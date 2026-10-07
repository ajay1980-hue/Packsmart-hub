import test from 'node:test';
import assert from 'node:assert/strict';
import { seedWorkspaceState } from '../lib/store.mjs';
import { beginConnectionSync, connectionDue, connectionSettings, recoveryFor, shopifyOrderReadBinding, isShopifyOrderReadBindingCurrent, shopifyOrderReadHold } from '../lib/connection-centre.mjs';
import { classifyConnectionIssue, intelligentConnections } from '../lib/connection-intelligence.mjs';
import { runConnectionDoctor, queueFirstSync, runFirstSync } from '../lib/connection-doctor.mjs';
import { createScheduler, monitoredSync } from '../lib/scheduler.mjs';

const SUCCESS_AT = '2026-09-20T10:00:00.000Z';
const HOLD = { code: 'SHOPIFY_ORDER_SOURCE_SIZE_LIMIT', at: '2026-09-21T10:00:00.000Z' };
const future = () => new Date(Date.now() + 2 * 3600000);
function fixture({ held = false, areas = ['products', 'orders'], legacy = false } = {}) {
  const state = seedWorkspaceState({}, { workspaceId: 'source-retry-fixture' });
  state.connections = [{ provider: 'shopify', encryptedCredentials: 'synthetic-fixture', status: 'connected', lastCheckedAt: SUCCESS_AT }];
  state.products = [{ provider: 'shopify', id: 'product-1', variants: [] }];
  state.orders = [{ provider: 'shopify', id: 'retained-order', total: 19, actualShippingCost: 4 }];
  state.integrationStatus = { shopify: { status: held ? 'error' : 'connected', lastSyncAt: SUCCESS_AT, lastSuccessfulSyncAt: SUCCESS_AT,
    areaSuccessAt: { products: SUCCESS_AT, orders: SUCCESS_AT }, ...(held ? { lastError: HOLD.code, lastFailureAt: HOLD.at, orderReadHold: structuredClone(HOLD) } : {}) } };
  if (!legacy) state.connectionSettings = { shopify: { ...connectionSettings(state, 'shopify'), areas, managedReadSchedule: true } };
  if (held) state.integrationStatus.shopify.orderReadHold.binding = shopifyOrderReadBinding(state);
  for (const key of Object.keys(state.automations)) state.automations[key] = key === 'channelSync';
  state.autopilot.enabled = true;
  return state;
}
function service(syncProvider) {
  return { syncProvider, shopifyRefreshAvailable: () => true, shopifyConfigured: () => true, ebayConfigured: () => false,
    oauthReady: () => true, connectionAccessExpiry: () => null, refreshSupported: () => false };
}
function sourceError(code = HOLD.code, extra = {}) {
  return Object.assign(new TypeError('untrusted source detail'), { code, status: 422, nonRetryable: true, upstreamStatus: 503, ...extra });
}

test('source shape and size failures retain order evidence and cannot become transient immediate retries', async () => {
  for (const code of ['SHOPIFY_ORDER_SOURCE_SHAPE_INVALID', HOLD.code]) {
    const state = fixture(), orders = structuredClone(state.orders), evidence = structuredClone(state.integrationStatus.shopify.areaSuccessAt);
    let calls = 0;
    await assert.rejects(monitoredSync(state, service(async () => { calls++; throw sourceError(code, { nonRetryable: false }); }), 'shopify', { areas: ['orders'] }), error => error.code === code && error.status === 422 && error.nonRetryable === true);
    assert.equal(calls, 1, 'The source code must override a false transient HTTP/type hint');
    assert.deepEqual(state.orders, orders);
    assert.deepEqual(state.integrationStatus.shopify.areaSuccessAt, evidence);
    assert.equal(state.integrationStatus.shopify.lastSyncAt, SUCCESS_AT);
    assert.equal(state.integrationStatus.shopify.lastSuccessfulSyncAt, SUCCESS_AT);
    assert.equal(state.integrationStatus.shopify.orderReadHold.code, code);
    assert.ok(Number.isFinite(Date.parse(state.integrationStatus.shopify.orderReadHold.at)));
    assert.equal(state.integrationStatus.shopify.transient, false);
    assert.equal(state.integrationStatus.shopify.retryAt, null);
    assert.equal(state.connectionSyncs[0].status, 'failed');
    assert.doesNotMatch(JSON.stringify(state), /untrusted source detail/);
  }
});

