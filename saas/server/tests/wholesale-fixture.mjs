import { prepareShopifyOrderRead } from '../lib/shopify-order-source.mjs';
import { REQUIRED_UNIT_COSTS } from '../lib/profit.mjs';

export const wholesaleFixtureTime = '2026-11-14T12:00:00.000Z';
const at = wholesaleFixtureTime;
export function wholesaleOrderFixture(workspaceId = 'synthetic-wholesale') {
  const order = { id: 'order-1', externalId: 'gid://shopify/Order/1', provider: 'shopify',
    createdAt: at, updatedAt: at, cancelledAt: null, financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED',
    currency: 'GBP', total: '100.00', currentTotal: '100.00', currentTax: '0.00', discounts: '0.00', shippingCharged: '5.00',
    tax: null, refunds: null, lineItems: [{ id: 'line-1', sku: 'existing-fixture-variant', quantity: 1, gross: '95.00', net: '95.00' }] };
  const read = prepareShopifyOrderRead({ workspaceId, domain: 'synthetic.myshopify.com' }, [order],
    [{ rows: 1, hasNextPage: false, cursorDigest: null, apiVersion: '2026-07' }],
    { query: 'created_at:>=2026-11-01', startedAt: at, finishedAt: at, legacyBytes: 2 });
  const state = { workspace: { id: workspaceId }, _revision: 'snapshot-1', orders: read.orders,
    channelData: { shopify: { orderReads: { schema: 'shopify-order-reads/v1', manifests: { [read.ref]: read.manifest } } } } };
  const economics = { currency: 'GBP', packs: [500], priceApproval: 'approved',
    revenue: { pence: 10000, verified: true, basis: 'received_after_discounts_including_shipping' },
    vatTreatment: { verified: true, status: 'not_registered', basis: 'gross_non_reclaimable' },
    costs: Object.fromEntries(REQUIRED_UNIT_COSTS.map(({ id }) => [id, { pence: id === 'landed' ? 6800 : 0, verified: true }])) };
  return { state, context: { workspaceId, orderId: order.id, revision: state._revision, sourceReadRef: read.ref, updatedAt: at, economics } };
}
