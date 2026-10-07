import test from 'node:test';
import assert from 'node:assert/strict';
import { projectImportedOrderEvidence, IMPORTED_ORDER_EVIDENCE_LIMITS as LIMITS } from '../lib/imported-order-evidence.mjs';

const workspaceId = 'workspace-one';
const period = { startAt: '2026-09-01T00:00:00Z', endAt: '2026-10-01T00:00:00Z' };
const costs = (landed = '30') => ({ landed, packing: 0, handling: 0, delivery: 0, paymentFee: 0, channelFee: 0, advertising: 0, otherVariable: 0 });
function order(id, extra = {}) {
  return { id, externalId: id, provider: 'shopify', financialStatus: 'PAID', createdAt: '2026-09-15T12:00:00Z', cancelledAt: null,
    total: '100', currentTotal: '100', refunds: '0', tax: '0', currentTax: '0', discounts: '0', shippingCharged: '0', currency: 'GBP',
    lineItems: [{ id: `${id}-line`, sku: 'A', quantity: 1, gross: '100', net: '100' }], ...extra };
}
function state(orders = [], extra = {}) { return { workspace: { id: workspaceId, currency: 'GBP' }, orders, economics: { A: costs() }, ...extra }; }
const project = (input, options = {}) => projectImportedOrderEvidence(input, { workspaceId, period, providers: ['shopify', 'ebay'], ...options });
const first = input => project(input).groups[0];
const total = (group, key = 'netTotal') => group.recordedAmounts[key];

test('unequal-value cost coverage cannot become a period profit or margin', () => {
  const report = project(state([order('small'), order('large', { total: '900', currentTotal: '900', lineItems: [{ sku: 'B', quantity: 1, net: '900' }] })]));
  const group = report.groups[0];
  assert.equal(total(group).completeCohortTotal, '1000');
  assert.deepEqual(group.costNumbers.orderCoverage, { numerator: 1, denominator: 2 });
  assert.deepEqual(group.costNumbers.netTotalCoverage, { numerator: '100', denominator: '1000' });
  assert.equal(group.costNumbers.coveredNetTotal.knownSubtotal, '100');
  assert.equal(group.costNumbers.coveredNetTotal.completeCohortTotal, null);
  assert.equal(group.costNumbers.completeCohort, false);
  assert.equal(group.financialQualification.contributionProfit, null);
  assert.equal(group.financialQualification.grossProfit, null);
  assert.equal(group.financialQualification.marginPercent, null);
  assert.equal(report.completeness.businessTotalsAvailable, false);
  assert.equal(report.completeness.sourcePeriod, 'unverified');
});

test('unknown values, known zero and signed values retain separate meaning', () => {
  const group = first(state([
    order('unknown', { currentTotal: null, total: null, refunds: null, currentTax: null }),
    order('zero', { currentTotal: 0, total: 0, refunds: 0, currentTax: 0 }),
    order('signed', { currentTotal: '-20.25', total: '-15.25', refunds: '-5', currentTax: '-1.25' })
  ]));
  assert.deepEqual(total(group), { knownCount: 2, unknownCount: 1, knownSubtotal: '-20.25', completeCohortTotal: null, complete: false });
  assert.equal(total(group, 'refunds').knownSubtotal, '-5');
  assert.equal(total(group, 'refunds').unknownCount, 1);
  assert.equal(group.costNumbers.netTotalCoverage, null);
  const zero = first(state([order('zero', { currentTotal: 0, total: 0, refunds: 0, currentTax: 0 })]));
  assert.equal(total(zero).completeCohortTotal, '0');
  assert.equal(zero.financialQualification.marginPercent, null);
});

test('a complete order count is not complete monetary coverage', () => {
  const group = first(state([order('one'), order('two', { currentTotal: null, total: null, refunds: null })]));
  assert.equal(group.orders, 2);
  assert.equal(group.costNumbers.completeCohort, true);
  assert.equal(group.costNumbers.netTotalCoverage, null);
  assert.equal(total(group).knownSubtotal, '100');
  assert.equal(total(group).completeCohortTotal, null);
});

