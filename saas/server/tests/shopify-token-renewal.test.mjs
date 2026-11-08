import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {decryptCredentials} from '../lib/security.mjs';
import {createShopifyTokenPolicy} from '../lib/shopify-token-exchange.mjs';
import {expiredState,alterCredentials,renewalEnv,renewalFixture as fixture,tokenResponse,digest,secretPattern,ID,DOMAIN,SECRET,NEW,SCOPES} from './shopify-token-renewal-fixture.mjs';

test('renewal is explicit, default closed and cannot repurpose an initial permit',async t=>{
  const state=expiredState();assert.equal(createShopifyTokenPolicy({RUNVARA_SHOPIFY_TOKEN_OPERATION:'renew_expired/v1'}),null);
  const f=await fixture(t,{state,env:{RUNVARA_SHOPIFY_TOKEN_OPERATION:undefined,RUNVARA_SHOPIFY_TOKEN_PREVIOUS_REQUEST_ID:undefined}});
  assert.equal((await f.status()).payload.operation,'initial/v1');assert.equal((await f.submit()).payload.code,'SHOPIFY_TOKEN_CREDENTIAL_SHAPE_INVALID');assert.equal(f.requests.length,0);
  const g=await fixture(t,{env:{RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE:'disabled/v1'}}),n=g.calls.length;
  assert.equal((await g.submit()).status,503);assert.equal(g.calls.length,n);assert.equal(g.requests.length,0);
});
for(const [name,change] of [
  ['unknown operation',{RUNVARA_SHOPIFY_TOKEN_OPERATION:'renew'}],['missing previous',{RUNVARA_SHOPIFY_TOKEN_PREVIOUS_REQUEST_ID:undefined}],
  ['bad previous',{RUNVARA_SHOPIFY_TOKEN_PREVIOUS_REQUEST_ID:'x'}],['initial with previous',{RUNVARA_SHOPIFY_TOKEN_OPERATION:'initial/v1'}]
])test('invalid renewal policy: '+name,()=>{assert.throws(()=>createShopifyTokenPolicy(renewalEnv(expiredState(),change)),{code:'SHOPIFY_TOKEN_OPERATION_INVALID'});});
test('renewal request cannot be the previous request',()=>{const e=renewalEnv(expiredState());e.RUNVARA_SHOPIFY_TOKEN_REQUEST_ID=e.RUNVARA_SHOPIFY_TOKEN_PREVIOUS_REQUEST_ID;assert.throws(()=>createShopifyTokenPolicy(e));});

for(const legacy of [true,false])test('one renewal preserves previous receipt and all unrelated state, legacy='+legacy,async t=>{
  const f=await fixture(t,{state:expiredState({legacy})}),before=structuredClone(f.fake.states.get(ID));
  const d=(await f.request('/api/bootstrap',{cookie:f.cookie})).payload.shopifyTokenExchange;
  assert.equal(d.operation,'renew_expired/v1');assert.equal(d.previousRequestId,before.shopifyTokenExchanges[0].requestId);assert.equal(f.requests.length,0);
  const r=await f.submit();assert.equal(r.status,200,JSON.stringify(r.payload));assert.equal(r.payload.outcome,'stored');
  const saved=f.fake.states.get(ID),c=saved.connections[0],creds=decryptCredentials(c.encryptedCredentials,SECRET),receipt=saved.shopifyTokenExchanges.at(-1);
  assert.equal(creds.accessToken,NEW);assert.deepEqual(creds.scopes,SCOPES);assert.equal(creds.expiresAt-creds.issuedAt,86399000);
  assert.deepEqual(saved.shopifyTokenExchanges[0],before.shopifyTokenExchanges[0]);assert.equal(receipt.replacesRequestId,d.previousRequestId);
  assert.equal(receipt.storedCiphertextDigest,digest(c.encryptedCredentials));assert.equal(receipt.operation,'renew_expired/v1');
  for(const k of Object.keys(before).filter(k=>!['_revision','updatedAt','storageReady','workspace','integrationStatus','connections','audit','shopifyTokenExchanges'].includes(k)))assert.deepEqual(saved[k],before[k],k);
  assert.equal(saved.storageReady,true,'normal durable-store bookkeeping');
  assert.deepEqual({...saved.workspace,updatedAt:before.workspace.updatedAt},before.workspace);
  assert.ok(Date.parse(saved.workspace.updatedAt)>=Date.parse(before.workspace.updatedAt),'normal persistence timestamp advances');
  const {supabase,reporting,...otherStatus}=saved.integrationStatus;assert.deepEqual(otherStatus,before.integrationStatus);
  assert.deepEqual({...supabase,lastSyncAt:null},{status:'connected',detail:'Authoritative workspace state committed.',lastSyncAt:null,lastError:null});
  assert.ok(Number.isFinite(Date.parse(supabase.lastSyncAt)));assert.deepEqual(reporting,{status:'degraded',detail:'Reporting refresh pending; authoritative state is durable.'});
  assert.deepEqual(saved.audit.slice(2),before.audit);assert.equal(f.requests.length,1);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,2);
  assert.ok(f.calls.every(c=>['GET','PATCH'].includes(c.method)));assert.doesNotMatch(JSON.stringify([d,r.payload,saved.audit,f.logs]),secretPattern);
  assert.equal((await f.submit()).payload.outcome,'stored');assert.equal(f.requests.length,1);
  assert.equal(f.server.packsmart.scheduler.status.lastTickAt,null);assert.equal(f.server.packsmart.agentOps.status.lastTickAt,null);
});

