import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { IntegrationService, mergeProviderRecords } from '../lib/integrations.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createPacksmartServer } from '../server.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { monitoredSync } from '../lib/scheduler.mjs';
import { SHOPIFY_ORDER_SOURCE_LIMITS as LIMITS, inspectShopifyOrderSource, stageShopifyOrderRead, orderReportingCurrency } from '../lib/shopify-order-source.mjs';

const WS = 'source-capture-test', NOW = '2026-10-07T10:00:00.000Z';
const money = (amount = '100.00', currencyCode = 'GBP') => ({ shopMoney: { amount, currencyCode } });
function raw(id = 'one', lineCount = 1) {
  return { id: `gid://shopify/Order/${id}`, name: `#${id}`, createdAt: NOW, updatedAt: NOW, cancelledAt: null,
    displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED', totalPriceSet: money(), currentTotalPriceSet: money(),
    currentTotalTaxSet: money('16.67'), currentTotalDiscountsSet: money('0.00'), currentShippingPriceSet: money('3.00'),
    lineItems: { nodes: Array.from({ length: lineCount }, (_, index) => ({ id: `gid://shopify/LineItem/${id}-${index}`, name: 'Recorded line', sku: `SKU-${index}`, quantity: 1,
      originalTotalSet: money('25.00'), discountedTotalSet: money('24.00') })), pageInfo: { hasNextPage: false } } };
}
const responsePage = (nodes, hasNextPage = false, endCursor = null) => ({ data: { orders: { nodes, pageInfo: { hasNextPage, endCursor } } } });
function fixture(rows = [raw()], workspaceId = WS) {
  const calls = [];
  const state = seedWorkspaceState({}, { workspaceId });
  state.orders = [{ id: 'historical', provider: 'shopify', total: 99, currentTotal: 98, refunds: 1, tax: 2, currentTax: 2, lineItems: [], createdAt: NOW }];
  state.integrationStatus.shopify = { status: 'connected', lastSyncAt: '2026-10-01T00:00:00.000Z', lastSuccessfulSyncAt: '2026-10-01T00:00:00.000Z', areaSuccessAt: { orders: '2026-10-01T00:00:00.000Z' } };
  let reply = (index, query) => query.includes('PacksmartOpsProducts') ? { data: { products: { nodes: [], pageInfo: { hasNextPage: false } } } } : responsePage(rows);
  const env = { SHOPIFY_ENV_WORKSPACE_ID: workspaceId, SHOPIFY_STORE_DOMAIN: 'fixture.myshopify.com', SHOPIFY_ADMIN_ACCESS_TOKEN: 'synthetic-token', SHOPIFY_ADMIN_API_VERSION: '2026-07' };
  const fetchImpl = async (url, options) => { const body = JSON.parse(options.body); calls.push({ url, body }); const result = reply(calls.length - 1, body.query); return result instanceof Response ? result : Response.json(result, { headers: { 'X-Shopify-API-Version': '2026-07' } }); };
  const service = new IntegrationService(env, { fetchImpl });
  return { state, service, calls, env, fetchImpl, setReply(value) { reply = value; }, sync: () => service.syncShopify(state, { areas: ['orders'] }) };
}
function preserved(state) { return structuredClone({ orders: state.orders, products: state.products, channelData: state.channelData, lastSuccessfulSyncAt: state.integrationStatus.shopify.lastSuccessfulSyncAt, areaSuccessAt: state.integrationStatus.shopify.areaSuccessAt }); }

