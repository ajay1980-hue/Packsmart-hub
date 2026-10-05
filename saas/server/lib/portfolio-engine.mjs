const clean = (value, max = 180) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const round = (value, digits = 2) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null;
const RISK = Object.freeze({ low:0.1, medium:0.3, high:0.6, critical:0.9 });
const EFFORT = Object.freeze({ low:0.2, medium:0.5, high:0.8 });

function riskValue(value) {
  if (Number.isFinite(Number(value))) return Math.max(0, Math.min(1, Number(value)));
  return RISK[String(value || '').toLowerCase()] ?? RISK.medium;
}
function effortValue(value) {
  if (Number.isFinite(Number(value))) return Math.max(0, Math.min(1, Number(value)));
  return EFFORT[String(value || '').toLowerCase()] ?? EFFORT.medium;
}
function verifiedExperimentFor(state, opportunity) {
  if (!opportunity?.experimentId) return null;
  const experiment=(state.revenueEngine?.experiments || []).find(item=>item.id===opportunity.experimentId);
  if (!experiment || experiment.status!=='completed' || experiment.impact?.verified!==true) return null;
  return experiment;
}
function contributionValue(impact={}) {
  return ['incrementalContribution','contributionProtected','costAvoided']
    .reduce((sum, field)=>sum+(Number.isFinite(Number(impact[field]))?Number(impact[field]):0),0);
}
function allocationRow(state, opportunity) {
  const experiment=verifiedExperimentFor(state,opportunity);
  const verifiedContribution=experiment ? contributionValue(experiment.impact) : null;
  const confidence=Number.isFinite(Number(opportunity.confidence)) ? Math.max(0,Math.min(1,Number(opportunity.confidence))) : 0.5;
  const risk=riskValue(opportunity.risk);
  const effort=effortValue(opportunity.effort);
  const learningSamples=Number(opportunity.learning?.samples || 0);
  const learningRate=Number(opportunity.learning?.positiveRatePercent || 0);
  const learningSignal=learningSamples ? Math.min(1,learningSamples/8)*Math.max(0,Math.min(1,learningRate/100)) : 0;
  const evidenceSignal=verifiedContribution===null ? 0 : verifiedContribution>0 ? 1 : verifiedContribution<0 ? -1 : 0;
  const priorityIndex=round(Math.max(0,(confidence*0.35)+(learningSignal*0.2)+(Math.max(0,evidenceSignal)*0.45)-risk*0.25-effort*0.1),3);
  const executionCost=Number.isFinite(Number(opportunity.executionCost)) && Number(opportunity.executionCost)>0 ? Number(opportunity.executionCost) : null;
  const effortHours=Number.isFinite(Number(opportunity.effortHours)) && Number(opportunity.effortHours)>0 ? Number(opportunity.effortHours) : null;
  const pendingApproval=(state.approvals || []).some(item => item.status==='pending' && item.payload?.opportunityId===opportunity.id);
  const activeExperiment=(state.revenueEngine?.experiments || []).some(item => item.opportunityId===opportunity.id && ['draft','running','measured'].includes(String(item.status || '').toLowerCase()));
  const blockedByEvidence=opportunity.evidenceDecision==='needs-more-evidence' || opportunity.evidenceDecision==='deprioritise';
  return {
    opportunityId:clean(opportunity.id,180),
    title:clean(opportunity.title,180),
    kind:clean(opportunity.kind,80),
    verifiedContribution:verifiedContribution===null?null:round(verifiedContribution),
    priorityIndex,
    risk:round(risk,3),
    confidence:round(confidence,3),
    learningSignal:round(learningSignal,3),
    executionCost:round(executionCost),
    effortHours:round(effortHours),
    contributionPerPound:verifiedContribution!==null&&executionCost ? round(verifiedContribution/executionCost,3) : null,
    contributionPerHour:verifiedContribution!==null&&effortHours ? round(verifiedContribution/effortHours,2) : null,
    approvalRequired:Boolean(opportunity.approvalRequired || opportunity.requiredAction),
    approvalPending:pendingApproval,
    activeExperiment,
    blockedByEvidence,
    evidenceDecision:clean(opportunity.evidenceDecision,60)||null,
    missingAllocationInputs:[
      ...(executionCost ? [] : ['executionCost']),
      ...(effortHours ? [] : ['effortHours'])
    ]
  };
}

