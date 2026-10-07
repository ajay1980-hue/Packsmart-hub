import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { aggregateBusinessOutcomes, createBusinessOutcomeCandidate, correctBusinessOutcomeCandidate, withdrawBusinessOutcomeCandidate } from '../lib/business-outcomes.mjs';
import { businessOutcomePublicationParams, createBusinessOutcomePersistence, OUTCOME_READ_BYTES, SELECTED_OUTCOME_RELATIONSHIPS_MAX_BYTES } from '../lib/business-outcome-store.mjs';
import { prepareExperimentOutcomeMeasurement } from '../lib/experiment-measurements.mjs';
import { createStore } from '../lib/store.mjs';
import { deriveBusinessGraph } from '../lib/business-graph.mjs';

const NOW = '2026-10-06T20:00:00.000Z', WS = 'tenant-a';
const digest = value => createHash('sha256').update(value).digest('hex');
const actor = { id: 'user_owner', sessionVersion: 3 };
function fixture(index = 1, amount = '10') {
  const measurementDigest = digest(`measurement_${index}`);
  const version = createBusinessOutcomeCandidate({
    source: { type: 'experiment_measurement', experimentId: `experiment_${index}`, measurementRevision: 1, measurementDigest },
    metric: 'incrementalContribution', amount, currency: 'GBP',
    window: { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' },
    coverage: { status: 'complete', scopeId: `scope_${index}`, observedCount: 10, expectedCount: 10 },
    method: { kind: 'reconciled_manual', definitionVersion: 'incremental-contribution/v1' },
    provenance: { observationId: `observation_${index}`, sourceRefs: [{ type: 'measurement_report', id: `report_${index}`, digest: digest(`report_${index}`) }],
      observedAt: '2026-10-06T12:00:00.000Z', aggregation: 'non_overlapping_scopes_attested' },
    verification: { kind: 'owner_attestation', actorId: actor.id, verifiedAt: '2026-10-06T14:00:00.000Z', measurementDigest }
  }, { workspaceId: WS, now: NOW });
  const head = { schema: 'runvara-outcome-head/v1', workspaceId: WS, outcomeId: version.outcomeId, revision: version.revision,
    versionId: version.versionId, digest: version.digest, status: 'published', publicationId: `publication_${index}`,
    committedAt: '2026-10-06T19:00:00.000Z', commitRevision: 'state_committed' };
  const row = { workspace_id: WS, outcome_id: version.outcomeId, revision: version.revision, version_id: version.versionId,
    digest: version.digest, status: version.status, payload: version, publication_id: head.publicationId,
    intent_digest: digest(`intent_${index}`), committed_at: '2026-10-06T19:00:00+00:00', commit_revision: head.commitRevision };
  const input = { publicationId: head.publicationId, action: 'publish', experimentId: version.source.experimentId,
    expectedWorkspaceRevision: 'state_reviewed', expectedMeasurementRevision: 1, expectedMeasurementDigest: measurementDigest,
    expectedHeadVersionId: null, expectedHeadDigest: null, withdrawalReason: null };
  return { version, head, row, input, receipt: { publication: { head, version }, replayed: false, isCurrent: true },
    joined: { workspace_id: WS, outcome_id: version.outcomeId, version_id: version.versionId, version: row } };
}
const adapter = (request, invalidate) => createBusinessOutcomePersistence({ request: async (path, options) => {
  const result = await request(path, options);
  return options.includeResponseMetadata && Array.isArray(result)
    ? { data: result, contentRange: result.length ? `0-${result.length - 1}/${result.length}` : '*/0' } : result;
}, invalidate, now: () => new Date(NOW) });

test('publication DTO takes tenant and actor only from separate authenticated arguments', () => {
  const { input } = fixture(), params = businessOutcomePublicationParams(WS, actor, input);
  assert.equal(params.p_workspace_id, WS); assert.equal(params.p_actor_id, actor.id); assert.equal(params.p_actor_session_version, 3);
  assert.equal(params.p_expected_measurement_digest, input.expectedMeasurementDigest);
  for (const field of ['workspaceId', 'actorId', 'sessionVersion', 'amount', 'verified', 'candidate', 'committedAt', 'head']) {
    assert.throws(() => businessOutcomePublicationParams(WS, actor, { ...input, [field]: 'injected' }), { code: 'OUTCOME_REQUEST_INVALID' });
  }
  for (const patch of [{ action: 'delete' }, { publicationId: '../bad' }, { expectedMeasurementRevision: 0 },
    { expectedMeasurementDigest: 'not-a-digest' }, { expectedWorkspaceRevision: null }, { withdrawalReason: 'duplicate_observation' },
    { expectedHeadVersionId: fixture().version.versionId }, { expectedHeadDigest: digest('x') }, { action: 'correct' }]) {
    assert.throws(() => businessOutcomePublicationParams(WS, actor, { ...input, ...patch }), { code: 'OUTCOME_REQUEST_INVALID' });
  }
  let accessed = false;
  const computed = { ...input }; Object.defineProperty(computed, 'publicationId', { enumerable: true, get() { accessed = true; return 'injected'; } });
  assert.throws(() => businessOutcomePublicationParams(WS, actor, computed)); assert.equal(accessed, false);
});

test('publication uses one bounded RPC and clears stale workspace cache on acknowledged commit', async () => {
  const f = fixture(); let calls = 0, invalidations = 0;
  const result = await adapter(async (path, options) => {
    calls++; assert.equal(path, 'rpc/runvara_publish_business_outcome'); assert.equal(options.method, 'POST');
    assert.equal(options.maxResponseBytes, 128 * 1024);
    assert.deepEqual(JSON.parse(options.body), businessOutcomePublicationParams(WS, actor, f.input));
    return structuredClone(f.receipt);
  }, workspace => { assert.equal(workspace, WS); invalidations++; }).publish(WS, actor, f.input);
  assert.deepEqual(result, f.receipt); assert.equal(calls, 1); assert.equal(invalidations, 1);
});

test('lost acknowledgement does not automatically replay and still invalidates cached state', async () => {
  let calls = 0, invalidations = 0;
  await assert.rejects(adapter(async () => { calls++; throw Object.assign(new Error('secret upstream text'), { code: 'SUPABASE_PERSISTENCE_FAILED' }); }, () => invalidations++)
    .publish(WS, actor, fixture().input), error => error.code === 'OUTCOME_PUBLICATION_UNCERTAIN' && !error.message.includes('secret'));
  assert.equal(calls, 1); assert.equal(invalidations, 1);
});

test('safe database rejection codes remain distinct from an uncertain commit', async () => {
  const mappings = { P0O01: 'OUTCOME_SOURCE_INVALID', P0O02: 'OUTCOME_MEASUREMENT_INCOMPLETE', P0O03: 'OUTCOME_OWNER_SESSION_CHANGED',
    P0O04: 'OUTCOME_WORKSPACE_CONFLICT', P0O05: 'OUTCOME_HEAD_CONFLICT', P0O06: 'OUTCOME_PUBLICATION_CONFLICT',
    P0O07: 'OUTCOME_MEASUREMENT_CONFLICT', P0O08: 'OUTCOME_WITHDRAWN_FINAL', P0O09: 'OUTCOME_SOURCE_NOT_FOUND', P0O10: 'OUTCOME_SIZE_LIMIT',
    '42P01': 'OUTCOME_STORAGE_UNAVAILABLE', PGRST202: 'OUTCOME_STORAGE_UNAVAILABLE' };
  for (const [databaseCode, code] of Object.entries(mappings)) {
    await assert.rejects(adapter(async () => { throw Object.assign(new Error('private SQL detail'), { databaseCode }); })
      .publish(WS, actor, fixture().input), { code });
  }
});

test('malformed or mismatched success is uncertain, never permission to publish again', async () => {
  const f = fixture();
  for (const mutate of [r => { r.publication.head.publicationId = 'wrong'; }, r => { r.publication.head.workspaceId = 'tenant-b'; },
    r => { r.publication.version.amount = '1000'; }, r => { r.isCurrent = false; }, r => { r.replayed = 'true'; },
    r => { r.publication.head.versionId = 'wrong'; }, r => { r.extra = 'unrecognized'; }]) {
    const receipt = structuredClone(f.receipt); mutate(receipt); let calls = 0;
    await assert.rejects(adapter(async () => { calls++; return receipt; }).publish(WS, actor, f.input), { code: 'OUTCOME_PUBLICATION_UNCERTAIN' });
    assert.equal(calls, 1);
  }
  const replay = { ...structuredClone(f.receipt), replayed: true, isCurrent: false };
  assert.deepEqual(await adapter(async () => replay).publish(WS, actor, f.input), replay);
});

test('withdrawal receipt binds the exact prior version and retains its measurement identity', async () => {
  const f = fixture();
  const version = withdrawBusinessOutcomeCandidate(f.version, { reason: 'incorrect_measurement', verification: {
    ...f.version.verification, verifiedAt: '2026-10-06T19:00:00.000Z' } }, { workspaceId: WS, now: NOW });
  const input = { ...f.input, publicationId: 'withdrawal_one', action: 'withdraw', expectedHeadVersionId: f.version.versionId,
    expectedHeadDigest: f.version.digest, withdrawalReason: 'incorrect_measurement' };
  const head = { ...f.head, publicationId: input.publicationId, versionId: version.versionId, revision: 2, digest: version.digest, status: 'withdrawn' };
  const receipt = { publication: { head, version }, replayed: false, isCurrent: true };
  assert.deepEqual(await adapter(async () => receipt).publish(WS, actor, input), receipt);
});

test('current outcomes use one tenant-scoped joined snapshot, never generic history or separate head/version reads', async () => {
  const f = fixture(1, '999999999999999999.999999'); let calls = 0;
  const result = await adapter(async (path, options) => {
    calls++; assert.ok(path.startsWith('runvara_business_outcome_heads?workspace_id=eq.tenant-a&'));
    assert.ok(path.includes('version:runvara_business_outcome_versions!runvara_outcome_head_version_fk('));
    assert.ok(path.endsWith('&order=outcome_id.asc&limit=51')); assert.ok(!path.includes('source_measurement'));
    assert.equal(options.maxResponseBytes, OUTCOME_READ_BYTES); assert.equal(options.headers.Prefer, 'count=exact');
    assert.equal(options.includeResponseMetadata, true); return [structuredClone(f.joined)];
  }).current(WS);
  assert.equal(calls, 1); assert.equal(result.summary.groups[0].amount, '999999999999999999.999999');
  assert.equal(result.summary.coverage.complete, true); assert.equal(result.summary.roi, null);
  assert.equal(result.summary.overallAmount, null); assert.equal(result.versions.length, 1);
  assert.throws(() => { result.publications[0].head.digest = digest('forged'); }, TypeError);
  assert.throws(() => { result.versions[0].amount = '999'; }, TypeError);
  assert.equal(result.publications[0].version.amount, '999999999999999999.999999');
});

test('server row caps or missing exact count cannot silently turn partial data into a complete total', async () => {
  const data = [fixture().joined];
  const limited = await adapter(async () => ({ data, contentRange: '0-0/20' })).current(WS);
  assert.equal(limited.summary.coverage.complete, false); assert.equal(limited.summary.coverage.totalCurrentHeads, 20);
  assert.equal(limited.summary.groups[0].amount, null);
  for (const contentRange of [null, '0-0/*', '1-1/1', '0-3/1', '0-0/0', '0-0/9007199254740992']) {
    await assert.rejects(adapter(async () => ({ data, contentRange })).current(WS), { code: 'OUTCOME_COVERAGE_UNAVAILABLE' });
  }
});

test('overflow sentinel withholds monetary totals and marks coverage incomplete', async () => {
  const rows = Array.from({ length: 51 }, (_, index) => fixture(index + 1).joined);
  const { summary } = await adapter(async () => rows).current(WS);
  assert.equal(summary.coverage.overflow, true); assert.equal(summary.coverage.complete, false);
  assert.equal(summary.counts.suppliedVersions, 50); assert.equal(summary.groups.length, 1);
  assert.equal(summary.groups[0].amount, null); assert.equal(summary.groups[0].learningComparable, false);
});

test('foreign, missing, duplicate or inconsistent joined rows fail closed', async () => {
  const f = fixture();
  const malformed = [null, {}, [{ ...f.joined, workspace_id: 'tenant-b' }], [f.joined, f.joined],
    [{ ...f.joined, version: null }], [{ ...f.joined, version: [f.row] }], [{ ...f.joined, version_id: fixture(2).version.versionId }],
    [{ ...f.joined, version: { ...f.row, workspace_id: 'tenant-b' } }],
    [{ ...f.joined, version: { ...f.row, digest: digest('wrong') } }]];
  for (const rows of malformed) await assert.rejects(adapter(async () => rows).current(WS), { code: 'OUTCOME_PUBLICATION_INVALID' });
  const rows = Array.from({ length: 51 }, (_, i) => fixture(i + 1).joined); rows[50].workspace_id = 'tenant-b';
  await assert.rejects(adapter(async () => rows).current(WS), { code: 'OUTCOME_PUBLICATION_INVALID' });
});

test('oversize, unavailable and empty current reads are distinct', async () => {
  await assert.rejects(adapter(async () => [{ ...fixture().joined, extra: 'x'.repeat(OUTCOME_READ_BYTES) }]).current(WS), { code: 'OUTCOME_RESPONSE_TOO_LARGE' });
  await assert.rejects(adapter(async () => { throw Object.assign(new Error('missing'), { databaseCode: '42P01' }); }).current(WS), { code: 'OUTCOME_STORAGE_UNAVAILABLE' });
  await assert.rejects(adapter(async () => { throw new Error('offline'); }).current(WS), { code: 'OUTCOME_READ_UNAVAILABLE' });
  const result = await adapter(async () => []).current(WS);
  assert.equal(result.summary.coverage.complete, true); assert.deepEqual(result.summary.groups, []);
  assert.equal(result.summary.overallAmount, null);
});

test('historical evidence reads require exact tenant/version and never imply current-head authority', async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(adapter(async (path, options) => {
    calls++; assert.ok(path.includes(`workspace_id=eq.${WS}&version_id=eq.${f.version.versionId}&`));
    assert.ok(path.endsWith(',source_measurement,source_action&limit=2')); assert.equal(options.maxResponseBytes, 128 * 1024); return [];
  }).evidence(WS, f.version.versionId), { code: 'OUTCOME_VERSION_NOT_FOUND' });
  assert.equal(calls, 1);
  await assert.rejects(adapter(async () => assert.fail('Invalid ID cannot query')).evidence(WS, '../foreign'), { code: 'OUTCOME_REQUEST_INVALID' });
  await assert.rejects(adapter(async () => [f.row, f.row]).evidence(WS, f.version.versionId), { code: 'OUTCOME_PUBLICATION_INVALID' });
  await assert.rejects(adapter(async () => [{ ...f.row, source_measurement: {} }]).evidence(WS, f.version.versionId), { code: 'OUTCOME_SOURCE_INVALID' });
});