test('existing order call captures exact strings, one shared observation and real returned API metadata', async () => {
  const one = raw('large', 2), two = raw('zero');
  one.totalPriceSet = money('123456789012.123456'); one.currentTotalPriceSet = money('-0.000001'); two.currentTotalPriceSet = money('0');
  delete two.currentTotalTaxSet;
  const f = fixture([one, two]); const old = structuredClone(f.state.orders[0]);
  await f.sync();
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].body.query, /query PacksmartOpsOrders/); assert.doesNotMatch(f.calls[0].body.query, /ConnectionIdentity|\bmutation\b/);
  assert.deepEqual(Object.keys(f.calls[0].body.variables).sort(), ['after', 'first', 'query']);
  assert.equal(f.calls[0].body.variables.first, 50); assert.match(f.calls[0].body.variables.query, /^created_at:>=\d{4}-\d\d-\d\d$/);
  const [large, zero] = f.state.orders;
  assert.equal(large.total, '123456789012.123456'); assert.equal(large.currentTotal, '-0.000001'); assert.equal(zero.currentTotal, '0'); assert.equal(zero.currentTax, null);
  assert.equal(large.tax, null); assert.equal(large.refunds, null); assert.equal(large.lineItems[0].net, '24.00');
  assert.equal(large.sourceReadRef, zero.sourceReadRef); assert.equal(large.lineItems[0].sourceReadRef, undefined);
  const reads = f.state.channelData.shopify.orderReads, manifest = reads.manifests[large.sourceReadRef];
  assert.equal(Object.keys(reads.manifests).length, 1); assert.equal(manifest.ordersRead, 2); assert.equal(manifest.linesRead, 3);
  assert.equal(manifest.pages[0].apiVersion, '2026-07'); assert.equal(manifest.requestDomain, 'fixture.myshopify.com');
  assert.equal(manifest.sourceAccountId, null); assert.equal(manifest.currentScopes, 'not_observed'); assert.equal(manifest.requestedUpperBound, null);
  assert.equal(manifest.sourcePeriod, 'unverified'); assert.equal(manifest.queryExhaustion, 'observed_exhausted');
  assert.equal(f.state.integrationStatus.shopify.orderReadHold, null);
  assert.deepEqual(f.state.orders.find(order => order.id === 'historical'), old, 'no legacy backfill');
  assert.doesNotMatch(JSON.stringify(reads), /synthetic-token|gid:\/\/shopify\/Order|customerEmail/);
});

test('each field retains its currency exception and missing response version is never filled from the request', async () => {
  const order = raw(); order.totalPriceSet = money('100.00', 'USD'); delete order.currentTotalTaxSet.shopMoney.currencyCode;
  order.lineItems.nodes[0].discountedTotalSet = money('24.00', 'EUR');
  const f = fixture(); f.setReply(() => Response.json(responsePage([order]))); await f.sync();
  const captured = f.state.orders[0];
  assert.deepEqual(captured.sourceCurrencyOverrides, { total: 'USD', currentTax: null, 'lineItems/0/net': 'EUR' });
  const info = inspectShopifyOrderSource(f.state, captured, WS); assert.equal(info.currencyFor('total'), 'USD'); assert.equal(info.currencyFor('currentTax'), null);
  assert.equal(info.currencyFor('lineItems/0/net'), 'EUR'); assert.equal(info.currencyFor('refunds'), null);
  assert.equal(orderReportingCurrency(captured), 'USD', 'the lossy typed total keeps its own source currency');
  assert.equal(f.state.channelData.shopify.orderReads.manifests[captured.sourceReadRef].pages[0].apiVersion, null);
});

test('missing total currency rejects admission even when current currency is present', async () => {
  const row = raw(); delete row.totalPriceSet.shopMoney.currencyCode;
  const f = fixture([row]); const before = preserved(f.state);
  await assert.rejects(f.sync, { code: 'SHOPIFY_ORDER_SOURCE_REPORTING_CURRENCY_UNAVAILABLE' });
  assert.deepEqual(preserved(f.state), before);
  const missingCurrent = raw(); delete missingCurrent.currentTotalPriceSet.shopMoney.currencyCode;
  const safe = fixture([missingCurrent]); await safe.sync();
  assert.equal(safe.state.orders[0].currency, null); assert.equal(orderReportingCurrency(safe.state.orders[0]), 'GBP');
});

