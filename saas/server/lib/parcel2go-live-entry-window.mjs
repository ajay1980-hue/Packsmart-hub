// Host-configured bounded window; it permits storage ONLY, never provider calls.
import {parcel2GoCanonicalHash as hash,parcel2GoCanonicalJson as json} from './parcel2go-live-canonical.mjs';
const permits=new WeakMap();const fail=()=>{throw Error('Private live credential entry unavailable');};
export const LIVE_ENTRY_PATH='/api/owner/parcel2go-live-credentials';
const projection=c=>({requestId:c.requestId,expectedRevision:c.expectedRevision,trustedBinding:c.trustedBinding,expectedClientId:c.expectedClientId,termsReference:c.termsReference,expiresAt:c.expiresAt,expectedSessionFingerprint:c.expectedSessionFingerprint,entryReviewDigest:c.entryReviewDigest,principalEmail:c.principalEmail,accountEvidenceReference:c.accountEvidenceReference});
export function consumeLiveCredentialEntryPermit(permit,config){const p=permits.get(permit);permits.delete(permit);if(!p||p.digest!==hash(projection(config)))fail();p.guard();}
export function createLiveCredentialEntryWindow(env,{now=Date.now,monotonic=()=>performance.now()}={}){
 const flag=env.RUNVARA_QUIET_PARCEL2GO_LIVE_CREDENTIAL_ENTRY??'disabled/v1';if(flag==='disabled/v1')return null;
 if(flag!=='enabled/v1'||env.RUNVARA_STARTUP_MODE!=='quiet'||env.RUNVARA_QUIET_OWNER_WORKSPACE!=='enabled/v1'||['RUNVARA_QUIET_PARCEL2GO_CREDENTIAL_ENTRY','RUNVARA_QUIET_PARCEL2GO_SANDBOX_QUOTE','RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE','RUNVARA_QUIET_SHOPIFY_CATALOGUE'].some(k=>env[k]!==undefined&&env[k]!=='disabled/v1'))fail();
 let c;try{c=JSON.parse(env.RUNVARA_PARCEL2GO_LIVE_ENTRY_CONFIG);}catch{fail();}
 const keys='requestId expectedRevision trustedBinding expectedClientId termsReference expiresAt expectedSessionFingerprint principalEmail accountEvidenceReference scope';
 if(!c||Array.isArray(c)||Object.keys(c).sort().join('|')!==keys.split(' ').sort().join('|'))fail();
 const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x),id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(x);
 if(!uuid(c.requestId)||!uuid(c.expectedRevision)||! /^[a-f0-9]{64}$/.test(c.expectedSessionFingerprint)||typeof c.expectedClientId!=='string'||c.expectedClientId.length<8||c.expectedClientId.length>4096||/[\x00-\x20\x7f]/.test(c.expectedClientId)||!id(c.termsReference)||!id(c.accountEvidenceReference)||typeof c.principalEmail!=='string'||! /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(c.principalEmail)||c.scope!=='private_storage_only')fail();
 const b=c.trustedBinding;if(!b||Object.keys(b).sort().join('|')!=='accountId|connectionId|environment|workspaceId'||b.workspaceId!=='packsmart-solutions'||b.environment!=='live'||!id(b.accountId)||!id(b.connectionId))fail();
 const start=now(),mono=monotonic(),expiry=Date.parse(c.expiresAt);if(!Number.isSafeInteger(start)||!Number.isFinite(mono)||!Number.isFinite(expiry)||new Date(expiry).toISOString()!==c.expiresAt||expiry<=start||expiry-start>300000)fail();
 c=JSON.parse(json(c));let closed=false,attempted=false,last=start,lastMono=mono;
 const guard=()=>{const t=now(),m=monotonic();if(closed||!Number.isSafeInteger(t)||!Number.isFinite(m)||t<last||m<lastMono||t>=expiry||m-mono>=expiry-start){closed=true;fail();}last=t;lastMono=m;};
 const summary={requestId:c.requestId,expectedRevision:c.expectedRevision,accountAlias:b.accountId,accountAliasKind:'internal_runvara_alias_not_provider_id',principalEmail:c.principalEmail,termsUrl:'https://www.parcel2go.com/api/docs/articles/terms.html',termsReference:c.termsReference,accountEvidenceReference:c.accountEvidenceReference,expiresAt:c.expiresAt,scope:c.scope,providerCallsAllowed:false,bookingAllowed:false,spendAllowed:false};
 c.entryReviewDigest=hash(summary);
 return Object.freeze({config:()=>JSON.parse(json(c)),summary:()=>({...summary,reviewDigest:hash(summary)}),remainingMs(){try{guard();return Math.max(0,Math.min(expiry-now(),expiry-start-(monotonic()-mono)))}catch{return 0}},close(){closed=true;},guard,available(){try{guard();return !attempted}catch{return false}},issue(){guard();if(attempted)fail();attempted=true;const p=Object.freeze({});permits.set(p,{digest:hash(projection(c)),guard});return p;}});
}
