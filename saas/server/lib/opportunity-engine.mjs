const round = (value, digits = 2) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null;
const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));
const clean = (value, max = 240) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const workspaceIdentity = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) ? value : '';

function inWorkspace(record, workspaceId) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const scopes = ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id'].filter(key => Object.hasOwn(record, key)).map(key => record[key]);
  for (const key of ['workspace', 'tenant']) if (Object.hasOwn(record, key)) scopes.push(record[key] && typeof record[key] === 'object' ? record[key].id : record[key]);
  return scopes.every(value => typeof value === 'string' && value === workspaceId);
}

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

function learningPrior(kind, learning) {
  const prior = (learning?.priors || []).find(item => item.kind === String(kind || '').toLowerCase());
  if (!prior || !prior.usableForGuidance) return null;
  return {
    samples:Number(prior.samples || 0),
    confidence:clean(prior.confidence,40),
    averageIncrementalContribution:round(prior.averageIncrementalContribution),
    medianIncrementalContribution:round(prior.medianIncrementalContribution),
    positiveRatePercent:round(prior.positiveRatePercent,1)
  };
}

function applyLearning(opportunity, learning) {
  const prior = learningPrior(opportunity.evidenceKind || opportunity.kind, learning);
  if (!prior) return { ...opportunity, learning:null, learningPriority:0 };
  const rate = Math.max(0, Math.min(100, Number(prior.positiveRatePercent) || 0));
  const sampleWeight = Math.min(1, prior.samples / 8);
  const learningPriority = round((rate / 100) * sampleWeight, 3);
  return {
    ...opportunity,
    learning:prior,
    learningPriority
  };
}

