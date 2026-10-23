// Isolated headless browser, real app/server/store, synthetic database transport.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { maintenanceFixture, ownerState, PASSWORD } from './maintenance-login-fixture.mjs';

const output = path.resolve(process.env.RUNVARA_MAINTENANCE_EVIDENCE_DIR || path.join(os.tmpdir(), 'runvara-maintenance-login'));
await fs.mkdir(output, { recursive: true });
let browser, external = 0;
const errors = [], requests = [], captures = [], databaseCalls = [];
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  for (const width of [390, 1200]) {
    const state = ownerState('packsmart-solutions');
    state.workspace.name = 'Synthetic maintenance workspace';
    const env = { NODE_ENV: 'test', APP_PUBLIC_URL: 'http://127.0.0.1' };
    const f = await maintenanceFixture({ states: [state], env });
    let activeFixture = f;
    let context;
    try {
      context = await browser.newContext({ viewport: { width, height: 900 } });
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

      // Real server replacement on the same localhost origin keeps the browser's
      // issued cookie while closing new login. No cookie extraction or injection.
      const persisted = structuredClone(f.fake.states.get(state.workspace.id));
      const port = f.server.address().port;
      await f.close(); activeFixture = null;
      databaseCalls.push(...f.calls);
      const closed = await maintenanceFixture({ states: [persisted], port, env: { ...env, RUNVARA_QUIET_OWNER_LOGIN: 'disabled/v1' } });
      activeFixture = closed;
      assert.equal(closed.base, f.base);
      const closedRequestStart = requests.length;
      for (const action of ['reload', 'check-session']) {
        if (action === 'reload') await page.reload({ waitUntil: 'networkidle' });
        else await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.locator('#startup-retry').click()]);
        assert.equal(await page.locator('#loading-screen h1').textContent(), 'Signed in. Maintenance continues.', `closed-login ${action}`);
        assert.match(await page.locator('#loading-screen h1 + p').textContent(), /packsmart-solutions@example.test/);
        assert.match(await page.locator('#startup-error').textContent(), /session is verified/);
        assert.equal(await page.locator('#startup-retry').textContent(), 'Check session');
        assert.equal(await page.locator('#login-screen').isVisible(), false);
        assert.equal(await page.locator('#app-shell').isVisible(), false);
      }
      const closedRequests = requests.slice(closedRequestStart);
      assert.equal(closedRequests.filter(r => r.path === '/api/auth/session').length, 2);
      assert.ok(closedRequests.every(r => r.method === 'GET'), 'closing checks never attempt a mutation');
      assert.ok(!closedRequests.some(r => ['/api/bootstrap', '/api/migrate-pilot'].includes(r.path)), 'closed-login browser never attempts dashboard/import work');
      assert.deepEqual(closed.fake.states.get(state.workspace.id), persisted);
      assert.ok(closed.calls.every(call => ['GET', 'HEAD'].includes(call.method)), 'closed-login identity cannot write');
      const closedFilename = `maintenance-login-closed-${width}.png`;
      await page.screenshot({ path: path.join(output, closedFilename), fullPage: true }); captures.push(closedFilename);
      closed.fake.states.get(state.workspace.id).users[0].sessionVersion++;
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator('#login-screen').waitFor({ state: 'visible' });
      databaseCalls.push(...closed.calls);
      assert.equal(f.fake.tables.size, 0);
      assert.equal(closed.fake.tables.size, 0);
    } finally { await context?.close(); await activeFixture?.close(); }
  }
  assert.equal(external, 0); assert.deepEqual(errors, []);
  assert.ok(!requests.some(r => ['/api/bootstrap', '/api/migrate-pilot'].includes(r.path)), 'maintenance never attempts dashboard/import work');
  const writes = databaseCalls.filter(call => !['GET', 'HEAD'].includes(call.method));
  assert.equal(writes.length, 2);
  assert.ok(writes.every(call => call.method === 'PATCH' && call.url.pathname.endsWith('/saas_workspace_state')));
  await fs.writeFile(path.join(output, 'browser-result.json'), JSON.stringify({ passed: true, browser: browser.version(), widths: [390, 1200], captures, requests, externalRequests: external, pageErrors: errors, auditWrites: writes.length, limits: ['Synthetic local transport and accounts', 'No hosted database/provider acceptance'] }, null, 2) + '\n');
  console.log('Maintenance login browser checks passed: invalid and successful sign-in, enabled-to-disabled restart, retained identity, reload/check without writes, revocation, no bootstrap/import/provider traffic.');
} finally { await browser?.close(); }
