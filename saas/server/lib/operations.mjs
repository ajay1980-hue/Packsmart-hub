import crypto from 'node:crypto';
import { orderPeriod, inspectOrderPeriod, summarizeOrderInspection, recordedOrderNarrative, orderFinancialView, unqualifiedAdvertising, ORDER_EVIDENCE_PRESENTATION_LIMITS, compactOrderPeriod, hasRecordedRefund, editorOrderRecord } from './order-analytics.mjs';
import { createRequire } from 'node:module';
import { requiresApproval } from './security.mjs';
import {
  amount,
  deriveLandedCost,
  hasAmount,
  hasCataloguePrice,
  unitEconomics,
  withinDays
} from './profit.mjs';

const require = createRequire(import.meta.url);
let ebayCommercial = null;
try { ebayCommercial = require('../../../ebay-manager/strategy.js'); } catch {}

// Bump when deterministic reporting/detection semantics change, even if the
// persisted source records are unchanged. Historical reports keep their version.
export const OPERATIONS_CALCULATION_VERSION = 'imported-order-analytics/v2';

export const SOCIAL_COMMERCE_CHANNELS = Object.freeze([
  { id: 'meta', name: 'Facebook & Instagram Shops', kind: 'social-commerce', capabilities: ['catalogue', 'listings', 'orders', 'ads'] },
  { id: 'tiktok_shop', name: 'TikTok Shop', kind: 'social-commerce', capabilities: ['catalogue', 'listings', 'orders', 'ads'] },
  { id: 'pinterest', name: 'Pinterest Shopping', kind: 'social-commerce', capabilities: ['catalogue', 'product-pins', 'ads'] },
  { id: 'google_youtube', name: 'Google & YouTube Shopping', kind: 'social-commerce', capabilities: ['catalogue', 'listings', 'orders', 'ads'] },
  { id: 'whatsapp_business', name: 'WhatsApp Business', kind: 'social-commerce', capabilities: ['catalogue', 'messages', 'orders'] }
]);

export const MARKETPLACE_CHANNELS = Object.freeze([
  { id: 'amazon', name: 'Amazon', kind: 'marketplace', capabilities: ['catalogue', 'listings', 'orders', 'fees', 'ads'] }
]);

export const APPROVAL_TYPES = Object.freeze({
  spend_money: 'Spend money',
  advertising_spend: 'Advertising spend',
  supplier_order: 'Supplier order',
  refund: 'Customer refund',
  major_price_change: 'Major price change',
  paid_service_purchase: 'Paid-service purchase',
  live_external_action: 'Live external action',
  risky_marketplace_action: 'Risky marketplace action',
  social_commerce_publish: 'Social-commerce publish',
  social_advertising_change: 'Social advertising change',
  customer_facing_publish: 'Customer-facing publication', sensitive_communication: 'Sensitive outbound communication',
  delete_data: 'Important data deletion', integration_change: 'Important integration change', irreversible_action: 'Irreversible action'
});

export const AUTOMATION_DEFINITIONS = Object.freeze([
  { id: 'channelSync', name: 'Channel sync', detail: 'Refreshes connected read-only commerce data without changing live listings.' },
  { id: 'inventoryMonitoring', name: 'Inventory monitoring', detail: 'Detects low and out-of-stock variants across connected channels.' },
  { id: 'profitGuard', name: 'Profit guard', detail: 'Flags products below their configured contribution-margin floor.' },
  { id: 'costCoverageChecks', name: 'Cost coverage checks', detail: 'Keeps unknown costs visible instead of silently treating them as zero.' },
  { id: 'lowStockAlerts', name: 'Low-stock alerts', detail: 'Surfaces stock risks without placing supplier orders.' },
  { id: 'dailyOpsBrief', name: 'Daily operations brief', detail: 'Builds a deterministic daily priority briefing.' },
  { id: 'seoChecks', name: 'SEO checks', detail: 'Finds missing images, weak titles and unpublished products.' },
  { id: 'priceRecommendations', name: 'Price recommendations', detail: 'Prepares recommendations; major changes require approval.' },
  { id: 'customerReplyDrafts', name: 'Customer-service issue detection', detail: 'Identifies order follow-up from recorded payment and fulfilment states. Inbox messages are not connected.' },
  { id: 'channelMismatchAlerts', name: 'Channel mismatch alerts', detail: 'Compares marketplace and social-channel catalogue health.' },
  { id: 'lossMakingAlerts', name: 'Loss-making SKU alerts', detail: 'Surfaces fully costed products and orders with negative contribution.' },
  { id: 'marketingPlanner', name: 'Marketing Autopilot planner', detail: 'Prepares one evidence-backed product campaign per day. Publishing and paid advertising remain approval-gated.' },
  { id: 'marketingCreativeWorker', name: 'Marketing creative worker', detail: 'Advances configured Canva and Runway creative jobs. It cannot buy credits, publish content or change advertising spend.' },
  { id: 'marketRadar', name: 'Market Radar', detail: 'Monitors approved public competitor and supplier pages for evidence-backed changes. It cannot change prices, buy stock or publish content.' }
]);

