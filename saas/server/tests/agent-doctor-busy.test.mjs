import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createAgentOperations } from '../lib/agent-ops.mjs';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { connectionSettings } from '../lib/connection-centre.mjs';
import { queueFirstSync } from '../lib/connection-doctor.mjs';
import { IntegrationService } from '../lib/integrations.mjs';
import { encryptCredentials, decryptCredentials } from '../lib/security.mjs';

const START = Date.parse('2026-10-10T12:00:00.000Z');
function fixture(t, { first = false, refresh = false, busy = false, healthy = false, commitBeforeLostAck = false } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  t.mock.method(globalThis, 'fetch', () => assert.fail('No real network permitted'));
  const provider = refresh ? 'pinterest' : 'shopify';
  let saved = seedWorkspaceState({}, { workspaceId: 'busy-fixture', email: 'owner@example.test', passwordHash: 'fixture' });
  const settings = connectionSettings(saved, provider);
  saved.connectionSettings = { [provider]: { ...settings, autoSync: true, areas: refresh ? ['boards'] : ['products'] } };
  saved.connections = [{ id: 'fixture-connection', provider, encryptedCredentials: 'synthetic-unused', status: 'connected',
    lastCheckedAt: new Date().toISOString(), metadata: { account: 'Synthetic account', accountId: 'Synthetic account' } }];
  saved.integrationStatus = { [provider]: healthy || refresh ? { status: 'connected' } : { status: 'error', lastError: 'UPSTREAM_REQUEST_FAILED', upstreamStatus: 503 } };
  if (first) queueFirstSync(saved, provider, 'owner');
  if (busy) {
    saved.connectionDoctor = { [provider]: { leaseUntil: new Date(START + 600000).toISOString() } };
    saved.connectionSyncs = [{ id: 'fixture-running', provider, status: 'running', leaseUntil: new Date(START + 600000).toISOString() }];
  }
  const key = crypto.randomBytes(32).toString('hex'), oldToken = crypto.randomBytes(24).toString('hex'), newToken = crypto.randomBytes(24).toString('hex');
  if (refresh) saved.connections[0].encryptedCredentials = encryptCredentials({ mode: 'oauth', accessToken: 'fixture-access', refreshToken: oldToken, expiresAt: START - 1000 }, key);
  const calls = { providerReads: 0, tokenPosts: 0, saves: 0, finishes: 0, reschedules: 0 };
  let failAfterProvider = false, injected = false, finishMode = 'commit';
  const store = createStore({ SAAS_STATE_FILE: '/unused-in-memory-busy-fixture.json' });
  const row = { id: 'job_busy_fixture', workspace_id: saved.workspace.id, type: 'connection_doctor', provider: null,
    status: 'queued', attempts: 0, max_attempts: 3, priority: 50, concurrency_limit: 1,
    payload: { busy: [{ provider: 'forged', reason: 'sync_lease', leaseUntil: '2099-01-01T00:00:00Z' }] }, ai_units: 0,
    created_at: new Date().toISOString(), available_at: new Date().toISOString(), result: null };
  store.agentJobs = [row];
  store.get = async () => structuredClone(saved);
  store.save = async (_workspace, state) => {
    calls.saves++;
    const shouldFail = failAfterProvider && !injected && calls.providerReads + calls.tokenPosts > 0;
    if (!shouldFail || commitBeforeLostAck) saved = structuredClone(state);
    if (shouldFail) { injected = true; throw Object.assign(new Error('Synthetic post-read persistence failure'), { code: 'PERSISTENCE_FAILED' }); }
  };
  const finish = store.finishAgentJob.bind(store);
  store.finishAgentJob = async (...args) => {
    calls.finishes++;
    if (finishMode === 'throw') throw Object.assign(new Error('Synthetic lost completion acknowledgement'), { code: 'PERSISTENCE_FAILED' });
    if (finishMode === 'null') return null;
    return finish(...args);
  };
  const reschedule = store.rescheduleAgentJob.bind(store);
  store.rescheduleAgentJob = async (...args) => { calls.reschedules++; return reschedule(...args); };
  const refreshTokens = [];
  const integrations = refresh ? new IntegrationService({ CREDENTIALS_KEY: key, PINTEREST_CLIENT_ID: 'synthetic-id', PINTEREST_CLIENT_SECRET: crypto.randomBytes(24).toString('hex') }, {
    fetchImpl: async (url, options = {}) => {
      if (String(url).endsWith('/oauth/token')) {
        assert.equal(options.method, 'POST'); calls.tokenPosts++;
        refreshTokens.push(new URLSearchParams(options.body).get('refresh_token'));
        return Response.json({ access_token: 'fixture-new-access', refresh_token: newToken, expires_in: 86400 });
      }
      calls.providerReads++;
      if (String(url).endsWith('/user_account')) return Response.json({ username: 'Synthetic account' });
      assert.ok(String(url).includes('/boards')); return Response.json({ items: [{ id: 'fixture-board', name: 'Synthetic board' }] });
    }
  }) : { connectionAccessExpiry: () => null, refreshSupported: () => false,
    async syncProvider(state, selected) { assert.equal(selected, provider); calls.providerReads++; state.products = [{ id: 'updated-fixture', provider, variants: [] }]; return { status: 'connected', lastError: null }; } };
  const worker = createAgentOperations({ store, integrations, enabled: false, withWorkspaceLock: async (_id, run) => run() });
  t.after(() => worker.stop());
  return { row, store, worker, calls, provider, snapshot: () => structuredClone(saved),
    failAfterProvider: () => { failAfterProvider = true; }, setFinishMode: value => { finishMode = value; },
    oldRefreshRetained: () => decryptCredentials(saved.connections[0].encryptedCredentials, key).refreshToken === oldToken,
    oldRefreshReused: () => refreshTokens.length > 1 && refreshTokens.every(value => value === oldToken) };
}

