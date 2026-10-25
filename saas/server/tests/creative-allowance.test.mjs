import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {creativeBinding,creativeRpcParams,creativeRpcResult,createCreativeIssuer} from '../lib/creative-allowance.mjs';
import {createCreativeLifecycle,creativeDigest,newCreativeRequest} from '../lib/creative-safety.mjs';
import {advanceCampaignCreatives} from '../lib/marketing-providers.mjs';
import {createStore} from '../lib/store.mjs';

const ENV={RUNVARA_CREATIVE_ALLOWANCES:'enabled/v1',RUNWAY_API_KEY:'synthetic-only-key',CANVA_ACCESS_TOKEN:'synthetic-only-token',CANVA_BRAND_TEMPLATE_ID:'synthetic-template'};
const auth={user:{id:'owner',role:'owner'},session:{sub:'owner',workspaceId:'alpha',sessionVersion:1}};
const failCode=code=>Object.assign(Error(code),{code});
function fixture(provider='runway',phase='generation'){
 const state={workspace:{id:'alpha'},_revision:'rev-1',marketing:{campaigns:[]}};
 const campaign={id:'campaign',status:'draft',product:{image:'https://cdn.shopify.com/synthetic.png',title:'Synthetic',sku:'ABC',price:10},copy:{headline:'Original'},creativeRequests:[]};
 const request=newCreativeRequest({workspaceId:'alpha',campaignId:campaign.id,provider,kind:'synthetic',formats:[]});
 if(phase==='autofill')Object.assign(request,{stage:'autofill_ready',assetId:'asset-1'});
 if(phase==='export')Object.assign(request,{stage:'export_ready',designId:'design-1'});
 campaign.creativeRequests.push(request);state.marketing.campaigns.push(campaign);
 return{state,campaign,request,phase};
}
function runtime(f,{onRpc,saveFault,providerFault,afterConfirm}={}){
 const calls=[],posts=[],reads=[];let saved=structuredClone(f.state),revision=1,held=null,claimed=false,step=0;
 const store={provider:'supabase',async creativeAllowanceRpc(name,workspaceId,input){
  const params=creativeRpcParams(name,workspaceId,input);calls.push({name,params});await onRpc?.(name,input);
  if(name==='prepare')return {prepared:true,binding:input.binding};
  if(name==='reserve'){
   if(held)return{allowed:false,reason:'CREATIVE_SUBMISSION_ALREADY_CLAIMED'};
   held={allowed:true,...Object.fromEntries(['workspaceId','campaignId','requestId','provider','phase','inputDigest'].map(k=>[k,input.binding[k]])),approvalId:'approval',approvalRevision:2,reservationId:'reservation',policyRevision:'policy',currency:'USD',maxCostMicros:600,verifiedUpperBound:true,expiresAt:new Date(Date.now()+60000).toISOString()};
   return creativeRpcResult(name,held,params);
  }
  if(name==='confirm'){assert.equal(claimed,false);assert.ok(saved.marketing.campaigns[0].creativeRequests[0].safety.phases[f.phase]);claimed=true;await afterConfirm?.();return creativeRpcResult(name,{ok:true,reservationId:'reservation',status:'dispatching'},params);}
  return creativeRpcResult(name,{ok:true,reservationId:'reservation',status:input.outcome},params);
 }};
 const persist=async()=>{step++;await saveFault?.(step,'before');f.state._revision='rev-'+(++revision);saved=structuredClone(f.state);await saveFault?.(step,'after');return structuredClone(saved);};
 const fetchImpl=async(url,options={})=>{
  const method=options.method||'GET';
  if(method==='POST'){assert.equal(claimed,true,'protected admission precedes every provider POST');assert.equal(options.redirect,'error');posts.push({url,body:options.body});await providerFault?.();return Response.json(f.request.provider==='runway'?{id:'known-task'}:{job:{id:'known-job'}});}
  reads.push(String(url));
  if(String(url).startsWith('https://cdn.shopify.com/'))return new Response(Buffer.from('synthetic image'),{headers:{'Content-Type':'image/png'}});
  if(String(url).endsWith('/dataset'))return Response.json({dataset:{title:{type:'text'},product_image:{type:'image'}}});
  if(String(url).includes('/tasks/'))return Response.json({status:'SUCCEEDED',output:['https://example.test/output.mp4']});
  throw Error('Unexpected mock GET '+url);
 };
 const run=async({prepared=null}={})=>advanceCampaignCreatives(f.campaign,ENV,{state:f.state,persist,durableStore:true,authorizePhase:createCreativeIssuer({store,state:f.state,env:ENV,auth,operationId:randomUUID(),prepared}),fetchImpl});
 return {store,run,calls,posts,reads,persist,get saved(){return structuredClone(saved);},get held(){return held;}};
}

