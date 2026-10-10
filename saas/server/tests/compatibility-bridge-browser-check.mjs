// Release HTML/CSS/UI, projected synthetic data, and a local in-page API stub.
// No application server, provider credentials, or external requests are used.
// Run: node tests/compatibility-bridge-browser-check.mjs
// Emits 12 actual PNGs and hash manifests under /tmp/runvara-compatibility-bridge/.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { connectionPreviewFixture, renderConnectionPreview } from './render-connection-preview.mjs';

const output = '/tmp/runvara-compatibility-bridge';
const widths = [320, 390, 1200];
const scales = [1, 2];
const scenarios = ['compatibility-held', 'legacy-exact-change'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const document = await renderConnectionPreview({ compatibility: true });
const bridgeUI = await fs.readFile(new URL('../../connections-ui.js', import.meta.url), 'utf8');
const productionCommit = 'd32da62d0e7935597638266d44d88ae5e066d51f';
const bridgeUIHash = '709fdea888665674f99cbb0b10b71c4a027900c36c6ec6609ec6cf8d0e6bfae0';
const productionUIHash = '38130b168f8656a85c204f6843581410520dbff5870d580f01e7b13dbb25e01e';
const ordinaryPayloadHash = '7c55a5b8685a58721e97db68599b42a53459977f561db7100df55dca02bb7561';
const sharedProductionHashes = {
  '../../index.html': '126402f9402fd7376820a86b137f8a05a72b7a5ed8e49a143b677f3ecbbec994',
  '../../styles.css': '7bbc1357117ece3f26712d07ca8d63b6e7f7bb606dacb9020c854a8815205dbb',
  '../../presentation.js': '0dab35ef8e42f23660b3c461f95fde1988597385a75b405fc554399d43b6e20b',
  '../../favicon.svg': 'b3463c0684a3fa60eb788b71242dba3f300e76e061ae94c3d0c6e1be0d2f99c2'
};
function requireHash(value, expected, name) {
  assert.equal(sha256(value), expected, `${name} changed; the production control must be reviewed again`);
}
// Literal original lines from d32da62. Both complete source hashes are pinned;
// this is an exact reverse patch, never a fallback to the current ordinary UI.
const originalProductionLines = [[112, "      ${writes.length ? `<section class=\"connection-section\"><h3>Proposed changes</h3>${writes.slice(0,15).map(write => `<article class=\"connection-write\"><b>${esc(write.input.operation.replaceAll('_',' '))}</b><p>${esc(write.status.replaceAll('_',' '))}</p><details><summary>Review exact change</summary><dl>${Object.entries(write.input).map(([key,value]) => `<dt>${esc(key.replace(/([A-Z])/g,' $1'))}</dt><dd class=\"connection-exact-text\">${esc(value)}</dd>`).join('')}</dl></details><div class=\"button-row\">${write.approvalId ? button('approvals', 'Open Approval Centre', channel) : ''}${owner() && ['ready','processing'].includes(write.status) ? `<button class=\"secondary\" type=\"button\" data-connection-action=\"execute\" data-provider=\"${channel.id}\" data-write=\"${esc(write.id)}\">${write.status === 'processing' ? 'Check publishing progress' : write.requiresApproval ? 'Apply approved change' : 'Apply change'}</button>` : ''}</div>${write.status === 'processing' ? `<p>${write.observationErrorCode ? 'Instagram status could not be verified. The saved container is retained; check its status again after a minute.' : 'Instagram is preparing your image. Check again after a minute; the same approved request will be continued.'}</p>` : ''}${write.status === 'uncertain' ? '<p class=\"warn\">Check the channel before making another request. Runvara will not repeat an uncertain write.</p>' : ''}${write.status === 'failed' ? `<p class=\"warn\">${write.dispatchBlocked ? 'Runvara stopped this request before a new channel submission. Review the current permissions and prepare a new exact change.' : 'The channel declined this request. Test the connection, check the selected asset and fields, then prepare a new change.'}</p>` : ''}${write.result?.externalId ? `<p>Confirmed channel reference: ${esc(write.result.externalId)}</p>` : ''}</article>`).join('')}</section>` : ''}"], [113, "      <section class=\"connection-section\"><h3>Sync history</h3><p class=\"muted tiny\">Latest 30 syncs. Completed sync summaries remain in the workspace audit log.</p><div class=\"connection-history\">${channel.history.length ? channel.history.map(run => `<article><div><b>${esc({completed:'Completed',partial:'Partially completed',failed:'Needs attention',running:'In progress'}[run.status])}</b><small>${esc(when(run.startedAt))} · ${run.automatic ? 'Automatic' : 'Requested'}</small></div><p>${esc(run.areas.map(label).join(', '))}</p>${run.status === 'failed' || run.status === 'partial' ? '<p class=\"warn\">Some data could not be refreshed. Your previous data is retained. Use Sync now to retry.</p>' : ''}</article>`).join('') : '<p class=\"muted\">No sync history recorded yet. Your earlier imported data is retained.</p>'}</div></section>"], [154, "      if (operation === 'facebook_update') html += select('postId','Post published by Runvara',(data.connectionWrites || []).filter(item=>item.provider === 'meta' && item.status === 'completed' && item.input.operation === 'facebook_publish').map(item=>({id:item.result.externalId,name:item.input.message})));"]];
function reconstructProductionUI(source) {
  requireHash(source, bridgeUIHash, 'Bridge UI');
  const lines = source.split('\n');
  for (const [index, line] of originalProductionLines) lines[index] = line;
  const reconstructed = lines.join('\n');
  requireHash(reconstructed, productionUIHash, 'Reconstructed production UI');
  return reconstructed;
}
const productionUI = reconstructProductionUI(bridgeUI);
const ordinaryDocument = await renderConnectionPreview();
requireHash(ordinaryDocument, 'a001ffb4d30eb1f8a71fb55233ceea2c71ec20177517d90517fc1c1ca58a73ac', 'Ordinary fixture HTML');
requireHash(JSON.stringify(connectionPreviewFixture().payload), ordinaryPayloadHash, 'Ordinary fixture payload');
const escapedBridgeUI = bridgeUI.replaceAll('</script', '<\\/script');
assert.equal(ordinaryDocument.split(escapedBridgeUI).length, 2, 'exactly one embedded UI script is replaced');
const productionDocument = ordinaryDocument.replace(escapedBridgeUI, productionUI.replaceAll('</script', '<\\/script'));
requireHash(productionDocument, '6ef0a201cd6539d2ec98a83cf29507391343427c7a35ce76da9cfa461e0e232e', 'Reconstructed production fixture');

const sourceHashes = Object.fromEntries(await Promise.all([
  '../../index.html', '../../favicon.svg', '../../styles.css', '../../presentation.js', '../../connections-ui.js',
  './render-connection-preview.mjs', './compatibility-bridge-browser-check.mjs', '../lib/action-display.mjs'
].map(async file => [file, sha256(await fs.readFile(new URL(file, import.meta.url)))])));
for (const [file, expected] of Object.entries(sharedProductionHashes)) assert.equal(sourceHashes[file], expected, `Production layout source changed: ${file}`);
const manifest = { verificationBoundary: 'Compatibility nonregression against production; existing enlarged-text page defects are retained', productionCommit, productionUIHash, ordinaryPayloadHash, productionFixtureSha256: sha256(productionDocument), productionControls: [], schema: 'runvara-compatibility-browser-evidence/v1', syntheticOnly: true,
  fixtureSha256: sha256(document), sourceHashes, screenshots: [] };
if (!process.argv.includes('--self-test')) for (const width of widths) {
  await fs.mkdir(path.join(output, String(width)), { recursive: true });
  for (const name of [...scenarios.flatMap(scenario => scales.flatMap(scale => {
    const stem = `${scenario}-${scale * 100}pct`;
    return [`${stem}.png`, `${stem}-failure.png`, `${stem}-failure.json`, `${stem}-failure-ordinary-before-modal.png`, `${stem}-failure-compatibility-before-modal.png`];
  })), ...scales.map(scale => `production-ordinary-${scale * 100}pct.png`), 'production-controls.json', 'manifest.json']) {
    await fs.rm(path.join(output, String(width), name), { force: true });
  }
}
if (!process.argv.includes('--self-test')) await fs.rm(path.join(output, 'manifest.json'), { force: true });

async function waitForSettledMotion({ timeoutMs = 3000, runtime } = {}) {
  // Serialized into the browser; the injected runtime only serves local tests.
  const clock = runtime || {
    now: () => performance.now(), fontsReady: () => document.fonts.ready,
    frame: () => new Promise(resolve => requestAnimationFrame(resolve)),
    sample: () => {
      // Flush layout and hover-dependent styles before discovering newly
      // scheduled transitions. Never rely on one snapshot of .finished.
      document.documentElement.getBoundingClientRect();
      for (const element of document.querySelectorAll(':hover')) getComputedStyle(element).transform;
      return document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)
        && (animation.pending || ['running', 'paused'].includes(animation.playState))).map(animation => {
        const target = animation.effect?.target, timing = animation.effect?.getComputedTiming();
        return { type: animation.constructor.name, target: target?.id || `${target?.localName || ''}.${target?.getAttribute?.('class') || ''}`,
          property: animation.transitionProperty || animation.animationName || null, playState: animation.playState, pending: animation.pending,
          currentTime: animation.currentTime, endTime: timing?.endTime, delay: timing?.delay, duration: timing?.duration };
      });
    }
  };
  const started = clock.now();
  let stopped = false, timeout, phase = 'fonts', lastMotion = [], samples = 0, busySamples = 0, firstBusySample = null;
  const timedOut = () => new Error(`Animation settling exceeded ${timeoutMs}ms during ${phase}: ${JSON.stringify(lastMotion.slice(0, 8))}`);
  try {
    return await Promise.race([
      (async () => {
        await clock.fontsReady();
        phase = 'frames';
        let quietSince = null, quietFrames = 0;
        while (!stopped) {
          await clock.frame();
          if (stopped) return;
          const now = clock.now();
          if (now - started >= timeoutMs) throw timedOut();
          lastMotion = clock.sample(); samples++;
          if (lastMotion.length) { quietSince = null; quietFrames = 0; busySamples++; firstBusySample ??= samples; }
          else {
            quietSince ??= now; quietFrames++;
            // Consecutive post-layout frames catch transitions that start after
            // scroll, hit testing, focus or a preceding transition finishes.
            if (quietFrames >= 3 && now - quietSince >= 80) return { samples, busySamples, firstBusySample, quietFrames, elapsedMs: now - started };
          }
        }
      })(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(timedOut()), timeoutMs); })
    ]);
  } finally { stopped = true; clearTimeout(timeout); }
}

