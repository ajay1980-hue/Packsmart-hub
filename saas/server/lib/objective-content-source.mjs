import crypto from 'node:crypto';
import { buildObjectiveReview, objectiveReviewFingerprint } from './objective-review.mjs';
import { businessObjectivesSnapshot } from './business-objectives.mjs';
import { projectCanonicalOpportunities } from './business-state.mjs';
import { manualContentRecord, manualContentRows, manualContentWorkspace, assertManualContentScope,
  resolveManualContentTarget, assertManualContentTarget } from './manual-content-target.mjs';
import { objectiveCanonicalDigest as hash, objectiveCanonicalText as canonical, captureObjectiveDispatchPolicy,
  assertObjectiveDispatchBinding, assessObjectiveDispatchPolicy, OBJECTIVE_CONTENT_PROPOSAL_SCHEMA } from './objective-dispatch-policy.mjs';

export const OBJECTIVE_CONTENT_SOURCE_SCHEMA = 'runvara-objective-content-source/v1';
export const OBJECTIVE_CONTENT_CONTEXT_SCHEMA = 'runvara-objective-content-context/v1';
export const OBJECTIVE_CONTENT_REQUEST_SCHEMA = 'runvara-objective-content-request/v1';
const fail = (code = 'OBJECTIVE_CONTENT_SOURCE_CHANGED', message = 'The saved review or current source changed. Prepare a fresh review and exact request.', status = 409) => {
  throw Object.assign(new Error(message), { code, status, definitive: true });
};
const own = (value, key) => Object.hasOwn(value, key);
const identity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/.test(value);
const exact = (value, fields) => {
  manualContentRecord(value);
  if (Reflect.ownKeys(value).length !== fields.length || !fields.every(key => own(value, key))) fail('OBJECTIVE_CONTENT_INPUT_INVALID', 'Refresh and review the exact saved source.', 400);
};
const digestFields = ['objectiveDigest', 'jobIdentityDigest', 'payloadDigest', 'resultDigest', 'opportunityDigest', 'productDigest', 'approvalSourceDigest'];
const sourceFields = ['schema', 'objectiveId', 'objectiveRevision', 'objectiveDigest', 'jobId', 'jobIdentityDigest', 'reportId',
  'payloadDigest', 'resultDigest', 'actorId', 'actorSessionVersion', 'inputFingerprint', 'opportunityId', 'opportunityDigest', 'productId', 'productDigest', 'approvalSourceDigest'];
