// Real responsive app, authentication and local synthetic tenants; only activity is intercepted.
// CI: cd saas/server && node tests/activity-browser-check.mjs
// Requires the repository's pinned Playwright Chromium; never contacts providers.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken, hashPassword } from '../lib/security.mjs';
import { createActivityMeter } from '../lib/activity-meter.mjs';

const workspaceId = 'packsmart-solutions';
const email = 'activity-admin@example.test';
const password = 'Synthetic-only-password!1';
const secret = 'activity-browser-fixture-only-more-than-thirty-two-characters';
const hostile = '<img src=x onerror="window.activityInjected=true">';
const epoch = Date.parse('2026-10-07T00:00:00.000Z');
const port = Number(process.env.RUNVARA_ACTIVITY_BROWSER_PORT || 18983);
assert.ok(Number.isInteger(port) && port > 1023 && port < 65536, 'fixture port must be an unprivileged TCP port');
const base = `http://127.0.0.1:${port}`;
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-activity-browser-'));
const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
  APP_PUBLIC_URL: base, PACKSMART_ADMIN_EMAIL: email, SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' });

function buildFixture() {
  let now = epoch;
  const meter = createActivityMeter({ now: () => now, instanceId: 'activity-browser-first' });
  for (let index = 0; index < 12; index++) {
    const token = meter.beginDbAttempt({ workspaceId, operation: index < 6 ? 'state_read' : 'state_commit',
      method: index < 6 ? 'GET' : 'POST', requestBodyBytes: 0, retryKind: index < 6 ? 'upsert_network' : null });
    meter.finishDbAttempt(token, { outcome: index < 6 ? 'http_error' : 'succeeded', responseBodyBytes: index < 6 ? null : 0 });
  }
  meter.observeHotState(workspaceId, { kind: 'attempted', bytes: 1024 });
  meter.observeHotState(workspaceId, { kind: 'attempted', bytes: 1_999_999 });
  meter.observeHotState(workspaceId, { kind: 'confirmed', bytes: 512 });
  meter.observeHotState(workspaceId, { kind: 'confirmed', bytes: 1024 });
  meter.observeHotState(workspaceId, { kind: 'integrity_read', bytes: 0 });
  meter.observeJob(workspaceId, 'blocked');
  meter.observeJob(workspaceId, 'succeeded');
  now += 5 * 60 * 1000;
  const snapshot = meter.snapshot(workspaceId);
  assert.equal(snapshot.db.attempted, 12);
  assert.equal(snapshot.db.requestBody.bytes, 0);
  assert.equal(snapshot.db.responseBody.unknownObservations, 6);
  assert.equal(snapshot.rateWindow.eligible, true);
  assert.deepEqual(snapshot.anomalies.map(item => item.code), ['hot_state_near_limit', 'db_failure_burst', 'db_retry_burst']);
  return snapshot;
}

const fixture = buildFixture();
const unknownFixture = createActivityMeter({ now: () => epoch, instanceId: 'activity-browser-unobserved' }).snapshot(workspaceId);
const unavailableMeter = createActivityMeter({ now: () => epoch, instanceId: 'activity-browser-unavailable', dbAvailable: false });
unavailableMeter.observeJob(workspaceId, 'blocked');
const unavailableFixture = unavailableMeter.snapshot(workspaceId);
const overflowMeter = createActivityMeter({ now: () => epoch, instanceId: 'activity-browser-overflow' });
for (const bytes of [Number.MAX_SAFE_INTEGER, 1]) {
  const token = overflowMeter.beginDbAttempt({ workspaceId, operation: 'state_commit', method: 'POST', requestBodyBytes: bytes });
  overflowMeter.finishDbAttempt(token, { outcome: 'succeeded', responseBodyBytes: 0 });
}
const overflowFixture = overflowMeter.snapshot(workspaceId);
assert.equal(overflowFixture.coverage.counterOverflow, true);
assert.equal(overflowFixture.db.requestBody.bytes, null);
const capacityMeter = createActivityMeter({ now: () => epoch, instanceId: 'activity-browser-capacity' });
for (let index = 0; index < 129; index++) capacityMeter.beginDbAttempt({ workspaceId, operation: 'state_read', method: 'GET', requestBodyBytes: 0 });
const capacityFixture = capacityMeter.snapshot(workspaceId);
assert.equal(capacityFixture.coverage.inflightReason, 'inflight_token_overflow');
assert.equal(capacityFixture.db.inflight, null);

