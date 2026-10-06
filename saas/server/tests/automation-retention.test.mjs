import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { planAutomationRetention, applyAutomationRetention, isAutomationArchiveStub, automationArchivePayloadDigest, verifyAutomationArchivePayload, automationEvidenceCount, estimateAutomationArchiveReadBodyBytes, estimateAutomationArchiveResponseBodyBytes, AUTOMATION_ARCHIVE_BATCH_SIZE, AUTOMATION_ARCHIVE_BATCH_BYTES, AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES, AUTOMATION_ARCHIVE_READ_BODY_MAX_BYTES, AUTOMATION_ARCHIVE_READ_FRAMING_BYTES } from '../lib/automation-retention.mjs';
import { dueRules, claimAutomation, finishAutomation } from '../lib/control.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';

const NOW = new Date('2026-10-06T19:00:00.000Z');
function run(id, index = 0, extra = {}) {
  const startedAt = new Date(NOW.getTime() - (index + 1) * 60000).toISOString();
  return { id, ruleId: 'profitGuard', status: 'COMPLETED', startedAt, completedAt: startedAt,
    leaseUntil: new Date(Date.parse(startedAt) + 600000).toISOString(), risk: 'low', spend: 0, errorCode: null,
    evidence: [{ type: 'business_monitor', id, detail: 'Recorded source evidence '.repeat(100) }], ...extra };
}
function state(runs = []) {
  return { workspace: { id: 'tenant-retention' }, _revision: 'revision-a', autopilot: { timeZone: 'Europe/London' }, automationRuns: runs };
}
const acknowledge = plan => plan.archiveCandidates.map(candidate => ({ ...candidate.reference, confirmed: true }));
const applyAll = plan => applyAutomationRetention(plan, { acknowledgedArchives: acknowledge(plan) });
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function schedulerState(runs, ruleId = 'profitGuard') {
  const s = seedWorkspaceState({}, { workspaceId: 'tenant-retention' });
  s._revision = 'revision-a'; s.automationRuns = runs;
  s.autopilot.enabled = true;
  s.autopilot.timeZone = 'Europe/London';
  for (const key of Object.keys(s.automations)) s.automations[key] = key === ruleId;
  s.autopilot.rules[ruleId] = { ...s.autopilot.rules[ruleId], permitted: true, intervalMinutes: 15, maxRunsPerDay: 40 };
  return s;
}

test('default policy compacts old completed payloads but retains every current-day quota row', () => {
  const s = state(Array.from({ length: 40 }, (_, i) => run(`run-${i}`, i)));
  const before = JSON.stringify(s), plan = planAutomationRetention(s, { now: NOW });
  assert.equal(plan.archiveCandidates.length, 15);
  assert.equal(plan.archiveCandidates.every(item => item.targetAction === 'retain-stub'), true);
  const result = applyAll(plan);
  assert.equal(result.automationRuns.length, 40);
  assert.equal(result.compacted, 15);
  assert.equal(result.evicted, 0);
  for (let i = 0; i < 25; i++) assert.equal(result.automationRuns[i], s.automationRuns[i]);
  for (let i = 25; i < 40; i++) {
    const stub = result.automationRuns[i];
    assert.ok(isAutomationArchiveStub(stub, s.workspace.id));
    assert.equal(stub.id, s.automationRuns[i].id);
    assert.equal(stub.startedAt, s.automationRuns[i].startedAt);
    assert.equal(stub.evidenceCount, 1);
    assert.equal(automationEvidenceCount(stub, s.workspace.id), automationEvidenceCount(s.automationRuns[i], s.workspace.id));
    assert.deepEqual(stub.evidence, [], 'archive metadata must not be fabricated evidence');
  }
  assert.equal(JSON.stringify(s), before, 'planning/apply never assigns into source state');
  assert.ok(Buffer.byteLength(JSON.stringify(result.automationRuns)) < Buffer.byteLength(JSON.stringify(s.automationRuns)));
});

test('active/latest/error/malformed records remain full and preserve object identity', () => {
  const active = run('active', 0, { status: 'IN PROGRESS' });
  const failed = run('failed', 30, { status: 'FAILED', errorCode: 'READ_FAILED' });
  const blocked = run('blocked', 31, { status: 'BLOCKED' });
  const malformed = run('malformed', 32, { completedAt: '2026-02-30T12:00:00Z' });
  const otherLatest = run('other-latest', 33, { ruleId: 'stockAlerts' });
  const foreign = run('foreign', 34, { tenant_id: 'other' });
  const unknown = run('unknown-status', 35, { status: 'REQUIRES APPROVAL' });
  const malformedMarker = run('bad-archive', 36, { archive: { table: 'wrong' } });
  const duplicateOne = run('duplicate', 37), duplicateTwo = run('duplicate', 38, { evidence: [] });
  const s = state([active, ...Array.from({ length: 29 }, (_, i) => run(`normal-${i}`, i + 1)), failed, blocked, malformed, otherLatest, foreign, unknown, malformedMarker, duplicateOne, duplicateTwo, null]);
  const result = applyAll(planAutomationRetention(s, { now: NOW }));
  for (const item of [active, failed, blocked, malformed, otherLatest, foreign, unknown, malformedMarker, duplicateOne, duplicateTwo, null]) assert.ok(result.automationRuns.includes(item));
  active.evidence.push({ type: 'later' });
  assert.equal(result.automationRuns[0].evidence.at(-1).type, 'later');
});

