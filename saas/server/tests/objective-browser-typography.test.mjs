import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRestrictionTypographySession } from './objective-browser-typography.mjs';

function fixture(t) {
  const dom = new JSDOM(`<!doctype html><html><head><style>
    #business-objective-restriction, #business-objective-restriction * { font-size: 12px; line-height: 18px; }
    #hint { font-size: 11px; line-height: 17px; }
    #account-label { font-size: 14px; line-height: 20px; }
    #account { font-size: 16px; line-height: 24px; }
    #option-a { font-size: 10px; line-height: 15px; }
    #option-b { font-size: 17px; line-height: 25px; }
  </style></head><body><section id="business-objective-restriction">
    <div id="copy" style="color: navy; font-size: 13px; line-height: 19px;"><span id="hint" style="">Synthetic restriction</span></div>
    <form id="form" style=""><label id="account-label" for="account">Account</label>
      <select id="account" style="color: maroon;"><option id="option-a" value="a" style="color: coral;">Synthetic A</option><option id="option-b" value="b" style="color: teal;">Synthetic B</option></select>
      <button id="save" style="font-size: 15px; line-height: 22px; color: green;">Save restriction</button>
    </form>
  </section></body></html>`, { runScripts: 'outside-only', url: 'https://typography.test' });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  const panel = document.getElementById('business-objective-restriction');
  // Evaluate the serialized function in the browser realm, as Playwright does.
  // Accidental dependencies on imported assertions or other module state fail here.
  const session = dom.window.eval(`(${createRestrictionTypographySession.toString()})(document.getElementById('business-objective-restriction'))`);
  return { dom, document, panel, session, get: id => document.getElementById(id) };
}

function typography(node) {
  const computed = node.ownerDocument.defaultView.getComputedStyle(node);
  return { style: node.getAttribute('style'), fontSize: computed.fontSize, lineHeight: computed.lineHeight };
}

function snapshot(panel) {
  return new Map(Array.from(panel.querySelectorAll('*'), node => [node, typography(node)]));
}

function assertRestored(baseline) {
  for (const [node, original] of baseline) {
    assert.deepEqual(typography(node), original, `${node.id} must recover its own exact inline and computed typography`);
  }
}

function assertDoubled(baseline) {
  for (const [node, original] of baseline) {
    const actual = typography(node);
    assert.equal(actual.fontSize, `${parseFloat(original.fontSize) * 2}px`, `${node.id} font size`);
    assert.equal(actual.lineHeight, `${parseFloat(original.lineHeight) * 2}px`, `${node.id} line height`);
  }
}

function capture(session, baseline) {
  session.assertBaseline();
  session.begin();
  session.enlarge();
  assertDoubled(baseline);
  session.restore();
  assertRestored(baseline);
}

test('typography session scales and restores element references after descendant index reordering', t => {
  const { session, panel, get } = fixture(t);
  const baseline = snapshot(panel);
  session.assertBaseline();
  session.begin();
  get('account').prepend(get('option-b'));
  get('form').prepend(get('save'));
  session.enlarge();
  assertDoubled(baseline);
  get('account').append(get('option-b'));
  get('form').append(get('account-label'));
  session.restore();
  assertRestored(baseline);
  session.assertBaseline();
});

test('typography restoration rejects replaced options but cleans original references and leaves replacements untouched', t => {
  const { session, panel, document, get } = fixture(t);
  const baseline = snapshot(panel);
  const original = get('option-a');
  session.assertBaseline();
  session.begin();
  session.enlarge();
  const replacement = document.createElement('option');
  replacement.id = original.id;
  replacement.textContent = 'Synthetic replacement';
  replacement.setAttribute('style', 'font-size: 21px; line-height: 29px; color: purple;');
  original.replaceWith(replacement);
  const replacementBaseline = typography(replacement);
  assert.throws(() => session.restore(), /ownership|replac|membership|changed|removed/i);
  assert.equal(original.getAttribute('style'), baseline.get(original).style, 'even the detached original has its inline style restored');
  baseline.delete(original);
  assertRestored(baseline);
  assert.deepEqual(typography(replacement), replacementBaseline, 'a fresh option must not receive the removed option’s style');
});

for (const mutation of ['addition', 'removal']) {
  test(`typography restoration rejects descendant ${mutation} while restoring surviving originals`, t => {
    const { session, panel, document, get } = fixture(t);
    const baseline = snapshot(panel);
    session.assertBaseline();
    session.begin();
    session.enlarge();
    let added;
    if (mutation === 'addition') {
      added = document.createElement('option');
      added.textContent = 'Synthetic added account';
      added.setAttribute('style', 'font-size: 23px; line-height: 31px;');
      get('account').append(added);
    } else {
      const removed = get('option-a');
      removed.remove();
      baseline.delete(removed);
    }
    const addedBaseline = added && typography(added);
    assert.throws(() => session.restore(), /ownership|membership|changed|added|removed/i);
    assertRestored(baseline);
    if (added) assert.deepEqual(typography(added), addedBaseline, 'new nodes are outside the active capture’s ownership');
  });
}

