// CI ONLY: real app, fresh synthetic file-store data, and blocked provider access.
// Never launch/install a local browser to work around an executor restriction.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { deriveOperations } from '../lib/operations.mjs';
import { createRestrictionTypographySession } from './objective-browser-typography.mjs';

assert.equal(process.env.CI, 'true', 'SEO browser evidence runs only in the existing GitHub CI workflow.');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Never launch this browser fixture in a local executor.');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-seo-browser-'));
const secret = 'synthetic-seo-browser-secret-more-than-thirty-two-characters';
const maxArchiveBytes = 12 * 1024 * 1024;
let browser, providerCalls = 0;
const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret, SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' },
  { schedulerEnabled: false, agentOpsEnabled: false, fetchImpl: async () => { providerCalls++; throw new Error('No providers are allowed in SEO UI CI.'); } });
const product = (id, status = 'active', fields = {}) => ({ id, title: 'Synthetic catalogue item ' + id, status, description: '', image: 'synthetic.png', variants: [], ...fields });
const products = [product('active', ' AcTiVe ', { publicationStatus: 'published', published: true, publishedAt: '2026-10-09', inventory: 500, onlineStoreUrl: 'https://shop.example.test/product' }),
  product('unknown', 'pending'), product('unlisted', 'unlisted'), product('draft', 'draft'), product('archived', 'archived')];

async function containment(page, width, state, textScale) {
  const result = await page.evaluate(() => ({ width: innerWidth, page: document.documentElement.scrollWidth,
    elements: [...document.querySelectorAll('#seo-review-panel, #seo-review-panel section, #seo-review-panel details, #seo-review-panel summary, #seo-review-panel .issue-row, #seo-review-panel .text-button')]
      .filter(node => node.getClientRects().length).map(node => { const box = node.getBoundingClientRect(); return { id: node.id, tag: node.tagName, className: node.className,
        left: box.left, right: box.right, scroll: node.scrollWidth, client: node.clientWidth }; }) }));
  assert.ok(result.page <= width + 2, `Page overflow at ${width}/${state}/${textScale}: ${JSON.stringify(result)}`);
  for (const item of result.elements) {
    assert.ok(item.left >= -2 && item.right <= width + 2 && item.scroll <= item.client + 2,
      `SEO panel overflow at ${width}/${state}/${textScale}: ${JSON.stringify(item)}`);
  }
  return { state, textScale, ...result };
}

