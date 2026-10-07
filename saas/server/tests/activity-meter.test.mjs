import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityMeter, ACTIVITY_OPERATIONS, ACTIVITY_METHODS, ACTIVITY_RETRY_KINDS,
  ACTIVITY_JOB_EVENTS, ACTIVITY_OUTCOMES } from '../lib/activity-meter.mjs';

const EPOCH = Date.parse('2026-10-06T00:00:00.000Z');
function fixture(options = {}) {
  let at = EPOCH;
  const meter = createActivityMeter({ now: () => at, instanceId: 'process-one', ...options });
  return { meter, setTime: value => { at = value; }, advance: milliseconds => { at += milliseconds; } };
}
function request(meter, workspaceId = 'alpha', options = {}) {
  return meter.beginDbAttempt({ workspaceId, operation: 'state_read', method: 'GET', requestBodyBytes: 0, ...options });
}
function complete(meter, token, options = {}) {
  return meter.finishDbAttempt(token, { outcome: 'succeeded', responseBodyBytes: 0, ...options });
}
function batch(meter, amount, { failures = 0, retries = 0 } = {}) {
  for (let i = 0; i < amount; i++) complete(meter, request(meter, 'alpha', {
    retryKind: i < retries ? 'upsert_network' : null,
  }), { outcome: i < failures ? 'http_error' : 'succeeded' });
}

// These snapshots describe what this process observed, not complete provider usage.
test('unobserved and unavailable database counts remain unknown, while observed zero is exact', () => {
  const { meter } = fixture();
  const unknown = meter.snapshot('alpha');
  assert.equal(unknown.schema, 'runvara-activity/v1');
  assert.equal(unknown.workspaceId, 'alpha');
  assert.equal(unknown.instanceId, 'process-one');
  assert.equal(unknown.observedSince, null);
  assert.equal(unknown.coverage.status, 'not_observed');
  assert.equal(unknown.db.attempted, null);
  assert.equal(unknown.db.requestBody.bytes, null);
  assert.equal(unknown.jobs.succeeded, null);
  assert.equal(unknown.hotState.confirmed.observations, null);
  assert.equal(meter.instanceSnapshot().trackedTenants, 0, 'reading does not allocate tenant records');

  meter.observeJob('alpha', 'blocked');
  const observed = meter.snapshot('alpha');
  assert.equal(observed.coverage.status, 'observed');
  assert.equal(observed.db.attempted, 0);
  assert.equal(observed.jobs.succeeded, 0);
  assert.deepEqual(observed.db.requestBody, { bytes: null, knownObservations: 0, unknownObservations: 0 });
  assert.equal(observed.coverage.byteSemantics, 'application_body_bytes_only');
  assert.equal(observed.coverage.resetOnRestart, true);
  assert.equal(observed.coverage.persistence, false);

  const unavailable = fixture({ dbAvailable: false }).meter;
  unavailable.observeJob('alpha', 'succeeded');
  unavailable.observeHotState('alpha', { bytes: 128, kind: 'confirmed' });
  assert.equal(request(unavailable), null);
  const local = unavailable.snapshot('alpha');
  assert.equal(local.coverage.status, 'unavailable');
  assert.equal(local.db.completed, null);
  assert.equal(local.db.responseBody.knownObservations, null);
  assert.equal(local.jobs.succeeded, 1);
  assert.equal(local.hotState.confirmed.bytes, 128);
  assert.deepEqual(local.anomalies, []);
});

test('counts attempts, outcomes, known retries, application bytes and missing byte coverage', () => {
  const { meter } = fixture();
  const a = request(meter, 'alpha', { operation: 'state_commit', method: 'POST', requestBodyBytes: 21 });
  assert.deepEqual(Object.keys(a), []);
  assert.ok(Object.isFrozen(a));
  const b = request(meter, 'alpha', { requestBodyBytes: null, retryKind: 'primary_statement_cancelled' });
  assert.equal(meter.snapshot('alpha').db.inflight, 2);
  complete(meter, a, { responseBodyBytes: 0 });
  complete(meter, b, { outcome: 'network_error', responseBodyBytes: null });
  complete(meter, request(meter, 'alpha', { retryKind: 'upsert_network' }), { responseBodyBytes: 15 });
  const { db } = meter.snapshot('alpha');
  assert.equal(db.attempted, 3);
  assert.equal(db.completed, 3);
  assert.equal(db.inflight, 0);
  assert.equal(db.failed, 1);
  assert.equal(db.succeeded, 2);
  assert.equal(db.outcomes.network_error, 1);
  assert.equal(db.operations.state_commit, 1);
  assert.equal(db.methods.POST, 1);
  assert.equal(db.retries.primary_statement_cancelled, 1);
  assert.equal(db.retries.upsert_network, 1);
  assert.equal(db.retries.primary_network_reconciled, 0);
  assert.deepEqual(db.requestBody, { bytes: 21, knownObservations: 2, unknownObservations: 1 });
  assert.deepEqual(db.responseBody, { bytes: 15, knownObservations: 2, unknownObservations: 1 });
});

