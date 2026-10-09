import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const cooldownReport = { schema: 'runvara-ebay-cooldown-browser-evidence/v1', status: 'running',
  fixture: 'release connection UI with synthetic saved cooldown evidence', captures: [], widths: [], factLayouts: [] };
async function assertCooldownFacts(panel, width, mode, textScale) {
  const facts = await panel.locator('.connection-facts').evaluate(list => {
    const box = list.getBoundingClientRect();
    return { width: box.width, rows: [...list.children].map(row => {
      const rowBox = row.getBoundingClientRect();
      return { left: rowBox.left - box.left, right: rowBox.right - box.left, top: rowBox.top - box.top, bottom: rowBox.bottom - box.top,
        fields: [...row.querySelectorAll('dt,dd')].map(field => {
          const fieldBox = field.getBoundingClientRect(), words = [], style = getComputedStyle(field);
          const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) for (const match of walker.currentNode.textContent.matchAll(/\S+/g)) {
            const range = document.createRange(); range.setStart(walker.currentNode, match.index); range.setEnd(walker.currentNode, match.index + match[0].length);
            const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0), lines = [];
            for (const rect of rects) if (!lines.some(top => Math.abs(top - rect.top) < 1)) lines.push(rect.top);
            words.push({ text: match[0], lines: lines.length, inside: rects.every(rect => rect.left >= fieldBox.left - 1 && rect.right <= fieldBox.right + 1) });
          }
          return { text: field.textContent, scroll: field.scrollWidth, client: field.clientWidth, overflow: style.overflowX, ellipsis: style.textOverflow, words };
        }) };
    }) };
  });
  const label = `${width}px/${mode}/${textScale}%`;
  assert.equal(facts.rows.length, 4, `Every saved fact remains visible at ${label}`);
  for (const [index, row] of facts.rows.entries()) {
    assert.equal(row.fields.length, 2, `Every fact retains its label and value at ${label}`);
    assert.ok(row.left >= -1 && row.right <= facts.width + 1, `Fact row exceeds its own card at ${label}: ${JSON.stringify(row)}`);
    for (const field of row.fields) {
      assert.ok(field.words.length && field.words.every(word => word.lines === 1 && word.inside), `Fact word splits or clips at ${label}: ${JSON.stringify(field)}`);
      assert.ok(field.scroll <= field.client + 2 && !['hidden','clip'].includes(field.overflow) && field.ellipsis !== 'ellipsis', `Fact text must remain fully readable at ${label}: ${JSON.stringify(field)}`);
    }
    for (const previous of facts.rows.slice(0, index)) assert.ok(row.left >= previous.right - 1 || row.right <= previous.left + 1 || row.top >= previous.bottom - 1 || row.bottom <= previous.top + 1, `Fact rows overlap at ${label}`);
  }
  cooldownReport.factLayouts.push({ width, mode, textScale, factsWidth: facts.width, rows: facts.rows });
}
async function captureCooldown(page, width, mode, surface) {
  const management = surface === 'management';
  const panel = page.locator(management ? '#connection-detail' : '[data-channel-card="ebay"]');
  const typography = await panel.evaluateHandle((root, management) => {
    // Enlarge exactly the affected cooldown copy and schedule, preserving the
    // unrelated card badges, controls and management form typography.
    const nodes = [...root.querySelectorAll(management ? '.connection-notice p, .connection-notice button' : '.connection-health, .connection-facts dt, .connection-facts dd')];
    if (!nodes.length) throw new Error('Cooldown typography must own visible text');
    const records = nodes.map(node => { const computed = getComputedStyle(node); return { node, size: computed.fontSize, line: computed.lineHeight,
      inline: node.getAttribute('style'), declarations: ['font-size','line-height'].map(name => ({ name, value: node.style.getPropertyValue(name), priority: node.style.getPropertyPriority(name) })) }; });
    const assertBaseline = () => records.forEach(record => {
      if (!root.contains(record.node) || getComputedStyle(record.node).fontSize !== record.size || getComputedStyle(record.node).lineHeight !== record.line) throw new Error('Cooldown typography changed its saved baseline');
    });
    return { assertBaseline,
      enlarge() {
        assertBaseline();
        for (const record of records) { record.node.style.fontSize = `${parseFloat(record.size) * 2}px`; if (Number.isFinite(parseFloat(record.line))) record.node.style.lineHeight = `${parseFloat(record.line) * 2}px`; }
        for (const record of records) if (Math.abs(parseFloat(getComputedStyle(record.node).fontSize) - parseFloat(record.size) * 2) > .05) throw new Error('Cooldown text must be exactly 200%');
      },
      restore() {
        for (const record of records) {
          for (const declaration of record.declarations) { if (declaration.value) record.node.style.setProperty(declaration.name, declaration.value, declaration.priority); else record.node.style.removeProperty(declaration.name); }
          if (record.inline === null && record.node.getAttribute('style') === '') record.node.removeAttribute('style');
        }
        assertBaseline();
      }
    };
  }, management);
  const save = async textScale => {
    if (!management) await assertCooldownFacts(panel, width, mode, textScale);
    await panel.evaluate((node, management) => {
      const scroller = management ? document.querySelector('#connection-dialog') : document.scrollingElement;
      const topbar = document.querySelector('.topbar');
      const top = management ? scroller.getBoundingClientRect().top + 70
        : getComputedStyle(topbar).position === 'sticky' ? topbar.getBoundingClientRect().height + 12 : 12;
      scroller.scrollTop += node.getBoundingClientRect().top - top;
    }, management);
    for (let frame = 1; frame <= 12; frame++) {
      const geometry = await panel.evaluate((node, management) => {
        const scroller = management ? document.querySelector('#connection-dialog') : document.scrollingElement;
        const box = node.getBoundingClientRect(), topbar = document.querySelector('.topbar');
        const top = management ? scroller.getBoundingClientRect().top + 70
          : getComputedStyle(topbar).position === 'sticky' ? topbar.getBoundingClientRect().bottom + 8 : 0;
        const regionBottom = management ? node.querySelector('.connection-toolbar').getBoundingClientRect().bottom : box.bottom;
        const bottom = Math.min(regionBottom, management ? scroller.getBoundingClientRect().bottom - 4 : innerHeight);
        const y = Math.max(box.top, top);
        return { x: box.left, y, width: box.width, height: bottom - y, remaining: regionBottom - bottom,
          pageWidth: document.documentElement.scrollWidth, scroll: node.scrollWidth, client: node.clientWidth,
          containerScroll: scroller.scrollWidth, containerWidth: scroller.clientWidth, scrollTop: scroller.scrollTop };
      }, management);
      assert.ok(geometry.pageWidth <= width + 2 && geometry.x >= 0 && geometry.x + geometry.width <= width + 2
        && geometry.scroll <= geometry.client + 2 && geometry.containerScroll <= geometry.containerWidth + 2,
      `eBay cooldown overflow at ${width}px/${mode}/${surface}/${textScale}%: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.height > 0, 'Cooldown capture must contain visible content');
      const filename = `/tmp/runvara-ebay-cooldown-${width}-${mode}-${surface}-${textScale}-${String(frame).padStart(2, '0')}.png`;
      const clip = { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height };
      await page.screenshot({ path: filename, clip, caret: 'initial' });
      cooldownReport.captures.push({ width, mode, surface, textScale, frame, filename, clip, scrollTop: geometry.scrollTop });
      if (geometry.remaining <= 1) return;
      const advanced = await panel.evaluate((node, { management, amount }) => {
        const scroller = management ? document.querySelector('#connection-dialog') : document.scrollingElement;
        const before = scroller.scrollTop; scroller.scrollTop += amount; return scroller.scrollTop > before;
      }, { management, amount: Math.max(100, geometry.height - 32) });
      assert.ok(advanced, 'Cooldown screenshot traversal must advance without clipping saved text');
    }
    assert.fail('Cooldown screenshot traversal exceeded twelve viewport slices');
  };
  try {
    await typography.evaluate(session => session.assertBaseline());
    await save(100);
    try { await typography.evaluate(session => session.enlarge()); await save(200); }
    finally { await typography.evaluate(session => session.restore()); }
    await typography.evaluate(session => session.assertBaseline());
  } finally { await typography.dispose(); }
}

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
    if ([320, 390, 1200].includes(width)) {
      for (const mode of ['deadline', 'manual', 'review', 'exhausted']) {
        await page.evaluate(mode => window.showEbayCooldownFixture(mode), mode);
        const card = page.locator('[data-channel-card="ebay"]');
        const message = await card.locator('.connection-health').textContent();
        const next = await card.locator('.connection-facts div').filter({ has: page.locator('dt', { hasText: 'Next automatic read' }) }).locator('dd').textContent();
        if (mode === 'deadline') {
          assert.match(message, /eBay reads must wait until/);
          assert.match(next, /^Eligible after \d{1,2} [A-Za-z]+ \d{4}/, 'Cooldown card must show the day as well as the time');
        } else {
          assert.doesNotMatch(next, /Eligible/);
          assert.match(next, mode === 'review' ? /Retry timing needs review/ : /paused/);
        }
        if (mode === 'review') {
          assert.match(message, /deadline could not be represented safely and needs manual review/);
          assert.doesNotMatch(message, /reconnect|will retry/i);
        }
        await captureCooldown(page, width, mode, 'card');
        await card.locator('.connection-title').click();
        assert.ok(await page.locator('#connection-dialog').isVisible());
        assert.equal(await page.locator('#connection-detail > .connection-notice > p').textContent(), message);
        await captureCooldown(page, width, mode, 'management');
        await page.locator('#connection-close').click();
        assert.equal(await page.locator('#connection-dialog').isVisible(), false);
        // Repeated opening must preserve the same saved wait or hold copy.
        await card.locator('.connection-title').click();
        assert.equal(await page.locator('#connection-detail > .connection-notice > p').textContent(), message);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#connection-dialog').isVisible(), false);
      }
      cooldownReport.widths.push(width);
      assert.deepEqual(errors, [], 'Cooldown management must not throw browser errors');
    }
    console.log(JSON.stringify({ viewport: width, page: layout, dialog }));
    await page.close();
    page = undefined;
  }
  cooldownReport.status = 'passed';
  cooldownReport.note = 'Real viewport slices of the card and management notice/toolbar at normal and exact 200% affected text. Synthetic saved evidence only; no provider reads. Downloaded images still require pixel review.';
} catch (error) {
  cooldownReport.status = 'failed';
  if (page) await page.screenshot({ path: '/tmp/runvara-onboarding-mobile.png', fullPage: true }).catch(() => {});
  throw error;
} finally {
  await fs.writeFile('/tmp/runvara-ebay-cooldown-report.json', JSON.stringify(cooldownReport, null, 2));
  await browser.close();
}