async function createSeoCaptureSession(panel) {
  const document = panel.ownerDocument, view = document.defaultView, ancestors = [];
  for (let node = panel.parentElement; node && node !== document.documentElement; node = node.parentElement) ancestors.push(node);
  const check = (condition, message) => { if (!condition) throw new Error('SEO capture: ' + message); };
  const settle = async () => {
    const chrome = [...document.querySelectorAll('.topbar, .skip-link, .global-message')];
    const pending = () => [...new Set([panel, ...ancestors, ...chrome].flatMap(node => node.getAnimations({ subtree: node === panel || chrome.includes(node) })))]
      .filter(animation => animation.effect && animation.playbackRate !== 0 && Number.isFinite(animation.effect.getComputedTiming().endTime) && !['finished', 'idle'].includes(animation.playState));
    let timeout, stopped = false, phase = 'fonts', rounds = 0;
    const diagnostics = () => ({ phase, rounds, fonts: document.fonts.status, pending: pending().slice(0, 12).map(animation => {
      const target = animation.effect.target;
      return { target: target?.id ? '#' + target.id : String(target?.tagName || 'unknown') + '.' + String(target?.className || '').slice(0, 120),
        name: animation.animationName || animation.id || null, property: animation.transitionProperty || null,
        state: animation.playState, currentTime: animation.currentTime, endTime: animation.effect.getComputedTiming().endTime, playbackRate: animation.playbackRate };
    }) });
    try {
      await Promise.race([(async () => {
        // The existing view reveal translates its children by up to 4px.
        // Wait naturally before measuring; the screenshot must not finish that
        // ancestor animation after the clip was calculated.
        await document.fonts.ready;
        while (!stopped) {
          phase = 'finite motion'; rounds++;
          await Promise.allSettled(pending().map(animation => animation.finished));
          if (stopped) return;
          phase = 'layout frames';
          await new Promise(resolve => view.requestAnimationFrame(() => view.requestAnimationFrame(resolve)));
          if (stopped || pending().length === 0) return;
          // Scroll, focus and typography may start a new hover transition on
          // the next frame. Rescan within the same overall deadline.
        }
      })(), new Promise((_, reject) => { timeout = view.setTimeout(() => {
        stopped = true; reject(new Error('SEO capture: fonts and finite animations did not settle within 5 seconds: ' + JSON.stringify(diagnostics())));
      }, 5000); })]);
    } finally { stopped = true; view.clearTimeout(timeout); }
  };
  await settle();
  const scroll = { x: view.scrollX, y: view.scrollY }, viewport = { width: view.innerWidth, height: view.innerHeight };
  const positions = ancestors.map(node => ({ node, x: node.scrollLeft, y: node.scrollTop }));
  const focused = document.activeElement, markup = panel.innerHTML;
  const details = [...panel.querySelectorAll('details')].map(node => ({ node, open: node.open }));
  const rect = node => { const box = node.getBoundingClientRect(); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height }; };
  const chrome = () => [...document.querySelectorAll('.topbar, .skip-link, .global-message')]
    .filter(node => node.getClientRects().length).map(node => ({ selector: node.className, ...rect(node) }));
  const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const unchanged = () => {
    check(panel.isConnected && panel.innerHTML === markup, 'capture must not change or replace SEO content');
    check(details.every(item => item.node.isConnected && item.node.open === item.open), 'capture must preserve history state');
    check(view.innerWidth === viewport.width && view.innerHeight === viewport.height, 'capture must preserve the real viewport');
  };
  return {
    async historyViewport() {
      const summary = panel.querySelector('#seo-retained-history > summary');
      check(summary && summary.parentElement.open, 'history must already be opened by the interaction test');
      // Scroll only; retain real fixed/sticky chrome and the existing open state.
      summary.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); await settle();
      return this.historyBounds();
    },
    historyBounds() {
      unchanged();
      const summary = panel.querySelector('#seo-retained-history > summary');
      check(summary && summary.parentElement.open, 'history must remain open during its viewport capture');
      const target = rect(summary), overlays = chrome(), hit = document.elementFromPoint((target.left + target.right) / 2, (target.top + target.bottom) / 2);
      check(target.left >= 0 && target.right <= viewport.width && target.top >= 0 && target.bottom <= viewport.height, 'open-history control must fit in the live viewport');
      check(overlays.every(box => !overlaps(box, target)), 'real page chrome must not obscure the open-history control');
      check(hit === summary || summary.contains(hit), 'open-history control must remain an unobscured interaction target');
      return { scroll: { x: view.scrollX, y: view.scrollY }, target, chrome: overlays, targetHitTest: true };
    },
    async prepare() {
      if (document.activeElement instanceof view.HTMLElement) document.activeElement.blur();
      for (const { node } of positions) node.scrollTo({ left: 0, top: 0, behavior: 'instant' });
      view.scrollTo({ left: 0, top: 0, behavior: 'instant' }); await settle();
      return this.bounds();
    },
    bounds() {
      unchanged();
      check(view.scrollX === 0 && view.scrollY === 0 && positions.every(({ node }) => node.scrollLeft === 0 && node.scrollTop === 0), 'complete-panel capture requires zero scroll');
      const box = rect(panel), overlays = chrome(), skip = document.querySelector('.skip-link');
      check(skip && !skip.matches(':focus') && rect(skip).bottom <= 0, 'the unfocused skip link must stay above the viewport');
      check(overlays.every(item => !overlaps(item, box)), 'page chrome must not overlap the document-coordinate panel capture');
      const clip = { x: Math.floor(box.left), y: Math.floor(box.top), width: Math.ceil(box.right) - Math.floor(box.left), height: Math.ceil(box.bottom) - Math.floor(box.top) };
      check(clip.x >= 0 && clip.y >= 0 && clip.width > 0 && clip.height > 0, 'complete panel needs a valid document rectangle');
      return { clip, panel: box, chrome: overlays, scroll: { x: view.scrollX, y: view.scrollY }, originalScroll: scroll };
    },
    async restore() {
      await settle();
      for (const item of positions) item.node.scrollTo({ left: item.x, top: item.y, behavior: 'instant' });
      view.scrollTo({ left: scroll.x, top: scroll.y, behavior: 'instant' });
      if (focused instanceof view.HTMLElement && focused.isConnected && focused !== document.body) focused.focus({ preventScroll: true });
      await settle(); unchanged();
      check(Math.abs(view.scrollX - scroll.x) <= 1 && Math.abs(view.scrollY - scroll.y) <= 1 &&
        positions.every(item => Math.abs(item.node.scrollLeft - item.x) <= 1 && Math.abs(item.node.scrollTop - item.y) <= 1), 'capture must restore interaction scroll positions');
      check(focused === document.body || document.activeElement === focused, 'capture must restore the focused control');
    }
  };
}

