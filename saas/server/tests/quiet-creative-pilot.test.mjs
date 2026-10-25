import test from 'node:test';
import assert from 'node:assert/strict';
import { quietCreativeFixture } from './quiet-creative-fixture.mjs';
import { createQuietCreativePilot, CREATIVE_PILOT_BASE } from '../lib/quiet-creative-pilot.mjs';
import { createStartupPolicy } from '../lib/startup-mode.mjs';

test('creative maintenance is default off and rejects broad or conflicting capability descriptors', () => {
  assert.equal(createQuietCreativePilot({}), null);
  for (const change of [{ extra: true }, { maxCostMicros: 0 }, { maxCostMicros: 1.5 }, { inputDigest: 'guess' }, { operationId: 'guess' }, { expiresAt: '2099-01-01T00:00:00.000Z' }, { workspaceId: '*' }]) {
    const f = quietCreativeFixture(); assert.throws(() => createQuietCreativePilot({ ...f.env, RUNVARA_QUIET_CREATIVE_PILOT: JSON.stringify({ ...f.descriptor, ...change }) }), /INVALID/);
  }
  for (const key of ['RUNVARA_QUIET_OWNER_LOGIN','RUNVARA_QUIET_COMMERCE_PREVIEW','RUNVARA_QUIET_APPROVAL_PILOT','RUNVARA_META_PUBLICATION','RUNVARA_CREATIVE_ALLOWANCES']) {
    const f = quietCreativeFixture(); assert.throws(() => createQuietCreativePilot({ ...f.env, [key]: 'enabled/v1' }), /INVALID/);
  }
  const f = quietCreativeFixture(); assert.throws(() => createQuietCreativePilot({ ...f.env, RUNVARA_STARTUP_MODE: 'normal' }), /INVALID/);
});

test('startup permits only dedicated exact methods; broad advance, dashboard, login, Canva and publication remain closed', () => {
  const f=quietCreativeFixture(), p=createStartupPolicy(f.env, ['/']);
  for (const op of ['prepare','decide','submit','observe']) assert.equal(p.allowsRequest('POST', CREATIVE_PILOT_BASE+op),true);
  assert.equal(p.allowsRequest('GET', CREATIVE_PILOT_BASE+'review'), true);
  for (const [method,path] of [['POST',CREATIVE_PILOT_BASE+'review'],['GET',CREATIVE_PILOT_BASE+'submit'],['POST','/api/marketing/campaigns/campaign/advance'],['GET','/api/bootstrap'],['POST','/api/auth/login'],['GET','/api/oauth/canva/callback'],['POST','/api/marketing/publish']]) assert.equal(p.allowsRequest(method,path),false);
});

test('fixed expiry survives restart and backward clocks fail closed', () => {
  const f=quietCreativeFixture();assert.equal(f.pilot.available(),true);f.clock(599001);assert.equal(f.pilot.available(),false);assert.equal(f.restart().available(),false);
  const g=quietCreativeFixture();g.clock(-1);assert.equal(g.pilot.available(),false);g.clock(2);assert.equal(g.pilot.available(),false);
});

test('exact approved source proceeds through protected admission to one explicit 10s720p silent request', async () => {
  const f=quietCreativeFixture();assert.equal((await f.run('review')).allowance,null);assert.equal(f.posts.length,0);
  await f.ready();assert.equal(f.posts.length,0);assert.equal(f.saves.length,0);
  const out=await f.run('submit');assert.equal(out.taskId,'task-synthetic');assert.equal(f.posts.length,1);
  assert.deepEqual(Object.fromEntries(['duration','ratio','audio','version'].map(k=>[k,f.posts[0].body[k]])),{duration:10,ratio:'1280:720',audio:false,version:'2026-07'});
  assert.equal(f.held,600);assert.equal(f.row.reservationStatus,'accepted');assert.equal(f.saves.length,2);
  assert.equal(f.saved.marketing.campaigns[0].creativeRequests[0].safety.phases.generation.status,'accepted');
  assert.equal(f.env.RUNVARA_CREATIVE_ALLOWANCES,undefined);
});

