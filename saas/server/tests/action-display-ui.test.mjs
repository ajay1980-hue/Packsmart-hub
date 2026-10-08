import test from 'node:test';
import assert from 'node:assert/strict';
import { publicConnectionWrite, publicApproval } from '../lib/action-display.mjs';
import { objectiveContentHarness, until, pause } from './objective-content-ui-fixture.mjs';
import { objectiveContentFixture } from './objective-content-fixture.mjs';

const canary = 'PRIVATE_SOURCE_UI_CANARY_8372';
const exactTitle = 'Exact café title <img src=x onerror="window.injected=true">';
const exactDescription = 'Exact description\nSecond line · 日本語';
function records(h, { description = exactDescription, status = 'pending_approval' } = {}) {
  const write = {
    id:'write_public_review',requestId:'public-review-request-001',provider:'shopify',
    input:{operation:'product_content',productId:h.context.product.id,title:exactTitle,description,futurePrivate:canary},
    digest:'a'.repeat(64),connectionId:h.context.target.connectionId,account:h.context.target.account,
    requestedBy:h.state.users[0].id,requiresApproval:true,approvalId:'approval_public_review',status,
    createdAt:'2026-10-08T00:00:00.000Z',result:{externalId:h.context.product.id,privateResult:canary},
    objectivePolicyProposal:{schema:'runvara-objective-dispatch-proposal/v2',origin:'owner_objective_content',provider:'shopify',operation:'product_content',
      source:{...h.context.source,futurePrivate:canary},policies:[{futurePrivate:canary}],privateEnvelope:canary},
    source:{futurePrivate:canary},dispatchClaim:{futurePrivate:canary},providerState:{futurePrivate:canary},
    recordedActionContext:{futurePrivate:canary},futurePrivate:canary
  };
  const approval = {id:write.approvalId,type:'customer_facing_publish',action:'Review exact owner content',
    reason:'Ordinary narrative for '+h.context.source.reportId,financialImpact:0,expectedBenefit:'Owner-reviewed wording',risk:'Customer-facing edit',
    requestedBy:write.requestedBy,source:'Owner',revision:1,status:'pending',createdAt:write.createdAt,executedExternally:false,
    payload:{connectionWriteId:write.id,opportunityId:h.context.source.opportunityId,source:{futurePrivate:canary},futurePrivate:canary},
    evidence:[{type:'objective_review',id:h.context.source.reportId,detail:'Ordinary reviewed evidence',futurePrivate:canary}],
    history:[{revision:1,status:'pending',actor:write.requestedBy,at:write.createdAt,note:'Ordinary history note',futurePrivate:canary,
      evidence:[{type:'product',id:write.input.productId,detail:'Ordinary historical evidence',futurePrivate:canary}]}],futurePrivate:canary};
  return {write,approval};
}
async function renderRecords(h, write, approval) {
  h.bootstrap.connectionWrites=[write];h.bootstrap.approvals=[approval];
  await h.login();h.controls.setView('approvals');
  return h.el('approval-list');
}
function openHistory(h, provider='shopify') {
  h.controls.setView('channels');h.w.RunvaraConnections.open(provider);
  return [...h.d.querySelectorAll('.connection-write')];
}
function assertPrivateAbsent(value) {
  const text=typeof value==='string'?value:JSON.stringify(value);
  assert.equal(text.includes(canary),false);
  for(const key of ['actorSessionVersion','inputFingerprint','objectiveDigest','jobIdentityDigest','payloadDigest','resultDigest','opportunityDigest','productDigest','approvalSourceDigest','objectivePolicyProposal','dispatchClaim','recordedActionContext']) assert.equal(text.includes(key),false,key);
}

