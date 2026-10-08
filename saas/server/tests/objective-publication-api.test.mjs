// HTTP/API/adapter proof with a real objective producer and synthetic SQL
// transport. Actual PostgreSQL locking, grants and durability are separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, BASE, REVIEW, MEASURE, EXPERIMENT, measurementInput } from './business-outcomes-api-fixture.mjs';
import { objectivePublicationFixture } from './objective-publication-fixture.mjs';
import { reviewedActionFixture } from './reviewed-action-test-fixture.mjs';
import { publicReviewedSourceAction, resolveRecordedActionEvidence } from '../lib/reviewed-action-evidence.mjs';

const ROLES = ['owner','admin','member','viewer'];
const CONTRACT = 'runvara-reviewed-action/v2';
const success = r => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const error = (r, status, code) => { assert.equal(r.status, status, JSON.stringify(r.body)); if (code) assert.equal(r.body.code, code); };
const privateKeys = ['recordedActionContext','objectivePolicyProposal','stableApproval','actorSessionVersion','claimIdentity','claimId','dispatchRequestDigest','jobIdentityDigest','approvalSourceDigest','approvalDigest','payloadDigest','resultDigest','productDigest'];
function privateAbsent(value, label = '') {
  const json = JSON.stringify(value);
  for (const key of privateKeys) assert.equal(json.includes(`"${key}":`), false, `${label}: ${key}`);
}
async function objectiveApiFixture(t, options = {}) {
  const producer = await objectivePublicationFixture(options.producerOptions);
  const f = await fixture(t, { measured: false, linkedContract: CONTRACT, primaryState: producer.state, ...options });
  return { ...f, producer, workspaceId: producer.workspaceId };
}
function nextPublication(f, previous, action = 'correct') {
  return { ...f.publicationInput(), action, expectedHeadVersionId: previous.publication.head.versionId,
    expectedHeadDigest: previous.publication.head.digest, withdrawalReason: action === 'withdraw' ? 'incorrect_measurement' : null };
}
async function publishFresh(f, role = 'owner') {
  const draft = success(await f.request(MEASURE, { method: 'PUT', body: { ...measurementInput(), actionSelection: { actionId: f.producer.write.id } }, identity: f.auth(f.workspaceId, role) }));
  const published = success(await f.request(`${BASE}/publish`, { method: 'POST', body: f.publicationInput() }));
  return { draft, published, versionId: published.publication.head.versionId };
}

