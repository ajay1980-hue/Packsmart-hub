import { createHash } from 'node:crypto';

// Pure two-phase retention planning. The integration owns archive I/O and the
// final revision-guarded state commit. Nothing here writes, hydrates, or schedules.
export const AUTOMATION_ARCHIVE_BATCH_SIZE = 200;
export const AUTOMATION_ARCHIVE_BATCH_BYTES = 1024 * 1024;
export const AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES = 2 * 1024 * 1024;
export const AUTOMATION_ARCHIVE_READ_BODY_MAX_BYTES = 2 * 1024 * 1024;
export const AUTOMATION_ARCHIVE_READ_FRAMING_BYTES = 2;
export const AUTOMATION_RECENT_COMPLETED_LIMIT = 25;
const SCHEMA = 'runvara-automation-retention/v1';
const ARCHIVE_SCHEMA = 'runvara-automation-run-archive/v1';
const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'BLOCKED']);
const plans = new WeakMap();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.hasOwn(value, key);
const hash = value => createHash('sha256').update(value).digest('hex');
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 180 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const validWorkspace = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const error = (message, code = 'RETENTION_INVALID') => Object.assign(new Error(message), { code });

function canonical(value, ancestors = new Set(), depth = 0) {
  if (depth > 100) throw error('Record nesting is not safely archivable');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!Array.isArray(value) && !object(value)) throw error('Record is not JSON data');
  if (Object.getOwnPropertySymbols(value).length) throw error('Record contains non-JSON keys');
  if (ancestors.has(value)) throw error('Record is cyclic');
  ancestors.add(value);
  let output;
  if (Array.isArray(value)) {
    if (Object.keys(value).some(key => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw error('Array contains non-JSON fields');
    const parts = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !own(descriptor, 'value')) throw error('Record contains sparse or computed data');
      parts.push(canonical(descriptor.value, ancestors, depth + 1));
    }
    output = '[' + parts.join(',') + ']';
  } else {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    output = '{' + Object.keys(descriptors).sort().map(key => {
      if (!descriptors[key].enumerable || !own(descriptors[key], 'value')) throw error('Record contains hidden or computed data');
      return JSON.stringify(key) + ':' + canonical(descriptors[key].value, ancestors, depth + 1);
    }).join(',') + '}';
  }
  ancestors.delete(value);
  return output;
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const parsed = Date.parse(value), expected = value.includes('.') ? value : value.slice(0, -1) + '.000Z';
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === expected ? parsed : null;
}
function inWorkspace(record, workspaceId) {
  if (!object(record) || !validWorkspace(workspaceId)) return false;
  const values = ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id'].filter(key => own(record, key)).map(key => record[key]);
  for (const key of ['workspace', 'tenant']) if (own(record, key)) values.push(object(record[key]) ? record[key].id : record[key]);
  return values.every(value => value === workspaceId);
}
function archiveKey(workspaceId, runId, sha256) {
  return 'automation-v1:' + hash(JSON.stringify([workspaceId, runId, sha256]));
}
function reference(workspaceId, runId, sha256) {
  return { schema: ARCHIVE_SCHEMA, table: 'runvara_history', workspaceId, collection: 'automationRuns', runId, recordId: archiveKey(workspaceId, runId, sha256), sha256 };
}
function validReference(ref, workspaceId, runId) {
  return object(ref) && ref.schema === ARCHIVE_SCHEMA && ref.table === 'runvara_history' && ref.workspaceId === workspaceId &&
    ref.collection === 'automationRuns' && ref.runId === runId && typeof ref.sha256 === 'string' && /^[0-9a-f]{64}$/.test(ref.sha256) &&
    ref.recordId === archiveKey(workspaceId, runId, ref.sha256);
}

function postgresNumberBytes(value) {
  const encoded = JSON.stringify(value);
  const [mantissa, exponent] = encoded.split('e');
  if (exponent === undefined) return encoded.length;
  const negative = mantissa.startsWith('-');
  const unsigned = negative ? mantissa.slice(1) : mantissa;
  const digits = unsigned.replace('.', '');
  const point = (unsigned.includes('.') ? unsigned.indexOf('.') : unsigned.length) + Number(exponent);
  // PostgreSQL JSONB stores a numeric, emitting decimal expansion rather than
  // JS's compact exponent: 1e308 is 309 bytes; 5e-324 is 326 bytes.
  const expanded = point <= 0 ? 2 - point + digits.length : point >= digits.length ? point : digits.length + 1;
  return expanded + (negative ? 1 : 0);
}

