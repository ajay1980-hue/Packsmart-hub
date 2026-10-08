// Actual app + server integration, with synthetic tenant records and a real
// current-head adapter over local fixture rows only. Run in the existing CI gate.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { createPacksmartServer } from '../server.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { upsertBusinessObjective } from '../lib/business-objectives.mjs';
import { createBusinessOutcomeCandidate, withdrawBusinessOutcomeCandidate } from '../lib/business-outcomes.mjs';
import { createBusinessOutcomePersistence } from '../lib/business-outcome-store.mjs';
import { CONTENT_WORKSPACE } from './objective-content-fixture.mjs';
import { publishedActionGraphFixture } from './published-action-graph-fixture.mjs';
import { createRestrictionTypographySession } from './objective-browser-typography.mjs';
import { createOutcomeViewportSession } from './business-outcomes-browser-capture.mjs';

async function graphTypography(page) {
  return page.locator('.business-graph-inspector .status-list > div').evaluateAll(rows => rows.map(row => {
      const summary = row.parentElement.id === 'business-graph-result';
      const label = row.querySelector('span'), value = row.querySelector('b');
      const measure = element => {
        const style = getComputedStyle(element), range = document.createRange(), bounds = element.getBoundingClientRect();
        range.selectNodeContents(element);
        const textRects = [...range.getClientRects()].filter(rect => rect.width && rect.height);
        const rowBounds = row.getBoundingClientRect();
        // Whole-box bounds can pass even when "31" or "Complete" has been
        // split across lines. Measure each summary value word's actual range.
        const words = [], walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        if (summary && element === value) {
          for (let text; (text = walker.nextNode());) for (const match of text.textContent.matchAll(/[A-Za-z]+|\d+/g)) {
            range.setStart(text, match.index); range.setEnd(text, match.index + match[0].length);
            const rects = [...range.getClientRects()].filter(rect => rect.width && rect.height);
            words.push({ text: match[0], lineCount: new Set(rects.map(rect => Math.round(rect.top * 100) / 100)).size });
          }
        }
        return { text: element.textContent, fontSize: parseFloat(style.fontSize), whiteSpace: style.whiteSpace,
          overflowX: style.overflowX, overflowY: style.overflowY, textOverflow: style.textOverflow,
          lineCount: new Set(textRects.map(rect => Math.round(rect.top * 100) / 100)).size,
          words,
          width: element.clientWidth, scrollWidth: element.scrollWidth, height: element.clientHeight, scrollHeight: element.scrollHeight,
          textInside: textRects.every(rect => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 &&
            rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1),
          insideRow: bounds.left >= rowBounds.left - 1 && bounds.right <= rowBounds.right + 1 &&
            bounds.top >= rowBounds.top - 1 && bounds.bottom <= rowBounds.bottom + 1 };
      };
      return { summary, label: measure(label), value: measure(value) };
    }));
}

