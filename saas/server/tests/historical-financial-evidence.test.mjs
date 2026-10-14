import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessOutcomePersistence } from '../lib/business-outcome-store.mjs';
import { prepareExperimentOutcomeMeasurement, digestMeasurementValue } from '../lib/experiment-measurements.mjs';
import { createBusinessOutcomeCandidate, withdrawBusinessOutcomeCandidate } from '../lib/business-outcomes.mjs';
import { protectedReceiptFixture } from './protected-receipt-source-fixture.mjs';
import { createGovernedRecordStage, GOVERNED_RECORD_PRODUCER_CONTRACT } from '../lib/governed-record-stage.mjs';
import { upsertBusinessObjective, OBJECTIVE_EXECUTION_POLICY_SCHEMA } from '../lib/business-objectives.mjs';
import { captureObjectiveDispatchPolicy, assertObjectiveDispatchAllowed } from '../lib/objective-dispatch-policy.mjs';

const WS = 'tenant-a', EXP = 'experiment_financial', NOW = '2026-10-08T15:00:00.000Z';
const REVISION = '22222222-2222-3333-4444-555555555555';
const ACTOR = { id: 'reviewer_owner', sessionVersion: 4 };
const FACTS = ['metric', 'amount', 'currency', 'window', 'coverage', 'method', 'provenance', 'links'];
const clone = value => structuredClone(value);
function fixture({ amount = '10.250001', facts = {}, source = protectedReceiptFixture() } = {}) {
  const measurement = prepareExperimentOutcomeMeasurement({ expectedRevision: 0, amount, currency: 'GBP',
    window: { startsAt: '2026-10-06T00:00:00.000Z', endsAt: '2026-10-07T00:00:00.000Z' },
    coverage: { status: 'complete', observedCount: 2, expectedCount: 2 }, method: { kind: 'reconciled_manual' },
    observedAt: '2026-10-07T12:00:00.000Z', report: { description: 'Synthetic revenue less all variable costs.', costsComplete: true },
    actionSelection: { receipt: source.selector }, ...facts },
  { workspaceId: WS, experimentId: EXP, actorId: ACTOR.id, now: NOW, receiptEvidence: source.evidence });
  const version = createBusinessOutcomeCandidate({ source: { type: 'experiment_measurement', experimentId: EXP,
    measurementRevision: measurement.revision, measurementDigest: measurement.digest },
    ...Object.fromEntries(FACTS.map(key => [key, measurement[key]])),
    verification: { kind: 'owner_attestation', actorId: ACTOR.id, verifiedAt: NOW, measurementDigest: measurement.digest } },
  { workspaceId: WS, now: NOW });
  const row = { workspace_id: WS, outcome_id: version.outcomeId, revision: version.revision, version_id: version.versionId,
    digest: version.digest, status: version.status, payload: version, publication_id: 'financial_publication',
    intent_digest: 'c'.repeat(64), committed_at: NOW, commit_revision: '33333333-2222-3333-4444-555555555555' };
  const response = { schema: 'runvara-outcome-content-source-reader/v1', review: {
    workspaceId: WS, workspaceRevision: REVISION, experiment: { id: EXP, title: 'Synthetic financial evidence', status: 'measured' },
    measurement, current: { workspace_id: WS, outcome_id: version.outcomeId, version_id: version.versionId, version: row },
    actionLinkContract: 'runvara-reviewed-action/v2', actionChoices: [], currentActionAssociation: measurement.intervention },
  receiptChoices: [], nextCursor: null, hasMore: false, selectedEvidence: source.evidence };
  const input = { expectedWorkspaceRevision: REVISION, expectedVersionId: version.versionId,
    expectedVersionDigest: version.digest, receipt: source.selector };
  return { source, measurement, version, row, response, input };
}
function harness(f, request = async () => clone(f.response)) {
  const calls = [];
  const store = createBusinessOutcomePersistence({ request: async (path, options) => {
    calls.push({ path, options }); return request(path, options);
  }, now: () => new Date(NOW) });
  return { calls, store, read: (input = f.input) => store.financialEvidence(WS, EXP, ACTOR, input) };
}

