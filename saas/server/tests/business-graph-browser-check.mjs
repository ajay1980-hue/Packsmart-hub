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
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { createBusinessOutcomeCandidate, withdrawBusinessOutcomeCandidate } from '../lib/business-outcomes.mjs';
import { createBusinessOutcomePersistence } from '../lib/business-outcome-store.mjs';

async function graphTypography(page) {
  return page.locator('#business-graph-result section.status-list').evaluateAll(sections => sections.flatMap(section =>
    [...section.children].map(row => {
      const label = row.querySelector('span'), value = row.querySelector('b');
      const measure = element => {
        const style = getComputedStyle(element), range = document.createRange(), bounds = element.getBoundingClientRect();
        range.selectNodeContents(element);
        const textRects = [...range.getClientRects()].filter(rect => rect.width && rect.height);
        const rowBounds = row.getBoundingClientRect();
        return { text: element.textContent, fontSize: parseFloat(style.fontSize), whiteSpace: style.whiteSpace,
          overflowX: style.overflowX, overflowY: style.overflowY, textOverflow: style.textOverflow,
          lineCount: new Set(textRects.map(rect => Math.round(rect.top * 100) / 100)).size,
          width: element.clientWidth, scrollWidth: element.scrollWidth, height: element.clientHeight, scrollHeight: element.scrollHeight,
          textInside: textRects.every(rect => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 &&
            rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1),
          insideRow: bounds.left >= rowBounds.left - 1 && bounds.right <= rowBounds.right + 1 &&
            bounds.top >= rowBounds.top - 1 && bounds.bottom <= rowBounds.bottom + 1 };
      };
      return { label: measure(label), value: measure(value) };
    })));
}

function assertReadableRows(rows, width, { doubled = false } = {}) {
  assert.ok(rows.length > 0, 'expanded measurement, result and snapshot rows were inspected');
  for (const row of rows) for (const item of [row.label, row.value]) {
    const context = `${width}px${doubled ? ' doubled text' : ''}: ${JSON.stringify(row)}`;
    assert.ok(item.fontSize >= (doubled ? 28 : 14), 'nested evidence text stays readable: ' + context);
    assert.notEqual(item.whiteSpace, 'nowrap', 'larger text must be allowed to wrap: ' + context);
    assert.ok(!['hidden', 'clip'].includes(item.overflowX) && !['hidden', 'clip'].includes(item.overflowY), 'text cannot be clipped: ' + context);
    assert.notEqual(item.textOverflow, 'ellipsis', 'exact evidence cannot be shortened: ' + context);
    assert.ok(item.width + 1 >= item.scrollWidth && item.height + 1 >= item.scrollHeight, 'text fits its full visible box: ' + context);
    assert.ok(item.textInside && item.insideRow, 'all text remains inside its visible row: ' + context);
  }
}

