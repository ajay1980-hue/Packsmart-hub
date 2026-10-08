import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveBusinessGraph, deriveBusinessGraphSummary, REVIEWED_OUTCOME_GRAPH_BYTES } from '../lib/business-graph.mjs';
import { createBusinessOutcomeCandidate, correctBusinessOutcomeCandidate, withdrawBusinessOutcomeCandidate, projectCurrentOutcomeReferences } from '../lib/business-outcomes.mjs';
import { objectiveCanonicalDigest } from '../lib/objective-dispatch-policy.mjs';
import { objectiveContentApprovalDigest } from '../lib/objective-content-source.mjs';
import { publishedActionGraphFixture, publishedGraphOptions, publishedGraphInput, graphHash } from './published-action-graph-fixture.mjs';
import { fixture as apiFixture } from './business-outcomes-api-fixture.mjs';

const manual = await publishedActionGraphFixture(), objective = await publishedActionGraphFixture({ kind: 'objective' });
const relationships = graph => graph.reviewedOutcomes.records[0];
const publicationEdges = graph => graph.edges.filter(edge => edge.relation.startsWith('publication_recorded_'));
function integrity(graph) {
  const nodes = new Set(graph.nodes.map(node => node.id));
  assert.equal(nodes.size, graph.nodes.length);
  for (const edge of graph.edges) { assert.ok(nodes.has(edge.from)); assert.ok(nodes.has(edge.to)); }
  for (const row of graph.reviewedOutcomes.records) for (const link of [row.relationship, row.requestRelationship, row.approvalRelationship]) {
    if (link.status === 'resolved') assert.ok(nodes.has(link.targetNodeId), 'resolved target remains in this output');
  }
  assert.equal(graph.summary.nodes, graph.nodes.length); assert.equal(graph.summary.edges, graph.edges.length);
}
function resign(state) {
  const write = state.connectionWrites[0], approval = state.approvals[0], proposal = write.objectivePolicyProposal;
  write.digest = graphHash(write.input); approval.payload.digest = write.digest;
  if (!proposal) return;
  proposal.inputDigest = write.digest; proposal.approvalDigest = objectiveContentApprovalDigest(approval);
  const { digest, ...body } = proposal; proposal.digest = objectiveCanonicalDigest(body);
  approval.payload.objectivePolicyProposalDigest = proposal.digest;
}

test('manual and objective current payloads bridge exact retained pairs through the real bounded adapter', async () => {
  for (const f of [manual, objective]) {
    let reads = 0;
    const options = await publishedGraphOptions([f.version], { onRead: () => reads++ });
    const state = structuredClone(f.state), before = JSON.stringify(state), graph = deriveBusinessGraph(state, options), row = relationships(graph);
    assert.equal(JSON.stringify(state), before); assert.equal(reads, 1); integrity(graph);
    for (const link of [row.requestRelationship, row.approvalRelationship]) {
      assert.equal(link.status, 'resolved'); assert.equal(link.reason, null); assert.equal(link.snapshotContentCompared, false);
    }
    assert.deepEqual(publicationEdges(graph).map(edge => edge.relation).sort(), ['publication_recorded_approval', 'publication_recorded_request']);
    assert.ok(publicationEdges(graph).every(edge => edge.provenance.basis === 'recorded-publication-reference'));
    assert.equal(graph.reviewedOutcomes.counts.resolvedRequestLinks, 1); assert.equal(graph.reviewedOutcomes.counts.resolvedApprovalLinks, 1);
    assert.equal(graph.reviewedOutcomes.snapshots.independent, true);
    assert.notEqual(graph.reviewedOutcomes.snapshots.workspace.readCompletedAt, graph.reviewedOutcomes.snapshots.outcomes.readCompletedAt);
    for (const key of ['snapshotContentCompared', 'immutableExecutionProof', 'goalProgressEstablished', 'causalAttribution', 'executionAuthorized', 'learningAuthorized']) assert.equal(graph.reviewedOutcomes.safeguards[key], false);
    assert.equal(f.version.links.objective, null); assert.equal(f.version.links.opportunity, null);
    assert.equal(graph.edges.some(edge => edge.from === row.nodeId && /objective|opportunity/.test(edge.relation)), false);
    assert.equal(graph.reviewedOutcomes.groups[0].amount, '10.25'); assert.equal(options.outcomeSnapshot.summary.groups[0].learningComparable, false);
    const encoded = JSON.stringify(graph);
    for (const value of [f.write.id, f.write.requestId, f.write.approvalId, f.write.account, f.write.requestedBy, f.write.input.title, f.write.input.description,
      f.sourceAction.digest, f.version.links.approval.digest, f.sourceAction.context.claimIdentity, 'private_graph_owner', 'private_graph_workspace_revision', 'private_graph_commit_revision']) {
      assert.equal(encoded.includes(value), false, `Private value is absent: ${value.slice(0, 16)}`);
    }
  }
});

