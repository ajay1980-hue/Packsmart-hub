// Pure, default-off derivation from the existing plan/wire schema and admission
// receipt. It does not establish production API entitlement or owner permission.
import {parcel2GoLiveWireBody} from './parcel2go-live-quote-wire.mjs';
import {parcel2GoCanonicalHash as hash,parcel2GoCanonicalJson as json} from './parcel2go-live-canonical.mjs';
import {assertQuietOwnerWorkspace} from './quiet-owner-workspace.mjs';
import {prepareExactQuoteApproval} from './parcel2go-exact-approval.mjs';
// Shared presentation derived from a validated wire plan, never an entitlement
// assertion. Admission compares this with the exact summary the owner approved.
export function parcel2GoExactReviewSummary({plan,body}){
 const r=plan.route,p=plan.parcel,a=plan.account,w=JSON.parse(body).Parcels[0];
 return {recipient:'Parcel2Go public API; quote request only',collection:`${r.collectionCountry} ${r.collectionPostcode}; VAT status ${a.collectionVatStatus}`,delivery:`${r.deliveryCountry} ${r.deliveryPostcode}; VAT status ${a.deliveryVatStatus}`,parcel:`${w.Weight} kg; length ${w.Length} cm × width ${w.Width} cm × height ${w.Height} cm; declared value GBP ${p.declaredValueDecimal}`,estimateProvenance:`${plan.estimate?'Owner-authorised estimate, not measured':'Measured packed parcel'}; evidence ${p.evidenceId}; observed ${p.observedAt}`};
}
function derive({auth,input,requestId,connectionId,termsReference,accountEvidenceReference,expectedCredentialReceiptHash,now,window}){
 const fail=()=>{throw Error('Trusted quote input unavailable');};
 assertQuietOwnerWorkspace(auth,{inspectEvidence:false});
 const snapshot=JSON.parse(json(input)),{plan,body}=parcel2GoLiveWireBody(snapshot,now);
 const state=auth.state,connections=(state.connections??[]).filter(x=>x.id===connectionId||x.provider==='parcel2go-live');if(connections.length!==1)fail();const connection=connections[0];
 const binding={workspaceId:auth.session.workspaceId,connectionId,accountId:plan.account.accountId,environment:'live'};
 const runs=state.parcel2goLiveQuoteRuns;if(!Array.isArray(runs))fail();const rows=runs.filter(x=>x.requestId===connection.metadata?.admissionRequestId);if(rows.length!==1)fail();const receipt=rows[0];
 if(connection.id!==connectionId||connection.provider!=='parcel2go-live'||connection.metadata?.account!==binding.accountId||connection.metadata?.environment!=='live'||receipt.operation!=='admit_credentials'||receipt.status!=='completed'||receipt.connectionId!==connectionId||receipt.accountId!==binding.accountId||receipt.environment!=='live'||receipt.termsReference!==termsReference||receipt.connectionHash!==hash(connection)||receipt.fingerprint!==hash(['live-credential-admission/v1',binding,receipt.admissionSessionFingerprint])||hash(receipt)!==expectedCredentialReceiptHash)fail();
 const a=plan.account,issuedAt=window?.issuedAt??new Date(now).toISOString(),expiresAt=new Date(Math.min(window?Date.parse(window.expiresAt):now+300000,Date.parse(plan.expiresAt),auth.session.exp*1000)).toISOString();
 const operation={schema:'runvara-exact-quote-operation/v1',workspaceId:binding.workspaceId,ownerId:auth.session.sub,sessionFingerprint:hash(auth.session),accountId:a.accountId,inputFingerprint:plan.fingerprint,credentialReceiptHash:hash(receipt),termsReference,accountEvidenceReference,
 reviewSummary:parcel2GoExactReviewSummary({plan,body}),issuedAt,expiresAt,permission:'one_quote_only',maxTokenRequests:1,maxQuoteRequests:1,maxSpendMinor:0,currency:'GBP',bookingAllowed:false,labelsAllowed:false,collectionsAllowed:false};
 const intent=prepareExactQuoteApproval({mode:'local-contract/v1',requestId,operation,auth,now});
 return Object.freeze({intent,wireBodyHash:hash(JSON.parse(body)),inputFingerprint:plan.fingerprint,operationalExecution:false,accountEntitlementVerified:false});
}

