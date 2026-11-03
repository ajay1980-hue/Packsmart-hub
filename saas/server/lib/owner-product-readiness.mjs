import {createBundleRosterValidator,PACKSMART_BUNDLE_POLICY} from './support-bundle-policy.mjs';

export const OWNER_PRODUCT_READINESS_PATH='/api/owner/product-readiness';
export const OWNER_PRODUCT_READINESS_FLAG='RUNVARA_QUIET_OWNER_PRODUCT_READINESS';
const WORKSPACE='packsmart-solutions',MAX_BYTES=2097152,MAX_AGE=86400000;
const unavailable=()=>Object.assign(new Error('Saved product readiness is unavailable'),{status:503,code:'PRODUCT_READINESS_UNAVAILABLE'});
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
function plainData(root){
  const seen=new Set(),pending=[root];let count=0;
  while(pending.length){
    const value=pending.pop();
    if(value===null||typeof value==='string'||typeof value==='boolean'||value===undefined)continue;
    if(typeof value==='number'){if(!Number.isFinite(value))return false;continue;}
    if(typeof value!=='object'||seen.has(value)||++count>100000)return false;
    seen.add(value);
    if(![Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(value)))return false;
    for(const key of Reflect.ownKeys(value)){
      const d=Object.getOwnPropertyDescriptor(value,key);
      if(typeof key!=='string'||!Object.hasOwn(d,'value'))return false;
      pending.push(d.value);
    }
  }
  return true;
}
const iso=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  &&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value.replace(/(?<!\.\d{3})Z$/,'.000Z');

// An explicit pure policy dependency supports synthetic fixtures. The live
// store calls only the pinned export below, never request/config-supplied policy.
export function createOwnerProductReadinessProjection(policy){
  const validate=createBundleRosterValidator(policy);
  return function project(workspaceId,products,context,{now=Date.now()}={}){
    try{
      if(workspaceId!==WORKSPACE||!plainData(products)||!plainData(context)||context?.workspaceId!==WORKSPACE||!Number.isSafeInteger(now)||now<0
        ||!Array.isArray(products)||products.length>200
        ||Buffer.byteLength(JSON.stringify({products,context}))>MAX_BYTES)throw unavailable();
      const counts=new Map();let variants=0;
      for(const p of products){
        if(!p||!Array.isArray(p.variants)||p.variants.length>50)throw unavailable();
        for(const v of p.variants){if(!v||++variants>1000)throw unavailable();if(typeof v.sku==='string')counts.set(v.sku,(counts.get(v.sku)||0)+1);}
      }
      const captured=iso(context.sourceCapturedAt)&&Date.parse(context.sourceCapturedAt)<=now?context.sourceCapturedAt:null;
      const result={schema:'runvara-owner-product-readiness/v1',status:'not_ready',code:'CATALOGUE_UNVERIFIED',
        nextStep:'review_evidence',checkedAt:new Date(now).toISOString(),sourceCapturedAt:captured,
        sourceCurrency:null,verifiedProductCount:0,verifiedVariantCount:0,
        snapshotRevisionPresent:uuid(context.revision),receiptPresent:uuid(context.requestId),
        livePriceVerified:false,credentialUsability:'not_checked',permitsImport:false,permitsPublicSupport:false};
      const finish=(code,nextStep)=>Object.freeze({...result,code,nextStep});
      // Unknown or reserved outcomes need reconciliation, never a new import.
      if(context.status!==null&&context.status!==undefined&&context.status!=='imported')return finish('IMPORT_OUTCOME_UNRESOLVED','reconcile_existing_import');
      if(!result.receiptPresent||context.status!=='imported')return finish('IMPORT_RECEIPT_UNVERIFIED','reconcile_existing_import');
      if(!result.snapshotRevisionPresent||!uuid(context.sourceRevision))return finish('ENRICHED_RECEIPT_REQUIRED','review_evidence');
      if(!captured||![context.startedAt,context.completedAt].every(x=>iso(x)&&Date.parse(x)<=now)
        ||Date.parse(context.startedAt)>Date.parse(captured)||Date.parse(captured)>Date.parse(context.completedAt))return finish('SOURCE_TIME_INVALID','review_evidence');
      if([captured,context.startedAt,context.completedAt].some(x=>now-Date.parse(x)>MAX_AGE))return finish('SOURCE_EVIDENCE_STALE','review_fresh_import');
      const rows=validate(products,context,{now});
      if(!rows||rows.some(row=>counts.get(row.sku)!==1))return Object.freeze(result);
      return Object.freeze({...result,status:'ready_for_trial_review',code:'VERIFIED_SAVED_EVIDENCE',nextStep:'separate_trial_review',
        sourceCurrency:'GBP',verifiedProductCount:new Set(rows.map(row=>row.productId)).size,verifiedVariantCount:rows.length});
    }catch{throw unavailable();}
  };
}
export const ownerProductReadinessProjection=createOwnerProductReadinessProjection(PACKSMART_BUNDLE_POLICY);
