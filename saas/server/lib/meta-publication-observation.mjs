import { createHash } from 'node:crypto';
import { contentWriteSnapshot } from './content-write-identity.mjs';
import { assertManualContentActor } from './manual-content-target.mjs';
import { metaReceiptActor, protectedMetaReceiptProjection, protectedMetaPublicationAdmission } from './meta-publication-receipt.mjs';

// Prepared synthetic observation contract. There is deliberately no real
// transport issuer, token access, URL input, polling loop or mutation adapter.
export const META_OBSERVATION_CONTRACT = 'runvara-synthetic-meta-observations/v1';
export const META_OBSERVATION_LIMIT = 8;
export const META_OBSERVATION_MAX = 4096;
export const META_OBSERVATION_READ_MAX = 73728;
const observers = new WeakMap(), issued = new WeakSet();
const hash = text => createHash('sha256').update(text).digest('hex');
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
const requestIdValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(value);
const numeric = value => typeof value === 'string' && /^\d{1,32}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const statuses = ['IN_PROGRESS', 'FINISHED', 'PUBLISHED', 'ERROR', 'EXPIRED'];
export const metaObservationError = (reason = 'INVALID', status = 409) =>
  Object.assign(new Error('META_OBSERVATION_' + reason), { code: 'META_OBSERVATION_' + reason, status });
function exact(value, keys) {
  contentWriteSnapshot(value);
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.slice().sort().join(',')) throw metaObservationError();
}
export function validateMetaObservationAnchor(anchor) {
  exact(anchor, ['workspaceId','writeId','receiptSequence','receiptDigest','publicationDigest','connectionId','account','pageId','instagramId','containerId']);
  if (![anchor.workspaceId,anchor.writeId,anchor.connectionId].every(id) || ![anchor.account,anchor.pageId,anchor.instagramId,anchor.containerId].every(numeric)
    || ![anchor.receiptDigest,anchor.publicationDigest].every(sha) || !Number.isSafeInteger(anchor.receiptSequence)
    || anchor.receiptSequence < 1 || anchor.receiptSequence > 16) throw metaObservationError();
  return anchor;
}
export function validateMetaObservation(descriptor, anchor, { requireIssued = false } = {}) {
  exact(descriptor, ['contract','observationText','digest']);
  if (requireIssued && !issued.has(descriptor) || descriptor.contract !== META_OBSERVATION_CONTRACT
    || typeof descriptor.observationText !== 'string' || Buffer.byteLength(descriptor.observationText) > META_OBSERVATION_MAX
    || hash(descriptor.observationText) !== descriptor.digest) throw metaObservationError();
  const row = JSON.parse(descriptor.observationText);
  if (contentWriteSnapshot(row) !== descriptor.observationText) throw metaObservationError();
  exact(row, ['anchor','requestId','actor','observedAt','statusCode','resultId','outcome','source','simulated','executedExternally','providerReadPerformed','replayPermitted']);
  validateMetaObservationAnchor(row.anchor); exact(row.actor, ['userId','sessionVersion']); metaReceiptActor(row.actor);
  if (contentWriteSnapshot(row.anchor) !== contentWriteSnapshot(anchor) || !requestIdValid(row.requestId)
    || typeof row.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row.observedAt)
    || !Number.isFinite(Date.parse(row.observedAt)) || new Date(row.observedAt).toISOString() !== row.observedAt
    || !statuses.includes(row.statusCode) || row.resultId !== null || row.outcome !== 'unresolved_do_not_resend'
    || row.source !== 'fixed_simulated_meta_container_status/v1' || row.simulated !== true || row.executedExternally !== false
    || row.providerReadPerformed !== false || row.replayPermitted !== false) throw metaObservationError();
  return row;
}
export function createMetaObservationSimulation(fixtures) {
  contentWriteSnapshot(fixtures);
  if (!Array.isArray(fixtures) || !fixtures.length || fixtures.length > 32) throw metaObservationError();
  const rows = fixtures.map(row => {
    exact(row, ['anchor','response']); validateMetaObservationAnchor(row.anchor); exact(row.response, ['id','status_code']);
    if (row.response.id !== row.anchor.containerId || !statuses.includes(row.response.status_code)) throw metaObservationError();
    return structuredClone(row);
  });
  if (new Set(rows.map(row => contentWriteSnapshot(row.anchor))).size !== rows.length) throw metaObservationError();
  const capability = Object.freeze(Object.create(null));
  observers.set(capability, rows);
  return capability;
}
export function assertMetaObservationSimulation(capability) {
  if (!observers.has(capability)) throw metaObservationError('PRODUCTION_CLOSED');
}
const body = (workspaceId, writeId, session, extra = {}) => {
  if (!id(workspaceId) || !id(writeId) || session.workspaceId !== workspaceId) throw metaObservationError('AUTHORITY_CHANGED', 403);
  return JSON.stringify({ p_request: JSON.stringify({ contract: META_OBSERVATION_CONTRACT, workspaceId, writeId, actor: metaReceiptActor(session), ...extra }) });
};
export async function readMetaObservationHistory(request, workspaceId, writeId, session, anchor) {
  validateMetaObservationAnchor(anchor);
  const result = await request('state_read', 'rpc/runvara_read_meta_observations', {
    method: 'POST', body: body(workspaceId, writeId, session), maxResponseBytes: META_OBSERVATION_READ_MAX });
  exact(result, ['contract','workspaceId','writeId','observations']);
  if (result.contract !== META_OBSERVATION_CONTRACT || result.workspaceId !== workspaceId || result.writeId !== writeId
    || !Array.isArray(result.observations) || result.observations.length > META_OBSERVATION_LIMIT
    || Buffer.byteLength(JSON.stringify(result)) > META_OBSERVATION_READ_MAX) throw metaObservationError('READ_INVALID', 503);
  const ids = new Set();
  for (const descriptor of result.observations) {
    const row = validateMetaObservation(descriptor, anchor);
    if (ids.has(row.requestId) || contentWriteSnapshot(row.actor) !== contentWriteSnapshot(metaReceiptActor(session))) throw metaObservationError('READ_INVALID', 503);
    ids.add(row.requestId);
  }
  return structuredClone(result.observations);
}
export async function appendMetaObservation(request, workspaceId, writeId, session, descriptor, anchor) {
  const row = validateMetaObservation(descriptor, anchor, { requireIssued: true });
  if (contentWriteSnapshot(row.actor) !== contentWriteSnapshot(metaReceiptActor(session))) throw metaObservationError('AUTHORITY_CHANGED', 403);
  try {
    const result = await request('state_commit', 'rpc/runvara_append_meta_observation', {
      method: 'POST', body: body(workspaceId, writeId, session, { descriptor }), maxResponseBytes: META_OBSERVATION_MAX * 2 + 512 });
    if (contentWriteSnapshot(result) !== contentWriteSnapshot(descriptor)) throw metaObservationError('COMMIT_UNKNOWN', 503);
    return result;
  } catch (error) {
    if (/^P0O0[1-5]$/.test(error?.databaseCode)) throw metaObservationError(({ P0O01:'INVALID',P0O02:'AUTHORITY_CHANGED',P0O03:'CAPACITY_OR_MODE',P0O04:'CONFLICT',P0O05:'PROTECTED_WRITE' })[error.databaseCode]);
    // One exact read may recover a lost acknowledgement. Never repeat append.
    try {
      const history = await readMetaObservationHistory(request, workspaceId, writeId, session, anchor);
      const found = history.find(item => validateMetaObservation(item, anchor).requestId === row.requestId);
      if (found && contentWriteSnapshot(found) === contentWriteSnapshot(descriptor)) return found;
    } catch { /* The write outcome stays unknown; this grants no resend. */ }
    throw metaObservationError('COMMIT_UNKNOWN', 503);
  }
}

