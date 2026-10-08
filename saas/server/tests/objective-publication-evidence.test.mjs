import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { objectivePublicationFixture, objectivePublicationMeasurementInput } from './objective-publication-fixture.mjs';
import { objectiveContentFixture } from './objective-content-fixture.mjs';
import { reviewedActionFixture } from './reviewed-action-test-fixture.mjs';
import * as action from '../lib/reviewed-action-evidence.mjs';
import { prepareExperimentOutcomeMeasurement, validateExperimentOutcomeMeasurement, canonicalMeasurementJson } from '../lib/experiment-measurements.mjs';
import { createBusinessOutcomePersistence } from '../lib/business-outcome-store.mjs';

// Independent canonical JSON/hash oracle: no production digest helper is used
// to verify the original fixture bytes or captured stable approval preimage.
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = v => sha(canonical(v));
const unsigned = v => Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'digest'));
const resign = source => { source.digest = digest(unsigned(source)); return source; };
const reversed = v => Array.isArray(v) ? v.map(reversed) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k,x]) => [k,reversed(x)])) : v;

test('pre-union manual source, manual measurement and unlinked canonical bytes remain frozen', async () => {
  const g = JSON.parse(await fs.readFile(new URL('./fixtures/objective-publication-legacy-golden.json', import.meta.url)));
  const f = reviewedActionFixture({ workspaceId: g.fixture.context.workspaceId });
  const unlinked = prepareExperimentOutcomeMeasurement(g.fixture.input, g.fixture.context);
  const linked = prepareExperimentOutcomeMeasurement({ ...g.fixture.input, actionSelection: { actionId: f.write.id } }, { ...g.fixture.context, actionEvidence: f.source });
  const bytes = { manualSource: action.canonicalReviewedActionJson(f.source), unlinkedMeasurement: canonicalMeasurementJson(unlinked), manualLinkedMeasurement: canonicalMeasurementJson(linked) };
  assert.deepEqual(bytes, g.canonical);
  for (const [key,value] of Object.entries(bytes)) assert.equal(sha(value), g.sha256[key], key);
  assert.deepEqual(action.publicReviewedSourceAction(f.source, { workspaceId: f.state.workspace.id }), f.source);
  assert.equal(f.source.context.origin, 'owner_manual'); assert.equal(f.source.context.originatingObjective, null);
});

test('actual v2 producer and one dispatch capture exact historical origin, independently reconstruct stable approval and survive JSONB order', async () => {
  const f = await objectivePublicationFixture(), c = f.source.context, p = c.proposal;
  assert.equal(f.source.schema, 'runvara-reviewed-source-action/v2');
  assert.equal(c.schema, 'runvara-recorded-action-context/v2');
  assert.deepEqual(c.proposal, f.write.objectivePolicyProposal);
  assert.deepEqual(c.originatingObjective, { workspaceId: f.workspaceId, id: p.source.objectiveId, revision: p.source.objectiveRevision, digest: p.source.objectiveDigest });
  const mutable = new Set(['status','decidedAt','decidedBy','decisionNote','history','workStatus','executedExternally','executionStatus']);
  const stable = Object.fromEntries(Object.entries(f.approval).filter(([k]) => !mutable.has(k)));
  stable.payload = { connectionWriteId: f.approval.payload.connectionWriteId, digest: f.approval.payload.digest };
  assert.deepEqual(c.stableApproval, stable);
  assert.equal(digest(stable), p.approvalDigest, 'full independently reconstructed approval body binds the captured proposal');
  assert.equal(digest(unsigned(c.approval)), c.approval.digest, 'the decision is a separate digest');
  assert.equal(digest(unsigned(f.source)), f.source.digest);
  assert.deepEqual(action.resolveRecordedActionEvidence(reversed(f.state), f.write.id), f.source);
  assert.deepEqual(action.validateReviewedSourceAction(reversed(f.source), { workspaceId: f.workspaceId }), f.source);
  assert.deepEqual(f.counts, { job: 3, credentials: 1, saves: 3, fresh: 2, mutations: 1 });
  const before = structuredClone(f.source), historicalState = structuredClone(f.state);
  historicalState.products = []; historicalState.businessObjectives = []; f.database.tables.set('runvara_agent_jobs', []);
  assert.deepEqual(action.resolveRecordedActionEvidence(historicalState, f.write.id), before, 'historical linking does not re-execute a current objective/job check');
  historicalState.connectionWrites = []; historicalState.approvals = []; historicalState.connections = [];
  assert.deepEqual(action.validateReviewedSourceAction(before, { workspaceId: f.workspaceId }), before, 'immutable reuse needs no mutable action or approval row');
});

