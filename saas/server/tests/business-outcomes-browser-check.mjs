// Real responsive app + an isolated synthetic tenant. Outcome transport is
// intercepted; these checks never publish to a database or contact providers.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken, hashPassword } from '../lib/security.mjs';
import { prepareExperimentOutcomeMeasurement, assessExperimentOutcomeMeasurement } from '../lib/experiment-measurements.mjs';
import { createBusinessOutcomeCandidate, createOutcomePublicationBoundary, aggregateBusinessOutcomes } from '../lib/business-outcomes.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-outcomes-browser-'));
const secret = 'business-outcomes-browser-fixture-more-than-thirty-two-characters';
const password = 'Outcome-fixture-only-49!';
const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
  SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' });
const hostile = '<img src=x onerror="window.outcomeInjected=true">';
const experiment = { id: 'experiment_browser_outcome', title: 'Synthetic contribution experiment ' + 'long recorded title '.repeat(8), status: 'measured' };
const tripleClick = locator => locator.evaluate(element => { element.click(); element.click(); element.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(predicate, description) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(description);
}
async function navigate(page, view) {
  if (await page.locator('#mobile-menu').isVisible() && await page.locator('#mobile-menu').getAttribute('aria-expanded') !== 'true') await page.locator('#mobile-menu').click();
  await page.locator(`#main-nav [data-view="${view}"]`).click();
  await page.locator(`#view-${view}.active`).waitFor();
}
async function assertNoOverflow(page, width, label) {
  const dimensions = await page.evaluate(() => {
    const panel = document.querySelector('#business-outcomes-panel'), rect = panel.getBoundingClientRect();
    return { width: innerWidth, page: document.documentElement.scrollWidth, panel: panel.scrollWidth,
      available: panel.clientWidth, left: rect.left, right: rect.right };
  });
  assert.ok(dimensions.page <= width + 2 && dimensions.panel <= dimensions.available + 2,
    `${label} overflows at ${width}px: ${JSON.stringify(dimensions)}`);
  assert.ok(dimensions.left >= -2 && dimensions.right <= width + 2,
    `${label} escapes the ${width}px viewport: ${JSON.stringify(dimensions)}`);
}
let browser;
try {
  const state = seedWorkspaceState({}, { workspaceId: 'outcomes-browser', userId: 'user_outcomes_owner',
    name: 'Synthetic business outcome checks', email: 'outcomes@example.test', passwordHash: hashPassword(password) });
  state.products = [];
  state.revenueEngine.experiments = [experiment];
  await server.packsmart.store.save(state.workspace.id, state);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  for (const width of [320, 390, 1200]) {
    const currentState = await server.packsmart.store.get(state.workspace.id);
    const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id,
      email: state.users[0].email, role: 'owner', sessionVersion: currentState.users[0].sessionVersion }, secret);
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addCookies([{ name: 'packsmart_session', value: token, url: base, httpOnly: true, sameSite: 'Strict' }]);
    // One selected request can ignore AbortSignal so a late response exercises
    // generation/session guards even if navigation also cancels its transport.
    await context.addInitScript(() => {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, options) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (window.__holdOutcomePastCancellation && url.pathname === '/api/business-outcomes') {
          window.__holdOutcomePastCancellation = false;
          const config = { ...options }; delete config.signal;
          return nativeFetch(input, config);
        }
        return nativeFetch(input, options);
      };
    });
    const page = await context.newPage(), errors = [], calls = [], writes = [], external = [];
    let measurement = null, publication = null, workspaceRevision = 'browser_workspace_revision_1', holdNext = null;
    const now = new Date().toISOString();
    const detailPayload = () => ({ workspaceId: state.workspace.id, workspaceRevision, experiment,
      measurement, assessment: measurement ? assessExperimentOutcomeMeasurement(measurement,
        { workspaceId: state.workspace.id, experimentId: experiment.id, now }) : null, currentPublication: publication });
    const summaryPayload = () => {
      const current = publication ? [publication] : [];
      const publicationBoundary = createOutcomePublicationBoundary({ workspaceId: state.workspace.id,
        snapshotId: workspaceRevision, complete: true, expectedOutcomeCount: current.length,
        resolveCommittedPublication: ({ outcomeId }) => current.find(row => row.head.outcomeId === outcomeId) || null });
      return { workspaceId: state.workspace.id, current,
        summary: aggregateBusinessOutcomes(current.map(row => row.version), { workspaceId: state.workspace.id, now, publicationBoundary }) };
    };
    const holdRequest = (method, pathname, status = 200) => {
      assert.equal(holdNext, null, 'only one deliberately delayed request at a time');
      const gate = { method, pathname, status, seen: false, release: null, done: false };
      holdNext = gate;
      return gate;
    };
    async function releaseRequest(gate) {
      await waitUntil(() => gate.seen, 'the delayed request must reach the route');
      gate.release();
      await waitUntil(() => gate.done, 'the delayed response must be delivered');
      // Let the response, promise continuations and rendering run before checks.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() !== 'GET') writes.push(request.method() + ' ' + new URL(request.url()).pathname); });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (url.origin !== base) { external.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/business-outcomes')) return route.continue();
      calls.push({ path: url.pathname, method, body: request.postData() ? request.postDataJSON() : null });
      let gate = null;
      if (holdNext?.method === method && holdNext.pathname === url.pathname) {
        gate = holdNext; holdNext = null; gate.seen = true;
        await new Promise(resolve => { gate.release = resolve; });
      }
      let response;
      if (gate && gate.status !== 200) response = { status: gate.status, json: { error: 'Synthetic expired request', code: 'AUTH_REQUIRED' } };
      else if (method === 'GET' && url.pathname === '/api/business-outcomes') response = { json: summaryPayload() };
      else if (method === 'GET' && url.pathname === `/api/business-outcomes/experiments/${experiment.id}`) response = { json: detailPayload() };
      else if (method === 'PUT' && url.pathname === `/api/business-outcomes/experiments/${experiment.id}/measurement`) {
        const input = request.postDataJSON();
        measurement = prepareExperimentOutcomeMeasurement(input, { workspaceId: state.workspace.id,
          experimentId: experiment.id, actorId: state.users[0].id, now, previousMeasurement: measurement });
        workspaceRevision = 'browser_workspace_revision_2';
        response = { json: detailPayload() };
      } else if (method === 'POST' && url.pathname === '/api/business-outcomes/publish') {
        const input = request.postDataJSON();
        assert.deepEqual(Object.keys(input).sort(), ['publicationId', 'action', 'experimentId', 'expectedWorkspaceRevision', 'expectedMeasurementRevision', 'expectedMeasurementDigest', 'expectedHeadVersionId', 'expectedHeadDigest', 'withdrawalReason'].sort(), 'publication uses only the reviewed conflict-safe input fields');
        assert.equal(input.action, 'publish');
        assert.equal(input.experimentId, experiment.id);
        assert.equal(input.expectedMeasurementRevision, measurement.revision);
        assert.equal(input.expectedMeasurementDigest, measurement.digest);
        assert.equal(input.expectedWorkspaceRevision, workspaceRevision);
        assert.equal(input.expectedHeadVersionId, null); assert.equal(input.expectedHeadDigest, null);
        assert.equal(input.withdrawalReason, null); assert.match(input.publicationId, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
        const version = createBusinessOutcomeCandidate({ source: { type: 'experiment_measurement', experimentId: experiment.id,
          measurementRevision: measurement.revision, measurementDigest: measurement.digest }, metric: measurement.metric,
          amount: measurement.amount, currency: measurement.currency, window: measurement.window, coverage: measurement.coverage,
          method: measurement.method, provenance: measurement.provenance, links: measurement.links,
          verification: { kind: 'owner_attestation', actorId: state.users[0].id, verifiedAt: now, measurementDigest: measurement.digest } },
        { workspaceId: state.workspace.id, now });
        workspaceRevision = 'browser_workspace_revision_3';
        publication = { head: { schema: 'runvara-outcome-head/v1', workspaceId: state.workspace.id,
          outcomeId: version.outcomeId, revision: version.revision, versionId: version.versionId, digest: version.digest,
          status: 'published', publicationId: input.publicationId, committedAt: now, commitRevision: workspaceRevision }, version };
        response = { json: { workspaceId: state.workspace.id, publication, replayed: false, isCurrent: true } };
      } else if (method === 'GET' && publication && url.pathname === `/api/business-outcomes/versions/${publication.version.versionId}`) {
        response = { json: { workspaceId: state.workspace.id, publication, sourceMeasurement: measurement,
          currentStatus: 'not_checked', source: 'immutable_business_outcome_version' } };
      } else assert.fail(`Unexpected outcome request: ${method} ${url.pathname}`);
      await route.fulfill(response);
      if (gate) gate.done = true;
    });

    const panel = page.locator('#business-outcomes-panel'), status = page.locator('#business-outcomes-status');
    const summary = page.locator('#business-outcomes-summary'), detail = page.locator('#business-outcomes-detail');
    const select = page.locator('#business-outcomes-experiment'), load = page.locator('#business-outcomes-load');
    const refresh = page.locator('#business-outcomes-refresh'), form = page.locator('#business-outcomes-form');
    const review = page.locator('#business-outcomes-review');
    const callCount = (method, pathname) => calls.filter(call => call.method === method && (!pathname || call.path === pathname)).length;
    const open = async () => {
      if (await panel.getAttribute('open') === null) await panel.locator(':scope > summary').click();
    };
    const loadExperiment = async () => {
      await select.selectOption(experiment.id); await load.click();
      await form.waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('#business-outcomes-load').disabled);
    };

    await page.goto(base); await page.locator('#app-shell:not(.hidden)').waitFor();
    assert.equal(calls.length, 0, 'startup never reads or publishes business outcomes');
    await navigate(page, 'revenue-engine');
    assert.equal(await panel.getAttribute('open'), null);
    assert.equal(calls.length, 0, 'navigation leaves collapsed outcomes read-free');
    const initialRead = holdRequest('GET', '/api/business-outcomes');
    await open(); await waitUntil(() => initialRead.seen, 'opening the panel requests its committed selection');
    await tripleClick(refresh);
    assert.equal(callCount('GET', '/api/business-outcomes'), 1, 'repeated refresh clicks coalesce with the opening read');
    assert.equal(await refresh.isDisabled(), true);
    await releaseRequest(initialRead);
    await summary.getByText('No published business results yet.', { exact: false }).waitFor();
    const openedCalls = calls.length;
    await panel.locator(':scope > summary').click(); await open();
    assert.equal(calls.length, openedCalls, 'a cached selection is reused on reopening without polling');

    await select.selectOption(experiment.id);
    assert.equal(calls.length, openedCalls, 'choosing an experiment does not read or prepare it');
    const detailPath = `/api/business-outcomes/experiments/${experiment.id}`;
    const detailRead = holdRequest('GET', detailPath);
    await tripleClick(load); await waitUntil(() => detailRead.seen, 'explicit detail request must be observed');
    assert.equal(callCount('GET', detailPath), 1, 'repeated experiment load clicks coalesce');
    assert.equal(await load.isDisabled(), true);
    await releaseRequest(detailRead); await form.waitFor({ state: 'visible' });
    assert.match(await detail.textContent(), /No typed measurement saved/);
    assert.equal(await form.locator('[name="amount"]').inputValue(), '', 'unknown amount is blank, never an inferred zero');
    assert.equal(await form.locator('[name="currency"]').inputValue(), '', 'measurement currency is not inferred from workspace defaults');
    assert.equal(callCount('PUT'), 0); assert.equal(callCount('POST'), 0);

    const input = { expectedRevision: 0, amount: '-12.004000', currency: 'GBP',
      window: { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-04T00:00:00.000Z' },
      coverage: { status: 'complete', observedCount: 12, expectedCount: 12 }, method: { kind: 'reconciled_manual' },
      observedAt: '2026-10-05T12:00:00.000Z', report: { description: 'Synthetic retained evidence. ' + hostile + ' ' + 'long-recorded-source-detail'.repeat(12), costsComplete: true } };
    for (const [name, value] of Object.entries({ amount: input.amount, currency: input.currency,
      startsAt: input.window.startsAt.slice(0, -1), endsAt: input.window.endsAt.slice(0, -1),
      observedAt: input.observedAt.slice(0, -1), observedCount: '12', expectedCount: '12', description: input.report.description }))
      await form.locator(`[name="${name}"]`).fill(value);
    for (const [name, value] of Object.entries({ coverageStatus: 'complete', method: 'reconciled_manual', costsComplete: 'true' }))
      await form.locator(`[name="${name}"]`).selectOption(value);
    const savePath = `${detailPath}/measurement`, draftSave = holdRequest('PUT', savePath);
    await form.evaluate(element => {
      element.requestSubmit();
      element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await waitUntil(() => draftSave.seen, 'explicit save requests a typed measurement');
    assert.equal(callCount('PUT', savePath), 1, 'repeated draft submits coalesce');
    assert.deepEqual(calls.find(call => call.method === 'PUT').body, input);
    assert.equal(callCount('POST'), 0, 'draft preparation never publishes');
    await releaseRequest(draftSave); await status.getByText('Draft saved.', { exact: false }).waitFor();
    assert.match(await detail.textContent(), /-12\.004 GBP/);
    assert.match(await detail.textContent(), /Ready for explicit owner review/);
    assert.equal(await detail.locator('img,script,[onerror]').count(), 0);
    assert.equal(await page.evaluate(() => window.outcomeInjected), undefined);

    const publicationReview = detail.locator('[data-outcome-action="publish"]');
    await publicationReview.click(); await review.waitFor({ state: 'visible' });
    assert.match(await review.textContent(), /-12\.004 GBP/);
    assert.match(await review.textContent(), /Measurement revision 1/);
    assert.match(await review.textContent(), /does not prove Runvara caused the result/);
    assert.equal(await page.locator('#business-outcomes-confirm').isDisabled(), true);
    await page.locator('#business-outcomes-confirm').evaluate(element => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.equal(callCount('POST'), 0, 'an unchecked review cannot publish, including a synthetic click');
    await page.locator('#business-outcomes-cancel').click();
    await review.waitFor({ state: 'hidden' });
    assert.equal(callCount('POST'), 0, 'cancelled review sends no publication request');

    await publicationReview.click(); await page.locator('#business-outcomes-attest').check();
    assert.equal(callCount('POST'), 0, 'attestation alone does not publish');
    await assertNoOverflow(page, width, 'reviewed measurement');
    const publicationWrite = holdRequest('POST', '/api/business-outcomes/publish');
    await tripleClick(page.locator('#business-outcomes-confirm'));
    await waitUntil(() => publicationWrite.seen, 'confirmed publication reaches the transport');
    assert.equal(callCount('POST'), 1, 'repeated confirm clicks submit one reviewed publication');
    assert.equal(await page.locator('#business-outcomes-confirm').isDisabled(), true);
    await releaseRequest(publicationWrite);
    await status.getByText('Reviewed action recorded.', { exact: false }).waitFor();
    await review.waitFor({ state: 'hidden' });
    await refresh.click(); await summary.getByText('Owner-verified measurement', { exact: false }).waitFor();
    assert.match(await summary.textContent(), /-12\.004 GBP/);
    assert.match(await summary.textContent(), /not independently verified/);
    assert.match(await summary.textContent(), /Attribution to RunvaraUnestablished/);
    assert.doesNotMatch(await summary.textContent(), /Synthetic retained evidence/);
    const sourcePath = `/api/business-outcomes/versions/${publication.version.versionId}`;
    assert.equal(callCount('GET', sourcePath), 0, 'loading a committed selection does not eagerly hydrate retained evidence');
    const evidenceRead = holdRequest('GET', sourcePath), evidence = summary.locator('[data-outcome-evidence]');
    await tripleClick(evidence); await waitUntil(() => evidenceRead.seen, 'explicit retained evidence request must be observed');
    assert.equal(callCount('GET', sourcePath), 1, 'repeated evidence clicks coalesce');
    await releaseRequest(evidenceRead);
    await summary.getByText('Retained immutable source', { exact: true }).waitFor();
    assert.match(await summary.textContent(), /Historical evidence; current status has not been rechecked/);
    assert.match(await summary.textContent(), /Synthetic retained evidence/);
    assert.equal(await summary.locator('img,script,[onerror]').count(), 0);
    assert.equal(await page.evaluate(() => window.outcomeInjected), undefined);
    await tripleClick(evidence);
    assert.equal(callCount('GET', sourcePath), 1, 'successfully loaded evidence is reused');
    await assertNoOverflow(page, width, 'committed result and retained evidence');
    await panel.screenshot({ path: `/tmp/runvara-business-outcomes-${width}.png` });

    // A late 401 belongs to its abandoned navigation, not the freshly loaded UI.
    await page.evaluate(() => { window.__holdOutcomePastCancellation = true; });
    const navigation401 = holdRequest('GET', '/api/business-outcomes', 401);
    await refresh.click(); await waitUntil(() => navigation401.seen, 'navigation race request must be in flight');
    await navigate(page, 'overview'); await navigate(page, 'revenue-engine'); await open();
    await refresh.click(); await status.getByText('Loaded on request.', { exact: false }).waitFor();
    await loadExperiment();
    const freshDetail = await detail.textContent(), freshSummary = await summary.textContent();
    await releaseRequest(navigation401);
    assert.equal(await page.locator('#app-shell').isVisible(), true, 'a stale navigation 401 cannot sign out the current session');
    assert.equal(await page.locator('#login-screen').isVisible(), false);
    assert.equal(await detail.textContent(), freshDetail, 'stale navigation results cannot clear the new detail');
    assert.equal(await summary.textContent(), freshSummary, 'stale navigation results cannot clear the new summary');

    // Exercise an actual session replacement, rather than merely changing a
    // JavaScript fixture identity: real logout revokes the old session version.
    await page.evaluate(() => { window.__holdOutcomePastCancellation = true; });
    const session401 = holdRequest('GET', '/api/business-outcomes', 401);
    await refresh.click(); await waitUntil(() => session401.seen, 'session race request must be in flight');
    await navigate(page, 'audit'); await page.locator('#logout').click();
    await page.locator('#login-screen:not(.hidden)').waitFor();
    await page.locator('#login-form [name="email"]').fill(state.users[0].email);
    await page.locator('#login-form [name="password"]').fill(password);
    await page.locator('#login-form button[type="submit"]').click();
    await page.locator('#app-shell:not(.hidden)').waitFor();
    await navigate(page, 'revenue-engine'); await open();
    await status.getByText('Loaded on request.', { exact: false }).waitFor();
    await loadExperiment();
    const newSessionDetail = await detail.textContent(), newSessionSummary = await summary.textContent();
    await releaseRequest(session401);
    assert.equal(await page.locator('#app-shell').isVisible(), true, 'an old-session 401 cannot clear the replacement session');
    assert.equal(await page.locator('#login-screen').isVisible(), false);
    assert.equal(await detail.textContent(), newSessionDetail, 'old-session completion cannot change replacement detail');
    assert.equal(await summary.textContent(), newSessionSummary, 'old-session completion cannot change replacement summary');
    assert.equal(callCount('POST'), 1, 'navigation and reauthentication never replay publication');
    assert.equal(callCount('PUT'), 1, 'navigation and reauthentication never replay draft preparation');
    assert.deepEqual(errors, [], 'browser must remain free of unhandled errors');
    assert.deepEqual(external, [], 'synthetic checks never contact external providers');
    assert.deepEqual(writes.filter(write => !write.endsWith('/api/auth/logout') && !write.endsWith('/api/auth/login')),
      [`PUT ${savePath}`, 'POST /api/business-outcomes/publish'], 'outcomes never execute commercial/provider actions');
    await context.close();
  }
  console.log('Business outcome browser checks passed at 320, 390 and 1200 pixels using synthetic measurements and publications.');
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
