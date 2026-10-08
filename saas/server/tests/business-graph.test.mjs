import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { deriveBusinessGraph, deriveBusinessGraphSummary, REVIEWED_OUTCOME_GRAPH_BYTES } from '../lib/business-graph.mjs';
import { createBusinessOutcomeCandidate, correctBusinessOutcomeCandidate, withdrawBusinessOutcomeCandidate, createOutcomePublicationBoundary } from '../lib/business-outcomes.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';

const costs = () => ({ landed: 2, packing: 0.2, handling: 0.1, delivery: 1, paymentFee: 0.3, channelFee: 0.4, advertising: 0, otherVariable: 0, supplierId: 's1' });
function fixture(workspaceId = 'tenant-a') {
  const state = seedWorkspaceState({}, { workspaceId });
  state.businessObjectives = []; state.connectionWrites = [];
  state.products = [
    { id: 'p1', externalId: 'external-p1', provider: 'shopify', title: 'Mailing bags', status: 'active', variants: [{ id: 'v1', externalId: 'external-v1', sku: 'BAGS', price: 10, inventory: 50 }] },
    { id: 'p2', provider: 'shopify', title: 'Boxes', variants: [{ id: 'v2', sku: 'BOXES', price: 12 }] }
  ];
  state.economics = { BAGS: costs(), BOXES: { landed: 3 }, ORPHAN: { landed: 1 } };
  state.suppliers = [{ id: 's1', name: 'Packaging supplier', active: true }];
  state.ebay = { source: 'ebay-oauth-readonly', listings: [{ id: 'offer1', offerId: 'offer1', listingId: 'listing1', sku: 'BAGS', status: 'PUBLISHED' }], drafts: [{ id: 'draft1', sku: 'UNKNOWN', status: 'UNPUBLISHED' }] };
  state.orders = [
    { id: 'order1', provider: 'shopify', financialStatus: 'PAID', customerId: 'customer1', customerEmail: 'private@example.com', lineItems: [{ id: 'line1', sku: 'BAGS', quantity: 2 }] },
    { id: 'order2', provider: 'shopify', customerEmail: 'private@example.com', lineItems: [{ id: 'line2', sku: 'NO-COST', quantity: 1 }] }
  ];
  state.channelData = { shopify: { customers: [{ id: 'customer1', numberOfOrders: 2 }] } };
  state.marketing.campaigns = [{ id: 'campaign1', status: 'draft', product: { productId: 'p1', variantId: 'v1', sku: 'BAGS' }, channels: ['meta', 'pinterest'], publish: { approvalRequired: true, approvalId: 'approval1' }, copy: { longCaption: 'A campaign prompt and private body' } }];
  state.opportunities = [{ id: 'opportunity1', status: 'requires_approval', approvalId: 'approval1', experimentId: 'experiment1', evidence: [{ type: 'economics', id: 'BAGS' }, { type: 'product', id: 'p1' }, { type: 'variant', id: 'external-v1' }] }];
  state.approvals = [{ id: 'approval1', status: 'approved', executionStatus: 'executed', financialImpact: 9000, payload: { opportunityId: 'opportunity1', experimentId: 'experiment1', campaignId: 'campaign1' }, impact: { verified: true, contributionProtected: 20 } }];
  state.workRecords = [{ id: 'work1', status: 'COMPLETED', approvalId: 'approval1', title: 'Private user command', evidence: [{ impact: { id: 'impact1', verified: true, incrementalContribution: 30, method: 'holdout' } }] }];
  state.revenueEngine.experiments = [{ id: 'experiment1', status: 'completed', opportunityId: 'opportunity1', approvalId: 'approval1', impact: { verified: true, incrementalContribution: 50, method: 'holdout' } }];
  return state;
}
function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
const nodesOf = (graph, type) => graph.nodes.filter(node => node.type === type);
const edgesOf = (graph, relation) => graph.edges.filter(edge => edge.relation === relation);
const nodeAt = (graph, pointer, type) => graph.nodes.find(node => node.sourceRef.pointer === pointer && (!type || node.type === type));
function assertIntegrity(graph) {
  const ids = new Set(graph.nodes.map(node => node.id));
  assert.equal(ids.size, graph.nodes.length);
  assert.equal(new Set(graph.edges.map(edge => edge.id)).size, graph.edges.length);
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.from), 'edge source exists in the same projection');
    assert.ok(ids.has(edge.to), 'edge target exists in the same projection');
    assert.equal(edge.provenance.sourceRef.workspaceId, graph.workspaceId);
  }
  for (const mapping of graph.unknownMappings) assert.ok(ids.has(mapping.subjectId));
}

