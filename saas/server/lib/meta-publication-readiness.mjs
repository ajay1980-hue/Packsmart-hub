import {randomUUID} from 'node:crypto';
import {contentWriteSnapshot} from './content-write-identity.mjs';
import {metaLedgerText, metaLedgerDigest, prepareMetaLedgerCommand, metaLedgerCommandBody, META_LEDGER_PROVENANCE} from './meta-publication-ledger.mjs';
import {assertMetaDeliveryOwner} from './meta-publication-delivery.mjs';
import {parseMetaContainerResponse} from './meta-container-response.mjs';
import {metaBoundedBytes, metaStrictJson} from './meta-publication-bounded.mjs';
export const META_READINESS_CONTRACT = 'runvara-meta-container-readiness/v1';
const proofs = new WeakMap();
const fail = code => Object.assign(new Error(code), {code, status: 409});
const snapshot = value => contentWriteSnapshot(structuredClone(value));
const exact = (v, keys) => {contentWriteSnapshot(v); if (!v || Array.isArray(v) || Object.keys(v).sort().join('|') !== [...keys].sort().join('|')) throw fail('META_READINESS_INVALID');};
const digest = request => {const {expectedState, ...identity} = request; return metaLedgerDigest(identity);};
async function rpc(request, name, data) {
  if (typeof request !== 'function') throw fail('META_READINESS_CLOSED');
  const text = JSON.stringify(data); if (Buffer.byteLength(text) > 2200000) throw fail('META_READINESS_INVALID');
  return metaStrictJson(await metaBoundedBytes(signal => request(name, {p_request: text}, {signal}), {maxBytes: 18000, mediaType: 'application/json'}));
}
function check(value, binding, kind) {
  exact(value, ['eventText', 'digest', 'replayed']);
  const e = JSON.parse(value.eventText);
  exact(e, ['contract', 'provenance', 'workspaceId', 'writeId', 'requestId', 'kind', 'actor', 'bindingDigest', 'containerId', 'attempt',
    'admissionDigest', 'statusCode', 'approvalDigest', 'at', 'requestFingerprint', 'providerReadPerformed']);
  if (value.eventText !== metaLedgerText(e) || value.digest !== metaLedgerDigest(e) || typeof value.replayed !== 'boolean'
    || e.contract !== META_READINESS_CONTRACT || e.provenance !== META_LEDGER_PROVENANCE || e.providerReadPerformed !== false
    || e.workspaceId !== binding.workspaceId || e.writeId !== binding.writeId || e.bindingDigest !== metaLedgerDigest(binding)
    || e.kind !== kind || typeof e.containerId !== 'string' || !/^\d{1,32}$/.test(e.containerId) || !Number.isInteger(e.attempt) || e.attempt < 1 || e.attempt > 5
    || typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at)) || new Date(e.at).toISOString() !== e.at
    || typeof e.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(e.requestId)
    || ![e.bindingDigest, e.approvalDigest, e.requestFingerprint].every(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x))
    || kind === 'admit' && (e.admissionDigest !== null || e.statusCode !== null)
    || kind === 'settle' && (typeof e.admissionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(e.admissionDigest)
      || !['IN_PROGRESS', 'FINISHED', 'PUBLISHED', 'ERROR', 'EXPIRED'].includes(e.statusCode))) throw fail('META_READINESS_INVALID');
  exact(e.actor, ['userId', 'sessionVersion']);
  if (typeof e.actor.userId !== 'string' || !Number.isSafeInteger(e.actor.sessionVersion) || e.actor.sessionVersion < 1) throw fail('META_READINESS_INVALID');
  return Object.freeze({event: Object.freeze(e), digest: value.digest, replayed: value.replayed});
}
export async function readMetaReadiness(binding, session, {request, loadFreshState} = {}) {
  if (typeof loadFreshState !== 'function' || session.workspaceId !== binding.workspaceId) throw fail('META_READINESS_CLOSED');
  assertMetaDeliveryOwner(await loadFreshState(), session);
  const value = await rpc(request, 'runvara_read_meta_readiness_v1', {contract: META_READINESS_CONTRACT, workspaceId: binding.workspaceId,
    writeId: binding.writeId, bindingDigest: metaLedgerDigest(binding), actor: {userId: session.userId, sessionVersion: session.sessionVersion}});
  assertMetaDeliveryOwner(await loadFreshState(), session);
  if (value === null) return null;
  exact(value, ['admission', 'settlement']);
  const admission = check(value.admission, binding, 'admit'), settlement = value.settlement === null ? null : check(value.settlement, binding, 'settle');
  if (settlement && (settlement.event.admissionDigest !== admission.digest || settlement.event.containerId !== admission.event.containerId
    || settlement.event.attempt !== admission.event.attempt || metaLedgerText(settlement.event.actor) !== metaLedgerText(admission.event.actor)
    || settlement.event.approvalDigest !== admission.event.approvalDigest || Date.parse(settlement.event.at) < Date.parse(admission.event.at))) throw fail('META_READINESS_INVALID');
  return {admission, settlement};
}
async function commit(data, binding, session, adapters) {
  let value, recovered = false;
  try {value = await rpc(adapters.request, 'runvara_commit_meta_readiness_v1', data);}
  catch {
    recovered = true;
    const latest = await readMetaReadiness(binding, session, adapters);
    const retained = data.kind === 'admit' ? latest?.admission : latest?.settlement;
    if (!retained || retained.event.requestId !== data.requestId || retained.event.requestFingerprint !== digest(data)) throw fail('META_READINESS_COMMIT_UNKNOWN');
    return {...retained, recovered}; // Recovered evidence has no GET permission.
  }
  const proof = check(value, binding, data.kind);
  if (proof.event.requestId !== data.requestId || proof.event.requestFingerprint !== digest(data)
    || metaLedgerText(proof.event.actor) !== metaLedgerText(data.actor) || proof.event.statusCode !== data.statusCode
    || proof.event.admissionDigest !== data.admissionDigest) throw fail('META_READINESS_COMMIT_UNKNOWN');
  proofs.set(proof, structuredClone(data)); return {...proof, recovered, capability: proof};
}
export function isFreshMetaReadiness(retained, binding, containerId, now = Date.now()) {
  const e = retained?.settlement?.event, admittedAt = Date.parse(retained?.admission?.event.at);
  return Boolean(e && e.statusCode === 'FINISHED' && e.containerId === containerId && e.bindingDigest === metaLedgerDigest(binding)
    && metaLedgerText(e.actor) === metaLedgerText(binding.actor) && Date.parse(e.at) >= admittedAt && now >= Date.parse(e.at)
    && now - admittedAt < 60000);
}
export async function observeMetaReadinessFixture(binding, containerId, session, {request, loadFreshState, read} = {}) {
  if (typeof read !== 'function' || typeof loadFreshState !== 'function') throw fail('META_READINESS_CLOSED');
  const adapters = {request, loadFreshState};
  const previous = await readMetaReadiness(binding, session, adapters);
  if (isFreshMetaReadiness(previous, binding, containerId)) return previous;
  if (previous && (!previous.settlement || ['ERROR', 'EXPIRED', 'PUBLISHED'].includes(previous.settlement.event.statusCode)
    || Date.now() - Date.parse(previous.admission.event.at) < 60000)) return previous;
  const state = await loadFreshState(); assertMetaDeliveryOwner(state, session);
  // Reuse current cost, stock, source and exact approval validation, without
  // submitting a publication admission merely to check readiness.
  const command = prepareMetaLedgerCommand(state, binding, session, {kind: 'admit', phase: 'publish', requestId: 'readiness-' + randomUUID(), expectedHead: null, admissionDigest: null, data: {}});
  const source = JSON.parse(metaLedgerCommandBody(command).p_request);
  const data = {contract: META_READINESS_CONTRACT, workspaceId: binding.workspaceId, writeId: binding.writeId,
    requestId: source.requestId, kind: 'admit', actor: source.actor, binding: source.binding, expectedState: source.expectedState, admissionDigest: null, statusCode: null};
  const admission = await commit(data, binding, session, adapters);
  if (admission.recovered || admission.replayed) return {admission, settlement: null};
  if (admission.event.containerId !== containerId) throw fail('META_READINESS_CONTAINER_CHANGED');
  const before = snapshot(state);
  const guard = async () => {
    const fresh = await loadFreshState(); assertMetaDeliveryOwner(fresh, session);
    if (snapshot(fresh) !== before) throw fail('META_READINESS_SOURCE_CHANGED');
  };
  const raw = await read(containerId, guard);
  const status = parseMetaContainerResponse(JSON.stringify(raw), containerId);
  const issued = proofs.get(admission.capability); if (!issued) throw fail('META_READINESS_PROOF_REQUIRED');
  const settlement = await commit({...issued, kind: 'settle', requestId: issued.requestId + '.settle', expectedState: null,
    admissionDigest: admission.digest, statusCode: status.status_code}, binding, session, adapters);
  assertMetaDeliveryOwner(await loadFreshState(), session);
  return {admission, settlement};
}
