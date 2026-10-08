import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BASE, REVIEW, MEASURE, EXPERIMENT, measurementInput, fixture, sqlError } from './business-outcomes-api-fixture.mjs';
import { protectedReceiptFixture } from './protected-receipt-source-fixture.mjs';
import { objectivePublicationFixture } from './objective-publication-fixture.mjs';

const SOURCES = `${REVIEW}/content-sources`;
const PRIVATE_KEYS = ['admission', 'authorityDigest', 'actorSessionVersion', 'claimIdentity', 'claimId', 'stableApproval', 'proposal', 'requestId', 'dispatchRequestDigest'];
const rawFree = value => { for (const key of PRIVATE_KEYS) assert.equal(JSON.stringify(value).includes(`"${key}"`), false, key); };
async function setup(t, options = {}) {
  const p = options.receipt ?? protectedReceiptFixture({ workspaceId: 'outcome-alpha' });
  const f = await fixture(t, { measured: false, linkedContract: 'runvara-reviewed-action/v2', protectedSources: [p.evidence], ...options });
  return { ...f, p };
}
const saveBody = (p, revision = 0) => ({ ...measurementInput(revision), actionSelection: { receipt: p.selector } });

test('owner/admin exact protected save needs one combined read and stores only immutable references', async t => {
  for (const role of ['owner', 'admin']) {
    const f = await setup(t), state = f.states.get('outcome-alpha');
    delete state.connectionWrites; delete state.approvals; delete state.connections;
    const saved = await f.request(MEASURE, { method: 'PUT', body: saveBody(f.p), identity: f.auth('outcome-alpha', role) });
    assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.measurement.schema, 'runvara-experiment-measurement/v4');
    assert.deepEqual(saved.body.measurement.receiptSource, saved.body.measurement.report.facts.receiptSource);
    assert.equal(saved.body.measurement.intervention.action.digest, f.p.source.digest);
    assert.equal(saved.body.measurement.receiptSource.receiptDigest, f.p.selector.receiptDigest);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, 'rpc/runvara_read_outcome_content_sources');
    const params = JSON.parse(f.calls[0].options.body); assert.deepEqual(params.p_receipt_selector, f.p.selector);
    assert.equal(params.p_actor_id, role === 'admin' ? 'outcome-alpha-admin' : state.users[0].id);
    assert.equal(f.counts.saves, 1); assert.equal(f.counts.providerCalls, 0); assert.equal(f.rows.size, 0);
    rawFree(saved.body); rawFree(f.states.get('outcome-alpha').revenueEngine.experiments[0].outcomeMeasurement);
    assert.equal(JSON.stringify(saved.body).includes(f.p.source.input.description), false);
  }
});

test('initial saved-draft review and explicit preview/page each use one read with safe display only', async t => {
  const f = await setup(t);
  const initial = await f.request(REVIEW); assert.equal(initial.status, 200); assert.equal(initial.body.receiptChoices.length, 1);
  assert.equal(initial.body.selectedReceiptSource, null); assert.equal(f.calls.length, 1); rawFree(initial.body);
  const preview = await f.request(SOURCES, { method: 'POST', body: { receipt: f.p.selector, afterAttemptId: null } });
  assert.equal(preview.status, 200, JSON.stringify(preview.body)); assert.equal(f.calls.length, 2);
  assert.equal(preview.body.selectedReceiptSource.input.description, f.p.source.input.description); rawFree(preview.body);
  const saved = await f.request(MEASURE, { method: 'PUT', body: saveBody(f.p) }); assert.equal(saved.status, 200);
  const review = await f.request(REVIEW); assert.equal(review.status, 200, JSON.stringify(review.body)); assert.equal(f.calls.length, 4);
  assert.deepEqual(review.body.selectedReceiptSource.receiptSource, saved.body.measurement.receiptSource); rawFree(review.body);
  const page = await f.request(SOURCES, { method: 'POST', body: { receipt: null, afterAttemptId: f.p.selector.attemptId } });
  assert.equal(page.status, 200); assert.equal(f.calls.length, 5); assert.equal(page.body.selectedReceiptSource, null);
  assert.deepEqual(page.body.receiptChoices, []); assert.equal(page.body.hasMoreReceipts, false);
});

