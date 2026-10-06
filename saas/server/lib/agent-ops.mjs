import crypto from 'node:crypto';
import { AGENT_DEFINITIONS, recordAgentRun, runCommander } from './agents.mjs';
import { CONNECTORS } from './connection-centre.mjs';
import { runConnectionDoctor } from './connection-doctor.mjs';
import { addAudit, recordWork } from './events.mjs';
import { marketingPlannerCycle } from './marketing.mjs';
import { monitoredSync } from './scheduler.mjs';
import { configureAiEconomics, ensureAiEconomics, planMonthlyValueGbp, routeAiWork } from './ai-economics.mjs';

export const AGENT_JOB_TYPES = Object.freeze({
  agent_command: { priority: 70, maxAttempts: 3, aiUnits: 1 },
  connection_sync: { priority: 80, maxAttempts: 5, aiUnits: 0 },
  connection_doctor: { priority: 90, maxAttempts: 5, aiUnits: 0 },
  marketing_plan: { priority: 40, maxAttempts: 3, aiUnits: 1 }
});

const safeText = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const nowIso = () => new Date().toISOString();
const transient = error => error?.upstreamStatus === 429 || error?.upstreamStatus >= 500 ||
  /RATE_LIMIT|TIMEOUT|ETIMEDOUT|ECONNRESET|PERSISTENCE|SUPABASE|STATE_CONFLICT/.test(String(error?.code || '')) ||
  ['AbortError','TimeoutError','TypeError'].includes(error?.name);
const blocked = error => /AUTH|CREDENTIAL|OWNER_APPROVAL|PERMISSION|ACCOUNT_MISMATCH|APPROVAL_REQUIRED/.test(String(error?.code || ''));
const safeCode = error => /^[A-Z0-9_]{1,80}$/.test(String(error?.code || '')) ? String(error.code) : 'AGENT_JOB_FAILED';

function planLimits(state) {
  const plan = state?.subscription?.plan || 'starter';
  if (plan === 'customer-zero') return { maxConcurrentJobs: 6, dailyAiUnitLimit: 500 };
  if (plan === 'pro') return { maxConcurrentJobs: 6, dailyAiUnitLimit: 300 };
  if (plan === 'growth') return { maxConcurrentJobs: 3, dailyAiUnitLimit: 100 };
  return { maxConcurrentJobs: 2, dailyAiUnitLimit: 25 };
}

export function ensureAgentOps(state) {
  const limits = planLimits(state);
  state.agentOps = {
    enabled: true,
    paused: false,
    maxConcurrentJobs: limits.maxConcurrentJobs,
    dailyAiUnitLimit: limits.dailyAiUnitLimit,
    ...state.agentOps
  };
  state.agentOps.maxConcurrentJobs = Math.max(1, Math.min(10, Number(state.agentOps.maxConcurrentJobs) || limits.maxConcurrentJobs));
  const dailyAiUnitLimit = Number(state.agentOps.dailyAiUnitLimit);
  state.agentOps.dailyAiUnitLimit = Number.isFinite(dailyAiUnitLimit) ? Math.max(0, Math.min(100000, dailyAiUnitLimit)) : limits.dailyAiUnitLimit;
  return state.agentOps;
}

export function configureAgentOps(state, input, actor) {
  const settings = ensureAgentOps(state);
  if (input.enabled !== undefined) settings.enabled = Boolean(input.enabled);
  if (input.paused !== undefined) settings.paused = Boolean(input.paused);
  if (input.maxConcurrentJobs !== undefined) {
    const n = Number(input.maxConcurrentJobs);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw Object.assign(new Error('Concurrent jobs must be between 1 and 10'), { status:400, code:'VALIDATION_FAILED' });
    settings.maxConcurrentJobs = n;
  }
  if (input.dailyAiUnitLimit !== undefined) {
    const n = Number(input.dailyAiUnitLimit);
    if (!Number.isFinite(n) || n < 0 || n > 100000) throw Object.assign(new Error('Daily AI unit limit is invalid'), { status:400, code:'VALIDATION_FAILED' });
    settings.dailyAiUnitLimit = Math.floor(n);
  }
  addAudit(state, { type:'agent_ops_settings_updated', actor, detail:{
    enabled:settings.enabled, paused:settings.paused, maxConcurrentJobs:settings.maxConcurrentJobs,
    dailyAiUnitLimit:settings.dailyAiUnitLimit
  }});
  return settings;
}

