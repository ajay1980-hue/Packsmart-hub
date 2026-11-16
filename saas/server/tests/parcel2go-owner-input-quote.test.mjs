import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeHttpFixture} from './parcel2go-native-http-fixture.mjs';
import {fixture} from './parcel2go-live-integrated-fixture.mjs';
import {KEY,CLIENT,SECRET_VALUE,TOKEN} from './parcel2go-sandbox-fixture.mjs';
import {createSessionToken,verifySessionToken} from '../lib/security.mjs';
import {parcel2GoCanonicalHash as hash} from '../lib/parcel2go-live-canonical.mjs';
import {deriveOwnerEnteredQuoteApproval} from '../lib/parcel2go-exact-input-producer.mjs';
import {createParcel2GoRecordedOwnerReview as create,PARCEL2GO_RECORDED_REVIEW_PATH as PATH} from '../lib/parcel2go-recorded-owner-review.mjs';

const ORIGIN='https://synthetic-owner-input.example.test';
const writes=c=>c.f.calls.filter(x=>x.settings.method==='PATCH');
const stored=c=>c.f.fake.states.get(c.workspaceId);
const receipt=c=>stored(c).parcel2goLiveQuoteRuns.find(r=>r.requestId===c.options.requestId);
const redacted=value=>{for(const secret of [KEY,CLIENT,SECRET_VALUE,TOKEN])assert.equal(JSON.stringify(value).includes(secret),false);};
async function setup(t,responseFor=()=>({})){
 t.mock.method(Date,'now',()=>Date.parse('2026-11-16T12:00:00.000Z'));
 let c;const network=nativeHttpFixture(t,operation=>responseFor(operation,c)),f=await fixture(),workspaceId=f.config.trustedBinding.workspaceId;
 const state=await f.store.get(workspaceId,{exactSnapshot:true}),user=state.users[0];
 const token=createSessionToken({workspaceId,userId:user.id,email:user.email,role:'owner',csrf:f.session.csrf},KEY),session=verifySessionToken(token,KEY,f.getTime()/1000);
 c={f,network,workspaceId,state,session,token};
 c.options={mode:'unmounted-owner-input-quote/v1',store:f.store,sessionSecret:KEY,origin:ORIGIN,
  withWorkspaceLock:async(id,fn)=>{assert.equal(id,workspaceId);return fn();},
  admission:{...f.config,mode:'disabled/v1',mockRequest:undefined},requestId:f.config.requestId,expiresAt:f.config.expiresAt,now:f.getTime,monotonic:f.config.monotonic};
 c.make=(extra={})=>{const review=create({...c.options,...extra});t.after(()=>review.close());return review;};c.review=c.make();
 c.headers={cookie:`__Host-packsmart_session=${token}`,origin:ORIGIN,'x-csrf-token':session.csrf,'content-type':'application/json'};
 c.send=async(body,{review=c.review,headers={},signal}={})=>{
  const res=await review.handle(new Request(`${ORIGIN}${PATH}?requestId=${c.options.requestId}`,{method:body===undefined?'GET':'POST',headers:{...c.headers,...headers},signal,
   ...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})}));
  return {status:res.status,body:await res.json(),headers:res.headers};
 };
 c.declaration={currency:'GBP',collectionVatStatus:'NotRegistered',deliveryVatStatus:'Individual',collectionPostcode:'SW1A 1AA',deliveryPostcode:'M1 1AE',acknowledgedUnverified:true,
  parcel:{basis:'estimate',scope:'whole_package',includesOuter:true,weightGrams:'5000',lengthMm:'450',widthMm:'300',heightMm:'250',declaredValueDecimal:'15.15'}};
 c.prepare=()=>({action:'prepare',requestId:c.options.requestId,declaration:structuredClone(c.declaration)});
 c.decision=(dto,decision='approved')=>({action:'decide',requestId:c.options.requestId,approvalId:dto.approvalId,confirmation:{decision,revision:dto.revision,operationHash:dto.operationHash}});
 c.execute=dto=>({action:'execute',requestId:c.options.requestId,approvalId:dto.approvalId,confirmation:{approvalId:dto.approvalId,operationHash:dto.operationHash,requestId:c.options.requestId,confirmed:true}});
 c.approve=async()=>{const prepared=await c.send(c.prepare());assert.equal(prepared.status,200);const approved=await c.send(c.decision(prepared.body));assert.equal(approved.status,200);return approved.body;};
 f.calls.length=0;return c;
}

