// Versioned production authority. Synthetic contracts/proofs are never accepted.
// The server controller supplies fresh actor state; SQL admission is also required.
import {createHash} from 'node:crypto';
import {contentWriteSnapshot} from './content-write-identity.mjs';
import {previewMetaMarketingPublication} from './marketing-publication.mjs';
export const META_LEDGER_CONTRACT = 'runvara-meta-publication-ledger/production-v1';
export const META_LEDGER_ADMISSION = 'runvara-meta-read-admission/production-v1';
export const META_LEDGER_OBSERVATION = 'runvara-meta-container-observation/production-v1';
export const META_LEDGER_RECOVERY = 'runvara-meta-read-recovery/production-v1';
export const META_LEDGER_PROVENANCE = 'server_meta_publication/production-v1';
export const META_LEDGER_LIMITS = Object.freeze({requestBytes: 2200000, eventBytes: 24576,
  responseBytes: 24576 * 2 + 4096, events: 24, workspace: 16, global: 128,
  active: 2, accountActive: 1, readAttempts: 5, cadenceMs: 60000, windowMs: 300000});
const commands = new WeakMap(), proofs = new WeakMap();
const error = code => Object.assign(new Error(code), {code});
const invalid = () => {throw error('META_LEDGER_INVALID');};
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const numeric = value => typeof value === 'string' && /^[0-9]{1,32}$/.test(value);
const exact = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) invalid();
};
// The SQL canonicalizer uses ASCII property names and safe integers. Reject
// unsupported values before hashing; do not silently normalize them.
export function metaLedgerText(value) {
  const text = contentWriteSnapshot(value);
  const check = (v, depth = 0) => {
    if (depth > 24) invalid();
    if (typeof v === 'number' && (!Number.isSafeInteger(v) || Object.is(v, -0))) invalid();
    if (typeof v === 'string' && (!v.isWellFormed() || v.includes('\0'))) invalid();
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
      if (!Array.isArray(v) && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) invalid();
      check(x, depth + 1);
    }
  };
  check(value); return text;
}
export const metaLedgerDigest = value => createHash('sha256').update(metaLedgerText(value)).digest('hex');
export function metaLedgerRequestFingerprint(request) {
  // Workspace data is only a fresh admission comparison, never an identity
  // record or retained credential-bearing payload. Replay binds the exact
  // canonical operation, actor and proposal; it cannot grant another send.
  const {expectedState, ...identity} = request; return metaLedgerDigest(identity);
}
function actor(state, session) {
  exact(session, ['workspaceId', 'userId', 'sessionVersion']);
  if (!id(session.userId) || session.workspaceId !== state.workspace?.id
    || !Number.isSafeInteger(session.sessionVersion) || session.sessionVersion < 1) invalid();
  const users = (state.users || []).filter(u => u.id === session.userId);
  if (users.length !== 1) throw error('META_LEDGER_AUTHORITY');
  const u = users[0];
  const field = (key, fallback) => Object.hasOwn(u, key) ? u[key] : fallback;
  if (u.role !== 'owner' || field('sessionVersion', 1) !== session.sessionVersion
    || field('status', 'active') !== 'active' || field('disabled', false) !== false
    || field('active', true) !== true || field('passwordChangeRequired', false) !== false
    || u.workspaceId !== undefined && u.workspaceId !== session.workspaceId) throw error('META_LEDGER_AUTHORITY');
  return {userId: session.userId, sessionVersion: session.sessionVersion};
}
function source(state, binding, session) {
  actor(state, session);
  if (binding.workspaceId !== session.workspaceId || metaLedgerText(binding.actor) !== metaLedgerText(actor(state, session))) throw error('META_LEDGER_AUTHORITY');
  const current = previewMetaMarketingPublication(state, binding.campaignId, binding.selection, session);
  if (current.sourceRevision !== binding.sourceRevision || metaLedgerText(current.target) !== metaLedgerText(binding.target)
    || current.caption !== binding.caption || current.asset.url !== binding.asset.url
    || current.dailyOrganicLimit !== binding.dailyLimit) throw error('META_LEDGER_SOURCE_CHANGED');
  const approvals = (state.approvals || []).filter(a => a.id === binding.approvalId);
  if (approvals.length !== 1) throw error('META_LEDGER_APPROVAL');
  const a = approvals[0];
  if (a.type !== 'protected_meta_production_publication' || a.status !== 'approved' || a.decidedBy !== session.userId
    || a.revision !== binding.approvalRevision || a.workspaceId !== binding.workspaceId
    || a.payload?.contract !== META_LEDGER_CONTRACT || a.payload?.bindingDigest !== metaLedgerDigest(binding)) throw error('META_LEDGER_APPROVAL');
  if (metaLedgerText(a.metaProductionConsent) !== metaLedgerText(metaProductionConsent(binding))) throw error('META_LEDGER_APPROVAL');
}
export function metaProductionConsent(binding) {
  return {contract: META_LEDGER_CONTRACT, bindingDigest: metaLedgerDigest(binding), sourceRevision: binding.sourceRevision,
    imageSha256: binding.asset.sha256, byteLength: binding.asset.byteLength, caption: binding.caption,
    target: structuredClone(binding.target), postCount: 1};
}
export function buildMetaLedgerProductionProposal(state, campaignId, selection, session, options) {
  metaLedgerText(options);
  exact(options, ['environment', 'writeId', 'requestId', 'claimId', 'approvalId', 'approvalRevision', 'asset']);
  if (options.environment !== 'production' || ![options.writeId, options.requestId, options.claimId, options.approvalId].every(id)
    || !Number.isSafeInteger(options.approvalRevision) || options.approvalRevision < 1) invalid();
  exact(options.asset, ['sha256', 'byteLength', 'mediaType', 'deliveryDigest']);
  if (!sha(options.asset.sha256) || !sha(options.asset.deliveryDigest) || !Number.isSafeInteger(options.asset.byteLength)
    || options.asset.byteLength < 100 || options.asset.byteLength > 2097152 || options.asset.mediaType !== 'image/jpeg') invalid();
  const current = previewMetaMarketingPublication(state, campaignId, selection, session);
  const binding = {workspaceId: session.workspaceId, writeId: options.writeId, requestId: options.requestId,
    claimId: options.claimId, approvalId: options.approvalId, approvalRevision: options.approvalRevision,
    actor: actor(state, session), campaignId, selection: structuredClone(selection), sourceRevision: current.sourceRevision,
    target: current.target, caption: current.caption, dailyLimit: current.dailyOrganicLimit,
    asset: {...options.asset, url: current.asset.url, providerDeliveryVerified: false, provenance: META_LEDGER_PROVENANCE},
    logicalKey: metaLedgerDigest({workspaceId: session.workspaceId, campaignId,
      account: current.target.account, pageId: current.target.pageId, instagramId: current.target.instagramId})};
  binding.inputDigest = metaLedgerDigest({caption: binding.caption, asset: binding.asset, target: binding.target});
  return JSON.parse(metaLedgerText(binding));
}
function issue(request) {
  const text = JSON.stringify(request);
  if (Buffer.byteLength(text) > META_LEDGER_LIMITS.requestBytes) invalid();
  const command = Object.freeze(Object.create(null)); commands.set(command, {text, request: structuredClone(request)}); return command;
}
// Trusted production composition uses the existing financial/source gates. SQL
// compares this complete snapshot under a lock, before recording an admission.
export function prepareMetaLedgerCommand(state, binding, session, operation) {
  // Store-owned nonenumerable capability metadata is not persisted JSON.
  const stateSnapshot = structuredClone(state); contentWriteSnapshot(stateSnapshot);
  metaLedgerText(operation); actor(state, session); metaLedgerText(binding);
  exact(operation, ['kind', 'requestId', 'phase', 'expectedHead', 'admissionDigest', 'data']);
  if (!['reserve', 'admit', 'settle', 'recover'].includes(operation.kind) || !id(operation.requestId)
    || !['proposal', 'container', 'publish', 'read'].includes(operation.phase)
    || operation.expectedHead !== null && !sha(operation.expectedHead)
    || operation.admissionDigest !== null && !sha(operation.admissionDigest)) invalid();
  if (['reserve', 'admit'].includes(operation.kind)) source(state, binding, session);
  return issue({contract: META_LEDGER_CONTRACT, provenance: META_LEDGER_PROVENANCE, workspaceId: binding.workspaceId,
    writeId: binding.writeId, actor: actor(state, session), binding,
    expectedState: ['reserve', 'admit'].includes(operation.kind) ? stateSnapshot : null, ...structuredClone(operation)});
}
// Settlement may survive owner revocation. Only an issued, retained exact
// admission proof can create this narrow operation; no workspace state is sent.
export function prepareMetaLedgerSettlement(admissionProof, requestId, data) {
  metaLedgerText(data);
  const entry = proofs.get(admissionProof);
  if (!entry || entry.event.kind !== 'admit' || !id(requestId)) throw error('META_LEDGER_PROOF_REQUIRED');
  const {request, event} = entry;
  return issue({...request, kind: 'settle', requestId, expectedState: null,
    expectedHead: null, admissionDigest: metaLedgerDigest(event), data: structuredClone(data)});
}
export function metaLedgerCommandBody(command) {
  const entry = commands.get(command); if (!entry) throw error('META_LEDGER_PROOF_REQUIRED');
  return Object.freeze({p_request: entry.text});
}
function evidence(value) {
  exact(value, ['contract', 'provenance', 'eventText', 'digest', 'replayed', 'transportPermitted']);
  if (value.contract !== META_LEDGER_CONTRACT || value.provenance !== META_LEDGER_PROVENANCE
    || typeof value.eventText !== 'string' || Buffer.byteLength(value.eventText) > META_LEDGER_LIMITS.eventBytes
    || typeof value.replayed !== 'boolean' || value.transportPermitted !== false) invalid();
  const event = JSON.parse(value.eventText);
  exact(event, ['contract', 'provenance', 'workspaceId', 'writeId', 'sequence', 'requestId', 'kind', 'phase', 'actor',
    'bindingDigest', 'requestFingerprint', 'previousDigest', 'admissionDigest', 'data', 'at', 'containerId', 'publicationAdmission', 'containerConflict', 'phaseContract', 'approvalDigest']);
  if (metaLedgerText(event) !== value.eventText || metaLedgerDigest(event) !== value.digest
    || event.contract !== META_LEDGER_CONTRACT || event.provenance !== META_LEDGER_PROVENANCE
    || ![event.workspaceId, event.writeId, event.requestId].every(id) || !sha(event.bindingDigest) || !sha(event.requestFingerprint)
    || !['reserve', 'admit', 'settle', 'recover'].includes(event.kind) || !['proposal', 'container', 'publish', 'read'].includes(event.phase)
    || !sha(event.approvalDigest) || event.phaseContract !== (event.kind === 'recover' ? META_LEDGER_RECOVERY
      : event.phase === 'read' && event.kind === 'admit' ? META_LEDGER_ADMISSION : event.phase === 'read' && event.kind === 'settle' ? META_LEDGER_OBSERVATION : META_LEDGER_CONTRACT)
    || event.admissionDigest !== null && !sha(event.admissionDigest)
    || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.sequence > 24
    || event.previousDigest !== null && !sha(event.previousDigest)
    || event.containerId !== null && !numeric(event.containerId)
    || event.publicationAdmission !== null && !sha(event.publicationAdmission)
    || typeof event.containerConflict !== 'boolean' || event.containerConflict && !(event.kind === 'settle' && event.phase === 'container')
    || typeof event.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.at)
    || !Number.isFinite(Date.parse(event.at)) || new Date(event.at).toISOString() !== event.at) invalid();
  exact(event.actor, ['userId', 'sessionVersion']);
  if (!id(event.actor.userId) || !Number.isSafeInteger(event.actor.sessionVersion) || event.actor.sessionVersion < 1) invalid();
  return event;
}
function result(value, event, recovered) {
  return Object.freeze({contract: META_LEDGER_CONTRACT, event: Object.freeze(structuredClone(event)),
    digest: value.digest, recovered, replayed: value.replayed, transportPermitted: false,
    providerReadPerformed: false, executedExternally: false, publishingEnabled: false});
}
function proof(value, entry, recovered) {
  const event = evidence(value);
  if (event.workspaceId !== entry.request.workspaceId || event.writeId !== entry.request.writeId
    || event.requestId !== entry.request.requestId || event.kind !== entry.request.kind || event.phase !== entry.request.phase
    || metaLedgerText(event.actor) !== metaLedgerText(entry.request.actor) || metaLedgerText(event.data) !== metaLedgerText(entry.request.data)
    || event.bindingDigest !== metaLedgerDigest(entry.request.binding) || event.admissionDigest !== entry.request.admissionDigest
    || event.requestFingerprint !== metaLedgerRequestFingerprint(entry.request)) invalid();
  const retained = result(value, event, recovered);
  proofs.set(retained, {request: entry.request, event}); return retained;
}
function flatAck(text) {
  // Only the six flat ACK fields exist on this wire. This scanner rejects
  // duplicate keys before JSON.parse, including escaped spellings of a key.
  const token = /\s*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")\s*:\s*("(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|true|false)\s*([,}])/y;
  let i = text.search(/\S/); if (text[i++] !== '{') invalid();
  const keys = new Set();
  for (;;) {token.lastIndex = i; const m = token.exec(text); if (!m) invalid();
    const key = JSON.parse(m[1]); if (keys.has(key)) invalid(); keys.add(key); i = token.lastIndex;
    if (m[3] === '}') break;
  }
  if (text.slice(i).trim()) invalid(); return JSON.parse(text);
}
async function bounded(submit) {
  const controller = new AbortController(); let reader, body, timer;
  const expiresAt = performance.now() + 5000;
  const cancel = () => {try {(reader ? reader.cancel() : body?.cancel())?.catch(() => {});} catch {}};
  const checkTime = () => {if (controller.signal.aborted || performance.now() >= expiresAt) {cancel(); throw error('META_LEDGER_TIMEOUT');}};
  const pending = (async () => {
    const response = await submit(controller.signal); body = response?.body;
    checkTime();
    if (response?.status !== 200 || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type') || '')) throw error('META_LEDGER_RPC_REJECTED');
    reader = body?.getReader(); if (!reader) invalid();
    const chunks = []; let length = 0, count = 0;
    for (;;) {checkTime(); const {done, value} = await reader.read(); checkTime(); if (done) break;
      if (!(value instanceof Uint8Array) || !value.byteLength || ++count > META_LEDGER_LIMITS.responseBytes) invalid();
      length += value.byteLength; if (length > META_LEDGER_LIMITS.responseBytes) invalid(); chunks.push(Buffer.from(value));}
    const value = flatAck(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, length))); checkTime(); return value;
  })();
  const deadline = new Promise((_, reject) => {timer = setTimeout(() => {controller.abort(); cancel(); reject(error('META_LEDGER_TIMEOUT'));}, 5000);});
  try {return await Promise.race([pending, deadline]);} finally {clearTimeout(timer); cancel();}
}
export async function commitMetaLedgerCommand(command, {request} = {}) {
  const entry = commands.get(command);
  if (!entry || typeof request !== 'function') throw error('META_LEDGER_CLOSED');
  try {return proof(await bounded(signal => request('runvara_commit_meta_prod_ledger_v1', metaLedgerCommandBody(command), {signal})), entry, false);}
  catch {
    // One exact lookup, including the original fingerprint. No RPC resend and
    // no provider permission on either a duplicate ACK or recovered decision.
    const lookup = {contract: META_LEDGER_CONTRACT, workspaceId: entry.request.workspaceId, writeId: entry.request.writeId,
      actor: entry.request.actor, requestId: entry.request.requestId,
      requestFingerprint: metaLedgerRequestFingerprint(entry.request)};
    try {return proof(await bounded(signal => request('runvara_lookup_meta_prod_ledger_v1', {p_request: JSON.stringify(lookup)}, {signal})), entry, true);}
    catch {throw error('META_LEDGER_COMMIT_UNKNOWN');}
  }
}
export async function readMetaLedgerDecision(command, session, {request, loadFreshState} = {}) {
  const entry = commands.get(command);
  if (!entry || typeof request !== 'function' || typeof loadFreshState !== 'function') throw error('META_LEDGER_CLOSED');
  const authorize = state => {if (session.workspaceId !== entry.request.workspaceId) throw error('META_LEDGER_AUTHORITY'); actor(state, session);};
  authorize(await loadFreshState());
  const lookup = {contract: META_LEDGER_CONTRACT, workspaceId: entry.request.workspaceId, writeId: entry.request.writeId,
    actor: {userId: session.userId, sessionVersion: session.sessionVersion}, requestId: entry.request.requestId,
    requestFingerprint: metaLedgerRequestFingerprint(entry.request)};
  const retained = proof(await bounded(signal => request('runvara_lookup_meta_prod_ledger_v1', {p_request: JSON.stringify(lookup)}, {signal})), entry, true);
  authorize(await loadFreshState()); return retained;
}
// Restart-safe disclosure requires only persisted immutable identity and a
// fresh owner session, not an in-process command or the former workspace state.
// This evidence is deliberately not branded as a mutation/settlement issuer.
export async function readMetaLedgerRetained(identity, session, {request, loadFreshState} = {}) {
  exact(identity, ['workspaceId', 'writeId', 'requestId', 'bindingDigest']);
  if (![identity.workspaceId, identity.writeId, identity.requestId].every(id) || !sha(identity.bindingDigest)
    || typeof request !== 'function' || typeof loadFreshState !== 'function') throw error('META_LEDGER_CLOSED');
  const authorize = state => {if (session.workspaceId !== identity.workspaceId) throw error('META_LEDGER_AUTHORITY'); actor(state, session);};
  authorize(await loadFreshState());
  const query = {contract: META_LEDGER_CONTRACT, ...structuredClone(identity), actor: {userId: session.userId, sessionVersion: session.sessionVersion}};
  const value = await bounded(signal => request('runvara_read_meta_prod_ledger_v1', {p_request: JSON.stringify(query)}, {signal}));
  const event = evidence(value);
  if (event.workspaceId !== identity.workspaceId || event.writeId !== identity.writeId || event.requestId !== identity.requestId
    || event.bindingDigest !== identity.bindingDigest || value.replayed !== true) invalid();
  authorize(await loadFreshState()); return result(value, event, true);
}
export function metaLedgerProductionOutcome(phase, resultId = null, statusCode = null) {
  if (!['container', 'publish', 'read'].includes(phase) || resultId !== null && !numeric(resultId)
    || statusCode !== null && !['IN_PROGRESS', 'FINISHED', 'PUBLISHED', 'ERROR', 'EXPIRED'].includes(statusCode)
    || phase === 'read' && resultId !== null || phase !== 'read' && statusCode !== null) invalid();
  return {contract: phase === 'read' ? META_LEDGER_OBSERVATION : META_LEDGER_CONTRACT, resultId, statusCode,
    outcome: resultId === null ? 'unresolved_do_not_resend' : 'provider_result_retained',
    provenance: META_LEDGER_PROVENANCE, simulated: false, executedExternally: phase !== 'read' && resultId !== null,
    providerReadPerformed: phase === 'read' && statusCode !== null, replayPermitted: false};
}