test('quota and cooldown decisions remain exactly unchanged after current-day compaction', () => {
  for (const [count, limit, newestMinutesAgo] of [[40, 40, 60], [30, 40, 5], [30, 40, 60]]) {
    const runs = Array.from({ length: count }, (_, i) => run(`quota-${i}`, i + newestMinutesAgo - 1));
    const s = schedulerState(runs);
    s.autopilot.rules.profitGuard.maxRunsPerDay = limit;
    const before = dueRules(s, NOW).map(item => item.id);
    const result = applyAll(planAutomationRetention(s, { now: NOW }));
    const after = dueRules({ ...s, automationRuns: result.automationRuns }, NOW).map(item => item.id);
    assert.deepEqual(after, before);
    assert.equal(result.automationRuns.length, count);
    assert.ok(result.compacted > 0);
  }
});

test('daily brief local-day rows survive UTC midnight and both DST transitions', () => {
  for (const [now, earlier] of [
    ['2026-10-06T00:05:00.000Z', '2026-10-05T23:10:00.000Z'],
    ['2026-03-29T23:05:00.000Z', '2026-03-29T23:01:00.000Z'],
    ['2026-10-25T23:55:00.000Z', '2026-10-25T01:10:00.000Z']
  ]) {
    const s = schedulerState([run('newest', 0, { ruleId: 'dailyOpsBrief', startedAt: now, completedAt: now }), run('earlier', 0, { ruleId: 'dailyOpsBrief', startedAt: earlier, completedAt: earlier })], 'dailyOpsBrief');
    s.autopilot.morningHour = 0;
    const before = dueRules(s, new Date(now)).map(item => item.id);
    const result = applyAll(planAutomationRetention(s, { now, recentCompletedLimit: 0 }));
    assert.equal(result.automationRuns.length, 2);
    assert.equal(result.compacted, 1);
    assert.deepEqual(dueRules({ ...s, automationRuns: result.automationRuns }, new Date(now)).map(item => item.id), before);
  }
  const s = state([run('newest', 0, { ruleId: 'dailyOpsBrief', startedAt: '2026-10-06T08:10:00Z', completedAt: '2026-10-06T08:10:00Z' }), run('old-utc-local-today', 0, { ruleId: 'dailyOpsBrief', startedAt: '2026-10-05T23:30:00Z', completedAt: '2026-10-05T23:30:00Z' })]);
  s.autopilot.timeZone = 'America/Los_Angeles';
  // The earlier row belongs to the previous local day here, so no quota is invented.
  const p = planAutomationRetention(s, { now: '2026-10-06T09:00:00Z', recentCompletedLimit: 0 });
  assert.equal(p.archiveCandidates[0].targetAction, 'archive-only');
});

test('an earlier local-day completed brief still prevents replay when the latest attempt failed across UTC midnight', () => {
  const now = new Date('2026-10-06T00:05:00.000Z');
  const s = schedulerState([
    run('latest-failure', 0, { ruleId: 'dailyOpsBrief', status: 'FAILED', errorCode: 'READ_FAILED', startedAt: '2026-10-05T23:40:00Z', completedAt: '2026-10-05T23:41:00Z' }),
    run('earlier-success', 0, { ruleId: 'dailyOpsBrief', startedAt: '2026-10-05T23:10:00Z', completedAt: '2026-10-05T23:11:00Z' })
  ], 'dailyOpsBrief');
  s.autopilot.morningHour = 0;
  assert.deepEqual(dueRules(s, now), []);
  const result = applyAll(planAutomationRetention(s, { now, recentCompletedLimit: 0 }));
  assert.equal(result.compacted, 1);
  assert.equal(result.automationRuns[0], s.automationRuns[0]);
  assert.deepEqual(dueRules({ ...s, automationRuns: result.automationRuns }, now), []);
  assert.ok(dueRules({ ...s, automationRuns: result.automationRuns.slice(0, 1) }, now).some(rule => rule.id === 'dailyOpsBrief'), 'dropping the success row would actually replay the brief');
});

test('claim/save/finish/save keeps the live claim object and completed evidence attached', () => {
  const s = schedulerState(Array.from({ length: 35 }, (_, i) => run(`historic-${i}`, i + 60)));
  s.autopilot.rules.profitGuard.maxRunsPerDay = 96;
  const claim = claimAutomation(s, 'profitGuard', NOW);
  assert.ok(claim);
  const first = applyAll(planAutomationRetention(s, { now: NOW }));
  // Simulate successful CAS publication of the staged array only.
  s.automationRuns = first.automationRuns;
  assert.equal(s.automationRuns[0], claim);
  finishAutomation(s, claim, { evidence: [{ type: 'completed-read', id: 'verified-read' }] });
  const finishNow = new Date(Math.max(Date.parse(claim.completedAt), NOW.getTime()));
  const second = applyAll(planAutomationRetention(s, { now: finishNow }));
  assert.equal(second.automationRuns[0], claim);
  assert.equal(second.automationRuns[0].status, 'COMPLETED');
  assert.equal(second.automationRuns[0].evidence[0].id, 'verified-read');
});

