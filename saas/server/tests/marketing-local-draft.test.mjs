import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { publicationFixture } from './marketing-publication-fixture.mjs';
import { jpegFixture,dcOverflowJpeg } from './marketing-local-jpeg-fixture.mjs';
import { snapshotLocalJpeg } from '../lib/marketing-jpeg.mjs';
import { createLocalDraftStorage,assertLocalDraftStorage,localDraftContext,saveLocalDraft,readLocalDraft } from '../lib/marketing-local-draft.mjs';
import { createStore,withLocalFileState } from '../lib/store.mjs';
import { executeConnectionWrite } from '../lib/connection-writes.mjs';

const rejects=(fn,code)=>assert.rejects(fn,e=>e.code===code);
const entries=async root=>(await fs.readdir(root)).filter(name=>name!=='.store.json');
async function fixture(t) {
  const f=await publicationFixture(t);
  await f.change(state=>{state.marketing.campaigns[0].creativeRequests=[];});
  f.root=path.join(path.dirname(f.env.SAAS_STATE_FILE),'local-drafts');
  f.capability=await createLocalDraftStorage({store:f.store,root:f.root,environment:'local'});
  f.context=()=>localDraftContext(f.capability,f.campaignId,'202',f.session);
  f.body=async(noisy=false)=>({requestId:crypto.randomUUID(),sourceRevision:(await f.context()).sourceRevision,pageId:'202',jpegBase64:jpegFixture({noisy}).toString('base64')});
  f.save=body=>saveLocalDraft(f.capability,f.campaignId,body,f.session);
  f.read=(id,options)=>readLocalDraft(f.capability,f.campaignId,id,f.session,options);
  return f;
}
test('JPEG fully decodes owned bytes, matches exact encoded hash, and does not imply provider delivery',async()=>{
  const bytes=jpegFixture(),copy=Buffer.from(bytes),snapshot=await snapshotLocalJpeg(bytes);
  bytes.fill(0);assert.deepEqual(snapshot.bytes,copy);assert.equal(snapshot.descriptor.sha256,crypto.createHash('sha256').update(copy).digest('hex'));
  assert.equal(snapshot.descriptor.decoded,true);assert.equal(snapshot.descriptor.width,1080);assert.equal(snapshot.descriptor.pixelByteLength,4665600);
  assert.equal(snapshot.descriptor.providerDeliveryVerified,false);
});
test('JPEG refuses malformed structure, entropy, unsupported variants and overflow coefficients',async t=>{
  const bytes=jpegFixture(),sof=bytes.indexOf(Buffer.from([255,192])),sos=bytes.indexOf(Buffer.from([255,218]));
  const samples={truncated:bytes.subarray(0,-4),trailing:Buffer.concat([bytes,Buffer.from([0])]),concatenated:Buffer.concat([bytes,bytes]),
    metadata:Buffer.concat([bytes.subarray(0,2),Buffer.from([255,225,0,2]),bytes.subarray(2)]),progressive:Buffer.from(bytes),dimensions:Buffer.from(bytes),
    precision:Buffer.from(bytes),sampling:Buffer.from(bytes),missingEntropy:Buffer.concat([bytes.subarray(0,sos+14),Buffer.from([255,217])]),
    positiveDcOverflow:dcOverflowJpeg(),negativeDcOverflow:dcOverflowJpeg(true)};
  samples.progressive[sof+1]=194;samples.dimensions[sof+6]=1;samples.precision[sof+4]=12;samples.sampling[sof+11]=255;
  for(const [name,value] of Object.entries(samples))await t.test(name,()=>rejects(()=>snapshotLocalJpeg(value),'LOCAL_JPEG_INVALID'));
  await rejects(()=>snapshotLocalJpeg(Buffer.alloc(2097153)),'LOCAL_JPEG_INVALID');
  await rejects(()=>snapshotLocalJpeg(new Uint8Array(new SharedArrayBuffer(200))),'LOCAL_JPEG_INVALID');
  await rejects(()=>snapshotLocalJpeg(new Proxy(bytes,{})),'LOCAL_JPEG_INVALID');
});
test('manual JPEG saves without Canva, preserves workspace/legacy queues, replays and reopens exact bytes after restart',async t=>{
  const f=await fixture(t),body=await f.body(),before=await fs.readFile(f.env.SAAS_STATE_FILE);
  const saved=await f.save(body);assert.equal(saved.publishingEnabled,false);assert.equal(saved.executedExternally,false);assert.equal(saved.storage,'local_review_only');
  assert.deepEqual(await fs.readFile(f.env.SAAS_STATE_FILE),before);
  assert.deepEqual(await f.save(body),saved);assert.equal((await entries(f.root)).length,1);
  const store=createStore(f.env),capability=await createLocalDraftStorage({store,root:f.root,environment:'local'});
  const reopened=await readLocalDraft(capability,f.campaignId,body.requestId,f.session,{image:true});assert.deepEqual(reopened.bytes,jpegFixture());
  const state=await f.get();let calls=0;
  await rejects(()=>executeConnectionWrite(state,body.requestId,f.session.userId,{},{persist:async()=>{calls++;}}),'WRITE_NOT_FOUND');
  assert.equal(calls,0);assert.equal((state.connectionWrites||[]).length,0);assert.equal((state.approvals||[]).length,0);
});
test('valid JPEG greater than 1.5 MiB survives metadata validation and exact-byte persistence',async t=>{
  const f=await fixture(t),body=await f.body(true),length=Buffer.from(body.jpegBase64,'base64').length;
  assert.ok(length>1572864&&length<=2097152,'noisy fixture bytes '+length);
  const saved=await f.save(body);assert.equal(saved.asset.byteLength,length);
});
test('concurrent identical requests return one immutable draft and changed content conflicts',async t=>{
  const f=await fixture(t),body=await f.body();const [a,b]=await Promise.all([f.save(body),f.save(body)]);assert.deepEqual(a,b);
  await rejects(()=>f.save({...body,sourceRevision:'0'.repeat(64)}),'LOCAL_DRAFT_REQUEST_CONFLICT');assert.equal((await entries(f.root)).length,1);
});
test('exact cost changes reject new writes; retained result survives removed source and target with blockers',async t=>{
  const f=await fixture(t),body=await f.body(),saved=await f.save(body);
  await f.change(state=>{state.economics.BAGS.landed+=0.000001;});
  await rejects(()=>f.save({...body,requestId:crypto.randomUUID()}),'LOCAL_DRAFT_SOURCE_CHANGED');
  assert.equal((await f.read(body.requestId)).draft.stale,true);
  await f.change(state=>{state.connectionSettings.meta.metaPageIds=[];state.marketing.campaigns=[];});
  const replay=await f.save(body),read=await f.read(body.requestId);assert.equal(replay.integrity,saved.integrity);assert.equal(read.draft.stale,true);
  assert.ok(read.draft.blockers.includes('CURRENT_SOURCE_UNAVAILABLE'));assert.deepEqual((await f.read(body.requestId,{image:true})).bytes,jpegFixture());
});
test('missing actual costs remain explicit blockers, never fabricated or publishable',async t=>{
  const f=await fixture(t);await f.change(state=>{delete state.economics.BAGS.delivery;});
  const context=await f.context();assert.ok(context.eligibility.missingCostFields.includes('actual outbound delivery cost'));
  const saved=await f.save(await f.body());assert.ok(saved.blockers.includes('PRODUCT_NOT_ELIGIBLE'));assert.equal(saved.publishingEnabled,false);
});
test('owner authority is freshly checked after decode and on every retained read',async t=>{
  const f=await fixture(t),body=await f.body(),pending=f.save(body);
  await f.change(state=>{state.users[0].disabled=true;});await rejects(()=>pending,'WRITE_ACTOR_CHANGED');
  assert.equal((await entries(f.root)).length,0);
  await f.change(state=>{state.users[0].disabled=false;});await f.save(body);
  await f.change(state=>{state.users[0].sessionVersion=2;});await rejects(()=>f.read(body.requestId),'WRITE_ACTOR_CHANGED');
});
test('foreign actors, tenant substitutions, corrupt/missing bytes and unsafe request paths fail closed',async t=>{
  const f=await fixture(t),body=await f.body();await f.save(body);
  await rejects(()=>saveLocalDraft(f.capability,f.campaignId,{...body,requestId:'../../unrelated-file'},f.session),'LOCAL_DRAFT_INPUT_INVALID');
  await assert.rejects(()=>readLocalDraft(f.capability,f.campaignId,body.requestId,{...f.session,workspaceId:'foreign'}));
  await f.change(state=>{state.users.push({...state.users[0],id:'another-owner',email:'another@example.test'});});
  await rejects(()=>readLocalDraft(f.capability,f.campaignId,body.requestId,{...f.session,userId:'another-owner'}),'LOCAL_DRAFT_CORRUPT');
  const directory=path.join(f.root,(await entries(f.root))[0]);await fs.writeFile(path.join(directory,'image.jpg'),Buffer.from('tampered'));
  await rejects(()=>f.read(body.requestId),'LOCAL_DRAFT_CORRUPT');
});
test('storage is denied for fake durable stores, production composition and static roots',async t=>{
  const f=await fixture(t);
  await rejects(()=>createLocalDraftStorage({store:{provider:'file'},root:f.root,environment:'local'}),'LOCAL_DRAFT_STORAGE_CLOSED');
  assert.throws(()=>assertLocalDraftStorage(f.capability,f.store,{NODE_ENV:'production'}),{code:'LOCAL_DRAFT_STORAGE_CLOSED'});
  assert.throws(()=>assertLocalDraftStorage(f.capability,f.store,{SUPABASE_URL:'synthetic'}),{code:'LOCAL_DRAFT_STORAGE_CLOSED'});
  assert.throws(()=>assertLocalDraftStorage(f.capability,f.store,{},path.dirname(f.root)),{code:'LOCAL_DRAFT_STORAGE_CLOSED'});
  const another=createStore({SAAS_STATE_FILE:path.join(path.dirname(f.root),'another-state.json')});
  await rejects(()=>createLocalDraftStorage({store:another,root:f.root,environment:'local'}),'LOCAL_DRAFT_STORAGE_CONFLICT');
});
test('all current FileStore instances serialize authority changes against a draft transaction',async t=>{
  const f=await fixture(t),other=createStore(f.env),state=await other.get(f.workspaceId);let release,entered;
  const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const locked=withLocalFileState(f.store,f.workspaceId,async()=>{entered();await gate;});await started;
  state.users[0].disabled=true;let completed=false;const saving=other.save(f.workspaceId,state).then(()=>completed=true);
  await new Promise(resolve=>setTimeout(resolve,35));assert.equal(completed,false);release();await locked;await saving;assert.equal(completed,true);
});
test('incomplete storage consumes bounded capacity but never appears as a saved draft',async t=>{
  const f=await fixture(t),body=await f.body();
  for(let i=0;i<128;i++)await fs.mkdir(path.join(f.root,'.pending-fixture-'+i));
  await rejects(()=>f.save(body),'LOCAL_DRAFT_STORAGE_FULL');assert.equal((await f.read(body.requestId)).found,false);
});
test('OS-visible lock serializes a second FileStore process and never steals an abandoned lock',async t=>{
  const f=await fixture(t),script=fileURLToPath(new URL('./marketing-local-state-worker.mjs',import.meta.url));
  const start=mode=>{
    const child=fork(script,[f.env.SAAS_STATE_FILE,f.workspaceId,mode],{env:{NODE_ENV:'test',...Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP'].flatMap(key=>process.env[key]?[[key,process.env[key]]]:[]))},windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
    const messages=[];child.on('message',message=>messages.push(message.event));t.after(()=>{if(child.exitCode===null)child.kill();});return {child,messages};
  };
  const until=async fn=>{for(let i=0;i<300;i++){if(fn())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Worker did not signal');};
  const holder=start('hold');await until(()=>holder.messages.includes('locked'));
  const writer=start('write');await until(()=>writer.messages.includes('writing'));
  await new Promise(resolve=>setTimeout(resolve,50));assert.equal(writer.messages.includes('done'),false);
  const exits=Promise.all([once(holder.child,'exit'),once(writer.child,'exit')]);holder.child.send('release');await exits;
  assert.ok(writer.messages.includes('done'));assert.equal((await f.get()).users[0].disabled,true);
  await fs.writeFile(f.env.SAAS_STATE_FILE+'.transaction-lock','abandoned synthetic lock',{flag:'wx'});
  await rejects(()=>withLocalFileState(f.store,f.workspaceId,()=>assert.fail('lock stolen')),'LOCAL_STATE_LOCKED');
});
test('disk failures never expose partial drafts; same request safely recovers without overwriting orphans',async t=>{
  for(const fault of ['image.jpg:open','image.jpg:writeFile','image.jpg:sync','draft.json:writeFile','draft.json:sync','rename'])await t.test(fault,async t=>{
    const f=await fixture(t),body=await f.body(),originalOpen=fs.open,originalRename=fs.rename;
    let hit=false;
    fs.open=async function(file,...args){
      if(String(file).startsWith(f.root)&&fault===path.basename(file)+':open'){hit=true;throw Error('synthetic disk failure');}
      const handle=await originalOpen.call(this,file,...args);
      if(String(file).startsWith(f.root))for(const method of ['writeFile','sync'])if(fault===path.basename(file)+':'+method)handle[method]=async()=>{hit=true;throw Error('synthetic disk failure');};
      return handle;
    };
    fs.rename=async function(from,...args){if(String(from).startsWith(f.root)&&fault==='rename'){hit=true;throw Error('synthetic disk failure');}return originalRename.call(this,from,...args);};
    try{await assert.rejects(()=>f.save(body),/synthetic disk failure/);}finally{fs.open=originalOpen;fs.rename=originalRename;}
    assert.equal(hit,true);assert.equal((await f.read(body.requestId)).found,false);
    await f.save(body);assert.equal((await f.read(body.requestId)).found,true);
    assert.ok((await fs.readdir(f.root)).some(name=>name.startsWith('.pending-')));
  });
});
