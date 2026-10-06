import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveLearning } from '../lib/learning-engine.mjs';

test('legacy reviewed samples never confer comparable learning priors', () => {
  const state={
    workspace:{id:'tenant-a'},
    revenueEngine:{experiments:[
      {id:'e1',kind:'retention',status:'completed',impact:{verified:true,incrementalContribution:80,method:'holdout'}},
      {id:'e2',kind:'retention',status:'measured',impact:{status:'verified',incrementalContribution:120,method:'before-after'}},
      {id:'e3',kind:'retention',status:'running',impact:{verified:true,incrementalContribution:999}},
      {id:'e4',kind:'conversion',status:'completed',impact:{verified:false,incrementalContribution:500}}
    ]},
    workRecords:[]
  };
  const result=deriveLearning(state);
  assert.deepEqual(result.priors,[]);
  assert.equal(result.summary.verifiedLearningEvents,0);
  assert.equal(result.summary.legacyRecordedEvents,3);
  assert.equal(result.summary.legacyReviewedEvents,2);
  assert.equal(result.summary.domainsUsableForGuidance,0);
  assert.equal(result.legacy.evidence.find(row=>row.sourceId==='e1').metrics.incrementalContribution,'80');
  assert.equal(result.outcomeCoverage.publicationProofAvailable,false);
  assert.equal(result.safeguards.immutableActionDomainEvidenceRequired,true);
  assert.equal(result.safeguards.forecastsExcluded,true);
  assert.equal(result.safeguards.externalWrites,false);
});

test('one verified result remains descriptive and cannot set guidance', () => {
  const state={
    workspace:{id:'tenant-b'},
    revenueEngine:{experiments:[
      {id:'e1',kind:'pricing',status:'closed',impact:{verified:true,incrementalContribution:-15}}
    ]},
    workRecords:[]
  };
  const result=deriveLearning(state);
  assert.deepEqual(result.priors,[]);
  assert.equal(result.summary.verifiedLearningEvents,0);
  assert.equal(result.legacy.recordedEvents,1);
  assert.equal(result.legacy.evidence[0].metrics.incrementalContribution,'-15');
  assert.equal(result.legacy.evidence[0].qualified,false);
  assert.equal(result.safeguards.singleObservationCannotSetGuidance,true);
});

test('duplicate evidence IDs are not double counted and tenant identity stays local', () => {
  const state={
    workspace:{id:'tenant-c'},
    revenueEngine:{experiments:[]},
    workRecords:[
      {id:'w1',kind:'inventory',status:'COMPLETED',evidence:[
        {id:'same',impact:{id:'same',verified:true,incrementalContribution:25,opportunityKind:'inventory'}},
        {id:'same',impact:{id:'same',verified:true,incrementalContribution:25,opportunityKind:'inventory'}}
      ]},
      {id:'w2',kind:'inventory',status:'COMPLETED',evidence:[
        {impact:{id:'second',verified:true,incrementalContribution:35,opportunityKind:'inventory'}}
      ]}
    ]
  };
  const result=deriveLearning(state);
  assert.equal(result.workspaceId,'tenant-c');
  assert.equal(result.summary.verifiedLearningEvents,0);
  assert.deepEqual(result.priors,[]);
  assert.equal(result.legacy.recordedEvents,2);
  assert.deepEqual(result.evidence.map(row=>row.metrics.incrementalContribution),['25','35']);
  assert.equal(JSON.stringify(result).includes('tenant-a'),false);
});
