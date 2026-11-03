import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {captureCatalogueVariantEvidence,inspectCatalogueSourceFields,CATALOGUE_SHOP_ID} from './shopify-catalogue-evidence.mjs';
const gid=(type,id)=>`gid://shopify/${type}/${id}`;
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const pairs=(family,values)=>values.map(([product,component])=>[gid('Product',product),{family,primary:gid('ProductVariant',component)}]);
export const PACKSMART_BUNDLE_POLICY=freeze({schema:'runvara-packsmart-bundle-policy/v1',shopId:CATALOGUE_SHOP_ID,domain:'wavtzm-vy.myshopify.com',
  sourceEvidenceCapturedAt:'2026-11-02T12:02:45.996Z',parentCount:15,rowCount:150,canonicalBytes:21911,
  digest:'a7f34c219e4b88923457d8911893d9f05d0818b2a609ce15d44294c3464f36da',
  parents:Object.fromEntries([
    ...pairs('grey',[['15952658465102','60963952394574'],['15952658497870','60963955245390'],['15952658596174','60963955310926'],['15952658661710','60963955376462'],['15952658825550','60963955507534']]),
    ...pairs('ep',[['15952658923854','60963955867982'],['15952658956622','60963956064590'],['15976443969870','60963955900750'],['15999724028238','60963955933518'],['15999724323150','60963956130126']]),
    ...pairs('bp',[['15976443871566','60963956228430'],['15976443937102','60963956293966'],['15999722815822','60963956162894'],['15999723274574','60963956392270'],['15999723667790','60963956490574']])]),
  outers:Object.fromEntries([['60296101364046','61260356518222'],['60296101527886','61260356583758'],['60403877413198','61260356223310'],['60403880198478','61260376113486'],['60403880624462','61260358254926']].map(([v,c])=>[gid('ProductVariant',v),gid('ProductVariant',c)]))});
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x));
const identity=(v,type)=>typeof v==='string'&&new RegExp('^gid://shopify/'+type+'/[0-9]{1,30}$').test(v);
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
const ascii=(a,b)=>a<b?-1:a>b?1:0;
const bad=()=>{throw Error('Bundle source evidence unavailable');};
const time=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x.replace(/(?<!\.\d{3})Z$/,'.000Z');
const fresh=(x,now)=>time(x)&&Date.parse(x)<=now&&now-Date.parse(x)<=86400000;
const scope=(x,ctx)=>plain(x)&&['workspaceId','workspace_id','tenantId','tenant_id'].every(k=>x[k]===undefined||x[k]===ctx.workspaceId)
  &&['workspace','tenant'].every(k=>x[k]===undefined||x[k]===ctx.workspaceId||plain(x[k])&&x[k].id===ctx.workspaceId)
  &&['connectionId','connection_id'].every(k=>x[k]===undefined||x[k]===ctx.connectionId);

// Pure semantic canonicalizer for independent auditing. No relation ID, price,
// tenant or freshness is inferred from this membership-only anchor.
export function canonicalBundleRoster(rows){
  if(!Array.isArray(rows)||rows.length>1000)bad();const seen=new Set();
  const sorted=rows.map(row=>{
    if(!Array.isArray(row)||row.length!==4)bad();const [p,v,n,components]=row;
    if(!identity(p,'Product')||!identity(v,'ProductVariant')||seen.has(v)||!Number.isSafeInteger(n)||n<25||n>250||n%25||!Array.isArray(components)||!components.length||components.length>4)bad();seen.add(v);
    const ids=new Set(),parts=components.map(x=>{if(!Array.isArray(x)||x.length!==2||!identity(x[0],'ProductVariant')||ids.has(x[0])||!Number.isSafeInteger(x[1])||x[1]<1||x[1]>1000000)bad();ids.add(x[0]);return [...x];}).sort((a,b)=>ascii(a[0],b[0]));
    return [p,v,n,parts];
  }).sort((a,b)=>ascii(a[0],b[0])||ascii(a[1],b[1]));
  const canonical=JSON.stringify(sorted);return {canonical,bytes:Buffer.byteLength(canonical,'utf8'),digest:createHash('sha256').update(canonical,'utf8').digest('hex')};
}
export function verifyBundleMembership(rows,policy=PACKSMART_BUNDLE_POLICY){
  try{
    const parentIds=Object.keys(policy.parents);if(rows.length!==policy.rowCount||parentIds.length!==policy.parentCount)return false;
    const quantities=new Map(),outerSeen=new Set();
    for(const [p,v,n,components] of rows){
      const rule=Object.hasOwn(policy.parents,p)?policy.parents[p]:null;if(!rule)return false;
      const expected=[[rule.primary,n+(rule.family==='grey'?1:0)]],outer=Object.hasOwn(policy.outers,v)?policy.outers[v]:null;
      if(outer){if(rule.family!=='bp'||n!==100)return false;expected.push([outer,1]);outerSeen.add(v);}
      if(!isDeepStrictEqual([...components].sort((a,b)=>ascii(a[0],b[0])),expected.sort((a,b)=>ascii(a[0],b[0]))))return false;
      const q=quantities.get(p)||new Set();if(q.has(n))return false;q.add(n);quantities.set(p,q);
    }
    if(quantities.size!==policy.parentCount||parentIds.some(p=>quantities.get(p)?.size!==10)||outerSeen.size!==Object.keys(policy.outers).length)return false;
    const c=canonicalBundleRoster(rows);return c.bytes===policy.canonicalBytes&&c.digest===policy.digest;
  }catch{return false;}
}