test('archive failure, partial acknowledgements and failed CAS never mutate authoritative input', () => {
  const s = state(Array.from({ length: 28 }, (_, i) => run(`failure-${i}`, i)));
  const before = structuredClone(s), plan = planAutomationRetention(s, { now: NOW });
  const failed = applyAutomationRetention(plan);
  assert.deepEqual(failed.automationRuns, s.automationRuns);
  assert.ok(failed.automationRuns.every((row, i) => row === s.automationRuns[i]));
  assert.equal(failed.pendingArchives, 3);
  const ack = acknowledge(plan)[0];
  const partial = applyAutomationRetention(plan, { acknowledgedArchives: [ack, { ...ack, workspaceId: 'foreign' }, { ...ack, sha256: '0'.repeat(64) }] });
  assert.equal(partial.compacted, 1);
  assert.equal(partial.pendingArchives, 2);
  const staged = applyAll(plan);
  assert.equal(staged.compacted, 3);
  // A caller can discard staged output after a CAS failure; originals remain full.
  assert.deepEqual(s, before);
  assert.equal(s.automationRuns[25].archive, undefined);
  s._revision = 'concurrent-winner';
  assert.throws(() => applyAll(plan), { code: 'RETENTION_PLAN_STALE' });
});

test('source array/order, candidate payload, or latest scheduling changes invalidate old plans', () => {
  for (const mutate of [
    s => s.automationRuns.unshift(run('new-arrival')),
    s => s.automationRuns.reverse(),
    s => { s.automationRuns = [...s.automationRuns]; },
    s => { s.automationRuns[27].evidence[0].detail = 'new evidence'; },
    s => { s.automationRuns[0].ruleId = 'another-rule'; },
    s => { s.tenantId = 'foreign'; },
    s => { s.autopilot.timeZone = 'UTC'; }
  ]) {
    const s = state(Array.from({ length: 28 }, (_, i) => run(`stale-${i}`, i)));
    const plan = planAutomationRetention(s, { now: NOW }); mutate(s);
    assert.throws(() => applyAll(plan), { code: 'RETENTION_PLAN_STALE' });
  }
});

test('unchanged persisted stubs cause no archival work and later eviction never re-archives them', () => {
  const s = state(Array.from({ length: 30 }, (_, i) => run(`repeat-${i}`, i)));
  s.automationRuns = applyAll(planAutomationRetention(s, { now: NOW })).automationRuns;
  const repeat = planAutomationRetention(s, { now: NOW });
  assert.equal(repeat.archiveCandidates.length, 0);
  const repeated = applyAll(repeat);
  assert.equal(repeated.compacted, 0);
  assert.ok(repeated.automationRuns.every((row, i) => row === s.automationRuns[i]));
  const nextDay = planAutomationRetention(s, { now: '2026-10-07T19:00:00Z' });
  assert.equal(nextDay.archiveCandidates.length, 0);
  assert.equal(nextDay.summary.existingStubsToEvict, 5);
  const aged = applyAll(nextDay);
  assert.equal(aged.evicted, 5);
  assert.equal(aged.automationRuns.length, 25);
  assert.equal(s.automationRuns.length, 30, 'planning does not remove quota stubs from source');
});

test('old completed rows leave hot state only after exact confirmed immutable archival', () => {
  const s = state([run('latest'), run('old', 0, { startedAt: '2026-10-01T10:00:00Z', completedAt: '2026-10-01T10:01:00Z' })]);
  const plan = planAutomationRetention(s, { now: NOW, recentCompletedLimit: 0 });
  assert.equal(plan.archiveCandidates[0].targetAction, 'archive-only');
  assert.equal(applyAutomationRetention(plan).automationRuns.length, 2);
  assert.equal(applyAutomationRetention(plan, { acknowledgedArchives: [plan.archiveCandidates[0].reference] }).automationRuns.length, 2, 'a proposed reference alone is not acknowledgement');
  assert.equal(applyAll(plan).automationRuns.length, 1);
});

