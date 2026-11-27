import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createStore} from '../lib/store.mjs';
import {fakeSupabase} from './fake-supabase.mjs';
import {createSessionToken,verifySessionToken,decryptCredentials} from '../lib/security.mjs';
import {expiredState,renewalEnv,alterCredentials,tokenResponse,ID,DOMAIN,SECRET,NEW,SCOPES,secretPattern} from './shopify-token-renewal-fixture.mjs';
import {createShopifyRuntimeRenewal,createShopifyRuntimeRenewalRehearsal,SHOPIFY_RUNTIME_RENEWAL_PATH as PATH} from '../lib/shopify-renewal-runtime.mjs';
import {RUNTIME_RENEWAL_CONNECTION,prepareRuntimeRenewalChange,assertShopifyRuntimeRenewalPermit} from '../lib/shopify-renewal-runtime-permit.mjs';

const ORIGIN='http://127.0.0.1:48137';
async function fixture(t,options={}) {
  const state=options.state??expiredState({legacy:false});state.connections[0].id=RUNTIME_RENEWAL_CONNECTION;
  state.shopifyTokenExchanges[0].binding.connectionId=RUNTIME_RENEWAL_CONNECTION;
  const fake=options.fake??fakeSupabase({initialStates:[state]}),calls=[],requests=[],logs=[];
  for(const name of ['warn','error'])t.mock.method(console,name,(...v)=>logs.push(v.join(' ')));
  const transport=async(url,settings={})=>{
    assert.equal(new URL(url).origin,'https://runtime.supabase.invalid');
    calls.push({path:new URL(url).pathname,method:settings.method??'GET'});
    const proceed=()=>fake.fetchImpl(url,settings);
    return options.intercept?options.intercept({settings,fake,proceed,calls}):proceed();
  };
  const env={...renewalEnv(state),RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE:'disabled/v1',RUNVARA_OWNER_SHOPIFY_RUNTIME_RENEWAL:'enabled/v1',
    SUPABASE_URL:'https://runtime.supabase.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-only',SESSION_SECRET:SECRET,CREDENTIALS_KEY:SECRET,APP_PUBLIC_URL:ORIGIN,...options.env};
  const store=createStore(env,{fetchImpl:transport});
  const integrations={shopifyConfig(s){const c=s.connections[0],v=decryptCredentials(c.encryptedCredentials,SECRET);return {...v,connection:c,workspaceId:ID,domain:DOMAIN,apiVersion:'2026-07'};}};
  const fetchImpl=async(url,init)=>{assert.equal(url,'https://wavtzm-vy.myshopify.com/admin/oauth/access_token');assert.equal(init.method,'POST');assert.equal(init.redirect,'error');requests.push({method:init.method});return options.issuer?options.issuer({fake,requests}):tokenResponse();};
  let tail=Promise.resolve();const withWorkspaceLock=(_id,fn)=>{const task=tail.then(fn);tail=task.catch(()=>{});return task;};
  const make=()=>createShopifyRuntimeRenewal({env,store,integrations,fetchImpl,withWorkspaceLock,...options.clock});
  let controller=make(),http=createShopifyRuntimeRenewalRehearsal({controller,origin:ORIGIN,mode:'offline-owner-http/v1'});
  const token=createSessionToken({userId:state.users[0].id,workspaceId:ID,email:'synthetic@example.test',role:'owner',sessionVersion:1},SECRET),session=verifySessionToken(token,SECRET),cookie='__Host-packsmart_session='+token;
  async function request(part,body,extra={}) {
    const req=new Request(ORIGIN+PATH+part,{method:body===undefined?'GET':'POST',headers:{cookie,Origin:ORIGIN,'X-CSRF-Token':session.csrf,'Content-Type':'application/json',...extra.headers},
      ...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)}),...(extra.signal?{signal:extra.signal}:{})});
    const response=await http.handle(req);return {status:response.status,body:await response.json()};
  }
  const review=async()=>{const r=await request('/review');assert.equal(r.status,200,JSON.stringify(r));return r.body;};
  const approve=async()=>{const r=await request('/approve',await review());assert.equal(r.status,200,JSON.stringify(r));return {requestId:r.body.requestId,expectedRevision:r.body.expectedRevision};};
  return {state,fake,store,env,controller,requests,calls,logs,request,review,approve,session,cookie,
    restart(){controller.close();controller=make();http=createShopifyRuntimeRenewalRehearsal({controller,origin:ORIGIN,mode:'offline-owner-http/v1'});return controller;}};
}
const patches=f=>f.calls.filter(x=>x.method==='PATCH');

