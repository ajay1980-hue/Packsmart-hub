import assert from 'node:assert/strict';
import test from 'node:test';
import { deliberateOpportunity, runGrowthCouncil } from '../lib/growth-council.mjs';

const state={workspaceId:'tenant-a',generatedAt:'2026-10-05T15:00:00.000Z'};

test('finance challenges opportunities that do not have evidenced contribution profit',()=>{
  const item={id:'stock-1',kind:'inventory',title:'Reorder stock',score:null,economicEvidenceComplete:false,approvalRequired:true,actionType:'supplier_order'};
  const result=deliberateOpportunity(item,state);
  assert.equal(result.decision,'needs-evidence');
  assert.ok(result.reviews.some(row=>row.agentId==='finance'&&row.verdict==='challenge'));
  assert.ok(result.reviews.some(row=>row.agentId==='compliance'&&row.verdict==='guardrail'));
});

test('evidence-backed risky action is prepared for Approval Centre, never executed',()=>{
  const item={id:'margin-1',kind:'margin',title:'Adjust price',score:220,economicEvidenceComplete:true,approvalRequired:true,actionType:'major_price_change'};
  const result=deliberateOpportunity(item,state);
  assert.equal(result.decision,'prepare-for-approval');
  assert.equal(result.approvalRequired,true);
  assert.equal(result.reviews.some(row=>row.verdict==='challenge'),false);
});

test('growth council preserves tenant scope and never authorises external writes',()=>{
  const queue={opportunities:[
    {id:'safe-1',kind:'operations',title:'Review evidence',score:50,economicEvidenceComplete:true,approvalRequired:false,actionType:'safe'},
    {id:'risky-1',kind:'marketing',title:'Publish campaign',score:100,economicEvidenceComplete:true,approvalRequired:true,actionType:'customer_facing_publish'},
    {id:'unknown-1',kind:'inventory',title:'Buy stock',score:null,economicEvidenceComplete:false,approvalRequired:true,actionType:'supplier_order'}
  ]};
  const council=runGrowthCouncil(state,queue);
  assert.deepEqual(council.commander.recommended,['safe-1']);
  assert.deepEqual(council.commander.prepareForApproval,['risky-1']);
  assert.deepEqual(council.commander.needsEvidence,['unknown-1']);
  assert.equal(council.commander.externalWrites,false);
  assert.equal(council.safeguards.tenantScope,'tenant-a');
});