test('one authenticated snapshot produces exact historical financial evidence without spending authority', async () => {
  const f = fixture(), h = harness(f), before = JSON.stringify(f);
  const evidence = await h.read();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, 'rpc/runvara_read_outcome_content_sources');
  assert.equal(h.calls[0].options.maxResponseBytes, 128 * 1024);
  assert.deepEqual(JSON.parse(h.calls[0].options.body), { p_workspace_id: WS, p_experiment_id: EXP,
    p_actor_id: ACTOR.id, p_actor_session_version: 4, p_receipt_selector: f.source.selector,
    p_after_attempt_id: null, p_resolve_saved_source: true });
  assert.equal(evidence.schema, 'runvara-historical-financial-evidence/v1');
  assert.equal(evidence.basis, 'published_owner_attestation');
  assert.equal(evidence.financial.amount, '10.250001');
  assert.equal(evidence.financial.currency, 'GBP');
  assert.equal(evidence.financial.costsComplete, true);
  assert.equal(evidence.workspaceRevision, REVISION);
  assert.equal(evidence.readCompletedAt, NOW);
  assert.equal(evidence.source.publication.digest, f.version.digest);
  assert.equal(evidence.source.measurement.digest, f.measurement.digest);
  assert.equal(evidence.source.measurement.reportDigest, f.measurement.report.digest);
  assert.deepEqual(evidence.source.provenance, f.measurement.provenance);
  assert.deepEqual(evidence.source.receipt, f.measurement.receiptSource);
  assert.deepEqual(evidence.source.operation.action, f.measurement.links.action);
  assert.deepEqual(evidence.source.operation.approval, f.measurement.links.approval);
  assert.equal(evidence.source.operation.productId, f.source.source.input.productId);
  assert.ok(Object.values(evidence.safeguards).every(value => value === false));
  const { digest, ...body } = evidence;
  assert.equal(digest, digestMeasurementValue(body));
  assert.ok(Object.isFrozen(evidence.financial.window));
  assert.throws(() => { evidence.financial.amount = '999'; }, TypeError);
  for (const key of ['admission', 'authorityDigest', 'actorSessionVersion', 'claimIdentity', 'claimId', 'stableApproval', 'proposal', 'requestId', 'description']) {
    assert.equal(JSON.stringify(evidence).includes(`"${key}"`), false, key);
  }
  assert.equal(JSON.stringify(f), before);
});

function replaceVersion(f, version) {
  Object.assign(f.row, { outcome_id: version.outcomeId, revision: version.revision, version_id: version.versionId,
    digest: version.digest, status: version.status, payload: version });
  Object.assign(f.response.review.current, { outcome_id: version.outcomeId, version_id: version.versionId });
  Object.assign(f.input, { expectedVersionId: version.versionId, expectedVersionDigest: version.digest });
}

for (const amount of ['0', '-0.000000', '-12.340000', '999999999999999999.999999', '-999999999999999999.999999']) {
  test(`historical decimal ${amount} is preserved exactly without Number conversion`, async () => {
    const f = fixture({ amount });
    assert.equal((await harness(f).read()).financial.amount, f.measurement.amount);
  });
}

