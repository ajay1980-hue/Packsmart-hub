import crypto from 'node:crypto';
import { AGENT_DEFINITIONS, recordAgentRun, runCommander } from './agents.mjs';
import { CONNECTORS, isShopifyOrderSourceFailure, shopifyOrderReadHold, orderReadHeld, shopifyOrderReadBudgetExhausted } from './connection-centre.mjs';
import { runConnectionDoctor } from './connection-doctor.mjs';
import { addAudit, recordWork } from './events.mjs';
import { marketingPlannerCycle } from './marketing.mjs';
import { monitoredSync } from './scheduler.mjs';
import { configureAiEconomics, ensureAiEconomics, planMonthlyValueGbp, publicAiSettings, routeAiWork } from './ai-economics.mjs';
import { buildObjectiveReview, objectiveReviewFingerprint } from './objective-review.mjs';

export const AGENT_JOB_TYPES = Object.freeze({
  agent_command: { priority: 70, maxAttempts: 3, aiUnits: 1 },
  connection_sync: { priority: 80, maxAttempts: 5, aiUnits: 0 },
  connection_doctor: { priority: 90, maxAttempts: 5, aiUnits: 0 },
  marketing_plan: { priority: 40, maxAttempts: 3, aiUnits: 1 },
  objective_prepare: { priority: 60, maxAttempts: 3, aiUnits: 0 }
});

const safeText = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const nowIso = () => new Date().toISOString();
const transient = error => error?.upstreamStatus === 429 || error?.upstreamStatus >= 500 ||
  /RATE_LIMIT|TIMEOUT|ETIMEDOUT|ECONNRESET|PERSISTENCE|SUPABASE|STATE_CONFLICT/.test(String(error?.code || '')) ||
  ['AbortError','TimeoutError','TypeError'].includes(error?.name);
