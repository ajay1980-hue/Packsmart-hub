import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectImportedOrderEvidence, projectImportedOrderEvidence } from '../lib/imported-order-evidence.mjs';
import { compactOrderEvidence, compactOrderPeriod, orderFinancialView, summarizeOrderInspection } from '../lib/order-analytics.mjs';
import { inspectShopifyOrderSource, orderFinancialMirrorRow, prepareShopifyOrderRead, SHOPIFY_ORDER_SOURCE_LIMITS } from '../lib/shopify-order-source.mjs';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

const workspaceId = 'source-consumer-workspace';
const period = { startAt: '2026-09-01T00:00:00Z', endAt: '2026-10-01T00:00:00Z' };
const ref = 'sor1:' + 'a'.repeat(64);
const secondRef = 'sor1:' + 'b'.repeat(64);
const costs = { landed: '30', packing: '0', handling: '0', delivery: '0', paymentFee: '0', channelFee: '0', advertising: '0', otherVariable: '0' };
function order(id = 'source-order', fields = {}) {
  return { id, externalId: id, provider: 'shopify', financialStatus: 'PAID', fulfillmentStatus: 'FULFILLED',
    createdAt: '2026-09-15T12:00:00Z', updatedAt: '2026-09-16T12:00:00Z', cancelledAt: null,
    currency: 'GBP', total: '100.000000', currentTotal: '90.125000', currentTax: '10.125000',
    discounts: '9.875000', shippingCharged: '0.000000', tax: null, refunds: null, sourceReadRef: ref,
    lineItems: [{ id: 'line-one', sku: 'A', quantity: 1, gross: '100.000000', net: '90.125000' }], ...fields };
}
function state(orders = [order()], fields = {}) {
  return { workspace: { id: workspaceId, currency: 'GBP' }, orders, economics: { A: { ...costs } }, ...fields };
}
const options = { workspaceId, period, providers: ['shopify'] };
const project = value => projectImportedOrderEvidence(value, options);
const amount = (report, field = 'netTotal') => report.groups[0].recordedAmounts[field];
function observedState(orders = [order()]) {
  const read = prepareShopifyOrderRead({ workspaceId, domain: 'private-fixture.myshopify.com', apiVersion: '2026-07' }, orders,
    [{ rows: orders.length, hasNextPage: false, cursorDigest: null, apiVersion: null }],
    { query: 'created_at:>=2026-07-09', startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z', legacyBytes: 0 });
  return state(read.orders, { channelData: { shopify: { orderReads: { schema: 'shopify-order-reads/v1', workspaceId,
    manifests: { [read.ref]: read.manifest }, lastSuccess: read.ref } } } });
}

test('source decimal strings remain exact while source tax and refunds stay unknown', () => {
  const raw = state([order('large', { currentTotal: '999999999999999999999999.999999', currentTax: '.000001' }), order('small', { currentTotal: '.000001', currentTax: '0' })]);
  const before = structuredClone(raw);
  const report = project(raw);
  assert.equal(amount(report).completeCohortTotal, '1000000000000000000000000');
  assert.equal(amount(report, 'netTotalExCurrentTax').completeCohortTotal, '999999999999999999999999.999999');
  for (const field of ['tax', 'refunds']) assert.deepEqual(amount(report, field), { knownCount: 0, unknownCount: 2, knownSubtotal: null, completeCohortTotal: null, complete: false });
  assert.equal(report.sourceObservations.capturedOrders, 2);
  assert.equal(report.sourceObservations.unavailableManifests, 2);
  assert.equal(report.completeness.sourcePeriod, 'unverified');
  assert.equal(report.groups[0].financialQualification.qualifiedOrders, 0);
  assert.deepEqual(raw, before, 'consumer arithmetic never rewrites captured decimal spelling');
});

test('source per-field currency exceptions suppress only incompatible monetary evidence', () => {
  for (const field of ['total', 'currentTotal', 'currentTax', 'discounts', 'shippingCharged']) {
    for (const code of ['USD', null]) {
      const report = project(state([order('one', { sourceCurrencyOverrides: { [field]: code } })]));
      assert.equal(amount(report, field).knownSubtotal, null, `${field}: ${code}`);
      assert.equal(amount(report, field).unknownCount, 1);
      assert.equal(amount(report, field === 'total' ? 'currentTotal' : 'total').knownSubtotal, field === 'total' ? '90.125' : '100');
      if (field === 'currentTotal') assert.equal(amount(report).knownSubtotal, null, 'a rejected current-total pair cannot fall back to total');
      if (field === 'currentTotal' || field === 'currentTax') assert.equal(amount(report, 'netTotalExCurrentTax').knownSubtotal, null);
      assert.equal(report.groups[0].costNumbers.completeOrders, 1, 'owner cost availability is independent of source money currency');
    }
  }
  const absent = project(state([order('missing-current', { currentTotal: null })]));
  assert.equal(amount(absent).knownSubtotal, null, 'unselected refunds cannot establish a source fallback net amount');
});

test('source line currencies cannot be added under the order currency', () => {
  const report = project(state([order('mixed', { sourceCurrencyOverrides: { 'lineItems/0/net': 'USD', 'lineItems/0/gross': null } })]));
  assert.equal(amount(report).completeCohortTotal, '90.125');
  assert.equal(report.skuGroups[0].recordedLineNet.knownSubtotal, null);
  assert.equal(report.skuGroups[0].recordedLineNet.unknownCount, 1);
  assert.equal(report.skuGroups[0].recordedQuantity.completeCohortTotal, '1');
  assert.equal(report.groups[0].costNumbers.completeOrders, 1);
  const missing = project(state([order('missing', { currency: null, sourceCurrencyOverrides: { currentTotal: 'GBP' } })]));
  assert.equal(amount(missing).knownSubtotal, null);
  assert.equal(missing.counts.unknownCurrencyOrders, 1);
});

test('invalid source markers cannot reactivate normalized monetary authority', () => {
  for (const extra of [
    { sourceReadRef: 'forged' }, { sourceReadRef: null },
    { sourceCurrencyOverrides: { currentTotal: 'gbp' } },
    { sourceCurrencyOverrides: { unknownField: 'GBP' } }
  ]) {
    const report = project(state([order('one', extra)]));
    assert.equal(amount(report).knownSubtotal, null, JSON.stringify(extra));
    assert.equal(report.sourceObservations.invalidOrders, 1);
    assert.equal(report.groups[0].costNumbers.completeOrders, 1);
    assert.equal(report.groups[0].financialQualification.contributionProfit, null);
  }
});

test('source authority requires bounded decimal strings and unselected tax and refunds', () => {
  for (const extra of [
    { total: 100 }, { currentTotal: false }, { currentTax: '1e2' },
    { discounts: '.1234567' }, { shippingCharged: '1' + '0'.repeat(24) },
    { tax: '0' }, { refunds: '0' },
    { lineItems: [{ id: 'line-one', sku: 'A', quantity: 1, gross: 100, net: '90.125' }] },
    { lineItems: [{ id: 'line-one', sku: 'A', quantity: 1, gross: '100', net: '.0000001' }] }
  ]) {
    const raw = state([order('invalid-codec', extra)]);
    const source = inspectShopifyOrderSource(raw, raw.orders[0], workspaceId);
    assert.equal(source.format, 'invalid', JSON.stringify(extra));
    const report = project(raw);
    assert.equal(amount(report).knownSubtotal, null);
    assert.equal(report.skuGroups[0].recordedLineNet.knownSubtotal, null);
    assert.equal(report.groups[0].costNumbers.completeOrders, 1);
    assert.equal(Object.hasOwn(orderFinancialMirrorRow(workspaceId, raw.orders[0]).financial_data, 'sourceFormat'), false);
  }
  const ownerNumbers = order('owner-input', { actualShippingCost: 0, paymentFees: 2.5 });
  assert.equal(inspectShopifyOrderSource(state([ownerNumbers]), ownerNumbers, workspaceId).format, 'source');
  assert.equal(orderFinancialMirrorRow(workspaceId, ownerNumbers).financial_data.paymentFees, 2.5);
});

test('retained and evicted descriptors preserve captured amounts without certifying coverage', () => {
  const raw = observedState();
  const retained = project(raw);
  assert.equal(retained.sourceObservations.retainedManifests, 1);
  assert.equal(retained.sourceObservations.unavailableManifests, 0);
  assert.equal(amount(retained).completeCohortTotal, '90.125');
  const before = structuredClone(raw.orders);
  raw.channelData.shopify.orderReads.manifests = {};
  const evicted = project(raw);
  assert.equal(evicted.sourceObservations.retainedManifests, 0);
  assert.equal(evicted.sourceObservations.unavailableManifests, 1);
  assert.deepEqual(evicted.groups, retained.groups);
  assert.deepEqual(raw.orders, before);
  for (const report of [retained, evicted]) {
    assert.equal(report.completeness.sourcePeriod, 'unverified');
    assert.equal(report.completeness.businessTotalsAvailable, false);
    assert.equal(report.groups[0].financialQualification.collectedCash, null);
    assert.doesNotMatch(JSON.stringify(report), /private-fixture|requestedApiVersion|cursorDigest|sourceAccountId|sor1:/);
  }
});

test('forged retained descriptors cannot provide source monetary authority', () => {
  const raw = observedState();
  const sourceRef = raw.orders[0].sourceReadRef;
  raw.channelData.shopify.orderReads.manifests[sourceRef].query = 'created_at:>=2026-01-01';
  const inspected = inspectShopifyOrderSource(raw, raw.orders[0], workspaceId);
  assert.equal(inspected.manifestStatus, 'invalid');
  const report = project(raw);
  assert.equal(report.sourceObservations.invalidManifests, 1);
  assert.equal(amount(report).knownSubtotal, null);
  assert.equal(report.skuGroups[0].recordedLineNet.knownSubtotal, null);
  assert.equal(report.groups[0].costNumbers.completeOrders, 1);
});

test('oversized manifest containers suppress money even when their excess is unreferenced', () => {
  for (const evicted of [false, true]) {
    for (const excessLocation of ['unreferenced_descriptor', 'container_metadata']) {
      const raw = observedState();
      const container = raw.channelData.shopify.orderReads;
      const originalOrders = structuredClone(raw.orders);
      if (evicted) delete container.manifests[raw.orders[0].sourceReadRef];
      const padding = 'x'.repeat(SHOPIFY_ORDER_SOURCE_LIMITS.manifestMapBytes + 1);
      if (excessLocation === 'unreferenced_descriptor') container.manifests[secondRef] = { padding };
      else container.lastAttempt = { status: 'complete', padding };
      const inspected = inspectShopifyOrderSource(raw, raw.orders[0], workspaceId);
      assert.equal(inspected.manifestStatus, 'invalid', `${excessLocation}; evicted=${evicted}`);
      const report = project(raw);
      assert.equal(report.sourceObservations.invalidManifests, 1);
      assert.equal(report.sourceObservations.retainedManifests, 0);
      assert.equal(report.sourceObservations.unavailableManifests, 0);
      assert.equal(amount(report).knownSubtotal, null);
      assert.equal(amount(report).completeCohortTotal, null);
      assert.equal(report.skuGroups[0].recordedLineNet.knownSubtotal, null);
      assert.equal(report.groups[0].costNumbers.completeOrders, 1);
      assert.equal(report.groups[0].financialQualification.qualifiedOrders, 0);
      assert.equal(report.groups[0].financialQualification.contributionProfit, null);
      assert.equal(report.completeness.businessTotalsAvailable, false);
      assert.equal(report.completeness.sourcePeriod, 'unverified');
      assert.deepEqual(raw.orders, originalOrders, 'rejecting metadata must not erase source decimal strings');
    }
  }
});

test('foreign source scope excludes and taints an otherwise favorable duplicate', () => {
  for (const change of [
    raw => { raw.channelData.tenantId = 'foreign'; },
    raw => { raw.channelData.shopify.workspaceId = 'foreign'; },
    raw => { raw.channelData.shopify.orderReads.workspaceId = 'foreign'; },
    raw => { raw.channelData.shopify.orderReads.manifests.tenantId = 'foreign'; },
    raw => { raw.channelData.shopify.orderReads.manifests.workspace = { id: workspaceId, tenantId: 'foreign' }; },
    raw => { raw.channelData.shopify.orderReads.manifests[raw.orders[0].sourceReadRef].tenantId = 'foreign'; },
    raw => { raw.orders[0].sourceCurrencyOverrides = { tenantId: 'foreign' }; },
    raw => { raw.channelData.workspace = { id: workspaceId, tenant: { id: workspaceId, tenantId: 'foreign' } }; },
    raw => { raw.channelData.shopify.orderReads.manifests[raw.orders[0].sourceReadRef].workspace = { id: workspaceId, tenantId: 'foreign' }; },
    raw => { raw.channelData.shopify.orderReads.manifests[raw.orders[0].sourceReadRef].pages[0].tenantId = 'foreign'; },
    raw => { raw.channelData.shopify.orderReads.manifests[raw.orders[0].sourceReadRef].pages[0].tenant = { id: workspaceId, workspaceId: 'foreign' }; },
    raw => { raw.orders[0].sourceCurrencyOverrides = { workspace: { id: workspaceId, tenantId: 'foreign' } }; }
  ]) {
    const raw = observedState();
    const favorable = order(); delete favorable.sourceReadRef;
    raw.orders.push(favorable);
    change(raw);
    const report = project(raw);
    assert.equal(report.counts.invalidScopeRows, 1);
    assert.equal(report.counts.scopeTaintedIdentities, 1);
    assert.equal(report.counts.retainedOrders, 0);
    assert.equal(report.completeness.eligibilityResolved, false);
    assert.deepEqual(report.groups, []);
  }
});

test('duplicate equality includes source refs and currency exceptions before filtering', () => {
  for (const extra of [
    { sourceReadRef: secondRef },
    { sourceCurrencyOverrides: { 'lineItems/0/gross': 'USD' } },
    { sourceCurrencyOverrides: { currentTax: 'USD' } },
    { sourceReadRef: 'invalid' }
  ]) {
    const report = project(state([order('same'), order('same', extra), order('good')]));
    assert.equal(report.counts.conflictingIdentities, 1);
    assert.equal(report.counts.retainedOrders, 1);
    assert.equal(amount(report).knownSubtotal, '90.125');
    assert.equal(amount(report).completeCohortTotal, null);
  }
  const identical = project(state([order(), order()]));
  assert.equal(identical.counts.identicalDuplicateRows, 1);
  assert.equal(identical.sourceObservations.capturedOrders, 1);
  const overCap = order('oversized', { sourceReadRef: 'x'.repeat(262145) });
  assert.equal(inspectShopifyOrderSource(state([overCap]), overCap, workspaceId).fingerprint, null);
  const unresolved = project(state([overCap, structuredClone(overCap)]));
  assert.equal(unresolved.counts.conflictingIdentities, 1);
  assert.equal(unresolved.counts.identicalDuplicateRows, 0, 'unbounded metadata cannot establish source duplicate equality');
});

test('legacy amounts and owner-supplied numeric costs retain their existing behavior', () => {
  const legacy = order('legacy', { currentTotal: null, total: '100.25', refunds: '20.125', tax: '9', currentTax: '3' });
  delete legacy.sourceReadRef;
  const report = project(state([legacy]));
  assert.equal(amount(report).completeCohortTotal, '80.125');
  assert.equal(amount(report, 'tax').completeCohortTotal, '9');
  assert.equal(report.sourceObservations.legacyOrders, 1);
  const source = order('owner-cost', { sourceReadRef: 'invalid', actualShippingCost: '1.25', paymentFees: '2', channelFees: '0', advertisingCost: '0', otherVariableCosts: '0' });
  const missingDefaults = state([source], { economics: { A: { landed: '30', packing: '0', handling: '0' } } });
  assert.equal(project(missingDefaults).groups[0].costNumbers.completeOrders, 1);
  delete source.actualShippingCost;
  assert.equal(project(missingDefaults).groups[0].costNumbers.completeOrders, 0);
});

test('compact and per-order DTOs expose bounded observation availability without read identities', () => {
  const raw = observedState();
  const inspection = { ...inspectImportedOrderEvidence(raw, options), period, providers: ['shopify'] };
  const report = inspection.evidence;
  const compact = compactOrderEvidence(report);
  const periodView = compactOrderPeriod(summarizeOrderInspection(inspection));
  const financial = orderFinancialView(inspection, inspection.rows[0]);
  for (const view of [compact, periodView.importedOrderEvidence, financial.importedOrderEvidence]) {
    assert.deepEqual(view.sourceObservations, report.sourceObservations);
    assert.equal(view.completeness.sourcePeriod, 'unverified');
    assert.doesNotMatch(JSON.stringify(view), /sor1:|sourceReadRef|manifests|accountId|endCursor/);
  }
  assert.equal(financial.complete, false);
  assert.equal(financial.grossRevenue, null);
});

test('financial mirror retains exact source amounts and stable metadata without volatile read references', () => {
  const source = order('mirror', { total: '999999999999999999999999.123456', sourceCurrencyOverrides: { discounts: null } });
  const row = orderFinancialMirrorRow(workspaceId, source, '2026-10-01T00:00:00Z');
  assert.equal(row.financial_data.total, source.total);
  assert.equal(row.financial_data.currentTotal, '90.125000');
  assert.equal(row.financial_data.sourceCurrency, 'GBP');
  assert.equal(typeof row.financial_data.sourceFormat, 'string');
  assert.deepEqual(row.financial_data.sourceCurrencyOverrides, { discounts: null });
  assert.equal(row.line_items[0].net, '90.125000');
  assert.doesNotMatch(JSON.stringify(row), /sor1:|sourceReadRef|manifests|lastAttempt/);
  assert.deepEqual(orderFinancialMirrorRow(workspaceId, { ...source, sourceReadRef: secondRef }, '2026-10-01T00:00:00Z'), row);
  const invalid = orderFinancialMirrorRow(workspaceId, { ...source, sourceReadRef: 'invalid' });
  assert.equal(Object.hasOwn(invalid.financial_data, 'sourceFormat'), false);
  const legacy = { ...source }; delete legacy.sourceReadRef; delete legacy.sourceCurrencyOverrides;
  const legacyRow = orderFinancialMirrorRow(workspaceId, legacy);
  assert.equal(Object.hasOwn(legacyRow.financial_data, 'total'), false, 'legacy mirror behavior remains unchanged');
});

test('warm unchanged source mirrors skip writes when only source observation references change', async () => {
  const fake = fakeSupabase();
  const store = createStore({ SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-only' }, { fetchImpl: fake.fetchImpl });
  const raw = seedWorkspaceState({}, { workspaceId, name: 'Source consumers', email: 'source@example.test', passwordHash: 'fixture-only' });
  raw.orders = [order()];
  await store.save(workspaceId, raw);
  const before = fake.calls.length;
  raw.orders[0].sourceReadRef = secondRef;
  await store.save(workspaceId, raw);
  assert.equal(fake.calls.slice(before).filter(call => call.method === 'POST' && call.url.pathname.endsWith('/order_financials')).length, 0);
  assert.equal(fake.tables.get('order_financials')[0].financial_data.total, '100.000000');
  assert.equal(fake.states.get(workspaceId).orders[0].sourceReadRef, secondRef);
  const costBefore = fake.calls.length;
  raw.orders[0].actualShippingCost = '4.125000';
  await store.save(workspaceId, raw);
  assert.equal(fake.calls.slice(costBefore).filter(call => call.method === 'POST' && call.url.pathname.endsWith('/order_financials')).length, 1);
  assert.equal(fake.tables.get('order_financials')[0].financial_data.actualShippingCost, '4.125000');
});

test('typed reporting total uses its own recorded currency while JSONB retains field exceptions', async () => {
  const fake = fakeSupabase();
  const store = createStore({ SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-only' }, { fetchImpl: fake.fetchImpl });
  const raw = seedWorkspaceState({}, { workspaceId });
  raw.orders = [order('different-currency', { total: '100.123', sourceCurrencyOverrides: { total: 'KWD' } })];
  await store.save(workspaceId, raw);
  assert.equal(fake.tables.get('orders')[0].currency, 'KWD');
  assert.equal(fake.tables.get('orders')[0].total, 100.123, 'the existing numeric projection is explicitly lossy at PostgreSQL numeric(14,2)');
  assert.equal(fake.tables.get('order_financials')[0].financial_data.total, '100.123');
  assert.equal(fake.tables.get('order_financials')[0].financial_data.sourceCurrency, 'GBP');
  assert.deepEqual(fake.tables.get('order_financials')[0].financial_data.sourceCurrencyOverrides, { total: 'KWD' });
});