export function validateObjectiveContentSource(source) {
  exact(source, sourceFields);
  if (source.schema !== OBJECTIVE_CONTENT_SOURCE_SCHEMA || !/^objective_[0-9a-f-]{36}$/.test(source.objectiveId)
    || !Number.isSafeInteger(source.objectiveRevision) || source.objectiveRevision < 1 || !/^job_[A-Za-z0-9_-]{1,100}$/.test(source.jobId)
    || !/^objective_review_[0-9a-f]{32}$/.test(source.reportId) || !identity(source.actorId) || !identity(source.opportunityId)
    || !Number.isSafeInteger(source.actorSessionVersion) || source.actorSessionVersion < 1
    || !/^[0-9a-f]{32}$/.test(source.inputFingerprint) || !/^gid:\/\/shopify\/Product\/\d+$/.test(source.productId)
    || digestFields.some(key => typeof source[key] !== 'string' || !/^[0-9a-f]{64}$/.test(source[key]))) fail('OBJECTIVE_CONTENT_INPUT_INVALID');
  return source;
}
export const isObjectiveContentWrite = write => write?.objectivePolicyProposal?.schema === OBJECTIVE_CONTENT_PROPOSAL_SCHEMA;
export function assertObjectiveContentOwner(state, session) {
  const workspaceId = manualContentWorkspace(state);
  if (session?.workspaceId !== workspaceId || !identity(session.userId) || !Number.isSafeInteger(session.sessionVersion) || session.sessionVersion < 1) fail('WRITE_ACTOR_CHANGED', 'Sign in as the original reviewing owner.', 403);
  const rows = manualContentRows(state.users, 2000).filter(row => row.id === session.userId);
  if (rows.length !== 1) fail('WRITE_ACTOR_CHANGED', 'The current owner identity is ambiguous.', 403);
  const actor = rows[0]; assertManualContentScope(actor, workspaceId);
  if (actor.role !== 'owner' || actor.active === false || actor.passwordChangeRequired || actor.sessionVersion !== session.sessionVersion) fail('WRITE_ACTOR_CHANGED', 'Sign in as the original reviewing owner.', 403);
  return actor;
}
function scopedUnique(rows, workspaceId, limit = 1000) {
  const records = manualContentRows(rows || [], limit), seen = new Set();
  for (const row of records) {
    assertManualContentScope(row, workspaceId);
    if (!identity(row.id) || seen.has(row.id)) fail();
    seen.add(row.id);
  }
  return records;
}
const mutableApproval = new Set(['status', 'decidedAt', 'decidedBy', 'decisionNote', 'history', 'workStatus', 'executedExternally', 'executionStatus']);
export function objectiveContentApprovalDigest(approval) {
  // The envelope digest is added after this independent approval binding; all
  // other payload and presentation fields remain bound without a hash cycle.
  const stable = Object.fromEntries(Object.entries(approval).filter(([key]) => !mutableApproval.has(key)));
  stable.payload = Object.fromEntries(Object.entries(approval.payload).filter(([key]) => key !== 'objectivePolicyProposalDigest'));
  return hash(stable);
}
function ownApproval(state, write) {
  const rows = scopedUnique(state.approvals, state.workspace.id);
  const found = rows.filter(row => row.id === write.approvalId), approval = found[0], envelope = write.objectivePolicyProposal;
  if (found.length !== 1 || write.requiresApproval !== true || envelope.approvalId !== write.approvalId
    || approval.requestedBy !== write.requestedBy || approval.type !== 'customer_facing_publish' || approval.revision !== 1
    || objectiveContentApprovalDigest(approval) !== envelope.approvalDigest) fail('OBJECTIVE_CONTENT_APPROVAL_CHANGED');
  exact(approval.payload, ['connectionWriteId', 'digest', 'objectivePolicyProposalDigest']);
  if (approval.payload.connectionWriteId !== write.id || approval.payload.digest !== write.digest
    || approval.payload.objectivePolicyProposalDigest !== envelope.digest) fail('OBJECTIVE_CONTENT_APPROVAL_CHANGED');
  if (approval.status === 'pending') {
    if (write.status !== 'pending_approval' || approval.decidedBy !== null || approval.decidedAt !== null || approval.decisionNote !== null
      || canonical(approval.history) !== '[]' || approval.workStatus !== 'REQUIRES APPROVAL'
      || approval.executedExternally !== false || approval.executionStatus !== 'not_connected') fail('OBJECTIVE_CONTENT_APPROVAL_CHANGED');
  } else if (approval.status === 'approved') {
    const deciders = manualContentRows(state.users, 2000).filter(row => row.id === approval.decidedBy);
    if (deciders.length !== 1 || deciders[0].role !== 'owner' || deciders[0].active === false || deciders[0].passwordChangeRequired) fail('OBJECTIVE_CONTENT_APPROVAL_CHANGED');
    assertManualContentScope(deciders[0], state.workspace.id);
    if (typeof approval.decidedAt !== 'string' || !Number.isFinite(Date.parse(approval.decidedAt))
      || !(approval.decisionNote === null || typeof approval.decisionNote === 'string' && approval.decisionNote.length <= 500)
      || canonical(approval.history) !== canonical([{ revision: 1, status: 'approved', actor: approval.decidedBy, at: approval.decidedAt, note: approval.decisionNote }])) fail('OBJECTIVE_CONTENT_APPROVAL_CHANGED');
    const completed = write.status === 'completed';
    if (approval.executedExternally !== completed || approval.executionStatus !== (completed ? 'completed' : 'ready')
      || approval.workStatus !== (completed ? 'COMPLETED' : 'PLANNED')) fail('OBJECTIVE_CONTENT_APPROVAL_CHANGED');
  } else fail('OBJECTIVE_CONTENT_APPROVAL_CHANGED');
  return approval;
}
function sourceView(state, write) {
  const workspaceId = state.workspace.id;
  for (const key of ['opportunities', 'decisions', 'approvals', 'exceptions']) scopedUnique(state[key], workspaceId);
  if (state.revenueEngine !== undefined) {
    assertManualContentScope(state.revenueEngine, workspaceId);
    scopedUnique(state.revenueEngine.experiments, workspaceId);
  }
  for (const key of ['settings', 'agentSettings', 'agentOps']) if (state[key] !== undefined) assertManualContentScope(state[key], workspaceId);
  if (state.agentOps && (own(state.agentOps, 'enabled') && typeof state.agentOps.enabled !== 'boolean'
    || own(state.agentOps, 'paused') && typeof state.agentOps.paused !== 'boolean')) fail('OBJECTIVE_CONTENT_SOURCE_CHANGED');
  if (state.agentOps?.enabled === false || state.agentOps?.paused === true) fail('AGENT_OPS_PAUSED');
  if (!write) return state;
  const approval = ownApproval(state, write);
  return { ...state, approvals: state.approvals.filter(row => row !== approval) };
}
function jobBinding(job, workspaceId, session) {
  if (!job) fail('OBJECTIVE_CONTENT_SOURCE_UNAVAILABLE', 'The retained diagnostic review is unavailable. Prepare a fresh review.');
  manualContentRecord(job); canonical(job.payload); canonical(job.result);
  if (job.workspace_id !== workspaceId || !/^job_[A-Za-z0-9_-]{1,100}$/.test(job.id) || job.type !== 'objective_prepare'
    || job.status !== 'succeeded' || job.provider !== null || job.ai_provider !== null || job.ai_model !== null || job.ai_tier !== 'deterministic'
    || job.ai_units !== 0 || job.actor !== session.userId) fail();
  const payload = job.payload;
  exact(payload, ['schema', 'objectiveId', 'objectiveRevision', 'typedInputFingerprint', 'actorSessionVersion']);
  if (payload.schema !== 'runvara-objective-prepare/v1' || !/^objective_[0-9a-f-]{36}$/.test(payload.objectiveId)
    || !Number.isSafeInteger(payload.objectiveRevision) || payload.objectiveRevision < 1
    || !/^[0-9a-f]{32}$/.test(payload.typedInputFingerprint) || payload.actorSessionVersion !== session.sessionVersion) fail();
  const ordered = { schema: payload.schema, objectiveId: payload.objectiveId, objectiveRevision: payload.objectiveRevision,
    typedInputFingerprint: payload.typedInputFingerprint, actorSessionVersion: payload.actorSessionVersion };
  const dedup = crypto.createHash('sha256').update(JSON.stringify([workspaceId, ordered, job.actor])).digest('hex');
  if (job.idempotency_key !== `objective_prepare:v1:${dedup}` || typeof job.created_at !== 'string' || !Number.isFinite(Date.parse(job.created_at))
    || typeof job.completed_at !== 'string' || !Number.isFinite(Date.parse(job.completed_at))) fail();
  return { id: job.id, workspaceId, type: job.type, provider: job.provider, actor: job.actor, aiProvider: job.ai_provider,
    aiModel: job.ai_model, aiTier: job.ai_tier, aiUnits: job.ai_units, idempotencyKey: job.idempotency_key, createdAt: job.created_at, completedAt: job.completed_at };
}