async function settle(page, { timeoutMs = 3000 } = {}) {
  // Preserve the current hover/focus state while production motion completes.
  return page.evaluate(waitForSettledMotion, { timeoutMs });
}

async function prepareCapture(page) {
  // Normal interaction and hit-test checks precede this explicit evidence state.
  // (0,0) stays outside controls when the evidence viewport is later restored.
  await page.mouse.move(0, 0);
  await settle(page);
  await assertTextScaleStable(page);
}

async function enlargeText(page, scale, probeSelector = '.connection-write > b') {
  // Text-only enlargement, including fixed-pixel text. Snapshot all computed
  // sizes before applying them so nested inheritance does not compound to 400%.
  // Keep the root size, widths, spacing and normal motion rules unchanged.
  return page.evaluate(({ scale, probeSelector }) => {
    const title = document.querySelector(probeSelector);
    const before = parseFloat(getComputedStyle(title).fontSize);
    const values = [...document.body.querySelectorAll('*'), document.body]
        .filter(element => element instanceof HTMLElement && !element.matches('script,style'))
        .map(element => { const style = getComputedStyle(element); return { element, fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight) }; });
    if (scale !== 1) {
      for (const { element, fontSize, lineHeight } of values) {
        element.style.fontSize = `${fontSize * scale}px`;
        if (Number.isFinite(lineHeight)) element.style.lineHeight = `${lineHeight * scale}px`;
      }
    }
    window.fixtureTextScale = { scale, values };
    return { before, after: parseFloat(getComputedStyle(title).fontSize), scale };
  }, { scale, probeSelector });
}

