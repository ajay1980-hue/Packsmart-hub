import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createBusinessOutcomeCandidate, correctBusinessOutcomeCandidate, withdrawBusinessOutcomeCandidate,
  validateBusinessOutcomeCandidate, validateBusinessOutcomePublication, assessBusinessOutcomeCandidate, createOutcomePublicationBoundary,
  aggregateBusinessOutcomes, projectCurrentOutcomeReferences, normalizeOutcomeDecimal, BUSINESS_OUTCOME_LIMITS, BUSINESS_OUTCOME_CURRENCIES, BUSINESS_OUTCOME_CURRENCY_CONTRACT_VERSION
} from '../lib/business-outcomes.mjs';

const NOW = '2026-10-06T20:00:00.000Z', options = { workspaceId: 'tenant-a', now: NOW };
const H = char => char.repeat(64);
const fixtureDigest = value => createHash('sha256').update(value).digest('hex');
function input({ experimentId = 'experiment_one', amount = '10', observationId = 'observation_one', scopeId = 'population_one', currency = 'GBP', method = 'holdout', aggregation = 'non_overlapping_scopes_attested' } = {}) {
  return { source: { type: 'experiment_measurement', experimentId, measurementRevision: 1, measurementDigest: fixtureDigest(`measurement:${experimentId}`) },
    metric: 'incrementalContribution', amount, currency,
    window: { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' },
    coverage: { status: 'complete', scopeId, observedCount: 10, expectedCount: 10 },
    method: { kind: method, definitionVersion: 'incremental-contribution/v1' },
    provenance: { observationId, sourceRefs: [{ type: 'measurement_report', id: `report_${experimentId}`, digest: fixtureDigest(`report:${experimentId}`) }], observedAt: '2026-10-06T12:00:00.000Z', aggregation },
    verification: { kind: 'owner_attestation', actorId: 'user_owner', verifiedAt: '2026-10-06T14:00:00.000Z', measurementDigest: fixtureDigest(`measurement:${experimentId}`) } };
}
const candidate = properties => createBusinessOutcomeCandidate(input(properties), options);
function head(row, patch = {}) {
  return { schema: 'runvara-outcome-head/v1', workspaceId: row.workspaceId, outcomeId: row.outcomeId, revision: row.revision,
    versionId: row.versionId, digest: row.digest, status: row.status === 'withdrawn' ? 'withdrawn' : 'published',
    publicationId: `publication_${row.revision}`, committedAt: '2026-10-06T19:00:00.000Z', commitRevision: 'state_committed_revision', ...patch };
}
function proof(currentRows, settings = {}) {
  const heads = new Map(currentRows.map(row => [row.outcomeId, { head: head(row), version: row }]));
  return createOutcomePublicationBoundary({ workspaceId: 'tenant-a', snapshotId: 'committed_snapshot_one', complete: true,
    expectedOutcomeCount: heads.size, resolveCommittedPublication: ({ workspaceId, outcomeId }) => workspaceId === 'tenant-a' ? heads.get(outcomeId) ?? null : null, ...settings });
}
function aggregate(rows, boundary = proof(rows)) { return aggregateBusinessOutcomes(rows, { ...options, publicationBoundary: boundary }); }
function freeze(value) { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }
const code = value => value.exclusions.map(row => row.code);

test('current-reference projector requires private proof and exposes only descriptive source metadata', () => {
  const row = candidate(), boundary = proof([row]);
  const result = projectCurrentOutcomeReferences(freeze([row]), { ...options, publicationBoundary: boundary });
  assert.equal(result.coverage.complete, true); assert.equal(result.counts.publishedHeads, 1);
  assert.deepEqual(result.records, [{ outcomeId: row.outcomeId, versionId: row.versionId, digest: row.digest,
    revision: 1, status: 'published', source: row.source, measurementComplete: true }]);
  for (const forbidden of ['actorId', 'links', 'sourceRefs', 'amount', 'verification']) assert.equal(JSON.stringify(result).includes(forbidden), false);
  for (const fake of [undefined, {}, structuredClone(boundary), JSON.parse(JSON.stringify(boundary)), result]) {
    assert.throws(() => projectCurrentOutcomeReferences([row], { ...options, publicationBoundary: fake }), { code: 'PUBLICATION_PROOF_REQUIRED' });
  }
  assert.throws(() => aggregateBusinessOutcomes([row], { ...options, publicationBoundary: JSON.parse(JSON.stringify(result)) }), { code: 'PUBLICATION_PROOF_REQUIRED' });
});

test('current references reject a historical supplied version against published corrections and withdrawals', () => {
  const first = candidate(), replacement = input({ amount: '-1.000001' });
  replacement.source.measurementRevision = 2; replacement.source.measurementDigest = H('c'); replacement.verification.measurementDigest = H('c');
  const corrected = correctBusinessOutcomeCandidate(first, replacement, options);
  const withdrawn = withdrawBusinessOutcomeCandidate(corrected, { reason: 'incorrect_measurement', verification: corrected.verification }, options);
  for (const current of [corrected, withdrawn]) {
    const missing = projectCurrentOutcomeReferences([first], { ...options, publicationBoundary: proof([current]) });
    assert.deepEqual(missing.records, []); assert.equal(missing.coverage.complete, false);
    assert.ok(code(missing).includes('CURRENT_VERSION_UNPROVED'));
    const matched = projectCurrentOutcomeReferences([first, current], { ...options, publicationBoundary: proof([current]) });
    assert.equal(matched.records.length, 1); assert.equal(matched.records[0].versionId, current.versionId);
    assert.equal(matched.coverage.complete, true);
  }
});

test('current references fail closed on tenant mismatch and describe incomplete or unavailable proof', () => {
  const row = candidate();
  for (const versions of [[{ ...row, workspaceId: 'foreign' }], [row]]) {
    assert.throws(() => projectCurrentOutcomeReferences(versions, { ...options, workspaceId: 'foreign', publicationBoundary: proof([row]) }), { code: 'WORKSPACE_MISMATCH' });
  }
  assert.throws(() => projectCurrentOutcomeReferences([{ ...row, workspaceId: 'foreign' }], { ...options, publicationBoundary: proof([row]) }), { code: 'WORKSPACE_MISMATCH' });
  for (const settings of [{ complete: false }, { expectedOutcomeCount: 2 }]) {
    const result = projectCurrentOutcomeReferences([row], { ...options, publicationBoundary: proof([row], settings) });
    assert.equal(result.coverage.complete, false); assert.equal(result.records.length, 1);
  }
  const unavailable = projectCurrentOutcomeReferences([row], { ...options, publicationBoundary: proof([row], { resolveCommittedPublication: () => { throw Error('private source text'); } }) });
  assert.deepEqual(unavailable.records, []); assert.equal(unavailable.coverage.complete, false);
  assert.equal(JSON.stringify(unavailable).includes('private source text'), false);
});

test('initial candidate identities are stable, source-scoped and independent of object/reference order', () => {
  const firstInput = input(); firstInput.provenance.sourceRefs.push({ type: 'ledger_snapshot', id: 'ledger_one', digest: H('c') });
  const first = createBusinessOutcomeCandidate(firstInput, options);
  const reordered = Object.fromEntries(Object.entries(firstInput).reverse()); reordered.provenance = { ...reordered.provenance, sourceRefs: [...reordered.provenance.sourceRefs].reverse() };
  assert.deepEqual(createBusinessOutcomeCandidate(reordered, options), first);
  assert.match(first.outcomeId, /^outcome_[a-f0-9]{64}$/); assert.match(first.versionId, /^outcome_version_[a-f0-9]{64}$/);
  assert.equal(first.outcomeId.includes('experiment_one'), false);
  assert.equal(first.publicationAuthority, false); assert.equal(first.sourceReferencesResolved, false);
  assert.equal(first.runvaraAttribution, 'unestablished');
  assert.deepEqual(validateBusinessOutcomeCandidate(first, options), first);
  const changed = candidate({ amount: '11' });
  assert.equal(changed.outcomeId, first.outcomeId); assert.notEqual(changed.versionId, first.versionId);
  const other = createBusinessOutcomeCandidate(firstInput, { ...options, workspaceId: 'tenant-b' });
  assert.notEqual(other.outcomeId, first.outcomeId); assert.notEqual(other.digest, first.digest);
});

test('strict exact decimal normalization retains valid zero, negative and fractional amounts', () => {
  for (const [value, expected] of [['0', '0'], ['-0.000000', '0'], ['1.230000', '1.23'], ['-0.000001', '-0.000001'], ['999999999999999999.999999', '999999999999999999.999999'], [null, null], [undefined, null]]) assert.equal(normalizeOutcomeDecimal(value), expected);
  for (const value of [0, -1, NaN, Infinity, true, '', ' 0', '+1', '01', '1e2', '0.0000001', '1000000000000000000', '1.', '.1']) assert.throws(() => normalizeOutcomeDecimal(value), { code: 'OUTCOME_INVALID' });
});

test('zero counts as a real qualified observation while unknown remains null and excluded', () => {
  const zero = candidate({ amount: '0' }), zeroSummary = aggregate([zero]);
  assert.equal(zeroSummary.groups[0].amount, '0'); assert.equal(zeroSummary.groups[0].measuredCount, 1);
  assert.equal(zeroSummary.groups[0].knownZeroCount, 1); assert.equal(zeroSummary.counts.qualifiedOutcomes, 1);
  const unknown = candidate({ amount: null });
  assert.equal(unknown.amount, null); assert.equal(assessBusinessOutcomeCandidate(unknown, options).measurementComplete, false);
  const unknownSummary = aggregate([unknown]);
  assert.deepEqual(unknownSummary.groups, []); assert.equal(unknownSummary.overallAmount, null);
  assert.ok(unknownSummary.exclusions[0].blockers.some(row => row.code === 'AMOUNT_UNKNOWN'));
  const missingInput = input(); delete missingInput.amount;
  assert.equal(createBusinessOutcomeCandidate(missingInput, options).amount, null);
});

test('exact aggregation exceeds JavaScript safe integer size without losing any fractional units', () => {
  const one = candidate({ amount: '999999999999999999.999999' });
  const two = candidate({ experimentId: 'experiment_two', observationId: 'observation_two', scopeId: 'population_two', amount: '999999999999999999.999999' });
  const negative = candidate({ experimentId: 'experiment_three', observationId: 'observation_three', scopeId: 'population_three', amount: '-0.000001' });
  const summary = aggregate([one, two, negative]);
  assert.equal(summary.groups.length, 1);
  assert.equal(summary.groups[0].amount, '1999999999999999999.999997');
  assert.equal(summary.groups[0].negativeCount, 1); assert.equal(summary.groups[0].positiveCount, 2);
  assert.equal(typeof summary.groups[0].amount, 'string');
  assert.equal(summary.overallAmount, null); assert.equal(summary.roi, null);
});

test('ordinary archive flags, candidate fields and serialized proof lookalikes never establish publication', () => {
  const row = candidate();
  for (const boundary of [undefined, null, { committed: true, verified: true }, JSON.parse(JSON.stringify(proof([row])))]) {
    assert.throws(() => aggregateBusinessOutcomes([row], { ...options, publicationBoundary: boundary }), { code: 'PUBLICATION_PROOF_REQUIRED' });
  }
  assert.throws(() => createOutcomePublicationBoundary({ workspaceId: 'tenant-a', snapshotId: 'snapshot', complete: true, expectedOutcomeCount: 1, resolveCommittedPublication: true }), { code: 'PUBLICATION_PROOF_REQUIRED' });
  const unpublished = aggregate([row], proof([], { expectedOutcomeCount: 1 }));
  assert.deepEqual(unpublished.groups, []); assert.ok(code(unpublished).includes('UNPUBLISHED_OUTCOME')); assert.equal(unpublished.coverage.complete, false);
  const archived = { id: 'archived_work', status: 'COMPLETED', impact: { verified: true, incrementalContribution: 900000, currency: 'GBP' } };
  const invalid = aggregate([archived], proof([], { expectedOutcomeCount: 1 }));
  assert.equal(invalid.counts.qualifiedOutcomes, 0); assert.ok(code(invalid).includes('INVALID_OUTCOME_VERSION'));
  assert.equal(invalid.coverage.complete, false);
});

test('a trusted current head must bind exact version, digest, revision and committed time', () => {
  const row = candidate();
  for (const patch of [{ digest: H('f') }, { versionId: `outcome_version_${H('d')}` }, { revision: 2 }, { committedAt: '2026-10-07T00:00:00.000Z' }, { committedAt: '2026-10-06T13:00:00.000Z' }]) {
    const boundary = proof([row], { resolveCommittedPublication: () => ({ head: head(row, patch), version: row }) });
    const summary = aggregate([row], boundary);
    assert.equal(summary.counts.qualifiedOutcomes, 0); assert.equal(summary.coverage.complete, false);
  }
  const unavailable = aggregate([row], proof([row], { resolveCommittedPublication: () => { throw new Error('private database failure'); } }));
  assert.ok(code(unavailable).includes('PUBLICATION_UNAVAILABLE'));
  assert.equal(JSON.stringify(unavailable).includes('private database failure'), false);
  const asynchronous = aggregate([row], proof([row], { resolveCommittedPublication: () => Promise.resolve({ head: head(row), version: row }) }));
  assert.equal(asynchronous.coverage.complete, false); assert.deepEqual(asynchronous.groups, []);
});

test('incomplete publication reads or omitted current outcomes never produce partial totals presented as complete', () => {
  const one = candidate(), two = candidate({ experimentId: 'experiment_two', observationId: 'observation_two', scopeId: 'population_two' });
  for (const boundary of [proof([one], { complete: false }), proof([one], { expectedOutcomeCount: 2 }), proof([one, two])]) {
    const summary = aggregate([one], boundary);
    assert.equal(summary.coverage.complete, false); assert.equal(summary.groups[0].amount, null);
    assert.equal(summary.groups[0].amountStatus, 'incomplete_publication_read');
  }
  const summary = aggregate([one, two], proof([one, two], { resolveCommittedPublication: ({ outcomeId }) => outcomeId === two.outcomeId ? null : { head: head(one), version: one } }));
  assert.equal(summary.coverage.complete, false); assert.ok(summary.groups.every(group => group.amount === null));
});

test('correction lineage is immutable and only the current committed correction contributes once', () => {
  const previous = candidate({ amount: '10' }), replacement = input({ amount: '-2.004' });
  replacement.source.measurementRevision = 2; replacement.source.measurementDigest = H('d'); replacement.verification.measurementDigest = H('d');
  replacement.verification.verifiedAt = '2026-10-06T15:00:00.000Z';
  const before = structuredClone(previous), correction = correctBusinessOutcomeCandidate(previous, replacement, options);
  assert.deepEqual(previous, before); assert.equal(correction.outcomeId, previous.outcomeId);
  assert.equal(correction.revision, 2); assert.equal(correction.lineage.previousVersionId, previous.versionId);
  assert.equal(correction.lineage.previousDigest, previous.digest); assert.notEqual(correction.digest, previous.digest);
  const current = aggregate([previous, correction, correction], proof([correction]));
  assert.equal(current.groups[0].amount, '-2.004'); assert.equal(current.groups[0].measuredCount, 1);
  assert.equal(current.counts.distinctVersions, 2);
  const stillPrevious = aggregate([previous, correction], proof([previous]));
  assert.equal(stillPrevious.groups[0].amount, '10', 'An uncommitted correction cannot replace the published head');
  const missingCurrent = aggregate([previous], proof([correction]));
  assert.equal(missingCurrent.coverage.complete, false); assert.deepEqual(missingCurrent.groups, []);
  assert.throws(() => correctBusinessOutcomeCandidate(previous, input({ amount: '20' }), options), { code: 'OUTCOME_INVALID' });
  assert.throws(() => correctBusinessOutcomeCandidate(previous, { ...replacement, source: { ...replacement.source, experimentId: 'different_experiment' } }, options), { code: 'OUTCOME_INVALID' });
});

test('withdrawal preserves immutable measurement history and takes effect only at the trusted head', () => {
  const previous = candidate({ amount: '14' });
  const withdrawal = withdrawBusinessOutcomeCandidate(previous, { reason: 'incorrect_measurement', verification: { ...previous.verification, verifiedAt: '2026-10-06T16:00:00.000Z' } }, options);
  assert.equal(withdrawal.amount, '14'); assert.equal(withdrawal.status, 'withdrawn'); assert.equal(withdrawal.lineage.previousVersionId, previous.versionId);
  assert.equal(aggregate([previous, withdrawal], proof([previous])).groups[0].amount, '14');
  const removed = aggregate([previous, withdrawal], proof([withdrawal]));
  assert.deepEqual(removed.groups, []); assert.equal(removed.counts.withdrawnOutcomes, 1);
  assert.ok(code(removed).includes('OUTCOME_WITHDRAWN'));
  assert.throws(() => withdrawBusinessOutcomeCandidate(withdrawal, { reason: 'duplicate_observation', verification: withdrawal.verification }, options), { code: 'OUTCOME_INVALID' });
  assert.throws(() => withdrawBusinessOutcomeCandidate(previous, { reason: 'customer@example.com', verification: previous.verification }, options), { code: 'OUTCOME_INVALID' });
});

test('duplicate payloads count once, while conflicting immutable versions invalidate the selection', () => {
  const row = candidate();
  assert.equal(aggregate([row, structuredClone(row)], proof([row])).groups[0].measuredCount, 1);
  const altered = { ...row, amount: '99999' };
  assert.throws(() => validateBusinessOutcomeCandidate(altered, options), { code: 'OUTCOME_INTEGRITY_FAILED' });
  const summary = aggregate([row, altered], proof([row]));
  assert.deepEqual(summary.groups, []); assert.equal(summary.coverage.complete, false);
  assert.ok(code(summary).includes('CONFLICTING_OUTCOME_VERSION'));
});

test('the same economic observation copied into another experiment is not double-counted', () => {
  const one = candidate();
  const copied = candidate({ experimentId: 'experiment_copy', scopeId: 'population_other', amount: '100' });
  const summary = aggregate([one, copied]);
  assert.deepEqual(summary.groups, []);
  assert.equal(summary.counts.qualifiedOutcomes, 0);
  assert.equal(summary.exclusions.filter(row => row.code === 'DUPLICATE_OBSERVATION').length, 2);
});

test('overlapping scope claims are excluded while adjacent half-open windows remain distinct', () => {
  const one = candidate(), secondInput = input({ experimentId: 'experiment_two', observationId: 'observation_two' });
  secondInput.window.startsAt = '2026-10-02T00:00:00.000Z';
  const two = createBusinessOutcomeCandidate(secondInput, options), overlapping = aggregate([one, two]);
  assert.deepEqual(overlapping.groups, []); assert.ok(code(overlapping).includes('OVERLAPPING_SCOPE'));
  const earlierInput = input({ experimentId: 'experiment_earlier', observationId: 'observation_earlier' });
  earlierInput.window = { startsAt: '2026-09-26T00:00:00.000Z', endsAt: one.window.startsAt };
  const adjacent = aggregate([one, createBusinessOutcomeCandidate(earlierInput, options)]);
  assert.equal(adjacent.groups.length, 2); assert.ok(adjacent.groups.every(group => group.amount === '10'));
});

test('currency, exact window and measurement method define separate comparable groups; no lifetime ROI exists', () => {
  const gbp = candidate({ amount: '100' });
  const usd = candidate({ experimentId: 'experiment_usd', observationId: 'observation_usd', scopeId: 'population_usd', currency: 'USD', amount: '100' });
  const beforeAfter = candidate({ experimentId: 'experiment_observational', observationId: 'observation_observational', scopeId: 'population_observational', method: 'before_after' });
  const summary = aggregate([gbp, usd, beforeAfter]);
  assert.equal(summary.groups.length, 3);
  assert.deepEqual(summary.groups.map(row => row.currency).sort(), ['GBP', 'GBP', 'USD']);
  assert.equal(summary.overallAmount, null); assert.equal(summary.roi, null);
  assert.equal(summary.safeguards.currenciesNeverCombined, true);
  assert.equal(summary.safeguards.lifetimeMonthlyRoiCalculated, false);
});

test('standalone observations are not added merely because their currencies and periods match', () => {
  const one = candidate({ aggregation: 'standalone' });
  const two = candidate({ experimentId: 'experiment_two', observationId: 'observation_two', scopeId: 'population_two', aggregation: 'standalone' });
  const grouped = aggregate([one, two]);
  assert.equal(grouped.groups[0].amount, null); assert.equal(grouped.groups[0].amountStatus, 'standalone_observations');
  assert.equal(grouped.groups[0].measuredCount, 2); assert.equal(grouped.groups[0].learningComparable, false);
  assert.equal(aggregate([one]).groups[0].amount, '10');
});

test('unknown currency/window/coverage/method/provenance cannot be inferred from other fields', () => {
  for (const patch of [{ currency: null }, { window: null }, { coverage: { status: 'unknown', scopeId: null, observedCount: null, expectedCount: null } },
    { method: { kind: 'unknown', definitionVersion: 'incremental-contribution/v1' } },
    { provenance: { observationId: null, sourceRefs: [], observedAt: null, aggregation: 'standalone' } }]) {
    const row = createBusinessOutcomeCandidate({ ...input(), ...patch }, options), assessed = assessBusinessOutcomeCandidate(row, options);
    assert.equal(assessed.measurementComplete, false); assert.equal(assessed.publicationAuthority, false);
    assert.equal(aggregate([row]).groups.length, 0);
  }
  const partial = input(); partial.coverage = { ...partial.coverage, status: 'partial', observedCount: 4 };
  const row = createBusinessOutcomeCandidate(partial, options);
  assert.equal(row.coverage.observedCount, 4); assert.equal(row.coverage.expectedCount, 10);
  assert.ok(assessBusinessOutcomeCandidate(row, options).blockers.some(item => item.code === 'COVERAGE_INCOMPLETE'));
});

test('strict metadata and temporal validation reject contradictions, implicit types and unbounded data', () => {
  const variants = [
    { metric: 'incrementalRevenue' }, { currency: 'gbp' }, { currency: 'ZZZ' },
    { window: { startsAt: '2026-02-30T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' } },
    { window: { startsAt: '2026-10-06T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' } },
    { window: { startsAt: '2024-01-01T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' } },
    { coverage: { status: 'complete', scopeId: 'scope', observedCount: 5, expectedCount: 10 } },
    { coverage: { status: 'partial', scopeId: 'scope', observedCount: 10, expectedCount: 5 } },
    { coverage: { status: 'complete', scopeId: 'scope', observedCount: '10', expectedCount: 10 } },
    { provenance: { ...input().provenance, observedAt: '2026-10-05T00:00:00.000Z' } },
    { verification: { ...input().verification, verifiedAt: '2026-10-07T00:00:00.000Z' } },
    { verification: { ...input().verification, measurementDigest: H('e') } },
    { source: { ...input().source, measurementRevision: 0 } },
    { source: { ...input().source, measurementRevision: NaN } },
    { source: { ...input().source, measurementDigest: 'not-a-digest' } },
    { provenance: { ...input().provenance, sourceRefs: Array(21).fill(input().provenance.sourceRefs[0]) } }
  ];
  for (const patch of variants) assert.throws(() => createBusinessOutcomeCandidate({ ...input(), ...patch }, options), { code: 'OUTCOME_INVALID' });
  const duplicate = input(); duplicate.provenance.sourceRefs.push({ ...duplicate.provenance.sourceRefs[0], digest: H('f') });
  assert.throws(() => createBusinessOutcomeCandidate(duplicate, options), { code: 'OUTCOME_INVALID' });
});

test('optional source linkages require explicit same-tenant identity/revision/digest without granting execution', () => {
  const record = input(); record.links = Object.fromEntries(['action', 'opportunity', 'approval', 'objective'].map(kind => [kind, { workspaceId: 'tenant-a', id: `${kind}_one`, revision: 1, digest: H('c') }]));
  const row = createBusinessOutcomeCandidate(record, options);
  assert.equal(row.links.approval.id, 'approval_one'); assert.equal(row.sourceReferencesResolved, false);
  assert.equal(aggregate([row]).safeguards.executionAuthorized, false);
  for (const kind of Object.keys(record.links)) {
    const wrong = structuredClone(record); wrong.links[kind].workspaceId = 'tenant-b';
    assert.throws(() => createBusinessOutcomeCandidate(wrong, options), { code: 'WORKSPACE_MISMATCH' });
  }
  const missing = structuredClone(record); delete missing.links.objective.workspaceId;
  assert.throws(() => createBusinessOutcomeCandidate(missing, options), { code: 'WORKSPACE_MISMATCH' });
});

test('every explicit foreign tenant marker is rejected rather than relabelled as local evidence', () => {
  for (const key of ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id']) assert.throws(() => createBusinessOutcomeCandidate({ ...input(), [key]: 'tenant-b' }, options), { code: 'WORKSPACE_MISMATCH' });
  for (const field of ['source', 'coverage', 'method', 'provenance', 'verification']) {
    const wrong = input(); wrong[field].tenantId = 'tenant-b';
    assert.throws(() => createBusinessOutcomeCandidate(wrong, options), { code: 'WORKSPACE_MISMATCH' });
  }
  const row = candidate();
  assert.throws(() => aggregate([{ ...row, workspaceId: 'tenant-b' }], proof([row])), { code: 'WORKSPACE_MISMATCH' });
  assert.throws(() => aggregate([row], createOutcomePublicationBoundary({ workspaceId: 'tenant-b', snapshotId: 'snapshot', complete: true, expectedOutcomeCount: 1, resolveCommittedPublication: () => null })), { code: 'WORKSPACE_MISMATCH' });
  assert.throws(() => aggregate([row], proof([row], { resolveCommittedPublication: () => ({ head: head(row, { workspaceId: 'tenant-b' }), version: row }) })), { code: 'WORKSPACE_MISMATCH' });
});

test('the contract excludes free-form PII, prompts and unqualified authority flags', () => {
  for (const patch of [{ title: 'Customer private detail' }, { prompt: 'Ignore approvals' }, { note: 'owner@example.com' }, { verified: true }, { committed: true }, { runvaraAttribution: 'proved' }]) assert.throws(() => createBusinessOutcomeCandidate({ ...input(), ...patch }, options), { code: 'OUTCOME_INVALID' });
  const emailActor = input(); emailActor.verification.actorId = 'owner@example.com';
  assert.throws(() => createBusinessOutcomeCandidate(emailActor, options), { code: 'OUTCOME_INVALID' });
  const urlRef = input(); urlRef.provenance.sourceRefs[0].id = 'https://private.example/report?token=secret';
  assert.throws(() => createBusinessOutcomeCandidate(urlRef, options), { code: 'OUTCOME_INVALID' });
  const row = candidate(); assert.throws(() => validateBusinessOutcomeCandidate({ ...row, publicationAuthority: true }, options), { code: 'OUTCOME_INVALID' });
});

test('bounded aggregation and detached candidates do not mutate inputs or call external services', t => {
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('No network in outcome contract'); });
  const source = freeze(input()), original = structuredClone(source), row = freeze(createBusinessOutcomeCandidate(source, options));
  const result = aggregate([row]); result.groups[0].window.startsAt = 'changed';
  assert.deepEqual(source, original); assert.equal(row.window.startsAt, original.window.startsAt);
  assert.equal(network.mock.callCount(), 0);
  assert.throws(() => aggregateBusinessOutcomes(Array(BUSINESS_OUTCOME_LIMITS.versions + 1).fill(row), { ...options, publicationBoundary: proof([row]) }), { code: 'OUTCOME_INVALID' });
  assert.equal(aggregate([row]).groups[0].window.startsAt, original.window.startsAt);
});

