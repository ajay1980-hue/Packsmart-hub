import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentOperations } from '../lib/agent-ops.mjs';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';

const genericTypes = ['agent_command', 'connection_sync', 'connection_doctor', 'marketing_plan'];
const invalidCounters = [undefined, null, NaN, Infinity, -Infinity, -1, 0, 1.5, '1', '', true, false, {}, [], Number.MAX_SAFE_INTEGER + 1];
const timestamp = Date.now();

function harness(t, patch = {}, options = {}) {
  const calls = { reads:0, saves:0, locks:0, credentials:0, providers:0, reschedules:0, finishes:[] };
  let clock = timestamp;
  const forbidden = key => () => { calls[key]++; throw new Error(`Unexpected ${key}`); };
  const integrations = new Proxy({}, { get:forbidden('credentials') });
  const store = {
    claimAgentJobs:async workerId => [{ id:'job_claim', workspace_id:'alpha', type:'connection_sync', provider:'shopify',
      status:'running', worker_id:workerId, attempts:1, max_attempts:5, lease_until:new Date(timestamp + 300000).toISOString(),
      payload:{}, result:null, ...patch }],
    get:forbidden('reads'), save:forbidden('saves'), getAgentJob:forbidden('reads'),
    rescheduleAgentJob:forbidden('reschedules'),
    finishAgentJob:async (job, update) => {
      calls.finishes.push({ job, update });
      return options.finish ? options.finish(job, update) : { ...job, status:update.status };
    }
  };
  const ops = createAgentOperations({ store, integrations, enabled:false, now:() => clock,
    aiProvider:{ enhanceCommander:forbidden('providers') },
    withWorkspaceLock:async (_id, callback) => { calls.locks++; if (options.lockDelay) clock += options.lockDelay; return callback(); } });
  t.after(() => ops.stop());
  return { store, ops, calls };
}

function assertNoWork(f) {
  assert.equal(f.calls.reads, 0);
  assert.equal(f.calls.saves, 0);
  assert.equal(f.calls.credentials, 0);
  assert.equal(f.calls.providers, 0);
  assert.equal(f.calls.reschedules, 0);
  assert.equal(f.ops.status.processed, 0);
}

test('every generic job rejects exhausted claims before state, credentials, business or provider work', async t => {
  for (const type of genericTypes) for (const maximum of [1, 5, 10]) {
    const f = harness(t, { type, attempts:maximum + 1, max_attempts:maximum,
      maxAttempts:10, payload:{ attempts:1, max_attempts:10, maxAttempts:10 }, result:{ retained:true } });
    await f.ops.tick();
    assertNoWork(f);
    assert.equal(f.calls.locks, 0);
    assert.equal(f.calls.finishes.length, 1);
    const { job, update } = f.calls.finishes[0];
    assert.equal(job.attempts, maximum + 1);
    assert.equal(job.max_attempts, maximum);
    assert.equal(update.status, 'dead_letter');
    assert.equal(update.errorCode, 'AGENT_LEASE_ATTEMPTS_EXHAUSTED');
    assert.deepEqual(update.result, { retained:true });
    assert.equal(f.ops.status.failed, 1);
    assert.equal(f.ops.status.deadLettered, 1);
  }
});

test('invalid authoritative attempt counters never fall back, read state or construct a malformed write', async t => {
  for (const attempts of invalidCounters) {
    const f = harness(t, { attempts, attempt:1, payload:{ attempts:1 } });
    await f.ops.tick();
    assertNoWork(f);
    assert.equal(f.calls.finishes.length, 0);
    assert.equal(f.ops.status.lastError, 'AGENT_JOB_CLAIM_INVALID');
    assert.equal(f.ops.status.failed, 0);
    assert.equal(f.ops.status.deadLettered, 0);
  }
});

test('invalid authoritative maxima never use defaults or camelCase and close only through a valid fence', async t => {
  for (const max_attempts of [...invalidCounters, 11]) {
    const f = harness(t, { max_attempts, maxAttempts:5, payload:{ maxAttempts:5 } });
    await f.ops.tick();
    assertNoWork(f);
    assert.equal(f.calls.finishes.length, 1);
    assert.equal(f.calls.finishes[0].update.errorCode, 'AGENT_JOB_CLAIM_INVALID');
    assert.equal(f.calls.finishes[0].update.status, 'dead_letter');
    assert.equal(f.calls.finishes[0].job.attempts, 1);
    assert.equal(f.ops.status.failed, 1);
    assert.equal(f.ops.status.deadLettered, 1);
  }
});

