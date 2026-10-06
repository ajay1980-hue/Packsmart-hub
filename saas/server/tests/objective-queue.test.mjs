import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { createAgentOperations } from '../lib/agent-ops.mjs';
import { upsertBusinessObjective } from '../lib/business-objectives.mjs';
import { buildObjectiveReview, objectiveReviewFingerprint } from '../lib/objective-review.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-objective-queue-'));
  const file = path.join(dir, 'state.json');
  const store = createStore({ SAAS_STATE_FILE: file });
  const state = seedWorkspaceState({}, { workspaceId: 'alpha', email: 'alpha@test.local', passwordHash: 'fixture' });
  state.opportunities = [{ id: 'opp_a', kind: 'operations', present: true, status: 'open', executionCost: 0, effortHours: 1, confidence: 0.8 },
    { id: 'opp_b', kind: 'pricing', present: true, status: 'open', executionCost: 10, effortHours: 2, confidence: 0.7 }];
  state.decisions = []; state.approvals = []; state.exceptions = [];
  state.settings.growthCapacityHours = 10;
  const objective = upsertBusinessObjective(state, { title: 'Review objective', metric: 'contribution_profit', baseline: 10, target: 100,
    direction: 'increase', startsAt: '2025-01-01T00:00:00.000Z', endsAt: '2034-01-01T00:00:00.000Z', limits: { currency: 'GBP' } }, { workspaceId: 'alpha' });
  await store.save('alpha', state);
  await store.save('beta', seedWorkspaceState({}, { workspaceId: 'beta', email: 'beta@test.local', passwordHash: 'fixture' }));
  let timestamp = Date.now(), providerCalls = 0;
  const ops = createAgentOperations({ store, integrations: {}, enabled: false, now: () => timestamp,
    aiProvider: { enhanceCommander() { providerCalls++; throw new Error('Objective jobs cannot enhance'); } },
    withWorkspaceLock: async (_id, callback) => callback() });
  t.after(async () => { ops.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  const input = { objectiveId: objective.id, objectiveRevision: objective.revision };
  const auth = { actorId: state.users[0].id, sessionVersion: state.users[0].sessionVersion };
  return { store, ops, input, auth, file, get providerCalls() { return providerCalls; }, advance(ms) { timestamp += ms; } };
}

test('objective enqueue is typed, zero-provider/unit, idempotent and never saves workspace state', async t => {
  const f = await fixture(t), before = await fs.readFile(f.file, 'utf8');
  f.store.save = () => { throw new Error('Objective enqueue must not save workspace'); };
  f.store.agentOpsUsage = () => { throw new Error('Zero provider work must not read paid usage'); };
  const one = await f.ops.enqueueObjectiveReview('alpha', f.input, f.auth);
  f.advance(1000);
  const two = await f.ops.enqueueObjectiveReview('alpha', f.input, f.auth);
  assert.equal(one.job.id, two.job.id);
  assert.equal(f.store.agentJobs.length, 1);
  const job = f.store.agentJobs[0];
  assert.equal(job.provider, null); assert.equal(job.ai_provider, null); assert.equal(job.ai_model, null);
  assert.equal(job.ai_tier, 'deterministic'); assert.equal(job.ai_units, 0);
  assert.match(job.idempotency_key, /^objective_prepare:v1:[0-9a-f]{64}$/);
  assert.equal(job.actor, f.auth.actorId); assert.equal(job.payload.actorSessionVersion, f.auth.sessionVersion);
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  for (const extra of [{ provider: 'openai' }, { aiUnits: 0 }, { actor: 'other' }, { jobId: 'job_client' },
    { workspaceId: 'beta' }, { idempotencyKey: 'override' }, { payload: {} }, { command: 'publish' }]) {
    await assert.rejects(() => f.ops.enqueueObjectiveReview('alpha', { ...f.input, ...extra }, f.auth), e => e.code === 'OBJECTIVE_JOB_INPUT_INVALID');
  }
  await assert.rejects(() => f.ops.enqueue('alpha', { type: 'objective_prepare', payload: f.input }, f.auth.actorId), e => e.code === 'OBJECTIVE_DEDICATED_ENQUEUE_REQUIRED');
  assert.equal(f.providerCalls, 0);
});

test('typed fingerprint ignores read time, unrelated revision and storage order but tracks evidence/policy/duplicates', async t => {
  const f = await fixture(t), state = await f.store.get('alpha');
  const fingerprint = (s, now = new Date().toISOString()) => objectiveReviewFingerprint(s, f.input, { workspaceId: 'alpha', now });
  const original = fingerprint(state);
  const shuffled = structuredClone(state); shuffled._revision = 'unrelated'; shuffled.workspace.updatedAt = '2040-01-01T00:00:00.000Z'; shuffled.opportunities.reverse();
  assert.equal(fingerprint(shuffled, '2030-01-01T00:00:00.000Z'), original);
  shuffled.opportunities[0].effortHours += 1;
  assert.notEqual(fingerprint(shuffled), original);
  const changed = structuredClone(state); changed.agentSettings.finance.autonomy = 0;
  assert.notEqual(fingerprint(changed), original);
  changed.agentSettings = state.agentSettings; changed.opportunities.push(structuredClone(changed.opportunities[0]));
  assert.notEqual(fingerprint(changed), original);
  assert.equal(fingerprint(state, '2100-01-01T00:00:00.000Z'), null);
});

test('objective execution persists one bounded self-contained job report without audit/work/run mutations or provider calls', async t => {
  const f = await fixture(t);
  const queued = await f.ops.enqueueObjectiveReview('alpha', f.input, f.auth);
  const before = await fs.readFile(f.file, 'utf8');
  f.store.save = () => { throw new Error('Objective execution must not save'); };
  await f.ops.tick();
  const row = f.store.agentJobs[0];
  assert.equal(row.status, 'succeeded'); assert.equal(row.result.jobId, queued.job.id);
  assert.equal(row.result.sourceAsOf.typedInputFingerprint, row.payload.typedInputFingerprint);
  assert.ok(row.result.specialists.length <= 3); assert.ok(Buffer.byteLength(JSON.stringify(row.result)) <= 65536);
  assert.equal(row.result.safeguards.providerCalls, 0); assert.equal(row.result.commercialReady, false);
  assert.equal(f.ops.status.processed, 1); assert.equal(f.providerCalls, 0);
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  const report = await f.ops.objectiveReview('alpha', queued.job.id, { includeReport: true }, f.auth);
  assert.deepEqual(report.report, row.result); assert.equal(report.stale, false);
});

test('status polls use only compact identity/job reads; full evidence is loaded only for explicit report retrieval', async t => {
  const f = await fixture(t), queued = await f.ops.enqueueObjectiveReview('alpha', f.input, f.auth);
  await f.ops.tick();
  const originalGet = f.store.get.bind(f.store);
  let reads = 0; f.store.get = async (...args) => { reads++; return originalGet(...args); };
  for (let i = 0; i < 8; i++) {
    const status = await f.ops.objectiveReview('alpha', queued.job.id, { includeReport: false }, f.auth);
    assert.equal(status.report, undefined); assert.equal(status.stale, null); assert.equal(status.staleReason, 'not_checked');
    assert.ok(Buffer.byteLength(JSON.stringify(status)) <= 2048);
  }
  assert.equal(reads, 0);
  await f.ops.objectiveReview('alpha', queued.job.id, { includeReport: true }, f.auth);
  assert.equal(reads, 1);
  const list = await f.store.listAgentJobs('alpha');
  assert.equal(list[0].result, undefined); assert.equal(list[0].payload, undefined);
  const beta = await originalGet('beta');
  await assert.rejects(() => f.ops.objectiveReview('beta', queued.job.id, {}, { actorId: beta.users[0].id, sessionVersion: 1 }), e => e.code === 'AGENT_JOB_NOT_FOUND');
});

test('fresh actor, objective revision, autonomy and source bindings block obsolete queued reports', async t => {
  for (const change of [state => { state.users[0].active = false; }, state => { state.users[0].role = 'viewer'; },
    state => { state.users[0].sessionVersion++; }, state => { state.businessObjectives[0].revision++; },
    state => { state.agentSettings.commander.enabled = false; }, state => { state.agentSettings.finance.autonomy = 0; },
    state => { state.opportunities[0].effortHours++; }]) {
    const f = await fixture(t); await f.ops.enqueueObjectiveReview('alpha', f.input, f.auth);
    const state = await f.store.get('alpha'); change(state); await f.store.save('alpha', state);
    const before = await fs.readFile(f.file, 'utf8'); await f.ops.tick();
    assert.equal(f.store.agentJobs[0].status, 'blocked'); assert.equal(f.store.agentJobs[0].result, null);
    assert.equal(await fs.readFile(f.file, 'utf8'), before); assert.equal(f.providerCalls, 0);
  }
});

test('uncertain completed write recovers exact result without a second finish or workspace write', async t => {
  const f = await fixture(t); const queued = await f.ops.enqueueObjectiveReview('alpha', f.input, f.auth);
  const original = f.store.finishAgentJob.bind(f.store); let finishes = 0;
  f.store.finishAgentJob = async (...args) => { finishes++; await original(...args); throw Object.assign(new Error('lost reply'), { code: 'SUPABASE_PERSISTENCE_FAILED' }); };
  f.store.save = () => { throw new Error('No workspace write'); };
  await f.ops.tick();
  assert.equal(finishes, 1); assert.equal(f.store.agentJobs[0].status, 'succeeded'); assert.equal(f.ops.status.processed, 1);
  const first = await f.ops.objectiveReview('alpha', queued.job.id, { includeReport: true }, f.auth);
  const second = await f.ops.objectiveReview('alpha', queued.job.id, { includeReport: true }, f.auth);
  assert.deepEqual(first.report, second.report);
});

test('uncommitted completion retries identical identity/body; unresolved outcomes are never downgraded', async t => {
  const f = await fixture(t); await f.ops.enqueueObjectiveReview('alpha', f.input, f.auth);
  const original = f.store.finishAgentJob.bind(f.store), writes = [];
  f.store.finishAgentJob = async (job, update) => { writes.push(structuredClone({ job, update })); if (writes.length === 1) throw new Error('lost'); return original(job, update); };
  await f.ops.tick(); assert.equal(writes.length, 2); assert.deepEqual(writes[0], writes[1]); assert.equal(f.store.agentJobs[0].status, 'succeeded');
  const other = await fixture(t); await other.ops.enqueueObjectiveReview('alpha', other.input, other.auth);
  let finishCalls = 0, reschedules = 0;
  other.store.finishAgentJob = async () => { finishCalls++; throw new Error('unknown'); };
  other.store.getAgentJob = async () => { throw new Error('cannot reconcile'); };
  other.store.rescheduleAgentJob = async () => { reschedules++; };
  await other.ops.tick();
  assert.equal(finishCalls, 1); assert.equal(reschedules, 0); assert.equal(other.store.agentJobs[0].status, 'running');
  assert.equal(other.ops.status.processed, 0); assert.equal(other.ops.status.lastError, 'OBJECTIVE_COMPLETION_UNCERTAIN');
});

test('stale attempt, same-worker reclaim and expired lease cannot finish or reschedule job state', async t => {
  const f = await fixture(t); await f.ops.enqueueObjectiveReview('alpha', f.input, f.auth);
  const [first] = await f.store.claimAgentJobs('worker_same', 1, 300);
  f.store.agentJobs[0].lease_until = new Date(Date.now() - 10).toISOString();
  assert.equal(await f.store.finishAgentJob(first, { status: 'blocked' }), null);
  const [second] = await f.store.claimAgentJobs('worker_same', 1, 300);
  assert.equal(second.attempts, 2);
  assert.equal(await f.store.finishAgentJob(first, { status: 'dead_letter' }), null);
  assert.equal(await f.store.rescheduleAgentJob(first, { availableAt: new Date().toISOString() }), null);
  assert.equal(await f.store.finishAgentJob({ ...second, workspace_id: 'beta' }, { status: 'blocked' }), null);
  assert.equal(f.store.agentJobs[0].status, 'running');
});

test('completed report survives hot-state history compaction and is flagged stale only on explicit read', async t => {
  const f = await fixture(t), queued = await f.ops.enqueueObjectiveReview('alpha', f.input, f.auth); await f.ops.tick();
  const saved = structuredClone(f.store.agentJobs[0].result);
  const state = await f.store.get('alpha'); state.agentRuns = []; state.workRecords = []; state.audit = [];
  await f.store.save('alpha', state);
  assert.deepEqual((await f.ops.objectiveReview('alpha', queued.job.id, { includeReport: true }, f.auth)).report, saved);
  state.opportunities[0].effortHours++; await f.store.save('alpha', state);
  const stale = await f.ops.objectiveReview('alpha', queued.job.id, { includeReport: true }, f.auth);
  assert.equal(stale.stale, true); assert.equal(stale.staleReason, 'OBJECTIVE_SOURCE_CHANGED'); assert.deepEqual(stale.report, saved);
  assert.notEqual((await f.ops.enqueueObjectiveReview('alpha', f.input, f.auth)).job.id, queued.job.id);
});

test('manual objective retry requires explicit current session binding and never adds workspace history', async t => {
  const f = await fixture(t), queued = await f.ops.enqueueObjectiveReview('alpha', f.input, f.auth);
  const [claimed] = await f.store.claimAgentJobs('retry_worker', 1, 300);
  await f.store.finishAgentJob(claimed, { status: 'blocked', errorCode: 'TEST_BLOCK', completedAt: new Date().toISOString() });
  const before = await fs.readFile(f.file, 'utf8');
  await assert.rejects(() => f.ops.retry('alpha', queued.job.id, f.auth.actorId), e => e.code === 'OBJECTIVE_RETRY_AUTH_REQUIRED');
  await assert.rejects(() => f.ops.retry('alpha', queued.job.id, { ...f.auth, sessionVersion: 99 }), e => e.code === 'OBJECTIVE_ACTOR_PERMISSION_CHANGED');
  await assert.rejects(() => f.ops.retry('alpha', queued.job.id, { actorId: 'platform-owner-other-tenant', sessionVersion: 1 }), e => e.code === 'OBJECTIVE_ACTOR_PERMISSION_CHANGED');
  const retried = await f.ops.retry('alpha', queued.job.id, f.auth);
  assert.equal(retried.id, queued.job.id); assert.equal(retried.status, 'queued');
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
});

test('session rotation between request authentication and objective retry cannot acquire a new attempt', async t => {
  const f = await fixture(t), queued = await f.ops.enqueueObjectiveReview('alpha', f.input, f.auth);
  const [claimed] = await f.store.claimAgentJobs('retry_worker', 1, 300);
  await f.store.finishAgentJob(claimed, { status: 'blocked', errorCode: 'TEST_BLOCK', completedAt: new Date().toISOString() });
  const authenticated = { ...f.auth };
  const state = await f.store.get('alpha'); state.users[0].sessionVersion++; await f.store.save('alpha', state);
  await assert.rejects(() => f.ops.retry('alpha', queued.job.id, authenticated), e => e.code === 'OBJECTIVE_ACTOR_PERMISSION_CHANGED');
  assert.equal(f.store.agentJobs[0].status, 'blocked'); assert.equal(f.store.agentJobs[0].attempts, 1);
});

test('legacy retry accepts the new auth object while retaining string audit provenance', async t => {
  const f = await fixture(t);
  const job = await f.ops.enqueue('alpha', { type: 'agent_command', payload: { command: 'review health' } }, f.auth.actorId);
  const [claimed] = await f.store.claimAgentJobs('retry_worker', 1, 300);
  await f.store.finishAgentJob(claimed, { status: 'dead_letter', errorCode: 'TEST_BLOCK', completedAt: new Date().toISOString() });
  assert.equal((await f.ops.retry('alpha', job.id, f.auth)).status, 'queued');
  const state = await f.store.get('alpha');
  assert.equal(state.audit.find(row => row.type === 'agent_job_retried').actor, f.auth.actorId);
});

test('currency and typed view diagnostics invalidate queued/completed report keys and staleness', async t => {
  const f = await fixture(t), queued = await f.ops.enqueueObjectiveReview('alpha', f.input, f.auth);
  const state = await f.store.get('alpha'); state.settings.currency = 'USD'; await f.store.save('alpha', state);
  await f.ops.tick(); assert.equal(f.store.agentJobs[0].status, 'blocked');
  const current = await f.ops.enqueueObjectiveReview('alpha', f.input, f.auth);
  assert.notEqual(current.job.id, queued.job.id); await f.ops.tick();
  const saved = await f.ops.objectiveReview('alpha', current.job.id, { includeReport: true }, f.auth);
  assert.equal(saved.report.metricEvidence.currency.workspace, 'USD'); assert.equal(saved.stale, false);
  state.settings.currency = 'GBP'; await f.store.save('alpha', state);
  const changed = await f.ops.objectiveReview('alpha', current.job.id, { includeReport: true }, f.auth);
  assert.equal(changed.stale, true); assert.equal(changed.staleReason, 'OBJECTIVE_SOURCE_CHANGED');
  const fingerprint = () => objectiveReviewFingerprint(state, f.input, { workspaceId: 'alpha' });
  state.opportunities = []; const empty = fingerprint(); delete state.opportunities;
  assert.notEqual(fingerprint(), empty, 'missing evidence diagnostics differ from a known empty source');
});

test('canonical typed source ordering keeps selected proposals and cumulative blockers identical beyond both report and canonical caps', async t => {
  const f = await fixture(t), original = await f.store.get('alpha');
  for (const count of [12, 110]) {
    const state = structuredClone(original); state.settings.growthCapacityHours = 3;
    state.opportunities = Array.from({ length: count }, (_, index) => ({ id: `opp_${String(index).padStart(3, '0')}`,
      kind: 'operations', status: 'open', present: true, executionCost: 0, effortHours: 1, confidence: 0.8, risk: 'low' }));
    state.decisions = [{ status: 'active', category: 'product_exclusion', target: 'missing-a' }, { status: 'active', category: 'product_exclusion', target: 'missing-b' }];
    state.approvals = [{ id: 'approval_a', status: 'pending', payload: { opportunityId: 'opp_001' } }, { id: 'approval_b', status: 'pending', payload: { opportunityId: 'opp_003' } }];
    const shuffled = structuredClone(state);
    for (const key of ['opportunities', 'decisions', 'approvals']) shuffled[key].reverse();
    const first = buildObjectiveReview(state, { ...f.input, jobId: 'job_order_test' }, { workspaceId: 'alpha', now: '2026-10-06T19:00:00.000Z' });
    const second = buildObjectiveReview(shuffled, { ...f.input, jobId: 'job_order_test' }, { workspaceId: 'alpha', now: '2026-10-06T19:01:00.000Z' });
    assert.equal(first.sourceAsOf.typedInputFingerprint, second.sourceAsOf.typedInputFingerprint);
    delete first.generatedAt; delete second.generatedAt;
    delete first.sourceAsOf.snapshotReadAt; delete second.sourceAsOf.snapshotReadAt;
    assert.deepEqual(second, first, `Every report field except explicit observation timestamps is order-independent for ${count} sources`);
    assert.ok(first.proposals.length <= 10);
  }
});

test('objective lease recovery stops at max attempts, preserves identity/result and permits fresh explicit retry', async t => {
  const f = await fixture(t), queued = await f.ops.enqueueObjectiveReview('alpha', f.input, f.auth);
  const payload = structuredClone(f.store.agentJobs[0].payload);
  f.store.agentJobs[0].result = { preserved: true };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const claimed = await f.store.claimAgentJobs('expiry_worker', 1, 300);
    assert.equal(claimed.length, 1); assert.equal(claimed[0].id, queued.job.id); assert.equal(claimed[0].attempts, attempt);
    f.store.agentJobs[0].lease_until = new Date(Date.now() - 1000).toISOString();
  }
  const before = await fs.readFile(f.file, 'utf8');
  for (let poll = 0; poll < 4; poll++) assert.deepEqual(await f.store.claimAgentJobs('expiry_worker', 1, 300), []);
  const row = f.store.agentJobs[0];
  assert.equal(row.status, 'dead_letter'); assert.equal(row.error_code, 'OBJECTIVE_LEASE_ATTEMPTS_EXHAUSTED');
  assert.equal(row.attempts, 3); assert.equal(row.worker_id, null); assert.equal(row.lease_until, null);
  assert.ok(Number.isFinite(Date.parse(row.completed_at))); assert.deepEqual(row.payload, payload); assert.deepEqual(row.result, { preserved: true });
  await assert.rejects(() => f.ops.retry('alpha', queued.job.id, { ...f.auth, sessionVersion: 99 }), e => e.code === 'OBJECTIVE_ACTOR_PERMISSION_CHANGED');
  const retried = await f.ops.retry('alpha', queued.job.id, f.auth);
  assert.equal(retried.status, 'queued'); assert.equal(f.store.agentJobs[0].attempts, 0);
  assert.deepEqual(f.store.agentJobs[0].result, { preserved: true });
  assert.equal((await f.store.claimAgentJobs('fresh_retry_worker', 1, 300))[0].attempts, 1);
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
});

