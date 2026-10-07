// Inactive preparation: no default transport, command-line probe or workflow hook.
// A future authorized CI adapter must enforce these options and AbortSignal.
export const PRODUCTION_HEALTH_URL = 'https://packsmart-ops.onrender.com/api/health';
export const HEALTH_VERIFIER_LIMITS = Object.freeze({ attempts: 3, bodyBytes: 16384,
  requestTimeoutMs: 5000, totalTimeoutMs: 20000, retryDelayMs: 5000,
  freshnessMs: 30000, futureToleranceMs: 5000, serverCacheMs: 5000 });
export const REQUIRED_HEALTH_CHECKS = Object.freeze([
  'persistence', 'primaryPersistence', 'stateSizeSafe', 'authentication', 'credentialEncryption'
]);

const verifierErrors = new WeakSet();
const fail = code => {
  const error = Object.assign(new Error(code), { code });
  verifierErrors.add(error);
  return error;
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function timestamp(value, code) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw fail(code);
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toISOString() !== value) throw fail(code);
  return parsed;
}
function bounded(value, maximum, code) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw fail(code);
  return value;
}
function clock(now) {
  let value;
  try { value = now(); } catch { throw fail('HEALTH_CLOCK_INVALID'); }
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) throw fail('HEALTH_CLOCK_INVALID');
  return value;
}
function cancel(body) {
  try { Promise.resolve(body?.cancel()).catch(() => {}); } catch {}
}
function abortable(task, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(task).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
function pause(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, HEALTH_VERIFIER_LIMITS.retryDelayMs);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

async function responseJson(response, signal, deadline, observeBytes) {
  let reader;
  try {
    if (!response || response.url !== PRODUCTION_HEALTH_URL || response.redirected !== false) throw fail('HEALTH_DESTINATION_INVALID');
    if (response.status !== 200 && response.status !== 503) throw fail('HEALTH_STATUS_INVALID');
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers?.get('content-type') || '')) throw fail('HEALTH_CONTENT_TYPE_INVALID');
    const encoding = response.headers.get('content-encoding');
    if (encoding !== null && encoding.toLowerCase() !== 'identity') throw fail('HEALTH_ENCODING_INVALID');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > HEALTH_VERIFIER_LIMITS.bodyBytes)) throw fail('HEALTH_BODY_TOO_LARGE');
    if (!response.body || typeof response.body.getReader !== 'function') throw fail('HEALTH_BODY_INVALID');
    reader = response.body.getReader();
    const chunks = []; let bytes = 0;
    while (true) {
      if (performance.now() >= deadline) throw fail('HEALTH_REQUEST_TIMEOUT');
      const part = await abortable(() => reader.read(), signal);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || !part.value.byteLength) throw fail('HEALTH_BODY_INVALID');
      if (bytes + part.value.byteLength > HEALTH_VERIFIER_LIMITS.bodyBytes) throw fail('HEALTH_BODY_TOO_LARGE');
      bytes += part.value.byteLength; observeBytes(part.value.byteLength); chunks.push(part.value);
    }
    if (!bytes || (length !== null && Number(length) !== bytes)) throw fail('HEALTH_BODY_INVALID');
    const body = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    try { return { payload: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)), bytes }; }
    catch { throw fail('HEALTH_JSON_INVALID'); }
  } finally {
    cancel(reader || response?.body);
    try { reader?.releaseLock(); } catch {}
  }
}

function qualify(payload, expectedCommit, deployedMs, nowMs) {
  if (!object(payload) || !object(payload.checks)) throw fail('HEALTH_SHAPE_INVALID');
  if (payload.commit !== expectedCommit) throw fail('HEALTH_COMMIT_MISMATCH');
  if (payload.storage !== 'supabase') throw fail('HEALTH_STORAGE_INVALID');
  if (typeof payload.ok !== 'boolean' || typeof payload.productionReady !== 'boolean' ||
      REQUIRED_HEALTH_CHECKS.some(key => typeof payload.checks[key] !== 'boolean')) throw fail('HEALTH_FLAGS_INVALID');
  const checkedMs = timestamp(payload.checkedAt, 'HEALTH_CHECKED_AT_INVALID');
  if (checkedMs <= deployedMs) throw fail('HEALTH_BEFORE_DEPLOYMENT');
  if (checkedMs > nowMs + HEALTH_VERIFIER_LIMITS.futureToleranceMs) throw fail('HEALTH_CHECK_FROM_FUTURE');
  if (nowMs - checkedMs > HEALTH_VERIFIER_LIMITS.freshnessMs) throw fail('HEALTH_CHECK_STALE');
  if (!Number.isSafeInteger(payload.checkCacheMaxAgeMs) || payload.checkCacheMaxAgeMs < 0 ||
      payload.checkCacheMaxAgeMs > HEALTH_VERIFIER_LIMITS.serverCacheMs) throw fail('HEALTH_CACHE_BOUND_INVALID');
  return payload.ok && payload.productionReady && REQUIRED_HEALTH_CHECKS.every(key => payload.checks[key] === true);
}