test('caller financial facts, proof DTOs and authority flags are rejected before any source read', async () => {
  const f = fixture(), h = harness(f);
  for (const extra of ['amount', 'currency', 'financialImpact', 'verified', 'executionAuthorized', 'publicationBoundary',
    'source', 'review', 'selectedEvidence', 'actor', 'workspaceId', 'costEntries', 'invoice']) {
    await assert.rejects(h.read({ ...f.input, [extra]: extra === 'review' ? clone(f.response.review) : true }),
      { code: 'FINANCIAL_EVIDENCE_REQUEST_INVALID' }, extra);
  }
  for (const field of Object.keys(f.input)) {
    const input = clone(f.input); delete input[field];
    await assert.rejects(h.read(input), { code: 'FINANCIAL_EVIDENCE_REQUEST_INVALID' });
  }
  let accessed = false;
  const input = clone(f.input);
  Object.defineProperty(input, 'expectedWorkspaceRevision', { enumerable: true, get() { accessed = true; return REVISION; } });
  await assert.rejects(h.read(input), { code: 'FINANCIAL_EVIDENCE_REQUEST_INVALID' });
  assert.equal(accessed, false);
  await assert.rejects(h.read({ ...f.input, receipt: { ...f.input.receipt, verified: true } }));
  for (const identity of [null, { ...ACTOR, verified: true }, { id: ACTOR.id, sessionVersion: 0 }]) {
    await assert.rejects(h.store.financialEvidence(WS, EXP, identity, f.input), { code: 'FINANCIAL_EVIDENCE_REQUEST_INVALID' });
  }
  assert.equal(h.calls.length, 0);
});

test('a stale workspace revision and obsolete publication selectors fail closed', async () => {
  const f = fixture(), h = harness(f);
  for (const [field, value, code] of [
    ['expectedWorkspaceRevision', 'old_revision', 'FINANCIAL_EVIDENCE_WORKSPACE_CHANGED'],
    ['expectedVersionId', 'outcome_version_' + 'a'.repeat(64), 'FINANCIAL_EVIDENCE_PUBLICATION_CHANGED'],
    ['expectedVersionDigest', 'a'.repeat(64), 'FINANCIAL_EVIDENCE_PUBLICATION_CHANGED']
  ]) await assert.rejects(h.read({ ...f.input, [field]: value }), { code });
  assert.equal(h.calls.length, 3);
});

test('a newer unpublished draft does not inherit the current publication attestation', async () => {
  const f = fixture(), changed = fixture({ amount: '900' });
  f.response.review.measurement = changed.measurement;
  await assert.rejects(harness(f).read(), { code: 'FINANCIAL_EVIDENCE_MEASUREMENT_CHANGED' });
});

test('a valid re-digested publication cannot substitute financial facts for its attested measurement', async () => {
  for (const replacement of [{ amount: '999' }, { currency: 'USD' }, { method: { kind: 'unknown', definitionVersion: 'contribution-v1' } }]) {
    const f = fixture();
    // Derive a structurally valid publication with the real measurement digest
    // but different facts; digest integrity alone must not authorize this join.
    const record = { source: f.version.source, ...Object.fromEntries(FACTS.map(key => [key, f.version[key]])),
      verification: f.version.verification, ...replacement };
    if (replacement.method) record.method.definitionVersion = f.version.method.definitionVersion;
    replaceVersion(f, createBusinessOutcomeCandidate(record, { workspaceId: WS, now: NOW }));
    await assert.rejects(harness(f).read(), { code: 'FINANCIAL_EVIDENCE_FACTS_MISMATCH' });
  }
});

test('missing publication or measurement never produces evidence', async () => {
  const f = fixture(); f.response.review.current = null; f.response.review.currentActionAssociation = null;
  await assert.rejects(harness(f).read(), { code: 'FINANCIAL_EVIDENCE_SOURCE_REQUIRED' });
  const missing = fixture(); missing.response.review.measurement = null;
  await assert.rejects(harness(missing).read(), { code: 'FINANCIAL_EVIDENCE_SOURCE_REQUIRED' });
});

test('withdrawn committed outcomes cannot supply historical qualified evidence', async () => {
  const f = fixture();
  replaceVersion(f, withdrawBusinessOutcomeCandidate(f.version, {
    reason: 'evidence_retracted', verification: f.version.verification
  }, { workspaceId: WS, now: NOW }));
  await assert.rejects(harness(f).read(), { code: 'FINANCIAL_EVIDENCE_WITHDRAWN' });
});

