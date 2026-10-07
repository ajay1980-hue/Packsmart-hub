import { createHash } from 'node:crypto';
import { evidenceInWorkspace } from './business-evidence-scope.mjs';

// A projection of the authoritative workspace snapshot, not a new accounting
// ledger. No current importer records a trusted order-period or cost-basis
// contract. This module deliberately cannot certify either one.
export const IMPORTED_ORDER_EVIDENCE_VERSION = 'imported-order-evidence/v1';
export const IMPORTED_ORDER_EVIDENCE_LIMITS = Object.freeze({
  orders: 2000, lines: 8000, linesPerOrder: 100, referencedCosts: 2000,
  groups: 64, skuGroups: 80, references: 100, identifierLength: 256,
  decimalPlaces: 6, integerDigits: 24
});

const PROVIDERS = new Set(['shopify', 'ebay', 'meta', 'tiktok_shop', 'pinterest', 'google_youtube', 'whatsapp_business', 'amazon']);
const STATUSES = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'AUTHORIZED', 'PARTIALLY_PAID', 'PENDING', 'EXPIRED', 'VOIDED', 'UNPAID', 'UNKNOWN'];
const PAID_OR_REFUNDED = new Set(['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED']);
const MONEY_FIELDS = ['total', 'currentTotal', 'refunds', 'tax', 'currentTax', 'discounts', 'shippingCharged'];
const ORDER_COSTS = { delivery: 'actualShippingCost', paymentFee: 'paymentFees', channelFee: 'channelFees', advertising: 'advertisingCost', otherVariable: 'otherVariableCosts' };
const UNIT_COSTS = ['packing', 'handling', ...Object.keys(ORDER_COSTS)];
const SCALE = 1000000n;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= IMPORTED_ORDER_EVIDENCE_LIMITS.identifierLength && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
const hash = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
// Syntax only: a recorded code is not proof of an ISO currency, source currency,
// or financial support. Keep unknown codes separate without a guessed allowlist.
const currency = value => typeof value === 'string' && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : null;
const currencyStatus = value => value === null ? 'missing_or_malformed' : 'unverified_recorded_code';

function inWorkspace(record, workspaceId, depth = 0) {
  if (depth > 4 || !evidenceInWorkspace(record, workspaceId)) return false;
  return ['workspace', 'tenant'].every(key => !own(record, key) || !object(record[key]) || inWorkspace(record[key], workspaceId, depth + 1));
}

function invalid(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }

// Exact arithmetic on the recorded decimal spelling. Numbers are already
// normalized by ingestion; converting their bounded spelling does not recover
// discarded provider precision. Booleans, blanks, exponent notation, unsafe
// numbers and precision beyond six places remain unknown, never rounded to zero.
function decimal(value) {
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const raw = String(value);
  if (raw.length > 33 || !/^[+-]?(?:\d+(?:\.\d{1,6})?|\.\d{1,6})$/.test(raw)) return null;
  const negative = raw.startsWith('-');
  const [whole, fraction = ''] = raw.replace(/^[+-]/, '').split('.');
  if ((whole.replace(/^0+/, '') || '0').length > IMPORTED_ORDER_EVIDENCE_LIMITS.integerDigits) return null;
  const result = BigInt(whole || '0') * SCALE + BigInt(fraction.padEnd(6, '0'));
  return negative ? -result : result;
}