test('all allowlisted outcomes and retry kinds have fixed bounded counters', () => {
  const { meter } = fixture();
  for (const outcome of ACTIVITY_OUTCOMES) complete(meter, request(meter), { outcome });
  for (const retryKind of ACTIVITY_RETRY_KINDS) complete(meter, request(meter, 'alpha', { retryKind }));
  const { db } = meter.snapshot('alpha');
  for (const outcome of ACTIVITY_OUTCOMES) assert.ok(db.outcomes[outcome] >= 1);
  for (const retryKind of ACTIVITY_RETRY_KINDS) assert.equal(db.retries[retryKind], 1);
  assert.equal(db.failed, 4);
  assert.equal(Object.keys(db.methods).length, ACTIVITY_METHODS.length);
  assert.equal(Object.keys(db.operations).length, ACTIVITY_OPERATIONS.length - 1);
});

test('opaque tokens cannot be forged, replayed, moved between meters or assigned another tenant', () => {
  const { meter } = fixture();
  const other = fixture().meter;
  const alpha = request(meter);
  const beta = request(meter, 'beta');
  assert.equal(complete(meter, {}), false);
  assert.equal(complete(other, alpha), false);
  assert.equal(complete(meter, alpha, { workspaceId: 'beta' }), true);
  assert.equal(complete(meter, alpha), false);
  assert.equal(meter.snapshot('alpha').db.completed, 1);
  assert.equal(meter.snapshot('beta').db.completed, 0);
  complete(meter, beta);
  assert.equal(meter.snapshot('beta').db.completed, 1);
});

test('tenant snapshots contain no other tenant, global claims, or unattributed counts', () => {
  const { meter } = fixture();
  complete(meter, request(meter, 'secret-other-tenant', { requestBodyBytes: 123_456 }));
  complete(meter, request(meter, null, { operation: 'identity_read', requestBodyBytes: 987_654 }));
  complete(meter, request(meter, 'alpha', { operation: 'job_claim', requestBodyBytes: 555_555 }));
  assert.equal(meter.snapshot('alpha').db.attempted, null, 'global claim must not allocate alpha');
  complete(meter, request(meter));
  const alpha = meter.snapshot('alpha');
  assert.equal(alpha.db.attempted, 1);
  assert.equal(alpha.db.requestBody.bytes, 0);
  assert.equal(Object.hasOwn(alpha.db.operations, 'job_claim'), false);
  const json = JSON.stringify(alpha);
  for (const forbidden of ['secret-other-tenant', '123456', '987654', '555555', 'unattributed', 'trackedTenants']) {
    assert.equal(json.includes(forbidden), false, forbidden);
  }
  assert.equal(meter.instanceSnapshot().totals.db.attempted, 4);
  assert.equal(meter.instanceSnapshot().unattributed.db.attempted, 2);
});

test('tenant cardinality is bounded without eviction and excess activity is explicitly unknown', () => {
  const { meter } = fixture({ maxTenants: 2 });
  complete(meter, request(meter, 'alpha'));
  complete(meter, request(meter, 'beta'));
  for (let i = 0; i < 1000; i++) assert.equal(request(meter, `overflow-${i}`), null);
  assert.equal(meter.instanceSnapshot().trackedTenants, 2);
  assert.equal(meter.instanceSnapshot().tenantCapacityOmissions, 1000);
  assert.equal(meter.snapshot('overflow-1').db.attempted, null);
  assert.equal(meter.snapshot('overflow-1').coverage.status, 'not_observed');
  assert.equal(meter.snapshot('alpha').db.attempted, 1);
  assert.equal(meter.snapshot('alpha').coverage.evicted, false);
  assert.throws(() => createActivityMeter({ maxTenants: 65 }), /ACTIVITY_TENANT_LIMIT_INVALID/);
});

