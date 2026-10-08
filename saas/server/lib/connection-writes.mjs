import crypto from 'node:crypto';
import { createRecordedActionContext, REVIEWED_ACTION_STATE_MAX_BYTES } from './reviewed-action-evidence.mjs';
import { connectionError, connectionSettings } from './connection-centre.mjs';
import { normalizeApprovalRequest } from './operations.mjs';
import { addAudit, recordWork } from './events.mjs';
import { createConnectionDispatch, connectionDispatchCount } from './connection-dispatch.mjs';
import { META_WRITES, prepareMetaWrite, requireMetaScopes, metaWriteScopes } from './meta-commerce.mjs';
import { captureObjectiveDispatchPolicy, prepareObjectiveDispatchProposal, assertObjectiveDispatchBinding,
  assertObjectivePolicySource, protectObjectivePolicySource, assertObjectiveDispatchAllowed, prepareObjectiveContentDispatchProposal,
  objectiveCanonicalText, objectiveCanonicalDigest, OBJECTIVE_DISPATCH_PROPOSAL_SCHEMA } from './objective-dispatch-policy.mjs';
import { assertObjectiveContentOwner, validateObjectiveContentSource, loadObjectiveContentSource, captureObjectiveContentSource,
  objectiveContentApprovalDigest, isObjectiveContentWrite, OBJECTIVE_CONTENT_REQUEST_SCHEMA } from './objective-content-source.mjs';
import { MANUAL_CONTENT_REQUEST_SCHEMA, manualContentRecord, manualContentRows, manualContentWorkspace,
  assertManualContentScope, assertManualContentActor, validateManualContentTarget, assertManualContentTarget } from './manual-content-target.mjs';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contentTerminal = status => ['completed', 'uncertain', 'failed', 'rejected'].includes(status);