const OUTCOME_NOW = '2026-10-07T00:00:00.000Z';
const outcomeHash = value => createHash('sha256').update(value).digest('hex');
function reviewedInput(experimentId = 'experiment1', patch = {}) {
  const measurementDigest = outcomeHash(`measurement:${experimentId}`);
  return { source: { type: 'experiment_measurement', experimentId, measurementRevision: 1, measurementDigest },
    metric: 'incrementalContribution', amount: '0', currency: 'GBP',
    window: { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' },
    coverage: { status: 'complete', scopeId: `scope_${experimentId}`, observedCount: 10, expectedCount: 10 },
    method: { kind: 'holdout', definitionVersion: 'incremental-contribution/v1' },
    provenance: { observationId: `observation_${experimentId}`, sourceRefs: [{ type: 'measurement_report', id: `private_report_${experimentId}`, digest: outcomeHash(`report:${experimentId}`) }], observedAt: '2026-10-06T12:00:00.000Z', aggregation: 'non_overlapping_scopes_attested' },
    verification: { kind: 'owner_attestation', actorId: 'private_owner', verifiedAt: '2026-10-06T14:00:00.000Z', measurementDigest }, ...patch };
}
const reviewedVersion = (experimentId, patch, workspaceId = 'tenant-a') => createBusinessOutcomeCandidate(reviewedInput(experimentId, patch), { workspaceId, now: OUTCOME_NOW });
function reviewedOptions(rows, { complete = true, versions = rows, ...rest } = {}) {
  const workspaceId = rows[0]?.workspaceId || 'tenant-a';
  const pairs = new Map(rows.map(version => [version.outcomeId, { version,
    head: { schema: 'runvara-outcome-head/v1', workspaceId, outcomeId: version.outcomeId, versionId: version.versionId, digest: version.digest,
      revision: version.revision, status: version.status === 'withdrawn' ? 'withdrawn' : 'published', publicationId: `publication_${version.revision}`,
      committedAt: '2026-10-06T20:00:00.000Z', commitRevision: 'private_state_revision' } }]));
  return { inspectCurrentOutcomes: true, now: OUTCOME_NOW,
    workspaceSnapshot: { revision: 'private_state_revision', readCompletedAt: '2026-10-06T22:00:00.000Z' },
    outcomeReadCompletedAt: '2026-10-06T22:00:01.000Z', outcomeSnapshot: { versions,
      publicationBoundary: createOutcomePublicationBoundary({ workspaceId, snapshotId: 'private_snapshot', complete,
        expectedOutcomeCount: pairs.size, resolveCommittedPublication: ({ outcomeId }) => pairs.get(outcomeId) }) }, ...rest };
}

test('opt-in current nodes use exact canonical experiment identities without promoting legacy records', () => {
  const state = frozen(fixture()), row = reviewedVersion('experiment1', { amount: '-0.000001' });
  const before = JSON.stringify(state), graph = deriveBusinessGraph(state, reviewedOptions([row]));
  assert.equal(JSON.stringify(state), before); assertIntegrity(graph);
  const reviewed = nodesOf(graph, 'reviewed_outcome')[0], experiment = nodeAt(graph, '/revenueEngine/experiments/0', 'experiment');
  const edge = edgesOf(graph, 'measurement_recorded_for_experiment')[0];
  assert.equal(edge.from, reviewed.id); assert.equal(edge.to, experiment.id);
  assert.equal(graph.reviewedOutcomes.records[0].relationship.targetNodeId, experiment.id);
  assert.equal(graph.reviewedOutcomes.groups[0].amount, '-0.000001');
  assert.equal(graph.reviewedOutcomes.counts.currentHeadsRead, 1); assert.equal(graph.reviewedOutcomes.counts.projectedRecords, 1);
  assert.equal(graph.reviewedOutcomes.coverage.publicationHeadsComplete, true);
  assert.equal(graph.reviewedOutcomes.snapshots.independent, true);
  assert.notEqual(graph.reviewedOutcomes.snapshots.workspace.readCompletedAt, graph.reviewedOutcomes.snapshots.outcomes.readCompletedAt);
  assert.equal(graph.summary.verifiedOutcomeRecords, 0);
  for (const legacy of nodesOf(graph, 'outcome')) assert.equal(legacy.attributes.qualified, false);
  for (const secret of [row.outcomeId, row.versionId, 'experiment1', 'private_owner', 'private_report', 'private_state_revision', 'private_snapshot', row.source.measurementDigest]) {
    assert.equal(JSON.stringify(graph.reviewedOutcomes).includes(secret), false, secret);
  }
  assert.equal(graph.reviewedOutcomes.safeguards.learningAuthorized, false);
  assert.equal(graph.reviewedOutcomes.safeguards.executionAuthorized, false);
});

test('current logical identities survive reorder, correction and withdrawal while version-bound edges advance', () => {
  const state = fixture(), row = reviewedVersion('experiment1');
  state.revenueEngine.experiments.push({ id: 'second', status: 'completed' });
  const initial = deriveBusinessGraph(state, reviewedOptions([row]));
  state.revenueEngine.experiments.reverse();
  state.revenueEngine.experiments[1].outcomeMeasurement = { revision: 999, amount: '999999', digest: 'newer draft' };
  const reordered = deriveBusinessGraph(state, reviewedOptions([row]));
  assert.equal(nodesOf(initial, 'reviewed_outcome')[0].id, nodesOf(reordered, 'reviewed_outcome')[0].id);
  assert.equal(edgesOf(initial, 'measurement_recorded_for_experiment')[0].id, edgesOf(reordered, 'measurement_recorded_for_experiment')[0].id);
  assert.equal(reordered.reviewedOutcomes.groups[0].amount, '0');
  const replacement = reviewedInput('experiment1', { amount: '-3.123456' });
  replacement.source.measurementRevision = 2; replacement.source.measurementDigest = outcomeHash('correction'); replacement.verification.measurementDigest = replacement.source.measurementDigest;
  const correction = correctBusinessOutcomeCandidate(row, replacement, { workspaceId: 'tenant-a', now: OUTCOME_NOW });
  const corrected = deriveBusinessGraph(state, reviewedOptions([correction]));
  assert.equal(nodesOf(initial, 'reviewed_outcome')[0].id, nodesOf(corrected, 'reviewed_outcome')[0].id);
  assert.notEqual(edgesOf(initial, 'measurement_recorded_for_experiment')[0].id, edgesOf(corrected, 'measurement_recorded_for_experiment')[0].id);
  const withdrawal = withdrawBusinessOutcomeCandidate(correction, { reason: 'incorrect_measurement', verification: correction.verification }, { workspaceId: 'tenant-a', now: OUTCOME_NOW });
  const withdrawn = deriveBusinessGraph(state, reviewedOptions([withdrawal]));
  assert.equal(nodesOf(initial, 'reviewed_outcome')[0].id, nodesOf(withdrawn, 'reviewed_outcome')[0].id);
  assert.notEqual(edgesOf(corrected, 'measurement_recorded_for_experiment')[0].id, edgesOf(withdrawn, 'measurement_recorded_for_experiment')[0].id);
  assert.equal(withdrawn.reviewedOutcomes.counts.withdrawnHeads, 1); assert.deepEqual(withdrawn.reviewedOutcomes.groups, []);
  const historical = deriveBusinessGraph(state, reviewedOptions([withdrawal], { versions: [row] }));
  assert.equal(nodesOf(historical, 'reviewed_outcome').length, 0); assert.equal(historical.reviewedOutcomes.status, 'incomplete');
});

test('current experiment references stay unresolved for duplicate aliases, incomplete indexes, archival and output caps', () => {
  const row = reviewedVersion('experiment1');
  for (const [experiments, limits, reason] of [
    [[{ id: 'experiment1' }, { id: 'experiment1' }], {}, 'ambiguous_reference'],
    [[{ id: 'experiment1' }, { id: 'other', externalId: 'experiment1' }], {}, 'ambiguous_reference'],
    [[{ id: 'experiment1' }, { id: 'experiment1' }], { recordLimit: 1 }, 'target_index_incomplete'],
    [[{ id: 'experiment1', status: 'archived' }], {}, 'archived_reference'],
    [[{ id: 'experiment1', archived: true }], {}, 'archived_reference'],
    [[], {}, 'unresolved_reference']
  ]) {
    const graph = deriveBusinessGraph({ workspace: { id: 'tenant-a' }, revenueEngine: { experiments } }, reviewedOptions([row], limits));
    assert.equal(graph.reviewedOutcomes.records[0].relationship.reason, reason); assert.equal(edgesOf(graph, 'measurement_recorded_for_experiment').length, 0);
    assert.equal(nodesOf(graph, 'reviewed_outcome').length, 1); assertIntegrity(graph);
  }
  // A target omitted by the shared node limit must never become a placeholder.
  const capped = deriveBusinessGraph({ workspace: { id: 'tenant-a' }, revenueEngine: { experiments: [{ id: 'experiment1' }] } }, reviewedOptions([row], { nodeLimit: 1 }));
  assert.equal(capped.reviewedOutcomes.counts.projectedRecords, 0); assert.equal(capped.reviewedOutcomes.omitted.records, 1); assertIntegrity(capped);
  const edgeLimited = deriveBusinessGraph(fixture(), reviewedOptions([row], { edgeLimit: 1 }));
  assert.equal(edgeLimited.reviewedOutcomes.records[0].relationship.reason, 'edge_limit'); assert.equal(edgeLimited.reviewedOutcomes.coverage.projectionComplete, false);
});

test('full current snapshot grouping precedes graph limits and never revives overlapping or reused observations', () => {
  const first = reviewedVersion('experiment1', { amount: '10' });
  for (const second of [reviewedVersion('experiment2', { amount: '20', coverage: first.coverage }),
    reviewedVersion('experiment2', { amount: '20', provenance: { ...reviewedInput('experiment2').provenance, sourceRefs: first.provenance.sourceRefs } })]) {
    const graph = deriveBusinessGraph(fixture(), reviewedOptions([first, second], { recordLimit: 1 }));
    assert.equal(graph.reviewedOutcomes.counts.currentHeadsRead, 2); assert.equal(graph.reviewedOutcomes.counts.projectedRecords, 1);
    assert.equal(graph.reviewedOutcomes.records[0].measurementComplete, true); assert.equal(graph.reviewedOutcomes.records[0].qualifiedGroupIncluded, false);
    assert.deepEqual(graph.reviewedOutcomes.groups, []); assert.equal(graph.reviewedOutcomes.counts.qualifiedMeasurements, 0);
  }
  const scoped = [reviewedVersion('experiment1'), reviewedVersion('experiment2', { amount: '-4', currency: 'USD' }),
    reviewedVersion('experiment3', { amount: '9', window: { startsAt: '2026-10-02T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' } })];
  const graph = deriveBusinessGraph(fixture(), reviewedOptions(scoped));
  assert.equal(graph.reviewedOutcomes.groups.length, 3); assert.deepEqual(graph.reviewedOutcomes.groups.map(group => group.amount).sort(), ['-4', '0', '9']);
  assert.equal(graph.reviewedOutcomes.overallAmount, undefined);
  const standalone = deriveBusinessGraph(fixture(), reviewedOptions(['experiment1', 'experiment2'].map(id => reviewedVersion(id, {
    provenance: { ...reviewedInput(id).provenance, aggregation: 'standalone' }
  }))));
  assert.equal(standalone.reviewedOutcomes.groups[0].amount, null);
  assert.equal(standalone.reviewedOutcomes.groups[0].amountStatus, 'standalone_observations');
  assert.ok(standalone.reviewedOutcomes.records.every(row => row.qualifiedGroupIncluded));
});

test('forged summaries, DTOs and incomplete snapshots cannot turn graph records into current totals', () => {
  const row = reviewedVersion('experiment1'), valid = reviewedOptions([row]);
  const copied = structuredClone(valid);
  copied.outcomeSnapshot.publications = [{ version: row, head: { verified: true } }];
  copied.outcomeSnapshot.summary = { coverage: { complete: true }, groups: [{ amount: '999' }] };
  const unavailable = deriveBusinessGraph(fixture(), copied);
  assert.equal(unavailable.reviewedOutcomes.status, 'unavailable'); assert.equal(unavailable.reviewedOutcomes.counts.currentHeadsRead, null);
  assert.equal(unavailable.reviewedOutcomes.counts.publishedHeads, null); assert.deepEqual(unavailable.reviewedOutcomes.groups, []);
  const incompleteOptions = reviewedOptions([row], { complete: false });
  incompleteOptions.outcomeSnapshot.summary = copied.outcomeSnapshot.summary;
  const incomplete = deriveBusinessGraph(fixture(), incompleteOptions);
  assert.equal(incomplete.reviewedOutcomes.counts.currentHeadsRead, 1); assert.equal(incomplete.reviewedOutcomes.coverage.publicationHeadsComplete, false);
  assert.equal(incomplete.reviewedOutcomes.status, 'incomplete'); assert.deepEqual(incomplete.reviewedOutcomes.groups, []);
  const absent = deriveBusinessGraph(fixture(), { inspectCurrentOutcomes: true, outcomeUnavailableReason: 'OUTCOME_STORAGE_UNAVAILABLE' });
  assert.equal(absent.reviewedOutcomes.unavailableReason, 'OUTCOME_STORAGE_UNAVAILABLE');
  const baseline = deriveBusinessGraph(fixture());
  assert.equal(baseline.reviewedOutcomes, undefined);
  assert.deepEqual(deriveBusinessGraph(fixture(), { outcomeSnapshot: valid.outcomeSnapshot }), baseline, 'existing default remains unchanged');
});

test('opt-in graph rejects foreign root, target and private-capability scope markers', () => {
  const row = reviewedVersion('experiment1');
  for (const marker of [{ tenant: 'foreign' }, { tenant: { id: 'foreign' } }, { workspace: 'foreign' }, { workspaceId: 'foreign' }, { tenant_id: 'foreign' }]) {
    const state = fixture(); Object.assign(state.revenueEngine.experiments[0], marker);
    assert.throws(() => deriveBusinessGraph(state, reviewedOptions([row])), { code: 'WORKSPACE_MISMATCH' });
  }
  const state = fixture(); state.workspace.tenantId = 'foreign';
  assert.throws(() => deriveBusinessGraph(state, reviewedOptions([row])), { code: 'WORKSPACE_MISMATCH' });
  assert.throws(() => deriveBusinessGraph(fixture(), reviewedOptions([reviewedVersion('experiment1', {}, 'foreign')])), { code: 'WORKSPACE_MISMATCH' });
});

test('current rows consume shared record, scan, node and UTF-8 extension budgets with explicit omissions', () => {
  const workspaceId = '界'.repeat(250);
  const rows = Array.from({ length: 50 }, (_, index) => reviewedVersion(`experiment_${index}`, {
    amount: '999999999999999999.999999', method: { kind: ['holdout', 'before_after', 'reconciled_manual'][index % 3], definitionVersion: 'incremental-contribution/v1' },
    window: { startsAt: `2026-09-${String(1 + index % 28).padStart(2, '0')}T00:00:00.000Z`, endsAt: '2026-10-06T00:00:00.000Z' }
  }, workspaceId));
  const state = { workspace: { id: workspaceId }, revenueEngine: { experiments: rows.map(row => ({ id: row.source.experimentId })) } };
  for (const derive of [deriveBusinessGraph, deriveBusinessGraphSummary]) {
    const graph = derive(state, reviewedOptions(rows)), current = graph.reviewedOutcomes;
    assert.equal(current.counts.currentHeadsRead, 50);
    assert.ok(current.counts.projectedRecords <= graph.limits.recordLimit);
    const { nodes = [], edges = [], unknownMappings = [], ...metadata } = graph;
    const added = { ...metadata, ...(graph.mode === 'summary' ? {} : {
      nodes: nodes.filter(node => node.type === 'reviewed_outcome'),
      edges: edges.filter(edge => edge.relation === 'measurement_recorded_for_experiment'),
      unknownMappings: unknownMappings.filter(row => row.subjectId.startsWith('reviewed_outcome_')) }) };
    assert.ok(Buffer.byteLength(JSON.stringify(added), 'utf8') <= REVIEWED_OUTCOME_GRAPH_BYTES[graph.mode]);
    assert.ok(current.omitted.groups > 0 || current.omitted.records > 0);
    assert.equal(current.coverage.projectionComplete, false);
    if (graph.mode === 'detail') assertIntegrity(graph);
  }
  const scanLimited = deriveBusinessGraph(state, reviewedOptions(rows, { scanLimit: 1 }));
  assert.equal(scanLimited.coverage.scannedRecords, 1); assert.equal(scanLimited.reviewedOutcomes.counts.projectedRecords, 0);
  assert.equal(scanLimited.reviewedOutcomes.omitted.records, 50); assertIntegrity(scanLimited);
});

test('byte node removal preserves mapping counts when retained unknown output is already saturated', () => {
  const workspaceId = '界'.repeat(256);
  const rows = Array.from({ length: 50 }, (_, index) => reviewedVersion(`experiment_${index}`, {}, workspaceId));
  const state = { workspace: { id: workspaceId }, products: [{ id: 'p', variants: [{ id: 'v' }] }],
    revenueEngine: { experiments: rows.slice(0, 45).map(row => ({ id: row.source.experimentId })) } };
  const baseline = deriveBusinessGraph(state, { unknownLimit: 1 });
  assert.ok(baseline.summary.unknownMappings > baseline.unknownMappings.length);
  const graph = deriveBusinessGraph(state, reviewedOptions(rows, { unknownLimit: 1 }));
  assert.ok(graph.reviewedOutcomes.omitted.records > 0, 'byte cap removes nodes, not merely group rows');
  assert.ok(graph.reviewedOutcomes.counts.projectedRecords > 0);
  assert.equal(graph.reviewedOutcomes.omitted.records, rows.length - graph.reviewedOutcomes.records.length);
  const unknown = graph.reviewedOutcomes.records.filter(row => row.relationship.status === 'unresolved');
  assert.equal(graph.summary.unknownMappings, baseline.summary.unknownMappings + unknown.length);
  const reasons = { ...baseline.summary.unknownByReason };
  for (const row of unknown) reasons[row.relationship.reason] = (reasons[row.relationship.reason] || 0) + 1;
  assert.deepEqual(graph.summary.unknownByReason, reasons);
  assert.equal(graph.reviewedOutcomes.omitted.mappings, unknown.length);
  assert.deepEqual(graph.unknownMappings, baseline.unknownMappings);
  assert.equal(graph.coverage.omittedUnknownMappings, graph.summary.unknownMappings - graph.unknownMappings.length);
  assertIntegrity(graph);
});

test('graph uses the existing persisted commerce, control, marketing and measurement schemas', () => {
  const state = fixture();
  const graph = deriveBusinessGraph(state);
  assert.equal(graph.schema, 'runvara-business-graph/v1');
  assert.equal(graph.workspaceId, 'tenant-a');
  assert.equal(graph.mode, 'detail');
  assert.equal(graph.coverage.complete, true);
  assert.equal(graph.summary.nodesByType.product, 2);
  assert.equal(graph.summary.nodesByType.variant, 2);
  assert.equal(graph.summary.nodesByType.listing, 2);
  assert.equal(graph.summary.nodesByType.customer, 1);
  assert.equal(graph.summary.nodesByType.outcome, 3);
  assert.equal(graph.summary.recordedOutcomeRecords, 3);
  assert.equal(graph.summary.legacyReviewedOutcomeRecords, 3);
  assert.equal(graph.summary.verifiedOutcomeRecords, 0);
  assert.equal(graph.outcomeCoverage.publicationProofAvailable, false);
  assert.equal(graph.outcomeCoverage.complete, false);
  assert.equal(graph.outcomeCoverage.unavailableReason, 'COMMITTED_OUTCOME_SNAPSHOT_NOT_SUPPLIED');
  assert.equal(graph.outcomeCoverage.completeLifetimeHistoryClaimed, false);
  for (const relation of ['has_variant', 'uses_sku', 'has_economics', 'sourced_from_supplier', 'placed_by_customer', 'promotes_product', 'promotes_variant', 'requires_approval', 'references_opportunity', 'references_campaign', 'evaluated_by_experiment', 'has_recorded_outcome', 'has_evidence_for']) {
    assert.ok(edgesOf(graph, relation).length, relation);
    assert.equal(graph.summary.edgesByRelation[relation], edgesOf(graph, relation).length);
  }
  for (const node of graph.nodes) {
    assert.equal(node.sourceRef.workspaceId, 'tenant-a');
    let value = state;
    for (const key of node.sourceRef.pointer.split('/').slice(1)) value = value[key];
    assert.notEqual(value, undefined, `source reference resolves: ${node.sourceRef.pointer}`);
  }
  assertIntegrity(graph);
});

test('graph is deterministic and read-only against deeply frozen authoritative state', t => {
  const state = frozen(fixture());
  const before = JSON.stringify(state);
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('Graph attempted a provider request'); });
  const timer = t.mock.method(globalThis, 'setTimeout', () => { throw new Error('Graph attempted to schedule work'); });
  assert.deepEqual(deriveBusinessGraph(state), deriveBusinessGraph(state));
  assert.deepEqual(deriveBusinessGraphSummary(state), deriveBusinessGraphSummary(state));
  assert.equal(JSON.stringify(state), before);
  assert.equal(network.mock.callCount(), 0);
  assert.equal(timer.mock.callCount(), 0);
  const graph = deriveBusinessGraph(state);
  assert.equal(graph.persistence.writesPerformed, 0);
  assert.equal(graph.persistence.separateGraphStored, false);
  assert.equal(graph.persistence.mode, 'projection-of-authoritative-persisted-records');
  assert.equal(graph.safeguards.providerRequests, false);
});

