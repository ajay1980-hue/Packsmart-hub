import test from 'node:test';
import assert from 'node:assert/strict';
import { seedWorkspaceState } from '../lib/store.mjs';
import { connectionSettings, connectionDue, connectionReadAttempts, pendingConnectionReadExhausted, shopifyOrderReadBinding, completeShopifyOrderReadBudget } from '../lib/connection-centre.mjs';
import { queueFirstSync, runFirstSync, runConnectionDoctor } from '../lib/connection-doctor.mjs';
import { monitoredSync, createScheduler } from '../lib/scheduler.mjs';

const NOW = Date.parse('2026-10-07T12:00:00Z'), HOUR = 3600001;
const PROVIDERS = ['ebay', 'pinterest', 'shopify'];
const failure = () => Object.assign(new Error('Synthetic source failure'), { code: 'UPSTREAM_REQUEST_FAILED', upstreamStatus: 503 });
const lost = () => Object.assign(new Error('Synthetic lost save'), { code: 'PERSISTENCE_INTERRUPTED' });
function fixture(provider, firstSync = false, areas = provider === 'shopify' ? ['products'] : undefined) {
  const state = seedWorkspaceState({}, { workspaceId: 'read-admission' });
  state.connections = [{ id: 'source', provider: provider === 'ebay' ? 'ebay_oauth' : provider,
    encryptedCredentials: 'synthetic-record', status: 'connected', lastCheckedAt: new Date(NOW - HOUR).toISOString(),
    metadata: { account: 'Synthetic', shopDomain: 'fixture.myshopify.com', shopId: 'fixture-shop' } }];
  state.connectionSettings = { [provider]: { ...connectionSettings(state, provider), ...(areas ? { areas } : {}), managedReadSchedule: true } };
  state.integrationStatus = { [provider]: { status: 'error', lastError: 'UPSTREAM_REQUEST_FAILED', upstreamStatus: 503 } };
  state.connectionDoctor = {}; state.connectionSyncs = []; state.products = []; state.orders = []; state.autopilot.enabled = false;
  if (firstSync) queueFirstSync(state, provider, 'owner');
  return state;
}
function service(syncProvider, extra = {}) {
  return { syncProvider, oauthReady: () => true, refreshSupported: () => false, connectionAccessExpiry: () => null,
    shopifyConfigured: () => true, ebayConfigured: () => true, shopifyRefreshAvailable: () => true,
    shopifyConfig: state => ({ connection: state.connections[0], domain: state.connections[0]?.metadata.shopDomain, apiVersion: '2026-07' }), ...extra };
}
function persisted(initial) {
  let encoded = JSON.stringify(initial);
  const snapshots = [];
  return { snapshots, load: () => JSON.parse(encoded), save: async state => { encoded = JSON.stringify(state); snapshots.push(JSON.parse(encoded)); } };
}
const doctor = (state, integrations, save) => runConnectionDoctor(state, { integrations, readSync: monitoredSync, now: new Date(), save: () => save(state) });

for (const provider of PROVIDERS) for (const firstSync of [false, true]) for (const succeeds of [false, true]) {
  test(`${provider} ${firstSync ? 'first-sync' : 'direct'} caps lost ${succeeds ? 'successful' : 'failed'} result saves at five shared admissions`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const disk = persisted(fixture(provider, firstSync));
    let calls = 0, afterRead;
    const integrations = service(async () => {
      calls++; afterRead = true;
      const durable = disk.load();
      assert.equal(connectionReadAttempts(durable.connectionDoctor[provider]), calls);
      assert.equal(durable.connectionSyncs[0].status, 'running');
      assert.ok(Date.parse(durable.connectionSyncs[0].leaseUntil) > Date.now());
      if (!succeeds) throw failure();
      return { status: 'connected', lastError: null };
    });
    for (let pass = 1; pass <= 8; pass++) {
      afterRead = false;
      const current = disk.load(), saves = disk.snapshots.length, before = JSON.stringify(current);
      const run = doctor(current, integrations, async state => { if (afterRead) throw lost(); await disk.save(state); });
      if (pass <= 5) await assert.rejects(run, { code: 'PERSISTENCE_INTERRUPTED' });
      else { await run; assert.equal(disk.snapshots.length, saves); assert.equal(JSON.stringify(current), before); }
      t.mock.timers.tick(HOUR);
    }
    assert.equal(calls, 5);
    assert.equal(disk.load().connectionDoctor[provider].pendingReadAttempts, 5);
    assert.equal(connectionDue(disk.load(), provider, new Date(), integrations), false);
    assert.equal(disk.snapshots.length, firstSync ? 15 : 10, 'No additional admission saves');
  });
}