export function defaultAutomations() {
  return Object.fromEntries(AUTOMATION_DEFINITIONS.map(rule => [rule.id, true]));
}

export function flattenProducts(products = []) {
  return products.flatMap(product => (product.variants || []).map(variant => ({
    productId: product.id,
    externalProductId: product.externalId || product.id,
    productTitle: product.title,
    handle: product.handle,
    productStatus: product.status || 'unknown',
    productType: product.productType || '',
    productImage: product.image || null,
    description: product.description || '',
    provider: product.provider || 'shopify',
    id: variant.id || variant.externalId || variant.sku,
    externalId: variant.externalId || variant.id,
    sku: variant.sku || `${product.handle || product.id}-${variant.title || variant.id}`,
    title: variant.title || 'Default',
    price: hasCataloguePrice(variant.price) ? amount(variant.price) : null,
    inventory: variant.inventory === null || variant.inventory === undefined ? null : amount(variant.inventory),
    available: variant.available !== false,
    image: variant.image || product.image || null
  })));
}

export function contributionFor(item, economics = {}, options = {}) {
  return unitEconomics(item, economics[item.sku] || economics[item.id] || {}, options);
}

export function calculateEbayListingProfit(listing, economics = {}, feeModel = {}) {
  const record = economics[listing?.sku] || {};
  const required = ['landed', 'packing', 'delivery'];
  const missingFields = required.filter(field => !hasAmount(record[field]));
  if (!ebayCommercial || missingFields.length || !hasAmount(listing?.price) || !hasAmount(listing?.buyerShippingCharge) || !hasAmount(listing?.adRate)) {
    return { complete: false, missingFields, basis: 'existing-ebay-profit-guard' };
  }
  const result = ebayCommercial.calculateProfit({
    itemPrice: amount(listing.price),
    buyerShippingCharge: amount(listing.buyerShippingCharge),
    landedCost: amount(record.landed),
    packingCost: amount(record.packing),
    outboundShippingCost: amount(record.delivery),
    adRatePercent: amount(listing.adRate),
    feeModel
  });
  return {
    complete: true,
    basis: 'existing-ebay-profit-guard',
    contribution: Number(result.netProfit.toFixed(2)),
    margin: Number(result.netMarginPercent.toFixed(2)),
    fees: Number(result.totalChannelFees.toFixed(2)),
    assumptions: ebayCommercial.normalizeFeeModel(feeModel)
  };
}

function channelEconomics(state, inspection) {
  return inspection.providers.map(id => ({ id, ...summarizeOrderInspection(inspection, id),
    advertisingSpend: null, attributableRevenue: null, roas: null, profitAfterAdvertising: null,
    advertisingBasis: 'recorded_costs_currency_and_attribution_unverified'
  }));
}

// Scalar revenue series are deprecated: source coverage and currency are not
// qualified. Reuse existing period evidence; never rescan the snapshot per point.
export function revenueSignals() {
  return { daily: [], periodRef: 'last30d', comparisons: { 7: { current: null, previous: null, change: null }, 30: { current: null, previous: null, change: null } },
    basis: 'recorded_order_evidence', status: 'source_period_unverified' };
}