function postgresJsonBytes(value, depth = 0) {
  if (depth > 105) throw error('Archive response nesting is not safely bounded');
  if (value === null) return 4;
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (typeof value === 'string') return Buffer.byteLength(JSON.stringify(value));
  if (typeof value === 'number' && Number.isFinite(value)) return postgresNumberBytes(value);
  if (Array.isArray(value)) {
    let size = 2 + Math.max(0, value.length - 1) * 2; // brackets and comma-space
    for (const item of value) size += postgresJsonBytes(item, depth + 1);
    return size;
  }
  if (!object(value)) throw error('Archive response is not JSON data');
  const keys = Object.keys(value);
  let size = 2 + Math.max(0, keys.length - 1) * 2;
  for (const key of keys) size += Buffer.byteLength(JSON.stringify(key)) + 2 + postgresJsonBytes(value[key], depth + 1); // colon-space
  return size;
}

/** Conservative size of the exact single-row PostgREST archive GET projection:
 * select=workspace_id,collection,record_id,payload&limit=1. JSONB uses spaces
 * after every comma/colon and decimal-expanded numeric exponents. Counting
 * those spaces in outer row/envelope JSON too overbounds row_to_json/json_agg;
 * reserve another two bytes for an optional terminating CRLF. No pretty output,
 * extra columns, or extra rows may be added by the reader without re-admission.
 * Input must be detached JSON data (the planner's canonical payload provides it).
 */
export function estimateAutomationArchiveReadBodyBytes(row) {
  if (!object(row) || !['workspace_id', 'collection', 'record_id'].every(key => typeof row[key] === 'string') || !own(row, 'payload')) throw error('Archive read projection is invalid');
  return postgresJsonBytes([{ workspace_id: row.workspace_id, collection: row.collection, record_id: row.record_id, payload: row.payload }]) + AUTOMATION_ARCHIVE_READ_FRAMING_BYTES;
}

/** Exact Node response envelope used by the authenticated archive endpoint. */
export function estimateAutomationArchiveResponseBodyBytes(row) {
  if (!object(row) || typeof row.workspace_id !== 'string' || !object(row.payload) || !validId(row.payload.id)) throw error('Archive response projection is invalid');
  return Buffer.byteLength(JSON.stringify({ workspaceId: row.workspace_id, runId: row.payload.id, run: row.payload, source: 'immutable_automation_archive' }));
}

/** Stable across JSONB/object-key reordering; arrays keep their recorded order. */
export function automationArchivePayloadDigest(payload) {
  return hash(canonical(payload));
}

/** Verify an explicitly retrieved full version. This does not fetch or hydrate. */
export function verifyAutomationArchivePayload(ref, payload, workspaceId, expectedRunId = ref?.runId) {
  if (!object(payload) || !validId(payload.id) || payload.id !== expectedRunId || !inWorkspace(payload, workspaceId) || !validReference(ref, workspaceId, payload.id)) return false;
  try { return automationArchivePayloadDigest(payload) === ref.sha256; } catch { return false; }
}

/** A persisted stub is evidence of an earlier successful archive + state commit.
 * This shape is server-internal and must never be accepted from client input. */
export function isAutomationArchiveStub(run, workspaceId) {
  return object(run) && validId(run.id) && validId(run.ruleId) && run.status === 'COMPLETED' &&
    inWorkspace(run, workspaceId) && timestamp(run.startedAt) !== null && timestamp(run.completedAt) !== null &&
    Array.isArray(run.evidence) && run.evidence.length === 0 && Number.isSafeInteger(run.evidenceCount) && run.evidenceCount >= 0 &&
    validReference(run.archive, workspaceId, run.id);
}

/** Counting metadata is not a replacement evidence object or verification claim. */
export function automationEvidenceCount(run, workspaceId) {
  if (isAutomationArchiveStub(run, workspaceId)) return run.evidenceCount;
  return Array.isArray(run?.evidence) ? run.evidence.length : 0;
}

