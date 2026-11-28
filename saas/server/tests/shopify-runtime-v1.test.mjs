import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {runtimeOwnerFixture,ID,SECRET,secretPattern} from './shopify-runtime-owner-fixture.mjs';
import {createSessionToken} from '../lib/security.mjs';
import {runtimeRenewalCompletion,runtimeRenewalDigest} from '../lib/shopify-renewal-runtime-permit.mjs';
const writes=f=>f.calls.filter(x=>x.method!=='GET');
const full=f=>f.calls.filter(x=>x.url.searchParams.get('select')==='state');

for(const kind of ['missing-signature','malformed-signature','changed-signature','new-id','extended-expiry','issue-time','terms','prior-receipt','different-session'])test('signed review rejects '+kind+' before approval',async t=>{
  const f=await runtimeOwnerFixture(t),r=await f.review(),extra={};
  if(kind==='missing-signature')delete r.challenge;if(kind==='malformed-signature')r.challenge='invalid';
  if(kind==='changed-signature')r.challenge=(r.challenge[0]==='A'?'B':'A')+r.challenge.slice(1);
  if(kind==='new-id')r.requestId=randomUUID();if(kind==='extended-expiry')r.expiresAt=new Date(Date.parse(r.expiresAt)+1).toISOString();
  if(kind==='issue-time')r.issuedAt=new Date(Date.parse(r.issuedAt)-1).toISOString();if(kind==='terms')r.termsVersion='unreviewed';
  if(kind==='prior-receipt')f.fake.states.get(ID).shopifyTokenExchanges[0].actorId='changed-synthetic-owner';
  if(kind==='different-session'){const token=createSessionToken({userId:f.state.users[0].id,workspaceId:ID,email:'synthetic@example.test',role:'owner',sessionVersion:1},SECRET);extra.cookie='__Host-packsmart_session='+token;}
  assert.notEqual((await f.call('approve',r,extra)).status,200);assert.equal(writes(f).length,0);assert.equal(f.issued.length,0);
});

test('signed review accepts JSON member reordering with no automatic issuer',async t=>{
  const f=await runtimeOwnerFixture(t),r=Object.fromEntries(Object.entries(await f.review()).reverse());
  assert.equal((await f.call('approve',r)).status,200);assert.equal(writes(f).length,1);assert.equal(f.issued.length,0);
});

for(const kind of ['wrong-workspace','admin-cookie','other-owner-id','revoked','inactive','password-setup','multiple-active-owners'])test('identity admission refuses '+kind+' before full snapshot',async t=>{
  const f=await runtimeOwnerFixture(t),s=f.fake.states.get(ID);let cookie=f.cookie;
  if(['wrong-workspace','admin-cookie','other-owner-id'].includes(kind))cookie='__Host-packsmart_session='+createSessionToken({userId:kind==='other-owner-id'?'other-synthetic-owner':s.users[0].id,workspaceId:kind==='wrong-workspace'?'other-workspace':ID,email:'synthetic@example.test',role:kind==='admin-cookie'?'admin':'owner',sessionVersion:1},SECRET);
  if(kind==='revoked')s.users[0].sessionVersion++;if(kind==='inactive')s.users[0].active=false;if(kind==='password-setup')s.users[0].passwordChangeRequired=true;
  if(kind==='multiple-active-owners')s.users.push({...s.users[0],id:'additional-synthetic-owner'});
  assert.notEqual((await f.call('status',undefined,{cookie})).status,200);assert.equal(full(f).length,0);assert.equal(writes(f).length,0);assert.equal(f.issued.length,0);
});
test('intended owner identity projection precedes the full state read',async t=>{
  const f=await runtimeOwnerFixture(t);assert.equal((await f.call('status')).status,200);
  assert.equal(f.calls[0].url.searchParams.get('select'),'state->workspace,state->users');assert.equal(f.calls[1].url.searchParams.get('select'),'state');
});

