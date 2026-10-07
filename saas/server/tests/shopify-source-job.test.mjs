import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentOperations, ensureAgentOps } from '../lib/agent-ops.mjs';
import { connectionSettings, shopifyOrderReadBinding, shopifyOrderReadHold } from '../lib/connection-centre.mjs';
import { runConnectionDoctor } from '../lib/connection-doctor.mjs';
import { createScheduler, monitoredSync } from '../lib/scheduler.mjs';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

const WORKSPACE = 'shopify-source-job-fixture';
const SUCCESS_AT = '2026-09-20T10:00:00.000Z';
const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const SOURCE_CODES = ['SHOPIFY_ORDER_SOURCE_SHAPE_INVALID', 'SHOPIFY_ORDER_SOURCE_SIZE_LIMIT'];
const TOKEN = 'private-shopify-token-fixture';
const CIPHERTEXT = 'synthetic-encrypted-connection-fixture';
const ENV = { SUPABASE_URL: 'https://source-job.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-role-key' };
const MIRRORS = ['workspaces', 'users', 'connections', 'products', 'variants', 'economics', 'product_cost_profiles',
  'suppliers', 'automation_rules', 'audit_events', 'subscriptions', 'orders', 'order_financials'];

function sourceError(code = SOURCE_CODES[0]) {
  // The structural code must win over all misleading transient hints.
  return Object.assign(new TypeError(`Untrusted source message: ${TOKEN}`), {
    code, status: 422, nonRetryable: false, upstreamStatus: 503, retryAfterMs: 60000
  });
}

function representativeState() {
  const state = seedWorkspaceState({}, { workspaceId: WORKSPACE, userId: 'source-owner',
    email: 'source-owner@example.test', passwordHash: 'synthetic-password-hash' });
  state.products = [{ id: 'product-1', externalId: 'product-1', provider: 'shopify', title: 'Retained carton',
    handle: 'retained-carton', status: 'active', inventory: 12, updatedAt: SUCCESS_AT,
    variants: [{ id: 'variant-1', externalId: 'variant-1', sku: 'CARTON-1', title: 'Single', price: 19, inventory: 12, available: true }] }];
  state.economics = { 'CARTON-1': { landed: 4, packing: 0.5, delivery: 3, channelFee: 0.6, marginFloor: 20, updatedAt: SUCCESS_AT } };
  state.orders = [{ id: 'order-1', externalId: 'order-1', provider: 'shopify', name: '#1001', total: 19,
    currency: 'GBP', financialStatus: 'PAID', fulfillmentStatus: 'FULFILLED', createdAt: SUCCESS_AT,
    updatedAt: SUCCESS_AT, actualShippingCost: 3.25, actualShippingCostSource: 'owner',
    lineItems: [{ id: 'line-1', sku: 'CARTON-1', quantity: 1, price: 19 }] }];
  state.suppliers = [{ id: 'supplier-1', name: 'Fixture packaging', active: true, notes: 'Retained supplier',
    createdAt: SUCCESS_AT, updatedAt: SUCCESS_AT }];
  state.audit = [{ id: 'audit-fixture', type: 'fixture_seeded', actor: 'source-owner',
    detail: { retained: true }, createdAt: SUCCESS_AT }];
  state.connections = [{ id: 'connection-1', provider: 'shopify', label: 'Fixture Shopify', status: 'connected',
    encryptedCredentials: CIPHERTEXT, capabilities: ['products', 'orders'],
    metadata: { shopDomain: 'source-job.myshopify.com', shopId: 'shop-1' },
    createdAt: SUCCESS_AT, updatedAt: SUCCESS_AT }];
  state.connectionSettings = { shopify: { ...connectionSettings(state, 'shopify'), areas: ['orders'], managedReadSchedule: true } };
  state.integrationStatus.shopify = { status: 'connected', lastSyncAt: SUCCESS_AT, lastSuccessfulSyncAt: SUCCESS_AT,
    areaSuccessAt: { products: SUCCESS_AT, orders: SUCCESS_AT } };
  ensureAgentOps(state);
  return state;
}

