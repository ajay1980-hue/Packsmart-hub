/**
 * Explicit PostgreSQL 17.6 JSONB qualification, outside the default test glob.
 * Run through run-content-jsonb-postgres.sh with CONTENT_JSONB_TEST_FILE set to
 * this file. The existing harness creates and verifies removal of a dedicated
 * temporary localhost cluster. No real Supabase or Shopify endpoint is called.
 * SQL consists only of the fixture's parameterized SELECT $1::jsonb casts and
 * empty-schema checks; the adapter HTTP transport and mirror tables are fake.
 */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createStore } from '../lib/store.mjs';
import { costSourceReviewContext, prepareCostSourceReview, publicEconomicsSources, publicCostSourceHistory,
  COST_SOURCE_HISTORY_MAX_BYTES } from '../lib/cost-source-review.mjs';
import { createCostSourceStage, assertCostSourceCreation } from '../lib/cost-source-stage.mjs';
import { openJsonbFixture } from './content-jsonb-postgres-fixture.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
import { sourceState, appendReview, reviewInput, acceptedStoreModule, acceptedBootstrap,
  COST_SOURCE_SELECTOR as selector, COST_SOURCE_ACTOR as actor, COST_SOURCE_TIME as now, bytes } from './cost-source-persistence-fixture.mjs';

let pg, unexpectedNetwork = 0;
const originalFetch = globalThis.fetch;
before(async () => {
  globalThis.fetch = async () => { unexpectedNetwork++; throw new Error('No external network is permitted in the source persistence fixture'); };
  pg = await openJsonbFixture();
  console.log(JSON.stringify({ safety: pg.info, emptyFixture: true, applicationSchemaChanges: 0,
    realSql: 'SELECT $1::jsonb AS snapshot', httpQualification: false }));
});
after(async () => {
  try {
    if (pg) { await pg.close(); console.log(JSON.stringify({ realJsonbCasts: pg.casts.length,
      orderChangingCasts: pg.casts.filter(row => row.orderChanged).length, applicationSchemaChanges: 0,
      emptyAtFinish: true, unexpectedNetwork })); }
    assert.equal(unexpectedNetwork, 0);
  } finally { globalThis.fetch = originalFetch; }
});

function roundtripAdapter() {
  const fake = fakeSupabase(), castTargets = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://source-fixture.invalid', 'Only the synthetic adapter URL is accepted');
    const table = url.pathname.split('/').pop();
    if (options.body && ['runvara_create_workspace', 'saas_workspace_state', 'product_cost_profiles', 'cost_history'].includes(table)) {
      const body = JSON.parse(options.body);
      // Cast the exact authoritative snapshot or JSONB column payload. SQL
      // never creates application tables; fake transport models their mapping.
      if (table === 'runvara_create_workspace') body.p_state = pg.roundtrip(body.p_state);
      else if (table === 'saas_workspace_state') body.state = pg.roundtrip(body.state);
      else {
        const converted = pg.roundtrip(body.map(row => table === 'product_cost_profiles'
          ? { cost_data: row.cost_data } : { before_data: row.before_data, after_data: row.after_data }));
        body.forEach((row, index) => Object.assign(row, converted[index]));
      }
      options = { ...options, body: JSON.stringify(body) };
      castTargets.push(table);
    }
    return fake.fetchImpl(input, options);
  };
  const env = { SUPABASE_URL: 'https://source-fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-placeholder' };
  return { ...fake, env, fetchImpl, castTargets, store: createStore(env, { fetchImpl }) };
}

