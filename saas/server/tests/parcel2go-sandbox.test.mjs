import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,ID,KEY,CLIENT,SECRET_VALUE,TOKEN,binding,quoteBody,digest} from './parcel2go-sandbox-fixture.mjs';
import {publicConnection,decryptCredentials} from '../lib/security.mjs';
import {createParcel2GoSandboxCandidate,createParcel2GoSandboxPolicy,assertParcel2GoPersistencePermit} from '../lib/parcel2go-sandbox.mjs';
import {parcel2GoQuoteRequest,parcel2GoQuoteResponse} from '../lib/parcel2go-quote-schema.mjs';
const writes=f=>f.calls.filter(c=>c.settings.method==='PATCH');
const reject=async(p,code)=>assert.rejects(p,e=>{assert.doesNotMatch(e.message+' '+e.stack,new RegExp([SECRET_VALUE,TOKEN,KEY].join('|')));return !code||e.code===code;});

test('default disabled does not inspect argument getters, store or transport',async()=>{
  const c=createParcel2GoSandboxCandidate();await reject(c.run({get session(){assert.fail();}}),'PARCEL2GO_DISABLED');assert.equal(c.status().enabled,false);
});
for(const mode of ['enabled/v1','live','sandbox',true])test('no production activation mode '+mode,()=>assert.throws(()=>createParcel2GoSandboxPolicy({mode})));
test('admission encrypts exact scoped credentials in existing store with two CAS writes; no provider call or mirror',async()=>{
  const f=fixture({operation:'admit_credentials'}),before=structuredClone(f.state),r=await f.run(),saved=f.fake.states.get(ID);
  assert.equal(r.status,'completed');assert.equal(writes(f).length,2);assert.equal(f.providerCalls.length,0);
  for(const k of ['products','orders','economics','users','autopilot'])assert.deepEqual(saved[k],before[k]);
  assert.equal(saved.connections.length,before.connections.length+1);const c=saved.connections.at(-1);
  assert.equal(decryptCredentials(c.encryptedCredentials,KEY).credentials.clientSecret,SECRET_VALUE);
  for(const output of [r,publicConnection(c),saved.audit,saved.parcel2goSandboxRuns,f.candidate.status()])
    for(const secret of [CLIENT,SECRET_VALUE,TOKEN,KEY,c.encryptedCredentials])assert.ok(!JSON.stringify(output).includes(secret));
  assert.ok(f.calls.filter(c=>c.settings.method!=='GET').every(c=>new URL(c.url).pathname.endsWith('/saas_workspace_state')));
});
test('sandbox quote uses only fixed issuer and quotes, one each, with public-api only and no persisted token',async()=>{
  const f=fixture(),before=structuredClone(f.state),r=await f.run(),saved=f.fake.states.get(ID);
  assert.equal(writes(f).length,2);assert.equal(f.providerCalls.length,2);assert.deepEqual(saved.connections,before.connections);
  assert.equal(r.quote.quotes[0].totalDecimal,'12.66');assert.equal(r.quote.quotes[0].netDecimal,'10.55');assert.equal(r.quote.quotes[0].vatDecimal,'2.11');
  assert.equal(r.quote.quotes[0].quoteExpiresAt,null);assert.equal(r.quote.purchaseAllowed,false);assert.equal(r.quote.liveReady,false);
  assert.deepEqual(f.providerCalls.map(c=>c.url),['https://sandbox.parcel2go.com/auth/connect/token','https://sandbox.parcel2go.com/api/quotes']);
  assert.equal(new URLSearchParams(f.providerCalls[0].settings.body).get('scope'),'public-api');assert.ok(f.providerCalls.every(c=>c.settings.redirect==='error'&&c.settings.method==='POST'));
  const wire=JSON.parse(f.providerCalls[1].settings.body);assert.deepEqual(wire.Parcels,[{Weight:0.25,Length:20,Width:10,Height:5,Value:12.3}]);
  assert.deepEqual(wire.CollectionAddress,{Country:'GBR',VatStatus:'NotRegistered'});
  assert.doesNotMatch(JSON.stringify([saved,r]),new RegExp([SECRET_VALUE,TOKEN,KEY,'<script>','CutOff'].join('|')));
});
for(const operation of ['order','payment','my-profile','label','webhook'])test('unsupported operation '+operation,()=>assert.throws(()=>fixture({config:{operation}})));
for(const mutation of ['sub absent','sub blank','version absent','version string','owner admin','owner inactive','password change','expired','tenant','csrf'])test('reject actor '+mutation+' before durable/provider effects',async()=>{
  const f=fixture();if(mutation==='sub absent')delete f.args.session.sub;
  if(mutation==='sub blank')f.args.session.sub='';if(mutation==='version absent')delete f.args.session.sessionVersion;
  if(mutation==='version string')f.args.session.sessionVersion='1';if(mutation==='expired')f.args.session.exp=1;
  if(mutation==='tenant')f.args.session.workspaceId='beta';if(mutation==='csrf')f.args.csrf='wrong';
  const u=f.fake.states.get(ID).users[0];if(mutation==='owner admin')u.role='admin';if(mutation==='owner inactive')u.active=false;if(mutation==='password change')u.passwordChangeRequired=true;
  await reject(f.run());assert.equal(writes(f).length,0);assert.equal(f.providerCalls.length,0);
});
for(const field of ['workspaceId','connectionId','accountId','environment'])test('binding mismatch '+field+' fails closed',async()=>{
  const f=fixture();f.config.binding={...binding,[field]:'wrong'};
  await reject(Promise.resolve().then(()=>f.make().run(f.args)));assert.equal(writes(f).length,0);assert.equal(f.providerCalls.length,0);
});
test('replay, concurrent click and recreated candidate cannot reuse completed admission',async()=>{
  const f=fixture();const [a,b]=await Promise.allSettled([f.run(),f.run()]);assert.equal(a.status,'fulfilled');assert.equal(b.status,'rejected');
  await reject(f.make().run(f.args),'PARCEL2GO_ATTEMPT_SPENT');assert.equal(f.providerCalls.length,2);assert.equal(writes(f).length,2);
});
test('two independent candidate instances still perform at most one issuer after durable CAS',async()=>{
  const f=fixture();const r=await Promise.allSettled([f.run(),f.make().run(f.args)]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.providerCalls.length,2);
});
for(const stage of ['claim','final'])test('unknown '+stage+' acknowledgement is not replayed and retains receipt',async()=>{
  let patches=0,lost=false;const f=fixture({intercept:async(url,s,proceed)=>{if(lost)throw Error('synthetic readback unavailable');const r=await proceed();if(s.method==='PATCH'&&++patches===(stage==='claim'?1:2)){lost=true;throw Error(SECRET_VALUE);}return r;}});
  await reject(f.run(),'PARCEL2GO_SAVE_OUTCOME_UNKNOWN');assert.equal(f.providerCalls.length,stage==='claim'?0:2);
  assert.equal(f.fake.states.get(ID).parcel2goSandboxRuns.at(-1).status,stage==='claim'?'reserved':'completed');
  await reject(f.make().run(f.args));assert.equal(f.providerCalls.length,stage==='claim'?0:2);
});
for(const value of [undefined,''])test('R1 missing/blank matched owner identity is rejected in admission',async()=>{
  const f=fixture({operation:'admit_credentials'});f.args.session.sub=value;f.fake.states.get(ID).users[0].id=value;
  await reject(f.run(),'PARCEL2GO_OWNER_REQUIRED');assert.equal(writes(f).length,0);
});
for(const field of ['client','ciphertext','receipt missing','receipt wrong account','receipt duplicated'])test('stored credential '+field+' fails before reservation',async()=>{
  const f=fixture(),s=f.fake.states.get(ID);
  if(field==='client')f.config.expectedClientId='different-client';if(field==='ciphertext')s.connections[0].encryptedCredentials='bad';
  if(field==='receipt missing')s.parcel2goSandboxRuns=[];if(field==='receipt wrong account')s.parcel2goSandboxRuns[0].accountId='wrong';
  if(field==='receipt duplicated')s.parcel2goSandboxRuns.push({...s.parcel2goSandboxRuns[0]});
  await reject(f.make().run(f.args));assert.equal(writes(f).length,0);assert.equal(f.providerCalls.length,0);
});
test('over-cap primary state refuses before archive/provider writes',async()=>{
  const f=fixture();f.fake.states.get(ID).syntheticPadding='x'.repeat(2*1024*1024);
  await reject(f.run());assert.equal(writes(f).length,0);assert.equal(f.providerCalls.length,0);
});
test('claim CAS conflict cannot send to issuer or replace business state',async()=>{
  const f=fixture({intercept:async(_u,s,proceed,fake)=>{if(s.method==='PATCH')fake.states.get(ID)._revision=randomUUID();return proceed();}});
  await reject(f.run(),'PARCEL2GO_SAVE_OUTCOME_UNKNOWN');assert.equal(writes(f).length,1);assert.equal(f.providerCalls.length,0);
});
test('read-only status and ordinary public connection remove every credential field',async()=>{
  const f=fixture();const dto=publicConnection(f.state.connections[0]);assert.ok(!('encryptedCredentials' in dto));
  assert.doesNotMatch(JSON.stringify(dto),new RegExp([CLIENT,SECRET_VALUE,TOKEN,KEY].join('|')));
});
for(const stage of ['claim','final'])test('R2 session expiry during '+stage+' audit archive prevents primary commit',async()=>{
  let f,archives=0;f=fixture({operation:'admit_credentials',intercept:async(url,s,proceed)=>{
    const result=await proceed();if(s.method==='POST'&&new URL(url).pathname.endsWith('/audit_events')&&++archives===(stage==='claim'?1:2))f.advance(3000);return result;
  }});
  f.args.session.exp=Math.floor(f.getTime()/1000)+2;
  f.fake.states.get(ID).audit=Array.from({length:300},()=>({id:randomUUID(),at:new Date(f.getTime()-1000).toISOString(),actor:'synthetic',action:'synthetic',detail:'synthetic audit'}));
  await reject(f.run(),'PARCEL2GO_SAVE_OUTCOME_UNKNOWN');const saved=f.fake.states.get(ID);
  assert.equal(archives,stage==='claim'?1:2);assert.equal(writes(f).length,stage==='claim'?0:1);assert.equal(f.providerCalls.length,0);
  assert.equal(saved.connections.some(c=>c.provider==='parcel2go'),false);
  assert.equal(saved.parcel2goSandboxRuns?.at(-1)?.status,stage==='claim'?undefined:'reserved');
});
for(const stage of ['claim','final'])test('lost '+stage+' ack can reconcile its exact revision without repeating a PATCH',async()=>{
  let patches=0;const f=fixture({intercept:async(url,s,proceed)=>{const r=await proceed();if(s.method==='PATCH'&&++patches===(stage==='claim'?1:2))throw Error('synthetic lost ack');return r;}});
  assert.equal((await f.run()).status,'completed');assert.equal(writes(f).length,2);assert.equal(f.providerCalls.length,2);
});
for(const kind of ['throw','http401','redirect','html','big','bad json','duplicate','extra scope','missing expiry','expired response'])test('token '+kind+' remains spent without quote or retry',async()=>{
  let f;f=fixture({provider:()=>{
    if(kind==='throw')throw Error(SECRET_VALUE);
    if(kind==='http401')return new Response(SECRET_VALUE,{status:401});
    if(kind==='redirect')return new Response(null,{status:302,headers:{Location:'https://www.parcel2go.com/api/orders'}});
    if(kind==='html')return new Response(SECRET_VALUE,{headers:{'Content-Type':'text/html'}});
    if(kind==='big')return Response.json({access_token:'a'.repeat(20000)});
    if(kind==='bad json')return new Response('{',{headers:{'Content-Type':'application/json'}});
    if(kind==='duplicate')return new Response('{"access_token":"a","access_token":"b"}',{headers:{'Content-Type':'application/json'}});
    if(kind==='expired response')f.advance(2000);
    return Response.json({access_token:TOKEN,token_type:'Bearer',expires_in:kind==='missing expiry'?undefined:kind==='expired response'?1:3600,scope:kind==='extra scope'?'public-api payment':'public-api'});
  }});await reject(f.run());assert.equal(f.providerCalls.length,1);assert.equal(writes(f).length,1);await reject(f.make().run(f.args));assert.equal(f.providerCalls.length,1);
});
test('timeout aborts injected request and stays durably spent; no second call',async()=>{
  let signal;const f=fixture({provider:(_u,s)=>{signal=s.signal;return new Promise(()=>{});}});
  await reject(f.run(),'PARCEL2GO_PROVIDER_OUTCOME_UNKNOWN');assert.equal(signal.aborted,true);assert.equal(f.providerCalls.length,1);await reject(f.make().run(f.args));assert.equal(f.providerCalls.length,1);
});
for(const drift of ['revision','owner','session','connection','unrelated edit','expiry','clock rollback'])test('after issuer '+drift+' stops before quote and final save',async()=>{
  let f;f=fixture({provider:()=>{
    const s=f.fake.states.get(ID);if(drift==='revision')s._revision=randomUUID();if(drift==='owner')s.users[0].role='admin';if(drift==='session')s.users[0].sessionVersion++;
    if(drift==='connection')s.connections[0].metadata.account='changed';if(drift==='unrelated edit')s.localManualField='keep';if(drift==='expiry')f.advance(300000);if(drift==='clock rollback')f.advance(-1);
    return Response.json({access_token:TOKEN,token_type:'Bearer',expires_in:3600});
  }});await reject(f.run());assert.equal(f.providerCalls.length,1);assert.equal(writes(f).length,1);
});
test('monotonic expiry cannot reopen when wall clock is frozen or later restored',async()=>{
  const f=fixture();f.setMono(301001);await reject(f.run(),'PARCEL2GO_EXPIRED');f.setMono(1000);await reject(f.run(),'PARCEL2GO_EXPIRED');assert.equal(writes(f).length,0);
});
test('forged persistence permit cannot authorize any save',()=>{
  const f=fixture();assert.throws(()=>assertParcel2GoPersistencePermit({},ID,f.state));
});
test('existing provider connection cannot be overwritten during credential admission',async()=>{
  const f=fixture();f.config.operation='admit_credentials';await reject(f.make().run(f.args),'PARCEL2GO_CONNECTION_EXISTS');assert.equal(writes(f).length,0);
});
for(const field of ['weightGrams','lengthMm','widthMm','heightMm'])test('precision needing conversion rounding rejected '+field,()=>{
  const f=fixture();f.intent.parcel[field]='1.001';assert.throws(()=>parcel2GoQuoteRequest(f.intent,binding,f.getTime(),f.config));
});
test('absent explicit VAT/account currency evidence rejected instead of a business default',()=>{
  const f=fixture();assert.throws(()=>parcel2GoQuoteRequest(f.intent,binding,f.getTime()));
});
for(const kind of ['currency missing','currency wrong','total missing','negative','exponent','fraction','vat mismatch','slug duplicate','no quotes','too many','duplicate key'])test('quote schema '+kind+' fails closed',()=>{
  const b=quoteBody(),q=b.Quotes[0];
  if(kind==='currency missing')delete q.CurrencyCode;if(kind==='currency wrong')q.CurrencyCode='EUR';if(kind==='total missing')delete q.TotalPrice;
  if(kind==='negative')q.TotalPrice=-1;if(kind==='exponent')q.TotalPrice=1e30;if(kind==='fraction')q.TotalPrice=12.666;if(kind==='vat mismatch')q.TotalVat=2;
  if(kind==='slug duplicate')b.Quotes.push({...q});if(kind==='no quotes')delete b.Quotes;if(kind==='too many')b.Quotes=Array(51).fill(q);
  const bytes=Buffer.from(kind==='duplicate key'?'{"Quotes":[],"Quotes":[]}':JSON.stringify(b));
  assert.throws(()=>parcel2GoQuoteResponse(bytes,{observedAt:new Date().toISOString(),requestId:randomUUID()}));
});
test('response arithmetic handles decimal cents without binary rounding',()=>{
  const b=quoteBody();Object.assign(b.Quotes[0],{TotalPrice:0.3,TotalPriceExVat:0.1,TotalVat:0.2});
  assert.equal(parcel2GoQuoteResponse(Buffer.from(JSON.stringify(b)),{observedAt:new Date().toISOString(),requestId:randomUUID()}).quotes[0].totalDecimal,'0.30');
});
for(const value of ['0.30000000000000001','3e-1','-0','0.300'])test('original money lexeme '+value+' cannot be rounded silently',()=>{
  const text=JSON.stringify(quoteBody()).replace('12.66',value);
  assert.throws(()=>parcel2GoQuoteResponse(Buffer.from(text),{observedAt:new Date().toISOString(),requestId:randomUUID()}));
});
