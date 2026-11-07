// Synthetic loopback server/database/browser only. No real sessions or sources.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {maintenanceFixture,ownerState,SECRET} from './maintenance-login-fixture.mjs';
import {createSessionToken} from '../lib/security.mjs';
import {createOwnerProductReadinessProjection,OWNER_PRODUCT_READINESS_PATH as PATH,OWNER_PRODUCT_READINESS_FLAG as FLAG} from '../lib/owner-product-readiness.mjs';
import {syntheticBundleFixture} from './support-bundle-fixtures.mjs';
const output=path.resolve(process.env.RUNVARA_PRODUCT_READINESS_EVIDENCE||'.product-readiness-browser-evidence');
await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
const results=[],requests=[],errors=[];let external=0;
const check=(ok,name)=>{assert.ok(ok,name);results.push(name);console.log('PASS '+name);};
async function bounded(promise,label){
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Browser fixture stalled: '+label)),15000);})]);}
 finally{clearTimeout(timer);}
}
const env={NODE_ENV:'test',APP_PUBLIC_URL:'http://127.0.0.1',RUNVARA_QUIET_OWNER_LOGIN:'disabled/v1',RUNVARA_QUIET_OWNER_WORKSPACE:'enabled/v1',[FLAG]:'enabled/v1',RUNVARA_QUIET_OWNER_PRODUCT_READINESS_EXPIRES_AT:new Date(Date.now()+240000).toISOString()};
try{
 for(const width of [390,1200]){
  const state=ownerState('packsmart-solutions'),f=await maintenanceFixture({states:[state],env});
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   await context.addCookies([{name:'packsmart_session',value:createSessionToken({userId:state.users[0].id,workspaceId:state.workspace.id,email:state.users[0].email,role:'owner',sessionVersion:1},SECRET),url:f.base,httpOnly:true,sameSite:'Strict'}]);
   await context.addInitScript(()=>localStorage.setItem('packsmart-saas-economics-v1','preserve-synthetic-legacy'));
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==f.base){external++;return route.abort();}requests.push({method:route.request().method(),path:u.pathname});return route.continue();});
   async function open(){await page.goto(f.base,{waitUntil:'networkidle'});await page.locator('#app-shell').waitFor({state:'visible'});if(width<600)await page.locator('#mobile-menu').click();await page.locator('#main-nav [data-view="channels"]').click();await page.locator('#product-readiness-check').waitFor({state:'visible'});}
   const prior=requests.filter(r=>r.path===PATH).length;await open();
   check(requests.filter(r=>r.path===PATH).length===prior,`${width}: opening Channels makes no readiness request`);
   check(await page.locator('#product-readiness-check').isEnabled(),`${width}: owner sees enabled read-only check`);
   check(await page.locator('#catalogue-import-start').count()===0&&await page.locator('#shopify-token-exchange-start').count()===0,`${width}: import and token controls remain absent`);
   await page.locator('#product-readiness-check').click();
   await page.waitForFunction(()=>document.querySelector('#product-readiness-result')?.textContent.includes('No complete import receipt'));
   check((await page.locator('#product-readiness-result').textContent()).includes('reconcile any previous attempt'),`${width}: incomplete receipt requires reconciliation`);
   check(!(await page.locator('#product-readiness-result').textContent()).includes('nothing has been imported'),`${width}: missing evidence is not proof of non-execution`);
   check((await page.locator('#product-readiness-result').textContent()).includes('not a live price'),`${width}: current price and stock limitations visible`);
   const fixture=syntheticBundleFixture(Date.now()),ready=createOwnerProductReadinessProjection(fixture.policy)(state.workspace.id,fixture.products,fixture.context,{now:fixture.now});
   // UI result contracts are stubbed; production pinned validator is tested separately.
   let release,entered,deliveries=0;const held=new Promise(r=>release=r),seen=new Promise(r=>entered=r);
   await page.route('**'+PATH,async route=>{deliveries++;entered();await held;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(ready)});});
   const count=requests.filter(r=>r.path===PATH).length;
   await page.locator('#product-readiness-check').evaluate(button=>{button.click();document.querySelector('#product-readiness-check').click();});await seen;
   check(await page.locator('#product-readiness-check').isDisabled(),`${width}: busy check disables double click`);
   release();await page.waitForFunction(()=>document.querySelector('#product-readiness-result')?.textContent.includes('15 products / 150'));
   check(deliveries===1,`${width}: double click sends exactly one readiness request`);
   // The route override bypasses the global recorder; track fixture delivery explicitly.
   check(requests.filter(r=>r.path===PATH).length===count,`${width}: stubbed response does not reach server transport`);
   check((await page.locator('#product-readiness-result').textContent()).includes('separate approval'),`${width}: ready does not authorize public trial`);
   check((await page.locator('#product-readiness-result').textContent()).includes(fixture.context.sourceCapturedAt),`${width}: source capture shown`);
   await page.unroute('**'+PATH);
   f.fake.states.get(state.workspace.id).shopifyCatalogueImports=[{schema:'runvara-shopify-catalogue-import/v1',requestId:'44444444-4444-4444-8444-444444444444',status:'reserved',startedAt:new Date().toISOString()}];
   const refreshed=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/bootstrap');await page.locator('#refresh-all').click();check((await refreshed).status()===200,`${width}: newer reserved receipt reload succeeds`);
   await page.waitForFunction(()=>document.querySelector('#catalogue-import-panel')?.textContent.includes('44444444-4444-4444-8444-444444444444: reserved'));
   check(await page.locator('#product-readiness-result').count()===0,`${width}: completed old success is cleared for newer snapshot`);
   let oldRelease,oldEntered,newRelease,newEntered,oldRequest,reads=0;
   const oldHeld=new Promise(r=>oldRelease=r),oldSeen=new Promise(r=>oldEntered=r),newHeld=new Promise(r=>newRelease=r),newSeen=new Promise(r=>newEntered=r);
   await page.route('**'+PATH,async route=>{
     if(++reads===1){oldRequest=route.request();oldEntered();await oldHeld;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(ready)});}
     else {const response=await route.fetch();newEntered();await newHeld;await route.fulfill({response});}
   });
   await page.locator('#product-readiness-check').click();await oldSeen;
   const reloaded=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/bootstrap');await page.locator('#refresh-all').click();await reloaded;
   await page.waitForFunction(()=>document.querySelector('#product-readiness-check')?.disabled===false);
   check(await page.locator('#product-readiness-result').count()===0,`${width}: reload invalidates in-flight readiness message`);
   await page.locator('#product-readiness-check').click();await newSeen;
   const oldFinished=page.waitForEvent('requestfinished',{predicate:r=>r===oldRequest});oldRelease();await oldFinished;
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   check(await page.locator('#product-readiness-check').isDisabled(),`${width}: old response cannot unlock newer pending check`);
   newRelease();await page.waitForFunction(()=>document.querySelector('#product-readiness-result')?.textContent.includes('previous import has no confirmed complete outcome'));
   check(!(await page.locator('#product-readiness-result').textContent()).includes('meets the product-trial'),`${width}: new reconciliation result replaces old success`);
   await page.unroute('**'+PATH);
   await page.route('**'+PATH,route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...ready,permitsImport:true,secret:'DO-NOT-DISPLAY'})}));
   await page.locator('#product-readiness-check').click();await page.waitForFunction(()=>document.querySelector('#product-readiness-result')?.textContent.includes('could not be checked'));
   check(!(await page.locator('#catalogue-import-panel').textContent()).includes('DO-NOT-DISPLAY'),`${width}: malformed capability response is redacted`);
   await page.unroute('**'+PATH);
   let finish,started;const delayed=new Promise(r=>finish=r),pending=new Promise(r=>started=r);
   await page.route('**'+PATH,async route=>{started();await delayed;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(ready)});});
   await page.locator('#product-readiness-check').click();await pending;await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));finish();
   await page.waitForLoadState('networkidle');check(!await page.locator('#app-shell').isVisible(),`${width}: delayed result cannot reopen closed session`);
   await page.unroute('**'+PATH);await open();
   f.fake.states.get(state.workspace.id).users[0].role='admin';await page.locator('#product-readiness-check').click();await page.getByText('Signed in. Maintenance continues.',{exact:true}).waitFor();
   check(!await page.locator('#app-shell').isVisible(),`${width}: owner revocation closes view`);
   f.fake.states.get(state.workspace.id).users[0].role='owner';
   const port=f.server.address().port;await f.close();const closed=await maintenanceFixture({states:[state],env:{...env,[FLAG]:'disabled/v1'},port});
   try{await page.goto(f.base,{waitUntil:'networkidle'});await page.locator('#app-shell').waitFor({state:'visible'});check(await page.locator('#product-readiness-check').count()===0,`${width}: disabled flag hides button`);check(await page.evaluate(()=>localStorage.getItem('packsmart-saas-economics-v1'))==='preserve-synthetic-legacy',`${width}: legacy data untouched`);check(closed.calls.every(x=>x.method==='GET'),`${width}: closed server receives no mutations`);check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width}: no horizontal page overflow`);}finally{await context.close();await bounded(closed.close(),'closed fixture teardown');}
   check(f.calls.every(x=>x.method==='GET'),`${width}: enabled fixture receives no mutations`);
  }finally{await context.close();await f.close();}
 }
 // A real browser timer closes the UI without a reload, server poll or operator click.
 for(const width of [390,1200]){
  const now=Date.now(),expiry=new Date(now+20000).toISOString(),state=ownerState('packsmart-solutions');
  const f=await maintenanceFixture({states:[state],env:{...env,RUNVARA_QUIET_OWNER_PRODUCT_READINESS_EXPIRES_AT:expiry}});
  const context=await browser.newContext({viewport:{width,height:900}});
  try{
   await context.addCookies([{name:'packsmart_session',value:createSessionToken({userId:state.users[0].id,workspaceId:state.workspace.id,email:state.users[0].email,role:'owner',sessionVersion:1},SECRET),url:f.base,httpOnly:true,sameSite:'Strict'}]);
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.clock.install({time:new Date(now)});
   await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==f.base){external++;return route.abort();}requests.push({method:route.request().method(),path:u.pathname});return route.continue();});
   await page.goto(f.base,{waitUntil:'networkidle'});await page.locator('#app-shell').waitFor({state:'visible'});
   if(width<600)await page.locator('#mobile-menu').click();await page.locator('#main-nav [data-view="channels"]').click();
   check((await page.locator('#catalogue-import-panel').textContent()).includes(expiry),`${width}: absolute readiness deadline displayed`);
   const source=syntheticBundleFixture(now),ready=createOwnerProductReadinessProjection(source.policy)(state.workspace.id,source.products,source.context,{now});
   let release,entered,deliveries=0;const held=new Promise(r=>release=r),seen=new Promise(r=>entered=r);
   await page.route('**'+PATH,async route=>{deliveries++;entered();await held;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(ready)});});
   await page.locator('#product-readiness-check').click();await seen;await page.clock.fastForward(20001);
   check(await page.locator('#product-readiness-check').isDisabled(),`${width}: automatic expiry disables an in-flight check`);
   check((await page.locator('#product-readiness-result').textContent()).includes('window has expired'),`${width}: expired state replaces pending message`);
   const finished=page.waitForEvent('requestfinished',{predicate:r=>new URL(r.url()).pathname===PATH});release();await finished;
   await page.evaluate(()=>new Promise(r=>queueMicrotask(r)));
   check(!(await page.locator('#product-readiness-result').textContent()).includes('15 products'),`${width}: late success after expiry is discarded`);
   await page.locator('#product-readiness-check').evaluate(button=>button.dispatchEvent(new Event('click')));
   check(deliveries===1,`${width}: expired click cannot send another request`);
   await page.clock.setFixedTime(new Date(now-1000));
   await page.locator('#product-readiness-check').evaluate(button=>button.dispatchEvent(new Event('click')));
   check(deliveries===1&&await page.locator('#product-readiness-check').isDisabled(),`${width}: clock rollback cannot reopen the expired UI`);
   await page.unroute('**'+PATH);
   await page.route('**/api/bootstrap',async route=>{const response=await route.fetch(),payload=await response.json();delete payload.productReadinessExpiresAt;await route.fulfill({response,json:payload});});
   await page.reload({waitUntil:'networkidle'});await page.locator('#app-shell').waitFor({state:'visible'});
   check(await page.locator('#product-readiness-check').count()===0,`${width}: missing expiry metadata never exposes a usable button`);
   await page.unroute('**/api/bootstrap');
   for(const remaining of [undefined,-1,300001,1.5,'20000']){
    await page.route('**/api/bootstrap',async route=>{const response=await route.fetch(),payload=await response.json();assert.equal(payload.productReadinessAvailable,true);payload.productReadinessRemainingMs=remaining;await route.fulfill({response,json:payload});});
    await page.reload({waitUntil:'networkidle'});await page.locator('#app-shell').waitFor({state:'visible'});
    check(await page.locator('#product-readiness-check').count()===0,`${width}: invalid or missing remaining budget ${remaining} hides action`);
    await page.unroute('**/api/bootstrap');
   }
   check(f.calls.every(x=>x.method==='GET'),`${width}: expiry fixture receives no mutations`);
  }finally{await context.close();await f.close();}
 }
 // Real elapsed-time regression: the server finishes before expiry, but its
 // response reaches a wall-clock-skewed browser only after the server closes.
 for(const skew of [-60000,60000]){
  const now=Date.now(),deadline=now+8000,expiry=new Date(deadline).toISOString(),state=ownerState('packsmart-solutions');
  const f=await maintenanceFixture({states:[state],env:{...env,RUNVARA_QUIET_OWNER_PRODUCT_READINESS_EXPIRES_AT:expiry}});
  const context=await browser.newContext({viewport:{width:1200,height:900}});let release;
  try{
   await context.addCookies([{name:'packsmart_session',value:createSessionToken({userId:state.users[0].id,workspaceId:state.workspace.id,email:state.users[0].email,role:'owner',sessionVersion:1},SECRET),url:f.base,httpOnly:true,sameSite:'Strict'}]);
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.clock.install({time:new Date(now+skew)});
   await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==f.base){external++;return route.abort();}requests.push({method:route.request().method(),path:u.pathname});return route.continue();});
   let entered,status,responseAt,deliveries=0;const held=new Promise(r=>release=r),seen=new Promise(r=>entered=r);
   await page.route('**'+PATH,async route=>{deliveries++;const response=await route.fetch();status=response.status();responseAt=Date.now();entered();await held;await route.fulfill({response});});
   await page.goto(f.base,{waitUntil:'networkidle'});await page.locator('#app-shell').waitFor({state:'visible'});await page.locator('#main-nav [data-view="channels"]').click();
   check(await page.locator('#product-readiness-check').isEnabled(),`${skew}: skewed browser admits the still-valid read`);
   await page.locator('#product-readiness-check').click();await bounded(seen,'skewed readiness response');
   check(status===200&&responseAt<deadline,`${skew}: actual server read completed before expiry`);
   await delay(Math.max(0,deadline-Date.now()+120));
   check((await f.request('/api/health')).payload.quietOwnerProductReadiness===false,`${skew}: actual server is closed before response delivery`);
   const finished=page.waitForEvent('requestfinished',{predicate:r=>new URL(r.url()).pathname===PATH});release();await finished;
   await bounded(page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))),'skewed UI frame');
   const observation={skew,expiry,responseAt:new Date(responseAt).toISOString(),observedAt:new Date().toISOString(),clientNow:await page.evaluate(()=>new Date().toISOString()),buttonEnabled:await page.locator('#product-readiness-check').isEnabled(),text:await page.locator('#product-readiness-result').textContent(),deliveries};
   await fs.writeFile(path.join(output,`clock-skew-${skew}.json`),JSON.stringify(observation,null,2));
   check(!observation.buttonEnabled,`${skew}: button closes by server deadline despite device clock skew`);
   check(observation.text.includes('window has expired')&&!observation.text.includes('No complete import receipt'),`${skew}: late real response is discarded`);
   await page.locator('#product-readiness-check').evaluate(button=>button.dispatchEvent(new Event('click')));
   check(deliveries===1,`${skew}: closed window sends no second request`);
   check(f.calls.every(x=>x.method==='GET'),`${skew}: skew fixture makes no mutations`);
  }finally{release?.();await context.close();await f.close();}
 }
 // Delayed bootstrap itself must consume the original deadline, not issue a
 // fresh client countdown when the old response eventually arrives.
 {
  const now=Date.now(),deadline=now+6000,expiry=new Date(deadline).toISOString(),state=ownerState('packsmart-solutions');
  const f=await maintenanceFixture({states:[state],env:{...env,RUNVARA_QUIET_OWNER_PRODUCT_READINESS_EXPIRES_AT:expiry}}),context=await browser.newContext();
  try{
   await context.addCookies([{name:'packsmart_session',value:createSessionToken({userId:state.users[0].id,workspaceId:state.workspace.id,email:state.users[0].email,role:'owner',sessionVersion:1},SECRET),url:f.base,httpOnly:true,sameSite:'Strict'}]);
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.clock.install({time:new Date(now-60000)});
   await page.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==f.base){external++;return route.abort();}requests.push({method:route.request().method(),path:u.pathname});return route.continue();});
   await page.route('**/api/bootstrap',async route=>{const response=await route.fetch(),payload=await response.json();assert.equal(payload.productReadinessAvailable,true);await delay(Math.max(0,deadline-Date.now()+120));await route.fulfill({response,json:payload});});
   const prior=requests.filter(x=>x.path===PATH).length;
   await page.goto(f.base,{waitUntil:'networkidle'});await page.locator('#app-shell').waitFor({state:'visible'});await page.locator('#main-nav [data-view="channels"]').click();
   check((await f.request('/api/health')).payload.quietOwnerProductReadiness===false,'delayed bootstrap: real server has expired');
   check(await page.locator('#product-readiness-check').isDisabled(),'delayed bootstrap: no new countdown starts at receipt');
   check((await page.locator('#product-readiness-result').textContent()).includes('window has expired'),'delayed bootstrap: expired state is explicit');
   await page.locator('#product-readiness-check').evaluate(button=>button.dispatchEvent(new Event('click')));
   check(requests.filter(x=>x.path===PATH).length===prior,'delayed bootstrap: no readiness request sent');
   check(f.calls.every(x=>x.method==='GET'),'delayed bootstrap: no mutations');
  }finally{await context.close();await f.close();}
 }
 check(external===0,'no external browser traffic');check(errors.length===0,'no browser errors');check(requests.every(x=>x.method==='GET'),'all browser requests GET');
 check(!requests.some(x=>/migrate|refresh|sync|public\/support|shopify-catalogue/.test(x.path)),'no migration, token, import, sync or public support requests');
 const report={checks:results.length,results,externalRequests:external,errors,requests};await fs.writeFile(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
