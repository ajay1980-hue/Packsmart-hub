import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareExperimentOutcomeMeasurement, validateExperimentOutcomeMeasurement, assessExperimentOutcomeMeasurement,
  canonicalMeasurementJson, digestMeasurementValue, EXPERIMENT_MEASUREMENT_MAX_BYTES
} from '../lib/experiment-measurements.mjs';
import { createBusinessOutcomeCandidate, createOutcomePublicationBoundary, aggregateBusinessOutcomes, BUSINESS_OUTCOME_CURRENCIES } from '../lib/business-outcomes.mjs';

// Shared conformance fixture for the independent SQL publication implementation.
// All hashes below are literals, never computed expectations from the function
// under test. PostgreSQL must hash the same canonical facts, not jsonb::text.
const CONTEXT = { workspaceId: 'tenant-golden', experimentId: 'experiment_golden', actorId: 'user_admin_golden',
  now: '2026-10-06T16:00:00.000Z', previousMeasurement: null };
function ownerInput() {
  return { expectedRevision: 0, amount: '123.450000', currency: 'GBP',
    window: { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' },
    coverage: { status: 'complete', observedCount: 12, expectedCount: 12 }, method: { kind: 'reconciled_manual' },
    observedAt: '2026-10-06T12:00:00.000Z', report: { description: 'Reconciled retained order revenue and recorded variable costs.', costsComplete: true } };
}
const validationContext = (context = CONTEXT) => ({ workspaceId: context.workspaceId, experimentId: context.experimentId, now: context.now });
const prepare = (body = ownerInput(), context = CONTEXT) => prepareExperimentOutcomeMeasurement(body, context);
function freeze(value) { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }
function reversed(value) { return Array.isArray(value) ? value.map(reversed) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversed(item)])) : value; }
function candidateFrom(measurement) {
  return createBusinessOutcomeCandidate({ source: { type: 'experiment_measurement', experimentId: measurement.experimentId,
    measurementRevision: measurement.revision, measurementDigest: measurement.digest }, metric: measurement.metric,
    amount: measurement.amount, currency: measurement.currency, window: measurement.window, coverage: measurement.coverage,
    method: measurement.method, provenance: measurement.provenance, links: measurement.links,
    verification: { kind: 'owner_attestation', actorId: 'user_owner_golden', verifiedAt: '2026-10-06T18:00:00.000Z', measurementDigest: measurement.digest } },
  { workspaceId: measurement.workspaceId, now: '2026-10-06T20:00:00.000Z' });
}

test('fixed canonical serializer golden preserves Unicode, safe integer representations and exact monetary strings', () => {
  const value = { z: 12, a: '雪🚀', n: -0, amount: '-0.000001', arr: [0, true, null] };
  assert.equal(canonicalMeasurementJson(value), '{"a":"雪🚀","amount":"-0.000001","arr":[0,true,null],"n":0,"z":12}');
  assert.equal(digestMeasurementValue(value), 'cdcd190371f0aeabdb6ed7e6b0d78f24893073849fb124e6fac57605be0e17a4');
  assert.equal(digestMeasurementValue(reversed(value)), digestMeasurementValue(value));
});

