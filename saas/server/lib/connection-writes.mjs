import crypto from 'node:crypto';
import { connectionError, connectionSettings } from './connection-centre.mjs';
import { normalizeApprovalRequest } from './operations.mjs';
import { addAudit, recordWork } from './events.mjs';
import { createConnectionDispatch, connectionDispatchCount } from './connection-dispatch.mjs';
import { META_WRITES, prepareMetaWrite, requireMetaScopes, metaWriteScopes } from './meta-commerce.mjs';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function previewShopifyTagTest(state, productId, integrations) {
  const product = state.products?.find(item => item.id === productId && item.provider === 'shopify');
  if (!product || !/^gid:\/\/shopify\/Product\/\d+$/.test(product.id)) throw connectionError('Choose a product in this workspace.', 'PRODUCT_NOT_FOUND', 404);
  if (connectionSettings(state, 'shopify').disconnected) throw connectionError('Reconnect Shopify first.', 'CONNECTION_DISCONNECTED', 409);
  const config = integrations.shopifyConfig(state);
  if (config.mode === 'oauth') config.accessToken = (await integrations.connectorCredentials(state, 'shopify')).accessToken;
  const result = await integrations.shopifyGraphql('query RunvaraTagAcceptancePreview($id: ID!) { product(id: $id) { id title tags } }', { id: product.id }, config);
  if (result?.product?.id !== product.id || !Array.isArray(result.product.tags)) throw connectionError('Shopify could not confirm current tags.', 'WRITE_BASELINE_UNAVAILABLE', 422);
  const tag = `runvara-beta-check-${crypto.randomBytes(6).toString('hex')}`;
  const connection = state.connections?.find(item => item.provider === 'shopify');
  return { resource: { id: product.id, title: result.product.title, store: config.domain }, checkedAt: new Date().toISOString(),
    before: result.product.tags, proposed: [...result.product.tags, tag],
    request: { operation: 'product_tags_add', productId: product.id, tags: [tag], expectedTags: result.product.tags },
    permissionMode: connectionSettings(state, 'shopify').permissionMode,
    writeScopeGranted: Boolean(connection?.metadata?.grantedScopes?.includes('write_products')),
    approval: `Approve adding only the tag ${tag} to ${result.product.title} (${product.id}) in ${config.domain}.`,
    rollback: { operation: 'product_tags_remove', productId: product.id, tags: [tag], expectedTags: [...result.product.tags, tag] },
    notice: 'No write or permission change has occurred. Tags may affect storefront collections or external workflows. The inverse removal needs its own exact approval.' };
}
export function proposeConnectionWrite(state, provider, body, actor) {
  const settings = connectionSettings(state, provider);
  if (settings.disconnected || settings.permissionMode === 'read_only') throw connectionError('This connection is read-only. The owner must authorise write access first.', 'WRITE_NOT_AUTHORISED', 403);
  if (!((provider === 'shopify' && ['product_content', 'internal_note', 'product_tags_add', 'product_tags_remove'].includes(body.operation)) || (provider === 'meta' && META_WRITES.includes(body.operation)))) throw connectionError('Runvara does not support this write action. No change was made.', 'WRITE_UNSUPPORTED', 422);
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(body.requestId || '')) throw connectionError('A unique request reference is required.', 'WRITE_REQUEST_ID_REQUIRED');
  state.connectionWrites ||= [];
  const existing = state.connectionWrites.find(item => item.requestId === body.requestId);
  const product = (state.products || []).find(item => item.id === body.productId && item.provider === 'shopify');
  if (provider === 'shopify' && (!product || !/^gid:\/\/shopify\/Product\/\d+$/.test(product.id))) throw connectionError('Choose a Shopify product in this workspace.', 'PRODUCT_NOT_FOUND', 404);
  const input = provider === 'meta' ? prepareMetaWrite(state, body) : { productId: product.id, operation: body.operation };
  if (provider === 'meta') { /* Exact supported input was validated above. */ } else if (body.operation === 'internal_note') {
    if (typeof body.note !== 'string' || !body.note.trim() || body.note.length > 500) throw connectionError('Enter an internal note of up to 500 characters.');
    input.note = body.note.trim();
  } else if (body.operation.startsWith('product_tags_')) {
    const tags = typeof body.tags === 'string' ? body.tags.split(',').map(value => value.trim()).filter(Boolean) : body.tags;
    if (!Array.isArray(tags) || !tags.length || tags.length > 50 || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 255 || /[\r\n,]/.test(tag))) throw connectionError('Enter 1–50 tags, separated by commas, up to 255 characters each.');
    input.tags = [...new Set(tags.map(tag => tag.trim()))];
    if (body.expectedTags !== undefined) {
      if (!Array.isArray(body.expectedTags) || body.expectedTags.length > 250 || body.expectedTags.some(tag => typeof tag !== 'string' || tag.length > 255)) throw connectionError('Invalid tag baseline.');
      input.expectedTags = [...body.expectedTags].sort();
    }
  } else {
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200 || typeof body.description !== 'string' || body.description.length > 10000) throw connectionError('Enter a product title and a description of up to 10,000 characters.');
    input.title = body.title.trim(); input.description = body.description;
  }
  if (existing) {
    if (existing.provider !== provider || existing.digest !== digest(input)) throw connectionError('This request reference was already used for a different change.', 'WRITE_CONFLICT', 409);
    return existing;
  }
  const connection = state.connections?.find(item => item.provider === provider && item.encryptedCredentials);
  if (provider === 'meta') requireMetaScopes(connection?.metadata?.grantedScopes, metaWriteScopes(input.operation));
  if (provider === 'shopify' && !connection?.metadata?.grantedScopes?.includes('write_products')) throw connectionError('Shopify has not granted product write access. Reconnect with write access and test the connection first.', 'WRITE_SCOPE_REQUIRED', 409);
  const requiresApproval = provider === 'meta' || settings.permissionMode !== 'automatic' || body.operation !== 'internal_note';
  if (settings.permissionMode === 'automatic' && (!settings.consent || settings.consent.mode !== 'automatic')) throw connectionError('The owner must explicitly authorise automatic writes.', 'OWNER_APPROVAL_REQUIRED', 403);
  const write = { id: `write_${crypto.randomUUID()}`, requestId: body.requestId, provider, input, digest: digest(input), connectionId: connection.id, account: provider === 'meta' ? connection.metadata.accountId : connection.metadata.shopDomain, requestedBy: actor,
    requiresApproval, status: requiresApproval ? 'pending_approval' : 'ready', createdAt: new Date().toISOString() };
  if (requiresApproval) {
    const approval = normalizeApprovalRequest({ type: provider === 'meta' ? 'risky_marketplace_action' : body.operation !== 'internal_note' ? 'customer_facing_publish' : 'integration_change',
      action: body.operation.startsWith('product_tags_') ? `${body.operation === 'product_tags_add' ? 'Add' : 'Remove'} Shopify tags: ${product.title}` : provider === 'meta' ? `Meta: ${input.operation.replaceAll('_', ' ')}` : body.operation === 'product_content' ? `Update Shopify content: ${product.title}` : `Save internal Shopify note: ${product.title}`,
      reason: body.operation.startsWith('product_tags_') ? `Exact tags: ${input.tags.join(', ')}. Tags may affect collections and automated workflows. An inverse change needs a new approval.` : provider === 'meta' ? JSON.stringify(input).slice(0,1000) : body.operation === 'product_content' ? `Proposed title: ${input.title}\nDescription: ${input.description}`.slice(0, 1000) : input.note,
      expectedBenefit: 'Apply the exact change reviewed in the Connection Centre.', risk: 'medium', source: 'connection-centre',
      evidence: [{ type: provider === 'meta' ? 'meta_asset' : 'product', id: input.productId || input.catalogId || input.pageId, detail: 'The full proposed change is available in the channel details panel.' }],
      payload: { connectionWriteId: write.id, digest: write.digest } }, actor);
    state.approvals.unshift(approval); write.approvalId = approval.id;
  }
  state.connectionWrites.unshift(write);
  addAudit(state, { type: 'connection_write_requested', actor, detail: { provider, writeId: write.id, operation: input.operation, requiresApproval, digest: write.digest } });
  return write;
}
function immutable(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) immutable(child); Object.freeze(value); }
  return value;
}
function metaMutationRequest(input, phase, containerId) {
  let path, body;
  if (phase === 'instagram_container') {
    path = `/${input.instagramId}/media`; body = { image_url: input.imageUrl, caption: input.caption };
  } else if (phase === 'instagram_publish') {
    path = `/${input.instagramId}/media_publish`; body = { creation_id: containerId };
  } else if (input.operation.startsWith('catalog_')) {
    path = input.operation === 'catalog_product_create' ? `/${input.catalogId}/products` : `/${input.productId}`;
    body = input.operation === 'catalog_visibility' ? { visibility: input.visibility }
      : input.operation === 'catalog_inventory' ? { inventory: input.quantity, availability: input.availability }
      : { name: input.name, description: input.description };
    if (input.operation === 'catalog_product_create') Object.assign(body, { retailer_id: input.retailerId, brand: input.brand,
      category: input.category, url: input.url, image_url: input.imageUrl, price: input.priceMinor, currency: input.currency,
      availability: input.availability, condition: input.condition, visibility: input.visibility });
  } else {
    path = input.operation === 'facebook_publish' ? `/${input.pageId}/feed` : `/${input.postId}`;
    body = { message: input.message, ...(input.link ? { link: input.link } : {}) };
  }
  return { provider: 'meta', phase, method: 'POST', path, body: JSON.stringify(body) };
}
function writeIdentity(write) {
  return { id: write.id, requestId: write.requestId, provider: write.provider, input: write.input, digest: write.digest,
    connectionId: write.connectionId, account: write.account, requestedBy: write.requestedBy,
    requiresApproval: write.requiresApproval, approvalId: write.approvalId || null };
}
const configBinding = config => ({ domain: config.domain, workspaceId: config.workspaceId, mode: config.mode, apiVersion: config.apiVersion,
  accessToken: config.accessToken, clientId: config.clientId, clientSecret: config.clientSecret });
