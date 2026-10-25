// Full local app with real HTTP/auth/store code and synthetic RPC/provider
// transport. Fresh browser context; no existing profile or external requests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { creativeApiFixture } from './quiet-creative-api-fixture.mjs';
import { maintenanceFixture } from './maintenance-login-fixture.mjs';
import { CREATIVE_PILOT_BASE } from '../lib/quiet-creative-pilot.mjs';
const output=path.resolve(process.env.RUNVARA_CREATIVE_BROWSER_EVIDENCE||path.join(os.tmpdir(),'runvara-quiet-creative-browser'));
await fs.mkdir(output,{recursive:true});let browser,external=0;const cases=[],captures=[];
try{
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
 for(const width of [320,390,1200]){
  const cleanup=[],f=await creativeApiFixture({after:fn=>cleanup.push(fn)}),context=await browser.newContext({viewport:{width,height:950},reducedMotion:'reduce'});
  try{
   const page=await context.newPage(),calls=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==f.base){external++;return route.abort();}
    if(url.pathname.startsWith('/api/')){calls.push({path:url.pathname,method:req.method()});const r=await f.request(url.pathname+url.search,{method:req.method(),...(req.postData()?{body:req.postData()}:{}),...f.auth});return route.fulfill({status:r.status,contentType:'application/json',body:JSON.stringify(r.payload)});}
    return route.continue();
   });
   const panel=page.locator('#maintenance-creative-pilot'),button=op=>panel.locator('[data-creative-pilot="'+op+'"]');
   await page.goto(f.base,{waitUntil:'networkidle'});await panel.waitFor();assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/auth/session');
   assert.equal(await page.locator('#app-shell').isVisible(),false);assert.equal(await button('submit').isDisabled(),true);
   await button('review').click();await button('prepare').waitFor();await page.waitForFunction(()=>!document.querySelector('[data-creative-pilot="prepare"]').disabled);
   await button('prepare').click();await page.waitForFunction(()=>!document.querySelector('[data-creative-pilot="approved"]').disabled);
   assert.equal(f.providerCalls.length,0);
   for(const scale of [100,200]){await page.evaluate(v=>document.documentElement.style.fontSize=v+'%',scale);await panel.scrollIntoViewIfNeeded();const file=`maintenance-runway-${width}-${scale}.png`;await page.screenshot({path:path.join(output,file),fullPage:true});captures.push(file);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
   await button('approved').click();await page.waitForFunction(()=>!document.querySelector('[data-creative-pilot="submit"]').disabled);await button('submit').click();
   await page.waitForFunction(()=>document.querySelector('#maintenance-creative-pilot').textContent.includes('task-synthetic'));assert.equal(f.providerCalls.length,1);
   await page.reload({waitUntil:'networkidle'});await panel.waitFor();assert.equal(f.providerCalls.length,1);assert.equal(await button('submit').isDisabled(),true);assert.equal(await button('observe').isDisabled(),true);
   await button('review').click();await page.waitForFunction(()=>!document.querySelector('[data-creative-pilot="observe"]').disabled);await button('observe').click();await page.waitForFunction(()=>!document.querySelector('[data-creative-pilot="review"]').disabled);
   assert.equal(f.providerCalls.filter(c=>c.method==='POST').length,1);assert.equal(f.providerCalls.filter(c=>c.method==='GET').length,1);
   const final=`maintenance-runway-known-${width}.png`;await page.screenshot({path:path.join(output,final),fullPage:true});captures.push(final);
   const saved=structuredClone(f.fake.states.get('alpha')),port=f.server.address().port;await f.close();
   const closed=await maintenanceFixture({states:[saved],port,env:{...f.config,RUNVARA_QUIET_CREATIVE_PILOT:'disabled/v1'}});cleanup.push(closed.close);
   await page.reload({waitUntil:'networkidle'});assert.equal(await panel.count(),0);assert.equal(await page.locator('#loading-screen h1').textContent(),'Signed in. Maintenance continues.');
   assert.deepEqual(closed.fake.states.get('alpha'),saved);assert.ok(closed.calls.every(c=>c.method==='GET'));
   assert.ok(calls.every(c=>c.path==='/api/auth/session'||c.path.startsWith(CREATIVE_PILOT_BASE)));
   assert.equal(f.server.packsmart.scheduler.status.lastTickAt,null);assert.equal(f.server.packsmart.agentOps.status.lastTickAt,null);assert.deepEqual(errors,[]);
   cases.push({width,calls,providerPosts:1,knownTaskReads:1,noAutomaticReplay:true,workersOff:true,closedWithoutWrites:true,errors});
  }finally{await context.close();for(const close of cleanup)await close();}
 }
 assert.equal(external,0);await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,cases,captures,external,limits:['Synthetic accounts, prices and provider results','No hosted/provider acceptance']},null,2));console.log(JSON.stringify({passed:true,cases:cases.length,captures:captures.length,external}));
}finally{await browser?.close();}
