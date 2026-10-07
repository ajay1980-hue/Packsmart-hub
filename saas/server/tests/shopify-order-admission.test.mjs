import test from 'node:test';
import assert from 'node:assert/strict';
import { seedWorkspaceState } from '../lib/store.mjs';
import { connectionDoctorState, connectionDue, connectionSettings, shopifyOrderReadBinding } from '../lib/connection-centre.mjs';
import { queueFirstSync, runConnectionDoctor, runFirstSync } from '../lib/connection-doctor.mjs';
import { createScheduler, monitoredSync } from '../lib/scheduler.mjs';
import { IntegrationService } from '../lib/integrations.mjs';
import { encryptCredentials } from '../lib/security.mjs';
import { configureAutopilot, dueRules, ensureControl } from '../lib/control.mjs';
import { applyAutomationRetention, isAutomationArchiveStub, planAutomationRetention } from '../lib/automation-retention.mjs';

const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const EARLIER = '2026-10-01T10:00:00.000Z';
const KEY = 'admission-fixture-encryption-key-thirty-two';
const TOKEN = 'synthetic-admission-token';
const SOURCE_CODE = 'SHOPIFY_ORDER_SOURCE_SHAPE_INVALID';
const HOUR = 3600000;

function fixture(areas = ['orders']) {
  const state = seedWorkspaceState({}, { workspaceId: 'shopify-admission-fixture' });
  state.connections = [{ id: 'connection-1', provider: 'shopify', status: 'connected',
    encryptedCredentials: 'synthetic-encrypted-record', lastCheckedAt: EARLIER,
    metadata: { shopDomain: 'admission.myshopify.com', shopId: 'shop-1' } }];
  state.products = [{ id: 'retained-product', provider: 'shopify', variants: [] }];
  state.orders = [{ id: 'retained-order', provider: 'shopify', total: 19, actualShippingCost: 3 }];
  state.connectionSettings = { shopify: { ...connectionSettings(state, 'shopify'), areas, managedReadSchedule: true } };
  state.integrationStatus = { shopify: { status: 'connected', lastSyncAt: EARLIER, lastSuccessfulSyncAt: EARLIER,
    areaSuccessAt: { products: EARLIER, orders: EARLIER } } };
  state.connectionDoctor = {};
  state.connectionSyncs = [];
  state.autopilot.enabled = false;
  return state;
}

function service(syncProvider = async () => ({ status: 'connected', lastError: null }), extra = {}) {
  return { syncProvider, shopifyRefreshAvailable: () => true, shopifyConfigured: () => true,
    ebayConfigured: () => false, oauthReady: () => true, refreshSupported: () => false,
    connectionAccessExpiry: () => null,
    shopifyConfig: state => ({ connection: state.connections[0] || null,
      domain: state.connections[0]?.metadata?.shopDomain || 'admission.myshopify.com', apiVersion: '2026-07', accessToken: TOKEN }),
    ...extra };
}

function budget(state, integrations, attempts = 3) {
  state.connectionDoctor.shopify = { attempts, exhausted: attempts >= 5,
    orderReadBinding: shopifyOrderReadBinding(state, integrations) };
  return state.connectionDoctor.shopify;
}

function persisted(initial) {
  let encoded = JSON.stringify(initial);
  const snapshots = [];
  return {
    snapshots,
    load: () => JSON.parse(encoded),
    save: async state => { encoded = JSON.stringify(state); snapshots.push(JSON.parse(encoded)); }
  };
}

const sourceError = () => Object.assign(new TypeError('Untrusted source detail'), {
  code: SOURCE_CODE, status: 422, nonRetryable: true, upstreamStatus: 503
});
const persistenceError = () => Object.assign(new Error('Synthetic lost result'), { code: 'PERSISTENCE_INTERRUPTED' });
const runDoctor = (state, integrations, save) => runConnectionDoctor(state, {
  integrations, readSync: monitoredSync, save: () => save(state), now: new Date()
});

