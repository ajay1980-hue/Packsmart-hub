import crypto from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import { createCataloguePolicy } from './shopify-catalogue-import.mjs';
import { assertQuietOwnerWorkspace } from './quiet-owner-workspace.mjs';
import { encryptCredentials, decryptCredentials } from './security.mjs';
import { addAudit } from './events.mjs';
import { classifyShopifyCredential } from './shopify-credential-metadata.mjs';

// Reuses the existing connection refresh URL, but never its broad test/sync flow.
export const SHOPIFY_TOKEN_PATH = '/api/connections/shopify/refresh';
export const TOKEN_DESTINATION = 'https://wavtzm-vy.myshopify.com/admin/oauth/access_token';
const WORKSPACE='packsmart-solutions', DOMAIN='wavtzm-vy.myshopify.com', VERSION='2026-07';
const SCHEMA='runvara-shopify-token-exchange/v1', MAX_BODY=16384;
const APP_ID='gid://shopify/App/408091000833', INSTALLATION_ID='gid://shopify/AppInstallation/1161754673486';
const INSTALLED_SCOPES=Object.freeze(['read_inventory','read_orders','read_products']);
// Pins the public identifier to the independently verified installed app, without
// exposing the configured identifier through a policy/status serialization.
const INSTALLED_CLIENT_DIGEST='6096a6b621bb718f415290470a95dc63b912b355cf0042e0017230f652346a49';
const policyBindings=new WeakMap();
const uuid=v=>typeof v==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const digest=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const permits=new WeakMap();
const fail=(code,status=409)=>Object.assign(new Error('Shopify credential exchange stopped. Reconcile before another attempt.'),{code:'SHOPIFY_TOKEN_'+code,status});
const safeSecret=v=>typeof v==='string' && v.length>=16 && v.length<=512 && !/\s/.test(v);
export function parseTokenScopes(value) {
  if(typeof value!=='string' || value.length>4096) throw fail('SCOPES_INVALID');
  const scopes=value.split(',').map(s=>s.trim());
  if(!scopes.length || scopes.length>100 || scopes.some(s=>!/^((read|write)_[a-z0-9_]+|unauthenticated_[a-z0-9_]+)$/.test(s))
    || new Set(scopes).size!==scopes.length) throw fail('SCOPES_INVALID');
  return scopes.sort();
}
export function createShopifyTokenPolicy(env) {
  const flag=env.RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE === undefined ? 'disabled/v1' : env.RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE;
  if(!['disabled/v1','enabled/v1'].includes(flag)) throw fail('CONFIG_INVALID',503);
  if(flag==='disabled/v1') return null;
  // Use the already tested absolute + monotonic deadline and backward-clock latch.
  const timer=createCataloguePolicy({...env,RUNVARA_QUIET_SHOPIFY_CATALOGUE:flag,
    RUNVARA_SHOPIFY_CATALOGUE_REQUEST_ID:env.RUNVARA_SHOPIFY_TOKEN_REQUEST_ID,
    RUNVARA_SHOPIFY_CATALOGUE_EXPIRES_AT:env.RUNVARA_SHOPIFY_TOKEN_EXPIRES_AT});
  const scopes=parseTokenScopes(env.RUNVARA_SHOPIFY_TOKEN_EXPECTED_SCOPES);
  if(!same(scopes,INSTALLED_SCOPES)) throw fail('SCOPES_INVALID',503);
  const clientId=env.RUNVARA_SHOPIFY_TOKEN_EXPECTED_CLIENT_ID;
  if(typeof clientId!=='string' || !/^[a-f0-9]{32}$/.test(clientId) || digest(clientId)!==INSTALLED_CLIENT_DIGEST) throw fail('APP_BINDING_INVALID',503);
  if(env.RUNVARA_QUIET_SHOPIFY_CATALOGUE==='enabled/v1') throw fail('MIXED_CAPABILITIES',503);
  // An existing initial-setup permit never authorizes replacing saved access.
  const operation=env.RUNVARA_SHOPIFY_TOKEN_OPERATION ?? 'initial/v1';
  const previousRequestId=env.RUNVARA_SHOPIFY_TOKEN_PREVIOUS_REQUEST_ID ?? null;
  if(!['initial/v1','renew_expired/v1'].includes(operation)
    || (operation==='initial/v1' ? previousRequestId!==null : !uuid(previousRequestId)||previousRequestId===timer.requestId)) throw fail('OPERATION_INVALID',503);
  const policy=Object.freeze({...timer,scopes:Object.freeze(scopes),operation,previousRequestId});
  policyBindings.set(policy,{clientId,match:'unverified'});
  return policy;
}
function actor(state,session) {
  assertQuietOwnerWorkspace({state,session});
  if(state.users.find(u=>u.id===session.sub)?.active!==true || !uuid(state._revision)
    || !Number.isFinite(session.exp) || session.exp*1000<=Date.now()) throw fail('OWNER_SESSION_REQUIRED',401);
}
function binding(state,integrations,env,policy) {
  const rows=state.connections?.filter(c=>c.provider==='shopify') || [], c=rows[0];
  if(rows.length!==1 || typeof c?.id!=='string' || !c.id || state.connections.filter(row=>row.id===c.id).length!==1 || !c.encryptedCredentials || c.metadata?.shopDomain!==DOMAIN
    || state.connectionSettings?.shopify?.disconnected) throw fail('BINDING_INVALID');
  let credentials,config;
  try { credentials=decryptCredentials(c.encryptedCredentials,env.CREDENTIALS_KEY); config=integrations.shopifyConfig(state); }
  catch { throw fail('CREDENTIAL_UNAVAILABLE'); }
  const approved=policyBindings.get(policy);
  if(!approved || approved.match==='not_matched' || credentials?.clientId!==approved.clientId || config?.clientId!==approved.clientId) {
    if(approved)approved.match='not_matched';
    throw fail('APP_BINDING_MISMATCH');
  }
  approved.match='matched';
  if(!credentials || Array.isArray(credentials) || credentials.storeDomain!==DOMAIN
    || typeof credentials.clientId!=='string' || !/^[A-Za-z0-9_-]{8,200}$/.test(credentials.clientId) || !safeSecret(credentials.clientSecret)) throw fail('CREDENTIAL_SHAPE_INVALID');
  if(policy.operation==='renew_expired/v1') validateExpiredGrant(state,c,credentials,policy);
  else if(!same(Object.keys(credentials).sort(),['clientId','clientSecret','storeDomain'])) throw fail('CREDENTIAL_SHAPE_INVALID');
  if(config.connection?.id!==c.id || config.workspaceId!==WORKSPACE || config.domain!==DOMAIN || config.apiVersion!==VERSION
    || config.clientId!==credentials.clientId || config.clientSecret!==credentials.clientSecret
    || (policy.operation==='renew_expired/v1' ? config.accessToken!==credentials.accessToken||config.mode!=='client_credentials' : config.accessToken)) throw fail('CONFIG_MISMATCH');
  return {credentials,connection:c,binding:{connectionId:c.id,domain:DOMAIN,apiVersion:VERSION,appId:APP_ID,installationId:INSTALLATION_ID,
    ciphertextDigest:digest(c.encryptedCredentials),settingsDigest:digest(state.connectionSettings?.shopify || {}),
    ...(policy.operation==='renew_expired/v1'?{previousReceiptDigest:digest(ledger(state).find(r=>r.requestId===policy.previousRequestId))}: {})}};
}
function validateExpiredGrant(state,connection,credentials,policy) {
  const now=Date.now(), metadata=classifyShopifyCredential(credentials,now);
  if(metadata.credentialType!=='client_credentials'||metadata.expiryState!=='expired'||credentials.expiresAt>=now
    || !same([...credentials.scopes].sort(),policy.scopes)||credentials.tokenExchangeRequestId!==policy.previousRequestId) throw fail('EXPIRED_GRANT_REQUIRED');
  const prior=ledger(state).filter(r=>r.status==='stored').at(-1);
  const initialReceipt=prior&&!Object.hasOwn(prior,'operation');
  const time=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(Date.parse(x)).toISOString()===x;
  // Legacy initial receipts did not store the output-ciphertext digest. Their
  // protected receipt/connection metadata must agree; new receipts additionally
  // bind exact ciphertext. Neither form claims provider validity of old access.
  if(!prior||prior.requestId!==policy.previousRequestId||prior.schema!==SCHEMA
    || (!initialReceipt&&prior.operation!=='renew_expired/v1')
    // Initial receipts may have an output hash, but never renewal-only links.
    || (initialReceipt&&(Object.hasOwn(prior,'replacesRequestId')||Object.hasOwn(prior.binding||{},'previousReceiptDigest')))
    || (prior.operation==='renew_expired/v1'&&(!uuid(prior.replacesRequestId)||prior.replacesRequestId===prior.requestId||!Object.hasOwn(prior,'storedCiphertextDigest')))
    || !same(prior.approvedScopes,policy.scopes)||!same(prior.returnedScopes,policy.scopes)
    || prior.tokenExpiresAt!==credentials.expiresAt||connection.updatedAt!==prior.storedAt
    || ![prior.startedAt,prior.storedAt,prior.expiresAt].every(time)
    || Date.parse(prior.startedAt)>credentials.issuedAt||credentials.issuedAt>Date.parse(prior.storedAt)
    || Date.parse(prior.storedAt)>=credentials.expiresAt||Date.parse(prior.storedAt)>Date.parse(prior.expiresAt)
    || Date.parse(prior.expiresAt)>Date.parse(prior.startedAt)+600000
    || typeof prior.actorId!=='string'||!prior.actorId||!Number.isSafeInteger(prior.sessionVersion)||prior.sessionVersion<1
    || prior.binding?.connectionId!==connection.id||prior.binding?.domain!==DOMAIN||prior.binding?.apiVersion!==VERSION
    || prior.binding?.appId!==APP_ID||prior.binding?.installationId!==INSTALLATION_ID
    || !/^[a-f0-9]{64}$/.test(prior.binding?.ciphertextDigest||'')
    || prior.binding?.settingsDigest!==digest(state.connectionSettings?.shopify||{})
    || (Object.hasOwn(prior,'storedCiphertextDigest')&&prior.storedCiphertextDigest!==digest(connection.encryptedCredentials))) throw fail('PRIOR_RECEIPT_MISMATCH');
}
function ledger(state) {
  const rows=state.shopifyTokenExchanges ?? [];
  if(!Array.isArray(rows) || rows.length>20 || new Set(rows.map(r=>r.requestId)).size!==rows.length
    || rows.some(r=>r.schema!==SCHEMA || !uuid(r.requestId) || !['reserved','stored'].includes(r.status))) throw fail('LEDGER_INVALID');
  return rows;
}
export function shopifyTokenStatus(state,policy,uncertain=false) {
  const rows=ledger(state),run=policy ? rows.find(r=>r.requestId===policy.requestId) : null;
  const priorUnresolved=rows.some(r=>r.status==='reserved' && r.requestId!==policy?.requestId);
  const appMatch=policyBindings.get(policy)?.match || 'unverified';
  const canRun=Boolean(policy?.available() && !run && !priorUnresolved && !uncertain && appMatch!=='not_matched');
  return {schema:SCHEMA,enabled:Boolean(policy?.available()),requestId:policy?.requestId || null,expiresAt:policy?.expiresAt || null,
    canRun,expectedRevision:canRun ? state._revision : null,
    // Never return the stored binding, ciphertext, provider payload, or arbitrary error strings.
    outcome:run?.status==='stored'?'stored':run?'reserved_reconcile_no_replay':priorUnresolved?'prior_request_unresolved':uncertain?'commit_unconfirmed':'not_started',
    domain:DOMAIN,appId:APP_ID,appMatch,approvedScopes:policy ? [...policy.scopes] : [],importEnabled:false,
    operation:policy?.operation||'initial/v1',previousRequestId:policy?.previousRequestId||null};
}
function issuePermit(before,after,connectionId,phase) {
  const restored=structuredClone(after);
  restored.audit=structuredClone(before.audit);
  if(Object.hasOwn(before,'shopifyTokenExchanges')) restored.shopifyTokenExchanges=structuredClone(before.shopifyTokenExchanges);
  else delete restored.shopifyTokenExchanges;
  if(phase==='stored') {
    const old=before.connections.find(c=>c.id===connectionId), current=after.connections.find(c=>c.id===connectionId);
    if(!old || !current || !/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/.test(current.encryptedCredentials || '')) throw fail('DELTA_INVALID');
    const copy=structuredClone(current); copy.encryptedCredentials=old.encryptedCredentials;
    if(Object.hasOwn(old,'updatedAt')) copy.updatedAt=old.updatedAt; else delete copy.updatedAt;
    if(!same(copy,old)) throw fail('DELTA_INVALID');
    restored.connections=after.connections.map(c=>c.id===connectionId?structuredClone(old):structuredClone(c));
  }
  if(!same(restored,before) || after.audit.length!==before.audit.length+1 || !same(after.audit.slice(1),before.audit)) throw fail('DELTA_INVALID');
  const permit=Object.freeze({}); permits.set(permit,{workspaceId:WORKSPACE,revision:before._revision,digest:digest(after)}); return permit;
}
export function assertShopifyTokenPermit(permit,workspaceId,state) {
  const expected=permits.get(permit); permits.delete(permit);
  if(!expected || workspaceId!==expected.workspaceId || state._revision!==expected.revision || digest(state)!==expected.digest) throw fail('PERSISTENCE_PERMIT_INVALID');
}
async function tokenResponse(response) {
  if(!response?.ok || response.redirected) throw fail('REQUEST_UNCONFIRMED',502);
  const reader=response.body?.getReader(); if(!reader) throw fail('RESPONSE_INVALID',502);
  let size=0; const chunks=[];
  try { for(;;) { const {done,value}=await reader.read(); if(done) break; size+=value.byteLength;
    if(size>MAX_BODY) throw fail('RESPONSE_INVALID',502); chunks.push(Buffer.from(value)); } }
  finally { await reader.cancel().catch(()=>{}); }
  let payload; try { payload=JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('RESPONSE_INVALID',502); }
  if(!payload || Array.isArray(payload) || !safeSecret(payload.access_token) || !Number.isSafeInteger(payload.expires_in)
    || payload.expires_in!==86399 || Object.hasOwn(payload,'refresh_token')) throw fail('RESPONSE_INVALID',502);
  return {accessToken:payload.access_token,scopes:parseTokenScopes(payload.scope),lifetimeSeconds:payload.expires_in};
}
export function createShopifyTokenExchange({store,integrations,env,policy,fetchImpl}) {
  const uncertain=new Set();
  const status=state=>shopifyTokenStatus(state,policy,uncertain.has(policy?.requestId));
  async function run(auth,body,assertOpen=()=>{}) {
    if(!policy || store.provider!=='supabase') throw fail('DISABLED',503);
    actor(auth.state,auth.session);
    if(!body || Array.isArray(body) || !same(Object.keys(body).sort(),['expectedRevision','requestId'])
      || body.requestId!==policy.requestId || body.expectedRevision!==auth.state._revision) throw fail('INPUT_STALE');
    const assertActive=()=>{policy.assertActive();assertOpen();if(auth.session.exp*1000<=Date.now())throw fail('OWNER_SESSION_REQUIRED',401);};
    assertActive(); const old=ledger(auth.state);
    if(old.some(r=>r.requestId===policy.requestId)) return status(auth.state);
    if(old.some(r=>r.status==='reserved')) throw fail('PRIOR_REQUEST_UNRESOLVED');
    if(uncertain.has(policy.requestId)) throw fail('COMMIT_UNCERTAIN',503);
    if(old.length>=20) throw fail('LEDGER_FULL');
    const source=binding(auth.state,integrations,env,policy), before=structuredClone(auth.state), claimed=structuredClone(before);
    const record={schema:SCHEMA,requestId:policy.requestId,status:'reserved',actorId:auth.session.sub,sessionVersion:auth.session.sessionVersion,
      binding:source.binding,approvedScopes:[...policy.scopes],startedAt:new Date().toISOString(),expiresAt:policy.expiresAt,
      ...(policy.operation==='renew_expired/v1'?{operation:policy.operation,replacesRequestId:policy.previousRequestId}:{})};
    claimed.shopifyTokenExchanges=[...old,record];
    addAudit(claimed,{type:'shopify_token_exchange_reserved',actor:auth.session.sub,detail:{requestId:policy.requestId,domain:DOMAIN,approvedScopes:[...policy.scopes]}});
    async function save(from,to,phase) {
      const permit=issuePermit(from,to,source.connection.id,phase);
      try { return await store.save(WORKSPACE,to,{ownedSnapshot:true,shopifyTokenPermit:permit,beforeCommit:assertActive}); }
      catch { uncertain.add(policy.requestId); throw fail('COMMIT_UNCERTAIN',503); }
    }
    let current=await save(before,claimed,'reserved'); const revision=current._revision;
    const fresh=async()=>{
      assertActive(); const next=await store.get(WORKSPACE,{exactSnapshot:true}); actor(next,auth.session);
      if(next._revision!==revision || !same(binding(next,integrations,env,policy).binding,source.binding)
        || !same(ledger(next).find(r=>r.requestId===policy.requestId),record)) throw fail('STATE_CHANGED');
      assertActive(); return next;
    };
    // Durable reservation must be acknowledged before any transmission. Any
    // failure leaves it spent across processes/restarts; never retry this grant.
    await fresh(); const sentAt=Date.now(); let result;
    try {
      const response=await fetchImpl(TOKEN_DESTINATION,{method:'POST',redirect:'error',
        headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({grant_type:'client_credentials',client_id:source.credentials.clientId,client_secret:source.credentials.clientSecret}).toString(),
        signal:AbortSignal.timeout(20000)});
      result=await tokenResponse(response);
    } catch { throw fail('REQUEST_UNCONFIRMED',502); }
    if(!same(result.scopes,policy.scopes)) throw fail('SCOPES_MISMATCH',502);
    current=await fresh();
    const expiresAt=sentAt+result.lifetimeSeconds*1000; // conservative: no network-latency extension
    if(expiresAt<=Date.now()+60000) throw fail('TOKEN_EXPIRED',502);
    const next=structuredClone(current), c=next.connections.find(c=>c.id===source.connection.id);
    c.encryptedCredentials=encryptCredentials({...source.credentials,mode:'client_credentials',accessToken:result.accessToken,
      issuedAt:sentAt,expiresAt,scopes:result.scopes,tokenExchangeRequestId:policy.requestId},env.CREDENTIALS_KEY);
    c.updatedAt=new Date().toISOString();
    next.shopifyTokenExchanges=next.shopifyTokenExchanges.map(r=>r.requestId===policy.requestId
      ? {...r,status:'stored',storedAt:c.updatedAt,tokenExpiresAt:expiresAt,returnedScopes:result.scopes,storedCiphertextDigest:digest(c.encryptedCredentials)}:r);
    addAudit(next,{type:'shopify_token_exchange_stored',actor:auth.session.sub,detail:{requestId:policy.requestId,domain:DOMAIN,scopes:result.scopes,expiresAt}});
    result=undefined;
    const saved=await save(current,next,'stored');
    return status(saved);
  }
  return Object.freeze({run,status});
}