test('unlinked publications stay not recorded and mixed/unsupported compact pairs stay explicitly unresolved', async () => {
  for (const [links, reason] of [[{}, null], [{ action: manual.version.links.action }, 'invalid_reference_pair'],
    [{ approval: manual.version.links.approval }, 'invalid_reference_pair'],
    [{ ...manual.version.links, action: { ...manual.version.links.action, revision: 2 } }, 'invalid_reference_pair'],
    [{ ...manual.version.links, approval: { ...manual.version.links.approval, revision: 2 } }, 'invalid_reference_pair']]) {
    const version = createBusinessOutcomeCandidate({ ...manual.input, links }, { workspaceId: manual.state.workspace.id, now: manual.now });
    const options = await publishedGraphOptions([version]), graph = deriveBusinessGraph(manual.state, options), row = relationships(graph);
    for (const link of [row.requestRelationship, row.approvalRelationship]) {
      assert.equal(link.status, reason ? 'unresolved' : 'not_recorded'); assert.equal(link.reason, reason); assert.equal(link.snapshotContentCompared, false);
    }
    assert.equal(publicationEdges(graph).length, 0); assert.equal(graph.reviewedOutcomes.groups[0].amount, '10.25');
    const projection = projectCurrentOutcomeReferences([version], { workspaceId: manual.state.workspace.id, now: options.now, publicationBoundary: options.outcomeSnapshot.publicationBoundary });
    assert.equal(projection.records[0].actionReferences, null);
  }
});

test('compact references require trusted current proof and reject malformed or foreign links', async () => {
  const projection = projectCurrentOutcomeReferences([manual.version], { workspaceId: manual.state.workspace.id, now: manual.now, publicationBoundary: manual.options.outcomeSnapshot.publicationBoundary });
  assert.deepEqual(projection.records[0].actionReferences, {
    action: { id: manual.write.id, revision: 1, digest: manual.version.links.action.digest },
    approval: { id: manual.approval.id, revision: 1, digest: manual.version.links.approval.digest }
  });
  for (const publicationBoundary of [{}, structuredClone(manual.options.outcomeSnapshot.publicationBoundary), projection]) {
    const graph = deriveBusinessGraph(manual.state, { ...manual.options, outcomeSnapshot: { versions: [manual.version], publicationBoundary } });
    assert.equal(graph.reviewedOutcomes.status, 'unavailable'); assert.equal(publicationEdges(graph).length, 0);
  }
  for (const mutate of [v => { v.links.action.digest = 'malformed'; }, v => { v.links.action.id = ''; }, v => { v.links.approval.extra = 'private'; }]) {
    const version = structuredClone(manual.version); mutate(version);
    await assert.rejects(publishedGraphOptions([version]));
  }
  const foreign = structuredClone(manual.version); foreign.links.action.workspaceId = 'foreign';
  await assert.rejects(publishedGraphOptions([foreign]));
});

test('exact primary identity excludes aliases, request IDs, titles and product IDs', () => {
  const collisions = [manual.write.requestId, manual.write.input.productId, manual.write.input.title, 'different-primary'];
  for (const id of collisions) {
    const state = structuredClone(manual.state); state.connectionWrites[0].externalId = manual.write.id; state.connectionWrites[0].id = id;
    const graph = deriveBusinessGraph(state, manual.options); integrity(graph);
    assert.equal(relationships(graph).requestRelationship.reason, 'unresolved_reference');
    assert.equal(relationships(graph).approvalRelationship.reason, 'paired_request_unresolved');
    assert.equal(publicationEdges(graph).length, 0);
  }
  const aliases = structuredClone(manual.state);
  aliases.connectionWrites.push({ ...aliases.connectionWrites[0], id: 'write_other', requestId: 'other_request_0001', externalId: manual.write.id, approvalId: 'other_approval' });
  aliases.approvals.push({ id: 'other_approval', status: 'approved', externalId: manual.approval.id, payload: { connectionWriteId: 'write_other', digest: manual.write.digest } });
  const graph = deriveBusinessGraph(aliases, manual.options); assert.equal(relationships(graph).requestRelationship.status, 'resolved');
  assert.equal(relationships(graph).approvalRelationship.status, 'resolved');
});