test('conflicting same-ID payloads have separate immutable versions across replicas', () => {
  const a = state([run('latest'), run('same-id', 30)]), b = structuredClone(a);
  b.automationRuns[1].evidence[0].detail = 'Corrected recorded evidence '.repeat(100);
  const left = planAutomationRetention(a, { now: NOW, recentCompletedLimit: 0 });
  const right = planAutomationRetention(b, { now: NOW, recentCompletedLimit: 0 });
  assert.notEqual(left.archiveCandidates[0].reference.recordId, right.archiveCandidates[0].reference.recordId);
  assert.notEqual(left.archiveCandidates[0].reference.sha256, right.archiveCandidates[0].reference.sha256);
  assert.equal(left.archiveCandidates[0].row.payload.id, right.archiveCandidates[0].row.payload.id);
  assert.equal(applyAutomationRetention(left, { acknowledgedArchives: acknowledge(right) }).compacted, 0);
  const reordered = state([run('latest'), Object.fromEntries(Object.entries(a.automationRuns[1]).reverse())]);
  const same = planAutomationRetention(reordered, { now: NOW, recentCompletedLimit: 0 });
  assert.equal(same.archiveCandidates[0].reference.sha256, left.archiveCandidates[0].reference.sha256, 'JSONB key order does not create new versions');
});

test('canonical payload digest is complete, detached, immutable and scoped across tenants', () => {
  const s = state([run('latest'), { ...run('digest', 30), extra: { z: [3, 2, 1], a: 'full recorded payload' } }]);
  const plan = planAutomationRetention(s, { now: NOW, recentCompletedLimit: 0 });
  const candidate = plan.archiveCandidates[0];
  assert.deepEqual(candidate.row.payload, s.automationRuns[1]);
  assert.notEqual(candidate.row.payload, s.automationRuns[1]);
  assert.throws(() => { candidate.row.payload.extra.a = 'overwrite'; }, TypeError);
  assert.equal(candidate.reference.sha256, createHash('sha256').update(JSON.stringify(candidate.row.payload)).digest('hex'));
  assert.equal(verifyAutomationArchivePayload(candidate.reference, candidate.row.payload, s.workspace.id), true);
  assert.equal(verifyAutomationArchivePayload(candidate.reference, candidate.row.payload, 'foreign'), false);
  assert.equal(verifyAutomationArchivePayload(candidate.reference, candidate.row.payload, s.workspace.id, 'different-run'), false);
  assert.equal(verifyAutomationArchivePayload(candidate.reference, { ...candidate.row.payload, spend: 999 }, s.workspace.id), false);
  assert.equal(automationArchivePayloadDigest({ '2': 'two', '10': 'ten', '1': 'one' }), automationArchivePayloadDigest(JSON.parse('{"10":"ten","1":"one","2":"two"}')));
  const foreign = structuredClone(s); foreign.workspace.id = 'other-tenant';
  const other = planAutomationRetention(foreign, { now: NOW, recentCompletedLimit: 0 });
  assert.notEqual(other.archiveCandidates[0].reference.recordId, candidate.reference.recordId);
  assert.equal(applyAutomationRetention(plan, { acknowledgedArchives: acknowledge(other) }).compacted, 0);
});

test('planning is pure and batches at most 200 archive candidates without network/timers', t => {
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected network'); });
  const timers = t.mock.method(globalThis, 'setTimeout', () => { throw new Error('unexpected timer'); });
  const s = freeze(state(Array.from({ length: 426 }, (_, i) => run(`batch-${i}`, i))));
  const before = JSON.stringify(s), plan = planAutomationRetention(s, { now: NOW });
  assert.equal(plan.archiveCandidates.length, 401);
  assert.deepEqual(plan.archiveBatches.map(batch => batch.length), [200, 200, 1]);
  assert.equal(plan.archiveBatchSize, AUTOMATION_ARCHIVE_BATCH_SIZE);
  assert.equal(applyAll(plan).automationRuns.length, 426);
  assert.equal(JSON.stringify(s), before);
  assert.equal(network.mock.callCount(), 0); assert.equal(timers.mock.callCount(), 0);
  assert.equal(plan.safeguards.writesPerformed, 0);
});

test('invalid scope/options fail closed and non-JSON payloads stay fully retained', () => {
  assert.throws(() => planAutomationRetention(state(), { now: '2026-02-30T00:00:00Z' }));
  assert.throws(() => planAutomationRetention(state(), { recentCompletedLimit: -1 }));
  const badZone = state(); badZone.autopilot.timeZone = 'invalid-zone';
  assert.throws(() => planAutomationRetention(badZone), { code: 'RETENTION_INVALID_TIME_ZONE' });
  assert.throws(() => planAutomationRetention({ ...state(), tenantId: 'foreign' }), { code: 'WORKSPACE_MISMATCH' });
  const long = state(); long.workspace.id = 'w'.repeat(256);
  assert.equal(planAutomationRetention(long).workspaceId, long.workspace.id);
  const bad = run('non-json', 30); bad.value = undefined;
  const s = state([run('latest'), bad]);
  const plan = planAutomationRetention(s, { now: NOW, recentCompletedLimit: 0 });
  assert.equal(plan.archiveCandidates.length, 0);
  assert.equal(applyAll(plan).automationRuns[1], bad);
  assert.deepEqual(applyAll(planAutomationRetention({ workspace: { id: 'empty' } })).automationRuns, []);
});

