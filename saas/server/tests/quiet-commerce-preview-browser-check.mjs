import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { maintenanceFixture, ownerState, SECRET } from './maintenance-login-fixture.mjs';
import { createSessionToken } from '../lib/security.mjs';

const output = path.resolve(process.env.RUNVARA_MAINTENANCE_EVIDENCE_DIR || path.join(os.tmpdir(), 'runvara-quiet-commerce-preview'));
await fs.mkdir(output, { recursive: true });
const requests = [], errors = [], captures = [], calls = [];
let browser, external = 0;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  for (const width of [320, 390, 1200]) {
    const state = ownerState('packsmart-solutions');
    state.products = [{ id: 'p1', title: '<img src=https://forbidden.invalid onerror=alert(1)> saved product', currency: 'GBP',
      image: 'https://forbidden.invalid/image.png', variants: [{ id: 'v1', title: 'Small', sku: 'same-sku', inventory: 0, price: '2.50' },
        { id: 'v2', title: 'Large', sku: 'same-sku', inventory: null, price: null }] }];
    state.economics = { 'same-sku': { supplierUnitCost: '0.00', currency: 'GBP', notes: 'private-note' }, v2: { supplierUnitCost: '4.20' } };
    const env = { NODE_ENV: 'test', APP_PUBLIC_URL: 'http://127.0.0.1', RUNVARA_QUIET_OWNER_LOGIN: 'disabled/v1', RUNVARA_QUIET_COMMERCE_PREVIEW: 'enabled/v1' };
    const f = await maintenanceFixture({ states: [state], env });
    let active = f, context;
    try {
      context = await browser.newContext({ viewport: { width, height: 900 } });
      // Only a synthetic local session: no hosted login, cookie extraction or credentials.
      await context.addCookies([{ name: 'packsmart_session', value: createSessionToken({ userId: state.users[0].id,
        workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, SECRET),
        url: f.base, httpOnly: true, sameSite: 'Strict' }]);
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== f.base) { external++; return route.abort(); }
        requests.push({ width, method: request.method(), path: url.pathname }); return route.continue();
      });
      const before = structuredClone(f.fake.states.get(state.workspace.id));
      const count = () => requests.filter(r => r.width === width && r.path === '/api/maintenance/commerce').length;
      await page.goto(f.base, { waitUntil: 'networkidle' });
      assert.equal(count(), 0, 'no automatic catalogue read');
      assert.equal(await page.locator('#loading-screen h1').textContent(), 'Signed in. Maintenance continues.');
      const button = page.locator('#maintenance-commerce > button');
      for (const scale of [100, 200]) {
        await page.evaluate(value => { document.documentElement.style.fontSize = value + '%'; }, scale);
        const prior = count();
        await button.focus(); await page.keyboard.press('Enter');
        await page.locator('#maintenance-commerce h2').waitFor();
        await page.waitForFunction(() => !document.querySelector('#maintenance-commerce > button').disabled);
        assert.equal(count(), prior + 1);
        const text = await page.locator('#maintenance-commerce').textContent();
        assert.match(text, /Saved records only/); assert.match(text, /Unknown/); assert.match(text, /0\.00/);
        assert.match(text, /without assigning them to a product or variant/);
        assert.match(text, /<img src=/); assert.equal(await page.locator('#maintenance-commerce img').count(), 0);
        assert.doesNotMatch(text, /private-note/);
        assert.equal(await page.locator('#app-shell').isVisible(), false);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const file = `saved-commerce-${width}-${scale}.png`; captures.push(file);
        await page.screenshot({ path: path.join(output, file), fullPage: true });
      }
      // A failed refresh removes prior saved data, without attempting fallback work.
      await page.route('**/api/maintenance/commerce', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic unavailable' }) }));
      await button.click(); await page.waitForFunction(() => document.querySelector('#maintenance-commerce').textContent.includes('Saved preview unavailable'));
      assert.equal(await page.locator('#maintenance-commerce article').count(), 0);
      await page.unroute('**/api/maintenance/commerce');
      // Interruption: abort a pending read on reload, then ignore any late response.
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
      await page.route('**/api/maintenance/commerce', async route => { entered(); await gate; await route.abort().catch(() => {}); });
      await button.click(); await started;
      assert.equal(await button.isDisabled(), true);
      const reload = page.reload({ waitUntil: 'networkidle' }); release(); await reload;
      await page.unroute('**/api/maintenance/commerce');
      assert.equal(await page.locator('#maintenance-commerce article').count(), 0);
      assert.equal(await page.locator('#maintenance-commerce h2').count(), 0);
      assert.deepEqual(f.fake.states.get(state.workspace.id), before);
      // Close preview on the same origin; issued session stays maintenance-only.
      const port = f.server.address().port; await f.close(); active = null; calls.push(...f.calls);
      const closed = await maintenanceFixture({ states: [before], port, env: { ...env, RUNVARA_QUIET_COMMERCE_PREVIEW: 'disabled/v1' } });
      active = closed; const readsBeforeClosure = count();
      await page.reload({ waitUntil: 'networkidle' });
      assert.equal(await page.locator('#loading-screen h1').textContent(), 'Signed in. Maintenance continues.');
      assert.equal(await page.locator('#maintenance-commerce').count(), 0); assert.equal(count(), readsBeforeClosure);
      calls.push(...closed.calls); assert.deepEqual(closed.fake.states.get(state.workspace.id), before);
    } finally { await context?.close(); await active?.close(); }
  }
  assert.equal(external, 0); assert.deepEqual(errors, []);
  assert.ok(requests.every(r => r.method === 'GET'));
  assert.ok(requests.every(r => !r.path.startsWith('/api/') || ['/api/auth/session', '/api/maintenance/commerce'].includes(r.path)), 'no bootstrap/import/signup/provider requests');
  assert.ok(calls.every(call => call.method === 'GET'), 'no audit, revision, RPC or business writes');
  await fs.writeFile(path.join(output, 'browser-result.json'), JSON.stringify({ passed: true, browser: browser.version(), captures, requests,
    externalRequests: external, pageErrors: errors, databaseWrites: 0,
    limitations: ['Synthetic localhost transport, accounts and cookies', 'No hosted, native database or provider acceptance'] }, null, 2) + '\n');
  console.log('Saved commerce browser checks passed: six responsive/enlarged views, manual-only reads, safe text, failed/interrupted reads, same-origin closure and zero writes/provider requests.');
} finally { await browser?.close(); }
