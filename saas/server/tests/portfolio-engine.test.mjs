import assert from 'node:assert/strict';
import test from 'node:test';
import { derivePortfolioAllocation } from '../lib/portfolio-engine.mjs';

test('portfolio does not rank legacy contribution flags as qualified financial evidence', () => {
  const state={
    workspace:{id:'tenant-portfolio'},
    opportunities:[
      {id:'o1',title:'Retention play',kind:'retention',present:true,status:'open',confidence:.8,risk:'low',effort:'low',experimentId:'e1'},
      {id:'o2',title:'Conversion idea',kind:'conversion',present:true,status:'open',confidence:.9,risk:'low',effort:'low',learning:{samples:8,positiveRatePercent:90}}
    ],
    revenueEngine:{experiments:[
      {id:'e1',opportunityId:'o1',status:'completed',impact:{verified:true,incrementalContribution:120,incrementalRevenue:500}}
    ]}
  };
  const result=derivePortfolioAllocation(state);
  assert.equal(result.portfolio[0].opportunityId,'o2','ordinary recorded confidence is not overridden by an unqualified historical amount');
  assert.ok(result.portfolio.every(row=>row.verifiedContribution===null));
  assert.equal(result.coverage.verifiedContribution,0);
  assert.equal(state.revenueEngine.experiments[0].impact.incrementalContribution,120);
  const changed=structuredClone(state); changed.revenueEngine.experiments[0].impact.incrementalContribution=-999999;
  assert.deepEqual(derivePortfolioAllocation(changed).portfolio,result.portfolio,'legacy sign and amount never drive allocation');
  assert.equal(result.portfolio[0].contributionPerPound,null);
  assert.equal(result.portfolio[0].contributionPerHour,null);
  assert.equal(result.allocation.nextPound,null);
  assert.equal(result.allocation.nextHour,null);
  assert.equal(result.safeguards.unknownCostDoesNotBecomeZero,true);
});

test('known planned costs and effort cannot turn legacy historical contribution into efficiency', () => {
  const state={
    workspace:{id:'tenant-efficiency'},
    opportunities:[
      {id:'o1',title:'A',kind:'retention',present:true,status:'open',confidence:.8,risk:'low',effort:'low',experimentId:'e1',executionCost:20,effortHours:4},
      {id:'o2',title:'B',kind:'conversion',present:true,status:'open',confidence:.8,risk:'low',effort:'low',experimentId:'e2',executionCost:50,effortHours:1}
    ],
    revenueEngine:{experiments:[
      {id:'e1',opportunityId:'o1',status:'completed',impact:{verified:true,incrementalContribution:100}},
      {id:'e2',opportunityId:'o2',status:'completed',impact:{verified:true,incrementalContribution:150}}
    ]}
  };
  const result=derivePortfolioAllocation(state);
  assert.equal(result.allocation.nextPound,null);
  assert.equal(result.allocation.nextHour,null);
  assert.deepEqual(result.portfolio.map(row=>[row.opportunityId,row.executionCost,row.effortHours]),[['o1',20,4],['o2',50,1]]);
  assert.ok(result.portfolio.every(row=>row.contributionPerPound===null && row.contributionPerHour===null && row.verifiedContribution===null));
  assert.equal(result.coverage.poundEfficiencyReady,0); assert.equal(result.coverage.hourEfficiencyReady,0);
  assert.ok(result.portfolio.every(row=>row.approvalRequired),'known positive costs retain approval gates');
});

test('revenue alone never becomes contribution evidence', () => {
  const state={
    workspace:{id:'tenant-revenue'},
    opportunities:[{id:'o1',title:'Revenue-only',kind:'conversion',present:true,status:'open',confidence:.9,risk:'low',effort:'low',experimentId:'e1'}],
    revenueEngine:{experiments:[{id:'e1',opportunityId:'o1',status:'completed',impact:{verified:true,incrementalRevenue:1000}}]}
  };
  const result=derivePortfolioAllocation(state);
  assert.equal(result.portfolio[0].verifiedContribution,null, 'revenue-only evidence must remain unknown contribution');
  assert.equal(result.safeguards.revenueNotUsedAsContribution,true);
  assert.equal(result.allocation.nextPound,null);
});


