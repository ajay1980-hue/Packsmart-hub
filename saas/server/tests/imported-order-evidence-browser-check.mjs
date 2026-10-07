// Real Command/Analytics + the real local server, with synthetic orders only.
// SaaS CI supplies its pinned Chromium. No browser install or fallback is performed here.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-imported-evidence-browser-'));
const secret = 'imported-evidence-browser-synthetic-secret-more-than-32-characters';
const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
  SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' }, { schedulerEnabled: false, agentOpsEnabled: false });
const exactEuro = '9007199254740993.123456';
let browser;
try {
  const state = seedWorkspaceState({}, { workspaceId: 'imported-browser', name: 'Synthetic imported evidence', email: 'evidence@example.test', passwordHash: 'fixture-only' });
  const createdAt = new Date(Date.now() - 60_000).toISOString();
  const rawOrder = (id, fields = {}) => ({ id, externalId: id, provider: 'shopify', name: id, createdAt, currency: 'GBP', financialStatus: 'PAID', fulfillmentStatus: 'FULFILLED',
    total: '100', currentTotal: '100', refunds: '0', tax: '0', currentTax: '0', discounts: '0', shippingCharged: '0',
    lineItems: [{ id: 'line-' + id, sku: 'COSTED', name: 'Synthetic recorded line', quantity: '1', gross: '100', net: '100' }], ...fields });
  state.products = [];
  state.orders = [
    rawOrder('costed'),
    rawOrder('uncosted', { total: '900', currentTotal: '900', refunds: null, lineItems: [{ id: 'uncosted-line', sku: 'MISSING-COST', quantity: '1', gross: '900', net: '900' }] }),
    rawOrder('usd-negative', { provider: 'ebay', currency: 'USD', total: '20', currentTotal: '-12.345678' }),
    rawOrder('eur-exact', { currency: 'EUR', total: exactEuro, currentTotal: exactEuro }),
    rawOrder('pending-zero', { currency: 'ZZZ', currentTotal: '0', financialStatus: 'PENDING', cancelledAt: createdAt }),
    rawOrder('currency-unknown', { currency: null, currentTotal: '40' })
  ];
  state.economics.COSTED = { landed: '30', supplierDelivery: '0', supplierVatRate: '0', supplierVatRecoverable: true,
    packing: '0', handling: '0', delivery: '0', paymentFee: '0', channelFee: '0', advertising: '0', otherVariable: '0' };
  state.advertisingCosts = [{ id: 'synthetic-ad', date: createdAt.slice(0, 10), channel: 'synthetic', currency: 'USD', spend: '0.123456', attributableRevenue: '7.654321' }];
  await server.packsmart.store.save(state.workspace.id, state);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  browser = await chromium.launch({ headless: true });
  for (const width of [320, 390, 1200]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addCookies([{ name: 'packsmart_session', value: token, url: base, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage(), errors = [], external = [], writes = [], apiCalls = [];
    page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base) { external.push(url.origin); return route.abort(); }
      if (request.method() !== 'GET') { writes.push(request.method() + ' ' + url.pathname); return route.abort(); }
      if (url.pathname.startsWith('/api/')) apiCalls.push(url.pathname);
      return route.continue();
    });
    const navigate = async view => {
      if (await page.locator('#mobile-menu').isVisible()) await page.locator('#mobile-menu').click();
      await page.locator(`#main-nav [data-view="${view}"]`).click();
      await page.locator(`#view-${view}.active`).waitFor();
    };
    const inspectCohorts = async selector => {
      const root = page.locator(selector);
      const commandDetails = root.locator(':scope > .imported-evidence-cohorts');
      if (await commandDetails.count()) {
        assert.equal(await commandDetails.getAttribute('open'), null, 'Command keeps exact groups available on demand');
        assert.equal(await root.locator('.imported-evidence-table').isVisible(), false);
        await commandDetails.locator(':scope > summary').click();
      }
      await root.locator('.imported-evidence-table').waitFor();
      assert.equal(await root.locator(':scope > .imported-evidence-warning').isVisible(), true);
      const provenance = root.locator(':scope > .imported-evidence-provenance');
      assert.equal(await provenance.getAttribute('open'), null, 'detailed provenance is optional');
      await provenance.locator('summary').click();
      assert.equal(await provenance.locator('ul').isVisible(), true);
      assert.match(await provenance.textContent(), /Recorded order dates: .* \(inclusive\) to .* \(exclusive\)/);
      assert.match(await provenance.textContent(), /importer defaults or derived values/);
      assert.match(await provenance.textContent(), /Source-period coverage is unverified for every provider/);
      await provenance.locator('summary').click();
      assert.equal(await root.locator('svg').count(), 0, 'imported currencies cannot share a monetary plot');
      const rows = await root.locator('tbody > tr').evaluateAll(elements => elements.map(row => [...row.cells].map(cell => cell.textContent)));
      assert.equal(rows.length, 5, 'retained provider/currency/status/cancellation cohorts stay separate');
      const byCurrency = currency => rows.find(row => row[1].startsWith(currency));
      const gbp = byCurrency('GBP');
      assert.equal(gbp[0], 'Shopify'); assert.equal(gbp[2], 'PAID'); assert.equal(gbp[4], '2');
      assert.match(gbp[1], /unverified recorded code/);
      assert.match(gbp[5], /^1000Known subtotal · 2 known \/ 0 unknown/);
      assert.match(gbp[6], /^0Known subtotal · 1 known \/ 1 unknown/);
      assert.match(gbp[6], /Complete retained cohort: Unavailable/);
      assert.match(gbp[7], /1 \/ 2 retained orders/);
      const usd = byCurrency('USD'); assert.equal(usd[0], 'Ebay'); assert.match(usd[5], /^-12\.345678Known subtotal/);
      assert.ok(byCurrency('EUR')[5].startsWith(exactEuro + 'Known subtotal'), 'exact decimal above Number precision is retained');
      const zzz = byCurrency('ZZZ'); assert.equal(zzz[2], 'PENDING'); assert.equal(zzz[3], 'Cancelled'); assert.match(zzz[5], /^0Known subtotal/);
      const unknown = byCurrency('Unknown currency'); assert.match(unknown[5], /^UnknownKnown subtotal · 1 known \/ 0 unknown/);
      const text = await root.textContent();
      assert.match(text, /Source period unverified/);
      assert.match(text, /not verified business revenue, profit or collected cash/);
      assert.match(text, /Financial qualification unavailable/);
      assert.doesNotMatch(text, /£|\$|€|Grand total|Combined revenue|Net revenue total|\.\.\.|…/i);
      assert.equal(await root.locator('tfoot').count(), 0, 'no cross-currency total row');
      const gbpDetails = root.locator('tbody > tr').filter({ hasText: 'GBP · unverified recorded code' }).locator('details');
      await gbpDetails.locator('summary').click();
      assert.match(await gbpDetails.textContent(), /Exact numeric cost \/ net amount coverage100 \/ 1000/);
      assert.match(await gbpDetails.textContent(), /Recorded current tax/);
      await gbpDetails.locator('summary').click();
      await assertContained([selector, selector + ' .imported-evidence-cohorts']);
      if (await commandDetails.count()) {
        await commandDetails.locator(':scope > summary').click();
        assert.equal(await root.locator('.imported-evidence-table').isVisible(), false);
        assert.equal(await root.locator(':scope > .imported-evidence-warning').isVisible(), true, 'the warning stays visible when exact groups are closed');
      }
    };
    const resetCapturePosition = async () => {
      // Inspection scrolls tables and focuses controls. Capture the real at-rest view.
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        for (const element of document.querySelectorAll('.view.active .table-wrap, .sidebar, main')) element.scrollTo({ left: 0, top: 0, behavior: 'instant' });
        window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
      });
      await page.waitForFunction(() => window.scrollX === 0 && window.scrollY === 0 && [...document.querySelectorAll('.view.active .table-wrap')].every(element => element.scrollLeft === 0 && element.scrollTop === 0));
      assert.equal(await page.locator('.skip-link').evaluate(element => element.matches(':focus')), false, 'fixture focus does not appear in screenshots');
    };
    const assertContained = async selectors => {
      const dimensions = await page.evaluate(selectors => ({ page: document.documentElement.scrollWidth, width: innerWidth,
        panels: selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(element => element.getClientRects().length).map(element => {
          const rect = element.getBoundingClientRect();
          return { selector, element: element.tagName.toLowerCase(), id: element.id, className: element.className,
            scroll: element.scrollWidth, available: element.clientWidth, left: rect.left, right: rect.right };
        })) }), selectors);
      assert.ok(dimensions.page <= width + 2, `page overflow at ${width}px: ${JSON.stringify(dimensions)}`);
      for (const panel of dimensions.panels) {
        assert.ok(panel.scroll <= panel.available + 2, `panel overflow at ${width}px: ${JSON.stringify(panel)}`);
        assert.ok(panel.left >= -2 && panel.right <= width + 2, `panel escapes ${width}px viewport: ${JSON.stringify(panel)}`);
      }
      // Tables may scroll within their explicit container, without expanding the panel/page.
      const containers = await page.locator('.view.active .table-wrap:visible').evaluateAll(elements => elements.map(element => ({ overflow: getComputedStyle(element).overflowX, width: element.clientWidth, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right })));
      for (const container of containers) {
        assert.ok(['auto', 'scroll'].includes(container.overflow), 'wide evidence tables keep a usable scrolling container');
        assert.ok(container.width > 0 && container.left >= -2 && container.right <= width + 2, 'table container stays in viewport');
      }
    };
    try {
      await page.goto(base); await page.locator('#app-shell:not(.hidden)').waitFor();
      const callsAfterBootstrap = [...apiCalls];
      await inspectCohorts('#revenue-trajectory');
      for (const id of ['today-revenue', 'today-profit', 'today-margin', 'hg-coverage']) assert.equal(await page.locator('#' + id).textContent(), 'Unavailable', id);
      await page.locator('[data-period="week"]').click();
      assert.equal(await page.locator('#week-metrics').isVisible(), true);
      await page.locator('#week-metrics > details > summary').click();
      await assertContained(['#revenue-trajectory', '.period-card', '#week-metrics', '#view-overview .period-block .kpi']);
      await page.locator('#week-metrics > details > summary').click();
      await page.locator('[data-period="month"]').click();
      assert.equal(await page.locator('#month-metrics').isVisible(), true);
      assert.equal(await page.locator('#revenue-trajectory > .imported-evidence-cohorts').getAttribute('open'), null);
      await resetCapturePosition();
      await page.screenshot({ path: `/tmp/runvara-imported-order-command-${width}.png`, fullPage: true });

      await navigate('analytics');
      await inspectCohorts('#analytics-channel-table');
      for (const id of ['analytics-revenue', 'analytics-profit', 'analytics-margin', 'analytics-ad-spend', 'analytics-roas']) assert.equal(await page.locator('#' + id).textContent(), 'Unavailable', id);
      assert.equal(await page.locator('#analytics-orders').textContent(), '6');
      assert.match(await page.locator('#analytics-marketing').textContent(), /0\.123456/);
      assert.match(await page.locator('#analytics-marketing').textContent(), /7\.654321/);
      assert.match(await page.locator('#analytics-marketing').textContent(), /totals and ROAS are unavailable/);
      assert.doesNotMatch(await page.locator('#analytics-marketing').textContent(), /£|\$|×/);
      await assertContained(['#analytics-channel-table', '#analytics-marketing', '#analytics-coverage', '#view-analytics .kpi', '#view-analytics .card']);
      const layout = await page.evaluate(() => {
        const bounds = selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width }; };
        return { view: bounds('#view-analytics'), cohorts: bounds('.analytics-cohorts-card'), secondary: bounds('.analytics-secondary-grid'),
          providers: bounds('.analytics-providers-card'), coverage: bounds('.analytics-coverage-card'), advertising: bounds('.analytics-advertising-card'),
          alignment: getComputedStyle(document.querySelector('.analytics-secondary-grid')).alignItems };
      });
      assert.ok(Math.abs(layout.cohorts.width - layout.view.width) <= 2, 'cohort evidence uses the full Analytics row');
      assert.ok(layout.secondary.top >= layout.cohorts.bottom, 'secondary cards are below the complete evidence row');
      assert.equal(layout.alignment, 'start', 'secondary cards keep independent heights');
      if (width === 1200) {
        assert.ok(Math.abs(layout.providers.top - layout.coverage.top) <= 2, 'provider counts and coverage share a compact desktop row');
        assert.ok(layout.providers.right < layout.coverage.left, 'secondary cards use distinct desktop columns');
        assert.ok(layout.advertising.top >= Math.max(layout.providers.bottom, layout.coverage.bottom), 'advertising follows the compact secondary cards');
        assert.ok(Math.abs(layout.advertising.width - layout.view.width) <= 2, 'advertising columns have a readable full row');
      }
      await resetCapturePosition();
      await page.screenshot({ path: `/tmp/runvara-imported-order-analytics-${width}.png`, fullPage: true });
      await navigate('overview'); await navigate('analytics');
      assert.deepEqual(apiCalls, callsAfterBootstrap, 'navigation, period toggles and opening evidence never fetch or poll');
      assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, [], 'evidence review never writes or contacts providers');
    } catch (error) {
      await page.screenshot({ path: `/tmp/runvara-imported-order-failure-${width}.png`, fullPage: true }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
  console.log('Imported-order Command/Analytics browser checks passed at 320, 390 and 1200 pixels using synthetic mixed-currency and missing-cost records.');
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
