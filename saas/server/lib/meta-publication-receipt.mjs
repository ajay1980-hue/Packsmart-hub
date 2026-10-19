import { createHash } from 'node:crypto';
import { contentWriteSnapshot, contentApprovalDecisionSnapshot } from './content-write-identity.mjs';

// Local synthetic composition only. No environment/HTTP activation or provider
// attestation. Database owners remain outside the append-only threat model.
export const META_RECEIPT_CONTRACT = 'runvara-synthetic-meta-receipts/v1';
export const META_RECEIPT_EVENT_MAX = 32768;
export const META_RECEIPT_EVENT_LIMIT = 16;
// eventText is encoded once more as a JSON string on the read response.
export const META_RECEIPT_READ_MAX = META_RECEIPT_EVENT_LIMIT * (META_RECEIPT_EVENT_MAX * 2 + 256) + 4096;
const issued = new WeakSet(), acknowledgements = new WeakMap(), protectedReads = new WeakMap();
const hash = text => createHash('sha256').update(text).digest('hex');
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const metaReceiptError = (reason = 'INVALID', status = 409, definitive = true) =>
  Object.assign(new Error(`META_RECEIPT_${reason}`), { code: `META_RECEIPT_${reason}`, status, definitive });
export function metaReceiptProjection(state, writeId) {
  contentWriteSnapshot(state.connectionWrites);
  const rows = state.connectionWrites.filter(row => row.id === writeId);
  if (rows.length !== 1) throw metaReceiptError();
  const write = rows[0], approvals = state.approvals?.filter(row => row.id === write.approvalId);
  if (approvals?.length !== 1 || write.marketingPublication?.receiptContract !== META_RECEIPT_CONTRACT) throw metaReceiptError();
  const { metaReceiptCursor: _cursor, ...body } = write;
  return { write: JSON.parse(contentWriteSnapshot(body)), approval: JSON.parse(contentApprovalDecisionSnapshot(approvals[0])) };
}
export function prepareMetaReceiptCommit(state, write) {
  const previous = write.metaReceiptCursor;
  if (previous && (previous.contract !== META_RECEIPT_CONTRACT || !Number.isSafeInteger(previous.sequence)
    || previous.sequence < 1 || !sha(previous.digest))) throw metaReceiptError();
  const event = { workspaceId: state.workspace.id, writeId: write.id,
    sequence: (previous?.sequence ?? 0) + 1, previousDigest: previous?.digest ?? null,
    projection: metaReceiptProjection(state, write.id), simulated: true, executedExternally: false };
  const eventText = contentWriteSnapshot(event), digest = hash(eventText);
  if (event.sequence === 1 && Buffer.byteLength(eventText) > META_RECEIPT_EVENT_MAX - 8192) throw metaReceiptError('CAPACITY_OR_MODE');
  const descriptor = Object.freeze({ contract: META_RECEIPT_CONTRACT, eventText, digest });
  validateMetaReceiptDescriptor(descriptor);
  write.metaReceiptCursor = { contract: META_RECEIPT_CONTRACT, sequence: event.sequence, digest };
  issued.add(descriptor);
  return descriptor;
}
export function validateMetaReceiptDescriptor(descriptor, { requireIssued = false } = {}) {
  contentWriteSnapshot(descriptor);
  if (requireIssued && !issued.has(descriptor) || Object.keys(descriptor).sort().join(',') !== 'contract,digest,eventText'
    || descriptor.contract !== META_RECEIPT_CONTRACT || typeof descriptor.eventText !== 'string'
    || Buffer.byteLength(descriptor.eventText) > META_RECEIPT_EVENT_MAX || hash(descriptor.eventText) !== descriptor.digest) throw metaReceiptError();
  const event = JSON.parse(descriptor.eventText);
  if (contentWriteSnapshot(event) !== descriptor.eventText || Object.keys(event).sort().join(',') !== 'executedExternally,previousDigest,projection,sequence,simulated,workspaceId,writeId'
    || !id(event.workspaceId) || !id(event.writeId) || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.sequence > META_RECEIPT_EVENT_LIMIT
    || (event.sequence === 1 ? event.previousDigest !== null : !sha(event.previousDigest)) || event.simulated !== true || event.executedExternally !== false
    || event.projection?.write?.id !== event.writeId || event.projection.write.marketingPublication?.workspaceId !== event.workspaceId
    || event.projection.write.marketingPublication?.receiptContract !== META_RECEIPT_CONTRACT) throw metaReceiptError();
  return event;
}
export function recordMetaReceiptAcknowledgement(state, descriptor, ack) {
  const event = validateMetaReceiptDescriptor(descriptor);
  if (ack?.contract !== META_RECEIPT_CONTRACT || ack.workspaceId !== event.workspaceId || ack.writeId !== event.writeId
    || ack.sequence !== event.sequence || ack.eventDigest !== descriptor.digest || !sha(ack.requestFingerprint)
    || contentWriteSnapshot(metaReceiptProjection(state, event.writeId)) !== contentWriteSnapshot(event.projection)) throw metaReceiptError('ACK_INVALID', 503, false);
  acknowledgements.set(state, descriptor.digest);
}
export function assertMetaReceiptAcknowledgement(state, descriptor) {
  if (acknowledgements.get(state) !== descriptor.digest) throw metaReceiptError('ACK_INVALID', 503, false);
}
export function metaReceiptActor(session) {
  contentWriteSnapshot(session);
  const actor = { userId: session.userId, sessionVersion: session.sessionVersion };
  if (!id(actor.userId) || !Number.isSafeInteger(actor.sessionVersion) || actor.sessionVersion < 1) throw metaReceiptError('ACTOR_INVALID', 403);
  return actor;
}

