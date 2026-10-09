// CI ONLY. Real app, local synthetic server and intercepted PUBLIC recovery DTOs.
// This fixture does not exercise the private recovery store or call any provider.
// Never install or launch a local browser to work around executor restrictions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { createRestrictionTypographySession } from './objective-browser-typography.mjs';
import { recoveryRoute,recoveryChannel,recoveryPreview,recoveryResult,recoveryObservation,originalStartedAt } from './order-recovery-ui-fixture.mjs';

assert.equal(process.env.CI,'true','Recovery browser execution is restricted to the existing GitHub CI workflow.');
assert.equal(process.env.GITHUB_ACTIONS,'true','Never launch this browser fixture in a local executor.');
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'runvara-recovery-browser-'));
const secret='synthetic-order-recovery-browser-secret-more-than-32-characters';
let browser,providerCalls=0;
const server=createPacksmartServer({NODE_ENV:'test',SESSION_SECRET:secret,CREDENTIALS_KEY:secret,SAAS_STATE_FILE:path.join(directory,'state.json'),SHOPIFY_PUBLIC_SYNC_ENABLED:'false'},
  {schedulerEnabled:false,agentOpsEnabled:false,fetchImpl:async()=>{providerCalls++;throw new Error('No provider calls are allowed in recovery UI CI.');}});
