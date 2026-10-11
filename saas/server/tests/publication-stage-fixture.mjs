import assert from 'node:assert/strict';
import { createBusinessOutcomePersistence, businessOutcomePublicationParams, businessOutcomePublicationIntentDigest } from '../lib/business-outcome-store.mjs';
import { createBusinessOutcomeCandidate, correctBusinessOutcomeCandidate, withdrawBusinessOutcomeCandidate } from '../lib/business-outcomes.mjs';
import { createGovernedRecordStage, GOVERNED_RECORD_PRODUCER_CONTRACT } from '../lib/governed-record-stage.mjs';
import { evidenceInWorkspace } from '../lib/business-evidence-scope.mjs';
import { sourceMeasurement, actionFixture, linkedMeasurement } from './business-outcome-postgres-fixture.mjs';

export const NOW = '2026-10-10T12:00:00.000Z';
export const OPEN_STAGE = createGovernedRecordStage({ GOVERNED_RECORD_PRODUCER_CONTRACT });
export function publicationHarness({ workspaceId = 'stage-tenant', linked = false } = {}) {
  const actor = { id: 'owner', sessionVersion: 3 }, experimentId = 'experiment_stage';
  const action = actionFixture(workspaceId), source = linked
    ? linkedMeasurement(workspaceId, experimentId, action.sourceAction) : sourceMeasurement(workspaceId, experimentId);
  const state = { _revision: 'workspace_1', workspace: { id: workspaceId },
    users: [{ ...actor, role: 'owner', active: true, passwordChangeRequired: false }], measurement: source };
  const rows = new Map(), calls = [], invalidations = [], hooks = { transport: null };
  let head = null, sequence = 1;
  const input = (patch = {}) => ({ publicationId: `publication_${sequence++}`, action: 'publish', experimentId,
    expectedWorkspaceRevision: state._revision, expectedMeasurementRevision: state.measurement.revision,
    expectedMeasurementDigest: state.measurement.digest, expectedHeadVersionId: null, expectedHeadDigest: null,
    withdrawalReason: null, ...patch });
  const sqlError = code => Object.assign(new Error('Synthetic SQL rejection'), { databaseCode: code });
  const compact = row => Object.fromEntries(Object.entries(row).filter(([key]) => !['source_measurement','source_action'].includes(key)));
  function assertActor(p) {
    const matches = state.users.filter(user => user.id === p.p_actor_id), user = matches[0];
    if (matches.length !== 1 || user.role !== 'owner' || user.active !== true || user.passwordChangeRequired !== false
      || user.sessionVersion !== p.p_actor_session_version) throw sqlError('P0O03');
  }
  async function normal(path, options) {
    if (path === 'rpc/runvara_publish_business_outcome') {
      const p = JSON.parse(options.body); assertActor(p);
      const existing = [...rows.values()].find(row => row.publication_id === p.p_publication_id);
      if (existing) {
        if (existing.intent_digest !== businessOutcomePublicationIntentDigest(p)) throw sqlError('P0O06');
        return { publication: pair(existing), replayed: true, isCurrent: head === existing.version_id };
      }
      if (state._revision !== p.p_expected_workspace_revision) throw sqlError('P0O04');
      const previous = rows.get(head);
      if ((head ?? null) !== p.p_expected_head_version_id || (previous?.digest ?? null) !== p.p_expected_head_digest) throw sqlError('P0O05');
      const measurement = p.p_action === 'withdraw' ? previous.source_measurement : state.measurement;
      if (measurement.revision !== p.p_expected_measurement_revision || measurement.digest !== p.p_expected_measurement_digest) throw sqlError('P0O07');
      const verification = { kind: 'owner_attestation', actorId: actor.id, verifiedAt: NOW, measurementDigest: measurement.digest };
      const record = { source: { type: 'experiment_measurement', experimentId, measurementRevision: measurement.revision, measurementDigest: measurement.digest },
        ...Object.fromEntries(['metric','amount','currency','window','coverage','method','provenance','links'].map(key => [key,measurement[key]])), verification };
      const context = { workspaceId, now: NOW };
      const version = p.p_action === 'withdraw' ? withdrawBusinessOutcomeCandidate(previous.payload, { verification, reason: p.p_withdrawal_reason }, context)
        : p.p_action === 'correct' ? correctBusinessOutcomeCandidate(previous.payload, record, context) : createBusinessOutcomeCandidate(record, context);
      state._revision = `committed_${sequence++}`;
      const row = { workspace_id: workspaceId, outcome_id: version.outcomeId, revision: version.revision, version_id: version.versionId,
        digest: version.digest, status: version.status, payload: version, publication_id: p.p_publication_id,
        intent_digest: businessOutcomePublicationIntentDigest(p), committed_at: NOW, commit_revision: state._revision,
        source_measurement: structuredClone(measurement), source_action: measurement.intervention ? structuredClone(action.sourceAction) : null };
      rows.set(version.versionId, row); head = version.versionId;
      return { publication: pair(row), replayed: false, isCurrent: true };
    }
    if (path === 'rpc/runvara_read_outcome_content_sources' || path === 'rpc/runvara_read_business_outcome_review') {
      const p = JSON.parse(options.body); if (p.p_actor_id) assertActor(p);
      const prior = rows.get(head), joined = prior ? { workspace_id: workspaceId, outcome_id: prior.outcome_id, version_id: head, version: compact(prior) } : null;
      const review = { workspaceId, workspaceRevision: state._revision, experiment: { id: experimentId, title: 'Synthetic stage test', status: 'measured' },
        measurement: structuredClone(state.measurement), current: joined, actionLinkContract: 'runvara-reviewed-action/v1',
        actionChoices: [], currentActionAssociation: prior?.source_measurement.intervention ?? null };
      return path === 'rpc/runvara_read_business_outcome_review' ? review : { schema: 'runvara-outcome-content-source-reader/v1', review,
        receiptChoices: [], nextCursor: null, hasMore: false, selectedEvidence: null };
    }
    const url = new URL(path, 'https://synthetic.invalid');
    assert.equal(url.searchParams.get('workspace_id'), `eq.${workspaceId}`);
    assert.equal(url.searchParams.get('limit'), '2');
    if (url.pathname === '/runvara_business_outcome_versions') {
      const publicationId = url.searchParams.get('publication_id')?.slice(3), versionId = url.searchParams.get('version_id')?.slice(3);
      return [...rows.values()].filter(row => publicationId ? row.publication_id === publicationId : row.version_id === versionId)
        .map(row => Object.fromEntries(url.searchParams.get('select').split(',').filter(key => Object.hasOwn(row,key)).map(key => [key,structuredClone(row[key])])));
    }
    if (url.pathname === '/runvara_business_outcome_heads') return head
      ? [{ workspace_id: workspaceId, outcome_id: rows.get(head).outcome_id, version_id: head }] : [];
    if (url.pathname === '/saas_workspace_state') {
      assert.match(url.searchParams.get('and'), /state->workspaceId\.is\.null/);
      if (!evidenceInWorkspace(state,workspaceId)) return [];
      return [{ workspace_id: workspaceId, revision: state._revision, workspace: structuredClone(state.workspace), users_json: JSON.stringify(state.users),
        ...Object.fromEntries(['workspaceId','workspace_id','tenantId','tenant_id','tenant'].map(key => [`scope_${key}`,structuredClone(state[key] ?? null)])) }];
    }
    assert.fail(path);
  }
  function pair(row) {
    return { head: { schema: 'runvara-outcome-head/v1', workspaceId, outcomeId: row.outcome_id, revision: row.revision,
      versionId: row.version_id, digest: row.digest, status: row.status === 'withdrawn' ? 'withdrawn' : 'published', publicationId: row.publication_id,
      committedAt: row.committed_at, commitRevision: row.commit_revision }, version: structuredClone(row.payload) };
  }
  const request = async (path, options = {}) => {
    const call = { path, options: structuredClone(options), requestBytes: Buffer.byteLength(options.body ?? ''), responseBytes: null };
    calls.push(call);
    const result = await (hooks.transport ? hooks.transport(path, options, () => normal(path,options)) : normal(path, options));
    call.responseBytes = Buffer.byteLength(JSON.stringify(result));
    return structuredClone(result);
  };
  const adapter = (stage, options = {}) => createBusinessOutcomePersistence({ request, now: () => NOW,
    invalidate: id => invalidations.push(id), governedRecordStage: stage, ...options });
  const params = value => businessOutcomePublicationParams(workspaceId,actor,value);
  return { workspaceId, experimentId, actor, state, rows, calls, invalidations, hooks, input, params, adapter, action,
    get head() { return head; }, set head(value) { head = value; },
    setMeasurement({ linked = false, revision = state.measurement.revision + 1 } = {}) {
      state.measurement = linked ? linkedMeasurement(workspaceId,experimentId,action.sourceAction,{revision}) : sourceMeasurement(workspaceId,experimentId,{revision});
      state._revision = `edited_${sequence++}`;
    },
    fences(actionName, patch = {}) { const row = rows.get(head); return input({ action: actionName, expectedHeadVersionId: head,
      expectedHeadDigest: row.digest, ...(actionName === 'withdraw' ? { expectedMeasurementRevision: row.source_measurement.revision,
        expectedMeasurementDigest: row.source_measurement.digest, withdrawalReason: 'evidence_retracted' } : {}), ...patch }); }
  };
}
