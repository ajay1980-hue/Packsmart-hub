import assert from 'node:assert/strict';
import test from 'node:test';
import { REQUIRED_UNIT_COSTS } from '../lib/profit.mjs';
import { reviewWholesaleContribution as review } from '../lib/wholesale-economics.mjs';

// Synthetic evidence; none of these numbers are Runvara prices or provider quotes.
function fixture() {
  return {
    packs: [500], currency: 'GBP', priceApproval: 'approved',
    revenue: { pence: 10000, verified: true, basis: 'received_after_discounts_including_shipping' },
    vatTreatment: { verified: true, status: 'not_registered', basis: 'gross_non_reclaimable' },
    costs: Object.fromEntries(REQUIRED_UNIT_COSTS.map(({ id }) => [id, { pence: id === 'landed' ? 6800 : 0, verified: true }]))
  };
}

test('500 and 1000 use exact 32% and 30% boundaries before display rounding', () => {
  for (const [size, cost, target] of [[500, 6800, 32], [1000, 7000, 30]]) {
    const input = fixture(); input.packs = [size]; input.costs.landed.pence = cost;
    assert.equal(review(input).status, 'meets_target');
    assert.equal(review(input).targetPercent, target);
    input.costs.landed.pence++;
    assert.equal(review(input).status, 'below_target');
  }
});

test('mixed 1500 uses stricter 32%; 2000 and larger require quotation', () => {
  const input = fixture(); input.packs = [500, 1000];
  assert.equal(review(input).targetPercent, 32);
  for (const packs of [[1000, 1000], [500, 500, 500, 500], [1000, 1000, 500]]) {
    const result = review({ ...input, packs });
    assert.equal(result.status, 'quotation_required');
    assert.equal(result.contributionPence, null);
  }
});

test('actual discounted receipts include customer shipping and all recorded fees', () => {
  const input = fixture();
  // Received 90 after promotion plus 10 shipping. Payment fee is actual 2% of 100 + 25p.
  input.costs.paymentFee.pence = 225;
  input.costs.delivery.pence = 500;
  const result = review(input);
  assert.equal(result.receivedRevenuePence, 10000);
  assert.equal(result.totalCostPence, 7525);
  assert.equal(result.contributionPence, 2475);
  assert.equal(result.marginPercent, 24.75);
  assert.equal(result.status, 'below_target');
  input.revenue.basis = 'list_price_before_promotion';
  assert.ok(review(input).blockers.includes('received_revenue'));
});

test('every unknown cost including placeholder zero withholds contribution', () => {
  for (const { id } of REQUIRED_UNIT_COSTS) {
    for (const value of [undefined, { pence: 0 }, { pence: 0, verified: false }, { pence: '0', verified: true },
      { pence: -1, verified: true }, { pence: 0.1, verified: true }, { pence: Infinity, verified: true }]) {
      const input = fixture(); input.costs[id] = value;
      assert.ok(review(input).blockers.includes(`cost:${id}`));
      assert.equal(review(input).contributionPence, null);
    }
  }
});

test('unverified or unsupported VAT and HOLD/rejected prices fail closed', () => {
  for (const treatment of [undefined, 'VAT inclusive', { verified: false },
    { verified: true, status: 'registered', basis: 'gross_non_reclaimable' }]) {
    assert.ok(review({ ...fixture(), vatTreatment: treatment }).blockers.includes('vat_treatment'));
  }
  for (const approval of [undefined, 'HOLD', 'draft', 'rejected', true]) {
    const result = review({ ...fixture(), priceApproval: approval });
    assert.ok(result.blockers.includes('price_approval'));
    assert.equal(result.contributionPence, null);
  }
});

test('malformed quantities and receipts cannot establish economics', () => {
  for (const currency of [undefined, 'EUR', 'gbp']) {
    assert.ok(review({ ...fixture(), currency }).blockers.includes('currency'));
  }
  for (const input of [null, [], { packs: [] }, { packs: Array(1) }, { packs: [499] }, { packs: ['500'] }, { packs: Array(101).fill(500) }]) {
    assert.equal(review(input).status, 'blocked');
  }
  for (const pence of [null, 0, -1, '10000', NaN, 1.5, 1e12 + 1]) {
    assert.ok(review({ ...fixture(), revenue: { ...fixture().revenue, pence } }).blockers.includes('received_revenue'));
  }
  assert.ok(review({ ...fixture(), revenue: { ...fixture().revenue, verified: false } }).blockers.includes('received_revenue'));
});

test('review is repeatable, leaves input untouched and never allows booking', () => {
  const input = fixture(), before = structuredClone(input), first = review(input);
  assert.deepEqual(review(input), first);
  assert.deepEqual(input, before);
  assert.equal(first.bookingAllowed, false);
  assert.equal(first.liveReady, false);
  assert.equal(review().bookingAllowed, false);
});
