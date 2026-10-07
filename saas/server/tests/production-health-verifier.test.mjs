// Synthetic responses only. There is deliberately no real production transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyProductionHealth, PRODUCTION_HEALTH_URL, HEALTH_VERIFIER_LIMITS,
  REQUIRED_HEALTH_CHECKS } from '../lib/production-health-verifier.mjs';

const NOW = Date.parse('2026-10-07T12:00:10.000Z');
const COMMIT = 'd32da62d0e7935597638266d44d88ae5e066d51f';
const DEPLOYED = '2026-10-07T12:00:00.000Z';
const healthy = () => ({ ok: true, productionReady: true, commit: COMMIT, storage: 'supabase',
  checkedAt: '2026-10-07T12:00:09.000Z', checkCacheMaxAgeMs: 5000,
  checks: { ...Object.fromEntries(REQUIRED_HEALTH_CHECKS.map(key => [key, true])), billingCharging: false },
  persistence: { detail: 'PRIVATE_DIAGNOSTIC_NOT_RETURNED' } });
const config = extra => ({ expectedCommit: COMMIT, deployedAt: DEPLOYED, now: () => NOW, ...extra });
function response(body = JSON.stringify(healthy()), { status = 200, headers, url = PRODUCTION_HEALTH_URL, redirected = false } = {}) {
  const value = new Response(body, { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
  Object.defineProperties(value, { url: { value: url }, redirected: { value: redirected } });
  return value;
}
async function rejectsFixture(payload, code, options = {}) {
  let requests = 0;
  await assert.rejects(verifyProductionHealth(config({ attempts: 3,
    transport: async () => { requests++; return response(typeof payload === 'string' ? payload : JSON.stringify(payload), options); }
  })), { code });
  assert.equal(requests, 1, 'invalid health never triggers a retry');
}

test('verifier is inactive without an explicit adapter and never falls back to global fetch', async t => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error('no network allowed'); };
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(verifyProductionHealth(config()), { code: 'HEALTH_TRANSPORT_NOT_ACTIVATED' });
  assert.equal(calls, 0);
});

test('fixed anonymous GET produces only bounded exact-commit evidence; billing charging need not be enabled', async () => {
  let calls = 0;
  const result = await verifyProductionHealth(config({ transport: async (url, options) => {
    calls++; assert.equal(url, PRODUCTION_HEALTH_URL);
    assert.deepEqual(Object.keys(options).sort(), ['cache', 'credentials', 'method', 'redirect', 'signal']);
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    assert.equal(options.signal.aborted, false);
    return response();
  } }));
  assert.equal(calls, 1); assert.equal(result.ok, true); assert.equal(result.productionReady, true);
  assert.equal(result.commit, COMMIT); assert.equal(result.deployedAt, DEPLOYED);
  assert.equal(result.checkedAt, healthy().checkedAt); assert.equal(result.verifiedAt, new Date(NOW).toISOString());
  assert.equal(result.attempts, 1); assert.equal(result.responseBytes, Buffer.byteLength(JSON.stringify(healthy())));
  assert.equal(result.acceptedBodyBytes, result.responseBytes);
  assert.deepEqual(result.checks, Object.fromEntries(REQUIRED_HEALTH_CHECKS.map(key => [key, true])));
  assert.equal(JSON.stringify(result).includes('PRIVATE_DIAGNOSTIC'), false);
});

for (const destination of [
  'http://packsmart-ops.onrender.com/api/health', 'https://packsmart-ops.onrender.com:443/api/health',
  'https://packsmart-ops.onrender.com/api/health?x=1', 'https://packsmart-ops.onrender.com/api/health#x',
  'https://user:password@packsmart-ops.onrender.com/api/health', 'https://packsmart-ops.onrender.com/api/health/',
  'https://packsmart-ops.onrender.com.evil.test/api/health', 'https://evil.test/api/health',
  'https://127.0.0.1/api/health', 'https://PACKSMART-OPS.onrender.com/api/health', new URL(PRODUCTION_HEALTH_URL)
]) test(`reject destination variant before transport: ${String(destination).replace('user:password@', '[credentials]@')}`, async () => {
  let calls = 0;
  await assert.rejects(verifyProductionHealth(config({ destination, transport: async () => { calls++; } })), { code: 'HEALTH_DESTINATION_INVALID' });
  assert.equal(calls, 0);
});

