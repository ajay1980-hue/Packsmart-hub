import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { createScheduler } from '../lib/scheduler.mjs';
import { reportingStatusRequest, REPORTING_STATUS_MAX_BYTES, REPORTING_REQUEST_MAX_BYTES, REPORTING_RESPONSE_MAX_BYTES } from '../lib/reporting-status.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

const RPC = 'runvara_commit_reporting_status';
const NOW = '2026-10-07T05:00:00.000Z';
const healthy = () => ({ status: 'connected', detail: 'Reporting refresh completed.', lastSyncAt: NOW, lastFailureAt: null, lastError: null, failures: [] });
async function fixture({ padding = 0 } = {}) {
  const initial = seedWorkspaceState({}, { workspaceId: 'reporting-fixture', email: 'fixture@example.test' });
  initial._revision = randomUUID();
  if (padding) initial.syntheticFixturePayload = 'x'.repeat(padding);
  const fake = fakeSupabase({ initialStates: [initial] });
  const f = { fake, calls: [], intercept: null, workspaceId: initial.workspace.id };
  f.store = createStore({ SUPABASE_URL: 'https://local.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only' }, {
    fetchImpl: async (url, options = {}) => {
      const call = { url: new URL(url), table: new URL(url).pathname.split('/').pop(), method: options.method || 'GET', body: options.body || '', options };
      f.calls.push(call);
      const perform = () => fake.fetchImpl(url, options);
      return f.intercept ? f.intercept(call, perform) : perform();
    }
  });
  f.state = await f.store.get(f.workspaceId);
  f.calls.length = 0;
  return f;
}
const primary = f => f.calls.filter(c => c.table === 'saas_workspace_state' && c.method === 'PATCH');
const reports = f => f.calls.filter(c => c.table === RPC);
const revisions = f => f.calls.filter(c => c.url.searchParams.get('select') === 'revision:state->>_revision');
const bodyBytes = calls => calls.reduce((sum, call) => sum + Buffer.byteLength(call.body), 0);

test('large steady-state save sends one full snapshot and one bounded reporting RPC, preserving all state', async t => {
  const f = await fixture({ padding: 1_400_000 });
  f.state.integrationStatus.shopify = { status: 'connected', fixture: 'sibling retained' };
  await f.store.save(f.workspaceId, f.state);
  const persisted = f.fake.states.get(f.workspaceId);
  assert.equal(primary(f).length, 1);
  assert.equal(reports(f).length, 1);
  const payload = JSON.parse(reports(f)[0].body);
  assert.deepEqual(Object.keys(payload).sort(), ['p_expected_revision','p_next_revision','p_report','p_updated_at','p_workspace_id']);
  assert.ok(bodyBytes(reports(f)) <= REPORTING_REQUEST_MAX_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(payload.p_report)) <= REPORTING_STATUS_MAX_BYTES);
  assert.equal(payload.p_expected_revision, JSON.parse(primary(f)[0].body).state._revision);
  assert.equal(payload.p_next_revision, persisted._revision);
  assert.equal(persisted.syntheticFixturePayload, f.state.syntheticFixturePayload);
  assert.deepEqual(persisted.integrationStatus.shopify, f.state.integrationStatus.shopify);
  assert.equal(persisted.integrationStatus.reporting.status, 'connected');
  assert.equal(f.store.diagnostics().primaryPersistence, true);
  assert.equal(f.state._revision, persisted._revision);
  t.diagnostic(JSON.stringify({ primaryRequests: 1, reportingRequests: 1, primaryBodyBytes: bodyBytes(primary(f)), reportingBodyBytes: bodyBytes(reports(f)) }));
});

