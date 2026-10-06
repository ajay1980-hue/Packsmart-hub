import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { AGENT_JOB_TYPES, createAgentOperations, configureAgentOps, ensureAgentOps } from '../lib/agent-ops.mjs';

async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-agent-ops-'));
  const store = createStore({ SAAS_STATE_FILE:path.join(dir,'state.json') });
  for (const workspaceId of ['alpha','beta']) {
    const state = seedWorkspaceState({}, { workspaceId, email:`${workspaceId}@example.test`, passwordHash:'fixture' });
    state.subscription.plan = 'pro';
    await store.save(workspaceId, state);
  }
  const locks = new Map();
  async function withWorkspaceLock(workspaceId, callback) {
    const previous = locks.get(workspaceId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release=resolve; });
    const queued = previous.then(()=>current);
    locks.set(workspaceId,queued);
    await previous;
    try { return await callback(); }
    finally { release(); if (locks.get(workspaceId) === queued) locks.delete(workspaceId); }
  }
  const ops = createAgentOperations({ store, integrations:{}, withWorkspaceLock, enabled:false, ...options });
  t.after(async()=>{ ops.stop(); await fs.rm(dir,{recursive:true,force:true}); });
  return { store, ops };
}

test('agent operations queue is tenant scoped, idempotent and rejects unsafe job types', async t => {
  const {store,ops}=await fixture(t);
  const first=await ops.enqueue('alpha',{type:'agent_command',payload:{command:'check everything'},idempotencyKey:'same-key'},'alpha-owner');
  const duplicate=await ops.enqueue('alpha',{type:'agent_command',payload:{command:'check everything'},idempotencyKey:'same-key'},'alpha-owner');
  const other=await ops.enqueue('beta',{type:'agent_command',payload:{command:'check everything'},idempotencyKey:'same-key'},'beta-owner');
  assert.equal(first.id,duplicate.id);
  assert.notEqual(first.id,other.id);
  assert.equal((await ops.workspaceSnapshot('alpha')).jobs.some(job=>job.workspace_id==='beta'),false);
  await assert.rejects(()=>ops.enqueue('alpha',{type:'refund',payload:{}},'alpha-owner'),error=>error.code==='AGENT_JOB_TYPE_INVALID');

  const a2=await ops.enqueue('alpha',{type:'marketing_plan',idempotencyKey:'alpha-second'},'alpha-owner');
  const claimed=await store.claimAgentJobs('worker-test',8,300);
  assert.equal(claimed.filter(job=>job.workspace_id==='alpha').length,1,'one job per workspace is claimed per pass for fair tenant scheduling');
  assert.equal(claimed.filter(job=>job.workspace_id==='beta').length,1);
  assert.ok([first.id,a2.id].includes(claimed.find(job=>job.workspace_id==='alpha').id));
});

test('agent worker executes safe analysis with no external writes and records bounded usage', async t => {
  const {store,ops}=await fixture(t);
  const alpha=await store.get('alpha');
  configureAgentOps(alpha,{dailyAiUnitLimit:2,maxConcurrentJobs:2},'owner');
  await store.save('alpha',alpha);
  await ops.enqueue('alpha',{type:'agent_command',payload:{command:'check business health'},idempotencyKey:'health-1'},'owner');
  await ops.tick();
  const snapshot=await ops.workspaceSnapshot('alpha');
  assert.equal(snapshot.counts.succeeded,1);
  const completed=snapshot.jobs.find(job=>job.idempotency_key==='health-1');
  assert.equal(completed.result.externalWrites,false);
  assert.equal(snapshot.usage.aiUnitsToday,1);
  await ops.enqueue('alpha',{type:'marketing_plan',idempotencyKey:'marketing-1'},'owner');
  await assert.rejects(()=>ops.enqueue('alpha',{type:'agent_command',payload:{command:'another analysis'},idempotencyKey:'health-2'},'owner'),error=>error.code==='AI_BUDGET_REACHED');
});

