import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { dueRules, ensureControl } from '../lib/control.mjs';
import { marketingCreativeCycle, marketingCreativeReadiness } from '../lib/marketing.mjs';
import { createScheduler } from '../lib/scheduler.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

const NOW = Date.parse('2026-10-13T00:00:00.000Z');
const campaign = (status = 'pending') => ({ id: 'synthetic-campaign', status: 'draft',
  creativeRequests: [{ provider: 'runway', status,
    ...(status === 'in_progress' ? { stage: 'generation', taskId: 'known_task' } : {}) }] });
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const primary = f => f.calls.filter(c => c.table === 'saas_workspace_state' && c.method === 'PATCH');
const writes = f => f.calls.filter(c => !['GET', 'HEAD'].includes(c.method));
const bodyBytes = calls => calls.reduce((sum, c) => sum + Buffer.byteLength(c.body), 0);

test.beforeEach(t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Live network is forbidden in readiness tests'));
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
});

async function fixture(t, { marketing, rules = ['marketingCreativeWorker'], padding = 0, creativeCycle, providerFetch } = {}) {
  const initial = seedWorkspaceState({}, { workspaceId: 'idle-creative-fixture', email: 'fixture@example.test' });
  ensureControl(initial);
  initial._revision = randomUUID();
  initial.autopilot.enabled = true;
  for (const key of Object.keys(initial.automations)) initial.automations[key] = rules.includes(key);
  if (marketing !== undefined) initial.marketing = marketing;
  if (padding) initial.syntheticFixturePayload = 'x'.repeat(padding);
  const fake = fakeSupabase({ initialStates: [initial] });
  const f = { fake, calls: [], providerCalls: [], workerCalls: 0, intercept: null, workspaceId: initial.workspace.id };
  f.store = createStore({ SUPABASE_URL: 'https://local.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only' }, {
    fetchImpl: async (url, options = {}) => {
      const call = { url: new URL(url), table: new URL(url).pathname.split('/').pop(), method: options.method || 'GET', body: options.body || '' };
      f.calls.push(call);
      const perform = () => fake.fetchImpl(url, options);
      return f.intercept ? f.intercept(call, perform) : perform();
    }
  });
  f.state = await f.store.get(f.workspaceId);
  f.calls.length = 0;
  f.scheduler = createScheduler({ store: f.store, integrations: {}, enabled: false, env: {},
    withWorkspaceLock: async (_id, action) => action(), currentBrief: () => ({ id: 'brief', summary: 'Synthetic brief' }),
    creativeCycle: async (state, options) => {
      f.workerCalls++;
      const execute = () => marketingCreativeCycle(state, { ...options,
        env: { MARKETING_ENV_WORKSPACE_ID: f.workspaceId, RUNWAY_API_KEY: 'synthetic-provider-key' },
        fetchImpl: async (url, request = {}) => {
          f.providerCalls.push({ url, method: request.method || 'GET' });
          assert.equal(f.fake.states.get(f.workspaceId).automationRuns[0].status, 'IN PROGRESS', 'Claim must be durable before a provider read');
          return providerFetch ? providerFetch(url, request) : Response.json({ status: 'RUNNING', progress: 20 });
        }
      });
      return creativeCycle ? creativeCycle(state, options, execute) : execute();
    }
  });
  t.after(() => f.scheduler.stop());
  f.run = (options = {}) => f.scheduler.runWorkspace(f.workspaceId, { now: new Date(), ...options });
  return f;
}

