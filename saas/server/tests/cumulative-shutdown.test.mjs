import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { createScheduler } from '../lib/scheduler.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { connectionSettings, shopifyOrderReadBinding } from '../lib/connection-centre.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { CONTENT_EXECUTION_RECEIPT_CONTRACT, CONTENT_EXECUTION_RECEIPT_ACK_SCHEMA, recordContentReceiptAcknowledgement } from '../lib/content-execution-receipt.mjs';
import { GOVERNED_RECORD_PRODUCER_CONTRACT } from '../lib/governed-record-stage.mjs';
import { recoveryFixture } from './shopify-order-recovery-fixture.mjs';
import { contentJsonbFixture, CONTENT_WORKSPACE, CONTENT_PRODUCT } from './content-jsonb-test-fixture.mjs';

// Synthetic adapters only. These tests establish local lifecycle behavior,
// not database atomicity or a real provider receipt.
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
async function pending(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
}
const noEffects = { providerReads: 0, submissionAttempts: 0, confirmedSubmissions: 0,
  uncertainSubmissions: 0, blockedSubmissions: 0, historicalExposureUnknown: false,
  externalWrites: false, spend: 0, costStatus: 'not_incurred' };

function schedulerFixture(t) {
  const state = seedWorkspaceState({}, { workspaceId: 'shutdown-protection-fixture' });
  const before = new Date(Date.now() - 86400000).toISOString();
  state.connections = [
    { id: 'shopify-fixture', provider: 'shopify', encryptedCredentials: 'synthetic-marker', status: 'connected', lastCheckedAt: before,
      metadata: { shopDomain: 'shutdown.myshopify.com', shopId: 'synthetic-shop' } },
    { id: 'ebay-fixture', provider: 'ebay_oauth', encryptedCredentials: 'synthetic-marker', status: 'connected', lastCheckedAt: before }
  ];
  state.connectionSettings = Object.fromEntries(['shopify', 'ebay'].map(provider => [provider,
    { ...connectionSettings(state, provider), areas: ['orders'], managedReadSchedule: true }]));
  state.integrationStatus = Object.fromEntries(['shopify', 'ebay'].map(provider => [provider,
    { status: 'connected', lastSyncAt: before, lastSuccessfulSyncAt: before, areaSuccessAt: { orders: before } }]));
  state.connectionDoctor = {}; state.connectionSyncs = [];
  state.products = [{ id: 'retained-product', provider: 'shopify', variants: [] }];
  state.orders = [{ id: 'retained-order', provider: 'shopify', total: 19, actualShippingCost: 3 }];
  state.autopilot.enabled = true;
  for (const key of Object.keys(state.automations)) state.automations[key] = ['channelSync', 'marketingCreativeWorker'].includes(key);
  const snapshots = [], calls = [];
  const integrations = { shopifyRefreshAvailable: () => true, shopifyConfigured: () => true, ebayConfigured: () => true,
    connectionAccessExpiry: () => null, refreshSupported: () => false,
    shopifyConfig: () => ({ connection: state.connections[0], domain: 'shutdown.myshopify.com', apiVersion: '2026-07', accessToken: 'synthetic' }),
    syncProvider: async (_state, provider) => { calls.push(provider); assert.fail('Held sources must not be read'); } };
  const entered = deferred(), finish = deferred();
  const scheduler = createScheduler({ enabled: false, env: {}, integrations,
    store: { provider: 'supabase', get: async () => state, save: async (_id, value) => snapshots.push(structuredClone(value)) },
    withWorkspaceLock: async (_id, action) => action(), currentBrief: () => ({}),
    creativeCycle: async () => { entered.resolve(); await finish.promise; return { advanced: 0, effects: noEffects }; } });
  t.after(() => { finish.resolve(); scheduler.stop(); });
  return { state, integrations, scheduler, entered, finish, snapshots, calls };
}

