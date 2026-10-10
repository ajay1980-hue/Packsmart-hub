// Release HTML/CSS/UI, projected synthetic data, and a local in-page API stub.
// No application server, provider credentials, or external requests are used.
// Run: node tests/compatibility-bridge-browser-check.mjs
// Emits 12 actual PNGs and hash manifests under /tmp/runvara-compatibility-bridge/.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { renderConnectionPreview } from './render-connection-preview.mjs';

const output = '/tmp/runvara-compatibility-bridge';
const widths = [320, 390, 1200];
const scales = [1, 2];
const scenarios = ['compatibility-held', 'legacy-exact-change'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const document = await renderConnectionPreview({ compatibility: true });
const sourceHashes = Object.fromEntries(await Promise.all([
  '../../index.html', '../../favicon.svg', '../../styles.css', '../../presentation.js', '../../connections-ui.js',
  './render-connection-preview.mjs', './compatibility-bridge-browser-check.mjs', '../lib/action-display.mjs'
].map(async file => [file, sha256(await fs.readFile(new URL(file, import.meta.url)))])));
const manifest = { schema: 'runvara-compatibility-browser-evidence/v1', syntheticOnly: true,
  fixtureSha256: sha256(document), sourceHashes, screenshots: [] };
for (const width of widths) {
  await fs.mkdir(path.join(output, String(width)), { recursive: true });
  for (const name of [...scenarios.flatMap(scenario => scales.map(scale => `${scenario}-${scale * 100}pct.png`)), 'manifest.json']) {
    await fs.rm(path.join(output, String(width), name), { force: true });
  }
}
await fs.rm(path.join(output, 'manifest.json'), { force: true });

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function enlargeText(page, scale, probeSelector = '.connection-write > b') {
  // Text-only enlargement, including fixed-pixel text. Snapshot all computed
  // sizes before applying them so nested inheritance does not compound to 400%.
  // Keep the root size, widths, spacing and normal motion rules unchanged.
  return page.evaluate(({ scale, probeSelector }) => {
    const title = document.querySelector(probeSelector);
    const before = parseFloat(getComputedStyle(title).fontSize);
    if (scale !== 1) {
      const values = [...document.body.querySelectorAll('*'), document.body]
        .filter(element => element instanceof HTMLElement && !element.matches('script,style'))
        .map(element => { const style = getComputedStyle(element); return { element, fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight) }; });
      for (const { element, fontSize, lineHeight } of values) {
        element.style.fontSize = `${fontSize * scale}px`;
        if (Number.isFinite(lineHeight)) element.style.lineHeight = `${lineHeight * scale}px`;
      }
    }
    return { before, after: parseFloat(getComputedStyle(title).fontSize), scale };
  }, { scale, probeSelector });
}

async function overflowDiagnostics(page) {
  return page.evaluate(() => {
    const round = value => Math.round(value * 100) / 100;
    const describe = element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { tag: element.tagName.toLowerCase(), id: element.id, classes: element.className,
        parent: element.parentElement?.id || element.parentElement?.className || '',
        text: (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90),
        rect: { left: round(rect.left), right: round(rect.right), top: round(rect.top), bottom: round(rect.bottom) },
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, inDialog: Boolean(element.closest('#connection-dialog')),
        intersectsViewport: rect.bottom > 0 && rect.top < innerHeight, fontSize: style.fontSize, lineHeight: style.lineHeight,
        display: style.display, position: style.position, flexShrink: style.flexShrink, whiteSpace: style.whiteSpace, overflowX: style.overflowX };
    };
    const overflowing = [...document.body.querySelectorAll('*')].filter(element => {
      if (!(element instanceof HTMLElement) || element.matches('script,style')) return false;
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
        && (rect.left < -1 || rect.right > innerWidth + 1 || element.scrollWidth > element.clientWidth + 1);
    }).map(describe).sort((a, b) => Number(b.intersectsViewport) - Number(a.intersectsViewport) || b.rect.right - a.rect.right);
    return { viewport: { width: innerWidth, height: innerHeight }, pageScroll: document.documentElement.scrollWidth,
      bodyScroll: document.body.scrollWidth, dialogOpen: document.querySelector('#connection-dialog').open,
      overflowCount: overflowing.length, overflow: overflowing.slice(0, 24),
      commandBar: [...document.querySelectorAll('.command-bar,.top-actions,#mobile-menu,#refresh-all,#open-workspace-search,.account-shortcut')].map(describe) };
  });
}

