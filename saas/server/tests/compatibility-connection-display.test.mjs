import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { publicConnectionWrite } from '../lib/action-display.mjs';
import { intelligentConnections } from '../lib/connection-intelligence.mjs';
import { finishConnectionSync } from '../lib/connection-centre.mjs';
import { connectionPreviewFixture, renderConnectionPreview } from './render-connection-preview.mjs';

const html = await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8');
const sources = await Promise.all(['presentation.js', 'connections-ui.js'].map(file => fs.readFile(new URL(`../../${file}`, import.meta.url), 'utf8')));
const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
async function render(t, writes, { provider = 'shopify', role = 'owner', payload = connectionPreviewFixture({ compatibility: true }).payload } = {}) {
  const errors = [], requests = [], views = [], console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, { url: 'https://runvara.example.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: console });
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  for (const source of sources) window.eval(source);
  const next = { ...payload, user: { role }, connectionWrites: writes };
  window.RunvaraConnections.init({ escapeHtml, date: String, notify: () => {}, reload: async () => {}, setView: view => views.push(view), request: async (url, options = {}) => {
    requests.push({ url, ...options });
    if (url.endsWith('/execute')) return { write: { status: 'completed' }, executedExternally: false };
    assert.equal(url, '/api/connection-centre');
    return { channels: next.connectionCentre, writes, autopilotEnabled: true };
  } });
  t.after(() => { window.RunvaraConnections.endSession(); dom.window.close(); assert.deepEqual(errors, []); });
  window.RunvaraConnections.render(next);
  window.RunvaraConnections.open(provider);
  return { window, document: window.document, requests, views };
}

for (const status of ['ready', 'processing', 'completed', undefined, null, { future: true }]) {
  test(`projected future writes render safely with ${JSON.stringify(status)} status`, async t => {
    const source = { id: 'write_future', provider: 'shopify', status, input: { operation: 'future_operation', privateFuture: '<img src=x onerror="window.injected=true">' } };
    const before = structuredClone(source), write = publicConnectionWrite(source);
    assert.deepEqual(write.input, {});
    const { document, window, requests } = await render(t, [write]);
    const card = document.querySelector('.connection-write');
    assert.match(card.textContent, /Unsupported saved change/);
    assert.match(card.textContent, /requires a newer compatible release/);
    assert.doesNotMatch(card.textContent, /Instagram is preparing|Check again after|future_operation|privateFuture/);
    if (typeof status !== 'string') assert.match(card.textContent, /Status unavailable/);
    assert.equal(card.querySelector('[data-connection-action="execute"]'), null);
    assert.equal(card.querySelector('details'), null, 'omitted operation is not presented as an exact change');
    assert.equal(card.querySelector('img,script,[onerror]'), null);
    assert.equal(window.injected, undefined);
    assert.deepEqual(requests, []);
    assert.deepEqual(source, before);
  });
}

test('missing input and non-string operations cannot offer execution', async t => {
  const writes = [undefined, null, {}, { operation: null }, { operation: 42 }, { operation: {} }].map((input, index) => ({ id: `write_${index}`, provider: 'shopify', status: 'ready', ...(input === undefined ? {} : { input }) }));
  const { document } = await render(t, writes);
  assert.equal(document.querySelectorAll('.connection-write').length, writes.length);
  assert.equal(document.querySelectorAll('.connection-write [data-connection-action="execute"]').length, 0);
  assert.equal([...document.querySelectorAll('.connection-write > b')].every(element => element.textContent === 'Unsupported saved change'), true);
});

test('legacy exact-change controls and execute request stay intact', async t => {
  const { payload } = connectionPreviewFixture({ compatibility: true });
  const exact = { operation: 'product_content', productId: 'gid://shopify/Product/1', title: 'Exact <title> & 雪', description: 'First line\nSecond line' };
  const writes = [
    publicConnectionWrite({ id: 'write_approved', provider: 'shopify', status: 'ready', approvalId: 'approval_1', requiresApproval: true, input: exact }),
    publicConnectionWrite({ id: 'write_note', provider: 'shopify', status: 'ready', input: { operation: 'internal_note', productId: exact.productId, note: 'Private note' } }),
    publicConnectionWrite({ id: 'write_pending', provider: 'shopify', status: 'pending_approval', approvalId: 'approval_2', input: { operation: 'product_tags_add', productId: exact.productId, tags: ['Tag one', '雪'], expectedTags: ['Existing'] } })
  ];
  const { document, requests, window, views } = await render(t, writes, { payload });
  const cards = document.querySelectorAll('.connection-write');
  assert.deepEqual([...cards[0].querySelectorAll('dd')].map(el => el.textContent), Object.values(exact));
  assert.equal(cards[0].querySelector('summary').textContent, 'Review exact change');
  assert.equal(cards[0].querySelector('[data-connection-action="execute"]').textContent, 'Apply approved change');
  assert.equal(cards[1].querySelector('[data-connection-action="execute"]').textContent, 'Apply change');
  assert.equal(cards[2].querySelector('[data-connection-action="execute"]'), null);
  cards[0].querySelector('[data-connection-action="execute"]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[0].url, '/api/connection-writes/write_approved/execute');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].body, '{}');
  assert.equal(requests.filter(item => item.url.endsWith('/execute')).length, 1);
  document.querySelector('.connection-write [data-connection-action="approvals"]').click();
  assert.deepEqual(views, ['approvals']);
  assert.equal(document.querySelector('#connection-dialog').open, false);
  window.RunvaraConnections.endSession();
});

test('legacy Meta progress and Facebook source selection tolerate projected future records', async t => {
  const { state, service, payload } = connectionPreviewFixture({ compatibility: true });
  state.connections.push({ id: 'meta-fixture', provider: 'meta', status: 'connected', encryptedCredentials: 'fixture', metadata: { grantedScopes: ['pages_manage_posts', 'pages_read_engagement'], assets: { pages: [{ id: '100', name: 'Example Page' }], catalogs: [] } } });
  state.connectionSettings.meta = { areas: ['posts'], permissionMode: 'approval_gated', autoSync: false };
  payload.connectionCentre = intelligentConnections(state, service);
  const writes = [
    publicConnectionWrite({ id: 'write_future', provider: 'meta', status: 'completed', input: { operation: 'future_post' } }),
    { id: 'write_missing', provider: 'meta', status: 'completed' },
    publicConnectionWrite({ id: 'write_post', provider: 'meta', status: 'completed', input: { operation: 'facebook_publish', pageId: '100', message: 'Exact saved post' }, result: { externalId: '100_101' } }),
    publicConnectionWrite({ id: 'write_processing', provider: 'meta', status: 'processing', input: { operation: 'instagram_publish', pageId: '100', instagramId: '200', imageUrl: 'https://example.test/image.jpg', caption: 'Exact caption' }, observationErrorCode: 'META_STATUS_UNAVAILABLE' })
  ];
  const { document, window } = await render(t, writes, { provider: 'meta', payload });
  assert.equal(document.querySelector('[data-write="write_processing"]').textContent, 'Check publishing progress');
  assert.match(document.querySelector('[data-write="write_processing"]').closest('article').textContent, /saved container is retained/);
  const operation = document.querySelector('#connection-meta-write-form select[name="operation"]');
  operation.value = 'facebook_update';
  operation.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual([...document.querySelectorAll('select[name="postId"] option')].map(option => [option.value, option.textContent]), [['', 'Choose…'], ['100_101', 'Exact saved post']]);
});

test('stored deferred history reports compatibility and retry holds without replay controls', async t => {
  const { state, payload } = connectionPreviewFixture({ compatibility: true });
  const channel = payload.connectionCentre.find(item => item.id === 'ebay');
  channel.history = ['READ_COMPATIBILITY_DEFERRED', 'EBAY_READ_DEFERRED', 'EBAY_RETRY_REVIEW_REQUIRED', 'UNKNOWN_FUTURE_HOLD'].map(code => {
    const run = { id: `sync_${code}`, provider: 'ebay', areas: ['orders'], status: 'running', startedAt: '2026-10-01T10:00:00Z' };
    finishConnectionSync(state, run, null, { code, readDeferred: true });
    return run;
  });
  const { document } = await render(t, [], { payload, provider: 'ebay' });
  const history = document.querySelector('.connection-history');
  assert.deepEqual([...history.querySelectorAll('b')].map(el => el.textContent), ['Deferred', 'Deferred', 'Deferred', 'Deferred']);
  assert.match(history.textContent, /newer compatible reader/);
  assert.match(history.textContent, /waiting for the saved retry deadline/);
  assert.match(history.textContent, /deadline needs review/);
  assert.doesNotMatch(history.textContent, /Use Sync now|In progress|Completed|Partially completed|reset/i);
  assert.equal(history.querySelector('button,progress'), null);
  assert.equal(document.querySelector('#connection-progress progress'), null);
});

test('read health preserves ordinary success and prioritizes saved compatibility and eBay retry holds', () => {
  const { state, service } = connectionPreviewFixture({ compatibility: true });
  delete state.connectionDoctor;
  delete state.integrationStatus.ebay.retryAt;
  const health = provider => intelligentConnections(state, service, { now: new Date('2026-10-01T11:00:00Z') }).find(item => item.id === provider).health;
  assert.equal(health('shopify').status, 'Healthy');
  const cases = [
    ['shopify', s => { s.connectionDoctor = { shopify: { pendingReadAttempts: [] } }; }, /newer compatible reader/],
    ['shopify', s => { s.channelData = { shopify: { orderReads: {} } }; }, /newer compatible reader/],
    ['ebay', s => { s.integrationStatus.ebay.retryAt = '2099-01-01T00:00:00.000Z'; }, /saved retry deadline/],
    ['ebay', s => { s.integrationStatus.ebay.retryReviewRequired = true; }, /deadline needs review/]
  ];
  for (const [provider, mark, message] of cases) {
    const before = structuredClone(state);
    mark(state);
    const marked = structuredClone(state), result = health(provider);
    assert.notEqual(result.status, 'Healthy');
    assert.match(result.message, message);
    assert.equal(result.action.action, 'open');
    assert.doesNotMatch(result.action.label, /retry|reset|refresh/i);
    assert.deepEqual(state, marked, 'health is read-only');
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, before);
  }
});

test('compatibility browser fixture uses deterministic projected synthetic data', async () => {
  const first = await renderConnectionPreview({ compatibility: true });
  assert.equal(first, await renderConnectionPreview({ compatibility: true }));
  assert.match(first, /write_future/);
  assert.match(first, /READ_COMPATIBILITY_DEFERRED/);
  assert.doesNotMatch(first, /private-fixture-canary|fixture-not-a-credential/);
});