test('value-weighted coverage is undefined for mixed signs, nonpositive denominators and unknown net amounts', () => {
  for (const values of [['100', '-10'], ['-100', '-10'], ['0', '0'], ['100', null]]) {
    const report = project(state(values.map((currentTotal, index) => order(`o${index}`, { currentTotal, total: currentTotal, refunds: currentTotal === null ? null : 0 }))));
    assert.equal(report.groups[0].costNumbers.netTotalCoverage, null);
    assert.deepEqual(report.groups[0].costNumbers.orderCoverage, { numerator: 2, denominator: 2 });
  }
});

test('currencies are grouped explicitly and missing currency is not inferred from workspace', () => {
  const report = project(state([order('gbp'), order('usd', { currency: 'USD' }), order('missing', { currency: null }), order('bad', { currency: ' GBP ' })]));
  const gbp = report.groups.find(group => group.currency === 'GBP');
  const usd = report.groups.find(group => group.currency === 'USD');
  const unknown = report.groups.find(group => group.currency === null);
  assert.equal(total(gbp).completeCohortTotal, '100');
  assert.equal(total(usd).completeCohortTotal, '100');
  assert.equal(unknown.orders, 2);
  assert.equal(total(unknown).knownCount, 2);
  assert.equal(total(unknown).knownSubtotal, null);
  assert.equal(total(unknown).completeCohortTotal, null);
  assert.equal(report.counts.unknownCurrencyOrders, 2);
  assert.match(report.provenance.currency, /normalized.*fallback.*no workspace inference or FX/);
  assert.equal(Object.hasOwn(report, 'revenue'), false);
});

test('legacy cost numbers never qualify cost currency, tax or historical assignment', () => {
  const group = first(state([order('one')]));
  assert.equal(group.costNumbers.completeOrders, 1);
  assert.equal(group.costNumbers.completeCohort, true);
  assert.deepEqual(group.costNumbers.netTotalCoverage, { numerator: '100', denominator: '100' });
  assert.equal(group.financialQualification.qualifiedOrders, 0);
  assert.equal(group.financialQualification.currency, 'unverified');
  assert.equal(group.financialQualification.taxTreatment, 'unverified');
  assert.equal(group.financialQualification.historicalCostBasis, 'unverified');
  const invented = first(state([order('one', { verified: true, costCurrency: 'GBP', taxBasis: 'ex-tax', costBasis: 'actual' })], {
    economics: { A: { ...costs(), currency: 'GBP', verified: true, taxBasis: 'ex-tax', effectiveAt: '2026-09-01T00:00:00Z' } }
  }));
  assert.equal(invented.financialQualification.contributionProfit, null, 'unrecognized attestation fields cannot create a trusted contract');
});

test('three-letter currency syntax labels recorded codes without verifying recognition or financial support', () => {
  const report = project(state([order('ordinary'), order('unrecognized', { currency: 'zzz' }), order('missing', { currency: null })]));
  const recorded = report.groups.find(group => group.currency === 'ZZZ');
  assert.equal(total(recorded).completeCohortTotal, '100', 'only the exact recorded-code cohort is complete');
  for (const group of [...report.groups, ...report.skuGroups]) {
    assert.equal(group.currencyStatus, group.currency === null ? 'missing_or_malformed' : 'unverified_recorded_code');
  }
  assert.match(report.provenance.currency, /three-letter recorded code only; recognition and source provenance unverified/);
  for (const group of report.groups) {
    assert.equal(group.financialQualification.currency, 'unverified');
    assert.equal(group.financialQualification.qualifiedOrders, 0);
    assert.equal(group.financialQualification.grossProfit, null);
    assert.equal(group.financialQualification.contributionProfit, null);
    assert.equal(group.financialQualification.marginPercent, null);
    assert.equal(group.financialQualification.collectedCash, null);
  }
});

