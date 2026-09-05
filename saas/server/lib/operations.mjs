import crypto from 'node:crypto';
import { requiresApproval } from './security.mjs';

export const SOCIAL_COMMERCE_CHANNELS = Object.freeze([
  { id: 'meta', name: 'Facebook & Instagram Shops', kind: 'social-commerce', capabilities: ['catalogue', 'listings', 'orders', 'ads'] },
  { id: 'tiktok_shop', name: 'TikTok Shop', kind: 'social-commerce', capabilities: ['catalogue', 'listings', 'orders', 'ads'] },
  { id: 'pinterest', name: 'Pinterest Shopping', kind: 'social-commerce', capabilities: ['catalogue', 'product-pins', 'ads'] },
  { id: 'google_youtube', name: 'Google & YouTube Shopping', kind: 'social-commerce', capabilities: ['catalogue', 'listings', 'orders', 'ads'] },
  { id: 'whatsapp_business', name: 'WhatsApp Business', kind: 'social-commerce', capabilities: ['catalogue', 'messages', 'orders'] }
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
  social_advertising_change: 'Social advertising change'
});

export const AUTOMATION_DEFINITIONS = Object.freeze([
  { id: 'profitGuard', name: 'Profit guard', detail: 'Flags products below the configured contribution-margin floor.' },
  { id: 'lowStockAlerts', name: 'Low-stock alerts', detail: 'Surfaces stock risks without placing supplier orders.' },
  { id: 'dailyOpsBrief', name: 'Daily operations brief', detail: 'Builds a deterministic daily priority briefing.' },
  { id: 'seoChecks', name: 'SEO checks', detail: 'Finds missing images, weak titles and unpublished products.' },
  { id: 'priceRecommendations', name: 'Price recommendations', detail: 'Prepares recommendations; major changes require approval.' },
  { id: 'customerReplyDrafts', name: 'Customer reply drafts', detail: 'Prepares drafts without sending customer messages.' },
  { id: 'channelMismatchAlerts', name: 'Channel mismatch alerts', detail: 'Compares marketplace and social-channel catalogue health.' }
]);

export function defaultAutomations() {
  return Object.fromEntries(AUTOMATION_DEFINITIONS.map(rule => [rule.id, true]));
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasCost(value) {
  return value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));
}

function dateInWindow(value, days, now) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= now.getTime() - days * 86400000;
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
    id: variant.id || variant.externalId || variant.sku,
    externalId: variant.externalId || variant.id,
    sku: variant.sku || `${product.handle || product.id}-${variant.title || variant.id}`,
    title: variant.title || 'Default',
    price: number(variant.price),
    inventory: variant.inventory === null || variant.inventory === undefined ? null : number(variant.inventory),
    available: variant.available !== false,
    image: variant.image || product.image || null
  })));
}

export function contributionFor(item, economics = {}) {
  const costs = economics[item.sku] || economics[item.id] || {};
  if (!hasCost(costs.landed)) return null;
  const landed = number(costs.landed);
  const packing = number(costs.packing);
  const delivery = number(costs.delivery);
  const channelFee = number(costs.channelFee);
  const totalCost = landed + packing + delivery + channelFee;
  const contribution = item.price - totalCost;
  const margin = item.price > 0 ? contribution / item.price * 100 : 0;
  return { landed, packing, delivery, channelFee, totalCost, contribution, margin };
}

