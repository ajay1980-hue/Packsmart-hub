// Unmounted approval rehearsal boundary. No HTTPS/provider implementation here.
// A matching hash is a trusted-host pin, NOT proof that a human approved anything.
import {parcel2GoCanonicalHash as hash,parcel2GoCanonicalJson as json} from './parcel2go-live-canonical.mjs';
import {assertParcel2GoSynchronousCurrent as current} from './parcel2go-live-sync-guard.mjs';
import {createParcel2GoLiveAdmission} from './parcel2go-live-admission.mjs';
const refuse=()=>{throw Error('Operational quote approval unavailable; no retry');};
const keys=['schema','approvalId','requestId','expectedRevision','ownerId','sessionFingerprint','binding','inputFingerprint','credentialReceiptHash','termsReference','accountEvidenceReference','issuedAt','expiresAt','permission','maxTokenRequests','maxQuoteRequests','maxSpendMinor','currency','bookingAllowed','labelsAllowed','collectionsAllowed'];
const exact=(x,names)=>x&&Object.keys(x).sort().join('|')===[...names].sort().join('|');
export function createParcel2GoOperationalApprovalRehearsal(options={}){
 if((options.mode??'disabled/v1')==='disabled/v1')return Object.freeze({review:()=>refuse(),run:async()=>refuse(),close(){}});
 if(options.mode!=='operational-approval-rehearsal/v1'||options.admission?.mode!=='offline-integrated/v1'||typeof options.admission.mockRequest!=='function'||typeof options.assertApprovalCurrent!=='function')refuse();
 const c={...options.admission,trustedBinding:JSON.parse(json(options.admission.trustedBinding))},assertApprovalCurrent=options.assertApprovalCurrent,now=c.now??Date.now,monotonic=c.monotonic??(()=>performance.now());
 const a=JSON.parse(json(options.approval)),expected=options.expectedApprovalHash,original=options.approval;
 if(!/^[a-f0-9]{64}$/.test(expected??'')||hash(a)!==expected||!exact(a,keys)||a.schema!=='runvara-quote-approval/v1'||!/^[-a-zA-Z0-9_.:]{1,100}$/.test(a.approvalId)||typeof a.ownerId!=='string'||!a.ownerId||typeof a.accountEvidenceReference!=='string'||!/^[-a-zA-Z0-9_.:]{1,100}$/.test(a.accountEvidenceReference))refuse();
 if(a.requestId!==c.requestId||a.expectedRevision!==c.expectedRevision||a.sessionFingerprint!==c.expectedSessionFingerprint||hash(a.binding)!==hash(c.trustedBinding)||a.inputFingerprint!==c.inputFingerprint||a.credentialReceiptHash!==c.expectedCredentialReceiptHash||a.termsReference!==c.termsReference||a.expiresAt!==c.expiresAt)refuse();
 if(a.permission!=='one_quote_only'||a.maxTokenRequests!==1||a.maxQuoteRequests!==1||a.maxSpendMinor!==0||a.currency!=='GBP'||a.bookingAllowed!==false||a.labelsAllowed!==false||a.collectionsAllowed!==false)refuse();
 const start=now(),mono=monotonic(),issued=Date.parse(a.issuedAt),expiry=Date.parse(a.expiresAt);
 if(!Number.isSafeInteger(start)||!Number.isFinite(mono)||!Number.isFinite(issued)||new Date(issued).toISOString()!==a.issuedAt||!Number.isFinite(expiry)||new Date(expiry).toISOString()!==a.expiresAt||issued>start||expiry<=start||expiry-issued>300000||expiry<=issued)refuse();
 let closed=false,spent=false,last=start,lastMono=mono,runner;
 const close=()=>{closed=true;runner?.close();};
 const validate=()=>{const t=now(),m=monotonic();if(closed||hash(original)!==expected||!Number.isSafeInteger(t)||!Number.isFinite(m)||t<last||m<lastMono||t>=expiry||m-mono>=expiry-start){close();refuse();}last=t;lastMono=m;};
 const check=()=>{validate();try{current(assertApprovalCurrent);}catch{close();refuse();}validate();};
 const review=session=>{check();if(session?.sub!==a.ownerId||hash(session)!==a.sessionFingerprint)refuse();return Object.freeze({schema:'runvara-operational-rehearsal-review/v1',requestId:a.requestId,approvalId:a.approvalId,approvalHash:expected,inputFingerprint:a.inputFingerprint,expiresAt:a.expiresAt,remainingMs:Math.max(0,Math.floor(Math.min(expiry-now(),expiry-start-(monotonic()-mono)))),permission:'one_quote_only',maxSpendMinor:0,currency:'GBP',fixture:true,liveReady:false,bookingAllowed:false,canSubmit:!spent});};
 async function run(args={}){if(spent)refuse();spent=true;try{review(args.session);if(!exact(args.confirmation,['approvalHash','requestId','confirmed'])||args.confirmation.confirmed!==true||args.confirmation.approvalHash!==expected||args.confirmation.requestId!==a.requestId)refuse();runner=createParcel2GoLiveAdmission({...c,assertCurrent:()=>{check();current(c.assertCurrent);}});const result=await runner.run(args);check();return Object.freeze({...result,approvalHash:expected,operationalExecution:false});}finally{close();}}
 return Object.freeze({review,run,close});
}