export async function verifyProductionHealth({ expectedCommit, deployedAt, destination = PRODUCTION_HEALTH_URL,
  transport, attempts = 1, requestTimeoutMs = HEALTH_VERIFIER_LIMITS.requestTimeoutMs,
  totalTimeoutMs = HEALTH_VERIFIER_LIMITS.totalTimeoutMs, now = Date.now } = {}) {
  // No global fetch fallback. Supplying an adapter does not constitute permission.
  if (typeof transport !== 'function') throw fail('HEALTH_TRANSPORT_NOT_ACTIVATED');
  if (destination !== PRODUCTION_HEALTH_URL) throw fail('HEALTH_DESTINATION_INVALID');
  if (typeof expectedCommit !== 'string' || !/^[a-f0-9]{40}$/.test(expectedCommit)) throw fail('HEALTH_EXPECTED_COMMIT_INVALID');
  const deployedMs = timestamp(deployedAt, 'HEALTH_DEPLOYMENT_TIME_INVALID');
  bounded(attempts, HEALTH_VERIFIER_LIMITS.attempts, 'HEALTH_ATTEMPT_LIMIT_INVALID');
  bounded(requestTimeoutMs, HEALTH_VERIFIER_LIMITS.requestTimeoutMs, 'HEALTH_TIMEOUT_INVALID');
  bounded(totalTimeoutMs, HEALTH_VERIFIER_LIMITS.totalTimeoutMs, 'HEALTH_TIMEOUT_INVALID');
  if (typeof now !== 'function' || deployedMs > clock(now) + HEALTH_VERIFIER_LIMITS.futureToleranceMs) throw fail('HEALTH_DEPLOYMENT_TIME_INVALID');
  const overall = new AbortController();
  const deadline = performance.now() + totalTimeoutMs;
  const overallTimer = setTimeout(() => overall.abort(fail('HEALTH_TOTAL_TIMEOUT')), totalTimeoutMs);
  let attempt = 0, acceptedBodyBytes = 0;
  try {
    for (attempt = 1; attempt <= attempts; attempt++) {
      if (overall.signal.aborted || performance.now() >= deadline) throw fail('HEALTH_TOTAL_TIMEOUT');
      const request = new AbortController();
      const requestDeadline = Math.min(deadline, performance.now() + requestTimeoutMs);
      const overallAbort = () => request.abort(overall.signal.reason);
      overall.signal.addEventListener('abort', overallAbort, { once: true });
      const requestTimer = setTimeout(() => request.abort(fail('HEALTH_REQUEST_TIMEOUT')), Math.min(requestTimeoutMs, Math.max(1, deadline - performance.now())));
      let unavailable = false;
      try {
        const result = await abortable(async () => {
          if (request.signal.aborted || performance.now() >= requestDeadline) throw fail('HEALTH_REQUEST_TIMEOUT');
          const response = await transport(PRODUCTION_HEALTH_URL, {
            method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
            signal: request.signal
          });
          if (request.signal.aborted) { cancel(response?.body); throw request.signal.reason; }
          const { payload, bytes } = await responseJson(response, request.signal, requestDeadline, size => { acceptedBodyBytes += size; });
          if (request.signal.aborted || performance.now() >= requestDeadline) throw fail('HEALTH_REQUEST_TIMEOUT');
          const nowMs = clock(now), healthy = qualify(payload, expectedCommit, deployedMs, nowMs);
          if (response.status === 503 && !healthy) return null;
          if (response.status !== 200) throw fail('HEALTH_STATUS_INVALID');
          if (!healthy) throw fail('HEALTH_FLAGS_NOT_READY');
          return { ok: true, productionReady: true, destination: PRODUCTION_HEALTH_URL, deployedAt,
            commit: payload.commit, storage: payload.storage, checkedAt: payload.checkedAt,
            verifiedAt: new Date(nowMs).toISOString(), checks: Object.fromEntries(REQUIRED_HEALTH_CHECKS.map(key => [key, true])),
            attempts: attempt, responseBytes: bytes, acceptedBodyBytes };
        }, request.signal);
        if (request.signal.aborted || performance.now() >= requestDeadline) throw fail('HEALTH_REQUEST_TIMEOUT');
        if (result) {
          if (overall.signal.aborted || performance.now() >= deadline) throw fail('HEALTH_TOTAL_TIMEOUT');
          return result;
        }
        unavailable = true;
      } catch (error) {
        request.abort(error);
        throw error;
      } finally {
        clearTimeout(requestTimer); overall.signal.removeEventListener('abort', overallAbort);
      }
      if (unavailable && attempt === attempts) throw fail('HEALTH_UNAVAILABLE');
      await pause(overall.signal);
    }
  } catch (error) {
    // Only fixed verifier codes leave this boundary; transport errors may contain secrets.
    const safe = verifierErrors.has(error) ? fail(error.code) : fail('HEALTH_TRANSPORT_FAILED');
    safe.attempts = Math.min(attempt, attempts); safe.acceptedBodyBytes = acceptedBodyBytes;
    throw safe;
  } finally { clearTimeout(overallTimer); }
}