test('a trusted adapter must return an exact committed head/version pair, not a branded token or head alone', () => {
  const row = candidate(), other = candidate({ amount: '11' });
  for (const resolver of [
    () => head(row),
    () => ({ head: head(row), version: null }),
    () => ({ head: head(row), version: other }),
    () => ({ head: head(row, { status: 'withdrawn' }), version: row }),
    () => ({ head: head(row), version: { ...row, publicationAuthority: true } })
  ]) {
    const summary = aggregate([row], proof([row], { resolveCommittedPublication: resolver }));
    assert.equal(summary.counts.qualifiedOutcomes, 0);
    assert.equal(summary.coverage.complete, false);
    assert.ok(code(summary).includes('PUBLICATION_UNAVAILABLE'));
  }
  let resolutions = 0;
  const resolved = aggregate([row, row, structuredClone(row)], proof([row], { resolveCommittedPublication: () => { resolutions++; return { head: head(row), version: row }; } }));
  assert.equal(resolutions, 1, 'One stable materialized publication lookup per logical outcome');
  assert.equal(resolved.groups[0].measuredCount, 1);
});

test('JSON archival and corrected versions do not change an exact result without a different committed current head', () => {
  const old = candidate({ amount: '0.000001' }), replacement = input({ amount: '0.000002' });
  replacement.source.measurementRevision = 2; replacement.source.measurementDigest = H('d'); replacement.verification.measurementDigest = H('d');
  const pending = correctBusinessOutcomeCandidate(old, replacement, options), snapshot = proof([old]);
  const before = aggregate([old], snapshot);
  const archivedCopies = [JSON.parse(JSON.stringify(old)), JSON.parse(JSON.stringify(pending))];
  const afterFailedPublication = aggregate(archivedCopies, snapshot);
  assert.deepEqual(afterFailedPublication.groups, before.groups, 'A pre-CAS archived correction cannot become realised value');
  const afterCommit = aggregate(archivedCopies, proof([pending]));
  assert.equal(afterCommit.groups[0].amount, '0.000002');
  assert.equal(afterCommit.groups[0].measuredCount, 1);
});

