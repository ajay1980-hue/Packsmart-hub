// Actual app + server integration, with synthetic tenant records only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-graph-browser-'));
const secret = 'graph-browser-test-only-secret-more-than-32-characters';
const server = createPacksmartServer({NODE_ENV:'test', SESSION_SECRET:secret, CREDENTIALS_KEY:secret,
  SAAS_STATE_FILE:path.join(directory,'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED:'false'});
let browser;
try {
  const state = seedWorkspaceState({}, {workspaceId:'graph-preview', name:'Graph preview', email:'preview@example.test', passwordHash:'fixture-only'});
  state.products = [{id:'p1',provider:'shopify',title:'Packaging evidence fixture',status:'active',variants:[{id:'v1',sku:'PS-1',price:10,inventory:3,available:true}]}];
  await server.packsmart.store.save(state.workspace.id,state);
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = createSessionToken({userId:state.users[0].id, workspaceId:state.workspace.id, email:state.users[0].email, role:'owner', sessionVersion:1},secret);
  browser = await chromium.launch({headless:true,args:['--no-sandbox']});
  for (const width of [320,390,1200]) {
    const context = await browser.newContext({viewport:{width,height:900}});
    await context.addCookies([{name:'packsmart_session',value:token,url:base,httpOnly:true,sameSite:'Strict'}]);
    const page = await context.newPage(), errors = [], calls = [];
    page.on('pageerror',error => errors.push(error.message));
    await page.route('**/*',route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    page.on('request',request => {if(new URL(request.url()).pathname === '/api/business-graph') calls.push(request.url());});
    await page.goto(base);
    await page.locator('#app-shell:not(.hidden)').waitFor();
    assert.equal(calls.length,0,'no automatic graph requests');
    const details = page.locator('.business-graph-inspector');
    await details.locator('summary').click();
    await page.locator('#load-business-graph').click();
    await page.locator('#business-graph-result').getByText('Evidence-backed links',{exact:true}).waitFor();
    assert.equal(calls.length,1);
    assert.equal(new URL(calls[0]).searchParams.has('detail'),false,'UI uses small summary only');
    await details.locator('summary').click();
    await details.locator('summary').click();
    assert.equal(calls.length,1,'reopening never polls');
    const dimensions = await page.evaluate(() => ({scroll:document.documentElement.scrollWidth,width:innerWidth}));
    assert.ok(dimensions.scroll <= dimensions.width + 2, `graph viewport overflow at ${width}px: ${JSON.stringify(dimensions)}`);
    assert.deepEqual(errors,[]);
    await details.screenshot({path:`/tmp/runvara-business-graph-${width}.png`});
    await context.close();
  }
  console.log('Business graph browser verification passed at 320, 390 and 1200 pixels.');
} finally {
  if(browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(directory,{recursive:true,force:true});
}
