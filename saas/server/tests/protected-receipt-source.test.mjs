import test from 'node:test';
import assert from 'node:assert/strict';
import { protectedReceiptFixture } from './protected-receipt-source-fixture.mjs';
import { objectivePublicationFixture } from './objective-publication-fixture.mjs';
import { canonicalReviewedActionJson, digestReviewedActionValue, actionIntervention,
  validateActionSelection, REVIEWED_ACTION_MAX_BYTES } from '../lib/reviewed-action-evidence.mjs';
import { resolveProtectedReceiptEvidence, validateProtectedReceiptSource, validateProtectedReceiptChoice,
  validateProtectedReceiptSelector, publicProtectedReceiptSource, PROTECTED_RECEIPT_DISPLAY_MAX_BYTES,
  PROTECTED_RECEIPT_PRIVATE_MAX_BYTES } from '../lib/protected-receipt-source.mjs';
import { contentReceiptJsonbBytes } from '../lib/content-execution-receipt.mjs';
import { prepareExperimentOutcomeMeasurement, validateExperimentOutcomeMeasurement,
  assessExperimentOutcomeMeasurement, digestMeasurementValue } from '../lib/experiment-measurements.mjs';

const context = { workspaceId: 'tenant-a', experimentId: 'experiment_receipt', actorId: 'different_current_admin', now: '2026-10-06T20:00:00.000Z' };
const validation = (c = context) => ({ workspaceId: c.workspaceId, experimentId: c.experimentId, now: c.now });
const input = (patch = {}) => ({ expectedRevision: 0, report: { description: 'Recorded protected content association', costsComplete: null }, ...patch });
const prepare = (f, body = {}, c = context) => prepareExperimentOutcomeMeasurement(input({ actionSelection: { receipt: f.selector }, ...body }), { ...c, receiptEvidence: f.evidence });
const resign = object => { object.digest = digestReviewedActionValue(Object.fromEntries(Object.entries(object).filter(([key]) => key !== 'digest'))); };
function resignMeasurement(m) {
  m.report.digest = digestMeasurementValue(Object.fromEntries(Object.entries(m.report).filter(([key]) => key !== 'digest')));
  m.provenance.sourceRefs[0].digest = m.report.digest;
  m.digest = digestMeasurementValue(Object.fromEntries(Object.entries(m).filter(([key]) => key !== 'digest')));
}
const choiceOf = (source, receiptSource) => ({ receiptSource, actionId: source.context.writeId, account: source.context.account,
  productId: source.input.productId, title: source.input.title, completedAt: source.context.completedAt,
  origin: source.context.origin, originatingObjective: source.context.originatingObjective });

test('receipt selection is exact, bounded, detached and contains no selectable authority', () => {
  const f = protectedReceiptFixture(), selection = { receipt: f.selector };
  assert.deepEqual(validateActionSelection(selection), selection);
  assert.ok(Buffer.byteLength(canonicalReviewedActionJson(f.selector)) <= 512);
  for (const malformed of [null, {}, { ...f.selector, actorId: 'owner' }, { ...f.selector, commitRevision: f.evidence.commitRevision },
    { ...f.selector, attemptId: f.selector.attemptId.toUpperCase() }, { ...f.selector, receiptDigest: 'a'.repeat(63) },
    { ...f.selector, sourceDigest: 'A'.repeat(64) }, { ...f.selector, sourceDigest: undefined }]) assert.throws(() => validateProtectedReceiptSelector(malformed));
  for (const malformed of [{ ...selection, actionId: f.write.id }, { ...selection, reuseVersionId: 'outcome_version_' + '1'.repeat(64) },
    { ...selection, workspaceId: 'tenant-a' }, { ...selection, source: f.source }]) assert.throws(() => validateActionSelection(malformed));
  const checked = validateActionSelection(selection); checked.receipt.sourceDigest = '0'.repeat(64);
  assert.notEqual(checked.receipt.sourceDigest, f.selector.sourceDigest);
  let reads = 0;
  const getter = Object.defineProperty({}, 'receipt', { enumerable: true, get() { reads++; return f.selector; } });
  assert.throws(() => validateActionSelection(getter)); assert.equal(reads, 0);
});