test('held automatic reads and claims make no provider calls or state changes', async () => {
  const state = fixture({ held: true }), before = structuredClone(state);
  let calls = 0;
  const integrations = service(async () => { calls++; throw new Error('Unexpected provider call'); });
  assert.equal(connectionDue(state, 'shopify', future()), false);
  assert.throws(() => beginConnectionSync(state, 'shopify', { automatic: true }), error => error.code === HOLD.code && error.nonRetryable);
  for (let i = 0; i < 3; i++) await assert.rejects(monitoredSync(state, integrations, 'shopify', { automatic: true }), error => error.code === HOLD.code);
  assert.equal(calls, 0);
  assert.deepEqual(state, before);
});

test('a failed source attempt replaces completed attempt diagnostics while retaining successful evidence', async () => {
  const state = fixture();
  const completed = { status: 'complete', at: SUCCESS_AT, retryable: false };
  state.integrationStatus.shopify.orderReadAttempt = completed;
  const orders = structuredClone(state.orders);
  const successfulAreas = structuredClone(state.integrationStatus.shopify.areaSuccessAt);
  await assert.rejects(monitoredSync(state, service(async current => {
    current.integrationStatus.shopify = { ...current.integrationStatus.shopify,
      orderReadAttempt: { status: 'incomplete', code: HOLD.code, at: HOLD.at, retryable: false, untrusted: 'private adapter detail' } };
    throw sourceError();
  }), 'shopify', { areas: ['orders'] }), error => error.code === HOLD.code);
  const status = state.integrationStatus.shopify;
  assert.deepEqual(status.orderReadAttempt, { status: 'incomplete', code: HOLD.code, at: status.orderReadHold.at, retryable: false });
  assert.equal(status.lastSuccessfulSyncAt, SUCCESS_AT);
  assert.deepEqual(status.areaSuccessAt, successfulAreas);
  assert.deepEqual(state.orders, orders);
  assert.doesNotMatch(JSON.stringify(status), /private adapter detail/);

  const ordinary = fixture();
  ordinary.integrationStatus.shopify.orderReadAttempt = completed;
  await assert.rejects(monitoredSync(ordinary, service(async () => {
    throw Object.assign(new Error('Temporary read error'), { code: 'UPSTREAM_REQUEST_FAILED', upstreamStatus: 503 });
  }), 'shopify', { areas: ['orders'], retry: false }));
  assert.deepEqual(ordinary.integrationStatus.shopify.orderReadAttempt, completed);
  assert.equal(ordinary.integrationStatus.shopify.orderReadHold, undefined);
});

test('persisted holds suppress recurring scheduler claims and saves with current or legacy settings', async () => {
  for (const legacy of [false, true]) {
    const saved = fixture({ held: true, legacy });
    saved.integrationStatus.shopify.transient = true;
    saved.integrationStatus.shopify.upstreamStatus = 503;
    let calls = 0, saves = 0;
    const scheduler = createScheduler({ store: { get: async () => structuredClone(saved), save: async () => { saves++; } },
      integrations: service(async () => { calls++; throw new Error('Unexpected provider call'); }),
      withWorkspaceLock: async (_id, action) => action(), currentBrief: () => ({}), enabled: false });
    for (let i = 0; i < 3; i++) {
      const result = await scheduler.runWorkspace(saved.workspace.id, { now: new Date(future().getTime() + i * 3600000) });
      assert.equal(result.skipped, true);
    }
    assert.equal(calls, 0);
    assert.equal(saves, 0, 'A held check must not save a failed or empty automation claim');
  }
});

test('Auto-Doctor does not resume held first sync or refresh tokens, even with stale transient hints', async () => {
  const state = fixture({ held: true });
  queueFirstSync(state, 'shopify', 'owner');
  Object.assign(state.integrationStatus.shopify, { transient: true, upstreamStatus: 503 });
  const before = structuredClone(state);
  let calls = 0, saves = 0;
  const integrations = { ...service(async () => { calls++; }), testConnection: async () => { calls++; }, refreshSupported: () => true, connectionAccessExpiry: () => SUCCESS_AT };
  for (let i = 0; i < 3; i++) await runConnectionDoctor(state, { integrations, readSync: monitoredSync, save: async () => { saves++; }, now: future() });
  assert.equal(calls, 0);
  assert.equal(saves, 0);
  assert.deepEqual(state, before);
  await runFirstSync(state, 'shopify', { integrations, readSync: monitoredSync, save: async () => { saves++; }, automatic: true });
  assert.equal(calls, 0);
  assert.equal(saves, 0);
  assert.deepEqual(state, before);
});

