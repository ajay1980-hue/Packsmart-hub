import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deriveBusinessGraph, deriveBusinessGraphSummary, RETAINED_REQUEST_GRAPH_BYTES, REVIEWED_OUTCOME_GRAPH_BYTES } from '../lib/business-graph.mjs';
import { objectiveContentFixture } from './objective-content-fixture.mjs';
import { objectiveCanonicalDigest, OBJECTIVE_DISPATCH_PROPOSAL_SCHEMA } from '../lib/objective-dispatch-policy.mjs';
import { objectiveContentApprovalDigest } from '../lib/objective-content-source.mjs';
import { createOutcomePublicationBoundary } from '../lib/business-outcomes.mjs';

const prepared = await objectiveContentFixture();
const state = () => structuredClone(prepared.state);
const record = graph => graph.retainedRequests.records[0];
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function frozen(value) { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value; }
function resign(snapshot) {
  const write = snapshot.connectionWrites[0], envelope = write.objectivePolicyProposal;
  const approval = snapshot.approvals.find(row => row.id === write.approvalId);
  if (envelope.schema !== OBJECTIVE_DISPATCH_PROPOSAL_SCHEMA) envelope.approvalDigest = objectiveContentApprovalDigest(approval);
  const { digest: _digest, ...body } = envelope; envelope.digest = objectiveCanonicalDigest(body);
  approval.payload.objectivePolicyProposalDigest = envelope.digest;
}
function cloneRequest(snapshot, index) {
  const write = structuredClone(snapshot.connectionWrites[0]), approval = structuredClone(snapshot.approvals[0]);
  write.id = `write_copy_${index}`; write.requestId = `copied_request_number_${index}`; write.approvalId = `approval_copy_${index}`;
  approval.id = write.approvalId; approval.payload.connectionWriteId = write.id;
  Object.assign(write.objectivePolicyProposal, { writeId: write.id, approvalId: write.approvalId });
  const mini = { connectionWrites: [write], approvals: [approval] }; resign(mini);
  snapshot.connectionWrites.push(write); snapshot.approvals.push(approval);
}
function integrity(graph) {
  const ids = new Set(graph.nodes.map(row => row.id));
  assert.equal(ids.size, graph.nodes.length);
  for (const edge of graph.edges) { assert.ok(ids.has(edge.from)); assert.ok(ids.has(edge.to)); }
  for (const mapping of graph.unknownMappings) assert.ok(ids.has(mapping.subjectId));
  for (const row of graph.retainedRequests.records) {
    assert.ok(ids.has(row.nodeId));
    for (const link of [row.approval, row.objective]) if (link.status === 'resolved') assert.ok(ids.has(link.targetNodeId));
  }
  assert.equal(graph.summary.nodes, graph.nodes.length); assert.equal(graph.summary.edges, graph.edges.length);
  assert.equal(graph.summary.nodes, Object.values(graph.summary.nodesByType).reduce((a, b) => a + b, 0));
  assert.equal(graph.summary.edges, Object.values(graph.summary.edgesByRelation).reduce((a, b) => a + b, 0));
}
function emptyCurrent(snapshot) {
  return { inspectCurrentOutcomes: true, outcomeSnapshot: { versions: [], publicationBoundary: createOutcomePublicationBoundary({
    workspaceId: snapshot.workspace.id, snapshotId: 'retained-tests', complete: true, expectedOutcomeCount: 0, resolveCommittedPublication: () => null }) } };
}