test('default off, no production mount and no implicit network transport',()=>{
  assert.equal(createShopifyRuntimeRenewal(),null);
  assert.throws(()=>createShopifyRuntimeRenewal({env:{RUNVARA_OWNER_SHOPIFY_RUNTIME_RENEWAL:'wrong'}}));
  assert.throws(()=>createShopifyRuntimeRenewalRehearsal({controller:{},origin:'https://packsmart-ops.onrender.com',mode:'offline-owner-http/v1'}));
});
test('explicit approval and four narrow CAS writes reuse existing issuer and receipt path',async t=>{
  const f=await fixture(t),before=structuredClone(f.fake.states.get(ID));
  const a=await f.approve();assert.equal(patches(f).length,1);assert.equal(f.requests.length,0);
  const result=await f.request('/run',a);assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.outcome,'stored');
  const saved=f.fake.states.get(ID);assert.equal(patches(f).length,4);assert.equal(f.requests.length,1);
  assert.equal(decryptCredentials(saved.connections[0].encryptedCredentials,SECRET).accessToken,NEW);
  assert.deepEqual(saved.shopifyTokenExchanges.at(-1).returnedScopes,SCOPES);
  assert.equal(saved.shopifyTokenExchanges.at(-1).replacesRequestId,before.shopifyTokenExchanges.at(-1).requestId);
  assert.equal(saved.shopifyRenewalApprovals[0].status,'claimed');
  for(const k of ['products','orders','economics','costHistory','connectionSettings','autopilot','agentOps'])assert.deepEqual(saved[k],before[k],k);
  assert.ok(f.calls.every(x=>x.method==='GET'||x.path.endsWith('/saas_workspace_state')&&x.method==='PATCH'));
  assert.doesNotMatch(JSON.stringify([result,(await f.request('/status')).body,saved.audit,f.logs]),secretPattern);
  assert.equal((await f.request('/run',a)).status,409);assert.equal(f.requests.length,1);
});
for(const change of ['admin','member','wrong-workspace','revoked','password-change','inactive','expired-cookie','bad-cookie','origin','csrf','cross-site'])test('HTTP owner admission rejects '+change,async t=>{
  const f=await fixture(t),review=await f.review(),s=f.fake.states.get(ID),extra={headers:{}};
  if(change==='admin'||change==='member')s.users[0].role=change;
  if(change==='wrong-workspace')s.workspace.id='other';if(change==='revoked')s.users[0].sessionVersion++;if(change==='password-change')s.users[0].passwordChangeRequired=true;if(change==='inactive')s.users[0].active=false;
  if(change==='bad-cookie')extra.headers.cookie='__Host-packsmart_session=bad';
  if(change==='expired-cookie')extra.headers.cookie='__Host-packsmart_session='+createSessionToken({userId:s.users[0].id,workspaceId:ID,email:'synthetic@example.test',role:'owner'},SECRET,-1);
  if(change==='origin')extra.headers.Origin='https://foreign.invalid';if(change==='csrf')extra.headers['X-CSRF-Token']='wrong';if(change==='cross-site')extra.headers['sec-fetch-site']='cross-site';
  assert.notEqual((await f.request('/approve',review,extra)).status,200);assert.equal(patches(f).length,0);assert.equal(f.requests.length,0);
});
for(const change of ['revision','prior','domain','connection','action','scope','confirmation','secret-field','expiry-long','expiry-past','duplicate-json'])test('review binding rejects '+change,async t=>{
  const f=await fixture(t);let r=await f.review();
  if(change==='revision')r.expectedRevision=randomUUID();if(change==='prior')r.previousRequestId=randomUUID();if(change==='domain')r.domain='other.myshopify.com';if(change==='connection')r.connectionId='other';
  if(change==='action')r.action='import';if(change==='scope')r.scopes.push('write_products');if(change==='confirmation')r.confirmation='yes';if(change==='secret-field')r.accessToken='synthetic-secret';
  if(change==='expiry-long')r.expiresAt=new Date(Date.now()+600000).toISOString();if(change==='expiry-past')r.expiresAt=new Date(Date.now()-1).toISOString();
  if(change==='duplicate-json')r=JSON.stringify(r).replace('{','{"action":"import",');
  assert.notEqual((await f.request('/approve',r)).status,200);assert.equal(patches(f).length,0);assert.equal(f.requests.length,0);
});
for(const kind of ['usable','malformed','scope','settings','ciphertext'])test('existing private validator still rejects '+kind,async t=>{
  const s=expiredState({legacy:false});
  if(kind==='settings')s.connectionSettings.shopify.changed=true;
  else alterCredentials(s,c=>{if(kind==='usable'){c.expiresAt=Date.now()+3600000;c.issuedAt=c.expiresAt-86399000;}if(kind==='malformed')c.expiresAt=null;if(kind==='scope')c.scopes.push('write_orders');if(kind==='ciphertext')c.accessToken='synthetic-other-expired-token';});
  const f=await fixture(t,{state:s}),a=await f.approve(),before=f.fake.states.get(ID).connections[0].encryptedCredentials;
  assert.equal((await f.request('/run',a)).status,409);assert.equal(f.requests.length,0);assert.equal(f.fake.states.get(ID).connections[0].encryptedCredentials,before);
  assert.equal(f.fake.states.get(ID).shopifyRenewalApprovals[0].status,'claimed');assert.equal((await f.request('/approve',await f.review().catch(()=>({})))).status,409);
});
test('concurrent run clicks issue once',async t=>{
  const f=await fixture(t),a=await f.approve(),results=await Promise.all([f.request('/run',a),f.request('/run',a)]);
  assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);assert.equal(f.requests.length,1);
});
test('competing approvals use primary CAS, never a generic state overwrite',async t=>{
  const f=await fixture(t),r=await f.review(),other={...r,requestId:randomUUID()};
  const results=await Promise.all([f.request('/approve',r),f.request('/approve',other)]);
  assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);assert.equal(f.fake.states.get(ID).shopifyRenewalApprovals.length,1);
});
test('restart refuses unclaimed permission until explicit close and new review',async t=>{
  const f=await fixture(t),a=await f.approve();f.restart();
  assert.equal((await f.request('/run',a)).status,409);assert.equal(f.requests.length,0);
  assert.equal((await f.request('/close',a)).status,200);const b=await f.approve();assert.notEqual(b.requestId,a.requestId);
  assert.equal((await f.request('/run',b)).status,200);assert.equal(f.requests.length,1);
});
for(const failure of ['timeout','refusal','malformed'])test('issuer '+failure+' stays spent after restart and close',async t=>{
  const f=await fixture(t,{issuer:()=>{if(failure==='timeout')throw Error('synthetic timeout');return failure==='refusal'?Response.json({}, {status:401}):new Response('bad');}}),a=await f.approve();
  assert.equal((await f.request('/run',a)).status,409);assert.equal(f.requests.length,1);f.restart();
  assert.equal((await f.request('/run',a)).status,409);
  const current=f.fake.states.get(ID);assert.equal((await f.request('/close',{requestId:a.requestId,expectedRevision:current._revision})).status,200);
  assert.equal((await f.request('/review')).status,409);assert.equal(f.requests.length,1);assert.equal(current.shopifyTokenExchanges.at(-1).status,'reserved');
});
for(const write of [1,2,3,4])for(const committed of [false,true])test('unresolved write '+write+' committed='+committed+' never replays',async t=>{
  let writes=0,unavailable=false;const f=await fixture(t,{intercept:async({settings,proceed})=>{
    if(unavailable)throw Error('synthetic reconciliation unavailable');
    if(settings.method==='PATCH'&&++writes===write){if(committed)await proceed();unavailable=true;throw Error('synthetic network unknown');}return proceed();}});
  const review=await f.review(),approval=await f.request('/approve',review);
  if(approval.status===200){const a={requestId:review.requestId,expectedRevision:approval.body.expectedRevision};assert.equal((await f.request('/run',a)).status,409);const n=f.requests.length;unavailable=false;f.restart();assert.equal((await f.request('/run',a)).status,409);assert.equal(f.requests.length,n);}
  else {assert.equal(f.requests.length,0);unavailable=false;f.restart();assert.equal((await f.request('/run',{requestId:review.requestId,expectedRevision:f.fake.states.get(ID)._revision})).status,409);}
  assert.equal(writes,write);assert.equal(f.requests.length,write===4?1:0);
});