test('signed, fractional and zero quantities remain recorded evidence without implying sales or return costs', () => {
  for (const [quantity, expected, costComplete] of [['-2', '-2', 0], ['0', '0', 1], ['1.5', '1.5', 0], ['0.0000001', null, 0]]) {
    const report = project(state([order('one', { lineItems: [{ sku: 'A', quantity, net: '100' }] })]));
    const group = report.groups[0], sku = report.skuGroups[0];
    assert.equal(sku.recordedQuantity.knownSubtotal, expected);
    assert.equal(sku.recordedQuantity.completeCohortTotal, expected);
    assert.equal(sku.recordedQuantity.unknownCount, expected === null ? 1 : 0);
    assert.equal(sku.attribution, 'unverified_recorded_sku_only');
    assert.equal(sku.refundsAllocated, false);
    assert.equal(group.costNumbers.completeOrders, costComplete, 'zero permits numeric availability only; signed/fractional quantities cannot establish numeric costs');
    assert.equal(total(group).completeCohortTotal, '100', 'quantity does not rewrite independently recorded order amounts');
    assert.equal(group.financialQualification.qualifiedOrders, 0);
    assert.equal(group.financialQualification.grossProfit, null);
    assert.equal(group.financialQualification.contributionProfit, null);
    assert.equal(group.financialQualification.marginPercent, null);
    assert.equal(group.financialQualification.collectedCash, null);
  }
});

test('exact decimal addition and subtraction preserve large strings and small supported values', () => {
  const group = first(state([order('a', { currentTotal: '999999999999999999999999.999999' }), order('b', { currentTotal: '.000001' })]));
  assert.equal(total(group).completeCohortTotal, '1000000000000000000000000');
  const decimalGroup = first(state([order('a', { currentTotal: 0.1 }), order('b', { currentTotal: '0.2' })]));
  assert.equal(total(decimalGroup).completeCohortTotal, '0.3');
  const signed = first(state([order('one', { currentTotal: null, total: '10', refunds: '15', currentTax: '2' })]));
  assert.equal(total(signed).completeCohortTotal, '-5');
  assert.equal(total(signed, 'netTotalExCurrentTax').completeCohortTotal, '-7');
});

test('unsupported precision and coerced values stay unknown rather than becoming zero', () => {
  for (const value of ['', ' ', true, false, [], {}, NaN, Infinity, 'NaN', '0x10', '1e-8', 0.0000001, '0.0000001', '1000000000000000000000000', Number.MAX_SAFE_INTEGER + 1]) {
    const group = first(state([order('one', { currentTotal: value, total: null, refunds: value })]));
    assert.equal(total(group).knownSubtotal, null, String(value));
    assert.equal(total(group).unknownCount, 1, String(value));
    assert.equal(total(group, 'refunds').knownSubtotal, null, String(value));
  }
});

test('refunded status does not fabricate refunds or current tax', () => {
  const group = first(state([order('one', { financialStatus: 'REFUNDED', refunds: null, currentTotal: null, currentTax: null, tax: '20' })]));
  assert.equal(total(group).knownSubtotal, null);
  assert.equal(total(group, 'refunds').knownSubtotal, null);
  assert.equal(total(group, 'netTotalExCurrentTax').knownSubtotal, null);
  assert.equal(total(group, 'tax').knownSubtotal, '20');
});

test('financial-status and cancellation cohorts do not claim collected cash', () => {
  const statuses = ['PAID', 'AUTHORIZED', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'PENDING', 'mystery'];
  const report = project(state([...statuses.map((financialStatus, index) => order(`s${index}`, { financialStatus })),
    order('cancelled', { cancelledAt: '2026-09-16T00:00:00Z', refunds: '100', currentTotal: '0' })]));
  assert.equal(report.counts.retainedOrders, 8);
  assert.equal(report.counts.cancelledOrders, 1);
  assert.equal(report.groups.find(group => group.cancelled).recordedAmounts.refunds.completeCohortTotal, '100');
  assert.equal(report.financialStatusCohorts.find(row => row.financialStatus === 'PAID').cancelledOrders, 1);
  for (const status of ['AUTHORIZED', 'PARTIALLY_PAID']) {
    const group = report.groups.find(row => row.financialStatus === status);
    assert.equal(group.recordedPaidOrRefunded, false);
    assert.equal(group.financialQualification.collectedCash, null);
  }
  assert.equal(report.groups.find(group => group.financialStatus === 'UNKNOWN').orders, 1);
});