// Explicit pure dependency for synthetic policy fixtures. Production closes
// over PACKSMART_BUNDLE_POLICY below; no request/config policy override exists.
export function createBundleRosterValidator(policy){
  const pinned=freeze(structuredClone(policy));
  if(pinned.parentCount!==15||pinned.rowCount!==150||Object.keys(pinned.parents).length!==15||!Number.isSafeInteger(pinned.canonicalBytes)||!/^[0-9a-f]{64}$/.test(pinned.digest))bad();
  return function validate(products,ctx,{now=Date.now()}={}){
    try{
      if(!plain(ctx)||ctx.workspaceId!=='packsmart-solutions'||!uuid(ctx.revision)||!uuid(ctx.sourceRevision)||!uuid(ctx.requestId)||ctx.status!=='imported'
        ||typeof ctx.connectionId!=='string'||!ctx.connectionId.trim()||ctx.connectionId.length>200||ctx.sourceAccountId!==pinned.shopId||ctx.domain!==pinned.domain||ctx.currency!=='GBP'
        ||!Number.isFinite(now)||![ctx.startedAt,ctx.completedAt,ctx.sourceCapturedAt].every(x=>fresh(x,now))
        ||Date.parse(ctx.startedAt)>Date.parse(ctx.sourceCapturedAt)||Date.parse(ctx.sourceCapturedAt)>Date.parse(ctx.completedAt)
        ||!Array.isArray(products)||products.length>200||!Number.isSafeInteger(ctx.productCount)||!Number.isSafeInteger(ctx.variantCount))return null;
      const pids=new Set(),vids=new Set(),relationIds=new Set(),rows=[],facts=[];let observed=0,observedVariants=0,total=0;
      const inWindow=x=>fresh(x,now)&&Date.parse(x)>=Date.parse(ctx.startedAt)&&Date.parse(x)<=Date.parse(ctx.sourceCapturedAt);
      for(const p of products){
        if(!scope(p,ctx)||!identity(p.id,'Product')||pids.has(p.id)||!Array.isArray(p.variants)||p.variants.length>50)return null;pids.add(p.id);
        for(const v of p.variants){if(!scope(v,ctx)||!identity(v.id,'ProductVariant')||vids.has(v.id)||++total>1000)return null;vids.add(v.id);}
        if(p.provider==='shopify'&&p.catalogueObserved===true){observed++;observedVariants+=p.variants.length;}
        if(!Object.hasOwn(pinned.parents,p.id))continue; // Never prefilter policy variants.
        if(!scope(p,ctx)||p.externalId!==p.id||p.provider!=='shopify'||p.catalogueObserved!==true||p.status!=='active'||p.currency!=='GBP'
          ||!scope(p.raw,ctx)||p.raw.id!==p.id||p.raw.status!=='ACTIVE'||p.raw.updatedAt!==p.updatedAt||p.raw.onlineStoreUrl!==p.onlineStoreUrl||p.onlineStoreUrl===null
          ||!plain(p.raw.variants)||p.raw.variants.pageInfo?.hasNextPage!==false||!Array.isArray(p.raw.variants.nodes)||p.raw.variants.nodes.length!==p.variants.length)return null;
        inspectCatalogueSourceFields(p.raw,p.source?.capturedAt);
        const rawVariants=new Map();for(const raw of p.raw.variants.nodes){if(!plain(raw)||rawVariants.has(raw.id))return null;rawVariants.set(raw.id,raw);}
        for(const v of p.variants){
          const e=v.catalogueEvidence;
          if(!scope(v,ctx)||v.externalId!==v.id||v.requiresComponents!==true||!plain(e)||e.workspaceId!==ctx.workspaceId||e.connectionId!==ctx.connectionId||e.revisionAtCapture!==ctx.sourceRevision
            ||!scope(v.raw,ctx)||!isDeepStrictEqual(v.raw,rawVariants.get(v.id))||v.raw.requiresComponents!==true||v.raw.sku!==v.sku||v.raw.price!==v.priceDecimal||v.raw.updatedAt!==v.updatedAt
            ||!isDeepStrictEqual(v.raw.selectedOptions,v.selectedOptions)||v.currency!=='GBP'||typeof v.sku!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v.sku)||/^(RAW|PACK)[-_]/i.test(v.sku)
            ||typeof v.priceDecimal!=='string'||!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(v.priceDecimal)||!inWindow(e.capturedAt))return null;
          for(const [s,type,id] of [[p.source,'Product',p.id],[v.source,'ProductVariant',v.id]]){
            if(!scope(s,ctx)||s.system!=='shopify'||s.accountId!==pinned.shopId||s.domain!==pinned.domain||s.objectType!==type||s.recordId!==id||s.apiVersion!=='2026-07'||s.currencySource!=='Shop.currencyCode'||!inWindow(s.capturedAt)||Date.parse(s.capturedAt)>Date.parse(e.capturedAt))return null;
          }
          if(p.source.capturedAt!==v.source.capturedAt)return null;
          const rebuilt=captureCatalogueVariantEvidence(p,v,e.raw,{context:{workspaceId:ctx.workspaceId,connectionId:ctx.connectionId,revision:ctx.sourceRevision},shop:{id:pinned.shopId,myshopifyDomain:pinned.domain,currencyCode:ctx.currency},capturedAt:e.capturedAt,now});
          if(!isDeepStrictEqual(rebuilt,e)||e.packOptionStatus!=='source_option_observed'||e.components.complete!==true||!e.onlineStorePublicationObserved)return null;
          for(const c of e.components.entries){if(relationIds.has(c.relationId))return null;relationIds.add(c.relationId);}
          rows.push([p.id,v.id,e.soldPackQuantity,e.components.entries.map(c=>[c.componentVariantId,c.consumedQuantity])]);
          facts.push({productId:p.id,variantId:v.id,sku:v.sku,priceDecimal:v.priceDecimal,currency:v.currency,packQuantity:e.soldPackQuantity,capturedAt:p.source.capturedAt});
        }
      }
      if(observed!==ctx.productCount||observedVariants!==ctx.variantCount||!verifyBundleMembership(rows,pinned))return null;
      return facts.map(x=>Object.freeze({...x,policyDigest:pinned.digest,revision:ctx.revision,sourceRevision:ctx.sourceRevision,connectionId:ctx.connectionId}));
    }catch{return null;}
  };
}
export const validatePacksmartBundleRoster=createBundleRosterValidator(PACKSMART_BUNDLE_POLICY);