test('explicit historical evidence retains and validates the original typed report', async () => {
  const f = fixture();
  const source = prepareExperimentOutcomeMeasurement({ expectedRevision: 0, amount: '10', currency: 'GBP',
    window: f.version.window, coverage: { status: 'complete', observedCount: 10, expectedCount: 10 },
    method: { kind: 'reconciled_manual' }, observedAt: '2026-10-06T12:00:00.000Z',
    report: { description: 'Owner-reconciled contribution after all variable costs.', costsComplete: true }
  }, { workspaceId: WS, experimentId: 'experiment_1', actorId: actor.id, now: '2026-10-06T13:00:00.000Z', previousMeasurement: null });
  const version = createBusinessOutcomeCandidate({
    source: { type: 'experiment_measurement', experimentId: source.experimentId, measurementRevision: source.revision, measurementDigest: source.digest },
    ...Object.fromEntries(['metric', 'amount', 'currency', 'window', 'coverage', 'method', 'provenance', 'links'].map(key => [key, source[key]])),
    verification: { kind: 'owner_attestation', actorId: actor.id, verifiedAt: '2026-10-06T14:00:00.000Z', measurementDigest: source.digest }
  }, { workspaceId: WS, now: NOW });
  const row = { ...f.row, outcome_id: version.outcomeId, version_id: version.versionId, digest: version.digest,
    payload: version, source_measurement: source };
  const result = await adapter(async () => [row]).evidence(WS, version.versionId);
  assert.deepEqual(result.sourceMeasurement, source); assert.equal(result.currentStatus, 'not_checked');
  assert.equal(result.source, 'immutable_business_outcome_version');
  const changed = structuredClone(row); changed.source_measurement.report.description = 'Changed after publication';
  await assert.rejects(adapter(async () => [changed]).evidence(WS, version.versionId), { code: 'OUTCOME_SOURCE_INVALID' });
});