test('dead-letter retry cannot cross tenants and returns the same durable job to the queue', async t => {
  const {store,ops}=await fixture(t);
  const job=await ops.enqueue('alpha',{type:'agent_command',payload:{command:'stock check'},idempotencyKey:'retry-me'},'owner');
  const [claimed]=await store.claimAgentJobs('worker-retry',1,300);
  assert.equal(claimed.id,job.id);
  await store.finishAgentJob(claimed,{status:'dead_letter',errorCode:'TEST_FAILURE',completedAt:new Date().toISOString()});
  await assert.rejects(()=>ops.retry('beta',job.id,'beta-owner'),error=>error.code==='AGENT_JOB_NOT_FOUND');
  const retried=await ops.retry('alpha',job.id,'alpha-owner');
  assert.equal(retried.id,job.id);
  assert.equal(retried.status,'queued');
  assert.equal(retried.attempts,0);
});

test('expired worker leases are recovered without claiming two jobs from one tenant in a pass', async t => {
  const {store,ops}=await fixture(t);
  const one=await ops.enqueue('alpha',{type:'agent_command',payload:{command:'health'},idempotencyKey:'lease-1'},'owner');
  await ops.enqueue('alpha',{type:'agent_command',payload:{command:'stock'},idempotencyKey:'lease-2'},'owner');
  const [claimed]=await store.claimAgentJobs('worker-old',8,0);
  assert.equal(claimed.id,one.id);
  claimed.lease_until=new Date(Date.now()-1000).toISOString();
  const stored=store.agentJobs.find(item=>item.id===claimed.id);stored.lease_until=claimed.lease_until;
  const recovered=await store.claimAgentJobs('worker-new',8,300);
  assert.equal(recovered.filter(job=>job.workspace_id==='alpha').length,1);
  assert.ok(recovered.some(job=>job.id===one.id || job.idempotency_key==='lease-2'));
});

function fakeTiming(randomValue = 1) {
  let timestamp = Date.UTC(2026, 0, 1), unrefs = 0;
  const timers = new Map();
  return {
    options: {
      now: () => timestamp,
      random: () => randomValue,
      scheduleTimeout(callback, delay) {
        const timer = { unref() { unrefs++; } };
        timers.set(timer, { callback, due:timestamp + delay });
        return timer;
      },
      cancelTimeout: timer => timers.delete(timer)
    },
    get size() { return timers.size; },
    get unrefs() { return unrefs; },
    get now() { return timestamp; },
    get delay() { return timers.size ? [...timers.values()][0].due - timestamp : null; },
    fireNext() {
      assert.equal(timers.size, 1, 'at most one poll timer is scheduled');
      const [timer, { callback, due }] = [...timers][0];
      timers.delete(timer);
      timestamp = due;
      callback();
    }
  };
}

async function settled(ops) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!ops.status.running) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('worker did not settle');
}

function pollingFixture(t, { randomValue = 1, store = {}, ...options } = {}) {
  const clock = fakeTiming(randomValue);
  const ops = createAgentOperations({
    store:{ claimAgentJobs:async () => [], ...store }, integrations:{},
    withWorkspaceLock:async (_id, callback) => callback(),
    ...clock.options, ...options
  });
  t.after(() => ops.stop());
  return { ops, clock };
}

test('idle polls back off exponentially with bounded jitter and read-only counters', async t => {
  for (const [randomValue, expected] of [[0, [4000,8000,16000,32000,48000,48000]], [1, [5000,10000,20000,40000,60000,60000]]]) {
    const { ops, clock } = pollingFixture(t, { randomValue });
    ops.start();
    await settled(ops);
    for (let i = 0; i < expected.length; i++) {
      assert.equal(clock.delay, expected[i]);
      assert.equal(ops.status.nextPollAt, new Date(clock.now + expected[i]).toISOString());
      assert.equal(ops.status.pollCalls, i + 1);
      assert.equal(ops.status.emptyPolls, i + 1);
      assert.equal(ops.status.pollErrors, 0);
      assert.equal(clock.size, 1);
      clock.fireNext();
      await settled(ops);
    }
    assert.equal(ops.status.backoffMs, 60000);
    assert.equal(clock.unrefs, expected.length + 1);
    assert.throws(() => { ops.status.pollCalls = 0; }, TypeError);
    ops.stop();
    assert.equal(clock.size, 0);
    assert.equal(ops.status.nextPollAt, null);
  }
});