for(const kind of ['usable','expiring','absent','null-expiry','bad-expiry','wrong-lifetime','future-issued','oauth','extra-field','missing-scope','extra-scope','duplicate-scope','wrong-prior','malformed-token'])test('non-eligible grant: '+kind,async t=>{
  const s=expiredState();alterCredentials(s,c=>{
    if(kind==='usable'||kind==='expiring'){c.expiresAt=Date.now()+(kind==='usable'?3600000:30000);c.issuedAt=c.expiresAt-86399000;}
    if(kind==='absent')delete c.accessToken;if(kind==='null-expiry')c.expiresAt=null;if(kind==='bad-expiry')c.expiresAt='bad';
    if(kind==='wrong-lifetime')c.expiresAt++;if(kind==='future-issued')c.issuedAt=Date.now()+10000;if(kind==='oauth')c.mode='oauth';
    if(kind==='extra-field')c.refreshToken='synthetic-unexpected';if(kind==='missing-scope')c.scopes=SCOPES.slice(1);
    if(kind==='extra-scope')c.scopes.push('write_products');if(kind==='duplicate-scope')c.scopes.push(SCOPES[0]);
    if(kind==='wrong-prior')c.tokenExchangeRequestId=randomUUID();if(kind==='malformed-token')c.accessToken='bad token';
  });
  const f=await fixture(t,{state:s}),before=structuredClone(f.fake.states.get(ID));const r=await f.submit();
  assert.equal(r.status,409);assert.equal(f.requests.length,0);assert.ok(f.calls.every(c=>c.method==='GET'));assert.deepEqual(f.fake.states.get(ID),before);
});
for(const kind of ['missing','status','expires','updated','stored-time','issued-window','permit-window','actor','session','app','installation','domain','connection','version','settings','approved-scope','returned-scope','ciphertext','latest','operation'])test('prior receipt mismatch: '+kind,async t=>{
  const s=expiredState({legacy:false}),r=s.shopifyTokenExchanges[0],previous=r.requestId;
  if(kind==='missing')s.shopifyTokenExchanges=[];if(kind==='status')r.status='reserved';if(kind==='expires')r.tokenExpiresAt--;
  if(kind==='updated')s.connections[0].updatedAt='2020-01-01T00:00:00.000Z';if(kind==='stored-time')r.storedAt='bad';
  if(kind==='issued-window')r.startedAt=r.storedAt;if(kind==='permit-window')r.expiresAt='2099-01-01T00:00:00.000Z';
  if(kind==='actor')r.actorId='';if(kind==='session')r.sessionVersion=0;if(kind==='app')r.binding.appId='gid://shopify/App/1';
  if(kind==='installation')r.binding.installationId='gid://shopify/AppInstallation/1';if(kind==='domain')r.binding.domain='other.myshopify.com';
  if(kind==='connection')r.binding.connectionId='other';if(kind==='version')r.binding.apiVersion='2026-10';if(kind==='settings')s.connectionSettings.shopify.extra=true;
  if(kind==='approved-scope')r.approvedScopes=[];if(kind==='returned-scope')r.returnedScopes=[];
  if(kind==='ciphertext')alterCredentials(s,c=>c.accessToken='synthetic-other-expired-token');
  if(kind==='latest')s.shopifyTokenExchanges.push({...structuredClone(r),requestId:randomUUID()});if(kind==='operation')r.operation='unknown';
  const f=await fixture(t,{state:s,env:{RUNVARA_SHOPIFY_TOKEN_PREVIOUS_REQUEST_ID:previous}}),before=structuredClone(f.fake.states.get(ID));
  assert.equal((await f.submit()).status,409);assert.equal(f.requests.length,0);assert.ok(f.calls.every(c=>c.method==='GET'));assert.deepEqual(f.fake.states.get(ID),before);
});

