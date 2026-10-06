import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveLearning} from '../lib/learning-engine.mjs';
import {deriveImpact} from '../lib/impact-engine.mjs';

test('foreign containers, rows and nested impacts cannot become local learning or realised value',()=>{
 const state={workspace:{id:'own'},revenueEngine:{workspaceId:'foreign',experiments:[1,2].map(id=>({id:String(id),kind:'pricing',status:'completed',impact:{verified:true,incrementalContribution:100}}))},
 workRecords:[{id:'foreign-work',workspace_id:'foreign',status:'COMPLETED',evidence:[{verified:true,incrementalContribution:100}]},{id:'foreign-evidence',status:'COMPLETED',evidence:[{tenant_id:'foreign',verified:true,incrementalContribution:100}]},{id:'foreign-impact',status:'COMPLETED',evidence:[{impact:{workspaceId:'foreign',verified:true,incrementalContribution:100}}]}],
 approvals:[{id:'bad',status:'approved',executionStatus:'completed',impact:{workspaceId:'foreign',verified:true,incrementalContribution:100}}]};
 const original=structuredClone(state);
 assert.equal(deriveLearning(state).summary.verifiedLearningEvents,0);
 assert.equal(deriveImpact(state).verified.verifiedValue,0);
 assert.deepEqual(state,original,'scope filtering cannot mutate authoritative records');
});

test('same-tenant verified sources retain full scope and source values',()=>{
 const id='tenant-'+ 'x'.repeat(170);
 const state={workspace:{id},workRecords:[{workspaceId:id,id:'w',kind:'pricing',status:'COMPLETED',evidence:[{workspace_id:id,impact:{tenantId:id,verified:true,incrementalContribution:10}}]}]};
 assert.equal(deriveLearning(state).workspaceId,id);assert.equal(deriveImpact(state).workspaceId,id);
 assert.equal(deriveImpact(state).verified.verifiedValue,10);
 assert.equal(deriveLearning({...state,workspaceId:'foreign'}).summary.verifiedLearningEvents,0);
});

test('conflicting duplicate outcome identities are excluded rather than choosing favourable first values',()=>{
 const state={workspace:{id:'own'},workRecords:[{id:'one',kind:'pricing',status:'COMPLETED',evidence:[{impact:{id:'same',verified:true,incrementalContribution:100}},{impact:{id:'same',verified:true,incrementalContribution:-50}}]}]};
 const learning=deriveLearning(state), impact=deriveImpact(state);
 assert.equal(learning.summary.verifiedLearningEvents,0);assert.equal(learning.summary.conflictingEvidenceExcluded,1);
 assert.equal(impact.verified.verifiedValue,0);assert.equal(impact.coverage.conflictingEvidenceExcluded,1);
});

test('explicit malformed or foreign scope markers never disappear during aggregation',()=>{
 for(const marker of [{tenant:'foreign'},{workspace:null},{workspace:{}},{tenant:{}}]) {
  const state={workspace:{id:'own'},revenueEngine:{experiments:[{id:'e',...marker,kind:'pricing',status:'completed',impact:{verified:true,incrementalContribution:100}}]}};
  assert.equal(deriveLearning(state).summary.verifiedLearningEvents,0);
  assert.equal(deriveImpact(state).verified.verifiedValue,0);
 }
});

test('ambiguous experiment IDs are excluded before verification or terminal-status filtering',()=>{
 const state={workspace:{id:'own'},revenueEngine:{experiments:[{id:'same',kind:'pricing',status:'completed',impact:{verified:true,incrementalContribution:100}},{id:'same',kind:'pricing',status:'measured',impact:{verified:false,incrementalContribution:-50}}]}};
 assert.equal(deriveLearning(state).summary.verifiedLearningEvents,0);
 assert.equal(deriveLearning(state).summary.ambiguousSourceRecordsExcluded,2);
 assert.equal(deriveImpact(state).verified.verifiedValue,0);
});
