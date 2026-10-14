import assert from 'node:assert/strict';

// Use real browser text ranges: scrollWidth alone misses words split over lines.
// This operates on the release UI without invoking a connection action.
export async function assertConnectionToolbar(page, context) {
  const toolbar = page.locator('#connection-dialog .connection-toolbar');
  const typography = await toolbar.evaluateHandle(root => [...root.querySelectorAll('button')].map(node => ({
    node, style: node.getAttribute('style'), size: parseFloat(getComputedStyle(node).fontSize),
    line: parseFloat(getComputedStyle(node).lineHeight),
  })));
  const results = [];
  try {
    for (const textScale of [100, 200]) {
      if (textScale === 200) await typography.evaluate(records => records.forEach(({ node, size, line }) => {
        node.style.fontSize = `${size * 2}px`;
        if (Number.isFinite(line)) node.style.lineHeight = `${line * 2}px`;
      }));
      const exactScale = await typography.evaluate((records, scale) => records.every(({ node, size }) =>
        Math.abs(parseFloat(getComputedStyle(node).fontSize) - size * scale / 100) < .05), textScale);
      assert.ok(exactScale, 'The actual toolbar button text must use the requested scale');
      const layout = await toolbar.evaluate(root => {
        const bounds = root.getBoundingClientRect();
        return { toolbarWidth: bounds.width, buttons: [...root.querySelectorAll('button')].map(button => {
          const box = button.getBoundingClientRect(), words = [];
          const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) for (const match of walker.currentNode.textContent.matchAll(/\S+/g)) {
            const range = document.createRange();
            range.setStart(walker.currentNode, match.index); range.setEnd(walker.currentNode, match.index + match[0].length);
            const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
            const lines = [];
            for (const rect of rects) if (!lines.some(top => Math.abs(top - rect.top) < 1)) lines.push(rect.top);
            words.push({ text: match[0], lines: lines.length,
              inside: rects.every(rect => rect.left >= box.left && rect.right <= box.right && rect.top >= box.top && rect.bottom <= box.bottom) });
          }
          return { text: button.textContent, type: button.type, action: button.dataset.connectionAction,
            provider: button.dataset.provider, width: box.width, height: box.height,
            left: box.left - bounds.left, right: box.right - bounds.left, top: box.top - bounds.top, bottom: box.bottom - bounds.top,
            scroll: button.scrollWidth, client: button.clientWidth, words };
        }) };
      });
      const label = `${context.width}px/${context.mode}/${textScale}%`;
      assert.ok(layout.buttons.length >= 2, `Configured connection retains management buttons at ${label}`);
      assert.equal(layout.buttons[0].text, 'Test connection');
      assert.equal(layout.buttons[0].action, 'test');
      assert.equal(layout.buttons.at(-1).action, 'reconnect');
      for (const [index, button] of layout.buttons.entries()) {
        assert.equal(button.type, 'button', `Management action must not submit a form at ${label}`);
        assert.ok(button.provider, `Management action retains its provider at ${label}`);
        assert.ok(button.width >= 44 && button.height >= 44, `Touch target too small at ${label}: ${JSON.stringify(button)}`);
        assert.ok(button.left >= -1 && button.right <= layout.toolbarWidth + 1 && button.scroll <= button.client + 1,
          `Toolbar button overflows at ${label}: ${JSON.stringify(button)}`);
        assert.ok(button.words.length && button.words.every(word => word.lines === 1 && word.inside),
          `Toolbar word splits or clips at ${label}: ${JSON.stringify(button)}`);
        for (const previous of layout.buttons.slice(0, index)) assert.ok(button.left >= previous.right - 1 || button.right <= previous.left + 1
          || button.top >= previous.bottom - 1 || button.bottom <= previous.top + 1, `Toolbar buttons overlap at ${label}`);
      }
      const enabled = toolbar.locator('button:enabled');
      assert.ok(await enabled.count(), `Owner fixture retains enabled management actions at ${label}`);
      await enabled.first().focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      for (let index = 0; index < await enabled.count(); index++) {
        const focus = await enabled.nth(index).evaluate(button => ({ active: document.activeElement === button,
          visible: button.matches(':focus-visible'), outline: getComputedStyle(button).outlineStyle,
          outlineWidth: parseFloat(getComputedStyle(button).outlineWidth) }));
        assert.ok(focus.active && focus.visible && focus.outline !== 'none' && focus.outlineWidth > 0,
          `Keyboard order or visible focus missing at ${label}: ${JSON.stringify(focus)}`);
        if (index + 1 < await enabled.count()) await page.keyboard.press('Tab');
      }
      results.push({ ...context, textScale, ...layout });
    }
  } finally {
    await typography.evaluate(records => records.forEach(({ node, style }) => {
      if (style === null) node.removeAttribute('style'); else node.setAttribute('style', style);
    }));
    await typography.dispose();
  }
  return results;
}
