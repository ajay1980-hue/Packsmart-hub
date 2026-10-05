import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveImpact } from '../lib/impact-engine.mjs';

test('impact engine counts only explicit verified realised evidence',()=>{
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
  assert.equal(result.verified.incrementalRevenue,500);
  assert.equal(result.verified.incrementalContribution,250);
  assert.equal(result.verified.contributionProtected,30);
  assert.equal(result.verified.costAvoided,20);
  assert.equal(result.verified.verifiedValue,300);
  assert.equal(result.verified.hoursSaved,1.5);
  assert.equal(result.roi.multiple,3);
  assert.equal(result.activity.verifiedImpactEvents,3);
  assert.equal(result.safeguards.forecastsCountedAsImpact,false);
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
  assert.equal(result.verified.verifiedValue,0);
  assert.equal(result.roi.multiple,0);
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
  assert.equal(result.verified.costAvoided,25);
  assert.equal(result.activity.verifiedImpactEvents,1);
  assert.equal(JSON.stringify(result).includes('tenant-a'),false);
});
