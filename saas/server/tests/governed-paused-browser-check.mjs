// Remote Chromium only. Real app, synthetic tenant and real read/reconciliation
// APIs. Tested mutation replies and outcome reads are explicitly mocked. Setup
// creates only synthetic objectives/reviews; tested saves never reach the server.
// No publications, provider calls, model calls, approvals or apply actions occur.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { createPacksmartServer } from '../server.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { GOVERNED_RECORD_PRODUCER_CONTRACT } from '../lib/governed-record-stage.mjs';
import { detectOpportunities } from '../lib/control.mjs';
import { prepareExperimentOutcomeMeasurement, assessExperimentOutcomeMeasurement } from '../lib/experiment-measurements.mjs';
import { objectiveContentState, OBJECTIVE_CONTENT_PRODUCT } from './objective-content-test-fixture.mjs';
import { createRestrictionTypographySession } from './objective-browser-typography.mjs';
import { createOutcomeViewportSession } from './business-outcomes-browser-capture.mjs';

const pausedMessage = 'New governed records are paused on this server. Existing records remain available for review and exact reconciliation.';
const preflightOnly = process.argv.includes('--preflight');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-governed-paused-browser-'));
const base = 'http://127.0.0.1:18880', secret = randomBytes(32).toString('hex');
let browser, providerCalls = 0, modelCalls = 0;
const server = createPacksmartServer({ NODE_ENV:'test', GOVERNED_RECORD_PRODUCER_CONTRACT, APP_PUBLIC_URL:base,
  SESSION_SECRET:secret, CREDENTIALS_KEY:secret, SAAS_STATE_FILE:path.join(directory,'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED:'false' },
  { schedulerEnabled:false, agentOpsEnabled:false, fetchImpl:async()=>{providerCalls++;assert.fail('Provider transport forbidden');} });
server.packsmart.aiProvider.enhanceCommander = async()=>{modelCalls++;assert.fail('Model transport forbidden');};
const captures = [], interactions = [], actionChecks = [];
const writesProjection = state => structuredClone({ objectives:state.businessObjectives, writes:state.connectionWrites,
  approvals:state.approvals, decisions:state.decisions, measurements:state.experimentMeasurements, outcomes:state.businessOutcomes });

async function preflight({state,objective,candidate,token,width}) {
  let csrf;
  const request=async(route,body,expectedStatus=200)=>{
    const response=await fetch(base+route,{method:body?'POST':'GET',headers:{Cookie:`packsmart_session=${token}`,Origin:base,...(body?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const result=await response.json();assert.equal(response.status,expectedStatus,`Preflight ${route}: ${JSON.stringify(result)}`);return result;
  };
  csrf=(await request('/api/auth/session')).csrf;
  const bootstrap=await request('/api/bootstrap');assert.equal(bootstrap.workspace.id,state.workspace.id);assert.ok(bootstrap.products.some(row=>row.id===OBJECTIVE_CONTENT_PRODUCT));
  const centre=await request('/api/connection-centre'),target=centre.channels.find(row=>row.id==='shopify')?.contentPreparation?.target;
  assert.ok(target,'The real manual-content target must be available');assert.equal(target.connectionId,state.connections[0].id);assert.equal(target.account,state.connections[0].metadata.shopDomain);
  const snapshot=await request('/api/business-objectives');assert.ok(snapshot.objectives.some(row=>row.id===objective.id&&row.revision===objective.revision));
  const queued=await request('/api/business-objectives/reviews',{objectiveId:objective.id,objectiveRevision:objective.revision},202);await server.packsmart.agentOps.tick();
  const review=await request(`/api/business-objectives/reviews/${queued.job.id}?report=true`);assert.equal(review.job.status,'succeeded');
  assert.ok(review.report.proposals.some(row=>row.opportunityId===candidate.id),'The real review must retain the exact selected canonical opportunity');
  const source=await request(`/api/objective-content/context?jobId=${queued.job.id}&opportunityId=${candidate.id}`);
  assert.equal(source.source.opportunityId,candidate.id);assert.equal(source.product.id,OBJECTIVE_CONTENT_PRODUCT);assert.deepEqual(source.target,target);
  for(const root of ['/api/objective-content/requests/','/api/connections/shopify/content-requests/']){
    const history=await request(root+`preflight_absent_request_${width}`);assert.equal(history.found,false);assert.equal(history.request,null);assert.equal(history.workspaceId,state.workspace.id);
  }
  console.log(`${width}px HTTP preflight: real bootstrap, manual target, objective/review candidate, source context and both exact history reads match.`);
}

// Modal branch of the existing objective-content consumer viewport geometry.
// Background page chrome is outside the native dialog's visible scrollport.
// Do not scroll the page beneath a modal or hide its actual sticky Close button.
function createModalViewportSession(panel) {
  const view=panel.ownerDocument.defaultView,modal=panel.closest('dialog'),ancestors=[];
  if(!modal)throw new Error('Modal capture requires an actual dialog');
  for(let node=panel.parentElement;node;node=node.parentElement){ancestors.push(node);if(node===modal)break;}
  const chrome=()=>Array.from(modal.querySelectorAll('#connection-close')).filter(node=>{
    const style=view.getComputedStyle(node),rect=node.getBoundingClientRect();return ['sticky','fixed'].includes(style.position)&&rect.width>0&&rect.height>0&&rect.bottom>0&&rect.top<view.innerHeight;
  });
  return {
    async reveal(offset){
      for(const node of ancestors.filter(node=>/^(auto|scroll)$/.test(view.getComputedStyle(node).overflowY)&&node.scrollHeight>node.clientHeight)){
        const clearance=Math.max(12,...chrome().filter(item=>node.contains(item)).map(item=>item.getBoundingClientRect().height+24));
        node.scrollBy({top:panel.getBoundingClientRect().top+offset-node.getBoundingClientRect().top-node.clientTop-clearance,behavior:'instant'});
      }
      await new Promise(resolve=>view.requestAnimationFrame(()=>view.requestAnimationFrame(resolve)));
    },
    bounds(){
      const rect=panel.getBoundingClientRect();let top=0,bottom=view.innerHeight,left=0,right=view.innerWidth;
      for(const node of ancestors){const style=view.getComputedStyle(node),box=node.getBoundingClientRect();
        if(/^(auto|scroll|hidden|clip)$/.test(style.overflowY)){top=Math.max(top,box.top+node.clientTop);bottom=Math.min(bottom,box.top+node.clientTop+node.clientHeight);}
        if(/^(auto|scroll|hidden|clip)$/.test(style.overflowX)){left=Math.max(left,box.left+node.clientLeft);right=Math.min(right,box.left+node.clientLeft+node.clientWidth);}
      }
      for(const node of chrome())top=Math.max(top,node.getBoundingClientRect().bottom+12);
      return {from:Math.max(0,top-rect.top),to:Math.min(rect.height,bottom-rect.top),height:rect.height,left:rect.left,right:rect.right,visibleLeft:left,visibleRight:right,scroll:panel.scrollWidth,client:panel.clientWidth};
    }
  };
}
async function writeManifest(width,{complete=true,failure=null,diagnosticErrors=[]}={}) {
  const images=captures.filter(row=>row.width===width);for(const row of images)row.bytes=(await fs.stat(row.file)).size;
  const manifest={width,complete,transport:'Mocked HTTP 503 + GOVERNED_RECORDS_PAUSED and aborted mutations; real app and content read/reconciliation APIs; mocked outcome reads.',imageCount:images.length,bytes:images.reduce((sum,row)=>sum+row.bytes,0),interactions:interactions.filter(row=>row.width===width),actionChecks:actionChecks.filter(row=>row.width===width),images,...(failure?{failure,diagnosticErrors}:{})};
  await fs.writeFile(`/tmp/runvara-governed-paused-${width}-manifest.json`,JSON.stringify(manifest,null,2));return manifest;
}
async function assertManualContentActions(page,width,state,textScale) {
  const layout=await page.locator('#connection-content-form').evaluate(form=>{
    const view=form.ownerDocument.defaultView,dialog=form.closest('dialog'),row=form.querySelector('.button-row');
    const box=node=>{const rect=node.getBoundingClientRect();return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height};};
    const buttons=Array.from(row.querySelectorAll('button')).filter(node=>node.getBoundingClientRect().height>0).map(node=>{
      const style=view.getComputedStyle(node),words=[],walker=form.ownerDocument.createTreeWalker(node,view.NodeFilter.SHOW_TEXT);
      while(walker.nextNode())for(const match of walker.currentNode.textContent.matchAll(/\S+/g)){
        const range=form.ownerDocument.createRange();range.setStart(walker.currentNode,match.index);range.setEnd(walker.currentNode,match.index+match[0].length);
        words.push({text:match[0],rects:Array.from(range.getClientRects()).filter(rect=>rect.width>0&&rect.height>0).map(rect=>({left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom}))});
      }
      return {id:node.id,...box(node),disabled:node.disabled,tabIndex:node.tabIndex,order:style.order,scroll:node.scrollWidth,client:node.clientWidth,words};
    });
    return {actualViewportWidth:view.innerWidth,viewportHeight:view.innerHeight,row:box(row),buttons,
      dialog:{...box(dialog),scroll:dialog.scrollHeight,client:dialog.clientHeight,overflow:view.getComputedStyle(dialog).overflowY}};
  });
  const label=`${layout.actualViewportWidth}px ${state} ${textScale*100}% text`,expected=state==='content-first-paused'?['content-prepare','content-reload','content-new']:['content-check'];
  assert.deepEqual(layout.buttons.map(button=>button.id),expected,`${label}: recovery actions must match the refusal/unknown state`);
  assert.ok(layout.dialog.top>=0&&layout.dialog.bottom<=layout.viewportHeight&&layout.dialog.height<=layout.viewportHeight-14,`${label}: dialog must stay within the viewport`);
  assert.ok(layout.dialog.scroll>layout.dialog.client&&['auto','scroll'].includes(layout.dialog.overflow),`${label}: long content must scroll inside the dialog`);
  for(const [index,button] of layout.buttons.entries()){
    assert.equal(button.disabled,button.id==='content-prepare',`${label}: refused preparation stays disabled while recovery actions stay enabled`);
    assert.ok(Math.abs(button.left-layout.row.left)<=2&&Math.abs(button.right-layout.row.right)<=2,`${label}: ${button.id} must use the full action row`);
    assert.ok(index===0||button.top>=layout.buttons[index-1].bottom,`${label}: actions must stack in their DOM order`);
    assert.equal(button.order,'0',`${label}: CSS must not reorder actions`);assert.equal(button.tabIndex,0,`${label}: natural tab order must remain`);
    assert.ok(button.height>=44&&button.scroll<=button.client+2,`${label}: ${button.id} must retain a usable, unclipped target`);
    assert.ok(button.words.length>0,`${label}: ${button.id} must have a visible label`);
    for(const word of button.words){
      assert.ok(word.rects.length>0&&word.rects.every(rect=>Math.abs(rect.top-word.rects[0].top)<=1),`${label}: ${button.id} splits the word ${word.text}`);
      assert.ok(word.rects.every(rect=>rect.left>=button.left&&rect.right<=button.right&&rect.top>=button.top&&rect.bottom<=button.bottom),`${label}: ${button.id} clips the word ${word.text}`);
    }
    const target=page.locator(`#${button.id}`),viewport=await target.evaluateHandle(createModalViewportSession),pageScroll=await page.evaluate(()=>window.scrollY);
    try{
      await viewport.evaluate(session=>session.reveal(0));const bounds=await viewport.evaluate(session=>session.bounds());
      assert.ok(bounds.from<=1&&bounds.to>=bounds.height-1&&bounds.left>=bounds.visibleLeft&&bounds.right<=bounds.visibleRight,`${label}: ${button.id} must be fully reachable below Close`);
      assert.equal(await page.evaluate(()=>window.scrollY),pageScroll,`${label}: reaching an action must not scroll the background page`);
      assert.ok(await target.evaluate(node=>{const rect=node.getBoundingClientRect(),hit=node.ownerDocument.elementFromPoint((rect.left+rect.right)/2,(rect.top+rect.bottom)/2);return node===hit||node.contains(hit);}),`${label}: ${button.id} must not be covered`);
      assert.ok(await page.locator('#connection-close').evaluate(node=>{const rect=node.getBoundingClientRect(),hit=node.ownerDocument.elementFromPoint((rect.left+rect.right)/2,(rect.top+rect.bottom)/2);return rect.top>=0&&rect.bottom<=innerHeight&&(node===hit||node.contains(hit));}),`${label}: Close must remain visible and reachable`);
    }finally{await viewport.dispose();}
  }
  const enabled=layout.buttons.filter(button=>!button.disabled);
  assert.ok(enabled.length>0,`${label}: an enabled recovery action must remain`);
  await page.locator(`#${enabled[0].id}`).focus();
  for(const [index,button] of enabled.entries()){
    assert.equal(await page.evaluate(()=>document.activeElement.id),button.id,`${label}: keyboard focus must follow the displayed actions`);
    if(index<enabled.length-1)await page.keyboard.press('Tab');
  }
  actionChecks.push({width,state,textScale,...layout});
}
async function captureFeedback(page,width,name,rootSelector,selectors) {
  const root=page.locator(rootSelector), typography=await root.evaluateHandle(createRestrictionTypographySession),actualViewportWidth=page.viewportSize().width;
  const image=async suffix=>{
    if(rootSelector==='#connection-content-editor'&&actualViewportWidth<=430)await assertManualContentActions(page,width,name,suffix?2:1);
    for(let index=0;index<selectors.length;index++){
      const target=page.locator(selectors[index]);await target.waitFor({state:'visible'});
      const modal=await target.evaluate(node=>Boolean(node.closest('dialog')));
      const viewport=await target.evaluateHandle(modal?createModalViewportSession:createOutcomeViewportSession);let covered=0,part=0;
      try{while(true){
        await viewport.evaluate((session,offset)=>session.reveal(offset),Math.max(0,covered-60));const bounds=await viewport.evaluate(session=>session.bounds());
        assert.ok(bounds.height>0&&bounds.left>=bounds.visibleLeft-2&&bounds.right<=bounds.visibleRight+2&&bounds.scroll<=bounds.client+2,`${name}${suffix} horizontal clipping: ${JSON.stringify(bounds)}`);
        assert.ok(bounds.from<=covered+2&&bounds.to>covered+1,`${name}${suffix} lost visible text: ${JSON.stringify({covered,...bounds})}`);
        const file=`/tmp/runvara-governed-paused-${width}-${name}${actualViewportWidth===width?'':`-viewport-${actualViewportWidth}`}${suffix}-${index+1}-${++part}.png`;
        await page.screenshot({path:file,fullPage:false,caret:'initial'});captures.push({width,actualViewportWidth,state:name,selector:selectors[index],textScale:suffix?2:1,file,bounds,...(actualViewportWidth===width?{}:{probe:'manual-content-layout'})});
        covered=bounds.to;if(covered>=bounds.height-1)break;assert.ok(part<8,'Bounded feedback capture exceeded eight viewport slices');
      }}finally{await viewport.dispose();}
    }
  };
  try{await typography.evaluate(session=>session.assertBaseline());await image('');await typography.evaluate(session=>session.begin());
    try{await typography.evaluate(session=>session.enlarge());await image('-large-text');}finally{await typography.evaluate(session=>session.restore());}
    await typography.evaluate(session=>session.assertBaseline());
  }finally{await typography.dispose();}
}
async function navigate(page,view) {
  const menu=page.locator('#mobile-menu');if(await menu.isVisible()&&await menu.getAttribute('aria-expanded')!=='true')await menu.click();
  await page.locator(`#main-nav [data-view="${view}"]`).click();await page.locator(`#view-${view}.active`).waitFor();
}
async function settleForm(page,selector) {await page.waitForFunction(value=>document.querySelector(value)?.getAttribute('aria-busy')==='false',selector);}
async function openObjectives(page,objective) {
  await navigate(page,'ai-team');await page.locator('.business-objectives-panel > summary').click();await page.locator('#load-business-objectives').click();
  await page.locator(`[data-manage-objective-restriction="${objective.id}"]`).waitFor();
}
async function checkContent(page,width,h,objectiveMode) {
  const prefix=objectiveMode?'objective-content':'content', root=objectiveMode?'#objective-content-editor':'#connection-content-editor';
  const el=name=>page.locator(`#${prefix}-${name}`), status=el('status'), error=el('error');
  const capture=async(state,action)=>{
    const selectors=[`#${prefix}-status`,`#${prefix}-error`,`#${prefix}-${action}`],row='#connection-content-form .button-row';
    if(!objectiveMode&&width<=430)selectors.push(row);
    await captureFeedback(page,width,`${prefix}-${state}`,root,selectors);
    // Reuse the 390px manual state for a 430px layout probe only. Keep all five
    // existing flows and artifact groups; record the actual viewport in each image.
    if(!objectiveMode&&width===390){const viewport=page.viewportSize(),writeCount=h.writes.length;
      try{await page.setViewportSize({...viewport,width:430});await captureFeedback(page,width,`${prefix}-${state}`,root,[row]);}
      finally{await page.setViewportSize(viewport);}
      assert.equal(h.writes.length,writeCount,'The 430px layout probe must not submit or retry a request');
    }
  };
  const open=async()=>{await page.locator('#connection-grid [data-provider="shopify"][data-connection-action="open"]').first().click();await el('title').waitFor();};
  if(objectiveMode){await openObjectives(page,h.objective);await page.locator(`[data-prepare-objective-review="${h.objective.id}"]`).click();await page.locator(`[data-request-objective-content="${h.candidate.id}"]`).click();await settleForm(page,'#objective-content-form');}
  else {await navigate(page,'channels');await open();}
  const fill=async()=>{await el('account').selectOption(h.state.connections[0].id);await el('product').selectOption(OBJECTIVE_CONTENT_PRODUCT);await el('title').fill('Exact synthetic paused content');await el('description').fill('Only these exact retained words.');await el('ack').check();};
  await fill();await el('prepare').click();await status.getByText('Preparation was refused.',{exact:false}).waitFor();assert.equal(await error.textContent(),pausedMessage);assert.equal(h.writes.length,1);assert.equal(await el('check').isVisible(),false);assert.equal(await el('ack').isChecked(),false);
  await capture('first-paused','reload');
  await el('reload').click();await settleForm(page,objectiveMode?'#objective-content-form':'#connection-content-form');assert.equal(h.writes.length,1);await fill();h.mode='lose';await el('prepare').click();await status.getByText('The preparation outcome is unknown.',{exact:false}).waitFor();const original=h.writes[1].body;
  await el('check').click();await status.getByText('No matching request was found',{exact:false}).waitFor();assert.equal(h.writes.length,2);await el('ack').check();h.mode='paused';await el('retry').click();await status.getByText('The preparation outcome is unknown.',{exact:false}).waitFor();
  assert.equal(h.writes.length,3);assert.equal(h.writes[2].body,original);assert.ok((await error.textContent()).includes(pausedMessage));assert.equal(await el('reload').isVisible(),false);assert.equal(await el('retry').isVisible(),false);assert.equal(await el('ack').isChecked(),false);
  await capture('retained-unknown','check');
  if(objectiveMode){await el('cancel').click();await page.locator('#resume-objective-content').click();}else{await page.locator('#connection-close').click();await open();}
  assert.ok((await el('exact').textContent()).includes(JSON.parse(original).requestId));assert.match(await status.textContent(),/outcome is unknown/);assert.equal(h.writes.length,3);
}
async function checkRestriction(page,width,h) {
  await openObjectives(page,h.objective);await page.locator(`[data-manage-objective-restriction="${h.objective.id}"]`).click();
  const error=page.locator('#objective-restriction-error'),ack=page.locator('#objective-restriction-ack'),save=page.locator('#save-objective-restriction');
  const choose=async()=>{await page.locator('#objective-restriction-mode').selectOption('preparation_only');await ack.check();};
  await choose();await save.click();await error.getByText(pausedMessage,{exact:false}).waitFor();assert.equal(h.writes.length,1);assert.equal(await save.isDisabled(),true);assert.equal(await ack.isChecked(),false);assert.doesNotMatch(await error.textContent(),/unknown/);
  await captureFeedback(page,width,'restriction-first-paused','#business-objective-restriction',['#objective-restriction-error','#reload-objective-restriction']);
  await page.locator('#reload-objective-restriction').click();await settleForm(page,'#objective-restriction-form');assert.equal(h.writes.length,1);await choose();h.mode='lose';await save.click();await error.getByText('The restriction save outcome is unknown.',{exact:false}).waitFor();assert.equal(await save.isDisabled(),true);assert.equal(h.writes.length,2);
  await captureFeedback(page,width,'restriction-retained-unknown','#business-objective-restriction',['#objective-restriction-error','#reload-objective-restriction']);
  await page.locator('#cancel-objective-restriction').click();await navigate(page,'overview');await navigate(page,'ai-team');assert.match(await page.locator('#business-objectives-list').textContent(),/save outcome is unknown/);assert.equal(h.writes.length,2);
}
async function openOutcome(page,h) {
  await navigate(page,'revenue-engine');await page.locator('#business-outcomes-panel > summary').click();await page.locator('#business-outcomes-experiment').selectOption(h.experiment.id);await loadOutcome(page);
}
async function loadOutcome(page) {
  await page.locator('#business-outcomes-load').click();await page.locator('#business-outcomes-status').getByText('Experiment loaded.',{exact:false}).waitFor();
}
async function checkMeasurement(page,width,h) {
  await openOutcome(page,h);const status=page.locator('#business-outcomes-status'),save=page.locator('#business-outcomes-form button[type=submit]');
  await save.click();await status.getByText(pausedMessage,{exact:true}).waitFor();assert.equal(h.writes.length,1);assert.equal(await save.isDisabled(),true);
  await captureFeedback(page,width,'measurement-first-paused','#business-outcomes-panel',['#business-outcomes-status','#business-outcomes-load']);
  await loadOutcome(page);h.mode='lose';await save.click();await status.getByText('Save was not confirmed.',{exact:false}).waitFor();assert.equal(h.writes.length,2);assert.equal(await save.isDisabled(),true);
  await captureFeedback(page,width,'measurement-retained-unknown','#business-outcomes-panel',['#business-outcomes-status','#business-outcomes-load']);
  await page.locator('#business-outcomes-panel > summary').click();await page.locator('#business-outcomes-panel > summary').click();assert.equal(await save.isDisabled(),true);assert.equal(h.writes.length,2);
}
async function checkPublication(page,width,h) {
  await openOutcome(page,h);const status=page.locator('#business-outcomes-status'),review=page.locator('#business-outcomes-review');
  const confirm=async()=>{await page.locator('#business-outcomes-attest').check();await page.locator('#business-outcomes-confirm').click();};
  await page.locator('[data-outcome-action="publish"]').click();await confirm();await status.getByText(pausedMessage,{exact:true}).waitFor();assert.equal(await review.isVisible(),false);assert.equal(h.writes.length,1);
  await captureFeedback(page,width,'publication-first-paused','#business-outcomes-panel',['#business-outcomes-status','#business-outcomes-load']);
  await loadOutcome(page);await page.locator('[data-outcome-action="publish"]').click();h.mode='lose';await confirm();await page.locator('#business-outcomes-confirm').getByText('Retry same reviewed action',{exact:true}).waitFor();const original=h.writes[1].body;
  h.mode='paused';await confirm();await status.getByText(pausedMessage,{exact:false}).waitFor();assert.match(await status.textContent(),/Confirmation was not received/);assert.equal(h.writes.length,3);assert.equal(h.writes[2].body,original);assert.equal(await page.locator('#business-outcomes-attest').isChecked(),false);
  await captureFeedback(page,width,'publication-retained-unknown','#business-outcomes-panel',['#business-outcomes-status','#business-outcomes-review .outcome-error','#business-outcomes-confirm']);
  await page.locator('#business-outcomes-load').click();await status.getByText('Finish checking the pending action',{exact:false}).waitFor();await page.locator('#business-outcomes-cancel').click();await page.locator('#business-outcomes-panel > summary').click();await page.locator('#business-outcomes-panel > summary').click();assert.match(await page.locator('#business-outcomes-confirm').textContent(),/Retry same/);assert.equal(h.writes.length,3);
}
try {
  server.listen(18880,'127.0.0.1');await once(server,'listening');if(!preflightOnly)browser=await chromium.launch({headless:true});
  for(const width of [320,390,1200]){
    const {state,objective}=objectiveContentState(`paused-browser-${width}`);state.connections[0].status='connected';
    detectOpportunities(state);for(const row of state.opportunities){row.executionCost=0;row.effortHours=1;}
    const candidate=state.opportunities.find(row=>row.present&&row.evidence.some(item=>item.id===OBJECTIVE_CONTENT_PRODUCT&&item.detail==='Thin product title'));assert.ok(candidate);
    const experiment={id:'paused-browser-experiment',title:'Synthetic paused measurement',status:'measured'};state.revenueEngine.experiments=[experiment];
    await server.packsmart.store.save(state.workspace.id,state);
    const token=createSessionToken({userId:state.users[0].id,workspaceId:state.workspace.id,email:state.users[0].email,role:'owner',sessionVersion:1},secret);
    await preflight({state,objective,candidate,token,width});if(preflightOnly)continue;
    const now='2026-10-06T20:00:00.000Z',measurement=prepareExperimentOutcomeMeasurement({expectedRevision:0,amount:'25',currency:'GBP',window:{startsAt:'2026-10-01T00:00:00.000Z',endsAt:'2026-10-06T00:00:00.000Z'},coverage:{status:'complete',observedCount:3,expectedCount:3},method:{kind:'reconciled_manual'},observedAt:'2026-10-06T12:00:00.000Z',report:{description:'Synthetic retained measurement with complete reported costs.',costsComplete:true}},{workspaceId:state.workspace.id,experimentId:experiment.id,actorId:state.users[0].id,now});
    const detail={workspaceId:state.workspace.id,workspaceRevision:'synthetic-review-revision',experiment,measurement,assessment:assessExperimentOutcomeMeasurement(measurement,{workspaceId:state.workspace.id,experimentId:experiment.id,now}),currentPublication:null};
    for(const [surface,check,writePath] of [
      ['manual-content',(page,h)=>checkContent(page,width,h,false),'/api/connections/shopify/writes'],
      ['objective-content',(page,h)=>checkContent(page,width,h,true),'/api/objective-content/requests'],
      ['restriction',(page,h)=>checkRestriction(page,width,h),'/api/business-objectives'],
      ['measurement',(page,h)=>checkMeasurement(page,width,h),`/api/business-outcomes/experiments/${experiment.id}/measurement`],
      ['publication',(page,h)=>checkPublication(page,width,h),'/api/business-outcomes/publish']]){
      const context=await browser.newContext({viewport:{width,height:900}});await context.addCookies([{name:'packsmart_session',value:token,url:base,httpOnly:true,sameSite:'Strict'}]);
      const page=await context.newPage(),h={state,objective,candidate,experiment,writes:[],mode:'paused'},errors=[],external=[],unexpected=[];
      const before=writesProjection(await server.packsmart.store.get(state.workspace.id));page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/*',async route=>{
        const request=route.request(),url=new URL(request.url()),method=request.method();if(url.origin!==base){external.push(url.href);return route.abort();}
        if(!url.pathname.startsWith('/api/'))return route.continue();
        if(method!=='GET'&&url.pathname===writePath){h.writes.push({path:url.pathname,body:request.postData(),response:h.mode});assert.equal(await request.headerValue('origin'),base);
          if(h.mode==='lose')return route.abort('timedout');return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'GOVERNED_RECORDS_PAUSED',error:pausedMessage})});}
        if(method==='GET'&&url.pathname==='/api/business-outcomes')return route.fulfill({json:{workspaceId:state.workspace.id,current:[],summary:{groups:[],coverage:{complete:true},exclusions:[]}}});
        if(method==='GET'&&url.pathname===`/api/business-outcomes/experiments/${experiment.id}`)return route.fulfill({json:detail});
        if(method==='GET'&&(['/api/auth/session','/api/bootstrap','/api/connection-centre','/api/connections','/api/business-objectives','/api/objective-content/context'].includes(url.pathname)||url.pathname.startsWith('/api/objective-content/requests/')||url.pathname.startsWith('/api/connections/shopify/content-requests/')||url.pathname.startsWith('/api/business-objectives/reviews/')))return route.continue();
        if(surface==='objective-content'&&method==='POST'&&url.pathname==='/api/business-objectives/reviews'){assert.deepEqual(request.postDataJSON(),{objectiveId:objective.id,objectiveRevision:objective.revision});const response=await route.fetch();assert.equal(response.status(),202);await server.packsmart.agentOps.tick();return route.fulfill({response});}
        unexpected.push({path:url.pathname,method});return route.abort();
      });
      let failure;
      try{await page.goto(base);await page.locator('#app-shell:not(.hidden)').waitFor();await check(page,h);
        assert.deepEqual(writesProjection(await server.packsmart.store.get(state.workspace.id)),before,'Mocked refusal/timeout cannot mutate stored governed records');
        assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(unexpected,[]);assert.equal(providerCalls,0);assert.equal(modelCalls,0);
        interactions.push({width,surface,writeCount:h.writes.length,responses:h.writes.map(row=>row.response),storedGovernedRecordsUnchanged:true});
      }catch(error){
        failure=error;const diagnosticErrors=[],file=`/tmp/runvara-governed-paused-${width}-${surface}-failure.png`;
        try{await page.screenshot({path:file,fullPage:false,caret:'initial'});captures.push({width,state:`${surface}-failure`,textScale:'current',file,diagnostic:true});}
        catch(captureError){diagnosticErrors.push(String(captureError.message));}
        try{await writeManifest(width,{complete:false,failure:{surface,message:String(error.message)},diagnosticErrors});}
        catch(manifestError){console.error('Could not save partial browser manifest:',manifestError.message);}
        throw error;
      }finally{try{await context.close();}catch(closeError){if(!failure)throw closeError;console.error('Could not close failed browser context:',closeError.message);}}
    }
    const images=captures.filter(row=>row.width===width);for(const row of images)row.bytes=(await fs.stat(row.file)).size;
    assert.equal(new Set(images.map(row=>row.state)).size,10);assert.ok(images.every(row=>row.textScale===1||row.textScale===2));
    if(width<=430)for(const actualViewportWidth of width===390?[390,430]:[width])for(const state of ['content-first-paused','content-retained-unknown'])for(const textScale of [1,2]){
      assert.equal(actionChecks.filter(row=>row.width===width&&row.actualViewportWidth===actualViewportWidth&&row.state===state&&row.textScale===textScale).length,1,'Each mobile recovery state must pass normal and 200% text action checks');
      assert.ok(images.some(row=>row.actualViewportWidth===actualViewportWidth&&row.state===state&&row.textScale===textScale&&row.selector==='#connection-content-form .button-row'),'Each checked mobile action row must have viewport evidence');
    }
    const bytes=images.reduce((sum,row)=>sum+row.bytes,0);assert.ok(bytes<31*1024*1024,`${width}px artifacts must leave room below the 32 MiB ZIP bound`);
    await writeManifest(width);console.log(`${width}px: ${images.length} screenshots, ${bytes} bytes; all five surfaces preserve refusal/uncertainty boundaries.`);
  }
} finally {
  if(browser)await browser.close();if(server.listening)await new Promise(resolve=>server.close(resolve));await server.packsmart.drain();await fs.rm(directory,{recursive:true,force:true});assert.equal(providerCalls,0);assert.equal(modelCalls,0);
}
