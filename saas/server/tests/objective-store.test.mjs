import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { upsertBusinessObjective } from '../lib/business-objectives.mjs';
import { buildObjectiveReview } from '../lib/objective-review.mjs';

function fixture(handler) {
  const calls = [];
  const store = createStore({ SUPABASE_URL: 'https://objective-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'private-service-test-key' }, {
    fetchImpl: async (url, options = {}) => { calls.push({ url: new URL(url), ...options }); return Response.json(await handler(calls.at(-1), calls.length)); }
  });
  return { store, calls };
}
function records() {
  const state = seedWorkspaceState({}, { workspaceId: 'alpha', email: 'alpha@test.local', passwordHash: 'fixture' });
  const objective = upsertBusinessObjective(state, { title: 'Review', metric: 'orders', baseline: 0, target: 10,
    direction: 'increase', startsAt: '2025-01-01T00:00:00.000Z', endsAt: '2034-01-01T00:00:00.000Z', limits: {} }, { workspaceId: 'alpha' });
  const report = buildObjectiveReview(state, { objectiveId: objective.id, objectiveRevision: 1, jobId: 'job_test' }, { workspaceId: 'alpha' });
  const job = { id: 'job_test', workspace_id: 'alpha', type: 'objective_prepare', provider: null, ai_units: 0, ai_provider: null, ai_model: null,
    ai_tier: 'deterministic', status: 'running', actor: state.users[0].id, worker_id: 'worker_test', attempts: 1, max_attempts: 3,
    lease_until: new Date(Date.now() + 300000).toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    payload: { schema: 'runvara-objective-prepare/v1', objectiveId: objective.id, objectiveRevision: 1,
      typedInputFingerprint: report.sourceAsOf.typedInputFingerprint, actorSessionVersion: 1 }, result: report };
  return { job, report };
}

test('objective completion and retry use exact tenant/worker/attempt/lease predicates with byte-identical success bodies', async () => {
  const { job, report } = records();
  const { store, calls } = fixture(() => [{ ...job, status: 'succeeded', result: undefined }]);
  const update = { status: 'succeeded', result: report, completedAt: new Date().toISOString() };
  await store.finishAgentJob(job, update); await store.finishAgentJob(job, update);
  assert.equal(calls.length, 2); assert.equal(calls[0].body, calls[1].body);
  const query = calls[0].url.searchParams;
  assert.equal(calls[0].method, 'PATCH'); assert.equal(query.get('workspace_id'), 'eq.alpha'); assert.equal(query.get('id'), 'eq.job_test');
  assert.equal(query.get('worker_id'), 'eq.worker_test'); assert.equal(query.get('attempts'), 'eq.1'); assert.equal(query.get('status'), 'eq.running');
  assert.deepEqual(query.getAll('lease_until'), [`eq.${job.lease_until}`, 'gt.now']);
  assert.ok(!query.get('select').includes('result')); assert.ok(!query.get('select').includes('*'));
  assert.ok(!calls[0].body.includes('private-service-test-key'));
  const retry = fixture(() => [{ ...job, status: 'queued' }]);
  await retry.store.rescheduleAgentJob(job, { availableAt: new Date().toISOString(), errorCode: 'TEST_RETRY' });
  assert.deepEqual(retry.calls[0].url.searchParams.getAll('lease_until'), [`eq.${job.lease_until}`, 'gt.now']);
});

test('zero-row/lost ownership and mismatched finish rows cannot claim success', async () => {
  const { job, report } = records();
  const empty = fixture(() => []);
  assert.equal(await empty.store.finishAgentJob(job, { status: 'succeeded', result: report }), null);
  for (const value of [[{ ...job, workspace_id: 'beta', status: 'succeeded' }], [{ ...job, status: 'running' }], null, [job, job]]) {
    const { store } = fixture(() => value);
    await assert.rejects(() => store.finishAgentJob(job, { status: 'succeeded', result: report }), e => e.code === 'AGENT_JOB_RESPONSE_INVALID');
  }
});