function actualService(state, respond) {
  state.connections[0].encryptedCredentials = encryptCredentials({
    storeDomain: state.connections[0].metadata.shopDomain, accessToken: TOKEN
  }, KEY);
  return new IntegrationService({ CREDENTIALS_KEY: KEY, SHOPIFY_ADMIN_API_VERSION: '2026-07' }, {
    fetchImpl: async (url, options) => {
      const request = JSON.parse(options.body);
      assert.match(request.query, /query PacksmartOpsOrders/);
      assert.doesNotMatch(request.query, /\bmutation\b|ConnectionIdentity/);
      return respond(url, options);
    }
  });
}

function sourceResponse() {
  const money = amount => ({ shopMoney: { amount, currencyCode: 'GBP' } });
  return Response.json({ data: { orders: { nodes: [{
    id: 'gid://shopify/Order/admitted', name: '#admitted', createdAt: EARLIER, updatedAt: EARLIER,
    cancelledAt: null, displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED',
    totalPriceSet: money('10.00'), currentTotalPriceSet: money('10.00'),
    currentTotalTaxSet: money('0.00'), currentTotalDiscountsSet: money('0.00'), currentShippingPriceSet: money('0.00'),
    lineItems: { nodes: [], pageInfo: { hasNextPage: false } }
  }], pageInfo: { hasNextPage: false, endCursor: null } } } }, { headers: { 'X-Shopify-API-Version': '2026-07' } });
}

for (const firstSync of [false, true]) test(`${firstSync ? 'first-sync' : 'direct'} Doctor reserves orders in existing pre-read saves without added saves`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const state = fixture();
  if (firstSync) queueFirstSync(state, 'shopify', 'owner');
  const disk = persisted(state);
  let calls = 0;
  const integrations = service(async () => {
    calls++;
    const durable = disk.load();
    assert.equal(durable.connectionDoctor.shopify.attempts, 1);
    assert.equal(durable.connectionDoctor.shopify.exhausted, false);
    assert.deepEqual(durable.connectionDoctor.shopify.orderReadBinding, shopifyOrderReadBinding(state, integrations));
    assert.equal(durable.connectionSyncs[0].status, 'running');
    assert.deepEqual(durable.connectionSyncs[0].areas, ['orders']);
    assert.ok(Date.parse(durable.connectionSyncs[0].leaseUntil) > Date.now());
    return { status: 'connected', lastError: null };
  });
  await runDoctor(state, integrations, disk.save);
  assert.equal(calls, 1);
  assert.equal(disk.snapshots.length, firstSync ? 7 : 4);
  assert.equal(state.connectionDoctor.shopify.attempts, 1, 'A generic connected result cannot prove source admission');
  assert.equal(disk.snapshots[0].connectionDoctor.shopify.attempts, firstSync ? undefined : 1);
  const preRead = disk.snapshots.find(saved => saved.connectionSyncs[0]?.status === 'running');
  const withoutCharge = structuredClone(preRead);
  for (const key of ['attempts', 'exhausted', 'orderReadBinding']) delete withoutCharge.connectionDoctor.shopify[key];
  const addedBytes = Buffer.byteLength(JSON.stringify(preRead)) - Buffer.byteLength(JSON.stringify(withoutCharge));
  // Exact fixture overhead, measured in the already-required serialized save.
  assert.equal(addedBytes, 336);
  assert.doesNotMatch(JSON.stringify(preRead.connectionDoctor.shopify.orderReadBinding), /synthetic|token|credential/i);
  t.diagnostic(`${firstSync ? 'first-sync' : 'direct'}: ${disk.snapshots.length} existing saves; ${addedBytes} added pre-read bytes`);
});