test('capacity-aware portfolio excludes approval-gated and already-active work from next executable', () => {
  const state={
    workspace:{id:'tenant-capacity'},
    settings:{growthCapacityHours:4,maxConcurrentGrowthExperiments:2},
    approvals:[{id:'a1',status:'pending',payload:{opportunityId:'o1'}}],
    exceptions:[],
    opportunities:[
      {id:'o1',title:'Approval-bound',kind:'pricing',present:true,status:'open',confidence:.9,risk:'low',effort:'low',effortHours:1,approvalRequired:true},
      {id:'o2',title:'Already testing',kind:'retention',present:true,status:'open',confidence:.8,risk:'low',effort:'low',effortHours:1,experimentId:'e2'},
      {id:'o3',title:'Executable analysis',kind:'operations',present:true,status:'open',confidence:.7,risk:'low',effort:'low',effortHours:2,executionCost:0,approvalRequired:false}
    ],
    revenueEngine:{experiments:[{id:'e2',opportunityId:'o2',status:'running'}]}
  };
  const result=derivePortfolioAllocation(state);
  assert.equal(result.allocation.nextExecutable.opportunityId,'o3');
  assert.equal(result.capacity.activeGrowthExperiments,1);
  assert.equal(result.capacity.experimentCapacityAvailable,true);
  assert.equal(result.safeguards.approvalRequiredWorkNotMarkedExecutable,true);
});

test('explicit growth-hour capacity blocks work that does not fit', () => {
  const state={
    workspace:{id:'tenant-hours'},
    settings:{growthCapacityHours:1,maxConcurrentGrowthExperiments:3},
    approvals:[],exceptions:[],
    opportunities:[{id:'o1',title:'Two-hour task',kind:'operations',present:true,status:'open',confidence:.8,risk:'low',effort:'low',effortHours:2,executionCost:0,approvalRequired:false}],
    revenueEngine:{experiments:[]}
  };
  const result=derivePortfolioAllocation(state);
  assert.equal(result.allocation.nextExecutable,null);
  assert.equal(result.capacity.availableGrowthHours,1);
});

test('unknown hour capacity is surfaced as unknown instead of invented', () => {
  const state={
    workspace:{id:'tenant-unknown'},
    settings:{},
    approvals:[],exceptions:[],
    opportunities:[{id:'o1',title:'Read-only analysis',kind:'operations',present:true,status:'open',confidence:.8,risk:'low',effort:'low',effortHours:1,approvalRequired:false}],
    revenueEngine:{experiments:[]}
  };
  const result=derivePortfolioAllocation(state);
  assert.equal(result.capacity.availableGrowthHours,null);
  assert.match(result.capacity.note,/unknown/i);
  assert.equal(result.safeguards.unknownCapacityDoesNotBecomeUnlimited,true);
});

test('fractional positive costs and effort never round to free or zero-hour work', () => {
  const result=derivePortfolioAllocation({workspace:{id:'fractional'},settings:{growthCapacityHours:0.004,maxConcurrentGrowthExperiments:1},opportunities:[{id:'tiny',title:'Tiny',kind:'operations',executionCost:0.004,effortHours:0.004,approvalRequired:false}],revenueEngine:{experiments:[]}});
  assert.equal(result.portfolio[0].executionCost,0.004);assert.equal(result.portfolio[0].effortHours,0.004);assert.equal(result.portfolio[0].approvalRequired,true);
  assert.equal(result.capacity.availableGrowthHours,0.004);assert.equal(result.allocation.nextExecutable,null);
});

test('foreign approval and experiment metadata cannot change tenant capacity', () => {
  const result=derivePortfolioAllocation({workspace:{id:'owner'},settings:{growthCapacityHours:2,maxConcurrentGrowthExperiments:1},opportunities:[{id:'o1',title:'Own analysis',kind:'operations',executionCost:0,effortHours:1,approvalRequired:false}],approvals:[{workspaceId:'foreign',status:'pending',payload:{opportunityId:'o1'}}],revenueEngine:{workspaceId:'foreign',experiments:[{opportunityId:'o1',status:'running'}]}});
  assert.equal(result.capacity.pendingApprovals,0);assert.equal(result.capacity.activeGrowthExperiments,0);assert.equal(result.allocation.nextExecutable.opportunityId,'o1');
});
