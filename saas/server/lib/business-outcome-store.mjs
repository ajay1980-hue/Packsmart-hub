import { REVIEWED_ACTION_CONTRACT, validateReviewedSourceAction, validateActionIntervention, actionIntervention } from './reviewed-action-evidence.mjs';
import { randomUUID } from 'node:crypto';
import { aggregateBusinessOutcomes, assessBusinessOutcomeCandidate, createOutcomePublicationBoundary, validateBusinessOutcomePublication } from './business-outcomes.mjs';
import { assessExperimentOutcomeMeasurement, digestMeasurementValue, validateExperimentOutcomeMeasurement } from './experiment-measurements.mjs';

export const OUTCOME_CURRENT_LIMIT = 50;
export const OUTCOME_READ_BYTES = 2 * 1024 * 1024;
export const SELECTED_OUTCOME_RELATIONSHIPS_MAX_BYTES = 4096;
const VERSION_COLUMNS = 'workspace_id,outcome_id,revision,version_id,digest,status,payload,publication_id,intent_digest,committed_at,commit_revision';
const CURRENT_COLUMNS = `workspace_id,outcome_id,version_id,version:runvara_business_outcome_versions!runvara_outcome_head_version_fk(${VERSION_COLUMNS})`;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^outcome_version_[a-f0-9]{64}$/;
const WITHDRAWALS = ['incorrect_measurement', 'duplicate_observation', 'incorrect_scope', 'evidence_retracted'];
const failures = {
  P0O01: ['OUTCOME_SOURCE_INVALID', 409], P0O02: ['OUTCOME_MEASUREMENT_INCOMPLETE', 409],
  P0O03: ['OUTCOME_OWNER_SESSION_CHANGED', 403], P0O04: ['OUTCOME_WORKSPACE_CONFLICT', 409],
  P0O05: ['OUTCOME_HEAD_CONFLICT', 409], P0O06: ['OUTCOME_PUBLICATION_CONFLICT', 409],
  P0O07: ['OUTCOME_MEASUREMENT_CONFLICT', 409], P0O08: ['OUTCOME_WITHDRAWN_FINAL', 409],
  P0O09: ['OUTCOME_SOURCE_NOT_FOUND', 404], P0O10: ['OUTCOME_SIZE_LIMIT', 413],
  P0O11: ['OUTCOME_ACTION_INVALID', 409]
};
const failure = (code, status = 503) => Object.assign(new Error(code), { code, status });
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function exact(value, fields) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !fields.includes(key)
    || !Object.getOwnPropertyDescriptor(value, key)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')))
    throw failure('OUTCOME_REQUEST_INVALID', 400);
}
function tenant(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw failure('WORKSPACE_REQUIRED', 400);
  return value;
}
function identifier(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw failure('OUTCOME_REQUEST_INVALID', 400);
  return value;
}
function positive(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw failure('OUTCOME_REQUEST_INVALID', 400);
  return value;
}
function hash(value) {
  if (typeof value !== 'string' || !HASH.test(value)) throw failure('OUTCOME_REQUEST_INVALID', 400);
  return value;
}
function versionId(value) {
  if (typeof value !== 'string' || !VERSION.test(value)) throw failure('OUTCOME_REQUEST_INVALID', 400);
  return value;
}
function bounded(value, maximum = OUTCOME_READ_BYTES) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { throw failure('OUTCOME_PUBLICATION_INVALID'); }
  if (typeof encoded !== 'string') throw failure('OUTCOME_PUBLICATION_INVALID');
  if (Buffer.byteLength(encoded) > maximum) throw failure('OUTCOME_RESPONSE_TOO_LARGE');
  return value;
}
function freezeRecorded(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeRecorded(child);
    Object.freeze(value);
  }
  return value;
}
function readError(cause) {
  if (['42P01', '42883', 'PGRST200', 'PGRST202', 'PGRST205'].includes(cause?.databaseCode)) return failure('OUTCOME_STORAGE_UNAVAILABLE');
  return failure('OUTCOME_READ_UNAVAILABLE');
}