async function assertTextScaleStable(page) {
  // Intentionally immediate: after screenshot capture, waiting could hide a
  // transient invalid capture or allow a rerender to replace the tested state.
  const errors = await page.evaluate(() => {
    const snapshot = window.fixtureTextScale;
    if (!snapshot) return ['Text enlargement was not recorded'];
    const elements = [...document.body.querySelectorAll('*'), document.body].filter(element => element instanceof HTMLElement && !element.matches('script,style'));
    const errors = [];
    if (elements.length !== snapshot.values.length) errors.push('The document changed after enlargement');
    for (const { element, fontSize, lineHeight } of snapshot.values) {
      if (!element.isConnected) { errors.push('A scaled node was replaced'); break; }
      const style = getComputedStyle(element);
      if (Math.abs(parseFloat(style.fontSize) - fontSize * snapshot.scale) > .03
        || Number.isFinite(lineHeight) && Math.abs(parseFloat(style.lineHeight) - lineHeight * snapshot.scale) > .03) {
        errors.push(`Text size changed on ${element.id || element.tagName}`); break;
      }
    }
    const motion = document.getAnimations().filter(animation => (animation.pending || ['running', 'paused'].includes(animation.playState)) && Number.isFinite(animation.effect?.getComputedTiming().endTime));
    if (motion.length) errors.push(`Finite motion remains: ${JSON.stringify(motion.map(animation => ({ target: animation.effect?.target?.id || animation.effect?.target?.className, property: animation.transitionProperty || animation.animationName || null, playState: animation.playState, pending: animation.pending, currentTime: animation.currentTime, timing: animation.effect?.getComputedTiming() })))}`);
    return errors;
  });
  assert.deepEqual(errors, [], 'the tested text scale and nodes must survive until capture');
}

async function geometryEvidence(page, selectors) {
  return page.evaluate(selectors => selectors.map(selector => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Capture target is missing: ${selector}`);
    const rect = element.getBoundingClientRect();
    return { selector, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
  }), selectors);
}

async function checkedScreenshot(page, options, selectors) {
  // Callers finish settling before computing the clip. There is no settling or
  // pointer/focus mutation between these snapshots and the post-capture guards.
  await page.evaluate(() => {
    window.fixtureCaptureMotion = [];
    window.fixtureCaptureMotionListener = event => window.fixtureCaptureMotion.push({ type: event.type, target: event.target.id || event.target.className, property: event.propertyName || event.animationName });
    document.addEventListener('transitionrun', window.fixtureCaptureMotionListener, true);
    document.addEventListener('animationstart', window.fixtureCaptureMotionListener, true);
  });
  try {
    await assertTextScaleStable(page);
    const geometry = await geometryEvidence(page, selectors);
    const horizontal = await horizontalEvidence(page);
    const bytes = await page.screenshot(options);
    await assertTextScaleStable(page);
    assert.deepEqual(await geometryEvidence(page, selectors), geometry, 'capture target geometry cannot change during capture');
    assert.deepEqual(await horizontalEvidence(page), horizontal, 'tested layout cannot change during capture');
    assert.deepEqual(await page.evaluate(() => window.fixtureCaptureMotion), [], 'new CSS motion cannot start during capture');
    return bytes;
  } finally {
    await page.evaluate(() => {
      document.removeEventListener('transitionrun', window.fixtureCaptureMotionListener, true);
      document.removeEventListener('animationstart', window.fixtureCaptureMotionListener, true);
      delete window.fixtureCaptureMotionListener;
    });
  }
}

const maximumFixtureNodes = 5000;
async function horizontalEvidence(page) {
  return page.evaluate(maximumNodes => {
    const nodes = [...document.querySelectorAll('*')];
    if (nodes.length > maximumNodes) throw new Error('Fixture exceeds the complete-inspection node limit');
    const ids = new Set();
    for (const element of nodes) if (element.id) {
      if (ids.has(element.id)) throw new Error(`Duplicate DOM id: ${element.id}`);
      ids.add(element.id);
    }
    const path = element => {
      const parts = [];
      while (element) {
        if (element.id) { parts.unshift(`#${CSS.escape(element.id)}`); break; }
        if (element.hasAttribute('data-channel-card')) { parts.unshift(`[data-channel-card="${CSS.escape(element.getAttribute('data-channel-card'))}"]`); break; }
        const index = element.parentElement ? [...element.parentElement.children].indexOf(element) + 1 : 1;
        parts.unshift(`${element.localName}:nth-child(${index})`);
        element = element.parentElement;
      }
      return parts.join(' > ');
    };
    const rows = [], identities = new Set();
    for (const element of nodes) {
      // Hidden/inert/off-screen/clipped nodes still count when they have a box.
      // Native editable value scrolling is intentional; its outer box counts.
      if (!element.getClientRects().length || element.matches('script,style,link,meta')) continue;
      const identity = path(element);
      if (identities.has(identity)) throw new Error(`Duplicate layout identity: ${identity}`);
      identities.add(identity);
      const rect = element.getBoundingClientRect();
      const editable = element.matches('input,textarea,select');
      const internalOverflow = !editable && element.scrollWidth > element.clientWidth + 1;
      if (rect.left >= -1 && rect.right <= innerWidth + 1 && !internalOverflow) continue;
      rows.push({ identity, tag: element.localName, classes: element.getAttribute('class') || '',
        directText: [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').replace(/\s+/g, ' ').trim(),
        left: rect.left, right: rect.right, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        internalOverflow: internalOverflow ? element.scrollWidth - element.clientWidth : 0,
        inDialog: Boolean(element.closest('#connection-dialog')) });
    }
    const skip = document.querySelector('.skip-link').getBoundingClientRect();
    return { viewport: { width: innerWidth, height: innerHeight }, nodeCount: nodes.length,
      pageScroll: document.documentElement.scrollWidth, rows, textScale: window.fixtureTextScale?.scale,
      unfocusedSkipLinkVisible: document.activeElement !== document.querySelector('.skip-link') && skip.bottom > 0 };
  }, maximumFixtureNodes);
}