export function captureObjectiveContentSource(state, job, opportunityId, session, { write = null, now = Date.now() } = {}) {
  assertObjectiveContentOwner(state, session);
  const workspaceId = state.workspace.id, stableJob = jobBinding(job, workspaceId, session), payload = job.payload, report = job.result;
  const view = sourceView(state, write);
  const objective = businessObjectivesSnapshot(view, { now: new Date(now) }).objectives.find(row => row.id === payload.objectiveId);
  if (!objective || objective.revision !== payload.objectiveRevision || objective.effectiveStatus !== 'active' || objective.executionPolicy?.mode !== 'enforce') fail('OBJECTIVE_CONTENT_POLICY_REQUIRED', 'The selected objective must remain active with explicit execution restrictions.');
  if (!identity(opportunityId) || !report || typeof report.generatedAt !== 'string' || !Number.isFinite(Date.parse(report.generatedAt))
    || Buffer.byteLength(canonical(report)) > 65536) fail();
  const reconstructed = buildObjectiveReview({ ...view, _revision: report.sourceAsOf?.stateRevision },
    { objectiveId: payload.objectiveId, objectiveRevision: payload.objectiveRevision, jobId: job.id }, { now: report.generatedAt });
  if (canonical(reconstructed) !== canonical(report) || objectiveReviewFingerprint(view,
    { objectiveId: payload.objectiveId, objectiveRevision: payload.objectiveRevision }, { now: new Date(now) }) !== payload.typedInputFingerprint
    || report.sourceAsOf.typedInputFingerprint !== payload.typedInputFingerprint || report.reportCompleted !== true) fail();
  const candidates = report.proposals.filter(row => row.opportunityId === opportunityId);
  if (candidates.length !== 1) fail('OBJECTIVE_CONTENT_CANDIDATE_UNAVAILABLE');
  const canonicalRows = projectCanonicalOpportunities(view, { limit: 100 }) || [];
  const opportunity = canonicalRows.find(row => row.id === opportunityId), raw = view.opportunities.find(row => row.id === opportunityId);
  if (!opportunity || opportunity.kind !== 'seo' || opportunity.requiredAction !== 'customer_facing_publish'
    || raw.kind !== 'seo' || raw.requiredAction !== 'customer_facing_publish') fail('OBJECTIVE_CONTENT_CANDIDATE_UNAVAILABLE');
  const evidence = manualContentRows(raw.evidence || [], 20);
  if (evidence.length !== 1 || evidence[0].type !== 'product' || !['Thin product title', 'Thin product description'].includes(evidence[0].detail)
    || !/^gid:\/\/shopify\/Product\/\d+$/.test(evidence[0].id) || raw.reference !== `${evidence[0].id}:${evidence[0].detail}`) fail('OBJECTIVE_CONTENT_CANDIDATE_UNAVAILABLE');
  const productRows = manualContentRows(state.products || [], 10000).filter(row => row.id === evidence[0].id);
  if (productRows.length !== 1 || productRows[0].provider !== 'shopify') fail('OBJECTIVE_CONTENT_PRODUCT_CHANGED');
  const product = productRows[0]; assertManualContentScope(product, workspaceId);
  if (typeof product.title !== 'string' || product.title.length > 1000 || typeof product.description !== 'string' || product.description.length > 32768
    || evidence[0].detail === 'Thin product title' && product.title.trim().length >= 18
    || evidence[0].detail === 'Thin product description' && product.description.trim().length >= 80) fail('OBJECTIVE_CONTENT_PRODUCT_CHANGED');
  const target = resolveManualContentTarget(state);
  if (!target.available) fail(target.code, target.message);
  const scope = objective.executionPolicy.scope;
  if (scope.connectionId !== target.target.connectionId || scope.account !== target.target.account || scope.provider !== 'shopify' || scope.operation !== 'product_content') fail('OBJECTIVE_CONTENT_POLICY_REQUIRED');
  if (write && (write.requestedBy !== session.userId || write.provider !== 'shopify' || write.input.operation !== 'product_content'
    || write.input.productId !== product.id || write.connectionId !== target.target.connectionId || write.account !== target.target.account)) fail();
  const { effectiveStatus: _status, ...definition } = objective;
  const source = { schema: OBJECTIVE_CONTENT_SOURCE_SCHEMA, objectiveId: objective.id, objectiveRevision: objective.revision,
    objectiveDigest: hash(definition), jobId: job.id, jobIdentityDigest: hash(stableJob), reportId: report.id,
    payloadDigest: hash(payload), resultDigest: hash(report), actorId: session.userId, actorSessionVersion: session.sessionVersion,
    inputFingerprint: payload.typedInputFingerprint, opportunityId, opportunityDigest: hash({ canonical: opportunity,
      mapping: { id: raw.id, kind: raw.kind, reference: raw.reference, requiredAction: raw.requiredAction, evidence: raw.evidence } }),
    productId: product.id, productDigest: hash({ id: product.id, provider: product.provider, title: product.title,
      description: product.description, status: product.status ?? null }), approvalSourceDigest: hash(view.approvals) };
  const subject = write || { provider: 'shopify', input: { operation: 'product_content' }, connectionId: target.target.connectionId, account: target.target.account };
  const policy = captureObjectiveDispatchPolicy(state, subject);
  if (write) {
    if (canonical(source) !== canonical(write.objectivePolicyProposal.source)) fail();
    assertObjectiveDispatchBinding(write, state.approvals.find(row => row.id === write.approvalId), policy,
      { source, approvalId: write.approvalId, approvalDigest: write.objectivePolicyProposal.approvalDigest });
  }
  return { source, policy, target: target.target, objective: { id: objective.id, revision: objective.revision, title: objective.title },
    candidate: { opportunityId, issue: evidence[0].detail }, product: { id: product.id, title: product.title, description: product.description, provenance: 'unverified' } };
}