for (const kind of ['source_hold', 'exhausted_budget', 'unknown_policy', 'recovery_hold']) {
  test(`draining an active cycle preserves Shopify ${kind} and eBay admission protection`, { timeout: 5000 }, async t => {
    const f = schedulerFixture(t), { state } = f;
    const binding = shopifyOrderReadBinding(state, f.integrations);
    if (kind === 'source_hold') state.integrationStatus.shopify.orderReadHold = { code: 'SHOPIFY_ORDER_SOURCE_SHAPE_INVALID', at: new Date().toISOString(), binding };
    if (kind === 'exhausted_budget') state.connectionDoctor.shopify = { attempts: 5, exhausted: true, orderReadBinding: binding };
    if (kind === 'unknown_policy') state.connectionDoctor.shopify = { attempts: 1, orderReadBinding: { ...binding, sourcePolicy: 'unknown-policy' } };
    if (kind === 'recovery_hold') state.integrationStatus.shopify.orderRecovery = { schema: 'shopify-order-recovery-marker/v1', stageId: 'synthetic-stage', runId: 'synthetic-run', status: 'pending', attempt: 2 };
    Object.assign(state.integrationStatus.ebay, kind === 'unknown_policy' ? { retryReviewRequired: true } : { retryAt: new Date(Date.now() + 3600000).toISOString() });
    const protectedState = structuredClone({ status: state.integrationStatus, doctor: state.connectionDoctor, orders: state.orders });
    const work = f.scheduler.runWorkspace(state.workspace.id);
    await f.entered.promise;
    const drain = f.scheduler.drain(); await pending(drain);
    assert.equal(f.scheduler.drain(), drain);
    assert.deepEqual(await f.scheduler.runWorkspace(state.workspace.id), { skipped: true, reason: 'SCHEDULER_STOPPED' });
    f.finish.resolve(); await work;
    assert.deepEqual(await drain, { settled: true, errors: 0, lastError: null });
    assert.deepEqual(f.calls, []);
    const saved = f.snapshots.at(-1);
    assert.deepEqual({ status: saved.integrationStatus, doctor: saved.connectionDoctor, orders: saved.orders }, protectedState);
    assert.equal(saved.automationRuns.some(run => run.ruleId === 'channelSync'), false);
    assert.equal(saved.automationRuns.find(run => run.ruleId === 'marketingCreativeWorker').status, 'COMPLETED');
  });
}

for (const provider of ['shopify', 'ebay']) {
  test(`a ${provider} failure arriving during drain retains its new admission hold and old orders`, { timeout: 5000 }, async t => {
    const f = schedulerFixture(t), { state } = f, entered = deferred(), finish = deferred();
    t.after(() => finish.resolve());
    state.autopilot.enabled = false;
    state.connections = state.connections.filter(row => row.provider === (provider === 'ebay' ? 'ebay_oauth' : provider));
    const binding = shopifyOrderReadBinding(state, f.integrations);
    const retryAt = new Date(Date.now() + 7200000).toISOString();
    f.integrations.syncProvider = async () => {
      f.calls.push(provider); entered.resolve(); await finish.promise;
      throw Object.assign(new Error('Synthetic source error'), provider === 'shopify'
        ? { code: 'SHOPIFY_ORDER_SOURCE_SHAPE_INVALID', status: 422, nonRetryable: true, orderReadBinding: binding }
        : { code: 'CONNECTION_RATE_LIMITED', upstreamStatus: 429, retryAt });
    };
    const orders = structuredClone(state.orders), work = f.scheduler.runWorkspace(state.workspace.id);
    await entered.promise;
    const drain = f.scheduler.drain(); await pending(drain);
    finish.resolve(); await work; await drain;
    const saved = f.snapshots.at(-1);
    assert.deepEqual(saved.orders, orders); assert.deepEqual(f.calls, [provider]);
    if (provider === 'shopify') {
      assert.equal(saved.integrationStatus.shopify.orderReadHold.code, 'SHOPIFY_ORDER_SOURCE_SHAPE_INVALID');
      assert.deepEqual(saved.integrationStatus.shopify.orderReadHold.binding, binding);
      assert.equal(saved.connectionDoctor.shopify.attempts, 1);
    } else {
      assert.equal(saved.integrationStatus.ebay.retryAt, retryAt);
      assert.equal(saved.connectionDoctor.ebay.nextRetryAt, retryAt);
    }
  });
}

