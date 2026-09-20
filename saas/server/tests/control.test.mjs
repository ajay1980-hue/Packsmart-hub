import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { addAudit, recordWork } from '../lib/events.mjs';
import { claimAutomation, configureAutopilot, detectExceptions, detectOpportunities, dueRules, finishAutomation, modifyApproval, putDecision, requestOpportunityApproval, setExceptionStatus, valueSummary } from '../lib/control.mjs';
import { createScheduler, monitoredSync } from '../lib/scheduler.mjs';
import { runCommander } from '../lib/agents.mjs';
import { mergeProviderRecords } from '../lib/integrations.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

function business() {
  const state = seedWorkspaceState();
  state.products = [{ id: 'p1', title: 'Protective packaging for ecommerce', handle: 'packaging', status: 'active', description: 'Useful protective packaging description for our recorded catalogue of ecommerce products.', image: 'https://example.test/p.jpg', variants: [{ id: 'v1', externalId: 'v1', sku: 'SKU-1', title: 'Pack', price: 10, inventory: 2, available: true }] }];
  state.economics['SKU-1'] = { landed: 9, packing: 0, handling: 0, delivery: 0, paymentFee: 0, channelFee: 0, advertising: 0, otherVariable: 0 };
  state.integrationStatus.shopify = { status: 'connected', source: 'admin-graphql', lastSyncAt: new Date().toISOString() };
  return state;
}

test('exceptions deduplicate, retain dismissal evidence and reopen only after recurrence', () => {
  const state = business();
  detectExceptions(state); const count = state.exceptions.length;
  detectExceptions(state); assert.equal(state.exceptions.length, count);
  const stock = state.exceptions.find(item => item.kind === 'stock');
  setExceptionStatus(state, stock.id, { status: 'dismissed', note: 'Supplier delivery already arranged.' }, 'owner');
  detectExceptions(state); assert.equal(stock.status, 'dismissed');
  state.products[0].variants[0].inventory = 100; detectExceptions(state); assert.equal(stock.present, false);
  state.products[0].variants[0].inventory = 1; detectExceptions(state); assert.equal(stock.status, 'open');
  assert.equal(stock.history.length, 3);
  assert.throws(() => setExceptionStatus(state, stock.id, { status: 'resolved' }, 'owner'), /note/);
});

test('Inventory API scope cannot produce full-marketplace missing-listing alerts', async () => {
  const state = business();
  state.ebay = { source: 'ebay-oauth-readonly', listings: [], health: { missingOnEbay: ['SKU-1'] }, coverage: { inventoryAvailable: true, offersAvailable: true } };
  state.integrationStatus.ebay = { status: 'connected' };
  detectExceptions(state);
  assert.ok(!state.exceptions.some(item => item.kind === 'inventory_mismatch' && item.present));
  assert.ok(state.exceptions.some(item => item.kind === 'source_coverage' && item.present));
  const run = await runCommander(state, 'Check eBay');
  assert.match(run.summary, /Inventory API/);
  assert.equal(run.results[0].data.health, null);
});

test('opportunity estimates require costs, respect decision memory and deduplicate approvals', () => {
  const state = business(); detectOpportunities(state);
  const pricing = state.opportunities.find(item => item.kind === 'pricing');
  assert.equal(pricing.estimatedImpact.amount, 1.25);
  assert.match(pricing.estimatedImpact.unit, /per unit/);
  const first = requestOpportunityApproval(state, pricing.id, 'owner');
  assert.equal(requestOpportunityApproval(state, pricing.id, 'owner').id, first.id);
  assert.equal(first.financialImpact, null);
  const revised = modifyApproval(state, first.id, { revision: 1, action: 'Confirm pricing with supplier' }, 'owner');
  assert.equal(revised.revision, 2); assert.equal(revised.history[0].action, pricing.title);
  assert.throws(() => modifyApproval(state, first.id, { revision: 1, action: 'Stale change' }, 'owner'), error => error.code === 'APPROVAL_CONFLICT');
  putDecision(state, { key: 'exclude-one', category: 'product_exclusion', title: 'Exclude SKU', content: 'Do not recommend this product.', source: 'Owner review', target: 'SKU-1' }, 'owner');
  detectOpportunities(state); assert.equal(pricing.present, false);
  const missing = business(); missing.economics = {}; detectOpportunities(missing);
  assert.ok(missing.opportunities.every(item => item.estimatedImpact === null));
  const value = valueSummary(state); assert.equal(value.actual.moneySaved, null); assert.equal(value.actual.hoursSaved, null);
});

