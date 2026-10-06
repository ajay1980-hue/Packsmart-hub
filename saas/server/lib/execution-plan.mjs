const clean = (value, max = 180) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

function blockerReasons(row, capacity = {}) {
  const reasons = [];
  if (capacity.availableGrowthHours == null) reasons.push('available growth hours are unknown');
  if (row.effortHours == null) reasons.push('estimated effort is unknown');
  if (row.executionCost == null) reasons.push('execution cost is unknown');
  else if (row.executionCost > 0) reasons.push('positive execution cost requires approval');
  if (row.evidenceDecision === 'deprioritise') reasons.push('verified contribution evidence is negative');
  if (row.evidenceDecision === 'needs-more-evidence') reasons.push('more economic evidence is required');
  if (row.approvalPending) reasons.push('owner approval is pending');
  if (row.approvalRequired && !row.approvalPending) reasons.push('owner approval is required before execution');
  if (row.activeExperiment) reasons.push('an experiment is already active');
  if (capacity.maxConcurrentGrowthExperiments !== null && capacity.experimentCapacityAvailable === false) reasons.push('experiment capacity is full');
  if (capacity.availableGrowthHours !== null && row.effortHours !== null && row.effortHours > capacity.availableGrowthHours) reasons.push('estimated effort exceeds available growth hours');
  return reasons;
}

function unlockActions(row, capacity = {}) {
  const actions = [];
  if (capacity.availableGrowthHours == null || row.effortHours == null) actions.push('record available hours and bounded effort');
  if (row.executionCost == null) actions.push('record an evidenced execution cost before planning');
  else if (row.executionCost > 0) actions.push('obtain approval for execution cost');
  if (row.evidenceDecision === 'needs-more-evidence') actions.push('measure and verify contribution impact');
  if (row.evidenceDecision === 'deprioritise') actions.push('do not advance unless new verified evidence changes the result');
  if (row.approvalPending) actions.push('complete owner review in Approval Centre');
  if (row.approvalRequired && !row.approvalPending) actions.push('prepare an approval request with current evidence');
  if (row.activeExperiment) actions.push('complete and verify the active experiment');
  if (capacity.maxConcurrentGrowthExperiments !== null && capacity.experimentCapacityAvailable === false) actions.push('close or complete an active growth experiment');
  if (capacity.availableGrowthHours !== null && row.effortHours !== null && row.effortHours > capacity.availableGrowthHours) actions.push('increase available growth hours or reduce scope');
  if (!actions.length && row.missingAllocationInputs?.length) actions.push('add ' + row.missingAllocationInputs.join(' and ') + ' for stronger allocation guidance');
  return [...new Set(actions)];
}

export function deriveExecutionPlan(portfolio = {}) {
  const rows = Array.isArray(portfolio.portfolio) ? portfolio.portfolio : [];
  const capacity = portfolio.capacity || {};
  const executable = [];
  const blocked = [];
  let remainingHours = capacity.availableGrowthHours ?? null;

  for (const row of rows) {
    const blockers = blockerReasons(row, capacity);
    if (executable.length >= 25) blockers.push('bounded plan step limit reached');
    if (!blockers.length && remainingHours !== null && row.effortHours > remainingHours) blockers.push('cumulative planned effort exceeds remaining growth hours');
    if (!blockers.length && !row.approvalRequired && !row.approvalPending && !row.activeExperiment) {
      remainingHours = Math.max(0, remainingHours - row.effortHours);
      executable.push({
        opportunityId:clean(row.opportunityId,180),
        title:clean(row.title,180),
        kind:clean(row.kind,80),
        priorityIndex:row.priorityIndex ?? null,
        verifiedContribution:row.verifiedContribution ?? null,
        contributionPerPound:row.contributionPerPound ?? null,
        contributionPerHour:row.contributionPerHour ?? null,
        effortHours:row.effortHours ?? null,
        nextAction:'Proceed with internal/read-only preparation. External execution remains disabled.'
      });
    } else {
      blocked.push({
        opportunityId:clean(row.opportunityId,180),
        title:clean(row.title,180),
        kind:clean(row.kind,80),
        priorityIndex:row.priorityIndex ?? null,
        blockers,
        unlocks:[...unlockActions(row,capacity), ...(blockers.some(reason=>reason.includes('cumulative')) ? ['reduce scope or add evidenced growth-hour capacity'] : []), ...(executable.length >= 25 ? ['complete the current bounded plan before adding more steps'] : [])]
      });
    }
  }

  // Retain the value/evidence ordering supplied by the canonical portfolio.
  blocked.sort((a,b)=>(b.priorityIndex||0)-(a.priorityIndex||0) || a.title.localeCompare(b.title));

  return {
    schema:'runvara-execution-plan/v1',
    workspaceId:portfolio.workspaceId || null,
    generatedAt:new Date().toISOString(),
    sequence:executable.slice(0,25).map((item,index)=>({...item,step:index+1})),
    blocked:blocked.slice(0,50),
    summary:{
      executable:executable.length,
      blocked:blocked.length,
      firstExecutable:executable[0]?.opportunityId || null,
      firstBlocked:blocked[0]?.opportunityId || null,
      remainingGrowthHours:remainingHours
    },
    safeguards:{
      externalWrites:false,
      spendCommitted:false,
      approvalRequiredWorkExcludedFromSequence:true,
      activeExperimentsExcludedFromSequence:true,
      negativeVerifiedContributionExcludedFromSequence:true
    }
  };
}
