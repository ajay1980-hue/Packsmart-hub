// Local, unmounted contract. Callers must authenticate cookies, validate origin/CSRF,
// hold the workspace lock and commit returned decisions with the primary revision CAS.
// This module cannot execute a quote or turn a decision into provider authority.
import { randomUUID } from 'node:crypto';
import { parcel2GoCanonicalHash as hash, parcel2GoCanonicalJson as json } from './parcel2go-live-canonical.mjs';
import { assertApprovalRequestActor, createApprovalRequest } from './approval-request.mjs';
import {assertParcel2GoSynchronousCurrent as current} from './parcel2go-live-sync-guard.mjs';
import {prepareParcel2GoLiveQuotePlan} from './parcel2go-live-quote-plan.mjs';
import {parcel2GoWorkspaceFingerprint as workspaceHash} from './parcel2go-workspace-fingerprint.mjs';
import {isDeepStrictEqual as same} from 'node:util';
export const PARCEL2GO_EXACT_APPROVAL_TYPE = 'protected_parcel2go_quote';
const fail=()=>{throw Object.assign(Error('Exact owner quote review required'),{status:409,code:'PARCEL2GO_EXACT_CONSENT_REQUIRED'});};
const exact=(x,keys)=>x&&Object.keys(x).sort().join('|')===keys.sort().join('|');
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const persistencePermits=new WeakMap();
const fields=['schema','workspaceId','ownerId','sessionFingerprint','accountId','inputFingerprint','credentialReceiptHash','termsReference','accountEvidenceReference','reviewSummary','issuedAt','expiresAt','permission','maxTokenRequests','maxQuoteRequests','maxSpendMinor','currency','bookingAllowed','labelsAllowed','collectionsAllowed'];
function operation(value,auth,now){
 const x=JSON.parse(json(value));
 if(!exact(x,fields)||x.schema!=='runvara-exact-quote-operation/v1'||x.workspaceId!==auth.session.workspaceId||x.ownerId!==auth.session.sub||x.sessionFingerprint!==hash(auth.session)||!digest(x.inputFingerprint)||!digest(x.credentialReceiptHash))fail();
 for(const k of ['accountId','termsReference','accountEvidenceReference'])if(typeof x[k]!=='string'||!/^[-a-zA-Z0-9_.:]{1,100}$/.test(x[k]))fail();
 // Human-readable immutable summary, assembled by the trusted producer, not client HTML.
 if(!exact(x.reviewSummary,['recipient','collection','delivery','parcel','estimateProvenance']))fail();
 for(const s of Object.values(x.reviewSummary))if(typeof s!=='string'||!s.trim()||s.length>1000)fail();
 const issued=Date.parse(x.issuedAt),end=Date.parse(x.expiresAt);
 if(!Number.isSafeInteger(now)||!Number.isFinite(issued)||!Number.isFinite(end)||new Date(issued).toISOString()!==x.issuedAt||new Date(end).toISOString()!==x.expiresAt||issued>now||end<=now||end<=issued||end-issued>300000)fail();
 if(x.permission!=='one_quote_only'||x.maxTokenRequests!==1||x.maxQuoteRequests!==1||x.maxSpendMinor!==0||x.currency!=='GBP'||x.bookingAllowed!==false||x.labelsAllowed!==false||x.collectionsAllowed!==false)fail();
 return x;
}
function owner(state,auth){assertApprovalRequestActor(state,auth);if(auth.user.role!=='owner'||auth.user.id!==auth.session.sub)fail();}
export function assertGenericQuoteDecisionAllowed(approval){if(approval?.type===PARCEL2GO_EXACT_APPROVAL_TYPE)fail();}
function quoteInput(value,op,now){
 const input=JSON.parse(json(value)),plan=prepareParcel2GoLiveQuotePlan(input,now);
 if(plan.account.evidenceSource!=='owner_declaration'||plan.account.workspaceId!==op.workspaceId||plan.account.accountId!==op.accountId||plan.fingerprint!==op.inputFingerprint)fail();
 return input;
}
export function prepareExactQuoteApproval({mode='disabled/v1',requestId,operation:input,quoteInput:submitted,auth,now}){
 if(mode!=='local-contract/v1'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId??''))fail();
 const op=operation(input,auth,now),payload={operation:op,operationHash:hash(op)};
 // Owner-entered values are persisted in the same immutable approval payload.
 // They are hash-bound to the plan; this does not upgrade them into verified data.
 if(submitted!==undefined)payload.quoteInput=quoteInput(submitted,op,now);
 const approval={id:`approval_${randomUUID()}`,type:PARCEL2GO_EXACT_APPROVAL_TYPE,workspaceId:op.workspaceId,action:'Review one Parcel2Go quote only',reason:'Exact owner review; no booking or spending',financialImpact:0,expectedBenefit:'Compare delivery prices',risk:'Parcel details transmitted only after separate operational admission',source:'parcel2go-exact-review',payload,evidence:[],agentId:auth.session.sub,requestedBy:auth.session.sub,revision:1,history:[],status:'pending',workStatus:'REQUIRES APPROVAL',createdAt:new Date(now).toISOString(),decidedAt:null,decidedBy:null,executedExternally:false,executionStatus:'not_connected'};
 return {requestId,approval,contentSha256:hash({type:approval.type,payload})};
}
export async function createExactQuoteApproval({mode='disabled/v1',store,auth,intent,now=Date.now,assertCurrent=()=>{},assertEvidenceCurrent,primaryOnly=false,refreshAuth,onConfirmed}){
 if(mode!=='local-contract/v1'||auth.user.role!=='owner'||auth.user.id!==auth.session.sub)fail();
 const consolidated=refreshAuth!==undefined;
 if(consolidated&&(!primaryOnly||!auth.state||typeof refreshAuth!=='function'||typeof onConfirmed!=='function'||typeof assertEvidenceCurrent!=='function')||!consolidated&&onConfirmed!==undefined)fail();
 const frozen=JSON.parse(json(intent));
 if(frozen.contentSha256!==hash({type:frozen.approval?.type,payload:frozen.approval?.payload})||frozen.approval?.status!=='pending'||frozen.approval?.decidedAt!==null||frozen.approval?.decidedBy!==null||frozen.approval?.executedExternally!==false||frozen.approval?.executionStatus!=='not_connected')fail();
 const check=state=>{current(assertCurrent);if(state&&assertEvidenceCurrent!==undefined)current(()=>assertEvidenceCurrent(state));current(assertCurrent);};
 let confirmedAuth;
 const readBack=async()=>{
  check();const fresh=await refreshAuth();check();
  if(hash(fresh.session)!==hash(auth.session))fail();owner(fresh.state,fresh);
  confirmedAuth=fresh;return fresh.state;
 };
 check();
 const result=await createApprovalRequest({store,auth,intent:frozen,...(consolidated?{initialSnapshot:auth.state,readBack}:{}),admit(state,a){check(state);owner(state,auth);validate(a,auth,now());},beforeSave(state){const guard=state=>{check(state);owner(state,auth);validate(state.approvals.find(a=>a.id===frozen.approval.id),auth,now());};return {...(assertEvidenceCurrent!==undefined?{beforeEffects:guard}:{}),beforeCommit:guard,
  ...(primaryOnly?{parcel2goReviewPermit:issueParcel2GoQuoteReviewPersistencePermit({before:auth.state,after:state,auth,approvalId:frozen.approval.id,now:now()})}:{})};}});
 check();
 if(assertEvidenceCurrent!==undefined||consolidated){
  // Reuse the single post-save authenticated primary read. Even idempotent
  // replay, which bypasses admit/beforeSave/readBack, must refresh its evidence.
  const state=consolidated?(confirmedAuth?.state??await readBack()):await store.get(auth.session.workspaceId,{exactSnapshot:true});check(state);owner(state,auth);
  const rows=state.approvals.filter(a=>a.id===result.approval.id);if(rows.length!==1||hash(rows[0])!==hash(result.approval))fail();
 }
 validate(result.approval,auth,now());
 if(result.approval.requestIdentity?.contentSha256!==hash({type:result.approval.type,payload:result.approval.payload}))fail();
 // Synchronous host callback only, after all checks and outside the save catch.
 // No authentication or workspace state is added to the serializable result.
 if(consolidated){current(()=>onConfirmed(confirmedAuth));check();}
 return result;
}
function validate(a,auth,now){
 if(a?.type!==PARCEL2GO_EXACT_APPROVAL_TYPE||a.revision!==1||a.requestedBy!==auth.session.sub||a.workspaceId!==auth.session.workspaceId||!exact(a.payload,a.payload?.quoteInput!==undefined?['operation','operationHash','quoteInput']:['operation','operationHash']))fail();
 const op=operation(a.payload.operation,auth,now);if(hash(op)!==a.payload.operationHash)fail();
 if(a.payload.quoteInput!==undefined)quoteInput(a.payload.quoteInput,op,now);return op;
}
export function decideExactQuoteApproval({mode='disabled/v1',state,auth,approvalId,confirmation,now}){
 if(mode!=='local-contract/v1')fail(); owner(state,auth);
 const matches=state.approvals.filter(a=>a.id===approvalId);if(matches.length!==1)fail();
 const a=matches[0];validate(a,auth,now);
 const identity=a.requestIdentity;
 if(identity?.schema!=='runvara-approval-request/v1'||identity.workspaceId!==auth.session.workspaceId||identity.actorId!==auth.session.sub||identity.contentSha256!==hash({type:a.type,payload:a.payload}))fail();
 if(a.status!=='pending'||!exact(confirmation,['decision','revision','operationHash'])||!['approved','rejected'].includes(confirmation.decision)||confirmation.revision!==a.revision||confirmation.operationHash!==a.payload.operationHash)fail();
 // Pure copy: caller must CAS-save and exact-read before treating this as durable.
 const next=structuredClone(state),row=next.approvals.find(a=>a.id===approvalId),at=new Date(now).toISOString();
 row.status=confirmation.decision;row.decidedAt=at;row.decidedBy=auth.session.sub;
 row.decisionEvidence={schema:'runvara-exact-quote-decision/v1',operationHash:a.payload.operationHash,sessionFingerprint:hash(auth.session),ownerId:auth.session.sub,workspaceId:auth.session.workspaceId,revision:1,decision:confirmation.decision,at};
 row.history.push({revision:1,status:row.status,actor:auth.session.sub,at});row.workStatus=row.status==='approved'?'BLOCKED':'COMPLETED';
 return next;
}