test('decision edits preserve history and margin policy feeds subsequent analysis', async () => {
  const state = business();
  const initial = putDecision(state, { key: 'margin-policy', category: 'margin_target', title: 'Target margin', content: 'Aim for 25 percent.', source: 'Owner', value: 25 }, 'owner');
  const revised = putDecision(state, { revision: 1, category: 'margin_target', title: 'New margin target', content: 'Aim for 30 percent.', source: 'Owner review', value: 30 }, 'owner', initial.id);
  assert.equal(initial.status, 'superseded'); assert.equal(revised.supersedes, initial.id);
  assert.equal(state.settings.marginFloor, 30);
  const run = await runCommander(state, 'Review stock and pricing');
  assert.ok(run.conflicts.length); assert.equal(run.workStatus, 'REQUIRES APPROVAL');
  assert.ok(run.decisionContext.some(item => item.id === revised.id));
  assert.ok(!run.decisionContext.some(item => item.id === initial.id));
});

test('Commander respects enablement and autonomy, isolates specialists, and gates risky requests', async () => {
  const state = business(); state.agentSettings.stock.enabled = false;
  let invoked = [];
  const run = await runCommander(state, 'Review stock and pricing', { specialist: async id => { invoked.push(id); if (id === 'pricing') throw new Error('private upstream detail'); return { agentId: id, status: 'Idle', finding: 'Recorded analysis', confidence: 1 }; } });
  assert.ok(!invoked.includes('stock')); assert.equal(run.results.find(item => item.agentId === 'stock').workStatus, 'BLOCKED');
  assert.equal(run.results.find(item => item.agentId === 'pricing').workStatus, 'FAILED');
  assert.ok(!JSON.stringify(run).includes('private upstream detail'));
  state.agentSettings.commander.autonomy = 0;
  const observed = await runCommander(state, 'Spend money on stock');
  assert.equal(observed.approvalId, null); assert.equal(observed.priorities.length, 0);
  state.agentSettings.commander.autonomy = 2;
  const proposal = await runCommander(state, 'Spend money on stock');
  assert.ok(proposal.approvalId); assert.equal(proposal.executedExternally, false); assert.equal(proposal.modelCalls, 0);
  state.agentSettings.commander.enabled = false;
  await assert.rejects(() => runCommander(state, 'Stock'), error => error.code === 'COMMANDER_DISABLED');
});

test('Autopilot enforces OFF, permission, frequency, spend and UK morning schedule', () => {
  const state = business(), now = new Date('2026-09-20T06:00:00Z');
  configureAutopilot(state, { enabled: false }, 'owner'); assert.deepEqual(dueRules(state, now), []);
  configureAutopilot(state, { enabled: true, rules: { inventoryMonitoring: { permitted: false } } }, 'owner');
  assert.ok(!dueRules(state, now).some(item => item.id === 'inventoryMonitoring'));
  assert.throws(() => configureAutopilot(state, { spendLimit: 1 }, 'owner'), /spending/);
  assert.ok(!dueRules(state, new Date('2026-09-20T05:59:00Z')).some(item => item.id === 'dailyOpsBrief'));
  const morning = claimAutomation(state, 'dailyOpsBrief', now); assert.ok(morning);
  finishAutomation(state, morning, { evidence: [{ type: 'brief', id: 'b1' }] });
  assert.ok(!dueRules(state, new Date('2026-09-20T22:00:00Z')).some(item => item.id === 'dailyOpsBrief'));
  assert.ok(dueRules(state, new Date('2026-09-21T06:00:00Z')).some(item => item.id === 'dailyOpsBrief'));
  const sync = claimAutomation(state, 'channelSync', now); assert.ok(sync);
  assert.equal(claimAutomation(state, 'channelSync', now), null);
  finishAutomation(state, sync, { evidence: [{ type: 'source_read', id: 's1' }] });
  assert.equal(claimAutomation(state, 'channelSync', new Date(now.getTime() + 60000)), null);
  assert.throws(() => recordWork(state, { id: 'fake', status: 'COMPLETED', evidence: [] }), /evidence/i);
});

test('sync retains known data and manual costs, never loops on expired authentication', async () => {
  const state = business(); state.orders = [{ id: 'old', provider: 'ebay', total: 20 }, { id: 'current', provider: 'ebay', total: 10, actualShippingCost: 3, costOverrides: { actualShippingCost: 3 } }];
  const merged = mergeProviderRecords(state.orders, 'ebay', [{ id: 'current', provider: 'ebay', total: 12, actualShippingCost: null }]);
  assert.equal(merged.length, 2); assert.equal(merged.find(item => item.id === 'current').actualShippingCost, 3);
  let reads = 0;
  const adapters = { syncShopify: async () => { reads++; throw Object.assign(new Error('Expired'), { code: 'UPSTREAM_AUTH_FAILED', upstreamStatus: 401 }); } };
  await assert.rejects(() => monitoredSync(state, adapters, 'shopify', { automatic: true }));
  const successfulAt = state.integrationStatus.shopify.lastSyncAt;
  await assert.rejects(() => monitoredSync(state, adapters, 'shopify', { automatic: true }), error => error.code === 'AUTH_REPAIR_REQUIRED');
  assert.equal(reads, 1); assert.equal(state.integrationStatus.shopify.lastSyncAt, successfulAt); assert.equal(state.products.length, 1);
  reads = 0;
  await assert.rejects(() => monitoredSync(state, { syncShopify: async () => { reads++; throw Object.assign(new Error('Busy'), { upstreamStatus: 503 }); } }, 'shopify'));
  assert.equal(reads, 2);
});

