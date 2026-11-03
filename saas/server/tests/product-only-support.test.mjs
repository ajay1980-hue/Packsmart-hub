import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import {once} from 'node:events';
import {createPacksmartServer} from '../server.mjs';
import {createStartupPolicy} from '../lib/startup-mode.mjs';
import {PRODUCT_ONLY_SUPPORT_PATH as PATH,validateProductOnlyInput,supportProductProjection,SUPPORT_PRODUCT_WORKSPACE as WS} from '../lib/support-product-facts.mjs';
import {eligibleProduct,rawImportedProduct} from './support-product-fixtures.mjs';
const FLAG='RUNVARA_QUIET_PRODUCT_ONLY_SUPPORT';
const sku='DEMO-RETAIL-25',origin='https://packsmartsolutions.com';
const base={NODE_ENV:'test',RUNVARA_STARTUP_MODE:'quiet',SESSION_SECRET:'synthetic-product-only-secret-over-thirty-two-characters'};
const orderInput={message:'Where is my order?',orderNumber:'#1001',email:'synthetic@example.test'};
async function fixture(t,{enabled=true,publicSupport=false,existingProducts=false,mode='quiet',readError=false,products}={}){
  t.mock.method(console,'error',()=>{});const reads={products:[],orders:[]};
  const saved=products||[eligibleProduct(new Date(Date.now()-1000).toISOString())],before=structuredClone(saved);
  const store={provider:'supabase',ping:async()=>true,
    get:async()=>assert.fail('No hydration'),save:async()=>assert.fail('No writes'),
    getPublicSupportProduct:async(id,value)=>{reads.products.push({id,sku:value});if(readError)throw new Error('PRIVATE-ERROR-SENTINEL');return supportProductProjection(id,saved,value);},
    integrityCheck:async()=>assert.fail('No integrity repair'),listWorkspaceIds:async()=>assert.fail('No scheduling'),claimAgentJobs:async()=>assert.fail('No jobs')};
  if(publicSupport)store.getPublicSupportOrders=async id=>{reads.orders.push(id);return [{provider:'shopify',name:'#1001',fulfillmentStatus:'UNFULFILLED',customerEmailHash:crypto.createHash('sha256').update(orderInput.email).digest('hex')}];};
  const env={...base,RUNVARA_STARTUP_MODE:mode,...(enabled?{[FLAG]:'enabled/v1'}:{}),...(publicSupport?{RUNVARA_QUIET_PUBLIC_SUPPORT:'enabled/v1'}:{}),...(existingProducts?{RUNVARA_QUIET_SUPPORT_PRODUCTS:'enabled/v1'}:{})};
  const server=createPacksmartServer(env,{store,schedulerEnabled:false,agentOpsEnabled:false,fetchImpl:async()=>assert.fail('No provider/model request')});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await server.packsmart.drain();await new Promise(r=>server.close(r));assert.deepEqual(saved,before);});
  const request=(body={sku},{method='POST',path=PATH,requestOrigin=origin,contentType='application/json',raw,forwardedFor}={})=>new Promise((resolve,reject)=>{
    const data=raw??JSON.stringify(body),headers={'Content-Type':contentType,'Content-Length':Buffer.byteLength(data)};
    if(requestOrigin!==null)headers.Origin=requestOrigin;if(forwardedFor)headers['X-Forwarded-For']=forwardedFor;
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers},res=>{
      const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>{const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,headers:res.headers,body:text?JSON.parse(text):null});});
    });req.on('error',reject);req.end(data);
  });return {request,reads,server,env};
}

test('product-only switch defaults off, is strict/quiet-only and independent of generic support',()=>{
  for(const value of [undefined,'disabled/v1'])assert.equal(createStartupPolicy({...base,[FLAG]:value},[]).quietProductOnlySupport,false);
  for(const value of ['',true,null,'true','enabled','enabled/v1 ',1,{}])assert.throws(()=>createStartupPolicy({...base,[FLAG]:value},[]),{code:'QUIET_PRODUCT_ONLY_SUPPORT_INVALID'});
  for(const mode of [undefined,'normal'])assert.throws(()=>createStartupPolicy({...base,RUNVARA_STARTUP_MODE:mode,[FLAG]:'enabled/v1'},[]),{code:'QUIET_PRODUCT_ONLY_SUPPORT_INVALID'});
  const env={...base,[FLAG]:'enabled/v1'},p=createStartupPolicy(env,[]);env[FLAG]='disabled/v1';
  assert.equal(p.quietProductOnlySupport,true);assert.equal(p.quietPublicSupport,false);assert.equal(p.quietSupportProducts,false);
  assert.throws(()=>{p.quietProductOnlySupport=false;},TypeError);
});

