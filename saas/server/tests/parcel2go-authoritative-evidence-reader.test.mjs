import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './parcel2go-live-integrated-fixture.mjs';
import {nativeHttpFixture} from './parcel2go-native-http-fixture.mjs';
import {KEY,CLIENT,SECRET_VALUE,TOKEN} from './parcel2go-sandbox-fixture.mjs';
import {createSessionToken} from '../lib/security.mjs';
import {parcel2GoCanonicalHash as hash} from '../lib/parcel2go-live-canonical.mjs';
import {createParcel2GoAuthoritativeEvidenceReader as create,PARCEL2GO_EVIDENCE_SOURCE_REQUIRED as MISSING,PARCEL2GO_EVIDENCE_DEPENDENCIES as DEPENDENCIES} from '../lib/parcel2go-authoritative-evidence-reader.mjs';
import {createParcel2GoRecordedOwnerReview,PARCEL2GO_RECORDED_REVIEW_PATH} from '../lib/parcel2go-recorded-owner-review.mjs';

async function setup(t){
 t.mock.method(Date,'now',()=>Date.parse('2026-11-16T12:00:00.000Z'));
 const network=nativeHttpFixture(t),f=await fixture(),workspaceId=f.config.trustedBinding.workspaceId;
 const options={mode:'unmounted-source-reader/v1',store:f.store,requestId:f.config.requestId,expiresAt:f.config.expiresAt,now:f.getTime,monotonic:f.config.monotonic};
 const reader=create(options);t.after(()=>reader.close());f.calls.length=0;
 return {f,network,options,reader,args:{workspaceId,requestId:options.requestId},get state(){return f.fake.states.get(workspaceId);}};
}
const writes=c=>c.f.calls.filter(x=>x.settings.method==='PATCH');
const receipt=c=>c.state.parcel2goLiveQuoteRuns.find(r=>r.operation==='admit_credentials');
const connection=c=>c.state.connections.find(r=>r.provider==='parcel2go-live');
function noAuthority(out){
 assert.equal(out.packet,null);assert.equal(out.sourceVerified,false);assert.equal(out.accountEntitlementVerified,false);
 assert.equal(out.quoteReady,false);assert.equal(out.providerCallsAllowed,false);assert.equal(out.liveReady,false);
 for(const secret of [KEY,CLIENT,SECRET_VALUE,TOKEN])assert.equal(JSON.stringify(out).includes(secret),false);
}

test('disabled reader never accesses configuration or primary state',async()=>{
 const r=create({get store(){assert.fail('Disabled store access');}}),out=await r.inspect();
 assert.equal(out.status,'disabled');noAuthority(out);await assert.rejects(r.readEvidence(),{code:MISSING});
});

test('exact primary snapshot establishes only retained credential-storage linkage',async t=>{
 const c=await setup(t),get=c.f.store.get.bind(c.f.store);let reads=0;
 c.f.store.get=(workspaceId,options)=>{reads++;assert.equal(workspaceId,c.args.workspaceId);assert.deepEqual(options,{exactSnapshot:true});return get(workspaceId,options);};
 const before=structuredClone(c.state),out=await c.reader.inspect(c.args);
 assert.equal(out.status,'blocked');assert.equal(out.credentialStorage,'linked_receipt');assert.deepEqual(out.blockers,DEPENDENCIES);noAuthority(out);
 await assert.rejects(c.reader.readEvidence(c.args),{code:MISSING});assert.equal(reads,2);
 assert.equal(writes(c).length,0);assert.equal(c.network.length,0);assert.deepEqual(c.state,before);
 assert.equal(JSON.stringify(out).includes(connection(c).encryptedCredentials),false);
});