test('an empty committed selection stays distinct from one explicitly measured zero-population result', () => {
  const empty = aggregate([], proof([]));
  assert.equal(empty.coverage.complete, true); assert.equal(empty.overallAmount, null); assert.deepEqual(empty.groups, []);
  const measured = input({ amount: '0' }); measured.coverage.observedCount = 0; measured.coverage.expectedCount = 0;
  const zero = aggregate([createBusinessOutcomeCandidate(measured, options)]);
  assert.equal(zero.groups[0].amount, '0'); assert.equal(zero.groups[0].measuredCount, 1);
  assert.equal(zero.groups[0].knownZeroCount, 1);
});

test('source-reference arrays must be dense recorded data without holes, inherited indices, accessors or hidden fields', () => {
  const ref = input().provenance.sourceRefs[0]; let reads = 0;
  const getter = new Array(1); Object.defineProperty(getter, '0', { enumerable: true, get() { reads++; return ref; } });
  const inherited = new Array(1); Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: ref }));
  const extra = [ref]; extra.note = 'not serialized array content';
  const symbol = [ref]; symbol[Symbol('private')] = 'not JSON';
  const hidden = [ref]; Object.defineProperty(hidden, '0', { enumerable: false, value: ref });
  for (const refs of [new Array(1), [ref, , ref], getter, inherited, extra, symbol, hidden]) {
    const record = input(); record.provenance.sourceRefs = refs;
    assert.throws(() => createBusinessOutcomeCandidate(record, options), { code: 'OUTCOME_INVALID' });
  }
  assert.equal(reads, 0, 'The validator must not invoke an index getter');
  const valid = candidate(), forged = { ...valid, provenance: { ...valid.provenance, sourceRefs: new Array(1) } };
  assert.throws(() => assessBusinessOutcomeCandidate(forged, options), { code: 'OUTCOME_INVALID' });
  const summary = aggregate([forged], proof([forged]));
  assert.deepEqual(summary.groups, []); assert.equal(summary.coverage.complete, false);
});

