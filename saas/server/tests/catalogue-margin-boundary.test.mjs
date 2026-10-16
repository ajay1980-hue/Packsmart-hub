import test from 'node:test';
import assert from 'node:assert/strict';
import { contributionMeetsMargin, deriveLandedCost, minimumPriceForMargin, unitEconomics } from '../lib/profit.mjs';
import { deriveOperations } from '../lib/operations.mjs';
import { draftMarketingCampaign } from '../lib/marketing.mjs';
import { detectExceptions, detectOpportunities } from '../lib/control.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';

const costs = landed => ({ landed, packing: 0, handling: 0, delivery: 0, paymentFee: 0, channelFee: 0, advertising: 0, otherVariable: 0 });
const fixture = (price, record, floor = 30) => ({ workspace: { id: 'synthetic-margin-boundary' }, settings: { marginFloor: floor },
  products: [{ id: 'p', title: 'Synthetic', status: 'active', image: 'recorded', variants: [{ id: 'v', sku: 'TEST', price, inventory: 20, available: true }] }],
  economics: { TEST: record }, marketing: { settings: { enabled: true, minMarginPercent: floor, minInventory: 10 }, campaigns: [] } });

test('a rounded 30.00 display cannot admit a true 29.996 percent campaign', () => {
  const state = fixture(20, costs(14.0008));
  const row = unitEconomics({ price: 20 }, state.economics.TEST, { marginFloor: 30 });
  assert.equal(row.margin, 30); assert.equal(row.status, 'below-floor');
  assert.equal(contributionMeetsMargin(20, row.costs, 30), false);
  assert.equal(deriveOperations(state).lowMargin, 1);
  assert.throws(() => draftMarketingCampaign(state), { code: 'NO_MARKETING_CANDIDATE' });
  assert.equal(state.marketing.campaigns.length, 0);
});

test('exact threshold passes despite binary arithmetic; one source increment below fails', () => {
  for (const [landed, expected] of [[1.785, true], [1.7851, false], [1.7849, true]]) {
    const state = fixture(2.55, costs(landed));
    const row = unitEconomics({ price: 2.55 }, state.economics.TEST, { marginFloor: 30 });
    assert.equal(contributionMeetsMargin(2.55, row.costs, 30), expected);
    assert.equal(row.status, expected ? 'profitable' : 'below-floor');
    assert.equal(deriveOperations(state).lowMargin, expected ? 0 : 1);
    if (expected) assert.equal(draftMarketingCampaign(state).product.sku, 'TEST');
    else assert.throws(() => draftMarketingCampaign(state), { code: 'NO_MARKETING_CANDIDATE' });
  }
});

test('exact zero contribution and very small losses receive consistent status', () => {
  const zero = { ...costs(0.1), packing: 0.2 };
  assert.equal(unitEconomics({ price: 0.3 }, zero, { marginFloor: 0 }).status, 'profitable');
  const loss = fixture(1, costs(1.000001), 0);
  assert.equal(unitEconomics({ price: 1 }, loss.economics.TEST, { marginFloor: 0 }).status, 'loss-making');
  assert.equal(deriveOperations(loss).negativeMargin, 1);
  assert.throws(() => draftMarketingCampaign(loss), { code: 'NO_MARKETING_CANDIDATE' });
});

test('integer oracle covers threshold boundaries without depending on formatted margins', () => {
  for (let priceCents = 1; priceCents <= 200; priceCents += 3) {
    for (const floorHundredths of [0, 150, 2000, 3000, 9999, 10000]) {
      const maxCostTenThousandths = Math.floor(priceCents * (10000 - floorHundredths) / 100);
      for (const costTenThousandths of [Math.max(0, maxCostTenThousandths - 1), maxCostTenThousandths, maxCostTenThousandths + 1]) {
        const price = BigInt(priceCents) * 100n;
        const expected = (price - BigInt(costTenThousandths)) * 10000n >= price * BigInt(floorHundredths);
        assert.equal(contributionMeetsMargin(priceCents / 100, costs(costTenThousandths / 10000), floorHundredths / 100), expected);
      }
    }
  }
});

