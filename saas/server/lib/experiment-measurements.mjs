import { createHash } from 'node:crypto';
import { actionIntervention, validateActionIntervention, validateActionSelection, validateReviewedSourceAction } from './reviewed-action-evidence.mjs';
import { resolveProtectedReceiptEvidence, validateProtectedReceiptSource } from './protected-receipt-source.mjs';
import { contentReceiptJsonbBytes } from './content-execution-receipt.mjs';
import { normalizeOutcomeDecimal, BUSINESS_OUTCOME_CURRENCIES } from './business-outcomes.mjs';

/**
 * Typed measurement preparation only. No database, state mutation, owner
 * attestation, model/provider call or publication authority is created here.
 *
 * prepareExperimentOutcomeMeasurement(ownerInput, {
 *   workspaceId, experimentId, actorId, now, previousMeasurement
 * }) returns the envelope the authenticated owner/admin route may assign to
 * experiment.outcomeMeasurement under its existing workspace CAS. The context
 * MUST come from the server/session/current experiment, never request JSON.
 * expectedRevision is required in ownerInput: 0 on create, previous.revision on
 * edit. The route owns authorization and must leave legacy impact untouched.
 *
 * The later owner-only publisher independently loads this exact persisted
 * envelope, resolves its one co-persisted server-recorded report, recomputes
 * both canonical digests and verifies all normalized facts. It must not accept
 * arbitrary imported reference hashes as resolved evidence. Its immutable
 * outcome version should retain this source envelope for audit/corrections.
 *
 * Initial links are all null. Whole-business scope and standalone aggregation
 * are server-derived, so experiment/observation renaming cannot claim disjoint
 * populations. Genuine disjoint cohorts need a later real source resolver.
 */
export const EXPERIMENT_MEASUREMENT_SCHEMA = 'runvara-experiment-measurement/v1';
export const LINKED_EXPERIMENT_MEASUREMENT_SCHEMA = 'runvara-experiment-measurement/v2';
export const LINKED_MEASUREMENT_REPORT_SCHEMA = 'runvara-measurement-report/v2';
export const OBJECTIVE_LINKED_EXPERIMENT_MEASUREMENT_SCHEMA = 'runvara-experiment-measurement/v3';
export const OBJECTIVE_LINKED_MEASUREMENT_REPORT_SCHEMA = 'runvara-measurement-report/v3';
export const PROTECTED_EXPERIMENT_MEASUREMENT_SCHEMA = 'runvara-experiment-measurement/v4';
export const PROTECTED_MEASUREMENT_REPORT_SCHEMA = 'runvara-measurement-report/v4';
export const MEASUREMENT_REPORT_SCHEMA = 'runvara-measurement-report/v1';
export const EXPERIMENT_MEASUREMENT_MAX_BYTES = 8192;
export const EXPERIMENT_MEASUREMENT_JSONB_MAX_BYTES = 12288;
export const MEASUREMENT_REPORT_DESCRIPTION_MAX = 1000;
const METRIC = 'incrementalContribution';
const DEFINITION = 'incremental-contribution/v1';
const DAY = 86400000;
const METHODS = ['holdout', 'before_after', 'reconciled_manual', 'unknown'];
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const HASH = /^[0-9a-f]{64}$/;
const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (message, code = 'MEASUREMENT_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const blocker = (code, field) => ({ code, field });
function descriptors(value, name) {
  if (!plain(value)) throw fail(`${name} must be a plain recorded object`);
  const rows = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || Object.values(rows).some(row => !row.enumerable || !own(row, 'value'))) throw fail(`${name} must not contain hidden or computed data`);
  return rows;
}
function exact(value, fields, name) {
  const rows = descriptors(value, name);
  if (Object.keys(rows).some(key => !fields.includes(key))) throw fail(`Unsupported ${name} field`);
  return rows;
}
function jsonString(value) {
  if (!value.isWellFormed() || value.includes('\u0000')) throw fail('Text is not compatible with recorded PostgreSQL JSONB data');
  return JSON.stringify(value);
}