test('workspace identity is mandatory, explicit conflicting tenant IDs are rejected', () => {
  for (const state of [{}, { workspace: {} }, { workspace: { id: '' } }]) assert.throws(() => deriveBusinessGraph(state), { code: 'WORKSPACE_REQUIRED' });
  assert.throws(() => deriveBusinessGraph(fixture(), { workspaceId: 'tenant-b' }), { code: 'WORKSPACE_MISMATCH' });
  for (const field of ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id']) {
    const state = fixture();
    state.products[0][field] = 'tenant-b';
    assert.throws(() => deriveBusinessGraph(state), { code: 'WORKSPACE_MISMATCH' }, field);
  }
  for (const location of [state => state.products[0].variants[0], state => state.orders[0].lineItems[0], state => state.economics.BAGS, state => state.approvals[0].payload, state => state.revenueEngine.experiments[0].impact, state => state.workRecords[0].evidence[0]]) {
    const state = fixture();
    location(state).workspaceId = 'tenant-b';
    assert.throws(() => deriveBusinessGraph(state), { code: 'WORKSPACE_MISMATCH' });
  }
  assert.equal(deriveBusinessGraph(fixture(), { workspaceId: 'tenant-a' }).workspaceId, 'tenant-a');
});

test('every entity and relationship identity is tenant scoped, including shared source IDs', () => {
  const left = deriveBusinessGraph(fixture('tenant-a'));
  const right = deriveBusinessGraph(fixture('tenant-b'));
  const leftIds = new Set([...left.nodes, ...left.edges].map(item => item.id));
  for (const item of [...right.nodes, ...right.edges]) assert.equal(leftIds.has(item.id), false);
  assert.equal(JSON.stringify(left).includes('tenant-b'), false);
  assert.equal(JSON.stringify(right).includes('tenant-a'), false);
});

