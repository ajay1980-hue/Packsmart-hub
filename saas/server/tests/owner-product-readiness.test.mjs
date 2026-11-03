import test from 'node:test';
import assert from 'node:assert/strict';
import {createOwnerProductReadinessProjection,ownerProductReadinessProjection as pinned} from '../lib/owner-product-readiness.mjs';
import {syntheticBundleFixture,addSyntheticUnmapped} from './support-bundle-fixtures.mjs';
const WS='packsmart-solutions';
const run=f=>createOwnerProductReadinessProjection(f.policy)(WS,f.products,f.context,{now:f.now});
test('complete synthetic policy verifies only saved facts, remains non-authorizing and does not mutate source',()=>{
  const f=addSyntheticUnmapped(syntheticBundleFixture()),before=structuredClone(f),a=run(f),b=run(f);
  assert.deepEqual(a,b);assert.deepEqual(f,before);assert.equal(Object.isFrozen(a),true);
  assert.equal(a.code,'VERIFIED_SAVED_EVIDENCE');assert.equal(a.verifiedProductCount,15);assert.equal(a.verifiedVariantCount,150);
  assert.equal(a.sourceCurrency,'GBP');assert.equal(a.livePriceVerified,false);assert.equal(a.credentialUsability,'not_checked');
  assert.equal(a.permitsImport,false);assert.equal(a.permitsPublicSupport,false);
  assert.doesNotMatch(JSON.stringify(a),/gid:|synthetic-shopify|SYNTH-|999999|12\.34|11111111|22222222|33333333/);
});
test('test policy is explicit; synthetic roster never satisfies production pinned membership',()=>{
  const f=syntheticBundleFixture();assert.equal(pinned(WS,f.products,f.context,{now:f.now}).code,'CATALOGUE_UNVERIFIED');
});
for(const status of ['reserved','unknown','failed','pending','IMPORTED',''])test(`unresolved import ${JSON.stringify(status)} requires reconciliation, not replay`,()=>{
  const f=syntheticBundleFixture();f.context.status=status;const r=run(f);assert.equal(r.code,'IMPORT_OUTCOME_UNRESOLVED');assert.equal(r.nextStep,'reconcile_existing_import');
});
for(const [name,change,code] of [
  ['missing receipt',f=>f.context.requestId=null,'IMPORT_RECEIPT_UNVERIFIED'],
  ['old snapshot',f=>{f.context.requestId=null;f.context.status=null;},'IMPORT_RECEIPT_UNVERIFIED'],
  ['missing source revision',f=>f.context.sourceRevision=null,'ENRICHED_RECEIPT_REQUIRED'],
  ['missing current revision',f=>f.context.revision=null,'ENRICHED_RECEIPT_REQUIRED'],
  ['future capture',f=>f.context.sourceCapturedAt=new Date(f.now+1000).toISOString(),'SOURCE_TIME_INVALID'],
  ['missing timestamp',f=>f.context.startedAt=null,'SOURCE_TIME_INVALID'],
  ['capture after completion',f=>f.context.completedAt=f.context.startedAt,'SOURCE_TIME_INVALID'],
  ['stale',f=>f.now+=86400000,'SOURCE_EVIDENCE_STALE'],
  ['wrong account',f=>f.context.sourceAccountId='gid://shopify/Shop/1','CATALOGUE_UNVERIFIED'],
  ['wrong connection',f=>f.context.connectionId='different','CATALOGUE_UNVERIFIED'],
  ['wrong currency',f=>f.context.currency='USD','CATALOGUE_UNVERIFIED'],
  ['missing price provenance',f=>delete f.products[0].variants[0].source.currencySource,'CATALOGUE_UNVERIFIED'],
  ['malformed price',f=>f.products[0].variants[0].priceDecimal='NaN','CATALOGUE_UNVERIFIED'],
  ['missing enriched evidence',f=>delete f.products[0].variants[0].catalogueEvidence,'CATALOGUE_UNVERIFIED'],
  ['missing variant',f=>f.products[0].variants.pop(),'CATALOGUE_UNVERIFIED'],
  ['extra variant',f=>f.products[0].variants.push(structuredClone(f.products[0].variants[0])),'CATALOGUE_UNVERIFIED'],
  ['foreign evidence',f=>f.products[0].workspaceId='beta','CATALOGUE_UNVERIFIED'],
  ['unmapped duplicate SKU',f=>{addSyntheticUnmapped(f,1);f.products.at(-1).variants[0].sku=f.sku;},'CATALOGUE_UNVERIFIED'],
  ['conflicting pack option',f=>f.products[0].variants[0].selectedOptions[0].value='Pack of 250','CATALOGUE_UNVERIFIED']
])test(`safe reason: ${name}`,()=>{
  const f=syntheticBundleFixture();change(f);const r=run(f);assert.equal(r.code,code);assert.equal(r.status,'not_ready');
  assert.equal(r.sourceCurrency,null);assert.equal(r.verifiedVariantCount,0);assert.equal(r.permitsImport,false);assert.equal(r.permitsPublicSupport,false);
});
for(const [name,change] of [
  ['request ID with null status',f=>f.context.status=null],
  ['request ID with absent status',f=>delete f.context.status],
  ['imported with absent request ID',f=>delete f.context.requestId],
  ['imported with malformed request ID',f=>f.context.requestId='invalid'],
  ['all receipt fields absent',f=>f.context={workspaceId:f.context.workspaceId,revision:f.context.revision}]
])test(`incomplete receipt cannot establish non-execution: ${name}`,()=>{
  const f=syntheticBundleFixture();change(f);const r=run(f);
  assert.equal(r.code,'IMPORT_RECEIPT_UNVERIFIED');assert.equal(r.nextStep,'reconcile_existing_import');
  assert.equal(r.permitsImport,false);assert.equal(r.permitsPublicSupport,false);
});
for(const [name,change] of [
  ['too many products',f=>f.products=Array.from({length:201},()=>({variants:[]}))],
  ['too many variants per product',f=>f.products[0].variants=Array.from({length:51},()=>({}))],
  ['too many total variants',f=>f.products=Array.from({length:21},()=>({variants:Array.from({length:50},()=>({}))}))],
  ['response bytes',f=>f.products[0].padding='x'.repeat(2097152)],
  ['cycle',f=>f.products[0].cycle=f.products],
  ['non-JSON number',f=>f.products[0].price=NaN],
  ['getter',f=>Object.defineProperty(f.context,'workspaceId',{get(){assert.fail('getter invoked');}})],
  ['prototype',f=>Object.setPrototypeOf(f.products[0],{secret:'private'})],
  ['missing products',f=>f.products=null]
])test(`bounded or malformed input: ${name}`,()=>{
  const f=syntheticBundleFixture();change(f);assert.throws(()=>run(f),e=>e.code==='PRODUCT_READINESS_UNAVAILABLE'&&!/secret|private|getter/.test(e.message));
});
test('foreign caller tenant is rejected without any eligible projection',()=>{
  const f=syntheticBundleFixture();assert.throws(()=>createOwnerProductReadinessProjection(f.policy)('beta',f.products,f.context,{now:f.now}),{code:'PRODUCT_READINESS_UNAVAILABLE'});
});
