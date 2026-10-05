import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveExecutionPlan } from '../lib/execution-plan.mjs';

test('execution plan sequences only safe executable work', () => {
  const plan=deriveExecutionPlan({
    portfolio:[
      {opportunityId:'safe-1',title:'Safe analysis',kind:'operations',priorityIndex:.8,approvalRequired:false,approvalPending:false,activeExperiment:false,evidenceDecision:null,effortHours:1,missingAllocationInputs:[]},
      {opportunityId:'approval-1',title:'Publish campaign',kind:'marketing',priorityIndex:.9,approvalRequired:true,approvalPending:false,activeExperiment:false,evidenceDecision:null,effortHours:1,missingAllocationInputs:[]}
    ],
    capacity:{availableGrowthHours:4,maxConcurrentGrowthExperiments:2,experimentCapacityAvailable:true}
  });
  assert.deepEqual(plan.sequence.map(x=>x.opportunityId),['safe-1']);
  assert.equal(plan.blocked[0].opportunityId,'approval-1');
  assert.ok(plan.blocked[0].blockers.some(x=>/approval/i.test(x)));
  assert.equal(plan.safeguards.externalWrites,false);
});

test('negative verified contribution never enters execution sequence', () => {
  const plan=deriveExecutionPlan({
    portfolio:[
      {opportunityId:'bad-1',title:'Bad test',kind:'pricing',priorityIndex:.95,approvalRequired:false,approvalPending:false,activeExperiment:false,evidenceDecision:'deprioritise',effortHours:1,missingAllocationInputs:[]}
    ],
    capacity:{availableGrowthHours:4,maxConcurrentGrowthExperiments:2,experimentCapacityAvailable:true}
  });
  assert.equal(plan.sequence.length,0);
  assert.equal(plan.blocked[0].opportunityId,'bad-1');
  assert.equal(plan.safeguards.negativeVerifiedContributionExcludedFromSequence,true);
});

test('capacity and experiment blockers explain how to unlock work', () => {
  const plan=deriveExecutionPlan({
    portfolio:[
      {opportunityId:'wait-1',title:'Experiment idea',kind:'retention',priorityIndex:.7,approvalRequired:false,approvalPending:false,activeExperiment:true,evidenceDecision:null,effortHours:3,missingAllocationInputs:[]}
    ],
    capacity:{availableGrowthHours:2,maxConcurrentGrowthExperiments:1,experimentCapacityAvailable:false}
  });
  assert.equal(plan.sequence.length,0);
  assert.ok(plan.blocked[0].blockers.length>=2);
  assert.ok(plan.blocked[0].unlocks.some(x=>/active experiment/i.test(x)));
});