test('Supabase transport exposes only explicitly requested cardinality metadata', async () => {
  let calls = 0;
  const store = createStore({ NODE_ENV: 'test', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only-key' }, { fetchImpl: async (_url, options) => {
    calls++; assert.equal(Object.hasOwn(options, 'includeResponseMetadata'), false);
    assert.equal(options.headers.Prefer, 'count=exact');
    return new Response('[]', { status: 200, headers: { 'content-range': '*/0', 'x-private-test-header': 'must-not-return' } });
  } });
  const result = await store.request('runvara_business_outcome_heads?select=outcome_id', {
    headers: { Prefer: 'count=exact' }, maxResponseBytes: 128, includeResponseMetadata: true
  });
  assert.deepEqual(result, { data: [], contentRange: '*/0' }); assert.equal(calls, 1);
});

test('review loads one compact source/current snapshot without full workspace reads', async () => {
  const f = fixture(); let calls = 0;
  const result = await adapter(async (path, options) => {
    calls++; assert.equal(path, 'rpc/runvara_read_business_outcome_review'); assert.equal(options.method, 'POST');
    assert.equal(options.maxResponseBytes, 128 * 1024);
    assert.deepEqual(JSON.parse(options.body), { p_workspace_id: WS, p_experiment_id: 'experiment_1' });
    return { workspaceId: WS, workspaceRevision: 'state_reviewed', experiment: { id: 'experiment_1', title: 'Recorded experiment', status: 'completed' },
      measurement: null, current: f.joined };
  }).review(WS, 'experiment_1');
  assert.equal(calls, 1); assert.equal(result.measurement, null); assert.equal(result.assessment, null);
  assert.deepEqual(result.currentPublication.version, f.version); assert.equal(result.workspaceRevision, 'state_reviewed');
  assert.equal(Object.hasOwn(result, 'users'), false);
});

