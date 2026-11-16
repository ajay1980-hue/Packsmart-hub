// Real Chromium and Node HTTP, synthetic storage/identity, intercepted provider.
// Test-only overlay; production server.mjs stays untouched and unmounted.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import net from 'node:net';
import {mock} from 'node:test';
import {chromium} from 'playwright';
import {createPacksmartServer} from '../server.mjs';
import {createWorkspaceLock} from '../lib/workspace-lock.mjs';
import {createSessionToken} from '../lib/security.mjs';
import {createParcel2GoOwnerQuoteSurface,PARCEL2GO_OWNER_QUOTE_PAGE,PARCEL2GO_OWNER_QUOTE_SCRIPT} from '../lib/parcel2go-owner-quote-surface.mjs';
import {PARCEL2GO_RECORDED_REVIEW_PATH} from '../lib/parcel2go-recorded-owner-review.mjs';
import {nativeHttpFixture} from './parcel2go-native-http-fixture.mjs';
import {fixture} from './parcel2go-live-integrated-fixture.mjs';
import {KEY,CLIENT,SECRET_VALUE,TOKEN} from './parcel2go-sandbox-fixture.mjs';

const ORIGIN='https://synthetic-owner-browser.example.test';
const artifacts=process.argv[2]??'/tmp/parcel2go-owner-browser';await mkdir(artifacts,{recursive:true});
const summaries=[],originalConnect=net.Socket.prototype.connect;let browser;
try{
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-background-networking']});
 for(const scenario of ['comparison','lost_quote']){
  let server,surface,context,page,mounted=false,port=0;
  assert.equal(net.Socket.prototype.connect,originalConnect,'Network guard restored between scenarios');
  const provider=nativeHttpFixture({mock},operation=>scenario==='lost_quote'&&operation==='quote'?{reset:true}:{});
  net.Socket.prototype.connect.mock.restore();
  // Playwright's proxy may connect only to this one loopback listener. Native
  // HTTPS is already intercepted, and all other server sockets/fetch fail.
  mock.method(net.Socket.prototype,'connect',function(...args){
   const first=Array.isArray(args[0])?args[0][0]:args[0];
   const host=typeof first==='object'?first.host:args[1],requestedPort=typeof first==='object'?first.port:first;
   assert.equal(host,'127.0.0.1','Only loopback browser proxy sockets are permitted');assert.equal(Number(requestedPort),port);
   return Reflect.apply(originalConnect,this,args);
  });
  const f=await fixture(),workspaceId=f.config.trustedBinding.workspaceId,state=await f.store.get(workspaceId,{exactSnapshot:true}),user=state.users[0];
  const token=createSessionToken({workspaceId,userId:user.id,email:user.email,role:'owner',csrf:f.session.csrf},KEY);
  const pagePath=PARCEL2GO_OWNER_QUOTE_PAGE+'?requestId='+f.config.requestId,apiPath=PARCEL2GO_RECORDED_REVIEW_PATH+'?requestId='+f.config.requestId;
  const locks=new Map(),pending=new Set(),errors=[],outside=[],posts=[];
  try{
   const env={NODE_ENV:'production',RUNVARA_STARTUP_MODE:'quiet',RUNVARA_QUIET_OWNER_LOGIN:'enabled/v1',RUNVARA_QUIET_OWNER_WORKSPACE:'enabled/v1',SESSION_SECRET:KEY,CREDENTIALS_KEY:KEY,APP_PUBLIC_URL:ORIGIN};
   server=createPacksmartServer(env,{store:f.store,fetchImpl:async()=>assert.fail('Real provider fetch forbidden')});
   const application=server.listeners('request')[0];server.removeAllListeners('request');
   const surfaceOptions={mode:'unmounted-owner-quote-surface/v1',origin:ORIGIN,sessionSecret:KEY,store:f.store,withWorkspaceLock:createWorkspaceLock(locks),
    admission:{...f.config,mode:'disabled/v1',mockRequest:undefined},requestId:f.config.requestId,expiresAt:f.config.expiresAt,now:Date.now,monotonic:()=>performance.now()};
   surface=createParcel2GoOwnerQuoteSurface(surfaceOptions);
   server.on('request',(req,res)=>{
    if(!mounted||![pagePath,apiPath,PARCEL2GO_OWNER_QUOTE_SCRIPT].includes(req.url))return application(req,res);
    const run=surface.handle(req,res);pending.add(run);void run.finally(()=>pending.delete(run));
   });
   server.listen(0,'127.0.0.1');await once(server,'listening');port=server.address().port;
   const base='http://127.0.0.1:'+port;
   context=await browser.newContext({viewport:{width:1100,height:850},serviceWorkers:'block'});
   await context.addCookies([{name:'__Host-packsmart_session',value:token,domain:new URL(ORIGIN).hostname,path:'/',secure:true,httpOnly:true,sameSite:'Strict'}]);
   await context.route('**/*',async route=>{try{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==ORIGIN){outside.push(url.origin);await route.abort();return;}
    if(request.method()==='POST')posts.push({path:url.pathname,body:request.postDataJSON()});
    const response=await route.fetch({url:base+url.pathname+url.search,headers:request.headers(),maxRedirects:0,maxRetries:0});
    await route.fulfill({response});
   }catch{errors.push('Loopback proxy failed');await route.abort().catch(()=>{});}});
   page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(10000);
   // Prove the original server cannot reach the candidate before the test mount.
   const readsBeforeMount=f.calls.length;
   assert.equal((await page.goto(ORIGIN+pagePath)).status(),503);assert.equal(provider.length,0);assert.equal(f.calls.length,readsBeforeMount);
   mounted=true;const response=await page.goto(ORIGIN+pagePath);
   assert.equal(response.status(),200);assert.equal(response.headers()['cache-control'],'no-store');assert.equal(response.headers()['referrer-policy'],'no-referrer');
   await page.getByText('Enter your parcel details.',{exact:true}).waitFor();assert.equal(posts.length,0);
   for(const [name,value] of Object.entries({collectionPostcode:'SW1A 1AA',deliveryPostcode:'M1 1AE',weightGrams:'5000',lengthMm:'450',widthMm:'300',heightMm:'250',declaredValueDecimal:'15.15'}))await page.locator(`[name="${name}"]`).fill(value);
   for(const [name,value] of Object.entries({collectionVatStatus:'NotRegistered',deliveryVatStatus:'Individual',currency:'GBP',basis:'estimate'}))await page.locator(`[name="${name}"]`).selectOption(value);
   await page.locator('[name="acknowledgedUnverified"]').check();await page.getByRole('button',{name:'Prepare exact review',exact:true}).click();
   await page.locator('[name="reviewed"]').waitFor();assert.equal(provider.length,0);
   assert.match(await page.locator('main').innerText(),/Owner-authorised estimate, not measured/);
   await page.screenshot({path:artifacts+'/'+scenario+'-review.png',fullPage:true});
   await page.locator('[name="reviewed"]').check();await page.getByRole('button',{name:'Approve exact review',exact:true}).click();
   await page.locator('[name="sendConfirmed"]').waitFor();assert.equal(provider.length,0);
   await page.locator('[name="sendConfirmed"]').check();await page.getByRole('button',{name:'Request one quote comparison',exact:true}).click();
   await page.getByText(scenario==='comparison'?'Comparison received. This attempt cannot be repeated.':'Outcome unconfirmed. Reconcile saved status; do not retry.',{exact:true}).waitFor();
   assert.equal(provider.length,2);assert.deepEqual(provider.map(c=>new URL(c.url).pathname),['/auth/connect/token','/api/quotes']);
   assert.deepEqual(posts.map(p=>p.body.action),['prepare','decide','execute']);
   assert.equal(posts[1].body.confirmation.operationHash,posts[2].body.confirmation.operationHash);
   const text=await page.locator('main').innerText();if(scenario==='comparison')assert.match(text,/12\.66/);else assert.doesNotMatch(text,/12\.66/);
   for(const secret of [KEY,CLIENT,SECRET_VALUE,TOKEN])assert.equal(text.includes(secret),false);
   await page.screenshot({path:artifacts+'/'+scenario+'-outcome.png',fullPage:true});
   const saved=f.fake.states.get(workspaceId),receipt=saved.parcel2goLiveQuoteRuns.find(r=>r.requestId===f.config.requestId);
   assert.equal(receipt.status,scenario==='comparison'?'completed':'reserved');assert.equal(JSON.stringify(receipt).includes('12.66'),false);
   // Only this synthetic test clears markers: prove retained server evidence,
   // independently of browser markers, prevents replay after a fresh page load.
   await page.evaluate(()=>sessionStorage.clear());
   await page.reload();await page.getByText('A quote attempt is recorded or unconfirmed. Reconcile the saved outcome; do not repeat it.',{exact:true}).waitFor();
   assert.equal(await page.getByRole('button').count(),0);assert.equal(provider.length,2);
   // Close before unmount/drain, retaining all approval/attempt/audit history.
   const durable=structuredClone(f.fake.states.get(workspaceId));surface.close();mounted=false;
   assert.equal((await page.goto(ORIGIN+pagePath)).status(),503);assert.deepEqual(f.fake.states.get(workspaceId),durable);
   surface=createParcel2GoOwnerQuoteSurface(surfaceOptions);mounted=true;
   await page.goto(ORIGIN+pagePath);await page.getByText('A quote attempt is recorded or unconfirmed. Reconcile the saved outcome; do not repeat it.',{exact:true}).waitFor();
   assert.equal(await page.getByRole('button').count(),0);assert.equal(provider.length,2);
   assert.deepEqual(errors,[]);assert.deepEqual(outside,[]);
   summaries.push({scenario,browser:browser.version(),realNodeServer:true,actualSessionEndpoint:true,providerTransport:'intercepted native HTTPS',realProviderRequests:0,
    posts:posts.length,tokenQuotePair:provider.length===2,durableStatus:receipt.status,reloadBlocked:true,emptyBrowserMarkers:true,rollbackRetainedHistory:true,remountBlockedReplay:true,
    defaultUnmountedStatus:503,browserErrors:errors.length,externalBrowserRequests:outside.length});
  }catch(error){await page?.screenshot({path:artifacts+'/'+scenario+'-failure.png',fullPage:true}).catch(()=>{});throw error;}
  finally{surface?.close();await Promise.allSettled([...pending]);await context?.close();await server?.packsmart.drain();if(server?.listening)await new Promise(resolve=>server.close(resolve));mock.restoreAll();}
 }
 await writeFile(artifacts+'/report.json',JSON.stringify({status:'passed',scenarios:summaries},null,2)+'\n');
 console.log(JSON.stringify({status:'passed',scenarios:summaries,artifacts}));
}finally{await browser?.close();mock.restoreAll();}
