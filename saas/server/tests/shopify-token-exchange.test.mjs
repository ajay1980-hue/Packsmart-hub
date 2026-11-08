import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { maintenanceFixture, SECRET } from './maintenance-login-fixture.mjs';
import { catalogueState, catalogueEnv, response as catalogueResponse, page as cataloguePage, componentNode, ID, DOMAIN } from './shopify-catalogue-import-fixture.mjs';
import { CATALOGUE_PATH, CATALOGUE_QUERY } from '../lib/shopify-catalogue-import.mjs';
import { CATALOGUE_COMPONENT_QUERY } from '../lib/shopify-catalogue-evidence.mjs';
import { createSessionToken, verifySessionToken, encryptCredentials, decryptCredentials } from '../lib/security.mjs';
import { createStartupPolicy } from '../lib/startup-mode.mjs';
import { classifyShopifyCredential } from '../lib/shopify-credential-metadata.mjs';
import { SHOPIFY_TOKEN_PATH as PATH, TOKEN_DESTINATION, createShopifyTokenPolicy, assertShopifyTokenPermit } from '../lib/shopify-token-exchange.mjs';

const CLIENT='9df2fc397d3f5ac01b66a46442fd20f9', KEY='synthetic-client-secret-only', ACCESS='synthetic-issued-access-token';
const SCOPES='read_inventory,read_orders,read_products';
export function tokenState() {
  const s=catalogueState();
  s.connections[0].encryptedCredentials=encryptCredentials({storeDomain:DOMAIN,clientId:CLIENT,clientSecret:KEY},SECRET);
  return s;
}
export function tokenEnv(extra={}) {
  return {RUNVARA_STARTUP_MODE:'quiet',RUNVARA_QUIET_OWNER_WORKSPACE:'enabled/v1',RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE:'enabled/v1',
    RUNVARA_SHOPIFY_TOKEN_REQUEST_ID:randomUUID(),RUNVARA_SHOPIFY_TOKEN_EXPIRES_AT:new Date(Date.now()+300000).toISOString(),
    RUNVARA_SHOPIFY_TOKEN_EXPECTED_CLIENT_ID:CLIENT,RUNVARA_SHOPIFY_TOKEN_EXPECTED_SCOPES:SCOPES,...extra};
}
const response=extra=>Response.json({access_token:ACCESS,scope:SCOPES,expires_in:86399,...extra});
async function fixture(t,options={}) {
  const logs=[]; for(const name of ['error','warn']) t.mock.method(console,name,(...args)=>logs.push(args.join(' ')));
  const state=options.state || tokenState(), env=tokenEnv(options.env), requests=[];
  const f=await maintenanceFixture({...options,states:[state],env,providerFetch:async(url,settings)=>{
    assert.equal(url,TOKEN_DESTINATION); assert.equal(settings.method,'POST'); assert.equal(settings.redirect,'error');
    assert.ok(settings.signal); assert.deepEqual(Object.fromEntries(new URLSearchParams(settings.body)),{grant_type:'client_credentials',client_id:CLIENT,client_secret:KEY});
    assert.equal(new URLSearchParams(settings.body).has('scope'),false);
    requests.push({url,method:settings.method});
    return options.providerFetch?options.providerFetch(f,requests.length):response();
  }});
  t.after(f.close);
  const token=createSessionToken({userId:state.users[0].id,workspaceId:ID,email:'synthetic@example.test',role:'owner',sessionVersion:1},SECRET);
  const session=verifySessionToken(token,SECRET), cookie='__Host-packsmart_session='+token;
  const submit=(body={requestId:env.RUNVARA_SHOPIFY_TOKEN_REQUEST_ID,expectedRevision:f.fake.states.get(ID)._revision},extra={})=>f.request(PATH,{method:'POST',cookie,headers:{'X-CSRF-Token':session.csrf},body,...extra});
  return {...f,env,session,cookie,submit,requests,logs,status:()=>f.request(PATH,{cookie})};
}