test('claim errors back off, including alternating empty/error polls, without overlapping work', async t => {
  let calls = 0, resolveClaim;
  const { ops, clock } = pollingFixture(t, { store:{
    claimAgentJobs:async () => {
      calls++;
      if (calls === 1) return new Promise(resolve => { resolveClaim = resolve; });
      if (calls % 2 === 0) throw Object.assign(new Error('database unavailable'), { code:'PERSISTENCE_FAILED' });
      return [];
    }
  } });
  ops.start();
  ops.start();
  await ops.tick();
  assert.equal(calls, 1);
  assert.equal(clock.size, 0);
  assert.equal(ops.status.running, true);
  resolveClaim([]);
  await settled(ops);
  for (const delay of [5000,10000,20000,40000,60000]) {
    assert.equal(clock.delay, delay);
    clock.fireNext();
    await settled(ops);
  }
  assert.equal(ops.status.pollCalls, 6);
  assert.equal(ops.status.emptyPolls, 3);
  assert.equal(ops.status.pollErrors, 3);
  assert.equal(ops.status.lastError, 'PERSISTENCE_FAILED');
  assert.equal(clock.delay, 60000);
});

test('explicit ticks bypass pending backoff and disabled workers never start timers', async t => {
  const { ops, clock } = pollingFixture(t);
  ops.start();
  await settled(ops);
  const before = clock.now;
  await ops.tick();
  assert.equal(ops.status.pollCalls, 2);
  assert.equal(clock.now, before);
  assert.equal(clock.delay, 10000);
  assert.equal(clock.size, 1);
  const disabled = pollingFixture(t, { enabled:false });
  disabled.ops.start();
  await disabled.ops.tick();
  assert.equal(disabled.ops.status.pollCalls, 1);
  assert.equal(disabled.clock.size, 0);
  disabled.ops.stop();
  await disabled.ops.tick();
  assert.equal(disabled.ops.status.pollCalls, 1);
});

test('stop/start during an in-flight claim neither leaks timers nor overlaps claims', async t => {
  let resolveClaim, calls = 0;
  const { ops, clock } = pollingFixture(t, { store:{ claimAgentJobs:async () => {
    calls++;
    return new Promise(resolve => { resolveClaim = resolve; });
  } } });
  ops.start();
  ops.stop();
  ops.start();
  assert.equal(calls, 1);
  resolveClaim([]);
  await settled(ops);
  assert.equal(clock.delay, 0);
  assert.equal(ops.status.backoffMs, 2500);
  clock.fireNext();
  ops.stop();
  resolveClaim([]);
  await settled(ops);
  assert.equal(calls, 2);
  assert.equal(clock.size, 0);
  assert.equal(ops.status.nextPollAt, null);
  ops.start();
  resolveClaim([]);
  await settled(ops);
  assert.equal(calls, 3);
  assert.equal(clock.size, 1);
  assert.equal(clock.delay, 5000);
});

test('local enqueue/retry wakes idle workers immediately and successful work resets backoff', async t => {
  const clock = fakeTiming();
  const { ops, store } = await fixture(t, { enabled:true, ...clock.options });
  ops.start();
  await settled(ops);
  for (let i = 0; i < 5; i++) { clock.fireNext(); await settled(ops); }
  assert.equal(clock.delay, 60000);
  await assert.rejects(() => ops.enqueue('alpha', { type:'refund' }), error => error.code === 'AGENT_JOB_TYPE_INVALID');
  assert.equal(clock.delay, 60000, 'rejected input does not wake the worker');
  const job = await ops.enqueue('alpha', { type:'agent_command', payload:{ command:'health' }, idempotencyKey:'wake' });
  assert.equal(clock.delay, 0);
  assert.equal(ops.status.backoffMs, 2500);
  clock.fireNext();
  await settled(ops);
  assert.equal(ops.status.processed, 1);
  assert.equal(clock.delay, 2500);
  clock.fireNext();
  await settled(ops);
  assert.equal(clock.delay, 5000);
  await ops.enqueue('alpha', { type:'agent_command', payload:{ command:'health' }, idempotencyKey:'wake' });
  assert.equal(clock.delay, 5000, 'an already-completed idempotent job does not wake the worker');
  const row = store.agentJobs.find(item => item.id === job.id);
  row.status = 'dead_letter';
  await ops.retry('alpha', job.id, 'owner');
  assert.equal(clock.delay, 0);
  clock.fireNext();
  await settled(ops);
  assert.equal(ops.status.processed, 2);
  assert.equal(clock.delay, 2500);
  const fleet = await ops.fleetSnapshot();
  assert.equal(fleet.worker.pollCalls, ops.status.pollCalls);
  assert.equal(fleet.worker.backoffMs, 2500);
});

