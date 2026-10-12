import assert from 'node:assert/strict';
import test from 'node:test';
import { IntegrationService, SHOPIFY_PRODUCTS_QUERY } from '../lib/integrations.mjs';
import { inspectShopifyCataloguePage } from '../lib/shopify-catalogue-read.mjs';

const WS = 'catalogue-integrity-test';
const areas = ['products', 'variants', 'inventory', 'prices'];
const gid = (type, id) => `gid://shopify/${type}/${id}`;
const variant = id => ({ id: gid('ProductVariant', id), title: 'Synthetic variant', sku: `SYN-${id}`, price: '0.00', inventoryQuantity: 3 });
const product = (id = 1, count = 1) => ({ id: gid('Product', id), title: 'Synthetic product', description: 'Synthetic description', status: 'ACTIVE',
  totalInventory: 3, variants: { nodes: Array.from({ length: count }, (_, i) => variant(id * 1000 + i)), pageInfo: { hasNextPage: false } } });
const page = (nodes = [product()], hasNextPage = false, endCursor = null) => ({ products: { nodes, pageInfo: { hasNextPage, endCursor } } });
const context = () => ({ workspaceId: WS, after: null, seenProductIds: new Set(), seenVariantIds: new Set(), seenCursors: new Set() });
const inspect = data => inspectShopifyCataloguePage(data, context());

function fixture(replies = [page()]) {
  const calls = [];
  const state = { workspace: { id: WS }, products: [{ id: gid('Product', 91), provider: 'shopify', title: 'Retained catalogue',
    variants: [{ id: gid('ProductVariant', 91000), sku: 'RETAINED', price: 7, inventory: 2 }] }],
    orders: [{ id: 'retained-order', provider: 'shopify', total: 12, lineItems: [] }], economics: { RETAINED: { landed: 0 } }, integrationStatus: {} };
  const service = new IntegrationService({ SHOPIFY_ENV_WORKSPACE_ID: WS, SHOPIFY_STORE_DOMAIN: 'catalogue-fixture.myshopify.com',
    SHOPIFY_ADMIN_ACCESS_TOKEN: 'synthetic-test-token' }, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://catalogue-fixture.myshopify.com/admin/api/2026-07/graphql.json');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body); calls.push(body);
    if (body.query.includes('PacksmartOpsOrders')) return Response.json({ data: { orders: { nodes: [], pageInfo: { hasNextPage: false } } } }, { headers: { 'X-Shopify-API-Version': '2026-07' } });
    assert.equal(body.query, SHOPIFY_PRODUCTS_QUERY);
    const index = calls.filter(call => call.query === SHOPIFY_PRODUCTS_QUERY).length - 1;
    assert.ok(index < replies.length, 'No extra provider read or automatic retry');
    return Response.json({ data: replies[index] });
  } });
  return { state, service, calls, sync: selected => service.syncShopify(state, { areas: selected || areas }) };
}

async function rejected(data, { code, requests = 1, selected, pages = false } = {}) {
  const f = fixture(pages ? data : [data]);
  const original = f.state.products, before = JSON.stringify({ products: f.state.products, orders: f.state.orders, economics: f.state.economics });
  await assert.rejects(f.sync(selected), error => {
    assert.match(error.code, /^SHOPIFY_(?:CATALOGUE|VARIANT|PRODUCT)_/);
    if (code) assert.equal(error.code, code);
    assert.equal(error.status, 502);
    assert.doesNotMatch(error.message, /private-provider-detail|foreign-workspace/);
    return true;
  });
  assert.equal(f.state.products, original, 'Rejected candidate does not replace the retained array');
  assert.equal(JSON.stringify({ products: f.state.products, orders: f.state.orders, economics: f.state.economics }), before);
  assert.equal(f.calls.length, requests);
  return f;
}