test('known task observation never dispatches again and completion retains the full hold', async () => {
  const f=quietCreativeFixture();await f.ready();await f.run('submit');const result=await f.run('observe');
  assert.equal(result.status,'complete');assert.equal(f.posts.length,1);assert.equal(f.reads.length,1);assert.equal(f.held,600);
  assert.equal(f.row.accountingStatus,'held');assert.equal(f.pilot.status().open,false);
});

test('repeat and restarted submit cannot acquire another permanent claim', async () => {
  const f=quietCreativeFixture();await f.ready();await f.run('submit');f.restart();
  await assert.rejects(f.run('submit'),/ALREADY_CLAIMED/);assert.equal(f.posts.length,1);assert.equal(f.held,600);
});

test('competing submissions cannot issue two provider POSTs', async () => {
  const f=quietCreativeFixture();await f.ready();const results=await Promise.allSettled([f.run('submit'),f.run('submit')]);
  assert.ok(f.posts.length<=1);assert.ok(results.some(r=>r.status==='rejected'));assert.equal(f.held,600);
});

for(const kind of ['tenant','owner','role','session','password','disabled'])test('current '+kind+' cannot enter the scoped provider route',async()=>{
  const f=quietCreativeFixture();if(kind==='tenant')f.auth.session.workspaceId='beta';if(kind==='owner')f.auth.session.sub='other';
  if(kind==='role')f.saved.users[0].role='admin';if(kind==='session')f.saved.users[0].sessionVersion=2;
  if(kind==='password')f.saved.users[0].passwordChangeRequired=true;if(kind==='disabled')f.saved.users[0].active=false;
  await assert.rejects(f.run('prepare'));assert.equal(f.posts.length,0);assert.equal(f.calls.length,0);assert.equal(f.saves.length,0);
});

for(const kind of ['source','account','price','policy','ceiling'])test('changed '+kind+' denies submission before reservation or transport',async()=>{
  const f=quietCreativeFixture();await f.ready();if(kind==='source')f.saved.marketing.campaigns[0].copy.headline='changed';
  if(kind==='account')f.env.RUNWAY_API_KEY='different-synthetic';if(kind==='price')f.row.priceRevision='changed';
  if(kind==='policy')f.row.policyRevision='changed';if(kind==='ceiling')f.row.maxCostMicros++;
  await assert.rejects(f.run('submit'));assert.equal(f.posts.length,0);assert.equal(f.held,0);
});

test('revocation before submission closes the local admission',async()=>{
  const f=quietCreativeFixture();await f.ready();await f.run('decide',{requestId:f.request.id,approvalId:f.row.id,revision:f.row.revision,decision:'revoked'});
  await assert.rejects(f.run('submit'),/CLOSED/);assert.equal(f.posts.length,0);assert.equal(f.held,0);
});

for(const edge of ['expiry','role','input','revision'])test('last transport check denies '+edge+' drift after remote admission and retains hold',async()=>{
  const f=quietCreativeFixture();await f.ready();f.hooks.afterRpc=(name)=>{if(name==='confirm'){
    if(edge==='expiry')f.clock(600000);if(edge==='role')f.saved.users[0].role='viewer';
    if(edge==='input')f.saved.marketing.campaigns[0].copy.headline='changed';if(edge==='revision')f.saved._revision='changed';
  }};
  await assert.rejects(f.run('submit'));assert.equal(f.posts.length,0);assert.equal(f.held,600);
});

test('lost provider acknowledgement remains uncertain across restart; no resubmission or refund',async()=>{
  const f=quietCreativeFixture();await f.ready();f.hooks.provider=()=>{throw Error('synthetic lost response');};
  await assert.rejects(f.run('submit'),/OUTCOME_UNKNOWN/);assert.equal(f.posts.length,1);assert.equal(f.row.reservationStatus,'uncertain');
  f.restart();await assert.rejects(f.run('submit'));assert.equal(f.posts.length,1);assert.equal(f.held,600);
});

