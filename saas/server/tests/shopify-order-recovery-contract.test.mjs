import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IntegrationService } from '../lib/integrations.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { encryptCredentials } from '../lib/security.mjs';
import { inspectShopifyOrderSource, prepareShopifyOrderRead, shopifyOrderReadWindow } from '../lib/shopify-order-source.mjs';
import { createShopifyOrderRecoveryBinding, createShopifyOrderRecoveryStage, validateShopifyOrderRecoveryStage,
  appendShopifyOrderRecoveryPage, resumeShopifyOrderRecoveryStage, createShopifyOrderRecoveryCapability,
  getShopifyOrderRecoveryStage, shopifyOrderRecoverySummary, shopifyOrderRecoveryFingerprint,
  shopifyOrderRecoveryLogicalBytes, SHOPIFY_ORDER_RECOVERY_LIMITS } from '../lib/shopify-order-recovery.mjs';

const AT = '2026-10-09T05:00:00.000Z', SOURCE_AT = '2026-10-09T04:59:00.000Z', WS = 'recovery-contract', KEY = 'synthetic-recovery-encryption-key-only';
const REV = '11111111-2222-4333-8444-555555555555';
const money = (amount = '100.00', currencyCode = 'GBP') => ({ shopMoney: { amount, currencyCode } });
export function recoveryRaw(id = 'one') {
  return { id: `gid://shopify/Order/${id}`, name: `#${id}`, createdAt: SOURCE_AT, updatedAt: SOURCE_AT, cancelledAt: null,
    displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED', totalPriceSet: money(), currentTotalPriceSet: money('95.25'),
    currentTotalTaxSet: money('16.67'), currentTotalDiscountsSet: money('0.00'), currentShippingPriceSet: money('3.00'), paymentGatewayNames: ['shopify_payments'],
    lineItems: { nodes: [{ id: `gid://shopify/LineItem/${id}`, name: 'Synthetic line', sku: 'SKU', quantity: 1,
      originalTotalSet: money('100.00'), discountedTotalSet: money('95.25') }], pageInfo: { hasNextPage: false } } };
}
const admission = (attempt = 1, extra = {}) => ({ runId: `sync-${attempt}`, leaseUntil: '2026-10-09T05:10:00.000Z', attempt,
  workspaceRevision: REV, actorId: 'owner', actorSessionVersion: 1, sessionDigest: 'a'.repeat(64), ...extra });
function fixture(t, rows = [recoveryRaw()], config = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(AT) });
  const state = seedWorkspaceState({}, { workspaceId: WS }); state._revision = REV;
  state.connections = [{ id: 'shop-connection', provider: 'shopify', status: 'connected', metadata: { shopId: 'shop-id', shopDomain: 'fixture.myshopify.com' },
    encryptedCredentials: encryptCredentials({ mode: 'oauth', storeDomain: 'fixture.myshopify.com', accessToken: 'synthetic-token', ...config }, KEY) }];
  state.orders = [{ id: 'old-order', provider: 'shopify', total: 12, lineItems: [] }];
  const calls = [], checkpoints = [], authority = [];
  let reply = ({ after }) => { const offset = after === null ? 0 : Number(after.split(':')[1]), nodes = rows.slice(offset, offset + 50), next = offset + nodes.length;
    return { data: { orders: { nodes, pageInfo: { hasNextPage: next < rows.length, endCursor: next < rows.length ? `cursor:${next}` : null } } } }; };
  const service = new IntegrationService({ CREDENTIALS_KEY: KEY }, { fetchImpl: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) }); const payload = reply(calls.at(-1).body.variables, calls.length);
    return payload instanceof Response ? payload : Response.json(payload, { headers: { 'X-Shopify-API-Version': '2026-07' } });
  } });
  const binding = createShopifyOrderRecoveryBinding(state, service, { startedAt: AT });
  const stage = createShopifyOrderRecoveryStage({ id: 'retained-stage', binding, admission: admission() });
  const capability = createShopifyOrderRecoveryCapability({ stage, assertCurrent: ({ phase }) => { authority.push(phase); },
    appendPage: (page, next) => { checkpoints.push({ page, next }); }, atomicAppend: true });
  return { state, service, calls, checkpoints, authority, stage, capability,
    setReply(value) { reply = value; }, sync: () => service.syncShopify(state, { areas: ['orders'], orderRecovery: capability }) };
}
function recharged(stage) { stage.logicalBytes = shopifyOrderRecoveryLogicalBytes(stage); return stage; }
const recoveryError = error => /^(SHOPIFY_ORDER_(RECOVERY|SOURCE)_|ORDER_RECOVERY_)/.test(error.code);