test('malformed or expired fence values never reach state, credentials or terminal writes', async t => {
  const patches = [{ status:'queued' }, { status:'succeeded' }, { worker_id:'other_worker' }, { worker_id:null },
    { id:null }, { id:'' }, { id:'job_bad&workspace_id=eq.beta' }, { id:'a'.repeat(201) },
    { workspace_id:null, workspaceId:'beta' }, { workspace_id:'' }, { workspace_id:'alpha&workspace_id=eq.beta' },
    { workspace_id:42 }, { workspace_id:'a'.repeat(201) }, { lease_until:null }, { lease_until:timestamp + 300000 },
    { lease_until:'invalid' }, { lease_until:new Date(timestamp).toISOString() }, { lease_until:new Date(timestamp - 1).toISOString() }];
  for (const patch of patches) {
    const f = harness(t, { attempts:6, ...patch });
    await f.ops.tick();
    assertNoWork(f);
    assert.equal(f.calls.finishes.length, 0);
    assert.equal(f.ops.status.failed, 0);
    assert.equal(f.ops.status.deadLettered, 0);
    assert.equal(f.ops.status.lastError, 'AGENT_JOB_CLAIM_INVALID');
  }
  for (const job of [null, undefined, [], 'invalid']) {
    const f = harness(t);
    f.store.claimAgentJobs = async () => [job];
    await f.ops.tick();
    assertNoWork(f);
    assert.equal(f.calls.finishes.length, 0);
    assert.equal(f.ops.status.lastError, 'AGENT_JOB_CLAIM_INVALID');
  }
});

test('a lease expiring in the workspace lock cannot load state or report a completed job', async t => {
  const f = harness(t, {}, { lockDelay:300000 });
  await f.ops.tick();
  assertNoWork(f);
  assert.equal(f.calls.locks, 1);
  assert.equal(f.calls.finishes.length, 0);
  assert.equal(f.ops.status.failed, 0);
  assert.equal(f.ops.status.lastError, 'AGENT_JOB_CLAIM_INVALID');
});

test('null and uncertain rejection closures cannot report failed/dead-lettered completion or reschedule', async t => {
  for (const patch of [{ attempts:6 }, { max_attempts:NaN }]) for (const finish of [() => null, () => { throw new Error('lost completion response'); }]) {
    const f = harness(t, patch, { finish });
    await f.ops.tick();
    assertNoWork(f);
    assert.equal(f.calls.finishes.length, 1);
    assert.equal(f.ops.status.failed, 0);
    assert.equal(f.ops.status.deadLettered, 0);
  }
});

async function fileFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-claim-budget-'));
  const store = createStore({ SAAS_STATE_FILE:path.join(dir, 'state.json') });
  t.after(async () => fs.rm(dir, { recursive:true, force:true }));
  return store;
}

async function queue(store, { type = 'connection_sync', maximum = 5 } = {}) {
  return store.enqueueAgentJob('alpha', { id:'job_reclaimed', type, provider:type === 'connection_sync' ? 'shopify' : null,
    payload:{ command:'check health', areas:['products'] }, priority:80, maxAttempts:maximum, concurrencyLimit:1, aiUnits:0,
    idempotencyKey:'budget-check', availableAt:new Date(timestamp - 1000).toISOString(), createdAt:new Date(timestamp).toISOString() });
}