test('missing, archived, duplicated, malformed and incomplete retained targets explain each failed pair', async t => {
  for (const [collection, relation, paired] of [['connectionWrites', 'requestRelationship', 'approvalRelationship'], ['approvals', 'approvalRelationship', 'requestRelationship']]) {
    for (const [name, change, options, reason] of [
      ['missing', s => { s[collection] = []; }, {}, 'unresolved_reference'],
      ['archived status', s => { s[collection][0].status = 'archived'; }, {}, 'archived_reference'],
      ['archived marker', s => { s[collection][0].archived = true; }, {}, 'archived_reference'],
      ['duplicate', s => { s[collection].push(structuredClone(s[collection][0])); }, {}, 'ambiguous_reference'],
      ['invalid status', s => { s[collection][0].status = 'INVALID'; }, {}, 'invalid_record'],
      ['unknown collection', s => { delete s[collection]; }, {}, 'target_index_incomplete'],
      ['malformed collection', s => { s[collection] = {}; }, {}, 'target_index_incomplete'],
      ['truncated collection', s => { s[collection].push({ ...s[collection][0], id: 'other' }); }, { recordLimit: 1 }, 'target_index_incomplete']
    ]) await t.test(`${collection}: ${name}`, () => {
      const state = structuredClone(manual.state); change(state); const graph = deriveBusinessGraph(state, { ...manual.options, ...options });
      assert.equal(relationships(graph)[relation].reason, reason); assert.equal(relationships(graph)[paired].reason, collection === 'connectionWrites' ? 'paired_request_unresolved' : 'paired_approval_unresolved');
      assert.equal(publicationEdges(graph).length, 0); integrity(graph);
    });
  }
});

test('current reciprocal mutation and unsupported proposals never create published pair edges', async t => {
  for (const [name, fixture, mutate, reason] of [
    ['changed write approval', manual, s => { s.connectionWrites[0].approvalId = 'other'; }, 'approval_binding_mismatch'],
    ['changed reciprocal write', manual, s => { s.approvals[0].payload.connectionWriteId = 'other'; }, 'approval_binding_mismatch'],
    ['changed input', manual, s => { s.connectionWrites[0].input.title = 'Changed with old digest'; }, 'approval_binding_mismatch'],
    ['changed approval digest', manual, s => { s.approvals[0].payload.digest = graphHash('different'); }, 'approval_binding_mismatch'],
    ['second reciprocal approval', manual, s => { s.approvals.push({ ...s.approvals[0], id: 'second_approval' }); }, 'approval_binding_mismatch'],
    ['duplicate request ID', manual, s => { s.connectionWrites.push({ ...s.connectionWrites[0], id: 'write_other' }); }, 'source_identity_ambiguous'],
    ['unsupported proposal', manual, s => { s.connectionWrites[0].objectivePolicyProposal = { schema: 'future' }; }, 'unsupported_proposal'],
    ['mutated v2 stable approval', objective, s => { s.approvals[0].reason = 'Changed'; }, 'approval_binding_mismatch'],
    ['mutated v2 proposal', objective, s => { s.connectionWrites[0].objectivePolicyProposal.inputDigest = graphHash('different'); }, 'invalid_proposal']
  ]) await t.test(name, () => {
    const state = structuredClone(fixture.state); mutate(state); const graph = deriveBusinessGraph(state, fixture.options);
    assert.equal(relationships(graph).requestRelationship.reason, reason); assert.equal(relationships(graph).approvalRelationship.reason, reason);
    assert.equal(publicationEdges(graph).length, 0); integrity(graph);
  });
});

test('coherently changed mutable content still resolves identity without comparing different digest contracts', () => {
  for (const f of [manual, objective]) {
    const state = structuredClone(f.state); state.connectionWrites[0].input.title = 'Coherently changed current content'; resign(state);
    assert.notEqual(f.version.links.action.digest, state.connectionWrites[0].digest);
    const graph = deriveBusinessGraph(state, f.options), row = relationships(graph); integrity(graph);
    assert.equal(row.requestRelationship.status, 'resolved'); assert.equal(row.approvalRelationship.status, 'resolved');
    assert.equal(row.requestRelationship.snapshotContentCompared, false); assert.equal(row.approvalRelationship.snapshotContentCompared, false);
    assert.equal(graph.reviewedOutcomes.groups[0].amount, '10.25');
  }
});

