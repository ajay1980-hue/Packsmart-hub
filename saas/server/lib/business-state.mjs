import { deriveOperations } from './operations.mjs';

const round = (value, digits = 2) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null;
const clean = (value, max = 180) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

function connectionSummary(state = {}) {
  const statuses = state.integrationStatus || {};
  const configured = new Set([
    ...Object.keys(statuses),
    ...(state.connections || []).map(item => item.provider).filter(Boolean)
  ]);
  return [...configured].sort().map(provider => {
    const row = statuses[provider] || {};
    return {
      provider,
      status: clean(row.status || 'unknown', 40),
      healthy: row.status === 'connected' && !row.lastError,
      lastError: row.lastError ? clean(row.lastError, 80) : null
    };
  });
}

function missingCostSummary(items = [], limit = 25) {
  return items.slice(0, limit).map(item => ({
    sku: clean(item.sku || item.id, 120),
    product: clean(item.productTitle || item.title, 160),
    missingFields: (item.missingFields || []).map(field => clean(field, 120)).slice(0, 12)
  }));
}

function stockRiskSummary(items = [], limit = 25) {
  return items.slice(0, limit).map(item => ({
    sku: clean(item.sku || item.id, 120),
    product: clean(item.productTitle || item.title, 160),
    inventory: Number.isFinite(Number(item.inventory)) ? Number(item.inventory) : null,
    available: item.available !== false,
    units30d: Number(item.units30d || 0)
  }));
}

function marginSummary(items = [], limit = 25) {
  return items.slice(0, limit).map(item => ({
    sku: clean(item.sku || item.id, 120),
    product: clean(item.productTitle || item.title, 160),
    price: round(item.price),
    contribution: round(item.contribution),
    margin: round(item.margin, 1),
    marginFloor: round(item.marginFloor, 1)
  }));
}

export function deriveBusinessState(state = {}, { now = new Date(), itemLimit = 25 } = {}) {
  const operations = deriveOperations(state, { now });
  const connections = connectionSummary(state);
  const pendingApprovals = (state.approvals || []).filter(item => item.status === 'pending');

  return {
    schema: 'runvara-business-state/v1',
    workspaceId: clean(state.workspace?.id, 120),
    generatedAt: now.toISOString(),
    currency: clean(state.settings?.currency || 'GBP', 8),
    readiness: operations.readiness,
    commerce: {
      products: operations.products,
      variants: operations.variants,
      orders30d: operations.orders30d,
      paidOrders30d: operations.paidOrders30d,
      openOrders30d: operations.openOrders,
      refundedOrders30d: operations.refundedOrders30d,
      revenue30d: round(operations.revenue30d)
    },
    profitability: {
      contribution30d: round(operations.last30d.operatingProfit),
      grossProfit30d: round(operations.last30d.grossProfit),
      margin30d: round(operations.last30d.margin, 1),
      profitCoveragePercent: operations.last30d.profitCoverage,
      profitCoveredOrders: operations.last30d.profitCoveredOrders,
      costCoveragePercent: operations.costCoverage,
      averageVariantMargin: round(operations.averageMargin, 1),
      missingCostVariants: operations.missingCosts,
      lowMarginVariants: operations.lowMargin,
      lossMakingVariants: operations.negativeMargin,
      missingCosts: missingCostSummary(operations.missingCostItems, itemLimit),
      lowMargin: marginSummary(operations.lowMarginItems, itemLimit),
      lossMaking: marginSummary(operations.negativeMarginItems, itemLimit)
    },
    inventory: {
      stockRisks: operations.stockRisks,
      outOfStock: operations.outOfStock,
      stockValue: round(operations.stockValue),
      stockValueCoveragePercent: operations.stockValueCoverage,
      risks: stockRiskSummary(operations.stockRiskItems, itemLimit)
    },
    advertising: {
      spend30d: round(operations.advertising?.spend),
      attributableRevenue30d: round(operations.advertising?.attributableRevenue),
      roas30d: round(operations.advertising?.roas)
    },
    channels: (operations.channels || []).map(channel => ({
      id: clean(channel.id, 60),
      orders30d: channel.orders,
      revenue30d: round(channel.revenue),
      contribution30d: round(channel.operatingProfit),
      profitCoveragePercent: channel.profitCoverage,
      advertisingSpend30d: round(channel.advertisingSpend),
      profitAfterAdvertising30d: round(channel.profitAfterAdvertising)
    })),
    controls: {
      pendingApprovals: pendingApprovals.length,
      activeAutomations: operations.activeAutomations,
      automationCount: operations.automationCount,
      integrationIssues: operations.integrationIssues
    },
    connections,
    recommendations: (operations.recommendations || []).slice(0, 12).map(item => ({
      id: clean(item.id, 80),
      priority: Number(item.priority || 0),
      title: clean(item.title, 180),
      detail: clean(item.detail, 360),
      actionType: clean(item.actionType || 'safe', 80),
      view: clean(item.view, 80),
      filter: clean(item.filter, 80)
    })),
    evidence: {
      profitUnknownWhenCostsMissing: true,
      rawCredentialsIncluded: false,
      rawCustomerIdentityIncluded: false,
      rawOrderPayloadsIncluded: false
    }
  };
}