test('recovery reads only orders through the existing importer and emits v3 original observation', async t => {
  const f = fixture(t); await f.sync();
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].body.query, /query PacksmartOpsOrders/);
  assert.deepEqual(f.calls[0].body.variables, { first: 50, after: null, query: f.stage.binding.window.query });
  assert.deepEqual(f.authority, ['before_token', 'before_fetch']); assert.equal(f.checkpoints.length, 1);
  const read = f.state.channelData.shopify.orderReads, manifest = read.manifests[read.lastSuccess];
  assert.match(read.lastSuccess, /^sor3:/); assert.equal(manifest.schema, 'shopify-order-read/v3');
  assert.deepEqual(manifest.recovery, { schema: 'shopify-order-recovery-observation/v1', stageId: 'retained-stage', continued: false,
    originalStartedAt: AT, lastCapturedAt: AT, pageCaptureTimes: [AT], snapshotConsistency: 'unverified' });
  assert.equal(manifest.sourceAccountId, null); assert.equal(manifest.startedAt, AT);
  assert.equal(f.state.integrationStatus.shopify.lastSyncAt, AT); assert.equal(getShopifyOrderRecoveryStage(f.capability).status, 'complete');
  assert.equal(inspectShopifyOrderSource(f.state, f.state.orders[0], WS).manifestStatus, 'retained');
  assert.ok(Buffer.byteLength(JSON.stringify(manifest)) <= 4096);
  assert.throws(() => validateShopifyOrderRecoveryStage(JSON.parse(JSON.stringify({ ...f.stage, pages: 'not-an-array' }))), recoveryError);
});

test('ordinary v1/v2 manifests preserve exact original layouts and references', async t => {
  const f = fixture(t); const read = await f.service.fetchShopifyOrders(f.service.shopifyConfig(f.state));
  assert.equal(read.manifest.schema, 'shopify-order-read/v2'); assert.match(read.ref, /^sor2:/);
  assert.equal(Object.hasOwn(read.manifest, 'recovery'), false);
  const orders = read.orders.map(({ sourceReadRef, ...order }) => order), config = f.service.shopifyConfig(f.state);
  const legacy = prepareShopifyOrderRead(config, orders, read.manifest.pages, { query: 'created_at:>=2026-07-11', startedAt: AT, finishedAt: AT, legacyBytes: read.legacyBytes });
  assert.equal(legacy.manifest.schema, 'shopify-order-read/v1'); assert.match(legacy.ref, /^sor1:/);
  for (const key of ['recovery', 'requestedLowerBound', 'sortKey', 'reverse']) assert.equal(Object.hasOwn(legacy.manifest, key), false);
  for (const result of [read, legacy]) {
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    const digest = createHash('sha256').update(JSON.stringify(canonical(result.manifest))).digest('hex');
    assert.equal(result.ref, `${result === read ? 'sor2' : 'sor1'}:${digest}`);
  }
});

test('restart rehydrates prefix and retains original window, capture times and current actor authority', async t => {
  const f = fixture(t, Array.from({ length: 51 }, (_, i) => recoveryRaw(i)));
  f.setReply((variables, count) => {
    if (count === 2) throw new Error('synthetic interruption');
    return { data: { orders: { nodes: Array.from({ length: 50 }, (_, i) => recoveryRaw(i)), pageInfo: { hasNextPage: true, endCursor: 'original-cursor' } } } };
  });
  await assert.rejects(f.sync(), /synthetic interruption/);
  const retained = getShopifyOrderRecoveryStage(f.capability); assert.equal(retained.pages.length, 1); assert.equal(f.state.orders.length, 1);
  t.mock.timers.tick(120000);
  const resumed = resumeShopifyOrderRecoveryStage(JSON.parse(JSON.stringify(retained)), admission(2, { actorId: 'other-admin', actorSessionVersion: 3 }));
  const cap = createShopifyOrderRecoveryCapability({ stage: resumed, assertCurrent: () => {}, appendPage: () => {}, atomicAppend: true });
  f.setReply(variables => { assert.equal(variables.after, 'original-cursor'); assert.equal(variables.query, f.stage.binding.window.query);
    return { data: { orders: { nodes: [recoveryRaw(50)], pageInfo: { hasNextPage: false, endCursor: null } } } }; });
  await f.service.syncShopify(f.state, { areas: ['orders'], orderRecovery: cap });
  assert.equal(f.calls.length, 3); assert.equal(f.state.orders.length, 52);
  const reads = f.state.channelData.shopify.orderReads, manifest = reads.manifests[reads.lastSuccess];
  assert.equal(manifest.startedAt, AT); assert.equal(manifest.finishedAt, '2026-10-09T05:02:00.000Z');
  assert.deepEqual(manifest.recovery.pageCaptureTimes, [AT, '2026-10-09T05:02:00.000Z']); assert.equal(manifest.recovery.continued, true);
  assert.equal(f.state.integrationStatus.shopify.lastSyncAt, AT);
});