test('real prepared/approved/dispatched objective action flows through deliberate review, publication, public evidence, correction reuse and withdrawal', async t => {
  const f = await objectiveApiFixture(t), p = f.producer, pre = JSON.stringify(p.source);
  const review = success(await f.request(REVIEW));
  assert.equal(review.actionLinkContract, CONTRACT); assert.equal(review.measurement, null); assert.equal(review.actionChoices.length, 1);
  assert.deepEqual(review.actionChoices[0], { id: p.write.id, account: p.write.account, productId: p.write.input.productId,
    title: p.write.input.title, completedAt: p.write.completedAt, digest: p.source.digest, origin: 'owner_objective_content', originatingObjective: p.source.context.originatingObjective });
  privateAbsent(review, 'selected review');
  const { draft, published, versionId } = await publishFresh(f, 'admin');
  assert.equal(draft.measurement.schema, 'runvara-experiment-measurement/v3');
  assert.equal(draft.measurement.report.schema, 'runvara-measurement-report/v3');
  assert.equal(draft.measurement.recordedBy, `${f.workspaceId}-admin`);
  assert.deepEqual(draft.measurement.intervention.originatingObjective, p.source.context.originatingObjective);
  assert.equal(draft.measurement.links.objective, null); assert.equal(draft.measurement.links.opportunity, null);
  assert.equal(draft.measurement.intervention.comparison, 'not_established');
  const exactRoute = `${BASE}/versions/${versionId}`, expectedPublic = publicReviewedSourceAction(p.source, { workspaceId: f.workspaceId });
  const savedBeforeReads = f.counts.saves, callsBeforeReads = f.calls.length;
  for (const role of ROLES) {
    const evidence = success(await f.request(exactRoute, { identity: f.auth(f.workspaceId, role) }));
    assert.deepEqual(evidence.sourceAction, expectedPublic); privateAbsent(evidence, `${role} exact evidence`);
    assert.deepEqual(evidence.sourceMeasurement, draft.measurement);
    assert.equal(evidence.publication.version.versionId, versionId);
    const summary = success(await f.request(BASE, { identity: f.auth(f.workspaceId, role) }));
    privateAbsent(summary, `${role} summary`); assert.equal(JSON.stringify(summary).includes('sourceAction'), false);
    assert.equal(summary.summary.groups[0].learningComparable, false);
  }
  assert.equal(f.calls.length - callsBeforeReads, 8, 'each exact read/summary uses one bounded source read');
  assert.equal(f.counts.saves, savedBeforeReads); assert.equal(f.counts.providerCalls, 0); assert.equal(p.counts.mutations, 1);
  const internal = await f.store.getBusinessOutcomeEvidence(f.workspaceId, versionId);
  assert.deepEqual(internal.sourceAction, p.source, 'correction resolver still receives full private validated evidence');
  assert.deepEqual(f.rows.get(versionId).source_action, p.source);
  assert.equal(JSON.stringify(p.source), pre, 'external projection does not rewrite retained source');
  const afterPublish = success(await f.request(REVIEW));
  assert.deepEqual(afterPublish.currentActionAssociation, draft.measurement.intervention);
  const mutable = structuredClone(f.states.get(f.workspaceId));
  mutable.connectionWrites = []; mutable.approvals = []; mutable.connections = []; mutable.products = []; mutable.businessObjectives = [];
  mutable._revision = randomUUID(); f.states.set(f.workspaceId, mutable);
  const correctedDraft = success(await f.request(MEASURE, { method: 'PUT', body: { ...measurementInput(1), amount: '-2', actionSelection: { reuseVersionId: versionId } } }));
  assert.equal(correctedDraft.measurement.intervention.reuseVersionId, versionId);
  assert.deepEqual(correctedDraft.measurement.intervention.originatingObjective, p.source.context.originatingObjective);
  const corrected = success(await f.request(`${BASE}/publish`, { method: 'POST', body: nextPublication(f, published) }));
  assert.deepEqual(f.rows.get(corrected.publication.head.versionId).source_action, p.source);
  const withdrawn = success(await f.request(`${BASE}/publish`, { method: 'POST', body: nextPublication(f, corrected, 'withdraw') }));
  assert.equal(withdrawn.publication.version.status, 'withdrawn');
  assert.deepEqual(f.rows.get(withdrawn.publication.head.versionId).source_action, p.source);
  assert.deepEqual(success(await f.request(exactRoute)).sourceAction, expectedPublic, 'old exact evidence survives correction and withdrawal');
  assert.equal(success(await f.request(REVIEW)).currentPublication.version.status, 'withdrawn');
  assert.equal(f.counts.saves, 2, 'only the two explicit draft updates use generic saves');
  assert.equal(f.counts.providerCalls, 0); assert.equal(p.counts.mutations, 1);
});