test('owner-input derivation and HTTP remain default disabled',async()=>{
 assert.throws(()=>deriveOwnerEnteredQuoteApproval());
 const review=create({get admission(){assert.fail('Disabled host access');}});
 assert.equal((await review.handle(new Request(ORIGIN))).status,404);
});

for(const basis of ['estimate','measured']){
 test(`HTTP owner ${basis} → saved review → exact decision → native quote uses no evidence registry`,async t=>{
  const c=await setup(t);c.declaration.parcel.basis=basis;
  const entry=await c.send();assert.equal(entry.status,200);assert.equal(entry.body.status,'input_required');assert.equal(writes(c).length,0);
  const prepared=await c.send(c.prepare());assert.equal(prepared.status,200);assert.equal(prepared.body.status,'pending');
  assert.equal(c.network.length,0);assert.equal(writes(c).length,1);
  assert.match(prepared.body.reviewSummary.estimateProvenance,basis==='estimate'?/Owner-authorised estimate, not measured/:/Owner-reported whole-package measurement/);
  assert.match(prepared.body.reviewSummary.estimateProvenance,/not independently verified/);
  assert.match(prepared.body.reviewSummary.collection,/VAT status NotRegistered \(owner declaration\)/);
  assert.equal(prepared.body.sourceVerified,false);assert.equal(prepared.body.accountEntitlementVerified,false);
  const row=stored(c).approvals.find(a=>a.id===prepared.body.approvalId),input=row.payload.quoteInput;
  assert.equal(input.account.evidenceSource,'owner_declaration');assert.equal(input.account.verifiedAt,undefined);
  assert.equal(input.account.declaredAt,row.payload.operation.issuedAt);
  assert.equal(input.parcel.provenance,basis==='estimate'?'owner_authorised_estimate':'owner_reported_measurement');
  // A fresh controller reloads the same saved inputs; no browser resubmission or reader.
  c.f.advance(1000);const fresh=c.make(),reload=await c.send(undefined,{review:fresh});
  assert.equal(reload.body.operationHash,prepared.body.operationHash);assert.equal(reload.body.expiresAt,prepared.body.expiresAt);
  assert.equal((await c.send(c.prepare(),{review:fresh})).body.approvalId,row.id);assert.equal(writes(c).length,1);
  const approved=await c.send(c.decision(reload.body),{review:fresh});assert.equal(approved.status,200);assert.equal(approved.body.status,'approved');
  assert.equal(c.network.length,0);assert.equal(writes(c).length,2);
  const result=await c.send(c.execute(approved.body),{review:fresh});assert.equal(result.status,200);assert.equal(result.body.status,'completed');
  assert.equal(result.body.inputSource,'owner_entered');assert.equal(result.body.liveReady,false);assert.equal(result.body.purchaseAllowed,false);
  assert.equal(result.body.quote.quotes[0].totalDecimal,'12.66');assert.equal(result.body.sourceVerified,false);assert.equal(result.body.accountEntitlementVerified,false);
  assert.deepEqual(c.network.map(x=>new URL(x.url).pathname),['/auth/connect/token','/api/quotes']);
  assert.equal(new URLSearchParams(c.network[0].body).get('scope'),'public-api');
  assert.deepEqual(JSON.parse(c.network[1].body),{CollectionAddress:{Country:'GBR',VatStatus:'NotRegistered',Postcode:'SW1A 1AA'},DeliveryAddress:{Country:'GBR',VatStatus:'Individual',Postcode:'M1 1AE'},Parcels:[{Weight:5,Length:45,Width:30,Height:25,Value:15.15}]});
  assert.equal(writes(c).length,4);assert.equal(receipt(c).status,'completed');assert.equal(receipt(c).projectionHash,hash(result.body.quote));
  assert.equal(receipt(c).exactApproval.approvalId,row.id);assert.equal(JSON.stringify(receipt(c)).includes('12.66'),false);
  for(const key of ['users','connections','orders','products','autopilot','agentOps'])assert.deepEqual(stored(c)[key],c.state[key],key);
  assert.equal(stored(c).audit.filter(a=>a.type==='parcel2go_exact_decided')[0].detail.inputSource,'owner_entered');
  redacted(result.body);redacted(receipt(c));redacted(row);
  assert.equal((await c.send(c.execute(approved.body),{review:c.make()})).status,409);assert.equal(c.network.length,2);assert.equal(writes(c).length,4);
 });
}

