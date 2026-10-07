// Real app, synthetic local tenant, and intercepted Fleet fixtures only.
// CI installs Playwright's pinned Chromium. No provider calls are permitted.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';

const complete = (cost = 0, requests = 0) => ({ status: 'complete', reason: null, totals: { estimatedCostUsd: cost, requests }, byModel: [] });
function fixture(status = 'partial') {
  const workspaces = [
    { workspaceId: 'packsmart-solutions', name: 'Synthetic complete workspace', aiUsageMonth: complete(), plan: 'growth', subscriptionStatus: 'active', dailyAiUnitLimit: 100, aiUnitsToday: 2 },
    { workspaceId: 'partial-tenant', name: 'Synthetic partial workspace', aiUsageMonth: { status: 'partial', reason: 'AI_USAGE_VOLATILE_STORE', totals: null }, plan: 'growth', subscriptionStatus: 'active' },
    { workspaceId: 'missing-tenant', name: 'Synthetic unavailable workspace', aiUsageMonth: { status: 'unavailable', reason: 'AI_USAGE_READ_UNAVAILABLE', totals: null }, plan: 'growth', subscriptionStatus: 'active' }
  ];
  if (status === 'complete') for (const workspace of workspaces) workspace.aiUsageMonth = complete();
  if (status === 'unavailable') for (const workspace of workspaces) delete workspace.aiUsageMonth;
  return { workspaces, totals: { workspaces: 3, aiUsageMonthStatus: status,
    aiEstimatedCostUsdMonth: status === 'complete' ? 0 : null, aiRequestsMonth: status === 'complete' ? 0 : null,
    aiUsageMonthCompleteWorkspaces: status === 'complete' ? 3 : status === 'partial' ? 1 : 0,
    aiUsageMonthPartialWorkspaces: status === 'partial' ? 1 : 0,
    aiUsageMonthUnavailableWorkspaces: status === 'unavailable' ? 3 : status === 'partial' ? 1 : 0 },
    aiProviderConfigured: status === 'complete', worker: {},
    modelCatalog: [{ model: 'synthetic-economy-model', provider: 'synthetic-provider', tier: 'economy', pricingUpdatedAt: '2026-09-01', inputPerMillionUsd: 1, cachedInputPerMillionUsd: 0.1, outputPerMillionUsd: 2 }]
  };
}
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-legacy-usage-browser-'));
const secret = 'legacy-usage-browser-test-only-secret-more-than-32-characters';
const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
  PACKSMART_ADMIN_EMAIL: 'legacy-admin@example.test', SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' });