test('half-open UTC period has no future grace, includes its start and excludes its end', () => {
  const report = project(state([
    order('before', { createdAt: '2026-08-31T23:59:59.999Z' }), order('start', { createdAt: period.startAt }),
    order('last', { createdAt: '2026-09-30T23:59:59.999Z' }), order('end', { createdAt: period.endAt }),
    order('future', { createdAt: '2026-10-01T00:00:01Z' })
  ]));
  assert.equal(report.counts.retainedOrders, 2);
  assert.equal(report.counts.outsidePeriodOrders, 3);
  assert.equal(total(report.groups[0]).completeCohortTotal, '200');
  for (const createdAt of ['2026-09-31T00:00:00Z', '2026-09-15', '', null]) {
    const bad = project(state([order('bad', { createdAt })]));
    assert.equal(bad.counts.invalidDateOrders, 1);
    assert.equal(bad.completeness.eligibilityResolved, false);
  }
});

test('normalized identical duplicate orders collapse once without reading customer payloads', () => {
  const original = order('one');
  const duplicate = order('different-local-id', { externalId: 'one', total: 100, currentTotal: 100, currency: 'gbp', financialStatus: 'paid', createdAt: '2026-09-15T12:00:00.000Z', lineItems: structuredClone(original.lineItems),
    customerEmail: 'private@example.com', name: 'private order name', customerId: 'somebody' });
  const report = project(state([original, duplicate]));
  assert.equal(report.counts.retainedOrders, 1);
  assert.equal(report.counts.identicalDuplicateRows, 1);
  assert.equal(total(report.groups[0]).completeCohortTotal, '100');
  assert.equal(report.skuGroups[0].recordedQuantity.completeCohortTotal, '1');
  assert.doesNotMatch(JSON.stringify(report), /private@example|private order|somebody|different-local-id/);
});

test('conflicting duplicates are excluded before date, cancellation and status filtering', () => {
  for (const change of [
    { currentTotal: '900' }, { createdAt: '2026-10-02T00:00:00Z' }, { cancelledAt: '2026-09-15T12:01:00Z' },
    { financialStatus: 'AUTHORIZED' }, { currency: 'USD' }, { lineItems: [{ sku: 'B', quantity: 1, net: '100' }] },
    { currentTotal: false }, { costOverrides: { tenantId: 'foreign' } }
  ]) {
    const report = project(state([order('one'), order('one', change), order('good')]));
    assert.equal(report.counts.conflictingIdentities, 1, JSON.stringify(change));
    assert.equal(report.counts.conflictingDuplicateRows, 2);
    assert.equal(report.counts.retainedOrders, 1);
    assert.equal(total(report.groups[0]).knownSubtotal, '100');
    assert.equal(total(report.groups[0]).completeCohortTotal, null);
  }
  const fallbackConflict = project(state([order('one', { currentTotal: null }), order('one', { currentTotal: false })]));
  assert.equal(fallbackConflict.counts.conflictingIdentities, 1, 'different derived evidence is not an identical normalized duplicate');
});

test('equal source IDs across providers remain separate and different orders are not deduped by SKU or customer', () => {
  const report = project(state([order('same'), order('same', { provider: 'ebay' }), order('different', { customerEmailHash: 'same-customer' })]));
  assert.equal(report.counts.retainedOrders, 3);
  assert.equal(report.counts.identicalDuplicateRows, 0);
  assert.equal(report.groups.length, 2);
  assert.equal(total(report.groups.find(row => row.provider === 'shopify')).completeCohortTotal, '200');
  assert.equal(total(report.groups.find(row => row.provider === 'ebay')).completeCohortTotal, '100');
  assert.equal(new Set(report.references.filter(ref => ref.collection === 'orders').map(ref => ref.identityHash)).size, 3);
});

test('identity requires a recorded source ID and never silently defaults the provider', () => {
  const old = order('legacy'); delete old.externalId;
  const report = project(state([old, order('null-external', { externalId: null }), order('missing-provider', { provider: null }), order('not-selected', { provider: 'ebay' })]), { providers: ['shopify'] });
  assert.equal(report.counts.retainedOrders, 1);
  assert.equal(report.counts.missingIdentityRows, 1);
  assert.equal(report.counts.invalidProviderRows, 1);
  assert.equal(report.counts.excludedProviderRows, 1);
  assert.equal(report.references.find(ref => ref.collection === 'orders').sourceIdField, 'id');
});

