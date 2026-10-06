const clean = (value, max = 360) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

const DOMAIN_AGENTS = Object.freeze({
  margin:['finance','pricing'],
  inventory:['stock','finance','supplier'],
  marketing:['marketing','finance','sales'],
  sales:['sales','finance'],
  conversion:['sales','marketing','finance'],
  retention:['sales','customer_service','finance'],
  'data-quality':['finance','operations'],
  operations:['operations','finance']
});

function agentIdsFor(opportunity) {
  const ids = DOMAIN_AGENTS[opportunity.kind] || ['finance','operations'];
  return [...new Set([...ids,'compliance'])];
}

function verdict(agentId, opportunity, businessState) {
  const missing = opportunity.score === null || !opportunity.economicEvidenceComplete;
  const approvalRequired = Boolean(opportunity.approvalRequired);
  if (agentId === 'finance') {
    if (missing) return { verdict:'challenge', reason:'Expected contribution profit is not yet evidenced. Complete the economic inputs before treating this as a financial priority.' };
    if (Number(opportunity.score) <= 0) return { verdict:'challenge', reason:'Risk-adjusted contribution value is not positive after execution cost.' };
    return { verdict:'support', reason:`Verified risk-adjusted opportunity score is £${Number(opportunity.score).toFixed(2)}.` };
  }
  if (agentId === 'pricing' && opportunity.kind === 'margin') {
    return { verdict:'support', reason:'Recorded unit economics identify a margin intervention candidate; any material live price change remains approval-gated.' };
  }
  if (agentId === 'stock' && opportunity.kind === 'inventory') {
    return { verdict:'support', reason:'Recorded inventory is at risk, but replenishment should wait for demand, landed-cost and margin evidence.' };
  }
  if (agentId === 'supplier' && opportunity.kind === 'inventory') {
    return missing ? { verdict:'challenge', reason:'Supplier action needs reorder quantity, landed cost and replenishment-window demand evidence.' } : { verdict:'support', reason:'Supplier economics are sufficiently evidenced for owner review.' };
  }
  if (agentId === 'marketing') {
    return { verdict:'support', reason:'The opportunity is suitable for a controlled marketing experiment; publishing or paid spend stays approval-controlled.' };
  }
  if (agentId === 'sales' || agentId === 'customer_service') {
    return { verdict:'support', reason:'The opportunity can be prepared as a customer-growth action, with outbound contact and incentives subject to existing controls.' };
  }
  if (agentId === 'compliance') {
    return approvalRequired
      ? { verdict:'guardrail', reason:`Action type ${clean(opportunity.actionType || 'external action',80)} requires the existing Approval Centre before execution.` }
      : { verdict:'support', reason:'No approval-gated external action is required to continue analysis.' };
  }
  return { verdict:'support', reason:'The opportunity is within this specialist domain for analysis only; no external write is authorised.' };
}

export function deliberateOpportunity(opportunity, businessState) {
  const reviews = agentIdsFor(opportunity).map(agentId => ({ agentId, ...verdict(agentId, opportunity, businessState) }));
  const challenges = reviews.filter(item => item.verdict === 'challenge');
  const guardrails = reviews.filter(item => item.verdict === 'guardrail');
  const financiallyReady = opportunity.score !== null && opportunity.economicEvidenceComplete;
  const decision = challenges.length ? 'needs-evidence' : opportunity.approvalRequired ? 'prepare-for-approval' : financiallyReady ? 'recommend' : 'analyse';

  return {
    opportunityId:opportunity.id,
    title:clean(opportunity.title,180),
    decision,
    financiallyReady,
    reviews,
    challengeCount:challenges.length,
    approvalRequired:Boolean(opportunity.approvalRequired),
    actionType:clean(opportunity.actionType || 'safe',80),
    learning:opportunity.learning ? {
      samples:Number(opportunity.learning.samples || 0),
      confidence:clean(opportunity.learning.confidence,40),
      positiveRatePercent:Number(opportunity.learning.positiveRatePercent || 0),
      averageIncrementalContribution:opportunity.learning.averageIncrementalContribution ?? null,
      medianIncrementalContribution:opportunity.learning.medianIncrementalContribution ?? null
    } : null,
    rationale:challenges.length
      ? clean(challenges.map(item => `${item.agentId}: ${item.reason}`).join(' '),900)
      : guardrails.length
        ? 'Specialists support continued preparation, but the existing Approval Centre must authorise execution.'
        : 'Specialists support the evidence-backed recommendation. No external write has been authorised.'
  };
}

export function runGrowthCouncil(businessState, opportunityQueue, { limit = 10 } = {}) {
  const scope = businessState?.workspaceId;
  if (opportunityQueue?.workspaceId !== undefined && opportunityQueue.workspaceId !== scope) throw Object.assign(new Error('Workspace identity mismatch'), {status:403,code:'WORKSPACE_MISMATCH'});
  if ((opportunityQueue?.opportunities || []).some(item => item?.workspaceId !== undefined && item.workspaceId !== scope)) throw Object.assign(new Error('Workspace identity mismatch'), {status:403,code:'WORKSPACE_MISMATCH'});
  const opportunities = (opportunityQueue?.opportunities || []).slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
  const deliberations = opportunities.map(item => deliberateOpportunity(item, businessState));
  const recommended = deliberations.filter(item => item.decision === 'recommend');
  const approval = deliberations.filter(item => item.decision === 'prepare-for-approval');
  const needsEvidence = deliberations.filter(item => item.decision === 'needs-evidence');

  return {
    schema:'runvara-growth-council/v1',
    workspaceId:clean(businessState?.workspaceId,256),
    generatedAt:businessState?.generatedAt || null,
    deliberations,
    commander:{
      recommended:recommended.map(item => item.opportunityId),
      prepareForApproval:approval.map(item => item.opportunityId),
      needsEvidence:needsEvidence.map(item => item.opportunityId),
      learnedGuidance:deliberations.filter(item => item.learning).map(item => ({
        opportunityId:item.opportunityId,
        samples:item.learning.samples,
        confidence:item.learning.confidence,
        positiveRatePercent:item.learning.positiveRatePercent
      })),
      externalWrites:false
    },
    safeguards:{
      approvalCentrePreserved:true,
      externalWrites:false,
      unknownProfitCanBeRecommendedAsVerified:false,
      historicalLearningCannotBypassCurrentEconomics:true,
      tenantScope:clean(businessState?.workspaceId,256)
    }
  };
}
