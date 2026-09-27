import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
let page;
try {
  const fixture = await browser.newPage();
  await fixture.goto(pathToFileURL(process.argv[2] || '/tmp/runvara-mobile-preview.html').href);
  const document = await fixture.locator('#preview').getAttribute('srcdoc');
  assert.ok(document, 'Responsive fixture must contain the release document');
  await fixture.close();
  for (const width of [320, 390, 768, 1200]) {
    // Exercise the actual viewport, without an outer iframe clipping scroll targets.
    page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(document);
    await page.locator('#connection-journey').waitFor();
    if (await page.locator('#connection-journey > details').getAttribute('open') === null) {
      await page.locator('#connection-journey > details > summary').click();
    }
    const layout = await page.locator('body').evaluate(el => ({
      scroll: el.ownerDocument.documentElement.scrollWidth,
      width: el.ownerDocument.documentElement.clientWidth,
    }));
    assert.equal(layout.width, width, 'Test must use the requested customer viewport');
    assert.ok(layout.scroll <= layout.width + 1, `Page overflows at ${width}: ${JSON.stringify(layout)}`);
    const title = page.locator('[data-channel-card="tiktok_shop"] .connection-title');
    await title.click();
    assert.ok(await page.locator('#connection-dialog').isVisible(), 'Channel details must open');
    const dialog = await page.locator('#connection-dialog').evaluate(el => ({
      scroll: el.scrollWidth, width: el.clientWidth,
      left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right,
      viewport: el.ownerDocument.documentElement.clientWidth,
    }));
    assert.ok(dialog.scroll <= dialog.width + 1 && dialog.left >= 0 && dialog.right <= dialog.viewport + 1,
      `Dialog overflows at ${width}: ${JSON.stringify(dialog)}`);
    await page.locator('#connection-close').click();
    assert.equal(await page.locator('#connection-dialog').isVisible(), false, 'Dialog must close');
    assert.deepEqual(errors, [], 'Customer connection UI must not throw browser errors');
    if (width === 390) {
      await page.locator('#connection-journey').scrollIntoViewIfNeeded();
      await page.screenshot({ path: '/tmp/runvara-onboarding-mobile.png', fullPage: true });
    }
    console.log(JSON.stringify({ viewport: width, page: layout, dialog }));
    await page.close();
    page = undefined;
  }
} catch (error) {
  if (page) await page.screenshot({ path: '/tmp/runvara-onboarding-mobile.png', fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
