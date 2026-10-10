import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { assertLegacyReadAdmission, legacyReadDeferral, preserveEbayRetryFields } from '../lib/legacy-read-safety.mjs';
import { activateConnection, beginConnectionSync, connectionDue, connectionSettings, connectionCentre } from '../lib/connection-centre.mjs';
import { queueFirstSync, runFirstSync, runConnectionDoctor } from '../lib/connection-doctor.mjs';
import { monitoredSync, createScheduler } from '../lib/scheduler.mjs';
import { IntegrationService, SHOPIFY_ORDERS_QUERY, SHOPIFY_PRODUCTS_QUERY } from '../lib/integrations.mjs';
import { seedWorkspaceState, createStore } from '../lib/store.mjs';
import { encryptCredentials, createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
import { ensureControl } from '../lib/control.mjs';
import { createPacksmartServer } from '../server.mjs';
import { intelligentConnections, classifyConnectionIssue } from '../lib/connection-intelligence.mjs';

const key = 'compatibility-read-test-encryption-key-only';
const future = '2099-01-03T12:00:00.000Z', later = '2099-01-05T12:00:00.000Z', expired = '2000-01-01T00:00:00.000Z';
function stateFor(provider = 'shopify') {
  const state = seedWorkspaceState({}, { workspaceId: 'compatibility-reader', email: 'owner@example.test', passwordHash: 'test' });
  state.products = []; state.orders = []; state.audit = []; state.connectionSyncs = [];
  state.integrationStatus = { [provider]: { status: 'connected', lastError: null, lastSuccessfulSyncAt: expired } };
  state.connectionSettings = { [provider]: connectionSettings(state, provider) };
  state.connectionDoctor = { [provider]: { attempts: 4, exhausted: false, nextRetryAt: null } };
  state.connections = [{ id: 'saved-connection', provider, status: 'connected', lastCheckedAt: expired, metadata: {}, encryptedCredentials: 'invalid-on-purpose' }];
  state.connectionFirstSync = { [provider]: { status: 'queued', actor: 'owner', identityVerifiedAt: expired, areas: Object.fromEntries(state.connectionSettings[provider].areas.map(area => [area, 'pending'])), failures: {} } };
  return state;
}
const rejected = error => error.readDeferred === true;
const guardedService = () => new IntegrationService({}, { fetchImpl: async () => assert.fail('A held read must not contact a provider') });

test('malformed and oversized retained envelopes fail closed without scanning unbounded rows', async () => {
  const cases = [
    ['shopify', state => { state.orders = [null]; }],
    ['shopify', state => { state.orders = 'future-envelope'; }],
    ['shopify', state => { state.orders = new Array(100001); }],
    ['shopify', state => { state.connectionSyncs = new Array(10001); }],
    ['shopify', state => { state.connectionSyncs = [null]; }],
    ['shopify', state => { state.channelData = { shopify: [] }; }],
    ['shopify', state => { state.channelData = { shopify: { orderReads: null } }; }],
    ['pinterest', state => { state.connectionDoctor.pinterest = null; }],
    ['pinterest', state => { state.connectionDoctor = []; }],
    ['pinterest', state => { state.integrationStatus.pinterest = 'future-envelope'; }],
    ['ebay', state => { state.ebay = { coverage: { readDiagnostics: { orders: null } } }; }],
    ['ebay', state => { state.ebay = { coverage: { readDiagnostics: [] } }; }],
    ['ebay', state => { state.ebay = { coverage: { readDiagnostics: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [index, {}])) } }; }]
  ];
  for (const [provider, mark] of cases) {
    const state = stateFor(provider); mark(state);
    const before = JSON.stringify(state);
    assert.throws(() => assertLegacyReadAdmission(state, provider), rejected);
    await assert.rejects(() => guardedService().syncProvider(state, provider), rejected);
    assert.equal(JSON.stringify(state), before);
  }
});