test('no credentials, command bodies, raw identities or customer PII appear in any reference', () => {
  const state = fixture();
  const secret = 'secret-private-payload-unique-value';
  const email = 'unique-raw-identifier@example.com';
  state.orders[0].id = email;
  state.orders[0].customerId = email;
  state.orders[0].customerName = secret;
  state.orders[0].shippingAddress = { line1: secret };
  state.products[0].id = email;
  state.products[0].variants[0].sku = email;
  state.economics[email] = costs();
  state.suppliers[0].id = email;
  state.economics[email].supplierId = email;
  state.workRecords[0].id = email;
  state.workRecords[0].title = secret;
  state.approvals[0].action = secret;
  state.approvals[0].payload.body = secret;
  state.connections = [{ provider: 'shopify', encryptedCredentials: secret }];
  state.aiProvider = { apiKey: secret, prompt: secret };
  state.marketing.campaigns[0].copy.longCaption = secret;
  const graph = deriveBusinessGraph(state);
  const serialized = JSON.stringify(graph);
  for (const value of [secret, email, 'private@example.com', 'Private user command', 'customer1']) assert.equal(serialized.includes(value), false, value);
  assert.equal(graph.safeguards.rawRecordIdsIncluded, false);
  const dictionaryRef = nodesOf(graph, 'economics').find(node => node.sourceRef.keyHash === createHash('sha256').update(JSON.stringify(['tenant-a', 'economics-key', email])).digest('hex'));
  assert.ok(dictionaryRef, 'opaque dictionary selector still locates authoritative economics');
});