test('unknown values and zero price cannot pass a financial threshold', () => {
  for (const field of Object.keys(costs(1))) for (const value of [undefined, null, '', false, NaN, Infinity]) {
    assert.equal(contributionMeetsMargin(10, { ...costs(1), [field]: value }, 30), false);
  }
  for (const price of [0, -1, null, undefined, NaN, Infinity]) assert.equal(contributionMeetsMargin(price, costs(0), 0), false);
  for (const floor of [null, undefined, NaN, Infinity]) assert.equal(contributionMeetsMargin(10, costs(1), floor), false);
  for (const record of [undefined, null, false, [], {}]) {
    assert.equal(contributionMeetsMargin(10, record, 30), false);
    assert.equal(minimumPriceForMargin(record, 30), null);
  }
});

test('bounded finite number exponents compare without rounding to display precision', () => {
  assert.equal(contributionMeetsMargin(1e-7, costs(7e-8), 30), true);
  assert.equal(contributionMeetsMargin(1e-7, costs(7.0001e-8), 30), false);
  assert.equal(contributionMeetsMargin(1e21, costs(7e20), 30), true);
});

test('supplier unit derivation retains sub-penny cost through quantity aggregation', () => {
  const derived = deriveLandedCost({ supplierUnitCost: 0.02029, supplierDelivery: 0, supplierVatRate: 0, supplierVatRecoverable: false });
  assert.equal(derived.value, 0.02029);
  assert.equal(Math.round(derived.value * 1000 * 100), 2029);
  assert.equal(deriveLandedCost({ landed: 0.02029 }).value, derived.value);
});

test('supplier decimal addition, box division and VAT use source precision at the threshold', () => {
  const supplier = fields => ({ ...costs(undefined), supplierDelivery: 0, supplierVatRate: 0, supplierVatRecoverable: false, ...fields });
  for (const [price, floor, record, eligible] of [
    [1, 70, supplier({ supplierUnitCost: 0.1, supplierDelivery: 0.2 }), true],
    [0.3, 0, supplier({ supplierUnitCost: 0.1, supplierDelivery: 0.2 }), true],
    [1, 20, supplier({ supplierUnitCost: 0.1, supplierDelivery: 0.7000000000000001 }), false],
    [1, 70, supplier({ boxPrice: 0.3, boxQuantity: 3, supplierDelivery: 0.2 }), true],
    [0.3, 0, supplier({ supplierUnitCost: 0.25, supplierVatRate: 20 }), true],
    [0.05, 20, supplier({ boxPrice: 0.1, boxQuantity: 3, supplierVatRate: 20 }), true],
    [0.05, 20.00001, supplier({ boxPrice: 0.1, boxQuantity: 3, supplierVatRate: 20 }), false],
    [1, 90, supplier({ supplierUnitCost: 0.1, supplierVatRate: 20, supplierVatRecoverable: true }), true]
  ]) {
    const state = fixture(price, record, floor);
    const row = unitEconomics({ price }, record, { marginFloor: floor });
    assert.equal(contributionMeetsMargin(price, record, floor), eligible, JSON.stringify({ price, floor, record }));
    assert.equal(row.status, eligible ? 'profitable' : 'below-floor');
    assert.equal(deriveOperations(state).lowMargin, eligible ? 0 : 1);
    if (eligible) assert.equal(draftMarketingCampaign(state).product.sku, 'TEST');
    else assert.throws(() => draftMarketingCampaign(state), { code: 'NO_MARKETING_CANDIDATE' });
  }
});

test('tiny losses create one high-severity exception and retain its identity on reconciliation', () => {
  const state = Object.assign(seedWorkspaceState({}), fixture(1, costs(1.000001), 0));
  detectExceptions(state);
  const margins = () => state.exceptions.filter(item => item.kind === 'margin');
  assert.equal(margins().length, 1);
  assert.equal(margins()[0].severity, 'high');
  const id = margins()[0].id;
  margins()[0].status = 'dismissed';
  assert.equal(detectExceptions(state).created, 0);
  assert.equal(margins().length, 1);
  assert.equal(margins()[0].status, 'dismissed');
  state.economics.TEST.landed = 1;
  detectExceptions(state);
  assert.equal(margins()[0].present, false);
  state.economics.TEST.landed = 1.000001;
  detectExceptions(state);
  assert.equal(margins().length, 1);
  assert.equal(margins()[0].id, id);
  assert.equal(margins()[0].status, 'open');
  assert.equal(margins()[0].severity, 'high');
  assert.equal(margins()[0].history.length, 2);
});