test('products and orders first-sync groups charge only orders, once even on the Doctor failure path', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const state = fixture(['products', 'orders']);
  queueFirstSync(state, 'shopify', 'owner');
  const disk = persisted(state), calls = [];
  const integrations = service(async (_current, _provider, { areas }) => {
    calls.push(areas);
    const durable = disk.load();
    if (areas.includes('products')) {
      assert.equal(durable.connectionDoctor.shopify.attempts, undefined);
      return { status: 'connected', lastError: null };
    }
    assert.equal(durable.connectionDoctor.shopify.attempts, calls.filter(group => group.includes('orders')).length);
    throw Object.assign(new Error('Temporary provider failure'), { code: 'UPSTREAM_REQUEST_FAILED', upstreamStatus: 503 });
  });
  for (let attempt = 1; attempt <= 5; attempt++) {
    await runDoctor(state, integrations, disk.save);
    assert.equal(state.connectionDoctor.shopify.attempts, attempt);
    assert.equal(state.connectionDoctor.shopify.exhausted, attempt === 5);
    t.mock.timers.tick(HOUR + 1);
  }
  assert.equal(calls.filter(group => group.includes('products')).length, 1);
  assert.equal(calls.filter(group => group.includes('orders')).length, 5);
  assert.equal(state.connectionFirstSync.shopify.areas.products, 'completed');
  const before = JSON.stringify(state), saves = disk.snapshots.length;
  for (let check = 0; check < 3; check++) {
    await runDoctor(state, integrations, disk.save);
    await runFirstSync(state, 'shopify', { integrations, readSync: monitoredSync, save: () => disk.save(state), automatic: true, retryFailedOnly: true });
    t.mock.timers.tick(HOUR);
  }
  assert.equal(JSON.stringify(state), before);
  assert.equal(disk.snapshots.length, saves);
  assert.equal(calls.length, 6);
});

test('a normally persisted structural hold stops after its first charged read', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  for (const firstSync of [false, true]) {
    const state = fixture();
    if (firstSync) queueFirstSync(state, 'shopify', 'owner');
    const disk = persisted(state);
    let calls = 0;
    const integrations = service(async () => { calls++; throw sourceError(); });
    await runDoctor(state, integrations, disk.save);
    assert.equal(disk.load().connectionDoctor.shopify.attempts, 1);
    assert.equal(disk.load().integrationStatus.shopify.orderReadHold.code, SOURCE_CODE);
    const saves = disk.snapshots.length;
    for (let check = 0; check < 7; check++) {
      t.mock.timers.tick(HOUR);
      await runDoctor(disk.load(), integrations, disk.save);
    }
    assert.equal(calls, 1);
    assert.equal(disk.snapshots.length, saves);
  }
});

for (const firstSync of [false, true]) for (const successfulSource of [false, true]) for (const loss of ['result-save', 'interruption']) {
  test(`${firstSync ? 'first-sync' : 'direct'} durable admission caps ${successfulSource ? 'admitted success' : 'failed source'} replay after ${loss}`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const initial = fixture();
    if (firstSync) queueFirstSync(initial, 'shopify', 'owner');
    let calls = 0, afterProvider = false, current;
    const integrations = actualService(initial, async () => {
      calls++;
      const durable = disk.load();
      assert.equal(durable.connectionDoctor.shopify.attempts, calls);
      assert.equal(durable.connectionDoctor.shopify.exhausted, calls === 5);
      assert.equal(durable.connectionSyncs[0].status, 'running');
      assert.ok(Date.parse(durable.connectionSyncs[0].leaseUntil) > Date.now());
      afterProvider = true;
      return successfulSource ? sourceResponse() : Response.json({ data: {} });
    });
    const disk = persisted(initial);
    for (let check = 1; check <= 8; check++) {
      // The passed Doctor time AND beginConnectionSync's Date.now advance.
      t.mock.timers.tick(HOUR + 1);
      current = disk.load();
      afterProvider = false;
      const savesBefore = disk.snapshots.length;
      const run = runConnectionDoctor(current, { integrations, now: new Date(),
        save: async () => {
          if (afterProvider) {
            if (successfulSource) assert.equal(current.connectionDoctor.shopify.attempts, 0, 'Actual promotion releases only the in-memory budget');
            throw persistenceError();
          }
          await disk.save(current);
        },
        readSync: async (...args) => {
          if (loss === 'result-save') return monitoredSync(...args);
          try { await monitoredSync(...args); } catch (error) {
            assert.equal(successfulSource, false);
            assert.equal(error.code, SOURCE_CODE);
          }
          throw persistenceError();
        }
      });
      if (check <= 5) await assert.rejects(run, { code: 'PERSISTENCE_INTERRUPTED' });
      else {
        await run;
        assert.equal(disk.snapshots.length, savesBefore, 'Exhausted reloads must not write another claim or audit');
      }
      assert.equal(calls, Math.min(check, 5));
      assert.equal(disk.load().connectionDoctor.shopify.attempts, Math.min(check, 5));
      assert.deepEqual(disk.load().orders, initial.orders, 'An uncommitted result never replaces the durable source');
    }
    assert.equal(calls, 5, 'The fifth request executes, and all later checks stop');
    assert.equal(disk.load().connectionDoctor.shopify.exhausted, true);
    assert.equal(connectionDue(disk.load(), 'shopify', new Date(), integrations), false);
  });
}

