// Synthetic action snapshots for UI-only and intercepted-browser tests.
// These are never provider mutations or database publication fixtures.
import { createHash } from 'node:crypto';
import { digestReviewedActionValue, reviewedActionDispatchRequest, reviewedActionClaimIdentity, validateReviewedSourceAction } from '../lib/reviewed-action-evidence.mjs';
export function actionUiFixture(workspaceId, { title = '<img src=x onerror="window.actionInjected=true"> Product', description = 'Exact description <script>window.actionInjected=true</script>\nSecond line.', id = 'write_reviewed_action', completedAt = '2026-10-05T10:00:00.000Z', policyCount = 0 } = {}) {
  const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const input = { productId: 'gid://shopify/Product/101', operation: 'product_content', title, description };
  const decision = { workspaceId, id: 'approval_reviewed_action', revision: 1, status: 'approved', decidedBy: 'owner_one', decidedAt: '2026-10-05T09:00:00.000Z', payload: { connectionWriteId: id, digest: fingerprint(input) } };
  const context = { schema: 'runvara-recorded-action-context/v1', workspaceId, writeId: id, requestId: 'synthetic_request_123456', claimId: 'claim_reviewed_action', claimIdentity: 'c'.repeat(64), provider: 'shopify', operation: 'product_content',
    connectionId: 'connection_reviewed_action', account: 'synthetic-shop.myshopify.com', apiVersion: '2026-07', requestedBy: 'owner_one', executedBy: 'owner_one', inputDigest: fingerprint(input), phase: 'shopify_mutation',
    dispatchRequestDigest: fingerprint(reviewedActionDispatchRequest(input, 'synthetic-shop.myshopify.com', '2026-07')),
    resultId: input.productId, completedAt, origin: 'owner_manual', originatingObjective: null,
    approval: { ...decision, digest: digestReviewedActionValue(decision) }, proposal: null, policies: [] };
  if (policyCount) {
    context.policies = Array.from({ length: policyCount }, (_, index) => ({ objectiveId: `objective_policy_${index}`, revision: index + 1, digest: digestReviewedActionValue(['synthetic policy', index]) }));
    const proposal = { schema: 'runvara-objective-dispatch-proposal/v1', workspaceId, origin: context.origin, writeId: id, provider: context.provider, operation: context.operation, inputDigest: context.inputDigest, connectionId: context.connectionId, account: context.account, requestedBy: context.requestedBy, approvalKind: 'customer_facing_publish', policies: context.policies, evidenceQualification: 'no_financial_execution_evidence' };
    context.proposal = { ...proposal, digest: digestReviewedActionValue(proposal) };
    decision.payload.objectivePolicyProposalDigest = context.proposal.digest;
    context.approval = { ...decision, digest: digestReviewedActionValue(decision) };
  }
  context.claimIdentity = reviewedActionClaimIdentity(input, context);
  const body = { schema: 'runvara-reviewed-source-action/v1', revision: 1, context, input };
  const source = validateReviewedSourceAction({ ...body, digest: digestReviewedActionValue(body) }, { workspaceId });
  return { source, choice: { id, account: context.account, productId: input.productId, title, completedAt, digest: source.digest } };
}