function spelling(value) {
  if (value === null) return null;
  const absolute = value < 0n ? -value : value;
  const fraction = String(absolute % SCALE).padStart(6, '0').replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${absolute / SCALE}${fraction ? `.${fraction}` : ''}`;
}

function divide(numerator, denominator) {
  return denominator !== 0n && numerator % denominator === 0n ? numerator / denominator : null;
}

function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const normalized = new Date(time).toISOString();
  return normalized === (value.length === 20 ? value.replace('Z', '.000Z') : value) ? normalized : null;
}

function landedNumber(record) {
  if (record.landed !== null && record.landed !== undefined) return decimal(record.landed);
  let unit = decimal(record.supplierUnitCost);
  if (record.supplierUnitCost === null || record.supplierUnitCost === undefined) {
    const price = decimal(record.boxPrice), quantity = decimal(record.boxQuantity);
    unit = price !== null && quantity !== null && quantity > 0n ? divide(price * SCALE, quantity) : null;
  }
  const delivery = decimal(record.supplierDelivery), rate = decimal(record.supplierVatRate);
  if (unit === null || delivery === null || rate === null || typeof record.supplierVatRecoverable !== 'boolean') return null;
  const vat = record.supplierVatRecoverable ? 0n : divide(unit * rate, 100n * SCALE);
  return vat === null ? null : unit + delivery + vat;
}

const accumulator = () => ({ sum: 0n, knownCount: 0, unknownCount: 0, negative: false });
function add(target, value) {
  if (value === null) target.unknownCount++;
  else { target.sum += value; target.knownCount++; target.negative ||= value < 0n; }
}
function metric(target, complete, moneyCurrency = true) {
  const qualified = complete && moneyCurrency && target.unknownCount === 0 && target.knownCount > 0;
  return {
    knownCount: target.knownCount, unknownCount: target.unknownCount,
    knownSubtotal: moneyCurrency && target.knownCount > 0 ? spelling(target.sum) : null,
    completeCohortTotal: qualified ? spelling(target.sum) : null,
    complete: qualified
  };
}

/**
 * All monetary outputs are decimal strings or null. Every group is provider +
 * recorded normalized currency + recorded financial-status cohort. Complete
 * means only the eligible retained snapshot cohort, never the provider period,
 * business, cash collection, or accounting revenue. Callers cannot widen caps.
 */
function inspect(state, options = {}) {
  const workspaceId = id(options.workspaceId);
  if (!workspaceId) throw invalid('WORKSPACE_REQUIRED', 'Explicit workspace identity is required');
  if (!object(state) || state.workspace?.id !== workspaceId || !inWorkspace(state, workspaceId) || !inWorkspace(state.workspace, workspaceId)) {
    throw invalid('WORKSPACE_MISMATCH', 'Workspace identity mismatch', 403);
  }
  const startAt = instant(options.period?.startAt), endAt = instant(options.period?.endAt);
  if (!startAt || !endAt || startAt >= endAt) throw invalid('ORDER_PERIOD_INVALID', 'A nonempty half-open UTC period is required');
  if (!Array.isArray(options.providers) || !options.providers.length || options.providers.length > PROVIDERS.size || [...options.providers].some(value => !PROVIDERS.has(value)) || new Set(options.providers).size !== options.providers.length) {
    throw invalid('ORDER_PROVIDERS_INVALID', 'Select distinct supported providers explicitly');
  }
  const providers = [...options.providers].sort(), selected = new Set(providers), limits = IMPORTED_ORDER_EVIDENCE_LIMITS;
  const orders = Array.isArray(state.orders) ? state.orders : [];
  const collectionAvailable = Array.isArray(state.orders);
  const economics = object(state.economics) && inWorkspace(state.economics, workspaceId) ? state.economics : null;
  const counts = {
    availableOrders: collectionAvailable ? orders.length : null, scannedOrders: 0, selectedProviderRows: 0,
    scannedLines: 0, referencedCosts: 0, retainedOrders: 0, identicalDuplicateRows: 0, conflictingIdentities: 0,
    conflictingDuplicateRows: 0, excludedProviderRows: 0, invalidProviderRows: 0, invalidOrderRows: 0,
    invalidScopeRows: 0, invalidLineScopeOrders: 0, missingIdentityRows: 0, invalidDateOrders: 0,
    cancelledOrders: 0, outsidePeriodOrders: 0, unknownCurrencyOrders: 0, unqualifiedCostReferences: 0,
    invalidLineOrders: 0, unknownSkuLines: 0, scopeTaintedIdentities: 0, unscannedLineOrders: 0
  };
  const truncated = { orders: orders.length > limits.orders, lines: false, referencedCosts: false, groups: false, skuGroups: false, references: false };
  const identities = new Map(), scopeTainted = new Set(), costCache = new Map(), refs = new Map(), groups = new Map(), skuGroups = new Map();
  const retainedRows = [];
  const cohorts = Object.fromEntries(STATUSES.map(status => [status, 0]));
  const cancelledCohorts = Object.fromEntries(STATUSES.map(status => [status, 0]));
  let unresolvedEligibility = !collectionAvailable;

  function reference(collection, pointer, identityHash, provider, sourceIdField = null) {
    const key = `${collection}:${identityHash}`;
    if (refs.has(key)) return;
    if (refs.size === limits.references) { truncated.references = true; return; }
    refs.set(key, { collection, pointer, identityHash, provider, ...(sourceIdField ? { sourceIdField } : {}) });
  }

  function costFor(sku, provider) {
    if (!sku) return null;
    if (!costCache.has(sku)) {
      if (costCache.size === limits.referencedCosts) { truncated.referencedCosts = true; return null; }
      counts.referencedCosts++;
      const record = economics && own(economics, sku) ? economics[sku] : null;
      // A missing, malformed or foreign cost must not supply even numeric coverage.
      const scoped = object(record) && inWorkspace(record, workspaceId);
      if (record !== null && !scoped) counts.unqualifiedCostReferences++;
      costCache.set(sku, scoped ? record : null);
    }
    const result = costCache.get(sku);
    if (result) reference('economics', '/economics', hash([workspaceId, provider, 'economics-key', sku]), provider);
    return result;
  }

  function normalize(order, index, provider, sourceId, sourceIdField) {
    const values = Object.fromEntries(MONEY_FIELDS.map(field => [field, decimal(order[field])]));
    const netTotal = values.currentTotal !== null ? values.currentTotal
      : (order.currentTotal === null || order.currentTotal === undefined) && values.total !== null && values.refunds !== null ? values.total - values.refunds : null;
    // Original tax is not silently promoted to current tax after a refund.
    values.netTotal = netTotal;
    values.netTotalExCurrentTax = netTotal !== null && values.currentTax !== null ? netTotal - values.currentTax : null;
    const normalizedStatus = typeof order.financialStatus === 'string' && order.financialStatus.length <= 40 ? order.financialStatus.toUpperCase() : 'UNKNOWN';
    const financialStatus = STATUSES.includes(normalizedStatus) ? normalizedStatus : 'UNKNOWN';
    const normalizedCurrency = currency(order.currency), createdAt = instant(order.createdAt);
    const recordedFulfillment = typeof order.fulfillmentStatus === 'string' && order.fulfillmentStatus.length <= 40 ? order.fulfillmentStatus.toUpperCase() : 'UNKNOWN';
    const fulfillmentStatus = ['FULFILLED', 'UNFULFILLED', 'PARTIAL', 'PARTIALLY_FULFILLED', 'RESTOCKED', 'IN_PROGRESS', 'ON_HOLD', 'OPEN', 'SCHEDULED'].includes(recordedFulfillment) ? recordedFulfillment : 'UNKNOWN';
    const cancelled = order.cancelledAt !== null && order.cancelledAt !== undefined && order.cancelledAt !== '';
    const rawLines = Array.isArray(order.lineItems) ? order.lineItems : [];
    let linesComplete = Array.isArray(order.lineItems) && rawLines.length > 0;
    let scopeValid = true;
    const lines = [], lineIds = new Set();
    const count = Math.min(rawLines.length, limits.linesPerOrder, Math.max(0, limits.lines - counts.scannedLines));
    if (count < rawLines.length) { truncated.lines = true; linesComplete = false; }
    for (let lineIndex = 0; lineIndex < count; lineIndex++) {
      counts.scannedLines++;
      const line = rawLines[lineIndex];
      if (!object(line)) { linesComplete = false; lines.push({ invalid: true }); continue; }
      if (!inWorkspace(line, workspaceId)) { scopeValid = false; linesComplete = false; }
      const lineId = id(line.id), sku = id(line.sku);
      if (lineId && lineIds.has(lineId)) linesComplete = false;
      if (lineId) lineIds.add(lineId);
      lines.push({ id: lineId, sku, quantity: decimal(line.quantity), gross: decimal(line.gross), net: decimal(line.net), scopeValid: inWorkspace(line, workspaceId) });
    }
    const overrides = Object.fromEntries(Object.entries(ORDER_COSTS).map(([field, key]) => [field, decimal(order[key])]));
    const overrideNumbersValid = Object.values(ORDER_COSTS).every(key => order[key] === undefined || order[key] === null || decimal(order[key]) !== null);
    const overrideScopeValid = !own(order, 'costOverrides') || order.costOverrides === null || inWorkspace(order.costOverrides, workspaceId);
    // Compare only normalized evidence fields; customer/name/raw payloads never
    // affect identity. An unscanned tail cannot establish an identical duplicate.
    const signature = count < rawLines.length ? null : hash([
      createdAt, cancelled, financialStatus, fulfillmentStatus, normalizedCurrency, Object.values(values).map(spelling),
      Object.values(overrides).map(spelling), overrideNumbersValid, overrideScopeValid, linesComplete, scopeValid,
      lines.map(line => JSON.stringify([line.invalid || false, line.id, line.sku, spelling(line.quantity ?? null), spelling(line.gross ?? null), spelling(line.net ?? null), line.scopeValid])).sort()
    ]);
    return { index, provider, sourceId, sourceIdField, identityHash: hash([workspaceId, provider, sourceId]), createdAt, cancelled, financialStatus, fulfillmentStatus, currency: normalizedCurrency,
      values, overrides, overrideNumbersValid, overrideScopeValid, lines, linesComplete, linesScannedFully: count === rawLines.length, scopeValid, signature, occurrences: 1, conflict: false };
  }

  // Identity reconciliation precedes date, cancellation and status filtering: an
  // out-of-period or cancelled conflicting copy cannot leave its favourable twin.
  for (let index = 0; index < Math.min(orders.length, limits.orders); index++) {
    counts.scannedOrders++;
    const order = orders[index];
    if (!object(order)) { counts.invalidOrderRows++; unresolvedEligibility = true; continue; }
    if (!PROVIDERS.has(order.provider)) { counts.invalidProviderRows++; unresolvedEligibility = true; continue; }
    if (!selected.has(order.provider)) { counts.excludedProviderRows++; continue; }
    counts.selectedProviderRows++;
    const sourceIdField = own(order, 'externalId') ? 'externalId' : 'id';
    const sourceId = id(order[sourceIdField]);
    if (!inWorkspace(order, workspaceId)) {
      counts.invalidScopeRows++; unresolvedEligibility = true;
      if (sourceId) scopeTainted.add(JSON.stringify([order.provider, sourceId]));
      continue;
    }
    if (!sourceId) { counts.missingIdentityRows++; unresolvedEligibility = true; continue; }
    const row = normalize(order, index, order.provider, sourceId, sourceIdField);
    const key = JSON.stringify([row.provider, sourceId]);
    const previous = identities.get(key);
    if (previous) {
      previous.occurrences++;
      if (!row.signature || !previous.signature || row.signature !== previous.signature) previous.conflict = true;
    } else identities.set(key, row);
  }

  function numericCosts(row) {
    let complete = row.linesComplete && row.scopeValid && row.overrideScopeValid && row.overrideNumbersValid;
    for (const line of row.lines) {
      const record = costFor(line.sku, row.provider);
      if (!record || line.quantity === null || line.quantity === undefined || line.quantity < 0n || line.quantity % SCALE !== 0n || landedNumber(record) === null) { complete = false; continue; }
      for (const field of UNIT_COSTS) if (row.overrides[field] === null || row.overrides[field] === undefined) {
        if (decimal(record[field]) === null) complete = false;
      }
    }
    return complete;
  }

  for (const row of identities.values()) {
    if (scopeTainted.has(JSON.stringify([row.provider, row.sourceId]))) { counts.scopeTaintedIdentities++; continue; }
    if (row.conflict) {
      counts.conflictingIdentities++; counts.conflictingDuplicateRows += row.occurrences; unresolvedEligibility = true; continue;
    }
    counts.identicalDuplicateRows += row.occurrences - 1;
    // Do not expose even a known subtotal from an order whose unseen line tail
    // could carry a conflicting tenant marker. Bounds never relax scope checks.
    if (!row.linesScannedFully) { counts.unscannedLineOrders++; unresolvedEligibility = true; continue; }
    if (!row.scopeValid) { counts.invalidLineScopeOrders++; unresolvedEligibility = true; continue; }
    if (!row.createdAt) { counts.invalidDateOrders++; unresolvedEligibility = true; continue; }
    if (row.createdAt < startAt || row.createdAt >= endAt) { counts.outsidePeriodOrders++; continue; }
    counts.retainedOrders++; cohorts[row.financialStatus]++;
    if (row.cancelled) { counts.cancelledOrders++; cancelledCohorts[row.financialStatus]++; }
    if (!row.linesComplete) counts.invalidLineOrders++;
    if (!row.currency) counts.unknownCurrencyOrders++;
    reference('orders', `/orders/${row.index}`, row.identityHash, row.provider, row.sourceIdField);
    const costsComplete = numericCosts(row);
    retainedRows.push({ order: orders[row.index], pointer: `/orders/${row.index}`, identityHash: row.identityHash, provider: row.provider, sourceIdField: row.sourceIdField, createdAt: row.createdAt, financialStatus: row.financialStatus, fulfillmentStatus: row.fulfillmentStatus, cancelled: row.cancelled, currency: row.currency, recordedAmounts: Object.fromEntries(Object.entries(row.values).map(([key, value]) => [key, spelling(value)])), costNumbersComplete: costsComplete, costOverrideScopeValid: row.overrideScopeValid });
    const key = JSON.stringify([row.provider, row.currency, row.financialStatus, row.cancelled]);
    if (!groups.has(key)) {
      if (groups.size === limits.groups) { truncated.groups = true; continue; }
      groups.set(key, { provider: row.provider, currency: row.currency, financialStatus: row.financialStatus, cancelled: row.cancelled, orders: 0,
        values: Object.fromEntries(Object.keys(row.values).map(field => [field, accumulator()])), costCompleteOrders: 0, costCoveredNet: accumulator() });
    }
    const group = groups.get(key);
    group.orders++;
    for (const [field, value] of Object.entries(row.values)) add(group.values[field], value);
    if (costsComplete) { group.costCompleteOrders++; add(group.costCoveredNet, row.values.netTotal); }

    // These are provider-scoped recorded SKU buckets, not catalogue attribution.
    // No product join duplicates sales across providers/variants; eBay's SKU can
    // itself be a legacy listing ID, so even an equal string proves no cost link.
    for (const line of row.lines) {
      if (!line.sku) counts.unknownSkuLines++;
      if (!line.sku || !line.scopeValid) continue;
      const skuHash = hash([workspaceId, row.provider, 'recorded-sku', line.sku]);
      const skuKey = JSON.stringify([key, skuHash]);
      if (!skuGroups.has(skuKey)) {
        if (skuGroups.size === limits.skuGroups) { truncated.skuGroups = true; continue; }
        skuGroups.set(skuKey, { provider: row.provider, currency: row.currency, financialStatus: row.financialStatus, cancelled: row.cancelled, skuHash, lines: 0, quantity: accumulator(), net: accumulator() });
      }
      const skuGroup = skuGroups.get(skuKey);
      skuGroup.lines++; add(skuGroup.quantity, line.quantity); add(skuGroup.net, line.net);
    }
  }

  const scanComplete = collectionAvailable && !truncated.orders && !truncated.lines && !truncated.referencedCosts;
  const outputComplete = !truncated.groups && !truncated.skuGroups && !truncated.references;
  const retainedCohortComplete = scanComplete && outputComplete && !unresolvedEligibility;
  const evidence = {
    schema: IMPORTED_ORDER_EVIDENCE_VERSION, workspaceId, period: { startAt, endAt, boundary: '[startAt,endAt)' }, providers,
    limits: { ...limits }, counts,
    completeness: { collectionAvailable, scanComplete, outputComplete, eligibilityResolved: !unresolvedEligibility, retainedCohortComplete, truncated,
      sourcePeriod: 'unverified', businessTotalsAvailable: false },
    provenance: {
      collection: 'state.orders', identity: 'provider + externalId; id only when externalId is absent',
      scope: 'workspace snapshot; all explicit tenant markers must match',
      dates: 'normalized createdAt; importer may have supplied a fallback',
      currency: 'normalized order.currency; importer may have supplied a fallback; three-letter recorded code only; recognition and source provenance unverified; no workspace inference or FX',
      amounts: 'normalized recorded fields; importer may have defaulted, derived or rounded amounts',
      netTotal: 'currentTotal, else total minus explicit refunds; no clamp; missing stays unknown',
      netTotalExCurrentTax: 'netTotal minus explicit currentTax; original tax is not substituted',
      cash: 'financial status and normalized totals do not establish collected cash',
      costNumbers: 'current SKU-keyed economics and order-level overrides only; numeric completeness is not a historical cost assignment',
      advertising: 'order allocation belongs inside variable costs; channel advertising is never subtracted here'
    },
    sourcePeriods: providers.map(provider => ({ provider, status: 'unverified', reason: 'no_trusted_order_period_contract' })),
    financialStatusCohorts: STATUSES.map(financialStatus => ({ financialStatus, orders: cohorts[financialStatus], cancelledOrders: cancelledCohorts[financialStatus], recordedPaidOrRefunded: PAID_OR_REFUNDED.has(financialStatus), collectedCash: null })),
    groups: [...groups.values()].map(group => {
      const monetary = group.currency !== null, net = group.values.netTotal, covered = group.costCoveredNet;
      const netCoverageQualified = retainedCohortComplete && monetary && net.unknownCount === 0 && !net.negative && net.sum > 0n && covered.unknownCount === 0;
      return {
        provider: group.provider, currency: group.currency, currencyStatus: currencyStatus(group.currency), financialStatus: group.financialStatus, cancelled: group.cancelled, orders: group.orders,
        recordedPaidOrRefunded: PAID_OR_REFUNDED.has(group.financialStatus),
        recordedAmounts: Object.fromEntries(Object.entries(group.values).map(([field, value]) => [field, metric(value, retainedCohortComplete, monetary)])),
        costNumbers: {
          completeOrders: group.costCompleteOrders, incompleteOrders: group.orders - group.costCompleteOrders,
          completeCohort: retainedCohortComplete && group.costCompleteOrders === group.orders,
          orderCoverage: { numerator: group.costCompleteOrders, denominator: group.orders },
          coveredNetTotal: metric(covered, retainedCohortComplete && group.costCompleteOrders === group.orders, monetary),
          netTotalCoverage: netCoverageQualified ? { numerator: spelling(covered.sum), denominator: spelling(net.sum) } : null
        },
        financialQualification: { qualifiedOrders: 0, currency: 'unverified', taxTreatment: 'unverified', historicalCostBasis: 'unverified',
          reason: 'no_trusted_cost_currency_tax_or_historical_assignment_contract', grossProfit: null, contributionProfit: null, marginPercent: null, collectedCash: null }
      };
    }),
    skuGroups: [...skuGroups.values()].map(group => ({ provider: group.provider, currency: group.currency, currencyStatus: currencyStatus(group.currency), financialStatus: group.financialStatus, cancelled: group.cancelled, skuHash: group.skuHash,
      lines: group.lines, recordedQuantity: metric(group.quantity, retainedCohortComplete && counts.invalidLineOrders === 0 && counts.unknownSkuLines === 0), recordedLineNet: metric(group.net, retainedCohortComplete && counts.invalidLineOrders === 0 && counts.unknownSkuLines === 0, group.currency !== null),
      attribution: 'unverified_recorded_sku_only', refundsAllocated: false })),
    references: [...refs.values()]
  };
  return { evidence, rows: retainedRows };
}

// Public DTO deliberately excludes raw order/customer data. Internal consumers
// share the same bounded identity reconciliation before inspecting authorized
// source rows for nonfinancial follow-up and the existing raw order editor.
export function projectImportedOrderEvidence(state, options = {}) {
  return inspect(state, options).evidence;
}
export function inspectImportedOrderEvidence(state, options = {}) {
  return inspect(state, options);
}