function normalizeJob(input, workspaceId, actor, state) {
  const type = safeText(input?.type, 80);
  const definition = AGENT_JOB_TYPES[type];
  if (!definition) throw Object.assign(new Error('Unsupported agent job type'), { status:400, code:'AGENT_JOB_TYPE_INVALID' });
  const payload = input?.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? structuredClone(input.payload) : {};
  const provider = safeText(input?.provider || payload.provider, 80) || null;
  if (provider && !CONNECTORS[provider]) throw Object.assign(new Error('Unknown provider'), { status:400, code:'PROVIDER_NOT_FOUND' });
  if (type === 'agent_command') {
    payload.command = safeText(payload.command, 1000);
    if (!payload.command) throw Object.assign(new Error('Command required'), { status:400, code:'COMMAND_REQUIRED' });
  }
  if (type === 'connection_sync' && !provider) throw Object.assign(new Error('Provider required'), { status:400, code:'PROVIDER_REQUIRED' });
  const priority = Math.max(0, Math.min(100, Number(input?.priority ?? definition.priority)));
  const maxAttempts = Math.max(1, Math.min(10, Number(input?.maxAttempts ?? definition.maxAttempts)));
  const requestedAiUnits = Number(input?.aiUnits ?? definition.aiUnits);
  if (!Number.isFinite(requestedAiUnits) || requestedAiUnits < 0) {
    throw Object.assign(new Error('AI units must be a finite non-negative number'), { status:400, code:'VALIDATION_FAILED' });
  }
  const idempotencyKey = safeText(input?.idempotencyKey, 180) || `${type}:${provider || 'none'}:${crypto.randomUUID()}`;
  const settings = ensureAgentOps(state);
  const route = routeAiWork(state,{jobType:type,payload});
  return {
    id:`job_${crypto.randomUUID()}`, workspaceId, type, provider, payload, status:'queued',
    priority, attempts:0, maxAttempts, aiUnits:Math.max(definition.aiUnits, requestedAiUnits),
    concurrencyLimit:settings.maxConcurrentJobs, idempotencyKey, actor:safeText(actor,120) || 'system',
    aiProvider:route.provider, aiModel:route.model, aiTier:route.tier,
    availableAt:nowIso(), createdAt:nowIso(), updatedAt:nowIso()
  };
}

