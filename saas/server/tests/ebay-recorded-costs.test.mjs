import assert from 'node:assert/strict';
import test from 'node:test';
import { IntegrationService } from '../lib/integrations.mjs';
import { calculateOrderProfit } from '../lib/profit.mjs';

const costFields = [
  ['actualShippingCost', 'delivery', 'actual outbound delivery cost', ['postageCost']],
  ['paymentFees', 'paymentFee', 'payment processing fee', ['paymentProcessingFees']],
  ['channelFees', 'channelFee', 'marketplace / channel fee', ['ebayFees', 'fees', 'totalMarketplaceFee']],
  ['advertisingCost', 'advertising', 'advertising allocation', ['promotedListingFee', 'adFees']],
  ['otherVariableCosts', 'otherVariable', 'other variable cost', []]
];
const zeroOrderCosts = Object.fromEntries(costFields.map(([field]) => [field, 0]));
const productCosts = { 'SYNTHETIC-SKU': { landed: 0, packing: 0, handling: 0 } };
const wrapAmounts = [value => value, value => ({ value }), amount => ({ amount })];
const malformed = [
  undefined, null, '', ' ', '\t\n', '\u00a0', false, true,
  [], [0], ['2'], [null], {}, { currency: 'GBP' },
  '0x10', '0Xff', '0b10', '0B10', '0o10', '0O10',
  'Infinity', '-Infinity', 'NaN', '1e309', '1_000', '1,000',
  '10 GBP', '--1', '.', '+', '1e', '1 2'
];
const valid = [
  0, 2.5, -2.5, '0', '-0', '+0', '0.00', ' .0 ', '0e2',
  '2.50', ' 2.50 ', '\t-2.50\n', '+2.50', '2.', '.25', '-.25',
  '1e2', '2.5E-1', '-2.5E+1', '0002.50', '1.234567890123456789'
];

function sourceOrder(id, overrides = {}) {
  return {
    orderId: id, creationDate: '2026-10-09T12:00:00.000Z',
    lastModifiedDate: '2026-10-09T12:00:00.000Z', orderPaymentStatus: 'PAID',
    total: { value: '100.00', currency: 'GBP' }, refunds: 0, tax: 0,
    ...zeroOrderCosts,
    lineItems: [{ lineItemId: 'synthetic-line', sku: 'SYNTHETIC-SKU', quantity: 1, total: 100 }],
    ...overrides
  };
}

// Exercise the public integration entrypoint, including JSON decoding and the
// private mapper. The injected transport handles every request without network IO.
async function importOrders(orders) {
  const requests = [];
  const origin = 'https://ebay-manager.example.test';
  const service = new IntegrationService({
    NODE_ENV: 'production', EBAY_ENV_WORKSPACE_ID: 'synthetic-workspace',
    EBAY_MANAGER_BASE_URL: origin, EBAY_EXPECTED_ACCOUNT: 'synthetic-seller'
  }, {
    fetchImpl: async (url, options) => {
      requests.push(String(url));
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      if (url === `${origin}/api/ebay/status`) return Response.json({ connected: true, account: 'synthetic-seller' });
      if (url === `${origin}/api/ebay/orders`) return Response.json({ orders });
      if (url === `${origin}/api/ebay/fees`) return Response.json({ fees: [] });
      assert.fail(`Unexpected synthetic request: ${url}`);
    }
  });
  const state = { workspace: { id: 'synthetic-workspace' }, products: [], orders: [], integrationStatus: {} };
  const status = await service.syncEbay(state, { areas: ['orders'] });
  assert.equal(status.status, 'connected');
  assert.equal(status.lastError, null);
  assert.deepEqual(requests.sort(), ['/api/ebay/fees', '/api/ebay/orders', '/api/ebay/status'].map(path => `${origin}${path}`));
  assert.equal(state.orders.length, orders.length);
  return state.orders;
}