test('real v2 preparation projects only redacted recorded history from frozen state with no extra reads or effects', () => {
  const source = frozen(state()), before = JSON.stringify(source), graph = deriveBusinessGraph(source);
  assert.equal(JSON.stringify(source), before); integrity(graph);
  assert.equal(graph.retainedRequests.counts.projectedObjectives, 1); assert.equal(graph.retainedRequests.counts.projectedRequests, 1);
  assert.equal(record(graph).origin, 'owner_objective_content'); assert.equal(record(graph).approval.status, 'resolved');
  assert.equal(record(graph).approval.recordedStatus, 'approved'); assert.equal(record(graph).objective.status, 'resolved');
  assert.equal(record(graph).objective.revisionComparison, 'matches_retained_definition');
  assert.deepEqual(graph.edges.filter(row => row.relation.startsWith('request_')).map(row => row.relation).sort(), ['request_recorded_approval', 'request_recorded_objective']);
  for (const value of [prepared.write.id, prepared.write.requestId, prepared.write.approvalId, prepared.objective.id,
    prepared.write.account, prepared.write.requestedBy, prepared.write.input.title, prepared.write.input.description, prepared.job.id,
    prepared.write.objectivePolicyProposal.source.opportunityId]) assert.equal(JSON.stringify(graph.retainedRequests).includes(value), false);
  assert.deepEqual(prepared.counts, { job: 0, credentials: 0, saves: 0, fresh: 0, mutations: 0 });
  assert.equal(graph.summary.verifiedOutcomeRecords, 0); assert.equal(graph.summary.recordedOutcomeRecords, 0);
  assert.equal(graph.retainedRequests.coverage.currentSourceChecked, false); assert.equal(graph.retainedRequests.coverage.archiveReadsPerformed, 0);
  assert.ok(Object.values(graph.retainedRequests.safeguards).every(value => value === false));
});

test('manual v1 restriction sets and no-envelope legacy rows never gain objective origin', () => {
  const source = state(), write = source.connectionWrites[0], envelope = write.objectivePolicyProposal;
  delete envelope.source; delete envelope.approvalId; delete envelope.approvalDigest;
  envelope.schema = OBJECTIVE_DISPATCH_PROPOSAL_SCHEMA; envelope.origin = 'owner_manual';
  envelope.policies.push({ objectiveId: 'objective_11111111-1111-4111-8111-111111111111', revision: 9, digest: 'b'.repeat(64) });
  resign(source);
  const manual = deriveBusinessGraph(source); assert.equal(record(manual).origin, 'owner_manual');
  assert.equal(record(manual).approval.status, 'resolved'); assert.equal(record(manual).objective.status, 'not_recorded');
  delete write.objectivePolicyProposal; delete source.approvals[0].payload.objectivePolicyProposalDigest;
  const legacy = deriveBusinessGraph(source); assert.equal(record(legacy).origin, 'not_recorded');
  assert.equal(record(legacy).approval.status, 'resolved'); assert.equal(record(legacy).objective.status, 'not_recorded');
  write.input.title = 'Changed with the old stored digest';
  assert.equal(record(deriveBusinessGraph(source)).approval.reason, 'approval_binding_mismatch');
});

test('every request and saved objective state is recorded without source freshness or execute permission', async t => {
  for (const status of ['pending_approval', 'ready', 'executing', 'processing', 'completed', 'uncertain', 'failed', 'rejected']) await t.test(status, () => {
    const source = state(); source.connectionWrites[0].status = status;
    source.approvals[0].status = status === 'rejected' ? 'rejected' : status === 'pending_approval' ? 'pending' : 'approved';
    const graph = deriveBusinessGraph(source); assert.equal(record(graph).recordedStatus, status); assert.equal(record(graph).objective.status, 'resolved');
    assert.equal(record(graph).approval.recordedStatus, source.approvals[0].status);
    assert.equal(graph.nodes.find(row => row.type === 'connection_write').attributes.status, status);
  });
  for (const status of ['active', 'paused', 'disabled', 'completed', 'cancelled']) await t.test(`objective ${status}`, () => {
    const source = state(); source.businessObjectives[0].status = status;
    const graph = deriveBusinessGraph(source); assert.equal(graph.retainedRequests.objectives[0].recordedStatus, status);
    assert.equal(record(graph).objective.status, 'resolved'); assert.equal(graph.retainedRequests.coverage.currentSourceChecked, false);
  });
  for (const [now, expected] of [[new Date(Date.parse(prepared.objective.startsAt) - 1).toISOString(), 'scheduled'],
    [new Date(Date.parse(prepared.objective.endsAt) + 1).toISOString(), 'expired']]) {
    const graph = deriveBusinessGraph(state(), { now }); assert.equal(graph.retainedRequests.objectives[0].effectiveStatus, expected);
    assert.equal(record(graph).objective.revisionComparison, 'matches_retained_definition');
  }
});