test('record accessors are rejected before tenant, reference or candidate fields are read', () => {
  let reads = 0;
  for (const mutate of [
    record => Object.defineProperty(record, 'workspaceId', { enumerable: true, get() { reads++; return 'tenant-a'; } }),
    record => Object.defineProperty(record.source, 'experimentId', { enumerable: true, get() { reads++; return 'experiment_one'; } }),
    record => Object.defineProperty(record.provenance, 'sourceRefs', { enumerable: true, get() { reads++; return []; } }),
    record => Object.defineProperty(record.provenance.sourceRefs[0], 'id', { enumerable: true, get() { reads++; return 'report_one'; } })
  ]) {
    const record = input(); mutate(record);
    assert.throws(() => createBusinessOutcomeCandidate(record, options), { code: 'OUTCOME_INVALID' });
  }
  const malformed = structuredClone(candidate());
  Object.defineProperty(malformed, 'outcomeId', { enumerable: true, get() { reads++; return candidate().outcomeId; } });
  const summary = aggregate([malformed], proof([], { expectedOutcomeCount: 1 }));
  assert.deepEqual(summary.groups, []); assert.equal(summary.coverage.complete, false);
  assert.equal(reads, 0, 'No accessor may run during validation, including failure reporting');
});

test('aggregation inputs enforce the same dense recorded-array contract before resolving publications', () => {
  const row = candidate(); let reads = 0, resolutions = 0;
  const accessor = new Array(1); Object.defineProperty(accessor, '0', { enumerable: true, get() { reads++; return row; } });
  const extra = [row]; extra.archived = true;
  const symbol = [row]; Object.defineProperty(symbol, Symbol.iterator, { get() { reads++; return Array.prototype[Symbol.iterator]; } });
  const boundary = proof([row], { resolveCommittedPublication: () => { resolutions++; return { head: head(row), version: row }; } });
  for (const rows of [new Array(1), [row, , row], accessor, extra, symbol]) assert.throws(() => aggregate(rows, boundary), { code: 'OUTCOME_INVALID' });
  assert.equal(reads, 0); assert.equal(resolutions, 0);
});