test('protected preview rejects viewers, CSRF, authority overrides and malformed selector before database access', async t => {
  const f = await setup(t), body = { receipt: f.p.selector, afterAttemptId: null };
  for (const role of ['member', 'viewer']) assert.equal((await f.request(SOURCES, { method: 'POST', body, identity: f.auth('outcome-alpha', role) })).status, 403);
  assert.equal((await f.request(SOURCES, { method: 'POST', body, csrf: false })).status, 403);
  for (const injected of [{ ...body, workspaceId: 'outcome-beta' }, { ...body, actorId: 'somebody' }, { ...body, requireReceiptContract: false },
    { ...body, afterAttemptId: f.p.selector.attemptId }, { ...body, receipt: { ...f.p.selector, source: f.p.source } }]) {
    assert.ok([400, 409, 413].includes((await f.request(SOURCES, { method: 'POST', body: injected })).status));
  }
  assert.equal(f.calls.length, 0); assert.equal(f.counts.saves, 0);
  const foreign = await f.request(SOURCES, { method: 'POST', body, identity: f.auth('outcome-beta') });
  assert.equal(foreign.status, 409); rawFree(foreign.body); assert.equal(f.counts.saves, 0);
});

test('current authority changes and measurement/workspace races prevent protected draft save', async t => {
  for (const change of ['session', 'role', 'inactive', 'password', 'workspace', 'measurement']) {
    const f = await setup(t), original = f.store.getBusinessOutcomeReview;
    f.store.getBusinessOutcomeReview = async (...args) => {
      const result = await original(...args), state = f.states.get('outcome-alpha');
      if (change === 'session') state.users[0].sessionVersion++;
      if (change === 'role') state.users[0].role = 'viewer';
      if (change === 'inactive') state.users[0].active = false;
      if (change === 'password') state.users[0].passwordChangeRequired = true;
      if (change === 'workspace') state._revision = randomUUID();
      if (change === 'measurement') state.revenueEngine.experiments[0].outcomeMeasurement = { revision: 99, digest: 'f'.repeat(64) };
      return result;
    };
    const result = await f.request(MEASURE, { method: 'PUT', body: saveBody(f.p) });
    assert.ok([401, 403, 404, 409].includes(result.status), `${change}: ${JSON.stringify(result.body)}`);
    assert.equal(f.counts.saves, 0); assert.equal(f.calls.length, 1); rawFree(result.body);
  }
});

test('combined source reads authenticate the current reviewer after the compact authentication snapshot', async t => {
  for (const change of ['session', 'role', 'password']) {
    const f = await setup(t);
    f.hooks.afterIdentity = async () => {
      const actor = f.states.get('outcome-alpha').users[0];
      if (change === 'session') actor.sessionVersion++;
      if (change === 'role') actor.role = 'viewer';
      if (change === 'password') actor.passwordChangeRequired = true;
    };
    const response = await f.request(SOURCES, { method: 'POST', body: { receipt: f.p.selector, afterAttemptId: null } });
    assert.equal(response.status, 403); assert.equal(response.body.code, 'OUTCOME_OWNER_SESSION_CHANGED');
    assert.equal(f.calls.length, 1); assert.equal(f.counts.saves, 0); rawFree(response.body);
  }
});

test('initial, page and different-purpose preview reject a changed protected commit behind the saved v4 reference', async t => {
  for (const purpose of ['initial', 'page', 'preview']) {
    const f = await setup(t);
    assert.equal((await f.request(MEASURE, { method: 'PUT', body: saveBody(f.p) })).status, 200);
    f.protectedEvidence.get(f.p.selector.attemptId).commitRevision = randomUUID();
    const before = f.calls.length;
    const response = purpose === 'initial' ? await f.request(REVIEW) : await f.request(SOURCES, { method: 'POST',
      body: purpose === 'page' ? { receipt: null, afterAttemptId: f.p.selector.attemptId } : { receipt: f.p.selector, afterAttemptId: null } });
    assert.equal(response.status, 409, `${purpose}: ${JSON.stringify(response.body)}`); assert.equal(response.body.code, 'OUTCOME_SOURCE_INVALID');
    assert.equal(f.calls.length - before, 1); rawFree(response.body);
  }
});