test('successful explicit order retry clears the adapter hold and restores due reads', async () => {
  const state = fixture({ held: true });
  let calls = 0;
  const result = await monitoredSync(state, service(async (current, provider, { areas, automatic }) => {
    calls++;
    assert.equal(provider, 'shopify'); assert.equal(automatic, false); assert.deepEqual(areas, ['orders']);
    current.orders.push({ provider, id: 'new-order', total: 11 });
    // The source adapter clears only after validating and accepting orders.
    return { status: 'connected', lastError: null, orderReadHold: null };
  }), 'shopify', { areas: ['orders'] });
  assert.equal(calls, 1);
  assert.equal(result.orderReadHold, null);
  assert.equal(result.lastError, null);
  assert.equal(state.orders[0].actualShippingCost, 4);
  assert.equal(state.orders.length, 2);
  assert.notEqual(result.areaSuccessAt.orders, SUCCESS_AT);
  assert.equal(classifyConnectionIssue(state, 'shopify'), null);
  assert.equal(connectionDue(state, 'shopify', future()), true);
});

test('products-only success cannot clear a hold or claim a successful order read', async () => {
  for (const automatic of [false, true]) {
    const state = fixture({ held: true }), orders = structuredClone(state.orders);
    let calls = 0;
    await monitoredSync(state, service(async (current, provider, { areas }) => {
      calls++; assert.deepEqual(areas, ['products']);
      current.products.push({ provider, id: 'new-product', variants: [] });
      current.integrationStatus.shopify = { status: 'connected', lastError: null, orderReadHold: null };
      return current.integrationStatus.shopify;
    }), 'shopify', { areas: ['products'], automatic });
    assert.equal(calls, 1);
    assert.deepEqual(state.integrationStatus.shopify.orderReadHold, { ...HOLD, binding: shopifyOrderReadBinding(state) });
    assert.equal(state.integrationStatus.shopify.areaSuccessAt.orders, SUCCESS_AT);
    assert.notEqual(state.integrationStatus.shopify.areaSuccessAt.products, SUCCESS_AT);
    assert.deepEqual(state.orders, orders);
    assert.equal(connectionDue(state, 'shopify', future()), false);
    assert.equal(classifyConnectionIssue(state, 'shopify').kind, 'order_source_review');
  }
});

test('managed products-only scheduled reads remain available and retain held order diagnostics', async () => {
  const state = fixture({ held: true, areas: ['products'] });
  const calls = [];
  await runConnectionDoctor(state, { integrations: service(async (_state, provider, { areas }) => {
    calls.push({ provider, areas }); return { status: 'connected', lastError: null, orderReadHold: null };
  }), readSync: monitoredSync, save: async () => {}, now: future() });
  assert.deepEqual(calls, [{ provider: 'shopify', areas: ['products'] }]);
  assert.deepEqual(state.integrationStatus.shopify.orderReadHold, { ...HOLD, binding: shopifyOrderReadBinding(state) });
  assert.equal(state.integrationStatus.shopify.areaSuccessAt.orders, SUCCESS_AT);
  assert.ok(!state.audit.some(entry => entry.detail?.message?.includes('No action required')));
});

test('source review classifications override transient flags and do not advise reconnecting', () => {
  const state = fixture({ held: true });
  Object.assign(state.integrationStatus.shopify, { transient: true, upstreamStatus: 429, lastError: 'CONNECTION_RATE_LIMITED' });
  state.connectionDoctor = { shopify: { nextRetryAt: future().toISOString(), exhausted: true } };
  state.connectionSyncs = [{ provider: 'shopify', status: 'running', leaseUntil: SUCCESS_AT }];
  const issue = classifyConnectionIssue(state, 'shopify');
  assert.equal(issue.kind, 'order_source_review'); assert.equal(issue.repair, null);
  for (const message of [issue.message, recoveryFor('shopify', state.integrationStatus.shopify).message]) {
    assert.match(message, /review/); assert.match(message, /Existing data is retained/); assert.doesNotMatch(message, /reconnect/i);
  }
  const health = intelligentConnections(state, service(async () => ({}))).find(channel => channel.id === 'shopify').health;
  assert.equal(health.cause, 'order_source_review');
  assert.equal(health.nextRetryAt, null);
  assert.notEqual(health.action.action, 'reconnect');
});