test('newer durable contracts defer every provider admission family without changing saved state', async () => {
  const cases = [
    ...['shopify', 'ebay', 'pinterest'].flatMap(provider => [0, 1, 5, null, 'unknown', {}, false].map(value => [provider, state => { state.connectionDoctor[provider].pendingReadAttempts = value; }])),
    ...[null, false, 'unknown', { schema: 'shopify-order-hold/v99', sourcePolicy: 'future' }].map(value => ['shopify', state => { state.connectionDoctor.shopify.orderReadBinding = value; }]),
    ...['orderReadHold', 'orderReadAttempt', 'orderRecovery'].flatMap(field => [null, false, {}, { schema: 'future', status: 'committed' }].map(value => ['shopify', state => { state.integrationStatus.shopify[field] = value; }])),
    ['shopify', state => { state.channelData = { shopify: { orderReads: { manifests: { 'sor2:opaque': { schema: 'future' } } } } }; }],
    ['shopify', state => { state.orders = [{ id: 'newer', provider: 'shopify', sourceReadRef: 'sor2:opaque', total: 4 }]; }],
    ['shopify', state => { state.orders = [{ id: 'newer', provider: 'shopify', sourceCurrencyOverrides: {} }]; }]
  ];
  for (const [provider, mark] of cases) {
    const state = stateFor(provider); mark(state);
    const before = JSON.stringify(state), service = guardedService();
    assert.equal(connectionDue(state, provider), false);
    for (const operation of [() => activateConnection(state, provider, 'owner'), () => queueFirstSync(state, provider, 'owner'), () => beginConnectionSync(state, provider)]) assert.throws(operation, rejected);
    for (const operation of [
      () => monitoredSync(state, service, provider),
      () => service.syncProvider(state, provider),
      () => service.testConnection(state, provider),
      () => service.testConnection(state, provider, { refresh: true }),
      () => runFirstSync(state, provider, { integrations: service, readSync: monitoredSync, save: async () => assert.fail('No new lease') })
    ]) await assert.rejects(operation, rejected);
    if (provider === 'shopify') await assert.rejects(() => service.syncShopify(state), rejected);
    if (provider === 'ebay') {
      await assert.rejects(() => service.syncEbay(state), rejected);
      await assert.rejects(() => service.syncEbayOAuth(state, {}), rejected);
    }
    assert.deepEqual(await runConnectionDoctor(state, { integrations: service, readSync: monitoredSync, save: async () => assert.fail('No Doctor reset') }), { changed: false, externalWrites: false });
    assert.equal(JSON.stringify(state), before, `${provider}: protection must remain byte-for-byte`);
  }
});

test('eBay respects all retained deadlines and malformed nonempty review evidence before credential access', async () => {
  const cases = [
    { retryAt: future }, { retryReviewRequired: true },
    ...['2026-02-30T00:00:00.000Z', '2099-01-01', ' ', 0, false, [], {}, 'unknown'].map(retryAt => ({ retryAt })),
    ...['', 0, 'false', [], {}].map(retryReviewRequired => ({ retryReviewRequired }))
  ];
  for (const fields of cases) for (const location of ['status', 'surface']) {
    const state = stateFor('ebay');
    if (location === 'status') Object.assign(state.integrationStatus.ebay, fields);
    else state.ebay = { coverage: { readDiagnostics: { marketing: { ...fields, code: 'SAVED_DIAGNOSTIC' } } } };
    const before = JSON.stringify(state), service = guardedService();
    assert.equal(connectionDue(state, 'ebay'), false);
    await assert.rejects(() => service.syncEbay(state), rejected);
    await assert.rejects(() => service.testConnection(state, 'ebay', { refresh: true }), rejected);
    await assert.rejects(() => monitoredSync(state, service, 'ebay', { automatic: false }), rejected);
    assert.throws(() => queueFirstSync(state, 'ebay', 'owner'), rejected);
    await runConnectionDoctor(state, { integrations: service, readSync: monitoredSync, save: async () => assert.fail('No save on deferral') });
    assert.equal(JSON.stringify(state), before);
    assert.equal(legacyReadDeferral(state, 'pinterest'), null, 'The unrelated provider is unaffected');
  }
  const state = stateFor('ebay');
  state.integrationStatus.ebay.retryAt = future;
  state.ebay = { coverage: { readDiagnostics: { orders: { retryAt: later } } } };
  assert.equal(legacyReadDeferral(state, 'ebay').retryAt, later);
  assert.equal(legacyReadDeferral(state, 'ebay', { now: Date.parse(later) }), null);
  assert.match(connectionCentre(state, { ebayConfigured: () => true }).find(item => item.id === 'ebay').recovery.message, /saved retry deadline/);
  state.ebay.coverage.readDiagnostics = { orders: null, marketing: { retryReviewRequired: true, failedCampaigns: [null], errorIds: 'future-shape' } };
  const displayed = connectionCentre(state, { ebayConfigured: () => true }).find(item => item.id === 'ebay');
  assert.match(displayed.recovery.message, /needs review/);
  assert.deepEqual(displayed.readDiagnostics.marketing.failedCampaigns, []);
  assert.deepEqual(displayed.readDiagnostics.marketing.errorIds, []);
});