for(const kind of ['receipt-missing','missing-field','extra-field','operation','previous','owner','session','scopes','binding','prior-digest','old-ciphertext','saved-digest','changed-saved-value','settings','timestamp','expiry','prior-record','duplicate-receipt'])test('completion remains unconfirmed for '+kind,async t=>{
  const f=await runtimeOwnerFixture(t),a=await f.approve();assert.equal((await f.call('run',a)).payload.outcome,'stored');
  const s=f.fake.states.get(ID),r=s.shopifyTokenExchanges.at(-1),c=s.connections[0];
  if(kind==='receipt-missing')s.shopifyTokenExchanges.pop();if(kind==='missing-field')delete r.storedCiphertextDigest;if(kind==='extra-field')r.unreviewed=true;
  if(kind==='operation')r.operation='initial/v1';if(kind==='previous')r.replacesRequestId=randomUUID();if(kind==='owner')r.actorId='other';if(kind==='session')r.sessionVersion++;
  if(kind==='scopes')r.returnedScopes=['read_products'];if(kind==='binding')r.binding.appId='wrong';if(kind==='prior-digest')r.binding.previousReceiptDigest='0'.repeat(64);
  if(kind==='old-ciphertext')r.binding.ciphertextDigest='0'.repeat(64);if(kind==='saved-digest')r.storedCiphertextDigest='0'.repeat(64);
  if(kind==='changed-saved-value')c.encryptedCredentials=c.encryptedCredentials.slice(0,-1)+(c.encryptedCredentials.endsWith('A')?'B':'A');
  if(kind==='settings')s.connectionSettings.shopify.extra='different';if(kind==='timestamp')r.storedAt='invalid';if(kind==='expiry')r.tokenExpiresAt+=86400000;
  if(kind==='prior-record')s.shopifyTokenExchanges[0].actorId='other';if(kind==='duplicate-receipt')s.shopifyTokenExchanges.push(structuredClone(r));
  const status=await f.call('status');assert.equal(status.status,200);assert.equal(status.payload.outcome,'uncertain');assert.equal(status.payload.terminal,false);assert.equal(status.payload.canRun,false);assert.equal(status.payload.canReview,false);
  assert.doesNotMatch(JSON.stringify(status.payload),secretPattern);assert.equal(f.issued.length,1);
});
test('strict completion permits receipt key order changes, returns no private digests',async t=>{
  const f=await runtimeOwnerFixture(t),a=await f.approve();await f.call('run',a);const s=f.fake.states.get(ID),r=s.shopifyTokenExchanges.at(-1);s.shopifyTokenExchanges[s.shopifyTokenExchanges.length-1]=Object.fromEntries(Object.entries(r).reverse());
  const status=(await f.call('status')).payload;assert.equal(status.outcome,'stored');assert.equal(status.terminal,true);assert.doesNotMatch(JSON.stringify(status),/Digest|ciphertext|encryptedCredentials/);
});
test('unused confirmed closure is terminal; claimed uncertain closure is not',async t=>{
  const f=await runtimeOwnerFixture(t),a=await f.approve();const closed=await f.call('close',a);assert.equal(closed.payload.outcome,'closed');assert.equal(closed.payload.terminal,true);
  const g=await runtimeOwnerFixture(t,{issuer:()=>{throw Error('Synthetic lost issuer response');}}),b=await g.approve();await g.call('run',b);const s=(await g.call('status')).payload;
  const unknown=await g.call('close',{requestId:b.requestId,expectedRevision:s.expectedRevision});assert.equal(unknown.payload.outcome,'uncertain');assert.equal(unknown.payload.terminal,false);assert.equal(unknown.payload.canClose,false);assert.equal(unknown.payload.canReview,false);assert.equal(g.issued.length,1);
});

test('retained completion needs an exact bounded successor chain to current ciphertext',async t=>{
  const f=await runtimeOwnerFixture(t),a=await f.approve();await f.call('run',a);const s=structuredClone(f.fake.states.get(ID)),r=s.shopifyRenewalApprovals[0],old=s.shopifyTokenExchanges.at(-1);
  const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex'),id=randomUUID(),time=old.tokenExpiresAt+1000,iso=n=>new Date(n).toISOString();
  // A complete synthetic retained successor fixture, without a second issuer.
  const next={...r,id,previousRequestId:r.id,previousReceiptDigest:runtimeRenewalDigest(old),previousCiphertextDigest:old.storedCiphertextDigest,reviewIssuedAt:iso(time),approvedAt:iso(time),claimedAt:iso(time),expiresAt:iso(time+300000)};
  const ciphertext=s.connections[0].encryptedCredentials+'A',receipt={...old,requestId:id,replacesRequestId:r.id,startedAt:iso(time),storedAt:iso(time+1),expiresAt:next.expiresAt,tokenExpiresAt:time+86399000,
    storedCiphertextDigest:hash(ciphertext),binding:{...old.binding,ciphertextDigest:old.storedCiphertextDigest,previousReceiptDigest:hash(old)}};
  s.shopifyRenewalApprovals.push(next);s.shopifyTokenExchanges.push(receipt);s.connections[0].encryptedCredentials=ciphertext;s.connections[0].updatedAt=receipt.storedAt;
  assert.equal(runtimeRenewalCompletion(s,r),'stored');assert.equal(runtimeRenewalCompletion(s,next),'stored');
  receipt.binding.ciphertextDigest='0'.repeat(64);assert.equal(runtimeRenewalCompletion(s,r),'uncertain');assert.equal(f.issued.length,1);
});