function assertOverflowNonRegression(candidate, baseline) {
  assert.deepEqual(candidate.viewport, baseline.viewport, 'baseline and candidate use the same viewport');
  assert.equal(candidate.textScale, baseline.textScale, 'baseline and candidate use the same text enlargement');
  for (const evidence of [candidate, baseline]) {
    assert.ok(evidence.nodeCount <= maximumFixtureNodes, 'all fixture nodes are inspected');
    assert.equal(new Set(evidence.rows.map(row => row.identity)).size, evidence.rows.length, 'overflow identities must be unique');
  }
  const background = new Map(baseline.rows.filter(row => !row.inDialog).map(row => [row.identity, row]));
  if (candidate.textScale === 1) {
    assert.ok(baseline.pageScroll <= baseline.viewport.width + 1, 'normal production page has no horizontal overflow');
    assert.ok(candidate.pageScroll <= candidate.viewport.width + 1, 'normal candidate page has no horizontal overflow');
    assert.equal(background.size, 0, 'normal production background has no overflow contributors');
    assert.equal(candidate.rows.filter(row => !row.inDialog).length, 0, 'normal candidate background has no overflow contributors');
  } else {
    assert.ok(candidate.pageScroll <= baseline.pageScroll + 1, 'candidate page overflow cannot exceed production');
  }
  for (const row of candidate.rows.filter(row => !row.inDialog)) {
    const prior = background.get(row.identity);
    assert.ok(prior, `new background overflow contributor: ${row.identity}`);
    assert.equal(row.tag, prior.tag, `overflow identity changed: ${row.identity}`);
    assert.equal(row.classes, prior.classes, `overflow identity changed: ${row.identity}`);
    assert.equal(row.directText, prior.directText, `overflowing text changed: ${row.identity}`);
    assert.ok(row.left >= prior.left - 1 && row.right <= prior.right + 1
      && Math.abs(row.clientWidth - prior.clientWidth) <= 1
      && row.scrollWidth <= prior.scrollWidth + 1 && row.internalOverflow <= prior.internalOverflow + 1,
    `background overflow worsened: ${row.identity}`);
  }
}

async function captureProductionControl(browser, width, scale) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'UTC', locale: 'en-GB', reducedMotion: 'no-preference' });
  const page = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
  try {
    await page.setContent(productionDocument);
    await settle(page);
    assert.equal(await page.locator('.connection-write').count(), 0, 'ordinary production fixture has no future write');
    assert.equal(await page.locator('[data-channel-card="shopify"] .connection-title').textContent(), 'Shopify');
    assert.equal(await page.locator('[data-channel-card="ebay"] .connection-title').textContent(), 'eBay');
    const font = await enlargeText(page, scale, '#page-title');
    await prepareCapture(page);
    const horizontal = await horizontalEvidence(page);
    assertOverflowNonRegression(horizontal, horizontal);
    const file = `${width}/production-ordinary-${scale * 100}pct.png`;
    await checkedScreenshot(page, { path: path.join(output, file) }, ['.command-bar', '#page-title', '#connection-grid']);
    assert.deepEqual(await horizontalEvidence(page), horizontal, 'production layout cannot change during capture');
    assert.deepEqual(errors, []); assert.deepEqual(requests, []);
    const bytes = await fs.readFile(path.join(output, file));
    const result = { width, textScale: scale, font, horizontal, file, sha256: sha256(bytes), bytes: bytes.length,
      dimensions: { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) },
      knownLimitations: [...(horizontal.pageScroll > width + 1 ? ['Existing production page horizontal overflow under text enlargement'] : []),
        ...(horizontal.unfocusedSkipLinkVisible ? ['Existing production unfocused skip link is partly visible under text enlargement'] : [])] };
    assert.deepEqual(result.dimensions, { width, height: 900 });
    return result;
  } finally { await context.close(); }
}

