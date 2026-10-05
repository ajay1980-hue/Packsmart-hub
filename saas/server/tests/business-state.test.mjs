import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveBusinessState } from '../lib/business-state.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';

function completeEconomics() {
  return {
    landed: 2,
    packing: 0.2,
    handling: 0.1,
    delivery: 1,
    paymentFee: 0.3,
    channelFee: 0.4,
    advertising: 0,
    otherVariable: 0
  };
}

test('business state is compact, tenant-scoped and withholds profit when cost evidence is incomplete', () => {
  const state = seedWorkspaceState({}, { workspaceId:'tenant-a' });
  state.storageReady = true;
  state.products = [{
    id:'p1', title:'Heavy duty mailing bags', status:'active', provider:'shopify',
    description:'x'.repeat(100000),
    variants:[
      { id:'v1', sku:'SKU-OK', title:'100 pack', price:10, inventory:50, available:true },
      { id:'v2', sku:'SKU-MISSING', title:'50 pack', price:8, inventory:4, available:true }
    ]
  }];
  state.economics['SKU-OK'] = completeEconomics();
  state.economics['SKU-MISSING'] = { landed:2 };
  state.orders = [{
    id:'o1', provider:'shopify', financialStatus:'PAID', fulfillmentStatus:'FULFILLED',
    total:10, currentTotal:10, tax:0, refunds:0, createdAt:'2026-10-05T12:00:00.000Z',
    customerEmail:'secret@example.com',
    lineItems:[{ id:'l1', sku:'SKU-OK', name:'100 pack', quantity:1, net:10 }]
  }];
  state.connections = [{ provider:'shopify', encryptedCredentials:'top-secret-token' }];
  state.integrationStatus.shopify = { status:'connected', lastError:null };
  const result = deriveBusinessState(state, { now:new Date('2026-10-05T13:00:00.000Z') });

  assert.equal(result.workspaceId, 'tenant-a');
  assert.equal(result.profitability.missingCostVariants, 1);
  assert.equal(result.profitability.missingCosts[0].sku, 'SKU-MISSING');
  assert.equal(result.profitability.profitCoveragePercent, 100);
  assert.equal(result.profitability.contribution30d, 6);
  assert.equal(result.inventory.stockRisks, 1);
  assert.equal(result.evidence.profitUnknownWhenCostsMissing, true);

  const json = JSON.stringify(result);
  assert.ok(json.length < 20000, 'canonical business state should stay compact');
  assert.equal(json.includes('top-secret-token'), false);
  assert.equal(json.includes('secret@example.com'), false);
  assert.equal(json.includes('x'.repeat(1000)), false);
});

test('business state reports contribution as unknown when retained orders lack required evidence', () => {
  const state = seedWorkspaceState({}, { workspaceId:'tenant-b' });
  state.products = [{ id:'p1', title:'Boxes', status:'active', variants:[{ id:'v1', sku:'SKU-1', price:12, inventory:10 }] }];
  state.economics['SKU-1'] = { landed:3 };
  state.orders = [{
    id:'o1', provider:'shopify', financialStatus:'PAID', fulfillmentStatus:'FULFILLED',
    total:12, currentTotal:12, createdAt:'2026-10-05T12:00:00.000Z',
    lineItems:[{ id:'l1', sku:'SKU-1', quantity:1, net:12 }]
  }];
  const result = deriveBusinessState(state, { now:new Date('2026-10-05T13:00:00.000Z') });
  assert.equal(result.profitability.contribution30d, null);
  assert.equal(result.profitability.profitCoveragePercent, 0);
  assert.equal(result.profitability.missingCostVariants, 1);
});