test('readiness is pure and agrees with worker defaults and exact campaign/request eligibility', async () => {
  const cases = [
    ...[null, undefined, 4, 'bad'].map(state => [state, 'CREATIVE_WORK_UNKNOWN']),
    [{}, 'NO_CREATIVE_WORK'], [{ marketing: null }, 'NO_CREATIVE_WORK'],
    [{ marketing: { campaigns: {} } }, 'NO_CREATIVE_WORK'],
    ...[undefined, null, 0, '', 'false', true].map(value => [{ marketing: { settings: { enabled: value, autoCreative: value }, campaigns: [campaign()] } }, 'CREATIVE_WORK_READY']),
    ...['enabled', 'autoCreative'].map(key => [{ marketing: { settings: { [key]: false }, campaigns: [null] } }, 'AUTO_CREATIVE_OFF']),
    ...['draft', 'creative_generation', 'creative_attention'].flatMap(status => ['pending', 'in_progress'].map(requestStatus =>
      [{ marketing: { campaigns: [{ ...campaign(requestStatus), status }] } }, 'CREATIVE_WORK_READY'])),
    ...['prepared', 'published', 'unknown', undefined].map(status => [{ marketing: { campaigns: [{ ...campaign(), status }] } }, 'NO_CREATIVE_WORK']),
    ...['complete', 'failed', 'unknown', undefined].map(status => [{ marketing: { campaigns: [{ ...campaign(), creativeRequests: [{ provider: 'runway', status }] }] } }, 'NO_CREATIVE_WORK']),
    [{ marketing: { campaigns: [{ ...campaign(), creativeRequests: null }] } }, 'NO_CREATIVE_WORK'],
    [{ marketing: { campaigns: [null] } }, 'CREATIVE_WORK_UNKNOWN'],
    ...['minMarginPercent', 'minInventory'].map(key => [{ marketing: { settings: { [key]: { toString: null, valueOf: null } }, campaigns: [] } }, 'CREATIVE_WORK_UNKNOWN']),
    [{ marketing: { campaigns: [{ ...campaign(), creativeRequests: {} }] } }, 'CREATIVE_WORK_UNKNOWN'],
    [{ marketing: { campaigns: [{ ...campaign(), creativeRequests: [null] }] } }, 'CREATIVE_WORK_UNKNOWN']
  ];
  for (const [state, expected] of cases) {
    const original = structuredClone(state);
    assert.equal(marketingCreativeReadiness(freeze(state)), expected);
    assert.deepEqual(state, original);
    const work = marketingCreativeCycle(structuredClone(state), { env: {}, fetchImpl: () => assert.fail('No provider admission') });
    if (expected === 'CREATIVE_WORK_UNKNOWN') await assert.rejects(work, TypeError);
    else {
      const result = await work;
      if (expected === 'CREATIVE_WORK_READY') assert.ok(!['AUTO_CREATIVE_OFF', 'NO_CREATIVE_WORK'].includes(result.reason));
      else assert.equal(result.reason, expected);
    }
  }
  const state = freeze({ marketing: { campaigns: [campaign()], creativeCampaignCursor: 'synthetic-campaign' } });
  assert.equal(marketingCreativeReadiness(state, { campaignId: 'absent' }), 'NO_CREATIVE_WORK');
  assert.equal(marketingCreativeReadiness(state, { campaignId: 'synthetic-campaign' }), 'CREATIVE_WORK_READY');
});

test('24 idle automatic ticks make no creative claims, audit records, provider calls or write bytes', async t => {
  const f = await fixture(t, { padding: 1_400_000 });
  const before = structuredClone(f.fake.states.get(f.workspaceId));
  for (let i = 0; i < 24; i++) { t.mock.timers.setTime(NOW + i * 15 * 60000); await f.scheduler.tick(); }
  assert.equal(f.workerCalls, 0);
  assert.deepEqual(f.providerCalls, []);
  assert.equal(primary(f).length, 0);
  assert.equal(writes(f).length, 0);
  assert.equal(bodyBytes(f.calls), 0);
  assert.deepEqual(f.fake.states.get(f.workspaceId), before);
  assert.equal(f.scheduler.status.lastError, null);
  const automaticRequests = f.calls.length;

  // Manual scheduling retains the exact claim/worker/completion path that
  // automatic idle scheduling used before this filter. Count real serialized
  // store requests, not save spies; these are synthetic API-body measurements.
  t.mock.timers.setTime(NOW);
  const legacyPath = await fixture(t, { padding: 1_400_000 });
  for (let i = 0; i < 24; i++) {
    t.mock.timers.setTime(NOW + i * 15 * 60000);
    const result = await legacyPath.run({ manual: true });
    assert.equal(result.runs[0].reason, 'NO_CREATIVE_WORK');
  }
  assert.equal(legacyPath.workerCalls, 24);
  assert.equal(primary(legacyPath).length, 48);
  assert.ok(bodyBytes(primary(legacyPath)) > 48 * 1_400_000);
  assert.equal(legacyPath.providerCalls.length, 0);
  t.diagnostic(JSON.stringify({ syntheticOnly: true, ticks: 24, payloadPadding: 1_400_000,
    automaticRequests, automaticWriteRequests: writes(f).length, automaticBodyBytes: bodyBytes(f.calls),
    retainedClaimPathRequests: legacyPath.calls.length, retainedClaimPathWriteRequests: writes(legacyPath).length,
    avoidedFullStateRequests: primary(legacyPath).length, avoidedFullStateBodyBytes: bodyBytes(primary(legacyPath)),
    retainedClaimPathTotalBodyBytes: bodyBytes(legacyPath.calls) }));
});