test('captured objective binding mutations cannot survive re-signing the outer source', async t => {
  const f = await objectivePublicationFixture();
  const mutations = {
    tenant: s => { s.context.workspaceId = 'foreign'; },
    action: s => { s.context.writeId = 'other_action'; },
    request: s => { s.context.requestId = 'different_request_0001'; },
    claim: s => { s.context.claimIdentity = 'a'.repeat(64); },
    account: s => { s.context.account = 'foreign.myshopify.com'; },
    result: s => { s.context.resultId = 'gid://shopify/Product/999'; },
    requester: s => { s.context.requestedBy = 'another_owner'; },
    decision: s => { s.context.approval.decidedBy = 'another_owner'; },
    product: s => { s.input.productId = 'gid://shopify/Product/999'; },
    input: s => { s.input.description += ' Changed after execution'; },
    origin: s => { s.context.origin = 'owner_manual'; },
    nullOrigin: s => { s.context.originatingObjective = null; },
    goal: s => { s.context.originatingObjective.id = 'other_objective'; },
    goalRevision: s => { s.context.originatingObjective.revision++; },
    goalDefinition: s => { s.context.originatingObjective.digest = 'b'.repeat(64); },
    stableApproval: s => { s.context.stableApproval.reason += ' Forged'; },
    absentStable: s => { delete s.context.stableApproval; },
    absentProposal: s => { delete s.context.proposal; },
    absentSource: s => { delete s.context.proposal.source; },
    absentEpoch: s => { delete s.context.proposal.source.actorSessionVersion; },
    sourceVersion: s => { s.context.proposal.source.schema = 'runvara-objective-content-source/v999'; },
    envelopeVersion: s => { s.schema = 'runvara-reviewed-source-action/v999'; },
    contextVersion: s => { s.context.schema = 'runvara-recorded-action-context/v999'; },
    proposalVersion: s => { s.context.proposal.schema = 'runvara-objective-dispatch-proposal/v999'; },
    duplicatePolicy: s => { s.context.policies.push(structuredClone(s.context.policies[0])); },
    publicPrivateMix: s => { s.schema = 'runvara-reviewed-source-action-display/v2'; },
    unknownRoot: s => { s.future = { private: 'CANARY' }; },
    unknownStable: s => { s.context.stableApproval.future = { private: 'CANARY' }; },
    unknownEvidence: s => { s.context.stableApproval.evidence[0].binding = 'CANARY'; },
    tenantAlias: s => { s.context.stableApproval.evidence[0].tenantId = 'foreign'; },
    stablePayloadAlias: s => { s.context.stableApproval.payload.source = { actorSessionVersion: 1 }; },
    malformedUnicode: s => { s.context.stableApproval.reason = '\ud800'; },
    nullByte: s => { s.context.stableApproval.reason = 'a\0b'; }
  };
  for (const key of ['objectiveId','objectiveRevision','objectiveDigest','jobId','jobIdentityDigest','reportId','payloadDigest','resultDigest','actorId','actorSessionVersion','inputFingerprint','opportunityId','opportunityDigest','productId','productDigest','approvalSourceDigest']) {
    mutations[`source:${key}`] = s => { const source = s.context.proposal.source; source[key] = typeof source[key] === 'number' ? source[key] + 1 : source[key].replace(/[a-z0-9]$/, x => x === 'a' ? 'b' : 'a'); };
  }
  for (const [label,mutate] of Object.entries(mutations)) await t.test(label, () => {
    const source = structuredClone(f.source); mutate(source); resign(source);
    assert.throws(() => action.validateReviewedSourceAction(source, { workspaceId: f.workspaceId }));
  });
});