async function diagnoseFailure(page, browser, { width, scenario, scale, error }) {
  // Preserve the failing normal-height state before running isolated controls.
  // Diagnostics do not change the assertion, fix styles, hide the background,
  // or enlarge the evidence viewport.
  assert.deepEqual(page.viewportSize(), { width, height: 900 });
  const stem = `${scenario}-${scale * 100}pct-failure`;
  const file = `${width}/${stem}.png`;
  await page.screenshot({ path: path.join(output, file) });
  const bytes = await fs.readFile(path.join(output, file));
  const failure = { schema: 'runvara-compatibility-browser-failure/v1', error: error.message, scenario, scale,
    sourceHashes, fixtureSha256: sha256(document), screenshot: { file, sha256: sha256(bytes) },
    actual: await overflowDiagnostics(page), controls: [] };
  for (const compatibility of [false, true]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'UTC', locale: 'en-GB', reducedMotion: 'no-preference' });
    const probe = await context.newPage(), requests = [], errors = [];
    probe.on('pageerror', error => errors.push(error.message));
    await probe.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
    try {
      const fixture = compatibility ? document : await renderConnectionPreview();
      await probe.setContent(fixture);
      await settle(probe);
      const normal = await overflowDiagnostics(probe);
      const font = await enlargeText(probe, scale, '#page-title');
      await settle(probe);
      const enlarged = await overflowDiagnostics(probe);
      const controlFile = `${width}/${stem}-${compatibility ? 'compatibility' : 'ordinary'}-before-modal.png`;
      await probe.screenshot({ path: path.join(output, controlFile) });
      failure.controls.push({ compatibility, fixtureSha256: sha256(fixture), normal, font, enlarged, errors, requests,
        screenshot: { file: controlFile, sha256: sha256(await fs.readFile(path.join(output, controlFile))) } });
    } finally {
      await context.close();
    }
  }
  const evidenceFile = `${width}/${stem}.json`;
  await fs.writeFile(path.join(output, evidenceFile), JSON.stringify(failure, null, 2) + '\n');
  console.error(JSON.stringify({ failureEvidence: evidenceFile, actual: failure.actual,
    controls: failure.controls.map(control => ({ compatibility: control.compatibility, normalPageScroll: control.normal.pageScroll,
      enlargedPageScroll: control.enlarged.pageScroll, dialogOpen: control.enlarged.dialogOpen, font: control.font,
      overflow: control.enlarged.overflow.slice(0, 8), screenshot: control.screenshot })) }));
}

async function checkLayout(page, width) {
  const layout = await page.evaluate(() => {
    const dialog = document.querySelector('#connection-dialog');
    const rect = dialog.getBoundingClientRect();
    const targets = [...dialog.querySelectorAll('.connection-write, .connection-history, .connection-exact-text')]
      .filter(element => element.getBoundingClientRect().height > 0)
      .map(element => ({ kind: element.className, width: element.clientWidth, scroll: element.scrollWidth, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }));
    return { viewport: { width: innerWidth, height: innerHeight }, pageScroll: document.documentElement.scrollWidth,
      dialog: { width: dialog.clientWidth, scroll: dialog.scrollWidth, left: rect.left, right: rect.right }, targets,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches };
  });
  assert.deepEqual(layout.viewport, { width, height: 900 }, 'validation uses the normal customer viewport');
  assert.equal(layout.reducedMotion, false, 'production animations stay enabled');
  assert.ok(layout.pageScroll <= width + 1, `page overflows: ${JSON.stringify(layout)}`);
  assert.ok(layout.dialog.scroll <= layout.dialog.width + 1 && layout.dialog.left >= 0 && layout.dialog.right <= width + 1, `dialog overflows: ${JSON.stringify(layout)}`);
  for (const target of layout.targets) assert.ok(target.scroll <= target.width + 1 && target.left >= 0 && target.right <= width + 1, `target overflows: ${JSON.stringify(target)}`);
  const scrollTargets = [];
  for (const selector of ['.connection-write > b', '#connection-detail > .connection-section:has(.connection-history) > h3']) {
    const target = page.locator(selector).first();
    await target.scrollIntoViewIfNeeded();
    await target.evaluate(element => {
      const dialog = document.querySelector('#connection-dialog');
      const close = document.querySelector('#connection-close').getBoundingClientRect();
      const top = Math.max(dialog.getBoundingClientRect().top + close.height + 16, close.bottom + 12);
      dialog.scrollTop += element.getBoundingClientRect().top - top;
    });
    await settle(page);
    const position = await target.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const close = document.querySelector('#connection-close').getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + Math.min(8, rect.width / 2), rect.top + Math.min(8, rect.height / 2));
      return { top: rect.top, bottom: rect.bottom, closeBottom: close.bottom, viewportHeight: innerHeight,
        withinSection: Boolean(hit && element.closest('.connection-section').contains(hit)), hiddenByClose: Boolean(hit?.closest('#connection-close')) };
    });
    assert.equal(position.viewportHeight, 900);
    assert.ok(position.top >= position.closeBottom && position.top < 880, `target heading is behind sticky Close or outside normal viewport: ${JSON.stringify(position)}`);
    assert.equal(position.hiddenByClose, false);
    assert.equal(position.withinSection, true, 'saved-change/history heading is visible to the user');
    scrollTargets.push({ selector, ...position });
  }
  return { ...layout, scrollTargets };
}

