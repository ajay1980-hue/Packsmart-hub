import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveCustomerIntelligence, deriveAttribution, deriveBasketIntelligence,
  deriveAdvertisingIntelligence, deriveGrowthPlan, revenueEngineSnapshot
} from '../lib/revenue-engine.mjs';

const now = new Date('2026-10-01T00:00:00Z');
const options = { now };
const line = (sku = 'A') => ({ sku, quantity: 1, net: '100' });
const order = (id, extra = {}) => ({
  id, provider: 'shopify', customerEmailHash: 'customer-a', createdAt: '2026-09-01T00:00:00Z',
  financialStatus: 'PAID', currency: 'GBP', total: '100', currentTotal: '100', refunds: '0',
  tax: '0', currentTax: '0', lineItems: [line('A'), line('B')], ...extra
});
const stateFor = (orders, extra = {}) => ({ workspace: { id: 'local' }, orders, economics: {}, ...extra });
const costs = { landed: '20', packing: '1', handling: '1', delivery: '5', paymentFee: '2', channelFee: '0', advertising: '0', otherVariable: '0' };
const deepFreeze = value => {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
};
const assertWithheldCustomerMoney = result => {
  for (const field of ['totalRevenue', 'knownContribution', 'profitCoverage', 'averageOrderValue']) assert.equal(result.summary[field], null, field);
  for (const customer of result.customers) {
    for (const field of ['revenue', 'contribution', 'profitCoverage', 'averageOrderValue', 'ltv30', 'ltv60', 'ltv90', 'ltv365']) assert.equal(customer[field], null, field);
    if (customer.favouriteProduct) assert.equal(customer.favouriteProduct.revenue, null);
  }
  assert.ok(result.coverage.labels.includes('source_period_unverified'));
  assert.ok(result.coverage.labels.includes('financial_qualification_missing'));
};

test('mixed currencies and unequal missing costs never become customer revenue, profit or LTV', () => {
  const state = stateFor([
    order('known', { lineItems: [line('A')], createdAt: '2026-07-01T00:00:00Z' }),
    order('unknown', { total: '900', currentTotal: '900', lineItems: [line('MISSING')], createdAt: '2026-08-01T00:00:00Z' }),
    order('usd', { currency: 'USD', createdAt: '2026-09-01T00:00:00Z' }),
    order('missing-money', { currentTotal: null, total: null, refunds: null, currency: null, customerEmailHash: 'customer-b' })
  ], { economics: { A: costs } });
  const result = deriveCustomerIntelligence(state, options);
  assertWithheldCustomerMoney(result);
  assert.equal(result.summary.customers, 2);
  assert.equal(result.summary.repeatCustomers, 1);
  assert.equal(result.customers[0].orderCount, 3);
  assert.equal(result.customers[0].averageReorderDays, 31);
  assert.equal(result.coverage.sourceCounts.retainedOrders, 4);
  assert.equal(result.coverage.sourceCounts.unknownCurrencyOrders, 1);
  assert.equal(result.customers[1].averageReorderDays, null);
});

test('same customer and order IDs in different providers remain distinct and duplicate copies count once', () => {
  const first = order('same');
  const state = stateFor([first, structuredClone(first), order('same', { provider: 'ebay' })]);
  const result = deriveCustomerIntelligence(state, options);
  assert.equal(result.summary.customers, 2);
  assert.equal(result.summary.repeatCustomers, 0);
  assert.deepEqual(result.customers.map(row => row.provider).sort(), ['ebay', 'shopify']);
  assert.equal(result.coverage.sourceCounts.identicalDuplicateRows, 1);
  assert.equal(new Set(result.customers.map(row => row.id)).size, 2);
  assert.ok(result.customers.every(row => !row.id.includes('customer-a')));
  assert.equal(deriveBasketIntelligence(state, options).pairs.length, 2);
});

test('customer-only duplicate metadata conflicts cannot select a favourable customer', () => {
  const state = stateFor([order('same'), order('same', { customerEmailHash: 'other' }), order('valid', { customerEmailHash: 'safe' })]);
  const customers = deriveCustomerIntelligence(state, options);
  assert.equal(customers.summary.customers, 1);
  assert.equal(customers.customers[0].orderCount, 1);
  assert.equal(customers.coverage.consumerConflictingIdentities, 1);
  assert.ok(customers.coverage.labels.includes('consumer_metadata_conflicts'));
  // Unrelated recorded basket evidence survives a customer identity conflict.
  assert.equal(deriveBasketIntelligence(state, options).pairs[0].ordersTogether, 2);
});