test('historical objective association survives changed revisions and definitions without looking up jobs/opportunities', () => {
  const source = state(); source.businessObjectives[0].revision++;
  source.opportunities[0].status = 'dismissed'; source.opportunities.push(structuredClone(source.opportunities[0]));
  delete source.users; delete source.connections; delete source.connectionSettings;
  Object.defineProperty(source, 'jobs', { get() { assert.fail('No job reads'); } });
  const graph = deriveBusinessGraph(source); assert.equal(record(graph).objective.status, 'resolved');
  assert.equal(record(graph).objective.recordedRevision, 1); assert.equal(record(graph).objective.savedRevision, 2);
  assert.equal(record(graph).objective.revisionComparison, 'saved_revision_changed');
  source.businessObjectives[0].revision = 1; source.businessObjectives[0].title = 'Changed saved definition';
  assert.equal(record(deriveBusinessGraph(source)).objective.revisionComparison, 'saved_definition_changed');
  assert.equal(graph.edges.some(row => row.from === record(graph).nodeId && row.relation.includes('opportunity')), false);
});

test('duplicate source/target IDs, aliases and conflicting reciprocal approvals never establish unique links', async t => {
  const cases = [
    ['duplicate write ID', s => { const copy = structuredClone(s.connectionWrites[0]); copy.requestId += '_other'; s.connectionWrites.push(copy); }, 'approval', 'source_identity_ambiguous'],
    ['duplicate request ID', s => { cloneRequest(s, 1); s.connectionWrites[1].requestId = s.connectionWrites[0].requestId; }, 'objective', 'source_identity_ambiguous'],
    ['duplicate approval ID', s => s.approvals.push(structuredClone(s.approvals[0])), 'approval', 'ambiguous_reference'],
    ['duplicate objective ID', s => s.businessObjectives.push(structuredClone(s.businessObjectives[0])), 'objective', 'ambiguous_reference'],
    ['approval external alias', s => { s.approvals[0].externalId = s.approvals[0].id; s.approvals[0].id = 'different-primary'; }, 'approval', 'unresolved_reference'],
    ['conflicting reciprocal approval', s => { const other = structuredClone(s.approvals[0]); other.id = 'other-approval'; s.approvals.push(other); }, 'approval', 'approval_binding_mismatch'],
    ['mismatched input binding', s => { s.approvals[0].payload.digest = 'b'.repeat(64); }, 'approval', 'approval_binding_mismatch'],
    ['mismatched reciprocal write', s => { s.approvals[0].payload.connectionWriteId = 'other-write'; }, 'approval', 'approval_binding_mismatch'],
    ['independent approval digest', s => { s.approvals[0].reason = 'Changed presentation'; }, 'approval', 'approval_binding_mismatch'],
    ['proposal approval digest', s => { s.approvals[0].payload.objectivePolicyProposalDigest = 'b'.repeat(64); }, 'approval', 'approval_binding_mismatch']
  ];
  for (const [name, mutate, link, expected] of cases) await t.test(name, () => {
    const source = state(); mutate(source); const graph = deriveBusinessGraph(source); integrity(graph);
    assert.equal(record(graph)[link].status, 'unresolved'); assert.equal(record(graph)[link].reason, expected);
  });
  const source = state(); source.businessObjectives[0].externalId = source.businessObjectives[0].id;
  source.businessObjectives[0].id = 'objective_11111111-1111-4111-8111-111111111111';
  assert.equal(record(deriveBusinessGraph(source)).objective.status, 'unresolved');
});

