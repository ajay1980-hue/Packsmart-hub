import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { maintenanceFixture, ownerState, SECRET } from './maintenance-login-fixture.mjs';
import { upgradeState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { PILOT_SCHEMA, PILOT_BASE } from '../lib/quiet-approval-pilot.mjs';

const output = path.resolve(process.env.RUNVARA_MAINTENANCE_EVIDENCE_DIR || path.join(os.tmpdir(), 'runvara-quiet-approval-pilot'));
await fs.mkdir(output, { recursive: true });
const requests = [], errors = [], captures = [], results = [];
let browser, external = 0;
async function freePort() {
  const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  for (const width of [320, 390, 1200]) {
    const port = await freePort(), base = 'http://127.0.0.1:' + port, state = upgradeState(ownerState('alpha'), {});
    const d = { schema: PILOT_SCHEMA, workspaceId: 'alpha', ownerId: 'alpha-owner', requestId: randomUUID(),
      notBefore: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 590000).toISOString() };
    const env = { NODE_ENV: 'test', APP_PUBLIC_URL: base, RUNVARA_QUIET_OWNER_LOGIN: 'disabled/v1', RUNVARA_QUIET_COMMERCE_PREVIEW: 'disabled/v1', RUNVARA_QUIET_APPROVAL_PILOT: JSON.stringify(d) };
    let active = await maintenanceFixture({ states: [state], port, env }), context;
    try {
      const f = active;
      context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addCookies([{ name: 'packsmart_session', value: createSessionToken({ userId: state.users[0].id, workspaceId: 'alpha',
        email: state.users[0].email, role: 'owner', sessionVersion: 1 }, SECRET), url: base, httpOnly: true, sameSite: 'Strict' }]);
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const r = route.request(), url = new URL(r.url());
        if (url.origin !== base) { external++; return route.abort(); }
        requests.push({ width, method: r.method(), path: url.pathname }); return route.continue();
      });
      const count = op => requests.filter(r => r.width === width && r.path === PILOT_BASE + op).length;
      const panel = page.locator('#maintenance-approval-pilot');
      const button = text => panel.getByRole('button', { name: text, exact: true });
      await page.goto(base, { waitUntil: 'networkidle' }); await panel.waitFor();
      assert.equal(await page.locator('#loading-screen h1').textContent(), 'Signed in. Maintenance continues.');
      assert.equal(count('request'), 0); assert.equal(count('reconcile'), 0);
      assert.equal(await button('Reject test request').isDisabled(), true);
      for (const scale of [100, 200]) {
        await page.evaluate(value => { document.documentElement.style.fontSize = value + '%'; }, scale);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        const file = `pilot-${width}-${scale}.png`; captures.push(file); await page.screenshot({ path: path.join(output, file), fullPage: true });
      }
      await button('Create test request').focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('#maintenance-approval-pilot').textContent.includes('Test request confirmed.'));
      assert.equal(count('request'), 1);
      // Re-entry must not silently submit or reconcile; it retains the exact request.
      await page.reload({ waitUntil: 'networkidle' }); await panel.waitFor();
      assert.equal(count('request'), 1); assert.equal(count('reconcile'), 0);
      assert.equal(await button('Create test request').isDisabled(), true); assert.equal(await button('Reject test request').isDisabled(), true);
      await button('Check saved test').click();
      await page.waitForFunction(() => [...document.querySelectorAll('#maintenance-approval-pilot button')].find(b => b.textContent === 'Reject test request').disabled === false);
      await button('Reject test request').click();
      await page.waitForFunction(() => document.querySelector('#maintenance-approval-pilot').textContent.includes('Test rejection confirmed.'));
      assert.equal(count('reject'), 1); assert.equal(count('reconcile'), 1);
      const saved = structuredClone(f.fake.states.get('alpha'));
      assert.equal(saved.approvals.length, 1); assert.equal(saved.approvals[0].status, 'rejected'); assert.equal(saved.approvals[0].history.length, 1);
      assert.equal(saved.audit.filter(a => a.type === 'approval_requested').length, 1); assert.equal(saved.audit.filter(a => a.type === 'approval_decided').length, 1);
      assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 2);
      const finalFile = `pilot-rejected-${width}.png`; captures.push(finalFile); await page.screenshot({ path: path.join(output, finalFile), fullPage: true });
      assert.equal(await page.locator('#app-shell').isVisible(), false); assert.equal(await page.locator('#maintenance-commerce').count(), 0);
      await f.close(); active = null;
      active = await maintenanceFixture({ states: [saved], port, env: { ...env, RUNVARA_QUIET_APPROVAL_PILOT: 'disabled/v1' } });
      await page.reload({ waitUntil: 'networkidle' });
      assert.equal(await page.locator('#loading-screen h1').textContent(), 'Signed in. Maintenance continues.'); assert.equal(await panel.count(), 0);
      assert.deepEqual(active.fake.states.get('alpha'), saved); assert.ok(active.calls.every(c => c.method === 'GET'));
      results.push({ width, creates: count('request'), rejections: count('reject'), explicitReconciliations: count('reconcile'), primaryWrites: 2, closedWithoutWrites: true });
    } finally { await context?.close(); await active?.close(); }
  }
  assert.equal(external, 0); assert.deepEqual(errors, []);
  assert.ok(requests.every(r => !r.path.startsWith('/api/') || r.path === '/api/auth/session' || ['request','reconcile','reject'].some(op => r.path === PILOT_BASE + op)), 'no bootstrap, import, login, preview or provider requests');
  await fs.writeFile(path.join(output, 'browser-result.json'), JSON.stringify({ passed: true, browser: browser.version(), captures, results, requests,
    externalRequests: external, pageErrors: errors, limitations: ['Synthetic localhost accounts, cookies and database transport', 'No hosted/provider acceptance'] }, null, 2) + '\n');
  console.log('Pilot browser checks passed: six responsive/enlarged views, explicit create/reconcile/reject only, retained identity on reload, closed maintenance presentation and zero external requests.');
} finally { await browser?.close(); }
