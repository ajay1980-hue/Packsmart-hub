import {createCredentialHttpBoundary} from './parcel2go-credential-http-boundary.mjs';
import {createCredentialOwnerAuth} from './parcel2go-credential-owner-auth.mjs';
import {createLiveCredentialEntryWindow,LIVE_ENTRY_PATH} from './parcel2go-live-entry-window.mjs';
import {createParcel2GoLiveCredentialAdmission} from './parcel2go-live-admission.mjs';
import {parcel2GoCanonicalHash as hash} from './parcel2go-live-canonical.mjs';
export {LIVE_ENTRY_PATH};
const fail=()=>{throw Error('Private credential admission unavailable');};
export function createLiveCredentialEntryController({env,store,withWorkspaceLock,now=Date.now,monotonic=()=>performance.now()}={}){
 const window=createLiveCredentialEntryWindow(env,{now,monotonic});if(!window)return null;
 if(store?.provider!=='supabase'||typeof withWorkspaceLock!=='function'||typeof env.CREDENTIALS_KEY!=='string'||env.CREDENTIALS_KEY.length<32)fail();
 const origin=new URL(env.APP_PUBLIC_URL).origin;if(!origin.startsWith('https://'))fail();
 const config=window.config(),summary=window.summary();
 const authenticate=createCredentialOwnerAuth({enabled:true,store,sessionSecret:env.SESSION_SECRET,now});
 const read=auth=>{const state=auth.state,runs=state.parcel2goLiveQuoteRuns??[],rows=Array.isArray(runs)?runs.filter(r=>r.requestId===config.requestId):[],connections=(state.connections??[]).filter(c=>c.id===config.trustedBinding.connectionId||c.provider==='parcel2go-live'),r=rows[0],c=connections[0],b=config.trustedBinding;
  const stored=rows.length===1&&connections.length===1&&r.operation==='admit_credentials'&&r.status==='completed'&&r.accountId===b.accountId&&r.connectionId===b.connectionId&&r.environment==='live'&&r.termsReference===config.termsReference&&r.entryReview?.reviewDigest===summary.reviewDigest&&r.entryReview?.principalEmail===config.principalEmail&&r.entryReview?.accountEvidenceReference===config.accountEvidenceReference&&r.entryReview?.scope==='private_storage_only'&&r.admissionSessionFingerprint===config.expectedSessionFingerprint&&r.fingerprint===hash(['live-credential-admission/v1',b,config.expectedSessionFingerprint])&&c.id===b.connectionId&&c.provider==='parcel2go-live'&&c.metadata?.admissionRequestId===config.requestId&&c.metadata?.account===b.accountId&&c.metadata?.environment==='live'&&typeof c.encryptedCredentials==='string'&&r.connectionHash===hash(c);
  const canSubmit=!stored&&window.available()&&Array.isArray(runs)&&!rows.length&&!connections.length&&!runs.some(r=>r.status==='reserved')&&state._revision===config.expectedRevision&&hash(auth.session)===config.expectedSessionFingerprint;
  return {...summary,remainingMs:Math.max(0,Math.min(window.remainingMs(),auth.session.exp*1000-now())),status:stored?'stored':rows.length?'unconfirmed':canSubmit?'ready':'unavailable',canSubmit,retryAllowed:false};};
 const boundary=createCredentialHttpBoundary({enabled:true,origin,now:monotonic,authenticate:async request=>{window.guard();const a=await authenticate(request);window.guard();return {...a,request}},admit:async({auth,requestId,expectedRevision,credentials,reviewDigest,assertCurrent})=>withWorkspaceLock(auth.session.workspaceId,async()=>{
  const current=()=>{assertCurrent();window.guard();if(auth.session.exp*1000<=now())fail();};current();
  const fresh=await authenticate(auth.request);current();
  if(hash(fresh.session)!==hash(auth.session)||!read(fresh).canSubmit||requestId!==config.requestId||expectedRevision!==config.expectedRevision||reviewDigest!==summary.reviewDigest||credentials.clientId!==config.expectedClientId)fail();
  const runner=createParcel2GoLiveCredentialAdmission({...config,mode:'private-credential-admission/v1',credentialEntryPermit:window.issue(),store,key:env.CREDENTIALS_KEY,now,monotonic,assertCurrent:current});
  try{await runner.run({session:fresh.session,csrf:fresh.session.csrf,credentials});current();const status=read(await authenticate(auth.request));current();if(status.status!=='stored')fail();return {status:'stored',requestId};}finally{runner.close();}
 })});
 return Object.freeze({close(){window.close();boundary.close()},async handle(req,res){
  const abort=new AbortController(),cancel=()=>abort.abort();req.once('aborted',cancel);res.once('close',cancel);
  const request={method:req.method,origin:req.headers.origin,contentType:String(req.headers['content-type']??'').split(';')[0],csrf:req.headers['x-csrf-token'],headers:req.headers,signal:abort.signal,body:req};
  try{if(req.url!==LIVE_ENTRY_PATH||!['GET','POST'].includes(req.method))fail();
   if(req.method==='GET'){const readStart=monotonic();let timer;let a;try{a=await Promise.race([authenticate(request),new Promise((_,reject)=>{timer=setTimeout(()=>{cancel();reject(Error('Status deadline'));},2000)})]);if(abort.signal.aborted||!Number.isFinite(monotonic())||monotonic()<readStart||monotonic()-readStart>=2000)fail();}finally{clearTimeout(timer);}return {status:200,body:read(a),headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}};}
   // Retain original request only in private auth context for fresh locked verification.
   return await boundary.handle(request);
  }catch{return {status:409,body:{status:'unconfirmed',message:'Credential save is unconfirmed or refused. Check saved status; do not repeat it.'},headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}};}
  finally{req.off('aborted',cancel);res.off('close',cancel);}
 }});
}
