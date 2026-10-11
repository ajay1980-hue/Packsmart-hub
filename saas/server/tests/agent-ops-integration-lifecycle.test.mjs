import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentOperations } from '../lib/agent-ops.mjs';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { connectionSettings } from '../lib/connection-centre.mjs';
import { upsertBusinessObjective } from '../lib/business-objectives.mjs';
import { objectiveReviewFingerprint } from '../lib/objective-review.mjs';

const genericTypes = ['agent_command', 'connection_sync', 'connection_doctor', 'marketing_plan'];
const error = (code = 'PERSISTENCE_FAILED') => Object.assign(new Error('Synthetic private error'), { code });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function stillPending(promise) {
  const pending = Symbol('pending');
  assert.equal(await Promise.race([promise, new Promise(resolve => setImmediate(() => resolve(pending)))]), pending);
}
async function enteredDuring(tick, boundary) {
  return Promise.race([boundary.entered, tick.then(() => { throw new Error('Tick completed without reaching the expected await boundary'); })]);
}
function gate(target, method, action) {
  const entered = deferred(), release = deferred(), original = target[method].bind(target);
  target[method] = async (...args) => { entered.resolve(args); await release.promise; return action ? action(original, args) : original(...args); };
  return { entered:entered.promise, release:release.resolve, reject:release.reject };
}

function fixture(t, type = 'agent_command', { busy = false, repair = false } = {}) {
  t.mock.method(globalThis, 'fetch', () => assert.fail('No real network permitted'));
  let state = seedWorkspaceState({}, { workspaceId:'alpha', email:'alpha@example.test', passwordHash:'fixture' });
  state.connections = [{ id:'synthetic-connection', provider:'shopify', status:'connected', encryptedCredentials:'synthetic-unused', lastCheckedAt:new Date().toISOString() }];
  state.connectionSettings = { shopify:{ ...connectionSettings(state, 'shopify'), autoSync:true, areas:['products'] } };
  state.integrationStatus = { shopify:{ status:busy || repair ? 'error' : 'connected', lastError:busy || repair ? 'UPSTREAM_REQUEST_FAILED' : null, ...(busy || repair ? { upstreamStatus:503 } : {}) } };
  if (busy) {
    const leaseUntil = new Date(Date.now() + 600000).toISOString();
    state.connectionDoctor = { shopify:{ leaseUntil } };
    state.connectionSyncs = [{ id:'synthetic-sync', provider:'shopify', status:'running', leaseUntil }];
  }
  if (type === 'marketing_plan') {
    state.products = [{ id:'synthetic-product', externalId:'synthetic-product', title:'Synthetic product', handle:'synthetic-product', status:'active',
      image:'https://example.test/synthetic-product.jpg', variants:[{ id:'synthetic-variant', sku:'SYNTHETIC-001', price:20, inventory:50, available:true }] }];
    state.economics['SYNTHETIC-001'] = { landed:6, packing:0.5, handling:0.5, delivery:1, paymentFee:0.2, channelFee:0.2, advertising:0, otherVariable:0, marginFloor:20 };
  }
  const row = { id:'job_integration', workspace_id:'alpha', type, status:'queued', attempts:0, max_attempts:3,
    priority:50, concurrency_limit:1, payload:{ command:'check health', areas:['products'] },
    provider:type === 'connection_sync' ? 'shopify' : null, actor:state.users[0].id, ai_units:type === 'agent_command' ? 1 : 0,
    ai_provider:null, ai_model:null, ai_tier:'deterministic', result:null, worker_id:null, lease_until:null,
    created_at:new Date().toISOString(), available_at:new Date().toISOString() };
  if (type === 'objective_prepare') {
    const objective = upsertBusinessObjective(state, { title:'Review objective', metric:'contribution_profit', baseline:10, target:100,
      direction:'increase', startsAt:'2025-01-01T00:00:00.000Z', endsAt:'2034-01-01T00:00:00.000Z', limits:{ currency:'GBP' } }, { workspaceId:'alpha' });
    const input = { objectiveId:objective.id, objectiveRevision:objective.revision };
    row.payload = { schema:'runvara-objective-prepare/v1', ...input,
      typedInputFingerprint:objectiveReviewFingerprint(state, input, { workspaceId:'alpha' }), actorSessionVersion:state.users[0].sessionVersion };
  }
  const calls = { claim:0, lock:0, get:0, save:0, provider:0, ai:0, finishes:[], reschedules:[], reconcile:0 };
  const store = createStore({ SAAS_STATE_FILE:'/unused-synthetic-integration-lifecycle.json' });
  store.agentJobs = [row];
  store.get = async workspaceId => { calls.get++; assert.equal(workspaceId, 'alpha'); return structuredClone(state); };
  store.save = async (workspaceId, next) => { calls.save++; assert.equal(workspaceId, 'alpha'); state = structuredClone(next); };
  for (const [method, counter] of [['claimAgentJobs','claim'], ['getAgentJob','reconcile'], ['finishAgentJob','finishes'], ['rescheduleAgentJob','reschedules']]) {
    const original = store[method].bind(store);
    store[method] = async (...args) => { if (Array.isArray(calls[counter])) calls[counter].push(structuredClone(args)); else calls[counter]++; return original(...args); };
  }
  const integrations = { shopifyConfigured:() => true, connectionAccessExpiry:() => null, refreshSupported:() => false,
    async syncProvider(_state, provider) { calls.provider++; assert.equal(provider, 'shopify'); return { status:'connected', lastError:null }; } };
  const aiProvider = { async enhanceCommander() { calls.ai++; return { used:false, reason:'TEST' }; } };
  const timers = new Map();
  const lock = { async run(_id, callback) { calls.lock++; return callback(); } };
  const ops = createAgentOperations({ store, integrations, aiProvider, env:{},
    withWorkspaceLock:(...args) => lock.run(...args),
    scheduleTimeout(callback, delay) { const handle = { unref() {} }; timers.set(handle, { callback, delay }); return handle; },
    cancelTimeout:handle => timers.delete(handle) });
  t.after(() => ops.stop());
  return { ops, store, calls, row, integrations, aiProvider, timers, lock, snapshot:() => structuredClone(state) };
}
function assertNoAction(f) {
  assert.equal(f.calls.get, 0); assert.equal(f.calls.save, 0); assert.equal(f.calls.ai, 0); assert.equal(f.calls.provider, 0);
  assert.equal(f.calls.reschedules.length, 0); assert.equal(f.ops.status.processed, 0);
}
function assertRetained(f, summary, code = null) {
  assert.deepEqual(summary, { settled:true, retainedClaims:1, errors:code ? 1 : 0, lastError:code });
  assert.equal(f.ops.status.processed, 0); assert.equal(f.ops.status.failed, 0); assert.equal(f.ops.status.deadLettered, 0);
  assert.equal(f.calls.reschedules.length, 0); assert.equal(f.timers.size, 0);
}