test('JSON cannot mint a capability, replay a used capability or change selected areas', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.syncShopify(f.state, { areas: ['orders'], orderRecovery: JSON.parse(JSON.stringify(f.capability)) }), recoveryError);
  await assert.rejects(f.service.syncShopify(f.state, { areas: ['orders', 'products'], orderRecovery: f.capability }), recoveryError);
  assert.equal(f.calls.length, 0); await f.sync();
  await assert.rejects(f.sync(), error => error.code === 'SHOPIFY_ORDER_RECOVERY_CAPABILITY_USED'); assert.equal(f.calls.length, 1);
});

for (const phase of ['before_token', 'before_fetch']) test(`fresh authority rejects ${phase} before provider dispatch`, async t => {
  const f = fixture(t); let credentials = 0;
  const original = f.service.connectorCredentials.bind(f.service); f.service.connectorCredentials = async (...args) => { credentials++; return original(...args); };
  const cap = createShopifyOrderRecoveryCapability({ stage: f.stage, assertCurrent: info => info.phase !== phase, appendPage: () => {}, atomicAppend: true });
  await assert.rejects(f.service.syncShopify(f.state, { areas: ['orders'], orderRecovery: cap }), recoveryError);
  assert.equal(f.calls.length, 0); assert.equal(credentials, phase === 'before_token' ? 0 : 1);
});

test('lease expiry during token await prevents provider dispatch', async t => {
  const f = fixture(t); f.service.connectorCredentials = async () => { t.mock.timers.tick(600001); return { accessToken: 'synthetic-token' }; };
  await assert.rejects(f.sync(), error => error.code === 'SHOPIFY_ORDER_RECOVERY_LEASE_EXPIRED'); assert.equal(f.calls.length, 0);
});

test('lease expiry during response prevents append, and unknown ACK never advances stage', async t => {
  const f = fixture(t); f.setReply(() => { t.mock.timers.tick(600001); return { data: { orders: { nodes: [recoveryRaw()], pageInfo: { hasNextPage: false, endCursor: null } } } }; });
  await assert.rejects(f.sync(), recoveryError); assert.equal(f.checkpoints.length, 0); assert.equal(getShopifyOrderRecoveryStage(f.capability).pages.length, 0);
});

test('uncertain append remains unpromoted and cannot reuse the capability', async t => {
  const f = fixture(t); let appends = 0;
  const cap = createShopifyOrderRecoveryCapability({ stage: f.stage, assertCurrent: () => {}, appendPage: () => { appends++; throw new Error('unknown ACK'); }, atomicAppend: true });
  await assert.rejects(f.service.syncShopify(f.state, { areas: ['orders'], orderRecovery: cap }), /unknown ACK/);
  assert.equal(getShopifyOrderRecoveryStage(cap).pages.length, 0); assert.equal(f.state.orders.length, 1); assert.equal(appends, 1);
  await assert.rejects(f.service.syncShopify(f.state, { areas: ['orders'], orderRecovery: cap }), recoveryError); assert.equal(f.calls.length, 1);
});

for (const mode of ['oauth', 'direct']) test(`recovery ${mode} cannot exchange or refresh credentials`, async t => {
  const f = fixture(t, [recoveryRaw()], mode === 'oauth' ? { expiresAt: Date.parse(AT) + 1000, refreshToken: 'synthetic-refresh' }
    : { mode: 'direct', accessToken: '', clientId: 'synthetic-client', clientSecret: 'synthetic-secret' });
  await assert.rejects(f.sync(), recoveryError); assert.equal(f.calls.length, 0); assert.equal(f.checkpoints.length, 0);
});