test('fixed report/envelope goldens bind the actual normalized facts and recording identity', () => {
  const measurement = prepare();
  assert.equal(measurement.schema, 'runvara-experiment-measurement/v1'); assert.equal(measurement.amount, '123.45');
  assert.equal(measurement.recordedBy, CONTEXT.actorId); assert.equal(measurement.recordedAt, CONTEXT.now); assert.equal(measurement.revision, 1);
  assert.equal(measurement.coverage.scopeId, 'whole_business_ce203c60594bf81482855621be816971bbb9ca13e8c9a137c731214e751e5046');
  assert.equal(measurement.provenance.observationId, 'measurement_observation_e8748103939123b02473c1ccd21fbfd96544de83319282daa3042a75a0979f1b');
  assert.equal(measurement.report.id, 'measurement_report_7ade075d80366185a7fde1ba1c6d7ef6ac17a0a50d0584f03f31ab14ed1cf76c');
  assert.equal(measurement.report.digest, '6e8ef5f0974c31d67049604048c810f63bf83d7c575a83d1e38eec10f7e477b8');
  assert.equal(measurement.digest, '8a3f07f810777a260ed6bbe8ba0d632d6ce386f565b1b1ff027adf77995ec76a');
  assert.deepEqual(measurement.provenance.sourceRefs, [{ type: 'measurement_report', id: measurement.report.id, digest: measurement.report.digest }]);
  assert.deepEqual(measurement.links, { action: null, opportunity: null, approval: null, objective: null });
  assert.equal(measurement.provenance.aggregation, 'standalone');
  assert.deepEqual(measurement.report.facts, { metric: measurement.metric, amount: measurement.amount, currency: measurement.currency,
    window: measurement.window, coverage: measurement.coverage, method: measurement.method, observedAt: measurement.provenance.observedAt });
  assert.equal(Buffer.byteLength(JSON.stringify(measurement), 'utf8'), 2093);
});

test('known complete facts are ready only for later owner verification and never become publication authority', () => {
  const measurement = prepare(), assessment = assessExperimentOutcomeMeasurement(measurement, validationContext());
  assert.equal(assessment.measurementComplete, true); assert.equal(assessment.readyForOwnerVerification, true);
  assert.equal(assessment.ownerVerificationRequired, true); assert.equal(assessment.publicationAuthority, false);
  assert.equal(assessment.independentSourceVerification, false); assert.equal(assessment.legacyVerificationUsed, false);
  assert.equal(assessment.runvaraAttribution, 'unestablished'); assert.equal(assessment.sourceReportBindingValid, true);
  assert.equal(measurement.verified, undefined); assert.equal(measurement.verification, undefined);
  const candidate = candidateFrom(measurement);
  assert.equal(candidate.source.measurementDigest, measurement.digest);
  assert.throws(() => aggregateBusinessOutcomes([candidate], { workspaceId: CONTEXT.workspaceId, now: CONTEXT.now }), { code: 'PUBLICATION_PROOF_REQUIRED' });
});

test('unknown draft facts stay null or unknown without using workspace defaults or recording time as evidence time', () => {
  const measurement = prepare({ expectedRevision: 0, report: { description: 'Reconciliation is incomplete.' } });
  for (const key of ['amount', 'currency', 'window']) assert.equal(measurement[key], null);
  assert.equal(measurement.method.kind, 'unknown'); assert.equal(measurement.coverage.status, 'unknown');
  assert.equal(measurement.coverage.observedCount, null); assert.equal(measurement.coverage.expectedCount, null);
  assert.equal(measurement.provenance.observedAt, null); assert.equal(measurement.report.costsComplete, null);
  const assessment = assessExperimentOutcomeMeasurement(measurement, validationContext());
  assert.equal(assessment.readyForOwnerVerification, false);
  for (const code of ['AMOUNT_UNKNOWN', 'CURRENCY_UNKNOWN', 'WINDOW_UNKNOWN', 'COVERAGE_INCOMPLETE', 'METHOD_UNKNOWN', 'OBSERVATION_TIME_UNKNOWN', 'COST_COMPLETENESS_UNKNOWN']) assert.ok(assessment.blockers.some(row => row.code === code), code);
});

test('false and null cost completeness block owner publication eligibility without losing the recorded draft', () => {
  for (const costsComplete of [false, null]) {
    const body = ownerInput(); body.report.costsComplete = costsComplete;
    const measurement = prepare(body), assessment = assessExperimentOutcomeMeasurement(measurement, validationContext());
    assert.equal(measurement.report.costsComplete, costsComplete); assert.equal(assessment.readyForOwnerVerification, false);
    assert.ok(assessment.blockers.some(row => row.code === (costsComplete === false ? 'COSTS_INCOMPLETE' : 'COST_COMPLETENESS_UNKNOWN')));
  }
});

