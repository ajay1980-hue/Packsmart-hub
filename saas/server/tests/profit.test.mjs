import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateOrderProfit, deriveLandedCost, unitEconomics } from '../lib/profit.mjs';
import { deriveOperations } from '../lib/operations.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';

const completeCosts = {
  landed: 2,
  packing: 0.2,
  handling: 0.1,
  delivery: 2,
  paymentFee: 0.3,
  channelFee: 0.5,
  advertising: 0,
  otherVariable: 0,
  marginFloor: 20
};

test('unknown variable costs never silently become zero profit inputs', () => {
  const result = unitEconomics({ sku: 'PS-1', price: 10 }, { landed: 2, packing: 0.2, delivery: 2, channelFee: 0.5 });
  assert.equal(result.complete, false);
  assert.equal(result.contribution, null);
  assert.ok(result.missingFields.includes('picking / handling cost'));
  assert.ok(result.missingFields.includes('payment processing fee'));
  assert.ok(result.missingFields.includes('advertising allocation'));
  assert.ok(result.missingFields.includes('other variable cost'));
});

test('explicit zero values are valid and complete unit contribution', () => {
  const result = unitEconomics({ sku: 'PS-1', price: 10 }, completeCosts);
  assert.equal(result.complete, true);
  assert.equal(result.totalVariableCost, 5.1);
  assert.equal(result.contribution, 4.9);
  assert.equal(result.margin, 49);
  assert.equal(result.status, 'profitable');
});

test('landed cost derives only from complete supplier, delivery and VAT treatment', () => {
  const incomplete = deriveLandedCost({ boxPrice: 120, boxQuantity: 100, supplierDelivery: 0.1 });
  assert.equal(incomplete.complete, false);
  assert.ok(incomplete.missing.includes('supplier VAT rate'));

  const derived = deriveLandedCost({
    boxPrice: 120,
    boxQuantity: 100,
    supplierDelivery: 0.1,
    supplierVatRate: 20,
    supplierVatRecoverable: false
  });
  assert.equal(derived.complete, true);
  assert.equal(derived.value, 1.54);
  assert.equal(derived.source, 'supplier-box-price');
});

test('order profitability subtracts refunds, VAT and actual source costs', () => {
  const order = {
    id: 'order-1',
    provider: 'shopify',
    financialStatus: 'PARTIALLY_REFUNDED',
    total: 20,
    currentTotal: 15,
    refunds: 5,
    currentTax: 2,
    shippingCharged: 3,
    actualShippingCost: 3,
    paymentFees: 1,
    channelFees: 2,
    advertisingCost: 0,
    otherVariableCosts: 0,
    lineItems: [{ id: 'line-1', sku: 'PS-1', name: 'Pouch', quantity: 2, net: 12 }]
  };
  const result = calculateOrderProfit(order, { 'PS-1': completeCosts });
  assert.equal(result.complete, true);
  assert.equal(result.netRevenue, 15);
  assert.equal(result.revenueExTax, 13);
  assert.equal(result.totalVariableCost, 10.6);
  assert.equal(result.grossProfit, 9);
  assert.equal(result.contribution, 2.4);
  assert.equal(result.basis, 'confirmed-costs');
});

test('business dashboard separates windows, channels, stock value and profit coverage', () => {
  const state = seedWorkspaceState({});
  const now = new Date('2026-09-06T12:00:00Z');
  state.products = [{
    id: 'product-1', title: 'Protective Bubble Pouch', handle: 'pouch', status: 'active', image: 'https://cdn.shopify.com/pouch.jpg',
    description: 'A sufficiently complete protective pouch description for ecommerce packaging and dispatch.',
    variants: [{ id: 'variant-1', sku: 'PS-1', title: 'Pack 50', price: 10, inventory: 4 }]
  }];
  state.economics['PS-1'] = completeCosts;
  state.orders = [{
    id: 'order-1', provider: 'shopify', name: '#1', createdAt: now.toISOString(), financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED',
    total: 10, currentTotal: 10, refunds: 0, currentTax: 1.67, shippingCharged: 0,
    actualShippingCost: 2, paymentFees: 0.3, channelFees: 0.5, advertisingCost: 0, otherVariableCosts: 0,
    lineItems: [{ id: 'line-1', sku: 'PS-1', name: 'Pouch', quantity: 1, net: 8.33 }]
  }];
  state.integrationStatus.shopify = { status: 'connected' };
  const result = deriveOperations(state, { now, lowStockThreshold: 5 });
  assert.equal(result.today.orders, 1);
  assert.equal(result.last7d.profitCoverage, 100);
  assert.equal(result.channels.find(channel => channel.id === 'shopify').orders, 1);
  assert.equal(result.stockRisks, 1);
  assert.equal(result.stockValue, 8);
  assert.equal(result.costCoverage, 100);
});
