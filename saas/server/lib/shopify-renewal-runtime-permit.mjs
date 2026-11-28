// Private, unmounted renewal contract. No credentials, provider transport or
// environment editing. Persistence uses the existing primary workspace CAS.
import {randomUUID,createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import {assertQuietOwnerWorkspace} from './quiet-owner-workspace.mjs';
import {addAudit} from './events.mjs';

export const RUNTIME_RENEWAL_LEDGER='shopifyRenewalApprovals';
export const RUNTIME_RENEWAL_WORKSPACE='packsmart-solutions';
export const RUNTIME_RENEWAL_CONNECTION='conn_d3e0af94-fd74-4791-aed2-59b2f9ddd2e8';
export const RUNTIME_RENEWAL_DOMAIN='wavtzm-vy.myshopify.com';
export const RUNTIME_RENEWAL_SCOPES=Object.freeze(['read_inventory','read_orders','read_products']);
export const RUNTIME_RENEWAL_CONFIRMATION='Approve one existing-connection renewal; no import or order reads.';
export const RUNTIME_RENEWAL_TERMS='shopify-expired-renewal-terms/v1';
const SCHEMA='runvara-shopify-runtime-renewal/v2';
const permits=new WeakMap();
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
export const runtimeRenewalDigest=x=>hash(canonical(x));
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&same(Object.keys(x).sort(),[...keys].sort());
const timestamp=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(Date.parse(x)).toISOString()===x;
export const runtimeRenewalError=(code='REFUSED')=>Object.assign(Error('Renewal permission unavailable; reconcile without retry.'),{code:'SHOPIFY_RUNTIME_'+code,status:409});
const fail=()=>{throw runtimeRenewalError();};
export function assertRuntimeRenewalIdentity(auth,now=Date.now()) {
  const s=auth?.session;
  if(s?.role!=='owner'||s.workspaceId!==RUNTIME_RENEWAL_WORKSPACE||typeof s.sub!=='string'||!s.sub||!Number.isSafeInteger(s.sessionVersion)||s.sessionVersion<1||!Number.isSafeInteger(s.exp)||s.exp*1000<=now||!Number.isSafeInteger(now))fail();
  assertQuietOwnerWorkspace(auth,{inspectEvidence:false});
  const owners=auth.state.users.filter(x=>x.role==='owner'&&x.active===true);
  if(owners.length!==1||owners[0].id!==s.sub||owners[0].sessionVersion!==s.sessionVersion)fail();
}
export function assertRuntimeRenewalOwner(auth,now=Date.now()) {
  assertRuntimeRenewalIdentity(auth,now);assertQuietOwnerWorkspace(auth);
  const {session,state}=auth;
  if(session.role!=='owner'||!Number.isSafeInteger(session.exp)||session.exp*1000<=now||!Number.isSafeInteger(now)
    ||!uuid(state._revision)||!Array.isArray(state.audit)||state.users.find(x=>x.id===session.sub)?.active!==true)fail();
}
function rows(state) {
  const list=state[RUNTIME_RENEWAL_LEDGER]??[];
  if(!Array.isArray(list)||list.length>20||new Set(list.map(x=>x.id)).size!==list.length)fail();
  const base=['schema','id','status','ownerId','sessionHash','workspaceId','connectionId','domain','action','scopes','previousRequestId','sourceRevision','approvedRevision','approvedAt','expiresAt','reviewIssuedAt','termsVersion','approvedSessionVersion','previousReceiptDigest','previousCiphertextDigest','settingsDigest'];
  for(const r of list) {
    const extra=r.status==='approved'?[]:r.status==='claimed'?['claimedAt','claimRevision']:r.status==='closed'?['closedAt',...(Object.hasOwn(r,'claimedAt')?['claimedAt','claimRevision']:[])]:null;
    if(!extra||!exact(r,[...base,...extra])||r.schema!==SCHEMA||!uuid(r.id)||!uuid(r.sourceRevision)||!uuid(r.approvedRevision)||!uuid(r.previousRequestId)
      ||r.workspaceId!==RUNTIME_RENEWAL_WORKSPACE||r.connectionId!==RUNTIME_RENEWAL_CONNECTION||r.domain!==RUNTIME_RENEWAL_DOMAIN||r.action!=='renew_expired/v1'
      ||!same(r.scopes,RUNTIME_RENEWAL_SCOPES)||typeof r.ownerId!=='string'||!r.ownerId||!/^[a-f0-9]{64}$/.test(r.sessionHash)||!timestamp(r.approvedAt)
      ||!timestamp(r.reviewIssuedAt)||Date.parse(r.reviewIssuedAt)>Date.parse(r.approvedAt)||r.termsVersion!==RUNTIME_RENEWAL_TERMS||!Number.isSafeInteger(r.approvedSessionVersion)||r.approvedSessionVersion<1
      ||!['previousReceiptDigest','previousCiphertextDigest','settingsDigest'].every(k=>/^[a-f0-9]{64}$/.test(r[k]??''))
      ||!timestamp(r.expiresAt)||Date.parse(r.expiresAt)<=Date.parse(r.approvedAt)||Date.parse(r.expiresAt)>Date.parse(r.reviewIssuedAt)+300000
      ||(Object.hasOwn(r,'claimedAt')&&(!uuid(r.claimRevision)||!timestamp(r.claimedAt)||Date.parse(r.claimedAt)<Date.parse(r.approvedAt)||Date.parse(r.claimedAt)>=Date.parse(r.expiresAt)))
      ||(r.status==='closed'&&(!timestamp(r.closedAt)||Date.parse(r.closedAt)<Date.parse(r.claimedAt??r.approvedAt))))fail();
  }
  return list;
}
function source(state,now) {
  const connections=(state.connections??[]).filter(c=>c.provider==='shopify'),c=connections[0],ledger=state.shopifyTokenExchanges;
  if(connections.length!==1||c.id!==RUNTIME_RENEWAL_CONNECTION||state.connections.filter(x=>x.id===c.id).length!==1
    ||c.metadata?.shopDomain!==RUNTIME_RENEWAL_DOMAIN||state.connectionSettings?.shopify?.disconnected
    ||!Array.isArray(ledger)||ledger.length>=20||new Set(ledger.map(x=>x.requestId)).size!==ledger.length||ledger.some(x=>x.status!=='stored'))fail();
  const r=ledger.at(-1);
  if(!r||!uuid(r.requestId)||r.schema!=='runvara-shopify-token-exchange/v1'||r.binding?.connectionId!==c.id||r.binding?.domain!==RUNTIME_RENEWAL_DOMAIN
    ||r.binding?.appId!=='gid://shopify/App/408091000833'||r.binding?.installationId!=='gid://shopify/AppInstallation/1161754673486'
    ||r.binding?.apiVersion!=='2026-07'||!same(r.approvedScopes,RUNTIME_RENEWAL_SCOPES)||!same(r.returnedScopes,RUNTIME_RENEWAL_SCOPES)
    ||!Number.isSafeInteger(r.tokenExpiresAt)||r.tokenExpiresAt>=now||c.updatedAt!==r.storedAt)fail();
  return r;
}
// A stored label alone is never proof of completion. Compare the exact renewal
// receipt, its prior evidence and the currently saved ciphertext privately.
export function runtimeRenewalCompletion(state,r,visited=new Set()) {
  if(!r||visited.has(r.id)||visited.size>=20)return 'uncertain';visited=new Set([...visited,r.id]);
  const ledger=state.shopifyTokenExchanges;
  if(!Array.isArray(ledger)||ledger.length>20||new Set(ledger.map(x=>x?.requestId)).size!==ledger.length)return 'uncertain';
  const matches=ledger.filter(x=>x?.requestId===r.id);
  if(!Object.hasOwn(r,'claimedAt'))return matches.length?'uncertain':r.status==='closed'?'closed_unused':'approved';
  if(matches.length!==1)return 'uncertain';
  const t=matches[0],prior=ledger.find(x=>x?.requestId===r.previousRequestId),connections=state.connections?.filter(x=>x.provider==='shopify')??[],c=connections[0];
  const keys=['schema','requestId','status','actorId','sessionVersion','binding','approvedScopes','startedAt','expiresAt','operation','replacesRequestId','storedAt','tokenExpiresAt','returnedScopes','storedCiphertextDigest'];
  if(!exact(t,keys)||t.schema!=='runvara-shopify-token-exchange/v1'||t.status!=='stored'||t.operation!=='renew_expired/v1'||t.replacesRequestId!==r.previousRequestId
    ||t.actorId!==r.ownerId||t.sessionVersion!==r.approvedSessionVersion||!same(t.approvedScopes,r.scopes)||!same(t.returnedScopes,r.scopes)
    ||!prior||runtimeRenewalDigest(prior)!==r.previousReceiptDigest||connections.length!==1||c?.id!==r.connectionId||state.connections.filter(x=>x.id===c.id).length!==1
    ||c.metadata?.shopDomain!==r.domain||state.connectionSettings?.shopify?.disconnected||typeof c.encryptedCredentials!=='string'||!/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/.test(c.encryptedCredentials)
    ||!exact(t.binding,['connectionId','domain','apiVersion','appId','installationId','ciphertextDigest','settingsDigest','previousReceiptDigest'])
    ||t.binding.connectionId!==r.connectionId||t.binding.domain!==r.domain||t.binding.apiVersion!=='2026-07'||t.binding.appId!=='gid://shopify/App/408091000833'||t.binding.installationId!=='gid://shopify/AppInstallation/1161754673486'
    ||t.binding.ciphertextDigest!==r.previousCiphertextDigest||t.binding.settingsDigest!==r.settingsDigest||t.binding.settingsDigest!==hash(state.connectionSettings?.shopify||{})||t.binding.previousReceiptDigest!==hash(prior)
    ||!/^[a-f0-9]{64}$/.test(t.storedCiphertextDigest??'')||![t.startedAt,t.storedAt,t.expiresAt].every(timestamp)||t.expiresAt!==r.expiresAt
    ||Date.parse(t.startedAt)<Date.parse(r.claimedAt)||Date.parse(t.storedAt)<Date.parse(t.startedAt)||Date.parse(t.storedAt)>Date.parse(t.expiresAt)
    ||!Number.isSafeInteger(t.tokenExpiresAt)||t.tokenExpiresAt-86399000<Date.parse(t.startedAt)||t.tokenExpiresAt-86399000>Date.parse(t.storedAt)||t.tokenExpiresAt<=Date.parse(t.storedAt))return 'uncertain';
  if(t.storedCiphertextDigest===hash(c.encryptedCredentials)&&c.updatedAt===t.storedAt)return 'stored';
  // Retained success is corroborated through an exact, bounded successor chain
  // to the current ciphertext; an old stored label alone is not enough.
  const next=ledger.filter(x=>x?.replacesRequestId===r.id),nextRecords=state[RUNTIME_RENEWAL_LEDGER]?.filter(x=>x.id===next[0]?.requestId)??[];
  return next.length===1&&nextRecords.length===1&&nextRecords[0].previousRequestId===r.id
    &&next[0].binding?.ciphertextDigest===t.storedCiphertextDigest&&nextRecords[0].previousCiphertextDigest===t.storedCiphertextDigest
    &&nextRecords[0].previousReceiptDigest===runtimeRenewalDigest(t)&&Date.parse(next[0].startedAt)>t.tokenExpiresAt
    &&runtimeRenewalCompletion(state,nextRecords[0],visited)==='stored'?'stored':'uncertain';
}
function unresolved(state,r) {return runtimeRenewalCompletion(state,r)==='uncertain';}
export function runtimeRenewalStatus(auth,now=Date.now()) {
  assertRuntimeRenewalOwner(auth,now);
  return rows(auth.state).map(r=>{const completed=runtimeRenewalCompletion(auth.state,r);return {requestId:r.id,status:r.status,expiresAt:r.expiresAt,
    outcome:completed==='stored'?'stored':completed==='uncertain'?'claimed_reconcile_no_replay':completed==='closed_unused'?'closed':Date.parse(r.expiresAt)<=now?'expired':'approved'};});
}
export function assertRuntimeRenewalReviewable(auth,now=Date.now()) {
  assertRuntimeRenewalOwner(auth,now);const prior=source(auth.state,now),list=rows(auth.state);
  if(list.length>=20||list.some(r=>r.status!=='closed'||unresolved(auth.state,r)))fail();
  return prior;
}
export function reviewRuntimeRenewal(auth,now=Date.now()) {
  const prior=assertRuntimeRenewalReviewable(auth,now);
  return Object.freeze({requestId:randomUUID(),expectedRevision:auth.state._revision,previousRequestId:prior.requestId,
    connectionId:RUNTIME_RENEWAL_CONNECTION,domain:RUNTIME_RENEWAL_DOMAIN,action:'renew_expired/v1',scopes:[...RUNTIME_RENEWAL_SCOPES],
    issuedAt:new Date(now).toISOString(),termsVersion:RUNTIME_RENEWAL_TERMS,expiresAt:new Date(Math.min(now+300000,auth.session.exp*1000)).toISOString(),confirmation:RUNTIME_RENEWAL_CONFIRMATION});
}
export function assertRuntimeRenewalClaim(auth,r,now=Date.now()) {
  assertRuntimeRenewalOwner(auth,now);
  if(!r||r.ownerId!==auth.session.sub||r.sessionHash!==hash(auth.session)||r.status!=='approved'||r.approvedRevision!==auth.state._revision
    ||Date.parse(r.approvedAt)>now||Date.parse(r.expiresAt)<=now||source(auth.state,now).requestId!==r.previousRequestId
    ||rows(auth.state).some(x=>unresolved(auth.state,x)))fail();
}
export function prepareRuntimeRenewalChange(auth,kind,body,now=Date.now()) {
  assertRuntimeRenewalOwner(auth,now);
  const before=auth.state,list=rows(before),after=structuredClone(before),nextRevision=randomUUID();let record;
  if(kind==='approve') {
    const prior=source(before,now),connection=before.connections.find(x=>x.id===RUNTIME_RENEWAL_CONNECTION);
    if(!exact(body,['requestId','expectedRevision','previousRequestId','connectionId','domain','action','scopes','expiresAt','confirmation','issuedAt','termsVersion'])||!uuid(body.requestId)
      ||body.expectedRevision!==before._revision||body.previousRequestId!==prior.requestId||body.requestId===prior.requestId
      ||body.connectionId!==RUNTIME_RENEWAL_CONNECTION||body.domain!==RUNTIME_RENEWAL_DOMAIN||body.action!=='renew_expired/v1'
      ||!same(body.scopes,RUNTIME_RENEWAL_SCOPES)||body.confirmation!==RUNTIME_RENEWAL_CONFIRMATION||body.termsVersion!==RUNTIME_RENEWAL_TERMS||!timestamp(body.issuedAt)||Date.parse(body.issuedAt)>now
      ||!Number.isFinite(Date.parse(body.expiresAt))||new Date(body.expiresAt).toISOString()!==body.expiresAt||Date.parse(body.expiresAt)<=now
      ||Date.parse(body.expiresAt)>Math.min(Date.parse(body.issuedAt)+300000,auth.session.exp*1000)||list.length>=20
      ||list.some(r=>r.id===body.requestId||r.status!=='closed'||unresolved(before,r))||before.shopifyTokenExchanges.some(r=>r.requestId===body.requestId))fail();
    record={schema:SCHEMA,id:body.requestId,status:'approved',ownerId:auth.session.sub,sessionHash:hash(auth.session),workspaceId:RUNTIME_RENEWAL_WORKSPACE,
      connectionId:RUNTIME_RENEWAL_CONNECTION,domain:RUNTIME_RENEWAL_DOMAIN,action:'renew_expired/v1',scopes:[...RUNTIME_RENEWAL_SCOPES],
      previousRequestId:prior.requestId,sourceRevision:before._revision,approvedRevision:nextRevision,approvedAt:new Date(now).toISOString(),expiresAt:body.expiresAt,
      reviewIssuedAt:body.issuedAt,termsVersion:body.termsVersion,approvedSessionVersion:auth.session.sessionVersion,previousReceiptDigest:runtimeRenewalDigest(prior),previousCiphertextDigest:hash(connection.encryptedCredentials),settingsDigest:hash(before.connectionSettings?.shopify||{})};
    after[RUNTIME_RENEWAL_LEDGER]=[...list,record];
  } else {
    if(!['claim','close'].includes(kind)||!exact(body,['requestId','expectedRevision'])||body.expectedRevision!==before._revision)fail();
    const r=list.find(x=>x.id===body.requestId);
    // A fresh login by the same strict owner may close an expired/old-session
    // grant. Only execution requires the exact approving session. Otherwise an
    // expired login could strand an unused durable grant forever.
    if(!r||r.ownerId!==auth.session.sub||r.status==='closed')fail();
    if(kind==='claim') {
      assertRuntimeRenewalClaim(auth,r,now);
      record={...r,status:'claimed',claimedAt:new Date(now).toISOString(),claimRevision:nextRevision};
    }else record={...r,status:'closed',closedAt:new Date(now).toISOString()};
    after[RUNTIME_RENEWAL_LEDGER]=list.map(x=>x.id===r.id?record:x);
  }
  addAudit(after,{type:'shopify_runtime_renewal_'+kind,actor:auth.session.sub,detail:{requestId:record.id,action:record.action,expiresAt:record.expiresAt}});
  const permit=Object.freeze({});permits.set(permit,{revision:before._revision,digest:hash(after),nextRevision,currentBytes:Buffer.byteLength(JSON.stringify(before))});
  return {state:after,permit,nextRevision,record};
}
export function assertShopifyRuntimeRenewalPermit(permit,workspaceId,state) {
  const p=permits.get(permit);permits.delete(permit);
  if(!p||workspaceId!==RUNTIME_RENEWAL_WORKSPACE||state._revision!==p.revision||hash(state)!==p.digest)throw runtimeRenewalError('PERSISTENCE_INVALID');
  return Object.freeze({currentBytes:p.currentBytes,nextRevision:p.nextRevision});
}