function contentInput(body) {
  if (typeof body.productId !== 'string' || body.productId.length > 100 || !/^gid:\/\/shopify\/Product\/\d+$/.test(body.productId)) throw connectionError('Choose a Shopify product in this workspace.', 'PRODUCT_NOT_FOUND', 404);
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200 || typeof body.description !== 'string' || body.description.length > 10000) throw connectionError('Enter a product title and a description of up to 10,000 characters.');
  return { productId: body.productId, operation: 'product_content', title: body.title.trim(), description: body.description };
}
function contentRequestRows(state, requestId) {
  return manualContentRows(state.connectionWrites || []).filter(row => row.requestId === requestId);
}
function contentRequest(state, requestId, actor, objectiveContent = false) {
  const workspaceId = manualContentWorkspace(state);
  const rows = contentRequestRows(state, requestId);
  if (rows.length > 1) throw connectionError('This request reference is ambiguous. Review the saved requests before continuing.', 'WRITE_CONFLICT', 409);
  if (!rows.length) return null;
  const write = rows[0];
  assertManualContentScope(write, workspaceId);
  if (objectiveContent ? !isObjectiveContentWrite(write) || write.objectivePolicyProposal.origin !== 'owner_objective_content' : Object.hasOwn(write, 'objectivePolicyProposal')
    && (write.objectivePolicyProposal?.schema !== OBJECTIVE_DISPATCH_PROPOSAL_SCHEMA || write.objectivePolicyProposal?.origin !== 'owner_manual')) {
    throw connectionError('This request reference belongs to a different request family.', 'WRITE_CONFLICT', 409);
  }
  if (write.provider !== 'shopify' || write.input?.operation !== 'product_content' || write.requestedBy !== actor) throw connectionError('This request reference belongs to a different change or requester.', 'WRITE_CONFLICT', 409);
  manualContentRecord(write.input);
  const normalized = contentInput(write.input);
  if (Reflect.ownKeys(write.input).length !== 4 || Object.keys(normalized).some(key => write.input[key] !== normalized[key])
    || write.digest !== digest(normalized) || typeof write.id !== 'string' || !/^write_[A-Za-z0-9_-]{1,100}$/.test(write.id)
    || typeof write.connectionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(write.connectionId)
    || typeof write.account !== 'string' || write.account.length > 253 || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(write.account)
    || typeof write.approvalId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(write.approvalId)
    || !['pending_approval', 'ready', 'executing', 'processing', 'completed', 'uncertain', 'failed', 'rejected'].includes(write.status)
    || state.connectionWrites.filter(row => row.id === write.id).length !== 1) throw connectionError('The saved content request could not be verified.', 'WRITE_CONFLICT', 409);
  return write;
}
function assertPendingContentApproval(state, write) {
  const rows = manualContentRows(state.approvals || []).filter(row => row.id === write.approvalId);
  const approval = rows[0];
  if (approval) assertManualContentScope(approval, state.workspace.id);
  if (rows.length !== 1 || write.requiresApproval !== true || approval.type !== 'customer_facing_publish'
    || (approval.revision || 1) !== 1 || approval.payload?.connectionWriteId !== write.id || approval.payload?.digest !== write.digest
    || !['pending', 'approved'].includes(approval.status)
    || (write.status !== 'pending_approval' && approval.status !== 'approved')) {
    throw connectionError('The exact saved approval changed. Review a new request.', 'APPROVAL_REQUIRED', 409);
  }
  assertObjectiveDispatchBinding(write, approval, captureObjectiveDispatchPolicy(state, write));
}
export function readManualContentRequest(state, requestId, actor) {
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)) throw connectionError('An exact request reference is required.', 'WRITE_REQUEST_ID_REQUIRED');
  assertManualContentActor(state, actor);
  const write = contentRequest(state, requestId, actor);
  // This is history from one retained snapshot, never execution authority or a
  // promise that an outstanding request cannot still commit on another replica.
  const request = write ? { id: write.id, requestId, provider: write.provider, input: structuredClone(write.input), digest: write.digest,
    connectionId: write.connectionId, account: write.account, requestedBy: write.requestedBy, status: write.status, approvalId: write.approvalId } : null;
  const result = { schema: MANUAL_CONTENT_REQUEST_SCHEMA, workspaceId: state.workspace.id, requestId, requestedBy: actor, found: Boolean(write), request };
  if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw connectionError('This request exceeds the safe review size.', 'WRITE_REQUEST_TOO_LARGE', 409);
  return result;
}
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
  const operationField = provider === 'shopify' ? Object.getOwnPropertyDescriptor(body, 'operation') : null;
  if (provider === 'shopify' && (!operationField && 'operation' in body || operationField && !Object.hasOwn(operationField, 'value'))) throw connectionError('The requested operation must be ordinary own data.', 'WRITE_CONTENT_INPUT_INVALID');
  if (['origin', 'objectiveRef', 'objectivePolicyProposal', 'policyBinding', 'executionPolicy', 'financialEvidence'].some(key => Object.hasOwn(body, key))) {
    throw connectionError('Execution restrictions and proposal authority are assigned by the server.', 'WRITE_POLICY_INPUT_INVALID', 400);
  }
  const manualContent = provider === 'shopify' && operationField?.value === 'product_content';
  if (manualContent) {
    manualContentRecord(body);
    if (Reflect.ownKeys(body).some(key => !['operation', 'requestId', 'productId', 'title', 'description', 'target'].includes(key))) throw connectionError('Unsupported content request field. Refresh and review the exact request.', 'WRITE_CONTENT_INPUT_INVALID');
    validateManualContentTarget(body.target);
    assertManualContentActor(state, actor);
  }
  let settings = manualContent ? null : connectionSettings(state, provider);
  if (!manualContent && (settings.disconnected || settings.permissionMode === 'read_only')) throw connectionError('This connection is read-only. The owner must authorise write access first.', 'WRITE_NOT_AUTHORISED', 403);
  if (!((provider === 'shopify' && ['product_content', 'internal_note', 'product_tags_add', 'product_tags_remove'].includes(body.operation)) || (provider === 'meta' && META_WRITES.includes(body.operation)))) throw connectionError('Runvara does not support this write action. No change was made.', 'WRITE_UNSUPPORTED', 422);
  if (manualContent && typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.requestId || '')) throw connectionError('A unique request reference is required.', 'WRITE_REQUEST_ID_REQUIRED');
  state.connectionWrites ||= [];
  const existing = manualContent ? contentRequest(state, body.requestId, actor) : state.connectionWrites.find(item => item.requestId === body.requestId);
  const products = manualContent ? manualContentRows(state.products || []) : state.products || [];
  const matches = manualContent ? products.filter(item => item.id === body.productId && item.provider === 'shopify')
    : [products.find(item => item.id === body.productId && item.provider === 'shopify')];
  const product = matches[0];
  if (provider === 'shopify' && !(manualContent && existing && contentTerminal(existing.status)) && (!product || manualContent && matches.length !== 1 || !/^gid:\/\/shopify\/Product\/\d+$/.test(product.id))) throw connectionError('Choose one exact Shopify product in this workspace.', 'PRODUCT_NOT_FOUND', 404);
  if (manualContent && product) assertManualContentScope(product, state.workspace.id);
  const input = manualContent ? contentInput(body) : provider === 'meta' ? prepareMetaWrite(state, body) : { productId: product.id, operation: body.operation };
  if (provider === 'meta' || manualContent) { /* Exact supported input was validated above. */ } else if (body.operation === 'internal_note') {
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
    if (manualContent) {
      if (existing.connectionId !== body.target.connectionId || existing.account !== body.target.account) throw connectionError('This request reference was already used for a different account.', 'WRITE_CONFLICT', 409);
      if (!contentTerminal(existing.status)) { assertManualContentTarget(state, body.target); assertPendingContentApproval(state, existing); }
      return existing;
    }
    if (!['completed', 'uncertain', 'failed', 'rejected'].includes(existing.status)) {
      assertObjectiveDispatchBinding(existing, state.approvals?.find(row => row.id === existing.approvalId), captureObjectiveDispatchPolicy(state, existing));
    }
    return existing;
  }
  const connection = manualContent ? assertManualContentTarget(state, body.target) : state.connections?.find(item => item.provider === provider && item.encryptedCredentials);
  if (manualContent) settings = connectionSettings(state, provider);
  if (provider === 'meta') requireMetaScopes(connection?.metadata?.grantedScopes, metaWriteScopes(input.operation));
  if (provider === 'shopify' && !connection?.metadata?.grantedScopes?.includes('write_products')) throw connectionError('Shopify has not granted product write access. Reconnect with write access and test the connection first.', 'WRITE_SCOPE_REQUIRED', 409);
  const requiresApproval = provider === 'meta' || settings.permissionMode !== 'automatic' || body.operation !== 'internal_note';
  if (settings.permissionMode === 'automatic' && (!settings.consent || settings.consent.mode !== 'automatic')) throw connectionError('The owner must explicitly authorise automatic writes.', 'OWNER_APPROVAL_REQUIRED', 403);
  const write = { id: `write_${crypto.randomUUID()}`, requestId: body.requestId, provider, input, digest: digest(input), connectionId: connection.id, account: provider === 'meta' ? connection.metadata.accountId : connection.metadata.shopDomain, requestedBy: actor,
    requiresApproval, status: requiresApproval ? 'pending_approval' : 'ready', createdAt: new Date().toISOString() };
  const objectiveProposal = prepareObjectiveDispatchProposal(write, captureObjectiveDispatchPolicy(state, write));
  if (objectiveProposal) write.objectivePolicyProposal = objectiveProposal;
  if (requiresApproval) {
    const approval = normalizeApprovalRequest({ type: provider === 'meta' ? 'risky_marketplace_action' : body.operation !== 'internal_note' ? 'customer_facing_publish' : 'integration_change',
      action: body.operation.startsWith('product_tags_') ? `${body.operation === 'product_tags_add' ? 'Add' : 'Remove'} Shopify tags: ${product.title}` : provider === 'meta' ? `Meta: ${input.operation.replaceAll('_', ' ')}` : body.operation === 'product_content' ? `Update Shopify content: ${product.title}` : `Save internal Shopify note: ${product.title}`,
      reason: body.operation.startsWith('product_tags_') ? `Exact tags: ${input.tags.join(', ')}. Tags may affect collections and automated workflows. An inverse change needs a new approval.` : provider === 'meta' ? JSON.stringify(input).slice(0,1000) : body.operation === 'product_content' ? `Proposed title: ${input.title}\nDescription: ${input.description}`.slice(0, 1000) : input.note,
      expectedBenefit: 'Apply the exact change reviewed in the Connection Centre.', risk: 'medium', source: 'connection-centre',
      evidence: [{ type: provider === 'meta' ? 'meta_asset' : 'product', id: input.productId || input.catalogId || input.pageId, detail: 'The full proposed change is available in the channel details panel.' }],
      payload: { connectionWriteId: write.id, digest: write.digest,
        ...(objectiveProposal ? { objectivePolicyProposalDigest: objectiveProposal.digest } : {}) } }, actor);
    state.approvals.unshift(approval); write.approvalId = approval.id;
  }
  state.connectionWrites.unshift(write);
  addAudit(state, { type: 'connection_write_requested', actor, detail: { provider, writeId: write.id, operation: input.operation, requiresApproval, digest: write.digest } });
  return write;
}

