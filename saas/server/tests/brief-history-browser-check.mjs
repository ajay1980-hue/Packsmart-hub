// Real local app with a synthetic tenant and bounded intercepted saved-brief reads.
// No provider requests, external writes or public uploads. CI uses pinned Chromium.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-brief-browser-'));
const secret = 'saved-brief-browser-fixture-over-thirty-two-characters';
const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret, SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' }, { schedulerEnabled: false, agentOpsEnabled: false });
const captures = [], verifiedStates = [], scrolledStates = [], scrollCoverage = [], executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const capturedStates = new Set(['list', 'verified', 'complete-detail', 'legacy', 'unavailable', 'oversized']);
let browser;
const hold = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const hostile = '<img src=x onerror="window.briefHistoryInjected=true">';
const id = 'saved/brief?synthetic=1', generatedAt = '2026-10-01T10:00:00.000Z';
const full = { id, generatedAt, summary: 'Saved observations for this earlier period. Profit was unknown because recorded costs were incomplete.',
  today: { profit: null, recordedAmount: '12.3400', currency: 'GBP' }, topActions: [{ title: 'Review recorded coverage', detail: 'This earlier recommendation does not confirm an action was executed.' }],
  recommendations: [{ title: 'Inspect saved source evidence', detail: 'Historical evidence remains subject to the recorded qualification.' }], originalEvidence: { qualification: 'Saved source observation only', hostile, longField: 'recorded-detail-'.repeat(50) } };
const list = integrity => ({ limit: 30, briefs: [{ id, generatedAt, summary: full.summary, archived: integrity !== 'retained', integrity }] });