// Extend only the two job request families absent from the shared fake. Every
// store read, primary CAS, report RPC and normal mirror still uses the real store
// and shared fake, with the exact outbound request body recorded in fake.calls.
function jobDatabase() {
  const control = { storageFault: null, finishFault: null, beforeFinish: null };
  const fake = fakeSupabase({ fault: request => control.storageFault?.(request) });
  const jobs = new Map(), claims = new Map(), finishes = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input), table = url.pathname.split('/').pop(), method = options.method || 'GET';
    if (table !== 'runvara_claim_agent_jobs' && !(table === 'runvara_agent_jobs' && method === 'PATCH')) {
      return fake.fetchImpl(input, options);
    }
    fake.calls.push({ url, method, headers: options.headers, body: options.body || '' });
    const body = JSON.parse(options.body);
    if (table === 'runvara_claim_agent_jobs') {
      assert.equal(method, 'POST');
      assert.equal(body.p_lease_seconds, 300);
      assert.equal(body.p_limit, 8);
      const claimed = [], workspaces = new Set();
      for (const row of jobs.values()) {
        if (row.status !== 'queued' || workspaces.has(row.workspace_id) || claimed.length >= body.p_limit) continue;
        workspaces.add(row.workspace_id);
        Object.assign(row, { status: 'running', attempts: row.attempts + 1, worker_id: body.p_worker_id,
          lease_until: new Date(Date.now() + body.p_lease_seconds * 1000).toISOString() });
        if (Object.hasOwn(control, 'claimLease')) row.lease_until = control.claimLease;
        const snapshot = structuredClone(row);
        claims.set(row.id, snapshot);
        claimed.push(snapshot);
      }
      return Response.json(claimed);
    }
    const id = url.searchParams.get('id')?.slice(3), row = jobs.get(id), claim = claims.get(id);
    finishes.push({ url, body, claim: structuredClone(claim) });
    control.beforeFinish?.(row);
    if (control.finishFault) return Response.json(control.finishFault, { status: control.finishFault.status });
    const matches = row && ['workspace_id', 'id', 'status', 'worker_id', 'attempts']
      .every(key => url.searchParams.get(key) === `eq.${row[key]}`)
      && url.searchParams.getAll('lease_until').includes(`eq.${row.lease_until}`)
      && url.searchParams.getAll('lease_until').includes('gt.now') && Date.parse(row.lease_until) > Date.now();
    if (!matches) return Response.json([]);
    Object.assign(row, body);
    return Response.json([row]);
  };
  return { ...fake, control, jobs, claims, finishes, fetchImpl };
}

async function fixture(t, { cold = false, held = false, sync, prepareState } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const database = jobDatabase();
  let providerCalls = 0, saves = 0;
  const integrations = {
    env: { SHOPIFY_ADMIN_API_VERSION: '2026-07' },
    shopifyConnection: state => state.connections.find(connection => connection.provider === 'shopify'),
    shopifyConfig: state => ({ domain: state.connections[0].metadata.shopDomain, apiVersion: '2026-07',
      connection: state.connections[0], accessToken: TOKEN, clientSecret: 'private-client-secret-fixture' }),
    syncProvider: async (state, provider, options) => {
      providerCalls++;
      assert.equal(provider, 'shopify');
      assert.deepEqual(options, { automatic: true, areas: ['orders'] });
      if (sync) return sync(state, database);
      throw sourceError();
    }
  };
  const state = representativeState();
  prepareState?.(state);
  if (held) Object.assign(state.integrationStatus.shopify, { status: 'error', lastError: SOURCE_CODES[0],
    orderReadHold: { code: SOURCE_CODES[0], at: SUCCESS_AT, binding: shopifyOrderReadBinding(state, integrations) } });
  let store = createStore(ENV, { fetchImpl: database.fetchImpl });
  await store.save(WORKSPACE, state);
  const seeded = structuredClone(database.states.get(WORKSPACE));
  if (cold) store = createStore(ENV, { fetchImpl: database.fetchImpl });
  const originalSave = store.save.bind(store);
  t.mock.method(store, 'save', async (...args) => { saves++; return originalSave(...args); });
  const operations = createAgentOperations({ store, integrations, withWorkspaceLock: async (_workspaceId, action) => action(), enabled: false });
  t.after(() => operations.stop());
  // A real later save changes the workspace timestamp, so include that normal
  // mirror in warm costs as well as the source failure's changed connection.
  t.mock.timers.tick(1000);
  database.calls.length = 0;
  function queue(id = 'job_source_fixture') {
    const row = { id, workspace_id: WORKSPACE, type: 'connection_sync', provider: 'shopify', payload: { areas: ['orders'] },
      status: 'queued', priority: 80, attempts: 0, max_attempts: 5, ai_units: 0, concurrency_limit: 2,
      idempotency_key: id, actor: 'source-owner', ai_provider: null, ai_model: null, ai_tier: 'deterministic',
      available_at: SUCCESS_AT, created_at: SUCCESS_AT, updated_at: SUCCESS_AT, result: null };
    database.jobs.set(id, row);
    return row;
  }
  return { database, store, integrations, operations, seeded, queue,
    get providerCalls() { return providerCalls; }, get saves() { return saves; } };
}

