import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fixture, product, page, response, catalogueState, catalogueEnv, ID } from './shopify-catalogue-import-fixture.mjs';
import { CATALOGUE_PATH, CATALOGUE_LIMITS, createCataloguePolicy, readBoundedCatalogue } from '../lib/shopify-catalogue-import.mjs';
import { createStartupPolicy } from '../lib/startup-mode.mjs';
import { encryptCredentials } from '../lib/security.mjs';
import { SECRET } from './maintenance-login-fixture.mjs';
import { deriveOperations } from '../lib/operations.mjs';

test('default closed; exact quiet owner capability and absolute expiry required',()=>{
  assert.equal(createCataloguePolicy({}),null);
  for(const value of [true,'true','enabled/v1 ',null]) assert.throws(()=>createCataloguePolicy({RUNVARA_QUIET_SHOPIFY_CATALOGUE:value}));
  assert.throws(()=>createCataloguePolicy(catalogueEnv()));
  assert.throws(()=>createCataloguePolicy({RUNVARA_STARTUP_MODE:'quiet',...catalogueEnv({RUNVARA_SHOPIFY_CATALOGUE_EXPIRES_AT:new Date(Date.now()+700000).toISOString()})}));
  const p=createStartupPolicy({RUNVARA_STARTUP_MODE:'quiet',...catalogueEnv({RUNVARA_SHOPIFY_CATALOGUE_EXPIRES_AT:'2020-01-01T00:00:00.000Z'})},[]);
  assert.equal(p.allowsRequest('POST',CATALOGUE_PATH),false); assert.equal(p.allowsRequest('GET',CATALOGUE_PATH),true);
  assert.equal(p.allowsRequest('POST','/api/integrations/sync'),false);
});
function policyClock(t,remainingMs=1000) {
  const start=Date.parse('2026-11-01T12:00:00.000Z'), clock={wall:start,mono:100};
  t.mock.method(Date,'now',()=>clock.wall); t.mock.method(performance,'now',()=>clock.mono);
  const env={RUNVARA_STARTUP_MODE:'quiet',...catalogueEnv({RUNVARA_SHOPIFY_CATALOGUE_EXPIRES_AT:new Date(start+remainingMs).toISOString()})};
  return {clock,env,policy:createCataloguePolicy(env)};
}
test('expiry remains latched when wall time moves backwards after an expired check',t=>{
  const {clock,policy}=policyClock(t); clock.wall+=1000;
  assert.equal(policy.available(),false); clock.wall-=2000;
  assert.equal(policy.available(),false); assert.throws(()=>policy.assertActive(),{code:'SHOPIFY_CATALOGUE_EXPIRED'});
});
test('backwards wall adjustment before expiry closes the grant permanently',t=>{
  const {clock,policy}=policyClock(t); clock.wall+=100; clock.mono+=100; policy.assertActive();
  clock.wall-=1; assert.throws(()=>policy.assertActive(),{code:'SHOPIFY_CATALOGUE_EXPIRED'});
  clock.wall+=1; assert.equal(policy.available(),false);
});
test('monotonic deadline closes an unused grant even while wall time is stalled',t=>{
  const {clock,policy}=policyClock(t); clock.mono+=999; assert.equal(policy.available(),true);
  clock.mono+=1; assert.equal(policy.available(),false); clock.wall-=100;
  assert.throws(()=>policy.assertActive(),{code:'SHOPIFY_CATALOGUE_EXPIRED'});
});
test('restart retains only the remaining absolute window and expired construction stays closed',t=>{
  const {clock,env}=policyClock(t); clock.wall+=750; clock.mono+=750;
  const restarted=createCataloguePolicy(env); clock.mono+=250;
  assert.equal(restarted.available(),false);
  clock.wall+=250; const expired=createCataloguePolicy(env); clock.wall-=500;
  assert.equal(expired.available(),false); assert.throws(()=>expired.assertActive(),{code:'SHOPIFY_CATALOGUE_EXPIRED'});
});
test('invalid or backwards clock readings fail closed without later recovery',t=>{
  const {clock,env}=policyClock(t);
  for(const [field,value] of [['wall',NaN],['wall',Infinity],['mono',NaN],['mono',99]]) {
    clock.wall=Date.parse('2026-11-01T12:00:00.000Z'); clock.mono=100;
    const policy=createCataloguePolicy(env); clock[field]=value;
    assert.equal(policy.available(),false); clock.wall=Date.parse('2026-11-01T12:00:00.000Z'); clock.mono=100;
    assert.throws(()=>policy.assertActive(),{code:'SHOPIFY_CATALOGUE_EXPIRED'});
  }
});
test('one complete import uses current source currency, preserves unrelated state and performs no reporting mirrors',async t=>{
  const f=await fixture(t); const before=structuredClone(f.fake.states.get(ID));
  const r=await f.submit(); assert.equal(r.status,200,JSON.stringify(r.payload)); assert.equal(r.payload.run.status,'imported');
  const saved=f.fake.states.get(ID), p=saved.products[0];
  assert.equal(p.currency,'GBP'); assert.equal(p.variants[0].priceDecimal,'12.30'); assert.equal(p.variants[0].raw.price,'12.30');
  assert.equal(p.source.accountId,'gid://shopify/Shop/123'); assert.equal(p.source.currencySource,'Shop.currencyCode');
  assert.equal(p.variants[0].stock.onHand,null); assert.equal(p.variants[0].stock.available,12); assert.equal(p.variants[0].stock.aggregateEligible,false);
  for(const key of ['users','connections','orders','economics','settings','automations','autopilot','agentOps']) assert.deepEqual(saved[key],before[key],key);
  assert.equal(saved.audit.length,before.audit.length+2); assert.equal(f.reads.length,1);
  assert.equal(f.calls.filter(c=>c.method==='PATCH').length,2); assert.equal(f.calls.some(c=>c.method==='POST'),false);
  assert.equal(saved.integrationStatus.reporting.status,'degraded'); assert.equal(f.server.packsmart.scheduler.status.lastTickAt,null);
  assert.equal(f.server.packsmart.agentOps.status.lastTickAt,null);
});
test('duplicate logical request and reentry read receipt without repeating provider work',async t=>{
  const f=await fixture(t); assert.equal((await f.submit()).status,200);
  assert.equal((await f.submit()).payload.run.status,'imported'); assert.equal((await f.status()).payload.canRun,false); assert.equal(f.reads.length,1);
});
test('stale revisions, changed request ID, extra input and query overrides rejected before writes',async t=>{
  const f=await fixture(t);
  for(const body of [{requestId:randomUUID(),expectedRevision:f.fake.states.get(ID)._revision},{requestId:f.env.RUNVARA_SHOPIFY_CATALOGUE_REQUEST_ID,expectedRevision:randomUUID()},{requestId:f.env.RUNVARA_SHOPIFY_CATALOGUE_REQUEST_ID,expectedRevision:f.fake.states.get(ID)._revision,areas:['orders']}]) assert.equal((await f.submit(body)).status,409);
  assert.equal((await f.request(CATALOGUE_PATH+'?workspaceId=beta',{cookie:f.cookie})).status,400);
  assert.equal(f.reads.length,0); assert.equal(f.calls.filter(c=>c.method==='PATCH').length,0);
});
for(const mode of ['csrf','origin','admin','inactive','revoked','tenant']) test('admission rejects '+mode,async t=>{
  const f=await fixture(t); const user=f.fake.states.get(ID).users[0]; let extra={};
  if(mode==='csrf') extra={headers:{}};
  if(mode==='origin') extra={headers:{'X-CSRF-Token':f.session.csrf,Origin:'https://other.example'}};
  if(mode==='admin') user.role='admin'; if(mode==='inactive')user.active=false; if(mode==='revoked')user.sessionVersion++;
  if(mode==='tenant')f.fake.states.get(ID).products.push({workspaceId:'beta'});
  assert.ok([401,403].includes((await f.submit(undefined,extra)).status)); assert.equal(f.reads.length,0); assert.equal(f.calls.filter(c=>c.method==='PATCH').length,0);
});
test('multiple complete pages stage before final save and retain missing historical rows without claiming freshness',async t=>{
  const state=catalogueState(); state.products=[{id:'gid://shopify/Product/999',provider:'shopify',title:'Old',variants:[]}];
  const f=await fixture(t,{state,providerFetch:(_input,n)=>response(n===1?page([product(1)],true,'next'):page([product(2)]))});
  assert.equal((await f.submit()).status,200); assert.equal(f.reads.length,2); assert.equal(f.reads[1].variables.after,'next');
  const p=f.fake.states.get(ID).products; assert.equal(p.length,3); assert.equal(p[0].catalogueObserved,false);
});
for(const defect of ['variant-page','cursor','duplicate','missing-currency','changed-account','malformed','graphql','api-version','oversize','limit']) test('incomplete '+defect+' never replaces catalogue',async t=>{
  const state=catalogueState(); state.products=[{id:'old',provider:'ebay',title:'Preserved'}];
  const f=await fixture(t,{state,providerFetch:(_input,n)=>{
    const b=page([product(n)]);
    if(defect==='variant-page') b.data.products.nodes[0].variants.pageInfo.hasNextPage=true;
    if(defect==='cursor') Object.assign(b.data.products.pageInfo,{hasNextPage:true,endCursor:'same'});
    if(defect==='duplicate') b.data.products.nodes.push(product(n));
    if(defect==='missing-currency') delete b.data.shop.currencyCode;
    if(defect==='changed-account') b.data.shop.myshopifyDomain='other.myshopify.com';
    if(defect==='malformed') b.data.products.nodes[0].variants.nodes[0].price='not-money';
    if(defect==='graphql') b.errors=[{message:'partial'}];
    if(defect==='oversize') b.padding='x'.repeat(CATALOGUE_LIMITS.pageBytes);
    if(defect==='limit') Object.assign(b.data.products.pageInfo,{hasNextPage:true,endCursor:'next'+n});
    return response(b,defect==='api-version'?'2026-10':'2026-07');
  }});
  assert.notEqual((await f.submit()).status,200); assert.deepEqual(f.fake.states.get(ID).products,state.products);
  assert.equal(f.fake.states.get(ID).shopifyCatalogueImports[0].status,'reserved');
  const reads=f.reads.length; assert.equal((await f.submit()).payload.run.status,'reserved'); assert.equal(f.reads.length,reads);
});
test('source account currency overrides reporting GBP; no currency conversion',async t=>{
  const f=await fixture(t,{providerFetch:()=>{const b=page(); b.data.shop.currencyCode='EUR';return response(b);}});
  assert.equal((await f.submit()).payload.run.currency,'EUR');assert.equal(f.fake.states.get(ID).products[0].currency,'EUR');
});
test('source revocation during a page aborts without final persistence',async t=>{
  let f; f=await fixture(t,{providerFetch:()=>{const s=f.fake.states.get(ID);s.users[0].sessionVersion++;s._revision=randomUUID();return response();}});
  assert.notEqual((await f.submit()).status,200); assert.equal(f.fake.states.get(ID).products.length,0);
});
test('token renewal is never called when stored token is missing or expired',async t=>{
  for(const creds of [{clientId:'dummy',clientSecret:'dummy'},{accessToken:'synthetic-token-only',expiresAt:Date.now()-1}]) {
    const state=catalogueState();state.connections[0].encryptedCredentials=encryptCredentials({storeDomain:'wavtzm-vy.myshopify.com',...creds},SECRET);
    const f=await fixture(t,{state}); assert.equal((await f.submit()).payload.code,'SHOPIFY_CATALOGUE_TOKEN_RENEWAL_REQUIRED');assert.equal(f.reads.length,0);
  }
});
test('uncertain final persistence is not replayed; authoritative status can reconcile exact receipt',async t=>{
  let writes=0; const f=await fixture(t,{intercept:async({options,proceed})=>{
    if(options.method==='PATCH' && ++writes===2) { await proceed(); throw new Error('Synthetic lost acknowledgement'); } return proceed();
  }});
  const r=await f.submit(); assert.ok([200,503].includes(r.status)); assert.equal((await f.status()).payload.run.status,'imported');assert.equal(writes,2);assert.equal(f.reads.length,1);
});
test('unknown reservation never starts provider read or retries PATCH',async t=>{
  let writes=0;const f=await fixture(t,{intercept:({options,proceed})=>{if(options.method==='PATCH'){writes++;throw new Error('Synthetic timeout');}return proceed();}});
  assert.equal((await f.submit()).payload.code,'SHOPIFY_CATALOGUE_COMMIT_UNCERTAIN'); assert.equal((await f.submit()).status,503);assert.equal(writes,1);assert.equal(f.reads.length,0);
});
test('concurrent attempts admit at most one provider run',async t=>{
  const f=await fixture(t), body={requestId:f.env.RUNVARA_SHOPIFY_CATALOGUE_REQUEST_ID,expectedRevision:f.fake.states.get(ID)._revision};
  const results=await Promise.all([f.submit(body),f.submit(body)]);assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(f.reads.length,1);
});
test('bundle, explicit component, archived and SKU hints remain distinct without retail inference',async t=>{
  const a=product(1),b=product(2,{productType:'Component'}),c=product(3,{status:'ARCHIVED'}),d=product(4);
  a.variants.nodes[0].requiresComponents=true;d.variants.nodes[0].sku='RAW-TEST';
  const f=await fixture(t,{providerFetch:()=>response(page([a,b,c,d]))});assert.equal((await f.submit()).status,200);
  const products=f.fake.states.get(ID).products;assert.deepEqual(products.map(p=>p.catalogueClassification.kind),['bundle','component','unclassified','internal_review']);
  assert.equal(products[2].status,'archived');assert.ok(products.every(p=>p.catalogueClassification.retailVerified===false && p.stock.aggregateEligible===false));
});