test('matching forged approval digest strings do not replace independent stable approval verification', async () => {
  const f = await objectivePublicationFixture(), s = structuredClone(f.source), c = s.context;
  c.proposal.approvalDigest = 'a'.repeat(64);
  c.proposal.digest = digest(unsigned(c.proposal));
  c.approval.payload.objectivePolicyProposalDigest = c.proposal.digest;
  c.approval.digest = digest(unsigned(c.approval));
  // Rebuild every downstream public consistency hash, so rejection must still
  // require the independent stable approval body, not just matching strings.
  c.claimIdentity = action.reviewedActionClaimIdentity(s.input, c); resign(s);
  assert.throws(() => action.validateReviewedSourceAction(s, { workspaceId: f.workspaceId }));
  c.stableApproval.reason = 'A changed stable body';
  assert.throws(() => action.validateReviewedSourceAction(resign(s), { workspaceId: f.workspaceId }));
});

test('independently derivable job/report/payload bindings and private stable-body cap survive matching downstream hashes', async t => {
  const f = await objectivePublicationFixture();
  const downstream = source => {
    const c = source.context;
    c.proposal.approvalDigest = digest(c.stableApproval); c.proposal.digest = digest(unsigned(c.proposal));
    c.approval.payload.objectivePolicyProposalDigest = c.proposal.digest; c.approval.digest = digest(unsigned(c.approval));
    c.claimIdentity = action.reviewedActionClaimIdentity(source.input, c); return resign(source);
  };
  for (const [label, mutate] of [
    ['security epoch vs prepared payload', s => { s.context.proposal.source.actorSessionVersion++; }],
    ['job identity vs generated report', s => { s.context.proposal.source.jobId = 'job_different_history'; }],
    ['report plus evidence reference', s => { s.context.proposal.source.reportId = 'objective_review_' + 'a'.repeat(32); s.context.stableApproval.evidence[0].id = s.context.proposal.source.reportId; }]
  ]) await t.test(label, () => {
    const source = structuredClone(f.source); mutate(source); downstream(source);
    assert.throws(() => action.validateReviewedSourceAction(source, { workspaceId: f.workspaceId }));
  });
  const large = structuredClone(f.source);
  for (const key of ['reason','expectedBenefit','risk']) large.context.stableApproval[key] = '雪'.repeat(1000);
  downstream(large);
  assert.ok(Buffer.byteLength(canonical(large.context.stableApproval)) > 8192);
  assert.ok(Buffer.byteLength(canonical(large)) < 24576, 'stable-body cap is independently tighter than the whole source cap');
  assert.throws(() => action.validateReviewedSourceAction(large, { workspaceId: f.workspaceId }), { code: 'OUTCOME_ACTION_TOO_LARGE' });
});

test('fresh association requires unique retained action, request, claim, approval and account identities', async t => {
  const original = await objectivePublicationFixture();
  const mutations = {
    omittedContext: f => { delete f.connectionWrites[0].recordedActionContext; },
    forgedContext: f => { f.connectionWrites[0].recordedActionContext = { acknowledged: true }; },
    duplicateAction: f => { f.connectionWrites.push(structuredClone(f.connectionWrites[0])); },
    duplicateRequest: f => { const w = structuredClone(f.connectionWrites[0]); w.id += '_copy'; w.dispatchClaim.id += '_copy'; f.connectionWrites.push(w); },
    duplicateClaim: f => { const w = structuredClone(f.connectionWrites[0]); w.id += '_copy'; w.requestId += '_copy'; f.connectionWrites.push(w); },
    duplicateApproval: f => { f.approvals.push(structuredClone(f.approvals[0])); },
    duplicateConnection: f => { f.connections.push(structuredClone(f.connections[0])); },
    changedStableApproval: f => { f.approvals[0].reason += ' altered'; },
    changedApprovedPayload: f => { f.approvals[0].payload.digest = 'a'.repeat(64); },
    changedSource: f => { f.connectionWrites[0].objectivePolicyProposal.source.actorSessionVersion++; },
    crossTenantAction: f => { f.connectionWrites[0].tenant_id = 'foreign'; },
    crossTenantApproval: f => { f.approvals[0].tenant = { id: 'foreign' }; },
    crossTenantConnection: f => { f.connections[0].workspaceId = 'foreign'; },
    failed: f => { f.connectionWrites[0].status = 'failed'; },
    uncertain: f => { f.connectionWrites[0].status = 'uncertain'; },
    notApproved: f => { f.approvals[0].status = 'pending'; },
    phaseRequest: f => { f.connectionWrites[0].dispatchClaim.phases.shopify_mutation.requestDigest = 'a'.repeat(64); }
  };
  for (const [label,mutate] of Object.entries(mutations)) await t.test(label, () => {
    const state = structuredClone(original.state); mutate(state);
    assert.throws(() => action.resolveRecordedActionEvidence(state, original.write.id));
  });
  let getter = false;
  const source = structuredClone(original.source);
  Object.defineProperty(source.context.stableApproval, 'reason', { enumerable: true, get() { getter = true; return 'a'; } });
  assert.throws(() => action.validateReviewedSourceAction(source, { workspaceId: original.workspaceId })); assert.equal(getter, false);
});