const malformed = [
  ['missing data', () => undefined], ['null data', () => null], ['array data', () => []],
  ['missing products', () => ({})], ['null products', () => ({ products: null })], ['array products', () => ({ products: [] })],
  ['missing nodes', d => { delete d.products.nodes; return d; }], ['null nodes', d => { d.products.nodes = null; return d; }],
  ['object nodes', d => { d.products.nodes = {}; return d; }], ['null product', d => { d.products.nodes = [null]; return d; }],
  ['missing product metadata', d => { delete d.products.pageInfo; return d; }], ['null product metadata', d => { d.products.pageInfo = null; return d; }],
  ['missing product terminal flag', d => { delete d.products.pageInfo.hasNextPage; return d; }],
  ['missing variants', d => { delete d.products.nodes[0].variants; return d; }], ['null variants', d => { d.products.nodes[0].variants = null; return d; }],
  ['missing variant nodes', d => { delete d.products.nodes[0].variants.nodes; return d; }],
  ['null variant', d => { d.products.nodes[0].variants.nodes = [null]; return d; }],
  ['missing variant metadata', d => { delete d.products.nodes[0].variants.pageInfo; return d; }],
  ['missing variant terminal flag', d => { delete d.products.nodes[0].variants.pageInfo.hasNextPage; return d; }],
  ['missing product identity', d => { delete d.products.nodes[0].id; return d; }],
  ['missing variant identity', d => { delete d.products.nodes[0].variants.nodes[0].id; return d; }],
  ['duplicate product identity', d => { d.products.nodes.push(structuredClone(d.products.nodes[0])); return d; }],
  ['duplicate variant identity', d => { d.products.nodes[0].variants.nodes.push(structuredClone(d.products.nodes[0].variants.nodes[0])); return d; }],
  ['duplicate variant under another parent', d => { const p = product(2); p.variants.nodes[0].id = d.products.nodes[0].variants.nodes[0].id; d.products.nodes.push(p); return d; }],
  ['too many products', () => page(Array.from({ length: 51 }, (_, i) => product(i + 1)))],
  ['too many variants', () => page([product(1, 101)])],
  ['nonterminal empty page', () => page([], true, 'opaque-next')],
  ['foreign data marker', d => ({ ...d, workspaceId: 'foreign-workspace' })],
  ['foreign connection marker', d => { d.products.tenant_id = 'foreign-workspace'; return d; }],
  ['foreign product marker', d => { d.products.nodes[0].workspace = { id: 'foreign-workspace' }; return d; }],
  ['foreign variant marker', d => { d.products.nodes[0].variants.nodes[0].tenantId = 'foreign-workspace'; return d; }]
];
for (const [label, mutate] of malformed) test(`Admin catalogue refuses ${label} and preserves prior records`, async () => rejected(mutate(page())));

for (const flag of [null, 'false', 'true', 0, 1, [], {}]) {
  test(`Admin catalogue refuses nonboolean product terminal flag ${JSON.stringify(flag)}`, async () => {
    const d = page(); d.products.pageInfo.hasNextPage = flag; await rejected(d);
  });
  test(`Admin catalogue refuses nonboolean variant terminal flag ${JSON.stringify(flag)}`, async () => {
    const d = page(); d.products.nodes[0].variants.pageInfo.hasNextPage = flag; await rejected(d);
  });
}

for (const id of [null, 1, true, {}, ['1'], '', 'undefined', '1', ' gid://shopify/Product/1', 'gid://shopify/Order/1', 'gid://shopify/Product/1?x=1', 'gid://shopify/Product/' + '1'.repeat(257)]) {
  test(`Admin catalogue rejects unsupported product identity ${JSON.stringify(id).slice(0, 80)}`, async () => {
    const d = page(); d.products.nodes[0].id = id; await rejected(d);
  });
}

test('Variant identities require the exact ProductVariant resource', async () => {
  for (const id of [false, 'gid://shopify/Product/1', 'gid://shopify/ProductVariant/1\n', 'gid://shopify/ProductVariant/1?x=1']) {
    const d = page(); d.products.nodes[0].variants.nodes[0].id = id; await rejected(d);
  }
});

test('Explicit further variant pages retain the existing overflow error', async () => {
  const d = page(); d.products.nodes[0].variants.pageInfo.hasNextPage = true;
  await rejected(d, { code: 'SHOPIFY_VARIANT_COVERAGE_LIMIT' });
});

test('Continuation requires a usable bounded cursor without an automatic retry', async () => {
  for (const cursor of [undefined, null, '', 1, {}, 'x'.repeat(4097), '£'.repeat(2049)]) {
    await rejected(page([product()], true, cursor));
  }
});

test('Repeated and cyclic cursors stop before another read and install no prefix', async () => {
  await rejected([page([product(1)], true, 'cursor-A'), page([product(2)], true, 'cursor-A')], { requests: 2, pages: true });
  await rejected([page([product(1)], true, 'cursor-A'), page([product(2)], true, 'cursor-B'), page([product(3)], true, 'cursor-A')], { requests: 3, pages: true });
});

test('Cross-page product and variant identity duplicates reject the complete candidate', async () => {
  await rejected([page([product(1)], true, 'cursor-A'), page([product(1)])], { requests: 2, pages: true });
  const p = product(2); p.variants.nodes[0].id = gid('ProductVariant', 1000);
  await rejected([page([product(1)], true, 'cursor-A'), page([p])], { requests: 2, pages: true });
});

test('A malformed later page preserves all previous products without installing the first page', async () => {
  await rejected([page([product(1)], true, 'cursor-A'), {}], { requests: 2, pages: true });
});