test('invalid explicit customer identifiers do not activate a duplicate fallback', () => {
  const a = order('same', { customerEmailHash: undefined, customerId: 'good' });
  const b = { ...a, customerEmailHash: false };
  for (const rows of [[a, b], [b, a]]) {
    const result = deriveCustomerIntelligence(stateFor(rows), options);
    assert.equal(result.summary.customers, 0);
    assert.equal(result.coverage.consumerConflictingIdentities, 1);
  }
});

test('duplicate attribution metadata conflicts are excluded before recorded source grouping', () => {
  const state = stateFor([order('same', { utmSource: 'google' }), order('same', { utmSource: 'email' }), order('safe', { utmSource: 'email' })]);
  const result = deriveAttribution(state, options);
  assert.equal(result.orders.length, 1);
  assert.equal(result.bySource[0].orders, 1);
  assert.equal(result.coverage.consumerConflictingIdentities, 1);
  assert.equal(result.coverage.sourceAttributedOrders, null);
  assert.equal(result.bySource[0].revenue, null);
  assert.equal(result.bySource[0].contribution, null);
});

test('provider is required for touches and a source is never financial attribution', () => {
  const state = stateFor([order('same'), order('same', { provider: 'ebay' })], { revenueEngine: { attributionTouches: [
    { orderId: 'same', kind: 'utm_source', value: 'legacy' },
    { provider: 'shopify', orderId: 'same', kind: 'utm_source', value: 'google' },
    { provider: 'ebay', orderId: 'same', kind: 'utm_source', value: 'email' },
    { provider: 'ebay', orderId: 'same', kind: 'utm_source', value: 'foreign', tenantId: 'other' }
  ] } });
  const result = deriveAttribution(state, options);
  assert.equal(result.orders.find(row => row.provider === 'shopify').source, 'google');
  assert.equal(result.orders.find(row => row.provider === 'ebay').source, 'email');
  assert.equal(result.coverage.unscopedTouchRows, 2);
  assert.equal(result.coverage.recordedSourceCoveragePercent, 100);
  assert.equal(result.coverage.sourceCoveragePercent, null);
  assert.ok(result.orders.every(row => row.revenue === null && row.contribution === null && row.confidence === 'recorded-source-unverified'));
});

test('touches cannot join ambiguous local IDs even with the provider, including outside-period copies', () => {
  const state = stateFor([
    order('local-id', { externalId: 'source-1' }),
    order('local-id', { externalId: 'source-2', createdAt: '2026-12-01T00:00:00Z' })
  ], { revenueEngine: { attributionTouches: [{ provider: 'shopify', orderId: 'local-id', kind: 'source', value: 'google' }] } });
  const result = deriveAttribution(state, options);
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].source, null);
  assert.equal(result.coverage.unscopedTouchRows, 1);
});

test('financial duplicate conflicts including future copies are reconciled before the cohort window', () => {
  const state = stateFor([order('same'), order('same', { createdAt: '2026-12-01T00:00:00Z' }), order('good')]);
  for (const derive of [deriveCustomerIntelligence, deriveAttribution, deriveBasketIntelligence]) {
    const result = derive(state, options);
    assert.equal(result.coverage.sourceCounts.conflictingIdentities, 1);
    assert.equal(result.coverage.sourceCounts.retainedOrders, 1);
  }
});

test('history uses valid UTC dates, an exclusive now boundary, recorded paid/refund statuses and no cancellations', () => {
  const state = stateFor([
    order('paid'), order('partial-refund', { financialStatus: 'PARTIALLY_REFUNDED', refunds: '20' }),
    order('refunded', { financialStatus: 'REFUNDED', refunds: '100', currentTotal: '0' }),
    order('cancelled', { cancelledAt: '2026-09-02T00:00:00Z' }),
    order('authorized', { financialStatus: 'AUTHORIZED' }), order('part-paid', { financialStatus: 'PARTIALLY_PAID' }),
    order('pending', { financialStatus: 'PENDING' }), order('end', { createdAt: now.toISOString() }),
    order('future', { createdAt: '2027-01-01T00:00:00Z' }), order('no-zone', { createdAt: '2026-09-01T00:00:00' }),
    order('invalid-day', { createdAt: '2026-09-31T00:00:00Z' }), order('old', { createdAt: '1969-12-31T23:59:59Z' })
  ]);
  const result = deriveCustomerIntelligence(state, options);
  assert.equal(result.customers[0].orderCount, 3);
  assert.equal(result.coverage.sourceCounts.outsidePeriodOrders, 3);
  assert.equal(result.coverage.sourceCounts.invalidDateOrders, 2);
  assert.equal(result.coverage.sourceCounts.cancelledOrders, 1);
  assert.equal(result.coverage.period.startAt, '1970-01-01T00:00:00.000Z');
  assert.equal(result.coverage.period.endAt, now.toISOString());
  const basket = deriveBasketIntelligence(state, options);
  assert.equal(basket.pairs[0].ordersTogether, 3);
  assert.equal(basket.pairs[0].refundsAllocated, false);
});