test('invalid commit, deployment time, clock or expanded limits fail before any transport', async () => {
  for (const patch of [
    { expectedCommit: COMMIT.slice(0, 7) }, { expectedCommit: COMMIT.toUpperCase() }, { expectedCommit: null },
    { deployedAt: '2026-02-30T12:00:00.000Z' }, { deployedAt: '2026-10-07' }, { deployedAt: null },
    { deployedAt: '2026-10-07T12:00:16.000Z' }, { now: () => NaN }, { now: () => { throw new Error('PRIVATE_CLOCK'); } }, { now: null },
    { attempts: 0 }, { attempts: 4 }, { attempts: 1.5 }, { attempts: '1' },
    { requestTimeoutMs: 0 }, { requestTimeoutMs: 5001 }, { totalTimeoutMs: 20001 }, { totalTimeoutMs: Infinity }
  ]) {
    let calls = 0;
    await assert.rejects(verifyProductionHealth(config({ ...patch, transport: async () => { calls++; } })), error => error.code.startsWith('HEALTH_'));
    assert.equal(calls, 0);
  }
});

test('every required boolean is literal true; absent, null, coerced and false values cannot pass', async () => {
  for (const key of ['ok', 'productionReady', ...REQUIRED_HEALTH_CHECKS]) {
    for (const value of [undefined, null, 'true', 1, false]) {
      const payload = healthy(), target = REQUIRED_HEALTH_CHECKS.includes(key) ? payload.checks : payload;
      if (value === undefined) delete target[key]; else target[key] = value;
      await rejectsFixture(payload, value === false ? 'HEALTH_FLAGS_NOT_READY' : 'HEALTH_FLAGS_INVALID');
    }
  }
  for (const checks of [null, [], 'healthy']) await rejectsFixture({ ...healthy(), checks }, 'HEALTH_SHAPE_INVALID');
});

test('foreign revision/storage, old samples and impossible times fail closed', async () => {
  await rejectsFixture({ ...healthy(), commit: 'a'.repeat(40) }, 'HEALTH_COMMIT_MISMATCH');
  await rejectsFixture({ ...healthy(), commit: COMMIT.slice(0, 7) }, 'HEALTH_COMMIT_MISMATCH');
  await rejectsFixture({ ...healthy(), storage: 'file' }, 'HEALTH_STORAGE_INVALID');
  for (const checkedAt of [DEPLOYED, '2026-10-07T11:59:59.999Z'])
    await rejectsFixture({ ...healthy(), checkedAt }, 'HEALTH_BEFORE_DEPLOYMENT');
  for (const checkedAt of [null, 0, 'yesterday', '2026-02-30T00:00:00.000Z', '2026-10-07T12:00:09Z', '2026-10-07T12:00:09.000+00:00'])
    await rejectsFixture({ ...healthy(), checkedAt }, 'HEALTH_CHECKED_AT_INVALID');
  await rejectsFixture({ ...healthy(), checkedAt: '2026-10-07T12:00:15.001Z' }, 'HEALTH_CHECK_FROM_FUTURE');
  await assert.rejects(verifyProductionHealth(config({ now: () => NOW + 30001,
    transport: async () => response() })), { code: 'HEALTH_CHECK_STALE' });
  for (const checkCacheMaxAgeMs of [null, '5000', -1, 5001])
    await rejectsFixture({ ...healthy(), checkCacheMaxAgeMs }, 'HEALTH_CACHE_BOUND_INVALID');
});

test('freshness has explicit inclusive age/future bounds while deployment ordering is strict', async () => {
  for (const checkedMs of [NOW - 30000, NOW + 5000]) {
    const result = await verifyProductionHealth(config({ deployedAt: '2026-10-07T11:59:00.000Z',
      transport: async () => response(JSON.stringify({ ...healthy(), checkedAt: new Date(checkedMs).toISOString() })) }));
    assert.equal(result.ok, true);
  }
});

