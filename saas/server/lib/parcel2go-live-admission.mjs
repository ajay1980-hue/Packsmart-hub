import {consumeLiveCredentialEntryPermit} from './parcel2go-live-entry-window.mjs';
// Ordinary quote composition remains offline. Native composition is private to
// the default-disabled, unmounted exact-owner candidate at the end of this file.
import {isDeepStrictEqual as same} from 'node:util';
import {assertQuietOwnerWorkspace} from './quiet-owner-workspace.mjs';
import {addAudit} from './events.mjs';
import {parcel2GoCanonicalHash as hash,parcel2GoCanonicalJson as json} from './parcel2go-live-canonical.mjs';
import {parcel2GoWorkspaceFingerprint as workspaceHash} from './parcel2go-workspace-fingerprint.mjs';
import {assertParcel2GoSynchronousCurrent as current} from './parcel2go-live-sync-guard.mjs';
import {prepareParcel2GoLiveQuotePlan} from './parcel2go-live-quote-plan.mjs';
import {sealParcel2GoLiveCredentials,openParcel2GoLiveCredentials} from './parcel2go-live-credentials.mjs';
import {createParcel2GoLiveOrchestration} from './parcel2go-live-orchestration.mjs';
import {createCredentialOwnerAuth} from './parcel2go-credential-owner-auth.mjs';
import {readExactQuoteApproval} from './parcel2go-exact-approval.mjs';
import {parcel2GoLiveWireBody} from './parcel2go-live-quote-wire.mjs';
import {parcel2GoExactReviewSummary} from './parcel2go-exact-input-producer.mjs';
const W='packsmart-solutions',permits=new WeakMap();
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(x);
const fail=code=>{throw Object.assign(new Error('Parcel2Go admission stopped; reconcile without retry.'),{code:'PARCEL2GO_LIVE_'+code,status:409});};
const clone=x=>JSON.parse(json(x));
function actor(state,session,now){try{assertQuietOwnerWorkspace({state,session},{inspectEvidence:false});}catch{fail('OWNER_REQUIRED');}const rows=state.users.filter(u=>u.id===session.sub);if(!uuid(state._revision)||rows.length!==1||rows[0].active!==true||!Number.isSafeInteger(session.sessionVersion)||rows[0].sessionVersion!==session.sessionVersion||!Number.isSafeInteger(session.exp)||session.exp*1000<=now)fail('OWNER_REQUIRED');}
function issue(before,after){const fingerprint=workspaceHash(after);if(before._revision!==after._revision)fail('STATE_CHANGED');for(const k of new Set([...Object.keys(before),...Object.keys(after)]))if(!['connections','parcel2goLiveQuoteRuns','audit'].includes(k)&&!same(before[k],after[k]))fail('PERSISTENCE_INVALID');const p=Object.freeze({});permits.set(p,{revision:after._revision,hash:fingerprint,bytes:Buffer.byteLength(JSON.stringify(before))});return p;}
export function assertParcel2GoLivePersistencePermit(permit,workspaceId,state){const p=permits.get(permit);permits.delete(permit);if(!p||workspaceId!==W)fail('PERSISTENCE_INVALID');const fingerprint=workspaceHash(state);if(state._revision!==p.revision||fingerprint!==p.hash)fail('PERSISTENCE_INVALID');return Object.freeze({currentBytes:p.bytes});}
function create(config={},operation,exactApproval){
 const mode=config.mode??'disabled/v1';if(mode==='disabled/v1')return Object.freeze({run:async()=>fail('DISABLED'),close(){}});
 const native=operation==='quote'&&exactApproval!==undefined;
 if(native){if(mode!=='approved-https-integrated/v1')fail('DISABLED');}
 else if(operation==='admit_credentials'&&mode==='private-credential-admission/v1'){consumeLiveCredentialEntryPermit(config.credentialEntryPermit,config);}else if(mode!==(operation==='quote'?'offline-integrated/v1':'offline-credential-admission/v1'))fail('DISABLED');
 const {store,key,now=Date.now,monotonic=()=>performance.now(),assertCurrent,mockRequest}=config;
 const c=clone({requestId:config.requestId,expectedRevision:config.expectedRevision,trustedBinding:config.trustedBinding,expectedClientId:config.expectedClientId,termsReference:config.termsReference,expiresAt:config.expiresAt,expectedSessionFingerprint:config.expectedSessionFingerprint,...(mode==='private-credential-admission/v1'?{entryReview:{reviewDigest:config.entryReviewDigest,principalEmail:config.principalEmail,accountEvidenceReference:config.accountEvidenceReference,scope:'private_storage_only'}}:{}),...(operation==='quote'?{inputFingerprint:config.inputFingerprint,credentialAdmissionRequestId:config.credentialAdmissionRequestId,expectedCredentialReceiptHash:config.expectedCredentialReceiptHash}:{})});
 if(store?.provider!=='supabase'||typeof store.get!=='function'||typeof store.save!=='function'||!uuid(c.requestId)||!uuid(c.expectedRevision)||!digest(c.expectedSessionFingerprint)||!id(c.termsReference)||typeof assertCurrent!=='function'||typeof key!=='string'||key.length<32||typeof c.expectedClientId!=='string'||c.expectedClientId.length<8)fail('CONFIG_INVALID');
 const b=c.trustedBinding;if(!b||Object.keys(b).sort().join('|')!=='accountId|connectionId|environment|workspaceId'||b.workspaceId!==W||b.environment!=='live'||!id(b.accountId)||!id(b.connectionId))fail('CONFIG_INVALID');
 if(operation==='quote'&&(!digest(c.inputFingerprint)||!uuid(c.credentialAdmissionRequestId)||!digest(c.expectedCredentialReceiptHash)||(native?mockRequest!==undefined:typeof mockRequest!=='function')))fail('CONFIG_INVALID');
 if(operation!=='quote'&&mockRequest!==undefined)fail('CONFIG_INVALID');
 const start=now(),mono=monotonic(),expiry=Date.parse(c.expiresAt);if(!Number.isSafeInteger(start)||!Number.isFinite(mono)||!Number.isFinite(expiry)||new Date(expiry).toISOString()!==c.expiresAt||expiry<=start||expiry-start>300000)fail('EXPIRED');
 let closed=false,attempted=false,last=start,lastMono=mono,runner;
 const close=()=>{closed=true;runner?.close();};
 const check=()=>{const t=now(),m=monotonic();if(closed||!Number.isSafeInteger(t)||!Number.isFinite(m)||t<last||m<lastMono||t>=expiry||m-mono>=expiry-start){close();fail('EXPIRED');}last=t;lastMono=m;try{current(assertCurrent);}catch{close();fail('REVOKED');}return t;};
 const review=(state,session,t,summary)=>{
  if(!native)return;
  const auth={state,session,user:state.users.find(u=>u.id===session.sub)};
  const row=readExactQuoteApproval({state,auth,approvalId:exactApproval.approvalId,now:t}),op=row.payload.operation;
  if(row.status!=='approved'||row.requestIdentity.requestId!==c.requestId||row.payload.operationHash!==exactApproval.operationHash||op.accountId!==b.accountId||op.inputFingerprint!==c.inputFingerprint||!same(op.reviewSummary,summary)||op.credentialReceiptHash!==c.expectedCredentialReceiptHash||op.termsReference!==c.termsReference||op.accountEvidenceReference!==exactApproval.accountEvidenceReference||op.expiresAt!==c.expiresAt)fail('EXACT_APPROVAL_REQUIRED');
  return {approvalId:row.id,operationHash:row.payload.operationHash,decisionHash:hash(row.decisionEvidence)};
 };
 async function run(args={}){
  if(attempted)fail('ATTEMPT_SPENT');attempted=true;
  const session=clone(args.session);if(hash(session)!==c.expectedSessionFingerprint)fail('SESSION_BINDING_INVALID');
  if(typeof session.csrf!=='string'||session.csrf.length<16||args.csrf!==session.csrf)fail('CSRF_REQUIRED');
  const checkSession=()=>{if(hash(args.session)!==c.expectedSessionFingerprint)fail('SESSION_BINDING_INVALID');return check();};
  const summary=native?parcel2GoExactReviewSummary(parcel2GoLiveWireBody(args.input,checkSession())):undefined;
  const validate=s=>{const t=checkSession();actor(s,session,t);review(s,session,t,summary);};
  const read=async()=>{checkSession();const s=await store.get(W,{exactSnapshot:true});validate(s);return s;};
  let state=await read();if(state._revision!==c.expectedRevision)fail('STATE_CHANGED');
  const runs=state.parcel2goLiveQuoteRuns??[];if(!Array.isArray(runs)||runs.length>=20||runs.some(r=>r.requestId===c.requestId||r.status==='reserved'||native&&r.exactApproval?.approvalId===exactApproval.approvalId))fail('ATTEMPT_SPENT');
  const approval=review(state,session,checkSession(),summary);
  const auth=()=>({state,session});
  const connection=()=>{const rows=(state.connections??[]).filter(x=>x.provider==='parcel2go-live'||x.id===b.connectionId);if(rows.length!==1)fail('BINDING_INVALID');const x=rows[0],a=runs.filter(r=>r.requestId===x.metadata?.admissionRequestId);if(x.provider!=='parcel2go-live'||x.id!==b.connectionId||!same(x.metadata,{account:b.accountId,environment:'live',admissionRequestId:x.metadata?.admissionRequestId})||a.length!==1||a[0].operation!=='admit_credentials'||a[0].status!=='completed'||a[0].accountId!==b.accountId||a[0].connectionId!==b.connectionId||x.metadata.admissionRequestId!==c.credentialAdmissionRequestId||hash(a[0])!==c.expectedCredentialReceiptHash||a[0].environment!=='live'||a[0].termsReference!==c.termsReference||!digest(a[0].admissionSessionFingerprint)||a[0].fingerprint!==hash(['live-credential-admission/v1',b,a[0].admissionSessionFingerprint])||a[0].connectionHash!==hash(x))fail('BINDING_INVALID');return {schema:'runvara-parcel2go-live-credentials/v1',binding:b,encryptedCredentials:x.encryptedCredentials};};
  let sealed,envelope;
  if(operation==='admit_credentials'){if((state.connections??[]).some(x=>x.provider==='parcel2go-live'||x.id===b.connectionId))fail('CONNECTION_EXISTS');if(args.credentials?.clientId!==c.expectedClientId)fail('BINDING_INVALID');sealed=sealParcel2GoLiveCredentials({auth:auth(),trustedBinding:b,value:args.credentials,key,now:checkSession()});}
  else{if(prepareParcel2GoLiveQuotePlan(args.input,checkSession()).fingerprint!==c.inputFingerprint)fail('INPUT_CHANGED');envelope=connection();openParcel2GoLiveCredentials({auth:auth(),trustedBinding:b,envelope,key,expectedClientId:c.expectedClientId,now:checkSession()});}
  const save=async(from,to)=>{const permit=issue(from,to);try{return await store.save(W,to,{ownedSnapshot:true,parcel2goLivePermit:permit,beforeEffects:validate,beforeCommit:validate});}catch{fail('SAVE_OUTCOME_UNKNOWN');}};
  const claim=structuredClone(state);claim.parcel2goLiveQuoteRuns=[...runs,{requestId:c.requestId,operation,connectionId:b.connectionId,accountId:b.accountId,environment:'live',status:'reserved',termsReference:c.termsReference,...(c.entryReview?{entryReview:c.entryReview}:{}),expiresAt:c.expiresAt,fingerprint:hash([operation==='quote'?'live-quote-admission/v1':'live-credential-admission/v1',operation==='quote'?c.inputFingerprint:b,c.expectedSessionFingerprint])}];
  if(approval)claim.parcel2goLiveQuoteRuns.at(-1).exactApproval=approval;
  const auditDetail={requestId:c.requestId,operation,...(approval?{approvalId:approval.approvalId,operationHash:approval.operationHash}:{})};
  // Credential storage has no provider side effect between reservation and
  // completion. Persist the connection, completed receipt and both audit events
  // in one CAS; never leave a newly reserved credential row without its envelope.
  // Existing reserved rows are still rejected above, including expired ones.
  if(sealed){
   try{
    claim.connections=[...(claim.connections??[]),{id:b.connectionId,provider:'parcel2go-live',metadata:{account:b.accountId,environment:'live',admissionRequestId:c.requestId},encryptedCredentials:sealed.encryptedCredentials}];
    claim.parcel2goLiveQuoteRuns=claim.parcel2goLiveQuoteRuns.map(r=>r.requestId===c.requestId?{...r,status:'completed',completedAt:new Date(checkSession()).toISOString(),admissionSessionFingerprint:c.expectedSessionFingerprint,connectionHash:hash(claim.connections.find(x=>x.id===b.connectionId))}:r);
    addAudit(claim,{type:'parcel2go_live_reserved',actor:'owner',detail:auditDetail});
    addAudit(claim,{type:'parcel2go_live_completed',actor:'owner',detail:auditDetail});
    state=await save(state,claim);
    const confirmed=await read();if(!same(confirmed,state))fail('STATE_CHANGED');
    return Object.freeze({requestId:c.requestId,revision:state._revision,status:'completed',fixture:true,quote:null,liveReady:false,purchaseAllowed:false});
   }finally{close();}
  }
  addAudit(claim,{type:'parcel2go_live_reserved',actor:'owner',detail:auditDetail});state=await save(state,claim);
  const fresh=async()=>{const s=await read();if(!same(s,state))fail('STATE_CHANGED');};
  await fresh();let projection;
  try{
   if(operation==='quote'){runner=createParcel2GoLiveOrchestration({mode:native?'approved-https-orchestration/v1':'offline-orchestration/v1',expectedSessionFingerprint:c.expectedSessionFingerprint,mockRequest,now,monotonic});const result=await runner.run({input:args.input,expectedPlanFingerprint:c.inputFingerprint,auth:auth(),trustedBinding:b,envelope,key,expectedClientId:c.expectedClientId,requestId:c.requestId,expiresAt:c.expiresAt,assertCurrent:()=>{checkSession();},refreshCurrent:fresh});projection=result.result;}
   await fresh();const final=structuredClone(state);
   if(sealed)final.connections=[...(final.connections??[]),{id:b.connectionId,provider:'parcel2go-live',metadata:{account:b.accountId,environment:'live',admissionRequestId:c.requestId},encryptedCredentials:sealed.encryptedCredentials}];
   final.parcel2goLiveQuoteRuns=final.parcel2goLiveQuoteRuns.map(r=>r.requestId===c.requestId?{...r,status:'completed',completedAt:new Date(checkSession()).toISOString(),...(projection?{projectionHash:hash(projection),quoteCount:projection.quotes.length}:{admissionSessionFingerprint:c.expectedSessionFingerprint,connectionHash:hash(final.connections.find(x=>x.id===b.connectionId))})}:r);
   addAudit(final,{type:'parcel2go_live_completed',actor:'owner',detail:auditDetail});state=await save(state,final);await fresh();
   return Object.freeze({requestId:c.requestId,revision:state._revision,status:'completed',fixture:!native,quote:projection??null,liveReady:false,purchaseAllowed:false});
  }finally{close();}
 }
 return Object.freeze({run,close});
}
export const createParcel2GoLiveAdmission=config=>create(config,'quote');
export const createParcel2GoLiveCredentialAdmission=config=>create(config,'admit_credentials');

