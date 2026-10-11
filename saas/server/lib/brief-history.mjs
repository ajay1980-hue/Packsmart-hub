import crypto from 'node:crypto';

// The producer is opt-in. Readers support this exact contract independently of
// the producer switch; disabling production does not reinterpret existing refs.
export const BRIEF_HISTORY_CONTRACT = 'runvara-brief-history/v1';
export const BRIEF_HISTORY_HASH_FORMAT = 'sha256-canonical-json/v1';
export const BRIEF_HISTORY_MAX_BYTES = 65536;
export const BRIEF_HISTORY_READ_MAX_BYTES = 131072;
export const BRIEF_HISTORY_POST_MAX_BYTES = 131072;
export const BRIEF_HISTORY_MAX_COMPACTIONS = 2;
export const BRIEF_HISTORY_RETAINED_LIMIT = 30;
export const BRIEF_HISTORY_MAX_INPUT_ROWS = 4096;
export const BRIEF_HISTORY_LEGACY_READ_MAX_BYTES = 2097152;
const MAX_DEPTH = 32;
const REFERENCE_FIELDS = ['schema', 'table', 'workspaceId', 'briefId', 'archiveId', 'sha256', 'hashFormat'];
const plans = new WeakMap();
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const briefArchiveError = (code = 'BRIEF_ARCHIVE_INTEGRITY_FAILED') =>
  Object.assign(new Error('Historical brief could not be verified'), { status: 503, code });

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const parsed = Date.parse(value), expected = value.includes('.') ? value : value.slice(0, -1) + '.000Z';
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === expected ? parsed : null;
}

/** Strict JSON, with bounded traversal/emission and sorted object keys. Arrays
 * retain order. JSONB key ordering, whitespace and number spelling are not data.
 * Reject silent JSON.stringify losses (undefined, holes, getters, etc.). */
export function canonicalBriefJSON(value, { maxBytes = BRIEF_HISTORY_MAX_BYTES } = {}) {
  let bytes = 0, nodes = 0;
  const ancestors = new Set();
  const emit = text => {
    bytes += Buffer.byteLength(text);
    if (bytes > maxBytes) throw briefArchiveError();
    return text;
  };
  function visit(item, depth) {
    if (++nodes > maxBytes + 1 || depth > MAX_DEPTH) throw briefArchiveError();
    if (item === null) return emit('null');
    if (typeof item === 'string') {
      // PostgreSQL JSONB cannot store NUL or lone UTF-16 surrogates.
      if (item.length > maxBytes || item.includes('\u0000') || !item.isWellFormed()) throw briefArchiveError();
      return emit(JSON.stringify(item));
    }
    if (typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return emit(JSON.stringify(item));
    if (!Array.isArray(item) && !object(item) || ancestors.has(item)) throw briefArchiveError();
    if (Object.getOwnPropertySymbols(item).length) throw briefArchiveError();
    ancestors.add(item);
    let output;
    if (Array.isArray(item)) {
      if (item.length > maxBytes || Object.keys(item).length !== item.length
        || Object.getOwnPropertyNames(item).length !== item.length + 1) throw briefArchiveError();
      const parts = [];
      emit('[');
      for (let i = 0; i < item.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
        if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) throw briefArchiveError();
        if (i) emit(',');
        parts.push(visit(descriptor.value, depth + 1));
      }
      emit(']');
      output = '[' + parts.join(',') + ']';
    } else {
      const keys = Object.getOwnPropertyNames(item), parts = [];
      if (keys.length > maxBytes || keys.some(key => key.length > maxBytes)) throw briefArchiveError();
      keys.sort();
      emit('{');
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor.enumerable || !own(descriptor, 'value') || !key.isWellFormed() || key.includes('\u0000')) throw briefArchiveError();
        if (parts.length) emit(',');
        const prefix = emit(JSON.stringify(key) + ':');
        parts.push(prefix + visit(descriptor.value, depth + 1));
      }
      emit('}');
      output = '{' + parts.join(',') + '}';
    }
    ancestors.delete(item);
    return output;
  }
  return visit(value, 0);
}