test('held providers show a saved read hold with Review, without automatic repair or reconnect advice', () => {
  for (const provider of ['shopify', 'ebay', 'pinterest']) {
    const state = stateFor(provider), service = guardedService();
    state.connectionDoctor[provider].pendingReadAttempts = 5;
    if (provider === 'ebay') state.integrationStatus.ebay.retryAt = later;
    const issue = classifyConnectionIssue(state, provider);
    assert.equal(issue.kind, 'saved_read_hold');
    assert.equal(issue.repair, null);
    const channel = intelligentConnections(state, service).find(item => item.id === provider);
    assert.equal(channel.health.status, 'Degraded');
    assert.deepEqual(channel.health.action, { action: 'open', label: 'Review' });
    if (provider === 'ebay') assert.equal(channel.health.nextRetryAt, later);
  }
});

test('retained eBay retry fields survive success, partial and actual provider error without extra retries', async () => {
  for (const outcome of ['success', 'partial', 'error']) {
    const state = stateFor('ebay');
    Object.assign(state.integrationStatus.ebay, { retryAt: expired, retryReviewRequired: false });
    let calls = 0;
    const integrations = { syncProvider: async () => {
      calls++;
      if (outcome === 'error') throw Object.assign(new Error('Provider failed'), { code: 'UPSTREAM_REQUEST_FAILED', upstreamStatus: 503, retryAt: later });
      return { status: 'connected', lastError: outcome === 'partial' ? 'EBAY_PARTIAL_READ' : null };
    } };
    if (outcome === 'error') await assert.rejects(() => monitoredSync(state, integrations, 'ebay'), { code: 'UPSTREAM_REQUEST_FAILED' });
    else await monitoredSync(state, integrations, 'ebay');
    assert.equal(calls, 1);
    assert.equal(state.integrationStatus.ebay.retryAt, outcome === 'error' ? later : expired);
    assert.equal(state.integrationStatus.ebay.retryReviewRequired, false);
  }
  assert.equal(preserveEbayRetryFields({ retryAt: future }, { retryAt: later }).retryAt, later);
  assert.equal(preserveEbayRetryFields({ retryReviewRequired: false }, { retryReviewRequired: 'unknown' }).retryReviewRequired, 'unknown');
});

test('normalized eBay review evidence on provider errors stops immediate retry and survives future admissions', async () => {
  const state = stateFor('ebay'); let calls = 0;
  const integrations = { syncProvider: async () => { calls++; throw Object.assign(new Error('Provider failed'), { code: 'UPSTREAM_REQUEST_FAILED', upstreamStatus: 503, retryAt: 'malformed', retryReviewRequired: true }); } };
  await assert.rejects(() => monitoredSync(state, integrations, 'ebay'), { code: 'UPSTREAM_REQUEST_FAILED' });
  assert.equal(state.integrationStatus.ebay.retryAt, 'malformed');
  assert.equal(state.integrationStatus.ebay.retryReviewRequired, true);
  await assert.rejects(() => monitoredSync(state, integrations, 'ebay'), rejected);
  assert.equal(calls, 1);
});

test('local in-flight retained state prevents success or error from clearing protection or amplifying retries', async () => {
  for (const provider of ['shopify', 'ebay', 'pinterest']) for (const outcome of ['success', 'error']) {
    const state = stateFor(provider), health = structuredClone(state.integrationStatus[provider]); let calls = 0;
    await assert.rejects(() => monitoredSync(state, { syncProvider: async () => {
      calls++;
      state.connectionDoctor[provider].pendingReadAttempts = 5;
      if (outcome === 'error') throw Object.assign(new Error('Unavailable'), { upstreamStatus: 503 });
      return { status: 'connected', lastError: null };
    } }, provider), rejected);
    assert.equal(calls, 1);
    assert.deepEqual(state.integrationStatus[provider], health);
    assert.equal(state.connectionDoctor[provider].attempts, 4);
    assert.equal(state.connectionDoctor[provider].pendingReadAttempts, 5);
    assert.equal(state.connectionSyncs[0].status, 'deferred');
    assert.equal(state.connectionSyncs[0].errorCode, null);
    assert.deepEqual(state.audit, []);
  }
});