for (const provider of PROVIDERS) for (const firstSync of [false, true]) for (const committed of [false, true]) {
  test(`${provider} ${firstSync ? 'first-sync' : 'direct'} ${committed ? 'ambiguous committed' : 'uncommitted'} pre-read save never invokes source`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const disk = persisted(fixture(provider, firstSync)); let calls = 0;
    const integrations = service(async () => { calls++; throw failure(); });
    for (let pass = 1; pass <= 7; pass++) {
      const current = disk.load(), prior = current.connectionDoctor[provider]?.pendingReadAttempts || 0;
      const run = doctor(current, integrations, async state => {
        if (state.connectionDoctor[provider]?.pendingReadAttempts > prior) { if (committed) await disk.save(state); throw lost(); }
        await disk.save(state);
      });
      if (!committed || pass <= 5) await assert.rejects(run, { code: 'PERSISTENCE_INTERRUPTED' });
      else await run;
      t.mock.timers.tick(HOUR);
    }
    assert.equal(calls, 0);
    const current = disk.load();
    assert.equal(current.connectionDoctor[provider]?.pendingReadAttempts, committed ? 5 : undefined);
    await doctor(current, integrations, disk.save);
    assert.equal(calls, committed ? 0 : provider === 'pinterest' && firstSync ? 2 : 1);
    if (!committed) assert.equal(current.connectionDoctor[provider].attempts, 1);
  });
}

for (const provider of PROVIDERS) for (const firstSync of [false, true]) {
  test(`${provider} ${firstSync ? 'first-sync' : 'direct'} successful result commit clears only completed generic debt without extra saves`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const initial = fixture(provider, firstSync); initial.connectionDoctor[provider] = { attempts: 3, pendingReadAttempts: 3 };
    const disk = persisted(initial); let calls = 0, loseFinal = true;
    const integrations = service(async () => { calls++; assert.ok(disk.load().connectionDoctor[provider].pendingReadAttempts >= 1); return { status: 'connected', lastError: null }; });
    const current = disk.load();
    await assert.rejects(doctor(current, integrations, async state => {
      await disk.save(state);
      if (loseFinal && calls && !state.connectionDoctor[provider].pendingReadAttempts) { loseFinal = false; throw lost(); }
    }), { code: 'PERSISTENCE_INTERRUPTED' });
    assert.equal(disk.load().connectionDoctor[provider].pendingReadAttempts, undefined);
    assert.equal(connectionDue(disk.load(), provider, new Date(), integrations), false);
    t.mock.timers.tick(HOUR);
    const reloaded = disk.load(); await doctor(reloaded, integrations, disk.save);
    assert.equal(reloaded.connectionDoctor[provider].attempts, 0);
    assert.equal(reloaded.connectionDoctor[provider].pendingReadAttempts, undefined);
  });
}

for (const provider of PROVIDERS) test(`${provider} known grouped failures spend one attempt, then known recovery releases it`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const state = fixture(provider, true), disk = persisted(state); let fail = true, calls = 0;
  const integrations = service(async () => { calls++; if (fail) throw failure(); return { status: 'connected', lastError: null }; });
  for (let pass = 1; pass <= 4; pass++) {
    await doctor(state, integrations, disk.save); assert.equal(state.connectionDoctor[provider].attempts, pass);
    assert.equal(state.connectionDoctor[provider].pendingReadAttempts, pass); t.mock.timers.tick(HOUR);
  }
  assert.equal(calls, provider === 'pinterest' ? 8 : 4);
  fail = false; await doctor(state, integrations, disk.save);
  assert.equal(state.connectionDoctor[provider].attempts, 0); assert.equal(state.connectionDoctor[provider].pendingReadAttempts, undefined);
  assert.equal(state.connectionFirstSync[provider].status, 'completed');
});

test('Pinterest group-result persistence retains completed areas and bounds later-group losses', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const disk = persisted(fixture('pinterest', true)), calls = []; let lose = false;
  const integrations = service(async (_state, _provider, { areas }) => { calls.push(areas[0]); lose = areas.includes('pins'); return { status: 'connected', lastError: null }; });
  for (let pass = 0; pass < 7; pass++) {
    lose = false;
    try { await doctor(disk.load(), integrations, async state => { if (lose) throw lost(); await disk.save(state); }); }
    catch (error) { assert.equal(error.code, 'PERSISTENCE_INTERRUPTED'); }
    t.mock.timers.tick(HOUR);
  }
  assert.deepEqual(calls, ['boards', 'pins', 'pins', 'pins', 'pins', 'pins']);
  assert.equal(disk.load().connectionFirstSync.pinterest.areas.boards, 'completed');
  assert.equal(disk.load().connectionDoctor.pinterest.pendingReadAttempts, 5);
});

