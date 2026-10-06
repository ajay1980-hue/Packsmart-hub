import test from 'node:test';
import assert from 'node:assert/strict';
import { seedWorkspaceState } from '../lib/store.mjs';
import { ensureControl } from '../lib/control.mjs';
import { createScheduler } from '../lib/scheduler.mjs';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const noEffects = (overrides = {}) => ({ providerReads: 0, submissionAttempts: 0, confirmedSubmissions: 0,
  uncertainSubmissions: 0, blockedSubmissions: 0, historicalExposureUnknown: false,
  externalWrites: false, spend: 0, costStatus: 'not_incurred', ...overrides });
const unknownEffects = (overrides = {}) => noEffects({ spend: null, costStatus: 'unknown', ...overrides });

test.beforeEach(t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network calls are forbidden in scheduler effect tests'); });
});

function setup(creativeCycle, rules = ['marketingCreativeWorker'], provider = 'file') {
  const state = seedWorkspaceState({}, { workspaceId: 'creative-effects-fixture' });
  ensureControl(state);
  state.autopilot.enabled = true;
  for (const key of Object.keys(state.automations)) state.automations[key] = rules.includes(key);
  const saved = [];
  const store = { provider, get: async () => state, save: async (id, value) => { assert.equal(id, state.workspace.id); saved.push(structuredClone(value)); } };
  const scheduler = createScheduler({ store, integrations: {}, withWorkspaceLock: async (_id, action) => action(),
    currentBrief: () => ({ id: 'test-brief', summary: 'Recorded summary' }), env: {}, enabled: false, creativeCycle });
  return { state, saved, run: () => scheduler.runWorkspace(state.workspace.id, { now: NOW }) };
}

function assertRecorded(fixture, result, expected) {
  const run = result.runs.find(item => item.ruleId === 'marketingCreativeWorker');
  assert.deepEqual(run.effects, expected);
  assert.equal(run.spend, expected.spend);
  assert.equal(run.externalWrites, expected.externalWrites);
  assert.equal(run.costStatus, expected.costStatus);
  assert.deepEqual(run.evidence[0].effects, expected);
  assert.equal(result.spend, expected.spend);
  assert.equal(result.externalWrites, expected.externalWrites);
  assert.equal(result.costStatus, expected.costStatus);
  assert.deepEqual(result.effects, expected);
  const cycle = fixture.state.audit.find(item => item.type === 'autopilot_cycle_finished').detail;
  assert.deepEqual(cycle, { runIds: result.runs.map(item => item.id), spend: expected.spend,
    externalWrites: expected.externalWrites, costStatus: expected.costStatus, effects: expected });
  const finish = fixture.state.audit.find(item => item.type === 'automation_finished' && item.detail.runId === run.id);
  assert.deepEqual(finish.detail.evidence[0].effects, expected);
  assert.deepEqual(fixture.saved.at(-1).automationRuns.find(item => item.id === run.id).effects, expected);
  return run;
}

test('creative scheduler records blocked generation without claiming completed generation', async () => {
  const effects = noEffects({ blockedSubmissions: 2 });
  const fixture = setup(async () => ({ advanced: 0, reason: 'CREATIVE_ALLOWANCE_REQUIRED', effects }));
  const run = assertRecorded(fixture, await fixture.run(), effects);
  assert.equal(run.status, 'BLOCKED');
  assert.equal(run.errorCode, 'CREATIVE_ALLOWANCE_REQUIRED');
  assert.equal(run.reason, 'CREATIVE_ALLOWANCE_REQUIRED');
  assert.match(run.evidence[0].detail, /2 blocked/);
  assert.doesNotMatch(run.evidence[0].detail, /No publishing or credit purchase was attempted/);
});

test('known-ID reads keep historical cost unknown while this cycle has no external writes', async () => {
  const effects = unknownEffects({ providerReads: 2, historicalExposureUnknown: true });
  const fixture = setup(async () => ({ advanced: 1, campaign: { id: 'legacy-campaign' }, effects }), ['marketingCreativeWorker', 'seoChecks']);
  const result = await fixture.run();
  const run = assertRecorded(fixture, result, effects);
  assert.equal(result.runs.length, 2);
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.evidence[0].id, 'legacy-campaign');
  assert.equal(result.runs.find(item => item.ruleId === 'seoChecks').spend, 0);
});