test('review refuses foreign identities, copied current records and malformed source envelopes', async () => {
  const f = fixture(), base = { workspaceId: WS, workspaceRevision: 'state_reviewed', experiment: { id: 'experiment_1', title: 'A', status: 'draft' }, measurement: null, current: null };
  for (const mutate of [v => { v.workspaceId = 'tenant-b'; }, v => { v.experiment.id = 'experiment_2'; },
    v => { v.workspaceRevision = null; }, v => { v.measurement = {}; }, v => { v.current = fixture(2).joined; },
    v => { v.current = { ...f.joined, workspace_id: 'tenant-b' }; }, v => { v.experiment.title = 'x'.repeat(181); }, v => { v.users = []; }]) {
    const value = structuredClone(base); mutate(value);
    await assert.rejects(adapter(async () => value).review(WS, 'experiment_1'), { code: 'OUTCOME_REVIEW_INVALID' });
  }
  await assert.rejects(adapter(async () => { throw Object.assign(new Error('missing private source'), { databaseCode: 'P0O09' }); })
    .review(WS, 'experiment_1'), { code: 'OUTCOME_SOURCE_NOT_FOUND' });
});

function reviewResult(current = fixture().joined, measurement = null) {
  return { workspaceId: WS, workspaceRevision: 'state_reviewed', experiment: { id: 'experiment_1', title: 'PRIVATE_EXPERIMENT_TITLE', status: 'completed' }, measurement, current };
}
function joinedVersion(version) {
  const f = fixture();
  return { workspace_id: WS, outcome_id: version.outcomeId, version_id: version.versionId, version: {
    ...f.row, outcome_id: version.outcomeId, revision: version.revision, version_id: version.versionId, digest: version.digest,
    status: version.status, payload: version, committed_at: NOW
  } };
}
function measurementInput(amount, expectedRevision = 0) {
  return { expectedRevision, amount, currency: 'GBP', window: fixture().version.window,
    coverage: { status: 'complete', observedCount: 10, expectedCount: 10 }, method: { kind: 'reconciled_manual' },
    observedAt: '2026-10-06T12:00:00.000Z', report: { description: 'PRIVATE_MEASUREMENT_REPORT', costsComplete: true } };
}
function candidateInput(measurement) {
  return { source: { type: 'experiment_measurement', experimentId: measurement.experimentId,
    measurementRevision: measurement.revision, measurementDigest: measurement.digest },
    ...Object.fromEntries(['metric', 'amount', 'currency', 'window', 'coverage', 'method', 'provenance', 'links'].map(key => [key, measurement[key]])),
    verification: { kind: 'owner_attestation', actorId: actor.id, verifiedAt: NOW, measurementDigest: measurement.digest } };
}