test('zero, negative and fractional values remain exact; no nonzero result is allowed for a complete zero population', () => {
  for (const [value, expected] of [['-0.000000', '0'], ['-12.004000', '-12.004'], ['999999999999999999.999999', '999999999999999999.999999']]) {
    assert.equal(prepare({ ...ownerInput(), amount: value }).amount, expected);
  }
  const zero = ownerInput(); zero.amount = '0'; zero.coverage.observedCount = 0; zero.coverage.expectedCount = 0;
  assert.equal(assessExperimentOutcomeMeasurement(prepare(zero), validationContext()).readyForOwnerVerification, true);
  for (const amount of ['1', '-0.000001']) assert.throws(() => prepare({ ...zero, amount }), { code: 'MEASUREMENT_INVALID' });
  assert.equal(prepare({ ...zero, amount: null }).amount, null);
  for (const amount of [0, NaN, Infinity, '1e3', '0.0000001', '1000000000000000000', '', ' 1']) assert.throws(() => prepare({ ...ownerInput(), amount }), { code: 'MEASUREMENT_INVALID' });
});

test('server revision and identities advance only against the exact supplied previous revision', () => {
  const previous = prepare(), before = structuredClone(previous), body = ownerInput();
  body.expectedRevision = 1; body.amount = '-5.004';
  const nextContext = { ...CONTEXT, now: '2026-10-06T17:00:00.000Z', actorId: 'user_second_admin', previousMeasurement: previous };
  const next = prepare(body, nextContext);
  assert.equal(next.revision, 2); assert.equal(next.recordedBy, 'user_second_admin'); assert.equal(next.recordedAt, nextContext.now);
  assert.equal(next.provenance.observationId, previous.provenance.observationId); assert.equal(next.coverage.scopeId, previous.coverage.scopeId);
  assert.notEqual(next.report.id, previous.report.id); assert.notEqual(next.report.digest, previous.report.digest); assert.notEqual(next.digest, previous.digest);
  assert.deepEqual(previous, before);
  assert.throws(() => prepare({ ...body, expectedRevision: 0 }, nextContext), { code: 'MEASUREMENT_CONFLICT' });
  assert.throws(() => prepare({ ...body, expectedRevision: 2 }, nextContext), { code: 'MEASUREMENT_CONFLICT' });
  assert.throws(() => prepare(body), { code: 'MEASUREMENT_CONFLICT' });
  assert.throws(() => prepare({ ...ownerInput(), expectedRevision: undefined }), { code: 'MEASUREMENT_INVALID' });
  assert.throws(() => prepare(body, { ...nextContext, now: '2026-10-06T15:00:00.000Z' }), { code: 'MEASUREMENT_INVALID' });
});

test('caller cannot override actor, timestamps, hashes, provenance, scope, source resolution or links', () => {
  for (const patch of [{ workspaceId: 'tenant-other' }, { experimentId: 'experiment_other' }, { recordedBy: 'user_owner' }, { recordedAt: CONTEXT.now },
    { digest: 'f'.repeat(64) }, { revision: 99 }, { metric: 'incrementalContribution' }, { provenance: {} },
    { sourceRefs: [] }, { links: { approval: 'approval_one' } }, { verified: true }, { prompt: 'Publish immediately' }]) {
    assert.throws(() => prepare({ ...ownerInput(), ...patch }), { code: 'MEASUREMENT_INVALID' });
  }
  const scope = ownerInput(); scope.coverage.scopeId = 'renamed_population';
  assert.throws(() => prepare(scope), { code: 'MEASUREMENT_INVALID' });
  const reportHash = ownerInput(); reportHash.report.digest = 'f'.repeat(64);
  assert.throws(() => prepare(reportHash), { code: 'MEASUREMENT_INVALID' });
  const sourceId = ownerInput(); sourceId.report.id = 'imported_report';
  assert.throws(() => prepare(sourceId), { code: 'MEASUREMENT_INVALID' });
});