function assertFinishFence(database) {
  assert.ok(database.finishes.length > 0);
  for (const { url, claim } of database.finishes) {
    assert.equal(url.searchParams.get('workspace_id'), `eq.${claim.workspace_id}`);
    assert.equal(url.searchParams.get('id'), `eq.${claim.id}`);
    assert.equal(url.searchParams.get('status'), 'eq.running');
    assert.equal(url.searchParams.get('worker_id'), `eq.${claim.worker_id}`);
    assert.equal(url.searchParams.get('attempts'), `eq.${claim.attempts}`);
    assert.deepEqual(url.searchParams.getAll('lease_until'), [`eq.${claim.lease_until}`, 'gt.now']);
    assert.equal(url.searchParams.get('select').includes('result'), false, 'completion returns the existing compact job projection');
  }
}

function requestMetrics(calls) {
  const groups = Object.fromEntries(['primaryRead', 'primary', 'report', 'mirror', 'job'].map(key => [key, { requests: 0, bodyBytes: 0 }]));
  const families = {};
  for (const call of calls) {
    const table = call.url.pathname.split('/').pop(), bytes = Buffer.byteLength(call.body);
    const group = table === 'saas_workspace_state' ? call.method === 'GET' ? 'primaryRead' : 'primary'
      : table === 'runvara_commit_reporting_status' ? 'report'
        : ['runvara_claim_agent_jobs', 'runvara_agent_jobs'].includes(table) ? 'job' : 'mirror';
    if (group === 'mirror') assert.ok(MIRRORS.includes(table), `unexpected request family ${table}`);
    groups[group].requests++; groups[group].bodyBytes += bytes;
    const family = `${call.method} ${table}`;
    families[family] ||= { requests: 0, bodyBytes: 0 };
    families[family].requests++; families[family].bodyBytes += bytes;
  }
  return { requests: calls.length, bodyBytes: calls.reduce((total, call) => total + Buffer.byteLength(call.body), 0), groups, families };
}

function assertRetained(before, after) {
  for (const key of ['products', 'orders', 'economics', 'suppliers']) assert.deepEqual(after[key], before[key], `${key} evidence is retained`);
  assert.equal(after.integrationStatus.shopify.lastSyncAt, SUCCESS_AT);
  assert.equal(after.integrationStatus.shopify.lastSuccessfulSyncAt, SUCCESS_AT);
  assert.deepEqual(after.integrationStatus.shopify.areaSuccessAt, before.integrationStatus.shopify.areaSuccessAt);
  assert.ok(after.audit.some(event => event.id === 'audit-fixture'));
}

test('successful queued Shopify order read retains its existing one-save path', async t => {
  const f = await fixture(t, { sync: async () => ({ status: 'connected', lastError: null, orderReadHold: null }) });
  const job = f.queue();
  await f.operations.tick();
  assert.equal(f.providerCalls, 1);
  assert.equal(f.saves, 1);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.result.externalWrites, false);
  assert.equal(f.operations.status.processed, 1);
  assert.equal(f.operations.status.deadLettered, 0);
  const persisted = f.database.states.get(WORKSPACE);
  assert.equal(persisted.integrationStatus.shopify.orderReadHold, null);
  assert.notEqual(persisted.integrationStatus.shopify.areaSuccessAt.orders, SUCCESS_AT);
  assert.equal(requestMetrics(f.database.calls).groups.primary.requests, 1);
  assert.equal(requestMetrics(f.database.calls).groups.report.requests, 1);
  assertFinishFence(f.database);
});

