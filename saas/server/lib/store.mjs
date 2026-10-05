import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactDailyBrief, defaultAutomations } from './operations.mjs';
import { defaultAgentSettings } from './agents.mjs';
import { normalizeEmail } from './security.mjs';
import { ensureControl } from './control.mjs';
import { ensureMarketing } from './marketing.mjs';
import { ensureAiEconomics } from './ai-economics.mjs';
import { ensureWebIntelligence } from './web-intelligence.mjs';
import { ensureRevenueEngine } from './revenue-engine.mjs';
export { addAudit } from './events.mjs';

const PERSISTED = Symbol('persisted');
const SUPABASE_EMBEDDED_AUDIT_LIMIT = 300;
const SUPABASE_WORK_RECORD_LIMIT = 100;
const SUPABASE_CONNECTION_SYNC_LIMIT = 100;
const SUPABASE_AGENT_RUN_LIMIT = 1;
const SUPABASE_DAILY_BRIEF_LIMIT = 30;
const SUPABASE_STATE_WARN_BYTES = 1572864;
const SUPABASE_STATE_HARD_BYTES = 2097152;
function markPersisted(state) { Object.defineProperty(state, PERSISTED, { value: true, configurable: true }); return state; }
function conflict() { return Object.assign(new Error('Workspace changed; refresh and try again'), { status: 409, code: 'STATE_CONFLICT' }); }
function assertWorkspace(workspaceId, state) {
  if (!workspaceId || state?.workspace?.id !== workspaceId) throw Object.assign(new Error('Workspace identity mismatch'), { status: 403, code: 'WORKSPACE_MISMATCH' });
}
const fileQueues = new Map();