test('a failed pre-read save never invokes Shopify, and a later durable retry spends one attempt', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  for (const firstSync of [false, true]) {
    const state = fixture();
    if (firstSync) queueFirstSync(state, 'shopify', 'owner');
    const disk = persisted(state);
    let calls = 0;
    const integrations = service(async () => { calls++; return { status: 'connected', lastError: null }; });
    await assert.rejects(runDoctor(state, integrations, async current => {
      if (current.connectionDoctor.shopify.attempts) throw persistenceError();
      await disk.save(current);
    }), { code: 'PERSISTENCE_INTERRUPTED' });
    assert.equal(calls, 0);
    assert.equal(disk.load().connectionDoctor.shopify?.attempts, undefined);
    t.mock.timers.tick(HOUR);
    const reloaded = disk.load();
    await runDoctor(reloaded, integrations, disk.save);
    assert.equal(calls, 1);
    assert.equal(disk.load().connectionDoctor.shopify.attempts, 1);
  }
});

test('token rotation, products-only success, and token refresh cannot erase a consumed order budget', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  for (const action of ['products', 'refresh']) {
    const state = fixture(action === 'products' ? ['products'] : ['orders']);
    let reads = 0, refreshes = 0;
    const integrations = service(async () => { reads++; return { status: 'connected', lastError: null }; }, action === 'refresh' ? {
      refreshSupported: () => true, connectionAccessExpiry: () => new Date(Date.now() - 1000).toISOString(),
      testConnection: async () => { refreshes++; state.connections[0].encryptedCredentials = 'rotated-token'; return { ok: true }; }
    } : {});
    const existing = budget(state, integrations), binding = structuredClone(existing.orderReadBinding);
    state.connections[0].encryptedCredentials = 'new-ciphertext-same-account';
    state.connections[0].updatedAt = new Date().toISOString();
    state.connectionSettings.shopify.revision++;
    const disk = persisted(state);
    await runDoctor(state, integrations, disk.save);
    assert.equal(reads, action === 'products' ? 1 : 0);
    assert.equal(refreshes, action === 'refresh' ? 1 : 0);
    assert.equal(state.connectionDoctor.shopify, existing);
    assert.equal(existing.attempts, 3);
    assert.equal(existing.exhausted, false);
    assert.deepEqual(existing.orderReadBinding, binding);
    assert.equal(disk.load().connectionDoctor.shopify.attempts, 3);
  }
});

test('same-account products-only queue preserves the budget; an explicit orders queue resets it', () => {
  const state = fixture(['products']), integrations = service();
  const previous = budget(state, integrations, 5);
  queueFirstSync(state, 'shopify', 'owner');
  assert.equal(state.connectionDoctor.shopify, previous);
  assert.equal(state.connectionDoctor.shopify.attempts, 5);
  state.connections[0].encryptedCredentials = 'rotated-token';
  queueFirstSync(state, 'shopify', 'owner');
  assert.equal(state.connectionDoctor.shopify, previous);
  state.connectionSettings.shopify.areas = ['orders'];
  queueFirstSync(state, 'shopify', 'owner');
  assert.deepEqual(state.connectionDoctor.shopify, {});
});