test('valid unlisted products and null SKUs retain exact source evidence',async t=>{
  const p=product(1,{status:'UNLISTED'});p.variants.nodes[0].sku=null;
  const f=await fixture(t,{providerFetch:()=>response(page([p]))});assert.equal((await f.submit()).status,200);
  const saved=f.fake.states.get(ID).products[0];assert.equal(saved.status,'unlisted');assert.equal(saved.variants[0].sku,null);assert.equal(saved.variants[0].raw.sku,null);
  assert.equal(saved.catalogueClassification.kind,'unclassified');
  assert.equal(deriveOperations(f.fake.states.get(ID)).productRows[0].sku,'','missing source SKU must not become an invented matching key');
});

test('query bounds reduce nested connection cost and oversized source pages fail closed',async t=>{
  const f=await fixture(t,{providerFetch:input=>{assert.equal(input.variables.first,10);assert.match(input.query,/variants\(first: 50\)/);return response(page(Array.from({length:11},(_,i)=>product(i+1))));}});
  assert.notEqual((await f.submit()).status,200);assert.equal(f.fake.states.get(ID).products.length,0);
});

test('absent historical products cannot create current financial or replenishment recommendations',async t=>{
  const s=catalogueState();s.products=[{id:'gid://shopify/Product/999',provider:'shopify',title:'Retained old record',status:'active',variants:[{id:'old',sku:'OLD',price:20,inventory:0,available:false}]}];
  s.economics.OLD={landed:1,packing:1,delivery:1,fees:1,returns:0,vat:0};
  const p=product(1);p.totalInventory=100;p.variants.nodes[0].inventoryQuantity=100;
  const f=await fixture(t,{state:s,providerFetch:()=>response(page([p]))});assert.equal((await f.submit()).status,200);
  const ops=deriveOperations(f.fake.states.get(ID));
  assert.equal(ops.productRows.find(p=>p.sku==='OLD').contribution,null);
  assert.equal(ops.stockRisks,0);assert.ok(!ops.recommendations.some(r=>r.id==='stock-risk'));
});