const blocked = error => /AUTH|CREDENTIAL|OWNER_APPROVAL|PERMISSION|ACCOUNT_MISMATCH|APPROVAL_REQUIRED/.test(String(error?.code || ''));
const safeCode = error => /^[A-Z0-9_]{1,80}$/.test(String(error?.code || '')) ? String(error.code) : 'AGENT_JOB_FAILED';
function aiEffects(value) {
  const counts = ['submissionAttempts', 'confirmedSubmissions', 'uncertainSubmissions'];
  const valid = counts.every(key => Number.isSafeInteger(value?.[key]) && value[key] >= 0 && value[key] <= 1);
  const result = Object.fromEntries(counts.map(key => [key, valid ? value[key] : null]));
  result.reservationId = typeof value?.reservationId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value.reservationId) ? value.reservationId : null;
  result.usageStatus = ['none', 'held', 'uncertain', 'settled', 'overrun', 'cancelled_pre_dispatch'].includes(value?.usageStatus) ? value.usageStatus : 'uncertain';
  result.currency = 'USD';
  const noCost = valid && counts.every(key => result[key] === 0) && result.usageStatus === 'cancelled_pre_dispatch' && result.reservationId
    && value?.costStatus === 'not_incurred' && value.accountedCostMicros === 0;
  const accounted = valid && result.reservationId && ['settled', 'overrun'].includes(result.usageStatus)
    && value?.costStatus === 'accounted' && value.currency === 'USD'
    && (Number.isSafeInteger(value.accountedCostMicros) && value.accountedCostMicros >= 0
      || typeof value.accountedCostMicros === 'string' && /^(?:0|[1-9][0-9]{0,59})$/.test(value.accountedCostMicros));
  result.costStatus = noCost ? 'not_incurred' : accounted ? 'accounted' : 'unknown';
  result.accountedCostMicros = noCost ? 0 : accounted ? value.accountedCostMicros : null;
  return result;
}
const objectiveError = (code, status = 409) => Object.assign(new Error(code), { code, status });
function exactInput(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw objectiveError('OBJECTIVE_JOB_INPUT_INVALID', 400);
  for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !fields.includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key))) throw objectiveError('OBJECTIVE_JOB_INPUT_INVALID', 400);
}
function objectiveActor(state, workspaceId, auth) {
  exactInput(auth, ['actorId', 'sessionVersion']);
  if (state?.workspace?.id !== workspaceId || typeof auth.actorId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(auth.actorId)
    || !Number.isSafeInteger(auth.sessionVersion) || auth.sessionVersion < 1) throw objectiveError('OBJECTIVE_ACTOR_INVALID', 403);
  const actor = state.users?.find(user => user.id === auth.actorId);
  if (!actor || actor.active === false || actor.passwordChangeRequired || !['owner', 'admin'].includes(actor.role)
    || actor.sessionVersion !== auth.sessionVersion) throw objectiveError('OBJECTIVE_ACTOR_PERMISSION_CHANGED', 403);
  return actor;
}
function objectivePayload(payload) {
  exactInput(payload, ['schema', 'objectiveId', 'objectiveRevision', 'typedInputFingerprint', 'actorSessionVersion']);
  if (payload.schema !== 'runvara-objective-prepare/v1' || typeof payload.objectiveId !== 'string'
    || !/^objective_[0-9a-f-]{36}$/.test(payload.objectiveId) || !Number.isSafeInteger(payload.objectiveRevision) || payload.objectiveRevision < 1
    || !/^[0-9a-f]{32}$/.test(payload.typedInputFingerprint) || !Number.isSafeInteger(payload.actorSessionVersion) || payload.actorSessionVersion < 1) throw objectiveError('OBJECTIVE_JOB_INPUT_INVALID', 400);
}
function objectiveOpsEnabled(state) {
  const settings = state?.agentOps;
  if (settings !== undefined && (!settings || typeof settings !== 'object' || Array.isArray(settings)
    || (settings.enabled !== undefined && typeof settings.enabled !== 'boolean')
    || (settings.paused !== undefined && typeof settings.paused !== 'boolean'))) throw objectiveError('OBJECTIVE_JOB_POLICY_INVALID');
  if (settings?.enabled === false || settings?.paused === true) throw objectiveError('AGENT_OPS_PAUSED');
}
function objectiveBindings(state, workspaceId, payload, actorId, timestamp) {
  objectivePayload(payload);
  objectiveActor(state, workspaceId, { actorId, sessionVersion: payload.actorSessionVersion });
  objectiveOpsEnabled(state);
  const fingerprint = objectiveReviewFingerprint(state, { objectiveId: payload.objectiveId, objectiveRevision: payload.objectiveRevision }, { workspaceId, now: timestamp });
  if (!fingerprint) throw objectiveError('OBJECTIVE_POLICY_OR_STATUS_CHANGED');
  if (fingerprint !== payload.typedInputFingerprint) throw objectiveError('OBJECTIVE_SOURCE_CHANGED');
}
function objectiveStatus(row) {
  objectivePayload(row.payload);
  const value = { id: row.id, type: row.type, status: row.status, objectiveId: row.payload.objectiveId,
    objectiveRevision: row.payload.objectiveRevision, attempts: row.attempts, maxAttempts: row.max_attempts,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at || null,
    errorCode: row.error_code || null, reportAvailable: row.status === 'succeeded' };
  if (Buffer.byteLength(JSON.stringify(value)) > 2048) throw objectiveError('AGENT_JOB_RESPONSE_INVALID', 503);
  return value;
}

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
  if (type === 'objective_prepare') throw objectiveError('OBJECTIVE_DEDICATED_ENQUEUE_REQUIRED', 400);
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
  const claimNotAdmitted = Symbol('claimNotAdmitted');

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

  async function enqueueObjectiveReview(workspaceId, input, auth) {
    exactInput(input, ['objectiveId', 'objectiveRevision']);
    const state = await store.get(workspaceId);
    if (!state) throw objectiveError('WORKSPACE_NOT_FOUND', 404);
    objectiveActor(state, workspaceId, auth);
    objectiveOpsEnabled(state);
    const timestamp = new Date(now()).toISOString();
    const fingerprint = objectiveReviewFingerprint(state, input, { workspaceId, now: timestamp });
    if (!fingerprint) throw objectiveError('OBJECTIVE_POLICY_OR_STATUS_CHANGED');
    const payload = { schema: 'runvara-objective-prepare/v1', objectiveId: input.objectiveId,
      objectiveRevision: input.objectiveRevision, typedInputFingerprint: fingerprint, actorSessionVersion: auth.sessionVersion };
    objectivePayload(payload);
    const key = crypto.createHash('sha256').update(JSON.stringify([workspaceId, payload, auth.actorId])).digest('hex');
    const limits = planLimits(state);
    const concurrencyLimit = Number.isSafeInteger(state.agentOps?.maxConcurrentJobs) ? Math.max(1, Math.min(10, state.agentOps.maxConcurrentJobs)) : limits.maxConcurrentJobs;
    const queued = await store.enqueueAgentJob(workspaceId, {
      id: `job_${crypto.randomUUID()}`, workspaceId, type: 'objective_prepare', provider: null, payload,
      priority: 60, attempts: 0, maxAttempts: 3, aiUnits: 0, concurrencyLimit,
      idempotencyKey: `objective_prepare:v1:${key}`, actor: auth.actorId,
      aiProvider: null, aiModel: null, aiTier: 'deterministic', availableAt: timestamp, createdAt: timestamp, updatedAt: timestamp
    });
    if (!queued || queued.workspace_id !== workspaceId || queued.type !== 'objective_prepare' || queued.actor !== auth.actorId
      || Object.keys(payload).some(key => queued.payload?.[key] !== payload[key])) throw objectiveError('AGENT_JOB_RESPONSE_INVALID', 503);
    // No workspace save or extra audit: the immutable job row is provenance.
    if (queued.status === 'queued') wake();
    return { job: objectiveStatus(queued), stale: false, staleReason: null };
  }

  async function objectiveReview(workspaceId, jobId, options = {}, auth) {
    exactInput(options, ['includeReport']);
    if (options.includeReport !== undefined && typeof options.includeReport !== 'boolean') throw objectiveError('OBJECTIVE_JOB_INPUT_INVALID', 400);
    // Polling only reads compact identity + one job. Full evidence is read once
    // on an explicit report request, never on every status poll.
    const identity = await store.getIdentity(workspaceId);
    objectiveActor(identity, workspaceId, auth);
    const row = await store.getAgentJob(workspaceId, jobId, { includeReport: options.includeReport === true });
    if (!row || row.type !== 'objective_prepare') throw objectiveError('AGENT_JOB_NOT_FOUND', 404);
    const result = { job: objectiveStatus(row), stale: null, staleReason: 'not_checked' };
    if (options.includeReport === true) {
      const state = await store.get(workspaceId);
      objectiveActor(state, workspaceId, auth);
      try {
        objectiveBindings(state, workspaceId, row.payload, row.actor, new Date(now()).toISOString());
        result.stale = false; result.staleReason = null;
      } catch (error) { result.stale = true; result.staleReason = safeCode(error); }
      result.report = row.status === 'succeeded' ? row.result : null;
    }
    return result;
  }

  function sameObjectiveClaim(current, job) {
    return current?.workspace_id === job.workspace_id && current.id === job.id && current.type === 'objective_prepare'
      && current.status === 'running' && current.worker_id === job.worker_id && current.attempts === job.attempts
      && Date.parse(current.lease_until) === Date.parse(job.lease_until) && Date.parse(current.lease_until) > now();
  }

  async function completeObjective(job, update) {
    // Same prepared body/identity on retry; never recalculate a report after a
    // potentially committed completion, or downgrade it through generic catch.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const finished = await store.finishAgentJob(job, update);
        if (finished) return true;
      } catch (error) {
        if (['P0L01', 'P0L02', 'P0L03'].includes(error.databaseCode)) return false;
      }
      let current;
      try { current = await store.getAgentJob(job.workspace_id, job.id, { includeReport: true }); }
      catch { throw objectiveError('OBJECTIVE_COMPLETION_UNCERTAIN', 503); }
      if (current?.status === 'succeeded' && current.result?.id === update.result.id
        && current.result?.sourceAsOf?.typedInputFingerprint === job.payload.typedInputFingerprint) return true;
      if (!sameObjectiveClaim(current, job)) return false;
    }
    throw objectiveError('OBJECTIVE_COMPLETION_UNCERTAIN', 503);
  }

  async function processObjective(job) {
    // A malformed/stale claim must not even load tenant state. The trigger and
    // FileStore recovery cap leases; this also bounds work against an older DB.
    if (job.status !== 'running' || job.worker_id !== workerId
      || typeof job.id !== 'string' || !/^job_[A-Za-z0-9_-]{1,100}$/.test(job.id)
      || typeof job.workspace_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(job.workspace_id)
      || !Number.isSafeInteger(job.attempts) || job.attempts < 1
      || !Number.isSafeInteger(job.max_attempts) || job.max_attempts < 1 || job.max_attempts > 10
      || typeof job.lease_until !== 'string' || !Number.isFinite(Date.parse(job.lease_until)) || Date.parse(job.lease_until) <= now()) {
      status.lastError = 'OBJECTIVE_JOB_CLAIM_INVALID';
      return;
    }
    if (job.attempts > job.max_attempts) {
      status.lastError = 'OBJECTIVE_LEASE_ATTEMPTS_EXHAUSTED';
      try {
        const finished = await store.finishAgentJob(job, { status:'dead_letter', result:job.result ?? null,
          errorCode:status.lastError, completedAt:new Date(now()).toISOString() });
        if (finished) { status.failed++; status.deadLettered++; }
      } catch { /* Never recompute or loop if exhausted-claim closure is uncertain. */ }
      return;
    }
    let result;
    try {
      objectivePayload(job.payload);
      if (job.provider !== null || job.ai_provider != null || job.ai_model != null || job.ai_units !== 0
        || ![null, undefined, 'deterministic'].includes(job.ai_tier)) throw objectiveError('OBJECTIVE_JOB_INPUT_INVALID', 400);
      if (Date.parse(job.lease_until) <= now()) return;
      const state = await store.get(job.workspace_id);
      objectiveBindings(state, job.workspace_id, job.payload, job.actor, new Date(now()).toISOString());
      result = buildObjectiveReview(state, { objectiveId: job.payload.objectiveId,
        objectiveRevision: job.payload.objectiveRevision, jobId: job.id }, { workspaceId: job.workspace_id, now: new Date(now()).toISOString() });
      if (Buffer.byteLength(JSON.stringify(result)) > 65536 || result.specialists.length > 3) throw objectiveError('OBJECTIVE_REVIEW_RESULT_TOO_LARGE', 413);
    } catch (error) {
      const code = safeCode(error);
      try {
        let finished;
        if (transient(error) && job.attempts < job.max_attempts) finished = await store.rescheduleAgentJob(job, {
          errorCode: code, availableAt: new Date(now() + Math.min(3600000, 15000 * 2 ** (job.attempts - 1))).toISOString()
        });
        else finished = await store.finishAgentJob(job, { status: /OBJECTIVE|AGENT_OPS_PAUSED|WORKSPACE_NOT_FOUND/.test(code) ? 'blocked' : 'dead_letter', errorCode: code, completedAt: new Date(now()).toISOString() });
        if (finished) status.failed++;
      } catch { /* Leave an uncertain claim for durable lease recovery. */ }
      return;
    }
    try {
      if (await completeObjective(job, { status: 'succeeded', result, errorCode: null, completedAt: new Date(now()).toISOString() })) status.processed++;
    } catch (error) {
      // Lost outcome is neither a failed report nor permission to reschedule it.
      status.lastError = safeCode(error);
    }
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

  async function admitClaim(job) {
    // Use only the authoritative claim fields. Invalid fence values must never
    // reach tenant state, credential decoding, or a conditional job update.
    if (!job || typeof job !== 'object' || Array.isArray(job) || job.status !== 'running' || job.worker_id !== workerId
      || typeof job.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(job.id)
      || typeof job.workspace_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(job.workspace_id)
      || !Number.isSafeInteger(job.attempts) || job.attempts < 1
      || typeof job.lease_until !== 'string' || !Number.isFinite(Date.parse(job.lease_until)) || Date.parse(job.lease_until) <= now()) {
      status.lastError = 'AGENT_JOB_CLAIM_INVALID';
      return false;
    }
    const validMax = Number.isSafeInteger(job.max_attempts) && job.max_attempts >= 1 && job.max_attempts <= 10;
    if (validMax && job.attempts <= job.max_attempts) return true;
    const code = validMax ? 'AGENT_LEASE_ATTEMPTS_EXHAUSTED' : 'AGENT_JOB_CLAIM_INVALID';
    status.lastError = code;
    try {
      // Older stores may reclaim expired leases beyond the attempt ceiling.
      // Close only this live claim; null/uncertain writes prove no completion.
      const finished = await store.finishAgentJob(job, { status:'dead_letter', result:job.result ?? null,
        errorCode:code, completedAt:new Date(now()).toISOString() });
      if (finished) { status.failed++; status.deadLettered++; }
    } catch { /* Leave an uncertain closure for durable lease recovery. */ }
    return false;
  }

  async function execute(job) {
    return withWorkspaceLock(job.workspace_id || job.workspaceId, async () => {
      // A claim can expire while waiting behind another workspace operation.
      if (!await admitClaim(job)) return claimNotAdmitted;
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
            aiEnhancement=await aiProvider.enhanceCommander({workspaceId,jobId:job.id,route,command:safeText(payload.command,1000),run,state,
              jobContext:Object.freeze({workspaceId,jobId:job.id,type:job.type,status:job.status,
                workerId:job.worker_id === workerId ? workerId : null,attempt:job.attempts,leaseUntil:job.lease_until,createdAt:job.created_at})});
          } catch(error) {
            aiEnhancement={used:false,reason:safeCode(error),route};
            console.warn(JSON.stringify({event:'agent_ai_enhancement_failed',jobId:job.id,workspaceId,code:safeCode(error)}));
          }
        }
        if (aiEnhancement.used) {
          run.ai={provider:route.provider,model:route.model,tier:route.tier,used:true,summary:aiEnhancement.summary,usage:aiEnhancement.usage};
        } else {
          run.ai={provider:route.provider,model:route.model,tier:route.tier,used:false,reason:aiEnhancement.reason,
            ...(aiEnhancement.usage ? {usage:aiEnhancement.usage} : {})};
        }
        run.ai.effects = aiEffects(aiEnhancement.effects || (!aiProvider ? {submissionAttempts:0,confirmedSubmissions:0,uncertainSubmissions:0,
          usageStatus:'uncertain',costStatus:'unknown',accountedCostMicros:null,currency:'USD'} : null));
        run.modelCalls = run.ai.effects.submissionAttempts;
        recordAgentRun(state, run, job.actor || 'agent-ops');
        recordWork(state, { id:runId, title:safeText(payload.command,1000), source:'agent-ops', status:run.workStatus || 'COMPLETED',
          approvalId:run.approvalId || null, executedExternally:false,
          evidence:[{ type:'agent_run', id:run.id, detail:`Routed to ${run.routedAgents?.length || 0} specialist agents.` }] });
        result = { runId:run.id, status:run.status, workStatus:run.workStatus, approvalId:run.approvalId || null, routedAgents:run.routedAgents || [], ai:run.ai, externalWrites:false };
      } else if (job.type === 'connection_sync') {
        const provider = job.provider || payload.provider;
        const previousHold = shopifyOrderReadHold(state, provider, integrations);
        let sync;
        try {
          sync = await monitoredSync(state, integrations, provider, { automatic:true, retry:false, areas:Array.isArray(payload.areas) ? payload.areas : undefined });
        } catch (error) {
          if (!isShopifyOrderSourceFailure(provider, error.code)) throw error;
          const hold = shopifyOrderReadHold(state, provider, integrations);
          let outcome = { status: 'configuration_changed', durable: false };
          if (hold && previousHold?.code === hold.code && JSON.stringify(previousHold.binding) === JSON.stringify(hold.binding)) outcome = { status: 'already_held', durable: true };
          else if (hold) {
            try {
              const leaseUntil = Date.parse(job.lease_until);
              if (job.status !== 'running' || job.worker_id !== workerId || !Number.isFinite(leaseUntil) || leaseUntil <= now()) throw Object.assign(new Error('Job lease is no longer current'), { code: 'AGENT_JOB_LEASE_EXPIRED' });
              // Only a newly established structural hold gets this one failure
              // save. The successful path keeps its existing single save.
              await store.save(workspaceId, state);
              outcome = { status: 'persisted', durable: true };
            } catch (persistenceError) {
              outcome = { status: 'not_confirmed', durable: false, persistenceErrorCode: safeCode(persistenceError),
                limitation: 'The order-read hold could not be confirmed saved. This job will not retry the provider; automatic checks in other workers are not confirmed paused.' };
              status.lastError = 'SHOPIFY_ORDER_HOLD_PERSISTENCE_UNCONFIRMED';
            }
          }
          throw Object.assign(error, { nonRetryable: true, orderReadHoldOutcome: outcome });
        }
        result = { provider, status:sync.status, failedAreas:sync.failedAreas || [], externalWrites:false };
      } else if (job.type === 'connection_doctor') {
        result = await runConnectionDoctor(state, { integrations, readSync:monitoredSync, save:()=>store.save(workspaceId,state), now:new Date() });
        // The job's fenced completion is enough evidence for an unchanged held
        // check. Do not turn its no-op into another full workspace save.
        if (!result.changed && (orderReadHeld(state, 'shopify', undefined, integrations) || shopifyOrderReadBudgetExhausted(state, integrations))) return result;
      } else if (job.type === 'marketing_plan') {
        const plan = marketingPlannerCycle(state, { now:new Date(), source:'agent-ops' });
        result = { created:Boolean(plan.created), campaignId:plan.campaign?.id || null, reason:plan.reason || null, externalWrites:false };
      } else {
        throw Object.assign(new Error('Unsupported agent job type'), { code:'AGENT_JOB_TYPE_INVALID' });
      }
      addAudit(state, { type:'agent_job_completed', actor:'agent-ops', detail:{ jobId:job.id, type:job.type, provider:job.provider || null, externalWrites:false,
        ...(result.ai?.effects ? {providerEffects:result.ai.effects} : {}) } });
      await store.save(workspaceId, state);
      return result;
    });
  }

  async function process(job) {
    if (job?.type === 'objective_prepare') return processObjective(job);
    if (!await admitClaim(job)) return;
    try {
      const result = await execute(job);
      if (result === claimNotAdmitted) return;
      await store.finishAgentJob(job, { status:'succeeded', result, errorCode:null, completedAt:nowIso() });
      status.processed++;
    } catch (error) {
      const code = safeCode(error);
      const attempts = Number(job.attempts || 0);
      if (job.type === 'connection_sync' && isShopifyOrderSourceFailure(job.provider || job.payload?.provider, code)) {
        let finished;
        try {
          finished = await store.finishAgentJob(job, { status: 'dead_letter', errorCode: code, completedAt: nowIso(),
            result: { provider: 'shopify', externalWrites: false, orderReadHold: error.orderReadHoldOutcome || { status: 'not_confirmed', durable: false } } });
        } catch { /* An uncertain close cannot authorize a retry or a success claim. */ }
        if (!finished) {
          status.lastError = 'SHOPIFY_ORDER_HOLD_JOB_CLOSURE_UNCONFIRMED';
          console.warn(JSON.stringify({ event: 'agent_job_closure_unconfirmed', jobId: job.id, workspaceId: job.workspace_id || job.workspaceId, code: status.lastError }));
          return;
        }
        status.deadLettered++;
      } else if (blocked(error)) {
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
    const aiSettings = state ? publicAiSettings(ensureAiEconomics(state)) : null;
    const jobs = await store.listAgentJobs(workspaceId, 100);
    const usage = await store.agentOpsUsage(workspaceId, new Date().toISOString().slice(0,10));
    const now=new Date(), monthStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString(), monthEnd=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1)).toISOString();
    const aiUsageMonth=await store.aiUsageSummary(workspaceId,monthStart,monthEnd);
    const counts = Object.fromEntries(['queued','running','succeeded','blocked','dead_letter'].map(name => [name, jobs.filter(j=>j.status===name).length]));
    return { settings, aiSettings, usage:{ aiUnitsToday:usage, dailyAiUnitLimit:settings?.dailyAiUnitLimit ?? 0 }, aiUsageMonth, counts, jobs, worker:{ running:status.running, lastTickAt:status.lastTickAt } };
  }

  async function retry(workspaceId, jobId, actor) {
    const existing = await store.getAgentJob(workspaceId, jobId);
    if (existing?.type === 'objective_prepare') {
      const state = await store.get(workspaceId);
      const auth = typeof actor === 'object' ? actor : null;
      if (!auth) throw objectiveError('OBJECTIVE_RETRY_AUTH_REQUIRED', 403);
      objectiveActor(state, workspaceId, auth);
      objectiveBindings(state, workspaceId, existing.payload, existing.actor, new Date(now()).toISOString());
      const retried = await store.retryAgentJob(workspaceId, jobId);
      if (!retried || retried.status !== 'queued') throw objectiveError('AGENT_JOB_NOT_RETRYABLE');
      wake(); return compactObjectiveRetry(retried);
    }
    const auditActor = typeof actor === 'object' && actor !== null ? actor.actorId : actor;
    const retried = await withWorkspaceLock(workspaceId, async () => {
      const state = await store.get(workspaceId);
      if (!state) throw Object.assign(new Error('Workspace not found'), { status:404, code:'WORKSPACE_NOT_FOUND' });
      const job = await store.retryAgentJob(workspaceId, jobId);
      if (!job) throw Object.assign(new Error('Agent job not found'), { status:404, code:'AGENT_JOB_NOT_FOUND' });
      if (job.status !== 'queued') throw Object.assign(new Error('Only blocked or dead-letter jobs can be retried'), { status:409, code:'AGENT_JOB_NOT_RETRYABLE' });
      addAudit(state, { type:'agent_job_retried', actor: auditActor, detail:{ jobId, type:job.type, provider:job.provider || null } });
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
      return { ...settings, aiEconomics:publicAiSettings(aiSettings) };
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

  return { enqueue, enqueueObjectiveReview, objectiveReview, retry, configureWorkspace, tick, start, stop, get status() { return Object.freeze({ ...status }); }, workspaceSnapshot, fleetSnapshot, workerId };
}

function compactObjectiveRetry(job) { return { ...objectiveStatus(job), workspace_id: job.workspace_id }; }
