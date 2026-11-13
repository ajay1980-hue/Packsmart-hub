// Private LOOPBACK fixture handler only. Not mounted in server.mjs.
import {createParcel2GoLiveAdmission} from './parcel2go-live-admission.mjs';
import {prepareParcel2GoLiveQuotePlan} from './parcel2go-live-quote-plan.mjs';
import {parcel2GoCanonicalHash as hash,parcel2GoCanonicalJson as json} from './parcel2go-live-canonical.mjs';
import {assertQuietOwnerWorkspace} from './quiet-owner-workspace.mjs';
import {metaStrictJson} from './meta-publication-bounded.mjs';
export const PARCEL2GO_LIVE_OFFLINE_PATH='/api/offline/parcel2go-quote-review';
const headers={'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
const response=(status,value)=>new Response(JSON.stringify(value),{status,headers});
const fail=()=>{throw Error('Offline quote review refused');};
async function body(req,signal,isCurrent,budget){
 const reader=req.body?.getReader();if(!reader)fail();let size=0,count=0,chunks=[],stop,timer,poll;
 const cancelled=new Promise((_resolve,reject)=>{stop=()=>reject(Error('Body read closed'));});
 const check=()=>{if(req.signal.aborted||signal.aborted||!isCurrent())fail();};
 req.signal.addEventListener('abort',stop,{once:true});signal.addEventListener('abort',stop,{once:true});
 timer=setTimeout(stop,Math.max(1,Math.min(2000,budget)));poll=setInterval(()=>{try{check();}catch{stop();}},25);
 try{check();for(;;){const {value,done}=await Promise.race([reader.read(),cancelled]);check();if(done)break;if(!(value instanceof Uint8Array)||value.byteLength===0||++count>2048)fail();size+=value.byteLength;if(size>2048)fail();chunks.push(value);}return metaStrictJson(Buffer.concat(chunks));}
 finally{clearTimeout(timer);clearInterval(poll);req.signal.removeEventListener('abort',stop);signal.removeEventListener('abort',stop);reader.cancel().catch(()=>{});}
}
export function createParcel2GoLiveOwnerRoute({mode='disabled/v1',authenticate,origin,config,input,now=Date.now}={}){
 if(mode==='disabled/v1')return Object.freeze({handle:async()=>response(404,{error:'Unavailable'}),close(){}});
 let u;try{u=new URL(origin);}catch{fail();}
 if(mode!=='offline-owner-route/v1'||!['127.0.0.1','localhost'].includes(u.hostname)||u.protocol!=='http:'||u.origin!==origin||!u.port||typeof authenticate!=='function'||config?.mode!=='offline-integrated/v1'||typeof config.mockRequest!=='function')fail();
 const fixedInput=JSON.parse(json(input)),plan=prepareParcel2GoLiveQuotePlan(fixedInput,now());
 if(plan.fingerprint!==config.inputFingerprint)fail();
 const pinned=JSON.parse(json({requestId:config.requestId,expectedRevision:config.expectedRevision,expectedSessionFingerprint:config.expectedSessionFingerprint,inputFingerprint:config.inputFingerprint,expiresAt:config.expiresAt}));
 const runner=createParcel2GoLiveAdmission(config),bodyController=new AbortController();let closed=false,submitted=false;
 const close=()=>{closed=true;bodyController.abort();runner.close();};
 function descriptor(auth,quote=null){
  const rows=(auth.state.parcel2goLiveQuoteRuns??[]).filter(r=>r.requestId===pinned.requestId),remainingMs=Math.max(0,Math.min(300000,Date.parse(pinned.expiresAt)-now(),auth.session.exp*1000-now()));
  const receipt=rows.length===1?rows[0]:null;
  const completed=receipt?.status==='completed'&&receipt.operation==='quote'&&receipt.fingerprint===hash(['live-quote-admission/v1',pinned.inputFingerprint,pinned.expectedSessionFingerprint])&&/^[a-f0-9]{64}$/.test(receipt.projectionHash||'');
  const outcome=completed?'completed':rows.length||submitted?'reconcile_no_replay':auth.state._revision!==pinned.expectedRevision?'state_changed':'not_started';
  return {schema:'runvara-offline-quote-review/v1',requestId:pinned.requestId,expectedRevision:pinned.expectedRevision,expiresAt:pinned.expiresAt,remainingMs,fixture:true,liveReady:false,purchaseAllowed:false,canSubmit:!closed&&remainingMs>0&&outcome==='not_started',outcome,parcel:{estimate:plan.estimate,weightGrams:plan.parcel.weightGrams,lengthMm:plan.parcel.lengthMm,widthMm:plan.parcel.widthMm,heightMm:plan.parcel.heightMm,declaredValueDecimal:plan.parcel.declaredValueDecimal,currency:'GBP'},quote:remainingMs>0?quote:null};
 }
 async function handle(req){
  try{
   const url=new URL(req.url);if(closed||url.origin!==origin||url.pathname!==PARCEL2GO_LIVE_OFFLINE_PATH||url.search)return response(404,{error:'Unavailable'});
   if(!['GET','POST'].includes(req.method))return response(405,{error:'Method refused'});
   if(req.headers.get('sec-fetch-site')&&!['same-origin','none'].includes(req.headers.get('sec-fetch-site')))return response(403,{error:'Origin refused'});
   const auth=await authenticate(req);if(closed||req.signal.aborted)fail();assertQuietOwnerWorkspace(auth,{inspectEvidence:false});
   if(hash(auth.session)!==pinned.expectedSessionFingerprint||!Number.isSafeInteger(auth.session.exp)||auth.session.exp*1000<=now()||auth.state.users.filter(u=>u.id===auth.session.sub&&u.active===true&&u.sessionVersion===auth.session.sessionVersion).length!==1)return response(403,{error:'Owner session required'});
   if(req.method==='GET')return response(200,descriptor(auth));
   if(req.headers.get('origin')!==origin||req.headers.get('x-csrf-token')!==auth.session.csrf||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers.get('content-type')||''))return response(403,{error:'Request refused'});
   const b=await body(req,bodyController.signal,()=>!closed&&now()<Date.parse(pinned.expiresAt)&&now()<auth.session.exp*1000,Math.min(Date.parse(pinned.expiresAt)-now(),auth.session.exp*1000-now()));if(!b||Object.keys(b).sort().join('|')!=='confirmed|expectedRevision|requestId'||b.confirmed!==true||b.requestId!==pinned.requestId||b.expectedRevision!==pinned.expectedRevision||!descriptor(auth).canSubmit)return response(409,{error:'Attempt unavailable; do not retry'});
   if(req.signal.aborted)fail();submitted=true;const abort=()=>close();req.signal.addEventListener('abort',abort,{once:true});let result;try{result=await runner.run({session:auth.session,csrf:auth.session.csrf,input:fixedInput});}finally{req.signal.removeEventListener('abort',abort);}
   const latest=await authenticate(req);if(closed||req.signal.aborted||now()>=Date.parse(pinned.expiresAt))fail();assertQuietOwnerWorkspace(latest,{inspectEvidence:false});if(hash(latest.session)!==pinned.expectedSessionFingerprint||latest.state._revision!==result.revision||latest.session.exp*1000<=now()||latest.state.users.filter(u=>u.id===latest.session.sub&&u.active===true&&u.sessionVersion===latest.session.sessionVersion).length!==1)fail();
   const saved=latest.state.parcel2goLiveQuoteRuns?.filter(r=>r.requestId===pinned.requestId);if(saved?.length!==1||saved[0].projectionHash!==hash(result.quote))fail();
   const dto=descriptor(latest,result.quote);if(dto.outcome!=='completed')fail();return response(200,dto);
  }catch{return response(409,{error:'Offline result unconfirmed; reconcile without retry'});}
 }
 return Object.freeze({handle,close});
}
