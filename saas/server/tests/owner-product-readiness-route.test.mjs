import test from 'node:test';
import assert from 'node:assert/strict';
import {maintenanceFixture,ownerState,SECRET} from './maintenance-login-fixture.mjs';
import {createSessionToken} from '../lib/security.mjs';
import {createStartupPolicy} from '../lib/startup-mode.mjs';
import {createStore} from '../lib/store.mjs';
import {OWNER_PRODUCT_READINESS_PATH as PATH,OWNER_PRODUCT_READINESS_FLAG as FLAG} from '../lib/owner-product-readiness.mjs';
import {SUPPORT_BUNDLE_CONTEXT_SELECT} from '../lib/support-bundle-policy.mjs';
const WS='packsmart-solutions',enabled=()=>({RUNVARA_QUIET_OWNER_LOGIN:'disabled/v1',RUNVARA_QUIET_OWNER_WORKSPACE:'enabled/v1',[FLAG]:'enabled/v1',RUNVARA_QUIET_OWNER_PRODUCT_READINESS_EXPIRES_AT:new Date(Date.now()+240000).toISOString()});
const cookie=(ws=WS,changes={},ttl)=>'__Host-packsmart_session='+createSessionToken({userId:ws+'-owner',workspaceId:ws,email:ws+'@example.test',role:'owner',sessionVersion:1,...changes},SECRET,ttl);
async function fixture(t,options={}){
  t.mock.method(console,'error',()=>{});
  const f=await maintenanceFixture({states:[ownerState(WS),ownerState('beta')],...options,env:{...enabled(),...options.env}});t.after(f.close);return f;
}
const writes=f=>f.calls.filter(x=>!['GET','HEAD'].includes(x.method));
const EXPIRY='RUNVARA_QUIET_OWNER_PRODUCT_READINESS_EXPIRES_AT';
test('expiry closes admission, health and bootstrap while the quiet dashboard remains available',async t=>{
  const start=Date.now();let elapsed=0;t.mock.method(Date,'now',()=>start+elapsed);
  const f=await fixture(t),c=cookie();
  assert.equal((await f.request('/api/health')).payload.quietOwnerProductReadiness,true);
  const before=await f.request('/api/bootstrap',{cookie:c});assert.equal(before.payload.productReadinessAvailable,true);
  assert.equal(before.payload.productReadinessExpiresAt,f.config[EXPIRY]);
  assert.ok(Number.isSafeInteger(before.payload.productReadinessRemainingMs)&&before.payload.productReadinessRemainingMs>0&&before.payload.productReadinessRemainingMs<=240000);
  elapsed=240000;
  const health=await f.request('/api/health');assert.equal(health.payload.quietOwnerProductReadiness,false);
  const count=f.calls.length;assert.equal((await f.request(PATH,{cookie:c})).status,503);assert.equal(f.calls.length,count);
  const after=await f.request('/api/bootstrap',{cookie:c});assert.equal(after.status,200);assert.equal(after.payload.productReadinessAvailable,false);
  assert.equal(after.payload.productReadinessExpiresAt,before.payload.productReadinessExpiresAt);
  assert.equal(after.payload.productReadinessRemainingMs,0);
  elapsed=0;assert.equal((await f.request(PATH,{cookie:c})).status,503,'observed expiry never reopens');
  assert.equal(writes(f).length,0);
});
for(const endRead of [1,2,3])test(`permit expiry after database read ${endRead} suppresses the result and subsequent reads`,async t=>{
  const start=Date.now();let elapsed=0,reads=0;t.mock.method(Date,'now',()=>start+elapsed);
  const f=await fixture(t,{intercept:async({proceed})=>{const result=await proceed();if(++reads===endRead)elapsed=240000;return result;}});
  const r=await f.request(PATH,{cookie:cookie()});assert.equal(r.status,503);assert.equal(r.payload.schema,undefined);
  assert.equal(f.calls.length,endRead);assert.equal(writes(f).length,0);
});
test('the same bounded abort signal reaches identity, catalogue and identity transports',async t=>{
  const signals=[],f=await fixture(t,{intercept:({options,proceed})=>{signals.push(options.signal);return proceed();}});
  assert.equal((await f.request(PATH,{cookie:cookie()})).status,200);assert.equal(signals.length,3);
  assert.ok(signals.every(s=>s instanceof AbortSignal&&s===signals[0]));assert.equal(writes(f).length,0);
});
test('expired configuration starts closed without taking down quiet owner viewing',async t=>{
  const f=await fixture(t,{env:{[EXPIRY]:new Date(Date.now()-1000).toISOString()}});
  assert.equal((await f.request(PATH,{cookie:cookie()})).status,503);assert.equal(f.calls.length,0);
  assert.equal((await f.request('/api/bootstrap',{cookie:cookie()})).status,200);
});
test('an old OFF instance can overlap an expiring instance without waiting for shutdown logs',async t=>{
  const old=await fixture(t,{env:{[FLAG]:'disabled/v1'}}),next=await fixture(t);
  assert.equal(old.server.listening,true);assert.equal(next.server.listening,true);
  assert.equal((await old.request(PATH,{cookie:cookie()})).status,503);assert.equal(old.calls.length,0);
  assert.equal((await next.request(PATH,{cookie:cookie()})).status,200);
  assert.equal(old.server.packsmart.agentOps.status.lastTickAt,null);assert.equal(next.server.packsmart.scheduler.status.lastTickAt,null);
  assert.equal(writes(old).length+writes(next).length,0);
});
test('default OFF, exact GET admission, owner-workspace dependency and invalid flags fail closed',()=>{
  assert.equal(createStartupPolicy({RUNVARA_STARTUP_MODE:'quiet'},[]).allowsRequest('GET',PATH),false);
  for(const v of ['',true,null,'true','enabled/v1 ',{}])assert.throws(()=>createStartupPolicy({RUNVARA_STARTUP_MODE:'quiet',...enabled(),[FLAG]:v},[]),{code:'QUIET_OWNER_PRODUCT_READINESS_INVALID'});
  assert.throws(()=>createStartupPolicy({RUNVARA_STARTUP_MODE:'quiet',[FLAG]:'enabled/v1'},[]),{code:'QUIET_OWNER_PRODUCT_READINESS_INVALID'});
  const p=createStartupPolicy({RUNVARA_STARTUP_MODE:'quiet',...enabled()},[]);
  for(const method of ['GET','HEAD','POST','PUT','OPTIONS','DELETE'])assert.equal(p.allowsRequest(method,PATH),method==='GET');
  for(const route of [PATH+'/',PATH+'?x=1','/api/public/support','/api/public/support/products','/api/connections/shopify/refresh','/api/integrations/sync'])assert.equal(p.allowsRequest('GET',route),false);
});
test('independent public support retains its own exact gate, not enabled by readiness',()=>{
  const p=createStartupPolicy({RUNVARA_STARTUP_MODE:'quiet',...enabled(),RUNVARA_QUIET_PUBLIC_SUPPORT:'enabled/v1'},[]);
  assert.equal(p.allowsRequest('POST','/api/public/support'),true);assert.equal(p.allowsRequest('GET','/api/public/support'),false);
  const closed=createStartupPolicy({RUNVARA_STARTUP_MODE:'quiet',...enabled()},[]);assert.equal(closed.allowsRequest('POST','/api/public/support'),false);
});
test('strict owner reads narrow identity/catalogue/identity; no mutation, jobs or provider calls',async t=>{
  const f=await fixture(t),before=structuredClone([...f.fake.states]);
  const r=await f.request(PATH,{cookie:cookie()});assert.equal(r.status,200,JSON.stringify(r.payload));assert.equal(r.payload.code,'IMPORT_RECEIPT_UNVERIFIED');
  assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.payload.permitsImport,false);assert.equal(r.payload.permitsPublicSupport,false);
  assert.equal(f.calls.length,3);assert.ok(f.calls.every(x=>x.method==='GET'&&x.url.searchParams.get('workspace_id')==='eq.'+WS));
  const select=f.calls[1].url.searchParams.get('select');assert.equal(select,'workspace_id,workspaceId:state->workspace->>id,products:state->products,'+SUPPORT_BUNDLE_CONTEXT_SELECT);
  assert.doesNotMatch(select,/credentials|connections|orders|customers/i);assert.deepEqual([...f.fake.states],before);assert.equal(writes(f).length,0);
  assert.equal(f.store.schedulerCache.size,0);assert.equal(f.server.packsmart.scheduler.status.lastTickAt,null);assert.equal(f.server.packsmart.agentOps.status.lastTickAt,null);
});
for(const role of ['admin','operator','viewer'])test(`denies ${role} before catalogue read`,async t=>{
  const f=await fixture(t);f.fake.states.get(WS).users[0].role=role;const r=await f.request(PATH,{cookie:cookie()});assert.equal(r.status,403);assert.equal(f.calls.length,1);assert.equal(writes(f).length,0);
});
test('anonymous, forged, expired and foreign workspace sessions cannot read catalogue',async t=>{
  const f=await fixture(t);
  for(const c of [undefined,'__Host-packsmart_session=forged',cookie(WS,{},-1)])assert.equal((await f.request(PATH,{cookie:c})).status,401);
  assert.equal(f.calls.length,0);assert.equal((await f.request(PATH,{cookie:cookie('beta')})).status,403);assert.equal(f.calls.length,1);
});
for(const [label,change,status] of [
  ['password change',s=>s.users[0].passwordChangeRequired=true,403],['inactive',s=>s.users[0].active=false,401],
  ['revoked',s=>s.users[0].sessionVersion++,401],['duplicate owner',s=>s.users.push(structuredClone(s.users[0])),403]
])test(`stored identity ${label} fails closed`,async t=>{
  const f=await fixture(t);change(f.fake.states.get(WS));assert.equal((await f.request(PATH,{cookie:cookie()})).status,status);assert.equal(f.calls.length,1);
});
test('revocation while catalogue read is in flight suppresses result',async t=>{
  const f=await fixture(t,{intercept:({url,fake,proceed})=>{if(url.searchParams.get('select')?.includes('products:'))fake.states.get(WS).users[0].role='admin';return proceed();}});
  const r=await f.request(PATH,{cookie:cookie()});assert.equal(r.status,403);assert.equal(r.payload.schema,undefined);assert.equal(f.calls.length,3);assert.equal(writes(f).length,0);
});
test('expiry during final identity read suppresses the response without another database read',async t=>{
  const start=Date.now();let elapsed=0,identities=0;t.mock.method(Date,'now',()=>start+elapsed);
  const f=await fixture(t,{intercept:async({url,proceed})=>{
    const response=await proceed();if(url.searchParams.get('select')==='state->workspace,state->users'&&++identities===2)elapsed=61000;
    return response;
  }});
  const r=await f.request(PATH,{cookie:cookie(WS,{},60)});
  assert.equal(r.status,401);assert.equal(r.payload.code,'AUTH_REQUIRED');assert.equal(r.payload.schema,undefined);
  assert.equal(f.calls.length,3);assert.equal(writes(f).length,0);
});
test('latest receipt controls readiness even when an older receipt says imported',async t=>{
  const f=await fixture(t);f.fake.states.get(WS).shopifyCatalogueImports=[{status:'imported',requestId:'11111111-1111-4111-8111-111111111111'},{status:'reserved',requestId:'22222222-2222-4222-8222-222222222222'}];
  const r=await f.request(PATH,{cookie:cookie()});assert.equal(r.status,200);assert.equal(r.payload.code,'IMPORT_OUTCOME_UNRESOLVED');assert.equal(r.payload.nextStep,'reconcile_existing_import');assert.equal(f.calls.length,3);
});
test('disabled route, queries and unsupported methods do not reach storage',async t=>{
  const f=await fixture(t);
  for(const method of ['HEAD','POST','PUT','DELETE','OPTIONS'])assert.equal((await f.request(PATH,{method,cookie:cookie()})).status,503);
  assert.equal((await f.request(PATH+'?workspaceId=beta',{cookie:cookie()})).status,400);assert.equal(f.calls.length,0);
  const closed=await fixture(t,{env:{[FLAG]:'disabled/v1'}});assert.equal((await closed.request(PATH,{cookie:cookie()})).status,503);assert.equal(closed.calls.length,0);
});
test('database failure is redacted, no retry or writes',async t=>{
  const f=await fixture(t,{fault:({method})=>method==='GET'?new Response('PRIVATE-ERROR',{status:503}):null});
  const r=await f.request(PATH,{cookie:cookie()});assert.notEqual(r.status,200);assert.doesNotMatch(JSON.stringify(r.payload),/PRIVATE-ERROR/);assert.equal(f.calls.length,1);assert.equal(writes(f).length,0);
});
const env={SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-only'};
for(const [label,rows] of [
  ['absent',[]],['extra field',[{workspace_id:WS,workspaceId:WS,products:[],credentials:'PRIVATE'}]],
  ['foreign',[{workspace_id:'beta',workspaceId:WS,products:[]}]],['malformed',[{workspace_id:WS,workspaceId:WS,products:null}]]
])test(`store rejects ${label} without hydration or retries`,async()=>{
  let calls=0;const store=createStore(env,{fetchImpl:async()=>{calls++;return Response.json(rows);}});
  await assert.rejects(store.getOwnerProductReadiness(WS));assert.equal(calls,1);assert.equal(store.schedulerCache.size,0);
});
test('store rejects caller tenant before any request',async()=>{
  let calls=0;const store=createStore(env,{fetchImpl:async()=>{calls++;throw new Error('no');}});await assert.rejects(store.getOwnerProductReadiness('beta'));assert.equal(calls,0);
});
test('bounded store rejects oversized response without retry',async()=>{
  let calls=0;const store=createStore(env,{fetchImpl:async()=>{calls++;return new Response(' '.repeat(2097153));}});
  await assert.rejects(store.getOwnerProductReadiness(WS));assert.equal(calls,1);
});
test('duplicate JSON fields are rejected before projection',async()=>{
  let calls=0;const store=createStore(env,{fetchImpl:async()=>{calls++;return new Response('[{"workspace_id":"packsmart-solutions","workspace_id":"beta","workspaceId":"packsmart-solutions","products":[]}]');}});
  await assert.rejects(store.getOwnerProductReadiness(WS));assert.equal(calls,1);
});