export function createAgentOperations({ store, integrations, withWorkspaceLock, aiProvider = null, env = process.env, enabled = true, intervalMs = 2500,
  now = Date.now, random = Math.random, scheduleTimeout = setTimeout, cancelTimeout = clearTimeout }) {
  const workerId = `agent_worker_${process.pid}_${crypto.randomUUID()}`;
  const baseIntervalMs = Math.max(1000, Math.min(60000, Number(intervalMs) || 2500));
  const maxBackoffMs = 60000;
  let timer = null, running = false, stopped = false, started = false, wakePending = false;
  const status = { workerId, running:false, lastTickAt:null, lastError:null, processed:0, failed:0, deadLettered:0,
    pollCalls:0, emptyPolls:0, pollErrors:0, backoffMs:baseIntervalMs, nextPollAt:null };

  function clearPoll() {
    if (timer !== null) cancelTimeout(timer);
    timer = null;
    status.nextPollAt = null;
  }

  function schedulePoll(delay) {
    clearPoll();
    if (!started || stopped) return;
    status.nextPollAt = new Date(now() + delay).toISOString();
    timer = scheduleTimeout(() => { timer = null; status.nextPollAt = null; void tick(); }, delay);
    timer.unref?.();
  }

  function wake() {
    if (!started || stopped) return;
    status.backoffMs = baseIntervalMs;
    // A claim already in flight might have missed this enqueue. Drain first,
    // then poll again immediately without overlapping a claim or execution.
    if (running) wakePending = true;
    else schedulePoll(0);
  }

  async function enqueue(workspaceId, input, actor = 'system') {
    const queued = await withWorkspaceLock(workspaceId, async () => {
      const state = await store.get(workspaceId);
      if (!state) throw Object.assign(new Error('Workspace not found'), { status:404, code:'WORKSPACE_NOT_FOUND' });
      const settings = ensureAgentOps(state);
      if (!settings.enabled || settings.paused) throw Object.assign(new Error('Agent operations are paused'), { status:409, code:'AGENT_OPS_PAUSED' });
      const job = normalizeJob(input, workspaceId, actor, state);
      if (job.aiUnits > 0) {
        const used = await store.agentOpsUsage(workspaceId, new Date().toISOString().slice(0,10));
        if (used + job.aiUnits > settings.dailyAiUnitLimit) {
          addAudit(state, { type:'agent_job_blocked_budget', actor, detail:{ type:job.type, requestedUnits:job.aiUnits, used, limit:settings.dailyAiUnitLimit } });
          await store.save(workspaceId, state);
          throw Object.assign(new Error('Daily AI usage limit reached'), { status:429, code:'AI_BUDGET_REACHED' });
        }
      }
      const queued = await store.enqueueAgentJob(workspaceId, job);
      addAudit(state, { type:'agent_job_queued', actor, detail:{ jobId:queued.id, type:queued.type, provider:queued.provider, priority:queued.priority } });
      await store.save(workspaceId, state);
      return queued;
    });
    if (queued.status === 'queued') wake();
    return queued;
  }

  async function execute(job) {
    return withWorkspaceLock(job.workspace_id || job.workspaceId, async () => {
      const workspaceId = job.workspace_id || job.workspaceId;
      const state = await store.get(workspaceId);
      if (!state) throw Object.assign(new Error('Workspace not found'), { code:'WORKSPACE_NOT_FOUND' });
      const settings = ensureAgentOps(state);
      if (!settings.enabled || settings.paused) throw Object.assign(new Error('Agent operations are paused'), { code:'AGENT_OPS_PAUSED' });
      const payload = job.payload || {};
      let result;
      if (job.type === 'agent_command') {
        const runId = `agent_run_${crypto.randomUUID()}`;
        recordWork(state, { id:runId, title:safeText(payload.command,1000), source:'agent-ops', status:'IN PROGRESS', evidence:[] });
        const run = await runCommander(state, safeText(payload.command,1000), {
          actor:job.actor || 'agent-ops', runId,
          lowStockThreshold:state.settings?.lowStockThreshold ?? 20,
          marginFloor:state.settings?.marginFloor ?? 20
        });
        const route={provider:job.ai_provider || job.aiProvider || 'runvara',model:job.ai_model || job.aiModel || 'deterministic',tier:job.ai_tier || job.aiTier || 'deterministic'};
        let aiEnhancement={used:false,reason:'PROVIDER_NOT_CONFIGURED',route};
        if (aiProvider) {
          try {
            aiEnhancement=await aiProvider.enhanceCommander({workspaceId,jobId:job.id,route,command:safeText(payload.command,1000),run,state});
          } catch(error) {
            aiEnhancement={used:false,reason:safeCode(error),route};
            console.warn(JSON.stringify({event:'agent_ai_enhancement_failed',jobId:job.id,workspaceId,code:safeCode(error)}));
          }
        }
        if (aiEnhancement.used) {
          run.ai={provider:route.provider,model:route.model,tier:route.tier,summary:aiEnhancement.summary,usage:aiEnhancement.usage};
          run.modelCalls=1;
        } else {
          run.ai={provider:route.provider,model:route.model,tier:route.tier,used:false,reason:aiEnhancement.reason};
        }
        recordAgentRun(state, run, job.actor || 'agent-ops');
        recordWork(state, { id:runId, title:safeText(payload.command,1000), source:'agent-ops', status:run.workStatus || 'COMPLETED',
          approvalId:run.approvalId || null, executedExternally:false,
          evidence:[{ type:'agent_run', id:run.id, detail:`Routed to ${run.routedAgents?.length || 0} specialist agents.` }] });
        result = { runId:run.id, status:run.status, workStatus:run.workStatus, approvalId:run.approvalId || null, routedAgents:run.routedAgents || [], ai:run.ai, externalWrites:false };
      } else if (job.type === 'connection_sync') {
        const provider = job.provider || payload.provider;
        const sync = await monitoredSync(state, integrations, provider, { automatic:true, retry:false, areas:Array.isArray(payload.areas) ? payload.areas : undefined });
        result = { provider, status:sync.status, failedAreas:sync.failedAreas || [], externalWrites:false };
      } else if (job.type === 'connection_doctor') {
        result = await runConnectionDoctor(state, { integrations, readSync:monitoredSync, save:()=>store.save(workspaceId,state), now:new Date() });
      } else if (job.type === 'marketing_plan') {
        const plan = marketingPlannerCycle(state, { now:new Date(), source:'agent-ops' });
        result = { created:Boolean(plan.created), campaignId:plan.campaign?.id || null, reason:plan.reason || null, externalWrites:false };
      } else {
        throw Object.assign(new Error('Unsupported agent job type'), { code:'AGENT_JOB_TYPE_INVALID' });
      }
      addAudit(state, { type:'agent_job_completed', actor:'agent-ops', detail:{ jobId:job.id, type:job.type, provider:job.provider || null, externalWrites:false } });
      await store.save(workspaceId, state);
      return result;
    });
  }

  async function process(job) {
    try {
      const result = await execute(job);
      await store.finishAgentJob(job, { status:'succeeded', result, errorCode:null, completedAt:nowIso() });
      status.processed++;
    } catch (error) {
      const code = safeCode(error);
      const attempts = Number(job.attempts || 0);
      if (blocked(error)) {
        await store.finishAgentJob(job, { status:'blocked', errorCode:code, completedAt:nowIso() });
      } else if (transient(error) && attempts < Number(job.max_attempts || job.maxAttempts || 3)) {
        const backoff = 15000 * 2 ** Math.max(0, attempts - 1);
        const delay = Math.min(3600000, Math.max(backoff, Number(error.retryAfterMs) || 0));
        await store.rescheduleAgentJob(job, { errorCode:code, availableAt:new Date(Date.now()+delay).toISOString() });
      } else {
        await store.finishAgentJob(job, { status:'dead_letter', errorCode:code, completedAt:nowIso() });
        status.deadLettered++;
      }
      status.failed++;
      console.warn(JSON.stringify({ event:'agent_job_failed', jobId:job.id, workspaceId:job.workspace_id || job.workspaceId, type:job.type, code }));
    }
  }

  async function tick() {
    if (running || stopped) return;
    // Explicit ticks bypass backoff, but replace any scheduled poll.
    clearPoll();
    running = true; status.running = true; status.lastError = null;
    try {
      status.pollCalls++;
      const jobs = await store.claimAgentJobs(workerId, Math.max(1, Math.min(20, Number(env.AGENT_OPS_GLOBAL_CONCURRENCY) || 8)), 300);
      if (jobs?.length) status.backoffMs = baseIntervalMs;
      else {
        status.emptyPolls++;
        status.backoffMs = Math.min(maxBackoffMs, status.backoffMs * 2);
      }
      await Promise.allSettled((jobs || []).map(process));
      status.lastTickAt = new Date(now()).toISOString();
    } catch (error) {
      status.pollErrors++;
      status.backoffMs = Math.min(maxBackoffMs, status.backoffMs * 2);
      status.lastError = safeCode(error);
      console.warn(JSON.stringify({ event:'agent_ops_tick_failed', code:status.lastError }));
    } finally {
      running = false; status.running = false;
      if (started && !stopped) {
        if (wakePending) {
          wakePending = false;
          status.backoffMs = baseIntervalMs;
          schedulePoll(0);
        } else {
          // Jitter stays below the cap so work enqueued on another replica is
          // discovered within 60 seconds of an idle poll (plus claim latency).
          const delay = status.backoffMs === baseIntervalMs ? baseIntervalMs :
            Math.max(baseIntervalMs, Math.round(status.backoffMs * (0.8 + 0.2 * random())));
          schedulePoll(delay);
        }
      }
    }
  }

  async function workspaceSnapshot(workspaceId, state) {
    state ||= await store.get(workspaceId);
    const settings = state ? ensureAgentOps(state) : null;
    const aiSettings = state ? ensureAiEconomics(state) : null;
    const jobs = await store.listAgentJobs(workspaceId, 100);
    const usage = await store.agentOpsUsage(workspaceId, new Date().toISOString().slice(0,10));
    const now=new Date(), monthStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString(), monthEnd=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1)).toISOString();
    const aiUsageMonth=await store.aiUsageSummary(workspaceId,monthStart,monthEnd);
    const counts = Object.fromEntries(['queued','running','succeeded','blocked','dead_letter'].map(name => [name, jobs.filter(j=>j.status===name).length]));
    return { settings, aiSettings, usage:{ aiUnitsToday:usage, dailyAiUnitLimit:settings?.dailyAiUnitLimit ?? 0 }, aiUsageMonth, counts, jobs, worker:{ running:status.running, lastTickAt:status.lastTickAt } };
  }

  async function retry(workspaceId, jobId, actor) {
    const retried = await withWorkspaceLock(workspaceId, async () => {
      const state = await store.get(workspaceId);
      if (!state) throw Object.assign(new Error('Workspace not found'), { status:404, code:'WORKSPACE_NOT_FOUND' });
      const job = await store.retryAgentJob(workspaceId, jobId);
      if (!job) throw Object.assign(new Error('Agent job not found'), { status:404, code:'AGENT_JOB_NOT_FOUND' });
      if (job.status !== 'queued') throw Object.assign(new Error('Only blocked or dead-letter jobs can be retried'), { status:409, code:'AGENT_JOB_NOT_RETRYABLE' });
      addAudit(state, { type:'agent_job_retried', actor, detail:{ jobId, type:job.type, provider:job.provider || null } });
      await store.save(workspaceId, state);
      return job;
    });
    wake();
    return retried;
  }

  async function configureWorkspace(workspaceId, input, actor='platform-owner') {
    return withWorkspaceLock(workspaceId, async () => {
      const state = await store.get(workspaceId);
      if (!state) throw Object.assign(new Error('Workspace not found'), { status:404, code:'WORKSPACE_NOT_FOUND' });
      const settings = configureAgentOps(state, input, actor);
      const aiSettings = configureAiEconomics(state, input, actor);
      addAudit(state, { type:'agent_ops_operator_updated', actor, detail:{ workspaceId, paused:settings.paused, enabled:settings.enabled, maxConcurrentJobs:settings.maxConcurrentJobs, dailyAiUnitLimit:settings.dailyAiUnitLimit, routingMode:aiSettings.routingMode, monthlyCostLimitUsd:aiSettings.monthlyCostLimitUsd } });
      await store.save(workspaceId, state);
      return { ...settings, aiEconomics:aiSettings };
    });
  }

  async function fleetSnapshot() {
    const workspaceIds = await store.listWorkspaceIds();
    const workspaces = [];
    for (const workspaceId of workspaceIds) {
      const state = await store.get(workspaceId);
      if (!state) continue;
      const snapshot = await workspaceSnapshot(workspaceId, state);
      const connectionStates = Object.values(state.integrationStatus || {});
      const unhealthyConnections = connectionStates.filter(item => ['degraded','error','auth_expired'].includes(item?.status)).length;
      const planValue=planMonthlyValueGbp(state);
      workspaces.push({
        workspaceId,
        name:state.workspace?.name || workspaceId,
        plan:state.subscription?.plan || 'unknown',
        subscriptionStatus:state.subscription?.status || 'unknown',
        paused:Boolean(snapshot.settings?.paused),
        enabled:snapshot.settings?.enabled !== false,
        maxConcurrentJobs:snapshot.settings?.maxConcurrentJobs || 0,
        counts:snapshot.counts,
        aiUnitsToday:snapshot.usage.aiUnitsToday,
        dailyAiUnitLimit:snapshot.usage.dailyAiUnitLimit,
        aiRoutingMode:snapshot.aiSettings?.routingMode || 'balanced',
        monthlyAiCostLimitUsd:snapshot.aiSettings?.monthlyCostLimitUsd ?? null,
        aiUsageMonth:snapshot.aiUsageMonth,
        planMonthlyValueGbp:planValue.amount,
        planValueSource:planValue.source,
        unhealthyConnections,
        pendingApprovals:(state.approvals || []).filter(item => item.status === 'pending').length,
        openExceptions:(state.exceptions || []).filter(item => ['open','acknowledged'].includes(item.status)).length,
        updatedAt:state.workspace?.updatedAt || null,
        jobs:snapshot.jobs.slice(0,10).map(job => ({
          id:job.id, type:job.type, provider:job.provider || null, status:job.status,
          priority:job.priority, attempts:job.attempts, maxAttempts:job.max_attempts ?? job.maxAttempts,
          aiUnits:Number(job.ai_units ?? job.aiUnits ?? 0), aiProvider:job.ai_provider ?? job.aiProvider ?? null,
          aiModel:job.ai_model ?? job.aiModel ?? null, aiTier:job.ai_tier ?? job.aiTier ?? null,
          errorCode:job.error_code ?? job.errorCode ?? null,
          createdAt:job.created_at ?? job.createdAt ?? null, completedAt:job.completed_at ?? job.completedAt ?? null
        }))
      });
    }
    workspaces.sort((a,b) => (b.counts.dead_letter + b.counts.blocked + b.unhealthyConnections + b.openExceptions) - (a.counts.dead_letter + a.counts.blocked + a.unhealthyConnections + a.openExceptions) || a.name.localeCompare(b.name));
    return {
      worker:{ ...status },
      totals:workspaces.reduce((out,item) => {
        for (const [key,value] of Object.entries(item.counts)) out[key]=(out[key]||0)+value;
        out.aiUnitsToday=(out.aiUnitsToday||0)+item.aiUnitsToday;
        out.dailyAiUnitLimit=(out.dailyAiUnitLimit||0)+item.dailyAiUnitLimit;
        out.aiEstimatedCostUsdMonth=(out.aiEstimatedCostUsdMonth||0)+Number(item.aiUsageMonth?.totals?.estimatedCostUsd||0);
        out.aiRequestsMonth=(out.aiRequestsMonth||0)+Number(item.aiUsageMonth?.totals?.requests||0);
        out.planMonthlyValueGbp=(out.planMonthlyValueGbp||0)+Number(item.planMonthlyValueGbp||0);
        out.unhealthyConnections=(out.unhealthyConnections||0)+item.unhealthyConnections;
        out.pendingApprovals=(out.pendingApprovals||0)+item.pendingApprovals;
        out.openExceptions=(out.openExceptions||0)+item.openExceptions;
        return out;
      }, { workspaces:workspaces.length }),
      workspaces
    };
  }

  function start() {
    if (!enabled || started) return;
    started = true; stopped = false; status.backoffMs = baseIntervalMs;
    if (running) wakePending = true;
    else void tick();
  }
  function stop() { stopped = true; started = false; wakePending = false; clearPoll(); }

  return { enqueue, retry, configureWorkspace, tick, start, stop, get status() { return Object.freeze({ ...status }); }, workspaceSnapshot, fleetSnapshot, workerId };
}