test('only a verified stable source change releases exhaustion; unavailable configuration fails closed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const mutations = {
    account: state => { state.connections[0].metadata.shopId = 'shop-2'; },
    connection: state => { state.connections[0].id = 'connection-2'; },
    domain: state => { state.connections[0].metadata.shopDomain = 'replacement.myshopify.com'; },
    api: (_state, integrations) => { integrations.shopifyConfig = current => ({ connection: current.connections[0], domain: current.connections[0].metadata.shopDomain, apiVersion: '2026-10' }); },
    parser: state => { state.connectionDoctor.shopify.orderReadBinding = { ...state.connectionDoctor.shopify.orderReadBinding, sourcePolicy: 'previous-parser' }; }
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const state = fixture();
    let calls = 0;
    const integrations = service(async () => { calls++; return { status: 'connected', lastError: null }; });
    budget(state, integrations, 5);
    mutate(state, integrations);
    assert.equal(connectionDoctorState(state, 'shopify', integrations).exhausted, false, name);
    assert.equal(connectionDue(state, 'shopify', new Date(), integrations), true, name);
    const disk = persisted(state);
    await runDoctor(state, integrations, disk.save);
    assert.equal(calls, 1, name);
    assert.equal(disk.load().connectionDoctor.shopify.attempts, 1, name);
    assert.deepEqual(disk.load().connectionDoctor.shopify.orderReadBinding, shopifyOrderReadBinding(state, integrations), name);
  }
  const state = fixture(), integrations = service();
  budget(state, integrations, 5);
  const before = structuredClone(state);
  integrations.shopifyConfig = () => { throw new Error('Configuration unavailable'); };
  integrations.syncProvider = async () => assert.fail('Unknown configuration cannot release a retry');
  assert.equal(connectionDoctorState(state, 'shopify', integrations), state.connectionDoctor.shopify);
  for (let check = 0; check < 3; check++) await runDoctor(state, integrations, async () => assert.fail('Unknown configuration cannot save a fresh claim'));
  assert.deepEqual(state, before);
});

test('malformed persisted attempt counts fail closed without another claim, provider call, or save', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  for (const attempts of [undefined, null, -1, 1.5, '3', 6, Number.MAX_SAFE_INTEGER + 1]) {
    const state = fixture(), integrations = service(async () => assert.fail('Malformed budget must not read'));
    budget(state, integrations);
    state.connectionDoctor.shopify.attempts = attempts;
    state.connectionDoctor.shopify.exhausted = false;
    const before = structuredClone(state);
    assert.equal(connectionDue(state, 'shopify', new Date(), integrations), false);
    await runDoctor(state, integrations, async () => assert.fail('Malformed budget must not save'));
    assert.deepEqual(state, before);
  }
});

test('malformed prior source bindings never establish replacement or release consumed attempts', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const corruptions = [
    binding => ({ ...binding, unknown: true }),
    binding => { const changed = { ...binding }; delete changed.accountId; return changed; },
    binding => ({ ...binding, schema: 'invalid' }),
    () => 'bad',
    binding => ({ ...binding, accountId: null }),
    binding => ({ ...binding, domain: 'invalid\nsource' })
  ];
  for (const corrupt of corruptions) {
    const state = fixture(), integrations = service(async () => assert.fail('Malformed binding cannot release exhausted reads'));
    const doctor = budget(state, integrations, 5);
    doctor.orderReadBinding = corrupt(doctor.orderReadBinding);
    const before = structuredClone(state);
    assert.equal(connectionDoctorState(state, 'shopify', integrations), doctor);
    assert.equal(connectionDue(state, 'shopify', new Date(), integrations), false);
    await runDoctor(state, integrations, async () => assert.fail('Malformed binding cannot save a replacement claim'));
    assert.deepEqual(state, before);
  }
});