for(const bad of ['components','outer_missing','added_tare','verified_claim','account_override','currency','vat','weight','rounding','postcodes','acknowledgement','duplicate_json','body_limit','cookie','tenant','csrf','origin']){
 test(`owner input refuses ${bad} before persistence or provider access`,async t=>{
  const c=await setup(t),d=c.declaration,headers={};
  if(bad==='components')d.parcel.scope='components';if(bad==='outer_missing')d.parcel.includesOuter=false;if(bad==='added_tare')d.parcel.tareGrams='100';
  if(bad==='verified_claim')d.parcel.basis='verified';if(bad==='account_override')d.accountId='synthetic-other';
  if(bad==='currency')d.currency='USD';if(bad==='vat')d.collectionVatStatus='unknown';if(bad==='weight')d.parcel.weightGrams='0';
  if(bad==='rounding')d.parcel.weightGrams='5000.001';if(bad==='postcodes')d.deliveryPostcode='';if(bad==='acknowledgement')d.acknowledgedUnverified=false;
  if(bad==='cookie')headers.cookie='invalid';if(bad==='tenant')headers.cookie='__Host-packsmart_session='+createSessionToken({workspaceId:'synthetic-other-tenant',userId:c.session.sub,email:c.session.email,role:'owner',csrf:c.session.csrf},KEY);
  if(bad==='csrf')headers['x-csrf-token']='invalid';if(bad==='origin')headers.origin='https://synthetic-other.example.test';
  let body=c.prepare();if(bad==='duplicate_json')body=JSON.stringify(body).replace('"action":','"action":"prepare","action":');if(bad==='body_limit')body=' '.repeat(2049)+JSON.stringify(body);
  const out=await c.send(body,{headers});assert.ok([403,409].includes(out.status));assert.equal(writes(c).length,0);assert.equal(c.network.length,0);redacted(out.body);
 });
}

for(const bad of ['pending','rejected','confirmation','input_injection','changed_input','changed_hash','receipt','owner_revoked','expired','closed']){
 test(`execution refuses ${bad} without a reservation`,async t=>{
  const c=await setup(t),prepared=await c.send(c.prepare());assert.equal(prepared.status,200);
  if(bad!=='pending')assert.equal((await c.send(c.decision(prepared.body,bad==='rejected'?'rejected':'approved'))).status,200);
  const before=writes(c).length,body=c.execute(prepared.body),row=stored(c).approvals.find(a=>a.id===body.approvalId);
  if(bad==='confirmation')body.confirmation.confirmed=false;if(bad==='input_injection')body.input={parcel:{weightGrams:'1'}};
  if(bad==='changed_input')row.payload.quoteInput.parcel.weightGrams='6000';if(bad==='changed_hash')body.confirmation.operationHash='0'.repeat(64);
  if(bad==='receipt')stored(c).parcel2goLiveQuoteRuns[0].connectionHash='0'.repeat(64);if(bad==='owner_revoked')stored(c).users[0].active=false;
  if(bad==='expired')c.f.advance(300000);if(bad==='closed')c.review.close();
  assert.equal((await c.send(body)).status,bad==='closed'?404:409);assert.equal(writes(c).length,before);assert.equal(c.network.length,0);
 });
}

test('changing a saved declaration or renewing its deadline requires a different reviewed intent',async t=>{
 const c=await setup(t),first=await c.send(c.prepare());assert.equal(first.status,200);
 c.declaration.parcel.weightGrams='6000';assert.equal((await c.send(c.prepare())).status,409);
 c.f.advance(1000);const renewed=c.make({expiresAt:new Date(c.f.getTime()+300000).toISOString()});
 assert.equal((await c.send(undefined,{review:renewed})).status,409);assert.equal(writes(c).length,1);assert.equal(c.network.length,0);
});