for(const [name,value] of [['missing',undefined],['null',null],['empty',''],['malformed','bad'],['wrong','f'.repeat(32)],['uppercase',CLIENT.toUpperCase()]])
test('installed-app policy fails closed: '+name,()=>{
  assert.throws(()=>createShopifyTokenPolicy(tokenEnv({RUNVARA_SHOPIFY_TOKEN_EXPECTED_CLIENT_ID:value})),{code:'SHOPIFY_TOKEN_APP_BINDING_INVALID'});
});
for(const scopes of ['read_inventory,read_products','read_orders,read_products','read_inventory,read_orders',SCOPES+',write_products'])
test('installed scope equality rejects '+scopes,()=>{
  assert.throws(()=>createShopifyTokenPolicy(tokenEnv({RUNVARA_SHOPIFY_TOKEN_EXPECTED_SCOPES:scopes})),{code:'SHOPIFY_TOKEN_SCOPES_INVALID'});
});
test('policy pins the installed app without serializing its public client identifier',()=>{
  const env=tokenEnv(),p=createShopifyTokenPolicy(env);env.RUNVARA_SHOPIFY_TOKEN_EXPECTED_CLIENT_ID='f'.repeat(32);
  assert.deepEqual(p.scopes,SCOPES.split(','));assert.equal(Object.isFrozen(p),true);assert.equal(Object.isFrozen(p.scopes),true);
  assert.doesNotMatch(JSON.stringify(p),new RegExp(CLIENT+'|clientId|CLIENT_ID'));
});
for(const kind of ['stored-id','resolved-config'])test('public app mismatch before reservation: '+kind,async t=>{
  const s=tokenState();if(kind==='stored-id')s.connections[0].encryptedCredentials=encryptCredentials({storeDomain:DOMAIN,clientId:'f'.repeat(32),clientSecret:KEY},SECRET);
  const f=await fixture(t,{state:s}),before=structuredClone(f.fake.states.get(ID));
  if(kind==='resolved-config') {const integrations=f.server.packsmart.integrations,original=integrations.shopifyConfig.bind(integrations);
    t.mock.method(integrations,'shopifyConfig',state=>({...original(state),clientId:'f'.repeat(32)}));}
  assert.equal((await f.status()).payload.appMatch,'unverified');
  assert.equal((await f.submit()).payload.code,'SHOPIFY_TOKEN_APP_BINDING_MISMATCH');
  const status=(await f.status()).payload;assert.equal(status.appId,'gid://shopify/App/408091000833');assert.equal(status.appMatch,'not_matched');assert.equal(status.canRun,false);assert.equal(status.expectedRevision,null);
  assert.deepEqual(f.fake.states.get(ID),before);assert.equal(f.requests.length,0);assert.ok(f.calls.every(c=>c.method==='GET'));
  assert.doesNotMatch(JSON.stringify([status,f.logs]),new RegExp(CLIENT+'|'+KEY+'|ciphertext|clientId|settingsDigest'));
});
test('observed app mismatch stays blocked even if the in-process config is corrected',async t=>{
  const f=await fixture(t),integrations=f.server.packsmart.integrations,original=integrations.shopifyConfig.bind(integrations);let wrong=true;
  t.mock.method(integrations,'shopifyConfig',state=>({...original(state),...(wrong?{clientId:'f'.repeat(32)}:{})}));
  assert.equal((await f.submit()).payload.code,'SHOPIFY_TOKEN_APP_BINDING_MISMATCH');wrong=false;
  assert.equal((await f.submit()).payload.code,'SHOPIFY_TOKEN_APP_BINDING_MISMATCH');assert.equal(f.requests.length,0);assert.ok(f.calls.every(c=>c.method==='GET'));
});
test('configured client identity changing after reservation stops before transmission',async t=>{
  let claimed=false;const f=await fixture(t,{intercept:async({options,proceed})=>{const result=await proceed();if(options.method==='PATCH')claimed=true;return result;}});
  const integrations=f.server.packsmart.integrations,original=integrations.shopifyConfig.bind(integrations);
  t.mock.method(integrations,'shopifyConfig',state=>({...original(state),...(claimed?{clientId:'f'.repeat(32)}:{})}));
  assert.equal((await f.submit()).payload.code,'SHOPIFY_TOKEN_APP_BINDING_MISMATCH');assert.equal(f.requests.length,0);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);
  assert.equal((await f.status()).payload.outcome,'reserved_reconcile_no_replay');assert.equal((await f.status()).payload.appMatch,'not_matched');
});

