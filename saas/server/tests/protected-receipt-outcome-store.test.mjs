import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessOutcomePersistence, publicBusinessOutcomeReview, publicBusinessOutcomeEvidence,
  selectedProtectedReceiptEvidence, outcomeContentSourceReadOptions } from '../lib/business-outcome-store.mjs';
import { prepareExperimentOutcomeMeasurement, digestMeasurementValue } from '../lib/experiment-measurements.mjs';
import { createBusinessOutcomeCandidate } from '../lib/business-outcomes.mjs';
import { resolveProtectedReceiptEvidence } from '../lib/protected-receipt-source.mjs';
import { protectedReceiptFixture } from './protected-receipt-source-fixture.mjs';

const WS = 'tenant-a', EXP = 'experiment_receipt', NOW = '2026-10-08T15:00:00.000Z';
const actor = { id: 'reviewer_owner', sessionVersion: 4 };
const PRIVATE_KEYS = ['admission', 'authorityDigest', 'actorSessionVersion', 'claimIdentity', 'claimId', 'stableApproval', 'proposal', 'requestId', 'dispatchRequestDigest'];
const databaseError = databaseCode => Object.assign(new Error('private database details'), { databaseCode });
const baseReview = () => ({ workspaceId: WS, workspaceRevision: '22222222-2222-3333-4444-555555555555',
  experiment: { id: EXP, title: 'Review exact completion', status: 'measured' }, measurement: null, current: null,
  actionLinkContract: 'runvara-reviewed-action/v2', actionChoices: [], currentActionAssociation: null });
const envelope = () => ({ schema: 'runvara-outcome-content-source-reader/v1', review: baseReview(), receiptChoices: [], nextCursor: null, hasMore: false, selectedEvidence: null });
const service = request => createBusinessOutcomePersistence({ request, now: () => new Date(NOW) });
function choice(f) {
  const { source, receiptSource } = resolveProtectedReceiptEvidence(f.evidence, { workspaceId: WS });
  return { receiptSource, actionId: source.context.writeId, account: source.context.account, productId: source.input.productId,
    title: source.input.title, completedAt: source.context.completedAt, origin: source.context.origin, originatingObjective: source.context.originatingObjective };
}
function measurement(f) {
  return prepareExperimentOutcomeMeasurement({ expectedRevision: 0, amount: '10', currency: 'GBP',
    window: { startsAt: '2026-10-06T00:00:00.000Z', endsAt: '2026-10-07T00:00:00.000Z' },
    coverage: { status: 'complete', observedCount: 2, expectedCount: 2 }, method: { kind: 'reconciled_manual' },
    observedAt: '2026-10-07T12:00:00.000Z', report: { description: 'Recorded revenue less all variable costs.', costsComplete: true },
    actionSelection: { receipt: f.selector } }, { workspaceId: WS, experimentId: EXP, actorId: actor.id, now: NOW, receiptEvidence: f.evidence });
}
function versionRow(f) {
  const m = measurement(f), version = createBusinessOutcomeCandidate({ source: { type: 'experiment_measurement', experimentId: EXP,
    measurementRevision: m.revision, measurementDigest: m.digest },
    ...Object.fromEntries(['metric', 'amount', 'currency', 'window', 'coverage', 'method', 'provenance', 'links'].map(key => [key, m[key]])),
    verification: { kind: 'owner_attestation', actorId: actor.id, verifiedAt: NOW, measurementDigest: m.digest } }, { workspaceId: WS, now: NOW });
  return { workspace_id: WS, outcome_id: version.outcomeId, revision: version.revision, version_id: version.versionId, digest: version.digest,
    status: version.status, payload: version, publication_id: 'receipt_publication', intent_digest: 'c'.repeat(64), committed_at: NOW,
    commit_revision: '33333333-2222-3333-4444-555555555555', source_measurement: m, source_action: f.source };
}

