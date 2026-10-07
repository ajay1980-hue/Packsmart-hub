import { inspectImportedOrderEvidence, LEGACY_ORDER_FIELD_PROVENANCE } from './imported-order-evidence.mjs';

export const ORDER_ANALYTICS_PROVIDERS = Object.freeze(['shopify', 'ebay', 'meta', 'tiktok_shop', 'pinterest', 'google_youtube', 'whatsapp_business', 'amazon']);
const DAY = 86400000;
const PAID = new Set(['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED']);
const unavailableMoney = { revenue: null, knownRevenue: null, grossRevenue: null, grossProfit: null, operatingProfit: null, margin: null, refunds: null, profitCoverage: null, profitCoveredOrders: null };
export const FINANCIAL_QUALIFICATION_REASON = 'Historical currency, tax, cost assignment and source-period coverage are unverified.';

export function orderPeriod(now, days) {
  const endAt = now.toISOString();
  return { startAt: days === 'today' ? endAt.slice(0, 10) + 'T00:00:00.000Z' : new Date(now.getTime() - days * DAY).toISOString(), endAt };
}

export function inspectOrderPeriod(state, period, providers = ORDER_ANALYTICS_PROVIDERS) {
  // Missing authenticated scope does not authorise inventing a workspace. Empty
  // UTC today is a zero-duration interval, not a fabricated provider observation.
  if (!state.workspace?.id || period.startAt === period.endAt) return { evidence: null, rows: [], period, providers: [...providers], collectionAvailable: Array.isArray(state.orders), reason: !state.workspace?.id ? 'workspace_unavailable' : 'empty_utc_interval' };
  return { ...inspectImportedOrderEvidence(state, { workspaceId: state.workspace.id, period, providers: [...providers] }), period, providers: [...providers] };
}

export const ORDER_EVIDENCE_PRESENTATION_LIMITS = Object.freeze({ groups: 16, skuGroups: 12, orderDetails: 100 });
export function compactOrderEvidence(source) {
  if (!source) return null;
  const groups = source.groups.slice(0, ORDER_EVIDENCE_PRESENTATION_LIMITS.groups);
  const skuGroups = source.skuGroups.slice(0, ORDER_EVIDENCE_PRESENTATION_LIMITS.skuGroups);
  const clipped = groups.length < source.groups.length || skuGroups.length < source.skuGroups.length;
  const suppress = metric => clipped ? { ...metric, complete: false, completeCohortTotal: null } : metric;
  return {
    schema: source.schema, period: source.period, providers: source.providers, counts: source.counts,
    completeness: { ...source.completeness, outputComplete: source.completeness.outputComplete && !clipped,
      retainedCohortComplete: source.completeness.retainedCohortComplete && !clipped },
    provenance: { ...LEGACY_ORDER_FIELD_PROVENANCE, amounts: 'normalized recorded fields; may include importer defaults or rounding', currency: 'unverified recorded code; no currency inference or FX', costNumbers: 'numeric availability only; historical assignment unverified' },
    sourcePeriods: source.sourcePeriods, financialStatusCohorts: source.financialStatusCohorts,
    groups: groups.map(group => ({ ...group,
      recordedAmounts: Object.fromEntries(Object.entries(group.recordedAmounts).map(([key, metric]) => [key, suppress(metric)])),
      costNumbers: { ...group.costNumbers, completeCohort: group.costNumbers.completeCohort && !clipped,
        coveredNetTotal: suppress(group.costNumbers.coveredNetTotal), netTotalCoverage: clipped ? null : group.costNumbers.netTotalCoverage }
    })),
    skuGroups: skuGroups.map(group => ({ ...group, recordedQuantity: suppress(group.recordedQuantity), recordedLineNet: suppress(group.recordedLineNet) })),
    presentation: { groupLimit: ORDER_EVIDENCE_PRESENTATION_LIMITS.groups, groupsAvailable: source.groups.length, groupsReturned: groups.length,
      skuGroupLimit: ORDER_EVIDENCE_PRESENTATION_LIMITS.skuGroups, skuGroupsAvailable: source.skuGroups.length, skuGroupsReturned: skuGroups.length, truncated: clipped }
  };
}

