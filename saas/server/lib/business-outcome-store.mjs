import { REVIEWED_OBJECTIVE_ACTION_CONTRACT, supportsReviewedActions, supportsReviewedActionSource, publicReviewedSourceAction, validateRecordedObjectiveReference, validateReviewedSourceAction, validateActionIntervention, actionIntervention } from './reviewed-action-evidence.mjs';
import { validateProtectedReceiptSelector, validateProtectedReceiptSource, validateProtectedReceiptChoice, resolveProtectedReceiptEvidence, publicProtectedReceiptSource } from './protected-receipt-source.mjs';
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
// Receipt admission/session/claim material never becomes an enumerable review
// property, including on the internal result. Only the trusted draft adapter can
// retrieve this detached proof from its validated review identity.
const protectedReviewEvidence = new WeakMap();
export const selectedProtectedReceiptEvidence = review => protectedReviewEvidence.get(review) ?? null;
export const OUTCOME_RECEIPT_LINK_CONTRACT = 'runvara-protected-content-source/v1';
const PROTECTED_MEASUREMENT_SCHEMA = 'runvara-experiment-measurement/v4';
const ATTEMPT = /^content_attempt_[a-f0-9]{64}$/;
export function outcomeContentSourceReadOptions(input = {}) {
  exact(input, ['receipt', 'afterAttemptId']);
  const receipt = input.receipt == null ? null : validateProtectedReceiptSelector(input.receipt);
  const afterAttemptId = input.afterAttemptId ?? null;
  if (afterAttemptId !== null && (typeof afterAttemptId !== 'string' || !ATTEMPT.test(afterAttemptId))
    || receipt && afterAttemptId !== null) throw failure('OUTCOME_REQUEST_INVALID', 400);
  return { receipt, afterAttemptId };
}

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
        if (sourceMeasurement.schema === PROTECTED_MEASUREMENT_SCHEMA) validateProtectedReceiptSource(sourceMeasurement.receiptSource, { workspaceId, sourceDigest: sourceAction.digest });
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
  function validatedReview(result, workspaceId, experimentId, { protectedReader = false } = {}) {
    bounded(result, 128 * 1024);
    try {
      exact(result, ['workspaceId', 'workspaceRevision', 'experiment', 'measurement', 'current', 'actionLinkContract', 'actionChoices', 'currentActionAssociation']);
      exact(result.experiment, ['id', 'title', 'status']);
      if (result.workspaceId !== workspaceId || result.experiment.id !== experimentId
        || (result.experiment.title !== null && (typeof result.experiment.title !== 'string' || result.experiment.title.length > 180))
        || (result.experiment.status !== null && (typeof result.experiment.status !== 'string' || result.experiment.status.length > 40))) throw failure('OUTCOME_PUBLICATION_INVALID');
      identifier(result.workspaceRevision);
      const at = now();
      if (!protectedReader && result.measurement?.schema === PROTECTED_MEASUREMENT_SCHEMA) throw failure('OUTCOME_REVIEW_INVALID');
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
        if (!supportsReviewedActions(result.actionLinkContract) || !Array.isArray(result.actionChoices) || result.actionChoices.length > 20) throw failure('OUTCOME_REVIEW_INVALID');
        const ids = new Set();
        actionChoices = result.actionChoices.map(row => {
          const objective = Object.hasOwn(row, 'origin');
          exact(row, ['id','account','productId','title','completedAt','digest', ...(objective ? ['origin','originatingObjective'] : [])]); identifier(row.id); hash(row.digest);
          if (objective && (result.actionLinkContract !== REVIEWED_OBJECTIVE_ACTION_CONTRACT || row.origin !== 'owner_objective_content')) throw failure('OUTCOME_REVIEW_INVALID');
          if (objective) validateRecordedObjectiveReference(row.originatingObjective, workspaceId);
          if (ids.has(row.id) || typeof row.account !== 'string' || row.account.length > 253 || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(row.account)
            || typeof row.productId !== 'string' || row.productId.length > 160 || !/^gid:\/\/shopify\/Product\/\d+$/.test(row.productId)
            || typeof row.title !== 'string' || row.title.length > 200 || !row.title.isWellFormed()
            || typeof row.completedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.completedAt)
            || !Number.isFinite(Date.parse(row.completedAt)) || new Date(row.completedAt).toISOString() !== row.completedAt) throw failure('OUTCOME_REVIEW_INVALID');
          ids.add(row.id); return { ...row };
        });
        bounded(actionChoices, 16384); actionLinkContract = result.actionLinkContract;
        if (result.currentActionAssociation !== null) {
          currentActionAssociation = validateActionIntervention(result.currentActionAssociation, workspaceId);
          if (!currentPublication || digestMeasurementValue(currentPublication.version.links) !== digestMeasurementValue({ action: currentActionAssociation.action, approval: currentActionAssociation.approval, objective: null, opportunity: null })) throw failure('OUTCOME_REVIEW_INVALID');
        } else if (currentPublication?.version.links.action !== null && currentPublication?.version.links.action !== undefined) throw failure('OUTCOME_REVIEW_INVALID');
      } else if (Object.hasOwn(result, 'actionChoices') || Object.hasOwn(result, 'currentActionAssociation') || measurement?.intervention || currentPublication?.version.links.action) throw failure('OUTCOME_REVIEW_INVALID');
      if (actionLinkContract !== REVIEWED_OBJECTIVE_ACTION_CONTRACT
        && (measurement?.schema === 'runvara-experiment-measurement/v3' || measurement?.intervention?.schema === 'runvara-owner-action-association/v2' || currentActionAssociation?.schema === 'runvara-owner-action-association/v2')) throw failure('OUTCOME_REVIEW_INVALID');
      const review = { actionLinkContract, actionChoices, currentActionAssociation, workspaceId, workspaceRevision: result.workspaceRevision, experiment: { ...result.experiment }, measurement, assessment, currentPublication };
      return bounded({ ...review, relationships: projectValidatedSelectedReview(review, at) }, 128 * 1024);
    } catch { throw failure('OUTCOME_REVIEW_INVALID'); }
  }
  async function review(workspaceId, experimentId, actor = null, options = {}) {
    tenant(workspaceId); identifier(experimentId);
    exact(options, ['receipt', 'afterAttemptId', 'requireReceiptContract', 'resolveSavedSource']);
    const requireReceiptContract = options.requireReceiptContract ?? false, resolveSavedSource = options.resolveSavedSource ?? true;
    if (typeof requireReceiptContract !== 'boolean' || typeof resolveSavedSource !== 'boolean') throw failure('OUTCOME_REQUEST_INVALID', 400);
    const selection = outcomeContentSourceReadOptions({ receipt: options.receipt, afterAttemptId: options.afterAttemptId });
    const legacyParams = { p_workspace_id: workspaceId, p_experiment_id: experimentId };
    // The retained no-actor internal signature is strictly the old invoker
    // reader. It cannot request protected evidence or accept a v4 draft.
    if (actor === null) {
      if (!resolveSavedSource || requireReceiptContract || selection.receipt || selection.afterAttemptId) throw failure('OUTCOME_REQUEST_INVALID', 400);
      let result;
      try { result = await request('rpc/runvara_read_business_outcome_review', { method: 'POST', maxResponseBytes: 128 * 1024, body: JSON.stringify(legacyParams) }); }
      catch (cause) { const mapped = failures[cause?.databaseCode]; if (mapped) throw failure(...mapped); throw readError(cause); }
      return validatedReview(result, workspaceId, experimentId);
    }
    exact(actor, ['id', 'sessionVersion']); identifier(actor.id); positive(actor.sessionVersion);
    let result;
    try {
      result = await request('rpc/runvara_read_outcome_content_sources', { method: 'POST', maxResponseBytes: 128 * 1024,
        body: JSON.stringify({ ...legacyParams, p_actor_id: actor.id, p_actor_session_version: actor.sessionVersion,
          p_receipt_selector: selection.receipt, p_after_attempt_id: selection.afterAttemptId, p_resolve_saved_source: resolveSavedSource }) });
    } catch (cause) {
      // Exactly one compatibility fallback, and only for the absent function.
      // Denials, timeouts, missing tables, unknown responses and every explicit
      // protected request remain closed. The legacy parser rejects v4.
      if (cause?.databaseCode === 'PGRST202' && !requireReceiptContract && !selection.receipt && !selection.afterAttemptId) {
        let legacy;
        try { legacy = await request('rpc/runvara_read_business_outcome_review', { method: 'POST', maxResponseBytes: 128 * 1024, body: JSON.stringify(legacyParams) }); }
        catch (fallbackCause) { const mapped = failures[fallbackCause?.databaseCode]; if (mapped) throw failure(...mapped); throw readError(fallbackCause); }
        return validatedReview(legacy, workspaceId, experimentId);
      }
      const mapped = failures[cause?.databaseCode]; if (mapped) throw failure(...mapped); throw readError(cause);
    }
    bounded(result, 128 * 1024);
    try {
      exact(result, ['schema', 'review', 'receiptChoices', 'nextCursor', 'hasMore', 'selectedEvidence']);
      if (result.schema !== 'runvara-outcome-content-source-reader/v1' || !Array.isArray(result.receiptChoices)
        || result.receiptChoices.length > 20 || typeof result.hasMore !== 'boolean'
        || result.nextCursor !== null && !ATTEMPT.test(result.nextCursor)) throw failure('OUTCOME_REVIEW_INVALID');
      if (!resolveSavedSource && (result.review?.measurement !== null || result.receiptChoices.length
        || result.nextCursor !== null || result.hasMore)) throw failure('OUTCOME_REVIEW_INVALID');
      const parsed = validatedReview(result.review, workspaceId, experimentId, { protectedReader: true });
      const choices = result.receiptChoices.map(row => validateProtectedReceiptChoice(row, { workspaceId }));
      bounded(choices, 16384);
      if (choices.length && !supportsReviewedActions(parsed.actionLinkContract)
        || choices.some(choice => choice.origin === 'owner_objective_content') && parsed.actionLinkContract !== REVIEWED_OBJECTIVE_ACTION_CONTRACT) throw failure('OUTCOME_REVIEW_INVALID');
      let previous = selection.afterAttemptId;
      for (const choice of choices) {
        if (previous !== null && choice.receiptSource.attemptId <= previous) throw failure('OUTCOME_REVIEW_INVALID');
        previous = choice.receiptSource.attemptId;
      }
      if (result.hasMore ? !choices.length || result.nextCursor !== previous : result.nextCursor !== null) throw failure('OUTCOME_REVIEW_INVALID');
      let selectedReceiptSource = null, privateEvidence = null;
      if (result.selectedEvidence !== null) {
        const resolved = resolveProtectedReceiptEvidence(result.selectedEvidence, { workspaceId, selector: selection.receipt ?? undefined });
        if (!supportsReviewedActionSource(parsed.actionLinkContract, resolved.source)) throw failure('OUTCOME_REVIEW_INVALID');
        if (!selection.receipt) {
          if (selection.afterAttemptId || parsed.measurement?.schema !== PROTECTED_MEASUREMENT_SCHEMA
            || parsed.measurement.intervention.reuseVersionId !== null
            || digestMeasurementValue(resolved.receiptSource) !== digestMeasurementValue(parsed.measurement.receiptSource)
            || digestMeasurementValue(actionIntervention(resolved.source)) !== digestMeasurementValue(parsed.measurement.intervention)) throw failure('OUTCOME_REVIEW_INVALID');
        }
        selectedReceiptSource = publicProtectedReceiptSource(resolved.source, { workspaceId, receiptSource: resolved.receiptSource });
        const listed = choices.find(choice => choice.receiptSource.attemptId === resolved.receiptSource.attemptId);
        if (listed && digestMeasurementValue(listed) !== digestMeasurementValue({ receiptSource: resolved.receiptSource,
          actionId: resolved.source.context.writeId, account: resolved.source.context.account, productId: resolved.source.input.productId,
          title: resolved.source.input.title, completedAt: resolved.source.context.completedAt, origin: resolved.source.context.origin,
          originatingObjective: resolved.source.context.originatingObjective })) throw failure('OUTCOME_REVIEW_INVALID');
        privateEvidence = freezeRecorded(structuredClone(result.selectedEvidence));
      } else if (selection.receipt || !selection.afterAttemptId && parsed.measurement?.schema === PROTECTED_MEASUREMENT_SCHEMA
        && parsed.measurement.intervention.reuseVersionId === null) throw failure('OUTCOME_REVIEW_INVALID');
      const combined = { ...parsed, receiptLinkContract: OUTCOME_RECEIPT_LINK_CONTRACT,
        receiptChoices: choices, nextReceiptCursor: result.nextCursor, hasMoreReceipts: result.hasMore, selectedReceiptSource };
      bounded(combined, 128 * 1024);
      if (privateEvidence) protectedReviewEvidence.set(combined, privateEvidence);
      return combined;
    } catch { throw failure('OUTCOME_REVIEW_INVALID'); }
  }
  return { publish, current, one, evidence, review };
}