test('real JSONB reordered keys preserve revisions, full correction records, and exact replay identity', t => {
  let state = sourceState();
  const baseRevision = costSourceReviewContext(state, selector, actor, { now }).sourceRevision;
  state = pg.roundtrip(state);
  assert.equal(costSourceReviewContext(state, selector, actor, { now }).sourceRevision, baseRevision);
  const first = appendReview(state), producerOrder = Object.keys(first.plan.record);
  const firstSaved = structuredClone(state);
  state = pg.roundtrip(state);
  assert.notDeepEqual(Object.keys(state.economics[selector.sku].sourceBasis), producerOrder);
  assert.deepEqual(state, firstSaved);
  assert.equal(costSourceReviewContext(state, selector, actor, { now }).current.stale, false);
  const replay = prepareCostSourceReview(state, first.input, actor, { now });
  assert.equal(replay.duplicate, true); assert.deepEqual(replay.record, first.plan.record);
  const correction = reviewInput(state, { identifier: 'SYNTHETIC-CORRECTION-002' });
  const reordered = pg.roundtrip(state);
  assert.equal(costSourceReviewContext(reordered, selector, actor, { now }).sourceRevision, correction.sourceRevision);
  const plan = prepareCostSourceReview(reordered, pg.roundtrip(correction), actor, { now });
  reordered.economics[selector.sku] = plan.economics;
  reordered.costHistory.unshift(plan.historyEvent);
  state = pg.roundtrip(reordered);
  assert.equal(state.costHistory[0].before.sourceBasis, first.plan.record.id);
  assert.deepEqual(state.costHistory[1].after.sourceBasis, first.plan.record);
  assert.deepEqual(state.economics[selector.sku].sourceBasis, plan.record);
  assert.equal(prepareCostSourceReview(state, first.input, actor, { now }).duplicate, true);
  const retained = structuredClone(state.economics[selector.sku].sourceBasis);
  state.economics[selector.sku].landed = '5.2500';
  state = pg.roundtrip(state);
  const stale = costSourceReviewContext(state, selector, actor, { now });
  assert.equal(stale.current.stale, true);
  assert.deepEqual(stale.current.staleReasons, ['saved_costs_changed']);
  assert.deepEqual(state.economics[selector.sku].sourceBasis, retained);
  assert.equal(state.economics[selector.sku].packing, 0);
  assert.equal(state.economics[selector.sku].delivery, null);
  assert.equal(state.economics[selector.sku].supplierVatRecoverable, false);
  t.diagnostic(JSON.stringify({ producerRecordKeyOrder: producerOrder,
    postgresRecordKeyOrder: Object.keys(state.economics[selector.sku].sourceBasis), revisionsStable: true,
    retainedSources: stale.history.length, historicalReplayDoesNotReplaceLatest: true,
    ordinaryCostChangePreservesStaleSource: true }));
});

