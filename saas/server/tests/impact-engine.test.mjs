import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveImpact } from '../lib/impact-engine.mjs';

test('legacy measurements remain visible and unqualified without committed publication proof',()=>{
  const state={
    workspace:{id:'tenant-a'},
    subscription:{monthlyPriceGbp:100},
    workRecords:[
      {id:'w1',status:'COMPLETED',evidence:[{type:'result',impact:{verified:true,incrementalRevenue:500,incrementalContribution:180,minutesSaved:90,method:'before-after'}}]},
      {id:'w2',status:'COMPLETED',evidence:[{type:'forecast',impact:{verified:false,incrementalContribution:9999,minutesSaved:9999}}]},
      {id:'w3',status:'PLANNED',evidence:[{impact:{verified:true,incrementalContribution:500}}]}
    ],
    automationRuns:[{id:'a1',status:'COMPLETED'}],
    revenueEngine:{experiments:[
      {id:'e1',status:'completed',impact:{verified:true,incrementalContribution:70,costAvoided:20,method:'holdout'}},
      {id:'e2',status:'running',impact:{verified:true,incrementalContribution:400}}
    ]},
    approvals:[
      {id:'p1',status:'approved',executionStatus:'executed',impact:{verified:true,contributionProtected:30}},
      {id:'p2',status:'pending',financialImpact:10000,impact:{verified:true,incrementalContribution:10000}}
    ]
  };
  const result=deriveImpact(state);
  assert.deepEqual(result.verified, {incrementalRevenue:null,incrementalContribution:null,contributionProtected:null,costAvoided:null,verifiedValue:null,hoursSaved:null});
  assert.deepEqual(result.roi,{subscriptionCost:null,verifiedValue:null,multiple:null});
  assert.equal(result.activity.verifiedImpactEvents,0);
  assert.equal(result.activity.completedWork,2);
  assert.equal(result.activity.completedAutomations,1);
  assert.equal(result.activity.completedExperiments,1);
  assert.equal(result.legacy.recordedEvents,4);
  assert.equal(result.legacy.reviewedEvents,3);
  assert.equal(result.legacy.qualified,false);
  assert.equal(result.evidence.find(row=>row.sourceId==='w1').metrics.incrementalContribution,'180');
  assert.equal(result.evidence.find(row=>row.sourceId==='w1').metrics.minutesSaved,'90');
  assert.ok(result.evidence.every(row=>row.qualified===false && row.currency===null && row.window===null));
  assert.equal(result.outcomeCoverage.publicationProofAvailable,false);
  assert.equal(result.safeguards.forecastsCountedAsImpact,false);
  assert.equal(state.workRecords[0].evidence[0].impact.incrementalContribution,180,'stored legacy amounts are preserved');
});

test('estimated approval financial impact and recommendations never become realised ROI',()=>{
  const state={
    workspace:{id:'tenant-b'},
    subscription:{monthlyPriceGbp:299},
    workRecords:[],
    automationRuns:[],
    revenueEngine:{experiments:[]},
    approvals:[{id:'p1',status:'approved',financialImpact:5000,expectedBenefit:'£5000 expected',executionStatus:'executed'}],
    opportunities:[{id:'o1',expectedContributionProfit:1000,score:800}]
  };
  const result=deriveImpact(state);
  assert.equal(result.verified.verifiedValue,null);
  assert.equal(result.roi.multiple,null);
  assert.equal(result.activity.verifiedImpactEvents,0);
});

test('impact evidence is tenant-local and duplicate evidence IDs are not double counted',()=>{
  const state={
    workspace:{id:'tenant-c'},
    workRecords:[{id:'w1',status:'COMPLETED',evidence:[
      {impact:{id:'same',verified:true,costAvoided:25}},
      {impact:{id:'same',verified:true,costAvoided:25}}
    ]}],
    automationRuns:[],revenueEngine:{experiments:[]},approvals:[]
  };
  const result=deriveImpact(state);
  assert.equal(result.workspaceId,'tenant-c');
  assert.equal(result.verified.costAvoided,null);
  assert.equal(result.activity.verifiedImpactEvents,0);
  assert.equal(result.legacy.recordedEvents,1);
  assert.equal(result.evidence[0].metrics.costAvoided,'25');
  assert.equal(result.evidence[0].metrics.incrementalContribution,null);
  assert.equal(JSON.stringify(result).includes('tenant-a'),false);
});

test('qualification does not trim or relabel malformed or foreign root scope',()=>{
  for (const state of [{workspace:{id:' tenant-a '}},{workspace:{id:'tenant-a'},tenantId:'foreign'},{workspace:{id:'tenant-a',tenantId:'foreign'}}]) {
    assert.throws(()=>deriveImpact(state,{outcomeSnapshot:{versions:[],publicationBoundary:{}}}),{code:'WORKSPACE_MISMATCH'});
  }
});

test('legacy missing and explicit zero stay distinguishable without becoming qualified sums',()=>{
  const state={workspace:{id:'tenant-zero'},revenueEngine:{experiments:[
    {id:'zero',status:'completed',impact:{verified:true,incrementalContribution:0,minutesSaved:0}},
    {id:'unknown',status:'completed',impact:{verified:true}},
    {id:'negative',status:'completed',impact:{verified:true,incrementalContribution:'-0.000001'}}
  ]}};
  const before=structuredClone(state),result=deriveImpact(state);
  assert.equal(result.legacy.recordedEvents,3);
  assert.equal(result.evidence.find(row=>row.sourceId==='zero').metrics.incrementalContribution,'0');
  assert.equal(result.evidence.find(row=>row.sourceId==='zero').metrics.minutesSaved,'0');
  assert.equal(result.evidence.find(row=>row.sourceId==='unknown').metrics.incrementalContribution,null);
  assert.equal(result.evidence.find(row=>row.sourceId==='negative').metrics.incrementalContribution,'-0.000001');
  assert.equal(result.verified.incrementalContribution,null); assert.equal(result.verified.hoursSaved,null);
  assert.deepEqual(state,before);
});
