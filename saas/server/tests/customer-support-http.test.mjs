import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';

const origin = 'https://packsmartsolutions.com';
const emailHash = value => crypto.createHash('sha256').update(value).digest('hex');

async function fixture(t, mode='normal', options={}) {
  const reads=[];
  t.mock.method(console,'error',()=>{});
  const states={
    'packsmart-solutions':{orders:[{provider:'shopify',name:'#1001',financialStatus:'PAID',fulfillmentStatus:'UNFULFILLED',customerEmailHash:emailHash('packsmart-buyer@example.test')}]},
    'other-tenant':{orders:[{provider:'shopify',name:'#9999',financialStatus:'PAID',fulfillmentStatus:'FULFILLED',customerEmailHash:emailHash('other-buyer@example.test'),statusPageUrl:'https://other.example.test/private-tracking'}]}
  };
  const before=structuredClone(states);
  const store={provider:options.enabled?'supabase':'file',ping:async()=>true,
    get:async()=>assert.fail('Support must not hydrate a workspace'),
    getPublicSupportOrders:async id=>{reads.push(id);if(options.readError)throw new Error('private-read-error-sentinel');return structuredClone(states[id]?.orders||[]);},
    save:async()=>assert.fail('Support must not save'),integrityCheck:async()=>assert.fail('Quiet support must not repair'),
    listWorkspaceIds:async()=>assert.fail('Quiet support must not schedule'),claimAgentJobs:async()=>assert.fail('Quiet support must not claim')};
  const server=createPacksmartServer({NODE_ENV:'test',RUNVARA_STARTUP_MODE:mode,SESSION_SECRET:'synthetic-support-secret-over-thirty-two-characters',
    ...(options.enabled?{RUNVARA_QUIET_PUBLIC_SUPPORT:'enabled/v1'}:{})},
    {store,schedulerEnabled:mode==='quiet',agentOpsEnabled:mode==='quiet',fetchImpl:async()=>assert.fail('Support must not call providers')});
  t.after(async()=>{await server.packsmart.drain();await new Promise(resolve=>server.close(resolve));assert.deepEqual(states,before);});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const request=(body, {method='POST',requestOrigin=origin,path='/api/public/support',raw,contentType='application/json',forwardedFor}={})=>new Promise((resolve,reject)=>{
    const data=raw??JSON.stringify(body);
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:{Origin:requestOrigin,'Content-Type':contentType,'Content-Length':Buffer.byteLength(data),...(forwardedFor?{'X-Forwarded-For':forwardedFor}:{})}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
      res.on('end',()=>{const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,headers:res.headers,body:text?JSON.parse(text):null});});
    });req.on('error',reject);req.end(data);
  });
  return {request,reads,server};
}

test('public support ignores client tenant selection and reads only the fixed storefront workspace',async t=>{
  const f=await fixture(t);
  const response=await f.request({message:'Where is my order?',orderNumber:'#9999',email:'other-buyer@example.test',workspaceId:'other-tenant',tenantId:'other-tenant'},
    {path:'/api/public/support?workspaceId=other-tenant&tenantId=other-tenant'});
  assert.equal(response.status,200);
  assert.equal(response.body.needsHuman,true);
  assert.notEqual(response.body.matchedOrder,true);
  assert.doesNotMatch(JSON.stringify(response.body),/private-tracking|dispatched|9999/);
  assert.deepEqual(f.reads,['packsmart-solutions']);
});

test('public support returns corrected saved status without writes or provider calls',async t=>{
  const f=await fixture(t);
  const response=await f.request({message:'Where is my order?',orderNumber:'#1001',email:'packsmart-buyer@example.test'});
  assert.equal(response.status,200);
  assert.equal(response.headers['access-control-allow-origin'],origin);
  assert.equal(response.body.matchedOrder,true);
  assert.match(response.body.reply,/\*\*not yet dispatched\*\*/);
  assert.deepEqual(f.reads,['packsmart-solutions']);
});

test('public support rejects an unrelated origin before reading the workspace',async t=>{
  const f=await fixture(t);
  const response=await f.request({message:'Where is my order?'},{requestOrigin:'https://other.example.test'});
  assert.equal(response.status,403);
  assert.equal(response.body.code,'ORIGIN_DENIED');
  assert.deepEqual(f.reads,[]);
});

test('quiet startup still blocks support POST and preflight before workspace access',async t=>{
  const f=await fixture(t,'quiet');
  for(const method of ['POST','OPTIONS']){
    const response=await f.request({message:'Where is my order?'},{method});
    assert.equal(response.status,503);
    assert.equal(response.body.code,'STARTUP_QUIET_MODE');
  }
  assert.deepEqual(f.reads,[]);
});