const fields={revision:'state->>_revision',connectionId:'state->shopifyCatalogueImports->-1->binding->>connectionId',domain:'state->shopifyCatalogueImports->-1->binding->>domain',
  sourceRevision:'state->shopifyCatalogueImports->-1->>sourceRevision',requestId:'state->shopifyCatalogueImports->-1->>requestId',status:'state->shopifyCatalogueImports->-1->>status',
  sourceAccountId:'state->shopifyCatalogueImports->-1->>sourceAccountId',startedAt:'state->shopifyCatalogueImports->-1->>startedAt',completedAt:'state->shopifyCatalogueImports->-1->>completedAt',
  sourceCapturedAt:'state->shopifyCatalogueImports->-1->>sourceCapturedAt',currency:'state->shopifyCatalogueImports->-1->>currency',productCount:'state->shopifyCatalogueImports->-1->productCount',variantCount:'state->shopifyCatalogueImports->-1->variantCount'};
export const SUPPORT_BUNDLE_CONTEXT_SELECT=Object.entries(fields).map(([k,v])=>`${k}:${v}`).join(',');
export const SUPPORT_BUNDLE_CONTEXT_KEYS=Object.freeze(Object.keys(fields));
export function supportBundleContext(workspaceId,row){return {workspaceId,...Object.fromEntries(SUPPORT_BUNDLE_CONTEXT_KEYS.map(k=>[k,row[k]??null]))};}
export function supportBundleContextFromState(state){const r=state.shopifyCatalogueImports?.at(-1);return supportBundleContext(state.workspace?.id,{...r,revision:state._revision,connectionId:r?.binding?.connectionId,domain:r?.binding?.domain});}