test('explicit v2 selection binds only the captured descriptive association and uses a new measurement/report schema', async () => {
  const f = await objectivePublicationFixture(), input = objectivePublicationMeasurementInput({ actionSelection: { actionId: f.write.id } });
  const context = { workspaceId: f.workspaceId, experimentId: 'experiment_objective', actorId: f.session.userId, now: new Date(), previousMeasurement: null };
  assert.throws(() => prepareExperimentOutcomeMeasurement(input, context));
  assert.throws(() => prepareExperimentOutcomeMeasurement(objectivePublicationMeasurementInput(), { ...context, actionEvidence: f.source }));
  const m = prepareExperimentOutcomeMeasurement(input, { ...context, actionEvidence: f.source });
  assert.equal(m.schema, 'runvara-experiment-measurement/v3'); assert.equal(m.report.schema, 'runvara-measurement-report/v3');
  assert.equal(m.intervention.schema, 'runvara-owner-action-association/v2'); assert.equal(m.intervention.origin, 'owner_objective_content');
  assert.equal(m.intervention.comparison, 'not_established'); assert.deepEqual(m.intervention.originatingObjective, f.source.context.originatingObjective);
  assert.equal(m.links.objective, null); assert.equal(m.links.opportunity, null);
  assert.deepEqual(m.report.facts.intervention, m.intervention);
  assert.deepEqual(validateExperimentOutcomeMeasurement(reversed(m), { workspaceId: f.workspaceId, experimentId: context.experimentId, now: new Date() }), m);
  assert.throws(() => prepareExperimentOutcomeMeasurement(objectivePublicationMeasurementInput({ expectedRevision: 1 }), { ...context, previousMeasurement: m }));
  const unlinked = prepareExperimentOutcomeMeasurement(objectivePublicationMeasurementInput({ expectedRevision: 1, actionSelection: null }), { ...context, previousMeasurement: m });
  assert.equal(unlinked.schema, 'runvara-experiment-measurement/v1'); assert.equal(unlinked.revision, 2);
  const changed = structuredClone(m); changed.schema = 'runvara-experiment-measurement/v2';
  assert.throws(() => validateExperimentOutcomeMeasurement(changed, { workspaceId: f.workspaceId, experimentId: context.experimentId, now: new Date() }));
});

test('completed old v2 requests without captured context remain unavailable with no backfill, save or provider replay', async () => {
  const f = await objectiveContentFixture(); await f.run();
  delete f.write.recordedActionContext; f.write.recordedActionUnavailable = 'objective_origin_unsupported';
  const before = JSON.stringify(f.write), counts = structuredClone(f.counts);
  await f.run(); assert.equal(JSON.stringify(f.write), before); assert.deepEqual(f.counts, counts);
  assert.throws(() => action.resolveRecordedActionEvidence(f.state, f.write.id));
});