test('production Store mapping preserves source JSONB in primary state and existing reporting columns', async t => {
  const f = roundtripAdapter(), state = sourceState();
  const saveWire = async label => {
    const start = f.calls.length;
    await f.store.save(state.workspace.id, state);
    const calls = f.calls.slice(start);
    const primary = calls.find(call => /\/(?:runvara_create_workspace|saas_workspace_state)$/.test(call.url.pathname)
      && ['POST', 'PATCH'].includes(call.method));
    assert.ok(primary);
    const body = JSON.parse(primary.body);
    const mirror = table => calls.filter(call => call.method === 'POST' && call.url.pathname.endsWith(`/${table}`));
    return { label, primaryMethod: primary.method, primaryTable: primary.url.pathname.split('/').pop(),
      primaryRequestBodyBytes: Buffer.byteLength(primary.body), primarySnapshotBytes: bytes(body.p_state ?? body.state),
      profileRequestBodyBytes: mirror('product_cost_profiles').reduce((sum, call) => sum + Buffer.byteLength(call.body), 0),
      historyRequestBodyBytes: mirror('cost_history').reduce((sum, call) => sum + Buffer.byteLength(call.body), 0),
      allAdapterRequestBodyBytes: calls.reduce((sum, call) => sum + Buffer.byteLength(call.body), 0) };
  };
  const createWire = await saveWire('initial-create');
  // Compare source additions against the same existing-workspace PATCH path,
  // after the initial create/reporting status has settled.
  const wire = [await saveWire('baseline-existing')];
  const baselineStart = f.calls.length;
  await f.store.get(state.workspace.id);
  const baselineReads = f.calls.slice(baselineStart).filter(call => call.method === 'GET').length;
  assert.equal(baselineReads, 1);
  const first = appendReview(state);
  wire.push(await saveWire('first-source'));
  const correction = appendReview(state, { identifier: 'SYNTHETIC-CORRECTION-002' });
  wire.push(await saveWire('first-correction'));
  const lastSave = f.calls.length;
  await f.store.save(state.workspace.id, state);
  const repeatedSourceMirrors = f.calls.slice(lastSave).filter(call => call.method === 'POST'
    && /\/(?:product_cost_profiles|cost_history)$/.test(call.url.pathname));
  assert.equal(repeatedSourceMirrors.length, 0, 'An unchanged source should not repeat the reporting upserts');
  const coldStart = f.calls.length, cold = await f.store.get(state.workspace.id);
  assert.equal(f.calls.length - coldStart, baselineReads, 'Adding sources must not add ordinary snapshot read calls');
  assert.deepEqual(cold.economics[selector.sku].sourceBasis, correction.plan.record);
  assert.deepEqual(cold.costHistory.map(event => event.after), state.costHistory.map(event => event.after));
  const profile = f.tables.get('product_cost_profiles').find(row => row.sku === selector.sku);
  assert.deepEqual(profile.cost_data, state.economics[selector.sku]);
  const history = f.tables.get('cost_history');
  assert.equal(history.length, 3);
  for (const event of state.costHistory) {
    const row = history.find(item => item.id === event.id);
    assert.deepEqual(row.before_data, event.before);
    assert.deepEqual(row.after_data, event.after);
  }
  assert.equal(history.find(row => row.id === correction.plan.historyEvent.id).before_data.sourceBasis, first.plan.record.id);
  const viewStart = f.calls.length, savedBeforeView = JSON.stringify(f.states.get(state.workspace.id));
  for (let repeat = 0; repeat < 3; repeat++) {
    const view = costSourceReviewContext(cold, selector, actor, { now });
    assert.equal(view.history.length, 2);
    publicEconomicsSources(cold.economics); publicCostSourceHistory(cold.costHistory);
  }
  assert.equal(f.calls.length, viewStart, 'Repeated context/DTO reads add no adapter calls or writes');
  assert.equal(JSON.stringify(f.states.get(state.workspace.id)), savedBeforeView);
  assert.throws(() => assertCostSourceCreation(createCostSourceStage({})), { code: 'COST_SOURCE_REVIEW_PAUSED' });
  assert.equal(costSourceReviewContext(cold, selector, actor, { now }).current.record.id, correction.plan.record.id);
  const legacy = await acceptedStoreModule(), legacyStore = legacy.module.createStore(f.env, { fetchImpl: f.fetchImpl });
  const legacyReadStart = f.calls.length, legacyCold = await legacyStore.get(state.workspace.id);
  assert.equal(f.calls.length - legacyReadStart, 1);
  assert.deepEqual(legacyCold.economics[selector.sku].sourceBasis, correction.plan.record);
  assert.deepEqual(legacyCold.costHistory, cold.costHistory);
  const oldDto = acceptedBootstrap(legacyCold, { id: 'synthetic-viewer', role: 'viewer' });
  assert.ok(JSON.stringify(oldDto.payload).includes('SYNTHETIC-CORRECTION-002'));
  assert.equal(f.calls.some(call => call.method === 'DELETE'), false);
  t.diagnostic(JSON.stringify({ actualAdapter: true, actualPostgreSQLJsonb: true, actualPostgrestHttp: false,
    castTargets: f.castTargets, beforeAndAfterStateReads: [baselineReads, 1], repeatedContextCalls: 3,
    repeatContextAdapterWrites: 0, repeatSourceMirrorUpserts: repeatedSourceMirrors.length,
    profileSourceComplete: true, fullSourceHistoryRows: 2, ordinaryHistoryRows: 1,
    oldColdReaderPreservesSource: true, oldColdReaderBootstrapPrivacySafe: false,
    applicationSchemaChanges: 0, grantsChanged: 0, providerCalls: unexpectedNetwork }));
  t.diagnostic(JSON.stringify({ createWire, wire,
    primarySnapshotFirstSourceGrowthBytes: wire[1].primarySnapshotBytes - wire[0].primarySnapshotBytes,
    primarySnapshotCorrectionGrowthBytes: wire[2].primarySnapshotBytes - wire[1].primarySnapshotBytes,
    primaryRequestFirstSourceGrowthBytes: wire[1].primaryRequestBodyBytes - wire[0].primaryRequestBodyBytes,
    primaryRequestCorrectionGrowthBytes: wire[2].primaryRequestBodyBytes - wire[1].primaryRequestBodyBytes,
    wireQualification: 'serialized adapter request bodies; excludes HTTP headers/TLS and API audit rows; growth compares existing-workspace PATCH baseline with first source and correction' }));
});

test('real JSONB retains the full capped correction chain and cap refusal leaves it unchanged', t => {
  let state = sourceState(), count = 0;
  while (count < 100) {
    try { appendReview(state, { identifier: `SYNTHETIC-CAP-${String(count + 1).padStart(3, '0')}` }); count++; }
    catch (error) { assert.equal(error.code, 'COST_SOURCE_HISTORY_FULL'); break; }
  }
  assert.ok(count > 1 && count < 100);
  state = pg.roundtrip(state);
  const before = JSON.stringify(state), context = costSourceReviewContext(state, selector, actor, { now });
  assert.equal(context.history.length, count);
  assert.ok(context.budget.retainedBytes <= COST_SOURCE_HISTORY_MAX_BYTES);
  assert.throws(() => appendReview(state, { identifier: 'SYNTHETIC-CAP-NEXT' }), { code: 'COST_SOURCE_HISTORY_FULL', status: 413 });
  assert.equal(JSON.stringify(state), before);
  assert.deepEqual(pg.roundtrip(state), state);
  t.diagnostic(JSON.stringify({ retainedSourceRecords: count, retainedOrdinaryHistory: 1,
    retainedSourceBytes: context.budget.retainedBytes, remainingSourceBytes: context.budget.remainingBytes,
    totalSerializedStateBytes: bytes(state), rejectedWithoutMutation: true, historyPruned: false }));
});
