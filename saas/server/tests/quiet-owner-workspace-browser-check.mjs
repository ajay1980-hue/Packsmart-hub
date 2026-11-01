import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { maintenanceFixture, ownerState, SECRET } from './maintenance-login-fixture.mjs';
import { createSessionToken } from '../lib/security.mjs';

const output = path.resolve(process.env.RUNVARA_OWNER_WORKSPACE_EVIDENCE || '.owner-workspace-browser-evidence');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
const errors = [], requests = [], captures = []; let checks = 0, external = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
async function overviewActionsFit(page) {
  return page.locator('#view-overview .section-head > .text-button').evaluateAll(buttons => buttons.length > 0 && buttons.every(button => {
    const bounds = button.getBoundingClientRect(), parent = button.parentElement.getBoundingClientRect();
    return bounds.left >= parent.left - 1 && bounds.right <= parent.right + 1 && button.scrollWidth <= button.clientWidth + 1;
  }));
}
try {
  for (const width of [390, 1200]) {
    const requestStart = requests.length;
    const state = ownerState('packsmart-solutions');
    state.products = [{ id: 'synthetic-product', title: 'Synthetic saved product', provider: 'shopify', status: 'active', productType: 'Packaging', image: '', variants: [{ id: 'variant-1', title: 'Single', sku: 'TEST-SKU', price: 5, inventory: 7, available: true }] }];
    state.workspace.name = 'Synthetic owner workspace';
    const before = structuredClone(state);
    const env = { NODE_ENV: 'test', APP_PUBLIC_URL: 'http://127.0.0.1', RUNVARA_QUIET_OWNER_LOGIN: 'disabled/v1', RUNVARA_QUIET_OWNER_WORKSPACE: 'enabled/v1', RUNVARA_QUIET_COMMERCE_PREVIEW: 'enabled/v1' };
    const f = await maintenanceFixture({ states: [state], env }); let active = f;
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      await context.addCookies([{ name: 'packsmart_session', value: createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, SECRET), url: f.base, httpOnly: true, sameSite: 'Strict' }]);
      await context.addInitScript(() => {
        if (!localStorage.getItem('synthetic-test-initialized')) {
          localStorage.setItem('packsmart-saas-economics-v1', '{"legacy-cost":"2.50"}');
          localStorage.setItem('packsmart-saas-automations-v1', '{"legacy-rule":false}');
          localStorage.setItem('synthetic-test-initialized', 'yes');
        }
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== f.base) { external++; return route.abort(); }
        requests.push({ method: req.method(), path: url.pathname }); return route.continue();
      });
      await page.goto(f.base, { waitUntil: 'networkidle' });
      await page.locator('#app-shell').waitFor({ state: 'visible' });
      await page.locator('#owner-workspace-notice').waitFor();
      check(new URL(page.url()).pathname === '/', 'uses existing root, not a replacement dashboard');
      check((await page.locator('#owner-workspace-notice').textContent()).includes('not a source-sync time'), 'honest freshness');
      check((await page.locator('#owner-workspace-notice').textContent()).includes('has not been saved'), 'transient brief disclosed');
      check((await page.locator('#command-posture').textContent()).includes('Automatic work paused'), 'stored autopilot flag does not claim runtime is on');
      check(await page.getByText('Saved enabled rules (not running)', { exact: true }).isVisible(), 'saved enabled rules are not labelled active workers');
      check(await page.locator('#commander-form button').isDisabled(), 'paid commander action disabled');
      check(await page.locator('#sync-shopify').isDisabled(), 'Shopify import is separately gated');
      check(await page.locator('#sync-all-channels').isDisabled(), 'broad sync disabled');
      check(await page.locator('#refresh-all').textContent() === 'Reload dashboard', 'refresh semantics clear');
      for (const scale of [100, 200]) {
        await page.evaluate(value => { document.documentElement.style.fontSize = value + '%'; }, scale);
        for (const view of ['overview', 'profit', 'orders', 'channels', 'approvals']) {
          if (width < 900 && !await page.locator('.sidebar').isVisible()) await page.locator('#mobile-menu').click();
          await page.locator(`#main-nav [data-view="${view}"]`).focus(); await page.keyboard.press('Enter');
          check(await page.locator(`#view-${view}`).isVisible(), `existing view ${view}`);
          check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `layout ${width}/${scale}/${view}`);
          if (view === 'overview') check(await overviewActionsFit(page), `overview actions remain inside their headings ${width}/${scale}`);
        }
        if (width < 900 && !await page.locator('.sidebar').isVisible()) await page.locator('#mobile-menu').click();
        await page.locator('#main-nav [data-view="overview"]').click();
        const file = path.join(output, `existing-dashboard-${width}-${scale}.png`); await page.screenshot({ path: file, fullPage: true }); captures.push(file);
        await page.screenshot({ path: path.join(output, `viewport-${width}-${scale}.png`), fullPage: false });
      }
      if (width === 1200) {
        await page.evaluate(() => { document.documentElement.style.fontFamily = 'Arial, sans-serif'; });
        check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '200% fallback-font layout');
        check(await overviewActionsFit(page), '200% fallback-font overview actions remain inside their headings');
        await page.evaluate(() => { document.documentElement.style.fontFamily = ''; });
      }
      const preserved = await page.evaluate(() => ({ economics: localStorage.getItem('packsmart-saas-economics-v1'), automations: localStorage.getItem('packsmart-saas-automations-v1'), migrated: localStorage.getItem('packsmart-saas-cloud-migration-v3:packsmart-solutions') }));
      assert.deepEqual(preserved, { economics: '{"legacy-cost":"2.50"}', automations: '{"legacy-rule":false}', migrated: null }); checks++;
      await page.locator('#refresh-all').click(); await page.getByText('Dashboard reloaded from retained records. No source sync ran.', { exact: true }).waitFor();
      check(requests.every(row => row.method === 'GET'), 'no browser mutation or migration');
      check(requests.slice(requestStart).filter(row => row.path.startsWith('/api/')).every(row => ['/api/auth/session', '/api/bootstrap'].includes(row.path)), 'only session/bootstrap reads while dashboard is open');
      check(f.calls.every(row => row.method === 'GET'), 'no database writes');
      assert.deepEqual(f.fake.states.get(state.workspace.id), before); checks++;
      check(f.server.packsmart.scheduler.status.lastTickAt === null && f.server.packsmart.agentOps.status.lastTickAt === null, 'workers off');
      // Server failure must hide the stale application, not leave active controls.
      await page.route('**/api/bootstrap', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic read unavailable"}' }));
      await page.locator('#refresh-all').click(); await page.locator('#loading-screen').waitFor({ state: 'visible' });
      check(!await page.locator('#app-shell').isVisible(), 'failed refresh closes app shell');
      await page.getByRole('button', { name: 'View saved commerce data', exact: true }).click();
      await page.getByRole('heading', { name: 'Saved commerce preview', exact: true }).waitFor();
      check(requests.some(row => row.path === '/api/maintenance/commerce' && row.method === 'GET'), 'existing separately enabled maintenance preview remains usable after closure');
      await page.unroute('**/api/bootstrap'); await page.reload({ waitUntil: 'networkidle' }); await page.locator('#app-shell').waitFor({ state: 'visible' });
      // An in-flight successful read cannot reopen a view that has closed.
      let finishRead, readReady;
      const ready = new Promise(resolve => { readReady = resolve; });
      const held = new Promise(resolve => { finishRead = resolve; });
      await page.route('**/api/bootstrap', async route => {
        const response = await route.fetch(); readReady(); await held; await route.fulfill({ response });
      });
      await page.locator('#refresh-all').click(); await ready;
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      finishRead(); await page.waitForLoadState('networkidle');
      check(!await page.locator('#app-shell').isVisible(), 'late successful bootstrap cannot reopen a closed view');
      await page.unroute('**/api/bootstrap'); await page.reload({ waitUntil: 'networkidle' }); await page.locator('#app-shell').waitFor({ state: 'visible' });
      f.fake.states.get(state.workspace.id).users[0].role = 'admin';
      await page.locator('#refresh-all').click(); await page.locator('#loading-screen').waitFor({ state: 'visible' });
      check(!await page.locator('#app-shell').isVisible(), 'owner revocation closes app');
      f.fake.states.get(state.workspace.id).users[0].role = 'owner';
      // Exact same local origin, new server with feature off: no automatic migration or bootstrap.
      const port = f.server.address().port; await f.close();
      active = await maintenanceFixture({ states: [state], env: { ...env, RUNVARA_QUIET_OWNER_WORKSPACE: 'disabled/v1' }, port });
      const prior = requests.filter(row => row.path === '/api/bootstrap').length;
      await page.reload({ waitUntil: 'networkidle' }); await page.getByText('Signed in. Maintenance continues.', { exact: true }).waitFor();
      check(!await page.locator('#app-shell').isVisible(), 'disabled restart returns maintenance');
      check(requests.filter(row => row.path === '/api/bootstrap').length === prior, 'disabled session does not request bootstrap');
      const after = await page.evaluate(() => localStorage.getItem('packsmart-saas-economics-v1')); check(after === preserved.economics, 'legacy data survives closure');
    } catch (error) {
      const pages = context.pages(); if (pages[0]) {
        await pages[0].screenshot({ path: path.join(output, `failure-${width}.png`), fullPage: false });
        await fs.writeFile(path.join(output, `failure-${width}-layout.json`), JSON.stringify(await pages[0].evaluate(() => Array.from(document.querySelectorAll('#app-shell *')).filter(el => { const r = el.getBoundingClientRect(); return r.width && r.right > innerWidth + 1 && getComputedStyle(el).display !== 'none'; }).slice(0, 30).map(el => ({ tag: el.tagName, id: el.id, cls: el.className, width: el.getBoundingClientRect().width, right: el.getBoundingClientRect().right }))), null, 2));
      }
      throw error;
    } finally { await context.close(); await active.close(); }
  }
  assert.deepEqual(errors, []); check(external === 0, 'no external browser requests');
  const result = { checks, views: 20, browserErrors: errors, externalRequests: external, mutationRequests: requests.filter(row => row.method !== 'GET').length, apiPaths: [...new Set(requests.filter(row => row.path.startsWith('/api/')).map(row => row.path))], captures };
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await browser.close(); }
