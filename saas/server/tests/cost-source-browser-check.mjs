// Remote CI Chromium only. Real local app + synthetic workspace + local API.
// No provider, model, external URL, deploy or production account activity.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { COST_SOURCE_REVIEW_CONTRACT } from '../lib/cost-source-stage.mjs';
import { createGovernedRecordStage, GOVERNED_RECORD_PRODUCER_CONTRACT } from '../lib/governed-record-stage.mjs';
import { upsertBusinessObjective } from '../lib/business-objectives.mjs';
import { detectOpportunities } from '../lib/control.mjs';
import { costSourceReviewContext, prepareCostSourceReview } from '../lib/cost-source-review.mjs';
import { createRestrictionTypographySession } from './objective-browser-typography.mjs';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'runvara-cost-source-browser-'));
const secret=crypto.randomBytes(32).toString('hex'),port=18897,base=`http://127.0.0.1:${port}`;
let browser,providerRequests=0,modelRequests=0;
const fixtureOnly=process.env.RUNVARA_COST_SOURCE_FIXTURE_CHECK==='1';
const server=createPacksmartServer({NODE_ENV:'test',COST_SOURCE_REVIEW_CONTRACT,GOVERNED_RECORD_PRODUCER_CONTRACT,APP_PUBLIC_URL:base,SESSION_SECRET:secret,CREDENTIALS_KEY:secret,SAAS_STATE_FILE:path.join(directory,'state.json'),SHOPIFY_PUBLIC_SYNC_ENABLED:'false'},
 {schedulerEnabled:false,agentOpsEnabled:false,fetchImpl:()=>{providerRequests++;throw new Error('Provider call forbidden');}});