test('actual legacy FileStore lease recovery past the ceiling does no additional work and closes once', async t => {
  for (const type of ['connection_sync', 'connection_doctor']) for (const maximum of [1, 5, 10]) {
    const store = await fileFixture(t);
    await queue(store, { type, maximum });
    const row = store.agentJobs[0];
    row.result = { retained:true };
    for (let attempt = 1; attempt <= maximum; attempt++) {
      const [claim] = await store.claimAgentJobs('old_worker', 1, 300);
      assert.equal(claim.attempts, attempt);
      row.lease_until = new Date(Date.now() - 1000).toISOString();
    }
    let reads = 0, credentials = 0;
    store.get = async () => { reads++; throw new Error('No workspace read'); };
    const integrations = new Proxy({}, { get() { credentials++; throw new Error('No credential/config decoding'); } });
    const ops = createAgentOperations({ store, integrations, enabled:false, withWorkspaceLock:async (_id, fn) => fn() });
    t.after(() => ops.stop());
    await ops.tick();
    assert.equal(row.attempts, maximum + 1);
    assert.equal(row.status, 'dead_letter');
    assert.equal(row.error_code, 'AGENT_LEASE_ATTEMPTS_EXHAUSTED');
    assert.equal(row.worker_id, null);
    assert.equal(row.lease_until, null);
    assert.deepEqual(row.result, { retained:true });
    assert.equal(ops.status.deadLettered, 1);
    await ops.tick();
    assert.equal(ops.status.deadLettered, 1);
    assert.equal(row.attempts, maximum + 1);
    assert.equal(reads, 0);
    assert.equal(credentials, 0);
  }
});

test('repeated expired-lease recoveries after an uncertain close cannot restart provider work', async t => {
  const store = await fileFixture(t);
  await queue(store, { maximum:1 });
  const row = store.agentJobs[0];
  row.attempts = 1;
  let reads = 0, credentials = 0, finishes = 0;
  store.get = async () => { reads++; throw new Error('No workspace read'); };
  store.finishAgentJob = async () => { finishes++; throw new Error('Uncertain completion'); };
  const integrations = new Proxy({}, { get() { credentials++; throw new Error('No credential/config decoding'); } });
  const ops = createAgentOperations({ store, integrations, enabled:false, withWorkspaceLock:async (_id, fn) => fn() });
  t.after(() => ops.stop());
  for (let attempt = 2; attempt <= 6; attempt++) {
    await ops.tick();
    assert.equal(row.attempts, attempt);
    assert.equal(row.status, 'running');
    row.lease_until = new Date(Date.now() - 1000).toISOString();
  }
  assert.equal(finishes, 5);
  assert.equal(reads, 0);
  assert.equal(credentials, 0);
  assert.equal(ops.status.processed, 0);
  assert.equal(ops.status.failed, 0);
  assert.equal(ops.status.deadLettered, 0);
});

test('replaced, expired and foreign-tenant claims cannot falsely close the current FileStore row', async t => {
  for (const change of [row => { row.attempts++; }, row => { row.worker_id = 'replacement_worker'; },
    row => { row.lease_until = new Date(Date.now() + 600000).toISOString(); },
    row => { row.lease_until = new Date(Date.now() - 1).toISOString(); }, row => { row.workspace_id = 'beta'; }]) {
    const store = await fileFixture(t);
    await queue(store, { maximum:1 });
    store.agentJobs[0].attempts = 1;
    const originalClaim = store.claimAgentJobs.bind(store);
    store.claimAgentJobs = async (...args) => { const claims = await originalClaim(...args); change(store.agentJobs[0]); return claims; };
    let reads = 0, finishes = 0;
    store.get = async () => { reads++; throw new Error('No workspace read'); };
    const finish = store.finishAgentJob.bind(store);
    store.finishAgentJob = async (...args) => { finishes++; return finish(...args); };
    const ops = createAgentOperations({ store, integrations:{}, enabled:false, withWorkspaceLock:async (_id, fn) => fn() });
    t.after(() => ops.stop());
    await ops.tick();
    assert.equal(store.agentJobs[0].status, 'running');
    assert.equal(ops.status.failed, 0);
    assert.equal(ops.status.deadLettered, 0);
    assert.equal(ops.status.processed, 0);
    assert.equal(finishes, 1);
    assert.equal(reads, 0);
  }
});

test('admitted final attempt retains normal execution and authoritative provider context', async t => {
  for (const maximum of [1, 5, 10]) {
    const store = await fileFixture(t);
    await store.save('alpha', seedWorkspaceState({}, { workspaceId:'alpha', email:'alpha@example.test', passwordHash:'fixture' }));
    await queue(store, { type:'agent_command', maximum });
    store.agentJobs[0].attempts = maximum - 1;
    let reads = 0, providers = 0;
    const get = store.get.bind(store);
    store.get = async (...args) => { reads++; return get(...args); };
    const ops = createAgentOperations({ store, integrations:{}, enabled:false, withWorkspaceLock:async (_id, fn) => fn(),
      aiProvider:{ enhanceCommander:async input => { providers++; assert.equal(input.jobContext.attempt, maximum); return { used:false, reason:'TEST' }; } } });
    t.after(() => ops.stop());
    await ops.tick();
    assert.equal(reads, 1);
    assert.equal(providers, 1);
    assert.equal(store.agentJobs[0].status, 'succeeded');
    assert.equal(store.agentJobs[0].attempts, maximum);
    assert.equal(ops.status.processed, 1);
    assert.equal(ops.status.failed, 0);
  }
});