export function summarizeOrderInspection(inspection, provider = null) {
  const rows = inspection.rows.filter(row => !provider || row.provider === provider);
  const source = inspection.evidence;
  const evidence = source;
  const available = source?.completeness.collectionAvailable === true || (inspection.reason === 'empty_utc_interval' && inspection.collectionAvailable);
  const completeOrders = rows.filter(row => row.costNumbersComplete).length;
  const knownFulfillment = rows.filter(row => row.fulfillmentStatus !== 'UNKNOWN');
  return {
    ...unavailableMoney,
    basis: 'normalized_recorded_order_cohorts', financialStatus: 'unavailable', reason: inspection.reason || FINANCIAL_QUALIFICATION_REASON,
    period: { ...inspection.period, boundary: '[startAt,endAt)' }, providers: provider ? [provider] : inspection.providers,
    sourcePeriod: 'unverified', orders: available ? rows.length : null,
    paidOrders: available ? rows.filter(row => PAID.has(row.financialStatus)).length : null,
    openOrders: available ? knownFulfillment.filter(row => !row.cancelled && !['FULFILLED', 'RESTOCKED'].includes(row.fulfillmentStatus)).length : null,
    unknownFulfillmentOrders: available ? rows.length - knownFulfillment.length : null,
    refundedOrders: available ? rows.filter(hasRecordedRefund).length : null,
    numericCostCoverage: {
      completeOrders: available ? completeOrders : null, incompleteOrders: available ? rows.length - completeOrders : null,
      orderCoverage: available && rows.length ? { numerator: completeOrders, denominator: rows.length } : null,
      completeCohort: Boolean(source?.completeness.retainedCohortComplete && source.groups.length <= ORDER_EVIDENCE_PRESENTATION_LIMITS.groups && source.skuGroups.length <= ORDER_EVIDENCE_PRESENTATION_LIMITS.skuGroups && rows.length && completeOrders === rows.length),
      basis: 'numeric_availability_only_not_historical_financial_qualification'
    },
    importedOrderEvidence: provider ? null : compactOrderEvidence(evidence),
    ...(provider ? { evidenceRef: { period: 'last30d', provider } } : {})
  };
}

// Durable briefs and specialist/business summaries carry only the fields they
// actually show. The dashboard retains the larger bounded detail projection.
export function compactOrderPeriod(period) {
  const source = period.importedOrderEvidence;
  if (!source) return period;
  const groups = source.groups.slice(0, 6);
  const clipped = source.presentation?.truncated || groups.length < source.groups.length;
  const metric = value => clipped ? { ...value, complete: false, completeCohortTotal: null } : value;
  return { ...period, numericCostCoverage: { ...period.numericCostCoverage, completeCohort: period.numericCostCoverage?.completeCohort === true && !clipped }, importedOrderEvidence: {
    schema: source.schema, period: source.period, providers: source.providers, counts: source.counts,
    sourcePeriods: source.sourcePeriods, provenance: source.provenance,
    completeness: { ...source.completeness, outputComplete: source.completeness.outputComplete && !clipped, retainedCohortComplete: source.completeness.retainedCohortComplete && !clipped },
    groups: groups.map(group => ({ ...group, recordedAmounts: { netTotal: metric(group.recordedAmounts.netTotal), refunds: metric(group.recordedAmounts.refunds) },
      costNumbers: { ...group.costNumbers, completeCohort: group.costNumbers.completeCohort && !clipped, coveredNetTotal: metric(group.costNumbers.coveredNetTotal), netTotalCoverage: clipped ? null : group.costNumbers.netTotalCoverage } })),
    presentation: { groupLimit: 6, groupsAvailable: source.presentation?.groupsAvailable ?? source.groups.length, groupsReturned: groups.length, truncated: Boolean(clipped) }
  } };
}

export function hasRecordedRefund(row) {
  // A legacy refund field can be a derived total difference for any provider.
  // Only recorded status supports this review cue; neither proves a payment.
  return ['PARTIALLY_REFUNDED', 'REFUNDED'].includes(row.financialStatus);
}

export function editorOrderRecord(order) {
  const text = (value, limit = 256) => typeof value === 'string' ? value.slice(0, limit) : null;
  const numeric = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value
    : typeof value === 'string' && value.length <= 33 && /^[+-]?(?:\d+(?:\.\d{1,6})?|\.\d{1,6})$/.test(value) ? value : null;
  const textFields = ['id', 'externalId', 'provider', 'name', 'createdAt', 'financialStatus', 'fulfillmentStatus', 'cancelledAt', 'currency', 'costUpdatedAt'];
  const numericFields = ['total', 'currentTotal', 'tax', 'currentTax', 'refunds', 'discounts', 'shippingCharged', 'actualShippingCost', 'paymentFees', 'channelFees', 'advertisingCost', 'otherVariableCosts'];
  return { ...Object.fromEntries(textFields.filter(field => Object.hasOwn(order, field)).map(field => [field, text(order[field])])),
    ...Object.fromEntries(numericFields.filter(field => Object.hasOwn(order, field)).map(field => [field, numeric(order[field])])),
    lineItems: (Array.isArray(order.lineItems) ? order.lineItems : []).slice(0, 100).filter(line => line && typeof line === 'object' && !Array.isArray(line))
      .map(line => ({ ...Object.fromEntries(['id', 'sku', 'name', 'title'].filter(field => Object.hasOwn(line, field)).map(field => [field, text(line[field])])),
        ...Object.fromEntries(['quantity', 'gross', 'net'].filter(field => Object.hasOwn(line, field)).map(field => [field, numeric(line[field])])) })) };
}

