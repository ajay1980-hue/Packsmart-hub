/**
 * Strict DTO boundary for the dormant, server-only atomic accounting API.
 * Callers must construct these inputs from trusted worker/adapter evidence,
 * never spread a browser request, provider response, or workspace state into one.
 * Prices and spend authority belong to the database, not these DTOs.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const ADAPTER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const PROVIDER = /^[a-z][a-z0-9-]{0,31}(?::[a-z0-9][a-z0-9-]{0,47})?$/;
const HASH = /^[0-9a-f]{64}$/;
const CODE = /^[A-Z0-9_]{1,80}$/;
const STATUSES = ['held', 'uncertain', 'settled', 'cancelled_pre_dispatch', 'overrun'];
const COUNTERS = ['requests', 'input_tokens', 'output_tokens', 'total_tokens', 'cost_micros'];
export const USAGE_SUMMARY_MAX_SCOPES = 129;
export const USAGE_SUMMARY_COLUMNS = ['workspace_id', 'scope_key', 'window_start', 'currency',
  ...['held', 'settled'].flatMap(prefix => COUNTERS.map(key => `${prefix}_${key}`))].join(',');

export function providerUsageError(code, status = 503) {
  // Never retain a provider/PostgREST error, body, key, or cause on this boundary.
  return Object.assign(new Error(code), { code, status, dispatchAllowed: false });
}
const fail = () => { throw providerUsageError('AI_USAGE_INPUT_INVALID', 400); };
function record(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.length) fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor || !('value' in descriptor)) fail();
  }
  return value;
}
function text(value, pattern = ID) {
  if (typeof value !== 'string' || !pattern.test(value)) fail();
  return value;
}
function integer(value, max = Number.MAX_SAFE_INTEGER, min = 0) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail();
  return value;
}
function exactAccountedCost(value) {
  // SQL NUMERIC(60,0) overrun costs can exceed JS's safe-integer range. Preserve
  // the canonical decimal string exactly; callers must not Number()/parseInt()
  // or arithmetic-coerce this number|string field. Summary counters stay strict.
  if (typeof value === 'string') {
    if (!/^(?:0|[1-9][0-9]{0,59})$/.test(value)) fail();
    return value;
  }
  return integer(value);
}
function boolean(value) { if (typeof value !== 'boolean') fail(); return value; }
function monthStart(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-(?:0[1-9]|1[0-2])-01$/.test(value)
    || value.startsWith('0000')) fail();
  return value;
}
function timestamp(value) {
  if (Number.isSafeInteger(value) && value >= 0 && value <= 253402300799999) return new Date(value).toISOString();
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/.test(value)
    || value.startsWith('0000')) fail();
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== canonical) fail();
  return canonical;
}
function scope(value) {
  if (value === 'tenant') return value;
  if (typeof value !== 'string' || !value.startsWith('provider:')) fail();
  text(value.slice('provider:'.length), PROVIDER);
  return value;
}
function status(value) { if (!STATUSES.includes(value)) fail(); return value; }

export function providerUsageMonth(workspaceId, admissionMonth) {
  text(workspaceId);
  if (typeof admissionMonth !== 'string' || !/^[0-9]{4}-(?:0[1-9]|1[0-2])$/.test(admissionMonth)) fail();
  return monthStart(`${admissionMonth}-01`);
}

export function providerUsageReservationParams(workspaceId, input) {
  text(workspaceId);
  record(input, ['jobId', 'workerId', 'jobAttempt', 'callKey', 'requestFingerprint', 'provider',
    'adapterId', 'model', 'inputTokenBound', 'outputTokenBound', 'pricingVersion', 'routeValidUntil']);
  const jobId = text(input.jobId);
  const workerId = text(input.workerId);
  if (workerId.length < 8 || input.callKey !== `${jobId}:operator-brief:v1`) fail();
  return {
    p_workspace_id: workspaceId,
    p_job_id: jobId,
    p_worker_id: workerId,
    p_job_attempt: integer(input.jobAttempt, 2147483647, 1),
    p_call_key: input.callKey,
    p_request_fingerprint: text(input.requestFingerprint, HASH),
    p_provider: text(input.provider, PROVIDER),
    p_adapter_id: text(input.adapterId, ADAPTER),
    p_model: text(input.model, MODEL),
    p_input_token_bound: integer(input.inputTokenBound, 1_000_000),
    p_output_token_bound: integer(input.outputTokenBound, 128_000),
    p_pricing_version: text(input.pricingVersion, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
    p_route_valid_until: timestamp(input.routeValidUntil)
  };
}

export function providerUsageSettlementParams(workspaceId, input) {
  text(workspaceId);
  record(input, ['reservationId', 'requestFingerprint', 'outcome', 'receipt', 'trustedPreDispatchProof']);
  if (!['complete', 'uncertain', 'cancelled_pre_dispatch'].includes(input.outcome)) fail();
  const receipt = input.receipt;
  let normalized;
  if (input.outcome === 'cancelled_pre_dispatch') {
    record(receipt, ['jobId']);
    // A separate, explicit server-side assertion is required. This is only valid
    // when the trusted adapter lifecycle proves fetch/dispatch never started.
    // A timeout, cancellation signal, missing receipt, or client flag is NOT proof.
    record(input.trustedPreDispatchProof, ['dispatchStarted', 'proof']);
    if (input.trustedPreDispatchProof.dispatchStarted !== false
      || input.trustedPreDispatchProof.proof !== 'local_pre_dispatch') fail();
    normalized = { jobId: text(receipt.jobId), dispatchStarted: false, proof: 'local_pre_dispatch' };
  } else {
    if (input.trustedPreDispatchProof !== undefined) fail();
    const keys = input.outcome === 'complete'
      ? ['jobId', 'providerRequestId', 'inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens', 'errorCode']
      : ['jobId', 'errorCode'];
    record(receipt, keys);
    normalized = { jobId: text(receipt.jobId) };
    if (input.outcome === 'complete') {
      normalized.providerRequestId = text(receipt.providerRequestId, /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,179}$/);
      for (const key of ['inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens']) {
        normalized[key] = integer(receipt[key]);
      }
      if (!Number.isSafeInteger(normalized.inputTokens + normalized.outputTokens)
        || normalized.inputTokens + normalized.outputTokens !== normalized.totalTokens
        || !Number.isSafeInteger(normalized.cachedInputTokens + normalized.cacheWriteTokens)
        || normalized.cachedInputTokens + normalized.cacheWriteTokens > normalized.inputTokens) fail();
    }
    if (receipt.errorCode !== undefined) normalized.errorCode = text(receipt.errorCode, CODE);
  }
  return {
    p_workspace_id: workspaceId,
    p_reservation_id: text(input.reservationId),
    p_request_fingerprint: text(input.requestFingerprint, HASH),
    p_outcome: input.outcome,
    p_receipt: normalized
  };
}

const RESERVATION_REASONS = new Set(['AI_LOGICAL_CALL_EXISTS', 'AI_JOB_LEASE_INVALID', 'AI_ROUTE_EXPIRED',
  'AI_GOVERNANCE_NOT_CONFIGURED', 'AI_ACCOUNTING_BASELINE_UNVERIFIED', 'AI_PROVIDER_NOT_ALLOWED',
  'AI_PROVIDER_OVERRUN_BLOCKED', 'AI_POLICY_LIMIT_INVALID', 'AI_PRICING_UNVERIFIED', 'AI_PRICING_EXPIRED',
  'AI_COST_BOUND_INVALID', 'AI_BUDGET_EXCEEDED', 'AI_ADMISSION_EVIDENCE_EXPIRED', 'AI_ADMISSION_WINDOW_CHANGED']);
export function providerUsageReservationResult(value, params) {
  try {
    record(value, ['dispatch_allowed', 'reservation_id', 'status', 'window_start', 'reserved_requests',
      'reserved_input_tokens', 'reserved_output_tokens', 'reserved_total_tokens', 'reserved_cost_micros',
      'currency', 'pricing_version', 'reason', 'scope']);
    const result = { dispatchAllowed: boolean(value.dispatch_allowed) };
    if (result.dispatchAllowed) {
      if (value.status !== 'held' || value.currency !== 'USD' || value.reason !== undefined || value.scope !== undefined
        || value.reserved_requests !== 1 || value.reserved_input_tokens !== params.p_input_token_bound
        || value.reserved_output_tokens !== params.p_output_token_bound
        || value.reserved_total_tokens !== params.p_input_token_bound + params.p_output_token_bound
        || value.pricing_version !== params.p_pricing_version) fail();
      return { ...result, reservationId: text(value.reservation_id), status: 'held',
        windowStart: monthStart(value.window_start), reservedRequests: 1,
        reservedInputTokens: value.reserved_input_tokens, reservedOutputTokens: value.reserved_output_tokens,
        reservedTotalTokens: value.reserved_total_tokens, reservedCostMicros: integer(value.reserved_cost_micros),
        currency: 'USD', pricingVersion: value.pricing_version };
    }
    if (!RESERVATION_REASONS.has(value.reason)) fail();
    result.reason = value.reason;
    if (value.reason === 'AI_LOGICAL_CALL_EXISTS') {
      result.reservationId = text(value.reservation_id);
      result.status = status(value.status);
      result.windowStart = monthStart(value.window_start);
      result.reservedCostMicros = integer(value.reserved_cost_micros);
    } else if (['reservation_id', 'status', 'window_start', 'reserved_cost_micros'].some(key => value[key] !== undefined)) fail();
    if (value.reason === 'AI_BUDGET_EXCEEDED') result.scope = scope(value.scope);
    else if (value.scope !== undefined) fail();
    if (['reserved_requests', 'reserved_input_tokens', 'reserved_output_tokens', 'reserved_total_tokens', 'currency', 'pricing_version'].some(key => value[key] !== undefined)) fail();
    return result;
  } catch { throw providerUsageError('AI_USAGE_RESPONSE_INVALID'); }
}

export function providerUsageSettlementResult(value, params) {
  // A valid SQL overrun is successful durable accounting, even when its exact
  // accountedCostMicros is a decimal string. A malformed/lost response can still
  // follow a committed settlement; retry only the same identity, never dispatch.
  try {
    record(value, ['reservation_id', 'status', 'accounted_cost_micros', 'held_cost_micros', 'window_start', 'idempotent', 'reason']);
    if (value.reservation_id !== params.p_reservation_id) fail();
    const result = { reservationId: text(value.reservation_id), status: status(value.status), idempotent: boolean(value.idempotent) };
    if (result.status === 'uncertain') {
      if (params.p_outcome === 'cancelled_pre_dispatch' || value.accounted_cost_micros !== undefined || value.window_start !== undefined) fail();
      result.heldCostMicros = integer(value.held_cost_micros);
      result.reason = text(value.reason, CODE);
    } else {
      if (value.held_cost_micros !== undefined || value.reason !== undefined) fail();
      if (params.p_outcome === 'cancelled_pre_dispatch') {
        if (result.status !== 'cancelled_pre_dispatch') fail();
        if (value.accounted_cost_micros !== undefined && value.accounted_cost_micros !== 0) fail();
      } else if (params.p_outcome !== 'complete' || !['settled', 'overrun'].includes(result.status)) fail();
      if (value.accounted_cost_micros !== undefined) result.accountedCostMicros = exactAccountedCost(value.accounted_cost_micros);
      else if (!(result.status === 'cancelled_pre_dispatch' && result.idempotent)) fail();
      if (value.window_start !== undefined) result.windowStart = monthStart(value.window_start);
      else if (!result.idempotent) fail();
    }
    return result;
  } catch { throw providerUsageError('AI_USAGE_RESPONSE_INVALID'); }
}

export function providerUsageUnavailableReason(error) {
  if (['42P01', '42703', '42883', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error?.databaseCode)) return 'AI_USAGE_MIGRATION_REQUIRED';
  if (error?.databaseCode === '42501' || [401, 403].includes(error?.httpStatus)) return 'AI_USAGE_NOT_CONFIGURED';
  return 'AI_USAGE_UNAVAILABLE';
}

export function providerUsageSummaryResult(rows, workspaceId, windowStart) {
  try {
    if (!Array.isArray(rows) || rows.length > USAGE_SUMMARY_MAX_SCOPES) fail();
    if (!rows.length) return { available: false, reason: 'AI_USAGE_NOT_CONFIGURED' };
    const scopes = rows.map(row => {
      record(row, USAGE_SUMMARY_COLUMNS.split(','));
      if (row.workspace_id !== workspaceId || row.window_start !== windowStart || row.currency !== 'USD') fail();
      const result = { scopeKey: scope(row.scope_key) };
      for (const prefix of ['held', 'settled']) {
        result[prefix] = {
          requests: integer(row[`${prefix}_requests`]), inputTokens: integer(row[`${prefix}_input_tokens`]),
          outputTokens: integer(row[`${prefix}_output_tokens`]), totalTokens: integer(row[`${prefix}_total_tokens`]),
          costMicros: integer(row[`${prefix}_cost_micros`])
        };
        if (!Number.isSafeInteger(result[prefix].inputTokens + result[prefix].outputTokens)
          || result[prefix].inputTokens + result[prefix].outputTokens !== result[prefix].totalTokens) fail();
      }
      return result;
    });
    if (new Set(scopes.map(item => item.scopeKey)).size !== scopes.length || !scopes.some(item => item.scopeKey === 'tenant')) fail();
    return { available: true, admissionMonth: windowStart.slice(0, 7), currency: 'USD', scopes };
  } catch { return { available: false, reason: 'AI_USAGE_RESPONSE_INVALID' }; }
}