const roleUsers = {};
let browser;

async function goTo(page, view) {
  if (await page.locator('#mobile-menu').isVisible()) await page.locator('#mobile-menu').click();
  await page.locator(`#main-nav [data-view="${view}"]`).click();
  await page.locator(`#view-${view}.active`).waitFor();
}

async function settleActivity(page, completed) {
  if (completed !== undefined) await page.waitForFunction(expected => window.activityTransportFinished?.[expected] === true, completed);
  await page.waitForFunction(() => !document.querySelector('#workspace-activity-refresh').disabled);
  // Flush the response/render microtasks without a wall-clock polling delay.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function readMetric(page, field) {
  const fields = {
    'db.attempted': ['Database activity', null, 'Requests started'],
    'db.completed': ['Database activity', null, 'Requests completed'],
    'db.failed': ['Database activity', null, 'Failed'],
    'db.inflight': ['Database activity', null, 'Still running'],
    'db.requestBody.bytes': ['Recorded data sizes', 'Request content', 'Known size total'],
    'db.responseBody.bytes': ['Recorded data sizes', 'Response content', 'Known size total'],
    'db.responseBody.knownObservations': ['Recorded data sizes', 'Response content', 'Requests with a measured size'],
    'db.responseBody.unknownObservations': ['Recorded data sizes', 'Response content', 'Requests with an unknown size'],
    'hotState.attempted.bytes': ['Workspace snapshot sizes', 'Latest save attempt', 'Recorded size'],
    'hotState.confirmed.bytes': ['Workspace snapshot sizes', 'Latest confirmed save', 'Recorded size'],
    'hotState.integrityRead.bytes': ['Workspace snapshot sizes', 'Latest saved data check', 'Recorded size'],
    'rateWindow.reason': ['Recent completion window', null, null]
  };
  assert.ok(fields[field], `known fixture field ${field}`);
  const value = await page.locator('#workspace-activity-result').evaluate((root, [heading, subheading, label]) => {
    const section = [...root.querySelectorAll(':scope > section')].find(element => element.querySelector('h3')?.textContent === heading);
    if (!section) return null;
    if (!label) return section.querySelector(':scope > p')?.textContent;
    let facts = section.querySelector('dl');
    if (subheading) facts = [...section.querySelectorAll('h4')].find(element => element.textContent === subheading)?.nextElementSibling;
    return [...facts?.querySelectorAll('dt') || []].find(element => element.textContent === label)?.nextElementSibling?.textContent ?? null;
  }, fields[field]);
  assert.notEqual(value, null, `visible metric ${field}`);
  return value.trim();
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  // Attach a rejection handler immediately; a failed fixture must not hang CI.
  const timer = setTimeout(() => reject(new Error('Synthetic activity response timed out')), 30000);
  timer.unref();
  promise.catch(() => {});
  return { promise, resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } };
}

