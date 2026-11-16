// Construction-time, finite own-account quote activation. Disabled by default;
// browser input cannot configure this host or obtain credentials from it.
import {metaStrictJson} from './meta-publication-bounded.mjs';
import {createParcel2GoOwnerQuoteSurface,PARCEL2GO_OWNER_QUOTE_PAGE,PARCEL2GO_OWNER_QUOTE_SCRIPT} from './parcel2go-owner-quote-surface.mjs';
import {PARCEL2GO_RECORDED_REVIEW_PATH} from './parcel2go-recorded-owner-review.mjs';
export const PARCEL2GO_OWNER_QUOTE_FLAG='RUNVARA_QUIET_PARCEL2GO_OWNER_QUOTE';
export const PARCEL2GO_OWNER_QUOTE_CONFIG='RUNVARA_PARCEL2GO_OWNER_QUOTE_CONFIG';
export const isParcel2GoOwnerQuotePath=pathname=>[PARCEL2GO_OWNER_QUOTE_PAGE,PARCEL2GO_OWNER_QUOTE_SCRIPT,PARCEL2GO_RECORDED_REVIEW_PATH].includes(pathname);
const fail=()=>{throw Object.assign(Error('Owner quote activation unavailable'),{code:'PARCEL2GO_OWNER_QUOTE_CONFIG_INVALID'});};
const exact=(x,keys)=>x&&!Array.isArray(x)&&Object.keys(x).sort().join('|')===keys.split(' ').sort().join('|');
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const reference=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(x);

export function createParcel2GoOwnerQuoteMount({env={},store,withWorkspaceLock,now=Date.now,monotonic=()=>performance.now()}={}){
 const flag=env[PARCEL2GO_OWNER_QUOTE_FLAG]??'disabled/v1';if(flag==='disabled/v1')return null;
 if(flag!=='enabled/v1'||env.RUNVARA_STARTUP_MODE!=='quiet'||env.RUNVARA_QUIET_OWNER_WORKSPACE!=='enabled/v1')fail();
 let c;
 try{const raw=env[PARCEL2GO_OWNER_QUOTE_CONFIG];if(typeof raw!=='string'||Buffer.byteLength(raw)>8192)fail();c=metaStrictJson(Buffer.from(raw));}catch{fail();}
 if(!exact(c,'requestId trustedBinding expectedClientId termsReference expiresAt credentialAdmissionRequestId expectedCredentialReceiptHash scope')||
    !uuid(c.requestId)||!uuid(c.credentialAdmissionRequestId)||c.requestId===c.credentialAdmissionRequestId||
    !/^[a-f0-9]{64}$/.test(c.expectedCredentialReceiptHash??'')||!reference(c.termsReference)||c.scope!=='one_quote_only'||
    typeof c.expectedClientId!=='string'||c.expectedClientId.length<8||c.expectedClientId.length>4096||/[\x00-\x20\x7f]/.test(c.expectedClientId))fail();
 const b=c.trustedBinding;
 if(!exact(b,'workspaceId connectionId accountId environment')||b.workspaceId!=='packsmart-solutions'||b.environment!=='live'||!reference(b.accountId)||
    typeof b.connectionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(b.connectionId))fail();
 const start=now(),expiry=Date.parse(c.expiresAt);
 if(!Number.isSafeInteger(start)||typeof c.expiresAt!=='string'||!Number.isFinite(expiry)||new Date(expiry).toISOString()!==c.expiresAt||expiry-start>300000)fail();
 // A retained expired activation must not stop the rest of the service starting.
 if(expiry<=start)return null;
 let origin;
 try{const u=new URL(env.APP_PUBLIC_URL);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/')fail();origin=u.origin;}catch{fail();}
 if(store?.provider!=='supabase'||typeof withWorkspaceLock!=='function'||typeof env.CREDENTIALS_KEY!=='string'||env.CREDENTIALS_KEY.length<32)fail();
 let closed=false;
 const surface=createParcel2GoOwnerQuoteSurface({mode:'unmounted-owner-quote-surface/v1',origin,store,sessionSecret:env.SESSION_SECRET,withWorkspaceLock,
  requestId:c.requestId,expiresAt:c.expiresAt,now,monotonic,
  admission:{mode:'disabled/v1',store,key:env.CREDENTIALS_KEY,trustedBinding:b,expectedClientId:c.expectedClientId,termsReference:c.termsReference,
   credentialAdmissionRequestId:c.credentialAdmissionRequestId,expectedCredentialReceiptHash:c.expectedCredentialReceiptHash,
   assertCurrent:()=>{if(closed)fail();}}});
 return Object.freeze({handle:surface.handle,close(){closed=true;surface.close();}});
}
