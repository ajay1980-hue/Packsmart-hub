// Read-only server proof for configuring a separate credential-entry window.
// Never returns cookies, secrets, connection contents or the workspace snapshot.
import {createCredentialOwnerAuth} from './parcel2go-credential-owner-auth.mjs';
import {parcel2GoCanonicalHash as hash} from './parcel2go-live-canonical.mjs';
export const ENTRY_PREFLIGHT_PATH='/api/owner/parcel2go-entry-preflight';
export function createEntryPreflight({env,store,now=Date.now,monotonic=()=>performance.now()}={}) {
 const flag=env.RUNVARA_QUIET_PARCEL2GO_ENTRY_PREFLIGHT??'disabled/v1';
 if(flag==='disabled/v1')return null;
 const fail=()=>{throw Error('Entry preflight unavailable')};
 const expiry=Date.parse(env.RUNVARA_PARCEL2GO_ENTRY_PREFLIGHT_EXPIRES_AT),start=now(),mono=monotonic();
 if(!Number.isSafeInteger(start)||!Number.isFinite(mono)||flag!=='enabled/v1'||env.RUNVARA_STARTUP_MODE!=='quiet'||env.RUNVARA_QUIET_OWNER_WORKSPACE!=='enabled/v1'||!Number.isFinite(expiry)||expiry<=start||expiry-start>300000)fail();
 for(const key of ['RUNVARA_QUIET_PARCEL2GO_LIVE_CREDENTIAL_ENTRY','RUNVARA_QUIET_PARCEL2GO_CREDENTIAL_ENTRY','RUNVARA_QUIET_PARCEL2GO_SANDBOX_QUOTE','RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE','RUNVARA_QUIET_SHOPIFY_CATALOGUE'])if(env[key]!==undefined&&env[key]!=='disabled/v1')fail();
 const origin=new URL(env.APP_PUBLIC_URL).origin;if(!origin.startsWith('https://'))fail();
 const authenticate=createCredentialOwnerAuth({enabled:true,store,sessionSecret:env.SESSION_SECRET,now});
 let closed=false,last=start,lastMono=mono;
 const guard=()=>{const t=now(),m=monotonic();if(closed||!Number.isSafeInteger(t)||!Number.isFinite(m)||t<last||m<lastMono||t>=expiry||m-mono>=expiry-start){closed=true;fail();}last=t;lastMono=m};
 const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer'};
 return Object.freeze({close(){closed=true},async handle(req,res){
  const controller=new AbortController(),abort=()=>controller.abort();let timer;
  req.once('aborted',abort);res.once('close',abort);
  try {
   guard();if(req.url!==ENTRY_PREFLIGHT_PATH||req.method!=='POST'||req.headers.origin!==origin||req.headers['transfer-encoding']||Number(req.headers['content-length']??0)!==0)fail();
   const begin=monotonic();
   const auth=await Promise.race([authenticate({headers:req.headers,signal:controller.signal}),new Promise((_,reject)=>{timer=setTimeout(()=>{abort();reject(Error('Preflight deadline'))},2000)})]);
   guard();if(controller.signal.aborted||monotonic()-begin>=2000||req.headers['x-csrf-token']!==auth.session.csrf)fail();
   const revision=auth.state._revision;if(typeof revision!=='string'||! /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(revision))fail();
   return {status:200,headers,body:{status:'observed',workspaceId:auth.session.workspaceId,expectedRevision:revision,expectedSessionFingerprint:hash(auth.session),sessionExpiresAt:new Date(auth.session.exp*1000).toISOString(),observedAt:new Date(now()).toISOString(),entryEnabled:false,providerCallsAllowed:false}};
  }catch{return {status:409,headers,body:{status:'unavailable'}}}
  finally{clearTimeout(timer);req.off('aborted',abort);res.off('close',abort)}
 }});
}
