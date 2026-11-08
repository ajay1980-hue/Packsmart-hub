// Real existing application on localhost; synthetic identity/database/credentials.
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';import {chromium} from 'playwright';
import {ownerState,maintenanceFixture,SECRET} from './maintenance-login-fixture.mjs';
import {entryEnv,ID,CLIENT,VALUE} from './parcel2go-entry-fixture.mjs';import {createSessionToken} from '../lib/security.mjs';
import {PARCEL2GO_ENTRY_PATH as ROUTE} from '../lib/parcel2go-credential-entry.mjs';
const folder=path.resolve(process.env.P2G_BROWSER_EVIDENCE||'.p2g-browser-evidence');await fs.mkdir(folder,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
let checks=0,external=0;const results=[],errors=[];const check=(v,label)=>{assert.ok(v,label);checks++;};
try{for(const scenario of ['disabled','admin','success','double','cancel','lost response','timeout','revoked','expired','slow clock','shortened','navigate','storage blocked']){
  const state=ownerState(ID);if(scenario==='admin')state.users[0].role='admin';
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const env=entryEnv(state,{NODE_ENV:'test',APP_PUBLIC_URL:`http://127.0.0.1:${port}`});
  if(scenario==='disabled')env.RUNVARA_QUIET_PARCEL2GO_CREDENTIAL_ENTRY='disabled/v1';
  if(scenario==='expired'){env.RUNVARA_PARCEL2GO_ENTRY_OPENED_AT='2026-01-01T00:00:00.000Z';env.RUNVARA_PARCEL2GO_ENTRY_EXPIRES_AT='2026-01-01T00:05:00.000Z';}
  const f=await maintenanceFixture({states:[state],env,port}),context=await browser.newContext({viewport:{width:1100,height:900}}),page=await context.newPage();
  const token=createSessionToken({userId:state.users[0].id,workspaceId:ID,email:'synthetic@example.test',role:state.users[0].role,sessionVersion:1},SECRET);
  await context.addCookies([{name:'packsmart_session',value:token,url:f.base,httpOnly:true,sameSite:'Strict'}]);
  let posts=0,dialogs=0,secretResponses=0;page.on('pageerror',e=>errors.push({scenario,message:e.message}));
  page.on('dialog',async d=>{dialogs++;check(d.message().includes('No Parcel2Go request'),'confirmation scope');if(scenario==='cancel')await d.dismiss();else await d.accept();});
  if(scenario==='storage blocked')await context.addInitScript(()=>{Storage.prototype.setItem=()=>{throw Error('synthetic blocked');};});
  if(scenario==='slow clock')await context.addInitScript(()=>{Date.now=()=>new Date().getTime()-60000;});
  if(scenario==='timeout')await context.addInitScript(()=>{const timer=window.setTimeout;window.setTimeout=(fn,ms,...args)=>timer(fn,ms===20000?30:ms,...args);});
  await page.route('**/*',async route=>{
    const req=route.request(),u=new URL(req.url());if(u.origin!==f.base){external++;return route.abort();}
    if(u.pathname===ROUTE&&req.method()==='POST'){
      posts++;const b=req.postDataJSON();check(b.clientId===CLIENT&&b.clientSecret===VALUE,'only synthetic private values');check(Boolean(req.headers()['x-csrf-token']),'normal csrf present');check(req.headers().origin===f.base,'same origin');
      if(scenario==='lost response'){await route.fetch();return route.abort();}
      if(scenario==='timeout'){const response=await route.fetch();await new Promise(r=>setTimeout(r,120));return route.fulfill({response}).catch(()=>{});}
    }
    if(scenario==='slow clock'&&u.pathname==='/api/bootstrap'){
      const response=await route.fetch(),body=await response.json();if(body.parcel2goCredentialEntry)body.parcel2goCredentialEntry.remainingMs=1;
      await new Promise(r=>setTimeout(r,50));return route.fulfill({response,json:body});
    }
    if(scenario==='shortened'&&u.pathname===ROUTE&&req.method()==='GET'){
      const response=await route.fetch(),body=await response.json();body.remainingMs=500;return route.fulfill({response,json:body});
    }
    return route.continue();
  });
  page.on('response',async r=>{if(new URL(r.url()).pathname.startsWith('/api/')){try{const body=await r.text();if(body.includes(VALUE)||body.includes(CLIENT))secretResponses++;}catch{}}});
  try{
    await page.goto(f.base);await page.waitForLoadState('networkidle');
    if(scenario==='admin'){check(await page.locator('#p2g-client-secret').count()===0,'nonowner no entry');results.push({scenario,posts});continue;}
    await page.locator('[data-view="channels"]').first().click();
    if(scenario==='disabled'){check(await page.locator('#p2g-client-secret').count()===0,'off no fields');results.push({scenario,posts});continue;}
    await page.locator('#p2g-save').waitFor();
    if(['expired','slow clock'].includes(scenario)){check(await page.locator('#p2g-save').isDisabled(),'server-authoritative expiry');check(await page.locator('#p2g-client-secret').isDisabled(),'expired input closed');results.push({scenario,posts});continue;}
    check(await page.locator('#p2g-client-secret').getAttribute('type')==='password','masked private entry');
    await page.locator('#p2g-client-id').fill(CLIENT);await page.locator('#p2g-client-secret').fill(VALUE);await page.locator('#p2g-confirm').check();
    check(!(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]))).includes(VALUE),'no storage of entered secret');
    if(scenario==='shortened'){
      await page.locator('#p2g-status').click();await page.waitForFunction(()=>document.querySelector('#p2g-status')?.disabled===false);
      await page.locator('#p2g-client-secret').fill(VALUE);await page.waitForFunction(()=>document.querySelector('#p2g-client-secret')?.disabled===true);
      check(await page.locator('#p2g-client-secret').inputValue()==='','shortened deadline clears private value');check(posts===0,'expiry never submits');results.push({scenario,posts});continue;
    }
    if(scenario==='navigate'){
      await page.locator('[data-view="overview"]').first().click();await page.locator('[data-view="channels"]').first().click();
      check(await page.locator('#p2g-client-secret').inputValue()==='','navigation clears');check(posts===0,'navigation sends nothing');results.push({scenario,posts});continue;
    }
    if(scenario==='revoked')f.fake.states.get(ID).users[0].sessionVersion++;
    if(scenario==='double')await page.locator('#p2g-save').evaluate(e=>{e.click();e.click();});else await page.locator('#p2g-save').click();
    if(scenario==='cancel'){check(posts===0,'cancel sends nothing');check(dialogs===1,'one cancel confirmation');results.push({scenario,posts});continue;}
    if(scenario==='storage blocked'){check(posts===0,'blocked tracking sends nothing');check(await page.locator('#p2g-client-secret').inputValue()==='','blocked tracking clears');results.push({scenario,posts});continue;}
    if(scenario==='revoked'){await page.waitForFunction(()=>document.querySelector('#login-screen')?.classList.contains('hidden')===false||!document.querySelector('#p2g-client-secret'));check(!f.fake.states.get(ID).connections.some(c=>c.provider==='parcel2go'),'revocation no credential save');results.push({scenario,posts});continue;}
    await page.waitForFunction(()=>document.querySelector('#p2g-entry-result')?.textContent.match(/recorded|unconfirmed/));
    check(posts===1,'one save only');check(await page.locator('#p2g-client-secret').inputValue()==='','secret cleared after submission');check(await page.locator('#p2g-save').isDisabled(),'no repeated save');
    check(!(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]))).includes(VALUE),'no persisted secret');
    await page.locator('#p2g-status').click();await page.waitForFunction(()=>document.querySelector('#p2g-entry-result')?.textContent.includes('recorded'));
    check(posts===1,'status only reconciles');await page.reload();await page.waitForLoadState('networkidle');await page.locator('[data-view="channels"]').first().click();check(await page.locator('#p2g-save').isDisabled(),'reload does not replay');
    check(secretResponses===0,'responses contain no entered values');results.push({scenario,posts});
  }finally{await context.close();await f.close();}
}
check(external===0,'zero external browser traffic');check(errors.length===0,JSON.stringify(errors));
await fs.writeFile(path.join(folder,'result.json'),JSON.stringify({checks,passed:checks,external,errors,results},null,2));console.log(JSON.stringify({checks,passed:checks,external,errors}));
}finally{await browser.close();}