for(const drift of ['credential','domain','settings','expiry']) test('mid-read '+drift+' change leaves a durable claim and old catalogue',async t=>{
  let f;f=await fixture(t,{providerFetch:()=>{
    const s=f.fake.states.get(ID);
    if(drift==='credential')s.connections[0].encryptedCredentials=encryptCredentials({accessToken:'changed'},SECRET);
    if(drift==='domain')s.connections[0].metadata.shopDomain='other.myshopify.com';
    if(drift==='settings')s.connectionSettings.shopify.disconnected=true;
    if(drift==='expiry')t.mock.method(Date,'now',()=>Date.parse(f.env.RUNVARA_SHOPIFY_CATALOGUE_EXPIRES_AT)+1);
    return response();
  }});
  assert.notEqual((await f.submit()).status,200);assert.equal(f.fake.states.get(ID).products.length,0);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);
  assert.equal(f.fake.states.get(ID).shopifyCatalogueImports[0].status,'reserved');
});

test('restarting with a reserved claim does not repeat the provider request',async t=>{
  const f=await fixture(t,{providerFetch:()=>{throw Error('synthetic lost response');}});assert.notEqual((await f.submit()).status,200);
  const restart=await fixture(t,{state:structuredClone(f.fake.states.get(ID)),env:f.env});assert.equal((await restart.submit()).payload.run.status,'reserved');assert.equal(restart.reads.length,0);
});