test('missing economics remain unknown, incomplete costs do not become fabricated zero profit', () => {
  const graph = deriveBusinessGraph(fixture());
  const complete = nodesOf(graph, 'economics').filter(node => node.attributes.complete);
  const incomplete = nodesOf(graph, 'economics').filter(node => !node.attributes.complete);
  assert.equal(complete.length, 1);
  assert.equal(incomplete.length, 2);
  for (const node of incomplete) {
    assert.ok(node.attributes.missingFields.length);
    assert.equal(node.attributes.contribution, null);
  }
  assert.ok(graph.summary.unknownByReason.missing_economics >= 2);
  assert.ok(graph.summary.unknownByReason.no_recorded_sku_match >= 1);
});

test('variant-ID economics fallback is preserved without inventing an SKU', () => {
  const state = { workspace: { id: 'tenant' }, products: [{ id: 'p', provider: 'shopify', variants: [{ id: 'v', price: 12 }] }], economics: { v: costs() } };
  const graph = deriveBusinessGraph(state);
  assert.equal(nodesOf(graph, 'sku').length, 0);
  assert.equal(edgesOf(graph, 'has_economics')[0].provenance.basis, 'recorded-variant-id-fallback');
  assert.equal(graph.summary.unknownByReason.missing_sku, 1);
});

test('duplicate source IDs, delimiter collisions and duplicate SKUs never silently merge products', () => {
  const state = fixture();
  state.products = [
    { id: 'a:b', provider: 'shopify', variants: [{ id: 'c', sku: 'SHARED' }] },
    { id: 'a', provider: 'shopify', variants: [{ id: 'b:c', sku: 'SHARED' }] },
    { id: 'a', provider: 'shopify', variants: [{ id: 'b:c', sku: 'SHARED' }, { id: 'b:c', sku: 'SHARED' }] },
    { id: 'a', provider: 'ebay', variants: [{ id: 'b:c', sku: 'OTHER' }] }
  ];
  state.marketing.campaigns[0].product = { productId: 'a', variantId: 'b:c', sku: 'SHARED' };
  const graph = deriveBusinessGraph(state);
  assert.equal(nodesOf(graph, 'product').length, 4);
  assert.equal(nodesOf(graph, 'variant').length, 5);
  assert.equal(graph.summary.unknownByReason.shared_sku_not_unique_variant, 4);
  assert.ok(graph.summary.unknownByReason.duplicate_record_id >= 2);
  assert.ok(graph.summary.unknownByReason.ambiguous_reference >= 2);
  assert.equal(edgesOf(graph, 'promotes_product').length, 0);
  assert.equal(edgesOf(graph, 'promotes_variant').length, 0);
  assertIntegrity(graph);
});

