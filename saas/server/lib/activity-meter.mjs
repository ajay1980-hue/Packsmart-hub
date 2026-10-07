/** Bounded, process-local observations of instrumented activity, never a billing ledger. */
import { randomUUID } from 'node:crypto';

export const ACTIVITY_OPERATIONS = Object.freeze([
  'identity_read', 'state_read', 'state_commit', 'reporting_commit',
  'provider_usage_read', 'provider_usage_reserve', 'provider_usage_settle',
  'job_read', 'job_enqueue', 'job_finish', 'job_retry', 'job_claim', 'usage_read',
  'archive_write', 'archive_read', 'reporting_write', 'other',
]);
export const ACTIVITY_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE']);
export const ACTIVITY_RETRY_KINDS = Object.freeze([
  'upsert_network', 'primary_statement_cancelled', 'primary_network_reconciled',
  'reporting_statement_cancelled', 'reporting_network_reconciled',
]);
export const ACTIVITY_OUTCOMES = Object.freeze([
  'succeeded', 'http_error', 'network_error', 'invalid_response', 'oversized_response',
]);
export const ACTIVITY_JOB_EVENTS = Object.freeze(['succeeded', 'blocked', 'dead_letter', 'rescheduled', 'manual_retry']);
const HOT_KINDS = Object.freeze({ attempted: 'attempted', confirmed: 'confirmed', integrity_read: 'integrityRead' });
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const WINDOW_MS = 5 * 60 * 1000;
const MAX_TENANTS = 64;
const MAX_INFLIGHT = 128;
const MAX_COUNT = Number.MAX_SAFE_INTEGER;
const MAX_TIME = 8_640_000_000_000_000;

const validBytes = value => Number.isSafeInteger(value) && value >= 0;
const validWorkspace = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value);
const entries = keys => Object.fromEntries(keys.map(key => [key, 0]));
const bodyCounter = () => ({ bytes: 0, knownObservations: 0, unknownObservations: 0, bytesOverflowed: false });
const hotCounter = () => ({ bytes: null, previousBytes: null, deltaBytes: null, observedAt: null, observations: 0 });
const windowCounter = start => ({ start, completed: 0, failed: 0, retried: 0, complete: true });
const iso = milliseconds => new Date(milliseconds).toISOString();

function makeRecord(at) {
  return {
    observedSince: at,
    omittedObservations: 0,
    invalidObservations: 0,
    inflightOverflow: 0,
    counterOverflow: false,
    clockReliable: true,
    db: {
      attempted: 0, completed: 0, inflight: 0, succeeded: 0, failed: 0,
      outcomes: entries(ACTIVITY_OUTCOMES), operations: entries(ACTIVITY_OPERATIONS),
      methods: entries(ACTIVITY_METHODS), retries: entries(ACTIVITY_RETRY_KINDS),
      requestBody: bodyCounter(), responseBody: bodyCounter(),
    },
    hotState: { attempted: hotCounter(), confirmed: hotCounter(), integrityRead: hotCounter() },
    jobs: entries(ACTIVITY_JOB_EVENTS),
    currentWindow: windowCounter(at),
    lastWindow: null,
  };
}

function add(record, target, key, amount = 1) {
  if (amount > MAX_COUNT - target[key]) {
    target[key] = MAX_COUNT;
    if (key === 'bytes') target.bytesOverflowed = true;
    record.counterOverflow = true;
    record.currentWindow.complete = false;
  } else target[key] += amount;
}

function omit(record, invalid = false) {
  add(record, record, 'omittedObservations');
  if (invalid) add(record, record, 'invalidObservations');
  record.currentWindow.complete = false;
}

function bodyObservation(record, target, bytes) {
  if (validBytes(bytes)) {
    add(record, target, 'bytes', bytes);
    add(record, target, 'knownObservations');
  } else {
    add(record, target, 'unknownObservations');
    // null/undefined are explicitly unknown; malformed sizes also lose coverage.
    if (bytes !== null && bytes !== undefined) omit(record, true);
  }
}

function advance(record, at) {
  const elapsed = at - record.currentWindow.start;
  if (elapsed < WINDOW_MS) return;
  if (record.db.inflight > 0) record.currentWindow.complete = false;
  const windows = Math.floor(elapsed / WINDOW_MS);
  record.lastWindow = windows === 1
    ? record.currentWindow
    : windowCounter(record.currentWindow.start + (windows - 1) * WINDOW_MS);
  record.currentWindow = windowCounter(record.currentWindow.start + windows * WINDOW_MS);
}