test('lost durable claim acknowledgement prevents all provider traffic and leaves a non-replayable hold',async()=>{
  const f=quietCreativeFixture();await f.ready();f.hooks.afterSave=(_,n)=>{if(n===1)throw Error('synthetic lost save acknowledgement');};
  await assert.rejects(f.run('submit'),/PERSISTENCE_UNCERTAIN/);assert.equal(f.posts.length,0);assert.equal(f.held,600);
  delete f.hooks.afterSave;f.restart();await assert.rejects(f.run('submit'));assert.equal(f.posts.length,0);
});

test('an admitted provider receipt is preserved when expiry occurs in flight',async()=>{
  const f=quietCreativeFixture();await f.ready();f.hooks.provider=()=>{f.clock(600000);return Response.json({id:'task-synthetic'});};
  await assert.rejects(f.run('submit'));assert.equal(f.posts.length,1);assert.equal(f.row.upstreamId,'task-synthetic');
  assert.equal(f.saved.marketing.campaigns[0].creativeRequests[0].taskId,'task-synthetic');assert.equal(f.held,600);
});

test('unknown or conflicting saved task is never polled',async()=>{
  const f=quietCreativeFixture();await f.ready();await assert.rejects(f.run('observe'),/TASK_UNVERIFIED/);assert.equal(f.reads.length,0);
  const g=quietCreativeFixture();await g.ready();await g.run('submit');g.saved.marketing.campaigns[0].creativeRequests[0].taskId='other';
  await assert.rejects(g.run('observe'),/TASK_UNVERIFIED/);assert.equal(g.reads.length,0);
});

test('browser cannot override request, ceiling, provider job or decision payload',async()=>{
  for(const body of [{requestId:'other'},{requestId:'x',provider:'canva'},{requestId:'x',maxCostMicros:1},{requestId:'x',taskId:'forged'}]){
    const f=quietCreativeFixture();await assert.rejects(f.run('submit',body),/INPUT_INVALID/);assert.equal(f.calls.length,0);
  }
});

test('guard blocks unrelated state changes and unsupported history compaction before provider submission',async()=>{
  const f=quietCreativeFixture();await f.ready();f.hooks.beforeSave=value=>{value.users[0].email='tampered@example.test';};
  await assert.rejects(f.run('submit'),/STATE_CHANGED/);assert.equal(f.posts.length,0);
  const g=quietCreativeFixture();g.saved.workRecords=Array.from({length:101},()=>({synthetic:true}));await g.ready();
  await assert.rejects(g.run('submit'),/RETENTION_UNSUPPORTED/);assert.equal(g.posts.length,0);
});

test('known-task poll intent cap survives controller restarts and failed acknowledgements',async()=>{
  const f=quietCreativeFixture();await f.ready();await f.run('submit');f.hooks.provider=()=>Response.json({status:'RUNNING',progress:10});
  for(let i=0;i<5;i++){f.restart();await f.run('observe');}
  f.restart();await assert.rejects(f.run('observe'),/READ_LIMIT/);assert.equal(f.reads.length,5);assert.equal(f.posts.length,1);
  assert.equal(f.saved.marketing.campaigns[0].creativeRequests[0].safety.phases.generation.maintenanceObservationAttempts,5);
});

test('failed known task closes the window, preserves error evidence and does not release its hold',async()=>{
  const f=quietCreativeFixture();await f.ready();await f.run('submit');f.hooks.provider=()=>Response.json({status:'FAILED'});
  const result=await f.run('observe');assert.equal(result.status,'failed');assert.equal(f.pilot.status().open,false);assert.equal(f.held,600);
  assert.equal(f.saved.marketing.campaigns[0].creativeRequests[0].errorCode,'RUNWAY_GENERATION_FAILED');
});