test('the last allowed connection-sync attempt still performs its existing read and completion', async t => {
  const store = await fileFixture(t);
  const state = seedWorkspaceState({}, { workspaceId:'alpha', email:'alpha@example.test', passwordHash:'fixture' });
  state.connections = [{ provider:'shopify', status:'connected', encryptedCredentials:'fixture' }];
  await store.save('alpha', state);
  await queue(store, { maximum:5 });
  store.agentJobs[0].attempts = 4;
  let providerReads = 0;
  const ops = createAgentOperations({ store, enabled:false, withWorkspaceLock:async (_id, fn) => fn(),
    integrations:{ shopifyConfigured:() => true, syncProvider:async (_state, provider, options) => {
      providerReads++;
      assert.equal(provider, 'shopify');
      assert.deepEqual(options.areas, ['products']);
      return { status:'connected', lastError:null };
    } } });
  t.after(() => ops.stop());
  await ops.tick();
  assert.equal(providerReads, 1);
  assert.equal(store.agentJobs[0].attempts, 5);
  assert.equal(store.agentJobs[0].status, 'succeeded');
  assert.equal(ops.status.processed, 1);
  assert.equal(ops.status.failed, 0);
});

test('Supabase exhausted-claim admission issues only claim and exact fenced terminal PATCH, never full-state GET', async t => {
  const calls = [];
  let job;
  const store = createStore({ SUPABASE_URL:'https://claim-budget-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY:'test-key' }, {
    fetchImpl:async (url, options = {}) => {
      const call = { url:new URL(url), ...options };
      calls.push(call);
      if (call.url.pathname.endsWith('/rpc/runvara_claim_agent_jobs')) {
        job = { id:'job_exhausted', workspace_id:'alpha', type:'connection_sync', status:'running', provider:'shopify',
          worker_id:JSON.parse(options.body).p_worker_id, attempts:6, max_attempts:5,
          lease_until:new Date(Date.now() + 300000).toISOString(), result:{ retained:true } };
        return Response.json([job]);
      }
      assert.equal(options.method, 'PATCH');
      assert.ok(call.url.pathname.endsWith('/runvara_agent_jobs'));
      return Response.json([{ ...job, status:'dead_letter' }]);
    }
  });
  const ops = createAgentOperations({ store, integrations:new Proxy({}, { get() { assert.fail('No credential/config access'); } }),
    enabled:false, withWorkspaceLock:async () => assert.fail('No workspace lock for exhausted claim') });
  t.after(() => ops.stop());
  await ops.tick();
  assert.equal(calls.length, 2);
  const patch = calls[1], query = patch.url.searchParams;
  assert.equal(patch.method, 'PATCH');
  assert.equal(query.get('workspace_id'), 'eq.alpha');
  assert.equal(query.get('id'), 'eq.job_exhausted');
  assert.equal(query.get('status'), 'eq.running');
  assert.equal(query.get('worker_id'), `eq.${job.worker_id}`);
  assert.equal(query.get('attempts'), 'eq.6');
  assert.deepEqual(query.getAll('lease_until'), [`eq.${job.lease_until}`, 'gt.now']);
  assert.equal(JSON.parse(patch.body).error_code, 'AGENT_LEASE_ATTEMPTS_EXHAUSTED');
  assert.deepEqual(JSON.parse(patch.body).result, { retained:true });
  assert.equal(ops.status.deadLettered, 1);
  t.diagnostic(JSON.stringify({ fixture: 'exhausted connection_sync claim, retained compact job result', requests: calls.length,
    fullStateReads: 0, bodyBytes: calls.reduce((sum, call) => sum + Buffer.byteLength(call.body || ''), 0),
    families: calls.map(call => ({ method: call.method, table: call.url.pathname.split('/').pop(), bodyBytes: Buffer.byteLength(call.body || '') })) }));
});
