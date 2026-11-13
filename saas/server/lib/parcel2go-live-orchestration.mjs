import {assertParcel2GoSynchronousCurrent} from './parcel2go-live-sync-guard.mjs';
// Default-off orchestration. HTTPS candidate is not reachable from mounted routes.
import {createHash} from 'node:crypto';
import {createParcel2GoLiveHttpsCandidate} from './parcel2go-live-https-candidate.mjs';
import {parcel2GoCanonicalHash} from './parcel2go-live-canonical.mjs';
import {captureParcel2GoToken} from './parcel2go-quote-foundation.mjs';
import {parcel2GoQuoteResponse} from './parcel2go-quote-schema.mjs';
import {metaStrictJson} from './meta-publication-bounded.mjs';
import {createParcel2GoLiveMockHttp} from './parcel2go-live-mock-http.mjs';
import {parcel2GoLiveWireBody} from './parcel2go-live-quote-wire.mjs';
import {openParcel2GoLiveCredentials} from './parcel2go-live-credentials.mjs';
const fail=code=>{throw Object.assign(new Error('Local quote fixture stopped; reconcile before retry.'),{code:'PARCEL2GO_LIVE_'+code});};
export function createParcel2GoLiveOrchestration({mode='disabled/v1',mockRequest,expectedSessionFingerprint,now=Date.now,monotonic=()=>performance.now()}={}){
 if(!['disabled/v1','offline-orchestration/v1','approved-https-orchestration/v1'].includes(mode))fail('DISABLED');const live=mode==='approved-https-orchestration/v1';let attempted=false,http,closed=false;
 const close=()=>{closed=true;http?.close();};
 async function run(args={}){
  if(mode==='disabled/v1'||closed)fail('DISABLED');if(attempted)fail('ATTEMPT_SPENT');attempted=true;
  const {input,expectedPlanFingerprint,auth,trustedBinding,envelope,key,expectedClientId,requestId,expiresAt,assertCurrent,refreshCurrent,signal}=args;
  if((live?mockRequest!==undefined:typeof mockRequest!=='function')||typeof assertCurrent!=='function'||typeof requestId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestId))fail('CONFIG_INVALID');
  if(live&&(!/^[a-f0-9]{64}$/.test(expectedSessionFingerprint||'')||parcel2GoCanonicalHash(auth?.session)!==expectedSessionFingerprint))fail('SESSION_BINDING_INVALID');
  const start=now(),mono=monotonic(),expiry=Date.parse(expiresAt);let last=start,lastMono=mono;
  if(!Number.isSafeInteger(start)||!Number.isFinite(mono)||!Number.isFinite(expiry)||expiry<=start||expiry-start>300000)fail('EXPIRED');
  const check=()=>{if(live&&parcel2GoCanonicalHash(auth?.session)!==expectedSessionFingerprint){close();fail('SESSION_BINDING_INVALID');}const t=now(),m=monotonic();if(closed||signal?.aborted||!Number.isSafeInteger(t)||!Number.isFinite(m)||t<last||m<lastMono||t>=expiry||m-mono>=expiry-start){close();fail('EXPIRED');}last=t;lastMono=m;try{assertParcel2GoSynchronousCurrent(assertCurrent);}catch{close();fail('REVOKED');}return t;};
  const wire=parcel2GoLiveWireBody(input,check());
  if(expectedPlanFingerprint!==undefined&&wire.plan.fingerprint!==expectedPlanFingerprint)fail('INPUT_CHANGED');
  if(wire.plan.account.accountId!==trustedBinding?.accountId||wire.plan.account.workspaceId!==trustedBinding?.workspaceId)fail('BINDING_INVALID');
  const checkpoint=async()=>{check();if(refreshCurrent!==undefined){if(typeof refreshCurrent!=='function')fail('CONFIG_INVALID');await refreshCurrent();}check();};
  const sessionEnd=auth?.session?.exp*1000;
  const remain=()=>Math.floor(Math.min(5000,expiry-check(),expiry-start-(lastMono-mono),sessionEnd-check(),Date.parse(wire.plan.expiresAt)-check()));
  let creds,token,raw;const abort=()=>close();
  try{
   signal?.addEventListener('abort',abort,{once:true});await checkpoint();
   creds=openParcel2GoLiveCredentials({auth,trustedBinding,envelope,key,expectedClientId,now:check()});
   const tokenBody=new URLSearchParams({grant_type:'client_credentials',scope:'public-api',client_id:creds.clientId,client_secret:creds.clientSecret}).toString();
   const digest=body=>createHash('sha256').update(body).digest('hex');
   http=live?createParcel2GoLiveHttpsCandidate({mode:'approved-https-candidate/v1',expiresAt,approvedBodyHashes:{token:digest(tokenBody),quote:digest(wire.body)},assertAuthorized:()=>{check();return true;},now,monotonic}):createParcel2GoLiveMockHttp({mode:'offline-wire-mock/v1',mockRequest});
   const sentAt=new Date(check()).toISOString(),sentMono=monotonic();
   raw=await http.send({operation:'token',timeoutMs:remain(),body:tokenBody});
   await checkpoint();token=captureParcel2GoToken(metaStrictJson(raw),{sentAt,receivedAt:new Date(check()).toISOString()});raw.fill(0);raw=null;
   const tokenRemaining=()=>Math.floor(Math.min(Date.parse(token.expiresAt)-check(),Date.parse(token.expiresAt)-Date.parse(sentAt)-(monotonic()-sentMono)));
   // Revalidate owner/binding after await; production integration must re-read state.
   openParcel2GoLiveCredentials({auth,trustedBinding,envelope,key,expectedClientId,now:check()});
   const timeout=Math.min(remain(),tokenRemaining());if(timeout<1)fail('TOKEN_EXPIRED');
   raw=await http.send({operation:'quote',timeoutMs:timeout,body:wire.body,token:token.accessToken});
   await checkpoint();if(tokenRemaining()<=0||remain()<1)fail('TOKEN_EXPIRED');
   openParcel2GoLiveCredentials({auth,trustedBinding,envelope,key,expectedClientId,now:check()});
   const parsed=parcel2GoQuoteResponse(raw,{observedAt:new Date(check()).toISOString(),requestId,responseSource:'fixture'});
   // Reuse strict value validation only, not the fixture parser's provenance.
   // Only the HTTPS branch may label its source live-http. Parser guarantees exact
   // GBP VAT arithmetic, duplicate-key/UTF-8 checks and <=50 safe service rows.
   const result=Object.freeze({schema:live?'runvara-parcel2go-live-quote/v1':'runvara-parcel2go-live-quote-mock/v1',requestId,observedAt:parsed.observedAt,quotes:parsed.quotes,
    fixture:!live,synthetic:!live,responseSource:live?'live-http':'fixture',estimate:wire.plan.estimate,liveReady:false,purchaseAllowed:false,priceGuaranteed:false,deliveryGuaranteed:false});
   const serialized=JSON.stringify(result);if([creds.clientId,creds.clientSecret,token.accessToken,key,envelope.encryptedCredentials].some(v=>serialized.includes(v)))fail('QUOTE_INVALID');
   return Object.freeze({result,projectionHash:parcel2GoCanonicalHash(result)});
  }catch{fail('OUTCOME_UNKNOWN');}finally{raw?.fill(0);token=null;if(creds){creds.clientId=null;creds.clientSecret=null;}close();signal?.removeEventListener('abort',abort);}
 }
 return Object.freeze({run,close});
}
