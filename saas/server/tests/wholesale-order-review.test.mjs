import assert from 'node:assert/strict';
import test from 'node:test';
import { wholesaleOrderFixture as fixture, wholesaleFixtureTime as at } from './wholesale-fixture.mjs';
import { reviewWholesaleOrderContribution as review } from '../lib/wholesale-order-review.mjs';


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