test('missing or newly enriched account identity cannot prove source replacement or erase products-only reconnect budgets', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  for (const change of ['remove', 'enrich']) {
    const state = fixture(['products']), integrations = service(async () => assert.fail('Identity metadata changes cannot release exhaustion'));
    if (change === 'enrich') delete state.connections[0].metadata.shopId;
    const doctor = budget(state, integrations, 5);
    if (change === 'remove') state.connections[0].metadata = { shopDomain: state.connections[0].metadata.shopDomain };
    else state.connections[0].metadata.shopId = 'shop-1';
    assert.equal(connectionDoctorState(state, 'shopify', integrations), doctor);
    assert.equal(connectionDue(state, 'shopify', new Date(), integrations), false);
    queueFirstSync(state, 'shopify', 'owner');
    assert.equal(state.connectionDoctor.shopify, doctor);
    const before = structuredClone(state);
    await runDoctor(state, integrations, async () => assert.fail('No claim is admitted on identity metadata change'));
    assert.deepEqual(state, before);
  }
});

test('actual admitted orders reset the existing Doctor object in the existing successful save', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  for (const firstSync of [false, true]) {
    const state = fixture();
    if (firstSync) queueFirstSync(state, 'shopify', 'owner');
    let calls = 0;
    const integrations = actualService(state, async () => { calls++; return sourceResponse(); });
    const existing = budget(state, integrations, 4), disk = persisted(state);
    await runDoctor(state, integrations, disk.save);
    assert.equal(calls, 1);
    assert.equal(state.connectionDoctor.shopify, existing);
    assert.equal(existing.attempts, 0);
    assert.equal(existing.exhausted, false);
    assert.equal(existing.orderReadBinding, undefined);
    const durable = disk.load();
    assert.equal(durable.connectionDoctor.shopify.attempts, 0);
    assert.ok(durable.orders.some(order => order.sourceReadRef));
    assert.equal(Object.keys(durable.channelData.shopify.orderReads.manifests).length, 1);
    assert.equal(disk.snapshots.length, firstSync ? 7 : 4);
    const claim = disk.snapshots.find(saved => saved.connectionSyncs[0]?.status === 'running');
    assert.equal(claim.connectionDoctor.shopify.attempts, 5);
    assert.equal(claim.connectionDoctor.shopify.exhausted, true);
  }
});

test('actual admitted manual orders recover after account identity metadata was lost or enriched', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  for (const change of ['remove', 'enrich']) {
    const state = fixture();
    if (change === 'enrich') delete state.connections[0].metadata.shopId;
    let calls = 0;
    const integrations = actualService(state, async () => { calls++; return sourceResponse(); });
    const doctor = budget(state, integrations, 5);
    if (change === 'remove') delete state.connections[0].metadata.shopId;
    else state.connections[0].metadata.shopId = 'shop-1';
    assert.equal(connectionDoctorState(state, 'shopify', integrations), doctor);
    assert.equal(doctor.exhausted, true, 'Metadata changes alone cannot release the budget');
    await integrations.syncShopify(state, { areas: ['orders'] });
    assert.equal(calls, 1);
    assert.equal(state.connectionDoctor.shopify, doctor);
    assert.equal(doctor.attempts, 0);
    assert.equal(doctor.exhausted, false);
    assert.equal(doctor.orderReadBinding, undefined);
    assert.ok(state.orders.some(order => order.sourceReadRef));
  }
});

test('legacy scheduler discovery cannot bypass an exhausted bound budget or save empty claims', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const state = fixture(), integrations = service(async () => assert.fail('Legacy discovery must respect exhaustion'));
  budget(state, integrations, 5);
  delete state.connectionSettings;
  delete state.connectionSyncs;
  state.autopilot.enabled = true;
  for (const key of Object.keys(state.automations)) state.automations[key] = key === 'channelSync';
  const disk = persisted(state);
  const scheduler = createScheduler({ store: { get: async () => disk.load(), save: async () => assert.fail('No empty legacy claims') },
    integrations, withWorkspaceLock: async (_id, action) => action(), currentBrief: () => ({}), enabled: false });
  for (let check = 0; check < 7; check++) {
    t.mock.timers.tick(HOUR);
    assert.equal((await scheduler.runWorkspace(state.workspace.id, { now: new Date() })).skipped, true);
  }
  assert.deepEqual(disk.load().automationRuns, state.automationRuns);
});