const rawMutations = {
  'invalid final identity': rows => { rows[1].id = ''; },
  'duplicate IDs': rows => { rows[1].id = rows[0].id; },
  'unexhausted lines': rows => { rows[1].lineItems.pageInfo.hasNextPage = true; },
  'duplicate line IDs': rows => { rows[1].lineItems.nodes.push({ ...rows[1].lineItems.nodes[0] }); },
  'unsafe quantity': rows => { rows[1].lineItems.nodes[0].quantity = Number.MAX_SAFE_INTEGER + 1; },
  'numeric source amount': rows => { rows[1].currentTotalPriceSet.shopMoney.amount = 1; },
  'invalid currency': rows => { rows[1].currentTotalPriceSet.shopMoney.currencyCode = 'gbp'; },
  'invalid timestamp': rows => { rows[1].updatedAt = 'yesterday'; },
  'outside upper bound': rows => { rows[1].updatedAt = AT; },
  'outside lower bound': rows => { rows[1].updatedAt = '2020-01-01T00:00:00.000Z'; },
  'descending order': rows => { rows[1].updatedAt = '2026-10-09T04:58:00.000Z'; },
  'foreign workspace': rows => { rows[1].workspaceId = 'other-business'; }
};
for (const [name, mutate] of Object.entries(rawMutations)) test(`whole page rejects ${name} without any partial checkpoint`, async t => {
  const rows = [recoveryRaw('a'), recoveryRaw('b')]; mutate(rows); const f = fixture(t, rows);
  await assert.rejects(f.sync(), recoveryError); assert.equal(f.calls.length, 1); assert.equal(f.checkpoints.length, 0);
  assert.equal(getShopifyOrderRecoveryStage(f.capability).pages.length, 0); assert.equal(f.state.orders.length, 1);
});

test('maximum ten pages exhaust exactly; overflow retains paused full prefix without promotion', async t => {
  const f = fixture(t, Array.from({ length: 500 }, (_, i) => recoveryRaw(i))); await f.sync();
  assert.equal(f.calls.length, 10); assert.equal(getShopifyOrderRecoveryStage(f.capability).pages.length, 10);
  assert.equal(f.state.orders.length, 501);
});

test('eleventh page requirement pauses at ten pages and never claims a prefix complete', async t => {
  const f = fixture(t, Array.from({ length: 501 }, (_, i) => recoveryRaw(i)));
  await assert.rejects(f.sync(), error => error.code === 'SHOPIFY_ORDER_RECOVERY_PAGE_LIMIT');
  const retained = getShopifyOrderRecoveryStage(f.capability); assert.equal(retained.pages.length, 10); assert.equal(retained.status, 'paused');
  assert.equal(f.calls.length, 10); assert.equal(f.state.orders.length, 1);
  assert.throws(() => resumeShopifyOrderRecoveryStage(retained, admission(2)), recoveryError);
});

test('strict retained page schema, cursor chain, evidence, cost placeholders and byte accounting', async t => {
  const f = fixture(t); await f.sync(); const stage = getShopifyOrderRecoveryStage(f.capability);
  const mutations = [
    value => { value.binding.window.query += ' OR status:any'; }, value => { value.binding.source.connectionId = ''; },
    value => { value.binding.sourceGeneration = 'sor9:bad'; }, value => { value.binding.parserPolicy = 'future'; },
    value => { value.admissions[0].workspaceRevision = 1; }, value => { value.admissions[0].sessionDigest = ''; },
    value => { value.pages[0].orders[0].paymentFees = 0; }, value => { value.pages[0].orders[0].costOverrides = {}; },
    value => { value.pages[0].orders[0].sourceReadRef = 'sor3:' + 'a'.repeat(64); }, value => { value.pages[0].index = 1; },
    value => { value.pages[0].after = 'injected-cursor'; }, value => { value.pages[0].capturedAt = '2026-10-08T00:00:00.000Z'; },
    value => { value.pages[0].evidence.rows = 0; }, value => { value.pages[0].evidence.cursorDigest = 'a'.repeat(64); },
    value => { value.pages[0].evidence.apiVersion = '2026-08'; }, value => { value.pages[0].evidence.extra = true; },
    value => { value.legacyBytes++; }, value => { value.continued = true; }, value => { value.status = 'reading'; },
    value => { value.pages[0].orders[0].lineItems[0].sourceReadRef = 'anything'; },
    value => { value.pages[0].orders[0].sourceCurrencyOverrides = { 'lineItems/9/net': 'USD' }; }
  ];
  for (const mutate of mutations) { const corrupted = structuredClone(stage); mutate(corrupted); recharged(corrupted); assert.throws(() => validateShopifyOrderRecoveryStage(corrupted), recoveryError); }
  const changed = structuredClone(stage); changed.logicalBytes--; assert.throws(() => validateShopifyOrderRecoveryStage(changed), recoveryError);
  assert.equal(stage.legacyBytes, stage.pages[0].legacyBytes); assert.equal(stage.logicalBytes, shopifyOrderRecoveryLogicalBytes(stage));
  const summary = shopifyOrderRecoverySummary(stage); assert.equal(summary.ordersRead, 1); assert.deepEqual(summary.pageCaptureTimes, [AT]);
  assert.equal(Object.hasOwn(summary, 'pages'), false); assert.equal(Object.hasOwn(summary, 'after'), false);
});