function bytesSnapshot(value, available) {
  return {
    bytes: available && value.knownObservations && !value.bytesOverflowed ? value.bytes : null,
    knownObservations: available ? value.knownObservations : null,
    unknownObservations: available ? value.unknownObservations : null,
  };
}

function dbSnapshot(record, available, includeGlobal = false) {
  const db = record.db;
  return {
    ...Object.fromEntries(['attempted', 'completed', 'inflight', 'succeeded', 'failed'].map(key => [key,
      available && (key !== 'inflight' || record.inflightOverflow === 0) ? db[key] : null])),
    outcomes: Object.fromEntries(ACTIVITY_OUTCOMES.map(key => [key, available ? db.outcomes[key] : null])),
    operations: Object.fromEntries(ACTIVITY_OPERATIONS.filter(key => includeGlobal || key !== 'job_claim').map(key => [key, available ? db.operations[key] : null])),
    methods: Object.fromEntries(ACTIVITY_METHODS.map(key => [key, available ? db.methods[key] : null])),
    retries: Object.fromEntries(ACTIVITY_RETRY_KINDS.map(key => [key, available ? db.retries[key] : null])),
    requestBody: bytesSnapshot(db.requestBody, available),
    responseBody: bytesSnapshot(db.responseBody, available),
  };
}

/**
 * IDs must come from a trusted store context. Tokens contain no caller-visible
 * attribution and can only complete their original observation once.
 * No records are evicted: once the tenant cap is reached, new tenants remain
 * explicitly unobserved. At most two five-minute windows per record are kept.
 */