for (const limit of [48, 96]) test(`channelSync durable ${limit}-claim UTC cap survives retention and counts unfinished claims`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const state = fixture();
  // Environment-backed scheduler reads have no Doctor connection record.
  state.connections = [];
  state.connectionSettings.shopify.managedReadSchedule = false;
  state.autopilot.enabled = true;
  ensureControl(state);
  assert.equal(state.autopilot.rules.channelSync.maxRunsPerDay, 48);
  assert.throws(() => configureAutopilot(state, { rules: { channelSync: { maxRunsPerDay: 97 } } }, 'owner'), { code: 'VALIDATION_FAILED' });
  if (limit === 96) configureAutopilot(state, { rules: { channelSync: { maxRunsPerDay: 96 } } }, 'owner');
  for (const key of Object.keys(state.automations)) state.automations[key] = key === 'channelSync';
  state.automationRuns = Array.from({ length: limit - 1 }, (_, index) => {
    const startedAt = new Date(NOW - HOUR - (index + 1) * 60000).toISOString();
    const status = index === 1 ? 'IN PROGRESS' : index === 2 ? 'FAILED' : index === 3 ? 'BLOCKED' : 'COMPLETED';
    return { id: `existing-${index}`, ruleId: 'channelSync', status, startedAt,
      ...(status === 'IN PROGRESS' ? {} : { completedAt: startedAt }),
      leaseUntil: new Date(Date.parse(startedAt) + 600000).toISOString(), risk: 'low', spend: 0,
      errorCode: status === 'FAILED' ? 'READ_FAILED' : null,
      evidence: [{ type: 'integration_read', id: 'shopify', detail: 'Recorded provider evidence. '.repeat(80) }] };
  });
  const disk = persisted(state);
  let calls = 0, compactions = 0;
  const integrations = service(async () => {
    calls++;
    const durable = disk.load();
    assert.equal(durable.automationRuns.length, limit);
    assert.equal(durable.automationRuns[0].status, 'IN PROGRESS');
    assert.equal(durable.connectionSyncs[0].status, 'running');
    assert.ok(durable.automationRuns.some(run => isAutomationArchiveStub(run, durable.workspace.id)));
    return { status: 'connected', lastError: null };
  });
  const scheduler = createScheduler({ store: { get: async () => disk.load(), save: async (_id, current) => {
    const plan = planAutomationRetention(current, { now: new Date(), recentCompletedLimit: 0 });
    const result = applyAutomationRetention(plan, { acknowledgedArchives: plan.archiveCandidates.map(candidate => ({ ...candidate.reference, confirmed: true })) });
    compactions += result.compacted;
    current.automationRuns = result.automationRuns;
    await disk.save(current);
  } }, integrations, withWorkspaceLock: async (_id, action) => action(), currentBrief: () => ({}), enabled: false });
  assert.equal((await scheduler.runWorkspace(state.workspace.id, { now: new Date() })).skipped, false);
  assert.equal(calls, 1);
  assert.ok(compactions > 0);
  const durable = disk.load();
  assert.equal(durable.automationRuns.length, limit);
  for (const id of ['existing-1', 'existing-2', 'existing-3']) assert.ok(durable.automationRuns.some(run => run.id === id && !run.archive));
  assert.equal(durable.automationRuns.find(run => run.id === 'existing-1').errorCode, 'WORKER_INTERRUPTED');
  const saves = disk.snapshots.length;
  for (let check = 0; check < 7; check++) {
    t.mock.timers.tick(HOUR);
    assert.equal((await scheduler.runWorkspace(state.workspace.id, { now: new Date() })).skipped, true);
  }
  assert.equal(calls, 1);
  assert.equal(disk.snapshots.length, saves);
  assert.deepEqual(dueRules(disk.load(), new Date(), integrations), []);
  const incorrectlyTrimmed = disk.load();
  incorrectlyTrimmed.automationRuns = incorrectlyTrimmed.automationRuns.filter(run => !run.archive);
  assert.ok(dueRules(incorrectlyTrimmed, new Date(), integrations).some(rule => rule.id === 'channelSync'), 'Discarding current-day stubs would actually reopen provider work');
});