test('existing generic CAS rejects a workspace change after protected preparation without retry', async t => {
  const f = await setup(t), original = f.store.save;
  f.store.save = async (workspace, state) => { f.states.get(workspace)._revision = randomUUID(); return original(workspace, state); };
  const result = await f.request(MEASURE, { method: 'PUT', body: saveBody(f.p) });
  assert.equal(result.status, 409); assert.equal(result.body.code, 'STATE_CONFLICT'); assert.equal(f.counts.saves, 1);
  assert.equal(f.calls.length, 1); assert.equal(f.states.get('outcome-alpha').revenueEngine.experiments[0].outcomeMeasurement, undefined);
});

test('exact protected publish/evidence/reuse/withdraw stay in existing RPC/version paths without mutable reconstruction', async t => {
  const f = await setup(t);
  assert.equal((await f.request(MEASURE, { method: 'PUT', body: saveBody(f.p) })).status, 200);
  const beforePublishReads = f.calls.length, saves = f.counts.saves;
  const first = await f.request(`${BASE}/publish`, { method: 'POST', body: f.publicationInput() });
  assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(f.calls.length - beforePublishReads, 1); assert.equal(f.counts.saves, saves);
  const versionId = first.body.publication.head.versionId, row = f.rows.get(versionId);
  assert.deepEqual(row.source_action, f.p.source);
  const beforeEvidenceReads = f.calls.length;
  const evidence = await f.request(`${BASE}/versions/${versionId}`, { identity: f.auth('outcome-alpha', 'viewer') });
  assert.equal(evidence.status, 200); assert.equal(f.calls.length - beforeEvidenceReads, 1);
  assert.equal(evidence.body.sourceAction.schema, 'runvara-protected-content-source-display/v1'); rawFree(evidence.body);
  f.protectedEvidence.clear();
  const state = f.states.get('outcome-alpha'); delete state.connectionWrites; delete state.approvals; delete state.connections;
  const beforeReuseReads = f.calls.length;
  const reused = await f.request(MEASURE, { method: 'PUT', body: { ...measurementInput(1), amount: '11', actionSelection: { reuseVersionId: versionId } } });
  assert.equal(reused.status, 200, JSON.stringify(reused.body)); assert.equal(f.calls.length - beforeReuseReads, 2);
  assert.equal(reused.body.measurement.schema, 'runvara-experiment-measurement/v4');
  assert.equal(reused.body.measurement.intervention.reuseVersionId, versionId);
  assert.deepEqual(reused.body.measurement.receiptSource, row.source_measurement.receiptSource);
  const review = await f.request(REVIEW); assert.equal(review.status, 200, JSON.stringify(review.body)); assert.equal(review.body.selectedReceiptSource, null);
  const correction = { ...f.publicationInput(), action: 'correct', expectedHeadVersionId: versionId, expectedHeadDigest: first.body.publication.head.digest };
  const corrected = await f.request(`${BASE}/publish`, { method: 'POST', body: correction }); assert.equal(corrected.status, 200);
  const correctedRow = f.rows.get(corrected.body.publication.head.versionId); assert.deepEqual(correctedRow.source_action, f.p.source);
  const withdrawnInput = { ...f.publicationInput(), action: 'withdraw', expectedHeadVersionId: corrected.body.publication.head.versionId,
    expectedHeadDigest: corrected.body.publication.head.digest, withdrawalReason: 'incorrect_measurement' };
  const beforeWithdrawalReads = f.calls.length, beforeWithdrawalSaves = f.counts.saves;
  const withdrawn = await f.request(`${BASE}/publish`, { method: 'POST', body: withdrawnInput });
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body)); assert.equal(f.calls.length - beforeWithdrawalReads, 1); assert.equal(f.counts.saves, beforeWithdrawalSaves);
  const withdrawnRow = f.rows.get(withdrawn.body.publication.head.versionId);
  assert.deepEqual(withdrawnRow.source_action, correctedRow.source_action); assert.deepEqual(withdrawnRow.source_measurement, correctedRow.source_measurement);
  assert.equal(f.counts.providerCalls, 0);
});