function objectiveRequestProjection(state, requestId, session, write, sourceStatus) {
  const request = write ? { id: write.id, requestId, provider: write.provider, input: structuredClone(write.input), digest: write.digest,
    connectionId: write.connectionId, account: write.account, requestedBy: write.requestedBy, status: write.status, approvalId: write.approvalId,
    origin: write.objectivePolicyProposal.origin, source: structuredClone(write.objectivePolicyProposal.source) } : null;
  const result = { schema: OBJECTIVE_CONTENT_REQUEST_SCHEMA, workspaceId: state.workspace.id, requestId,
    requestedBy: session.userId, found: Boolean(write), request, sourceStatus: write ? sourceStatus : null };
  if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw connectionError('This request exceeds the safe review size.', 'WRITE_REQUEST_TOO_LARGE', 409);
  return result;
}
export async function readObjectiveContentRequest(state, requestId, session, loadJob) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(requestId)) throw connectionError('An exact request reference is required.', 'WRITE_REQUEST_ID_REQUIRED');
  assertObjectiveContentOwner(state, session);
  const write = contentRequest(state, requestId, session.userId, true);
  if (!write) return objectiveRequestProjection(state, requestId, session, null, null);
  validateObjectiveContentSource(write.objectivePolicyProposal.source);
  const source = write.objectivePolicyProposal.source;
  const retained = digest(write);
  // A new account security epoch cannot reconcile an old unknown request as if
  // it were this session's intent. History does not confer apply permission.
  if (source.actorId !== session.userId || source.actorSessionVersion !== session.sessionVersion) throw blocked('WRITE_ACTOR_CHANGED');
  let sourceStatus = { status: 'current' };
  try { await loadObjectiveContentSource(state, source.jobId, source.opportunityId, session, loadJob, { write }); }
  catch (error) { sourceStatus = { status: error.code === 'OBJECTIVE_CONTENT_SOURCE_UNAVAILABLE' || !error.definitive ? 'unavailable' : 'changed',
    code: /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'OBJECTIVE_CONTENT_SOURCE_UNAVAILABLE',
    message: 'This retained request is history only. Its current source could not be confirmed; do not retry or apply it as a new request.' }; }
  assertObjectiveContentOwner(state, session);
  if (contentRequest(state, requestId, session.userId, true) !== write || digest(write) !== retained) throw blocked('WRITE_REQUEST_CHANGED');
  return objectiveRequestProjection(state, requestId, session, write, sourceStatus);
}