async function scaleText(page, percent) {
  if (percent !== 200) return;
  await page.locator('#brief-history-dialog, .brief-history-controls').evaluateAll(roots => {
    const elements = roots.flatMap(root => [root, ...root.querySelectorAll('*')]);
    // Restore the whole subtree before measuring new nodes, so inherited text
    // is never scaled twice after a list or detail render.
    elements.forEach(element => {
      if (!Object.hasOwn(element.dataset, 'briefOriginalFont')) element.dataset.briefOriginalFont = element.style.fontSize;
      element.style.fontSize = element.dataset.briefOriginalFont;
    });
    const sizes = elements.map(element => parseFloat(getComputedStyle(element).fontSize));
    elements.forEach((element, i) => { element.style.fontSize = sizes[i] * 2 + 'px'; });
  });
}
async function capture(page, width, percent, state, scrolled = false) {
  if (!scrolled) await scaleText(page, percent);
  await page.mouse.move(0, 0);
  if (state === 'complete-detail') await page.locator('#brief-history-body').evaluate(body => { body.scrollTop = body.scrollHeight; });
  const modal = page.locator('#brief-history-dialog');
  await modal.evaluate(async element => {
    await document.fonts.ready;
    const animations = element.getAnimations({ subtree: true });
    await Promise.allSettled(animations.filter(animation => animation.playbackRate !== 0 && Number.isFinite(animation.effect?.getComputedTiming().endTime) && !['finished', 'idle'].includes(animation.playState)).map(animation => animation.finished));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const dimensions = await modal.evaluate(element => {
    const box = node => { const rect = node.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }; };
    const body = document.getElementById('brief-history-body'), close = document.getElementById('brief-history-close'), heading = document.getElementById('brief-history-title');
    const closeBox = box(close), titleBox = box(heading), hit = document.elementFromPoint(closeBox.left + closeBox.width / 2, closeBox.top + closeBox.height / 2);
    return { modal: box(element), body: box(body), close: closeBox, title: titleBox, width: innerWidth, height: innerHeight, bodyWidth: body.clientWidth, bodyScrollWidth: body.scrollWidth,
      modalWidth: element.clientWidth, modalScrollWidth: element.scrollWidth, closeVisible: hit === close || close.contains(hit), titleFont: parseFloat(getComputedStyle(heading).fontSize),
      buttons: [...element.querySelectorAll('button')].filter(button => button.getClientRects().length).map(button => ({ bounds: box(button), clientWidth: button.clientWidth, scrollWidth: button.scrollWidth, clientHeight: button.clientHeight, scrollHeight: button.scrollHeight })) };
  });
  const diagnostic = `${width}/${percent}%/${state}: ${JSON.stringify(dimensions)}`;
  try {
    assert.ok(dimensions.modal.left >= 0 && dimensions.modal.right <= width + 1 && dimensions.modal.top >= 0 && dimensions.modal.bottom <= dimensions.height + 1, 'modal stays in the viewport: ' + diagnostic);
    assert.ok(dimensions.bodyScrollWidth <= dimensions.bodyWidth + 1 && dimensions.modalScrollWidth <= dimensions.modalWidth + 1, 'modal content wraps without horizontal overflow: ' + diagnostic);
    assert.ok(dimensions.closeVisible && dimensions.close.top >= 0 && dimensions.close.bottom <= dimensions.height, 'close remains visible and unobstructed: ' + diagnostic);
    assert.ok(Math.min(dimensions.close.right, dimensions.title.right) - Math.max(dimensions.close.left, dimensions.title.left) <= 1 || Math.min(dimensions.close.bottom, dimensions.title.bottom) - Math.max(dimensions.close.top, dimensions.title.top) <= 1, 'heading and close do not overlap: ' + diagnostic);
    for (const button of dimensions.buttons) assert.ok(button.scrollWidth <= button.clientWidth + 1 && button.scrollHeight <= button.clientHeight + 1 && button.bounds.left >= dimensions.body.left - 1 && button.bounds.right <= dimensions.modal.right, 'buttons wrap their complete labels: ' + diagnostic);
    assert.ok(Math.abs(dimensions.titleFont - 19.2 * percent / 100) < .2, 'the changed title uses the requested text scale: ' + diagnostic);
  } catch (error) {
    // Preserve the actual visible failed layout without changing motion or styles.
    // The crop is bounded to this viewport, including when the modal overflows it.
    const left = Math.max(0, Math.min(width - 1, Math.floor(dimensions.modal.left)));
    const top = Math.max(0, Math.min(dimensions.height - 1, Math.floor(dimensions.modal.top)));
    const clip = { x: left, y: top, width: Math.max(1, Math.min(width, Math.ceil(dimensions.modal.right)) - left), height: Math.max(1, Math.min(dimensions.height, Math.ceil(dimensions.modal.bottom)) - top) };
    const filename = `/tmp/runvara-brief-history-${width}-${state}-${percent}pct-failure.png`;
    let imageError = null;
    try { await page.screenshot({ path: filename, clip, fullPage: false, animations: 'allow', scale: 'css' }); }
    catch (cause) { imageError = String(cause.message).slice(0, 1000); }
    await fs.writeFile(filename.replace(/\.png$/, '.json'), JSON.stringify({ viewportWidth: width, textScale: percent, state, error: String(error.message).slice(0, 4096), dimensions, crop: clip, filename, imageError }, null, 2));
    throw error;
  }
  (scrolled ? scrolledStates : verifiedStates).push({ viewportWidth: width, textScale: percent, state, geometry: 'passed', dimensions });
  if (!scrolled && !capturedStates.has(state)) return;
  const filename = `/tmp/runvara-brief-history-${width}-${state}-${percent}pct.png`;
  const clip = { x: Math.floor(dimensions.modal.left), y: Math.floor(dimensions.modal.top), width: Math.ceil(dimensions.modal.right) - Math.floor(dimensions.modal.left), height: Math.ceil(dimensions.modal.bottom) - Math.floor(dimensions.modal.top) };
  const bytes = await page.screenshot({ path: filename, clip, fullPage: false, animations: 'allow', scale: 'css' });
  captures.push({ filename, viewportWidth: width, textScale: percent, state, crop: clip, bytes: bytes.length });
  if (!scrolled && percent === 200 && state !== 'complete-detail') await captureScrolledEvidence(page, width, percent, state);
}
async function captureScrolledEvidence(page, width, percent, state) {
  const selectors = {
    list: '#brief-history-list .brief-history-record',
    verified: '#brief-history-detail > h3, #brief-history-detail > .brief-history-integrity, #brief-history-detail > .muted, #brief-history-detail > .brief-history-notice',
    legacy: '#brief-history-detail > h3, #brief-history-detail > .brief-history-integrity, #brief-history-detail > .brief-history-notice',
    unavailable: '#brief-history-back, #brief-history-status, #brief-history-retry',
    oversized: '#brief-history-back, #brief-history-status, #brief-history-retry'
  };
  const selector = selectors[state];
  assert.ok(selector, 'a captured enlarged state has an explicit content target');
  const body = page.locator('#brief-history-body');
  const target = await body.evaluate((element, selector) => {
    const bounds = element.getBoundingClientRect();
    const nodes = [...element.querySelectorAll(selector)];
    const boxes = nodes.map(node => node.getBoundingClientRect());
    return { count: boxes.length, visible: nodes.every(node => !node.hidden && node.getClientRects().length),
      start: Math.min(...boxes.map(box => box.top - bounds.top + element.scrollTop)),
      end: Math.max(...boxes.map(box => box.bottom - bounds.top + element.scrollTop)),
      height: element.clientHeight, maximum: element.scrollHeight - element.clientHeight,
      overflowY: getComputedStyle(element).overflowY };
  }, selector);
  assert.ok(target.count && target.visible && target.height > 100 && target.end > target.start, 'bounded visible scroll targets');
  assert.ok(['auto', 'scroll'].includes(target.overflowY), 'the real body permits user scrolling');
  const frames = [];
  let requested = Math.min(target.maximum, Math.max(0, target.start - 12)), covered = target.start;
  for (let index = 0; index < 8; index++) {
    const before = await body.evaluate(element => ({ top: element.scrollTop, box: element.getBoundingClientRect().toJSON() }));
    await page.mouse.move(before.box.left + before.box.width / 2, before.box.top + before.box.height / 2);
    await page.mouse.wheel(0, requested - before.top);
    await page.waitForFunction(top => Math.abs(document.getElementById('brief-history-body').scrollTop - top) <= 2, requested);
    // Preserve real app styles and motion. Do not rescale at this position: temporarily
    // shrinking fonts could clamp scrollTop and hide the evidence being reviewed.
    const frameState = `${state}-scrolled-${index + 1}`;
    await capture(page, width, percent, frameState, true);
    const top = await body.evaluate(element => element.scrollTop), bottom = top + target.height;
    assert.ok(top <= covered + 2 && bottom > covered, 'scrolled pixels cover the target without gaps');
    frames.push({ state: frameState, top, bottom }); covered = bottom;
    if (covered >= target.end - 1) break;
    requested = Math.min(target.maximum, top + target.height - 96);
  }
  assert.ok(covered >= target.end - 1, 'every line and target control is covered within eight real viewport captures');
  scrollCoverage.push({ viewportWidth: width, textScale: percent, state, selector, target, frames });
}
try {
  const state = seedWorkspaceState({}, { workspaceId: 'brief-browser', name: 'Synthetic saved briefs', email: 'brief@example.test', passwordHash: 'fixture-only' }); state.products = [];
  await server.packsmart.store.save(state.workspace.id, state); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  const bootstrapResponse = await fetch(base + '/api/bootstrap', { headers: { Cookie: `packsmart_session=${token}` } });
  assert.equal(bootstrapResponse.status, 200); const bootstrap = await bootstrapResponse.json();
  if (executablePath) assert.ok(path.isAbsolute(executablePath));
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  for (const width of [320, 390, 430, 1200]) for (const percent of [100, 200]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addCookies([{ name: 'packsmart_session', value: token, url: base, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage(), errors = [], calls = [], writes = [], external = [];
    let listValue = list('archive_pending_read'), detailValue = { brief: full, integrity: 'verified_archive' }, detailStatus = 200, listStatus = 200, pendingList = null, pendingDetail = null;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() !== 'GET') writes.push(request.method() + ' ' + new URL(request.url()).pathname); });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { external.push(url.origin); return route.abort(); }
      if (url.pathname === '/api/auth/logout') return route.fulfill({ json: { ok: true } });
      if (url.pathname === '/api/auth/login') return route.fulfill({ json: { user: bootstrap.user, workspace: bootstrap.workspace, csrf: 'synthetic-new-session' } });
      if (!url.pathname.startsWith('/api/briefs')) return route.continue();
      calls.push({ pathname: url.pathname, search: url.search, method: route.request().method() });
      if (url.pathname === '/api/briefs') {
        assert.equal(url.search, '?view=history'); const payload = listValue, status = listStatus, pending = pendingList;
        if (pending) await pending.promise;
        return route.fulfill({ status, json: payload });
      }
      assert.equal(url.pathname, '/api/briefs/' + encodeURIComponent(id)); assert.equal(url.search, '');
      const payload = detailValue, status = detailStatus, pending = pendingDetail;
      if (pending) await pending.promise;
      return route.fulfill({ status, json: payload });
    });
    const open = async () => { await page.locator('#open-brief-history').click(); await page.locator('#brief-history-dialog[open]').waitFor(); };
    const loadedList = async () => { await page.locator('#brief-history-list button').waitFor(); };
    const loadedDetail = async () => { await page.locator('#brief-history-detail-title').waitFor(); };
    const close = async () => { await page.locator('#brief-history-close').click(); assert.equal(await page.locator('#brief-history-dialog').getAttribute('open'), null); assert.equal(await page.locator('#brief-history-list').textContent(), ''); assert.equal(await page.locator('#brief-history-detail').textContent(), ''); };
    await page.goto(base); await page.locator('#app-shell:not(.hidden)').waitFor(); assert.equal(calls.length, 0, 'boot is quiet');
    await page.evaluate(() => { document.querySelector('#main-nav [data-view="profit"]').click(); document.querySelector('#main-nav [data-view="overview"]').click(); });
    assert.equal(calls.length, 0, 'navigation is quiet');
    pendingList = hold(); await open(); await page.getByText('Loading saved briefs…', { exact: true }).waitFor(); await capture(page, width, percent, 'loading');
    await page.locator('#open-brief-history').evaluate(button => { button.click(); button.click(); }); assert.equal(calls.length, 1, 'repeated opening coalesces');
    pendingList.release(); pendingList = null; await loadedList(); await capture(page, width, percent, 'list'); assert.equal(calls.length, 1, 'list never prefetches full records');
    pendingDetail = hold(); await page.locator('#brief-history-list button').click(); await page.getByText('Reading the selected saved brief…', { exact: true }).waitFor();
    await capture(page, width, percent, 'detail-loading'); assert.equal(calls.length, 2);
    pendingDetail.release(); pendingDetail = null; await loadedDetail(); await capture(page, width, percent, 'verified');
    assert.match(await page.locator('#brief-history-detail').textContent(), /Archive integrity matched/);
    assert.equal(await page.locator('#brief-history-detail details').getAttribute('open'), null);
    await page.locator('#brief-history-detail details > summary').click();
    await page.locator('#brief-history-body').evaluate(body => { body.scrollTop = body.scrollHeight; }); await capture(page, width, percent, 'complete-detail');
    assert.deepEqual(JSON.parse(await page.locator('#brief-history-detail pre').textContent()), full);
    assert.equal(await page.locator('#brief-history-dialog img, #brief-history-dialog script, #brief-history-dialog [onerror]').count(), 0); assert.equal(await page.evaluate(() => window.briefHistoryInjected), undefined);
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#brief-history-dialog').getAttribute('open'), null); assert.equal(await page.evaluate(() => document.activeElement.id), 'open-brief-history');
    assert.equal(await page.locator('#brief-history-detail').textContent(), '');
    listValue = list('retained'); detailValue = { brief: full, integrity: 'retained' }; await open(); await loadedList(); await page.locator('#brief-history-list button').click(); await loadedDetail(); await capture(page, width, percent, 'retained');
    assert.match(await page.locator('#brief-history-detail').textContent(), /Retained snapshot/); await close();
    listValue = list('legacy_archive_unverified'); detailValue = { brief: full, integrity: 'legacy_archive_unverified' }; await open(); await loadedList(); await page.locator('#brief-history-list button').click(); await loadedDetail(); await capture(page, width, percent, 'legacy');
    assert.match(await page.locator('#brief-history-detail').textContent(), /integrity unverified/);
    for (const code of [503, 404]) {
      await page.locator('#brief-history-back').click(); detailStatus = code; detailValue = { error: 'private-fixture-diagnostic' }; await page.locator('#brief-history-list button').click(); await page.locator('#brief-history-retry').waitFor(); await capture(page, width, percent, code === 503 ? 'unavailable' : 'missing');
      assert.equal(await page.locator('#brief-history-detail').textContent(), ''); assert.doesNotMatch(await page.locator('#brief-history-status').textContent(), /private-fixture/);
    }
    await page.locator('#brief-history-back').click(); detailStatus = 503; detailValue = { code: 'BRIEF_ARCHIVE_TOO_LARGE', error: 'private-fixture-oversize-diagnostic' };
    await page.locator('#brief-history-list button').click(); await page.locator('#brief-history-retry').waitFor(); await capture(page, width, percent, 'oversized');
    assert.equal(await page.locator('#brief-history-status').textContent(), 'This saved brief is too large to open safely here. It remains stored; no detail has been deleted or truncated.');
    assert.equal(await page.locator('#brief-history-detail').textContent(), ''); assert.doesNotMatch(await page.locator('#brief-history-dialog').textContent(), /private-fixture-oversize/);
    await close(); listValue = { briefs: [], limit: 30 }; await open(); await page.getByText('No saved briefs are retained for this workspace.', { exact: true }).waitFor(); await capture(page, width, percent, 'empty'); await close();
    listStatus = 503; listValue = { error: 'private-fixture-diagnostic' }; await open(); await page.locator('#brief-history-retry').waitFor(); await capture(page, width, percent, 'list-error'); await close();
    listStatus = 200; listValue = list('retained'); detailStatus = 200; detailValue = { brief: full, integrity: 'retained' };
    await open(); await loadedList(); pendingDetail = hold(); await page.locator('#brief-history-list button').click(); await page.getByText('Reading the selected saved brief…', { exact: true }).waitFor();
    await page.evaluate(() => window.RunvaraBriefHistory.reset()); pendingDetail.release(); pendingDetail = null;
    await open(); await loadedList(); await page.locator('#brief-history-list button').click(); await loadedDetail(); await capture(page, width, percent, 'reopened');
    assert.match(await page.locator('#brief-history-detail').textContent(), /Retained snapshot/); await close();
    await open(); await loadedList(); detailStatus = 401; detailValue = { code: 'AUTH_REQUIRED', error: 'Old session only' }; pendingDetail = hold();
    await page.locator('#brief-history-list button').click(); await page.getByText('Reading the selected saved brief…', { exact: true }).waitFor();
    await page.evaluate(() => document.getElementById('logout').click()); await page.locator('#login-screen:not(.hidden)').waitFor();
    assert.equal(await page.locator('#brief-history-dialog').getAttribute('open'), null); assert.equal(await page.locator('#brief-history-detail').textContent(), '');
    await page.locator('#login-email').fill('brief@example.test'); await page.locator('#login-password').fill('synthetic-only'); await page.locator('#login-form button').click();
    await page.locator('#app-shell:not(.hidden)').waitFor(); pendingDetail.release(); pendingDetail = null;
    detailStatus = 200; detailValue = { brief: { ...full, summary: 'New session saved snapshot' }, integrity: 'retained' };
    await open(); await loadedList(); await page.locator('#brief-history-list button').click(); await loadedDetail(); await capture(page, width, percent, 'session-guard');
    assert.equal(await page.locator('#login-screen').isVisible(), false); assert.match(await page.locator('#brief-history-detail').textContent(), /New session saved snapshot/); assert.doesNotMatch(await page.locator('#brief-history-status').textContent(), /Old session only|Sign in/); await close();
    assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(writes, ['POST /api/auth/logout', 'POST /api/auth/login']); assert.ok(calls.every(call => call.method === 'GET'));
    await context.close();
  }
  assert.equal(verifiedStates.length, 14 * 8, 'all states receive geometry checks across every width and text scale');
  assert.equal(captures.length - scrolledStates.length, 6 * 8, 'all 48 original initial/detail captures remain');
  assert.equal(scrollCoverage.length, 5 * 4, 'each enlarged list, integrity and error state has complete scroll evidence');
  assert.ok(scrolledStates.length >= 20 && scrolledStates.length <= 160, 'additional pixels have a fixed per-state bound');
  await fs.writeFile('/tmp/runvara-brief-history-manifest.json', JSON.stringify({ browser: { version: browser.version(), executablePath: executablePath || 'Playwright bundled Chromium' }, widths: [320, 390, 430, 1200], textScales: [100, 200], verifiedStateCount: verifiedStates.length, captureCount: captures.length, verifiedStates, scrolledStates, scrollCoverage, captures }, null, 2));
  console.log(`Saved brief browser checks passed: ${verifiedStates.length} verified states and ${captures.length} focused captures at 320, 390, 430 and 1200px, with 100% and 200% text.`);
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