const blocked = (code, message = 'Connection-write authority changed. Review a new exact request.') =>
  Object.assign(connectionError(message, code, 409), { definitive: true });
function scope(value, workspaceId, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 5) throw blocked('WRITE_SCOPE_CHANGED');
  for (const key of ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id', 'workspace', 'tenant']) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field && !(key in value)) continue;
    if (!field || !Object.hasOwn(field, 'value')) throw blocked('WRITE_SCOPE_CHANGED');
    const marker = field.value;
    if (['workspace', 'tenant'].includes(key) && marker && typeof marker === 'object' && !Array.isArray(marker)) {
      const id = Object.getOwnPropertyDescriptor(marker, 'id');
      if (!id || !Object.hasOwn(id, 'value') || id.value !== workspaceId) throw blocked('WRITE_SCOPE_CHANGED');
      scope(marker, workspaceId, depth + 1);
    } else if (marker !== workspaceId) throw blocked('WRITE_SCOPE_CHANGED');
  }
}
function scopedRecord(value, workspaceId, depth = 0) {
  if (depth > 32) throw blocked('WRITE_SCOPE_CHANGED');
  if (value === null || typeof value !== 'object') return;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw blocked('WRITE_SCOPE_CHANGED');
  if (!Array.isArray(value)) scope(value, workspaceId);
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Object.values(fields).some(field => !Object.hasOwn(field, 'value'))) throw blocked('WRITE_SCOPE_CHANGED');
  for (const field of Object.values(fields)) scopedRecord(field.value, workspaceId, depth + 1);
}
function admitExecution(state, commit = false) {
  const now = Date.now(), previous = Object.hasOwn(state, 'connectionDispatchAdmissions') ? state.connectionDispatchAdmissions : [];
  if (!Array.isArray(previous) || previous.length > 10 || previous.some(at => !Number.isSafeInteger(at) || at < 0 || at > now)) throw blocked('WRITE_ADMISSION_UNAVAILABLE');
  const recent = previous.filter(at => at > now - 3600000);
  if (recent.length >= 10) throw connectionError('Connection execution frequency limit reached. Try again after the current hour window.', 'WRITE_EXECUTION_RATE_LIMITED', 429);
  if (commit) state.connectionDispatchAdmissions = Object.freeze([...recent, now]);
}
function authority(state, write, actor, actorSession) {
  const actors = state.users?.filter(row => row.id === actor) || [];
  const user = actors[0];
  if (actors.length !== 1 || !user || user.active === false || user.role !== 'owner' || user.passwordChangeRequired
    || actorSession.workspaceId !== state.workspace?.id || actorSession.userId !== actor
    || Number(user.sessionVersion ?? 1) !== actorSession.sessionVersion) throw blocked('WRITE_ACTOR_CHANGED');
  scope(state, actorSession.workspaceId);
  for (const row of [state.workspace, user, write]) scopedRecord(row, actorSession.workspaceId);
  if (state.connectionSettings) scope(state.connectionSettings, actorSession.workspaceId);
  if (write.dispatchClaim) { scope(write.dispatchClaim, actorSession.workspaceId); for (const phase of Object.values(write.dispatchClaim.phases || {})) scope(phase, actorSession.workspaceId); }
  const settings = connectionSettings(state, write.provider);
  scopedRecord(settings, actorSession.workspaceId);
  if (settings.disconnected || settings.permissionMode === 'read_only') throw blocked('WRITE_NOT_AUTHORISED');
  const matches = state.connections?.filter(row => row.id === write.connectionId && row.provider === write.provider) || [];
  const connection = matches[0];
  if (matches.length !== 1 || !connection.encryptedCredentials
    || (write.provider === 'meta' ? connection.metadata?.accountId : connection.metadata?.shopDomain) !== write.account) throw blocked('WRITE_CONNECTION_CHANGED');
  scopedRecord(connection, actorSession.workspaceId);
  if (write.provider === 'meta') requireMetaScopes(connection.metadata?.grantedScopes, metaWriteScopes(write.input.operation));
  else if (!connection.metadata?.grantedScopes?.includes('write_products')) throw blocked('WRITE_SCOPE_REQUIRED');
  const approvals = state.approvals?.filter(row => row.id === write.approvalId) || [];
  const approval = approvals[0];
  const needsApproval = write.requiresApproval || settings.permissionMode !== 'automatic' || write.input.operation !== 'internal_note';
  if (needsApproval) {
    const owners = state.users?.filter(row => row.id === approval?.decidedBy) || [];
    const owner = owners[0];
    if (approval) scopedRecord(approval, actorSession.workspaceId);
    if (owner) scopedRecord(owner, actorSession.workspaceId);
    if (approvals.length !== 1 || approval.status !== 'approved' || (approval.revision || 1) !== 1
      || approval.payload?.digest !== write.digest || approval.payload?.connectionWriteId !== write.id
      || owners.length !== 1 || !owner || owner.active === false || owner.role !== 'owner') throw blocked('APPROVAL_REQUIRED');
  } else {
    const owners = state.users?.filter(row => row.id === settings.consent?.actor) || [];
    const owner = owners[0];
    if (owner) scopedRecord(owner, actorSession.workspaceId);
    if (owners.length !== 1 || settings.consent?.mode !== 'automatic' || !owner || owner.active === false || owner.role !== 'owner') throw blocked('OWNER_APPROVAL_REQUIRED');
  }
  return digest({ actor, sessionVersion: user.sessionVersion || 1, connectionId: connection.id, account: write.account,
    credentials: digest(connection.encryptedCredentials), scopes: [...(connection.metadata?.grantedScopes || [])].sort(),
    permissionMode: settings.permissionMode, consent: settings.consent || null,
    ...(write.provider === 'meta' ? { pages: settings.metaPageIds || [], catalogs: settings.metaCatalogIds || [] } : {}),
    approval: needsApproval ? { id: approval.id, revision: approval.revision || 1, decidedBy: approval.decidedBy,
      decidedAt: approval.decidedAt, payload: approval.payload } : null });
}