test('objective public display is exact, detached, bounded and does not claim browser private-digest reconstruction', async () => {
  const f = await objectivePublicationFixture(), before = JSON.stringify(f.source);
  const display = action.publicReviewedSourceAction(f.source, { workspaceId: f.workspaceId });
  assert.deepEqual(Object.keys(display).sort(), ['schema','action','approval','origin','originatingObjective','account','productId','completedAt','input','decision','policies','validation'].sort());
  assert.equal(display.schema, 'runvara-reviewed-source-action-display/v2');
  assert.deepEqual(display.validation, { snapshot: 'server_validated_immutable_publication', currentStatus: 'not_checked', providerAuthentication: 'not_established', causalAttribution: 'not_established' });
  assert.deepEqual(display.input, f.write.input);
  assert.equal(display.action.digest, f.source.digest);
  assert.notEqual(digest(unsigned(display)), f.source.digest, 'public bytes cannot independently recreate a private source digest');
  for (const k of ['context','proposal','source','stableApproval','claimId','claimIdentity','dispatchRequestDigest','actorSessionVersion','requestId','snapshotDigest']) assert.equal(JSON.stringify(display).includes(`"${k}":`), false, k);
  assert.ok(Buffer.byteLength(canonical(display)) <= 24576);
  display.input.description = 'changed browser copy'; assert.equal(JSON.stringify(f.source), before);
  const mixed = structuredClone(f.source); mixed.context.stableApproval.future = { private: 'NESTED_PRIVATE_CANARY' }; resign(mixed);
  assert.throws(() => action.publicReviewedSourceAction(mixed, { workspaceId: f.workspaceId }), 'a mixed private/public schema must fail closed, never fall back to raw data');
});

test('actual approval producer retains its exact maximum-length reason ending in sliced whitespace', async () => {
  const prepared = await objectiveContentFixture();
  const prefixLength = prepared.state.approvals[0].reason.length - prepared.body.description.length;
  const description = 'a'.repeat(999 - prefixLength) + ' retained text after the cut';
  const f = await objectivePublicationFixture({ contentInput: { description } });
  assert.equal(f.approval.reason.length, 1000); assert.equal(f.approval.reason.at(-1), ' ');
  assert.deepEqual(f.source.context.stableApproval.reason, f.approval.reason);
  assert.equal(digest(f.source.context.stableApproval), f.source.context.proposal.approvalDigest);
});

test('excluded mutable approval history and flags do not change the exact captured stable binding or resolved source', async t => {
  const f = await objectivePublicationFixture();
  const changes = {
    largeHistory: approval => { approval.history = Array.from({ length: 1000 }, (_, index) => ({ index, note: 'Irrelevant mutable history '.repeat(10) })); },
    unsafeNumericHistory: approval => { approval.history = [{ amount: 1.25, counter: Number.MAX_SAFE_INTEGER + 1, approximate: 1e100 }]; },
    mutableFlags: approval => { approval.history = []; approval.decisionNote = 'Updated explanatory note'; approval.workStatus = 'ARCHIVED'; approval.executedExternally = false; approval.executionStatus = 'historical'; }
  };
  for (const [label,change] of Object.entries(changes)) await t.test(label, () => {
    const state = structuredClone(f.state), approval = state.approvals.find(row => row.id === f.write.approvalId);
    change(approval); const before = JSON.stringify(approval);
    const stable = action.recordedStableApproval(approval);
    assert.deepEqual(stable, f.source.context.stableApproval);
    assert.equal(digest(stable), f.source.context.proposal.approvalDigest);
    assert.deepEqual(action.resolveRecordedActionEvidence(state, f.write.id), f.source);
    assert.equal(JSON.stringify(approval), before, 'stable selection never rewrites the excluded mutable fields');
  });
});

