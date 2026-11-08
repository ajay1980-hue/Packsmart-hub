import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {fixture,ID,CLIENT,VALUE,entryEnv} from './parcel2go-entry-fixture.mjs';
import {ownerState,SECRET} from './maintenance-login-fixture.mjs';
import {decryptCredentials,createSessionToken} from '../lib/security.mjs';
import {PARCEL2GO_ENTRY_PATH,createParcel2GoCredentialWindow,parseParcel2GoEntry} from '../lib/parcel2go-credential-entry.mjs';
import {createStartupPolicy} from '../lib/startup-mode.mjs';
const writes=f=>f.calls.filter(c=>c.method!=='GET');
test('synthetic admission fixture uses one captured timestamp for its exact finite interval',t=>{
  const state=ownerState(ID),start=Date.parse('2026-11-08T18:00:00.000Z');let calls=0;t.mock.method(Date,'now',()=>start+calls++);
  const env=entryEnv(state);assert.equal(calls,1);assert.equal(Date.parse(env.RUNVARA_PARCEL2GO_ENTRY_OPENED_AT),start);assert.equal(Date.parse(env.RUNVARA_PARCEL2GO_ENTRY_EXPIRES_AT)-Date.parse(env.RUNVARA_PARCEL2GO_ENTRY_OPENED_AT),300000);
});
test('private owner admission stores encrypted once; status/bootstrap redact; no provider work',async t=>{
  const f=await fixture(t),before=structuredClone(f.state);const pre=await f.status();assert.equal(pre.status,200);assert.equal(pre.payload.canSubmit,true);assert.equal(pre.headers.get('cache-control'),'no-store');
  assert.equal(pre.headers.get('referrer-policy'),'no-referrer');
  const result=await f.submit();assert.equal(result.status,200,JSON.stringify(result.payload));assert.equal(result.payload.outcome,'stored');assert.equal(result.headers.get('referrer-policy'),'no-referrer');
  const saved=f.fake.states.get(ID),c=saved.connections.at(-1);assert.equal(decryptCredentials(c.encryptedCredentials,SECRET).credentials.clientSecret,VALUE);
  assert.equal(f.calls.filter(c=>c.method==='PATCH').length,2);for(const k of ['orders','products','economics','users','autopilot'])assert.deepEqual(saved[k],before[k]);
  const bootstrap=await f.request('/api/bootstrap',{cookie:f.cookie});assert.equal(bootstrap.status,200,JSON.stringify({payload:bootstrap.payload,logs:f.logs}));
  for(const output of [pre.payload,result.payload,bootstrap.payload,f.logs,saved.audit,saved.parcel2goSandboxRuns])for(const secret of [CLIENT,VALUE,SECRET,c.encryptedCredentials])assert.ok(!JSON.stringify(output).includes(secret));
  assert.equal((await f.submit()).status,409);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,2);assert.equal((await f.status()).payload.canSubmit,false);
});
for(const mode of ['quiet'])test('default disabled before authentication/body in '+mode,async t=>{
  const f=await fixture(t,{env:{RUNVARA_STARTUP_MODE:mode,RUNVARA_QUIET_OWNER_WORKSPACE:mode==='quiet'?'enabled/v1':'disabled/v1',RUNVARA_QUIET_OWNER_LOGIN:mode==='quiet'?'enabled/v1':'disabled/v1',RUNVARA_QUIET_PARCEL2GO_CREDENTIAL_ENTRY:'disabled/v1'}});
  const n=f.calls.length;for(const method of ['GET','POST','PUT','DELETE'])assert.equal((await f.request(PARCEL2GO_ENTRY_PATH,{method,body:method==='GET'?undefined:VALUE})).status,503);assert.equal(f.calls.length,n);
});
test('normal-mode startup policy also denies the disabled private route',()=>{
  const policy=createStartupPolicy({RUNVARA_STARTUP_MODE:'normal'},[]);
  for(const method of ['GET','POST','PUT','DELETE'])assert.equal(policy.allowsRequest(method,PARCEL2GO_ENTRY_PATH),false);
});
for(const role of ['admin','viewer'])test('reject nonowner '+role,async t=>{
  const state=ownerState(ID);state.users[0].role=role;const f=await fixture(t,{state});assert.notEqual((await f.status()).status,200);assert.notEqual((await f.submit()).status,200);assert.equal(writes(f).length,0);
});
test('foreign tenant cannot enter or view the Packsmart permit',async t=>{
  const f=await fixture(t),token=createSessionToken({userId:'beta-owner',workspaceId:'beta',email:'beta@example.test',role:'owner',sessionVersion:1},SECRET);
  const r=await f.request(PARCEL2GO_ENTRY_PATH,{cookie:'__Host-packsmart_session='+token});assert.notEqual(r.status,200);assert.equal(writes(f).length,0);
});
for(const kind of ['no cookie','csrf','origin absent','origin wrong','form type','query','revoked','expired','password'])test('transport/session '+kind+' refuses without writes',async t=>{
  const f=await fixture(t);let extra={};
  if(kind==='no cookie')extra.cookie='';if(kind==='csrf')extra.headers={Origin:new URL(f.config.APP_PUBLIC_URL).origin};
  if(kind==='origin absent')extra.headers={'X-CSRF-Token':f.session.csrf};if(kind==='origin wrong')extra.headers={'X-CSRF-Token':f.session.csrf,Origin:'https://wrong.example'};
  if(kind==='form type')extra.headers={'X-CSRF-Token':f.session.csrf,Origin:new URL(f.config.APP_PUBLIC_URL).origin,'Content-Type':'text/plain'};
  if(kind==='revoked')f.fake.states.get(ID).users[0].sessionVersion++;if(kind==='password')f.fake.states.get(ID).users[0].passwordChangeRequired=true;
  if(kind==='expired')extra.cookie='__Host-packsmart_session='+createSessionToken({userId:f.state.users[0].id,workspaceId:ID,email:'synthetic@example.test',role:'owner',sessionVersion:1},SECRET,-1);
  const r=kind==='query'?await f.request(PARCEL2GO_ENTRY_PATH+'?override=yes',{cookie:f.cookie}):await f.submit(f.body,extra);
  assert.notEqual(r.status,200,kind);assert.equal(writes(f).length,0);assert.ok(!JSON.stringify([r.payload,f.logs]).includes(VALUE));
});
for(const kind of ['false consent','client mismatch','revision','request id','extra field','duplicate','malformed','oversize','token'])test('body '+kind+' refuses without secret echo',async t=>{
  const f=await fixture(t);let b={...f.body};if(kind==='false consent')b.confirmed=false;if(kind==='client mismatch')b.clientId='different-client';if(kind==='revision')b.expectedRevision=randomUUID();if(kind==='request id')b.requestId=randomUUID();
  if(kind==='extra field')b.account='other';if(kind==='token')b.accessToken=VALUE;if(kind==='oversize')b.clientSecret='x'.repeat(14000);if(kind==='malformed')b='{"secret":"'+VALUE+'",';if(kind==='duplicate')b=JSON.stringify(b).replace('"confirmed":true','"confirmed":false,"confirmed":true');
  const r=await f.submit(b);assert.notEqual(r.status,200);assert.equal(writes(f).length,0);assert.ok(!JSON.stringify([r.payload,f.logs]).includes(VALUE));
});
test('concurrent submissions only admit one durable operation',async t=>{
  const f=await fixture(t),r=await Promise.all([f.submit(),f.submit()]);assert.equal(r.filter(x=>x.status===200).length,1);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,2);
});
test('unknown final acknowledgement can only reconcile with GET and never replays POST',async t=>{
  let patches=0,lost=false;const f=await fixture(t,{intercept:async({options,proceed})=>{if(lost&&(!options.method||options.method==='GET'))throw Error(VALUE);const r=await proceed();if(options.method==='PATCH'&&++patches===2){lost=true;throw Error(VALUE);}return r;}});
  const r=await f.submit();assert.equal(r.status,409);assert.equal(r.headers.get('referrer-policy'),'no-referrer');lost=false;assert.equal((await f.status()).payload.outcome,'stored');assert.equal((await f.submit()).status,409);assert.equal(patches,2);assert.ok(!JSON.stringify(f.logs).includes(VALUE));
});
test('expired permit boots closed, status can reconcile, POST never writes',async t=>{
  const f=await fixture(t,{env:{RUNVARA_PARCEL2GO_ENTRY_OPENED_AT:'2026-01-01T00:00:00.000Z',RUNVARA_PARCEL2GO_ENTRY_EXPIRES_AT:'2026-01-01T00:05:00.000Z'}});
  assert.equal((await f.status()).payload.canSubmit,false);assert.equal((await f.submit()).status,503);assert.equal(writes(f).length,0);
});
for(const change of [e=>e.RUNVARA_STARTUP_MODE='normal',e=>e.RUNVARA_QUIET_OWNER_WORKSPACE='disabled/v1',e=>e.RUNVARA_QUIET_SHOPIFY_CATALOGUE='enabled/v1',e=>e.RUNVARA_PARCEL2GO_ENTRY_ACCOUNT_ID='',e=>e.RUNVARA_PARCEL2GO_ENTRY_EXPIRES_AT=new Date(Date.now()+600000).toISOString()])test('invalid deployment descriptor fails closed',()=>{
  const e={RUNVARA_STARTUP_MODE:'quiet',...entryEnv(ownerState(ID))};change(e);assert.throws(()=>createParcel2GoCredentialWindow(e));
});
test('parser never includes rejected private fields in error',()=>assert.throws(()=>parseParcel2GoEntry(Buffer.from('{"clientSecret":"'+VALUE+'",')),e=>!e.message.includes(VALUE)));
