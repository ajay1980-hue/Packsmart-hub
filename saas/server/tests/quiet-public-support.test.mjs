import test from 'node:test';
import assert from 'node:assert/strict';
import { createStartupPolicy } from '../lib/startup-mode.mjs';
import { createPacksmartServer } from '../server.mjs';
import { buildSupportReply, supportOrderProjection, validateSupportInput, supportNeedsOrders, SUPPORT_MAX_ORDERS, SUPPORT_READ_MAX_BYTES } from '../lib/customer-support.mjs';
import crypto from 'node:crypto';

const route='/api/public/support';
const env={RUNVARA_STARTUP_MODE:'quiet',RUNVARA_QUIET_PUBLIC_SUPPORT:'enabled/v1'};
const email='buyer@example.test';
const order={provider:'shopify',name:'#1001',customerEmailHash:crypto.createHash('sha256').update(email).digest('hex'),fulfillmentStatus:'UNFULFILLED'};
const input={message:'Where is my order?',orderNumber:'#1001',email};

test('quiet support is strict, immutable, default-off and exact-route/method only',()=>{
  for(const value of [undefined,'disabled/v1']){
    const policy=createStartupPolicy({...env,RUNVARA_QUIET_PUBLIC_SUPPORT:value},[]);
    assert.equal(policy.quietPublicSupport,false);assert.equal(policy.allowsRequest('POST',route),false);
  }
  for(const value of ['',true,null,'true','enabled','enabled/v1 ',1,{}])assert.throws(()=>createStartupPolicy({...env,RUNVARA_QUIET_PUBLIC_SUPPORT:value},[]),{code:'QUIET_PUBLIC_SUPPORT_INVALID'});
  for(const mode of [undefined,'normal'])assert.throws(()=>createStartupPolicy({...env,RUNVARA_STARTUP_MODE:mode},[]),{code:'QUIET_PUBLIC_SUPPORT_INVALID'});
  const options={...env},policy=createStartupPolicy(options,[]);options.RUNVARA_QUIET_PUBLIC_SUPPORT='disabled/v1';
  assert.equal(policy.quietPublicSupport,true);assert.throws(()=>{policy.quietPublicSupport=false;},TypeError);
  for(const method of ['GET','HEAD','POST','OPTIONS','PUT','PATCH','DELETE','post'])for(const path of [route,route+'/',route+'?x=1','/api/public/%73upport','/api/bootstrap','/api/auth/login','/api/maintenance/commerce','/api/marketing/providers/runway/test']){
    assert.equal(policy.allowsRequest(method,path),path===route&&['POST','OPTIONS'].includes(method),`${method} ${path}`);
  }
});

test('enabled quiet support cannot fall back to ordinary workspace hydration or file storage',()=>{
  for(const store of [{provider:'file',getPublicSupportOrders(){}},{provider:'supabase',get(){assert.fail('hydration');}}]){
    assert.throws(()=>createPacksmartServer(env,{store}),{code:'QUIET_PUBLIC_SUPPORT_UNAVAILABLE'});
  }
});

test('only complete order-status inputs require saved orders; client tenant selectors are discarded',()=>{
  const normalized=validateSupportInput({...input,workspaceId:'foreign',tenantId:'foreign',orders:[order]});
  assert.deepEqual(normalized,input);assert.equal(supportNeedsOrders(normalized),true);
  for(const value of [{message:'Hi'},{message:'Track order'},{...input,email:''},{...input,orderNumber:''}])assert.equal(supportNeedsOrders(validateSupportInput(value)),false);
});

test('saved order projection drops unrelated data, does not mutate it and bounds rows/bytes/types',()=>{
  const source=[{...order,email:'private-sentinel',address:'private-sentinel',credentials:'private-sentinel',total:123,notes:'private-sentinel'}];
  const before=structuredClone(source);
  assert.deepEqual(supportOrderProjection(source),[order]);assert.deepEqual(source,before);
  assert.deepEqual(supportOrderProjection([{provider:'ebay',name:{unrelated:true}},{...order,orderNumber:1001}]),[{...order,orderNumber:'1001'}]);
  for(const bad of [null,{},[null],[[]],[{...order,name:{}}],[{...order,name:'x'.repeat(81)}],Array(SUPPORT_MAX_ORDERS+1).fill(order),[{...order,notes:'x'.repeat(SUPPORT_READ_MAX_BYTES)}]]){
    assert.throws(()=>supportOrderProjection(bad),{code:'SUPPORT_UNAVAILABLE'});
  }
});

test('ambiguous saved order matches fail closed instead of exposing the first status or tracking link',()=>{
  const result=buildSupportReply({orders:[order,{...order,fulfillmentStatus:'DELIVERED',statusPageUrl:'https://packsmartsolutions.com/private'}]},input);
  assert.notEqual(result.matchedOrder,true);assert.equal(result.needsHuman,true);
  assert.doesNotMatch(result.reply,/DELIVERED|delivered|private/);
});

test('saved status labels freshness and filters untrusted or credential-bearing tracking destinations',()=>{
  for(const statusPageUrl of ['javascript:alert(1)','http://packsmartsolutions.com/order','https://evil.example.test/order','https://packsmartsolutions.com.evil.example.test/order','https://user:pass@packsmartsolutions.com/order','https://packsmartsolutions.com/<tag>']){
    const result=buildSupportReply({orders:[{...order,statusPageUrl}]},input);
    assert.equal(result.source,'saved_order');assert.match(result.reply,/not a live carrier check/);
    assert.ok(!result.reply.includes(statusPageUrl));
  }
  const url='https://packsmartsolutions.com/order/fixture';
  assert.ok(buildSupportReply({orders:[{...order,statusPageUrl:url}]},input).reply.includes(url));
});

test('human-required responses do not claim messages, refunds or order changes were executed',()=>{
  for(const message of ['Return or refund','Change my delivery address','VAT invoice']){
    const result=buildSupportReply({}, {message});assert.equal(result.needsHuman,true);
    assert.match(result.reply,/contact Packsmart/i);
    assert.doesNotMatch(result.reply,/will be passed|will pick it up|I.ll pass/);
  }
});
