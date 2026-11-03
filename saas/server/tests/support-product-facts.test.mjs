import test from 'node:test';
import assert from 'node:assert/strict';
import {supportProductProjection as project,supportProductReply as answer,supportProductSku,SUPPORT_PRODUCT_WORKSPACE as WS,SUPPORT_PRODUCT_LIMITS as limits} from '../lib/support-product-facts.mjs';
import {buildSupportReply,supportProductRequest,validateSupportInput} from '../lib/customer-support.mjs';
import {eligibleProduct,rawImportedProduct,fixedNow} from './support-product-fixtures.mjs';
const sku='DEMO-RETAIL-25';
const facts=p=>project(WS,[p],sku,{now:fixedNow});
test('eligible facts answer exact SKU, decimal price/currency, verified quantity and capture date',()=>{
  const p=eligibleProduct(),before=structuredClone(p),dto=facts(p),result=answer(dto,{now:fixedNow});
  assert.deepEqual(p,before);assert.equal(dto.packQuantity,25);assert.ok(Object.isFrozen(dto));
  assert.match(result.reply,/DEMO-RETAIL-25/);assert.match(result.reply,/GBP 12\.3400/);assert.match(result.reply,/25 items per sellable pack/);
  assert.match(result.reply,/2026-11-02T11:00:00\.000Z/);assert.match(result.reply,/not a live stock check/);assert.doesNotMatch(result.reply,/99999|98765|guarantee|dispatch/);
  assert.equal(result.needsHuman,false);assert.deepEqual(answer(dto,{now:fixedNow}),result);
});
test('the genuine imported-shape fallback is separate from eligible evidence',()=>assert.equal(facts(rawImportedProduct()),null));
test('ordinary reply cannot consume a client forged or cloned projection',()=>{
  const dto=facts(eligibleProduct());assert.equal(answer({...dto},{now:fixedNow}),null);
  const r=buildSupportReply({products:[eligibleProduct()],supportProductFacts:{...dto}},{message:'Pack quantity for SKU: DEMO-RETAIL-25'});
  assert.match(r.reply,/cannot verify/);assert.doesNotMatch(r.reply,/12\.3400|25 items/);
});
for(const [label,mutate] of [
  ['tenant',p=>p.workspaceId='foreign'],['nested tenant',p=>p.source.tenant={id:'foreign'}],
  ['variant tenant',p=>p.variants[0].tenant_id='foreign'],['account',p=>p.source.accountId='gid://shopify/Shop/999'],
  ['domain',p=>p.variants[0].source.domain='foreign.example.test'],['provider',p=>p.provider='ebay'],
  ['product id mismatch',p=>p.externalId='different'],['variant id mismatch',p=>p.variants[0].externalId='different'],
  ['source identity',p=>p.variants[0].source.recordId=p.id],['unobserved',p=>p.catalogueObserved=false],
  ['draft',p=>p.status='draft'],['archived',p=>p.status='archived'],['missing eligibility',p=>delete p.catalogueClassification],
  ['unverified retail',p=>p.catalogueClassification.retailVerified=false],['raw type conflict',p=>p.raw.productType='Internal component'],
  ['component',p=>p.catalogueClassification.kind='component'],['bundle',p=>p.variants[0].requiresComponents=true],
  ['missing source',p=>delete p.source],['stale',p=>p.source.capturedAt='2001-01-01T00:00:00.000Z'],
  ['future',p=>p.source.capturedAt='2999-01-01T00:00:00.000Z'],['invalid timestamp',p=>p.source.capturedAt='2026-02-30T11:00:00.000Z'],
  ['missing currency',p=>delete p.currency],['conflicting currency',p=>p.variants[0].currency='USD'],
  ['unsupported currency',p=>{p.currency='USD';p.variants[0].currency='USD';}],['currency provenance',p=>p.source.currencySource='workspace'],
  ['number price',p=>p.variants[0].priceDecimal=12.34],['exponent price',p=>p.variants[0].priceDecimal='1e3'],
  ['raw price conflict',p=>p.variants[0].raw.price='99.00'],['raw identity conflict',p=>p.variants[0].raw.id='foreign'],
  ['API provenance',p=>p.source.apiVersion='unknown'],
  ['negative price',p=>p.variants[0].priceDecimal='-1'],['leading zero price',p=>p.variants[0].priceDecimal='001.25']
])test(`ineligible product fails closed: ${label}`,()=>{const p=eligibleProduct();mutate(p);assert.equal(facts(p),null);});
for(const prefix of ['RAW-','PACK_'])test(`internal SKU ${prefix} never becomes retail`,()=>{
  const p=eligibleProduct();p.variants[0].sku=prefix+'DEMO';assert.equal(project(WS,[p],p.variants[0].sku,{now:fixedNow}),null);
});
for(const [label,mutate] of [
  ['absent',v=>delete v.packQuantityEvidence],['unverified',v=>v.packQuantityEvidence.verified=false],
  ['title inferred',v=>v.packQuantityEvidence.basis='title'],['stock inferred',v=>v.packQuantityEvidence.basis='inventory'],
  ['wrong variant',v=>v.packQuantityEvidence.variantId='wrong'],['wrong sku',v=>v.packQuantityEvidence.sku='wrong'],
  ['wrong tenant',v=>v.packQuantityEvidence.workspaceId='foreign'],['wrong source',v=>v.packQuantityEvidence.source.accountId='foreign'],
  ['wrong unit',v=>v.packQuantityEvidence.unit='grams'],['zero',v=>v.packQuantityEvidence.quantity=0],
  ['fractional',v=>v.packQuantityEvidence.quantity=1.5],['stale proof',v=>v.packQuantityEvidence.source.capturedAt='2001-01-01T00:00:00.000Z'],
  ['missing evidence ref',v=>delete v.packQuantityEvidence.evidenceRef]
])test(`missing pack evidence does not block safe price but quantity stays unknown: ${label}`,()=>{
  const p=eligibleProduct();mutate(p.variants[0]);const dto=facts(p),r=answer(dto,{now:fixedNow});
  assert.equal(dto.packQuantity,null);assert.match(r.reply,/GBP 12\.3400/);assert.match(r.reply,/Pack quantity is not verified/);assert.doesNotMatch(r.reply,/25 items|99999/);assert.equal(r.needsHuman,true);
});
test('duplicate source identity or ambiguous exact SKU is not first-match selection',()=>{
  const p=eligibleProduct();assert.throws(()=>project(WS,[p,p],sku,{now:fixedNow}),{code:'SUPPORT_UNAVAILABLE'});
  const q=eligibleProduct();q.id=q.externalId='gid://shopify/Product/900002';q.variants[0].id=q.variants[0].externalId='gid://shopify/ProductVariant/900002';
  assert.equal(project(WS,[p,q],sku,{now:fixedNow}),null);
});
test('tenant, malformed collection and byte/row limits fail before a reply',()=>{
  assert.throws(()=>project('foreign',[eligibleProduct()],sku),{code:'SUPPORT_UNAVAILABLE'});
  for(const p of [null,{},[null],Array(201).fill(eligibleProduct()),[{...eligibleProduct(),extra:'x'.repeat(limits.bytes)}]])
    assert.throws(()=>project(WS,p,sku,{now:fixedNow}),{code:'SUPPORT_UNAVAILABLE'});
});
test('expiry is rechecked before formatting a projected fact',()=>{
  const dto=facts(eligibleProduct());assert.equal(answer(dto,{now:fixedNow+limits.maxAgeMs}),null);assert.equal(answer(dto,{now:NaN}),null);
});
test('exact explicit SKU syntax is bounded, case preserving and unambiguous',()=>{
  assert.equal(supportProductSku('Price for SKU: DEMO-RETAIL-25?'),sku);
  assert.equal(supportProductSku('SKU: demo-retail-25'),'demo-retail-25');
  for(const s of ['DEMO-RETAIL-25','SKU: A SKU: B','SKU: <script>','SKU: A/B','SKU: '+ 'a'.repeat(81)])assert.equal(supportProductSku(s),null);
  assert.equal(project(WS,[eligibleProduct()],'demo-retail-25',{now:fixedNow}),null);
});
test('stock, delivery, refund and order questions cannot trigger product projection',()=>{
  for(const message of ['Stock for SKU: DEMO-RETAIL-25','Deliver SKU: DEMO-RETAIL-25 tomorrow','Refund SKU: DEMO-RETAIL-25','Where is my order SKU: DEMO-RETAIL-25'])assert.equal(supportProductRequest({message}),null);
  assert.deepEqual(validateSupportInput({message:'SKU: DEMO-RETAIL-25',supportProductFacts:facts(eligibleProduct()),products:[eligibleProduct()],workspaceId:'foreign'}),{message:'SKU: DEMO-RETAIL-25',email:'',orderNumber:''});
});