test('missing, archived, invalid and incomplete retained targets stay explicitly unresolved', async t => {
  for (const collection of ['businessObjectives', 'approvals']) await t.test(collection, () => {
    const link = collection === 'approvals' ? 'approval' : 'objective';
    for (const marker of ['status', 'archived', 'archivedAt']) {
      const source = state(); source[collection][0][marker] = marker === 'status' ? 'archived' : marker === 'archived' ? true : '2026-01-01';
      assert.equal(record(deriveBusinessGraph(source))[link].reason, 'archived_reference');
    }
    const absent = state(); absent[collection] = []; assert.equal(record(deriveBusinessGraph(absent))[link].reason, 'unresolved_reference');
    const invalid = state(); invalid[collection] = {}; assert.equal(record(deriveBusinessGraph(invalid))[link].reason, 'target_index_incomplete');
    const incomplete = state(); incomplete[collection].push(structuredClone(incomplete[collection][0]));
    const graph = deriveBusinessGraph(incomplete, { recordLimit: 1 }); assert.equal(record(graph)[link].reason, 'target_index_incomplete');
    assert.equal(graph.retainedRequests.status, 'incomplete');
  });
  const source = state(); source.businessObjectives[0].revision = 0;
  assert.equal(record(deriveBusinessGraph(source)).objective.status, 'unresolved');
  assert.equal(deriveBusinessGraph(source).retainedRequests.coverage.complete, false);
});

test('malformed, unsupported and inconsistent retained envelopes never expose a v2 association', async t => {
  const cases = [
    ['unsupported version', s => { s.connectionWrites[0].objectivePolicyProposal.schema = 'runvara-objective-dispatch-proposal/v9'; }],
    ['unknown source field', s => { s.connectionWrites[0].objectivePolicyProposal.source.extra = true; resign(s); }],
    ['source actor', s => { s.connectionWrites[0].objectivePolicyProposal.source.actorId = 'other-owner'; resign(s); }],
    ['source product', s => { s.connectionWrites[0].objectivePolicyProposal.source.productId = 'gid://shopify/Product/99'; resign(s); }],
    ['source revision', s => { s.connectionWrites[0].objectivePolicyProposal.source.objectiveRevision++; resign(s); }],
    ['input digest', s => { s.connectionWrites[0].input.title = 'Retained input changed'; }],
    ['provider', s => { s.connectionWrites[0].provider = 'unsupported-provider'; }],
    ['operation', s => { s.connectionWrites[0].input.operation = 'unsupported-operation'; }],
    ['account', s => { s.connectionWrites[0].account = 'other.myshopify.com'; }],
    ['requester', s => { s.connectionWrites[0].requestedBy = 'other-owner'; }],
    ['write id', s => { s.connectionWrites[0].objectivePolicyProposal.writeId = 'write_other'; resign(s); }],
    ['approval id', s => { s.connectionWrites[0].objectivePolicyProposal.approvalId = 'approval_other'; resign(s); }],
    ['wrong envelope digest', s => { s.connectionWrites[0].objectivePolicyProposal.digest = 'f'.repeat(64); }],
    ['oversized valid JSON', s => { s.connectionWrites[0].objectivePolicyProposal.extra = '🙂'.repeat(3000); }]
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const source = state(); mutate(source); const graph = deriveBusinessGraph(source);
    assert.equal(graph.retainedRequests.records.length, 1); assert.equal(record(graph).origin, 'invalid');
    assert.equal(record(graph).objective.status, 'unresolved'); assert.equal(record(graph).approval.status, 'unresolved'); integrity(graph);
  });
  const coherent = state(); coherent.connectionWrites[0].input.title = 'Coherently rewritten title';
  coherent.connectionWrites[0].digest = sha(coherent.connectionWrites[0].input);
  coherent.connectionWrites[0].objectivePolicyProposal.inputDigest = coherent.connectionWrites[0].digest;
  coherent.approvals[0].payload.digest = coherent.connectionWrites[0].digest; resign(coherent);
  const graph = deriveBusinessGraph(coherent); assert.equal(record(graph).objective.status, 'resolved');
  assert.equal(graph.retainedRequests.safeguards.immutableExecutionProof, false);
});