test('due scheduler claim and completion retain durability while sending only two full snapshots', async t => {
  const f = await fixture({ padding: 1_400_000 });
  f.state.autopilot.enabled = true;
  for (const key of Object.keys(f.state.automations)) f.state.automations[key] = key === 'profitGuard';
  await f.store.save(f.workspaceId, f.state);
  f.calls.length = 0;
  const scheduler = createScheduler({ store: f.store, integrations: {}, withWorkspaceLock: async (_, fn) => fn(), currentBrief: () => ({}), enabled: false });
  const result = await scheduler.runWorkspace(f.workspaceId);
  assert.equal(result.skipped, false);
  assert.equal(primary(f).length, 2);
  assert.equal(reports(f).length, 2);
  assert.equal(JSON.parse(primary(f)[0].body).state.automationRuns[0].status, 'IN PROGRESS');
  assert.notEqual(f.fake.states.get(f.workspaceId).automationRuns[0].status, 'IN PROGRESS');
  assert.ok(reports(f).every(c => Buffer.byteLength(c.body) <= REPORTING_REQUEST_MAX_BYTES));
  t.diagnostic(JSON.stringify({ fullSnapshots: primary(f).length, fullSnapshotBytes: bodyBytes(primary(f)), reportBytes: bodyBytes(reports(f)) }));
  f.calls.length = 0;
  const skipped = await scheduler.runWorkspace(f.workspaceId);
  assert.equal(skipped.skipped, true);
  assert.equal(f.calls.length, 0, 'Unchanged not-due scheduler work stays in memory');
});

test('reads and unchanged scheduler reads never issue the reporting RPC or any writes', async () => {
  const f = await fixture();
  await f.store.save(f.workspaceId, f.state);
  f.calls.length = 0;
  await f.store.get(f.workspaceId);
  await f.store.getIdentity(f.workspaceId);
  await f.store.getForScheduler(f.workspaceId);
  await f.store.listWorkspaceIds();
  assert.ok(f.calls.every(c => c.method === 'GET'));
});

test('mirror failures remain durably degraded with exact failure evidence and primary success', async () => {
  const f = await fixture();
  f.intercept = (c, perform) => c.table === 'audit_events' ? Response.json({ code: '42501' }, { status: 403 }) : perform();
  await f.store.save(f.workspaceId, f.state);
  const report = f.fake.states.get(f.workspaceId).integrationStatus.reporting;
  assert.equal(report.status, 'degraded');
  assert.equal(report.lastError, '42501');
  assert.deepEqual(report.failures, [{ table: 'audit_events', code: 'SUPABASE_PERSISTENCE_FAILED', httpStatus: 403, databaseCode: '42501' }]);
  assert.equal(f.store.diagnostics().primaryPersistence, true);
  assert.equal(primary(f).length, 1);
});

test('missing RPC and denied RPC leave durable pending status without full-state fallback or false primary failure', async () => {
  for (const [status, code] of [[404, 'PGRST202'], [403, '42501']]) {
    const f = await fixture();
    f.intercept = (c, perform) => c.table === RPC ? Response.json({ code }, { status }) : perform();
    const result = await f.store.save(f.workspaceId, f.state);
    assert.equal(primary(f).length, 1);
    assert.equal(reports(f).length, 1);
    assert.equal(f.fake.states.get(f.workspaceId).integrationStatus.reporting.status, 'degraded');
    assert.match(f.fake.states.get(f.workspaceId).integrationStatus.reporting.detail, /pending/);
    assert.equal(result.integrationStatus.reporting.lastError, 'REPORTING_STATUS_DEFERRED');
    assert.equal(f.store.diagnostics().primaryPersistence, true);
    assert.equal(f.store.diagnostics().lastPrimaryFailureAt, null);
    assert.equal(f.store.schedulerCache.has(f.workspaceId), false);
    assert.equal(f.store.mirrorRevisions.has(f.workspaceId), false);
  }
});