// Host-only candidate: no route, environment flag, approval creation or entitlement
// verifier. The host must pin the reviewed operation and post-decision revision.
// Existing synthetic derivation is NOT independent evidence of API eligibility.
export function createParcel2GoExactQuoteCandidate(options={}){
 const refuse=()=>fail('EXACT_CANDIDATE_UNAVAILABLE');
 if((options.mode??'disabled/v1')==='disabled/v1')return Object.freeze({run:async()=>refuse(),close(){}});
 const {origin,sessionSecret,withWorkspaceLock}=options;
 if(options.mode!=='unmounted-exact-https-candidate/v1'||typeof withWorkspaceLock!=='function'||typeof origin!=='string'||new URL(origin).origin!==origin||!origin.startsWith('https://'))refuse();
 const supplied=options.admission??{};
 if((supplied.mode??'disabled/v1')!=='disabled/v1'||supplied.mockRequest!==undefined||typeof supplied.assertCurrent!=='function')refuse();
 const c={...supplied,trustedBinding:clone(supplied.trustedBinding)},exact=clone(options.exactApproval);
 if(Object.keys(exact).sort().join('|')!=='accountEvidenceReference|approvalId|operationHash'||!/^approval_[a-f0-9-]{36}$/.test(exact.approvalId)||!digest(exact.operationHash)||!id(exact.accountEvidenceReference))refuse();
 const now=c.now??Date.now,monotonic=c.monotonic??(()=>performance.now());
 const start=now(),mono=monotonic(),expiry=Date.parse(c.expiresAt);
 if(!Number.isSafeInteger(start)||!Number.isFinite(mono)||!Number.isFinite(expiry)||expiry<=start||expiry-start>300000)refuse();
 const authenticate=createCredentialOwnerAuth({enabled:true,store:c.store,sessionSecret,now});
 let spent=false,closed=false,last=start,lastMono=mono,runner;
 const close=()=>{closed=true;runner?.close();};
 const clock=signal=>{const t=now(),m=monotonic();if(closed||signal?.aborted||!Number.isSafeInteger(t)||!Number.isFinite(m)||t<last||m<lastMono||t>=expiry||m-mono>=expiry-start)refuse();last=t;lastMono=m;};
 const guard=signal=>{clock(signal);current(c.assertCurrent);clock(signal);};
 async function run(request={}){
  if(spent||closed)refuse();spent=true;
  const signal=request.signal,abort=()=>close();
  try{
   signal?.addEventListener('abort',abort,{once:true});guard(signal);
   const headers={...request.headers},input=clone(request.input),confirmation=clone(request.confirmation);
   if(headers.origin!==origin||headers['sec-fetch-site']&&!['same-origin','none'].includes(headers['sec-fetch-site'])||Object.keys(confirmation).sort().join('|')!=='approvalId|confirmed|operationHash|requestId'||confirmation.confirmed!==true||confirmation.requestId!==c.requestId||confirmation.approvalId!==exact.approvalId||confirmation.operationHash!==exact.operationHash)refuse();
   const req={headers,signal},initial=await authenticate(req);guard(signal);
   if(hash(initial.session)!==c.expectedSessionFingerprint||typeof initial.session.csrf!=='string'||initial.session.csrf.length<16||headers['x-csrf-token']!==initial.session.csrf)refuse();
   return await withWorkspaceLock(W,async()=>{
    guard(signal);const auth=await authenticate(req);guard(signal);
    if(hash(auth.session)!==hash(initial.session))refuse();
    runner=create({...c,mode:'approved-https-integrated/v1',assertCurrent:()=>guard(signal)},'quote',exact);
    const result=await runner.run({session:auth.session,csrf:auth.session.csrf,input});guard(signal);return result;
   });
  }catch{refuse();}finally{close();signal?.removeEventListener('abort',abort);}
 }
 return Object.freeze({run,close});
}