for (const type of genericTypes) {
  test(`${type}: stop between claim admission and workspace lock cannot start action work`, async t => {
    const f = fixture(t, type);
    // A direct resolved claim puts runTick ahead of this queued stop; its first
    // await admitClaim continuation is behind the stop in the microtask queue.
    f.store.claimAgentJobs = workerId => {
      f.calls.claim++;
      Object.assign(f.row, { status:'running', attempts:1, worker_id:workerId, lease_until:new Date(Date.now() + 300000).toISOString() });
      return Promise.resolve([structuredClone(f.row)]);
    };
    const tick = f.ops.tick();
    queueMicrotask(() => f.ops.stop());
    await tick;
    assertRetained(f, await f.ops.drain());
    assertNoAction(f); assert.equal(f.calls.lock, 0); assert.equal(f.calls.finishes.length, 0); assert.equal(f.row.status, 'running');
  });

  test(`${type}: stop during the repeated lock admission prevents the state read`, async t => {
    const f = fixture(t, type);
    f.lock.run = (_id, callback) => {
      f.calls.lock++;
      queueMicrotask(() => { f.ops.stop(); f.ops.start(); });
      return callback();
    };
    await f.ops.tick();
    assertRetained(f, await f.ops.drain());
    assertNoAction(f); assert.equal(f.calls.lock, 1); assert.equal(f.calls.finishes.length, 0); assert.equal(f.row.status, 'running');
  });

  for (const readFails of [false, true]) test(`${type}: stopped state read ${readFails ? 'failure' : 'success'} cannot admit work`, async t => {
    const f = fixture(t, type), read = gate(f.store, 'get');
    const tick = f.ops.tick(); await enteredDuring(tick, read);
    f.ops.stop(); f.ops.start(); const draining = f.ops.drain(); await stillPending(draining);
    if (readFails) read.reject(error()); else read.release();
    await tick; assertRetained(f, await draining);
    assert.equal(f.calls.save, 0); assert.equal(f.calls.ai, 0); assert.equal(f.calls.provider, 0); assert.equal(f.calls.finishes.length, 0);
    assert.equal(f.row.status, 'running');
  });

  for (const mode of ['false', 'throw', 'lost-ack']) test(`${type}: ${mode} final completion is retained without replay`, async t => {
    const f = fixture(t, type), writes = [];
    const finish = gate(f.store, 'finishAgentJob', async (original, args) => {
      writes.push(structuredClone(args));
      if (mode === 'lost-ack') await original(...args);
      if (mode === 'false') return null;
      throw error();
    });
    const tick = f.ops.tick(); await enteredDuring(tick, finish);
    const draining = f.ops.drain(); await stillPending(draining); finish.release(); await tick;
    assertRetained(f, await draining, mode === 'false' ? 'AGENT_JOB_COMPLETION_UNCONFIRMED' : 'PERSISTENCE_FAILED');
    assert.equal(writes.length, 1); assert.equal(writes[0][1].status, 'succeeded'); assert.equal(writes[0][1].result.externalWrites, false);
    assert.equal(f.row.status, mode === 'lost-ack' ? 'succeeded' : 'running');
    assert.equal(f.calls.ai, type === 'agent_command' ? 1 : 0); assert.equal(f.calls.provider, type === 'connection_sync' ? 1 : 0);
  });

  test(`${type}: returned action result plus failed outer save cannot become an execution retry`, async t => {
    const f = fixture(t, type), save = gate(f.store, 'save');
    const tick = f.ops.tick(); await enteredDuring(tick, save);
    const draining = f.ops.drain(); await stillPending(draining); save.reject(error()); await tick;
    assertRetained(f, await draining, 'PERSISTENCE_FAILED');
    assert.equal(f.calls.finishes.length, 0); assert.equal(f.row.status, 'running');
    assert.equal(f.calls.ai, type === 'agent_command' ? 1 : 0); assert.equal(f.calls.provider, type === 'connection_sync' ? 1 : 0);
  });

  for (const [code, expected] of [['PERSISTENCE_FAILED','queued'], ['AUTH_REQUIRED','blocked'], ['SYNTHETIC_EXECUTION_ERROR','dead_letter']]) {
    test(`${type}: ordinary ${code} still follows its existing attempt policy`, async t => {
      const f = fixture(t, type);
      f.store.get = async () => { f.calls.get++; throw error(code); };
      const method = expected === 'queued' ? 'rescheduleAgentJob' : 'finishAgentJob', finish = gate(f.store, method);
      const tick = f.ops.tick(); await enteredDuring(tick, finish);
      const draining = f.ops.drain(); await stillPending(draining); finish.release(); await tick;
      assert.deepEqual(await draining, { settled:true, retainedClaims:0, errors:0, lastError:null });
      assert.equal(f.row.status, expected); assert.equal(f.row.error_code, code); assert.equal(f.ops.status.failed, 1);
      assert.equal(f.ops.status.deadLettered, expected === 'dead_letter' ? 1 : 0); assert.equal(f.ops.status.processed, 0);
      assert.equal(f.calls.ai, 0); assert.equal(f.calls.provider, 0); assert.equal(f.calls.save, 0);
    });
  }
}