async function serve(t, { state, store, integrations, env = {} }) {
  const secret = 'synthetic-shutdown-session-secret-over-thirty-two';
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, SHOPIFY_PUBLIC_SYNC_ENABLED: 'false', ...env },
    { store, integrations, schedulerEnabled: false, agentOpsEnabled: false, fetchImpl: async () => assert.fail('Unexpected external transport') });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await server.packsmart.drain(); await new Promise(resolve => server.close(resolve)); });
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email,
    role: 'owner', sessionVersion: state.users[0].sessionVersion || 1 }, env.SESSION_SECRET || secret);
  const csrf = verifySessionToken(token, env.SESSION_SECRET || secret).csrf;
  const request = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: `packsmart_session=${token}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { server, request };
}

test('admitted recovery retains its received page and finalization through HTTP shutdown without changing another tenant', { timeout: 10000 }, async t => {
  const appended = deferred(), append = deferred(), finalizing = deferred(), finalize = deferred();
  t.after(() => { append.resolve(); finalize.resolve(); });
  const f = recoveryFixture({ count: 1, fetchFault: async ({ name }) => {
    if (name === 'runvara_append_order_recovery') { appended.resolve(); await append.promise; }
    if (name === 'runvara_finalize_order_recovery') { finalizing.resolve(); await finalize.promise; }
  } });
  const foreign = seedWorkspaceState({}, { workspaceId: 'unrelated-tenant', email: 'other@example.test' });
  f.fake.states.set(foreign.workspace.id, structuredClone(foreign));
  const { server, request } = await serve(t, f), route = '/api/connections/shopify/order-recovery';
  const preview = await request(route); assert.equal(preview.status, 200);
  const work = request(route + '/start', { selection: preview.body.selection });
  await appended.promise;
  const drain = server.packsmart.drain(); await pending(drain);
  assert.equal((await request(route + '/start', { selection: preview.body.selection })).status, 503);
  append.resolve(); await finalizing.promise; await pending(drain);
  assert.equal(f.controls.providerCalls, 1);
  finalize.resolve(); const result = await work;
  assert.equal(result.status, 200); assert.equal(result.body.status, 'committed');
  assert.equal((await drain).settled, true);
  assert.equal(f.snapshot().orders.length, 1); assert.equal(f.stages.size, 0);
  assert.deepEqual(f.fake.states.get(foreign.workspace.id), foreign);
});

for (const family of ['manual', 'objective-v2']) {
  test(`admitted ${family} content saves its protected completion after drain without replay or cross-tenant changes`, { timeout: 10000 }, async t => {
    const providerEntered = deferred(), providerDone = deferred(), finalEntered = deferred(), finalDone = deferred();
    t.after(() => { providerDone.resolve(); finalDone.resolve(); });
    const f = await contentJsonbFixture({ family, privateOrder: true, seedChange: state => { state.users[0].passwordChangeRequired = false; } });
    const foreign = seedWorkspaceState({}, { workspaceId: 'content-other-tenant', email: 'content-other@example.test' });
    f.database.states.set(foreign.workspace.id, structuredClone(foreign));
    const commits = [];
    const store = { provider: 'supabase', contentExecutionReceiptCapability: CONTENT_EXECUTION_RECEIPT_CONTRACT,
      ...Object.fromEntries(['get', 'getIdentity', 'getConnectionWriteContext', 'getAgentJob'].map(key => [key, f.store[key].bind(f.store)])),
      save: async (workspaceId, state, options) => {
        const descriptor = options?.protectedContentCommit, previous = state._revision;
        const ordinary = options ? { ...options } : undefined;
        if (ordinary) delete ordinary.protectedContentCommit;
        if (descriptor) commits.push(descriptor);
        if (descriptor?.kind === 'finalize') { finalEntered.resolve(); await finalDone.promise; }
        const saved = await f.store.save(workspaceId, state, ordinary);
        if (descriptor) {
          const a = descriptor.admission;
          recordContentReceiptAcknowledgement(saved, descriptor, { schema: CONTENT_EXECUTION_RECEIPT_ACK_SCHEMA,
            kind: descriptor.kind, workspaceId, attemptId: a.attemptId, admissionDigest: a.digest, intentDigest: a.intentDigest,
            requestFingerprint: crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex'),
            expectedRevision: previous, nextRevision: saved._revision, receiptDigest: descriptor.kind === 'finalize' ? descriptor.receipt.digest : null,
            reservedBytes: 40960, replayed: false });
        }
        return saved;
      } };
    f.hooks.fetch = async () => { providerEntered.resolve(); await providerDone.promise; };
    const { server, request } = await serve(t, { state: f.state, store, integrations: f.service, env: { GOVERNED_RECORD_PRODUCER_CONTRACT } });
    const route = `/api/connection-writes/${f.write.id}/execute`, work = request(route, {});
    await providerEntered.promise;
    const drain = server.packsmart.drain(); await pending(drain);
    assert.equal((await request(route, {})).status, 503);
    providerDone.resolve(); await finalEntered.promise; await pending(drain);
    assert.equal(f.database.states.get(CONTENT_WORKSPACE).connectionWrites[0].status, 'executing');
    assert.deepEqual(commits.map(row => row.kind), ['reserve', 'finalize']);
    assert.equal(commits[1].receipt.source.context.resultId, CONTENT_PRODUCT);
    assert.equal(commits[1].receipt.source.context.origin, family === 'objective-v2' ? 'owner_objective_content' : 'owner_manual');
    finalDone.resolve(); const result = await work;
    assert.equal(result.status, 200); assert.equal(result.body.write.status, 'completed');
    assert.equal((await drain).settled, true); assert.equal(f.counts.mutations, 1);
    assert.equal(f.requests[0].body, f.expected.request.body);
    assert.equal(f.database.states.get(CONTENT_WORKSPACE).connectionWrites[0].status, 'completed');
    assert.deepEqual(f.database.states.get(foreign.workspace.id), foreign);
    assert.doesNotMatch(JSON.stringify(result.body), /receiptDigest|admissionDigest|synthetic-marker|protectedContentCommit/);
  });
}
