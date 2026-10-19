import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {containerObserverFixture} from './meta-container-observer-fixture.mjs';
import {observationFixture} from './meta-publication-observation-fixture.mjs';
import {createMetaContainerObserverMock,previewMetaContainerObserver,runMetaContainerObserver} from '../lib/meta-container-observer.mjs';

test('separate OS processes share exact-request admission in the existing FileStore',async t=>{
 const f=await containerObserverFixture(t),input=await f.input(),directory=path.dirname(f.store.filePath),calls=path.join(directory,'mock-calls.txt'),fixture=path.join(directory,'observer-process.json');
 await fs.writeFile(calls,'');await fs.writeFile(fixture,JSON.stringify({stateFile:f.store.filePath,events:f.events,writeId:f.writeId,session:f.session,input,now:f.now(),containerId:f.anchor.containerId,calls}));
 const children=[0,1].map(()=>{const child=spawn(process.execPath,[fileURLToPath(new URL('./meta-container-observer-process.mjs',import.meta.url)),fixture],{env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
 let message,output='';child.stderr.on('data',chunk=>output+=chunk);const ready=new Promise(resolve=>child.once('message',resolve));
 child.on('message',value=>{if(value!=='ready')message=value;});const done=new Promise(resolve=>child.once('close',code=>resolve({code,message,output})));return {child,ready,done};});
 await Promise.all(children.map(row=>row.ready));for(const row of children)row.child.send('go');
 for(const result of await Promise.all(children.map(row=>row.done))){assert.equal(result.code,0,result.output);assert.ok(result.message.result);assert.equal(result.message.result.replayPermitted,false);}
 assert.equal((await fs.readFile(calls,'utf8')).trim().split('\n').length,1);
 assert.equal((await f.get()).integrationStatus.meta.containerObserver.attempts.length,1);
});
for(const failure of ['reserve-after-rename','settle-before-rename','settle-after-rename'])test(failure+' never grants another transport attempt',async t=>{
 const f=await containerObserverFixture(t),input=await f.input(),original=fs.rename;let renames=0;
 fs.rename=async(...args)=>{if(args[1]===f.store.filePath){renames++;if(failure==='settle-before-rename'&&renames===2)throw Error('synthetic local failure');}
  const result=await original(...args);if(args[1]===f.store.filePath&&((failure==='reserve-after-rename'&&renames===1)||(failure==='settle-after-rename'&&renames===2)))throw Error('synthetic lost local ACK');return result;};
 try{await assert.rejects(f.run(input),{code:failure.startsWith('reserve')?'META_CONTAINER_OBSERVER_ADMISSION_UNKNOWN':'META_CONTAINER_OBSERVER_COMMIT_UNKNOWN'});}finally{fs.rename=original;}
 const expected=failure.startsWith('reserve')?0:1;assert.equal(f.calls.length,expected);const recovered=await f.run(input);assert.equal(f.calls.length,expected);
 assert.equal(recovered.attemptState,failure==='settle-after-rename'?'complete':'reserved');assert.equal(recovered.replayPermitted,false);
});
test('same account across two tenants shares cadence without revealing peer data',async t=>{
 const a=await containerObserverFixture(t,{workspaceId:'observer-a'}),b=await observationFixture(t,{workspaceId:'observer-b'});
 await a.store.save(b.workspaceId,await b.get());await a.run();let calls=0;
 const cap=createMetaContainerObserverMock({store:a.store,receiptStore:b.observationStore,environment:'test',now:a.now,fetchImpl:async()=>{calls++;throw Error('should not run');}});
 const preview=await previewMetaContainerObserver(cap,b.writeId,b.session);assert.deepEqual(preview.attempts,[]);
 await assert.rejects(runMetaContainerObserver(cap,b.writeId,b.session,{requestId:randomUUID(),selection:preview.selection}),{code:'META_CONTAINER_OBSERVER_CADENCE'});assert.equal(calls,0);
});
test('global concurrency spans accounts and tenants; timeout holds cannot be bypassed by new harnesses',async t=>{
 const a=await containerObserverFixture(t,{workspaceId:'observer-a',configure:s=>{s.connections[0].metadata.accountId='111';},timeoutMs:10});
 a.controls.respond=()=>new Promise(()=>{});await a.run();
 for(const [i,account] of [[2,'222'],[3,'333']]){
  const f=await observationFixture(t,{workspaceId:'observer-'+i,configure:s=>{s.connections[0].metadata.accountId=account;}});await a.store.save(f.workspaceId,await f.get());
  let calls=0;const cap=createMetaContainerObserverMock({store:a.store,receiptStore:f.observationStore,environment:'test',now:a.now,timeoutMs:10,fetchImpl:()=>{calls++;return new Promise(()=>{});}});
  const input={requestId:randomUUID(),selection:(await previewMetaContainerObserver(cap,f.writeId,f.session)).selection};
  if(i===2){assert.equal((await runMetaContainerObserver(cap,f.writeId,f.session,input)).requiresReview,true);assert.equal(calls,1);}
  else{await assert.rejects(runMetaContainerObserver(cap,f.writeId,f.session,input),{code:'META_CONTAINER_OBSERVER_BUSY'});assert.equal(calls,0);}
 }
});
test('clock regression and expired five-minute window fail closed',async t=>{
 const f=await containerObserverFixture(t);await f.run();f.advance(-1);await assert.rejects(f.run(),{code:'META_CONTAINER_OBSERVER_CLOCK_INVALID'});
 f.advance(300001);await assert.rejects(f.run(),{code:'META_CONTAINER_OBSERVER_ATTEMPTS_EXHAUSTED'});assert.equal(f.calls.length,1);
});
for(const retained of [false,true])test('owner revocation while '+(retained?'retained retry':'settlement')+' releases its lock suppresses private output',async t=>{
 const f=await containerObserverFixture(t),input=await f.input();if(retained)await f.run(input);
 const original=fs.unlink;let releases=0,revoked=false;
 fs.unlink=async(...args)=>{const result=await original(...args);if(args[0]===f.store.filePath+'.transaction-lock'&&++releases===(retained?1:3)){
  revoked=true;await f.change(s=>{s.users[0].sessionVersion=2;});}return result;};
 try{await assert.rejects(f.run(input),{code:'META_CONTAINER_OBSERVER_AUTHORITY_CHANGED'});assert.equal(revoked,true);}finally{fs.unlink=original;}
 assert.equal(f.calls.length,1);
});
test('revocation during final admission lock release prevents the mocked GET itself',async t=>{
 const f=await containerObserverFixture(t),input=await f.input(),original=fs.unlink;let releases=0;
 fs.unlink=async(...args)=>{const result=await original(...args);if(args[0]===f.store.filePath+'.transaction-lock'&&++releases===2)await f.change(s=>{s.users[0].sessionVersion=2;});return result;};
 try{await assert.rejects(f.run(input),{code:'META_CONTAINER_OBSERVER_AUTHORITY_CHANGED'});}finally{fs.unlink=original;}
 assert.equal(f.calls.length,0);
});
for(const global of [false,true])test((global?'global 128':'workspace 32')+' retained-attempt capacity refuses a new request',async t=>{
 const f=await containerObserverFixture(t);await f.run();f.advance(60000);
 const all=JSON.parse(await fs.readFile(f.store.filePath,'utf8')),original=all[f.workspaceId].integrationStatus.meta.containerObserver,template=original.attempts[0];
 const rows=count=>Array.from({length:count},(_,index)=>({...structuredClone(template),requestId:randomUUID(),anchor:{...template.anchor,containerId:String(800000000+index)}}));
 if(!global)original.attempts=rows(32);
 else for(const [index,count] of [32,32,32,31].entries())all['peer-'+index]={workspace:{id:'peer-'+index},users:[],integrationStatus:{meta:{containerObserver:{...original,attempts:rows(count)}}}};
 await fs.writeFile(f.store.filePath,JSON.stringify(all));await assert.rejects(f.run(),{code:'META_CONTAINER_OBSERVER_CAPACITY'});assert.equal(f.calls.length,1);
});
test('clock rollback during transport preserves a valid held reservation rather than corrupting shared admission',async t=>{
 const f=await containerObserverFixture(t),input=await f.input();f.controls.respond=()=>{
  f.advance(-1);return new Response(JSON.stringify({id:f.anchor.containerId,status_code:'PUBLISHED'}),{headers:{'Content-Type':'application/json'}});
 };
 await assert.rejects(f.run(input),{code:'META_CONTAINER_OBSERVER_COMMIT_UNKNOWN'});
 const row=(await f.get()).integrationStatus.meta.containerObserver.attempts[0];assert.equal(row.state,'reserved');assert.equal(row.observedAt,null);assert.equal(row.hold,true);
 f.advance(1);assert.equal((await f.preview()).attempts[0].attemptState,'reserved');assert.equal((await f.run(input)).attemptState,'reserved');assert.equal(f.calls.length,1);
});