test('reporting CAS conflict cannot overwrite a newer business revision and invalidates stale caches', async () => {
  const f = await fixture();
  const foreignRevision = randomUUID();
  f.intercept = async (c, perform) => {
    if (c.table === RPC) {
      const newer = f.fake.states.get(f.workspaceId);
      newer._revision = foreignRevision;
      newer.settings.marginFloor = 43;
    }
    return perform();
  };
  await f.store.save(f.workspaceId, f.state);
  assert.equal(primary(f).length, 1);
  assert.equal(reports(f).length, 1);
  assert.equal(f.fake.states.get(f.workspaceId)._revision, foreignRevision);
  assert.equal(f.fake.states.get(f.workspaceId).settings.marginFloor, 43);
  assert.equal(f.store.schedulerCache.has(f.workspaceId), false);
  assert.equal(f.store.mirrorDigests.size, 0);
  f.intercept = null;
  const refreshed = await f.store.getForScheduler(f.workspaceId);
  assert.equal(refreshed._revision, foreignRevision);
  assert.equal(refreshed.settings.marginFloor, 43);
});

test('lost reporting acknowledgement resolves by revision-only read without resending or replaying primary work', async () => {
  const f = await fixture();
  f.intercept = async (c, perform) => {
    const result = await perform();
    if (c.table === RPC) throw new TypeError('synthetic lost response');
    return result;
  };
  await f.store.save(f.workspaceId, f.state);
  assert.equal(primary(f).length, 1);
  assert.equal(reports(f).length, 1);
  assert.equal(revisions(f).length, 1);
  assert.equal(f.state._revision, f.fake.states.get(f.workspaceId)._revision);
  assert.equal(f.store.schedulerCache.get(f.workspaceId).state._revision, f.state._revision);
});

test('reporting pre-commit timeout retries identical bounded body only after confirming unchanged revision', async () => {
  const f = await fixture();
  let attempts = 0;
  f.intercept = (c, perform) => { if (c.table === RPC && attempts++ === 0) throw new TypeError('synthetic timeout'); return perform(); };
  await f.store.save(f.workspaceId, f.state);
  assert.equal(primary(f).length, 1);
  assert.equal(reports(f).length, 2);
  assert.equal(reports(f)[0].body, reports(f)[1].body);
  assert.equal(revisions(f).length, 1);
  assert.equal(f.state._revision, f.fake.states.get(f.workspaceId)._revision);
});

test('cancelled reporting statement retries once; persistent cancellation remains deferred without primary replay', async () => {
  for (const failCount of [1, 2]) {
    const f = await fixture();
    let remaining = failCount;
    f.intercept = (c, perform) => c.table === RPC && remaining-- > 0 ? Response.json({ code: '57014' }, { status: 500 }) : perform();
    const result = await f.store.save(f.workspaceId, f.state);
    assert.equal(primary(f).length, 1);
    assert.equal(reports(f).length, 2);
    assert.equal(reports(f)[0].body, reports(f)[1].body);
    assert.equal(result.integrationStatus.reporting.status, failCount === 1 ? 'connected' : 'degraded');
    assert.equal(f.store.diagnostics().primaryPersistence, true);
  }
});

test('unresolved reporting timeout or a foreign revision never authorizes a retry', async () => {
  for (const foreign of [false, true]) {
    const f = await fixture();
    f.intercept = (c, perform) => {
      if (c.table === RPC) { if (foreign) f.fake.states.get(f.workspaceId)._revision = randomUUID(); throw new TypeError('lost response'); }
      if (!foreign && c.url.searchParams.get('select') === 'revision:state->>_revision') throw new TypeError('read failed');
      return perform();
    };
    await f.store.save(f.workspaceId, f.state);
    assert.equal(primary(f).length, 1);
    assert.equal(reports(f).length, 1);
    assert.equal(f.store.schedulerCache.has(f.workspaceId), false);
  }
});

test('malformed revision-only reads cannot turn an uncommitted reporting request into confirmed success', async () => {
  const shapes = [revision => ({ 0: { revision } }), revision => [{ revision }, { revision }], revision => [{ revision, state: {} }],
    () => [{}], () => [{ revision: 123 }], () => [{ revision: '' }], () => [null]];
  for (const shape of shapes) {
    const f = await fixture();
    let attemptedRevision;
    f.intercept = (c, perform) => {
      if (c.table === RPC) { attemptedRevision = JSON.parse(c.body).p_next_revision; throw new TypeError('not committed'); }
      if (c.url.searchParams.get('select') === 'revision:state->>_revision') return Response.json(shape(attemptedRevision));
      return perform();
    };
    const result = await f.store.save(f.workspaceId, f.state);
    assert.equal(result.integrationStatus.reporting.lastError, 'REPORTING_STATUS_DEFERRED');
    assert.equal(primary(f).length, 1);
    assert.equal(reports(f).length, 1);
    assert.notEqual(f.state._revision, attemptedRevision);
    assert.notEqual(f.fake.states.get(f.workspaceId)._revision, attemptedRevision);
    assert.equal(f.store.schedulerCache.has(f.workspaceId), false);
    assert.equal(f.store.mirrorRevisions.has(f.workspaceId), false);
  }
});

