// Inactive composition of existing approval/source gates, durable asset bytes,
// protected phase admission and exact outcome settlement. No production issuer.
import {normalizeApprovalRequest} from './operations.mjs';
import {addAudit} from './events.mjs';
import {contentWriteSnapshot} from './content-write-identity.mjs';
import {metaRequestEnvelope, metaWriteScopes, requireMetaScopes} from './meta-commerce.mjs';
import {metaLedgerDigest, metaLedgerText, META_LEDGER_CONTRACT, buildMetaLedgerFixtureProposal,
  prepareMetaLedgerCommand, commitMetaLedgerCommand, prepareMetaLedgerSettlement, metaLedgerFixtureOutcome, readMetaLedgerRetained} from './meta-publication-ledger.mjs';
import {metaAssetDescriptor, assertMetaAssetSource, assertMetaDeliveryOwner, verifyMetaAssetDeliveryFixture} from './meta-publication-delivery.mjs';
import {metaBoundedBytes, metaStrictJson} from './meta-publication-bounded.mjs';
import {observeMetaReadinessFixture, isFreshMetaReadiness} from './meta-publication-readiness.mjs';

const compositions = new WeakMap();
const fail = code => Object.assign(new Error(code), {code, status: 409});
const stateText = state => contentWriteSnapshot(structuredClone(state));
const requestId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(v);
const numeric = v => typeof v === 'string' && /^\d{1,32}$/.test(v);
function exact(v, keys) {
  contentWriteSnapshot(v);
  if (!v || Array.isArray(v) || Object.keys(v).sort().join('|') !== [...keys].sort().join('|')) throw fail('META_FLOW_INVALID');
}
function config(capability) {const c = compositions.get(capability); if (!c) throw fail('META_FLOW_PRODUCTION_CLOSED'); return c;}
export function createMetaSingleImageFixture({environment, store, request, fetch, assetRequest = request} = {}) {
  if (environment !== 'test' || !store || typeof store.get !== 'function' || typeof store.save !== 'function'
    || typeof request !== 'function' || typeof assetRequest !== 'function' || typeof fetch !== 'function') throw fail('META_FLOW_PRODUCTION_CLOSED');
  const cap = Object.freeze(Object.create(null)); compositions.set(cap, {store, request, assetRequest, fetch}); return cap;
}
function assetBinding(asset, binding, state, session) {
  const d = assertMetaAssetSource(asset, state, session);
  if (d.campaignId !== binding.campaignId || d.sourceRevision !== binding.sourceRevision
    || metaLedgerText(d.selection) !== metaLedgerText(binding.selection) || binding.asset.deliveryDigest !== metaLedgerDigest(d)
    || binding.asset.sha256 !== d.image.sha256 || binding.asset.byteLength !== d.image.byteLength || binding.asset.mediaType !== d.image.mediaType) throw fail('META_FLOW_ASSET_CHANGED');
  return d;
}
function approval(state, binding) {
  const matches = (state.approvals || []).filter(a => a.id === binding.approvalId);
  if (matches.length !== 1 || metaLedgerText(matches[0].payload?.binding) !== metaLedgerText(binding)
    || matches[0].payload?.bindingDigest !== metaLedgerDigest(binding)) throw fail('META_FLOW_APPROVAL_CHANGED');
  return matches[0];
}
export async function prepareMetaSingleImageFixture(capability, asset, campaignId, selection, session, publicationRequestId) {
  const c = config(capability); if (!requestId(publicationRequestId)) throw fail('META_FLOW_INVALID');
  const state = await c.store.get(session.workspaceId); assertMetaDeliveryOwner(state, session);
  const d = assertMetaAssetSource(asset, state, session);
  const identity = metaLedgerDigest({workspaceId: session.workspaceId, requestId: publicationRequestId});
  const binding = buildMetaLedgerFixtureProposal(state, campaignId, selection, session, {environment: 'test',
    writeId: 'meta-' + identity, requestId: publicationRequestId, claimId: 'claim-' + identity,
    approvalId: 'approval-' + identity, approvalRevision: 1,
    asset: {sha256: d.image.sha256, byteLength: d.image.byteLength, mediaType: d.image.mediaType, deliveryDigest: metaLedgerDigest(d)}});
  assetBinding(asset, binding, state, session);
  const existing = (state.approvals || []).filter(a => a.id === binding.approvalId);
  if (existing.length) {approval(state, binding); return {binding, publishingEnabled: false, replayed: true};}
  const decision = normalizeApprovalRequest({type: 'social_commerce_publish', action: 'Review exact single-image Instagram proposal (publishing closed)',
    reason: 'Exact caption, destination and retained JPEG bytes are bound in this approval.', expectedBenefit: 'No provider action or financial benefit has been established.',
    risk: 'Inactive local composition. Hosted installation, provider access and exact real delivery remain unaccepted.',
    source: 'meta-protected-single-image', payload: {contract: META_LEDGER_CONTRACT, bindingDigest: metaLedgerDigest(binding), binding: structuredClone(binding), delivery: d}}, session.userId);
  Object.assign(decision, {id: binding.approvalId, type: 'protected_meta_publication', workspaceId: session.workspaceId});
  state.approvals.unshift(decision);
  addAudit(state, {type: 'meta_protected_proposal_prepared', actor: session.userId,
    detail: {writeId: binding.writeId, approvalId: binding.approvalId, bindingDigest: metaLedgerDigest(binding), assetSha256: d.image.sha256, publishingEnabled: false}});
  const expected = stateText(decision), prior = state._revision;
  const guard = next => {
    assertMetaDeliveryOwner(next, session); assetBinding(asset, binding, next, session);
    if (stateText(approval(next, binding)) !== expected) throw fail('META_FLOW_APPROVAL_CHANGED');
  };
  try {
    const saved = await c.store.save(session.workspaceId, state, {ownedSnapshot: true, beforeCommit: guard});
    if (!saved || saved._revision === prior) throw fail('META_FLOW_SAVE_UNKNOWN'); guard(saved);
  } catch {throw fail('META_FLOW_SAVE_UNKNOWN');}
  return {binding, publishingEnabled: false, replayed: false};
}
const operationId = (b, phase, kind) => b.writeId + '.' + phase + '.' + kind;
async function find(c, binding, session, requestId) {
  const loadFreshState = () => c.store.get(session.workspaceId);
  assertMetaDeliveryOwner(await loadFreshState(), session);
  if (binding.workspaceId !== session.workspaceId) throw fail('META_FLOW_AUTHORITY');
  const identity = {workspaceId: binding.workspaceId, writeId: binding.writeId, requestId, bindingDigest: metaLedgerDigest(binding)};
  const query = {contract: META_LEDGER_CONTRACT, ...identity, actor: {userId: session.userId, sessionVersion: session.sessionVersion}};
  const value = metaStrictJson(await metaBoundedBytes(signal => c.request('runvara_read_meta_ledger_v1', {p_request: JSON.stringify(query)}, {signal}), {maxBytes: 53248, mediaType: 'application/json'}));
  assertMetaDeliveryOwner(await loadFreshState(), session);
  if (value === null) return null;
  // Reuse the ledger's exact evidence validator; no mutation branding is issued.
  const retained = await readMetaLedgerRetained(identity, session, {loadFreshState, request: async () => Response.json(value)});
  const expected = requestId === binding.requestId ? ['reserve', 'proposal']
    : ['container', 'publish'].flatMap(phase => ['admit', 'settle'].map(kind => [kind, phase]))
      .find(([kind, phase]) => requestId === operationId(binding, phase, kind));
  if (!expected || retained.event.kind !== expected[0] || retained.event.phase !== expected[1]
    || expected[0] !== 'settle' && metaLedgerText(retained.event.data) !== '{}'
    || expected[0] === 'settle' && metaLedgerText(retained.event.data) !== metaLedgerText(metaLedgerFixtureOutcome(expected[1], retained.event.data.resultId))) throw fail('META_FLOW_RETAINED_ROLE_CHANGED');
  return retained;
}
const publicState = (binding, resultId = null, disposition = 'unresolved_do_not_resend') => ({writeId: binding.writeId,
  requestId: binding.requestId, bindingDigest: metaLedgerDigest(binding), resultId, disposition,
  publishingEnabled: false, simulated: true, executedExternally: false, providerReadPerformed: false, resendPermitted: false});
