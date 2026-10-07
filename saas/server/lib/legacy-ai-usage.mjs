// Read-only qualification of the historical ledger. This is never admission or
// proof of complete provider billing, including when the recorded ledger is empty.
export const LEGACY_AI_USAGE_MAX_ROWS = 1000;
export const LEGACY_AI_USAGE_MAX_BYTES = 524288;
export const LEGACY_AI_USAGE_COLUMNS = 'id,workspace_id,occurred_at,model,input_tokens,cached_input_tokens,cache_write_tokens,output_tokens,estimated_cost_usd';
const SCOPE = 'legacy_recorded_usage';
const INTEGER_FIELDS = ['requests', 'inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens'];
const ROW_TOKENS = ['input_tokens', 'cached_input_tokens', 'cache_write_tokens', 'output_tokens'];
const REASONS = new Set(['AI_USAGE_INPUT_INVALID', 'AI_USAGE_READ_UNAVAILABLE', 'AI_USAGE_RESPONSE_INVALID',
  'AI_USAGE_COUNT_UNVERIFIED', 'AI_USAGE_TRUNCATED', 'AI_USAGE_ROW_LIMIT', 'AI_USAGE_VOLATILE_STORE']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const safeInteger = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const safeModel = value => typeof value === 'string' && value.length > 0 && value.length <= 200
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const zero = () => ({ requests: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });

export function legacyAiUsageWindow(workspaceId, startAt, endAt) {
  if (typeof workspaceId !== 'string' || !ID.test(workspaceId)
    || typeof startAt !== 'string' || typeof endAt !== 'string'
    || !/^[1-9][0-9]{3}-(?:0[1-9]|1[0-2])-01T00:00:00\.000Z$/.test(startAt)) return false;
  const end = new Date(startAt);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return Number.isFinite(end.getTime()) && end.toISOString() === endAt;
}

export function legacyAiUsageUnknown(workspaceId, startAt, endAt, reason = 'AI_USAGE_READ_UNAVAILABLE', status = 'unavailable') {
  const valid = legacyAiUsageWindow(workspaceId, startAt, endAt);
  return { scope: SCOPE, workspaceId: valid ? workspaceId : null, startAt: valid ? startAt : null, endAt: valid ? endAt : null,
    status: valid && status === 'partial' ? 'partial' : 'unavailable',
    reason: valid && REASONS.has(reason) ? reason : 'AI_USAGE_INPUT_INVALID', totals: null, byModel: [] };
}

// The current column is NUMERIC(30,8), wider than a JSON number can preserve.
// Below 2^26 USD binary64 spacing stays below 1e-8, so distinct valid database
// decimals stay distinct. Reject larger rows/sums rather than imply precision.
// Sum in integer 1e-8 USD units, not floating addition; never coerce strings.
function costUnits(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || Object.is(value, -0)
    || value >= 2 ** 26) return null;
  const decimal = value.toFixed(8);
  if (Number(decimal) !== value) return null;
  const units = BigInt(decimal.replace('.', ''));
  return units <= BigInt(Number.MAX_SAFE_INTEGER) ? units : null;
}
function validTotals(value) {
  return record(value) && Object.keys(value).length === 6 && INTEGER_FIELDS.every(key => safeInteger(value[key]))
    && value.cachedInputTokens <= value.inputTokens - value.cacheWriteTokens && costUnits(value.estimatedCostUsd) !== null;
}
function addTotals(target, source) {
  for (const key of INTEGER_FIELDS) {
    if (!safeInteger(target[key] + source[key])) return false;
    target[key] += source[key];
  }
  const units = costUnits(target.estimatedCostUsd) + costUnits(source.estimatedCostUsd);
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) return false;
  target.estimatedCostUsd = Number(units) / 1e8;
  return costUnits(target.estimatedCostUsd) === units;
}
function rowTime(value) {
  // PostgREST timestamptz includes an offset and can contain microseconds.
  if (typeof value !== 'string' || !/^[1-9][0-9]{3}-\d{2}-\d{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.\d{1,6})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/.test(value)) return NaN;
  const parsed = Date.parse(value);
  const day = value.slice(0, 10);
  if (!Number.isFinite(parsed) || new Date(day).toISOString().slice(0, 10) !== day) return NaN;
  return parsed;
}

