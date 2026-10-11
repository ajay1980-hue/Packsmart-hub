import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REQUIRED_UNIT_COSTS, amount, calculateOrderProfit, deriveLandedCost,
  hasAmount, hasCataloguePrice, orderRevenue, unitEconomics
} from '../lib/profit.mjs';
import { flattenProducts } from '../lib/operations.mjs';

const malformed = [
  '', ' ', '\t\n', '\u00a0', false, true, [], [0], ['2'], {},
  '0x10', '0Xff', '0b10', '0B10', '0o10', '0O10',
  'Infinity', '-Infinity', 'NaN', '1e309', '1_000', '1,000',
  '10 GBP', '--1', '.', '+', '1e', '1 2'
];
const unknown = [undefined, null, NaN, Infinity, -Infinity, ...malformed];
const zeroCosts = () => Object.fromEntries(REQUIRED_UNIT_COSTS.map(({ id }) => [id, 0]));
const knownOrder = () => ({
  total: 20, currentTotal: 15, refunds: 5, currentTax: 2,
  lineItems: [{ id: 'line-1', sku: 'RECORDED', quantity: 2, net: 12 }]
});

test('recorded amounts accept finite numbers and the existing signed decimal string grammar', () => {
  for (const value of [
    0, -0, 10.25, -10.25, Number.MIN_VALUE, -Number.MIN_VALUE,
    Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 1,
    '0', '-0', '+0', '0.00', ' 10.25 ', '\t-10.25\n', '+10.25',
    '10.', '.25', '-.25', '1e2', '2.5E-1', '-2.5E+1', '0002.50',
    '1.234567890123456789', '1e-400'
  ]) {
    assert.equal(hasAmount(value), true, `Recorded amount ${String(value)} stays supported`);
    assert.equal(amount(value, null), Number(value));
  }
  assert.equal(hasAmount('-1.25'), true);
  assert.equal(hasCataloguePrice('-1.25'), false, 'Catalogue prices retain their separate nonnegative rule');
});

test('missing or malformed recorded amounts do not qualify as evidence', () => {
  for (const value of unknown) {
    assert.equal(hasAmount(value), false, `Reject ${JSON.stringify(value)}`);
  }
});

test('non-JSON values never invoke implicit numeric conversion', () => {
  const coercible = { [Symbol.toPrimitive]() { throw new Error('Unexpected numeric coercion'); } };
  for (const value of [0n, 1n, Symbol('amount'), new Number(0), new String('2'), new Date(0), coercible]) {
    assert.equal(hasAmount(value), false);
    assert.equal(hasCataloguePrice(value), false);
  }
});

test('general numeric conversion and existing stock interpretation remain unchanged', () => {
  for (const [inventory, expected] of [[[50], 50], ['0x32', 50], [true, 1], [false, 0], [null, null], [undefined, null], ['2.5', 2.5], [0, 0], ['', 0], [{}, 0]]) {
    const [row] = flattenProducts([{ id: 'stock', variants: [{ id: 'v', inventory }] }]);
    assert.equal(row.inventory, expected);
  }
  assert.equal(amount(false), 0, 'Generic conversion is not a recorded-amount validator');
  assert.equal(amount('0x32'), 50);
  assert.equal(amount('invalid', 20), 20);
});

test('every required unit cost rejects malformed or missing evidence', () => {
  for (const { id, label } of REQUIRED_UNIT_COSTS) {
    for (const value of unknown) {
      const result = unitEconomics({ price: 10 }, { ...zeroCosts(), [id]: value });
      assert.equal(result.complete, false, `${id}: ${JSON.stringify(value)} cannot establish cost coverage`);
      assert.equal(result.costs[id], null);
      assert.equal(result.totalVariableCost, null);
      assert.equal(result.contribution, null);
      assert.equal(result.margin, null);
      assert.equal(result.status, 'missing-costs');
      assert.ok(result.missingFields.length > 0);
      if (id !== 'landed') assert.ok(result.missingFields.includes(label));
    }
  }
});

test('explicit numeric and decimal zeros remain complete unit and order costs', () => {
  for (const value of [0, -0, '0', '-0', '0.00', '+0', ' .0 ', '0e2']) {
    const record = Object.fromEntries(REQUIRED_UNIT_COSTS.map(({ id }) => [id, value]));
    const unit = unitEconomics({ price: 10 }, record);
    assert.equal(unit.complete, true);
    assert.equal(unit.totalVariableCost, 0);
    assert.equal(unit.contribution, 10);
    assert.equal(unit.margin, 100);
    const order = calculateOrderProfit({ ...knownOrder(), refunds: value, currentTax: value }, { RECORDED: record });
    assert.equal(order.complete, true);
    assert.equal(order.totalVariableCost, 0);
    assert.equal(order.contribution, 15);
    assert.equal(order.margin, 100);
  }
});

