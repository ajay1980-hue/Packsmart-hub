// Local/CI Chromium, real application and quiet server, synthetic session only.
// The fixture file is prepared before startup. No provider or production access.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { createPacksmartServer } from '../server.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { closePacksmartServer } from '../lib/server-shutdown.mjs';
import { createRestrictionTypographySession } from './objective-browser-typography.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-quiet-browser-'));
const file = path.join(directory, 'synthetic-state.json');
const secret = randomBytes(32).toString('hex');
const workspace = { id: 'quiet-browser-fixture', name: 'Synthetic quiet workspace' };
const user = { id: 'quiet-owner', name: 'Synthetic owner', email: 'quiet-owner@example.test', role: 'owner', active: true, sessionVersion: 1, passwordChangeRequired: false };
const original = JSON.stringify({ [workspace.id]: { workspace, users: [user] } });
await fs.writeFile(file, original);
let browser, base, providerCalls = 0, browserExternalRequests = 0, saves = 0, complete = false, failure = null;
let browserVersion = null;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const widths = [320, 390, 430, 768, 1200], motionPreferences = ['no-preference', 'reduce'], textScales = [1, 2];
const server = createPacksmartServer({ NODE_ENV: 'test', RUNVARA_STARTUP_MODE: 'quiet',
  SESSION_SECRET: secret, CREDENTIALS_KEY: secret, SAAS_STATE_FILE: file },
{ schedulerEnabled: true, agentOpsEnabled: true, fetchImpl: async () => { providerCalls++; throw new Error('External transport forbidden'); } });
server.packsmart.store.save = async () => { saves++; throw new Error('Quiet save forbidden'); };
const failures = [], captures = [], requests = [], retries = [];
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  const token = createSessionToken({ userId: user.id, workspaceId: workspace.id, email: user.email, role: user.role, sessionVersion: 1 }, secret);
  if (executablePath) assert.ok(path.isAbsolute(executablePath), 'Local Chromium executable must use an absolute path');
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  browserVersion = browser.version();
  for (const width of widths) for (const reducedMotion of motionPreferences) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion });
    try {
      await context.addCookies([{ name: 'packsmart_session', value: token, url: base, httpOnly: true, sameSite: 'Lax' }]);
      const page = await context.newPage();
      page.on('pageerror', error => failures.push(error.message));
      await page.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== base) { browserExternalRequests++; return route.abort('blockedbyclient'); }
        requests.push({ width, reducedMotion, method: request.method(), path: url.pathname });
        return route.continue();
      });
      await page.goto(base, { waitUntil: 'networkidle' });
      const error = page.locator('#startup-error'), retry = page.locator('#startup-retry');
      await error.waitFor({ state: 'visible' });
      assert.match(await error.textContent(), /temporar|pause|quiet/i, 'Startup must explain the admission pause');
      assert.doesNotMatch(await error.textContent(), /sign.in|password|internet|saved successfully|completed successfully/i);
      assert.equal(await retry.isVisible(), true);
      assert.equal(await retry.isEnabled(), true);
      assert.equal(await page.locator('#login-screen').isVisible(), false, 'Quiet refusal does not invalidate the existing session');
      assert.equal(await page.locator('#loading-screen .skeleton-group').isVisible(), false);
      await page.evaluate(() => document.fonts.ready);
      const card = page.locator('#loading-screen .auth-card');
      const typography = await card.evaluateHandle(createRestrictionTypographySession);
      try {
        for (const scale of textScales) {
          if (scale === 2) { await typography.evaluate(session => session.begin()); await typography.evaluate(session => session.enlarge()); }
          await page.evaluate(async () => {
            await Promise.all(document.getAnimations().filter(animation => animation.playState !== 'finished' && Number.isFinite(animation.effect?.getTiming().iterations)).map(animation => animation.finished.catch(() => {})));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          });
          // Narrow enlarged text may need vertical scrolling. Verify both ends,
          // including the heading before moving down to the keyboard retry.
          await card.locator('h1').scrollIntoViewIfNeeded();
          const headingView = await card.locator('h1').evaluate(node => {
            const rect = node.getBoundingClientRect(), range = document.createRange();
            range.selectNodeContents(node);
            const words = Array.from(range.getClientRects()).filter(box => box.width && box.height);
            const hit = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
            return { top: rect.top, bottom: rect.bottom, viewportHeight: innerHeight, documentScrollTop: scrollY,
              screenScrollTop: node.closest('#loading-screen').scrollTop,
              visible: (node === hit || node.contains(hit)) && words.length > 0 && words.every(box => box.top >= -1 && box.bottom <= innerHeight + 1) };
          });
          await retry.scrollIntoViewIfNeeded();
          // Start at the preceding native focus target and reach retry with a real Tab.
          await page.locator('.skip-link').focus();
          await page.keyboard.press('Tab');
          const geometry = await card.evaluate(node => {
            const inspect = (element, includeWords = true) => {
              const rect = element.getBoundingClientRect(), words = [];
              const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
              while (includeWords && walker.nextNode()) for (const match of walker.currentNode.textContent.matchAll(/\S+/g)) {
                const range = document.createRange(); range.setStart(walker.currentNode, match.index); range.setEnd(walker.currentNode, match.index + match[0].length);
                words.push({ text: match[0], rects: Array.from(range.getClientRects()).filter(box => box.width && box.height).map(box => ({ left: box.left, right: box.right, top: box.top, bottom: box.bottom })) });
              }
              const style = getComputedStyle(element);
              return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height, client: element.clientWidth, scroll: element.scrollWidth,
                style: { width: style.width, minWidth: style.minWidth, gridTemplateColumns: style.gridTemplateColumns, overflowWrap: style.overflowWrap, fontSize: style.fontSize,
                  overflowX: style.overflowX, paddingLeft: style.paddingLeft, paddingRight: style.paddingRight }, words };
            };
            const button = node.querySelector('#startup-retry'), rect = button.getBoundingClientRect(), hit = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
            return { viewport: { width: innerWidth, height: innerHeight },
              document: { client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, scrollTop: scrollY },
              screenVertical: { client: node.parentElement.clientHeight, scroll: node.parentElement.scrollHeight, scrollTop: node.parentElement.scrollTop },
              screen: inspect(node.parentElement, false), card: inspect(node, false), heading: inspect(node.querySelector('h1')), description: inspect(node.querySelector('h1 + p')),
              error: inspect(node.querySelector('#startup-error')), retry: inspect(button), retryVisible: button === hit || button.contains(hit),
              retryKeyboardFocused: document.activeElement === button, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
              activeAnimations: node.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length };
          });
          // Record the failing case before assertions, so CI retains its pixels and bounds.
          await page.mouse.move(0, 0);
          const image = `/tmp/runvara-quiet-startup-${width}-${scale * 100}${reducedMotion === 'reduce' ? '-reduced' : ''}.png`;
          await page.screenshot({ path: image, fullPage: true, animations: 'disabled' });
          const bytes = await fs.readFile(image);
          captures.push({ width, textScale: scale, reducedMotion, file: image, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), headingView, geometry });
          for (const value of [geometry.error, geometry.retry]) {
            assert.ok(value.left >= -1 && value.right <= width + 1 && value.scroll <= value.client + 1, 'Pause feedback must fit horizontally');
            for (const word of value.words) assert.ok(word.rects.length && word.rects.every(rect => rect.left >= value.left - 1 && rect.right <= value.right + 1), `Clipped feedback word: ${word.text}`);
          }
          for (const [name, value] of Object.entries({ screen: geometry.screen, card: geometry.card, heading: geometry.heading, description: geometry.description })) {
            assert.ok(value.left >= -1 && value.right <= width + 1 && value.scroll <= value.client + 1, `Startup ${name} must fit horizontally`);
            for (const word of value.words) assert.ok(word.rects.length && word.rects.every(rect => rect.left >= value.left - 1 && rect.right <= value.right + 1), `Clipped ${name} word: ${word.text}`);
          }
          assert.ok(geometry.document.scroll <= geometry.document.client + 1, 'Startup document must not scroll horizontally');
          assert.ok(headingView.visible && headingView.top >= 0 && headingView.bottom <= headingView.viewportHeight, 'Startup heading must remain reachable by vertical scrolling');
          assert.ok(geometry.retryVisible && geometry.retry.top >= 0 && geometry.retry.bottom <= geometry.viewport.height && geometry.retry.height >= 44, 'Manual retry must remain reachable');
          assert.equal(geometry.retryKeyboardFocused, true, 'Tab must reach the manual retry');
          assert.equal(geometry.reducedMotion, reducedMotion === 'reduce', 'Requested motion preference must be active');
          if (reducedMotion === 'reduce') assert.equal(geometry.activeAnimations, 0, 'Reduced-motion startup must not animate');
          if (scale === 2) await typography.evaluate(session => session.restore());
        }
      } finally { await typography.dispose(); }
      for (const activation of ['keyboard', 'pointer']) {
        const identityReads = () => requests.filter(row => row.width === width && row.reducedMotion === reducedMotion && row.method === 'GET' && row.path === '/api/auth/session').length;
        const businessAttempts = () => requests.filter(row => row.width === width && row.reducedMotion === reducedMotion && ['/api/bootstrap', '/api/migrate-pilot'].includes(row.path)).length;
        const before = identityReads();
        if (activation === 'keyboard') {
          await page.locator('.skip-link').focus(); await page.keyboard.press('Tab');
          assert.equal(await page.evaluate(() => document.activeElement.id), 'startup-retry');
        }
        await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), activation === 'keyboard' ? page.keyboard.press('Enter') : retry.click()]);
        await error.waitFor({ state: 'visible' });
        assert.equal(identityReads(), before + 1, `${activation} check makes one identity read`);
        assert.equal(businessAttempts(), 0, `${activation} check never attempts bootstrap or import`);
        assert.equal(await page.locator('#loading-screen h1').textContent(), 'Signed in. Maintenance continues.');
        assert.equal(await page.locator('#login-screen').isVisible(), false);
        assert.equal(await retry.isEnabled(), true);
        retries.push({ width, reducedMotion, activation, identityReads: identityReads() - before, businessAttempts: businessAttempts() });
      }
    } finally { await context.close(); }
  }
  assert.equal(providerCalls, 0); assert.equal(browserExternalRequests, 0); assert.equal(saves, 0); assert.deepEqual(failures, []);
  assert.equal(await fs.readFile(file, 'utf8'), original, 'Browser checks retain fixture bytes');
  assert.ok(requests.every(row => ['GET', 'HEAD'].includes(row.method)), 'Startup and manual reload do not submit mutations');
  assert.equal(captures.length, widths.length * motionPreferences.length * textScales.length);
  assert.equal(retries.length, widths.length * motionPreferences.length * 2);
  assert.ok(captures.reduce((sum, image) => sum + image.bytes, 0) < 24 * 1024 * 1024, 'Responsive archive must remain within supported materialization bounds');
  complete = true;
} catch (error) {
  failure = String(error.code || error.message || 'BROWSER_QUALIFICATION_FAILED');
  throw error;
} finally {
  const [browserClose, serverClose] = await Promise.allSettled([
    Promise.resolve().then(() => browser?.close()),
    Promise.resolve().then(() => closePacksmartServer(server))
  ]);
  let fixtureRemoved = false;
  try { await fs.rm(directory, { recursive: true, force: true }); fixtureRemoved = true; } catch {}
  const cleanup = { browserClosed: browserClose.status === 'fulfilled',
    server: serverClose.status === 'fulfilled' ? serverClose.value : { settled: false, code: 'SERVER_CLOSE_FAILED' }, fixtureRemoved };
  const cleaned = cleanup.browserClosed && cleanup.server.settled === true && fixtureRemoved;
  complete &&= cleaned;
  await fs.writeFile('/tmp/runvara-quiet-startup-manifest.json', JSON.stringify({ complete, failure,
    browser: { version: browserVersion, executablePath: executablePath || 'Playwright bundled Chromium' },
    matrix: { widths, motionPreferences, textScales }, captures, retries, requests, providerCalls, browserExternalRequests, saves, pageErrors: failures, cleanup,
    limits: ['Synthetic file persistence and session only', '200% affected card text, not browser zoom or whole-app accessibility', 'No production access, provider response or deployment termination evidence'] }, null, 2));
  assert.equal(cleaned, true, 'Every quiet fixture cleanup must complete');
}
console.log('Quiet startup browser qualification: twenty normal/enlarged and reduced-motion captures, keyboard/pointer retries, zero provider calls/saves and verified local cleanup.');
