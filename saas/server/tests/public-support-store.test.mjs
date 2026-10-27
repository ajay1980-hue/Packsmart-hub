import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../lib/store.mjs';
import { PUBLIC_SUPPORT_WORKSPACE as WS, SUPPORT_READ_MAX_BYTES } from '../lib/customer-support.mjs';

const env={SUPABASE_URL:'https://support-fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-never-print-key'};
const order={provider:'shopify',name:'#1001',fulfillmentStatus:'UNFULFILLED',customerEmailHash:'a'.repeat(64)};
const row={workspace_id:WS,workspaceId:WS,orders:[{...order,email:'private-sentinel',address:'private-sentinel'}]};
function fixture(response=()=>Response.json([row])){
  const calls=[];
  const store=createStore(env,{fetchImpl:async(url,options)=>{calls.push({url:new URL(url),method:options.method||'GET'});return response();}});
  return {store,calls};
}

test('support reads one bounded primary orders projection with no credentials, hydration, caches, joins or writes',async()=>{
  const {store,calls}=fixture();
  assert.deepEqual(await store.getPublicSupportOrders(WS),[order]);
  assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');
  assert.equal(calls[0].url.searchParams.get('workspace_id'),'eq.'+WS);
  assert.equal(calls[0].url.searchParams.get('select'),'workspace_id,workspaceId:state->workspace->>id,orders:state->orders');
  assert.equal(calls[0].url.searchParams.get('limit'),'1');assert.equal(store.schedulerCache.size,0);
  assert.doesNotMatch(JSON.stringify(store.activitySnapshot(WS)),/private-sentinel|synthetic-never-print-key|1001/);
});

test('support rejects another tenant before issuing any query',async()=>{
  const {store,calls}=fixture();
  for(const id of ['other-tenant',undefined,null,'packsmart-solutions&select=state'])await assert.rejects(store.getPublicSupportOrders(id),{code:'SUPPORT_UNAVAILABLE'});
  assert.equal(calls.length,0);
});

for(const [label,value] of [
  ['no row',[]],['multiple rows',[row,row]],['foreign row',[{...row,workspace_id:'other-tenant'}]],
  ['foreign embedded identity',[{...row,workspaceId:'other-tenant'}]],['missing embedded identity',[{workspace_id:WS,orders:[]}]],
  ['unrequested columns',[{...row,credentials:'private-sentinel'}]],['missing orders',[{...row,orders:null}]],['malformed row',[null]]
])test(`support fails closed on ${label} without retry`,async()=>{
  const {store,calls}=fixture(()=>Response.json(value));
  await assert.rejects(store.getPublicSupportOrders(WS),{code:'SUPPORT_UNAVAILABLE'});assert.equal(calls.length,1);
});

test('support bounds response streaming and rejects malformed/duplicate JSON without retry',async()=>{
  for(const content of ['{"orders":','[{"workspace_id":"packsmart-solutions","workspace_id":"foreign","workspaceId":"packsmart-solutions","orders":[]}]',' '.repeat(SUPPORT_READ_MAX_BYTES+1)]){
    const {store,calls}=fixture(()=>new Response(content,{headers:{'Content-Type':'application/json'}}));
    await assert.rejects(store.getPublicSupportOrders(WS),{code:'SUPPORT_UNAVAILABLE'});assert.equal(calls.length,1);
  }
});

test('support network and upstream errors expose no provider/data details and do not retry',async()=>{
  for(const response of [()=>{throw new Error('private-sentinel');},()=>new Response('private-sentinel',{status:500})]){
    const {store,calls}=fixture(response);
    await assert.rejects(store.getPublicSupportOrders(WS),error=>error.code==='SUPPORT_UNAVAILABLE'&&!error.message.includes('private-sentinel')&&!error.cause);
    assert.equal(calls.length,1);
  }
});

test('local file compatibility reads the fixed workspace without saving or upgrading the fixture',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'runvara-support-'));
  const file=path.join(dir,'fixture.json');
  t.after(async()=>{await fs.rm(file,{force:true});await fs.rmdir(dir);});
  const contents=JSON.stringify({[WS]:{workspace:{id:WS},orders:[order]},foreign:{workspace:{id:'foreign'},orders:[{...order,name:'#foreign'}]}});
  await fs.writeFile(file,contents);
  const store=createStore({SAAS_STATE_FILE:file});
  assert.deepEqual(await store.getPublicSupportOrders(WS),[order]);
  await assert.rejects(store.getPublicSupportOrders('foreign'),{code:'SUPPORT_UNAVAILABLE'});
  assert.equal(await fs.readFile(file,'utf8'),contents);
});