// Fresh exact reader for the dedicated panel and post-CAS reconciliation only.
export function readExactQuoteApproval({state,auth,approvalId,now}){
 owner(state,auth);const rows=state.approvals.filter(a=>a.id===approvalId);if(rows.length!==1)fail();
 const a=rows[0];validate(a,auth,now);const i=a.requestIdentity;
 if(i?.schema!=='runvara-approval-request/v1'||i.workspaceId!==auth.session.workspaceId||i.actorId!==auth.session.sub||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(i.requestId??'')||i.contentSha256!==hash({type:a.type,payload:a.payload}))fail();
 if(!['pending','approved','rejected'].includes(a.status)||a.executedExternally!==false||a.executionStatus!=='not_connected')fail();
 if(a.status!=='pending'){
 const expected={schema:'runvara-exact-quote-decision/v1',operationHash:a.payload.operationHash,sessionFingerprint:hash(auth.session),ownerId:auth.session.sub,workspaceId:auth.session.workspaceId,revision:1,decision:a.status,at:a.decidedAt};
 const at=Date.parse(a.decidedAt);if(!Number.isFinite(at)||at<Date.parse(a.payload.operation.issuedAt)||at>now||a.decidedBy!==auth.session.sub||hash(a.decisionEvidence)!==hash(expected))fail();
 }
 return structuredClone(a);
}