test('foreign retained data fails closed and consumed accessors never run', () => {
  for (const select of [s => s.connectionWrites[0], s => s.connectionWrites[0].input, s => s.approvals[0], s => s.approvals[0].payload]) {
    const state = structuredClone(manual.state); select(state).workspaceId = 'foreign';
    assert.throws(() => deriveBusinessGraph(state, manual.options), { code: 'WORKSPACE_MISMATCH' });
  }
  const state = structuredClone(manual.state); let calls = 0;
  Object.defineProperty(state.connectionWrites[0].input, 'title', { enumerable: true, get() { calls++; throw Error('Private getter'); } });
  Object.defineProperty(state, 'jobs', { get() { calls++; throw Error('Must not hydrate jobs'); } });
  const graph = deriveBusinessGraph(state, manual.options);
  assert.equal(calls, 0); assert.equal(relationships(graph).requestRelationship.reason, 'target_index_incomplete');
  assert.equal(publicationEdges(graph).length, 0);
});

test('correction/reuse/withdrawal keeps version-bound relationship identities and separate qualification', async () => {
  const replacement = structuredClone(manual.input); replacement.amount = '-2'; replacement.source.measurementRevision = 2;
  replacement.source.measurementDigest = graphHash('correction'); replacement.verification.measurementDigest = replacement.source.measurementDigest;
  const corrected = correctBusinessOutcomeCandidate(manual.version, replacement, { workspaceId: 'tenant-a', now: manual.now });
  const withdrawn = withdrawBusinessOutcomeCandidate(corrected, { reason: 'incorrect_measurement', verification: corrected.verification }, { workspaceId: 'tenant-a', now: manual.now });
  const graphs = await Promise.all([manual.version, corrected, withdrawn].map(async version => deriveBusinessGraph(manual.state, await publishedGraphOptions([version]))));
  assert.ok(graphs.every(graph => relationships(graph).nodeId === relationships(graphs[0]).nodeId));
  for (const relation of ['publication_recorded_request', 'publication_recorded_approval']) assert.equal(new Set(graphs.map(graph => graph.edges.find(edge => edge.relation === relation).id)).size, 3);
  assert.equal(graphs[1].reviewedOutcomes.groups[0].amount, '-2'); assert.deepEqual(graphs[2].reviewedOutcomes.groups, []);
  assert.equal(relationships(graphs[2]).status, 'withdrawn'); assert.equal(relationships(graphs[2]).requestRelationship.status, 'resolved');
  const missing = structuredClone(manual.state); missing.connectionWrites = []; missing.approvals = [];
  const historical = deriveBusinessGraph(missing, await publishedGraphOptions([corrected]));
  assert.equal(relationships(historical).requestRelationship.reason, 'unresolved_reference'); assert.equal(historical.reviewedOutcomes.groups[0].amount, '-2');
});

test('bounds account for new references, reasons and version-bound edges without changing grouping', async () => {
  const limited = deriveBusinessGraph(manual.state, { ...manual.options, edgeLimit: 2 }); integrity(limited);
  assert.ok(publicationEdges(limited).length < 2); assert.ok(limited.reviewedOutcomes.omitted.relationships > 0);
  assert.ok([relationships(limited).requestRelationship, relationships(limited).approvalRelationship].some(link => link.reason === 'edge_limit'));
  const rows = Array.from({ length: 50 }, (_, index) => createBusinessOutcomeCandidate(publishedGraphInput(`experiment_${index}`, manual.version.links), { workspaceId: 'tenant-a', now: manual.now }));
  const options = await publishedGraphOptions(rows), state = structuredClone(manual.state);
  state.revenueEngine.experiments = rows.map(row => ({ id: row.source.experimentId }));
  for (const scanLimit of [1, 3, 8, 20, 80]) {
    const graph = deriveBusinessGraph(state, { ...options, scanLimit }); assert.ok(graph.coverage.scannedRecords <= scanLimit); integrity(graph);
  }
  const summary = deriveBusinessGraphSummary(state, options);
  assert.ok(Buffer.byteLength(JSON.stringify(summary), 'utf8') <= REVIEWED_OUTCOME_GRAPH_BYTES.summary);
  assert.ok(summary.reviewedOutcomes.omitted.records > 0); assert.ok(summary.reviewedOutcomes.omitted.relationships >= summary.reviewedOutcomes.omitted.records * 3);
  const graph = deriveBusinessGraph(state, { ...options, unknownLimit: 1 }); integrity(graph);
  assert.equal(options.outcomeSnapshot.summary.groups[0].learningComparable, false);
  assert.equal(graph.reviewedOutcomes.counts.qualifiedMeasurements, 50, 'identity edges do not alter existing measurement qualification');
  assert.equal(summary.reviewedOutcomes.groups[0].amount, '512.5');
  const byteLimited = deriveBusinessGraph(state, options); integrity(byteLimited);
  assert.ok(byteLimited.reviewedOutcomes.records.some(row => row.requestRelationship.reason === 'output_byte_limit'));
  assert.ok(byteLimited.reviewedOutcomes.omitted.relationships > byteLimited.reviewedOutcomes.omitted.records * 3);
  const extension = { ...byteLimited, nodes: byteLimited.nodes.filter(node => node.type === 'reviewed_outcome'),
    edges: byteLimited.edges.filter(edge => edge.relation === 'measurement_recorded_for_experiment' || edge.relation.startsWith('publication_recorded_')),
    unknownMappings: byteLimited.unknownMappings.filter(row => row.relation === 'measurement_recorded_for_experiment' || row.relation.startsWith('publication_recorded_')) };
  assert.ok(Buffer.byteLength(JSON.stringify(extension), 'utf8') <= REVIEWED_OUTCOME_GRAPH_BYTES.detail);
  const reused = rows.map(row => {
    const input = publishedGraphInput(row.source.experimentId, manual.version.links);
    input.provenance.sourceRefs = manual.input.provenance.sourceRefs;
    return createBusinessOutcomeCandidate(input, { workspaceId: 'tenant-a', now: manual.now });
  });
  const conflicts = deriveBusinessGraph(state, { ...await publishedGraphOptions(reused), recordLimit: 1 });
  assert.equal(conflicts.reviewedOutcomes.counts.qualifiedMeasurements, 0, 'whole-snapshot shared-report qualification precedes truncation');
  assert.deepEqual(conflicts.reviewedOutcomes.groups, []);
});