test('exact receipt resolves without optional context or current approval/connection history and preserves source bytes', () => {
  const f = protectedReceiptFixture(), before = canonicalReviewedActionJson(f.source);
  delete f.write.recordedActionContext; f.approval.status = 'rejected'; f.state.connections = [];
  const resolved = resolveProtectedReceiptEvidence(f.evidence, { workspaceId: context.workspaceId, selector: f.selector });
  assert.equal(canonicalReviewedActionJson(resolved.source), before);
  assert.equal(resolved.receiptSource.sourceDigest, f.source.digest);
  assert.equal(resolved.receiptSource.commitRevision, f.evidence.commitRevision);
  assert.equal(resolved.receiptSource.workspaceId, context.workspaceId);
  assert.equal(resolved.source.context.originatingObjective, null);
  assert.deepEqual(validateProtectedReceiptChoice(choiceOf(resolved.source, resolved.receiptSource), { workspaceId: context.workspaceId }), choiceOf(resolved.source, resolved.receiptSource));
  assert.throws(() => resolveProtectedReceiptEvidence(f.evidence, { workspaceId: 'other' }), { code: 'OUTCOME_RECEIPT_INVALID' });
  assert.ok(contentReceiptJsonbBytes(f.evidence) < PROTECTED_RECEIPT_PRIVATE_MAX_BYTES);
});

test('source, admission, selector, observation and reference mismatches fail with fixed errors', () => {
  const f = protectedReceiptFixture();
  const changes = [e => { e.schema = 'unknown'; }, e => { delete e.receipt; }, e => { e.receipt.observation = 'uncertain'; },
    e => { e.receipt.source.input.description = 'tampered'; }, e => { e.receipt.attemptId = 'content_attempt_' + '0'.repeat(64); resign(e.receipt); },
    e => { e.admission.actorId = 'other_executor'; resign(e.admission); e.receipt.admissionDigest = e.admission.digest; resign(e.receipt); },
    e => { e.receipt.intentDigest = '0'.repeat(64); resign(e.receipt); }, e => { e.admission.workspaceId = 'other'; resign(e.admission); },
    e => { e.commitRevision = null; }, e => { e.commitRevision = 'not-a-primary-revision'; }, e => { e.extra = 'unexpected'; }];
  for (const change of changes) {
    const changed = structuredClone(f.evidence); change(changed);
    assert.throws(() => resolveProtectedReceiptEvidence(changed, { workspaceId: context.workspaceId }), { code: 'OUTCOME_RECEIPT_INVALID' });
  }
  for (const key of ['attemptId', 'receiptDigest', 'sourceDigest']) {
    const selector = { ...f.selector, [key]: key === 'attemptId' ? 'content_attempt_' + '0'.repeat(64) : '0'.repeat(64) };
    assert.throws(() => resolveProtectedReceiptEvidence(f.evidence, { workspaceId: context.workspaceId, selector }), { code: 'OUTCOME_RECEIPT_INVALID' });
  }
  const { receiptSource } = resolveProtectedReceiptEvidence(f.evidence, { workspaceId: context.workspaceId });
  assert.throws(() => validateProtectedReceiptSource({ ...receiptSource, sourceDigest: '0'.repeat(64) }, { workspaceId: context.workspaceId, sourceDigest: f.source.digest }), { code: 'OUTCOME_RECEIPT_INVALID' });
  assert.throws(() => validateProtectedReceiptSource({ ...receiptSource, committedAt: context.now }, { workspaceId: context.workspaceId }), { code: 'OUTCOME_RECEIPT_INVALID' });
  let reads = 0; const computed = structuredClone(f.evidence);
  Object.defineProperty(computed.receipt.source.context, 'claimId', { enumerable: true, get() { reads++; return 'claim'; } });
  assert.throws(() => resolveProtectedReceiptEvidence(computed, { workspaceId: context.workspaceId })); assert.equal(reads, 0);
});

test('v4 binds both receipt reference copies while retaining manual intervention, null objective and qualification', () => {
  const f = protectedReceiptFixture(), m = prepare(f);
  assert.equal(m.schema, 'runvara-experiment-measurement/v4'); assert.equal(m.report.schema, 'runvara-measurement-report/v4');
  assert.equal(f.source.digest, '5077ebc422081cde90eb0e51c0f642e4841b3b5273524809c262797039ce9240');
  assert.equal(f.evidence.receipt.digest, '8357ef60161ff08af10eec5d3d78d760ae2ea23c4e0cbe481a4911e8484778e4');
  assert.equal(m.report.digest, 'acd6cf33247585866273a4fd35dc661f5eb0e2496da1e479105ac707d9d610a6');
  assert.equal(m.digest, '71f61feea52b4f6ef0699f663aa75d4756b1274830d2f440cebf6be3b00ae063');
  assert.deepEqual(m.intervention, actionIntervention(f.source));
  assert.deepEqual(m.report.facts.receiptSource, m.receiptSource);
  assert.equal(m.links.objective, null); assert.equal(m.intervention.originatingObjective, undefined);
  assert.deepEqual(validateExperimentOutcomeMeasurement(m, validation()), m);
  assert.equal(assessExperimentOutcomeMeasurement(m, validation()).readyForOwnerVerification, false);
  const text = JSON.stringify(m);
  for (const privateKey of ['admission', 'actorSessionVersion', 'authorityDigest', 'claimIdentity', 'description\\nSecond']) assert.equal(text.includes(privateKey), false);
  const checked = validateExperimentOutcomeMeasurement(m, validation()); checked.receiptSource.commitRevision = '0';
  assert.notEqual(checked.report.facts.receiptSource.commitRevision, '0');
  assert.throws(() => prepareExperimentOutcomeMeasurement(input({ actionSelection: { receipt: f.selector } }), { ...context, actionEvidence: f.source }), { code: 'MEASUREMENT_INVALID' });
  assert.throws(() => prepareExperimentOutcomeMeasurement(input({ actionSelection: { receipt: f.selector } }), { ...context, receiptSource: m.receiptSource }), { code: 'MEASUREMENT_INVALID' });
  assert.throws(() => prepareExperimentOutcomeMeasurement(input(), { ...context, receiptEvidence: f.evidence }), { code: 'MEASUREMENT_INVALID' });
  assert.throws(() => prepare(f, { expectedRevision: 1 }), { code: 'MEASUREMENT_CONFLICT' });
});