test('same-string SKUs remain provider-scoped and delimiter characters cannot create pair collisions', () => {
  const state = stateFor([
    order('shop-1'), order('shop-2'), order('ebay-1', { provider: 'ebay' }),
    order('delimiter-1', { lineItems: [line('A||B'), line('C')] }),
    order('delimiter-2', { lineItems: [line('A'), line('B||C')] }),
    order('names-only', { lineItems: [{ name: 'A' }, { name: 'B' }] })
  ]);
  const result = deriveBasketIntelligence(state, options);
  assert.equal(result.pairs.find(pair => pair.provider === 'shopify' && pair.a === 'A' && pair.b === 'B').ordersTogether, 2);
  assert.equal(result.pairs.find(pair => pair.provider === 'ebay').ordersTogether, 1);
  assert.equal(result.pairs.length, 4);
  assert.equal(result.recommendations.length, 1);
  assert.ok(result.pairs.every(pair => pair.attribution === 'unverified_recorded_sku_only' && pair.refundsAllocated === false));
});

test('missing, contradictory and nested foreign tenant scope never supplies analytic rows', () => {
  for (const state of [stateFor([order('local')], { tenantId: 'foreign' }), { orders: [order('no-workspace')] }, stateFor(null)]) {
    const customer = deriveCustomerIntelligence(state, options);
    assert.equal(customer.summary.customers, null);
    assert.equal(customer.coverage.status, 'unavailable');
    assert.equal(deriveAttribution(state, options).orders.length, 0);
    assert.equal(deriveBasketIntelligence(state, options).pairs.length, 0);
  }
  const state = stateFor([
    order('foreign', { tenantId: 'foreign' }), order('line-foreign', { lineItems: [{ ...line('A'), workspace: { id: 'local', tenant: { id: 'foreign' } } }] }),
    order('good')
  ]);
  assert.equal(deriveCustomerIntelligence(state, options).customers[0].orderCount, 1);
  const attributed = deriveAttribution(stateFor([order('attr', { attribution: { workspaceId: 'foreign', source: 'google' } })]), options);
  assert.equal(attributed.orders.length, 0);
});

test('scan and output caps are explicit and capped order scans cannot establish a touch join', () => {
  const orders = Array.from({ length: 2001 }, (_, i) => order('id-' + i, { lineItems: [] }));
  const state = stateFor(orders, { revenueEngine: { attributionTouches: [{ provider: 'shopify', orderId: 'id-0', kind: 'source', value: 'google' }] } });
  const customers = deriveCustomerIntelligence(state, options);
  assert.equal(customers.coverage.sourceCounts.availableOrders, 2001);
  assert.equal(customers.coverage.sourceCounts.scannedOrders, 2000);
  assert.equal(customers.coverage.completeness.truncated.orders, true);
  assert.equal(customers.coverage.status, 'partial_recorded_cohort');
  assert.equal(deriveAttribution(state, options).coverage.recordedSourceOrders, 0);
  const basket = deriveBasketIntelligence(stateFor([order('pairs', { lineItems: Array.from({ length: 11 }, (_, i) => line('SKU' + i)) })]), options);
  assert.equal(basket.pairs.length, 50);
  assert.equal(basket.coverage.pairsAvailable, 55);
  assert.equal(basket.coverage.pairsTruncated, true);
  assert.ok(basket.coverage.labels.includes('analytic_output_truncated'));
});

test('advertising preserves recorded null/zero/decimal spellings but withholds money totals and ROAS', () => {
  const raw = [
    { id: 'missing', spend: null, attributableRevenue: null },
    { id: 'zero', spend: '0', attributableRevenue: '0', currency: 'GBP' },
    { id: 'usd', spend: '100.000001', attributableRevenue: '900719925474099300000', currency: 'USD', roas: 99 },
    { id: 'bad', spend: '', attributableRevenue: false, currency: 'GBP' },
    { id: 'foreign', spend: '500', tenantId: 'foreign' }
  ];
  const result = deriveAdvertisingIntelligence(stateFor([], { advertisingCosts: raw }));
  assert.deepEqual(result.summary, { spend: null, attributedRevenue: null, roas: null, attributionCoverage: null });
  assert.equal(result.rows.length, 4);
  assert.equal(result.rows[0].spend, null);
  assert.equal(result.rows[0].attributableRevenue, null);
  assert.equal(result.rows[1].spend, '0');
  assert.equal(result.rows[2].attributableRevenue, '900719925474099300000');
  assert.equal(result.rows[3].attributableRevenue, false);
  assert.ok(result.rows.every(row => row.roas === null && row.provenance.collection === 'state.advertisingCosts'));
  assert.equal(result.coverage.excludedScopeRows, 1);
  assert.equal(deriveAdvertisingIntelligence({ advertisingCosts: raw }).rows.length, 0);
});