test('foreign scope is checked before provider/status/origin filters without executing accessors', async t => {
  for (const selector of [s => s.connectionWrites[0], s => s.connectionWrites[0].input,
    s => s.connectionWrites[0].objectivePolicyProposal, s => s.connectionWrites[0].objectivePolicyProposal.source,
    s => s.approvals[0], s => s.approvals[0].payload, s => s.approvals[0].evidence[0],
    s => s.businessObjectives[0], s => s.businessObjectives[0].limits, s => s.businessObjectives[0].executionPolicy.scope]) {
    for (const marker of ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id', 'workspace', 'tenant']) {
      const source = state(); source.connectionWrites[0].provider = 'unsupported'; source.connectionWrites[0].status = 'alien';
      selector(source)[marker] = ['workspace', 'tenant'].includes(marker) ? { id: 'foreign' } : 'foreign';
      assert.throws(() => deriveBusinessGraph(source), { code: 'WORKSPACE_MISMATCH' });
    }
  }
  for (const path of ['write-id', 'input-title', 'proposal-source', 'approval-payload', 'approval-history', 'objective-status', 'collection', 'array-row']) await t.test(path, () => {
    const source = state(); let calls = 0;
    const targets = { 'write-id': [source.connectionWrites[0], 'id'], 'input-title': [source.connectionWrites[0].input, 'title'],
      'proposal-source': [source.connectionWrites[0].objectivePolicyProposal, 'source'], 'approval-payload': [source.approvals[0], 'payload'],
      'approval-history': [source.approvals[0], 'history'], 'objective-status': [source.businessObjectives[0], 'status'],
      collection: [source, 'connectionWrites'], 'array-row': [source.connectionWrites, '0'] };
    const [target, key] = targets[path]; Object.defineProperty(target, key, { enumerable: true, configurable: true, get() { calls++; throw Error('Do not execute'); } });
    const graph = deriveBusinessGraph(source); assert.equal(calls, 0); assert.equal(graph.retainedRequests.coverage.complete, false);
  });
});

test('nested validation, source scans, node/edge/unknown and UTF-8 output budgets are shared and explicit', () => {
  const source = state(); source.connectionWrites[0].objectivePolicyProposal.policies = Array.from({ length: 26 }, (_, index) => ({
    objectiveId: `objective_${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`, revision: 1, digest: 'a'.repeat(64) }));
  const nested = deriveBusinessGraph(source, { nestedLimit: 25 }); assert.equal(nested.retainedRequests.coverage.complete, false);
  assert.equal(nested.retainedRequests.omitted.requests, 1);
  for (const scanLimit of [1, 5, 8, 15, 20]) {
    const graph = deriveBusinessGraph(state(), { scanLimit }); assert.ok(graph.coverage.scannedRecords <= scanLimit);
    assert.equal(graph.coverage.complete, false); integrity(graph);
  }
  const nodes = deriveBusinessGraph(state(), { nodeLimit: 2 }); assert.ok(nodes.nodes.length <= 2); assert.equal(nodes.retainedRequests.omitted.requests, 1); integrity(nodes);
  const edges = deriveBusinessGraph(state(), { edgeLimit: 1 }); assert.equal(record(edges).approval.reason, 'edge_limit'); integrity(edges);
  const missing = state(); delete missing.connectionWrites[0].objectivePolicyProposal; missing.approvals = [];
  for (let index = 1; index < 10; index++) missing.connectionWrites.push({ ...missing.connectionWrites[0], id: `write_${index}`, requestId: `request_number_${index}` });
  const unknown = deriveBusinessGraph(missing, { unknownLimit: 1 }); assert.ok(unknown.unknownMappings.length <= 1); assert.ok(unknown.retainedRequests.omitted.mappings > 0);
  const large = state(); for (let index = 1; index < 120; index++) cloneRequest(large, index);
  const detail = deriveBusinessGraph(large, { recordLimit: 200, nodeLimit: 1000, edgeLimit: 1000, scanLimit: 10000 });
  assert.ok(Buffer.byteLength(JSON.stringify(detail.retainedRequests), 'utf8') <= RETAINED_REQUEST_GRAPH_BYTES.detail);
  assert.ok(detail.retainedRequests.omitted.requests > 0); assert.equal(detail.retainedRequests.coverage.complete, false); integrity(detail);
  const summary = deriveBusinessGraphSummary(large, emptyCurrent(large));
  assert.ok(Buffer.byteLength(JSON.stringify(summary.retainedRequests), 'utf8') <= RETAINED_REQUEST_GRAPH_BYTES.summary);
  assert.ok(Buffer.byteLength(JSON.stringify(summary), 'utf8') <= REVIEWED_OUTCOME_GRAPH_BYTES.summary);
  assert.equal(summary.reviewedOutcomes.status, 'available'); assert.equal(summary.reviewedOutcomes.counts.currentHeadsRead, 0);
  assert.equal(summary.retainedRequests.status, 'incomplete');
});

