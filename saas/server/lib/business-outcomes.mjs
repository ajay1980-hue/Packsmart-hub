import { createHash } from 'node:crypto';

/**
 * Pure outcome contract, not a publication/authorization service.
 *
 * createBusinessOutcomeCandidate(input, { workspaceId, now }) creates a first
 * draft candidate. correctBusinessOutcomeCandidate(previous, replacement,
 * options) and withdrawBusinessOutcomeCandidate(previous, request, options)
 * create immutable successor candidates; they never alter the predecessor.
 *
 * Later persistence MUST validate the authenticated owner, source measurement
 * revision/digest, same-tenant links, expected current head, and idempotency in
 * the SAME transaction as the workspace CAS and version/head publication.
 * source.measurementDigest must cover the immutable measurement identity,
 * revision and provenance context, not merely its numeric amount. The trusted
 * publisher must recompute it from the authoritative typed source. Shared
 * ledger inputs are not shared experiment-measurement identities.
 * Neither these candidates nor an ordinary archived `verified:true` record
 * prove that transaction committed.
 *
 * createOutcomePublicationBoundary({ workspaceId, snapshotId, complete,
 * expectedOutcomeCount, resolveCommittedPublication }) is a trusted server-adapter
 * capability. The synchronous resolver MUST read an already-materialized,
 * authoritative committed head/version snapshot, never request JSON or provisional
 * pre-CAS archives. Each lookup returns { head, version } from that snapshot.
 * A head without its matching committed version is insufficient.
 * This module cannot establish database durability or owner
 * authentication itself. No database schema, grants, provider or I/O are chosen.
 *
 * aggregateBusinessOutcomes(versions, { workspaceId, publicationBoundary })
 * requires that non-serializable capability. It selects only current proved
 * versions, preserves exact decimals, and withholds totals on incomplete reads.
 */