test('selected relationship proof is private, bounded and adds no lookup or transferable publication authority', async () => {
  const f = fixture(1, '987654321.123456'), response = reviewResult(f.joined); let calls = 0;
  const service = adapter(async (path, options) => {
    calls++; assert.equal(path, 'rpc/runvara_read_business_outcome_review');
    assert.equal(options.maxResponseBytes, 131072);
    assert.deepEqual(JSON.parse(options.body), { p_workspace_id: WS, p_experiment_id: 'experiment_1' });
    return structuredClone(response);
  });
  const result = await service.review(WS, 'experiment_1'), p = result.relationships;
  assert.equal(calls, 1); assert.equal(p.scope, 'selected_experiment_only');
  assert.equal(p.publication.state, 'published'); assert.equal(p.publication.qualification, 'owner_attested_measurement');
  assert.equal(p.publication.versionDigest, f.version.digest); assert.equal(p.publication.draftRelationship, 'no_draft');
  assert.equal(p.nodes.length, 2); assert.equal(p.edges.length, 1);
  assert.equal(p.edges[0].from, p.nodes[1].id); assert.equal(p.edges[0].to, p.nodes[0].id);
  assert.ok(p.nodes.every(node => node.canonicalGraphRef.status === 'unresolved'));
  assert.deepEqual(p.coverage, { selectedExperimentConfirmed: true, currentHeadChecked: true, wholeGraphSynchronized: false, otherOutcomesChecked: false, crossOutcomeComparabilityChecked: false });
  assert.ok(Object.values(p.safeguards).every(value => value === false));
  const json = JSON.stringify(p);
  for (const privateValue of [WS, 'experiment_1', 'PRIVATE_EXPERIMENT_TITLE', actor.id, '987654321.123456', f.version.versionId, f.version.outcomeId, 'state_reviewed']) assert.equal(json.includes(JSON.stringify(privateValue)), false, privateValue);
  assert.equal(Object.hasOwn(p, 'publicationBoundary'), false);
  assert.throws(() => aggregateBusinessOutcomes([f.version], { workspaceId: WS, now: NOW, publicationBoundary: p }), { code: 'PUBLICATION_PROOF_REQUIRED' });
  assert.throws(() => { p.nodes[0].canonicalGraphRef.status = 'resolved'; }, TypeError);
  const { relationships, ...without } = result;
  assert.ok(Buffer.byteLength(JSON.stringify({ relationships })) <= SELECTED_OUTCOME_RELATIONSHIPS_MAX_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) - Buffer.byteLength(JSON.stringify(without)) <= 4096);
  assert.equal(p.snapshot.readCompletedAt, NOW);
  const again = await service.review(WS, 'experiment_1');
  assert.deepEqual(again.relationships.nodes, p.nodes); assert.deepEqual(again.relationships.edges, p.edges);
  assert.notEqual(again.relationships.snapshot.id, p.snapshot.id, 'a later explicit read has its own snapshot identity');
});

