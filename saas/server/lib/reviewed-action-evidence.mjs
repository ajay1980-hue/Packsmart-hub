import { createHash } from 'node:crypto';
import { prepareObjectiveDispatchProposal, OBJECTIVE_CONTENT_PROPOSAL_SCHEMA, OBJECTIVE_DISPATCH_PROPOSAL_MAX_BYTES } from './objective-dispatch-policy.mjs';
import { validateObjectiveContentSource } from './objective-content-source.mjs';
import { contentWritePreimage } from './content-write-identity.mjs';

// Mutable prospective application observations. Immutability starts only when
// the fixed-purpose outcome publisher commits the owner's reviewed snapshot.
export const REVIEWED_ACTION_CONTRACT = 'runvara-reviewed-action/v1';
export const REVIEWED_OBJECTIVE_ACTION_CONTRACT = 'runvara-reviewed-action/v2';
export const RECORDED_OBJECTIVE_ACTION_CONTEXT_SCHEMA = 'runvara-recorded-action-context/v2';
export const REVIEWED_OBJECTIVE_SOURCE_ACTION_SCHEMA = 'runvara-reviewed-source-action/v2';
export const REVIEWED_OBJECTIVE_SOURCE_ACTION_DISPLAY_SCHEMA = 'runvara-reviewed-source-action-display/v2';
export const REVIEWED_STABLE_APPROVAL_MAX_BYTES = 8192;
export const supportsReviewedActions = marker => [REVIEWED_ACTION_CONTRACT, REVIEWED_OBJECTIVE_ACTION_CONTRACT].includes(marker);
export const supportsReviewedActionSource = (marker, source) => source?.schema === REVIEWED_SOURCE_ACTION_SCHEMA
  ? supportsReviewedActions(marker) : source?.schema === REVIEWED_OBJECTIVE_SOURCE_ACTION_SCHEMA && marker === REVIEWED_OBJECTIVE_ACTION_CONTRACT;
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
  if (p?.schema === OBJECTIVE_CONTENT_PROPOSAL_SCHEMA) return fingerprint(contentWritePreimage({ id: c.writeId, requestId: c.requestId,
    provider: c.provider, input: orderedInput, digest: c.inputDigest, connectionId: c.connectionId, account: c.account,
    requestedBy: c.requestedBy, requiresApproval: true, approvalId: c.approval.id, objectivePolicyProposal: p }, { family: 'objective-v2' }));
  const proposal = p === null ? null : { schema: p.schema, workspaceId: p.workspaceId, origin: p.origin, writeId: p.writeId,
    provider: p.provider, operation: p.operation, inputDigest: p.inputDigest, connectionId: p.connectionId, account: p.account,
    requestedBy: p.requestedBy, approvalKind: p.approvalKind,
    policies: p.policies.map(row => ({ objectiveId: row.objectiveId, revision: row.revision, digest: row.digest })),
    evidenceQualification: p.evidenceQualification, digest: p.digest };
  return fingerprint({ id: c.writeId, requestId: c.requestId, provider: c.provider, input: orderedInput, digest: c.inputDigest,
    connectionId: c.connectionId, account: c.account, requestedBy: c.requestedBy, requiresApproval: true, approvalId: c.approval.id,
    ...(proposal ? { objectivePolicyProposal: proposal } : {}) });
}
const STABLE_APPROVAL_FIELDS = ['id','type','action','reason','financialImpact','expectedBenefit','risk','requestedBy','source','payload','evidence','revision','agentId','createdAt'];
const MUTABLE_APPROVAL_FIELDS = ['status','decidedAt','decidedBy','decisionNote','history','workStatus','executedExternally','executionStatus'];
export function recordedStableApproval(approval) {
  // Validate before projecting: unknown future stable fields cannot silently
  // disappear from the independently reproducible approval digest.
  exact(approval, [...STABLE_APPROVAL_FIELDS, ...MUTABLE_APPROVAL_FIELDS]);
  exact(approval.payload, ['connectionWriteId','digest','objectivePolicyProposalDigest']);
  const stable = Object.fromEntries(STABLE_APPROVAL_FIELDS.map(key => [key, approval[key]]));
  stable.payload = { connectionWriteId: approval.payload.connectionWriteId, digest: approval.payload.digest };
  // Canonicalize the selected body before detaching it: this rejects nested
  // stable accessors without invoking them. Deliberately excluded mutable
  // history is not an additional stable-approval publication requirement.
  return JSON.parse(canonicalReviewedActionJson(stable));
}
function reference(v, workspaceId) {
  exact(v, ['workspaceId','id','revision','digest']);
  if (v.workspaceId !== workspaceId || !Number.isSafeInteger(v.revision) || v.revision < 1) throw fail();
  identifier(v.id); digest(v.digest);
}
export function validateRecordedObjectiveReference(v, workspaceId) {
  reference(v, workspaceId); if (!/^objective_[0-9a-f-]{36}$/.test(v.id)) throw fail();
  return JSON.parse(canonicalReviewedActionJson(v));
}
function boundedText(v, max, required = true) {
  if (typeof v !== 'string' || v.length > max || v !== v.trimStart()
    || v.length < max && v !== v.trimEnd() || required && !v.trim().length) throw fail();
}
function validateStableApproval(stable, c, input) {
  exact(stable, STABLE_APPROVAL_FIELDS);
  if (Buffer.byteLength(canonicalReviewedActionJson(stable)) > REVIEWED_STABLE_APPROVAL_MAX_BYTES) throw fail('OUTCOME_ACTION_TOO_LARGE', 413);
  const a = c.approval, p = c.proposal;
  if (stable.id !== a.id || stable.type !== 'customer_facing_publish' || stable.source !== 'objective-content'
    || stable.financialImpact !== null || stable.revision !== 1 || stable.requestedBy !== c.requestedBy
    || digestReviewedActionValue(stable) !== p.approvalDigest) throw fail();
  identifier(stable.id); identifier(stable.requestedBy);
  for (const [key, max] of [['action',180],['reason',1000],['expectedBenefit',1000],['risk',1000],['source',120]]) boundedText(stable[key], max);
  boundedText(stable.agentId, 80, false); stamp(stable.createdAt); if (stable.createdAt > a.decidedAt) throw fail();
  exact(stable.payload, ['connectionWriteId','digest']);
  if (stable.payload.connectionWriteId !== c.writeId || stable.payload.digest !== c.inputDigest) throw fail();
  if (!Array.isArray(stable.evidence) || stable.evidence.length !== 2) throw fail();
  for (const row of stable.evidence) { exact(row, ['type','id','detail']); boundedText(row.type,40,false); boundedText(row.id,180,false); boundedText(row.detail,1000,false); }
  if (stable.evidence[0].type !== 'objective_review' || stable.evidence[0].id !== p.source.reportId
    || stable.evidence[1].type !== 'product' || stable.evidence[1].id !== input.productId) throw fail();
}
const CONTEXT_FIELDS = ['schema','workspaceId','writeId','requestId','claimId','claimIdentity','provider','operation','connectionId','account','apiVersion','requestedBy','executedBy','inputDigest','phase','dispatchRequestDigest','resultId','completedAt','origin','originatingObjective','approval','proposal','policies'];
export function validateReviewedSourceAction(source, { workspaceId }) {
  exact(source, ['schema','revision','context','input','digest']); const encoded = canonicalReviewedActionJson(source);
  if (Buffer.byteLength(encoded) > REVIEWED_ACTION_MAX_BYTES) throw fail('OUTCOME_ACTION_TOO_LARGE', 413);
  const objective = source.schema === REVIEWED_OBJECTIVE_SOURCE_ACTION_SCHEMA;
  if (![REVIEWED_SOURCE_ACTION_SCHEMA, REVIEWED_OBJECTIVE_SOURCE_ACTION_SCHEMA].includes(source.schema) || source.revision !== 1 || source.digest !== digestReviewedActionValue(without(source, 'digest'))) throw fail();
  const c = source.context, input = source.input; exact(c, objective ? [...CONTEXT_FIELDS, 'stableApproval'] : CONTEXT_FIELDS); scope(source, workspaceId);
  if (c.workspaceId !== workspaceId || c.schema !== (objective ? RECORDED_OBJECTIVE_ACTION_CONTEXT_SCHEMA : RECORDED_ACTION_CONTEXT_SCHEMA) || c.provider !== 'shopify' || c.operation !== 'product_content'
    || c.phase !== 'shopify_mutation' || c.origin !== (objective ? 'owner_objective_content' : 'owner_manual')
    || !objective && c.originatingObjective !== null || typeof c.account !== 'string'
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
  if (c.proposal === null) { if (objective || c.policies.length || own(a.payload, 'objectivePolicyProposalDigest')) throw fail(); }
  else {
    const p = c.proposal; exact(p, ['schema','workspaceId','origin','writeId','provider','operation','inputDigest','connectionId','account','requestedBy','approvalKind','policies','evidenceQualification','digest', ...(objective ? ['source','approvalId','approvalDigest'] : [])]);
    if (p.schema !== (objective ? OBJECTIVE_CONTENT_PROPOSAL_SCHEMA : 'runvara-objective-dispatch-proposal/v1') || p.workspaceId !== workspaceId || p.origin !== c.origin || p.writeId !== c.writeId
      || p.provider !== c.provider || p.operation !== c.operation || p.inputDigest !== c.inputDigest || p.connectionId !== c.connectionId
      || p.account !== c.account || p.requestedBy !== c.requestedBy || p.approvalKind !== 'customer_facing_publish'
      || p.evidenceQualification !== 'no_financial_execution_evidence' || !c.policies.length || canonicalReviewedActionJson(p.policies) !== canonicalReviewedActionJson(c.policies)
      || p.digest !== digestReviewedActionValue(without(p, 'digest')) || a.payload.objectivePolicyProposalDigest !== p.digest) throw fail();
  }
  if (objective) {
    const p = c.proposal, origin = c.originatingObjective;
    validateObjectiveContentSource(p.source); reference(origin, workspaceId);
    if (Buffer.byteLength(canonicalReviewedActionJson(p)) > OBJECTIVE_DISPATCH_PROPOSAL_MAX_BYTES) throw fail('OUTCOME_ACTION_TOO_LARGE', 413);
    if (p.approvalId !== a.id || c.executedBy !== c.requestedBy || p.source.actorId !== c.requestedBy || p.source.productId !== input.productId
      || origin.id !== p.source.objectiveId || origin.revision !== p.source.objectiveRevision || origin.digest !== p.source.objectiveDigest
      || !c.policies.some(row => row.objectiveId === origin.id && row.revision === origin.revision && row.digest === origin.digest)) throw fail();
    if (p.source.payloadDigest !== digestReviewedActionValue({ schema: 'runvara-objective-prepare/v1', objectiveId: p.source.objectiveId,
      objectiveRevision: p.source.objectiveRevision, typedInputFingerprint: p.source.inputFingerprint, actorSessionVersion: p.source.actorSessionVersion })
      || p.source.reportId !== `objective_review_${fingerprint([workspaceId, p.source.objectiveId, p.source.objectiveRevision, p.source.jobId]).slice(0, 32)}`) throw fail();
    validateStableApproval(c.stableApproval, c, input);
  }
  if (c.claimIdentity !== reviewedActionClaimIdentity(input, c)) throw fail();
  return JSON.parse(encoded);
}
export function sourceActionFromRecordedContext(write, workspaceId) {
  const objective = Object.getOwnPropertyDescriptor(write.recordedActionContext || {}, 'schema')?.value === RECORDED_OBJECTIVE_ACTION_CONTEXT_SCHEMA;
  exact(write.recordedActionContext, [...CONTEXT_FIELDS, ...(objective ? ['stableApproval'] : []), 'snapshotDigest']); const { snapshotDigest, ...context } = write.recordedActionContext;
  return validateReviewedSourceAction({ schema: objective ? REVIEWED_OBJECTIVE_SOURCE_ACTION_SCHEMA : REVIEWED_SOURCE_ACTION_SCHEMA, revision: 1, context, input: write.input, digest: snapshotDigest }, { workspaceId });
}
export function createRecordedActionContext({ state, write, preparedInput, actor, approval, objectivePolicy, dispatchRequestDigest, claimId, claimIdentity, apiVersion, approvedProposal = null }) {
  const workspaceId = state.workspace.id, objective = approvedProposal?.schema === OBJECTIVE_CONTENT_PROPOSAL_SCHEMA;
  const proposal = objective ? structuredClone(approvedProposal) : prepareObjectiveDispatchProposal(write, objectivePolicy);
  const context = { schema: objective ? RECORDED_OBJECTIVE_ACTION_CONTEXT_SCHEMA : RECORDED_ACTION_CONTEXT_SCHEMA, workspaceId, writeId: write.id, requestId: write.requestId, claimId, claimIdentity, provider: 'shopify', operation: 'product_content',
    connectionId: write.connectionId, account: write.account, apiVersion, requestedBy: write.requestedBy, executedBy: actor, inputDigest: write.digest, phase: 'shopify_mutation',
    dispatchRequestDigest, resultId: write.result.externalId, completedAt: write.completedAt, origin: objective ? 'owner_objective_content' : 'owner_manual',
    originatingObjective: objective ? { workspaceId, id: proposal.source.objectiveId, revision: proposal.source.objectiveRevision, digest: proposal.source.objectiveDigest } : null,
    approval: recordedApprovalDecision(approval, workspaceId), proposal, policies: proposal?.policies || [],
    ...(objective ? { stableApproval: recordedStableApproval(approval) } : {}) };
  const body = { schema: objective ? REVIEWED_OBJECTIVE_SOURCE_ACTION_SCHEMA : REVIEWED_SOURCE_ACTION_SCHEMA, revision: 1, context, input: preparedInput };
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
  if (source.schema === REVIEWED_OBJECTIVE_SOURCE_ACTION_SCHEMA
    && canonicalReviewedActionJson(recordedStableApproval(approvals[0])) !== canonicalReviewedActionJson(c.stableApproval)) throw fail();
  return source;
}
export function actionIntervention(source, reuseVersionId = null) {
  const c = source.context;
  const objective = source.schema === REVIEWED_OBJECTIVE_SOURCE_ACTION_SCHEMA;
  return validateActionIntervention({ schema: objective ? 'runvara-owner-action-association/v2' : 'runvara-owner-action-association/v1', relationship: 'owner_associated_recorded_action', comparison: 'not_established',
    action: { workspaceId: c.workspaceId, id: c.writeId, revision: 1, digest: source.digest },
    approval: { workspaceId: c.workspaceId, id: c.approval.id, revision: c.approval.revision, digest: c.approval.digest },
    account: c.account, productId: source.input.productId, completedAt: c.completedAt, reuseVersionId,
    ...(objective ? { origin: c.origin, originatingObjective: c.originatingObjective } : {}) }, c.workspaceId);
}
export function validateActionIntervention(v, workspaceId) {
  const objective = Object.getOwnPropertyDescriptor(v || {}, 'schema')?.value === 'runvara-owner-action-association/v2';
  exact(v, ['schema','relationship','comparison','action','approval','account','productId','completedAt','reuseVersionId', ...(objective ? ['origin','originatingObjective'] : [])]); scope(v, workspaceId);
  if (!['runvara-owner-action-association/v1','runvara-owner-action-association/v2'].includes(v.schema) || v.relationship !== 'owner_associated_recorded_action' || v.comparison !== 'not_established'
    || typeof v.account !== 'string' || !ACCOUNT.test(v.account) || v.account.length > 253 || (!PRODUCT.test(v.productId) || v.productId.length > 160) || (v.reuseVersionId !== null && !VERSION.test(v.reuseVersionId))) throw fail();
  stamp(v.completedAt);
  if (objective) { if (v.origin !== 'owner_objective_content') throw fail(); validateRecordedObjectiveReference(v.originatingObjective, workspaceId); }
  for (const link of [v.action, v.approval]) { exact(link, ['workspaceId','id','revision','digest']); if (link.workspaceId !== workspaceId || link.revision !== 1) throw fail(); identifier(link.id); digest(link.digest); }
  return JSON.parse(canonicalReviewedActionJson(v));
}
export function validateActionSelection(v) {
  if (v == null) return null;
  if (own(v, 'actionId')) { exact(v, ['actionId']); identifier(v.actionId); }
  else if (own(v, 'receipt')) { exact(v, ['receipt']); return { receipt: validateProtectedReceiptSelector(v.receipt) }; }
  else { exact(v, ['reuseVersionId']); if (!VERSION.test(v.reuseVersionId)) throw fail('MEASUREMENT_INVALID', 400); }
  return { ...v };
}

// A receipt selector identifies evidence only. It supplies no tenant, reviewer,
// executor, commit revision or authority, and cannot establish protection.
export function validateProtectedReceiptSelector(v) {
  exact(v, ['attemptId', 'receiptDigest', 'sourceDigest']);
  if (typeof v.attemptId !== 'string' || !/^content_attempt_[a-f0-9]{64}$/.test(v.attemptId)) throw fail('MEASUREMENT_INVALID', 400);
  digest(v.receiptDigest); digest(v.sourceDigest);
  const encoded = canonicalReviewedActionJson(v);
  if (Buffer.byteLength(encoded, 'utf8') > 512) throw fail('MEASUREMENT_INVALID', 400);
  return JSON.parse(encoded);
}

// This is a display DTO, not a substitute for private source validation or
// correction reuse. Only the server can validate the omitted private material.
export function publicReviewedSourceAction(source, { workspaceId }) {
  const validated = validateReviewedSourceAction(source, { workspaceId });
  if (validated.schema === REVIEWED_SOURCE_ACTION_SCHEMA) return validated;
  const c = validated.context, association = actionIntervention(validated);
  const view = { schema: REVIEWED_OBJECTIVE_SOURCE_ACTION_DISPLAY_SCHEMA,
    action: association.action, approval: association.approval, origin: c.origin, originatingObjective: c.originatingObjective,
    account: c.account, productId: validated.input.productId, completedAt: c.completedAt,
    input: { productId: validated.input.productId, operation: validated.input.operation, title: validated.input.title, description: validated.input.description },
    decision: { status: c.approval.status, decidedBy: c.approval.decidedBy, decidedAt: c.approval.decidedAt },
    policies: c.policies.map(row => ({ objectiveId: row.objectiveId, revision: row.revision, digest: row.digest })),
    validation: { snapshot: 'server_validated_immutable_publication', currentStatus: 'not_checked', providerAuthentication: 'not_established', causalAttribution: 'not_established' } };
  const encoded = canonicalReviewedActionJson(view);
  if (Buffer.byteLength(encoded) > REVIEWED_ACTION_MAX_BYTES) throw fail('OUTCOME_ACTION_TOO_LARGE', 413);
  return JSON.parse(encoded);
}