// Separate, private proof for one validated review RPC snapshot. It cannot be
// serialized into an aggregate publication boundary or minted by a client DTO.
const selectedReviewContexts = new WeakMap();
function selectedReviewRelationships(token) {
  const context = selectedReviewContexts.get(token);
  if (!context) throw failure('OUTCOME_REVIEW_INVALID');
  const { workspaceId, workspaceRevision, experiment, measurement, currentPublication, at } = context;
  const opaque = (kind, ...parts) => `${kind}_${digestMeasurementValue([workspaceId, kind, ...parts])}`;
  const experimentRef = opaque('selected_experiment', experiment.id);
  const canonicalGraphRef = identityHash => ({ status: 'unresolved', reason: 'separate_graph_not_resolved', identityHash });
  const nodes = [{ id: experimentRef, type: 'experiment_reference',
    canonicalGraphRef: canonicalGraphRef(digestMeasurementValue([workspaceId, 'revenueEngine.experiments', experiment.id])) }];
  const edges = [];
  const state = currentPublication?.head.status || 'none';
  let qualification = 'none';
  if (currentPublication) {
    const { head, version } = currentPublication;
    // A selected source is not the whole graph's indexed experiment collection:
    // do not guess its duplicate ordinal, array pointer or canonical node ID.
    if (version.source.experimentId !== experiment.id) throw failure('OUTCOME_REVIEW_INVALID');
    qualification = head.status === 'withdrawn' ? 'withdrawn'
      : assessBusinessOutcomeCandidate(version, { workspaceId, now: at }).measurementComplete ? 'owner_attested_measurement' : 'unqualified';
    const outcomeRef = opaque('selected_outcome', head.outcomeId);
    nodes.push({ id: outcomeRef, type: head.status === 'withdrawn' ? 'withdrawn_measurement_reference' : 'published_measurement_reference',
      qualification, sourceVersionRef: opaque('selected_version', head.versionId, head.digest),
      canonicalGraphRef: canonicalGraphRef(digestMeasurementValue([workspaceId, 'runvara_business_outcome_versions', head.versionId])) });
    edges.push({ id: opaque('selected_edge', experiment.id, head.outcomeId, head.versionId), from: outcomeRef, to: experimentRef,
      relation: 'measurement_recorded_for_experiment', basis: 'same_review_snapshot' });
  }
  const source = currentPublication?.version.source;
  const draftRelationship = !measurement ? 'no_draft' : !source ? 'no_publication'
    : measurement.revision === source.measurementRevision && measurement.digest === source.measurementDigest
      ? 'matches_publication' : 'different_from_publication';
  const projection = {
    schema: 'runvara-selected-outcome-relationships/v1', scope: 'selected_experiment_only',
    snapshot: { id: opaque('selected_snapshot', randomUUID()), workspaceRevisionRef: opaque('selected_revision', workspaceRevision),
      readCompletedAt: new Date(at).toISOString() },
    publication: { state, qualification, versionDigest: currentPublication?.version.digest ?? null,
      draftRelationship, draftDigest: measurement?.digest ?? null },
    nodes, edges,
    coverage: { selectedExperimentConfirmed: true, currentHeadChecked: true, wholeGraphSynchronized: false,
      otherOutcomesChecked: false, crossOutcomeComparabilityChecked: false },
    safeguards: { causalAttribution: false, forecastingAuthorized: false, learningAuthorized: false,
      executionAuthorized: false, rawIdentifiersIncluded: false, amountsIncluded: false }
  };
  // The complete added property envelope is at most 4 KiB; the existing RPC's
  // 128 KiB response bound remains unchanged. The projection has no report bodies.
  bounded({ relationships: projection }, SELECTED_OUTCOME_RELATIONSHIPS_MAX_BYTES);
  return freezeRecorded(projection);
}

function projectValidatedSelectedReview(review, at) {
  const token = Object.freeze({});
  // Capture a detached immutable snapshot only after the adapter has validated
  // the database response. Retain the publication for validation, but omit draft
  // report text and experiment titles. There is no public constructor or input.
  selectedReviewContexts.set(token, freezeRecorded({ workspaceId: review.workspaceId, workspaceRevision: review.workspaceRevision,
    experiment: { id: review.experiment.id }, measurement: review.measurement
      ? { revision: review.measurement.revision, digest: review.measurement.digest } : null,
    currentPublication: structuredClone(review.currentPublication), at: new Date(at).toISOString() }));
  try { return selectedReviewRelationships(token); }
  finally { selectedReviewContexts.delete(token); }
}