test('mutable-history parity does not relax stable/decision identity, exact approval keys or descriptor safety', async t => {
  const f = await objectivePublicationFixture();
  const changes = {
    stableReason: approval => { approval.reason += ' changed'; },
    decision: approval => { approval.decidedBy = 'different_owner'; },
    status: approval => { approval.status = 'pending'; },
    decisionPayload: approval => { approval.payload.objectivePolicyProposalDigest = 'a'.repeat(64); },
    unknownRoot: approval => { approval.futurePrivate = 'unknown'; },
    missingMutableKey: approval => { delete approval.history; },
    unknownPayload: approval => { approval.payload.futurePrivate = 'unknown'; }
  };
  for (const [label,change] of Object.entries(changes)) await t.test(label, () => {
    const state = structuredClone(f.state), approval = state.approvals.find(row => row.id === f.write.approvalId);
    approval.history = [{ unrelated: Number.MAX_SAFE_INTEGER + 1 }]; change(approval);
    assert.throws(() => action.resolveRecordedActionEvidence(state, f.write.id));
  });
  for (const field of ['stableText','stableEvidence','stablePayload','decision']) await t.test(`accessor:${field}`, () => {
    const state = structuredClone(f.state), approval = state.approvals.find(row => row.id === f.write.approvalId);
    let invoked = false;
    const object = field === 'stableEvidence' ? approval.evidence[0] : field === 'stablePayload' ? approval.payload : approval;
    const key = field === 'stableEvidence' ? 'detail' : field === 'stablePayload' ? 'digest' : field === 'decision' ? 'decidedBy' : 'reason';
    Object.defineProperty(object, key, { enumerable: true, get() { invoked = true; return 'getter result'; } });
    assert.throws(() => action.recordedStableApproval(approval));
    assert.throws(() => action.resolveRecordedActionEvidence(state, f.write.id));
    assert.equal(invoked, false, 'neither stable projection nor fresh resolution may invoke approval accessors');
  });
});

test('forward selected review enforces exact origin choice schema, unique references and unchanged response budgets', async t => {
  const f = await objectivePublicationFixture(), c = f.source.context;
  const choice = { id: f.write.id, account: c.account, productId: f.source.input.productId, title: f.source.input.title,
    completedAt: c.completedAt, digest: f.source.digest, origin: c.origin, originatingObjective: c.originatingObjective };
  const base = { workspaceId: f.workspaceId, workspaceRevision: f.state._revision, experiment: { id: 'experiment_objective', title: 'Selected experiment', status: 'measured' },
    measurement: null, current: null, actionLinkContract: 'runvara-reviewed-action/v2', actionChoices: [choice], currentActionAssociation: null };
  const changes = {
    duplicate: r => r.actionChoices.push(structuredClone(choice)),
    tooMany: r => { r.actionChoices = Array.from({ length: 21 }, (_, i) => ({ ...structuredClone(choice), id: `write_${i}` })); },
    tooManyBytes: r => { r.actionChoices = Array.from({ length: 20 }, (_, i) => ({ ...structuredClone(choice), id: `write_${i}`, title: '雪'.repeat(200) })); },
    missingOrigin: r => { delete r.actionChoices[0].origin; },
    missingGoal: r => { delete r.actionChoices[0].originatingObjective; },
    manualOrigin: r => { r.actionChoices[0].origin = 'owner_manual'; },
    nullGoal: r => { r.actionChoices[0].originatingObjective = null; },
    foreignGoal: r => { r.actionChoices[0].originatingObjective.workspaceId = 'foreign'; },
    goalAlias: r => { r.actionChoices[0].originatingObjective.tenantId = 'foreign'; },
    privateEnvelope: r => { r.actionChoices[0].source = f.source; },
    futureNested: r => { r.actionChoices[0].originatingObjective.future = { stableApproval: 'PRIVATE_CANARY' }; },
    oldMarker: r => { r.actionLinkContract = 'runvara-reviewed-action/v1'; },
    unknownMarker: r => { r.actionLinkContract = 'runvara-reviewed-action/v999'; },
    responseLimit: r => { r.actionChoices[0].title = 'a'.repeat(131072); }
  };
  for (const [name,change] of Object.entries(changes)) await t.test(name, async () => {
    const result = structuredClone(base); change(result); const before = JSON.stringify(result); let reads = 0;
    const adapter = createBusinessOutcomePersistence({ request: async (_path, options) => { reads++; assert.equal(options.maxResponseBytes, 131072); return result; } });
    await assert.rejects(adapter.review(f.workspaceId, 'experiment_objective'));
    assert.equal(reads, 1); assert.equal(JSON.stringify(result), before, 'invalid remote response is never rewritten');
  });
  let reads = 0;
  const adapter = createBusinessOutcomePersistence({ request: async (_path, options) => { reads++; assert.equal(options.maxResponseBytes, 131072); return structuredClone(base); } });
  const result = await adapter.review(f.workspaceId, 'experiment_objective');
  assert.deepEqual(result.actionChoices, [choice]); assert.equal(reads, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(result.actionChoices)) <= 16384); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 131072);
});