for(const write of [1,2,3,4])test('lost acknowledgement '+write+' reconciles by exact revision without replay',async t=>{
  let writes=0;const f=await fixture(t,{intercept:async({settings,proceed})=>{
    if(settings.method==='PATCH'&&++writes===write){await proceed();throw Error('synthetic lost acknowledgement');}return proceed();}});
  const a=await f.approve();assert.equal((await f.request('/run',a)).status,200);
  assert.equal(writes,4);assert.equal(f.requests.length,1);assert.equal(f.fake.states.get(ID).shopifyTokenExchanges.at(-1).status,'stored');
  assert.equal((await f.request('/run',a)).status,409);assert.equal(writes,4);
});

test('independent controllers race approval at primary CAS',async t=>{
  let started,release,count=0;const both=new Promise(r=>started=r),gate=new Promise(r=>release=r);
  const intercept=async({settings,proceed})=>{if(settings.method==='PATCH'){if(++count===2)started();await gate;}return proceed();};
  const f=await fixture(t,{intercept}),g=await fixture(t,{fake:f.fake,intercept});
  const a=await f.review(),b=await g.review(),first=f.request('/approve',a),second=g.request('/approve',b);
  await both;release();const results=await Promise.all([first,second]);
  assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);assert.equal(f.fake.states.get(ID).shopifyRenewalApprovals.length,1);
  assert.equal(f.requests.length+g.requests.length,0);
});