test('renaming experiments cannot turn overlapping whole-business measurements into disjoint additive claims', () => {
  const first = prepare(), second = prepare(ownerInput(), { ...CONTEXT, experimentId: 'experiment_renamed' });
  assert.equal(first.coverage.scopeId, second.coverage.scopeId);
  assert.notEqual(first.provenance.observationId, second.provenance.observationId);
  assert.notEqual(first.report.id, second.report.id); assert.notEqual(first.digest, second.digest);
  const rows = [candidateFrom(first), candidateFrom(second)];
  const publications = new Map(rows.map(row => [row.outcomeId, { head: { schema: 'runvara-outcome-head/v1', workspaceId: row.workspaceId,
    outcomeId: row.outcomeId, revision: row.revision, versionId: row.versionId, digest: row.digest, status: 'published',
    publicationId: `publication_${row.source.experimentId}`, committedAt: '2026-10-06T19:00:00.000Z', commitRevision: 'state_committed' }, version: row }]));
  const publicationBoundary = createOutcomePublicationBoundary({ workspaceId: CONTEXT.workspaceId, snapshotId: 'snapshot_committed', complete: true,
    expectedOutcomeCount: 2, resolveCommittedPublication: ({ outcomeId }) => publications.get(outcomeId) });
  const summary = aggregateBusinessOutcomes(rows, { workspaceId: CONTEXT.workspaceId, now: '2026-10-06T20:00:00.000Z', publicationBoundary });
  assert.deepEqual(summary.groups, []); assert.ok(summary.exclusions.every(row => row.code === 'OVERLAPPING_SCOPE'));
});

test('tenant/experiment identities are explicit on read and previous measurements cannot cross either boundary', () => {
  const measurement = prepare();
  assert.throws(() => validateExperimentOutcomeMeasurement(measurement, { ...validationContext(), workspaceId: 'tenant-other' }), { code: 'WORKSPACE_MISMATCH' });
  assert.throws(() => validateExperimentOutcomeMeasurement(measurement, { ...validationContext(), experimentId: 'experiment_other' }), { code: 'EXPERIMENT_MISMATCH' });
  assert.throws(() => prepare({ ...ownerInput(), expectedRevision: 1 }, { ...CONTEXT, previousMeasurement: measurement, workspaceId: 'tenant-other' }), { code: 'WORKSPACE_MISMATCH' });
  assert.throws(() => prepare({ ...ownerInput(), expectedRevision: 1 }, { ...CONTEXT, previousMeasurement: measurement, experimentId: 'experiment_other' }), { code: 'EXPERIMENT_MISMATCH' });
  const foreign = prepare(ownerInput(), { ...CONTEXT, workspaceId: 'tenant-other' });
  assert.notEqual(foreign.coverage.scopeId, measurement.coverage.scopeId); assert.notEqual(foreign.report.digest, measurement.report.digest);
});

test('canonical hashes and normalized facts survive JSON roundtrips, JSONB key ordering and integer spelling changes', () => {
  const measurement = prepare(), decoded = JSON.parse(JSON.stringify(reversed(measurement)).replaceAll('"expectedCount":12', '"expectedCount":12e0').replaceAll('"observedCount":12', '"observedCount":12.0'));
  assert.deepEqual(validateExperimentOutcomeMeasurement(decoded, validationContext()), measurement);
  assert.equal(decoded.digest, measurement.digest);
  const strings = ownerInput(); strings.report.description = 'Retained totals: 雪🚀; quote " and slash \\ are recorded text.';
  const unicode = prepare(strings);
  assert.deepEqual(validateExperimentOutcomeMeasurement(reversed(JSON.parse(JSON.stringify(unicode))), validationContext()), unicode);
});