for(const bad of ['absent','missing_receipt','duplicate_connection','duplicate_receipt','reserved','account','environment','terms','fingerprint','connection_hash','ciphertext','future_time','invalid_time','expiry_time']){
 test(`storage status stays closed for ${bad}`,async t=>{
  const c=await setup(t),r=receipt(c),x=connection(c);
  if(bad==='absent'){c.state.connections=[];c.state.parcel2goLiveQuoteRuns=[];}
  if(bad==='missing_receipt')c.state.parcel2goLiveQuoteRuns=[];
  if(bad==='duplicate_connection')c.state.connections.push(structuredClone(x));
  if(bad==='duplicate_receipt')c.state.parcel2goLiveQuoteRuns.push(structuredClone(r));
  if(bad==='reserved')r.status='reserved';if(bad==='account')r.accountId='synthetic-other';if(bad==='environment')r.environment='sandbox';
  if(bad==='terms')r.termsReference='';if(bad==='fingerprint')r.fingerprint='0'.repeat(64);if(bad==='connection_hash')r.connectionHash='0'.repeat(64);
  if(bad==='ciphertext')x.encryptedCredentials='synthetic-unsealed';
  if(bad==='future_time')r.completedAt=new Date(c.f.getTime()+1).toISOString();if(bad==='invalid_time')r.completedAt='invalid';if(bad==='expiry_time')r.expiresAt=r.completedAt;
  const out=await c.reader.inspect(c.args);assert.equal(out.credentialStorage,bad==='absent'?'absent':'unconfirmed');
  assert.ok(out.blockers.includes('credential_storage_unconfirmed'));noAuthority(out);
  await assert.rejects(c.reader.readEvidence(c.args),{code:MISSING});assert.equal(writes(c).length,0);assert.equal(c.network.length,0);
 });
}

for(const bad of ['workspace','request','packet','verified']){
 test(`request ${bad} cannot select or inject a source`,async t=>{
  const c=await setup(t),args={...c.args};
  if(bad==='workspace')args.workspaceId='synthetic-other-tenant';if(bad==='request')args.requestId=randomUUID();
  if(bad==='packet')args.packet={sourceVerified:true};if(bad==='verified')args.verified=true;
  await assert.rejects(c.reader.inspect(args),{code:'PARCEL2GO_EVIDENCE_SCOPE_REFUSED'});
  assert.equal(c.f.calls.length,0);assert.equal(c.network.length,0);
 });
}

for(const place of ['root','workspace','connection','receipt']){
 test(`foreign ${place} scope never becomes storage evidence`,async t=>{
  const c=await setup(t);
  const target=place==='root'?c.state:place==='workspace'?c.state.workspace:place==='connection'?connection(c):receipt(c);
  target.tenantId='synthetic-other-tenant';
  if(place==='connection')receipt(c).connectionHash=hash(connection(c));
  await assert.rejects(c.reader.inspect(c.args),{code:'PARCEL2GO_EVIDENCE_READ_REFUSED'});
  assert.equal(writes(c).length,0);assert.equal(c.network.length,0);
 });
}

test('arbitrary saved claims and metadata do not create an authoritative source',async t=>{
 const c=await setup(t);
 // Invented claims intentionally resemble evidence. No ingestion/verifier owns
 // these workspace keys, so even consistent hashes and verified flags confer nothing.
 c.state.shippingEvidence={sourceVerified:true,verified:true,packet:{schema:'runvara-parcel2go-recorded-evidence/v1',requestId:c.args.requestId}};
 c.state.packedMeasurements=[{scope:'whole_package',basis:'measured',weightGrams:'1000',verified:true}];
 c.state.accountEntitlement={verified:true,currency:'GBP'};
 c.state.suppliers[0].metadata={verified:true,packingReady:true};
 const out=await c.reader.inspect(c.args);assert.equal(out.credentialStorage,'linked_receipt');noAuthority(out);
 assert.deepEqual(out.blockers,DEPENDENCIES);await assert.rejects(c.reader.readEvidence(c.args),{code:MISSING});
 assert.equal(writes(c).length,0);assert.equal(c.network.length,0);
});

test('field-specific checks accept a historical .999Z completion without treating it as permission',async t=>{
 const c=await setup(t);receipt(c).completedAt='2026-11-16T11:59:59.999Z';c.state.notes='FOREIGN 999 is unrelated text';
 const out=await c.reader.inspect(c.args);assert.equal(out.credentialStorage,'linked_receipt');noAuthority(out);
 c.f.advance(360000);const later=create({...c.options,expiresAt:new Date(c.f.getTime()+300000).toISOString()});t.after(()=>later.close());
 assert.equal((await later.inspect(c.args)).credentialStorage,'linked_receipt');
 await assert.rejects(later.readEvidence(c.args),{code:MISSING});
});