test('authenticated graph API reads one existing workspace and head snapshot for every role without hydration or writes', async t => {
  const f = await apiFixture(t, { primaryState: objective.state });
  f.states.get(f.primaryWorkspace).revenueEngine.experiments = structuredClone(objective.state.revenueEngine.experiments);
  for (const joined of objective.joinedRows) f.rows.set(joined.version_id, structuredClone(joined.version));
  for (const role of ['owner', 'admin', 'member', 'viewer']) {
    const before = { reads: f.counts.gets, calls: f.calls.length, saves: f.counts.saves };
    const response = await f.request('/api/business-graph?outcomes=current&detail=true', { identity: f.auth(f.primaryWorkspace, role) });
    assert.equal(response.status, 200); assert.equal(f.counts.gets, before.reads + 1); assert.equal(f.calls.length, before.calls + 1); assert.equal(f.counts.saves, before.saves);
    assert.equal(relationships(response.body).requestRelationship.status, 'resolved'); assert.equal(relationships(response.body).approvalRelationship.status, 'resolved'); integrity(response.body);
    const { path, options } = f.calls.at(-1); assert.match(path, /runvara_business_outcome_heads/); assert.match(path, /limit=51$/);
    assert.equal(path.includes('source_action'), false); assert.equal(path.includes('source_measurement'), false); assert.equal(options.maxResponseBytes, 2 * 1024 * 1024);
    for (const secret of [objective.write.id, objective.approval.id, objective.write.input.title, objective.write.account, objective.sourceAction.digest]) assert.equal(JSON.stringify(response.body).includes(secret), false);
  }
  const foreign = await f.request('/api/business-graph?outcomes=current&detail=true', { identity: f.auth('outcome-beta', 'viewer') });
  assert.equal(foreign.status, 200); assert.equal(foreign.body.reviewedOutcomes.records.length, 0);
  const injected = await f.request('/api/business-graph?outcomes=current&workspaceId=tenant-a'); assert.equal(injected.status, 400);
  const anonymous = await f.request('/api/business-graph?outcomes=current', { identity: null }); assert.equal(anonymous.status, 401);
  // A later workspace mutation cannot rewrite the snapshot already read for
  // this request. The next explicit inspection describes the missing targets.
  const current = f.store.businessOutcomeSummary;
  f.store.businessOutcomeSummary = async workspaceId => {
    const state = f.states.get(workspaceId); state.connectionWrites = []; state.approvals = [];
    return current(workspaceId);
  };
  const separate = await f.request('/api/business-graph?outcomes=current&detail=true');
  assert.equal(relationships(separate.body).requestRelationship.status, 'resolved');
  assert.equal(separate.body.reviewedOutcomes.snapshots.independent, true);
  const later = await f.request('/api/business-graph?outcomes=current&detail=true');
  assert.equal(relationships(later.body).requestRelationship.reason, 'unresolved_reference');
  assert.equal(later.body.reviewedOutcomes.groups[0].amount, '10.25');
  assert.equal(f.counts.saves, 0); assert.equal(f.counts.providerCalls, 0);
});
