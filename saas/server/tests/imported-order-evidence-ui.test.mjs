// Real frontend, authenticated synthetic bootstrap, pure evidence projection. No provider calls.
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
import { projectImportedOrderEvidence } from '../lib/imported-order-evidence.mjs';

const period = { startAt: '2026-09-01T00:00:00Z', endAt: '2026-10-01T00:00:00Z' };
const costs = { landed: '30', supplierDelivery: '0', supplierVatRate: '0', supplierVatRecoverable: true, packing: '0', handling: '0', delivery: '0', paymentFee: '0', channelFee: '0', advertising: '0', otherVariable: '0' };
function order(id, fields = {}) {
  return { id, externalId: id, provider: 'shopify', name: id, currency: 'GBP', financialStatus: 'PAID', fulfillmentStatus: 'FULFILLED', createdAt: '2026-09-20T12:00:00Z', total: '100', currentTotal: '100', refunds: '0', tax: '0', currentTax: '0', discounts: '0', shippingCharged: '0', lineItems: [{ id: 'line-' + id, sku: 'COSTED', name: '<img src=x onerror=alert(1)>', quantity: '1', net: '100' }], ...fields };
}
function projection(orders, overrides = {}) {
  return projectImportedOrderEvidence({ workspace: { id: 'imported-ui' }, orders, economics: { COSTED: costs }, ...overrides }, { workspaceId: 'imported-ui', providers: ['shopify', 'ebay'], period });
}
function dto(evidence) {
  return { orders: evidence.counts.retainedOrders, openOrders: 0, revenue: null, operatingProfit: null, grossProfit: null, refunds: null, margin: null, profitCoverage: null,
    numericCostCoverage: { orderCoverage: { numerator: 1, denominator: 2 } }, importedOrderEvidence: evidence };
}
async function until(condition, diagnosis = () => '') {
  for (let i = 0; i < 200; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Imported evidence UI did not settle: ' + diagnosis());
}
async function harness(t, initialState = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-imported-ui-'));
  const secret = 'imported-order-ui-test-only-secret-more-than-32-characters';
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret, SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' });
  const state = seedWorkspaceState({}, { workspaceId: 'imported-ui', name: 'Synthetic evidence tenant', email: 'evidence@example.test', passwordHash: 'fixture-only' });
  state.products = [];
  Object.assign(state, initialState);
  await server.packsmart.store.save(state.workspace.id, state);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  let bootstrap;
  try { const response = await fetch(base + '/api/bootstrap', { headers: { Cookie: `packsmart_session=${token}` } }); assert.equal(response.status, 200); bootstrap = await response.json(); }
  finally { await new Promise(resolve => server.close(resolve)); }
  const errors = [], calls = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8'), { url: base, runScripts: 'outside-only', virtualConsole });
  t.after(async () => { dom.window.close(); await fs.rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  const window = dom.window, document = window.document, h = { window, document, bootstrap, calls, errors };
  window.Headers = Headers; window.AbortController = AbortController; window.scrollTo = () => {};
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.RunvaraControl = { init(api) { h.controls = api; }, render() {}, evidence() { return ''; }, history() { return ''; } };
  window.fetch = async (route, options = {}) => {
    calls.push({ route, method: options.method || 'GET', body: options.body });
    if (route === '/api/auth/session') return Response.json({ user: bootstrap.user, workspace: bootstrap.workspace, csrf: bootstrap.csrf });
    if (route === '/api/bootstrap') return Response.json(h.bootstrap);
    if (route === '/api/orders/costed/economics') return Response.json({ ok: true });
    throw new Error('Unexpected synthetic route: ' + route);
  };
  const rows = [
    order('costed'),
    order('uncosted', { total: '900', currentTotal: '900', refunds: null, lineItems: [{ id: 'u', sku: 'UNKNOWN', quantity: '1', net: '900' }] }),
    order('same-id', { provider: 'ebay', currency: 'USD', total: '99999999999999999999999.123456', currentTotal: '-1.000001' }),
    order('pending', { financialStatus: 'PENDING', cancelledAt: '2026-09-21T00:00:00Z', currency: 'ZZZ', currentTotal: '0' }),
    order('unknown', { currency: null, currentTotal: '30' })
  ];
  h.rows = rows;
  const evidence = projection(rows), month = dto(evidence);
  bootstrap.dashboard = { ...bootstrap.dashboard, today: month, last7d: month, last30d: month, revenueSignals: { daily: [], period: month, comparisons: { 30: { current: month, previous: null, change: null } } }, orderProfitability: rows.map(row => ({ ...row, profitability: { importedOrderEvidence: projection([row]) } })), productRows: [{ productTitle: 'Catalogue item', title: 'Variant', sku: 'COSTED', productStatus: 'active', price: 55, inventory: 3, units30d: 999, revenue30d: 999, contribution: 25, margin: 45.45, totalVariableCost: 30, status: 'profitable' }] };
  bootstrap.economics = { COSTED: costs };
  bootstrap.integrations = [{ id: 'shopify', name: '<img src=x onerror=alert(1)>', kind: 'commerce', status: 'connected', metrics30d: dto(projection(rows.filter(row => row.provider === 'shopify'))) }, { id: 'ebay', name: 'eBay', kind: 'marketplace', status: 'connected', metrics30d: dto(projection(rows.filter(row => row.provider === 'ebay'))) }];
  bootstrap.advertisingCosts = [{ id: 'raw-ad', date: '2026-09-20', channel: '<img src=x onerror=alert(1)>', currency: 'USD', spend: '9007199254740993.123456', attributableRevenue: '9999999999999999.999999' }];
  bootstrap.revenueEngine.customers = { summary: { customers: 2, repeatRate: 50, reorderDue: 1, churnRisk: 0, dormant: 0, totalRevenue: 500, knownContribution: 300 }, customers: [{ privacyLabel: 'Customer A', segment: 'repeat', orderCount: 2, daysSinceLastOrder: 4, revenue: 500 }] };
  bootstrap.revenueEngine.baskets = { pairs: [{ a: 'A', b: 'B', ordersTogether: 2, affinity: 50 }] };
  bootstrap.revenueEngine.attribution = { coverage: { orders: 5, sourceCoveragePercent: 99, sourceAttributedOrders: 5, recordedSourceCoveragePercent: 40, recordedSourceOrders: 2 } };
  for (const file of ['presentation.js', 'app.js']) window.eval(await fs.readFile(new URL(`../../${file}`, import.meta.url), 'utf8'));
  await until(() => !document.querySelector('#app-shell').classList.contains('hidden'), () => document.querySelector('#startup-error').textContent);
  return h;
}

test('imported evidence keeps exact currency/status/cancellation cohorts and distinguishes partial, zero, unknown and cost fractions', async t => {
  const h = await harness(t), root = h.document.querySelector('#revenue-trajectory');
  assert.equal(root.querySelector('svg'), null);
  assert.equal(root.querySelectorAll('tbody > tr').length, 4);
  const rows = [...root.querySelectorAll('tbody > tr')];
  const gbp = rows.find(row => row.cells[1].textContent.startsWith('GBP'));
  assert.match(gbp.textContent, /1000/);
  assert.match(gbp.cells[6].textContent, /0Known subtotal · 1 known \/ 1 unknown/);
  assert.match(gbp.cells[6].textContent, /Complete retained cohort: Unavailable/);
  assert.match(gbp.textContent, /Exact numeric cost \/ net amount coverage100 \/ 1000/);
  assert.match(gbp.cells[7].textContent, /1 \/ 2 retained orders/);
  const usd = rows.find(row => row.cells[1].textContent.startsWith('USD'));
  assert.match(usd.textContent, /99999999999999999999999\.123456/);
  assert.match(usd.cells[5].textContent, /-1\.000001/);
  const zzz = rows.find(row => row.cells[1].textContent.startsWith('ZZZ'));
  assert.equal(zzz.cells[2].textContent, 'PENDING');
  assert.equal(zzz.cells[3].textContent, 'Cancelled');
  assert.equal(zzz.cells[5].querySelector('strong').textContent, '0');
  const unknown = rows.find(row => row.cells[1].textContent.startsWith('Unknown'));
  assert.equal(unknown.cells[5].querySelector('strong').textContent, 'Unknown');
  assert.match(unknown.cells[5].textContent, /1 known \/ 0 unknown/);
  assert.match(root.textContent, /Source period unverified/);
  assert.match(root.textContent, /not verified business revenue, profit or collected cash/);
  assert.doesNotMatch(root.textContent, /£|\$|70%|£70|1e\+/);
  assert.equal(h.document.querySelector('[onerror]'), null);
  for (const id of ['today-revenue', 'today-profit', 'today-margin', 'hg-coverage', 'analytics-revenue', 'analytics-profit', 'analytics-margin', 'analytics-ad-spend', 'analytics-roas', 'orders-profit', 'orders-profit-coverage']) assert.equal(h.document.getElementById(id).textContent, 'Unavailable', id);
  assert.equal(h.document.getElementById('re-attribution').textContent, '40.0%');
  assert.match(h.document.getElementById('re-attribution-list').textContent, /Orders with a recorded source2/);
  assert.match(h.document.getElementById('re-customers-list').textContent, /2 retained orders/);
  assert.doesNotMatch(h.document.getElementById('re-customers-list').textContent, /500|£/);
  assert.match(h.document.getElementById('re-baskets').textContent, /retained orders together · recorded SKU association only/);
  const marketing = h.document.getElementById('analytics-marketing');
  assert.match(marketing.textContent, /9007199254740993\.123456/);
  assert.match(marketing.textContent, /9999999999999999\.999999/);
  assert.match(marketing.textContent, /USD · unverified recorded code/);
  assert.doesNotMatch(marketing.textContent, /£|\$|×/);
  assert.equal(h.document.querySelector('#product-sort [value="revenue-desc"]'), null);
  assert.equal(h.document.querySelector('#product-sort [value="units-desc"]'), null);
  assert.match(h.document.getElementById('economics-body').textContent, /sales and stock cover unavailable/);
  assert.match(h.document.getElementById('economics-body').textContent, /£55\.00/,'catalogue economics remains separate');
  assert.equal(h.calls.every(call => call.method === 'GET'), true);
});

test('Command keeps owner-result boundaries beside imported evidence disclosures after a bootstrap refresh', async t => {
  const h = await harness(t);
  h.bootstrap.hypergrowth.impact = { ...h.bootstrap.hypergrowth.impact,
    verified: { verifiedValue: 990001, hoursSaved: 99 }, roi: { multiple: 990 },
    legacy: { recordedEvents: 7, reviewedEvents: 3 } };
  await h.controls.reload({ migrate: false });
  const text = id => h.document.getElementById(id).textContent;
  assert.equal(text('hypergrowth-title'), 'Next actions. Measured evidence.');
  assert.equal(text('hg-value'), '—');
  assert.equal(text('hg-hours'), '—');
  assert.equal(h.document.getElementById('hg-value').previousElementSibling.textContent, 'Unscoped value');
  assert.match(h.document.getElementById('hg-value').nextElementSibling.textContent, /Business results.*exact currency and window/);
  assert.equal(text('hypergrowth-evidence-badge'), '7 legacy records · unqualified');
  assert.equal(text('hg-coverage'), 'Unavailable');
  assert.match(text('hg-coverage-note'), /Historical cost, currency and tax basis unverified/);
  assert.match(text('revenue-trajectory'), /Source period unverified/);
  assert.match(text('revenue-trajectory'), /GBP.*unverified recorded code/s);
  assert.match(text('revenue-trajectory'), /USD.*unverified recorded code/s);
  assert.doesNotMatch(text('view-overview'), /990001|990,001|99\.0h|990x/);
  assert.equal(h.document.querySelectorAll('#business-outcomes-panel').length, 1);
  assert.equal(h.document.querySelectorAll('#workspace-activity-panel').length, 1);
  assert.ok(h.calls.every(call => call.method === 'GET'), 'rendering never creates outcome or activity writes');
});

test('evidence stays concise at rest while disclosures preserve provenance and exact recorded groups', async t => {
  const h = await harness(t), document = h.document;
  for (const id of ['revenue-trajectory', 'analytics-channel-table']) {
    const root = document.getElementById(id), provenance = root.querySelector(':scope > .imported-evidence-provenance');
    assert.ok(provenance);
    assert.equal(provenance.open, false);
    assert.match(root.querySelector(':scope > .imported-evidence-warning').textContent, /not verified business revenue, profit or collected cash\. Source period unverified/);
    assert.match(root.querySelector(':scope > .signal-note').textContent, /Retained orders: 5/);
    assert.match(provenance.textContent, /2026-09-01T00:00:00\.000Z \(inclusive\) to 2026-10-01T00:00:00\.000Z \(exclusive\)/);
    assert.match(provenance.textContent, /importer defaults or derived values/);
    assert.match(provenance.textContent, /Currency recognition and source currency are unverified/);
    assert.match(provenance.textContent, /Scan complete · Output complete · Eligibility resolved/);
    assert.match(provenance.textContent, /historical cost assignment/);
    assert.match(provenance.textContent, /Source-period coverage is unverified for every provider/);
    assert.deepEqual([...provenance.querySelectorAll('li')].map(item => item.textContent), ['Ebay', 'Shopify']);
  }
  const command = document.querySelector('#revenue-trajectory > .imported-evidence-cohorts');
  assert.equal(command.open, false);
  assert.equal(command.querySelectorAll('tbody tr').length, 4);
  assert.equal(document.querySelector('#analytics-channel-table > .table-wrap tbody').rows.length, 4);
  assert.equal(document.querySelector('#analytics-channel-table').closest('.card').parentElement.id, 'view-analytics', 'cohorts have the full Analytics row');
  const providers = document.querySelector('.analytics-providers-card');
  assert.equal(providers.querySelectorAll('.source-row small').length, 0, 'provider rows share one coverage explanation');
  assert.equal((providers.textContent.match(/Source-period coverage is unverified/g) || []).length, 1);
  assert.match(providers.textContent, /No retained records does not establish zero sales/);
  h.bootstrap.integrations[0].metrics30d.orders = null;
  h.bootstrap.integrations[1].metrics30d.orders = 0;
  await h.controls.reload({ migrate: false });
  assert.deepEqual([...document.querySelectorAll('#analytics-source-mix strong')].map(item => item.textContent), ['Unknown retained orders', '0 retained orders']);
});

test('missing, empty and incomplete projections never fabricate monetary zero or complete financial periods', async t => {
  const h = await harness(t);
  for (const evidence of [null, projection([]), projection(h.rows, { orders: [...h.rows, { provider: 'shopify', currency: 'GBP' }] })]) {
    const month = evidence ? dto(evidence) : { orders: null, openOrders: null, importedOrderEvidence: null };
    h.bootstrap.dashboard.today = month; h.bootstrap.dashboard.last30d = month; h.bootstrap.dashboard.revenueSignals = { period: month, daily: [] };
    await h.controls.reload({ migrate: false });
    const root = h.document.getElementById('revenue-trajectory');
    assert.doesNotMatch(root.textContent, /£0|\$0|0%|settled orders/i);
    assert.equal(h.document.getElementById('today-revenue').textContent, 'Unavailable');
    if (!evidence) { assert.match(root.textContent, /evidence unavailable/); assert.equal(h.document.getElementById('today-orders').textContent, 'Unknown'); }
    else if (!evidence.groups.length) assert.match(root.textContent, /does not establish zero sales/);
    else { assert.match(root.querySelector(':scope > .signal-note').textContent, /Eligibility unresolved/); assert.doesNotMatch(root.textContent, /Complete retained cohort: (?:1000|100|0)(?:\D|$)/); }
  }
});

test('eBay retained-order diagnostics stay independent of capped editor rows and preserve unknown counts', async t => {
  const orders = [...Array.from({ length: 100 }, (_, index) => order(`shopify-${index}`, { createdAt: '2026-10-06T12:00:00Z' })),
    order('ebay-older', { provider: 'ebay' })];
  const h = await harness(t, { orders, ebay: { account: 'Synthetic eBay account', listings: [], coverage: {} } });
  assert.equal(h.bootstrap.orders.length, 100);
  assert.equal(h.bootstrap.orders.filter(item => item.provider === 'ebay').length, 0);
  assert.equal(h.bootstrap.orderDetailCoverage.truncated, true);
  const channel = h.bootstrap.connectionCentre.find(item => item.id === 'ebay');
  assert.equal(channel.counts.orders, 1);
  const displayedCount = () => [...h.document.querySelectorAll('#ebay-health > div')]
    .find(row => row.querySelector('span').textContent === 'Recorded orders').querySelector('b').textContent;
  assert.equal(displayedCount(), '1');
  for (const [count, expected] of [[null, 'Unknown'], [undefined, 'Unknown'], [0, '0']]) {
    channel.counts.orders = count;
    await h.controls.reload({ migrate: false });
    assert.equal(displayedCount(), expected);
  }
});

test('raw order costs remain editable without money inference and navigation adds no evidence requests', async t => {
  const h = await harness(t), document = h.document;
  const card = document.querySelector('[data-order-id="costed"]');
  assert.ok(card);
  assert.match(card.textContent, /Profit unavailable/);
  assert.match(card.textContent, /Cost currency, tax treatment and historical assignment are unverified/);
  assert.match(card.textContent, /recorded quantity 1/);
  assert.doesNotMatch(card.textContent, /£|\$|Gross profit/);
  const before = h.calls.length;
  for (const view of ['orders', 'analytics', 'revenue-engine', 'profit', 'overview']) document.querySelector('#main-nav [data-view="' + view + '"]').click();
  card.open = true; card.open = false; card.open = true;
  assert.equal(h.calls.length, before);
  card.querySelector('[data-field="actualShippingCost"]').value = '0';
  card.querySelector('[data-field="paymentFees"]').value = '';
  card.querySelector('.save-order-costs').click();
  await until(() => document.getElementById('global-success').textContent.startsWith('Recorded order costs saved.'));
  const writes = h.calls.filter(call => call.method !== 'GET');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].route, '/api/orders/costed/economics');
  assert.equal(JSON.parse(writes[0].body).actualShippingCost, '0');
  assert.equal(JSON.parse(writes[0].body).paymentFees, '');
  assert.match(document.getElementById('global-success').textContent, /Financial qualification remains unavailable/);
});

test('bounded presentations and shared period references retain provider scope and disclose clipped evidence', async t => {
  const h = await harness(t);
  const evidence = projection(h.rows);
  evidence.presentation = { groupLimit: 1, groupsAvailable: evidence.groups.length, groupsReturned: 1, truncated: true, skuGroupsAvailable: 4, skuGroupsReturned: 1 };
  evidence.groups = evidence.groups.filter(group => group.currency === 'GBP');
  const month = dto(evidence);
  h.bootstrap.dashboard.last30d = month;
  h.bootstrap.dashboard.revenueSignals = { periodRef: 'last30d', daily: [] };
  h.bootstrap.integrations[0].metrics30d = { orders: 4, importedOrderEvidence: null, evidenceRef: { period: 'last30d', provider: 'shopify' } };
  h.bootstrap.integrations[1].metrics30d = { orders: 1, importedOrderEvidence: null, evidenceRef: { period: 'last30d', provider: 'ebay' } };
  h.bootstrap.dashboard.orderDetailCoverage = { returned: 5, available: 150, truncated: true };
  await h.controls.reload({ migrate: false });
  const root = h.document.getElementById('revenue-trajectory');
  assert.match(root.textContent, /Partial grouped view: 1 of 4 period groups returned/);
  assert.match(root.querySelector(':scope > .missing-inputs').textContent, /Partial grouped view/);
  assert.match(root.textContent, /Complete retained cohort: Unavailable/);
  assert.doesNotMatch(root.textContent, /Complete retained cohort: 1000/);
  assert.match(root.textContent, /Exact numeric cost \/ net amount coverageUnavailable/);
  const channels = h.document.querySelectorAll('#revenue-chart > details');
  assert.match(channels[0].textContent, /GBP · unverified recorded code/);
  assert.equal(channels[1].querySelectorAll('tbody tr').length, 0, 'a clipped eBay group cannot borrow a Shopify amount');
  assert.match(channels[1].textContent, /Partial grouped view/);
  assert.match(h.document.getElementById('order-list').textContent, /Partial order-detail view/);
  evidence.completeness.truncated.orders = true;
  evidence.completeness.scanComplete = false;
  evidence.completeness.retainedCohortComplete = false;
  await h.controls.reload({ migrate: false });
  assert.match(root.textContent, /Bounded projection truncated: Orders/);
  assert.match([...root.querySelectorAll(':scope > .missing-inputs')].map(item => item.textContent).join(' '), /Bounded projection truncated: Orders/);
  assert.match(root.querySelector(':scope > .signal-note').textContent, /Scan incomplete/);
  assert.match(root.textContent, /Known subtotals describe only the scanned subset/);
  assert.equal(h.calls.every(call => call.method === 'GET'), true);
});


test('order filters use reconciled refund, cancellation and fulfilment evidence; unavailable counts stay unknown', async t => {
  const h = await harness(t), document = h.document;
  const rows = [order('open', { fulfillmentStatus: 'UNFULFILLED' }),
    order('cancelled', { fulfillmentStatus: 'UNFULFILLED', cancelledAt: false }),
    order('unknown-fulfillment', { fulfillmentStatus: null }),
    order('paid-refund', { fulfillmentStatus: 'FULFILLED', refunds: '1', currentTotal: '99' })];
  h.bootstrap.dashboard.orderProfitability = rows.map(row => ({ ...row, profitability: { importedOrderEvidence: projection([row]) } }));
  h.bootstrap.dashboard.customerServiceIssues = null;
  await h.controls.reload({ migrate: false });
  assert.match(document.getElementById('control-status').textContent, /Recorded customer-service issuesUnknown/);
  const filter = document.getElementById('order-filter');
  filter.value = 'open'; filter.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.deepEqual([...document.querySelectorAll('#order-list [data-order-id]')].map(row => row.dataset.orderId), ['open']);
  filter.value = 'refunded'; filter.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.deepEqual([...document.querySelectorAll('#order-list [data-order-id]')].map(row => row.dataset.orderId), ['paid-refund']);
  filter.value = 'all'; filter.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  assert.match(document.querySelector('[data-order-id="cancelled"]').textContent, /Cancelled/);
});
