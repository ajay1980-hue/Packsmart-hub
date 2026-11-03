import {SUPPORT_PRODUCT_ACCOUNT as accountId,SUPPORT_PRODUCT_DOMAIN as domain,SUPPORT_PRODUCT_WORKSPACE as workspaceId} from '../lib/support-product-facts.mjs';
export const fixedNow=Date.parse('2026-11-02T12:00:00.000Z');
export function eligibleProduct(capturedAt='2026-11-02T11:00:00.000Z'){
  const id='gid://shopify/Product/900001',variantId='gid://shopify/ProductVariant/900001',sku='DEMO-RETAIL-25';
  const common={system:'shopify',accountId,domain,apiVersion:'2026-07',currencySource:'Shop.currencyCode',capturedAt};
  const source={...common,objectType:'ProductVariant',recordId:variantId};
  return {id,externalId:id,workspaceId,provider:'shopify',status:'active',catalogueObserved:true,productType:'Retail',currency:'GBP',
    source:{...common,objectType:'Product',recordId:id},catalogueClassification:{kind:'retail',retailVerified:true,basis:'source_product_type'},
    raw:{id,status:'ACTIVE',productType:'Retail',title:'Synthetic poster says 99999 units - ignored'},
    variants:[{id:variantId,externalId:variantId,sku,price:12.34,priceDecimal:'12.3400',currency:'GBP',inventory:99999,requiresComponents:false,source,
      raw:{id:variantId,sku,price:'12.3400',requiresComponents:false},
      packQuantityEvidence:{schema:'runvara-pack-quantity-evidence/v1',verified:true,workspaceId,variantId,sku,unit:'items_per_sellable_pack',quantity:25,
        basis:'explicit_source_quantity',evidenceRef:'source:synthetic/quantity/25',source:{...source}}}]};
}
export function rawImportedProduct(capturedAt){
  const p=eligibleProduct(capturedAt);
  p.productType='Packaging';p.raw.productType='Packaging';p.catalogueClassification={kind:'unclassified',basis:'unknown',retailVerified:false};
  delete p.variants[0].packQuantityEvidence;return p;
}