test('unique record IDs retain stable graph IDs when source arrays are reordered', () => {
  const state = fixture();
  state.revenueEngine.experiments.push({ id: 'second-measurement', status: 'completed', impact: { verified: true, costAvoided: 20 } });
  const before = deriveBusinessGraph(state);
  state.products.reverse();
  state.orders.reverse();
  state.revenueEngine.experiments.reverse();
  const after = deriveBusinessGraph(state);
  for (const type of ['product', 'variant', 'order', 'order_line', 'sku', 'customer', 'experiment', 'outcome']) {
    assert.deepEqual(nodesOf(before, type).map(node => node.id).sort(), nodesOf(after, type).map(node => node.id).sort(), type);
  }
  assert.deepEqual(before.edges.map(edge => edge.id).sort(), after.edges.map(edge => edge.id).sort());
});

test('shared SKU and campaign names are not treated as product identity or conversion attribution', () => {
  const state = fixture();
  state.orders[0].campaignName = 'campaign1';
  state.orders[0].utmCampaign = 'campaign1';
  const graph = deriveBusinessGraph(state);
  assert.equal(edgesOf(graph, 'lists_product').length, 0);
  assert.equal(edgesOf(graph, 'lists_variant').length, 0);
  assert.equal(edgesOf(graph, 'references_variant').length, 0);
  const orderIds = new Set(nodesOf(graph, 'order').map(node => node.id));
  const campaignIds = new Set(nodesOf(graph, 'campaign').map(node => node.id));
  assert.equal(graph.edges.some(edge => orderIds.has(edge.from) && campaignIds.has(edge.to)), false);
  assert.equal(graph.summary.unknownByReason.no_explicit_product_or_variant_reference, 2);
  assert.equal(graph.summary.unknownByReason.sku_only_not_verified_product_identity, 2);
});

test('only explicit unique provider-scoped variant IDs join order lines to variants', () => {
  const state = fixture();
  state.products.push({ id: 'p-other', provider: 'ebay', variants: [{ id: 'v1', sku: 'BAGS' }] });
  state.orders[0].lineItems[0].variantId = 'v1';
  const graph = deriveBusinessGraph(state);
  const relation = edgesOf(graph, 'references_variant');
  assert.equal(relation.length, 1);
  assert.equal(graph.nodes.find(node => node.id === relation[0].to).attributes.channel, 'shopify');
});

test('historical eBay line legacyItemId fallbacks cannot create SKU or economics joins', () => {
  const state = fixture();
  // This is the actual persisted mapEbayOrder shape. Its `sku` may have come
  // from line.legacyItemId; no source discriminator survives normalization.
  state.orders = [{ id: 'ebay-order', provider: 'ebay', lineItems: [{ id: 'line', sku: 'BAGS', quantity: 1, net: 10 }] }];
  const graph = deriveBusinessGraph(state);
  const line = nodeAt(graph, '/orders/0/lineItems/0', 'order_line');
  assert.ok(line);
  assert.equal(graph.edges.some(edge => edge.from === line.id && ['uses_sku', 'has_economics'].includes(edge.relation)), false);
  assert.equal(graph.summary.unknownByReason.unverified_provider_sku_provenance, 2);
  // The independently recorded eBay listing SKU is still usable evidence.
  const listing = nodeAt(graph, '/ebay/listings/0', 'listing');
  assert.ok(graph.edges.some(edge => edge.from === listing.id && edge.relation === 'has_economics'));
});

test('campaign-generated SKU fallback cannot join an unrelated real catalogue SKU', () => {
  const state = fixture();
  state.products[0].variants[0].sku = '';
  state.products[1].variants[0].sku = 'p1-v1';
  state.marketing.campaigns[0].product.sku = 'p1-v1';
  state.economics['p1-v1'] = costs();
  const graph = deriveBusinessGraph(state);
  const campaign = nodesOf(graph, 'campaign')[0];
  assert.equal(graph.edges.some(edge => edge.from === campaign.id && edge.relation === 'uses_sku'), false);
  assert.ok(graph.edges.some(edge => edge.from === campaign.id && edge.relation === 'promotes_variant'));
  assert.equal(graph.summary.unknownByReason.campaign_sku_not_verified_in_catalogue, 1);
  const normal = deriveBusinessGraph(fixture());
  const safeEdge = normal.edges.find(edge => edge.from === nodesOf(normal, 'campaign')[0].id && edge.relation === 'uses_sku');
  assert.ok(safeEdge);
  assert.equal(safeEdge.provenance.sourceRef.pointer, '/products/0/variants/0');
});

test('customer references use recorded identifiers only and remain provider scoped', () => {
  const state = fixture();
  state.orders = [
    { id: 'o1', provider: 'shopify', customerId: 'same', lineItems: [] },
    { id: 'o2', provider: 'ebay', customerId: 'same', lineItems: [] },
    { id: 'o3', provider: 'shopify', customerEmailHash: 'recorded-hash', lineItems: [] },
    { id: 'o4', provider: 'shopify', customerEmailHash: 'recorded-hash', lineItems: [] },
    { id: 'o5', provider: 'shopify', customerEmail: 'same@example.com', customerName: 'Same Person', lineItems: [] },
    { id: 'o6', customerId: 'same', lineItems: [] }
  ];
  state.channelData = {};
  const graph = deriveBusinessGraph(state);
  assert.equal(nodesOf(graph, 'customer').length, 3);
  assert.equal(edgesOf(graph, 'placed_by_customer').length, 4);
  assert.equal(graph.summary.unknownByReason.missing_customer_identifier_or_channel, 2);
  assert.equal(JSON.stringify(graph).includes('recorded-hash'), false);
});