for (const cold of [false, true]) for (const code of SOURCE_CODES) {
  test(`${cold ? 'cold' : 'warm'} queued ${code} persists one bound hold and measures all Supabase requests`, async t => {
    const f = await fixture(t, { cold, sync: async () => { throw sourceError(code); } });
    const job = f.queue();
    await f.operations.tick();
    assert.equal(f.providerCalls, 1, 'structural failures cannot become TypeError or HTTP 5xx retries');
    assert.equal(f.saves, 1, 'only one failure save is added');
    assert.equal(job.status, 'dead_letter');
    assert.equal(job.attempts, 1);
    assert.equal(job.error_code, code);
    assert.deepEqual(job.result.orderReadHold, { status: 'persisted', durable: true });
    assert.equal(f.operations.status.failed, 1);
    assert.equal(f.operations.status.deadLettered, 1);
    const persisted = f.database.states.get(WORKSPACE), hold = shopifyOrderReadHold(persisted, 'shopify', f.integrations);
    assertRetained(f.seeded, persisted);
    assert.equal(hold.code, code);
    assert.deepEqual(hold.binding, shopifyOrderReadBinding(f.seeded, f.integrations));
    assert.deepEqual(Object.keys(hold).sort(), ['at', 'binding', 'code']);
    assert.equal(persisted.integrationStatus.shopify.transient, false);
    assert.equal(persisted.integrationStatus.shopify.retryAt, null);
    assert.equal(persisted.connectionSyncs[0].status, 'failed');
    assert.doesNotMatch(JSON.stringify(hold), /token|secret|encryptedCredentials|private-|synthetic-encrypted/i);
    assert.doesNotMatch(JSON.stringify(persisted), /private-shopify-token|private-client-secret|Untrusted source/);
    assert.doesNotMatch(JSON.stringify(job.result), /private-|synthetic-encrypted/);
    assertFinishFence(f.database);
    const metrics = requestMetrics(f.database.calls);
    assert.equal(metrics.groups.primaryRead.requests, 1);
    assert.equal(metrics.groups.primary.requests, 1);
    assert.equal(metrics.groups.report.requests, 1);
    assert.equal(metrics.groups.job.requests, 2);
    const mirrorTables = f.database.calls.filter(call => call.method === 'POST' && MIRRORS.includes(call.url.pathname.split('/').pop()))
      .map(call => call.url.pathname.split('/').pop());
    assert.deepEqual(mirrorTables, cold ? MIRRORS : ['workspaces', 'connections', 'audit_events']);
    assert.equal(metrics.groups.mirror.requests, cold ? 14 : 4, 'normal mirrors include one variant identity GET');
    assert.equal(metrics.requests, cold ? 19 : 9);
    assert.equal(metrics.bodyBytes, Object.values(metrics.groups).reduce((sum, group) => sum + group.bodyBytes, 0));
    t.diagnostic(JSON.stringify({ fixture: 'one product/variant/economics/order/supplier, retained audit, normal default mirrors',
      scope: 'one worker tick; seeded workspace and queued job already exist', cache: cold ? 'cold' : 'warm', code, ...metrics }));
  });
}

test('repeated queued jobs against the identical persisted hold call no provider and save no workspace', async t => {
  const f = await fixture(t, { held: true });
  const before = structuredClone(f.database.states.get(WORKSPACE));
  for (let index = 0; index < 3; index++) {
    const job = f.queue(`job_source_repeat_${index}`);
    await f.operations.tick();
    assert.equal(job.status, 'dead_letter');
    assert.deepEqual(job.result.orderReadHold, { status: 'already_held', durable: true });
  }
  assert.equal(f.providerCalls, 0);
  assert.equal(f.saves, 0);
  assert.deepEqual(f.database.states.get(WORKSPACE), before);
  assertFinishFence(f.database);
  const metrics = requestMetrics(f.database.calls);
  assert.equal(metrics.requests, 9);
  assert.equal(metrics.groups.primaryRead.requests, 3);
  assert.equal(metrics.groups.job.requests, 6);
  for (const group of ['primary', 'report', 'mirror']) assert.equal(metrics.groups[group].requests, 0);
  t.diagnostic(JSON.stringify({ scope: 'three already-held job ticks', ...metrics }));
});

