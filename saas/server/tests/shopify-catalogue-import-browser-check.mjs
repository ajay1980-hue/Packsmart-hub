import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {chromium} from 'playwright';
import {fixture,product,page as dataPage,response,ID} from './shopify-catalogue-import-fixture.mjs';
import {CATALOGUE_PATH} from '../lib/shopify-catalogue-import.mjs';
const folder=path.resolve(process.env.CATALOGUE_BROWSER_EVIDENCE || '.catalogue-browser-evidence');await fs.mkdir(folder,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
let checks=0,external=0;const failures=[],events=[];const check=(x,label)=>{assert.ok(x,label);checks++;};
try{
 for(const width of [390,1200]){
  const component=product(2,{productType:'Component'}),archived=product(3,{status:'ARCHIVED'}),bundle=product(4);bundle.variants.nodes[0].requiresComponents=true;
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const f=await fixture(null,{port,env:{NODE_ENV:'test',APP_PUBLIC_URL:`http://127.0.0.1:${port}`},providerFetch:()=>response(dataPage([product(1),component,archived,bundle]))});
  const context=await browser.newContext({viewport:{width,height:900}});
  await context.addCookies([{name:'packsmart_session',value:f.token,url:f.base,httpOnly:true,sameSite:'Strict'}]);
  const page=await context.newPage();page.on('pageerror',e=>failures.push(e.message));
  await page.route('**/*',r=>{const q=r.request(),u=new URL(q.url());if(u.origin!==f.base){external++;return r.abort();}events.push({method:q.method(),path:u.pathname});return r.continue();});
  try{
   await page.goto(f.base,{waitUntil:'networkidle'});await page.locator('#app-shell').waitFor({state:'visible'});
   if(width<900)await page.locator('#mobile-menu').click();await page.locator('#main-nav [data-view="channels"]').click();
   check(await page.locator('#catalogue-import-start').isEnabled(),'exact one-run button available');
   check(await page.locator('#sync-all-channels').isDisabled(),'broad sync blocked');check(await page.locator('#sync-shopify').isDisabled(),'legacy Shopify sync blocked');
   check(f.reads.length===0,'opening dashboard does not read provider');
   await page.locator('#catalogue-import-start').click();await page.getByText('Catalogue saved. Reload dashboard to view the current rows.',{exact:true}).waitFor();
   check(await page.locator('#catalogue-import-start').isDisabled(),'no repeat button after completion');check(f.reads.length===1,'one synthetic provider call');
   await page.locator('#catalogue-import-status').click();await page.getByText('Status checked. This did not repeat the import.',{exact:true}).waitFor();
   check(f.reads.length===1,'status read does not invoke provider');
   await page.reload({waitUntil:'networkidle'});await page.locator('#app-shell').waitFor({state:'visible'});
   if(width<900)await page.locator('#mobile-menu').click();await page.locator('#main-nav [data-view="channels"]').click();
   check(await page.locator('#catalogue-import-start').isDisabled(),'reload retains logical request outcome');
   await page.locator('#catalogue-import-panel summary').filter({hasText:'active source records'}).click();
   const text=await page.locator('#catalogue-import-panel').innerText();
   check(text.includes('12.30 GBP'),'original decimal plus source currency');check(text.includes('component')&&text.includes('bundle'),'component and bundle classifications visible');
   check(text.includes('archived source records (1)'),'archived separated');check(text.includes('retail eligibility not verified'),'no retail assumption');
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'responsive layout');
   await page.screenshot({path:path.join(folder,`catalogue-${width}.png`),fullPage:false});
   if(width<900)await page.locator('#mobile-menu').click();await page.locator('#main-nav [data-view="profit"]').click();
   check(await page.locator('#economics-body').innerText().then(t=>t.includes('12.30 GBP')),'existing product table uses source currency');
   check(await page.locator('#economics-body .economics-row').count()===2,'active view excludes internal component and archived rows');
   check(f.server.packsmart.scheduler.status.lastTickAt===null && f.server.packsmart.agentOps.status.lastTickAt===null,'workers never run');
   const record=f.fake.states.get(ID).shopifyCatalogueImports[0];check(record.status==='imported','durable completion');
  }finally{await context.close();await f.close();}
 }
 for(const scenario of ['disabled','expired','uncertain']){
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const env={NODE_ENV:'test',APP_PUBLIC_URL:`http://127.0.0.1:${port}`};
  if(scenario==='disabled')env.RUNVARA_QUIET_SHOPIFY_CATALOGUE='disabled/v1';
  if(scenario==='expired')env.RUNVARA_SHOPIFY_CATALOGUE_EXPIRES_AT='2020-01-01T00:00:00.000Z';
  const f=await fixture(null,{port,env,providerFetch:()=>{throw Error('Synthetic unknown source outcome');}});
  const context=await browser.newContext({viewport:{width:1200,height:900}});await context.addCookies([{name:'packsmart_session',value:f.token,url:f.base,httpOnly:true,sameSite:'Strict'}]);
  const page=await context.newPage();page.on('pageerror',e=>failures.push(e.message));
  await page.route('**/*',r=>{const q=r.request(),u=new URL(q.url());if(u.origin!==f.base){external++;return r.abort();}events.push({method:q.method(),path:u.pathname});return r.continue();});
  try{
   await page.goto(f.base,{waitUntil:'networkidle'});await page.locator('#app-shell').waitFor({state:'visible'});await page.locator('#main-nav [data-view="channels"]').click();
   if(scenario==='disabled'){check(await page.locator('#catalogue-import-start').count()===0,'default off has no import action');check(f.reads.length===0,'default off makes no provider calls');}
   if(scenario==='expired'){check(await page.locator('#catalogue-import-start').isDisabled(),'expired descriptor disabled');check(f.reads.length===0,'expired descriptor makes no provider calls');}
   if(scenario==='uncertain'){
    await page.locator('#catalogue-import-start').click();await page.getByText('Outcome needs reconciliation:',{exact:false}).waitFor();check(await page.locator('#catalogue-import-start').isDisabled(),'uncertain response cannot be resubmitted');
    await page.locator('#catalogue-import-status').click();await page.getByText('Status checked. This did not repeat the import.',{exact:true}).waitFor();
    check((await page.locator('#catalogue-import-panel').innerText()).includes('reserved'),'durable unresolved status shown');
    await context.clearCookies();await context.addCookies([{name:'packsmart_session',value:f.token,url:f.base,httpOnly:true,sameSite:'Strict'}]);await page.reload({waitUntil:'networkidle'});
    await page.locator('#main-nav [data-view="channels"]').click();check(await page.locator('#catalogue-import-start').isDisabled(),'session reentry keeps consumed logical request disabled');check(f.reads.length===1,'unknown outcome not replayed');
   }
  }finally{await context.close();await f.close();}
 }
 assert.deepEqual(failures,[]);check(external===0,'no external browser traffic');
 check(events.filter(e=>e.method==='POST').every(e=>e.path===CATALOGUE_PATH),'no migration, broad sync or unrelated browser mutation');
 const result={checks,failures,external,syntheticOnly:true,providerRequests:3,browserPosts:events.filter(e=>e.method==='POST')};await fs.writeFile(path.join(folder,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
