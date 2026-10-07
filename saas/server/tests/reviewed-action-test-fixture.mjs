// Pure synthetic contract fixture. Dispatcher/transport proof is tested separately.
import { createHash } from 'node:crypto';
import { createRecordedActionContext, reviewedActionDispatchRequest, reviewedActionClaimIdentity, resolveRecordedActionEvidence } from '../lib/reviewed-action-evidence.mjs';
const fingerprint = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function reviewedActionFixture({ workspaceId = 'tenant-a', description = 'Exact <approved> description\nSecond line', title = 'Reviewed product', completedAt = '2026-10-05T12:00:00.000Z', policies = [] } = {}) {
  const input = { productId: 'gid://shopify/Product/71', operation: 'product_content', title, description };
  const write = { id: 'write_synthetic', requestId: 'synthetic_request_0001', provider: 'shopify', input, digest: fingerprint(input), connectionId: 'connection_synthetic',
    account: 'synthetic.myshopify.com', requestedBy: 'user_owner', approvalId: 'approval_synthetic', requiresApproval: true, status: 'completed',
    completedAt, result: { externalId: input.productId }, observationErrorCode: null };
  const approval = { id: write.approvalId, revision: 1, status: 'approved', type: 'customer_facing_publish', decidedBy: 'user_owner',
    decidedAt: '2026-10-04T12:00:00.000Z', payload: { connectionWriteId: write.id, digest: write.digest } };
  const state = { workspace: { id: workspaceId }, connectionWrites: [write], approvals: [approval],
    connections: [{ id: write.connectionId, provider: 'shopify', metadata: { shopDomain: write.account } }] };
  const dispatchRequestDigest = fingerprint(reviewedActionDispatchRequest(input, write.account, '2026-07'));
  const claimIdentity = reviewedActionClaimIdentity(input, { writeId: write.id, requestId: write.requestId, provider: write.provider, inputDigest: write.digest, connectionId: write.connectionId, account: write.account, requestedBy: write.requestedBy, approval, proposal: null });
  write.dispatchClaim = { id: 'claim_synthetic', identity: claimIdentity, authority: 'b'.repeat(64), workspaceId,
    phases: { shopify_mutation: { requestDigest: dispatchRequestDigest, status: 'dispatching', at: '2026-10-05T11:59:00.000Z' } } };
  // Policy-specific fixtures should use the actual proposal creator to bind the
  // approved payload before asking this helper for a completed source.
  if (policies.length) throw new Error('Use actual dispatcher for policy fixtures');
  write.recordedActionContext = createRecordedActionContext({ state, write, preparedInput: input, actor: 'user_owner', approval,
    objectivePolicy: { workspaceId, policies: [] }, dispatchRequestDigest, claimId: write.dispatchClaim.id, claimIdentity: write.dispatchClaim.identity, apiVersion: '2026-07' });
  return { state, write, approval, source: resolveRecordedActionEvidence(state, write.id) };
}
