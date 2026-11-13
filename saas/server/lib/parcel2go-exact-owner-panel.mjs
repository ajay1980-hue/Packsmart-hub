// Unmounted synthetic-only panel controller, no provider or production config.
// Uses the app's signed-cookie verification; caller supplies primary-CAS store.
import {tokenFromRequest,verifySessionToken} from './security.mjs';
import {readExactQuoteApproval,decideExactQuoteApproval} from './parcel2go-exact-approval.mjs';
import {parcel2GoCanonicalHash as hash} from './parcel2go-live-canonical.mjs';
export function createExactQuoteOwnerPanel({mode='disabled/v1',store,sessionSecret,now=Date.now,monotonic=()=>performance.now()}={}){
 const refuse=()=>{throw Error('Exact quote review unavailable; reconcile without retry');};
 if(mode==='disabled/v1')return Object.freeze({review:async()=>refuse(),decide:async()=>refuse()});
 if(mode!=='synthetic-owner-panel/v1'||store?.provider!=='synthetic-approval'||typeof store.get!=='function'||typeof store.save!=='function'||typeof sessionSecret!=='string'||sessionSecret.length<32)refuse();
 let lastWall=now(),lastMono=monotonic(),closed=false;const deadlines=new Map();
 function clock(){const wall=now(),mono=monotonic();if(closed||!Number.isSafeInteger(wall)||!Number.isFinite(mono)||wall<lastWall||mono<lastMono){closed=true;refuse();}lastWall=wall;lastMono=mono;return {wall,mono};}
 function bounded(row){const {wall,mono}=clock(),key=row.payload.operationHash,end=Date.parse(row.payload.operation.expiresAt);if(!deadlines.has(key))deadlines.set(key,mono+Math.max(0,end-wall));if(wall>=end||mono>=deadlines.get(key))refuse();}
 const locks=new Map();
 async function lock(id,fn){const prior=locks.get(id)??Promise.resolve();let release;const gate=new Promise(r=>release=r),tail=prior.then(()=>gate);locks.set(id,tail);await prior;try{return await fn();}finally{release();if(locks.get(id)===tail)locks.delete(id);}}
 async function auth(req){clock();if(req.signal?.aborted)refuse();const session=verifySessionToken(tokenFromRequest(req,{secure:false,allowBearer:false}),sessionSecret,Math.floor(now()/1000));if(!session||session.role!=='owner')refuse();const state=await store.get(session.workspaceId,{exactSnapshot:true});if(req.signal?.aborted||session.exp*1000<=now())refuse();const users=state.users?.filter(x=>x.id===session.sub);if(users?.length!==1)refuse();return {session,user:users[0],state};}
 function current(req,a){clock();if(req.signal?.aborted||a.session.exp*1000<=now())refuse();}
 const read=(a,id)=>{const row=readExactQuoteApproval({state:a.state,auth:a,approvalId:id,now:now()});bounded(row);return row;};
 function view(row){const op=row.payload.operation;return {schema:'runvara-exact-owner-panel/v1',approvalId:row.id,revision:row.revision,status:row.status,operationHash:row.payload.operationHash,accountId:op.accountId,reviewSummary:op.reviewSummary,termsReference:op.termsReference,accountEvidenceReference:op.accountEvidenceReference,expiresAt:op.expiresAt,remainingMs:Math.max(0,Math.floor(Math.min(Date.parse(op.expiresAt)-now(),deadlines.get(row.payload.operationHash)-monotonic()))),permission:op.permission,maxTokenRequests:1,maxQuoteRequests:1,maxSpendMinor:0,currency:'GBP',bookingAllowed:false,labelsAllowed:false,collectionsAllowed:false,synthetic:true,operationalExecution:false};}
 async function review(req,id){const a=await auth(req);const row=read(a,id);current(req,a);return view(row);}
 async function decide(req,id,confirmation){const initial=await auth(req);return lock(initial.session.workspaceId,async()=>{
 const a=await auth(req);if(hash(a.session)!==hash(initial.session)||req.headers.origin!=='http://127.0.0.1:4173'||req.headers['x-csrf-token']!==a.session.csrf)refuse();
 read(a,id);const next=decideExactQuoteApproval({mode:'local-contract/v1',state:a.state,auth:a,approvalId:id,confirmation,now:now()});const target=next.approvals.find(x=>x.id===id),targetHash=hash(target);
 const guard=snapshot=>{current(req,a);const row=readExactQuoteApproval({state:snapshot,auth:a,approvalId:id,now:now()});bounded(row);if(hash(row)!==targetHash)refuse();};
 // Exactly one save attempt, never replay on conflict/timeout/lost acknowledgement.
 try{current(req,a);await store.save(a.session.workspaceId,next,{ownedSnapshot:true,beforeEffects:()=>current(req,a),beforeCommit:guard});}catch{/* Reconcile exact committed result, do not retry. */}
 const latest=await auth(req),row=read(latest,id);current(req,latest);if(hash(latest.session)!==hash(a.session)||hash(row)!==targetHash)refuse();
 return {...view(row),durableDecision:true};
 });}
 return Object.freeze({review,decide});
}
