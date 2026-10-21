import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {containerObserverFixture} from './meta-container-observer-fixture.mjs';
import {createMetaContainerObserverMock,previewMetaContainerObserver,runMetaContainerObserver,META_CONTAINER_OBSERVER_CONTRACT} from '../lib/meta-container-observer.mjs';
import {createStore,updateLocalMetaObserver} from '../lib/store.mjs';
import {metaMethods} from '../lib/meta-commerce.mjs';

test('fixed versioned GET retains only exact known status, never media or publication authority',async t=>{
 const f=await containerObserverFixture(t),before=await f.get(),input=await f.input();
 assert.equal(f.calls.length,0);const result=await f.run(input);assert.equal(result.contract,META_CONTAINER_OBSERVER_CONTRACT);
 assert.equal(result.statusCode,'PUBLISHED');assert.equal(result.resultId,null);assert.equal(result.outcome,'unresolved_do_not_resend');
 for(const key of ['providerReadPerformed','executedExternally','publishingEnabled','replayPermitted'])assert.equal(result[key],false);
 const request=f.calls[0],url=new URL(request.address);assert.equal(url.origin,'https://graph.facebook.com');assert.equal(url.pathname,'/v26.0/'+f.anchor.containerId);
 assert.equal(url.searchParams.get('fields'),'id,status_code');assert.deepEqual([...url.searchParams.keys()].sort(),['appsecret_proof','fields']);
 assert.equal(request.settings.method,'GET');assert.equal(request.settings.redirect,'error');assert.equal(request.settings.body,undefined);
 const after=await f.get();assert.deepEqual(after.connectionWrites,before.connectionWrites);assert.deepEqual(after.approvals,before.approvals);assert.deepEqual(after.connectionSyncs,before.connectionSyncs);
 assert.doesNotMatch(JSON.stringify(after.integrationStatus.meta.containerObserver),/synthetic-meta-observer-token|synthetic-meta-observer-secret|Authorization|appsecret_proof/);
 assert.deepEqual(await f.run(input),result);assert.equal(f.calls.length,1);
});
for(const code of ['IN_PROGRESS','FINISHED','ERROR','EXPIRED'])test('documented '+code+' remains unresolved without resend',async t=>{
 const f=await containerObserverFixture(t);f.controls.respond=()=>new Response(JSON.stringify({status_code:code,id:f.anchor.containerId}),{headers:{'Content-Type':'application/json'}});
 const result=await f.run();assert.equal(result.statusCode,code);assert.equal(result.resultId,null);assert.equal(result.replayPermitted,false);
});
for(const body of ['{secret','{"id":"999","status_code":"PUBLISHED"}','{"id":"900000001","status_code":"UNKNOWN"}',
 '{"id":"900000001","status_code":"PUBLISHED","status_code":"ERROR"}','{"id":"900000001","status_code":"PUBLISHED","media_id":"99"}', ' '.repeat(4097)])test('untrusted malformed/contradictory/oversized response stays unknown: '+body.slice(0,60),async t=>{
 const f=await containerObserverFixture(t);f.controls.respond=()=>new Response(body,{headers:{'Content-Type':'application/json'}});
 const input=await f.input(),result=await f.run(input);assert.equal(result.attemptState,'unknown');assert.equal(result.statusCode,null);assert.equal(result.resultId,null);
 assert.doesNotMatch(JSON.stringify(result),/secret|media_id/);assert.deepEqual(await f.run(input),result);assert.equal(f.calls.length,1);
});
test('streamed body, invalid UTF8, missing body and declared oversize are bounded',async t=>{
 const f=await containerObserverFixture(t);for(const response of [new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(4097));c.close();}}),{headers:{'Content-Type':'application/json'}}),
 new Response(new Uint8Array([255,254]),{headers:{'Content-Type':'application/json'}}),new Response(null,{headers:{'Content-Type':'application/json'}}),
 new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'999999'}})]){
  f.controls.respond=()=>response;const result=await f.run();assert.equal(result.attemptState,'unknown');f.advance(60000);
 }
});
for(const phase of ['fetch','body'])test(phase+' timeout remains charged and holds shared admission even if transport ignores abort',async t=>{
 const f=await containerObserverFixture(t,{timeoutMs:20});f.controls.respond=()=>phase==='fetch'?new Promise(()=>{}):new Response(new ReadableStream({start(){},cancel(){return new Promise(()=>{});}}),{headers:{'Content-Type':'application/json'}});
 const input=await f.input(),result=await f.run(input);assert.equal(result.errorCode,'META_CONTAINER_OBSERVER_TIMEOUT');assert.equal(result.requiresReview,true);
 f.advance(60000);assert.deepEqual(await f.run(input),result);await assert.rejects(f.run(),{code:'META_CONTAINER_OBSERVER_BUSY'});assert.equal(f.calls.length,1);
});
for(const status of [401,403,429,500])test('HTTP '+status+' never copies provider error text or retries',async t=>{
 const f=await containerObserverFixture(t);f.controls.respond=()=>new Response('{"error":{"message":"secret token example"}}',{status,headers:{'Content-Type':'application/json','Retry-After':'9999999'}});
 const result=await f.run();assert.equal(result.attemptState,'unknown');assert.equal(result.requiresReview,status!==500);assert.doesNotMatch(JSON.stringify(result),/secret|token|example/);assert.equal(f.calls.length,1);
});
test('lost fetch response remains unknown with safe fixed error and no automatic retry',async t=>{
 const f=await containerObserverFixture(t);f.controls.respond=()=>{throw Error('https://secret.example/?access_token=leak');};
 const input=await f.input(),result=await f.run(input);assert.equal(result.errorCode,'META_CONTAINER_OBSERVER_RESPONSE_UNKNOWN');assert.deepEqual(await f.run(input),result);assert.equal(f.calls.length,1);
});
test('different request and new harness share durable cadence; exact retry never sends twice',async t=>{
 const f=await containerObserverFixture(t),input=await f.input();const result=await f.run(input);
 const store=createStore(f.env),cap=createMetaContainerObserverMock({store,receiptStore:f.observationStore,fetchImpl:f.fetchImpl,environment:'test',now:f.now});
 assert.deepEqual(await f.run(input,cap),result);await assert.rejects(f.run({...input,requestId:randomUUID()},cap),{code:'META_CONTAINER_OBSERVER_CADENCE'});
 f.advance(60000);await f.run({...input,requestId:randomUUID()},cap);assert.equal(f.calls.length,2);
});
test('concurrent duplicate claims across FileStore instances permit one GET',async t=>{
 const f=await containerObserverFixture(t),input=await f.input();let release;f.controls.respond=()=>new Promise(resolve=>{release=()=>resolve(new Response(JSON.stringify({id:f.anchor.containerId,status_code:'PUBLISHED'}),{headers:{'Content-Type':'application/json'}}));});
 const store=createStore(f.env),cap=createMetaContainerObserverMock({store,receiptStore:f.observationStore,fetchImpl:f.fetchImpl,environment:'test',now:f.now});
 const first=f.run(input);while(!release)await new Promise(resolve=>setTimeout(resolve,2));
 const retained=await f.run(input,cap);assert.equal(retained.attemptState,'reserved');assert.equal(retained.requiresReview,true);assert.equal(f.calls.length,1);
 release();await first;assert.equal(f.calls.length,1);
});
test('five total checks and fixed five-minute window cannot reset with a new request ID',async t=>{
 const f=await containerObserverFixture(t);for(let i=0;i<5;i++){await f.run();f.advance(60000);}await assert.rejects(f.run(),{code:'META_CONTAINER_OBSERVER_ATTEMPTS_EXHAUSTED'});assert.equal(f.calls.length,5);
});
test('ordinary saves cannot forge, remove or reset cadence state',async t=>{
 const f=await containerObserverFixture(t);await f.change(s=>{s.integrationStatus.meta={containerObserver:{forged:true}};});assert.equal((await f.get()).integrationStatus.meta.containerObserver,undefined);
 await f.run();const retained=(await f.get()).integrationStatus.meta.containerObserver;
 await f.change(s=>{delete s.integrationStatus.meta;});assert.deepEqual((await f.get()).integrationStatus.meta.containerObserver,retained);
 await f.change(s=>{s.integrationStatus.meta.containerObserver={contract:META_CONTAINER_OBSERVER_CONTRACT,attempts:[]};});assert.deepEqual((await f.get()).integrationStatus.meta.containerObserver,retained);
});
for(const [name,change] of [['account',s=>s.connections[0].metadata.accountId='999'],['connection',s=>s.connections[0].id='other'],['instagram',s=>s.connections[0].metadata.assets.pages[0].instagram.id='999'],
 ['page',s=>s.connectionSettings.meta.metaPageIds=['999']],['grant',s=>s.connections[0].metadata.grantedScopes=[]],['revision',s=>s.connectionSettings.meta.revision++],['revocation',s=>s.users[0].active=false]])test(name+' changes invalidate owner selection before any GET',async t=>{
 const f=await containerObserverFixture(t),input=await f.input();await f.change(change);await assert.rejects(f.run(input));assert.equal(f.calls.length,0);
});
test('revocation during transport suppresses disclosure and retains an unknown attempt',async t=>{
 const f=await containerObserverFixture(t);f.controls.respond=async()=>{await f.change(s=>{s.users[0].sessionVersion=2;});return new Response(JSON.stringify({id:f.anchor.containerId,status_code:'PUBLISHED'}),{headers:{'Content-Type':'application/json'}});};
 await assert.rejects(f.run(),{code:'META_CONTAINER_OBSERVER_AUTHORITY_CHANGED'});const row=(await f.get()).integrationStatus.meta.containerObserver.attempts[0];assert.equal(row.statusCode,null);assert.equal(row.state,'unknown');
});
test('foreign tenant, cloned capabilities, production issuer and changed file path stay closed',async t=>{
 const f=await containerObserverFixture(t);await assert.rejects(previewMetaContainerObserver(f.capability,f.writeId,{...f.session,workspaceId:'other'}));
 for(const cap of [{},structuredClone(f.capability),null])await assert.rejects(previewMetaContainerObserver(cap,f.writeId,f.session));
 assert.throws(()=>createMetaContainerObserverMock({store:f.store,receiptStore:f.observationStore,fetchImpl:f.fetchImpl,environment:'production'}));
 const saved=f.store.filePath;f.store.filePath+='-other';await assert.rejects(f.preview());f.store.filePath=saved;assert.equal(f.calls.length,0);
});
test('known-container admission is required and arbitrary URL/mutation request overrides are refused',async t=>{
 const f=await containerObserverFixture(t,{phase:'instagram_container'});await assert.rejects(f.preview(),{code:'META_CONTAINER_OBSERVER_NO_KNOWN_RECEIPT'});assert.equal(f.calls.length,0);
 for(const [url,options] of [['https://other.example',{}],['/123',{method:'POST'}],['/123',{body:{x:1}}],['/123',{query:{fields:'media'}}]])await assert.rejects(metaMethods.metaRequest.call({fetch:()=>{throw Error('must not fetch');},env:{}},url,'fake',{query:{fields:'id,status_code'},containerStatusRead:true,...options}));
});
test('malformed peer ledger fails closed before shared-limit admission',async t=>{
 const f=await containerObserverFixture(t),raw=JSON.parse(await fs.readFile(f.store.filePath,'utf8'));
 raw.other={workspace:{id:'other'},users:[],integrationStatus:{meta:{containerObserver:{contract:'wrong',attempts:[]}}}};await fs.writeFile(f.store.filePath,JSON.stringify(raw));
 await assert.rejects(f.run());assert.equal(f.calls.length,0);
});
test('a changed current container receipt during transport cannot become a retained status',async t=>{
 const f=await containerObserverFixture(t);f.controls.respond=async()=>{
  await f.change(s=>{s.connectionWrites[0].providerState.containerId='999';});
  return new Response(JSON.stringify({id:f.anchor.containerId,status_code:'PUBLISHED'}),{headers:{'Content-Type':'application/json'}});
 };
 await assert.rejects(f.run(),{code:'META_CONTAINER_OBSERVER_AUTHORITY_CHANGED'});
 const row=(await f.get()).integrationStatus.meta.containerObserver.attempts[0];assert.equal(row.statusCode,null);assert.equal(row.state,'unknown');assert.equal(f.calls.length,1);
});
test('same request ID cannot be rebound to another selection or an invalid protected receipt',async t=>{
 const f=await containerObserverFixture(t),input=await f.input();await f.run(input);
 await assert.rejects(f.run({...input,selection:'a'.repeat(64)}),{code:'META_CONTAINER_OBSERVER_REQUEST_CONFLICT'});
 f.events[0].digest='0'.repeat(64);await assert.rejects(f.run(input));assert.equal(f.calls.length,1);
});
