import crypto from 'node:crypto';
import { META_RECEIPT_CONTRACT, metaReceiptProjection, protectedMetaReceiptProjection } from './meta-publication-receipt.mjs';
import { normalizeApprovalRequest } from './operations.mjs';
import { addAudit } from './events.mjs';
import { connectionSettings } from './connection-centre.mjs';
import { metaMethods, metaWriteScopes, requireMetaScopes } from './meta-commerce.mjs';
import { dispatchConnectionMutation } from './connection-dispatch.mjs';
import { ensureMarketing } from './marketing.mjs';
import { reviewMetaMarketingCampaign } from './marketing-campaign-review.mjs';
import { contentWriteSnapshot, contentApprovalDecisionSnapshot } from './content-write-identity.mjs';
import { objectiveCanonicalDigest as canonicalDigest } from './objective-dispatch-policy.mjs';
import { manualContentWorkspace, assertManualContentActor, assertManualContentScope } from './manual-content-target.mjs';
import { snapshotPublicationImage, LOCAL_PUBLICATION_ASSET_SCHEMA, LEGACY_LOCAL_PUBLICATION_ASSET_SCHEMA,
  LOCAL_PUBLICATION_ASSET_MAX_BYTES, LOCAL_PUBLICATION_DECODE_MAX_BYTES, LOCAL_PUBLICATION_DECODER } from './marketing-publication-asset.mjs';

export const META_PUBLICATION_SCHEMA = 'runvara-meta-campaign-publication/v1';
export const META_PUBLICATION_DISPATCH_SCHEMA = 'runvara-meta-publication-canonical-dispatch/v1';
const receiptSchema = 'runvara-meta-publication-simulation-receipt/v1';
const simulations = new WeakMap();
const preparationSimulations = new WeakMap();
const localAssets = new WeakMap();
const fail = (code, status = 409) => Object.assign(new Error(code), { code, status, definitive: true });
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const numeric = value => typeof value === 'string' && /^\d{1,32}$/.test(value);
const text = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max
  && value === value.trim() && value.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
function exact(value, keys) {
  contentWriteSnapshot(value);
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) throw fail('META_PUBLICATION_INPUT_INVALID', 400);
}
export function assertMetaPublicationOwner(state, session) {
  const user = assertManualContentActor(state, session?.userId);
  if (user.role !== 'owner' || session.workspaceId !== state.workspace.id || !Number.isSafeInteger(session.sessionVersion)
    || user.disabled != null && user.disabled !== false || user.active != null && user.active !== true || (user.status ?? 'active') !== 'active'
    || session.sessionVersion < 1 || (user.sessionVersion ?? 1) !== session.sessionVersion) throw fail('WRITE_ACTOR_CHANGED', 403);
}
const owner = assertMetaPublicationOwner;
function unique(rows, predicate, code) {
  const matches = (rows || []).filter(predicate);
  if (matches.length !== 1) throw fail(code, matches.length ? 409 : 404);
  return matches[0];
}
export function metaPublicationChoices(state, campaignId, session) {
  owner(state, session);
  const campaign = unique(state.marketing?.campaigns, row => row.id === campaignId, 'MARKETING_CAMPAIGN_NOT_FOUND');
  assertManualContentScope(campaign, state.workspace.id);
  const connections = (state.connections || []).filter(row => row.provider === 'meta');
  const pages = [], assets = [];
  if (connections.length === 1) {
    assertManualContentScope(connections[0], state.workspace.id);
    const source = connections[0].metadata?.assets?.pages;
    if (Array.isArray(source) && source.length <= 100) for (const page of source) {
      if (numeric(page?.id) && numeric(page?.instagram?.id) && state.connectionSettings?.meta?.metaPageIds?.includes(page.id)) pages.push({ pageId: page.id, instagramId: page.instagram.id });
    }
  }
  const creatives = campaign.creativeRequests;
  if (Array.isArray(creatives) && creatives.length <= 100) for (const item of creatives) {
    if (item.provider !== 'canva' || item.kind !== 'social_post' || item.status !== 'complete' || item.stage !== 'complete'
      || !Array.isArray(item.assetUrls) || item.assetUrls.length > 20) continue;
    for (const url of item.assetUrls) if (typeof url === 'string' && url.length <= 2000) assets.push({ creativeRequestId: item.id, assetUrl: url });
  }
  return { campaignId, pages, assets: assets.slice(0, 100), publishingEnabled: false,
    notice: 'Preview saved selections only. Image delivery and exact proposal creation remain closed.' };
}
const assetContext = (workspaceId, campaignId, asset) => ({ workspaceId, campaignId,
  creativeRequestId: asset.creativeRequestId, provider: asset.provider, jobId: asset.jobId,
  completedAt: asset.completedAt, url: asset.url, referenceDigest: asset.referenceDigest });