test('all tenant marker aliases and malformed nested markers fail closed', () => {
  const markers = [
    { workspaceId: 'foreign' }, { workspace_id: 'foreign' }, { tenantId: 'foreign' }, { tenant_id: 'foreign' },
    { workspace: null }, { workspace: {} }, { tenant: 'foreign' }, { tenant: { id: 'foreign' } },
    { workspace: { id: workspaceId, tenantId: 'foreign' } }, { tenantId: null }
  ];
  for (const marker of markers) {
    const report = project(state([order('bad', marker), order('good')]));
    assert.equal(report.counts.retainedOrders, 1, JSON.stringify(marker));
    assert.equal(report.counts.invalidScopeRows, 1);
    const nested = project(state([order('bad', { lineItems: [{ sku: 'A', quantity: 1, ...marker }] })]));
    assert.equal(nested.counts.retainedOrders, 0);
    assert.equal(nested.counts.invalidLineScopeOrders, 1);
    const costReport = project(state([order('one')], { economics: { A: { ...costs(), ...marker } } }));
    assert.equal(costReport.groups[0].costNumbers.completeOrders, 0);
    assert.equal(costReport.references.some(ref => ref.collection === 'economics'), false);
  }
  assert.throws(() => project({ ...state(), tenant: { id: workspaceId, workspace_id: 'foreign' } }), { code: 'WORKSPACE_MISMATCH' });
});

test('a rejected foreign duplicate cannot leave a favourable same-identity copy', () => {
  for (const orders of [[order('one'), order('one', { tenantId: 'foreign' })], [order('one', { tenantId: 'foreign' }), order('one')]]) {
    const report = project(state(orders));
    assert.equal(report.counts.retainedOrders, 0);
    assert.equal(report.counts.scopeTaintedIdentities, 1);
  }
});

test('tenant scoped explicit numeric overrides replace only their corresponding numeric requirements', () => {
  const partial = { landed: 10, packing: 0, handling: 0 };
  const overrides = { actualShippingCost: 0, paymentFees: 0, channelFees: 0, advertisingCost: 0, otherVariableCosts: 0 };
  const group = first(state([order('one', overrides)], { economics: { A: partial } }));
  assert.equal(group.costNumbers.completeOrders, 1);
  assert.equal(first(state([order('one', { ...overrides, costOverrides: { workspaceId: 'foreign' } })], { economics: { A: partial } })).costNumbers.completeOrders, 0);
  assert.equal(first(state([order('one', { ...overrides, paymentFees: true })], { economics: { A: partial } })).costNumbers.completeOrders, 0);
  for (const actualShippingCost of [false, 'oops', '1e4', '0.0000001']) {
    assert.equal(first(state([order('one', { actualShippingCost })])).costNumbers.completeOrders, 0);
    assert.equal(project(state([order('one'), order('one', { actualShippingCost })])).counts.conflictingIdentities, 1);
  }
});

test('landed derivation requires exact supported precision and every required numeric field', () => {
  const base = { ...costs(), landed: null, boxPrice: '10', boxQuantity: '4', supplierDelivery: '0', supplierVatRate: '20', supplierVatRecoverable: false };
  assert.equal(first(state([order('one')], { economics: { A: base } })).costNumbers.completeOrders, 1);
  assert.equal(first(state([order('one')], { economics: { A: { ...base, boxQuantity: '3' } } })).costNumbers.completeOrders, 0);
  assert.equal(first(state([order('one')], { economics: { A: { ...base, supplierVatRecoverable: null } } })).costNumbers.completeOrders, 0);
  assert.equal(first(state([order('one')], { economics: { A: { ...costs(), advertising: null } } })).costNumbers.completeOrders, 0);
});

