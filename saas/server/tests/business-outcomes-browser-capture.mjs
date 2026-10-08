// Full live scrolling coverage with real fixed/sticky chrome. No oversized
// element screenshots, app-wide zoom or interaction at enlarged typography.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

export function createOutcomeViewportSession(panel) {
  const view = panel.ownerDocument.defaultView, document = panel.ownerDocument, ancestors = [];
  for (let node = panel.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) ancestors.push(node);
  const scrollports = () => ancestors.filter(node => /^(auto|scroll)$/.test(view.getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight);
  const chrome = () => Array.from(document.querySelectorAll('.topbar, .global-message')).filter(node => {
    const style = view.getComputedStyle(node), rect = node.getBoundingClientRect();
    return ['sticky', 'fixed'].includes(style.position) && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < view.innerHeight;
  });
  const clearance = () => Math.max(12, ...chrome().map(node => node.getBoundingClientRect().height + 24));
  return {
    async reveal(offset) {
      for (const node of scrollports()) node.scrollBy({ top: panel.getBoundingClientRect().top + offset - node.getBoundingClientRect().top - node.clientTop - clearance(), behavior: 'instant' });
      view.scrollBy({ top: panel.getBoundingClientRect().top + offset - clearance(), behavior: 'instant' });
      await new Promise(resolve => view.requestAnimationFrame(() => view.requestAnimationFrame(resolve)));
    },
    bounds() {
      const rect = panel.getBoundingClientRect(); let top = 0, bottom = view.innerHeight, left = 0, right = view.innerWidth;
      for (const node of ancestors) {
        const style = view.getComputedStyle(node), box = node.getBoundingClientRect();
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) { top = Math.max(top, box.top + node.clientTop); bottom = Math.min(bottom, box.top + node.clientTop + node.clientHeight); }
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) { left = Math.max(left, box.left + node.clientLeft); right = Math.min(right, box.left + node.clientLeft + node.clientWidth); }
      }
      for (const node of chrome()) top = Math.max(top, node.getBoundingClientRect().bottom + 12);
      return { from: Math.max(0, top - rect.top), to: Math.min(rect.height, bottom - rect.top), height: rect.height,
        left: rect.left, right: rect.right, visibleLeft: left, visibleRight: right, scroll: panel.scrollWidth, client: panel.clientWidth };
    }
  };
}

export async function captureOutcomeViewports({ page, width, name, subtree, controls, captures, typographyFactory }) {
  const typography = await subtree.evaluateHandle(typographyFactory), viewport = await subtree.evaluateHandle(createOutcomeViewportSession);
  const controlViews = await Promise.all(controls.map(control => control.evaluateHandle(createOutcomeViewportSession)));
  const image = async (suffix, label, bounds) => {
    const file = `/tmp/runvara-business-outcomes-${width}-${name}${suffix}-${label}.png`;
    assert.equal(captures.some(row => row.file === file), false, 'every evidence capture has a unique path');
    await page.screenshot({ path: file, fullPage: false, caret: 'initial' }); captures.push({ width, name, file, bounds });
    console.log(`${width}px ${name}${suffix} ${label}: ${JSON.stringify(bounds)}`);
  };
  const horizontal = (bounds, label) => assert.ok(bounds.left >= bounds.visibleLeft - 2 && bounds.right <= bounds.visibleRight + 2 && bounds.scroll <= bounds.client + 2, `${label} clipped horizontally: ${JSON.stringify(bounds)}`);
  const images = async suffix => {
    let covered = 0, part = 0;
    while (true) {
      await viewport.evaluate((session, offset) => session.reveal(offset), Math.max(0, covered - 80));
      const bounds = await viewport.evaluate(session => session.bounds()); horizontal(bounds, name + suffix);
      assert.ok(bounds.from <= covered + 2 && bounds.to > covered + 1, `Evidence coverage must be contiguous: ${JSON.stringify({ covered, ...bounds })}`);
      await image(suffix, `viewport-${++part}`, bounds); covered = bounds.to;
      if (covered >= bounds.height - 1) break;
      assert.ok(part < 60, 'Each source subtree stays within 60 real viewport captures');
    }
    for (let index = 0; index < controlViews.length; index++) {
      const view = controlViews[index]; await view.evaluate(session => session.reveal(0));
      const bounds = await view.evaluate(session => session.bounds()); horizontal(bounds, name + ' control ' + index);
      assert.ok(bounds.height > 0 && bounds.right > bounds.left && bounds.from <= 1 && bounds.to >= bounds.height - 1, `Entire control must be visible below real chrome: ${JSON.stringify(bounds)}`);
      await image(suffix, `control-${index + 1}`, bounds);
    }
  };
  try {
    await typography.evaluate(session => session.assertBaseline()); await images('');
    await typography.evaluate(session => session.begin());
    try { await typography.evaluate(session => session.enlarge()); await images('-large-text'); }
    finally { await typography.evaluate(session => session.restore()); }
    await typography.evaluate(session => session.assertBaseline());
    const bytes = (await Promise.all(captures.filter(row => row.width === width).map(row => fs.stat(row.file)))).reduce((total, stat) => total + stat.size, 0);
    assert.ok(bytes < 32 * 1024 * 1024, `${width}px evidence exceeds the 32 MiB artifact bound`);
  } finally { await typography.dispose(); await viewport.dispose(); await Promise.all(controlViews.map(view => view.dispose())); }
}
