// Real local browser, full app, synthetic retained records and intercepted
// creative transport. No existing profile, credentials or external requests.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium} from 'playwright';
import {approvalFixture} from './approval-request-fixture.mjs';
const output=path.resolve(process.env.RUNVARA_CREATIVE_BROWSER_EVIDENCE||path.join(os.tmpdir(),'runvara-creative-allowance-browser'));
await fs.mkdir(output,{recursive:true});const cleanup=[],f=await approvalFixture({after:fn=>cleanup.push(fn),mock:{method(){}}});
const s=f.states.get('alpha');s.marketing.campaigns=[{id:'creative-campaign',status:'draft',product:{title:'Synthetic saved product',sku:'TEST',price:10},copy:{headline:'Exact local creative'},publish:{status:'not_requested',approvalRequired:true},creativeRequests:[{id:'creative-request',provider:'runway',status:'pending',kind:'product_video',formats:[]}]}];
const base='http://127.0.0.1:'+f.servers[0].address().port;let browser,external=0;const cases=[],captures=[];
const budget={limitMicros:'1000000',reservedMicros:'600000',heldMicros:'600000',spentMicros:'0',releasedMicros:'0',uncertainMicros:'600000',overrunMicros:'0',availableMicros:'400000',overrunBlocked:false};
const row=()=>({id:'creative-approval',approvalType:'creative_phase/v1',workspaceId:'alpha',campaignId:'creative-campaign',requestId:'creative-request',provider:'runway',phase:'generation',status:'approved',revision:2,currency:'USD',maxCostMicros:600000,expiresAt:new Date(Date.now()+60000).toISOString(),providerAccountId:'synthetic-account',accountBinding:'a'.repeat(64),inputDigest:'b'.repeat(64),priceRevision:'verified-price-v1',sourcePreview:JSON.stringify({headline:'Exact local creative',imageDigest:'c'.repeat(64)}),payloadPreview:JSON.stringify({recipe:'product_ad',duration:10}),tenantBudget:budget,accountBudget:budget,reservationStatus:'uncertain',accountingStatus:'uncertain',heldCostMicros:'600000',accountedCostMicros:null,upstreamId:'original-task'});
try{
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
 for(const width of [320,390,1200]){
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});try{
   const page=await context.newPage(),identity=f.auth(),calls=[],errors=[];let prepared=false;page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());if(url.origin!==base){external++;return route.abort();}
    if(url.pathname.endsWith('/allowance')){
     calls.push({method:req.method(),path:url.pathname,body:req.postDataJSON()});
     if(req.method()==='POST'){assert.equal(prepared,false);prepared=true;return route.abort('failed');}
     return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({allowance:prepared?[row()]:[]})});
    }
    if(url.pathname.startsWith('/api/')){assert.equal(req.method(),'GET');const response=await fetch(url,{headers:identity});return route.fulfill({status:response.status,contentType:'application/json',body:await response.text()});}
    return route.continue();
   });
   const open=async()=>{await page.locator('#app-shell').waitFor({state:'visible'});await page.locator('[data-view="marketing"]').first().evaluate(n=>n.click());await page.locator('.creative-allowance').waitFor({state:'visible'});};
   await page.goto(base);await open();assert.equal(calls.length,0);
   const panel=page.locator('.creative-allowance');await panel.getByRole('button',{name:'Review runway allowance'}).click();await panel.getByRole('button',{name:'Prepare exact phase review'}).click();await panel.getByText(/No automatic retry/).waitFor();assert.equal(calls.filter(c=>c.method==='POST').length,1);
   await page.reload();await open();assert.equal(calls.filter(c=>c.method==='POST').length,1);
   await panel.getByRole('button',{name:'Review runway allowance'}).click();await panel.getByText(/original-task/).waitFor();assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.equal(await panel.locator('[data-creative-prepare]').count(),0);
   await panel.locator('summary').click();
   for(const scale of [100,200]){await page.evaluate(v=>document.documentElement.style.fontSize=v+'%',scale);await panel.scrollIntoViewIfNeeded();const file=`creative-${width}-${scale}.png`;await page.screenshot({path:path.join(output,file),fullPage:true});captures.push(file);
    const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('body *')].filter(n=>n.getBoundingClientRect().right>innerWidth+1&&n.getBoundingClientRect().width>0).slice(-15).map(n=>({tag:n.tagName,id:n.id,class:n.className,text:n.textContent.slice(0,90),right:n.getBoundingClientRect().right}))}));assert.ok(layout.scroll<=layout.width+1,JSON.stringify({width,scale,layout}));}
   assert.deepEqual(errors,[]);cases.push({width,preparations:1,automaticRetries:0,originalTaskRecovered:true,calls,errors});
  }finally{await context.close();}
 }
 assert.equal(external,0);await fs.writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,cases,captures,external,providerCalls:f.calls.providers,limits:['Synthetic transport and account','Not hosted acceptance']},null,2));console.log(JSON.stringify({passed:true,cases:cases.length,captures:captures.length,external}));
}finally{await browser?.close();for(const close of cleanup)await close();}