test('no selected head is distinct from global absence and incomplete publication remains unqualified', async () => {
  for (const current of [null, fixture(1, null).joined]) {
    const result = await adapter(async () => reviewResult(current)).review(WS, 'experiment_1'), p = result.relationships;
    assert.equal(p.publication.state, current ? 'published' : 'none');
    assert.equal(p.publication.qualification, current ? 'unqualified' : 'none');
    assert.equal(p.nodes.length, current ? 2 : 1); assert.equal(p.edges.length, current ? 1 : 0);
    assert.equal(p.coverage.otherOutcomesChecked, false); assert.equal(p.coverage.wholeGraphSynchronized, false);
    assert.equal(Object.hasOwn(p, 'totalOutcomes'), false);
  }
});

test('new drafts, corrections and withdrawal preserve the exact selected publication source', async () => {
  const first = prepareExperimentOutcomeMeasurement(measurementInput('10'), { workspaceId: WS, experimentId: 'experiment_1', actorId: actor.id, now: NOW, previousMeasurement: null });
  const v1 = createBusinessOutcomeCandidate(candidateInput(first), { workspaceId: WS, now: NOW });
  const second = prepareExperimentOutcomeMeasurement(measurementInput('-1', 1), { workspaceId: WS, experimentId: 'experiment_1', actorId: actor.id, now: NOW, previousMeasurement: first });
  let current = joinedVersion(v1), measurement = first;
  const service = adapter(async () => reviewResult(current, measurement));
  const matched = (await service.review(WS, 'experiment_1')).relationships;
  assert.equal(matched.publication.draftRelationship, 'matches_publication');
  measurement = second;
  const draft = (await service.review(WS, 'experiment_1')).relationships;
  assert.equal(draft.publication.draftRelationship, 'different_from_publication');
  assert.equal(draft.publication.versionDigest, v1.digest); assert.equal(draft.publication.draftDigest, second.digest);
  assert.deepEqual(draft.nodes, matched.nodes, 'an unpublished draft cannot replace the current publication reference');
  const v2 = correctBusinessOutcomeCandidate(v1, candidateInput(second), { workspaceId: WS, now: NOW });
  current = joinedVersion(v2);
  const corrected = (await service.review(WS, 'experiment_1')).relationships;
  assert.equal(corrected.publication.draftRelationship, 'matches_publication');
  assert.equal(corrected.nodes[1].id, matched.nodes[1].id, 'logical selected outcome remains the same');
  assert.notEqual(corrected.nodes[1].sourceVersionRef, matched.nodes[1].sourceVersionRef);
  const v3 = withdrawBusinessOutcomeCandidate(v2, { reason: 'incorrect_measurement', verification: candidateInput(second).verification }, { workspaceId: WS, now: NOW });
  current = joinedVersion(v3);
  const withdrawn = (await service.review(WS, 'experiment_1')).relationships;
  assert.equal(withdrawn.publication.state, 'withdrawn'); assert.equal(withdrawn.publication.qualification, 'withdrawn');
  assert.equal(withdrawn.nodes[1].type, 'withdrawn_measurement_reference');
  assert.equal(withdrawn.edges.length, 1, 'withdrawal retains the real source relationship, not qualification');
  assert.equal(withdrawn.publication.draftDigest, second.digest);
  assert.equal(matched.publication.versionDigest, v1.digest, 'earlier response stays its own immutable historical snapshot');
});