test('legacy reviews and terminal source statuses never establish qualified or realised outcomes', () => {
  const state = fixture();
  state.approvals[0].status = 'pending';
  state.workRecords[0].status = 'PLANNED';
  state.revenueEngine.experiments = [
    { id: 'running', status: 'running', impact: { verified: true, incrementalContribution: 10 } },
    { id: 'measured', status: 'measured', impact: { verified: false, incrementalContribution: 20 } },
    { id: 'verified-zero', status: 'completed', impact: { status: 'verified', incrementalContribution: 0 } },
    { id: 'forecast', status: 'completed', expectedContributionProfit: 99999 }
  ];
  const graph = deriveBusinessGraph(state);
  assert.equal(nodesOf(graph, 'outcome').length, 5);
  assert.equal(graph.summary.recordedOutcomeRecords, 5);
  assert.equal(graph.summary.legacyReviewedOutcomeRecords, 4);
  assert.equal(graph.summary.verifiedOutcomeRecords, 0);
  assert.equal(JSON.stringify(graph).includes('99999'), false);
  assert.equal(JSON.stringify(graph).includes('9000'), false);
  for (const node of nodesOf(graph, 'outcome')) {
    assert.equal(node.attributes.verified, false);
    assert.equal(node.attributes.realised, false);
    assert.equal(node.attributes.qualified, false);
    assert.equal(node.attributes.qualification, 'legacy_unqualified');
  }
  assert.equal(nodeAt(graph, '/revenueEngine/experiments/2/impact').attributes.terminalSource, true);
  assert.equal(nodeAt(graph, '/revenueEngine/experiments/2/impact').attributes.legacyReviewed, true);
  assert.equal(nodeAt(graph, '/revenueEngine/experiments/1/impact').attributes.legacyReviewed, false);
  assert.equal(nodeAt(graph, '/approvals/0/impact').attributes.terminalSource, false);
  assert.equal(nodeAt(graph, '/workRecords/0/evidence/0/impact').attributes.terminalSource, false);
});

test('outcome counts are explicitly source-record counts, never deduplicated commercial impact', () => {
  const state = fixture();
  state.approvals[0].impact.id = 'same-evidence';
  state.workRecords[0].evidence[0].impact.id = 'same-evidence';
  state.revenueEngine.experiments[0].impact.id = 'same-evidence';
  const graph = deriveBusinessGraph(state);
  assert.equal(graph.summary.recordedOutcomeRecords, 3);
  assert.equal(graph.summary.legacyReviewedOutcomeRecords, 3);
  assert.equal(graph.summary.verifiedOutcomeRecords, 0);
  assert.equal(graph.summary.outcomeCountsAreSourceRecords, true);
  assert.equal('verifiedRealisedOutcomes' in graph.summary, false);
  assert.equal('verifiedValue' in graph.summary, false);
  assert.equal(new Set(nodesOf(graph, 'outcome').map(node => node.id)).size, 3);
});

test('all legacy source shapes preserve recorded metrics without promoting spoofed qualification or amounts', () => {
  const forged = { verified: true, status: 'verified', qualified: true, realised: true, financiallyQualified: true,
    qualification: 'qualified', publicationProofAvailable: true, currency: 'GBP',
    publicationBoundary: { committed: true }, verification: { actorId: 'private-reviewer' },
    incrementalRevenue: '1e20', incrementalContribution: '-0.000001', contributionProtected: 0, costAvoided: '0', minutesSaved: 45 };
  const state = { workspace: { id: 'tenant-a' },
    approvals: [{ id: 'a1', status: 'approved', executionStatus: 'succeeded', executionImpact: forged }],
    workRecords: [{ id: 'w1', status: 'COMPLETED', evidence: [forged, { impact: forged }] }],
    revenueEngine: { experiments: [
      { id: 'e1', status: 'measured', result: forged },
      { id: 'e2', status: 'closed', outcome: forged },
      { id: 'e3', status: 'completed', impact: { verified: true, incrementalContribution: null, minutesSaved: '' } }
    ] } };
  const graph = deriveBusinessGraph(frozen(state));
  assert.equal(graph.summary.recordedOutcomeRecords, 5);
  assert.equal(graph.summary.legacyReviewedOutcomeRecords, 5);
  assert.equal(graph.summary.verifiedOutcomeRecords, 0);
  for (const node of nodesOf(graph, 'outcome')) {
    assert.deepEqual(node.attributes, { verified: false, realised: false, qualified: false, qualification: 'legacy_unqualified',
      legacyReviewed: true, terminalSource: true,
      metricFields: ['incrementalRevenue', 'incrementalContribution', 'contributionProtected', 'costAvoided', 'minutesSaved'] });
  }
  for (const privateValue of ['private-reviewer', '1e20', '-0.000001', 'GBP']) assert.equal(JSON.stringify(graph).includes(privateValue), false);
  assert.equal(edgesOf(graph, 'has_recorded_outcome').length, 5);
  assertIntegrity(graph);
});

test('hot-state summaries and copied publication proofs cannot supply committed outcome coverage', () => {
  const state = fixture();
  const copiedSnapshot = { versions: [{ qualified: true }], publicationBoundary: { committed: true, complete: true } };
  Object.assign(state, { outcomeSnapshot: copiedSnapshot, businessOutcomes: { counts: { qualifiedOutcomes: 999 } },
    outcomeSummary: { qualifiedOutcomeCount: 999 }, qualifiedOutcomeGroups: [{ amount: '999' }] });
  const before = JSON.stringify(state);
  for (const derive of [deriveBusinessGraph, deriveBusinessGraphSummary]) {
    const result = derive(frozen(state), { outcomeSnapshot: copiedSnapshot });
    assert.equal(result.summary.verifiedOutcomeRecords, 0);
    assert.equal(result.summary.recordedOutcomeRecords, 3);
    assert.equal(result.outcomeCoverage.publicationProofAvailable, false);
    assert.equal(result.outcomeCoverage.complete, false);
    assert.equal(result.outcomeCoverage.unavailableReason, 'COMMITTED_OUTCOME_SNAPSHOT_NOT_SUPPLIED');
    assert.equal(result.outcomeCoverage.publicationSnapshotId, undefined);
    assert.match(result.outcomeCoverage.note, /zero verified count does not establish that no qualified outcomes exist/);
    assert.equal(result.qualifiedOutcomeGroups, undefined);
    assert.equal(result.outcomeSummary, undefined);
    assert.equal(result.businessOutcomes, undefined);
  }
  assert.equal(JSON.stringify(state), before);
});

