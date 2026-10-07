import crypto from 'node:crypto';
import { inspectImportedOrderEvidence } from './imported-order-evidence.mjs';
import { evidenceInWorkspace } from './business-evidence-scope.mjs';

const DAY = 86400000;
const clean = (value, max = 240) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const rounded = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null;
const nowIso = now => (now instanceof Date ? now : new Date(now || Date.now())).toISOString();

function safeDate(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

// The history window is explicit and half-open. These are recorded cohort
// diagnostics; retained imports cannot establish a complete customer lifetime.
const HISTORY_START = '1970-01-01T00:00:00Z';
const ORDER_PROVIDERS = ['shopify', 'ebay', 'meta', 'tiktok_shop', 'pinterest', 'google_youtube', 'whatsapp_business', 'amazon'];
const RECORDED_PURCHASE_STATUSES = new Set(['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED']);
const TOUCH_KINDS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'referrer', 'landing_page', 'source', 'campaign']);
const ANALYTIC_LIMITS = Object.freeze({ advertisingRows: 2000, attributionTouches: 2000, basketPairs: 50, customerRows: 100, attributionRows: 100, sourceGroups: 100, touchesPerOrder: 16 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function scoped(record, workspaceId, depth = 0) {
  if (depth > 4 || !evidenceInWorkspace(record, workspaceId)) return false;
  return ['workspace', 'tenant'].every(key => !Object.hasOwn(record, key) || !object(record[key]) || scoped(record[key], workspaceId, depth + 1));
}

function financialQualification() {
  return { qualifiedOrders: 0, revenue: null, contribution: null, profitCoverage: null,
    reason: 'no_trusted_source_period_currency_tax_or_historical_cost_contract' };
}

function importedHistory(state, now) {
  const workspaceId = identifier(state?.workspace?.id);
  let result;
  try {
    const endAt = now instanceof Date && Number.isFinite(now.getTime()) ? now.toISOString() : null;
    result = inspectImportedOrderEvidence(state, { workspaceId, period: { startAt: HISTORY_START, endAt }, providers: ORDER_PROVIDERS });
  } catch (error) {
    if (!['WORKSPACE_REQUIRED', 'WORKSPACE_MISMATCH', 'ORDER_PERIOD_INVALID'].includes(error.code)) throw error;
    return { evidence: null, rows: [], coverage: { status: 'unavailable', reason: error.code,
      sourcePeriod: 'unverified', financialQualification: financialQualification(),
      labels: ['source_period_unverified', 'financial_qualification_missing', 'recorded_cohort_unavailable'] } };
  }
  const { evidence } = result;
  return { ...result, coverage: {
    status: !evidence.completeness.collectionAvailable ? 'unavailable' : evidence.completeness.retainedCohortComplete ? 'recorded_cohort' : 'partial_recorded_cohort',
    basis: 'retained_imported_orders', period: evidence.period, providers: evidence.providers,
    sourcePeriod: 'unverified', sourceCounts: evidence.counts, completeness: evidence.completeness,
    sourcePeriods: evidence.sourcePeriods, limits: evidence.limits,
    financialQualification: financialQualification(),
    labels: ['source_period_unverified', 'financial_qualification_missing', ...(!evidence.completeness.retainedCohortComplete ? ['recorded_cohort_incomplete'] : [])]
  } };
}

function purchaseRows(history) {
  return history.rows.filter(row => !row.cancelled && RECORDED_PURCHASE_STATUSES.has(row.financialStatus));
}

function customerKey(order) {
  // Customer IDs and email hashes have no cross-provider identity contract.
  const emailHash = identifier(order.customerEmailHash);
  if (emailHash) return order.provider + ':' + hash(['email_hash', emailHash]);
  if (order.customerEmailHash !== null && order.customerEmailHash !== undefined) return null;
  for (const field of ['customerId', 'buyerId', 'buyerUsername']) {
    if (order[field] === null || order[field] === undefined) continue;
    const value = identifier(order[field]);
    return value ? order.provider + ':' + hash([field, value]) : null;
  }
  return null;
}

function customerSignature(order) {
  return JSON.stringify(['customerEmailHash', 'customerId', 'buyerId', 'buyerUsername'].map(field => [order[field] === null || order[field] === undefined ? 'absent' : identifier(order[field]) ? 'valid' : 'invalid', identifier(order[field])]));
}

function recordedText(value) {
  return typeof value === 'string' && value.length <= 200 && value.trim() ? value.trim() : null;
}

function orderSourceEvidence(order, workspaceId) {
  const touches = [];
  const add = (kind, value) => {
    const recorded = recordedText(value);
    if (recorded) touches.push({ kind, value: recorded, confidence: 'recorded-unverified', provenance: 'normalized_order_field' });
  };
  const attr = object(order.attribution) && scoped(order.attribution, workspaceId) ? order.attribution : {};
  add('utm_source', attr.utmSource || order.utmSource);
  add('utm_medium', attr.utmMedium || order.utmMedium);
  add('utm_campaign', attr.utmCampaign || order.utmCampaign);
  add('referrer', attr.referrer || order.referrer);
  add('landing_page', attr.landingPage || order.landingPage);
  add('source', attr.source || order.sourceName || order.source);
  add('campaign', attr.campaign || order.campaignName);
  return touches;
}

function sourceMetadataValid(order, workspaceId) {
  return order.attribution === undefined || order.attribution === null || (object(order.attribution) && scoped(order.attribution, workspaceId));
}

// The shared projection deliberately ignores customer/attribution payloads.
// Reconcile the bounded original copies before using these extra fields; never
// let an arbitrary first duplicate choose the favourable customer or campaign.
function consumerConflicts(state, history, signature) {
  const signatures = new Map(), conflicts = new Set();
  if (!history.evidence) return conflicts;
  for (const order of (Array.isArray(state.orders) ? state.orders : []).slice(0, history.evidence.counts.scannedOrders)) {
    if (!object(order) || !ORDER_PROVIDERS.includes(order.provider)) continue;
    const sourceId = identifier(Object.hasOwn(order, 'externalId') ? order.externalId : order.id);
    if (!sourceId) continue;
    const identityHash = hash([history.evidence.workspaceId, order.provider, sourceId]);
    const value = signature(order);
    if (signatures.has(identityHash) && signatures.get(identityHash) !== value) conflicts.add(identityHash);
    else signatures.set(identityHash, value);
  }
  return conflicts;
}

function consumerCoverage(history, conflicts = 0, extra = {}) {
  const coverage = { ...history.coverage, consumerConflictingIdentities: conflicts, ...extra };
  const capped = extra.touchesTruncated || extra.pairsTruncated || extra.detailRowsTruncated;
  const excluded = (extra.missingCustomerIdentityOrders || 0) + (extra.excludedSourceMetadataOrders || 0);
  coverage.consumerCohortComplete = history.coverage.status === 'recorded_cohort' && !conflicts && !capped && !excluded;
  if (excluded) {
    coverage.status = coverage.status === 'unavailable' ? 'unavailable' : 'partial_recorded_cohort';
    coverage.labels = [...coverage.labels, 'consumer_metadata_incomplete'];
  }
  if (capped) {
    coverage.status = coverage.status === 'unavailable' ? 'unavailable' : 'partial_recorded_cohort';
    coverage.labels = [...coverage.labels, 'analytic_output_truncated'];
  }
  if (conflicts) {
    coverage.status = coverage.status === 'unavailable' ? 'unavailable' : 'partial_recorded_cohort';
    coverage.labels = [...coverage.labels, 'consumer_metadata_conflicts'];
  }
  return coverage;
}

export function ensureRevenueEngine(state) {
  const current = state.revenueEngine && typeof state.revenueEngine === 'object' ? state.revenueEngine : {};
  state.revenueEngine = {
    // Imported attribution checks the enclosing collection scope. Normalizing
    // other engine arrays must never erase an explicit foreign tenant marker.
    ...Object.fromEntries(['workspaceId', 'workspace_id', 'tenantId', 'tenant_id', 'workspace', 'tenant'].filter(key => Object.hasOwn(current, key)).map(key => [key, current[key]])),
    intentEvents: Array.isArray(current.intentEvents) ? current.intentEvents : [],
    leads: Array.isArray(current.leads) ? current.leads : [],
    quotes: Array.isArray(current.quotes) ? current.quotes : [],
    experiments: Array.isArray(current.experiments) ? current.experiments : [],
    referrals: Array.isArray(current.referrals) ? current.referrals : [],
    loyaltyRules: Array.isArray(current.loyaltyRules) ? current.loyaltyRules : [],
    attributionTouches: Array.isArray(current.attributionTouches) ? current.attributionTouches : [],
    updatedAt: current.updatedAt || null
  };
  return state.revenueEngine;
}

export function deriveCustomerIntelligence(state, { now = new Date() } = {}) {
  const history = importedHistory(state, now);
  const conflicts = consumerConflicts(state, history, customerSignature);
  const groups = new Map();
  let missingCustomerIdentityOrders = 0;
  for (const row of purchaseRows(history)) {
    if (conflicts.has(row.identityHash)) continue;
    const { order, provider, createdAt } = row;
    const key = customerKey(order);
    if (!key) { missingCustomerIdentityOrders++; continue; }
    const at = Date.parse(createdAt);
    const customer = groups.get(key) || { id: key, orders: [], provider, products: new Map(), firstPurchaseAt: at, lastPurchaseAt: at };
    customer.orders.push(row);
    customer.firstPurchaseAt = Math.min(customer.firstPurchaseAt, at);
    customer.lastPurchaseAt = Math.max(customer.lastPurchaseAt, at);
    const skus = new Set((Array.isArray(order.lineItems) ? order.lineItems : []).map(line => identifier(line?.sku)).filter(Boolean));
    for (const sku of skus) customer.products.set(sku, (customer.products.get(sku) || 0) + 1);
    groups.set(key, customer);
  }

  const customers = [...groups.values()].map(row => {
    row.orders.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const intervals = row.orders.slice(1).map((order, index) => (Date.parse(order.createdAt) - Date.parse(row.orders[index].createdAt)) / DAY);
    const averageReorderDays = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : null;
    const daysSinceLastOrder = (now.getTime() - row.lastPurchaseAt) / DAY;
    const expectedNextOrderAt = averageReorderDays > 0 ? new Date(row.lastPurchaseAt + averageReorderDays * DAY).toISOString() : null;
    const favourite = [...row.products.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const repeat = row.orders.length > 1;
    const due = repeat && averageReorderDays > 0 && daysSinceLastOrder >= averageReorderDays * .9;
    const dormant = daysSinceLastOrder >= Math.max(60, (averageReorderDays || 45) * 1.75);
    const churnRisk = repeat && daysSinceLastOrder >= Math.max(45, (averageReorderDays || 30) * 1.35);
    return {
      id: row.id, provider: row.provider,
      privacyLabel: 'Customer ' + row.id.split(':').pop().slice(0, 8).toUpperCase(),
      orderCount: row.orders.length, revenue: null, contribution: null, profitCoverage: null, averageOrderValue: null,
      firstPurchaseAt: new Date(row.firstPurchaseAt).toISOString(), lastPurchaseAt: new Date(row.lastPurchaseAt).toISOString(),
      daysSinceLastOrder: rounded(daysSinceLastOrder, 1), averageReorderDays: averageReorderDays === null ? null : rounded(averageReorderDays, 1), expectedNextOrderAt,
      ltv30: null, ltv60: null, ltv90: null, ltv365: null,
      favouriteProduct: favourite ? { provider: row.provider, sku: favourite[0], name: favourite[0], recordedOrderCount: favourite[1], quantity: null, revenue: null, attribution: 'unverified_recorded_sku_only', refundsAllocated: false } : null,
      channels: [row.provider],
      segment: dormant ? 'dormant' : churnRisk ? 'churn-risk' : due ? 'reorder-due' : row.orders.length >= 3 ? 'loyal' : repeat ? 'repeat' : 'new',
      signals: { repeat, reorderDue: Boolean(due), dormant, churnRisk },
      basis: 'recorded_customer_cohort_heuristic', sourcePeriod: 'unverified', financialQualification: financialQualification(),
      financialStatusCohorts: [...RECORDED_PURCHASE_STATUSES].map(financialStatus => ({ financialStatus, orders: row.orders.filter(order => order.financialStatus === financialStatus).length }))
    };
  }).sort((a, b) => b.orderCount - a.orderCount || b.lastPurchaseAt.localeCompare(a.lastPurchaseAt) || a.id.localeCompare(b.id));

  const repeatCustomers = customers.filter(customer => customer.orderCount > 1).length;
  const available = history.coverage.status !== 'unavailable';
  const recommendations = [];
  for (const customer of customers) {
    if (customer.signals.reorderDue) recommendations.push({ type: 'reorder', customerId: customer.id, title: customer.privacyLabel + ' is near its observed reorder window', evidence: `${customer.orderCount} recorded orders; average interval ${customer.averageReorderDays} days; last recorded order ${customer.daysSinceLastOrder} days ago. Retained history may be incomplete.`, action: 'Review the recorded pattern before preparing an account follow-up.', approvalRequired: true });
    if (customer.signals.churnRisk) recommendations.push({ type: 'retention', customerId: customer.id, title: customer.privacyLabel + ' has a possible retention gap', evidence: `Last recorded order ${customer.daysSinceLastOrder} days ago versus an observed ${customer.averageReorderDays ?? 'unknown'}-day repeat cycle. Retained history may be incomplete.`, action: 'Review the customer history before preparing a win-back message.', approvalRequired: true });
  }
  return {
    summary: {
      customers: available ? customers.length : null, repeatCustomers: available ? repeatCustomers : null,
      repeatRate: customers.length ? rounded(repeatCustomers / customers.length * 100, 1) : null,
      totalRevenue: null, knownContribution: null, profitCoverage: null, averageOrderValue: null,
      reorderDue: available ? customers.filter(customer => customer.signals.reorderDue).length : null,
      churnRisk: available ? customers.filter(customer => customer.signals.churnRisk).length : null,
      dormant: available ? customers.filter(customer => customer.signals.dormant).length : null
    }, customers: customers.slice(0, ANALYTIC_LIMITS.customerRows), recommendations: recommendations.slice(0, 100),
    coverage: consumerCoverage(history, conflicts.size, {
      identity: 'provider-scoped recorded customer identifiers; no cross-provider customer matching',
      historicalWindow: 'Retained imports from 1970-01-01 through the exclusive observation time; no complete customer lifetime or source-period coverage is established.',
      cohort: 'noncancelled recorded PAID, PARTIALLY_REFUNDED and REFUNDED orders; refunds do not establish retained units',
      missingCustomerIdentityOrders, namesAndEmailsExposed: false, refundsAllocated: false,
      customersAvailable: customers.length, customersReturned: Math.min(customers.length, ANALYTIC_LIMITS.customerRows), customerLimit: ANALYTIC_LIMITS.customerRows,
      detailRowsTruncated: customers.length > ANALYTIC_LIMITS.customerRows, aggregatesUseFullBoundedCohort: true
    })
  };
}

export function deriveAttribution(state, { now = new Date() } = {}) {
  const history = importedHistory(state, now), workspaceId = history.evidence?.workspaceId;
  const conflicts = consumerConflicts(state, history, order => JSON.stringify([identifier(order.id), sourceMetadataValid(order, workspaceId), orderSourceEvidence(order, workspaceId)]));
  const localIds = new Map();
  for (const order of (Array.isArray(state.orders) ? state.orders : []).slice(0, history.evidence?.counts.scannedOrders || 0)) {
    const localId = identifier(order?.id), sourceId = object(order) && identifier(Object.hasOwn(order, 'externalId') ? order.externalId : order.id);
    if (!localId || !sourceId || !ORDER_PROVIDERS.includes(order.provider)) continue;
    const key = JSON.stringify([order.provider, localId]);
    const identities = localIds.get(key) || new Set();
    identities.add(sourceId); localIds.set(key, identities);
  }
  const rawTouches = Array.isArray(state.revenueEngine?.attributionTouches) ? state.revenueEngine.attributionTouches : [];
  const touchScopeValid = scoped(state.revenueEngine || {}, workspaceId) && history.evidence?.completeness.truncated.orders === false;
  let unscopedTouchRows = 0;
  const touchesByOrder = new Map();
  for (const touch of rawTouches.slice(0, ANALYTIC_LIMITS.attributionTouches)) {
    if (!touchScopeValid || !scoped(touch, workspaceId) || !ORDER_PROVIDERS.includes(touch.provider) || !identifier(touch.orderId) || !TOUCH_KINDS.has(touch.kind) || !recordedText(touch.value)) { unscopedTouchRows++; continue; }
    const key = JSON.stringify([touch.provider, touch.orderId]);
    if (localIds.get(key)?.size !== 1) { unscopedTouchRows++; continue; }
    const touches = touchesByOrder.get(key) || [];
    touches.push({ kind: touch.kind, value: recordedText(touch.value), confidence: 'recorded-unverified', provider: touch.provider, provenance: 'provider_scoped_recorded_touch' });
    touchesByOrder.set(key, touches);
  }
  const selectedRows = purchaseRows(history);
  const excludedSourceMetadataOrders = selectedRows.filter(row => !sourceMetadataValid(row.order, workspaceId)).length;
  const rows = selectedRows.filter(row => !conflicts.has(row.identityHash) && sourceMetadataValid(row.order, workspaceId)).map(row => {
    const { order, provider } = row;
    const touches = [...orderSourceEvidence(order, workspaceId), ...(touchesByOrder.get(JSON.stringify([provider, order.id])) || [])];
    const sourceTouch = touches.find(touch => touch.kind === 'utm_source') || touches.find(touch => touch.kind === 'source');
    return { orderId: identifier(order.id), identityHash: row.identityHash, pointer: row.pointer, provider, channel: provider,
      source: sourceTouch?.value || null, touches: touches.slice(0, ANALYTIC_LIMITS.touchesPerOrder),
      touchEvidence: { available: touches.length, returned: Math.min(touches.length, ANALYTIC_LIMITS.touchesPerOrder), truncated: touches.length > ANALYTIC_LIMITS.touchesPerOrder }, revenue: null, contribution: null,
      confidence: sourceTouch ? 'recorded-source-unverified' : 'channel-only', attribution: 'unverified_recorded_source_only', financialQualification: financialQualification() };
  });
  const sourced = rows.filter(row => row.source), bySource = new Map();
  for (const row of sourced) {
    const key = JSON.stringify([row.provider, row.source]);
    const item = bySource.get(key) || { provider: row.provider, source: row.source, orders: 0, revenue: null, contribution: null, profitCoveredOrders: null, attribution: 'unverified_recorded_source_only' };
    item.orders++; bySource.set(key, item);
  }
  return {
    orders: rows.slice(0, ANALYTIC_LIMITS.attributionRows), bySource: [...bySource.values()].sort((a, b) => b.orders - a.orders || a.provider.localeCompare(b.provider) || a.source.localeCompare(b.source)).slice(0, ANALYTIC_LIMITS.sourceGroups),
    coverage: consumerCoverage(history, conflicts.size, {
      orders: history.coverage.status === 'unavailable' ? null : rows.length,
      sourceAttributedOrders: null, sourceCoveragePercent: null,
      recordedSourceOrders: history.coverage.status === 'unavailable' ? null : sourced.length,
      recordedSourceCoveragePercent: rows.length ? rounded(sourced.length / rows.length * 100, 1) : null,
      attributionStatus: 'unverified', detailRowsTruncated: rows.length > ANALYTIC_LIMITS.attributionRows || bySource.size > ANALYTIC_LIMITS.sourceGroups || rows.some(row => row.touchEvidence.truncated),
      orderRowsAvailable: rows.length, orderRowsReturned: Math.min(rows.length, ANALYTIC_LIMITS.attributionRows), orderRowLimit: ANALYTIC_LIMITS.attributionRows,
      sourceGroupsAvailable: bySource.size, sourceGroupsReturned: Math.min(bySource.size, ANALYTIC_LIMITS.sourceGroups), sourceGroupLimit: ANALYTIC_LIMITS.sourceGroups, aggregatesUseFullBoundedCohort: true,
      unscopedTouchRows, excludedSourceMetadataOrders, availableTouchRows: rawTouches.length,
      cohort: 'noncancelled recorded PAID, PARTIALLY_REFUNDED and REFUNDED orders',
      scannedTouchRows: Math.min(rawTouches.length, ANALYTIC_LIMITS.attributionTouches), touchesTruncated: rawTouches.length > ANALYTIC_LIMITS.attributionTouches,
      note: 'Source labels are recorded, unverified observations. Touch joins require provider and an unambiguous local order ID. Source attribution, campaign sales and financial totals remain unavailable.'
    })
  };
}

export function deriveBasketIntelligence(state, { now = new Date() } = {}) {
  const history = importedHistory(state, now), pairCounts = new Map(), skuStats = new Map();
  const rows = purchaseRows(history);
  for (const { order, provider } of rows) {
    const unique = [...new Set((Array.isArray(order.lineItems) ? order.lineItems : []).map(line => identifier(line?.sku)).filter(Boolean))].sort();
    for (const sku of unique) {
      const key = JSON.stringify([provider, sku]);
      skuStats.set(key, (skuStats.get(key) || 0) + 1);
    }
    for (let i = 0; i < unique.length; i++) for (let j = i + 1; j < unique.length; j++) {
      const key = JSON.stringify([provider, unique[i], unique[j]]);
      pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
    }
  }
  const pairs = [...pairCounts.entries()].map(([key, count]) => {
    const [provider, a, b] = JSON.parse(key);
    const base = Math.min(skuStats.get(JSON.stringify([provider, a])), skuStats.get(JSON.stringify([provider, b])));
    return { provider, a, b, ordersTogether: count, affinity: rounded(count / base * 100, 1), attribution: 'unverified_recorded_sku_only', refundsAllocated: false };
  }).sort((a, b) => b.ordersTogether - a.ordersTogether || b.affinity - a.affinity || a.provider.localeCompare(b.provider) || a.a.localeCompare(b.a) || a.b.localeCompare(b.b));
  return {
    pairs: pairs.slice(0, ANALYTIC_LIMITS.basketPairs),
    recommendations: pairs.filter(pair => pair.ordersTogether >= 2).slice(0, 20).map(pair => ({ type: 'cross-sell', provider: pair.provider, title: `${pair.a} + ${pair.b}`, evidence: `Recorded together in ${pair.ordersTogether} retained ${pair.provider} orders; ${pair.affinity}% co-occurrence against the less-frequent recorded SKU. SKU-to-product attribution is unverified and refunds are unallocated.`, approvalRequired: true })),
    coverage: consumerCoverage(history, 0, { orders: history.coverage.status === 'unavailable' ? null : rows.length, attribution: 'unverified_recorded_sku_only', refundsAllocated: false,
      basis: 'provider_scoped_recorded_sku_cooccurrence', pairsAvailable: pairs.length, pairsTruncated: pairs.length > ANALYTIC_LIMITS.basketPairs,
      cohort: 'noncancelled recorded PAID, PARTIALLY_REFUNDED and REFUNDED orders; recorded lines are not verified kept purchases' })
  };
}

export function deriveIntentRecovery(state, { now = new Date() } = {}) {
  const events = ensureRevenueEngine(state).intentEvents;
  const sessions = new Map();
  for (const event of events) {
    const key=clean(event.sessionId||event.customerId,160); if(!key) continue;
    const row=sessions.get(key)||{id:key,events:[],lastAt:null,checkoutValue:null,customerId:event.customerId||null};
    row.events.push(event); const at=safeDate(event.createdAt); if(at && (!row.lastAt||at>row.lastAt)) row.lastAt=at;
    if(event.type==='checkout_started' && Number.isFinite(Number(event.value))) row.checkoutValue=Number(event.value);
    sessions.set(key,row);
  }
  const recoveries=[];
  for(const row of sessions.values()){
    const types=new Set(row.events.map(e=>e.type)); const age=row.lastAt?(now.getTime()-row.lastAt)/DAY:null;
    if(types.has('checkout_started')&&!types.has('order_completed')&&age!==null&&age>=.04&&age<=14) recoveries.push({sessionId:row.id,customerId:row.customerId,value:rounded(row.checkoutValue),ageDays:rounded(age,1),stage:'checkout-abandoned',recommendedAction:row.checkoutValue>=250?'sales-follow-up':'margin-safe-reminder',approvalRequired:true});
    else if(types.has('add_to_cart')&&!types.has('checkout_started')&&!types.has('order_completed')&&age!==null&&age<=7) recoveries.push({sessionId:row.id,customerId:row.customerId,value:null,ageDays:rounded(age,1),stage:'cart-abandoned',recommendedAction:'product-reminder',approvalRequired:true});
  }
  return {events:events.length,recoveries:recoveries.sort((a,b)=>(b.value||0)-(a.value||0)).slice(0,100)};
}

export function deriveSalesPipeline(state, { now = new Date() } = {}) {
  const engine=ensureRevenueEngine(state);
  const quotes=engine.quotes.map(q=>{
    const value=(q.lines||[]).reduce((s,l)=>s+(Number(l.quantity)||0)*(Number(l.unitPrice)||0),0);
    const expectedContribution=(q.lines||[]).every(l=>Number.isFinite(Number(l.unitContribution))) ? (q.lines||[]).reduce((s,l)=>s+(Number(l.quantity)||0)*Number(l.unitContribution),0) : null;
    const overdue=q.followUpAt&&safeDate(q.followUpAt)<now.getTime()&&!['won','lost','expired'].includes(q.status);
    return {...q,value:rounded(value),expectedContribution:rounded(expectedContribution),overdue};
  });
  const open=quotes.filter(q=>!['won','lost','expired'].includes(q.status));
  return {
    leads:engine.leads,
    quotes,
    summary:{
      leads:engine.leads.length,
      openQuotes:open.length,
      openPipeline:rounded(open.reduce((s,q)=>s+q.value,0)),
      overdueFollowUps:open.filter(q=>q.overdue).length,
      won:quotes.filter(q=>q.status==='won').length,
      lost:quotes.filter(q=>q.status==='lost').length,
      conversionPercent:quotes.filter(q=>['won','lost'].includes(q.status)).length ? rounded(quotes.filter(q=>q.status==='won').length/quotes.filter(q=>['won','lost'].includes(q.status)).length*100,1) : null
    }
  };
}

export function deriveAdvertisingIntelligence(state) {
  const workspaceId = identifier(state?.workspace?.id);
  const available = scoped(state, workspaceId) && scoped(state.workspace, workspaceId) && Array.isArray(state.advertisingCosts);
  const recorded = available ? state.advertisingCosts : [];
  let excludedScopeRows = 0;
  const rows = [];
  for (const [index, item] of recorded.slice(0, ANALYTIC_LIMITS.advertisingRows).entries()) {
    if (!scoped(item, workspaceId)) { excludedScopeRows++; continue; }
    // Preserve the source spelling and explicit unknowns. Even a known zero does
    // not qualify currency, campaign attribution or an aggregate ROAS.
    rows.push({ ...item, roas: null, attributionStatus: 'unverified',
      provenance: { collection: 'state.advertisingCosts', pointer: `/advertisingCosts/${index}`, currency: 'recorded_currency_unverified', amounts: 'recorded_fields_not_qualified_financial_totals', attribution: 'no_trusted_attribution_contract' } });
  }
  return {
    summary: { spend: null, attributedRevenue: null, roas: null, attributionCoverage: null }, rows,
    coverage: { status: !available ? 'unavailable' : excludedScopeRows || recorded.length > ANALYTIC_LIMITS.advertisingRows ? 'partial_recorded_rows' : 'recorded_rows', availableRows: available ? recorded.length : null,
      scannedRows: Math.min(recorded.length, ANALYTIC_LIMITS.advertisingRows), retainedRows: rows.length, excludedScopeRows,
      truncated: recorded.length > ANALYTIC_LIMITS.advertisingRows, sourcePeriod: 'unverified',
      labels: ['source_period_unverified', 'financial_qualification_missing', 'attribution_unverified', ...(recorded.length > ANALYTIC_LIMITS.advertisingRows ? ['analytic_output_truncated'] : []), ...(excludedScopeRows ? ['recorded_rows_incomplete'] : [])],
      financialQualification: { reason: 'no_trusted_advertising_currency_or_attribution_contract', spend: null, attributedRevenue: null, roas: null } }
  };
}

export function deriveGrowthPlan(state, { targetProfit = null } = {}) {
  const customers=deriveCustomerIntelligence(state), baskets=deriveBasketIntelligence(state), attribution=deriveAttribution(state), intent=deriveIntentRecovery(state), pipeline=deriveSalesPipeline(state);
  const opportunities=[];
  if(customers.summary.reorderDue) opportunities.push({kind:'retention',title:`Follow up ${customers.summary.reorderDue} customers near a reorder window`,evidence:`${customers.summary.reorderDue} customer records have repeat history and are at or beyond 90% of their observed reorder interval.`,estimatedImpact:null,confidence:'medium',risk:'Customer contact requires appropriate consent and review.',approvalRequired:true});
  if(intent.recoveries.length) opportunities.push({kind:'conversion',title:`Review ${intent.recoveries.length} recoverable buying-intent sessions`,evidence:'Recorded cart/checkout events have no matching completion event in the configured recovery window.',estimatedImpact:null,confidence:'medium',risk:'Do not send discounts below margin floor; outbound contact remains approval-controlled.',approvalRequired:true});
  if(baskets.recommendations.length) opportunities.push({kind:'aov',title:'Test evidence-backed cross-sell bundles',evidence:baskets.recommendations[0].evidence,estimatedImpact:null,confidence:'medium',risk:'Association does not prove uplift; use controlled experiments.',approvalRequired:true});
  if(pipeline.summary.overdueFollowUps) opportunities.push({kind:'b2b',title:`Resolve ${pipeline.summary.overdueFollowUps} overdue B2B follow-ups`,evidence:`Open pipeline value is £${Number(pipeline.summary.openPipeline||0).toFixed(2)}.`,estimatedImpact:null,confidence:'high',risk:'Quote terms and customer-facing messages need owner review.',approvalRequired:true});
  if(attribution.coverage.orders > 0) opportunities.push({kind:'attribution',title:'Verify recorded source attribution',evidence:`${attribution.coverage.recordedSourceOrders} of ${attribution.coverage.orders} assessed retained orders have recorded source labels; attribution and source-period coverage remain unverified.`,estimatedImpact:null,confidence:'low',risk:'Verify provider, campaign and currency evidence before optimising spend.',approvalRequired:false});
  return {targetProfit: Number.isFinite(Number(targetProfit))?Number(targetProfit):null, opportunities, generatedAt:nowIso(), note:'Estimated impact remains null where Runvara lacks defensible uplift evidence. The plan prioritises measurable actions without inventing financial certainty.'};
}


export function createOpportunityExperiment(state, opportunity, body = {}, actor = 'system') {
  if (!opportunity?.id) throw Object.assign(new Error('Opportunity is required'), { status:400, code:'VALIDATION_FAILED' });
  const experiment = createExperiment(state, {
    kind: body.kind || opportunity.kind,
    title: body.title || ('Test: ' + opportunity.title),
    hypothesis: body.hypothesis || opportunity.recommendedNextStep || opportunity.title,
    opportunityId: opportunity.id,
    metric: body.metric || 'incremental_contribution',
    baseline: body.baseline,
    target: body.target
  }, actor);
  opportunity.experimentId = experiment.id;
  opportunity.experimentStatus = 'draft';
  opportunity.updatedAt = nowIso();
  return experiment;
}

export function createExperiment(state, body = {}, actor = 'system') {
  const engine=ensureRevenueEngine(state), now=nowIso();
  const kind=clean(body.kind || body.type,80).toLowerCase();
  const title=clean(body.title,180);
  if(!kind || !title) throw Object.assign(new Error('Experiment kind and title are required'),{status:400,code:'VALIDATION_FAILED'});
  const experiment={
    id:'experiment_'+crypto.randomUUID(),
    kind,
    title,
    hypothesis:clean(body.hypothesis,600),
    status:'draft',
    opportunityId:clean(body.opportunityId,180)||null,
    approvalId:clean(body.approvalId,180)||null,
    metric:clean(body.metric || 'incremental_contribution',120),
    baseline:body.baseline && typeof body.baseline==='object' ? body.baseline : null,
    target:body.target && typeof body.target==='object' ? body.target : null,
    impact:null,
    createdAt:now,
    updatedAt:now,
    createdBy:actor,
    externalWrites:false
  };
  engine.experiments.unshift(experiment);
  engine.updatedAt=now;
  return experiment;
}

export function recordExperimentMeasurement(state, experimentId, body = {}, actor = 'system') {
  const engine=ensureRevenueEngine(state);
  const experiment=engine.experiments.find(item=>item.id===experimentId);
  if(!experiment) throw Object.assign(new Error('Experiment not found'),{status:404,code:'EXPERIMENT_NOT_FOUND'});
  if(!['draft','running','completed','measured'].includes(String(experiment.status||'').toLowerCase())) throw Object.assign(new Error('Experiment cannot be measured in its current state'),{status:409,code:'EXPERIMENT_STATE_INVALID'});
  const method=clean(body.method,160);
  if(!method) throw Object.assign(new Error('Measurement method is required'),{status:400,code:'VALIDATION_FAILED'});
  const numbers=['incrementalRevenue','incrementalContribution','contributionProtected','costAvoided','minutesSaved'];
  const impact={verified:false,status:'measured',method,measuredAt:nowIso(),recordedBy:actor};
  let hasMetric=false;
  for(const field of numbers) {
    if(body[field]===null || body[field]===undefined || body[field]==='') continue;
    const value=Number(body[field]);
    if(!Number.isFinite(value)) throw Object.assign(new Error('Measurement values must be numeric'),{status:400,code:'VALIDATION_FAILED'});
    impact[field]=rounded(value);
    hasMetric=true;
  }
  if(!hasMetric) throw Object.assign(new Error('At least one measured impact value is required'),{status:400,code:'VALIDATION_FAILED'});
  experiment.impact=impact;
  experiment.status='measured';
  experiment.updatedAt=impact.measuredAt;
  engine.updatedAt=impact.measuredAt;
  return experiment;
}

function experimentDecisionPosture(impact = {}) {
  const contribution = ['incrementalContribution','contributionProtected','costAvoided']
    .reduce((sum, field) => sum + (Number.isFinite(Number(impact[field])) ? Number(impact[field]) : 0), 0);
  if (contribution > 0) return { status:'ready-for-owner-review', verifiedContributionValue:rounded(contribution), reason:'Verified realised contribution evidence is positive.' };
  if (contribution < 0) return { status:'deprioritise', verifiedContributionValue:rounded(contribution), reason:'Verified realised contribution evidence is negative.' };
  return { status:'needs-more-evidence', verifiedContributionValue:0, reason:'No positive verified contribution evidence has been established.' };
}

export function verifyExperimentMeasurement(state, experimentId, body = {}, actor = 'system') {
  const engine=ensureRevenueEngine(state);
  const experiment=engine.experiments.find(item=>item.id===experimentId);
  if(!experiment) throw Object.assign(new Error('Experiment not found'),{status:404,code:'EXPERIMENT_NOT_FOUND'});
  if(!experiment.impact || String(experiment.status).toLowerCase()!=='measured') throw Object.assign(new Error('Experiment must have a measured result before verification'),{status:409,code:'EXPERIMENT_NOT_MEASURED'});
  const note=clean(body.note,500);
  if(!note) throw Object.assign(new Error('Verification note is required'),{status:400,code:'VALIDATION_FAILED'});
  const now=nowIso();
  experiment.impact={...experiment.impact,verified:true,status:'verified',verifiedAt:now,verifiedBy:actor,verificationNote:note};
  experiment.status='completed';
  experiment.completedAt=now;
  experiment.updatedAt=now;
  const posture=experimentDecisionPosture(experiment.impact);
  experiment.decisionPosture=posture;
  if (experiment.opportunityId) {
    const opportunity=(state.opportunities || []).find(item=>item.id===experiment.opportunityId);
    if (opportunity) {
      opportunity.experimentId=experiment.id;
      opportunity.experimentStatus='completed';
      opportunity.evidenceDecision=posture.status;
      opportunity.verifiedContributionValue=posture.verifiedContributionValue;
      opportunity.evidenceDecisionReason=posture.reason;
      opportunity.evidenceUpdatedAt=now;
    }
  }
  engine.updatedAt=now;
  return experiment;
}

export function revenueEngineSnapshot(state) {
  ensureRevenueEngine(state);
  return {
    customers: deriveCustomerIntelligence(state),
    attribution: deriveAttribution(state),
    baskets: deriveBasketIntelligence(state),
    intent: deriveIntentRecovery(state),
    sales: deriveSalesPipeline(state),
    advertising: deriveAdvertisingIntelligence(state),
    loyalty: { referrals: state.revenueEngine.referrals, rules: state.revenueEngine.loyaltyRules },
    experiments: state.revenueEngine.experiments,
    growthPlan: deriveGrowthPlan(state)
  };
}

export function createLead(state, body = {}, actor = 'system') {
  const engine=ensureRevenueEngine(state), now=nowIso();
  const lead={id:'lead_'+crypto.randomUUID(),company:clean(body.company,160),contact:clean(body.contact,160),source:clean(body.source,120),stage:['new','qualified','quote','won','lost'].includes(body.stage)?body.stage:'new',notes:clean(body.notes,1200),createdAt:now,updatedAt:now,createdBy:actor};
  if(!lead.company) throw Object.assign(new Error('Company is required'),{status:400,code:'VALIDATION_FAILED'});
  engine.leads.unshift(lead); engine.updatedAt=now; return lead;
}

export function createQuote(state, body = {}, actor = 'system') {
  const engine=ensureRevenueEngine(state), now=nowIso();
  const lines=Array.isArray(body.lines)?body.lines.slice(0,100).map(line=>({sku:clean(line.sku,160),description:clean(line.description||line.sku,220),quantity:Math.max(0,Number(line.quantity)||0),unitPrice:Math.max(0,Number(line.unitPrice)||0),unitContribution:Number.isFinite(Number(line.unitContribution))?Number(line.unitContribution):null})).filter(line=>line.quantity>0):[];
  if(!lines.length) throw Object.assign(new Error('At least one quote line is required'),{status:400,code:'VALIDATION_FAILED'});
  const quote={id:'quote_'+crypto.randomUUID(),leadId:clean(body.leadId,160)||null,customerId:clean(body.customerId,200)||null,status:'draft',lines,expiresAt:body.expiresAt&&safeDate(body.expiresAt)?new Date(body.expiresAt).toISOString():null,followUpAt:body.followUpAt&&safeDate(body.followUpAt)?new Date(body.followUpAt).toISOString():null,notes:clean(body.notes,1200),createdAt:now,updatedAt:now,createdBy:actor,customerFacing:false};
  engine.quotes.unshift(quote); engine.updatedAt=now; return quote;
}

export function recordIntentEvent(state, body = {}, actor = 'system') {
  const engine=ensureRevenueEngine(state);
  const type=clean(body.type,60);
  if(!['product_viewed','add_to_cart','checkout_started','order_completed'].includes(type)) throw Object.assign(new Error('Unsupported intent event'),{status:400,code:'VALIDATION_FAILED'});
  const event={id:'intent_'+crypto.randomUUID(),type,sessionId:clean(body.sessionId,160),customerId:clean(body.customerId,200)||null,sku:clean(body.sku,160)||null,value:Number.isFinite(Number(body.value))?Math.max(0,Number(body.value)):null,createdAt:body.createdAt&&safeDate(body.createdAt)?new Date(body.createdAt).toISOString():nowIso(),source:clean(body.source,100)||'recorded',recordedBy:actor};
  if(!event.sessionId) throw Object.assign(new Error('sessionId is required'),{status:400,code:'VALIDATION_FAILED'});
  engine.intentEvents.unshift(event); engine.intentEvents=engine.intentEvents.slice(0,10000); engine.updatedAt=nowIso(); return event;
}

export function recordAttributionTouch(state, body = {}, actor = 'system') {
  const engine=ensureRevenueEngine(state);
  const kind=clean(body.kind,40), value=clean(body.value,200), orderId=clean(body.orderId,200);
  if(!['utm_source','utm_medium','utm_campaign','referrer','landing_page','source','campaign'].includes(kind)||!value||!orderId) throw Object.assign(new Error('orderId, supported kind and value are required'),{status:400,code:'VALIDATION_FAILED'});
  const touch={id:'touch_'+crypto.randomUUID(),orderId,kind,value,confidence:'confirmed',createdAt:nowIso(),recordedBy:actor};
  engine.attributionTouches.unshift(touch); engine.attributionTouches=engine.attributionTouches.slice(0,10000); engine.updatedAt=nowIso(); return touch;
}