export function deriveOperations(state, { now = new Date(), lowStockThreshold = state.settings?.lowStockThreshold ?? 20, marginFloor = state.settings?.marginFloor ?? 20 } = {}) {
  const products = state.products || [];
  const variants = flattenProducts(products);
  const economics = state.economics || {};
  const productRows = variants.map(item => {
    const result = contributionFor(item, economics, { marginFloor });
    return { ...item, ...result, units30d: null, revenue30d: null, stockCoverDays: null, salesAttribution: 'unverified_recorded_sku_only' };
  });
  const covered = productRows.filter(item => item.complete);
  const contributionKnown = covered.filter(item => hasCataloguePrice(item.price) && Number.isFinite(item.contribution));
  const marginKnown = contributionKnown.filter(item => Number.isFinite(item.margin));
  const missingCosts = productRows.filter(item => !item.complete);
  const lowMargin = marginKnown.filter(item => item.margin < item.marginFloor);
  const negativeMargin = contributionKnown.filter(item => item.contribution < 0);
  const stockRisks = productRows.filter(item =>
    String(item.productStatus).toLowerCase() === 'active' &&
    ((item.inventory !== null && item.inventory <= lowStockThreshold) || item.available === false)
  );
  const outOfStock = stockRisks.filter(item => item.available === false || (item.inventory !== null && item.inventory <= 0));

  const orders = Array.isArray(state.orders) ? state.orders : [];
  const todayInspection = inspectOrderPeriod(state, orderPeriod(now, 'today'));
  const weekInspection = inspectOrderPeriod(state, orderPeriod(now, 7));
  const monthInspection = inspectOrderPeriod(state, orderPeriod(now, 30));
  const detailInspection = inspectOrderPeriod(state, orderPeriod(now, 90));
  const today = summarizeOrderInspection(todayInspection);
  const last7d = summarizeOrderInspection(weekInspection);
  const last30d = summarizeOrderInspection(monthInspection);
  const rawDetailOrders = detailInspection.rows.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const orderProfitability = rawDetailOrders.slice(0, ORDER_EVIDENCE_PRESENTATION_LIMITS.orderDetails)
    .map(row => ({ ...editorOrderRecord(row.order), recordedStatus: { financialStatus: row.financialStatus, fulfillmentStatus: row.fulfillmentStatus, cancelled: row.cancelled, hasRecordedRefund: hasRecordedRefund(row), createdAt: row.createdAt }, profitability: orderFinancialView(detailInspection, row) }));

  const averageMargin = marginKnown.length ? marginKnown.reduce((sum, item) => sum + item.margin, 0) / marginKnown.length : null;
  const costCoverage = variants.length ? Math.round(covered.length / variants.length * 100) : 0;
  const positiveStock = productRows.filter(item => item.inventory > 0);
  const stockWithCost = positiveStock.filter(item => deriveLandedCost(economics[item.sku] || {}).complete);
  const stockValue = stockWithCost.reduce((sum, item) => sum + item.inventory * deriveLandedCost(economics[item.sku] || {}).value, 0);

  const seoIssues = products.flatMap(product => {
    const issues = [];
    if (!product.image) issues.push({ productId: product.id, product: product.title, issue: 'Missing product image' });
    if (String(product.title || '').trim().length < 18) issues.push({ productId: product.id, product: product.title, issue: 'Thin product title' });
    if (String(product.description || '').trim().length < 80) issues.push({ productId: product.id, product: product.title, issue: 'Thin product description' });
    if (String(product.status || '').toLowerCase() !== 'active') issues.push({ productId: product.id, product: product.title, issue: `Product is ${product.status || 'not active'}` });
    return issues;
  });

  const customerServiceItems = monthInspection.rows.filter(row => {
    const open = row.fulfillmentStatus !== 'UNKNOWN' && !['FULFILLED', 'RESTOCKED'].includes(row.fulfillmentStatus);
    const oldOpen = open && !withinDays(row.createdAt, 2, now) && !row.cancelled;
    const paymentIssue = ['PENDING', 'EXPIRED', 'VOIDED'].includes(row.financialStatus);
    return oldOpen || paymentIssue || hasRecordedRefund(row);
  }).map(({ order }) => { const safe = editorOrderRecord(order); return { id: safe.id, name: safe.name, provider: safe.provider, createdAt: safe.createdAt, financialStatus: safe.financialStatus, fulfillmentStatus: safe.fulfillmentStatus }; });

  const pendingApprovals = (state.approvals || []).filter(item => item.status === 'pending');
  const commerceStatuses = state.integrationStatus || {};
  const expectedChannels = [...new Set(['shopify', 'ebay', ...Object.keys(commerceStatuses), ...(state.connections || []).map(item => item.provider)])];
  const integrationIssues = expectedChannels.filter(id => ['error', 'failed', 'auth_expired', 'degraded'].includes(commerceStatuses[id]?.status) || commerceStatuses[id]?.lastError);
  const activeAutomations = Object.values(state.automations || {}).filter(Boolean).length;
  const automationCount = Object.keys(state.automations || {}).length;
  const channels = channelEconomics(state, monthInspection);
  const advertising = unqualifiedAdvertising(state.advertisingCosts);
  const supplierCount = (state.suppliers || []).filter(item => item.active !== false).length;
  const readiness = Math.max(0, Math.min(100, Math.round(
    15 + (products.length ? 10 : 0) + costCoverage * 0.35 + (state.storageReady ? 15 : 0) +
    (commerceStatuses.shopify?.status === 'connected' ? 10 : 0) + (commerceStatuses.ebay?.status === 'connected' ? 5 : 0) +
    (supplierCount ? 5 : 0) + (last30d.numericCostCoverage.orderCoverage ? 5 * last30d.numericCostCoverage.orderCoverage.numerator / last30d.numericCostCoverage.orderCoverage.denominator : 0) + (pendingApprovals.length === 0 ? 5 : 0)
  )));

  const recommendations = [];
  if (missingCosts.length) recommendations.push({ id: 'complete-costs', priority: 100, title: `Complete costs for ${missingCosts.length} variant${missingCosts.length === 1 ? '' : 's'}`, detail: 'Profit stays unknown until every required variable cost is explicitly recorded, including valid zero values.', actionType: 'safe', view: 'profit', filter: 'missing-costs' });
  if (negativeMargin.length) recommendations.push({ id: 'negative-margin', priority: 98, title: `Review ${negativeMargin.length} loss-making variant${negativeMargin.length === 1 ? '' : 's'}`, detail: 'Fully recorded variable costs exceed selling price. Any material live price change remains approval-gated.', actionType: 'major_price_change', view: 'profit', filter: 'loss-making' });
  if (last30d.orders) recommendations.push({ id: 'order-profit-coverage', priority: 96, title: 'Review imported order evidence', detail: `${last30d.numericCostCoverage.completeOrders} of ${last30d.orders} retained orders have numeric cost inputs. Historical currency, tax, cost assignments and source coverage still need qualification before profit can be reported.`, actionType: 'safe', view: 'orders', filter: 'missing-profit' });
  if (lowMargin.length && !negativeMargin.length) recommendations.push({ id: 'low-margin', priority: 88, title: `Review ${lowMargin.length} low-margin variant${lowMargin.length === 1 ? '' : 's'}`, detail: 'Contribution is below its configured operating floor.', actionType: 'major_price_change', view: 'profit', filter: 'below-floor' });
  if (stockRisks.length) recommendations.push({ id: 'stock-risk', priority: 84, title: `Resolve ${stockRisks.length} stock risk${stockRisks.length === 1 ? '' : 's'}`, detail: 'Replenishment can be prepared, but supplier orders require approval.', actionType: 'supplier_order', view: 'profit', filter: 'low-stock' });
  if (last30d.openOrders) recommendations.push({ id: 'open-orders', priority: 78, title: `Check ${last30d.openOrders} open order${last30d.openOrders === 1 ? '' : 's'}`, detail: 'Review fulfilment status and any customer-service follow-up.', actionType: 'safe', view: 'orders', filter: 'open' });
  if (pendingApprovals.length) recommendations.push({ id: 'pending-approvals', priority: 94, title: `Decide ${pendingApprovals.length} pending approval${pendingApprovals.length === 1 ? '' : 's'}`, detail: 'A decision records authorisation only; external execution remains separately disabled.', actionType: 'safe', view: 'approvals', filter: 'pending' });
  if (integrationIssues.length) recommendations.push({ id: 'integration-health', priority: 72, title: `Resolve ${integrationIssues.length} channel connection issue${integrationIssues.length === 1 ? '' : 's'}`, detail: 'Disconnected sources reduce sales, fee, stock and mismatch visibility.', actionType: 'safe', view: 'channels', filter: 'issues' });
  if (seoIssues.length) recommendations.push({ id: 'seo-issues', priority: 55, title: `Review ${seoIssues.length} catalogue SEO issue${seoIssues.length === 1 ? '' : 's'}`, detail: 'Product presentation checks can be reviewed without changing the live store.', actionType: 'safe', view: 'issues', filter: 'seo' });
  if (!recommendations.length) recommendations.push({ id: 'operations-clear', priority: 1, title: 'Operations checks are clear', detail: 'No immediate deterministic risk has been detected.', actionType: 'safe', view: 'overview', filter: 'all' });
  recommendations.sort((a, b) => b.priority - a.priority);

  return {
    generatedAt: now.toISOString(), today, last7d, last30d, revenueSignals: revenueSignals(state, now, { last7d, last30d }),
    revenue30d: last30d.revenue, orders30d: last30d.orders, paidOrders30d: last30d.paidOrders,
    refundedOrders30d: last30d.refundedOrders, openOrders: last30d.openOrders,
    products: products.length, variants: variants.length, productRows, orderProfitability,
    orderDetailCoverage: { limit: ORDER_EVIDENCE_PRESENTATION_LIMITS.orderDetails, returnedRows: orderProfitability.length, scannedRows: Math.min(orders.length, 2000), availableRows: rawDetailOrders.length, returned: orderProfitability.length, available: rawDetailOrders.length, truncated: !detailInspection.evidence?.completeness.retainedCohortComplete || rawDetailOrders.length !== orderProfitability.length, complete: Boolean(detailInspection.evidence?.completeness.retainedCohortComplete && rawDetailOrders.length === orderProfitability.length) },
    stockRisks: stockRisks.length, stockRiskItems: stockRisks.slice(0, 100), outOfStock: outOfStock.length,
    stockValue: stockWithCost.length ? Number(stockValue.toFixed(2)) : null,
    stockValueCoverage: positiveStock.length ? Math.round(stockWithCost.length / positiveStock.length * 100) : 0,
    missingCosts: missingCosts.length, missingCostItems: missingCosts.slice(0, 100),
    lowMargin: lowMargin.length, lowMarginItems: lowMargin.slice(0, 100),
    negativeMargin: negativeMargin.length, negativeMarginItems: negativeMargin.slice(0, 100),
    mostProfitable: [...contributionKnown].sort((a, b) => b.contribution - a.contribution).slice(0, 10),
    leastProfitable: [...contributionKnown].sort((a, b) => a.contribution - b.contribution).slice(0, 10),
    averageMargin: averageMargin === null ? null : Number(averageMargin.toFixed(1)), costCoverage,
    marginCoveredVariants: marginKnown.length,
    marginCoverage: variants.length ? Math.round(marginKnown.length / variants.length * 100) : 0,
    averageMarginBasis: 'unweighted-known-catalogue-contribution-margins',
    seoIssues: seoIssues.length, seoIssueItems: seoIssues.slice(0, 100),
    customerServiceIssues: last30d.orders === null ? null : customerServiceItems.length, customerServiceItems: customerServiceItems.slice(0, 100),
    pendingApprovals: pendingApprovals.length, integrationIssues: integrationIssues.length,
    activeAutomations, automationCount, supplierCount, advertising, channels, readiness,
    recommendations: recommendations.slice(0, 12)
  };
}

