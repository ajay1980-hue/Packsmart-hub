import { createHash } from 'node:crypto';
import { canonicalReviewedActionJson, digestReviewedActionValue, createRecordedActionContext,
  sourceActionFromRecordedContext, validateReviewedSourceAction, REVIEWED_ACTION_MAX_BYTES,
  REVIEWED_ACTION_JSONB_MAX_BYTES } from './reviewed-action-evidence.mjs';

// Prospective, server-only storage contract. Neither a workspace field nor a
// browser request can select this capability. The database owns activation.
export const CONTENT_EXECUTION_RECEIPT_CONTRACT = 'runvara-content-execution-receipts/v1';
export const CONTENT_EXECUTION_ADMISSION_SCHEMA = 'runvara-content-execution-admission/v1';
export const CONTENT_EXECUTION_RECEIPT_SCHEMA = 'runvara-content-execution-receipt/v1';
export const CONTENT_EXECUTION_RECEIPT_ACK_SCHEMA = 'runvara-content-execution-commit-ack/v1';
export const CONTENT_EXECUTION_RESERVED_BYTES = 40960;
export const CONTENT_EXECUTION_ADMISSION_MAX_BYTES = 4096;
export const CONTENT_EXECUTION_RECEIPT_MAX_BYTES = 36864;
export const CONTENT_EXECUTION_RECEIPT_ACK_MAX_BYTES = 8192;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const workspaceIdentity = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const admissionKeys = ['schema','workspaceId','attemptId','writeId','requestId','claimId','claimIdentity',
  'authorityDigest','actorId','actorSessionVersion','phase','dispatchRequestDigest','intentDigest','admittedAt','reservedBytes','digest'];
const receiptKeys = ['schema','workspaceId','attemptId','admissionDigest','intentDigest','observation','source','digest'];
const ackKeys = ['schema','kind','workspaceId','attemptId','admissionDigest','intentDigest','requestFingerprint',
  'expectedRevision','nextRevision','receiptDigest','reservedBytes','replayed'];
const acknowledgements = new WeakMap();
const fail = (code = 'CONTENT_RECEIPT_INVALID', status = 409) => Object.assign(new Error(code), { code, status, definitive: true });
const withoutDigest = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'digest'));
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function stamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function contentExecutionReceiptRequired(capability) {
  if (capability === undefined || capability === null || capability === '') return false;
  if (capability !== CONTENT_EXECUTION_RECEIPT_CONTRACT) throw fail('CONTENT_RECEIPT_UNAVAILABLE', 503);
  return true;
}

// The validated source grammar has safe integer numbers, well-formed non-NUL
// strings and ordinary own JSON data. JSONB adds one space after each colon and
// comma; key ordering cannot change byte length. SQL enforces the real ::text
// boundary independently. Keep this helper restricted to that same grammar.
export function contentReceiptJsonbBytes(value) {
  canonicalReviewedActionJson(value);
  const encode = item => Array.isArray(item) ? `[${item.map(encode).join(', ')}]`
    : item && typeof item === 'object' ? `{${Object.keys(item).map(key => `${JSON.stringify(key)}: ${encode(item[key])}`).join(', ')}}`
      : JSON.stringify(item);
  return Buffer.byteLength(encode(value));
}

export function contentExecutionSourceIntent(source) {
  const { digest: _digest, ...body } = source;
  return digestReviewedActionValue({ ...body, context: { ...body.context, completedAt: null } });
}

function checkedAdmission(admission) {
  canonicalReviewedActionJson(admission);
  if (!exact(admission, admissionKeys) || admission.schema !== CONTENT_EXECUTION_ADMISSION_SCHEMA
    || admission.phase !== 'shopify_mutation' || admission.reservedBytes !== CONTENT_EXECUTION_RESERVED_BYTES
    || !Number.isSafeInteger(admission.actorSessionVersion) || admission.actorSessionVersion < 1
    || !stamp(admission.admittedAt) || typeof admission.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(admission.requestId)
    || !/^content_attempt_[a-f0-9]{64}$/.test(admission.attemptId)
    || !workspaceIdentity(admission.workspaceId)
    || ['writeId','claimId','actorId'].some(key => typeof admission[key] !== 'string' || !ID.test(admission[key]))
    || ['claimIdentity','authorityDigest','dispatchRequestDigest','intentDigest','digest'].some(key => typeof admission[key] !== 'string' || !HASH.test(admission[key]))
    || admission.digest !== digestReviewedActionValue(withoutDigest(admission))
    || admission.attemptId !== `content_attempt_${digestReviewedActionValue([admission.workspaceId, admission.claimId, admission.phase])}`) throw fail();
  if (contentReceiptJsonbBytes(admission) > CONTENT_EXECUTION_ADMISSION_MAX_BYTES) throw fail('CONTENT_RECEIPT_TOO_LARGE', 413);
}