let browser;
try {
  const state = seedWorkspaceState({}, { workspaceId: 'packsmart-solutions', name: 'Synthetic legacy admin', email: 'legacy-admin@example.test', passwordHash: 'fixture-only' });
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
    const page = await context.newPage(), errors = [], externalCalls = [], operatorCalls = [];
    let next = fixture();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { externalCalls.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/operator/')) return route.continue();
      operatorCalls.push({ path: url.pathname, method: route.request().method() });
      if (url.pathname !== '/api/operator/agent-ops') return route.abort();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(next) });
    });
    await page.goto(base);
    await page.locator('#app-shell:not(.hidden)').waitFor();
    if (await page.locator('#mobile-menu').isVisible()) await page.locator('#mobile-menu').click();
    await page.locator('#main-nav [data-view="fleet"]').click();
    await page.locator('[data-fleet-workspace]').first().waitFor();
    const cost = page.locator('#fleet-kpis .kpi').nth(4).locator('strong');
    const workspaceCost = id => page.locator(`[data-fleet-workspace="${id}"] .fleet-signal-grid > div`).nth(3).locator('b');
    const refresh = async data => {
      next = data;
      await page.locator('#fleet-refresh').click();
      await page.waitForFunction(() => !document.querySelector('#fleet-refresh').disabled);
    };
    for (const [status, label] of [['partial', 'Incomplete'], ['complete', '$0.0000'], ['unavailable', 'Unavailable']]) {
      await refresh(fixture(status));
      assert.equal(await cost.textContent(), label);
      assert.equal(await workspaceCost('packsmart-solutions').textContent(), status === 'unavailable' ? 'Unavailable' : '$0.0000');
      assert.equal(await workspaceCost('partial-tenant').textContent(), label);
      assert.equal(await workspaceCost('missing-tenant').textContent(), status === 'complete' ? '$0.0000' : 'Unavailable');
      const requestLine = await page.locator('#fleet-kpis .kpi').nth(4).locator('small').textContent();
      assert.equal(requestLine, status === 'complete' ? '0 recorded legacy requests' : `Legacy requests ${label.toLowerCase()}`);
      assert.equal(await page.locator('#fleet-ai-provider-status').textContent(), status === 'complete' ? 'Provider configured' : 'Provider not configured');
      const dimensions = await page.evaluate(() => ({
        width: innerWidth, scroll: document.documentElement.scrollWidth,
        panels: [...document.querySelectorAll('#view-fleet > .card, #view-fleet > .grid-2, #fleet-kpis .kpi, #fleet-workspaces .fleet-signal-grid > div')].map(panel => {
          const rect = panel.getBoundingClientRect();
          return { left: rect.left, right: rect.right, scroll: panel.scrollWidth, width: panel.clientWidth };
        })
      }));
      assert.ok(dimensions.scroll <= width + 2, `Fleet page overflow at ${width}px/${status}: ${JSON.stringify(dimensions)}`);
      for (const panel of dimensions.panels) {
        assert.ok(panel.scroll <= panel.width + 2, `Fleet panel overflow at ${width}px/${status}: ${JSON.stringify(panel)}`);
        assert.ok(panel.left >= -2 && panel.right <= width + 2, `Fleet panel escapes viewport at ${width}px/${status}: ${JSON.stringify(panel)}`);
      }
      await page.locator('#view-fleet').screenshot({ path: `/tmp/runvara-legacy-ai-usage-${width}-${status}.png` });
    }
    await refresh(fixture());
    await page.locator('#fleet-search').fill('Synthetic complete');
    assert.equal(await page.locator('[data-fleet-workspace]').count(), 1);
    assert.equal(await cost.textContent(), 'Incomplete', 'filtering must not turn mixed coverage into a complete fleet');
    await page.locator('#fleet-search').fill('');
    const hostile = '<img src=x onerror="window.legacyInjected=true">', hostileFixture = fixture('unavailable');
    hostileFixture.workspaces[0].name = hostile;
    hostileFixture.workspaces[0].aiUsageMonth = { status: hostile, reason: hostile, totals: { estimatedCostUsd: hostile, requests: hostile } };
    hostileFixture.modelCatalog[0].model = hostile; hostileFixture.modelCatalog[0].pricingUpdatedAt = hostile;
    await refresh(hostileFixture);
    assert.equal(await page.locator('#view-fleet img, #view-fleet script, #view-fleet [onerror]').count(), 0);
    assert.equal(await page.evaluate(() => window.legacyInjected), undefined);
    assert.equal(await workspaceCost('packsmart-solutions').textContent(), 'Unavailable');
    assert.match(await page.locator('#view-fleet').textContent(), /not complete provider billing or all provider spend/);
    assert.match(await page.locator('#view-fleet').textContent(), /these scopes must not be added together/);
    assert.match(await page.locator('#fleet-model-catalog').textContent(), /Catalogue dated <img/);
    assert.deepEqual(errors, []);
    assert.deepEqual(externalCalls, [], 'synthetic fixture must never contact external providers');
    assert.equal(operatorCalls.every(call => call.path === '/api/operator/agent-ops' && call.method === 'GET'), true, 'Fleet never fetches governed usage or performs mutations');
    await context.close();
  }
  console.log('Legacy usage completeness browser checks passed at 320, 390 and 1200 pixels with synthetic fixtures.');
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
