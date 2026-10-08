// Synthetic retained records and joined current-head transport. The production
// adapter validates the payload and mints its private publication boundary.
// No network/database/provider request is made by the graph or its adapter.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { reviewedActionFixture } from './reviewed-action-test-fixture.mjs';
import { objectivePublicationFixture } from './objective-publication-fixture.mjs';
import { actionIntervention } from '../lib/reviewed-action-evidence.mjs';
import { createBusinessOutcomeCandidate } from '../lib/business-outcomes.mjs';
import { createBusinessOutcomePersistence, OUTCOME_READ_BYTES } from '../lib/business-outcome-store.mjs';
import { deriveBusinessGraph } from '../lib/business-graph.mjs';

export const graphHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function publishedGraphInput(experimentId, links = {}, amount = '10.25') {
  const measurementDigest = graphHash(['measurement', experimentId]);
  return { source: { type: 'experiment_measurement', experimentId, measurementRevision: 1, measurementDigest },
    metric: 'incrementalContribution', amount, currency: 'GBP',
    window: { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' },
    coverage: { status: 'complete', scopeId: `scope_${experimentId}`, observedCount: 2, expectedCount: 2 },
    method: { kind: 'reconciled_manual', definitionVersion: 'incremental-contribution/v1' },
    provenance: { observationId: `observation_${experimentId}`, sourceRefs: [{ type: 'measurement_report', id: `report_${experimentId}`, digest: graphHash(['report', experimentId]) }],
      observedAt: '2026-10-06T12:00:00.000Z', aggregation: 'non_overlapping_scopes_attested' },
    verification: { kind: 'owner_attestation', actorId: 'private_graph_owner', verifiedAt: '2026-10-06T14:00:00.000Z', measurementDigest }, links };
}
export function publishedGraphHeadRows(versions, committedAt = new Date().toISOString()) {
  return versions.map(version => ({ workspace_id: version.workspaceId, outcome_id: version.outcomeId, version_id: version.versionId,
    version: { workspace_id: version.workspaceId, outcome_id: version.outcomeId, revision: version.revision, version_id: version.versionId,
      digest: version.digest, status: version.status, payload: structuredClone(version), publication_id: `graph_publication_${version.revision}`,
      intent_digest: graphHash(['intent', version.versionId]), committed_at: committedAt, commit_revision: 'private_graph_commit_revision' } }));
}
export async function publishedGraphOptions(versions, { now = new Date().toISOString(), workspaceId = versions[0]?.workspaceId || 'tenant-a', onRead = () => {} } = {}) {
  const rows = publishedGraphHeadRows(versions, now);
  const persistence = createBusinessOutcomePersistence({ now: () => new Date(now), request: async (target, options) => {
    onRead(target, options);
    assert.ok(target.startsWith(`runvara_business_outcome_heads?workspace_id=eq.${workspaceId}&`));
    assert.match(target, /limit=51$/); assert.equal(target.includes('source_action'), false); assert.equal(target.includes('source_measurement'), false);
    assert.equal(options.maxResponseBytes, OUTCOME_READ_BYTES); assert.equal(options.includeResponseMetadata, true);
    return { data: structuredClone(rows), contentRange: rows.length ? `0-${rows.length - 1}/${rows.length}` : '*/0' };
  } });
  return { inspectCurrentOutcomes: true, now, outcomeSnapshot: await persistence.current(workspaceId),
    workspaceSnapshot: { revision: 'private_graph_workspace_revision', readCompletedAt: new Date(Date.parse(now) - 1).toISOString() },
    outcomeReadCompletedAt: now };
}
export async function publishedActionGraphFixture({ kind = 'manual', linked = true, workspaceId = 'tenant-a' } = {}) {
  const retained = kind === 'objective' ? await objectivePublicationFixture({ workspaceId }) : reviewedActionFixture({ workspaceId });
  const state = structuredClone(retained.state), experimentId = 'experiment_published_action';
  state.businessObjectives ||= []; state.revenueEngine = { experiments: [{ id: experimentId, status: 'completed' }] };
  const association = actionIntervention(retained.source);
  const input = publishedGraphInput(experimentId, linked ? { action: association.action, approval: association.approval } : {});
  const now = new Date().toISOString(); input.verification.verifiedAt = now;
  const version = createBusinessOutcomeCandidate(input, { workspaceId, now });
  const options = await publishedGraphOptions([version], { now });
  return { state, version, input, now, options, joinedRows: publishedGraphHeadRows([version], now), sourceAction: retained.source,
    write: state.connectionWrites[0], approval: state.approvals.find(row => row.id === state.connectionWrites[0].approvalId),
    graph: deriveBusinessGraph(state, options) };
}