for (const orderSuccess of [false, true]) test(`mixed Shopify fifth admission survives products failure and ${orderSuccess ? 'admitted orders' : 'order failure'} without double charge`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const state = fixture('shopify', true, ['products', 'orders']); state.connectionDoctor.shopify = { attempts: 4 };
  const disk = persisted(state), calls = [];
  const integrations = service(async (current, _provider, { areas }) => {
    calls.push(areas[0]); assert.equal(connectionReadAttempts(disk.load().connectionDoctor.shopify), 5);
    if (areas.includes('products') || !orderSuccess) throw failure();
    completeShopifyOrderReadBudget(current, integrations, shopifyOrderReadBinding(current, integrations));
    return { status: 'connected', lastError: null };
  });
  await doctor(state, integrations, disk.save);
  assert.deepEqual(calls, ['products', 'orders']);
  assert.equal(state.connectionDoctor.shopify.attempts, 5); assert.equal(state.connectionDoctor.shopify.exhausted, true);
  assert.equal(state.connectionDoctor.shopify.pendingReadAttempts, 5);
  assert.equal(Boolean(state.connectionDoctor.shopify.orderReadBinding), !orderSuccess);
  const saves = disk.snapshots.length;
  t.mock.timers.tick(HOUR); await doctor(disk.load(), integrations, disk.save);
  assert.equal(disk.snapshots.length, saves); assert.equal(calls.length, 2);
});

for (const sourcePolicy of ['shopify-orders-v1:90-day-created:10-pages:50-orders:100-lines', 'unknown-policy']) {
  test(`products share remaining headroom without spending or releasing ${sourcePolicy} order debt`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const initial = fixture('shopify'); let calls = 0, afterRead;
    const integrations = service(async () => { calls++; afterRead = true; return { status: 'connected', lastError: null }; });
    const binding = { ...shopifyOrderReadBinding(initial, integrations), sourcePolicy };
    initial.connectionDoctor.shopify = { attempts: 3, exhausted: false, orderReadBinding: binding };
    const disk = persisted(initial);
    for (let pass = 0; pass < 5; pass++) {
      afterRead = false;
      try { await doctor(disk.load(), integrations, async state => { if (afterRead) throw lost(); await disk.save(state); }); }
      catch (error) { assert.equal(error.code, 'PERSISTENCE_INTERRUPTED'); }
      t.mock.timers.tick(HOUR);
    }
    assert.equal(calls, 2); const durable = disk.load().connectionDoctor.shopify;
    assert.equal(durable.attempts, 3); assert.equal(durable.exhausted, false); assert.deepEqual(durable.orderReadBinding, binding);
    assert.equal(durable.pendingReadAttempts, 5);
  });
}

for (const provider of PROVIDERS) test(`${provider} stale concurrent snapshots lose CAS before provider I/O and live leases remain exclusive`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  let encoded = JSON.stringify(fixture(provider)), version = 0, calls = 0, release;
  const revisions = new WeakMap(), gate = new Promise(resolve => { release = resolve; });
  const load = () => { const state = JSON.parse(encoded); revisions.set(state, version); return state; };
  const save = async state => {
    if (revisions.get(state) !== version) throw Object.assign(new Error('Synthetic CAS conflict'), { code: 'STATE_CONFLICT' });
    version++; revisions.set(state, version); encoded = JSON.stringify(state);
  };
  let entered; const reading = new Promise(resolve => { entered = resolve; });
  const integrations = service(async () => { calls++; entered(); await gate; throw failure(); });
  const a = load(), b = load();
  const first = doctor(a, integrations, save), second = doctor(b, integrations, save);
  await assert.rejects(second, { code: 'STATE_CONFLICT' }); await reading;
  await doctor(load(), integrations, save); assert.equal(calls, 1);
  release(); await first;
  assert.equal(JSON.parse(encoded).connectionDoctor[provider].pendingReadAttempts, 1);
  t.mock.timers.tick(HOUR); await doctor(load(), integrations, save);
  assert.equal(calls, 2); assert.equal(JSON.parse(encoded).connectionDoctor[provider].attempts, 2);
});

