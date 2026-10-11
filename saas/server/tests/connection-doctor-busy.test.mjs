import test from 'node:test';
import assert from 'node:assert/strict';
import { runConnectionDoctor } from '../lib/connection-doctor.mjs';
import { CONNECTORS, shopifyOrderReadBinding } from '../lib/connection-centre.mjs';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const AT = new Date(NOW).toISOString();
const BEFORE = new Date(NOW - 60000).toISOString();
const LATER = new Date(NOW + 60000).toISOString();
const LAST = new Date(NOW + 120000).toISOString();
const UNCHANGED = { changed: false, externalWrites: false };

function fixture(providers = ['shopify']) {
  return {
    workspace: { id: 'doctor-busy-fixture' },
    connections: providers.map(provider => ({ id: `synthetic-${provider}`, provider: provider === 'ebay' ? 'ebay_oauth' : provider,
      encryptedCredentials: 'synthetic-encrypted-token', status: 'connected', lastCheckedAt: AT,
      metadata: { shopDomain: 'doctor-busy.myshopify.com', shopId: 'synthetic-shop' } })),
    connectionSettings: Object.fromEntries(providers.map(provider => [provider, {
      areas: provider === 'shopify' || provider === 'ebay' ? ['products'] : CONNECTORS[provider].defaults.slice(),
      autoSync: true, managedReadSchedule: false
    }])),
    integrationStatus: Object.fromEntries(providers.map(provider => [provider, {
      status: 'connected', lastSuccessfulSyncAt: BEFORE, lastAttemptAt: BEFORE, areaSuccessAt: { products: BEFORE }
    }])),
    connectionDoctor: Object.fromEntries(providers.map(provider => [provider, {
      issue: null, attempts: 2, exhausted: false, nextRetryAt: null, leaseUntil: null, lastSuccessAt: BEFORE
    }])),
    connectionSyncs: [], connectionFirstSync: {}, audit: [],
    products: [{ id: 'retained-product', provider: 'shopify', variants: [] }],
    orders: [{ id: 'retained-order', provider: 'shopify', total: 19 }],
    channelData: { pinterest: { boards: [{ id: 'retained-board' }] } }
  };
}

function service(extra = {}) {
  return {
    connectionAccessExpiry: () => null, refreshSupported: () => false,
    testConnection: async () => assert.fail('Unexpected token refresh'),
    ...extra
  };
}

async function noWork(state, integrations = service()) {
  const before = structuredClone(state);
  const result = await runConnectionDoctor(state, {
    integrations, now: new Date(NOW),
    readSync: async () => assert.fail('A skipped provider must not be read'),
    save: async () => assert.fail('Unchanged work must not be saved')
  });
  assert.deepEqual(state, before, 'The result must not change retained data, leases, budgets, first syncs, timestamps or audit history');
  return result;
}

function liveSync(provider, leaseUntil = LATER, extra = {}) {
  return { id: 'synthetic-private-run-id', provider, status: 'running', leaseUntil, startedAt: AT, ...extra };
}

function repairDue(state, provider) {
  state.integrationStatus[provider] = { ...state.integrationStatus[provider], status: 'error', lastError: 'UPSTREAM_REQUEST_FAILED', upstreamStatus: 503 };
  state.connectionDoctor[provider].issue = 'provider_unavailable';
}

test('healthy unchanged Doctor keeps its exact compatible result and makes no saves', async () => {
  assert.deepEqual(await noWork(fixture()), UNCHANGED);
  assert.deepEqual(await noWork(fixture([])), UNCHANGED);
});

for (const kind of ['source_hold', 'pending_exhausted', 'orders_exhausted', 'unknown_order_policy', 'recovery_hold', 'ebay_cooldown']) {
  test(`durable ${kind} remains a policy-held no-op even when a live lease is present`, async () => {
    const provider = kind === 'ebay_cooldown' ? 'ebay' : 'shopify';
    const state = fixture([provider]);
    state.connectionSettings[provider].areas = ['orders'];
    state.connectionDoctor[provider].leaseUntil = LAST;
    state.connectionSyncs = [liveSync(provider)];
    const binding = shopifyOrderReadBinding(state);
    if (kind === 'source_hold') state.integrationStatus.shopify.orderReadHold = { code: 'SHOPIFY_ORDER_SOURCE_SHAPE_INVALID', at: BEFORE, binding };
    if (kind === 'pending_exhausted') state.connectionDoctor.shopify.pendingReadAttempts = 5;
    if (kind === 'orders_exhausted') Object.assign(state.connectionDoctor.shopify, { attempts: 5, exhausted: true, orderReadBinding: binding });
    if (kind === 'unknown_order_policy') state.connectionDoctor.shopify.orderReadBinding = { ...binding, sourcePolicy: 'synthetic-unknown-policy' };
    if (kind === 'recovery_hold') state.integrationStatus.shopify.orderRecovery = { schema: 'shopify-order-recovery-marker/v1', stageId: 'synthetic-stage', runId: 'synthetic-run', status: 'pending', attempt: 2 };
    if (kind === 'ebay_cooldown') state.integrationStatus.ebay.retryAt = LATER;
    assert.deepEqual(await noWork(state), UNCHANGED);
  });
}