test('archive batching bounds the actual UTF-8 request body, including row wrappers and array punctuation', () => {
  const s = state([run('latest'), ...Array.from({ length: 6 }, (_, i) => run(`utf8-${i}`, 30 + i, { evidence: [{ detail: '£'.repeat(180000) }] }))]);
  const plan = planAutomationRetention(s, { now: NOW, recentCompletedLimit: 0 });
  assert.deepEqual(plan.archiveBatches.map(batch => batch.length), [2, 2, 2]);
  for (const [index, batch] of plan.archiveBatches.entries()) {
    const body = JSON.stringify(batch.map(candidate => candidate.row));
    assert.equal(plan.archiveBatchMetadata[index].requestBodyBytes, Buffer.byteLength(body));
    assert.ok(Buffer.byteLength(body) <= AUTOMATION_ARCHIVE_BATCH_BYTES);
    assert.ok(body.length < Buffer.byteLength(body), 'UTF-8 byte accounting is not character counting');
    assert.equal(plan.archiveBatchMetadata[index].isolatedLargeRow, false);
  }
});

test('a large single body is isolated, while over-ceiling payloads remain full with a pending reason', () => {
  const large = run('large', 30, { evidence: [{ detail: 'L'.repeat(AUTOMATION_ARCHIVE_BATCH_BYTES + 100) }] });
  const tooLarge = run('too-large', 31, { evidence: [{ detail: 'X'.repeat(AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES) }] });
  const s = state([run('latest'), run('small-a', 28), large, run('small-b', 29), tooLarge]);
  const plan = planAutomationRetention(s, { now: NOW, recentCompletedLimit: 0 });
  assert.deepEqual(plan.archiveBatches.map(batch => batch.length), [1, 1, 1]);
  assert.equal(plan.archiveBatchMetadata[1].isolatedLargeRow, true);
  assert.ok(plan.archiveBatchMetadata[1].requestBodyBytes > AUTOMATION_ARCHIVE_BATCH_BYTES);
  assert.ok(plan.archiveBatchMetadata[1].requestBodyBytes <= AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES);
  assert.equal(plan.archiveCandidates.some(candidate => candidate.row.payload.id === tooLarge.id), false);
  assert.deepEqual(plan.pending.map(item => [item.runId, item.reason]), [['too-large', 'ARCHIVE_PAYLOAD_TOO_LARGE']]);
  assert.ok(plan.pending[0].requestBodyBytes > AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES, 'row overhead counts against the single body ceiling');
  const result = applyAll(plan);
  assert.equal(result.automationRuns.at(-1), tooLarge);
  assert.equal(result.pendingArchives, 1);
  assert.equal(result.pendingReasons[0].reason, 'ARCHIVE_PAYLOAD_TOO_LARGE');
  assert.equal(result.compacted, 3);
});

test('byte limits include exact one-MiB/two-MiB boundaries and reject the next byte', () => {
  const base = run('boundary', 30, { evidence: [{ detail: 'B'.repeat(1024) }] });
  const makePlan = row => planAutomationRetention(state([run('latest'), row]), { now: NOW, recentCompletedLimit: 0 });
  const overhead = makePlan(base).archiveCandidates[0].requestBodyBytes - 1024;
  for (const bytes of [AUTOMATION_ARCHIVE_BATCH_BYTES, AUTOMATION_ARCHIVE_BATCH_BYTES + 1, AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES, AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES + 1]) {
    const plan = makePlan({ ...base, evidence: [{ detail: 'A'.repeat(bytes - overhead) }] });
    if (bytes > AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES) {
      assert.equal(plan.archiveCandidates.length, 0);
      assert.equal(plan.pending[0].requestBodyBytes, bytes);
    } else {
      assert.equal(plan.archiveCandidates[0].requestBodyBytes, bytes);
      assert.equal(plan.archiveBatchMetadata[0].requestBodyBytes, bytes);
      assert.equal(plan.archiveBatchMetadata[0].isolatedLargeRow, bytes > AUTOMATION_ARCHIVE_BATCH_BYTES);
    }
  }
});

test('dense null arrays fitting the compact write body cannot strand an oversized JSONB read', () => {
  const payload = run('dense-null', 30, { evidence: Array(400000).fill(null) });
  const s = state([run('latest'), payload]);
  const plan = planAutomationRetention(s, { now: NOW, recentCompletedLimit: 0 });
  assert.equal(plan.archiveCandidates.length, 0);
  assert.equal(plan.pending[0].reason, 'ARCHIVE_READ_ENVELOPE_TOO_LARGE');
  assert.ok(plan.pending[0].requestBodyBytes < AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES);
  assert.ok(plan.pending[0].estimatedReadBodyBytes > 2400000);
  assert.ok(plan.pending[0].estimatedReadBodyBytes > AUTOMATION_ARCHIVE_READ_BODY_MAX_BYTES);
  const result = applyAll(plan);
  assert.equal(result.automationRuns[1], payload);
  assert.equal(result.compacted, 0);
  assert.equal(result.pendingArchives, 1);
});