test('Tenth nonterminal page preserves existing product coverage error and request ceiling', async () => {
  const pages = Array.from({ length: 10 }, (_, i) => page([product(i + 1)], true, `cursor-${i}`));
  await rejected(pages, { requests: 10, pages: true, code: 'SHOPIFY_PRODUCT_COVERAGE_LIMIT' });
});

test('Valid empty terminal catalogue is distinct from a missing connection', async () => {
  for (const endCursor of [null, undefined, 'opaque-terminal']) {
    const f = fixture([page([], false, endCursor)]); await f.sync();
    assert.deepEqual(f.state.products, []); assert.equal(f.calls.length, 1);
  }
});

test('Valid pagination returns each product exactly once with unchanged opaque variables', async () => {
  const cursors = ['opaque:/A+==', '£'.repeat(2048)];
  const f = fixture([page([product(1)], true, cursors[0]), page([product(2)], true, cursors[1]), page([product(3)])]);
  await f.sync();
  assert.deepEqual(f.calls.map(call => call.variables), [{ first: 50, after: null }, { first: 50, after: cursors[0] }, { first: 50, after: cursors[1] }]);
  assert.deepEqual(f.state.products.map(row => row.id), [1, 2, 3].map(id => gid('Product', id)));
  assert.ok(f.state.products.every(row => row.variants[0].price === 0));
});

test('Exact 50-product/100-variant page limits pass without truncation', async () => {
  const f = fixture([page(Array.from({ length: 50 }, (_, i) => product(i + 1, 100)))]);
  await f.sync(); assert.equal(f.calls.length, 1); assert.equal(f.state.products.length, 50);
  assert.equal(f.state.products.flatMap(row => row.variants).length, 5000);
});

test('Ten valid terminal pages preserve the existing maximum request count', async () => {
  const f = fixture(Array.from({ length: 10 }, (_, i) => page([product(i + 1)], i < 9, i < 9 ? `cursor-${i}` : null)));
  await f.sync(); assert.equal(f.calls.length, 10); assert.equal(f.state.products.length, 10);
});

test('Rejected mixed catalogue/order sync preserves both prior collections', async () => {
  const f = await rejected({}, { selected: [...areas, 'orders'], requests: 2 });
  assert.equal(f.calls.filter(call => call.query.includes('PacksmartOpsOrders')).length, 1);
});

test('Unselected catalogue is never requested during an order-only import', async () => {
  const f = fixture([]), before = structuredClone(f.state.products);
  await f.sync(['orders']); assert.deepEqual(f.state.products, before);
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].query, /PacksmartOpsOrders/);
});

test('Pure validation rejects sparse arrays and accessors without invoking them', () => {
  const sparse = page(); sparse.products.nodes = new Array(1); assert.throws(() => inspect(sparse));
  const sparseVariants = page(); sparseVariants.products.nodes[0].variants.nodes = new Array(1); assert.throws(() => inspect(sparseVariants));
  let getters = 0;
  for (const mutate of [
    d => Object.defineProperty(d, 'products', { get() { getters++; return page().products; } }),
    d => Object.defineProperty(d.products.pageInfo, 'hasNextPage', { get() { getters++; return false; } }),
    d => Object.defineProperty(d.products.nodes[0], 'id', { get() { getters++; return gid('Product', 1); } })
  ]) { const d = page(); mutate(d); assert.throws(() => inspect(d)); }
  assert.equal(getters, 0);
});

test('Pure validation is side-effect free for prior identity sets and response objects', () => {
  const d = page(), ctx = context(), before = JSON.stringify(d);
  const result = inspectShopifyCataloguePage(d, ctx);
  assert.deepEqual(result.productIds, [gid('Product', 1)]);
  assert.deepEqual(result.variantIds, [gid('ProductVariant', 1000)]);
  assert.equal(ctx.seenProductIds.size, 0); assert.equal(ctx.seenVariantIds.size, 0); assert.equal(ctx.seenCursors.size, 0);
  assert.equal(JSON.stringify(d), before);
  ctx.seenProductIds.add(gid('Product', 1)); assert.throws(() => inspectShopifyCataloguePage(d, ctx));
  assert.equal(ctx.seenProductIds.size, 1); assert.equal(ctx.seenVariantIds.size, 0);
});

test('Matching explicit scope is accepted but grants no retained provenance', async () => {
  const d = page(); d.workspaceId = WS; d.products.tenant = { id: WS }; d.products.nodes[0].workspace_id = WS;
  const f = fixture([d]); await f.sync();
  assert.equal(f.state.products[0].financialEvidence, undefined);
  assert.equal(f.state.products[0].provenance, undefined);
  assert.equal(f.state.products[0].variants[0].qualified, undefined);
});