export function compactDailyBrief(brief) {
  const summaries = new Set(['today', 'last7d', 'last30d', 'advertising', 'channels', 'recommendations', 'topActions', 'attention', 'archive']);
  return Object.fromEntries(Object.entries(brief).filter(([key, value]) => value === null || typeof value !== 'object' || summaries.has(key)).map(([key, value]) => [key, ['today', 'last7d', 'last30d'].includes(key) ? compactOrderPeriod(value) : value]));
}

export function buildDailyBrief(state, options = {}) {
  const metrics = options.operations || deriveOperations(state, options);
  const lines = [];
  lines.push(recordedOrderNarrative(metrics.today, 'Today UTC'));
  lines.push(recordedOrderNarrative(metrics.last7d, 'Last 7 days UTC'));
  lines.push(`${metrics.products} products and ${metrics.variants} variants are in the operations catalogue.`);
  if (metrics.missingCosts) lines.push(`${metrics.missingCosts} variants still have incomplete variable-cost coverage.`);
  else if (metrics.variants) lines.push('Required variable-cost coverage is complete for the current catalogue.');
  if (metrics.stockRisks) lines.push(`${metrics.stockRisks} active variants are at or below the stock-risk threshold.`);
  if (metrics.lowMargin) lines.push(`${metrics.lowMargin} fully costed variants are below their contribution-margin floor.`);
  if (metrics.pendingApprovals) lines.push(`${metrics.pendingApprovals} risk-sensitive actions are waiting for a decision.`);
  if (metrics.integrationIssues) lines.push(`${metrics.integrationIssues} channel connections need attention.`);
  return compactDailyBrief({ id: `brief_${crypto.randomUUID()}`, ...metrics, summary: lines.join(' '), logic: 'deterministic-v2',
    calculationVersion: OPERATIONS_CALCULATION_VERSION, topActions: metrics.recommendations.slice(0, 5) });
}

