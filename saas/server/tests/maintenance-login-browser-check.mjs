// Isolated headless browser, real app/server/store, synthetic database transport.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { maintenanceFixture, ownerState, PASSWORD } from './maintenance-login-fixture.mjs';

const output = path.resolve(process.env.RUNVARA_MAINTENANCE_EVIDENCE_DIR || path.join(os.tmpdir(), 'runvara-maintenance-login'));
await fs.mkdir(output, { recursive: true });
const state = ownerState('packsmart-solutions');
state.workspace.name = 'Synthetic maintenance workspace';
const f = await maintenanceFixture({ states: [state], env: { NODE_ENV: 'test', APP_PUBLIC_URL: 'http://127.0.0.1' } });
let browser, external = 0;
const errors = [], requests = [], captures = [];
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  for (const width of [390, 1200]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== f.base) { external++; return route.abort('blockedbyclient'); }
        requests.push({ width, method: req.method(), path: url.pathname });
        return route.continue();
      });
      await page.goto(f.base, { waitUntil: 'networkidle' });
      await page.locator('#login-screen').waitFor({ state: 'visible' });
      await page.locator('#login-email').fill('packsmart-solutions@example.test');
      await page.locator('#login-password').fill('Wrong-Synthetic!2026');
      await page.locator('#login-form button').click();
      await page.waitForFunction(() => document.querySelector('#login-error').textContent.includes('Invalid email or password'));
      const before = f.fake.states.get(state.workspace.id).audit.length;
      await page.locator('#login-password').fill(PASSWORD);
      await page.locator('#login-form button').click();
      await page.waitForFunction(() => document.querySelector('#loading-screen h1').textContent === 'Signed in. Maintenance continues.');
      assert.equal(await page.locator('#login-screen').isVisible(), false);
      assert.equal(await page.locator('#app-shell').isVisible(), false);
      assert.match(await page.locator('#loading-screen h1 + p').textContent(), /packsmart-solutions@example.test/);
      assert.match(await page.locator('#startup-error').textContent(), /session is verified/);
      assert.equal(await page.locator('#login-password').inputValue(), '');
      assert.equal(f.fake.states.get(state.workspace.id).audit.length, before + 1);
      const session = await page.evaluate(async () => { const r = await fetch('/api/auth/session'); const p = await r.json(); return { status: r.status, workspaceId: p.workspace?.id, maintenance: p.maintenance }; });
      assert.deepEqual(session, { status: 200, workspaceId: state.workspace.id, maintenance: true });
      const postCount = requests.filter(r => r.method === 'POST').length;
      await page.locator('#startup-retry').click();
      await page.waitForFunction(() => document.querySelector('#loading-screen h1').textContent === 'Signed in. Maintenance continues.');
      assert.equal(requests.filter(r => r.method === 'POST').length, postCount, 'manual session check does not repeat login');
      assert.equal(f.fake.states.get(state.workspace.id).audit.length, before + 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const filename = `maintenance-login-${width}.png`;
      await page.screenshot({ path: path.join(output, filename), fullPage: true }); captures.push(filename);
      f.fake.states.get(state.workspace.id).users[0].sessionVersion++;
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator('#login-screen').waitFor({ state: 'visible' });
    } finally { await context.close(); }
  }
  assert.equal(external, 0); assert.deepEqual(errors, []);
  assert.ok(!requests.some(r => ['/api/bootstrap', '/api/migrate-pilot'].includes(r.path)), 'maintenance never attempts dashboard/import work');
  const writes = f.calls.filter(call => !['GET', 'HEAD'].includes(call.method));
  assert.equal(writes.length, 2);
  assert.ok(writes.every(call => call.method === 'PATCH' && call.url.pathname.endsWith('/saas_workspace_state')));
  assert.equal(f.fake.tables.size, 0);
  await fs.writeFile(path.join(output, 'browser-result.json'), JSON.stringify({ passed: true, browser: browser.version(), widths: [390, 1200], captures, requests, externalRequests: external, pageErrors: errors, auditWrites: writes.length, limits: ['Synthetic local transport and accounts', 'No hosted database/provider acceptance'] }, null, 2) + '\n');
  console.log('Maintenance login browser checks passed: invalid and successful sign-in, paused identity, reload without repeat write, revocation, no bootstrap/import/provider traffic.');
} finally { await browser?.close(); await f.close(); }
