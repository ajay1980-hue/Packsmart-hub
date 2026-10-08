import crypto from 'node:crypto';
import { createActivityMeter } from './activity-meter.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { compactDailyBrief, defaultAutomations } from './operations.mjs';
import { defaultAgentSettings } from './agents.mjs';
import { normalizeEmail } from './security.mjs';
import { reportingStatusRequest, REPORTING_RESPONSE_MAX_BYTES } from './reporting-status.mjs';
import { ensureControl } from './control.mjs';
import { ensureMarketing } from './marketing.mjs';
import { ensureAiEconomics } from './ai-economics.mjs';
import { ensureWebIntelligence } from './web-intelligence.mjs';
import { ensureRevenueEngine } from './revenue-engine.mjs';
import { createBusinessOutcomePersistence } from './business-outcome-store.mjs';
import { CONTENT_EXECUTION_RECEIPT_CONTRACT, validateContentExecutionCommit,
  recordContentReceiptAcknowledgement } from './content-execution-receipt.mjs';
import { prepareContentReceiptTransaction, commitContentReceiptTransaction } from './content-execution-receipt-store.mjs';
import { orderFinancialMirrorRow, orderReportingCurrency } from './shopify-order-source.mjs';
import { LEGACY_AI_USAGE_COLUMNS, LEGACY_AI_USAGE_MAX_ROWS, LEGACY_AI_USAGE_MAX_BYTES,
  legacyAiUsageWindow, legacyAiUsageUnknown, legacyAiUsagePage } from './legacy-ai-usage.mjs';
import { planAutomationRetention, applyAutomationRetention, verifyAutomationArchivePayload,
  AUTOMATION_ARCHIVE_BATCH_SIZE, AUTOMATION_ARCHIVE_BATCH_BYTES, AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES } from './automation-retention.mjs';
import {
  providerUsageError, providerUsageMonth, providerUsageReservationParams, providerUsageReservationResult,
  providerUsageSettlementParams, providerUsageSettlementResult, providerUsageSummaryResult,
  providerUsageUnavailableReason, USAGE_SUMMARY_COLUMNS, USAGE_SUMMARY_MAX_SCOPES
} from './usage-governance.mjs';
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
function saveGuard(beforeCommit) {
  if (beforeCommit === undefined) return () => {};
  if (typeof beforeCommit !== 'function') throw new TypeError('Save guard must be a synchronous function');
  return snapshot => {
    const result = beforeCommit(snapshot);
    if (result && typeof result.then === 'function') {
      // A guard must finish before serialization, not create another unchecked
      // asynchronous boundary. Consume rejection without hiding the error here.
      Promise.resolve(result).catch(() => {});
      throw new TypeError('Save guard must be synchronous');
    }
  };
}
const fileQueues = new Map();
async function boundedResponseText(response, maxBytes) {
  if (maxBytes === undefined) return response.text();
  const tooLarge = () => Object.assign(new Error('Supabase response exceeds its byte limit'), { code:'SUPABASE_RESPONSE_TOO_LARGE' });
  const declared = response.headers?.get?.('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    try { await response.body?.cancel?.(); } catch { /* Never expose the raw body. */ }
    throw tooLarge();
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw tooLarge();
    return text;
  }
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { try { await reader.cancel(); } catch {} throw tooLarge(); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks,total).toString('utf8');
  } finally { reader.releaseLock(); }
}
const CONNECTION_WRITE_CONTEXT_MAX_BYTES = 32768;
const CONNECTION_WRITE_CONTEXT_FIELDS = ['revision', 'provider', 'writeId', 'connectionId', 'actorId', 'approverId', 'approvalId',
  'writeIndex', 'connectionIndex', 'actorIndex', 'approverIndex', 'approvalIndex'];
const CONNECTION_WRITE_ROOT_SCOPE = ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id', 'tenant'];
const contextUnavailable = () => Object.assign(new Error('Connection-write context is unavailable. Review the request and try again.'),
  { code: 'WRITE_CONTEXT_UNAVAILABLE', status: 503 });
const contextObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const contextIdentity = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const contextIndex = value => Number.isSafeInteger(value) && value >= 0 && value <= 4095;
function validateConnectionWriteContextInput(workspaceId, input) {
  if (!contextIdentity(workspaceId) || !contextObject(input)) throw contextUnavailable();
  const fields = Reflect.ownKeys(input), descriptors = Object.getOwnPropertyDescriptors(input);
  if (fields.length !== CONNECTION_WRITE_CONTEXT_FIELDS.length
    || fields.some(field => !CONNECTION_WRITE_CONTEXT_FIELDS.includes(field) || !Object.hasOwn(descriptors[field], 'value'))
    || !['shopify', 'meta'].includes(input.provider)
    || !['revision', 'writeId', 'connectionId', 'actorId', 'approverId'].every(field => contextIdentity(input[field]))
    || !['writeIndex', 'connectionIndex', 'actorIndex', 'approverIndex'].every(field => contextIndex(input[field]))
    || (input.actorId === input.approverId) !== (input.actorIndex === input.approverIndex)
    || !(input.approvalId === null && input.approvalIndex === null
      || contextIdentity(input.approvalId) && contextIndex(input.approvalIndex))) throw contextUnavailable();
}
function assertConnectionContextScope(value, workspaceId, depth = 0) {
  if (depth > 64) throw contextUnavailable();
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertConnectionContextScope(item, workspaceId, depth + 1);
    return;
  }
  if (!contextObject(value)) throw contextUnavailable();
  for (const key of ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id']) {
    if (Object.hasOwn(value, key) && value[key] !== workspaceId) throw contextUnavailable();
  }
  for (const key of ['workspace', 'tenant']) {
    if (Object.hasOwn(value, key) && (contextObject(value[key]) ? value[key].id : value[key]) !== workspaceId) throw contextUnavailable();
  }
  for (const item of Object.values(value)) assertConnectionContextScope(item, workspaceId, depth + 1);
}
function connectionWriteContextResult(rows, workspaceId, input) {
  const objectFields = ['workspace', 'settings', 'actor', 'approver', 'connection', 'write',
    ...(input.approvalId === null ? [] : ['approval'])];
  const fields = ['workspace_id', 'revision', ...CONNECTION_WRITE_ROOT_SCOPE.map(key => `scope_${key}`), ...objectFields];
  if (!Array.isArray(rows) || rows.length !== 1 || Buffer.byteLength(JSON.stringify(rows)) > CONNECTION_WRITE_CONTEXT_MAX_BYTES) throw contextUnavailable();
  const row = rows[0];
  if (!contextObject(row) || Object.keys(row).length !== fields.length || fields.some(field => !Object.hasOwn(row, field))
    || row.workspace_id !== workspaceId || row.revision !== input.revision
    || !objectFields.every(field => contextObject(row[field]))
    || row.workspace.id !== workspaceId || row.actor.id !== input.actorId || row.approver.id !== input.approverId
    || row.connection.id !== input.connectionId || row.connection.provider !== input.provider
    || row.write.id !== input.writeId || row.write.provider !== input.provider || row.write.connectionId !== input.connectionId
    || !contextObject(row.connection.metadata) || !Array.isArray(row.connection.metadata.grantedScopes)
    || !row.connection.metadata.grantedScopes.every(contextIdentity) || !contextObject(row.write.input)
    || (input.actorId === input.approverId && !isDeepStrictEqual(row.actor, row.approver))) throw contextUnavailable();
  // JSON projection maps both absent root properties and JSON null to null.
  // Their distinction was checked on the caller's full snapshot; revision
  // equality preserves it here. Selected complete records keep own properties.
  for (const key of CONNECTION_WRITE_ROOT_SCOPE) {
    const value = row[`scope_${key}`];
    if (value !== null && (key === 'tenant' && contextObject(value) ? value.id : value) !== workspaceId) throw contextUnavailable();
  }
  for (const key of ['metaPageIds', 'metaCatalogIds']) {
    if (Object.hasOwn(row.settings, key) && (!Array.isArray(row.settings[key]) || !row.settings[key].every(contextIdentity))) throw contextUnavailable();
  }
  if (Object.hasOwn(row.settings, 'consent') && row.settings.consent !== null && !contextObject(row.settings.consent)) throw contextUnavailable();
  for (const key of ['providerState', 'dispatchClaim']) {
    if (Object.hasOwn(row.write, key) && row.write[key] !== null && !contextObject(row.write[key])) throw contextUnavailable();
  }
  if (input.approvalId === null) {
    if (row.write.approvalId != null || row.write.requiresApproval !== false || input.provider !== 'shopify'
      || row.write.input.operation !== 'internal_note' || row.settings.permissionMode !== 'automatic'
      || !contextObject(row.settings.consent) || row.settings.consent.mode !== 'automatic'
      || row.settings.consent.actor !== input.approverId) throw contextUnavailable();
  } else if (row.approval.id !== input.approvalId || row.write.approvalId !== input.approvalId
    || row.approval.decidedBy !== input.approverId || !contextObject(row.approval.payload)
    || row.approval.payload.connectionWriteId !== input.writeId) throw contextUnavailable();
  for (const record of [row.settings, row.approval]) {
    if (record && Object.hasOwn(record, 'provider') && record.provider !== input.provider) throw contextUnavailable();
  }
  assertConnectionContextScope(row, workspaceId);
  return { _revision: row.revision, workspace: row.workspace,
    users: input.actorId === input.approverId ? [row.actor] : [row.actor, row.approver],
    connectionSettings: { [input.provider]: row.settings }, connections: [row.connection],
    approvals: input.approvalId === null ? [] : [row.approval], connectionWrites: [row.write] };
}
const JOB_FIELDS = 'id,workspace_id,type,provider,status,priority,attempts,max_attempts,ai_units,concurrency_limit,idempotency_key,actor,ai_provider,ai_model,ai_tier,available_at,lease_until,worker_id,error_code,created_at,updated_at,completed_at';
// Exact reads request two rows so duplicate identities cannot be hidden by a
// limit of one. Allow both bounded report bodies plus their payload/metadata.
const JOB_STATUS_RESPONSE_MAX_BYTES = 16384;
const JOB_REPORT_RESPONSE_MAX_BYTES = 163840;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const jobError = (code = 'AGENT_JOB_INPUT_INVALID') => Object.assign(new Error(code), { code, status: 400 });
function validateJobIdentity(workspaceId, jobId) {
  if (typeof workspaceId !== 'string' || !JOB_ID.test(workspaceId) || typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw jobError();
}
function compactJobRow(row) {
  if (row.type !== 'objective_prepare') return structuredClone(row);
  return Object.fromEntries(JOB_FIELDS.split(',').filter(key => Object.hasOwn(row, key)).map(key => [key, structuredClone(row[key])]));
}
function validateObjectiveResult(job, result) {
  const fields = ['schema', 'id', 'workspaceId', 'jobId', 'objectiveId', 'objectiveRevision', 'generatedAt', 'sourceAsOf', 'reportStatus', 'reportCompleted',
    'commercialReady', 'objective', 'sourceResolution', 'metricEvidence', 'specialists', 'proposals', 'blockers', 'evidenceGaps', 'summary', 'synthesis', 'safeguards'];
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some(key => !fields.includes(key))
    || !/^objective_review_[0-9a-f]{32}$/.test(result.id) || result.schema !== 'runvara-objective-review/v1' || result.workspaceId !== job.workspace_id
    || result.jobId !== job.id || result.objectiveId !== job.payload?.objectiveId
    || result.objectiveRevision !== job.payload?.objectiveRevision
    || result.sourceAsOf?.typedInputFingerprint !== job.payload?.typedInputFingerprint
    || result.commercialReady !== false || typeof result.reportCompleted !== 'boolean' || !['blocked', 'completed', 'completed_with_gaps'].includes(result.reportStatus)
    || !Array.isArray(result.specialists) || result.specialists.length > 3 || !Array.isArray(result.proposals) || result.proposals.length > 10
    || result.safeguards?.providerCalls !== 0 || result.safeguards?.modelCalls !== 0
    || result.safeguards?.externalWrites !== false || result.safeguards?.externalExecutionAllowed !== false
    || Buffer.byteLength(JSON.stringify(result)) > 65536) throw jobError('OBJECTIVE_REVIEW_RESULT_INVALID');
}
function validateObjectiveEnqueue(workspaceId, job) {
  if (job.type !== 'objective_prepare') return;
  validateJobIdentity(workspaceId, job.id);
  const payload = job.payload;
  if (job.workspaceId !== workspaceId || job.provider !== null || job.aiProvider !== null || job.aiModel !== null
    || job.aiTier !== 'deterministic' || job.aiUnits !== 0 || job.priority !== 60 || job.maxAttempts !== 3
    || typeof job.actor !== 'string' || !JOB_ID.test(job.actor)
    || !payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some(key => !['schema', 'objectiveId', 'objectiveRevision', 'typedInputFingerprint', 'actorSessionVersion'].includes(key))
    || payload.schema !== 'runvara-objective-prepare/v1' || !/^objective_[0-9a-f-]{36}$/.test(payload.objectiveId)
    || !Number.isSafeInteger(payload.objectiveRevision) || payload.objectiveRevision < 1
    || !Number.isSafeInteger(payload.actorSessionVersion) || payload.actorSessionVersion < 1
    || !/^[0-9a-f]{32}$/.test(payload.typedInputFingerprint)
    || !/^objective_prepare:v1:[0-9a-f]{64}$/.test(job.idempotencyKey)
    || Buffer.byteLength(JSON.stringify(payload)) > 2048) throw jobError('OBJECTIVE_JOB_INPUT_INVALID');
}
function finishedJobRow(rows, job, status) {
  if (!Array.isArray(rows) || rows.length > 1) throw jobError('AGENT_JOB_RESPONSE_INVALID');
  const row = rows[0];
  if (row && (row.workspace_id !== job.workspace_id || row.id !== job.id || row.status !== status)) throw jobError('AGENT_JOB_RESPONSE_INVALID');
  return row || null;
}
function jobFence(job) {
  validateJobIdentity(job.workspace_id, job.id);
  if (typeof job.worker_id !== 'string' || !JOB_ID.test(job.worker_id) || !Number.isSafeInteger(job.attempts) || job.attempts < 1
    || typeof job.lease_until !== 'string' || !Number.isFinite(Date.parse(job.lease_until))) throw jobError('AGENT_JOB_CLAIM_INVALID');
  return `workspace_id=eq.${encodeURIComponent(job.workspace_id)}&id=eq.${encodeURIComponent(job.id)}&status=eq.running&worker_id=eq.${encodeURIComponent(job.worker_id)}&attempts=eq.${job.attempts}&lease_until=eq.${encodeURIComponent(job.lease_until)}&lease_until=gt.now`;
}
function sameLiveClaim(row, job) {
  return row && row.workspace_id === job.workspace_id && row.status === 'running' && row.worker_id === job.worker_id
    && row.attempts === job.attempts && Date.parse(row.lease_until) === Date.parse(job.lease_until) && Date.parse(row.lease_until) > Date.now();
}
function assertAutomationArchiveReference(workspaceId, runId, reference) {
  const fields = ['schema', 'table', 'workspaceId', 'collection', 'runId', 'recordId', 'sha256'];
  if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 256 || workspaceId !== workspaceId.trim() || /[\u0000-\u001f\u007f]/.test(workspaceId)
    || !reference || typeof reference !== 'object' || Array.isArray(reference)
    || Object.keys(reference).some(key => !fields.includes(key))
    || reference.schema !== 'runvara-automation-run-archive/v1' || reference.table !== 'runvara_history'
    || reference.workspaceId !== workspaceId || reference.collection !== 'automationRuns'
    || reference.runId !== runId || typeof reference.runId !== 'string' || !reference.runId || reference.runId.length > 180
    || reference.runId !== reference.runId.trim() || /[\u0000-\u001f\u007f]/.test(reference.runId)
    || typeof reference.recordId !== 'string' || !/^automation-v1:[0-9a-f]{64}$/.test(reference.recordId)
    || typeof reference.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(reference.sha256)) {
    throw Object.assign(new Error('Automation archive reference is invalid'), { status:400, code:'AUTOMATION_ARCHIVE_REFERENCE_INVALID' });
  }
}

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
  constructor(env, activityOptions = {}) {
    Object.defineProperty(this, 'contentExecutionReceiptCapability', { value: env.CONTENT_EXECUTION_RECEIPT_CONTRACT ?? null });
    this.activityMeter = createActivityMeter({ ...activityOptions, dbAvailable: false });
    const defaultPath = fileURLToPath(new URL('../data/state.json', import.meta.url));
    this.filePath = env.SAAS_STATE_FILE || defaultPath;
    this.agentJobs = [];
    this.aiUsage = [];
  }

  get provider() { return 'file'; }
  activitySnapshot(workspaceId) { return this.activityMeter.snapshot(workspaceId); }

  async getConnectionWriteContext() {
    // File snapshots cannot establish the durable, current dispatch authority.
    throw contextUnavailable();
  }

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

  async getIdentity(workspaceId) {
    const state = (await this.readAll())[workspaceId];
    return state ? { workspace: structuredClone(state.workspace), users: structuredClone(state.users || []) } : null;
  }

  async save(workspaceId, state, { ownedSnapshot = false, beforeCommit, protectedContentCommit } = {}) {
    if (protectedContentCommit !== undefined) throw Object.assign(new Error('CONTENT_RECEIPT_UNAVAILABLE'), { code: 'CONTENT_RECEIPT_UNAVAILABLE', status: 503 });
    assertWorkspace(workspaceId, state);
    const assertCurrent = saveGuard(beforeCommit);
    assertCurrent(state);
    const source = ownedSnapshot ? structuredClone(state) : state;
    const wasPersisted = Boolean(state[PERSISTED]);
    const previous = fileQueues.get(this.filePath) || Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      const all = await this.readAll();
      const existing = all[workspaceId];
      if (existing && (!(wasPersisted || source._revision) || (existing._revision || null) !== (source._revision || null))) throw conflict();
      for (const other of Object.values(all)) if (other.workspace.id !== workspaceId && (other.users || []).some(user => (source.users || []).some(next => normalizeEmail(next.email) === normalizeEmail(user.email)))) {
        throw Object.assign(new Error('An account already exists for this email'), { status: 409, code: 'ACCOUNT_EXISTS' });
      }
      const upgraded = { ...upgradeState(source), _revision: crypto.randomUUID(), storageReady: false };
      all[workspaceId] = upgraded;
      assertCurrent(upgraded);
      const serialized = JSON.stringify(all);
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${crypto.randomUUID()}.tmp`;
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
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

  async getArchivedAutomationRun(workspaceId, runId, archiveRef) {
    assertAutomationArchiveReference(workspaceId, runId, archiveRef);
    throw Object.assign(new Error('Durable automation archives require Supabase'), { status:503, code:'AUTOMATION_ARCHIVE_UNAVAILABLE' });
  }

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
    validateObjectiveEnqueue(workspaceId, job);
    const existing = this.agentJobs.find(item => item.workspace_id === workspaceId && item.idempotency_key === job.idempotencyKey);
    if (existing) return structuredClone(existing);
    const row = {
      id: job.id, workspace_id: workspaceId, type: job.type, provider: job.provider, payload: structuredClone(job.payload),
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
      const exhausted = row.type === 'objective_prepare' && row.attempts >= row.max_attempts;
      Object.assign(row, { status:exhausted ? 'dead_letter' : 'queued', worker_id:null, lease_until:null,
        available_at:new Date(now).toISOString(), updated_at:new Date(now).toISOString(),
        ...(exhausted ? { completed_at:new Date(now).toISOString() } : {}),
        error_code:exhausted ? 'OBJECTIVE_LEASE_ATTEMPTS_EXHAUSTED' : 'WORKER_LEASE_EXPIRED' });
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
    jobFence(job);
    const row = this.agentJobs.find(item => item.id === job.id);
    if (!sameLiveClaim(row, job)) return null;
    if (row.type === 'objective_prepare' && update.status === 'succeeded') validateObjectiveResult(row, update.result);
    Object.assign(row, {
      status:update.status, result:update.result == null ? row.result : structuredClone(update.result), error_code:update.errorCode ?? null,
      completed_at:update.completedAt || null, lease_until:null, worker_id:null, updated_at:new Date().toISOString()
    });
    this.activityMeter.observeJob(job.workspace_id, update.status);
    return structuredClone(row);
  }

  async rescheduleAgentJob(job, update) {
    jobFence(job);
    const row = this.agentJobs.find(item => item.id === job.id);
    if (!sameLiveClaim(row, job)) return null;
    Object.assign(row, { status:'queued', error_code:update.errorCode || null, available_at:update.availableAt, lease_until:null, worker_id:null, updated_at:new Date().toISOString() });
    this.activityMeter.observeJob(job.workspace_id, 'rescheduled');
    return structuredClone(row);
  }

  async listAgentJobs(workspaceId, limit = 100) {
    return this.agentJobs.filter(item => item.workspace_id === workspaceId).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at) || a.id.localeCompare(b.id)).slice(0, Math.max(1,Math.min(500,Number(limit)||100))).map(compactJobRow);
  }

  async getAgentJob(workspaceId, jobId, { includeReport = false } = {}) {
    validateJobIdentity(workspaceId, jobId);
    const rows = this.agentJobs.filter(item => item.workspace_id === workspaceId && item.id === jobId);
    if (rows.length > 1) throw jobError('AGENT_JOB_RESPONSE_INVALID');
    const row = rows[0];
    if (!row) return null;
    const result = { ...compactJobRow(row), payload: structuredClone(row.payload) };
    if (includeReport && row.type === 'objective_prepare' && row.status === 'succeeded') {
      validateObjectiveResult(row, row.result);
      result.result = structuredClone(row.result);
    }
    return result;
  }

  async retryAgentJob(workspaceId, jobId) {
    const row = this.agentJobs.find(item => item.workspace_id === workspaceId && item.id === jobId);
    if (!row) return null;
    if (!['blocked','dead_letter'].includes(row.status)) return structuredClone(row);
    Object.assign(row, { status:'queued', attempts:0, available_at:new Date().toISOString(), lease_until:null, worker_id:null, error_code:null, completed_at:null, updated_at:new Date().toISOString() });
    this.activityMeter.observeJob(workspaceId, 'manual_retry');
    return structuredClone(row);
  }

  async agentOpsUsage(workspaceId, day) {
    return this.agentJobs.filter(item => item.workspace_id === workspaceId && String(item.created_at).slice(0,10) === day)
      .reduce((sum,item)=>sum + Number(item.ai_units || 0), 0);
  }

  // A process-local file/mutex cannot grant durable, cross-replica dispatch.
  async reserveProviderUsage() { throw providerUsageError('AI_USAGE_DURABLE_STORE_REQUIRED'); }
  async settleProviderUsage() { throw providerUsageError('AI_USAGE_DURABLE_STORE_REQUIRED'); }
  async getOperatorBriefContext() { throw providerUsageError('AI_USAGE_DURABLE_STORE_REQUIRED'); }
  async businessOutcomeSummary() { throw Object.assign(new Error('Outcome publication storage is unavailable'), { code: 'OUTCOME_STORAGE_UNAVAILABLE', status: 503 }); }
  async getBusinessOutcome() { return this.businessOutcomeSummary(); }
  async getBusinessOutcomeReview() { return this.businessOutcomeSummary(); }
  async getBusinessOutcomeEvidence() { return this.businessOutcomeSummary(); }
  async publishBusinessOutcome() { return this.businessOutcomeSummary(); }
  async providerUsageSummary(workspaceId, admissionMonth) {
    providerUsageMonth(workspaceId, admissionMonth);
    return { available: false, reason: 'AI_USAGE_NOT_CONFIGURED' };
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
    // This array is process-local and resets on restart. Even an empty array
    // cannot establish a complete recorded month, so do not expose a false zero.
    return legacyAiUsageUnknown(workspaceId, startAt, endAt, 'AI_USAGE_VOLATILE_STORE', 'partial');
  }

  async ping() { return true; }
}

class SupabaseStore {
  constructor(env, fetchImpl, activityOptions = {}) {
    Object.defineProperty(this, 'contentExecutionReceiptCapability', { value: env.CONTENT_EXECUTION_RECEIPT_CONTRACT ?? null });
    this.activityMeter = createActivityMeter({ ...activityOptions, dbAvailable: true });
    this.url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
    this.key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
    this.mirrorDigests = new Map();
    this.mirrorRevisions = new Map();
    this.schedulerCache = new Map();
    this.schedulerWorkspaceIdsCache = null;
    this.schedulerCacheMaxAgeMs = Math.max(300000, Math.min(21600000, Number(env.SCHEDULER_STATE_CACHE_MS) || 3600000));
    this.schedulerRevisionCheckMs = Math.max(60000, Math.min(this.schedulerCacheMaxAgeMs, Number(env.SCHEDULER_REVISION_CHECK_MS) || 900000));
    this.schedulerWorkspaceIdsCacheMs = Math.max(60000, Math.min(3600000, Number(env.SCHEDULER_WORKSPACE_IDS_CACHE_MS) || 300000));
    this.fetch = fetchImpl;
    this.requestTimeoutMs = Math.max(20000, Math.min(60000, Number(env.SUPABASE_REQUEST_TIMEOUT_MS) || 30000));
    this.mirrorDeadlineMs = Math.max(12000, Math.min(60000, Number(env.SUPABASE_MIRROR_DEADLINE_MS) || 30000));
    this.automationRetentionEnabled = String(env.AUTOMATION_RETENTION_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
    // Last primary commit outcome; timestamps can tie or wall time can move.
    this.primaryPersistenceHealthy = true;
    this.telemetry = {
      automationRetentionEnabled: this.automationRetentionEnabled,
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

  async getConnectionWriteContext(workspaceId, input) {
    try {
      validateConnectionWriteContextInput(workspaceId, input);
      input = Object.freeze({ ...input });
      // Only trusted server-selected indexes are accepted. The caller checks
      // array uniqueness once; an exact revision binds every subsequent read
      // to that same array membership and order. Never normalize or fall back
      // to the full workspace snapshot at this dispatch boundary.
      const select = ['workspace_id', 'revision:state->>_revision', 'workspace:state->workspace',
        ...CONNECTION_WRITE_ROOT_SCOPE.map(key => `scope_${key}:state->${key}`),
        `settings:state->connectionSettings->${input.provider}`, `actor:state->users->${input.actorIndex}`,
        `approver:state->users->${input.approverIndex}`, `connection:state->connections->${input.connectionIndex}`,
        ...(input.approvalId === null ? [] : [`approval:state->approvals->${input.approvalIndex}`]),
        `write:state->connectionWrites->${input.writeIndex}`].join(',');
      const rows = await this.request(`saas_workspace_state?workspace_id=eq.${encodeURIComponent(workspaceId)}&state->>_revision=eq.${encodeURIComponent(input.revision)}&select=${select}&limit=2`,
        { maxResponseBytes: CONNECTION_WRITE_CONTEXT_MAX_BYTES });
      return connectionWriteContextResult(rows, workspaceId, input);
    } catch { throw contextUnavailable(); }
  }

  // Separate from diagnostics(): public health must never expose tenant usage.
  activitySnapshot(workspaceId) { return this.activityMeter.snapshot(workspaceId); }

  scopedRequest(workspaceId, operation, pathname, options = {}, retryKind = null) {
    return this.request(pathname, options, { workspaceId, operation, retryKind });
  }

  async getOperatorBriefContext(workspaceId, jobId) {
    validateJobIdentity(workspaceId, jobId);
    try {
      // Final pre-dispatch revalidation only. No full snapshot, prompt, user
      // records, credentials, result payloads or usage history are downloaded.
      const [policies, jobs] = await Promise.all([
        this.scopedRequest(workspaceId, 'state_read', `saas_workspace_state?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=workspace_id,governance:state->aiEconomics->governance,monthly_cost_limit_usd:state->aiEconomics->monthlyCostLimitUsd,agent_ops_enabled:state->agentOps->enabled,agent_ops_paused:state->agentOps->paused,commander_enabled:state->agentSettings->commander->enabled&limit=1`, { maxResponseBytes: 131072 }),
        this.scopedRequest(workspaceId, 'job_read', `runvara_agent_jobs?workspace_id=eq.${encodeURIComponent(workspaceId)}&id=eq.${encodeURIComponent(jobId)}&select=id,workspace_id,type,status,worker_id,attempts,lease_until,created_at,ai_provider,ai_model&limit=1`, { maxResponseBytes: 4096 })
      ]);
      if (!Array.isArray(policies) || policies.length !== 1 || policies[0]?.workspace_id !== workspaceId
        || !Array.isArray(jobs) || jobs.length !== 1 || jobs[0]?.workspace_id !== workspaceId || jobs[0]?.id !== jobId
        || Buffer.byteLength(JSON.stringify(policies)) > 131072 || Buffer.byteLength(JSON.stringify(jobs)) > 4096) throw new Error('Unverified context');
      const row = jobs[0];
      return { workspaceId, aiEconomics: { governance: policies[0].governance, monthlyCostLimitUsd: policies[0].monthly_cost_limit_usd },
        executionPolicy: { agentOpsEnabled: policies[0].agent_ops_enabled, agentOpsPaused: policies[0].agent_ops_paused,
          commanderEnabled: policies[0].commander_enabled },
        job: { workspaceId, jobId, type: row.type, status: row.status, workerId: row.worker_id, attempt: row.attempts,
          leaseUntil: row.lease_until, createdAt: row.created_at, provider: row.ai_provider, model: row.ai_model } };
    } catch { throw providerUsageError('AI_USAGE_CONTEXT_UNAVAILABLE'); }
  }
  businessOutcomePersistence() {
    return createBusinessOutcomePersistence({ request: (pathname, options) => this.request(pathname, options),
      invalidate: workspaceId => {
        this.schedulerCache.delete(workspaceId);
        this.mirrorRevisions.delete(workspaceId);
      } });
  }
  async businessOutcomeSummary(workspaceId) { return this.businessOutcomePersistence().current(workspaceId); }
  async getBusinessOutcome(workspaceId, experimentId) { return this.businessOutcomePersistence().one(workspaceId, experimentId); }
  async getBusinessOutcomeReview(workspaceId, experimentId, actor, options) { return this.businessOutcomePersistence().review(workspaceId, experimentId, actor, options); }
  async getBusinessOutcomeEvidence(workspaceId, versionId) { return this.businessOutcomePersistence().evidence(workspaceId, versionId); }
  async publishBusinessOutcome(workspaceId, actor, input) { return this.businessOutcomePersistence().publish(workspaceId, actor, input); }

  // Trusted worker-only boundary. Tenant comes solely from the explicit argument;
  // DTO validation rejects client overrides, prices, raw bodies and credentials.
  async reserveProviderUsage(workspaceId, input) {
    const params = providerUsageReservationParams(workspaceId, input);
    let result;
    try {
      // Never retry here: a lost response may represent a committed reservation.
      result = await this.scopedRequest(workspaceId, 'provider_usage_reserve', 'rpc/runvara_reserve_provider_usage', { method: 'POST', body: JSON.stringify(params) });
    } catch (error) {
      const reason = providerUsageUnavailableReason(error);
      throw providerUsageError(reason === 'AI_USAGE_UNAVAILABLE' ? 'AI_USAGE_RESERVATION_UNCERTAIN' : reason);
    }
    return providerUsageReservationResult(result, params);
  }

  async settleProviderUsage(workspaceId, input) {
    const params = providerUsageSettlementParams(workspaceId, input);
    let result;
    try {
      // A caller may retry the same immutable identity/receipt after a lost reply.
      // Never mint an alternate reservation, fingerprint or receipt on retry.
      result = await this.scopedRequest(workspaceId, 'provider_usage_settle', 'rpc/runvara_settle_provider_usage', { method: 'POST', body: JSON.stringify(params) });
    } catch (error) {
      const reason = providerUsageUnavailableReason(error);
      throw providerUsageError(reason === 'AI_USAGE_UNAVAILABLE' ? 'AI_USAGE_SETTLEMENT_UNCERTAIN' : reason);
    }
    return providerUsageSettlementResult(result, params);
  }

  async providerUsageSummary(workspaceId, admissionMonth) {
    const windowStart = providerUsageMonth(workspaceId, admissionMonth);
    let page;
    try {
      // One compact counter read. An exact count proves completeness even when
      // PostgREST's configured max_rows is below the requested sentinel limit.
      page = await this.scopedRequest(workspaceId, 'provider_usage_read', `runvara_provider_usage_windows?workspace_id=eq.${encodeURIComponent(workspaceId)}&window_start=eq.${windowStart}&select=${USAGE_SUMMARY_COLUMNS}&order=scope_key.asc&limit=${USAGE_SUMMARY_MAX_SCOPES + 1}`, {
        maxResponseBytes: 131072, includeResponseMetadata: true, headers: { Prefer: 'count=exact' }
      });
    } catch (error) {
      return { available: false, reason: providerUsageUnavailableReason(error) };
    }
    const rows = page?.data;
    const range = typeof page?.contentRange === 'string' && /^(0)-(0|[1-9][0-9]*)\/(0|[1-9][0-9]*)$/.exec(page.contentRange);
    const complete = Array.isArray(rows) && rows.length <= USAGE_SUMMARY_MAX_SCOPES
      && (rows.length === 0 ? page.contentRange === '*/0' : range && Number.isSafeInteger(Number(range[3]))
        && Number(range[2]) === rows.length - 1 && Number(range[3]) === rows.length);
    if (!complete || Buffer.byteLength(JSON.stringify(rows)) > 131072) return { available: false, reason: 'AI_USAGE_RESPONSE_INVALID' };
    return providerUsageSummaryResult(rows, workspaceId, windowStart);
  }

  headers(extra = {}) {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      ...extra
    };
  }

  async request(pathname, options = {}, observation = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const { maxResponseBytes, includeResponseMetadata = false, ...fetchOptions } = options;
    // Attribution is supplied only by trusted store call sites. Never infer it
    // from request URLs, payloads, headers or workspace-like client fields.
    const requestBodyBytes = typeof options.body === 'string' ? Buffer.byteLength(options.body)
      : Buffer.isBuffer(options.body) ? options.body.byteLength : options.body == null ? 0 : null;
    const token = this.activityMeter.beginDbAttempt({ workspaceId: observation.workspaceId ?? null,
      operation: observation.operation || 'other', method, requestBodyBytes, retryKind: observation.retryKind ?? null });
    let responseBodyBytes = null, response;
    const finishActivity = outcome => this.activityMeter.finishDbAttempt(token, { outcome, responseBodyBytes });
    try {
      response = await this.fetch(`${this.url}/rest/v1/${pathname}`, {
        ...fetchOptions,
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
      finishActivity('network_error');
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
        const body = await boundedResponseText(response, maxResponseBytes);
        responseBodyBytes = Buffer.byteLength(body);
        const payload = JSON.parse(body);
        if (typeof payload?.code === 'string' && /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(payload.code)) {
          error.databaseCode = payload.code;
        }
      } catch { /* Non-JSON error responses retain HTTP/table diagnostics. */ }
      this.telemetry.lastFailureAt = new Date().toISOString();
      this.telemetry.lastFailureCode = error.databaseCode || error.code;
      this.telemetry.lastFailureHttpStatus = response.status;
      this.telemetry.lastFailureTable = error.table;
      finishActivity('http_error');
      throw error;
    }
    let data = null;
    try {
      if (method !== 'HEAD') {
        const text = response.status === 204 ? '' : await boundedResponseText(response, maxResponseBytes);
        responseBodyBytes = Buffer.byteLength(text);
        const prefer = new Headers(options.headers || {}).get('prefer') || '';
        const permitsEmpty = method !== 'GET' && (prefer.split(',').some(value => value.trim() === 'return=minimal')
          || pathname.split('?')[0] === 'rpc/runvara_create_workspace');
        if (!text && !permitsEmpty) throw new Error('Missing JSON response');
        if (text) data = JSON.parse(text);
      } else responseBodyBytes = 0;
    } catch (cause) {
      // JSON parser/stream errors can embed upstream content. Keep only a fixed
      // safe code; never claim a decoded read/write or retain that error body.
      const code = cause?.code === 'SUPABASE_RESPONSE_TOO_LARGE' ? cause.code : 'SUPABASE_RESPONSE_INVALID';
      const error = Object.assign(new Error('Supabase response could not be verified'), {
        code, httpStatus: response.status, table: pathname.split('?')[0], payloadBytes: Buffer.byteLength(options.body || '')
      });
      this.telemetry.lastFailureAt = new Date().toISOString();
      this.telemetry.lastFailureCode = code;
      this.telemetry.lastFailureHttpStatus = response.status;
      this.telemetry.lastFailureTable = error.table;
      finishActivity(code === 'SUPABASE_RESPONSE_TOO_LARGE' ? 'oversized_response' : 'invalid_response');
      throw error;
    }
    finishActivity('succeeded');
    const succeededAt = new Date().toISOString();
    if (['GET', 'HEAD'].includes(method)) this.telemetry.lastSuccessfulReadAt = succeededAt;
    else this.telemetry.lastSuccessfulWriteAt = succeededAt;
    // Bounded readers receive cardinality only after the response has decoded.
    return includeResponseMetadata ? { data, contentRange: response.headers.get('content-range') } : data;
  }

  async getIdentity(workspaceId) {
    const rows = await this.scopedRequest(workspaceId, 'identity_read', `saas_workspace_state?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=state->workspace,state->users&limit=1`);
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
    const rows = await this.scopedRequest(workspaceId, 'state_read', `saas_workspace_state?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=state&limit=1`);
    if (!rows?.[0]?.state) { this.rememberSchedulerState(workspaceId, null); return null; }
    const state = upgradeState(rows[0].state);
    state.storageReady = true;
    assertWorkspace(workspaceId, state);
    const persisted = markPersisted(state);
    this.rememberSchedulerState(workspaceId, persisted);
    return persisted;
  }

  async schedulerRevision(workspaceId) {
    const rows = await this.scopedRequest(workspaceId, 'state_read', `saas_workspace_state?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=revision:state->>_revision&limit=1`, { maxResponseBytes: REPORTING_RESPONSE_MAX_BYTES });
    if (!Array.isArray(rows) || rows.length > 1 || (rows.length === 1 &&
      (rows[0] === null || typeof rows[0] !== 'object' || Array.isArray(rows[0]) || Object.keys(rows[0]).length !== 1 || !Object.hasOwn(rows[0], 'revision')
        || !(rows[0].revision === null || typeof rows[0].revision === 'string' && rows[0].revision.length > 0)))) {
      throw Object.assign(new Error('Persistence revision response is invalid'), { status: 503, code: 'SUPABASE_PERSISTENCE_RESPONSE_INVALID' });
    }
    return rows[0]?.revision ?? null;
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

  async upsert(table, rows, conflict, options = {}, observation = {}) {
    if (!rows.length) return;
    const requestOptions = {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
      ...options
    };
    try {
      await this.request(`${table}?on_conflict=${encodeURIComponent(conflict)}`, requestOptions, observation);
    } catch (error) {
      if (error.code !== 'SUPABASE_PERSISTENCE_FAILED' || error.httpStatus) throw error;
      // Upserts are idempotent on the declared conflict key, so a single retry is
      // safe when the network outcome is unknown.
      await new Promise(resolve => setTimeout(resolve, 250));
      await this.request(`${table}?on_conflict=${encodeURIComponent(conflict)}`, requestOptions, { ...observation, retryKind: 'upsert_network' });
    }
  }

  async mirrorNormalized(workspaceId, state) {
    const errors = [];
    const deadline = Date.now() + this.mirrorDeadlineMs;
    const orderSourceUpdates = new Map((state.orders || []).map(order => [order.id, order.updatedAt || null]));
    const mirror = async (table, rows, conflict) => {
      if (!rows.length) return;
      try {
        const cacheKey = `${workspaceId}:${table}`, previous = this.mirrorDigests.get(cacheKey) || new Map();
        // These tables stamp mirror time on every save. It is not business data:
        // hashing it makes unchanged rows appear dirty and defeats incremental writes.
        // Source timestamps remain in source_updated_at / cost_data / financial_data.
        const mirrorTimestampTables = new Set(['products', 'variants', 'economics', 'product_cost_profiles', 'automation_rules', 'orders', 'order_financials']);
        const fingerprinted = rows.map(row => {
          const content = { ...row };
          if (mirrorTimestampTables.has(table)) delete content.updated_at;
          // Financial rows reuse a real source timestamp when supplied. Keep it
          // in the digest without inventing a column in the reporting schema.
          if (table === 'order_financials') content.source_updated_at = orderSourceUpdates.get(row.order_id) || null;
          return { row, key: JSON.stringify(conflict.split(',').map(key => String(row[key]))),
            hash: crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex') };
        });
        const changed = fingerprinted.filter(item => previous.get(item.key) !== item.hash);
        if (!changed.length) return;
        if (Date.now() >= deadline) throw Object.assign(new Error('Mirror deferred'), { code: 'MIRROR_DEFERRED' });
        await this.upsert(table, changed.map(item => item.row), conflict, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) }, { workspaceId, operation: 'reporting_write' });
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
        const rows = await this.scopedRequest(workspaceId, 'other', `variants?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=id,product_id,external_id&order=id&limit=500&offset=${offset}`, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
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
      currency: orderReportingCurrency(order),
      ordered_at: order.createdAt,
      source_updated_at: order.updatedAt || order.createdAt,
      cancelled_at: order.cancelledAt || null,
      updated_at: new Date().toISOString()
    })), 'workspace_id,id');

    await mirror('order_financials', (state.orders || []).map(order => orderFinancialMirrorRow(workspaceId, order)), 'workspace_id,order_id');

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

  // Share the same CAS/ambiguous-ack recovery for primary and reporting writes.
  // Every retry uses the original URL, body and revision fence. No business work
  // is repeated, and revision reads never hydrate the workspace snapshot.
  async commitRevision(workspaceId, nextRevision, expectedRevision, path, options, { primary = true } = {}) {
    const operation = primary ? 'state_commit' : 'reporting_commit';
    const retryPrefix = primary ? 'primary' : 'reporting';
    let rows;
    try { rows = await this.scopedRequest(workspaceId, operation, path, options); }
    catch (error) {
      if (error.databaseCode === '57014') {
        // PostgreSQL cancelled this statement. Retry the same revision-guarded
        // write once; do not repeat any provider operation or business callback.
        await new Promise(resolve => setTimeout(resolve, 250));
        rows = await this.scopedRequest(workspaceId, operation, path, options, `${retryPrefix}_statement_cancelled`);
      } else if (error.code === 'SUPABASE_PERSISTENCE_FAILED' && !error.httpStatus) {
        // A network timeout can happen after Postgres has already committed.
        // Resolve the uncertainty by reading the authoritative revision before
        // deciding whether to retry, accept success, or surface a conflict.
        let currentRevision = null;
        try { currentRevision = await this.schedulerRevision(workspaceId); } catch {}
        if (currentRevision === nextRevision) {
          rows = [{ workspace_id: workspaceId }];
        } else if (currentRevision === expectedRevision || (!expectedRevision && !currentRevision)) {
          await new Promise(resolve => setTimeout(resolve, 250));
          try { rows = await this.scopedRequest(workspaceId, operation, path, options, `${retryPrefix}_network_reconciled`); }
          catch (retryError) {
            if (retryError.code !== 'SUPABASE_PERSISTENCE_FAILED' || retryError.httpStatus) throw retryError;
            let retryRevision = null;
            try { retryRevision = await this.schedulerRevision(workspaceId); } catch {}
            if (retryRevision === nextRevision) rows = [{ workspace_id: workspaceId }];
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
    if (Array.isArray(rows) && rows.length === 0) throw conflict();
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.workspace_id !== workspaceId || Object.keys(rows[0]).length !== 1) {
      throw Object.assign(new Error('Persistence response is invalid'), { status: 503, code: 'SUPABASE_PERSISTENCE_RESPONSE_INVALID' });
    }
  }

  async commitReportingStatus(workspaceId, report, expectedRevision, nextRevision) {
    const body = reportingStatusRequest(workspaceId, expectedRevision, nextRevision, report, new Date().toISOString());
    await this.commitRevision(workspaceId, nextRevision, expectedRevision, 'rpc/runvara_commit_reporting_status', {
      method: 'POST', body, maxResponseBytes: REPORTING_RESPONSE_MAX_BYTES
    }, { primary: false });
  }

  async commit(workspaceId, state, expectedRevision, existing, { primary = true, protectedContentCommit } = {}) {
    try {
      const stateBytes = Buffer.byteLength(JSON.stringify(state));
      this.telemetry.stateBytes = stateBytes;
      this.activityMeter.observeHotState(workspaceId, { bytes: stateBytes, kind: 'attempted' });
      if (stateBytes >= SUPABASE_STATE_HARD_BYTES) {
        const error = Object.assign(new Error('Workspace state is too large to persist safely'), {
          status: 503, code: 'STATE_SIZE_LIMIT', stateBytes
        });
        throw error;
      }
      if (stateBytes >= SUPABASE_STATE_WARN_BYTES) {
        console.warn(JSON.stringify({ event: 'supabase_state_size_warning', workspaceId, stateBytes, warnBytes: SUPABASE_STATE_WARN_BYTES, hardBytes: SUPABASE_STATE_HARD_BYTES }));
      }
      let protectedResult = null;
      const record = { workspace_id: workspaceId, state, updated_at: new Date().toISOString() };
      if (protectedContentCommit) {
        if (this.contentExecutionReceiptCapability !== CONTENT_EXECUTION_RECEIPT_CONTRACT) {
          throw Object.assign(new Error('CONTENT_RECEIPT_UNAVAILABLE'), { code: 'CONTENT_RECEIPT_UNAVAILABLE', status: 503 });
        }
        const transaction = prepareContentReceiptTransaction(workspaceId, state, expectedRevision, protectedContentCommit);
        try {
          protectedResult = await commitContentReceiptTransaction(transaction, (operation, pathname, options, retryKind) =>
            this.scopedRequest(workspaceId, operation, pathname, options, retryKind));
        } finally {
          // An uncertain response may have committed; cached predecessors are
          // never authoritative evidence. Reinstall only after normal success.
          if (!protectedResult || protectedResult.recovered) {
            this.invalidateSchedulerCache(workspaceId);
            this.mirrorRevisions.delete(workspaceId);
            for (const key of this.mirrorDigests.keys()) if (key.startsWith(`${workspaceId}:`)) this.mirrorDigests.delete(key);
          }
        }
      } else if (existing) {
        const revisionFilter = expectedRevision ? `eq.${encodeURIComponent(expectedRevision)}` : 'is.null';
        const path = `saas_workspace_state?workspace_id=eq.${encodeURIComponent(workspaceId)}&state->>_revision=${revisionFilter}&select=workspace_id`;
        const options = { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(record) };
        await this.commitRevision(workspaceId, state._revision, expectedRevision, path, options, { primary });
      } else {
        // Atomically create the FK parent, unique login identity and primary state.
        try {
          await this.scopedRequest(workspaceId, 'state_commit', 'rpc/runvara_create_workspace', { method: 'POST', body: JSON.stringify({ p_state: state }) });
        } catch (error) {
          if (error.databaseCode === '23505') throw conflict();
          throw error;
        }
      }
      this.activityMeter.observeHotState(workspaceId, { bytes: stateBytes, kind: 'confirmed' });
      if (primary) {
        this.telemetry.lastPrimaryWriteAt = new Date().toISOString();
        this.primaryPersistenceHealthy = true;
      }
      if (protectedResult) return protectedResult;
    } catch (error) {
      // Revision conflicts are expected concurrency outcomes. A reporting-status
      // follow-up cannot revoke or replace the already-confirmed primary commit.
      if (primary && error.code !== 'STATE_CONFLICT') {
        this.telemetry.lastPrimaryFailureAt = new Date().toISOString();
        this.primaryPersistenceHealthy = false;
      }
      throw error;
    }
  }

  async archiveHistory(workspaceId, collection, records) {
    if (!records.length) return;
    // Automation run IDs are mutable identities, not immutable version keys.
    // All automation snapshots must use the content-addressed retention writer.
    if (collection === 'automationRuns') throw Object.assign(new Error('Immutable automation archive version required'), { code:'AUTOMATION_ARCHIVE_VERSION_REQUIRED' });
    const rows = records.map((record, index) => ({
      workspace_id: workspaceId,
      collection,
      record_id: String(record?.id || `${collection}_${index}_${crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 24)}`),
      payload: record,
      occurred_at: record?.completedAt || record?.startedAt || record?.updatedAt || record?.createdAt || null,
      archived_at: new Date().toISOString()
    }));
    for (let offset = 0; offset < rows.length; offset += 200) {
      await this.upsert('runvara_history', rows.slice(offset, offset + 200), 'workspace_id,collection,record_id', {}, { workspaceId, operation: 'archive_write' });
    }
  }

  async archiveAutomationVersions(plan) {
    const acknowledgedArchives = [];
    for (const batch of plan.archiveBatches) {
      // The pure planner bounds both row count and exact serialized body bytes.
      // Do not add timestamps: initial archived_at uses the database default.
      const rows = batch.map(candidate => {
        if (candidate.archiveWrite !== 'insert-ignore-duplicates'
          || candidate.row.workspace_id !== plan.workspaceId || candidate.row.collection !== 'automationRuns'
          || candidate.row.record_id !== candidate.reference.recordId
          || !['COMPLETED', 'FAILED', 'BLOCKED'].includes(candidate.row.payload?.status)
          || !verifyAutomationArchivePayload(candidate.reference, candidate.row.payload, plan.workspaceId)) {
          throw Object.assign(new Error('Automation archive candidate is invalid'), { code:'AUTOMATION_ARCHIVE_REFERENCE_INVALID' });
        }
        return candidate.row;
      });
      const bytes = Buffer.byteLength(JSON.stringify(rows));
      if (rows.length > AUTOMATION_ARCHIVE_BATCH_SIZE || bytes > AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES
        || (rows.length > 1 && bytes > AUTOMATION_ARCHIVE_BATCH_BYTES)) {
        throw Object.assign(new Error('Automation archive batch exceeds its safety limit'), { code:'AUTOMATION_ARCHIVE_BATCH_TOO_LARGE' });
      }
      await this.upsert('runvara_history', rows, 'workspace_id,collection,record_id', {
        headers: { Prefer:'resolution=ignore-duplicates,return=minimal' }
      }, { workspaceId: plan.workspaceId, operation: 'archive_write' });
      // A successful immutable insert/ignore confirms this exact content key.
      // A thrown/uncertain batch never acknowledges any candidate in that batch.
      acknowledgedArchives.push(...batch.map(candidate => ({ ...candidate.reference, confirmed:true })));
    }
    return acknowledgedArchives;
  }

  async archiveAndCompact(workspaceId, state, automationPlan) {
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
        })), 'id', {}, { workspaceId, operation: 'archive_write' });
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

    const acknowledgedArchives = automationPlan ? await this.archiveAutomationVersions(automationPlan) : [];

    const briefs = state.dailyBriefs || [];
    const keepBriefs = briefs.slice(0, SUPABASE_DAILY_BRIEF_LIMIT);
    const archivedBriefs = briefs.slice(SUPABASE_DAILY_BRIEF_LIMIT);
    for (const brief of archivedBriefs) {
      if (!brief?.id) continue;
      await this.upsert('operations_briefs', [{
        id: brief.id,
        workspace_id: workspaceId,
        summary: brief.summary || '',
        metrics: brief.archive ? ((await this.scopedRequest(workspaceId, 'archive_read', `operations_briefs?workspace_id=eq.${encodeURIComponent(workspaceId)}&id=eq.${encodeURIComponent(brief.id)}&select=metrics&limit=1`))?.[0]?.metrics || brief) : brief,
        logic: brief.logic || 'deterministic-v1',
        created_at: brief.generatedAt || new Date().toISOString()
      }], 'id', {}, { workspaceId, operation: 'archive_write' });
    }
    state.dailyBriefs = keepBriefs;
    state.audit = audit.slice(0, SUPABASE_EMBEDDED_AUDIT_LIMIT);
    return acknowledgedArchives;
  }

  async save(workspaceId, state, { ownedSnapshot = false, beforeCommit, protectedContentCommit } = {}) {
    assertWorkspace(workspaceId, state);
    if (protectedContentCommit !== undefined) {
      if (this.contentExecutionReceiptCapability !== CONTENT_EXECUTION_RECEIPT_CONTRACT) {
        throw Object.assign(new Error('CONTENT_RECEIPT_UNAVAILABLE'), { code: 'CONTENT_RECEIPT_UNAVAILABLE', status: 503 });
      }
      // Detach both the descriptor and workspace before the first archive await.
      protectedContentCommit = validateContentExecutionCommit(protectedContentCommit);
      if (protectedContentCommit.admission.workspaceId !== workspaceId) throw Object.assign(new Error('WORKSPACE_MISMATCH'), { code: 'WORKSPACE_MISMATCH', status: 403 });
      if (typeof state._revision !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(state._revision)) {
        throw Object.assign(new Error('CONTENT_RECEIPT_INVALID'), { code: 'CONTENT_RECEIPT_INVALID', status: 409 });
      }
      ownedSnapshot = true;
    }
    const assertCurrent = saveGuard(beforeCommit);
    assertCurrent(state);
    // Opt-in source-bound requests own every value serialized after an archive
    // await. Keep live state mutable for legitimate completion bookkeeping.
    const source = ownedSnapshot ? structuredClone(state) : state;
    // Digests only describe rows mirrored by this process at its last saved
    // revision. A different replica may have changed them since then.
    if (this.mirrorRevisions.get(workspaceId) !== state._revision) {
      for (const key of this.mirrorDigests.keys()) if (key.startsWith(`${workspaceId}:`)) this.mirrorDigests.delete(key);
    }
    const existing = Boolean(state[PERSISTED] || state._revision);
    const expectedRevision = state._revision;
    // Plan against the predecessor and original run references, not the new
    // revision or a deep clone. Scheduler claim handles survive save/finish.
    const automationPlan = existing && this.automationRetentionEnabled ? planAutomationRetention(protectedContentCommit ? source : state) : null;
    const upgraded = { ...upgradeState(source), _revision: crypto.randomUUID(), storageReady: true };
    // Archive append-only operational histories before compacting existing hot state.
    // New workspaces have no parent FK row yet and start below retention limits.
    let acknowledgedArchives = [];
    if (existing) acknowledgedArchives = await this.archiveAndCompact(workspaceId, upgraded, automationPlan);
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
          metrics: brief, logic: brief.logic || 'deterministic-v1', created_at: brief.generatedAt }], 'id', {}, { workspaceId, operation: 'archive_write' });
        briefs.push({ ...compactDailyBrief(brief), archive: { table: 'operations_briefs', id: brief.id, sha256: crypto.createHash('sha256').update(JSON.stringify(brief)).digest('hex') } });
      }
      upgraded.dailyBriefs = briefs;
    }
    const now = new Date().toISOString();
    upgraded.integrationStatus.supabase = { status: 'connected', detail: 'Authoritative workspace state committed.', lastSyncAt: now, lastError: null };
    upgraded.integrationStatus.reporting = { ...upgraded.integrationStatus.reporting, status: 'degraded', detail: 'Reporting refresh pending; authoritative state is durable.' };
    // Revalidate the source after every archive await, just before serializing
    // the CAS write. Caller state is changed only after that commit succeeds.
    const retainedAutomationRuns = automationPlan ? applyAutomationRetention(automationPlan, { acknowledgedArchives }).automationRuns : null;
    if (retainedAutomationRuns) upgraded.automationRuns = ownedSnapshot ? structuredClone(retainedAutomationRuns) : retainedAutomationRuns;
    assertCurrent(upgraded);
    const protectedResult = await this.commit(workspaceId, upgraded, expectedRevision, existing, { protectedContentCommit });
    if (protectedResult?.recovered) {
      // The exact original primary transaction is proven, even if another
      // replica has since advanced the workspace. Never mirror or save this
      // old snapshot over that newer state, or install it in scheduler caches.
      // Advance the caller only to its own acknowledged primary revision. This
      // is the dispatch continuation's original fence, never the newer revision
      // observed elsewhere; its final fresh check still detects concurrent work.
      state._revision = upgraded._revision;
      const persisted = markPersisted(upgraded);
      recordContentReceiptAcknowledgement(persisted, protectedContentCommit, protectedResult.ack);
      return persisted;
    }
    state._revision = upgraded._revision;
    for (const key of ['audit', 'workRecords', 'automationRuns', 'connectionSyncs', 'agentRuns', 'dailyBriefs']) {
      // Retention plans deliberately keep original run handles for scheduler
      // finish. Do not share the private snapshot with caller-owned histories.
      if (key === 'automationRuns' && (retainedAutomationRuns || ownedSnapshot && state.automationRuns)) {
        state[key] = retainedAutomationRuns || state.automationRuns;
      } else state[key] = ownedSnapshot ? structuredClone(upgraded[key]) : upgraded[key];
    }
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
    let reportingCommitted = false;
    try {
      await this.commitReportingStatus(workspaceId, report, expected, upgraded._revision);
      reportingCommitted = true;
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
    if (reportingCommitted) this.mirrorRevisions.set(workspaceId, state._revision);
    else {
      this.mirrorRevisions.delete(workspaceId);
      for (const key of this.mirrorDigests.keys()) if (key.startsWith(`${workspaceId}:`)) this.mirrorDigests.delete(key);
    }
    if (reportingCommitted) this.rememberSchedulerState(workspaceId, persisted);
    else this.invalidateSchedulerCache(workspaceId);
    if (protectedResult) recordContentReceiptAcknowledgement(persisted, protectedContentCommit, protectedResult.ack);
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
    const rows = await this.scopedRequest(workspaceId, 'archive_read', `operations_briefs?workspace_id=eq.${encodeURIComponent(workspaceId)}&id=eq.${encodeURIComponent(briefId)}&select=metrics&limit=1`);
    if (!rows?.[0]?.metrics) throw Object.assign(new Error('Historical brief is temporarily unavailable'), { status: 503, code: 'BRIEF_ARCHIVE_UNAVAILABLE' });
    return rows[0].metrics;
  }

  async getArchivedAutomationRun(workspaceId, runId, archiveRef) {
    assertAutomationArchiveReference(workspaceId, runId, archiveRef);
    let rows;
    try {
      rows = await this.scopedRequest(workspaceId, 'archive_read', `runvara_history?workspace_id=eq.${encodeURIComponent(workspaceId)}&collection=eq.automationRuns&record_id=eq.${encodeURIComponent(archiveRef.recordId)}&select=workspace_id,collection,record_id,payload&limit=1`,
        { maxResponseBytes:AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES });
      // JSONB/JSON number formatting can expand when parsed and re-serialized.
      if (Buffer.byteLength(JSON.stringify(rows)) > AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES) throw new Error('Archive response too large');
    } catch {
      throw Object.assign(new Error('Archived automation is temporarily unavailable'), { status:503, code:'AUTOMATION_ARCHIVE_UNAVAILABLE' });
    }
    if (Array.isArray(rows) && rows.length === 0) return null;
    const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    if (!row || row.workspace_id !== workspaceId || row.collection !== 'automationRuns' || row.record_id !== archiveRef.recordId
      || !['COMPLETED', 'FAILED', 'BLOCKED'].includes(row.payload?.status) || Object.hasOwn(row.payload || {}, 'archive') || Object.hasOwn(row.payload || {}, 'evidenceCount')
      || !verifyAutomationArchivePayload(archiveRef, row.payload, workspaceId, runId)) {
      throw Object.assign(new Error('Archived automation integrity could not be verified'), { status:503, code:'AUTOMATION_ARCHIVE_INTEGRITY_FAILED' });
    }
    return structuredClone(row.payload);
  }

  async enqueueAgentJob(workspaceId, job) {
    validateObjectiveEnqueue(workspaceId, job);
    const key = encodeURIComponent(job.idempotencyKey);
    const existing = await this.scopedRequest(workspaceId, 'job_read', `runvara_agent_jobs?workspace_id=eq.${encodeURIComponent(workspaceId)}&idempotency_key=eq.${key}&select=*&limit=1`);
    if (existing?.[0]) return existing[0];
    const row = {
      id: job.id, workspace_id: workspaceId, type: job.type, provider: job.provider, payload: job.payload,
      status:'queued', priority:job.priority, attempts:0, max_attempts:job.maxAttempts, ai_units:job.aiUnits,
      concurrency_limit:job.concurrencyLimit, idempotency_key:job.idempotencyKey, actor:job.actor,
      ai_provider:job.aiProvider || null, ai_model:job.aiModel || null, ai_tier:job.aiTier || null,
      available_at:job.availableAt, created_at:job.createdAt, updated_at:job.updatedAt
    };
    try {
      const rows = await this.scopedRequest(workspaceId, 'job_enqueue', 'runvara_agent_jobs?select=*', { method:'POST', headers:{ Prefer:'return=representation' }, body:JSON.stringify(row) });
      return rows?.[0] || row;
    } catch (error) {
      if (error.httpStatus !== 409 && error.databaseCode !== '23505') throw error;
      const raced = await this.scopedRequest(workspaceId, 'job_read', `runvara_agent_jobs?workspace_id=eq.${encodeURIComponent(workspaceId)}&idempotency_key=eq.${key}&select=*&limit=1`);
      if (raced?.[0]) return raced[0];
      throw error;
    }
  }

  async claimAgentJobs(workerId, limit = 8, leaseSeconds = 300) {
    return await this.scopedRequest(null, 'job_claim', 'rpc/runvara_claim_agent_jobs', { method:'POST', body:JSON.stringify({ p_worker_id:workerId, p_limit:limit, p_lease_seconds:leaseSeconds }) }) || [];
  }

  async finishAgentJob(job, update) {
    if (job.type === 'objective_prepare' && update.status === 'succeeded') validateObjectiveResult(job, update.result);
    const rows = await this.scopedRequest(job.workspace_id, 'job_finish', `runvara_agent_jobs?${jobFence(job)}&select=${JOB_FIELDS}`, {
      method:'PATCH', headers:{ Prefer:'return=representation' }, body:JSON.stringify({
        status:update.status, result:update.result ?? null, error_code:update.errorCode ?? null,
        completed_at:update.completedAt || null, lease_until:null, worker_id:null, updated_at:update.completedAt || new Date().toISOString()
      })
    });
    const finished = finishedJobRow(rows, job, update.status);
    if (finished) this.activityMeter.observeJob(job.workspace_id, update.status);
    return finished;
  }

  async rescheduleAgentJob(job, update) {
    const rows = await this.scopedRequest(job.workspace_id, 'job_finish', `runvara_agent_jobs?${jobFence(job)}&select=${JOB_FIELDS}`, {
      method:'PATCH', headers:{ Prefer:'return=representation' }, body:JSON.stringify({
        status:'queued', error_code:update.errorCode || null, available_at:update.availableAt,
        lease_until:null, worker_id:null, updated_at:new Date().toISOString()
      })
    });
    const rescheduled = finishedJobRow(rows, job, 'queued');
    if (rescheduled) this.activityMeter.observeJob(job.workspace_id, 'rescheduled');
    return rescheduled;
  }

  async listAgentJobs(workspaceId, limit = 100) {
    const bound = Math.max(1,Math.min(500,Number(limit)||100));
    const base = `runvara_agent_jobs?workspace_id=eq.${encodeURIComponent(workspaceId)}&order=created_at.desc,id.asc&limit=${bound}`;
    // Explicit list/fleet views only: at most 2*bound rows fetched, bound returned.
    // Preserve legacy result contracts without copying 100 full objective reports.
    const [legacy, objectives] = await Promise.all([
      this.scopedRequest(workspaceId, 'job_read', `${base}&type=neq.objective_prepare&select=*`),
      this.scopedRequest(workspaceId, 'job_read', `${base}&type=eq.objective_prepare&select=${JOB_FIELDS}`)
    ]);
    return [...(legacy || []).filter(row => row.type !== 'objective_prepare'), ...(objectives || []).filter(row => row.type === 'objective_prepare').map(compactJobRow)]
      .sort((a,b) => Date.parse(b.created_at)-Date.parse(a.created_at) || a.id.localeCompare(b.id)).slice(0, bound);
  }

  async getAgentJob(workspaceId, jobId, { includeReport = false } = {}) {
    validateJobIdentity(workspaceId, jobId);
    const rows = await this.scopedRequest(workspaceId, 'job_read', `runvara_agent_jobs?workspace_id=eq.${encodeURIComponent(workspaceId)}&id=eq.${encodeURIComponent(jobId)}&select=${JOB_FIELDS},payload${includeReport ? ',result' : ''}&limit=2`,
      { maxResponseBytes: includeReport ? JOB_REPORT_RESPONSE_MAX_BYTES : JOB_STATUS_RESPONSE_MAX_BYTES });
    if (!Array.isArray(rows) || rows.length > 1) throw jobError('AGENT_JOB_RESPONSE_INVALID');
    const row = rows[0];
    if (!row) return null;
    if (row.workspace_id !== workspaceId || row.id !== jobId) throw jobError('AGENT_JOB_RESPONSE_INVALID');
    const result = { ...compactJobRow(row), payload: row.payload };
    if (includeReport && row.type === 'objective_prepare' && row.status === 'succeeded') {
      validateObjectiveResult(row, row.result);
      result.result = row.result;
    }
    return result;
  }

  async retryAgentJob(workspaceId, jobId) {
    const rows = await this.scopedRequest(workspaceId, 'job_retry', `runvara_agent_jobs?workspace_id=eq.${encodeURIComponent(workspaceId)}&id=eq.${encodeURIComponent(jobId)}&status=in.(blocked,dead_letter)&select=*`, {
      method:'PATCH', headers:{ Prefer:'return=representation' }, body:JSON.stringify({
        status:'queued', attempts:0, available_at:new Date().toISOString(), lease_until:null, worker_id:null,
        error_code:null, completed_at:null, updated_at:new Date().toISOString()
      })
    });
    if (rows?.[0]) {
      if (rows[0].workspace_id === workspaceId && rows[0].id === jobId && rows[0].status === 'queued') this.activityMeter.observeJob(workspaceId, 'manual_retry');
      return rows[0];
    }
    return (await this.scopedRequest(workspaceId, 'job_read', `runvara_agent_jobs?workspace_id=eq.${encodeURIComponent(workspaceId)}&id=eq.${encodeURIComponent(jobId)}&select=*&limit=1`))?.[0] || null;
  }

  async agentOpsUsage(workspaceId, day) {
    const next = new Date(`${day}T00:00:00.000Z`); next.setUTCDate(next.getUTCDate()+1);
    const rows = await this.scopedRequest(workspaceId, 'job_read', `runvara_agent_jobs?workspace_id=eq.${encodeURIComponent(workspaceId)}&created_at=gte.${encodeURIComponent(day+'T00:00:00.000Z')}&created_at=lt.${encodeURIComponent(next.toISOString())}&select=ai_units`);
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
      const rows=await this.scopedRequest(workspaceId, 'other', 'runvara_ai_usage?select=*',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(row)});
      return rows?.[0]||row;
    } catch(error) {
      if ((error.httpStatus===409 || error.databaseCode==='23505') && usage.requestId) {
        const rows=await this.scopedRequest(workspaceId, 'usage_read', `runvara_ai_usage?workspace_id=eq.${encodeURIComponent(workspaceId)}&provider=eq.${encodeURIComponent(usage.provider)}&request_id=eq.${encodeURIComponent(usage.requestId)}&select=*&limit=1`);
        if(rows?.[0]) return rows[0];
      }
      throw error;
    }
  }

  async aiUsageSummary(workspaceId, startAt, endAt) {
    if (!legacyAiUsageWindow(workspaceId, startAt, endAt)) return legacyAiUsageUnknown(workspaceId, startAt, endAt, 'AI_USAGE_INPUT_INVALID');
    try {
      // One bounded indexed workspace/month read, never pagination. Exact count
      // adds DB work over the filtered month, including rows beyond the limit;
      // it detects server max_rows caps and is not proof of provider billing.
      const page = await this.scopedRequest(workspaceId, 'usage_read', `runvara_ai_usage?workspace_id=eq.${encodeURIComponent(workspaceId)}&occurred_at=gte.${encodeURIComponent(startAt)}&occurred_at=lt.${encodeURIComponent(endAt)}&select=${LEGACY_AI_USAGE_COLUMNS}&order=occurred_at.desc&limit=${LEGACY_AI_USAGE_MAX_ROWS + 1}`, {
        maxResponseBytes: LEGACY_AI_USAGE_MAX_BYTES, includeResponseMetadata: true, headers: { Prefer: 'count=exact' }
      });
      return legacyAiUsagePage(page, workspaceId, startAt, endAt);
    } catch (error) {
      const reason = ['SUPABASE_RESPONSE_TOO_LARGE', 'SUPABASE_RESPONSE_INVALID'].includes(error?.code)
        ? 'AI_USAGE_RESPONSE_INVALID' : 'AI_USAGE_READ_UNAVAILABLE';
      return legacyAiUsageUnknown(workspaceId, startAt, endAt, reason);
    }
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
    const primaryPersistence = this.primaryPersistenceHealthy;
    return {
      ...this.telemetry,
      primaryPersistence,
      stateSizeStatus: this.telemetry.stateBytes === null ? 'unknown' :
        this.telemetry.stateBytes >= SUPABASE_STATE_HARD_BYTES ? 'critical' :
        this.telemetry.stateBytes >= SUPABASE_STATE_WARN_BYTES ? 'warning' : 'healthy'
    };
  }

  async integrityCheck(workspaceId) {
    const rows = await this.scopedRequest(workspaceId, 'state_read', `saas_workspace_state?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=state&limit=1`);
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
    this.activityMeter.observeHotState(workspaceId, { bytes: stateBytes, kind: 'integrity_read' });
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
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) return new SupabaseStore(env, options.fetchImpl || fetch, options.activityOptions);
  return new FileStore(env, options.activityOptions);
}

export async function getOrSeed(store, workspaceId, env = process.env, options = {}) {
  const existing = await store.get(workspaceId);
  if (existing) return existing;
  const seeded = seedWorkspaceState(env, { workspaceId, ...options });
  seeded.storageReady = store.provider === 'supabase';
  try { return await store.save(workspaceId, seeded); }
  catch (error) { if (error.code === 'STATE_CONFLICT') { const concurrent = await store.get(workspaceId); if (concurrent) return concurrent; } throw error; }
}
