import { createGovernedRecordStage, GOVERNED_RECORD_PRODUCER_CONTRACT } from '../lib/governed-record-stage.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { detectExceptions, detectOpportunities } from '../lib/control.mjs';
import { buildDailyBrief, deriveOperations } from '../lib/operations.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { prepareExperimentOutcomeMeasurement } from '../lib/experiment-measurements.mjs';
import { proposeConnectionWrite, executeConnectionWrite } from '../lib/connection-writes.mjs';
import { resolveManualContentTarget } from '../lib/manual-content-target.mjs';
import { objectiveContentSeed, approveObjectiveContent, CONTENT_PRODUCT } from './objective-content-fixture.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

const governedRecordStage = createGovernedRecordStage({ GOVERNED_RECORD_PRODUCER_CONTRACT });

const priorVersion = 'imported-order-analytics/v3';
const nextVersion = 'catalogue-margin-thresholds/v2';
const costs = (packing = 0, landed = 9) => ({ landed, packing, handling: 0, delivery: 0, paymentFee: 0, channelFee: 0, advertising: 0, otherVariable: 0 });
// Exact prior signature, deliberately independent of the current implementation/version.
function priorSignature(state) {
  return createHash('sha256').update(JSON.stringify({
    calculationVersion: priorVersion,
    products: state.products || [], orders: state.orders || [], economics: state.economics || {},
    advertisingCosts: state.advertisingCosts || [], revenueEngine: state.revenueEngine || {}, approvals: state.approvals || [],
    integrationStatus: Object.fromEntries(Object.entries(state.integrationStatus || {}).map(([key, value]) => [key, {
      status: value.status, source: value.source, lastError: value.lastError,
      lastSyncAt: ['supabase', 'reporting', 'render'].includes(key) ? null : value.lastSyncAt
    }])),
    automations: state.automations || {}, suppliers: state.suppliers || [],
    decisions: (state.decisions || []).filter(item => item.status === 'active').map(item => item.id),
    exceptions: (state.exceptions || []).map(item => [item.id, item.status]),
    automationFailures: (state.automationRuns || []).filter(item => ['FAILED', 'BLOCKED'].includes(item.status)).map(item => item.id)
  })).digest('hex').slice(0, 32);
}

