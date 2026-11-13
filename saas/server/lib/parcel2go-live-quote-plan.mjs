// Pure preparation only. Submitted account evidence is NOT an approval or proof
// of API eligibility. No storage, credentials, routes or transport are used.
import {parcel2GoCanonicalJson,parcel2GoCanonicalHash} from './parcel2go-live-canonical.mjs';
const fail=()=>{throw Object.assign(new Error('Parcel2Go live quote preparation refused.'),{code:'PARCEL2GO_LIVE_PLAN_INVALID'});};
const exact=(x,keys)=>{if(!x||Array.isArray(x)||Object.keys(x).sort().join('|')!==keys.split(' ').sort().join('|'))fail();};
const text=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(x);
const time=x=>{if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x)||!Number.isFinite(Date.parse(x))||new Date(x).toISOString()!==x)fail();return Date.parse(x);};
const measured=(v,max)=>{if(typeof v!=='string'||!/^(0|[1-9][0-9]*)(\.[0-9]{1,3})?$/.test(v)||Number(v)<=0||Number(v)>max)fail();};
export function prepareParcel2GoLiveQuotePlan(value,now=Date.now()){
 let input;try{input=JSON.parse(parcel2GoCanonicalJson(value));}catch{fail();}
 if(!Number.isSafeInteger(now)||now<0)fail();
 exact(input,'operation account parcel route');if(input.operation!=='quote')fail();
 const a=input.account,p=input.parcel,r=input.route;
 exact(a,'workspaceId accountId environment currency collectionVatStatus deliveryVatStatus verifiedAt');
 if(a.workspaceId!=='packsmart-solutions'||!text(a.accountId)||a.environment!=='live'||a.currency!=='GBP')fail();
 if(!['Individual','NotRegistered','Registered'].includes(a.collectionVatStatus)||!['Individual','NotRegistered','Registered'].includes(a.deliveryVatStatus))fail();
 exact(p,'evidenceId provenance observedAt weightGrams lengthMm widthMm heightMm declaredValueDecimal');
 if(!text(p.evidenceId)||!['measured_packed_parcel','owner_authorised_estimate'].includes(p.provenance))fail();
 const verified=time(a.verifiedAt),observed=time(p.observedAt);
 if(verified>now||observed>now||now-verified>=86400000||now-observed>=86400000)fail();
 measured(p.weightGrams,1000000);for(const k of ['lengthMm','widthMm','heightMm'])measured(p[k],10000);
 if(typeof p.declaredValueDecimal!=='string'||!/^(0|[1-9][0-9]{0,5})\.[0-9]{2}$/.test(p.declaredValueDecimal))fail();
 exact(r,'collectionCountry deliveryCountry collectionPostcode deliveryPostcode');
 if(r.collectionCountry!=='GBR'||r.deliveryCountry!=='GBR')fail();
 for(const k of ['collectionPostcode','deliveryPostcode'])if(typeof r[k]!=='string'||!/^(GIR 0AA|[A-Z]{1,2}[0-9][A-Z0-9]? [0-9][A-Z]{2})$/.test(r[k]))fail();
 const data={schema:'runvara-parcel2go-live-quote-plan/v1',...input,estimate:p.provenance==='owner_authorised_estimate',expiresAt:new Date(Math.min(verified,observed)+86400000).toISOString()};
 // Fingerprint does not depend on call time: fresh rereads of identical evidence
 // must bind the same approval. Expiry is independently checked on every call.
 const plan={...data,fingerprint:parcel2GoCanonicalHash(data),liveReady:false,purchaseAllowed:false,carrierEligibilityVerified:false};
 for(const x of [plan.account,plan.parcel,plan.route,plan])Object.freeze(x);
 return plan;
}
