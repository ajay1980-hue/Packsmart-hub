// Credential storage and disconnected quote preparation share guarded admission.
// Credential-entry mode cannot quote. No fetch default or real provider transport.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual as same} from 'node:util';
import {assertQuietOwnerWorkspace} from './quiet-owner-workspace.mjs';
import {addAudit} from './events.mjs';
import {decryptCredentials} from './security.mjs';
import {sealParcel2GoCredentials,captureParcel2GoToken} from './parcel2go-quote-foundation.mjs';
import {parcel2GoQuoteRequest,parcel2GoQuoteResponse} from './parcel2go-quote-schema.mjs';
import {metaBoundedBytes,metaStrictJson} from './meta-publication-bounded.mjs';
const WORKSPACE='packsmart-solutions', modes=['disabled/v1','offline-fixture/v2','credential-entry/v1'];
const TOKEN='https://sandbox.parcel2go.com/auth/connect/token', QUOTE='https://sandbox.parcel2go.com/api/quotes';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(v);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=code=>{throw Object.assign(new Error('Parcel2Go preparation stopped; reconcile before another attempt.'),{code:'PARCEL2GO_'+code,status:409});};
const policies=new WeakMap(),permits=new WeakMap();
function iso(v){if(typeof v!=='string'||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)fail('TIME_INVALID');return Date.parse(v);}
function actor(state,session,now){
  if(!id(session?.sub)||!Number.isSafeInteger(session?.sessionVersion)||session.sessionVersion<1
    ||!uuid(state?._revision)||!Number.isSafeInteger(session.exp)||session.exp*1000<=now)fail('OWNER_REQUIRED');
  try{assertQuietOwnerWorkspace({state,session},{inspectEvidence:false});}catch{fail('OWNER_REQUIRED');}
  const owners=state.users.filter(u=>u.id===session.sub);
  if(owners.length!==1||owners[0].active!==true||owners[0].sessionVersion!==session.sessionVersion)fail('OWNER_REQUIRED');
}
function issue(before,after){
  if(before._revision!==after._revision)fail('STATE_CHANGED');
  for(const k of new Set([...Object.keys(before),...Object.keys(after)]))
    if(!['connections','parcel2goSandboxRuns','audit'].includes(k)&&!same(before[k],after[k]))fail('PERSISTENCE_INVALID');
  const p=Object.freeze({});permits.set(p,{workspaceId:WORKSPACE,revision:after._revision,afterHash:hash(after),currentBytes:Buffer.byteLength(JSON.stringify(before))});return p;
}
export function assertParcel2GoPersistencePermit(p,workspaceId,state){
  const v=permits.get(p);permits.delete(p);
  if(!v||v.workspaceId!==workspaceId||state._revision!==v.revision||hash(state)!==v.afterHash)fail('PERSISTENCE_INVALID');
  return Object.freeze({currentBytes:v.currentBytes});
}
export function createParcel2GoSandboxPolicy(config={}, {now=Date.now,monotonic=()=>performance.now()}={}){
  const mode=config.mode??'disabled/v1';if(!modes.includes(mode))fail('DISABLED');if(mode==='disabled/v1')return null;
  const c=structuredClone(config), b=c.binding;
  if(mode==='credential-entry/v1'&&c.operation!=='admit_credentials')fail('CONFIG_INVALID');
  if(c.startupMode!=='quiet'||!['admit_credentials','quote'].includes(c.operation)||!uuid(c.requestId)||!uuid(c.expectedRevision)
    ||b?.workspaceId!==WORKSPACE||b.environment!=='sandbox'||!id(b.connectionId)||!id(b.accountId)
    ||typeof c.expectedClientId!=='string'||c.expectedClientId.length<8||c.expectedClientId.length>4096
    ||!id(c.termsReference))fail('CONFIG_INVALID');
  const opened=iso(c.openedAt),expiry=iso(c.expiresAt),initial=now(),mono=monotonic();
  if(!Number.isSafeInteger(initial)||opened>initial||(expiry<=initial&&mode!=='credential-entry/v1')||expiry-opened>300000||expiry<=opened||!Number.isFinite(mono))fail('TIME_INVALID');
  if(c.operation==='quote'&&(!/^[a-f0-9]{64}$/.test(c.inputHash||'')
    ||!['Individual','NotRegistered','Registered'].includes(c.collectionVatStatus)
    ||!['Individual','NotRegistered','Registered'].includes(c.deliveryVatStatus)||c.accountCurrency!=='GBP'))fail('CONFIG_INVALID');
  let last=initial,lastMono=mono,closed=expiry<=initial;
  const check=()=>{const t=now(),m=monotonic();
    if(!Number.isSafeInteger(t)||!Number.isFinite(m)||t<last||m<lastMono||t>=expiry||m-mono>=expiry-initial)closed=true;
    last=t;lastMono=m;if(closed)fail('EXPIRED');return t;};
  const remainingMs=()=>{try{const t=check();return Math.max(0,Math.floor(Math.min(expiry-t,expiry-initial-(lastMono-mono))));}catch{return 0;}};
  const p=Object.freeze({requestId:c.requestId,expiresAt:c.expiresAt,operation:c.operation,remainingMs,available:()=>remainingMs()>0});policies.set(p,{...c,check});return p;
}
function audit(state,p,status){
  addAudit(state,{type:'parcel2go_sandbox_'+status,actor:'owner',detail:{requestId:p.requestId,operation:p.operation,environment:'sandbox'}});
}
function connection(state,p){
  const rows=(state.connections||[]).filter(c=>c.provider==='parcel2go'||c.id===p.binding.connectionId);
  if(rows.length!==1)fail('BINDING_INVALID');const c=rows[0];
  if(c.provider!=='parcel2go'||c.id!==p.binding.connectionId||!uuid(c.metadata?.admissionRequestId)
    ||!same(c.metadata,{account:p.binding.accountId,environment:'sandbox',admissionRequestId:c.metadata.admissionRequestId})||typeof c.encryptedCredentials!=='string')fail('BINDING_INVALID');
  const receipts=(state.parcel2goSandboxRuns||[]).filter(r=>r.requestId===c.metadata.admissionRequestId);
  if(receipts.length!==1||receipts[0].operation!=='admit_credentials'||receipts[0].status!=='completed'
    ||receipts[0].connectionId!==c.id||receipts[0].accountId!==p.binding.accountId||receipts[0].environment!=='sandbox')fail('BINDING_INVALID');
  return c;
}
function credential(c,p,key){
  let value;try{value=decryptCredentials(c.encryptedCredentials,key);}catch{fail('CREDENTIALS_INVALID');}
  if(value?.schema!=='runvara-parcel2go-credentials/v1'||!same(value.binding,p.binding)
    ||value.credentials?.clientId!==p.expectedClientId||value.credentials?.token!==null
    ||typeof value.credentials?.clientSecret!=='string'||value.credentials.clientSecret.length<8)fail('BINDING_INVALID');
  return value.credentials;
}
export function createParcel2GoSandboxCandidate({policy=null,store,key,fixtureTransport,assertCurrent=()=>{}}={}){
  const p=policies.get(policy);let attempted=false;
  const check=()=>{const at=p.check();assertCurrent();return at;};
  const status=()=>Object.freeze({enabled:false,fixtureMode:Boolean(p),liveReady:false,credentialEntryAvailable:false,
    attempted,providerEnforcedReadOnlyScope:false,orders:false,payment:false,profile:false,labels:false,webhooks:false});
  async function run(args){
    if(!p||store?.provider!=='supabase')fail('DISABLED');check();
    if(attempted)fail('ATTEMPT_SPENT');attempted=true;
    // Caller must be a server-verified session, never user-provided role claims.
    const session=structuredClone(args?.session),csrf=args?.csrf;
    if(typeof session?.csrf!=='string'||session.csrf.length<16||csrf!==session.csrf)fail('CSRF_REQUIRED');
    if(typeof key!=='string'||key.length<32)fail('KEY_REQUIRED');
    const read=async()=>{check();const s=await store.get(WORKSPACE,{exactSnapshot:true});actor(s,session,check());return s;};
    let state=await read();
    const runs=state.parcel2goSandboxRuns??[];
    if(!Array.isArray(runs)||runs.length>=20||runs.some(r=>r.requestId===p.requestId||r.status==='reserved'))fail('ATTEMPT_SPENT');
    if(state._revision!==p.expectedRevision)fail('STATE_CHANGED');
    let sealed,wire;
    if(p.operation==='admit_credentials'){
      if((state.connections||[]).some(c=>c.provider==='parcel2go'||c.id===p.binding.connectionId))fail('CONNECTION_EXISTS');
      const value=structuredClone(args.credentials);
      if(value?.clientId!==p.expectedClientId||value?.token!==null)fail('BINDING_INVALID');
      const a={session,state:{workspace:state.workspace,users:state.users,_revision:state._revision}};
      sealed=sealParcel2GoCredentials({auth:a,trustedBinding:p.binding,value,key,now:check()});
    }else{
      if(typeof fixtureTransport!=='function'||hash(args.input)!==p.inputHash)fail('INPUT_INVALID');
      wire=parcel2GoQuoteRequest(args.input,p.binding,p.check(),p);
      if(wire.prepared.requestId!==p.requestId||wire.prepared.expectedRevision!==p.expectedRevision)fail('INPUT_INVALID');
      credential(connection(state,p),p,key);
    }
    const save=async(from,to)=>{
      const permit=issue(from,to);
      try{return await store.save(WORKSPACE,to,{ownedSnapshot:true,parcel2goPermit:permit,
        beforeEffects:snapshot=>actor(snapshot,session,check()),
        beforeCommit:snapshot=>actor(snapshot,session,check())});}catch{fail('SAVE_OUTCOME_UNKNOWN');}
    };
    const claim=structuredClone(state);
    claim.parcel2goSandboxRuns=[...runs,{requestId:p.requestId,operation:p.operation,connectionId:p.binding.connectionId,
      accountId:p.binding.accountId,environment:'sandbox',status:'reserved',openedAt:p.openedAt,expiresAt:p.expiresAt,termsReference:p.termsReference}];
    audit(claim,p,'reserved');state=await save(state,claim);
    const fresh=async()=>{const current=await read();if(!same(current,state))fail('STATE_CHANGED');return current;};
    await fresh();let projection;
    if(p.operation==='quote'){
      const creds=credential(connection(state,p),p,key),sentAt=new Date(p.check()).toISOString();
      const send=async(url,headers,body,maxBytes)=>{
        // Only these fixed sandbox operations exist. No fallback fetch, redirects,
        // retry, refresh token, payment/profile/order URL or provider error logging.
        try{return await metaBoundedBytes(signal=>{p.check();return fixtureTransport(url,{method:'POST',redirect:'error',headers,body,signal});},
          {maxBytes,mediaType:'application/json',timeoutMs:5000});}catch{fail('PROVIDER_OUTCOME_UNKNOWN');}
      };
      const raw=await send(TOKEN,{'Content-Type':'application/x-www-form-urlencoded'},new URLSearchParams({grant_type:'client_credentials',client_id:creds.clientId,client_secret:creds.clientSecret,scope:'public-api'}).toString(),16384);
      let token;try{token=captureParcel2GoToken(metaStrictJson(raw),{sentAt,receivedAt:new Date(p.check()).toISOString()});}catch{fail('TOKEN_INVALID');}
      await fresh();if(Date.parse(token.expiresAt)<=p.check())fail('TOKEN_EXPIRED');
      const quotes=await send(QUOTE,{'Content-Type':'application/json',Authorization:'Bearer '+token.accessToken},JSON.stringify(wire.body),262144);
      if(Date.parse(token.expiresAt)<=p.check())fail('TOKEN_EXPIRED');
      projection=parcel2GoQuoteResponse(quotes,{observedAt:new Date(p.check()).toISOString(),requestId:p.requestId});
    }
    await fresh();const final=structuredClone(state);
    if(sealed)final.connections=[...(final.connections||[]),{id:p.binding.connectionId,provider:'parcel2go',
      metadata:{account:p.binding.accountId,environment:'sandbox',admissionRequestId:p.requestId},encryptedCredentials:sealed.encryptedCredentials}];
    final.parcel2goSandboxRuns=final.parcel2goSandboxRuns.map(r=>r.requestId===p.requestId?{...r,status:'completed',completedAt:new Date(p.check()).toISOString(),quoteCount:projection?.quotes.length??0}:r);
    audit(final,p,'completed');const saved=await save(state,final);
    // Acknowledged CAS is necessary; readback additionally proves the receipt.
    state=saved;await fresh();
    return Object.freeze({requestId:p.requestId,status:'completed',revision:saved._revision,environment:'sandbox',synthetic:p.mode==='offline-fixture/v2',
      credentialStored:Boolean(sealed),quote:projection??null,liveReady:false});
  }
  return Object.freeze({status,run});
}
