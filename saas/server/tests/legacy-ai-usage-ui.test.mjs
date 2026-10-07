// Real Fleet HTML and app code with synthetic local bootstrap/accounting only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';

const complete = (cost = 0, requests = 0) => ({ status: 'complete', reason: null, totals: { estimatedCostUsd: cost, requests }, byModel: [] });
function fleetFixture({ status = 'complete', cost = 0, requests = 0, usage = complete(), configured = true } = {}) {
  return {
    workspaces: [{ workspaceId: 'packsmart-solutions', name: 'Synthetic legacy workspace', aiUsageMonth: usage, plan: 'growth', subscriptionStatus: 'active', planMonthlyValueGbp: 79, planValueSource: 'indicative_list_price' }],
    totals: { workspaces: 1, aiUsageMonthStatus: status, aiEstimatedCostUsdMonth: cost, aiRequestsMonth: requests,
      aiUsageMonthCompleteWorkspaces: status === 'complete' ? 1 : 0, aiUsageMonthPartialWorkspaces: status === 'partial' ? 1 : 0, aiUsageMonthUnavailableWorkspaces: status === 'unavailable' ? 1 : 0, planMonthlyValueGbp: 79 },
    aiProviderConfigured: configured, worker: {}, modelCatalog: [{ model: 'fixture-model', provider: 'fixture-provider', tier: 'economy', pricingUpdatedAt: '2026-09-01', inputPerMillionUsd: 1, cachedInputPerMillionUsd: 0.1, outputPerMillionUsd: 2 }]
  };
}
async function until(condition) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Synthetic Fleet UI did not reach the expected state');
}
async function harness(t, fleet = fleetFixture(), { launchAdmin = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-legacy-usage-ui-'));
  const secret = 'legacy-usage-ui-test-only-secret-more-than-32-characters';
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
    PACKSMART_ADMIN_EMAIL: 'legacy-admin@example.test', SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' });
  const state = seedWorkspaceState({}, { workspaceId: 'packsmart-solutions', name: 'Synthetic legacy admin', email: 'legacy-admin@example.test', passwordHash: 'fixture-only' });
  state.products = [];
  await server.packsmart.store.save(state.workspace.id, state);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  let bootstrap;
  try {
    const response = await fetch(base + '/api/bootstrap', { headers: { Cookie: `packsmart_session=${token}` } });
    assert.equal(response.status, 200);
    bootstrap = await response.json(); bootstrap.launchAdmin = launchAdmin;
  } finally { await new Promise(resolve => server.close(resolve)); }
  const errors = [], calls = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8'), { url: base, runScripts: 'outside-only', virtualConsole, pretendToBeVisual: true });
  t.after(async () => { dom.window.close(); await fs.rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  const window = dom.window, document = window.document, h = { window, document, fleet, calls };
  window.Headers = Headers; window.AbortController = AbortController; window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.localStorage.setItem('packsmart-saas-cloud-migration-v3:packsmart-solutions', 'fixture-complete');
  window.RunvaraControl = { init() {}, render() {}, evidence() { return ''; }, history() { return ''; } };
  window.fetch = async (route, options = {}) => {
    calls.push({ route: String(route), method: options.method || 'GET' });
    if (route === '/api/auth/session') return Response.json({ user: bootstrap.user, workspace: bootstrap.workspace, csrf: bootstrap.csrf });
    if (route === '/api/bootstrap') return Response.json(bootstrap);
    if (route === '/api/operator/agent-ops') return h.rawFleetJson === undefined ? Response.json(h.fleet) : new Response(h.rawFleetJson, { headers: { 'Content-Type': 'application/json' } });
    if (route === '/api/auth/signup-options') return Response.json({ enabled: false });
    throw new Error(`Unexpected request in legacy usage fixture: ${route}`);
  };
  for (const file of ['presentation.js', 'app.js']) window.eval(await fs.readFile(new URL(`../../${file}`, import.meta.url), 'utf8'));
  await until(() => !document.querySelector('#app-shell').classList.contains('hidden'));
  h.open = async () => {
    document.querySelector('#main-nav [data-view="fleet"]').click();
    await until(() => document.querySelector('#fleet-kpis').children.length === 6);
  };
  h.refresh = async (next, rawJson) => {
    h.fleet = next; h.rawFleetJson = rawJson;
    const button = document.querySelector('#fleet-refresh'), before = calls.length;
    button.click();
    await until(() => !button.disabled && calls.length > before);
  };
  h.costKpi = () => document.querySelector('#fleet-kpis').children[4];
  h.economics = label => [...document.querySelectorAll('#fleet-economics-summary > div')].find(row => row.querySelector('span').textContent === label)?.querySelector('b').textContent;
  h.workspace = id => [...document.querySelectorAll('[data-fleet-workspace]')].find(row => row.dataset.fleetWorkspace === (id || 'packsmart-solutions'));
  h.workspaceCost = id => h.workspace(id).querySelector('.fleet-signal-grid').children[3].querySelector('b').textContent;
  h.workspaceRequests = id => h.workspace(id).querySelector('.fleet-ai-line').children[1].textContent;
  return h;
}

test('complete recorded zero stays known zero, with explicit legacy scope and truthful configuration/catalogue labels', async t => {
  const h = await harness(t); await h.open();
  assert.equal(h.costKpi().querySelector('strong').textContent, '$0.0000');
  assert.equal(h.document.querySelectorAll('#fleet-kpis .kpi-text-status').length, 0, 'known numeric amounts retain the numeric KPI typography');
  assert.deepEqual([...h.document.querySelectorAll('#fleet-kpis .kpi-monthly > span')].map(element => element.textContent), ['Legacy AI estimate · month', 'Plan value · month']);
  assert.equal(h.costKpi().querySelector('small').textContent, '0 recorded legacy requests');
  assert.equal(h.economics('Recorded legacy requests · month'), '0');
  assert.equal(h.economics('Recorded legacy cost estimate · USD'), '$0.0000');
  assert.equal(h.economics('Recorded ledger status'), 'Complete');
  assert.equal(h.economics('Snapshot usage coverage'), '1 complete · 0 incomplete · 0 unavailable');
  assert.equal(h.workspaceCost(), '$0.0000'); assert.match(h.workspaceRequests(), /^0 recorded legacy requests/);
  assert.equal(h.workspace().querySelectorAll('.kpi-text-status').length, 0, 'known workspace amounts keep numeric typography');
  assert.deepEqual([...h.workspace().querySelectorAll('.fleet-signal-monthly > span')].map(element => element.textContent), ['Legacy AI estimate · month', 'Plan value · month']);
  assert.equal(h.workspace().querySelector('[data-legacy-ai-usage-note]'), null);
  assert.equal(h.document.querySelector('#fleet-ai-provider-status').textContent, 'Provider configured');
  const fleetText = h.document.querySelector('#view-fleet').textContent;
  assert.match(fleetText, /not complete provider billing or all provider spend/);
  assert.match(fleetText, /workspaces in this snapshot, before the search filter/);
  assert.match(fleetText, /may not include every workspace/);
  assert.match(fleetText, /these scopes must not be added together/);
  assert.match(fleetText, /environment\/key setup only/);
  assert.match(fleetText, /Catalogue dated 2026-09-01/);
  assert.doesNotMatch(fleetText, /Provider metering ready|pricing checked|Measured tokens only/);
  assert.match(h.document.querySelector('#fleet-ai-capacity').textContent, /do not prove provider requests, metering coverage or spend/);
  assert.deepEqual(h.calls.filter(call => call.route.startsWith('/api/operator/')), [{ route: '/api/operator/agent-ops', method: 'GET' }]);
});

test('complete nonzero usage shows its estimate without combining any governed ledger scopes', async t => {
  const fleet = fleetFixture({ cost: 1.25, requests: 3, usage: complete(1.25, 3) });
  fleet.providerUsage = { scopes: [{ scopeKey: 'tenant', settled: { costMicros: 9000000, requests: 99 } }, { scopeKey: 'provider:openai', settled: { costMicros: 9000000, requests: 99 } }] };
  const h = await harness(t, fleet); await h.open();
  assert.equal(h.costKpi().querySelector('strong').textContent, '$1.25');
  assert.equal(h.costKpi().querySelector('strong').classList.contains('kpi-text-status'), false);
  assert.equal(h.workspaceCost(), '$1.25'); assert.match(h.workspaceRequests(), /^3 recorded legacy requests/);
  assert.equal(h.economics('Recorded legacy requests · month'), '3');
  assert.equal(h.economics('Monthly plan value'), '£79.00 GBP');
  assert.equal(h.document.querySelector('#fleet-provider-usage-result').textContent, '');
  assert.equal(h.calls.some(call => call.route.includes('provider-usage')), false);
});

test('partial and unavailable summaries withhold stale values at every Fleet cost/request location', async t => {
  const h = await harness(t, fleetFixture({ cost: 9, requests: 8, usage: complete(9, 8) })); await h.open();
  for (const [status, label, reason] of [
    ['partial', 'Incomplete', 'AI_USAGE_VOLATILE_STORE'],
    ['unavailable', 'Unavailable', 'AI_USAGE_READ_UNAVAILABLE']
  ]) {
    // Even stale numbers in an incomplete response must not become visible.
    await h.refresh(fleetFixture({ status, cost: 9, requests: 8, usage: { status, reason, totals: { estimatedCostUsd: 9, requests: 8 } }, configured: false }));
    assert.equal(h.costKpi().querySelector('strong').textContent, label);
    assert.equal(h.costKpi().querySelector('strong').classList.contains('kpi-text-status'), true);
    assert.equal(h.document.querySelectorAll('#fleet-kpis .kpi-text-status').length, 1, 'only the textual usage status receives text typography');
    assert.deepEqual([...h.document.querySelectorAll('#fleet-kpis .kpi-monthly > span')].map(element => element.textContent), ['Legacy AI estimate · month', 'Plan value · month'], 'monthly card layout is stable across incomplete and unavailable states');
    assert.equal(h.economics('Recorded legacy requests · month'), label);
    assert.equal(h.economics('Recorded legacy cost estimate · USD'), label);
    assert.equal(h.economics('Recorded ledger status'), label);
    assert.equal(h.workspaceCost(), label);
    assert.equal(h.workspace().querySelector('.fleet-signal-monthly > b').classList.contains('kpi-text-status'), true);
    assert.equal(h.workspace().querySelectorAll('.fleet-signal-monthly').length, 2, 'monthly workspace layout is independent of usage completeness');
    assert.match(h.workspaceRequests(), new RegExp(`^Legacy requests ${label.toLowerCase()}`));
    assert.doesNotMatch(h.costKpi().textContent + h.workspaceRequests(), /\$|\b[089] (?:recorded|metered|model)/);
    const note = h.workspace().querySelector('[data-legacy-ai-usage-note]').textContent;
    assert.match(note, status === 'partial' ? /process memory, which resets on restart/ : /could not be read/);
    assert.equal(h.document.querySelector('#fleet-ai-provider-status').textContent, 'Provider not configured');
  }
  await h.refresh(fleetFixture({ cost: 1.25, requests: 3, usage: complete(1.25, 3) }));
  assert.equal(h.costKpi().querySelector('strong').textContent, '$1.25');
  assert.equal(h.document.querySelectorAll('#fleet-kpis .kpi-text-status').length, 0, 'refreshing to complete restores numeric typography');
  assert.equal(h.document.querySelectorAll('#fleet-kpis .kpi-monthly').length, 2, 'complete monthly amounts retain the same monthly layout');
  assert.equal(h.workspace().querySelectorAll('.kpi-text-status').length, 0, 'complete workspace values restore numeric typography');
  assert.equal(h.workspace().querySelectorAll('.fleet-signal-monthly').length, 2);
});

test('mixed Fleet coverage hides its overall sum while retaining each complete workspace value', async t => {
  const fleet = fleetFixture({ status: 'partial', cost: null, requests: null, usage: complete(1.25, 3) });
  fleet.workspaces.push(
    { workspaceId: 'partial-tenant', name: 'Partial tenant', aiUsageMonth: { status: 'partial', reason: 'AI_USAGE_TRUNCATED', totals: null } },
    { workspaceId: 'missing-tenant', name: 'Missing tenant' }
  );
  Object.assign(fleet.totals, { workspaces: 3, aiUsageMonthCompleteWorkspaces: 1, aiUsageMonthPartialWorkspaces: 1, aiUsageMonthUnavailableWorkspaces: 1 });
  const h = await harness(t, fleet); await h.open();
  assert.equal(h.costKpi().querySelector('strong').textContent, 'Incomplete');
  assert.equal(h.economics('Snapshot usage coverage'), '1 complete · 1 incomplete · 1 unavailable');
  assert.equal(h.workspaceCost(), '$1.25');
  assert.equal(h.workspaceCost('partial-tenant'), 'Incomplete');
  assert.equal(h.workspaceCost('missing-tenant'), 'Unavailable');
  const filter = h.document.querySelector('#fleet-search'); filter.value = 'Synthetic'; filter.dispatchEvent(new h.window.Event('input'));
  assert.equal(h.document.querySelectorAll('[data-fleet-workspace]').length, 1);
  assert.equal(h.costKpi().querySelector('strong').textContent, 'Incomplete', 'filtering never promotes a partial fleet to complete');
  assert.equal(h.economics('Snapshot usage coverage'), '1 complete · 1 incomplete · 1 unavailable');
});

test('missing, unknown and malformed summaries never coerce null, strings, or omitted totals to zero', async t => {
  const h = await harness(t); await h.open();
  const cases = [undefined, { totals: { estimatedCostUsd: 0, requests: 0 } }, { status: 'unknown', totals: { estimatedCostUsd: 0, requests: 0 } },
    { status: 'complete', totals: null }, complete(null, 0), complete(0, null), complete('0', 0), complete(0, '0'), complete(-1, 0), complete(0, 0.5), complete(2 ** 26, 0), complete(Number.MAX_VALUE, 1)];
  for (const usage of cases) {
    const fleet = fleetFixture({ status: usage?.status, cost: usage?.totals?.estimatedCostUsd, requests: usage?.totals?.requests });
    fleet.workspaces[0].aiUsageMonth = usage;
    fleet.totals.aiUsageMonthStatus = usage?.status;
    fleet.totals.aiEstimatedCostUsdMonth = usage?.totals?.estimatedCostUsd;
    fleet.totals.aiRequestsMonth = usage?.totals?.requests;
    delete fleet.totals.aiUsageMonthCompleteWorkspaces;
    await h.refresh(fleet);
    assert.equal(h.costKpi().querySelector('strong').textContent, 'Unavailable');
    assert.equal(h.economics('Recorded legacy requests · month'), 'Unavailable');
    assert.equal(h.economics('Snapshot usage coverage'), 'Unavailable');
    assert.equal(h.workspaceCost(), 'Unavailable');
    assert.match(h.workspaceRequests(), /^Legacy requests unavailable/);
  }
});

test('negative-zero costs or requests in raw JSON are unavailable, not complete zero', async t => {
  const h = await harness(t); await h.open();
  for (const fields of [['estimatedCostUsd', 'aiEstimatedCostUsdMonth'], ['requests', 'aiRequestsMonth']]) {
    const fleet = fleetFixture();
    // JSON.stringify normalizes -0 to 0. A raw response verifies JSON.parse's
    // valid negative-zero number without silently changing the malformed input.
    let rawJson = JSON.stringify(fleet);
    for (const field of fields) rawJson = rawJson.replace(`"${field}":0`, `"${field}":-0`);
    await h.refresh(fleet, rawJson);
    assert.equal(h.costKpi().querySelector('strong').textContent, 'Unavailable');
    assert.equal(h.economics('Recorded legacy requests · month'), 'Unavailable');
    assert.equal(h.economics('Recorded legacy cost estimate · USD'), 'Unavailable');
    assert.equal(h.workspaceCost(), 'Unavailable');
    assert.match(h.workspaceRequests(), /^Legacy requests unavailable/);
  }
});

test('empty Fleet does not imply zero recorded spend, even with inconsistent complete totals', async t => {
  const fleet = fleetFixture(); fleet.workspaces = []; fleet.totals.workspaces = 0;
  const h = await harness(t, fleet); await h.open();
  assert.equal(h.costKpi().querySelector('strong').textContent, 'Unavailable');
  assert.equal(h.economics('Recorded legacy requests · month'), 'Unavailable');
  assert.equal(h.document.querySelectorAll('[data-fleet-workspace]').length, 0);
});

test('hostile labels are escaped and unknown reason strings never become HTML or raw error text', async t => {
  const hostile = '<img src=x onerror="window.legacyInjected=true">';
  const fleet = fleetFixture({ status: hostile, cost: hostile, requests: hostile, usage: { status: hostile, reason: hostile, totals: { estimatedCostUsd: hostile, requests: hostile } } });
  fleet.workspaces[0].name = hostile;
  fleet.modelCatalog[0] = { model: hostile, provider: hostile, tier: hostile, pricingUpdatedAt: hostile };
  fleet.totals.aiUsageMonthCompleteWorkspaces = hostile;
  const h = await harness(t, fleet); await h.open();
  const panel = h.document.querySelector('#view-fleet');
  assert.equal(panel.querySelectorAll('img,script,[onerror]').length, 0);
  assert.equal(h.window.legacyInjected, undefined);
  assert.equal(h.workspace().querySelector('h3').textContent, hostile);
  assert.match(h.document.querySelector('#fleet-model-catalog').textContent, /Catalogue dated <img/);
  assert.equal(h.costKpi().querySelector('strong').textContent, 'Unavailable');
  assert.equal(h.workspace().querySelector('[data-legacy-ai-usage-note]').textContent, 'A complete recorded legacy usage total is not available.');
  for (const reason of ['__proto__', 'constructor', { toString: null }]) {
    fleet.workspaces[0].aiUsageMonth = { status: 'partial', reason, totals: null };
    await h.refresh(fleet);
    assert.equal(h.workspace().querySelector('[data-legacy-ai-usage-note]').textContent, 'A complete recorded legacy usage total is not available.');
  }
});

test('non-admin navigation never fetches or exposes Fleet accounting', async t => {
  const h = await harness(t, fleetFixture(), { launchAdmin: false });
  assert.equal(h.document.querySelector('#operator-fleet-nav').classList.contains('hidden'), true);
  h.document.querySelector('#operator-fleet-nav').click();
  assert.equal(h.calls.some(call => call.route.startsWith('/api/operator/')), false);
  assert.equal(h.document.querySelector('#fleet-kpis').textContent, '');
});