test('supplier derivation requires valid unit cost, delivery allocation and VAT rate', () => {
  const supplier = { supplierUnitCost: '2.50', supplierDelivery: '.25', supplierVatRate: '20', supplierVatRecoverable: false };
  assert.deepEqual(deriveLandedCost(supplier), { value: 3.25, source: 'supplier-unit-cost', complete: true, missing: [] });
  for (const [field, label] of [
    ['supplierUnitCost', 'supplier unit cost or box price / quantity'],
    ['supplierDelivery', 'supplier delivery allocation'],
    ['supplierVatRate', 'supplier VAT rate']
  ]) {
    for (const value of unknown) {
      const result = deriveLandedCost({ ...supplier, [field]: value });
      assert.equal(result.complete, false, `${field}: ${JSON.stringify(value)}`);
      assert.equal(result.value, null);
      assert.ok(result.missing.includes(label));
    }
  }
  assert.equal(deriveLandedCost({ ...supplier, supplierVatRecoverable: 'false' }).complete, false);
  assert.equal(deriveLandedCost({ ...supplier, supplierVatRecoverable: true }).value, 2.75);
});

test('supplier box derivation preserves positive quantity requirements and existing arithmetic', () => {
  const supplier = { boxPrice: '120', boxQuantity: '100', supplierDelivery: '.1', supplierVatRate: '20', supplierVatRecoverable: false };
  assert.deepEqual(deriveLandedCost(supplier), { value: 1.54, source: 'supplier-box-price', complete: true, missing: [] });
  for (const field of ['boxPrice', 'boxQuantity']) {
    for (const value of unknown) {
      assert.equal(deriveLandedCost({ ...supplier, [field]: value }).complete, false, `${field}: ${JSON.stringify(value)}`);
    }
  }
  for (const value of [0, '0.00', -1, '-1']) assert.equal(deriveLandedCost({ ...supplier, boxQuantity: value }).complete, false);
  assert.equal(deriveLandedCost({ ...supplier, boxPrice: '0.00' }).value, 0.1);
  assert.equal(deriveLandedCost({ ...supplier, boxPrice: '-120' }).value, -1.34);
  assert.equal(deriveLandedCost({ ...supplier, boxPrice: 1, boxQuantity: 3 }).value, 0.5);
});

test('valid supplier evidence can replace an unknown direct landed amount without changing stored evidence', () => {
  const supplier = { supplierUnitCost: '2.50', supplierDelivery: '0', supplierVatRate: '0', supplierVatRecoverable: false };
  for (const landed of unknown) {
    const result = deriveLandedCost({ ...supplier, landed });
    assert.equal(result.source, 'supplier-unit-cost');
    assert.equal(result.value, 2.5);
    assert.equal(result.complete, true);
  }
  for (const landed of [0, '0.00', '-.25']) {
    const result = deriveLandedCost({ ...supplier, landed });
    assert.equal(result.source, 'recorded');
    assert.equal(result.value, Number(landed));
  }
  assert.equal(deriveLandedCost({ ...supplier, supplierUnitCost: 0, supplierDelivery: '0.00', supplierVatRate: '0e0' }).value, 0);
});

test('malformed legacy unit, supplier and order values remain byte-for-byte unchanged by calculations', () => {
  for (const value of malformed) {
    const raw = JSON.stringify({
      economics: { RECORDED: { ...zeroCosts(), landed: value, supplierUnitCost: value, supplierDelivery: value, supplierVatRate: value, supplierVatRecoverable: false } },
      order: { ...knownOrder(), refunds: value, currentTax: value, paymentFees: value }
    });
    const legacy = JSON.parse(raw);
    deriveLandedCost(legacy.economics.RECORDED);
    unitEconomics({ price: 10 }, legacy.economics.RECORDED);
    orderRevenue(legacy.order);
    calculateOrderProfit(legacy.order, legacy.economics);
    assert.equal(JSON.stringify(legacy), raw);
  }
});

test('malformed required order revenue inputs do not make complete profitability', () => {
  for (const value of unknown) {
    for (const field of ['refunds', 'currentTax']) {
      const result = calculateOrderProfit({ ...knownOrder(), [field]: value }, { RECORDED: zeroCosts() });
      assert.equal(result.complete, false, `${field}: ${JSON.stringify(value)}`);
      assert.equal(result.contribution, null);
      assert.equal(result.margin, null);
      assert.ok(result.missingFields.includes(field === 'refunds' ? 'refund amount' : 'tax / VAT amount'));
    }
    const revenue = orderRevenue({ total: value, refunds: 0, tax: 0 });
    assert.equal(revenue.grossRevenue, null);
    assert.equal(revenue.netRevenue, null);
    assert.equal(revenue.revenueExTax, null);
    const result = calculateOrderProfit({ ...knownOrder(), total: value, currentTotal: value }, { RECORDED: zeroCosts() });
    assert.equal(result.complete, false);
    assert.ok(result.missingFields.includes('net order revenue'));
  }
});

