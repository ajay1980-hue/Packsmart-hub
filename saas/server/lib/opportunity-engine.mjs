const round = (value, digits = 2) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null;
const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));
const clean = (value, max = 240) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

const CONFIDENCE = Object.freeze({ high:0.9, medium:0.65, low:0.35, unknown:0 });
const RISK = Object.freeze({ low:0.05, medium:0.2, high:0.45, critical:0.8 });

function evidenceConfidence(opportunity = {}) {
  if (Number.isFinite(Number(opportunity.confidence))) return clamp01(opportunity.confidence);
  return CONFIDENCE[String(opportunity.confidence || '').toLowerCase()] ?? CONFIDENCE.unknown;
}

function riskPenalty(opportunity = {}) {
  if (Number.isFinite(Number(opportunity.risk))) return clamp01(opportunity.risk);
  return RISK[String(opportunity.risk || '').toLowerCase()] ?? RISK.medium;
}

export function scoreOpportunity(opportunity = {}) {
  const rawExpectedProfit = opportunity.expectedContributionProfit;
  const expectedProfit = rawExpectedProfit === null || rawExpectedProfit === undefined || rawExpectedProfit === '' ? null : Number(rawExpectedProfit);
  const confidence = evidenceConfidence(opportunity);
  const probability = clamp01(opportunity.probability ?? confidence);
  const executionCost = Math.max(0, Number(opportunity.executionCost) || 0);
  const risk = riskPenalty(opportunity);
  const hasProfitEvidence = expectedProfit !== null && Number.isFinite(expectedProfit);

  // Unknown economics must never be converted into invented pounds.
  const score = hasProfitEvidence
    ? Math.max(0, expectedProfit * confidence * probability * (1 - risk) - executionCost)
    : null;

  return {
    ...opportunity,
    expectedContributionProfit: hasProfitEvidence ? round(expectedProfit) : null,
    confidence: round(confidence, 3),
    probability: round(probability, 3),
    risk: round(risk, 3),
    executionCost: round(executionCost),
    score: score === null ? null : round(score),
    economicEvidenceComplete: hasProfitEvidence,
    needsEvidence: hasProfitEvidence ? [] : [...new Set(opportunity.needsEvidence || ['expectedContributionProfit'])]
  };
}

function missingCostOpportunity(businessState) {
  const count = Number(businessState.profitability?.missingCostVariants || 0);
  if (!count) return null;
  return scoreOpportunity({
    id:'evidence-complete-costs',
    kind:'data-quality',
    title:`Complete cost evidence for ${count} variant${count === 1 ? '' : 's'}`,
    evidence:'Runvara is withholding contribution profit for variants without complete variable-cost evidence.',
    expectedContributionProfit:null,
    confidence:'high',
    probability:1,
    risk:'low',
    executionCost:0,
    approvalRequired:false,
    actionType:'safe',
    needsEvidence:['landed cost and required variable costs']
  });
}

function lossMakingOpportunity(businessState) {
  const items = businessState.profitability?.lossMaking || [];
  if (!items.length) return null;
  const knownLoss = items.reduce((sum, item) => sum + Math.max(0, -(Number(item.contribution) || 0)), 0);
  return scoreOpportunity({
    id:'margin-stop-loss',
    kind:'margin',
    title:`Review ${items.length} loss-making variant${items.length === 1 ? '' : 's'}`,
    evidence:`Current fully-costed unit economics show £${knownLoss.toFixed(2)} aggregate loss per one unit of each listed variant.`,
    expectedContributionProfit:null,
    confidence:'high',
    probability:0.7,
    risk:'medium',
    executionCost:0,
    approvalRequired:true,
    actionType:'major_price_change',
    needsEvidence:['expected sales volume after intervention','validated price or cost action']
  });
}

function stockOpportunity(businessState) {
  const risks = businessState.inventory?.risks || [];
  if (!risks.length) return null;
  return scoreOpportunity({
    id:'inventory-protect-sales',
    kind:'inventory',
    title:`Resolve ${risks.length} priority stock risk${risks.length === 1 ? '' : 's'}`,
    evidence:'Active variants are at or below the configured stock-risk threshold.',
    expectedContributionProfit:null,
    confidence:'high',
    probability:0.75,
    risk:'medium',
    executionCost:0,
    approvalRequired:true,
    actionType:'supplier_order',
    needsEvidence:['reorder quantity','supplier landed cost','expected demand during replenishment window']
  });
}

function recommendationOpportunities(businessState) {
  return (businessState.recommendations || [])
    .filter(item => !['complete-costs','negative-margin','stock-risk'].includes(item.id))
    .map(item => scoreOpportunity({
      id:`ops-${clean(item.id,80)}`,
      kind:clean(item.view || 'operations',60),
      title:clean(item.title,180),
      evidence:clean(item.detail,360),
      expectedContributionProfit:null,
      confidence:'medium',
      probability:0.5,
      risk:item.actionType === 'safe' ? 'low' : 'medium',
      executionCost:0,
      approvalRequired:item.actionType !== 'safe',
      actionType:clean(item.actionType || 'safe',80),
      needsEvidence:['measured incremental contribution-profit estimate']
    }));
}

export function deriveOpportunityQueue(businessState = {}, { limit = 50 } = {}) {
  const candidates = [
    missingCostOpportunity(businessState),
    lossMakingOpportunity(businessState),
    stockOpportunity(businessState),
    ...recommendationOpportunities(businessState)
  ].filter(Boolean);

  const ranked = candidates.sort((a,b) => {
    const aKnown = a.score !== null ? 1 : 0, bKnown = b.score !== null ? 1 : 0;
    if (aKnown !== bKnown) return bKnown - aKnown;
    if (a.score !== b.score) return (b.score || 0) - (a.score || 0);
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return a.title.localeCompare(b.title);
  }).slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));

  return {
    schema:'runvara-opportunity-queue/v1',
    workspaceId:clean(businessState.workspaceId,120),
    generatedAt:businessState.generatedAt || null,
    objective:'maximise verified incremental contribution profit, not headline revenue',
    opportunities:ranked,
    summary:{
      total:ranked.length,
      economicallyScored:ranked.filter(item => item.score !== null).length,
      awaitingEconomicEvidence:ranked.filter(item => item.score === null).length,
      approvalRequired:ranked.filter(item => item.approvalRequired).length
    },
    safeguards:{
      unknownProfitRanksAsMoney:false,
      approvalsPreserved:true,
      tenantScope:clean(businessState.workspaceId,120)
    }
  };
}