server.packsmart.aiProvider.enhanceCommander=async()=>{modelRequests++;throw new Error('Model call forbidden');};
const selector={productId:'gid://shopify/Product/810',variantId:'gid://shopify/ProductVariant/811',sku:'SOURCE-BROWSER-SKU'};
const captures=[];
const artifactGroup=label=>label==='objective-sidecar'?'objective':['draft','saved','correction','history'].includes(label)?'review':'reconciliation';
const capturePath=(width,label,scale,index)=>path.join('/tmp/runvara-cost-source',String(width),artifactGroup(label),`runvara-cost-source-${width}-${label}-${scale}pct-${String(index).padStart(2,'0')}.png`);
const waitIdle=page=>page.waitForFunction(()=>document.querySelector('#cost-source-form').getAttribute('aria-busy')==='false');
async function captureState(page,width,label) {
 const panel=page.locator('#cost-source-dialog'),session=await panel.evaluateHandle(createRestrictionTypographySession);
 async function images(scale) {
  await page.locator('.cost-source-history-section').evaluate(node=>{node.open=true;});
  const body=page.locator('#cost-source-dialog .cost-source-body');
  await panel.evaluate(async node=>{await document.fonts.ready;await Promise.allSettled(node.getAnimations({subtree:true}).filter(animation=>animation.playbackRate!==0&&Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished));});
  let covered=0,index=0,last=-1;
  while(true) {
   const requested=await body.evaluate((node,covered)=>Math.min(Math.max(0,node.scrollHeight-node.clientHeight),Math.max(0,covered-24)),covered);
   await body.evaluate((node,top)=>{node.scrollTop=top;},requested);
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const geometry=await panel.evaluate(node=>{
    const body=node.querySelector('.cost-source-body'),close=document.getElementById('cost-source-close'),heading=node.querySelector('.cost-source-heading');
    const rect=node.getBoundingClientRect(),b=body.getBoundingClientRect(),c=close.getBoundingClientRect(),h=heading.getBoundingClientRect(),hit=document.elementFromPoint(c.x+c.width/2,c.y+c.height/2);
    return {modal:rect.toJSON(),body:b.toJSON(),close:c.toJSON(),heading:h.toJSON(),modalClient:node.clientWidth,modalScroll:node.scrollWidth,client:body.clientWidth,scroll:body.scrollWidth,top:body.scrollTop,height:body.clientHeight,total:body.scrollHeight,closeHit:hit===close||close.contains(hit),viewport:innerHeight,
     controls:[...node.querySelectorAll('button,input,select')].filter(control=>control.getClientRects().length).map(control=>({id:control.id,width:control.clientWidth,scroll:control.scrollWidth,height:control.clientHeight,scrollHeight:control.scrollHeight,bounds:control.getBoundingClientRect().toJSON()}))};
   });
   assert.ok(geometry.modal.x>=0&&geometry.modal.right<=width+1&&geometry.modal.y>=0&&geometry.modal.bottom<=geometry.viewport+1,`${width}/${label}/${scale}: modal in viewport`);
   assert.ok(geometry.modalScroll<=geometry.modalClient+1&&geometry.scroll<=geometry.client+1,`${width}/${label}/${scale}: no horizontal overflow`);
   assert.ok(geometry.closeHit&&geometry.close.bottom<=geometry.heading.bottom+1&&geometry.body.top>=geometry.heading.bottom-1,`${width}/${label}/${scale}: close/header visible and separate from scrolling body`);
   for(const control of geometry.controls) {
    assert.ok(control.bounds.x>=geometry.modal.x&&control.bounds.right<=geometry.modal.right+1,`${width}/${label}/${scale}: control stays within dialog ${control.id}`);
    if(control.id&&control.id!=='cost-source-ack'&&!['cost-source-currency','cost-source-effectiveFrom','cost-source-effectiveUntil','cost-source-taxBasis'].includes(control.id)) assert.ok(control.scroll<=control.width+1&&control.scrollHeight<=control.height+1,`${width}/${label}/${scale}: complete control label ${control.id}`);
   }
   assert.ok(geometry.top<=covered+1&&geometry.top+geometry.height>covered,`${width}/${label}/${scale}: gap-free scroll coverage`);
   assert.ok(geometry.top>last,`${width}/${label}/${scale}: scrolling advances`);last=geometry.top;
   const filename=capturePath(width,label,scale,++index);await fs.mkdir(path.dirname(filename),{recursive:true});
   // Actual visible viewport, with native sticky/fixed chrome and normal motion.
   await page.screenshot({path:filename,fullPage:false,animations:'allow',scale:'css'});
   const bytes=await fs.readFile(filename);captures.push({width,label,scale,filename,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),geometry});
   covered=geometry.top+geometry.height;if(covered>=geometry.total-1)break;
  }
 }
 try {await session.evaluate(s=>s.assertBaseline());await images(100);await session.evaluate(s=>s.begin());try{await session.evaluate(s=>s.enlarge());await images(200);}finally{await session.evaluate(s=>s.restore());}await session.evaluate(s=>s.assertBaseline());}
 finally {await session.dispose();}
}
function createSourceViewportSession(panel) {
 const view=panel.ownerDocument.defaultView,document=panel.ownerDocument,modal=panel.closest('dialog');
 const ancestors=[];
 for(let node=panel.parentElement;node&&node!==document.body&&node!==document.documentElement;node=node.parentElement)ancestors.push(node);
 const scrolling=()=>ancestors.filter(node=>/^(auto|scroll)$/.test(view.getComputedStyle(node).overflowY)&&node.scrollHeight>node.clientHeight);
 const chrome=()=>Array.from(document.querySelectorAll(modal?'#connection-close':'.topbar, .global-message')).filter(node=>{
  const style=view.getComputedStyle(node),rect=node.getBoundingClientRect();
  return ['sticky','fixed'].includes(style.position)&&rect.width>0&&rect.height>0&&rect.bottom>0&&rect.top<view.innerHeight;
 });
 const clearance=node=>Math.max(12,...chrome().filter(item=>node?node.contains(item):!modal).map(item=>item.getBoundingClientRect().height+24));
 return {
  async reveal(offset) {
   // Inner lists can scroll independently of the page; the dialog has its own
   // scrollport too. Re-read geometry after each scroll and allow native clamps.
   for(const node of scrolling()){
    const top=node.getBoundingClientRect().top+node.clientTop+clearance(node);
    node.scrollBy({top:panel.getBoundingClientRect().top+offset-top,behavior:'instant'});
   }
   if(!modal)view.scrollBy({top:panel.getBoundingClientRect().top+offset-clearance(null),behavior:'instant'});
   await new Promise(resolve=>view.requestAnimationFrame(()=>view.requestAnimationFrame(resolve)));
  },
  bounds() {
   const rect=panel.getBoundingClientRect();
   let top=0,bottom=view.innerHeight,left=0,right=view.innerWidth;
   for(const node of ancestors){
    const style=view.getComputedStyle(node),box=node.getBoundingClientRect();
    if(/^(auto|scroll|hidden|clip)$/.test(style.overflowY)){top=Math.max(top,box.top+node.clientTop);bottom=Math.min(bottom,box.top+node.clientTop+node.clientHeight);}
    if(/^(auto|scroll|hidden|clip)$/.test(style.overflowX)){left=Math.max(left,box.left+node.clientLeft);right=Math.min(right,box.left+node.clientLeft+node.clientWidth);}
   }
   // Reserve the whole horizontal band occupied by sticky chrome. This is
   // conservative even for the close button, which only covers the right edge.
   for(const node of chrome())top=Math.max(top,node.getBoundingClientRect().bottom+12);
   return {from:Math.max(0,top-rect.top),to:Math.min(rect.height,bottom-rect.top),height:rect.height,
    left:rect.left,right:rect.right,visibleLeft:left,visibleRight:right,scroll:panel.scrollWidth,client:panel.clientWidth};
  }
 };
}
// Populate the real owner objective route without a provider or model call.
function prepareObjectiveSidecar(state) {
 const actor={workspaceId:state.workspace.id,userId:state.users[0].id,sessionVersion:1};
 const record=(reference,identifier)=>{
  const reviewed=costSourceReviewContext(state,reference,actor);
  const result=prepareCostSourceReview(state,{...reference,sourceRevision:reviewed.sourceRevision,requestId:crypto.randomUUID(),basis:{currency:null,taxBasis:'unknown',effectiveFrom:null,effectiveUntil:null,sources:[{component:'landed',kind:'invoice',identifier,issuedOn:null}]}},actor);
  state.economics[reference.sku]=result.economics;if(result.historyEvent)state.costHistory.unshift(result.historyEvent);
 };
 // The browser path already has a matching reviewed first variant. The local
 // fixture-only API check creates that same state without claiming pixels.
 if(!state.economics[selector.sku].sourceBasis)record(selector,'BROWSER INVOICE matching sibling');
 const stale={productId:selector.productId,variantId:'gid://shopify/ProductVariant/812',sku:'STALE-SOURCE-SIBLING'};
 state.products[0].variants.push({id:stale.variantId,sku:stale.sku,title:'Stale saved source sibling',price:20,inventory:8},{id:'gid://shopify/ProductVariant/813',sku:'UNRECORDED-SOURCE-SIBLING',title:'No source attestation sibling',price:20,inventory:8});
 state.economics[stale.sku]={landed:'1.5000',packing:0};record(stale,'BROWSER INVOICE stale sibling');state.economics[stale.sku].landed='2.7500';state.economics['UNRECORDED-SOURCE-SIBLING']={landed:0};
 state.products[0].title='Box';state.products[0].description='';
 // This unusable fixture marker enables the existing owner context parser; it
 // is never decrypted, and every provider/model transport remains forbidden.
 state.connections[0].encryptedCredentials='unusable-synthetic-source-marker';state.connections[0].metadata.grantedScopes=['read_products','write_products'];
 state.connectionSettings.shopify={permissionMode:'approval_gated',revision:2};state.settings={...state.settings,growthCapacityHours:4,maxConcurrentGrowthExperiments:2};state.opportunities=[];
 detectOpportunities(state);for(const row of state.opportunities){row.executionCost=0;row.effortHours=1;}
 const candidate=state.opportunities.find(row=>row.evidence.some(item=>item.detail==='Thin product title'));assert.ok(candidate);
 const objective=upsertBusinessObjective(state,{title:'Inspect per-variant source attestations with financial holds',metric:'contribution_profit',baseline:null,target:100,direction:'increase',startsAt:new Date(Date.now()-86400000).toISOString(),endsAt:new Date(Date.now()+86400000).toISOString(),
  limits:{currency:'GBP',profitFirst:true,minGrossMarginPercent:0,maxMonthlyAdBudget:0,minStockCoverDays:0},executionPolicy:{schema:'runvara-objective-execution-policy/v1',mode:'enforce',scope:{provider:'shopify',operation:'product_content',connectionId:state.connections[0].id,account:state.connections[0].metadata.shopDomain}}},
  {workspaceId:state.workspace.id,actorId:state.users[0].id,governedRecordStage:createGovernedRecordStage({GOVERNED_RECORD_PRODUCER_CONTRACT})});
 return {objective,candidate};
}
function assertObjectiveSidecar(value) {
 assert.equal(value.costSources.available,true);assert.deepEqual(value.costSources.reviews.map(row=>row.status),['current','stale','unrecorded']);
 assert.equal(value.costSources.reviews[0].current,true);assert.equal(value.costSources.reviews[1].current,false);assert.equal(value.costSources.reviews[2].current,false);
 assert.equal(value.policy.allowed,false);assert.ok(value.policy.blockers.length>0);assert.equal(value.costSources.reviews[0].basis.currency,null);assert.equal(value.costSources.reviews[0].basis.taxBasis,'unknown');
 assert.equal(Object.hasOwn(value.source,'costSources'),false);assert.equal(Object.hasOwn(value.source,'sourceBasis'),false);
 const canonical=value=>JSON.stringify(value,function(_key,row){return row&&typeof row==='object'&&!Array.isArray(row)?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row;});
 assert.equal(crypto.createHash('sha256').update(canonical(value.source)).digest('hex'),value.sourceRevision,'diagnostic sidecar is outside exact content-source digest');
}
async function checkObjectiveFixture(seed,token) {
 const prepared=prepareObjectiveSidecar(seed);await server.packsmart.store.save(seed.workspace.id,seed);
 const headers={Cookie:`packsmart_session=${token}`,'Content-Type':'application/json','X-CSRF-Token':verifySessionToken(token,secret).csrf};
 const queued=await fetch(base+'/api/business-objectives/reviews',{method:'POST',headers,body:JSON.stringify({objectiveId:prepared.objective.id,objectiveRevision:prepared.objective.revision})});assert.equal(queued.status,202,await queued.clone().text());
 const {job}=await queued.json();await server.packsmart.agentOps.tick();
 const response=await fetch(base+'/api/objective-content/context?'+new URLSearchParams({jobId:job.id,opportunityId:prepared.candidate.id}),{headers});assert.equal(response.status,200,await response.clone().text());assertObjectiveSidecar(await response.json());
 const after=await server.packsmart.store.get(seed.workspace.id);assert.equal(after.connectionWrites.length,0);assert.equal(after.approvals.length,0);
}
async function captureObjectiveSidecar(page,width) {
 const panel=page.locator('#objective-content-editor'),typography=await panel.evaluateHandle(createRestrictionTypographySession),viewport=await panel.evaluateHandle(createSourceViewportSession);
 async function images(scale) {
  await panel.evaluate(async node=>{await document.fonts.ready;await Promise.allSettled(node.getAnimations({subtree:true}).filter(animation=>animation.playbackRate!==0&&Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation=>animation.finished));});
  let covered=0,index=0;
  while(true) {
   await viewport.evaluate((session,offset)=>session.reveal(offset),Math.max(0,covered-80));
   const geometry=await viewport.evaluate(session=>session.bounds());
   assert.ok(geometry.left>=geometry.visibleLeft-2&&geometry.right<=geometry.visibleRight+2&&geometry.scroll<=geometry.client+2,`${width}/objective-sidecar/${scale}: no horizontal clipping`);
   assert.ok(geometry.from<=covered+2&&geometry.to>covered+1,`${width}/objective-sidecar/${scale}: complete contiguous visible text coverage`);
   const filename=capturePath(width,'objective-sidecar',scale,++index);await fs.mkdir(path.dirname(filename),{recursive:true});
   await page.screenshot({path:filename,fullPage:false,animations:'allow',scale:'css'});const bytes=await fs.readFile(filename);
   captures.push({width,label:'objective-sidecar',scale,filename,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),geometry});
   covered=geometry.to;if(covered>=geometry.height-1)break;
  }
 }
 try {await typography.evaluate(s=>s.assertBaseline());await images(100);await typography.evaluate(s=>s.begin());try{await typography.evaluate(s=>s.enlarge());await images(200);}finally{await typography.evaluate(s=>s.restore());}await typography.evaluate(s=>s.assertBaseline());}
 finally {await viewport.dispose();await typography.dispose();}
}