async function captureEvidence(page, width, scenario, scale) {
  const selectors = scenario === 'compatibility-held'
    ? ['#connection-detail > .connection-section:has(.connection-write)', '#connection-detail > .connection-section:has(.connection-history)']
    : ['#connection-detail > .connection-section:has(.connection-write)'];
  const height = await page.evaluate(selectors => {
    const first = document.querySelector(selectors[0]).getBoundingClientRect();
    const last = document.querySelector(selectors.at(-1)).getBoundingClientRect();
    return Math.ceil(last.bottom - first.top);
  }, selectors);
  // Only after normal 900px viewport checks, give the evidence enough vertical
  // room. No CSS, overflow, sticky close control, animation, or width is changed.
  // This avoids cropping scrollable modal content or putting it under Close.
  const captureViewport = { width, height: Math.max(900, height + 220) };
  await page.setViewportSize(captureViewport);
  await settle(page);
  await page.evaluate(selectors => {
    window.scrollTo(0, 0);
    const dialog = document.querySelector('#connection-dialog');
    const first = document.querySelector(selectors[0]);
    const close = document.querySelector('#connection-close');
    const top = dialog.getBoundingClientRect().top + close.getBoundingClientRect().height + 36;
    dialog.scrollTop += first.getBoundingClientRect().top - top;
  }, selectors);
  await settle(page);
  const clip = await page.evaluate(selectors => {
    const first = document.querySelector(selectors[0]).getBoundingClientRect();
    const last = document.querySelector(selectors.at(-1)).getBoundingClientRect();
    const close = document.querySelector('#connection-close').getBoundingClientRect();
    if (first.top < close.bottom || last.bottom > innerHeight || first.left < 0 || first.right > innerWidth) throw new Error('Evidence target is clipped or overlaps the sticky Close control');
    const x = Math.floor(first.left), y = Math.floor(first.top);
    return { x, y, width: Math.ceil(first.right) - x, height: Math.ceil(last.bottom) - y };
  }, selectors);
  const file = `${scenario}-${scale * 100}pct.png`;
  const destination = path.join(output, String(width), file);
  await page.screenshot({ path: destination, clip });
  const bytes = await fs.readFile(destination);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'evidence is an actual PNG');
  const dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  assert.equal(dimensions.width, clip.width);
  assert.equal(dimensions.height, clip.height);
  await page.setViewportSize({ width, height: 900 });
  await settle(page);
  return { file: `${width}/${file}`, sha256: sha256(bytes), bytes: bytes.length, dimensions, captureViewport, clip };
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const width of widths) {
    for (const scale of scales) for (const scenario of scenarios) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'UTC', locale: 'en-GB', reducedMotion: 'no-preference' });
      const page = await context.newPage();
      const errors = [], requests = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => { requests.push({ method: route.request().method(), url: route.request().url() }); return route.abort(); });
      try {
        await page.setContent(document);
        await settle(page);
        const provider = scenario === 'compatibility-held' ? 'ebay' : 'shopify';
        const opener = page.locator(`[data-channel-card="${provider}"] .connection-title`);
        await opener.click();
        const dialog = page.locator('#connection-dialog');
        assert.equal(await dialog.isVisible(), true);
        assert.equal(await page.locator('#connection-close').evaluate(element => document.activeElement === element), true);
        const font = await enlargeText(page, scale);
        assert.equal(font.after, font.before * scale, 'saved-change text is enlarged by exactly 200%');
        await settle(page);
        const write = page.locator('.connection-write');
        if (scenario === 'compatibility-held') {
          assert.match(await write.textContent(), /Unsupported saved change/);
          assert.match(await write.textContent(), /requires a newer compatible release/);
          assert.equal(await write.locator('[data-connection-action="execute"],details').count(), 0);
          const history = page.locator('.connection-history');
          assert.equal(await history.locator('b').textContent(), 'Deferred');
          assert.match(await history.textContent(), /Saved read safety state requires a newer compatible reader/);
          assert.doesNotMatch(await history.textContent(), /Use Sync now|In progress|Completed|Partially completed|reset/i);
          assert.equal(await history.locator('button,progress').count(), 0);
          assert.equal(await page.locator('#connection-progress progress').count(), 0);
          const hold = dialog.locator('.connection-notice').filter({ hasText: 'Saved read safety state requires a newer compatible reader' });
          assert.equal(await hold.count(), 1);
          assert.equal(await hold.locator('[data-connection-action="open"]').count(), 1);
          assert.equal(await hold.locator('[data-connection-action="sync"],[data-connection-action="reconnect"]').count(), 0);
        } else {
          const summary = write.locator('summary');
          assert.equal(await summary.textContent(), 'Review exact change');
          await summary.click();
          assert.notEqual(await write.locator('details').getAttribute('open'), null);
          assert.deepEqual(await write.locator('dd').allTextContents(), ['product_content', 'gid://shopify/Product/1', 'Exact reviewed title', 'Keep this exact description.\nSecond line retained.']);
          assert.equal(await write.locator('[data-write="write_legacy"]').textContent(), 'Apply approved change');
          assert.equal(await write.locator('[data-write="write_legacy"]').isEnabled(), true);
          assert.equal(await write.locator('[data-connection-action="approvals"]').isEnabled(), true);
        }
        const layout = await checkLayout(page, width);
        const screenshot = await captureEvidence(page, width, scenario, scale);
        if (scenario === 'legacy-exact-change') {
          await write.locator('[data-connection-action="approvals"]').click();
          assert.deepEqual(await page.evaluate(() => window.fixtureViews), ['approvals']);
        } else {
          await page.locator('#connection-close').click();
        }
        assert.equal(await dialog.isVisible(), false, 'normal viewport controls close the native modal');
        assert.equal(await opener.evaluate(element => document.activeElement === element), true, 'focus returns to the initiating control');
        await opener.click();
        await page.keyboard.press('Escape');
        assert.equal(await dialog.isVisible(), false, 'Escape closes the native modal');
        assert.deepEqual(errors, []);
        assert.deepEqual(requests, [], 'fixture cannot contact external services');
        assert.equal(await page.evaluate(() => window.fixtureRequests.every(request => request.method === 'GET')), true, 'review never attempts a write or retry');
        manifest.screenshots.push({ scenario, textScale: scale, font, validatedLayout: layout, ...screenshot });
        console.log(JSON.stringify({ scenario, width, textScale: scale, sha256: screenshot.sha256, file: screenshot.file }));
      } catch (error) {
        await diagnoseFailure(page, browser, { width, scenario, scale, error }).catch(diagnosticError => console.error(`Failure diagnostics could not complete: ${diagnosticError.message}`));
        throw error;
      } finally {
        await context.close();
      }
    }
    const screenshots = manifest.screenshots.filter(item => item.validatedLayout.viewport.width === width);
    assert.equal(screenshots.length, 4);
    await fs.writeFile(path.join(output, String(width), 'manifest.json'), JSON.stringify({ ...manifest, screenshots }, null, 2) + '\n');
  }
  assert.equal(manifest.screenshots.length, 12);
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Compatibility bridge browser checks passed: 12 screenshots at 320, 390 and 1200 pixels, normal and 200% text. Manifest: ${output}/manifest.json`);
} finally {
  await browser?.close();
}
