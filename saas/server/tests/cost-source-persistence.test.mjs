import assert from 'node:assert/strict';
import test from 'node:test';
import { COST_SOURCE_COMPONENTS, COST_SOURCE_REVIEW_MAX_BYTES, COST_SOURCE_HISTORY_MAX_BYTES,
  costSourceReviewContext, prepareCostSourceReview, publicEconomicsSources, publicCostSourceHistory } from '../lib/cost-source-review.mjs';
import { createCostSourceStage, costSourceCreationEnabled, assertCostSourceCreation,
  COST_SOURCE_REVIEW_CONTRACT } from '../lib/cost-source-stage.mjs';
import { sourceState, sourceBasis, appendReview, reviewInput, acceptedStoreModule, acceptedBootstrap,
  COST_SOURCE_SELECTOR as selector, COST_SOURCE_ACTOR as actor, COST_SOURCE_TIME as now, ACCEPTED_TREE, bytes } from './cost-source-persistence-fixture.mjs';

test('accepted pre-feature reader preserves full private metadata but its bootstrap exposes it to a viewer', async t => {
  const state = sourceState(), first = appendReview(state);
  appendReview(state, { identifier: 'SYNTHETIC-CORRECTION-002' });
  const legacy = await acceptedStoreModule();
  const restored = legacy.module.upgradeState(structuredClone(state), {});
  assert.deepEqual(restored.economics, state.economics);
  assert.deepEqual(restored.costHistory, state.costHistory);
  const viewer = { id: 'synthetic-viewer', role: 'viewer' };
  const exposed = acceptedBootstrap(restored, viewer);
  assert.deepEqual(exposed.payload.economics[selector.sku].sourceBasis, state.economics[selector.sku].sourceBasis);
  assert.ok(JSON.stringify(exposed.payload).includes(first.plan.record.basis.sources[0].identifier));
  assert.equal(exposed.payload.costHistory.length, 3);
  const safe = { economics: publicEconomicsSources(restored.economics), costHistory: publicCostSourceHistory(restored.costHistory) };
  assert.equal(JSON.stringify(safe).includes('sourceBasis'), false);
  assert.equal(safe.costHistory.length, 1);
  t.diagnostic(JSON.stringify({ acceptedTree: ACCEPTED_TREE, storeSourceSha256: legacy.sourceSha256,
    bootstrapSourceSha256: exposed.bootstrapSha256, exactLegacyDtoExecuted: true,
    oldReaderPreservesUnknownMetadata: true, oldBootstrapExposesPrivateSources: true,
    preFeatureBinaryRollback: 'PRIVACY_UNSAFE_AFTER_FIRST_SOURCE_RECORD', oldServerOrWorkersStarted: false,
    qualification: 'exact source module and isolated bootstrap DTO; not HTTP/authentication coverage' }));
});

test('same binary producer close retains readable metadata and rejects only a new creation', () => {
  const state = sourceState();
  const open = createCostSourceStage({ COST_SOURCE_REVIEW_CONTRACT });
  assert.equal(costSourceCreationEnabled(open), true);
  assertCostSourceCreation(open);
  const first = appendReview(state), original = JSON.stringify(state);
  const closed = createCostSourceStage({});
  assert.equal(costSourceCreationEnabled(closed), false);
  assert.throws(() => assertCostSourceCreation(closed), { code: 'COST_SOURCE_REVIEW_PAUSED' });
  assert.equal(costSourceReviewContext(state, selector, actor, { now }).current.record.id, first.plan.record.id);
  const replay = prepareCostSourceReview(state, first.input, actor, { now });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.historyEvent, null);
  assert.equal(JSON.stringify(state), original);
});

test('first review and corrections have measured bounded growth and retain every full source event', t => {
  const state = sourceState(), baseBytes = bytes(state), first = appendReview(state);
  const firstBytes = bytes(state);
  const second = appendReview(state, { identifier: 'SYNTHETIC-CORRECTION-002' }), correctedBytes = bytes(state);
  assert.deepEqual(state.costHistory[0].before, { sourceBasis: first.plan.record.id });
  assert.deepEqual(state.costHistory[0].after, { sourceBasis: second.plan.record });
  assert.deepEqual(state.costHistory[1].after, { sourceBasis: first.plan.record });
  assert.equal(state.costHistory[1].before.sourceBasis, null);
  let accepted = 2, rejected = null;
  while (accepted < 100) {
    const previous = JSON.stringify(state);
    try { appendReview(state, { identifier: `SYNTHETIC-CORRECTION-${String(accepted + 1).padStart(3, '0')}` }); accepted++; }
    catch (error) {
      assert.equal(error.code, 'COST_SOURCE_HISTORY_FULL'); assert.equal(error.status, 413);
      assert.equal(JSON.stringify(state), previous, 'Refusal cannot mutate or prune the existing source history');
      rejected = error.code; break;
    }
  }
  assert.equal(rejected, 'COST_SOURCE_HISTORY_FULL');
  const context = costSourceReviewContext(state, selector, actor, { now });
  assert.equal(context.history.length, accepted);
  assert.equal(state.costHistory.length, accepted + 1);
  assert.ok(context.budget.retainedBytes <= COST_SOURCE_HISTORY_MAX_BYTES);
  for (const record of context.history) assert.ok(bytes(record) <= COST_SOURCE_REVIEW_MAX_BYTES);
  assert.deepEqual(state.costHistory.at(-2).after.sourceBasis, first.plan.record);
  t.diagnostic(JSON.stringify({ baseStateBytes: baseBytes, firstStateBytes: firstBytes,
    firstReviewGrowthBytes: firstBytes - baseBytes, correctedStateBytes: correctedBytes,
    correctionGrowthBytes: correctedBytes - firstBytes, firstReviewBytes: bytes(first.plan.record),
    firstEventBytes: bytes(first.plan.historyEvent), correctedEventBytes: bytes(second.plan.historyEvent),
    retainedReviewsAtCap: accepted, retainedSourceBytes: context.budget.retainedBytes,
    remainingSourceBytes: context.budget.remainingBytes, refusedCode: rejected, prunedEvents: 0 }));
});

test('the independent 2 KiB review cap rejects an oversized complete-source annotation without mutation', () => {
  const state = sourceState();
  for (const component of COST_SOURCE_COMPONENTS) state.economics[selector.sku][component] = 1;
  const basis = sourceBasis();
  basis.sources = COST_SOURCE_COMPONENTS.map(component => ({ component, kind: 'invoice', identifier: 'S'.repeat(80), issuedOn: null }));
  const input = reviewInput(state, { basis }), before = JSON.stringify(state);
  assert.throws(() => prepareCostSourceReview(state, input, actor, { now }), { code: 'COST_SOURCE_REVIEW_TOO_LARGE', status: 413 });
  assert.equal(JSON.stringify(state), before);
});