test('body-stream interruption and lost acknowledgement after cancelled-statement retry safely defer without fallback', async () => {
  for (const failure of ['body-stream', 'cancelled-then-lost']) {
    const f = await fixture();
    let reportAttempts = 0;
    f.intercept = async (c, perform) => {
      if (c.table !== RPC) return perform();
      reportAttempts++;
      if (failure === 'cancelled-then-lost' && reportAttempts === 1) return Response.json({ code: '57014' }, { status: 500 });
      await perform();
      if (failure === 'cancelled-then-lost') throw new TypeError('lost retry acknowledgement');
      return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('interrupted response body')); } }));
    };
    const result = await f.store.save(f.workspaceId, f.state);
    assert.equal(result.integrationStatus.reporting.lastError, 'REPORTING_STATUS_DEFERRED');
    assert.equal(primary(f).length, 1);
    assert.equal(reports(f).length, failure === 'body-stream' ? 1 : 2);
    assert.equal(f.store.schedulerCache.has(f.workspaceId), false);
    assert.equal(f.store.diagnostics().primaryPersistence, true);
    assert.equal(f.fake.states.get(f.workspaceId).integrationStatus.reporting.status, 'connected', 'Lost acknowledgement may follow a committed report');
    assert.notEqual(result._revision, f.fake.states.get(f.workspaceId)._revision, 'An unconfirmed revision must not be presented as confirmed');
  }
});

test('malformed, wrong-tenant and oversized RPC acknowledgements never establish cache trust', async () => {
  const replies = [null, {}, [{ workspace_id: 'other' }], [{ workspace_id: 'reporting-fixture', state: {} }],
    [{ workspace_id: 'reporting-fixture' }, { workspace_id: 'reporting-fixture' }], 'x'.repeat(REPORTING_RESPONSE_MAX_BYTES + 1)];
  for (const reply of replies) {
    const f = await fixture();
    f.intercept = (c, perform) => c.table === RPC ? typeof reply === 'string' ? new Response(reply) : Response.json(reply) : perform();
    const result = await f.store.save(f.workspaceId, f.state);
    assert.equal(result.integrationStatus.reporting.lastError, 'REPORTING_STATUS_DEFERRED');
    assert.equal(primary(f).length, 1);
    assert.equal(reports(f).length, 1);
    assert.equal(f.store.schedulerCache.has(f.workspaceId), false);
  }
});

test('primary acknowledgement validation and lost-ack recovery remain fenced before mirroring', async () => {
  for (const reply of [[], null, {}, [{ workspace_id: 'other' }], [{ workspace_id: 'reporting-fixture', state: {} }]]) {
    const f = await fixture();
    f.intercept = (c, perform) => c.method === 'PATCH' ? Response.json(reply) : perform();
    await assert.rejects(f.store.save(f.workspaceId, f.state), e => e.code === (Array.isArray(reply) && !reply.length ? 'STATE_CONFLICT' : 'SUPABASE_PERSISTENCE_RESPONSE_INVALID'));
    assert.equal(reports(f).length, 0);
    assert.equal(primary(f).length, 1);
  }
  const f = await fixture();
  f.intercept = async (c, perform) => { const result = await perform(); if (c.method === 'PATCH') throw new TypeError('lost primary response'); return result; };
  await f.store.save(f.workspaceId, f.state);
  assert.equal(primary(f).length, 1);
  assert.equal(reports(f).length, 1);
  assert.equal(revisions(f).length, 1);
});