test('128 inflight tokens are a hard bound and overflow marks tenant coverage incomplete', () => {
  const { meter, advance } = fixture();
  const tokens = Array.from({ length: 128 }, () => request(meter));
  assert.ok(tokens.every(Boolean));
  assert.equal(request(meter), null);
  let alpha = meter.snapshot('alpha');
  assert.equal(alpha.db.attempted, 129);
  assert.equal(alpha.db.inflight, null);
  assert.equal(alpha.coverage.inflightReason, 'inflight_token_overflow');
  assert.equal(alpha.coverage.inflightOverflow, 1);
  assert.equal(alpha.coverage.omittedObservations, 1);
  assert.equal(alpha.coverage.status, 'partial');
  assert.equal(meter.instanceSnapshot().inflightTokens, 128);
  for (const token of tokens) complete(meter, token, { outcome: 'http_error' });
  advance(300_000);
  alpha = meter.snapshot('alpha');
  assert.equal(alpha.db.completed, 128);
  assert.equal(alpha.db.inflight, null, 'an omitted request may remain running after all retained tokens complete');
  assert.equal(alpha.rateWindow.eligible, false);
  assert.equal(alpha.rateWindow.reason, 'inflight_token_overflow');
  assert.deepEqual(alpha.anomalies, []);
  const next = request(meter);
  assert.ok(next, 'space is reusable after completions');
});

test('hot state tracks separate observations, prior deltas and deterministic thresholds', () => {
  const { meter, advance } = fixture();
  meter.observeHotState('alpha', { bytes: 100, kind: 'attempted' });
  advance(1000);
  meter.observeHotState('alpha', { bytes: 80, kind: 'attempted' });
  meter.observeHotState('alpha', { bytes: 200, kind: 'confirmed' });
  meter.observeHotState('alpha', { bytes: 400, kind: 'integrity_read' });
  let state = meter.snapshot('alpha').hotState;
  assert.deepEqual(state.attempted, { bytes: 80, previousBytes: 100, deltaBytes: -20,
    observedAt: new Date(EPOCH + 1000).toISOString(), observations: 2 });
  assert.equal(state.confirmed.previousBytes, null);
  assert.equal(state.integrityRead.bytes, 400);
  meter.observeHotState('alpha', { bytes: 1.5 * 1024 * 1024, kind: 'attempted' });
  assert.equal(meter.snapshot('alpha').anomalies[0].code, 'hot_state_near_limit');
  meter.observeHotState('alpha', { bytes: 2 * 1024 * 1024, kind: 'attempted' });
  assert.equal(meter.snapshot('alpha').anomalies[0].severity, 'error');
  meter.observeHotState('alpha', { bytes: 2 * 1024 * 1024 + 1, kind: 'attempted' });
  assert.equal(meter.snapshot('alpha').anomalies[0].code, 'hot_state_limit_exceeded');
  assert.equal(meter.snapshot('alpha').hotState.confirmed.bytes, 200, 'failed oversized attempts do not change confirmed bytes');
});

test('malformed observations never throw or retain unbounded raw context', () => {
  const { meter } = fixture();
  const secret = 'https://service.invalid/?apikey=do-not-store';
  for (const bad of [undefined, null, true, 123, 'raw', [], { get workspaceId() { throw new Error(secret); } }]) {
    assert.doesNotThrow(() => meter.beginDbAttempt(bad));
    assert.doesNotThrow(() => meter.observeHotState('alpha', bad));
    assert.doesNotThrow(() => meter.finishDbAttempt({}, bad));
  }
  for (const bad of [-1, Infinity, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1, {}, secret]) {
    assert.equal(meter.observeHotState('alpha', { bytes: bad, kind: 'confirmed' }), false);
    complete(meter, request(meter, 'alpha', { requestBodyBytes: bad }), { responseBodyBytes: bad });
  }
  assert.equal(request(meter, 'alpha', { operation: secret }), null);
  assert.equal(request(meter, 'alpha', { method: secret }), null);
  assert.equal(request(meter, 'alpha', { retryKind: secret }), null);
  assert.equal(meter.observeJob('alpha', secret), false);
  assert.equal(meter.observeHotState('alpha', { bytes: 12, kind: '__proto__' }), false);
  assert.equal(meter.observeJob('x'.repeat(257), 'succeeded'), false);
  assert.equal(meter.observeJob('with\nnewline', 'succeeded'), false);
  assert.equal(meter.observeJob(null, 'succeeded'), true);
  assert.throws(() => meter.snapshot('with\nnewline'), /ACTIVITY_WORKSPACE_INVALID/);
  const alpha = meter.snapshot('alpha');
  assert.ok(alpha.coverage.invalidObservations > 0);
  assert.equal(alpha.hotState.confirmed.bytes, null);
  assert.equal(JSON.stringify(meter.instanceSnapshot()).includes(secret), false);
});