test('disabled automatic work stays idle while explicit manual and direct no-work results remain available', async t => {
  for (const settings of [{ enabled: false }, { autoCreative: false }]) {
    const f = await fixture(t, { marketing: { settings, campaigns: [campaign('in_progress')] } });
    assert.equal((await f.run()).skipped, true);
    assert.equal(writes(f).length, 0);
    assert.equal(f.workerCalls, 0);
    const manual = await f.run({ manual: true });
    assert.equal(manual.runs[0].reason, 'AUTO_CREATIVE_OFF');
    assert.equal(primary(f).length, 2);
    assert.equal(f.providerCalls.length, 0);
  }
});

test('filter changes only the idle creative rule in a mixed due-rule cycle', async t => {
  const f = await fixture(t, { rules: ['marketingCreativeWorker', 'profitGuard', 'seoChecks', 'priceRecommendations'] });
  const expected = dueRules(f.state, new Date(), {}).map(rule => rule.id).filter(id => id !== 'marketingCreativeWorker');
  const result = await f.run();
  assert.deepEqual(result.runs.map(run => run.ruleId), expected);
  assert.equal(primary(f).length, 2);
  assert.equal(f.workerCalls, 0);
  assert.ok(!f.fake.states.get(f.workspaceId).audit.some(row => row.detail?.ruleId === 'marketingCreativeWorker'));
});

test('pending work is claimed and durably blocked by the existing allowance gate without provider requests', async t => {
  const f = await fixture(t, { marketing: { campaigns: [campaign()] } });
  const result = await f.run();
  assert.equal(result.runs[0].status, 'BLOCKED');
  assert.equal(result.runs[0].reason, 'CREATIVE_ALLOWANCE_REQUIRED');
  assert.equal(f.providerCalls.length, 0);
  assert.equal(primary(f).length, 2);
  assert.equal(JSON.parse(primary(f)[0].body).state.automationRuns[0].status, 'IN PROGRESS');
  assert.equal(f.fake.states.get(f.workspaceId).automationRuns[0].status, 'BLOCKED');
});

test('worker rechecks readiness after the durable claim when settings change during execution', async t => {
  const f = await fixture(t, { marketing: { campaigns: [campaign('in_progress')] },
    creativeCycle: (state, _options, execute) => { state.marketing.settings.autoCreative = false; return execute(); } });
  const result = await f.run();
  assert.equal(result.runs[0].reason, 'AUTO_CREATIVE_OFF');
  assert.equal(result.runs[0].status, 'COMPLETED');
  assert.equal(primary(f).length, 2);
  assert.equal(f.providerCalls.length, 0);
});