test('authenticated ordinary review replaces the old read with one combined bounded RPC', async () => {
  let reads = 0;
  const result = await service(async (path, options) => {
    reads++; assert.equal(path, 'rpc/runvara_read_outcome_content_sources'); assert.equal(options.maxResponseBytes, 128 * 1024);
    assert.deepEqual(JSON.parse(options.body), { p_workspace_id: WS, p_experiment_id: EXP, p_actor_id: actor.id,
      p_actor_session_version: 4, p_receipt_selector: null, p_after_attempt_id: null, p_resolve_saved_source: true });
    return envelope();
  }).review(WS, EXP, actor);
  assert.equal(reads, 1); assert.equal(result.receiptLinkContract, 'runvara-protected-content-source/v1');
  assert.deepEqual(result.receiptChoices, []); assert.equal(result.selectedReceiptSource, null);
});

test('only an unambiguous missing RPC gets one legacy fallback, never a stack of retries', async () => {
  let calls = [];
  const result = await service(async path => { calls.push(path); if (calls.length === 1) throw databaseError('PGRST202'); return baseReview(); }).review(WS, EXP, actor);
  assert.equal(result.receiptLinkContract, undefined); assert.deepEqual(calls, ['rpc/runvara_read_outcome_content_sources', 'rpc/runvara_read_business_outcome_review']);
  calls = [];
  await assert.rejects(service(async path => { calls.push(path); throw databaseError('PGRST202'); }).review(WS, EXP, actor), { code: 'OUTCOME_STORAGE_UNAVAILABLE' });
  assert.equal(calls.length, 2);
  for (const code of ['42883', '42501', '57014', '42P01', 'P0O03']) {
    let count = 0;
    await assert.rejects(service(async () => { count++; throw databaseError(code); }).review(WS, EXP, actor));
    assert.equal(count, 1, `No fallback for ${code}`);
  }
});

