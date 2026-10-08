// Real responsive app with a local synthetic tenant; review jobs are intercepted.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { upsertBusinessObjective, OBJECTIVE_EXECUTION_POLICY_SCHEMA } from '../lib/business-objectives.mjs';
import { buildObjectiveReview } from '../lib/objective-review.mjs';
import { detectOpportunities } from '../lib/control.mjs';
import { createRestrictionTypographySession } from './objective-browser-typography.mjs';

async function captureRestriction(page, width, name, typography) {
  const panel = page.locator('#business-objective-restriction');
  const assertFits = async label => {
    const dimensions = await panel.evaluate(element => ({ page: document.documentElement.scrollWidth,
      panel: element.scrollWidth, available: element.clientWidth }));
    assert.ok(dimensions.page <= width + 2 && dimensions.panel <= dimensions.available + 2,
      `restriction ${label} overflow at ${width}px: ${JSON.stringify(dimensions)}`);
  };
  await typography.evaluate(session => session.assertBaseline());
  await assertFits(name);
  await panel.screenshot({ path: `/tmp/runvara-business-objectives-${name}-${width}.png` });
  await typography.evaluate(session => session.begin());
  try {
    await typography.evaluate(session => session.enlarge());
    await assertFits(`${name} at 200% text`);
    await panel.screenshot({ path: `/tmp/runvara-business-objectives-${name}-${width}-large-text.png` });
  } finally {
    await typography.evaluate(session => session.restore());
  }
  await typography.evaluate(session => session.assertBaseline());
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-objective-review-browser-'));
const secret = 'objective-review-browser-test-only-more-than-thirty-two-characters';
// The real browser sends Origin on PUT. Configure the same dedicated loopback
// origin before server creation, when the server captures its CSRF allowlist.
const port = 18876, base = `http://127.0.0.1:${port}`;
const fixtureEnv = { NODE_ENV: 'test', APP_PUBLIC_URL: base, SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
  SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' };
const server = createPacksmartServer(fixtureEnv);
let browser;
try {
  const now = new Date().toISOString();
  const state = seedWorkspaceState({}, { workspaceId: 'review-browser', name: 'Synthetic objective review', email: 'review@example.test', passwordHash: 'fixture-only' });
  state.settings = { ...state.settings, currency: 'GBP', growthCapacityHours: 4, maxConcurrentGrowthExperiments: 2 };
  state.connections = [
    { id: 'restriction-browser-a', provider: 'shopify', status: 'disconnected', label: 'Synthetic saved account <img src=x onerror="window.restrictionInjected=true">',
      metadata: { shopDomain: 'restriction-browser-a.myshopify.com' } },
    { id: 'restriction-browser-b', provider: 'shopify', status: 'disconnected', label: 'Synthetic separate saved account with a deliberately long descriptive label',
      metadata: { shopDomain: 'restriction-browser-b.myshopify.com' } }
  ];
  state.products = [{ id: 'product_review_fixture', provider: 'shopify', title: 'Synthetic packaging product', status: 'active', variants: [{ id: 'variant_review_fixture', sku: 'REVIEW-FIXTURE', price: 10, inventory: 1, available: true }] }];
  state.approvals = []; state.decisions = []; state.exceptions = []; state.opportunities = [];
  detectOpportunities(state);
  for (const opportunity of state.opportunities) { opportunity.executionCost = 0; opportunity.effortHours = 1; }
  const objective = upsertBusinessObjective(state, { title: 'Review recorded contribution', metric: 'contribution_profit', baseline: null, target: 100, direction: 'increase',
    startsAt: new Date(Date.now() - 86400000).toISOString(), endsAt: new Date(Date.now() + 86400000).toISOString(),
    limits: { currency: 'GBP', minGrossMarginPercent: 10, minStockCoverDays: 5, maxMonthlyAdBudget: 0, profitFirst: true } }, { workspaceId: state.workspace.id, now });
  const report = buildObjectiveReview(state, { objectiveId: objective.id, objectiveRevision: objective.revision, jobId: 'job_browser_review' }, { workspaceId: state.workspace.id, now });
  assert.ok(report.proposals.length > 0, 'synthetic product produces a reviewable canonical opportunity');
  const originalOpportunityId = report.proposals[0].opportunityId;
  const hostile = '<img src=x onerror="window.reviewInjected=true">';
  report.evidenceGaps.push({ message: hostile });
  report.proposals[0].title = 'BoundedLongRecordedOpportunity' + 's'.repeat(130);
  await server.packsmart.store.save(state.workspace.id, state);
  const originalState = structuredClone(state);
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  assert.equal(new URL(fixtureEnv.APP_PUBLIC_URL).origin, `http://${server.address().address}:${server.address().port}`,
    'the configured CSRF origin must match the actual local browser server');
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  browser = await chromium.launch({ headless: true });
  for (const width of [320,390,1200]) {
    // Policy saves below are real local API writes. Each viewport starts with
    // the same isolated fixture revision, so the diagnostic binding stays exact.
    const resetState = structuredClone(originalState);
    resetState._revision = (await server.packsmart.store.get(state.workspace.id))._revision;
    await server.packsmart.store.save(state.workspace.id, resetState);
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addCookies([{ name: 'packsmart_session', value: token, url: base, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage(), errors = [], calls = [], external = [], apiCalls = [], unexpected = [];
    page.on('pageerror', error => errors.push(error.message));
    let statusReads = 0;
    const job = { id: 'job_browser_review', type: 'objective_prepare', status: 'queued', objectiveId: objective.id, objectiveRevision: objective.revision,
      attempts: 0, maxAttempts: 3, createdAt: now, updatedAt: now, completedAt: null, errorCode: null, reportAvailable: false };
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { external.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      apiCalls.push({ path: url.pathname + url.search, method: route.request().method(), body: route.request().postData() });
      if (!url.pathname.startsWith('/api/business-objectives/reviews')) {
        const permitted = route.request().method() === 'GET'
          ? ['/api/auth/session', '/api/bootstrap', '/api/business-objectives', '/api/connections'].includes(url.pathname)
          : route.request().method() === 'PUT' && url.pathname === '/api/business-objectives';
        if (!permitted) { unexpected.push(apiCalls.at(-1)); return route.abort(); }
        if (route.request().method() === 'PUT') assert.equal(await route.request().headerValue('origin'), base,
          'real browser writes must carry their unchanged same-origin header');
        return route.continue();
      }
      calls.push({ path: url.pathname + url.search, method: route.request().method(), body: route.request().postData(), at: Date.now() });
      if (route.request().method() === 'POST') {
        assert.deepEqual(route.request().postDataJSON(), { objectiveId: objective.id, objectiveRevision: objective.revision });
        return route.fulfill({ json: { job, stale: false, staleReason: null } });
      }
      if (url.searchParams.get('report') === 'true') return route.fulfill({ json: { job, stale: true, staleReason: 'SOURCE_INPUTS_CHANGED', report } });
      statusReads++;
      if (statusReads >= 2) Object.assign(job, { status: 'succeeded', reportAvailable: true, attempts: 1, completedAt: now });
      return route.fulfill({ json: { job, stale: false, staleReason: null } });
    });
    await page.goto(base); await page.locator('#app-shell:not(.hidden)').waitFor();
    assert.equal(calls.length, 0, 'startup never prepares or polls reviews');
    assert.equal(apiCalls.filter(call => ['/api/business-objectives', '/api/connections'].includes(call.path)).length, 0,
      'startup does not fetch objective or account references separately');
    if (await page.locator('#mobile-menu').isVisible()) await page.locator('#mobile-menu').click();
    await page.locator('#main-nav [data-view="ai-team"]').click();
    const details = page.locator('.business-objectives-panel'); await details.locator(':scope > summary').click();
    await page.locator('#load-business-objectives').click();
    const prepare = page.locator('[data-prepare-objective-review]'); await prepare.waitFor();
    assert.equal(calls.length, 0, 'loading definitions does not prepare a diagnostic');
    await prepare.evaluate(button => { button.click(); button.click(); button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await page.locator('#business-objective-review-status').getByText('Diagnostic completed.', { exact: false }).waitFor();
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(statusReads, 2); assert.equal(calls.filter(call => call.path.includes('?report=true')).length, 1);
    const statuses = calls.filter(call => call.method === 'GET' && !call.path.includes('?report=true'));
    assert.ok(statuses[0].at - calls[0].at >= 1900, 'first automatic status check waits two seconds');
    assert.ok(statuses[1].at - statuses[0].at >= 3900, 'second automatic status check backs off to four seconds');
    const result = page.locator('#business-objective-review-result');
    assert.match(await result.textContent(), /Commercial proposalsBlocked/);
    assert.match(await result.textContent(), /Historical review:/);
    assert.match(await result.textContent(), /Financial source as-ofUnknown/);
    assert.equal(await result.locator('img,script,[onerror],[data-opportunity],[data-approval]').count(), 0);
    assert.equal(await page.evaluate(() => window.reviewInjected), undefined);
    await page.locator('#business-objective-review').screenshot({ path: `/tmp/runvara-objective-review-${width}.png` });
    const dimensions = await page.evaluate(() => {
      const panel = document.querySelector('#business-objective-review');
      return { width: innerWidth, page: document.documentElement.scrollWidth, panel: panel.scrollWidth, available: panel.clientWidth };
    });
    assert.ok(dimensions.page <= width + 2 && dimensions.panel <= dimensions.available + 2, `review overflow at ${width}px: ${JSON.stringify(dimensions)}`);
    const before = calls.length; await details.locator(':scope > summary').click(); await details.locator(':scope > summary').click();
    assert.equal(calls.length, before, 'reopening the completed report does not request it again');
    await result.locator('[data-investigate-review-opportunity="' + originalOpportunityId + '"]').click();
    await page.locator('#view-opportunities.active').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-opportunity-record')), originalOpportunityId);
    assert.equal(calls.length, before, 'investigation only navigates to the existing opportunity');

    if (await page.locator('#mobile-menu').isVisible()) await page.locator('#mobile-menu').click();
    const beforeReturn = apiCalls.length;
    await page.locator('#main-nav [data-view="ai-team"]').click();
    assert.equal(apiCalls.length, beforeReturn, 'returning to the objective panel does not fetch or mutate a restriction');
    if (!await details.evaluate(element => element.open)) await details.locator(':scope > summary').click();
    const manage = page.locator(`[data-manage-objective-restriction="${objective.id}"]`);
    const panel = page.locator('#business-objective-restriction');
    const typography = await panel.evaluateHandle(createRestrictionTypographySession);
    const form = page.locator('#objective-restriction-form');
    const mode = page.locator('#objective-restriction-mode');
    const account = page.locator('#objective-restriction-connection');
    const acknowledge = page.locator('#objective-restriction-ack');
    const saveButton = page.locator('#save-objective-restriction');
    const policyWrites = () => apiCalls.filter(call => call.path === '/api/business-objectives' && call.method === 'PUT');
    const openRestriction = async () => {
      const count = apiCalls.length;
      await manage.click(); await panel.waitFor({ state: 'visible' });
      assert.equal(apiCalls.length, count, 'opening uses the existing public bootstrap references without a request');
      assert.equal(await acknowledge.isChecked(), false);
      assert.equal(await panel.locator('img,script,[onerror]').count(), 0);
      assert.equal(await page.evaluate(() => window.restrictionInjected), undefined);
    };
    const policyFor = connection => ({ schema: OBJECTIVE_EXECUTION_POLICY_SCHEMA, mode: 'enforce', scope: {
      provider: 'shopify', operation: 'product_content', connectionId: connection.id, account: connection.metadata.shopDomain } });
    const saveRestriction = async (revision, executionPolicy) => {
      await acknowledge.check();
      const previous = policyWrites().length;
      const responsePromise = page.waitForResponse(response => response.url() === `${base}/api/business-objectives` && response.request().method() === 'PUT');
      await saveButton.click();
      const response = await responsePromise;
      assert.equal(response.status(), 200);
      const payload = await response.json();
      assert.equal(payload.objective.revision, revision + 1);
      assert.deepEqual(payload.objective.executionPolicy, executionPolicy);
      assert.equal(policyWrites().length, previous + 1);
      assert.deepEqual(JSON.parse(policyWrites().at(-1).body), { id: objective.id, revision, executionPolicy });
      const { updatedAt, revision: savedRevision, executionPolicy: savedPolicy, ...definition } = payload.objective;
      const { updatedAt: originalUpdatedAt, revision: originalRevision, ...originalDefinition } = objective;
      assert.deepEqual(definition, originalDefinition, 'policy-only browser saves keep every recorded objective condition');
      await panel.waitFor({ state: 'hidden' });
    };

    await openRestriction();
    assert.equal(await mode.inputValue(), 'preparation_only');
    await mode.selectOption('enforce');
    assert.equal(await account.inputValue(), '', 'no saved account is implicitly selected for a new restriction');
    assert.equal(await saveButton.isDisabled(), true);
    await account.selectOption(state.connections[0].id); await acknowledge.check();
    await account.selectOption(state.connections[1].id);
    assert.equal(await acknowledge.isChecked(), false, 'a different exact account requires fresh acknowledgement');
    await page.locator('#cancel-objective-restriction').click();
    await panel.waitFor({ state: 'hidden' });
    assert.equal(policyWrites().length, 0, 'cancel does not write');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-manage-objective-restriction')), objective.id);

    await openRestriction(); await mode.selectOption('enforce');
    assert.equal(await account.inputValue(), '', 'cancel discards the unsaved account choice');
    await account.selectOption(state.connections[0].id);
    await captureRestriction(page, width, 'add-restriction', typography);
    await saveRestriction(1, policyFor(state.connections[0]));

    await openRestriction();
    assert.equal(await account.inputValue(), state.connections[0].id);
    const beforeNoop = policyWrites().length;
    await form.evaluate(element => element.requestSubmit());
    assert.equal(policyWrites().length, beforeNoop, 'keyboard/form submission of an unchanged policy makes no PUT');
    await account.selectOption(state.connections[1].id);
    const consequence = await page.locator('#objective-restriction-consequence').textContent();
    for (const connection of state.connections) assert.ok(consequence.includes(connection.metadata.shopDomain), 'rebinding names both exact accounts');
    await captureRestriction(page, width, 'move-restriction', typography);
    await saveRestriction(2, policyFor(state.connections[1]));

    await openRestriction();
    const withoutConnection = await server.packsmart.store.get(state.workspace.id);
    withoutConnection.connections = withoutConnection.connections.filter(connection => connection.id !== state.connections[1].id);
    await server.packsmart.store.save(state.workspace.id, withoutConnection);
    const beforeReload = apiCalls.length;
    await page.locator('#reload-objective-restriction').click();
    await page.waitForFunction(() => !document.querySelector('#reload-objective-restriction').disabled);
    assert.deepEqual(apiCalls.slice(beforeReload).map(call => [call.method, call.path]).sort(),
      [['GET', '/api/business-objectives'], ['GET', '/api/connections']], 'explicit reload only reads saved definitions and public references');
    assert.equal(await mode.inputValue(), 'enforce');
    assert.ok((await panel.textContent()).includes(state.connections[1].metadata.shopDomain), 'the removed binding remains visible');
    assert.equal(await acknowledge.isChecked(), false);
    await mode.selectOption('preparation_only');
    await captureRestriction(page, width, 'remove-unavailable-restriction', typography);
    await saveRestriction(3, { schema: OBJECTIVE_EXECUTION_POLICY_SCHEMA, mode: 'preparation_only' });
    assert.equal(calls.length, before, 'restriction editing does not request another diagnostic, approval, or job');
    assert.deepEqual(unexpected, [], 'only the bounded local fixture routes were requested');
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    await typography.dispose();
    await context.close();
  }
  console.log('Objective review and owner restriction browser checks passed at 320, 390 and 1200 pixels with synthetic diagnostics and normal/200% text screenshots.');
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