function checkedSource(source, admission, { template = false } = {}) {
  validateReviewedSourceAction(source, { workspaceId: admission.workspaceId });
  const c = source.context;
  if (c.writeId !== admission.writeId || c.requestId !== admission.requestId || c.claimId !== admission.claimId
    || c.claimIdentity !== admission.claimIdentity || c.executedBy !== admission.actorId
    || c.dispatchRequestDigest !== admission.dispatchRequestDigest || c.phase !== admission.phase
    || contentExecutionSourceIntent(source) !== admission.intentDigest || c.completedAt < admission.admittedAt
    || template && c.completedAt !== admission.admittedAt
    || c.origin === 'owner_objective_content' && c.proposal.source.actorSessionVersion !== admission.actorSessionVersion) throw fail();
  if (Buffer.byteLength(canonicalReviewedActionJson(source)) > REVIEWED_ACTION_MAX_BYTES
    || contentReceiptJsonbBytes(source) > REVIEWED_ACTION_JSONB_MAX_BYTES) throw fail('CONTENT_RECEIPT_TOO_LARGE', 413);
}

function receiptForSource(admission, source) {
  const body = { schema: CONTENT_EXECUTION_RECEIPT_SCHEMA, workspaceId: admission.workspaceId,
    attemptId: admission.attemptId, admissionDigest: admission.digest, intentDigest: admission.intentDigest,
    observation: 'provider_confirmed', source };
  const receipt = { ...body, digest: digestReviewedActionValue(body) };
  if (contentReceiptJsonbBytes(receipt) > CONTENT_EXECUTION_RECEIPT_MAX_BYTES) throw fail('CONTENT_RECEIPT_TOO_LARGE', 413);
  return receipt;
}

export function validateContentExecutionCommit(descriptor) {
  canonicalReviewedActionJson(descriptor);
  if (!['reserve','finalize'].includes(descriptor?.kind)
    || !exact(descriptor, ['contract','kind','admission',descriptor.kind === 'reserve' ? 'sourceTemplate' : 'receipt'])
    || descriptor.contract !== CONTENT_EXECUTION_RECEIPT_CONTRACT) throw fail();
  const admission = descriptor.admission;
  checkedAdmission(admission);
  if (descriptor.kind === 'reserve') {
    checkedSource(descriptor.sourceTemplate, admission, { template: true });
    // Check the entire future receipt, not only its independently bounded source.
    receiptForSource(admission, descriptor.sourceTemplate);
  } else {
    const receipt = descriptor.receipt;
    if (!exact(receipt, receiptKeys) || receipt.schema !== CONTENT_EXECUTION_RECEIPT_SCHEMA
      || receipt.workspaceId !== admission.workspaceId || receipt.attemptId !== admission.attemptId
      || receipt.admissionDigest !== admission.digest || receipt.intentDigest !== admission.intentDigest
      || receipt.observation !== 'provider_confirmed'
      || receipt.digest !== digestReviewedActionValue(withoutDigest(receipt))) throw fail();
    checkedSource(receipt.source, admission);
    if (contentReceiptJsonbBytes(receipt) > CONTENT_EXECUTION_RECEIPT_MAX_BYTES) throw fail('CONTENT_RECEIPT_TOO_LARGE', 413);
  }
  return freeze(JSON.parse(canonicalReviewedActionJson(descriptor)));
}