test('accepted jobs retain durable claim-before-read, observation and completion', async t => {
  const f = await fixture(t, { marketing: { campaigns: [campaign('in_progress')] },
    providerFetch: () => Response.json({ status: 'SUCCEEDED', output: ['https://example.test/synthetic.mp4'] }) });
  const result = await f.run();
  assert.deepEqual(f.providerCalls, [{ url: 'https://api.dev.runwayml.com/v1/tasks/known_task', method: 'GET' }]);
  const saved = f.fake.states.get(f.workspaceId);
  assert.equal(saved.marketing.campaigns[0].creativeRequests[0].status, 'complete');
  assert.equal(saved.marketing.campaigns[0].creativeRequests[0].taskId, 'known_task');
  assert.equal(saved.automationRuns[0].status, 'COMPLETED');
  assert.equal(result.spend, null);
  assert.equal(result.effects.submissionAttempts, 0);
  assert.ok(primary(f).length >= 2);
});

test('new work appears on the next tick after a local save and after the existing remote revision check', async t => {
  for (const remote of [false, true]) {
    t.mock.timers.setTime(NOW);
    const f = await fixture(t);
    await f.scheduler.tick();
    assert.equal(f.workerCalls, 0);
    if (remote) {
      const updated = f.fake.states.get(f.workspaceId);
      updated.marketing.campaigns.push(campaign()); updated._revision = randomUUID();
      t.mock.timers.setTime(NOW + f.store.schedulerRevisionCheckMs);
    } else {
      f.state.marketing.campaigns.push(campaign());
      await f.store.save(f.workspaceId, f.state);
    }
    f.calls.length = 0;
    await f.scheduler.tick();
    assert.equal(f.workerCalls, 1);
    assert.equal(primary(f).length, 2);
    assert.equal(f.fake.states.get(f.workspaceId).automationRuns[0].reason, 'CREATIVE_ALLOWANCE_REQUIRED');
  }
});

test('idle ticks consume no quota and the existing 32-run limit still bounds genuine work', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++) { t.mock.timers.setTime(NOW + i * 15 * 60000); await f.scheduler.tick(); }
  assert.equal(f.fake.states.get(f.workspaceId).automationRuns.length, 0);
  f.state.marketing.campaigns.push(campaign('in_progress'));
  await f.store.save(f.workspaceId, f.state);
  for (let i = 8; i < 41; i++) { t.mock.timers.setTime(NOW + i * 15 * 60000); await f.scheduler.tick(); }
  assert.equal(f.workerCalls, 32);
  assert.equal(f.providerCalls.length, 32);
  assert.equal(f.fake.states.get(f.workspaceId).automationRuns.length, 32);
  assert.equal(f.fake.states.get(f.workspaceId).autopilot.rules.marketingCreativeWorker.maxRunsPerDay, 32);
});

test('a campaign created by a due planner is discovered on the following tick without a creative interval charge', async t => {
  const f = await fixture(t, { rules: ['marketingPlanner', 'marketingCreativeWorker'] });
  f.state.products = [{ id: 'p1', externalId: 'p1', title: 'Synthetic mailing bags', status: 'active',
    image: 'https://cdn.shopify.com/example.jpg', variants: [{ id: 'v1', externalId: 'v1', sku: 'TEST', title: '100 pack', price: 20, inventory: 50, available: true }] }];
  f.state.economics.TEST = { landed: 6, packing: 0.5, handling: 0.5, delivery: 1, paymentFee: 0.2, channelFee: 0.2, advertising: 0, otherVariable: 0, marginFloor: 20 };
  await f.store.save(f.workspaceId, f.state); f.calls.length = 0;
  const planner = await f.run();
  assert.deepEqual(planner.runs.map(run => run.ruleId), ['marketingPlanner']);
  assert.equal(planner.runs[0].status, 'COMPLETED');
  assert.equal(f.fake.states.get(f.workspaceId).marketing.campaigns.length, 1);
  t.mock.timers.setTime(NOW + 60000);
  const creative = await f.run();
  assert.deepEqual(creative.runs.map(run => run.ruleId), ['marketingCreativeWorker']);
  assert.equal(creative.runs[0].reason, 'CREATIVE_ALLOWANCE_REQUIRED');
  assert.equal(f.providerCalls.length, 0);
});