test('enqueue racing a claim schedules exactly one immediate follow-on poll', async t => {
  const clock = fakeTiming();
  const { ops, store } = await fixture(t, { enabled:true, ...clock.options });
  const claim = store.claimAgentJobs.bind(store);
  let resolveClaim;
  store.claimAgentJobs = () => new Promise(resolve => { resolveClaim = resolve; });
  ops.start();
  await ops.enqueue('alpha', { type:'agent_command', payload:{ command:'health' } });
  await ops.enqueue('beta', { type:'agent_command', payload:{ command:'health' } });
  assert.equal(clock.size, 0);
  assert.equal(ops.status.pollCalls, 1);
  store.claimAgentJobs = claim;
  resolveClaim([]);
  await settled(ops);
  assert.equal(clock.size, 1);
  assert.equal(clock.delay, 0);
  clock.fireNext();
  await settled(ops);
  assert.equal(ops.status.processed, 2);
  assert.equal(ops.status.pollCalls, 2);
  assert.equal(clock.delay, 2500);
  ops.stop();
  await ops.enqueue('alpha', { type:'agent_command', payload:{ command:'stock' } });
  assert.equal(clock.size, 0, 'enqueue never restarts a stopped worker');
});

test('a replica at maximum idle backoff still discovers remotely enqueued work', async t => {
  const clock = fakeTiming();
  const { ops, store } = await fixture(t, { enabled:true, ...clock.options });
  ops.start();
  await settled(ops);
  for (let i = 0; i < 5; i++) { clock.fireNext(); await settled(ops); }
  const remote = createAgentOperations({ store, integrations:{}, withWorkspaceLock:async (_id, callback) => callback(), enabled:false });
  await remote.enqueue('alpha', { type:'agent_command', payload:{ command:'health' } });
  assert.equal(clock.delay, 60000, 'another replica cannot use the local wake signal');
  clock.fireNext();
  await settled(ops);
  assert.equal(ops.status.processed, 1);
  assert.equal(clock.delay, 2500);
});

test('idle poll volume stays within the calculated first-day bounds', async t => {
  for (const [randomValue, expected] of [[0,1803], [1,1443]]) {
    const { ops, clock } = pollingFixture(t, { randomValue });
    const end = clock.now + 86400000;
    ops.start();
    await settled(ops);
    while (clock.now + clock.delay < end) {
      clock.fireNext();
      await settled(ops);
    }
    assert.equal(ops.status.pollCalls, expected);
    assert.equal(ops.status.emptyPolls, expected);
  }
});

test('a running execution cannot overlap another poll or be restarted by stop', async t => {
  let releaseExecution, enteredExecution;
  const entered = new Promise(resolve => { enteredExecution = resolve; });
  const clock = fakeTiming();
  const { ops } = await fixture(t, { enabled:true, ...clock.options, aiProvider:{
    enhanceCommander:async () => {
      enteredExecution();
      return new Promise(resolve => { releaseExecution = resolve; });
    }
  } });
  await ops.enqueue('alpha', { type:'agent_command', payload:{ command:'health' } });
  ops.start();
  await entered;
  await ops.tick();
  ops.start();
  assert.equal(ops.status.pollCalls, 1);
  assert.equal(clock.size, 0);
  await ops.enqueue('beta', { type:'agent_command', payload:{ command:'health' } });
  assert.equal(clock.size, 0, 'the enqueue wake waits for the active execution');
  ops.stop();
  releaseExecution({ used:false, reason:'TEST' });
  await settled(ops);
  assert.equal(ops.status.processed, 1);
  assert.equal(ops.status.pollCalls, 1);
  assert.equal(clock.size, 0);
  assert.equal(ops.status.nextPollAt, null);
});