test('a duplicate request after the retained scan prefix cannot revive uniqueness', () => {
  const source = state(); cloneRequest(source, 1); source.connectionWrites[1].requestId = source.connectionWrites[0].requestId;
  const graph = deriveBusinessGraph(source, { recordLimit: 1 });
  assert.equal(record(graph).approval.reason, 'source_index_incomplete'); assert.equal(record(graph).objective.reason, 'source_index_incomplete');
  assert.equal(graph.retainedRequests.omitted.requests, 1);
});


test('unknown source collections and unsupported typed states do not claim complete history', () => {
  for (const collection of ['businessObjectives', 'connectionWrites', 'approvals']) {
    const source = state(); delete source[collection]; const graph = deriveBusinessGraph(source);
    assert.equal(graph.retainedRequests.coverage.complete, false);
    assert.equal(graph.coverage.sources.find(row => row.collection === collection).totalKnown, false);
    if (collection !== 'connectionWrites') assert.equal(record(graph)[collection === 'approvals' ? 'approval' : 'objective'].reason, 'target_index_incomplete');
  }
  const empty = state(); empty.businessObjectives = []; empty.connectionWrites = []; empty.approvals = [];
  assert.equal(deriveBusinessGraph(empty).retainedRequests.coverage.complete, true);
  for (const collection of ['connectionWrites', 'approvals', 'businessObjectives']) {
    const source = state(); source[collection][0].status = 'unsupported'; const graph = deriveBusinessGraph(source);
    assert.equal(graph.retainedRequests.coverage.complete, false);
    assert.equal(record(graph)[collection === 'businessObjectives' ? 'objective' : 'approval'].reason, 'invalid_record');
  }
});

test('v2 bounded identities match the real producer contract even after a coherent rewrite', () => {
  for (const [field, value] of [['id', 'not-a-write'], ['requestId', 'short'], ['connectionId', 'not a connection'], ['approvalId', 'not an approval']]) {
    const source = state(), write = source.connectionWrites[0]; write[field] = value;
    if (field === 'id') { write.objectivePolicyProposal.writeId = value; source.approvals[0].payload.connectionWriteId = value; }
    if (field === 'connectionId') write.objectivePolicyProposal.connectionId = value;
    if (field === 'approvalId') { source.approvals[0].id = value; write.objectivePolicyProposal.approvalId = value; }
    resign(source); assert.equal(record(deriveBusinessGraph(source)).objective.status, 'unresolved');
  }
});


test('invalid primary approval identities make the exact index incomplete, including unrelated retained rows', () => {
  for (const invalidRow of [{ status: 'approved' }, { id: 42, status: 'approved' }, { id: '', status: 'pending' }, { id: ' padded ', status: 'approved' }]) {
    const source = state(); source.approvals.push(invalidRow); const graph = deriveBusinessGraph(source);
    assert.equal(graph.coverage.sources.find(row => row.collection === 'approvals').invalid, 1);
    assert.equal(graph.retainedRequests.coverage.complete, false);
    assert.equal(record(graph).approval.reason, 'target_index_incomplete');
    assert.equal(record(graph).objective.status, 'unresolved'); integrity(graph);
  }
  const unrelated = state(); unrelated.approvals.push({ id: 'unrelated-approval', status: 'approved', payload: null });
  const graph = deriveBusinessGraph(unrelated); assert.equal(record(graph).approval.status, 'resolved');
  assert.equal(record(graph).objective.status, 'resolved'); assert.equal(graph.retainedRequests.coverage.complete, true);
});