test('legacy expired-lease behavior is unchanged by the objective-only recovery cap', async t => {
  const f = await fixture(t);
  await f.ops.enqueue('alpha', { type:'agent_command', maxAttempts:1, payload:{command:'review health'} }, f.auth.actorId);
  assert.equal((await f.store.claimAgentJobs('legacy_worker', 1, 300))[0].attempts, 1);
  f.store.agentJobs[0].lease_until = new Date(Date.now() - 1000).toISOString();
  const second = await f.store.claimAgentJobs('legacy_worker', 1, 300);
  assert.equal(second.length, 1); assert.equal(second[0].attempts, 2); assert.equal(second[0].status, 'running');
});

test('invalid, non-running and exhausted objective claims cannot load state or compute a report', async t => {
  const f = await fixture(t); await f.ops.enqueueObjectiveReview('alpha', f.input, f.auth);
  const base = { ...f.store.agentJobs[0], status:'running', worker_id:f.ops.workerId, attempts:1, lease_until:new Date(Date.now()+300000).toISOString() };
  const invalid = [{status:'queued'}, {worker_id:'other_worker'}, {attempts:0}, {attempts:1.5}, {max_attempts:0},
    {lease_until:'not-a-date'}, {lease_until:new Date(Date.now()-1000).toISOString()}, {workspace_id:'alpha&other'}, {attempts:4,result:{preserved:true}}];
  f.store.claimAgentJobs = async () => invalid.map(patch => ({...base,...patch}));
  let reads = 0, reschedules = 0; const finishes = [];
  f.store.get = async () => { reads++; throw new Error('State must not be loaded'); };
  f.store.finishAgentJob = async (_job, update) => { finishes.push(update); return { status:update.status }; };
  f.store.rescheduleAgentJob = async () => { reschedules++; };
  await f.ops.tick();
  assert.equal(reads, 0); assert.equal(reschedules, 0); assert.equal(f.providerCalls, 0); assert.equal(f.ops.status.processed, 0);
  assert.equal(finishes.length, 1); assert.equal(finishes[0].status, 'dead_letter');
  assert.equal(finishes[0].errorCode, 'OBJECTIVE_LEASE_ATTEMPTS_EXHAUSTED');
  assert.deepEqual(finishes[0].result, {preserved:true});
});