test('order revenue falls back only to valid existing recorded amounts', () => {
  for (const value of unknown) {
    assert.deepEqual(orderRevenue({ total: 20, currentTotal: value, refunds: 5, currentTax: value, tax: 2, discounts: value, shippingCharged: value }), {
      grossRevenue: 20, netRevenue: 15, revenueExTax: 13, refunds: 5, tax: 2, discounts: null, shippingCharged: null
    });
    assert.equal(orderRevenue({ total: 20, financialStatus: 'REFUNDED', refunds: value, tax: 0 }).refunds, 20);
    assert.equal(orderRevenue({ total: value, financialStatus: 'REFUNDED', tax: 0 }).refunds, null);
  }
});

test('malformed order cost overrides cannot establish actual cost coverage or replace unit costs', () => {
  const fields = [
    ['actualShippingCost', 'delivery'], ['paymentFees', 'paymentFee'],
    ['channelFees', 'channelFee'], ['advertisingCost', 'advertising'], ['otherVariableCosts', 'otherVariable']
  ];
  for (const [orderField, unitField] of fields) {
    for (const value of unknown) {
      const result = calculateOrderProfit({ ...knownOrder(), [orderField]: value }, { RECORDED: { ...zeroCosts(), [unitField]: 1 } });
      assert.equal(result.complete, true);
      assert.equal(result.breakdown[unitField], 2, `${orderField}: ${JSON.stringify(value)} uses valid unit cost`);
      const missing = calculateOrderProfit({ ...knownOrder(), [orderField]: value }, { RECORDED: { ...zeroCosts(), [unitField]: undefined } });
      assert.equal(missing.complete, false);
      assert.equal(missing.contribution, null);
    }
  }
  const overrides = Object.fromEntries(fields.map(([field]) => [field, false]));
  assert.equal(calculateOrderProfit({ ...knownOrder(), ...overrides }, { RECORDED: zeroCosts() }).basis, 'estimated-costs');
  const explicitZero = Object.fromEntries(fields.map(([field]) => [field, '0.00']));
  assert.equal(calculateOrderProfit({ ...knownOrder(), ...explicitZero }, { RECORDED: zeroCosts() }).basis, 'confirmed-costs');
});

test('line quantity and sales reject implicit coercion while preserving supported numeric strings', () => {
  for (const value of unknown) {
    const result = calculateOrderProfit({ ...knownOrder(), lineItems: [{ sku: 'RECORDED', quantity: value, net: value }] }, { RECORDED: zeroCosts() });
    assert.equal(result.complete, false, `quantity ${JSON.stringify(value)}`);
    assert.ok(result.missingFields.includes('RECORDED quantity'));
    assert.equal(result.lines[0].netSales, null);
  }
  const result = calculateOrderProfit({ ...knownOrder(), lineItems: [{ sku: 'RECORDED', quantity: '2.9', net: false, discountedTotal: '12.50' }] }, { RECORDED: zeroCosts() });
  assert.equal(result.complete, true);
  assert.equal(result.lines[0].quantity, 2);
  assert.equal(result.lines[0].netSales, 12.5);
});

test('signed historical costs, taxes and existing refund clamps retain their semantics', () => {
  const record = { ...zeroCosts(), landed: '-2.50', packing: '-.25', handling: '+.1' };
  const unit = unitEconomics({ price: 10 }, record);
  assert.equal(unit.complete, true);
  assert.equal(unit.totalVariableCost, -2.65);
  assert.equal(unit.contribution, 12.65);
  assert.equal(unit.margin, 126.5);
  assert.deepEqual(orderRevenue({ total: '20', refunds: '-5', tax: '-2', discounts: '-1', shippingCharged: '-3' }), {
    grossRevenue: 20, netRevenue: 20, revenueExTax: 22, refunds: 0, tax: -2, discounts: -1, shippingCharged: -3
  });
  assert.equal(orderRevenue({ total: 20, refunds: 25, tax: 0 }).netRevenue, 0);
  assert.equal(orderRevenue({ total: -20, financialStatus: 'REFUNDED', tax: 0 }).refunds, 0);
  assert.equal(orderRevenue({ currentTotal: '-5', refunds: 0, currentTax: '-1' }).revenueExTax, -4);
  const order = calculateOrderProfit({ ...knownOrder(), paymentFees: '-.50', currentTax: '-2' }, { RECORDED: record });
  assert.equal(order.complete, true);
  assert.equal(order.totalVariableCost, -5.8);
  assert.equal(order.contribution, 22.8);
});

test('margin floors apply valid signed values and use the configured fallback for unknown inputs', () => {
  for (const value of unknown) {
    assert.equal(unitEconomics({ price: 10 }, { ...zeroCosts(), marginFloor: value }, { marginFloor: '25' }).marginFloor, 25);
    assert.equal(unitEconomics({ price: 10 }, zeroCosts(), { marginFloor: value }).marginFloor, 20);
  }
  for (const value of [0, '0.00', '-5', '+2.5e1']) {
    assert.equal(unitEconomics({ price: 10 }, { ...zeroCosts(), marginFloor: value }).marginFloor, Number(value));
  }
});