test('zero AI budgets persist and callers cannot understate trusted job unit costs', async t => {
  const { ops, store } = await fixture(t);
  const state = await store.get('alpha');
  configureAgentOps(state, { dailyAiUnitLimit:0 }, 'owner');
  assert.equal(ensureAgentOps(state).dailyAiUnitLimit, 0);
  await store.save('alpha', state);
  assert.equal((await ops.workspaceSnapshot('alpha')).settings.dailyAiUnitLimit, 0);
  for (const type of ['agent_command','marketing_plan']) {
    await assert.rejects(() => ops.enqueue('alpha', { type, aiUnits:0, payload:{ command:'health' } }), error => error.code === 'AI_BUDGET_REACHED');
    const job = await ops.enqueue('beta', { type, aiUnits:0, payload:{ command:'health' } });
    assert.equal(job.ai_units, AGENT_JOB_TYPES[type].aiUnits);
  }
  const free = await ops.enqueue('alpha', { type:'connection_doctor' });
  assert.equal(free.ai_units, 0);
  for (const value of [-1, NaN, Infinity, -Infinity, 'invalid']) {
    await assert.rejects(() => ops.enqueue('beta', { type:'marketing_plan', aiUnits:value }), error => error.code === 'VALIDATION_FAILED');
    assert.throws(() => configureAgentOps(state, { dailyAiUnitLimit:value }, 'owner'), error => error.code === 'VALIDATION_FAILED');
  }
  const higher = await ops.enqueue('beta', { type:'marketing_plan', aiUnits:3 });
  assert.equal(higher.ai_units, 3);
});

test('agent execution preserves approval-required and blocked work records', async t => {
  const { ops, store } = await fixture(t);
  const alpha = await store.get('alpha');
  alpha.agentSettings = { commander:{ enabled:true, autonomy:2 } };
  await store.save('alpha', alpha);
  await ops.enqueue('alpha', { type:'agent_command', payload:{ command:'purchase inventory' } });
  await ops.tick();
  const approvalState = await store.get('alpha');
  const approvalRun = approvalState.agentRuns[0];
  const approvalWork = approvalState.workRecords.find(item => item.id === approvalRun.id);
  assert.equal(approvalWork.status, 'REQUIRES APPROVAL');
  assert.ok(approvalWork.approvalId);
  assert.equal(approvalWork.approvalId, approvalRun.approvalId);
  assert.equal(approvalWork.executedExternally, false);
  assert.equal(approvalWork.history.some(item => item.status === 'COMPLETED'), false);

  const beta = await store.get('beta');
  beta.agentSettings = { stock:{ enabled:false } };
  await store.save('beta', beta);
  await ops.enqueue('beta', { type:'agent_command', payload:{ command:'stock' } });
  await ops.tick();
  const blockedState = await store.get('beta');
  const blockedRun = blockedState.agentRuns[0];
  assert.equal(blockedRun.workStatus, 'BLOCKED');
  assert.equal(blockedState.workRecords.find(item => item.id === blockedRun.id).status, 'BLOCKED');
  const completed = (await ops.workspaceSnapshot('alpha')).jobs[0];
  assert.equal(completed.result.workStatus, 'REQUIRES APPROVAL');
  assert.equal(completed.result.externalWrites, false);
});

const noBriefDispatch = () => ({ submissionAttempts: 0, confirmedSubmissions: 0, uncertainSubmissions: 0,
  reservationId: null, usageStatus: 'uncertain', costStatus: 'unknown', accountedCostMicros: null, currency: 'USD' });
