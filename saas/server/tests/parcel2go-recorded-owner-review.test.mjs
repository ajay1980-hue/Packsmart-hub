import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeHttpFixture} from './parcel2go-native-http-fixture.mjs';
import {fixture} from './parcel2go-live-integrated-fixture.mjs';
import {KEY,CLIENT,SECRET_VALUE,TOKEN} from './parcel2go-sandbox-fixture.mjs';
import {createSessionToken,verifySessionToken} from '../lib/security.mjs';
import {parcel2GoCanonicalHash as hash} from '../lib/parcel2go-live-canonical.mjs';
import {deriveRecordedQuoteApproval} from '../lib/parcel2go-exact-input-producer.mjs';
import {createExactQuoteApproval} from '../lib/parcel2go-exact-approval.mjs';
import {createParcel2GoExactQuoteCandidate} from '../lib/parcel2go-live-admission.mjs';
import {createParcel2GoRecordedOwnerReview as create,PARCEL2GO_RECORDED_REVIEW_PATH as PATH} from '../lib/parcel2go-recorded-owner-review.mjs';

const ORIGIN='https://synthetic-review.example.test';
const writes=f=>f.calls.filter(x=>x.settings.method==='PATCH');
async function setup(t){
 t.mock.method(Date,'now',()=>Date.parse('2026-11-16T12:00:00.000Z'));
 const network=nativeHttpFixture(t),f=await fixture(),workspaceId=f.config.trustedBinding.workspaceId;
 const state=await f.store.get(workspaceId,{exactSnapshot:true}),user=state.users[0];
 const token=createSessionToken({workspaceId,userId:user.id,email:user.email,role:'owner',csrf:f.session.csrf},KEY);
 const session=verifySessionToken(token,KEY,f.getTime()/1000);
 const input=structuredClone(f.args.input);input.parcel.provenance='measured_packed_parcel';
 const packet={schema:'runvara-parcel2go-recorded-evidence/v1',workspaceId,requestId:f.config.requestId,
  issuedAt:new Date(f.getTime()).toISOString(),expiresAt:f.config.expiresAt,connectionId:f.config.trustedBinding.connectionId,
  termsReference:f.config.termsReference,accountEvidenceReference:'synthetic-account-record',credentialReceiptHash:f.config.expectedCredentialReceiptHash,input,
  packing:{workspaceId,evidenceId:input.parcel.evidenceId,observedAt:input.parcel.observedAt,
   selection:{packingPlanId:'synthetic-whole-package',units:500},
   measurement:{packingPlanId:'synthetic-whole-package',units:500,scope:'whole_package',basis:'measured',includesOuter:true,
    ...Object.fromEntries(['weightGrams','lengthMm','widthMm','heightMm'].map(k=>[k,input.parcel[k]]))},additions:[]}};
 const c={f,network,workspaceId,packet,session,token,state,evidenceReads:0,beforeEvidence:null};
 c.options={mode:'unmounted-recorded-review/v1',store:f.store,sessionSecret:KEY,origin:ORIGIN,
  withWorkspaceLock:async(id,fn)=>{assert.equal(id,workspaceId);return fn();},
  readEvidence:async args=>{assert.equal(args.workspaceId,workspaceId);assert.equal(args.requestId,packet.requestId);c.evidenceReads++;await c.beforeEvidence?.(args);return structuredClone(c.packet);},
  expectedEvidenceHash:hash(packet),requestId:packet.requestId,expiresAt:packet.expiresAt,now:f.getTime,monotonic:f.config.monotonic};
 c.make=(extra={})=>create({...c.options,...extra});c.review=c.make();t.after(()=>c.review.close());
 c.headers={cookie:`__Host-packsmart_session=${token}`,origin:ORIGIN,'x-csrf-token':session.csrf,'content-type':'application/json'};
 c.url=`${ORIGIN}${PATH}?requestId=${packet.requestId}`;
 c.send=async(body,{review=c.review,headers={},url=c.url,signal,...rest}={})=>{
  const req=new Request(url,{method:body===undefined?'GET':'POST',headers:{...c.headers,...headers},signal,
   ...(body===undefined?{}:{body:typeof body==='string'||body instanceof Uint8Array||body instanceof ReadableStream?body:JSON.stringify(body),duplex:'half'}),...rest});
  const res=await review.handle(req);return {status:res.status,body:await res.json(),headers:res.headers};
 };
 c.prepare=()=>({action:'prepare',requestId:packet.requestId,evidenceHash:c.options.expectedEvidenceHash});
 c.decision=(dto,decision='approved')=>({action:'decide',requestId:packet.requestId,evidenceHash:c.options.expectedEvidenceHash,
  approvalId:dto.approvalId,confirmation:{decision,revision:dto.revision,operationHash:dto.operationHash}});
 f.calls.length=0;return c;
}
function redacted(value){const text=JSON.stringify(value);for(const secret of [KEY,CLIENT,SECRET_VALUE,TOKEN])assert.equal(text.includes(secret),false);}