/** Sorted-key compact JSON, matching the outcome contract's canonical rules.
 * The typed envelope uses only safe integer JSON numbers; monetary values are
 * exact decimal strings. Never hash PostgreSQL jsonb::text/key insertion order.
 * Dense arrays, ordinary descriptors and valid Unicode are required.
 */
export function canonicalMeasurementJson(value) {
  const ancestors = new Set();
  function serialize(item, depth) {
    if (depth > 24) throw fail('Measurement data nesting exceeds its bound');
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'string') return jsonString(item);
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item)) throw fail('Measurement JSON numbers must be safe integers');
      return JSON.stringify(item);
    }
    if (ancestors.has(item)) throw fail('Measurement data must not contain cycles');
    ancestors.add(item);
    let encoded;
    if (Array.isArray(item)) {
      if (![Array.prototype, null].includes(Object.getPrototypeOf(item)) || Object.getOwnPropertySymbols(item).length) throw fail('Measurement arrays must be plain recorded data');
      const length = Object.getOwnPropertyDescriptor(item, 'length')?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 32) throw fail('Measurement array is invalid or oversized');
      const rows = Object.getOwnPropertyDescriptors(item);
      if (Object.keys(rows).some(key => key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))) throw fail('Measurement array is invalid or oversized');
      const parts = [];
      for (let index = 0; index < length; index++) {
        const entry = rows[index];
        if (!entry || !entry.enumerable || !own(entry, 'value')) throw fail('Measurement arrays must be dense and free of accessors');
        parts.push(serialize(entry.value, depth + 1));
      }
      encoded = '[' + parts.join(',') + ']';
    } else {
      const rows = descriptors(item, 'Canonical measurement object');
      encoded = '{' + Object.keys(rows).sort().map(key => jsonString(key) + ':' + serialize(rows[key].value, depth + 1)).join(',') + '}';
    }
    ancestors.delete(item);
    return encoded;
  }
  return serialize(value, 0);
}
export function digestMeasurementValue(value) {
  return createHash('sha256').update(canonicalMeasurementJson(value), 'utf8').digest('hex');
}
function opaque(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) throw fail(`${label} must be a bounded opaque identifier`);
  return value;
}
function workspace(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || value !== value.trim() || !value.isWellFormed() || /[\u0000-\u001f\u007f]/.test(value)) throw fail('Workspace identity is required', 'WORKSPACE_REQUIRED');
  return value;
}
function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw fail(`${label} must be an ISO UTC timestamp`);
  const parsed = Date.parse(value), normalized = value.includes('.') ? value : value.slice(0, -1) + '.000Z';
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) throw fail(`${label} is not a valid calendar timestamp`);
  return normalized;
}
function trustedNow(value) {
  return timestamp(value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : value, 'Trusted server time');
}
function number(value, label, { minimum = 0, maximum = 1000000000, nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw fail(`${label} must be a bounded integer`);
  return value === 0 ? 0 : value;
}
function enumValue(value, allowed, label) {
  if (!allowed.includes(value)) throw fail(`Invalid ${label}`);
  return value;
}
function normalizeCurrency(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value) || !BUSINESS_OUTCOME_CURRENCIES.includes(value)) throw fail('Currency must be an explicit supported uppercase code');
  return value;
}
function description(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || value.trim().length > MEASUREMENT_REPORT_DESCRIPTION_MAX || /[\u0000-\u001f\u007f]/.test(value)) throw fail('A nonempty plain measurement description of at most 1000 characters is required');
  return value.trim();
}
const INPUT_FIELDS = ['expectedRevision', 'amount', 'currency', 'window', 'coverage', 'method', 'observedAt', 'report', 'actionSelection'];
function normalizeInput(input, context) {
  exact(input, INPUT_FIELDS, 'measurement input');
  if (own(input, 'actionSelection')) validateActionSelection(input.actionSelection);
  const expectedRevision = number(input.expectedRevision, 'Expected revision', { maximum: Number.MAX_SAFE_INTEGER });
  let amount;
  try { amount = normalizeOutcomeDecimal(input.amount); } catch { throw fail('Amount must be an exact decimal string with at most 18 integer and 6 fractional digits, or null'); }
  const currency = normalizeCurrency(input.currency);
  const suppliedWindow = input.window ?? null;
  let window = null;
  if (suppliedWindow !== null) {
    exact(suppliedWindow, ['startsAt', 'endsAt'], 'measurement window');
    window = { startsAt: timestamp(suppliedWindow.startsAt, 'Window start'), endsAt: timestamp(suppliedWindow.endsAt, 'Window end') };
    if (window.startsAt >= window.endsAt || Date.parse(window.endsAt) - Date.parse(window.startsAt) > 366 * DAY) throw fail('Measurement window must be ordered and no longer than 366 days');
  }
  const suppliedCoverage = input.coverage ?? { status: 'unknown', observedCount: null, expectedCount: null };
  exact(suppliedCoverage, ['status', 'observedCount', 'expectedCount'], 'coverage');
  const coverage = { status: enumValue(suppliedCoverage.status, ['complete', 'partial', 'unknown'], 'coverage status'),
    scopeId: `whole_business_${digestMeasurementValue([context.workspaceId, 'whole-business'])}`,
    observedCount: number(suppliedCoverage.observedCount ?? null, 'Observed population', { nullable: true }),
    expectedCount: number(suppliedCoverage.expectedCount ?? null, 'Expected population', { nullable: true }) };
  if (coverage.observedCount !== null && coverage.expectedCount !== null && coverage.observedCount > coverage.expectedCount) throw fail('Observed population cannot exceed the expected population');
  if (coverage.status === 'complete' && (coverage.observedCount === null || coverage.expectedCount === null || coverage.observedCount !== coverage.expectedCount)) throw fail('Complete coverage requires matching explicit population counts');
  if (coverage.status === 'complete' && coverage.observedCount === 0 && amount !== null && amount !== '0') throw fail('Zero population cannot establish nonzero contribution');
  if (coverage.status === 'partial' && coverage.observedCount !== null && coverage.expectedCount !== null && coverage.observedCount >= coverage.expectedCount) throw fail('Partial coverage cannot assert a complete population');
  const suppliedMethod = input.method ?? { kind: 'unknown' };
  exact(suppliedMethod, ['kind'], 'method');
  const method = { kind: enumValue(suppliedMethod.kind, METHODS, 'measurement method'), definitionVersion: DEFINITION };
  const observedAt = input.observedAt == null ? null : timestamp(input.observedAt, 'Evidence observation time');
  if (observedAt !== null && observedAt > context.recordedAt) throw fail('Evidence observation time cannot be later than the server recording time');
  exact(input.report, ['description', 'costsComplete'], 'measurement report input');
  const costsComplete = input.report.costsComplete ?? null;
  if (costsComplete !== null && typeof costsComplete !== 'boolean') throw fail('Cost completeness must be true, false or null');
  return { expectedRevision, amount, currency, window, coverage, method, observedAt,
    description: description(input.report.description), costsComplete };
}
function buildMeasurement(facts, context, revision) {
  const { workspaceId, experimentId, actorId: recordedBy, recordedAt } = context;
  const reportFacts = { metric: METRIC, amount: facts.amount, currency: facts.currency, window: facts.window,
    coverage: facts.coverage, method: facts.method, observedAt: facts.observedAt, ...(facts.intervention ? { intervention: facts.intervention } : {}),
    ...(facts.receiptSource ? { receiptSource: facts.receiptSource } : {}) };
  const objective = facts.intervention?.schema === 'runvara-owner-action-association/v2';
  const reportBody = { schema: facts.receiptSource ? PROTECTED_MEASUREMENT_REPORT_SCHEMA : objective ? OBJECTIVE_LINKED_MEASUREMENT_REPORT_SCHEMA : facts.intervention ? LINKED_MEASUREMENT_REPORT_SCHEMA : MEASUREMENT_REPORT_SCHEMA,
    id: `measurement_report_${digestMeasurementValue([workspaceId, experimentId, revision])}`,
    workspaceId, experimentId, measurementRevision: revision, recordedBy, recordedAt,
    description: facts.description, costsComplete: facts.costsComplete, facts: reportFacts };
  const report = { ...reportBody, digest: digestMeasurementValue(reportBody) };
  const body = { schema: facts.receiptSource ? PROTECTED_EXPERIMENT_MEASUREMENT_SCHEMA : objective ? OBJECTIVE_LINKED_EXPERIMENT_MEASUREMENT_SCHEMA : facts.intervention ? LINKED_EXPERIMENT_MEASUREMENT_SCHEMA : EXPERIMENT_MEASUREMENT_SCHEMA, workspaceId, experimentId, revision, recordedBy, recordedAt,
    metric: METRIC, amount: facts.amount, currency: facts.currency, window: facts.window, coverage: facts.coverage, method: facts.method,
    provenance: { observationId: `measurement_observation_${digestMeasurementValue([workspaceId, experimentId])}`,
      sourceRefs: [{ type: 'measurement_report', id: report.id, digest: report.digest }], observedAt: facts.observedAt, aggregation: 'standalone' },
    links: { action: facts.intervention?.action ?? null, opportunity: null, approval: facts.intervention?.approval ?? null, objective: null },
    ...(facts.intervention ? { intervention: facts.intervention } : {}), ...(facts.receiptSource ? { receiptSource: facts.receiptSource } : {}), report };
  const envelope = { ...body, digest: digestMeasurementValue(body) };
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > EXPERIMENT_MEASUREMENT_MAX_BYTES) throw fail('Typed measurement exceeds its 8 KiB serialized bound', 'MEASUREMENT_TOO_LARGE', 413);
  if (facts.receiptSource && contentReceiptJsonbBytes(envelope) > EXPERIMENT_MEASUREMENT_JSONB_MAX_BYTES) throw fail('Typed measurement exceeds its 12 KiB JSONB bound', 'MEASUREMENT_TOO_LARGE', 413);
  // Return detached ordinary data: the repeated report facts must not share
  // mutable nested objects with top-level fields or the caller's input.
  return JSON.parse(JSON.stringify(envelope));
}
function readContext(options, preparing = false) {
  exact(options, preparing ? ['workspaceId', 'experimentId', 'actorId', 'now', 'previousMeasurement', 'actionEvidence', 'reuseVersionId', 'receiptEvidence', 'reuseSourceMeasurement'] : ['workspaceId', 'experimentId', 'now'], 'trusted measurement context');
  return { workspaceId: workspace(options.workspaceId), experimentId: opaque(options.experimentId, 'Experiment ID'),
    ...(preparing ? { actorId: opaque(options.actorId, 'Recording actor ID') } : {}), recordedAt: trustedNow(options.now) };
}

