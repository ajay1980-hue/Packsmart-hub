import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCataloguePrice, unitEconomics } from '../lib/profit.mjs';
import { deriveOperations } from '../lib/operations.mjs';
import { deriveBusinessState } from '../lib/business-state.mjs';
import { deriveBusinessGraph } from '../lib/business-graph.mjs';
import { detectExceptions, detectOpportunities } from '../lib/control.mjs';
import { runSpecialist } from '../lib/agents.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';

const costs = (landed = 6) => ({ landed, packing: 0, handling: 0, delivery: 0, paymentFee: 0, channelFee: 0, advertising: 0, otherVariable: 0 });
const now = new Date('2026-10-07T00:00:00Z');
function catalogue(variants) {
  const state = seedWorkspaceState({}, { workspaceId: 'catalogue-test' });
  state.products = [{ id: 'p1', title: 'Recorded packaging catalogue', provider: 'shopify', status: 'active',
    image: 'https://example.invalid/product.png', description: 'Recorded description. '.repeat(8),
    variants: variants.map((row, index) => ({ id: `v${index}`, inventory: 50, available: true, ...row })) }];
  state.economics = Object.fromEntries(variants.map(row => [row.sku, costs(row.cost ?? 6)]));
  return state;
}

test('cost completeness survives missing price without claiming a financial status', () => {
  for (const price of [undefined, null, '', '   ', false, true, [], {}, NaN, Infinity, -1, '0x10', '0Xff', '0b10', '0B10', '0o10', '0O10']) {
    const result = unitEconomics({ price }, costs());
    assert.equal(result.complete, true, `Recorded costs stay complete for ${String(price)}`);
    assert.deepEqual(result.missingFields, []);
    assert.equal(result.totalVariableCost, 6);
    assert.equal(result.contribution, null);
    assert.equal(result.margin, null);
    assert.equal(result.status, 'missing-price');
  }
  const noPrice = unitEconomics({}, costs());
  assert.equal(noPrice.complete, true, 'Graph callers may ask about costs without a product');
  assert.equal(unitEconomics({ price: null }, { landed: 6 }).status, 'missing-costs');
});

test('finite numeric prices and decimal strings retain their supported syntax', () => {
  for (const price of [0, -0, 10.25, Number.MIN_VALUE, Number.MAX_VALUE, '0', '-0', '0.00', '10.25', ' 10.25 ', '+10.25', '10.', '.25', '1e2', '2.5E-1']) {
    assert.equal(hasCataloguePrice(price), true, `Valid recorded price ${String(price)}`);
  }
  for (const price of ['1_000', '1,000', 'Infinity', 'NaN', '1e309', '10 GBP', '--1']) assert.equal(hasCataloguePrice(price), false);
});

test('explicit zero retains known contribution while a zero-price percentage remains unavailable', () => {
  for (const price of [0, '0', '0.00']) {
    const loss = unitEconomics({ price }, costs());
    assert.equal(loss.complete, true);
    assert.equal(loss.contribution, -6);
    assert.equal(loss.margin, null);
    assert.equal(loss.status, 'loss-making');
    const zero = unitEconomics({ price }, costs(0), { marginFloor: 0 });
    assert.equal(zero.contribution, 0);
    assert.equal(zero.margin, null);
    assert.equal(zero.status, 'margin-unavailable');
  }
  const zeroMargin = unitEconomics({ price: '6.00' }, costs(), { marginFloor: 0 });
  assert.equal(zeroMargin.contribution, 0);
  assert.equal(zeroMargin.margin, 0);
  assert.equal(zeroMargin.status, 'profitable', 'A known zero margin can meet an explicit zero floor');
});

test('catalogue average and coverage use only known percentages while loss rankings retain real negatives', () => {
  const state = catalogue([
    { sku: 'KNOWN', price: 10 }, { sku: 'MISSING', price: null },
    { sku: 'FREE-LOSS', price: 0 }, { sku: 'FREE-ZERO', price: 0, cost: 0 }
  ]);
  const result = deriveOperations(state, { now });
  assert.equal(result.costCoverage, 100);
  assert.equal(result.averageMargin, 40, 'Missing/undefined percentages must not dilute the known average');
  assert.equal(result.marginCoveredVariants, 1);
  assert.equal(result.marginCoverage, 25);
  assert.equal(result.averageMarginBasis, 'unweighted-known-catalogue-contribution-margins');
  assert.equal(result.lowMargin, 0, 'Missing percentages are not below a floor');
  assert.equal(result.negativeMargin, 1, 'A zero selling price with a known cost is a genuine unit loss');
  assert.deepEqual(result.mostProfitable.map(row => row.sku), ['KNOWN', 'FREE-ZERO', 'FREE-LOSS']);
  assert.deepEqual(result.leastProfitable.map(row => row.sku), ['FREE-LOSS', 'FREE-ZERO', 'KNOWN']);
  const business = deriveBusinessState(state, { now });
  assert.equal(business.profitability.averageVariantMargin, 40);
  assert.equal(business.profitability.costCoveragePercent, 100);
  assert.equal(business.profitability.marginCoveredVariants, 1);
  assert.equal(business.profitability.marginCoveragePercent, 25);
  assert.equal(business.profitability.averageVariantMarginBasis, result.averageMarginBasis);
});

test('all unknown prices produce no financial ranking, false low-margin risk or price opportunity', () => {
  const state = catalogue([null, undefined, '', ' ', false].map((price, index) => ({ sku: `UNKNOWN-${index}`, price })));
  const result = deriveOperations(state, { now });
  assert.ok(result.productRows.every(row => row.price === null && row.status === 'missing-price'));
  assert.equal(result.costCoverage, 100);
  assert.equal(result.averageMargin, null);
  assert.equal(result.marginCoveredVariants, 0);
  assert.equal(result.marginCoverage, 0);
  assert.equal(result.lowMargin, 0);
  assert.equal(result.negativeMargin, 0);
  assert.deepEqual(result.mostProfitable, []);
  assert.deepEqual(result.leastProfitable, []);
  detectExceptions(state, 'test', { now });
  detectOpportunities(state, 'test', { now });
  assert.ok(!state.exceptions.some(row => row.kind === 'margin'));
  assert.ok(!state.opportunities.some(row => row.kind === 'pricing'));
  const specialist = runSpecialist('pricing', state, { now });
  assert.equal(specialist.status, 'Warning');
  assert.match(specialist.finding, /margins are unavailable/);
  assert.match(specialist.finding, /0 of 5 catalogue variants/);
  assert.ok(specialist.issues.some(row => row.code === 'INCOMPLETE_MARGIN_EVIDENCE'));
});

test('known catalogue subset remains labelled in pricing analysis and graph cost coverage stays intact', () => {
  const state = catalogue([{ sku: 'KNOWN', price: 10 }, { sku: 'MISSING', price: null }]);
  const specialist = runSpecialist('pricing', state, { now });
  assert.equal(specialist.status, 'Warning');
  assert.match(specialist.finding, /Known catalogue contribution margins meet/);
  assert.match(specialist.finding, /1 of 2 catalogue variants/);
  assert.equal(specialist.data.marginCoverage, 50);
  const graph = deriveBusinessGraph(state);
  const economics = graph.nodes.filter(node => node.type === 'economics');
  assert.equal(economics.length, 2);
  assert.ok(economics.every(node => node.attributes.complete === true));
  assert.ok(economics.every(node => node.attributes.contribution === null));
});