test('default closed; exact quiet, owner workspace, nonce, deadline and explicit scopes required',()=>{
  assert.equal(createShopifyTokenPolicy({}),null);
  for(const env of [tokenEnv({RUNVARA_STARTUP_MODE:'normal'}),tokenEnv({RUNVARA_QUIET_OWNER_WORKSPACE:'disabled/v1'}),
    tokenEnv({RUNVARA_SHOPIFY_TOKEN_REQUEST_ID:'wrong'}),tokenEnv({RUNVARA_SHOPIFY_TOKEN_EXPIRES_AT:new Date(Date.now()+700000).toISOString()}),
    tokenEnv({RUNVARA_SHOPIFY_TOKEN_EXPECTED_CLIENT_ID:CLIENT,RUNVARA_SHOPIFY_TOKEN_EXPECTED_SCOPES:undefined}),tokenEnv({RUNVARA_SHOPIFY_TOKEN_EXPECTED_CLIENT_ID:CLIENT,RUNVARA_SHOPIFY_TOKEN_EXPECTED_SCOPES:'read_products'}),
    tokenEnv({RUNVARA_SHOPIFY_TOKEN_EXPECTED_CLIENT_ID:CLIENT,RUNVARA_SHOPIFY_TOKEN_EXPECTED_SCOPES:SCOPES+',read_products'}),tokenEnv({RUNVARA_QUIET_SHOPIFY_CATALOGUE:'enabled/v1'})]) assert.throws(()=>createShopifyTokenPolicy(env));
  for(const v of [null,true,'true','enabled/v1 ']) assert.throws(()=>createShopifyTokenPolicy(tokenEnv({RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE:v})));
  const p=createStartupPolicy(tokenEnv(),[]);assert.equal(p.allowsRequest('POST',PATH),true);
  for(const path of ['/api/connections/shopify/test','/api/connections/shopify/sync','/api/connections/ebay/refresh','/api/integrations/sync']) assert.equal(p.allowsRequest('POST',path),false);
  for(const method of ['PUT','DELETE','PATCH','HEAD','OPTIONS']) assert.equal(p.allowsRequest(method,PATH),false);
});
test('expiry and backward clock latch; restart cannot extend absolute expiry',t=>{
  const clock={wall:Date.now(),mono:10}; t.mock.method(Date,'now',()=>clock.wall);t.mock.method(performance,'now',()=>clock.mono);
  const env=tokenEnv({RUNVARA_SHOPIFY_TOKEN_EXPIRES_AT:new Date(clock.wall+1000).toISOString()}),p=createShopifyTokenPolicy(env);
  clock.wall+=100;clock.mono+=100;assert.equal(p.available(),true);clock.wall--;
  assert.equal(p.available(),false);clock.wall++;assert.equal(p.available(),false);
  const p2=createShopifyTokenPolicy(env);clock.mono+=900;assert.equal(p2.available(),false);
  clock.wall+=900;const p3=createShopifyTokenPolicy(env);clock.wall-=1000;assert.equal(p3.available(),false);
});
test('disabled endpoint rejects before any workspace access; no broad activation',async t=>{
  const f=await fixture(t,{env:{RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE:'disabled/v1'}});const n=f.calls.length;
  assert.equal((await f.submit()).status,503);assert.equal(f.calls.length,n);assert.equal(f.requests.length,0);
});

test('strict-owner bootstrap exposes only the fixed setup DTO with no credential/provider activity',async t=>{
  const f=await fixture(t),before=structuredClone(f.fake.states.get(ID));
  const r=await f.request('/api/bootstrap',{cookie:f.cookie});assert.equal(r.status,200);
  assert.deepEqual(r.payload.shopifyTokenExchange,(await f.status()).payload);
  assert.equal(r.payload.shopifyTokenExchange.appMatch,'unverified');
  assert.deepEqual(Object.keys(r.payload.shopifyTokenExchange).sort(),['appId','appMatch','approvedScopes','canRun','domain','enabled','expectedRevision','expiresAt','importEnabled','operation','outcome','previousRequestId','requestId','schema']);
  assert.doesNotMatch(JSON.stringify(r.payload.shopifyTokenExchange),new RegExp(CLIENT+'|'+KEY+'|'+ACCESS+'|ciphertext'));
  assert.equal(f.requests.length,0);assert.deepEqual(f.fake.states.get(ID),before);assert.ok(f.calls.every(c=>c.method==='GET'));
});