for (const [name, mutate] of [
  ['missing connection', value => { delete value.data.orders; }],
  ['missing top page flag', value => { delete value.data.orders.pageInfo.hasNextPage; }],
  ['string page flag', value => { value.data.orders.pageInfo.hasNextPage = 'false'; }],
  ['missing nested page flag', value => { delete value.data.orders.nodes[0].lineItems.pageInfo.hasNextPage; }],
  ['partial lines', value => { value.data.orders.nodes[0].lineItems.pageInfo.hasNextPage = true; }],
  ['foreign nested scope', value => { value.data.orders.nodes[0].currentTotalPriceSet.shopMoney.workspace = { id: WS, tenantId: 'foreign' }; }],
  ['coerced money', value => { value.data.orders.nodes[0].currentTotalPriceSet.shopMoney.amount = true; }],
  ['unsupported precision', value => { value.data.orders.nodes[0].currentTotalPriceSet.shopMoney.amount = '1.1234567'; }],
  ['duplicate lines', value => { value.data.orders.nodes[0].lineItems.nodes.push(value.data.orders.nodes[0].lineItems.nodes[0]); }],
  ['partial GraphQL error', value => { value.errors = [{ message: 'synthetic partial response' }]; }]
]) test(`${name} retains old orders and successful evidence and creates a structural hold`, async () => {
  const f = fixture(); await f.sync(); const before = preserved(f.state); f.calls.length = 0;
  const value = responsePage([raw('replacement')]); mutate(value); f.setReply(() => value);
  await assert.rejects(f.sync, error => error.nonRetryable && error.code.startsWith('SHOPIFY_ORDER_SOURCE_'));
  assert.equal(f.calls.length, 1); assert.deepEqual(preserved(f.state), before);
  assert.equal(f.state.integrationStatus.shopify.orderReadAttempt.status, 'incomplete'); assert.ok(f.state.integrationStatus.shopify.orderReadHold.code);
});

test('duplicate orders and non-advancing cursors fail without a third page or partial replacement', async () => {
  for (const duplicate of [false, true]) {
    const f = fixture(); const before = preserved(f.state);
    f.setReply(index => responsePage([raw(duplicate ? 'same' : String(index))], true, duplicate ? `cursor-${index}` : 'same-cursor'));
    await assert.rejects(f.sync, { code: duplicate ? 'SHOPIFY_ORDER_SOURCE_DUPLICATE_ORDER' : 'SHOPIFY_ORDER_SOURCE_CURSOR_NOT_ADVANCING' });
    assert.equal(f.calls.length, 2); assert.deepEqual(preserved(f.state), before);
  }
});

test('ten-page exhaustion cap never asks for an eleventh page or commits a partial read', async () => {
  const f = fixture(); const before = preserved(f.state); f.setReply(index => responsePage([raw(String(index))], true, `cursor-${index}`));
  await assert.rejects(f.sync, { code: 'SHOPIFY_ORDER_SOURCE_PAGE_LIMIT' }); assert.equal(f.calls.length, 10); assert.deepEqual(preserved(f.state), before);
});

test('declared and actual provider body limits retain prior source state', async () => {
  for (const declared of [false, true]) {
    const f = fixture(); const before = preserved(f.state);
    f.setReply(() => new Response(declared ? '{}' : 'x'.repeat(2097153), { headers: declared ? { 'Content-Length': '2097153' } : {} }));
    await assert.rejects(f.sync, { code: 'SHOPIFY_ORDER_SOURCE_RESPONSE_LIMIT' }); assert.deepEqual(preserved(f.state), before); assert.equal(f.calls.length, 1);
  }
});