test('response redirects, foreign final URL, non-JSON and unexpected status never retry', async () => {
  await rejectsFixture(healthy(), 'HEALTH_DESTINATION_INVALID', { redirected: true });
  await rejectsFixture(healthy(), 'HEALTH_DESTINATION_INVALID', { url: 'https://foreign.test/api/health' });
  for (const status of [201, 202, 301, 302, 307, 308, 401, 429, 500])
    await rejectsFixture(healthy(), 'HEALTH_STATUS_INVALID', { status });
  for (const type of ['text/html', 'text/plain', 'application/jsonp', 'application/json; charset=latin1'])
    await rejectsFixture(healthy(), 'HEALTH_CONTENT_TYPE_INVALID', { headers: { 'Content-Type': type } });
  await rejectsFixture(healthy(), 'HEALTH_ENCODING_INVALID', { headers: { 'Content-Encoding': 'gzip' } });
});

test('malformed JSON, UTF-8, empty/mismatched bodies and oversized streams cannot pass', async () => {
  await rejectsFixture('{"ok":', 'HEALTH_JSON_INVALID');
  for (const payload of ['null', '[]', 'true']) await rejectsFixture(payload, 'HEALTH_SHAPE_INVALID');
  await rejectsFixture('', 'HEALTH_BODY_INVALID');
  await rejectsFixture(healthy(), 'HEALTH_BODY_INVALID', { headers: { 'Content-Length': '1' } });
  await rejectsFixture(healthy(), 'HEALTH_BODY_TOO_LARGE', { headers: { 'Content-Length': '16385' } });
  await assert.rejects(verifyProductionHealth(config({ transport: async () => response(new Uint8Array([0xc3, 0x28])) })), { code: 'HEALTH_JSON_INVALID' });
  const raw = JSON.stringify(healthy()), atLimit = raw.padEnd(HEALTH_VERIFIER_LIMITS.bodyBytes, ' ');
  assert.equal((await verifyProductionHealth(config({ transport: async () => response(atLimit) }))).responseBytes, 16384);
  await rejectsFixture(atLimit + ' ', 'HEALTH_BODY_TOO_LARGE');
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8000)); controller.enqueue(new Uint8Array(9000)); }, cancel() { cancelled = true; } });
  await assert.rejects(verifyProductionHealth(config({ transport: async () => response(stream) })), { code: 'HEALTH_BODY_TOO_LARGE', acceptedBodyBytes: 8000 });
  assert.equal(cancelled, true);
});

test('transport errors never expose untrusted messages or spoofed verifier codes and never retry', async () => {
  let calls = 0;
  await assert.rejects(verifyProductionHealth(config({ attempts: 3, transport: async () => {
    calls++; throw Object.assign(new Error('credential=PRIVATE'), { code: 'HEALTH_PRIVATE_TOKEN' });
  } })), error => error.code === 'HEALTH_TRANSPORT_FAILED' && !JSON.stringify(error).includes('PRIVATE') && error.attempts === 1);
  assert.equal(calls, 1);
});

test('transport ignoring abort cannot hang or trigger overlapping retries; late response is cancelled', async () => {
  let finish, signal, calls = 0, cancelled = false;
  const started = performance.now();
  await assert.rejects(verifyProductionHealth(config({ attempts: 3, requestTimeoutMs: 30, totalTimeoutMs: 150,
    transport: async (_url, options) => { calls++; signal = options.signal; return new Promise(resolve => { finish = resolve; }); }
  })), { code: 'HEALTH_REQUEST_TIMEOUT', attempts: 1 });
  assert.ok(performance.now() - started < 2000); assert.equal(calls, 1); assert.equal(signal.aborted, true);
  finish(response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, true);
});

test('never-settling body read and cancellation remain bounded by the request deadline', async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull: () => new Promise(() => {}), cancel() { cancelled = true; return new Promise(() => {}); } });
  const started = performance.now();
  await assert.rejects(verifyProductionHealth(config({ requestTimeoutMs: 30, totalTimeoutMs: 150, transport: async () => response(body) })), { code: 'HEALTH_REQUEST_TIMEOUT' });
  assert.equal(cancelled, true); assert.ok(performance.now() - started < 2000);
});