test('default-off bootstrap omits setup descriptor; an expired descriptor stays non-runnable',async t=>{
  for(const env of [{RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE:'disabled/v1'},{RUNVARA_SHOPIFY_TOKEN_EXPIRES_AT:'2020-01-01T00:00:00.000Z'}]){
    const f=await fixture(t,{env}),r=await f.request('/api/bootstrap',{cookie:f.cookie});assert.equal(r.status,200);
    if(env.RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE)assert.equal(Object.hasOwn(r.payload,'shopifyTokenExchange'),false);
    else {assert.equal(r.payload.shopifyTokenExchange.canRun,false);assert.equal(r.payload.shopifyTokenExchange.expectedRevision,null);}
    assert.equal(f.requests.length,0);assert.ok(f.calls.every(c=>c.method==='GET'));
  }
});

test('setup descriptor is never exposed by bootstrap to administrator or foreign tenant',async t=>{
  for(const kind of ['admin','tenant']){
    const f=await fixture(t);const s=f.fake.states.get(ID);if(kind==='admin')s.users[0].role='admin';else s.workspace.id='other';
    const r=await f.request('/api/bootstrap',{cookie:f.cookie});assert.equal(r.status,403);assert.equal(Object.hasOwn(r.payload,'shopifyTokenExchange'),false);assert.equal(f.requests.length,0);
  }
});
test('one token request, encrypted save, original credentials/history preserved, no catalogue import',async t=>{
  const f=await fixture(t),before=structuredClone(f.fake.states.get(ID));
  const r=await f.submit(); assert.equal(r.status,200,JSON.stringify(r.payload));assert.equal(r.payload.outcome,'stored');assert.equal(r.headers.get('cache-control'),'no-store');
  assert.equal(r.payload.appMatch,'matched');assert.equal(r.payload.appId,'gid://shopify/App/408091000833');
  const saved=f.fake.states.get(ID),c=saved.connections[0],creds=decryptCredentials(c.encryptedCredentials,SECRET);
  assert.equal(creds.clientId,CLIENT);assert.equal(creds.clientSecret,KEY);assert.equal(creds.accessToken,ACCESS);
  assert.equal(creds.mode,'client_credentials');assert.equal(creds.expiresAt-creds.issuedAt,86399000);
  assert.equal(classifyShopifyCredential(creds).metadataCompatible,true);
  assert.equal(classifyShopifyCredential(creds).credentialType,'client_credentials');
  for(const key of ['products','orders','users','settings','connectionSettings','automations','autopilot','agentOps'])assert.deepEqual(saved[key],before[key],key);
  assert.deepEqual(c.metadata,before.connections[0].metadata);assert.equal(saved.audit.length,before.audit.length+2);
  assert.deepEqual(saved.audit.slice(2),before.audit);assert.equal(f.requests.length,1);
  assert.equal(f.calls.filter(c=>c.method==='PATCH').length,2);assert.equal(f.calls.some(c=>c.method==='POST'),false);
  assert.doesNotMatch(JSON.stringify([r.payload,saved.audit,f.logs]),new RegExp(CLIENT+'|'+KEY+'|'+ACCESS+'|ciphertextDigest'));
  assert.equal((await f.status()).payload.outcome,'stored');assert.equal((await f.submit()).payload.outcome,'stored');assert.equal(f.requests.length,1);
  assert.equal(f.server.packsmart.scheduler.status.lastTickAt,null);assert.equal(f.server.packsmart.agentOps.status.lastTickAt,null);
});
for(const kind of ['csrf','origin','admin','inactive','revoked','password','tenant','duplicate-owner','anonymous','query','stale','extra','wrong-id'])test('reject before claim: '+kind,async t=>{
  const f=await fixture(t),s=f.fake.states.get(ID),u=s.users[0];let extra={},body;
  if(kind==='csrf')extra={headers:{}};if(kind==='origin')extra={headers:{'X-CSRF-Token':f.session.csrf,Origin:'https://forbidden.invalid'}};
  if(kind==='admin')u.role='admin';if(kind==='inactive')u.active=false;if(kind==='revoked')u.sessionVersion++;
  if(kind==='password')u.passwordChangeRequired=true;if(kind==='tenant')s.products.push({workspaceId:'beta'});if(kind==='duplicate-owner')s.users.push(structuredClone(u));
  if(kind==='anonymous')extra={cookie:undefined};
  if(['stale','extra','wrong-id'].includes(kind)){body={requestId:f.env.RUNVARA_SHOPIFY_TOKEN_REQUEST_ID,expectedRevision:s._revision};if(kind==='stale')body.expectedRevision=randomUUID();if(kind==='extra')body.scope='write_products';if(kind==='wrong-id')body.requestId=randomUUID();}
  const r=kind==='query'?await f.request(PATH+'?workspaceId=beta',{cookie:f.cookie}):await f.submit(body,extra);
  assert.ok([400,401,403,409].includes(r.status),JSON.stringify(r.payload));assert.equal(f.requests.length,0);assert.equal(f.calls.some(c=>c.method==='PATCH'),false);
});
for(const kind of ['missing','unknown-shape','saved-token','wrong-domain','config-version','disconnected','duplicate-connection','missing-client','malformed-client','wrong-metadata'])test('source fails closed: '+kind,async t=>{
  const s=tokenState();let creds={storeDomain:DOMAIN,clientId:CLIENT,clientSecret:KEY};let env={};
  if(kind==='missing')s.connections=[];
  if(kind==='unknown-shape')creds.extra=true;if(kind==='saved-token')creds.accessToken=ACCESS;if(kind==='wrong-domain')creds.storeDomain='other.myshopify.com';
  if(kind==='config-version')env.SHOPIFY_ADMIN_API_VERSION='2026-10';if(kind==='disconnected')s.connectionSettings.shopify.disconnected=true;
  if(kind==='missing-client')delete creds.clientId;if(kind==='malformed-client')creds.clientId='short';
  if(kind!=='missing')s.connections[0].encryptedCredentials=encryptCredentials(creds,SECRET);
  if(kind==='wrong-metadata')s.connections[0].metadata.shopDomain='other.myshopify.com';if(kind==='duplicate-connection')s.connections.push(structuredClone(s.connections[0]));
  const f=await fixture(t,{state:s,env});assert.equal((await f.submit()).status,409);assert.equal(f.requests.length,0);assert.equal(f.calls.some(c=>c.method==='PATCH'),false);
});
for(const kind of ['timeout','status401','redirect','malformed-json','oversize','missing-scope','omitted-installed-scope','extra-scope','duplicate-scope','wrong-expiry','coerced-expiry','missing-token','refresh-token'])test('uncertain/rejected response never retries or stores: '+kind,async t=>{
  const f=await fixture(t,{providerFetch:()=>{
    if(kind==='timeout')throw new Error(KEY);if(kind==='status401')return Response.json({error:KEY},{status:401});
    if(kind==='redirect')return new Response(null,{status:302,headers:{Location:'https://forbidden.invalid'}});
    if(kind==='malformed-json')return new Response(KEY);if(kind==='oversize')return response({padding:'x'.repeat(16384)});
    if(kind==='missing-scope')return response({scope:undefined});if(kind==='extra-scope')return response({scope:SCOPES+',write_products'});
    if(kind==='omitted-installed-scope')return response({scope:'read_inventory,read_products'});
    if(kind==='duplicate-scope')return response({scope:SCOPES+',read_products'});if(kind==='wrong-expiry')return response({expires_in:86400});
    if(kind==='coerced-expiry')return response({expires_in:'86399'});if(kind==='missing-token')return response({access_token:undefined});
    return response({refresh_token:'synthetic-refresh-token'});
  }});const before=f.fake.states.get(ID).connections[0].encryptedCredentials;
  assert.equal((await f.submit()).status,502);assert.equal(f.fake.states.get(ID).connections[0].encryptedCredentials,before);
  assert.equal((await f.status()).payload.outcome,'reserved_reconcile_no_replay');assert.equal((await f.submit()).payload.outcome,'reserved_reconcile_no_replay');
  assert.equal(f.requests.length,1);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);assert.doesNotMatch(JSON.stringify(f.logs),new RegExp(KEY+'|'+ACCESS));
});
for(const kind of ['credential','settings','session','revision','account'])test('drift during exchange preserves credentials: '+kind,async t=>{
  const f=await fixture(t,{providerFetch:f=>{const s=f.fake.states.get(ID);
    if(kind==='credential')s.connections[0].encryptedCredentials=encryptCredentials({storeDomain:DOMAIN,accessToken:'newer-synthetic-token'},SECRET);
    if(kind==='settings')s.connectionSettings.shopify.disconnected=true;if(kind==='session')s.users[0].sessionVersion++;
    if(kind==='revision')s._revision=randomUUID();if(kind==='account')s.connections[0].metadata.shopDomain='other.myshopify.com';return response();
  }});assert.notEqual((await f.submit()).status,200);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);assert.equal(f.requests.length,1);
});
test('concurrent submissions spend one durable reservation',async t=>{
  const f=await fixture(t);const r=await Promise.all([f.submit(),f.submit()]);assert.equal(r.filter(r=>r.status===200).length,1);
  assert.equal(f.requests.length,1);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,2);
});
for(const which of [1,2])test('lost commit acknowledgement '+which+' reconciles exact revision without replay',async t=>{
  let writes=0;
  const f=await fixture(t,{intercept:async({options,proceed})=>{if(options.method==='PATCH' && ++writes===which){await proceed();throw new Error(KEY);}return proceed();}});
  const r=await f.submit();assert.equal(r.status,200);assert.equal(f.requests.length,1);
  const status=await f.status();assert.equal(status.payload.outcome,'stored');
  await f.submit();assert.equal(writes,2);assert.equal(f.requests.length,1);
});
for(const which of [1,2])test('unresolved commit '+which+' stops without retry',async t=>{
  let writes=0,unresolved=false;
  const f=await fixture(t,{intercept:async({options,url,proceed})=>{
    if(unresolved && options.method!=='PATCH' && url.searchParams.get('select')==='revision:state->>_revision')throw new Error('Synthetic unavailable reconciliation');
    if(options.method==='PATCH' && ++writes===which){unresolved=true;throw new Error('Synthetic uncertain commit');}return proceed();
  }});
  assert.equal((await f.submit()).status,503);await f.submit();assert.equal(writes,which);assert.equal(f.requests.length,which===1?0:1);
  const status=(await f.status()).payload;assert.equal(status.outcome,which===1?'commit_unconfirmed':'reserved_reconcile_no_replay');assert.equal(status.canRun,false);assert.equal(status.expectedRevision,null);
});
test('reservation after process restart blocks a replacement exchange',async t=>{
  const f=await fixture(t,{providerFetch:()=>{throw new Error('lost');}});await f.submit();
  const g=await fixture(t,{state:structuredClone(f.fake.states.get(ID)),env:f.env});
  assert.equal((await g.submit()).payload.outcome,'reserved_reconcile_no_replay');assert.equal(g.requests.length,0);
});
test('a new permit UUID cannot bypass an unresolved prior reservation',async t=>{
  const f=await fixture(t,{providerFetch:()=>{throw new Error('lost');}});await f.submit();
  const g=await fixture(t,{state:structuredClone(f.fake.states.get(ID))});
  const status=(await g.status()).payload;assert.equal(status.outcome,'prior_request_unresolved');assert.equal(status.canRun,false);assert.equal(status.expectedRevision,null);
  assert.equal((await g.submit()).payload.code,'SHOPIFY_TOKEN_PRIOR_REQUEST_UNRESOLVED');assert.equal(g.requests.length,0);assert.equal(g.calls.some(c=>c.method==='PATCH'),false);
});
test('unissued persistence permits and mixed capabilities fail before writes',async t=>{
  const f=await fixture(t),s=f.fake.states.get(ID);
  assert.throws(()=>assertShopifyTokenPermit({},ID,s));
  await assert.rejects(f.store.save(ID,s,{shopifyTokenPermit:{}}),{code:'SHOPIFY_TOKEN_PERSISTENCE_PERMIT_INVALID'});
  await assert.rejects(f.store.save(ID,s,{shopifyTokenPermit:{},catalogueImportPermit:{}}),{code:'SHOPIFY_TOKEN_PERSISTENCE_PERMIT_INVALID'});
  assert.equal(f.calls.some(c=>c.method!=='GET'),false);
});
test('bounded size guard rejects reservation before provider request',async t=>{
  const s=tokenState();s.unrelated='x'.repeat(2100000);const f=await fixture(t,{state:s});
  assert.equal((await f.submit()).status,503);assert.equal(f.requests.length,0);assert.equal(f.calls.some(c=>c.method==='PATCH'),false);
});
test('normal retention archives required history before commit without mirrors or deletion',async t=>{
  const s=tokenState();s.audit=Array.from({length:305},(_,i)=>({id:'audit_synthetic_'+i,type:'synthetic',actor:'test',detail:{},createdAt:new Date().toISOString()}));
  const f=await fixture(t,{state:s});const r=await f.submit();assert.equal(r.status,200,JSON.stringify(r.payload));
  const writes=f.calls.filter(c=>c.method==='POST');assert.ok(writes.length>0);assert.ok(writes.every(c=>c.url.pathname==='/rest/v1/audit_events'));
  assert.equal(f.calls.some(c=>c.method==='DELETE'),false);assert.equal(f.fake.states.get(ID).shopifyTokenExchanges[0].status,'stored');
  const all=[...f.fake.states.get(ID).audit,...f.fake.tables.get('audit_events')];
  assert.equal(new Set(all.map(a=>a.id)).size,307);for(const row of s.audit)assert.ok(all.some(a=>a.id===row.id));
});
test('client grant classification rejects contradictory/expired data without renewal',async t=>{
  const f=await fixture(t);await f.submit();const creds=decryptCredentials(f.fake.states.get(ID).connections[0].encryptedCredentials,SECRET);
  assert.equal(classifyShopifyCredential(creds,creds.expiresAt).metadataCompatible,false);
  for(const change of [{expiresAt:null},{expiresAt:creds.expiresAt+1},{issuedAt:Date.now()+1000},{scopes:['read_products']},{tokenExchangeRequestId:'bad'},{refreshToken:'extra'}])
    assert.equal(classifyShopifyCredential({...creds,...change}).metadataCompatible,false);
  assert.equal(f.requests.length,1);
});
test('stored grant works with separately enabled catalogue, and does not auto-renew when expired',async t=>{
  const f=await fixture(t);assert.equal((await f.submit()).status,200);const saved=structuredClone(f.fake.states.get(ID));
  for(const expired of [false,true]) {
    const state=structuredClone(saved);if(expired){const c=decryptCredentials(state.connections[0].encryptedCredentials,SECRET);
      c.issuedAt=Date.now()-86400000;c.expiresAt=c.issuedAt+86399000;state.connections[0].encryptedCredentials=encryptCredentials(c,SECRET);}
    let reads=0;const env=catalogueEnv({RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE:'disabled/v1'}),staged=cataloguePage();
    const g=await maintenanceFixture({states:[state],env,providerFetch:async(url,settings)=>{
      assert.equal(url,`https://${DOMAIN}/admin/api/2026-07/graphql.json`);assert.equal(settings.headers['X-Shopify-Access-Token'],ACCESS);
      reads++;const body=JSON.parse(settings.body);
      if(body.query===CATALOGUE_QUERY){assert.equal(reads,1);return catalogueResponse(staged);}
      assert.equal(body.query,CATALOGUE_COMPONENT_QUERY);assert.equal(reads,2);
      const nodes=staged.data.products.nodes.flatMap(p=>p.variants.nodes.map(v=>componentNode(p,v)));
      assert.deepEqual(body.variables.ids,nodes.map(v=>v.id));return catalogueResponse({data:{shop:staged.data.shop,nodes}});
    }});t.after(g.close);
    const r=await g.request(CATALOGUE_PATH,{method:'POST',cookie:f.cookie,headers:{'X-CSRF-Token':f.session.csrf},body:{requestId:env.RUNVARA_SHOPIFY_CATALOGUE_REQUEST_ID,expectedRevision:state._revision}});
    assert.equal(r.status,expired?409:200,JSON.stringify(r.payload));assert.equal(reads,expired?0:2);
    if(expired)assert.equal(r.payload.code,'SHOPIFY_CATALOGUE_TOKEN_RENEWAL_REQUIRED');else assert.equal(r.payload.run.status,'imported');
    assert.deepEqual(g.fake.states.get(ID).connections,state.connections);
  }
});
