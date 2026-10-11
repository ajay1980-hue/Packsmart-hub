import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentOperations } from '../lib/agent-ops.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function stillPending(promise) {
  const pending = Symbol('pending');
  assert.equal(await Promise.race([promise, new Promise(resolve => setImmediate(() => resolve(pending)))]), pending);
}

function fixture(t, options = {}) {
  const state = seedWorkspaceState({}, { workspaceId:'alpha', email:'alpha@example.test', passwordHash:'fixture' });
  const jobs = [], calls = { claim:0, get:0, lock:0, save:0, provider:0, finishes:[], reschedules:[] };
  const timers = new Map(), callbacks = [];
  const store = {
    async claimAgentJobs(workerId) {
      calls.claim++;
      return jobs.filter(job => job.status === 'queued').map(job => {
        Object.assign(job, { status:'running', worker_id:workerId, attempts:job.attempts + 1,
          lease_until:new Date(Date.now() + 300000).toISOString() });
        return structuredClone(job);
      });
    },
    async get() { calls.get++; return structuredClone(state); },
    async save(_workspaceId, next) { calls.save++; Object.assign(state, structuredClone(next)); },
    async finishAgentJob(job, update) {
      calls.finishes.push(structuredClone({ job, update }));
      const row = jobs.find(row => row.id === job.id);
      Object.assign(row, { status:update.status, result:update.result ?? row.result, error_code:update.errorCode,
        completed_at:update.completedAt, worker_id:null, lease_until:null });
      return structuredClone(row);
    },
    async rescheduleAgentJob(job, update) {
      calls.reschedules.push(structuredClone({ job, update }));
      const row = jobs.find(row => row.id === job.id);
      Object.assign(row, { status:'queued', worker_id:null, lease_until:null, error_code:update.errorCode });
      return structuredClone(row);
    }
  };
  const ops = createAgentOperations({ store, integrations:{}, env:{},
    withWorkspaceLock:async (_id, callback) => { calls.lock++; return callback(); },
    aiProvider:{ async enhanceCommander() { calls.provider++; return { used:false, reason:'TEST' }; } },
    random:() => 1,
    scheduleTimeout(callback, delay) { const handle = { unref() {} }; timers.set(handle, { callback, delay }); callbacks.push(callback); return handle; },
    cancelTimeout:handle => timers.delete(handle), ...options });
  t.after(() => ops.stop());
  function queue(type = 'agent_command') {
    const job = { id:`job_${jobs.length + 1}`, workspace_id:'alpha', type, status:'queued', attempts:0, max_attempts:3,
      payload:{ command:'check health' }, provider:null, actor:state.users[0].id, ai_units:1,
      ai_provider:null, ai_model:null, ai_tier:'deterministic', result:null, worker_id:null, lease_until:null,
      created_at:new Date().toISOString() };
    if (type === 'objective_prepare') Object.assign(job, { ai_units:0, payload:{ schema:'runvara-objective-prepare/v1',
      objectiveId:'objective_00000000-0000-4000-8000-000000000000', objectiveRevision:1,
      typedInputFingerprint:'0'.repeat(32), actorSessionVersion:state.users[0].sessionVersion } });
    jobs.push(job);
    return job;
  }
  function fireNext() {
    assert.equal(timers.size, 1);
    const [handle, timer] = [...timers][0];
    timers.delete(handle);
    timer.callback();
  }
  return { ops, store, state, jobs, calls, timers, callbacks, queue, fireNext };
}

test('drain waits for a late claim and retains its jobs without executing or inventing terminal results', async t => {
  const f = fixture(t), claim = deferred(), original = f.store.claimAgentJobs.bind(f.store);
  const one = f.queue(), two = f.queue('objective_prepare');
  f.store.claimAgentJobs = async (...args) => { const claimed = await original(...args); await claim.promise; return claimed; };
  const tick = f.ops.tick();
  f.ops.stop();
  const draining = f.ops.drain();
  assert.equal(f.ops.drain(), draining);
  f.ops.stop(); f.ops.start(); await f.ops.tick();
  await stillPending(draining);
  assert.equal(f.calls.claim, 1);
  assert.equal(f.ops.status.running, true);
  claim.resolve();
  await tick;
  assert.deepEqual(await draining, { settled:true, retainedClaims:2, errors:0, lastError:null });
  for (const job of [one, two]) {
    assert.equal(job.status, 'running');
    assert.equal(job.result, null);
    assert.equal(job.attempts, 1);
    assert.equal(job.worker_id, f.ops.workerId);
    assert.ok(Date.parse(job.lease_until) > Date.now());
  }
  assert.deepEqual(f.calls, { claim:1, get:0, lock:0, save:0, provider:0, finishes:[], reschedules:[] });
  assert.equal(f.ops.status.processed, 0);
  assert.equal(f.ops.status.failed, 0);
  assert.equal(f.ops.status.running, false);
  assert.equal(f.timers.size, 0);
});

