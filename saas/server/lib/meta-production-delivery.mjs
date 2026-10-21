import {createHash} from 'node:crypto';
import {contentWriteSnapshot} from './content-write-identity.mjs';
import {assertMetaPublicationOwner, previewMetaMarketingPublication} from './marketing-publication.mjs';
import {snapshotLocalJpeg, JPEG_MAX_BYTES, JPEG_CONTRACT} from './marketing-jpeg.mjs';
import {metaLedgerDigest, metaLedgerText, metaProductionConsent, META_LEDGER_PROVENANCE} from './meta-production-ledger.mjs';
import {metaBoundedBytes, metaStrictJson} from './meta-publication-bounded.mjs';

export const META_ASSET_CONTRACT = 'runvara-meta-durable-asset/production-v1';
const assets = new WeakMap(), commands = new WeakMap();
const hash = value => createHash('sha256').update(value).digest('hex');
const error = code => Object.assign(new Error(code), {code, status: 409});
const bad = () => {throw error('META_ASSET_INVALID');};
const exact = (v, keys) => {contentWriteSnapshot(v); if (!v || Array.isArray(v) || Object.keys(v).sort().join('|') !== [...keys].sort().join('|')) bad();};
const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(v);
const sha = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function assertMetaDeliveryOwner(state, session) {
  assertMetaPublicationOwner(state, session);
  const users = state.users.filter(u => u.id === session.userId); if (users.length !== 1) bad();
  const u = users[0];
  for (const [k, fallback] of [['disabled', false], ['active', true], ['passwordChangeRequired', false], ['status', 'active'], ['sessionVersion', 1]]) {
    const value = Object.hasOwn(u, k) ? u[k] : fallback;
    if (value !== (k === 'sessionVersion' ? session.sessionVersion : fallback)) throw error('META_ASSET_AUTHORITY');
  }
}
function descriptor(value) {
  exact(value, ['contract', 'provenance', 'workspaceId', 'campaignId', 'requestId', 'assetId', 'actor', 'selection',
    'sourceRevision', 'referenceDigest', 'image', 'origin', 'tokenDigest', 'expiresAt', 'providerDeliveryVerified']);
  const image = value.image;
  exact(image, ['schema', 'mediaType', 'sha256', 'byteLength', 'width', 'height', 'pixelSha256', 'pixelByteLength', 'decoder', 'decoded', 'providerDeliveryVerified']);
  if (value.contract !== META_ASSET_CONTRACT || value.provenance !== META_LEDGER_PROVENANCE
    || ![value.workspaceId, value.campaignId, value.requestId].every(id)
    || ![value.assetId, value.sourceRevision, value.referenceDigest, value.tokenDigest, image.sha256, image.pixelSha256].every(sha)
    || value.assetId !== metaLedgerDigest({workspaceId: value.workspaceId, campaignId: value.campaignId, requestId: value.requestId, sha256: image.sha256})
    || image.schema !== JPEG_CONTRACT || image.mediaType !== 'image/jpeg' || image.width !== 1080 || image.height !== 1080
    || image.pixelByteLength !== 4665600 || image.decoded !== true || image.providerDeliveryVerified !== false
    || image.decoder !== 'jpeg-js@0.4.4/strict-baseline-ycbcr/v1' || !Number.isSafeInteger(image.byteLength) || image.byteLength < 100 || image.byteLength > JPEG_MAX_BYTES
    || value.providerDeliveryVerified !== false || !Number.isSafeInteger(value.expiresAt)
    || value.origin !== 'https://packsmart-ops.onrender.com') bad();
  exact(value.actor, ['userId', 'sessionVersion']);
  exact(value.selection, ['pageId', 'creativeRequestId', 'assetUrl']);
  if (!id(value.actor.userId) || !Number.isSafeInteger(value.actor.sessionVersion) || value.actor.sessionVersion < 1
    || !/^\d{1,32}$/.test(value.selection.pageId) || !id(value.selection.creativeRequestId) || typeof value.selection.assetUrl !== 'string') bad();
  return value;
}
function source(state, d, session) {
  assertMetaDeliveryOwner(state, session);
  if (d.workspaceId !== session.workspaceId || d.actor.userId !== session.userId) throw error('META_ASSET_AUTHORITY');
  const current = previewMetaMarketingPublication(state, d.campaignId, d.selection, session);
  if (current.sourceRevision !== d.sourceRevision || current.asset.referenceDigest !== d.referenceDigest) throw error('META_ASSET_SOURCE_CHANGED');
  return current;
}
const actor = session => ({userId: session.userId, sessionVersion: session.sessionVersion});
async function rpc(request, name, body) {
  if (typeof request !== 'function') throw error('META_ASSET_CLOSED');
  const text = JSON.stringify(body); if (Buffer.byteLength(text) > 5100000) bad();
  return metaStrictJson(await metaBoundedBytes(signal => request(name, {p_request: text}, {signal}), {maxBytes: 2900000, mediaType: 'application/json'}));
}
function retained(value, expected) {
  exact(value, ['contract', 'descriptorText', 'digest', 'bytesBase64', 'replayed', 'providerDeliveryVerified']);
  const d = descriptor(JSON.parse(value.descriptorText));
  if (value.contract !== META_ASSET_CONTRACT || value.descriptorText !== metaLedgerText(d) || value.digest !== metaLedgerDigest(d)
    || typeof value.replayed !== 'boolean' || value.providerDeliveryVerified !== false || typeof value.bytesBase64 !== 'string'
    || value.bytesBase64.length > Math.ceil(JPEG_MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.bytesBase64)
    || value.digest !== expected) bad();
  const bytes = Buffer.from(value.bytesBase64, 'base64');
  if (bytes.toString('base64') !== value.bytesBase64 || bytes.length !== d.image.byteLength || hash(bytes) !== d.image.sha256) bad();
  const cap = Object.freeze(Object.create(null)); assets.set(cap, {descriptor: structuredClone(d), bytes}); return cap;
}
// The authenticated controller supplies immutable source/tenant identity and
// server-generated delivery tokens. SQL starts closed and rechecks the actor.
export async function prepareMetaAssetProduction(campaignId, selection, session, bytes, options, {loadFreshState} = {}) {
  exact(options, ['environment', 'requestId', 'origin', 'token', 'expiresAt']);
  if (options.environment !== 'production' || !sha(options.token) || typeof loadFreshState !== 'function') throw error('META_ASSET_CLOSED');
  const initial = await loadFreshState(); assertMetaDeliveryOwner(initial, session);
  const current = previewMetaMarketingPublication(initial, campaignId, selection, session);
  const image = await snapshotLocalJpeg(bytes);
  const d = descriptor({contract: META_ASSET_CONTRACT, provenance: META_LEDGER_PROVENANCE, workspaceId: session.workspaceId,
    campaignId, requestId: options.requestId, assetId: metaLedgerDigest({workspaceId: session.workspaceId, campaignId, requestId: options.requestId, sha256: image.descriptor.sha256}),
    actor: actor(session), selection: structuredClone(selection), sourceRevision: current.sourceRevision, referenceDigest: current.asset.referenceDigest,
    image: image.descriptor, origin: options.origin, tokenDigest: hash(options.token), expiresAt: options.expiresAt, providerDeliveryVerified: false});
  const fresh = await loadFreshState(); source(fresh, d, session);
  const state = structuredClone(fresh); contentWriteSnapshot(state);
  const cap = Object.freeze(Object.create(null));
  commands.set(cap, {body: {contract: META_ASSET_CONTRACT, descriptor: d, expectedState: state, bytesBase64: image.bytes.toString('base64')}, session: structuredClone(session)});
  return cap;
}
export async function commitMetaAsset(command, {request, loadFreshState} = {}) {
  const entry = commands.get(command); if (!entry || typeof loadFreshState !== 'function') throw error('META_ASSET_CLOSED');
  const d = entry.body.descriptor, digest = metaLedgerDigest(d);
  source(await loadFreshState(), d, entry.session);
  let value;
  try {value = await rpc(request, 'runvara_commit_meta_prod_asset_v1', entry.body);}
  catch { // Never resend a write after an uncertain ACK.
    try {value = await rpc(request, 'runvara_read_meta_prod_asset_v1', {contract: META_ASSET_CONTRACT, workspaceId: d.workspaceId, assetId: d.assetId, digest, actor: actor(entry.session)});}
    catch {throw error('META_ASSET_COMMIT_UNKNOWN');}
  }
  const cap = retained(value, digest); source(await loadFreshState(), d, entry.session); return cap;
}
export function metaAssetDescriptor(capability) {
  const entry = assets.get(capability); if (!entry) throw error('META_ASSET_PROOF_REQUIRED'); return structuredClone(entry.descriptor);
}
export function metaAssetReviewBytes(capability) {
  const entry = assets.get(capability); if (!entry) throw error('META_ASSET_PROOF_REQUIRED');
  return Buffer.from(entry.bytes);
}
export async function readMetaAsset(identity, session, {request, loadFreshState} = {}) {
  exact(identity, ['workspaceId', 'assetId', 'digest']);
  if (identity.workspaceId !== session.workspaceId || !sha(identity.assetId) || !sha(identity.digest) || typeof loadFreshState !== 'function') bad();
  assertMetaDeliveryOwner(await loadFreshState(), session);
  const value = await rpc(request, 'runvara_read_meta_prod_asset_v1', {contract: META_ASSET_CONTRACT, ...identity, actor: actor(session)});
  const cap = retained(value, identity.digest), d = assets.get(cap).descriptor;
  if (d.workspaceId !== identity.workspaceId || d.assetId !== identity.assetId) bad();
  assertMetaDeliveryOwner(await loadFreshState(), session); return cap;
}
export function metaAssetProductionUrl(capability, token) {
  const d = metaAssetDescriptor(capability);
  if (!sha(token) || hash(token) !== d.tokenDigest) throw error('META_ASSET_DELIVERY_DENIED');
  return d.origin + '/api/meta-publication-assets/production-v1/' + metaLedgerDigest(d) + '/' + token + '.jpg';
}
export function assertMetaAssetSource(capability, state, session, now = Date.now()) {
  const d = metaAssetDescriptor(capability); source(state, d, session);
  if (!Number.isSafeInteger(now) || d.expiresAt < now + 60000) throw error('META_ASSET_EXPIRED');
  return d;
}
// Registered same-service delivery handler. The only
// lookup is by fixed digest + 256-bit bearer value, never a supplied URL/path.
export async function serveMetaAssetProduction(identity, {request, loadFreshState} = {}) {
  exact(identity, ['digest', 'token']); if (!sha(identity.digest) || !sha(identity.token)) bad();
  if (typeof loadFreshState !== 'function') throw error('META_ASSET_CLOSED');
  const value = await rpc(request, 'runvara_deliver_meta_prod_asset_v1', {contract: META_ASSET_CONTRACT, ...identity});
  const capability = retained(value, identity.digest), entry = assets.get(capability);
  if (hash(identity.token) !== entry.descriptor.tokenDigest) bad();
  const d = entry.descriptor, session = {workspaceId: d.workspaceId, ...d.actor};
  const state = await loadFreshState(d.workspaceId);
  assertMetaAssetSource(capability, state, session);
  const approvals = (state.approvals || []).filter(a => a.type === 'protected_meta_production_publication'
    && a.payload?.binding?.asset?.deliveryDigest === identity.digest);
  if (approvals.length !== 1 || approvals[0].status !== 'approved'
    || metaLedgerText(approvals[0].metaProductionConsent) !== metaLedgerText(metaProductionConsent(approvals[0].payload.binding))) throw error('META_ASSET_DELIVERY_DENIED');
  return new Response(Buffer.from(entry.bytes), {status: 200, headers: {'content-type': 'image/jpeg', 'content-length': String(entry.bytes.length),
    'cache-control': 'no-store, private', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-disposition': 'inline; filename="publication.jpg"'}});
}
export async function verifyMetaAssetDeliveryProduction(capability, token, {fetchAsset} = {}) {
  const d = metaAssetDescriptor(capability), url = metaAssetProductionUrl(capability, token);
  if (typeof fetchAsset !== 'function') throw error('META_ASSET_CLOSED');
  const bytes = await metaBoundedBytes(signal => fetchAsset(url, {method: 'GET', redirect: 'error',
    headers: {accept: 'image/jpeg'}, signal}), {maxBytes: JPEG_MAX_BYTES, mediaType: 'image/jpeg'});
  if (bytes.length !== d.image.byteLength || hash(bytes) !== d.image.sha256) bad();
  return {url, sha256: d.image.sha256, byteLength: bytes.length, providerDeliveryVerified: false};
}