export function prepareExperimentOutcomeMeasurement(input, options) {
  const context = readContext(options, true), facts = normalizeInput(input, context);
  const selection = validateActionSelection(input.actionSelection);
  if (selection) {
    let source;
    if (selection.receipt) {
      if (options.actionEvidence != null || options.reuseVersionId != null || options.reuseSourceMeasurement != null) throw fail('Receipt selection cannot reuse other action evidence');
      const resolved = resolveProtectedReceiptEvidence(options.receiptEvidence, { workspaceId: context.workspaceId, selector: selection.receipt });
      source = resolved.source; facts.receiptSource = resolved.receiptSource;
    } else {
      if (options.receiptEvidence != null) throw fail('Protected evidence requires an explicit receipt selection');
      source = validateReviewedSourceAction(options.actionEvidence, { workspaceId: context.workspaceId });
      if (selection.actionId ? selection.actionId !== source.context.writeId || options.reuseVersionId != null || options.reuseSourceMeasurement != null
        : selection.reuseVersionId !== options.reuseVersionId) throw fail('Action selection does not match resolved evidence');
      if (options.reuseSourceMeasurement != null) {
        // This envelope must come from the exact immutable same-outcome version
        // supplied by the trusted adapter. It is never a mutable reference or a
        // receipt-ledger/current-history lookup during published-version reuse.
        const reused = validateExperimentOutcomeMeasurement(options.reuseSourceMeasurement, {
          workspaceId: context.workspaceId, experimentId: context.experimentId, now: context.recordedAt });
        if (!reused.intervention || digestMeasurementValue(actionIntervention(source, reused.intervention.reuseVersionId)) !== digestMeasurementValue(reused.intervention)) throw fail('Published action and source measurement do not match');
        if (reused.receiptSource) facts.receiptSource = validateProtectedReceiptSource(reused.receiptSource, { workspaceId: context.workspaceId, sourceDigest: source.digest });
      }
    }
    facts.intervention = actionIntervention(source, options.reuseVersionId ?? null);
    if (facts.intervention.completedAt > context.recordedAt) throw fail('Action completion is in the future');
  } else if (options.actionEvidence != null || options.reuseVersionId != null || options.receiptEvidence != null || options.reuseSourceMeasurement != null) throw fail('Action evidence requires an explicit owner selection');
  const previous = options.previousMeasurement ?? null;
  const before = previous === null ? null : validateExperimentOutcomeMeasurement(previous, {
    workspaceId: context.workspaceId, experimentId: context.experimentId, now: context.recordedAt
  });
  if (before?.intervention && facts.intervention && before.intervention.action.id === facts.intervention.action.id
    && before.intervention.action.digest !== facts.intervention.action.digest) throw fail('Recorded action changed; select a different action or reuse its exact immutable version', 'MEASUREMENT_ACTION_CONFLICT', 409);
  if (before?.intervention && !own(input, 'actionSelection')) throw fail('Choose explicitly whether to retain, replace or remove the recorded action');
  if (facts.expectedRevision !== (before?.revision ?? 0)) throw fail('Measurement changed; reload before editing', 'MEASUREMENT_CONFLICT', 409);
  if (before && before.revision >= Number.MAX_SAFE_INTEGER) throw fail('Measurement revision is exhausted', 'MEASUREMENT_CONFLICT', 409);
  return buildMeasurement(facts, context, (before?.revision ?? 0) + 1);
}
const ENVELOPE_FIELDS = ['schema', 'workspaceId', 'experimentId', 'revision', 'recordedBy', 'recordedAt', 'metric', 'amount', 'currency', 'window', 'coverage', 'method', 'provenance', 'links', 'report', 'digest'];
const REPORT_FIELDS = ['schema', 'id', 'workspaceId', 'experimentId', 'measurementRevision', 'recordedBy', 'recordedAt', 'description', 'costsComplete', 'facts', 'digest'];

