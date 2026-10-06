import { tenantBusinessEvidence } from './business-evidence-scope.mjs';
const clean = (value, max = 240) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const round = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null;
const hasNumber = value => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));

function asMetricEvidence(sourceType, sourceId, raw = {}) {
  const verified = raw.verified === true || raw.status === 'verified';
  if (!verified) return null;
  const metrics = {
    incrementalRevenue: hasNumber(raw.incrementalRevenue) ? Number(raw.incrementalRevenue) : 0,
    incrementalContribution: hasNumber(raw.incrementalContribution) ? Number(raw.incrementalContribution) : 0,
    contributionProtected: hasNumber(raw.contributionProtected) ? Number(raw.contributionProtected) : 0,
    costAvoided: hasNumber(raw.costAvoided) ? Number(raw.costAvoided) : 0,
    minutesSaved: hasNumber(raw.minutesSaved) ? Number(raw.minutesSaved) : 0
  };
  if (!Object.values(metrics).some(value => value !== 0)) return null;
  return {
    id: clean(raw.id || `${sourceType}:${sourceId}`, 180),
    sourceType,
    sourceId: clean(sourceId, 180),
    measuredAt: clean(raw.measuredAt || raw.completedAt || raw.createdAt, 80) || null,
    method: clean(raw.method || raw.basis || 'recorded-evidence', 160),
    metrics
  };
}

function workEvidence(state = {}) {
  const rows = [];
  for (const work of state.workRecords || []) {
    if (work.status !== 'COMPLETED') continue;
    for (const evidence of work.evidence || []) {
      const impact = evidence?.impact && typeof evidence.impact === 'object' ? evidence.impact : evidence;
      const normalized = asMetricEvidence('work', work.id, impact);
      if (normalized) rows.push(normalized);
    }
  }
  return rows;
}

function experimentEvidence(state = {}) {
  const rows = [];
  for (const experiment of state.revenueEngine?.experiments || []) {
    if (!['completed','measured','closed'].includes(String(experiment.status || '').toLowerCase())) continue;
    const raw = experiment.impact || experiment.result || experiment.outcome;
    if (!raw || typeof raw !== 'object') continue;
    const normalized = asMetricEvidence('experiment', experiment.id, raw);
    if (normalized) rows.push(normalized);
  }
  return rows;
}

function approvalEvidence(state = {}) {
  const rows = [];
  for (const approval of state.approvals || []) {
    if (approval.status !== 'approved' || !['completed','succeeded','executed'].includes(String(approval.executionStatus || '').toLowerCase())) continue;
    const raw = approval.impact || approval.executionImpact;
    if (!raw || typeof raw !== 'object') continue;
    const normalized = asMetricEvidence('approval', approval.id, raw);
    if (normalized) rows.push(normalized);
  }
  return rows;
}

function uniqueEvidence(rows) {
  const byId = new Map(), conflicts = new Set();
  for (const row of rows) {
    const key = row.id || `${row.sourceType}:${row.sourceId}`;
    const previous = byId.get(key);
    if (previous && JSON.stringify(previous.metrics) !== JSON.stringify(row.metrics)) conflicts.add(key);
    else if (!previous) byId.set(key,row);
  }
  return {rows:[...byId.entries()].filter(([key])=>!conflicts.has(key)).map(([,row])=>row),conflicts:conflicts.size};
}

function sum(rows, metric) {
  return round(rows.reduce((total, row) => total + Number(row.metrics?.[metric] || 0), 0));
}

export function deriveImpact(state = {}) {
  state = tenantBusinessEvidence(state);
  const deduplicated = uniqueEvidence([
    ...workEvidence(state),
    ...experimentEvidence(state),
    ...approvalEvidence(state)
  ]);

  const evidence = deduplicated.rows;
  const incrementalRevenue = sum(evidence, 'incrementalRevenue');
  const incrementalContribution = sum(evidence, 'incrementalContribution');
  const contributionProtected = sum(evidence, 'contributionProtected');
  const costAvoided = sum(evidence, 'costAvoided');
  const minutesSaved = sum(evidence, 'minutesSaved');
  const verifiedValue = round(incrementalContribution + contributionProtected + costAvoided);

  const completedWork = (state.workRecords || []).filter(item => item.status === 'COMPLETED').length;
  const completedAutomations = (state.automationRuns || []).filter(item => item.status === 'COMPLETED').length;
  const completedExperiments = (state.revenueEngine?.experiments || []).filter(item => ['completed','measured','closed'].includes(String(item.status || '').toLowerCase())).length;
  const subscriptionCost = hasNumber(state.subscription?.monthlyPrice) ? Number(state.subscription.monthlyPrice) :
    hasNumber(state.subscription?.monthlyPriceGbp) ? Number(state.subscription.monthlyPriceGbp) : null;

  return {
    schema:'runvara-impact/v1',
    workspaceId:clean(state.workspace?.id,256),
    generatedAt:new Date().toISOString(),
    verified:{
      incrementalRevenue,
      incrementalContribution,
      contributionProtected,
      costAvoided,
      verifiedValue,
      hoursSaved:round(minutesSaved / 60, 1)
    },
    activity:{
      completedWork,
      completedAutomations,
      completedExperiments,
      verifiedImpactEvents:evidence.length
    },
    roi:{
      subscriptionCost:round(subscriptionCost),
      verifiedValue,
      multiple:subscriptionCost && subscriptionCost > 0 ? round(verifiedValue / subscriptionCost, 2) : null
    },
    evidence:evidence.slice(0,100),
    coverage:{
      conflictingEvidenceExcluded:deduplicated.conflicts,
      ambiguousSourceRecordsExcluded:state.evidenceScope.ambiguousSourceRecordsExcluded,
      financiallyVerifiedEvents:evidence.filter(row => row.metrics.incrementalContribution || row.metrics.contributionProtected || row.metrics.costAvoided).length,
      timeVerifiedEvents:evidence.filter(row => row.metrics.minutesSaved).length,
      note:'Runvara only counts realised value when an explicit verified measurement is recorded. Recommendations, forecasts and approval estimates are excluded.'
    },
    safeguards:{
      forecastsCountedAsImpact:false,
      approvalFinancialImpactCountedAsRealised:false,
      revenueDoubleCountedAsProfit:false,
      rawCustomerIdentityIncluded:false
    }
  };
}
