import { actionIntervention, canonicalReviewedActionJson, validateReviewedSourceAction,
  validateRecordedObjectiveReference, validateProtectedReceiptSelector } from './reviewed-action-evidence.mjs';
import { CONTENT_EXECUTION_RECEIPT_CONTRACT, validateContentExecutionCommit,
  contentReceiptJsonbBytes } from './content-execution-receipt.mjs';

export { validateProtectedReceiptSelector } from './reviewed-action-evidence.mjs';
export const PROTECTED_RECEIPT_SOURCE_SCHEMA = 'runvara-protected-content-source/v1';
export const PROTECTED_RECEIPT_PRIVATE_SCHEMA = 'runvara-outcome-content-source-private/v1';
export const PROTECTED_RECEIPT_DISPLAY_SCHEMA = 'runvara-protected-content-source-display/v1';
export const OUTCOME_CONTENT_SOURCE_READER_SCHEMA = 'runvara-outcome-content-source-reader/v1';
export const PROTECTED_RECEIPT_REFERENCE_MAX_BYTES = 2048;
export const PROTECTED_RECEIPT_PRIVATE_MAX_BYTES = 42 * 1024;
export const PROTECTED_RECEIPT_DISPLAY_MAX_BYTES = 36 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const fail = (code = 'OUTCOME_RECEIPT_INVALID', status = 409) => Object.assign(new Error(code), { code, status });
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || Object.keys(fields).length !== keys.length
    || keys.some(key => !Object.hasOwn(fields, key))
    || Object.values(fields).some(field => !field.enumerable || !Object.hasOwn(field, 'value'))) throw fail();
}
function bounded(value, maximum, jsonb = false) {
  const text = canonicalReviewedActionJson(value);
  if (Buffer.byteLength(text, 'utf8') > maximum || jsonb && contentReceiptJsonbBytes(value) > maximum) throw fail('OUTCOME_RECEIPT_TOO_LARGE', 413);
  return JSON.parse(text);
}
function checked(callback) {
  try { return callback(); }
  catch (error) {
    if (error?.code === 'OUTCOME_RECEIPT_TOO_LARGE') throw error;
    if (['CONTENT_RECEIPT_TOO_LARGE', 'OUTCOME_ACTION_TOO_LARGE'].includes(error?.code)) throw fail('OUTCOME_RECEIPT_TOO_LARGE', 413);
    throw fail();
  }
}
function workspace(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || value !== value.trim()
    || !value.isWellFormed() || /[\u0000-\u001f\u007f]/.test(value)) throw fail();
  return value;
}
function stamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw fail();
}

// Structural validation only. A client-supplied or mutable stored reference is
// never proof of receipt protection; the trusted reader/publisher must resolve
// its exact immutable evidence, or reuse an already protected publication.
export function validateProtectedReceiptSource(reference, { workspaceId, sourceDigest } = {}) {
  return checked(() => {
    exact(reference, ['schema', 'workspaceId', 'attemptId', 'receiptDigest', 'sourceDigest', 'commitRevision']);
    if (reference.schema !== PROTECTED_RECEIPT_SOURCE_SCHEMA || workspace(reference.workspaceId) !== workspace(workspaceId)
      || typeof reference.commitRevision !== 'string' || !UUID.test(reference.commitRevision)
      || sourceDigest !== undefined && reference.sourceDigest !== sourceDigest) throw fail();
    validateProtectedReceiptSelector({ attemptId: reference.attemptId, receiptDigest: reference.receiptDigest, sourceDigest: reference.sourceDigest });
    return bounded(reference, PROTECTED_RECEIPT_REFERENCE_MAX_BYTES, true);
  });
}