function checkComparatorRejections() {
  const row = { identity: '#shared > span:nth-child(1)', tag: 'span', classes: 'tag', directText: 'Existing label', left: 10, right: 419, clientWidth: 300, scrollWidth: 409, internalOverflow: 109, inDialog: false };
  const baseline = { viewport: { width: 320, height: 900 }, nodeCount: 100, textScale: 2, pageScroll: 419, rows: [row] };
  assertOverflowNonRegression(structuredClone(baseline), baseline);
  assertOverflowNonRegression({ ...baseline, rows: [] }, baseline);
  let attackCases = 0;
  const rejected = (check, message) => { assert.throws(check, message); attackCases++; };
  const rejection = mutate => { const candidate = structuredClone(baseline); mutate(candidate); rejected(() => assertOverflowNonRegression(candidate, baseline)); };
  rejection(value => { value.pageScroll = 421; });
  rejection(value => { value.rows.push({ ...row, identity: '#new', right: 350 }); });
  rejection(value => { value.rows[0].right += 2; });
  rejection(value => { value.rows[0].left -= 2; });
  rejection(value => { value.rows[0].internalOverflow += 2; value.rows[0].clientWidth -= 2; });
  rejection(value => { value.rows[0].scrollWidth += 2; });
  rejection(value => { value.rows[0].directText = 'Different item at a reordered path'; });
  rejection(value => { value.rows[0].classes = 'reordered-other-item'; });
  rejection(value => { value.rows.push({ ...row }); });
  rejection(value => { value.nodeCount = maximumFixtureNodes + 1; });
  rejection(value => { value.textScale = 1; });
  for (const condition of ['below-fold', 'behind-modal', 'inert', 'aria-hidden', 'visibility-hidden', 'opacity-zero', 'clipped-child']) {
    rejection(value => { value.rows.push({ ...row, identity: `#new-${condition}`, right: 350, internalOverflow: 20 }); });
  }
  const many = { ...baseline, rows: Array.from({ length: 30 }, (_, index) => ({ ...row, identity: `#item-${index}` })) };
  const changed = structuredClone(many); changed.rows[24].right += 2;
  rejected(() => assertOverflowNonRegression(changed, many), 'the 25th contributor is not truncated');
  rejected(() => reconstructProductionUI(bridgeUI + '\n'), 'source mismatch cannot fall back');
  rejected(() => requireHash('changed', ordinaryPayloadHash, 'Synthetic fixture'), 'fixture mismatch cannot fall back');
  rejected(() => assertOverflowNonRegression({ ...baseline, textScale: 1 }, { ...baseline, textScale: 1 }), 'normal text cannot inherit enlarged overflow');
  return { passed: true, syntheticRejectionCases: attackCases, productionUIHash: sha256(productionUI) };
}

async function checkMotionSettling() {
  const animation = { target: 'synthetic-control', property: 'background-color', playState: 'running', pending: false, currentTime: 16, endTime: 160 };
  const runtime = sample => {
    let time = 0;
    return { now: () => time, fontsReady: async () => {}, frame: async () => { time += 16; }, sample: () => sample(time) };
  };
  const delayed = await waitForSettledMotion({ runtime: runtime(time => time >= 48 && time <= 112 ? [animation] : []) });
  assert.equal(delayed.busySamples, 5, 'late motion must be discovered after initially quiet frames');
  assert.equal(delayed.firstBusySample, 3);
  assert.ok(delayed.elapsedMs >= 208, 'quiet observations restart after late motion');
  const restarted = await waitForSettledMotion({ runtime: runtime(time => time === 48 || time === 80 ? [{ ...animation, pending: time === 80 }] : []) });
  assert.equal(restarted.busySamples, 2, 'a pending restart invalidates the earlier quiet interval');
  assert.ok(restarted.elapsedMs >= 176);
  for (const state of ['paused', 'pending']) {
    await assert.rejects(() => waitForSettledMotion({ timeoutMs: 96, runtime: runtime(() => [{ ...animation, playState: state === 'paused' ? 'paused' : 'idle', pending: state === 'pending' }]) }), error => {
      assert.match(error.message, /Animation settling exceeded 96ms/);
      assert.match(error.message, /synthetic-control/);
      assert.match(error.message, /background-color/);
      assert.match(error.message, state === 'paused' ? /"playState":"paused"/ : /"pending":true/);
      return true;
    });
  }
  for (const phase of ['fonts', 'frames']) {
    const clock = runtime(() => []);
    clock[phase === 'fonts' ? 'fontsReady' : 'frame'] = () => new Promise(() => {});
    await assert.rejects(() => waitForSettledMotion({ timeoutMs: 25, runtime: clock }), new RegExp(`exceeded 25ms during ${phase}`));
  }
  return { passed: true, injectedRuntimeChecks: ['late-start', 'pending-restart', 'paused-deadline', 'pending-deadline', 'stalled-font-deadline', 'stalled-frame-deadline'] };
}

