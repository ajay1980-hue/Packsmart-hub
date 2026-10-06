import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createPacksmartServer} from '../server.mjs';
import {seedWorkspaceState} from '../lib/store.mjs';
import {createSessionToken} from '../lib/security.mjs';
import {planAutomationRetention} from '../lib/automation-retention.mjs';

async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'runvara-archive-api-'));
  const secret='automation-archive-api-fixture-more-than-thirty-two-characters';
  const server=createPacksmartServer({NODE_ENV:'test',SESSION_SECRET:secret,CREDENTIALS_KEY:secret,SAAS_STATE_FILE:path.join(dir,'state.json'),SHOPIFY_PUBLIC_SYNC_ENABLED:'false'},{schedulerEnabled:false,agentOpsEnabled:false});
  const store=server.packsmart.store, states={};
  for(const id of ['archive-alpha','archive-beta']) {
    const state=seedWorkspaceState({}, {workspaceId:id,email:`${id}@example.test`,passwordHash:'fixture-only'});
    state.users.push({...state.users[0],id:id+'-viewer',email:'viewer-'+id+'@example.test',role:'viewer'});
    await store.save(id,state);states[id]=state;
  }
  const now=new Date(), full={id:'automation_old',ruleId:'marginWatch',status:'COMPLETED',startedAt:new Date(now-120000).toISOString(),completedAt:new Date(now-110000).toISOString(),evidence:[{type:'calculation',id:'profit_check',detail:'<img src=x onerror=alert(1)> is stored text '+ 'Recorded source detail. '.repeat(60)}],risk:'low',spend:0};
  const state={...states['archive-alpha'],automationRuns:[{...full,id:'automation_latest'},full]};
  const candidate=planAutomationRetention(state,{now,recentCompletedLimit:0}).archiveCandidates[0];
  assert.ok(candidate);const ref=candidate.reference;
  let archiveReads=0;
  store.getArchivedAutomationRun=async(workspaceId,runId,archiveRef)=>{
    archiveReads++;
    assert.equal(archiveRef.workspaceId,workspaceId);assert.equal(archiveRef.runId,runId);
    assert.equal(archiveRef.table,'runvara_history');assert.equal(archiveRef.collection,'automationRuns');
    if(workspaceId!=='archive-alpha'||runId!==full.id||archiveRef.recordId!==ref.recordId||archiveRef.sha256!==ref.sha256)return null;
    return structuredClone(full);
  };
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await server.packsmart.drain();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(route,{workspace='archive-alpha',role='owner',authenticated=true}={})=>{
    const user=states[workspace].users.find(item=>item.role===role);
    const token=createSessionToken({userId:user.id,workspaceId:workspace,email:user.email,role,sessionVersion:1},secret);
    const response=await fetch(base+route,{headers:authenticated?{Cookie:`packsmart_session=${token}`}:{}});
    return {status:response.status,body:await response.json()};
  };
  const route=`/api/automation-runs/${encodeURIComponent(full.id)}/archive?recordId=${encodeURIComponent(ref.recordId)}&sha256=${ref.sha256}`;
  return {store,states,request,route,full,ref,get reads(){return archiveReads;}};
}

test('archive evidence uses authenticated tenant and one explicit version lookup without loading workspace state',async t=>{
  const f=await fixture(t);
  f.store.get=async()=>assert.fail('archive reads must use compact authentication, not full state');
  f.store.getIdentity=async id=>f.states[id]?{workspace:f.states[id].workspace,users:f.states[id].users}:null;
  const result=await f.request(f.route);
  assert.equal(result.status,200);assert.equal(result.body.workspaceId,'archive-alpha');
  assert.equal(result.body.runId,f.full.id);assert.equal(result.body.source,'immutable_automation_archive');
  assert.deepEqual(result.body.run,f.full);assert.equal(f.reads,1);
  const viewer=await f.request(f.route,{role:'viewer'});
  assert.equal(viewer.status,200,'same-workspace readers retain existing evidence visibility');
  assert.equal(f.reads,2);
});

test('archive API rejects unauthenticated, tenant/table overrides, malformed and duplicate references',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request(f.route,{authenticated:false})).status,401);
  assert.equal(f.reads,0);
  for(const suffix of ['&workspaceId=archive-beta','&table=users','&collection=users','&sha256='+f.ref.sha256,'&recordId='+encodeURIComponent(f.ref.recordId)]) {
    assert.equal((await f.request(f.route+suffix)).status,400);
  }
  assert.equal((await f.request(f.route.replace(f.ref.sha256,'invalid'))).status,400);
  assert.equal(f.reads,0);
  assert.equal((await f.request(f.route,{workspace:'archive-beta'})).status,404);
  assert.equal((await f.request(f.route.replace('automation_old','automation_other'))).status,404);
});

test('archive retrieval failure is an explicit error rather than fabricated missing evidence',async t=>{
  const f=await fixture(t);
  f.store.getArchivedAutomationRun=async()=>{throw Object.assign(new Error('Archive integrity could not be verified'),{status:503,code:'AUTOMATION_ARCHIVE_INTEGRITY_FAILED'});};
  const result=await f.request(f.route);
  assert.equal(result.status,503);assert.equal(result.body.code,'AUTOMATION_ARCHIVE_INTEGRITY_FAILED');
  assert.equal(Object.hasOwn(result.body,'run'),false);
});


test('explicit archived-evidence reads have a bounded per-user request rate',async t=>{
  const f=await fixture(t);
  for(let i=0;i<10;i++)assert.equal((await f.request(f.route)).status,200);
  const blocked=await f.request(f.route);
  assert.equal(blocked.status,429);assert.equal(blocked.body.code,'AUTOMATION_ARCHIVE_RATE_LIMITED');
  assert.equal(f.reads,10,'the rejected request must not reach archive storage');
});