test('invalid reporting input is rejected before transmission without silently dropping fields or evidence', () => {
  const expected = randomUUID(), next = randomUUID();
  const invalid = [null, [], { ...healthy(), workspaceId: 'other' }, { ...healthy(), failures: Array(33).fill({}) },
    { ...healthy(), detail: 'x'.repeat(321) }, { ...healthy(), lastFailureAt: '2026-10-07T06:00:00+01:00' },
    { ...healthy(), lastFailureAt: '2026-02-30T05:00:00.000Z' },
    { ...healthy(), status: 'degraded', lastError: '42501', failures: [{ table: 'users', code: 'SUPABASE_PERSISTENCE_FAILED', httpStatus: 403, databaseCode: '42501', raw: 'private' }] }];
  for (const report of invalid) assert.throws(() => reportingStatusRequest('fixture', expected, next, report, NOW), e => e.code === 'REPORTING_STATUS_INPUT_INVALID');
  const large = { ...healthy(), detail: '雪'.repeat(320), status: 'degraded', lastError: 'PGRST12345', failures: Array.from({ length: 32 }, () => ({ table: 'a'.repeat(80), code: 'A'.repeat(80), httpStatus: 500, databaseCode: 'PGRST12345' })) };
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > REPORTING_STATUS_MAX_BYTES);
  assert.throws(() => reportingStatusRequest('fixture', expected, next, large, NOW), e => e.code === 'REPORTING_STATUS_INPUT_INVALID');
  assert.throws(() => reportingStatusRequest('fixture', expected, expected, healthy(), NOW), e => e.code === 'REPORTING_STATUS_INPUT_INVALID');
  assert.throws(() => reportingStatusRequest('fixture', [expected], next, healthy(), NOW), e => e.code === 'REPORTING_STATUS_INPUT_INVALID');
  assert.throws(() => reportingStatusRequest('fixture', expected, [next], healthy(), NOW), e => e.code === 'REPORTING_STATUS_INPUT_INVALID');
});

test('historical noncanonical reporting timestamps stay visible as deferred instead of being rewritten', async () => {
  const f = await fixture();
  const original = '2026-10-06T23:00:00+01:00';
  f.state.integrationStatus.reporting = { ...healthy(), lastFailureAt: original };
  const result = await f.store.save(f.workspaceId, f.state);
  assert.equal(primary(f).length, 1);
  assert.equal(reports(f).length, 0);
  assert.equal(f.fake.states.get(f.workspaceId).integrationStatus.reporting.lastFailureAt, original);
  assert.equal(result.integrationStatus.reporting.lastError, 'REPORTING_STATUS_DEFERRED');
  assert.equal(f.store.schedulerCache.has(f.workspaceId), false);
});