export async function executeConnectionWrite(state, writeId, actor, integrations, persistClaim, { loadFreshState, durableStore = false, actorSession: authenticatedSession } = {}) {
  const write = state.connectionWrites?.find(item => item.id === writeId);
  if (!write) throw connectionError('Write request not found in this workspace.', 'WRITE_NOT_FOUND', 404);
  if (write.status === 'completed') return write;
  // A crash after sending a write leaves an uncertain result: never replay it.
  if (!['pending_approval', 'ready', 'processing'].includes(write.status)) throw connectionError('This change already ran or its result needs checking in the channel. It will not be sent again.', 'WRITE_ALREADY_ATTEMPTED', 409);
  if (durableStore !== true || typeof loadFreshState !== 'function' || typeof persistClaim !== 'function'
    || typeof state._revision !== 'string' || !state._revision) throw blocked('WRITE_DURABLE_STORE_REQUIRED');
  const actorSession = Object.freeze({ workspaceId: authenticatedSession?.workspaceId, userId: authenticatedSession?.userId,
    sessionVersion: authenticatedSession?.sessionVersion });
  if (actorSession.workspaceId !== state.workspace?.id || actorSession.userId !== actor
    || !Number.isSafeInteger(actorSession.sessionVersion) || actorSession.sessionVersion < 1) throw blocked('WRITE_ACTOR_CHANGED');
  const authorityDigest = authority(state, write, actor, actorSession);
  admitExecution(state);
  let admissionDigest = digest(state.connectionDispatchAdmissions ?? []);
  const settings = connectionSettings(state, write.provider);
  if (settings.disconnected || settings.permissionMode === 'read_only') throw connectionError('Write permission has been removed.', 'WRITE_NOT_AUTHORISED', 403);
  const connection = state.connections?.find(item => item.id === write.connectionId && item.provider === write.provider);
  if (!connection || (write.provider === 'meta' ? connection.metadata?.accountId : connection.metadata?.shopDomain) !== write.account) throw connectionError('The store connection changed. Create a new request.', 'WRITE_CONNECTION_CHANGED', 409);
  if (write.provider === 'meta') requireMetaScopes(connection.metadata?.grantedScopes, metaWriteScopes(write.input.operation));
  if (write.provider === 'shopify' && !connection.metadata?.grantedScopes?.includes('write_products')) throw connectionError('Shopify write access is missing.', 'WRITE_SCOPE_REQUIRED', 409);
  if (write.digest !== digest(write.input)) throw connectionError('The proposed change was modified. Create a new request.', 'WRITE_CONFLICT', 409);
  const approval = state.approvals?.find(item => item.id === write.approvalId);
  if (write.requiresApproval || settings.permissionMode !== 'automatic' || write.input.operation !== 'internal_note') {
    if (!approval || approval.status !== 'approved' || approval.payload?.digest !== write.digest || approval.payload?.connectionWriteId !== write.id || (approval.revision || 1) !== 1) throw connectionError('The owner must approve this exact change before it can run.', 'APPROVAL_REQUIRED', 409);
  } else if (settings.consent?.mode !== 'automatic') throw connectionError('Automatic writes need explicit owner consent.', 'OWNER_APPROVAL_REQUIRED', 403);
  const initialStatus = write.status;
  let containerId = write.providerState?.containerId || null;
  const recordedContainer = write.dispatchClaim?.phases?.instagram_container?.resultId;
  if (recordedContainer && recordedContainer !== containerId) throw blocked('WRITE_REQUEST_CHANGED');
  const credentialIdentity = digest(connection.encryptedCredentials);
  const preparedInput = immutable(structuredClone(write.input));
  const identity = digest(writeIdentity(write));
  const workspaceId = state.workspace?.id;
  const config = write.provider === 'shopify' ? { ...integrations.shopifyConfig(state), connection: undefined } : {};
  const metaCredentials = write.provider === 'meta' ? immutable(structuredClone(await integrations.connectorCredentials(state, 'meta'))) : null;
  if (config.mode === 'oauth') config.accessToken = (await integrations.connectorCredentials(state, 'shopify')).accessToken;
  Object.freeze(config);
  if (write.input.expectedTags) {
    const current = await integrations.shopifyGraphql('query RunvaraTagAcceptancePreview($id: ID!) { product(id: $id) { id tags } }', { id: write.input.productId }, config);
    if (current?.product?.id !== write.input.productId || !Array.isArray(current.product.tags) || JSON.stringify([...current.product.tags].sort()) !== JSON.stringify(write.input.expectedTags)) throw connectionError('Product tags changed since review. Prepare a fresh approval.', 'WRITE_BASELINE_CHANGED', 409);
  }
  if (write.status !== initialStatus) throw blocked('WRITE_ALREADY_ATTEMPTED');
  if (digest(connection.encryptedCredentials) !== credentialIdentity) throw blocked('WRITE_CONNECTION_CHANGED', 'The connection credentials changed during preparation. Refresh the connection before reviewing this write.');
  if (write.provider === 'shopify' && config.domain !== write.account) throw blocked('WRITE_CONNECTION_CHANGED');
  const configDigest = write.provider === 'shopify' ? digest(configBinding(config)) : null;
  const retainedCheck = () => {
    if (digest(state.connectionDispatchAdmissions ?? []) !== admissionDigest
      || state.workspace?.id !== workspaceId || !state.connectionWrites?.includes(write)
      || state.connectionWrites.filter(row => row.id === writeId).length !== 1
      || digest(writeIdentity(write)) !== identity) throw blocked('WRITE_CLAIM_CHANGED');
  };
  const localCheck = () => {
    retainedCheck();
    if ((write.providerState?.containerId || null) !== containerId) throw blocked('WRITE_REQUEST_CHANGED');
    if (state.workspace?.id !== workspaceId || state.connectionWrites?.filter(row => row.id === writeId).length !== 1
      || !state.connectionWrites.includes(write) || digest(writeIdentity(write)) !== identity
      || digest(write.input) !== write.digest || authority(state, write, actor, actorSession) !== authorityDigest) throw blocked('WRITE_AUTHORITY_CHANGED');
    if (write.provider === 'shopify') {
      const current = integrations.shopifyConfig(state);
      if (digest(configBinding(current)) !== configDigest) throw blocked('WRITE_CONNECTION_CHANGED');
    }
  };
  const saveExact = async () => {
    localCheck();
    const previous = state._revision, expected = digest(write);
    const saved = await persistClaim();
    localCheck();
    const rows = saved?.connectionWrites?.filter(row => row.id === writeId) || [];
    if (typeof state._revision !== 'string' || state._revision === previous || saved?.workspace?.id !== workspaceId
      || saved?._revision !== state._revision || rows.length !== 1 || digest(rows[0]) !== expected
      || digest(write) !== expected || digest(saved.connectionDispatchAdmissions ?? []) !== admissionDigest
      || authority(saved, rows[0], actor, actorSession) !== authorityDigest) throw blocked('WRITE_CLAIM_ACK_INVALID');
  };
  const freshCheck = async () => {
    localCheck();
    const expected = digest(write), revision = state._revision;
    const needsApproval = write.requiresApproval || settings.permissionMode !== 'automatic' || write.input.operation !== 'internal_note';
    const approverId = needsApproval ? approval.decidedBy : settings.consent.actor;
    const fresh = await loadFreshState({ revision, provider: write.provider, writeId, connectionId: write.connectionId, actorId: actor,
      approverId, approvalId: needsApproval ? approval.id : null, writeIndex: state.connectionWrites.indexOf(write),
      connectionIndex: state.connections.findIndex(row => row.id === write.connectionId && row.provider === write.provider),
      actorIndex: state.users.findIndex(row => row.id === actor), approverIndex: state.users.findIndex(row => row.id === approverId),
      approvalIndex: needsApproval ? state.approvals.indexOf(approval) : null });
    localCheck();
    const rows = fresh?.connectionWrites?.filter(row => row.id === writeId) || [];
    if (fresh?.workspace?.id !== workspaceId || fresh?._revision !== revision || state._revision !== revision
      || rows.length !== 1 || digest(rows[0]) !== expected || digest(write) !== expected
      || digest(writeIdentity(rows[0])) !== identity || authority(fresh, rows[0], actor, actorSession) !== authorityDigest) throw blocked('WRITE_AUTHORITY_CHANGED');
    if (write.provider === 'shopify' && digest(configBinding(integrations.shopifyConfig(fresh))) !== configDigest) throw blocked('WRITE_CONNECTION_CHANGED');
  };
  localCheck();
  if (write.dispatchClaim && (write.dispatchClaim.identity !== identity || write.dispatchClaim.authority !== authorityDigest
    || write.dispatchClaim.workspaceId !== workspaceId)) throw blocked('WRITE_CLAIM_CHANGED');
  write.dispatchClaim ||= { id: `write_claim_${crypto.randomUUID()}`, workspaceId, identity, authority: authorityDigest, phases: {} };
  if (digest(state.connectionDispatchAdmissions ?? []) !== admissionDigest) throw blocked('WRITE_ADMISSION_UNAVAILABLE');
  admitExecution(state, true);
  admissionDigest = digest(state.connectionDispatchAdmissions);
  write.status = 'executing'; write.startedAt = new Date().toISOString();
  addAudit(state, { type: 'connection_write_started', actor, detail: { provider: write.provider, writeId: write.id, digest: write.digest } });
  await saveExact();
  const phases = write.input.operation === 'instagram_publish' ? ['instagram_container', 'instagram_publish']
    : [write.provider === 'shopify' ? 'shopify_mutation' : 'meta_mutation'];
  let expectedShopifyRequest;
  const dispatch = createConnectionDispatch(async request => {
    if (request.provider !== write.provider || !phases.includes(request.phase)
      || write.dispatchClaim.phases[request.phase]) throw blocked('WRITE_ALREADY_ATTEMPTED');
    const expected = write.provider === 'shopify' ? expectedShopifyRequest : metaMutationRequest(preparedInput, request.phase, write.providerState?.containerId);
    if (!expected || digest(request) !== digest(expected)) throw blocked('WRITE_REQUEST_CHANGED');
    if (containerId && write.providerState?.containerId !== containerId) throw blocked('WRITE_REQUEST_CHANGED');
    await freshCheck();
    if (write.dispatchClaim.phases[request.phase]) throw blocked('WRITE_ALREADY_ATTEMPTED');
    if (request.phase === 'instagram_publish') write.providerState.publishStartedAt = new Date().toISOString();
    write.dispatchClaim.phases[request.phase] = { requestDigest: digest(request), status: 'dispatching', at: new Date().toISOString() };
    await saveExact();
    // Final acknowledged, revision-guarded phase claim is the dispatch
    // authorization point. A later pause cannot recall an in-flight request.
    await freshCheck();
  });
  const recordResult = (phase, externalId) => {
    if (phase !== 'instagram_container' || !/^\d{1,32}$/.test(externalId)
      || !write.dispatchClaim.phases[phase] || connectionDispatchCount(dispatch) !== 1
      || (containerId && containerId !== externalId)) throw blocked('WRITE_RESULT_UNKNOWN');
    containerId = externalId;
    write.dispatchClaim.phases[phase].resultId = externalId;
  };
  const shopifyMutation = (query, variables) => {
    expectedShopifyRequest = { provider: 'shopify', phase: 'shopify_mutation', method: 'POST',
      url: `https://${config.domain}/admin/api/${config.apiVersion || '2026-07'}/graphql.json`, body: JSON.stringify({ query, variables }) };
    return integrations.shopifyGraphql(query, immutable(structuredClone(variables)), config, { dispatch });
  };
  try {
    let result;
    if (write.provider === 'meta') {
      result = await integrations.executeMetaWrite(state, write, saveExact, { dispatch, credentials: metaCredentials, input: preparedInput, recordResult });
      if (result.pending) { localCheck(); write.status = 'processing'; write.observationErrorCode = result.observationError || null; addAudit(state, { type: 'connection_write_processing', actor, detail: { provider: write.provider, writeId: write.id } }); await saveExact(); return structuredClone(write); }
      write.result = result;
    } else if (preparedInput.operation.startsWith('product_tags_')) {
      const method = preparedInput.operation === 'product_tags_add' ? 'tagsAdd' : 'tagsRemove';
      const data = await shopifyMutation(`mutation RunvaraProductTags($id: ID!, $tags: [String!]!) { ${method}(id: $id, tags: $tags) { node { id } userErrors { field message } } }`, { id: preparedInput.productId, tags: preparedInput.tags });
      result = data?.[method];
      if (result?.node?.id !== preparedInput.productId && !result?.userErrors?.length) throw connectionError('Shopify did not confirm the tag change.', 'WRITE_RESULT_UNKNOWN', 422);
      write.result = { externalId: result?.node?.id || null, recovery: 'Review current tags in Shopify before preparing a separately approved inverse change. Never remove a tag that existed before this request.' };
    } else if (preparedInput.operation === 'internal_note') {
      const data = await shopifyMutation('mutation RunvaraInternalNote($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message code } } }', { metafields: [{ ownerId: preparedInput.productId, namespace: '$app:runvara', key: 'internal_note', type: 'single_line_text_field', value: preparedInput.note.replace(/[\r\n]/g, ' ') }] });
      result = data?.metafieldsSet;
      if (!result?.metafields?.length && !result?.userErrors?.length) throw connectionError('Shopify did not confirm the saved note.', 'WRITE_RESULT_UNKNOWN', 422);
    } else {
      const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      const data = await shopifyMutation('mutation RunvaraProductContent($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id title } userErrors { field message } } }', { product: { id: preparedInput.productId, title: preparedInput.title, descriptionHtml: `<p>${escape(preparedInput.description).replace(/\n/g, '<br>')}</p>` } });
      result = data?.productUpdate;
      if (result?.product?.id !== preparedInput.productId && !result?.userErrors?.length) throw connectionError('Shopify did not confirm the content change.', 'WRITE_RESULT_UNKNOWN', 422);
    }
    retainedCheck();
    if (connectionDispatchCount(dispatch) === 0) throw blocked('WRITE_DISPATCH_UNVERIFIED');
    if (result.userErrors?.length) { write.status = 'failed'; throw connectionError('Shopify declined this change. Check the product in Shopify before submitting a new request.', 'WRITE_REJECTED', 422); }
    write.status = 'completed'; write.observationErrorCode = null; write.completedAt = new Date().toISOString();
    if (approval) {
      approval.executedExternally = true; approval.executionStatus = 'completed'; approval.workStatus = 'COMPLETED';
      recordWork(state, { id: approval.id, title: approval.action, source: 'approval-centre', status: 'COMPLETED', executedExternally: true, evidence: [{ type: `${write.provider}_write`, id: write.result?.externalId || write.input.productId, detail: write.input.operation }] });
    }
    recordWork(state, { id: write.id, title: `${write.provider === 'meta' ? 'Meta' : 'Shopify'} change confirmed`, source: 'connection-centre', status: 'COMPLETED', executedExternally: true, evidence: [{ type: `${write.provider}_write`, id: write.result?.externalId || write.input.productId, detail: write.input.operation }] });
  } catch (error) {
    // Never let the outer whole-state save overwrite acknowledged admission
    // history or immutable request identity with a changed shared snapshot.
    retainedCheck();
    write.dispatchBlocked = connectionDispatchCount(dispatch) === 0;
    if (write.status !== 'failed') write.status = write.dispatchBlocked ? 'failed' : 'uncertain';
    write.errorCode = /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'WRITE_RESULT_UNKNOWN';
  }
  addAudit(state, { type: 'connection_write_finished', actor, detail: { provider: write.provider, writeId: write.id, status: write.status, errorCode: write.errorCode || null } });
  await saveExact();
  return structuredClone(write);
}
