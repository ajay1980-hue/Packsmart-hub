import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createPacksmartServer} from '../server.mjs';
import {seedWorkspaceState} from '../lib/store.mjs';
import {newCreativeRequest} from '../lib/creative-safety.mjs';
import {createSessionToken,verifySessionToken} from '../lib/security.mjs';
import {fakeSupabase} from './fake-supabase.mjs';
const secret='creative-api-synthetic-secret-at-least-32-characters';
const budget={limitMicros:'1000',reservedMicros:'0',heldMicros:'0',spentMicros:'0',releasedMicros:'0',uncertainMicros:'0',overrunMicros:'0',availableMicros:'1000',overrunBlocked:false};
async function harness(t,extra={}){
 const s=seedWorkspaceState({}, {workspaceId:'alpha',email:'owner@alpha.test',passwordHash:'synthetic'});s._revision=randomUUID();s.users[0].passwordChangeRequired=false;
 s.users.push({...s.users[0],id:'admin',email:'admin@alpha.test',role:'admin'},{...s.users[0],id:'viewer',email:'viewer@alpha.test',role:'viewer'});
 const other=seedWorkspaceState({}, {workspaceId:'beta',email:'owner@beta.test',passwordHash:'synthetic'});other._revision=randomUUID();other.users[0].passwordChangeRequired=false;
 const campaign={id:'campaign',status:'draft',product:{image:'https://cdn.shopify.com/synthetic.png',title:'Exact test'},copy:{headline:'Test'},creativeRequests:[]};
 const creative=newCreativeRequest({workspaceId:'alpha',campaignId:'campaign',provider:'runway',kind:'product_video',formats:[]});campaign.creativeRequests.push(creative);s.marketing.campaigns=[campaign];
 const fake=fakeSupabase({initialStates:[s,other]}),calls=[],writes=[];let allowance=null,failure=false,providerCalls=0;
 const env={NODE_ENV:'test',CREDENTIALS_KEY:secret,SESSION_SECRET:secret,SUPABASE_URL:'https://creative-api.supabase.test',SUPABASE_SERVICE_ROLE_KEY:'synthetic-only',SHOPIFY_PUBLIC_SYNC_ENABLED:'false',RUNVARA_CREATIVE_ALLOWANCES:'enabled/v1',MARKETING_ENV_WORKSPACE_ID:'alpha',RUNWAY_API_KEY:'synthetic-provider-key',...extra};
 const transport=async(url,options={})=>{
  assert.ok(String(url).startsWith(env.SUPABASE_URL+'/rest/v1/'));const endpoint=new URL(url).pathname.split('/').pop(),body=options.body?JSON.parse(options.body):null;
  if(endpoint.startsWith('runvara_creative_')){
   const name=endpoint.slice('runvara_creative_'.length);calls.push({name,body});assert.equal(options.method,'POST');
   if(failure)throw Error('Simulated lost acknowledgement');
   if(name==='review')return Response.json(allowance?[allowance]:[]);
   if(name==='prepare'){const b=body.p_binding;allowance={id:'creative-approval',approvalType:'creative_phase/v1',workspaceId:b.workspaceId,campaignId:b.campaignId,requestId:b.requestId,provider:b.provider,phase:b.phase,inputDigest:b.inputDigest,accountBinding:b.accountBinding,contractId:b.contractId,sourcePreview:b.sourcePreview,payloadPreview:b.payloadPreview,status:'pending',revision:1,maxCostMicros:600,currency:'USD',expiresAt:new Date(Date.now()+60000).toISOString(),policyRevision:'policy',priceRevision:'price',providerAccountId:'canonical-account',reservationStatus:null,accountingStatus:null,accountedCostMicros:null,heldCostMicros:'0',tenantBudget:budget,accountBudget:budget,upstreamId:null};return Response.json(allowance);}
   if(name==='decide'){assert.equal(body.p_approval_id,allowance.id);allowance={...allowance,status:body.p_decision,revision:2};return Response.json(allowance);}
   throw Error('Unexpected RPC '+name);
  }
  if(!['GET','HEAD'].includes(options.method||'GET'))writes.push({endpoint,body});return fake.fetchImpl(url,options);
 };
 const server=createPacksmartServer(env,{fetchImpl:transport,schedulerEnabled:false,agentOpsEnabled:false});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 const original=globalThis.fetch;globalThis.fetch=async(url,options)=>{if(String(url).startsWith(base+'/'))return original(url,options);providerCalls++;throw Error('Provider network forbidden');};
 t.after(async()=>{globalThis.fetch=original;await server.packsmart.drain();await new Promise(r=>server.close(r));});
 const identity=(state,user=state.users[0])=>{const token=createSessionToken({workspaceId:state.workspace.id,userId:user.id,email:user.email,role:user.role,sessionVersion:user.sessionVersion||1},secret);return{token,csrf:verifySessionToken(token,secret).csrf};};
 const ids={owner:identity(s),admin:identity(s,s.users[1]),viewer:identity(s,s.users[2]),other:identity(other)};
 const request=async(route,{method='GET',body,who=ids.owner,csrf=true}={})=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(who?{Cookie:'packsmart_session='+who.token}:{}),...(who&&csrf?{'X-CSRF-Token':who.csrf}:{})},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,body:await response.json()};};
 return{request,ids,fake,calls,writes,state:s,route:'/api/marketing/campaigns/campaign/creatives/'+creative.id+'/allowance',fail:()=>{failure=true;},get providerCalls(){return providerCalls;}};
}
test('API requires current owner, tenant membership and CSRF; no permission can come from browser body',async t=>{
 const h=await harness(t);assert.equal((await h.request(h.route,{who:null})).status,401);
 for(const role of ['admin','viewer'])assert.equal((await h.request(h.route,{who:h.ids[role]})).status,403);
 assert.equal((await h.request(h.route,{who:h.ids.other})).status,404);
 assert.equal((await h.request(h.route,{method:'POST',body:{operationId:randomUUID()},csrf:false})).status,403);
 for(const body of [{operationId:randomUUID(),maxCostMicros:0},{approval:{approved:true}},{operationId:randomUUID(),account:'forged'}])assert.equal((await h.request(h.route,{method:'POST',body})).status,400);
 assert.equal(h.calls.length,0);assert.equal(h.providerCalls,0);assert.equal(h.writes.length,0);
});
test('API prepares and decides exact phase through protected RPC without workspace/business/provider writes',async t=>{
 const h=await harness(t);assert.deepEqual((await h.request(h.route)).body.allowance,[]);
 const prepared=await h.request(h.route,{method:'POST',body:{operationId:randomUUID()}});assert.equal(prepared.status,200);assert.equal(prepared.body.allowance.approvalType,'creative_phase/v1');assert.equal(h.calls.at(-1).body.p_workspace_id,'alpha');
 const decision='/api/marketing/creative-allowances/'+prepared.body.allowance.id+'/decision';
 assert.equal((await h.request(decision,{method:'POST',body:{revision:1,decision:'approved',expiresAt:'2099-01-01'}})).status,400);
 assert.equal((await h.request(decision,{method:'POST',body:{revision:1,decision:'approved'}})).status,200);
 assert.deepEqual(h.calls.map(c=>c.name),['review','prepare','decide']);assert.equal(h.providerCalls,0);assert.equal(h.writes.length,0);
});
test('API lost preparation acknowledgement is explicit and never retries mutation',async t=>{
 const h=await harness(t);h.fail();const r=await h.request(h.route,{method:'POST',body:{operationId:randomUUID()}});assert.notEqual(r.status,200);assert.match(r.body.code,/CREATIVE_ALLOWANCE_OUTCOME_UNKNOWN/);assert.equal(h.calls.length,1);assert.equal(h.providerCalls,0);assert.equal(h.writes.length,0);
});
test('revoked session or changed owner role cannot read or approve creative authority',async t=>{
 const h=await harness(t);const state=h.fake.states.get('alpha');state.users[0].role='viewer';assert.equal((await h.request(h.route)).status,403);state.users[0].role='owner';state.users[0].sessionVersion=2;assert.equal((await h.request(h.route)).status,401);assert.equal(h.calls.length,0);
});
test('quiet startup blocks creative allowance read/prepare/decision even with capability configured',async t=>{
 const h=await harness(t,{RUNVARA_STARTUP_MODE:'quiet'});for(const [route,method,body] of [[h.route,'GET',undefined],[h.route,'POST',{operationId:randomUUID()}],['/api/marketing/creative-allowances/test/decision','POST',{revision:1,decision:'approved'}]])assert.equal((await h.request(route,{method,body})).status,503);assert.equal(h.calls.length,0);assert.equal(h.writes.length,0);assert.equal(h.providerCalls,0);
});
test('disabled generation capability cannot prepare or decide authority',async t=>{
 const h=await harness(t,{RUNVARA_CREATIVE_ALLOWANCES:'disabled/v1'});assert.equal((await h.request(h.route)).body.code,'CREATIVE_ALLOWANCES_DISABLED');assert.equal(h.calls.length,0);
});