test('five-admission ceiling is shared attempt debt and immutable initial first-sync evidence', t => {
  const f = fixture(t); f.state.connectionFirstSync = { shopify: { startedAt: SOURCE_AT, actor: 'initial-owner', identityVerifiedAt: SOURCE_AT, areas: { orders: 'failed' } } };
  const binding = createShopifyOrderRecoveryBinding(f.state, f.service, { startedAt: AT });
  let stage = createShopifyOrderRecoveryStage({ id: 'stage', binding, admission: admission(3) });
  stage = resumeShopifyOrderRecoveryStage(stage, admission(4, { actorId: 'new-owner' }));
  stage = resumeShopifyOrderRecoveryStage(stage, admission(5)); assert.equal(stage.admissions.length, 3);
  assert.equal(stage.binding.firstSync.actor, 'initial-owner'); assert.throws(() => resumeShopifyOrderRecoveryStage(stage, admission(6)), recoveryError);
  for (const status of ['paused', 'unknown', 'committed', 'superseded']) {
    const held = recharged({ ...structuredClone(f.stage), status });
    assert.throws(() => resumeShopifyOrderRecoveryStage(held, admission(2)), recoveryError);
  }
});

test('full recovery retains old rows and all user cost overrides', async t => {
  const f = fixture(t), costs = { actualShippingCost: 0, paymentFees: 2.1, channelFees: 3.2, advertisingCost: 4.3, otherVariableCosts: 5.4 };
  const original = structuredClone(f.state.orders[0]);
  f.state.orders.push({ ...original, id: recoveryRaw().id, externalId: recoveryRaw().id, ...costs, costOverrides: costs });
  await f.sync();
  assert.deepEqual(f.state.orders.find(row => row.id === 'old-order'), original);
  for (const [key, value] of Object.entries(costs)) assert.equal(f.state.orders[0][key], value);
  for (const key of Object.keys(costs)) assert.equal(getShopifyOrderRecoveryStage(f.capability).pages[0].orders[0][key], null);
});

test('stage size limits reject complete page atomically and fingerprints hash exact raw request bytes', async t => {
  const f = fixture(t); f.setReply(() => { const row = recoveryRaw(); row.name = 'x'.repeat(SHOPIFY_ORDER_RECOVERY_LIMITS.stageBytes);
    return { data: { orders: { nodes: [row], pageInfo: { hasNextPage: false, endCursor: null } } } }; });
  await assert.rejects(f.sync(), recoveryError); assert.equal(f.checkpoints.length, 0); assert.equal(f.state.orders.length, 1);
  assert.notEqual(shopifyOrderRecoveryFingerprint('{"a":1}'), shopifyOrderRecoveryFingerprint('{ "a": 1 }'));
  assert.equal(shopifyOrderRecoveryFingerprint({ a: 1, b: 2 }), shopifyOrderRecoveryFingerprint({ b: 2, a: 1 }));
});

test('validated capacity overflow reaches one durable pause callback with no partial page', async t => {
  const rows = Array.from({ length: 51 }, (_, index) => ({ ...recoveryRaw(index), name: 'x'.repeat(index < 50 ? 25000 : 900000) }));
  const f = fixture(t, rows), appended = [];
  const cap = createShopifyOrderRecoveryCapability({ stage: f.stage, assertCurrent: () => {}, atomicAppend: true,
    appendPage: (page, next) => { appended.push({ page, next }); return { confirmed: true }; } });
  await assert.rejects(f.service.syncShopify(f.state, { areas: ['orders'], orderRecovery: cap }), error => error.code === 'SHOPIFY_ORDER_RECOVERY_STAGE_LIMIT');
  assert.equal(appended.length, 2); assert.equal(appended[0].next.pages.length, 1); assert.equal(appended[1].next, null);
  assert.equal(appended[1].page.orders.length, 1); assert.equal(getShopifyOrderRecoveryStage(cap).pages.length, 1); assert.equal(f.state.orders.length, 1);
});

