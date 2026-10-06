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
import { upsertBusinessObjective } from '../lib/business-objectives.mjs';
import { buildObjectiveReview } from '../lib/objective-review.mjs';
import { detectOpportunities } from '../lib/control.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-objective-review-browser-'));
const secret = 'objective-review-browser-test-only-more-than-thirty-two-characters';
const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
  SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' });
let browser;
try {
  const now = new Date().toISOString();
  const state = seedWorkspaceState({}, { workspaceId: 'review-browser', name: 'Synthetic objective review', email: 'review@example.test', passwordHash: 'fixture-only' });
  state.settings = { ...state.settings, currency: 'GBP', growthCapacityHours: 4, maxConcurrentGrowthExperiments: 2 };
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
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  browser = await chromium.launch({ headless: true });
  for (const width of [320,390,1200]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addCookies([{ name: 'packsmart_session', value: token, url: base, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage(), errors = [], calls = [], external = [];
    page.on('pageerror', error => errors.push(error.message));
    let statusReads = 0;
    const job = { id: 'job_browser_review', type: 'objective_prepare', status: 'queued', objectiveId: objective.id, objectiveRevision: objective.revision,
      attempts: 0, maxAttempts: 3, createdAt: now, updatedAt: now, completedAt: null, errorCode: null, reportAvailable: false };
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { external.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/business-objectives/reviews')) return route.continue();
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
    if (await page.locator('#mobile-menu').isVisible()) await page.locator('#mobile-menu').click();
    await page.locator('#main-nav [data-view="ai-team"]').click();
    const details = page.locator('.business-objectives-panel'); await details.locator('summary').click();
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
    const before = calls.length; await details.locator('summary').click(); await details.locator('summary').click();
    assert.equal(calls.length, before, 'reopening the completed report does not request it again');
    await result.locator('[data-investigate-review-opportunity="' + originalOpportunityId + '"]').click();
    await page.locator('#view-opportunities.active').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-opportunity-record')), originalOpportunityId);
    assert.equal(calls.length, before, 'investigation only navigates to the existing opportunity');
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    await context.close();
  }
  console.log('Objective review browser checks passed at 320, 390 and 1200 pixels with synthetic diagnostics.');
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