export function derivePortfolioAllocation(state={}) {
  const availableHours=Number.isFinite(Number(state.settings?.growthCapacityHours)) && Number(state.settings.growthCapacityHours)>=0 ? Number(state.settings.growthCapacityHours) : null;
  const maxConcurrent=Number.isInteger(Number(state.settings?.maxConcurrentGrowthExperiments)) && Number(state.settings.maxConcurrentGrowthExperiments)>0 ? Number(state.settings.maxConcurrentGrowthExperiments) : null;
  const activeExperimentCount=(state.revenueEngine?.experiments || []).filter(item=>['draft','running','measured'].includes(String(item.status || '').toLowerCase())).length;
  const opportunities=(state.opportunities || []).filter(item=>item.present!==false && !['dismissed','resolved'].includes(item.status));
  const rows=opportunities.map(item=>allocationRow(state,item)).sort((a,b)=>{
    const aVerified=a.verifiedContribution!==null?1:0,bVerified=b.verifiedContribution!==null?1:0;
    if(aVerified!==bVerified) return bVerified-aVerified;
    if((a.verifiedContribution||0)!==(b.verifiedContribution||0)) return (b.verifiedContribution||0)-(a.verifiedContribution||0);
    if(a.priorityIndex!==b.priorityIndex) return b.priorityIndex-a.priorityIndex;
    return a.title.localeCompare(b.title);
  });
  const nextPound=rows.filter(row=>row.contributionPerPound!==null && row.contributionPerPound>0).sort((a,b)=>b.contributionPerPound-a.contributionPerPound)[0] || null;
  const nextHour=rows.filter(row=>row.contributionPerHour!==null && row.contributionPerHour>0).sort((a,b)=>b.contributionPerHour-a.contributionPerHour)[0] || null;
  const experimentCapacityAvailable=maxConcurrent===null ? null : activeExperimentCount < maxConcurrent;
  const executable=rows.filter(row=>{
    if(row.blockedByEvidence || row.approvalPending || row.activeExperiment) return false;
    if(row.approvalRequired) return false;
    if(availableHours!==null && row.effortHours!==null && row.effortHours>availableHours) return false;
    if(maxConcurrent!==null && !experimentCapacityAvailable) return false;
    return true;
  });
  const nextExecutable=executable[0] || null;
  return {
    schema:'runvara-portfolio-allocation/v1',
    workspaceId:clean(state.workspace?.id,120),
    generatedAt:new Date().toISOString(),
    objective:'prioritise verified contribution efficiency while preserving risk and approval controls',
    portfolio:rows.slice(0,100),
    allocation:{
      nextPound:nextPound ? {opportunityId:nextPound.opportunityId,title:nextPound.title,verifiedContributionPerPound:nextPound.contributionPerPound} : null,
      nextHour:nextHour ? {opportunityId:nextHour.opportunityId,title:nextHour.title,verifiedContributionPerHour:nextHour.contributionPerHour} : null,
      topEvidencePriority:rows[0] ? {opportunityId:rows[0].opportunityId,title:rows[0].title,priorityIndex:rows[0].priorityIndex,verifiedContribution:rows[0].verifiedContribution} : null,
      nextExecutable:nextExecutable ? {opportunityId:nextExecutable.opportunityId,title:nextExecutable.title,priorityIndex:nextExecutable.priorityIndex} : null
    },
    capacity:{
      availableGrowthHours:round(availableHours),
      maxConcurrentGrowthExperiments:maxConcurrent,
      activeGrowthExperiments:activeExperimentCount,
      experimentCapacityAvailable,
      pendingApprovals:(state.approvals || []).filter(item=>item.status==='pending').length,
      openExceptions:(state.exceptions || []).filter(item=>item.present!==false && ['open','acknowledged'].includes(item.status)).length,
      note:availableHours===null ? 'Growth-hour capacity is unknown until explicitly configured; Runvara will not invent available time.' : 'Growth-hour capacity comes from explicit workspace settings.'
    },
    coverage:{
      opportunities:rows.length,
      verifiedContribution:rows.filter(row=>row.verifiedContribution!==null).length,
      poundEfficiencyReady:rows.filter(row=>row.contributionPerPound!==null).length,
      hourEfficiencyReady:rows.filter(row=>row.contributionPerHour!==null).length
    },
    safeguards:{
      noSpendExecuted:true,
      noTimeCommitted:true,
      approvalsPreserved:true,
      unknownCostDoesNotBecomeZero:true,
      unknownEffortDoesNotBecomeZero:true,
      revenueNotUsedAsContribution:true,
      unknownCapacityDoesNotBecomeUnlimited:true,
      approvalRequiredWorkNotMarkedExecutable:true
    }
  };
}