test('late claim failure settles with bounded error evidence and no follow-on polling', async t => {
  const f = fixture(t), claim = deferred();
  f.store.claimAgentJobs = () => { f.calls.claim++; return claim.promise; };
  f.ops.start();
  const draining = f.ops.drain();
  await stillPending(draining);
  claim.reject(Object.assign(new Error('private response must not appear in drain'), { code:'SUPABASE_PERSISTENCE_FAILED' }));
  assert.deepEqual(await draining, { settled:true, retainedClaims:0, errors:1, lastError:'SUPABASE_PERSISTENCE_FAILED' });
  assert.equal(f.calls.claim, 1);
  assert.equal(f.ops.status.pollErrors, 1);
  assert.equal(f.ops.status.running, false);
  assert.equal(f.timers.size, 0);
});

test('a job queued behind a workspace lock cannot begin after stop and restart', async t => {
  const lock = deferred(), entered = deferred();
  const f = fixture(t, { withWorkspaceLock:async (_id, callback) => { entered.resolve(); await lock.promise; return callback(); } });
  const job = f.queue();
  const tick = f.ops.tick();
  await entered.promise;
  f.ops.stop(); f.ops.start();
  const draining = f.ops.drain();
  await stillPending(draining);
  lock.resolve();
  await tick;
  assert.equal((await draining).retainedClaims, 1);
  assert.equal(f.calls.get, 0);
  assert.equal(f.calls.provider, 0);
  assert.equal(f.calls.save, 0);
  assert.equal(f.calls.finishes.length, 0);
  assert.equal(f.calls.reschedules.length, 0);
  assert.equal(job.status, 'running');
  assert.equal(f.timers.size, 0);
});

test('state reads that settle after stop never admit action work or synthetic failures', async t => {
  for (const type of ['agent_command', 'objective_prepare']) for (const reject of [false, true]) {
    const f = fixture(t), read = deferred(), entered = deferred();
    const job = f.queue(type);
    f.store.get = () => { f.calls.get++; entered.resolve(); return read.promise; };
    f.ops.start();
    await entered.promise;
    f.ops.stop(); f.ops.start();
    const draining = f.ops.drain();
    await stillPending(draining);
    if (reject) read.reject(Object.assign(new Error('read failed after stop'), { code:'PERSISTENCE_FAILED' }));
    else read.resolve(structuredClone(f.state));
    assert.deepEqual(await draining, { settled:true, retainedClaims:1, errors:0, lastError:null });
    assert.equal(f.calls.provider, 0);
    assert.equal(f.calls.save, 0);
    assert.equal(f.calls.finishes.length, 0);
    assert.equal(f.calls.reschedules.length, 0);
    assert.equal(job.status, 'running');
    assert.equal(f.timers.size, 0);
  }
});

test('drain covers an already-running action, its final state save and terminal completion', async t => {
  const action = deferred(), actionEntered = deferred(), save = deferred(), saveEntered = deferred(), finish = deferred(), finishEntered = deferred();
  let providerCalls = 0;
  const f = fixture(t, { aiProvider:{ async enhanceCommander() { providerCalls++; actionEntered.resolve(); return action.promise; } } });
  const job = f.queue(), originalSave = f.store.save.bind(f.store), originalFinish = f.store.finishAgentJob.bind(f.store);
  f.store.save = async (...args) => { saveEntered.resolve(); await save.promise; return originalSave(...args); };
  f.store.finishAgentJob = async (...args) => { finishEntered.resolve(); await finish.promise; return originalFinish(...args); };
  f.ops.start();
  await actionEntered.promise;
  f.ops.stop();
  const draining = f.ops.drain();
  await stillPending(draining);
  action.resolve({ used:false, reason:'TEST' });
  await saveEntered.promise;
  await stillPending(draining);
  assert.equal(f.calls.finishes.length, 0);
  save.resolve();
  await finishEntered.promise;
  await stillPending(draining);
  assert.equal(job.status, 'running');
  finish.resolve();
  assert.deepEqual(await draining, { settled:true, retainedClaims:0, errors:0, lastError:null });
  assert.equal(job.status, 'succeeded');
  assert.equal(providerCalls, 1);
  assert.equal(f.calls.save, 1);
  assert.equal(f.calls.finishes.length, 1);
  assert.equal(f.calls.reschedules.length, 0);
  assert.equal(f.ops.status.processed, 1);
  assert.equal(f.timers.size, 0);
});