test('selected references never guess canonical graph positions or alias-dependent duplicate ordinals', async () => {
  const state = { workspace: { id: WS }, revenueEngine: { experiments: [
    { externalId: 'experiment_1', status: 'completed' }, { id: 'experiment_1', status: 'completed' }
  ] } };
  const graph = deriveBusinessGraph(state), experiments = graph.nodes.filter(row => row.type === 'experiment');
  assert.equal(experiments.length, 2);
  const p = (await adapter(async () => reviewResult()).review(WS, 'experiment_1')).relationships;
  assert.ok(!experiments.some(row => row.id === p.nodes[0].id));
  assert.equal(p.nodes[0].canonicalGraphRef.status, 'unresolved');
  assert.equal(JSON.stringify(p).includes('/revenueEngine/experiments/'), false);
  assert.ok(p.edges.every(edge => p.nodes.some(row => row.id === edge.from) && p.nodes.some(row => row.id === edge.to)));
});

test('copied relationship JSON and source failures cannot mint a selected review context', async () => {
  const good = await adapter(async () => reviewResult()).review(WS, 'experiment_1');
  await assert.rejects(adapter(async () => ({ ...reviewResult(), relationships: structuredClone(good.relationships) })).review(WS, 'experiment_1'), { code: 'OUTCOME_REVIEW_INVALID' });
  await assert.rejects(adapter(async () => structuredClone(good)).review(WS, 'experiment_1'), { code: 'OUTCOME_REVIEW_INVALID' });
  for (const cause of [Object.assign(new Error('missing or duplicate source'), { databaseCode: 'P0O09' }), new Error('unavailable')]) {
    let calls = 0;
    await assert.rejects(adapter(async () => { calls++; throw cause; }).review(WS, 'experiment_1'));
    assert.equal(calls, 1, 'no retry, fallback graph read or alternate current-head read');
  }
});

test('strict shared transport preserves outcome cardinality and withholds read success for undecodable evidence', async () => {
  const joined=fixture().joined;
  let contentRange='0-0/1',invalid=false,calls=0;
  const store=createStore({NODE_ENV:'test',SUPABASE_URL:'https://outcome-fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-only'}, {
    fetchImpl:async(_url,options)=>{
      calls++;assert.equal(Object.hasOwn(options,'includeResponseMetadata'),false);assert.equal(options.headers.Prefer,'count=exact');
      assert.equal(options.method,undefined,'outcome inspection remains read-only');
      return new Response(invalid?'private invalid outcome evidence':JSON.stringify([joined]),{headers:{'content-range':contentRange}});
    }
  });
  const complete=await store.businessOutcomeSummary(WS);
  assert.equal(complete.summary.coverage.complete,true);assert.equal(complete.summary.groups[0].amount,'10');
  contentRange='0-0/2';
  const partial=await store.businessOutcomeSummary(WS);
  assert.equal(partial.summary.coverage.complete,false);assert.equal(partial.summary.coverage.totalCurrentHeads,2);
  assert.equal(partial.summary.groups[0].amount,null);
  store.telemetry.lastSuccessfulReadAt='2026-01-01T00:00:00.000Z';invalid=true;
  await assert.rejects(store.businessOutcomeSummary(WS),{code:'OUTCOME_READ_UNAVAILABLE'});
  assert.equal(store.telemetry.lastSuccessfulReadAt,'2026-01-01T00:00:00.000Z');
  assert.equal(store.telemetry.lastFailureCode,'SUPABASE_RESPONSE_INVALID');
  assert.equal(calls,3);assert.doesNotMatch(JSON.stringify(store.diagnostics()),/private invalid outcome evidence/);
  assert.equal(store.activitySnapshot(WS).db.attempted,null,'tenant filters do not create trusted activity attribution');
  const observed=store.activityMeter.instanceSnapshot().unattributed;
  assert.equal(observed.db.attempted,3);assert.equal(observed.db.succeeded,2);assert.equal(observed.db.outcomes.invalid_response,1);
});