test('invalid completion consumes token, reports missing outcome and never invents success', () => {
  const { meter, advance } = fixture();
  const token = request(meter);
  assert.equal(complete(meter, token, { outcome: 'invented' }), false);
  const alpha = meter.snapshot('alpha');
  assert.equal(alpha.db.attempted, 1);
  assert.equal(alpha.db.completed, 0);
  assert.equal(alpha.db.inflight, 0);
  assert.equal(alpha.coverage.omittedObservations, 1);
  assert.equal(complete(meter, token), false);
  advance(300_000);
  assert.equal(meter.snapshot('alpha').rateWindow.reason, 'incomplete_observations');
});

test('jobs count bounded observed transitions without job IDs or caller-controlled keys', () => {
  const { meter } = fixture();
  for (const event of ACTIVITY_JOB_EVENTS) assert.equal(meter.observeJob('alpha', event), true);
  meter.observeJob('beta', 'succeeded');
  const jobs = meter.snapshot('alpha').jobs;
  assert.deepEqual(jobs, { succeeded: 1, blocked: 1, dead_letter: 1, rescheduled: 1, manual_retry: 1 });
  jobs.succeeded = 100;
  assert.equal(meter.snapshot('alpha').jobs.succeeded, 1);
});

test('rate anomalies require a complete fixed five-minute window and at least ten completions', () => {
  const { meter, advance } = fixture();
  batch(meter, 10, { failures: 5, retries: 5 });
  advance(299_999);
  assert.deepEqual(meter.snapshot('alpha').anomalies, []);
  assert.equal(meter.snapshot('alpha').rateWindow.reason, 'awaiting_complete_window');
  advance(1);
  const alpha = meter.snapshot('alpha');
  assert.equal(alpha.rateWindow.eligible, true);
  assert.equal(alpha.rateWindow.startedAt, new Date(EPOCH).toISOString());
  assert.equal(alpha.rateWindow.endedAt, new Date(EPOCH + 300_000).toISOString());
  assert.deepEqual(alpha.anomalies.map(item => item.code), ['db_failure_burst', 'db_retry_burst']);
  advance(300_000);
  assert.equal(meter.snapshot('alpha').rateWindow.reason, 'insufficient_completions');
  assert.deepEqual(meter.snapshot('alpha').anomalies, []);
});

test('insufficient, stale, and non-burst evidence never emits a rate anomaly', () => {
  const short = fixture();
  batch(short.meter, 9, { failures: 9, retries: 9 });
  short.advance(300_000);
  assert.equal(short.meter.snapshot('alpha').rateWindow.reason, 'insufficient_completions');
  assert.deepEqual(short.meter.snapshot('alpha').anomalies, []);
  const low = fixture();
  batch(low.meter, 20, { failures: 9, retries: 9 });
  low.advance(300_000);
  assert.equal(low.meter.snapshot('alpha').rateWindow.eligible, true);
  assert.deepEqual(low.meter.snapshot('alpha').anomalies, []);
  low.advance(50 * 300_000);
  assert.equal(low.meter.snapshot('alpha').rateWindow.completed, 0);
  assert.deepEqual(low.meter.snapshot('alpha').anomalies, []);
});

test('pending results and windows straddled by unfinished requests withhold rate anomalies', () => {
  const { meter, advance } = fixture();
  batch(meter, 10, { failures: 10 });
  const pending = request(meter);
  advance(300_000);
  let alpha = meter.snapshot('alpha');
  assert.equal(alpha.rateWindow.eligible, false);
  assert.equal(alpha.rateWindow.reason, 'incomplete_observations');
  complete(meter, pending);
  assert.deepEqual(meter.snapshot('alpha').anomalies, []);
  batch(meter, 10, { failures: 10 });
  advance(300_000);
  assert.equal(meter.snapshot('alpha').rateWindow.eligible, true, 'a subsequent fully observed window can recover');
  const another = request(meter);
  assert.equal(meter.snapshot('alpha').rateWindow.reason, 'pending_completions');
  assert.deepEqual(meter.snapshot('alpha').anomalies, []);
  complete(meter, another);
});