test('enabled quiet support admits only the endpoint and keeps workers and other business routes closed',async t=>{
  const f=await fixture(t,'quiet',{enabled:true});
  const preflight=await f.request({}, {method:'OPTIONS'});
  assert.equal(preflight.status,204);
  assert.equal(preflight.headers['access-control-allow-origin'],origin);
  assert.equal(preflight.headers['access-control-allow-methods'],'POST, OPTIONS');
  assert.equal(preflight.headers['access-control-allow-credentials'],undefined);
  assert.deepEqual(f.reads,[]);
  const result=await f.request({message:'Where is my order?',orderNumber:'#1001',email:'packsmart-buyer@example.test',workspaceId:'other-tenant'});
  assert.equal(result.status,200);assert.equal(result.body.source,'saved_order');
  assert.match(result.body.reply,/not a live carrier check/);
  assert.equal(result.headers['cache-control'],'no-store');assert.equal(result.headers['set-cookie'],undefined);
  for(const path of ['/api/bootstrap','/api/auth/login','/api/maintenance/commerce','/api/actions','/api/integrations/shopify/sync','/api/marketing/providers/runway/test','/api/webhooks/stripe','/api/public/support/']){
    assert.equal((await f.request({}, {path})).status,503,path);
  }
  for(const method of ['GET','PUT','DELETE','PATCH'])assert.equal((await f.request({}, {method})).status,503,method);
  const health=await f.request({}, {path:'/api/health',method:'GET'});
  assert.equal(health.body.quietPublicSupport,true);
  assert.equal(health.body.startupMode,'quiet');assert.equal(health.body.quietOwnerLogin,false);
  assert.equal(health.body.quietCommercePreview,false);assert.equal(health.body.quietApprovalPilot.open,false);assert.equal(health.body.quietCreativePilot.open,false);
  assert.equal(health.body.agentOps.running,false);assert.equal(f.server.packsmart.scheduler.status.lastTickAt,null);
  assert.deepEqual(f.reads,['packsmart-solutions']);
});

test('quiet generic and incomplete order questions do not read saved data or promise escalation',async t=>{
  const f=await fixture(t,'quiet',{enabled:true});
  for(const message of ['Hi','Delivery options','How do I return?','Stock available?','VAT invoice','Pack size','Please change my delivery address','Where is my order?']){
    const response=await f.request({message});assert.equal(response.status,200);
    assert.doesNotMatch(response.body.reply,/I.ll pass|will be passed|will pick it up|I can check it securely/);
  }
  assert.deepEqual(f.reads,[]);
});

test('quiet support protects the fixed tenant and returns no foreign order or raw email',async t=>{
  const f=await fixture(t,'quiet',{enabled:true});
  const response=await f.request({message:'Track order',orderNumber:'#9999',email:'other-buyer@example.test',tenantId:'other-tenant'},
    {path:'/api/public/support?workspaceId=other-tenant'});
  assert.equal(response.status,200);assert.equal(response.body.needsHuman,true);
  assert.doesNotMatch(JSON.stringify(response.body),/other-buyer|private-tracking|9999|dispatched/);
  assert.deepEqual(f.reads,['packsmart-solutions']);
});

test('quiet support input and origin failures occur before data access',async t=>{
  const f=await fixture(t,'quiet',{enabled:true});
  for(const [body,options,status] of [
    [{message:123},{},400],[{message:'x'.repeat(1201)},{},400],[{email:{}},{},400],
    [{orderNumber:'x'.repeat(81)},{},400],[{}, {raw:'{"email":"private-sentinel",'},400],
    [{},{raw:'[]'},400],[{},{raw:'x'.repeat(8193)},413],[{}, {contentType:'text/plain'},415],
    [{message:'Track order'},{requestOrigin:'https://attacker.example.test'},403]
  ]){
    const response=await f.request(body,options);assert.equal(response.status,status);
    assert.doesNotMatch(JSON.stringify(response.body),/private-sentinel/);
    if(status!==403)assert.equal(response.headers['access-control-allow-origin'],origin);
  }
  assert.deepEqual(f.reads,[]);
});

test('quiet support has bounded IP requests and exposes no store failure details or retries',async t=>{
  const f=await fixture(t,'quiet',{enabled:true,readError:true});
  const response=await f.request({message:'Track order',orderNumber:'#1001',email:'packsmart-buyer@example.test'});
  assert.equal(response.status,503);assert.equal(response.body.code,'SUPPORT_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(response.body),/private-read-error|packsmart-buyer/);
  assert.equal(response.headers['access-control-allow-origin'],origin);assert.equal(f.reads.length,1);
  for(let i=0;i<19;i++)assert.equal((await f.request({message:'Hi'})).status,200);
  const limited=await f.request({message:'Track order',orderNumber:'#1001',email:'packsmart-buyer@example.test'});
  assert.equal(limited.status,429);assert.equal(limited.body.code,'SUPPORT_RATE_LIMITED');assert.equal(f.reads.length,1);
});

test('new disabled process closes support after an enabled process',async t=>{
  const open=await fixture(t,'quiet',{enabled:true});
  assert.equal((await open.request({message:'Hi'})).status,200);
  await open.server.packsmart.drain();
  assert.equal((await open.request({message:'Hi'})).status,503);
  const closed=await fixture(t,'quiet');
  assert.equal((await closed.request({message:'Hi'})).status,503);assert.deepEqual(closed.reads,[]);
});

test('forwarded IP changes cannot evade the conservative instance support cap',async t=>{
  const f=await fixture(t,'quiet',{enabled:true});
  for(let i=0;i<20;i++)assert.equal((await f.request({message:'Hi'},{forwardedFor:`192.0.2.${i+1}`})).status,200);
  const limited=await f.request({message:'Track order',orderNumber:'#1001',email:'packsmart-buyer@example.test'},{forwardedFor:'192.0.2.99'});
  assert.equal(limited.status,429);assert.deepEqual(f.reads,[]);
});
