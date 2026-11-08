import { isDeepStrictEqual } from 'node:util';
import { flattenProducts } from './operations.mjs';

const variantKeys = new Set('id externalId title sku price priceDecimal currency inventory available requiresComponents updatedAt selectedOptions stock source raw catalogueEvidence'.split(' '));
const sourceKeys = new Set('system accountId domain apiVersion capturedAt currencySource objectType recordId'.split(' '));
const stockKeys = new Set('available onHand committed incoming unit aggregateEligible'.split(' '));
const rawKeys = new Set('id title sku price inventoryQuantity availableForSale requiresComponents updatedAt selectedOptions'.split(' '));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code) { throw Object.assign(new Error('Catalogue preservation review required.'), {code:'SHOPIFY_CATALOGUE_'+code,status:409}); }
function keys(value, allowed) {
  if (value !== undefined && (!object(value) || Object.keys(value).some(key => !allowed.has(key)))) fail('CUSTOM_VARIANT_FIELDS');
}
const scalars = names => Object.fromEntries(names.split(' ').map(name=>[name,null]));
const options = [scalars('name value')];
const rawSchema = {...scalars([...rawKeys].filter(key=>key!=='selectedOptions').join(' ')),selectedOptions:options};
const evidenceSchema = {...scalars('schema workspaceId connectionId revisionAtCapture sourceAccountId sourceDomain productId variantId capturedAt productUpdatedAt variantUpdatedAt priceDecimal currency soldPackQuantity packOptionStatus quantityBasis onlineStorePublicationObserved retailPolicyStatus componentRolePolicyStatus'),
  selectedOptions:options,packOption:scalars('name value'),components:{complete:null,entries:[scalars('relationId componentVariantId consumedQuantity')]},
  raw:{...rawSchema,product:scalars('id status onlineStoreUrl updatedAt'),productVariantComponents:{pageInfo:scalars('hasNextPage hasPreviousPage'),nodes:[{...scalars('id quantity'),productVariant:{id:null}}]}}};
function sourceShape(value,schema) {
  if(value===undefined || value===null)return;
  if(schema===null){if(typeof value==='object')fail('CUSTOM_VARIANT_FIELDS');return;}
  if(Array.isArray(schema)){if(!Array.isArray(value))fail('CUSTOM_VARIANT_FIELDS');for(const item of value)sourceShape(item,schema[0]);return;}
  if(!object(value) || Object.keys(value).some(key=>!Object.hasOwn(schema,key)))fail('CUSTOM_VARIANT_FIELDS');
  for(const key of Object.keys(value))sourceShape(value[key],schema[key]);
}
function identities(state) {
  const rows = [], seen = new Set(), variantIds=new Set(), skus = new Set();
  for (const product of state.products || []) for (const variant of product.variants || []) {
    if (typeof product.id !== 'string' || !product.id || typeof variant.id !== 'string' || !variant.id) fail('SAVED_IDENTITY_CONFLICT');
    // Scope never comes from SKU. Legacy records without source metadata remain
    // opaque identities; an import cannot silently attach their economics.
    const identity = JSON.stringify([state.workspace.id,product.provider,product.source?.accountId ?? null,product.id,variant.id]);
    if (seen.has(identity)) fail('SAVED_IDENTITY_CONFLICT'); seen.add(identity);
    const variantIdentity=JSON.stringify([product.provider,product.source?.accountId ?? null,variant.id]);
    if(variantIds.has(variantIdentity))fail('SAVED_IDENTITY_CONFLICT');variantIds.add(variantIdentity);
    if(product.provider==='shopify' && (variant.externalId && variant.externalId!==variant.id || variant.source?.recordId && variant.source.recordId!==variant.id
      || variant.source?.accountId && variant.source.accountId!==product.source?.accountId || variant.source?.domain && variant.source.domain!==product.source?.domain))fail('SAVED_IDENTITY_CONFLICT');
    if (variant.sku !== null && variant.sku !== undefined && typeof variant.sku !== 'string') fail('SAVED_IDENTITY_CONFLICT');
    // Use the existing economics consumer's exact SKU/fallback semantics; do
    // not normalize keys or overlook legacy generated-SKU associations.
    const effective=flattenProducts([{...product,variants:[variant]}])[0];
    if (effective.sku) {
      if (skus.has(effective.sku)) fail('SKU_AMBIGUOUS'); skus.add(effective.sku);
    }
    rows.push({identity,id:effective.id,sku:effective.sku});
  }
  return rows;
}
function costBindings(state) {
  if (!object(state.economics)) fail('ECONOMICS_INVALID');
  const rows = identities(state), result = new Map();
  for(const row of rows) {
    // Existing consumers select economics[sku] || economics[id]. A truthy
    // inherited name can shadow an own ID cost despite stable ID associations.
    // Refuse that selection; do not change consumers or remap the saved cost.
    const selectedKey=state.economics[row.sku] ? row.sku : row.id;
    if(state.economics[selectedKey] && !Object.hasOwn(state.economics,selectedKey))fail('COST_ASSOCIATION_AMBIGUOUS');
  }
  for (const key of Object.keys(state.economics)) {
    // Preserve both SKU and ID association, even a currently shadowed ID cost.
    const matches = rows.filter(row => row.sku === key || row.id === key).map(row => row.identity).sort();
    if (matches.length > 1) fail('COST_ASSOCIATION_AMBIGUOUS');
    result.set(key,matches);
  }
  return result;
}
export function assertCatalogueSavedPreservation(state) {
  costBindings(state);
  for (const product of state.products || []) if (product.provider === 'shopify') for (const variant of product.variants || []) {
    // Unknown local fields are blocked, not guessed to be provider-owned and
    // discarded. Known source evidence is replaced only by a complete capture.
    keys(variant,variantKeys); keys(variant.source,sourceKeys); keys(variant.stock,stockKeys); keys(variant.raw,rawKeys);
    sourceShape(variant.selectedOptions,options);sourceShape(variant.raw,rawSchema);sourceShape(variant.catalogueEvidence,evidenceSchema);
    sourceShape(variant.source,scalars([...sourceKeys].join(' ')));sourceShape(variant.stock,scalars([...stockKeys].join(' ')));
    for(const key of variantKeys)if(!['source','stock','raw','selectedOptions','catalogueEvidence'].includes(key))sourceShape(variant[key],null);
  }
}
export function assertCatalogueReplacementPreserved(before, after) {
  if (before.workspace?.id !== after.workspace?.id || !isDeepStrictEqual(before.economics,after.economics)) fail('ECONOMICS_CHANGED');
  assertCatalogueSavedPreservation(before);
  const old = costBindings(before), next = costBindings(after);
  if (!isDeepStrictEqual(old,next)) fail('COST_ASSOCIATION_CHANGED');
}