const unknownBriefEffects = () => ({ submissionAttempts: null, confirmedSubmissions: null, uncertainSubmissions: null,
  reservationId: null, usageStatus: 'uncertain', costStatus: 'unknown', accountedCostMicros: null, currency: 'USD' });
async function persistedBrief(store, jobId) {
  const state = await store.get('alpha');
  const job = await store.getAgentJob('alpha', jobId);
  const run = state.agentRuns.find(item => item.id === job.result?.runId);
  const completion = state.audit.find(item => item.type === 'agent_job_completed' && item.detail.jobId === jobId);
  assert.equal(job.status, 'succeeded');
  assert.ok(run);
  assert.ok(completion);
  assert.equal(job.result.externalWrites, false);
  assert.equal(run.executedExternally, false);
  assert.equal(completion.detail.externalWrites, false);
  assert.deepEqual(job.result.ai, run.ai);
  assert.deepEqual(completion.detail.providerEffects, run.ai.effects);
  return { state, job, run, completion };
}

test('brief worker context comes from the actual claimed lease rather than spoofed input or payload fields', async t => {
  let received, claimed;
  const { store, ops } = await fixture(t, { aiProvider: { enhanceCommander: async input => {
    received = input;
    return { used: false, reason: 'AI_GOVERNANCE_NOT_CONFIGURED', effects: noBriefDispatch() };
  } } });
  const forged = { workspaceId: 'beta', jobId: 'job_forged', type: 'connection_sync', status: 'succeeded',
    workerId: 'worker_forged', attempt: 999, leaseUntil: '2099-01-01T00:00:00.000Z', createdAt: '2098-01-01T00:00:00.000Z' };
  const job = await ops.enqueue('alpha', { ...forged, type: 'agent_command',
    payload: { command: 'check business health', ...forged, worker_id: 'worker_forged', attempts: 999,
      lease_until: forged.leaseUntil, created_at: forged.createdAt, jobContext: forged }, jobContext: forged }, 'owner');
  store.agentJobs.find(row => row.id === job.id).attempts = 1;
  const claim = store.claimAgentJobs.bind(store);
  store.claimAgentJobs = async (...args) => {
    const jobs = await claim(...args);
    claimed = structuredClone(jobs[0]);
    return jobs;
  };
  await ops.tick();
  assert.ok(received);
  assert.equal(received.workspaceId, 'alpha');
  assert.equal(received.jobId, job.id);
  assert.equal(Object.isFrozen(received.jobContext), true);
  assert.deepEqual(received.jobContext, { workspaceId: 'alpha', jobId: job.id, type: 'agent_command', status: 'running',
    workerId: ops.status.workerId, attempt: 2, leaseUntil: claimed.lease_until, createdAt: claimed.created_at });
  assert.equal(received.jobContext.workerId, claimed.worker_id);
  assert.equal(received.jobContext.attempt, claimed.attempts);
  assert.equal(received.jobContext.status, claimed.status);
  assert.equal(received.jobContext.createdAt, claimed.created_at);
  assert.notEqual(received.jobContext.createdAt, forged.createdAt);
  assert.ok(Date.parse(received.jobContext.leaseUntil) > Date.now());
  const { run } = await persistedBrief(store, job.id);
  assert.deepEqual(run.ai.effects, noBriefDispatch());
});

test('brief worker preserves deterministic findings with zero dispatch but unknown cost on policy denial', async t => {
  let deterministic;
  const { store, ops } = await fixture(t, { aiProvider: { enhanceCommander: async ({ run }) => {
    deterministic = structuredClone(run);
    return { used: false, reason: 'AI_GOVERNANCE_NOT_CONFIGURED', effects: noBriefDispatch() };
  } } });
  const job = await ops.enqueue('alpha', { type: 'agent_command', payload: { command: 'check business health' } });
  await ops.tick();
  const { run } = await persistedBrief(store, job.id);
  assert.ok(deterministic.summary);
  assert.equal(run.summary, deterministic.summary);
  assert.deepEqual(run.results, deterministic.results);
  assert.deepEqual(run.priorities, deterministic.priorities);
  assert.equal(run.ai.used, false);
  assert.equal(run.ai.reason, 'AI_GOVERNANCE_NOT_CONFIGURED');
  assert.equal(run.ai.summary, undefined);
  assert.equal(run.modelCalls, 0);
  assert.deepEqual(run.ai.effects, noBriefDispatch());
});

