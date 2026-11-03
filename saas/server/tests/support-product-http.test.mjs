import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createPacksmartServer} from '../server.mjs';
import {createStartupPolicy} from '../lib/startup-mode.mjs';
import {supportProductProjection,SUPPORT_PRODUCT_WORKSPACE as WS} from '../lib/support-product-facts.mjs';
import {eligibleProduct,rawImportedProduct} from './support-product-fixtures.mjs';
const base={NODE_ENV:'test',RUNVARA_STARTUP_MODE:'quiet',RUNVARA_QUIET_PUBLIC_SUPPORT:'enabled/v1',SESSION_SECRET:'synthetic-secret-over-thirty-two-characters'};
async function fixture(t,{enabled=true,products,readError=false}={}){
  t.mock.method(console,'error',()=>{});const reads=[];
  const store={provider:'supabase',ping:async()=>true,get:async()=>assert.fail('No hydration'),save:async()=>assert.fail('No writes'),
    getPublicSupportOrders:async()=>assert.fail('No order read for product questions'),
    getPublicSupportProduct:async(id,sku)=>{reads.push({id,sku});if(readError)throw new Error('PRIVATE-ERROR');return supportProductProjection(id,products||[eligibleProduct(new Date(Date.now()-1000).toISOString())],sku);},
    integrityCheck:async()=>assert.fail('No repair'),listWorkspaceIds:async()=>assert.fail('No worker'),claimAgentJobs:async()=>assert.fail('No claims')};
  const server=createPacksmartServer({...base,...(enabled?{RUNVARA_QUIET_SUPPORT_PRODUCTS:'enabled/v1'}:{})},{store,fetchImpl:async()=>assert.fail('No provider or model request')});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{await server.packsmart.drain();await new Promise(r=>server.close(r));});
  const request=(body,{origin='https://packsmartsolutions.com',method='POST',path='/api/public/support'}={})=>new Promise((resolve,reject)=>{
    const data=JSON.stringify(body);const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{Origin:origin,'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},res=>{
      const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>{const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,headers:res.headers,body:text?JSON.parse(text):null});});
    });req.on('error',reject);req.end(data);
  });return {server,request,reads};
}
test('product capability defaults off and requires exact enabled quiet support with immutable admission',()=>{
  assert.equal(createStartupPolicy(base,[]).quietSupportProducts,false);
  for(const value of ['',true,'true','enabled/v1 ',null])assert.throws(()=>createStartupPolicy({...base,RUNVARA_QUIET_SUPPORT_PRODUCTS:value},[]),{code:'QUIET_SUPPORT_PRODUCTS_INVALID'});
  assert.throws(()=>createStartupPolicy({...base,RUNVARA_QUIET_PUBLIC_SUPPORT:'disabled/v1',RUNVARA_QUIET_SUPPORT_PRODUCTS:'enabled/v1'},[]),{code:'QUIET_SUPPORT_PRODUCTS_INVALID'});
  const env={...base,RUNVARA_QUIET_SUPPORT_PRODUCTS:'enabled/v1'},p=createStartupPolicy(env,[]);env.RUNVARA_QUIET_SUPPORT_PRODUCTS='disabled/v1';assert.equal(p.quietSupportProducts,true);
  assert.equal(p.allowsRequest('GET','/api/public/support'),false);assert.equal(p.allowsRequest('POST','/api/integrations/shopify/sync'),false);
});
test('product-specific flag off does not read saved catalogue even while generic support is enabled',async t=>{
  const f=await fixture(t,{enabled:false});const r=await f.request({message:'Pack price SKU: DEMO-RETAIL-25'});assert.equal(r.status,200);assert.match(r.body.reply,/cannot verify/);assert.deepEqual(f.reads,[]);
});
test('enabled exact-SKU request uses fixed tenant projection, no writes, providers, orders or injected facts',async t=>{
  const f=await fixture(t);const r=await f.request({message:'Pack price SKU: DEMO-RETAIL-25',workspaceId:'foreign',products:[{price:'FAKE'}],supportProductFacts:{sku:'INJECTED'}});
  assert.equal(r.status,200);assert.equal(r.body.source,'saved_catalogue');assert.match(r.body.reply,/GBP 12\.3400/);assert.match(r.body.reply,/25 items per sellable pack/);assert.doesNotMatch(r.body.reply,/FAKE|INJECTED/);
  assert.deepEqual(f.reads,[{id:WS,sku:'DEMO-RETAIL-25'}]);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['set-cookie'],undefined);
  const h=await f.request({},{method:'GET',path:'/api/health'});assert.equal(h.body.quietSupportProducts,true);assert.equal(h.body.agentOps.running,false);assert.equal(f.server.packsmart.scheduler.status.lastTickAt,null);
});
test('raw unverified imported product remains unknown, with no invented pack or price',async t=>{
  const f=await fixture(t,{products:[rawImportedProduct(new Date(Date.now()-1000).toISOString())]});const r=await f.request({message:'Pack size SKU: DEMO-RETAIL-25'});
  assert.match(r.body.reply,/cannot verify/);assert.doesNotMatch(r.body.reply,/12\.3400|25 items/);assert.equal(r.body.needsHuman,true);
});
test('unsupported origin and ambiguous or absent SKU cause no product read',async t=>{
  const f=await fixture(t);assert.equal((await f.request({message:'SKU: DEMO-RETAIL-25'},{origin:'https://foreign.example.test'})).status,403);
  for(const message of ['What is the price?','SKU: A SKU: B','Shipping for SKU: DEMO-RETAIL-25','Refund SKU: DEMO-RETAIL-25','Stock for SKU: DEMO-RETAIL-25'])await f.request({message});
  assert.deepEqual(f.reads,[]);
});
test('product read failure is redacted, not retried or replaced by model inference',async t=>{
  const f=await fixture(t,{readError:true});const r=await f.request({message:'Price SKU: DEMO-RETAIL-25'});assert.equal(r.status,503);assert.equal(f.reads.length,1);assert.doesNotMatch(JSON.stringify(r.body),/PRIVATE-ERROR/);
});
test('same saved query remains deterministic and the existing instance rate cap still bounds reads',async t=>{
  const f=await fixture(t,{products:[eligibleProduct(new Date(Date.now()-1000).toISOString())]});let first;
  for(let i=0;i<20;i++){const r=await f.request({message:'Price SKU: DEMO-RETAIL-25'});assert.equal(r.status,200);if(first)assert.deepEqual(r.body,first);first=r.body;}
  assert.equal((await f.request({message:'Price SKU: DEMO-RETAIL-25'})).status,429);assert.equal(f.reads.length,20);
});