for (const type of [...genericTypes, 'objective_prepare']) {
  for (const mode of ['accepted', 'false', 'throw', 'lost-ack']) test(`${type}: exhausted claim drain waits for ${mode} closure without state or provider reads`, async t => {
    const f = fixture(t, type); f.row.attempts = f.row.max_attempts; f.row.result = { retained:true };
    const finish = gate(f.store, 'finishAgentJob', async (original, args) => {
      if (mode === 'accepted') return original(...args);
      if (mode === 'lost-ack') await original(...args);
      if (mode === 'false') return null;
      throw error();
    });
    const tick = f.ops.tick(); await enteredDuring(tick, finish);
    const draining = f.ops.drain(); await stillPending(draining); finish.release(); await tick;
    const result = await draining;
    assertNoAction(f); assert.equal(f.calls.lock, 0); assert.equal(f.row.attempts, 4); assert.deepEqual(f.row.result, { retained:true });
    if (mode === 'accepted') {
      assert.deepEqual(result, { settled:true, retainedClaims:0, errors:0, lastError:null });
      assert.equal(f.ops.status.failed, 1); assert.equal(f.ops.status.deadLettered, 1);
    } else assertRetained(f, result, mode === 'false' ? type === 'objective_prepare' ? 'OBJECTIVE_COMPLETION_UNCERTAIN' : 'AGENT_JOB_COMPLETION_UNCONFIRMED' : 'PERSISTENCE_FAILED');
    assert.equal(f.row.status, ['accepted','lost-ack'].includes(mode) ? 'dead_letter' : 'running');
  });
}