test('product-only admission is exact-route/method and does not grant old support or private paths',()=>{
  const p=createStartupPolicy({...base,[FLAG]:'enabled/v1'},[]);
  for(const method of ['GET','HEAD','POST','OPTIONS','PUT','PATCH','DELETE','post'])
    for(const path of [PATH,PATH+'/',PATH+'?sku=A','/api/public/support/%70roducts','/api/public/support','/api/public/support/orders','/api/orders','/api/bootstrap','/api/integrations/sync'])
      assert.equal(p.allowsRequest(method,path),path===PATH&&['POST','OPTIONS'].includes(method),`${method} ${path}`);
});

test('product-only startup needs bounded Supabase product reader, not an order reader',()=>{
  for(const store of [{provider:'file',getPublicSupportProduct(){}},{provider:'supabase',getPublicSupportOrders(){}}])
    assert.throws(()=>createPacksmartServer({...base,[FLAG]:'enabled/v1'},{store}),{code:'QUIET_PRODUCT_ONLY_SUPPORT_UNAVAILABLE'});
  assert.throws(()=>createStartupPolicy({...base,[FLAG]:'enabled/v1',RUNVARA_QUIET_SUPPORT_PRODUCTS:'enabled/v1'},[]),{code:'QUIET_SUPPORT_PRODUCTS_INVALID'});
});

test('product-only request schema accepts an exact opaque SKU without trimming or free-text intent',()=>{
  assert.equal(validateProductOnlyInput({sku}),sku);assert.equal(validateProductOnlyInput({sku:'dispatch-order-123'}),'dispatch-order-123');
  for(const body of [null,[],{},'sku',1,{sku:1},{sku:null},{sku:''},{sku:' '+sku},{sku:sku+' '},{sku:'A B'},{sku:'A/B'},{sku:'A'.repeat(81)},{sku,message:''},{sku,email:''},{sku,orderNumber:''},{sku,workspaceId:WS}])
    assert.throws(()=>validateProductOnlyInput(body),{code:'PRODUCT_ONLY_INPUT_INVALID'});
});

for(const mode of ['quiet','normal'])test(`disabled product-only route is closed in ${mode} without reading saved data`,async t=>{
  const f=await fixture(t,{enabled:false,mode});for(const method of ['POST','OPTIONS','GET'])assert.equal((await f.request({sku},{method})).status,503);
  assert.deepEqual(f.reads,{products:[],orders:[]});
});

test('product-only capability performs bounded catalogue read with old support off and no order reader',async t=>{
  const f=await fixture(t);const r=await f.request();assert.equal(r.status,200);assert.equal(r.body.source,'saved_catalogue');
  assert.match(r.body.reply,/GBP 12\.3400/);assert.match(r.body.reply,/25 items per sellable pack/);assert.equal(r.body.needsOrderDetails,false);
  assert.deepEqual(f.reads,{products:[{id:WS,sku}],orders:[]});assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['set-cookie'],undefined);
  assert.equal(r.headers['access-control-allow-credentials'],undefined);
  const h=await f.request({}, {method:'GET',path:'/api/health'});assert.equal(h.body.quietProductOnlySupport,true);assert.equal(h.body.quietPublicSupport,false);assert.equal(h.body.quietSupportProducts,false);
  assert.equal(h.body.quietShopifyCatalogue,false);assert.equal(h.body.quietShopifyTokenExchange,false);assert.equal(h.body.quietShopifyDiagnostic,false);
  assert.equal(h.body.agentOps.running,false);assert.equal(f.server.packsmart.scheduler.status.lastTickAt,null);
});

test('direct old order endpoint, private order path and unsupported product methods are closed',async t=>{
  const f=await fixture(t);
  for(const path of ['/api/public/support','/api/public/support/orders','/api/orders'])assert.equal((await f.request(orderInput,{path})).status,503);
  for(const method of ['GET','HEAD','PUT','PATCH','DELETE'])assert.equal((await f.request(orderInput,{method})).status,503);
  assert.deepEqual(f.reads,{products:[],orders:[]});
});

for(const [name,body] of [
  ['direct order request',orderInput],['mixed product plus order',{sku,...orderInput}],['mixed free-text order intent',{sku,message:'Price and where is my order?'}],
  ['empty order identifier',{sku,orderNumber:''}],['email alone',{sku,email:'synthetic@example.test'}],['nested order injection',{sku,order:{number:'1001'}}],
  ['client capability selector',{sku,capability:'public-support'}],['client tenant selector',{sku,workspaceId:'foreign'}],['client product facts',{sku,supportProductFacts:{price:'FAKE'}}],
  ['unknown field',{sku,extra:false}],['array', [{sku}]],['null',null],['missing SKU',{}],['malformed SKU',{sku:'SKU: X'}]
])test(`product-only transport rejects ${name} before any data read`,async t=>{
  const f=await fixture(t);const r=await f.request(body);assert.equal(r.status,400);assert.equal(r.body.code,['array','null'].includes(name)?'JSON_INVALID':'PRODUCT_ONLY_INPUT_INVALID');
  assert.deepEqual(f.reads,{products:[],orders:[]});assert.doesNotMatch(JSON.stringify(r.body),/synthetic@example|FAKE|1001/);
});