export async function prepareObjectiveContentRequest(state, body, session, { loadJob, persist } = {}) {
  manualContentRecord(body);
  const keys = ['requestId', 'jobId', 'opportunityId', 'sourceRevision', 'target', 'productId', 'title', 'description', 'confirmedDestinationProduct'];
  if (Reflect.ownKeys(body).length !== keys.length || !keys.every(key => Object.hasOwn(body, key))
    || body.confirmedDestinationProduct !== true || typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(body.requestId)
    || typeof body.sourceRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.sourceRevision)
    || typeof body.jobId !== 'string' || !/^job_[A-Za-z0-9_-]{1,100}$/.test(body.jobId)
    || typeof body.opportunityId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/.test(body.opportunityId)) {
    throw connectionError('Review the exact source, destination, product and content before preparing a request.', 'OBJECTIVE_CONTENT_INPUT_INVALID');
  }
  validateManualContentTarget(body.target);
  body = JSON.parse(objectiveCanonicalText(body));
  assertObjectiveContentOwner(state, session);
  const input = contentInput(body), inputDigest = digest(input);
  state.connectionWrites ||= [];
  const existing = contentRequest(state, body.requestId, session.userId, true);
  if (existing) {
    if (existing.digest !== inputDigest || existing.connectionId !== body.target.connectionId || existing.account !== body.target.account
      || existing.objectivePolicyProposal.source.jobId !== body.jobId || existing.objectivePolicyProposal.source.opportunityId !== body.opportunityId
      || objectiveCanonicalDigest(existing.objectivePolicyProposal.source) !== body.sourceRevision) throw blocked('WRITE_CONFLICT');
    if (!contentTerminal(existing.status)) {
      assertManualContentTarget(state, body.target);
      await loadObjectiveContentSource(state, body.jobId, body.opportunityId, session, loadJob, { write: existing });
    }
    return readObjectiveContentRequest(state, body.requestId, session, loadJob);
  }
  assertManualContentTarget(state, body.target);
  const current = await loadObjectiveContentSource(state, body.jobId, body.opportunityId, session, loadJob);
  if (objectiveCanonicalDigest(current.source) !== body.sourceRevision || body.productId !== current.product.id) throw blocked('OBJECTIVE_CONTENT_SOURCE_CHANGED');
  assertManualContentTarget(state, body.target);
  const write = { id: `write_${crypto.randomUUID()}`, requestId: body.requestId, provider: 'shopify', input, digest: inputDigest,
    connectionId: current.target.connectionId, account: current.target.account, requestedBy: session.userId,
    requiresApproval: true, status: 'pending_approval', createdAt: new Date().toISOString() };
  const approval = normalizeApprovalRequest({ type: 'customer_facing_publish', action: `Update Shopify content for objective: ${current.objective.title}`,
    reason: `Objective ${current.objective.id}, review ${current.source.reportId}, candidate ${current.source.opportunityId}. Destination ${write.account}; retained product ${input.productId}. Proposed title: ${input.title}\nDescription: ${input.description}`,
    expectedBenefit: 'Owner-requested content associated with this objective. Goal progress and financial benefit remain unknown.',
    risk: 'medium', source: 'objective-content', evidence: [
      { type: 'objective_review', id: current.source.reportId, detail: 'Server-recorded diagnostic history; not independently authenticated execution proof.' },
      { type: 'product', id: input.productId, detail: `Owner confirmed destination ${write.account}. Retained product account provenance is unverified. Full exact content is in the saved request.` }],
    payload: { connectionWriteId: write.id, digest: write.digest } }, session.userId);
  if (state.approvals.some(row => row.id === approval.id) || state.connectionWrites.some(row => row.id === write.id)) throw blocked('WRITE_CONFLICT');
  write.approvalId = approval.id;
  write.objectivePolicyProposal = prepareObjectiveContentDispatchProposal(write, current.policy,
    { source: current.source, approvalId: approval.id, approvalDigest: objectiveContentApprovalDigest(approval) });
  approval.payload.objectivePolicyProposalDigest = write.objectivePolicyProposal.digest;
  state.approvals.unshift(approval); state.connectionWrites.unshift(write);
  addAudit(state, { type: 'connection_write_requested', actor: session.userId,
    detail: { provider: 'shopify', writeId: write.id, operation: 'product_content', requiresApproval: true, digest: write.digest } });
  // Re-read the separate history row when preparing the actual commit. A
  // workspace revision cannot attest this job row or replace this read.
  const commitSource = await loadObjectiveContentSource(state, current.source.jobId, current.source.opportunityId, session, loadJob, { write });
  const expectedWrite = digest(write), expectedApproval = digest(approval);
  const beforeCommit = snapshot => {
    if (contentRequest(state, body.requestId, session.userId, true) !== write || digest(write) !== expectedWrite || digest(approval) !== expectedApproval) throw blocked('WRITE_REQUEST_CHANGED');
    captureObjectiveContentSource(state, commitSource.job, current.source.opportunityId, session, { write });
    assertManualContentTarget(state, body.target);
    if (snapshot && snapshot !== state) {
      const rows = snapshot.connectionWrites?.filter(row => row.id === write.id) || [];
      if (rows.length !== 1 || digest(rows[0]) !== expectedWrite || digest(snapshot.approvals?.find(row => row.id === approval.id)) !== expectedApproval) throw blocked('WRITE_REQUEST_CHANGED');
      captureObjectiveContentSource(snapshot, commitSource.job, current.source.opportunityId, session, { write: rows[0] });
    }
  };
  beforeCommit();
  if (typeof persist !== 'function') throw blocked('WRITE_DURABLE_STORE_REQUIRED');
  const previousRevision = state._revision;
  try {
    const saved = await persist({ ownedSnapshot: true, beforeCommit });
    beforeCommit();
    const rows = saved?.connectionWrites?.filter(row => row.id === write.id) || [];
    if (saved?.workspace?.id !== state.workspace.id || typeof saved?._revision !== 'string' || saved._revision === previousRevision
      || state._revision !== saved._revision || rows.length !== 1 || digest(rows[0]) !== expectedWrite
      || digest(saved.approvals?.find(row => row.id === approval.id)) !== expectedApproval) throw blocked('WRITE_CLAIM_ACK_INVALID');
    return objectiveRequestProjection(state, body.requestId, session, write, { status: 'current' });
  } catch {
    throw connectionError('The save acknowledgement could not be confirmed. Keep this request reference and check its exact saved status before any new request.', 'OBJECTIVE_CONTENT_SAVE_UNKNOWN', 503);
  }
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
    requiresApproval: write.requiresApproval, approvalId: write.approvalId || null,
    ...(Object.hasOwn(write, 'objectivePolicyProposal') ? { objectivePolicyProposal: write.objectivePolicyProposal } : {}) };
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