async function withCaptureCleanup(work, cleanups) {
  let result, primary, failed = false;
  try { result = await work(); } catch (error) { primary = error; failed = true; }
  const failures = [];
  for (const [label, cleanup] of cleanups) {
    try { await cleanup(); } catch (error) { failures.push({ label, error }); }
  }
  if (failures.length) {
    const details = failures.map(({ label, error }) => ({ label, message: error.message, stack: error.stack }));
    if (!failed) { primary = new AggregateError(failures.map(item => item.error), 'SEO capture cleanup failed: ' + details.map(item => item.label + ': ' + item.message).join('; ')); failed = true; }
    primary.captureCleanupErrors = [...(primary.captureCleanupErrors || []), ...details];
    console.error('SEO capture cleanup diagnostics (primary failure preserved): ' + JSON.stringify(details));
  }
  if (failed) throw primary;
  return result;
}

async function capture(page, width, name, manifest, outputDirectory) {
  const panel = page.locator('#seo-review-panel'), original = await panel.evaluateHandle(createSeoCaptureSession);
  let typography;
  const save = async textScale => {
    const position = await panel.evaluateHandle(createSeoCaptureSession);
    return withCaptureCleanup(async () => {
      if (name === 'history-open') {
        const geometry = await position.evaluate(session => session.historyViewport());
        const file = `seo-${name}-viewport-${textScale}.png`;
        const bytes = await page.screenshot({ path: path.join(outputDirectory, file), fullPage: false, animations: 'allow', scale: 'css' });
        assert.deepEqual(await position.evaluate(session => session.historyBounds()), geometry, 'Live viewport screenshot must preserve unobscured target geometry');
        assert.equal(bytes.readUInt32BE(16), width); assert.equal(bytes.readUInt32BE(20), 900);
        manifest.captures.push({ file, state: name, textScale, region: 'partial live viewport; open-history interaction with real page chrome', width, height: 900,
          bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), geometry });
      }
      const geometry = await position.evaluate(session => session.prepare());
      const layout = await containment(page, width, name, textScale);
      const file = `seo-${name}-${textScale}.png`, target = path.join(outputDirectory, file);
      // locator.screenshot scrolls into view again, allowing sticky/fixed chrome
      // to paint over an oversized element capture. Capture from document origin
      // without hiding chrome, resizing the viewport, or changing any app style.
      const bytes = await page.screenshot({ path: target, fullPage: true, clip: geometry.clip, animations: 'allow', scale: 'css' });
      const after = await position.evaluate(session => session.bounds());
      assert.deepEqual(after, geometry, 'Screenshot must leave capture geometry and state unchanged');
      const height = bytes.readUInt32BE(20), imageWidth = bytes.readUInt32BE(16);
      assert.equal(height, geometry.clip.height); assert.equal(imageWidth, geometry.clip.width);
      assert.ok(Math.abs(height - geometry.panel.height) <= 2 && Math.abs(imageWidth - geometry.panel.width) <= 2, 'Screenshot must cover the full SEO panel without clipping');
      manifest.captures.push({ file, state: name, textScale, region: 'complete SEO review panel', width: imageWidth, height,
        bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), layout, geometry });
    }, [['restore ' + textScale + '% capture position', () => position.evaluate(session => session.restore())], ['dispose ' + textScale + '% capture position', () => position.dispose()]]);
  };
  return withCaptureCleanup(async () => {
    typography = await panel.evaluateHandle(createRestrictionTypographySession);
    await typography.evaluate(session => session.assertBaseline()); await save(100);
    await typography.evaluate(session => session.begin());
    await withCaptureCleanup(async () => { await typography.evaluate(session => session.enlarge()); await save(200); },
      [['restore normal typography', () => typography.evaluate(session => session.restore())]]);
    await typography.evaluate(session => session.assertBaseline());
  }, [
    // Restore the original normal-text scroll after 200% text has shrunk again;
    // restoring only inside each text-scale capture misses scroll anchoring.
    ['restore outer normal-text position', () => original.evaluate(session => session.restore())],
    ['dispose typography session', () => typography?.dispose()], ['dispose outer position', () => original.dispose()]
  ]);
}