export const BUSINESS_OUTCOME_SCHEMA = 'runvara-business-outcome/v1';
export const BUSINESS_OUTCOME_METRIC = 'incrementalContribution';
// Application-supported input contract, shared literally with the SQL publisher.
// It is independent of host ICU and makes no FX/current-legal-tender claim.
export const BUSINESS_OUTCOME_CURRENCY_CONTRACT_VERSION = 'runvara-supported-currencies/v1';
export const BUSINESS_OUTCOME_CURRENCIES = Object.freeze('AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XCG XDR XOF XPF XSU YER ZAR ZMW ZWG ZWL'.split(' '));
export const BUSINESS_OUTCOME_LIMITS = Object.freeze({ versions: 500, sourceReferences: 20, integerDigits: 18, decimalPlaces: 6, windowDays: 366 });
const HEAD_SCHEMA = 'runvara-outcome-head/v1';
const DEFINITION = 'incremental-contribution/v1';
const DAY = 86400000;
const SCALE = 1000000n;
const DIGEST = /^[0-9a-f]{64}$/;
const OUTCOME_ID = /^outcome_[0-9a-f]{64}$/;
const VERSION_ID = /^outcome_version_[0-9a-f]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const METHODS = ['holdout', 'before_after', 'reconciled_manual', 'unknown'];
const WITHDRAWAL_REASONS = ['incorrect_measurement', 'duplicate_observation', 'incorrect_scope', 'evidence_retracted'];
const boundaries = new WeakMap();
const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (message, code = 'OUTCOME_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const issue = (code, field) => ({ code, field });
const lexical = (left, right) => left < right ? -1 : left > right ? 1 : 0;
function recordedObject(value, name) {
  if (!plain(value)) throw fail(`Invalid ${name}`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || Object.values(descriptors).some(row => !row.enumerable || !own(row, 'value'))) throw fail(`${name} must contain plain recorded data`);
  return descriptors;
}
function recordedArray(value, name, maximum = BUSINESS_OUTCOME_LIMITS.versions) {
  if (!Array.isArray(value) || ![Array.prototype, null].includes(Object.getPrototypeOf(value))) throw fail(`${name} must be a dense recorded array`);
  const descriptors = Object.getOwnPropertyDescriptors(value), length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum || Object.getOwnPropertySymbols(value).length) throw fail(`${name} must be a bounded recorded array`);
  if (Object.keys(descriptors).some(key => key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))) throw fail(`${name} contains non-recorded array fields`);
  const copied = [];
  for (let index = 0; index < length; index++) {
    const entry = descriptors[index];
    if (!entry || !entry.enumerable || !own(entry, 'value')) throw fail(`${name} must not contain holes, inherited values or accessors`);
    copied.push(entry.value);
  }
  return copied;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + recordedArray(value, 'Canonical array').map(canonical).join(',') + ']';
  if (plain(value)) { const fields = recordedObject(value, 'Canonical object'); return '{' + Object.keys(fields).sort().map(key => JSON.stringify(key) + ':' + canonical(fields[key].value)).join(',') + '}'; }
  return JSON.stringify(value);
}
function exact(value, fields, name) {
  const descriptors = recordedObject(value, name);
  if (Object.keys(descriptors).some(key => !fields.includes(key))) throw fail(`Invalid ${name}`);
}
function id(value, name, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !OPAQUE_ID.test(value)) throw fail(`${name} must be a bounded opaque identifier`);
  return value;
}
function digest(value, name) {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw fail(`${name} must be a SHA-256 digest`);
  return value;
}
function workspaceId(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw fail('Workspace identity is required', 'WORKSPACE_REQUIRED');
  return value;
}
function scope(value, workspace) {
  if (!plain(value)) return;
  const fields = recordedObject(value, 'Scoped record');
  for (const key of ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id']) if (own(fields, key) && fields[key].value !== workspace) throw fail('Workspace identity mismatch', 'WORKSPACE_MISMATCH', 403);
  for (const key of ['workspace', 'tenant']) if (own(fields, key)) {
    const raw = fields[key].value;
    const actual = plain(raw) ? recordedObject(raw, 'Nested scope').id?.value : raw;
    if (actual !== workspace) throw fail('Workspace identity mismatch', 'WORKSPACE_MISMATCH', 403);
  }
}
function timestamp(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw fail(`${name} must be an ISO UTC timestamp`);
  const parsed = Date.parse(value), normalized = value.includes('.') ? value : value.slice(0, -1) + '.000Z';
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) throw fail(`${name} is not a valid date`);
  return normalized;
}
function nowValue(value = new Date()) {
  return value instanceof Date ? timestamp(Number.isFinite(value.getTime()) ? value.toISOString() : null, 'now') : timestamp(value, 'now');
}
function revision(value, name = 'revision') {
  if (!Number.isSafeInteger(value) || value < 1) throw fail(`${name} must be a positive safe integer`);
  return value;
}
function enumValue(value, values, name) {
  if (!values.includes(value)) throw fail(`Invalid ${name}`);
  return value;
}
function currency(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value) || !BUSINESS_OUTCOME_CURRENCIES.includes(value)) throw fail('An explicit supported uppercase currency is required');
  return value;
}