function scoped(value, workspaceId, depth = 0) {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.every(item => scoped(item, workspaceId, depth + 1));
  if (!object(value)) return false;
  for (const key of ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id']) if (own(value, key) && value[key] !== workspaceId) return false;
  for (const key of ['workspace', 'tenant']) if (own(value, key) && (object(value[key]) ? value[key].id : value[key]) !== workspaceId) return false;
  return Object.values(value).every(item => scoped(item, workspaceId, depth + 1));
}

function archiveId(workspaceId, briefId, canonical) {
  return 'brief-v1:' + hash(JSON.stringify([workspaceId, briefId, canonical]));
}

export function assertBriefArchiveReference(reference, workspaceId, briefId) {
  if (!identity(workspaceId) || !identity(briefId) || !object(reference)
    || Reflect.ownKeys(reference).length !== REFERENCE_FIELDS.length
    || REFERENCE_FIELDS.some(key => !own(reference, key) || !Object.getOwnPropertyDescriptor(reference, key).enumerable
      || !own(Object.getOwnPropertyDescriptor(reference, key), 'value'))
    || reference.schema !== BRIEF_HISTORY_CONTRACT || reference.table !== 'operations_briefs'
    || reference.workspaceId !== workspaceId || reference.briefId !== briefId
    || reference.hashFormat !== BRIEF_HISTORY_HASH_FORMAT
    || typeof reference.archiveId !== 'string' || !/^brief-v1:[0-9a-f]{64}$/.test(reference.archiveId)
    || typeof reference.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(reference.sha256)) throw briefArchiveError('BRIEF_ARCHIVE_REFERENCE_INVALID');
  return reference;
}

export function isLegacyBriefArchiveReference(reference, briefId) {
  return identity(briefId) && object(reference) && Reflect.ownKeys(reference).length === 3
    && ['table', 'id', 'sha256'].every(key => own(reference, key) && own(Object.getOwnPropertyDescriptor(reference, key), 'value'))
    && reference.table === 'operations_briefs' && reference.id === briefId
    && typeof reference.sha256 === 'string' && /^[0-9a-f]{64}$/.test(reference.sha256);
}

// Conservative JSONB/PostgREST response size, including decimal exponent
// expansion and spaces after all commas/colons. Input is detached strict JSON.
function postgresBytes(value) {
  if (value === null) return 4;
  if (typeof value === 'string') return Buffer.byteLength(JSON.stringify(value));
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (typeof value === 'number') {
    const encoded = JSON.stringify(value), [mantissa, exponent] = encoded.split('e');
    if (exponent === undefined) return encoded.length;
    const negative = mantissa.startsWith('-'), unsigned = negative ? mantissa.slice(1) : mantissa;
    const digits = unsigned.replace('.', '');
    const point = (unsigned.includes('.') ? unsigned.indexOf('.') : unsigned.length) + Number(exponent);
    return (point <= 0 ? 2 - point + digits.length : point >= digits.length ? point : digits.length + 1) + Number(negative);
  }
  if (Array.isArray(value)) return 2 + Math.max(0, value.length - 1) * 2 + value.reduce((size, item) => size + postgresBytes(item), 0);
  const keys = Object.keys(value);
  return 2 + Math.max(0, keys.length - 1) * 2
    + keys.reduce((size, key) => size + Buffer.byteLength(JSON.stringify(key)) + 2 + postgresBytes(value[key]), 0);
}

export function estimateBriefArchiveReadBytes(row) {
  return postgresBytes([{ id: row.id, workspace_id: row.workspace_id, metrics: row.metrics }]) + 2;
}

export function verifyBriefArchiveRow(rows, reference, workspaceId, briefId) {
  assertBriefArchiveReference(reference, workspaceId, briefId);
  if (!Array.isArray(rows) || rows.length !== 1) throw briefArchiveError(rows?.length === 0 ? 'BRIEF_ARCHIVE_UNAVAILABLE' : undefined);
  const row = rows[0];
  if (!object(row) || Reflect.ownKeys(row).length !== 3 || !['id', 'workspace_id', 'metrics'].every(key => own(row, key))
    || row.id !== reference.archiveId || row.workspace_id !== workspaceId || !object(row.metrics)
    || !own(row.metrics, 'id') || row.metrics.id !== briefId || !own(row.metrics, 'generatedAt')
    || timestamp(row.metrics.generatedAt) === null || own(row.metrics, 'archive')) throw briefArchiveError();
  const canonical = canonicalBriefJSON(row.metrics);
  if (!scoped(row.metrics, workspaceId) || estimateBriefArchiveReadBytes(row) > BRIEF_HISTORY_READ_MAX_BYTES
    || hash(canonical) !== reference.sha256 || archiveId(workspaceId, briefId, canonical) !== reference.archiveId) throw briefArchiveError();
  return JSON.parse(canonical);
}

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** At most two historical retained rows, never today's rows or index zero.
 * Legacy >64KiB behavior remains the store's independent compatibility path. */
export function planBriefHistoryCompaction(state, { now = new Date() } = {}) {
  const workspaceId = state?.workspace?.id, briefs = state?.dailyBriefs;
  const time = now instanceof Date ? now.getTime() : timestamp(now);
  if (!identity(workspaceId) || !Array.isArray(briefs) || !Number.isFinite(time)) throw briefArchiveError('BRIEF_HISTORY_INPUT_INVALID');
  const candidates = [], originals = [];
  const finish = () => {
    const result = Object.freeze({ workspaceId, candidates: Object.freeze(candidates) });
    plans.set(result, { state, briefs, originals });
    return result;
  };
  // Duplicate-ID detection must see the whole input, but optional compaction
  // never adds an unbounded scan to a malformed/oversized retained collection.
  if (briefs.length > BRIEF_HISTORY_MAX_INPUT_ROWS) return finish();
  const today = new Date(time).toISOString().slice(0, 10), counts = new Map();
  for (const brief of briefs) if (object(brief) && identity(brief.id)) counts.set(brief.id, (counts.get(brief.id) || 0) + 1);
  for (let index = 1; index < Math.min(briefs.length, BRIEF_HISTORY_RETAINED_LIMIT) && candidates.length < BRIEF_HISTORY_MAX_COMPACTIONS; index++) {
    const original = briefs[index];
    if (!object(original) || !identity(original.id) || counts.get(original.id) !== 1 || own(original, 'archive')) continue;
    let canonical, brief;
    try { canonical = canonicalBriefJSON(original); brief = JSON.parse(canonical); } catch { continue; }
    const generated = timestamp(brief.generatedAt);
    if (!own(brief, 'id') || !identity(brief.id) || generated === null || generated > time || brief.generatedAt.slice(0, 10) === today || !scoped(brief, workspaceId)
      || own(brief, 'summary') && typeof brief.summary !== 'string') continue;
    const reference = { schema: BRIEF_HISTORY_CONTRACT, table: 'operations_briefs', workspaceId, briefId: brief.id,
      archiveId: archiveId(workspaceId, brief.id, canonical), sha256: hash(canonical), hashFormat: BRIEF_HISTORY_HASH_FORMAT };
    const row = { id: reference.archiveId, workspace_id: workspaceId, summary: brief.summary || '', metrics: brief,
      logic: typeof brief.logic === 'string' ? brief.logic : 'deterministic-v1', created_at: brief.generatedAt };
    const stub = { ...Object.fromEntries(Object.entries(brief).filter(([, value]) => value === null || typeof value !== 'object')), archive: reference };
    const originalBytes = Buffer.byteLength(canonical), stubBytes = Buffer.byteLength(JSON.stringify(stub));
    const readBytes = estimateBriefArchiveReadBytes(row), postBytes = Buffer.byteLength(JSON.stringify([row]));
    if (stubBytes >= originalBytes || readBytes > BRIEF_HISTORY_READ_MAX_BYTES || postBytes > BRIEF_HISTORY_POST_MAX_BYTES) continue;
    candidates.push(freeze({ index, row, reference, stub, originalBytes, stubBytes, readBytes, postBytes }));
    originals.push({ index, original, canonical });
  }
  return finish();
}

/** Every archive await can yield to a caller mutation. Abort rather than publish
 * a stub for an earlier value, including same-ID edits and array reordering. */
export function assertBriefHistoryPlanCurrent(plan) {
  const source = plans.get(plan);
  if (!source || source.state.workspace?.id !== plan.workspaceId || source.state.dailyBriefs !== source.briefs) throw briefArchiveError('BRIEF_HISTORY_SOURCE_CHANGED');
  for (const { index, original, canonical } of source.originals) {
    let current;
    try { current = canonicalBriefJSON(source.briefs[index]); } catch { throw briefArchiveError('BRIEF_HISTORY_SOURCE_CHANGED'); }
    if (source.briefs[index] !== original || current !== canonical) throw briefArchiveError('BRIEF_HISTORY_SOURCE_CHANGED');
  }
}

/** Metadata alone never establishes integrity. verified:true is only for the
 * authenticated detail route after getBrief has validated the full archive. */
export function briefHistoryIntegrity(brief, { workspaceId = brief?.archive?.workspaceId, verified = false } = {}) {
  if (!object(brief) || !identity(brief.id)) return 'archive_unavailable';
  if (!own(brief, 'archive')) return 'retained';
  if (isLegacyBriefArchiveReference(brief.archive, brief.id)) return 'legacy_archive_unverified';
  try { assertBriefArchiveReference(brief.archive, workspaceId, brief.id); return verified ? 'verified_archive' : 'archive_pending_read'; }
  catch { return 'archive_unavailable'; }
}

export function briefHistoryList(state) {
  return (Array.isArray(state?.dailyBriefs) ? state.dailyBriefs : []).slice(0, BRIEF_HISTORY_RETAINED_LIMIT)
    .filter(brief => object(brief) && identity(brief.id)).map(brief => ({
      id: brief.id, generatedAt: typeof brief.generatedAt === 'string' ? brief.generatedAt.slice(0, 40) : null,
      summary: typeof brief.summary === 'string' ? brief.summary.slice(0, 1024) : '', archived: own(brief, 'archive'),
      integrity: briefHistoryIntegrity(brief, { workspaceId: state.workspace?.id })
    }));
}

export function verifyLegacyBriefArchiveRow(rows, workspaceId, briefId) {
  if (Buffer.byteLength(JSON.stringify(rows)) > BRIEF_HISTORY_LEGACY_READ_MAX_BYTES) throw briefArchiveError('BRIEF_ARCHIVE_TOO_LARGE');
  const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  if (!row) throw briefArchiveError('BRIEF_ARCHIVE_UNAVAILABLE');
  if (row.id !== briefId || row.workspace_id !== workspaceId || !object(row.metrics) || row.metrics.id !== briefId || own(row.metrics, 'archive')) throw briefArchiveError();
  const canonical = canonicalBriefJSON(row.metrics, { maxBytes: BRIEF_HISTORY_LEGACY_READ_MAX_BYTES });
  if (!scoped(row.metrics, workspaceId)) throw briefArchiveError();
  // Legacy hashes used insertion-order JSON; JSONB does not preserve that order.
  // This checks scope/shape/bounds only, never asserts a verified legacy digest.
  return JSON.parse(canonical);
}