export function seedWorkspaceState(env = process.env, options = {}) {
  const now = new Date().toISOString();
  const workspaceId = options.workspaceId || 'packsmart-solutions';
  const ownerEmail = normalizeEmail(options.email || env.PACKSMART_ADMIN_EMAIL || 'sales@packsmartsolutions.com');
  const ownerId = options.userId || (workspaceId === 'packsmart-solutions' ? 'packsmart-admin' : `user_${crypto.randomUUID()}`);
  const seeded = {
    schemaVersion: 8,
    workspace: {
      id: workspaceId,
      name: options.name || (workspaceId === 'packsmart-solutions' ? 'Packsmart Solutions Ltd' : 'New business'),
      slug: options.slug || workspaceId,
      createdAt: now,
      updatedAt: now
    },
    users: [{
      id: ownerId,
      email: ownerEmail,
      role: 'owner',
      active: true,
      passwordHash: options.passwordHash || null,
      passwordChangeRequired: !options.passwordHash && workspaceId === 'packsmart-solutions',
      sessionVersion: 1,
      createdAt: now,
      updatedAt: now
    }],
    products: [],
    orders: [],
    economics: {},
    suppliers: workspaceId === 'packsmart-solutions' ? [{
      id: 'supplier_europlast',
      name: 'Europlast',
      active: true,
      notes: 'Primary Packsmart packaging supplier.',
      createdAt: now,
      updatedAt: now
    }] : [],
    costHistory: [],
    advertisingCosts: [],
    shippingProviders: workspaceId === 'packsmart-solutions' ? [{
      id: 'shipping_royal_mail',
      name: 'Royal Mail',
      active: true,
      createdAt: now,
      updatedAt: now
    }] : [],
    settings: {
      currency: 'GBP',
      marginFloor: 20,
      lowStockThreshold: 20
    },
    marketplaceSettings: {},
    automations: defaultAutomations(),
    agentSettings: defaultAgentSettings(),
    agentRuns: [],
    agentActivity: [],
    approvals: [],
    audit: [{
      id: id('audit'),
      type: 'workspace_seeded',
      actor: 'system',
      detail: { source: workspaceId === 'packsmart-solutions' ? 'customer-zero' : 'beta-onboarding' },
      createdAt: now
    }],
    dailyBriefs: [],
    subscription: {
      plan: workspaceId === 'packsmart-solutions' ? 'customer-zero' : (options.plan || 'starter'),
      status: workspaceId === 'packsmart-solutions' ? 'internal' : 'pending',
      usage: {},
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      updatedAt: now
    },
    connections: [],
    oauthChallenges: [],
    integrationStatus: {},
    revenueEngine: { intentEvents: [], leads: [], quotes: [], experiments: [], referrals: [], loyaltyRules: [], attributionTouches: [], updatedAt: null },
    migrations: {},
    storageReady: false
  };
  ensureControl(seeded);
  ensureMarketing(seeded);
  ensureAiEconomics(seeded);
  ensureWebIntelligence(seeded);
  ensureRevenueEngine(seeded);
  return seeded;
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function upgradeState(state, env = process.env) {
  const workspaceId = state?.workspace?.id || 'packsmart-solutions';
  const seeded = seedWorkspaceState(env, {
    workspaceId,
    name: state?.workspace?.name,
    slug: state?.workspace?.slug,
    email: state?.users?.[0]?.email
  });
  const upgraded = {
    ...seeded,
    ...(state || {}),
    schemaVersion: 8,
    workspace: { ...seeded.workspace, ...(state?.workspace || {}), updatedAt: state?.workspace?.updatedAt || new Date().toISOString() },
    users: Array.isArray(state?.users) && state.users.length ? state.users.map(user => {
      const upgradedUser = { active: true, sessionVersion: 1, passwordHash: null, ...user };
      if (typeof user.passwordChangeRequired !== 'boolean') {
        upgradedUser.passwordChangeRequired = workspaceId === 'packsmart-solutions' && !user.passwordHash;
      }
      return upgradedUser;
    }) : seeded.users,
    products: Array.isArray(state?.products) ? state.products : [],
    orders: Array.isArray(state?.orders) ? state.orders : [],
    economics: state?.economics && typeof state.economics === 'object' ? state.economics : {},
    suppliers: Array.isArray(state?.suppliers) ? state.suppliers : seeded.suppliers,
    costHistory: Array.isArray(state?.costHistory) ? state.costHistory : [],
    advertisingCosts: Array.isArray(state?.advertisingCosts) ? state.advertisingCosts : [],
    shippingProviders: Array.isArray(state?.shippingProviders) ? state.shippingProviders : seeded.shippingProviders,
    settings: { ...seeded.settings, ...(state?.settings || {}) },
    marketplaceSettings: state?.marketplaceSettings && typeof state.marketplaceSettings === 'object' ? state.marketplaceSettings : {},
    automations: { ...defaultAutomations(), ...(state?.automations || {}) },
    agentSettings: { ...defaultAgentSettings(), ...(state?.agentSettings || {}) },
    agentRuns: Array.isArray(state?.agentRuns) ? state.agentRuns : [],
    agentActivity: Array.isArray(state?.agentActivity) ? state.agentActivity : [],
    approvals: Array.isArray(state?.approvals) ? state.approvals : [],
    audit: Array.isArray(state?.audit) ? state.audit : seeded.audit,
    dailyBriefs: Array.isArray(state?.dailyBriefs) ? state.dailyBriefs : [],
    subscription: { ...seeded.subscription, ...(state?.subscription || {}) },
    connections: Array.isArray(state?.connections) ? state.connections : [],
    oauthChallenges: Array.isArray(state?.oauthChallenges) ? state.oauthChallenges : [],
    integrationStatus: state?.integrationStatus && typeof state.integrationStatus === 'object' ? state.integrationStatus : {},
    revenueEngine: state?.revenueEngine && typeof state.revenueEngine === 'object' ? state.revenueEngine : seeded.revenueEngine,
    migrations: state?.migrations && typeof state.migrations === 'object' ? state.migrations : {}
  };
  ensureControl(upgraded);
  ensureMarketing(upgraded);
  ensureAiEconomics(upgraded);
  ensureWebIntelligence(upgraded);
  ensureRevenueEngine(upgraded);
  return upgraded;
}

class FileStore {
  constructor(env) {
    const defaultPath = fileURLToPath(new URL('../data/state.json', import.meta.url));
    this.filePath = env.SAAS_STATE_FILE || defaultPath;
    this.agentJobs = [];
    this.aiUsage = [];
  }

  get provider() { return 'file'; }

  async readAll() {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return {};
    }
  }

  async get(workspaceId) {
    const all = await this.readAll();
    return all[workspaceId] ? markPersisted(upgradeState(all[workspaceId])) : null;
  }

  async save(workspaceId, state) {
    assertWorkspace(workspaceId, state);
    const previous = fileQueues.get(this.filePath) || Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      const all = await this.readAll();
      const existing = all[workspaceId];
      if (existing && (!(state[PERSISTED] || state._revision) || (existing._revision || null) !== (state._revision || null))) throw conflict();
      for (const other of Object.values(all)) if (other.workspace.id !== workspaceId && (other.users || []).some(user => (state.users || []).some(next => normalizeEmail(next.email) === normalizeEmail(user.email)))) {
        throw Object.assign(new Error('An account already exists for this email'), { status: 409, code: 'ACCOUNT_EXISTS' });
      }
      const upgraded = { ...upgradeState(state), _revision: crypto.randomUUID(), storageReady: false };
      all[workspaceId] = upgraded;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${crypto.randomUUID()}.tmp`;
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(all)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, this.filePath);
      state._revision = upgraded._revision;
      markPersisted(state);
      return markPersisted(upgraded);
    });
    fileQueues.set(this.filePath, write);
    try { return await write; } finally { if (fileQueues.get(this.filePath) === write) fileQueues.delete(this.filePath); }
  }

  async getForScheduler(workspaceId) { return this.get(workspaceId); }
  invalidateSchedulerCache() {}
  async listWorkspaceIds() { return Object.keys(await this.readAll()); }

  async getBrief(workspaceId, briefId) { return (await this.get(workspaceId))?.dailyBriefs?.find(item => item.id === briefId) || null; }

  async findUserByEmail(email) {
    const normalized = normalizeEmail(email);
    const all = await this.readAll();
    for (const state of Object.values(all)) {
      const user = (state.users || []).find(item => normalizeEmail(item.email) === normalized);
      if (user) return { ...user, workspaceId: state.workspace.id };
    }
    return null;
  }

  async enqueueAgentJob(workspaceId, job) {
    const existing = this.agentJobs.find(item => item.workspace_id === workspaceId && item.idempotency_key === job.idempotencyKey);
    if (existing) return structuredClone(existing);
    const row = {
      id: job.id, workspace_id: workspaceId, type: job.type, provider: job.provider, payload: job.payload,
      result: null, status: 'queued', priority: job.priority, attempts: 0, max_attempts: job.maxAttempts,
      ai_units: job.aiUnits, concurrency_limit: job.concurrencyLimit, idempotency_key: job.idempotencyKey,
      actor: job.actor, ai_provider:job.aiProvider || null, ai_model:job.aiModel || null, ai_tier:job.aiTier || null,
      available_at: job.availableAt, lease_until: null, worker_id: null, error_code: null,
      created_at: job.createdAt, updated_at: job.updatedAt, completed_at: null
    };
    this.agentJobs.push(row);
    return structuredClone(row);
  }

  async claimAgentJobs(workerId, limit = 8, leaseSeconds = 300) {
    const now = Date.now();
    for (const row of this.agentJobs) if (row.status === 'running' && Date.parse(row.lease_until) <= now) {
      Object.assign(row, { status:'queued', worker_id:null, lease_until:null, available_at:new Date(now).toISOString(), updated_at:new Date(now).toISOString(), error_code:'WORKER_LEASE_EXPIRED' });
    }
    const runningByWorkspace = new Map();
    for (const row of this.agentJobs) if (row.status === 'running' && Date.parse(row.lease_until) > now) runningByWorkspace.set(row.workspace_id, (runningByWorkspace.get(row.workspace_id) || 0) + 1);
    const runningProviders = new Set(this.agentJobs.filter(row => row.status === 'running' && Date.parse(row.lease_until) > now && row.provider).map(row => `${row.workspace_id}:${row.provider}`));
    const claimed = [];
    const seenWorkspace = new Set();
    for (const row of [...this.agentJobs].filter(row => row.status === 'queued' && Date.parse(row.available_at) <= now).sort((a,b) => b.priority-a.priority || Date.parse(a.created_at)-Date.parse(b.created_at))) {
      if (claimed.length >= limit || seenWorkspace.has(row.workspace_id)) continue;
      if ((runningByWorkspace.get(row.workspace_id) || 0) >= row.concurrency_limit) continue;
      if (row.provider && runningProviders.has(`${row.workspace_id}:${row.provider}`)) continue;
      Object.assign(row, { status:'running', attempts:row.attempts+1, worker_id:workerId, lease_until:new Date(now + leaseSeconds*1000).toISOString(), updated_at:new Date(now).toISOString() });
      claimed.push(structuredClone(row)); seenWorkspace.add(row.workspace_id);
    }
    return claimed;
  }

  async finishAgentJob(job, update) {
    const row = this.agentJobs.find(item => item.id === job.id);
    if (!row || (row.worker_id && job.worker_id && row.worker_id !== job.worker_id)) return null;
    Object.assign(row, {
      status:update.status, result:update.result ?? row.result, error_code:update.errorCode ?? null,
      completed_at:update.completedAt || null, lease_until:null, worker_id:null, updated_at:new Date().toISOString()
    });
    return structuredClone(row);
  }

  async rescheduleAgentJob(job, update) {
    const row = this.agentJobs.find(item => item.id === job.id);
    if (!row || (row.worker_id && job.worker_id && row.worker_id !== job.worker_id)) return null;
    Object.assign(row, { status:'queued', error_code:update.errorCode || null, available_at:update.availableAt, lease_until:null, worker_id:null, updated_at:new Date().toISOString() });
    return structuredClone(row);
  }

  async listAgentJobs(workspaceId, limit = 100) {
    return this.agentJobs.filter(item => item.workspace_id === workspaceId).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)).slice(0, limit).map(item => structuredClone(item));
  }

  async retryAgentJob(workspaceId, jobId) {
    const row = this.agentJobs.find(item => item.workspace_id === workspaceId && item.id === jobId);
    if (!row) return null;
    if (!['blocked','dead_letter'].includes(row.status)) return structuredClone(row);
    Object.assign(row, { status:'queued', attempts:0, available_at:new Date().toISOString(), lease_until:null, worker_id:null, error_code:null, completed_at:null, updated_at:new Date().toISOString() });
    return structuredClone(row);
  }

  async agentOpsUsage(workspaceId, day) {
    return this.agentJobs.filter(item => item.workspace_id === workspaceId && String(item.created_at).slice(0,10) === day)
      .reduce((sum,item)=>sum + Number(item.ai_units || 0), 0);
  }

  async recordAiUsage(workspaceId, usage) {
    const existing = usage.requestId ? this.aiUsage.find(item => item.workspace_id === workspaceId && item.provider === usage.provider && item.request_id === usage.requestId) : null;
    if (existing) return structuredClone(existing);
    const row = {
      id:usage.id, workspace_id:workspaceId, job_id:usage.jobId, task_type:usage.taskType,
      provider:usage.provider, model:usage.model, input_tokens:usage.inputTokens,
      cached_input_tokens:usage.cachedInputTokens, cache_write_tokens:usage.cacheWriteTokens,
      output_tokens:usage.outputTokens, estimated_cost_usd:usage.estimatedCostUsd,
      request_id:usage.requestId, occurred_at:usage.occurredAt, recorded_at:new Date().toISOString()
    };
    this.aiUsage.push(row);
    return structuredClone(row);
  }

  async aiUsageSummary(workspaceId, startAt, endAt) {
    const rows=this.aiUsage.filter(item => item.workspace_id === workspaceId && Date.parse(item.occurred_at) >= Date.parse(startAt) && Date.parse(item.occurred_at) < Date.parse(endAt));
    const byModel={};
    for(const row of rows) {
      const model=row.model || 'unknown';
      const current=byModel[model] ||= {model,requests:0,inputTokens:0,cachedInputTokens:0,cacheWriteTokens:0,outputTokens:0,estimatedCostUsd:0};
      current.requests++; current.inputTokens+=Number(row.input_tokens||0); current.cachedInputTokens+=Number(row.cached_input_tokens||0);
      current.cacheWriteTokens+=Number(row.cache_write_tokens||0); current.outputTokens+=Number(row.output_tokens||0);
      current.estimatedCostUsd+=Number(row.estimated_cost_usd||0);
    }
    const totals=Object.values(byModel).reduce((out,item)=>({
      requests:out.requests+item.requests,inputTokens:out.inputTokens+item.inputTokens,cachedInputTokens:out.cachedInputTokens+item.cachedInputTokens,
      cacheWriteTokens:out.cacheWriteTokens+item.cacheWriteTokens,outputTokens:out.outputTokens+item.outputTokens,estimatedCostUsd:out.estimatedCostUsd+item.estimatedCostUsd
    }),{requests:0,inputTokens:0,cachedInputTokens:0,cacheWriteTokens:0,outputTokens:0,estimatedCostUsd:0});
    totals.estimatedCostUsd=Number(totals.estimatedCostUsd.toFixed(8));
    for(const item of Object.values(byModel)) item.estimatedCostUsd=Number(item.estimatedCostUsd.toFixed(8));
    return {totals,byModel:Object.values(byModel).sort((a,b)=>b.estimatedCostUsd-a.estimatedCostUsd)};
  }

  async ping() { return true; }
}

class SupabaseStore {
  constructor(env, fetchImpl) {
    this.url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
    this.key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
    this.mirrorDigests = new Map();
    this.schedulerCache = new Map();
    this.schedulerWorkspaceIdsCache = null;
    this.schedulerCacheMaxAgeMs = Math.max(300000, Math.min(21600000, Number(env.SCHEDULER_STATE_CACHE_MS) || 3600000));
    this.schedulerRevisionCheckMs = Math.max(60000, Math.min(this.schedulerCacheMaxAgeMs, Number(env.SCHEDULER_REVISION_CHECK_MS) || 900000));
    this.schedulerWorkspaceIdsCacheMs = Math.max(60000, Math.min(3600000, Number(env.SCHEDULER_WORKSPACE_IDS_CACHE_MS) || 300000));
    this.fetch = fetchImpl;
    this.requestTimeoutMs = Math.max(20000, Math.min(60000, Number(env.SUPABASE_REQUEST_TIMEOUT_MS) || 30000));
    this.mirrorDeadlineMs = Math.max(12000, Math.min(60000, Number(env.SUPABASE_MIRROR_DEADLINE_MS) || 30000));
    this.telemetry = {
      lastSuccessfulReadAt: null,
      lastSuccessfulWriteAt: null,
      lastPrimaryWriteAt: null,
      lastPrimaryFailureAt: null,
      lastFailureAt: null,
      lastFailureCode: null,
      lastFailureHttpStatus: null,
      lastFailureTable: null,
      stateBytes: null,
      stateWarnBytes: SUPABASE_STATE_WARN_BYTES,
      stateHardBytes: SUPABASE_STATE_HARD_BYTES,
      embeddedAuditLimit: SUPABASE_EMBEDDED_AUDIT_LIMIT,
      reportingFailures: 0,
      reportingLastError: null,
      lastIntegrityCheckAt: null,
      schedulerCacheHits: 0,
      schedulerCacheMisses: 0,
      schedulerRevisionCheckMs: this.schedulerRevisionCheckMs,
      schedulerWorkspaceIdsCacheMs: this.schedulerWorkspaceIdsCacheMs,
      requestTimeoutMs: this.requestTimeoutMs,
      mirrorDeadlineMs: this.mirrorDeadlineMs
    };
    let parsed;
    try { parsed = new URL(this.url); } catch { throw new Error('SUPABASE_URL is invalid'); }
    if (parsed.protocol !== 'https:' && env.NODE_ENV === 'production') throw new Error('SUPABASE_URL must use HTTPS');
  }

  get provider() { return 'supabase'; }

  headers(extra = {}) {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      ...extra
    };
  }

  async request(pathname, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    let response;
    try {
      response = await this.fetch(`${this.url}/rest/v1/${pathname}`, {
        ...options,
        headers: this.headers(options.headers),
        signal: options.signal || AbortSignal.timeout(this.requestTimeoutMs)
      });
    } catch (cause) {
      const error = Object.assign(new Error('Supabase persistence request failed'), {
        code: 'SUPABASE_PERSISTENCE_FAILED',
        table: pathname.split('?')[0],
        payloadBytes: Buffer.byteLength(options.body || ''),
        cause
      });
      this.telemetry.lastFailureAt = new Date().toISOString();
      this.telemetry.lastFailureCode = cause?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR';
      this.telemetry.lastFailureHttpStatus = null;
      this.telemetry.lastFailureTable = error.table;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`Supabase persistence request failed (${response.status})`);
      error.code = 'SUPABASE_PERSISTENCE_FAILED';
      error.httpStatus = response.status;
      error.table = pathname.split('?')[0];
      error.payloadBytes = Buffer.byteLength(options.body || '');
      // Never log PostgREST messages/details: they can contain row data.
      try {
        const payload = await response.json();
        if (typeof payload?.code === 'string' && /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(payload.code)) {
          error.databaseCode = payload.code;
        }
      } catch { /* Non-JSON error responses retain HTTP/table diagnostics. */ }
      this.telemetry.lastFailureAt = new Date().toISOString();
      this.telemetry.lastFailureCode = error.databaseCode || error.code;
      this.telemetry.lastFailureHttpStatus = response.status;
      this.telemetry.lastFailureTable = error.table;
      throw error;
    }
    const succeededAt = new Date().toISOString();
    if (['GET', 'HEAD'].includes(method)) this.telemetry.lastSuccessfulReadAt = succeededAt;
    else this.telemetry.lastSuccessfulWriteAt = succeededAt;
    if (response.status === 204 || method === 'HEAD') return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async getIdentity(workspaceId) {
    const rows = await this.request(`saas_workspace_state?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=state->workspace,state->users&limit=1`);
    const state = rows?.[0];
    if (!state?.workspace || !Array.isArray(state.users)) return null;
    assertWorkspace(workspaceId, state);
    return { workspace: state.workspace, users: state.users.map(user => ({
      active: true, sessionVersion: 1, ...user,
      passwordChangeRequired: typeof user.passwordChangeRequired === 'boolean' ? user.passwordChangeRequired : workspaceId === 'packsmart-solutions' && !user.passwordHash
    })) };
  }

  rememberSchedulerState(workspaceId, state) {
    if (!state) { this.schedulerCache.delete(workspaceId); return; }
    const now = Date.now();
    this.schedulerCache.set(workspaceId, { at:now, checkedAt:now, state:structuredClone(state) });
    if (this.schedulerWorkspaceIdsCache && !this.schedulerWorkspaceIdsCache.ids.includes(workspaceId)) {
      this.schedulerWorkspaceIdsCache.ids.push(workspaceId);
      this.schedulerWorkspaceIdsCache.ids.sort();
    }
  }

  invalidateSchedulerCache(workspaceId) {
    this.schedulerCache.delete(workspaceId);
  }

  async get(workspaceId) {
    const rows = await this.request(`saas_workspace_state?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=state&limit=1`);
    if (!rows?.[0]?.state) { this.rememberSchedulerState(workspaceId, null); return null; }
    const state = upgradeState(rows[0].state);
    state.storageReady = true;
    assertWorkspace(workspaceId, state);
    const persisted = markPersisted(state);
    this.rememberSchedulerState(workspaceId, persisted);
    return persisted;
  }

  async schedulerRevision(workspaceId) {
    const rows = await this.request(`saas_workspace_state?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=revision:state->>_revision&limit=1`);
    return rows?.[0]?.revision || null;
  }

  async getForScheduler(workspaceId) {
    const cached = this.schedulerCache.get(workspaceId);
    const now = Date.now();
    if (cached && now - cached.at < this.schedulerCacheMaxAgeMs) {
      if (now - (cached.checkedAt || cached.at) < this.schedulerRevisionCheckMs) {
        this.telemetry.schedulerCacheHits++;
        const state = upgradeState(structuredClone(cached.state));
        state.storageReady = true;
        return markPersisted(state);
      }
      const revision = await this.schedulerRevision(workspaceId);
      if (revision && revision === cached.state?._revision) {
        cached.checkedAt = now;
        this.telemetry.schedulerCacheHits++;
        const state = upgradeState(structuredClone(cached.state));
        state.storageReady = true;
        return markPersisted(state);
      }
      this.schedulerCache.delete(workspaceId);
    }
    this.telemetry.schedulerCacheMisses++;
    return this.get(workspaceId);
  }

  async upsert(table, rows, conflict, options = {}) {
    if (!rows.length) return;
    const requestOptions = {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
      ...options
    };
    try {
      await this.request(`${table}?on_conflict=${encodeURIComponent(conflict)}`, requestOptions);
    } catch (error) {
      if (error.code !== 'SUPABASE_PERSISTENCE_FAILED' || error.httpStatus) throw error;
      // Upserts are idempotent on the declared conflict key, so a single retry is
      // safe when the network outcome is unknown.
      await new Promise(resolve => setTimeout(resolve, 250));
      await this.request(`${table}?on_conflict=${encodeURIComponent(conflict)}`, requestOptions);
    }
  }

  async mirrorNormalized(workspaceId, state) {
    const errors = [];
    const deadline = Date.now() + this.mirrorDeadlineMs;
    const mirror = async (table, rows, conflict) => {
      if (!rows.length) return;
      try {
        const cacheKey = `${workspaceId}:${table}`, previous = this.mirrorDigests.get(cacheKey) || new Map();
        const fingerprinted = rows.map(row => ({ row, key: conflict.split(',').map(key => String(row[key])).join(':'), hash: crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex') }));
        const changed = fingerprinted.filter(item => previous.get(item.key) !== item.hash);
        if (!changed.length) return;
        if (Date.now() >= deadline) throw Object.assign(new Error('Mirror deferred'), { code: 'MIRROR_DEFERRED' });
        await this.upsert(table, changed.map(item => item.row), conflict, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
        // Cache only confirmed writes. Failed mirrors are retried on the next save.
        this.mirrorDigests.set(cacheKey, new Map(fingerprinted.map(item => [item.key, item.hash])));
      } catch (error) {
        errors.push({ table, code: error.code === 'SUPABASE_PERSISTENCE_FAILED' ? error.code : 'MIRROR_DEFERRED', httpStatus: error.httpStatus || null, databaseCode: error.databaseCode || null });
      }
    };
    const workspace = state.workspace;
    await mirror('workspaces', [{
      id: workspaceId,
      name: workspace.name,
      slug: workspace.slug,
      settings: { schemaVersion: state.schemaVersion },
      created_at: workspace.createdAt,
      updated_at: workspace.updatedAt || new Date().toISOString()
    }], 'id');

    await mirror('users', (state.users || []).map(user => ({
      id: user.id,
      workspace_id: workspaceId,
      email: normalizeEmail(user.email),
      role: user.role,
      password_hash: user.passwordHash || null,
      password_change_required: Boolean(user.passwordChangeRequired),
      active: user.active !== false,
      session_version: Number(user.sessionVersion) || 1,
      created_at: user.createdAt,
      updated_at: user.updatedAt || user.createdAt
    })), 'id');

    await mirror('connections', (state.connections || []).map(connection => ({
      id: connection.id,
      workspace_id: workspaceId,
      provider: connection.provider,
      label: connection.label,
      status: connection.status,
      encrypted_credentials: connection.encryptedCredentials || null,
      capabilities: connection.capabilities || [],
      metadata: connection.metadata || {},
      last_sync_at: connection.lastSyncAt || null,
      last_error: connection.lastError || null,
      created_at: connection.createdAt,
      updated_at: connection.updatedAt || connection.createdAt
    })), 'id');

    const products = state.products || [];
    await mirror('products', products.map(product => ({
      id: product.id,
      workspace_id: workspaceId,
      provider: product.provider || 'shopify',
      external_id: product.externalId || product.id,
      title: product.title,
      handle: product.handle || '',
      status: product.status || 'unknown',
      product_type: product.productType || '',
      description: product.description || '',
      image_url: product.image || null,
      inventory_total: product.inventory,
      raw: {},
      source_updated_at: product.updatedAt || null,
      updated_at: new Date().toISOString()
    })), 'workspace_id,id');

    // Preserve old reporting IDs while matching on source identity, never SKU.
    const existingVariants = new Map();
    let variantsAvailable = true;
    if (products.length) try {
      for (let offset = 0; ; offset += 500) {
        const rows = await this.request(`variants?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=id,product_id,external_id&order=id&limit=500&offset=${offset}`, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
        for (const row of rows || []) existingVariants.set(`${row.product_id}:${row.external_id}`, row.id);
        if ((rows || []).length < 500) break;
      }
    } catch (error) {
      variantsAvailable = false;
      errors.push({ table: 'variants', code: 'VARIANT_IDENTITY_READ_FAILED', httpStatus: error.httpStatus || null, databaseCode: error.databaseCode || null });
    }
    const variants = products.flatMap(product => (product.variants || []).map(variant => ({
      id: existingVariants.get(`${product.id}:${variant.externalId || variant.id || ''}`) || variant.externalId || `${product.id}:${variant.id || variant.sku}`,
      workspace_id: workspaceId,
      product_id: product.id,
      external_id: variant.externalId || variant.id || '',
      sku: variant.sku || '',
      title: variant.title || 'Default',
      price: numericOrNull(variant.price) ?? 0,
      inventory_quantity: variant.inventory,
      available: variant.available !== false,
      image_url: variant.image || product.image || null,
      raw: {},
      updated_at: new Date().toISOString()
    })));
    if (variantsAvailable) await mirror('variants', variants, 'workspace_id,id');

    const variantBySku = new Map();
    if (variantsAvailable) for (const variant of variants) variantBySku.set(variant.sku, variantBySku.has(variant.sku) ? null : variant.id);
    await mirror('economics', Object.entries(state.economics || {}).map(([sku, economics]) => ({
      workspace_id: workspaceId,
      sku,
      variant_id: variantBySku.get(sku) || null,
      landed_cost: numericOrNull(economics.landed),
      packing_cost: numericOrNull(economics.packing),
      delivery_cost: numericOrNull(economics.delivery),
      channel_fee: numericOrNull(economics.channelFee),
      margin_floor: numericOrNull(economics.marginFloor),
      updated_at: new Date().toISOString()
    })), 'workspace_id,sku');

    await mirror('product_cost_profiles', Object.entries(state.economics || {}).map(([sku, economics]) => ({
      workspace_id: workspaceId,
      sku,
      cost_data: economics,
      updated_at: economics.updatedAt || new Date().toISOString()
    })), 'workspace_id,sku');

    await mirror('suppliers', (state.suppliers || []).map(supplier => ({
      id: supplier.id,
      workspace_id: workspaceId,
      name: supplier.name,
      active: supplier.active !== false,
      notes: supplier.notes || '',
      metadata: supplier.metadata || {},
      created_at: supplier.createdAt,
      updated_at: supplier.updatedAt || supplier.createdAt
    })), 'id');

    await mirror('cost_history', (state.costHistory || []).slice(0, 5000).map(event => ({
      id: event.id,
      workspace_id: workspaceId,
      sku: event.sku,
      changed_by: event.changedBy || 'system',
      changed_fields: event.changedFields || [],
      before_data: event.before || {},
      after_data: event.after || {},
      created_at: event.createdAt
    })), 'id');

    await mirror('automation_rules', Object.entries(state.automations || {}).map(([ruleId, enabled]) => ({
      workspace_id: workspaceId,
      rule_id: ruleId,
      enabled: Boolean(enabled),
      config: state.autopilot?.rules?.[ruleId] || {},
      updated_at: new Date().toISOString()
    })), 'workspace_id,rule_id');

    await mirror('approval_requests', (state.approvals || []).map(approval => ({
      id: approval.id,
      workspace_id: workspaceId,
      type: approval.type,
      proposed_action: approval.action || approval.type,
      reason: approval.reason || '',
      financial_impact: approval.financialImpact,
      expected_benefit: approval.expectedBenefit || '',
      risk: approval.risk || '',
      requested_by: approval.requestedBy || 'system',
      source: approval.source || 'packsmart-ops',
      payload: approval.payload || {},
      status: approval.status,
      created_at: approval.createdAt,
      decided_at: approval.decidedAt,
      decided_by: approval.decidedBy,
      decision_note: approval.decisionNote,
      executed_externally: Boolean(approval.executedExternally),
      execution_status: approval.executionStatus || 'not_connected'
    })), 'id');

    await mirror('audit_events', (state.audit || []).map(event => ({
      id: event.id,
      workspace_id: workspaceId,
      type: event.type,
      actor: event.actor,
      detail: event.detail || {},
      created_at: event.createdAt
    })), 'id');

    await mirror('subscriptions', [{
      workspace_id: workspaceId,
      plan: state.subscription?.plan || 'starter',
      status: state.subscription?.status || 'pending',
      stripe_customer_id: state.subscription?.stripeCustomerId || null,
      stripe_subscription_id: state.subscription?.stripeSubscriptionId || null,
      usage: state.subscription?.usage || {},
      updated_at: state.subscription?.updatedAt || new Date().toISOString()
    }], 'workspace_id');

    await mirror('orders', (state.orders || []).map(order => ({
      id: order.id,
      workspace_id: workspaceId,
      provider: order.provider || 'shopify',
      external_id: order.externalId || order.id,
      order_name: order.name || '',
      financial_status: order.financialStatus || 'UNKNOWN',
      fulfillment_status: order.fulfillmentStatus || 'UNKNOWN',
      total: numericOrNull(order.total) ?? 0,
      currency: order.currency || 'GBP',
      ordered_at: order.createdAt,
      source_updated_at: order.updatedAt || order.createdAt,
      cancelled_at: order.cancelledAt || null,
      updated_at: new Date().toISOString()
    })), 'workspace_id,id');

    await mirror('order_financials', (state.orders || []).map(order => ({
      workspace_id: workspaceId,
      order_id: order.id,
      provider: order.provider || 'shopify',
      financial_data: {
        currentTotal: order.currentTotal,
        discounts: order.discounts,
        refunds: order.refunds,
        tax: order.tax,
        currentTax: order.currentTax,
        shippingCharged: order.shippingCharged,
        actualShippingCost: order.actualShippingCost,
        paymentFees: order.paymentFees,
        channelFees: order.channelFees,
        advertisingCost: order.advertisingCost,
        otherVariableCosts: order.otherVariableCosts,
        paymentGatewayNames: order.paymentGatewayNames || []
      },
      line_items: order.lineItems || [],
      updated_at: order.updatedAt || new Date().toISOString()
    })), 'workspace_id,order_id');

    await mirror('advertising_costs', (state.advertisingCosts || []).map(record => ({
      id: record.id,
      workspace_id: workspaceId,
      channel: record.channel,
      spend: numericOrNull(record.spend),
      attributable_revenue: numericOrNull(record.attributableRevenue),
      period_date: record.date || record.createdAt,
      source: record.source || 'manual',
      metadata: record.metadata || {},
      created_at: record.createdAt,
      updated_at: record.updatedAt || record.createdAt
    })), 'id');

    // Archived full snapshots are immutable: never replace them with summaries.
    await mirror('operations_briefs', (state.dailyBriefs || []).filter(brief => !brief.archive).map(brief => ({
      id: brief.id,
      workspace_id: workspaceId,
      summary: brief.summary,
      metrics: brief,
      logic: brief.logic || 'deterministic-v1',
      created_at: brief.generatedAt
    })), 'id');
    return errors;
  }

  async commit(workspaceId, state, expectedRevision, existing) {
    const stateBytes = Buffer.byteLength(JSON.stringify(state));
    this.telemetry.stateBytes = stateBytes;
    if (stateBytes >= SUPABASE_STATE_HARD_BYTES) {
      const error = Object.assign(new Error('Workspace state is too large to persist safely'), {
        status: 503, code: 'STATE_SIZE_LIMIT', stateBytes
      });
      this.telemetry.lastPrimaryFailureAt = new Date().toISOString();
      throw error;
    }
    if (stateBytes >= SUPABASE_STATE_WARN_BYTES) {
      console.warn(JSON.stringify({ event: 'supabase_state_size_warning', workspaceId, stateBytes, warnBytes: SUPABASE_STATE_WARN_BYTES, hardBytes: SUPABASE_STATE_HARD_BYTES }));
    }
    const record = { workspace_id: workspaceId, state, updated_at: new Date().toISOString() };
    if (existing) {
      const revisionFilter = expectedRevision ? `eq.${encodeURIComponent(expectedRevision)}` : 'is.null';
      const path = `saas_workspace_state?workspace_id=eq.${encodeURIComponent(workspaceId)}&state->>_revision=${revisionFilter}&select=workspace_id`;
      const options = { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(record) };
      let rows;
      try { rows = await this.request(path, options); }
      catch (error) {
        if (error.databaseCode === '57014') {
          // PostgreSQL cancelled this statement. Retry the same revision-guarded
          // write once; do not repeat any provider operation or business callback.
          await new Promise(resolve => setTimeout(resolve, 250));
          rows = await this.request(path, options);
        } else if (error.code === 'SUPABASE_PERSISTENCE_FAILED' && !error.httpStatus) {
          // A network timeout can happen after Postgres has already committed.
          // Resolve the uncertainty by reading the authoritative revision before
          // deciding whether to retry, accept success, or surface a conflict.
          let currentRevision = null;
          try { currentRevision = await this.schedulerRevision(workspaceId); } catch {}
          if (currentRevision === state._revision) {
            rows = [{ workspace_id: workspaceId }];
          } else if (currentRevision === expectedRevision || (!expectedRevision && !currentRevision)) {
            await new Promise(resolve => setTimeout(resolve, 250));
            try { rows = await this.request(path, options); }
            catch (retryError) {
              if (retryError.code !== 'SUPABASE_PERSISTENCE_FAILED' || retryError.httpStatus) throw retryError;
              let retryRevision = null;
              try { retryRevision = await this.schedulerRevision(workspaceId); } catch {}
              if (retryRevision === state._revision) rows = [{ workspace_id: workspaceId }];
              else throw retryError;
            }
          } else if (currentRevision) {
            throw conflict();
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }
      if (!rows?.length) throw conflict();
      this.telemetry.lastPrimaryWriteAt = new Date().toISOString();
    } else {
      // Atomically create the FK parent, unique login identity and primary state.
      try {
        await this.request('rpc/runvara_create_workspace', { method: 'POST', body: JSON.stringify({ p_state: state }) });
        this.telemetry.lastPrimaryWriteAt = new Date().toISOString();
      } catch (error) {
        this.telemetry.lastPrimaryFailureAt = new Date().toISOString();
        if (error.databaseCode === '23505') throw conflict();
        throw error;
      }
    }
  }

  async archiveHistory(workspaceId, collection, records) {
    if (!records.length) return;
    const rows = records.map((record, index) => ({
      workspace_id: workspaceId,
      collection,
      record_id: String(record?.id || `${collection}_${index}_${crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 24)}`),
      payload: record,
      occurred_at: record?.completedAt || record?.startedAt || record?.updatedAt || record?.createdAt || null,
      archived_at: new Date().toISOString()
    }));
    for (let offset = 0; offset < rows.length; offset += 200) {
      await this.upsert('runvara_history', rows.slice(offset, offset + 200), 'workspace_id,collection,record_id');
    }
  }

  async archiveAndCompact(workspaceId, state) {
    const audit = state.audit || [];
    const archivedAudit = audit.slice(SUPABASE_EMBEDDED_AUDIT_LIMIT);
    if (archivedAudit.length) {
      for (let offset = 0; offset < archivedAudit.length; offset += 200) {
        await this.upsert('audit_events', archivedAudit.slice(offset, offset + 200).map(event => ({
          id: event.id,
          workspace_id: workspaceId,
          type: event.type,
          actor: event.actor,
          detail: event.detail || {},
          created_at: event.createdAt
        })), 'id');
      }
    }

    const workRecords = state.workRecords || [];
    await this.archiveHistory(workspaceId, 'workRecords', workRecords.slice(SUPABASE_WORK_RECORD_LIMIT));
    state.workRecords = workRecords.slice(0, SUPABASE_WORK_RECORD_LIMIT);

    const syncs = state.connectionSyncs || [];
    const keptSyncs = [], archivedSyncs = [];
    for (const run of syncs) {
      if (run.status === 'running' || keptSyncs.length < SUPABASE_CONNECTION_SYNC_LIMIT) keptSyncs.push(run);
      else archivedSyncs.push(run);
    }
    await this.archiveHistory(workspaceId, 'connectionSyncs', archivedSyncs);
    state.connectionSyncs = keptSyncs;

    const agentRuns = state.agentRuns || [];
    await this.archiveHistory(workspaceId, 'agentRuns', agentRuns.slice(SUPABASE_AGENT_RUN_LIMIT));
    state.agentRuns = agentRuns.slice(0, SUPABASE_AGENT_RUN_LIMIT);

    const today = new Date().toISOString().slice(0, 10);
    const seenRules = new Set();
    const keptAutomation = [], archivedAutomation = [];
    for (const run of state.automationRuns || []) {
      const ruleId = String(run.ruleId || 'unknown');
      const isToday = String(run.startedAt || '').slice(0, 10) === today;
      if (isToday || !seenRules.has(ruleId) || run.status === 'IN PROGRESS') {
        keptAutomation.push(run);
        seenRules.add(ruleId);
      } else archivedAutomation.push(run);
    }
    await this.archiveHistory(workspaceId, 'automationRuns', archivedAutomation);
    state.automationRuns = keptAutomation;

    const briefs = state.dailyBriefs || [];
    const keepBriefs = briefs.slice(0, SUPABASE_DAILY_BRIEF_LIMIT);
    const archivedBriefs = briefs.slice(SUPABASE_DAILY_BRIEF_LIMIT);
    for (const brief of archivedBriefs) {
      if (!brief?.id) continue;
      await this.upsert('operations_briefs', [{
        id: brief.id,
        workspace_id: workspaceId,
        summary: brief.summary || '',
        metrics: brief.archive ? ((await this.request(`operations_briefs?workspace_id=eq.${encodeURIComponent(workspaceId)}&id=eq.${encodeURIComponent(brief.id)}&select=metrics&limit=1`))?.[0]?.metrics || brief) : brief,
        logic: brief.logic || 'deterministic-v1',
        created_at: brief.generatedAt || new Date().toISOString()
      }], 'id');
    }
    state.dailyBriefs = keepBriefs;
    state.audit = audit.slice(0, SUPABASE_EMBEDDED_AUDIT_LIMIT);
  }

  async save(workspaceId, state) {
    assertWorkspace(workspaceId, state);
    const existing = Boolean(state[PERSISTED] || state._revision);
    const upgraded = { ...upgradeState(state), _revision: crypto.randomUUID(), storageReady: true };
    // Archive append-only operational histories before compacting existing hot state.
    // New workspaces have no parent FK row yet and start below retention limits.
    if (existing) await this.archiveAndCompact(workspaceId, upgraded);
    else {
      upgraded.audit = (upgraded.audit || []).slice(0, SUPABASE_EMBEDDED_AUDIT_LIMIT);
      upgraded.workRecords = (upgraded.workRecords || []).slice(0, SUPABASE_WORK_RECORD_LIMIT);
      upgraded.connectionSyncs = (upgraded.connectionSyncs || []).slice(0, SUPABASE_CONNECTION_SYNC_LIMIT);
      upgraded.agentRuns = (upgraded.agentRuns || []).slice(0, SUPABASE_AGENT_RUN_LIMIT);
      upgraded.dailyBriefs = (upgraded.dailyBriefs || []).slice(0, SUPABASE_DAILY_BRIEF_LIMIT);
    }
    upgraded.workspace.updatedAt = new Date().toISOString();
    if (existing) {
      const briefs = [];
      for (const brief of upgraded.dailyBriefs) {
        if (brief.archive || Buffer.byteLength(JSON.stringify(brief)) <= 65536) { briefs.push(brief); continue; }
        // Commit the full historical snapshot before replacing it with a pointer.
        // One snapshot per request also avoids the gateway's bulk payload limit.
        await this.upsert('operations_briefs', [{ id: brief.id, workspace_id: workspaceId, summary: brief.summary,
          metrics: brief, logic: brief.logic || 'deterministic-v1', created_at: brief.generatedAt }], 'id');
        briefs.push({ ...compactDailyBrief(brief), archive: { table: 'operations_briefs', id: brief.id, sha256: crypto.createHash('sha256').update(JSON.stringify(brief)).digest('hex') } });
      }
      upgraded.dailyBriefs = briefs;
    }
    const now = new Date().toISOString();
    upgraded.integrationStatus.supabase = { status: 'connected', detail: 'Authoritative workspace state committed.', lastSyncAt: now, lastError: null };
    upgraded.integrationStatus.reporting = { ...upgraded.integrationStatus.reporting, status: 'degraded', detail: 'Reporting refresh pending; authoritative state is durable.' };
    await this.commit(workspaceId, upgraded, state._revision, existing);
    state._revision = upgraded._revision;
    for (const key of ['audit', 'workRecords', 'automationRuns', 'connectionSyncs', 'agentRuns', 'dailyBriefs']) state[key] = upgraded[key];
    markPersisted(state);
    const failures = await this.mirrorNormalized(workspaceId, upgraded);
    this.telemetry.reportingFailures = failures.length;
    this.telemetry.reportingLastError = failures[0]?.databaseCode || failures[0]?.code || null;
    const report = { status: failures.length ? 'degraded' : 'connected', detail: failures.length ? `${failures.length} reporting tables need repair; primary workspace data remains durable.` : 'Reporting refresh completed.',
      lastSyncAt: failures.length ? (state.integrationStatus?.reporting?.lastSyncAt || null) : now,
      lastFailureAt: failures.length ? now : (state.integrationStatus?.reporting?.lastFailureAt || null), lastError: failures[0]?.databaseCode || failures[0]?.code || null, failures };
    for (const failure of failures) console.warn(JSON.stringify({ event: 'supabase_mirror_refresh_failed', workspaceId, ...failure }));
    upgraded.integrationStatus.reporting = report;
    const expected = upgraded._revision;
    upgraded._revision = crypto.randomUUID();
    try {
      await this.commit(workspaceId, upgraded, expected, true);
      state._revision = upgraded._revision;
      state.integrationStatus = upgraded.integrationStatus;
    } catch (error) {
      // Primary commit already succeeded. Never replay its business action, and
      // never overwrite a newer concurrent state merely to update diagnostics.
      upgraded._revision = expected;
      upgraded.integrationStatus.reporting = { status: 'degraded', detail: 'Reporting status update deferred; primary workspace data is durable.', lastError: 'REPORTING_STATUS_DEFERRED' };
      console.warn(JSON.stringify({ event: 'reporting_status_deferred', workspaceId, code: error.code || 'PERSISTENCE_UNAVAILABLE' }));
    }
    const persisted = markPersisted(upgraded);
    this.rememberSchedulerState(workspaceId, persisted);
    return persisted;
  }

  async findUserByEmail(email) {
    const normalized = normalizeEmail(email);
    const filter = encodeURIComponent(JSON.stringify([{ email: normalized }]));
    const rows = await this.request(`saas_workspace_state?state->users=cs.${filter}&select=workspace_id,state->users&limit=2`);
    if (rows?.length > 1) throw Object.assign(new Error('Ambiguous account'), { code: 'ACCOUNT_CONFLICT' });
    const user = rows?.[0]?.users?.find(item => normalizeEmail(item.email) === normalized);
    return user ? { ...user, workspaceId: rows[0].workspace_id } : null;
  }

  async getBrief(workspaceId, briefId) {
    const state = await this.get(workspaceId);
    const brief = state?.dailyBriefs?.find(item => item.id === briefId);
    if (!brief?.archive) return brief || null;
    const rows = await this.request(`operations_briefs?workspace_id=eq.${encodeURIComponent(workspaceId)}&id=eq.${encodeURIComponent(briefId)}&select=metrics&limit=1`);
    if (!rows?.[0]?.metrics) throw Object.assign(new Error('Historical brief is temporarily unavailable'), { status: 503, code: 'BRIEF_ARCHIVE_UNAVAILABLE' });
    return rows[0].metrics;
  }

  async enqueueAgentJob(workspaceId, job) {
    const key = encodeURIComponent(job.idempotencyKey);
    const existing = await this.request(`runvara_agent_jobs?workspace_id=eq.${encodeURIComponent(workspaceId)}&idempotency_key=eq.${key}&select=*&limit=1`);
    if (existing?.[0]) return existing[0];
    const row = {
      id: job.id, workspace_id: workspaceId, type: job.type, provider: job.provider, payload: job.payload,
      status:'queued', priority:job.priority, attempts:0, max_attempts:job.maxAttempts, ai_units:job.aiUnits,
      concurrency_limit:job.concurrencyLimit, idempotency_key:job.idempotencyKey, actor:job.actor,
      ai_provider:job.aiProvider || null, ai_model:job.aiModel || null, ai_tier:job.aiTier || null,
      available_at:job.availableAt, created_at:job.createdAt, updated_at:job.updatedAt
    };
    try {
      const rows = await this.request('runvara_agent_jobs?select=*', { method:'POST', headers:{ Prefer:'return=representation' }, body:JSON.stringify(row) });
      return rows?.[0] || row;
    } catch (error) {
      if (error.httpStatus !== 409 && error.databaseCode !== '23505') throw error;
      const raced = await this.request(`runvara_agent_jobs?workspace_id=eq.${encodeURIComponent(workspaceId)}&idempotency_key=eq.${key}&select=*&limit=1`);
      if (raced?.[0]) return raced[0];
      throw error;
    }
  }

  async claimAgentJobs(workerId, limit = 8, leaseSeconds = 300) {
    return await this.request('rpc/runvara_claim_agent_jobs', { method:'POST', body:JSON.stringify({ p_worker_id:workerId, p_limit:limit, p_lease_seconds:leaseSeconds }) }) || [];
  }

  async finishAgentJob(job, update) {
    const worker = encodeURIComponent(job.worker_id || '');
    const rows = await this.request(`runvara_agent_jobs?id=eq.${encodeURIComponent(job.id)}&status=eq.running&worker_id=eq.${worker}&select=*`, {
      method:'PATCH', headers:{ Prefer:'return=representation' }, body:JSON.stringify({
        status:update.status, result:update.result ?? null, error_code:update.errorCode ?? null,
        completed_at:update.completedAt || null, lease_until:null, worker_id:null, updated_at:new Date().toISOString()
      })
    });
    return rows?.[0] || null;
  }

  async rescheduleAgentJob(job, update) {
    const worker = encodeURIComponent(job.worker_id || '');
    const rows = await this.request(`runvara_agent_jobs?id=eq.${encodeURIComponent(job.id)}&status=eq.running&worker_id=eq.${worker}&select=*`, {
      method:'PATCH', headers:{ Prefer:'return=representation' }, body:JSON.stringify({
        status:'queued', error_code:update.errorCode || null, available_at:update.availableAt,
        lease_until:null, worker_id:null, updated_at:new Date().toISOString()
      })
    });
    return rows?.[0] || null;
  }

  async listAgentJobs(workspaceId, limit = 100) {
    return await this.request(`runvara_agent_jobs?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=*&order=created_at.desc&limit=${Math.max(1,Math.min(500,Number(limit)||100))}`) || [];
  }

  async retryAgentJob(workspaceId, jobId) {
    const rows = await this.request(`runvara_agent_jobs?workspace_id=eq.${encodeURIComponent(workspaceId)}&id=eq.${encodeURIComponent(jobId)}&status=in.(blocked,dead_letter)&select=*`, {
      method:'PATCH', headers:{ Prefer:'return=representation' }, body:JSON.stringify({
        status:'queued', attempts:0, available_at:new Date().toISOString(), lease_until:null, worker_id:null,
        error_code:null, completed_at:null, updated_at:new Date().toISOString()
      })
    });
    if (rows?.[0]) return rows[0];
    return (await this.request(`runvara_agent_jobs?workspace_id=eq.${encodeURIComponent(workspaceId)}&id=eq.${encodeURIComponent(jobId)}&select=*&limit=1`))?.[0] || null;
  }

  async agentOpsUsage(workspaceId, day) {
    const next = new Date(`${day}T00:00:00.000Z`); next.setUTCDate(next.getUTCDate()+1);
    const rows = await this.request(`runvara_agent_jobs?workspace_id=eq.${encodeURIComponent(workspaceId)}&created_at=gte.${encodeURIComponent(day+'T00:00:00.000Z')}&created_at=lt.${encodeURIComponent(next.toISOString())}&select=ai_units`);
    return (rows || []).reduce((sum,row)=>sum + Number(row.ai_units || 0),0);
  }

  async recordAiUsage(workspaceId, usage) {
    const row={
      id:usage.id, workspace_id:workspaceId, job_id:usage.jobId, task_type:usage.taskType,
      provider:usage.provider, model:usage.model, input_tokens:usage.inputTokens,
      cached_input_tokens:usage.cachedInputTokens, cache_write_tokens:usage.cacheWriteTokens,
      output_tokens:usage.outputTokens, estimated_cost_usd:usage.estimatedCostUsd,
      request_id:usage.requestId, occurred_at:usage.occurredAt
    };
    try {
      const rows=await this.request('runvara_ai_usage?select=*',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(row)});
      return rows?.[0]||row;
    } catch(error) {
      if ((error.httpStatus===409 || error.databaseCode==='23505') && usage.requestId) {
        const rows=await this.request(`runvara_ai_usage?workspace_id=eq.${encodeURIComponent(workspaceId)}&provider=eq.${encodeURIComponent(usage.provider)}&request_id=eq.${encodeURIComponent(usage.requestId)}&select=*&limit=1`);
        if(rows?.[0]) return rows[0];
      }
      throw error;
    }
  }

  async aiUsageSummary(workspaceId, startAt, endAt) {
    const rows=await this.request(`runvara_ai_usage?workspace_id=eq.${encodeURIComponent(workspaceId)}&occurred_at=gte.${encodeURIComponent(startAt)}&occurred_at=lt.${encodeURIComponent(endAt)}&select=model,input_tokens,cached_input_tokens,cache_write_tokens,output_tokens,estimated_cost_usd`)||[];
    const byModel={};
    for(const row of rows) {
      const model=row.model||'unknown';
      const current=byModel[model] ||= {model,requests:0,inputTokens:0,cachedInputTokens:0,cacheWriteTokens:0,outputTokens:0,estimatedCostUsd:0};
      current.requests++; current.inputTokens+=Number(row.input_tokens||0); current.cachedInputTokens+=Number(row.cached_input_tokens||0);
      current.cacheWriteTokens+=Number(row.cache_write_tokens||0); current.outputTokens+=Number(row.output_tokens||0);
      current.estimatedCostUsd+=Number(row.estimated_cost_usd||0);
    }
    const totals=Object.values(byModel).reduce((out,item)=>({
      requests:out.requests+item.requests,inputTokens:out.inputTokens+item.inputTokens,cachedInputTokens:out.cachedInputTokens+item.cachedInputTokens,
      cacheWriteTokens:out.cacheWriteTokens+item.cacheWriteTokens,outputTokens:out.outputTokens+item.outputTokens,estimatedCostUsd:out.estimatedCostUsd+item.estimatedCostUsd
    }),{requests:0,inputTokens:0,cachedInputTokens:0,cacheWriteTokens:0,outputTokens:0,estimatedCostUsd:0});
    totals.estimatedCostUsd=Number(totals.estimatedCostUsd.toFixed(8));
    for(const item of Object.values(byModel)) item.estimatedCostUsd=Number(item.estimatedCostUsd.toFixed(8));
    return {totals,byModel:Object.values(byModel).sort((a,b)=>b.estimatedCostUsd-a.estimatedCostUsd)};
  }

  async listWorkspaceIds() {
    const now = Date.now();
    if (this.schedulerWorkspaceIdsCache && now - this.schedulerWorkspaceIdsCache.at < this.schedulerWorkspaceIdsCacheMs) {
      return [...this.schedulerWorkspaceIdsCache.ids];
    }
    const ids = [];
    for (let offset = 0; ; offset += 200) {
      const rows = await this.request(`saas_workspace_state?select=workspace_id&order=workspace_id&limit=200&offset=${offset}`);
      ids.push(...(rows || []).map(row => row.workspace_id));
      if ((rows || []).length < 200) {
        this.schedulerWorkspaceIdsCache = { at:now, ids:[...ids] };
        return ids;
      }
    }
  }

  diagnostics() {
    const primaryPersistence = !this.telemetry.lastPrimaryFailureAt ||
      (this.telemetry.lastPrimaryWriteAt && this.telemetry.lastPrimaryWriteAt >= this.telemetry.lastPrimaryFailureAt);
    return {
      ...this.telemetry,
      primaryPersistence,
      stateSizeStatus: this.telemetry.stateBytes === null ? 'unknown' :
        this.telemetry.stateBytes >= SUPABASE_STATE_HARD_BYTES ? 'critical' :
        this.telemetry.stateBytes >= SUPABASE_STATE_WARN_BYTES ? 'warning' : 'healthy'
    };
  }

  async integrityCheck(workspaceId) {
    const rows = await this.request(`saas_workspace_state?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=state&limit=1`);
    const state = rows?.[0]?.state;
    if (!state) return { workspaceId, healthy: false, code: 'WORKSPACE_STATE_MISSING' };
    const stateBytes = Buffer.byteLength(JSON.stringify(state));
    const embeddedAuditCount = Array.isArray(state.audit) ? state.audit.length : 0;
    const workRecordCount = Array.isArray(state.workRecords) ? state.workRecords.length : 0;
    const connectionSyncCount = Array.isArray(state.connectionSyncs) ? state.connectionSyncs.length : 0;
    const agentRunCount = Array.isArray(state.agentRuns) ? state.agentRuns.length : 0;
    const dailyBriefCount = Array.isArray(state.dailyBriefs) ? state.dailyBriefs.length : 0;
    const automationRunCount = Array.isArray(state.automationRuns) ? state.automationRuns.length : 0;
    const reportingStatus = state.integrationStatus?.reporting?.status || 'unknown';
    this.telemetry.stateBytes = stateBytes;
    this.telemetry.lastIntegrityCheckAt = new Date().toISOString();
    const healthy = stateBytes < SUPABASE_STATE_HARD_BYTES &&
      embeddedAuditCount <= SUPABASE_EMBEDDED_AUDIT_LIMIT &&
      workRecordCount <= SUPABASE_WORK_RECORD_LIMIT &&
      connectionSyncCount <= SUPABASE_CONNECTION_SYNC_LIMIT + 20 &&
      agentRunCount <= SUPABASE_AGENT_RUN_LIMIT &&
      dailyBriefCount <= SUPABASE_DAILY_BRIEF_LIMIT;
    return {
      workspaceId,
      healthy,
      stateBytes,
      stateWarnBytes: SUPABASE_STATE_WARN_BYTES,
      stateHardBytes: SUPABASE_STATE_HARD_BYTES,
      embeddedAuditCount,
      embeddedAuditLimit: SUPABASE_EMBEDDED_AUDIT_LIMIT,
      workRecordCount,
      automationRunCount,
      connectionSyncCount,
      agentRunCount,
      dailyBriefCount,
      reportingStatus,
      checkedAt: this.telemetry.lastIntegrityCheckAt
    };
  }

  async ping() {
    await this.request('saas_workspace_state?select=workspace_id&limit=1');
    return true;
  }
}

function numericOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createStore(env = process.env, options = {}) {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) return new SupabaseStore(env, options.fetchImpl || fetch);
  return new FileStore(env);
}

export async function getOrSeed(store, workspaceId, env = process.env, options = {}) {
  const existing = await store.get(workspaceId);
  if (existing) return existing;
  const seeded = seedWorkspaceState(env, { workspaceId, ...options });
  seeded.storageReady = store.provider === 'supabase';
  try { return await store.save(workspaceId, seeded); }
  catch (error) { if (error.code === 'STATE_CONFLICT') { const concurrent = await store.get(workspaceId); if (concurrent) return concurrent; } throw error; }
}