const NOW = '2026-10-07T12:00:00.000Z', WORKSPACE = 'graph-preview';
const digest = value => createHash('sha256').update(value).digest('hex');
function publication(index, { experimentId, amount, currency = 'GBP', withdrawn = false }) {
  const measurementDigest = digest('browser_measurement_' + index);
  let version = createBusinessOutcomeCandidate({
    source: { type: 'experiment_measurement', experimentId, measurementRevision: 1, measurementDigest },
    metric: 'incrementalContribution', amount, currency,
    window: { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' },
    coverage: { status: 'complete', scopeId: 'browser_scope_' + index, observedCount: 10, expectedCount: 10 },
    method: { kind: 'reconciled_manual', definitionVersion: 'incremental-contribution/v1' },
    provenance: { observationId: 'browser_observation_' + index, sourceRefs: [{ type: 'measurement_report', id: 'browser_report_' + index, digest: digest('browser_report_' + index) }],
      observedAt: '2026-10-06T12:00:00.000Z', aggregation: 'non_overlapping_scopes_attested' },
    verification: { kind: 'owner_attestation', actorId: 'browser_fixture_owner', verifiedAt: '2026-10-06T14:00:00.000Z', measurementDigest }
  }, { workspaceId: WORKSPACE, now: NOW });
  if (withdrawn) version = withdrawBusinessOutcomeCandidate(version, { reason: 'incorrect_measurement', verification: {
    ...version.verification, verifiedAt: '2026-10-06T18:00:00.000Z' } }, { workspaceId: WORKSPACE, now: NOW });
  const row = { workspace_id: WORKSPACE, outcome_id: version.outcomeId, revision: version.revision, version_id: version.versionId,
    digest: version.digest, status: version.status, payload: version, publication_id: 'browser_publication_' + index,
    intent_digest: digest('browser_intent_' + index), committed_at: '2026-10-06T19:00:00+00:00', commit_revision: 'browser_fixture_revision' };
  return { workspace_id: WORKSPACE, outcome_id: version.outcomeId, version_id: version.versionId, version: row };
}
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-graph-browser-'));
const secret = 'graph-browser-test-only-secret-more-than-32-characters';
const server = createPacksmartServer({ NODE_ENV: 'test', APP_PUBLIC_URL: 'http://127.0.0.1:18787', SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
  SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' });
let browser, currentReads = 0, readBarrier = null;
try {
  const state = seedWorkspaceState({}, { workspaceId: WORKSPACE, name: 'Graph preview', email: 'preview@example.test', passwordHash: 'fixture-only' });
  state.products = [{ id: 'p1', provider: 'shopify', title: 'Packaging evidence fixture', status: 'active', variants: [{ id: 'v1', sku: 'PS-1', price: 10, inventory: 3, available: true }] }];
  state.revenueEngine.experiments = [
    { id: 'browser_experiment_one', status: 'completed', impact: { verified: true, incrementalContribution: 500 } },
    { id: 'browser_experiment_two', status: 'completed' },
    { id: 'browser_long_experiment_one', status: 'completed' },
    { id: 'browser_long_experiment_two', status: 'completed' }
  ];
  const rows = [publication(1, { experimentId: 'browser_experiment_one', amount: '-12.340001' }),
    publication(2, { experimentId: 'browser_archived_experiment', amount: '0', currency: 'USD' }),
    publication(3, { experimentId: 'browser_experiment_two', amount: '99', withdrawn: true }),
    publication(4, { experimentId: 'browser_long_experiment_one', amount: '999999999999999999.123456', currency: 'EUR' }),
    publication(5, { experimentId: 'browser_long_experiment_two', amount: '1', currency: 'EUR' })];
  const persistence = createBusinessOutcomePersistence({ now: () => new Date(NOW), request: async (route, options) => {
    currentReads++;
    assert.ok(route.startsWith('runvara_business_outcome_heads?workspace_id=eq.graph-preview&'));
    assert.ok(route.endsWith('&order=outcome_id.asc&limit=51')); assert.equal(options.includeResponseMetadata, true);
    assert.doesNotMatch(route, /source_measurement|source_action/); assert.equal(options.method || 'GET', 'GET');
    if (readBarrier) { const barrier = readBarrier; readBarrier = null; await new Promise(resolve => { barrier.release = resolve; }); }
    return { data: structuredClone(rows), contentRange: '0-4/5' };
  } });
  server.packsmart.store.businessOutcomeSummary = workspaceId => persistence.current(workspaceId);
  await server.packsmart.store.save(state.workspace.id, state);
  server.listen(18787, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const until = async condition => {
    for (let attempt = 0; attempt < 200; attempt++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail('Synthetic current-head request did not reach expected state');
  };
  for (const width of [320, 390, 1200]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addCookies([{ name: 'packsmart_session', value: token, url: base, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage(), errors = [], calls = [], readsBefore = currentReads;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
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
    await button.evaluate(element => { element.click(); element.click(); });
    await result.getByText('Complete current-result read', { exact: true }).waitFor();
    assert.equal(calls.length, 1); assert.equal(currentReads, readsBefore + 1, 'one explicit request reads one current-head snapshot');
    assert.equal(new URL(calls[0]).search, '?outcomes=current');
    assert.match(await result.textContent(), /Published results loaded4/); assert.match(await result.textContent(), /Withdrawn results loaded1/);
    assert.match(await result.textContent(), /-12.340001/); assert.match(await result.textContent(), /GBP/); assert.match(await result.textContent(), /USD/);
    assert.match(await result.textContent(), /Exact scoped amount0/); assert.match(await result.textContent(), /2026-10-01T00:00:00.000Z/);
    assert.match(await result.textContent(), /2026-10-06T00:00:00.000Z/); assert.match(await result.textContent(), /independent, not atomic or synchronized/);
    assert.match(await result.textContent(), /Full lifetime coverage is not claimed/); assert.match(await result.textContent(), /Unresolved reason/);
    assert.equal(await page.locator('#hg-value').textContent(), '—'); assert.equal(await page.locator('#hg-hours').textContent(), '—');
    assert.match(await page.locator('#hg-learning').textContent(), /do not establish qualified learning priors/);
    const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
    assert.ok(dimensions.scroll <= dimensions.width + 2, `graph viewport overflow at ${width}px: ${JSON.stringify(dimensions)}`);
    assert.deepEqual(errors, []);
    // Expand each existing evidence block so actual result, amount and snapshot
    // typography is checked, including long opaque version/snapshot references.
    await result.locator('details').evaluateAll(elements => elements.forEach(element => { element.open = true; }));
    const normal = await graphTypography(page);
    assertReadableRows(normal, width);
    const ordinaryAmounts = normal.filter(row => row.label.text === 'Exact scoped amount' && ['-12.340001', '0'].includes(row.value.text));
    assert.equal(ordinaryAmounts.length, 2, 'ordinary exact amounts are present unchanged');
    const timestamps = normal.filter(row => /^(Observation window|Workspace read completed|Outcome read completed)/.test(row.label.text));
    assert.equal(timestamps.length, 8, 'three exact observation windows and both independent snapshot times are visible');
    for (const row of [...ordinaryAmounts, ...timestamps]) assert.equal(row.value.lineCount, 1, `ordinary exact evidence stays on one line at ${width}px: ${JSON.stringify(row)}`);
    const longAmount = normal.find(row => row.label.text === 'Exact scoped amount' && row.value.text === '1000000000000000000.123456');
    assert.ok(longAmount, 'a grouped exact amount longer than one candidate amount is preserved');
    await details.screenshot({ path: `/tmp/runvara-business-graph-${width}.png` });

    // Double the rendered labels and values, matching a larger-text preference
    // without changing unrelated app typography. Natural wrapping is expected.
    await result.locator('section.status-list > div > span, section.status-list > div > b').evaluateAll(elements => {
      for (const element of elements) {
        element.dataset.normalFontSize = element.style.fontSize;
        element.style.fontSize = `${parseFloat(getComputedStyle(element).fontSize) * 2}px`;
      }
    });
    const doubled = await graphTypography(page);
    assertReadableRows(doubled, width, { doubled: true });
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
    await details.screenshot({ path: `/tmp/runvara-business-graph-large-text-${width}.png` });
    await result.locator('section.status-list > div > span, section.status-list > div > b').evaluateAll(elements => {
      for (const element of elements) { element.style.fontSize = element.dataset.normalFontSize; delete element.dataset.normalFontSize; }
    });

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
    await context.close();
  }
  assert.equal(currentReads, 9, 'nine explicit graph inspections, no automatic current-head reads');
  console.log('Reviewed outcomes, business graph and objectives browser verification passed at 320, 390 and 1200 pixels.');
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