await withCaptureCleanup(async () => {
  const seed = seedWorkspaceState({}, { workspaceId: 'seo-browser', name: 'Synthetic SEO review', email: 'seo@example.test', passwordHash: 'fixture-only' });
  seed.products = products; seed.orders = []; seed.connections = []; seed.approvals = [];
  await server.packsmart.store.save(seed.workspace.id, seed);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = createSessionToken({ userId: seed.users[0].id, workspaceId: seed.workspace.id, email: seed.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  browser = await chromium.launch({ headless: true });
  for (const width of [320, 390, 1200]) {
    const outputDirectory = path.join('/tmp', `runvara-seo-review-${width}`);
    await fs.rm(path.join('/tmp', `runvara-seo-review-${width}.tar.gz`), { force: true });
    await fs.rm(outputDirectory, { recursive: true, force: true }); await fs.mkdir(outputDirectory);
    const manifest = { schema: 'runvara-seo-review-browser-evidence/v1', status: 'running', viewport: { width, height: 900 },
      fixture: 'fresh synthetic retained catalogue; no provider calls', textScales: [100, 200], captures: [], checks: [], providerCalls: 0, maxArchiveBytes,
      captureMethod: 'Complete panels use a document-origin page clip with nonoverlapping real chrome; separate open-history viewport images retain real chrome and an unobscured interaction target. Scroll, focus, content, history state and viewport are preserved.',
      sourceDiagnosis: 'Element screenshots automatically scroll the target into view; this previously painted sticky/fixed page chrome inside oversized mobile panel captures. No app styles or elements are hidden or changed for capture.' };
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    await context.addCookies([{ name: 'packsmart_session', value: token, url: base, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage(), errors = [], external = [], writes = [], calls = [];
    let mode = 'mixed', latestBootstrap;
    page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base) { external.push(url.origin); return route.abort(); }
      if (request.method() !== 'GET') { writes.push(request.method() + ' ' + url.pathname); return route.abort(); }
      if (url.pathname.startsWith('/api/')) calls.push(url.pathname);
      if (url.pathname === '/api/bootstrap') {
        const result = await route.fetch(), data = await result.json();
        // Only this public bootstrap projection is replaced for empty/malformed/clipping states.
        if (mode === 'empty') { data.products = []; data.dashboard = { ...data.dashboard, ...deriveOperations({ ...seed, products: [] }) }; }
        if (mode === 'fallback') data.dashboard.seoReview = null;
        if (mode === 'clipped') {
          data.products = [...Array.from({ length: 107 }, (_, i) => product('review-' + i)), ...Array.from({ length: 56 }, (_, i) => product('history-' + i, 'archived'))];
          data.dashboard = { ...data.dashboard, ...deriveOperations({ ...seed, products: data.products }) };
        }
        if (mode === 'xss') {
          data.products = [product('xss', 'active', { title: '<img src=x onerror="window.seoInjected=true">Unsafe-looking recorded title' })];
          data.dashboard = { ...data.dashboard, ...deriveOperations({ ...seed, products: data.products }) };
        }
        latestBootstrap = data;
        return route.fulfill({ response: result, json: data });
      }
      return route.continue();
    });
    const navigate = async view => {
      if (await page.locator('#mobile-menu').isVisible()) await page.locator('#mobile-menu').click();
      await page.locator(`#main-nav [data-view="${view}"]`).click();
      await page.locator(`#view-${view}.active`).waitFor();
    };
    const load = async nextMode => { mode = nextMode; await page.goto(base); await page.locator('#app-shell:not(.hidden)').waitFor(); await navigate('issues'); };
    try {
      await withCaptureCleanup(async () => {
      await load('mixed');
      const initialCalls = [...calls], history = page.locator('#seo-retained-history');
      assert.equal(await history.getAttribute('open'), null);
      assert.equal(await page.locator('#seo-visibility-review').isVisible(), true);
      assert.match(await page.locator('#seo-actionable-status').textContent(), /publication is unverified/);
      assert.equal(await history.locator('.issue-row').first().isVisible(), false);
      assert.match(await page.locator('#seo-visibility-review').textContent(), /Product status unknown · Publication unknown/);
      assert.match(await page.locator('#seo-visibility-review').textContent(), /Recorded status: unlisted/);
      await capture(page, width, 'history-closed', manifest, outputDirectory);
      await history.locator('summary').click();
      assert.equal(await history.locator('.issue-row').first().isVisible(), true);
      await capture(page, width, 'history-open', manifest, outputDirectory);
      await history.locator('summary').click(); await history.locator('summary').click();
      await history.locator('.issue-row').first().click(); await page.locator('#view-profit.active').waitFor();
      assert.equal(await page.locator('#product-status').inputValue(), 'all');
      await navigate('issues'); await page.locator('#seo-visibility-review .issue-row').first().click(); await page.locator('#view-profit.active').waitFor();
      await navigate('issues'); await page.locator('#seo-review-panel > button').click(); await page.locator('#view-profit.active').waitFor();
      assert.deepEqual(calls, initialCalls, 'History and catalogue navigation do not fetch, write or poll');
      manifest.checks.push('Unknown publication visible at rest; draft/archive collapsed; repeated history toggles and all catalogue links');

      await load('fallback');
      assert.match(await page.locator('#seo-issue-list').textContent(), /SEO classification unavailable/);
      assert.equal(await page.locator('#seo-unclassified-review .issue-row').count(), latestBootstrap.dashboard.seoIssueItems.length);
      await capture(page, width, 'unclassified-fallback', manifest, outputDirectory);
      await load('empty');
      assert.match(await page.locator('#seo-issue-list').textContent(), /No SEO findings were recorded.*publication is still unverified/s);
      await capture(page, width, 'no-recorded-findings', manifest, outputDirectory);
      await load('clipped');
      assert.equal(await page.locator('#seo-visibility-review .issue-row').count(), 100);
      assert.equal(await page.locator('#seo-retained-history .issue-row').count(), 100);
      assert.match(await page.locator('#seo-visibility-review').textContent(), /Showing 100 of 107 findings; 7 omitted/);
      assert.match(await page.locator('#seo-retained-history').textContent(), /Showing 100 of 112 findings; 12 omitted/);
      await containment(page, width, 'clipped-review', 100);
      await page.locator('#seo-retained-history summary').click();
      await containment(page, width, 'clipped-history-open', 100);
      const clippedTypography = await page.locator('#seo-review-panel').evaluateHandle(createRestrictionTypographySession);
      await withCaptureCleanup(async () => {
        await clippedTypography.evaluate(session => session.begin());
        await withCaptureCleanup(async () => { await clippedTypography.evaluate(session => session.enlarge()); await containment(page, width, 'clipped-history-open', 200); },
          [['restore clipping-check typography', () => clippedTypography.evaluate(session => session.restore())]]);
      }, [['dispose clipping-check typography', () => clippedTypography.dispose()]]);
      manifest.checks.push('Independent 100-finding limits and exact omitted counts, with full row containment at 100% and 200% text; large fixture checked without screenshot');
      await load('xss');
      assert.equal(await page.locator('#seo-review-panel img, #seo-review-panel script, #seo-review-panel [onerror]').count(), 0);
      assert.equal(await page.evaluate(() => window.seoInjected), undefined);
      assert.match(await page.locator('#seo-issue-list').textContent(), /<img src=x/);
      await capture(page, width, 'escaped-source', manifest, outputDirectory);
      manifest.checks.push('Fresh bootstrap replaces earlier findings; source markup remains inert text');
      assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, []); assert.equal(providerCalls, 0);
      manifest.status = 'passed'; manifest.apiCalls = calls; manifest.providerCalls = providerCalls;
      manifest.imageBytes = manifest.captures.reduce((sum, entry) => sum + entry.bytes, 0);
      assert.ok(manifest.imageBytes < maxArchiveBytes, 'Each viewport evidence set must stay well below 32 MiB');
      await fs.writeFile(path.join(outputDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2));
      const archive = path.join('/tmp', `runvara-seo-review-${width}.tar.gz`);
      execFileSync('tar', ['-czf', archive, '-C', outputDirectory, '.']);
      const archiveBytes = (await fs.stat(archive)).size;
      assert.ok(archiveBytes < maxArchiveBytes, 'Each viewport archive must stay below 12 MiB');
      console.log(`SEO review ${width}px passed; ${manifest.captures.length} evidence images; archive ${archiveBytes} bytes.`);
      }, [['close ' + width + 'px context', () => context.close()]]);
    } catch (error) {
      manifest.status = 'failed'; manifest.error = error.message;
      manifest.captureCleanupErrors = error.captureCleanupErrors || [];
      await withCaptureCleanup(async () => { throw error; },
        [['write failure manifest', () => fs.writeFile(path.join(outputDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2))]]);
    }
  }
}, [['close browser', async () => { if (browser) await browser.close(); }],
  ['close synthetic server', async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); }],
  ['remove synthetic state directory', () => fs.rm(directory, { recursive: true, force: true })]]);