for(const change of ['revoked','role','session-expired'])test('fresh session '+change+' after approval blocks issuer',async t=>{
  let now=Date.now();const f=await fixture(t,{clock:{now:()=>now}}),a=await f.approve(),s=f.fake.states.get(ID);
  if(change==='revoked')s.users[0].sessionVersion++;if(change==='role')s.users[0].role='admin';if(change==='session-expired')now=f.session.exp*1000;
  assert.equal((await f.request('/run',a)).status,409);assert.equal(f.requests.length,0);assert.equal(patches(f).length,1);
});

test('expiry during approval persistence leaves no executable acknowledgement',async t=>{
  let now=Date.now();const f=await fixture(t,{clock:{now:()=>now},intercept:async({settings,proceed})=>{
    const out=await proceed();if(settings.method==='PATCH')now+=300001;return out;}});
  const r=await f.review();assert.equal((await f.request('/approve',r)).status,409);
  assert.equal((await f.request('/run',{requestId:r.requestId,expectedRevision:f.fake.states.get(ID)._revision})).status,409);assert.equal(f.requests.length,0);
});

for(const key of ['RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE','RUNVARA_QUIET_SHOPIFY_CATALOGUE','RUNVARA_QUIET_SHOPIFY_DIAGNOSTIC'])test('mixed capability denied: '+key,async t=>{
  await assert.rejects(fixture(t,{env:{[key]:'enabled/v1'}}),{code:'SHOPIFY_RUNTIME_MIXED_CAPABILITIES'});
});

test('a different signed session cannot consume the approving session permission',async t=>{
  const f=await fixture(t),a=await f.approve();
  const token=createSessionToken({userId:f.session.sub,workspaceId:ID,email:'synthetic@example.test',role:'owner',sessionVersion:1},SECRET),session=verifySessionToken(token,SECRET);
  assert.equal((await f.request('/run',a,{headers:{cookie:'__Host-packsmart_session='+token,'X-CSRF-Token':session.csrf}})).status,409);
  assert.equal(patches(f).length,1);assert.equal(f.requests.length,0);
});

test('same owner fresh login can close an expired unused grant without executing it',async t=>{
  let now=Date.now();const f=await fixture(t,{clock:{now:()=>now}}),a=await f.approve();now+=300001;
  const token=createSessionToken({userId:f.session.sub,workspaceId:ID,email:'synthetic@example.test',role:'owner',sessionVersion:1},SECRET),session=verifySessionToken(token,SECRET);
  assert.equal((await f.request('/close',a,{headers:{cookie:'__Host-packsmart_session='+token,'X-CSRF-Token':session.csrf}})).status,200);
  assert.equal(f.fake.states.get(ID).shopifyRenewalApprovals[0].status,'closed');assert.equal(f.requests.length,0);
  assert.equal((await f.request('/review')).status,200);
});