test('malformed request arrays retain a claimed failure instead of being silently treated as idle', async t => {
  const f = await fixture(t, { marketing: { campaigns: [{ ...campaign(), creativeRequests: {} }] } });
  const result = await f.run();
  assert.equal(f.workerCalls, 1);
  assert.equal(result.runs[0].status, 'FAILED');
  assert.equal(result.runs[0].costStatus, 'unknown');
  assert.equal(primary(f).length, 2);
  assert.equal(f.providerCalls.length, 0);
});

test('claim CAS conflict permits no worker or provider effect and preserves the newer revision', async t => {
  const f = await fixture(t, { marketing: { campaigns: [campaign('in_progress')] } });
  const newer = randomUUID();
  f.intercept = (c, perform) => {
    if (c.table === 'saas_workspace_state' && c.method === 'PATCH') f.fake.states.get(f.workspaceId)._revision = newer;
    return perform();
  };
  await assert.rejects(f.run(), { code: 'STATE_CONFLICT' });
  assert.equal(f.workerCalls, 0);
  assert.equal(f.providerCalls.length, 0);
  assert.equal(f.fake.states.get(f.workspaceId)._revision, newer);
});

test('lost claim acknowledgement is resolved by the existing revision read without duplicate provider work', async t => {
  const f = await fixture(t, { marketing: { campaigns: [campaign('in_progress')] } });
  let lost = false;
  f.intercept = async (c, perform) => {
    const result = await perform();
    if (!lost && c.table === 'saas_workspace_state' && c.method === 'PATCH') { lost = true; throw new TypeError('synthetic lost acknowledgement'); }
    return result;
  };
  const result = await f.run();
  assert.equal(result.runs[0].status, 'COMPLETED');
  assert.equal(f.workerCalls, 1);
  assert.equal(f.providerCalls.length, 1);
  assert.equal(primary(f).length, 2);
  assert.ok(f.calls.some(c => c.url.searchParams.get('select') === 'revision:state->>_revision'));
});

test('provider uncertainty keeps known jobs, unknown costs and existing failure evidence', async t => {
  const f = await fixture(t, { marketing: { campaigns: [campaign('in_progress')] },
    providerFetch: () => { throw new TypeError('synthetic provider timeout'); } });
  const result = await f.run();
  assert.equal(result.runs[0].status, 'FAILED');
  assert.equal(result.runs[0].reason, 'CREATIVE_STATUS_READ_FAILED');
  assert.equal(result.spend, null);
  assert.equal(f.fake.states.get(f.workspaceId).marketing.campaigns[0].creativeRequests[0].taskId, 'known_task');
  assert.ok(f.providerCalls.every(c => c.method === 'GET'));
});

test('expired creative leases still save recovery once while an idle replacement is omitted', async t => {
  const f = await fixture(t);
  f.state.automationRuns.push({ id: 'expired', ruleId: 'marketingCreativeWorker', status: 'IN PROGRESS',
    startedAt: new Date(NOW - 3600000).toISOString(), leaseUntil: new Date(NOW - 3000000).toISOString(), evidence: [] });
  await f.store.save(f.workspaceId, f.state); f.calls.length = 0;
  assert.equal((await f.run()).skipped, true);
  assert.equal(primary(f).length, 1);
  const run = f.fake.states.get(f.workspaceId).automationRuns[0];
  assert.equal(run.status, 'BLOCKED'); assert.equal(run.errorCode, 'WORKER_INTERRUPTED');
  assert.equal(run.costStatus, 'unknown'); assert.equal(f.workerCalls, 0);
  f.calls.length = 0;
  await f.run();
  assert.equal(writes(f).length, 0);
});

test('drain after repeated idle ticks closes admission with no writes or abandoned work', async t => {
  const f = await fixture(t);
  await f.scheduler.tick(); await f.scheduler.tick();
  assert.deepEqual(await f.scheduler.drain(), { settled: true, errors: 0, lastError: null });
  assert.deepEqual(await f.run({ manual: true }), { skipped: true, reason: 'SCHEDULER_STOPPED' });
  assert.equal(writes(f).length, 0);
});