for (const provider of PROVIDERS) for (const pendingReadAttempts of [5, 6, null, -1, 1.5, '2']) {
  test(`${provider} exhausted or malformed pending ${JSON.stringify(pendingReadAttempts)} fails closed in Doctor, first-sync and legacy scheduler`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const state = fixture(provider, true); state.connectionDoctor[provider] = { pendingReadAttempts };
    const integrations = service(async () => assert.fail('No provider reads'), { shopifyConfigured: () => provider === 'shopify', shopifyRefreshAvailable: () => provider === 'shopify', ebayConfigured: () => provider === 'ebay' });
    const save = async () => assert.fail('No new durable claims');
    assert.equal(pendingConnectionReadExhausted(state, provider, integrations), true);
    assert.equal(connectionDue(state, provider, new Date(), integrations), false);
    const before = structuredClone(state);
    await doctor(state, integrations, save);
    await runFirstSync(state, provider, { integrations, readSync: monitoredSync, save, automatic: true });
    assert.deepEqual(state, before);
    delete state.connectionSettings; delete state.connectionSyncs;
    state.autopilot.enabled = true;
    for (const key of Object.keys(state.automations)) state.automations[key] = key === 'channelSync';
    const scheduler = createScheduler({ store: { get: async () => structuredClone(state), save }, integrations,
      withWorkspaceLock: async (_id, action) => action(), currentBrief: () => ({}), enabled: false });
    assert.equal((await scheduler.runWorkspace(state.workspace.id)).skipped, true);
  });
}

test('refresh preserves uncertain read debt and never spends a new read admission', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  for (const provider of PROVIDERS) {
    const state = fixture(provider); state.connectionDoctor[provider] = { attempts: 2, pendingReadAttempts: 3 };
    let refreshes = 0;
    const integrations = service(async () => assert.fail('No read during refresh'), { refreshSupported: () => true,
      connectionAccessExpiry: () => new Date(NOW - 1000).toISOString(), testConnection: async () => { refreshes++; return { ok: true }; } });
    await doctor(state, integrations, async () => {});
    assert.equal(refreshes, 1); assert.equal(state.connectionDoctor[provider].pendingReadAttempts, 3);
    assert.equal(connectionReadAttempts(state.connectionDoctor[provider]), 3);
  }
});

for (const provider of PROVIDERS) for (const firstSync of [false, true]) test(`${provider} ${firstSync ? 'first-sync' : 'direct'} admission adds only 24 bytes inside existing saves`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const state = fixture(provider, firstSync), disk = persisted(state); let calls = 0;
  const integrations = service(async () => { calls++; return { status: 'connected', lastError: null }; });
  await doctor(state, integrations, disk.save);
  assert.equal(calls, provider === 'pinterest' && firstSync ? 2 : 1);
  assert.equal(disk.snapshots.length, firstSync ? provider === 'pinterest' ? 9 : 7 : 4);
  const preRead = disk.snapshots.find(snapshot => snapshot.connectionSyncs[0]?.status === 'running');
  const without = structuredClone(preRead); delete without.connectionDoctor[provider].pendingReadAttempts;
  const bytes = Buffer.byteLength(JSON.stringify(preRead)) - Buffer.byteLength(JSON.stringify(without));
  assert.equal(bytes, 24);
  t.diagnostic(`${provider}/${firstSync ? 'first-sync' : 'direct'}: ${calls} existing grouped reads, ${disk.snapshots.length} existing saves, ${bytes} added pre-read bytes`);
});

test('a verified Shopify source replacement resets source-bound pending debt; metadata loss does not', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  for (const replacement of [false, true]) {
    const state = fixture('shopify'); let calls = 0;
    const integrations = service(async () => { calls++; return { status: 'connected', lastError: null }; });
    state.connectionDoctor.shopify = { attempts: 3, pendingReadAttempts: 5, orderReadBinding: shopifyOrderReadBinding(state, integrations) };
    if (replacement) state.connections[0].metadata.shopId = 'replacement-shop';
    else delete state.connections[0].metadata.shopId;
    const disk = persisted(state);
    await doctor(state, integrations, disk.save);
    assert.equal(calls, replacement ? 1 : 0);
    assert.equal(state.connectionDoctor.shopify.pendingReadAttempts, replacement ? undefined : 5);
  }
});

