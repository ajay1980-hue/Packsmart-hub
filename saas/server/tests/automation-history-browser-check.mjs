// Responsive real-app history checks with synthetic records and intercepted archive reads.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { automationArchivePayloadDigest, isAutomationArchiveStub } from '../lib/automation-retention.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-history-browser-'));
const secret = 'automation-history-browser-fixture-more-than-thirty-two-characters';
const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret, SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' });
let browser;
try {
  const state = seedWorkspaceState({}, { workspaceId: 'history-browser', name: 'Synthetic check history', email: 'history@example.test', passwordHash: 'fixture-only' });
  state.products = [];
  const now = new Date().toISOString(), hostile = '<img src=x onerror="window.historyInjected=true">';
  const full = { id: 'automation/history?synthetic=1', workspaceId: state.workspace.id, ruleId: 'profitGuard', status: 'COMPLETED', startedAt: now, completedAt: now, risk: 'low', spend: 0, errorCode: null,
    evidence: [{ type: 'recorded_check', id: 'source_fixture', detail: 'Archived synthetic evidence: ' + 'long-recorded-source-detail'.repeat(10) }, { type: 'recorded_check', id: hostile, detail: hostile }] };
  const sha256 = automationArchivePayloadDigest(full);
  const archive = { schema: 'runvara-automation-run-archive/v1', table: 'runvara_history', workspaceId: state.workspace.id, collection: 'automationRuns', runId: full.id,
    recordId: 'automation-v1:' + createHash('sha256').update(JSON.stringify([state.workspace.id, full.id, sha256])).digest('hex'), sha256 };
  const stub = { id: full.id, ruleId: full.ruleId, status: full.status, startedAt: now, completedAt: now, risk: full.risk, spend: 0, errorCode: null, evidence: [], evidenceCount: full.evidence.length, archive };
  assert.ok(isAutomationArchiveStub(stub, state.workspace.id));
  state.automationRuns = [
    { ...full, id: 'automation_active', status: 'IN PROGRESS', completedAt: null, evidence: [{ type: 'recorded_check', detail: 'Active check retained evidence' }] },
    stub,
    { ...full, id: 'automation_failed', status: 'FAILED', errorCode: 'SYNTHETIC_FAILURE', evidence: [{ type: 'failure_context', detail: 'Failed check retained evidence' }] }
  ];
  await server.packsmart.store.save(state.workspace.id, state);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  browser = await chromium.launch({ headless: true });
  for (const width of [320,390,1200]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addCookies([{ name: 'packsmart_session', value: token, url: base, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage(), errors = [], calls = [], writes = [], external = [];
    let hold = true, release = null;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() !== 'GET') writes.push(request.method() + ' ' + new URL(request.url()).pathname); });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { external.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/automation-runs/')) return route.continue();
      calls.push({ path: url.pathname, query: [...url.searchParams.keys()].sort(), method: route.request().method() });
      assert.equal(url.pathname, '/api/automation-runs/' + encodeURIComponent(full.id) + '/archive');
      assert.equal(url.searchParams.get('recordId'), archive.recordId); assert.equal(url.searchParams.get('sha256'), archive.sha256);
      if (hold) await new Promise(resolve => { release = resolve; });
      return route.fulfill({ json: { workspaceId: state.workspace.id, runId: full.id, run: full, source: 'immutable_automation_archive' } });
    });
    const openHistory = async () => {
      if (await page.locator('#mobile-menu').isVisible()) await page.locator('#mobile-menu').click();
      await page.locator('#main-nav [data-view="automations"]').click();
      const panel = page.locator('#automation-history-panel'); assert.equal(await panel.getAttribute('open'), null);
      await panel.locator(':scope > summary').click(); return panel;
    };
    await page.goto(base); await page.locator('#app-shell:not(.hidden)').waitFor();
    assert.equal(calls.length, 0, 'startup never hydrates archived evidence');
    const panel = await openHistory(), root = page.locator('#automation-history-list');
    assert.equal(calls.length, 0, 'navigation and opening history never hydrate evidence');
    assert.match(await root.textContent(), /Active check retained evidence/); assert.match(await root.textContent(), /Failed check retained evidence/);
    assert.match(await root.textContent(), /2 evidence items retained/); assert.doesNotMatch(await root.textContent(), /Archived synthetic evidence/);
    assert.equal((await root.innerHTML()).includes(archive.recordId), false); assert.equal((await root.innerHTML()).includes(sha256), false);
    const button = root.locator('[data-read-automation-archive]');
    await button.evaluate(element => { element.click(); element.click(); element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await root.locator('[aria-busy="true"]').waitFor();
    for (let i = 0; i < 200 && !release; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(typeof release, 'function'); assert.equal(calls.length, 1); assert.equal(await button.isDisabled(), true);
    assert.deepEqual(calls[0].query, ['recordId', 'sha256']); assert.equal(calls[0].method, 'GET');
    hold = false; release();
    await root.getByText('Archived synthetic evidence:', { exact: false }).waitFor();
    assert.equal(await button.textContent(), 'Archived evidence loaded'); assert.equal(await root.locator('img,script,[onerror]').count(), 0);
    assert.equal(await page.evaluate(() => window.historyInjected), undefined);
    await panel.locator(':scope > summary').click(); await panel.locator(':scope > summary').click(); assert.equal(calls.length, 1, 'successful evidence is reused without requests');
    await panel.screenshot({ path: `/tmp/runvara-automation-history-${width}.png` });
    const dimensions = await page.evaluate(() => {
      const panel = document.querySelector('#automation-history-panel');
      return { width: innerWidth, page: document.documentElement.scrollWidth, panel: panel.scrollWidth, available: panel.clientWidth };
    });
    assert.ok(dimensions.page <= width + 2 && dimensions.panel <= dimensions.available + 2, `history overflow at ${width}px: ${JSON.stringify(dimensions)}`);
    await page.reload(); await page.locator('#app-shell:not(.hidden)').waitFor(); await openHistory();
    assert.equal(calls.length, 1, 'new snapshot waits for another explicit read');
    assert.doesNotMatch(await root.textContent(), /Archived synthetic evidence/);
    await button.click(); await root.getByText('Archived synthetic evidence:', { exact: false }).waitFor(); assert.equal(calls.length, 2);
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, [], 'history never changes automation policies or executes actions');
    await context.close();
  }
  console.log('Automation history browser checks passed at 320, 390 and 1200 pixels using synthetic evidence.');
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