test('monotonic deadline rejects a late final read even before a timeout callback can run', async () => {
  let reads = 0, signal, cancelled = false;
  const body = { getReader: () => ({
    async read() {
      if (reads++ === 0) return { done: false, value: new TextEncoder().encode(JSON.stringify(healthy())) };
      // A synchronous dependency can delay timers; a timestamp check must still
      // reject its result rather than accepting healthy data after the deadline.
      const until = performance.now() + 40;
      while (performance.now() < until) {}
      return { done: true };
    }, cancel() { cancelled = true; }, releaseLock() {}
  }) };
  await assert.rejects(verifyProductionHealth(config({ requestTimeoutMs: 20, totalTimeoutMs: 150,
    transport: async (_url, options) => { signal = options.signal; return {
      url: PRODUCTION_HEALTH_URL, redirected: false, status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }), body
    }; }
  })), { code: 'HEALTH_REQUEST_TIMEOUT' });
  assert.equal(signal.aborted, true); assert.equal(cancelled, true);
});

test('qualification cannot return success after the per-request deadline if an injected clock stalls', async () => {
  let clockCalls = 0, signal;
  await assert.rejects(verifyProductionHealth(config({ requestTimeoutMs: 20, totalTimeoutMs: 150,
    now: () => {
      if (++clockCalls === 2) {
        const until = performance.now() + 40;
        while (performance.now() < until) {}
      }
      return NOW;
    }, transport: async (_url, options) => { signal = options.signal; return response(); }
  })), { code: 'HEALTH_REQUEST_TIMEOUT' });
  assert.equal(signal.aborted, true);
});

test('total wall deadline bounds a stuck transport even when its request timeout is longer', async () => {
  const started = performance.now(); let signal;
  await assert.rejects(verifyProductionHealth(config({ requestTimeoutMs: 5000, totalTimeoutMs: 30,
    transport: async (_url, options) => { signal = options.signal; return new Promise(() => {}); }
  })), error => ['HEALTH_TOTAL_TIMEOUT', 'HEALTH_REQUEST_TIMEOUT'].includes(error.code));
  assert.ok(performance.now() - started < 2000); assert.equal(signal.aborted, true);
});

test('total wall budget includes retry delay and forbids another request after expiration', async () => {
  let calls = 0;
  const unavailable = { ...healthy(), ok: false, productionReady: false };
  await assert.rejects(verifyProductionHealth(config({ attempts: 3, totalTimeoutMs: 50,
    transport: async () => { calls++; return response(JSON.stringify(unavailable), { status: 503 }); }
  })), { code: 'HEALTH_TOTAL_TIMEOUT', attempts: 1 });
  assert.equal(calls, 1);
});

test('only fresh same-revision well-formed 503 may retry, at most three spaced GETs', async () => {
  const starts = [], unavailable = { ...healthy(), ok: false, productionReady: false };
  const bytes = Buffer.byteLength(JSON.stringify(unavailable));
  await assert.rejects(verifyProductionHealth(config({ attempts: 3, transport: async () => {
    starts.push(performance.now()); return response(JSON.stringify(unavailable), { status: 503 });
  } })), { code: 'HEALTH_UNAVAILABLE', attempts: 3, acceptedBodyBytes: 3 * bytes });
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 4900 && starts[2] - starts[1] >= 4900);
  await rejectsFixture({ ...unavailable, commit: 'f'.repeat(40) }, 'HEALTH_COMMIT_MISMATCH', { status: 503 });
  await rejectsFixture('{', 'HEALTH_JSON_INVALID', { status: 503 });
  await rejectsFixture(healthy(), 'HEALTH_STATUS_INVALID', { status: 503 });
});

test('a successful retry qualifies its own fresh body and reports the complete invocation budget', async () => {
  let calls = 0;
  const unavailable = { ...healthy(), ok: false, productionReady: false };
  const result = await verifyProductionHealth(config({ attempts: 3, transport: async () => {
    calls++; return calls === 1 ? response(JSON.stringify(unavailable), { status: 503 }) : response();
  } }));
  assert.equal(calls, 2); assert.equal(result.attempts, 2); assert.equal(result.ok, true);
  assert.equal(result.acceptedBodyBytes, Buffer.byteLength(JSON.stringify(unavailable)) + Buffer.byteLength(JSON.stringify(healthy())));
});