test('v4 rejects dropped, extra, foreign or unequal provenance even when both nested hashes are recomputed', () => {
  const f = protectedReceiptFixture(), m = prepare(f);
  for (const change of [x => { delete x.receiptSource; }, x => { delete x.report.facts.receiptSource; },
    x => { x.report.facts.receiptSource.receiptDigest = '0'.repeat(64); }, x => { x.receiptSource.sourceDigest = '0'.repeat(64); },
    x => { x.receiptSource.workspaceId = 'foreign'; }, x => { x.receiptSource.unverified = true; },
    x => { x.report.schema = 'runvara-measurement-report/v3'; }, x => { x.schema = 'runvara-experiment-measurement/v3'; },
    x => { x.schema = 'runvara-experiment-measurement/v5'; }, x => { x.links.objective = x.intervention.action; }]) {
    const altered = structuredClone(m); change(altered); resignMeasurement(altered);
    assert.throws(() => validateExperimentOutcomeMeasurement(altered, validation()));
  }
  for (const legacy of ['runvara-experiment-measurement/v1', 'runvara-experiment-measurement/v2', 'runvara-experiment-measurement/v3']) {
    const altered = structuredClone(m); altered.schema = legacy; resignMeasurement(altered);
    assert.throws(() => validateExperimentOutcomeMeasurement(altered, validation()));
  }
});

test('explicit protected reuse copies exact source and provenance without a receipt or current history lookup', () => {
  const f = protectedReceiptFixture(), first = prepare(f), reuseVersionId = 'outcome_version_' + 'e'.repeat(64);
  const originalSource = structuredClone(f.source), originalRef = structuredClone(first.receiptSource);
  f.state.approvals = []; f.state.connectionWrites = []; f.state.connections = [];
  const reused = prepareExperimentOutcomeMeasurement(input({ actionSelection: { reuseVersionId } }), {
    ...context, actionEvidence: originalSource, reuseVersionId, reuseSourceMeasurement: first });
  assert.equal(reused.schema, first.schema); assert.deepEqual(reused.receiptSource, originalRef);
  assert.equal(reused.intervention.reuseVersionId, reuseVersionId);
  assert.equal(reused.intervention.action.digest, originalSource.digest);
  assert.throws(() => prepareExperimentOutcomeMeasurement(input({ actionSelection: { reuseVersionId } }), {
    ...context, actionEvidence: originalSource, reuseVersionId, reuseSourceMeasurement: { ...first, experimentId: 'foreign' } }));
  const altered = structuredClone(first); altered.intervention.action.id = 'another_action'; resignMeasurement(altered);
  assert.throws(() => prepareExperimentOutcomeMeasurement(input({ actionSelection: { reuseVersionId } }), {
    ...context, actionEvidence: originalSource, reuseVersionId, reuseSourceMeasurement: altered }));
  assert.throws(() => prepareExperimentOutcomeMeasurement(input({ expectedRevision: 1 }), { ...context, previousMeasurement: first }), { code: 'MEASUREMENT_INVALID' });
  const removed = prepareExperimentOutcomeMeasurement(input({ expectedRevision: 1, actionSelection: null }), { ...context, previousMeasurement: first });
  assert.equal(removed.schema, 'runvara-experiment-measurement/v1'); assert.equal(removed.receiptSource, undefined);
});