function validateLocalSnapshot(snapshot, context) {
  const decoded = snapshot?.schema === LOCAL_PUBLICATION_ASSET_SCHEMA;
  exact(snapshot, ['schema', 'sha256', 'byteLength', 'mediaType', 'width', 'height', 'mimeEvidence', 'decoded', 'providerDeliveryVerified', 'context',
    ...(decoded ? ['pixelSha256', 'pixelByteLength', 'colorType', 'decoder'] : [])]);
  if (![LOCAL_PUBLICATION_ASSET_SCHEMA, LEGACY_LOCAL_PUBLICATION_ASSET_SCHEMA].includes(snapshot.schema) || !/^[a-f0-9]{64}$/.test(snapshot.sha256)
    || !Number.isSafeInteger(snapshot.byteLength) || snapshot.byteLength < 57 || snapshot.byteLength > LOCAL_PUBLICATION_ASSET_MAX_BYTES
    || snapshot.mediaType !== 'image/png' || !Number.isSafeInteger(snapshot.width) || !Number.isSafeInteger(snapshot.height)
    || snapshot.width < 1 || snapshot.height < 1 || snapshot.width > 16384 || snapshot.height > 16384 || snapshot.width * snapshot.height > 40000000
    || snapshot.mimeEvidence !== (decoded ? 'png_signature_structure_crc_zlib_pixels' : 'png_signature_structure_crc_not_decoded') || snapshot.decoded !== decoded
    || snapshot.providerDeliveryVerified !== false || canonicalDigest(snapshot.context) !== canonicalDigest(context)) throw fail('META_PUBLICATION_LOCAL_ASSET_INVALID');
  if (decoded && (!/^[a-f0-9]{64}$/.test(snapshot.pixelSha256) || ![0, 2, 4, 6].includes(snapshot.colorType)
    || snapshot.pixelByteLength !== snapshot.width * snapshot.height * ({ 0: 1, 2: 3, 4: 2, 6: 4 }[snapshot.colorType])
    || snapshot.pixelByteLength + snapshot.height > LOCAL_PUBLICATION_DECODE_MAX_BYTES
    || snapshot.decoder !== LOCAL_PUBLICATION_DECODER)) throw fail('META_PUBLICATION_LOCAL_ASSET_INVALID');
}
function localManifest(capability, context) {
  const entry = localAssets.get(capability);
  if (!entry || canonicalDigest(entry.manifest.context) !== canonicalDigest(context)) throw fail('META_PUBLICATION_LOCAL_ASSET_INVALID');
  return structuredClone(entry.manifest);
}
function selectedSource(state, campaignId, selection, session, localSnapshot = null) {
  owner(state, session);
  exact(selection, ['pageId', 'creativeRequestId', 'assetUrl']);
  const campaign = unique(state.marketing?.campaigns, row => row.id === campaignId, 'MARKETING_CAMPAIGN_NOT_FOUND');
  assertManualContentScope(campaign, state.workspace.id);
  const review = reviewMetaMarketingCampaign(state, campaignId);
  const product = unique(state.products, row => row.id === campaign.product?.productId, 'META_PUBLICATION_PRODUCT_CHANGED');
  assertManualContentScope(product, state.workspace.id);
  const view = { settings: state.settings, marketing: { settings: state.marketing?.settings } };
  const marketing = ensureMarketing(view).settings;
  assertManualContentScope(state.marketing?.settings || {}, state.workspace.id);
  if (!marketing.enabled || marketing.mode === 'draft' || !marketing.channels.meta || !campaign.channels?.includes('meta')) throw fail('META_PUBLICATION_DISABLED');
  if (!review.eligibility.eligible || review.product.changedFields.length
    || !Number.isSafeInteger(review.product.current?.inventory)) throw fail('META_PUBLICATION_PRODUCT_CHANGED');
  const connection = unique(state.connections, row => row.provider === 'meta', 'META_PUBLICATION_TARGET_UNAVAILABLE');
  // Public retained metadata only. Preparation never reads credential ciphertext.
  const metadata = connection.metadata;
  assertManualContentScope(connection, state.workspace.id);
  const settings = connectionSettings(state, 'meta');
  assertManualContentScope(settings, state.workspace.id);
  if (connection.status !== 'connected' || settings.disconnected || settings.permissionMode === 'read_only'
    || !['approval_gated', 'automatic'].includes(settings.permissionMode)
    || !Number.isSafeInteger(settings.revision) || settings.revision < 0
    || settings.permissionMode === 'automatic' && settings.consent?.mode !== 'automatic') throw fail('WRITE_NOT_AUTHORISED', 403);
  if (!text(connection.id) || !numeric(metadata?.accountId) || !numeric(selection.pageId)
    || !settings.metaPageIds?.includes(selection.pageId)) throw fail('META_PUBLICATION_TARGET_UNAVAILABLE');
  requireMetaScopes(metadata.grantedScopes, metaWriteScopes('instagram_publish'));
  const page = unique(metadata.assets?.pages, row => row.id === selection.pageId, 'META_PUBLICATION_TARGET_UNAVAILABLE');
  if (!numeric(page.instagram?.id)) throw fail('META_INSTAGRAM_REQUIRED');
  const creative = unique(campaign.creativeRequests, row => row.id === selection.creativeRequestId, 'META_PUBLICATION_ASSET_UNAVAILABLE');
  if (creative.provider !== 'canva' || creative.kind !== 'social_post' || creative.status !== 'complete'
    || creative.stage !== 'complete' || !text(creative.jobId) || !text(creative.completedAt)
    || !Array.isArray(creative.assetUrls) || creative.assetUrls.filter(url => url === selection.assetUrl).length !== 1) throw fail('META_PUBLICATION_ASSET_UNAVAILABLE');
  let url;
  try { url = new URL(selection.assetUrl); } catch { throw fail('META_PUBLICATION_ASSET_UNAVAILABLE'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname.includes('.')
    || selection.assetUrl.length > 2000 || !text(campaign.copy?.longCaption, 2200)) throw fail('META_PUBLICATION_INPUT_INVALID');
  const target = { connectionId: connection.id, account: metadata.accountId, pageId: page.id,
    instagramId: page.instagram.id, settingsRevision: settings.revision };
  const asset = { creativeRequestId: creative.id, provider: 'canva', jobId: creative.jobId,
    completedAt: creative.completedAt, url: selection.assetUrl, referenceDigest: canonicalDigest(creative),
    bytesVerified: false };
  if (localSnapshot !== null) {
    validateLocalSnapshot(localSnapshot, assetContext(state.workspace.id, campaignId, asset));
    asset.localSnapshot = structuredClone(localSnapshot);
  }
  // Match the financial resolver's SKU-first, variant-ID fallback exactly;
  // rounded display contribution/margin cannot bind sub-cent source changes.
  const costs = state.economics?.[review.product.current.sku] || state.economics?.[review.product.current.variantId] || {};
  assertManualContentScope(costs, state.workspace.id);
  const source = { workspaceId: state.workspace.id, campaignId, product: campaign.product, copy: campaign.copy,
    channels: campaign.channels, current: review.product.current, costs,
    marketing, target, scopes: [...metadata.grantedScopes].sort(), permissionMode: settings.permissionMode,
    consent: settings.consent ?? null, asset, creative, day: new Date().toISOString().slice(0, 10) };
  // The source must be ordinary JSON; no unbound getters or omitted values.
  const sourceRevision = canonicalDigest(source);
  return { schema: META_PUBLICATION_SCHEMA, dispatchIdentitySchema: META_PUBLICATION_DISPATCH_SCHEMA, workspaceId: state.workspace.id, campaignId,
    operation: 'instagram_publish', target, caption: campaign.copy.longCaption, asset, sourceRevision,
    logicalKey: canonicalDigest({ workspaceId: state.workspace.id, campaignId, target: { connectionId: target.connectionId,
      account: target.account, pageId: target.pageId, instagramId: target.instagramId } }),
    day: source.day, dailyOrganicLimit: marketing.dailyOrganicLimit, publishingEnabled: false };
}
// Opaque capabilities are issued only by trusted local composition, never HTTP.
// The private owned bytes cannot be mutated through the caller's original view.
export function createMetaPublicationLocalAsset(state, campaignId, selection, session, bytes, mediaType) {
  const source = selectedSource(state, campaignId, selection, session);
  const snapshot = snapshotPublicationImage(bytes, mediaType);
  const manifest = { ...snapshot.descriptor, context: assetContext(state.workspace.id, campaignId, source.asset) };
  const capability = Object.freeze(Object.create(null));
  localAssets.set(capability, { bytes: snapshot.bytes, manifest });
  return capability;
}
export function previewMetaMarketingPublication(state, campaignId, selection, session, { assetSnapshot = null } = {}) {
  const source = selectedSource(state, campaignId, selection, session);
  return assetSnapshot === null ? source : selectedSource(state, campaignId, selection, session,
    localManifest(assetSnapshot, assetContext(state.workspace.id, campaignId, source.asset)));
}
const inputFor = proposal => ({ operation: 'instagram_publish', pageId: proposal.target.pageId,
  instagramId: proposal.target.instagramId, caption: proposal.caption, imageUrl: proposal.asset.url });
export function metaPublicationInputDigest(input) {
  exact(input, ['operation', 'pageId', 'instagramId', 'caption', 'imageUrl']);
  // Preserve the original producer digest bytes even after JSONB reorders keys.
  return digest({ operation: input.operation, pageId: input.pageId, instagramId: input.instagramId,
    caption: input.caption, imageUrl: input.imageUrl });
}
const requestIdValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(value);
export function isMetaMarketingPublication(state, write) {
  return Object.hasOwn(write, 'marketingPublication') || (state.approvals || []).some(row => row.id === write.approvalId
    && Object.hasOwn(row.payload || {}, 'marketingPublicationDigest'));
}
export function assertMetaPublicationBinding(state, write) {
  contentWriteSnapshot(write);
  const binding = write.marketingPublication;
  if (!binding || binding.schema !== META_PUBLICATION_SCHEMA || binding.workspaceId !== manualContentWorkspace(state)
    || write.provider !== 'meta' || write.requiresApproval !== true || write.requestedBy !== binding.requestedBy
    || write.connectionId !== binding.target?.connectionId || write.account !== binding.target?.account
    || metaPublicationInputDigest(write.input) !== write.digest || canonicalDigest(inputFor(binding)) !== canonicalDigest(write.input)
    || Object.hasOwn(binding, 'dispatchIdentitySchema') && binding.dispatchIdentitySchema !== META_PUBLICATION_DISPATCH_SCHEMA
    || Object.hasOwn(binding, 'receiptContract') && binding.receiptContract !== META_RECEIPT_CONTRACT
    || (state.connectionWrites || []).filter(row => row.id === write.id || row.requestId === write.requestId).length !== 1) throw fail('META_PUBLICATION_BINDING_CHANGED');
  assertManualContentScope(write, state.workspace.id);
  const { digest: storedDigest, ...body } = binding;
  if (canonicalDigest(body) !== storedDigest) throw fail('META_PUBLICATION_BINDING_CHANGED');
  if (Object.hasOwn(binding.asset, 'localSnapshot')) validateLocalSnapshot(binding.asset.localSnapshot,
    assetContext(state.workspace.id, binding.campaignId, binding.asset));
  const approval = unique(state.approvals, row => row.id === write.approvalId, 'APPROVAL_REQUIRED');
  assertManualContentScope(approval, state.workspace.id);
  if (approval.type !== 'social_commerce_publish' || approval.payload?.connectionWriteId !== write.id
    || approval.payload.digest !== write.digest || approval.payload.marketingPublicationDigest !== binding.digest
    || canonicalDigest(approval.payload.publication) !== canonicalDigest(binding)) throw fail('META_PUBLICATION_BINDING_CHANGED');
  return binding;
}
export function assertMetaPublicationSource(state, write, session) {
  const binding = assertMetaPublicationBinding(state, write);
  owner(state, session);
  if (session.userId !== binding.requestedBy || session.sessionVersion !== binding.actorSessionVersion) throw fail('WRITE_ACTOR_CHANGED', 403);
  const current = selectedSource(state, binding.campaignId, { pageId: binding.target.pageId,
    creativeRequestId: binding.asset.creativeRequestId, assetUrl: binding.asset.url }, session, binding.asset.localSnapshot ?? null);
  if (current.sourceRevision !== binding.sourceRevision || current.logicalKey !== binding.logicalKey) throw fail('META_PUBLICATION_SOURCE_CHANGED');
  const duplicates = (state.connectionWrites || []).filter(row => row.marketingPublication?.logicalKey === binding.logicalKey);
  if (duplicates.length !== 1 || duplicates[0].id !== write.id) throw fail('META_PUBLICATION_DUPLICATE');
  const today = (state.connectionWrites || []).filter(row => row.marketingPublication?.day === current.day);
  if (today.length > current.dailyOrganicLimit) throw fail('META_PUBLICATION_DAILY_LIMIT');
}
export function readMetaMarketingPublication(state, campaignId, requestId, session) {
  owner(state, session);
  if (!requestIdValid(requestId)) throw fail('WRITE_REQUEST_ID_REQUIRED', 400);
  const rows = (state.connectionWrites || []).filter(row => row.requestId === requestId);
  if (!rows.length) return { found: false, requestId, publishingEnabled: false, executedExternally: false };
  if (rows.length !== 1) throw fail('WRITE_CONFLICT');
  const write = rows[0], binding = assertMetaPublicationBinding(state, write);
  if (binding.campaignId !== campaignId || binding.requestedBy !== session.userId
    || binding.actorSessionVersion !== session.sessionVersion) throw fail('WRITE_CONFLICT');
  const receipt = write.marketingPublicationReceipt;
  let receiptStatus = 'absent';
  if (receipt) {
    const { digest: stored, ...body } = receipt;
    const approval = state.approvals.find(row => row.id === write.approvalId);
    if (stored !== canonicalDigest(body) || receipt.schema !== receiptSchema || receipt.workspaceId !== state.workspace.id
      || receipt.writeId !== write.id || receipt.requestId !== requestId || receipt.publicationDigest !== binding.digest
      || receipt.claimId !== write.dispatchClaim?.id || receipt.claimDigest !== digest(contentWriteSnapshot(write.dispatchClaim))
      || receipt.approvalDecision !== digest(contentApprovalDecisionSnapshot(approval))
      || receipt.resultId !== write.result?.externalId || !numeric(receipt.resultId) || receipt.simulated !== true
      || write.result?.simulated !== true || receipt.executedExternally !== false || !numeric(receipt.containerId)
      || receipt.containerId !== write.providerState?.containerId
      || receipt.containerId !== write.dispatchClaim?.phases?.instagram_container?.resultId
      || canonicalDigest(receipt.localAssetSnapshot ?? null) !== canonicalDigest(binding.asset.localSnapshot ?? null)
      || write.status !== 'completed') throw fail('META_PUBLICATION_RECEIPT_INVALID');
    receiptStatus = 'simulated_confirmed';
  }
  let sourceStatus = 'current';
  try { assertMetaPublicationSource(state, write, session); } catch { sourceStatus = 'changed_or_unavailable'; }
  return { schema: META_PUBLICATION_SCHEMA, found: true, requestId, writeId: write.id, approvalId: write.approvalId,
    status: write.status, publication: structuredClone(binding), sourceStatus, receiptStatus,
    receipt: receipt ? structuredClone(receipt) : null, containerId: write.providerState?.containerId ?? null,
    outcome: receipt ? 'simulated_confirmed' : ['executing', 'uncertain'].includes(write.status) ? 'unresolved_do_not_resend'
      : write.status === 'processing' ? 'container_recorded_observation_pending' : 'not_confirmed',
    publishingEnabled: false, executedExternally: false, replayPermitted: false };
}
// Trusted local simulation composition only. Production callers, including HTTP
// and enabled legacy producer stages, have no issuer. Closing creation prevents
// older executors from receiving a new record they would treat as publishable.
export function createMetaPublicationPreparationSimulation(state, campaignId, body, session, { assetSnapshot = null, protectedReceipts = false } = {}) {
  owner(state, session);
  if (typeof protectedReceipts !== 'boolean') throw fail('META_SIMULATION_INVALID');
  const localSnapshot = assetSnapshot === null ? null
    : localManifest(assetSnapshot, assetContext(state.workspace.id, campaignId, body.asset));
  if (canonicalDigest(body.asset?.localSnapshot ?? null) !== canonicalDigest(localSnapshot)) throw fail('META_PUBLICATION_LOCAL_ASSET_INVALID');
  const capability = Object.freeze(Object.create(null));
  preparationSimulations.set(capability, { workspaceId: state.workspace.id, campaignId,
    userId: session.userId, sessionVersion: session.sessionVersion, requestDigest: canonicalDigest(body), localSnapshot, protectedReceipts });
  return capability;
}
export async function prepareMetaMarketingPublication(state, campaignId, body, session,
  { persist, durableStore = false, preparationSimulation = null } = {}) {
  owner(state, session);
  exact(body, ['requestId', 'sourceRevision', 'target', 'caption', 'asset']);
  if (!requestIdValid(body.requestId)) throw fail('WRITE_REQUEST_ID_REQUIRED', 400);
  const simulation = preparationSimulations.get(preparationSimulation);
  if (!simulation || simulation.workspaceId !== state.workspace.id || simulation.campaignId !== campaignId
    || simulation.userId !== session.userId || simulation.sessionVersion !== session.sessionVersion
    || simulation.requestDigest !== canonicalDigest(body)) throw fail('META_PUBLICATION_PREPARATION_CLOSED');
  const existing = (state.connectionWrites || []).filter(row => row.requestId === body.requestId);
  if (existing.length) {
    const history = readMetaMarketingPublication(state, campaignId, body.requestId, session);
    if (history.publication.requestDigest !== canonicalDigest(body)) throw fail('WRITE_CONFLICT');
    return history; // A lost save ACK is reconciled, never recreated or reapproved.
  }
  if (!durableStore || typeof persist !== 'function' || !text(state._revision)) throw fail('WRITE_DURABLE_STORE_REQUIRED');
  const current = selectedSource(state, campaignId, { pageId: body.target?.pageId,
    creativeRequestId: body.asset?.creativeRequestId, assetUrl: body.asset?.url }, session, simulation.localSnapshot);
  if (body.sourceRevision !== current.sourceRevision || body.caption !== current.caption
    || canonicalDigest(body.target) !== canonicalDigest(current.target) || canonicalDigest(body.asset) !== canonicalDigest(current.asset)) throw fail('META_PUBLICATION_SOURCE_CHANGED');
  if ((state.connectionWrites || []).some(row => row.marketingPublication?.logicalKey === current.logicalKey)) throw fail('META_PUBLICATION_DUPLICATE');
  if ((state.connectionWrites || []).filter(row => row.marketingPublication?.day === current.day).length >= current.dailyOrganicLimit) throw fail('META_PUBLICATION_DAILY_LIMIT');
  const bindingBody = { ...current, requestedBy: session.userId, actorSessionVersion: session.sessionVersion, requestDigest: canonicalDigest(body),
    ...(simulation.protectedReceipts ? { receiptContract: META_RECEIPT_CONTRACT } : {}) };
  const binding = { ...bindingBody, digest: canonicalDigest(bindingBody) };
  const input = inputFor(binding);
  const write = { id: `write_${crypto.randomUUID()}`, requestId: body.requestId, provider: 'meta', input, digest: digest(input),
    connectionId: binding.target.connectionId, account: binding.target.account, requestedBy: session.userId,
    requiresApproval: true, status: 'pending_approval', createdAt: new Date().toISOString(), marketingPublication: binding };
  const approval = normalizeApprovalRequest({ type: 'social_commerce_publish', action: 'Review exact Instagram campaign proposal (publishing closed)',
    reason: `Instagram ${binding.target.instagramId}, Page ${binding.target.pageId}. Full exact caption and Canva asset reference are in this approval payload.`,
    expectedBenefit: 'Prepare a bounded organic publication; no publication or financial benefit is established.',
    risk: binding.asset.localSnapshot
      ? 'Copied local PNG snapshot bound; see its exact decoding evidence. Provider format, remote delivery and current provider authority remain unverified. Production publishing stays closed.'
      : 'Image URL/reference only; remote bytes and current provider authority remain unverified. Production publishing stays closed.',
    source: 'marketing-publication', payload: { connectionWriteId: write.id, digest: write.digest,
      marketingPublicationDigest: binding.digest, publication: structuredClone(binding) } }, session.userId);
  write.approvalId = approval.id;
  (state.connectionWrites ||= []).unshift(write); state.approvals.unshift(approval);
  addAudit(state, { type: 'marketing_publication_prepared', actor: session.userId,
    detail: { campaignId, writeId: write.id, approvalId: approval.id, digest: binding.digest, publishingEnabled: false } });
  const expectedWrite = contentWriteSnapshot(write), expectedApproval = contentWriteSnapshot(approval), previous = state._revision;
  const check = snapshot => {
    for (const currentState of snapshot && snapshot !== state ? [state, snapshot] : [state]) {
      const saved = unique(currentState.connectionWrites, row => row.id === write.id, 'WRITE_CONFLICT');
      const decision = unique(currentState.approvals, row => row.id === approval.id, 'WRITE_CONFLICT');
      if (contentWriteSnapshot(saved) !== expectedWrite || contentWriteSnapshot(decision) !== expectedApproval) throw fail('WRITE_REQUEST_CHANGED');
      assertMetaPublicationSource(currentState, saved, session);
    }
  };
  try {
    check();
    const saved = await persist({ ownedSnapshot: true, beforeCommit: check });
    check(saved);
    if (!saved || saved.workspace.id !== state.workspace.id || !text(saved._revision)
      || saved._revision === previous || state._revision !== saved._revision) throw fail('WRITE_CLAIM_ACK_INVALID');
  } catch { throw fail('META_PUBLICATION_SAVE_UNKNOWN', 503); }
  return readMetaMarketingPublication(state, campaignId, body.requestId, session);
}

export function assertMetaPublicationSimulation(state, write, capability, integrations) {
  const entry = simulations.get(capability);
  if (!entry || entry.integrations !== integrations || entry.workspaceId !== state.workspace.id || entry.writeId !== write.id
    || entry.bindingDigest !== write.marketingPublication?.digest) throw fail('META_PUBLICATION_PRODUCTION_CLOSED');
  const binding = assertMetaPublicationBinding(state, write);
  const manifest = entry.assetSnapshot === null ? null
    : localManifest(entry.assetSnapshot, assetContext(state.workspace.id, binding.campaignId, binding.asset));
  if (canonicalDigest(manifest) !== canonicalDigest(binding.asset.localSnapshot ?? null)) throw fail('META_PUBLICATION_LOCAL_ASSET_INVALID');
  return binding;
}
export function metaPublicationReceipt(state, write, decision, result) {
  if (!numeric(result?.externalId) || result.simulated !== true || !numeric(write.providerState?.containerId)
    || write.providerState.containerId !== write.dispatchClaim?.phases?.instagram_container?.resultId
    || !write.dispatchClaim?.phases?.instagram_publish || !write.dispatchClaim?.phases?.instagram_container) throw fail('META_PUBLICATION_RESULT_UNKNOWN');
  const body = { schema: receiptSchema, workspaceId: state.workspace.id, writeId: write.id, requestId: write.requestId,
    publicationDigest: write.marketingPublication.digest, claimId: write.dispatchClaim.id,
    claimDigest: digest(contentWriteSnapshot(write.dispatchClaim)), approvalDecision: digest(contentApprovalDecisionSnapshot(decision)),
    resultId: result.externalId, containerId: write.providerState.containerId, simulated: true, executedExternally: false,
    evidenceBasis: 'retained_application_state_not_protected_provider_evidence',
    ...(write.marketingPublication.asset.localSnapshot ? { localAssetSnapshot: structuredClone(write.marketingPublication.asset.localSnapshot) } : {}) };
  return { ...body, digest: canonicalDigest(body) };
}

// Trusted local composition only. This capability is tied to this fixed,
// network-free adapter. There is no HTTP/env issuer or caller-supplied transport.
// All outcomes, identifiers and credentials below are synthetic fixtures.
export function createMetaPublicationSimulation(state, write, options = {}, { assetSnapshot = null } = {}) {
  exact(options, Object.keys(options));
  if (Object.keys(options).some(key => !['containerStatus', 'loseResponsePhase', 'invalidResult'].includes(key))
    || options.containerStatus && !['IN_PROGRESS', 'FINISHED'].includes(options.containerStatus)
    || options.loseResponsePhase && !['instagram_container', 'instagram_publish'].includes(options.loseResponsePhase)
    || options.invalidResult !== undefined && typeof options.invalidResult !== 'boolean') throw fail('META_SIMULATION_INVALID');
  options = structuredClone(options);
  const binding = assertMetaPublicationBinding(state, write), calls = [];
  const manifest = assetSnapshot === null ? null
    : localManifest(assetSnapshot, assetContext(state.workspace.id, binding.campaignId, binding.asset));
  if (canonicalDigest(manifest) !== canonicalDigest(binding.asset.localSnapshot ?? null)) throw fail('META_PUBLICATION_LOCAL_ASSET_INVALID');
  const integrations = Object.freeze({
    connectorCredentials: async () => Object.freeze({ synthetic: true }),
    metaPermissions: async () => metaWriteScopes('instagram_publish'),
    metaAssets: async () => ({ pages: [{ id: binding.target.pageId, instagram: { id: binding.target.instagramId } }],
      pageTokens: { [binding.target.pageId]: 'synthetic-no-credential' } }),
    metaRequest: async (resource, _token, request = {}) => {
      if (request.method === 'POST') {
        const phase = request.phase;
        if (!['instagram_container', 'instagram_publish'].includes(phase)) throw fail('META_SIMULATION_INVALID');
        return dispatchConnectionMutation(request.dispatch, { provider: 'meta', phase, method: 'POST', path: resource,
          body: JSON.stringify(request.body) }, async () => {
          calls.push({ phase, resource, body: structuredClone(request.body),
            ...(manifest ? { localAssetSha256: manifest.sha256, localAssetByteLength: manifest.byteLength, providerDeliveryVerified: false } : {}) });
          if (options.loseResponsePhase === phase) throw fail('META_SIMULATED_RESPONSE_LOST');
          return phase === 'instagram_container' ? { id: '900000001' } : options.invalidResult ? { success: true } : { id: '900000002' };
        });
      }
      if (resource === `/${binding.target.instagramId}/content_publishing_limit`) return { data: [{ quota_usage: 0, config: { quota_total: 100 } }] };
      if (resource === '/900000001') return { status_code: options.containerStatus || 'FINISHED' };
      throw fail('META_SIMULATION_INVALID');
    },
    async executeMetaWrite(...args) {
      const result = await metaMethods.executeMetaWrite.apply(this, args);
      return result.pending ? result : { ...result, simulated: true };
    }
  });
  const capability = Object.freeze(Object.create(null));
  simulations.set(capability, { integrations, workspaceId: state.workspace.id, writeId: write.id, bindingDigest: binding.digest, assetSnapshot,
    publicationObserved: () => calls.some(call => call.phase === 'instagram_publish') && options.invalidResult !== true });
  return { capability, integrations, observations: () => structuredClone(calls) };
}

// Exact known-container observation only. It never calls the mutation adapter,
// saves state, changes approval, or manufactures a media ID from status_code.
// Synthetic observations live only in the original simulator process. A newly
// issued capability after restart cannot reconstruct a lost provider outcome.
export async function reconcileMetaPublicationSimulation(state, writeId, session, capability, readProtected) {
  owner(state, session);
  const write = unique(state.connectionWrites, row => row.id === writeId, 'WRITE_NOT_FOUND');
  const entry = simulations.get(capability);
  if (!entry || entry.workspaceId !== state.workspace.id || entry.writeId !== writeId
    || entry.bindingDigest !== write.marketingPublication?.digest || typeof readProtected !== 'function') throw fail('META_PUBLICATION_PRODUCTION_CLOSED');
  const checkRetained = () => {
    owner(state, session);
    const binding = assertMetaPublicationBinding(state, write);
    if (binding.requestedBy !== session.userId || binding.actorSessionVersion !== session.sessionVersion) throw fail('WRITE_ACTOR_CHANGED', 403);
  };
  checkRetained();
  const pinned = contentWriteSnapshot(metaReceiptProjection(state, writeId));
  const proof = await readProtected();
  checkRetained();
  const projection = protectedMetaReceiptProjection(proof, state.workspace.id, writeId);
  if (contentWriteSnapshot(projection) !== pinned || contentWriteSnapshot(metaReceiptProjection(state, writeId)) !== pinned) throw fail('META_PUBLICATION_BINDING_CHANGED');
  const containerId = projection.write.providerState?.containerId;
  const admitted = projection.write.dispatchClaim?.phases;
  const observed = numeric(containerId) && admitted?.instagram_container?.resultId === containerId
    && admitted.instagram_publish && entry.publicationObserved();
  return Object.freeze({ schema: 'runvara-meta-synthetic-reconciliation/v1', writeId,
    containerId: observed ? containerId : null, statusCode: observed ? 'PUBLISHED' : null,
    outcome: observed ? 'simulated_container_published_result_id_unknown' : 'unresolved_do_not_resend',
    resultId: null, evidenceBasis: 'protected_synthetic_admission_and_process_local_container_observation',
    simulated: true, executedExternally: false, replayPermitted: false, publishingEnabled: false });
}
