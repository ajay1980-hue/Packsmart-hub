import { assertShopifySourceScope, inspectShopifyOrderSource, validateRetainedShopifyOrderState } from './shopify-order-source.mjs';
import { reviewWholesaleContribution } from './wholesale-economics.mjs';

// Unmounted, read-only snapshot review. Context/economics must come from trusted
// same-order evidence; this function neither authenticates nor approves it.
export function reviewWholesaleOrderContribution(state, context = {}) {
  const result = (blockers, contribution = null) => ({
    schema: 'runvara-wholesale-order-review/v1',
    status: blockers.length ? 'blocked' : 'recorded_order_review', blockers, contribution,
    bookingAllowed: false, liveReady: false
  });
  if (!context || typeof context !== 'object' || Array.isArray(context)) return result(['context']);
  const { workspaceId, orderId, revision, sourceReadRef, updatedAt, economics } = context;
  try {
    if (state?.workspace?.id !== workspaceId || typeof revision !== 'string' || !revision ||
        state._revision !== revision || typeof orderId !== 'string' || !orderId || !Array.isArray(state.orders)) {
      return result(['snapshot_binding']);
    }
    assertShopifySourceScope(context, workspaceId);
    // Existing validator rejects foreign nested scope and both internal/external
    // Shopify duplicate identities, rather than picking a favourable event copy.
    validateRetainedShopifyOrderState(state);
    const order = state.orders.find(row => row.provider === 'shopify' && row.id === orderId);
    if (!order) return result(['order_unavailable']);
    const source = inspectShopifyOrderSource(state, order, workspaceId);
    if (source.format !== 'source' || source.scopeValid !== true || source.manifestStatus !== 'retained') {
      return result(['source_evidence']);
    }
    if (typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt)) ||
        order.updatedAt !== updatedAt || order.sourceReadRef !== sourceReadRef) return result(['order_binding']);
    const blockers = [];
    // Historical analytics deliberately includes refunded orders in paid totals.
    // A contribution review for unfulfilled wholesale uses this stricter subset.
    if (order.financialStatus !== 'PAID') blockers.push('recorded_payment_status');
    if (order.cancelledAt !== null) blockers.push('cancelled_or_unknown');
    if (order.fulfillmentStatus !== 'UNFULFILLED') blockers.push('fulfillment_status');
    if (order.currency !== 'GBP' || source.currencyFor('currentTotal') !== 'GBP') blockers.push('order_currency');
    if (blockers.length) return result(blockers);
    assertShopifySourceScope(economics, workspaceId);
    for (const value of [economics.revenue, economics.vatTreatment, ...Object.values(economics.costs || {})]) {
      assertShopifySourceScope(value, workspaceId);
    }
    // Never infer actual received cash from currentTotal or a PAID status.
    const contribution = reviewWholesaleContribution(economics);
    return result(contribution.status === 'meets_target' ? [] :
      [contribution.status, ...contribution.blockers].map(reason => `economics:${reason}`), contribution);
  } catch {
    return result(['scope_or_retained_evidence']);
  }
}