for(const kind of ['admin','tenant','revoked','expired-session','csrf','origin','stale-revision'])test('renewal admission rejects '+kind,async t=>{
  const f=await fixture(t),s=f.fake.states.get(ID);let extra={},body;
  if(kind==='admin')s.users[0].role='admin';if(kind==='tenant')s.workspace.id='beta';if(kind==='revoked')s.users[0].sessionVersion++;
  if(kind==='expired-session')extra.cookie='__Host-packsmart_session=expired';if(kind==='csrf')extra.headers={};if(kind==='origin')extra.headers={'X-CSRF-Token':f.session.csrf,Origin:'https://foreign.invalid'};
  if(kind==='stale-revision')body={requestId:f.env.RUNVARA_SHOPIFY_TOKEN_REQUEST_ID,expectedRevision:randomUUID()};
  assert.ok([401,403,409].includes((await f.submit(body,extra)).status));assert.equal(f.requests.length,0);assert.ok(f.calls.every(c=>c.method==='GET'));
});
for(const phase of ['before-issuer','after-issuer'])for(const kind of ['ciphertext','receipt','settings','revision','session'])test('drift '+phase+' '+kind+' prevents replacement',async t=>{
  let f,claimed=false,changed=false;
  const mutate=()=>{if(changed)return;changed=true;const s=f.fake.states.get(ID);if(kind==='ciphertext')alterCredentials(s,c=>c.accessToken='synthetic-newer-token-kept');
    if(kind==='receipt')s.shopifyTokenExchanges[0].storedAt='2020-01-01T00:00:00.000Z';if(kind==='settings')s.connectionSettings.shopify.extra=true;
    if(kind==='revision')s._revision=randomUUID();if(kind==='session')s.users[0].sessionVersion++;};
  f=await fixture(t,{intercept:async({options,proceed})=>{if(claimed&&phase==='before-issuer')mutate();const r=await proceed();if(options.method==='PATCH')claimed=true;return r;},providerFetch:()=>{if(phase==='after-issuer')mutate();return tokenResponse();}});
  assert.notEqual((await f.submit()).status,200);assert.equal(f.requests.length,phase==='before-issuer'?0:1);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);
  assert.equal(f.fake.states.get(ID).shopifyTokenExchanges.at(-1).status,'reserved');
});
for(const mode of ['timeout','401','malformed','scope','expiry','redirect'])test('issuer '+mode+' spends attempt and preserves expired grant',async t=>{
  const f=await fixture(t,{providerFetch:()=>{if(mode==='timeout')throw new Error(NEW);if(mode==='401')return Response.json({secret:NEW},{status:401});
    if(mode==='malformed')return new Response('not-json');if(mode==='scope')return tokenResponse({scope:'read_products'});if(mode==='expiry')return tokenResponse({expires_in:86400});
    const r=tokenResponse();Object.defineProperty(r,'redirected',{value:true});return r;}}),before=structuredClone(f.fake.states.get(ID).connections);
  assert.notEqual((await f.submit()).status,200);assert.equal((await f.submit()).payload.outcome,'reserved_reconcile_no_replay');
  assert.equal(f.requests.length,1);assert.deepEqual(f.fake.states.get(ID).connections,before);assert.doesNotMatch(JSON.stringify([(await f.status()).payload,f.logs]),secretPattern);
  const g=await fixture(t,{state:structuredClone(f.fake.states.get(ID))});assert.equal((await g.submit()).payload.code,'SHOPIFY_TOKEN_PRIOR_REQUEST_UNRESOLVED');assert.equal(g.requests.length,0);
});
test('concurrent renewal makes one issuer request',async t=>{const f=await fixture(t),r=await Promise.all([f.submit(),f.submit()]);assert.equal(r.filter(x=>x.status===200).length,1);assert.equal(f.requests.length,1);});
for(const write of [1,2])for(const persisted of [false,true])test(`unknown CAS ${write}, persisted=${persisted}, never repeats`,async t=>{
  let writes=0,unknown=false;
  const f=await fixture(t,{intercept:async({options,url,proceed})=>{
    if(unknown&&options.method!=='PATCH'&&url.searchParams.get('select')==='revision:state->>_revision')throw new Error('synthetic lost read');
    if(options.method==='PATCH'&&++writes===write){if(persisted)await proceed();unknown=true;throw new Error('synthetic lost ack');}return proceed();
  }}),before=structuredClone(f.fake.states.get(ID).connections);
  assert.equal((await f.submit()).status,503);await f.submit();assert.equal(writes,write);assert.equal(f.requests.length,write===1?0:1);
  if(write===1||!persisted)assert.deepEqual(f.fake.states.get(ID).connections,before);
  assert.equal((await f.status()).payload.canRun,false);assert.doesNotMatch(JSON.stringify(f.logs),secretPattern);
});
test('new receipt supports the next explicit renewal only after its own expiry',async t=>{
  const f=await fixture(t);assert.equal((await f.submit()).status,200);const s=structuredClone(f.fake.states.get(ID)),previous=s.shopifyTokenExchanges.at(-1).requestId;
  const g=await fixture(t,{state:s,env:{RUNVARA_SHOPIFY_TOKEN_PREVIOUS_REQUEST_ID:previous}});assert.equal((await g.submit()).payload.code,'SHOPIFY_TOKEN_EXPIRED_GRANT_REQUIRED');assert.equal(g.requests.length,0);
});