test('protected manual projection never enters the legacy raw-source serializer', () => {
  const f = protectedReceiptFixture(), resolved = resolveProtectedReceiptEvidence(f.evidence, { workspaceId: context.workspaceId });
  const view = publicProtectedReceiptSource(resolved.source, { workspaceId: context.workspaceId, receiptSource: resolved.receiptSource });
  assert.equal(view.schema, 'runvara-protected-content-source-display/v1'); assert.equal(view.origin, 'owner_manual');
  assert.equal(view.originatingObjective, null); assert.deepEqual(view.input, f.source.input);
  assert.deepEqual(view.validation, { protection: 'completion_workspace_commit', currentStatus: 'not_checked', providerAuthentication: 'not_established', causalAttribution: 'not_established' });
  const text = JSON.stringify(view);
  for (const key of ['admission', 'requestId', 'claimId', 'claimIdentity', 'authorityDigest', 'actorSessionVersion', 'stableApproval', 'proposal', 'requestedBy', 'executedBy', 'payload']) assert.equal(text.includes('"' + key + '"'), false, key);
  assert.equal(view.completedAt, f.source.context.completedAt); assert.equal(view.committedAt, undefined);
  assert.ok(Buffer.byteLength(canonicalReviewedActionJson(view)) <= PROTECTED_RECEIPT_DISPLAY_MAX_BYTES);
});

test('protected objective receipt retains unchanged v2 source/intervention and safe origin projection', async () => {
  const actual = await objectivePublicationFixture(), f = protectedReceiptFixture({ fixture: actual });
  const c = { ...context, workspaceId: f.source.context.workspaceId, now: new Date(Date.now() + 1000).toISOString() };
  const original = canonicalReviewedActionJson(f.source), resolved = resolveProtectedReceiptEvidence(f.evidence, { workspaceId: c.workspaceId });
  const m = prepare(f, {}, c), view = publicProtectedReceiptSource(resolved.source, { workspaceId: c.workspaceId, receiptSource: resolved.receiptSource });
  assert.equal(canonicalReviewedActionJson(f.source), original); assert.equal(f.source.schema, 'runvara-reviewed-source-action/v2');
  assert.equal(m.intervention.schema, 'runvara-owner-action-association/v2'); assert.equal(m.links.objective, null);
  assert.deepEqual(m.intervention.originatingObjective, f.source.context.originatingObjective);
  assert.deepEqual(view.originatingObjective, m.intervention.originatingObjective);
  assert.equal(view.origin, 'owner_objective_content'); assert.equal(view.proposal, undefined); assert.equal(view.stableApproval, undefined);
  assert.deepEqual(validateProtectedReceiptChoice(choiceOf(resolved.source, resolved.receiptSource), { workspaceId: c.workspaceId }).originatingObjective, view.originatingObjective);
  assert.deepEqual(validateExperimentOutcomeMeasurement(m, validation(c)), m);
});

test('maximum source bytes remain exact and receipt references count twice toward the unchanged 8 KiB envelope bound', () => {
  const base = protectedReceiptFixture({ description: '' }), available = REVIEWED_ACTION_MAX_BYTES - Buffer.byteLength(canonicalReviewedActionJson(base.source));
  const description = '\u0001'.repeat(Math.floor(available / 6)) + 'x'.repeat(available % 6);
  const f = protectedReceiptFixture({ description }), resolved = resolveProtectedReceiptEvidence(f.evidence, { workspaceId: context.workspaceId });
  assert.equal(Buffer.byteLength(canonicalReviewedActionJson(resolved.source)), REVIEWED_ACTION_MAX_BYTES);
  assert.equal(publicProtectedReceiptSource(resolved.source, { workspaceId: context.workspaceId, receiptSource: resolved.receiptSource }).input.description, description);
  assert.throws(() => protectedReceiptFixture({ description: description + 'x' }), { code: 'OUTCOME_ACTION_TOO_LARGE' });
  let exact;
  for (let count = 1; count <= 256 && !exact; count++) {
    const workspaceId = '界'.repeat(count), candidate = protectedReceiptFixture({ workspaceId });
    let m;
    try { m = prepare(candidate, { report: { description: 'x' } }, { ...context, workspaceId }); } catch { continue; }
    const gap = 8192 - Buffer.byteLength(JSON.stringify(m));
    if (gap >= 0 && gap < 1000) exact = { candidate, workspaceId, report: { description: 'x'.repeat(gap + 1) } };
  }
  assert.ok(exact, 'fixture reaches the exact application boundary');
  const atLimit = prepare(exact.candidate, { report: exact.report }, { ...context, workspaceId: exact.workspaceId });
  assert.equal(Buffer.byteLength(JSON.stringify(atLimit)), 8192); assert.ok(contentReceiptJsonbBytes(atLimit) <= 12288);
  assert.throws(() => prepare(exact.candidate, { report: { description: exact.report.description + 'x' } }, { ...context, workspaceId: exact.workspaceId }), { code: 'MEASUREMENT_TOO_LARGE' });
});
