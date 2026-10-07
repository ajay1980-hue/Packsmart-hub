// Self-contained DOM helper: Playwright evaluates this function in the page.
// The same implementation is exercised without a browser by the JSDOM tests.
export function createRestrictionTypographySession(panel) {
  const view = panel.ownerDocument.defaultView;
  const baseline = new WeakMap();
  let active = null;
  const invariant = (condition, message) => {
    if (!condition) throw new Error('Restriction typography: ' + message);
  };
  const describe = node => node.id || node.tagName.toLowerCase();
  const descendants = () => Array.from(panel.querySelectorAll('*'));
  const read = node => {
    const computed = view.getComputedStyle(node);
    return { node, inline: node.getAttribute('style'), cssText: node.style.cssText,
      declarations: ['font-size', 'line-height'].map(name => ({ name, value: node.style.getPropertyValue(name), priority: node.style.getPropertyPriority(name) })),
      fontSize: computed.fontSize, lineHeight: computed.lineHeight };
  };
  const assertOwned = records => {
    invariant(panel.isConnected, 'the captured panel is no longer live');
    const current = descendants(), owned = new Set(records.map(record => record.node));
    invariant(current.length === records.length && current.every(node => owned.has(node)) &&
      records.every(record => record.node.isConnected && panel.contains(record.node)),
    'live element ownership changed during capture; replacement elements must never receive another element’s styles');
  };
  const assertNormal = record => {
    const current = read(record.node), label = describe(record.node);
    const details = JSON.stringify({ element: label,
      expected: { inline: record.inline, cssText: record.cssText, fontSize: record.fontSize, lineHeight: record.lineHeight },
      actual: { inline: current.inline, cssText: current.cssText, fontSize: current.fontSize, lineHeight: current.lineHeight } });
    // CSSOM may normalize attribute whitespace. Preserve exact declaration
    // values/priorities and absent-versus-present state, not source spelling.
    invariant((current.inline === null) === (record.inline === null) && current.cssText === record.cssText,
      label + ' has changed original inline styles; ' + details);
    invariant(current.fontSize === record.fontSize, label + ' did not restore its baseline computed font size; ' + details);
    invariant(current.lineHeight === record.lineHeight, label + ' did not restore its baseline computed line height; ' + details);
  };
  const assertBaseline = () => {
    invariant(!active, 'a previous text-resizing capture has not been restored');
    invariant(panel.isConnected, 'the panel is no longer live');
    for (const node of [panel, ...descendants()]) {
      const original = baseline.get(node);
      if (original) assertNormal(original);
      else {
        const record = read(node);
        invariant(Number.isFinite(parseFloat(record.fontSize)) && parseFloat(record.fontSize) > 0,
          describe(node) + ' has no measurable baseline font size');
        baseline.set(node, record);
      }
    }
  };
  return {
    assertBaseline,
    begin() {
      assertBaseline();
      active = { records: descendants().map(read), panel: read(panel), enlarged: false };
      assertOwned(active.records);
    },
    enlarge() {
      invariant(active && !active.enlarged, '200% text may be applied exactly once per capture');
      assertOwned(active.records);
      active.records.forEach(assertNormal);
      // Read every baseline before writing anything. Explicit pixel sizes stop
      // a parent's enlargement from being multiplied again by its children.
      active.enlarged = true;
      for (const record of active.records) {
        record.node.style.fontSize = `${parseFloat(record.fontSize) * 2}px`;
        const height = parseFloat(record.lineHeight);
        if (Number.isFinite(height)) record.node.style.lineHeight = `${height * 2}px`;
      }
      for (const record of active.records) {
        const current = read(record.node), label = describe(record.node);
        invariant(Math.abs(parseFloat(current.fontSize) - parseFloat(record.fontSize) * 2) < 0.05,
          label + ' is not exactly 200% of its captured font size');
        const height = parseFloat(record.lineHeight);
        invariant(Number.isFinite(height)
          ? Math.abs(parseFloat(current.lineHeight) - height * 2) < 0.05
          : current.lineHeight === record.lineHeight,
        label + ' is not using the expected 200% line height');
      }
    },
    restore() {
      invariant(active, 'there is no owned capture to restore');
      const capture = active;
      active = null;
      // Restore only our CSSOM declarations on the captured objects, including
      // detached originals. setAttribute('style', ...) can be blocked by the
      // app's unchanged style-src CSP and must not restore these assignments.
      for (const record of capture.records) {
        for (const declaration of record.declarations) {
          if (declaration.value) record.node.style.setProperty(declaration.name, declaration.value, declaration.priority);
          else record.node.style.removeProperty(declaration.name);
        }
        if (record.inline === null && record.node.getAttribute('style') === '') record.node.removeAttribute('style');
      }
      assertOwned(capture.records);
      assertNormal(capture.panel);
      capture.records.forEach(assertNormal);
      assertBaseline();
    }
  };
}