for (const provider of PROVIDERS) test(`${provider} pending exhaustion truthfully projects paused reads and manual retry without mutation`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { intelligentConnections, classifyConnectionIssue } = await import('../lib/connection-intelligence.mjs');
  const state = fixture(provider); state.connectionDoctor[provider] = { pendingReadAttempts: 5, nextRetryAt: new Date(NOW + HOUR).toISOString() };
  state.connectionSyncs = [{ provider, status: 'running', leaseUntil: new Date(NOW - 1).toISOString() }];
  const integrations = service(async () => assert.fail('Health never reads'), { ebayConnection: current => current.connections[0] });
  const before = structuredClone(state);
  assert.equal(classifyConnectionIssue(state, provider, new Date(), undefined, integrations).kind, 'read_retry_exhausted');
  const channel = intelligentConnections(state, integrations, { now: new Date() }).find(row => row.id === provider);
  assert.equal(channel.health.status, 'Attention needed'); assert.equal(channel.health.action.action, 'sync');
  assert.match(channel.health.message, /paused|manually/i); assert.doesNotMatch(channel.health.message, /can resume|will retry/);
  assert.equal(channel.health.nextRetryAt, null);
  assert.deepEqual(state, before);
});

for (const provider of PROVIDERS) for (const firstSync of [false, true]) test(`${provider} ${firstSync ? 'first-sync' : 'direct'} ambiguous committed failed results cannot reopen the five-pass budget`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const disk = persisted(fixture(provider, firstSync)); let calls = 0, afterRead;
  const integrations = service(async () => { calls++; afterRead = true; throw failure(); });
  for (let pass = 0; pass < 8; pass++) {
    afterRead = false;
    try { await doctor(disk.load(), integrations, async state => { await disk.save(state); if (afterRead) throw lost(); }); }
    catch (error) { assert.equal(error.code, 'PERSISTENCE_INTERRUPTED'); }
    t.mock.timers.tick(HOUR);
  }
  assert.equal(calls, 5); assert.equal(connectionReadAttempts(disk.load().connectionDoctor[provider]), 5);
});

test('exhausted eBay commerce reads retain the marketing restriction without claiming they can continue', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { intelligentConnections, classifyConnectionIssue } = await import('../lib/connection-intelligence.mjs');
  const state = fixture('ebay'); state.connectionDoctor.ebay = { pendingReadAttempts: 5, nextRetryAt: new Date(NOW + HOUR).toISOString() };
  state.ebay = { coverage: { readDiagnostics: { marketing: { errorIds: ['35077'] } } } };
  const integrations = service(async () => assert.fail('Projection never reads'), { ebayConnection: current => current.connections[0] });
  const issue = classifyConnectionIssue(state, 'ebay', new Date(), undefined, integrations);
  assert.equal(issue.kind, 'provider_restriction'); assert.equal(issue.action.action, 'sync');
  assert.match(issue.message, /paused|manually/); assert.doesNotMatch(issue.message, /can continue/);
  const channel = intelligentConnections(state, integrations, { now: new Date() }).find(row => row.id === 'ebay');
  assert.equal(channel.health.action.action, 'sync'); assert.equal(channel.health.nextRetryAt, null);
});

test('inherited failed-refresh accounting still exhausts the existing bound counter without a new read allowance', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  for (const sourcePolicy of ['shopify-orders-v2:90-day-updated-window:10-pages:50-orders:100-lines', 'shopify-orders-v1:90-day-created:10-pages:50-orders:100-lines', 'unknown-policy']) for (const pendingReadAttempts of [undefined, 4]) {
    const state = fixture('shopify'); let refreshes = 0;
    const integrations = service(async () => assert.fail('Refresh must not read products'), { refreshSupported: () => true,
      connectionAccessExpiry: () => new Date(NOW - 1000).toISOString(), testConnection: async () => { refreshes++; throw failure(); } });
    const binding = { ...shopifyOrderReadBinding(state, integrations), sourcePolicy };
    state.connectionDoctor.shopify = { attempts: 4, exhausted: false, orderReadBinding: binding, ...(pendingReadAttempts ? { pendingReadAttempts } : {}) };
    await doctor(state, integrations, async () => {});
    assert.equal(refreshes, 1); assert.equal(state.connectionDoctor.shopify.attempts, 5); assert.equal(state.connectionDoctor.shopify.exhausted, true);
    assert.deepEqual(state.connectionDoctor.shopify.orderReadBinding, binding);
    assert.equal(state.connectionDoctor.shopify.pendingReadAttempts, pendingReadAttempts);
    t.mock.timers.tick(HOUR); await doctor(state, integrations, async () => assert.fail('Exhaustion remains quiet'));
    assert.equal(refreshes, 1);
  }
});