// Called only on the exact private row envelope returned by the service reader.
// The database owns actor/session authorization and row identity. This function
// independently checks every admission, intent, source and successful observation
// binding without consulting mutable workspace histories or executor sessions.
export function resolveProtectedReceiptEvidence(evidence, { workspaceId, selector } = {}) {
  return checked(() => {
    exact(evidence, ['schema', 'admission', 'receipt', 'commitRevision']);
    bounded(evidence, PROTECTED_RECEIPT_PRIVATE_MAX_BYTES, true);
    if (evidence.schema !== PROTECTED_RECEIPT_PRIVATE_SCHEMA) throw fail();
    const descriptor = validateContentExecutionCommit({ contract: CONTENT_EXECUTION_RECEIPT_CONTRACT,
      kind: 'finalize', admission: evidence.admission, receipt: evidence.receipt });
    const source = validateReviewedSourceAction(descriptor.receipt.source, { workspaceId: workspace(workspaceId) });
    const receiptSource = validateProtectedReceiptSource({ schema: PROTECTED_RECEIPT_SOURCE_SCHEMA,
      workspaceId: descriptor.receipt.workspaceId, attemptId: descriptor.receipt.attemptId,
      receiptDigest: descriptor.receipt.digest, sourceDigest: source.digest, commitRevision: evidence.commitRevision },
    { workspaceId, sourceDigest: source.digest });
    if (selector !== undefined) {
      const selected = validateProtectedReceiptSelector(selector);
      if (selected.attemptId !== receiptSource.attemptId || selected.receiptDigest !== receiptSource.receiptDigest
        || selected.sourceDigest !== receiptSource.sourceDigest) throw fail();
    }
    return { source, receiptSource };
  });
}

export function validateProtectedReceiptChoice(choice, { workspaceId } = {}) {
  return checked(() => {
    exact(choice, ['receiptSource', 'actionId', 'account', 'productId', 'title', 'completedAt', 'origin', 'originatingObjective']);
    const result = bounded(choice, 16 * 1024);
    result.receiptSource = validateProtectedReceiptSource(result.receiptSource, { workspaceId });
    if (typeof result.actionId !== 'string' || !ID.test(result.actionId)
      || typeof result.account !== 'string' || result.account.length > 253 || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(result.account)
      || typeof result.productId !== 'string' || result.productId.length > 160 || !/^gid:\/\/shopify\/Product\/\d+$/.test(result.productId)
      || typeof result.title !== 'string' || !result.title || result.title.length > 200 || result.title !== result.title.trim()
      || !['owner_manual', 'owner_objective_content'].includes(result.origin)) throw fail();
    stamp(result.completedAt);
    if (result.origin === 'owner_manual') { if (result.originatingObjective !== null) throw fail(); }
    else validateRecordedObjectiveReference(result.originatingObjective, workspaceId);
    return result;
  });
}

// Deliberately projects both manual and objective sources. The legacy manual
// source serializer contains private request/claim/proposal fields and must not
// handle protected evidence. Callers establish immutable provenance first.
export function publicProtectedReceiptSource(source, { workspaceId, receiptSource } = {}) {
  return checked(() => {
    const validated = validateReviewedSourceAction(source, { workspaceId });
    const reference = validateProtectedReceiptSource(receiptSource, { workspaceId, sourceDigest: validated.digest });
    const c = validated.context, association = actionIntervention(validated);
    return bounded({ schema: PROTECTED_RECEIPT_DISPLAY_SCHEMA, receiptSource: reference,
      action: association.action, approval: association.approval, origin: c.origin, originatingObjective: c.originatingObjective,
      account: c.account, productId: validated.input.productId, completedAt: c.completedAt,
      input: { productId: validated.input.productId, operation: validated.input.operation, title: validated.input.title, description: validated.input.description },
      decision: { status: c.approval.status, decidedBy: c.approval.decidedBy, decidedAt: c.approval.decidedAt },
      policies: c.policies.map(row => ({ objectiveId: row.objectiveId, revision: row.revision, digest: row.digest })),
      validation: { protection: 'completion_workspace_commit', currentStatus: 'not_checked', providerAuthentication: 'not_established', causalAttribution: 'not_established' } },
    PROTECTED_RECEIPT_DISPLAY_MAX_BYTES);
  });
}