test('existing retry delays and exhausted budgets remain ordinary no-op results', async () => {
  for (const kind of ['doctor_delay', 'provider_delay', 'exhausted']) {
    const state = fixture(['pinterest']);
    if (kind === 'doctor_delay') state.connectionDoctor.pinterest.nextRetryAt = LATER;
    if (kind === 'provider_delay') state.integrationStatus.pinterest.retryAt = LATER;
    if (kind === 'exhausted') state.connectionDoctor.pinterest.exhausted = true;
    assert.deepEqual(await noWork(state), UNCHANGED);
  }
});

for (const reason of ['doctor_lease', 'sync_lease']) {
  test(`live ${reason} returns explicit bounded busy evidence without touching state`, async () => {
    const state = fixture();
    repairDue(state, 'shopify');
    state.connectionFirstSync.shopify = { status: 'queued', identityVerifiedAt: BEFORE, areas: { products: 'pending' }, failures: {} };
    if (reason === 'doctor_lease') state.connectionDoctor.shopify.leaseUntil = LATER;
    else state.connectionSyncs = [liveSync('shopify')];
    const result = await noWork(state);
    assert.deepEqual(result, { ...UNCHANGED, busy: [{ provider: 'shopify', reason, leaseUntil: LATER }] });
    assert.doesNotMatch(JSON.stringify(result), /synthetic|encrypted|token|run-id/);
  });
}

test('a newly classified issue can change diagnostics while the live lease still reports busy', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const state = fixture();
  repairDue(state, 'shopify');
  state.connectionDoctor.shopify.issue = null;
  state.connectionDoctor.shopify.leaseUntil = LATER;
  const before = structuredClone(state);
  let saves = 0;
  const result = await runConnectionDoctor(state, {
    integrations: service(), now: new Date(NOW), save: async () => { saves++; },
    readSync: async () => assert.fail('A live lease must block reads after classification')
  });
  assert.deepEqual(result, { changed: true, externalWrites: false, busy: [{ provider: 'shopify', reason: 'doctor_lease', leaseUntil: LATER }] });
  assert.equal(saves, 1, 'Only the existing classification save is retained');
  assert.deepEqual(state.audit.map(entry => entry.type).sort(), ['connection_doctor_issue_classified', 'connection_doctor_issue_detected', 'connection_doctor_provider_outage']);
  assert.deepEqual({ ...state, audit: before.audit, connectionDoctor: { shopify: { ...state.connectionDoctor.shopify, issue: null } } }, before);
});

test('busy evidence does not refresh tokens or advance an existing refresh attempt', async () => {
  const state = fixture(['pinterest']);
  state.connectionDoctor.pinterest.leaseUntil = LATER;
  const integrations = service({ connectionAccessExpiry: () => BEFORE, refreshSupported: () => true });
  assert.deepEqual(await noWork(state, integrations), { ...UNCHANGED, busy: [{ provider: 'pinterest', reason: 'doctor_lease', leaseUntil: LATER }] });
});

test('multiple live sync leases collapse to the latest canonical deadline with sync precedence', async () => {
  const state = fixture();
  state.connectionDoctor.shopify.issue = 'interrupted';
  state.connectionDoctor.shopify.leaseUntil = new Date(NOW + 180000).toISOString();
  state.connectionSyncs = [
    liveSync('shopify', LATER), liveSync('shopify', '2026-10-10T14:02:00+02:00'),
    liveSync('shopify', BEFORE), liveSync('shopify', 'invalid-private-deadline'),
    liveSync('shopify', new Date(NOW + 240000).toISOString(), { status: 'completed' }),
    liveSync('pinterest', new Date(NOW + 240000).toISOString())
  ];
  assert.deepEqual(await noWork(state), { ...UNCHANGED, busy: [{ provider: 'shopify', reason: 'sync_lease', leaseUntil: LAST }] });
});