test('an interrupted returned response is structural and preserves the last successful source state', async () => {
  const f = fixture(); const before = preserved(f.state);
  f.setReply(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"data":')); controller.error(new TypeError('synthetic interrupted body')); } })));
  await assert.rejects(f.sync, { code: 'SHOPIFY_ORDER_SOURCE_RESPONSE_INVALID', nonRetryable: true });
  assert.deepEqual(preserved(f.state), before); assert.equal(f.calls.length, 1);
  assert.equal(f.state.integrationStatus.shopify.orderReadHold.binding.domain, 'fixture.myshopify.com');
});

test('deterministic query cost failures hold while an explicit throttle uses scheduled retry without another page', async () => {
  for (const codes of [['MAX_COST_EXCEEDED'], ['THROTTLED', 'MAX_COST_EXCEEDED'], ['THROTTLED', 'UNKNOWN']]) {
    const f = fixture(); const before = preserved(f.state);
    f.setReply(() => ({ errors: codes.map(code => ({ message: 'Synthetic provider diagnostic', extensions: { code } })) }));
    const expected = codes.includes('MAX_COST_EXCEEDED') ? 'SHOPIFY_ORDER_SOURCE_QUERY_COST_LIMIT' : 'SHOPIFY_ORDER_SOURCE_GRAPHQL_INCOMPLETE';
    await assert.rejects(() => monitoredSync(f.state, f.service, 'shopify', { areas: ['orders'] }), { code: expected, nonRetryable: true });
    assert.equal(f.calls.length, 1); assert.deepEqual(preserved(f.state), before);
    assert.equal(f.state.integrationStatus.shopify.orderReadHold.code, expected); assert.equal(f.state.integrationStatus.shopify.retryAt, null);
  }
  const f = fixture(); const before = preserved(f.state);
  f.setReply(() => ({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }, { message: 'Temporary', extensions: { code: 'INTERNAL_SERVER_ERROR' } }], extensions: { cost: { requestedQueryCost: 900, actualQueryCost: null } } }));
  await assert.rejects(() => monitoredSync(f.state, f.service, 'shopify', { areas: ['orders'] }), { code: 'CONNECTION_RATE_LIMITED', upstreamStatus: 429 });
  assert.equal(f.calls.length, 1); assert.deepEqual(preserved(f.state), before);
  assert.equal(f.state.integrationStatus.shopify.orderReadHold, undefined); assert.ok(Date.parse(f.state.integrationStatus.shopify.retryAt) > Date.now());
});