test('SKU buckets remain provider scoped and never join duplicate catalogue variants or infer identity', () => {
  const input = state([order('s'), order('e', { provider: 'ebay' })], {
    products: [{ provider: 'shopify', variants: [{ sku: 'A' }, { sku: 'A' }] }, { provider: 'ebay', variants: [{ sku: 'A' }] }],
    ebay: { listings: [{ sku: 'A' }, { sku: 'A' }] }
  });
  const report = project(input);
  assert.equal(report.skuGroups.length, 2);
  assert.equal(new Set(report.skuGroups.map(row => row.skuHash)).size, 2);
  for (const group of report.skuGroups) {
    assert.equal(group.recordedQuantity.completeCohortTotal, '1');
    assert.equal(group.recordedLineNet.completeCohortTotal, '100');
    assert.equal(group.attribution, 'unverified_recorded_sku_only');
    assert.equal(group.refundsAllocated, false);
    assert.equal(Object.hasOwn(group, 'productId'), false);
  }
  assert.deepEqual(project({ ...input, products: [], ebay: {} }), report);
});

test('provider health, products-only success and invented coverage never establish order-period completeness', () => {
  const expected = project(state([order('one')]));
  for (const metadata of [
    { integrationStatus: { shopify: { status: 'connected', lastSyncAt: '2026-10-01T00:00:00Z', lastSuccessfulSyncAt: '2026-10-01T00:00:00Z' } } },
    { connectionSyncs: [{ provider: 'shopify', status: 'completed', areas: ['products'], completedAt: '2026-10-01T00:00:00Z' }] },
    { integrationStatus: { shopify: { status: 'connected', areaSuccessAt: { orders: '2025-01-01T00:00:00Z' } } }, orderPeriodCoverage: { verified: true, complete: true, ...period } }
  ]) assert.deepEqual(project(state([order('one')], metadata)), expected);
  assert.ok(expected.sourcePeriods.every(row => row.status === 'unverified'));
});

test('channel advertising and qualified outcomes cannot change imported-order projection', () => {
  const input = state([order('one', { advertisingCost: '10' })]);
  const expected = project(input);
  assert.deepEqual(project({ ...input, advertisingCosts: [{ channel: 'shopify', spend: 5000 }],
    revenueEngine: { experiments: [{ status: 'completed', impact: { verified: true, incrementalRevenue: 1000000, incrementalContribution: 500000 } }] },
    qualifiedOutcomes: [{ contributionProfit: 1000000, currency: 'GBP' }]
  }), expected);
  assert.equal(expected.groups[0].financialQualification.contributionProfit, null);
});

test('order scan caps cannot be widened and an unseen duplicate prevents completeness claims', () => {
  const rows = Array.from({ length: LIMITS.orders }, (_, index) => order(`o${index}`, { lineItems: [] }));
  rows.push(order('o0', { currentTotal: '99999' }));
  const report = project(state(rows), { limits: { orders: 1000000 }, scanLimit: 1000000 });
  assert.equal(report.counts.scannedOrders, LIMITS.orders);
  assert.equal(report.completeness.truncated.orders, true);
  assert.equal(report.completeness.scanComplete, false);
  assert.equal(total(report.groups[0]).completeCohortTotal, null);
  assert.ok(report.references.length <= LIMITS.references);
});

test('nested-line caps and unseen tenant markers prevent completeness and numeric cost claims', () => {
  const lines = Array.from({ length: LIMITS.linesPerOrder + 1 }, (_, index) => ({ id: `l${index}`, sku: 'A', quantity: 1, net: 1 }));
  lines.at(-1).tenantId = 'foreign';
  const report = project(state([order('one', { lineItems: lines })]));
  assert.equal(report.counts.scannedLines, LIMITS.linesPerOrder);
  assert.equal(report.completeness.truncated.lines, true);
  assert.equal(report.counts.unscannedLineOrders, 1);
  assert.equal(report.counts.retainedOrders, 0);
  assert.equal(report.completeness.eligibilityResolved, false);
  assert.deepEqual(report.groups, []);
  assert.deepEqual(report.references, []);
  const duplicates = project(state([order('one', { lineItems: lines }), order('one', { lineItems: lines })]));
  assert.equal(duplicates.counts.conflictingIdentities, 1);
  const many = project(state(Array.from({ length: 90 }, (_, index) => order(`o${index}`, { lineItems: lines.slice(0, 100) }))));
  assert.equal(many.counts.scannedLines, LIMITS.lines);
  assert.equal(many.completeness.scanComplete, false);
});