test('direct job reads are one exact-tenant bounded projection; only explicit report reads select result', async () => {
  const { job } = records(), row = { ...job, status: 'succeeded' };
  const { store, calls } = fixture(() => [row]);
  const status = await store.getAgentJob('alpha', job.id);
  assert.equal(status.result, undefined); assert.equal(calls.length, 1);
  assert.equal(calls[0].url.searchParams.get('workspace_id'), 'eq.alpha');
  assert.equal(calls[0].url.searchParams.get('id'), 'eq.job_test'); assert.equal(calls[0].url.searchParams.get('limit'), '2');
  assert.ok(!calls[0].url.searchParams.get('select').split(',').includes('result'));
  const report = await store.getAgentJob('alpha', job.id, { includeReport: true });
  assert.equal(report.result.jobId, job.id); assert.equal(calls.length, 2);
  assert.ok(calls[1].url.searchParams.get('select').split(',').includes('result'));
  const foreign = fixture(() => [{ ...row, workspace_id: 'beta' }]);
  await assert.rejects(() => foreign.store.getAgentJob('alpha', job.id, { includeReport: true }), e => e.code === 'AGENT_JOB_RESPONSE_INVALID');
  const duplicate = fixture(() => [row, structuredClone(row)]);
  await assert.rejects(() => duplicate.store.getAgentJob('alpha', job.id, { includeReport: true }), e => e.code === 'AGENT_JOB_RESPONSE_INVALID');
});

test('exact job reads reject oversized declared and streamed responses before JSON parsing', async () => {
  for (const includeReport of [false, true]) {
    const maxBytes = includeReport ? 163840 : 16384;
    let bodyRead = false, cancelled = false;
    const declared = createStore({ SUPABASE_URL: 'https://objective-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fixture' }, {
      fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers({ 'content-length': String(maxBytes + 1) }),
        body: { cancel: async () => { cancelled = true; } }, text: async () => { bodyRead = true; return 'not JSON'; } })
    });
    await assert.rejects(() => declared.getAgentJob('alpha', 'job_test', { includeReport }), e => e.code === 'SUPABASE_RESPONSE_TOO_LARGE');
    assert.equal(bodyRead, false); assert.equal(cancelled, true);
    cancelled = false;
    const streamed = createStore({ SUPABASE_URL: 'https://objective-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fixture' }, {
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(maxBytes + 1))); },
        cancel() { cancelled = true; }
      }))
    });
    await assert.rejects(() => streamed.getAgentJob('alpha', 'job_test', { includeReport }), e => e.code === 'SUPABASE_RESPONSE_TOO_LARGE');
    assert.equal(cancelled, true);
  }
});