test('v2 HTTP keeps owner/admin drafts, owner-only publication and authenticated exact evidence with exact tenant/session boundaries', async t => {
  const f = await objectiveApiFixture(t), body = { ...measurementInput(), actionSelection: { actionId: f.producer.write.id } };
  for (const role of ['member','viewer']) {
    const identity = f.auth(f.workspaceId, role);
    error(await f.request(REVIEW, { identity }), 403, 'ROLE_DENIED');
    error(await f.request(MEASURE, { method: 'PUT', body, identity }), 403, 'ROLE_DENIED');
  }
  success(await f.request(REVIEW, { identity: f.auth(f.workspaceId, 'admin') }));
  const { versionId } = await publishFresh(f);
  error(await f.request(`${BASE}/publish`, { method: 'POST', body: f.publicationInput(), identity: f.auth(f.workspaceId, 'admin') }), 403, 'OWNER_APPROVAL_REQUIRED');
  error(await f.request(`${BASE}/versions/${versionId}`, { identity: null }), 401, 'AUTH_REQUIRED');
  error(await f.request(`${BASE}/versions/${versionId}`, { identity: f.auth('outcome-beta') }), 404, 'OUTCOME_VERSION_NOT_FOUND');
  error(await f.request(`${BASE}/versions/${versionId}?workspaceId=outcome-beta`), 400, 'OUTCOME_REQUEST_INVALID');
  for (const role of ['admin','member','viewer']) error(await f.request(`/api/objective-content/requests/${f.producer.body.requestId}`, { identity: f.auth(f.workspaceId, role) }), 403);
  const identity = f.auth(), state = f.states.get(f.workspaceId); state.users[0].sessionVersion++;
  error(await f.request(`${BASE}/versions/${versionId}`, { identity }), 401, 'SESSION_INVALID');
  assert.equal(f.counts.providerCalls, 0);
});

test('old/unknown storage markers fail closed for objective actions; old unlinked/manual and forward manual reads remain compatible', async t => {
  for (const marker of [false, 'runvara-reviewed-action/v1', 'runvara-reviewed-action/v999']) await t.test(String(marker), async () => {
    const f = await objectiveApiFixture(t, { linkedContract: marker });
    if (marker === 'runvara-reviewed-action/v1') assert.deepEqual(success(await f.request(REVIEW)).actionChoices, []);
    const result = await f.request(MEASURE, { method: 'PUT', body: { ...measurementInput(), actionSelection: { actionId: f.producer.write.id } } });
    assert.ok(result.status >= 400, JSON.stringify(result.body)); assert.equal(f.counts.saves, 0); assert.equal(f.rows.size, 0);
    assert.equal(result.body.code, marker === 'runvara-reviewed-action/v999' ? 'OUTCOME_REVIEW_INVALID' : 'OUTCOME_ACTION_STORAGE_UNAVAILABLE');
  });
  for (const marker of ['runvara-reviewed-action/v1', CONTRACT]) await t.test(`manual ${marker}`, async () => {
    const f = await fixture(t, { measured: false, linkedContract: marker });
    const source = reviewedActionFixture({ workspaceId: f.primaryWorkspace }), state = f.states.get(f.primaryWorkspace);
    state.connectionWrites = source.state.connectionWrites; state.approvals = source.state.approvals; state.connections = source.state.connections;
    const unlinked = success(await f.request(MEASURE, { method: 'PUT', body: measurementInput() })); assert.equal(unlinked.measurement.schema, 'runvara-experiment-measurement/v1');
    const linked = success(await f.request(MEASURE, { method: 'PUT', body: { ...measurementInput(1), actionSelection: { actionId: source.write.id } } }));
    assert.equal(linked.measurement.schema, 'runvara-experiment-measurement/v2');
    const published = success(await f.request(`${BASE}/publish`, { method: 'POST', body: f.publicationInput() }));
    for (const role of ROLES) assert.deepEqual(success(await f.request(`${BASE}/versions/${published.publication.head.versionId}`, { identity: f.auth(f.primaryWorkspace, role) })).sourceAction, source.source);
  });
});