test('read envelope bounds PostgreSQL numeric exponent expansion including subnormals', () => {
  const row = { workspace_id: 'tenant-retention', collection: 'automationRuns', record_id: 'automation-v1:' + '0'.repeat(64), payload: 0 };
  const fixed = estimateAutomationArchiveReadBodyBytes(row) - 1;
  for (const [value, numericBytes] of [[1e308, 309], [-1e308, 310], [1e21, 22], [1e-7, 9], [Number.MIN_VALUE, 326], [-Number.MIN_VALUE, 327], [Number.MAX_VALUE, 309], [1.234e-7, 12], [0.000001, 8], [-0, 1]]) {
    assert.equal(estimateAutomationArchiveReadBodyBytes({ ...row, payload: value }), fixed + numericBytes, String(value));
  }
  for (const value of [1e308, -1e308, Number.MIN_VALUE, -Number.MIN_VALUE]) {
    const payload = run('expanded-numeric', 30, { evidence: Array(7000).fill(value) });
    const plan = planAutomationRetention(state([run('latest'), payload]), { now: NOW, recentCompletedLimit: 0 });
    assert.equal(plan.archiveCandidates.length, 0);
    assert.equal(plan.pending[0].reason, 'ARCHIVE_READ_ENVELOPE_TOO_LARGE');
    assert.ok(plan.pending[0].requestBodyBytes < 100000);
    assert.ok(plan.pending[0].estimatedReadBodyBytes > AUTOMATION_ARCHIVE_READ_BODY_MAX_BYTES);
    assert.equal(applyAll(plan).automationRuns[1], payload);
  }
});

test('read bounds count escaped UTF-8 keys/values and every PostgreSQL separator', () => {
  const row = { workspace_id: '租户🚀', collection: 'automationRuns', record_id: 'automation-v1:' + '0'.repeat(64), payload: { '雪🚀': '雪🚀\u2028\n\t\\"/', empty: [], nested: [null, true, false, { value: 'é' }] } };
  // Explicit PostgreSQL-style serialization, including outer envelope. The
  // estimator reserves another two bytes beyond this body for a possible CRLF.
  const payload = '{' + JSON.stringify('雪🚀') + ': ' + JSON.stringify(row.payload['雪🚀']) + ', "empty": [], "nested": [null, true, false, {"value": "é"}]}';
  const body = '[{"workspace_id": ' + JSON.stringify(row.workspace_id) + ', "collection": "automationRuns", "record_id": ' + JSON.stringify(row.record_id) + ', "payload": ' + payload + '}]';
  assert.equal(estimateAutomationArchiveReadBodyBytes(row), Buffer.byteLength(body) + 2);
  assert.ok(Buffer.byteLength(body) > body.length);
});

test('read admission accepts its exact bounded envelope ceiling and retains the next byte', () => {
  const base = run('read-boundary', 30, { evidence: Array(200).fill(null), description: '' });
  const makePlan = payload => planAutomationRetention(state([run('latest'), payload]), { now: NOW, recentCompletedLimit: 0 });
  const baseReadBytes = makePlan(base).archiveCandidates[0].estimatedReadBodyBytes;
  for (const bytes of [AUTOMATION_ARCHIVE_READ_BODY_MAX_BYTES, AUTOMATION_ARCHIVE_READ_BODY_MAX_BYTES + 1]) {
    const payload = { ...base, description: 'A'.repeat(bytes - baseReadBytes) };
    const plan = makePlan(payload);
    if (bytes <= AUTOMATION_ARCHIVE_READ_BODY_MAX_BYTES) {
      assert.equal(plan.archiveCandidates[0].estimatedReadBodyBytes, bytes);
      assert.ok(plan.archiveCandidates[0].requestBodyBytes < AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES);
      assert.equal(applyAll(plan).compacted, 1);
    } else {
      assert.equal(plan.archiveCandidates.length, 0);
      assert.equal(plan.pending[0].reason, 'ARCHIVE_READ_ENVELOPE_TOO_LARGE');
      assert.equal(plan.pending[0].estimatedReadBodyBytes, bytes);
      assert.ok(plan.pending[0].requestBodyBytes < AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES);
      assert.equal(applyAll(plan).automationRuns[1], payload);
    }
  }
});

test('long run IDs cannot make the final API response exceed the same bounded read cap', () => {
  const base = run('R'.repeat(180), 30, { evidence: [{ detail: 'B'.repeat(1024) }] });
  const makePlan = payload => planAutomationRetention(state([run('latest'), payload]), { now: NOW, recentCompletedLimit: 0 });
  const candidate = makePlan(base).archiveCandidates[0];
  assert.equal(candidate.responseBodyBytes, estimateAutomationArchiveResponseBodyBytes(candidate.row));
  for (const bytes of [AUTOMATION_ARCHIVE_READ_BODY_MAX_BYTES, AUTOMATION_ARCHIVE_READ_BODY_MAX_BYTES + 1]) {
    const payload = { ...base, evidence: [{ detail: 'A'.repeat(bytes - candidate.responseBodyBytes - AUTOMATION_ARCHIVE_READ_FRAMING_BYTES + 1024) }] };
    const plan = makePlan(payload);
    if (bytes <= AUTOMATION_ARCHIVE_READ_BODY_MAX_BYTES) {
      assert.equal(plan.archiveCandidates[0].estimatedResponseBodyBytes, bytes);
      assert.equal(plan.archiveCandidates[0].responseBodyBytes, bytes - AUTOMATION_ARCHIVE_READ_FRAMING_BYTES);
      assert.ok(plan.archiveCandidates[0].requestBodyBytes < AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES);
      assert.ok(plan.archiveCandidates[0].estimatedReadBodyBytes < AUTOMATION_ARCHIVE_READ_BODY_MAX_BYTES);
    } else {
      assert.equal(plan.archiveCandidates.length, 0);
      assert.equal(plan.pending[0].reason, 'ARCHIVE_API_ENVELOPE_TOO_LARGE');
      assert.equal(plan.pending[0].estimatedResponseBodyBytes, bytes);
      assert.equal(applyAll(plan).automationRuns[1], payload);
    }
  }
});