for (const [field, breakdownField, label] of costFields) {
  test(`imported eBay ${field} rejects malformed raw and wrapped costs before profit derivation`, async () => {
    const inputs = malformed.flatMap(value => wrapAmounts.map(wrap => wrap(value)));
    inputs.push(
      { value: { value: '0' } }, { value: { amount: '0' } },
      { amount: { value: '0' } }, { amount: { amount: '0' } },
      { value: { amount: '2' }, amount: '3' },
      { value: false, amount: '2' }, { value: '', amount: '2' }
    );
    const orders = await importOrders(inputs.map((value, index) => sourceOrder(`bad-${field}-${index}`, { [field]: value })));
    orders.forEach((order, index) => {
      assert.equal(order[field], null, `${field}: ${JSON.stringify(inputs[index])} stays unknown`);
      const result = calculateOrderProfit(order, productCosts);
      assert.equal(result.complete, false);
      assert.equal(result.basis, 'incomplete');
      assert.equal(result.totalVariableCost, null);
      assert.equal(result.contribution, null);
      assert.equal(result.margin, null);
      assert.deepEqual(result.missingFields, [`SYNTHETIC-SKU: ${label}`]);
    });
  });

  test(`imported eBay ${field} retains explicit zero, signed decimals and existing one-level wrappers`, async () => {
    const inputs = valid.flatMap(value => wrapAmounts.map(wrap => ({ input: wrap(value), expected: Number(value) })));
    inputs.push(
      { input: { value: 0, amount: '2' }, expected: 0 },
      { input: { value: null, amount: '-2.50' }, expected: -2.5 },
      { input: { value: '-1.25', amount: '2' }, expected: -1.25 }
    );
    const orders = await importOrders(inputs.map(({ input }, index) => sourceOrder(`valid-${field}-${index}`, { [field]: input })));
    orders.forEach((order, index) => {
      const expected = inputs[index].expected;
      assert.equal(order[field], expected, `${field}: ${JSON.stringify(inputs[index].input)}`);
      const result = calculateOrderProfit(order, productCosts);
      assert.equal(result.complete, true);
      assert.equal(result.basis, 'confirmed-costs');
      assert.deepEqual(result.missingFields, []);
      if (expected === 0) {
        assert.equal(result.breakdown[breakdownField], 0);
        assert.equal(result.totalVariableCost, 0);
        assert.equal(result.contribution, 100);
        assert.equal(result.margin, 100);
      }
    });
  });
}

test('eBay cost aliases retain their nullish priority while malformed selected values stay unknown', async () => {
  const cases = [];
  for (const [field, , , aliases] of costFields) {
    for (const alias of aliases) {
      cases.push({ field, expected: -2.5, overrides: { [field]: null, [alias]: { amount: '-2.50' } } });
      cases.push({ field, expected: 0, overrides: { [field]: 0, [alias]: { value: '2.50' } } });
      cases.push({ field, expected: null, overrides: { [field]: false, [alias]: { value: '2.50' } } });
      cases.push({ field, expected: null, overrides: { [field]: undefined, [alias]: { value: [] } } });
    }
    if (aliases.length > 1) cases.push({ field, expected: null, overrides: { [field]: null, [aliases[0]]: '', [aliases[1]]: 2.5 } });
  }
  const orders = await importOrders(cases.map(({ overrides }, index) => sourceOrder(`alias-${index}`, overrides)));
  orders.forEach((order, index) => assert.equal(order[cases[index].field], cases[index].expected));
});

test('eBay mapped costs preserve precision and existing profit rounding', async () => {
  const [order] = await importOrders([sourceOrder('precise-costs', {
    actualShippingCost: { value: '1.23456' }, paymentFees: { amount: '-.25' },
    channelFees: '+2.50', advertisingCost: '0.00', otherVariableCosts: 0
  })]);
  assert.equal(order.actualShippingCost, 1.23456);
  const result = calculateOrderProfit(order, productCosts);
  assert.equal(result.complete, true);
  assert.equal(result.breakdown.delivery, 1.2346);
  assert.equal(result.breakdown.paymentFee, -0.25);
  assert.equal(result.totalVariableCost, 3.48);
  assert.equal(result.contribution, 96.52);
  assert.equal(result.margin, 96.52);
});

test('eBay cost validation leaves non-cost mapper conversions unchanged', async () => {
  const [order] = await importOrders([sourceOrder('unchanged-non-costs', {
    total: false, refunds: ' ', tax: [0], currentTax: true,
    discounts: '0x10', shippingCharged: [],
    lineItems: [{ lineItemId: 'synthetic-line', sku: 'SYNTHETIC-SKU', quantity: '2', gross: true, net: ['4'] }]
  })]);
  assert.equal(order.total, 0);
  assert.equal(order.currentTotal, 0);
  assert.equal(order.refunds, 0);
  assert.equal(order.tax, 0);
  assert.equal(order.currentTax, 1);
  assert.equal(order.discounts, 16);
  assert.equal(order.shippingCharged, 0);
  assert.equal(order.lineItems[0].quantity, 2);
  assert.equal(order.lineItems[0].gross, 1);
  assert.equal(order.lineItems[0].net, 4);
});