for(const role of ['owner','admin','member','viewer']) test(role+' renders actual public DTO in approval cards and connection history with unchanged controls',async t=>{
  const h=await objectiveContentHarness(t,{role}),raw=records(h),before=JSON.stringify(raw);
  const write=publicConnectionWrite(raw.write),approval=publicApproval(raw.approval);
  assertPrivateAbsent({write,approval});assert.equal(JSON.stringify(raw),before);
  assert.equal(write.sourceDisplay.schema,'runvara-objective-content-display/v1');
  const card=await renderRecords(h,write,approval),text=card.textContent;
  for(const value of [h.context.source.objectiveId,h.context.source.reportId,h.context.source.jobId,h.context.source.opportunityId,
    exactTitle,exactDescription,write.account,write.connectionId,'Ordinary narrative','Ordinary reviewed evidence','Ordinary history note']) assert.ok(text.includes(value),value);
  assert.match(text,/Commercial readiness and objective progress remain unverified/);
  assert.match(text,/Server-recorded history is not independently immutable proof/);
  assert.match(text,/Applying the approved change is separate/);
  assert.equal(card.querySelectorAll('[data-decision]').length,role==='owner'?2:0);
  assert.equal(card.querySelector('img,script'),null);assertPrivateAbsent(card.innerHTML);
  const history=openHistory(h)[0];assert.ok(history);
  for(const value of [h.context.source.objectiveId,h.context.source.reportId,h.context.source.jobId,h.context.source.opportunityId,exactTitle,exactDescription]) assert.ok(history.textContent.includes(value),value);
  assert.match(history.textContent,/Current manual-action outcome linking does not support this origin/);
  assert.equal(history.querySelector('[data-connection-action="execute"]'),null);
  assertPrivateAbsent(history.innerHTML);assert.equal(h.w.injected,undefined);
  assert.equal(h.calls.some(call=>call.route.includes('/decision')||call.route.endsWith('/execute')),false);
});

for(const mode of ['source missing','source malformed','origin unknown','display missing ref','display wrong schema','display extra field','display null']) test(mode+' stays recognizably unavailable in both actual DOM consumers',async t=>{
  const h=await objectiveContentHarness(t),raw=records(h,{description:''});
  if(mode==='source missing')delete raw.write.objectivePolicyProposal.source;
  if(mode==='source malformed')raw.write.objectivePolicyProposal.source.objectiveRevision={futurePrivate:canary};
  if(mode==='origin unknown')raw.write.objectivePolicyProposal={schema:'future-proposal/v3',origin:'future_origin',futurePrivate:canary};
  const write=publicConnectionWrite(raw.write),approval=publicApproval(raw.approval);
  if(mode==='display missing ref')delete write.sourceDisplay.reportId;
  if(mode==='display wrong schema')write.sourceDisplay.schema='runvara-objective-content-source/v1';
  if(mode==='display extra field')write.sourceDisplay.futurePrivate=canary;
  if(mode==='display null')write.sourceDisplay=null;
  const card=await renderRecords(h,write,approval);
  assert.match(card.textContent,/source unavailable/i);assert.match(card.textContent,/must not be treated as a manual content request/);
  assert.ok(card.textContent.includes(exactTitle));assert.match(card.textContent,/Empty description: this clears the Shopify description/);
  assertPrivateAbsent(card.innerHTML);
  const history=openHistory(h)[0];assert.match(history.textContent,/Saved source unavailable/);assert.match(history.textContent,/must not be treated as a manual content request/);assert.match(history.textContent,/empty proposed description clears the Shopify description/);assert.match(history.textContent,/Exact approval and separate Apply are still required/);assertPrivateAbsent(history.innerHTML);
  assert.equal(h.calls.some(call=>call.route.includes('/decision')||call.route.endsWith('/execute')),false);
});

test('generic display never substitutes an old full source and legacy manual records make no objective claim',async t=>{
  const h=await objectiveContentHarness(t),raw=records(h),write=publicConnectionWrite(raw.write);
  delete write.sourceDisplay;
  Object.defineProperty(write,'objectivePolicyProposal',{get:()=>{throw new Error('Old proposal fallback must never be read');}});
  // Test the shared actual consumer directly without JSON serializing the trap.
  assert.equal(h.w.RunvaraConnections.objectiveContentDisplay(write),null);
  delete raw.write.objectivePolicyProposal;delete raw.write.source;
  const manual=publicConnectionWrite(raw.write),approval=publicApproval(raw.approval);
  assert.equal(Object.hasOwn(manual,'sourceDisplay'),false);
  const card=await renderRecords(h,manual,approval);assert.equal(card.textContent.includes('Review full goal-associated content'),false);
  const history=openHistory(h)[0];assert.ok(history.textContent.includes(exactTitle));assert.equal(history.textContent.includes('Goal-associated'),false);
});