/** Authenticated identity is a separate server argument, never body data. */
export function businessOutcomePublicationParams(workspaceId, actor, input) {
  tenant(workspaceId);
  exact(actor, ['id', 'sessionVersion']);
  exact(input, ['publicationId', 'action', 'experimentId', 'expectedWorkspaceRevision', 'expectedMeasurementRevision',
    'expectedMeasurementDigest', 'expectedHeadVersionId', 'expectedHeadDigest', 'withdrawalReason']);
  if (!['publish', 'correct', 'withdraw'].includes(input.action)) throw failure('OUTCOME_REQUEST_INVALID', 400);
  const first = input.action === 'publish';
  if (first ? input.expectedHeadVersionId !== null || input.expectedHeadDigest !== null
    : !VERSION.test(input.expectedHeadVersionId || '') || !HASH.test(input.expectedHeadDigest || '')) throw failure('OUTCOME_REQUEST_INVALID', 400);
  if (input.action === 'withdraw' ? !WITHDRAWALS.includes(input.withdrawalReason) : input.withdrawalReason !== null) throw failure('OUTCOME_REQUEST_INVALID', 400);
  return {
    p_workspace_id: workspaceId, p_actor_id: identifier(actor.id), p_actor_session_version: positive(actor.sessionVersion),
    p_publication_id: identifier(input.publicationId), p_action: input.action, p_experiment_id: identifier(input.experimentId),
    p_expected_workspace_revision: identifier(input.expectedWorkspaceRevision),
    p_expected_measurement_revision: positive(input.expectedMeasurementRevision), p_expected_measurement_digest: hash(input.expectedMeasurementDigest),
    p_expected_head_version_id: first ? null : versionId(input.expectedHeadVersionId),
    p_expected_head_digest: first ? null : hash(input.expectedHeadDigest), p_withdrawal_reason: input.withdrawalReason
  };
}

function pairFromRow(row, workspaceId, now) {
  if (!plain(row) || row.workspace_id !== workspaceId || !plain(row.payload)
    || row.payload.workspaceId !== workspaceId || row.payload.outcomeId !== row.outcome_id
    || row.payload.versionId !== row.version_id || row.payload.revision !== row.revision
    || row.payload.digest !== row.digest || row.payload.status !== row.status || !HASH.test(row.intent_digest || '')) throw failure('OUTCOME_PUBLICATION_INVALID');
  const at = typeof row.committed_at === 'string' ? Date.parse(row.committed_at) : NaN;
  if (!Number.isFinite(at)) throw failure('OUTCOME_PUBLICATION_INVALID');
  const pair = { head: { schema: 'runvara-outcome-head/v1', workspaceId, outcomeId: row.outcome_id,
    revision: row.revision, versionId: row.version_id, digest: row.digest,
    status: row.status === 'withdrawn' ? 'withdrawn' : 'published', publicationId: row.publication_id,
    committedAt: new Date(at).toISOString(), commitRevision: row.commit_revision }, version: row.payload };
  try { return validateBusinessOutcomePublication(pair, { workspaceId, now }); }
  catch { throw failure('OUTCOME_PUBLICATION_INVALID'); }
}

/** Only call with the existing server's authenticated Supabase transport.
 * No public/client field can inject a resolver or choose table/column names.
 */