test('missing-provider fallback reports zero dispatch but never proves zero historical same-job cost', async t => {
  for (const withHistoricalCharge of [false, true]) {
    const { store, ops } = await fixture(t);
    const job = await ops.enqueue('alpha', { type: 'agent_command', payload: { command: 'check business health' } });
    if (withHistoricalCharge) {
      // A recovered legacy job may already have incurred a charge before the
      // provider became unavailable or the durable accounting cutover occurred.
      store.agentJobs.find(row => row.id === job.id).attempts = 1;
      await store.recordAiUsage('alpha', { id: 'usage_prior_attempt', jobId: job.id, taskType: 'agent_command',
        provider: 'openai', model: 'test-model', inputTokens: 500, cachedInputTokens: 0, cacheWriteTokens: 0,
        outputTokens: 80, estimatedCostUsd: 0.0074, requestId: 'req_prior_attempt', occurredAt: job.created_at });
    }
    const historicalUsage = structuredClone(store.aiUsage);
    await ops.tick();
    const { run, job: completed } = await persistedBrief(store, job.id);
    assert.ok(run.summary);
    assert.equal(run.ai.used, false);
    assert.equal(run.ai.reason, 'PROVIDER_NOT_CONFIGURED');
    assert.equal(run.modelCalls, 0);
    assert.equal(completed.attempts, withHistoricalCharge ? 2 : 1);
    assert.deepEqual(run.ai.effects, noBriefDispatch());
    assert.equal(run.ai.effects.usageStatus, 'uncertain');
    assert.equal(run.ai.effects.costStatus, 'unknown');
    assert.equal(run.ai.effects.accountedCostMicros, null);
    assert.deepEqual(store.aiUsage, historicalUsage, 'Skipped invocation must not overwrite historical charges');
  }
});

test('brief worker persists held and uncertain accounting without turning an unused brief into zero cost', async t => {
  for (const effects of [
    { ...noBriefDispatch(), reservationId: 'provider_usage_held', usageStatus: 'held', costStatus: 'unknown', accountedCostMicros: null },
    { ...noBriefDispatch(), submissionAttempts: 1, uncertainSubmissions: 1, reservationId: 'provider_usage_uncertain',
      usageStatus: 'uncertain', costStatus: 'unknown', accountedCostMicros: null }
  ]) {
    let deterministic;
    const { store, ops } = await fixture(t, { aiProvider: { enhanceCommander: async ({ run }) => {
      deterministic = run.summary;
      return { used: false, reason: 'AI_PROVIDER_OUTCOME_UNCERTAIN', effects };
    } } });
    const job = await ops.enqueue('alpha', { type: 'agent_command', payload: { command: 'check business health' } });
    await ops.tick();
    const { run } = await persistedBrief(store, job.id);
    assert.equal(run.summary, deterministic);
    assert.equal(run.ai.used, false);
    assert.deepEqual(run.ai.effects, effects);
    assert.equal(run.modelCalls, effects.submissionAttempts);
    assert.equal(run.ai.effects.costStatus, 'unknown');
    assert.equal(run.ai.effects.accountedCostMicros, null);
  }
});

test('brief provider exceptions cannot erase deterministic results or look like zero-cost execution', async t => {
  const privateFailure = 'raw-provider-body-and-credential-must-not-persist';
  let deterministic;
  const { store, ops } = await fixture(t, { aiProvider: { enhanceCommander: async ({ run }) => {
    deterministic = run.summary;
    throw Object.assign(new Error(privateFailure), { code: 'AI_PROVIDER_TIMEOUT', body: privateFailure });
  } } });
  const job = await ops.enqueue('alpha', { type: 'agent_command', payload: { command: 'check business health' } });
  await ops.tick();
  const { state, run, job: completed } = await persistedBrief(store, job.id);
  assert.equal(run.summary, deterministic);
  assert.equal(run.ai.used, false);
  assert.equal(run.ai.reason, 'AI_PROVIDER_TIMEOUT');
  assert.equal(run.modelCalls, null);
  assert.deepEqual(run.ai.effects, unknownBriefEffects());
  assert.ok(!JSON.stringify({ state, completed }).includes(privateFailure));
});

