import { evidenceInWorkspace as inWorkspace } from './business-evidence-scope.mjs';
import { deriveOperations } from './operations.mjs';

const round = (value, digits = 2) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null;
const clean = (value, max = 180) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const rows = value => Array.isArray(value) ? value : [];
const finiteNumber = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) ? Number(value) : null;
const bound = (value, fallback, maximum) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(maximum, Math.floor(Number(value)))) : fallback;
const identity = value => typeof value === 'string' && value === value.trim() && value.length <= 180 ? value : '';
const workspaceIdentity = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) ? value : '';


function opportunityEvidence(value, workspaceId) {
  if (typeof value === 'string') return clean(value, 600);
  // Retain only catalogue/economics summaries, never order/customer payloads or
  // arbitrary evidence objects, verification notes, credentials or actor IDs.
  return rows(value).filter(item => inWorkspace(item, workspaceId) && typeof item.detail === 'string' && ['economics', 'variant', 'product', 'inventory', 'cost_coverage'].includes(item?.type))
    .slice(0, 6).map(item => clean(item.detail, 160)).filter(Boolean).join(' ').slice(0, 600);
}

function verifiedPosture(experiment) {
  const empty = { evidenceVerified:false, evidenceDecision:null, verifiedContributionValue:null, evidenceDecisionReason:null, evidenceUpdatedAt:null,
    legacyReviewRecorded:false, evidenceQualification:'none' };
  if (!experiment || experiment.status !== 'completed' || experiment.impact?.verified !== true) return empty;
  // A hot-state verified flag does not establish a committed measurement or a
  // comparable intervention. Neither its sign nor amount can rank future work.
  return { ...empty, evidenceDecision:'needs-more-evidence', legacyReviewRecorded:true, evidenceQualification:'legacy_unqualified',
    evidenceDecisionReason:'Legacy review is recorded but unqualified. A committed measurement and immutable action/domain comparability evidence are required.',
    evidenceUpdatedAt:clean(experiment.impact.verifiedAt || experiment.completedAt, 80) || null };
}