const staleClaims = {
  worker:row => { row.worker_id = 'replacement-worker'; },
  attempt:row => { row.attempts++; },
  lease:row => { row.lease_until = new Date(Date.now() + 600000).toISOString(); },
  expired:row => { row.lease_until = new Date(Date.now() - 1000).toISOString(); },
  tenant:row => { row.workspace_id = 'beta'; }
};
for (const type of genericTypes) for (const [name, mutate] of Object.entries(staleClaims)) {
  test(`${type}: ${name} fence change during completion stays unconfirmed in drain`, async t => {
    const f = fixture(t, type), finish = gate(f.store, 'finishAgentJob');
    const tick = f.ops.tick(); await enteredDuring(tick, finish);
    const draining = f.ops.drain(); mutate(f.row); finish.release(); await tick;
    assertRetained(f, await draining, 'AGENT_JOB_COMPLETION_UNCONFIRMED');
    assert.equal(f.row.status, 'running'); assert.equal(f.row.result, null); assert.equal(f.calls.finishes.length, 1);
  });
}

for (const mode of ['accepted', 'false', 'throw', 'lost-ack', ...Object.keys(staleClaims)]) {
  test(`Doctor busy ${mode} settlement is tracked through drain without scheduling another check`, async t => {
    const f = fixture(t, 'connection_doctor', { busy:true }), writes = [];
    const finish = gate(f.store, 'finishAgentJob', async (original, args) => {
      writes.push(structuredClone(args));
      if (staleClaims[mode]) staleClaims[mode](f.row);
      if (mode === 'false') return null;
      if (mode === 'throw') throw error();
      const result = await original(...args);
      if (mode === 'lost-ack') throw error();
      return result;
    });
    const tick = f.ops.tick(); await enteredDuring(tick, finish);
    const draining = f.ops.drain(); await stillPending(draining); finish.release(); await tick;
    const result = await draining;
    if (mode === 'accepted') {
      assert.deepEqual(result, { settled:true, retainedClaims:0, errors:0, lastError:null });
      assert.equal(f.ops.status.failed, 1); assert.equal(f.ops.status.lastError, 'CONNECTION_CHECK_BUSY');
    } else assertRetained(f, result, 'AGENT_JOB_CLOSURE_UNCONFIRMED');
    assert.equal(writes.length, 1); assert.equal(writes[0][1].status, 'blocked'); assert.equal(writes[0][1].errorCode, 'CONNECTION_CHECK_BUSY');
    assert.deepEqual(writes[0][1].result.busy.map(item => [item.provider,item.reason]), [['shopify','sync_lease']]);
    assert.equal(f.row.status, ['accepted','lost-ack'].includes(mode) ? 'blocked' : 'running');
    assert.equal(f.calls.provider, 0); assert.equal(f.calls.ai, 0); assert.equal(f.calls.reschedules.length, 0);
    assert.equal(f.snapshot().audit.some(item => item.type === 'agent_job_completed'), false); assert.equal(f.timers.size, 0);
  });
}

