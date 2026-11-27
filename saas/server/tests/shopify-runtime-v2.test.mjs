import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {runtimeOwnerFixture,ID,SECRET} from './shopify-runtime-owner-fixture.mjs';
import {expiredState,digest,SCOPES} from './shopify-token-renewal-fixture.mjs';
import {createSessionToken,verifySessionToken,encryptCredentials,decryptCredentials} from '../lib/security.mjs';
import {RUNTIME_RENEWAL_CONNECTION,reviewRuntimeRenewal,assertRuntimeRenewalReviewable,prepareRuntimeRenewalChange,runtimeRenewalCompletion} from '../lib/shopify-renewal-runtime-permit.mjs';

const writes=f=>f.calls.filter(x=>x.method!=='GET');
const apply=plan=>({...plan.state,_revision:plan.nextRevision});
const auth=state=>({state,session:verifySessionToken(createSessionToken({userId:state.users[0].id,workspaceId:ID,email:'synthetic@example.test',role:'owner',sessionVersion:1},SECRET),SECRET)});
// Complete historical evidence is synthetic. No issuer is invoked to build it.
function retained({closed=false,uncertain=false}={}) {
  const now=Date.now(),then=now-86401000;let state=expiredState({legacy:false,now:then});
  state.connections[0].id=RUNTIME_RENEWAL_CONNECTION;state.shopifyTokenExchanges[0].binding.connectionId=RUNTIME_RENEWAL_CONNECTION;
  const session=auth(state).session,ctx=()=>({state,session}),review=reviewRuntimeRenewal(ctx(),then);
  state=apply(prepareRuntimeRenewalChange(ctx(),'approve',review,then));
  state=apply(prepareRuntimeRenewalChange(ctx(),'claim',{requestId:review.requestId,expectedRevision:state._revision},then+1));
  const row=state.shopifyRenewalApprovals[0],prior=state.shopifyTokenExchanges[0],c=state.connections[0],oldCiphertext=c.encryptedCredentials,issuedAt=then+2;
  c.encryptedCredentials=encryptCredentials({...decryptCredentials(oldCiphertext,SECRET),accessToken:'synthetic-retained-v2-token',issuedAt,expiresAt:issuedAt+86399000,tokenExchangeRequestId:row.id},SECRET);
  c.updatedAt=new Date(then+3).toISOString();
  state.shopifyTokenExchanges.push({schema:'runvara-shopify-token-exchange/v1',requestId:row.id,status:'stored',actorId:row.ownerId,sessionVersion:row.approvedSessionVersion,
    binding:{...prior.binding,ciphertextDigest:digest(oldCiphertext),previousReceiptDigest:digest(prior)},approvedScopes:[...SCOPES],startedAt:new Date(issuedAt).toISOString(),expiresAt:row.expiresAt,
    operation:'renew_expired/v1',replacesRequestId:prior.requestId,storedAt:c.updatedAt,tokenExpiresAt:issuedAt+86399000,returnedScopes:[...SCOPES],storedCiphertextDigest:digest(c.encryptedCredentials)});
  state._revision=randomUUID();
  assert.equal(runtimeRenewalCompletion(state,row),'stored');assert.ok(state.shopifyTokenExchanges.at(-1).tokenExpiresAt<now);
  if(closed)state=apply(prepareRuntimeRenewalChange(ctx(),'close',{requestId:row.id,expectedRevision:state._revision},then+4));
  if(uncertain)state.shopifyTokenExchanges.at(-1).storedCiphertextDigest='0'.repeat(64);
  return state;
}

test('expired stored grant still requires durable closure before review and detached approval',()=>{
  const state=retained(),a=auth(state),closed=structuredClone(state);closed.shopifyRenewalApprovals[0].status='closed';closed.shopifyRenewalApprovals[0].closedAt=new Date().toISOString();
  const proposal=reviewRuntimeRenewal({...a,state:closed});
  assert.throws(()=>assertRuntimeRenewalReviewable(a));assert.throws(()=>reviewRuntimeRenewal(a));
  assert.throws(()=>prepareRuntimeRenewalChange(a,'approve',proposal));assert.equal(state.shopifyRenewalApprovals.length,1);
});

