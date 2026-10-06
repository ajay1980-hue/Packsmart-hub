// Real app + synthetic local tenant and intercepted ledger fixtures only.
// Run after Playwright's pinned Chromium is installed (the SaaS CI does this).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-usage-browser-'));
const secret = 'provider-usage-browser-test-only-secret-more-than-32-characters';
const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
  PACKSMART_ADMIN_EMAIL: 'usage-admin@example.test', SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' });
const fixture = {
  available: true, source: 'governed_reservations_only', excludesLegacyUsage: true, excludesProviderBill: true,
  currency: 'USD', admissionMonth: '2026-10', workspaceId: 'packsmart-solutions',
  scopes: [
    { scopeKey: 'tenant', settled: { requests: 2, inputTokens: 3000, outputTokens: 1000, totalTokens: 4000, costMicros: 1250000 }, held: { requests: 1, inputTokens: 4000, outputTokens: 1000, totalTokens: 5000, costMicros: 750000 } },
    { scopeKey: 'provider:openai', settled: { requests: 2, inputTokens: 3000, outputTokens: 1000, totalTokens: 4000, costMicros: 1250000 }, held: { requests: 1, inputTokens: 4000, outputTokens: 1000, totalTokens: 5000, costMicros: 750000 } }
  ]
};
let browser;
try {
  const state = seedWorkspaceState({}, { workspaceId: 'packsmart-solutions', name: 'Synthetic usage admin', email: 'usage-admin@example.test', passwordHash: 'fixture-only' });
  state.products = [];
  await server.packsmart.store.save(state.workspace.id, state);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  browser = await chromium.launch({ headless: true });
  for (const width of [320, 390, 1200]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addCookies([{ name: 'packsmart_session', value: token, url: base, httpOnly: true, sameSite: 'Strict' }]);
    await context.addInitScript(() => localStorage.setItem('packsmart-saas-cloud-migration-v3:packsmart-solutions', 'fixture-complete'));
    const page = await context.newPage(), errors = [], ledgerCalls = [], externalCalls = [];
    let next = structuredClone(fixture), release = null, hold = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { externalCalls.push(url.origin); return route.abort(); }
      if (url.pathname !== '/api/operator/provider-usage') return route.continue();
      ledgerCalls.push({ method: route.request().method(), workspaceId: url.searchParams.get('workspaceId'), month: url.searchParams.get('month') });
      if (hold) await new Promise(resolve => { release = resolve; });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(next) });
    });
    await page.goto(base);
    await page.locator('#app-shell:not(.hidden)').waitFor();
    assert.equal(ledgerCalls.length, 0, 'startup never inspects provider usage automatically');
    if (await page.locator('#mobile-menu').isVisible()) await page.locator('#mobile-menu').click();
    await page.locator('#main-nav [data-view="fleet"]').click();
    await page.locator('#fleet-provider-usage-workspace option').first().waitFor({ state: 'attached' });
    const button = page.locator('#fleet-provider-usage-refresh');
    const details = page.locator('details').filter({ has: button });
    const result = page.locator('#fleet-provider-usage-result');
    await details.locator('summary').click();
    await page.locator('#fleet-provider-usage-month').fill('2026-10');
    assert.equal(ledgerCalls.length, 0, 'fleet navigation and opening the panel are read-free');
    await button.click();
    await result.getByText('provider:openai', { exact: false }).waitFor();
    assert.deepEqual(ledgerCalls, [{ method: 'GET', workspaceId: 'packsmart-solutions', month: '2026-10' }]);
    assert.match(await result.textContent(), /Tenant and provider rows overlap; do not add them together/);
    await details.locator('summary').click(); await details.locator('summary').click();
    assert.equal(ledgerCalls.length, 1, 'details reopening never polls');

    next = { available: false, reason: 'AI_USAGE_MIGRATION_REQUIRED' }; hold = true;
    await button.evaluate(element => { element.click(); element.click(); element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await page.waitForFunction(() => document.querySelector('#fleet-provider-usage-refresh').disabled);
    for (let attempt = 0; attempt < 200 && !release; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(typeof release, 'function', 'pending synthetic request was observed within two seconds');
    assert.equal(ledgerCalls.length, 2, 'double clicks issue exactly one pending request');
    assert.equal(await page.locator('#fleet-provider-usage-workspace').isDisabled(), true);
    assert.equal(await page.locator('#fleet-provider-usage-month').isDisabled(), true);
    release(); hold = false;
    await result.getByText('Governed accounting is unavailable:', { exact: false }).waitFor();
    assert.match(await result.textContent(), /does not mean zero provider spend/);
    assert.doesNotMatch(await result.textContent(), /\$0|0 settled requests/);

    const hostile = '<img src=x onerror="window.usageInjected=true">';
    next = { available: true, admissionMonth: hostile, scopes: [{ scopeKey: hostile, settled: { requests: hostile, totalTokens: hostile }, held: {} }] };
    await button.click();
    await result.getByText(hostile, { exact: false }).first().waitFor();
    assert.equal(await result.locator('img,script,[onerror]').count(), 0);
    assert.equal(await page.evaluate(() => window.usageInjected), undefined);

    // A maximum-length legitimate custom provider label tests worst-case layout.
    next = structuredClone(fixture);
    next.scopes[1].scopeKey = `provider:custom:${'s'.repeat(48)}`;
    await button.click();
    await result.getByText(next.scopes[1].scopeKey, { exact: false }).waitFor();
    await details.screenshot({ path: `/tmp/runvara-provider-usage-${width}.png` });
    const dimensions = await page.evaluate(() => {
      const panel = document.querySelector('#fleet-provider-usage-refresh').closest('details');
      const rect = panel.getBoundingClientRect();
      return { scroll: document.documentElement.scrollWidth, width: innerWidth, panelScroll: panel.scrollWidth, panelWidth: panel.clientWidth, left: rect.left, right: rect.right };
    });
    assert.ok(dimensions.scroll <= dimensions.width + 2, `page overflow at ${width}px: ${JSON.stringify(dimensions)}`);
    assert.ok(dimensions.panelScroll <= dimensions.panelWidth + 2, `ledger overflow at ${width}px: ${JSON.stringify(dimensions)}`);
    assert.ok(dimensions.left >= -2 && dimensions.right <= width + 2, `ledger escapes ${width}px viewport`);
    assert.deepEqual(errors, []);
    assert.deepEqual(externalCalls, [], 'fixtures must not contact providers or other external services');
    assert.equal(ledgerCalls.every(call => call.method === 'GET'), true);
    await context.close();
  }
  console.log('Governed usage browser checks passed at 320, 390 and 1200 pixels using synthetic ledger fixtures.');
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