test('failed, lost-ACK and unconfirmed completion never requeue or overwrite a completed action', async t => {
  for (const mode of ['throw', 'lost-ack', 'false']) {
    const f = fixture(t), finish = deferred(), entered = deferred();
    const job = f.queue(), original = f.store.finishAgentJob.bind(f.store), writes = [];
    f.store.finishAgentJob = async (...args) => {
      writes.push(structuredClone(args)); entered.resolve(); await finish.promise;
      if (mode === 'lost-ack') await original(...args);
      if (mode === 'false') return null;
      throw Object.assign(new Error('unknown private terminal reply'), { code:'SUPABASE_PERSISTENCE_FAILED' });
    };
    f.ops.start();
    await entered.promise;
    const draining = f.ops.drain();
    await stillPending(draining);
    finish.resolve();
    const result = await draining;
    assert.deepEqual(result, { settled:true, retainedClaims:1, errors:1,
      lastError:mode === 'false' ? 'AGENT_JOB_COMPLETION_UNCONFIRMED' : 'SUPABASE_PERSISTENCE_FAILED' });
    assert.equal(writes.length, 1);
    assert.equal(writes[0][1].status, 'succeeded');
    assert.ok(writes[0][1].result.runId);
    assert.equal(f.calls.provider, 1);
    assert.equal(f.calls.reschedules.length, 0);
    assert.equal(f.ops.status.processed, 0);
    assert.equal(f.ops.status.failed, 0);
    assert.equal(f.ops.status.deadLettered, 0);
    assert.equal(job.status, mode === 'lost-ack' ? 'succeeded' : 'running');
    if (mode === 'lost-ack') assert.deepEqual(job.result, writes[0][1].result);
    assert.equal(f.timers.size, 0);
  }
});

test('a failed post-action state save remains uncertain without terminal writes or immediate replay', async t => {
  const f = fixture(t), save = deferred(), entered = deferred();
  const job = f.queue();
  f.store.save = () => { f.calls.save++; entered.resolve(); return save.promise; };
  f.ops.start();
  await entered.promise;
  const draining = f.ops.drain();
  await stillPending(draining);
  save.reject(Object.assign(new Error('failed save'), { code:'PERSISTENCE_FAILED' }));
  assert.deepEqual(await draining, { settled:true, retainedClaims:1, errors:1, lastError:'PERSISTENCE_FAILED' });
  assert.equal(f.calls.provider, 1);
  assert.equal(f.calls.save, 1);
  assert.equal(f.calls.finishes.length, 0);
  assert.equal(f.calls.reschedules.length, 0);
  assert.equal(job.status, 'running');
  assert.equal(f.ops.status.processed, 0);
});