test('legacy outcome source counts stay bounded and distinct from unavailable publication coverage', () => {
  const state = { workspace: { id: 'tenant-a' }, businessObjectives: [], connectionWrites: [], approvals: [], revenueEngine: { experiments: Array.from({ length: 12 }, (_, index) => ({
    id: `experiment-${index}`, status: 'completed', impact: { verified: index % 2 === 0, incrementalContribution: index }
  })) } };
  const summary = deriveBusinessGraphSummary(state);
  assert.equal(summary.summary.recordedOutcomeRecords, 8);
  assert.equal(summary.summary.legacyReviewedOutcomeRecords, 4);
  assert.equal(summary.summary.verifiedOutcomeRecords, 0);
  assert.equal(summary.coverage.truncated, true);
  const detail = deriveBusinessGraph(state);
  assert.equal(detail.summary.recordedOutcomeRecords, 12);
  assert.equal(detail.summary.legacyReviewedOutcomeRecords, 6);
  assert.equal(detail.coverage.complete, true);
  assert.equal(detail.outcomeCoverage.complete, false);
  const limited = deriveBusinessGraph(state, { nodeLimit: 13 });
  assert.equal(limited.summary.recordedOutcomeRecords, 1);
  assert.equal(limited.summary.legacyReviewedOutcomeRecords, 1);
  assert.equal(limited.coverage.truncated, true);
  assertIntegrity(limited);
});

test('unqualified legacy outcomes still reject foreign scopes in every retained source shape', () => {
  const sources = [
    impact => ({ approvals: [{ id: 'a', status: 'approved', executionStatus: 'executed', impact }] }),
    executionImpact => ({ approvals: [{ id: 'a', status: 'approved', executionStatus: 'executed', executionImpact }] }),
    impact => ({ workRecords: [{ id: 'w', status: 'COMPLETED', evidence: [{ impact }] }] }),
    evidence => ({ workRecords: [{ id: 'w', status: 'COMPLETED', evidence: [evidence] }] }),
    ...['impact', 'result', 'outcome'].map(field => value => ({ revenueEngine: { experiments: [{ id: 'e', status: 'completed', [field]: value }] } }))
  ];
  for (const source of sources) for (const field of ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id']) {
    const state = { workspace: { id: 'tenant-a' }, ...source({ [field]: 'tenant-b', verified: true, incrementalContribution: 0 }) };
    for (const derive of [deriveBusinessGraph, deriveBusinessGraphSummary]) assert.throws(() => derive(state), { code: 'WORKSPACE_MISMATCH' });
  }
});

test('all output limits are capped and never leave dangling relationships', () => {
  const state = fixture();
  const graph = deriveBusinessGraph(state, { recordLimit: 2, nestedLimit: 1, nodeLimit: 12, edgeLimit: 3, unknownLimit: 2 });
  assert.ok(graph.nodes.length <= 12);
  assert.ok(graph.edges.length <= 3);
  assert.ok(graph.unknownMappings.length <= 2);
  assert.equal(graph.coverage.truncated, true);
  assert.equal(graph.coverage.complete, false);
  assert.ok(graph.coverage.droppedNodes > 0);
  assert.ok(graph.coverage.droppedEdges > 0);
  assert.ok(graph.coverage.omittedUnknownMappings > 0);
  assertIntegrity(graph);
  const capped = deriveBusinessGraph(state, { recordLimit: 1e9, nestedLimit: 1e9, scanLimit: 1e9, nodeLimit: 1e9, edgeLimit: 1e9, unknownLimit: 1e9 });
  assert.deepEqual(capped.limits, { recordLimit: 500, nestedLimit: 100, scanLimit: 10000, nodeLimit: 2000, edgeLimit: 4000, unknownLimit: 500 });
});

test('a partial target index does not assert a unique relationship before unseen duplicates', () => {
  const state = fixture();
  state.products = [{ id: 'p1', provider: 'shopify', variants: [] }, { id: 'p1', provider: 'shopify', variants: [] }];
  const graph = deriveBusinessGraph(state, { recordLimit: 1 });
  assert.equal(edgesOf(graph, 'promotes_product').length, 0);
  assert.ok(graph.summary.unknownByReason.target_index_incomplete);
  assert.equal(graph.coverage.sources.find(source => source.collection === 'products.variants').totalKnown, false);
});

test('summary is cheap, bounded, honest about truncation and includes no source records', () => {
  const state = fixture();
  let touched = 0;
  state.products = Array.from({ length: 5000 }, (_, index) => ({
    get id() { touched++; return `p-${index}`; }, provider: 'shopify',
    variants: Array.from({ length: 10 }, (_, item) => ({ id: `v-${index}-${item}`, sku: `SKU-${index}-${item}` }))
  }));
  const graph = deriveBusinessGraphSummary(state, { recordLimit: 1e9, nestedLimit: 1e9, scanLimit: 1e9, nodeLimit: 1e9, edgeLimit: 1e9 });
  assert.equal(graph.mode, 'summary');
  assert.equal('nodes' in graph, false);
  assert.equal('edges' in graph, false);
  assert.equal('unknownMappings' in graph, false);
  assert.ok(graph.coverage.scannedRecords <= 250);
  assert.ok(touched < 100, 'does not scan the entire catalogue');
  assert.equal(graph.coverage.sources.find(source => source.collection === 'products').available, 5000);
  assert.equal(graph.coverage.truncated, true);
  assert.equal(graph.summary.countsAreProjectionOnly, true);
  assert.ok(JSON.stringify(graph).length < 15000);
});

test('dictionary scanning is bounded and never mistakes a projected-out cost profile for missing costs', () => {
  const state = fixture();
  state.economics = { unrelated: costs(), BAGS: costs() };
  const graph = deriveBusinessGraph(state, { recordLimit: 1 });
  const coverage = graph.coverage.sources.find(source => source.collection === 'economics');
  assert.equal(coverage.scanned, 1);
  assert.equal(coverage.totalKnown, false);
  assert.equal(coverage.truncated, true);
  const variant = nodeAt(graph, '/products/0/variants/0', 'variant');
  assert.ok(graph.unknownMappings.some(mapping => mapping.subjectId === variant.id && mapping.relation === 'has_economics' && mapping.reason === 'target_outside_projection'));
  assert.equal(graph.unknownMappings.some(mapping => mapping.subjectId === variant.id && mapping.reason === 'missing_economics'), false);
});

test('invalid records and absent collections do not claim complete coverage or synthesize businesses', () => {
  const empty = deriveBusinessGraph({ workspace: { id: 'empty' } });
  assert.equal(empty.nodes.length, 0);
  assert.equal(empty.edges.length, 0);
  const graph = deriveBusinessGraph({ workspace: { id: 'invalid' }, products: [null, 'invalid', 5] });
  assert.equal(graph.coverage.sources.find(source => source.collection === 'products').invalid, 3);
  assert.equal(graph.coverage.complete, false);
  assert.equal(graph.nodes.length, 0);
  const malformed = deriveBusinessGraph({ workspace: { id: 'invalid' }, products: {}, economics: [] });
  assert.equal(malformed.coverage.complete, false);
});
