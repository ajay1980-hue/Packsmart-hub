// Synthetic outcome transport, production app, 3 real viewports and exact 200%
// affected-subtree typography. This script runs only in the existing CI browser
// gate; no provider, protected ledger, real SQL or publication is contacted.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken, hashPassword } from '../lib/security.mjs';
import { receiptUiFixture } from './business-outcomes-receipt-ui-fixture.mjs';
import { createRestrictionTypographySession } from './objective-browser-typography.mjs';
import { createOutcomeViewportSession } from './business-outcomes-browser-capture.mjs';
const clone = structuredClone, captures = [], results = [], secret = 'protected-receipt-browser-fixture-more-than-thirty-two-characters';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message) { for (let n = 0; n < 250; n++) { if (fn()) return; await delay(10); } assert.fail(message); }
async function navigate(page, view) {
  if (await page.locator('#mobile-menu').isVisible() && await page.locator('#mobile-menu').getAttribute('aria-expanded') !== 'true') await page.locator('#mobile-menu').click();
  await page.locator(`#main-nav [data-view="${view}"]`).click(); await page.locator(`#view-${view}.active`).waitFor();
}
async function readable(page, locator, width, { screenshot = null } = {}) {
  const viewport = await locator.evaluateHandle(createOutcomeViewportSession);
  try {
    await viewport.evaluate(s => s.reveal(0));
    const b = await viewport.evaluate(s => s.bounds());
    const metrics = await locator.evaluate(el => {
      const range = document.createRange(); range.selectNodeContents(el);
      return { text: el.textContent, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, width: document.documentElement.scrollWidth,
        visibility: getComputedStyle(el).visibility, lines: [...range.getClientRects()].map(r => ({ left: r.left, right: r.right, height: r.height })) };
    });
    assert.equal(metrics.visibility, 'visible'); assert.ok(metrics.width <= width + 2, 'document stays within viewport');
    assert.ok(b.left >= b.visibleLeft - 2 && b.right <= b.visibleRight + 2 && metrics.scrollWidth <= metrics.clientWidth + 2, 'source or control fits horizontally: ' + JSON.stringify(b));
    assert.ok(b.height > 0 && b.to > b.from, 'element remains reachable by live scrolling');
    for (const line of metrics.lines) assert.ok(line.left >= b.visibleLeft - 2 && line.right <= b.visibleRight + 2, 'text is not clipped horizontally');
    if (await locator.evaluate(el => el.matches('button,input,select'))) {
      assert.ok(b.from <= 1 && b.to >= b.height - 1, 'entire interactive control is visible below fixed chrome');
      await locator.focus(); assert.equal(await locator.evaluate(el => document.activeElement === el), true);
    }
    if (screenshot) {
      const file = `/tmp/runvara-receipt-outcomes-${width}-${screenshot}.png`;
      await page.screenshot({ path: file, fullPage: false, caret: 'initial' }); captures.push({ width, file, bounds: b });
    }
  } finally { await viewport.dispose(); }
}
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  for (const width of [320, 390, 1200]) {
    // Per-viewport synthetic server retains the production rate limiter unchanged.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'receipt-outcomes-browser-'));
    const base = 'http://127.0.0.1:18879', f = receiptUiFixture({ workspaceId: 'receipt-browser-' + width });
    const server = createPacksmartServer({ NODE_ENV: 'test', APP_PUBLIC_URL: base, SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
      SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' }, { schedulerEnabled: false, agentOpsEnabled: false });
    let context;
    try {
      const state = seedWorkspaceState({}, { workspaceId: f.workspaceId, userId: 'owner_one', name: 'Synthetic protected receipt review', email: 'receipt-browser@example.test', passwordHash: hashPassword('Receipt-synthetic-only-41!') });
      state.products = []; state.revenueEngine.experiments = [f.experiment]; await server.packsmart.store.save(f.workspaceId, state);
      server.listen(18879, '127.0.0.1'); await once(server, 'listening');
      const current = await server.packsmart.store.get(f.workspaceId), token = createSessionToken({ userId: 'owner_one', workspaceId: f.workspaceId, email: state.users[0].email,
        role: 'owner', sessionVersion: current.users[0].sessionVersion }, secret);
      context = await browser.newContext({ viewport: { width, height: 900 } }); await context.addCookies([{ name: 'packsmart_session', value: token, url: base, httpOnly: true, sameSite: 'Strict' }]);
      const page = await context.newPage(), calls = [], errors = [], external = [];
      let hold = null, losePublicationResponse = false;
      page.on('pageerror', e => errors.push(e.message));
      // Ignore one preview AbortSignal to prove that UI scope checks also guard
      // a late response after navigation, independently of transport cancellation.
      await context.addInitScript(() => {
        const original = window.fetch.bind(window);
        window.fetch = (input, options) => {
          if (window.__ignoreReceiptAbort && String(input).endsWith('/content-sources')) { window.__ignoreReceiptAbort = false; const config = { ...options }; delete config.signal; return original(input, config); }
          return original(input, options);
        };
      });
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== base) { external.push(url.origin); return route.abort(); }
        if (!url.pathname.startsWith('/api/business-outcomes')) return route.continue();
        const call = { path: url.pathname, method: request.method(), body: request.postData() }; calls.push(call);
        const result = clone(await f.request(call.path, { method: call.method, ...(call.body ? { body: call.body } : {}) }));
        if (hold && call.path.endsWith('/content-sources')) { const gate = hold; hold = null; gate.seen = true; await new Promise(resolve => { gate.release = resolve; }); }
        if (losePublicationResponse && call.path.endsWith('/publish')) { losePublicationResponse = false; return route.fulfill({ status: 503, json: { code: 'SYNTHETIC_LOST_ACKNOWLEDGEMENT' } }); }
        return route.fulfill({ json: result });
      });
      const panel = page.locator('#business-outcomes-panel'), status = page.locator('#business-outcomes-status'), form = page.locator('#business-outcomes-form');
      const action = page.locator('#business-outcomes-action'), actionDetails = page.locator('#business-outcomes-action-details');
      const load = async () => { await page.locator('#business-outcomes-experiment').selectOption(f.experimentId); await page.locator('#business-outcomes-load').click(); await status.getByText('Experiment loaded.', { exact: false }).waitFor(); };
      const select = async (value = 'receipt:' + f.sources[0].selector.attemptId) => { await action.selectOption(value); };
      const preview = async () => { await page.locator('[data-receipt-read="preview"]').click(); await status.getByText('preview loaded.', { exact: false }).waitFor(); };
      const save = async () => { await form.locator('button[type="submit"]').click(); await status.getByText('Draft saved.', { exact: false }).waitFor(); };
      const readCount = () => calls.filter(c => c.path.endsWith('/content-sources')).length;
      await page.goto(base); await page.locator('#app-shell:not(.hidden)').waitFor(); assert.equal(calls.length, 0);
      await navigate(page, 'revenue-engine'); assert.equal(calls.length, 0); await panel.locator(':scope > summary').click();
      await status.getByText('Results loaded.', { exact: false }).waitFor(); await load(); assert.equal(calls.length, 2);
      await select(); assert.equal(calls.length, 2, 'choosing a receipt does not read or mutate');
      await readable(page, page.locator('[data-receipt-read="preview"]'), width, { screenshot: 'selection' });
      const gate = { seen: false }; hold = gate;
      await page.locator('[data-receipt-read="preview"]').evaluate(el => { el.click(); el.click(); el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      await until(() => gate.seen, 'preview should reach fixture'); assert.equal(readCount(), 1); gate.release(); await status.getByText('preview loaded.', { exact: false }).waitFor();
      const text = await actionDetails.textContent(); assert.ok(text.includes(f.sources[0].display.input.description)); assert.ok(text.includes(f.sources[0].receiptSource.commitRevision));
      assert.match(text, /Application-observed completion/); assert.match(text, /not a database commit timestamp/);
      assert.equal(await page.locator('#business-outcomes-action-details img, #business-outcomes-action-details script, #business-outcomes-action-details [onerror]').count(), 0);
      await readable(page, actionDetails.locator('dt').filter({ hasText: 'Protected completion commit revision' }).locator('..'), width, { screenshot: 'protected-commit' });
      for (const enlarged of [false, true]) {
        const typography = await actionDetails.evaluateHandle(createRestrictionTypographySession);
        try {
          await typography.evaluate(s => s.assertBaseline());
          if (enlarged) { await typography.evaluate(s => s.begin()); await typography.evaluate(s => s.enlarge()); }
          try {
            for (const label of ['Application-observed completion (UTC)', 'Protected completion commit revision', 'Product title', 'Product description'])
              await readable(page, actionDetails.locator('dt').filter({ hasText: label }).locator('..'), width);
            await readable(page, page.locator('[data-receipt-read="next"]'), width, enlarged ? { screenshot: '200-percent-page-control' } : {});
            await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement !== document.body), true, 'keyboard focus remains usable at enlarged text');
          } finally { if (enlarged) await typography.evaluate(s => s.restore()); }
        } finally { await typography.dispose(); }
      }
      await form.locator('[name="amount"]').fill('4.25'); await page.locator('[data-receipt-read="next"]').click();
      await status.getByText('Receipt page loaded.', { exact: false }).waitFor(); assert.equal(await action.inputValue(), ''); assert.equal(await form.locator('[name="amount"]').inputValue(), '4.25');
      assert.equal(await page.locator('[data-receipt-read="next"]').count(), 0); assert.equal(readCount(), 2);
      await select('receipt:' + f.sources[21].selector.attemptId); await preview(); await save(); assert.equal(f.measurement.schema, 'runvara-experiment-measurement/v4');
      const draftWrite = calls.find(c => c.method === 'PUT'); assert.deepEqual(JSON.parse(draftWrite.body).actionSelection, { receipt: f.sources[21].selector });
      await page.locator('[data-outcome-action="publish"]').click(); assert.equal(await page.locator('#business-outcomes-confirm').isDisabled(), true);
      await readable(page, page.locator('#business-outcomes-attest'), width, { screenshot: 'owner-review' });
      await page.locator('#business-outcomes-attest').check(); losePublicationResponse = true; await page.locator('#business-outcomes-confirm').click();
      await status.getByText('Confirmation was not received.', { exact: false }).waitFor(); const original = calls.at(-1).body;
      assert.equal(await action.isDisabled(), true); await page.locator('#business-outcomes-attest').check(); await page.locator('#business-outcomes-confirm').click();
      await status.getByText('Review saved.', { exact: false }).waitFor(); assert.equal(calls.at(-1).body, original); await load();
      await page.locator('[data-outcome-source-current]').click(); await page.locator('[data-outcome-source-current][data-loaded="true"]').waitFor();
      assert.match(await page.locator('#business-outcomes-current-source').textContent(), /Exact protected action input/);
      await select('reuse:' + f.publication.head.versionId); await save(); await load();
      const beforeReuse = readCount(); await page.locator('[data-receipt-read="preview"]').click();
      await status.getByText('Exact reused publication source loaded.', { exact: false }).waitFor(); assert.equal(readCount(), beforeReuse);
      // A late source response may not render after navigation/back/close.
      await page.locator('[data-receipt-read="first"]').click(); await status.getByText('Receipt page loaded.', { exact: false }).waitFor(); await select();
      const late = { seen: false }; hold = late; await page.evaluate(() => { window.__ignoreReceiptAbort = true; });
      await page.locator('[data-receipt-read="preview"]').click(); await until(() => late.seen, 'late preview should reach fixture');
      await navigate(page, 'overview'); const beforeReturn = calls.length; late.release(); await delay(30);
      await navigate(page, 'revenue-engine'); assert.equal(await panel.getAttribute('open'), null); assert.equal(calls.length, beforeReturn);
      await panel.locator(':scope > summary').click(); assert.equal(await page.locator('#business-outcomes-receipt-preview').textContent(), '');
      assert.equal(await page.evaluate(() => window.receiptInjected), undefined); assert.deepEqual(errors, []); assert.deepEqual(external, []);
      const images = captures.filter(c => c.width === width), bytes = (await Promise.all(images.map(c => fs.stat(c.file)))).reduce((n, s) => n + s.size, 0);
      assert.equal(images.length, 4); assert.ok(bytes < 20 * 1024 * 1024);
      results.push({ width, images: images.length, bytes, receiptReads: readCount(), draftWrites: calls.filter(c => c.method === 'PUT').length, publicationAttempts: calls.filter(c => c.path.endsWith('/publish')).length,
        passed: ['explicit-selector', 'bounded-pages', 'escaped-source', 'observation-versus-commit', 'exact-200-percent-text-and-keyboard-focus', 'owner-review', 'stable-retry', 'immutable-reuse', 'late-navigation-guard'] });
      console.log(JSON.stringify(results.at(-1)));
    } finally {
      if (context) await context.close(); await server.packsmart.drain(); if (server.listening) await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true });
    }
  }
  await fs.writeFile('/tmp/runvara-receipt-outcomes-report.json', JSON.stringify({ schema: 'runvara-receipt-outcome-browser-evidence/v1', syntheticOnly: true,
    providerCalls: 0, databaseCalls: 0, note: 'Normal-size state-changing interactions; exact 200% affected-subtree text/readability and keyboard focus. Targeted real viewport screenshots; no app-wide zoom or full-page coverage claim.', results, captures }, null, 2));
} finally { if (browser) await browser.close(); }
