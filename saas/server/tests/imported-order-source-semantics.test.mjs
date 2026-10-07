import test from 'node:test';
import assert from 'node:assert/strict';
import { IntegrationService } from '../lib/integrations.mjs';
import { projectImportedOrderEvidence } from '../lib/imported-order-evidence.mjs';
import { deriveOperations } from '../lib/operations.mjs';
import { deriveBusinessState } from '../lib/business-state.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';

const workspaceId = 'source-semantics-fixture';
const now = new Date('2026-10-07T12:00:00.000Z');
const period = { startAt: '2026-10-01T00:00:00.000Z', endAt: now.toISOString() };
const money = amount => ({ shopMoney: { amount, currencyCode: 'GBP' } });
function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}

test('actual Shopify mapping retains a derived refund field and current-tax alias without conferring refund authority', async () => {
  const calls = [];
  const service = new IntegrationService({}, { fetchImpl: async (url, options) => {
    calls.push({ url, query: JSON.parse(options.body).query });
    return Response.json({ data: { orders: { nodes: [
      ['derived-only', 'PAID', '100.00'], ['recorded-status', 'PARTIALLY_REFUNDED', '120.00']
    ].map(([id, displayFinancialStatus, current]) => ({
      id, createdAt: '2026-10-06T12:00:00.000Z', updatedAt: '2026-10-06T12:00:00.000Z',
      displayFinancialStatus, displayFulfillmentStatus: 'FULFILLED',
      totalPriceSet: money('120.00'), currentTotalPriceSet: money(current), currentTotalTaxSet: money('20.00'),
      lineItems: { nodes: [{ id: `line-${id}`, sku: 'A', quantity: 1, originalTotalSet: money('100.00'), discountedTotalSet: money('100.00') }], pageInfo: { hasNextPage: false } }
    })), pageInfo: { hasNextPage: false, endCursor: null } } } });
  } });
  const orders = await service.fetchShopifyOrders({ workspaceId, domain: 'fixture-shop.myshopify.com', apiVersion: '2026-07', accessToken: 'synthetic-test-only-token' });
  assert.equal(calls.length, 1);
  assert.ok(calls.every(call => !/\bmutation\b/.test(call.query)));
  assert.equal(orders[0].refunds, 20, 'existing mapper derives the field from totals');
  assert.equal(orders[0].tax, orders[0].currentTax, 'existing tax field repeats current tax');
  const state = frozen({ ...seedWorkspaceState({}, { workspaceId }), orders });
  const before = JSON.stringify(state);
  const evidence = projectImportedOrderEvidence(state, { workspaceId, period, providers: ['shopify'] });
  const paid = evidence.groups.find(group => group.financialStatus === 'PAID');
  assert.equal(paid.recordedAmounts.refunds.knownSubtotal, '20');
  assert.equal(paid.recordedAmounts.tax.knownSubtotal, '20');
  assert.match(evidence.provenance.refunds, /may be derived.*no provider refund/);
  assert.match(evidence.provenance.tax, /original\/current tax basis unverified/);
  const operations = deriveOperations(state, { now });
  assert.equal(operations.refundedOrders30d, 1);
  assert.deepEqual(operations.customerServiceItems.map(row => row.id), ['recorded-status']);
  assert.equal(operations.orderProfitability.find(row => row.id === 'derived-only').recordedStatus.hasRecordedRefund, false);
  assert.equal(operations.orderProfitability.find(row => row.id === 'recorded-status').recordedStatus.hasRecordedRefund, true);
  assert.equal(deriveBusinessState(state, { now }).commerce.refundedOrders30d, 1);
  for (const group of evidence.groups) {
    assert.equal(group.financialQualification.collectedCash, null);
    assert.equal(group.financialQualification.contributionProfit, null);
    assert.equal(group.financialQualification.taxTreatment, 'unverified');
  }
  assert.equal(evidence.completeness.sourcePeriod, 'unverified');
  assert.equal(JSON.stringify(state), before);
});

test('every provider requires recorded refund status; positive fields, asserted provenance and foreign rows add no authority', () => {
  for (const provider of ['shopify', 'ebay', 'meta', 'tiktok_shop', 'pinterest', 'google_youtube', 'whatsapp_business', 'amazon']) {
    const order = (id, financialStatus, extra = {}) => ({ id, provider, financialStatus, fulfillmentStatus: 'FULFILLED',
      createdAt: '2026-10-06T12:00:00.000Z', currency: 'GBP', currentTotal: '80', tax: '12', currentTax: '12', refunds: '20',
      lineItems: [{ id: `line-${id}`, sku: 'A', quantity: 1, net: '80' }], ...extra });
    const state = frozen({ ...seedWorkspaceState({}, { workspaceId }), orders: [
      order('derived', 'PAID', { verified: true, refundVerified: true, sourceEvidence: { refundBasis: 'provider_verified' } }),
      order('unknown', 'UNKNOWN'), order('partial', 'PARTIALLY_REFUNDED', { refunds: null }),
      order('refunded', 'REFUNDED', { refunds: '0' }), order('foreign', 'REFUNDED', { workspaceId: 'other-tenant' })
    ] });
    const operations = deriveOperations(state, { now });
    assert.equal(operations.refundedOrders30d, 2, provider);
    assert.deepEqual(operations.customerServiceItems.map(row => row.id), ['partial', 'refunded'], provider);
    assert.equal(operations.orderProfitability.find(row => row.id === 'derived').refunds, '20');
    assert.equal(operations.orderProfitability.find(row => row.id === 'derived').recordedStatus.hasRecordedRefund, false);
    assert.equal(JSON.stringify(operations).includes('other-tenant'), false);
    assert.equal(operations.last30d.refunds, null);
  }
});
