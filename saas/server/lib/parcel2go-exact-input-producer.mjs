// Pure, default-off derivation from the existing plan/wire schema and admission
// receipt. It does not establish production API entitlement or owner permission.
import {parcel2GoLiveWireBody} from './parcel2go-live-quote-wire.mjs';
import {parcel2GoCanonicalHash as hash,parcel2GoCanonicalJson as json} from './parcel2go-live-canonical.mjs';
import {assertQuietOwnerWorkspace} from './quiet-owner-workspace.mjs';
import {prepareExactQuoteApproval} from './parcel2go-exact-approval.mjs';
export function deriveExactQuoteApproval({mode='disabled/v1',auth,input,requestId,connectionId,termsReference,accountEvidenceReference,expectedAccountEvidenceReference,expectedCredentialReceiptHash,now}){
 const fail=()=>{throw Error('Trusted quote input unavailable');};
 if(mode!=='synthetic-input-derivation/v1'||accountEvidenceReference!==expectedAccountEvidenceReference||!/^synthetic[-_.:]/.test(accountEvidenceReference??''))fail();
 assertQuietOwnerWorkspace(auth,{inspectEvidence:false});
 const snapshot=JSON.parse(json(input)),{plan,body}=parcel2GoLiveWireBody(snapshot,now);
 const state=auth.state,connections=(state.connections??[]).filter(x=>x.id===connectionId||x.provider==='parcel2go-live');if(connections.length!==1)fail();const connection=connections[0];
 const binding={workspaceId:auth.session.workspaceId,connectionId,accountId:plan.account.accountId,environment:'live'};
 const runs=state.parcel2goLiveQuoteRuns;if(!Array.isArray(runs))fail();const rows=runs.filter(x=>x.requestId===connection.metadata?.admissionRequestId);if(rows.length!==1)fail();const receipt=rows[0];
 if(connection.id!==connectionId||connection.provider!=='parcel2go-live'||connection.metadata?.account!==binding.accountId||connection.metadata?.environment!=='live'||receipt.operation!=='admit_credentials'||receipt.status!=='completed'||receipt.connectionId!==connectionId||receipt.accountId!==binding.accountId||receipt.environment!=='live'||receipt.termsReference!==termsReference||receipt.connectionHash!==hash(connection)||receipt.fingerprint!==hash(['live-credential-admission/v1',binding,receipt.admissionSessionFingerprint])||hash(receipt)!==expectedCredentialReceiptHash)fail();
 const r=plan.route,p=plan.parcel,a=plan.account,w=JSON.parse(body).Parcels[0],issuedAt=new Date(now).toISOString(),expiresAt=new Date(Math.min(now+300000,Date.parse(plan.expiresAt),auth.session.exp*1000)).toISOString();
 const operation={schema:'runvara-exact-quote-operation/v1',workspaceId:binding.workspaceId,ownerId:auth.session.sub,sessionFingerprint:hash(auth.session),accountId:a.accountId,inputFingerprint:plan.fingerprint,credentialReceiptHash:hash(receipt),termsReference,accountEvidenceReference,
 reviewSummary:{recipient:'Parcel2Go public API; quote request only',collection:`${r.collectionCountry} ${r.collectionPostcode}; VAT status ${a.collectionVatStatus}`,delivery:`${r.deliveryCountry} ${r.deliveryPostcode}; VAT status ${a.deliveryVatStatus}`,parcel:`${w.Weight} kg; length ${w.Length} cm × width ${w.Width} cm × height ${w.Height} cm; declared value GBP ${p.declaredValueDecimal}`,estimateProvenance:`${plan.estimate?'Owner-authorised estimate, not measured':'Measured packed parcel'}; evidence ${p.evidenceId}; observed ${p.observedAt}`},issuedAt,expiresAt,permission:'one_quote_only',maxTokenRequests:1,maxQuoteRequests:1,maxSpendMinor:0,currency:'GBP',bookingAllowed:false,labelsAllowed:false,collectionsAllowed:false};
 const intent=prepareExactQuoteApproval({mode:'local-contract/v1',requestId,operation,auth,now});
 return Object.freeze({intent,wireBodyHash:hash(JSON.parse(body)),inputFingerprint:plan.fingerprint,operationalExecution:false,accountEntitlementVerified:false});
}