/** No Number conversion, exponent notation, rounding or implicit zero. */
export function normalizeOutcomeDecimal(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/.test(value)) throw fail('Amount must be an exact decimal string with at most 18 integer and 6 fractional digits');
  const negative = value.startsWith('-'), unsigned = negative ? value.slice(1) : value;
  const [whole, rawFraction = ''] = unsigned.split('.'), fraction = rawFraction.replace(/0+$/, '');
  const normalized = whole + (fraction ? '.' + fraction : '');
  return (negative && normalized !== '0' ? '-' : '') + normalized;
}
function units(value) {
  const negative = value.startsWith('-'), [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const amount = BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
  return negative ? -amount : amount;
}
function decimal(value) {
  const negative = value < 0n, amount = negative ? -value : value;
  const whole = amount / SCALE, fraction = String(amount % SCALE).padStart(6, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + String(whole) + (fraction ? '.' + fraction : '');
}
function count(value, name) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > 1000000000) throw fail(`${name} must be a non-negative bounded integer or null`);
  return value;
}
function normalizeSource(input, workspace) {
  scope(input, workspace);
  exact(input, ['type', 'experimentId', 'measurementRevision', 'measurementDigest'], 'source');
  return { type: enumValue(input.type, ['experiment_measurement'], 'source type'), experimentId: id(input.experimentId, 'Experiment ID'),
    measurementRevision: revision(input.measurementRevision, 'Measurement revision'), measurementDigest: digest(input.measurementDigest, 'Measurement digest') };
}
function normalizeLinks(input = {}, workspace) {
  scope(input, workspace); exact(input, ['action', 'opportunity', 'approval', 'objective'], 'links');
  return Object.fromEntries(['action', 'opportunity', 'approval', 'objective'].map(kind => {
    const row = input[kind] ?? null;
    if (row === null) return [kind, null];
    scope(row, workspace); exact(row, ['workspaceId', 'id', 'revision', 'digest'], `${kind} link`);
    if (row.workspaceId !== workspace) throw fail('Link workspace must be explicit', 'WORKSPACE_MISMATCH', 403);
    return [kind, { workspaceId: workspace, id: id(row.id, `${kind} ID`), revision: revision(row.revision), digest: digest(row.digest, `${kind} digest`) }];
  }));
}
function normalizeRecord(input, workspace, now) {
  scope(input, workspace);
  exact(input, ['workspaceId', 'source', 'metric', 'amount', 'currency', 'window', 'coverage', 'method', 'provenance', 'verification', 'links'], 'outcome input');
  const source = normalizeSource(input.source, workspace);
  const metric = enumValue(input.metric, [BUSINESS_OUTCOME_METRIC], 'metric');
  const amount = normalizeOutcomeDecimal(input.amount), measuredCurrency = currency(input.currency ?? null);
  const window = input.window ?? null;
  if (window !== null) {
    scope(window, workspace); exact(window, ['startsAt', 'endsAt'], 'observation window');
  }
  const interval = window === null ? null : { startsAt: timestamp(window.startsAt, 'Window start'), endsAt: timestamp(window.endsAt, 'Window end') };
  if (interval && (interval.startsAt >= interval.endsAt || Date.parse(interval.endsAt) - Date.parse(interval.startsAt) > BUSINESS_OUTCOME_LIMITS.windowDays * DAY)) throw fail('Observation window must be ordered and no longer than 366 days');
  const coverage = input.coverage ?? { status: 'unknown', scopeId: null, observedCount: null, expectedCount: null };
  scope(coverage, workspace); exact(coverage, ['status', 'scopeId', 'observedCount', 'expectedCount'], 'coverage');
  const normalizedCoverage = { status: enumValue(coverage.status, ['complete', 'partial', 'unknown'], 'coverage status'),
    scopeId: id(coverage.scopeId ?? null, 'Coverage scope ID', true), observedCount: count(coverage.observedCount ?? null, 'Observed count'), expectedCount: count(coverage.expectedCount ?? null, 'Expected count') };
  if (normalizedCoverage.observedCount !== null && normalizedCoverage.expectedCount !== null && normalizedCoverage.observedCount > normalizedCoverage.expectedCount) throw fail('Observed coverage exceeds the declared population');
  if (normalizedCoverage.status === 'complete' && (normalizedCoverage.scopeId === null || normalizedCoverage.observedCount === null || normalizedCoverage.expectedCount === null || normalizedCoverage.observedCount !== normalizedCoverage.expectedCount)) throw fail('Complete coverage requires an explicit scope and matching recorded population counts');
  if (normalizedCoverage.status === 'complete' && normalizedCoverage.observedCount === 0 && amount !== null && amount !== '0') throw fail('A zero-population measurement cannot assert nonzero incremental contribution');
  if (normalizedCoverage.status === 'partial' && normalizedCoverage.observedCount !== null && normalizedCoverage.expectedCount !== null && normalizedCoverage.observedCount >= normalizedCoverage.expectedCount) throw fail('Partial coverage cannot assert a complete population');
  const method = input.method ?? { kind: 'unknown', definitionVersion: DEFINITION };
  scope(method, workspace); exact(method, ['kind', 'definitionVersion'], 'method');
  const normalizedMethod = { kind: enumValue(method.kind, METHODS, 'measurement method'), definitionVersion: enumValue(method.definitionVersion, [DEFINITION], 'metric definition') };
  const provenance = input.provenance ?? { observationId: null, sourceRefs: [], observedAt: null, aggregation: 'standalone' };
  scope(provenance, workspace); exact(provenance, ['observationId', 'sourceRefs', 'observedAt', 'aggregation'], 'provenance');
  const refs = recordedArray(provenance.sourceRefs, 'Source references', BUSINESS_OUTCOME_LIMITS.sourceReferences).map(row => {
    scope(row, workspace); exact(row, ['type', 'id', 'digest'], 'source reference');
    return { type: enumValue(row.type, ['ledger_snapshot', 'measurement_report', 'experiment_log'], 'source reference type'), id: id(row.id, 'Source reference ID'), digest: digest(row.digest, 'Source reference digest') };
  });
  const referenceKeys = refs.map(row => canonical([row.type, row.id]));
  if (new Set(referenceKeys).size !== referenceKeys.length) throw fail('Source references must be unique');
  refs.sort((a, b) => lexical(canonical(a), canonical(b)));
  const normalizedProvenance = { observationId: id(provenance.observationId ?? null, 'Observation ID', true), sourceRefs: refs,
    observedAt: provenance.observedAt == null ? null : timestamp(provenance.observedAt, 'Observation timestamp'),
    aggregation: enumValue(provenance.aggregation ?? 'standalone', ['standalone', 'non_overlapping_scopes_attested'], 'aggregation basis') };
  scope(input.verification, workspace); exact(input.verification, ['kind', 'actorId', 'verifiedAt', 'measurementDigest'], 'verification');
  const verification = { kind: enumValue(input.verification.kind, ['owner_attestation'], 'verification kind'), actorId: id(input.verification.actorId, 'Verifier ID'),
    verifiedAt: timestamp(input.verification.verifiedAt, 'Verification time'), measurementDigest: digest(input.verification.measurementDigest, 'Verified measurement digest') };
  if (verification.measurementDigest !== source.measurementDigest) throw fail('Verification must bind the exact measurement digest');
  if (verification.verifiedAt > now || (interval && interval.endsAt > verification.verifiedAt) ||
      (normalizedProvenance.observedAt && (normalizedProvenance.observedAt > verification.verifiedAt || (interval && normalizedProvenance.observedAt < interval.endsAt)))) throw fail('Measurement and verification timestamps contradict the recorded observation window');
  return { source, metric, amount, currency: measuredCurrency, window: interval, coverage: normalizedCoverage, method: normalizedMethod,
    provenance: normalizedProvenance, verification, links: normalizeLinks(input.links, workspace) };
}
function build(record, workspace, nextRevision, lineage, status = 'recorded') {
  const outcomeId = `outcome_${hash([workspace, 'experiment_measurement', record.source.experimentId, record.metric])}`;
  const body = { schema: BUSINESS_OUTCOME_SCHEMA, workspaceId: workspace, outcomeId, revision: nextRevision, status, ...record,
    lineage, publicationAuthority: false, sourceReferencesResolved: false, runvaraAttribution: 'unestablished' };
  const payloadDigest = hash(body);
  return { ...body, digest: payloadDigest, versionId: `outcome_version_${hash([outcomeId, nextRevision, payloadDigest])}` };
}
const CANDIDATE_FIELDS = ['schema', 'workspaceId', 'outcomeId', 'versionId', 'digest', 'revision', 'status', 'source', 'metric', 'amount', 'currency', 'window', 'coverage', 'method', 'provenance', 'verification', 'links', 'lineage', 'publicationAuthority', 'sourceReferencesResolved', 'runvaraAttribution'];
function validate(candidate, workspace, now) {
  scope(candidate, workspace); exact(candidate, CANDIDATE_FIELDS, 'outcome candidate');
  if (candidate.schema !== BUSINESS_OUTCOME_SCHEMA || candidate.publicationAuthority !== false || candidate.sourceReferencesResolved !== false || candidate.runvaraAttribution !== 'unestablished') throw fail('A draft candidate cannot claim publication, resolved evidence or Runvara attribution');
  const status = enumValue(candidate.status, ['recorded', 'withdrawn'], 'candidate status');
  const nextRevision = revision(candidate.revision);
  exact(candidate.lineage, ['previousVersionId', 'previousDigest', 'previousRevision', 'reason'], 'lineage');
  const lineage = candidate.lineage;
  if (nextRevision === 1) {
    if (status !== 'recorded' || lineage.previousVersionId !== null || lineage.previousDigest !== null || lineage.previousRevision !== null || lineage.reason !== 'initial') throw fail('First outcome version cannot claim a predecessor');
  } else if (!VERSION_ID.test(lineage.previousVersionId) || !DIGEST.test(lineage.previousDigest) || lineage.previousRevision !== nextRevision - 1 || !['correction', ...WITHDRAWAL_REASONS].includes(lineage.reason) ||
    (status === 'recorded' && lineage.reason !== 'correction') || (status === 'withdrawn' && !WITHDRAWAL_REASONS.includes(lineage.reason))) throw fail('Successor lineage is invalid');
  const input = Object.fromEntries(['source', 'metric', 'amount', 'currency', 'window', 'coverage', 'method', 'provenance', 'verification', 'links'].map(key => [key, candidate[key]]));
  const normalized = normalizeRecord(input, workspace, now);
  const expected = build(normalized, workspace, nextRevision, { ...lineage }, status);
  if (nextRevision > 1 && lineage.previousVersionId !== `outcome_version_${hash([expected.outcomeId, lineage.previousRevision, lineage.previousDigest])}`) throw fail('Predecessor version identity does not match its logical outcome, revision and digest', 'OUTCOME_INTEGRITY_FAILED');
  if (canonical(candidate) !== canonical(expected)) throw fail('Outcome content does not match its immutable version digest', 'OUTCOME_INTEGRITY_FAILED');
  return expected;
}
function optionsFor(options) {
  exact(options, ['workspaceId', 'now'], 'outcome options');
  return { workspace: workspaceId(options.workspaceId), now: nowValue(options.now) };
}

