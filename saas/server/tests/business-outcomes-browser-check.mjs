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
import { prepareExperimentOutcomeMeasurement, assessExperimentOutcomeMeasurement, digestMeasurementValue } from '../lib/experiment-measurements.mjs';
import { createBusinessOutcomeCandidate, correctBusinessOutcomeCandidate, withdrawBusinessOutcomeCandidate, createOutcomePublicationBoundary, aggregateBusinessOutcomes } from '../lib/business-outcomes.mjs';
import { objectivePublicationFixture } from './objective-publication-fixture.mjs';
import { publicReviewedSourceAction } from '../lib/reviewed-action-evidence.mjs';
import { createRestrictionTypographySession } from './objective-browser-typography.mjs';
import { captureOutcomeViewports } from './business-outcomes-browser-capture.mjs';
import { createBusinessOutcomePersistence } from '../lib/business-outcome-store.mjs';

async function selectedReviewPayload({ workspaceId, workspaceRevision, experiment, measurement, publication, publicationMeasurement, action, choicesAvailable, now }) {
  let reads = 0;
  const adapter = createBusinessOutcomePersistence({ now: () => new Date(now), request: async (pathname, options) => {
    reads++;
    assert.equal(pathname, 'rpc/runvara_read_business_outcome_review');
    assert.equal(options.method, 'POST'); assert.equal(options.maxResponseBytes, 128 * 1024);
    assert.deepEqual(JSON.parse(options.body), { p_workspace_id: workspaceId, p_experiment_id: experiment.id });
    const { head, version } = publication || {};
    const current = publication ? { workspace_id: workspaceId, outcome_id: head.outcomeId, version_id: head.versionId,
      version: { workspace_id: workspaceId, outcome_id: head.outcomeId, version_id: head.versionId, revision: version.revision,
        digest: version.digest, status: version.status, payload: version, publication_id: head.publicationId,
        intent_digest: digestMeasurementValue(['synthetic_browser_review', head.publicationId]), committed_at: head.committedAt, commit_revision: head.commitRevision } } : null;
    // The real review RPC bounds its title; bootstrap retains the long fixture.
    return structuredClone({ workspaceId, workspaceRevision, experiment: { ...experiment, title: experiment.title.slice(0, 180) }, measurement, current, actionLinkContract: 'runvara-reviewed-action/v2', actionChoices: choicesAvailable ? [action.choice] : [], currentActionAssociation: publication ? publicationMeasurement.intervention : null });
  } });
  const result = await adapter.review(workspaceId, experiment.id);
  assert.equal(reads, 1, 'selected relationships use the existing single review snapshot');
  return result;
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-outcomes-browser-'));
const secret = 'business-outcomes-browser-fixture-more-than-thirty-two-characters';
const password = 'Outcome-fixture-only-49!';
const port = 18874, base = `http://127.0.0.1:${port}`;
const server = createPacksmartServer({ NODE_ENV: 'test', APP_PUBLIC_URL: base, SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
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
const captures = [];
try {
  const completed = await objectivePublicationFixture({ contentInput: { title: 'Recorded product ' + hostile, description: 'Retained Shopify description ' + hostile + '\n' + 'long-synthetic-product-content '.repeat(36) + ' EXACT RETAINED END' } });
  const action = { source: completed.source, choice: { id: completed.source.context.writeId, account: completed.source.context.account, productId: completed.source.input.productId, title: completed.source.input.title, completedAt: completed.source.context.completedAt, digest: completed.source.digest, origin: completed.source.context.origin, originatingObjective: completed.source.context.originatingObjective } };
  const state = seedWorkspaceState({}, { workspaceId: completed.workspaceId, userId: 'user_outcomes_owner',
    name: 'Synthetic business outcome checks', email: 'outcomes@example.test', passwordHash: hashPassword(password) });
  state.products = [];
  state.revenueEngine.experiments = [experiment];
  await server.packsmart.store.save(state.workspace.id, state);
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
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
    let measurement = null, publication = null, publicationMeasurement = null, workspaceRevision = 'browser_workspace_revision_1', holdNext = null;
    let choicesAvailable = true, losePublicationResponse = false;
    const versions = new Map(), receipts = new Map(), now = new Date().toISOString();
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
      else if (method === 'GET' && url.pathname === `/api/business-outcomes/experiments/${experiment.id}`) response = {
        json: await selectedReviewPayload({ workspaceId: state.workspace.id, workspaceRevision, experiment, measurement, publication, publicationMeasurement, action, choicesAvailable, now }) };
      else if (method === 'PUT' && url.pathname === `/api/business-outcomes/experiments/${experiment.id}/measurement`) {
        const input = request.postDataJSON();
        measurement = prepareExperimentOutcomeMeasurement(input, { workspaceId: state.workspace.id,
          experimentId: experiment.id, actorId: state.users[0].id, now, previousMeasurement: measurement, ...(input.actionSelection ? { actionEvidence: action.source, reuseVersionId: input.actionSelection.reuseVersionId ?? null } : {}) });
        workspaceRevision = 'browser_draft_revision_' + measurement.revision;
        response = { json: detailPayload() };
      } else if (method === 'POST' && url.pathname === '/api/business-outcomes/publish') {
        const input = request.postDataJSON();
        assert.deepEqual(Object.keys(input).sort(), ['publicationId', 'action', 'experimentId', 'expectedWorkspaceRevision', 'expectedMeasurementRevision', 'expectedMeasurementDigest', 'expectedHeadVersionId', 'expectedHeadDigest', 'withdrawalReason'].sort(), 'publication uses only the reviewed conflict-safe input fields');
        const retainedReceipt = receipts.get(input.publicationId);
        if (retainedReceipt) {
          assert.deepEqual(input, retainedReceipt.input, 'an explicit retry preserves every reviewed intent byte');
          response = { json: { ...retainedReceipt.result, replayed: true } };
        } else {
          assert.equal(input.experimentId, experiment.id);
          const retained = input.action === 'withdraw' ? publicationMeasurement : measurement;
          assert.equal(input.expectedMeasurementRevision, retained.revision);
          assert.equal(input.expectedMeasurementDigest, retained.digest);
          assert.equal(input.expectedWorkspaceRevision, workspaceRevision);
          assert.equal(input.expectedHeadVersionId, publication?.head.versionId ?? null); assert.equal(input.expectedHeadDigest, publication?.head.digest ?? null);
          assert.equal(input.withdrawalReason, input.action === 'withdraw' ? 'incorrect_measurement' : null);
          const verification = { kind: 'owner_attestation', actorId: state.users[0].id, verifiedAt: now, measurementDigest: retained.digest };
          const record = { source: { type: 'experiment_measurement', experimentId: experiment.id, measurementRevision: retained.revision, measurementDigest: retained.digest },
            ...Object.fromEntries(['metric', 'amount', 'currency', 'window', 'coverage', 'method', 'provenance', 'links'].map(key => [key, retained[key]])), verification };
          const version = input.action === 'withdraw' ? withdrawBusinessOutcomeCandidate(publication.version, { reason: input.withdrawalReason, verification }, { workspaceId: state.workspace.id, now })
            : input.action === 'correct' ? correctBusinessOutcomeCandidate(publication.version, record, { workspaceId: state.workspace.id, now })
            : createBusinessOutcomeCandidate(record, { workspaceId: state.workspace.id, now });
          workspaceRevision = 'browser_publication_revision_' + version.revision;
          publication = { head: { schema: 'runvara-outcome-head/v1', workspaceId: state.workspace.id,
            outcomeId: version.outcomeId, revision: version.revision, versionId: version.versionId, digest: version.digest,
            status: version.status === 'withdrawn' ? 'withdrawn' : 'published', publicationId: input.publicationId, committedAt: now, commitRevision: workspaceRevision }, version };
          publicationMeasurement = structuredClone(retained);
          versions.set(version.versionId, { publication: structuredClone(publication), sourceMeasurement: publicationMeasurement, sourceAction: publicReviewedSourceAction(action.source, { workspaceId: state.workspace.id }) });
          const result = { workspaceId: state.workspace.id, publication, replayed: false, isCurrent: true };
          receipts.set(input.publicationId, { input: structuredClone(input), result: structuredClone(result) });
          response = { json: result };
          if (losePublicationResponse) { losePublicationResponse = false; response = { status: 503, json: { code: 'SYNTHETIC_UNCONFIRMED' } }; }
        }
      } else if (method === 'GET' && url.pathname.startsWith('/api/business-outcomes/versions/')) {
        const retained = versions.get(decodeURIComponent(url.pathname.split('/').at(-1))); assert.ok(retained);
        response = { json: { ...structuredClone(retained), currentStatus: 'not_checked', source: 'immutable_business_outcome_version' } };
      } else assert.fail(`Unexpected outcome request: ${method} ${url.pathname}`);
      await route.fulfill(response);
      if (gate) gate.done = true;
    });

    const capture = (name, subtree, controls = []) => captureOutcomeViewports({ page, width, name, subtree, controls, captures, typographyFactory: createRestrictionTypographySession });
    const panel = page.locator('#business-outcomes-panel'), status = page.locator('#business-outcomes-status');
    const summary = page.locator('#business-outcomes-summary'), detail = page.locator('#business-outcomes-detail');
    const select = page.locator('#business-outcomes-experiment'), load = page.locator('#business-outcomes-load');
    const refresh = page.locator('#business-outcomes-refresh'), form = page.locator('#business-outcomes-form');
    const review = page.locator('#business-outcomes-review'), relationship = page.locator('#business-outcomes-relationship');
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
    await summary.getByText('No owner-reviewed results yet.', { exact: false }).waitFor();
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
    assert.match(await detail.textContent(), /No business result recorded yet/);
    assert.match(await relationship.textContent(), /No owner-reviewed result was found for this experiment when loaded/);
    assert.match(await relationship.textContent(), /Only this experiment was checked; the rest of the workspace was not/);
    assert.equal(calls.length, openedCalls + 1, 'the selected relationship adds no browser request');
    assert.equal(await form.locator('[name="amount"]').inputValue(), '', 'unknown amount is blank, never an inferred zero');
    assert.equal(await form.locator('[name="currency"]').inputValue(), '', 'measurement currency is not inferred from workspace defaults');
    assert.equal(callCount('PUT'), 0); assert.equal(callCount('POST'), 0);

    assert.equal(await form.locator('[name="actionSelection"]').inputValue(), '', 'a recorded action is never chosen automatically');
    const beforeSelection = calls.length;
    await form.locator('[name="actionSelection"]').selectOption('action:' + action.choice.id);
    assert.equal(calls.length, beforeSelection, 'choosing an action uses the same selected snapshot without another request');
    for (const value of [action.choice.id, action.choice.account, action.choice.productId, action.choice.completedAt]) assert.ok((await page.locator('#business-outcomes-action-details').textContent()).includes(value));
    for (const value of [action.choice.originatingObjective.id, String(action.choice.originatingObjective.revision), action.choice.originatingObjective.digest]) assert.ok((await page.locator('#business-outcomes-action-details').textContent()).includes(value));
    await assertNoOverflow(page, width, 'explicit recorded action selector');
    const input = { actionSelection: { actionId: action.choice.id }, expectedRevision: 0, amount: '-12.004000', currency: 'GBP',
      window: { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-04T00:00:00.000Z' },
      coverage: { status: 'complete', observedCount: 12, expectedCount: 12 }, method: { kind: 'reconciled_manual' },
      observedAt: '2026-10-05T12:00:00.000Z', report: { description: 'Synthetic retained evidence. ' + hostile + ' ' + 'long-recorded-source-detail'.repeat(12), costsComplete: true } };
    for (const [name, value] of Object.entries({ amount: input.amount, currency: input.currency,
      // Native datetime-local controls canonicalize zero seconds/milliseconds to minutes.
      // Fill that accepted form while retaining exact ISO UTC assertions on the request.
      startsAt: input.window.startsAt.slice(0, 16), endsAt: input.window.endsAt.slice(0, 16),
      observedAt: input.observedAt.slice(0, 16), observedCount: '12', expectedCount: '12', description: input.report.description }))
      await form.locator(`[name="${name}"]`).fill(value);
    for (const [name, value] of Object.entries({ coverageStatus: 'complete', method: 'reconciled_manual', costsComplete: 'true' }))
      await form.locator(`[name="${name}"]`).selectOption(value);
    await capture('selection', page.locator('#business-outcomes-action-details'), [form.locator('[name="actionSelection"]'), form.locator('button[type="submit"]')]);
    const savePath = `${detailPath}/measurement`, draftSave = holdRequest('PUT', savePath), readsBeforeSave = callCount('GET');
    await form.evaluate(element => {
      element.requestSubmit();
      element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await waitUntil(() => draftSave.seen, 'explicit save requests a typed measurement');
    assert.equal(callCount('PUT', savePath), 1, 'repeated draft submits coalesce');
    assert.equal(await relationship.count(), 0, 'saving immediately removes the previous selected relationship check');
    assert.deepEqual(calls.find(call => call.method === 'PUT').body, input);
    assert.equal(callCount('POST'), 0, 'draft preparation never publishes');
    await releaseRequest(draftSave); await status.getByText('Draft saved.', { exact: false }).waitFor();
    assert.equal(await relationship.count(), 0, 'saving cannot restore a selected relationship without a detail refresh');
    assert.equal(callCount('GET'), readsBeforeSave, 'relationship invalidation never refreshes or polls automatically');
    assert.match(await detail.textContent(), /-12\.004 GBP/);
    assert.match(await detail.textContent(), /ready for owner review/);
    assert.equal(await detail.locator('img,script,[onerror]').count(), 0);
    assert.equal(await page.evaluate(() => window.outcomeInjected), undefined);

    const publicationReview = detail.locator('[data-outcome-action="publish"]');
    await publicationReview.click(); await review.waitFor({ state: 'visible' });
    assert.match(await review.textContent(), /-12\.004 GBP/);
    assert.match(await review.textContent(), /Measurement version 1/);
    assert.match(await review.textContent(), /explicitly associate the recorded action shown above/);
    for (const value of [action.choice.id, action.choice.account, action.choice.productId, action.choice.completedAt]) assert.ok((await review.textContent()).includes(value));
    assert.match(await review.textContent(), /does not prove Runvara caused the result/);
    assert.equal(await page.locator('#business-outcomes-confirm').isDisabled(), true);
    await page.locator('#business-outcomes-confirm').evaluate(element => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.equal(callCount('POST'), 0, 'an unchecked review cannot publish, including a synthetic click');
    await page.locator('#business-outcomes-cancel').click();
    await review.waitFor({ state: 'hidden' });
    assert.equal(callCount('POST'), 0, 'cancelled review sends no publication request');

    // Actual Back/Forward events invalidate a dismissed review and send no API work.
    const beforeHistory = calls.length;
    await page.evaluate(() => history.pushState(null, '', '#synthetic-outcome-review'));
    await page.goBack(); await page.goForward();
    assert.equal(await panel.getAttribute('open'), null); assert.equal(calls.length, beforeHistory);
    await open(); assert.equal(await review.isVisible(), false);

    await publicationReview.click(); await page.locator('#business-outcomes-attest').check();
    assert.equal(callCount('POST'), 0, 'attestation alone does not publish');
    await assertNoOverflow(page, width, 'reviewed measurement');
    await capture('owner-review', review, [page.locator('#business-outcomes-attest'), page.locator('#business-outcomes-confirm'), page.locator('#business-outcomes-cancel')]);
    losePublicationResponse = true;
    const publicationWrite = holdRequest('POST', '/api/business-outcomes/publish');
    await tripleClick(page.locator('#business-outcomes-confirm'));
    await waitUntil(() => publicationWrite.seen, 'confirmed publication reaches the transport');
    assert.equal(callCount('POST'), 1, 'repeated confirm clicks submit one reviewed publication');
    assert.equal(await page.locator('#business-outcomes-confirm').isDisabled(), true);
    await releaseRequest(publicationWrite);
    await status.getByText('Confirmation was not received.', { exact: false }).waitFor();
    assert.equal(callCount('POST'), 1, 'unknown confirmation never retries automatically');
    assert.equal(await page.locator('#business-outcomes-confirm').isDisabled(), true);
    await capture('unknown-publication', review, [page.locator('#business-outcomes-attest'), page.locator('#business-outcomes-confirm'), page.locator('#business-outcomes-cancel')]);
    const firstIntent = calls.find(call => call.method === 'POST').body;
    await page.locator('#business-outcomes-cancel').click(); await review.waitFor({ state: 'hidden' });
    await panel.locator(':scope > summary').click(); await open(); await review.waitFor({ state: 'visible' });
    assert.equal(callCount('POST'), 1); await page.locator('#business-outcomes-attest').check(); await tripleClick(page.locator('#business-outcomes-confirm'));
    await status.getByText('Review saved.', { exact: false }).waitFor();
    assert.equal(callCount('POST'), 2); assert.deepEqual(calls.filter(call => call.method === 'POST')[1].body, firstIntent);
    await review.waitFor({ state: 'hidden' });
    assert.match(await detail.textContent(), /This saved version has already been reviewed/);
    assert.doesNotMatch(await detail.textContent(), /ready for owner review/);
    assert.equal(await detail.locator('[data-outcome-action="publish"]').isDisabled(), true);
    assert.equal(await relationship.count(), 0, 'publication success still needs explicit selected-detail refresh');
    await refresh.click();
    // Wait for the actual result heading, not the previous empty-state sentence.
    await summary.getByRole('heading', { name: 'Owner-reviewed result · version 1', exact: true }).waitFor();
    assert.match(await summary.textContent(), /-12\.004 GBP/);
    assert.match(await summary.textContent(), /Reconciled records/);
    assert.match(await summary.textContent(), /Recorded total/);
    assert.doesNotMatch(await summary.textContent(), /reconciled_manual|measured_sum|committed selection|Current publications/);
    assert.equal(await form.locator('h3').textContent(), 'Record a business result');
    assert.match(await summary.textContent(), /not independently verified/);
    assert.match(await summary.textContent(), /Attribution to RunvaraNot established/);
    assert.doesNotMatch(await summary.textContent(), /Synthetic retained evidence|Retained Shopify description|write_reviewed_action/);
    const sourcePath = `/api/business-outcomes/versions/${publication.version.versionId}`;
    assert.equal(callCount('GET', sourcePath), 0, 'loading a committed selection does not eagerly hydrate retained evidence');
    const evidenceRead = holdRequest('GET', sourcePath), evidence = summary.locator('[data-outcome-evidence]');
    await tripleClick(evidence); await waitUntil(() => evidenceRead.seen, 'explicit retained evidence request must be observed');
    assert.equal(callCount('GET', sourcePath), 1, 'repeated evidence clicks coalesce');
    await releaseRequest(evidenceRead);
    await summary.getByText('Original measurement report', { exact: true }).waitFor();
    await summary.getByText('Exact recorded action input', { exact: true }).waitFor();
    assert.ok((await summary.textContent()).includes(action.source.input.description), 'the retained action description is complete and untruncated');
    assert.match(await summary.textContent(), /Saved with this result; its current status has not been rechecked/);
    assert.match(await summary.textContent(), /Synthetic retained evidence/);
    assert.match(await summary.textContent(), /cannot recompute the private action snapshot digest/);
    assert.ok((await summary.textContent()).includes(action.choice.originatingObjective.id));
    assert.equal(await summary.locator('img,script,[onerror]').count(), 0);
    assert.equal(await page.evaluate(() => window.outcomeInjected), undefined);
    await tripleClick(evidence);
    assert.equal(callCount('GET', sourcePath), 1, 'successfully loaded evidence is reused');
    const beforeRelationshipRefresh = calls.length;
    await loadExperiment();
    assert.equal(calls.length, beforeRelationshipRefresh + 1, 'one explicit detail refresh also loads its relationship');
    assert.match(await relationship.textContent(), /An owner-reviewed result was linked to this experiment when loaded/);
    assert.match(await relationship.textContent(), /Only this experiment was checked; the rest of the workspace was not/);
    assert.doesNotMatch(await relationship.evaluate(element => element.outerHTML), /outcomes-browser|user_outcomes_owner|experiment_browser_outcome|-12\.004|GBP|Synthetic retained evidence|selected_snapshot|selected_revision|selected_outcome|digest|qualification|canonical|forecast|learning|execution/);
    await assertNoOverflow(page, width, 'committed result and retained evidence');
    await capture('exact-evidence', summary.locator('[data-outcome-evidence-result]'), [evidence]);

    // A removed mutable action requires an explicit immutable reuse choice.
    const originalVersionId = publication.version.versionId;
    choicesAvailable = false; await loadExperiment();
    await form.locator('button[type="submit"]').click(); await status.getByText('The saved action is no longer an exact current choice.', { exact: false }).waitFor();
    assert.equal(callCount('PUT'), 1);
    await form.locator('[name="actionSelection"]').selectOption('reuse:' + originalVersionId);
    await form.locator('[name="amount"]').fill('7.5');
    await capture('explicit-reuse', page.locator('#business-outcomes-action-details'), [form.locator('[name="actionSelection"]'), form.locator('button[type="submit"]')]);
    await form.locator('button[type="submit"]').click(); await status.getByText('Draft saved.', { exact: false }).waitFor();
    assert.equal(measurement.schema, 'runvara-experiment-measurement/v3'); assert.equal(measurement.intervention.reuseVersionId, originalVersionId);
    assert.deepEqual(measurement.intervention.originatingObjective, action.choice.originatingObjective);
    await detail.locator('[data-outcome-action="correct"]').click();
    await capture('correction-review', review, [page.locator('#business-outcomes-attest'), page.locator('#business-outcomes-confirm'), page.locator('#business-outcomes-cancel')]);
    await page.locator('#business-outcomes-attest').check(); await tripleClick(page.locator('#business-outcomes-confirm'));
    await status.getByText('Review saved.', { exact: false }).waitFor(); await loadExperiment();
    assert.equal(publication.version.revision, 2);
    await detail.locator('[data-outcome-source-current]').click();
    await page.locator('#business-outcomes-current-source').getByText('Exact recorded action input', { exact: true }).waitFor();
    assert.ok((await page.locator('#business-outcomes-current-source').textContent()).includes('EXACT RETAINED END'));
    // Unlink only the later draft, then withdraw the exact reviewed correction.
    await form.locator('[name="actionSelection"]').selectOption(''); await form.locator('button[type="submit"]').click();
    await status.getByText('Draft saved.', { exact: false }).waitFor(); assert.equal(measurement.schema, 'runvara-experiment-measurement/v1');
    const laterDraftDigest = measurement.digest;
    await detail.locator('[data-outcome-action="withdraw"]').click();
    await page.locator('#business-outcomes-reason').selectOption('incorrect_measurement');
    await capture('withdrawal-review', review, [page.locator('#business-outcomes-reason'), page.locator('#business-outcomes-attest'), page.locator('#business-outcomes-confirm'), page.locator('#business-outcomes-cancel')]);
    await page.locator('#business-outcomes-attest').check(); await tripleClick(page.locator('#business-outcomes-confirm'));
    await status.getByText('Review saved.', { exact: false }).waitFor(); await loadExperiment();
    assert.equal(publication.version.revision, 3); assert.equal(publication.head.status, 'withdrawn'); assert.equal(measurement.digest, laterDraftDigest);
    assert.equal(await detail.locator('[data-outcome-action]').count(), 0);
    assert.equal(await form.locator('[name="actionSelection"] option[value^="reuse:"]').count(), 0);
    const withdrawnEvidence = detail.locator('[data-outcome-source-current]'); await withdrawnEvidence.click();
    await page.locator('#business-outcomes-current-source').getByText('Exact recorded action input', { exact: true }).waitFor();
    assert.ok((await page.locator('#business-outcomes-current-source').textContent()).includes(action.choice.originatingObjective.id));
    await capture('withdrawn-evidence', page.locator('#business-outcomes-current-source'), [withdrawnEvidence]);
    assert.equal(callCount('PUT'), 3); assert.equal(callCount('POST'), 4);

    // A late 401 belongs to its abandoned navigation, not the freshly loaded UI.
    await page.evaluate(() => { window.__holdOutcomePastCancellation = true; });
    const navigation401 = holdRequest('GET', '/api/business-outcomes', 401);
    await refresh.click(); await waitUntil(() => navigation401.seen, 'navigation race request must be in flight');
    const beforeNavigation = calls.length;
    await navigate(page, 'overview');
    assert.equal(await relationship.count(), 0, 'navigation removes the checked relationship before returning');
    await navigate(page, 'revenue-engine'); await open();
    assert.equal(await relationship.count(), 0, 'reopening cannot restore a stale selected relationship');
    assert.equal(calls.length, beforeNavigation, 'clearing and reopening relationships sends no extra request');
    await refresh.click(); await status.getByText('Results loaded.', { exact: false }).waitFor();
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
    await status.getByText('Results loaded.', { exact: false }).waitFor();
    await loadExperiment();
    const newSessionDetail = await detail.textContent(), newSessionSummary = await summary.textContent();
    await releaseRequest(session401);
    assert.equal(await page.locator('#app-shell').isVisible(), true, 'an old-session 401 cannot clear the replacement session');
    assert.equal(await page.locator('#login-screen').isVisible(), false);
    assert.equal(await detail.textContent(), newSessionDetail, 'old-session completion cannot change replacement detail');
    assert.equal(await summary.textContent(), newSessionSummary, 'old-session completion cannot change replacement summary');
    assert.equal(callCount('POST'), 4, 'navigation and reauthentication never replay publication');
    assert.equal(callCount('PUT'), 3, 'navigation and reauthentication never replay draft preparation');
    assert.deepEqual(errors, [], 'browser must remain free of unhandled errors');
    assert.deepEqual(external, [], 'synthetic checks never contact external providers');
    assert.deepEqual(writes.filter(write => !write.endsWith('/api/auth/logout') && !write.endsWith('/api/auth/login')),
      [`PUT ${savePath}`, 'POST /api/business-outcomes/publish', 'POST /api/business-outcomes/publish', `PUT ${savePath}`, 'POST /api/business-outcomes/publish', `PUT ${savePath}`, 'POST /api/business-outcomes/publish'], 'outcomes never execute commercial/provider actions');
    for (const group of ['preparation', 'publication', 'withdrawal']) {
      const images = captures.filter(row => row.width === width && row.group === group);
      assert.ok(images.length > 0, `${width}px ${group} evidence must be captured`);
      const bytes = (await Promise.all(images.map(row => fs.stat(row.file)))).reduce((sum, stat) => sum + stat.size, 0);
      assert.ok(bytes < 31 * 1024 * 1024, `${width}px ${group} evidence leaves room below the 32 MiB ZIP bound`);
      console.log(`${width}px ${group} outcome evidence: ${images.length} viewport images, ${bytes} bytes; exact 200% source/review subtree typography, normal-size interactions, real fixed chrome.`);
    }
    await context.close();
  }
  console.log('Objective action outcome selection, review, unknown acknowledgement recovery, exact public evidence, correction reuse, unlink and withdrawal passed at 320, 390 and 1200 pixels. Separate normal/exact 200% subtree captures cover contiguous real scrolling source and action controls; no app-wide zoom claim. Synthetic services only; no provider mutation.');
} finally {
  if (browser) await browser.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