function settled(run, workspaceId, now) {
  if (!object(run) || !validId(run.id) || !validId(run.ruleId) || !inWorkspace(run, workspaceId) || !TERMINAL_STATUSES.has(run.status)) return false;
  const start = timestamp(run.startedAt), end = timestamp(run.completedAt);
  if (start === null || end === null || end < start || end > now || !Array.isArray(run.evidence)) return false;
  if (own(run, 'leaseUntil') && run.leaseUntil !== null && timestamp(run.leaseUntil) === null) return false;
  if (own(run, 'risk') && !['low', 'medium', 'high', 'critical'].includes(run.risk)) return false;
  if (own(run, 'spend') && (typeof run.spend !== 'number' || !Number.isFinite(run.spend) || run.spend < 0)) return false;
  if (own(run, 'errorCode') && run.errorCode !== null &&
      (run.status === 'COMPLETED' || typeof run.errorCode !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(run.errorCode))) return false;
  return true;
}
function stubFor(run, ref) {
  const stub = {};
  for (const key of ['id', 'ruleId', 'status', 'startedAt', 'completedAt', 'leaseUntil', 'risk', 'spend', 'errorCode']) if (own(run, key)) stub[key] = run[key];
  return { ...stub, evidence: [], evidenceCount: run.evidence.length, archive: { ...ref } };
}

/** Return immutable archive candidates and a process-local plan token. Original
 * array order is authoritative; active/latest/current-quota error/malformed
 * objects are kept by identity. Old well-formed errors may archive-only once
 * outside both quota days; errors never become stubs. No cap drops active work. */