test('busy output is limited to one fixed entry per configured supported provider', async () => {
  const providers = Object.keys(CONNECTORS).filter(provider => CONNECTORS[provider].areas.length);
  const state = fixture(providers);
  state.connectionSyncs = providers.flatMap(provider => Array.from({ length: 40 }, () => liveSync(provider)));
  state.connectionSyncs.push(liveSync('untrusted-provider-name'));
  for (const provider of providers) state.connectionDoctor[provider].leaseUntil = LAST;
  assert.deepEqual(await noWork(state), { ...UNCHANGED, busy: providers.map(provider => ({ provider, reason: 'sync_lease', leaseUntil: LATER })) });
});

test('busy providers do not discard successful work before or after them or emit false repair success', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const state = fixture(['shopify', 'ebay', 'pinterest']);
  for (const provider of ['shopify', 'ebay', 'pinterest']) repairDue(state, provider);
  state.connectionSyncs = [liveSync('ebay')];
  const busyBefore = { doctor: structuredClone(state.connectionDoctor.ebay), status: structuredClone(state.integrationStatus.ebay), sync: structuredClone(state.connectionSyncs[0]) };
  const calls = [], snapshots = [];
  const result = await runConnectionDoctor(state, {
    integrations: service(), now: new Date(NOW), save: async () => snapshots.push(structuredClone(state)),
    readSync: async (current, _integrations, provider, { run }) => {
      calls.push(provider);
      assert.equal(snapshots.at(-1).connectionSyncs.find(item => item.id === run.id).status, 'running', 'The pre-read save remains in place');
      current.integrationStatus[provider] = { ...current.integrationStatus[provider], status: 'connected', lastError: null, upstreamStatus: null };
      run.status = 'completed';
      current.channelData[provider] = { imported: [{ id: `synthetic-${provider}-import` }] };
      return { status: 'connected', lastError: null };
    }
  });
  assert.deepEqual(result, { changed: true, externalWrites: false, busy: [{ provider: 'ebay', reason: 'sync_lease', leaseUntil: LATER }] });
  assert.deepEqual(calls, ['shopify', 'pinterest']);
  assert.equal(snapshots.length, 7, 'Busy metadata must not add persistence calls');
  assert.deepEqual(state.connectionDoctor.ebay, busyBefore.doctor);
  assert.deepEqual(state.integrationStatus.ebay, busyBefore.status);
  assert.deepEqual(state.connectionSyncs.find(run => run.provider === 'ebay'), busyBefore.sync);
  for (const provider of calls) {
    assert.equal(state.connectionDoctor[provider].lastSuccessAt, AT);
    assert.equal(state.connectionDoctor[provider].attempts, 0);
    assert.equal(state.connectionDoctor[provider].leaseUntil, null);
    assert.deepEqual(state.channelData[provider].imported, [{ id: `synthetic-${provider}-import` }]);
  }
  assert.deepEqual(state.audit.filter(entry => entry.type === 'connection_doctor_repair_success').map(entry => entry.detail.provider).sort(), ['pinterest', 'shopify']);
  assert.equal(state.audit.some(entry => entry.detail.provider === 'ebay'), false);
  assert.deepEqual(snapshots.at(-1), state);
});

test('expired or equal lease deadlines preserve the normal recovery path without busy evidence', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  for (const leaseUntil of [BEFORE, AT]) {
    const state = fixture();
    state.connectionDoctor.shopify.leaseUntil = leaseUntil;
    state.connectionSyncs = [liveSync('shopify', leaseUntil)];
    let reads = 0, saves = 0;
    const result = await runConnectionDoctor(state, {
      integrations: service(), now: new Date(NOW), save: async () => { saves++; },
      readSync: async (_current, _integrations, _provider, { run }) => { reads++; run.status = 'completed'; return { status: 'connected', lastError: null }; }
    });
    assert.deepEqual(result, { changed: true, externalWrites: false });
    assert.equal(reads, 1);
    assert.equal(saves, 4);
    assert.equal(state.connectionSyncs.find(run => run.id === 'synthetic-private-run-id').errorCode, 'WORKER_INTERRUPTED');
    assert.equal(state.audit.filter(entry => entry.type === 'connection_doctor_repair_success').length, 1);
  }
});

test('invalid or absent lease deadlines never leak raw values or create false busy results', async () => {
  for (const leaseUntil of [undefined, null, '', 'invalid-private-deadline', '9999999999999999999999999999', '+999999-01-01T00:00:00.000Z']) {
    const state = fixture();
    state.connectionDoctor.shopify.leaseUntil = leaseUntil;
    state.connectionSyncs = [liveSync('shopify', leaseUntil, { leaseUntil })];
    assert.deepEqual(await noWork(state), UNCHANGED);
  }
});