async function openHarness(width, role = 'owner') {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const currentState = await server.packsmart.store.get(workspaceId);
  const user = currentState.users.find(item => item.id === roleUsers[role].id);
  const token = createSessionToken({ userId: user.id, workspaceId, email: user.email, role, sessionVersion: user.sessionVersion || 1 }, secret);
  await context.addCookies([{ name: 'packsmart_session', value: token, url: base, httpOnly: true, sameSite: 'Strict' }]);
  await context.addInitScript(() => {
    localStorage.setItem('packsmart-saas-cloud-migration-v3:packsmart-solutions', 'fixture-complete');
    // Deliberately allow late responses: abort alone must not be the stale-response guard.
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname !== '/api/activity') return originalFetch(input, options);
      const requestId = window.activityTransportStarts = (window.activityTransportStarts || 0) + 1;
      const config = { ...options }; delete config.signal;
      return originalFetch(input, config).then(response => {
        const originalJson = response.json.bind(response);
        response.json = async () => {
          const payload = await originalJson();
          window.activityTransportFinished ||= {};
          window.activityTransportFinished[requestId] = true;
          return payload;
        };
        return response;
      });
    };
  });
  const page = await context.newPage();
  await page.clock.install();
  const calls = [], errors = [], external = [], writes = [], fixtureErrors = [];
  let next = { status: 200, body: structuredClone(fixture) };
  let held = null;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) { external.push(url.origin); return route.abort(); }
    // Auth, CSRF validation, cookie changes and all other local routes stay real.
    if (url.pathname !== '/api/activity') return route.continue();
    const response = structuredClone(next);
    calls.push({ method: request.method(), path: url.pathname, query: url.search, body: request.postData() });
    const pending = held;
    if (pending) { held = null; pending.requestId = calls.length; pending.observed.resolve(); await pending.release.promise; }
    try {
      await route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.body) });
      pending?.fulfilled.resolve();
    } catch (error) {
      fixtureErrors.push(error.message); pending?.fulfilled.reject(error);
    }
  });
  const harness = {
    context, page, calls, errors, external, writes, fixtureErrors,
    panel: page.locator('#workspace-activity-panel'), result: page.locator('#workspace-activity-result'),
    button: page.locator('#workspace-activity-refresh'), status: page.locator('#workspace-activity-status'),
    respond(body, status = 200) { next = { status, body: structuredClone(body) }; },
    hold(body = fixture, status = 200) {
      assert.equal(held, null, 'only one unsent held response is configured');
      next = { status, body: structuredClone(body) };
      const pending = { observed: deferred(), release: deferred(), fulfilled: deferred() }; held = pending;
      return pending;
    },
    async refresh(body) {
      next = { status: 200, body: structuredClone(body) };
      const before = calls.length;
      await harness.button.click(); await settleActivity(page, before + 1);
      assert.equal(calls.length, before + 1, 'an explicit refresh performs exactly one read');
    },
    async open() {
      assert.equal(await harness.panel.getAttribute('open'), null, 'activity starts collapsed');
      const before = calls.length;
      await harness.panel.locator(':scope > summary').click(); await settleActivity(page, before + 1);
      assert.equal(calls.length, before + 1, 'explicit opening performs one read');
    },
    verify() {
      assert.deepEqual(errors, [], 'no browser exceptions');
      assert.deepEqual(fixtureErrors, [], 'every synthetic response was delivered');
      assert.deepEqual(external, [], 'no providers or external services contacted');
      assert.ok(writes.every(write => ['POST /api/auth/login', 'POST /api/auth/logout'].includes(write)), `unexpected writes: ${writes}`);
      for (const call of calls) assert.deepEqual(call, { method: 'GET', path: '/api/activity', query: '', body: null }, 'the signed-in tenant endpoint has no selector or request body');
    }
  };
  await page.goto(base); await page.locator('#app-shell:not(.hidden)').waitFor();
  await page.waitForLoadState('networkidle');
  return harness;
}