export function planAutomationRetention(state, { now = new Date(), recentCompletedLimit = AUTOMATION_RECENT_COMPLETED_LIMIT } = {}) {
  const workspaceId = state?.workspace?.id;
  if (!object(state) || !validWorkspace(workspaceId) || !inWorkspace(state, workspaceId) || !inWorkspace(state.workspace, workspaceId)) throw error('Workspace scope is invalid', 'WORKSPACE_MISMATCH');
  const at = now instanceof Date ? now.getTime() : timestamp(now);
  if (!Number.isFinite(at)) throw error('Retention time must be a valid date');
  if (!Number.isSafeInteger(recentCompletedLimit) || recentCompletedLimit < 0 || recentCompletedLimit > 100) throw error('Recent completed limit must be an integer from 0 to 100');
  if (state.automationRuns !== undefined && !Array.isArray(state.automationRuns)) throw error('Automation history must be an array');
  const sourceCollection = state.automationRuns, runs = sourceCollection || [], utcDay = new Date(at).toISOString().slice(0, 10);
  const timeZone = state.autopilot?.timeZone ?? 'Europe/London';
  let formatter, localDay;
  const day = time => Object.fromEntries(formatter.formatToParts(new Date(time)).map(part => [part.type, part.value]));
  const dayKey = time => { const parts = day(time); return `${parts.year}-${parts.month}-${parts.day}`; };
  try { formatter = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); localDay = dayKey(at); }
  catch { throw error('Configured daily-brief timezone is invalid', 'RETENTION_INVALID_TIME_ZONE'); }
  const entries = [], candidates = [], pending = [], skipped = [], latest = new Set(), counts = new Map();
  let recent = 0;
  for (const run of runs) if (object(run) && validId(run.id)) counts.set(run.id, (counts.get(run.id) || 0) + 1);
  for (const run of runs) {
    const rule = object(run) && validId(run.ruleId) ? run.ruleId : null;
    const firstForRule = rule !== null && !latest.has(rule);
    if (rule !== null) latest.add(rule);
    const recentCompleted = run?.status === 'COMPLETED' && recent++ < recentCompletedLimit;
    const entry = { run, action: 'keep', schedulingFields: object(run) ? ['id', 'ruleId', 'status', 'startedAt', 'completedAt'].map(key => run[key]) : null };
    entries.push(entry);
    if (firstForRule || recentCompleted || !settled(run, workspaceId, at) || counts.get(run.id) !== 1) continue;
    const quotaMember = run.startedAt.slice(0, 10) === utcDay || (run.ruleId === 'dailyOpsBrief' && dayKey(timestamp(run.startedAt)) === localDay);
    if (run.status !== 'COMPLETED' && quotaMember) continue;
    if (own(run, 'archive') || own(run, 'evidenceCount')) {
      if (isAutomationArchiveStub(run, workspaceId)) {
        entry.action = quotaMember ? 'keep' : 'evict-stub';
        entry.signature = canonical(run);
      }
      // Unknown archive markers are never archived again or silently discarded.
      continue;
    }
    let encoded;
    try { encoded = canonical(run); } catch { continue; }
    const sha256 = hash(encoded), ref = reference(workspaceId, run.id, sha256);
    const payload = JSON.parse(encoded);
    const stub = quotaMember ? stubFor(run, ref) : null;
    const originalRunBytes = Buffer.byteLength(JSON.stringify(payload));
    const stubBytes = stub ? Buffer.byteLength(JSON.stringify(stub)) : null;
    // References can exceed small evidence payloads. Keeping an otherwise
    // eligible quota row full is a successful no-op, never an archive failure.
    // Exact row counts/order stay unchanged, so this strict per-row saving also
    // guarantees that stubbing alone cannot grow the serialized hot array.
    if (stub && stubBytes >= originalRunBytes) {
      skipped.push(freeze({ runId: run.id, reason: 'STUB_NOT_SMALLER', originalRunBytes, stubBytes }));
      continue;
    }
    const row = { workspace_id: workspaceId, collection: 'automationRuns', record_id: ref.recordId, payload, occurred_at: run.completedAt };
    // Exact PostgREST body contract: JSON.stringify(batch.map(item => item.row)).
    // Includes UTF-8 bytes, the row envelope, and both array brackets.
    const requestBodyBytes = Buffer.byteLength(JSON.stringify([row]));
    if (requestBodyBytes > AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES) {
      pending.push(freeze({ runId: run.id, reason: 'ARCHIVE_PAYLOAD_TOO_LARGE', requestBodyBytes, maximumBodyBytes: AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES }));
      continue;
    }
    const estimatedReadBodyBytes = estimateAutomationArchiveReadBodyBytes(row);
    if (estimatedReadBodyBytes > AUTOMATION_ARCHIVE_READ_BODY_MAX_BYTES) {
      pending.push(freeze({ runId: run.id, reason: 'ARCHIVE_READ_ENVELOPE_TOO_LARGE', requestBodyBytes, estimatedReadBodyBytes,
        maximumBodyBytes: AUTOMATION_ARCHIVE_READ_BODY_MAX_BYTES }));
      continue;
    }
    const responseBodyBytes = estimateAutomationArchiveResponseBodyBytes(row);
    const estimatedResponseBodyBytes = responseBodyBytes + AUTOMATION_ARCHIVE_READ_FRAMING_BYTES;
    if (estimatedResponseBodyBytes > AUTOMATION_ARCHIVE_READ_BODY_MAX_BYTES) {
      pending.push(freeze({ runId: run.id, reason: 'ARCHIVE_API_ENVELOPE_TOO_LARGE', requestBodyBytes, estimatedReadBodyBytes,
        responseBodyBytes, estimatedResponseBodyBytes, maximumBodyBytes: AUTOMATION_ARCHIVE_READ_BODY_MAX_BYTES }));
      continue;
    }
    const candidate = freeze({ reference: ref, row, requestBodyBytes, estimatedReadBodyBytes, responseBodyBytes, estimatedResponseBodyBytes,
      originalRunBytes, stubBytes, retainedBytesSaved: originalRunBytes - (stubBytes ?? 0),
      digestAlgorithm: 'sha256-canonical-json/v1', archiveWrite: 'insert-ignore-duplicates', targetAction: quotaMember ? 'retain-stub' : 'archive-only' });
    candidates.push(candidate);
    Object.assign(entry, { action: candidate.targetAction, signature: encoded, reference: ref, stub });
  }
  const archiveBatches = [], archiveBatchMetadata = [];
  let batch = [], batchBytes = 2;
  const flush = () => {
    if (!batch.length) return;
    archiveBatchMetadata.push(freeze({ index: archiveBatches.length, rowCount: batch.length, requestBodyBytes: batchBytes,
      isolatedLargeRow: batchBytes > AUTOMATION_ARCHIVE_BATCH_BYTES,
      maximumBodyBytes: batchBytes > AUTOMATION_ARCHIVE_BATCH_BYTES ? AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES : AUTOMATION_ARCHIVE_BATCH_BYTES }));
    archiveBatches.push(Object.freeze(batch)); batch = []; batchBytes = 2;
  };
  for (const candidate of candidates) {
    const rowBytes = candidate.requestBodyBytes - 2;
    if (candidate.requestBodyBytes > AUTOMATION_ARCHIVE_BATCH_BYTES) {
      flush(); batch = [candidate]; batchBytes = candidate.requestBodyBytes; flush(); continue;
    }
    if (batch.length >= AUTOMATION_ARCHIVE_BATCH_SIZE || batchBytes + rowBytes + (batch.length ? 1 : 0) > AUTOMATION_ARCHIVE_BATCH_BYTES) flush();
    batchBytes += rowBytes + (batch.length ? 1 : 0); batch.push(candidate);
  }
  flush();
  const plan = Object.freeze({ schema: SCHEMA, workspaceId, sourceRevision: state._revision ?? null, utcDay, localBriefDay: localDay, timeZone,
    recentCompletedLimit, archiveBatchSize: AUTOMATION_ARCHIVE_BATCH_SIZE, archiveBatchBytes: AUTOMATION_ARCHIVE_BATCH_BYTES,
    archiveSingleBodyMaxBytes: AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES, archiveReadBodyMaxBytes: AUTOMATION_ARCHIVE_READ_BODY_MAX_BYTES,
    archiveCandidates: Object.freeze(candidates), archiveBatches: Object.freeze(archiveBatches),
    archiveBatchMetadata: Object.freeze(archiveBatchMetadata), pending: Object.freeze(pending), skipped: Object.freeze(skipped),
    summary: Object.freeze({ sourceRuns: runs.length, archiveCandidates: candidates.length, retainedFull: entries.filter(item => item.action === 'keep' && !isAutomationArchiveStub(item.run, workspaceId)).length,
      existingStubsToEvict: entries.filter(item => item.action === 'evict-stub').length, oversizedFullRecords: pending.length,
      notBeneficialFullRecords: skipped.length }), safeguards: Object.freeze({ writesPerformed: 0, providerCalls: false, schedulesCreated: false }) });
  plans.set(plan, { state, sourceCollection, entries, revision: state._revision, workspaceId, timeZone });
  return plan;
}