function cleanText(value, max, required = false) {
  const text = String(value || '').trim().slice(0, max);
  if (required && !text) throw Object.assign(new Error('Required approval detail is missing'), { status: 400 });
  return text;
}

export function normalizeApprovalRequest(body, requestedBy) {
  const type = cleanText(body?.type, 80, true).toLowerCase();
  if (!requiresApproval(type)) throw Object.assign(new Error('Action type is not configured as approval-gated'), { status: 400 });
  const impactRaw = body?.financialImpact;
  const financialImpact = impactRaw === '' || impactRaw === null || impactRaw === undefined ? null : Number(impactRaw);
  if (financialImpact !== null && (!Number.isFinite(financialImpact) || Math.abs(financialImpact) > 10000000)) throw Object.assign(new Error('Financial impact must be a valid amount'), { status: 400 });
  return {
    id: `approval_${crypto.randomUUID()}`, type,
    action: cleanText(body?.action || APPROVAL_TYPES[type], 180, true),
    reason: cleanText(body?.reason, 1000, true),
    financialImpact: financialImpact === null ? null : Number(financialImpact.toFixed(2)),
    expectedBenefit: cleanText(body?.expectedBenefit, 1000, true), risk: cleanText(body?.risk, 1000, true),
    requestedBy, source: cleanText(body?.source || 'packsmart-ops', 120, true),
    payload: body?.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : {},
    evidence: Array.isArray(body?.evidence) ? body.evidence.slice(0, 20).map(item => ({ type: cleanText(item?.type || 'reference', 40), id: cleanText(item?.id, 180), detail: cleanText(item?.detail, 1000) })) : [],
    revision: 1, history: [], agentId: cleanText(body?.agentId || requestedBy, 80), workStatus: 'REQUIRES APPROVAL',
    status: 'pending', createdAt: new Date().toISOString(), decidedAt: null, decidedBy: null, decisionNote: null,
    executedExternally: false, executionStatus: 'not_connected'
  };
}

