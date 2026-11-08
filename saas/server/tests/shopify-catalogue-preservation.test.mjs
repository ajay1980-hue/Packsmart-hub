import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,product,page,response,catalogueState,ID,DOMAIN} from './shopify-catalogue-import-fixture.mjs';
import {assertCatalogueSavedPreservation,assertCatalogueReplacementPreserved} from '../lib/shopify-catalogue-preservation.mjs';
const shop='gid://shopify/Shop/105939173710';
function stateWithCost() {
  const s=catalogueState();s.products=[{id:'gid://shopify/Product/1',provider:'shopify',source:{accountId:shop,domain:DOMAIN},variants:[{id:'gid://shopify/ProductVariant/1',sku:'TEST-1',price:12.30}]}];
  s.economics={'TEST-1':{landed:2,packing:0.1,delivery:3,originalCurrency:'EUR'}};return s;
}
const writes=f=>f.calls.filter(c=>c.method!=='GET');
test('unchanged stable cost association accepts source price/currency update without remapping economics',async t=>{
  const state=stateWithCost(),original=structuredClone(state),p=product();p.variants.nodes[0].price='14.20';
  const f=await fixture(t,{state,providerFetch:()=>response(page([p]))}),r=await f.submit();assert.equal(r.status,200,JSON.stringify(r.payload));
  assert.deepEqual(f.fake.states.get(ID).economics,original.economics);assert.equal(f.fake.states.get(ID).products[0].variants[0].priceDecimal,'14.20');
  assert.deepEqual(state,original,'caller snapshot unchanged');assert.equal(f.calls.filter(c=>c.method==='PATCH').length,2);
});
for(const scenario of ['sku changed','variant removed','sku reused','duplicate sku','duplicate against retained product','orphan cost attached'])test('staged '+scenario+' rejects without replacing catalogue or replay',async t=>{
  const state=stateWithCost(),p=product(),nodes=[p];
  if(scenario==='sku changed')p.variants.nodes[0].sku='CHANGED';
  if(scenario==='variant removed')p.variants.nodes=[{...p.variants.nodes[0],id:'gid://shopify/ProductVariant/2',sku:'OTHER'}];
  if(scenario==='sku reused'){p.variants.nodes[0].sku='CHANGED';const other=product(2);other.variants.nodes[0].sku='TEST-1';nodes.push(other);}
  if(scenario==='duplicate sku'){const other=product(2);other.variants.nodes[0].sku='TEST-1';nodes.push(other);}
  if(scenario==='duplicate against retained product')state.products.push({id:'gid://shopify/Product/99',provider:'shopify',variants:[{id:'legacy',sku:'TEST-2'}]}),nodes.push(product(2));
  if(scenario==='orphan cost attached'){state.economics['TEST-2']={landed:55};nodes.push(product(2));}
  const f=await fixture(t,{state,providerFetch:()=>response(page(nodes))}),r=await f.submit();assert.equal(r.status,409,JSON.stringify(r.payload));
  assert.match(r.payload.code,/COST_ASSOCIATION_CHANGED|SKU_AMBIGUOUS/);assert.deepEqual(f.fake.states.get(ID).products,state.products);assert.deepEqual(f.fake.states.get(ID).economics,state.economics);
  assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);assert.equal(f.fake.states.get(ID).shopifyCatalogueImports[0].status,'reserved');
  const count=f.reads.length;assert.equal((await f.submit()).payload.run.status,'reserved');assert.equal(f.reads.length,count);
});
for(const place of ['top','source','stock','raw','option','evidence','evidence nested'])test('custom variant field at '+place+' stops before claim and provider',async t=>{
  const state=stateWithCost(),v=state.products[0].variants[0];
  if(place==='top')v.manualNote='private-fixture-marker';
  if(place==='source')v.source={manualNote:'private-fixture-marker'};
  if(place==='stock')v.stock={manualNote:'private-fixture-marker'};
  if(place==='raw')v.raw={manualNote:'private-fixture-marker'};
  if(place==='option')v.selectedOptions=[{name:'Pack Size',value:'Pack of 25',manualNote:'private-fixture-marker'}];
  if(place==='evidence')v.catalogueEvidence={manualNote:'private-fixture-marker'};
  if(place==='evidence nested')v.catalogueEvidence={components:{complete:true,entries:[{relationId:'r',componentVariantId:'v',consumedQuantity:25,manualNote:'private-fixture-marker'}]}};
  const f=await fixture(t,{state}),r=await f.submit();assert.equal(r.payload.code,'SHOPIFY_CATALOGUE_CUSTOM_VARIANT_FIELDS');assert.equal(f.reads.length,0);assert.equal(writes(f).length,0);
  assert.doesNotMatch(JSON.stringify(r.payload),/private-fixture-marker|manualNote/);assert.deepEqual(f.fake.states.get(ID).products,state.products);
});
for(const drift of ['products same revision','economics same revision','revision','owner','session','tenant'])test('intervening '+drift+' cannot be overwritten',async t=>{
  const state=stateWithCost();let f;
  f=await fixture(t,{state,providerFetch:()=>{const live=f.fake.states.get(ID);
    if(drift==='products same revision')live.products[0].variants[0].manualNote='new edit';
    if(drift==='economics same revision')live.economics['TEST-1'].landed=99;
    if(drift==='revision')live._revision=randomUUID();
    if(drift==='owner')live.users[0].role='admin';
    if(drift==='session')live.users[0].sessionVersion++;
    if(drift==='tenant')live.workspace.id='other-tenant';return response();}});
  assert.notEqual((await f.submit()).status,200);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);assert.equal(f.fake.states.get(ID).shopifyCatalogueImports[0].status,'reserved');
  if(drift==='products same revision')assert.equal(f.fake.states.get(ID).products[0].variants[0].manualNote,'new edit');
  if(drift==='economics same revision')assert.equal(f.fake.states.get(ID).economics['TEST-1'].landed,99);
});
for(const scenario of ['ambiguous costs','duplicate variant','wrong account','wrong record alias'])test('saved '+scenario+' rejected locally',()=>{
  const s=stateWithCost(),v=s.products[0].variants[0];
  if(scenario==='ambiguous costs')s.products.push({id:'ebay-product',provider:'ebay',variants:[{id:'TEST-1',sku:'EBAY'}]});
  if(scenario==='duplicate variant')s.products.push({...structuredClone(s.products[0]),id:'gid://shopify/Product/2',variants:[{...v,sku:'OTHER'}]});
  if(scenario==='wrong account')v.source={accountId:'wrong'};
  if(scenario==='wrong record alias')v.externalId='wrong';
  assert.throws(()=>assertCatalogueSavedPreservation(s),{status:409});
});
test('ID-keyed economics stay on stable identity; changed SKU without an affected cost may update',()=>{
  const a=stateWithCost();a.economics={[a.products[0].variants[0].id]:{landed:2}};const b=structuredClone(a);b.products[0].variants[0].sku='NEW';assert.doesNotThrow(()=>assertCatalogueReplacementPreserved(a,b));
});
test('tenant, account or product move cannot rebind an existing cost',()=>{
  for(const change of [b=>b.workspace.id='other',b=>b.products[0].source.accountId='other',b=>b.products[0].id='other']){const a=stateWithCost(),b=structuredClone(a);change(b);assert.throws(()=>assertCatalogueReplacementPreserved(a,b));}
});
test('economics values including original supplier currency cannot be modified by comparison',()=>{
  const a=stateWithCost(),b=structuredClone(a);b.economics['TEST-1'].originalCurrency='GBP';assert.throws(()=>assertCatalogueReplacementPreserved(a,b),{code:'SHOPIFY_CATALOGUE_ECONOMICS_CHANGED'});
});
test('a full enriched saved capture passes preservation checks on a later independently admitted fixture',async t=>{
  const f=await fixture(t,{state:stateWithCost()});assert.equal((await f.submit()).status,200);const saved=structuredClone(f.fake.states.get(ID));
  assert.doesNotThrow(()=>assertCatalogueSavedPreservation(saved));const next=await fixture(t,{state:saved});assert.equal((await next.submit()).status,200);assert.deepEqual(next.fake.states.get(ID).economics,saved.economics);
});
test('legacy generated SKU economics cannot be silently detached when source normalization removes fallback',()=>{
  const a=stateWithCost(),p=a.products[0];p.handle='legacy';p.variants[0].sku=null;p.variants[0].title='Pack';a.economics={'legacy-Pack':{landed:9}};
  const b=structuredClone(a);b.products[0].source.system='shopify';assert.throws(()=>assertCatalogueReplacementPreserved(a,b),{code:'SHOPIFY_CATALOGUE_COST_ASSOCIATION_CHANGED'});
});
test('structured custom value hidden inside a scalar source field is not discarded',()=>{
  const s=stateWithCost();s.products[0].variants[0].title={text:'Pack',manualNote:'local'};assert.throws(()=>assertCatalogueSavedPreservation(s),{code:'SHOPIFY_CATALOGUE_CUSTOM_VARIANT_FIELDS'});
});
function idCostState(sku='OLD') {
  const s=stateWithCost(),v=s.products[0].variants[0];v.sku=sku;s.economics={[v.id]:{landed:6}};return s;
}
for(const sku of ['constructor','toString','__proto__']) {
  test('inherited '+sku+' cannot shadow own ID economics in a pure replacement',()=>{
    const before=idCostState(),after=structuredClone(before);after.products[0].variants[0].sku=sku;
    const v=after.products[0].variants[0];assert.notEqual(after.economics[v.sku]||after.economics[v.id],after.economics[v.id],'reproduce unchanged consumer shadowing');
    assert.throws(()=>assertCatalogueReplacementPreserved(before,after),{code:'SHOPIFY_CATALOGUE_COST_ASSOCIATION_AMBIGUOUS'});
    assert.equal(before.economics[before.products[0].variants[0].id].landed,6);
  });
  test('inherited '+sku+' from source refuses final HTTP/store save and remains spent',async t=>{
    const state=idCostState(),p=product();p.variants.nodes[0].sku=sku;
    const f=await fixture(t,{state,providerFetch:()=>response(page([p]))}),r=await f.submit();assert.equal(r.status,409,JSON.stringify(r.payload));
    assert.equal(r.payload.code,'SHOPIFY_CATALOGUE_COST_ASSOCIATION_AMBIGUOUS');const saved=f.fake.states.get(ID),v=saved.products[0].variants[0];
    assert.equal((saved.economics[v.sku]||saved.economics[v.id]).landed,6);assert.deepEqual(saved.products,state.products);assert.deepEqual(saved.economics,state.economics);
    assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);assert.equal(saved.shopifyCatalogueImports[0].status,'reserved');assert.equal(f.reads.length,2);
    await f.submit();assert.equal(f.reads.length,2);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);
  });
  test('saved inherited '+sku+' refuses admission without source reads',async t=>{
    const state=idCostState(sku),f=await fixture(t,{state}),r=await f.submit();assert.equal(r.payload.code,'SHOPIFY_CATALOGUE_COST_ASSOCIATION_AMBIGUOUS');assert.equal(f.reads.length,0);assert.equal(writes(f).length,0);
  });
  test('own '+sku+' economics remains a legitimate exact association',()=>{
    const s=idCostState(sku);Object.defineProperty(s.economics,sku,{value:{landed:7},enumerable:true,writable:true,configurable:true});
    assert.doesNotThrow(()=>assertCatalogueReplacementPreserved(s,structuredClone(s)));const v=s.products[0].variants[0];assert.equal((s.economics[v.sku]||s.economics[v.id]).landed,7);
  });
}
test('ordinary NEW SKU keeps own ID cost through complete HTTP/store import',async t=>{
  const state=idCostState(),p=product();p.variants.nodes[0].sku='NEW';const f=await fixture(t,{state,providerFetch:()=>response(page([p]))});assert.equal((await f.submit()).status,200);
  const saved=f.fake.states.get(ID),v=saved.products[0].variants[0];assert.equal((saved.economics[v.sku]||saved.economics[v.id]).landed,6);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,2);
});