test('price proposals use the minimum penny that passes the same source-cost threshold', () => {
  for (const [price, record, floor, expected] of [
    [1, costs(0.70001), 30, 1.01],
    [2.55, costs(1.7851), 30, 2.56],
    [1, { ...costs(undefined), supplierUnitCost: 0.1, supplierDelivery: 0.7000000000000001, supplierVatRate: 0, supplierVatRecoverable: false }, 20, 1.01]
  ]) {
    const state = Object.assign(seedWorkspaceState({}), fixture(price, record, floor));
    detectOpportunities(state);
    const proposals = state.opportunities.filter(item => item.kind === 'pricing');
    assert.equal(proposals.length, 1);
    assert.ok(proposals[0].recommendedNextStep.includes(`£${expected.toFixed(2)}`));
    assert.equal(contributionMeetsMargin(expected, record, floor), true);
    assert.equal(contributionMeetsMargin(Number((expected - 0.01).toFixed(2)), record, floor), false);
    assert.equal(proposals[0].estimatedImpact.amount, Number((expected - price).toFixed(2)));
    assert.equal(state.approvals.length, 0);
    assert.equal(state.products[0].variants[0].price, price);
  }
});

test('minimum-price integer oracle covers repeating division and fractional floors', () => {
  for (const costUnits of [0n, 1n, 2029n, 70001n, 178501n, 9999999n]) {
    for (const floorUnits of [0n, 150n, 2000n, 3000n, 9999n]) {
      // Cost units are 1e-5 GBP; floor units are 1e-2 percent. Ceil only at pennies.
      const numerator = costUnits * 10n, denominator = 10000n - floorUnits;
      const cents = numerator === 0n ? 1n : (numerator + denominator - 1n) / denominator;
      const record = costs(Number(costUnits) / 100000);
      const actual = minimumPriceForMargin(record, Number(floorUnits) / 100);
      assert.equal(actual, Number(cents) / 100);
      assert.equal(contributionMeetsMargin(actual, record, Number(floorUnits) / 100), true);
      if (cents > 1n) assert.equal(contributionMeetsMargin(Number(cents - 1n) / 100, record, Number(floorUnits) / 100), false);
    }
  }
  for (const floor of [100, 101, null, undefined, NaN, Infinity]) assert.equal(minimumPriceForMargin(costs(1), floor), null);
  assert.equal(minimumPriceForMargin(costs(1e21), 30), null, 'Unsafe penny representations must not become proposals');
});

test('source lookup falls back to variant identity and incomplete supplier inputs stay blocked', () => {
  const record = { ...costs(undefined), boxPrice: '0.3', boxQuantity: '3', supplierDelivery: '0.2', supplierVatRate: '0', supplierVatRecoverable: false };
  const state = fixture(1, {}, 70);
  state.economics = { v: record };
  assert.equal(deriveOperations(state).lowMargin, 0);
  assert.equal(draftMarketingCampaign(state).product.sku, 'TEST');
  for (const field of ['boxPrice', 'boxQuantity', 'supplierDelivery', 'supplierVatRate', 'supplierVatRecoverable']) {
    const incomplete = { ...record, [field]: undefined };
    assert.equal(contributionMeetsMargin(1, incomplete, 70), false);
    assert.equal(minimumPriceForMargin(incomplete, 70), null);
    assert.equal(unitEconomics({ price: 1 }, incomplete).contribution, null);
    assert.throws(() => draftMarketingCampaign(fixture(1, incomplete, 70)), { code: 'NO_MARKETING_CANDIDATE' });
  }
  assert.equal(contributionMeetsMargin(1, { ...record, boxQuantity: 0 }, 70), false);
  assert.equal(contributionMeetsMargin(1, { ...costs(0.7), boxQuantity: 0 }, 30), true, 'Recorded landed takes precedence over supplier inputs');
});

test('unrepresentable supplier derivation cannot disappear from costs or create apparent profit', () => {
  const record = { ...costs(undefined), boxPrice: 1000000, boxQuantity: 1e-320, supplierDelivery: 0, supplierVatRate: 0, supplierVatRecoverable: false };
  assert.equal(deriveLandedCost(record).complete, false);
  const row = unitEconomics({ price: 1 }, record);
  assert.equal(row.complete, false);
  assert.equal(row.totalVariableCost, null);
  assert.equal(row.contribution, null);
  assert.equal(row.margin, null);
  assert.equal(row.status, 'missing-costs');
  assert.equal(contributionMeetsMargin(1, record, 0), false);
  assert.equal(minimumPriceForMargin(record, 30), null);
  assert.throws(() => draftMarketingCampaign(fixture(1, record, 0)), { code: 'NO_MARKETING_CANDIDATE' });
});
