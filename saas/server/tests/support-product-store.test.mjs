import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore} from '../lib/store.mjs';
import {SUPPORT_PRODUCT_WORKSPACE as WS,supportProductReply} from '../lib/support-product-facts.mjs';
import {eligibleProduct} from './support-product-fixtures.mjs';
import {SUPPORT_BUNDLE_CONTEXT_SELECT} from '../lib/support-bundle-policy.mjs';
const env={SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-not-a-credential'};
const product=()=>eligibleProduct(new Date(Date.now()-1000).toISOString());
function fixture(change=x=>x){
  const calls=[];
  const store=createStore(env,{fetchImpl:async(url,options)=>{calls.push({url:new URL(url),method:options.method||'GET'});return Response.json(change([{workspace_id:WS,workspaceId:WS,products:[product()]}]));}});
  return {store,calls};
}
test('bounded product reader selects catalogue and safe receipt metadata once; arbitrary retail flags cannot admit facts',async()=>{
  const {store,calls}=fixture();const dto=await store.getPublicSupportProduct(WS,'DEMO-RETAIL-25');assert.equal(dto,null);assert.equal(supportProductReply(dto),null);
  assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');assert.equal(calls[0].url.searchParams.get('workspace_id'),'eq.'+WS);
  assert.equal(calls[0].url.searchParams.get('select'),'workspace_id,workspaceId:state->workspace->>id,products:state->products,'+SUPPORT_BUNDLE_CONTEXT_SELECT);assert.equal(calls[0].url.searchParams.get('limit'),'1');
  assert.doesNotMatch(SUPPORT_BUNDLE_CONTEXT_SELECT,/credentials|credentialDigest|settingsDigest|connections|orders|customers/i);
  assert.equal(store.schedulerCache.size,0);assert.doesNotMatch(JSON.stringify(dto),/raw|synthetic-not-a-credential|99999|evidenceRef/);
});
test('foreign tenant is rejected before a product query',async()=>{
  const {store,calls}=fixture();await assert.rejects(store.getPublicSupportProduct('foreign','DEMO-RETAIL-25'),{code:'SUPPORT_UNAVAILABLE'});assert.equal(calls.length,0);
});
for(const [label,change] of [
  ['no row',()=>[]],['multiple rows',rows=>[...rows,...rows]],['wrong row',rows=>[{...rows[0],workspace_id:'foreign'}]],
  ['wrong embedded tenant',rows=>[{...rows[0],workspaceId:'foreign'}]],['missing products',rows=>[{...rows[0],products:null}]],
  ['unexpected field',rows=>[{...rows[0],credentials:'DO-NOT-ECHO'}]]
])test(`product reader fails closed without retry: ${label}`,async()=>{
  const {store,calls}=fixture(change);await assert.rejects(store.getPublicSupportProduct(WS,'DEMO-RETAIL-25'),{code:'SUPPORT_UNAVAILABLE'});assert.equal(calls.length,1);
});
test('failed product read is redacted and not retried',async()=>{
  let calls=0;const store=createStore(env,{fetchImpl:async()=>{calls++;throw new Error('PRIVATE-ERROR');}});
  await assert.rejects(store.getPublicSupportProduct(WS,'DEMO-RETAIL-25'),e=>e.code==='SUPPORT_UNAVAILABLE'&&!e.message.includes('PRIVATE-ERROR'));
  assert.equal(calls,1);
});
