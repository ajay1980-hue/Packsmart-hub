import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { recoveryFixture } from './shopify-order-recovery-fixture.mjs';
import { prepareOrderRecoveryTransaction, commitOrderRecoveryTransaction, prepareOrderRecoveryContext } from '../lib/shopify-order-recovery-store.mjs';
import { createShopifyOrderRecoveryBinding } from '../lib/shopify-order-recovery.mjs';
import { automaticConnectionAreas, beginConnectionSync, connectionDoctorState } from '../lib/connection-centre.mjs';
import { queueFirstSync } from '../lib/connection-doctor.mjs';
import { encryptCredentials } from '../lib/security.mjs';

test('actual store and importer complete a bounded traversal preserving original freshness, credentials, unrelated failures and costs',async()=>{
  const f=recoveryFixture(),state=await f.get();
  state.connectionFirstSync={shopify:{status:'partial',startedAt:new Date().toISOString(),actor:f.actor.id,identityVerifiedAt:new Date().toISOString(),areas:{products:'failed',orders:'pending'},failures:{products:{code:'PRODUCT_FAILED'}},previousSuccessfulSyncAt:'2026-09-01T00:00:00.000Z'}};
  state.integrationStatus.shopify={status:'degraded',lastError:'PRODUCT_FAILED',areaSuccessAt:{products:'2026-09-01T00:00:00.000Z'}};
  state.orders=[{id:'gid://shopify/Order/0',externalId:'gid://shopify/Order/0',provider:'shopify',total:1,lineItems:[],actualShippingCost:7,costOverrides:{actualShippingCost:7}},{id:'old-order',provider:'shopify',total:9,lineItems:[]}];
  await f.store.save(state.workspace.id,state); const current=await f.get(),credentials=current.connections[0].encryptedCredentials;
  const p=await f.runner.preview(current,f.actor);assert.equal(p.canStart,true);assert.equal(p.stage,null);assert.doesNotMatch(JSON.stringify(p),/encryptedCredentials|sourceGeneration|stageId|sessionDigest/);
  const result=await f.runner.run(current,f.actor,'start',{selection:p.selection});
  assert.equal(result.status,'committed',JSON.stringify(result));
  const next=f.snapshot();assert.equal(next.integrationStatus.shopify.areaSuccessAt.orders,p.originalStartedAt);assert.equal(next.integrationStatus.shopify.areaSuccessAt.products,'2026-09-01T00:00:00.000Z');assert.equal(next.integrationStatus.shopify.lastSyncAt,p.originalStartedAt);
  assert.equal(next.connectionFirstSync.shopify.status,'partial');assert.equal(next.connectionFirstSync.shopify.areas.products,'failed');assert.equal(next.integrationStatus.shopify.lastError,'PRODUCT_FAILED');assert.equal(next.integrationStatus.shopify.status,'degraded');
  assert.equal(next.connections[0].encryptedCredentials,credentials);assert.equal(next.orders.find(o=>o.id==='gid://shopify/Order/0').actualShippingCost,7);assert.ok(next.orders.some(o=>o.id==='old-order'));
  assert.equal(next.connectionDoctor.shopify.attempts,1);assert.equal(f.stages.size,0);assert.equal(f.metrics.provider.calls,2);assert.equal(f.metrics.authority.calls,5);
  assert.equal(f.metrics.stage_mutation.calls,4);assert.equal(f.metrics.summary.calls,1);assert.equal(f.metrics.full.calls,1);
});
test('fresh selection is one-use, current-session and exact-revision bound before hydration/provider work',async()=>{
  for(const change of ['reused','revision','session','extra']) {
    const f=recoveryFixture({count:0}),state=await f.get(),p=await f.runner.preview(state,f.actor),before=f.calls.length;
    if(change==='revision')state._revision=crypto.randomUUID();
    const actor=change==='session'?{...f.actor,sessionDigest:'b'.repeat(64)}:f.actor;
    const body={selection:p.selection,...(change==='extra'?{after:'cursor:50'}:{})};
    if(change==='reused') {await f.runner.run(state,actor,'start',body);await assert.rejects(()=>f.runner.run(f.snapshot(),actor,'start',body),/SELECTION_INVALID/);}
    else {await assert.rejects(()=>f.runner.run(state,actor,'start',body),/SELECTION_INVALID/);assert.equal(f.calls.length,before);}
  }
});
test('recovery is unavailable without exact runtime/store opt-in and does zero recovery IO',async()=>{
  const f=recoveryFixture({enabled:false});const p=await f.runner.preview(await f.get(),f.actor);assert.equal(p.available,false);assert.equal(f.metrics.summary,undefined);assert.equal(f.metrics.provider,undefined);
});
test('preflight expiry, malformed debt, five spent admissions, duplicate actors and active lease stop before provider',async()=>{
  for(const mode of ['debt','five','actor','lease','source']) {
    const f=recoveryFixture(),state=await f.get();
    if(mode==='debt')state.connectionDoctor={shopify:{attempts:'1'}};
    if(mode==='five')state.connectionDoctor={shopify:{attempts:5,exhausted:true}};
    if(mode==='actor')state.users.push(structuredClone(state.users[0]));
    if(mode==='lease')state.connectionSyncs=[{id:'other',provider:'shopify',status:'running',leaseUntil:new Date(Date.now()+60000).toISOString()}];
    if(mode==='source')state.connectionSettings.shopify.areas=['products'];
    if(mode==='actor')await assert.rejects(()=>f.runner.preview(state,f.actor),/ACTOR_INVALID/);else assert.equal((await f.runner.preview(state,f.actor)).canStart,false);
    assert.equal(f.controls.providerCalls,0);
  }
});
test('post-token current revision gate stops dispatch and admits no page',async()=>{
  const f=recoveryFixture();let n=0;f.controls.beforeContext=state=>{if(++n===2)state._revision=crypto.randomUUID();};
  const state=await f.get(),p=await f.runner.preview(state,f.actor),result=await f.runner.run(state,f.actor,'start',{selection:p.selection});
  assert.equal(result.status,'interrupted');assert.equal(f.controls.providerCalls,0);assert.equal(f.stages.values().next().value.pages.length,0);assert.equal(f.snapshot().connectionDoctor.shopify.attempts,1);
});
test('unknown append attempts one mutation and exact lookup, then explicit review settles retained prefix without provider replay',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=recoveryFixture();f.controls.unknownKind='append';f.controls.dropLookup=true;
  let state=await f.get(),p=await f.runner.preview(state,f.actor),result=await f.runner.run(state,f.actor,'start',{selection:p.selection});
  assert.equal(result.status,'unknown');assert.equal(f.metrics.lookup.calls,1);assert.equal(f.controls.providerCalls,1);assert.equal(f.stages.values().next().value.pages.length,1);
  t.mock.timers.tick(600001);f.controls.dropLookup=false;state=await f.get();p=await f.runner.preview(state,f.actor);assert.equal(p.canResume,true);assert.equal(f.controls.providerCalls,1);
  result=await f.runner.run(state,f.actor,'resume',{selection:p.selection});assert.equal(result.status,'committed',JSON.stringify(result));assert.equal(f.controls.providerCalls,2);assert.equal(f.snapshot().connectionDoctor.shopify.attempts,2);
});
test('recovered final ACK does not execute stale mirrors/reporting after another replica advances',async()=>{
  const f=recoveryFixture({count:0});f.controls.unknownKind='finalize';const state=await f.get(),p=await f.runner.preview(state,f.actor);
  const result=await f.runner.run(state,f.actor,'start',{selection:p.selection});assert.equal(result.status,'committed');
  const finalize=f.calls.findIndex(c=>c.url.endsWith('runvara_finalize_order_recovery'));assert.ok(finalize>=0);assert.deepEqual(f.calls.slice(finalize+1).map(c=>c.category),['lookup']);
});
test('failed final CAS never generic-saves merged candidate or alters canonical orders',async()=>{
  const f=recoveryFixture({count:1});f.controls.failFinalize=true;const original=f.snapshot().orders,state=await f.get(),p=await f.runner.preview(state,f.actor);
  const result=await f.runner.run(state,f.actor,'start',{selection:p.selection});assert.equal(result.status,'interrupted');assert.deepEqual(f.snapshot().orders,original);assert.equal(f.stages.values().next().value.status,'complete');
});
test('known unique full-state indices reject duplicates and revision/reorder races fail closed',async()=>{
  const f=recoveryFixture(),state=await f.get(),run=beginConnectionSync(state,'shopify',{areas:['orders'],actor:f.actor.id});
  const context=prepareOrderRecoveryContext(state,f.actor.id,state.connections[0].id,run.id);state.users.push({...state.users[0]});assert.throws(()=>prepareOrderRecoveryContext(state,f.actor.id,state.connections[0].id,run.id),/CONTEXT_UNAVAILABLE/);
  assert.equal(context.actorIndex,0);await assert.rejects(()=>f.store.getOrderRecoveryContext(state.workspace.id,context,{actor:f.actor,stageId:'stage'}),/CONTEXT_UNAVAILABLE/);
});
test('generic save pins retained admitted run in exactly100 hot rows and archives displaced rows',async()=>{
  const f=recoveryFixture(),state=await f.get();state.connectionSyncs=Array.from({length:150},(_,i)=>({id:`run-${i}`,provider:'shopify',status:i===149?'running':'completed'}));
  state.integrationStatus.shopify ||= {};state.integrationStatus.shopify.orderRecovery={schema:'shopify-order-recovery-marker/v1',stageId:'stage',runId:'run-149',status:'reading',attempt:1};
  const next=await f.store.save(state.workspace.id,state);assert.equal(next.connectionSyncs.length,100);assert.ok(next.connectionSyncs.some(r=>r.id==='run-149'));assert.equal(f.fake.tables.get('runvara_history').length,50);
});
test('retained or unknown marker filters only automatic orders, including malformed committed markers',()=>{
  for(const marker of [null,false,0,'future',{status:'unknown'},{schema:'shopify-order-recovery-marker/v1',status:'committed'},{schema:'new-contract',stageId:'x',runId:'y',status:'committed',attempt:1}])assert.deepEqual(automaticConnectionAreas({integrationStatus:{shopify:{orderRecovery:marker}}},'shopify',['products','orders','customers']),['products','customers']);
});
test('each altered ACK field is uncertain, with one lookup and no mutation retry',async()=>{
  const f=recoveryFixture(),state=await f.get(),binding=createShopifyOrderRecoveryBinding(state,f.integrations),admission={runId:'run',leaseUntil:new Date(Date.now()+600000).toISOString(),attempt:1,workspaceRevision:state._revision,actorId:f.actor.id,actorSessionVersion:1,sessionDigest:f.actor.sessionDigest};
  const tx=prepareOrderRecoveryTransaction(state.workspace.id,{...state,_revision:crypto.randomUUID()},state._revision,{kind:'reserve',stageId:'stage',admission,actor:f.actor,binding,expectedStageRevision:0,expectedStatus:'reading'});
  const good={...tx.expected,logicalBytes:10000,status:'reading',replayed:false};
  for(const key of Object.keys(good)) {
    const bad={...good,[key]:null},calls=[];
    await assert.rejects(()=>commitOrderRecoveryTransaction(tx,async(_op,path)=>{calls.push(path);return path.includes('lookup')?null:bad;}),/COMMIT_UNCONFIRMED/);
    assert.equal(calls.length,2);assert.equal(calls.filter(p=>p.includes('reserve')).length,1);
  }
});
test('recovery refuses expiring saved credentials without refresh while ordinary resolver keeps refresh default',async()=>{
  const f=recoveryFixture(),state=await f.get();
  state.connections[0].encryptedCredentials=encryptCredentials({mode:'oauth',storeDomain:'fixture.myshopify.com',accessToken:'old-token',refreshToken:'synthetic-refresh',expiresAt:Date.now()+1},f.env.CREDENTIALS_KEY);
  assert.equal((await f.runner.preview(state,f.actor)).reason,'ORDER_RECOVERY_AUTH_REFRESH_REQUIRED');
  let tokenCalls=0;f.integrations.fetch=async()=>{tokenCalls++;return Response.json({access_token:'new-token',expires_in:3600});};
  await assert.rejects(()=>f.integrations.connectorCredentials(state,'shopify',{allowRefresh:false}),{code:'ORDER_RECOVERY_AUTH_REFRESH_REQUIRED'});assert.equal(tokenCalls,0);
  const credentials=await f.integrations.connectorCredentials(state,'shopify');assert.equal(credentials.accessToken,'new-token');assert.equal(tokenCalls,1);
});
test('committed run is released from history pinning and known supersession restores ordinary automatic areas',async()=>{
  const f=recoveryFixture(),state=await f.get();
  const marker={schema:'shopify-order-recovery-marker/v1',stageId:'stage',runId:'run-149',status:'superseded',attempt:1};
  assert.deepEqual(automaticConnectionAreas({integrationStatus:{shopify:{orderRecovery:marker}}},'shopify',['products','orders']),['products','orders']);
  state.connectionSyncs=Array.from({length:150},(_,i)=>({id:`run-${i}`,provider:'shopify',status:'completed'}));state.integrationStatus.shopify={orderRecovery:{...marker,status:'committed'}};
  const next=await f.store.save(state.workspace.id,state);assert.equal(next.connectionSyncs.length,100);assert.ok(!next.connectionSyncs.some(r=>r.id===marker.runId));
});
test('preview selection capacity evicts old unconsumed handles and expiry never becomes approval',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=recoveryFixture(),state=await f.get();let first,last;
  for(let i=0;i<257;i++){last=await f.runner.preview(state,f.actor);first ||=last;}
  await assert.rejects(()=>f.runner.run(state,f.actor,'start',{selection:first.selection}),/SELECTION_INVALID/);
  t.mock.timers.tick(300001);await assert.rejects(()=>f.runner.run(state,f.actor,'start',{selection:last.selection}),/SELECTION_EXPIRED/);assert.equal(f.metrics.full,undefined);assert.equal(f.controls.providerCalls,0);
});
test('definite provider failure finishes only detached admission state and allows immediate explicit continuation',async()=>{
  const f=recoveryFixture();f.controls.providerFailureAt=2;let state=await f.get(),p=await f.runner.preview(state,f.actor),first=p.originalStartedAt;
  const result=await f.runner.run(state,f.actor,'start',{selection:p.selection});assert.equal(result.status,'interrupted');assert.deepEqual(f.snapshot().orders,[]);assert.equal(f.snapshot().connectionSyncs[0].status,'failed');assert.equal(f.snapshot().connectionDoctor.shopify.attempts,1);
  state=await f.get();p=await f.runner.preview(state,f.actor);assert.equal(p.canResume,true,JSON.stringify(p));assert.equal(p.originalStartedAt,first);
  assert.equal((await f.runner.run(state,f.actor,'resume',{selection:p.selection})).status,'committed');assert.equal(f.controls.providerCalls,3);assert.equal(f.snapshot().connectionDoctor.shopify.attempts,2);
});
test('lost definite-failure save stays unknown until explicit authority read settles it, without automatic replay',async()=>{
  const f=recoveryFixture();f.controls.providerFailureAt=2;const originalSave=f.store.save.bind(f.store);let lost=false;
  f.store.save=async(ws,state,options)=>{const saved=await originalSave(ws,state,options);if(!options.protectedOrderRecovery && state.integrationStatus.shopify.orderRecovery?.status==='failed'&&!lost){lost=true;throw Object.assign(new Error('lost failure ack'),{code:'SUPABASE_PERSISTENCE_FAILED'});}return saved;};
  const state=await f.get(),p=await f.runner.preview(state,f.actor),result=await f.runner.run(state,f.actor,'start',{selection:p.selection});assert.equal(result.status,'unknown');assert.equal(f.controls.providerCalls,2);assert.deepEqual(f.snapshot().orders,[]);
  const preview=await f.runner.preview(await f.get(),f.actor);assert.equal(preview.canResume,true);assert.equal(f.controls.providerCalls,2);
});
test('concurrent revision after provider failure prevents detached bookkeeping from overwriting newer data',async()=>{
  const f=recoveryFixture();f.controls.providerFailureAt=2;let count=0;
  f.controls.beforeContext=s=>{if(++count===5){s._revision=crypto.randomUUID();s.workspace.name='Concurrent owner edit';}};
  const state=await f.get(),p=await f.runner.preview(state,f.actor),result=await f.runner.run(state,f.actor,'start',{selection:p.selection});assert.equal(result.status,'interrupted');assert.equal(f.snapshot().workspace.name,'Concurrent owner edit');assert.equal(f.snapshot().connectionSyncs[0].status,'running');assert.deepEqual(f.snapshot().orders,[]);assert.equal(f.controls.providerCalls,2);
});
test('private control pause during token await stops provider dispatch before append',async()=>{
  const f=recoveryFixture();let count=0;f.controls.beforeContext=()=>{if(++count===2)f.controls.mode='paused';};
  const state=await f.get(),p=await f.runner.preview(state,f.actor),result=await f.runner.run(state,f.actor,'start',{selection:p.selection});assert.equal(result.status,'interrupted');assert.equal(f.controls.providerCalls,0);assert.equal(f.metrics.stage_mutation.calls,1);
});
test('reconnecting a changed source preserves raw retained debt while recovery becomes ineligible',async()=>{
  const f=recoveryFixture(),state=await f.get(),binding=createShopifyOrderRecoveryBinding(state,f.integrations),doctor={attempts:4,exhausted:false,orderReadBinding:binding.source};
  state.connectionDoctor={shopify:doctor};state.integrationStatus.shopify={orderRecovery:{schema:'shopify-order-recovery-marker/v1',stageId:'retained',runId:'prior',status:'failed',attempt:4}};
  state.connections[0].metadata.shopId='replacement-shop';
  assert.equal(connectionDoctorState(state,'shopify',f.integrations),doctor);queueFirstSync(state,'shopify',f.actor.id);assert.deepEqual(state.connectionDoctor.shopify,doctor);
  assert.deepEqual(automaticConnectionAreas(state,'shopify',['products','orders']),['products']);
});
test('completed and unverified first-sync records remain unchanged when they are outside the source binding',async()=>{
  for(const first of [
    {status:'completed',startedAt:new Date().toISOString(),actor:'previous-owner',identityVerifiedAt:new Date().toISOString(),areas:{orders:'completed',products:'completed'},failures:{},completedAt:'2026-09-01T00:00:00.000Z'},
    {status:'failed',areas:{orders:'failed',products:'failed'},failures:{products:{code:'UNVERIFIED'}},identityVerifiedAt:null}
  ]) {
    const f=recoveryFixture({count:1}),state=await f.get();state.connectionFirstSync={shopify:first};await f.store.save(state.workspace.id,state);
    const current=await f.get(),binding=createShopifyOrderRecoveryBinding(current,f.integrations);assert.equal(binding.firstSync,null);
    const preview=await f.runner.preview(current,f.actor),result=await f.runner.run(current,f.actor,'start',{selection:preview.selection});assert.equal(result.status,'committed',JSON.stringify(result));assert.deepEqual(f.snapshot().connectionFirstSync.shopify,first);
  }
});
test('confirmed terminal page pause releases its finished lease for an immediate explicit ordinary fresh read',async()=>{
  const f=recoveryFixture({count:501}),state=await f.get(),p=await f.runner.preview(state,f.actor),result=await f.runner.run(state,f.actor,'start',{selection:p.selection});
  assert.equal(result.status,'interrupted');assert.equal(f.controls.providerCalls,10);assert.equal(f.stages.values().next().value.status,'paused');assert.equal(f.stages.values().next().value.pages.length,10);
  const saved=await f.get();assert.equal(saved.orders.length,0);assert.equal(saved.connectionSyncs[0].status,'failed');assert.equal(saved.integrationStatus.shopify.orderRecovery.status,'paused');
  assert.doesNotThrow(()=>beginConnectionSync(saved,'shopify',{areas:['orders'],actor:f.actor.id}));
});
