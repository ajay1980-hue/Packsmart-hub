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

async function capture(page, width, name, manifest, outputDirectory) {
  const panel = page.locator('#seo-review-panel'), typography = await panel.evaluateHandle(createRestrictionTypographySession);
  const save = async textScale => {
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    const layout = await containment(page, width, name, textScale);
    const file = `seo-${name}-${textScale}.png`, target = path.join(outputDirectory, file);
    await panel.screenshot({ path: target, animations: 'disabled', scale: 'css' });
    const bytes = await fs.readFile(target);
    // Element screenshots include the complete panel, including its expanded history.
    const height = bytes.readUInt32BE(20), imageWidth = bytes.readUInt32BE(16);
    const box = await panel.boundingBox();
    assert.ok(Math.abs(height - box.height) <= 2 && Math.abs(imageWidth - box.width) <= 2, 'Screenshot must cover the full SEO panel without clipping');
    manifest.captures.push({ file, state: name, textScale, region: 'complete SEO review panel', width: imageWidth, height,
      bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), layout });
  };
  try {
    await typography.evaluate(session => session.assertBaseline()); await save(100);
    await typography.evaluate(session => session.begin());
    try { await typography.evaluate(session => session.enlarge()); await save(200); }
    finally { await typography.evaluate(session => session.restore()); }
    await typography.evaluate(session => session.assertBaseline());
  } finally { await typography.dispose(); }
}

try {
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
      fixture: 'fresh synthetic retained catalogue; no provider calls', textScales: [100, 200], captures: [], checks: [], providerCalls: 0, maxArchiveBytes };
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
      try {
        await clippedTypography.evaluate(session => session.begin());
        try { await clippedTypography.evaluate(session => session.enlarge()); await containment(page, width, 'clipped-history-open', 200); }
        finally { await clippedTypography.evaluate(session => session.restore()); }
      } finally { await clippedTypography.dispose(); }
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
      console.log(`SEO review ${width}px passed; ${manifest.captures.length} complete-panel images; archive ${archiveBytes} bytes.`);
    } catch (error) {
      manifest.status = 'failed'; manifest.error = error.message;
      await fs.writeFile(path.join(outputDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2));
      throw error;
    } finally { await context.close(); }
  }
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
