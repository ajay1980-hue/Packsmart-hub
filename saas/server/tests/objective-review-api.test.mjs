import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { upsertBusinessObjective } from '../lib/business-objectives.mjs';

async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'runvara-objective-api-'));
  const secret='objective-api-test-secret-more-than-thirty-two-characters';
  const server=createPacksmartServer({NODE_ENV:'test',SESSION_SECRET:secret,CREDENTIALS_KEY:secret,SAAS_STATE_FILE:path.join(dir,'state.json'),SHOPIFY_PUBLIC_SYNC_ENABLED:'false'}, {schedulerEnabled:false,agentOpsEnabled:false});
  const store=server.packsmart.store, states={};
  const now=new Date(), end=new Date(now.getTime()+7*86400000);
  for(const id of ['objective-alpha','objective-beta']) {
    const state=seedWorkspaceState({}, {workspaceId:id,email:`${id}@example.test`,passwordHash:'synthetic-only'});
    state.products=[];state.opportunities=[];state.approvals=[];state.exceptions=[];state.decisions=[];
    state.users.push({...state.users[0],id:`${id}-viewer`,email:`viewer-${id}@example.test`,role:'viewer'});
    state.users.push({...state.users[0],id:`${id}-admin`,email:`admin-${id}@example.test`,role:'admin'});
    const objective=upsertBusinessObjective(state,{title:'Review packaging profitability',metric:'contribution_profit',baseline:100,target:125,direction:'increase',startsAt:new Date(now.getTime()-60000).toISOString(),endsAt:end.toISOString(),limits:{currency:'GBP',profitFirst:true,maxMonthlyAdBudget:0}}, {workspaceId:id,now:now.toISOString()});
    await store.save(id,state);states[id]={state,objective};
  }
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await server.packsmart.drain();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const auth=(workspace='objective-alpha',role='owner')=>{
    const user=states[workspace].state.users.find(user=>user.role===role);
    const token=createSessionToken({userId:user.id,workspaceId:workspace,email:user.email,role:user.role,sessionVersion:1},secret);
    return {token,csrf:verifySessionToken(token,secret).csrf};
  };
  const request=async(route,{method='GET',body,identity=auth(),csrf=true}={})=>{
    const headers={};if(identity){headers.Cookie=`packsmart_session=${identity.token}`;if(csrf)headers['X-CSRF-Token']=identity.csrf;}
    if(body!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  const objective=states['objective-alpha'].objective;
  return {server,store,states,auth,request,input:{objectiveId:objective.id,objectiveRevision:objective.revision}};
}

test('objective review API persists a diagnostic in the job only and returns compact opt-in status',async t=>{
  const {server,store,request,input}=await fixture(t);
  const originalSave=store.save.bind(store);let writes=0;
  store.save=async(...args)=>{writes++;return originalSave(...args);};
  server.packsmart.aiProvider.enhanceCommander=async()=>assert.fail('objective review must never invoke a model');
  const before=await store.get('objective-alpha');
  const queued=await request('/api/business-objectives/reviews',{method:'POST',body:input});
  assert.equal(queued.status,202);assert.equal(queued.body.job.type,'objective_prepare');
  const duplicate=await request('/api/business-objectives/reviews',{method:'POST',body:input});
  assert.equal(duplicate.status,202);assert.equal(duplicate.body.job.id,queued.body.job.id);
  await server.packsmart.agentOps.tick();
  const route='/api/business-objectives/reviews/'+queued.body.job.id;
  const compact=await request(route);
  assert.equal(compact.status,200);assert.equal(compact.body.job.status,'succeeded');assert.equal(compact.body.job.reportAvailable,true);
  assert.equal(Object.hasOwn(compact.body,'report'),false);assert.ok(Buffer.byteLength(JSON.stringify(compact.body))<=2048);
  const full=await request(route+'?report=true');
  assert.equal(full.status,200);assert.equal(full.body.report.jobId,queued.body.job.id);
  assert.equal(full.body.report.commercialReady,false);assert.equal(full.body.report.safeguards.externalWrites,false);
  assert.equal(full.body.report.safeguards.modelCalls,0);assert.equal(full.body.report.reportCompleted,true);
  assert.equal(full.body.report.sourceAsOf.financialObservedAt,null);assert.equal(full.body.stale,false);
  assert.equal(writes,0,'reviewing must not save the entire business snapshot');
  const after=await store.get('objective-alpha');
  for(const key of ['audit','agentRuns','workRecords','approvals'])assert.deepEqual(after[key],before[key]);
  // Production status authorization uses an identity projection, not the 1.5MB snapshot.
  const fullGet=store.get.bind(store), identity=structuredClone(after);
  store.getIdentity=async workspaceId=>workspaceId==='objective-alpha'?{workspace:identity.workspace,users:identity.users}:null;
  store.get=async()=>assert.fail('compact status must not load full workspace evidence');
  assert.equal((await request(route)).status,200);
  store.get=fullGet;
  after.businessObjectives[0].revision++;
  await originalSave('objective-alpha',after);
  const historical=await request(route+'?report=true');
  assert.equal(historical.status,200);assert.equal(historical.body.stale,true);
  assert.equal(historical.body.report.objectiveRevision,input.objectiveRevision);
});

test('objective review API enforces auth, CSRF, roles, tenant scope and strict server-authored inputs',async t=>{
  const {request,auth,input}=await fixture(t);
  const route='/api/business-objectives/reviews';
  assert.equal((await request(route,{method:'POST',body:input,identity:null})).status,401);
  assert.equal((await request(route,{method:'POST',body:input,csrf:false})).status,403);
  assert.equal((await request(route,{method:'POST',body:input,identity:auth('objective-alpha','viewer')})).status,403);
  for(const extra of [{workspaceId:'objective-beta'},{provider:'openai'},{aiUnits:0},{idempotencyKey:'mine'},{payload:{}},{approvalRequired:false}]){
    assert.equal((await request(route,{method:'POST',body:{...input,...extra}})).status,400);
  }
  const queued=await request(route,{method:'POST',body:input});assert.equal(queued.status,202);
  const jobRoute=route+'/'+queued.body.job.id;
  assert.equal((await request(jobRoute,{identity:auth('objective-beta')})).status,404);
  assert.equal((await request(jobRoute,{identity:auth('objective-alpha','viewer')})).status,403);
  assert.equal((await request(jobRoute+'?workspaceId=objective-beta')).status,400);
  assert.equal((await request(jobRoute+'?report=all')).status,400);
  assert.equal((await request(route,{method:'POST',body:input,identity:auth('objective-beta')})).status,404);
});

test('explicit objective-review requests are rate bounded even when the queue deduplicates them',async t=>{
  const {request,input}=await fixture(t);
  for(let i=0;i<3;i++)assert.equal((await request('/api/business-objectives/reviews',{method:'POST',body:input})).status,202);
  const denied=await request('/api/business-objectives/reviews',{method:'POST',body:input});
  assert.equal(denied.status,429);assert.equal(denied.body.code,'OBJECTIVE_REVIEW_RATE_LIMITED');
});


test('workspace admins may prepare a diagnostic without receiving commercial execution authority',async t=>{
  const {server,request,auth,input}=await fixture(t);
  const identity=auth('objective-alpha','admin');
  const queued=await request('/api/business-objectives/reviews',{method:'POST',body:input,identity});
  assert.equal(queued.status,202);
  await server.packsmart.agentOps.tick();
  const result=await request('/api/business-objectives/reviews/'+queued.body.job.id+'?report=true',{identity});
  assert.equal(result.status,200);assert.equal(result.body.report.commercialReady,false);
  assert.equal(result.body.report.safeguards.externalExecutionAllowed,false);
});