for (const storage of ['file', 'mock-supabase']) test(`${storage}: recorded-cost semantics reconcile one v3 cache and preserve source/history without recurring writes`, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-recorded-cost-cache-'));
  const secret = 'recorded-cost-cache-synthetic-session-secret-over-32-characters';
  const database = storage === 'mock-supabase' ? fakeSupabase() : null;
  const store = database ? createStore({ SUPABASE_URL: 'https://recorded-cost.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only' }, { fetchImpl: database.fetchImpl }) : null;
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: 'recorded-cost-synthetic-credential-key-over-32-characters',
    SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false'
  }, { schedulerEnabled: false, agentOpsEnabled: false, ...(store ? { store } : {}) });
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const state = seedWorkspaceState({}, { workspaceId: 'recorded-cost-cache', email: 'owner@recorded-cost.test', passwordHash: 'synthetic-only' });
  const now = new Date().toISOString();
  const malformed = [['BOOLEAN', false], ['BLANK', '   '], ['ARRAY', []], ['NULL-ARRAY', [null]]];
  state.products = [{ id: 'p1', provider: 'shopify', title: 'Synthetic recorded packaging catalogue', status: 'active',
    description: 'Synthetic recorded catalogue description. '.repeat(5), image: 'https://example.invalid/image.png',
    variants: [...malformed.map(([sku]) => ({ id: sku, sku, price: 10, inventory: 50 })), { id: 'ZERO', sku: 'ZERO', price: 10, inventory: 50 }] }];
  state.economics = Object.fromEntries([...malformed.map(([sku, value]) => [sku, costs(value)]), ['ZERO', costs(0, 0)]]);
  state.costHistory = [{ id: 'retained-cost-history', sku: 'BOOLEAN', before: { packing: '' }, after: { packing: false }, createdAt: now }];
  state.revenueEngine.experiments = [{ id: 'historical-cost-independent-result', title: 'Owner recorded contribution', status: 'measured',
    outcomeMeasurement: prepareExperimentOutcomeMeasurement({ expectedRevision: 0, amount: '12.000001', currency: 'GBP',
      window: { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' },
      coverage: { status: 'complete', observedCount: 2, expectedCount: 2 }, method: { kind: 'reconciled_manual' },
      observedAt: '2026-10-06T12:00:00.000Z', report: { description: 'Synthetic owner measurement independent of catalogue costs.', costsComplete: true }
    }, { workspaceId: state.workspace.id, experimentId: 'historical-cost-independent-result', actorId: state.users[0].id,
      now: '2026-10-06T16:00:00.000Z', previousMeasurement: null }) }];
  // Reproduce the old numeric interpretation without calling a future parser on malformed source.
  const oldView = structuredClone(state);
  for (const [sku] of malformed) oldView.economics[sku].packing = 0;
  detectExceptions(oldView, 'prior-fixture'); detectOpportunities(oldView, 'prior-fixture');
  state.exceptions = oldView.exceptions; state.opportunities = oldView.opportunities;
  const oldBrief = { ...buildDailyBrief(oldView), id: 'prior-recorded-cost-brief', calculationVersion: priorVersion,
    sourceSignature: priorSignature(state) };
  assert.equal(oldBrief.costCoverage, 100); assert.equal(oldBrief.lowMargin, 4);
  state.dailyBriefs = [oldBrief]; state.controlSignature = priorSignature(state);
  state.agentRuns = [{ id: 'prior-cost-agent-run', calculationVersion: priorVersion, completedAt: now, status: 'Completed',
    summary: 'Four catalogue rows are fully costed and below their margin floor.',
    results: [{ agentId: 'pricing', status: 'Warning', finding: 'Four fully costed variants need pricing review.', confidence: 0.94, issues: [] }] }];
  state.agentActivity = [{ id: 'prior-cost-agent-activity', calculationVersion: priorVersion, agentId: 'pricing',
    message: 'Four fully costed variants need pricing review.', createdAt: now }];
  await server.packsmart.store.save(state.workspace.id, state);
  if (store) {
    state.controlSignature = priorSignature(state); state.dailyBriefs[0].sourceSignature = state.controlSignature;
    await store.save(state.workspace.id, state);
  }
  const before = await server.packsmart.store.get(state.workspace.id);
  assert.equal(before.controlSignature, priorSignature(before), 'No input or reporting change is smuggled into the invalidation fixture');
  const preserved = structuredClone({ economics: before.economics, costHistory: before.costHistory, measurements: before.revenueEngine.experiments,
    brief: before.dailyBriefs[0], runs: before.agentRuns, activity: before.agentActivity, exceptions: before.exceptions, opportunities: before.opportunities });
  const normalizedBrief = database ? structuredClone(database.tables.get('operations_briefs').find(row => row.id === oldBrief.id)) : null;
  const callsBefore = database?.calls.length, activityBefore = store?.activitySnapshot(state.workspace.id);
  let saves = 0, providerCalls = 0;
  const save = server.packsmart.store.save.bind(server.packsmart.store);
  server.packsmart.store.save = async (...args) => { saves++; return save(...args); };
  server.packsmart.integrations.syncAll = async () => { providerCalls++; assert.fail('Catalogue reconciliation cannot call a provider'); };
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  const bootstrap = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bootstrap`, { headers: { Cookie: `packsmart_session=${token}` } });
    assert.equal(response.status, 200); return response.json();
  };
  const first = await bootstrap();
  assert.notEqual(first.brief.id, oldBrief.id, 'Versioned interpretation must invalidate the otherwise identical v3 cache');
  assert.equal(first.brief.calculationVersion, nextVersion);
  assert.equal(first.brief.costCoverage, 20); assert.equal(first.brief.missingCosts, 4); assert.equal(first.brief.lowMargin, 0);
  assert.match(first.brief.summary, /4 variants still have incomplete variable-cost coverage/);
  assert.equal(first.dashboard.marginCoveredVariants, 1); assert.equal(first.dashboard.averageMargin, 100);
  assert.deepEqual(first.dashboard.mostProfitable.map(row => row.sku), ['ZERO']);
  assert.ok(first.exceptions.some(row => row.kind === 'cost_coverage' && row.present));
  assert.ok(first.exceptions.filter(row => row.kind === 'margin').every(row => row.present === false));
  assert.ok(first.opportunities.filter(row => row.kind === 'pricing').every(row => row.present === false));
  assert.equal(first.aiTeam.find(row => row.id === 'pricing').historical, true);
  assert.match(first.aiTeam.find(row => row.id === 'pricing').lastFinding, /Historical analysis/);
  assert.equal(first.agentRuns[0].historical, true); assert.equal(first.agentActivity[0].historical, true);
  const after = await server.packsmart.store.get(state.workspace.id);
  assert.equal(saves, 1, 'Exactly one existing primary save path reconciles this snapshot');
  assert.deepEqual(after.economics, preserved.economics); assert.deepEqual(after.costHistory, preserved.costHistory);
  assert.deepEqual(after.revenueEngine.experiments, preserved.measurements);
  assert.deepEqual(after.dailyBriefs.find(row => row.id === oldBrief.id), preserved.brief);
  assert.deepEqual(after.agentRuns, preserved.runs); assert.deepEqual(after.agentActivity, preserved.activity);
  for (const row of preserved.exceptions) assert.deepEqual(after.exceptions.find(item => item.id === row.id), { ...row, present: false });
  for (const row of preserved.opportunities) assert.deepEqual(after.opportunities.find(item => item.id === row.id), { ...row, present: false });
  if (database) {
    const calls = database.calls.slice(callsBefore);
    const primary = calls.filter(call => call.method === 'PATCH' && call.url.pathname.endsWith('/saas_workspace_state'));
    const reporting = calls.filter(call => call.url.pathname.endsWith('/rpc/runvara_commit_reporting_status'));
    assert.equal(primary.length, 1); assert.equal(reporting.length, 1);
    assert.ok(Buffer.byteLength(reporting[0].body) <= 16384);
    assert.equal(Object.hasOwn(JSON.parse(reporting[0].body), 'state'), false);
    assert.ok(calls.every(call => !call.url.pathname.includes('business_outcome')));
    const oldMirrors = calls.filter(call => call.method === 'POST' && call.url.pathname.endsWith('/operations_briefs')).flatMap(call => JSON.parse(call.body));
    assert.equal(oldMirrors.some(row => row.id === oldBrief.id), false);
    assert.deepEqual(database.tables.get('operations_briefs').find(row => row.id === oldBrief.id), normalizedBrief);
    const activity = store.activitySnapshot(state.workspace.id);
    assert.equal(activity.db.operations.state_commit - activityBefore.db.operations.state_commit, 1);
    assert.equal(activity.db.operations.reporting_commit - activityBefore.db.operations.reporting_commit, 1);
    assert.equal(activity.hotState.confirmed.observations - activityBefore.hotState.confirmed.observations, 1);
    assert.equal(activity.hotState.confirmed.bytes, Buffer.byteLength(JSON.stringify(JSON.parse(primary[0].body).state)));
  }
  const secondCallsBefore = database?.calls.length, secondActivityBefore = store?.activitySnapshot(state.workspace.id);
  const second = await bootstrap(), unchanged = await server.packsmart.store.get(state.workspace.id);
  assert.equal(second.brief.id, first.brief.id); assert.equal(saves, 1, 'The next unchanged bootstrap must not save');
  assert.equal(unchanged._revision, after._revision); assert.deepEqual(unchanged, after);
  if (database) {
    assert.ok(database.calls.slice(secondCallsBefore).every(call => call.method === 'GET'));
    const activity = store.activitySnapshot(state.workspace.id);
    assert.equal(activity.db.operations.state_commit, secondActivityBefore.db.operations.state_commit);
    assert.equal(activity.db.operations.reporting_commit, secondActivityBefore.db.operations.reporting_commit);
    assert.deepEqual(activity.hotState, secondActivityBefore.hotState);
  }
  assert.equal(providerCalls, 0);
});

test('unknown catalogue costs and valid zero costs do not authorize enforced financial or stock execution', async t => {
  for (const kind of ['malformed', 'explicit-zero'])
  for (const limits of [{ profitFirst: true }, { profitFirst: false, minGrossMarginPercent: 0 },
    { profitFirst: false, minStockCoverDays: 0 }, { profitFirst: false, maxMonthlyAdBudget: 0, currency: 'GBP' }]) {
    await t.test(`${kind} ${JSON.stringify(limits)}`, async () => {
      const { state, session } = objectiveContentSeed({ limits });
      state._revision = 'synthetic-recorded-cost-revision';
      state.products[0].variants = [{ id: 'cost-variant', sku: 'COST', price: 10, inventory: 50 }];
      state.economics = { COST: costs(kind === 'malformed' ? false : 0, 0) };
      const metrics = deriveOperations(state);
      assert.equal(metrics.costCoverage, kind === 'malformed' ? 0 : 100);
      const write = proposeConnectionWrite(state, 'shopify', { target: resolveManualContentTarget(state).target,
        requestId: 'recorded_cost_policy_0001', operation: 'product_content', productId: CONTENT_PRODUCT,
        title: 'Synthetic reviewed content', description: 'Synthetic approved description' }, session.userId, { governedRecordStage });
      approveObjectiveContent(state, write);
      const before = structuredClone(state);
      let preparation = 0, saves = 0, freshReads = 0;
      const integrations = new Proxy({}, { get() { preparation++; assert.fail('Financial denial must precede every integration preparation'); } });
      await assert.rejects(executeConnectionWrite(state, write.id, session.userId, integrations,
        async () => { saves++; assert.fail('Financial denial must precede a claim save'); },
        { governedRecordStage, durableStore: true, actorSession: session, loadFreshState: async () => { freshReads++; assert.fail('No claim or final dispatch read is needed'); } }),
        error => error.code === 'WRITE_POLICY_EVIDENCE_REQUIRED');
      assert.equal(preparation, 0); assert.equal(saves, 0); assert.equal(freshReads, 0);
      assert.equal(write.dispatchClaim, undefined); assert.deepEqual(state, before);
    });
  }
});