test('modified report facts, source refs, identities or cost completeness cannot pass with caller-recomputed outer hashes', () => {
  const original = prepare();
  for (const mutate of [
    row => { row.report.facts.amount = '999'; }, row => { row.report.costsComplete = false; },
    row => { row.provenance.sourceRefs[0].digest = 'f'.repeat(64); }, row => { row.provenance.sourceRefs[0].id = 'other_report'; },
    row => { row.provenance.sourceRefs.push({ type: 'ledger_snapshot', id: 'arbitrary', digest: 'f'.repeat(64) }); },
    row => { row.coverage.scopeId = 'renamed_whole_business'; }, row => { row.provenance.aggregation = 'non_overlapping_scopes_attested'; },
    row => { row.links.approval = { workspaceId: CONTEXT.workspaceId, id: 'approval', revision: 1, digest: 'f'.repeat(64) }; },
    row => { row.report.recordedBy = 'other_actor'; }, row => { row.report.id = 'imported_report'; }
  ]) {
    const changed = structuredClone(original); mutate(changed);
    const { digest: _digest, ...body } = changed; changed.digest = digestMeasurementValue(body);
    assert.throws(() => validateExperimentOutcomeMeasurement(changed, validationContext()), { code: 'MEASUREMENT_INTEGRITY_FAILED' });
  }
  const altered = structuredClone(original); altered.report.facts.amount = '999';
  const { digest: _reportHash, ...reportBody } = altered.report; altered.report.digest = digestMeasurementValue(reportBody);
  altered.provenance.sourceRefs[0].digest = altered.report.digest;
  const { digest: _outerHash, ...body } = altered; altered.digest = digestMeasurementValue(body);
  assert.throws(() => validateExperimentOutcomeMeasurement(altered, validationContext()), { code: 'MEASUREMENT_INTEGRITY_FAILED' });
});

test('source description is bounded recorded context and all hashes change when actual facts or report context change', () => {
  const first = prepare();
  for (const mutate of [body => { body.amount = '124'; }, body => { body.currency = 'USD'; }, body => { body.report.description = 'A different explicit reconciliation method.'; }, body => { body.report.costsComplete = false; }]) {
    const body = ownerInput(); mutate(body); const next = prepare(body);
    assert.equal(next.report.id, first.report.id); assert.notEqual(next.report.digest, first.report.digest); assert.notEqual(next.digest, first.digest);
  }
  for (const value of ['', ' '.repeat(5), 'x'.repeat(1001), '\u0000', '\ud800', {}, 'multiple\nlines']) {
    const body = ownerInput(); body.report.description = value;
    assert.throws(() => prepare(body), { code: 'MEASUREMENT_INVALID' });
  }
  const trimmed = ownerInput(); trimmed.report.description = '  Recorded business context.  ';
  assert.equal(prepare(trimmed).report.description, 'Recorded business context.');
});

test('future windows remain explicit unqualified drafts; evidence observation time is never invented or allowed in the future', () => {
  const future = ownerInput(); future.window.endsAt = '2026-10-07T00:00:00.000Z';
  const draft = prepare(future), assessed = assessExperimentOutcomeMeasurement(draft, validationContext());
  assert.equal(draft.window.endsAt, future.window.endsAt); assert.equal(assessed.readyForOwnerVerification, false);
  assert.ok(assessed.blockers.some(row => row.code === 'OBSERVATION_BEFORE_WINDOW_END'));
  const laterObservation = ownerInput(); laterObservation.observedAt = '2026-10-06T17:00:00.000Z';
  assert.throws(() => prepare(laterObservation), { code: 'MEASUREMENT_INVALID' });
});

test('invalid dates, implicit numeric types, unsupported methods and contradictory coverage fail atomically', () => {
  const variants = [
    { currency: 'gbp' }, { currency: 'ZZZ' }, { expectedRevision: '0' }, { expectedRevision: -1 },
    { window: { startsAt: '2026-02-30T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' } },
    { window: { startsAt: '2026-10-01', endsAt: '2026-10-06' } },
    { window: { startsAt: '2024-10-01T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' } },
    { coverage: { status: 'complete', observedCount: 1, expectedCount: 2 } },
    { coverage: { status: 'partial', observedCount: 2, expectedCount: 2 } },
    { coverage: { status: 'unknown', observedCount: 3, expectedCount: 2 } },
    { coverage: { status: 'complete', observedCount: '12', expectedCount: 12 } },
    { method: { kind: 'invented' } }, { method: { kind: 'holdout', definitionVersion: 'caller-defined' } },
    { report: { description: 'Recorded facts', costsComplete: 'true' } }
  ];
  for (const patch of variants) assert.throws(() => prepare({ ...ownerInput(), ...patch }), { code: 'MEASUREMENT_INVALID' });
});

