import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createPacksmartServer } from '../server.mjs';
import { closePacksmartServer } from '../lib/server-shutdown.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
async function remainsPending(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await flush();
  assert.equal(settled, false);
}

test('shutdown closes admission before sockets and waits for both, exactly once', async () => {
  const drain = deferred(), events = [];
  let closeCallback, timerCallback, timerCleared = 0;
  const server = { packsmart: { drain() { events.push('drain'); return drain.promise; } },
    close(callback) { events.push('close'); closeCallback = callback; } };
  const options = { setTimer(callback, delay) { assert.equal(delay, 10000); timerCallback = callback; return 1; }, clearTimer(id) { assert.equal(id, 1); timerCleared++; } };
  const closing = closePacksmartServer(server, options);
  assert.equal(closePacksmartServer(server, options), closing);
  assert.deepEqual(events, ['drain', 'close']);
  closeCallback();
  await remainsPending(closing);
  drain.resolve({ settled: true, scheduler: { errors: 0, lastError: null }, agentOps: { retainedClaims: 1, errors: 1, lastError: 'COMPLETION_UNCERTAIN', privateField: 'excluded' } });
  assert.deepEqual(await closing, { settled: true, timedOut: false, closed: true, drained: true, closeFailed: false, drainFailed: false,
    localWork: { scheduler: { errors: 0, lastError: null }, agentOps: { retainedClaims: 1, errors: 1, lastError: 'COMPLETION_UNCERTAIN' } } });
  timerCallback();
  assert.equal(timerCleared, 1);
});

test('shutdown deadline reports unsettled work without cancelling it or claiming termination', async () => {
  const task = deferred();
  let timedOut, finished = false;
  const work = task.promise.then(() => { finished = true; });
  const server = { packsmart: { drain: () => work }, close: callback => callback() };
  const closing = closePacksmartServer(server, { setTimer(callback) { timedOut = callback; return 1; }, clearTimer() {} });
  timedOut();
  const result = await closing;
  assert.deepEqual(result, { settled: false, timedOut: true, closed: true, drained: false, closeFailed: false, drainFailed: false, localWork: null });
  assert.equal(finished, false);
  task.resolve(); await work;
  assert.equal(finished, true, 'a task can still finish after the timeout result');
  assert.equal((await closePacksmartServer(server)).drained, false, 'the earlier observation is not rewritten');
});

test('a timeout observation does not terminate the process or its outstanding local task', { timeout: 5000 }, async t => {
  const helper = new URL('../lib/server-shutdown.mjs', import.meta.url).href;
  const source = `import { closePacksmartServer } from ${JSON.stringify(helper)};
    let finish;
    const active = new Promise(resolve => { finish = resolve; }).then(() => { process.send({ lateCompletion: true }); return { settled: true }; });
    process.on('message', message => { if (message === 'complete') finish(); if (message === 'exit') process.exit(0); });
    const result = await closePacksmartServer({ packsmart: { drain: () => active }, close: callback => callback() }, { timeoutMs: 20 });
    process.send({ result });`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [message] = await once(child, 'message');
  assert.equal(message.result.timedOut, true); assert.equal(message.result.settled, false);
  assert.equal(child.exitCode, null);
  const late = once(child, 'message'); child.send('complete');
  assert.deepEqual((await late)[0], { lateCompletion: true });
  assert.equal(child.exitCode, null);
  const exited = once(child, 'exit'); child.send('exit');
  assert.deepEqual(await exited, [0, null]);
});