test('fresh reads detect changed storage and never reuse a cached positive result',async t=>{
 const c=await setup(t);assert.equal((await c.reader.inspect(c.args)).credentialStorage,'linked_receipt');
 connection(c).encryptedCredentials+='changed';
 assert.equal((await c.reader.inspect(c.args)).credentialStorage,'unconfirmed');assert.equal(c.f.calls.length,2);
});

for(const failure of ['expired','rollback','monotonic','aborted','closed']){
 test(`${failure} reader stops before primary read`,async t=>{
  const c=await setup(t),controller=new AbortController();
  if(failure==='expired')c.f.advance(300000);if(failure==='rollback')c.f.advance(-1);if(failure==='monotonic')c.f.setMono(300000);
  if(failure==='aborted')controller.abort();if(failure==='closed')c.reader.close();
  await assert.rejects(c.reader.inspect({...c.args,signal:controller.signal}),{code:'PARCEL2GO_EVIDENCE_READ_REFUSED'});
  assert.equal(c.f.calls.length,0);assert.equal(c.network.length,0);
 });
}

test('a cancelled pending read cannot release a later result or write',async t=>{
 const c=await setup(t),controller=new AbortController();let entered,release;
 const ready=new Promise(r=>{entered=r;});c.f.store.get=()=>new Promise(r=>{release=r;entered();});
 const pending=c.reader.inspect({...c.args,signal:controller.signal});await ready;controller.abort();
 await assert.rejects(pending,{code:'PARCEL2GO_EVIDENCE_READ_REFUSED'});release(structuredClone(c.state));await new Promise(r=>setImmediate(r));
 assert.equal(writes(c).length,0);assert.equal(c.network.length,0);
});

test('primary errors are redacted and the two-second read budget is enforced',async t=>{
 const c=await setup(t);c.f.store.get=async()=>{throw Error(SECRET_VALUE);};
 await assert.rejects(c.reader.inspect(c.args),error=>{assert.equal(error.message.includes(SECRET_VALUE),false);return error.code==='PARCEL2GO_EVIDENCE_READ_REFUSED';});
 c.f.store.get=async()=>{c.f.setMono(2000);return structuredClone(c.state);};
 await assert.rejects(c.reader.inspect(c.args),{code:'PARCEL2GO_EVIDENCE_READ_REFUSED'});assert.equal(writes(c).length,0);
});

test('recorded owner review defaults to the fail-closed primary reader with safe dependency diagnostics',async t=>{
 const c=await setup(t),user=c.state.users[0],origin='https://synthetic-source.example.test';
 const token=createSessionToken({userId:user.id,workspaceId:c.args.workspaceId,email:user.email,role:'owner',csrf:c.f.session.csrf},KEY);
 const review=createParcel2GoRecordedOwnerReview({mode:'unmounted-recorded-review/v1',store:c.f.store,sessionSecret:KEY,origin,
  withWorkspaceLock:async(_id,fn)=>fn(),expectedEvidenceHash:'0'.repeat(64),requestId:c.args.requestId,
  expiresAt:c.options.expiresAt,now:c.f.getTime,monotonic:c.options.monotonic});t.after(()=>review.close());
 const before=structuredClone(c.state);
 for(const method of ['GET','POST']){
  const response=await review.handle(new Request(`${origin}${PARCEL2GO_RECORDED_REVIEW_PATH}?requestId=${c.args.requestId}`,{method,
   headers:{cookie:`__Host-packsmart_session=${token}`,origin,'x-csrf-token':c.f.session.csrf,'content-type':'application/json'},
   ...(method==='POST'?{body:JSON.stringify({action:'prepare',requestId:c.args.requestId,evidenceHash:'0'.repeat(64)})}:{})}));
  assert.equal(response.status,409);const body=await response.json();assert.equal(body.code,MISSING);assert.deepEqual(body.blockers,DEPENDENCIES);
  noAuthority(body);
 }
 assert.equal(writes(c).length,0);assert.equal(c.network.length,0);assert.deepEqual(c.state,before);
});
