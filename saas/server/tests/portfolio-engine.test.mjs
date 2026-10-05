import assert from 'node:assert/strict';
import test from 'node:test';
import { derivePortfolioAllocation } from '../lib/portfolio-engine.mjs';

test('portfolio ranks verified contribution ahead of unverified ideas without inventing spend efficiency', () => {
  const state={
    workspace:{id:'tenant-portfolio'},
    opportunities:[
      {id:'o1',title:'Retention play',kind:'retention',present:true,status:'open',confidence:.8,risk:'low',effort:'low',experimentId:'e1'},
      {id:'o2',title:'Conversion idea',kind:'conversion',present:true,status:'open',confidence:.9,risk:'low',effort:'low',learning:{samples:8,positiveRatePercent:90}}
    ],
    revenueEngine:{experiments:[
      {id:'e1',status:'completed',impact:{verified:true,incrementalContribution:120,incrementalRevenue:500}}
    ]}
  };
  const result=derivePortfolioAllocation(state);
  assert.equal(result.portfolio[0].opportunityId,'o1');
  assert.equal(result.portfolio[0].verifiedContribution,120);
  assert.equal(result.portfolio[0].contributionPerPound,null);
  assert.equal(result.portfolio[0].contributionPerHour,null);
  assert.equal(result.allocation.nextPound,null);
  assert.equal(result.allocation.nextHour,null);
  assert.equal(result.safeguards.unknownCostDoesNotBecomeZero,true);
});

test('next pound and next hour use explicit execution cost and effort only', () => {
  const state={
    workspace:{id:'tenant-efficiency'},
    opportunities:[
      {id:'o1',title:'A',kind:'retention',present:true,status:'open',confidence:.8,risk:'low',effort:'low',experimentId:'e1',executionCost:20,effortHours:4},
      {id:'o2',title:'B',kind:'conversion',present:true,status:'open',confidence:.8,risk:'low',effort:'low',experimentId:'e2',executionCost:50,effortHours:1}
    ],
    revenueEngine:{experiments:[
      {id:'e1',status:'completed',impact:{verified:true,incrementalContribution:100}},
      {id:'e2',status:'completed',impact:{verified:true,incrementalContribution:150}}
    ]}
  };
  const result=derivePortfolioAllocation(state);
  assert.equal(result.allocation.nextPound.opportunityId,'o1');
  assert.equal(result.allocation.nextPound.verifiedContributionPerPound,5);
  assert.equal(result.allocation.nextHour.opportunityId,'o2');
  assert.equal(result.allocation.nextHour.verifiedContributionPerHour,150);
});

test('revenue alone never becomes contribution evidence', () => {
  const state={
    workspace:{id:'tenant-revenue'},
    opportunities:[{id:'o1',title:'Revenue-only',kind:'conversion',present:true,status:'open',confidence:.9,risk:'low',effort:'low',experimentId:'e1'}],
    revenueEngine:{experiments:[{id:'e1',status:'completed',impact:{verified:true,incrementalRevenue:1000}}]}
  };
  const result=derivePortfolioAllocation(state);
  assert.equal(result.portfolio[0].verifiedContribution,0);
  assert.equal(result.safeguards.revenueNotUsedAsContribution,true);
  assert.equal(result.allocation.nextPound,null);
});