export function createBusinessOutcomeCandidate(input, options) {
  const { workspace, now } = optionsFor(options);
  return build(normalizeRecord(input, workspace, now), workspace, 1,
    { previousVersionId: null, previousDigest: null, previousRevision: null, reason: 'initial' });
}
export function correctBusinessOutcomeCandidate(previous, replacement, options) {
  const { workspace, now } = optionsFor(options), before = validate(previous, workspace, now);
  if (before.status === 'withdrawn') throw fail('Withdrawn outcomes cannot be corrected without an explicit reinstatement policy', 'OUTCOME_WITHDRAWN', 409);
  if (before.revision >= Number.MAX_SAFE_INTEGER) throw fail('Outcome revision is exhausted');
  const next = normalizeRecord(replacement, workspace, now);
  if (next.source.experimentId !== before.source.experimentId || next.metric !== before.metric || next.source.measurementRevision <= before.source.measurementRevision || next.source.measurementDigest === before.source.measurementDigest || next.verification.verifiedAt < before.verification.verifiedAt) throw fail('A correction must preserve the logical source and advance its measurement revision');
  return build(next, workspace, before.revision + 1, { previousVersionId: before.versionId, previousDigest: before.digest, previousRevision: before.revision, reason: 'correction' });
}
export function withdrawBusinessOutcomeCandidate(previous, request, options) {
  const { workspace, now } = optionsFor(options), before = validate(previous, workspace, now);
  scope(request, workspace); exact(request, ['reason', 'verification'], 'withdrawal');
  if (before.status === 'withdrawn' || before.revision >= Number.MAX_SAFE_INTEGER) throw fail('Outcome cannot be withdrawn again');
  const reason = enumValue(request.reason, WITHDRAWAL_REASONS, 'withdrawal reason');
  const input = Object.fromEntries(['source', 'metric', 'amount', 'currency', 'window', 'coverage', 'method', 'provenance', 'links'].map(key => [key, before[key]]));
  const next = normalizeRecord({ ...input, verification: request.verification }, workspace, now);
  if (next.verification.verifiedAt < before.verification.verifiedAt) throw fail('Withdrawal precedes its prior verification');
  return build(next, workspace, before.revision + 1, { previousVersionId: before.versionId, previousDigest: before.digest, previousRevision: before.revision, reason }, 'withdrawn');
}
export function validateBusinessOutcomeCandidate(candidate, options) {
  const { workspace, now } = optionsFor(options);
  return validate(candidate, workspace, now);
}
export function assessBusinessOutcomeCandidate(candidate, options) {
  const record = validateBusinessOutcomeCandidate(candidate, options), blockers = [];
  if (record.status === 'withdrawn') blockers.push(issue('OUTCOME_WITHDRAWN', 'status'));
  if (record.amount === null) blockers.push(issue('AMOUNT_UNKNOWN', 'amount'));
  if (record.currency === null) blockers.push(issue('CURRENCY_UNKNOWN', 'currency'));
  if (record.window === null) blockers.push(issue('WINDOW_UNKNOWN', 'window'));
  if (record.coverage.status !== 'complete') blockers.push(issue('COVERAGE_INCOMPLETE', 'coverage'));
  if (record.method.kind === 'unknown') blockers.push(issue('METHOD_UNKNOWN', 'method'));
  if (record.provenance.observationId === null || !record.provenance.sourceRefs.length || record.provenance.observedAt === null) blockers.push(issue('PROVENANCE_INCOMPLETE', 'provenance'));
  return { schema: 'runvara-outcome-candidate-assessment/v1', outcomeId: record.outcomeId, versionId: record.versionId,
    measurementComplete: blockers.length === 0, blockers, publicationAuthority: false, ownerAuthorizationVerified: false,
    sourceReferencesResolved: false, executionAuthorized: false };
}