export async function loadObjectiveContentSource(state, jobId, opportunityId, session, loadJob, options = {}) {
  assertObjectiveContentOwner(state, session);
  if (typeof loadJob !== 'function' || !/^job_[A-Za-z0-9_-]{1,100}$/.test(jobId)) fail('OBJECTIVE_CONTENT_SOURCE_UNAVAILABLE');
  const job = await loadJob(jobId);
  // Capture copies immediately. They detect observed changes, not privileged
  // forgery or atomic revocation across the separate job and workspace rows.
  const copy = job ? JSON.parse(canonical(job)) : null;
  return { ...captureObjectiveContentSource(state, copy, opportunityId, session, options), job: copy };
}
export async function objectiveContentContext(state, jobId, opportunityId, session, loadJob) {
  const result = await loadObjectiveContentSource(state, jobId, opportunityId, session, loadJob);
  return { schema: OBJECTIVE_CONTENT_CONTEXT_SCHEMA, workspaceId: state.workspace.id, requestedBy: session.userId,
    source: result.source, sourceRevision: hash(result.source), target: result.target, objective: result.objective, candidate: result.candidate, product: result.product,
    policy: assessObjectiveDispatchPolicy({ connectionId: result.target.connectionId }, result.policy),
    notice: 'Owner-requested content associated with this objective. This diagnostic history is not execution proof or verified goal progress. Retained product account provenance is unverified; confirm the destination and product ID. Publish approval and apply remain separate.' };
}

export function assertObjectiveContentTarget(state, target) { return assertManualContentTarget(state, target); }
