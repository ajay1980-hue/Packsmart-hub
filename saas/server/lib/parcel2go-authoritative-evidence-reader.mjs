// Read-only host interface, called after owner authentication. Existing primary
// state can establish storage linkage, not physical measurements/API entitlement.
// No source ingestion contract exists yet, so readEvidence can never emit a packet.
import {isDeepStrictEqual as same} from 'node:util';
import {parcel2GoCanonicalHash as hash} from './parcel2go-live-canonical.mjs';
import {assertShopifySourceScope} from './shopify-order-source.mjs';

const WORKSPACE='packsmart-solutions';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const reference=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(x);
export const PARCEL2GO_EVIDENCE_SOURCE_REQUIRED='PARCEL2GO_AUTHORITATIVE_EVIDENCE_UNAVAILABLE';
export const PARCEL2GO_EVIDENCE_DEPENDENCIES=Object.freeze([
 'packed_measurement_source_missing', 'account_entitlement_source_missing', 'consignment_selection_source_missing'
]);
const fail=code=>{throw Object.assign(Error('Authoritative shipping evidence unavailable'),{code,status:409});};
const result=(status,credentialStorage,blockers)=>Object.freeze({schema:'runvara-parcel2go-evidence-availability/v1',status,credentialStorage,
 blockers:Object.freeze([...blockers]),packet:null,sourceVerified:false,accountEntitlementVerified:false,quoteReady:false,providerCallsAllowed:false,liveReady:false});

function storedCredentialLink(state,now){
 const connections=state.connections??[],runs=state.parcel2goLiveQuoteRuns??[];
 if(!Array.isArray(connections)||!Array.isArray(runs)||connections.length>1000||runs.length>20)return 'unconfirmed';
 const rows=connections.filter(x=>x?.provider==='parcel2go-live');
 if(!rows.length&&!runs.some(x=>x?.operation==='admit_credentials'))return 'absent';
 if(rows.length!==1)return 'unconfirmed';
 const c=rows[0],metadata=c.metadata;
 const admitted=runs.filter(x=>x?.requestId===metadata?.admissionRequestId);
 if(admitted.length!==1||!reference(c.id)||!reference(metadata?.account)||!uuid(metadata?.admissionRequestId)||
    !same(metadata,{account:metadata.account,environment:'live',admissionRequestId:metadata.admissionRequestId})||
    typeof c.encryptedCredentials!=='string'||!c.encryptedCredentials.startsWith('v1.')||c.encryptedCredentials.length>32768)return 'unconfirmed';
 const r=admitted[0],binding={workspaceId:WORKSPACE,connectionId:c.id,accountId:metadata.account,environment:'live'};
 for(const record of [c,metadata,r,...(r.entryReview?[r.entryReview]:[])])assertShopifySourceScope(record,WORKSPACE);
 const completed=Date.parse(r.completedAt),expiry=Date.parse(r.expiresAt);
 if(!Number.isFinite(completed)||new Date(completed).toISOString()!==r.completedAt||!Number.isFinite(expiry)||new Date(expiry).toISOString()!==r.expiresAt||completed>now||completed>=expiry)return 'unconfirmed';
 if(r.operation!=='admit_credentials'||r.status!=='completed'||r.environment!=='live'||r.connectionId!==c.id||r.accountId!==metadata.account||
    !reference(r.termsReference)||!digest(r.admissionSessionFingerprint)||r.fingerprint!==hash(['live-credential-admission/v1',binding,r.admissionSessionFingerprint])||r.connectionHash!==hash(c))return 'unconfirmed';
 // Self-consistency of retained storage only. No decryption, issuer validation,
 // scope/terms acceptance, account facts or measurement verification is implied.
 return 'linked_receipt';
}

export function createParcel2GoAuthoritativeEvidenceReader(options={}){
 if((options.mode??'disabled/v1')==='disabled/v1')return Object.freeze({
  inspect:async()=>result('disabled','unchecked',['disabled']),readEvidence:async()=>fail(PARCEL2GO_EVIDENCE_SOURCE_REQUIRED),close(){}});
 const {store,requestId,expiresAt,now=Date.now,monotonic=()=>performance.now()}=options;
 if(options.mode!=='unmounted-source-reader/v1'||store?.provider!=='supabase'||typeof store.get!=='function'||!uuid(requestId))fail('PARCEL2GO_EVIDENCE_READER_INVALID');
 const start=now(),mono=monotonic(),expiry=Date.parse(expiresAt);
 if(!Number.isSafeInteger(start)||!Number.isFinite(mono)||!Number.isFinite(expiry)||new Date(expiry).toISOString()!==expiresAt||expiry<=start||expiry-start>300000)fail('PARCEL2GO_EVIDENCE_READER_INVALID');
 const lifetime=new AbortController();let closed=false,last=start,lastMono=mono;
 const close=()=>{closed=true;lifetime.abort();};
 const clock=()=>{const t=now(),m=monotonic();if(closed||!Number.isSafeInteger(t)||!Number.isFinite(m)||t<last||m<lastMono||t>=expiry||m-mono>=expiry-start){close();fail('PARCEL2GO_EVIDENCE_READ_REFUSED');}last=t;lastMono=m;return m;};
 async function inspect(args={}){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['workspaceId','requestId','signal'].includes(k))||args.workspaceId!==WORKSPACE||args.requestId!==requestId)fail('PARCEL2GO_EVIDENCE_SCOPE_REFUSED');
  clock();if(args.signal?.aborted)fail('PARCEL2GO_EVIDENCE_READ_REFUSED');
  const began=monotonic();let timer,reject;
  const cancelled=new Promise((_,r)=>{reject=r;}),stop=()=>reject(Error('Evidence read closed'));
  args.signal?.addEventListener('abort',stop,{once:true});lifetime.signal.addEventListener('abort',stop,{once:true});
  const check=()=>{if(args.signal?.aborted||clock()-began>=2000)fail('PARCEL2GO_EVIDENCE_READ_REFUSED');};
  try{
   timer=setTimeout(stop,2000);
   const state=await Promise.race([Promise.resolve().then(()=>{check();return store.get(WORKSPACE,{exactSnapshot:true});}),cancelled]);check();
   if(!state||state.workspace?.id!==WORKSPACE||!uuid(state._revision))fail('PARCEL2GO_EVIDENCE_SCOPE_REFUSED');
   assertShopifySourceScope(state,WORKSPACE);assertShopifySourceScope(state.workspace,WORKSPACE);
   const credentialStorage=storedCredentialLink(state,now());check();
   return result('blocked',credentialStorage,[...PARCEL2GO_EVIDENCE_DEPENDENCIES,...(credentialStorage==='linked_receipt'?[]:['credential_storage_unconfirmed'])]);
  }catch{fail('PARCEL2GO_EVIDENCE_READ_REFUSED');}
  finally{clearTimeout(timer);args.signal?.removeEventListener('abort',stop);lifetime.signal.removeEventListener('abort',stop);}
 }
 const readEvidence=async args=>{await inspect(args);fail(PARCEL2GO_EVIDENCE_SOURCE_REQUIRED);};
 return Object.freeze({inspect,readEvidence,close});
}