function assertReadableRows(rows, width, { doubled = false, summaryCounts } = {}) {
  assert.ok(rows.length > 0, 'expanded measurement, result and snapshot rows were inspected');
  const summaries = rows.filter(row => row.summary);
  for (const [label, value] of [
    ['Recorded entities inspected', String(summaryCounts.nodes)], ['Recorded links inspected', String(summaryCounts.edges)],
    ['Relationship display coverage', 'Complete within this display'], ['Current reviewed results', 'Snapshot available']
  ]) assert.ok(summaries.some(row => row.label.text === label && row.value.text === value), `actual summary is inspected at ${width}px: ${label} = ${value}`);
  for (const row of summaries) {
    const context = `${width}px${doubled ? ' doubled text' : ''}: ${JSON.stringify(row)}`;
    assert.ok(row.value.words.length > 0, 'summary words were measured: ' + context);
    for (const word of row.value.words) assert.equal(word.lineCount, 1, 'summary count/status words stay intact: ' + context);
    if (/^[\d,]+$/.test(row.value.text)) assert.equal(row.value.lineCount, 1, 'summary counts stay on one line: ' + context);
  }
  for (const row of rows) for (const item of [row.label, row.value]) {
    const context = `${width}px${doubled ? ' doubled text' : ''}: ${JSON.stringify(row)}`;
    if (row.summary && width > 600) {
      assert.ok(Math.abs(item.fontSize - 13.12 * (doubled ? 2 : 1)) < .01, 'desktop summary keeps its existing .82rem baseline: ' + context);
    } else assert.ok(item.fontSize >= (doubled ? 28 : 14), 'phone summaries and nested evidence text stay readable: ' + context);
    assert.notEqual(item.whiteSpace, 'nowrap', 'larger text must be allowed to wrap: ' + context);
    assert.ok(!['hidden', 'clip'].includes(item.overflowX) && !['hidden', 'clip'].includes(item.overflowY), 'text cannot be clipped: ' + context);
    assert.notEqual(item.textOverflow, 'ellipsis', 'exact evidence cannot be shortened: ' + context);
    assert.ok(item.width + 1 >= item.scrollWidth && item.height + 1 >= item.scrollHeight, 'text fits its full visible box: ' + context);
    assert.ok(item.textInside && item.insideRow, 'all text remains inside its visible row: ' + context);
  }
}

// Capture real scrolling viewports, including fixed chrome, for the entire
// inspected source and its navigation controls. No stitched element captures.
async function captureGraphViewports(page, width, suffix = '') {
  const panel = page.locator('.business-graph-inspector');
  const viewport = await panel.evaluateHandle(createOutcomeViewportSession);
  // The complete expanded graph exceeds 60 real viewports at 320px and 200%
  // text. Keep a finite enlarged-text budget alongside the per-width byte bound.
  const maxCaptures = suffix === '-large-text' ? 80 : 60;
  const horizontal = bounds => assert.ok(bounds.left >= bounds.visibleLeft - 2 && bounds.right <= bounds.visibleRight + 2 && bounds.scroll <= bounds.client + 2,
    `graph ${width}px${suffix} horizontal clipping: ${JSON.stringify(bounds)}`);
  try {
    let covered = 0, part = 0;
    while (true) {
      await viewport.evaluate((session, offset) => session.reveal(offset), Math.max(0, covered - 80));
      const bounds = await viewport.evaluate(session => session.bounds()); horizontal(bounds);
      const coverage = { width, suffix, part: part + 1, maxCaptures, covered, advance: bounds.to - covered, remaining: bounds.height - bounds.to, ...bounds };
      console.log(`graph source capture: ${JSON.stringify(coverage)}`);
      assert.ok(bounds.from <= covered + 2 && bounds.to > covered + 1, `graph capture leaves a gap or fails to advance: ${JSON.stringify(coverage)}`);
      await page.screenshot({ path: `/tmp/runvara-business-graph-${width}-source${suffix}-${++part}.png`, fullPage: false });
      covered = bounds.to;
      if (covered >= bounds.height - 1) break;
      assert.ok(part < maxCaptures, `graph source exceeds its viewport capture budget: ${JSON.stringify(coverage)}`);
    }
    const controls = [page.locator('#load-business-graph'), panel.locator('[data-graph-record-link]').first(), panel.locator('[data-graph-record-link]').nth(1)];
    for (let index = 0; index < controls.length; index++) {
      const control = await controls[index].evaluateHandle(createOutcomeViewportSession);
      try {
        await control.evaluate(session => session.reveal(0));
        const bounds = await control.evaluate(session => session.bounds()); horizontal(bounds);
        assert.ok(bounds.height > 0 && bounds.from <= 1 && bounds.to >= bounds.height - 1, `graph control must be entirely visible: ${JSON.stringify(bounds)}`);
        await page.screenshot({ path: `/tmp/runvara-business-graph-${width}-control${suffix}-${index + 1}.png`, fullPage: false });
      } finally { await control.dispose(); }
    }
  } finally { await viewport.dispose(); }
}