test('issuer is absent unless explicitly enabled with protected persistence',()=>{
 for(const env of [{},{RUNVARA_CREATIVE_ALLOWANCES:'true'},{RUNVARA_CREATIVE_ALLOWANCES:'enabled'}])assert.equal(createCreativeIssuer({store:{provider:'supabase',creativeAllowanceRpc(){}},state:{workspace:{id:'alpha'}},env}),undefined);
 assert.equal(createCreativeIssuer({store:{provider:'file'},state:{workspace:{id:'alpha'}},env:ENV}),undefined);
});
for(const [provider,phase] of [['canva','asset_upload'],['canva','autofill'],['canva','export'],['runway','generation']]){
 test(`${provider}/${phase}: exact preview preparation never sends a provider POST or saves a claim`,async()=>{const f=fixture(provider,phase),r=runtime(f),prepared=[];await r.run({prepared});assert.equal(prepared.length,1);assert.equal(r.posts.length,0);assert.equal(r.calls.length,1);assert.equal(r.calls[0].name,'prepare');assert.equal(r.calls[0].params.p_binding.phase,phase);assert.equal(r.saved._revision,'rev-1');assert.ok(!JSON.stringify(prepared).includes('synthetic-only-key'));});
 test(`${provider}/${phase}: shared issuer reserves, durably claims, confirms then dispatches once`,async()=>{const f=fixture(provider,phase),r=runtime(f);await r.run();assert.equal(r.posts.length,1);assert.deepEqual(r.calls.map(c=>c.name),['reserve','confirm','observe']);assert.equal(r.calls[0].params.p_binding.phase,phase);assert.equal(creativeDigest(r.calls[0].params.p_binding.payloadPreview),r.calls[0].params.p_binding.payloadDigest);assert.equal(f.request.safety.phases[phase].status,'accepted');});
}
for(const [step,when] of [[1,'before'],[1,'after']])test(`claim persistence interruption ${when} commit never reaches provider`,async()=>{const f=fixture(),r=runtime(f,{saveFault:(n,w)=>{if(n===step&&w===when)throw failCode('SYNTHETIC_LOST_ACK');}});await assert.rejects(r.run(),{code:'SYNTHETIC_LOST_ACK'});assert.equal(r.posts.length,0);assert.equal(r.calls.filter(x=>x.name==='confirm').length,0);assert.ok(r.held);});
test('lost protected admission acknowledgement retains claim and never sends or retries POST',async()=>{const f=fixture(),r=runtime(f,{onRpc:name=>{if(name==='confirm')throw failCode('CREATIVE_ALLOWANCE_OUTCOME_UNKNOWN');}});await assert.rejects(r.run(),{code:'CREATIVE_ALLOWANCE_OUTCOME_UNKNOWN'});await r.run();assert.equal(r.posts.length,0);assert.equal(r.calls.filter(x=>x.name==='confirm').length,1);assert.equal(r.saved.marketing.campaigns[0].creativeRequests[0].safety.phases.generation.status,'dispatching');});
test('changed source after protected admission prevents POST and retains the hold',async()=>{const f=fixture(),r=runtime(f,{afterConfirm:()=>{f.campaign.copy.headline='Changed';}});const result=await r.run();assert.equal(result.reason,'CREATIVE_INPUT_CHANGED');assert.equal(r.posts.length,0);assert.ok(r.held);});
for (const finalBindingDuration of [5, 10]) test(`expiry during post-admission rebinding (${finalBindingDuration}ms) prevents POST without reopening the claim`, async () => {
 const f = fixture(), start = Date.parse('2026-10-25T12:00:00Z');
 let clock = start, confirmations = 0, bindings = 0, posts = 0, held = false, saved;
 const authorizePhase = async binding => {
  held = true;
  return { allowed: true, ...binding, approvalId: 'approval', approvalRevision: 2, reservationId: 'reservation',
   policyRevision: 'policy', currency: 'USD', maxCostMicros: 600, verifiedUpperBound: true,
   expiresAt: new Date(start + 5).toISOString() };
 };
 authorizePhase.confirmDispatch = async () => { confirmations++; };
 const gate = createCreativeLifecycle({ ...f, durableStore: true, authorizePhase, now: () => clock,
  persist: async () => { f.state._revision += '-saved'; saved = structuredClone(f.state); return structuredClone(saved); } });
 const binding = { payloadDigest: creativeDigest('synthetic payload'), accountBinding: creativeDigest('synthetic account'), sourceDigest: creativeDigest('synthetic source') };
 const action = { phase: 'generation', endpoint: 'https://api.dev.runwayml.com/v1/recipes/product_ad', ...binding,
  checkBinding: () => { if (++bindings === 2) { assert.equal(confirmations, 1); clock += finalBindingDuration; } return binding; },
  submit: async () => { posts++; return { id: 'must-not-dispatch' }; },
  accepted: response => ({ provider: 'runway', status: 'in_progress', stage: 'generation', taskId: response.id }) };
 assert.equal((await gate.mutate(action)).code, 'CREATIVE_ALLOWANCE_EXPIRED');
 assert.equal(posts, 0); assert.equal(gate.summary().submissionAttempts, 0); assert.equal(bindings, 2);
 assert.equal(held, true); assert.equal(saved.marketing.campaigns[0].creativeRequests[0].safety.phases.generation.status, 'dispatching');
 assert.equal((await gate.mutate(action)).code, 'CREATIVE_SUBMISSION_ALREADY_CLAIMED');
 assert.equal(confirmations, 1); assert.equal(posts, 0); assert.equal(held, true);
});
test('provider timeout retains uncertain intent and reconstruction never resubmits',async()=>{const f=fixture(),r=runtime(f,{providerFault:()=>{throw Error('lost response');}});await r.run();assert.equal(r.posts.length,1);const saved=r.saved;const next={state:saved,campaign:saved.marketing.campaigns[0],request:saved.marketing.campaigns[0].creativeRequests[0],phase:'generation'},restarted=runtime(next);await restarted.run();assert.equal(restarted.posts.length,0);assert.equal(restarted.calls.length,0);assert.equal(next.request.safety.phases.generation.status,'uncertain');});
test('accepted receipt acknowledgement loss preserves known task and permits observation only',async()=>{const f=fixture(),r=runtime(f,{onRpc:(name,input)=>{if(name==='observe'&&input.outcome==='accepted')throw failCode('CREATIVE_ALLOWANCE_OUTCOME_UNKNOWN');}});await assert.rejects(r.run(),{code:'CREATIVE_ALLOWANCE_OUTCOME_UNKNOWN'});assert.equal(r.saved.marketing.campaigns[0].creativeRequests[0].taskId,'known-task');await r.run();assert.equal(r.posts.length,1);assert.equal(f.request.status,'complete');assert.equal(r.calls.at(-1).params.p_outcome,'completed');});
test('every provider path blocks when trusted reservation refuses generic/publication approval',async()=>{for(const [provider,phase] of [['canva','asset_upload'],['canva','autofill'],['canva','export'],['runway','generation']]){const f=fixture(provider,phase),r=runtime(f,{onRpc:name=>{if(name==='reserve')throw failCode('CREATIVE_ALLOWANCE_PRECONDITION_FAILED');}});f.campaign.publish={status:'approved'};await r.run();assert.equal(r.posts.length,0);assert.equal(f.request.blockReason,'CREATIVE_ALLOWANCE_PRECONDITION_FAILED');}});
test('strict DTO rejects browser prices, role forgery, unsupported operations and fractional settlement',()=>{
 const input={auth,requestId:'request'};assert.throws(()=>creativeRpcParams('review','other',input));assert.throws(()=>creativeRpcParams('review','alpha',{...input,auth:{...auth,user:{id:'owner',role:'admin'}}}));assert.throws(()=>creativeRpcParams('review','alpha',{...input,maxCostMicros:1}));assert.throws(()=>creativeRpcParams('delete','alpha',{}));
 const receipt={type:'provider_bill/v1',id:'receipt',providerAccountId:'account',currency:'USD',costMicros:'9007199254740993',upstreamId:'task',evidenceDigest:'a'.repeat(64)};
 const args={reservationId:'res',inputDigest:'b'.repeat(64),receipt};assert.equal(creativeRpcParams('settle','alpha',args).p_receipt.costMicros,receipt.costMicros);
 for(const cost of [0,0.1,'1.1','-1','1e6','01'])assert.throws(()=>creativeRpcParams('settle','alpha',{...args,receipt:{...receipt,costMicros:cost}}));
});
for(const [label,response] of [
 ['duplicate JSON',()=>new Response('{"allowed":true,"allowed":false,"reason":"CREATIVE_APPROVAL_REQUIRED"}')],
 ['oversized response',()=>new Response(JSON.stringify({allowed:false,reason:'CREATIVE_APPROVAL_REQUIRED',padding:'x'.repeat(270000)}))],
 ['missing response',()=>new Response('',{status:200})],
 ['network lost acknowledgement',()=>{throw Error('synthetic secret never report');}],
 ['database permission',()=>Response.json({code:'42501',message:'synthetic secret never report'},{status:403})]
])test('protected store transport fails closed without retry: '+label,async()=>{
 let attempts=0;const store=createStore({SUPABASE_URL:'https://synthetic.supabase.test',SUPABASE_SERVICE_ROLE_KEY:'synthetic-only'}, {fetchImpl:async()=>{attempts++;return response();}});
 await assert.rejects(store.creativeAllowanceRpc('review','alpha',{auth,requestId:'request'}),e=>{assert.ok(e.code.startsWith('CREATIVE_ALLOWANCE_'));assert.ok(!e.message.includes('secret'));return true;});assert.equal(attempts,1);
});