for (const [label, facts] of [
  ['unknown amount', { amount: null }], ['unknown currency', { currency: null }], ['unknown window', { window: null }],
  ['partial coverage', { coverage: { status: 'partial', observedCount: 1, expectedCount: 2 } }],
  ['unknown method', { method: { kind: 'unknown' } }], ['unknown observation time', { observedAt: null }],
  ['incomplete costs', { report: { description: 'Incomplete synthetic costs', costsComplete: false } }],
  ['unknown costs', { report: { description: 'Unknown synthetic costs', costsComplete: null } }]
]) test(`${label} cannot be upgraded by a publication record`, async () => {
  await assert.rejects(harness(fixture({ facts })).read(), { code: 'FINANCIAL_EVIDENCE_MEASUREMENT_INCOMPLETE' });
});

test('the publication source contract already rejects observations before the measurement window ends', () => {
  assert.throws(() => fixture({ facts: { observedAt: '2026-10-06T12:00:00.000Z' } }), { code: 'OUTCOME_INVALID' });
});

test('invalid amounts in source rows fail before evidence construction', async () => {
  for (const amount of [NaN, Infinity, -Infinity, 10, '', 'NaN', 'Infinity', '1e3', '01', '0.0000001', '1000000000000000000', ' 10']) {
    const f = fixture(); f.response.review.measurement.amount = amount;
    await assert.rejects(harness(f).read(), { code: 'OUTCOME_REVIEW_INVALID' }, String(amount));
  }
});

test('foreign workspace and experiment sources are rejected by the authenticated adapter', async () => {
  for (const change of [f => { f.response.review.workspaceId = 'tenant-b'; },
    f => { f.response.review.experiment.id = 'experiment_other'; },
    f => { f.response.review.measurement.workspaceId = 'tenant-b'; },
    f => { f.row.workspace_id = 'tenant-b'; },
    f => { f.response.selectedEvidence = protectedReceiptFixture({ workspaceId: 'tenant-b' }).evidence; }]) {
    const f = fixture(); change(f);
    await assert.rejects(harness(f).read(), { code: 'OUTCOME_REVIEW_INVALID' });
  }
});

test('another valid protected operation cannot be joined to the financial measurement', async () => {
  const f = fixture(), other = protectedReceiptFixture({ title: 'A different approved product title' });
  f.input.receipt = other.selector; f.response.selectedEvidence = other.evidence;
  await assert.rejects(harness(f).read(), { code: 'FINANCIAL_EVIDENCE_OPERATION_MISMATCH' });
});

test('receipt tampering, missing protection and commit-revision mismatch never qualify', async () => {
  for (const change of [f => { f.response.selectedEvidence = null; },
    f => { f.response.selectedEvidence.receipt.digest = 'a'.repeat(64); },
    f => { f.response.selectedEvidence.receipt.source.input.description = 'tampered'; },
    f => { f.response.selectedEvidence.admission.actorSessionVersion++; },
    f => { f.input.receipt.sourceDigest = 'a'.repeat(64); },
    f => { f.response.selectedEvidence.commitRevision = '44444444-2222-3333-4444-555555555555'; }]) {
    const f = fixture(); change(f);
    await assert.rejects(harness(f).read(), error => ['OUTCOME_REVIEW_INVALID', 'FINANCIAL_EVIDENCE_OPERATION_MISMATCH'].includes(error.code));
  }
});

test('public review and previous evidence DTOs cannot replace the protected reader response', async () => {
  const f = fixture(), previous = await harness(f).read();
  for (const dto of [f.response.review, previous, { ...f.response.review, selectedEvidence: f.source.evidence }]) {
    const h = harness(f, async () => clone(dto));
    await assert.rejects(h.read(), { code: 'OUTCOME_REVIEW_INVALID' });
    assert.equal(h.calls.length, 1);
  }
});