test('every accepted candidate survives JSON round-trip with unchanged identity, assessment and aggregate', () => {
  const original = input();
  original.provenance.sourceRefs.push({ type: 'ledger_snapshot', id: 'ledger_zero', digest: H('e') });
  Object.setPrototypeOf(original.provenance.sourceRefs, null);
  const complete = createBusinessOutcomeCandidate(original, options);
  const unknown = createBusinessOutcomeCandidate({ ...input(), amount: null, currency: null, window: null, coverage: null, method: null, provenance: { observationId: null, sourceRefs: [], observedAt: null, aggregation: 'standalone' } }, options);
  for (const record of [complete, unknown, candidate({ amount: '-0.000001' }), candidate({ amount: '0' })]) {
    const decoded = JSON.parse(JSON.stringify(record));
    assert.deepEqual(validateBusinessOutcomeCandidate(decoded, options), record);
    assert.deepEqual(assessBusinessOutcomeCandidate(decoded, options), assessBusinessOutcomeCandidate(record, options));
    assert.deepEqual(aggregate([decoded], proof([record])), aggregate([record], proof([record])));
  }
});

test('renamed IDs cannot make the same measurement digest or exact measurement report count twice', () => {
  const firstInput = input(), first = createBusinessOutcomeCandidate(firstInput, options);
  const renamed = input({ experimentId: 'experiment_renamed', observationId: 'observation_renamed', scopeId: 'population_renamed' });
  renamed.source.measurementDigest = first.source.measurementDigest;
  renamed.verification.measurementDigest = first.source.measurementDigest;
  let result = aggregate([first, createBusinessOutcomeCandidate(renamed, options)]);
  assert.deepEqual(result.groups, []); assert.equal(result.counts.qualifiedOutcomes, 0);
  assert.ok(code(result).includes('DUPLICATE_MEASUREMENT'));
  const reused = input({ experimentId: 'experiment_report_copy', observationId: 'observation_report_copy', scopeId: 'population_report_copy' });
  reused.provenance.sourceRefs = [{ ...first.provenance.sourceRefs[0], id: 'renamed_report_same_bytes' }];
  result = aggregate([first, createBusinessOutcomeCandidate(reused, options)]);
  assert.deepEqual(result.groups, []); assert.ok(code(result).includes('REUSED_MEASUREMENT_REPORT'));
});