export function deriveExactQuoteApproval(args){
 if(args?.mode!=='synthetic-input-derivation/v1'||args.accountEvidenceReference!==args.expectedAccountEvidenceReference||!/^synthetic[-_.:]/.test(args.accountEvidenceReference??''))throw Error('Trusted quote input unavailable');
 return derive({...args,window:undefined});
}

// Production-shaped preparation contract, not a source verifier. Only a trusted
// host reader may supply the pinned packet; browser JSON must contain references
// only. Whole-package claims are checked for scope, never upgraded into proof.
export function deriveRecordedQuoteApproval({mode='disabled/v1',auth,packet,expectedEvidenceHash,requestId,now}={}){
 const fail=()=>{throw Error('Recorded quote evidence unavailable');};
 const exact=(value,keys)=>{if(!value||Array.isArray(value)||Object.keys(value).sort().join('|')!==keys.split(' ').sort().join('|'))fail();};
 if(mode!=='unmounted-recorded-input/v1'||! /^[a-f0-9]{64}$/.test(expectedEvidenceHash??''))fail();
 const e=JSON.parse(json(packet));if(hash(e)!==expectedEvidenceHash)fail();
 exact(e,'schema workspaceId requestId issuedAt expiresAt connectionId termsReference accountEvidenceReference credentialReceiptHash input packing');
 if(e.schema!=='runvara-parcel2go-recorded-evidence/v1'||e.workspaceId!==auth.session.workspaceId||e.requestId!==requestId)fail();
 for(const key of ['issuedAt','expiresAt'])if(typeof e[key]!=='string'||!Number.isFinite(Date.parse(e[key]))||new Date(e[key]).toISOString()!==e[key])fail();
 if(Date.parse(e.issuedAt)>now||Date.parse(e.expiresAt)<=now||Date.parse(e.expiresAt)<=Date.parse(e.issuedAt)||Date.parse(e.expiresAt)-Date.parse(e.issuedAt)>300000)fail();
 const p=e.packing,m=p?.measurement,s=p?.selection,input=e.input?.parcel;
 exact(p,'workspaceId evidenceId observedAt selection measurement additions');
 exact(s,'packingPlanId units');exact(m,'packingPlanId units scope basis includesOuter weightGrams lengthMm widthMm heightMm');
 if(p.workspaceId!==e.workspaceId||p.evidenceId!==input?.evidenceId||p.observedAt!==input?.observedAt||input?.provenance!=='measured_packed_parcel'||
    typeof s.packingPlanId!=='string'||! /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(s.packingPlanId)||m.packingPlanId!==s.packingPlanId||
    !Number.isSafeInteger(s.units)||s.units<=0||s.units>1000000||m.units!==s.units||m.scope!=='whole_package'||m.basis!=='measured'||m.includesOuter!==true||
    !Array.isArray(p.additions)||p.additions.length||!['weightGrams','lengthMm','widthMm','heightMm'].every(key=>m[key]===input[key]))fail();
 const out=derive({auth,input:e.input,requestId,connectionId:e.connectionId,termsReference:e.termsReference,
  accountEvidenceReference:e.accountEvidenceReference,expectedCredentialReceiptHash:e.credentialReceiptHash,now,window:e});
 return Object.freeze({...out,evidenceHash:expectedEvidenceHash,sourceVerified:false,
  packing:Object.freeze({packingPlanId:s.packingPlanId,units:s.units,scope:m.scope,basis:m.basis,includesOuter:true})});
}
