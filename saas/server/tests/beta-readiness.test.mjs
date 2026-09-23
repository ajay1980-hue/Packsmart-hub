import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState, createStore } from '../lib/store.mjs';
import { createSessionToken, verifySessionToken, hashPasswordAsync, verifyPasswordAsync } from '../lib/security.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
import { previewShopifyTagTest, proposeConnectionWrite, executeConnectionWrite } from '../lib/connection-writes.mjs';
import { monitoredSync } from '../lib/scheduler.mjs';

const secret='isolated-beta-test-session-secret-at-least-32', key='isolated-beta-test-credential-key-at-least-32';
const password='IsolatedBetaOnly!2026';
async function fixture(t, extra = {}) {
  const owner=seedWorkspaceState({}, {passwordHash:await hashPasswordAsync(password)});
  owner.products=[{id:'gid://shopify/Product/999',provider:'shopify',title:'CUSTOMER_ZERO_SENTINEL',variants:[]}];
  const fake=fakeSupabase({initialStates:[owner]}), flags={outage:false,providerCalls:0};
  const env={NODE_ENV:'test',APP_PUBLIC_URL:'http://localhost:8787',SUPABASE_URL:'https://isolated.supabase.test',SUPABASE_SERVICE_ROLE_KEY:'test-only',SESSION_SECRET:secret,CREDENTIALS_KEY:key,SHOPIFY_PUBLIC_SYNC_ENABLED:'false',BILLING_CHECKOUT_ENABLED:'false', ...extra};
  const fetchImpl=async(url,options)=>{
    if(String(url).startsWith(env.SUPABASE_URL)) { if(flags.outage)throw new TypeError('isolated database interruption');return fake.fetchImpl(url,options); }
    flags.providerCalls++;throw new Error('Provider network forbidden in beta acceptance fixture');
  };
  const server=createPacksmartServer(env,{fetchImpl});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  function identity(state){const user=state.users[0],token=createSessionToken({userId:user.id,workspaceId:state.workspace.id,email:user.email,role:user.role,sessionVersion:1},secret);return {cookie:`packsmart_session=${token}`,csrf:verifySessionToken(token,secret).csrf};}
  async function request(route,{auth,method='GET',body}={}){const start=performance.now();const response=await fetch(base+route,{method,headers:{...(auth?{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const payload=await response.json();return{status:response.status,payload,ms:performance.now()-start,cookie:response.headers.get('set-cookie')?.split(';')[0]};}
  return{server,fake,flags,env,request,base,ownerAuth:identity(owner),identity};
}

test('email-bound beta invitation creates a fully independent tenant and cannot bypass platform controls',async t=>{
  const f=await fixture(t),auth=f.ownerAuth;
  assert.deepEqual((await f.request('/api/auth/signup-options')).payload,{mode:'beta',enabled:true,invitationRequired:true});
  const details={businessName:'Independent Beta',email:'new-beta@example.test',password};
  assert.equal((await f.request('/api/auth/signup',{method:'POST',body:details})).status,403);
  const invite=await f.request('/api/admin/invitations',{auth,method:'POST',body:{email:details.email}});assert.equal(invite.status,201);
  assert.ok(!JSON.stringify(f.fake.states.get('packsmart-solutions')).includes(invite.payload.token),'raw invitation token is never persisted');
  assert.equal((await f.request('/api/auth/signup',{method:'POST',body:{...details,email:'wrong@example.test',invitation:invite.payload.token}})).status,403);
  assert.equal((await f.request('/api/auth/signup',{method:'POST',body:{...details,invitation:invite.payload.token+'tampered'}})).status,403);
  const signup=await f.request('/api/auth/signup',{method:'POST',body:{...details,invitation:invite.payload.token,workspaceId:'packsmart-solutions',role:'admin'}});assert.equal(signup.status,201);
  const beta={cookie:signup.cookie,csrf:signup.payload.csrf},id=signup.payload.workspace.id;
  const boot=await f.request('/api/bootstrap',{auth:beta});assert.equal(boot.status,200);assert.notEqual(id,'packsmart-solutions');
  assert.equal(JSON.stringify(boot.payload).includes('CUSTOMER_ZERO_SENTINEL'),false);assert.deepEqual(boot.payload.products,[]);assert.deepEqual(boot.payload.orders,[]);assert.deepEqual(boot.payload.connections,[]);assert.deepEqual(boot.payload.approvals,[]);assert.deepEqual(boot.payload.agentRuns,[]);assert.equal(boot.payload.launchAdmin,false);
  assert.equal((await f.request('/api/admin/launch',{auth:beta})).status,403);
  assert.equal((await f.request('/api/admin/invitations',{auth:beta,method:'POST',body:{email:'other@example.test'}})).status,403);
  const denied=await f.request('/api/billing/checkout',{auth:beta,method:'POST',body:{plan:'pro'}});assert.equal(denied.status,403);
  assert.equal((await f.request('/api/auth/signup',{method:'POST',body:{...details,invitation:invite.payload.token}})).status,409);
  let journey=await f.request('/api/onboarding',{auth:beta,method:'POST',body:{revision:0,businessName:'Independent Beta Business',platforms:['shopify']}});assert.equal(journey.status,200);
  assert.equal((await f.request('/api/onboarding',{auth:beta,method:'POST',body:{revision:1,finish:true}})).status,409);
  // Provider consent/import is mocked only in this isolated store. Existing OAuth
  // integration tests exercise the real adapter and workspace-bound callback.
  let state=await f.server.packsmart.store.get(id);
  state.connections=[{id:'beta-connection',provider:'shopify',encryptedCredentials:'ISOLATED_CIPHERTEXT',status:'connected',lastCheckedAt:new Date().toISOString(),metadata:{shopDomain:'independent.myshopify.com'}}];
  state.integrationStatus.shopify={status:'connected',lastSuccessfulSyncAt:new Date().toISOString()};
  state.products=[{id:'gid://shopify/Product/2',provider:'shopify',title:'BETA_ONLY',variants:[]}];await f.server.packsmart.store.save(id,state);
  journey=await f.request('/api/onboarding',{auth:beta,method:'POST',body:{revision:1,reviewPermissions:'shopify'}});assert.equal(journey.status,200);
  journey=await f.request('/api/onboarding',{auth:beta,method:'POST',body:{revision:2,finish:true,reviewControls:true}});assert.equal(journey.status,200);assert.ok(journey.payload.completedAt);
  const restored=await f.request('/api/onboarding',{auth:beta});assert.equal(restored.payload.journey.completedAt,journey.payload.completedAt);
  assert.equal(JSON.stringify((await f.request('/api/bootstrap',{auth})).payload).includes('BETA_ONLY'),false);
  assert.equal(JSON.stringify((await f.request('/api/audit',{auth:beta})).payload).includes('beta_invitation_created'),false);
  assert.equal((await f.request('/api/admin/launch',{auth,method:'PUT',body:{mode:'public'}})).status,400);
  assert.equal((await f.request('/api/admin/launch',{auth,method:'PUT',body:{mode:'closed'}})).status,200);
  assert.equal((await f.request('/api/auth/signup',{method:'POST',body:{...details,email:'closed@example.test'}})).status,404);
  assert.equal((await f.request('/api/admin/launch',{auth,method:'PUT',body:{mode:'public',confirm:'ENABLE PUBLIC SIGNUP'}})).status,200);
  assert.equal((await f.request('/api/auth/signup-options')).payload.invitationRequired,false);
  await f.request('/api/admin/launch',{auth,method:'PUT',body:{mode:'beta'}});
  assert.equal(f.flags.providerCalls,0);
});

test('revoked and expired invitations fail closed, including concurrent replay across replicas',async t=>{
  const f=await fixture(t),auth=f.ownerAuth;
  const invite=(await f.request('/api/admin/invitations',{auth,method:'POST',body:{email:'race@example.test'}})).payload;
  const body={businessName:'Race Beta',email:'race@example.test',password,invitation:invite.token};
  const results=await Promise.all([f.request('/api/auth/signup',{method:'POST',body}),f.request('/api/auth/signup',{method:'POST',body})]);
  assert.equal(results.filter(r=>r.status===201).length,1);assert.equal(results.filter(r=>r.status===409).length,1);
  const revoked=(await f.request('/api/admin/invitations',{auth,method:'POST',body:{email:'revoke@example.test'}})).payload;
  await f.request('/api/admin/invitations',{auth,method:'DELETE',body:{id:revoked.id}});
  assert.equal((await f.request('/api/auth/signup',{method:'POST',body:{...body,email:revoked.email,invitation:revoked.token}})).status,403);
  const expired=(await f.request('/api/admin/invitations',{auth,method:'POST',body:{email:'expired@example.test'}})).payload;
  const state=await f.server.packsmart.store.get('packsmart-solutions');state.launchControl.invitations.find(i=>i.id===expired.id).expiresAt='2000-01-01';await f.server.packsmart.store.save(state.workspace.id,state);
  assert.equal((await f.request('/api/auth/signup',{method:'POST',body:{...body,email:expired.email,invitation:expired.token}})).status,403);
});

test('bounded concurrent reads do not amplify provider requests; database interruption fails safely and recovers',async t=>{
  const f=await fixture(t);const identities=[];
  for(let n=0;n<4;n++){const state=seedWorkspaceState({}, {workspaceId:`load-${n}`,email:`load-${n}@example.test`,passwordHash:await hashPasswordAsync(password)});state.products=Array.from({length:89},(_,i)=>({id:`p-${n}-${i}`,title:`Tenant ${n} product`,provider:'shopify',variants:[{id:`v-${n}-${i}`,sku:`sku-${i}`,price:10,inventory:2}]}));await f.server.packsmart.store.save(state.workspace.id,state);identities.push(f.identity(state));await f.request('/api/bootstrap',{auth:identities[n]});}
  const routes=['/api/auth/session','/api/bootstrap','/api/connection-centre','/api/onboarding','/api/audit','/api/approvals','/api/agents','/api/control'];
  global.gc?.();const memoryBefore=process.memoryUsage().heapUsed;const results=[];const started=performance.now();
  for(let batch=0;batch<20;batch++)results.push(...await Promise.all(routes.map((route,i)=>f.request(route,{auth:identities[(i+batch)%4]}))));
  for(const result of results)assert.equal(result.status,200);
  global.gc?.();const times=results.map(r=>r.ms).sort((a,b)=>a-b);t.diagnostic(JSON.stringify({scope:'isolated mocked Supabase; 4 tenants; 89 products each',requests:results.length,concurrency:8,p50Ms:Math.round(times[Math.floor(times.length*.5)]),p95Ms:Math.round(times[Math.floor(times.length*.95)]),maxMs:Math.round(times.at(-1)),totalMs:Math.round(performance.now()-started),heapDeltaMiB:Number(((process.memoryUsage().heapUsed-memoryBefore)/1048576).toFixed(1)),providerCalls:f.flags.providerCalls}));
  assert.equal(f.flags.providerCalls,0);
  f.flags.outage=true;assert.equal((await f.request('/api/bootstrap',{auth:identities[0]})).status,500);
  f.flags.outage=false;assert.equal((await f.request('/api/bootstrap',{auth:identities[0]})).status,200);
  const logins=await Promise.all([0,1,2,3].map(n=>f.request('/api/auth/login',{method:'POST',body:{email:`load-${n}@example.test`,password}})));assert.ok(logins.every(r=>r.status===200));
});

test('provider timeout, revoked credentials and rate limit preserve previous data and expose recovery evidence',async()=>{
  for(const provider of ['shopify','ebay','meta'])for(const code of ['PROVIDER_TIMEOUT','TOKEN_EXPIRED','ACCESS_DENIED','RATE_LIMITED']){
    const state=seedWorkspaceState({}, {workspaceId:'recovery',passwordHash:'fixture'});state.products=[{id:'retained'}];state.orders=[{id:'retained-order'}];
    state.integrationStatus[provider]={status:'connected',lastSuccessfulSyncAt:'2026-09-01T00:00:00Z'};
    const service={syncProvider:async()=>{throw Object.assign(new Error('SECRET_MUST_NOT_LEAK'),{code});}};
    await assert.rejects(monitoredSync(state,service,provider,{retry:false}));
    assert.deepEqual(state.products,[{id:'retained'}]);assert.deepEqual(state.orders,[{id:'retained-order'}]);assert.equal(state.connectionSyncs[0].status,'failed');assert.equal(state.integrationStatus[provider].lastSuccessfulSyncAt,'2026-09-01T00:00:00Z');assert.ok(!JSON.stringify(state).includes('SECRET_MUST_NOT_LEAK'));
  }
});

test('safe tag preview is read-only and execution refuses a changed before-state',async()=>{
  const state=seedWorkspaceState({}, {workspaceId:'tag-test',passwordHash:'fixture'});state.products=[{id:'gid://shopify/Product/7',provider:'shopify',title:'Test product'}];state.connections=[{id:'c',provider:'shopify',encryptedCredentials:'fixture',metadata:{shopDomain:'test.myshopify.com',grantedScopes:['write_products']}}];
  const calls=[];const service={shopifyConfig:()=>({domain:'test.myshopify.com'}),shopifyGraphql:async(query)=>{calls.push(query);return{product:{id:state.products[0].id,title:'Test product',tags:['existing']}};}};
  const before=JSON.stringify(state),preview=await previewShopifyTagTest(state,state.products[0].id,service);assert.equal(JSON.stringify(state),before);assert.ok(calls.every(q=>q.startsWith('query ')));assert.deepEqual(preview.before,['existing']);assert.equal(preview.proposed.length,2);
  state.connectionSettings={shopify:{permissionMode:'approval_gated'}};
  const write=proposeConnectionWrite(state,'shopify',{...preview.request,requestId:'acceptance-test-request-1'},state.users[0].id);const approval=state.approvals.find(a=>a.id===write.approvalId);approval.status='approved';
  service.shopifyGraphql=async()=>({product:{id:state.products[0].id,tags:['changed']}});
  await assert.rejects(executeConnectionWrite(state,write.id,state.users[0].id,service,async()=>{}),{code:'WRITE_BASELINE_CHANGED'});assert.equal(write.status,'pending_approval');
});

test('asynchronous password verification keeps existing scrypt hashes compatible',async()=>{
  const hash=await hashPasswordAsync(password);assert.equal(await verifyPasswordAsync(password,hash),true);assert.equal(await verifyPasswordAsync('wrong',hash),false);
});

test('health probes coalesce concurrent database checks and dashboard reads stay usable during an in-flight sync',async t=>{
  const f=await fixture(t);let checks=0;
  f.server.packsmart.store.ping=async()=>{checks++;await new Promise(resolve=>setTimeout(resolve,30));return true;};
  const health=await Promise.all(Array.from({length:8},()=>f.request('/api/health')));assert.ok(health.every(r=>r.status===200));assert.equal(checks,1);assert.equal(health[0].payload.checkCacheMaxAgeMs,5000);
  let release;const paused=new Promise(resolve=>release=resolve);let entered;
  const started=new Promise(resolve=>entered=resolve);
  f.server.packsmart.integrations.syncProvider=async()=>{entered();await paused;return {status:'connected'};};
  const syncing=f.request('/api/connections/shopify/sync',{auth:f.ownerAuth,method:'POST',body:{areas:['products']}});
  await started;
  const bootstrap=await Promise.race([f.request('/api/bootstrap',{auth:f.ownerAuth}),new Promise(resolve=>setTimeout(()=>resolve({status:598}),500))]);
  release();await syncing;assert.equal(bootstrap.status,200);assert.equal(bootstrap.payload.products[0].title,'CUSTOMER_ZERO_SENTINEL');
});

test('identity projection excludes business history but honours immediate session revocation',async t=>{
  const f=await fixture(t);
  const auth=await f.request('/api/auth/session',{auth:f.ownerAuth});assert.equal(auth.status,200);
  assert.ok(f.fake.calls.at(-1).url.searchParams.get('select').includes('state->workspace,state->users'));
  assert.equal(JSON.stringify(auth.payload).includes('CUSTOMER_ZERO_SENTINEL'),false);
  const state=await f.server.packsmart.store.get('packsmart-solutions');state.users[0].sessionVersion++;await f.server.packsmart.store.save(state.workspace.id,state);
  assert.equal((await f.request('/api/auth/session',{auth:f.ownerAuth})).status,401);
});

test('existing signed billing lifecycle records are tenant separated, idempotent and reject replay',async t=>{
  const webhookSecret='isolated-stripe-signing-secret';const f=await fixture(t,{STRIPE_WEBHOOK_SECRET:webhookSecret});
  const state=seedWorkspaceState({}, {workspaceId:'billing-beta',email:'billing@example.test',passwordHash:await hashPasswordAsync(password)});await f.server.packsmart.store.save(state.workspace.id,state);
  async function event(id,type,status,created,workspaceId='billing-beta',valid=true){const body=JSON.stringify({id,type,created,data:{object:{id:'sub_test',customer:'cus_test',metadata:{workspace_id:workspaceId,plan:'starter'},status}}});const time=Math.floor(Date.now()/1000);const signature=crypto.createHmac('sha256',webhookSecret).update(`${time}.${body}`).digest('hex');const response=await fetch(f.base+'/api/webhooks/stripe',{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':`t=${time},v1=${valid?signature:'invalid'}`},body});return{status:response.status,payload:await response.json()};}
  assert.equal((await event('e0','customer.subscription.updated','active',100,'billing-beta',false)).status,400);
  assert.equal((await event('e1','customer.subscription.updated','trialing',101)).status,200);
  assert.equal((await event('e2','customer.subscription.updated','active',102)).status,200);
  assert.equal((await event('e2','customer.subscription.updated','active',102)).payload.duplicate,true);
  await event('e-old','customer.subscription.updated','past_due',99);
  assert.equal((await f.server.packsmart.store.get('billing-beta')).subscription.status,'active');
  await event('e3','customer.subscription.updated','past_due',103);assert.equal((await f.server.packsmart.store.get('billing-beta')).subscription.status,'past_due');
  await event('e4','customer.subscription.deleted','canceled',104);assert.equal((await f.server.packsmart.store.get('billing-beta')).subscription.status,'canceled');
  await event('e5','customer.subscription.updated','active',105,'packsmart-solutions');assert.equal((await f.server.packsmart.store.get('packsmart-solutions')).subscription.status,'internal');
});