test('protected objective preview and published evidence always use the same private-free projection', async t => {
  const objective = await objectivePublicationFixture(), p = protectedReceiptFixture({ fixture: objective });
  const f = await fixture(t, { primaryState: objective.state, measured: false, linkedContract: 'runvara-reviewed-action/v2', protectedSources: [p.evidence] });
  const preview = await f.request(SOURCES, { method: 'POST', body: { receipt: p.selector, afterAttemptId: null } });
  assert.equal(preview.status, 200, JSON.stringify(preview.body)); assert.equal(preview.body.selectedReceiptSource.origin, 'owner_objective_content');
  assert.deepEqual(preview.body.selectedReceiptSource.originatingObjective, p.source.context.originatingObjective); rawFree(preview.body);
  const state = f.states.get(f.primaryWorkspace); delete state.connectionWrites; delete state.approvals; delete state.connections;
  const saved = await f.request(MEASURE, { method: 'PUT', body: saveBody(p) }); assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.measurement.intervention.schema, 'runvara-owner-action-association/v2');
  const published = await f.request(`${BASE}/publish`, { method: 'POST', body: f.publicationInput() }); assert.equal(published.status, 200, JSON.stringify(published.body));
  const evidence = await f.request(`${BASE}/versions/${published.body.publication.head.versionId}`);
  assert.equal(evidence.status, 200); rawFree(evidence.body); assert.equal(evidence.body.sourceAction.schema, 'runvara-protected-content-source-display/v1');
  assert.deepEqual(evidence.body.sourceAction, preview.body.selectedReceiptSource); assert.equal(f.counts.providerCalls, 0);
});

test('denied, missing, timed-out and unknown protected storage never downgrade or leak upstream bodies', async t => {
  for (const databaseCode of ['PGRST202', '42883', 'P0O03', 'P0O01', '57014']) {
    const f = await setup(t); f.hooks.transport = async () => { throw sqlError(databaseCode); };
    const result = await f.request(MEASURE, { method: 'PUT', body: saveBody(f.p) });
    assert.ok(result.status >= 400); assert.equal(f.calls.length, 1); assert.equal(f.counts.saves, 0);
    assert.equal(JSON.stringify(result.body).includes('private synthetic'), false); rawFree(result.body);
  }
});

test('protected immutable reuse resolves the exact version first and refuses an unavailable receipt reader without legacy fallback', async t => {
  const f = await setup(t);
  assert.equal((await f.request(MEASURE, { method: 'PUT', body: saveBody(f.p) })).status, 200);
  const published = await f.request(`${BASE}/publish`, { method: 'POST', body: f.publicationInput() }); assert.equal(published.status, 200);
  const versionId = published.body.publication.head.versionId, row = structuredClone(f.rows.get(versionId));
  f.calls.length = 0;
  f.hooks.transport = async path => {
    if (path.startsWith('runvara_business_outcome_versions?')) return [row];
    assert.equal(path, 'rpc/runvara_read_outcome_content_sources'); throw sqlError('PGRST202');
  };
  const saves = f.counts.saves;
  const result = await f.request(MEASURE, { method: 'PUT', body: { ...measurementInput(1), actionSelection: { reuseVersionId: versionId } } });
  assert.equal(result.status, 503); assert.equal(f.calls.length, 2); assert.equal(f.counts.saves, saves);
  assert.equal(f.calls.some(call => call.path === 'rpc/runvara_read_business_outcome_review'), false);
});

test('manual receipt linking retains v1 capability while objective receipts require the v2 capability', async t => {
  const manual = await setup(t, { linkedContract: 'runvara-reviewed-action/v1' });
  assert.equal((await manual.request(MEASURE, { method: 'PUT', body: saveBody(manual.p) })).status, 200);
  const objective = await objectivePublicationFixture(), p = protectedReceiptFixture({ fixture: objective });
  const f = await fixture(t, { primaryState: objective.state, measured: false, linkedContract: 'runvara-reviewed-action/v1', protectedSources: [p.evidence] });
  const result = await f.request(MEASURE, { method: 'PUT', body: saveBody(p) });
  assert.equal(result.status, 503); assert.equal(result.body.code, 'OUTCOME_REVIEW_INVALID'); assert.equal(f.counts.saves, 0); assert.equal(f.calls.length, 1);
});