export function deriveOperations(state, { now = new Date(), lowStockThreshold = 20, marginFloor = 20 } = {}) {
  const products = state.products || [];
  const variants = flattenProducts(products);
  const economics = state.economics || {};
  const contributions = variants.map(item => ({ item, result: contributionFor(item, economics) }));
  const covered = contributions.filter(entry => entry.result);
  const missingCosts = contributions.filter(entry => !entry.result);
  const lowMargin = covered.filter(entry => entry.result.margin < marginFloor);
  const negativeMargin = covered.filter(entry => entry.result.contribution < 0);
  const stockRisks = variants.filter(item =>
    item.productStatus.toLowerCase() === 'active' &&
    item.inventory !== null &&
    item.inventory <= lowStockThreshold
  );

  const recentOrders = (state.orders || []).filter(order => dateInWindow(order.createdAt, 30, now));
  const paidOrders = recentOrders.filter(order => ['PAID', 'PARTIALLY_PAID', 'AUTHORIZED'].includes(String(order.financialStatus || '').toUpperCase()));
  const refundedOrders = recentOrders.filter(order => ['REFUNDED', 'VOIDED'].includes(String(order.financialStatus || '').toUpperCase()));
  const revenue = paidOrders.reduce((sum, order) => sum + number(order.total), 0);
  const openOrders = recentOrders.filter(order => !['FULFILLED', 'RESTOCKED'].includes(String(order.fulfillmentStatus || '').toUpperCase()));
  const avgMargin = covered.length ? covered.reduce((sum, entry) => sum + entry.result.margin, 0) / covered.length : null;
  const costCoverage = variants.length ? Math.round(covered.length / variants.length * 100) : 0;

  const seoIssues = products.flatMap(product => {
    const issues = [];
    if (!product.image) issues.push({ productId: product.id, product: product.title, issue: 'Missing product image' });
    if (String(product.title || '').trim().length < 18) issues.push({ productId: product.id, product: product.title, issue: 'Thin product title' });
    if (String(product.description || '').trim().length < 80) issues.push({ productId: product.id, product: product.title, issue: 'Thin product description' });
    if (String(product.status || '').toLowerCase() !== 'active') issues.push({ productId: product.id, product: product.title, issue: `Product is ${product.status || 'not active'}` });
    return issues;
  });

  const pendingApprovals = (state.approvals || []).filter(item => item.status === 'pending');
  const integrationIssues = Object.values(state.integrationStatus || {}).filter(item => ['error', 'degraded', 'not_configured'].includes(item.status));
  const activeAutomations = Object.values(state.automations || {}).filter(Boolean).length;
  const automationCount = Object.keys(state.automations || {}).length;
  const readiness = Math.max(0, Math.min(100, Math.round(
    25 +
    (products.length ? 15 : 0) +
    costCoverage * 0.25 +
    (state.storageReady ? 15 : 0) +
    (state.integrationStatus?.shopify?.status === 'connected' ? 10 : 0) +
    (state.integrationStatus?.ebay?.status === 'connected' ? 5 : 0) +
    (pendingApprovals.length === 0 ? 5 : 0)
  )));

  const recommendations = [];
  if (missingCosts.length) recommendations.push({
    id: 'complete-costs',
    priority: 100,
    title: `Add costs for ${missingCosts.length} variant${missingCosts.length === 1 ? '' : 's'}`,
    detail: 'Landed cost is required before Packsmart can trust margin recommendations.',
    actionType: 'safe'
  });
  if (negativeMargin.length) recommendations.push({
    id: 'negative-margin',
    priority: 95,
    title: `Review ${negativeMargin.length} loss-making variant${negativeMargin.length === 1 ? '' : 's'}`,
    detail: 'Recorded costs exceed selling price. Any major live price change remains approval-gated.',
    actionType: 'major_price_change'
  });
  if (lowMargin.length && !negativeMargin.length) recommendations.push({
    id: 'low-margin',
    priority: 85,
    title: `Review ${lowMargin.length} low-margin variant${lowMargin.length === 1 ? '' : 's'}`,
    detail: `Contribution is below the ${marginFloor}% operating floor.`,
    actionType: 'major_price_change'
  });
  if (stockRisks.length) recommendations.push({
    id: 'stock-risk',
    priority: 80,
    title: `Resolve ${stockRisks.length} stock risk${stockRisks.length === 1 ? '' : 's'}`,
    detail: 'Replenishment can be prepared, but supplier orders require approval.',
    actionType: 'supplier_order'
  });
  if (openOrders.length) recommendations.push({
    id: 'open-orders',
    priority: 75,
    title: `Check ${openOrders.length} open order${openOrders.length === 1 ? '' : 's'}`,
    detail: 'Review fulfilment status and any customer-service follow-up.',
    actionType: 'safe'
  });
  if (pendingApprovals.length) recommendations.push({
    id: 'pending-approvals',
    priority: 90,
    title: `Decide ${pendingApprovals.length} pending approval${pendingApprovals.length === 1 ? '' : 's'}`,
    detail: 'No external action will execute simply because it is approved.',
    actionType: 'safe'
  });
  if (integrationIssues.length) recommendations.push({
    id: 'integration-health',
    priority: 70,
    title: `Complete ${integrationIssues.length} integration connection${integrationIssues.length === 1 ? '' : 's'}`,
    detail: 'Disconnected channels reduce sales, stock and mismatch visibility.',
    actionType: 'safe'
  });
  if (!recommendations.length) recommendations.push({
    id: 'operations-clear',
    priority: 1,
    title: 'Operations checks are clear',
    detail: 'No immediate deterministic risk has been detected.',
    actionType: 'safe'
  });
  recommendations.sort((a, b) => b.priority - a.priority);

  return {
    generatedAt: now.toISOString(),
    revenue30d: Number(revenue.toFixed(2)),
    orders30d: recentOrders.length,
    paidOrders30d: paidOrders.length,
    refundedOrders30d: refundedOrders.length,
    openOrders: openOrders.length,
    products: products.length,
    variants: variants.length,
    stockRisks: stockRisks.length,
    stockRiskItems: stockRisks.slice(0, 25),
    missingCosts: missingCosts.length,
    missingCostItems: missingCosts.slice(0, 25).map(entry => entry.item),
    lowMargin: lowMargin.length,
    lowMarginItems: lowMargin.slice(0, 25).map(entry => ({ ...entry.item, ...entry.result })),
    negativeMargin: negativeMargin.length,
    averageMargin: avgMargin === null ? null : Number(avgMargin.toFixed(1)),
    costCoverage,
    seoIssues: seoIssues.length,
    seoIssueItems: seoIssues.slice(0, 25),
    customerServiceIssues: openOrders.length,
    pendingApprovals: pendingApprovals.length,
    integrationIssues: integrationIssues.length,
    activeAutomations,
    automationCount,
    readiness,
    recommendations: recommendations.slice(0, 8)
  };
}

