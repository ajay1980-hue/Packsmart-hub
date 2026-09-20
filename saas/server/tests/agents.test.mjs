import test from 'node:test';
import assert from 'node:assert/strict';
import { agentTeamSnapshot, defaultAgentSettings, recordAgentRun, routeCommand, runCommander } from '../lib/agents.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';

function connectedState() {
  const state = seedWorkspaceState({});
  state.products = [{ id: 'p1', title: 'Protective Bubble Pouches Pack of 50', handle: 'bubble-pouches', status: 'active', description: 'Protective self-seal bubble pouches for ecommerce dispatch and reliable parcel protection.', image: 'https://cdn.shopify.com/p.png', variants: [{ id: 'v1', sku: 'BP-50', title: '50', price: 12, inventory: 4, available: true }] }];
  state.economics['BP-50'] = { landed: 3, packing: 0.2, delivery: 3, handling: 0.5, paymentFee: 0.3, channelFee: 0, advertising: 0, otherVariable: 0, marginFloor: 20 };
  state.integrationStatus.shopify = { status: 'connected', detail: 'Healthy', lastSyncAt: new Date().toISOString() };
  return state;
}

test('Commander routes natural Packsmart commands to relevant specialists', () => {
  assert.deepEqual(routeCommand('What stock do I need next week?'), ['stock']);
  assert.ok(routeCommand('Why were profits lower yesterday?').includes('finance'));
  const full = routeCommand('Sort Packsmart out today');
  for (const id of ['health_watch', 'finance', 'stock', 'pricing', 'shopify', 'ebay', 'sales']) assert.ok(full.includes(id));
});

test('Commander runs specialists concurrently and returns a structured brief', async () => {
  const state = connectedState();
  const run = await runCommander(state, 'Sort Packsmart out today');
  assert.equal(run.results.length, run.routedAgents.length);
  assert.ok(run.summary.includes('variant'));
  assert.ok(run.priorities.length > 0);
  assert.equal(run.results.find(item => item.agentId === 'stock').status, 'Warning');
  assert.equal(run.results.find(item => item.agentId === 'ebay').data.connection.status, 'not_configured');
});

test('agent activity is auditable and does not store credentials', async () => {
  const state = connectedState();
  state.connections.push({ provider: 'shopify', encryptedCredentials: 'secret-ciphertext-value' });
  const run = await runCommander(state, 'Audit Shopify');
  recordAgentRun(state, run, 'owner');
  assert.equal(state.agentRuns[0].id, run.id);
  assert.ok(state.agentActivity.length >= 2);
  assert.equal(JSON.stringify(state.agentActivity).includes('secret-ciphertext-value'), false);
});

test('all agents default safely and financial workers do not execute actions', () => {
  const settings = defaultAgentSettings();
  assert.equal(settings.pricing.autonomy, 2);
  assert.equal(settings.finance.autonomy, 1);
  assert.ok(Object.values(settings).every(item => item.autonomy <= 2));
  const team = agentTeamSnapshot(seedWorkspaceState({}));
  assert.equal(team.length, 15);
  assert.equal(team.find(item => item.id === 'commander').lastFinding, 'Ready for a business command.');
});

test('failure behaviour reports missing integrations instead of inventing data', async () => {
  const state = seedWorkspaceState({});
  const run = await runCommander(state, 'Check eBay and Shopify');
  const ebay = run.results.find(item => item.agentId === 'ebay');
  const shopify = run.results.find(item => item.agentId === 'shopify');
  assert.match(ebay.finding, /Not configured|NOT CONNECTED|Secure read-only/i);
  assert.match(shopify.finding, /NOT CONNECTED|Secure Admin API/i);
  assert.ok(ebay.confidence < 0.5);
  assert.ok(shopify.confidence < 0.5);
});