test('request mutation while awaiting the source cannot alter captured selectors', async () => {
  const f = fixture(), original = clone(f.input), identity = clone(ACTOR);
  let release;
  const h = harness(f, () => new Promise(resolve => { release = resolve; }));
  const pending = h.store.financialEvidence(WS, EXP, identity, f.input);
  f.input.expectedWorkspaceRevision = 'changed'; f.input.expectedVersionDigest = 'a'.repeat(64);
  f.input.receipt.sourceDigest = 'a'.repeat(64); identity.sessionVersion++;
  release(clone(f.response));
  const evidence = await pending;
  assert.equal(evidence.workspaceRevision, original.expectedWorkspaceRevision);
  assert.equal(evidence.source.receipt.sourceDigest, original.receipt.sourceDigest);
  assert.equal(JSON.parse(h.calls[0].options.body).p_actor_session_version, ACTOR.sessionVersion);
});

test('each invocation reads current state and does not cache an earlier qualification', async () => {
  const f = fixture(), h = harness(f);
  await h.read();
  f.response.review.workspaceRevision = 'new_workspace_revision';
  await assert.rejects(h.read(), { code: 'FINANCIAL_EVIDENCE_WORKSPACE_CHANGED' });
  assert.equal(h.calls.length, 2);
});

test('missing protected reader, denial and transport failure have no legacy fallback or writes', async () => {
  for (const databaseCode of ['PGRST202', '42501', 'P0O03', '57014']) {
    const f = fixture(), h = harness(f, async () => { throw Object.assign(new Error('Synthetic private source error'), { databaseCode }); });
    await assert.rejects(h.read(), error => error.message !== 'Synthetic private source error');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].path, 'rpc/runvara_read_outcome_content_sources');
  }
});

test('unprotected associations and protected published-version reuse remain outside this first source contract', async () => {
  for (const reuse of [false, true]) {
    const f = fixture(), m = f.measurement;
    f.response.review.measurement = prepareExperimentOutcomeMeasurement({ expectedRevision: 1, amount: m.amount, currency: m.currency,
      window: m.window, coverage: { status: 'complete', observedCount: 2, expectedCount: 2 }, method: { kind: m.method.kind },
      observedAt: m.provenance.observedAt, report: { description: m.report.description, costsComplete: true },
      actionSelection: reuse ? { reuseVersionId: f.version.versionId } : { actionId: f.source.write.id } },
    { workspaceId: WS, experimentId: EXP, actorId: ACTOR.id, now: NOW, previousMeasurement: m, actionEvidence: f.source.source,
      ...(reuse ? { reuseVersionId: f.version.versionId, reuseSourceMeasurement: m } : {}) });
    await assert.rejects(harness(f).read(), { code: 'FINANCIAL_EVIDENCE_PROTECTED_SOURCE_REQUIRED' });
  }
});

test('produced evidence and its serialized clone cannot satisfy any financial dispatch hold', async () => {
  const evidence = await harness(fixture()).read();
  const stage = createGovernedRecordStage({ GOVERNED_RECORD_PRODUCER_CONTRACT });
  for (const supplied of [evidence, clone(evidence)]) {
    for (const limits of [{ profitFirst: true }, { profitFirst: false, minGrossMarginPercent: 0 },
      { profitFirst: false, maxMonthlyAdBudget: 0, currency: 'GBP' }, { profitFirst: false, minStockCoverDays: 0 }]) {
      const f = protectedReceiptFixture(), { state, write } = f;
      state.users = [{ id: write.requestedBy, role: 'owner' }];
      upsertBusinessObjective(state, { title: 'Synthetic restriction', metric: 'orders', baseline: 1, target: 2, direction: 'increase',
        startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-11-01T00:00:00.000Z', limits,
        executionPolicy: { schema: OBJECTIVE_EXECUTION_POLICY_SCHEMA, mode: 'enforce', scope: {
          provider: 'shopify', operation: 'product_content', connectionId: write.connectionId, account: write.account } } },
      { workspaceId: WS, actorId: write.requestedBy, now: new Date(NOW), governedRecordStage: stage });
      write.financialEvidence = supplied;
      assert.throws(() => assertObjectiveDispatchAllowed(write, captureObjectiveDispatchPolicy(state, write), Date.parse(NOW)),
        { code: 'WRITE_POLICY_EVIDENCE_REQUIRED' });
    }
  }
});