test('an interrupted morning brief can retry with a cooldown and bounded daily attempts', () => {
  const state = business(), now = new Date('2026-09-20T06:00:00Z');
  for (let attempt = 0; attempt < 3; attempt++) {
    const clock = new Date(now.getTime() + attempt * 15 * 60000);
    const run = claimAutomation(state, 'dailyOpsBrief', clock); assert.ok(run);
    finishAutomation(state, run, { errorCode: 'WORKER_INTERRUPTED', blocked: true });
    assert.ok(!dueRules(state, new Date(clock.getTime() + 60000)).some(rule => rule.id === 'dailyOpsBrief'));
  }
  assert.ok(!dueRules(state, new Date(now.getTime() + 3600000)).some(rule => rule.id === 'dailyOpsBrief'));
});

test('file persistence survives restart and rejects stale writes without losing another workspace', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-durable-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const env = { SAAS_STATE_FILE: path.join(directory, 'state.json') }, store = createStore(env);
  const a = business(), b = seedWorkspaceState({}, { workspaceId: 'beta', email: 'beta@example.test' });
  for (let i = 0; i < 2100; i++) addAudit(a, { type: 'verification_event', actor: 'test', detail: { sequence: i } });
  await Promise.all([store.save(a.workspace.id, a), store.save(b.workspace.id, b)]);
  const stale = await store.get(a.workspace.id); a.settings.marker = 'new'; await store.save(a.workspace.id, a);
  await assert.rejects(() => store.save(a.workspace.id, stale), error => error.code === 'STATE_CONFLICT');
  const restart = createStore(env); assert.equal((await restart.get(a.workspace.id)).settings.marker, 'new');
  assert.equal((await restart.get(a.workspace.id)).audit.length, 2101); assert.ok(await restart.get('beta'));
});

test('Supabase compare-and-save stops cross-replica overwrite and duplicate identities', async () => {
  const fake = fakeSupabase(), env = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test' };
  const one = createStore(env, { fetchImpl: fake.fetchImpl }), two = createStore(env, { fetchImpl: fake.fetchImpl });
  const state = business(); await one.save(state.workspace.id, state);
  const left = await one.get(state.workspace.id), right = await two.get(state.workspace.id);
  left.settings.marker = 'winner'; await one.save(state.workspace.id, left);
  right.settings.marker = 'loser'; await assert.rejects(() => two.save(state.workspace.id, right), error => error.code === 'STATE_CONFLICT');
  assert.equal((await two.get(state.workspace.id)).settings.marker, 'winner');
  const duplicate = seedWorkspaceState({}, { workspaceId: 'other' });
  await assert.rejects(() => two.save('other', duplicate), error => error.code === 'STATE_CONFLICT');
  assert.equal(await two.get('other'), null);
});

test('scheduler persists its claim before reading, limits duplicate work, and recovers interrupted runs', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-scheduler-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore({ SAAS_STATE_FILE: path.join(directory, 'state.json') }), state = business();
  for (const key of Object.keys(state.automations)) state.automations[key] = key === 'channelSync';
  await store.save(state.workspace.id, state);
  let calls = 0;
  const integrations = { shopifyRefreshAvailable: () => true, ebayConfigured: () => false, syncShopify: async () => {
    calls++; const persisted = await store.get(state.workspace.id);
    assert.equal(persisted.automationRuns[0].status, 'IN PROGRESS'); return { status: 'connected', lastSyncAt: new Date().toISOString() };
  } };
  const options = { store, integrations, withWorkspaceLock: async (_id, action) => action(), currentBrief: () => ({ id: 'test-brief' }), enabled: false };
  const scheduler = createScheduler(options), competitor = createScheduler(options);
  const attempts = await Promise.allSettled([scheduler.runWorkspace(state.workspace.id), competitor.runWorkspace(state.workspace.id)]);
  assert.ok(attempts.some(item => item.status === 'fulfilled')); assert.equal(calls, 1);
  const saved = await store.get(state.workspace.id); assert.equal(saved.automationRuns[0].status, 'COMPLETED');
  assert.equal(valueSummary(saved).actual.tasksAutomated, 1);
  assert.equal((await scheduler.runWorkspace(state.workspace.id)).skipped, true);
  const future = new Date(Date.now() + 3600000); claimAutomation(saved, 'channelSync', future); await store.save(state.workspace.id, saved);
  await scheduler.runWorkspace(state.workspace.id, { now: new Date(future.getTime() + 11 * 60000) });
  assert.equal((await store.get(state.workspace.id)).automationRuns[0].status, 'BLOCKED');
});
