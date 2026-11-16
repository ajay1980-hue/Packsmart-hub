// Unmounted, default-disabled preparation/decision HTTP candidate. No provider
// transport, credential decryption, environment activation or source verifier.
import {createCredentialOwnerAuth} from './parcel2go-credential-owner-auth.mjs';
import {deriveRecordedQuoteApproval} from './parcel2go-exact-input-producer.mjs';
import {createExactQuoteApproval,readExactQuoteApproval,decideExactQuoteApproval} from './parcel2go-exact-approval.mjs';
import {parcel2GoCanonicalHash as hash,parcel2GoCanonicalJson as json} from './parcel2go-live-canonical.mjs';
import {metaStrictJson} from './meta-publication-bounded.mjs';
import {addAudit} from './events.mjs';
import {isDeepStrictEqual as same} from 'node:util';

export const PARCEL2GO_RECORDED_REVIEW_PATH='/api/owner/parcel2go-quote-review';
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const exact=(x,keys)=>x&&!Array.isArray(x)&&Object.keys(x).sort().join('|')===keys.split(' ').sort().join('|');
const refuse=()=>{throw Error('Recorded quote review unavailable; reconcile without retry');};
const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"}});

export function createParcel2GoRecordedOwnerReview(options={}){
 if((options.mode??'disabled/v1')==='disabled/v1')return Object.freeze({handle:async()=>reply(404,{error:'Unavailable'}),close(){}});
 const {store,sessionSecret,origin,withWorkspaceLock,readEvidence,expectedEvidenceHash,requestId,expiresAt,now=Date.now,monotonic=()=>performance.now()}=options;
 if(options.mode!=='unmounted-recorded-review/v1'||typeof origin!=='string'||new URL(origin).origin!==origin||!origin.startsWith('https://')||typeof withWorkspaceLock!=='function'||typeof readEvidence!=='function'||!digest(expectedEvidenceHash)||!uuid(requestId))refuse();
 const start=now(),mono=monotonic(),expiry=Date.parse(expiresAt);
 if(!Number.isSafeInteger(start)||!Number.isFinite(mono)||!Number.isFinite(expiry)||new Date(expiry).toISOString()!==expiresAt||expiry<=start||expiry-start>300000)refuse();
 const authenticate=createCredentialOwnerAuth({enabled:true,store,sessionSecret,now});
 const lifetime=new AbortController(),attempts=new Set();let closed=false,last=start,lastMono=mono;
 const close=()=>{closed=true;lifetime.abort();};
 const clock=()=>{const t=now(),m=monotonic();if(closed||!Number.isSafeInteger(t)||!Number.isFinite(m)||t<last||m<lastMono||t>=expiry||m-mono>=expiry-start){close();refuse();}last=t;lastMono=m;return m;};
 const derive=(auth,packet)=>deriveRecordedQuoteApproval({mode:'unmounted-recorded-input/v1',auth,packet,expectedEvidenceHash,requestId,now:now()});
 const find=(auth,prepared)=>{
  const rows=auth.state.approvals.filter(a=>a.requestIdentity?.requestId===requestId);
  if(rows.length>1)refuse();if(!rows.length)return null;
  const row=readExactQuoteApproval({state:auth.state,auth,approvalId:rows[0].id,now:now()});
  if(row.payload.operationHash!==prepared.intent.approval.payload.operationHash)refuse();return row;
 };
 const view=(auth,prepared,row)=>{
  const op=prepared.intent.approval.payload.operation;
  return {schema:'runvara-recorded-quote-review/v1',requestId,evidenceHash:expectedEvidenceHash,
   status:row?.status??'not_prepared',approvalId:row?.id??null,revision:row?.revision??1,operationHash:prepared.intent.approval.payload.operationHash,
   accountAlias:op.accountId,reviewSummary:op.reviewSummary,packing:prepared.packing,termsReference:op.termsReference,accountEvidenceReference:op.accountEvidenceReference,
   expiresAt:op.expiresAt,remainingMs:Math.max(0,Math.floor(Math.min(Date.parse(op.expiresAt)-now(),expiry-start-(monotonic()-mono)))),
   evidenceNotice:'Recorded claims only; source and API eligibility are not independently verified.',
   sourceVerified:false,accountEntitlementVerified:false,providerCallsAllowed:false,operationalExecution:false,liveReady:false,
   durableDecision:row?.status==='approved'||row?.status==='rejected',permission:op.permission,executionStatus:'not_connected',
   maxTokenRequests:1,maxQuoteRequests:1,maxSpendMinor:0,currency:'GBP',bookingAllowed:false,labelsAllowed:false,collectionsAllowed:false};
 };
 async function handle(req){
  let reader,timer;const controller=new AbortController();let reject;
  const cancelled=new Promise((_,r)=>{reject=r;});
  const stop=()=>{controller.abort();reject(Error('Review request closed'));};
  req.signal.addEventListener('abort',stop,{once:true});lifetime.signal.addEventListener('abort',stop,{once:true});
  const began=monotonic();
  const check=()=>{if(controller.signal.aborted||req.signal.aborted||clock()-began>=2000)refuse();};
  const request={headers:Object.fromEntries(req.headers),signal:controller.signal};
  const auth=async()=>{check();const a=await authenticate(request);check();return {...a,user:a.state.users.find(u=>u.id===a.session.sub)};};
  const context=async a=>{
   check();const raw=await readEvidence({workspaceId:a.session.workspaceId,requestId,signal:controller.signal});check();
   const fresh=await auth();if(hash(fresh.session)!==hash(a.session)||!same(fresh.state,a.state))refuse();
   const packet=JSON.parse(json(raw));if(packet.expiresAt!==expiresAt)refuse();
   const prepared=derive(a,packet);check();return {packet,prepared};
  };
  const parse=async()=>{
   reader=req.body?.getReader();if(!reader)refuse();const chunks=[];let bytes=0,count=0;
   for(;;){check();const {value,done}=await reader.read();check();if(done)break;
    if(!(value instanceof Uint8Array)||!value.byteLength||++count>64||(bytes+=value.byteLength)>2048)refuse();chunks.push(value);}
   return metaStrictJson(Buffer.concat(chunks));
  };
  const job=async()=>{
   const u=new URL(req.url);
   if(closed||u.origin!==origin||u.pathname!==PARCEL2GO_RECORDED_REVIEW_PATH||u.searchParams.size!==1||u.searchParams.get('requestId')!==requestId)return reply(404,{error:'Unavailable'});
   if(!['GET','POST'].includes(req.method))return reply(405,{error:'Method refused'});
   if(request.headers['sec-fetch-site']&&!['same-origin','none'].includes(request.headers['sec-fetch-site']))return reply(403,{error:'Origin refused'});
   const initial=await auth();
   if(req.method==='GET'){const {prepared}=await context(initial),row=find(initial,prepared);check();return reply(200,view(initial,prepared,row));}
   if(request.headers.origin!==origin||request.headers['x-csrf-token']!==initial.session.csrf||initial.session.csrf.length<16||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type']??''))return reply(403,{error:'Request refused'});
   const body=await parse();check();
   if(!body||body.requestId!==requestId||body.evidenceHash!==expectedEvidenceHash||
      !(body.action==='prepare'&&exact(body,'action requestId evidenceHash')||body.action==='decide'&&exact(body,'action requestId evidenceHash approvalId confirmation')))refuse();
   return withWorkspaceLock(initial.session.workspaceId,async()=>{
    const a=await auth();if(hash(a.session)!==hash(initial.session))refuse();
    const {packet,prepared}=await context(a),row=find(a,prepared);
    const evidenceGuard=state=>{check();const out=derive({...a,state,user:state.users.find(u=>u.id===a.session.sub)},packet);if(out.intent.approval.payload.operationHash!==prepared.intent.approval.payload.operationHash)refuse();check();};
    let targetHash;
    if(body.action==='prepare'){
     if(row)targetHash=hash(row);
     else{
      if(attempts.has('prepare'))refuse();attempts.add('prepare');
      const result=await createExactQuoteApproval({mode:'local-contract/v1',store,auth:a,intent:prepared.intent,now,assertCurrent:check,assertEvidenceCurrent:evidenceGuard});
      check();targetHash=hash(result.approval);
     }
    }else{
     if(!row||body.approvalId!==row.id)refuse();
     const next=decideExactQuoteApproval({mode:'local-contract/v1',state:a.state,auth:a,approvalId:row.id,confirmation:body.confirmation,now:now()});
     targetHash=hash(next.approvals.find(x=>x.id===row.id));
     addAudit(next,{type:'parcel2go_exact_decided',actor:a.session.sub,detail:{requestId,approvalId:row.id,evidenceHash:expectedEvidenceHash,operationHash:row.payload.operationHash,decision:body.confirmation.decision}});
     const guard=state=>{evidenceGuard(state);const saved=readExactQuoteApproval({state,auth:a,approvalId:row.id,now:now()});if(hash(saved)!==targetHash)refuse();};
     // A single CAS attempt. Read back an exact lost acknowledgement; never retry.
     if(attempts.has('decide'))refuse();attempts.add('decide');
     try{check();await store.save(a.session.workspaceId,next,{ownedSnapshot:true,beforeEffects:guard,beforeCommit:guard});}catch{/* Reconcile below. */}
    }
    check();const latest=await auth(),fresh=await context(latest),saved=find(latest,fresh.prepared);check();
    if(hash(latest.session)!==hash(a.session)||!saved||hash(saved)!==targetHash)refuse();
    return reply(200,{...view(latest,fresh.prepared,saved),durableDecision:saved.status!=='pending'});
   });
  };
  try{timer=setTimeout(stop,2000);return await Promise.race([job(),cancelled]);}
  catch{return reply(409,{error:'Review outcome unconfirmed; reconcile without retry'});}
  finally{clearTimeout(timer);controller.abort();req.signal.removeEventListener('abort',stop);lifetime.signal.removeEventListener('abort',stop);reader?.cancel().catch(()=>{});}
 }
 return Object.freeze({handle,close});
}