test('advertising and touch row caps preserve source counts and incomplete labels', () => {
  const state = stateFor([order('one')], {
    advertisingCosts: Array.from({ length: 2001 }, () => ({ spend: null })),
    revenueEngine: { attributionTouches: Array.from({ length: 2001 }, () => ({ provider: 'shopify', orderId: 'one', kind: 'source', value: 'google' })) }
  });
  const ads = deriveAdvertisingIntelligence(state);
  assert.equal(ads.coverage.availableRows, 2001);
  assert.equal(ads.coverage.scannedRows, 2000);
  assert.equal(ads.coverage.truncated, true);
  const attribution = deriveAttribution(state, options);
  assert.equal(attribution.coverage.touchesTruncated, true);
  assert.ok(attribution.coverage.labels.includes('analytic_output_truncated'));
});

test('read-only imported analytics do not mutate orders, intent, pipeline or qualified outcomes', () => {
  const state = deepFreeze(stateFor([order('one')], {
    advertisingCosts: [{ spend: null }], revenueEngine: { intentEvents: [{ id: 'intent' }], quotes: [{ id: 'quote' }], experiments: [{ id: 'verified', impact: { verified: true, incrementalContribution: 999 } }], attributionTouches: [] },
    workRecords: [{ id: 'outcome', impact: { verified: true, incrementalContribution: 1000 } }]
  }));
  const before = JSON.stringify(state);
  assertWithheldCustomerMoney(deriveCustomerIntelligence(state, options));
  deriveAttribution(state, options);
  deriveBasketIntelligence(state, options);
  deriveAdvertisingIntelligence(state);
  assert.equal(JSON.stringify(state), before);
});

test('growth source recommendations describe recorded evidence without confirmed or attributed sales claims', () => {
  const plan = deriveGrowthPlan(stateFor([order('one', { utmSource: 'google' })]));
  const opportunity = plan.opportunities.find(item => item.kind === 'attribution');
  assert.ok(opportunity);
  assert.match(opportunity.evidence, /recorded source labels/);
  assert.match(opportunity.evidence, /remain unverified/);
  assert.doesNotMatch(opportunity.evidence, /confirmed traffic|settled orders/);
  assert.equal(opportunity.estimatedImpact, null);
});


test('snapshot normalization preserves enclosing attribution scope across repeated reads', () => {
  for (const marker of [{ tenantId: 'foreign' }, { workspace: { id: 'local', tenantId: 'foreign' } }]) {
    const state = stateFor([order('one')], { revenueEngine: {
      ...marker, attributionTouches: [{ provider: 'shopify', orderId: 'one', kind: 'source', value: 'FOREIGN CAMPAIGN' }]
    } });
    for (let read = 0; read < 2; read++) {
      const snapshot = revenueEngineSnapshot(state);
      assert.equal(snapshot.attribution.orders[0].source, null);
      assert.equal(snapshot.attribution.coverage.unscopedTouchRows, 1);
      for (const [field, value] of Object.entries(marker)) assert.deepEqual(state.revenueEngine[field], value);
    }
  }
});


test('customer and source detail output is capped while full bounded counts remain explicit', () => {
  const state = stateFor(Array.from({ length: 2000 }, (_, index) => order(`order-${index}`, { customerEmailHash: `customer-${index}`, utmSource: `source-${index}` })));
  const customers = deriveCustomerIntelligence(state, options), attribution = deriveAttribution(state, options);
  assert.equal(customers.summary.customers, 2000);
  assert.equal(customers.customers.length, 100);
  assert.equal(customers.coverage.customersAvailable, 2000);
  assert.equal(customers.coverage.customersReturned, 100);
  assert.equal(customers.coverage.detailRowsTruncated, true);
  assert.equal(attribution.coverage.orders, 2000);
  assert.equal(attribution.orders.length, 100);
  assert.equal(attribution.bySource.length, 100);
  assert.equal(attribution.coverage.sourceGroupsAvailable, 2000);
  assert.equal(attribution.coverage.detailRowsTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(customers)) < 180000);
  assert.ok(Buffer.byteLength(JSON.stringify(attribution)) < 180000);
  assert.equal(customers.summary.totalRevenue, null);
  assert.equal(attribution.orders[0].revenue, null);
});