export function prepareContentExecutionAdmission({ state, write, preparedInput, actor, actorSession,
  approval, objectivePolicy, approvedProposal = null, dispatchRequestDigest, claimId, claimIdentity,
  authorityDigest, apiVersion, phaseAt, comparisonContract }) {
  if (!comparisonContract) throw fail('CONTENT_RECEIPT_SOURCE_UNAVAILABLE');
  try {
    const previewWrite = { ...write, result: { externalId: preparedInput.productId }, completedAt: phaseAt };
    const context = createRecordedActionContext({ state: { workspace: { id: state.workspace.id } }, write: previewWrite,
      preparedInput, actor, approval, objectivePolicy, approvedProposal, dispatchRequestDigest, claimId, claimIdentity, apiVersion });
    const sourceTemplate = sourceActionFromRecordedContext({ input: preparedInput, recordedActionContext: context }, state.workspace.id);
    const body = { schema: CONTENT_EXECUTION_ADMISSION_SCHEMA, workspaceId: state.workspace.id,
      attemptId: `content_attempt_${digestReviewedActionValue([state.workspace.id, claimId, 'shopify_mutation'])}`,
      writeId: write.id, requestId: write.requestId, claimId, claimIdentity, authorityDigest, actorId: actor,
      actorSessionVersion: actorSession.sessionVersion, phase: 'shopify_mutation', dispatchRequestDigest,
      intentDigest: contentExecutionSourceIntent(sourceTemplate), admittedAt: phaseAt, reservedBytes: CONTENT_EXECUTION_RESERVED_BYTES };
    const descriptor = { contract: CONTENT_EXECUTION_RECEIPT_CONTRACT, kind: 'reserve',
      admission: { ...body, digest: digestReviewedActionValue(body) }, sourceTemplate };
    validateContentExecutionCommit(descriptor);
    return freeze(JSON.parse(canonicalReviewedActionJson(descriptor)));
  } catch (error) {
    if (error.code?.startsWith('CONTENT_RECEIPT_')) throw error;
    throw fail(error.code === 'OUTCOME_ACTION_TOO_LARGE' ? 'CONTENT_RECEIPT_TOO_LARGE' : 'CONTENT_RECEIPT_SOURCE_UNAVAILABLE',
      error.code === 'OUTCOME_ACTION_TOO_LARGE' ? 413 : 409);
  }
}

export function completeContentExecutionReceipt(reservation, { completedAt, resultId }) {
  validateContentExecutionCommit(reservation);
  if (reservation.kind !== 'reserve' || !stamp(completedAt) || completedAt < reservation.admission.admittedAt
    || resultId !== reservation.sourceTemplate.input.productId) throw fail();
  const { digest: _digest, ...body } = reservation.sourceTemplate;
  const completed = { ...body, context: { ...body.context, completedAt } };
  const source = { ...completed, digest: digestReviewedActionValue(completed) };
  const descriptor = { contract: CONTENT_EXECUTION_RECEIPT_CONTRACT, kind: 'finalize', admission: reservation.admission,
    receipt: receiptForSource(reservation.admission, source) };
  validateContentExecutionCommit(descriptor);
  return freeze(JSON.parse(canonicalReviewedActionJson(descriptor)));
}

// The adapter verifies requestFingerprint and both primary revisions against
// its frozen wire request before calling this recorder. This private channel
// lets dispatch require that verified proof after reporting changes _revision.
export function recordContentReceiptAcknowledgement(savedState, descriptor, ack) {
  validateContentExecutionCommit(descriptor);
  canonicalReviewedActionJson(ack);
  const a = descriptor.admission;
  if (!savedState || typeof savedState !== 'object' || savedState.workspace?.id !== a.workspaceId || !exact(ack, ackKeys)
    || ack.schema !== CONTENT_EXECUTION_RECEIPT_ACK_SCHEMA || ack.kind !== descriptor.kind
    || ack.workspaceId !== a.workspaceId || ack.attemptId !== a.attemptId || ack.admissionDigest !== a.digest
    || ack.intentDigest !== a.intentDigest || ack.reservedBytes !== CONTENT_EXECUTION_RESERVED_BYTES
    || ack.receiptDigest !== (descriptor.kind === 'finalize' ? descriptor.receipt.digest : null)
    || typeof ack.requestFingerprint !== 'string' || !HASH.test(ack.requestFingerprint)
    || typeof ack.expectedRevision !== 'string' || !UUID.test(ack.expectedRevision)
    || typeof ack.nextRevision !== 'string' || !UUID.test(ack.nextRevision) || ack.expectedRevision === ack.nextRevision
    || typeof ack.replayed !== 'boolean' || Buffer.byteLength(canonicalReviewedActionJson(ack)) > CONTENT_EXECUTION_RECEIPT_ACK_MAX_BYTES) throw fail('CONTENT_RECEIPT_ACK_INVALID', 503);
  acknowledgements.set(savedState, { descriptorDigest: digestReviewedActionValue(descriptor),
    ack: freeze(JSON.parse(canonicalReviewedActionJson(ack))) });
}

export function assertContentReceiptAcknowledgement(savedState, descriptor) {
  const proof = savedState && acknowledgements.get(savedState);
  if (!proof || proof.descriptorDigest !== digestReviewedActionValue(descriptor)) throw fail('CONTENT_RECEIPT_ACK_INVALID', 503);
  return proof.ack;
}

export const contentReceiptRequestFingerprint = text => createHash('sha256').update(text, 'utf8').digest('hex');