test('FileStore owns enqueued payloads and finished reports but remains volatile and unable to authorize dispatch', async () => {
  const { job, report } = records(), store = createStore({});
  const payload = structuredClone(job.payload), originalReport = structuredClone(report);
  const queued = { id: job.id, workspaceId: 'alpha', type: 'objective_prepare', provider: null,
    aiProvider: null, aiModel: null, aiTier: 'deterministic', aiUnits: 0, priority: 60, maxAttempts: 3,
    actor: job.actor, payload, idempotencyKey: `objective_prepare:v1:${'a'.repeat(64)}`, concurrencyLimit: 1,
    availableAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await store.enqueueAgentJob('alpha', queued);
  payload.objectiveRevision = 99;
  const retained = await store.getAgentJob('alpha', job.id);
  assert.deepEqual(retained.payload, job.payload);
  retained.payload.actorSessionVersion = 99;
  const [claim] = await store.claimAgentJobs('worker_test');
  await store.finishAgentJob(claim, { status: 'succeeded', result: report, completedAt: new Date().toISOString() });
  report.proposals.push({ forged: true }); report.summary.proposalsReady = 999;
  assert.deepEqual((await store.getAgentJob('alpha', job.id, { includeReport: true })).result, originalReport);
  assert.equal((await store.getAgentJob('alpha', job.id)).payload.actorSessionVersion, 1);
  assert.equal(await createStore({}).getAgentJob('alpha', job.id, { includeReport: true }), null);
  await assert.rejects(() => store.getConnectionWriteContext(), e => e.code === 'WRITE_CONTEXT_UNAVAILABLE');
  store.agentJobs.push(structuredClone(store.agentJobs[0]));
  await assert.rejects(() => store.getAgentJob('alpha', job.id, { includeReport: true }), e => e.code === 'AGENT_JOB_RESPONSE_INVALID');
});

test('objective reports reject tenant/job/source mismatch, unbounded payloads and unsafe proof before storage or return', async () => {
  const { job, report } = records();
  for (const patch of [{ workspaceId: 'beta' }, { jobId: 'job_other' }, { sourceAsOf: { typedInputFingerprint: 'b'.repeat(32) } },
    { specialists: [{}, {}, {}, {}] }, { providerBody: 'secret' }, { objective: { title: 'x'.repeat(65536) } },
    { safeguards: { ...report.safeguards, providerCalls: 1 } }]) {
    const value = { ...report, ...patch };
    const { store, calls } = fixture(() => [{ ...job, status: 'succeeded', result: value }]);
    await assert.rejects(() => store.finishAgentJob(job, { status: 'succeeded', result: value }), e => e.code === 'OBJECTIVE_REVIEW_RESULT_INVALID');
    assert.equal(calls.length, 0);
    await assert.rejects(() => store.getAgentJob('alpha', job.id, { includeReport: true }), e => e.code === 'OBJECTIVE_REVIEW_RESULT_INVALID');
  }
});

test('explicit lists fetch at most two bounded pages, preserve legacy results and never select objective report bodies', async () => {
  const { job } = records();
  const legacy = { id: 'job_legacy', workspace_id: 'alpha', type: 'agent_command', created_at: '2026-01-01T00:00:00.000Z', result: { externalWrites: false, runId: 'run1' } };
  const { store, calls } = fixture(call => call.url.searchParams.get('type') === 'neq.objective_prepare' ? [legacy] : [job]);
  const rows = await store.listAgentJobs('alpha', 100);
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.url.searchParams.get('limit') === '100'));
  assert.equal(calls.find(call => call.url.searchParams.get('type') === 'neq.objective_prepare').url.searchParams.get('select'), '*');
  const compact = calls.find(call => call.url.searchParams.get('type') === 'eq.objective_prepare').url.searchParams.get('select');
  assert.ok(!compact.includes('result')); assert.ok(!compact.includes('payload')); assert.ok(!compact.includes('*'));
  assert.deepEqual(rows.find(row => row.id === legacy.id).result, legacy.result);
  assert.equal(rows.find(row => row.id === job.id).result, undefined);
});

test('store refuses objective enqueue overrides before any network request', async () => {
  const { job } = records(); const { store, calls } = fixture(() => []);
  const queued = { id: job.id, workspaceId: 'alpha', type: 'objective_prepare', provider: null, aiProvider: null, aiModel: null, aiTier: 'deterministic',
    aiUnits: 0, priority: 60, maxAttempts: 3, actor: job.actor, payload: job.payload, idempotencyKey: `objective_prepare:v1:${'a'.repeat(64)}` };
  for (const patch of [{ workspaceId: 'beta' }, { provider: 'openai' }, { aiProvider: 'openai' }, { aiModel: 'paid' }, { aiUnits: '0' },
    { aiUnits: 1 }, { priority: 100 }, { payload: { ...job.payload, raw: 'secret' } }]) {
    await assert.rejects(() => store.enqueueAgentJob('alpha', { ...queued, ...patch }), e => e.code === 'OBJECTIVE_JOB_INPUT_INVALID');
  }
  assert.equal(calls.length, 0);
});