test('another owner cannot close a grant belonging to the approving owner',async t=>{
  const f=await fixture(t),a=await f.approve(),state=f.fake.states.get(ID),id='synthetic-second-owner';
  state.users.push({...state.users[0],id,email:'second@example.test'});
  const token=createSessionToken({userId:id,workspaceId:ID,email:'second@example.test',role:'owner',sessionVersion:1},SECRET),session=verifySessionToken(token,SECRET);
  assert.equal((await f.request('/close',a,{headers:{cookie:'__Host-packsmart_session='+token,'X-CSRF-Token':session.csrf}})).status,409);
  assert.equal(patches(f).length,1);assert.equal(f.requests.length,0);
});

test('fresh owner session closure cannot clear an unresolved issuer outcome',async t=>{
  const f=await fixture(t,{issuer:()=>{throw Error('synthetic unknown issuer');}}),a=await f.approve();await f.request('/run',a);
  const token=createSessionToken({userId:f.session.sub,workspaceId:ID,email:'synthetic@example.test',role:'owner',sessionVersion:1},SECRET),session=verifySessionToken(token,SECRET);
  assert.equal((await f.request('/close',{requestId:a.requestId,expectedRevision:f.fake.states.get(ID)._revision},{headers:{cookie:'__Host-packsmart_session='+token,'X-CSRF-Token':session.csrf}})).status,200);
  assert.equal((await f.request('/review')).status,409);assert.equal(f.requests.length,1);
});

test('unknown required archive leaves no approval or issuer dispatch',async t=>{
  const state=expiredState({legacy:false});state.audit=Array.from({length:301},(_,i)=>({id:'runtime-audit-'+i,type:'synthetic',actor:'fixture',detail:{},createdAt:new Date().toISOString()}));
  const f=await fixture(t,{state,intercept:async({settings,proceed})=>{
    if(settings.method==='POST'){await proceed();throw Error('synthetic archive acknowledgement missing');}return proceed();}}),before=structuredClone(f.fake.states.get(ID));
  assert.equal((await f.request('/approve',await f.review())).status,409);
  assert.equal(patches(f).length,0);assert.equal(f.requests.length,0);assert.deepEqual(f.fake.states.get(ID),before);
});

test('hard capacity bound refuses approval before primary/archive writes',async t=>{
  const state=expiredState({legacy:false});state.padding='x'.repeat(2097152);const f=await fixture(t,{state});
  assert.equal((await f.request('/approve',await f.review())).status,409);
  assert.equal(f.calls.filter(x=>x.method!=='GET').length,0);assert.equal(f.requests.length,0);
});

test('another controller durably closes an in-flight grant; original cannot save token',async t=>{
  let release,started;const sent=new Promise(r=>started=r),wait=new Promise(r=>release=r);
  const f=await fixture(t,{issuer:async()=>{started();await wait;return tokenResponse();}}),g=await fixture(t,{fake:f.fake}),a=await f.approve();
  const run=f.request('/run',a);await sent;
  const close=await g.request('/close',{requestId:a.requestId,expectedRevision:f.fake.states.get(ID)._revision},{headers:{cookie:f.cookie,'X-CSRF-Token':f.session.csrf}});
  assert.equal(close.status,200);release();assert.equal((await run).status,409);
  assert.equal(f.requests.length,1);assert.equal(g.requests.length,0);assert.equal(f.fake.states.get(ID).shopifyTokenExchanges.at(-1).status,'reserved');
});