export async function executeConnectionWrite(state, writeId, actor, integrations, persistClaim, { loadFreshState, loadObjectiveJob, durableStore = false, actorSession: authenticatedSession } = {}) {
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
  const objectivePolicy = captureObjectiveDispatchPolicy(state, write);
  const objectiveContent = isObjectiveContentWrite(write);
  const sourceAuthorityTime = Date.now();
  const admissionIdentity = digest(writeIdentity(write)), admissionStatus = write.status;
  let contentSource = null, contentBinding = null;
  if (objectiveContent) {
    validateObjectiveContentSource(write.objectivePolicyProposal.source);
    const source = write.objectivePolicyProposal.source;
    if (write.requestedBy !== actor || source.actorId !== actor || source.actorSessionVersion !== actorSession.sessionVersion) throw blocked('WRITE_ACTOR_CHANGED');
    contentSource = await loadObjectiveContentSource(state, source.jobId, source.opportunityId, actorSession, loadObjectiveJob, { write });
    if (digest(writeIdentity(write)) !== admissionIdentity || write.status !== admissionStatus
      || state.connectionWrites.filter(row => row.id === writeId).length !== 1 || !state.connectionWrites.includes(write)) throw blocked('WRITE_REQUEST_CHANGED');
    contentBinding = { source: contentSource.source, approvalId: write.approvalId, approvalDigest: write.objectivePolicyProposal.approvalDigest };
    assertObjectivePolicySource(state, objectivePolicy);
    if (authority(state, write, actor, actorSession) !== authorityDigest) throw blocked('WRITE_AUTHORITY_CHANGED');
  }
  const checkContentSource = (snapshot = state) => {
    if (contentSource) captureObjectiveContentSource(snapshot, contentSource.job, contentSource.source.opportunityId, actorSession,
      { write: snapshot === state ? write : snapshot.connectionWrites?.find(row => row.id === writeId), now: sourceAuthorityTime });
  };
  assertObjectiveDispatchBinding(write, state.approvals?.find(row => row.id === write.approvalId), objectivePolicy, contentBinding);
  assertObjectiveDispatchAllowed(write, objectivePolicy);
  protectObjectivePolicySource(state, objectivePolicy);
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
  const approvedActionDecision = write.provider === 'shopify' && preparedInput.operation === 'product_content'
    ? immutable(structuredClone(approval)) : null;
  const identity = digest(writeIdentity(write));
  const workspaceId = state.workspace?.id;
  const config = write.provider === 'shopify' ? { ...integrations.shopifyConfig(state), connection: undefined } : {};
  const metaCredentials = write.provider === 'meta' ? immutable(structuredClone(await integrations.connectorCredentials(state, 'meta'))) : null;
  if (config.mode === 'oauth') config.accessToken = (await integrations.connectorCredentials(state, 'shopify')).accessToken;
  checkContentSource();
  Object.freeze(config);
  if (write.input.expectedTags) {
    const current = await integrations.shopifyGraphql('query RunvaraTagAcceptancePreview($id: ID!) { product(id: $id) { id tags } }', { id: write.input.productId }, config);
    if (current?.product?.id !== write.input.productId || !Array.isArray(current.product.tags) || JSON.stringify([...current.product.tags].sort()) !== JSON.stringify(write.input.expectedTags)) throw connectionError('Product tags changed since review. Prepare a fresh approval.', 'WRITE_BASELINE_CHANGED', 409);
  }
  if (write.status !== initialStatus) throw blocked('WRITE_ALREADY_ATTEMPTED');
  if (digest(connection.encryptedCredentials) !== credentialIdentity) throw blocked('WRITE_CONNECTION_CHANGED', 'The connection credentials changed during preparation. Refresh the connection before reviewing this write.');
  if (write.provider === 'shopify' && config.domain !== write.account) throw blocked('WRITE_CONNECTION_CHANGED');
  const configDigest = write.provider === 'shopify' ? digest(configBinding(config)) : null;
  let dispatch = null, submittedClaimDigest = null;
  const contentSubmitted = () => objectiveContent && connectionDispatchCount(dispatch) > 0;
  const approvalDecisionIdentity = value => digest(Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['executedExternally', 'executionStatus', 'workStatus'].includes(key))));
  const retainedSubmittedSnapshot = snapshot => {
    const writes = snapshot.connectionWrites?.filter(row => row.id === writeId) || [];
    const approvals = snapshot.approvals?.filter(row => row.id === approval.id) || [];
    if (snapshot.workspace?.id !== workspaceId || writes.length !== 1 || approvals.length !== 1
      || digest(writeIdentity(writes[0])) !== identity || digest(writes[0].dispatchClaim) !== submittedClaimDigest
      || approvalDecisionIdentity(approvals[0]) !== approvalDecisionIdentity(approvedActionDecision)
      || digest(snapshot.connectionDispatchAdmissions ?? []) !== admissionDigest) throw blocked('WRITE_CLAIM_CHANGED');
  };
  const retainedCheck = () => {
    if (!contentSubmitted()) { assertObjectivePolicySource(state, objectivePolicy); checkContentSource(); }
    else { retainedSubmittedSnapshot(state); if (!state.approvals.includes(approval)) throw blocked('WRITE_CLAIM_CHANGED'); }
    if (digest(state.connectionDispatchAdmissions ?? []) !== admissionDigest
      || state.workspace?.id !== workspaceId || !state.connectionWrites?.includes(write)
      || state.connectionWrites.filter(row => row.id === writeId).length !== 1
      || digest(writeIdentity(write)) !== identity) throw blocked('WRITE_CLAIM_CHANGED');
  };
  const localCheck = () => {
    retainedCheck();
    // A later eligibility change cannot revoke an already-submitted request.
    // Preserve its known result under the immutable request/decision/claim and
    // existing workspace CAS instead of running a new authorization gate.
    if (contentSubmitted()) return;
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
    const previous = state._revision, expected = digest(write), expectedApproval = objectiveContent ? digest(approval) : null;
    const saved = await persistClaim(objectiveContent ? { ownedSnapshot: true, beforeCommit: snapshot => {
      localCheck();
      if (snapshot) {
        const rows = snapshot.connectionWrites?.filter(row => row.id === writeId) || [];
        const approvals = snapshot.approvals?.filter(row => row.id === approval.id) || [];
        if (rows.length !== 1 || digest(rows[0]) !== expected || approvals.length !== 1 || digest(approvals[0]) !== expectedApproval) throw blocked('WRITE_CLAIM_CHANGED');
        if (contentSubmitted()) retainedSubmittedSnapshot(snapshot); else checkContentSource(snapshot);
      }
    } } : undefined);
    localCheck();
    const rows = saved?.connectionWrites?.filter(row => row.id === writeId) || [];
    if (typeof state._revision !== 'string' || state._revision === previous || saved?.workspace?.id !== workspaceId
      || saved?._revision !== state._revision || rows.length !== 1 || digest(rows[0]) !== expected
      || digest(write) !== expected || digest(saved.connectionDispatchAdmissions ?? []) !== admissionDigest
      || !contentSubmitted() && authority(saved, rows[0], actor, actorSession) !== authorityDigest) throw blocked('WRITE_CLAIM_ACK_INVALID');
    if (objectiveContent && (saved.approvals?.filter(row => row.id === approval.id).length !== 1
      || digest(saved.approvals.find(row => row.id === approval.id)) !== expectedApproval || digest(approval) !== expectedApproval)) throw blocked('WRITE_CLAIM_ACK_INVALID');
    if (!contentSubmitted()) { assertObjectivePolicySource(saved, objectivePolicy); checkContentSource(saved); }
    else retainedSubmittedSnapshot(saved);
  };
  const freshCheck = async () => {
    localCheck();
    if (contentSource) {
      await loadObjectiveContentSource(state, contentSource.source.jobId, contentSource.source.opportunityId,
        actorSession, loadObjectiveJob, { write });
      localCheck();
      assertObjectiveDispatchAllowed(write, objectivePolicy);
    }
    // The exact job is read first. The narrow workspace authority/revision read
    // remains last; job history is a separate, non-atomic observation boundary.
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
    // The unchanged full-workspace revision attests the pinned objective source.
    // This narrow projection deliberately does not download it a second time.
    assertObjectiveDispatchBinding(rows[0], fresh.approvals?.find(row => row.id === rows[0].approvalId), objectivePolicy, contentBinding);
    if (write.provider === 'shopify' && digest(configBinding(integrations.shopifyConfig(fresh))) !== configDigest) throw blocked('WRITE_CONNECTION_CHANGED');
  };
  localCheck();
  if (write.dispatchClaim && (write.dispatchClaim.identity !== identity || write.dispatchClaim.authority !== authorityDigest
    || write.dispatchClaim.workspaceId !== workspaceId)) throw blocked('WRITE_CLAIM_CHANGED');
  write.dispatchClaim ||= { id: `write_claim_${crypto.randomUUID()}`, workspaceId, identity, authority: authorityDigest, phases: {} };
  const executionClaimId = write.dispatchClaim.id;
  if (digest(state.connectionDispatchAdmissions ?? []) !== admissionDigest) throw blocked('WRITE_ADMISSION_UNAVAILABLE');
  admitExecution(state, true);
  admissionDigest = digest(state.connectionDispatchAdmissions);
  write.status = 'executing'; write.startedAt = new Date().toISOString();
  addAudit(state, { type: 'connection_write_started', actor, detail: { provider: write.provider, writeId: write.id, digest: write.digest } });
  await saveExact();
  const phases = write.input.operation === 'instagram_publish' ? ['instagram_container', 'instagram_publish']
    : [write.provider === 'shopify' ? 'shopify_mutation' : 'meta_mutation'];
  let expectedShopifyRequest;
  dispatch = createConnectionDispatch(async request => {
    if (request.provider !== write.provider || !phases.includes(request.phase)
      || write.dispatchClaim.phases[request.phase]) throw blocked('WRITE_ALREADY_ATTEMPTED');
    const expected = write.provider === 'shopify' ? expectedShopifyRequest : metaMutationRequest(preparedInput, request.phase, write.providerState?.containerId);
    if (!expected || digest(request) !== digest(expected)) throw blocked('WRITE_REQUEST_CHANGED');
    if (containerId && write.providerState?.containerId !== containerId) throw blocked('WRITE_REQUEST_CHANGED');
    await freshCheck();
    assertObjectiveDispatchAllowed(write, objectivePolicy);
    if (write.dispatchClaim.phases[request.phase]) throw blocked('WRITE_ALREADY_ATTEMPTED');
    if (request.phase === 'instagram_publish') write.providerState.publishStartedAt = new Date().toISOString();
    write.dispatchClaim.phases[request.phase] = { requestDigest: digest(request), status: 'dispatching', at: new Date().toISOString() };
    await saveExact();
    // Final acknowledged, revision-guarded phase claim is the dispatch
    // authorization point. A later pause cannot recall an in-flight request.
    await freshCheck();
    assertObjectiveDispatchAllowed(write, objectivePolicy);
    if (objectiveContent) submittedClaimDigest = digest(write.dispatchClaim);
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
      write.result = { externalId: result?.product?.id || null };
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
  // Optional evidence preparation is deliberately outside the provider-result
  // catch. A size/shape failure cannot erase a known Shopify response, change it
  // to uncertain, add another save, or replay the provider mutation. The exact
  // same final save below acknowledges the retained context and terminal result.
  if (write.status === 'completed' && approvedActionDecision) {
    try {
      if (objectiveContent) throw Object.assign(new Error('Objective-origin action context is outside the manual v1 evidence contract.'), { code: 'OBJECTIVE_CONTENT_CONTEXT_UNSUPPORTED' });
      write.recordedActionContext = createRecordedActionContext({ state, write, preparedInput, actor,
        approval: approvedActionDecision, objectivePolicy, dispatchRequestDigest: digest(expectedShopifyRequest),
        claimId: executionClaimId, claimIdentity: identity, apiVersion: config.apiVersion || '2026-07' });
      // Leave conservative headroom for the existing store's revision/reporting
      // metadata. No full action text is duplicated in the mutable context.
      if (Buffer.byteLength(JSON.stringify(state)) >= REVIEWED_ACTION_STATE_MAX_BYTES - 16384) {
        delete write.recordedActionContext;
        write.recordedActionUnavailable = 'state_size_limit';
      }
    } catch (error) {
      delete write.recordedActionContext;
      write.recordedActionUnavailable = error.code === 'OBJECTIVE_CONTENT_CONTEXT_UNSUPPORTED' ? 'objective_origin_unsupported'
        : error.code === 'OUTCOME_ACTION_TOO_LARGE' ? 'source_size_limit' : 'context_unavailable';
    }
    if (write.recordedActionUnavailable && Buffer.byteLength(JSON.stringify(state)) >= REVIEWED_ACTION_STATE_MAX_BYTES - 16384) delete write.recordedActionUnavailable;
  }
  await saveExact();
  return structuredClone(write);
}