test('replacement options between restored captures receive a fresh baseline without compounding persistent text', t => {
  const { session, panel, document, get } = fixture(t);
  const originalBaseline = snapshot(panel);
  capture(session, originalBaseline);
  const original = get('option-a');
  const replacement = document.createElement('option');
  replacement.id = original.id;
  replacement.textContent = 'New normal account option';
  replacement.setAttribute('style', 'font-size: 19px; line-height: 27px;');
  original.replaceWith(replacement);
  const nextBaseline = snapshot(panel);
  for (const [node, expected] of originalBaseline) {
    if (node !== original) assert.deepEqual(nextBaseline.get(node), expected, `${node.id} retains its first normal baseline`);
  }
  capture(session, nextBaseline);
  capture(session, nextBaseline);
  assert.equal(typography(replacement).fontSize, '19px');
  assert.equal(typography(get('account')).fontSize, '16px');
});

test('a duplicate enlargement is rejected before it can compound any captured typography', t => {
  const { session, panel } = fixture(t);
  const baseline = snapshot(panel);
  session.assertBaseline();
  session.begin();
  session.enlarge();
  const enlarged = snapshot(panel);
  assert.throws(() => session.enlarge(), /already|once|enlarg|active/i);
  assertRestored(enlarged);
  assertDoubled(baseline);
  session.restore();
  assertRestored(baseline);
});

test('typography restoration uses CSSOM when setting a style attribute is forbidden', t => {
  const { session, panel, dom, get } = fixture(t);
  get('save').setAttribute('style', 'font-size: 15px !important; line-height: 22px !important; color: green;');
  const baseline = snapshot(panel);
  const canonicalStyles = new Map(Array.from(baseline.keys(), node => [node, node.style.cssText]));
  assert.equal(baseline.get(get('account-label')).style, null, 'fixture includes an absent style attribute');
  assert.equal(baseline.get(get('hint')).style, '', 'fixture includes a present, empty style attribute');
  assert.ok(baseline.get(get('copy')).style, 'fixture includes a nonempty style attribute');
  const { setAttribute } = dom.window.Element.prototype;
  let forbiddenWrites = 0;
  dom.window.Element.prototype.setAttribute = function (name, value) {
    if (String(name).toLowerCase() === 'style') {
      forbiddenWrites++;
      throw new Error('Synthetic CSP prohibits setAttribute(style)');
    }
    return setAttribute.call(this, name, value);
  };
  for (let phase = 0; phase < 2; phase++) {
    session.assertBaseline();
    session.begin();
    session.enlarge();
    assertDoubled(baseline);
    session.restore();
    for (const [node, original] of baseline) {
      assert.equal(node.style.cssText, canonicalStyles.get(node), `${node.id} retains its canonical inline declarations`);
      assert.equal(node.hasAttribute('style'), original.style !== null, `${node.id} retains its original style attribute presence`);
      assert.equal(typography(node).fontSize, original.fontSize, `${node.id} restores its computed font size`);
      assert.equal(typography(node).lineHeight, original.lineHeight, `${node.id} restores its computed line height`);
    }
  }
  assert.equal(forbiddenWrites, 0, 'no attempt to replace a style attribute is allowed');
  assert.equal(get('save').style.getPropertyPriority('font-size'), 'important');
  assert.equal(get('save').style.getPropertyPriority('line-height'), 'important');
  assert.equal(get('account-label').hasAttribute('style'), false);
  assert.equal(get('hint').hasAttribute('style'), true);
});

test('persistent inline style leakage is rejected even when computed typography is unchanged', t => {
  const { session, panel, get } = fixture(t);
  const baseline = snapshot(panel);
  capture(session, baseline);
  const persistent = get('hint');
  persistent.style.color = 'red';
  assert.equal(typography(persistent).fontSize, baseline.get(persistent).fontSize);
  assert.equal(typography(persistent).lineHeight, baseline.get(persistent).lineHeight);
  assert.throws(() => session.assertBaseline(), /baseline|inline|style|restor|leak/i);
  assert.equal(persistent.style.color, 'red', 'validation must not silently overwrite the evidence of leakage');
});

for (const property of ['font-size', 'line-height']) {
  test(`persistent computed ${property} leakage is rejected even when inline styles are unchanged`, t => {
    const { session, panel, document, get } = fixture(t);
    const baseline = snapshot(panel);
    capture(session, baseline);
    const override = document.createElement('style');
    override.textContent = `#hint { ${property}: 33px; }`;
    document.head.append(override);
    assert.equal(get('hint').getAttribute('style'), baseline.get(get('hint')).style);
    assert.throws(() => session.assertBaseline(), /baseline|computed|font|line|typography|restor|leak/i);
  });
}

test('restoration validates computed baselines after restoring every captured inline style', t => {
  const { session, panel, document, get } = fixture(t);
  const baseline = snapshot(panel);
  session.assertBaseline();
  session.begin();
  session.enlarge();
  const override = document.createElement('style');
  override.textContent = '#hint { font-size: 30px; line-height: 40px; }';
  document.head.append(override);
  assert.throws(() => session.restore(), /baseline|computed|font|line|typography|restor|leak/i);
  for (const [node, original] of baseline) {
    assert.equal(node.getAttribute('style'), original.style, `${node.id} inline cleanup must finish even when another node fails validation`);
  }
  assert.equal(typography(get('hint')).fontSize, '30px', 'the changed computed baseline remains observable');
});