test('clock rollback and invalid clocks never emit rate flags or regress snapshot time', () => {
  const { meter, advance, setTime } = fixture();
  batch(meter, 10, { failures: 10 });
  advance(300_000);
  assert.equal(meter.snapshot('alpha').rateWindow.eligible, true);
  setTime(EPOCH - 1);
  const alpha = meter.snapshot('alpha');
  assert.equal(alpha.snapshotAt, new Date(EPOCH + 300_000).toISOString());
  assert.equal(alpha.coverage.clockReliable, false);
  assert.equal(alpha.rateWindow.reason, 'clock_unreliable');
  assert.deepEqual(alpha.anomalies, []);
  setTime(EPOCH + 600_000);
  assert.equal(meter.snapshot('alpha').coverage.clockReliable, false, 'clock coverage stays degraded until a new meter');
  const invalid = createActivityMeter({ now: () => { throw new Error('private-clock-error'); }, instanceId: 'bad-clock' });
  assert.doesNotThrow(() => complete(invalid, request(invalid)));
  assert.equal(invalid.snapshot('alpha').coverage.clockReliable, false);
  assert.equal(JSON.stringify(invalid.snapshot('alpha')).includes('private-clock-error'), false);
});

test('safe integer overflow saturates and exposes loss of exact coverage', () => {
  const { meter, advance } = fixture();
  complete(meter, request(meter, 'alpha', { requestBodyBytes: Number.MAX_SAFE_INTEGER }));
  complete(meter, request(meter, 'alpha', { requestBodyBytes: 1 }));
  batch(meter, 10, { failures: 10 });
  advance(300_000);
  const alpha = meter.snapshot('alpha');
  assert.equal(alpha.db.requestBody.bytes, null);
  assert.equal(alpha.coverage.counterSemantics, 'lower_bounds_after_overflow');
  assert.equal(alpha.coverage.counterOverflow, true);
  assert.equal(alpha.rateWindow.reason, 'counter_overflow');
  assert.deepEqual(alpha.anomalies, []);
});

test('a fresh meter resets observations and cannot finish a prior instance token', () => {
  const first = fixture({ instanceId: 'before-restart' });
  const pending = request(first.meter);
  complete(first.meter, request(first.meter));
  const second = fixture({ instanceId: 'after-restart' });
  assert.equal(second.meter.snapshot('alpha').db.completed, null);
  assert.equal(complete(second.meter, pending), false);
  complete(second.meter, request(second.meter));
  assert.equal(second.meter.snapshot('alpha').db.completed, 1);
  assert.equal(first.meter.snapshot('alpha').db.completed, 1);
  assert.notEqual(first.meter.snapshot('alpha').instanceId, second.meter.snapshot('alpha').instanceId);
});

test('every snapshot is detached, bounded below32KiB, and excludes supplied raw bodies and errors', () => {
  const { meter, advance } = fixture();
  const raw = 'secret payload '.repeat(10_000);
  for (let i = 0; i < 64; i++) {
    const workspaceId = `tenant-${i}`;
    const token = request(meter, workspaceId, { body: raw, path: raw, url: raw });
    complete(meter, token, { responseBodyBytes: Number.MAX_SAFE_INTEGER, error: raw });
    for (const kind of ['attempted', 'confirmed', 'integrity_read']) meter.observeHotState(workspaceId, { bytes: Number.MAX_SAFE_INTEGER, kind });
  }
  advance(300_000);
  const snapshot = meter.snapshot('tenant-0');
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 32 * 1024);
  assert.equal(JSON.stringify(snapshot).includes('secret payload'), false);
  snapshot.db.requestBody.bytes = 5;
  snapshot.hotState.confirmed.bytes = 5;
  snapshot.coverage.excludes.push('invented');
  snapshot.anomalies[0].bytes = 5;
  const next = meter.snapshot('tenant-0');
  assert.equal(next.db.requestBody.bytes, 0);
  assert.equal(next.hotState.confirmed.bytes, Number.MAX_SAFE_INTEGER);
  assert.equal(next.coverage.excludes.includes('invented'), false);
  assert.equal(next.anomalies[0].bytes, Number.MAX_SAFE_INTEGER);
});


