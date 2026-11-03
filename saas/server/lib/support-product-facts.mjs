// Proposed saved-catalogue projection. No transport, model, credentials or writes.
import {createBundleRosterValidator,PACKSMART_BUNDLE_POLICY} from './support-bundle-policy.mjs';
export const SUPPORT_PRODUCT_WORKSPACE='packsmart-solutions';
export const SUPPORT_PRODUCT_ACCOUNT='gid://shopify/Shop/105939173710';
export const SUPPORT_PRODUCT_DOMAIN='wavtzm-vy.myshopify.com';
export const PRODUCT_ONLY_SUPPORT_PATH='/api/public/support/products';
export const SUPPORT_PRODUCT_LIMITS=Object.freeze({products:200,variants:1000,variantsPerProduct:50,bytes:2097152,maxAgeMs:86400000});
const projections=new WeakSet();
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
const skuValid=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(x);
const timestamp=(value,now)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  &&Number.isFinite(now)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value&&Date.parse(value)<=now&&now-Date.parse(value)<=SUPPORT_PRODUCT_LIMITS.maxAgeMs;
const scoped=(row)=>['workspaceId','workspace_id','tenantId','tenant_id'].every(k=>row[k]===undefined||row[k]===SUPPORT_PRODUCT_WORKSPACE)
  &&['workspace','tenant'].every(k=>row[k]===undefined||row[k]===SUPPORT_PRODUCT_WORKSPACE||plain(row[k])&&row[k].id===SUPPORT_PRODUCT_WORKSPACE);
const source=(s,type,id,now)=>plain(s)&&scoped(s)&&s.system==='shopify'&&s.accountId===SUPPORT_PRODUCT_ACCOUNT&&s.domain===SUPPORT_PRODUCT_DOMAIN
  &&s.apiVersion==='2026-07'&&s.objectType===type&&s.recordId===id&&s.currencySource==='Shop.currencyCode'&&timestamp(s.capturedAt,now);
const identity=(id,type)=>typeof id==='string'&&new RegExp('^gid://shopify/'+type+'/[0-9]{1,30}$').test(id);
const unavailable=()=>Object.assign(new Error('Saved product information is unavailable'),{status:503,code:'SUPPORT_UNAVAILABLE'});

// Deliberately no free-text intent routing or order/customer fields. This
// transport accepts one opaque SKU and cannot dispatch a saved-order lookup.
export function validateProductOnlyInput(body){
  if(!plain(body)||Object.keys(body).length!==1||!Object.hasOwn(body,'sku')||!skuValid(body.sku)) {
    throw Object.assign(new Error('Product-only support accepts exactly one SKU and no other fields'),{status:400,code:'PRODUCT_ONLY_INPUT_INVALID'});
  }
  return body.sku;
}

export function productOnlySupportReply(facts){
  return supportProductReply(facts)||{intent:'product',reply:'I cannot verify product facts from the available saved evidence. Check the product page or contact Packsmart. This product-only check does not look up orders or send messages.',needsHuman:true,needsOrderDetails:false};
}

// Exact, explicit syntax only; no fuzzy SKU matching or selection from a title.
export function supportProductSku(message){
  if(typeof message!=='string'||message.length>1200)return null;
  const labels=[...message.matchAll(/\bSKU\s*:/gi)];
  const matches=[...message.matchAll(/\bSKU\s*:\s*([A-Za-z0-9][A-Za-z0-9_-]{0,79})(?=$|[\s,.?!;])/gi)];
  return labels.length===1&&matches.length===1?matches[0][1]:null;
}

function verifiedPack(v,now){
  // This is a proposed internal evidence contract, NOT a field the current
  // Shopify importer creates. No title/SKU/stock arithmetic is a substitute.
  const e=v.packQuantityEvidence;
  if(!plain(e)||e.schema!=='runvara-pack-quantity-evidence/v1'||e.verified!==true||!scoped(e)
    ||e.workspaceId!==SUPPORT_PRODUCT_WORKSPACE||e.unit!=='items_per_sellable_pack'
    ||!Number.isSafeInteger(e.quantity)||e.quantity<1||e.quantity>1000000
    ||e.variantId!==v.id||e.sku!==v.sku||e.basis!=='explicit_source_quantity'
    ||typeof e.evidenceRef!=='string'||!/^source:[A-Za-z0-9_/-]{1,120}$/.test(e.evidenceRef)
    ||!source(e.source,'ProductVariant',v.id,now)||e.source.capturedAt!==v.source.capturedAt)return null;
  return e.quantity;
}

