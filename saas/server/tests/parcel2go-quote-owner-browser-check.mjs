// Existing application and real local HTTP/store, synthetic credentials/request mocks only.
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';import {chromium} from 'playwright';
import {fixture,savedState,ID,CLIENT,SECRET_VALUE,TOKEN} from './parcel2go-quote-owner-fixture.mjs';
import {PARCEL2GO_QUOTE_PATH as ROUTE} from '../lib/parcel2go-quote-owner.mjs';
const folder=path.resolve(process.env.P2G_BROWSER_EVIDENCE||'.p2g-quote-browser');await fs.mkdir(folder,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
let checks=0,external=0;const results=[],errors=[],check=(v,label)=>{assert.ok(v,label);checks++;};
try{for(const scenario of ['disabled','admin','success','double','cancel','lost response','timeout','revoked','expired','slow clock','shortened','navigate','navigation in-flight','storage blocked','refusal','320px']){
 const state=savedState();if(scenario==='admin')state.users[0].role='admin';
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const env={NODE_ENV:'test',APP_PUBLIC_URL:`http://127.0.0.1:${port}`};if(scenario==='disabled')env.RUNVARA_QUIET_PARCEL2GO_SANDBOX_QUOTE='disabled/v1';
 if(scenario==='expired'){env.RUNVARA_PARCEL2GO_QUOTE_OPENED_AT='2026-01-01T00:00:00.000Z';env.RUNVARA_PARCEL2GO_QUOTE_EXPIRES_AT='2026-01-01T00:05:00.000Z';}
 const f=await fixture(null,{state,env,port,provider:scenario==='navigation in-flight'?()=>{}:scenario==='refusal'?(_c,reply)=>reply({}, {status:403}):undefined});
 const context=await browser.newContext({viewport:{width:scenario==='320px'?320:1100,height:900}}),page=await context.newPage();await context.addCookies([{name:'packsmart_session',value:f.token,url:f.base,httpOnly:true,sameSite:'Strict'}]);
 let posts=0,dialogs=0,secretResponses=0;page.on('pageerror',e=>errors.push({scenario,message:e.message}));
 page.on('dialog',async d=>{dialogs++;check(d.message().includes('public-api-only'),'explicit scope');if(scenario==='cancel')await d.dismiss();else await d.accept();});
 if(scenario==='storage blocked')await context.addInitScript(()=>{Storage.prototype.setItem=()=>{throw Error('synthetic blocked');};});
 if(scenario==='slow clock')await context.addInitScript(()=>{Date.now=()=>new Date().getTime()-60000;});
 if(scenario==='timeout')await context.addInitScript(()=>{const timer=window.setTimeout;window.setTimeout=(fn,ms,...args)=>timer(fn,ms===20000?30:ms,...args);});
 await page.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url());if(u.origin!==f.base){external++;return route.abort();}
   if(u.pathname===ROUTE&&req.method()==='POST'){
     posts++;check(Object.keys(req.postDataJSON()).sort().join('|')==='confirmed|expectedRevision|requestId','no secret or parcel body');check(Boolean(req.headers()['x-csrf-token']),'csrf present');check(req.headers().origin===f.base,'same origin');
     if(scenario==='lost response'){await route.fetch();return route.abort();}
     if(scenario==='timeout'){const response=await route.fetch();await new Promise(r=>setTimeout(r,120));return route.fulfill({response}).catch(()=>{});}
   }
   if(scenario==='slow clock'&&u.pathname==='/api/bootstrap'){const response=await route.fetch(),body=await response.json();if(body.parcel2goSandboxQuote)body.parcel2goSandboxQuote.remainingMs=1;await new Promise(r=>setTimeout(r,50));return route.fulfill({response,json:body});}
   if(scenario==='shortened'&&u.pathname===ROUTE&&req.method()==='GET'){const response=await route.fetch(),body=await response.json();body.remainingMs=200;return route.fulfill({response,json:body});}
   return route.continue();
 });
 page.on('response',async r=>{if(new URL(r.url()).pathname.startsWith('/api/'))try{const b=await r.text();if([CLIENT,SECRET_VALUE,TOKEN].some(v=>b.includes(v)))secretResponses++;}catch{}});
 const channels=async()=>{if(scenario==='320px')await page.locator('#mobile-menu').click();await page.locator('[data-view="channels"]').first().click();};
 try{
   await page.goto(f.base);await page.waitForLoadState('networkidle');check(f.wire.calls.length===0,'load sends no provider request');
   if(scenario==='admin'){check(await page.locator('#p2g-quote-run').count()===0,'nonowner hidden');results.push({scenario,posts});continue;}
   await channels();if(scenario==='disabled'){check(await page.locator('#p2g-quote-run').count()===0,'disabled hidden');results.push({scenario,posts});continue;}
   await page.locator('#p2g-quote-run').waitFor();check(await page.locator('#p2g-client-secret').count()===0,'no credential entry during test');check(f.wire.calls.length===0,'mount sends no provider request');
   if(['expired','slow clock'].includes(scenario)){check(await page.locator('#p2g-quote-run').isDisabled(),'expired submit closed');results.push({scenario,posts});continue;}
   if(scenario==='320px')check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'320px no root overflow');
   await page.locator('#p2g-quote-confirm').check();
   if(scenario==='shortened'){await page.locator('#p2g-quote-status').click();await page.waitForFunction(()=>document.querySelector('#p2g-quote-confirm')?.disabled);check(posts===0,'shortened expiry no POST');check(await page.locator('#p2g-quote-run').isDisabled(),'shortened disabled');results.push({scenario,posts});continue;}
   if(scenario==='navigate'){await page.locator('[data-view="overview"]').first().click();await channels();check(!(await page.locator('#p2g-quote-confirm').isChecked()),'navigation clears consent');check(posts===0,'navigation no POST');results.push({scenario,posts});continue;}
   if(scenario==='revoked')f.fake.states.get(ID).users[0].sessionVersion++;
   if(scenario==='double')await page.locator('#p2g-quote-run').evaluate(e=>{e.click();e.click();});else await page.locator('#p2g-quote-run').click();
   if(['cancel','storage blocked'].includes(scenario)){check(posts===0,'cancel/tracking failure no POST');check(f.wire.calls.length===0,'no provider request');results.push({scenario,posts});continue;}
   if(scenario==='revoked'){await page.waitForFunction(()=>document.querySelector('#login-screen')?.classList.contains('hidden')===false||!document.querySelector('#p2g-quote-run'));check(f.wire.calls.length===0,'revocation no provider request');results.push({scenario,posts});continue;}
   if(scenario==='navigation in-flight'){
     await page.waitForFunction(()=>document.querySelector('#p2g-quote-result')?.textContent.includes('requested'));for(let i=0;i<200&&!f.wire.calls.length;i++)await new Promise(r=>setTimeout(r,5));check(f.wire.calls.length===1,'issuer started within bounded wait');
     await page.locator('[data-view="overview"]').first().click();await channels();check(await page.locator('#p2g-quote-run').isDisabled(),'navigation retained spent marker');
     for(let i=0;i<100&&!f.wire.calls[0].destroyed;i++)await new Promise(r=>setTimeout(r,10));check(f.wire.calls[0].destroyed,'navigation aborts in-flight issuer');check(f.wire.calls.length===1,'no quote after interruption');results.push({scenario,posts});continue;
   }
   await page.waitForFunction(()=>document.querySelector('#p2g-quote-result')?.textContent.match(/receipt is saved|unconfirmed/));check(posts===1,'one POST');check(await page.locator('#p2g-quote-run').isDisabled(),'repeated click closed');
   check(f.wire.calls.length===(scenario==='refusal'?1:2),'bounded source calls');
   if(['success','double','320px'].includes(scenario))check((await page.locator('#p2g-quote-prices').textContent()).includes('12.66'),'sanitized quote visible');
   await page.locator('#p2g-quote-status').click();await page.waitForFunction(()=>document.querySelector('#p2g-quote-status')?.disabled===false);check(posts===1,'status never resubmits');
   check(!(await page.locator('#p2g-quote-prices').textContent()).includes('12.66'),'GET cannot recover unsaved rates');
   await page.reload();await page.waitForLoadState('networkidle');await channels();check(await page.locator('#p2g-quote-run').isDisabled(),'reload no replay');check(secretResponses===0,'no secret response');
   const storage=await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]));check(![CLIENT,SECRET_VALUE,TOKEN].some(v=>storage.includes(v)),'no private browser storage');results.push({scenario,posts,providerCalls:f.wire.calls.length});
 }finally{await context.close();await f.close();}
}
check(external===0,'zero external browser traffic');check(errors.length===0,JSON.stringify(errors));await fs.writeFile(path.join(folder,'result.json'),JSON.stringify({checks,passed:checks,external,errors,results},null,2));console.log(JSON.stringify({checks,passed:checks,external,errors}));
}finally{await browser.close();}