export function prepareMetaReceiptTransaction(workspaceId, state, expectedRevision, descriptor) {
  const event = validateMetaReceiptDescriptor(descriptor);
  if (event.workspaceId !== workspaceId || state.workspace?.id !== workspaceId || !id(expectedRevision) || !id(state._revision)
    || state._revision === expectedRevision || contentWriteSnapshot(metaReceiptProjection(state, event.writeId)) !== contentWriteSnapshot(event.projection)) throw metaReceiptError();
  const raw = JSON.stringify({ contract: META_RECEIPT_CONTRACT, workspaceId, expectedRevision, nextRevision: state._revision, state, descriptor });
  const body = JSON.stringify({ p_request: raw });
  if (Buffer.byteLength(raw) > 2162688 || Buffer.byteLength(body) > 4325440) throw metaReceiptError('TOO_LARGE', 413);
  const expected = { contract: META_RECEIPT_CONTRACT, workspaceId, writeId: event.writeId, sequence: event.sequence,
    eventDigest: descriptor.digest, requestFingerprint: hash(raw), expectedRevision, nextRevision: state._revision };
  const actor = { userId: event.projection.write.requestedBy, sessionVersion: event.projection.write.marketingPublication.actorSessionVersion };
  return Object.freeze({ body, descriptor, expected, lookupBody: JSON.stringify({ p_request: JSON.stringify({
    contract: META_RECEIPT_CONTRACT, workspaceId, writeId: event.writeId, actor, requestFingerprint: expected.requestFingerprint }) }) });
}
function checkedAck(value, expected, replay = false) {
  contentWriteSnapshot(value);
  if (Object.keys(value).sort().join(',') !== [...Object.keys(expected), 'replayed'].sort().join(',') || Buffer.byteLength(JSON.stringify(value)) > 2048
    || Object.entries(expected).some(([key, item]) => value[key] !== item) || typeof value.replayed !== 'boolean' || replay && !value.replayed) throw metaReceiptError('COMMIT_UNKNOWN', 503, false);
  return Object.freeze(structuredClone(value));
}
export async function commitMetaReceiptTransaction(transaction, request) {
  try {
    const ack = checkedAck(await request('state_commit', 'rpc/runvara_commit_meta_receipt',
      { method: 'POST', body: transaction.body, maxResponseBytes: 2048 }), transaction.expected);
    return { ack, recovered: ack.replayed };
  } catch (error) {
    if (/^P0M0[1-5]$/.test(error?.databaseCode || '')) throw metaReceiptError(({ P0M01: 'INVALID', P0M02: 'AUTHORITY_CHANGED', P0M03: 'CAPACITY_OR_MODE', P0M04: 'CONFLICT', P0M05: 'PROTECTED_WRITE' })[error.databaseCode]);
    if (['42P01','42883','42501','PGRST202'].includes(error?.databaseCode) || [401,403,404,413].includes(error?.httpStatus)) throw metaReceiptError('UNAVAILABLE', 503);
    try {
      const ack = await request('state_read', 'rpc/runvara_lookup_meta_receipt', { method: 'POST', body: transaction.lookupBody, maxResponseBytes: 2048 });
      if (ack !== null) return { ack: checkedAck(ack, transaction.expected, true), recovered: true };
    } catch { /* Missing exact proof is uncertainty, never permission to resend. */ }
    throw metaReceiptError('COMMIT_UNKNOWN', 503, false);
  }
}
export async function readProtectedMetaReceipt(request, workspaceId, writeId, session) {
  if (!id(workspaceId) || !id(writeId) || session.workspaceId !== workspaceId) throw metaReceiptError('ACTOR_INVALID', 403);
  const actor = metaReceiptActor(session);
  const response = await request('state_read', 'rpc/runvara_read_meta_receipt', { method: 'POST', maxResponseBytes: META_RECEIPT_READ_MAX,
    body: JSON.stringify({ p_request: JSON.stringify({ contract: META_RECEIPT_CONTRACT, workspaceId, writeId, actor }) }) });
  contentWriteSnapshot(response);
  if (!response || Object.keys(response).sort().join(',') !== 'contract,events,executedExternally,simulated,workspaceId,writeId'
    || response.contract !== META_RECEIPT_CONTRACT || response.workspaceId !== workspaceId || response.writeId !== writeId
    || response.simulated !== true || response.executedExternally !== false || !Array.isArray(response.events)
    || !response.events.length || response.events.length > META_RECEIPT_EVENT_LIMIT) throw metaReceiptError('READ_INVALID', 503);
  let previous = null;
  for (const [index, descriptor] of response.events.entries()) {
    const event = validateMetaReceiptDescriptor(descriptor);
    if (event.sequence !== index + 1 || event.previousDigest !== previous || event.workspaceId !== workspaceId || event.writeId !== writeId
      || event.projection.write.requestedBy !== actor.userId || event.projection.write.marketingPublication.actorSessionVersion !== actor.sessionVersion) throw metaReceiptError('READ_INVALID', 503);
    previous = descriptor.digest;
  }
  const result = structuredClone(response);
  protectedReads.set(result, contentWriteSnapshot(result));
  return result;
}
export function protectedMetaReceiptProjection(proof, workspaceId, writeId) {
  if (!protectedReads.has(proof) || protectedReads.get(proof) !== contentWriteSnapshot(proof)
    || proof.workspaceId !== workspaceId || proof.writeId !== writeId) throw metaReceiptError('READ_INVALID', 503);
  return validateMetaReceiptDescriptor(proof.events.at(-1)).projection;
}

// The first protected publish admission is immutable, even if a later outcome
// is retained. Caller JSON and current workspace projections cannot mint it.
export function protectedMetaPublicationAdmission(proof, workspaceId, writeId) {
  protectedMetaReceiptProjection(proof, workspaceId, writeId);
  const descriptor = proof.events.find(row => validateMetaReceiptDescriptor(row).projection.write.dispatchClaim?.phases?.instagram_publish);
  if (!descriptor) return null;
  const event = validateMetaReceiptDescriptor(descriptor), write = event.projection.write;
  const target = write.marketingPublication.target, containerId = write.providerState?.containerId;
  if (typeof containerId !== 'string' || !/^\d{1,32}$/.test(containerId)
    || write.dispatchClaim.phases.instagram_container?.resultId !== containerId) throw metaReceiptError('READ_INVALID', 503);
  return Object.freeze({ workspaceId, writeId, receiptSequence: event.sequence, receiptDigest: descriptor.digest,
    publicationDigest: write.marketingPublication.digest, connectionId: target.connectionId,
    account: target.account, pageId: target.pageId, instagramId: target.instagramId, containerId });
}