export function scoreOpportunity(opportunity = {}) {
  const rawExpectedProfit = opportunity.expectedContributionProfit;
  const expectedProfit = (typeof rawExpectedProfit === 'number' || (typeof rawExpectedProfit === 'string' && rawExpectedProfit.trim() !== '')) ? Number(rawExpectedProfit) : null;
  const confidence = evidenceConfidence(opportunity);
  const probability = clamp01(opportunity.probability ?? confidence);
  const rawCost = opportunity.executionCost;
  const numericCost = (typeof rawCost === 'number' || (typeof rawCost === 'string' && rawCost.trim() !== '')) ? Number(rawCost) : null;
  const executionCost = numericCost !== null && Number.isFinite(numericCost) && numericCost >= 0 ? numericCost : null;
  const risk = riskPenalty(opportunity);
  const hasProfitEvidence = expectedProfit !== null && Number.isFinite(expectedProfit);
  const economicEvidenceComplete = hasProfitEvidence && executionCost !== null;

  // Unknown economics must never be converted into invented pounds.
  const score = economicEvidenceComplete
    ? Math.max(0, expectedProfit * confidence * probability * (1 - risk) - executionCost)
    : null;

  return {
    ...opportunity,
    expectedContributionProfit: hasProfitEvidence ? round(expectedProfit) : null,
    confidence: round(confidence, 3),
    probability: round(probability, 3),
    risk: round(risk, 3),
    executionCost: round(executionCost),
    approvalRequired:Boolean(opportunity.approvalRequired || opportunity.requiredAction || (opportunity.actionType && opportunity.actionType !== 'safe') || executionCost > 0),
    score: score === null ? null : round(score),
    economicEvidenceComplete,
    needsEvidence: economicEvidenceComplete ? [] : [...new Set([
      ...(Array.isArray(opportunity.needsEvidence) ? opportunity.needsEvidence : []),
      ...(!hasProfitEvidence ? ['expectedContributionProfit'] : []),
      ...(executionCost === null ? ['executionCost'] : [])
    ])]
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
  return (businessState.recommendations || []).slice(0, 100)
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

function canonicalOpportunities(businessState) {
  const workspaceId = workspaceIdentity(businessState.workspaceId);
  if (!workspaceId || !inWorkspace(businessState, workspaceId)) return [];
  const scoped = businessState.opportunities.filter(item => inWorkspace(item, workspaceId) && typeof item.id === 'string' && item.id && item.id === item.id.trim() && item.id.length <= 180);
  const idCounts = new Map(), fingerprintCounts = new Map();
  for (const item of scoped) {
    idCounts.set(item.id, (idCounts.get(item.id) || 0) + 1);
    if (item.fingerprint) fingerprintCounts.set(item.fingerprint, (fingerprintCounts.get(item.fingerprint) || 0) + 1);
  }
  return scoped.filter(item => item.present !== false && !['dismissed', 'resolved', 'rejected', 'cancelled', 'closed'].includes(String(item.status || '').toLowerCase())
    && idCounts.get(item.id) === 1 && (!item.fingerprint || fingerprintCounts.get(item.fingerprint) === 1)).slice(0, 100).map(item => {
    const evidenceKind = clean(item.kind || 'operations', 80).toLowerCase();
    const requiredAction = clean(item.requiredAction, 80) || null;
    const actionType = requiredAction || clean(item.actionType, 80) || 'safe';
    // Only business-state's authoritative linked-experiment projection sets
    // this flag. Raw opportunity posture fields alone are never sufficient.
    const verified = item.evidenceVerified === true && Boolean(item.experimentId) && item.experimentStatus === 'completed';
    const contribution = verified ? round(item.verifiedContributionValue) : null;
    const decision = !verified ? null : contribution !== null && contribution > 0 ? 'ready-for-owner-review'
      : contribution !== null && contribution < 0 ? 'deprioritise' : 'needs-more-evidence';
    const needsEvidence = Array.isArray(item.needsEvidence) ? item.needsEvidence.filter(value => typeof value === 'string').slice(0, 12).map(value => clean(value, 160)) : [];
    return scoreOpportunity({
      id:item.id.trim(), workspaceId,
      kind:({ pricing:'margin', reorder:'inventory', seo:'marketing' })[evidenceKind] || evidenceKind,
      evidenceKind,
      reference:clean(item.reference, 180),
      title:clean(item.title || 'Review recorded opportunity', 180),
      evidence:typeof item.evidence === 'string' ? clean(item.evidence, 600) : '',
      expectedContributionProfit:null,
      confidence:item.confidence ?? 'unknown',
      probability:item.probability ?? undefined,
      risk:item.risk ?? 'medium',
      executionCost:round(item.executionCost),
      effort:clean(item.effort, 40), effortHours:round(item.effortHours),
      approvalRequired:Boolean(item.approvalRequired || requiredAction || actionType !== 'safe'),
      requiredAction, actionType,
      recommendedNextStep:clean(item.recommendedNextStep, 360),
      needsEvidence:needsEvidence.length ? needsEvidence : ['measured incremental contribution-profit estimate'],
      experimentId:clean(item.experimentId, 180) || null,
      experimentStatus:clean(item.experimentStatus, 40) || null,
      evidenceVerified:verified,
      evidenceDecision:decision,
      verifiedContributionValue:contribution,
      evidenceDecisionReason:verified ? clean(item.evidenceDecisionReason, 240) || null : null,
      evidenceUpdatedAt:verified ? clean(item.evidenceUpdatedAt, 80) || null : null
    });
  });
}

export function deriveOpportunityQueue(businessState = {}, { limit = 50, learning = null } = {}) {
  const canonical = Array.isArray(businessState.opportunities);
  const candidateWorkspaceId = workspaceIdentity(businessState.workspaceId);
  const workspaceId = candidateWorkspaceId && inWorkspace(businessState, candidateWorkspaceId) ? candidateWorkspaceId : '';
  const scopedLearning = inWorkspace(learning, workspaceId) ? learning : null;
  const candidates = [
    missingCostOpportunity(businessState),
    ...(canonical ? canonicalOpportunities(businessState) : [
      lossMakingOpportunity(businessState),
      stockOpportunity(businessState),
      ...recommendationOpportunities(businessState)
    ])
  ].filter(item => item && workspaceId).filter((item, index, all) => all.findIndex(other => other.id === item.id) === index)
    .map(item => applyLearning(item, scopedLearning));

  const ranked = candidates.sort((a,b) => {
    // Verification is evidence, not a blanket promotion. A negative realised
    // result must not leapfrog stronger ideas just because it is measured.
    const aNegative = a.evidenceDecision === 'deprioritise' ? 1 : 0, bNegative = b.evidenceDecision === 'deprioritise' ? 1 : 0;
    if (aNegative !== bNegative) return aNegative - bNegative;
    const aKnown = a.score !== null ? 1 : 0, bKnown = b.score !== null ? 1 : 0;
    if (aKnown !== bKnown) return bKnown - aKnown;
    if (a.score !== b.score) return (b.score || 0) - (a.score || 0);
    if (a.learningPriority !== b.learningPriority) return (b.learningPriority || 0) - (a.learningPriority || 0);
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    const aPositive = a.evidenceDecision === 'ready-for-owner-review' ? 1 : 0, bPositive = b.evidenceDecision === 'ready-for-owner-review' ? 1 : 0;
    if (aPositive !== bPositive) return bPositive - aPositive;
    return a.title.localeCompare(b.title);
  }).slice(0, Math.max(0, Math.min(50, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 50)));

  return {
    schema:'runvara-opportunity-queue/v1',
    workspaceId,
    generatedAt:businessState.generatedAt || null,
    objective:'maximise verified incremental contribution profit, not headline revenue',
    opportunities:ranked,
    summary:{
      total:ranked.length,
      economicallyScored:ranked.filter(item => item.score !== null).length,
      awaitingEconomicEvidence:ranked.filter(item => item.score === null).length,
      approvalRequired:ranked.filter(item => item.approvalRequired).length,
      withVerifiedLearning:ranked.filter(item => item.learning).length,
      withVerifiedOutcomes:ranked.filter(item => item.evidenceVerified).length
    },
    safeguards:{
      unknownProfitRanksAsMoney:false,
      historicalResultsNeverBecomeExpectedProfit:true,
      durableOpportunityIdentityPreserved:canonical,
      approvalsPreserved:true,
      tenantScope:workspaceId
    }
  };
}