test('response after expiry remains spent without token replacement',async t=>{
  let now=Date.now();const f=await fixture(t,{clock:{now:()=>now},issuer:()=>{now+=300001;return tokenResponse();}}),a=await f.approve();
  assert.equal((await f.request('/run',a)).status,409);assert.equal(f.requests.length,1);assert.equal(f.fake.states.get(ID).shopifyTokenExchanges.at(-1).status,'reserved');
});
for(const movement of ['expiry','backward','monotonic'])test('clock '+movement+' fails closed',async t=>{
  let now=Date.now(),mono=1;const f=await fixture(t,{clock:{now:()=>now,monotonic:()=>mono}}),a=await f.approve();
  if(movement==='expiry')now+=300001;if(movement==='backward')now--;if(movement==='monotonic')mono+=300001;
  assert.equal((await f.request('/run',a)).status,409);assert.equal(f.requests.length,0);
});
test('closure during an issuer response blocks replacement, preserves spent evidence',async t=>{
  let release,started;const sent=new Promise(r=>started=r),wait=new Promise(r=>release=r);
  const f=await fixture(t,{issuer:async()=>{started();await wait;return tokenResponse();}}),a=await f.approve();const run=f.request('/run',a);await sent;
  const close=await f.request('/close',{requestId:a.requestId,expectedRevision:f.fake.states.get(ID)._revision});assert.equal(close.status,200);release();
  assert.equal((await run).status,409);assert.equal(f.requests.length,1);assert.equal(f.fake.states.get(ID).shopifyTokenExchanges.at(-1).status,'reserved');
});
test('request interruption after issuer dispatch never retries or replaces',async t=>{
  const abort=new AbortController();const f=await fixture(t,{issuer:()=>{abort.abort();return tokenResponse();}}),a=await f.approve();
  assert.equal((await f.request('/run',a,{signal:abort.signal})).status,409);assert.equal(f.requests.length,1);assert.equal(f.fake.states.get(ID).shopifyTokenExchanges.at(-1).status,'reserved');
});
test('stale revision or session after approval blocks claim',async t=>{
  const f=await fixture(t),a=await f.approve();f.fake.states.get(ID)._revision=randomUUID();assert.equal((await f.request('/run',a)).status,409);assert.equal(f.requests.length,0);
});
test('branded persistence permit is one-use and rejects unrelated state change',async t=>{
  const f=await fixture(t),state=await f.store.get(ID,{exactSnapshot:true}),auth={state,session:f.session};
  const {challenge,...review}=await f.review();const plan=prepareRuntimeRenewalChange(auth,'approve',review);plan.state.economics.changed=123;
  assert.throws(()=>assertShopifyRuntimeRenewalPermit(plan.permit,ID,plan.state));
  assert.throws(()=>assertShopifyRuntimeRenewalPermit({},ID,state));assert.equal(patches(f).length,0);
});
test('no other route or production transport is admitted',async t=>{
  const f=await fixture(t);for(const part of ['/import','/refresh','/orders','/customers','/run?query=x'])assert.equal((await f.request(part,{})).status,404);
  assert.equal(f.requests.length,0);assert.equal(patches(f).length,0);
});

test('authenticated stop latches before its asynchronous freshness read',async t=>{
  let releaseIssuer,signalIssuer,releaseRead,signalRead,hold=false;
  const issued=new Promise(r=>signalIssuer=r),issuerWait=new Promise(r=>releaseIssuer=r),reading=new Promise(r=>signalRead=r),readWait=new Promise(r=>releaseRead=r);
  const f=await fixture(t,{issuer:async()=>{signalIssuer();await issuerWait;return tokenResponse();},intercept:async({settings,proceed})=>{
    if(hold&&settings.method!=='PATCH'){hold=false;signalRead();await readWait;}return proceed();
  }}),a=await f.approve(),pending=f.request('/run',a);await issued;
  const state=await f.store.get(ID,{exactSnapshot:true}),original=structuredClone(state.connections);hold=true;
  const stopping=f.controller.revoke({state,session:f.session},{requestId:a.requestId,expectedRevision:state._revision});await reading;
  releaseIssuer();assert.equal((await pending).status,409);assert.deepEqual(f.fake.states.get(ID).connections,original);
  releaseRead();await stopping;assert.equal(f.fake.states.get(ID).shopifyRenewalApprovals[0].status,'closed');assert.equal(f.requests.length,1);
});

test('signed review expires at its original server clock deadline',async t=>{
  let now=Date.now();const f=await fixture(t,{clock:{now:()=>now}}),review=await f.review();now=Date.parse(review.expiresAt)+1;
  assert.equal((await f.request('/approve',review)).status,409);assert.equal(patches(f).length,0);assert.equal(f.requests.length,0);
});