test('a cooldown arriving during an eBay read is retained without a synthetic failure', async () => {
  const state = stateFor('ebay'), health = structuredClone(state.integrationStatus.ebay);
  await assert.rejects(() => monitoredSync(state, { syncProvider: async () => {
    state.ebay = { coverage: { readDiagnostics: { orders: { retryAt: later, retryReviewRequired: false } } } };
    return { status: 'connected' };
  } }, 'ebay'), rejected);
  assert.deepEqual(state.integrationStatus.ebay, health);
  assert.equal(state.ebay.coverage.readDiagnostics.orders.retryAt, later);
  assert.equal(state.connectionSyncs[0].status, 'deferred');
});

test('first-sync durable lease race defers without a provider read, failed area, or debt reset', async () => {
  const state = stateFor('pinterest'); let saves = 0, calls = 0;
  await assert.rejects(() => runFirstSync(state, 'pinterest', {
    integrations: {}, readSync: async () => { calls++; }, save: async () => { if (++saves === 2) state.connectionDoctor.pinterest.pendingReadAttempts = 5; }
  }), rejected);
  assert.equal(calls, 0);
  assert.equal(state.connectionFirstSync.pinterest.status, 'queued');
  assert.deepEqual(state.connectionFirstSync.pinterest.areas, { boards: 'pending', pins: 'pending' });
  assert.deepEqual(state.connectionFirstSync.pinterest.failures, {});
  assert.equal(state.connectionDoctor.pinterest.attempts, 4);
  assert.equal(state.connectionDoctor.pinterest.pendingReadAttempts, 5);
});

test('Doctor and OAuth test-refresh cannot reset a read contract arriving during token work', async () => {
  const state = stateFor('pinterest'), health = structuredClone(state.integrationStatus.pinterest);
  const service = guardedService(); let identities = 0;
  service.connectorCredentials = async () => { state.connectionDoctor.pinterest.pendingReadAttempts = 5; return { accessToken: 'test' }; };
  service.connectorIdentity = async () => { identities++; return { accountId: 'identity' }; };
  await assert.rejects(() => service.testConnection(state, 'pinterest', { refresh: true }), rejected);
  assert.equal(identities, 0);
  assert.deepEqual(state.integrationStatus.pinterest, health);
  delete state.connectionDoctor.pinterest.pendingReadAttempts;
  await runConnectionDoctor(state, {
    integrations: { refreshSupported: () => true, connectionAccessExpiry: () => expired, testConnection: async () => { state.connectionDoctor.pinterest.pendingReadAttempts = 5; } },
    readSync: async () => assert.fail('No read after refresh'), save: async () => {}
  });
  assert.equal(state.connectionDoctor.pinterest.attempts, 4);
  assert.equal(state.connectionDoctor.pinterest.pendingReadAttempts, 5);
  assert.equal(state.connectionDoctor.pinterest.lastSuccessAt, undefined);
  assert.equal(state.audit.some(event => event.type === 'connection_doctor_repair_failure'), false);
  delete state.connectionDoctor.pinterest.pendingReadAttempts;
  service.connectorCredentials = async () => { state.connectionDoctor.pinterest.pendingReadAttempts = 5; throw new TypeError('Token request interrupted'); };
  await assert.rejects(() => service.testConnection(state, 'pinterest', { refresh: true }), rejected);
  assert.equal(identities, 0);
  assert.deepEqual(state.integrationStatus.pinterest, health);
});

test('first-sync reservation CAS failure prevents dispatch without classifying the provider as failed', async () => {
  const state = stateFor('pinterest'); let saves = 0, calls = 0;
  await assert.rejects(() => runFirstSync(state, 'pinterest', {
    integrations: {}, readSync: async () => { calls++; }, save: async () => { if (++saves === 2) throw Object.assign(new Error('Concurrent save'), { code: 'STATE_CONFLICT' }); }
  }), { code: 'STATE_CONFLICT' });
  assert.equal(calls, 0);
  assert.equal(state.integrationStatus.pinterest.lastError, null);
  assert.deepEqual(state.connectionFirstSync.pinterest.failures, {});
  assert.equal(state.connectionDoctor.pinterest.attempts, 4);
});