test('generic all-role bootstrap, connections, approvals, history and graph omit captured v2 context and nested future canaries without mutating storage', async t => {
  const f = await objectiveApiFixture(t), state = f.states.get(f.workspaceId), marker = 'PRIVATE_FUTURE_CONTEXT_CANARY_NEVER_SERIALIZE';
  const w = state.connectionWrites[0], a = state.approvals[0];
  w.futurePrivate = { aliases: [{ stableApproval: { hidden: marker } }] };
  w.sourceDisplay = { source: { secret: marker } };
  a.futurePrivate = { private: marker }; a.payload.futurePrivate = { nested: [marker] };
  a.evidence[0].futurePrivate = { actorSessionVersion: marker };
  a.history[0].futurePrivate = { payload: marker };
  a.history[0].evidence = [{ type: 'reference', id: 'public_history_reference', detail: 'Intentional public history text', private: marker }];
  const before = JSON.stringify({ writes: state.connectionWrites, approvals: state.approvals });
  for (const role of ROLES) for (const route of ['/api/bootstrap','/api/connection-centre','/api/approvals','/api/business-graph','/api/audit']) {
    const response = success(await f.request(route, { identity: f.auth(f.workspaceId, role) }));
    privateAbsent(response, `${role} ${route}`); assert.equal(JSON.stringify(response).includes(marker), false, `${role} ${route}`);
    if (route === '/api/bootstrap' || route === '/api/approvals') {
      const approval = response.approvals.find(row => row.id === a.id);
      assert.equal(approval.action, a.action); assert.equal(approval.reason, a.reason);
      assert.equal(approval.evidence[0].id, a.evidence[0].id); assert.equal(approval.evidence[0].detail, a.evidence[0].detail);
      assert.equal(approval.history[0].evidence[0].detail, 'Intentional public history text');
    }
    if (route === '/api/bootstrap') assert.deepEqual(response.connectionWrites[0].input, w.input);
  }
  assert.equal(JSON.stringify({ writes: f.states.get(f.workspaceId).connectionWrites, approvals: f.states.get(f.workspaceId).approvals }), before);
  assert.equal(f.counts.saves, 1, 'only the first bootstrap refreshes existing derived control state; projections add no saves'); assert.equal(f.counts.providerCalls, 0);
});

test('HTTP selectors never admit owner-supplied private evidence and mutable source changes cannot mint a draft', async t => {
  for (const selection of [{ actionId: 'actual', digest: 'a'.repeat(64) }, { actionId: 'actual', sourceAction: {} }, { actionId: 'actual', reuseVersionId: 'outcome_version_' + 'a'.repeat(64) }]) await t.test(JSON.stringify(selection), async () => {
    const f = await objectiveApiFixture(t);
    selection.actionId = f.producer.write.id;
    const result = await f.request(MEASURE, { method: 'PUT', body: { ...measurementInput(), actionSelection: selection } });
    assert.ok(result.status >= 400); assert.equal(f.counts.saves, 0);
  });
  const f = await objectiveApiFixture(t), state = f.states.get(f.workspaceId);
  state.approvals[0].reason += ' changed after completion';
  error(await f.request(MEASURE, { method: 'PUT', body: { ...measurementInput(), actionSelection: { actionId: f.producer.write.id } } }), 409, 'OUTCOME_ACTION_INVALID');
  assert.equal(f.counts.saves, 0);
});

test('private immutable source corruption and future fields are rejected at HTTP without raw fallback or storage mutation', async t => {
  const f = await objectiveApiFixture(t), { versionId } = await publishFresh(f), row = f.rows.get(versionId), original = structuredClone(row.source_action);
  for (const change of [s => { s.context.stableApproval.reason += ' altered'; }, s => { s.context.stableApproval.future = { alias: { actorSessionVersion: 'PRIVATE_CORRUPT_CANARY' } }; }, s => { s.schema = 'runvara-reviewed-source-action/v999'; }]) {
    row.source_action = structuredClone(original); change(row.source_action); const before = JSON.stringify(row);
    for (const role of ROLES) {
      const result = await f.request(`${BASE}/versions/${versionId}`, { identity: f.auth(f.workspaceId, role) });
      error(result, 503, 'OUTCOME_SOURCE_INVALID'); privateAbsent(result.body);
      assert.equal(JSON.stringify(result.body).includes('PRIVATE_CORRUPT_CANARY'), false);
    }
    assert.equal(JSON.stringify(row), before);
  }
  assert.equal(f.counts.saves, 1); assert.equal(f.counts.providerCalls, 0);
});