// One-use, host-only capability for a single protected owner-input review change.
// It cannot change credentials, quote receipts, another approval or unrelated state.
export function issueParcel2GoQuoteReviewPersistencePermit({before,after,auth,approvalId,now}){
 const workspaceId=auth.session.workspaceId;
 if(workspaceId!=='packsmart-solutions'||before._revision!==after._revision)fail();
 owner(before,auth);owner(after,auth);
 for(const key of new Set([...Object.keys(before),...Object.keys(after)]))if(!['approvals','audit'].includes(key)&&!same(before[key],after[key]))fail();
 const row=readExactQuoteApproval({state:after,auth,approvalId,now}),old=before.approvals.filter(a=>a.id===approvalId);
 if(row.payload.operation.accountEvidenceReference!=='owner-declaration'||!row.payload.quoteInput||old.length>1)fail();
 let detail,type;
 if(!old.length){
  if(row.status!=='pending'||row.decidedAt!==null||row.decidedBy!==null||row.decisionEvidence!==undefined||row.history.length||after.approvals[0].id!==approvalId||!same(after.approvals.slice(1),before.approvals))fail();
  const createdAt=Date.parse(row.createdAt);if(!Number.isSafeInteger(createdAt)||createdAt>now)fail();
  const expected=prepareExactQuoteApproval({mode:'local-contract/v1',requestId:row.requestIdentity.requestId,operation:row.payload.operation,quoteInput:row.payload.quoteInput,auth,now:createdAt});
  expected.approval.id=approvalId;expected.approval.requestIdentity={schema:'runvara-approval-request/v1',requestId:expected.requestId,workspaceId,actorId:auth.session.sub,contentSha256:expected.contentSha256};
  if(!same(expected.approval,row))fail();
  type='approval_requested';detail={approvalId,actionType:PARCEL2GO_EXACT_APPROVAL_TYPE,financialImpact:0};
 }else{
  const expected=decideExactQuoteApproval({mode:'local-contract/v1',state:before,auth,approvalId,
   confirmation:{decision:row.status,revision:1,operationHash:row.payload.operationHash},now:Date.parse(row.decidedAt)});
  if(!same(expected.approvals,after.approvals))fail();
  type='parcel2go_exact_decided';detail={requestId:row.requestIdentity.requestId,approvalId,inputSource:'owner_entered',operationHash:row.payload.operationHash,decision:row.status};
 }
 const audit=after.audit?.[0];
 if(!Array.isArray(before.audit)||!Array.isArray(after.audit)||!same(after.audit.slice(1),before.audit)||audit?.type!==type||audit.actor!==auth.session.sub||!same(audit.detail,detail))fail();
 if(!exact(audit,['id','type','actor','detail','createdAt'])||!/^audit_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(audit.id)||before.audit.some(a=>a.id===audit.id)||
  typeof audit.createdAt!=='string'||!Number.isFinite(Date.parse(audit.createdAt))||new Date(audit.createdAt).toISOString()!==audit.createdAt)fail();
 // Exact store reads carry a private non-enumerable persistence marker. Bind
 // the detached JSON snapshot, as the primary-only store commit does.
 const permit=Object.freeze({});persistencePermits.set(permit,{workspaceId,revision:after._revision,hash:workspaceHash(structuredClone(after)),bytes:Buffer.byteLength(JSON.stringify(before))});return permit;
}
export function assertParcel2GoQuoteReviewPersistencePermit(permit,workspaceId,state){
 const p=persistencePermits.get(permit);persistencePermits.delete(permit);
 if(!p||p.workspaceId!==workspaceId||p.revision!==state._revision||p.hash!==workspaceHash(structuredClone(state)))fail();
 return Object.freeze({currentBytes:p.bytes});
}