test('historical failed/blocked growth retains the latest run and archives the rest immutably', () => {
  const oldRuns = Array.from({ length: 500 }, (_, i) => run(`old-error-${i}`, i, { status: i % 2 ? 'BLOCKED' : 'FAILED', errorCode: 'READ_FAILED',
    startedAt: new Date(Date.parse('2026-10-01T18:00:00Z') - i * 60000).toISOString(),
    completedAt: new Date(Date.parse('2026-10-01T18:00:30Z') - i * 60000).toISOString(), evidence: [{ detail: 'E'.repeat(4096) }] }));
  const s = state(oldRuns), before = JSON.stringify(s);
  assert.ok(Buffer.byteLength(before) > AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES);
  const plan = planAutomationRetention(s, { now: NOW });
  assert.equal(plan.archiveCandidates.length, 499);
  assert.ok(plan.archiveCandidates.every(candidate => candidate.targetAction === 'archive-only'));
  assert.deepEqual(plan.archiveCandidates.map(candidate => candidate.row.payload.id), oldRuns.slice(1).map(run => run.id));
  const unacknowledged = applyAutomationRetention(plan);
  assert.equal(unacknowledged.automationRuns.length, 500);
  assert.ok(unacknowledged.automationRuns.every((run, index) => run === oldRuns[index]));
  const staged = applyAll(plan);
  assert.equal(staged.evicted, 499);
  assert.equal(staged.compacted, 0, 'failed and blocked rows never become stubs');
  assert.deepEqual(staged.automationRuns, [oldRuns[0]]);
  assert.equal(staged.automationRuns[0], oldRuns[0]);
  assert.equal(JSON.stringify(s), before, 'a failed CAS can discard staging without losing evidence');
  s._revision = 'a-newer-writer';
  assert.throws(() => applyAll(plan), { code: 'RETENTION_PLAN_STALE' });
});

test('errors still in UTC or daily-brief local quota stay full; active/unknown/malformed errors never age out', () => {
  const now = new Date('2026-10-06T00:05:00Z');
  const rows = [
    run('newest-error', 0, { ruleId: 'dailyOpsBrief', status: 'FAILED', errorCode: 'READ_FAILED', startedAt: '2026-10-05T23:40:00Z', completedAt: '2026-10-05T23:41:00Z' }),
    run('local-quota-error', 0, { ruleId: 'dailyOpsBrief', status: 'BLOCKED', errorCode: 'AUTH_REQUIRED', startedAt: '2026-10-05T23:10:00Z', completedAt: '2026-10-05T23:11:00Z' }),
    run('utc-quota-error', 0, { ruleId: 'dailyOpsBrief', status: 'FAILED', errorCode: 'READ_FAILED', startedAt: '2026-10-06T00:00:00Z', completedAt: '2026-10-06T00:01:00Z' }),
    run('old-active', 0, { status: 'IN PROGRESS', startedAt: '2026-10-01T00:00:00Z', completedAt: '2026-10-01T00:01:00Z' }),
    run('old-unknown', 0, { status: 'UNKNOWN', startedAt: '2026-10-01T00:00:00Z', completedAt: '2026-10-01T00:01:00Z' }),
    run('old-malformed', 0, { status: 'FAILED', errorCode: { message: 'malformed' }, startedAt: '2026-10-01T00:00:00Z', completedAt: '2026-10-01T00:01:00Z' })
  ];
  const plan = planAutomationRetention(state(rows), { now, recentCompletedLimit: 0 });
  assert.equal(plan.archiveCandidates.length, 0);
  assert.ok(applyAll(plan).automationRuns.every((run, index) => run === rows[index]));
});