for (const first of [false, true]) test(`post-read save failure then early retry is blocked, not completed (${first ? 'first sync' : 'ordinary read'})`, async t => {
  const f = fixture(t, { first }); f.failAfterProvider();
  await f.worker.tick(); assert.equal(f.row.status, 'queued'); assert.equal(f.calls.providerReads, 1); assert.equal(f.calls.reschedules, 1);
  t.mock.timers.tick(16000); await f.worker.tick();
  assert.equal(f.row.status, 'blocked'); assert.equal(f.row.error_code, 'CONNECTION_CHECK_BUSY');
  assert.equal(f.row.result.busy[0].provider, 'shopify'); assert.equal(f.row.result.externalWrites, false);
  assert.equal(f.calls.providerReads, 1); assert.equal(f.calls.reschedules, 1); assert.equal(f.worker.status.processed, 0);
  const state = f.snapshot(); assert.equal(state.connectionSyncs[0].status, 'running');
  assert.equal(state.audit.filter(event => event.type === 'agent_job_completed').length, 0);
  assert.equal(state.audit.filter(event => event.type === 'connection_doctor_repair_success').length, 0);
  t.mock.timers.tick(900000); await f.worker.tick(); assert.equal(f.row.status, 'blocked'); assert.equal(f.calls.providerReads, 1, 'A confirmed blocked job is not automatically rescheduled');
});

for (const mode of ['null', 'throw']) test(`unconfirmed busy settlement (${mode}) does not claim success or enqueue a retry`, async t => {
  const f = fixture(t, { busy: true }); f.setFinishMode(mode); await f.worker.tick();
  assert.equal(f.row.status, 'running'); assert.equal(f.calls.providerReads, 0); assert.equal(f.calls.reschedules, 0);
  assert.equal(f.worker.status.processed, 0); assert.equal(f.worker.status.failed, 0);
  assert.equal(f.worker.status.lastError, 'AGENT_JOB_CLOSURE_UNCONFIRMED');
  assert.equal(f.snapshot().audit.some(event => event.type === 'agent_job_completed'), false);
});

test('stale worker cannot settle another claim as busy or success', async t => {
  const f = fixture(t, { busy: true }); const save = f.store.save;
  f.store.save = async (...args) => { await save(...args); f.row.worker_id = 'replacement-worker'; };
  await f.worker.tick(); assert.equal(f.row.status, 'running'); assert.equal(f.row.worker_id, 'replacement-worker');
  assert.equal(f.row.error_code, undefined); assert.equal(f.worker.status.processed, 0); assert.equal(f.calls.reschedules, 0);
  assert.equal(f.worker.status.lastError, 'AGENT_JOB_CLOSURE_UNCONFIRMED');
});

test('healthy unchanged scan keeps its existing job contract and ignores forged payload busy metadata', async t => {
  const f = fixture(t, { healthy: true }); await f.worker.tick();
  assert.equal(f.row.status, 'succeeded'); assert.deepEqual(f.row.result, { changed: false, externalWrites: false });
  assert.equal(f.calls.providerReads, 0); assert.equal(f.calls.tokenPosts, 0); assert.equal(f.calls.reschedules, 0);
});

test('committed repair with lost acknowledgement can be observed without a second provider read', async t => {
  const f = fixture(t, { commitBeforeLostAck: true }); f.failAfterProvider();
  await f.worker.tick(); assert.equal(f.row.status, 'queued'); t.mock.timers.tick(16000); await f.worker.tick();
  assert.equal(f.row.status, 'succeeded'); assert.equal(f.calls.providerReads, 1); assert.equal(f.snapshot().connectionSyncs[0].status, 'completed');
});

test('busy OAuth retry retains old persisted token without assuming rotation was rolled back', async t => {
  const f = fixture(t, { refresh: true }); f.failAfterProvider();
  await f.worker.tick(); assert.equal(f.row.status, 'queued'); assert.equal(f.calls.tokenPosts, 1); assert.equal(f.oldRefreshRetained(), true);
  t.mock.timers.tick(16000); await f.worker.tick(); assert.equal(f.row.status, 'blocked'); assert.equal(f.row.error_code, 'CONNECTION_CHECK_BUSY');
  assert.equal(f.calls.tokenPosts, 1); assert.equal(f.oldRefreshRetained(), true); assert.equal(f.oldRefreshReused(), false);
});

test('unresolved delayed retry boundary: expiry can repeat read and fake refresh before any busy result is observed', async t => {
  const f = fixture(t, { refresh: true }); f.failAfterProvider();
  await f.worker.tick(); assert.equal(f.oldRefreshRetained(), true); t.mock.timers.tick(601000); await f.worker.tick();
  assert.equal(f.calls.tokenPosts, 2); assert.equal(f.oldRefreshReused(), true);
  assert.equal(f.row.status, 'succeeded', 'This scoped busy-result correction does not establish exactly-once refresh or delayed-retry safety');
});
