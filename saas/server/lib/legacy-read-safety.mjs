// Admission for the pre-migration compatibility release. This release cannot
// consume newer durable read contracts, release their debt, or create receipts.
// Unmarked workspaces continue through the existing adapters unchanged.
const own = (value, key) => value != null && Object.hasOwn(value, key);
const present = value => value !== undefined && value !== null && value !== '';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function malformedProviderEnvelope(container, provider) {
  return container != null && (!record(container) || own(container, provider) && !record(container[provider]));
}

function retryTime(value) {
  if (typeof value !== 'string' || value.length > 24 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return NaN;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return NaN;
  const canonical = new Date(time).toISOString();
  return canonical === value || canonical === value.replace('Z', '.000Z') ? time : NaN;
}

function newerContract(state, provider) {
  if (malformedProviderEnvelope(state.connectionDoctor, provider) || malformedProviderEnvelope(state.integrationStatus, provider)) return true;
  const doctor = state.connectionDoctor?.[provider], status = state.integrationStatus?.[provider];
  if (own(doctor, 'pendingReadAttempts') || own(doctor, 'orderReadBinding')) return true;
  if (['orderReadHold', 'orderReadAttempt', 'orderRecovery'].some(key => own(status, key))) return true;
  if (provider !== 'shopify') return false;
  if (malformedProviderEnvelope(state.channelData, provider) || own(state.channelData?.shopify, 'orderReads')) return true;
  // Finite inspection bounds also fail closed on malformed retained envelopes.
  // These are admission limits, not trimming: every original row is retained.
  for (const [rows, limit, marked] of [
    [state.orders, 100000, row => (!row.provider || row.provider === 'shopify') && (own(row, 'sourceReadRef') || own(row, 'sourceCurrencyOverrides'))],
    [state.connectionSyncs, 10000, row => row.provider === provider && own(row, 'orderRecoveryStageId')]
  ]) {
    if (rows == null) continue;
    if (!Array.isArray(rows) || rows.length > limit) return true;
    for (const row of rows) if (!record(row) || marked(row)) return true;
  }
  return false;
}

export function legacyReadDeferral(state, provider, { automatic = false, now = Date.now() } = {}) {
  const incompatible = newerContract(state, provider) ? {
    code: 'READ_COMPATIBILITY_DEFERRED', status: 409, readDeferred: true,
    message: 'Saved read safety state requires a newer compatible reader. Existing data and retry limits are retained.'
  } : null;
  if (provider !== 'ebay') return incompatible;
  let latest = now, review = false;
  const values = [state.integrationStatus?.ebay], coverage = state.ebay?.coverage;
  if (state.ebay != null && !record(state.ebay) || coverage != null && !record(coverage)) review = true;
  const diagnostics = coverage?.readDiagnostics;
  if (diagnostics != null) {
    if (!record(diagnostics)) review = true;
    else {
      let count = 0;
      for (const surface in diagnostics) {
        if (!own(diagnostics, surface)) continue;
        if (++count > 100) { review = true; break; }
        if (!record(diagnostics[surface])) review = true;
        else values.push(diagnostics[surface]);
      }
    }
  }
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const time = retryTime(value.retryAt);
    if (Number.isFinite(time)) latest = Math.max(latest, time);
    else if (present(value.retryAt)) review = true;
    if (value.retryReviewRequired != null && value.retryReviewRequired !== false) review = true;
  }
  if (incompatible) return { ...incompatible, ...(latest > now ? { retryAt: new Date(latest).toISOString() } : {}), ...(review ? { retryReviewRequired: true } : {}) };
  if (review || latest > now) return {
    code: review ? 'EBAY_RETRY_REVIEW_REQUIRED' : 'EBAY_READ_DEFERRED', status: 429,
    readDeferred: true, cooldownDeferred: true, retryAt: latest > now ? new Date(latest).toISOString() : null,
    retryReviewRequired: review,
    message: review ? 'The saved eBay retry deadline needs review before another read.' : 'eBay reads are waiting for the saved retry deadline.'
  };
  if (automatic && retryTime(state.connectionDoctor?.ebay?.nextRetryAt) > now) return {
    code: 'CONNECTION_RETRY_DEFERRED', status: 409, readDeferred: true, cooldownDeferred: true,
    message: 'Automatic eBay reads are waiting for the saved retry deadline.'
  };
  return null;
}

export function assertLegacyReadAdmission(state, provider, options) {
  const deferred = legacyReadDeferral(state, provider, options);
  if (deferred) throw Object.assign(new Error(deferred.message), deferred);
}

export const isLegacyReadDeferred = error => error?.readDeferred === true || error?.cooldownDeferred === true;

// Keep already persisted fields, including expired deadlines and unrecognized
// values. No provider Retry-After parsing or new source contract is introduced.
export function preserveEbayRetryFields(next, ...retained) {
  const result = { ...next };
  for (const saved of retained) {
    if (!saved || typeof saved !== 'object') continue;
    if (own(saved, 'retryAt')) {
      const oldTime = retryTime(saved.retryAt), newTime = retryTime(result.retryAt);
      if (!own(result, 'retryAt') || !present(result.retryAt)
        || present(saved.retryAt) && (!Number.isFinite(oldTime) || Number.isFinite(newTime) && oldTime > newTime)) result.retryAt = saved.retryAt;
    }
    if (own(saved, 'retryReviewRequired') && (!own(result, 'retryReviewRequired') || result.retryReviewRequired == null || result.retryReviewRequired === false)) result.retryReviewRequired = saved.retryReviewRequired;
  }
  return result;
}

export function preserveEbayReadDiagnostics(next, previous) {
  const result = { ...next };
  for (const [surface, value] of Object.entries(previous || {})) {
    if (own(value, 'retryAt') || own(value, 'retryReviewRequired')) result[surface] = preserveEbayRetryFields(result[surface] || value, value);
  }
  return result;
}