test('small and zero-evidence completed records remain full with no archive IO candidates or failure', () => {
  const small = { id: 'small', ruleId: 'profitGuard', status: 'COMPLETED', startedAt: '2026-10-06T17:00:00Z', completedAt: '2026-10-06T17:01:00Z', evidence: [{ type: 'check', detail: 'ok' }] };
  const zero = { ...small, id: 'zero', evidence: [] };
  const s = state([run('latest'), small, zero]);
  const plan = planAutomationRetention(s, { now: NOW, recentCompletedLimit: 0 });
  assert.equal(plan.archiveCandidates.length, 0);
  assert.deepEqual(plan.archiveBatches, []);
  assert.deepEqual(plan.pending, []);
  assert.equal(plan.summary.notBeneficialFullRecords, 2);
  assert.deepEqual(plan.skipped.map(item => [item.runId, item.reason]), [['small', 'STUB_NOT_SMALLER'], ['zero', 'STUB_NOT_SMALLER']]);
  for (const [index, item] of plan.skipped.entries()) {
    assert.equal(item.originalRunBytes, Buffer.byteLength(JSON.stringify(s.automationRuns[index + 1])));
    assert.ok(item.stubBytes > item.originalRunBytes);
  }
  const result = applyAll(plan);
  assert.equal(result.pendingArchives, 0);
  assert.equal(result.compacted, 0);
  assert.deepEqual(result.skippedReasons, plan.skipped);
  assert.ok(result.automationRuns.every((row, index) => row === s.automationRuns[index]));
});

test('equal-size stubs are skipped; a one-byte actual retained saving is required', () => {
  const base = { id: 'equal-boundary', ruleId: 'profitGuard', status: 'COMPLETED', startedAt: '2026-10-06T17:00:00Z', completedAt: '2026-10-06T17:01:00Z', evidence: [], notes: '' };
  const makePlan = row => planAutomationRetention(state([run('latest'), row]), { now: NOW, recentCompletedLimit: 0 });
  const initial = makePlan(base).skipped[0];
  const padding = initial.stubBytes - initial.originalRunBytes;
  for (const delta of [-1, 0, 1]) {
    const row = { ...base, notes: 'N'.repeat(padding + delta) };
    const plan = makePlan(row);
    if (delta <= 0) {
      assert.equal(plan.archiveCandidates.length, 0);
      assert.equal(plan.skipped[0].originalRunBytes - plan.skipped[0].stubBytes, delta);
      assert.equal(applyAll(plan).automationRuns[1], row);
    } else {
      assert.equal(plan.skipped.length, 0);
      assert.equal(plan.archiveCandidates[0].retainedBytesSaved, 1);
      const result = applyAll(plan);
      assert.equal(result.compacted, 1);
      assert.equal(Buffer.byteLength(JSON.stringify(row)) - Buffer.byteLength(JSON.stringify(result.automationRuns[1])), 1);
      assert.equal(result.automationRuns[1].evidenceCount, 0);
      assert.equal(automationEvidenceCount(result.automationRuns[1], plan.workspaceId), 0);
    }
  }
});

test('small records can still leave hot state by confirmed age-based archive-only eviction', () => {
  const small = { id: 'old-small', ruleId: 'profitGuard', status: 'COMPLETED', startedAt: '2026-10-01T17:00:00Z', completedAt: '2026-10-01T17:01:00Z', evidence: [] };
  const s = state([run('latest'), small]);
  const plan = planAutomationRetention(s, { now: NOW, recentCompletedLimit: 0 });
  assert.equal(plan.skipped.length, 0);
  assert.equal(plan.archiveCandidates.length, 1);
  assert.equal(plan.archiveCandidates[0].targetAction, 'archive-only');
  assert.equal(plan.archiveCandidates[0].stubBytes, null);
  assert.equal(applyAutomationRetention(plan).automationRuns[1], small);
  const result = applyAll(plan);
  assert.equal(result.evicted, 1);
  assert.equal(result.compacted, 0);
});

test('aggregate hot bytes never increase from mixed small/large/UTF-8 quota-row stubbing', () => {
  const rows = [run('latest'), ...Array.from({ length: 60 }, (_, i) => run(`mixed-${i}`, i + 1, {
    evidence: i % 5 === 0 ? [] : [{ detail: (i % 2 ? 'x' : '雪🚀').repeat([0, 1, 64, 128, 256, 512, 1024, 4096][i % 8]) }]
  }))];
  const s = state(rows), plan = planAutomationRetention(s, { now: NOW, recentCompletedLimit: 0 });
  assert.ok(plan.archiveCandidates.length > 0);
  assert.ok(plan.skipped.length > 0);
  assert.equal(plan.pending.length, 0);
  const result = applyAll(plan);
  assert.equal(result.automationRuns.length, rows.length);
  assert.equal(result.evicted, 0);
  let saved = 0;
  for (const [index, retained] of result.automationRuns.entries()) {
    if (isAutomationArchiveStub(retained, s.workspace.id)) {
      const delta = Buffer.byteLength(JSON.stringify(rows[index])) - Buffer.byteLength(JSON.stringify(retained));
      assert.ok(delta > 0);
      saved += delta;
    } else assert.equal(retained, rows[index]);
  }
  assert.equal(Buffer.byteLength(JSON.stringify(rows)) - Buffer.byteLength(JSON.stringify(result.automationRuns)), saved);
  assert.equal(saved, plan.archiveCandidates.reduce((sum, candidate) => sum + candidate.retainedBytesSaved, 0));
});