test('concurrent HTTP executors obtain one primary reservation without shared process locking',async t=>{
 const c=await setup(t),dto=await c.approve();
 const out=await Promise.all([c.send(c.execute(dto)),c.send(c.execute(dto),{review:c.make()})]);
 assert.equal(out.filter(x=>x.status===200).length,1);assert.equal(c.network.length,2);
 assert.equal(stored(c).parcel2goLiveQuoteRuns.filter(r=>r.requestId===c.options.requestId).length,1);
 assert.equal(stored(c).audit.filter(a=>a.type==='parcel2go_live_reserved'&&a.detail.requestId===c.options.requestId).length,1);
 assert.equal(receipt(c).status,'completed');
});

for(const fault of ['issuer_rejection','lost_quote','reservation_ack','completion_ack','revoke_after_token','abort_after_token','transport_budget']){
 test(`${fault} is redacted and cannot replay through another HTTP controller`,async t=>{
  const controller=new AbortController();
  const c=await setup(t,(operation,c)=>{
   if(fault==='issuer_rejection'&&operation==='token')return {status:401,body:{error:SECRET_VALUE}};
   if(fault==='lost_quote'&&operation==='quote')return {reset:true};
   if(operation==='token'){
    if(fault==='revoke_after_token')stored(c).users[0].active=false;
    if(fault==='abort_after_token')controller.abort();
    if(fault==='transport_budget')c.f.setMono(12000);
   }
   return {};
  });
  const dto=await c.approve(),save=c.f.store.save.bind(c.f.store);let count=0;
  c.f.store.save=async(...args)=>{const out=await save(...args);count++;if(fault==='reservation_ack'&&count===1||fault==='completion_ack'&&count===2)throw Error('Synthetic lost acknowledgement');return out;};
  const out=await c.send(c.execute(dto),{signal:controller.signal});assert.equal(out.status,409);redacted(out.body);
  assert.equal(receipt(c).status,fault==='completion_ack'?'completed':'reserved');
  assert.equal(c.network.length,fault==='reservation_ack'?0:['lost_quote','completion_ack'].includes(fault)?2:1);
  const calls=c.network.length,saves=writes(c).length;
  assert.equal((await c.send(c.execute(dto),{review:c.make()})).status,409);assert.equal(c.network.length,calls);assert.equal(writes(c).length,saves);
 });
}

test('execute can use its bounded transport budget beyond the preparation deadline',async t=>{
 const c=await setup(t,(operation,c)=>{if(operation==='token')c.f.setMono(2500);}),dto=await c.approve();
 assert.equal((await c.send(c.execute(dto))).status,200);assert.equal(c.network.length,2);
});

test('execute holds the existing host lock without recursive acquisition',async t=>{
 const c=await setup(t);let held=false,entries=0;
 const review=c.make({withWorkspaceLock:async(id,fn)=>{assert.equal(held,false);held=true;entries++;try{return await fn();}finally{held=false;}}});
 const prepared=await c.send(c.prepare(),{review}),approved=await c.send(c.decision(prepared.body),{review});
 assert.equal((await c.send(c.execute(approved.body),{review})).status,200);assert.equal(entries,3);assert.equal(c.network.length,2);
});

test('unconfirmed reservation cannot be attempted twice by the same HTTP controller',async t=>{
 const c=await setup(t),dto=await c.approve();let attempts=0;
 c.f.store.save=async()=>{attempts++;throw Error('Synthetic uncertain persistence');};
 assert.equal((await c.send(c.execute(dto))).status,409);assert.equal(receipt(c),undefined);
 assert.equal((await c.send(c.execute(dto))).status,409);assert.equal(attempts,1);assert.equal(c.network.length,0);
});

test('an existing approval does not make a null declaration valid',async t=>{
 const c=await setup(t);assert.equal((await c.send(c.prepare())).status,200);
 assert.equal((await c.send({...c.prepare(),declaration:null})).status,409);assert.equal(writes(c).length,1);assert.equal(c.network.length,0);
});