test('a shared ledger snapshot can support separately identified disjoint attested measurements', () => {
  const a = input(), b = input({ experimentId: 'experiment_disjoint', observationId: 'observation_disjoint', scopeId: 'population_disjoint' });
  const ledger = { type: 'ledger_snapshot', id: 'shared_ledger', digest: H('f') };
  a.provenance.sourceRefs = [ledger]; b.provenance.sourceRefs = [ledger];
  const one = createBusinessOutcomeCandidate(a, options), two = createBusinessOutcomeCandidate(b, options);
  assert.notEqual(one.source.measurementDigest, two.source.measurementDigest);
  const summary = aggregate([one, two]);
  assert.equal(summary.groups.length, 1); assert.equal(summary.groups[0].measuredCount, 2);
  assert.equal(summary.groups[0].amount, '20');
});

test('zero population cannot establish nonzero contribution, but exact zero and unknown remain distinct', () => {
  for (const amount of ['10', '-1', '0.000001']) {
    const record = input({ amount }); record.coverage.observedCount = 0; record.coverage.expectedCount = 0;
    assert.throws(() => createBusinessOutcomeCandidate(record, options), { code: 'OUTCOME_INVALID' });
  }
  for (const amount of ['0', null]) {
    const record = input({ amount }); record.coverage.observedCount = 0; record.coverage.expectedCount = 0;
    const row = createBusinessOutcomeCandidate(record, options);
    assert.equal(row.amount, amount); assert.equal(assessBusinessOutcomeCandidate(row, options).measurementComplete, amount === '0');
  }
});