test('disabled review never reads host configuration or evidence',async()=>{
 const r=create({get store(){assert.fail('Disabled store access');}}),response=await r.handle(new Request(ORIGIN));
 assert.equal(response.status,404);
 assert.throws(()=>deriveRecordedQuoteApproval());
});

test('read-only preview keeps evidence claims distinct from verification and permission',async t=>{
 const c=await setup(t),out=await c.send();assert.equal(out.status,200);
 assert.equal(out.body.status,'not_prepared');assert.equal(out.body.approvalId,null);
 assert.equal(out.body.sourceVerified,false);assert.equal(out.body.accountEntitlementVerified,false);
 assert.match(out.body.evidenceNotice,/not independently verified/);assert.equal(out.body.durableDecision,false);
 assert.equal(out.body.providerCallsAllowed,false);assert.equal(out.body.liveReady,false);
 assert.deepEqual(out.body.packing,{packingPlanId:'synthetic-whole-package',units:500,scope:'whole_package',basis:'measured',includesOuter:true});
 assert.match(out.body.reviewSummary.parcel,/5 kg; length 45 cm/);assert.equal(out.headers.get('cache-control'),'no-store');
 assert.equal(c.network.length,0);assert.equal(writes(c.f).length,0);redacted(out.body);
});

test('bounded recorded review prepares and decides once, then composes with mocked exact native admission',async t=>{
 const c=await setup(t),preview=await c.send(),prepared=await c.send(c.prepare());
 assert.equal(prepared.status,200);assert.equal(prepared.body.status,'pending');
 assert.equal(prepared.body.operationHash,preview.body.operationHash);assert.equal(writes(c.f).length,1);
 const decision=await c.send(c.decision(prepared.body));assert.equal(decision.status,200);assert.equal(decision.body.status,'approved');
 assert.equal(decision.body.durableDecision,true);assert.equal(decision.body.providerCallsAllowed,false);
 assert.equal(writes(c.f).length,2);assert.equal(c.network.length,0);
 assert.equal((await c.send(c.prepare())).body.approvalId,prepared.body.approvalId);
 assert.equal((await c.send(c.decision(prepared.body))).status,409);assert.equal(writes(c.f).length,2);
 const stored=c.f.fake.states.get(c.workspaceId),audit=stored.audit.filter(a=>a.type==='parcel2go_exact_decided');
 assert.equal(audit.length,1);assert.equal(audit[0].detail.evidenceHash,c.options.expectedEvidenceHash);
 for(const key of ['connections','users','orders','products','autopilot','agentOps'])assert.deepEqual(stored[key],c.state[key],key);
 const op=stored.approvals.find(a=>a.id===decision.body.approvalId).payload.operation;
 const runner=createParcel2GoExactQuoteCandidate({mode:'unmounted-exact-https-candidate/v1',origin:ORIGIN,sessionSecret:KEY,withWorkspaceLock:c.options.withWorkspaceLock,
  admission:{...c.f.config,mode:'disabled/v1',mockRequest:undefined,expectedRevision:stored._revision,expectedSessionFingerprint:hash(c.session),inputFingerprint:op.inputFingerprint,expiresAt:op.expiresAt},
  exactApproval:{approvalId:decision.body.approvalId,operationHash:decision.body.operationHash,accountEvidenceReference:op.accountEvidenceReference}});
 const quote=await runner.run({headers:c.headers,input:c.packet.input,
  confirmation:{approvalId:decision.body.approvalId,operationHash:decision.body.operationHash,requestId:c.packet.requestId,confirmed:true}});
 assert.equal(quote.status,'completed');assert.equal(quote.liveReady,false);assert.equal(c.network.length,2);redacted(quote);
});