try {
 server.listen(port,'127.0.0.1');await once(server,'listening');if(!fixtureOnly)browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
 for(const width of [320,390,430,1200]) {
  const seed=seedWorkspaceState({}, {workspaceId:`cost-source-browser-${width}`,userId:`source-owner-${width}`,email:`source-${width}@example.test`,name:'Synthetic source review',passwordHash:'fixture-only'});
  seed.products=[{id:selector.productId,provider:'shopify',title:'Saved cost source product',description:'Synthetic retained catalogue',status:'active',variants:[{id:selector.variantId,sku:selector.sku,title:'Exact saved variant',price:20,inventory:8}]}];
  seed.connections=[{id:'source-exact-shop',provider:'shopify',status:'connected',metadata:{shopDomain:'source-review.myshopify.com'}}];seed.connectionSettings={shopify:{permissionMode:'read_only',revision:1}};
  seed.economics={[selector.sku]:{landed:'4.2500',packing:0,delivery:2}};seed.costHistory=[];seed.connectionWrites=[];seed.approvals=[];await server.packsmart.store.save(seed.workspace.id,seed);
  const token=createSessionToken({userId:seed.users[0].id,workspaceId:seed.workspace.id,email:seed.users[0].email,role:'owner',sessionVersion:1},secret);
  if(fixtureOnly){await checkObjectiveFixture(seed,token);continue;}
  const context=await browser.newContext({viewport:{width,height:900}});
  await context.addCookies([{name:'packsmart_session',value:token,url:base,httpOnly:true,sameSite:'Strict'}]);const page=await context.newPage(),calls=[],errors=[],external=[];let mode='normal',objectiveCase=null,objectiveContext=null;
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(url.origin!==base){external.push(url.href);return route.abort();}if(!url.pathname.startsWith('/api/'))return route.continue();
   calls.push({path:url.pathname,method:req.method(),body:req.postData(),query:url.search});
   if(url.pathname==='/api/economics'&&req.method()==='PUT'){
    assert.deepEqual(Object.keys(req.postDataJSON()).sort(),['sku','sourceReview']);assert.equal(req.postDataJSON().sourceReview.variantId,selector.variantId);
    if(mode==='lose-before-save'){mode='normal';return route.abort();}
    if(mode==='pause'){mode='normal';return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'COST_SOURCE_REVIEW_PAUSED',error:'Paused'})});}
    if(mode==='commit-and-lose'){mode='normal';const response=await route.fetch();assert.equal(response.status(),200);return route.abort();}
    return route.continue();
   }
   if(url.pathname==='/api/economics/source-review'){assert.equal(url.searchParams.get('productId'),selector.productId);assert.equal(url.searchParams.get('variantId'),selector.variantId);assert.equal(url.searchParams.get('sku'),selector.sku);return route.continue();}
   if(url.pathname==='/api/business-objectives/reviews'&&req.method()==='POST'){
    assert.ok(objectiveCase);assert.deepEqual(req.postDataJSON(),{objectiveId:objectiveCase.objective.id,objectiveRevision:objectiveCase.objective.revision});const response=await route.fetch();assert.equal(response.status(),202,await response.text());await server.packsmart.agentOps.tick();return route.fulfill({response});
   }
   if(url.pathname==='/api/objective-content/context'&&req.method()==='GET'){
    const response=await route.fetch();assert.equal(response.status(),200,await response.text());objectiveContext=await response.json();assertObjectiveSidecar(objectiveContext);return route.fulfill({response});
   }
   if(req.method()==='GET'&&(url.pathname==='/api/business-objectives'||url.pathname.startsWith('/api/business-objectives/reviews/')))return route.continue();
   if(req.method()==='GET'&&['/api/auth/session','/api/bootstrap'].includes(url.pathname)){const response=await route.fetch();const data=await response.json();assert.equal(JSON.stringify(data).includes('BROWSER INVOICE'),false,'source identifiers stay out of generic DTO');return route.fulfill({response});}
   throw new Error('Unexpected browser API '+req.method()+' '+url.pathname);
  });
  await page.goto(base);await page.locator('#app-shell:not(.hidden)').waitFor();if(await page.locator('#mobile-menu').isVisible())await page.locator('#mobile-menu').click();await page.locator('#main-nav [data-view="profit"]').click();
  assert.equal(calls.some(call=>call.path==='/api/economics/source-review'),false);const open=async()=>{await page.locator('.cost-source-open').click();await waitIdle(page);};
  const field=(component,name)=>page.locator(`[data-component="${component}"] [data-source-field="${name}"]`),ack=page.locator('#cost-source-ack'),status=page.locator('#cost-source-status'),writes=()=>calls.filter(call=>call.method==='PUT');
  const fill=async identifier=>{await field('landed','include').check();await field('landed','kind').selectOption('invoice');await field('landed','identifier').fill(identifier);await ack.check();};
  await open();assert.equal(await page.evaluate(()=>document.activeElement.id),'cost-source-close');await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>Boolean(document.activeElement.closest('#cost-source-dialog'))),true);await page.keyboard.press('Shift+Tab');await page.keyboard.press('Escape');assert.equal(await page.locator('#cost-source-dialog').evaluate(node=>node.open),false);assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('cost-source-open')),true);
  await open();await fill('BROWSER INVOICE 1');await captureState(page,width,'draft');await ack.check();await page.locator('#cost-source-save').click();await waitIdle(page);assert.match(await status.textContent(),/Exact source annotation found/);await captureState(page,width,'saved');assert.equal(writes().length,1);
  await page.locator('#cost-source-correct').click();await waitIdle(page);await fill('BROWSER INVOICE correction 2');await captureState(page,width,'correction');await ack.check();await page.locator('#cost-source-save').click();await waitIdle(page);assert.match(await status.textContent(),/Exact source annotation found/);assert.match(await page.locator('#cost-source-history').textContent(),/BROWSER INVOICE 1/);assert.match(await page.locator('#cost-source-history').textContent(),/correction 2/);await captureState(page,width,'history');
  await page.locator('#cost-source-close').click();let state=await server.packsmart.store.get(seed.workspace.id);state.economics[selector.sku].landed='6.5000';await server.packsmart.store.save(seed.workspace.id,state);await open();assert.match(await page.locator('#cost-source-current').textContent(),/saved costs changed/);await captureState(page,width,'stale');
  await page.locator('#cost-source-correct').click();await waitIdle(page);await fill('BROWSER INVOICE unknown 3');mode='lose-before-save';await page.locator('#cost-source-save').click();await waitIdle(page);assert.match(await status.textContent(),/outcome is unknown/);const original=writes().at(-1).body;await captureState(page,width,'unknown');await page.locator('#cost-source-close').click();await open();assert.match(await status.textContent(),/outcome is unknown/);await ack.check();mode='pause';await page.locator('#cost-source-retry').click();await waitIdle(page);assert.equal(writes().at(-1).body,original);assert.match(await status.textContent(),/outcome is unknown/);await captureState(page,width,'unknown-paused');
  await page.locator('#cost-source-check').click();await waitIdle(page);await ack.check();await page.locator('#cost-source-retry').click();await waitIdle(page);assert.match(await status.textContent(),/Exact source annotation found/);assert.equal(writes().at(-1).body,original);
  await page.locator('#cost-source-correct').click();await waitIdle(page);await fill('BROWSER INVOICE paused 4');mode='pause';await page.locator('#cost-source-save').click();await waitIdle(page);assert.match(await status.textContent(),/refused/);await captureState(page,width,'first-paused');
  state=await server.packsmart.store.get(seed.workspace.id);assert.equal(state.economics[selector.sku].landed,'6.5000');assert.equal(state.costHistory.length,3);assert.equal(state.connectionWrites.length,0);assert.equal(state.approvals.length,0);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  await page.locator('#cost-source-close').click();objectiveCase=prepareObjectiveSidecar(state);await server.packsmart.store.save(seed.workspace.id,state);
  await page.reload();await page.locator('#app-shell:not(.hidden)').waitFor();
  if(await page.locator('#mobile-menu').isVisible())await page.locator('#mobile-menu').click();await page.locator('#main-nav [data-view="ai-team"]').click();
  await page.locator('.business-objectives-panel > summary').click();await page.locator('#load-business-objectives').click();await page.locator(`[data-prepare-objective-review="${objectiveCase.objective.id}"]`).click();
  await page.locator(`[data-request-objective-content="${objectiveCase.candidate.id}"]`).click();await page.waitForFunction(()=>document.querySelector('#objective-content-form').getAttribute('aria-busy')==='false');
  const sidecar=page.locator('#objective-content-cost-sources'),sidecarRows=sidecar.locator(':scope > ul > li');assert.equal(await sidecarRows.count(),3);
  assert.match(await sidecarRows.nth(0).textContent(),/SOURCE-BROWSER-SKU.*Matches saved costs and target/);assert.match(await sidecarRows.nth(1).textContent(),/STALE-SOURCE-SIBLING.*Saved costs or target changed/);assert.match(await sidecarRows.nth(2).textContent(),/UNRECORDED-SOURCE-SIBLING.*No saved attestation/);
  assert.match(await sidecar.textContent(),/Currency: Unknown/);assert.match(await sidecar.textContent(),/Tax basis: Unknown/);assert.match(await sidecar.textContent(),/Unknown start.*Unknown end/);assert.match(await sidecar.textContent(),/Financial qualification remains unavailable for this variant/);assert.match(await page.locator('#objective-content-policy').textContent(),/blocked.*zero.*evidence/);
  const unchangedPolicy=await page.locator('#objective-content-policy').textContent(),unchangedSource=JSON.stringify(objectiveContext.source),unchangedRevision=objectiveContext.sourceRevision;
  await captureObjectiveSidecar(page,width);assert.equal(await page.locator('#objective-content-policy').textContent(),unchangedPolicy);assert.equal(JSON.stringify(objectiveContext.source),unchangedSource);assert.equal(objectiveContext.sourceRevision,unchangedRevision);
  assert.equal(calls.some(call=>call.path==='/api/objective-content/requests'),false);const finalState=await server.packsmart.store.get(seed.workspace.id);assert.equal(finalState.connectionWrites.length,0);assert.equal(finalState.approvals.length,0);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  const files=captures.filter(item=>item.width===width),totalBytes=files.reduce((sum,item)=>sum+item.bytes,0),groups=[];
  for(const name of ['review','reconciliation','objective']) {
   const group=files.filter(item=>artifactGroup(item.label)===name),bytes=group.reduce((sum,item)=>sum+item.bytes,0);assert.ok(group.length>0);assert.ok(bytes<32*1024*1024,`width ${width}, group ${name} must fit32MiB without truncation`);
   const directory=path.join('/tmp/runvara-cost-source',String(width),name),manifest=path.join(directory,'manifest.json');
   await fs.writeFile(manifest,JSON.stringify({width,group:name,bytes,states:[...new Set(group.map(item=>item.label))],scales:[100,200],screenshots:group.length,files:group},null,2));groups.push({name,bytes,directory,manifest});
  }
  await fs.writeFile(`/tmp/runvara-cost-source/${width}/manifest.json`,JSON.stringify({width,totalBytes,artifactGroups:groups,states:[...new Set(files.map(item=>item.label))],scales:[100,200],screenshots:files.length,files,checks:['exact source-only PUT','native keyboard close and focus return','correction history retained','stale costs','unknown + close/reopen','same-ID retry','first pause versus unknown pause','normal motion','complete gap-free scroll coverage','no horizontal overflow','visible close/header','populated objective sidecar: matching/stale/unrecorded siblings','unchanged exact content-source digest and per-variant financial policy','zero provider/model writes']},null,2));
  await context.close();
 }
 assert.equal(providerRequests,0);assert.equal(modelRequests,0);console.log(fixtureOnly?'Synthetic objective-sidecar fixture APIs passed for four widths with matching/stale/unrecorded variants and zero provider/model requests. Browser pixels were not run.':`Cost-source browser checks passed at320,390,430,1200 with nine states at100%/200% text and ${captures.length} visible scroll captures. Four width manifests and12 width/group manifests contain hashes without truncation. Zero provider/model requests.`);
} finally {await browser?.close();if(server.listening){await new Promise(resolve=>server.close(resolve));await server.packsmart.drain();}await fs.rm(directory,{recursive:true,force:true});}
