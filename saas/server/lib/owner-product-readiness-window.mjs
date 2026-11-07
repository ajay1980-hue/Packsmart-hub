import { performance } from 'node:perf_hooks';
import { OWNER_PRODUCT_READINESS_FLAG } from './owner-product-readiness.mjs';

export const OWNER_PRODUCT_READINESS_EXPIRY = 'RUNVARA_QUIET_OWNER_PRODUCT_READINESS_EXPIRES_AT';
const MAX_WINDOW_MS = 300000, MAX_READ_MS = 30000;
const unavailable = () => Object.assign(new Error('Saved product readiness is unavailable'), {
  status: 503, code: 'PRODUCT_READINESS_UNAVAILABLE'
});

// Fresh processes trust UTC at construction. Restarting never issues a new
// deadline. Within a process, observed clock rollback or expiry latches closed.
export function createOwnerProductReadinessWindow(env, {
  wallNow = () => Date.now(), monotonicNow = () => performance.now(),
  setTimer = setTimeout, clearTimer = clearTimeout
} = {}) {
  if (env[OWNER_PRODUCT_READINESS_FLAG] !== 'enabled/v1') return null;
  const expiresAt = env[OWNER_PRODUCT_READINESS_EXPIRY], until = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
  const startedWall = wallNow(), startedMono = monotonicNow();
  if (typeof expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt)
    || !Number.isFinite(until) || new Date(until).toISOString() !== expiresAt
    || !Number.isFinite(startedWall) || !Number.isFinite(startedMono) || until - startedWall > MAX_WINDOW_MS) {
    throw Object.assign(new Error('Product readiness requires an absolute UTC expiry within five minutes'), {
      code: 'QUIET_OWNER_PRODUCT_READINESS_INVALID'
    });
  }
  const duration = until - startedWall;
  let closed = duration <= 0, lastWall = startedWall, lastMono = startedMono;
  function remaining() {
    if (closed) return 0;
    const wall = wallNow(), mono = monotonicNow();
    if (!Number.isFinite(wall) || !Number.isFinite(mono) || wall < lastWall || mono < lastMono
      || wall >= until || mono - startedMono >= duration) closed = true;
    lastWall = wall; lastMono = mono;
    return closed ? 0 : Math.min(until - wall, duration - (mono - startedMono));
  }
  return Object.freeze({
    expiresAt,
    available: () => remaining() > 0,
    remainingMs: () => Math.floor(remaining()),
    beginRead() {
      const ms = Math.min(MAX_READ_MS, remaining());
      if (ms <= 0) throw unavailable();
      const controller = new AbortController(), readStart = monotonicNow();
      let rejectAbort, disposed = false;
      const aborted = new Promise((_, reject) => { rejectAbort = reject; });
      // The timer may fire between reads; retain rejection without an unhandled promise.
      aborted.catch(() => {});
      const cancel = () => {
        if (!controller.signal.aborted) { controller.abort(); rejectAbort(unavailable()); }
      };
      const timer = setTimer(cancel, Math.ceil(ms));
      timer?.unref?.();
      const assertActive = () => {
        if (disposed || controller.signal.aborted || remaining() <= 0 || monotonicNow() - readStart >= ms) {
          cancel(); throw unavailable();
        }
      };
      return Object.freeze({
        signal: controller.signal, cancel, assertActive,
        async run(operation) {
          assertActive();
          const result = await Promise.race([
            Promise.resolve().then(() => { assertActive(); return operation(controller.signal); }), aborted
          ]);
          assertActive();
          return result;
        },
        dispose() { disposed = true; clearTimer(timer); }
      });
    }
  });
}