test('drain waits for admitted failure bookkeeping and captures a rejected or false reschedule', async t => {
  for (const mode of ['accepted', 'throw', 'false']) {
    const f = fixture(t), retry = deferred(), entered = deferred();
    const job = f.queue(), original = f.store.rescheduleAgentJob.bind(f.store);
    f.store.get = async () => { throw Object.assign(new Error('transient read failure'), { code:'PERSISTENCE_FAILED' }); };
    f.store.rescheduleAgentJob = async (...args) => {
      entered.resolve(); await retry.promise;
      if (mode === 'accepted') return original(...args);
      if (mode === 'false') return null;
      throw Object.assign(new Error('retry write failed'), { code:'SUPABASE_PERSISTENCE_FAILED' });
    };
    f.ops.start();
    await entered.promise;
    const draining = f.ops.drain();
    await stillPending(draining);
    retry.resolve();
    assert.deepEqual(await draining, { settled:true, retainedClaims:mode === 'accepted' ? 0 : 1,
      errors:mode === 'accepted' ? 0 : 1, lastError:mode === 'accepted' ? null :
        mode === 'false' ? 'AGENT_JOB_COMPLETION_UNCONFIRMED' : 'SUPABASE_PERSISTENCE_FAILED' });
    assert.equal(job.status, mode === 'accepted' ? 'queued' : 'running');
    assert.equal(f.ops.status.failed, mode === 'accepted' ? 1 : 0);
    assert.equal(f.calls.provider, 0);
    assert.equal(f.calls.finishes.length, 0);
    assert.equal(f.timers.size, 0);
  }
});

test('ordinary stop/start retires old claims and resumes fresh polling without overlap', async t => {
  const f = fixture(t), claim = deferred(), original = f.store.claimAgentJobs.bind(f.store);
  const oldJob = f.queue();
  f.store.claimAgentJobs = async (...args) => { const claimed = await original(...args); await claim.promise; return claimed; };
  const oldTick = f.ops.tick();
  f.ops.stop(); f.ops.start(); f.ops.start();
  assert.equal(f.calls.claim, 1);
  claim.resolve();
  await oldTick;
  assert.equal(oldJob.status, 'running');
  assert.equal(f.calls.provider, 0);
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 0);
  const newJob = f.queue();
  const saved = deferred(), originalSave = f.store.save.bind(f.store);
  f.store.save = async (...args) => { const value = await originalSave(...args); saved.resolve(); return value; };
  f.fireNext();
  await saved.promise;
  assert.equal(f.calls.claim, 2);
  const result = await f.ops.drain();
  assert.equal(result.retainedClaims, 1);
  assert.equal(oldJob.status, 'running');
  assert.equal(newJob.status, 'succeeded');
  assert.equal(f.calls.provider, 1);
  assert.equal(f.timers.size, 0);
});

test('cleared poll callbacks cannot revive work or clear a replacement poll after restart', async t => {
  const f = fixture(t);
  f.ops.start();
  await new Promise(resolve => setImmediate(resolve));
  const stale = f.callbacks[0];
  assert.equal(f.timers.size, 1);
  f.ops.stop(); f.ops.start();
  await new Promise(resolve => setImmediate(resolve));
  const replacement = [...f.timers.keys()][0], nextPollAt = f.ops.status.nextPollAt;
  assert.equal(f.calls.claim, 2);
  stale();
  assert.equal(f.calls.claim, 2);
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.keys()][0], replacement);
  assert.equal(f.ops.status.nextPollAt, nextPollAt);
  const draining = f.ops.drain();
  f.callbacks.at(-1)();
  assert.equal(f.calls.claim, 2);
  assert.equal(f.timers.size, 0);
  assert.equal((await draining).settled, true);
});

test('idle drain is terminal and idempotent for stopped, enabled and disabled workers', async t => {
  for (const enabled of [true, false]) {
    const f = fixture(t, { enabled });
    f.ops.stop(); f.ops.stop();
    const draining = f.ops.drain();
    assert.equal(f.ops.drain(), draining);
    f.ops.start(); await f.ops.tick(); f.ops.stop(); f.ops.start();
    assert.deepEqual(await draining, { settled:true, retainedClaims:0, errors:0, lastError:null });
    assert.equal(f.ops.drain(), draining);
    assert.equal(f.calls.claim, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.ops.status.running, false);
    assert.equal(f.ops.status.nextPollAt, null);
  }
});

test('drain invoked synchronously by a claim still waits for that whole admitted tick', async t => {
  const f = fixture(t), claim = deferred();
  let draining;
  f.store.claimAgentJobs = () => { f.calls.claim++; draining = f.ops.drain(); return claim.promise; };
  const tick = f.ops.tick();
  assert.ok(draining);
  await stillPending(draining);
  assert.equal(f.ops.status.running, true);
  claim.resolve([]);
  await tick;
  assert.deepEqual(await draining, { settled:true, retainedClaims:0, errors:0, lastError:null });
  assert.equal(f.calls.claim, 1);
  assert.equal(f.ops.status.running, false);
});
