import { createHash } from 'node:crypto';
import { prepareObjectiveDispatchProposal } from './objective-dispatch-policy.mjs';

// Mutable prospective application observations. Immutability starts only when
// the fixed-purpose outcome publisher commits the owner's reviewed snapshot.
export const REVIEWED_ACTION_CONTRACT = 'runvara-reviewed-action/v1';
export const RECORDED_ACTION_CONTEXT_SCHEMA = 'runvara-recorded-action-context/v1';
export const REVIEWED_SOURCE_ACTION_SCHEMA = 'runvara-reviewed-source-action/v1';
export const REVIEWED_ACTION_MAX_BYTES = 24576;
export const REVIEWED_ACTION_JSONB_MAX_BYTES = 32768;
export const REVIEWED_ACTION_STATE_MAX_BYTES = 2097152;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/, HASH = /^[a-f0-9]{64}$/;
const PRODUCT = /^gid:\/\/shopify\/Product\/\d+$/, ACCOUNT = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const VERSION = /^outcome_version_[a-f0-9]{64}$/, API = /^\d{4}-(01|04|07|10)$/;
const own = (v, k) => Object.hasOwn(v, k);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const fail = (code = 'OUTCOME_ACTION_INVALID', status = 409) => Object.assign(new Error(code), { code, status });
const fingerprint = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function exact(v, keys, optional = []) {
  if (!plain(v)) throw fail(); const d = Object.getOwnPropertyDescriptors(v);
  if (Object.getOwnPropertySymbols(v).length || Object.keys(d).some(k => !keys.includes(k) && !optional.includes(k)) || keys.some(k => !own(d, k))
    || Object.values(d).some(r => !r.enumerable || !own(r, 'value'))) throw fail();
}
function identifier(v) { if (typeof v !== 'string' || !ID.test(v)) throw fail(); return v; }
function digest(v) { if (typeof v !== 'string' || !HASH.test(v)) throw fail(); return v; }
function stamp(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) throw fail(); return v;
}
function scope(v, workspaceId, depth = 0) {
  if (depth > 16) throw fail(); if (!v || typeof v !== 'object') return;
  const descriptors = Object.getOwnPropertyDescriptors(v);
  if (Object.values(descriptors).some(r => !own(r, 'value'))) throw fail();
  if (!Array.isArray(v)) {
    if (!plain(v)) throw fail();
    for (const k of ['workspaceId','workspace_id','tenantId','tenant_id']) if (own(v, k) && v[k] !== workspaceId) throw fail();
    for (const k of ['workspace','tenant']) if (own(v, k)) {
      const marker = descriptors[k].value;
      const nestedId = plain(marker) ? Object.getOwnPropertyDescriptor(marker, 'id') : null;
      if (plain(marker) ? !nestedId || !own(nestedId, 'value') || nestedId.value !== workspaceId : marker !== workspaceId) throw fail();
    }
  }
  for (const r of Object.values(Object.getOwnPropertyDescriptors(v))) { if (!own(r, 'value')) throw fail(); scope(r.value, workspaceId, depth + 1); }
}
export function canonicalReviewedActionJson(value) {
  const seen = new Set();
  function encode(v, depth) {
    if (depth > 16) throw fail();
    if (v === null || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'string') { if (!v.isWellFormed() || v.includes('\0')) throw fail(); return JSON.stringify(v); }
    if (typeof v === 'number') { if (!Number.isSafeInteger(v)) throw fail(); return JSON.stringify(v); }
    if (seen.has(v)) throw fail(); seen.add(v); let out;
    if (Array.isArray(v)) {
      if (![Array.prototype, null].includes(Object.getPrototypeOf(v)) || v.length > 50 || Object.getOwnPropertySymbols(v).length) throw fail();
      const d = Object.getOwnPropertyDescriptors(v); if (Object.keys(d).length !== v.length + 1) throw fail();
      out = '[' + Array.from({ length: v.length }, (_, i) => { if (!d[i]?.enumerable || !own(d[i], 'value')) throw fail(); return encode(d[i].value, depth + 1); }).join(',') + ']';
    } else {
      if (!plain(v)) throw fail(); const d = Object.getOwnPropertyDescriptors(v);
      if (Object.getOwnPropertySymbols(v).length || Object.keys(d).some(k => !/^[A-Za-z][A-Za-z0-9]*$/.test(k)) || Object.values(d).some(r => !r.enumerable || !own(r, 'value'))) throw fail();
      out = '{' + Object.keys(d).sort().map(k => JSON.stringify(k) + ':' + encode(d[k].value, depth + 1)).join(',') + '}';
    }
    seen.delete(v); return out;
  }
  return encode(value, 0);
}
export const digestReviewedActionValue = v => createHash('sha256').update(canonicalReviewedActionJson(v)).digest('hex');
const without = (v, key) => Object.fromEntries(Object.entries(v).filter(([k]) => k !== key));
export function recordedApprovalDecision(approval, workspaceId) {
  const body = { workspaceId, id: approval.id, revision: own(approval, 'revision') ? approval.revision : 1, status: approval.status, decidedBy: approval.decidedBy,
    decidedAt: approval.decidedAt, payload: structuredClone(approval.payload) };
  return { ...body, digest: digestReviewedActionValue(body) };
}
export function reviewedActionDispatchRequest(input, account, apiVersion) {
  const escape = v => v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const query = 'mutation RunvaraProductContent($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id title } userErrors { field message } } }';
  const variables = { product: { id: input.productId, title: input.title, descriptionHtml: `<p>${escape(input.description).replace(/\n/g, '<br>')}</p>` } };
  return { provider: 'shopify', phase: 'shopify_mutation', method: 'POST', url: `https://${account}/admin/api/${apiVersion}/graphql.json`, body: JSON.stringify({ query, variables }) };
}
// Preserve the legacy JSON.stringify fingerprint's known construction order.
// This never changes an existing dispatcher fingerprint. Nonmatching older
// layouts simply cannot use this optional typed snapshot contract.
export function reviewedActionClaimIdentity(input, c) {
  const orderedInput = { productId: input.productId, operation: input.operation, title: input.title, description: input.description };
  const p = c.proposal;
  const proposal = p === null ? null : { schema: p.schema, workspaceId: p.workspaceId, origin: p.origin, writeId: p.writeId,
    provider: p.provider, operation: p.operation, inputDigest: p.inputDigest, connectionId: p.connectionId, account: p.account,
    requestedBy: p.requestedBy, approvalKind: p.approvalKind,
    policies: p.policies.map(row => ({ objectiveId: row.objectiveId, revision: row.revision, digest: row.digest })),
    evidenceQualification: p.evidenceQualification, digest: p.digest };
  return fingerprint({ id: c.writeId, requestId: c.requestId, provider: c.provider, input: orderedInput, digest: c.inputDigest,
    connectionId: c.connectionId, account: c.account, requestedBy: c.requestedBy, requiresApproval: true, approvalId: c.approval.id,
    ...(proposal ? { objectivePolicyProposal: proposal } : {}) });
}
const CONTEXT_FIELDS = ['schema','workspaceId','writeId','requestId','claimId','claimIdentity','provider','operation','connectionId','account','apiVersion','requestedBy','executedBy','inputDigest','phase','dispatchRequestDigest','resultId','completedAt','origin','originatingObjective','approval','proposal','policies'];
export function validateReviewedSourceAction(source, { workspaceId }) {
  exact(source, ['schema','revision','context','input','digest']); const encoded = canonicalReviewedActionJson(source);
  if (Buffer.byteLength(encoded) > REVIEWED_ACTION_MAX_BYTES) throw fail('OUTCOME_ACTION_TOO_LARGE', 413);
  if (source.schema !== REVIEWED_SOURCE_ACTION_SCHEMA || source.revision !== 1 || source.digest !== digestReviewedActionValue(without(source, 'digest'))) throw fail();
  const c = source.context, input = source.input; exact(c, CONTEXT_FIELDS); scope(source, workspaceId);
  if (c.workspaceId !== workspaceId || c.schema !== RECORDED_ACTION_CONTEXT_SCHEMA || c.provider !== 'shopify' || c.operation !== 'product_content'
    || c.phase !== 'shopify_mutation' || c.origin !== 'owner_manual' || c.originatingObjective !== null || typeof c.account !== 'string'
    || !ACCOUNT.test(c.account) || c.account.length > 253 || !API.test(c.apiVersion)) throw fail();
  for (const k of ['writeId','claimId','connectionId','requestedBy','executedBy']) identifier(c[k]);
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(c.requestId || '')) throw fail();
  digest(c.inputDigest); digest(c.dispatchRequestDigest); digest(c.claimIdentity); stamp(c.completedAt); exact(input, ['productId','operation','title','description']);
  if ((!PRODUCT.test(input.productId) || input.productId.length > 160) || input.operation !== 'product_content' || typeof input.title !== 'string' || !input.title.trim()
    || input.title !== input.title.trim() || input.title.length > 200 || typeof input.description !== 'string' || input.description.length > 10000
    || c.resultId !== input.productId || c.inputDigest !== fingerprint({ productId: input.productId, operation: input.operation, title: input.title, description: input.description })
    || c.dispatchRequestDigest !== fingerprint(reviewedActionDispatchRequest(input, c.account, c.apiVersion))) throw fail();
  const a = c.approval; exact(a, ['workspaceId','id','revision','status','decidedBy','decidedAt','payload','digest']);
  if (a.workspaceId !== workspaceId || a.revision !== 1 || a.status !== 'approved' || a.digest !== digestReviewedActionValue(without(a, 'digest'))) throw fail();
  identifier(a.id); identifier(a.decidedBy); stamp(a.decidedAt); if (a.decidedAt > c.completedAt) throw fail();
  exact(a.payload, ['connectionWriteId','digest'], ['objectivePolicyProposalDigest']);
  if (a.payload.connectionWriteId !== c.writeId || a.payload.digest !== c.inputDigest) throw fail();
  if (!Array.isArray(c.policies) || c.policies.length > 50) throw fail(); const ids = new Set();
  for (const p of c.policies) { exact(p, ['objectiveId','revision','digest']); identifier(p.objectiveId); digest(p.digest);
    if (!Number.isSafeInteger(p.revision) || p.revision < 1 || ids.has(p.objectiveId)) throw fail(); ids.add(p.objectiveId); }
  if (c.proposal === null) { if (c.policies.length || own(a.payload, 'objectivePolicyProposalDigest')) throw fail(); }
  else {
    const p = c.proposal; exact(p, ['schema','workspaceId','origin','writeId','provider','operation','inputDigest','connectionId','account','requestedBy','approvalKind','policies','evidenceQualification','digest']);
    if (p.schema !== 'runvara-objective-dispatch-proposal/v1' || p.workspaceId !== workspaceId || p.origin !== c.origin || p.writeId !== c.writeId
      || p.provider !== c.provider || p.operation !== c.operation || p.inputDigest !== c.inputDigest || p.connectionId !== c.connectionId
      || p.account !== c.account || p.requestedBy !== c.requestedBy || p.approvalKind !== 'customer_facing_publish'
      || p.evidenceQualification !== 'no_financial_execution_evidence' || !c.policies.length || canonicalReviewedActionJson(p.policies) !== canonicalReviewedActionJson(c.policies)
      || p.digest !== digestReviewedActionValue(without(p, 'digest')) || a.payload.objectivePolicyProposalDigest !== p.digest) throw fail();
  }
  if (c.claimIdentity !== reviewedActionClaimIdentity(input, c)) throw fail();
  return JSON.parse(encoded);
}
export function sourceActionFromRecordedContext(write, workspaceId) {
  exact(write.recordedActionContext, [...CONTEXT_FIELDS, 'snapshotDigest']); const { snapshotDigest, ...context } = write.recordedActionContext;
  return validateReviewedSourceAction({ schema: REVIEWED_SOURCE_ACTION_SCHEMA, revision: 1, context, input: write.input, digest: snapshotDigest }, { workspaceId });
}
export function createRecordedActionContext({ state, write, preparedInput, actor, approval, objectivePolicy, dispatchRequestDigest, claimId, claimIdentity, apiVersion }) {
  const workspaceId = state.workspace.id, proposal = prepareObjectiveDispatchProposal(write, objectivePolicy);
  const context = { schema: RECORDED_ACTION_CONTEXT_SCHEMA, workspaceId, writeId: write.id, requestId: write.requestId, claimId, claimIdentity, provider: 'shopify', operation: 'product_content',
    connectionId: write.connectionId, account: write.account, apiVersion, requestedBy: write.requestedBy, executedBy: actor, inputDigest: write.digest, phase: 'shopify_mutation',
    dispatchRequestDigest, resultId: write.result.externalId, completedAt: write.completedAt, origin: 'owner_manual', originatingObjective: null,
    approval: recordedApprovalDecision(approval, workspaceId), proposal, policies: proposal?.policies || [] };
  const body = { schema: REVIEWED_SOURCE_ACTION_SCHEMA, revision: 1, context, input: preparedInput };
  const source = validateReviewedSourceAction({ ...body, digest: digestReviewedActionValue(body) }, { workspaceId });
  return { ...source.context, snapshotDigest: source.digest };
}
export function resolveRecordedActionEvidence(state, actionId) {
  identifier(actionId); const workspaceId = state.workspace?.id, rows = state.connectionWrites?.filter(r => r?.id === actionId) || [];
  if (rows.length !== 1) throw fail(); const w = rows[0]; scope(w, workspaceId);
  const source = sourceActionFromRecordedContext(w, workspaceId), c = source.context;
  if (state.connectionWrites.filter(row => row?.requestId === c.requestId).length !== 1
    || state.connectionWrites.filter(row => row?.dispatchClaim?.id === c.claimId).length !== 1) throw fail();
  digest(w.dispatchClaim?.authority);
  if (w.status !== 'completed' || w.provider !== c.provider || w.input.operation !== c.operation || w.digest !== c.inputDigest
    || w.id !== c.writeId || w.requestId !== c.requestId || w.account !== c.account || w.connectionId !== c.connectionId || w.requestedBy !== c.requestedBy
    || w.approvalId !== c.approval.id || w.result?.externalId !== c.resultId || w.completedAt !== c.completedAt || w.dispatchClaim?.id !== c.claimId
    || w.dispatchClaim?.identity !== c.claimIdentity || w.dispatchClaim?.workspaceId !== workspaceId || w.dispatchClaim?.phases?.shopify_mutation?.status !== 'dispatching'
    || w.dispatchClaim?.phases?.shopify_mutation?.requestDigest !== c.dispatchRequestDigest) throw fail();
  if (w.requiresApproval !== true || w.dispatchBlocked === true || w.errorCode != null || w.observationErrorCode != null) throw fail();
  exact(w.result, ['externalId']); exact(w.dispatchClaim.phases, ['shopify_mutation']);
  const phase = w.dispatchClaim.phases.shopify_mutation;
  exact(phase, ['requestDigest','status','at']); stamp(phase.at); if (phase.at > c.completedAt) throw fail();
  const connections = state.connections?.filter(r => r?.id === c.connectionId) || [];
  if (connections.length !== 1 || connections[0].provider !== c.provider || connections[0].metadata?.shopDomain !== c.account) throw fail();
  scope(connections[0], workspaceId);
  const approvals = state.approvals?.filter(r => r?.id === w.approvalId) || []; if (approvals.length !== 1) throw fail(); scope(approvals[0], workspaceId);
  if (approvals[0].type !== 'customer_facing_publish' || canonicalReviewedActionJson(recordedApprovalDecision(approvals[0], workspaceId)) !== canonicalReviewedActionJson(c.approval)
    || canonicalReviewedActionJson(w.objectivePolicyProposal ?? null) !== canonicalReviewedActionJson(c.proposal)) throw fail();
  return source;
}
export function actionIntervention(source, reuseVersionId = null) {
  const c = source.context;
  return validateActionIntervention({ schema: 'runvara-owner-action-association/v1', relationship: 'owner_associated_recorded_action', comparison: 'not_established',
    action: { workspaceId: c.workspaceId, id: c.writeId, revision: 1, digest: source.digest },
    approval: { workspaceId: c.workspaceId, id: c.approval.id, revision: c.approval.revision, digest: c.approval.digest },
    account: c.account, productId: source.input.productId, completedAt: c.completedAt, reuseVersionId }, c.workspaceId);
}
export function validateActionIntervention(v, workspaceId) {
  exact(v, ['schema','relationship','comparison','action','approval','account','productId','completedAt','reuseVersionId']); scope(v, workspaceId);
  if (v.schema !== 'runvara-owner-action-association/v1' || v.relationship !== 'owner_associated_recorded_action' || v.comparison !== 'not_established'
    || typeof v.account !== 'string' || !ACCOUNT.test(v.account) || v.account.length > 253 || (!PRODUCT.test(v.productId) || v.productId.length > 160) || (v.reuseVersionId !== null && !VERSION.test(v.reuseVersionId))) throw fail();
  stamp(v.completedAt);
  for (const link of [v.action, v.approval]) { exact(link, ['workspaceId','id','revision','digest']); if (link.workspaceId !== workspaceId || link.revision !== 1) throw fail(); identifier(link.id); digest(link.digest); }
  return JSON.parse(canonicalReviewedActionJson(v));
}
export function validateActionSelection(v) {
  if (v == null) return null;
  if (own(v, 'actionId')) { exact(v, ['actionId']); identifier(v.actionId); }
  else { exact(v, ['reuseVersionId']); if (!VERSION.test(v.reuseVersionId)) throw fail('MEASUREMENT_INVALID', 400); }
  return { ...v };
}