test('an admitted connection read completes through its provider await after stop without another admission', async t => {
  const f = fixture(t, 'connection_sync'), provider = gate(f.integrations, 'syncProvider');
  const tick = f.ops.tick(); await enteredDuring(tick, provider);
  const draining = f.ops.drain(); await stillPending(draining); provider.release(); await tick;
  assert.deepEqual(await draining, { settled:true, retainedClaims:0, errors:0, lastError:null });
  assert.equal(f.calls.provider, 1); assert.equal(f.calls.save, 1); assert.equal(f.calls.finishes.length, 1); assert.equal(f.row.status, 'succeeded');
});

test('an admitted Doctor repair drains its internal reservation saves, read and completion after stop', async t => {
  const f = fixture(t, 'connection_doctor', { repair:true }), save = gate(f.store, 'save');
  const tick = f.ops.tick(); await enteredDuring(tick, save);
  const draining = f.ops.drain(); await stillPending(draining); assert.equal(f.calls.provider, 0);
  save.release(); await tick;
  assert.deepEqual(await draining, { settled:true, retainedClaims:0, errors:0, lastError:null });
  assert.equal(f.calls.provider, 1); assert.ok(f.calls.save > 1); assert.equal(f.row.status, 'succeeded'); assert.equal(f.ops.status.processed, 1);
});

for (const mode of ['accepted', 'false', 'throw', 'lost-ack']) {
  test(`typed objective ${mode} completion and reconciliation stay within the drained tick`, async t => {
    const f = fixture(t, 'objective_prepare'), writes = [];
    const finish = gate(f.store, 'finishAgentJob', async (original, args) => {
      writes.push(structuredClone(args));
      if (mode === 'accepted') return original(...args);
      if (mode === 'lost-ack') await original(...args);
      if (mode === 'false') return null;
      throw error();
    });
    const reconcile = mode === 'accepted' ? null : gate(f.store, 'getAgentJob');
    const tick = f.ops.tick(); await enteredDuring(tick, finish);
    const draining = f.ops.drain(); await stillPending(draining); finish.release();
    if (reconcile) { await enteredDuring(tick, reconcile); await stillPending(draining); reconcile.release(); }
    await tick;
    if (['accepted','lost-ack'].includes(mode)) {
      assert.deepEqual(await draining, { settled:true, retainedClaims:0, errors:0, lastError:null });
      assert.equal(f.ops.status.processed, 1); assert.equal(f.row.status, 'succeeded'); assert.equal(writes.length, 1);
      assert.equal(f.row.result.sourceAsOf.typedInputFingerprint, f.row.payload.typedInputFingerprint);
    } else {
      assertRetained(f, await draining, 'OBJECTIVE_COMPLETION_UNCERTAIN'); assert.equal(f.row.status, 'running');
      assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]);
    }
    assert.equal(f.calls.ai, 0); assert.equal(f.calls.provider, 0); assert.equal(f.calls.save, 0); assert.equal(f.calls.get, 1);
  });
}

for (const mode of ['false','throw','lost-ack']) {
  test(`structural source-hold ${mode} closure remains non-retryable and visible to drain`, async t => {
    const f = fixture(t, 'connection_sync');
    f.integrations.syncProvider = async () => { f.calls.provider++; throw error('SHOPIFY_ORDER_SOURCE_INVALID'); };
    const finish = gate(f.store, 'finishAgentJob', async (original, args) => {
      if (mode === 'lost-ack') await original(...args);
      if (mode === 'false') return null;
      throw error();
    });
    const tick = f.ops.tick(); const [, update] = await enteredDuring(tick, finish);
    const draining = f.ops.drain(); await stillPending(draining); finish.release(); await tick;
    assertRetained(f, await draining, 'SHOPIFY_ORDER_HOLD_JOB_CLOSURE_UNCONFIRMED');
    assert.equal(update.status, 'dead_letter'); assert.equal(update.errorCode, 'SHOPIFY_ORDER_SOURCE_INVALID');
    assert.equal(f.calls.provider, 1); assert.equal(f.row.status, mode === 'lost-ack' ? 'dead_letter' : 'running');
    assert.equal(update.result.externalWrites, false);
  });
}