test('a Shopify hold does not block another provider or change its transient retries', async () => {
  const state = fixture({ held: true });
  state.connections.push({ provider: 'ebay_oauth', encryptedCredentials: 'synthetic-ebay', status: 'connected' });
  state.connectionSettings.ebay = { ...connectionSettings(state, 'ebay'), areas: ['orders'] };
  state.integrationStatus.ebay = { status: 'connected', lastSuccessfulSyncAt: SUCCESS_AT };
  assert.equal(connectionDue(state, 'ebay', future()), true);
  let calls = 0;
  await assert.rejects(monitoredSync(state, service(async () => { calls++; throw Object.assign(new Error('Temporary'), { code: 'UPSTREAM_REQUEST_FAILED', upstreamStatus: 503 }); }), 'ebay', { automatic: true }), error => error.code === 'UPSTREAM_REQUEST_FAILED');
  assert.equal(calls, 2);
  assert.equal(state.integrationStatus.ebay.orderReadHold, undefined);
  assert.equal(classifyConnectionIssue(state, 'ebay').kind, 'provider_unavailable');
  assert.deepEqual(state.integrationStatus.shopify.orderReadHold, { ...HOLD, binding: shopifyOrderReadBinding(state) });
});

test('automatic first-sync source failure records a hold without scheduling another repair', async () => {
  const state = fixture({ areas: ['orders'] });
  queueFirstSync(state, 'shopify', 'owner');
  let calls = 0, saves = 0;
  const options = { integrations: service(async () => { calls++; throw sourceError(); }), readSync: monitoredSync, save: async () => { saves++; }, now: future() };
  await runConnectionDoctor(state, options);
  assert.equal(calls, 1);
  assert.deepEqual(state.integrationStatus.shopify.orderReadHold.code, HOLD.code);
  assert.equal(state.connectionFirstSync.shopify.failures.orders.transient, false);
  assert.equal(state.connectionDoctor.shopify.nextRetryAt, null);
  const afterFailure = saves;
  await runConnectionDoctor(state, { ...options, now: new Date(future().getTime() + 3600000) });
  assert.equal(calls, 1);
  assert.equal(saves, afterFailure);
});

test('an explicit failed-area first-sync retry succeeds and clears its saved source failure', async () => {
  const state = fixture({ areas: ['products', 'orders'] });
  queueFirstSync(state, 'shopify', 'owner');
  const calls = [];
  let fail = true;
  const options = { integrations: service(async (_state, _provider, { areas }) => {
    calls.push(areas);
    if (areas.includes('orders') && fail) throw sourceError();
    return { status: 'connected', lastError: null, ...(areas.includes('orders') ? { orderReadHold: null } : {}) };
  }), readSync: monitoredSync, save: async () => {}, retryFailedOnly: true };
  await runFirstSync(state, 'shopify', options);
  assert.equal(state.connectionFirstSync.shopify.status, 'partial');
  assert.equal(state.integrationStatus.shopify.orderReadHold.code, HOLD.code);
  fail = false;
  await runFirstSync(state, 'shopify', options);
  assert.deepEqual(calls, [['products'], ['orders'], ['orders']]);
  assert.equal(state.connectionFirstSync.shopify.status, 'completed');
  assert.deepEqual(state.connectionFirstSync.shopify.failures, {});
  assert.equal(state.integrationStatus.shopify.orderReadHold, null);
  assert.equal(classifyConnectionIssue(state, 'shopify'), null);
});

test('queued first sync still performs the requested import when periodic sync is disabled', async () => {
  const state = fixture({ areas: ['orders'] });
  state.connectionSettings.shopify.autoSync = false;
  queueFirstSync(state, 'shopify', 'owner');
  let calls = 0;
  await runConnectionDoctor(state, { integrations: service(async () => {
    calls++; return { status: 'connected', lastError: null, orderReadHold: null };
  }), readSync: monitoredSync, save: async () => {}, now: future() });
  assert.equal(calls, 1);
  assert.equal(state.connectionFirstSync.shopify.status, 'completed');
  assert.equal(state.connectionSettings.shopify.autoSync, false);
});

