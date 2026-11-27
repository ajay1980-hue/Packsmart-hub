import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {runtimeOwnerFixture,ID,BASE,secretPattern} from './shopify-runtime-owner-fixture.mjs';
import {expiredState} from './shopify-token-renewal-fixture.mjs';
const writes=f=>f.calls.filter(x=>x.method!=='GET');

test('mounted but default disabled before any auth/state/provider work',async t=>{
  const f=await runtimeOwnerFixture(t,{env:{RUNVARA_OWNER_SHOPIFY_RUNTIME_RENEWAL:undefined}});
  for(const action of ['review','status','approve','run','close'])assert.equal((await f.call(action,['review','status'].includes(action)?undefined:{})).status,503);
  assert.equal(f.calls.length,0);assert.equal(f.issued.length,0);
  const b=await f.request('/api/bootstrap',{cookie:f.cookie});assert.equal(b.payload.shopifyRuntimeRenewal.enabled,false);
  assert.equal(writes(f).length,0);assert.equal((await f.request('/api/health')).payload.ownerShopifyRuntimeRenewal,false);
});
test('bootstrap, repeated review and status GET never issue a permit or write',async t=>{
  const f=await runtimeOwnerFixture(t),before=structuredClone(f.fake.states.get(ID));
  await f.request('/api/bootstrap',{cookie:f.cookie});await f.review();await f.review();
  const status=await f.call('status');assert.equal(status.payload.canReview,true);assert.equal(status.payload.approval,null);
  assert.equal(writes(f).length,0);assert.equal(f.issued.length,0);assert.deepEqual(f.fake.states.get(ID),before);
});
test('real owner routes separate approval, one execution, result read and closure',async t=>{
  const f=await runtimeOwnerFixture(t),before=structuredClone(f.fake.states.get(ID)),a=await f.approve();
  assert.equal(writes(f).length,1);assert.equal(f.issued.length,0);assert.equal((await f.call('status')).payload.canRun,true);
  const r=await f.call('run',a);assert.equal(r.status,200,JSON.stringify(r.payload));assert.equal(r.payload.outcome,'stored');assert.equal(r.payload.canRun,false);
  assert.equal(f.issued.length,1);assert.equal(writes(f).length,4);assert.equal((await f.call('run',a)).status,409);
  const status=await f.call('status');assert.equal(status.payload.outcome,'stored');assert.doesNotMatch(JSON.stringify(status.payload),secretPattern);
  const closed=await f.call('close',{requestId:a.requestId,expectedRevision:status.payload.expectedRevision});assert.equal(closed.status,200);assert.equal(closed.payload.canClose,false);
  for(const k of ['products','orders','economics','connectionSettings','autopilot','agentOps'])assert.deepEqual(f.fake.states.get(ID)[k],before[k]);
  assert.equal(f.server.packsmart.scheduler.status.lastTickAt,null);assert.equal(f.server.packsmart.agentOps.status.lastTickAt,null);
});
for(const kind of ['anonymous','admin','member','revoked','wrong-tenant','csrf','origin','missing-origin','bearer','query','duplicate-json','extra-credential','wrong-revision'])test('mounted boundary rejects '+kind,async t=>{
  const f=await runtimeOwnerFixture(t),r=await f.review(),extra={headers:{}};
  if(kind==='anonymous')extra.cookie='';
  if(['admin','member'].includes(kind))f.fake.states.get(ID).users[0].role=kind;
  if(kind==='revoked')f.fake.states.get(ID).users[0].sessionVersion++;
  if(kind==='wrong-tenant')f.fake.states.get(ID).workspace.id='other';
  if(kind==='csrf')extra.headers['X-CSRF-Token']='wrong';
  if(kind==='origin')extra.headers.Origin='https://foreign.invalid';if(kind==='missing-origin')extra.headers.Origin='';
  if(kind==='bearer')extra.headers.Authorization='Bearer synthetic-forbidden';
  if(kind==='wrong-revision')r.expectedRevision=randomUUID();if(kind==='extra-credential')r.clientSecret='synthetic-invalid-input';
  const body=kind==='duplicate-json'?JSON.stringify(r).replace('{','{"action":"import",'):r;
  assert.notEqual((await f.call(kind==='query'?'approve?override=x':'approve',body,extra)).status,200);assert.equal(writes(f).length,0);assert.equal(f.issued.length,0);
});
test('no new import, diagnostic, order, broad sync or public-support capability',async t=>{
  const f=await runtimeOwnerFixture(t);
  for(const path of [BASE+'/anything','/api/owner/shopify-catalogue','/api/owner/shopify-credential-metadata','/api/connections/shopify/refresh','/api/integrations/sync','/api/public/support','/api/orders'])assert.equal((await f.request(path,{method:'POST',cookie:f.cookie,body:{}})).status,503,path);
  assert.equal(writes(f).length,0);assert.equal(f.issued.length,0);
});
test('concurrent mounted executions dispatch one issuer request',async t=>{
  const f=await runtimeOwnerFixture(t),a=await f.approve(),r=await Promise.all([f.call('run',a),f.call('run',a)]);
  assert.deepEqual(r.map(x=>x.status).sort(),[200,409]);assert.equal(f.issued.length,1);
});
test('unknown issuer remains spent through status and close',async t=>{
  const f=await runtimeOwnerFixture(t,{issuer:()=>{throw Error('synthetic issuer uncertainty');}}),a=await f.approve();
  assert.equal((await f.call('run',a)).status,409);const s=(await f.call('status')).payload;assert.equal(s.outcome,'uncertain');
  await f.call('close',{requestId:a.requestId,expectedRevision:s.expectedRevision});assert.equal((await f.call('review')).status,409);assert.equal(f.issued.length,1);
});
test('drain closes in-flight renewal before encrypted replacement',async t=>{
  let sent,release;const started=new Promise(r=>sent=r),wait=new Promise(r=>release=r);
  const f=await runtimeOwnerFixture(t,{issuer:async()=>{sent();await wait;return Response.json({});}}),a=await f.approve(),pending=f.call('run',a);
  await started;const drain=f.server.packsmart.drain();release();assert.equal((await pending).status,409);await drain;
  assert.equal(f.issued.length,1);assert.equal(f.fake.states.get(ID).shopifyTokenExchanges.at(-1).status,'reserved');
});
test('stale saved receipt stops review with fixed redacted error',async t=>{
  const state=expiredState({legacy:false});state.shopifyTokenExchanges[0].binding.appId='wrong';const f=await runtimeOwnerFixture(t,{state});
  const r=await f.call('review');assert.equal(r.status,409);assert.equal(r.payload.code,'SHOPIFY_RUNTIME_STOPPED');assert.equal(writes(f).length,0);assert.equal(f.issued.length,0);
});
