import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,product,page,response,componentNode,ID} from './shopify-catalogue-import-fixture.mjs';
import {CATALOGUE_QUERY,CATALOGUE_LIMITS,readBoundedCatalogue} from '../lib/shopify-catalogue-import.mjs';
import {CATALOGUE_SHOP_ID,CATALOGUE_COMPONENT_QUERY,CATALOGUE_EVIDENCE_LIMITS,captureSelectedOptions,captureCatalogueVariantEvidence,inspectCatalogueSourceFields} from '../lib/shopify-catalogue-evidence.mjs';
const at='2026-11-02T12:00:00.000Z',now=Date.parse(at),ctx={workspaceId:ID,connectionId:'synthetic-connection',revision:'11111111-1111-4111-8111-111111111111'};
const shop={id:CATALOGUE_SHOP_ID,myshopifyDomain:'wavtzm-vy.myshopify.com',currencyCode:'GBP'};
function pure(){
  const raw=product(),v=raw.variants.nodes[0],source={accountId:shop.id,domain:shop.myshopifyDomain,capturedAt:at};
  return {p:{...raw,raw,currency:'GBP',source},v:{...v,source,currency:'GBP',priceDecimal:v.price},n:componentNode(raw,v),options:{context:{...ctx},shop:{...shop},capturedAt:at,now}};
}
const capture=x=>captureCatalogueVariantEvidence(x.p,x.v,x.n,x.options);
test('queries preserve structured fields in bounded read-only captures without changing existing limits',()=>{
  assert.match(CATALOGUE_QUERY,/onlineStoreUrl/);assert.match(CATALOGUE_QUERY,/updatedAt selectedOptions \{ name value \}/);
  assert.doesNotMatch(CATALOGUE_QUERY,/productVariantComponents/);assert.match(CATALOGUE_COMPONENT_QUERY,/productVariantComponents\(first: 4\)/);
  assert.match(CATALOGUE_COMPONENT_QUERY,/hasNextPage hasPreviousPage/);assert.match(CATALOGUE_COMPONENT_QUERY,/id quantity productVariant \{ id \}/);
  assert.doesNotMatch(CATALOGUE_QUERY+CATALOGUE_COMPONENT_QUERY,/\b(orders|customers|mutation)\b/);
  assert.equal(CATALOGUE_LIMITS.pages,20);assert.equal(CATALOGUE_LIMITS.products,200);assert.equal(CATALOGUE_LIMITS.variants,1000);assert.equal(CATALOGUE_LIMITS.variantsPerProduct,50);
  assert.equal(CATALOGUE_LIMITS.pageBytes,524288);assert.equal(CATALOGUE_LIMITS.totalBytes,2097152);assert.equal(CATALOGUE_EVIDENCE_LIMITS.variantsPerBatch,50);
});
for(let quantity=25;quantity<=250;quantity+=25)test(`only exact named option supplies sold quantity ${quantity}`,()=>{
  const options=[{name:'Pack Size',value:`Pack of ${quantity}`}];const before=structuredClone(options),r=captureSelectedOptions(options);
  assert.equal(r.soldPackQuantity,quantity);assert.deepEqual(r.packOption,options[0]);assert.deepEqual(options,before);
});
for(const value of ['Pack of 0','Pack of 24','Pack of 251','Pack of 275','Pack of 025','pack of 25','Pack of 25 ','Pack of 25 items','250','Pack of 999999999999999999999'])test('unrecognized pack option stays unknown: '+value,()=>{
  const r=captureSelectedOptions([{name:'Pack Size',value}]);assert.equal(r.soldPackQuantity,null);assert.equal(r.packOptionStatus,'unrecognized');assert.equal(r.packOption.value,value);
});
test('missing exact option is unknown; malformed/duplicate options cannot manufacture quantity',()=>{
  for(const options of [[],[{name:'Title',value:'Pack of 25'}],[{name:'pack size',value:'Pack of 25'}]])assert.equal(captureSelectedOptions(options).soldPackQuantity,null);
  for(const bad of [undefined,null,{},[null],[{name:'Pack Size',value:25}],[{name:'Pack Size',value:'Pack of 25'},{name:'Pack Size',value:'Pack of 50'}],[{name:'Pack Size',value:'Pack of 25'},{name:'pack size',value:'Pack of 25'}],Array(4).fill({name:'X',value:'x'})])assert.throws(()=>captureSelectedOptions(bad),{code:'SHOPIFY_CATALOGUE_EVIDENCE_INVALID'});
});
test('fresh capture is separate from old source update and does not verify retail, checkout or stock',()=>{
  const x=pure();x.p.raw.updatedAt=x.p.updatedAt=x.n.product.updatedAt='2020-01-01T00:00:00.000Z';const before=structuredClone(x),r=capture(x);
  assert.equal(r.capturedAt,at);assert.equal(r.productUpdatedAt,'2020-01-01T00:00:00.000Z');assert.equal(r.retailPolicyStatus,'unverified');assert.equal(r.componentRolePolicyStatus,'unverified');
  assert.equal(r.onlineStorePublicationObserved,true);assert.equal(r.priceDecimal,'12.30');assert.equal(r.currency,'GBP');assert.equal(r.connectionId,ctx.connectionId);assert.equal(r.revisionAtCapture,ctx.revision);
  assert.equal(r.purchasable,undefined);assert.equal(r.stock,undefined);assert.deepEqual(x,before);
});
test('grey sold 250 and consumed 251 remain distinct without subtraction or retail inference',()=>{
  const x=pure();x.n.requiresComponents=x.v.requiresComponents=true;x.n.selectedOptions=x.v.selectedOptions=[{name:'Pack Size',value:'Pack of 250'}];
  x.n.productVariantComponents.nodes=[{id:'synthetic-grey-relation',quantity:251,productVariant:{id:'gid://shopify/ProductVariant/990001'}}];
  const r=capture(x);assert.equal(r.soldPackQuantity,250);assert.equal(r.components.entries[0].consumedQuantity,251);assert.equal(r.retailPolicyStatus,'unverified');assert.equal(r.componentRolePolicyStatus,'unverified');
});
test('BP 100 and extra outer are retained as unidentified components, never classified heuristically',()=>{
  const x=pure();x.n.requiresComponents=x.v.requiresComponents=true;x.n.selectedOptions=x.v.selectedOptions=[{name:'Pack Size',value:'Pack of 100'}];
  x.n.productVariantComponents.nodes=[{id:'synthetic-bp-relation',quantity:100,productVariant:{id:'gid://shopify/ProductVariant/990001'}},{id:'synthetic-outer-relation',quantity:1,productVariant:{id:'gid://shopify/ProductVariant/990002'}}];
  const r=capture(x);assert.equal(r.soldPackQuantity,100);assert.deepEqual(r.components.entries.map(e=>e.consumedQuantity),[100,1]);assert.ok(r.components.entries.every(e=>e.role===undefined));assert.equal(r.componentRolePolicyStatus,'unverified');
});
for(const [name,mutate] of [
  ['wrong shop',x=>x.options.shop.id='gid://shopify/Shop/999'],['wrong tenant',x=>x.options.context.workspaceId='foreign'],['missing connection',x=>delete x.options.context.connectionId],['bad revision',x=>x.options.context.revision='old'],
  ['saved tenant conflict',x=>x.v.tenantId='foreign'],['saved connection conflict',x=>x.p.source.connectionId='other'],['source account conflict',x=>x.v.source.accountId='gid://shopify/Shop/999'],['source domain conflict',x=>x.p.source.domain='other.myshopify.com'],
  ['stale capture',x=>x.options.now+=86400001],['future capture',x=>x.options.now--],['stale saved capture',x=>x.v.source={...x.v.source,capturedAt:'2020-01-01T00:00:00.000Z'}],
  ['wrong variant',x=>x.n.id='gid://shopify/ProductVariant/999'],['wrong product',x=>x.n.product.id='gid://shopify/Product/999'],['changed price',x=>x.n.price='12.31'],['changed currency',x=>x.options.shop.currencyCode='EUR'],
  ['changed update',x=>x.n.updatedAt='2026-11-02T11:00:00.000Z'],['changed option',x=>x.n.selectedOptions=[{name:'Pack Size',value:'Pack of 50'}]],['future source update',x=>x.n.updatedAt=x.v.updatedAt='2030-01-01T00:00:00.000Z'],
  ['missing component pagination',x=>delete x.n.productVariantComponents.pageInfo],['incomplete next page',x=>x.n.productVariantComponents.pageInfo.hasNextPage=true],['incomplete previous page',x=>x.n.productVariantComponents.pageInfo.hasPreviousPage=true],
  ['missing components',x=>delete x.n.productVariantComponents],['empty required bundle',x=>x.n.requiresComponents=x.v.requiresComponents=true],['unexpected tenant field',x=>x.n.product.workspaceId='foreign']
])test('structured evidence fails closed: '+name,()=>{const x=pure();mutate(x);assert.throws(()=>capture(x),{code:'SHOPIFY_CATALOGUE_EVIDENCE_INVALID'});});
test('duplicate relations/components and malformed consumed quantities fail closed',()=>{
  for(const kind of ['duplicateRelation','duplicateVariant','self','zero','fraction','large','missingId','hole','limit']){
    const x=pure(),a={id:'rel-a',quantity:25,productVariant:{id:'gid://shopify/ProductVariant/990001'}},b={id:'rel-b',quantity:1,productVariant:{id:'gid://shopify/ProductVariant/990002'}};
    if(kind==='duplicateRelation')b.id=a.id;if(kind==='duplicateVariant')b.productVariant.id=a.productVariant.id;if(kind==='self')a.productVariant.id=x.v.id;
    if(kind==='zero')a.quantity=0;if(kind==='fraction')a.quantity=1.1;if(kind==='large')a.quantity=1000001;if(kind==='missingId')delete a.id;
    x.n.productVariantComponents.nodes=kind==='hole'?new Array(1):kind==='limit'?Array(5).fill(a):[a,b];assert.throws(()=>capture(x),{code:'SHOPIFY_CATALOGUE_EVIDENCE_INVALID'});
  }
});
test('missing structured fields in old snapshots are not silently eligible',()=>{
  const p=product();delete p.onlineStoreUrl;assert.throws(()=>inspectCatalogueSourceFields(p,at));p.onlineStoreUrl=null;delete p.variants.nodes[0].selectedOptions;assert.throws(()=>inspectCatalogueSourceFields(p,at));
});
test('complete staged import persists source fields with same trusted connection/revision and no attestations',async t=>{
  const f=await fixture(t);const r=await f.submit();assert.equal(r.status,200);assert.equal(f.reads.length,2);
  const saved=f.fake.states.get(ID),p=saved.products[0],v=p.variants[0],e=v.catalogueEvidence;
  assert.equal(e.connectionId,'synthetic-shopify');assert.equal(f.calls.filter(c=>c.method==='PATCH').at(-1).url.searchParams.get('state->>_revision'),'eq.'+e.revisionAtCapture);
  assert.match(e.revisionAtCapture,/^[0-9a-f-]{36}$/);assert.equal(e.workspaceId,ID);assert.equal(e.sourceAccountId,CATALOGUE_SHOP_ID);assert.equal(e.soldPackQuantity,25);
  assert.deepEqual(e.components,{complete:true,entries:[]});assert.equal(p.catalogueClassification.retailVerified,false);assert.equal(v.packQuantityEvidence,undefined);
  assert.deepEqual(v.selectedOptions,v.raw.selectedOptions);assert.equal(v.priceDecimal,'12.30');assert.equal(e.priceDecimal,v.priceDecimal);
  assert.deepEqual(saved.shopifyCatalogueImports[0].pages.map(p=>p.kind),['catalogue','components']);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,2);
  assert.equal(saved.shopifyCatalogueImports[0].sourceRevision,e.revisionAtCapture);
});
for(const defect of ['first-wrong-shop','missing-option','missing-url','component-next','component-duplicate','component-wrong-shop','component-price-drift','component-missing-node','component-oversize','component-error'])test('staging '+defect+' preserves old catalogue and spent claim, with no retry',async t=>{
  const f=await fixture(t,{providerFetch:()=>{const p=page();if(defect==='first-wrong-shop')p.data.shop.id='gid://shopify/Shop/999';if(defect==='missing-option')delete p.data.products.nodes[0].variants.nodes[0].selectedOptions;if(defect==='missing-url')delete p.data.products.nodes[0].onlineStoreUrl;return response(p);},componentFetch:p=>{
    if(defect==='component-next')p.data.nodes[0].productVariantComponents.pageInfo.hasNextPage=true;
    if(defect==='component-duplicate')p.data.nodes.push(p.data.nodes[0]);if(defect==='component-wrong-shop')p.data.shop={...p.data.shop,id:'gid://shopify/Shop/999'};
    if(defect==='component-price-drift')p.data.nodes[0].price='999';if(defect==='component-missing-node')p.data.nodes=[];
    if(defect==='component-oversize')p.padding='X'.repeat(CATALOGUE_LIMITS.pageBytes);if(defect==='component-error')throw Error('synthetic unavailable');return response(p);
  }});
  assert.notEqual((await f.submit()).status,200);const saved=f.fake.states.get(ID);assert.deepEqual(saved.products,[]);assert.equal(saved.shopifyCatalogueImports[0].status,'reserved');assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);
  const count=f.reads.length;await f.submit();assert.equal(f.reads.length,count);
});
test('component responses consume original 20-page budget; insufficient capacity fails before extra request',async t=>{
  const f=await fixture(t,{providerFetch:(_,n)=>response(page([product(n)],n<20,n<20?'cursor'+n:null))});
  const r=await f.submit();assert.notEqual(r.status,200);assert.equal(r.payload.code,'SHOPIFY_CATALOGUE_COVERAGE_LIMIT');assert.equal(f.reads.length,20);assert.ok(f.reads.every(x=>x.query===CATALOGUE_QUERY));assert.equal(f.fake.states.get(ID).products.length,0);
});
test('untrusted capture context is rejected before any synthetic source request',async()=>{
  let calls=0;await assert.rejects(readBoundedCatalogue({config:{domain:shop.myshopifyDomain,apiVersion:'2026-07',accessToken:'dummy'},context:{...ctx,workspaceId:'other'},assertCurrent:async()=>{},fetchImpl:async()=>{calls++;throw Error('not reached');}}),{code:'SHOPIFY_CATALOGUE_EVIDENCE_INVALID'});assert.equal(calls,0);
});
test('51 variants use two bounded component batches without exceeding 50 variants per product',async t=>{
  const p=product(1),q=product(2);p.variants.nodes=Array.from({length:50},(_,n)=>product(n+1).variants.nodes[0]);q.variants.nodes=[product(51).variants.nodes[0]];
  const f=await fixture(t,{providerFetch:()=>response(page([p,q]))});assert.equal((await f.submit()).status,200);
  assert.deepEqual(f.reads.filter(x=>x.query===CATALOGUE_COMPONENT_QUERY).map(x=>x.variables.ids.length),[50,1]);
  assert.equal(f.fake.states.get(ID).products.flatMap(p=>p.variants).filter(v=>v.catalogueEvidence.components.complete).length,51);
});
test('duplicate component relation across variants fails rather than assigning shared relation ownership',async t=>{
  const p=product(1),q=product(2);p.variants.nodes[0].requiresComponents=q.variants.nodes[0].requiresComponents=true;
  const f=await fixture(t,{providerFetch:()=>response(page([p,q])),componentFetch:b=>{b.data.nodes[1].productVariantComponents.nodes[0].id=b.data.nodes[0].productVariantComponents.nodes[0].id;return response(b);}});
  assert.notEqual((await f.submit()).status,200);assert.equal(f.fake.states.get(ID).products.length,0);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);
});
test('component bytes share the original total response budget, not an additional allowance',async t=>{
  const f=await fixture(t,{providerFetch:(_,n)=>{const b=page([product(n)],n<4,n<4?'next'+n:null);b.padding='P'.repeat(470000);return response(b);},componentFetch:b=>{b.padding='C'.repeat(240000);return response(b);}});
  const r=await f.submit();assert.equal(r.payload.code,'SHOPIFY_CATALOGUE_RESPONSE_LIMIT');assert.equal(f.reads.length,5);assert.equal(f.fake.states.get(ID).products.length,0);
});
