// Real frontend and retained-catalogue projection; synthetic local file store only.
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
import { deriveOperations } from '../lib/operations.mjs';

const clone = structuredClone;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = body => ({ ok: true, status: 200, json: async () => body });
const product = (id, status = 'active', fields = {}) => ({ id, status, title: 'Synthetic catalogue item ' + id, description: '', image: 'fixture.png', variants: [], ...fields });
let fixturePromise;
async function fixture() {
  if (!fixturePromise) fixturePromise = (async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-seo-ui-'));
    const secret = 'seo-review-test-only-secret-more-than-thirty-two-characters';
    const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret, SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' },
      { schedulerEnabled: false, agentOpsEnabled: false, fetchImpl: async () => { assert.fail('SEO review must not call a provider'); } });
    try {
      const state = seedWorkspaceState({}, { workspaceId: 'seo-ui', name: 'Synthetic SEO review', email: 'seo@example.test', passwordHash: 'fixture-only' });
      state.products = []; state.orders = [];
      await server.packsmart.store.save(state.workspace.id, state);
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
      const result = await fetch(`http://127.0.0.1:${server.address().port}/api/bootstrap`, { headers: { Cookie: `packsmart_session=${token}` } });
      assert.equal(result.status, 200);
      return { state, bootstrap: await result.json() };
    } finally {
      if (server.listening) await new Promise(resolve => server.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    }
  })();
  return clone(await fixturePromise);
}
async function until(check, label = 'SEO UI') {
  for (let i = 0; i < 150; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(label + ' did not settle');
}
async function harness(t, products = [product('active'), product('unknown', 'pending'), product('unlisted', 'unlisted'), product('draft', 'draft'), product('archived', 'archived')]) {
  const { state, bootstrap } = await fixture();
  state.products = products; bootstrap.products = products; bootstrap.dashboard = { ...bootstrap.dashboard, ...deriveOperations(state) };
  // Existing non-SEO lists must remain independent of the new classification.
  Object.assign(bootstrap.dashboard, {
    customerServiceItems: [{ id: 'order-1', name: 'Recorded open order', financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED', createdAt: '2026-10-01T12:00:00Z' }],
    stockRiskItems: [{ productTitle: 'Recorded low stock', sku: 'STOCK', inventory: 2 }],
    missingCostItems: [{ productTitle: 'Recorded missing cost', sku: 'COST', missingFields: ['landed'] }]
  });
  const errors = [], calls = [], console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8'), { url: 'https://seo.example.test', runScripts: 'outside-only', virtualConsole: console, pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  const h = { w, d, calls, bootstrap, state, session: { user: clone(bootstrap.user), workspace: clone(bootstrap.workspace), csrf: bootstrap.csrf } };
  t.after(() => { dom.window.close(); assert.deepEqual(errors, []); });
  w.Headers = Headers; w.AbortController = AbortController; w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  w.RunvaraControl = { init(api) { h.controls = api; }, render() {}, evidence() { return ''; }, history() { return ''; } };
  h.readBootstrap = async () => response(clone(h.bootstrap));
  h.logout = async () => response({ ok: true });
  w.fetch = async (route, options = {}) => {
    calls.push({ route, method: options.method || 'GET' });
    if (route === '/api/auth/session' || route === '/api/auth/login') return response(h.session);
    if (route === '/api/bootstrap') return h.readBootstrap();
    if (route === '/api/auth/logout') return h.logout();
    if (route === '/api/auth/signup-options') return response({ enabled: false });
    throw new Error('Unexpected synthetic SEO route: ' + route);
  };
  for (const file of ['presentation.js', 'app.js']) w.eval(await fs.readFile(new URL(`../../${file}`, import.meta.url), 'utf8'));
  await until(() => !d.querySelector('#app-shell').classList.contains('hidden'));
  h.root = d.querySelector('#seo-issue-list'); h.panel = d.querySelector('#seo-review-panel');
  h.open = () => d.querySelector('#main-nav [data-view="issues"]').click();
  h.refresh = () => h.controls.reload({ migrate: false });
  h.open(); return h;
}

test('unknown publication stays open for review while draft/archive findings are collapsed history', async t => {
  const h = await harness(t), before = h.calls.length;
  const review = h.d.querySelector('#seo-visibility-review'), history = h.d.querySelector('#seo-retained-history');
  assert.equal(history.open, false);
  assert.equal(review.closest('details'), null, 'visibility unknowns are visible at rest');
  assert.equal(review.querySelectorAll('.issue-row').length, 5);
  assert.equal(history.querySelectorAll('.issue-row').length, 4);
  assert.match(review.textContent, /Recorded status: active · Publication unknown/);
  assert.match(review.textContent, /Product status unknown · Publication unknown/);
  assert.match(review.textContent, /Recorded status: unlisted · Publication unknown/);
  assert.match(h.root.textContent, /No actionable SEO findings can be confirmed because customer-facing publication is unverified/);
  assert.doesNotMatch(review.textContent, /Synthetic catalogue item draft|Synthetic catalogue item archived/);
  assert.match(history.textContent, /Synthetic catalogue item draft/);
  assert.match(history.textContent, /Synthetic catalogue item archived/);
  history.querySelector('summary').click(); assert.equal(history.open, true);
  history.querySelector('summary').click(); assert.equal(history.open, false);
  history.querySelector('summary').click(); assert.equal(history.open, true);
  assert.equal(h.calls.length, before, 'opening retained history never requests records or runs diagnostics');
  assert.match(h.d.querySelector('#control-status').textContent, /Recorded SEO findings9/);
  assert.ok(h.calls.every(call => call.method === 'GET'));
});

test('catalogue and each existing order, stock and cost link retain their ordinary destination', async t => {
  const h = await harness(t), before = h.calls.length;
  for (const selector of ['#seo-review-panel > button', '#seo-visibility-review .issue-row', '#seo-retained-history .issue-row', '#customer-issue-list .issue-row', '#stock-issue-list .issue-row', '#cost-issue-list .issue-row']) {
    h.open(); const button = h.d.querySelector(selector);
    const view = button.dataset.viewLink, filter = button.dataset.targetFilter;
    button.click();
    assert.ok(h.d.querySelector('#view-' + view).classList.contains('active'), selector);
    assert.equal(h.d.querySelector(view === 'orders' ? '#order-filter' : '#product-status').value, filter, selector);
  }
  h.open(); assert.equal(h.d.querySelector('#seo-retained-history').open, false);
  assert.equal(h.calls.length, before, 'navigation does not fetch, write or poll');
});

test('no recorded findings is distinct from unverified publication, including all-history snapshots', async t => {
  const h = await harness(t, []);
  assert.match(h.root.textContent, /No SEO findings were recorded in the retained catalogue/);
  assert.match(h.root.textContent, /Customer-facing publication is still unverified/);
  assert.doesNotMatch(h.root.textContent, /No issues detected|SEO ready|published|customer-visible/i);
  h.state.products = [product('draft-only', 'draft')];
  h.bootstrap.products = h.state.products; h.bootstrap.dashboard = { ...h.bootstrap.dashboard, ...deriveOperations(h.state) };
  await h.refresh();
  assert.match(h.d.querySelector('#seo-visibility-heading').textContent, /0 findings/);
  assert.match(h.d.querySelector('#seo-retained-history summary').textContent, /2 findings/);
  assert.match(h.root.textContent, /No actionable SEO findings can be confirmed/);
  assert.doesNotMatch(h.root.textContent, /No SEO findings were recorded/);
});

test('refresh uses fresh retained data and normalizes ambiguous statuses without trusting forged publication fields', async t => {
  const h = await harness(t);
  h.d.querySelector('#seo-retained-history summary').click();
  h.state.products = [product('fresh', ' AcTiVe ', { published: true, publishedAt: '2026-10-09', publicationStatus: 'published', onlineStoreUrl: 'https://shop.example.test/product', inventory: 500 }),
    product('pending', { status: 'active' }), product('missing', null), product('future', 'published')];
  h.bootstrap.products = h.state.products; h.bootstrap.dashboard = { ...h.bootstrap.dashboard, ...deriveOperations(h.state) };
  await h.refresh();
  assert.match(h.root.textContent, /Synthetic catalogue item fresh/);
  assert.doesNotMatch(h.root.textContent, /Synthetic catalogue item archived|Synthetic catalogue item draft/);
  assert.equal(h.d.querySelector('#seo-retained-history').open, false);
  assert.match(h.root.textContent, /Product status unknown · Publication unknown/);
  assert.match(h.d.querySelector('#seo-actionable-status').textContent, /publication is unverified/);
  assert.ok(h.calls.every(call => call.method === 'GET'));
});

test('missing or malformed classifications preserve legacy findings as unclassified without claiming zero', async t => {
  const h = await harness(t), original = clone(h.bootstrap.dashboard.seoReview);
  const otherLists = ['customer-issue-list', 'stock-issue-list', 'cost-issue-list'].map(id => h.d.getElementById(id).innerHTML);
  const malformed = [undefined, null, {}, [], { ...original, publicationStatus: 'published' }, { ...original, actionableCount: 1 },
    { ...original, itemLimit: 101 }, { ...original, visibilityReview: { ...original.visibilityReview, count: -1 } },
    { ...original, retainedHistory: { ...original.retainedHistory, omitted: 4 } },
    { ...original, visibilityReview: { ...original.visibilityReview, items: original.visibilityReview.items.map((ref, i) => i ? ref : [999, 'description']) } },
    { ...original, retainedHistory: { ...original.retainedHistory, count: 0, items: [], omitted: 0 } }];
  for (const review of malformed) {
    h.bootstrap.dashboard.seoReview = review;
    await h.refresh();
    assert.match(h.root.textContent, /SEO classification unavailable/);
    assert.match(h.root.textContent, /Unclassified recorded findings/);
    assert.equal(h.root.querySelectorAll('.issue-row').length, 9);
    assert.match(h.root.textContent, /Synthetic catalogue item archived/);
    assert.equal(h.d.querySelector('#seo-retained-history'), null);
    assert.doesNotMatch(h.root.textContent, /No issues detected|0 actionable|No SEO findings were recorded|SEO ready/i);
    assert.deepEqual(['customer-issue-list', 'stock-issue-list', 'cost-issue-list'].map(id => h.d.getElementById(id).innerHTML), otherLists);
  }
  h.bootstrap.dashboard.seoIssueItems = null; h.bootstrap.dashboard.seoIssues = 0;
  await h.refresh();
  assert.match(h.root.textContent, /No legacy findings were supplied.*does not establish that no SEO findings exist/s);
});

test('finding names, issues and fallback data are escaped and cannot inject markup or actions', async t => {
  const payload = '<img src=x onerror="window.seoInjected=true"><script>window.seoInjected=true</script>';
  const h = await harness(t, [product('xss', 'active', { title: payload }), product('history', 'draft', { title: payload })]);
  await h.refresh();
  assert.match(h.root.textContent, /<img src=x/);
  assert.equal(h.root.querySelector('img, script, [onerror], [onclick]'), null);
  assert.equal(h.w.seoInjected, undefined);
  h.bootstrap.dashboard.seoReview = null; h.bootstrap.dashboard.seoIssueItems[0].issue = payload;
  await h.refresh();
  assert.match(h.root.textContent, /<script>/);
  assert.equal(h.root.querySelector('img, script, [onerror], [onclick]'), null);
  assert.equal(h.w.seoInjected, undefined);
});

test('invalid, duplicate, wrong-group and stale catalogue references stay visibly unclassified', async t => {
  const h = await harness(t), original = clone(h.bootstrap.dashboard.seoReview), originalProducts = clone(h.bootstrap.products);
  const invalidReferences = [[-1, 'description'], ['0', 'description'], [999, 'description'], [0, 'publish'], [0, 'description', true],
    [0, 'image'], [3, 'description'], original.visibilityReview.items[1], { productIndex: 0, issueCode: 'description' }];
  for (const ref of invalidReferences) {
    h.bootstrap.dashboard.seoReview = clone(original);
    h.bootstrap.dashboard.seoReview.visibilityReview.items[0] = ref;
    await h.refresh();
    assert.match(h.root.textContent, /SEO classification unavailable/);
    assert.equal(h.root.querySelectorAll('.issue-row').length, 9);
  }
  for (const products of [undefined, null, {}, [], [null, ...originalProducts.slice(1)],
    [{ ...originalProducts[0], title: { unexpected: true } }, ...originalProducts.slice(1)],
    [{ ...originalProducts[0], description: { unexpected: true } }, ...originalProducts.slice(1)],
    [{ ...originalProducts[0], status: { toString: null } }, ...originalProducts.slice(1)],
    [originalProducts[3], ...originalProducts.slice(1)]]) {
    h.bootstrap.dashboard.seoReview = clone(original); h.bootstrap.products = products;
    await h.refresh();
    assert.match(h.root.textContent, /SEO classification unavailable/);
    assert.match(h.root.textContent, /Synthetic catalogue item active/);
    assert.equal(h.d.querySelector('#seo-retained-history'), null);
  }
});

test('independent 100-finding limits disclose all omitted findings and fallback clipping stays truthful', async t => {
  const h = await harness(t, [...Array.from({ length: 107 }, (_, i) => product('review-' + i)), ...Array.from({ length: 56 }, (_, i) => product('history-' + i, 'archived'))]);
  const review = h.d.querySelector('#seo-visibility-review'), history = h.d.querySelector('#seo-retained-history');
  assert.equal(review.querySelectorAll('.issue-row').length, 100);
  assert.equal(history.querySelectorAll('.issue-row').length, 100);
  assert.match(review.textContent, /Showing 100 of 107 findings; 7 omitted/);
  assert.match(history.textContent, /Showing 100 of 112 findings; 12 omitted/);
  assert.doesNotMatch(review.textContent, /107 products/);
  h.bootstrap.dashboard.seoReview = null;
  h.bootstrap.dashboard.seoIssueItems = Array.from({ length: 110 }, (_, i) => ({ product: 'Legacy ' + i, issue: 'Retained issue' }));
  await h.refresh();
  assert.equal(h.root.querySelectorAll('.issue-row').length, 100);
  assert.match(h.root.textContent, /Showing 100 of 219 recorded findings; 119 omitted/);
});

test('pending refresh clears old findings and an older response cannot replace the current SEO view', async t => {
  const h = await harness(t), oldData = clone(h.bootstrap), pending = deferred();
  h.readBootstrap = () => pending.promise;
  const oldRefresh = h.refresh();
  assert.doesNotMatch(h.root.textContent, /Synthetic catalogue item/);
  h.state.products = [product('new-snapshot')];
  h.bootstrap.products = h.state.products; h.bootstrap.dashboard = { ...h.bootstrap.dashboard, ...deriveOperations(h.state) };
  h.readBootstrap = async () => response(clone(h.bootstrap));
  await h.refresh(); assert.match(h.root.textContent, /new-snapshot/);
  pending.resolve(response(oldData)); await oldRefresh;
  assert.doesNotMatch(h.root.textContent, /Synthetic catalogue item active|Synthetic catalogue item archived/);
  assert.match(h.root.textContent, /classification unavailable/);
});

test('role, workspace, account and security transitions cannot reuse another session’s SEO findings', async t => {
  for (const mutate of [h => { h.session.user.role = 'viewer'; }, h => { h.session.user.id = 'replacement-user'; },
    h => { h.session.workspace.id = 'replacement-workspace'; }, h => { h.session.csrf = 'replacement-csrf'; },
    h => { h.session.user.active = false; }, h => { h.session.user.passwordChangeRequired = true; }]) {
    const h = await harness(t); mutate(h); h.open();
    assert.match(h.root.textContent, /classification unavailable for the current session/);
    assert.doesNotMatch(h.root.textContent, /Synthetic catalogue item/);
  }
  const h = await harness(t);
  h.session.user.role = 'viewer'; h.bootstrap.user.role = 'viewer';
  await h.refresh(); assert.match(h.root.textContent, /Synthetic catalogue item active/, 'current viewer can review current read-only findings');
});

test('sign-out immediately removes findings and late bootstrap data cannot restore them', async t => {
  const h = await harness(t), pending = deferred(), oldData = clone(h.bootstrap), logout = deferred();
  h.readBootstrap = () => pending.promise;
  const refresh = h.refresh();
  h.logout = () => logout.promise;
  h.d.querySelector('#logout').click();
  assert.doesNotMatch(h.root.textContent, /Synthetic catalogue item/);
  logout.resolve(response({ ok: true }));
  await until(() => !h.d.querySelector('#login-screen').classList.contains('hidden'));
  pending.resolve(response(oldData)); await refresh;
  assert.match(h.root.textContent, /classification unavailable/);
  assert.doesNotMatch(h.root.textContent, /Synthetic catalogue item/);
  assert.equal(h.calls.filter(call => call.method !== 'GET').length, 1);
});