test('ordinary correction cannot reinstate a withdrawn outcome', () => {
  const first = candidate();
  const withdrawn = withdrawBusinessOutcomeCandidate(first, { reason: 'evidence_retracted', verification: { ...first.verification, verifiedAt: '2026-10-06T15:00:00.000Z' } }, options);
  const replacement = input({ amount: '12' });
  replacement.source.measurementRevision = 2; replacement.source.measurementDigest = H('d');
  replacement.verification.measurementDigest = H('d'); replacement.verification.verifiedAt = '2026-10-06T16:00:00.000Z';
  assert.throws(() => correctBusinessOutcomeCandidate(withdrawn, replacement, options), error => error.code === 'OUTCOME_WITHDRAWN' && error.status === 409);
  assert.equal(aggregate([first, withdrawn], proof([withdrawn])).groups.length, 0);
});

test('locally inconsistent predecessor identities fail even when a successor current digest is recomputed', () => {
  const canonicalJson = value => Array.isArray(value) ? '[' + value.map(canonicalJson).join(',') + ']'
    : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}' : JSON.stringify(value);
  const digestValue = value => fixtureDigest(canonicalJson(value));
  const rehash = candidate => {
    const { digest: _digest, versionId: _versionId, ...body } = candidate;
    const digest = digestValue(body);
    return { ...body, digest, versionId: `outcome_version_${digestValue([body.outcomeId, body.revision, digest])}` };
  };
  const previous = candidate(), nextInput = input({ amount: '11' });
  nextInput.source.measurementRevision = 2; nextInput.source.measurementDigest = H('d'); nextInput.verification.measurementDigest = H('d');
  const correction = correctBusinessOutcomeCandidate(previous, nextInput, options);
  assert.equal(correction.lineage.previousVersionId, `outcome_version_${digestValue([correction.outcomeId, correction.lineage.previousRevision, correction.lineage.previousDigest])}`);
  const unrelated = candidate({ experimentId: 'experiment_unrelated', observationId: 'observation_unrelated', scopeId: 'population_unrelated' });
  for (const lineage of [
    { ...correction.lineage, previousVersionId: `outcome_version_${H('f')}` },
    { ...correction.lineage, previousDigest: H('e') },
    { ...correction.lineage, previousVersionId: unrelated.versionId, previousDigest: unrelated.digest }
  ]) {
    const forged = rehash({ ...correction, lineage });
    assert.throws(() => validateBusinessOutcomeCandidate(forged, options), { code: 'OUTCOME_INTEGRITY_FAILED' });
    assert.equal(aggregate([forged], proof([forged])).groups.length, 0);
  }
});