export function legacyAiUsagePage(page, workspaceId, startAt, endAt) {
  const unknown = (reason, status) => legacyAiUsageUnknown(workspaceId, startAt, endAt, reason, status);
  if (!legacyAiUsageWindow(workspaceId, startAt, endAt)) return unknown('AI_USAGE_INPUT_INVALID');
  const rows = page?.data;
  if (!Array.isArray(rows) || rows.length > LEGACY_AI_USAGE_MAX_ROWS + 1
    || Buffer.byteLength(JSON.stringify(rows)) > LEGACY_AI_USAGE_MAX_BYTES) return unknown('AI_USAGE_RESPONSE_INVALID');
  const totals = zero(), byModel = new Map(), ids = new Set();
  for (const row of rows) {
    if (!record(row) || Object.keys(row).length !== LEGACY_AI_USAGE_COLUMNS.split(',').length
      || typeof row.id !== 'string' || !ID.test(row.id) || ids.has(row.id) || row.workspace_id !== workspaceId
      || !safeModel(row.model) || !ROW_TOKENS.every(key => safeInteger(row[key]))
      || row.cached_input_tokens > row.input_tokens - row.cache_write_tokens || costUnits(row.estimated_cost_usd) === null
      || !(rowTime(row.occurred_at) >= Date.parse(startAt) && rowTime(row.occurred_at) < Date.parse(endAt))) return unknown('AI_USAGE_RESPONSE_INVALID');
    ids.add(row.id);
    const item = { requests: 1, inputTokens: row.input_tokens, cachedInputTokens: row.cached_input_tokens,
      cacheWriteTokens: row.cache_write_tokens, outputTokens: row.output_tokens, estimatedCostUsd: row.estimated_cost_usd };
    const model = byModel.get(row.model) || zero();
    if (!addTotals(totals, item) || !addTotals(model, item)) return unknown('AI_USAGE_RESPONSE_INVALID');
    byModel.set(row.model, model);
  }
  const range = page.contentRange;
  if (range === null || range === undefined) return unknown('AI_USAGE_COUNT_UNVERIFIED', 'partial');
  if (typeof range !== 'string' || range.length > 80) return unknown('AI_USAGE_RESPONSE_INVALID');
  const wildcard = /^0-(0|[1-9][0-9]*)\/\*$/.exec(range);
  if (range === '*/*' || wildcard) return rows.length === 0 ? range === '*/*' ? unknown('AI_USAGE_COUNT_UNVERIFIED', 'partial') : unknown('AI_USAGE_RESPONSE_INVALID')
    : wildcard && Number(wildcard[1]) === rows.length - 1 ? unknown('AI_USAGE_COUNT_UNVERIFIED', 'partial') : unknown('AI_USAGE_RESPONSE_INVALID');
  const match = typeof range === 'string' && /^0-(0|[1-9][0-9]*)\/(0|[1-9][0-9]*)$/.exec(range);
  const count = match ? Number(match[2]) : range === '*/0' ? 0 : null;
  if (!safeInteger(count) || (rows.length === 0 ? range !== '*/0'
    : !match || Number(match[1]) !== rows.length - 1 || count < rows.length)) return unknown('AI_USAGE_RESPONSE_INVALID');
  if (rows.length > LEGACY_AI_USAGE_MAX_ROWS) return unknown('AI_USAGE_ROW_LIMIT', 'partial');
  if (count > rows.length) return unknown('AI_USAGE_TRUNCATED', 'partial');
  return { scope: SCOPE, workspaceId, startAt, endAt, status: 'complete', reason: null, totals,
    byModel: [...byModel].map(([model, values]) => ({ model, ...values })).sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd || a.model.localeCompare(b.model)) };
}

// Defensive API projection: a thrown/missing/malformed store result cannot turn
// into an apparent zero or leak fields added to a persistence DTO in future.
export function publicLegacyAiUsage(value, workspaceId, startAt, endAt) {
  const invalid = () => legacyAiUsageUnknown(workspaceId, startAt, endAt, 'AI_USAGE_RESPONSE_INVALID');
  try {
    if (!record(value) || value.scope !== SCOPE || value.workspaceId !== workspaceId || value.startAt !== startAt || value.endAt !== endAt
      || !legacyAiUsageWindow(workspaceId, startAt, endAt) || !Array.isArray(value.byModel)
      || value.byModel.length > LEGACY_AI_USAGE_MAX_ROWS || Buffer.byteLength(JSON.stringify(value)) > LEGACY_AI_USAGE_MAX_BYTES) return invalid();
    if (['partial', 'unavailable'].includes(value.status) && REASONS.has(value.reason) && value.totals === null && value.byModel.length === 0) {
      return legacyAiUsageUnknown(workspaceId, startAt, endAt, value.reason, value.status);
    }
    if (value.status !== 'complete' || value.reason !== null || !validTotals(value.totals)
      || value.totals.requests > LEGACY_AI_USAGE_MAX_ROWS) return invalid();
    const sum = zero(), models = new Set(), byModel = [];
    for (const item of value.byModel) {
      if (!record(item) || !safeModel(item.model) || models.has(item.model)) return invalid();
      const { model, ...values } = item;
      if (!validTotals(values) || values.requests === 0 || !addTotals(sum, values)) return invalid();
      models.add(model); byModel.push({ model, ...values });
    }
    if (Object.keys(sum).some(key => sum[key] !== value.totals[key])) return invalid();
    return { scope: SCOPE, workspaceId, startAt, endAt, status: 'complete', reason: null, totals: { ...sum }, byModel };
  } catch { return invalid(); }
}

export function fleetLegacyAiUsage(summaries) {
  const counts = { complete: 0, partial: 0, unavailable: 0 }, totals = zero(), workspaces = new Set();
  let startAt = null, endAt = null, validSum = true;
  for (const summary of summaries) {
    const value = publicLegacyAiUsage(summary, summary?.workspaceId, summary?.startAt, summary?.endAt);
    counts[value.status]++;
    if (value.workspaceId !== null) {
      if (startAt === null) { startAt = value.startAt; endAt = value.endAt; }
      if (workspaces.has(value.workspaceId) || value.startAt !== startAt || value.endAt !== endAt) validSum = false;
      workspaces.add(value.workspaceId);
    }
    if (value.status === 'complete' && validSum && !addTotals(totals, value.totals)) validSum = false;
  }
  const status = !validSum || summaries.length === 0 || counts.unavailable === summaries.length ? 'unavailable'
    : counts.complete === summaries.length ? 'complete' : 'partial';
  return { aiUsageMonthStatus: status, aiUsageMonthCompleteWorkspaces: counts.complete,
    aiUsageMonthPartialWorkspaces: counts.partial, aiUsageMonthUnavailableWorkspaces: counts.unavailable,
    aiUsageMonthScope: 'returned_workspaces',
    aiUsageMonthStartAt: status === 'complete' ? startAt : null, aiUsageMonthEndAt: status === 'complete' ? endAt : null,
    aiEstimatedCostUsdMonth: status === 'complete' ? totals.estimatedCostUsd : null,
    aiRequestsMonth: status === 'complete' ? totals.requests : null };
}
