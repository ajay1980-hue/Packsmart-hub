import crypto from 'node:crypto';
import { connectionError, connectionSettings } from './connection-centre.mjs';
import { normalizeApprovalRequest } from './operations.mjs';
import { addAudit, recordWork } from './events.mjs';
import { META_WRITES, prepareMetaWrite, requireMetaScopes, metaWriteScopes } from './meta-commerce.mjs';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function proposeConnectionWrite(state, provider, body, actor) {
  const settings = connectionSettings(state, provider);
  if (settings.disconnected || settings.permissionMode === 'read_only') throw connectionError('This connection is read-only. The owner must authorise write access first.', 'WRITE_NOT_AUTHORISED', 403);
  if (!((provider === 'shopify' && ['product_content', 'internal_note'].includes(body.operation)) || (provider === 'meta' && META_WRITES.includes(body.operation)))) throw connectionError('Runvara does not support this write action. No change was made.', 'WRITE_UNSUPPORTED', 422);
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(body.requestId || '')) throw connectionError('A unique request reference is required.', 'WRITE_REQUEST_ID_REQUIRED');
  state.connectionWrites ||= [];
  const existing = state.connectionWrites.find(item => item.requestId === body.requestId);
  const product = (state.products || []).find(item => item.id === body.productId && item.provider === 'shopify');
  if (provider === 'shopify' && (!product || !/^gid:\/\/shopify\/Product\/\d+$/.test(product.id))) throw connectionError('Choose a Shopify product in this workspace.', 'PRODUCT_NOT_FOUND', 404);
  const input = provider === 'meta' ? prepareMetaWrite(state, body) : { productId: product.id, operation: body.operation };
  if (provider === 'meta') { /* Exact supported input was validated above. */ } else if (body.operation === 'internal_note') {
    if (typeof body.note !== 'string' || !body.note.trim() || body.note.length > 500) throw connectionError('Enter an internal note of up to 500 characters.');
    input.note = body.note.trim();
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
    const approval = normalizeApprovalRequest({ type: provider === 'meta' ? 'risky_marketplace_action' : body.operation === 'product_content' ? 'customer_facing_publish' : 'integration_change',
      action: provider === 'meta' ? `Meta: ${input.operation.replaceAll('_', ' ')}` : body.operation === 'product_content' ? `Update Shopify content: ${product.title}` : `Save internal Shopify note: ${product.title}`,
      reason: provider === 'meta' ? JSON.stringify(input).slice(0,1000) : body.operation === 'product_content' ? `Proposed title: ${input.title}\nDescription: ${input.description}`.slice(0, 1000) : input.note,
      expectedBenefit: 'Apply the exact change reviewed in the Connection Centre.', risk: 'medium', source: 'connection-centre',
      evidence: [{ type: provider === 'meta' ? 'meta_asset' : 'product', id: input.productId || input.catalogId || input.pageId, detail: 'The full proposed change is available in the channel details panel.' }],
      payload: { connectionWriteId: write.id, digest: write.digest } }, actor);
    state.approvals.unshift(approval); write.approvalId = approval.id;
  }
  state.connectionWrites.unshift(write);
  addAudit(state, { type: 'connection_write_requested', actor, detail: { provider, writeId: write.id, operation: input.operation, requiresApproval, digest: write.digest } });
  return write;
}
export async function executeConnectionWrite(state, writeId, actor, integrations, persistClaim) {
  const write = state.connectionWrites?.find(item => item.id === writeId);
  if (!write) throw connectionError('Write request not found in this workspace.', 'WRITE_NOT_FOUND', 404);
  if (write.status === 'completed') return write;
  // A crash after sending a write leaves an uncertain result: never replay it.
  if (['executing', 'uncertain', 'failed'].includes(write.status)) throw connectionError('This change already ran or its result needs checking in the channel. It will not be sent again.', 'WRITE_ALREADY_ATTEMPTED', 409);
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
  const config = write.provider === 'shopify' ? integrations.shopifyConfig(state) : {};
  if (config.mode === 'oauth') config.accessToken = (await integrations.connectorCredentials(state, 'shopify')).accessToken;
  write.status = 'executing'; write.startedAt = new Date().toISOString();
  addAudit(state, { type: 'connection_write_started', actor, detail: { provider: write.provider, writeId: write.id, digest: write.digest } });
  await persistClaim();
  try {
    let result;
    if (write.provider === 'meta') {
      result = await integrations.executeMetaWrite(state, write, persistClaim);
      if (result.pending) { write.status = 'processing'; addAudit(state, { type: 'connection_write_processing', actor, detail: { provider: write.provider, writeId: write.id } }); return write; }
      write.result = result;
    } else if (write.input.operation === 'internal_note') {
      const data = await integrations.shopifyGraphql('mutation RunvaraInternalNote($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message code } } }', { metafields: [{ ownerId: write.input.productId, namespace: '$app:runvara', key: 'internal_note', type: 'single_line_text_field', value: write.input.note.replace(/[\r\n]/g, ' ') }] }, config);
      result = data?.metafieldsSet;
      if (!result?.metafields?.length && !result?.userErrors?.length) throw connectionError('Shopify did not confirm the saved note.', 'WRITE_RESULT_UNKNOWN', 422);
    } else {
      const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      const data = await integrations.shopifyGraphql('mutation RunvaraProductContent($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id title } userErrors { field message } } }', { product: { id: write.input.productId, title: write.input.title, descriptionHtml: `<p>${escape(write.input.description).replace(/\n/g, '<br>')}</p>` } }, config);
      result = data?.productUpdate;
      if (!result?.product?.id && !result?.userErrors?.length) throw connectionError('Shopify did not confirm the content change.', 'WRITE_RESULT_UNKNOWN', 422);
    }
    if (result.userErrors?.length) { write.status = 'failed'; throw connectionError('Shopify declined this change. Check the product in Shopify before submitting a new request.', 'WRITE_REJECTED', 422); }
    write.status = 'completed'; write.completedAt = new Date().toISOString();
    if (approval) {
      approval.executedExternally = true; approval.executionStatus = 'completed'; approval.workStatus = 'COMPLETED';
      recordWork(state, { id: approval.id, title: approval.action, source: 'approval-centre', status: 'COMPLETED', executedExternally: true, evidence: [{ type: `${write.provider}_write`, id: write.result?.externalId || write.input.productId, detail: write.input.operation }] });
    }
    recordWork(state, { id: write.id, title: `${write.provider === 'meta' ? 'Meta' : 'Shopify'} change confirmed`, source: 'connection-centre', status: 'COMPLETED', executedExternally: true, evidence: [{ type: `${write.provider}_write`, id: write.result?.externalId || write.input.productId, detail: write.input.operation }] });
  } catch (error) {
    if (write.status !== 'failed') write.status = error.definitive ? 'failed' : 'uncertain';
    write.errorCode = /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'WRITE_RESULT_UNKNOWN';
  }
  addAudit(state, { type: 'connection_write_finished', actor, detail: { provider: write.provider, writeId: write.id, status: write.status, errorCode: write.errorCode || null } });
  return write;
}
