// Permitted remote CI Chromium only. Real app + local production review/context/
// prepare/history APIs with synthetic retained data; no provider/model requests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { upsertBusinessObjective } from '../lib/business-objectives.mjs';
import { detectOpportunities } from '../lib/control.mjs';
import { createRestrictionTypographySession } from './objective-browser-typography.mjs';

const directory=await fs.mkdtemp(path.join(os.tmpdir(),'runvara-objective-content-browser-'));
const port=18879,base=`http://127.0.0.1:${port}`,secret='objective-content-browser-synthetic-only-over-thirty-two-characters';
let providerRequests=0,modelRequests=0,browser;
const server=createPacksmartServer({NODE_ENV:'test',APP_PUBLIC_URL:base,SESSION_SECRET:secret,CREDENTIALS_KEY:secret,SAAS_STATE_FILE:path.join(directory,'state.json'),SHOPIFY_PUBLIC_SYNC_ENABLED:'false'},
 {schedulerEnabled:false,agentOpsEnabled:false,fetchImpl:()=>{providerRequests++;throw new Error('Provider transport forbidden in synthetic objective-content browser fixture');}});
server.packsmart.aiProvider.enhanceCommander=async()=>{modelRequests++;throw new Error('Model transport forbidden in synthetic objective-content browser fixture');};
const captures=[];
function assertPublicReview(payload) {
 const writes=payload.connectionWrites||payload.writes||[];
 for(const write of writes){
  for(const key of ['objectivePolicyProposal','source','dispatchClaim','providerState','recordedActionContext','stableApproval'])assert.equal(Object.hasOwn(write,key),false,'Generic write must omit '+key);
  if(write.input?.operation==='product_content'){
   assert.deepEqual(Object.keys(write.sourceDisplay).sort(),['schema','origin','status','objectiveId','objectiveRevision','jobId','reportId','opportunityId','productId'].sort());
   assert.equal(write.sourceDisplay.schema,'runvara-objective-content-display/v1');assert.equal(write.sourceDisplay.origin,'owner_objective_content');assert.equal(write.sourceDisplay.status,'available');
  }
 }
 for(const approval of payload.approvals||[]){
  for(const key of ['source','objectivePolicyProposalDigest','digest','stableApproval'])assert.equal(Object.hasOwn(approval.payload||{},key),false,'Generic approval payload must omit '+key);
 }
}
async function capture(page,width,name){
 const panel=page.locator('#objective-content-editor'),typography=await panel.evaluateHandle(createRestrictionTypographySession);
 const image=async suffix=>{
  await page.locator('#objective-content-cancel').focus();
  const dimensions=await panel.evaluate(node=>({page:document.documentElement.scrollWidth,panel:node.scrollWidth,available:node.clientWidth}));
  assert.ok(dimensions.page<=width+2&&dimensions.panel<=dimensions.available+2,`goal content ${name}${suffix} overflow ${width}: ${JSON.stringify(dimensions)}`);
  const file=`/tmp/runvara-objective-content-${width}-${name}${suffix}.png`;await panel.screenshot({path:file,caret:'initial'});captures.push({width,file});
 };
 try {await typography.evaluate(session=>session.assertBaseline());await image('');await typography.evaluate(session=>session.begin());try{await typography.evaluate(session=>session.enlarge());await image('-large-text');}finally{await typography.evaluate(session=>session.restore());}await typography.evaluate(session=>session.assertBaseline());}finally{await typography.dispose();}
}
// Capture the live generic DTO consumers in overlapping real viewports. An
// element screenshot taller than a dialog can silently clip content or repeat
// sticky chrome. Scroll the actual containers instead; leave all chrome intact.
function createConsumerViewportSession(panel) {
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
async function captureConsumer(page,width,name,panel,actions){
 const typography=await panel.evaluateHandle(createRestrictionTypographySession),viewport=await panel.evaluateHandle(createConsumerViewportSession);
 const actionViewport=await actions.evaluateHandle(createConsumerViewportSession),buttons=await actions.locator('button').all();
 assert.ok(buttons.length>0,`${name} must retain its action controls`);
 const buttonViewports=await Promise.all(buttons.map(button=>button.evaluateHandle(createConsumerViewportSession)));
 const images=async suffix=>{
  // Keep focus visible on a real non-text control without changing inline
  // styles or triggering any approval/apply action.
  await panel.locator('summary').evaluate(node=>node.focus({preventScroll:true}));
  let covered=0,part=0;
  while(true){
   await viewport.evaluate((session,offset)=>session.reveal(offset),Math.max(0,covered-80));
   const bounds=await viewport.evaluate(session=>session.bounds()),label=`${width}px ${name}${suffix} slice ${part+1}`;
   assert.ok(bounds.left>=bounds.visibleLeft-2&&bounds.right<=bounds.visibleRight+2&&bounds.scroll<=bounds.client+2,`${label} horizontal clipping: ${JSON.stringify(bounds)}`);
   assert.ok(bounds.from<=covered+2&&bounds.to>covered+1,`${label} does not extend contiguous visible coverage: ${JSON.stringify({covered,...bounds})}`);
   const file=`/tmp/runvara-objective-content-${width}-${name}${suffix}-viewport-${++part}.png`;
   await page.screenshot({path:file,fullPage:false,caret:'initial'});captures.push({width,file});
   console.log(`${label}: visible source pixels ${Math.round(bounds.from)}-${Math.round(bounds.to)} of ${Math.round(bounds.height)}`);
   covered=bounds.to;if(covered>=bounds.height-1)break;
   assert.ok(part<60,`${label} exceeded the bounded viewport capture budget`);
  }
  // Actions sit outside the enlarged source subtree. Capture their real row
  // separately in each source-text state, without resizing or invoking them.
  await actionViewport.evaluate(session=>session.reveal(0));
  const file=`/tmp/runvara-objective-content-${width}-${name}${suffix}-actions-viewport.png`;
  await page.screenshot({path:file,fullPage:false,caret:'initial'});captures.push({width,file});
  const controls=[{label:'action row',bounds:await actionViewport.evaluate(session=>session.bounds())}];
  for(let index=0;index<buttons.length;index++)controls.push({label:await buttons[index].textContent(),bounds:await buttonViewports[index].evaluate(session=>session.bounds())});
  for(const {label,bounds} of controls){
   const description=`${width}px ${name}${suffix} ${label}: ${JSON.stringify(bounds)}`;
   assert.ok(bounds.height>0&&bounds.right>bounds.left,`Action control must be rendered: ${description}`);
   assert.ok(bounds.left>=bounds.visibleLeft-2&&bounds.right<=bounds.visibleRight+2&&bounds.scroll<=bounds.client+2,`Action control must fit its actual scrollport and viewport: ${description}`);
   assert.ok(bounds.from<=1&&bounds.to>=bounds.height-1,`Action control must be fully visible below sticky chrome: ${description}`);
  }
  console.log(`${width}px ${name}${suffix}: complete action row and ${buttons.length} buttons visible in ${file}`);
 };
 try {
  await typography.evaluate(session=>session.assertBaseline());await images('');
  await typography.evaluate(session=>session.begin());
  try{await typography.evaluate(session=>session.enlarge());await images('-large-text');}
  finally{await typography.evaluate(session=>session.restore());}
  await typography.evaluate(session=>session.assertBaseline());
 }finally{await typography.dispose();await viewport.dispose();await actionViewport.dispose();await Promise.all(buttonViewports.map(handle=>handle.dispose()));}
}
try{
 server.listen(port,'127.0.0.1');await once(server,'listening');assert.equal(base,`http://${server.address().address}:${server.address().port}`);
 browser=await chromium.launch({headless:true});
 for(const width of [320,390,1200]){
  const seed=seedWorkspaceState({}, {workspaceId:`objective-content-browser-${width}`,userId:`objective-content-owner-${width}`,name:'Synthetic goal-associated content',email:`objective-${width}@example.test`,passwordHash:'fixture-only'});
  const productId='gid://shopify/Product/54321';seed.products=[{id:productId,provider:'shopify',title:'Box',description:'Retained brief description',status:'active',variants:[]}];
  seed.connections=[{id:'objective-content-exact',provider:'shopify',status:'connected',encryptedCredentials:'synthetic-opaque-marker-never-decrypted',metadata:{shopDomain:'objective-content.myshopify.com',grantedScopes:['read_products','write_products']}}];
  seed.connectionSettings={shopify:{permissionMode:'approval_gated',revision:7}};seed.settings={...seed.settings,growthCapacityHours:4,maxConcurrentGrowthExperiments:2};seed.connectionWrites=[];seed.approvals=[];seed.decisions=[];seed.exceptions=[];seed.opportunities=[];
  detectOpportunities(seed);for(const row of seed.opportunities){row.executionCost=0;row.effortHours=1;}
  const candidate=seed.opportunities.find(row=>row.evidence.some(item=>item.detail==='Thin product title'));assert.ok(candidate);
  const objective=upsertBusinessObjective(seed,{title:'Improve recorded contribution with exact owner content',metric:'contribution_profit',baseline:null,target:100,direction:'increase',startsAt:new Date(Date.now()-86400000).toISOString(),endsAt:new Date(Date.now()+86400000).toISOString(),
   limits:{currency:'GBP',profitFirst:true,minGrossMarginPercent:0,maxMonthlyAdBudget:0,minStockCoverDays:0},executionPolicy:{schema:'runvara-objective-execution-policy/v1',mode:'enforce',scope:{provider:'shopify',operation:'product_content',connectionId:seed.connections[0].id,account:'objective-content.myshopify.com'}}},{workspaceId:seed.workspace.id,actorId:seed.users[0].id});
  await server.packsmart.store.save(seed.workspace.id,seed);
  const token=createSessionToken({userId:seed.users[0].id,workspaceId:seed.workspace.id,email:seed.users[0].email,role:'owner',sessionVersion:1},secret);
  const context=await browser.newContext({viewport:{width,height:900}});await context.addCookies([{name:'packsmart_session',value:token,url:base,httpOnly:true,sameSite:'Strict'}]);
  const page=await context.newPage(),calls=[],errors=[],external=[],unexpected=[];let postMode='commit-and-lose';
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());if(url.origin!==base){external.push(url.href);return route.abort();}
   if(!url.pathname.startsWith('/api/'))return route.continue();
   calls.push({path:url.pathname,query:url.search,method:request.method(),body:request.postData()});
   if(request.method()==='GET'&&['/api/bootstrap','/api/connection-centre'].includes(url.pathname)){const response=await route.fetch();assert.equal(response.status(),200);assertPublicReview(await response.json());return route.fulfill({response});}
   if(request.method()==='GET'&&(['/api/auth/session','/api/business-objectives','/api/objective-content/context'].includes(url.pathname)||url.pathname.startsWith('/api/objective-content/requests/')||url.pathname.startsWith('/api/business-objectives/reviews/')))return route.continue();
   if(request.method()==='POST'&&url.pathname==='/api/business-objectives/reviews'){
    assert.deepEqual(request.postDataJSON(),{objectiveId:objective.id,objectiveRevision:objective.revision});const response=await route.fetch();assert.equal(response.status(),202);await server.packsmart.agentOps.tick();return route.fulfill({response});
   }
   if(request.method()==='POST'&&url.pathname==='/api/objective-content/requests'){
    assert.equal(await request.headerValue('origin'),base);
    if(postMode==='commit-and-lose'){postMode='normal';const response=await route.fetch();assert.equal(response.status(),200,await response.text());return route.abort();}
    if(postMode==='lose-before-send'){postMode='normal';return route.abort();}
    return route.continue();
   }
   unexpected.push(calls.at(-1));return route.abort();
  });
  await page.goto(base);await page.locator('#app-shell:not(.hidden)').waitFor();
  const navigate=async view=>{if(await page.locator('#mobile-menu').isVisible())await page.locator('#mobile-menu').click();await page.locator(`#main-nav [data-view="${view}"]`).click();};
  await navigate('ai-team');await page.locator('.business-objectives-panel > summary').click();await page.locator('#load-business-objectives').click();await page.locator(`[data-prepare-objective-review="${objective.id}"]`).waitFor();
  assert.equal(calls.some(call=>call.path.startsWith('/api/objective-content/')),false);
  await page.locator(`[data-prepare-objective-review="${objective.id}"]`).click();
  const entry=page.locator(`[data-request-objective-content="${candidate.id}"]`);await entry.waitFor();await entry.click();await page.waitForFunction(()=>document.querySelector('#objective-content-form').getAttribute('aria-busy')==='false');
  const account=page.locator('#objective-content-account'),product=page.locator('#objective-content-product'),ack=page.locator('#objective-content-ack'),status=page.locator('#objective-content-status');
  const writes=()=>calls.filter(call=>call.path==='/api/objective-content/requests'),checks=()=>calls.filter(call=>call.path.startsWith('/api/objective-content/requests/'));
  assert.equal(await account.inputValue(),'');assert.equal(await product.inputValue(),'');assert.equal(await page.locator('#objective-content-title').inputValue(),'');assert.equal(await ack.isChecked(),false);assert.equal(writes().length,0);
  const fill=async title=>{await account.selectOption(seed.connections[0].id);await product.selectOption(productId);await page.locator('#objective-content-title').fill(title);await page.locator('#objective-content-description').fill('Exact owner-authored product description.\nOnly these reviewed words are proposed.');};
  await fill('Exact goal-associated title');await ack.check();await page.locator('#objective-content-title').fill('Exact reviewed goal-associated title');assert.equal(await ack.isChecked(),false);assert.match(await page.locator('#objective-content-policy').textContent(),/blocked.*zero.*evidence/);
  await capture(page,width,'review');await ack.check();await page.locator('#objective-content-prepare').click();await status.getByText('The preparation outcome is unknown.',{exact:false}).waitFor();
  assert.equal(writes().length,1);const first=JSON.parse(writes()[0].body);assert.equal(Object.hasOwn(first,'source'),false);assert.equal(first.sourceRevision.length,64);assert.equal(first.confirmedDestinationProduct,true);assert.equal(first.opportunityId,candidate.id);
  let stored=await server.packsmart.store.get(seed.workspace.id);assert.equal(stored.connectionWrites.length,1);assert.equal(stored.approvals.length,1);assert.equal(stored.approvals[0].status,'pending');assert.equal(stored.connectionWrites[0].objectivePolicyProposal.origin,'owner_objective_content');
  await capture(page,width,'unknown');await page.locator('#objective-content-cancel').click();assert.equal(await page.locator('#objective-content-editor').isVisible(),false);await page.locator('#resume-objective-content').click();assert.ok((await page.locator('#objective-content-exact').textContent()).includes(first.requestId));assert.equal(checks().length,0);await page.locator('#objective-content-check').click();await status.getByText('Exact goal-associated request found:',{exact:false}).waitFor();assert.equal(checks().length,1);assert.equal(writes().length,1);
  // Inspect actual saved source alongside exact content, without approving/applying.
  await page.locator('#objective-content-cancel').click();await navigate('channels');
  // The page refresh control is inert while the dialog is open. Read the saved
  // history explicitly before opening it; no live sync or provider call occurs.
  await page.locator('#connection-refresh').click();await page.waitForFunction(()=>!document.querySelector('#connection-refresh').disabled);
  await page.locator('#connection-grid [data-provider="shopify"][data-connection-action="open"]').first().click();await page.locator('#connection-dialog').waitFor();
  await page.locator('#connection-dialog .connection-write').getByText('Review exact change',{exact:true}).first().waitFor();await page.locator('#connection-dialog .connection-write summary').first().click();
  const exact=page.locator('#connection-dialog .connection-write').first();assert.ok((await exact.textContent()).includes(first.jobId));assert.ok((await exact.textContent()).includes(candidate.id));assert.match(await exact.textContent(),/commercial readiness and objective progress remain unverified/);
  const connectionActions=exact.locator('.button-row');assert.deepEqual(await connectionActions.locator('button').allTextContents(),['Open Approval Centre']);
  await captureConsumer(page,width,'connection-exact-write',exact.locator('details'),connectionActions);await page.locator('#connection-close').click();
  await navigate('ai-team');await page.locator('#refresh-objective-review').click();await entry.waitFor();await entry.click();await page.waitForFunction(()=>document.querySelector('#objective-content-form').getAttribute('aria-busy')==='false');await fill('Explicit same-reference retry');await ack.check();postMode='lose-before-send';await page.locator('#objective-content-prepare').click();await status.getByText('The preparation outcome is unknown.',{exact:false}).waitFor();
  const second=JSON.parse(writes()[1].body);await page.locator('#objective-content-check').click();await status.getByText('No matching request was found in the checked snapshot',{exact:false}).waitFor();assert.equal(writes().length,2);assert.equal(await ack.isChecked(),false);assert.equal(await page.locator('#objective-content-retry').isDisabled(),true);await capture(page,width,'retry');
  await ack.check();await page.locator('#objective-content-retry').click();await status.getByText('Exact goal-associated request found:',{exact:false}).waitFor();assert.equal(writes().length,3);assert.deepEqual(JSON.parse(writes()[2].body),second);
  await page.locator('#objective-content-approvals').click();await page.locator('#approval-list summary').getByText('Review full goal-associated content',{exact:true}).first().waitFor();assert.ok((await page.locator('#approval-list').textContent()).includes(second.jobId));assert.equal(calls.some(call=>call.path.includes('/decision')||call.path.endsWith('/execute')),false);
  const approvalCard=page.locator('#approval-list .approval-card').filter({hasText:second.jobId}).first(),approvalActions=approvalCard.locator('.approval-actions');
  const approvalSource=approvalCard.locator('details').filter({has:page.getByText('Review full goal-associated content',{exact:true})});
  assert.deepEqual(await approvalActions.locator('button').allTextContents(),['Review exact change','Reject','Approve']);
  await approvalSource.locator('summary').click();await captureConsumer(page,width,'approval-source',approvalSource,approvalActions);
  await navigate('ai-team');await page.locator('#resume-objective-content').click();await page.locator('#objective-content-cancel').click();await page.locator('#refresh-objective-review').click();await entry.waitFor();await entry.click();await page.waitForFunction(()=>document.querySelector('#objective-content-form').getAttribute('aria-busy')==='false');await fill('Refused because retained source changed');await ack.check();
  stored=await server.packsmart.store.get(seed.workspace.id);stored.products[0].title='New';await server.packsmart.store.save(seed.workspace.id,stored);
  await page.locator('#objective-content-prepare').click();await status.getByText('Preparation was refused.',{exact:false}).waitFor();assert.equal(await ack.isChecked(),false);assert.equal(await page.locator('#objective-content-prepare').isDisabled(),true);assert.equal(writes().length,4);await capture(page,width,'stale');
  stored=await server.packsmart.store.get(seed.workspace.id);assert.equal(stored.connectionWrites.length,2);assert.equal(stored.approvals.length,2);assert.ok(stored.approvals.every(row=>row.status==='pending'));assert.equal(providerRequests,0);assert.equal(modelRequests,0);assert.deepEqual(external,[]);assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[]);await context.close();
  const bytes=(await Promise.all(captures.filter(row=>row.width===width).map(row=>fs.stat(row.file)))).reduce((sum,row)=>sum+row.size,0);assert.ok(bytes<32*1024*1024,`${width}px screenshot artifact exceeds32MiB`);
 }
 console.log('Objective/report-bound content passed normal-size source/prepare/reconcile flows at320,390,1200, explicit same-ID retry, saved history/approval review and stale-source refusal. Separate normal/exact200% source-subtree captures cover both generic displays, with additional complete action-row views in each state; surrounding app and action-control typography is unchanged. Approval/apply remain separate; zero provider/model calls.');
}finally{if(browser)await browser.close();if(server.listening)await new Promise(resolve=>server.close(resolve));await server.packsmart.drain();await fs.rm(directory,{recursive:true,force:true});assert.equal(providerRequests,0);assert.equal(modelRequests,0);}