export function recordedOrderNarrative(period, label = 'Period') {
  const evidence = period.importedOrderEvidence;
  if (!evidence) return `${label}: recorded order evidence ${period.reason === 'empty_utc_interval' ? 'has an empty UTC interval' : 'is unavailable'}. Business revenue and profit are unavailable; source period unverified.`;
  const counts = evidence.counts;
  const partial = !evidence.completeness.retainedCohortComplete || evidence.presentation?.truncated;
  const scope = `${counts.scannedOrders} of ${counts.availableOrders ?? 'unknown'} retained snapshot rows scanned; ${counts.conflictingIdentities} conflicting identities excluded; eligibility ${evidence.completeness.eligibilityResolved ? 'resolved' : 'unresolved'}; ${partial ? 'partial scanned cohort or clipped output' : 'retained cohort only'}.`;
  const groups = evidence.groups.slice(0, 6).map(group => {
    const metric = group.recordedAmounts.netTotal;
    return `${group.provider} / ${group.currency || 'unknown currency'} (recorded code unverified) / ${group.financialStatus}${group.cancelled ? ' / cancelled' : ''}: ${metric.knownSubtotal ?? 'unavailable'} recorded net subtotal, ${metric.knownCount} known / ${metric.unknownCount} unknown`;
  });
  return `${label}: ${period.orders ?? 'unknown'} retained recorded orders; ${scope} ${groups.join('; ') || 'No retained records in this interval.'}${evidence.groups.length > 6 ? ' More cohorts are in the evidence detail.' : ''} Source period unverified; these subtotals are not business revenue, collected cash or profit.`;
}

export function orderFinancialView(inspection, row = null) {
  let importedOrderEvidence = null;
  if (row && inspection.evidence) {
    const source = inspection.evidence;
    const group = source.groups.find(item => item.provider === row.provider && item.currency === row.currency && item.financialStatus === row.financialStatus && item.cancelled === row.cancelled);
    if (group) importedOrderEvidence = {
      schema: source.schema, period: source.period, providers: [row.provider], completeness: source.completeness, scope: 'one retained order; completeness describes the bounded source inspection', provenance: { ...LEGACY_ORDER_FIELD_PROVENANCE, amounts: 'normalized recorded fields', currency: 'unverified recorded code' },
      sourcePeriods: source.sourcePeriods.filter(item => item.provider === row.provider),
      groups: [{ ...group, orders: 1,
        recordedAmounts: Object.fromEntries(Object.entries(row.recordedAmounts).map(([key, value]) => [key, { knownCount: value === null ? 0 : 1, unknownCount: value === null ? 1 : 0, knownSubtotal: row.currency ? value : null, completeCohortTotal: source.completeness.retainedCohortComplete && row.currency ? value : null, complete: Boolean(source.completeness.retainedCohortComplete && row.currency && value !== null) }])),
        costNumbers: { completeOrders: row.costNumbersComplete ? 1 : 0, incompleteOrders: row.costNumbersComplete ? 0 : 1, orderCoverage: { numerator: row.costNumbersComplete ? 1 : 0, denominator: 1 }, basis: 'numeric_availability_only_not_historical_financial_qualification' }
      }]
    };
  }
  return { complete: false, basis: 'unqualified_normalized_order_evidence', currency: row?.currency ?? null,
    grossRevenue: null, netRevenue: null, tax: null, refunds: null, discounts: null, shippingCharged: null,
    totalVariableCost: null, grossProfit: null, contribution: null, margin: null, collectedCash: null,
    breakdown: {}, missingFields: [FINANCIAL_QUALIFICATION_REASON], importedOrderEvidence };
}

// Advertising inputs lack a trusted currency/attribution contract. The editor
// remains available; no aggregation or subtraction can qualify these records.
export function unqualifiedAdvertising(records = []) {
  return { spend: null, attributableRevenue: null, roas: null, coverage: Array.isArray(records) ? records.length : null, status: 'unavailable', basis: 'recorded_costs_currency_and_attribution_unverified' };
}