export async function readMetaSingleImageFixture(capability, binding, session) {
  const c = config(capability);
  const outcome = await find(c, binding, session, operationId(binding, 'publish', 'settle'));
  return outcome?.event.data.resultId ? publicState(binding, outcome.event.data.resultId, 'fixture_result_retained') : publicState(binding);
}
async function providerJson(c, path, options, guard = async () => {}) {
  // Fixed synthetic strings cannot resolve the user's Meta credentials. Only
  // the caller's explicit test fetch is used; no global.fetch fallback exists.
  return metaStrictJson(await metaBoundedBytes(async (signal, checkDeadline) => {
    await guard();
    checkDeadline();
    const request = metaRequestEnvelope(path, 'runvara-synthetic-no-access', 'runvara-synthetic-no-secret', options);
    const address = new URL(request.address); address.hostname = 'graph.runvara.invalid';
    checkDeadline();
    return c.fetch(address.href, {...request.init, signal});
  }, {maxBytes: 16384, mediaType: 'application/json'}));
}
async function preflight(c, binding, guard) {
  const me = await providerJson(c, '/me', {query: {fields: 'id'}}, guard); exact(me, ['id']);
  if (me.id !== binding.target.account) throw fail('META_FLOW_PROVIDER_ACCOUNT_CHANGED');
  const grants = await providerJson(c, '/me/permissions', {}, guard); exact(grants, ['data']);
  if (!Array.isArray(grants.data) || grants.data.length > 64) throw fail('META_FLOW_PROVIDER_PERMISSIONS');
  const permissions = new Set();
  for (const row of grants.data) {exact(row, ['permission', 'status']);
    if (typeof row.permission !== 'string' || row.permission.length > 100 || permissions.has(row.permission)
      || !['granted', 'declined', 'expired'].includes(row.status)) throw fail('META_FLOW_PROVIDER_PERMISSIONS'); permissions.add(row.permission);}
  requireMetaScopes(grants.data.filter(r => r.status === 'granted').map(r => r.permission), metaWriteScopes('instagram_publish'));
  const page = await providerJson(c, '/' + binding.target.pageId, {query: {fields: 'id,tasks,instagram_business_account{id}'}}, guard);
  exact(page, ['id', 'tasks', 'instagram_business_account']); exact(page.instagram_business_account, ['id']);
  if (page.id !== binding.target.pageId || page.instagram_business_account.id !== binding.target.instagramId
    || !Array.isArray(page.tasks) || page.tasks.length > 32 || !page.tasks.every(t => typeof t === 'string')
    || !page.tasks.some(t => ['MANAGE', 'CREATE_CONTENT'].includes(t))) throw fail('META_FLOW_PROVIDER_TARGET_CHANGED');
  const limit = await providerJson(c, '/' + binding.target.instagramId + '/content_publishing_limit', {query: {fields: 'quota_usage,config'}}, guard);
  exact(limit, ['data']); if (!Array.isArray(limit.data) || limit.data.length !== 1) throw fail('META_FLOW_PROVIDER_LIMIT');
  const row = limit.data[0];
  if (!Number.isSafeInteger(row.quota_usage) || row.quota_usage < 0 || !Number.isSafeInteger(row.config?.quota_total)
    || row.config.quota_total < 1 || row.quota_usage >= row.config.quota_total) throw fail('META_FLOW_PROVIDER_LIMIT');
}
async function admit(c, binding, asset, session, phase, head, readiness = null, containerId = null) {
  const state = await c.store.get(session.workspaceId); assertMetaDeliveryOwner(state, session); assetBinding(asset, binding, state, session); approval(state, binding);
  const command = prepareMetaLedgerCommand(state, binding, session, {kind: 'admit', phase, requestId: operationId(binding, phase, 'admit'),
    expectedHead: head, admissionDigest: null, data: {}});
  const proof = await commitMetaLedgerCommand(command, {request: c.request});
  if (proof.replayed || proof.recovered) return null; // An ACK lookup never issues a send capability.
  const snapshot = stateText(state);
  const guard = async () => {
    const fresh = await c.store.get(session.workspaceId);
    assertMetaDeliveryOwner(fresh, session); assetBinding(asset, binding, fresh, session);
    const a = approval(fresh, binding), {executedExternally, executionStatus, workStatus, ...decision} = a;
    if (stateText(fresh) !== snapshot || metaLedgerDigest(decision) !== proof.event.approvalDigest) throw fail('META_FLOW_SOURCE_CHANGED');
    if (phase === 'publish' && !isFreshMetaReadiness(readiness, binding, containerId)) throw fail('META_FLOW_READINESS_EXPIRED');
    // Reuse current financial/source/approval/session grammar immediately before
    // serialization; this prepares no second admission or transport.
    prepareMetaLedgerCommand(fresh, binding, session, {kind: 'admit', phase, requestId: operationId(binding, phase, 'admit'), expectedHead: head, admissionDigest: null, data: {}});
  };
  return {proof, guard};
}
export async function executeMetaSingleImageFixture(capability, binding, asset, token, session) {
  const c = config(capability);
  // Capture caller-owned JSON so no await can substitute an approved target.
  binding = JSON.parse(metaLedgerText(binding)); session = JSON.parse(metaLedgerText(session));
  let state = await c.store.get(session.workspaceId); assertMetaDeliveryOwner(state, session); assetBinding(asset, binding, state, session); approval(state, binding);
  let reserve = await find(c, binding, session, binding.requestId);
  if (!reserve) reserve = await commitMetaLedgerCommand(prepareMetaLedgerCommand(state, binding, session,
    {kind: 'reserve', phase: 'proposal', requestId: binding.requestId, expectedHead: null, admissionDigest: null, data: {}}), {request: c.request});
  let head = reserve.digest;
  const final = await find(c, binding, session, operationId(binding, 'publish', 'settle'));
  if (final) return readMetaSingleImageFixture(capability, binding, session);
  let container = await find(c, binding, session, operationId(binding, 'container', 'settle'));
  if (!container) {
    if (await find(c, binding, session, operationId(binding, 'container', 'admit'))) return publicState(binding);
    const admission = await admit(c, binding, asset, session, 'container', head); if (!admission) return publicState(binding);
    const delivery = await verifyMetaAssetDeliveryFixture(asset, token, {request: c.assetRequest});
    await preflight(c, binding, admission.guard);
    const result = await providerJson(c, '/' + binding.target.instagramId + '/media',
      {method: 'POST', body: {image_url: delivery.url, caption: binding.caption}}, admission.guard);
    exact(result, ['id']); if (!numeric(result.id)) throw fail('META_FLOW_RESULT_UNKNOWN');
    // Settle before any fresh-owner disclosure/source check: a later revocation
    // cannot erase a result from the exact previously admitted operation.
    container = await commitMetaLedgerCommand(prepareMetaLedgerSettlement(admission.proof, operationId(binding, 'container', 'settle'),
      metaLedgerFixtureOutcome('container', result.id)), {request: c.request});
  }
  if (container.event.containerConflict || !numeric(container.event.data.resultId)) return publicState(binding);
  head = container.digest;
  if (await find(c, binding, session, operationId(binding, 'publish', 'admit'))) return publicState(binding);
  const readiness = await observeMetaReadinessFixture(binding, container.event.data.resultId, session, {
    request: c.request, loadFreshState: () => c.store.get(session.workspaceId),
    read: (containerId, guard) => providerJson(c, '/' + containerId, {query: {fields: 'id,status_code'}}, guard)});
  if (!isFreshMetaReadiness(readiness, binding, container.event.data.resultId)) return publicState(binding);
  const admission = await admit(c, binding, asset, session, 'publish', head, readiness, container.event.data.resultId); if (!admission) return publicState(binding);
  await verifyMetaAssetDeliveryFixture(asset, token, {request: c.assetRequest}); await preflight(c, binding, admission.guard);
  const result = await providerJson(c, '/' + binding.target.instagramId + '/media_publish',
    {method: 'POST', body: {creation_id: container.event.data.resultId}}, admission.guard);
  exact(result, ['id']); if (!numeric(result.id)) throw fail('META_FLOW_RESULT_UNKNOWN');
  await commitMetaLedgerCommand(prepareMetaLedgerSettlement(admission.proof, operationId(binding, 'publish', 'settle'),
    metaLedgerFixtureOutcome('publish', result.id)), {request: c.request});
  return readMetaSingleImageFixture(capability, binding, session);
}