export function createActivityMeter({ now = Date.now, instanceId, dbAvailable = true, maxTenants = MAX_TENANTS } = {}) {
  if (typeof now !== 'function') throw new TypeError('ACTIVITY_CLOCK_INVALID');
  if (!Number.isSafeInteger(maxTenants) || maxTenants < 1 || maxTenants > MAX_TENANTS) throw new TypeError('ACTIVITY_TENANT_LIMIT_INVALID');
  if (typeof dbAvailable !== 'boolean') throw new TypeError('ACTIVITY_AVAILABILITY_INVALID');
  if (instanceId !== undefined && (typeof instanceId !== 'string' || !ID.test(instanceId))) throw new TypeError('ACTIVITY_INSTANCE_INVALID');
  const tenants = new Map();
  const inflight = new Map();
  let lastNow = null;
  let clockReliable = true;
  const readTime = () => {
    let at;
    try { at = now(); } catch { at = null; }
    if (!Number.isSafeInteger(at) || at < 0 || at > MAX_TIME || (lastNow !== null && at < lastNow)) {
      clockReliable = false;
      return lastNow ?? 0;
    }
    lastNow = at;
    return at;
  };
  const startedAt = readTime();
  const id = instanceId ?? `activity-${randomUUID()}`;
  const totals = makeRecord(startedAt);
  const unattributed = makeRecord(startedAt);
  let tenantCapacityOmissions = 0;

  function time() {
    const at = readTime();
    for (const record of [totals, unattributed, ...tenants.values()]) {
      advance(record, at);
      if (!clockReliable) {
        record.clockReliable = false;
        record.currentWindow.complete = false;
      }
    }
    return at;
  }

  function getRecord(workspaceId, at) {
    if (workspaceId === null) return unattributed;
    if (!validWorkspace(workspaceId)) {
      omit(totals, true);
      return null;
    }
    const existing = tenants.get(workspaceId);
    if (existing) return existing;
    if (tenants.size >= maxTenants) {
      tenantCapacityOmissions = Math.min(MAX_COUNT, tenantCapacityOmissions + 1);
      omit(totals);
      return null;
    }
    const record = makeRecord(at);
    record.clockReliable = clockReliable;
    tenants.set(workspaceId, record);
    return record;
  }

  function beginDbAttempt({ workspaceId = null, operation, method, requestBodyBytes = null, retryKind = null } = {}) {
    const at = time();
    // A global claim cannot be safely attributed to its eventual returned row.
    const record = getRecord(operation === 'job_claim' ? null : workspaceId, at);
    if (!record) return null;
    if (!dbAvailable || !ACTIVITY_OPERATIONS.includes(operation) || !ACTIVITY_METHODS.includes(method)
      || (retryKind !== null && !ACTIVITY_RETRY_KINDS.includes(retryKind))) {
      omit(record, dbAvailable);
      omit(totals, dbAvailable);
      return null;
    }
    for (const target of [record, totals]) {
      add(target, target.db, 'attempted');
      add(target, target.db.operations, operation);
      add(target, target.db.methods, method);
      if (retryKind !== null) add(target, target.db.retries, retryKind);
      bodyObservation(target, target.db.requestBody, requestBodyBytes);
    }
    if (inflight.size >= MAX_INFLIGHT) {
      for (const target of [record, totals]) {
        add(target, target, 'inflightOverflow');
        omit(target);
      }
      return null;
    }
    const token = Object.freeze(Object.create(null));
    inflight.set(token, { record, retryKind });
    for (const target of [record, totals]) add(target, target.db, 'inflight');
    return token;
  }

  function finishDbAttempt(token, { outcome, responseBodyBytes = null } = {}) {
    time();
    const pending = inflight.get(token);
    if (!pending) {
      omit(totals, true);
      return false;
    }
    inflight.delete(token);
    const { record, retryKind } = pending;
    for (const target of [record, totals]) {
      target.db.inflight -= 1;
      if (!ACTIVITY_OUTCOMES.includes(outcome)) {
        omit(target, true);
        continue;
      }
      add(target, target.db, 'completed');
      add(target, target.db.outcomes, outcome);
      add(target, target.db, outcome === 'succeeded' ? 'succeeded' : 'failed');
      bodyObservation(target, target.db.responseBody, responseBodyBytes);
      add(target, target.currentWindow, 'completed');
      if (outcome !== 'succeeded') add(target, target.currentWindow, 'failed');
      if (retryKind !== null) add(target, target.currentWindow, 'retried');
    }
    return ACTIVITY_OUTCOMES.includes(outcome);
  }

  function observeHotState(workspaceId, { bytes, kind } = {}) {
    const at = time();
    const record = getRecord(workspaceId, at);
    if (!record) return false;
    if (!Object.hasOwn(HOT_KINDS, kind) || !validBytes(bytes)) {
      omit(record, true);
      omit(totals, true);
      return false;
    }
    const target = record.hotState[HOT_KINDS[kind]];
    target.previousBytes = target.bytes;
    target.deltaBytes = target.bytes === null ? null : bytes - target.bytes;
    target.bytes = bytes;
    target.observedAt = iso(at);
    add(record, target, 'observations');
    return true;
  }

  function observeJob(workspaceId, event) {
    const record = getRecord(workspaceId, time());
    if (!record) return false;
    if (!ACTIVITY_JOB_EVENTS.includes(event)) {
      omit(record, true);
      omit(totals, true);
      return false;
    }
    for (const target of [record, totals]) add(target, target.jobs, event);
    return true;
  }

  function serializeRecord(record, workspaceId, at, exists = true) {
    const available = exists && dbAvailable;
    const partial = record.omittedObservations > 0 || record.counterOverflow || !record.clockReliable;
    const last = record.lastWindow;
    const rateEligible = available && last !== null && last.complete && record.currentWindow.complete && record.clockReliable
      && !record.counterOverflow && record.inflightOverflow === 0 && record.db.inflight === 0 && last.completed >= 10;
    const rateWindow = {
      durationMs: WINDOW_MS,
      startedAt: last ? iso(last.start) : null,
      endedAt: last ? iso(last.start + WINDOW_MS) : null,
      completed: available && last ? last.completed : null,
      failed: available && last ? last.failed : null,
      retried: available && last ? last.retried : null,
      eligible: rateEligible,
      reason: !available ? (dbAvailable ? 'not_observed' : 'database_unavailable')
        : !record.clockReliable ? 'clock_unreliable'
          : record.counterOverflow ? 'counter_overflow'
            : record.inflightOverflow > 0 ? 'inflight_token_overflow'
            : !last ? 'awaiting_complete_window'
              : !last.complete || !record.currentWindow.complete ? 'incomplete_observations'
                : record.db.inflight > 0 ? 'pending_completions'
                  : last.completed < 10 ? 'insufficient_completions' : 'complete_window',
    };
    const anomalies = [];
    for (const kind of ['attempted', 'confirmed', 'integrityRead']) {
      const hot = record.hotState[kind];
      if (hot.bytes !== null && hot.bytes >= 1.5 * 1024 * 1024) {
        anomalies.push({ code: hot.bytes >= 2 * 1024 * 1024 ? 'hot_state_limit_exceeded' : 'hot_state_near_limit',
          severity: hot.bytes >= 2 * 1024 * 1024 ? 'error' : 'warning', kind, bytes: hot.bytes,
          limitBytes: 2 * 1024 * 1024, observedAt: hot.observedAt });
      }
    }
    if (rateEligible && last.failed >= 5 && last.failed / last.completed >= 0.5) {
      anomalies.push({ code: 'db_failure_burst', severity: 'warning', completed: last.completed, failed: last.failed,
        thresholdRate: 0.5, windowStartedAt: rateWindow.startedAt, windowEndedAt: rateWindow.endedAt });
    }
    if (rateEligible && last.retried >= 5 && last.retried / last.completed >= 0.5) {
      anomalies.push({ code: 'db_retry_burst', severity: 'warning', completed: last.completed, retried: last.retried,
        thresholdRate: 0.5, windowStartedAt: rateWindow.startedAt, windowEndedAt: rateWindow.endedAt });
    }
    return {
      schema: 'runvara-activity/v1', workspaceId, instanceId: id,
      instanceStartedAt: iso(startedAt),
      observedSince: exists ? iso(record.observedSince) : null,
      snapshotAt: iso(at),
      coverage: {
        scope: 'process_local_instrumented', status: !exists ? 'not_observed' : !dbAvailable ? 'unavailable' : partial ? 'partial' : 'observed',
        dbAvailable, resetOnRestart: true, persistence: false, evicted: false,
        omittedObservations: exists ? record.omittedObservations : null,
        invalidObservations: exists ? record.invalidObservations : null,
        inflightOverflow: exists ? record.inflightOverflow : null,
        inflightReason: !exists ? 'not_observed' : !dbAvailable ? 'database_unavailable'
          : record.inflightOverflow > 0 ? 'inflight_token_overflow' : 'complete_observations',
        counterOverflow: exists ? record.counterOverflow : null,
        counterSemantics: record.counterOverflow ? 'lower_bounds_after_overflow' : 'exact_recorded_observations',
        clockReliable: exists ? record.clockReliable : null,
        byteSemantics: 'application_body_bytes_only',
        excludes: ['uninstrumented_activity', 'other_processes', 'network_overhead', 'database_storage', 'provider_billing'],
      },
      db: dbSnapshot(record, available, workspaceId === null),
      hotState: Object.fromEntries(Object.entries(record.hotState).map(([key, value]) => [key, {
        ...value, observations: exists ? value.observations : null,
      }])),
      jobs: Object.fromEntries(ACTIVITY_JOB_EVENTS.map(event => [event, exists ? record.jobs[event] : null])),
      rateWindow, anomalies,
    };
  }

  function snapshot(workspaceId) {
    if (!validWorkspace(workspaceId)) throw new TypeError('ACTIVITY_WORKSPACE_INVALID');
    const at = time();
    const record = tenants.get(workspaceId);
    return serializeRecord(record ?? makeRecord(at), workspaceId, at, Boolean(record));
  }

  function instanceSnapshot() {
    const at = time();
    return {
      instanceId: id, observedSince: iso(startedAt), snapshotAt: iso(at),
      limits: { maxTenants, maxInflight: MAX_INFLIGHT, windowsPerRecord: 2 },
      trackedTenants: tenants.size, inflightTokens: inflight.size, tenantCapacityOmissions,
      totals: serializeRecord(totals, null, at),
      unattributed: serializeRecord(unattributed, null, at),
    };
  }

  // Diagnostics must never turn a malformed observation into a store failure.
  // The fixed fallback also prevents arbitrary error text entering the meter.
  function safelyObserve(callback, fallback) {
    return (...args) => {
      try { return callback(...args); } catch {
        omit(totals, true);
        return fallback;
      }
    };
  }

  return Object.freeze({
    beginDbAttempt: safelyObserve(beginDbAttempt, null),
    finishDbAttempt: safelyObserve(finishDbAttempt, false),
    observeHotState: safelyObserve(observeHotState, false),
    observeJob: safelyObserve(observeJob, false),
    snapshot, instanceSnapshot,
  });
}