test('expired unclosed grant is refused by mounted review; close then fresh approval permits no automatic issuer',async t=>{
  const f=await runtimeOwnerFixture(t,{state:retained()}),before=structuredClone(f.fake.states.get(ID)),r=before.shopifyRenewalApprovals[0];
  assert.equal((await f.call('status')).payload.canReview,false);assert.equal((await f.call('review')).status,409);
  assert.equal(writes(f).length,0);assert.equal(f.issued.length,0);
  const stopped=await f.call('close',{requestId:r.id,expectedRevision:before._revision});assert.equal(stopped.status,200);assert.equal(stopped.payload.terminal,true);assert.equal(stopped.payload.canReview,true);
  const next=await f.approve();assert.notEqual(next.requestId,r.id);assert.equal(writes(f).length,2);assert.equal(f.issued.length,0);
  const saved=f.fake.states.get(ID);assert.equal(saved.shopifyRenewalApprovals[0].status,'closed');assert.equal(saved.shopifyRenewalApprovals[1].status,'approved');
  for(const key of ['connections','shopifyTokenExchanges','products','orders','economics','costHistory'])assert.deepEqual(saved[key],before[key]);
});

test('exact closed resolved historical grant admits a new signed approval without dispatch',async t=>{
  const state=retained({closed:true});assert.equal(runtimeRenewalCompletion(state,state.shopifyRenewalApprovals[0]),'stored');assert.doesNotThrow(()=>assertRuntimeRenewalReviewable(auth(state)));
  const f=await runtimeOwnerFixture(t,{state});await f.approve();assert.equal(writes(f).length,1);assert.equal(f.issued.length,0);
});

test('closed but uncertain historical grant never admits review or a new approval',async t=>{
  const state=retained({closed:true,uncertain:true}),a=auth(state);assert.equal(runtimeRenewalCompletion(state,state.shopifyRenewalApprovals[0]),'uncertain');
  assert.throws(()=>assertRuntimeRenewalReviewable(a));
  const f=await runtimeOwnerFixture(t,{state});assert.equal((await f.call('review')).status,409);const s=(await f.call('status')).payload;
  assert.equal(s.canReview,false);assert.equal(s.terminal,false);assert.equal(s.outcome,'uncertain');assert.equal(writes(f).length,0);assert.equal(f.issued.length,0);
});

test('every earlier grant must be closed even when the latest unused grant is closed',async t=>{
  let state=retained({closed:true});const a=auth(state),r=reviewRuntimeRenewal(a);
  state=apply(prepareRuntimeRenewalChange(a,'approve',r));state=apply(prepareRuntimeRenewalChange({...a,state},'close',{requestId:r.requestId,expectedRevision:state._revision}));
  // Synthetic pre-existing inconsistent history; a latest-row-only guard is insufficient.
  state.shopifyRenewalApprovals[0].status='claimed';delete state.shopifyRenewalApprovals[0].closedAt;
  assert.throws(()=>assertRuntimeRenewalReviewable({...a,state}));
  const f=await runtimeOwnerFixture(t,{state});assert.equal((await f.call('review')).status,409);assert.equal(writes(f).length,0);assert.equal(f.issued.length,0);
});

test('review refuses while close CAS is pending; stale close cannot overwrite a later approval',async t=>{
  let ready,release,holding=true;const pending=new Promise(r=>ready=r),gate=new Promise(r=>release=r);
  const f=await runtimeOwnerFixture(t,{state:retained(),intercept:async({options,proceed})=>{
    if(holding&&options.method==='PATCH'){holding=false;ready();await gate;}return proceed();
  }});t.after(()=>release());
  const s=f.fake.states.get(ID),body={requestId:s.shopifyRenewalApprovals[0].id,expectedRevision:s._revision},closing=f.call('close',body);
  await pending;assert.equal((await f.call('review')).status,409);assert.equal(f.fake.states.get(ID).shopifyRenewalApprovals[0].status,'claimed');
  release();assert.equal((await closing).status,200);
  const review=await f.review(),results=await Promise.all([f.call('approve',review),f.call('close',body)]);
  assert.deepEqual(results.map(x=>x.status),[200,409]);assert.equal(f.fake.states.get(ID).shopifyRenewalApprovals.length,2);
  assert.deepEqual(f.fake.states.get(ID).shopifyRenewalApprovals.map(x=>x.status),['closed','approved']);assert.equal(writes(f).length,2);assert.equal(f.issued.length,0);
});

test('intervening revision after closed grant review refuses stale approval without undoing closure',async t=>{
  const f=await runtimeOwnerFixture(t,{state:retained({closed:true})}),r=await f.review(),s=f.fake.states.get(ID);s._revision=randomUUID();const before=structuredClone(s);
  assert.equal((await f.call('approve',r)).status,409);assert.deepEqual(f.fake.states.get(ID),before);assert.equal(writes(f).length,0);assert.equal(f.issued.length,0);
});