test('a known renewal receipt cannot fall back to legacy metadata when its output hash is missing',async t=>{
  const s=expiredState(),r=s.shopifyTokenExchanges[0];r.operation='renew_expired/v1';r.replacesRequestId=randomUUID();
  const f=await fixture(t,{state:s}),before=structuredClone(f.fake.states.get(ID));
  assert.equal((await f.submit()).payload.code,'SHOPIFY_TOKEN_PRIOR_RECEIPT_MISMATCH');assert.equal(f.requests.length,0);
  assert.ok(f.calls.every(c=>c.method==='GET'));assert.deepEqual(f.fake.states.get(ID),before);
});

for(const legacy of [true,false])for(const [name,value] of [
  ['uuid','00000000-0000-0000-0000-000000000001'],['null',null],['empty',''],['number',1],['object',{}]
])test(`initial receipt rejects renewal-only replacement link ${name}, legacy=${legacy}`,async t=>{
  const s=expiredState({legacy});s.shopifyTokenExchanges[0].replacesRequestId=value;
  const f=await fixture(t,{state:s}),before=structuredClone(f.fake.states.get(ID)),r=await f.submit();
  assert.equal(r.payload.code,'SHOPIFY_TOKEN_PRIOR_RECEIPT_MISMATCH');assert.equal(r.status,409);assert.equal(f.requests.length,0);
  assert.ok(f.calls.every(c=>c.method==='GET'));assert.deepEqual(f.fake.states.get(ID),before);assert.doesNotMatch(JSON.stringify([r.payload,f.logs]),secretPattern);
});