test('close and drain failures never report a successful shutdown or expose error details', async () => {
  for (const kind of ['close', 'drain', 'throw-close', 'throw-drain']) {
    const secret = randomBytes(16).toString('hex');
    const server = { packsmart: { drain() {
      if (kind === 'throw-drain') throw new Error(secret);
      return kind === 'drain' ? Promise.reject(new Error(secret)) : Promise.resolve({ settled: true });
    } }, close(callback) {
      if (kind === 'throw-close') throw new Error(secret);
      callback(kind === 'close' ? new Error(secret) : undefined);
    } };
    const result = await closePacksmartServer(server);
    assert.equal(result.settled, false); assert.equal(result.timedOut, false);
    assert.equal(result.closeFailed || result.drainFailed, true);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('a server that never listened still awaits its drain; invalid deadlines stay bounded', async () => {
  for (const timeoutMs of [-1, 0, Infinity, 120001, '5']) {
    let delay;
    const server = { packsmart: { drain: () => Promise.resolve({ settled: true }) }, close(callback) { callback({ code: 'ERR_SERVER_NOT_RUNNING' }); } };
    const result = await closePacksmartServer(server, { timeoutMs, setTimer(_callback, value) { delay = value; return 1; }, clearTimer() {} });
    assert.equal(delay, 10000); assert.equal(result.settled, true);
  }
});

async function fixture(t, overrides = {}) {
  const secret = randomBytes(32).toString('base64url');
  let saved = seedWorkspaceState({}, { workspaceId: 'shutdown-fixture', email: 'owner@example.test' });
  saved.users[0].passwordChangeRequired = false;
  const store = { provider: 'file', get: async () => structuredClone(saved), getIdentity: async () => structuredClone(saved),
    save: async (_id, state) => { saved = structuredClone(state); }, ping: async () => true, ...overrides };
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' }, {
    store, schedulerEnabled: false, agentOpsEnabled: false, fetchImpl: async () => assert.fail('No external request')
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await server.packsmart.drain().catch(() => {}); await new Promise(resolve => server.close(resolve)); });
  const token = createSessionToken({ userId: saved.users[0].id, workspaceId: saved.workspace.id, email: saved.users[0].email,
    role: 'owner', sessionVersion: saved.users[0].sessionVersion }, secret);
  const csrf = verifySessionToken(token, secret).csrf;
  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}` + route, { method,
      headers: { Cookie: 'packsmart_session=' + token, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return { server, store, request, state: () => saved };
}

test('server drain awaits an admitted request before any workspace lock and rejects new requests', async t => {
  const entered = deferred(), finish = deferred();
  let calls = 0;
  const f = await fixture(t, { ping: async () => { calls++; entered.resolve(); await finish.promise; return true; } });
  const first = f.request('/api/health'); await entered.promise;
  const drain = f.server.packsmart.drain();
  assert.equal(f.server.packsmart.drain(), drain);
  const later = await f.request('/api/health');
  assert.equal(later.status, 503); assert.equal(later.body.code, 'SERVER_DRAINING');
  assert.equal(later.headers.get('connection'), 'close'); assert.equal(calls, 1);
  await remainsPending(drain);
  finish.resolve(); assert.equal((await first).status, 200);
  assert.equal((await drain).settled, true);
});

test('an already-admitted mutation retains its saved outcome when auth resolves during drain', async t => {
  const authEntered = deferred(), authDone = deferred(), saveEntered = deferred(), saveDone = deferred();
  const f = await fixture(t);
  const get = f.store.get, save = f.store.save;
  let reads = 0, saves = 0;
  f.store.get = async id => { if (++reads === 1) { authEntered.resolve(); await authDone.promise; } return get(id); };
  f.store.save = async (...args) => { saves++; saveEntered.resolve(); await saveDone.promise; return save(...args); };
  const first = f.request('/api/autopilot', { method: 'PUT', body: { enabled: false } });
  await authEntered.promise;
  const drain = f.server.packsmart.drain(); await remainsPending(drain);
  const denied = await f.request('/api/autopilot', { method: 'PUT', body: { enabled: true } });
  assert.equal(denied.status, 503); assert.equal(reads, 1);
  authDone.resolve(); await saveEntered.promise; await remainsPending(drain);
  saveDone.resolve(); assert.equal((await first).status, 200);
  assert.equal((await drain).settled, true);
  assert.equal(saves, 1); assert.equal(f.state().autopilot.enabled, false);
});

test('startup integrity read is awaited and cannot start repair after drain', async t => {
  const entered = deferred(), result = deferred(); let repairs = 0;
  const f = await fixture(t, { provider: 'supabase', integrityCheck: async () => { entered.resolve(); return result.promise; },
    save: async () => { repairs++; } });
  await entered.promise;
  const drain = f.server.packsmart.drain(); await remainsPending(drain);
  result.resolve({ healthy: false });
  assert.equal((await drain).settled, true); assert.equal(repairs, 0);
});

test('integrity repair already saving is retained and awaited through drain', async t => {
  const entered = deferred(), result = deferred(); let reads = 0, saves = 0;
  const f = await fixture(t, { provider: 'supabase', integrityCheck: async () => { reads++; return { healthy: false }; },
    save: async () => { saves++; entered.resolve(); await result.promise; } });
  await entered.promise;
  const drain = f.server.packsmart.drain(); await remainsPending(drain);
  result.resolve(); await drain;
  assert.equal(saves, 1); assert.equal(reads, 1, 'no new post-repair check during shutdown');
});

test('server worker drain remains pending until a late empty claim has settled', async t => {
  const entered = deferred(), reply = deferred();
  const f = await fixture(t, { claimAgentJobs: async () => { entered.resolve(); return reply.promise; } });
  const tick = f.server.packsmart.agentOps.tick(); await entered.promise;
  const drain = f.server.packsmart.drain(); await remainsPending(drain);
  reply.resolve([]); await tick;
  assert.equal((await drain).agentOps.settled, true);
});

test('early worker-drain rejection is handled while admitted HTTP and the other worker settle', async t => {
  const entered = deferred(), read = deferred(), otherWorker = deferred();
  const f = await fixture(t, { ping: async () => { entered.resolve(); await read.promise; return true; } });
  const request = f.request('/api/health'); await entered.promise;
  f.server.packsmart.scheduler.drain = () => Promise.reject(new Error('private fault details'));
  f.server.packsmart.agentOps.drain = () => otherWorker.promise;
  const drain = f.server.packsmart.drain();
  const rejection = assert.rejects(drain, { message: 'WORKER_DRAIN_FAILED' });
  await remainsPending(drain);
  read.resolve(); assert.equal((await request).status, 200); await remainsPending(drain);
  otherWorker.resolve({ settled: true }); await rejection;
});