for (const reason of ['CREATIVE_STATUS_READ_FAILED', 'CREATIVE_PROVIDER_JOB_FAILED']) {
  test(`${reason} finishes failed with historical cost unknown and preserves known upstream IDs`, async () => {
    for (const provider of ['canva', 'runway']) {
      const effects = unknownEffects({ providerReads: 1, historicalExposureUnknown: true });
      const request = { provider, status: reason === 'CREATIVE_PROVIDER_JOB_FAILED' ? 'failed' : 'in_progress',
        ...(provider === 'canva' ? { stage: 'export', jobId: 'existing-canva-job' } : { stage: 'generation', taskId: 'existing-runway-task' }) };
      const campaign = { id: `existing-${provider}-campaign`, creativeRequests: [request] };
      const fixture = setup(async () => ({ advanced: 0, reason, campaign, effects }));
      fixture.state.marketing.campaigns = [structuredClone(campaign)];
      const run = assertRecorded(fixture, await fixture.run(), effects);
      assert.equal(run.status, 'FAILED');
      assert.equal(run.errorCode, reason);
      assert.equal(run.reason, reason);
      assert.equal(run.evidence[0].reason, reason);
      assert.equal(fixture.state.workRecords.find(item => item.id === run.id).status, 'FAILED');
      assert.equal(fixture.state.audit.find(item => item.type === 'automation_finished' && item.detail.runId === run.id).detail.status, 'FAILED');
      assert.deepEqual(fixture.saved.at(-1).marketing.campaigns[0].creativeRequests, [request]);
      assert.equal(run.effects.submissionAttempts, 0);
      assert.equal(run.effects.confirmedSubmissions, 0);
      assert.equal(run.effects.uncertainSubmissions, 0);
    }
  });
}

test('CREATIVE_PROVIDER_NOT_AVAILABLE finishes blocked without inventing submission attempts', async () => {
  const effects = unknownEffects({ historicalExposureUnknown: true });
  const request = { provider: 'runway', status: 'in_progress', stage: 'generation', taskId: 'existing-runway-task' };
  const campaign = { id: 'unavailable-provider-campaign', creativeRequests: [request] };
  const fixture = setup(async () => ({ advanced: 0, reason: 'CREATIVE_PROVIDER_NOT_AVAILABLE', campaign, effects }));
  fixture.state.marketing.campaigns = [structuredClone(campaign)];
  const run = assertRecorded(fixture, await fixture.run(), effects);
  assert.equal(run.status, 'BLOCKED');
  assert.equal(run.errorCode, 'CREATIVE_PROVIDER_NOT_AVAILABLE');
  assert.equal(run.reason, 'CREATIVE_PROVIDER_NOT_AVAILABLE');
  assert.deepEqual(fixture.saved.at(-1).marketing.campaigns[0].creativeRequests, [request]);
  assert.equal(run.effects.submissionAttempts, 0);
  assert.equal(run.effects.blockedSubmissions, 0);
});

test('AUTO_CREATIVE_OFF and NO_CREATIVE_WORK remain normal completed no-work results', async () => {
  for (const reason of ['AUTO_CREATIVE_OFF', 'NO_CREATIVE_WORK']) {
    const fixture = setup(async () => ({ advanced: 0, reason, effects: noEffects() }));
    const run = assertRecorded(fixture, await fixture.run(), noEffects());
    assert.equal(run.status, 'COMPLETED');
    assert.equal(run.errorCode, null);
    assert.equal(run.reason, reason);
  }
});

test('confirmed submissions are externally written with unknown cost, never reported as zero spend', async () => {
  const effects = unknownEffects({ submissionAttempts: 1, confirmedSubmissions: 1, externalWrites: true });
  const fixture = setup(async () => ({ advanced: 1, effects }));
  const run = assertRecorded(fixture, await fixture.run(), effects);
  assert.equal(run.status, 'COMPLETED');
});

test('unknown submission outcomes remain unconfirmed and blocked in run and cycle evidence', async () => {
  const effects = unknownEffects({ submissionAttempts: 1, uncertainSubmissions: 1, externalWrites: null });
  const fixture = setup(async () => ({ advanced: 0, effects }));
  const run = assertRecorded(fixture, await fixture.run(), effects);
  assert.equal(run.status, 'BLOCKED');
  assert.equal(run.errorCode, 'CREATIVE_OUTCOME_UNKNOWN');
});

test('partially progressed campaigns retain blocked submissions and known external writes', async () => {
  const effects = unknownEffects({ providerReads: 1, submissionAttempts: 2, confirmedSubmissions: 1,
    uncertainSubmissions: 1, blockedSubmissions: 1, externalWrites: true });
  const fixture = setup(async () => ({ advanced: 1, reason: 'CREATIVE_ALLOWANCE_REQUIRED', effects }));
  const run = assertRecorded(fixture, await fixture.run(), effects);
  assert.equal(run.status, 'BLOCKED');
  assert.equal(run.effects.uncertainSubmissions, 1);
});