test('a worker-persisted hold survives reload and stops scheduler and Doctor without automatic writes', async t => {
  const f = await fixture(t, { prepareState: state => {
    state.autopilot.enabled = true;
    for (const key of Object.keys(state.automations)) state.automations[key] = key === 'channelSync';
  } });
  const job = f.queue();
  await f.operations.tick();
  assert.equal(job.result.orderReadHold.durable, true);
  const saved = structuredClone(f.database.states.get(WORKSPACE)), before = f.database.calls.length;
  const scheduler = createScheduler({ store: f.store, integrations: f.integrations,
    withWorkspaceLock: async (_workspaceId, action) => action(), currentBrief: () => ({}), enabled: false });
  for (let index = 0; index < 3; index++) {
    const state = await f.store.get(WORKSPACE);
    const now = new Date(Date.now() + (index + 1) * 3600000);
    const doctor = await runConnectionDoctor(state, { integrations: f.integrations, readSync: monitoredSync,
      save: () => f.store.save(WORKSPACE, state), now });
    assert.equal(doctor.changed, false);
    assert.equal((await scheduler.runWorkspace(WORKSPACE, { now })).skipped, true);
  }
  assert.equal(f.providerCalls, 1);
  assert.equal(f.saves, 1);
  assert.ok(f.database.calls.slice(before).every(call => call.method === 'GET'));
  assert.deepEqual(f.database.states.get(WORKSPACE), saved);
});

test('queued Auto-Doctor no-op jobs close without another workspace save for held orders', async t => {
  const f = await fixture(t, { held: true });
  const before = structuredClone(f.database.states.get(WORKSPACE));
  for (let index = 0; index < 3; index++) {
    const job = f.queue(`job_doctor_held_${index}`);
    Object.assign(job, { type: 'connection_doctor', provider: null, payload: {} });
    await f.operations.tick();
    assert.equal(job.status, 'succeeded');
    assert.deepEqual(job.result, { changed: false, externalWrites: false });
  }
  assert.equal(f.providerCalls, 0);
  assert.equal(f.saves, 0);
  assert.deepEqual(f.database.states.get(WORKSPACE), before);
  const metrics = requestMetrics(f.database.calls);
  assert.equal(metrics.requests, 9);
  for (const group of ['primary', 'report', 'mirror']) assert.equal(metrics.groups[group].requests, 0);
  assertFinishFence(f.database);
});

test('queued Auto-Doctor checks of an exhausted durable order budget also add no workspace save', async t => {
  const f = await fixture(t, { prepareState: state => {
    state.connectionDoctor = { shopify: { attempts: 5, exhausted: true, orderReadBinding: shopifyOrderReadBinding(state) } };
  } });
  const before = structuredClone(f.database.states.get(WORKSPACE));
  for (let index = 0; index < 3; index++) {
    const job = f.queue(`job_doctor_budget_${index}`);
    Object.assign(job, { type: 'connection_doctor', provider: null, payload: {} });
    await f.operations.tick();
    assert.equal(job.status, 'succeeded');
    assert.deepEqual(job.result, { changed: false, externalWrites: false });
  }
  assert.equal(f.providerCalls, 0);
  assert.equal(f.saves, 0);
  assert.deepEqual(f.database.states.get(WORKSPACE), before);
  const metrics = requestMetrics(f.database.calls);
  assert.equal(metrics.requests, 9);
  for (const group of ['primary', 'report', 'mirror']) assert.equal(metrics.groups[group].requests, 0);
  assertFinishFence(f.database);
});