test('explicit protected requests and protected reuse never fall back; latent v4 is rejected by the old parser', async () => {
  const f = protectedReceiptFixture();
  for (const options of [{ receipt: f.selector }, { afterAttemptId: f.selector.attemptId }, { requireReceiptContract: true }]) {
    let calls = 0;
    await assert.rejects(service(async () => { calls++; throw databaseError('PGRST202'); }).review(WS, EXP, actor, options));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(service(async () => { if (++calls === 1) throw databaseError('PGRST202'); return { ...baseReview(), measurement: measurement(f) }; })
    .review(WS, EXP, actor), { code: 'OUTCOME_REVIEW_INVALID' });
  assert.equal(calls, 2);
  await assert.rejects(service(async () => ({ ...baseReview(), measurement: measurement(f) })).review(WS, EXP), { code: 'OUTCOME_REVIEW_INVALID' });
});

test('private selected evidence stays outside enumerable review and HTTP projection for manual receipts', async () => {
  const f = protectedReceiptFixture(), result = envelope(); result.receiptChoices = [choice(f)]; result.selectedEvidence = f.evidence;
  let calls = 0;
  const review = await service(async () => { calls++; return result; }).review(WS, EXP, actor, { receipt: f.selector });
  assert.equal(calls, 1); assert.deepEqual(selectedProtectedReceiptEvidence(review), f.evidence);
  assert.equal(review.selectedReceiptSource.schema, 'runvara-protected-content-source-display/v1');
  assert.deepEqual(review.selectedReceiptSource.receiptSource, choice(f).receiptSource);
  assert.equal(review.selectedReceiptSource.input.description, f.source.input.description);
  assert.equal(review.selectedReceiptSource.validation.protection, 'completion_workspace_commit');
  for (const key of PRIVATE_KEYS) assert.equal(JSON.stringify(review).includes(`"${key}"`), false, key);
  const publicView = publicBusinessOutcomeReview({ ...review, selectedEvidence: f.evidence, privateRaw: f.evidence });
  for (const key of PRIVATE_KEYS) assert.equal(JSON.stringify(publicView).includes(`"${key}"`), false, key);
  assert.equal(selectedProtectedReceiptEvidence(structuredClone(review)), null);
});

test('saved nonreuse v4 resolves the same exact reference while explicit preview can be outside the page', async () => {
  const f = protectedReceiptFixture(), saved = envelope(); saved.review.measurement = measurement(f); saved.selectedEvidence = f.evidence;
  const result = await service(async () => saved).review(WS, EXP, actor);
  assert.equal(result.selectedReceiptSource.receiptSource.receiptDigest, f.selector.receiptDigest);
  assert.deepEqual(result.receiptChoices, []);
  const outside = envelope(); outside.selectedEvidence = f.evidence;
  assert.equal((await service(async () => outside).review(WS, EXP, actor, { receipt: f.selector })).selectedReceiptSource.action.digest, f.source.digest);
  for (const change of [value => { value.selectedEvidence = null; }, value => { value.selectedEvidence.commitRevision = '44444444-2222-3333-4444-555555555555'; },
    value => { value.selectedEvidence.receipt.source.input.description = 'edited'; }]) {
    const changed = structuredClone(saved); change(changed);
    await assert.rejects(service(async () => changed).review(WS, EXP, actor), { code: 'OUTCOME_REVIEW_INVALID' });
  }
});

test('reader rejects missing/unknown private contracts, mismatches, overages and altered choice projections without fallback', async () => {
  const f = protectedReceiptFixture(), base = envelope(); base.receiptChoices = [choice(f)]; base.selectedEvidence = f.evidence;
  for (const change of [r => { r.schema = 'runvara-outcome-content-source-reader/v2'; }, r => { r.extra = 'private'; },
    r => { delete r.selectedEvidence; }, r => { r.selectedEvidence.schema = 'future'; }, r => { r.selectedEvidence.admission.actorSessionVersion++; },
    r => { r.selectedEvidence.receipt.digest = 'a'.repeat(64); }, r => { r.receiptChoices[0].title = 'Not the observed input'; },
    r => { r.receiptChoices[0].receiptSource.workspaceId = 'foreign'; }, r => { r.receiptChoices[0].raw = f.evidence; },
    r => { r.receiptChoices = Array(21).fill(choice(f)); }, r => { r.selectedEvidence.receipt.source.input.description = 'x'.repeat(43 * 1024); }]) {
    const input = structuredClone(base); change(input); let calls = 0;
    await assert.rejects(service(async () => { calls++; return input; }).review(WS, EXP, actor, { receipt: f.selector }), { code: 'OUTCOME_REVIEW_INVALID' });
    assert.equal(calls, 1);
  }
});

test('explicit pages validate strict immutable ordering and exact continuation without selected evidence', async () => {
  const f = protectedReceiptFixture(), first = choice(f), second = structuredClone(first);
  first.receiptSource.attemptId = 'content_attempt_' + '1'.repeat(64); second.receiptSource.attemptId = 'content_attempt_' + '2'.repeat(64);
  const page = envelope(); page.receiptChoices = [first, second]; page.hasMore = true; page.nextCursor = second.receiptSource.attemptId;
  assert.equal((await service(async () => page).review(WS, EXP, actor)).hasMoreReceipts, true);
  const after = envelope(); after.receiptChoices = [second];
  assert.deepEqual((await service(async () => after).review(WS, EXP, actor, { afterAttemptId: first.receiptSource.attemptId })).receiptChoices, [second]);
  for (const change of [r => { r.receiptChoices.reverse(); }, r => { r.receiptChoices[1] = r.receiptChoices[0]; },
    r => { r.nextCursor = first.receiptSource.attemptId; }, r => { r.receiptChoices = []; }, r => { r.hasMore = false; }]) {
    const changed = structuredClone(page); change(changed);
    await assert.rejects(service(async () => changed).review(WS, EXP, actor), { code: 'OUTCOME_REVIEW_INVALID' });
  }
  await assert.rejects(service(async () => after).review(WS, EXP, actor, { afterAttemptId: second.receiptSource.attemptId }), { code: 'OUTCOME_REVIEW_INVALID' });
});

test('HTTP source-read DTO accepts only cursor or exact receipt selector and cannot request authority', () => {
  const f = protectedReceiptFixture();
  assert.deepEqual(outcomeContentSourceReadOptions({ receipt: f.selector, afterAttemptId: null }), { receipt: f.selector, afterAttemptId: null });
  for (const bad of [{ receipt: f.selector, afterAttemptId: f.selector.attemptId }, { workspaceId: WS }, { actorId: actor.id },
    { requireReceiptContract: true }, { resolveSavedSource: false }, { afterAttemptId: 'bad' }, { receipt: { ...f.selector, commitRevision: 'ignored' } }]) assert.throws(() => outcomeContentSourceReadOptions(bad));
});

test('protected choice bytes remain bounded separately from legacy choices and total response bytes', async () => {
  const f = protectedReceiptFixture(), result = envelope();
  result.receiptChoices = Array.from({ length: 20 }, (_, index) => ({ ...choice(f), actionId: 'w'.repeat(160),
    account: 'a'.repeat(239) + '.myshopify.com', productId: 'gid://shopify/Product/' + '1'.repeat(138), title: 't'.repeat(200),
    receiptSource: { ...choice(f).receiptSource, attemptId: 'content_attempt_' + index.toString(16).padStart(64, '0') } }));
  assert.ok(Buffer.byteLength(JSON.stringify(result.receiptChoices)) > 16384);
  await assert.rejects(service(async () => result).review(WS, EXP, actor), { code: 'OUTCOME_REVIEW_INVALID' });
  await assert.rejects(service(async () => ({ ...envelope(), padding: 'x'.repeat(128 * 1024) })).review(WS, EXP, actor), { code: 'OUTCOME_RESPONSE_TOO_LARGE' });
});

test('trusted compatibility-only draft reads must omit prior draft evidence and cannot be requested through HTTP options', async () => {
  let calls = 0;
  const result = await service(async (_path, options) => {
    calls++; assert.equal(JSON.parse(options.body).p_resolve_saved_source, false); return envelope();
  }).review(WS, EXP, actor, { resolveSavedSource: false });
  assert.equal(calls, 1); assert.equal(result.measurement, null); assert.equal(result.selectedReceiptSource, null);
  const saved = envelope(); saved.review.measurement = measurement(protectedReceiptFixture());
  await assert.rejects(service(async () => saved).review(WS, EXP, actor, { resolveSavedSource: false }), { code: 'OUTCOME_REVIEW_INVALID' });
});

test('exact immutable protected evidence needs one existing version read and uses safe manual display', async () => {
  const f = protectedReceiptFixture(), row = versionRow(f); let calls = 0;
  const result = await service(async path => { calls++; assert.match(path, /^runvara_business_outcome_versions\?/); assert.match(path, /source_measurement,source_action&limit=2$/); return [row]; }).evidence(WS, row.version_id);
  assert.equal(calls, 1); assert.deepEqual(result.sourceAction, f.source); assert.deepEqual(result.sourceMeasurement.receiptSource, choice(f).receiptSource);
  const view = publicBusinessOutcomeEvidence(result, { workspaceId: WS });
  assert.equal(view.sourceAction.schema, 'runvara-protected-content-source-display/v1');
  for (const key of PRIVATE_KEYS) assert.equal(JSON.stringify(view).includes(`"${key}"`), false, key);
  const forged = structuredClone(result); forged.sourceMeasurement.receiptSource.receiptDigest = 'f'.repeat(64);
  assert.throws(() => publicBusinessOutcomeEvidence(forged, { workspaceId: WS }));
});

test('immutable source/ref substitutions fail before evidence can be exposed or reused', async () => {
  const f = protectedReceiptFixture(), row = versionRow(f);
  for (const change of [r => { r.source_action.input.title = 'substitute'; }, r => { r.source_measurement.receiptSource.sourceDigest = 'a'.repeat(64); },
    r => { r.source_measurement.receiptSource.commitRevision = '44444444-2222-3333-4444-555555555555'; }, r => { r.source_action = null; }]) {
    const changed = structuredClone(row); change(changed);
    await assert.rejects(service(async () => [changed]).evidence(WS, row.version_id), { code: 'OUTCOME_SOURCE_INVALID' });
  }
  assert.equal(digestMeasurementValue(row.source_action), digestMeasurementValue(f.source));
});