for(const legacy of [true,false])for(const [name,value] of [
  ['digest','a'.repeat(64)],['null',null],['empty',''],['number',1],['array',[]]
])test(`initial receipt rejects renewal-only prior digest ${name}, legacy=${legacy}`,async t=>{
  const s=expiredState({legacy});s.shopifyTokenExchanges[0].binding.previousReceiptDigest=value;
  const f=await fixture(t,{state:s}),before=structuredClone(f.fake.states.get(ID)),r=await f.submit();
  assert.equal(r.payload.code,'SHOPIFY_TOKEN_PRIOR_RECEIPT_MISMATCH');assert.equal(r.status,409);assert.equal(f.requests.length,0);
  assert.ok(f.calls.every(c=>c.method==='GET'));assert.deepEqual(f.fake.states.get(ID),before);assert.doesNotMatch(JSON.stringify([r.payload,f.logs]),secretPattern);
});

for(const operation of [null,'','initial/v1','renew',false,{},[]])test('receipt rejects ambiguous operation marker '+JSON.stringify(operation),async t=>{
  const s=expiredState();s.shopifyTokenExchanges[0].operation=operation;
  const f=await fixture(t,{state:s}),before=structuredClone(f.fake.states.get(ID));
  assert.equal((await f.submit()).payload.code,'SHOPIFY_TOKEN_PRIOR_RECEIPT_MISMATCH');assert.equal(f.requests.length,0);
  assert.ok(f.calls.every(c=>c.method==='GET'));assert.deepEqual(f.fake.states.get(ID),before);
});

test('removing operation and output hash from a renewal leaves links that cannot become initial evidence',async t=>{
  const s=expiredState({legacy:false}),r=s.shopifyTokenExchanges[0];r.operation='renew_expired/v1';r.replacesRequestId=randomUUID();r.binding.previousReceiptDigest='b'.repeat(64);
  delete r.operation;delete r.storedCiphertextDigest;
  const f=await fixture(t,{state:s}),before=structuredClone(f.fake.states.get(ID));
  assert.equal((await f.submit()).payload.code,'SHOPIFY_TOKEN_PRIOR_RECEIPT_MISMATCH');assert.equal(f.requests.length,0);
  assert.ok(f.calls.every(c=>c.method==='GET'));assert.deepEqual(f.fake.states.get(ID),before);
});

test('legacy initial evidence still cannot prove historical token bytes after all distinguishing links are removed',async t=>{
  const s=expiredState();alterCredentials(s,c=>c.accessToken='synthetic-altered-expired-token');
  const f=await fixture(t,{state:s});assert.equal((await f.submit()).payload.outcome,'stored');assert.equal(f.requests.length,1);
});

test('an expired previously renewed grant requires and accepts its matching output hash',async t=>{
  const s=expiredState({legacy:false}),r=s.shopifyTokenExchanges[0];r.operation='renew_expired/v1';r.replacesRequestId=randomUUID();
  const f=await fixture(t,{state:s});assert.equal((await f.submit()).payload.outcome,'stored');assert.equal(f.requests.length,1);
  assert.deepEqual(f.fake.states.get(ID).shopifyTokenExchanges[0],r);
});
test('expiry must be positively past, not the exact boundary',async t=>{
  const now=Date.now();t.mock.method(Date,'now',()=>now);const s=expiredState({now:now+1000}),f=await fixture(t,{state:s});
  assert.equal((await f.submit()).payload.code,'SHOPIFY_TOKEN_EXPIRED_GRANT_REQUIRED');assert.equal(f.requests.length,0);assert.ok(f.calls.every(c=>c.method==='GET'));
});
test('renewal retention failure preserves history and credentials before issuer access',async t=>{
  const s=expiredState();s.audit=Array.from({length:305},(_,i)=>({id:'renew-audit-'+i,type:'synthetic',actor:'test',detail:{},createdAt:new Date().toISOString()}));
  const f=await fixture(t,{state:s,intercept:({url,proceed})=>url.pathname.endsWith('/audit_events')?Response.json({code:'synthetic_unavailable'},{status:503}):proceed()}),before=structuredClone(f.fake.states.get(ID));
  assert.equal((await f.submit()).status,503);assert.equal(f.requests.length,0);assert.deepEqual(f.fake.states.get(ID),before);
});