export function buildDailyBrief(state, options = {}) {
  const metrics = deriveOperations(state, options);
  const lines = [];
  if (metrics.orders30d) lines.push(`£${metrics.revenue30d.toFixed(2)} paid revenue from ${metrics.paidOrders30d} paid order${metrics.paidOrders30d === 1 ? '' : 's'} in the last 30 days.`);
  else lines.push('Sales data is not yet available from a connected order source.');
  lines.push(`${metrics.products} products and ${metrics.variants} variants are in the operations catalogue.`);
  if (metrics.missingCosts) lines.push(`${metrics.missingCosts} variants still need landed-cost data.`);
  else if (metrics.variants) lines.push('Landed-cost coverage is complete for the current catalogue.');
  if (metrics.stockRisks) lines.push(`${metrics.stockRisks} active variants are at or below the stock-risk threshold.`);
  if (metrics.lowMargin) lines.push(`${metrics.lowMargin} variants are below the contribution-margin floor.`);
  if (metrics.pendingApprovals) lines.push(`${metrics.pendingApprovals} risk-sensitive actions are waiting for a decision.`);
  if (metrics.integrationIssues) lines.push(`${metrics.integrationIssues} channel connections still need attention.`);
  return {
    id: `brief_${crypto.randomUUID()}`,
    ...metrics,
    summary: lines.join(' '),
    logic: 'deterministic-v1',
    topActions: metrics.recommendations.slice(0, 5)
  };
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
  const financialImpact = impactRaw === '' || impactRaw === null || impactRaw === undefined
    ? null
    : Number(impactRaw);
  if (financialImpact !== null && (!Number.isFinite(financialImpact) || Math.abs(financialImpact) > 10000000)) {
    throw Object.assign(new Error('Financial impact must be a valid amount'), { status: 400 });
  }
  return {
    id: `approval_${crypto.randomUUID()}`,
    type,
    action: cleanText(body?.action || APPROVAL_TYPES[type], 180, true),
    reason: cleanText(body?.reason, 1000, true),
    financialImpact: financialImpact === null ? null : Number(financialImpact.toFixed(2)),
    expectedBenefit: cleanText(body?.expectedBenefit, 1000, true),
    risk: cleanText(body?.risk, 1000, true),
    requestedBy,
    source: cleanText(body?.source || 'packsmart-ops', 120, true),
    payload: body?.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : {},
    status: 'pending',
    createdAt: new Date().toISOString(),
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    executedExternally: false,
    executionStatus: 'not_connected'
  };
}