for (const cold of [false, true]) {
  test(`${cold ? 'cold' : 'warm'} source failure accounts for 500 retained orders and 2,000 lines`, async t => {
    const f = await fixture(t, { cold, prepareState: state => {
      const template = state.orders[0];
      state.orders = Array.from({ length: 500 }, (_, index) => ({ ...structuredClone(template),
        id: `order-${index + 1}`, externalId: `order-${index + 1}`, name: `#${1001 + index}`,
        lineItems: Array.from({ length: 4 }, (_, line) => ({ ...template.lineItems[0], id: `line-${index + 1}-${line + 1}` })) }));
    } });
    const job = f.queue();
    await f.operations.tick();
    assert.equal(f.providerCalls, 1);
    assert.equal(f.saves, 1);
    assert.equal(job.status, 'dead_letter');
    assert.equal(job.result.orderReadHold.durable, true);
    assertRetained(f.seeded, f.database.states.get(WORKSPACE));
    const metrics = requestMetrics(f.database.calls);
    assert.equal(metrics.groups.primaryRead.requests, 1);
    assert.equal(metrics.groups.primary.requests, 1);
    assert.equal(metrics.groups.report.requests, 1);
    assert.equal(metrics.groups.job.requests, 2);
    if (cold) {
      assert.ok(metrics.families['POST orders'].requests > 0);
      assert.ok(metrics.families['POST order_financials'].requests > 0);
    } else {
      assert.equal(metrics.families['POST orders'], undefined);
      assert.equal(metrics.families['POST order_financials'], undefined);
    }
    assertFinishFence(f.database);
    t.diagnostic(JSON.stringify({ fixture: '500 retained orders, 2,000 lines; one product/variant/economics/supplier; normal populated mirrors',
      scope: 'one worker tick; seeded workspace and queued job already exist', cache: cold ? 'cold' : 'warm', code: SOURCE_CODES[0], ...metrics }));
  });
}

for (const mode of ['persistence_error', 'cas_conflict']) {
  test(`${mode} preserves newer authoritative state and dead-letters without retrying the provider`, async t => {
    const f = await fixture(t);
    let newer;
    f.database.control.storageFault = ({ table, method, states }) => {
      if (table !== 'saas_workspace_state' || method !== 'PATCH') return null;
      newer = structuredClone(states.get(WORKSPACE));
      newer._revision = 'newer-concurrent-revision';
      newer.settings.ownerEdit = 'keep this newer owner change';
      newer.orders[0].actualShippingCost = 5.75;
      states.set(WORKSPACE, structuredClone(newer));
      return mode === 'persistence_error' ? { status: 503, code: 'XX000', message: 'private persistence diagnostic' } : null;
    };
    const job = f.queue();
    await f.operations.tick();
    assert.equal(f.providerCalls, 1);
    assert.equal(f.saves, 1);
    assert.equal(job.status, 'dead_letter');
    assert.equal(job.error_code, SOURCE_CODES[0]);
    assert.equal(job.result.orderReadHold.status, 'not_confirmed');
    assert.equal(job.result.orderReadHold.durable, false);
    assert.equal(job.result.orderReadHold.persistenceErrorCode, mode === 'persistence_error' ? 'SUPABASE_PERSISTENCE_FAILED' : 'STATE_CONFLICT');
    assert.match(job.result.orderReadHold.limitation, /could not be confirmed saved/);
    assert.match(job.result.orderReadHold.limitation, /other workers are not confirmed paused/);
    assert.doesNotMatch(JSON.stringify(job.result), /private persistence diagnostic|private-shopify-token/);
    assert.equal(f.operations.status.lastError, 'SHOPIFY_ORDER_HOLD_PERSISTENCE_UNCONFIRMED');
    assert.deepEqual(f.database.states.get(WORKSPACE), newer);
    assert.equal(shopifyOrderReadHold(newer, 'shopify', f.integrations), null);
    const metrics = requestMetrics(f.database.calls);
    assert.equal(metrics.groups.primary.requests, 1);
    assert.equal(metrics.groups.report.requests, 0);
    assert.equal(metrics.groups.mirror.requests, 0);
    assert.equal(metrics.groups.job.requests, 2);
    assertFinishFence(f.database);

    // The failed in-memory hold is not authority for a different queued job.
    // It must load the newer saved snapshot and may establish a fresh hold.
    const beforeSecond = f.database.calls.length;
    f.database.control.storageFault = null;
    const nextJob = f.queue('job_source_after_failed_save');
    await f.operations.tick();
    assert.equal(f.providerCalls, 2, 'one provider read per distinct job; no internal provider retry');
    assert.equal(f.saves, 2);
    assert.equal(nextJob.status, 'dead_letter');
    assert.deepEqual(nextJob.result.orderReadHold, { status: 'persisted', durable: true });
    const confirmed = f.database.states.get(WORKSPACE);
    assert.equal(confirmed.settings.ownerEdit, newer.settings.ownerEdit);
    assert.equal(confirmed.orders[0].actualShippingCost, 5.75);
    assert.ok(shopifyOrderReadHold(confirmed, 'shopify', f.integrations));
    assert.equal(requestMetrics(f.database.calls.slice(beforeSecond)).groups.primaryRead.requests, 1);
    assertFinishFence(f.database);
  });
}

