// Synthetic filesystem state and real separate processes; no external services.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createSyntheticAttempt, syntheticAttemptDetails, openSyntheticAttempt } from '../scripts/simulation-attempt.mjs';
import { descriptionSimulationBinding } from '../scripts/simulate-description-pilot.mjs';

const worker = fileURLToPath(new URL('./description-pilot-process-worker.mjs', import.meta.url));
const audit = [], active = new Set();
const manifestFile = attempt => path.join(attempt.directory, 'manifest.json');
const markerFile = attempt => path.join(attempt.directory, 'consumed.json');
const newAttempt = async () => syntheticAttemptDetails(await createSyntheticAttempt(descriptionSimulationBinding()));
const absent = async filename => { await assert.rejects(() => fs.lstat(filename), { code: 'ENOENT' }); };
const sha = value => createHash('sha256').update(value).digest('hex');

async function refusedPort(port) {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Shutdown check timed out')); });
    socket.once('connect', () => { socket.destroy(); reject(new Error('Worker listener remained open')); });
    socket.once('error', error => { socket.destroy(); error.code === 'ECONNREFUSED' ? resolve() : reject(error); });
  });
}
function launch(t, options) {
  const startedAt = new Date().toISOString();
  const child = fork(worker, [], { env: {}, execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  active.add(child);
  const messages = [], pending = new Set();
  let output = '', closed = false;
  child.stdout.on('data', data => { output += data.toString(); });
  child.stderr.on('data', data => { output += data.toString(); });
  const done = new Promise(resolve => {
    child.once('error', error => { output += error.code || error.name; });
    child.once('close', (code, signal) => {
      closed = true; active.delete(child);
      for (const waiter of pending) waiter.reject(new Error(`Worker exited before message (${code}/${signal}): ${output}`));
      resolve({ code, signal });
    });
  });
  child.on('message', message => {
    messages.push(message);
    for (const waiter of [...pending]) if (waiter.predicate(message)) { pending.delete(waiter); waiter.resolve(message); }
  });
  const wait = predicate => {
    const found = messages.find(predicate);
    if (found) return Promise.resolve(found);
    if (closed) return Promise.reject(new Error(`Worker already closed: ${output}`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(waiter); reject(new Error(`Worker message timeout: ${output}`)); }, 12000);
      const waiter = { predicate, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
      pending.add(waiter);
    });
  };
  const exit = async () => {
    let timer;
    try { return await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Worker failed to exit')), 5000); })]); }
    finally { clearTimeout(timer); }
  };
  const stop = async () => { if (!closed) child.kill('SIGKILL'); return exit(); };
  t.after(async () => {
    if (!closed) await stop(); else await exit();
    const ports = [...new Set(messages.filter(m => m.type === 'bound').map(m => m.address.port))];
    for (const port of ports) await refusedPort(port);
    const guard = messages.findLast(m => m.guard)?.guard;
    if (options.action !== 'probe') assert.deepEqual(guard?.denied, [], 'Normal worker must report no unexpected I/O');
    audit.push({ pid: child.pid, startedAt, exitedAt: new Date().toISOString(), attemptId: options.attemptId || null, action: options.action || 'run',
      stopAt: options.stopAt || null, exited: closed, portsRefused: ports,
      checkpoints: messages.filter(m => m.type === 'checkpoint').map(m => m.phase),
      submissions: messages.filter(m => m.type === 'checkpoint' && m.phase === 'simulated_submission').length,
      guard });
  });
  child.send(options);
  return { messages, wait, stop, go: () => child.send({ action: 'go' }),
    finish: async () => {
      const result = await wait(m => m.type === 'result');
      assert.deepEqual(await exit(), { code: 0, signal: null }, output);
      assert.equal(result.cleanupError, undefined);
      if (options.action !== 'probe') assert.deepEqual(result.guard.denied, [], JSON.stringify(result.guard));
      assert.deepEqual(result.guard.activeAllowedPorts, []);
      if (result.lifecycle) {
        assert.equal(result.lifecycle.listening, false); assert.equal(result.lifecycle.address, null);
        assert.equal(result.lifecycle.scheduler.running, false); assert.equal(result.lifecycle.agentOps.running, false);
      }
      return result;
    }
  };
}
async function refusedRestart(t, attempt, expected = 'SIMULATION_ATTEMPT_CONSUMED', options = {}) {
  const before = await fs.readFile(manifestFile(attempt));
  const child = launch(t, { attemptId: attempt.attemptId, ...options }), result = await child.finish();
  assert.equal(result.error, expected, JSON.stringify(result));
  assert.equal(result.submissions, 0); assert.equal(result.lifecycle, undefined);
  assert.equal(child.messages.some(m => m.type === 'bound'), false);
  assert.deepEqual(await fs.readFile(manifestFile(attempt)), before, 'Refusal must not repair or replace identity');
  return result;
}

test('SIMULATED persisted success keeps stable identity and refuses a separate-process restart', { timeout: 25000 }, async t => {
  const attempt = await newAttempt(), before = await fs.readFile(manifestFile(attempt));
  const reopened = syntheticAttemptDetails(await openSyntheticAttempt(attempt.attemptId, descriptionSimulationBinding()));
  assert.deepEqual(reopened, attempt);
  const child = launch(t, { attemptId: attempt.attemptId }), result = await child.finish();
  assert.equal(result.writeStatus, 'completed'); assert.equal(result.httpStatus, 200);
  assert.equal(result.submissions, 1); assert.equal(result.provider.mutations, 1); assert.equal(result.finalizations, 1);
  assert.deepEqual(result.attempt, attempt);
  assert.deepEqual(child.messages.filter(m => m.type === 'checkpoint').map(m => m.phase),
    ['marker_created', 'marker_written', 'marker_flushed', 'simulated_submission']);
  const address = child.messages.find(m => m.type === 'bound').address;
  assert.equal(address.address, '127.0.0.1'); assert.equal(address.family, 'IPv4');
  assert.ok(result.guard.loopbackConnections >= 3); assert.ok(result.guard.attemptReads > 0); assert.equal(result.guard.attemptWrites, 1);
  const marker = JSON.parse(await fs.readFile(markerFile(attempt), 'utf8'));
  assert.equal(marker.attemptId, attempt.attemptId); assert.equal(marker.manifestDigest, attempt.manifestDigest); assert.equal(marker.state, 'consumed');
  const markerBefore = await fs.readFile(markerFile(attempt));
  await refusedRestart(t, attempt);
  assert.deepEqual(await fs.readFile(manifestFile(attempt)), before);
  assert.deepEqual(await fs.readFile(markerFile(attempt)), markerBefore);
});

test('SIMULATED simultaneous processes share one exclusive claim and submit at most once', { timeout: 25000 }, async t => {
  const attempt = await newAttempt();
  const children = [launch(t, { attemptId: attempt.attemptId, waitForGo: true }), launch(t, { attemptId: attempt.attemptId, waitForGo: true })];
  await Promise.all(children.map(child => child.wait(m => m.type === 'ready')));
  children.forEach(child => child.go());
  const results = await Promise.all(children.map(child => child.finish()));
  assert.deepEqual(results.map(r => r.submissions).sort(), [0, 1]);
  assert.deepEqual(results.map(r => r.provider.mutations).sort(), [0, 1]);
  assert.equal(results.filter(r => r.writeStatus === 'completed').length, 1);
  assert.equal(children.flatMap(c => c.messages).filter(m => m.phase === 'marker_created').length, 1);
  await refusedRestart(t, attempt);
});

test('SIMULATED termination before claiming allows one subsequent submission', { timeout: 25000 }, async t => {
  const attempt = await newAttempt(), child = launch(t, { attemptId: attempt.attemptId, waitForGo: true });
  await child.wait(m => m.type === 'ready'); await child.stop(); await absent(markerFile(attempt));
  const result = await launch(t, { attemptId: attempt.attemptId }).finish();
  assert.equal(result.submissions, 1); assert.equal(result.writeStatus, 'completed');
  await refusedRestart(t, attempt);
});

test('SIMULATED interrupted markers and termination before/after submission remain consumed', { timeout: 60000 }, async t => {
  for (const phase of ['marker_created', 'marker_written', 'marker_flushed', 'simulated_submission']) await t.test(phase, async t => {
    const attempt = await newAttempt(), child = launch(t, { attemptId: attempt.attemptId, stopAt: phase });
    const checkpoint = await child.wait(m => m.type === 'checkpoint' && m.phase === phase);
    assert.deepEqual(checkpoint.guard.denied, []);
    await child.stop();
    const bytes = await fs.readFile(markerFile(attempt));
    if (phase === 'marker_created') assert.equal(bytes.length, 0);
    else assert.equal(JSON.parse(bytes).state, 'consumed');
    assert.equal(child.messages.filter(m => m.phase === 'simulated_submission').length, phase === 'simulated_submission' ? 1 : 0);
    await refusedRestart(t, attempt);
    assert.deepEqual(await fs.readFile(markerFile(attempt)), bytes);
  });
});

test('SIMULATED lost provider response remains uncertain and cannot resend after restart', { timeout: 25000 }, async t => {
  const attempt = await newAttempt(), result = await launch(t, { attemptId: attempt.attemptId, fault: 'provider_lost_response' }).finish();
  assert.equal(result.submissions, 1); assert.equal(result.provider.mutations, 1);
  assert.equal(result.writeStatus, 'uncertain'); assert.equal(result.finalizations, 0);
  await refusedRestart(t, attempt);
});

test('SIMULATED existing empty, malformed, mismatched and directory markers refuse dispatch', { timeout: 60000 }, async t => {
  for (const shape of ['empty', 'partial', 'mismatched', 'directory']) await t.test(shape, async t => {
    const attempt = await newAttempt();
    if (shape === 'directory') await fs.mkdir(markerFile(attempt));
    else await fs.writeFile(markerFile(attempt), shape === 'empty' ? '' : shape === 'partial' ? '{' : '{"attemptId":"different"}', { flag: 'wx' });
    const before = shape === 'directory' ? null : await fs.readFile(markerFile(attempt));
    await refusedRestart(t, attempt);
    if (before) assert.deepEqual(await fs.readFile(markerFile(attempt)), before);
    else assert.equal((await fs.lstat(markerFile(attempt))).isDirectory(), true);
  });
});

test('SIMULATED malformed, mismatched and missing manifests refuse without replacement', { timeout: 60000 }, async t => {
  for (const shape of ['malformed', 'digest', 'binding', 'identity', 'missing']) await t.test(shape, async t => {
    const attempt = await newAttempt(), filename = manifestFile(attempt);
    if (shape === 'missing') {
      await fs.rename(filename, path.join(attempt.directory, 'manifest.retained-test-copy.json'));
      const result = await launch(t, { attemptId: attempt.attemptId }).finish();
      assert.equal(result.error, 'SIMULATION_ATTEMPT_STATE_UNAVAILABLE'); assert.equal(result.submissions, 0);
      await absent(filename);
    } else {
      const value = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (shape === 'digest') value.digest = '0'.repeat(64);
      if (shape === 'binding' || shape === 'identity') {
        if (shape === 'binding') value.binding.inputDigest = '0'.repeat(64);
        else value.requestId = 'simulation_wrong_identity';
        const { digest, ...body } = value; value.digest = sha(JSON.stringify(body));
      }
      await fs.writeFile(filename, shape === 'malformed' ? '{' : JSON.stringify(value));
      await refusedRestart(t, attempt, shape === 'malformed' ? 'SIMULATION_ATTEMPT_STATE_UNAVAILABLE' : 'SIMULATION_ATTEMPT_BINDING_MISMATCH');
    }
    await absent(markerFile(attempt));
  });
});

test('SIMULATED manifest changed after opening is checked again before the claim', { timeout: 25000 }, async t => {
  const attempt = await newAttempt(), child = launch(t, { attemptId: attempt.attemptId, waitForGo: true });
  await child.wait(m => m.type === 'ready');
  await fs.writeFile(manifestFile(attempt), '{'); child.go();
  const result = await child.finish();
  assert.equal(result.submissions, 0); assert.equal(result.provider.mutations, 0); assert.notEqual(result.writeStatus, 'completed');
  await absent(markerFile(attempt));
  await refusedRestart(t, attempt, 'SIMULATION_ATTEMPT_STATE_UNAVAILABLE');
});

test('SIMULATED injected unreadable state and failed flush fail closed without repair', { timeout: 60000 }, async t => {
  for (const ioFault of ['unreadable_manifest', 'unreadable_marker', 'sync_failure']) await t.test(ioFault, async t => {
    const attempt = await newAttempt();
    if (ioFault === 'sync_failure') {
      const result = await launch(t, { attemptId: attempt.attemptId, ioFault }).finish();
      assert.equal(result.submissions, 0); assert.equal(result.provider.mutations, 0); assert.notEqual(result.writeStatus, 'completed');
      assert.equal(result.guard.injectedFaults, 1); assert.equal((await fs.lstat(markerFile(attempt))).isFile(), true);
      await refusedRestart(t, attempt);
    } else {
      const markerBytes = Buffer.from('SIMULATED inaccessible marker fixture');
      if (ioFault === 'unreadable_marker') await fs.writeFile(markerFile(attempt), markerBytes, { flag: 'wx' });
      const result = await refusedRestart(t, attempt, 'SIMULATION_ATTEMPT_STATE_UNAVAILABLE', { ioFault });
      assert.equal(result.guard.injectedFaults, 1);
      if (ioFault === 'unreadable_marker') {
        assert.deepEqual(await fs.readFile(markerFile(attempt)), markerBytes);
        await refusedRestart(t, attempt);
      } else await absent(markerFile(attempt));
    }
  });
});

test('SIMULATED instrumentation blocks common outbound/DNS/credential-read APIs before I/O', { timeout: 20000 }, async t => {
  const result = await launch(t, { action: 'probe' }).finish();
  assert.equal(Object.keys(result.probes).length, 19);
  for (const [name, outcome] of Object.entries(result.probes)) assert.equal(outcome, 'SIMULATION_GUARD_DENIED', name);
  assert.equal(result.guard.denied.length, 19);
  assert.equal(result.guard.loopbackConnections, 0); assert.equal(result.guard.loopbackListens, 0);
  assert.equal(result.guard.attemptReads, 0); assert.equal(result.guard.sourceReads, 0);
});

after(() => {
  assert.equal(active.size, 0, 'All test children must have exited');
  const totals = new Map();
  for (const row of audit) if (row.attemptId) totals.set(row.attemptId, (totals.get(row.attemptId) || 0) + row.submissions);
  for (const count of totals.values()) assert.ok(count <= 1, 'At most one observed simulated submission per attempt');
  console.log('SIMULATED_PROCESS_AUDIT ' + JSON.stringify({ childCount: audit.length, activeChildren: active.size,
    attempts: [...totals].map(([attemptId, submissions]) => ({ attemptId, submissions })), processes: audit }));
});