test('query/path overrides are rejected without reads, including canonicalized path confusion',async t=>{
  const f=await fixture(t);
  for(const path of [PATH+'?orderNumber=1001',PATH+'?capability=public-support',PATH+'?',PATH+'/../products'])assert.equal((await f.request({sku},{path})).status,400);
  for(const path of [PATH+'/', '/api/public/support/%70roducts',PATH+'/orders'])assert.equal((await f.request({sku},{path})).status,503);
  assert.deepEqual(f.reads,{products:[],orders:[]});
});

test('malformed JSON, oversized body and unsupported media types fail before reads',async t=>{
  const f=await fixture(t);assert.equal((await f.request({},{raw:'{broken'})).status,400);
  assert.equal((await f.request({},{raw:'{"sku":"A","__proto__":{}}'})).status,400);
  assert.equal((await f.request({sku:'A'.repeat(600)})).status,413);
  for(const contentType of ['', 'text/plain','application/x-www-form-urlencoded'])assert.equal((await f.request({sku},{contentType})).status,415);
  assert.deepEqual(f.reads,{products:[],orders:[]});
});

test('existing origin restrictions and preflight remain bounded without data reads',async t=>{
  const f=await fixture(t);
  for(const method of ['OPTIONS','POST'])assert.equal((await f.request({sku},{method,requestOrigin:'https://foreign.example.test'})).status,403);
  const r=await f.request({}, {method:'OPTIONS'});assert.equal(r.status,204);assert.equal(r.headers['access-control-allow-origin'],origin);
  assert.equal(r.headers['access-control-allow-methods'],'POST, OPTIONS');assert.equal(r.headers['access-control-allow-credentials'],undefined);
  assert.deepEqual(f.reads,{products:[],orders:[]});
});

test('unsupported or order-sounding SKU stays product-only with no order-detail solicitation',async t=>{
  const f=await fixture(t);const r=await f.request({sku:'dispatch-order-123'});assert.equal(r.status,200);assert.equal(r.body.intent,'product');assert.equal(r.body.needsOrderDetails,false);
  assert.match(r.body.reply,/product-only check does not look up orders/);assert.doesNotMatch(r.body.reply,/Enter your order number|checkout email/);
  assert.deepEqual(f.reads,{products:[{id:WS,sku:'dispatch-order-123'}],orders:[]});
});

test('raw catalogue mapping remains ineligible on product-only route',async t=>{
  const f=await fixture(t,{products:[rawImportedProduct(new Date(Date.now()-1000).toISOString())]});const r=await f.request();
  assert.equal(r.status,200);assert.match(r.body.reply,/cannot verify/);assert.equal(r.body.needsOrderDetails,false);assert.doesNotMatch(r.body.reply,/12\.3400|25 items/);
});

test('product-only read failure is redacted and never retried or replaced with order/model work',async t=>{
  const f=await fixture(t,{readError:true});const r=await f.request();assert.equal(r.status,503);assert.equal(r.body.code,'SUPPORT_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(r.body),/PRIVATE-ERROR/);assert.equal(f.reads.products.length,1);assert.equal(f.reads.orders.length,0);
});

test('independently enabled old support is unchanged and does not enable new route',async t=>{
  const f=await fixture(t,{enabled:false,publicSupport:true,existingProducts:true});assert.equal((await f.request()).status,503);
  const order=await f.request(orderInput,{path:'/api/public/support'});assert.equal(order.status,200);assert.equal(order.body.source,'saved_order');
  const product=await f.request({message:'Price SKU: '+sku},{path:'/api/public/support'});assert.equal(product.status,200);assert.equal(product.body.source,'saved_catalogue');
  assert.deepEqual(f.reads,{products:[{id:WS,sku}],orders:[WS]});
});

test('both independent capabilities preserve old order behavior but reject mixed requests on product route',async t=>{
  const f=await fixture(t,{publicSupport:true});assert.equal((await f.request({sku,...orderInput})).status,400);
  assert.equal((await f.request(orderInput,{path:'/api/public/support'})).body.source,'saved_order');
  assert.equal((await f.request()).body.source,'saved_catalogue');assert.deepEqual(f.reads,{products:[{id:WS,sku}],orders:[WS]});
});

test('shared instance rate cap bounds both public routes without a second independent allowance',async t=>{
  const f=await fixture(t,{publicSupport:true});
  for(let i=0;i<20;i++){
    const r=i%2?await f.request({message:'Hello'},{path:'/api/public/support',forwardedFor:'192.0.2.'+(i+1)}):await f.request({sku},{forwardedFor:'192.0.2.'+(i+1)});
    assert.equal(r.status,200);
  }
  assert.equal((await f.request()).status,429);assert.equal(f.reads.products.length,10);assert.equal(f.reads.orders.length,0);
});