const operationInputs = [
  ['shopify',{operation:'product_content',productId:'gid://shopify/Product/10',title:'Exact content',description:''}],
  ['shopify',{operation:'internal_note',productId:'gid://shopify/Product/10',note:'Exact private business note'}],
  ...['product_tags_add','product_tags_remove'].map(operation=>['shopify',{operation,productId:'gid://shopify/Product/10',tags:['tag-a','tag-b'],expectedTags:['original']}]),
  ['meta',{operation:'catalog_product_create',catalogId:'catalog-1',name:'Exact product',description:'Exact description',retailerId:'sku-1',brand:'Brand',category:'Category',url:'https://example.test/product',imageUrl:'https://example.test/image.jpg',priceMinor:599,currency:'GBP',availability:'out of stock',condition:'new',visibility:'staging'}],
  ['meta',{operation:'catalog_product_update',catalogId:'catalog-1',productId:'meta-product',name:'Exact updated product',description:'Exact updated description'}],
  ['meta',{operation:'catalog_visibility',catalogId:'catalog-1',productId:'meta-product',visibility:'published'}],
  ['meta',{operation:'catalog_inventory',catalogId:'catalog-1',productId:'meta-product',quantity:0,availability:'out of stock'}],
  ['meta',{operation:'facebook_publish',pageId:'page-1',message:'Exact Facebook message',link:'https://example.test/link'}],
  ['meta',{operation:'facebook_update',pageId:'page-1',postId:'post-1',message:'Exact revised Facebook message'}],
  ['meta',{operation:'instagram_publish',pageId:'page-1',instagramId:'instagram-1',caption:'Exact Instagram caption',imageUrl:'https://example.test/image.jpg'}]
];
for(const role of ['owner','admin','member','viewer']) test(role+' reviews every supported Shopify and Meta DTO operation without changing apply authority',async t=>{
  const h=await objectiveContentHarness(t,{role});
  h.bootstrap.connectionWrites=operationInputs.map(([provider,input],index)=>publicConnectionWrite({id:'write_operation_'+index,provider,input:{...input,futurePrivate:canary},status:'ready',requiresApproval:true,approvalId:'approval_operation_'+index,providerState:{futurePrivate:canary}}));
  await h.login();
  for(const provider of ['shopify','meta']) {
    const cards=openHistory(h,provider),inputs=operationInputs.filter(row=>row[0]===provider).map(row=>row[1]);assert.equal(cards.length,inputs.length);
    cards.forEach((card,index)=>{for(const value of Object.values(inputs[index]))assert.ok(card.textContent.includes(String(value)),`${provider}: ${value}`);assert.equal(card.querySelectorAll('[data-connection-action="execute"]').length,role==='owner'?1:0);assertPrivateAbsent(card.innerHTML);});
    h.el('connection-close').click();
  }
  assert.equal(h.calls.some(call=>call.route.endsWith('/execute')),false);
});

test('malformed projected operation, status and scalar fields render safely with no dangling apply control',async t=>{
  const h=await objectiveContentHarness(t);
  const inputs=[{operation:'future_operation',futurePrivate:canary},{operation:'product_content',productId:'gid://shopify/Product/10',title:{futurePrivate:canary},description:''},{operation:'product_tags_add',productId:'gid://shopify/Product/10',tags:[{futurePrivate:canary}]}];
  h.bootstrap.connectionWrites=inputs.map((input,index)=>publicConnectionWrite({id:'write_unsupported_'+index,provider:'shopify',status:index===0?{futurePrivate:canary}:'ready',input}));
  await h.login();const cards=openHistory(h);assert.equal(cards.length,3);
  for(const card of cards){assert.match(card.textContent,/Change review unavailable/);assert.equal(card.querySelector('[data-connection-action="execute"]'),null);assertPrivateAbsent(card.innerHTML);assert.equal(card.textContent.includes('[object Object]'),false);}
  assert.match(cards[0].textContent,/Unsupported change.*Status unavailable/);
});