async function authority(store, session) {
  const identity = await store.getIdentity(session.workspaceId);
  const user = assertManualContentActor(identity, session.userId);
  if (identity.workspace?.id !== session.workspaceId || user.role !== 'owner'
    || user.disabled != null && user.disabled !== false || user.active != null && user.active !== true || (user.status ?? 'active') !== 'active'
    || (user.sessionVersion ?? 1) !== session.sessionVersion) throw metaObservationError('AUTHORITY_CHANGED', 403);
}
export async function metaPublicationObservations(store, writeId, session, { capability = null, requestId = null } = {}) {
  // No customer JSON, environment setting or public route can issue a simulator.
  if (requestId !== null) { if (!requestIdValid(requestId)) throw metaObservationError('INPUT_INVALID', 400); assertMetaObservationSimulation(capability); }
  if (typeof store.readProtectedMetaPublication !== 'function' || typeof store.readMetaObservations !== 'function') throw metaObservationError('UNAVAILABLE', 503);
  await authority(store, session);
  const proof = await store.readProtectedMetaPublication(session.workspaceId, writeId, session);
  await authority(store, session);
  const projection = protectedMetaReceiptProjection(proof, session.workspaceId, writeId);
  const anchor = protectedMetaPublicationAdmission(proof, session.workspaceId, writeId);
  const result = { contract: META_OBSERVATION_CONTRACT, writeId, anchor, observations: [],
    outcome: 'unresolved_do_not_resend', resultId: null, publishingEnabled: false, replayPermitted: false,
    simulated: true, executedExternally: false, providerReadPerformed: false, captureAvailable: false };
  if (!anchor) { if (requestId !== null) throw metaObservationError('NO_KNOWN_PUBLISH_ADMISSION'); return result; }
  const eligible = ['uncertain','executing'].includes(projection.write.status);
  result.captureAvailable = eligible && observers.get(capability)?.some(row => contentWriteSnapshot(row.anchor) === contentWriteSnapshot(anchor)) === true;
  const history = await store.readMetaObservations(session.workspaceId, writeId, session, anchor);
  await authority(store, session);
  result.observations = history.map(row => ({ ...validateMetaObservation(row, anchor), digest: row.digest }));
  if (requestId === null || result.observations.some(row => row.requestId === requestId)) return result;
  if (!result.captureAvailable) throw metaObservationError('PRODUCTION_CLOSED');
  if (history.length >= META_OBSERVATION_LIMIT) throw metaObservationError('CAPACITY_OR_MODE');
  const fixture = observers.get(capability).find(row => contentWriteSnapshot(row.anchor) === contentWriteSnapshot(anchor));
  // A fresh simulated read is independent of the original dispatch process.
  // PUBLISHED without exact unique media evidence remains unresolved.
  const response = await Promise.resolve(structuredClone(fixture.response));
  await authority(store, session);
  const observationText = contentWriteSnapshot({ anchor, requestId, actor: metaReceiptActor(session), observedAt: new Date().toISOString(),
    statusCode: response.status_code, resultId: null, outcome: 'unresolved_do_not_resend', source: 'fixed_simulated_meta_container_status/v1',
    simulated: true, executedExternally: false, providerReadPerformed: false, replayPermitted: false });
  const descriptor = Object.freeze({ contract: META_OBSERVATION_CONTRACT, observationText, digest: hash(observationText) });
  issued.add(descriptor);
  await store.appendMetaObservation(session.workspaceId, writeId, session, descriptor, anchor);
  await authority(store, session);
  result.observations.push({ ...validateMetaObservation(descriptor, anchor), digest: descriptor.digest });
  return result;
}