// Keep evidence() private and complete for same-outcome correction/reuse. Only
// this explicit HTTP projection omits private v2 proposal/claim/approval data.
export function publicBusinessOutcomeEvidence(result, { workspaceId }) {
  exact(result, ['publication','sourceMeasurement','sourceAction','currentStatus','source']);
  if (result.currentStatus !== 'not_checked' || result.source !== 'immutable_business_outcome_version') throw failure('OUTCOME_SOURCE_INVALID');
  if (result.sourceMeasurement?.schema === PROTECTED_MEASUREMENT_SCHEMA) {
    const source = validateReviewedSourceAction(result.sourceAction, { workspaceId });
    const measurement = validateExperimentOutcomeMeasurement(result.sourceMeasurement, { workspaceId,
      experimentId: result.publication.version.source.experimentId, now: new Date() });
    if (measurement.digest !== result.publication.version.source.measurementDigest
      || measurement.revision !== result.publication.version.source.measurementRevision
      || digestMeasurementValue(actionIntervention(source, measurement.intervention.reuseVersionId)) !== digestMeasurementValue(measurement.intervention)
      || digestMeasurementValue(measurement.links) !== digestMeasurementValue(result.publication.version.links)) throw failure('OUTCOME_SOURCE_INVALID');
    validateProtectedReceiptSource(measurement.receiptSource, { workspaceId, sourceDigest: source.digest });
  }
  const sourceAction = result.sourceAction === null ? null : result.sourceMeasurement?.schema === PROTECTED_MEASUREMENT_SCHEMA
    ? publicProtectedReceiptSource(result.sourceAction, { workspaceId, receiptSource: result.sourceMeasurement.receiptSource })
    : publicReviewedSourceAction(result.sourceAction, { workspaceId });
  return bounded({ publication: result.publication, sourceMeasurement: result.sourceMeasurement, sourceAction,
    currentStatus: result.currentStatus, source: result.source }, 128 * 1024);
}

// Never spread the internal RPC result into an HTTP response. In particular,
// neither a future private property nor selectedEvidence may reach the browser.
export function publicBusinessOutcomeReview(result) {
  return bounded({ workspaceId: result.workspaceId, workspaceRevision: result.workspaceRevision,
    experiment: result.experiment, measurement: result.measurement, assessment: result.assessment,
    currentPublication: result.currentPublication, actionLinkContract: result.actionLinkContract,
    actionChoices: result.actionChoices, currentActionAssociation: result.currentActionAssociation,
    relationships: result.relationships, receiptLinkContract: result.receiptLinkContract ?? null,
    receiptChoices: result.receiptChoices ?? [], nextReceiptCursor: result.nextReceiptCursor ?? null,
    hasMoreReceipts: result.hasMoreReceipts ?? false, selectedReceiptSource: result.selectedReceiptSource ?? null }, 128 * 1024);
}