export function supportProductProjection(workspaceId,products,sku,{now=Date.now()}={}){
  if(workspaceId!==SUPPORT_PRODUCT_WORKSPACE||!skuValid(sku)||!Array.isArray(products)||products.length>SUPPORT_PRODUCT_LIMITS.products)throw unavailable();
  let bytes;try{bytes=Buffer.byteLength(JSON.stringify(products));}catch{throw unavailable();}
  if(bytes>SUPPORT_PRODUCT_LIMITS.bytes)throw unavailable();
  const candidates=[],productIds=new Set(),variantIds=new Set();let total=0;
  for(const p of products){
    if(!plain(p)||!Array.isArray(p.variants)||p.variants.length>SUPPORT_PRODUCT_LIMITS.variantsPerProduct)throw unavailable();
    if(!identity(p.id,'Product')||productIds.has(p.id))throw unavailable();productIds.add(p.id);
    for(const v of p.variants){
      if(!plain(v)||!identity(v.id,'ProductVariant')||variantIds.has(v.id)||++total>SUPPORT_PRODUCT_LIMITS.variants)throw unavailable();
      variantIds.add(v.id);if(v.sku===sku)candidates.push({p,v});
    }
  }
  // Even an ineligible duplicate blocks choosing the first matching SKU.
  if(candidates.length!==1)return null;
  const {p,v}=candidates[0],c=p.catalogueClassification;
  if(!scoped(p)||!scoped(v)||p.provider!=='shopify'||p.externalId!==p.id||v.externalId!==v.id||p.status!=='active'||p.catalogueObserved!==true
    ||!source(p.source,'Product',p.id,now)||!source(v.source,'ProductVariant',v.id,now)||p.source.capturedAt!==v.source.capturedAt
    ||!plain(c)||c.kind!=='retail'||c.retailVerified!==true||c.basis!=='source_product_type'
    ||p.productType!=='Retail'||!plain(p.raw)||p.raw.id!==p.id||p.raw.status!=='ACTIVE'||p.raw.productType!=='Retail'
    ||/^(RAW|PACK)[-_]/i.test(v.sku)||v.requiresComponents!==false)return null;
  // First contract is the verified Packsmart GBP source, not a GBP fallback.
  if(p.currency!=='GBP'||v.currency!=='GBP'||typeof v.priceDecimal!=='string'||!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(v.priceDecimal)
    ||!plain(v.raw)||v.raw.id!==v.id||v.raw.sku!==v.sku||v.raw.price!==v.priceDecimal||v.raw.requiresComponents!==false)return null;
  const facts=Object.freeze({schema:'runvara-support-product-facts/v1',workspaceId,productId:p.id,variantId:v.id,sku,
    sourceAccountId:SUPPORT_PRODUCT_ACCOUNT,sourceDomain:SUPPORT_PRODUCT_DOMAIN,capturedAt:v.source.capturedAt,
    priceDecimal:v.priceDecimal,currency:v.currency,packQuantity:verifiedPack(v,now)});
  projections.add(facts);return facts;
}

export function supportProductReply(facts,{now=Date.now()}={}){
  if(!plain(facts)||!projections.has(facts)||!timestamp(facts.capturedAt,now))return null;
  const quantity=facts.packQuantity===null?'Pack quantity is not verified; check the product page or contact Packsmart.':`Verified saved pack quantity: ${facts.packQuantity} items per sellable pack.`;
  return {intent:'product',reply:`Saved catalogue evidence for SKU ${facts.sku}: listed variant price ${facts.currency} ${facts.priceDecimal}, captured ${facts.capturedAt}. ${quantity} Confirm current price, availability, tax and delivery at checkout. This is not a live stock check.`,
    needsHuman:facts.packQuantity===null,needsOrderDetails:false,source:'saved_catalogue'};
}

// Production store uses only this complete-roster path. The older proposed
// single-retail-record helper above remains pure compatibility/test code and
// cannot admit a public store response or override this pinned policy.
export function createBundleSupportProjection(policy){
  const validate=createBundleRosterValidator(policy);
  return (workspaceId,products,sku,{now=Date.now(),context}={})=>{
    if(workspaceId!==SUPPORT_PRODUCT_WORKSPACE||!skuValid(sku)||!Array.isArray(products)||products.length>SUPPORT_PRODUCT_LIMITS.products)throw unavailable();
    let bytes;try{bytes=Buffer.byteLength(JSON.stringify(products));}catch{throw unavailable();}if(bytes>SUPPORT_PRODUCT_LIMITS.bytes)throw unavailable();
    let matching=0;for(const p of products){if(!plain(p)||!Array.isArray(p.variants))throw unavailable();for(const v of p.variants){if(!plain(v))throw unavailable();if(v.sku===sku)matching++;}}
    if(matching!==1||context?.workspaceId!==workspaceId)return null;
    const roster=validate(products,context,{now}),row=roster?.find(v=>v.sku===sku);if(!row)return null;
    const facts=Object.freeze({schema:'runvara-support-product-facts/v1',workspaceId,productId:row.productId,variantId:row.variantId,sku,
      sourceAccountId:SUPPORT_PRODUCT_ACCOUNT,sourceDomain:SUPPORT_PRODUCT_DOMAIN,capturedAt:row.capturedAt,
      priceDecimal:row.priceDecimal,currency:row.currency,packQuantity:row.packQuantity});
    projections.add(facts);return facts;
  };
}
export const supportBundleProductProjection=createBundleSupportProjection(PACKSMART_BUNDLE_POLICY);