test('Shopify does not commit a legacy response over newly retained source markers', async () => {
  const state = stateFor('shopify'), service = guardedService();
  service.shopifyConfigured = () => true;
  service.shopifyConfig = () => ({ accessToken: 'test' });
  service.fetchShopifyProducts = async () => [];
  service.fetchShopifyOrders = async () => {
    state.channelData = { shopify: { orderReads: { lastSuccess: 'sor2:retained' } } };
    return [{ id: 'incoming', provider: 'shopify' }];
  };
  await assert.rejects(() => service.syncShopify(state), rejected);
  assert.deepEqual(state.orders, []);
  assert.equal(state.channelData.shopify.orderReads.lastSuccess, 'sor2:retained');
  assert.equal(state.integrationStatus.shopify.lastSuccessfulSyncAt, expired);
});

test('scheduler bootstrap cannot bypass a retained fence when ordinary settings are absent', async () => {
  const state = stateFor('pinterest'); delete state.connectionSettings.pinterest;
  state.connectionDoctor.pinterest.pendingReadAttempts = 1;
  ensureControl(state);
  state.autopilot.enabled = true;
  state.automations.channelSync = true;
  let calls = 0;
  const integrations = { shopifyRefreshAvailable: () => false, ebayConfigured: () => false, syncProvider: async () => { calls++; return { status: 'connected' }; } };
  const scheduler = createScheduler({ store: { get: async () => state, save: async () => {} }, integrations, withWorkspaceLock: async (_id, work) => work(), currentBrief: () => ({}), enabled: false });
  await scheduler.runWorkspace(state.workspace.id);
  assert.equal(calls, 0);
  assert.deepEqual(state.connectionDoctor.pinterest, { attempts: 4, exhausted: false, nextRetryAt: null, pendingReadAttempts: 1 });
});

test('CAS rejects a stale mixed-process save; a captured snapshot cannot observe a remote admission fence', async () => {
  const fake = fakeSupabase(), env = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test' };
  const older = createStore(env, { fetchImpl: fake.fetchImpl }), newer = createStore(env, { fetchImpl: fake.fetchImpl });
  const seed = stateFor('ebay'); await older.save(seed.workspace.id, seed);
  const stale = await older.get(seed.workspace.id), current = await newer.get(seed.workspace.id);
  current.integrationStatus.ebay.retryAt = later;
  current.connectionDoctor.ebay.pendingReadAttempts = 5;
  current.ebay = { coverage: { readDiagnostics: { marketing: { retryReviewRequired: 'future-contract' } } } };
  await newer.save(seed.workspace.id, current);
  const protectedState = JSON.stringify(fake.states.get(seed.workspace.id));
  let calls = 0;
  // No remote reload occurs inside an adapter. An admitted predecessor must be
  // drained before newer producers activate; CAS protects commit, not dispatch.
  await monitoredSync(stale, { syncProvider: async () => { calls++; return { status: 'connected' }; } }, 'ebay');
  assert.equal(calls, 1, 'The old captured snapshot cannot discover a remote fence');
  await assert.rejects(() => older.save(seed.workspace.id, stale), { code: 'STATE_CONFLICT' });
  assert.equal(JSON.stringify(fake.states.get(seed.workspace.id)), protectedState);
  const reloaded = await older.get(seed.workspace.id);
  assert.throws(() => assertLegacyReadAdmission(reloaded, 'ebay'), rejected);
  reloaded.workspace.name = 'Unrelated safe change';
  await older.save(seed.workspace.id, reloaded);
  const saved = fake.states.get(seed.workspace.id);
  assert.equal(saved.integrationStatus.ebay.retryAt, later);
  assert.deepEqual(saved.connectionDoctor.ebay, current.connectionDoctor.ebay);
  assert.deepEqual(saved.ebay.coverage, current.ebay.coverage);
});