test('normal audit retention failures stop before source access and preserve history',async t=>{
  const s=catalogueState();s.audit=Array.from({length:301},(_,i)=>({id:'synthetic-audit-'+i,type:'synthetic',createdAt:'2026-10-01T00:00:00.000Z'}));
  const f=await fixture(t,{state:s,intercept:({url,proceed})=>url.pathname.endsWith('/audit_events')?Response.json({code:'synthetic_archive_failure'},{status:503}):proceed()});
  assert.notEqual((await f.submit()).status,200);assert.equal(f.reads.length,0);assert.deepEqual(f.fake.states.get(ID).audit,s.audit);assert.equal(f.calls.filter(c=>c.method==='PATCH').length,0);
});

test('state size guard refuses oversized catalogue without replacing existing products',async t=>{
  const s=catalogueState();s.syntheticPadding='x'.repeat(1950000);
  const p=product(1,{description:'x'.repeat(150000)});
  const f=await fixture(t,{state:s,providerFetch:()=>response(page([p]))});assert.notEqual((await f.submit()).status,200);
  assert.equal(f.fake.states.get(ID).products.length,0);assert.equal(f.fake.states.get(ID).shopifyCatalogueImports[0].status,'reserved');assert.equal(f.calls.filter(c=>c.method==='PATCH').length,1);
});