const report={schema:'runvara-order-recovery-browser-evidence/v1',status:'running',fixture:'real app with mocked public recovery DTOs',widths:[],actionLayouts:[],providerCalls:0};
async function assertRecoveryActionLayout(page,width,state,textScale){
  const buttons=await page.evaluate(()=>Array.from(document.querySelectorAll('#connection-order-recovery-form .button-row > button')).filter(button=>button.getClientRects().length).map(button=>{
    const box=button.getBoundingClientRect(),row=button.parentElement.getBoundingClientRect(),words=[];
    const textNodes=document.createTreeWalker(button,NodeFilter.SHOW_TEXT);
    while(textNodes.nextNode())for(const match of textNodes.currentNode.textContent.matchAll(/\S+/g)){
      const range=document.createRange();range.setStart(textNodes.currentNode,match.index);range.setEnd(textNodes.currentNode,match.index+match[0].length);
      const rects=Array.from(range.getClientRects()).filter(rect=>rect.width>0 && rect.height>0),lines=[];
      for(const rect of rects)if(!lines.some(top=>Math.abs(top-rect.top)<1))lines.push(rect.top);
      words.push({word:match[0],lines:lines.length});
    }
    return {id:button.id,text:button.textContent,left:box.left,right:box.right,top:box.top,bottom:box.bottom,rowLeft:row.left,rowRight:row.right,scrollWidth:button.scrollWidth,clientWidth:button.clientWidth,words};
  }));
  assert.ok(buttons.length>0,`Expected recovery actions at ${width}px/${state}/${textScale}%`);
  for(const [index,button] of buttons.entries()){
    assert.ok(button.words.length && button.words.every(word=>word.lines===1),`Recovery action word split at ${width}px/${state}/${textScale}%: ${JSON.stringify(button)}`);
    assert.ok(button.scrollWidth<=button.clientWidth+2,`Recovery action text overflow: ${JSON.stringify(button)}`);
    if(width<=680){
      assert.ok(Math.abs(button.left-button.rowLeft)<=2 && Math.abs(button.right-button.rowRight)<=2,`Narrow recovery actions must use a full row: ${JSON.stringify(button)}`);
      if(index)assert.ok(button.top>=buttons[index-1].bottom,`Narrow recovery actions must be stacked: ${JSON.stringify(buttons)}`);
    }
  }
  report.actionLayouts.push({width,state,textScale,buttons});
}
async function capture(page,width,name,selector='#connection-order-recovery'){
  const panel=page.locator(selector),typography=await panel.evaluateHandle(createRestrictionTypographySession);
  const controlsOnly=!['review','saved'].includes(name);
  const save=async suffix=>{
    if(selector==='#connection-order-recovery')await assertRecoveryActionLayout(page,width,name,suffix?200:100);
    await page.locator('#connection-close').focus();
    await panel.evaluate((node,controlsOnly)=>{const dialog=document.querySelector('#connection-dialog'),start=controlsOnly?node.querySelector('#order-recovery-status'):node;dialog.scrollTop+=start.getBoundingClientRect().top-dialog.getBoundingClientRect().top-70;},controlsOnly);
    const dimensions=await panel.evaluate(node=>{const box=node.getBoundingClientRect(),dialog=document.querySelector('#connection-dialog');return {width:innerWidth,page:document.documentElement.scrollWidth,left:box.left,right:box.right,scroll:node.scrollWidth,client:node.clientWidth,dialogScroll:dialog.scrollWidth,dialogClient:dialog.clientWidth};});
    assert.ok(dimensions.page<=width+2 && dimensions.left>=0 && dimensions.right<=width+2 && dimensions.scroll<=dimensions.client+2 && dimensions.dialogScroll<=dimensions.dialogClient+2,`Recovery overflow ${width}/${name}${suffix}: ${JSON.stringify(dimensions)}`);
    const files=[];
    // A single element screenshot can clip inside the scrollable dialog. Capture
    // its actual visible slices, with 32px overlap and unchanged layout instead.
    for(let frame=1;frame<=8;frame++){
      const geometry=await panel.evaluate((node,controlsOnly)=>{const dialog=document.querySelector('#connection-dialog'),p=node.getBoundingClientRect(),start=controlsOnly?node.querySelector('#order-recovery-status').getBoundingClientRect().top:p.top,d=dialog.getBoundingClientRect(),y=Math.max(start,d.top+70),bottom=Math.min(p.bottom,d.bottom-4);return {x:p.left,y,width:p.width,height:bottom-y,remaining:p.bottom-bottom,scrollTop:dialog.scrollTop};},controlsOnly);
      assert.ok(geometry.height>0,'Recovery screenshot must contain visible affected text');
      const filename=`/tmp/runvara-order-recovery-${width}-${name}${suffix}-${String(frame).padStart(2,'0')}.png`;
      const clip={x:geometry.x,y:geometry.y,width:geometry.width,height:geometry.height};
      await page.screenshot({path:filename,caret:'initial',clip});files.push({path:filename,width,state:name,region:controlsOnly?'hold and controls':'full affected section',textScale:suffix?200:100,frame,scrollTop:geometry.scrollTop,clip});
      if(geometry.remaining<=1)return files;
      const moved=await panel.evaluate((node,amount)=>{const d=document.querySelector('#connection-dialog'),before=d.scrollTop;d.scrollTop+=amount;return d.scrollTop>before;},Math.max(100,geometry.height-32));
      assert.ok(moved,'Recovery screenshot traversal must advance');
    }
    assert.fail('Recovery screenshot traversal exceeded eight bounded viewport slices');
  };
  const files=[];
  try {await typography.evaluate(s=>s.assertBaseline());files.push(...await save(''));await typography.evaluate(s=>s.begin());try{await typography.evaluate(s=>s.enlarge());files.push(...await save('-large-text'));}finally{await typography.evaluate(s=>s.restore());}await typography.evaluate(s=>s.assertBaseline());}
  finally {await typography.dispose();}
  return files;
}
try{
  const seed=seedWorkspaceState({}, {workspaceId:'recovery-browser',name:'Synthetic recovery UI',email:'recovery-ui@example.test',passwordHash:'fixture-only'});
  seed.products=[];seed.orders=[];seed.connections=[];seed.connectionWrites=[];seed.approvals=[];
  await server.packsmart.store.save(seed.workspace.id,seed);server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`,token=createSessionToken({userId:seed.users[0].id,workspaceId:seed.workspace.id,email:seed.users[0].email,role:'owner',sessionVersion:1},secret);
  browser=await chromium.launch({headless:true});
  for(const width of [320,390,1200]){
    const context=await browser.newContext({viewport:{width,height:900}});await context.addCookies([{name:'packsmart_session',value:token,url:base,httpOnly:true,sameSite:'Strict'}]);
    const page=await context.newPage(),calls=[],errors=[],external=[],unexpected=[],images=[];
    const widthReport={width,status:'running',images,explicitReviews:0,explicitActions:0,roles:['owner','admin','member','viewer'],textScales:[100,200],providerCalls:0};report.widths.push(widthReport);
    let available=false,persisted=false,role='owner',previewOptions={},postMode='unknown',deferredReview=null,reviewSequence=0,csrf=null;
    page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
    const reads=()=>calls.filter(c=>c.path===recoveryRoute),posts=()=>calls.filter(c=>c.path.startsWith(recoveryRoute+'/'));
    await page.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin!==base){external.push(url.origin);return route.abort();}
      if(!url.pathname.startsWith('/api/'))return route.continue();
      calls.push({path:url.pathname,method:request.method(),body:request.postData()});
      if(request.method()==='GET' && ['/api/auth/session','/api/bootstrap','/api/connection-centre'].includes(url.pathname)){
        const response=await route.fetch(),payload=await response.json();assert.equal(response.status(),200);
        if(url.pathname==='/api/auth/session'){payload.user.role=role;csrf=payload.csrf;}
        if(url.pathname==='/api/bootstrap'){payload.user.role=role;payload.connectionCentre=payload.connectionCentre.map(c=>c.id==='shopify'?recoveryChannel({available,observation:persisted}):c);}
        if(url.pathname==='/api/connection-centre')payload.channels=payload.channels.map(c=>c.id==='shopify'?recoveryChannel({available,observation:persisted}):c);
        return route.fulfill({response,json:payload});
      }
      if(url.pathname===recoveryRoute && request.method()==='GET'){
        const dto=recoveryPreview(seed.workspace.id,{...previewOptions,selection:`synthetic-browser-selection-${++reviewSequence}`});
        if(deferredReview){const pending=deferredReview;pending.dto=dto;pending.arrived();await pending.promise;}
        try{return await route.fulfill({status:200,json:dto});}catch{return;}
      }
      if([recoveryRoute+'/start',recoveryRoute+'/resume'].includes(url.pathname) && request.method()==='POST'){
        assert.equal(await request.headerValue('origin'),base);assert.equal(await request.headerValue('x-csrf-token'),csrf,'real app request includes current session CSRF');
        const body=JSON.parse(request.postData());assert.deepEqual(Object.keys(body),['selection']);assert.match(body.selection,/^synthetic-browser-selection-\d+$/);
        if(postMode==='unknown')return route.abort();
        if(postMode==='auth')return route.fulfill({status:409,json:{code:'ORDER_RECOVERY_AUTH_REFRESH_REQUIRED',error:'PRIVATE_PROVIDER_ERROR_CANARY'}});
        persisted=true;return route.fulfill({status:200,json:recoveryResult(seed.workspace.id)});
      }
      unexpected.push(request.method()+' '+url.pathname);return route.abort();
    });
    const navigate=async view=>{if(await page.locator('#mobile-menu').isVisible())await page.locator('#mobile-menu').click();await page.locator(`#main-nav [data-view="${view}"]`).click();await page.locator(`#view-${view}.active`).waitFor();};
    const open=async()=>{if(!await page.locator('#view-channels').evaluate(n=>n.classList.contains('active')))await navigate('channels');await page.locator('[data-channel-card="shopify"] [data-connection-action="open"]').first().click();await page.locator('#connection-dialog').waitFor();};
    const reload=async()=>{await page.reload();await page.locator('#app-shell:not(.hidden)').waitFor();await open();};
    const review=async()=>{await page.locator('#order-recovery-review').click();await page.waitForFunction(()=>document.querySelector('#connection-order-recovery-form').getAttribute('aria-busy')==='false');};
    try{
      await page.goto(base);await page.locator('#app-shell:not(.hidden)').waitFor();await open();
      assert.equal(await page.locator('#connection-order-recovery').count(),0);assert.equal(reads().length,0);assert.equal(posts().length,0);
      available=true;await reload();assert.equal(reads().length,0);await review();
      const ack=page.locator('#order-recovery-ack');assert.equal(await ack.isChecked(),false);assert.equal(await page.locator('#order-recovery-resume').isDisabled(),true);
      assert.match(await page.locator('#order-recovery-details').textContent(),/inclusive.*exclusive/s);assert.ok((await page.locator('#order-recovery-details').textContent()).includes(originalStartedAt));
      images.push(...await capture(page,width,'review'));
      await ack.focus();await page.keyboard.press('Space');assert.equal(await ack.isChecked(),true);await page.keyboard.press('Tab');assert.equal(await page.locator('#order-recovery-review').evaluate(n=>n===document.activeElement),true);await page.keyboard.press('Tab');assert.equal(await page.locator('#order-recovery-resume').evaluate(n=>n===document.activeElement),true);await page.keyboard.press('Enter');
      await page.locator('#order-recovery-status').getByText('outcome is unknown',{exact:false}).waitFor();assert.equal(posts().length,1);assert.equal(reads().length,1);assert.equal(await ack.isChecked(),false);
      await page.locator('#connection-close').click();await open();assert.equal(posts().length,1);assert.equal(reads().length,1);assert.match(await page.locator('#order-recovery-status').textContent(),/unknown/);
      images.push(...await capture(page,width,'unknown'));
      previewOptions={status:'failed',reason:'ORDER_RECOVERY_CAPACITY_EXHAUSTED',action:false};await review();assert.match(await page.locator('#order-recovery-status').textContent(),/storage is full.*completion records/);assert.equal(await ack.isEnabled(),false);assert.equal(await page.locator('[data-connection-action="sync-selected"]').isEnabled(),true);images.push(...await capture(page,width,'capacity'));
      previewOptions={status:'superseded',reason:'ORDER_RECOVERY_SUPERSEDED',action:false};await review();assert.match(await page.locator('#order-recovery-status').textContent(),/still use capacity.*cannot be resumed/);assert.equal(await page.locator('#order-recovery-resume').isVisible(),false);images.push(...await capture(page,width,'superseded'));
      previewOptions={status:'paused',reason:'ORDER_RECOVERY_PAUSED',action:false};await review();assert.equal(await ack.isEnabled(),false);assert.equal(await page.locator('#order-recovery-resume').isVisible(),false);
      previewOptions={status:'failed',reason:'ORDER_RECOVERY_AUTH_REFRESH_REQUIRED',action:false};await review();assert.match(await page.locator('#order-recovery-status').textContent(),/Refresh access or Reconnect.*identity can make retained pages ineligible/);images.push(...await capture(page,width,'access'));
      // A late preview cannot reopen a dismissed modal or restore consent.
      previewOptions={};let release,arrived;const received=new Promise(resolve=>{arrived=resolve;});deferredReview={arrived,promise:new Promise(resolve=>{release=resolve;})};await page.locator('#order-recovery-review').click();await received;await page.keyboard.press('Escape');assert.equal(await page.locator('#connection-dialog').evaluate(n=>n.open),false);release();deferredReview=null;await open();assert.equal(await ack.isChecked(),false);assert.equal(await page.locator('#order-recovery-resume').isVisible(),false);
      await review();await page.locator('#order-recovery-cancel').click();assert.equal(await page.locator('#order-recovery-review').evaluate(n=>n===document.activeElement),true);assert.equal(await ack.isChecked(),false);
      // Real browser Back/Forward events must dismiss and invalidate selection.
      await page.evaluate(()=>history.pushState({syntheticRecovery:true},'',location.pathname+'?recovery-ui-history=1'));await review();await ack.check();await page.goBack();assert.equal(await page.locator('#connection-dialog').evaluate(n=>n.open),false);await open();assert.equal(await ack.isChecked(),false);await review();await ack.check();await page.goForward();assert.equal(await page.locator('#connection-dialog').evaluate(n=>n.open),false);await open();assert.equal(await ack.isChecked(),false);
      // New explicit start succeeds; bootstrap/reload preserves original evidence.
      previewOptions={status:null};postMode='committed';await review();assert.equal(await ack.isChecked(),false);
      const startTypography=await page.locator('#connection-order-recovery').evaluateHandle(createRestrictionTypographySession);
      try{await assertRecoveryActionLayout(page,width,'start',100);await startTypography.evaluate(s=>s.begin());try{await startTypography.evaluate(s=>s.enlarge());await assertRecoveryActionLayout(page,width,'start',200);}finally{await startTypography.evaluate(s=>s.restore());}}finally{await startTypography.dispose();}
      await ack.check();await page.locator('#order-recovery-start').click();await page.locator('#connection-order-observation').waitFor();assert.equal(posts().length,2);assert.equal(posts()[1].path,recoveryRoute+'/start');
      images.push(...await capture(page,width,'saved','#connection-order-observation'));
      available=false;const readCount=reads().length;await reload();assert.equal(await page.locator('#connection-order-recovery').count(),0);assert.match(await page.locator('#connection-order-observation').textContent(),/earlier observation.*does not make the original observation newer/s);assert.ok((await page.locator('#connection-order-observation').textContent()).includes(originalStartedAt));assert.equal(reads().length,readCount);
      available=true;role='admin';await reload();assert.equal(await page.locator('#connection-order-recovery').count(),1);previewOptions={status:'failed'};await review();assert.equal(await ack.isChecked(),false);assert.equal(await page.locator('#connection-permissions select').isEnabled(),false,'admin recovery never expands owner write controls');
      for(const lowerRole of ['member','viewer']){role=lowerRole;const before=reads().length;await reload();assert.equal(await page.locator('#connection-order-recovery').count(),0);assert.equal(reads().length,before);assert.equal(await page.locator('[data-connection-action="sync-selected"]').isEnabled(),false);}
      assert.doesNotMatch(await page.locator('#connection-detail').innerHTML(),/synthetic-browser-selection|PRIVATE_PROVIDER_ERROR_CANARY|stageId|sessionDigest/);
      assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(unexpected,[]);assert.equal(providerCalls,0);
      widthReport.imageBytes=(await Promise.all(images.map(image=>fs.stat(image.path)))).reduce((sum,file)=>sum+file.size,0);
      assert.ok(images.length<=48 && widthReport.imageBytes<=8*1024*1024,'Keep each width artifact bounded to 48 native slices / 8 MiB.');
      widthReport.status='passed';
    }finally{Object.assign(widthReport,{explicitReviews:reads().length,explicitActions:posts().length,providerCalls,errors,external,unexpected});await context.close();}
  }
  report.status='passed';
  console.log('Recovery UI CI passed real app interactions at 320, 390 and 1200px, normal and 200% affected text. Public DTOs are synthetic; zero provider calls. Downloaded screenshots require actual pixel review.');
}finally{report.providerCalls=providerCalls;if(report.status!=='passed')report.status='failed';await fs.writeFile('/tmp/runvara-order-recovery-report.json',JSON.stringify(report,null,2)+'\n');if(browser)await browser.close();if(server.listening)await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});assert.equal(providerCalls,0);}