/** Structure, normalized facts, derived identities and digest binding only.
 * This does not authenticate the recording actor or establish a database commit.
 */
export function validateExperimentOutcomeMeasurement(envelope, options) {
  const trusted = readContext(options);
  const envelopeFields = descriptors(envelope, 'measurement envelope');
  const protectedSource = envelopeFields.schema?.value === PROTECTED_EXPERIMENT_MEASUREMENT_SCHEMA;
  const linked = [LINKED_EXPERIMENT_MEASUREMENT_SCHEMA, OBJECTIVE_LINKED_EXPERIMENT_MEASUREMENT_SCHEMA, PROTECTED_EXPERIMENT_MEASUREMENT_SCHEMA].includes(envelopeFields.schema?.value);
  exact(envelope, linked ? [...ENVELOPE_FIELDS, 'intervention', ...(protectedSource ? ['receiptSource'] : [])] : ENVELOPE_FIELDS, 'measurement envelope');
  if (envelope.workspaceId !== trusted.workspaceId) throw fail('Measurement workspace mismatch', 'WORKSPACE_MISMATCH', 403);
  if (envelope.experimentId !== trusted.experimentId) throw fail('Measurement experiment mismatch', 'EXPERIMENT_MISMATCH', 403);
  if (![EXPERIMENT_MEASUREMENT_SCHEMA, LINKED_EXPERIMENT_MEASUREMENT_SCHEMA, OBJECTIVE_LINKED_EXPERIMENT_MEASUREMENT_SCHEMA, PROTECTED_EXPERIMENT_MEASUREMENT_SCHEMA].includes(envelope.schema)) throw fail('Unsupported measurement schema');
  const revision = number(envelope.revision, 'Server measurement revision', { minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
  const context = { ...trusted, actorId: opaque(envelope.recordedBy, 'Recording actor ID'), recordedAt: timestamp(envelope.recordedAt, 'Recording timestamp') };
  if (context.recordedAt > trusted.recordedAt) throw fail('Measurement recording time is in the future');
  exact(envelope.coverage, ['status', 'scopeId', 'observedCount', 'expectedCount'], 'recorded coverage');
  exact(envelope.method, ['kind', 'definitionVersion'], 'recorded method');
  exact(envelope.provenance, ['observationId', 'sourceRefs', 'observedAt', 'aggregation'], 'recorded provenance');
  exact(envelope.report, REPORT_FIELDS, 'recorded measurement report');
  const facts = normalizeInput({ expectedRevision: revision - 1, amount: envelope.amount, currency: envelope.currency, window: envelope.window,
    coverage: { status: envelope.coverage.status, observedCount: envelope.coverage.observedCount, expectedCount: envelope.coverage.expectedCount },
    method: { kind: envelope.method.kind }, observedAt: envelope.provenance.observedAt,
    report: { description: envelope.report.description, costsComplete: envelope.report.costsComplete } }, context);
  if (linked) {
    facts.intervention = validateActionIntervention(envelope.intervention, trusted.workspaceId);
    if (facts.intervention.completedAt > context.recordedAt) throw fail('Action completion is in the future');
  }
  if (protectedSource) facts.receiptSource = validateProtectedReceiptSource(envelope.receiptSource, {
    workspaceId: trusted.workspaceId, sourceDigest: facts.intervention.action.digest });
  const expected = buildMeasurement(facts, context, revision);
  if (typeof envelope.digest !== 'string' || !HASH.test(envelope.digest) || canonicalMeasurementJson(envelope) !== canonicalMeasurementJson(expected)) throw fail('Measurement/report facts, identity or canonical digest do not match', 'MEASUREMENT_INTEGRITY_FAILED', 409);
  return expected;
}

export function assessExperimentOutcomeMeasurement(envelope, options) {
  const measurement = validateExperimentOutcomeMeasurement(envelope, options), blockers = [];
  if (measurement.amount === null) blockers.push(blocker('AMOUNT_UNKNOWN', 'amount'));
  if (measurement.currency === null) blockers.push(blocker('CURRENCY_UNKNOWN', 'currency'));
  if (measurement.window === null) blockers.push(blocker('WINDOW_UNKNOWN', 'window'));
  if (measurement.coverage.status !== 'complete') blockers.push(blocker('COVERAGE_INCOMPLETE', 'coverage'));
  if (measurement.method.kind === 'unknown') blockers.push(blocker('METHOD_UNKNOWN', 'method'));
  if (measurement.provenance.observedAt === null) blockers.push(blocker('OBSERVATION_TIME_UNKNOWN', 'provenance.observedAt'));
  else if (measurement.window && measurement.provenance.observedAt < measurement.window.endsAt) blockers.push(blocker('OBSERVATION_BEFORE_WINDOW_END', 'provenance.observedAt'));
  if (measurement.report.costsComplete !== true) blockers.push(blocker(measurement.report.costsComplete === false ? 'COSTS_INCOMPLETE' : 'COST_COMPLETENESS_UNKNOWN', 'report.costsComplete'));
  return { schema: 'runvara-experiment-measurement-assessment/v1', workspaceId: measurement.workspaceId, experimentId: measurement.experimentId,
    revision: measurement.revision, measurementDigest: measurement.digest, reportId: measurement.report.id, reportDigest: measurement.report.digest,
    measurementComplete: blockers.length === 0, readyForOwnerVerification: blockers.length === 0, blockers,
    ownerVerificationRequired: true, publicationAuthority: false, sourceReportBindingValid: true,
    evidenceBasis: 'server_recorded_owner_or_admin_report', independentSourceVerification: false,
    legacyVerificationUsed: false, runvaraAttribution: 'unestablished', externalWrites: false };
}