test('documented internal GraphQL failures use the existing bounded transient retry without a structural hold', async () => {
  const f = fixture(); const before = preserved(f.state);
  f.setReply(() => ({ errors: [{ message: 'Synthetic temporary provider error', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] }));
  await assert.rejects(() => monitoredSync(f.state, f.service, 'shopify', { areas: ['orders'] }), { code: 'SHOPIFY_GRAPHQL_TRANSIENT_ERROR', upstreamStatus: 503 });
  assert.equal(f.calls.length, 2); assert.deepEqual(preserved(f.state), before);
  assert.equal(f.state.integrationStatus.shopify.orderReadHold, undefined);
});

test('a pre-response network failure retains existing bounded transient retry behavior', async () => {
  const f = fixture(); const before = preserved(f.state);
  f.setReply(() => { throw new TypeError('Synthetic transport failure'); });
  await assert.rejects(() => monitoredSync(f.state, f.service, 'shopify', { areas: ['orders'] }), { code: 'READ_FAILED' });
  assert.equal(f.calls.length, 2); assert.deepEqual(preserved(f.state), before);
  assert.equal(f.state.integrationStatus.shopify.orderReadHold, undefined);
});

test('a token rotation retains account binding while a changed domain cannot adopt an old read or failure', async () => {
  const rotation = fixture();
  rotation.setReply(() => { rotation.env.SHOPIFY_ADMIN_ACCESS_TOKEN = 'synthetic-rotated-token'; return responsePage([raw()]); });
  await rotation.sync(); assert.equal(rotation.calls.length, 1); assert.equal(rotation.state.orders[0].currentTotal, '100.00');
  for (const complete of [false, true]) {
    const f = fixture(); const before = preserved(f.state);
    f.setReply(() => { f.env.SHOPIFY_STORE_DOMAIN = 'replacement.myshopify.com'; return complete ? responsePage([raw()]) : null; });
    await assert.rejects(f.sync, { code: complete ? 'SHOPIFY_ORDER_SOURCE_CONFIGURATION_CHANGED' : 'SHOPIFY_ORDER_SOURCE_RESPONSE_INVALID' });
    assert.deepEqual(preserved(f.state), before); assert.equal(f.calls.length, 1);
    assert.equal(f.state.integrationStatus.shopify.orderReadHold, undefined, 'old-account attempt must not block the replacement');
  }
});

test('the total metadata cap rejects detached admission without truncating retained orders', async () => {
  const f = fixture();
  f.state.orders = Array.from({ length: 3100 }, (_, index) => ({ id: `prior-${index}`, provider: 'shopify', total: 1,
    sourceReadRef: `sor1:${'a'.repeat(64)}`, lineItems: [], actualShippingCost: index }));
  const before = preserved(f.state);
  await assert.rejects(f.sync, { code: 'SHOPIFY_ORDER_SOURCE_METADATA_LIMIT' });
  assert.deepEqual(preserved(f.state), before); assert.equal(f.calls.length, 1);
});

test('detached state, encoding and reporting admission failures do not replace source rows', async () => {
  const oversized = fixture(); oversized.state.padding = 'x'.repeat(LIMITS.stateBytes - LIMITS.commitReserveBytes);
  let before = preserved(oversized.state); await assert.rejects(oversized.sync, { code: 'SHOPIFY_ORDER_SOURCE_STATE_LIMIT' }); assert.deepEqual(preserved(oversized.state), before);
  const heavy = fixture(); const records = Array.from({ length: 500 }, (_, index) => raw(String(index), 4));
  for (const order of records) {
    for (const field of ['totalPriceSet','currentTotalPriceSet','currentTotalTaxSet','currentTotalDiscountsSet','currentShippingPriceSet']) order[field] = money('999999999999999999999999.999999');
    for (const line of order.lineItems.nodes) { line.originalTotalSet = money('999999999999999999999999.999999'); line.discountedTotalSet = money('999999999999999999999999.999999'); }
  }
  heavy.setReply(index => responsePage(records.slice(index * 50, (index + 1) * 50), index < 9, index < 9 ? `cursor-${index}` : null));
  before = preserved(heavy.state); await assert.rejects(heavy.sync, { code: 'SHOPIFY_ORDER_SOURCE_ENCODING_LIMIT' }); assert.deepEqual(preserved(heavy.state), before); assert.equal(heavy.calls.length, 10);
  const reporting = fixture([raw()], 'w'.repeat(256));
  reporting.state.orders = Array.from({ length: 6000 }, (_, index) => ({ id: `old-${index}`, provider: 'ebay', createdAt: NOW, lineItems: [] }));
  before = preserved(reporting.state); await assert.rejects(reporting.sync, { code: 'SHOPIFY_ORDER_SOURCE_REPORTING_LIMIT' }); assert.deepEqual(preserved(reporting.state), before);
});

test('manifest retention stays capped without discarding orders, and changed source contents have distinct references', async () => {
  const f = fixture(); const refs = [];
  for (let index = 0; index < 12; index++) { f.setReply(() => responsePage([raw(String(index))])); await f.sync(); refs.push(f.state.orders[0].sourceReadRef); }
  assert.equal(new Set(refs).size, 12); assert.equal(f.state.orders.length, 13);
  const holder = f.state.channelData.shopify.orderReads; assert.equal(Object.keys(holder.manifests).length, 8); assert.ok(Buffer.byteLength(JSON.stringify(holder)) <= LIMITS.manifestMapBytes);
  const old = f.state.orders.find(order => order.sourceReadRef === refs[0]); assert.equal(old.currentTotal, '100.00'); assert.equal(inspectShopifyOrderSource(f.state, old, WS).manifestStatus, 'unavailable');
  assert.equal(inspectShopifyOrderSource(f.state, f.state.orders[0], WS).manifestStatus, 'retained');
});

test('merge refreshes invalidate stale references but preserve separately recorded owner costs', async () => {
  const f = fixture(); await f.sync(); const captured = f.state.orders[0]; captured.actualShippingCost = 9; captured.costOverrides = { actualShippingCost: 9 };
  captured.sourceCurrencyOverrides = { total: 'USD' };
  const unproved = mergeProviderRecords([captured], 'shopify', [{ id: captured.id, provider: 'shopify', total: '17', lineItems: [], actualShippingCost: null }])[0];
  assert.equal(unproved.sourceReadRef, undefined); assert.equal(unproved.sourceCurrencyOverrides, undefined); assert.equal(unproved.actualShippingCost, 9);
  const refreshed = mergeProviderRecords([captured], 'shopify', [{ ...captured, sourceCurrencyOverrides: undefined }])[0];
  assert.equal(refreshed.actualShippingCost, 9);
  const read = await f.service.fetchShopifyOrders(f.service.shopifyConfig(f.state)); const candidate = structuredClone(f.state); candidate.orders = read.orders;
  read.orders[0].currentTotal = '123'; assert.throws(() => stageShopifyOrderRead(candidate, read, f.state), { code: 'SHOPIFY_ORDER_SOURCE_READ_INVALID' });
});

test('authenticated manual API capture preserves source through cost edits and retains it after a failed retry', async t => {
  const f = fixture(); const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shopify-source-api-')); const secret = 'source-api-fixture-session-secret-over-32-characters';
  const server = createPacksmartServer({ ...f.env, NODE_ENV: 'test', SESSION_SECRET: secret, SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' }, { fetchImpl: f.fetchImpl, schedulerEnabled: false, agentOpsEnabled: false });
  t.after(async () => { await server.packsmart.drain(); if (server.listening) await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  f.state.users[0].passwordChangeRequired = false; await server.packsmart.store.save(WS, f.state);
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  const token = createSessionToken({ workspaceId: WS, userId: f.state.users[0].id, email: f.state.users[0].email, role: 'owner', sessionVersion: 1 }, secret), csrf = verifySessionToken(token, secret).csrf;
  const request = async (route, body, { identity = true, tokenCsrf = csrf, method = 'POST' } = {}) => fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(identity ? { Cookie: `packsmart_session=${token}`, 'X-CSRF-Token': tokenCsrf } : {}) }, body: JSON.stringify(body) });
  const route = '/api/connections/shopify/sync';
  assert.equal((await request(route, { areas: ['orders'], automatic: false }, { identity: false })).status, 401);
  assert.equal((await request(route, { areas: ['orders'] }, { tokenCsrf: 'invalid' })).status, 403); assert.equal(f.calls.length, 0);
  assert.equal((await request(route, { areas: ['orders'], workspaceId: 'foreign', sourceReadRef: 'forged' })).status, 200); assert.equal(f.calls.length, 1);
  const stored = await server.packsmart.store.get(WS), captured = stored.orders[0], reference = captured.sourceReadRef;
  assert.match(reference, /^sor1:[a-f0-9]{64}$/); assert.equal(captured.total, '100.00');
  const edited = await request(`/api/orders/${encodeURIComponent(captured.id)}/economics`, { actualShippingCost: 5, total: '999', currentTotal: '999', sourceReadRef: 'forged', sourceCurrencyOverrides: { total: 'USD' } }, { method: 'PUT' });
  assert.equal(edited.status, 200); const afterEdit = await server.packsmart.store.get(WS); const afterOrder = afterEdit.orders[0];
  assert.equal(afterOrder.total, '100.00'); assert.equal(afterOrder.currentTotal, '100.00'); assert.equal(afterOrder.sourceReadRef, reference); assert.equal(afterOrder.sourceCurrencyOverrides, undefined); assert.equal(afterOrder.actualShippingCost, 5);
  const beforeFailure = preserved(afterEdit); f.setReply(() => ({ data: { orders: { nodes: [], pageInfo: {} } } }));
  assert.equal((await request('/api/integrations/shopify/sync', {})).status, 422);
  const failed = await server.packsmart.store.get(WS); assert.deepEqual(preserved(failed), beforeFailure); assert.ok(failed.integrationStatus.shopify.orderReadHold); assert.equal(failed.orders[0].sourceReadRef, reference);
});

test('malformed response envelopes and retained order containers are structural before network retries or merges', async () => {
  for (const payload of [null, false, [], 'invalid']) {
    const f = fixture(); const before = preserved(f.state); f.setReply(() => Response.json(payload));
    await assert.rejects(f.sync, { code: 'SHOPIFY_ORDER_SOURCE_RESPONSE_INVALID' }); assert.equal(f.calls.length, 1); assert.deepEqual(preserved(f.state), before); assert.ok(f.state.integrationStatus.shopify.orderReadHold);
  }
  for (const orders of [{}, [null]]) {
    const f = fixture(); f.state.orders = orders; const before = structuredClone(orders);
    await assert.rejects(f.sync, { code: 'SHOPIFY_ORDER_SOURCE_RETAINED_ORDER_INVALID' }); assert.equal(f.calls.length, 0); assert.deepEqual(f.state.orders, before); assert.ok(f.state.integrationStatus.shopify.orderReadHold);
  }
});

test('retained duplicate source identities preserve both owner-cost histories and stop before another read', async () => {
  for (const sameInternalId of [true, false]) {
    const f = fixture(); f.state.orders = [5,900].map((cost,index) => ({ id: sameInternalId ? 'same' : `internal-${index}`, externalId: 'same-source', provider: 'shopify', actualShippingCost: cost, costOverrides: { actualShippingCost: cost }, lineItems: [] }));
    const before = structuredClone(f.state.orders);
    await assert.rejects(f.sync, { code: 'SHOPIFY_ORDER_SOURCE_RETAINED_DUPLICATE' }); assert.deepEqual(f.state.orders, before); assert.equal(f.calls.length, 0);
  }
});

test('prospective typed reporting range rejects incompatible totals without rounding source evidence or inventing zeros', async () => {
  for (const amount of ['1000000000000', '-1000000000000', '9007199254740993.123456', '999999999999.995']) {
    const order = raw(); order.totalPriceSet = money(amount); const f = fixture([order]); const before = preserved(f.state);
    await assert.rejects(f.sync, { code: 'SHOPIFY_ORDER_SOURCE_REPORTING_AMOUNT_RANGE' }); assert.deepEqual(preserved(f.state), before); assert.equal(f.calls.length, 1); assert.ok(f.state.integrationStatus.shopify.orderReadHold);
  }
  for (const [amount,currency] of [['123.456','KWD'], ['0.000001','GBP'], ['999999999999.994','GBP']]) {
    const order = raw(); for (const field of ['totalPriceSet','currentTotalPriceSet','currentTotalTaxSet','currentTotalDiscountsSet','currentShippingPriceSet']) order[field] = money(amount,currency);
    const f = fixture([order]); await f.sync(); assert.equal(f.state.orders[0].total, amount); assert.equal(f.state.orders[0].currency, currency);
  }
  const missing = raw(); delete missing.totalPriceSet; const f = fixture([missing]); const before = preserved(f.state);
  await assert.rejects(f.sync, { code: 'SHOPIFY_ORDER_SOURCE_REPORTING_AMOUNT_UNAVAILABLE' }); assert.deepEqual(preserved(f.state), before);
});
