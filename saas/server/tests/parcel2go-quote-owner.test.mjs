import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {fixture,savedState,quoteEnv,ID,CLIENT,SECRET_VALUE,TOKEN} from './parcel2go-quote-owner-fixture.mjs';
import {SECRET} from './maintenance-login-fixture.mjs';import {createSessionToken} from '../lib/security.mjs';
import {PARCEL2GO_QUOTE_PATH as ROUTE,createParcel2GoQuoteWindow,parseParcel2GoQuoteSubmission} from '../lib/parcel2go-quote-owner.mjs';
import {createStartupPolicy} from '../lib/startup-mode.mjs';
const writes=f=>f.calls.filter(x=>x.method!=='GET'),patches=f=>f.calls.filter(x=>x.method==='PATCH');
test('owner bootstrap/status never contact provider; confirmed one-shot uses fixed synthetic input and durable receipts',async t=>{
 const f=await fixture(t),before=structuredClone(f.state);const status=await f.status(),bootstrap=await f.request('/api/bootstrap',{cookie:f.cookie});assert.equal(status.status,200);assert.equal(status.payload.canSubmit,true);assert.equal(bootstrap.payload.parcel2goSandboxQuote.canSubmit,true);assert.equal(f.wire.calls.length,0);assert.equal(writes(f).length,0);
 const r=await f.submit();assert.equal(r.status,200,JSON.stringify(r.payload));assert.equal(r.payload.outcome,'completed');assert.equal(r.payload.quote.quotes[0].totalDecimal,'12.66');assert.equal(r.payload.quoteCount,1);assert.equal(patches(f).length,2);assert.equal(f.wire.calls.length,2);
 const body=JSON.parse(f.wire.calls[1].body);assert.deepEqual(body,{CollectionAddress:{Country:'GBR',VatStatus:'NotRegistered'},DeliveryAddress:{Country:'GBR',VatStatus:'NotRegistered'},Parcels:[{Weight:0.25,Length:20,Width:10,Height:5,Value:12.3}]});assert.equal(new URLSearchParams(f.wire.calls[0].body).get('scope'),'public-api');
 const saved=f.fake.states.get(ID);for(const k of ['connections','products','orders','economics','users','autopilot'])assert.deepEqual(saved[k],before[k]);
 const later=await f.status();assert.equal(later.payload.quote,null);assert.equal(later.payload.outcome,'completed');assert.equal((await f.submit()).status,409);assert.equal(f.wire.calls.length,2);
 for(const output of [status.payload,bootstrap.payload,r.payload,later.payload,saved.audit,saved.parcel2goSandboxRuns,f.logs])for(const v of [CLIENT,SECRET_VALUE,TOKEN,SECRET,before.connections[0].encryptedCredentials])assert.ok(!JSON.stringify(output).includes(v));
 assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('referrer-policy'),'no-referrer');assert.equal(f.server.packsmart.scheduler.status.running,false);
});
test('default disabled route denies before body/authentication/store',async t=>{const f=await fixture(t,{env:{RUNVARA_QUIET_PARCEL2GO_SANDBOX_QUOTE:'disabled/v1'}}),n=f.calls.length;for(const method of ['GET','POST','PUT','DELETE'])assert.equal((await f.request(ROUTE,{method,body:method==='GET'?undefined:SECRET_VALUE})).status,503);assert.equal(f.calls.length,n);assert.equal(f.wire.calls.length,0);});
test('normal startup cannot bypass disabled quote route',()=>{const p=createStartupPolicy({RUNVARA_STARTUP_MODE:'normal'},[]);for(const method of ['GET','POST','PUT','DELETE'])assert.equal(p.allowsRequest(method,ROUTE),false);});
for(const kind of ['admin','viewer','inactive','password','expired','revoked','tenant','cookie','csrf','origin missing','origin wrong','type','query','method'])test('reject '+kind+' before source effects',async t=>{
 const f=await fixture(t);let extra={};const s=f.fake.states.get(ID);
 if(['admin','viewer'].includes(kind))s.users[0].role=kind;if(kind==='inactive')s.users[0].active=false;if(kind==='password')s.users[0].passwordChangeRequired=true;if(kind==='revoked')s.users[0].sessionVersion++;
 if(kind==='cookie')extra.cookie='';if(kind==='expired')extra.cookie='__Host-packsmart_session='+createSessionToken({userId:s.users[0].id,workspaceId:ID,email:'synthetic@example.test',role:'owner',sessionVersion:1},SECRET,-1);
 if(kind==='tenant')extra.cookie='__Host-packsmart_session='+createSessionToken({userId:'beta-owner',workspaceId:'beta',email:'beta@example.test',role:'owner',sessionVersion:1},SECRET);
 if(kind==='csrf')extra.headers={Origin:new URL(f.config.APP_PUBLIC_URL).origin};if(kind==='origin missing')extra.headers={'X-CSRF-Token':f.session.csrf};if(kind==='origin wrong')extra.headers={'X-CSRF-Token':f.session.csrf,Origin:'https://wrong.example'};if(kind==='type')extra.headers={'X-CSRF-Token':f.session.csrf,Origin:new URL(f.config.APP_PUBLIC_URL).origin,'Content-Type':'text/plain'};
 const r=kind==='query'?await f.request(ROUTE+'?scope=payment',{cookie:f.cookie}):kind==='method'?await f.request(ROUTE,{method:'PUT',cookie:f.cookie,body:f.body}):await f.submit(f.body,extra);
 assert.notEqual(r.status,200);assert.equal(writes(f).length,0);assert.equal(f.wire.calls.length,0);
});
for(const kind of ['confirmed','revision','id','scope','url','parcel','credential','duplicate','malformed','oversized'])test('reject body override '+kind,async t=>{
 const f=await fixture(t);let b={...f.body};if(kind==='confirmed')b.confirmed=false;if(kind==='revision')b.expectedRevision=randomUUID();if(kind==='id')b.requestId=randomUUID();if(kind==='scope')b.scope='openid';if(kind==='url')b.url='https://www.parcel2go.com/api/orders';if(kind==='parcel')b.parcel={};if(kind==='credential')b.clientSecret=SECRET_VALUE;if(kind==='duplicate')b=JSON.stringify(b).replace('"confirmed":true','"confirmed":true,"confirmed":true');if(kind==='malformed')b='{';if(kind==='oversized')b='x'.repeat(2049);
 const r=await f.submit(b);assert.notEqual(r.status,200);assert.equal(writes(f).length,0);assert.equal(f.wire.calls.length,0);assert.ok(!JSON.stringify(r.payload).includes(SECRET_VALUE));
});
for(const drift of ['admission','account','connection','ciphertext','duplicate','revision','reserved'])test('saved '+drift+' mismatch is not admitted',async t=>{
 const f=await fixture(t),s=f.fake.states.get(ID);if(drift==='admission')s.connections[0].metadata.admissionRequestId=randomUUID();if(drift==='account')s.connections[0].metadata.account='other';if(drift==='connection')s.connections[0].id='other';if(drift==='ciphertext')s.connections[0].encryptedCredentials='invalid';if(drift==='duplicate')s.connections.push({...s.connections[0]});if(drift==='revision')s._revision=randomUUID();if(drift==='reserved')s.parcel2goSandboxRuns.push({requestId:randomUUID(),status:'reserved'});
 assert.equal((await f.submit()).status,409);assert.equal(writes(f).length,0);assert.equal(f.wire.calls.length,0);
});
test('concurrent requests are one attempt despite workspace-lock serialization',async t=>{const f=await fixture(t);const r=await Promise.all([f.submit(),f.submit()]);assert.equal(r.filter(x=>x.status===200).length,1);assert.equal(f.wire.calls.length,2);assert.equal(patches(f).length,2);});
test('expired descriptor boots closed but permits receipt-only status',async t=>{const f=await fixture(t,{env:{RUNVARA_PARCEL2GO_QUOTE_OPENED_AT:'2026-01-01T00:00:00.000Z',RUNVARA_PARCEL2GO_QUOTE_EXPIRES_AT:'2026-01-01T00:05:00.000Z'}});assert.equal((await f.status()).payload.canSubmit,false);assert.equal((await f.submit()).status,503);assert.equal(f.wire.calls.length,0);assert.equal(writes(f).length,0);});
for(const key of ['RUNVARA_QUIET_PARCEL2GO_CREDENTIAL_ENTRY','RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE','RUNVARA_QUIET_SHOPIFY_CATALOGUE'])test('mutually exclusive '+key,()=>{assert.throws(()=>createParcel2GoQuoteWindow({RUNVARA_STARTUP_MODE:'quiet',...quoteEnv(savedState()),[key]:'enabled/v1'}));});
for(const [key,value] of [['DATA_CONTRACT','real'],['SCOPE_POLICY','openid'],['ADMISSION_REQUEST_ID',''],['EXPECTED_CLIENT_ID',''],['EXPIRES_AT','2099-01-01T00:00:00.000Z']])test('bad descriptor '+key,()=>assert.throws(()=>createParcel2GoQuoteWindow({RUNVARA_STARTUP_MODE:'quiet',...quoteEnv(savedState()),['RUNVARA_PARCEL2GO_QUOTE_'+key]:value})));
for(const stage of ['token refusal','quote refusal','owner revoked','configuration revoked','lost save'])test(stage+' leaves spent state with no replay',async t=>{
 let f,patchCount=0,lost=false;f=await fixture(t,{intercept:async({options,proceed})=>{if(lost)throw Error(SECRET_VALUE);const r=await proceed();if(options.method==='PATCH'&&++patchCount===2&&stage==='lost save'){lost=true;throw Error(SECRET_VALUE);}return r;},provider:(call,reply)=>{
 if(stage==='token refusal'&&call.url.endsWith('/token')||stage==='quote refusal'&&call.url.endsWith('/quotes'))return reply({}, {status:403});
 if(stage==='owner revoked')f.fake.states.get(ID).users[0].sessionVersion++;
 if(stage==='configuration revoked')f.server.packsmart.env.RUNVARA_QUIET_PARCEL2GO_SANDBOX_QUOTE='disabled/v1';reply();
 }});assert.notEqual((await f.submit()).status,200);const count=f.wire.calls.length;assert.equal(count,['quote refusal','lost save'].includes(stage)?2:1);lost=false;
 assert.notEqual((await f.submit()).status,200);assert.equal(f.wire.calls.length,count);if(stage==='lost save')assert.equal((await f.status()).payload.outcome,'completed');
});
for(const kind of ['drain','disconnect'])test(kind+' aborts pending issuer and preserves spent claim',async t=>{
 let entered;const ready=new Promise(r=>entered=r);const f=await fixture(t,{provider:()=>entered()});const controller=new AbortController(),pending=f.submit(f.body,{signal:controller.signal}).catch(()=>null);await ready;
 if(kind==='disconnect')controller.abort();else await f.server.packsmart.drain();await pending;
 await new Promise(r=>setTimeout(r,30));assert.equal(f.wire.calls.length,1);assert.equal(f.wire.calls[0].destroyed,true);assert.equal(patches(f).length,1);assert.equal(f.fake.states.get(ID).parcel2goSandboxRuns.at(-1).status,'reserved');
});
test('receipt spoof with missing projection hash cannot become completed',async t=>{const f=await fixture(t);await f.submit();delete f.fake.states.get(ID).parcel2goSandboxRuns.at(-1).projectionHash;const r=await f.status();assert.equal(r.payload.outcome,'reconcile_no_replay');assert.equal(r.payload.quoteCount,null);assert.equal(f.wire.calls.length,2);});
test('strict parser fixed error omits injected secret',()=>assert.throws(()=>parseParcel2GoQuoteSubmission(Buffer.from('{"secret":"'+SECRET_VALUE+'"}')),e=>!e.message.includes(SECRET_VALUE)));