test('brief worker treats absent or malformed provider effect evidence as unknown accounting', async t => {
  for (const effects of [undefined, {}, { ...noBriefDispatch(), submissionAttempts: '0' },
    { ...noBriefDispatch(), confirmedSubmissions: -1 }, { ...noBriefDispatch(), uncertainSubmissions: NaN }]) {
    const { store, ops } = await fixture(t, { aiProvider: { enhanceCommander: async () => ({ used: false, reason: 'UNVERIFIED', effects }) } });
    const job = await ops.enqueue('alpha', { type: 'agent_command', payload: { command: 'check business health' } });
    await ops.tick();
    const { run } = await persistedBrief(store, job.id);
    assert.equal(run.ai.effects.costStatus, 'unknown');
    assert.equal(run.ai.effects.accountedCostMicros, null);
    assert.equal(run.ai.effects.submissionAttempts, null);
    assert.equal(run.modelCalls, null);
  }
});

test('measured accounted usage persists when generated brief text is unavailable', async t => {
  for (const [usageStatus, accountedCostMicros] of [['settled', 740], ['overrun', '9007199254740993']]) {
    let deterministic;
    const effects = { submissionAttempts: 1, confirmedSubmissions: 1, uncertainSubmissions: 0,
      reservationId: 'provider_usage_measured', usageStatus, costStatus: 'accounted', accountedCostMicros, currency: 'USD' };
    const usage = { providerRequestId: 'req_measured', inputTokens: 500, cachedInputTokens: 100, cacheWriteTokens: 50,
      outputTokens: 80, totalTokens: 580, accountedCostMicros, currency: 'USD' };
    const { store, ops } = await fixture(t, { aiProvider: { enhanceCommander: async ({ run }) => {
      deterministic = run.summary;
      return { used: false, reason: 'AI_RESPONSE_TEXT_UNAVAILABLE', usage, effects };
    } } });
    const job = await ops.enqueue('alpha', { type: 'agent_command', payload: { command: 'check business health' } });
    await ops.tick();
    const { run } = await persistedBrief(store, job.id);
    assert.equal(run.summary, deterministic);
    assert.equal(run.ai.used, false);
    assert.equal(run.ai.reason, 'AI_RESPONSE_TEXT_UNAVAILABLE');
    assert.equal(run.ai.summary, undefined);
    assert.equal(run.modelCalls, 1);
    assert.deepEqual(run.ai.usage, usage);
    assert.deepEqual(run.ai.effects, effects);
  }
});


test('zero-cost effects require explicit cancelled reservation evidence rather than a skipped invocation', async t => {
  const proven = { ...noBriefDispatch(), reservationId: 'provider_usage_cancelled', usageStatus: 'cancelled_pre_dispatch',
    costStatus: 'not_incurred', accountedCostMicros: 0 };
  for (const [effects, zeroProven] of [[proven, true], [{ ...proven, reservationId: null }, false],
    [{ ...proven, usageStatus: 'none' }, false], [{ ...proven, submissionAttempts: 1 }, false],
    [{ ...proven, accountedCostMicros: null }, false]]) {
    const { store, ops } = await fixture(t, { aiProvider: { enhanceCommander: async () => ({
      used: false, reason: 'NO_BRIEF_GENERATED', effects
    }) } });
    const job = await ops.enqueue('alpha', { type: 'agent_command', payload: { command: 'check business health' } });
    await ops.tick();
    const { run } = await persistedBrief(store, job.id);
    assert.equal(run.ai.effects.costStatus, zeroProven ? 'not_incurred' : 'unknown');
    assert.equal(run.ai.effects.accountedCostMicros, zeroProven ? 0 : null);
    assert.equal(run.ai.used, false);
    assert.ok(run.summary);
  }
});