test('unmarked Shopify retains the baseline request count, query and source format', async () => {
  const state = stateFor('shopify'); state.connections = [];
  const requests = [];
  const service = new IntegrationService({ SHOPIFY_ENV_WORKSPACE_ID: state.workspace.id, SHOPIFY_STORE_DOMAIN: 'baseline.myshopify.com', SHOPIFY_ADMIN_ACCESS_TOKEN: 'test' }, {
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body); requests.push({ url, options, body });
      return Response.json({ data: { [body.query === SHOPIFY_PRODUCTS_QUERY ? 'products' : 'orders']: { nodes: [], pageInfo: { hasNextPage: false } } } });
    }
  });
  await service.syncShopify(state);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.query, SHOPIFY_ORDERS_QUERY);
  assert.match(requests[1].body.variables.query, /^created_at:>=\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(requests[1].body.variables, { first: 50, after: null, query: requests[1].body.variables.query });
  assert.ok(requests.every(request => request.options.method === 'POST'));
  assert.equal(state.channelData?.shopify?.orderReads, undefined);
  assert.equal(state.integrationStatus.shopify.orderReadHold, undefined);
});

test('unmarked Pinterest keeps ordinary credential, pagination and request behavior', async () => {
  const state = stateFor('pinterest'), requests = [];
  state.connections[0].encryptedCredentials = encryptCredentials({ accessToken: 'test-access' }, key);
  const service = new IntegrationService({ CREDENTIALS_KEY: key }, { fetchImpl: async (url, options) => {
    requests.push({ url: new URL(url), options });
    return Response.json({ items: [{ id: 'record', name: 'Saved item' }] });
  } });
  await service.syncProvider(state, 'pinterest');
  assert.deepEqual(requests.map(item => item.url.pathname), ['/v5/boards', '/v5/pins']);
  assert.ok(requests.every(item => item.options.method === undefined && item.url.search === '?page_size=100'));
  assert.equal(state.channelData.pinterest.boards.length, 1);
  assert.equal(state.channelData.pinterest.pins.length, 1);
  assert.equal(state.connectionDoctor.pinterest.pendingReadAttempts, undefined);
});

test('ordinary eBay Manager retains six baseline GETs and expired retry evidence on success and partial reads', async () => {
  for (const partial of [false, true]) {
    const state = stateFor('ebay'); state.connections = [];
    Object.assign(state.integrationStatus.ebay, { retryAt: expired, retryReviewRequired: false });
    state.ebay = { coverage: { readDiagnostics: { marketing: { retryAt: expired, retryReviewRequired: false, code: 'SAVED' } } } };
    const requests = [];
    const service = new IntegrationService({ EBAY_ENV_WORKSPACE_ID: state.workspace.id, EBAY_MANAGER_BASE_URL: 'https://manager.example.test', EBAY_EXPECTED_ACCOUNT: 'seller' }, {
      fetchImpl: async (url, options) => {
        requests.push({ path: new URL(url).pathname, options });
        if (String(url).endsWith('/status')) return Response.json({ connected: true, account: 'seller' });
        if (partial && String(url).endsWith('/orders')) return Response.json({}, { status: 503 });
        return Response.json({ listings: [], drafts: [], orders: [], fees: [], promotions: [] });
      }
    });
    const result = await service.syncEbay(state);
    assert.equal(requests.length, 6);
    assert.ok(requests.every(request => request.options.method === 'GET'));
    assert.equal(Boolean(result.lastError), partial);
    assert.equal(result.retryAt, expired);
    assert.equal(result.retryReviewRequired, false);
    assert.deepEqual(state.ebay.coverage.readDiagnostics.marketing, { retryAt: expired, retryReviewRequired: false, code: 'SAVED' });
  }
});

test('ordinary direct eBay OAuth keeps four read requests and surface retry metadata after success or partial data', async () => {
  for (const partial of [false, true]) {
    const state = stateFor('ebay'), requests = [];
    Object.assign(state.integrationStatus.ebay, { retryAt: expired, retryReviewRequired: false });
    state.ebay = { coverage: { readDiagnostics: { orders: { retryAt: expired, retryReviewRequired: false } } } };
    const service = new IntegrationService({}, { fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).includes('/commerce/identity/')) return Response.json({ username: 'seller' });
      if (partial && String(url).includes('/fulfillment/')) return Response.json({}, { status: 503 });
      return Response.json({ orders: [], inventoryItems: [], campaigns: [], total: 0 });
    } });
    service.ebayAccessToken = async () => 'injected-test-token';
    const result = await service.syncEbayOAuth(state, { expectedAccount: 'seller', marketplaceId: 'EBAY_GB', connection: state.connections[0] });
    assert.equal(requests.length, 4);
    assert.ok(requests.every(request => request.options.method === 'GET'));
    assert.equal(Boolean(result.lastError), partial);
    assert.equal(result.retryAt, expired);
    assert.equal(result.retryReviewRequired, false);
    assert.equal(state.ebay.coverage.readDiagnostics.orders.retryAt, expired);
    assert.equal(state.ebay.coverage.readDiagnostics.orders.retryReviewRequired, false);
  }
});