test('publication DTO validator checks head/version integrity without creating database authority or a branded boundary', () => {
  const row = candidate(), original = freeze({ head: head(row), version: row });
  const validated = validateBusinessOutcomePublication(original, options);
  assert.deepEqual(validated, original);
  assert.notEqual(validated, original); assert.notEqual(validated.version, original.version);
  validated.version.coverage.scopeId = 'changed-detached-copy';
  assert.equal(original.version.coverage.scopeId, row.coverage.scopeId);
  assert.throws(() => aggregateBusinessOutcomes([row], { ...options, publicationBoundary: validateBusinessOutcomePublication(original, options) }), { code: 'PUBLICATION_PROOF_REQUIRED' });
  for (const patch of [{ digest: H('f') }, { versionId: `outcome_version_${H('f')}` }, { revision: 2 }, { committedAt: '2026-10-07T00:00:00.000Z' }]) {
    assert.throws(() => validateBusinessOutcomePublication({ head: head(row, patch), version: row }, options), { code: 'PUBLICATION_PROOF_INVALID' });
  }
  assert.throws(() => validateBusinessOutcomePublication({ head: head(row, { workspaceId: 'tenant-b' }), version: row }, options), { code: 'WORKSPACE_MISMATCH' });
  let reads = 0;
  const accessorHead = { ...head(row) }; Object.defineProperty(accessorHead, 'outcomeId', { enumerable: true, get() { reads++; return row.outcomeId; } });
  assert.throws(() => validateBusinessOutcomePublication({ head: accessorHead, version: row }, options), { code: 'OUTCOME_INVALID' });
  assert.equal(reads, 0);
});

test('versioned 162-code currency contract is frozen and independent of host Intl/ICU catalogs', t => {
  assert.equal(BUSINESS_OUTCOME_CURRENCY_CONTRACT_VERSION, 'runvara-supported-currencies/v1');
  assert.equal(BUSINESS_OUTCOME_CURRENCIES.length, 162);
  assert.equal(fixtureDigest(JSON.stringify(BUSINESS_OUTCOME_CURRENCIES)), 'ccb0af3a40271f3ee04570be1e702e397e76e20f91fdf1e8668419e379dff920', 'The v1 application-supported currency list must match the SQL contract exactly');
  assert.equal(new Set(BUSINESS_OUTCOME_CURRENCIES).size, 162);
  assert.ok(BUSINESS_OUTCOME_CURRENCIES.every(code => /^[A-Z]{3}$/.test(code)));
  assert.equal(Object.isFrozen(BUSINESS_OUTCOME_CURRENCIES), true);
  t.mock.method(Intl, 'supportedValuesOf', () => { throw new Error('Host ICU is not the supported-currency contract'); });
  for (const currency of BUSINESS_OUTCOME_CURRENCIES) assert.equal(candidate({ currency }).currency, currency);
  for (const currency of ['ZZZ', 'XXX', 'gbp', 826]) assert.throws(() => candidate({ currency }), { code: 'OUTCOME_INVALID' });
  assert.equal(candidate({ currency: null }).currency, null);
});
