import test from 'node:test';
import assert from 'node:assert/strict';
import { objectiveContentSeed, objectiveContentJob, objectiveContentFixture } from './objective-content-fixture.mjs';
import { captureObjectiveContentSource, objectiveContentContext } from '../lib/objective-content-source.mjs';
import { objectiveCanonicalDigest, objectiveCanonicalText } from '../lib/objective-dispatch-policy.mjs';
import { readObjectiveContentRequest } from '../lib/connection-writes.mjs';

const seed = () => { const f = objectiveContentSeed(); return { ...f, job: objectiveContentJob(f.state, f.objective) }; };
const capture = f => captureObjectiveContentSource(f.state, f.job, 'opportunity-content', f.session);
function reordered(value) {
  if (Array.isArray(value)) return value.map(reordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).reverse().map(key => [key, reordered(value[key])]));
  return value;
}
test('canonical whole payload/report binding survives JSONB key ordering and harmless row touches', () => {
  const f = seed(), original = capture(f).source;
  f.job = reordered(f.job); f.job.updated_at = new Date(Date.now() + 100).toISOString();
  assert.deepEqual(capture(f).source, original);
  assert.notEqual(objectiveCanonicalDigest({ a: [1, 2] }), objectiveCanonicalDigest({ a: [2, 1] }));
});
test('canonicalization rejects accessors, non-JSON values, sparse arrays and bounds without executing them', () => {
  let calls = 0;
  for (const value of [{ get bad() { calls++; return 1; } }, { a: undefined }, { a: Infinity }, { a: 1n }, [,,], new Date(), { a: 'x'.repeat(131073) }]) {
    assert.throws(() => objectiveCanonicalText(value));
  }
  assert.equal(calls, 0);
});
test('whole report reconstruction rejects altered diagnostics, derived identities and nested candidate semantics', async t => {
  const mutations = {
    reportId: f => { f.job.result.id = `objective_review_${'a'.repeat(32)}`; },
    reportMissingField: f => { delete f.job.result.metricEvidence; },
    reportExtra: f => { f.job.result.extra = true; },
    candidateReady: f => { f.job.result.proposals[0].readyForPreparation = true; },
    candidateCommercial: f => { f.job.result.proposals[0].commercialReady = true; },
    candidateExternal: f => { f.job.result.proposals[0].externalExecutionAllowed = true; },
    candidateMissing: f => { delete f.job.result.proposals[0].measurementsVerified; },
    candidateDuplicate: f => { f.job.result.proposals.push(structuredClone(f.job.result.proposals[0])); },
    candidateReference: f => { f.job.result.proposals[0].sourceRef.recordId = 'another-opportunity'; },
    candidateNestedScope: f => { f.job.result.proposals[0].sourceRef.workspaceId = 'foreign'; },
    summaryReady: f => { f.job.result.summary.proposalsReady = 1; },
    summaryAltered: f => { f.job.result.summary.specialistsCompleted = 0; },
    safeguardsMissing: f => { delete f.job.result.safeguards.unknownEvidenceDoesNotBecomeZero; },
    providerPosture: f => { f.job.provider = 'shopify'; },
    modelPosture: f => { f.job.ai_model = 'model'; },
    unitsPosture: f => { f.job.ai_units = 1; },
    type: f => { f.job.type = 'other'; },
    status: f => { f.job.status = 'running'; },
    actor: f => { f.job.actor = 'another-owner'; },
    epoch: f => { f.job.payload.actorSessionVersion = 2; },
    payloadUnknown: f => { f.job.payload.ignoreApprovals = []; },
    dedupIdentity: f => { f.job.idempotency_key = 'arbitrary'; },
    workspace: f => { f.job.workspace_id = 'foreign'; }
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => { const f = seed(); mutate(f); assert.throws(() => capture(f)); });
});
test('canonical current source validates raw duplicates/scope/mapping before filtering and never maps unsupported SEO', async t => {
  const mutations = {
    duplicateOpportunity: f => f.state.opportunities.push({ ...f.state.opportunities[0], workspaceId: 'foreign' }),
    dismissed: f => { f.state.opportunities[0].status = 'dismissed'; },
    absent: f => { f.state.opportunities[0].present = false; },
    foreignEvidence: f => { f.state.opportunities[0].evidence[0].workspaceId = 'foreign'; },
    productReference: f => { f.state.opportunities[0].reference += ':suffix'; },
    productEvidence: f => { f.state.opportunities[0].evidence[0].id = 'gid://shopify/Product/99'; },
    productDuplicate: f => f.state.products.push({ ...f.state.products[0], workspaceId: 'foreign' }),
    productForeign: f => { f.state.products[0].workspaceId = 'foreign'; },
    missingProduct: f => { f.state.products = []; },
    missingIssue: f => { f.state.products[0].title = 'A title with more than eighteen characters'; },
    imageIssue: f => { f.state.opportunities[0].reference = `${f.state.products[0].id}:Missing product image`; f.state.opportunities[0].evidence[0].detail = 'Missing product image'; },
    extraProductEvidence: f => f.state.opportunities[0].evidence.push({ ...f.state.opportunities[0].evidence[0] }),
    foreignApprovalBeforeFilter: f => f.state.approvals.push({ id: 'approval_other', status: 'pending', workspaceId: 'foreign' }),
    pausedAgent: f => { f.state.agentOps = { paused: true }; },
    preparationOnly: f => { f.state.businessObjectives[0].executionPolicy = { schema: 'runvara-objective-execution-policy/v1', mode: 'preparation_only' }; },
    expiredObjective: f => { f.state.businessObjectives[0].endsAt = new Date(Date.now() - 1).toISOString(); },
    changedConnection: f => { f.state.connections[0].metadata.shopDomain = 'other.myshopify.com'; }
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => { const f = seed(); mutate(f); assert.throws(() => capture(f)); });
});
test('unique current original owner and exact account epoch are required, not original login jti', async t => {
  for (const [name, mutate] of Object.entries({ admin: f => { f.state.users[0].role = 'admin'; }, inactive: f => { f.state.users[0].active = false; },
    passwordChange: f => { f.state.users[0].passwordChangeRequired = true; }, duplicate: f => f.state.users.push({ ...f.state.users[0] }),
    epoch: f => { f.state.users[0].sessionVersion = 2; } })) await t.test(name, () => { const f = seed(); mutate(f); assert.throws(() => capture(f)); });
  const f = seed(); f.session.jti = 'second-login-same-account-epoch'; assert.equal(capture(f).source.actorSessionVersion, 1);
});
test('retained product bodies and resource mapping supplement the legacy diagnostic fingerprint', () => {
  const f = seed(), initial = capture(f).source;
  f.state.products[0].description = 'Different retained description.';
  const next = capture(f).source;
  assert.equal(next.inputFingerprint, initial.inputFingerprint); assert.equal(next.resultDigest, initial.resultDigest);
  assert.notEqual(next.productDigest, initial.productDigest);
});
test('full other-approval comparison digest covers payload/decision changes omitted by the original report', () => {
  const f = seed();
  f.state.approvals.push({ id: 'approval_prior', status: 'approved', payload: { text: 'original' }, decidedBy: 'content-owner' });
  f.job = objectiveContentJob(f.state, f.objective);
  const original = capture(f).source;
  f.state.approvals[0].payload.text = 'different';
  const changed = capture(f).source;
  assert.equal(changed.inputFingerprint, original.inputFingerprint); assert.equal(changed.resultDigest, original.resultDigest);
  assert.notEqual(changed.approvalSourceDigest, original.approvalSourceDigest);
});
test('reconciliation rejects malformed stored v2 origin and changes across its awaited source read', async () => {
  const f = await objectiveContentFixture();
  f.write.objectivePolicyProposal = { ...f.write.objectivePolicyProposal, origin: 'owner_manual' };
  await assert.rejects(() => readObjectiveContentRequest(f.state, f.body.requestId, f.session, f.loadJob), error => error.code === 'WRITE_CONFLICT');
  f.write.objectivePolicyProposal.origin = 'owner_objective_content';
  f.hooks.job = () => { f.write.status = 'failed'; };
  await assert.rejects(() => readObjectiveContentRequest(f.state, f.body.requestId, f.session, f.loadJob), error => error.code === 'WRITE_REQUEST_CHANGED');
});
test('own approval validates independently before its private fingerprint exclusion', async t => {
  const mutations = {
    duplicate: f => f.state.approvals.push(structuredClone(f.state.approvals[0])),
    foreignDuplicate: f => f.state.approvals.push({ ...f.state.approvals[0], workspaceId: 'foreign' }),
    payload: f => { f.state.approvals[0].payload.digest = 'a'.repeat(64); },
    extraPayload: f => { f.state.approvals[0].payload.ignore = true; },
    type: f => { f.state.approvals[0].type = 'integration_change'; },
    requester: f => { f.state.approvals[0].requestedBy = 'other'; },
    revision: f => { f.state.approvals[0].revision = 2; },
    action: f => { f.state.approvals[0].action = 'Changed exact approval'; },
    decisionActor: f => { f.state.approvals[0].decidedBy = 'missing'; },
    decisionTime: f => { f.state.approvals[0].decidedAt = new Date(Date.now() - 10000).toISOString(); },
    extraHistory: f => f.state.approvals[0].history.push(structuredClone(f.state.approvals[0].history[0])),
    missingHistory: f => { f.state.approvals[0].history = []; },
    rejected: f => { f.state.approvals[0].status = 'rejected'; },
    missing: f => { f.state.approvals = []; },
    otherApproval: f => f.state.approvals.push({ id: 'approval_other', status: 'pending' })
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const f = await objectiveContentFixture(); mutate(f); await assert.rejects(f.run); assert.equal(f.counts.credentials, 0); assert.equal(f.counts.mutations, 0);
  });
});
test('a second request cannot ignore the first request approval and ordinary report context stays historical', async () => {
  const f = await objectiveContentFixture();
  await assert.rejects(() => objectiveContentContext(f.state, f.job.id, 'opportunity-content', f.session, f.loadJob));
});