test('expired eBay retry evidence remains through reconnect, token test-refresh and complete first sync', async () => {
  const state = stateFor('ebay'), service = guardedService();
  Object.assign(state.integrationStatus.ebay, { retryAt: expired, retryReviewRequired: false });
  const diagnostics = { orders: { retryAt: expired, retryReviewRequired: false } };
  state.ebay = { coverage: { readDiagnostics: structuredClone(diagnostics) } };
  state.connections[0].provider = 'ebay_oauth';
  service.ebayConfig = () => ({ mode: 'direct_oauth', expectedAccount: 'seller', connection: state.connections[0] });
  service.ebayAccessToken = async () => 'test-only-access';
  service.connectorIdentity = async () => ({ account: 'seller', accountId: 'seller-id' });
  activateConnection(state, 'ebay', 'owner');
  await service.testConnection(state, 'ebay', { refresh: true });
  queueFirstSync(state, 'ebay', 'owner');
  await runFirstSync(state, 'ebay', { integrations: { syncProvider: async () => ({ status: 'connected', lastError: null }) }, readSync: monitoredSync, save: async () => {} });
  assert.equal(state.connectionFirstSync.ebay.status, 'completed');
  assert.equal(state.integrationStatus.ebay.retryAt, expired);
  assert.equal(state.integrationStatus.ebay.retryReviewRequired, false);
  assert.deepEqual(state.ebay.coverage.readDiagnostics, diagnostics);
});

async function apiFixture(t, provider) {
  const state = stateFor(provider), calls = [], sessionSecret = 'compatibility-read-test-session-secret-long';
  const database = fakeSupabase(), store = createStore({ SUPABASE_URL: 'https://read-tests.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test' }, { fetchImpl: database.fetchImpl });
  await store.save(state.workspace.id, state);
  const env = {
    NODE_ENV: 'test', APP_PUBLIC_URL: 'https://runvara.example.test', SESSION_SECRET: sessionSecret, CREDENTIALS_KEY: key, SHOPIFY_PUBLIC_SYNC_ENABLED: 'false',
    SHOPIFY_OAUTH_ENABLED: 'true', SHOPIFY_OAUTH_CLIENT_ID: 'shopify-client-test', SHOPIFY_OAUTH_CLIENT_SECRET: 'shopify-client-secret-test-only',
    PINTEREST_OAUTH_ENABLED: 'true', PINTEREST_CLIENT_ID: 'pinterest-client-test', PINTEREST_CLIENT_SECRET: 'pinterest-client-secret-test-only',
    EBAY_OAUTH_ENABLED: 'true', EBAY_CLIENT_ID: 'ebay-client-test', EBAY_CLIENT_SECRET: 'ebay-client-secret-test-only', EBAY_REDIRECT_URI_NAME: 'ebay-redirect-test'
  };
  const server = createPacksmartServer(env, { store, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    assert.match(String(url), /pinterest\.com\/v5\/(boards|pins)\?/);
    return Response.json({ items: [] });
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await server.packsmart.drain(); });
  const user = state.users[0], token = createSessionToken({ userId: user.id, workspaceId: state.workspace.id, email: user.email, role: 'owner', sessionVersion: 1 }, sessionSecret);
  const request = async (route, { method = 'POST', body = {}, cookie } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method, redirect: 'manual', headers: { Cookie: cookie || `__Host-packsmart_session=${token}`, 'X-CSRF-Token': verifySessionToken(token, sessionSecret).csrf, 'Content-Type': 'application/json' },
      ...(method !== 'GET' ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text(); let payload; try { payload = JSON.parse(text); } catch { payload = text; }
    return { status: response.status, body: payload, headers: response.headers };
  };
  return { state, store, request, calls };
}
const providerSnapshot = (state, provider) => JSON.stringify({
  status: state.integrationStatus[provider], doctor: state.connectionDoctor[provider], firstSync: state.connectionFirstSync[provider],
  connections: state.connections.filter(item => item.provider === provider || provider === 'ebay' && item.provider === 'ebay_oauth'),
  ...(provider === 'ebay' ? { ebay: state.ebay } : {}), settings: state.connectionSettings[provider], challenges: state.oauthChallenges
});

test('held manual, legacy, reconnect and test-refresh API paths preserve metadata with zero provider calls', async t => {
  for (const provider of ['shopify', 'ebay', 'pinterest']) {
    const fixture = await apiFixture(t, provider), { store, request, calls } = fixture;
    const state = await store.get(fixture.state.workspace.id);
    state.connectionDoctor[provider].pendingReadAttempts = 5;
    if (provider === 'ebay') {
      state.integrationStatus.ebay.retryAt = later;
      state.ebay = { coverage: { readDiagnostics: { marketing: { retryReviewRequired: 'future' } } } };
    }
    await store.save(state.workspace.id, state);
    const before = providerSnapshot(await store.get(state.workspace.id), provider);
    for (const action of ['sync', 'test', 'refresh']) {
      const result = await request(`/api/connections/${provider}/${action}`);
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'READ_COMPATIBILITY_DEFERRED');
    }
    assert.equal((await request(`/api/integrations/${provider}/oauth/start`, { body: { storeDomain: 'baseline.myshopify.com' } })).status, 409);
    if (provider !== 'pinterest') {
      assert.equal((await request(`/api/integrations/${provider}/sync`)).status, 409);
      const credentials = provider === 'shopify' ? { storeDomain: 'baseline.myshopify.com', accessToken: 'new-token-only-for-test-32-characters' } : { baseUrl: 'https://manager.example.test', expectedAccount: 'seller', apiToken: 'test' };
      assert.equal((await request('/api/connections', { body: { provider, credentials } })).status, 409);
    }
    assert.equal(calls.length, 0);
    assert.equal(providerSnapshot(await store.get(state.workspace.id), provider), before);
  }
});