/** Server-adapter capability; a serialized/cloned lookalike cannot qualify. */
export function createOutcomePublicationBoundary(config) {
  exact(config, ['workspaceId', 'snapshotId', 'complete', 'expectedOutcomeCount', 'resolveCommittedPublication'], 'publication boundary');
  const workspace = workspaceId(config.workspaceId), snapshotId = id(config.snapshotId, 'Publication snapshot ID');
  if (typeof config.complete !== 'boolean' || !Number.isSafeInteger(config.expectedOutcomeCount) || config.expectedOutcomeCount < 0 || config.expectedOutcomeCount > BUSINESS_OUTCOME_LIMITS.versions || typeof config.resolveCommittedPublication !== 'function') throw fail('A trusted committed-head snapshot resolver and bounded coverage are required', 'PUBLICATION_PROOF_REQUIRED');
  const token = Object.freeze({ schema: 'runvara-outcome-publication-boundary/v1', workspaceId: workspace, snapshotId });
  boundaries.set(token, { workspace, snapshotId, complete: config.complete, expectedOutcomeCount: config.expectedOutcomeCount, resolve: config.resolveCommittedPublication });
  return token;
}
function committedHead(value, workspace, logicalId, now) {
  scope(value, workspace);
  exact(value, ['schema', 'workspaceId', 'outcomeId', 'revision', 'versionId', 'digest', 'status', 'publicationId', 'committedAt', 'commitRevision'], 'committed outcome head');
  if (value.schema !== HEAD_SCHEMA || value.workspaceId !== workspace || value.outcomeId !== logicalId || !OUTCOME_ID.test(value.outcomeId) || !VERSION_ID.test(value.versionId)) throw fail('Committed head identity is invalid', 'PUBLICATION_PROOF_INVALID');
  return { schema: HEAD_SCHEMA, workspaceId: workspace, outcomeId: logicalId, revision: revision(value.revision), versionId: value.versionId,
    digest: digest(value.digest, 'Published digest'), status: enumValue(value.status, ['published', 'withdrawn'], 'publication status'),
    publicationId: id(value.publicationId, 'Publication ID'), committedAt: timestamp(value.committedAt, 'Commit time'), commitRevision: id(value.commitRevision, 'Commit revision') };
}
function committedPublication(value, workspace, logicalId, now) {
  exact(value, ['head', 'version'], 'committed publication pair');
  const head = committedHead(value.head, workspace, logicalId, now);
  const version = validate(value.version, workspace, now);
  if (head.committedAt > now || version.outcomeId !== logicalId || version.versionId !== head.versionId || version.digest !== head.digest ||
      version.revision !== head.revision || version.verification.verifiedAt > head.committedAt ||
      (head.status === 'withdrawn' ? version.status !== 'withdrawn' : version.status !== 'recorded')) throw fail('Committed head and version do not match', 'PUBLICATION_PROOF_INVALID');
  return { head, version };
}
/** Validate the shape/content integrity of one publication DTO only.
 * This does NOT establish that it was read from the database, that its head is
 * current, or that an owner authorized it. It creates no aggregation capability.
 * A trusted adapter must establish those facts independently before supplying
 * validated pairs through createOutcomePublicationBoundary's resolver.
 */