test('metered outcome RPC preserves safe rejection codes and never repeats an uncertain mutation', async () => {
  for (const [databaseCode, expected] of [['P0O03', 'OUTCOME_OWNER_SESSION_CHANGED'], ['P0O05', 'OUTCOME_HEAD_CONFLICT'], ['42P01', 'OUTCOME_STORAGE_UNAVAILABLE'], [null, 'OUTCOME_PUBLICATION_UNCERTAIN']]) {
    let calls = 0;
    const store = createStore({ NODE_ENV: 'test', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only-key' }, {
      fetchImpl: async (_url, options) => {
        calls++;
        assert.equal(options.method, 'POST');
        if (databaseCode === null) return new Response('private truncated acknowledgement');
        return Response.json({ code: databaseCode, message: 'private SQL and measurement text' }, { status: 400 });
      }
    });
    await assert.rejects(store.publishBusinessOutcome(WS, actor, fixture().input), error => error.code === expected && !error.message.includes('private'));
    assert.equal(calls, 1);
    assert.equal(store.telemetry.lastSuccessfulWriteAt, null);
    assert.equal(store.activitySnapshot(WS).db.attempted, null, 'RPC payload does not assign tenant activity');
    const internal = store.activityMeter.instanceSnapshot().unattributed;
    assert.equal(internal.db.attempted, 1);
    assert.equal(internal.db.failed, 1);
    assert.equal(internal.db.outcomes[databaseCode === null ? 'invalid_response' : 'http_error'], 1);
    assert.equal(Object.values(internal.db.retries).reduce((sum, value) => sum + value, 0), 0);
  }
});

test('old-schema evidence fallback is one bounded read and only permits unlinked v1 data', async () => {
  const f=fixture(); let calls=0;
  await assert.rejects(adapter(async (path,options)=>{
    calls++; assert.equal(options.maxResponseBytes,128*1024);
    if(calls===1) { assert.ok(path.includes('source_action')); throw Object.assign(new Error('column missing'),{databaseCode:'42703'}); }
    assert.equal(path.includes('source_action'),false); return [];
  }).evidence(WS,f.version.versionId),{code:'OUTCOME_VERSION_NOT_FOUND'});
  assert.equal(calls,2);
  calls=0;
  await assert.rejects(adapter(async()=>{calls++; throw Object.assign(new Error('generic missing data'),{databaseCode:'42P01'});}).evidence(WS,f.version.versionId),{code:'OUTCOME_STORAGE_UNAVAILABLE'});
  assert.equal(calls,1);
});

test('review compact action choices require exact contract, bounded fields, tenant-scoped source and unique identities', async () => {
  const base={...reviewResult(null,null),actionLinkContract:'runvara-reviewed-action/v1',actionChoices:[{id:'write_one',account:'synthetic.myshopify.com',productId:'gid://shopify/Product/71',title:'Synthetic action',completedAt:'2026-10-05T00:00:00.000Z',digest:'a'.repeat(64)}],currentActionAssociation:null};
  const result=await adapter(async()=>base).review(WS,'experiment_1'); assert.equal(result.actionChoices.length,1);
  for(const change of [v=>v.actionLinkContract='forged',v=>v.actionChoices.push({...v.actionChoices[0]}),v=>v.actionChoices[0].description='body injection',
    v=>v.actionChoices[0].account='evil.test',v=>v.actionChoices[0].title='x'.repeat(201),v=>v.actionChoices[0].completedAt='2026-02-30T00:00:00.000Z',
    v=>v.currentActionAssociation={},v=>delete v.actionLinkContract,v=>delete v.currentActionAssociation]) {
    const value=structuredClone(base); change(value); await assert.rejects(adapter(async()=>value).review(WS,'experiment_1'),{code:'OUTCOME_REVIEW_INVALID'});
  }
});
