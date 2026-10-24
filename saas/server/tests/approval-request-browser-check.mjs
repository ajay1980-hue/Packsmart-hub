// Synthetic localhost app and transport only; never uses an existing browser profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { approvalFixture } from './approval-request-fixture.mjs';
const output = path.resolve(process.env.RUNVARA_APPROVAL_BROWSER_EVIDENCE || 'approval-request-browser-evidence');
await fs.mkdir(output, { recursive: true });
const cleanup = [], fixture = await approvalFixture({ after: fn => cleanup.push(fn), mock: { method() {} } });
const base = 'http://127.0.0.1:' + fixture.servers[0].address().port;
let browser, external = 0;
const cases = [], captures = [];
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  for (const width of [320, 390, 1200]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    try {
      // The HTTP fixture's public origin is HTTPS and expects its __Host cookie.
      // Inject only this synthetic fixture identity into localhost transport.
      const identity = fixture.auth();
      const page = await context.newPage(), errors = [], requests = []; let first = true;
      page.on('pageerror', error => errors.push(error.message));
      const responses = [];
      page.on('response', response => responses.push({ path: new URL(response.url()).pathname, status: response.status() }));
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== base) { external++; return route.abort(); }
        if (url.pathname === '/api/actions' || url.pathname === '/api/actions/reconcile') {
          requests.push({ path: url.pathname, body: request.postDataJSON() });
          const result = await fixture.request(request.postDataJSON(), { reconcile: url.pathname.endsWith('/reconcile') });
          if (first) { first = false; assert.equal(result.status, 202); return route.abort('failed'); }
          return route.fulfill({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.body) });
        }
        if (url.pathname.startsWith('/api/')) {
          assert.equal(request.method(), 'GET', 'only the declared action routes may mutate this synthetic fixture');
          const response = await fetch(url, { headers: identity });
          return route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
        }
        return route.continue();
      });
      const openApprovals = async () => {
        try { await page.locator('#app-shell').waitFor({ state: 'visible', timeout: 10000 }); }
        catch (error) {
          throw new Error(JSON.stringify({ errors, responses, startup: await page.locator('#startup-error').textContent(), login: await page.locator('#login-error').textContent() }), { cause: error });
        }
        // Invoke the existing navigation control; a hidden mobile sidebar is not a request.
        await page.locator('[data-view="approvals"]').first().evaluate(node => node.click());
        await page.locator('.approval-create > summary').click();
        await page.locator('#approval-form').waitFor({ state: 'visible' });
      };
      await page.goto(base); await openApprovals();
      const form = page.locator('#approval-form');
      await form.locator('[name=type]').selectOption('customer_facing_publish');
      for (const [name, value] of Object.entries({ action: 'Synthetic request ' + width, reason: 'Confirm one retained intent', expectedBenefit: 'Safe retry', risk: 'No provider connected' })) await form.locator(`[name=${name}]`).fill(value);
      const before = fixture.calls.commits;
      await form.locator('button[type=submit]').click();
      const panel = page.locator('#approval-form + div');
      await panel.getByText(/Outcome unknown/).waitFor();
      assert.equal(requests.length, 1); assert.equal(fixture.calls.commits, before + 1);
      const unknownPath = path.join(output, `${width}-unknown.png`);
      await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: unknownPath }); captures.push(unknownPath);
      await page.reload(); await openApprovals();
      await panel.getByText(/previous request is retained/).waitFor();
      assert.equal(requests.length, 1, 'reload never creates or reconciles automatically');
      const beforeCheck = fixture.calls.commits;
      await panel.getByRole('button', { name: 'Check saved request', exact: true }).click();
      await panel.getByText('Saved request confirmed. No external action was executed.').waitFor();
      assert.equal(requests.length, 2, JSON.stringify(requests)); assert.equal(requests[1].path, '/api/actions/reconcile');
      assert.deepEqual(requests[1].body, requests[0].body);
      assert.equal(fixture.calls.commits, beforeCheck, 'reconciliation performs no save');
      const approvals = fixture.states.get('alpha').approvals.filter(row => row.requestIdentity?.requestId === requests[0].body.requestId);
      assert.equal(approvals.length, 1);
      assert.equal(fixture.states.get('alpha').audit.filter(row => row.type === 'approval_requested' && row.detail.approvalId === approvals[0].id).length, 1);
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no page overflow');
      const confirmedPath = path.join(output, `${width}-confirmed.png`);
      await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: confirmedPath }); captures.push(confirmedPath);
      cases.push({ width, requests: requests.length, approvalCreations: 1, creationAuditEntries: 1, reconciliationSaves: 0,
        bootstrapSavesOnReload: beforeCheck - before - 1, errors });
    } finally { await context.close(); }
  }
  assert.equal(external, 0);
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'PASS', cases, external, providerCalls: fixture.calls.providers, captures }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', cases, external }));
} finally {
  await browser?.close();
  for (const close of cleanup) await close();
}