const NOW = '2026-10-07T12:00:00.000Z', WORKSPACE = CONTENT_WORKSPACE;
const digest = value => createHash('sha256').update(value).digest('hex');
function publication(index, { experimentId, amount, currency = 'GBP', withdrawn = false, links = {} }) {
  const measurementDigest = digest('browser_measurement_' + index);
  let version = createBusinessOutcomeCandidate({
    source: { type: 'experiment_measurement', experimentId, measurementRevision: 1, measurementDigest },
    metric: 'incrementalContribution', amount, currency,
    window: { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' },
    coverage: { status: 'complete', scopeId: 'browser_scope_' + index, observedCount: 10, expectedCount: 10 },
    method: { kind: 'reconciled_manual', definitionVersion: 'incremental-contribution/v1' },
    provenance: { observationId: 'browser_observation_' + index, sourceRefs: [{ type: 'measurement_report', id: 'browser_report_' + index, digest: digest('browser_report_' + index) }],
      observedAt: '2026-10-06T12:00:00.000Z', aggregation: 'non_overlapping_scopes_attested' },
    verification: { kind: 'owner_attestation', actorId: 'browser_fixture_owner', verifiedAt: '2026-10-06T14:00:00.000Z', measurementDigest }, links
  }, { workspaceId: WORKSPACE, now: NOW });
  if (withdrawn) version = withdrawBusinessOutcomeCandidate(version, { reason: 'incorrect_measurement', verification: {
    ...version.verification, verifiedAt: '2026-10-06T18:00:00.000Z' } }, { workspaceId: WORKSPACE, now: NOW });
  const row = { workspace_id: WORKSPACE, outcome_id: version.outcomeId, revision: version.revision, version_id: version.versionId,
    digest: version.digest, status: version.status, payload: version, publication_id: 'browser_publication_' + index,
    intent_digest: digest('browser_intent_' + index), committed_at: '2026-10-06T19:00:00+00:00', commit_revision: 'browser_fixture_revision' };
  return { workspace_id: WORKSPACE, outcome_id: version.outcomeId, version_id: version.versionId, version: row };
}
const secret = 'graph-browser-test-only-secret-more-than-32-characters';
let providerRequests = 0;
let browser, currentReads = 0;
try {
  const prepared = await publishedActionGraphFixture({ kind: 'objective', workspaceId: WORKSPACE }), state = prepared.state;
  const manual = await publishedActionGraphFixture({ workspaceId: WORKSPACE });
  state.connectionWrites.push(manual.write); state.approvals.push(manual.approval); state.connections.push(...manual.state.connections);
  state.products.push({ id: 'p1', provider: 'shopify', title: 'Packaging evidence fixture', status: 'active', variants: [{ id: 'v1', sku: 'PS-1', price: 10, inventory: 3, available: true }] });
  upsertBusinessObjective(state, { id: state.businessObjectives[0].id, revision: state.businessObjectives[0].revision, title: 'Changed saved goal definition' }, { actorId: state.users[0].id });
  // The fixture's completion used synthetic transport. Inspection itself never
  // executes a write or reads any current provider source.
  const legacy = { ...structuredClone(state.connectionWrites[0]), id: 'browser_legacy_write', requestId: 'browser_legacy_request', approvalId: 'browser_missing_approval', status: 'uncertain' };
  delete legacy.objectivePolicyProposal; delete legacy.source;
  state.connectionWrites.push(legacy);
  state.revenueEngine.experiments = [
    { id: 'browser_experiment_one', status: 'completed', impact: { verified: true, incrementalContribution: 500 } },
    { id: 'browser_experiment_two', status: 'completed' },
    { id: 'browser_long_experiment_one', status: 'completed' },
    { id: 'browser_long_experiment_two', status: 'completed' }
  ];
  const rows = [publication(1, { experimentId: 'browser_experiment_one', amount: '-12.340001', links: prepared.version.links }),
    publication(2, { experimentId: 'browser_archived_experiment', amount: '0', currency: 'USD' }),
    publication(3, { experimentId: 'browser_experiment_two', amount: '99', withdrawn: true, links: manual.version.links }),
    publication(4, { experimentId: 'browser_long_experiment_one', amount: '999999999999999999.123456', currency: 'EUR' }),
    publication(5, { experimentId: 'browser_long_experiment_two', amount: '1', currency: 'EUR' })];
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const until = async condition => {
    for (let attempt = 0; attempt < 200; attempt++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail('Synthetic current-head request did not reach expected state');
  };
  for (const width of [320, 390, 1200]) {
    // Each viewport is an independent scenario with the same synthetic owner
    // and source data. Start a fresh server so state and rate budgets cannot
    // leak from the preceding scenario; production limiter checks stay intact.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), `runvara-graph-browser-${width}-`));
    let server, context, readBarrier = null, pendingRead = null;
    try {
    server = createPacksmartServer({ NODE_ENV: 'test', APP_PUBLIC_URL: 'http://127.0.0.1:18787', SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
      SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' },
      { schedulerEnabled: false, agentOpsEnabled: false, fetchImpl: () => { providerRequests++; throw new Error('Provider transport forbidden in synthetic graph fixture'); } });
    const persistence = createBusinessOutcomePersistence({ now: () => new Date(NOW), request: async (route, options) => {
      currentReads++;
      assert.ok(route.startsWith('runvara_business_outcome_heads?workspace_id=eq.' + WORKSPACE + '&'));
      assert.ok(route.endsWith('&order=outcome_id.asc&limit=51')); assert.equal(options.includeResponseMetadata, true);
      assert.doesNotMatch(route, /source_measurement|source_action/); assert.equal(options.method || 'GET', 'GET');
      if (readBarrier) {
        const barrier = pendingRead = readBarrier; readBarrier = null;
        try { await new Promise(resolve => { barrier.release = resolve; }); }
        finally { if (pendingRead === barrier) pendingRead = null; }
      }
      return { data: structuredClone(rows), contentRange: '0-4/5' };
    } });
    server.packsmart.store.businessOutcomeSummary = workspaceId => persistence.current(workspaceId);
    await server.packsmart.store.save(state.workspace.id, structuredClone(state));
    server.listen(18787, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addCookies([{ name: 'packsmart_session', value: token, url: base, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage(), errors = [], calls = [], apiCalls = [], unexpected = [], readsBefore = currentReads;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      apiCalls.push({ path: url.pathname, method: request.method() });
      if (request.method() === 'GET' && ['/api/auth/session', '/api/bootstrap', '/api/business-graph', '/api/business-objectives'].includes(url.pathname)) return route.continue();
      if (request.method() === 'PUT' && url.pathname === '/api/business-objectives') return route.continue();
      unexpected.push(apiCalls.at(-1)); return route.abort();
    });
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/business-graph') calls.push(request.url()); });
    const navigate = async view => {
      if (await page.locator('#mobile-menu').isVisible()) await page.locator('#mobile-menu').click();
      await page.locator(`#main-nav [data-view="${view}"]`).click();
      await page.locator(`#view-${view}.active`).waitFor();
    };
    await page.goto(base);
    await page.locator('#app-shell:not(.hidden)').waitFor();
    assert.equal(calls.length, 0, 'no automatic graph requests'); assert.equal(currentReads, readsBefore, 'bootstrap does not read current heads');
    const investigate = page.locator('[data-investigate-opportunity]').first();
    await investigate.waitFor();
    const navigatedId = await investigate.getAttribute('data-investigate-opportunity');
    await investigate.click();
    await page.locator('#view-opportunities.active').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-opportunity-record')), navigatedId);
    await navigate('overview');

    const details = page.locator('.business-graph-inspector'), result = page.locator('#business-graph-result'), button = page.locator('#load-business-graph');
    await page.locator('#open-reviewed-results').click();
    assert.equal(await details.evaluate(element => element.open), true); assert.equal(calls.length, 0, 'opening never fetches');
    const graphResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/business-graph');
    await button.evaluate(element => { element.click(); element.click(); });
    await result.getByText('Complete current-result read', { exact: true }).waitFor();
    const { summary: summaryCounts } = await (await graphResponse).json();
    assert.ok(Number.isSafeInteger(summaryCounts.nodes) && summaryCounts.nodes >= 10 && Number.isSafeInteger(summaryCounts.edges) && summaryCounts.edges >= 10,
      'the same graph response supplies multi-digit summary counts for the readability regression');
    assert.equal(calls.length, 1); assert.equal(currentReads, readsBefore + 1, 'one explicit request reads one current-head snapshot');
    assert.equal(new URL(calls[0]).search, '?outcomes=current&detail=true');
    assert.match(await result.textContent(), /Published results loaded4/); assert.match(await result.textContent(), /Withdrawn results loaded1/);
    assert.match(await result.textContent(), /-12.340001/); assert.match(await result.textContent(), /GBP/); assert.match(await result.textContent(), /USD/);
    assert.match(await result.textContent(), /Exact scoped amount0/); assert.match(await result.textContent(), /2026-10-01T00:00:00.000Z/);
    assert.match(await result.textContent(), /2026-10-06T00:00:00.000Z/); assert.match(await result.textContent(), /independent, not atomic or synchronized/);
    assert.match(await result.textContent(), /Full lifetime coverage is not claimed/); assert.match(await result.textContent(), /Unresolved reason/);
    assert.equal(await page.locator('#hg-value').textContent(), '—'); assert.equal(await page.locator('#hg-hours').textContent(), '—');
    assert.match(await page.locator('#hg-learning').textContent(), /do not establish qualified learning priors/);
    const history = result.locator('.retained-request-history');
    assert.match(await history.textContent(), /Request application statusRecorded completed/);
    assert.match(await history.textContent(), /Recorded approval statusRecorded approved/);
    assert.match(await history.textContent(), /Recorded goal linkLinked to saved goal 1/);
    assert.match(await history.textContent(), /Saved revision changed; recorded association preserved/);
    assert.match(await history.textContent(), /Request application statusRecorded uncertain/);
    assert.match(await history.textContent(), /Reference absent from the inspected retained snapshot/);
    assert.match(await history.textContent(), /Current source and execution eligibility were not checked/);
    assert.match(await history.textContent(), /Recorded originOrigin not recorded/);
    assert.doesNotMatch(await history.textContent(), /browser_legacy_write|browser_legacy_request|browser_missing_approval|Owner authored|myshopify\.com|content-owner/);
    await result.locator('.reviewed-result').evaluateAll(elements => elements.forEach(element => { element.open = true; }));
    assert.equal(await result.locator('[data-graph-record-link]').count(), 4, 'manual and v2 publications link existing retained rows');
    assert.match(await result.textContent(), /Not recorded in this publication/);
    assert.match(await result.textContent(), /Snapshot content comparedFalse; current mutable content was not compared/);
    assert.match(await result.textContent(), /published source digest is not the current input digest/);
    const linksBefore = apiCalls.length, urlBefore = page.url(), historyBefore = await page.evaluate(() => history.length);
    for (const link of await result.locator('[data-graph-record-link]').all()) {
      const targetId = await link.getAttribute('data-graph-record-link');
      await link.click(); await link.click();
      assert.equal(await page.evaluate(() => document.activeElement.id), targetId);
      assert.equal(await page.locator('#' + targetId).evaluate(element => element.closest('.retained-request').open), true);
    }
    assert.equal(apiCalls.length, linksBefore, 'inspection links do not fetch, approve or apply');
    assert.equal(page.url(), urlBefore); assert.equal(await page.evaluate(() => history.length), historyBefore, 'inspection links do not add browser history');
    const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
    assert.ok(dimensions.scroll <= dimensions.width + 2, `graph viewport overflow at ${width}px: ${JSON.stringify(dimensions)}`);
    assert.deepEqual(errors, []);
    // Expand each existing evidence block so actual result, amount and snapshot
    // typography is checked, including long opaque version/snapshot references.
    await result.locator('details').evaluateAll(elements => elements.forEach(element => { element.open = true; }));
    const normal = await graphTypography(page);
    assertReadableRows(normal, width, { summaryCounts });
    const ordinaryAmounts = normal.filter(row => row.label.text === 'Exact scoped amount' && ['-12.340001', '0'].includes(row.value.text));
    assert.equal(ordinaryAmounts.length, 2, 'ordinary exact amounts are present unchanged');
    const timestamps = normal.filter(row => /^(Observation window|Workspace read completed|Outcome read completed)/.test(row.label.text));
    assert.equal(timestamps.length, 8, 'three exact observation windows and both independent snapshot times are visible');
    for (const row of [...ordinaryAmounts, ...timestamps]) assert.equal(row.value.lineCount, 1, `ordinary exact evidence stays on one line at ${width}px: ${JSON.stringify(row)}`);
    const longAmount = normal.find(row => row.label.text === 'Exact scoped amount' && row.value.text === '1000000000000000000.123456');
    assert.ok(longAmount, 'a grouped exact amount longer than one candidate amount is preserved');
    assert.ok(normal.some(row => row.label.text === 'Request application status' && row.value.text === 'Recorded completed'), 'actual retained request typography is inspected');
    assert.ok(normal.some(row => row.label.text === 'Saved definition comparison' && row.value.text.startsWith('Saved revision changed')), 'actual saved revision comparison typography is inspected');
    await captureGraphViewports(page, width);

    // Capture the selected inspector subtree at exactly 200%, with every
    // descendant's baseline read before any style changes. This also covers
    // anchors, controls and source-boundary text without nested multiplication.
    const typography = await details.evaluateHandle(createRestrictionTypographySession);
    await typography.evaluate(session => session.begin());
    try {
    await typography.evaluate(session => session.enlarge());
    const doubled = await graphTypography(page);
    assertReadableRows(doubled, width, { doubled: true, summaryCounts });
    assert.deepEqual(doubled.map(row => [row.label.text, row.value.text]), normal.map(row => [row.label.text, row.value.text]), 'enlarged text preserves every exact value and label');
    if (width < 600) {
      assert.ok(doubled.some(row => row.label.text.startsWith('Observation window') && row.value.lineCount > 1), 'phone timestamps wrap naturally at doubled text size');
      assert.ok(doubled.find(row => row.value.text === longAmount.value.text).value.lineCount > 1, 'long exact amounts wrap without losing digits at doubled text size');
    }
    const enlargedDimensions = await page.evaluate(() => {
      const inspector = document.querySelector('.business-graph-inspector');
      return { scroll: document.documentElement.scrollWidth, width: innerWidth, panelWidth: inspector.clientWidth, panelScroll: inspector.scrollWidth };
    });
    assert.ok(enlargedDimensions.scroll <= enlargedDimensions.width + 2 && enlargedDimensions.panelScroll <= enlargedDimensions.panelWidth + 1,
      `doubled graph text overflows at ${width}px: ${JSON.stringify(enlargedDimensions)}`);
    await captureGraphViewports(page, width, '-large-text');
    } finally { await typography.evaluate(session => session.restore()); await typography.dispose(); }

    const closedRead = {}; readBarrier = closedRead;
    await button.click(); await until(() => Boolean(closedRead.release));
    await details.locator(':scope > summary').click();
    assert.equal(await result.textContent(), '');
    await details.locator(':scope > summary').click(); closedRead.release();
    await page.waitForTimeout(50);
    assert.equal(await result.textContent(), ''); assert.equal(calls.length, 2, 'reopening never polls or revives abandoned results');
    assert.equal(await button.isEnabled(), true);

    const navigatedRead = {}; readBarrier = navigatedRead;
    await button.click(); await until(() => Boolean(navigatedRead.release));
    await navigate('ai-team'); navigatedRead.release();
    await navigate('overview'); await details.locator(':scope > summary').click();
    await page.waitForTimeout(50);
    assert.equal(await result.textContent(), ''); assert.equal(calls.length, 3, 'returning to Command never fetches or revives abandoned results');
    assert.equal(currentReads, readsBefore + 3); assert.equal(await button.isEnabled(), true);
    await page.evaluate(() => window.history.pushState({ fixture: true }, '', '?graph-browser-back-check'));
    const backRead = {}; readBarrier = backRead;
    await button.click(); await until(() => Boolean(backRead.release));
    await page.goBack(); backRead.release();
    await page.waitForTimeout(50);
    assert.equal(await result.textContent(), ''); assert.equal(await details.evaluate(element => element.open), false);
    assert.equal(calls.length, 4, 'browser Back abandons the snapshot without another read');
    assert.equal(currentReads, readsBefore + 4);
    assert.equal(apiCalls.filter(call => call.path === '/api/business-graph').length, 4);
    assert.deepEqual(unexpected, []); assert.equal(providerRequests, 0);
    assert.deepEqual(errors, []);
    await navigate('ai-team');
    const objectives = page.locator('.business-objectives-panel');
    await objectives.locator(':scope > summary').click();
    const form = page.locator('#business-objective-form');
    await form.locator('[name="title"]').fill(`Packaging goal ${width}`);
    await form.locator('[name="baseline"]').fill('100');
    await form.locator('[name="target"]').fill('125');
    await form.locator('[name="startsAt"]').fill(new Date(Date.now() - 60000).toISOString().slice(0, 16));
    await form.locator('[name="endsAt"]').fill(new Date(Date.now() + 86400000).toISOString().slice(0, 16));
    await form.locator('[name="maxMonthlyAdBudget"]').fill('0');
    await form.locator('button[type="submit"]').click();
    await page.locator('#business-objectives-list').getByText(`Packaging goal ${width}`, { exact: false }).waitFor();
    assert.equal(await page.locator('#business-objective-error').textContent(), '');
    const matching = page.locator('#business-objectives-list > div').filter({ hasText: `Packaging goal ${width}` });
    await matching.locator('[data-edit-objective]').click();
    await form.locator('[name="status"]').selectOption('paused');
    await form.locator('button[type="submit"]').click();
    await matching.getByText('Revenue · Paused', { exact: true }).waitFor();
    await matching.locator('[data-edit-objective]').click();
    await form.locator('[name="title"]').fill('Cancelled edit');
    await page.locator('#cancel-objective-edit').click();
    assert.equal(await form.locator('[name="title"]').inputValue(), '');
    const goalDimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
    assert.ok(goalDimensions.scroll <= goalDimensions.width + 2, `objective viewport overflow at ${width}px: ${JSON.stringify(goalDimensions)}`);
    assert.deepEqual(errors, []);
    await objectives.screenshot({ path: `/tmp/runvara-business-objectives-${width}.png` });
    assert.deepEqual(unexpected, []); assert.equal(providerRequests, 0);
    } finally {
      // An assertion may fail while a synthetic response is held. Release it
      // before closing the server, and always remove this scenario's state.
      readBarrier = null;
      pendingRead?.release();
      try { if (context) await context.close(); }
      finally {
        try { if (server?.listening) await new Promise(resolve => server.close(resolve)); }
        finally { await fs.rm(directory, { recursive: true, force: true }); }
      }
    }
  }
  assert.equal(currentReads, 12, 'twelve explicit graph inspections, no automatic current-head reads');
  assert.equal(providerRequests, 0, 'the server never used provider transport');
  const screenshots = await fs.readdir(os.tmpdir());
  for (const width of [320, 390, 1200]) {
    const files = screenshots.filter(name => name.startsWith(`runvara-business-graph-${width}-`) && name.endsWith('.png'));
    const sizes = await Promise.all(files.map(name => fs.stat(path.join(os.tmpdir(), name))));
    assert.ok(sizes.reduce((bytes, stat) => bytes + stat.size, 0) < 31 * 1024 * 1024, `graph ${width}px artifact group leaves room below the 32 MiB ZIP limit`);
  }
  console.log('Published manual/v2 references, saved request/approval inspection and objectives verified at 320, 390 and 1200 pixels. Normal interactions and separate exact 200% subtree scrolling source/control captures passed.');
} finally {
  if (browser) await browser.close();
}