export function createBusinessOutcomePersistence({ request, invalidate = () => {}, now = () => new Date() }) {
  if (typeof request !== 'function' || typeof invalidate !== 'function' || typeof now !== 'function') throw new TypeError('Outcome persistence needs a trusted transport');

  async function publish(workspaceId, actor, input) {
    const params = businessOutcomePublicationParams(workspaceId, actor, input);
    let result;
    try {
      // Never automatically repeat a mutation after an uncertain response.
      result = await request('rpc/runvara_publish_business_outcome', { method: 'POST', body: JSON.stringify(params), maxResponseBytes: 128 * 1024 });
    } catch (cause) {
      const mapped = failures[cause?.databaseCode];
      if (mapped) throw failure(...mapped);
      if (['42P01', '42883', 'PGRST202'].includes(cause?.databaseCode)) throw failure('OUTCOME_STORAGE_UNAVAILABLE');
      throw failure('OUTCOME_PUBLICATION_UNCERTAIN');
    } finally {
      // A lost acknowledgement may still have committed the workspace CAS.
      invalidate(workspaceId);
    }
    try {
      bounded(result, 128 * 1024);
      exact(result, ['publication', 'replayed', 'isCurrent']);
      if (typeof result.replayed !== 'boolean' || typeof result.isCurrent !== 'boolean') throw failure('OUTCOME_PUBLICATION_INVALID');
      const publication = validateBusinessOutcomePublication(result.publication, { workspaceId, now: now() });
      const { head, version } = publication;
      if (head.publicationId !== params.p_publication_id || version.source.experimentId !== params.p_experiment_id
        || version.source.measurementRevision !== params.p_expected_measurement_revision || version.source.measurementDigest !== params.p_expected_measurement_digest
        || version.verification.actorId !== params.p_actor_id || version.lineage.previousVersionId !== params.p_expected_head_version_id
        || version.lineage.previousDigest !== params.p_expected_head_digest
        || (params.p_action === 'withdraw' ? version.status !== 'withdrawn' || version.lineage.reason !== params.p_withdrawal_reason : version.status !== 'recorded')
        || (!result.replayed && !result.isCurrent)) throw failure('OUTCOME_PUBLICATION_INVALID');
      return { publication, replayed: result.replayed, isCurrent: result.isCurrent };
    } catch {
      // Malformed success is not proof that the database did not commit.
      throw failure('OUTCOME_PUBLICATION_UNCERTAIN');
    }
  }

  async function current(workspaceId) {
    tenant(workspaceId);
    let page;
    try {
      page = await request(`runvara_business_outcome_heads?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=${CURRENT_COLUMNS}&order=outcome_id.asc&limit=${OUTCOME_CURRENT_LIMIT + 1}`, {
        maxResponseBytes: OUTCOME_READ_BYTES, includeResponseMetadata: true, headers: { Prefer: 'count=exact' }
      });
    } catch (cause) { throw readError(cause); }
    if (!plain(page)) throw failure('OUTCOME_PUBLICATION_INVALID');
    const rows = page.data;
    bounded(rows);
    if (!Array.isArray(rows) || rows.length > OUTCOME_CURRENT_LIMIT + 1) throw failure('OUTCOME_PUBLICATION_INVALID');
    if (rows.some(row => !plain(row) || row.workspace_id !== workspaceId)) throw failure('OUTCOME_PUBLICATION_INVALID');
    // A server max_rows setting can be lower than the requested sentinel.
    // Exact Content-Range cardinality is required to prove a complete read.
    let total;
    if (page.contentRange === '*/0' && rows.length === 0) total = 0;
    else {
      const match = typeof page.contentRange === 'string' && /^(\d+)-(\d+)\/(\d+)$/.exec(page.contentRange);
      if (!match || Number(match[1]) !== 0 || Number(match[2]) !== rows.length - 1
        || !Number.isSafeInteger(Number(match[3])) || Number(match[3]) < rows.length) throw failure('OUTCOME_COVERAGE_UNAVAILABLE');
      total = Number(match[3]);
    }
    const limited = total > OUTCOME_CURRENT_LIMIT || rows.length !== total, at = now(), selected = rows.slice(0, OUTCOME_CURRENT_LIMIT), pairs = new Map();
    for (const row of selected) {
      if (!plain(row) || row.workspace_id !== workspaceId || pairs.has(row.outcome_id)) throw failure('OUTCOME_PUBLICATION_INVALID');
      const publication = pairFromRow(row.version, workspaceId, at);
      if (row.outcome_id !== publication.head.outcomeId || row.version_id !== publication.head.versionId) throw failure('OUTCOME_PUBLICATION_INVALID');
      pairs.set(row.outcome_id, freezeRecorded(publication));
    }
    const publicationBoundary = createOutcomePublicationBoundary({ workspaceId, snapshotId: randomUUID(), complete: !limited,
      expectedOutcomeCount: selected.length, resolveCommittedPublication: ({ outcomeId }) => pairs.get(outcomeId) || null });
    const versions = [...pairs.values()].map(pair => pair.version);
    const summary = aggregateBusinessOutcomes(versions, { workspaceId, now: at, publicationBoundary });
    return { summary: { ...summary, coverage: { ...summary.coverage, currentHeadLimit: OUTCOME_CURRENT_LIMIT, totalCurrentHeads: total, overflow: limited } },
      publications: [...pairs.values()], versions, publicationBoundary };
  }

  async function evidence(workspaceId, requestedVersionId) {
    tenant(workspaceId); versionId(requestedVersionId);
    let rows;
    try {
      const path = `runvara_business_outcome_versions?workspace_id=eq.${encodeURIComponent(workspaceId)}&version_id=eq.${requestedVersionId}&select=${VERSION_COLUMNS},source_measurement`;
      try { rows = await request(path + ',source_action&limit=2', { maxResponseBytes: 128 * 1024 }); }
      catch (cause) {
        // One bounded compatibility read for an older installed schema. It can
        // only return unlinked v1 evidence; linked data below still fails closed.
        if (!['42703', 'PGRST204'].includes(cause?.databaseCode)) throw cause;
        rows = await request(path + '&limit=2', { maxResponseBytes: 128 * 1024 });
      }
    } catch (cause) { throw readError(cause); }
    bounded(rows, 128 * 1024);
    if (!Array.isArray(rows) || rows.length > 1) throw failure('OUTCOME_PUBLICATION_INVALID');
    if (!rows.length) throw failure('OUTCOME_VERSION_NOT_FOUND', 404);
    const at = now(), publication = pairFromRow(rows[0], workspaceId, at);
    if (publication.head.versionId !== requestedVersionId) throw failure('OUTCOME_PUBLICATION_INVALID');
    let sourceMeasurement;
    try { sourceMeasurement = validateExperimentOutcomeMeasurement(rows[0].source_measurement, {
      workspaceId, experimentId: publication.version.source.experimentId, now: at }); }
    catch { throw failure('OUTCOME_SOURCE_INVALID'); }
    if (sourceMeasurement.digest !== publication.version.source.measurementDigest
      || sourceMeasurement.revision !== publication.version.source.measurementRevision) throw failure('OUTCOME_SOURCE_INVALID');
    let sourceAction = null;
    try {
      const stored = rows[0].source_action ?? null;
      if (sourceMeasurement.intervention) {
        sourceAction = validateReviewedSourceAction(stored, { workspaceId });
        if (digestMeasurementValue(actionIntervention(sourceAction, sourceMeasurement.intervention.reuseVersionId)) !== digestMeasurementValue(sourceMeasurement.intervention)
          || digestMeasurementValue(publication.version.links) !== digestMeasurementValue(sourceMeasurement.links)) throw failure('OUTCOME_SOURCE_INVALID');
      } else if (stored !== null || publication.version.links.action !== null || publication.version.links.approval !== null) throw failure('OUTCOME_SOURCE_INVALID');
    } catch { throw failure('OUTCOME_SOURCE_INVALID'); }
    return bounded({ publication, sourceMeasurement, sourceAction, currentStatus: 'not_checked', source: 'immutable_business_outcome_version' }, 128 * 1024);
  }
  async function one(workspaceId, experimentId) {
    tenant(workspaceId); identifier(experimentId);
    const logicalId = `outcome_${digestMeasurementValue([workspaceId, 'experiment_measurement', experimentId, 'incrementalContribution'])}`;
    let rows;
    try {
      rows = await request(`runvara_business_outcome_heads?workspace_id=eq.${encodeURIComponent(workspaceId)}&outcome_id=eq.${logicalId}&select=${CURRENT_COLUMNS}&limit=2`, { maxResponseBytes: 128 * 1024 });
    } catch (cause) { throw readError(cause); }
    bounded(rows, 128 * 1024);
    if (!Array.isArray(rows) || rows.length > 1) throw failure('OUTCOME_PUBLICATION_INVALID');
    if (!rows.length) return null;
    const row = rows[0];
    if (!plain(row) || row.workspace_id !== workspaceId || row.outcome_id !== logicalId) throw failure('OUTCOME_PUBLICATION_INVALID');
    const publication = pairFromRow(row.version, workspaceId, now());
    if (publication.head.outcomeId !== logicalId || publication.head.versionId !== row.version_id
      || publication.version.source.experimentId !== experimentId) throw failure('OUTCOME_PUBLICATION_INVALID');
    return publication;
  }
  async function review(workspaceId, experimentId) {
    tenant(workspaceId); identifier(experimentId);
    let result;
    try {
      result = await request('rpc/runvara_read_business_outcome_review', { method: 'POST', maxResponseBytes: 128 * 1024,
        body: JSON.stringify({ p_workspace_id: workspaceId, p_experiment_id: experimentId }) });
    } catch (cause) {
      const mapped = failures[cause?.databaseCode];
      if (mapped) throw failure(...mapped);
      throw readError(cause);
    }
    bounded(result, 128 * 1024);
    try {
      exact(result, ['workspaceId', 'workspaceRevision', 'experiment', 'measurement', 'current', 'actionLinkContract', 'actionChoices', 'currentActionAssociation']);
      exact(result.experiment, ['id', 'title', 'status']);
      if (result.workspaceId !== workspaceId || result.experiment.id !== experimentId
        || (result.experiment.title !== null && (typeof result.experiment.title !== 'string' || result.experiment.title.length > 180))
        || (result.experiment.status !== null && (typeof result.experiment.status !== 'string' || result.experiment.status.length > 40))) throw failure('OUTCOME_PUBLICATION_INVALID');
      identifier(result.workspaceRevision);
      const at = now();
      const measurement = result.measurement === null ? null : validateExperimentOutcomeMeasurement(result.measurement, { workspaceId, experimentId, now: at });
      const assessment = measurement === null ? null : assessExperimentOutcomeMeasurement(measurement, { workspaceId, experimentId, now: at });
      let currentPublication = null;
      if (result.current !== null) {
        const row = result.current;
        if (!plain(row) || row.workspace_id !== workspaceId) throw failure('OUTCOME_PUBLICATION_INVALID');
        currentPublication = pairFromRow(row.version, workspaceId, at);
        if (row.outcome_id !== currentPublication.head.outcomeId || row.version_id !== currentPublication.head.versionId
          || currentPublication.version.source.experimentId !== experimentId) throw failure('OUTCOME_PUBLICATION_INVALID');
      }
      let actionLinkContract = null, actionChoices = [], currentActionAssociation = null;
      if (Object.hasOwn(result, 'actionLinkContract')) {
        if (result.actionLinkContract !== REVIEWED_ACTION_CONTRACT || !Array.isArray(result.actionChoices) || result.actionChoices.length > 20) throw failure('OUTCOME_REVIEW_INVALID');
        const ids = new Set();
        actionChoices = result.actionChoices.map(row => {
          exact(row, ['id','account','productId','title','completedAt','digest']); identifier(row.id); hash(row.digest);
          if (ids.has(row.id) || typeof row.account !== 'string' || row.account.length > 253 || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(row.account)
            || typeof row.productId !== 'string' || row.productId.length > 160 || !/^gid:\/\/shopify\/Product\/\d+$/.test(row.productId)
            || typeof row.title !== 'string' || row.title.length > 200 || !row.title.isWellFormed()
            || typeof row.completedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.completedAt)
            || !Number.isFinite(Date.parse(row.completedAt)) || new Date(row.completedAt).toISOString() !== row.completedAt) throw failure('OUTCOME_REVIEW_INVALID');
          ids.add(row.id); return { ...row };
        });
        bounded(actionChoices, 16384); actionLinkContract = REVIEWED_ACTION_CONTRACT;
        if (result.currentActionAssociation !== null) {
          currentActionAssociation = validateActionIntervention(result.currentActionAssociation, workspaceId);
          if (!currentPublication || digestMeasurementValue(currentPublication.version.links) !== digestMeasurementValue({ action: currentActionAssociation.action, approval: currentActionAssociation.approval, objective: null, opportunity: null })) throw failure('OUTCOME_REVIEW_INVALID');
        } else if (currentPublication?.version.links.action !== null && currentPublication?.version.links.action !== undefined) throw failure('OUTCOME_REVIEW_INVALID');
      } else if (Object.hasOwn(result, 'actionChoices') || Object.hasOwn(result, 'currentActionAssociation') || measurement?.intervention || currentPublication?.version.links.action) throw failure('OUTCOME_REVIEW_INVALID');
      const review = { actionLinkContract, actionChoices, currentActionAssociation, workspaceId, workspaceRevision: result.workspaceRevision, experiment: { ...result.experiment }, measurement, assessment, currentPublication };
      return bounded({ ...review, relationships: projectValidatedSelectedReview(review, at) }, 128 * 1024);
    } catch { throw failure('OUTCOME_REVIEW_INVALID'); }
  }
  return { publish, current, one, evidence, review };
}