for(const bad of ['components','estimated','outer_missing','tare','quantity','plan','weight','dimensions','scope','evidence','estimate_input','future','expired','receipt','extra']){
 test(`server-pinned evidence still rejects invalid ${bad}`,async t=>{
  const c=await setup(t),p=c.packet.packing,m=p.measurement;
  if(bad==='components')m.scope='components';if(bad==='estimated')m.basis='estimated';if(bad==='outer_missing')m.includesOuter=false;
  if(bad==='tare')p.additions=[{grams:100}];if(bad==='quantity')m.units=1000;if(bad==='plan')m.packingPlanId='synthetic-other-plan';
  if(bad==='weight')m.weightGrams='6000';if(bad==='dimensions')m.lengthMm='500';if(bad==='scope')p.workspaceId='synthetic-other-tenant';
  if(bad==='evidence')p.evidenceId='synthetic-other-evidence';if(bad==='estimate_input')c.packet.input.parcel.provenance='owner_authorised_estimate';
  if(bad==='future')c.packet.issuedAt=new Date(c.f.getTime()+1).toISOString();if(bad==='expired')c.packet.expiresAt=new Date(c.f.getTime()).toISOString();
  if(bad==='receipt')c.packet.credentialReceiptHash='0'.repeat(64);if(bad==='extra')c.packet.verified=true;
  c.options.expectedEvidenceHash=hash(c.packet);const review=c.make();t.after(()=>review.close());
  assert.equal((await c.send(c.prepare(),{review})).status,409);assert.equal(c.network.length,0);assert.equal(writes(c.f).length,0);
 });
}

for(const bad of ['cookie','bearer','tenant','csrf','origin','hash','input','permission','duplicate_json','large_body','utf8']){
 test(`bounded HTTP refuses ${bad} before evidence or writes`,async t=>{
  const c=await setup(t),headers={};let body=c.prepare();
  if(bad==='cookie')headers.cookie='__Host-packsmart_session=invalid';
  if(bad==='bearer'){headers.cookie='';headers.authorization=`Bearer ${c.token}`;}
  if(bad==='tenant')headers.cookie='__Host-packsmart_session='+createSessionToken({workspaceId:'synthetic-other-tenant',userId:c.session.sub,email:c.session.email,role:'owner',csrf:c.session.csrf},KEY);
  if(bad==='csrf')headers['x-csrf-token']='invalid';if(bad==='origin')headers.origin='https://synthetic-other.example.test';
  if(bad==='hash')body.evidenceHash='0'.repeat(64);if(bad==='input')body.input=c.packet.input;if(bad==='permission')body.action='execute';
  if(bad==='duplicate_json')body=JSON.stringify(body).replace('"action":','"action":"prepare","action":');
  if(bad==='large_body')body=' '.repeat(2049)+JSON.stringify(body);if(bad==='utf8')body=new Uint8Array([0xc3,0x28]);
  const out=await c.send(body,{headers});assert.ok([403,409].includes(out.status));assert.equal(c.evidenceReads,0);
  assert.equal(c.network.length,0);assert.equal(writes(c.f).length,0);redacted(out.body);
 });
}

test('changed host packet cannot be substituted after pending review',async t=>{
 const c=await setup(t),prepared=await c.send(c.prepare());c.packet.input.parcel.weightGrams='6000';
 assert.equal((await c.send(c.decision(prepared.body))).status,409);
 assert.equal(writes(c.f).length,1);assert.equal(c.f.fake.states.get(c.workspaceId).approvals[0].status,'pending');assert.equal(c.network.length,0);
});

for(const failure of ['owner_revoked','timeout','aborted','clock_rollback','monotonic_window']){
 test(`${failure} during evidence read refuses before persistence`,async t=>{
  const c=await setup(t),controller=new AbortController();
  c.beforeEvidence=()=>{
   if(failure==='owner_revoked')c.f.fake.states.get(c.workspaceId).users[0].active=false;
   if(failure==='timeout')c.f.setMono(2000);if(failure==='aborted')controller.abort();
   if(failure==='clock_rollback')c.f.advance(-1);if(failure==='monotonic_window')c.f.setMono(300000);
  };
  assert.equal((await c.send(c.prepare(),{signal:controller.signal})).status,409);
  assert.equal(writes(c.f).length,0);assert.equal(c.network.length,0);
 });
}

for(const stage of ['prepare','decide']){
 test(`lost ${stage} acknowledgement reconciles an exact saved result without retry`,async t=>{
  const c=await setup(t);let prepared;if(stage==='decide')prepared=await c.send(c.prepare());
  const save=c.f.store.save.bind(c.f.store);let attempts=0;
  c.f.store.save=async(...args)=>{attempts++;await save(...args);throw Error('Synthetic acknowledgement lost');};
  const body=stage==='prepare'?c.prepare():c.decision(prepared.body),out=await c.send(body);
  assert.equal(out.status,200);assert.equal(out.body.status,stage==='prepare'?'pending':'approved');assert.equal(attempts,1);
  assert.equal((await c.send()).body.status,out.body.status);assert.equal(attempts,1);assert.equal(c.network.length,0);
 });
}

