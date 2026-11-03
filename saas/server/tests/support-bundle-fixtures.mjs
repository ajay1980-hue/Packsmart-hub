import {canonicalBundleRoster} from '../lib/support-bundle-policy.mjs';
import {captureCatalogueVariantEvidence,CATALOGUE_SHOP_ID} from '../lib/shopify-catalogue-evidence.mjs';
const gid=(type,n)=>`gid://shopify/${type}/${n}`;
export function syntheticBundleFixture(now=Date.parse('2026-11-02T14:00:00.000Z')){
  const iso=ms=>new Date(now-ms).toISOString(),domain='wavtzm-vy.myshopify.com',workspaceId='packsmart-solutions';
  const context={workspaceId,revision:'11111111-1111-4111-8111-111111111111',sourceRevision:'22222222-2222-4222-8222-222222222222',requestId:'33333333-3333-4333-8333-333333333333',
    connectionId:'synthetic-shopify',domain,status:'imported',sourceAccountId:CATALOGUE_SHOP_ID,currency:'GBP',startedAt:iso(90000),sourceCapturedAt:iso(10000),completedAt:iso(5000),productCount:15,variantCount:150};
  const policy={schema:'synthetic-policy-for-tests/v1',shopId:CATALOGUE_SHOP_ID,domain,parentCount:15,rowCount:150,parents:{},outers:{}};
  const products=[],rows=[];
  for(let i=0;i<15;i++){
    const id=gid('Product',800000+i),family=i<5?'grey':i<10?'ep':'bp',primary=gid('ProductVariant',900000+i);policy.parents[id]={family,primary};
    const common={system:'shopify',accountId:CATALOGUE_SHOP_ID,domain,apiVersion:'2026-07',capturedAt:iso(60000),currencySource:'Shop.currencyCode'};
    const p={id,externalId:id,provider:'shopify',status:'active',productType:'Packaging',updatedAt:iso(120000),onlineStoreUrl:`https://packsmartsolutions.com/products/synthetic-${i}`,currency:'GBP',catalogueObserved:true,
      catalogueClassification:{kind:'bundle',basis:'source_requires_components',retailVerified:false},source:{...common,objectType:'Product',recordId:id},variants:[]};
    p.raw={id,status:'ACTIVE',productType:'Packaging',updatedAt:p.updatedAt,onlineStoreUrl:p.onlineStoreUrl,variants:{nodes:[],pageInfo:{hasNextPage:false}}};
    for(let j=1;j<=10;j++){
      const vid=gid('ProductVariant',810000+i*10+j),n=j*25,sku=`SYNTH-${i}-${n}`,parts=[[primary,n+(family==='grey'?1:0)]];
      if(family==='bp'&&n===100){policy.outers[vid]=gid('ProductVariant',910000+i);parts.push([policy.outers[vid],1]);}
      const raw={id:vid,sku,price:'12.3400',requiresComponents:true,updatedAt:iso(120000),selectedOptions:[{name:'Pack Size',value:`Pack of ${n}`}]};
      const v={...structuredClone(raw),externalId:vid,price:12.34,priceDecimal:raw.price,currency:'GBP',inventory:999999,source:{...common,objectType:'ProductVariant',recordId:vid},raw:structuredClone(raw)};
      p.raw.variants.nodes.push(structuredClone(raw));
      const node={...structuredClone(raw),product:{id,status:'ACTIVE',onlineStoreUrl:p.onlineStoreUrl,updatedAt:p.updatedAt},productVariantComponents:{pageInfo:{hasNextPage:false,hasPreviousPage:false},
        nodes:parts.map(([component,quantity],k)=>({id:`synthetic-relation-${i}-${j}-${k}`,quantity,productVariant:{id:component}}))}};
      v.catalogueEvidence=captureCatalogueVariantEvidence(p,v,node,{context:{workspaceId,connectionId:context.connectionId,revision:context.sourceRevision},shop:{id:CATALOGUE_SHOP_ID,myshopifyDomain:domain,currencyCode:'GBP'},capturedAt:iso(20000),now});
      p.variants.push(v);rows.push([id,vid,n,parts]);
    }
    products.push(p);
  }
  const anchor=canonicalBundleRoster(rows);policy.canonicalBytes=anchor.bytes;policy.digest=anchor.digest;
  return {products,rows,policy,context,now,sku:products[0].variants[0].sku};
}
export function addSyntheticUnmapped(f,count=126){
  for(let start=0;start<count;start+=50){
    const id=gid('Product',950000+start),p={id,provider:'shopify',catalogueObserved:true,variants:[],catalogueClassification:{kind:'retail',retailVerified:true},productType:'Retail'};
    for(let j=start;j<Math.min(count,start+50);j++)p.variants.push({id:gid('ProductVariant',960000+j),sku:`UNMAPPED-${j}`,priceDecimal:'99999.99',requiresComponents:false});
    f.products.push(p);f.context.productCount++;
  }
  f.context.variantCount+=count;return f;
}