test('reporting recovery meters each real attempt once under reporting scope and preserves full primary snapshot samples', async () => {
  for (const failure of ['lost-after-commit', 'network-before-commit', 'cancelled-statement']) {
    const f = await fixture({ padding: 20_000 });
    const before = f.store.activitySnapshot(f.workspaceId);
    let reportAttempts = 0;
    f.intercept = async (call, perform) => {
      if (call.table !== RPC || reportAttempts++ > 0) return perform();
      if (failure === 'lost-after-commit') {
        await perform();
        throw new TypeError('synthetic lost reporting acknowledgement');
      }
      if (failure === 'network-before-commit') throw new TypeError('synthetic reporting connection failure');
      return Response.json({ code: '57014' }, { status: 500 });
    };
    const saved = await f.store.save(f.workspaceId, f.state);
    const observed = f.store.activitySnapshot(f.workspaceId);
    const reportCount = failure === 'lost-after-commit' ? 1 : 2;
    assert.equal(primary(f).length, 1);
    assert.equal(reports(f).length, reportCount);
    assert.equal(observed.db.attempted - before.db.attempted, f.calls.length);
    assert.equal(observed.db.completed - before.db.completed, f.calls.length);
    assert.equal(observed.db.operations.state_commit - before.db.operations.state_commit, 1);
    assert.equal(observed.db.operations.reporting_commit - before.db.operations.reporting_commit, reportCount);
    assert.equal(observed.db.operations.state_read - before.db.operations.state_read, revisions(f).length);
    assert.equal(observed.db.retries.primary_network_reconciled, 0);
    assert.equal(observed.db.retries.primary_statement_cancelled, 0);
    assert.equal(observed.db.retries.reporting_network_reconciled, failure === 'network-before-commit' ? 1 : 0);
    assert.equal(observed.db.retries.reporting_statement_cancelled, failure === 'cancelled-statement' ? 1 : 0);
    assert.equal(observed.db.requestBody.bytes - before.db.requestBody.bytes, bodyBytes(f.calls));
    const primaryStateBytes = Buffer.byteLength(JSON.stringify(JSON.parse(primary(f)[0].body).state));
    assert.equal(observed.hotState.attempted.bytes, primaryStateBytes);
    assert.equal(observed.hotState.confirmed.bytes, primaryStateBytes);
    assert.equal(observed.hotState.attempted.observations, 1);
    assert.equal(observed.hotState.confirmed.observations, 1);
    assert.equal(f.store.telemetry.stateBytes, primaryStateBytes);
    assert.ok(primaryStateBytes > bodyBytes(reports(f)), 'compact report bodies cannot become full-state storage samples');
    assert.equal(f.store.activitySnapshot('other-tenant').db.attempted, null);
    assert.equal(f.store.activityMeter.instanceSnapshot().unattributed.db.attempted, 0);
    assert.equal(saved.integrationStatus.reporting.status, 'connected');
    assert.equal(f.store.diagnostics().primaryPersistence, true);
    assert.equal(f.store.diagnostics().lastPrimaryFailureAt, null);
    if (reportCount === 2) assert.equal(reports(f)[0].body, reports(f)[1].body);
  }
});

test('narrow reporting success or unverifiable response cannot repair primary health or create hot-state growth', async () => {
  for (const invalidBody of [false, true]) {
    const f = await fixture();
    await f.store.save(f.workspaceId, f.state);
    const before = f.store.activitySnapshot(f.workspaceId);
    f.calls.length = 0;
    f.store.primaryPersistenceHealthy = false;
    f.store.telemetry.lastPrimaryWriteAt = '2026-10-01T00:00:00.000Z';
    f.store.telemetry.lastPrimaryFailureAt = '2026-10-02T00:00:00.000Z';
    const lastSuccessfulWriteAt = f.store.telemetry.lastSuccessfulWriteAt;
    if (invalidBody) f.intercept = call => {
      assert.equal(call.table, RPC);
      return new Response('private unconfirmed reporting body');
    };
    const request = f.store.commitReportingStatus(f.workspaceId, healthy(), f.state._revision, randomUUID());
    if (invalidBody) await assert.rejects(request, { code: 'SUPABASE_RESPONSE_INVALID' });
    else await request;
    const after = f.store.activitySnapshot(f.workspaceId);
    assert.equal(primary(f).length, 0);
    assert.equal(reports(f).length, 1);
    assert.equal(after.db.attempted - before.db.attempted, 1);
    assert.equal(after.db.operations.reporting_commit - before.db.operations.reporting_commit, 1);
    assert.equal(after.db.operations.state_commit, before.db.operations.state_commit);
    assert.deepEqual(after.hotState, before.hotState);
    assert.equal(f.store.diagnostics().primaryPersistence, false);
    assert.equal(f.store.telemetry.lastPrimaryWriteAt, '2026-10-01T00:00:00.000Z');
    assert.equal(f.store.telemetry.lastPrimaryFailureAt, '2026-10-02T00:00:00.000Z');
    if (invalidBody) {
      assert.equal(f.store.telemetry.lastSuccessfulWriteAt, lastSuccessfulWriteAt);
      assert.equal(after.db.outcomes.invalid_response - before.db.outcomes.invalid_response, 1);
      assert.doesNotMatch(JSON.stringify(after), /private unconfirmed reporting body/);
    }
  }
});
