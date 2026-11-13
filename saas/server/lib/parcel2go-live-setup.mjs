// Single bounded own-account storage setup. No provider calls or credential access.
import {createCredentialOwnerAuth} from './parcel2go-credential-owner-auth.mjs';
import {createLiveCredentialEntryController} from './parcel2go-live-entry-controller.mjs';
import {createLiveCredentialEntryWindow} from './parcel2go-live-entry-window.mjs';
import {parcel2GoCanonicalHash as hash} from './parcel2go-live-canonical.mjs';
export const LIVE_SETUP_PATH='/api/owner/parcel2go-live-setup';
const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer'};
export function createLiveSetup({env,store,withWorkspaceLock,now=Date.now,monotonic=()=>performance.now()}={}){
 const flag=env.RUNVARA_QUIET_PARCEL2GO_LIVE_SETUP??'disabled/v1';if(flag==='disabled/v1')return null;
 const fail=()=>{throw Error('Private setup unavailable')};
 if(flag!=='enabled/v1'||env.RUNVARA_STARTUP_MODE!=='quiet'||env.RUNVARA_QUIET_OWNER_WORKSPACE!=='enabled/v1')fail();
 for(const key of ['RUNVARA_QUIET_PARCEL2GO_ENTRY_PREFLIGHT','RUNVARA_QUIET_PARCEL2GO_LIVE_CREDENTIAL_ENTRY','RUNVARA_QUIET_PARCEL2GO_CREDENTIAL_ENTRY','RUNVARA_QUIET_PARCEL2GO_SANDBOX_QUOTE','RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE','RUNVARA_QUIET_SHOPIFY_CATALOGUE'])if(env[key]!==undefined&&env[key]!=='disabled/v1')fail();
 let config;try{config=JSON.parse(env.RUNVARA_PARCEL2GO_LIVE_SETUP_CONFIG)}catch{fail()}
 const keys='requestId trustedBinding expectedClientId termsReference expiresAt principalEmail accountEvidenceReference scope';
 if(!config||Array.isArray(config)||Object.keys(config).sort().join('|')!==keys.split(' ').sort().join('|'))fail();
 const start=now(),mono=monotonic(),expiry=Date.parse(config.expiresAt);if(!Number.isSafeInteger(start)||!Number.isFinite(mono)||!Number.isFinite(expiry)||new Date(expiry).toISOString()!==config.expiresAt)fail();
 // An expired activation must never prevent the production service restarting.
 if(expiry<=start)return null;
 const derivedEnv=c=>({...env,RUNVARA_QUIET_PARCEL2GO_LIVE_SETUP:'disabled/v1',RUNVARA_QUIET_PARCEL2GO_LIVE_CREDENTIAL_ENTRY:'enabled/v1',RUNVARA_PARCEL2GO_LIVE_ENTRY_CONFIG:JSON.stringify(c)});
 // Validate host-supplied account/terms schema without creating any admission permit.
 const validation=createLiveCredentialEntryWindow(derivedEnv({...config,expectedRevision:'00000000-0000-0000-0000-000000000000',expectedSessionFingerprint:'0'.repeat(64)}),{now,monotonic});if(!validation)return null;validation.close();
 if(typeof withWorkspaceLock!=='function'||typeof env.CREDENTIALS_KEY!=='string'||env.CREDENTIALS_KEY.length<32)fail();
 const authenticate=createCredentialOwnerAuth({enabled:true,store,sessionSecret:env.SESSION_SECRET,now});const origin=new URL(env.APP_PUBLIC_URL).origin;if(!origin.startsWith('https://'))fail();
 let closed=false,last=start,lastMono=mono,entry=null,boundFingerprint=null;
 const guard=()=>{const t=now(),m=monotonic();if(closed||!Number.isSafeInteger(t)||!Number.isFinite(m)||t<last||m<lastMono||t>=expiry||m-mono>=expiry-start){closed=true;entry?.close();fail()}last=t;lastMono=m};
 return Object.freeze({close(){closed=true;entry?.close()},async handleEntry(req,res){if(!entry)return {status:503,headers,body:{status:'unavailable'}};return entry.handle(req,res)},async handleSetup(req,res){
  const abort=new AbortController(),cancel=()=>abort.abort();let timer;req.once('aborted',cancel);res.once('close',cancel);
  try{
   guard();if(req.url!==LIVE_SETUP_PATH||req.method!=='POST'||req.headers.origin!==origin||req.headers['transfer-encoding']||Number(req.headers['content-length']??0)!==0)fail();
   const began=monotonic(),current=()=>{guard();if(abort.signal.aborted||monotonic()-began>=2000)fail()};
   const job=(async()=>{const request={headers:req.headers,signal:abort.signal};const a=await authenticate(request);current();if(req.headers['x-csrf-token']!==a.session.csrf)fail();
    return withWorkspaceLock(a.session.workspaceId,async()=>{current();const fresh=await authenticate(request);current();const fingerprint=hash(fresh.session);if(fingerprint!==hash(a.session))fail();
     if(entry){if(boundFingerprint!==fingerprint)fail();return {status:'prepared',entryPath:'/parcel2go-live-entry.html',savePerformed:false,providerCallsAllowed:false}}
     const runs=fresh.state.parcel2goLiveQuoteRuns??[];if(!Array.isArray(runs)||runs.some(r=>r.requestId===config.requestId||r.status==='reserved')||(fresh.state.connections??[]).some(c=>c.provider==='parcel2go-live'||c.id===config.trustedBinding.connectionId))fail();
     const c={...config,expiresAt:new Date(Math.min(expiry,fresh.session.exp*1000)).toISOString(),expectedRevision:fresh.state._revision,expectedSessionFingerprint:fingerprint};
     current();entry=createLiveCredentialEntryController({env:derivedEnv(c),store,withWorkspaceLock,now,monotonic});boundFingerprint=fingerprint;
     return {status:'prepared',entryPath:'/parcel2go-live-entry.html',savePerformed:false,providerCallsAllowed:false};
    });})();
   const body=await Promise.race([job,new Promise((_,reject)=>{timer=setTimeout(()=>{cancel();reject(Error('Setup deadline'))},2000)})]);current();return {status:200,headers,body};
  }catch{return {status:409,headers,body:{status:'unavailable',savePerformed:false,providerCallsAllowed:false}}}
  finally{clearTimeout(timer);req.off('aborted',cancel);res.off('close',cancel)}
 }});
}