test('hold binding survives token rotation and schedule edits but changes with tenant, account, API or parser policy', () => {
  const state = fixture();
  Object.assign(state.connections[0], { id: 'connection-original', updatedAt: SUCCESS_AT, metadata: { accountId: 'gid://shopify/Shop/1', shopDomain: 'original.myshopify.com' } });
  const config = { domain: 'original.myshopify.com', apiVersion: '2026-07', cacheKey: 'secret-must-not-be-hashed-or-stored', accessToken: 'private-token' };
  const integrations = { shopifyConfig: current => ({ ...config, connection: current.connections[0] }) };
  const binding = shopifyOrderReadBinding(state, integrations);
  state.integrationStatus.shopify.orderReadHold = { ...HOLD, binding };
  state.connections[0].updatedAt = new Date().toISOString();
  state.connections[0].encryptedCredentials = 'rotated-private-credentials';
  state.connectionSettings.shopify.revision = 123;
  state.connectionSettings.shopify.frequencyMinutes = 60;
  config.cacheKey = 'rotated-cache'; config.accessToken = 'rotated-token';
  assert.equal(isShopifyOrderReadBindingCurrent(state, binding, integrations), true);
  assert.equal(connectionDue(state, 'shopify', future(), integrations), false);
  assert.doesNotMatch(JSON.stringify(binding), /private|secret|cacheKey|updatedAt|frequency|revision/);
  for (const change of [current => { current.workspace.id = 'other-tenant'; }, current => { current.connections[0].id = 'replacement-connection'; }, current => { current.connections[0].metadata.accountId = 'gid://shopify/Shop/2'; }]) {
    const replaced = structuredClone(state); change(replaced);
    assert.equal(isShopifyOrderReadBindingCurrent(replaced, binding, integrations), false);
    assert.equal(shopifyOrderReadHold(replaced, 'shopify', integrations), null);
  }
  config.apiVersion = '2026-10';
  assert.equal(isShopifyOrderReadBindingCurrent(state, binding, integrations), false);
  config.apiVersion = '2026-07'; config.domain = 'replacement.myshopify.com';
  assert.equal(isShopifyOrderReadBindingCurrent(state, binding, integrations), false);
  config.domain = binding.domain;
  assert.equal(isShopifyOrderReadBindingCurrent(state, { ...binding, sourcePolicy: 'old-parser' }, integrations), false);
  assert.equal(isShopifyOrderReadBindingCurrent(state, { ...binding, accessToken: 'unsafe' }, integrations), false);
});

test('Doctor and scheduler compare current environment domain before claiming held reads', async () => {
  for (const route of ['doctor', 'scheduler']) {
    const state = fixture();
    state.connections = []; // Environment credentials have no connection row.
    let domain = 'original.myshopify.com', calls = 0, saves = 0;
    const integrations = { ...service(async () => { calls++; return { status: 'connected', lastError: null, orderReadHold: null }; }),
      shopifyConfig: current => ({ workspaceId: current.workspace.id, domain, apiVersion: '2026-07', connection: null }) };
    state.integrationStatus.shopify.orderReadHold = { ...HOLD, binding: shopifyOrderReadBinding(state, integrations) };
    state.integrationStatus.shopify.lastError = HOLD.code;
    if (route === 'doctor') state.connections = [{ id: '', provider: 'shopify', encryptedCredentials: 'synthetic', metadata: {} }];
    const scheduler = createScheduler({ store: { get: async () => state, save: async () => { saves++; } }, integrations,
      withWorkspaceLock: async (_id, action) => action(), currentBrief: () => ({}), enabled: false });
    const run = () => route === 'scheduler' ? scheduler.runWorkspace(state.workspace.id, { now: future() }) : runConnectionDoctor(state, { integrations, readSync: monitoredSync, save: async () => { saves++; }, now: future() });
    await run(); assert.equal(calls, 0); assert.equal(saves, 0);
    domain = 'replacement.myshopify.com';
    await run(); assert.equal(calls, 1);
    assert.equal(state.integrationStatus.shopify.orderReadHold, null);
  }
});

test('late source failures cannot install a hold or replace status for a replacement connection', async () => {
  for (const firstSync of [false, true]) {
    const state = fixture({ areas: ['orders'] });
    state.connections[0].id = 'original-connection';
    if (firstSync) queueFirstSync(state, 'shopify', 'owner');
    const replacementStatus = { status: 'connected', lastSuccessfulSyncAt: '2026-10-01T10:00:00.000Z', lastError: null };
    const integrations = service(async current => {
      const binding = shopifyOrderReadBinding(current);
      current.connections[0].id = 'replacement-connection';
      current.integrationStatus.shopify = structuredClone(replacementStatus);
      throw sourceError(HOLD.code, { orderReadBinding: binding });
    });
    const run = firstSync ? runFirstSync(state, 'shopify', { integrations, readSync: monitoredSync, save: async () => {} })
      : monitoredSync(state, integrations, 'shopify', { areas: ['orders'] });
    await assert.rejects(run, error => error.holdDisposition === 'configuration_changed');
    assert.deepEqual(state.integrationStatus.shopify, replacementStatus);
    assert.equal(state.orders[0].id, 'retained-order');
  }
});