/** Stage a replacement array after the integration confirms exact immutable
 * writes. An acknowledgement is { ...candidate.reference, confirmed:true }.
 * Missing/failed acknowledgements preserve full records. Commit this staged
 * array with sourceRevision CAS; never assign it to live state before success. */
export function applyAutomationRetention(plan, { acknowledgedArchives = [] } = {}) {
  const source = plans.get(plan);
  if (!source) throw error('Use a plan from this process', 'RETENTION_PLAN_INVALID');
  const { state, sourceCollection, entries, revision, workspaceId, timeZone } = source;
  if (state.workspace?.id !== workspaceId || !inWorkspace(state, workspaceId) || !inWorkspace(state.workspace, workspaceId) || state._revision !== revision || state.automationRuns !== sourceCollection ||
      (state.autopilot?.timeZone ?? 'Europe/London') !== timeZone || (sourceCollection && (sourceCollection.length !== entries.length || entries.some((entry, index) => sourceCollection[index] !== entry.run)))) {
    throw error('Source state changed; recompute retention', 'RETENTION_PLAN_STALE');
  }
  if (!Array.isArray(acknowledgedArchives)) throw error('Archive acknowledgements must be an array');
  const acknowledged = new Set();
  const candidatesByKey = new Map(plan.archiveCandidates.map(item => [item.reference.recordId, item]));
  for (const ack of acknowledgedArchives) {
    if (!object(ack) || ack.confirmed !== true) continue;
    const candidate = candidatesByKey.get(ack.recordId);
    if (candidate && Object.keys(candidate.reference).every(key => candidate.reference[key] === ack[key])) acknowledged.add(ack.recordId);
  }
  const automationRuns = [];
  let compacted = 0, evicted = 0;
  for (const entry of entries) {
    if (entry.schedulingFields && ['id', 'ruleId', 'status', 'startedAt', 'completedAt'].some((key, index) => entry.run[key] !== entry.schedulingFields[index])) {
      throw error('Scheduling evidence changed; recompute retention', 'RETENTION_PLAN_STALE');
    }
    if (entry.signature !== undefined) {
      let signature;
      try { signature = canonical(entry.run); } catch { throw error('Source record changed; recompute retention', 'RETENTION_PLAN_STALE'); }
      if (signature !== entry.signature) throw error('Source record changed; recompute retention', 'RETENTION_PLAN_STALE');
    }
    if (entry.action === 'evict-stub') { evicted++; continue; }
    if (entry.reference && acknowledged.has(entry.reference.recordId)) {
      if (entry.action === 'retain-stub') { automationRuns.push({ ...entry.stub, evidence: [], archive: { ...entry.stub.archive } }); compacted++; }
      else evicted++;
    } else automationRuns.push(entry.run);
  }
  return { automationRuns, sourceRevision: plan.sourceRevision, compacted, evicted,
    pendingArchives: plan.archiveCandidates.filter(item => !acknowledged.has(item.reference.recordId)).length + plan.pending.length,
    pendingReasons: plan.pending, skippedReasons: plan.skipped };
}