test('reference, group, SKU and cost caps are fixed and each suppresses completeness', () => {
  const references = project(state(Array.from({ length: 110 }, (_, index) => order(`o${index}`))));
  assert.equal(references.references.length, LIMITS.references);
  assert.equal(references.completeness.truncated.references, true);
  assert.equal(total(references.groups[0]).completeCohortTotal, null);
  const currencies = Array.from({ length: 70 }, (_, index) => `A${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + index % 26)}`);
  const groups = project(state(currencies.map((currency, index) => order(`o${index}`, { currency }))));
  assert.equal(groups.groups.length, LIMITS.groups);
  assert.equal(groups.completeness.truncated.groups, true);
  assert.ok(groups.groups.every(group => total(group).completeCohortTotal === null));
  const skus = project(state(Array.from({ length: 90 }, (_, index) => order(`o${index}`, { lineItems: [{ sku: `sku${index}`, quantity: 1, net: 1 }] }))));
  assert.equal(skus.skuGroups.length, LIMITS.skuGroups);
  assert.equal(skus.completeness.truncated.skuGroups, true);
  const manyCosts = project(state(Array.from({ length: 21 }, (_, index) => order(`o${index}`, {
    lineItems: Array.from({ length: 100 }, (_, n) => ({ sku: `s${index}-${n}`, quantity: 1, net: 1 }))
  }))));
  assert.equal(manyCosts.counts.referencedCosts, LIMITS.referencedCosts);
  assert.equal(manyCosts.completeness.truncated.referencedCosts, true);
});

test('missing collection differs from an observed empty retained collection, neither is business zero', () => {
  const missing = state(); delete missing.orders;
  const unavailable = project(missing), empty = project(state());
  assert.equal(unavailable.completeness.collectionAvailable, false);
  assert.equal(unavailable.completeness.retainedCohortComplete, false);
  assert.equal(empty.completeness.collectionAvailable, true);
  assert.equal(empty.completeness.retainedCohortComplete, true);
  assert.deepEqual(empty.groups, []);
  assert.equal(empty.completeness.businessTotalsAvailable, false);
  assert.equal(empty.completeness.sourcePeriod, 'unverified');
});

test('malformed or duplicate lines do not produce a complete SKU or cost cohort', () => {
  for (const lineItems of [null, [], [null], [{ id: 'same', sku: 'A', quantity: 1, net: 100 }, { id: 'same', sku: 'A', quantity: 1, net: 100 }]]) {
    const report = project(state([order('one', { lineItems })]));
    assert.equal(report.groups[0].costNumbers.completeOrders, 0);
    assert.ok(report.skuGroups.every(group => group.recordedQuantity.completeCohortTotal === null));
  }
});

test('explicit scope, UTC period and provider selection are mandatory', () => {
  const input = state();
  assert.throws(() => projectImportedOrderEvidence(input), { code: 'WORKSPACE_REQUIRED' });
  assert.throws(() => project(input, { workspaceId: 'another' }), { code: 'WORKSPACE_MISMATCH' });
  for (const period of [null, {}, { startAt: '2026-09-01', endAt: '2026-10-01' }, { startAt: '2026-09-31T00:00:00Z', endAt: '2026-10-01T00:00:00Z' }, { startAt: '2026-10-01T00:00:00Z', endAt: '2026-09-01T00:00:00Z' }]) {
    assert.throws(() => project(input, { period }), { code: 'ORDER_PERIOD_INVALID' });
  }
  for (const providers of [null, [], ['shopify', 'shopify'], ['unknown'], Array(1), ['shopify', , 'ebay']]) assert.throws(() => project(input, { providers }), { code: 'ORDER_PROVIDERS_INVALID' });
});

test('projection is deterministic, JSON-safe and does not mutate or return raw private payloads', () => {
  const input = state([order('secret-order-id', { name: 'secret-order-name', email: 'private@example.com', customerEmailHash: 'private-hash', raw: { token: 'secret-token' } })]);
  const before = structuredClone(input);
  function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } }
  freeze(input);
  const result = project(input);
  assert.deepEqual(result, project(input));
  assert.deepEqual(input, before);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /secret-order|private@example|private-hash|secret-token/);
  assert.ok(result.references.every(reference => /^[a-f0-9]{64}$/.test(reference.identityHash)));
});