test('persistence failures copy creativeEffects before failure evidence is recorded', async () => {
  const effects = unknownEffects({ submissionAttempts: 1, uncertainSubmissions: 1, externalWrites: null });
  const fixture = setup(async () => { throw Object.assign(new Error('Private upstream body'), { code: 'PERSISTENCE_FAILED', creativeEffects: { ...effects, providerRawResponse: 'private-provider-response' } }); });
  const result = await fixture.run();
  const run = assertRecorded(fixture, result, effects);
  assert.equal(run.status, 'FAILED');
  assert.equal(run.errorCode, 'PERSISTENCE_FAILED');
  assert.doesNotMatch(JSON.stringify(fixture.state), /Private upstream body|private-provider-response/);
});

test('errors without creative effect evidence cannot retain the initial zero-spend claim', async () => {
  const fixture = setup(async () => { throw Object.assign(new Error('Unavailable completion evidence'), { code: 'CREATIVE_FAILED' }); });
  const expected = unknownEffects({ historicalExposureUnknown: true, externalWrites: null });
  const run = assertRecorded(fixture, await fixture.run(), expected);
  assert.equal(run.status, 'FAILED');
});

test('missing or contradictory effect completion evidence is conservative', async () => {
  const missing = setup(async () => ({ advanced: 1, reason: 'NO_CREATIVE_WORK' }));
  const missingRun = assertRecorded(missing, await missing.run(), unknownEffects({ historicalExposureUnknown: true, externalWrites: null }));
  assert.equal(missingRun.status, 'BLOCKED');
  assert.equal(missingRun.errorCode, 'CREATIVE_EFFECTS_UNAVAILABLE');
  const contradictory = setup(async () => ({ advanced: 1,
    effects: noEffects({ submissionAttempts: 1, uncertainSubmissions: 1, externalWrites: true }) }));
  assertRecorded(contradictory, await contradictory.run(), unknownEffects({ submissionAttempts: 1, uncertainSubmissions: 1, externalWrites: null }));
  const unclassified = setup(async () => ({ advanced: 1, effects: unknownEffects({ submissionAttempts: 1 }) }));
  assertRecorded(unclassified, await unclassified.run(), unknownEffects({ submissionAttempts: 1, externalWrites: null }));
});

test('creative claim is durably unknown until worker evidence establishes no incurred cost', async () => {
  let fixture;
  fixture = setup(async () => {
    const claim = fixture.saved[0].automationRuns[0];
    assert.equal(claim.status, 'IN PROGRESS');
    assert.equal(claim.spend, null);
    assert.equal(claim.externalWrites, null);
    assert.equal(claim.costStatus, 'unknown');
    return { advanced: 0, reason: 'NO_CREATIVE_WORK', effects: noEffects() };
  });
  const run = assertRecorded(fixture, await fixture.run(), noEffects());
  assert.equal(run.status, 'COMPLETED');
});

test('scheduler exposes durable capability only for Supabase and supplies no allowance issuer', async () => {
  for (const provider of ['file', 'supabase']) {
    const fixture = setup(async (_state, options) => {
      assert.equal(options.durableStore, provider === 'supabase');
      assert.equal(typeof options.persist, 'function');
      assert.equal(options.authorizePhase, undefined);
      return { advanced: 0, effects: noEffects() };
    }, ['marketingCreativeWorker'], provider);
    assertRecorded(fixture, await fixture.run(), noEffects());
  }
});

test('expired legacy creative runs without effects remain unknown after recovery', async () => {
  const fixture = setup(async () => { assert.fail('Expired-only recovery must not invoke a creative cycle'); }, []);
  fixture.state.automationRuns.push({ id: 'legacy-creative-run', ruleId: 'marketingCreativeWorker', status: 'IN PROGRESS',
    startedAt: '2026-10-06T10:00:00.000Z', leaseUntil: '2026-10-06T10:10:00.000Z', spend: 0, evidence: [] });
  assert.equal((await fixture.run()).skipped, true);
  const run = fixture.saved.at(-1).automationRuns[0];
  assert.equal(run.status, 'BLOCKED');
  assert.equal(run.errorCode, 'WORKER_INTERRUPTED');
  assert.equal(run.spend, null);
  assert.equal(run.externalWrites, null);
  assert.equal(run.costStatus, 'unknown');
  assert.deepEqual(run.evidence[0].effects, run.effects);
});

test('noncreative automation preserves its existing no-spend read-only result shape', async () => {
  const fixture = setup(async () => { assert.fail('A noncreative cycle must not invoke the creative worker'); }, ['seoChecks']);
  const result = await fixture.run();
  assert.deepEqual(Object.keys(result).sort(), ['externalWrites', 'runs', 'skipped', 'spend']);
  assert.equal(result.spend, 0);
  assert.equal(result.externalWrites, false);
  assert.equal(result.runs[0].status, 'COMPLETED');
  assert.equal(result.runs[0].spend, 0);
  assert.equal(Object.hasOwn(result.runs[0], 'effects'), false);
  assert.deepEqual(fixture.state.audit.find(item => item.type === 'autopilot_cycle_finished').detail,
    { runIds: [result.runs[0].id], spend: 0, externalWrites: false });
});
