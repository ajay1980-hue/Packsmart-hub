import test from 'node:test';
import assert from 'node:assert/strict';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createScheduler } from '../lib/scheduler.mjs';
import { addWebIntelligenceTarget } from '../lib/web-intelligence.mjs';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const freshEffects = { providerReads: 0, submissionAttempts: 0, confirmedSubmissions: 0, uncertainSubmissions: 0,
  blockedSubmissions: 0, historicalExposureUnknown: false, externalWrites: false, spend: 0, costStatus: 'not_incurred' };
test.beforeEach(t => { t.mock.method(globalThis, 'fetch', () => assert.fail('No provider calls in web safety tests')); });
function setup({ prior = false, noTarget = false, disabled = false, rules = ['marketRadar'], webCycle } = {}) {
  const state = seedWorkspaceState({}, { workspaceId: 'web-effects' }); state.autopilot.enabled = true;
  for (const key of Object.keys(state.automations)) state.automations[key] = rules.includes(key);
  if (!noTarget) {
    const target = addWebIntelligenceTarget(state, { url: 'https://example.test/public' });
    if (prior) { target.snapshot = { prices: [10], fingerprint: 'old' }; target.lastScannedAt = '2026-10-01T00:00:00.000Z'; }
  }
  state.webIntelligence ||= { settings: {} }; state.webIntelligence.settings.enabled = !disabled;
  const saved = [];
  const store = { provider: 'supabase', get: async () => state, save: async (_id, value) => { saved.push(structuredClone(value)); return value; } };
  const scheduler = createScheduler({ store, integrations: {}, withWorkspaceLock: async (_id, action) => action(),
    currentBrief: () => ({ id: 'brief', summary: 'Synthetic' }), env: { FIRECRAWL_API_KEY: 'synthetic' }, enabled: false,
    ...(webCycle ? { webCycle } : {}), creativeCycle: async () => ({ advanced: 0, reason: 'NO_CREATIVE_WORK', effects: { ...freshEffects } }) });
  return { state, saved, run: () => scheduler.runWorkspace(state.workspace.id, { now: NOW }) };
}
for (const prior of [false, true]) {
  test(`marketRadar records a blocked zero-HTTP run with ${prior ? 'historically unknown' : 'not-incurred'} cost`, async () => {
    const f = setup({ prior }); const result = await f.run(); const run = result.runs.find(r => r.ruleId === 'marketRadar');
    assert.equal(run.status, 'BLOCKED'); assert.equal(run.errorCode, 'WEB_SCAN_ALLOWANCE_REQUIRED');
    assert.equal(run.effects.submissionAttempts, 0); assert.equal(run.effects.blockedSubmissions, 1);
    assert.equal(run.spend, prior ? null : 0); assert.equal(result.spend, run.spend); assert.equal(result.externalWrites, false);
    assert.equal(run.costStatus, prior ? 'unknown' : 'not_incurred'); assert.deepEqual(run.evidence[0].effects, run.effects);
    assert.match(run.evidence[0].detail, /0 verified scans/); assert.doesNotMatch(run.evidence[0].detail, /Scanned .*public pages|No external writes were attempted/);
    const audit = f.state.audit.find(e => e.type === 'autopilot_cycle_finished'); assert.equal(audit.detail.spend, run.spend);
    assert.equal(f.saved.at(-1).automationRuns.find(r => r.id === run.id).status, 'BLOCKED');
  });
}
test('empty or disabled marketRadar work is completed no-work and invokes no provider', async () => {
  for (const configuration of [{ noTarget: true }, { disabled: true }]) {
    const f = setup(configuration), result = await f.run(), run = result.runs.find(r => r.ruleId === 'marketRadar');
    assert.equal(run.status, 'COMPLETED'); assert.equal(run.effects.blockedSubmissions, 0); assert.equal(result.spend, 0);
    assert.ok(['WEB_NO_ACTIVE_TARGETS', 'WEB_SCANNING_DISABLED'].includes(run.reason));
  }
});
test('mixed creative/read-only cycles cannot hide marketRadar historical uncertainty', async () => {
  const f = setup({ prior: true, rules: ['marketRadar', 'marketingCreativeWorker', 'seoChecks'] });
  const result = await f.run(); assert.equal(result.spend, null); assert.equal(result.costStatus, 'unknown');
  assert.equal(result.runs.find(r => r.ruleId === 'marketRadar').status, 'BLOCKED');
  assert.equal(result.runs.find(r => r.ruleId === 'marketingCreativeWorker').status, 'COMPLETED');
});
test('missing effects and exceptions cannot create a zero-cost successful scan record', async () => {
  for (const webCycle of [async () => ({ scanned: 99 }), async () => { throw new Error('synthetic-secret-MUST-NOT-PERSIST'); }]) {
    const f = setup({ webCycle }), result = await f.run(), run = result.runs.find(r => r.ruleId === 'marketRadar');
    assert.notEqual(run.status, 'COMPLETED'); assert.equal(result.spend, null); assert.equal(result.externalWrites, null);
    assert.ok(!JSON.stringify(f.state).includes('synthetic-secret'));
  }
});
test('uncertain future/mock effect evidence is preserved without claiming verified scans', async () => {
  const webEffects = { ...freshEffects, submissionAttempts: 1, uncertainSubmissions: 1, historicalExposureUnknown: true,
    externalWrites: null, spend: null, costStatus: 'unknown' };
  const f = setup({ webCycle: async () => { throw Object.assign(new Error('private upstream error'), { code: 'WEB_SCAN_RESPONSE_UNVERIFIED', webEffects }); } });
  const result = await f.run(), run = result.runs.find(r => r.ruleId === 'marketRadar');
  assert.deepEqual(run.effects, webEffects); assert.deepEqual(run.evidence[0].effects, webEffects);
  assert.equal(result.spend, null); assert.equal(result.externalWrites, null); assert.equal(run.status, 'FAILED');
});
test('interrupted old marketRadar runs without effects retain unknown cost on recovery', async () => {
  const f = setup({ noTarget: true });
  f.state.automationRuns.unshift({ id: 'legacy_web_run', ruleId: 'marketRadar', status: 'IN PROGRESS',
    startedAt: '2026-10-05T00:00:00.000Z', leaseUntil: '2026-10-05T00:10:00.000Z', spend: 0, evidence: [] });
  await f.run(); const recovered = f.state.automationRuns.find(r => r.id === 'legacy_web_run');
  assert.equal(recovered.status, 'BLOCKED'); assert.equal(recovered.errorCode, 'WORKER_INTERRUPTED');
  assert.equal(recovered.spend, null); assert.equal(recovered.externalWrites, null); assert.equal(recovered.costStatus, 'unknown');
});