test('bulk API preserves a held provider byte-for-byte while an unrelated legacy provider still reads', async t => {
  const { state: original, store, request, calls } = await apiFixture(t, 'ebay');
  const state = await store.get(original.workspace.id);
  state.connectionDoctor.ebay.pendingReadAttempts = 5;
  state.integrationStatus.ebay.retryAt = later;
  state.ebay = { coverage: { readDiagnostics: { orders: { retryAt: later, retryReviewRequired: false } } } };
  state.connections.push({ id: 'pinterest-connection', provider: 'pinterest', status: 'connected', metadata: {}, encryptedCredentials: encryptCredentials({ accessToken: 'test-access' }, key) });
  state.connectionSettings.pinterest = connectionSettings(state, 'pinterest');
  await store.save(state.workspace.id, state);
  const before = providerSnapshot(await store.get(state.workspace.id), 'ebay');
  const result = await request('/api/integrations/sync');
  assert.equal(result.status, 200);
  assert.equal(result.body.integrations.ebay.code, 'READ_COMPATIBILITY_DEFERRED');
  assert.equal(result.body.integrations.pinterest.status, 'connected');
  assert.equal(calls.length, 2);
  assert.equal(providerSnapshot(await store.get(state.workspace.id), 'ebay'), before);
});

test('a retained hold at OAuth callback admission leaves the existing challenge and connection untouched', async t => {
  for (const provider of ['shopify', 'ebay', 'pinterest']) {
    const { state: original, store, request, calls } = await apiFixture(t, provider);
    const start = await request(`/api/integrations/${provider}/oauth/start`, { body: { storeDomain: 'baseline.myshopify.com' } });
    assert.equal(start.status, 200);
    const token = new URL(start.body.authorizationUrl).searchParams.get('state');
    const cookie = start.headers.get('set-cookie').split(';')[0];
    const state = await store.get(original.workspace.id);
    state.connectionDoctor[provider].pendingReadAttempts = 1;
    await store.save(state.workspace.id, state);
    const before = providerSnapshot(await store.get(state.workspace.id), provider);
    const response = await request(`/api/integrations/${provider}/oauth/callback?state=${encodeURIComponent(token)}&code=test-only-code`, { method: 'GET', cookie });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'READ_COMPATIBILITY_DEFERRED');
    assert.equal(calls.length, 0);
    assert.equal(providerSnapshot(await store.get(state.workspace.id), provider), before);
  }
});
