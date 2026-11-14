import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareShopifyOrderRead } from '../lib/shopify-order-source.mjs';
import { REQUIRED_UNIT_COSTS } from '../lib/profit.mjs';
import { reviewWholesaleOrderContribution as review } from '../lib/wholesale-order-review.mjs';

const workspaceId = 'synthetic-wholesale', at = '2026-11-14T12:00:00.000Z';
function fixture() {
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

test('one retained PAID unfulfilled order permits only a recorded contribution review', () => {
  const { state, context } = fixture(), result = review(state, context);
  assert.equal(result.status, 'recorded_order_review');
  assert.equal(result.contribution.status, 'meets_target');
  assert.equal(result.bookingAllowed, false);
  assert.equal(result.liveReady, false);
});

test('unpaid, partially paid, refunded and unknown statuses withhold contribution', () => {
  for (const status of ['PENDING', 'AUTHORIZED', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOIDED', 'UNKNOWN', undefined]) {
    const { state, context } = fixture(); state.orders[0].financialStatus = status;
    assert.ok(review(state, context).blockers.includes('recorded_payment_status'));
    assert.equal(review(state, context).contribution, null);
  }
});

test('foreign tenant markers at state, order, line and economics levels fail closed', () => {
  for (const target of ['state', 'order', 'line', 'economics', 'revenue', 'vat', 'cost']) {
    const { state, context } = fixture();
    const rows = { state, order: state.orders[0], line: state.orders[0].lineItems[0], economics: context.economics,
      revenue: context.economics.revenue, vat: context.economics.vatTreatment, cost: context.economics.costs.packing };
    rows[target].tenantId = 'foreign';
    const result = review(state, context);
    assert.equal(result.status, 'blocked', target);
    assert.equal(result.contribution, null, target);
  }
  const { state, context } = fixture(); context.workspaceId = 'foreign';
  assert.equal(review(state, context).status, 'blocked');
});

test('repeated local review is pure; duplicate internal or external order copies are blocked', () => {
  const { state, context } = fixture(), before = structuredClone({ state, context });
  assert.deepEqual(review(state, context), review(state, context));
  assert.deepEqual({ state, context }, before);
  for (const copy of [structuredClone(state.orders[0]), { ...state.orders[0], id: 'different-internal-id' }]) {
    assert.equal(review({ ...state, orders: [...state.orders, copy] }, context).status, 'blocked');
  }
});

test('missing/rejected price approval and unverified zero costs remain blocked by reused economics', () => {
  for (const approval of [undefined, 'pending', 'rejected', 'HOLD']) {
    const { state, context } = fixture(); context.economics.priceApproval = approval;
    state.approvals = [{ id: 'unrelated-approved-action', status: 'approved', type: 'live_external_action' }];
    assert.ok(review(state, context).blockers.includes('economics:price_approval'));
  }
  const { state, context } = fixture(); context.economics.costs.packing.verified = false;
  assert.ok(review(state, context).blockers.includes('economics:cost:packing'));
});

test('stale/missing snapshot, source or order bindings cannot select another order', () => {
  for (const change of [{ revision: 'old' }, { orderId: 'different' }, { sourceReadRef: 'old' }, { updatedAt: '2026-11-13T12:00:00.000Z' }]) {
    const { state, context } = fixture();
    assert.equal(review(state, { ...context, ...change }).contribution, null);
  }
  for (const change of ['manifest', 'legacy', 'invalid-source']) {
    const { state, context } = fixture();
    if (change === 'manifest') delete state.channelData;
    if (change === 'legacy') delete state.orders[0].sourceReadRef;
    if (change === 'invalid-source') state.orders[0].currentTotal = 100;
    assert.equal(review(state, context).contribution, null);
  }
});

test('cancelled, fulfilled, partial/unknown fulfilment and non-GBP orders remain blocked', () => {
  for (const fields of [{ cancelledAt: at }, { cancelledAt: undefined }, { fulfillmentStatus: 'FULFILLED' },
    { fulfillmentStatus: 'PARTIALLY_FULFILLED' }, { fulfillmentStatus: 'UNKNOWN' }, { currency: 'EUR' },
    { sourceCurrencyOverrides: { currentTotal: 'EUR' } }]) {
    const { state, context } = fixture(); Object.assign(state.orders[0], fields);
    assert.equal(review(state, context).contribution, null);
  }
  assert.equal(review(null).status, 'blocked');
  assert.equal(review({}, null).status, 'blocked');
});

test('recorded currentTotal is never promoted to actual cash or approved evidence', () => {
  const { state, context } = fixture(); delete context.economics.revenue;
  assert.equal(review(state, context).status, 'blocked');
  assert.equal(review(state, context).contribution, null);
});

test('quotation-required and below-target economics cannot become order readiness', () => {
  for (const kind of ['quotation', 'below-target']) {
    const { state, context } = fixture();
    if (kind === 'quotation') context.economics.packs = [1000, 1000];
    else context.economics.costs.delivery.pence = 1;
    const result = review(state, context);
    assert.equal(result.status, 'blocked');
    assert.equal(result.contribution.status, kind === 'quotation' ? 'quotation_required' : 'below_target');
    assert.equal(result.bookingAllowed, false);
  }
});