export function integrationMatrix(state, env = process.env) {
  const statuses = state.integrationStatus || {};
  const connectionMap = new Map((state.connections || []).map(item => [item.provider, item]));
  const core = [
    { id: 'shopify', name: 'Shopify', kind: 'commerce', capabilities: ['catalogue', 'inventory', 'orders'], status: statuses.shopify?.status || 'not_configured', detail: statuses.shopify?.detail || 'Secure Admin API connection required for live orders and inventory.' },
    { id: 'ebay', name: 'eBay Manager', kind: 'marketplace', capabilities: ['listings', 'drafts', 'promotions', 'profit-guard'], status: statuses.ebay?.status || 'not_configured', detail: statuses.ebay?.detail || 'Existing server-side OAuth manager connection will be reused.' }
  ];
  const social = SOCIAL_COMMERCE_CHANNELS.map(channel => {
    const status = statuses[channel.id] || {};
    const connection = connectionMap.get(channel.id);
    return {
      ...channel,
      status: status.status || connection?.status || 'not_configured',
      detail: status.detail || (connection ? 'Credentials are stored server-side; live read checks are pending.' : 'Ready for secure OAuth/API onboarding.')
    };
  });
  return [
    ...core,
    ...social,
    { id: 'stripe', name: 'Stripe Billing', kind: 'billing', capabilities: ['subscriptions', 'webhooks'], status: env.STRIPE_SECRET_KEY ? 'configured_disabled' : 'dormant', detail: env.BILLING_CHECKOUT_ENABLED === 'true' ? 'Checkout is enabled for eligible external workspaces.' : 'Architecture prepared; charging is disabled.' },
    { id: 'ai', name: 'AI Briefing', kind: 'intelligence', capabilities: ['summaries'], status: env.AI_BRIEF_ENABLED === 'true' && env.OPENAI_API_KEY ? 'configured' : 'deterministic', detail: 'The daily brief currently uses deterministic business logic.' }
  ];
}

export function onboardingState(state, env = process.env) {
  const integrations = integrationMatrix(state, env);
  return {
    accountCreated: Boolean(state.users?.length),
    workspaceCreated: Boolean(state.workspace?.id),
    commerceConnected: integrations.some(item => ['shopify', 'ebay'].includes(item.id) && item.status === 'connected'),
    costsStarted: Object.values(state.economics || {}).some(item => hasCost(item?.landed)),
    automationsConfigured: Object.keys(state.automations || {}).length > 0,
    approvalsReady: true,
    subscription: state.subscription || { plan: 'starter', status: 'pending' },
    betaSignupsEnabled: env.BETA_SIGNUPS_ENABLED === 'true'
  };
}