// This is a read-only projection of the existing durable collection, not a new
// detector. An empty authoritative collection must not revive dismissed work.
export function projectCanonicalOpportunities(state = {}, { limit = 100 } = {}) {
  if (!Array.isArray(state.opportunities)) return null;
  const workspaceId = workspaceIdentity(state.workspace?.id);
  if (!workspaceId || !inWorkspace(state, workspaceId) || !inWorkspace(state.workspace, workspaceId)) return [];
  const scoped = state.opportunities.filter(item => inWorkspace(item, workspaceId) && identity(item.id));
  const decisions = rows(state.decisions).filter(item => inWorkspace(item, workspaceId) && item.status === 'active' && typeof item.target === 'string' && item.target);
  const exclusions = new Set(decisions.filter(item => item.category === 'product_exclusion').map(item => item.target));
  const rejected = new Set(decisions.filter(item => item.category === 'rejected_idea').map(item => item.target));
  const isSuppressed = item => item.present === false || ['dismissed', 'resolved', 'rejected', 'cancelled', 'closed'].includes(String(item.status || '').toLowerCase())
    || exclusions.has(item.reference) || exclusions.has(item.sku) || rejected.has(item.id) || (item.fingerprint && rejected.has(item.fingerprint));
  const suppressedIds = new Set(), suppressedFingerprints = new Set();
  const idCounts = new Map(), fingerprintCounts = new Map();
  for (const item of scoped) {
    idCounts.set(item.id, (idCounts.get(item.id) || 0) + 1);
    if (item.fingerprint) fingerprintCounts.set(item.fingerprint, (fingerprintCounts.get(item.fingerprint) || 0) + 1);
  }
  for (const item of scoped.filter(isSuppressed)) {
    suppressedIds.add(identity(item.id));
    if (item.fingerprint) suppressedFingerprints.add(item.fingerprint);
  }
  const experiments = new Map();
  for (const experiment of inWorkspace(state.revenueEngine, workspaceId) ? rows(state.revenueEngine.experiments) : []) {
    if (!inWorkspace(experiment, workspaceId) || !identity(experiment.id)) continue;
    // Ambiguous experiment IDs cannot confer verified evidence.
    const id = identity(experiment.id);
    experiments.set(id, experiments.has(id) ? null : experiment);
  }
  const result = [];
  const maximum = bound(limit, 100, 100);
  for (const item of scoped) {
    if (result.length >= maximum) break;
    const id = identity(item.id);
    // Never let source ordering choose the least restrictive record when
    // repeated identities disagree about approval, cost or experiment state.
    if (suppressedIds.has(id) || idCounts.get(id) > 1 || (item.fingerprint && (suppressedFingerprints.has(item.fingerprint) || fingerprintCounts.get(item.fingerprint) > 1))) continue;
    const candidate = experiments.get(identity(item.experimentId));
    const experiment = candidate && candidate.opportunityId === item.id && inWorkspace(candidate.impact || {}, workspaceId) ? candidate : null;
    const requiredAction = clean(item.requiredAction, 80) || null;
    const actionType = requiredAction || clean(item.actionType, 80) || 'safe';
    const executionCost = finiteNumber(item.executionCost), effortHours = finiteNumber(item.effortHours);
    const confidence = finiteNumber(item.confidence), risk = finiteNumber(item.risk), effort = finiteNumber(item.effort), probability = finiteNumber(item.probability);
    result.push({
      id, workspaceId, kind:clean(item.kind || 'operations', 80).toLowerCase(),
      reference:clean(item.reference, 180), title:clean(item.title || 'Review recorded opportunity', 180),
      status:clean(item.status || 'open', 40), present:true,
      evidence:opportunityEvidence(item.evidence, workspaceId),
      effort:effort === null ? clean(item.effort || 'medium', 40) : Math.max(0, Math.min(1, effort)),
      effortHours:effortHours !== null && effortHours >= 0 ? effortHours : null,
      risk:risk === null ? clean(item.risk || 'medium', 40) : Math.max(0, Math.min(1, risk)),
      confidence:confidence === null ? clean(item.confidence || 'unknown', 40) : Math.max(0, Math.min(1, confidence)),
      probability:probability === null ? null : Math.max(0, Math.min(1, probability)),
      executionCost:executionCost !== null && executionCost >= 0 ? executionCost : null,
      // Durable opportunities have no validated total-profit forecast schema.
      // Neither arbitrary numeric fields, per-unit estimates nor realised
      // experiment outcomes establish future contribution profit.
      expectedContributionProfit:null,
      needsEvidence:rows(item.needsEvidence).filter(value => typeof value === 'string').slice(0, 12).map(value => clean(value, 160)),
      approvalRequired:Boolean(item.approvalRequired || requiredAction || actionType !== 'safe' || executionCost > 0),
      requiredAction, actionType,
      recommendedNextStep:clean(item.recommendedNextStep, 360),
      experimentId:experiment ? identity(experiment.id) : null,
      experimentStatus:experiment ? clean(experiment.status, 40) : null,
      ...verifiedPosture(experiment)
    });
  }
  return result;
}

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
  const workspaceId = workspaceIdentity(state.workspace?.id);
  if (workspaceId && (!inWorkspace(state, workspaceId) || !inWorkspace(state.workspace, workspaceId))) {
    throw Object.assign(new Error('Workspace identity mismatch'), { status:403, code:'WORKSPACE_MISMATCH' });
  }
  itemLimit = bound(itemLimit, 25, 100);
  const operations = deriveOperations(state, { now });
  const connections = connectionSummary(state);
  const pendingApprovals = (state.approvals || []).filter(item => item.status === 'pending');
  const opportunities = projectCanonicalOpportunities(state);

  return {
    schema: 'runvara-business-state/v1',
    workspaceId,
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
    ...(opportunities === null ? {} : { opportunities }),
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