test('valid store workspace identifiers preserve their full exact identity', () => {
  const { meter } = fixture();
  for (const workspaceId of ['Équipe du café', 'with/slash', 'x'.repeat(256), 'workspace-🌍']) {
    complete(meter, request(meter, workspaceId));
    assert.equal(meter.snapshot(workspaceId).workspaceId, workspaceId);
    assert.equal(meter.snapshot(workspaceId).db.completed, 1);
  }
  for (const invalid of ['', ' leading', 'trailing ', '\u0000', '\uD800', '\uDC00', '\u0085']) {
    assert.equal(request(meter, invalid), null);
    assert.throws(() => meter.snapshot(invalid), /ACTIVITY_WORKSPACE_INVALID/);
  }
});

test('default instance identifiers distinguish meters created at the same time', () => {
  const first = createActivityMeter({ now: () => EPOCH }).snapshot('alpha');
  const second = createActivityMeter({ now: () => EPOCH }).snapshot('alpha');
  assert.notEqual(first.instanceId, second.instanceId);
});

test('a newly omitted result immediately withholds otherwise eligible prior-window flags', () => {
  const { meter, advance } = fixture();
  batch(meter, 10, { failures: 10 });
  advance(300_000);
  assert.equal(meter.snapshot('alpha').rateWindow.eligible, true);
  complete(meter, request(meter), { outcome: 'invalid-enum' });
  assert.equal(meter.snapshot('alpha').rateWindow.eligible, false);
  assert.equal(meter.snapshot('alpha').rateWindow.reason, 'incomplete_observations');
  assert.deepEqual(meter.snapshot('alpha').anomalies, []);
});

test('global claim operation counters are available only in internal diagnostics', () => {
  const { meter } = fixture();
  complete(meter, request(meter, 'alpha', { operation: 'job_claim' }));
  assert.equal(meter.instanceSnapshot().totals.db.operations.job_claim, 1);
  assert.equal(meter.instanceSnapshot().unattributed.db.operations.job_claim, 1);
  assert.equal(Object.hasOwn(meter.snapshot('alpha').db.operations, 'job_claim'), false);
});

test('instance start precedes first tenant observation and remains available for unobserved tenants', () => {
  const { meter, advance } = fixture();
  advance(60_000);
  const unknown = meter.snapshot('alpha');
  assert.equal(unknown.instanceStartedAt, new Date(EPOCH).toISOString());
  assert.equal(unknown.observedSince, null);
  complete(meter, request(meter));
  const observed = meter.snapshot('alpha');
  assert.equal(observed.instanceStartedAt, new Date(EPOCH).toISOString());
  assert.equal(observed.observedSince, new Date(EPOCH + 60_000).toISOString());
  assert.equal(meter.instanceSnapshot().totals.instanceStartedAt, observed.instanceStartedAt);
  assert.equal(meter.instanceSnapshot().unattributed.instanceStartedAt, observed.instanceStartedAt);
});

test('an omitted inflight completion remains unknown through later windows and affects only its tenant', () => {
  const { meter, advance } = fixture();
  const retained = Array.from({ length: 128 }, () => request(meter, 'alpha'));
  assert.equal(request(meter, 'alpha'), null);
  for (const token of retained) complete(meter, token);
  complete(meter, request(meter, 'beta'));
  advance(300_000);
  batch(meter, 10, { failures: 10 });
  advance(300_000);
  const alpha = meter.snapshot('alpha');
  assert.equal(alpha.db.attempted, 139);
  assert.equal(alpha.db.completed, 138);
  assert.equal(alpha.db.inflight, null);
  assert.equal(alpha.coverage.inflightReason, 'inflight_token_overflow');
  assert.equal(alpha.rateWindow.eligible, false);
  assert.equal(alpha.rateWindow.reason, 'inflight_token_overflow');
  assert.deepEqual(alpha.anomalies, []);
  const beta = meter.snapshot('beta');
  assert.equal(beta.db.inflight, 0);
  assert.equal(beta.coverage.inflightOverflow, 0);
  assert.equal(beta.coverage.inflightReason, 'complete_observations');
});
