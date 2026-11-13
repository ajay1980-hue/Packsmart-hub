// Unmounted loopback-only HTTP adapter for synthetic operational-approval rehearsal.
import {createParcel2GoOperationalApprovalRehearsal} from './parcel2go-operational-approval.mjs';
import {parcel2GoCanonicalHash as hash,parcel2GoCanonicalJson as json} from './parcel2go-live-canonical.mjs';
import {assertQuietOwnerWorkspace} from './quiet-owner-workspace.mjs';
import {assertParcel2GoSynchronousCurrent as current} from './parcel2go-live-sync-guard.mjs';
import {metaStrictJson} from './meta-publication-bounded.mjs';
export const PARCEL2GO_APPROVAL_REHEARSAL_PATH='/api/offline/parcel2go-approval-review';
const fail=()=>{throw Error('Approval review unavailable');};
const headers={'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
const reply=(status,value)=>new Response(JSON.stringify(value),{status,headers});
const exact=(x,k)=>x&&Object.keys(x).sort().join('|')===[...k].sort().join('|');
async function readBody(req,signal,check){
 const reader=req.body?.getReader();if(!reader)fail();let stop,timer,poll,size=0,count=0;const chunks=[];
 const cancelled=new Promise((_r,reject)=>{stop=()=>reject(Error('Request closed'));});
 req.signal.addEventListener('abort',stop,{once:true});signal.addEventListener('abort',stop,{once:true});timer=setTimeout(stop,2000);poll=setInterval(()=>{try{check();}catch{stop();}},25);
 try{check();for(;;){const {value,done}=await Promise.race([reader.read(),cancelled]);check();if(done)break;if(!(value instanceof Uint8Array)||!value.byteLength||++count>2048||(size+=value.byteLength)>2048)fail();chunks.push(value);}return metaStrictJson(Buffer.concat(chunks));}
 finally{clearTimeout(timer);clearInterval(poll);req.signal.removeEventListener('abort',stop);signal.removeEventListener('abort',stop);reader.cancel().catch(()=>{});}
}
export function createParcel2GoApprovalOwnerHttp(options={}){
 if((options.mode??'disabled/v1')==='disabled/v1')return Object.freeze({handle:async()=>reply(404,{error:'Unavailable'}),close(){}});
 const {origin,authenticate,readApprovalEvidence}=options;let u;try{u=new URL(origin);}catch{fail();}
 if(options.mode!=='offline-approval-http/v1'||u.origin!==origin||u.protocol!=='http:'||!['127.0.0.1','localhost'].includes(u.hostname)||!u.port||typeof authenticate!=='function'||typeof readApprovalEvidence!=='function'||options.rehearsal?.mode!=='operational-approval-rehearsal/v1')fail();
 const expected=options.expectedEvidenceHash;if(!/^[a-f0-9]{64}$/.test(expected??''))fail();
 const approval=JSON.parse(json(options.rehearsal.approval)),approvalHash=options.rehearsal.expectedApprovalHash;
 const now=options.rehearsal.admission.now??Date.now,assertApprovalCurrent=options.rehearsal.assertApprovalCurrent;
 const input=JSON.parse(json(options.input)),monotonic=options.rehearsal.admission.monotonic??(()=>performance.now()),start=now(),mono=monotonic(),expiry=Date.parse(approval.expiresAt);let last=start,lastMono=mono;let closed=false;const controller=new AbortController();let runner;
 const close=()=>{closed=true;controller.abort();runner?.close();};
 const evidence=()=>{if(closed||now()>=Date.parse(approval.expiresAt))fail();const raw=readApprovalEvidence();if(raw&&typeof raw.then==='function'){Promise.resolve(raw).catch(()=>{});fail();}const e=JSON.parse(json(raw));if(hash(e)!==expected||!exact(e,['schema','evidenceId','approvalId','approvalHash','ownerId','sessionFingerprint','decision','source','recordedAt','revoked'])||e.schema!=='runvara-fixture-owner-approval-evidence/v1'||typeof e.evidenceId!=='string'||!e.evidenceId||e.approvalId!==approval.approvalId||e.approvalHash!==approvalHash||e.ownerId!==approval.ownerId||e.sessionFingerprint!==approval.sessionFingerprint||e.decision!=='approved'||e.source!=='synthetic-owner-event'||e.revoked!==false||e.recordedAt!==approval.issuedAt)fail();};
 runner=createParcel2GoOperationalApprovalRehearsal({...options.rehearsal,assertApprovalCurrent:()=>{evidence();current(assertApprovalCurrent);evidence();}});
 const time=()=>{const t=now(),m=monotonic();if(closed||!Number.isSafeInteger(t)||!Number.isFinite(m)||t<last||m<lastMono||t>=expiry||m-mono>=expiry-start)fail();last=t;lastMono=m;};
 const check=req=>{time();if(req.signal.aborted)fail();evidence();time();if(req.signal.aborted)fail();};
 const owner=auth=>{assertQuietOwnerWorkspace(auth,{inspectEvidence:false});const s=auth.session;if(s?.sub!==approval.ownerId||hash(s)!==approval.sessionFingerprint||!Number.isSafeInteger(s.exp)||s.exp*1000<=now()||auth.state.users.filter(x=>x.id===s.sub&&x.active===true&&x.sessionVersion===s.sessionVersion).length!==1)fail();};
 async function handle(req){try{const url=new URL(req.url);if(closed||url.origin!==origin||url.pathname!==PARCEL2GO_APPROVAL_REHEARSAL_PATH||url.search)return reply(404,{error:'Unavailable'});if(!['GET','POST'].includes(req.method))return reply(405,{error:'Method refused'});if(req.headers.get('sec-fetch-site')&&!['same-origin','none'].includes(req.headers.get('sec-fetch-site')))return reply(403,{error:'Origin refused'});
 check(req);const auth=await authenticate(req);check(req);owner(auth);const view=runner.review(auth.session);
 if(req.method==='GET')return reply(200,view);
 if(req.headers.get('origin')!==origin||req.headers.get('x-csrf-token')!==auth.session.csrf||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers.get('content-type')??''))return reply(403,{error:'Request refused'});
 const confirmation=await readBody(req,controller.signal,()=>check(req));check(req);const abort=()=>close();req.signal.addEventListener('abort',abort,{once:true});let out;
 try{out=await runner.run({session:auth.session,csrf:auth.session.csrf,input,confirmation});}finally{req.signal.removeEventListener('abort',abort);}
 check(req);const latest=await authenticate(req);check(req);owner(latest);if(latest.state._revision!==out.revision)fail();const rows=latest.state.parcel2goLiveQuoteRuns?.filter(x=>x.requestId===approval.requestId);if(rows?.length!==1||rows[0].status!=='completed'||rows[0].projectionHash!==hash(out.quote))fail();return reply(200,out);
 }catch{return reply(409,{error:'Rehearsal outcome unconfirmed; reconcile without retry'});}}
 return Object.freeze({handle,close});
}