async function verifyCollectorInBrowser(browser) {
  const results = [];
  for (const condition of ['new-350px', 'below-fold', 'visibility-hidden', 'opacity-zero', 'inert', 'aria-hidden', 'behind-modal', 'clipped-child', 'duplicate-id', 'reordered-shared-class', 'replaced-scaled-node', 'reset-scaled-font']) {
    const context = await browser.newContext({ viewport: { width: 320, height: 900 }, timezoneId: 'UTC', locale: 'en-GB', reducedMotion: 'no-preference' });
    const page = await context.newPage(), errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
    try {
      await page.setContent(productionDocument); await settle(page);
      await enlargeText(page, 2, '#page-title'); await settle(page);
      const baseline = await horizontalEvidence(page);
      await page.evaluate(condition => {
        if (condition === 'replaced-scaled-node') {
          const title = document.querySelector('#page-title'); title.replaceWith(title.cloneNode(true)); return;
        }
        if (condition === 'reset-scaled-font') { document.querySelector('#page-title').style.fontSize = '16px'; return; }
        const probe = document.createElement('div'); probe.id = 'collector-probe'; probe.textContent = 'Synthetic collector probe';
        probe.style.cssText = `position:absolute;left:0;top:${condition === 'new-350px' ? 0 : 10000}px;width:350px;height:24px`;
        if (condition === 'visibility-hidden') probe.style.visibility = 'hidden';
        if (condition === 'opacity-zero') probe.style.opacity = '0';
        if (condition === 'inert') probe.inert = true;
        if (condition === 'aria-hidden') probe.setAttribute('aria-hidden', 'true');
        if (condition === 'behind-modal') window.RunvaraConnections.open('shopify');
        if (condition === 'duplicate-id') probe.id = 'page-title';
        if (condition === 'clipped-child') {
          probe.style.width = '100px'; probe.style.overflow = 'hidden'; probe.textContent = '';
          const child = document.createElement('div'); child.style.cssText = 'width:350px;height:20px'; child.textContent = 'Clipped synthetic child'; probe.append(child);
        }
        if (condition === 'reordered-shared-class') {
          probe.textContent = ''; probe.style.height = 'auto';
          for (const text of ['First synthetic overflow', 'Second synthetic overflow']) {
            const child = document.createElement('div'); child.className = 'shared-class'; child.textContent = text;
            child.style.cssText = 'width:350px;height:24px'; probe.append(child);
          }
        }
        document.body.append(probe);
      }, condition);
      if (condition === 'duplicate-id') {
        await assert.rejects(() => horizontalEvidence(page), /Duplicate DOM id/);
      } else if (condition === 'replaced-scaled-node' || condition === 'reset-scaled-font') {
        await assert.rejects(() => assertTextScaleStable(page), /tested text scale and nodes/);
      } else if (condition === 'reordered-shared-class') {
        const before = await horizontalEvidence(page);
        await page.evaluate(() => { const probe = document.querySelector('#collector-probe'); probe.prepend(probe.lastElementChild); });
        const after = await horizontalEvidence(page);
        assert.throws(() => assertOverflowNonRegression(after, before), /overflowing text changed/);
      } else {
        const candidate = await horizontalEvidence(page);
        assert.ok(candidate.rows.some(row => row.identity.includes('#collector-probe')), `actual DOM collector must retain ${condition}`);
        assert.throws(() => assertOverflowNonRegression(candidate, baseline), /new background overflow contributor/);
      }
      assert.deepEqual(errors, []); assert.deepEqual(requests, []);
      results.push({ condition, rejected: true });
    } finally { await context.close(); }
  }
  return { passed: true, isolatedSyntheticBrowserProbes: results };
}

