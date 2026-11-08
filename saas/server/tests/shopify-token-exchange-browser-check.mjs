// Synthetic localhost-only acceptance. No real cookies, credentials or provider traffic.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {maintenanceFixture,SECRET} from './maintenance-login-fixture.mjs';
import {catalogueState,ID,DOMAIN} from './shopify-catalogue-import-fixture.mjs';
import {encryptCredentials,createSessionToken} from '../lib/security.mjs';
import {SHOPIFY_TOKEN_PATH,TOKEN_DESTINATION} from '../lib/shopify-token-exchange.mjs';
import {expiredState,alterCredentials,renewalEnv,KEY as RENEWAL_KEY,OLD as EXPIRED_TOKEN} from './shopify-token-renewal-fixture.mjs';

const folder=path.resolve(process.env.TOKEN_BROWSER_EVIDENCE || '.token-browser-evidence');await fs.mkdir(folder,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
const errors=[],events=[],results=[];let checks=0,external=0;
const check=(value,label)=>{assert.ok(value,label);checks++;};
const CLIENT='9df2fc397d3f5ac01b66a46442fd20f9',SECRET_VALUE='synthetic-client-secret-only',TOKEN='synthetic-issued-access-token';
const scopes='read_inventory,read_orders,read_products',secretPattern=new RegExp(CLIENT+'|'+SECRET_VALUE+'|'+TOKEN+'|'+RENEWAL_KEY+'|'+EXPIRED_TOKEN+'|encryptedCredentials|ciphertextDigest|storedCiphertextDigest');
async function fixture(scenario,width=1200){
 const renewal=scenario.startsWith('renew-');if(renewal)scenario=scenario.slice(6);
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const state=renewal?expiredState():catalogueState();if(!renewal)state.connections[0].encryptedCredentials=encryptCredentials({storeDomain:DOMAIN,clientId:CLIENT,clientSecret:SECRET_VALUE},SECRET);
 if(scenario==='ineligible')alterCredentials(state,c=>{c.expiresAt=Date.now()+3600000;c.issuedAt=c.expiresAt-86399000;});
 if(scenario==='admin')state.users[0].role='admin';
 if(scenario==='app-mismatch')state.connections[0].encryptedCredentials=encryptCredentials({storeDomain:DOMAIN,clientId:'f'.repeat(32),clientSecret:SECRET_VALUE},SECRET);
 const env={NODE_ENV:'test',APP_PUBLIC_URL:`http://127.0.0.1:${port}`,RUNVARA_QUIET_OWNER_WORKSPACE:'enabled/v1',RUNVARA_QUIET_SHOPIFY_TOKEN_EXCHANGE:scenario==='disabled'?'disabled/v1':'enabled/v1',
  RUNVARA_SHOPIFY_TOKEN_REQUEST_ID:randomUUID(),RUNVARA_SHOPIFY_TOKEN_EXPIRES_AT:new Date(Date.now()+300000).toISOString(),RUNVARA_SHOPIFY_TOKEN_EXPECTED_CLIENT_ID:CLIENT,RUNVARA_SHOPIFY_TOKEN_EXPECTED_SCOPES:scopes};
 if(renewal)Object.assign(env,renewalEnv(state,env),{RUNVARA_SHOPIFY_TOKEN_OPERATION:'renew_expired/v1',RUNVARA_SHOPIFY_TOKEN_PREVIOUS_REQUEST_ID:state.shopifyTokenExchanges[0].requestId});
 if(scenario==='expired')env.RUNVARA_SHOPIFY_TOKEN_EXPIRES_AT='2020-01-01T00:00:00.000Z';
 let calls=0,release=()=>{},startedResolve;const started=new Promise(r=>startedResolve=r),held=new Promise(r=>release=r);
 const f=await maintenanceFixture({states:[state],port,env,providerFetch:async(url,options)=>{
  assert.equal(url,TOKEN_DESTINATION);assert.equal(options.method,'POST');calls++;startedResolve();
  if(['double','late'].includes(scenario))await held;
  if(scenario==='provider-unknown')throw new Error(SECRET_VALUE);
  return Response.json({access_token:TOKEN,scope:scopes,expires_in:86399});
 }});
 const context=await browser.newContext({viewport:{width,height:900}});
 await context.addCookies([{name:'packsmart_session',value:createSessionToken({userId:state.users[0].id,workspaceId:ID,email:'synthetic@example.test',role:state.users[0].role,sessionVersion:1},SECRET),url:f.base,httpOnly:true,sameSite:'Strict'}]);
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 let confirmations=0;page.on('dialog',async dialog=>{assert.equal(dialog.type(),'confirm');assert.match(dialog.message(),/order-read capabilities/);assert.match(dialog.message(),/No import or order read/);confirmations++;if(scenario==='cancel')await dialog.dismiss();else await dialog.accept();});
 if(['clock-expiry','session-expiry'].includes(scenario))await page.clock.install();
 if(scenario==='storage-blocked')await context.addInitScript(()=>{Storage.prototype.getItem=()=>{throw new Error('Synthetic storage unavailable');};});
 await page.route('**/*',async route=>{
  const q=route.request(),u=new URL(q.url());if(u.origin!==f.base){external++;return route.abort();}
  events.push({scenario,method:q.method(),path:u.pathname});
  if(u.pathname===SHOPIFY_TOKEN_PATH && q.method()==='POST'){
   const body=q.postDataJSON();assert.deepEqual(Object.keys(body).sort(),['expectedRevision','requestId']);assert.equal(body.requestId,env.RUNVARA_SHOPIFY_TOKEN_REQUEST_ID);
   assert.ok(q.headers()['x-csrf-token']);assert.doesNotMatch(q.postData(),secretPattern);
   if(scenario==='lost-response'){await route.fetch();return route.abort();}
   if(scenario==='invalid-result'){await route.fetch();return route.fulfill({json:{error:SECRET_VALUE,access_token:TOKEN}});}
   if(scenario==='status-confusion'){const response=await route.fetch(),json=await response.json();json.operation='initial/v1';json.previousRequestId=null;return route.fulfill({response,json});}
  }
  if(u.pathname==='/api/bootstrap' && ['malformed','malformed-app','malformed-scopes','malformed-operation','malformed-prior','session-expiry'].includes(scenario)){
   const response=await route.fetch(),json=await response.json();
   if(scenario==='malformed')json.shopifyTokenExchange.domain='foreign.myshopify.com';
   if(scenario==='malformed-app')json.shopifyTokenExchange.appId='gid://shopify/App/999';
   if(scenario==='malformed-scopes')json.shopifyTokenExchange.approvedScopes=['read_inventory','read_products'];
   if(scenario==='malformed-operation')json.shopifyTokenExchange.operation='auto-renew';
   if(scenario==='malformed-prior')json.shopifyTokenExchange.previousRequestId=json.shopifyTokenExchange.requestId;
   return route.fulfill({response,json});
  }
  if(u.pathname==='/api/auth/session' && scenario==='session-expiry'){
   const response=await route.fetch(),json=await response.json();json.expiresAt=new Date(Date.now()+60000).toISOString();return route.fulfill({response,json});
  }
  return route.continue();
 });
 const open=async()=>{await page.goto(f.base,{waitUntil:'networkidle'});if(scenario==='admin')return;
  await page.locator('#app-shell').waitFor({state:'visible'});if(width<900)await page.locator('#mobile-menu').click();await page.locator('#main-nav [data-view="channels"]').click();};
 return {...f,page,context,state,env,started,release,open,renewal,confirmations:()=>confirmations,providerCalls:()=>calls,cleanup:async()=>{release();await context.close();await f.close();}};
}
try{
 for(const [scenarioName,width] of [['success',390],['success',1200],...['app-mismatch','disabled','expired','malformed','malformed-app','malformed-scopes','storage-blocked','admin','double','provider-unknown','lost-response','invalid-result','clock-expiry','session-expiry','revoked','late','renew-success','renew-disabled','renew-expired','renew-admin','renew-cancel','renew-double','renew-revoked','renew-provider-unknown','renew-lost-response','renew-ineligible','renew-status-confusion','renew-malformed-operation','renew-malformed-prior'].map(s=>[s,1200])]){
  const scenario=scenarioName.replace(/^renew-/,''),f=await fixture(scenarioName,width),begin=checks;const page=f.page;const start=page.locator('#shopify-token-exchange-start'),status=page.locator('#shopify-token-exchange-status');
  try{
   const before=structuredClone(f.fake.states.get(ID));await f.open();
   check(f.providerCalls()===0,scenario+': no automatic provider call');
   check(f.calls.every(c=>c.method==='GET'),scenario+': opening has no persistence');
   if(scenario==='admin'){check(await start.count()===0,'admin cannot see setup');check(await page.locator('#app-shell').isHidden(),'admin has no owner dashboard');continue;}
   check(await page.locator('#sync-shopify').isDisabled(),'legacy refresh remains disabled');check(await page.locator('#sync-all-channels').isDisabled(),'broad sync remains disabled');
   check(await page.locator('#catalogue-import-start').count()===0,'no simultaneous catalogue action');
   if(['disabled','malformed','malformed-app','malformed-scopes','malformed-operation','malformed-prior'].includes(scenario)){check(await start.count()===0,scenario+': no action');continue;}
   check(await start.innerText()===(f.renewal?'Renew expired Shopify access once':'Refresh Shopify access once'),'action clearly reuses existing connection');check((await page.locator('#shopify-token-exchange-panel').innerText()).includes('Opening this dashboard exchanges no token and starts no import or order action.'),'opening has no implied action or order permission');
   if(['expired','storage-blocked'].includes(scenario)){check(await start.isDisabled(),scenario+': action disabled');continue;}
   check(await start.isEnabled(),'strict-owner explicit action available');
   if(scenario==='cancel'){await start.click();check(f.confirmations()===1,'renewal confirmation shown');check(f.providerCalls()===0&&f.calls.every(c=>c.method==='GET'),'cancel sends nothing');check(await start.isEnabled(),'cancel consumes no attempt');continue;}
   if(scenario==='ineligible'){await start.click();await page.locator('#shopify-token-exchange-result').filter({hasText:'Outcome needs reconciliation'}).waitFor();check(f.providerCalls()===0&&f.calls.every(c=>c.method==='GET'),'usable grant refused before reservation');check(await start.isDisabled(),'rejected browser attempt stays spent');continue;}
   if(scenario==='clock-expiry'){
    await page.clock.fastForward(301000);check(await start.isDisabled(),'timer disables expired permit');
    await page.clock.setFixedTime(new Date(Date.now()-100000));await status.click();await page.locator('#shopify-token-exchange-result').waitFor();
    check(await start.isDisabled(),'backward browser clock cannot reopen observed expiry');check(f.providerCalls()===0,'expiry makes no token call');continue;
   }
   if(scenario==='session-expiry'){await page.clock.fastForward(61000);await page.locator('#app-shell').waitFor({state:'hidden'});check(await page.locator('#app-shell').isHidden(),'session expiry closes controls');check(f.providerCalls()===0,'expired session makes no token call');continue;}
   if(scenario==='revoked'){
    f.fake.states.get(ID).users[0].sessionVersion++;await start.click();await page.locator('#app-shell').waitFor({state:'hidden'});
    check(await page.locator('#app-shell').isHidden(),'revocation closes owner view');check(f.providerCalls()===0,'revoked owner cannot exchange');check(f.calls.every(c=>c.method==='GET'),'revoked owner has no writes');continue;
   }
   if(scenario==='app-mismatch'){
    await start.click();await page.locator('#shopify-token-exchange-result').filter({hasText:'Outcome needs reconciliation'}).waitFor();
    check(f.providerCalls()===0,'mismatched app makes no issuer call');check(f.calls.every(c=>c.method==='GET'),'mismatched app makes no reservation or write');
    await status.click();await page.locator('#shopify-token-exchange-result').filter({hasText:'Status checked without repeating'}).waitFor();
    check(await start.isDisabled(),'mismatch cannot be reset by status');check((await page.locator('#shopify-token-exchange-panel').innerText()).includes('not matched; action blocked'),'safe mismatch status visible');
    assert.doesNotMatch(await page.locator('#app-shell').innerText(),secretPattern);checks++;continue;
   }
   if(['double','late'].includes(scenario)){
    await start.evaluate(el=>{el.click();el.click();});await f.started;
    check(await start.isDisabled(),'pending action disabled');check(await status.isDisabled(),'pending read action disabled');
    if(scenario==='late'){await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));f.release();await page.waitForLoadState('networkidle');check(await page.locator('#app-shell').isHidden(),'late response cannot reopen closed view');check(f.providerCalls()===1,'no late replay');continue;}
    f.release();
   }else await start.click();
   await page.locator('#shopify-token-exchange-result').filter({hasText:/saved encrypted|Outcome needs reconciliation/}).waitFor();
   check(await start.isDisabled(),'attempt stays disabled after outcome');check(f.providerCalls()===1,'one synthetic exchange');
   assert.doesNotMatch(await page.locator('#app-shell').innerText(),secretPattern);checks++;
   await status.click();await page.locator('#shopify-token-exchange-result').filter({hasText:'Status checked without repeating'}).waitFor();
   check(f.providerCalls()===1,'read result never replays');check(await start.isDisabled(),'result read cannot reset attempt');
   check((await page.locator('#shopify-token-exchange-result').innerText()).includes(scenario==='provider-unknown'?'Outcome needs reconciliation':'saved encrypted'),'stored versus unresolved result shown');
   for(const key of ['products','orders','users','connectionSettings','automations','autopilot','agentOps'])assert.deepEqual(f.fake.states.get(ID)[key],before[key],key);checks++;
   await page.reload({waitUntil:'networkidle'});await page.locator('#app-shell').waitFor({state:'visible'});
   if(width<900)await page.locator('#mobile-menu').click();await page.locator('#main-nav [data-view="channels"]').click();check(await start.isDisabled(),'reload preserves spent request');
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'setup has no horizontal overflow');
   check(f.server.packsmart.scheduler.status.lastTickAt===null && f.server.packsmart.agentOps.status.lastTickAt===null,'workers remain stopped');
  }finally{results.push({scenario:scenarioName,width,checks:checks-begin,syntheticProviderCalls:f.providerCalls(),confirmations:f.confirmations()});await f.cleanup();}
 }
 assert.deepEqual(errors,[]);check(external===0,'zero external browser traffic');check(events.filter(e=>e.method==='POST').every(e=>e.path===SHOPIFY_TOKEN_PATH),'only exact setup POST used');
 const result={checks,errors,external,syntheticOnly:true,results,posts:events.filter(e=>e.method==='POST')};await fs.writeFile(path.join(folder,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