test('invalid page fails validation before capacity pause mutation', async t => {
  const rows = Array.from({ length: 51 }, (_, index) => ({ ...recoveryRaw(index), name: 'x'.repeat(index < 50 ? 25000 : 900000) }));
  rows[50].updatedAt = AT; const f = fixture(t, rows);
  await assert.rejects(f.sync(), error => error.code === 'SHOPIFY_ORDER_RECOVERY_ORDER_WINDOW_INVALID');
  assert.equal(f.checkpoints.length, 1); assert.equal(getShopifyOrderRecoveryStage(f.capability).pages.length, 1);
});

test('conservative mutable-control charge cannot grow on supersession or pause at full quota', t => {
  const f = fixture(t), initial = f.stage.logicalBytes;
  for (const status of ['failed', 'paused', 'unknown', 'superseded']) {
    const stage = { ...structuredClone(f.stage), status, revision: 16 };
    assert.equal(shopifyOrderRecoveryLogicalBytes(stage), initial); validateShopifyOrderRecoveryStage(stage);
  }
  const tooMany = recharged({ ...structuredClone(f.stage), revision: 100 });
  assert.throws(() => validateShopifyOrderRecoveryStage(tooMany), recoveryError);
});


for (const status of ['pending', 'running', 'failed']) test(`verified unfinished first-sync orders ${status} retain exact original evidence`, t => {
  const f = fixture(t), first = { status: 'partial', startedAt: SOURCE_AT, actor: 'initial-owner', identityVerifiedAt: SOURCE_AT,
    areas: { orders: status, products: 'failed' }, failures: { products: 'synthetic failure' }, completedAt: null };
  f.state.connectionFirstSync = { shopify: first };
  const before = structuredClone(first), binding = createShopifyOrderRecoveryBinding(f.state, f.service, { startedAt: AT });
  assert.deepEqual(binding.firstSync, { startedAt: SOURCE_AT, actor: 'initial-owner', identityVerifiedAt: SOURCE_AT });
  assert.deepEqual(f.state.connectionFirstSync.shopify, before);
  binding.firstSync.identityVerifiedAt = null;
  assert.throws(() => createShopifyOrderRecoveryStage({ id: 'invalid-first-sync', binding, admission: admission() }), recoveryError);
});

const unboundFirstSync = [
  ['completed orders', { areas: { orders: 'completed', products: 'failed' } }],
  ['missing orders', { areas: { products: 'failed' } }],
  ['unknown orders status', { areas: { orders: 'unknown' } }],
  ['missing verification', { identityVerifiedAt: undefined }],
  ['null verification', { identityVerifiedAt: null }],
  ['invalid verification', { identityVerifiedAt: 'yesterday' }],
  ['missing start', { startedAt: undefined }],
  ['invalid start', { startedAt: 'yesterday' }],
  ['missing actor', { actor: undefined }],
  ['empty actor', { actor: '' }],
  ['invalid actor', { actor: ' owner ' }]
];
for (const [name, change] of unboundFirstSync) test(`later order recovery excludes and preserves first-sync history with ${name}`, async t => {
  const f = fixture(t);
  f.state.connectionFirstSync = { shopify: { status: 'partial', startedAt: SOURCE_AT, actor: 'initial-owner', identityVerifiedAt: SOURCE_AT,
    areas: { orders: 'failed', products: 'failed' }, failures: { products: 'synthetic failure' }, completedAt: '2026-10-08T01:00:00.000Z', ...change } };
  const before = structuredClone(f.state.connectionFirstSync.shopify), binding = createShopifyOrderRecoveryBinding(f.state, f.service, { startedAt: AT });
  assert.equal(binding.firstSync, null);
  const stage = createShopifyOrderRecoveryStage({ id: 'later-recovery', binding, admission: admission() });
  const cap = createShopifyOrderRecoveryCapability({ stage, assertCurrent: () => {}, appendPage: () => {}, atomicAppend: true });
  await f.service.syncShopify(f.state, { areas: ['orders'], orderRecovery: cap });
  assert.deepEqual(f.state.connectionFirstSync.shopify, before);
});