export function validateBusinessOutcomePublication(value, options) {
  const { workspace, now } = optionsFor(options);
  exact(value, ['head', 'version'], 'publication pair');
  const headFields = recordedObject(value.head, 'publication head');
  const logicalId = headFields.outcomeId?.value;
  if (typeof logicalId !== 'string' || !OUTCOME_ID.test(logicalId)) throw fail('Publication outcome identity is invalid', 'PUBLICATION_PROOF_INVALID');
  return committedPublication(value, workspace, logicalId, now);
}

function comparableKey(row) {
  return canonical({ metric: row.metric, definition: row.method.definitionVersion, method: row.method.kind,
    currency: row.currency, startsAt: row.window.startsAt, endsAt: row.window.endsAt });
}

export function aggregateBusinessOutcomes(input, options) {
  exact(options, ['workspaceId', 'now', 'publicationBoundary'], 'aggregation options');
  const workspace = workspaceId(options.workspaceId), now = nowValue(options.now), boundary = boundaries.get(options.publicationBoundary);
  if (!boundary) throw fail('Aggregation requires a trusted committed-publication boundary', 'PUBLICATION_PROOF_REQUIRED', 403);
  if (boundary.workspace !== workspace) throw fail('Publication scope mismatch', 'WORKSPACE_MISMATCH', 403);
  const suppliedVersions = recordedArray(input, 'Outcome versions', BUSINESS_OUTCOME_LIMITS.versions);
  const records = new Map(), exclusions = [], seenLogical = new Set(), disputed = new Set();
  let invalid = 0;
  for (const raw of suppliedVersions) {
    try {
      const row = validate(raw, workspace, now);
      seenLogical.add(row.outcomeId);
      records.set(row.versionId, row);
    } catch (e) {
      if (e.code === 'WORKSPACE_MISMATCH') throw e;
      invalid++;
      const identity = plain(raw) ? Object.getOwnPropertyDescriptor(raw, 'outcomeId') : null;
      if (identity && own(identity, 'value') && typeof identity.value === 'string' && OUTCOME_ID.test(identity.value)) disputed.add(identity.value);
      exclusions.push({ outcomeId: null, code: 'INVALID_OUTCOME_VERSION' });
    }
  }
  let complete = boundary.complete && invalid === 0 && seenLogical.size === boundary.expectedOutcomeCount;
  const selected = [], resolved = new Set();
  let withdrawn = 0;
  for (const logicalId of [...seenLogical].sort()) {
    let head, publishedVersion;
    try {
      const raw = boundary.resolve(Object.freeze({ workspaceId: workspace, outcomeId: logicalId, snapshotId: boundary.snapshotId }));
      if (raw === null || raw === undefined) { exclusions.push({ outcomeId: logicalId, code: 'UNPUBLISHED_OUTCOME' }); continue; }
      const publication = committedPublication(raw, workspace, logicalId, now);
      head = publication.head; publishedVersion = publication.version;
      resolved.add(logicalId);
    } catch (e) {
      if (e.code === 'WORKSPACE_MISMATCH') throw e;
      complete = false; exclusions.push({ outcomeId: logicalId, code: 'PUBLICATION_UNAVAILABLE' }); continue;
    }
    if (disputed.has(logicalId)) { complete = false; exclusions.push({ outcomeId: logicalId, code: 'CONFLICTING_OUTCOME_VERSION' }); continue; }
    if (head.status === 'withdrawn') { withdrawn++; exclusions.push({ outcomeId: logicalId, code: 'OUTCOME_WITHDRAWN' }); continue; }
    const row = records.get(head.versionId);
    if (!row || row.outcomeId !== logicalId || row.digest !== head.digest || row.revision !== head.revision || row.status !== 'recorded' || row.verification.verifiedAt > head.committedAt) {
      complete = false; exclusions.push({ outcomeId: logicalId, code: 'CURRENT_VERSION_UNPROVED' }); continue;
    }
    const assessment = assessBusinessOutcomeCandidate(row, { workspaceId: workspace, now });
    if (!assessment.measurementComplete) { exclusions.push({ outcomeId: logicalId, code: 'UNQUALIFIED_MEASUREMENT', blockers: assessment.blockers }); continue; }
    selected.push(publishedVersion);
  }
  complete = complete && resolved.size === boundary.expectedOutcomeCount;
  const conflictIds = new Set();
  for (let i = 0; i < selected.length; i++) for (let j = i + 1; j < selected.length; j++) {
    const a = selected[i], b = selected[j];
    const sameObservation = a.provenance.observationId === b.provenance.observationId;
    const sameMeasurement = a.source.measurementDigest === b.source.measurementDigest;
    // A measurement report is already an observation-level claim. Renaming its
    // experiment, observation, population or report ID cannot count it again.
    // Shared ledger snapshots alone may support separately resolved disjoint
    // scopes, so they are not treated as duplicate reports.
    const reportDigests = new Set(a.provenance.sourceRefs.filter(ref => ref.type === 'measurement_report').map(ref => ref.digest));
    const reusedReport = b.provenance.sourceRefs.some(ref => ref.type === 'measurement_report' && reportDigests.has(ref.digest));
    const overlappingScope = a.coverage.scopeId === b.coverage.scopeId && a.window.startsAt < b.window.endsAt && b.window.startsAt < a.window.endsAt;
    if (sameObservation || sameMeasurement || reusedReport || overlappingScope) {
      const conflict = sameObservation ? 'DUPLICATE_OBSERVATION' : sameMeasurement ? 'DUPLICATE_MEASUREMENT' : reusedReport ? 'REUSED_MEASUREMENT_REPORT' : 'OVERLAPPING_SCOPE';
      for (const row of [a, b]) if (!conflictIds.has(row.outcomeId)) exclusions.push({ outcomeId: row.outcomeId, code: conflict });
      conflictIds.add(a.outcomeId); conflictIds.add(b.outcomeId);
    }
  }
  const qualified = selected.filter(row => !conflictIds.has(row.outcomeId)), grouped = new Map();
  for (const row of qualified) {
    const key = comparableKey(row);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const groups = [...grouped.entries()].sort(([a], [b]) => lexical(a, b)).map(([key, rows]) => {
    const additive = rows.length === 1 || rows.every(row => row.provenance.aggregation === 'non_overlapping_scopes_attested');
    const first = rows[0];
    return { id: `outcome_group_${hash([workspace, key])}`, metric: first.metric, definitionVersion: first.method.definitionVersion,
      method: first.method.kind, currency: first.currency, window: { ...first.window }, measuredCount: rows.length,
      knownZeroCount: rows.filter(row => row.amount === '0').length, negativeCount: rows.filter(row => units(row.amount) < 0n).length,
      positiveCount: rows.filter(row => units(row.amount) > 0n).length,
      amount: complete && additive ? decimal(rows.reduce((total, row) => total + units(row.amount), 0n)) : null,
      amountStatus: !complete ? 'incomplete_publication_read' : additive ? 'measured_sum' : 'standalone_observations',
      outcomeIds: rows.map(row => row.outcomeId).sort(), versionIds: rows.map(row => row.versionId).sort(),
      // Recorded action/approval associations do not establish comparison
      // evidence. This deny-only guard leaves amounts and grouping unchanged.
      learningComparable: complete && additive && rows.every(row => row.links.action === null && row.links.approval === null), forecastingAuthorized: false };
  });
  return { schema: 'runvara-business-outcome-summary/v1', workspaceId: workspace, publicationSnapshotId: boundary.snapshotId,
    generatedAt: now, groups, overallAmount: null, roi: null,
    counts: { suppliedVersions: suppliedVersions.length, distinctVersions: records.size, requestedOutcomes: seenLogical.size, resolvedHeads: resolved.size,
      qualifiedOutcomes: qualified.length, withdrawnOutcomes: withdrawn, excludedVersions: invalid, excludedOutcomes: new Set(exclusions.map(row => row.outcomeId).filter(Boolean)).size },
    coverage: { complete, expectedOutcomeCount: boundary.expectedOutcomeCount, basis: 'explicit_committed_head_selection', completeLifetimeHistoryClaimed: false },
    exclusions, safeguards: { candidateIsNotPublication: true, provisionalArchivesExcluded: true, currenciesNeverCombined: true,
      exactWindowsNeverCombined: true, validZeroPreserved: true, unknownsNeverBecomeZero: true, historicalResultsAreNotForecasts: true,
      runvaraAttributionEstablished: false, lifetimeMonthlyRoiCalculated: false, executionAuthorized: false, externalWrites: false } };
}