for (const mode of ['lease_replaced', 'lease_expired', 'finish_error']) {
  test(`${mode} refuses job closure without counting an unconfirmed dead letter or retrying`, async t => {
    const f = await fixture(t);
    if (mode === 'lease_replaced') f.database.control.beforeFinish = row => {
      row.worker_id = 'newer-worker'; row.attempts++; row.lease_until = new Date(Date.now() + 600000).toISOString();
    };
    if (mode === 'lease_expired') f.database.control.beforeFinish = () => { t.mock.timers.tick(301000); };
    if (mode === 'finish_error') f.database.control.finishFault = { status: 503, code: 'XX000' };
    const job = f.queue();
    await f.operations.tick();
    assert.equal(f.providerCalls, 1);
    assert.equal(f.saves, 1);
    assert.equal(job.status, 'running');
    assert.equal(job.result, null);
    assert.equal(f.operations.status.deadLettered, 0);
    assert.equal(f.operations.status.failed, 0);
    assert.equal(f.operations.status.lastError, 'SHOPIFY_ORDER_HOLD_JOB_CLOSURE_UNCONFIRMED');
    assert.equal(f.database.finishes.length, 1);
    assert.equal(f.database.finishes[0].body.result.orderReadHold.durable, true);
    assertFinishFence(f.database);
  });
}

test('a lease expiring during the provider read prevents a failure save and cannot confirm closure', async t => {
  const f = await fixture(t, { sync: async () => { t.mock.timers.tick(301000); throw sourceError(); } });
  const before = structuredClone(f.database.states.get(WORKSPACE)), job = f.queue();
  await f.operations.tick();
  assert.equal(f.providerCalls, 1);
  assert.equal(f.saves, 0);
  assert.deepEqual(f.database.states.get(WORKSPACE), before);
  assert.equal(job.status, 'running');
  assert.equal(f.operations.status.deadLettered, 0);
  assert.equal(f.operations.status.failed, 0);
  assert.deepEqual(f.database.finishes[0].body.result.orderReadHold.status, 'not_confirmed');
  assert.equal(f.database.finishes[0].body.result.orderReadHold.durable, false);
  assert.equal(f.database.finishes[0].body.result.orderReadHold.persistenceErrorCode, 'AGENT_JOB_LEASE_EXPIRED');
  assertFinishFence(f.database);
});

for (const lease of ['invalid-date', undefined]) {
  test(`${lease === undefined ? 'absent' : 'malformed'} lease cannot load state, read the provider or count a job closure`, async t => {
    const f = await fixture(t);
    f.database.control.claimLease = lease;
    const before = structuredClone(f.database.states.get(WORKSPACE)), job = f.queue();
    await f.operations.tick();
    assert.equal(f.providerCalls, 0);
    assert.equal(f.saves, 0);
    assert.deepEqual(f.database.states.get(WORKSPACE), before);
    assert.equal(job.status, 'running');
    assert.equal(f.database.finishes.length, 0, 'admission rejects malformed claim before issuing a PATCH');
    assert.equal(f.operations.status.deadLettered, 0);
    assert.equal(f.operations.status.failed, 0);
    assert.equal(f.operations.status.lastError, 'AGENT_JOB_CLAIM_INVALID');
    assert.equal(requestMetrics(f.database.calls).requests, 1);
    assert.equal(requestMetrics(f.database.calls).groups.primaryRead.requests, 0);
  });
}

test('connection identity changing during a failed read installs no hold against the replacement', async t => {
  const f = await fixture(t, { sync: async state => {
    state.connections[0].id = 'replacement-connection';
    state.connections[0].metadata.shopId = 'replacement-shop';
    throw sourceError();
  } });
  const before = structuredClone(f.database.states.get(WORKSPACE)), job = f.queue();
  await f.operations.tick();
  assert.equal(f.providerCalls, 1);
  assert.equal(f.saves, 0);
  assert.equal(job.status, 'dead_letter');
  assert.deepEqual(job.result.orderReadHold, { status: 'configuration_changed', durable: false });
  assert.deepEqual(f.database.states.get(WORKSPACE), before);
  assertFinishFence(f.database);
});
