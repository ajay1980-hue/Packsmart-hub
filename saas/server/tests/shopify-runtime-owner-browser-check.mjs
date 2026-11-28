// Actual local app/server, synthetic identities and mocked database/Shopify only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {runtimeOwnerFixture,BASE,ID,secretPattern} from './shopify-runtime-owner-fixture.mjs';
import {expiredState,tokenResponse} from './shopify-token-renewal-fixture.mjs';
import {PASSWORD} from './maintenance-login-fixture.mjs';
const folder=path.resolve(process.env.RUNTIME_OWNER_BROWSER_EVIDENCE||'.runtime-owner-browser');await fs.mkdir(folder,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
let checks=0,external=0;const scenarios=[],errors=[];
const check=(value,label)=>{assert.ok(value,label);checks++;};
try{
 for(const [scenario,width] of [['success',390],['success',1200],...['off','admin','cancel','double','unknown','lost-approval','lost-run','lost-close','missing-approval','missing-run','missing-close','malformed-status','expiry-slow-clock','revoked','navigate','read-review-error','read-status-error','read-approved-error','lost-run-read-error'].map(s=>[s,1200])]){
  const startChecks=checks,probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const state=expiredState({legacy:false});for(const p of state.products){p.image='';for(const v of p.variants||[])v.image='';}if(scenario==='admin')state.users[0].role='admin';
  let release=()=>{},sent;const pending=new Promise(r=>sent=r),held=new Promise(r=>release=r);
  const f=await runtimeOwnerFixture(null,{state,port,env:{NODE_ENV:'test',APP_PUBLIC_URL:`http://127.0.0.1:${port}`,RUNVARA_OWNER_SHOPIFY_RUNTIME_RENEWAL:scenario==='off'?'disabled/v1':'enabled/v1'},issuer:async()=>{
    sent();if(['double','navigate'].includes(scenario))await held;if(scenario==='unknown')throw Error('synthetic issuer unavailable');return tokenResponse();
  }});
  const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),posts=[];
  page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>scenario==='cancel'?d.dismiss():d.accept());
  if(scenario==='expiry-slow-clock'){await page.clock.install();await page.clock.setFixedTime(new Date(Date.now()-60000));}
  if(!(scenario==='success'&&width===390))await context.addCookies([{name:'packsmart_session',value:f.token,url:f.base,httpOnly:true,sameSite:'Strict'}]);
  let statusReads=0,lossObserved=false;
  await page.route('**/*',async route=>{
    const request=route.request(),u=new URL(request.url());if(u.origin!==f.base){external++;return route.abort();}
    if(request.method()==='POST'){posts.push(u.pathname);if(u.pathname.startsWith(BASE))check(!secretPattern.test(request.postData()||''),'no credential fields in browser mutation');}
    if(scenario==='read-review-error'&&u.pathname===BASE+'/review'&&!lossObserved){lossObserved=true;return route.abort();}
    if(['read-status-error','read-approved-error'].includes(scenario)&&u.pathname===BASE+'/status'&&!lossObserved){lossObserved=true;return route.abort();}
    const lost=scenario==='lost-run-read-error'?'run':scenario.startsWith('lost-')?scenario.slice(5):scenario.startsWith('missing-')?scenario.slice(8):null;
    if(lost&&u.pathname===BASE+'/'+(lost==='approval'?'approve':lost)&&request.method()==='POST'){await route.fetch();lossObserved=true;return route.abort();}
    if(scenario==='lost-run-read-error'&&lossObserved&&u.pathname===BASE+'/status'&&++statusReads===1)return route.abort();
    if(scenario.startsWith('missing-')&&lossObserved&&u.pathname===BASE+'/status'&&++statusReads===1){const r=await route.fetch(),s=await r.json();return route.fulfill({json:{...s,state:'ready',canReview:true,canRun:false,canClose:false,terminal:false,approval:null,outcome:'none'}});}
    if(scenario==='malformed-status'&&u.pathname===BASE+'/status'){await route.fetch();return route.fulfill({json:{secret:'synthetic-private-should-not-render',canRun:true}});}
    return route.continue();
  });
  const button=id=>page.locator('#runtime-renewal-'+id),panel=page.locator('#shopify-runtime-panel');
  async function channels(){if(width<900)await page.locator('#mobile-menu').click();await page.locator('#main-nav [data-view="channels"]').click();}
  async function reviewed(){await button('review').click();await button('approve').waitFor();await page.waitForFunction(()=>!document.querySelector('#runtime-renewal-approve')?.disabled);}
  async function approved(){await reviewed();await button('approve').click();await page.waitForFunction(()=>!document.querySelector('#runtime-renewal-run')?.disabled);}
  async function missing(){
    await button('check').click();await button('result').filter({hasText:'does not resolve'}).waitFor();
    check(await button('review').isDisabled()&&await button('run').isDisabled()&&await button('stop').isDisabled(),'absent read never clears uncertainty or enables retry');
    check(await page.evaluate(()=>Object.keys(sessionStorage).some(k=>k.startsWith('runvara-runtime-renewal:'))),'pending marker retained after absent read');
    await page.reload({waitUntil:'networkidle'});await page.locator('#app-shell').waitFor({state:'visible'});await channels();
    check(await button('review').isDisabled(),'reload retains stop after absent read');await button('check').click();
    await button('result').filter({hasText:/Saved result checked|saved encrypted/}).waitFor();
  }
  try{
    await page.goto(f.base,{waitUntil:'networkidle'});
    if(scenario==='success'&&width===390){await page.locator('#login-email').fill(state.users[0].email);await page.locator('#login-password').fill(PASSWORD);await page.locator('#login-form button[type="submit"]').click();}
    if(scenario==='admin'){check(await page.locator('#app-shell').isHidden(),'admin excluded from owner dashboard');check(f.issued.length===0,'admin no issuer');continue;}
    await page.locator('#app-shell').waitFor({state:'visible'});await channels();check(await panel.isVisible(),'panel mounted in actual Connections');check(f.issued.length===0,'opening makes no issuer call');
    check(!posts.some(x=>x.startsWith(BASE)),'opening grants no permit');check(!f.fake.states.get(ID).shopifyRenewalApprovals,'opening no durable permit');
    check(await page.locator('#sync-shopify').isDisabled()&&await page.locator('#sync-all-channels').isDisabled(),'general refresh stays off');
    if(scenario==='off'){check((await panel.innerText()).includes('Off.'),'off distinguished from missing UI');check(await button('run').count()===0,'off has no action');continue;}
    check(await button('run').isDisabled(),'execution disabled before approval');check(await button('approve').isDisabled(),'approval disabled before review');
    if(scenario==='malformed-status'){await button('check').click();await button('result').filter({hasText:'could not be read'}).waitFor();check(!(await panel.innerText()).includes('synthetic-private-should-not-render'),'malformed DTO redacted');check(await button('run').isDisabled(),'malformed DTO cannot authorize');continue;}
    if(['read-review-error','read-status-error'].includes(scenario)){
      await button(scenario==='read-review-error'?'review':'check').click();await button('result').filter({hasText:'could not be read'}).waitFor();
      check(await page.evaluate(()=>!Object.keys(sessionStorage).some(k=>k.startsWith('runvara-runtime-renewal:'))),'read-only failure creates no write marker');
      check(await button('run').isDisabled(),'failed read cannot authorize execution');check(!posts.some(x=>x.startsWith(BASE)),'read-only failure submits no write');
      if(scenario==='read-review-error'){await reviewed();check(await button('approve').isEnabled(),'fresh review works after transient read failure');}
      else{await button('check').click();await button('result').filter({hasText:'Saved result checked'}).waitFor();check(await button('review').isEnabled(),'status recovers without false write uncertainty');}
      check(f.issued.length===0,'read recovery never dispatches issuer');continue;
    }
    if(['lost-approval','missing-approval'].includes(scenario)){await reviewed();await button('approve').click();await button('result').filter({hasText:'Stopped.'}).waitFor();check(f.issued.length===0,'lost approval no issuer');if(scenario==='missing-approval')await missing();else{await button('check').click();await button('result').filter({hasText:'Saved result checked'}).waitFor();}check(await button('run').isDisabled(),'uncertain approval stays stopped');check(await button('stop').isEnabled(),'confirmed durable approval can be closed');await button('stop').click();await button('result').filter({hasText:'Permission closed'}).waitFor();check(await page.evaluate(()=>!Object.keys(sessionStorage).some(k=>k.startsWith('runvara-runtime-renewal:'))),'confirmed unused close clears only UI marker');continue;}
    if(scenario==='cancel'){await reviewed();await button('approve').click();check(!f.fake.states.get(ID).shopifyRenewalApprovals,'cancel makes no approval');check(f.issued.length===0,'cancel no issuer');continue;}
    await approved();check(f.issued.length===0,'approval never executes');check(f.fake.states.get(ID).shopifyRenewalApprovals[0].status==='approved','approval durable');
    if(scenario==='read-approved-error'){
      await button('check').click();await button('result').filter({hasText:'could not be read'}).waitFor();
      check(await button('run').isDisabled(),'failed status removes stale execution control');check(await page.evaluate(()=>!Object.keys(sessionStorage).some(k=>k.startsWith('runvara-runtime-renewal:'))),'acknowledged approval plus read failure is not uncertain write');
      await button('check').click();await button('result').filter({hasText:'Saved result checked'}).waitFor();check(await button('run').isEnabled(),'fresh authoritative read restores acknowledged permission');
      await button('stop').click();await button('result').filter({hasText:'Permission closed'}).waitFor();check(f.issued.length===0,'status recovery and stop never issue token');continue;
    }
    if(scenario==='expiry-slow-clock'){await page.clock.fastForward(300001);check(await button('run').isDisabled(),'server remaining budget expires with slow wall clock');await page.clock.setFixedTime(new Date(Date.now()-120000));check(await button('run').isDisabled(),'backward wall clock never reopens');check(f.issued.length===0,'expiry no issuer');continue;}
    if(scenario==='revoked'){f.fake.states.get(ID).users[0].sessionVersion++;await button('run').click();await page.locator('#app-shell').waitFor({state:'hidden'});check(f.issued.length===0,'revoked session no issuer');continue;}
    if(['double','navigate'].includes(scenario)){await button('run').evaluate(e=>{e.click();e.click();});await pending;check(f.issued.length===1,'double click dispatches once');if(scenario==='navigate'){await page.locator('#main-nav [data-view="overview"]').click();release();await page.waitForLoadState('networkidle');await channels();await button('check').click();await button('result').filter({hasText:/uncertain|saved encrypted/}).waitFor();check(await button('run').isDisabled(),'navigation cannot replay');continue;}release();}
    else await button('run').click();
    await button('result').filter({hasText:/saved encrypted|Stopped\./}).waitFor();check(f.issued.length===1,'exactly one synthetic issuer');check(await button('run').isDisabled(),'no replay after outcome');
    if(scenario==='lost-run-read-error'){
      await button('check').click();await button('result').filter({hasText:'Stopped.'}).waitFor();check(await page.evaluate(()=>Object.keys(sessionStorage).some(k=>k.startsWith('runvara-runtime-renewal:'))),'read failure preserves true pending write marker');
      check(await button('run').isDisabled(),'true uncertainty never enables retry after read failure');check(f.issued.length===1,'failed reconciliation does not repeat issuer');
    }
    if(scenario==='missing-run')await missing();else {await button('check').click();await button('result').filter({hasText:/saved encrypted|uncertain/}).waitFor();}check(f.issued.length===1,'check never repeats issuer');
    if(['lost-run','missing-run','lost-run-read-error'].includes(scenario))check(await page.evaluate(()=>!Object.keys(sessionStorage).some(k=>k.startsWith('runvara-runtime-renewal:'))),'corroborated matching receipt clears only UI marker');
    check(!secretPattern.test(await panel.innerText()),'UI redacted');await button('stop').click();
    if(['lost-close','missing-close'].includes(scenario)){
      await button('result').filter({hasText:'Stopped.'}).waitFor();check(await button('stop').isDisabled(),'uncertain close is not repeated');
      if(scenario==='missing-close')await missing();else{await button('check').click();await button('result').filter({hasText:'Permission closed'}).waitFor();}
      check(await page.evaluate(()=>!Object.keys(sessionStorage).some(k=>k.startsWith('runvara-runtime-renewal:'))),'matching closed terminal result clears close marker');check(posts.filter(p=>p===BASE+'/close').length===1,'one close POST only');
    }else await button('result').filter({hasText:'Permission closed'}).waitFor();
    if(scenario==='unknown')check(await page.evaluate(()=>Object.keys(sessionStorage).some(k=>k.startsWith('runvara-runtime-renewal:'))),'unresolved issuer remains stopped after durable close');
    check(f.fake.states.get(ID).shopifyRenewalApprovals[0].status==='closed','closure durable');check(f.issued.length===1,'closure no issuer');
    await page.reload({waitUntil:'networkidle'});await page.locator('#app-shell').waitFor({state:'visible'});await channels();await button('check').click();await button('result').filter({hasText:/saved encrypted|uncertain/}).waitFor();check(await button('run').isDisabled(),'reload cannot replay');
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal overflow');
    check(f.server.packsmart.scheduler.status.lastTickAt===null&&f.server.packsmart.agentOps.status.lastTickAt===null,'workers stopped');
  }finally{scenarios.push({scenario,width,checks:checks-startChecks,issuerCalls:f.issued.length,posts});release();await context.close();await f.close();}
 }
 check(errors.length===0,'no page errors');check(external===0,'no external browser requests for synthetic blank-image fixtures');
}finally{await browser.close();await fs.writeFile(path.join(folder,'result.json'),JSON.stringify({checks,external,errors,scenarios},null,2));}
console.log(JSON.stringify({checks,external,errors,scenarios}));