export function integrationMatrix(state, env = process.env, operations = null) {
  const statuses = state.integrationStatus || {};
  const connectionMap = new Map((state.connections || []).map(item => [item.provider, item]));
  const metricMap = new Map((operations?.channels || channelEconomics(state, inspectOrderPeriod(state, orderPeriod(new Date(), 30)))).map(item => [item.id, item]));
  const makeChannel = channel => {
    const status = statuses[channel.id] || {};
    const connection = connectionMap.get(channel.id);
    return {
      ...channel,
      status: status.status || connection?.status || 'not_configured',
      detail: status.detail || (connection ? 'Credentials are encrypted server-side; a live read check is pending.' : 'Secure OAuth/API consent is required.'),
      lastSyncAt: status.lastSyncAt || connection?.lastSyncAt || null,
      lastError: status.lastError || connection?.lastError || null,
      metrics30d: metricMap.get(channel.id) || null
    };
  };
  const core = [
    { id: 'shopify', name: 'Shopify', kind: 'commerce', capabilities: ['catalogue', 'inventory', 'orders', 'refunds', 'tax', 'payments'], status: statuses.shopify?.status || 'not_configured', detail: statuses.shopify?.detail || 'Secure Admin API connection required for live orders, fees and inventory.', lastSyncAt: statuses.shopify?.lastSyncAt || null, lastError: statuses.shopify?.lastError || null, metrics30d: metricMap.get('shopify') || null },
    { id: 'ebay', name: 'eBay', kind: 'marketplace', capabilities: ['listings', 'drafts', 'orders', 'fees', 'promotions', 'profit-guard'], status: statuses.ebay?.status || 'not_configured', detail: statuses.ebay?.detail || 'Secure read-only access can use the existing eBay app without changing the current Manager.', lastSyncAt: statuses.ebay?.lastSyncAt || null, lastError: statuses.ebay?.lastError || null, metrics30d: metricMap.get('ebay') || null }
  ];
  const channels = [
    ...core, ...SOCIAL_COMMERCE_CHANNELS.map(makeChannel), ...MARKETPLACE_CHANNELS.map(makeChannel),
    { id: 'stripe', name: 'Stripe Billing', kind: 'billing', capabilities: ['subscriptions', 'webhooks'], status: env.STRIPE_SECRET_KEY ? 'configured_disabled' : 'dormant', detail: env.BILLING_CHECKOUT_ENABLED === 'true' ? 'Checkout is enabled for eligible external workspaces.' : 'Architecture prepared; charging is disabled.', lastSyncAt: null, lastError: null },
    { id: 'ai', name: 'AI Briefing', kind: 'intelligence', capabilities: ['summaries'], status: env.AI_BRIEF_ENABLED === 'true' && env.OPENAI_API_KEY ? 'configured' : 'deterministic', detail: 'The daily brief uses deterministic business logic; no browser AI key is required.', lastSyncAt: null, lastError: null }
  ];
  for (const id of ['supabase', 'reporting', 'render', 'email', 'google']) {
    if (statuses[id]) channels.push({ id, name: ({ supabase: 'Supabase', reporting: 'Reporting', render: 'Render', email: 'Email', google: 'Google' })[id], kind: 'system', capabilities: ['health'], ...statuses[id] });
  }
  return channels.map(channel => ({ ...channel, source: statuses[channel.id]?.source || null,
    status: /AUTH|CREDENTIAL|TOKEN_EXPIRED|REFRESH_FAILED/.test(String(channel.lastError || '')) ? 'auth_expired' : channel.lastError && channel.status === 'connected' ? 'degraded' : channel.status,
    lastFailureAt: statuses[channel.id]?.lastFailureAt || null,
    degradedSurfaces: statuses[channel.id]?.degradedSurfaces || [],
    recommendedRepair: channel.lastError ? (/AUTH|CREDENTIAL|TOKEN_EXPIRED/.test(String(channel.lastError)) ? 'Owner: verify the existing credential and reconnect through Sales Channels.' : 'Review the recorded error; temporary read failures will be retried within Autopilot limits.') : null
  }));
}

export function ebayComparisonAvailable(ebay) {
  return Boolean(ebay?.health && ebay.source !== 'ebay-oauth-readonly' && ebay.coverage?.fullCatalogueAvailable !== false && ebay.coverage?.offersAvailable !== false && ebay.coverage?.inventoryAvailable !== false);
}

export function onboardingState(state, env = process.env, operations = null) {
  const integrations = integrationMatrix(state, env, operations);
  return {
    accountCreated: Boolean(state.users?.length), workspaceCreated: Boolean(state.workspace?.id),
    commerceConnected: integrations.some(item => ['shopify', 'ebay'].includes(item.id) && item.status === 'connected'),
    costsStarted: Object.values(state.economics || {}).some(item => deriveLandedCost(item).complete),
    automationsConfigured: Object.keys(state.automations || {}).length > 0, approvalsReady: true,
    subscription: state.subscription || { plan: 'starter', status: 'pending' }, betaSignupsEnabled: env.BETA_SIGNUPS_ENABLED === 'true'
  };
}
