// Structured source capture only. No retail policy, transport, or stored attestation.
export const CATALOGUE_SHOP_ID='gid://shopify/Shop/105939173710';
export const CATALOGUE_EVIDENCE_LIMITS=Object.freeze({variantsPerBatch:50,componentsPerVariant:4,optionsPerVariant:3,maxAgeMs:86400000});
export const CATALOGUE_COMPONENT_QUERY=`query RunvaraCatalogueComponents($ids: [ID!]!) {
  shop { id myshopifyDomain currencyCode }
  nodes(ids: $ids) { ... on ProductVariant {
    id sku updatedAt price requiresComponents selectedOptions { name value }
    product { id status onlineStoreUrl updatedAt }
    productVariantComponents(first: 4) {
      pageInfo { hasNextPage hasPreviousPage }
      nodes { id quantity productVariant { id } }
    }
  } }
}`;
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
const fail=()=>{throw Object.assign(new Error('Catalogue structured evidence is incomplete or changed'),{code:'SHOPIFY_CATALOGUE_EVIDENCE_INVALID',status:502});};
const id=(x,type)=>typeof x==='string'&&new RegExp('^gid://shopify/'+type+'/[0-9]{1,30}$').test(x);
const time=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x.replace(/(?<!\.\d{3})Z$/,'.000Z');
const keys=(x,allowed)=>plain(x)&&Object.keys(x).every(k=>allowed.includes(k));
const scoped=(x,context)=>['workspaceId','workspace_id','tenantId','tenant_id'].every(k=>x[k]===undefined||x[k]===context.workspaceId)&&[x.connectionId].every(v=>v===undefined||v===context.connectionId);
export function validateCatalogueEvidenceContext(context,capturedAt,now=Date.now()){
  if(!plain(context)||context.workspaceId!=='packsmart-solutions'||typeof context.connectionId!=='string'||!context.connectionId.trim()||context.connectionId.length>200
    ||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(context.revision||'')
    ||!time(capturedAt)||!Number.isFinite(now)||Date.parse(capturedAt)>now||now-Date.parse(capturedAt)>CATALOGUE_EVIDENCE_LIMITS.maxAgeMs)fail();
}
export function captureSelectedOptions(value){
  if(!Array.isArray(value)||value.length>CATALOGUE_EVIDENCE_LIMITS.optionsPerVariant)fail();
  const seen=new Set();
  for(const option of value){
    if(!keys(option,['name','value'])||typeof option.name!=='string'||!option.name||option.name.length>100||option.name!==option.name.trim()
      ||typeof option.value!=='string'||!option.value||option.value.length>200||seen.has(option.name.toLowerCase()))fail();
    seen.add(option.name.toLowerCase());
  }
  const pack=value.find(x=>x.name==='Pack Size'),match=pack&&/^Pack of ([1-9][0-9]*)$/.exec(pack.value);
  const n=match?Number(match[1]):null,quantity=Number.isSafeInteger(n)&&n>=25&&n<=250&&n%25===0?n:null;
  return {selectedOptions:structuredClone(value),soldPackQuantity:quantity,packOptionStatus:!pack?'not_observed':quantity===null?'unrecognized':'source_option_observed',
    packOption:pack?structuredClone(pack):null,quantityBasis:quantity===null?null:'selectedOptions:Pack Size'};
}
export function inspectCatalogueSourceFields(product,capturedAt){
  if(!time(capturedAt)||!time(product.updatedAt)||Date.parse(product.updatedAt)>Date.parse(capturedAt)||!Object.hasOwn(product,'onlineStoreUrl'))fail();
  if(product.onlineStoreUrl!==null){
    if(typeof product.onlineStoreUrl!=='string'||product.onlineStoreUrl.length>2048)fail();
    let url;try{url=new URL(product.onlineStoreUrl);}catch{fail();}
    if(url.protocol!=='https:'||url.username||url.password||url.hash||!['packsmartsolutions.com','www.packsmartsolutions.com','wavtzm-vy.myshopify.com'].includes(url.hostname))fail();
  }
  for(const v of product.variants.nodes){if(!time(v.updatedAt)||Date.parse(v.updatedAt)>Date.parse(capturedAt))fail();captureSelectedOptions(v.selectedOptions);}
}
export function captureCatalogueVariantEvidence(product,variant,node,{context,shop,capturedAt,now=Date.now()}={}){
  validateCatalogueEvidenceContext(context,capturedAt,now);
  if(!keys(shop,['id','myshopifyDomain','currencyCode'])||shop.id!==CATALOGUE_SHOP_ID||shop.myshopifyDomain!=='wavtzm-vy.myshopify.com'||!/^[A-Z]{3}$/.test(shop.currencyCode)
    ||!plain(product)||!plain(variant)||!keys(node,['id','sku','updatedAt','price','requiresComponents','selectedOptions','product','productVariantComponents'])||!id(product.id,'Product')||!id(variant.id,'ProductVariant')||node.id!==variant.id
    ||!plain(product.source)||!plain(variant.source)||![product,variant,product.source,variant.source].every(x=>scoped(x,context))
    ||product.source.accountId!==shop.id||variant.source.accountId!==shop.id||product.source.domain!==shop.myshopifyDomain||variant.source.domain!==shop.myshopifyDomain||product.currency!==shop.currencyCode||variant.currency!==shop.currencyCode
    ||!keys(node.product,['id','status','onlineStoreUrl','updatedAt'])||node.product.id!==product.id||node.product.status!==product.raw.status||node.product.updatedAt!==product.updatedAt||node.product.onlineStoreUrl!==product.onlineStoreUrl
    ||node.sku!==variant.sku||node.price!==variant.priceDecimal||node.updatedAt!==variant.updatedAt||node.requiresComponents!==variant.requiresComponents
    ||!time(node.updatedAt)||Date.parse(node.updatedAt)>Date.parse(capturedAt)||!time(node.product.updatedAt)||Date.parse(node.product.updatedAt)>Date.parse(capturedAt))fail();
  const options=captureSelectedOptions(node.selectedOptions);
  validateCatalogueEvidenceContext(context,product.source.capturedAt,now);validateCatalogueEvidenceContext(context,variant.source.capturedAt,now);
  if(JSON.stringify(node.selectedOptions)!==JSON.stringify(variant.selectedOptions))fail();
  const c=node.productVariantComponents;
  if(!keys(c,['nodes','pageInfo'])||!keys(c.pageInfo,['hasNextPage','hasPreviousPage'])||c.pageInfo.hasNextPage!==false||c.pageInfo.hasPreviousPage!==false
    ||!Array.isArray(c.nodes)||c.nodes.length>CATALOGUE_EVIDENCE_LIMITS.componentsPerVariant)fail();
  const relations=new Set(),variants=new Set();
  const components=Array.from(c.nodes,x=>{
    if(!keys(x,['id','quantity','productVariant'])||typeof x.id!=='string'||!x.id||x.id.length>256||x.id!==x.id.trim()||/[\s\x00-\x1f]/.test(x.id)||relations.has(x.id)
      ||!keys(x.productVariant,['id'])||!id(x.productVariant.id,'ProductVariant')||x.productVariant.id===variant.id||variants.has(x.productVariant.id)
      ||!Number.isSafeInteger(x.quantity)||x.quantity<1||x.quantity>1000000)fail();
    relations.add(x.id);variants.add(x.productVariant.id);return {relationId:x.id,componentVariantId:x.productVariant.id,consumedQuantity:x.quantity};
  });
  if(node.requiresComponents&&!components.length)fail();
  return {schema:'runvara-catalogue-structured-source/v1',workspaceId:context.workspaceId,connectionId:context.connectionId,revisionAtCapture:context.revision,
    sourceAccountId:shop.id,sourceDomain:shop.myshopifyDomain,productId:product.id,variantId:variant.id,capturedAt,
    productUpdatedAt:node.product.updatedAt,variantUpdatedAt:node.updatedAt,priceDecimal:node.price,currency:shop.currencyCode,
    ...options,components:{complete:true,entries:components},onlineStorePublicationObserved:node.product.status==='ACTIVE'&&node.product.onlineStoreUrl!==null,
    retailPolicyStatus:'unverified',componentRolePolicyStatus:'unverified',raw:structuredClone(node)};
}
