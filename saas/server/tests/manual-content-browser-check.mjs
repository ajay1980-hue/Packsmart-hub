// Real app and real local preparation/history API; provider traffic is forbidden.
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

const directory=await fs.mkdtemp(path.join(os.tmpdir(),'runvara-manual-content-browser-'));
const port=18878,base=`http://127.0.0.1:${port}`;
const secret='manual-content-browser-only-secret-over-thirty-two-characters';
let providerRequests=0;
const server=createPacksmartServer({NODE_ENV:'test',APP_PUBLIC_URL:base,SESSION_SECRET:secret,CREDENTIALS_KEY:secret,SAAS_STATE_FILE:path.join(directory,'state.json'),SHOPIFY_PUBLIC_SYNC_ENABLED:'false'}, {fetchImpl:async()=>{providerRequests++;throw new Error('Provider transport is forbidden in this synthetic browser fixture');}});
let browser;
const productId='gid://shopify/Product/54321';
const target={schema:'runvara-manual-content-target/v1',connectionId:'browser-exact-content-b',account:'browser-exact-b.myshopify.com',settingsRevision:7};
async function capture(page,width,name){
  const panel=page.locator('#connection-content-editor'),dialog=page.locator('#connection-dialog');
  const typography=await panel.evaluateHandle(createRestrictionTypographySession);
  const fit=async()=>{
    const dimensions=await dialog.evaluate(node=>({width:innerWidth,left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right,scroll:node.scrollWidth,client:node.clientWidth,panel:node.querySelector('#connection-content-editor').scrollWidth,panelClient:node.querySelector('#connection-content-editor').clientWidth}));
    assert.ok(dimensions.left>=0&&dimensions.right<=width+2&&dimensions.scroll<=dimensions.client+2&&dimensions.panel<=dimensions.panelClient+2,`manual content overflow ${width}/${name}: ${JSON.stringify(dimensions)}`);
  };
  const images=async suffix=>{
    // Focus a non-text control so screenshots need no caret suppression. The
    // default hides carets via inline styles and leaves empty style attributes,
    // which would invalidate the original typography baseline.
    if (await page.locator('#content-account').isEnabled()) await page.locator('#content-account').focus();
    else await page.locator('#connection-close').focus();
    await page.locator('#content-account').evaluate(node=>node.scrollIntoView({block:'start'}));
    await fit();await dialog.screenshot({path:`/tmp/runvara-manual-content-${name}-${width}${suffix}-fields.png`,caret:'initial'});
    await page.locator('#content-exact').evaluate(node=>node.scrollIntoView({block:'start'}));
    await fit();await dialog.screenshot({path:`/tmp/runvara-manual-content-${name}-${width}${suffix}-review.png`,caret:'initial'});
  };
  try {
    await typography.evaluate(session=>session.assertBaseline());await images('');
    await typography.evaluate(session=>session.begin());
    try {await typography.evaluate(session=>session.enlarge());await images('-large-text');}
    finally {await typography.evaluate(session=>session.restore());}
    await typography.evaluate(session=>session.assertBaseline());
  } finally {await typography.dispose();}
}
try{
 const seed=seedWorkspaceState({}, {workspaceId:'manual-content-browser',userId:'manual-content-owner',name:'Synthetic exact content tenant',email:'manual-content@example.test',passwordHash:'fixture-only'});
 seed.products=[{id:productId,provider:'shopify',title:'Synthetic retained product',status:'active',variants:[]}];
 seed.connections=[{id:'browser-display-a',provider:'shopify',status:'connected',metadata:{shopDomain:'browser-display-a.myshopify.com',grantedScopes:[]}},
  {id:target.connectionId,provider:'shopify',status:'connected',encryptedCredentials:'synthetic-opaque-marker-never-decrypted',metadata:{shopDomain:target.account,grantedScopes:['read_products','write_products']}}];
 seed.connectionSettings={shopify:{permissionMode:'approval_gated',revision:target.settingsRevision}};
 seed.connectionWrites=[];seed.approvals=[];
 await server.packsmart.store.save(seed.workspace.id,seed);
 server.listen(port,'127.0.0.1');await once(server,'listening');assert.equal(base,`http://${server.address().address}:${server.address().port}`);
 const token=createSessionToken({userId:seed.users[0].id,workspaceId:seed.workspace.id,email:seed.users[0].email,role:'owner',sessionVersion:1},secret);
 browser=await chromium.launch({headless:true});
 for(const width of [320,390,1200]){
  const reset=structuredClone(seed);reset._revision=(await server.packsmart.store.get(seed.workspace.id))._revision;await server.packsmart.store.save(seed.workspace.id,reset);
  const context=await browser.newContext({viewport:{width,height:900}});await context.addCookies([{name:'packsmart_session',value:token,url:base,httpOnly:true,sameSite:'Strict'}]);
  const page=await context.newPage(),calls=[],errors=[],external=[],unexpected=[];let postMode='commit-and-lose';
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url());if(url.origin!==base){external.push(url.href);return route.abort();}
   if(!url.pathname.startsWith('/api/'))return route.continue();
   calls.push({path:url.pathname,method:request.method(),body:request.postData()});
   if(request.method()==='GET'&&['/api/auth/session','/api/bootstrap','/api/connection-centre'].includes(url.pathname))return route.continue();
   if(request.method()==='GET'&&url.pathname.startsWith('/api/connections/shopify/content-requests/'))return route.continue();
   if(request.method()==='POST'&&url.pathname==='/api/connections/shopify/writes'){
    assert.equal(await request.headerValue('origin'),base);
    if(postMode==='commit-and-lose'){postMode='normal';const response=await route.fetch();assert.equal(response.status(),200);return route.abort();}
    if(postMode==='lose-before-send'){postMode='normal';return route.abort();}
    return route.continue();
   }
   unexpected.push(calls.at(-1));return route.abort();
  });
  await page.goto(base);await page.locator('#app-shell:not(.hidden)').waitFor();
  const navigate=async()=>{if(await page.locator('#mobile-menu').isVisible())await page.locator('#mobile-menu').click();await page.locator('#main-nav [data-view="channels"]').click();};
  await navigate();
  const open=async()=>{await page.locator('#connection-grid [data-provider="shopify"][data-connection-action="open"]').first().click();await page.locator('#connection-content-form').waitFor();};
  await open();
  const form=page.locator('#connection-content-form'),account=page.locator('#content-account'),product=page.locator('#content-product'),ack=page.locator('#content-ack');
  const writes=()=>calls.filter(call=>call.path==='/api/connections/shopify/writes');const checks=()=>calls.filter(call=>call.path.startsWith('/api/connections/shopify/content-requests/'));
  assert.equal(await account.inputValue(),'');assert.equal(await product.inputValue(),'');assert.equal(await ack.isChecked(),false);assert.equal(writes().length,0);assert.equal(checks().length,0);
  const fill=async title=>{await account.selectOption(target.connectionId);await product.selectOption(productId);await page.locator('#content-title').fill(title);await page.locator('#content-description').fill('Exact description.\nOnly these reviewed words.');};
  await fill('Exact reviewed title');await ack.check();await page.locator('#content-title').fill('Exact owner-reviewed title');assert.equal(await ack.isChecked(),false);
  assert.ok((await page.locator('#content-exact').textContent()).includes(target.account));assert.ok((await page.locator('#content-exact').textContent()).includes(productId));
  await capture(page,width,'review');await ack.check();await page.locator('#content-prepare').click();
  await page.locator('#content-status').getByText('The preparation outcome is unknown.',{exact:false}).waitFor();assert.equal(writes().length,1);
  const first=JSON.parse(writes()[0].body);assert.deepEqual(first.target,target);assert.deepEqual(Object.keys(first).sort(),['operation','requestId','productId','title','description','target'].sort());
  let stored=await server.packsmart.store.get(seed.workspace.id);assert.equal(stored.connectionWrites.length,1);assert.equal(stored.approvals.length,1);assert.equal(stored.connectionWrites[0].connectionId,target.connectionId);
  await capture(page,width,'unknown');await page.locator('#connection-close').click();await open();assert.ok((await page.locator('#content-exact').textContent()).includes(first.requestId));assert.equal(checks().length,0);
  await page.locator('#content-check').click();await page.locator('#content-status').getByText('Exact request found:',{exact:false}).waitFor();assert.equal(checks().length,1);assert.equal(writes().length,1);
  await page.locator('#content-new').click();await page.waitForFunction(()=>document.querySelector('#connection-content-form').getAttribute('aria-busy')==='false');assert.equal(await account.inputValue(),'');assert.equal(await product.inputValue(),'');
  await fill('A different reviewed title');await ack.check();postMode='lose-before-send';await page.locator('#content-prepare').click();await page.locator('#content-status').getByText('The preparation outcome is unknown.',{exact:false}).waitFor();
  const second=JSON.parse(writes()[1].body);assert.notEqual(second.requestId,first.requestId);
  await page.locator('#content-check').click();await page.locator('#content-status').getByText('No matching request was found',{exact:false}).waitFor();assert.equal(writes().length,2);assert.equal(await ack.isChecked(),false);
  await page.locator('#content-title').evaluate(node=>{node.value='Silent substitution';});await ack.check();await page.locator('#content-retry').click();await page.locator('#content-error').getByText('The displayed fields no longer match',{exact:false}).waitFor();assert.equal(writes().length,2);
  await page.locator('#connection-close').click();await open();assert.equal(await page.locator('#content-title').inputValue(),second.title);await page.locator('#content-check').click();await page.locator('#content-status').getByText('No matching request was found',{exact:false}).waitFor();await ack.check();await page.locator('#content-retry').click();await page.locator('#content-status').getByText('Exact request found:',{exact:false}).waitFor();
  assert.equal(writes().length,3);assert.deepEqual(JSON.parse(writes()[2].body),second);stored=await server.packsmart.store.get(seed.workspace.id);assert.equal(stored.connectionWrites.length,2);assert.equal(stored.approvals.length,2);
  await page.locator('#content-new').click();await page.waitForFunction(()=>document.querySelector('#connection-content-form').getAttribute('aria-busy')==='false');await fill('Draft with stale settings');await ack.check();
  stored=await server.packsmart.store.get(seed.workspace.id);stored.connectionSettings.shopify.revision++;await server.packsmart.store.save(seed.workspace.id,stored);
  await page.locator('#connection-refresh').click();await page.locator('#content-status').getByText('changed',{exact:false}).waitFor();assert.equal(await ack.isChecked(),false);assert.equal(await page.locator('#content-prepare').isDisabled(),true);
  await page.locator('#global-success').waitFor({state:'hidden'});await capture(page,width,'stale');
  await page.locator('#content-reload').click();await page.waitForFunction(()=>document.querySelector('#connection-content-form').getAttribute('aria-busy')==='false');assert.equal(await account.inputValue(),'');assert.equal(await product.inputValue(),'');assert.equal(writes().length,3);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(unexpected,[]);assert.equal(providerRequests,0,'preparation and reconciliation make no server-side provider requests');await context.close();
 }
 console.log('Manual Shopify exact-target content preparation/recovery checks passed at320,390,1200 with normal and200% text, real local saves, separate approval and no provider requests.');
}finally{if(browser)await browser.close();if(server.listening)await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});assert.equal(providerRequests,0,'no provider transport may be attempted, including on a failed fixture path');}