async function verifyMotionInBrowser(browser) {
  const results = [];
  for (const scale of scales) {
    const context = await browser.newContext({ viewport: { width: 320, height: 900 }, timezoneId: 'UTC', locale: 'en-GB', reducedMotion: 'no-preference' });
    const page = await context.newPage(), errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
    try {
      await page.setContent(document); await settle(page);
      const opener = page.locator('[data-channel-card="shopify"] .connection-title');
      await opener.click();
      assert.equal(await page.locator('#connection-close').evaluate(element => document.activeElement === element), true);
      await enlargeText(page, scale); await settle(page);
      const summary = page.locator('.connection-write summary');
      await summary.click();
      await page.evaluate(() => {
        window.fixtureHoverTransitions = [];
        document.addEventListener('transitionrun', event => {
          if (event.target.matches('[data-write="write_legacy"]')) window.fixtureHoverTransitions.push(event.propertyName);
        });
      });
      const apply = page.locator('[data-write="write_legacy"]');
      await apply.hover();
      const hovered = await settle(page);
      assert.equal(await apply.evaluate(element => element.matches(':hover')), true, 'settling preserves a real hovered control');
      const hoverTransitions = await page.evaluate(() => window.fixtureHoverTransitions);
      assert.ok(hoverTransitions.length > 0, 'normal production hover transitions remain enabled');
      await assertTextScaleStable(page);

      const history = page.locator('#connection-detail > .connection-section:has(.connection-history) > h3');
      await history.scrollIntoViewIfNeeded();
      await history.evaluate(element => {
        const dialog = document.querySelector('#connection-dialog');
        dialog.scrollTop += element.getBoundingClientRect().top - document.querySelector('#connection-close').getBoundingClientRect().bottom - 12;
        const rect = element.getBoundingClientRect();
        document.elementFromPoint(rect.left + 8, rect.top + 8);
      });
      await settle(page); await assertTextScaleStable(page);
      for (const height of [1100, 900]) { await page.setViewportSize({ width: 320, height }); await settle(page); await assertTextScaleStable(page); }
      await summary.click();
      assert.equal(await page.locator('.connection-write details').getAttribute('open'), null);
      await page.keyboard.press('Tab'); await settle(page);
      assert.equal(await page.evaluate(() => document.querySelector('#connection-dialog').contains(document.activeElement)), true);
      await summary.click(); await settle(page);
      assert.notEqual(await page.locator('.connection-write details').getAttribute('open'), null);

      // Start an actual finite CSS transition after the wait has already seen
      // quiet frames. This exercises the old one-snapshot race in a browser.
      await page.evaluate(`window.fixtureWaitForSettledMotion = (${waitForSettledMotion.toString()})`);
      const late = await page.evaluate(async () => {
        const target = document.querySelector('[data-write="write_legacy"]');
        const previousStyle = target.getAttribute('style');
        target.style.transition = 'transform 120ms linear';
        getComputedStyle(target).transform;
        const startLater = remaining => requestAnimationFrame(() => remaining ? startLater(remaining - 1) : (target.style.transform = 'translateY(2px)'));
        startLater(2);
        try { return await window.fixtureWaitForSettledMotion(); }
        finally { if (previousStyle === null) target.removeAttribute('style'); else target.setAttribute('style', previousStyle); }
      });
      assert.ok(late.busySamples > 0 && late.firstBusySample > 1, 'late CSS motion must be discovered after initially quiet frames');
      await settle(page); await assertTextScaleStable(page);

      await page.evaluate(() => {
        window.fixturePausedAnimation = document.querySelector('#connection-close').animate([{ opacity: 1 }, { opacity: .8 }], { duration: 1000 });
        window.fixturePausedAnimation.pause();
      });
      await assert.rejects(() => settle(page, { timeoutMs: 150 }), /Animation settling exceeded 150ms.*"playState":"paused"/);
      await assert.rejects(() => assertTextScaleStable(page), /tested text scale and nodes/);
      await page.evaluate(() => window.fixturePausedAnimation.cancel());
      await page.evaluate(() => {
        window.fixtureFinishedAnimation = document.querySelector('#connection-close').animate([{ opacity: 1 }, { opacity: 1 }], { duration: 20, fill: 'forwards' });
      });
      await settle(page); await assertTextScaleStable(page);
      assert.equal(await page.evaluate(() => window.fixtureFinishedAnimation.playState), 'finished');
      assert.equal(await page.evaluate(() => document.getAnimations().includes(window.fixtureFinishedAnimation)), true, 'a retained finished animation is inspected without blocking');
      await page.evaluate(() => window.fixtureFinishedAnimation.cancel());
      await prepareCapture(page);
      const targets = ['#connection-detail > .connection-section:has(.connection-write)', '#connection-close'];
      const screenshot = await checkedScreenshot(page, {}, targets);
      assert.equal(screenshot.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      // A vertical-only movement introduced at capture must fail immediately;
      // unchanged horizontal contributors alone are insufficient evidence.
      const driftingPage = { evaluate: (...args) => page.evaluate(...args), screenshot: async options => {
        await page.evaluate(selector => { document.querySelector(selector).style.transform = 'translateY(2px)'; }, targets[0]);
        return page.screenshot(options);
      } };
      await assert.rejects(() => checkedScreenshot(driftingPage, {}, targets), /capture target geometry cannot change/);
      await page.evaluate(selector => { document.querySelector(selector).style.removeProperty('transform'); }, targets[0]);
      await settle(page); await assertTextScaleStable(page);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#connection-dialog').isVisible(), false);
      assert.equal(await opener.evaluate(element => document.activeElement === element), true);
      assert.deepEqual(errors, []); assert.deepEqual(requests, []);
      assert.equal(await page.evaluate(() => window.fixtureRequests.every(request => request.method === 'GET')), true);
      results.push({ textScale: scale, hovered, hoverTransitions, late, pausedDeadlineRejected: true, immediateMotionGuardRejected: true, retainedFinishedAnimationAccepted: true, verticalCaptureDriftRejected: true });
    } finally { await context.close(); }
  }
  return { passed: true, isolatedSyntheticBrowserSequences: results };
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
      const fixture = compatibility ? document : productionDocument;
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

async function checkLayout(page, width, productionControl) {
  await settle(page);
  await assertTextScaleStable(page);
  const layout = await page.evaluate(() => {
    const dialog = document.querySelector('#connection-dialog');
    const rect = dialog.getBoundingClientRect();
    const affected = [...document.querySelectorAll('#connection-dialog .connection-write, #connection-dialog .connection-history, #connection-dialog .connection-exact-text, #connection-dialog .connection-notice, .connection-health')];
    for (const element of affected.filter(element => element.matches('.connection-write,.connection-history,.connection-health,#connection-detail > .connection-notice'))) {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height || getComputedStyle(element).visibility !== 'visible') throw new Error('Affected connection content is hidden');
      for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) if (Number(getComputedStyle(ancestor).opacity) === 0) throw new Error('Affected connection content is transparent');
    }
    const targets = affected
      .filter(element => element.getBoundingClientRect().height > 0)
      .map(element => ({ kind: element.className, width: element.clientWidth, scroll: element.scrollWidth, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }));
    return { viewport: { width: innerWidth, height: innerHeight }, pageScroll: document.documentElement.scrollWidth,
      dialog: { width: dialog.clientWidth, scroll: dialog.scrollWidth, left: rect.left, right: rect.right }, targets,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches };
  });
  assert.deepEqual(layout.viewport, { width, height: 900 }, 'validation uses the normal customer viewport');
  assert.equal(layout.reducedMotion, false, 'production animations stay enabled');
  const horizontal = await horizontalEvidence(page);
  assertOverflowNonRegression(horizontal, productionControl.horizontal);
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
  await settle(page);
  await assertTextScaleStable(page);
  return { ...layout, scrollTargets, horizontal, productionControl: productionControl.file };
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
  await prepareCapture(page);
  const captureTargets = [...selectors, '#connection-close'];
  const clipGeometry = await geometryEvidence(page, captureTargets);
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
  assert.deepEqual(await geometryEvidence(page, captureTargets), clipGeometry, 'clip geometry must remain current before capture');
  await checkedScreenshot(page, { path: destination, clip }, captureTargets);
  assert.deepEqual(await geometryEvidence(page, captureTargets), clipGeometry, 'captured geometry must still match the validated clip');
  const bytes = await fs.readFile(destination);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'evidence is an actual PNG');
  const dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  assert.equal(dimensions.width, clip.width);
  assert.equal(dimensions.height, clip.height);
  await page.setViewportSize({ width, height: 900 });
  await page.mouse.move(0, 0);
  await settle(page);
  return { file: `${width}/${file}`, sha256: sha256(bytes), bytes: bytes.length, dimensions, captureViewport, clip };
}