test('an unconfirmed preparation is not written twice by the same controller',async t=>{
 const c=await setup(t);let attempts=0;c.f.store.save=async()=>{attempts++;throw Error('Synthetic unconfirmed write');};
 assert.equal((await c.send(c.prepare())).status,409);assert.equal((await c.send()).body.status,'not_prepared');
 assert.equal((await c.send(c.prepare())).status,409);assert.equal(attempts,1);assert.equal(c.network.length,0);
});

test('independent preparations use one durable request identity under primary CAS',async t=>{
 const c=await setup(t),other=c.make();t.after(()=>other.close());
 const outcomes=await Promise.all([c.send(c.prepare()),c.send(c.prepare(),{review:other})]);
 assert.ok(outcomes.some(x=>x.status===200));
 const matches=c.f.fake.states.get(c.workspaceId).approvals.filter(a=>a.requestIdentity?.requestId===c.packet.requestId);
 assert.equal(matches.length,1);assert.equal(c.network.length,0);
});

test('late evidence resolution after cancellation cannot write',async t=>{
 const c=await setup(t),controller=new AbortController();let release,entered;
 const waiting=new Promise(r=>{entered=r;});c.beforeEvidence=()=>new Promise(r=>{release=r;entered();});
 const pending=c.send(c.prepare(),{signal:controller.signal});await waiting;controller.abort();
 assert.equal((await pending).status,409);release();await new Promise(r=>setImmediate(r));
 assert.equal(writes(c.f).length,0);assert.equal(c.network.length,0);
});

test('rejection is durable and cannot be replaced with approval',async t=>{
 const c=await setup(t),prepared=await c.send(c.prepare());
 const rejected=await c.send(c.decision(prepared.body,'rejected'));
 assert.equal(rejected.status,200);assert.equal(rejected.body.status,'rejected');
 assert.equal((await c.send()).body.durableDecision,true);
 assert.equal((await c.send(c.decision(prepared.body))).status,409);
 assert.equal(writes(c.f).length,2);assert.equal(c.network.length,0);
});

test('replaying preparation preserves its original finite window across controllers',async t=>{
 const c=await setup(t),first=await c.send(c.prepare());c.f.advance(1000);
 const other=c.make();t.after(()=>other.close());const replay=await c.send(c.prepare(),{review:other});
 assert.equal(replay.status,200);assert.equal(replay.body.approvalId,first.body.approvalId);
 assert.equal(replay.body.operationHash,first.body.operationHash);assert.equal(replay.body.expiresAt,first.body.expiresAt);
 assert.ok(replay.body.remainingMs<first.body.remainingMs);assert.equal(writes(c.f).length,1);
 c.packet.issuedAt=new Date(c.f.getTime()).toISOString();c.packet.expiresAt=new Date(c.f.getTime()+300000).toISOString();
 c.options.expectedEvidenceHash=hash(c.packet);c.options.expiresAt=c.packet.expiresAt;
 const renewed=c.make();t.after(()=>renewed.close());
 assert.equal((await c.send(c.prepare(),{review:renewed})).status,409);assert.equal(writes(c.f).length,1);
});

for(const stage of ['beforeEffects','beforeCommit']){
 test(`abort at preparation ${stage} prevents writes through the evidence guard`,async t=>{
  const c=await setup(t),controller=new AbortController(),save=c.f.store.save.bind(c.f.store);
  c.f.store.save=(id,state,options)=>save(id,state,{...options,[stage]:snapshot=>{controller.abort();options[stage](snapshot);}});
  assert.equal((await c.send(c.prepare(),{signal:controller.signal})).status,409);
  await new Promise(r=>setImmediate(r));assert.equal(writes(c.f).length,0);assert.equal(c.network.length,0);
 });
}

test('idempotent approval creation still runs the optional fresh evidence guard',async t=>{
 const c=await setup(t);assert.equal((await c.send(c.prepare())).status,200);
 const state=await c.f.store.get(c.workspaceId,{exactSnapshot:true}),auth={state,session:c.session,user:state.users[0]};
 const prepared=deriveRecordedQuoteApproval({mode:'unmounted-recorded-input/v1',auth,packet:c.packet,
  expectedEvidenceHash:c.options.expectedEvidenceHash,requestId:c.packet.requestId,now:c.f.getTime()});
 let checks=0;
 await assert.rejects(createExactQuoteApproval({mode:'local-contract/v1',store:c.f.store,auth,intent:prepared.intent,now:c.f.getTime,
  assertEvidenceCurrent:()=>{checks++;throw Error('Synthetic evidence revoked');}}));
 assert.equal(checks,1);assert.equal(writes(c.f).length,1);assert.equal(c.network.length,0);
});