test('sparse arrays and accessors are rejected without evaluating computed metadata', () => {
  let reads = 0;
  const array = new Array(1); Object.defineProperty(array, '0', { enumerable: true, get() { reads++; return 'read'; } });
  for (const bad of [new Array(1), array]) assert.throws(() => canonicalMeasurementJson(bad), { code: 'MEASUREMENT_INVALID' });
  const input = ownerInput(); Object.defineProperty(input.report, 'description', { enumerable: true, get() { reads++; return 'A reported result'; } });
  assert.throws(() => prepare(input), { code: 'MEASUREMENT_INVALID' });
  const envelope = prepare(); envelope.provenance.sourceRefs = new Array(1);
  assert.throws(() => validateExperimentOutcomeMeasurement(envelope, validationContext()), { code: 'MEASUREMENT_INVALID' });
  const altered = prepare(); Object.defineProperty(altered.report.facts, 'amount', { enumerable: true, get() { reads++; return '123.45'; } });
  assert.throws(() => validateExperimentOutcomeMeasurement(altered, validationContext()), { code: 'MEASUREMENT_INVALID' });
  assert.equal(reads, 0);
  for (const value of [NaN, Infinity, 0.1, undefined, '\ud800', '\u0000']) assert.throws(() => canonicalMeasurementJson(value), { code: 'MEASUREMENT_INVALID' });
});

test('the full serialized envelope is bounded and detached from both owner input and its repeated report facts', () => {
  const body = freeze(ownerInput()), context = freeze({ ...CONTEXT }), original = structuredClone(body), measurement = prepare(body, context);
  assert.ok(Buffer.byteLength(JSON.stringify(measurement), 'utf8') <= EXPERIMENT_MEASUREMENT_MAX_BYTES);
  measurement.coverage.scopeId = 'mutated-return'; measurement.report.facts.window.endsAt = 'mutated-report';
  assert.deepEqual(body, original); assert.notEqual(measurement.report.facts.coverage.scopeId, 'mutated-return');
  assert.equal(measurement.window.endsAt, body.window.endsAt);
  const large = ownerInput(); large.amount = '999999999999999999.999999'; large.report.description = '界'.repeat(1000);
  const bounded = prepare(large, { ...CONTEXT, workspaceId: '界'.repeat(256), experimentId: 'e'.repeat(160), actorId: 'u'.repeat(160) });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= 8192);
});

test('preparation cannot mutate legacy verification or invoke providers and requires explicit trusted server context', t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('No provider request permitted'); });
  const experiment = freeze({ id: CONTEXT.experimentId, impact: { verified: true, incrementalContribution: 999 }, outcomeMeasurement: null });
  const before = structuredClone(experiment);
  const result = prepare(ownerInput(), { ...CONTEXT, previousMeasurement: experiment.outcomeMeasurement });
  assert.deepEqual(experiment, before); assert.equal(result.impact, undefined); assert.equal(fetch.mock.callCount(), 0);
  assert.throws(() => prepare(ownerInput(), { ...CONTEXT, now: undefined }), { code: 'MEASUREMENT_INVALID' });
  assert.throws(() => prepare(ownerInput(), { ...CONTEXT, actorId: 'owner@example.com' }), { code: 'MEASUREMENT_INVALID' });
  assert.throws(() => prepare(ownerInput(), { ...CONTEXT, authorized: true }), { code: 'MEASUREMENT_INVALID' });
});

test('measurement preparation uses exactly the shared frozen currency contract even when host ICU differs', t => {
  t.mock.method(Intl, 'supportedValuesOf', () => []);
  for (const currency of BUSINESS_OUTCOME_CURRENCIES) {
    const measurement = prepare({ ...ownerInput(), currency });
    assert.equal(measurement.currency, currency);
    assert.equal(validateExperimentOutcomeMeasurement(measurement, validationContext()).currency, currency);
  }
  for (const currency of ['ZZZ', 'XXX', 'gbp', 826]) assert.throws(() => prepare({ ...ownerInput(), currency }), { code: 'MEASUREMENT_INVALID' });
  assert.equal(assessExperimentOutcomeMeasurement(prepare({ ...ownerInput(), currency: null }), validationContext()).readyForOwnerVerification, false);
});