const comparatorChecks = checkComparatorRejections();
const motionSettlingChecks = await checkMotionSettling();
if (process.argv.includes('--self-test')) {
  console.log(JSON.stringify({ ...comparatorChecks, motionSettlingChecks, productionFixtureSha256: sha256(productionDocument), ordinaryPayloadHash }));
} else {
let browser;
try {
  browser = await chromium.launch({ headless: true });
  manifest.domCollectorProbes = await verifyCollectorInBrowser(browser);
  manifest.motionSettlingChecks = motionSettlingChecks;
  manifest.motionSettlingProbes = await verifyMotionInBrowser(browser);
  console.log(JSON.stringify({ motionSettlingChecks, motionSettlingProbes: manifest.motionSettlingProbes }));
  for (const width of widths) {
    const productionControls = new Map();
    for (const scale of scales) {
      const control = await captureProductionControl(browser, width, scale);
      productionControls.set(scale, control); manifest.productionControls.push(control);
      console.log(JSON.stringify({ productionControl: control.file, width, textScale: scale, pageScroll: control.horizontal.pageScroll, contributors: control.horizontal.rows.length, knownLimitations: control.knownLimitations }));
    }
    await fs.writeFile(path.join(output, String(width), 'production-controls.json'), JSON.stringify({ productionCommit, productionUIHash, ordinaryPayloadHash, productionFixtureSha256: sha256(productionDocument), sourceHashes, expectedImageCount: 2, controls: [...productionControls.values()] }, null, 2) + '\n');
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
        assert.equal(await write.isVisible(), true, 'saved change remains visible');
        if (scenario === 'compatibility-held') {
          assert.match(await write.textContent(), /Unsupported saved change/);
          assert.match(await write.textContent(), /requires a newer compatible release/);
          assert.equal(await write.locator('[data-connection-action="execute"],details').count(), 0);
          const history = page.locator('.connection-history');
          assert.equal(await history.isVisible(), true, 'deferred history remains visible');
          assert.equal(await history.locator('b').textContent(), 'Deferred');
          assert.match(await history.textContent(), /Saved read safety state requires a newer compatible reader/);
          assert.doesNotMatch(await history.textContent(), /Use Sync now|In progress|Completed|Partially completed|reset/i);
          assert.equal(await history.locator('button,progress').count(), 0);
          assert.equal(await page.locator('#connection-progress progress').count(), 0);
          const hold = dialog.locator('.connection-notice').filter({ hasText: 'Saved read safety state requires a newer compatible reader' });
          assert.equal(await hold.count(), 1);
          assert.equal(await hold.isVisible(), true, 'saved compatibility notice remains visible');
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
        const layout = await checkLayout(page, width, productionControls.get(scale));
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
    const controls = manifest.productionControls.filter(item => item.width === width);
    await fs.writeFile(path.join(output, String(width), 'manifest.json'), JSON.stringify({ ...manifest, expectedImageCount: 6, productionControls: controls, screenshots }, null, 2) + '\n');
  }
  assert.equal(manifest.screenshots.length, 12);
  assert.equal(manifest.productionControls.length, 6);
  manifest.expectedImageCount = 18;
  manifest.comparatorChecks = comparatorChecks;
  manifest.totalImageBytes = [...manifest.screenshots, ...manifest.productionControls].reduce((sum, item) => sum + item.bytes, 0);
  assert.ok(manifest.totalImageBytes < 28 * 1024 * 1024, 'combined evidence remains comfortably below the 32 MiB artifact limit');
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Compatibility bridge nonregression checks passed against production: 12 bridge screenshots and 6 production controls at 320, 390 and 1200 pixels, normal and 200% text. Existing enlarged-text page accessibility limitations remain; this is not a general accessibility pass. Manifest: ${output}/manifest.json`);
} finally {
  await browser?.close();
}
}