test('owner real preparation and bootstrap display handoff keep decision and attempted apply explicit and separate',async t=>{
  const h=await objectiveContentHarness(t,{realBackend:true});await h.open();h.fill();h.change('description','');h.change('ack',true);h.submit();await until(()=>h.writes().length===1);await h.idle();
  const snapshotBefore=await h.server.packsmart.store.get(h.state.workspace.id),write=snapshotBefore.connectionWrites[0],approval=snapshotBefore.approvals[0];
  let projectedBootstrap;
  h.bootstrapRead=async(route,options)=>{const response=await h.realRequest(route,options);projectedBootstrap=await response.clone().json();return response;};
  h.elc('approvals').click();await until(()=>h.el('approval-list').textContent.includes('Review full goal-associated content'));
  assertPrivateAbsent({write:projectedBootstrap.connectionWrites[0],approval:projectedBootstrap.approvals[0]});
  assert.equal(projectedBootstrap.connectionWrites[0].sourceDisplay.reportId,h.context.source.reportId);
  assert.match(h.el('approval-list').textContent,/Empty description: this clears the Shopify description/);
  assert.equal((await h.server.packsmart.store.get(h.state.workspace.id)).approvals[0].status,'pending');
  const decisionRoute='/api/approvals/'+approval.id+'/decision';h.explicitRoutes.set(decisionRoute,h.realRequest);
  h.d.querySelector('[data-approval="'+approval.id+'"][data-decision="approved"]').click();
  await until(()=>h.el('global-success').textContent.includes('Approved. Review and apply the exact change'),()=>h.el('global-error').textContent);
  const approved=await h.server.packsmart.store.get(h.state.workspace.id);assert.equal(approved.approvals[0].status,'approved');assert.equal(approved.connectionWrites[0].status,'ready');assert.equal(approved.connectionWrites[0].dispatchClaim,undefined);
  assert.ok(approved.connectionWrites[0].objectivePolicyProposal.source.actorSessionVersion);assert.ok(approved.approvals[0].payload.objectivePolicyProposalDigest);
  assert.equal(h.calls.filter(call=>call.route.endsWith('/execute')).length,0);
  const card=openHistory(h)[0];assert.ok(card.textContent.includes(h.context.source.reportId));assert.match(card.textContent,/empty proposed description clears the Shopify description/);
  let applyResult;const executeRoute='/api/connection-writes/'+write.id+'/execute';h.explicitRoutes.set(executeRoute,async(route,options)=>{const response=await h.realRequest(route,options);applyResult=await response.clone().json();return response;});
  card.querySelector('[data-connection-action="execute"]').click();await until(()=>h.el('connection-feedback').textContent.length>0);await pause();
  assert.equal(h.calls.filter(call=>call.route===decisionRoute).length,1);assert.equal(h.calls.filter(call=>call.route===executeRoute).length,1);
  assert.equal(applyResult.code,'WRITE_DURABLE_STORE_REQUIRED');assert.match(h.el('connection-feedback').textContent,/authority changed/);
  const after=await h.server.packsmart.store.get(h.state.workspace.id);assert.equal(after.connectionWrites[0].status,'ready');assert.equal(after.connectionWrites[0].dispatchClaim,undefined);
  assert.deepEqual(after.connectionWrites[0].objectivePolicyProposal,approved.connectionWrites[0].objectivePolicyProposal);
});

test('owner explicit Apply consumes the actual synthetic dispatcher completion DTO and retains the confirmed result',async t=>{
  const h=await objectiveContentHarness(t),f=await objectiveContentFixture();
  h.bootstrap.connectionWrites=[publicConnectionWrite(f.write)];h.bootstrap.approvals=f.state.approvals.map(publicApproval);
  h.bootstrapRead=async()=>Response.json({...h.bootstrap,connectionWrites:[publicConnectionWrite(f.write)],approvals:f.state.approvals.map(publicApproval)});
  h.explicitRoutes.set('/api/connection-centre',async()=>Response.json({channels:h.bootstrap.connectionCentre,writes:[publicConnectionWrite(f.write)],autopilotEnabled:false}));
  const route='/api/connection-writes/'+f.write.id+'/execute';let returned;
  h.explicitRoutes.set(route,async()=>{const completed=await f.run();returned={write:publicConnectionWrite(completed),executedExternally:completed.status==='completed'};return Response.json(returned);});
  await h.login();const card=openHistory(h)[0];assert.equal(f.counts.mutations,0);assert.ok(card.textContent.includes(f.context.source.reportId));
  card.querySelector('[data-connection-action="execute"]').click();
  await until(()=>h.el('global-success').textContent.includes('Shopify confirmed the change'),()=>h.el('global-error').textContent);
  assert.equal(h.calls.filter(call=>call.route===route).length,1);assert.equal(f.counts.mutations,1);assertPrivateAbsent(returned);
  assert.equal(returned.write.status,'completed');assert.equal(returned.write.result.externalId,f.write.input.productId);
  const after=openHistory(h)[0];assert.match(after.textContent,/Confirmed channel reference/);assert.equal(after.querySelector('[data-connection-action="execute"]'),null);
  assert.ok(f.write.objectivePolicyProposal.source.actorSessionVersion);assert.ok(f.write.dispatchClaim);assert.equal(f.write.status,'completed');
  assert.equal(h.calls.some(call=>call.route.includes('/decision')),false);
});