try {
  const state = seedWorkspaceState({}, { workspaceId, name: 'Synthetic activity workspace', email, passwordHash: hashPassword(password) });
  state.products = [];
  roleUsers.owner = state.users[0];
  for (const role of ['admin', 'member', 'viewer']) {
    const user = { ...state.users[0], id: `activity-user-${role}`, email: `activity-${role}@example.test`, role };
    state.users.push(user); roleUsers[role] = user;
  }
  await server.packsmart.store.save(workspaceId, state);
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  browser = await chromium.launch({ headless: true });

  for (const width of [320, 390, 1200]) {
    const h = await openHarness(width), { page, panel, result, button, calls } = h;
    assert.equal(calls.length, 0, 'startup never requests activity');
    await goTo(page, 'fleet');
    await page.locator('#fleet-provider-usage-workspace option').first().waitFor({ state: 'attached' });
    assert.equal(calls.length, 0, 'fleet never requests a tenant activity snapshot');
    await goTo(page, 'audit');
    await page.waitForLoadState('networkidle');
    assert.equal(calls.length, 0, 'audit navigation never requests activity while collapsed');
    assert.equal(await panel.getAttribute('open'), null);
    await page.clock.fastForward(2 * 60 * 1000); await page.clock.resume();
    await page.waitForLoadState('networkidle');
    assert.equal(calls.length, 0, 'a collapsed panel has no delayed automatic reads');

    const initial = h.hold();
    await panel.locator(':scope > summary').click(); await initial.observed.promise;
    await button.evaluate(element => { element.click(); element.click(); element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    assert.equal(calls.length, 1, 'opening and repeated refresh clicks coalesce while pending');
    assert.equal(await button.isDisabled(), true);
    initial.release.resolve(); await initial.fulfilled.promise; await settleActivity(page, 1);

    assert.equal(await readMetric(page, 'db.attempted'), '12');
    assert.equal(await readMetric(page, 'db.completed'), '12');
    assert.equal(await readMetric(page, 'db.failed'), '6');
    assert.equal(await readMetric(page, 'db.requestBody.bytes'), '0 bytes');
    assert.equal(await readMetric(page, 'db.responseBody.bytes'), '0 bytes');
    assert.equal(await readMetric(page, 'db.responseBody.knownObservations'), '6');
    assert.equal(await readMetric(page, 'db.responseBody.unknownObservations'), '6');
    assert.equal(await readMetric(page, 'hotState.attempted.bytes'), '1,999,999 bytes');
    assert.equal(await readMetric(page, 'hotState.confirmed.bytes'), '1,024 bytes');
    assert.equal(await readMetric(page, 'hotState.integrityRead.bytes'), '0 bytes');
    assert.match(await result.textContent(), /unknown/i, 'unknown body observations remain visible beside measured bytes');
    assert.match(await result.textContent(), /server answering this request/i);
    assert.match(await result.textContent(), /restart/i);
    assert.match(await result.textContent(), /save attempt/i);
    assert.match(await result.textContent(), /confirmed|saved/i);
    assert.match(await result.textContent(), /failure/i);
    assert.match(await result.textContent(), /retr(y|ies)/i);
    await h.refresh(fixture);
    assert.equal(await readMetric(page, 'db.attempted'), '12', 'refresh replaces the snapshot and never adds counters');

    // Fast-forward only after requests settle, so this checks the absence of polling.
    await page.waitForLoadState('networkidle');
    const beforeIdle = calls.length;
    await page.clock.fastForward(10 * 60 * 1000);
    await page.clock.resume();
    await page.waitForLoadState('networkidle');
    assert.equal(calls.length, beforeIdle, 'an open activity panel never polls');

    await h.refresh(unknownFixture);
    assert.match(await readMetric(page, 'db.attempted'), /unknown|unavailable|not observed/i);
    assert.match(await readMetric(page, 'db.requestBody.bytes'), /unknown|unavailable|not observed/i);
    assert.doesNotMatch(await readMetric(page, 'db.attempted'), /^0$/);
    assert.match(await readMetric(page, 'rateWindow.reason'), /No database activity has been observed/i);
    await h.refresh(unavailableFixture);
    assert.match(await result.textContent(), /unavailable/i);
    assert.match(await readMetric(page, 'db.attempted'), /unknown|unavailable|not observed/i);
    assert.match(await readMetric(page, 'rateWindow.reason'), /tracking is unavailable/i);

    await h.refresh(overflowFixture);
    assert.match(await result.textContent(), /Some activity was not recorded/i);
    assert.match(await result.textContent(), /recording limit|minimums/i);
    assert.equal(await readMetric(page, 'db.attempted'), 'At least 2');
    assert.match(await readMetric(page, 'db.requestBody.bytes'), /unknown|unavailable/i, 'overflowed bytes are never shown as an exact or zero value');
    assert.match(await readMetric(page, 'rateWindow.reason'), /recording limit was reached/i);

    await h.refresh(capacityFixture);
    assert.equal(await readMetric(page, 'db.attempted'), '129');
    assert.equal(await readMetric(page, 'db.inflight'), 'Unknown', 'tracking-capacity overflow must not report a misleading running count');
    assert.match(await result.textContent(), /running requests could not be tracked/i);
    assert.match(await readMetric(page, 'rateWindow.reason'), /tracking capacity|could not be tracked|tracking limit/i);

    for (const [reason, expected] of [
      ['awaiting_complete_window', /Waiting for a full five-minute window/i],
      ['incomplete_observations', /observations are missing/i],
      ['pending_completions', /requests are still running/i],
      ['insufficient_completions', /Fewer than ten requests/i],
      ['clock_unreliable', /Timing could not be confirmed/i]
    ]) {
      const snapshot = structuredClone(fixture);
      snapshot.rateWindow = { ...snapshot.rateWindow, eligible: false, reason };
      snapshot.anomalies = [];
      if (reason === 'clock_unreliable') snapshot.coverage.clockReliable = false;
      if (reason === 'incomplete_observations') { snapshot.coverage.status = 'partial'; snapshot.coverage.omittedObservations = 1; }
      if (reason === 'pending_completions') snapshot.db.inflight = 1;
      if (reason === 'insufficient_completions') Object.assign(snapshot.rateWindow, { completed: 3, failed: 0, retried: 0 });
      await h.refresh(snapshot);
      const explanation = await readMetric(page, 'rateWindow.reason');
      assert.match(explanation, expected, `${reason} gets its specific explanation`);
      assert.equal(explanation.includes(reason), false, 'rate reasons use fixed human-readable copy');
    }

    const injected = structuredClone(fixture);
    injected.observedSince = hostile; injected.snapshotAt = hostile;
    injected.coverage.counterSemantics = hostile;
    injected.coverage.excludes = [hostile]; injected.rateWindow.reason = hostile;
    injected.db.attempted = hostile; injected.db.operations[hostile] = 999;
    injected.hotState.attempted.bytes = hostile;
    injected.anomalies.push({ code: hostile, severity: hostile, kind: hostile, bytes: hostile });
    await h.refresh(injected);
    assert.equal(await result.locator('img,script,[onerror]').count(), 0);
    assert.equal(await page.evaluate(() => window.activityInjected), undefined);
    assert.match(await readMetric(page, 'db.attempted'), /unknown|unavailable/i);
    assert.equal((await result.textContent()).includes(hostile), false, 'untrusted labels and identifiers never become user-facing copy');
    await h.refresh({ ...injected, instanceId: hostile, coverage: { ...injected.coverage, status: hostile } });
    assert.equal(await result.textContent(), '', 'a malformed envelope is rejected');
    assert.match(await h.status.textContent(), /could not be checked/i);

    const restarted = structuredClone(fixture);
    restarted.instanceId = 'activity-browser-after-restart';
    restarted.instanceStartedAt = new Date(epoch + 10 * 60 * 1000).toISOString();
    restarted.observedSince = restarted.instanceStartedAt;
    restarted.snapshotAt = new Date(epoch + 15 * 60 * 1000).toISOString();
    restarted.rateWindow.startedAt = restarted.instanceStartedAt;
    restarted.rateWindow.endedAt = restarted.snapshotAt;
    for (const snapshot of Object.values(restarted.hotState)) snapshot.observedAt = restarted.instanceStartedAt;
    await h.refresh(restarted);
    assert.match(await result.textContent(), /server has changed or restarted since your last check/i);
    assert.equal(await readMetric(page, 'db.attempted'), '12');
    await panel.screenshot({ path: `/tmp/runvara-activity-${width}.png` });
    const dimensions = await panel.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { width: innerWidth, page: document.documentElement.scrollWidth, panel: element.scrollWidth, available: element.clientWidth, left: rect.left, right: rect.right };
    });
    assert.ok(dimensions.page <= width + 2 && dimensions.panel <= dimensions.available + 2, `activity overflow at ${width}px: ${JSON.stringify(dimensions)}`);
    assert.ok(dimensions.left >= -2 && dimensions.right <= width + 2, `activity escapes the ${width}px viewport`);

    // Closing invalidates pending content even when the transport ignores abort.
    const closePending = h.hold(unknownFixture);
    await button.click(); await closePending.observed.promise;
    await panel.locator(':scope > summary').click();
    const closedContent = await result.textContent(), closedStatus = await h.status.textContent();
    closePending.release.resolve(); await closePending.fulfilled.promise;
    await settleActivity(page, closePending.requestId);
    assert.equal(await panel.getAttribute('open'), null);
    assert.equal(await result.textContent(), closedContent, 'closed panel ignores late content');
    assert.equal(await h.status.textContent(), closedStatus, 'closed panel ignores late status');
    h.respond(fixture); await h.open();

    const stale401 = h.hold({ code: 'AUTH_REQUIRED', error: 'Synthetic old response' }, 401);
    await button.click(); await stale401.observed.promise;
    await goTo(page, 'overview');
    stale401.release.resolve(); await stale401.fulfilled.promise;
    await settleActivity(page, stale401.requestId);
    assert.equal(await page.locator('#app-shell').isVisible(), true, 'a 401 after navigation cannot clear the current session');
    assert.equal(await page.locator('#login-screen').isVisible(), false);
    assert.equal(await result.textContent(), '', 'navigation clears the previous tenant snapshot');
    const beforeReturn = calls.length;
    await goTo(page, 'audit');
    await page.waitForLoadState('networkidle');
    assert.equal(await panel.getAttribute('open'), null);
    assert.equal(calls.length, beforeReturn, 'returning to audit does not reload activity');
    h.respond(fixture); await h.open();

    // A same-page logout and login changes the session while an old read remains pending.
    const oldSession = h.hold({ code: 'AUTH_REQUIRED', error: 'Synthetic prior-session response' }, 401);
    await button.click(); await oldSession.observed.promise;
    const oldCookie = (await h.context.cookies(base)).find(cookie => cookie.name === 'packsmart_session');
    assert.ok(oldCookie, 'the initial authenticated cookie exists');
    const beforeLogout = await server.packsmart.store.get(workspaceId);
    const oldVersion = beforeLogout.users.find(user => user.id === roleUsers.owner.id).sessionVersion || 1;
    const loggedOut = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/logout' && response.request().method() === 'POST');
    await page.locator('#logout').click();
    assert.equal((await loggedOut).status(), 200, 'real logout passes origin and CSRF checks');
    await page.locator('#login-screen:not(.hidden)').waitFor();
    assert.equal((await h.context.cookies(base)).some(cookie => cookie.name === 'packsmart_session'), false, 'real logout clears the session cookie');
    const afterLogout = await server.packsmart.store.get(workspaceId);
    assert.equal(afterLogout.users.find(user => user.id === roleUsers.owner.id).sessionVersion, oldVersion + 1, 'real logout revokes the previous session version');
    assert.equal(await result.textContent(), '', 'logout removes the prior activity snapshot');
    await page.locator('#login-email').fill(email);
    await page.locator('#login-password').fill(password);
    const loggedIn = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST');
    await page.locator('#login-form button[type="submit"]').click();
    assert.equal((await loggedIn).status(), 200, 'real login verifies the seeded synthetic password');
    await page.locator('#app-shell:not(.hidden)').waitFor();
    const newCookie = (await h.context.cookies(base)).find(cookie => cookie.name === 'packsmart_session');
    assert.ok(newCookie, 'real login installs a new session cookie');
    assert.notEqual(newCookie.value, oldCookie.value, 'the replacement session is different');
    await goTo(page, 'audit');
    h.respond(fixture); await h.open();
    const currentContent = await result.textContent();
    oldSession.release.resolve(); await oldSession.fulfilled.promise;
    await settleActivity(page, oldSession.requestId);
    assert.equal(await page.locator('#app-shell').isVisible(), true, 'a prior-session 401 cannot sign out the new session');
    assert.equal(await page.locator('#login-screen').isVisible(), false);
    assert.equal(await result.textContent(), currentContent, 'a prior-session response cannot clear the new snapshot');
    h.verify(); await h.context.close();
  }

  for (const role of ['admin', 'member', 'viewer']) {
    const h = await openHarness(390, role);
    await goTo(h.page, 'audit');
    assert.equal(h.calls.length, 0);
    assert.equal(await h.panel.isVisible(), role === 'admin', `${role} activity visibility`);
    if (role === 'admin') await h.open();
    else {
      await h.panel.evaluate(element => { element.open = true; element.dispatchEvent(new Event('toggle')); });
      await h.button.evaluate(element => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      await h.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(h.calls.length, 0, `${role} cannot trigger a read by dispatching a hidden control`);
    }
    h.verify(); await h.context.close();
  }
  console.log('Workspace activity browser checks passed at 320, 390 and 1200 pixels with synthetic snapshots and real local authentication.');
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
