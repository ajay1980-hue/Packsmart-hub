import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IntegrationService, SHOPIFY_PRODUCTS_QUERY } from '../lib/integrations.mjs';
import { amount, hasAmount, hasCataloguePrice, unitEconomics } from '../lib/profit.mjs';
import { deriveOperations } from '../lib/operations.mjs';
import { detectOpportunities } from '../lib/control.mjs';
import { draftMarketingCampaign } from '../lib/marketing.mjs';

const now = new Date('2026-10-11T12:00:00Z');
const workspaceId = 'shopify-price-fixture';
const productId = 'gid://shopify/Product/701';
const image = 'https://example.invalid/synthetic-product.png';
const sources = ['admin', 'snapshot', 'public'];
const catalogueAreas = ['products', 'variants', 'inventory', 'prices'];
const costs = (landed = 6) => ({ landed, packing: 0, handling: 0, delivery: 0, paymentFee: 0, channelFee: 0, advertising: 0, otherVariable: 0 });
const invalidPrices = [
  ['omitted', undefined], ['null', null], ['blank', ''], ['whitespace', ' \t\n '],
  ['false', false], ['true', true], ['empty array', []], ['numeric array', [12.5]],
  ['object', {}], ['amount object', { amount: '12.50' }], ['value object', { value: '12.50' }],
  ['text', 'unknown'], ['hex', '0x10'], ['binary', '0b10'], ['octal', '0o10'],
  ['separator', '1_000'], ['comma', '1,000'], ['currency', '10 GBP'],
  ['NaN string', 'NaN'], ['positive infinity string', 'Infinity'], ['negative infinity string', '-Infinity'],
  ['overflow string', '1e309'], ['negative number', -1], ['negative decimal', '-0.01']
];
const validPrices = [
  ['numeric zero', 0, 0], ['decimal zero', '0.00', 0], ['string zero', '0', 0],
  ['signed decimal zero', '-0.00', -0], ['number', 12.5, 12.5], ['decimal', '12.50', 12.5],
  ['trimmed decimal', ' 12.50 ', 12.5], ['signed decimal', '+12.50', 12.5],
  ['trailing decimal', '12.', 12], ['fraction', '.25', 0.25], ['exponent', '1e2', 100],
  ['fraction exponent', '2.5E-1', 0.25]
];

function variant([label, price], index) {
  return { id: `gid://shopify/ProductVariant/${801 + index}`, title: label, sku: `PRICE-${index}`,
    ...(price === undefined ? {} : { price }), inventoryQuantity: 50, inventory_quantity: 50, available: true };
}

function product(source, variants) {
  const common = { id: productId, title: 'Synthetic packaging price fixture', handle: 'synthetic-price-fixture',
    status: 'ACTIVE', description: 'Synthetic catalogue description for isolated price evidence checks. '.repeat(2),
    body_html: '<p>Synthetic catalogue description for isolated price evidence checks.</p>',
    totalInventory: 50, inventory: 50, image: { src: image } };
  return source === 'admin'
    ? { ...common, featuredMedia: { preview: { image: { url: image } } }, variants: { nodes: variants, pageInfo: { hasNextPage: false } } }
    : { ...common, variants };
}

async function fixture(t, source, variants, { rawResponse = false, productOverrides = {} } = {}) {
  const state = { workspace: { id: workspaceId }, products: [], orders: [], economics: {}, integrationStatus: {} };
  const requests = [];
  const env = { SHOPIFY_ENV_WORKSPACE_ID: workspaceId, SHOPIFY_PUBLIC_STOREFRONT_URL: 'https://fixture.example.test' };
  const sourceProduct = { ...product(source, variants), ...productOverrides };
  const payload = source === 'admin'
    ? { data: { products: { nodes: [sourceProduct], pageInfo: { hasNextPage: false, endCursor: null } } } }
    : { products: [sourceProduct] };
  let repoRoot;
  if (source === 'snapshot') {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-shopify-price-'));
    t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
    await fs.mkdir(path.join(repoRoot, 'ebay-manager'));
    await fs.writeFile(path.join(repoRoot, 'ebay-manager/shopify-products.json'), JSON.stringify(payload));
    env.SHOPIFY_PUBLIC_SYNC_ENABLED = 'false';
  }
  if (source === 'admin') Object.assign(env, { SHOPIFY_STORE_DOMAIN: 'synthetic-price.myshopify.com', SHOPIFY_ADMIN_ACCESS_TOKEN: 'synthetic-test-token' });
  const service = new IntegrationService(env, { repoRoot, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    assert.notEqual(source, 'snapshot', 'Repository fixture must never perform a network read');
    if (source === 'admin') {
      assert.equal(url, 'https://synthetic-price.myshopify.com/admin/api/2026-07/graphql.json');
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      assert.equal(body.query, SHOPIFY_PRODUCTS_QUERY);
      assert.deepEqual(body.variables, { first: 50, after: null });
    } else {
      assert.equal(url, 'https://fixture.example.test/products.json?limit=250');
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, undefined);
    }
    assert.equal(options.redirect, 'error');
    // Only explicitly labelled non-JSON boundary tests bypass JSON serialization.
    return rawResponse ? { ok: true, json: async () => structuredClone(payload) } : Response.json(payload);
  } });
  return { service, state, requests };
}

async function sync(t, source, cases, options) {
  const f = await fixture(t, source, cases.map(variant), options);
  const status = await f.service.syncShopify(f.state, { areas: catalogueAreas });
  assert.equal(status.source, { admin: 'admin-graphql', snapshot: 'repository-snapshot', public: 'public-storefront' }[source]);
  assert.equal(f.requests.length, source === 'snapshot' ? 0 : 1, 'Each fixture has one bounded catalogue read');
  return f;
}

for (const source of sources) {
  test(`${source}: absent or malformed imported prices stay unknown through catalogue economics`, async t => {
    const { state } = await sync(t, source, invalidPrices);
    const variants = state.products[0].variants;
    assert.equal(variants.length, invalidPrices.length);
    for (const [index, mapped] of variants.entries()) {
      assert.equal(mapped.price, null, `${source}: ${invalidPrices[index][0]} must not become a selling price`);
      assert.equal(mapped.id, `gid://shopify/ProductVariant/${801 + index}`);
      assert.equal(mapped.externalId, mapped.id);
      assert.equal(mapped.inventory, source === 'public' ? null : 50);
      assert.equal(mapped.available, true);
      assert.equal(mapped.image, image);
      const result = unitEconomics(mapped, costs());
      assert.equal(result.complete, true);
      assert.equal(result.totalVariableCost, 6);
      assert.equal(result.contribution, null);
      assert.equal(result.margin, null);
      assert.equal(result.status, 'missing-price');
      state.economics[mapped.sku] = costs();
    }
    const operations = deriveOperations(state, { now });
    assert.equal(operations.costCoverage, 100);
    assert.equal(operations.negativeMargin, 0);
    assert.equal(operations.lowMargin, 0);
    assert.equal(operations.averageMargin, null);
    assert.equal(operations.marginCoveredVariants, 0);
    assert.deepEqual(operations.mostProfitable, []);
    assert.deepEqual(operations.leastProfitable, []);
    assert.ok(operations.productRows.every(row => row.price === null && row.status === 'missing-price'));
    detectOpportunities(state, 'synthetic-test', { now });
    assert.ok(!state.opportunities.some(row => row.kind === 'pricing'));
    state.economics = Object.fromEntries(variants.map(mapped => [mapped.sku, costs(0)]));
    state.marketing = { settings: { minMarginPercent: 0 } };
    assert.throws(() => draftMarketingCampaign(state, { now }), { code: 'NO_MARKETING_CANDIDATE' });
    assert.deepEqual(state.marketing.campaigns, [], 'Unknown price cannot manufacture a zero-price offer even with zero costs and margin floor');
  });

  test(`${source}: explicit zero and supported decimal prices retain their existing economics`, async t => {
    const { state } = await sync(t, source, validPrices);
    for (const [index, mapped] of state.products[0].variants.entries()) {
      const [label, , expected] = validPrices[index];
      assert.equal(mapped.price, expected, `${source}: ${label}`);
      assert.equal(hasCataloguePrice(mapped.price), true);
      if (expected === 0) {
        const zeroCost = unitEconomics(mapped, costs(0));
        assert.equal(zeroCost.contribution, 0);
        assert.equal(zeroCost.margin, null);
        assert.equal(zeroCost.status, 'margin-unavailable');
        const realLoss = unitEconomics(mapped, costs());
        assert.equal(realLoss.contribution, -6);
        assert.equal(realLoss.margin, null);
        assert.equal(realLoss.status, 'loss-making');
      } else {
        const result = unitEconomics(mapped, costs(0));
        assert.equal(result.contribution, expected);
        assert.equal(result.margin, 100);
        assert.equal(result.status, 'profitable');
      }
    }
    state.economics = Object.fromEntries(state.products[0].variants.map(mapped => [mapped.sku, costs(0)]));
    const zeroOnly = structuredClone(state);
    zeroOnly.products[0].variants = zeroOnly.products[0].variants.filter(mapped => mapped.price === 0);
    zeroOnly.marketing = { settings: { minMarginPercent: 0 } };
    assert.throws(() => draftMarketingCampaign(zeroOnly, { now }), { code: 'NO_MARKETING_CANDIDATE' });
    const campaign = draftMarketingCampaign(state, { now });
    assert.equal(campaign.product.price, 100);
    assert.match(campaign.copy.shortCaption, /from £100\.00\./);
  });
}

const nonfinitePrices = [['numeric NaN', NaN], ['numeric positive infinity', Infinity], ['numeric negative infinity', -Infinity]];
for (const source of sources) {
  test(`${source}: JSON wire serialization turns non-finite numbers into null, which remains unknown`, async t => {
    // NaN and Infinity are not JSON tokens. Response.json and snapshot files
    // serialize these fixture values as null, so this is explicitly a null-wire test.
    assert.deepEqual(JSON.parse(JSON.stringify(nonfinitePrices)).map(([, price]) => price), [null, null, null]);
    const { state } = await sync(t, source, nonfinitePrices);
    for (const mapped of state.products[0].variants) {
      assert.equal(mapped.price, null);
      assert.equal(unitEconomics(mapped, costs()).status, 'missing-price');
    }
  });
}

for (const source of ['admin', 'public']) {
  test(`${source}: synthetic parsed-response boundary rejects actual NaN and infinities`, async t => {
    // A mocked response.json() can return JavaScript values that standard JSON
    // cannot encode. This still exercises the real service and private mapper.
    const { state } = await sync(t, source, nonfinitePrices, { rawResponse: true });
    assert.deepEqual(state.products[0].variants.map(mapped => mapped.price), [null, null, null]);
    assert.ok(state.products[0].variants.every(mapped => unitEconomics(mapped, costs()).contribution === null));
  });
}

test('snapshot: valid JSON overflow literals decode to non-finite numbers and remain unknown', async t => {
  const rows = [['positive overflow', 'POSITIVE_OVERFLOW'], ['negative overflow', 'NEGATIVE_OVERFLOW']].map(variant);
  const f = await fixture(t, 'snapshot', rows);
  const encoded = JSON.stringify({ products: [product('snapshot', rows)] })
    .replace('"POSITIVE_OVERFLOW"', '1e400').replace('"NEGATIVE_OVERFLOW"', '-1e400');
  assert.deepEqual(JSON.parse(encoded).products[0].variants.map(row => row.price), [Infinity, -Infinity]);
  await fs.writeFile(path.join(f.service.repoRoot, 'ebay-manager/shopify-products.json'), encoded);
  await f.service.syncShopify(f.state, { areas: catalogueAreas });
  assert.deepEqual(f.state.products[0].variants.map(row => row.price), [null, null]);
  assert.equal(f.requests.length, 0);
});

for (const source of sources) {
  test(`${source}: price validation preserves inventory coercion, IDs and availability`, async t => {
    const inventoryCases = [
      ['omitted', undefined, null, true], ['null', null, null, true], ['blank', '', null, true],
      ['whitespace', ' ', 0, false], ['false', false, 0, false], ['true', true, 1, true],
      ['empty array', [], 0, false], ['numeric array', [5], 5, true], ['object', {}, null, true],
      ['amount wrapper', { amount: '7' }, 7, false], ['value wrapper', { value: '8' }, 8, false],
      ['negative stock', '-2', -2, false], ['decimal stock', '42', 42, true]
    ];
    const rows = inventoryCases.map(([label, inventory], index) => ({
      id: source === 'admin' ? `gid://shopify/ProductVariant/${901 + index}` : index === 0 ? undefined : 901 + index, sku: `INVENTORY-${index}`, title: label, price: ' ',
      inventoryQuantity: inventory, inventory_quantity: inventory,
      available: index === 0 ? false : index === 1 ? null : index === 2 ? 0 : true
    }));
    const f = await fixture(t, source, rows, { productOverrides: { id: source === 'admin' ? productId : 701, inventory: '42', totalInventory: { value: '42' } } });
    await f.service.syncShopify(f.state, { areas: catalogueAreas });
    const mappedProduct = f.state.products[0];
    assert.equal(mappedProduct.id, source === 'snapshot' ? '701' : productId);
    assert.equal(mappedProduct.externalId, mappedProduct.id);
    assert.equal(mappedProduct.inventory, source === 'public' ? null : 42);
    for (const [index, mapped] of mappedProduct.variants.entries()) {
      const [label, , expectedInventory, expectedAdminAvailability] = inventoryCases[index];
      assert.equal(mapped.price, null, label);
      assert.equal(mapped.inventory, source === 'public' ? null : expectedInventory, label);
      assert.equal(mapped.available, source === 'admin' ? expectedAdminAvailability : index !== 0, label);
      const expectedId = source === 'admin' ? `gid://shopify/ProductVariant/${901 + index}` : index === 0 ? '701-INVENTORY-0'
        : source === 'public' ? `gid://shopify/ProductVariant/${901 + index}` : String(901 + index);
      assert.equal(mapped.id, expectedId, label);
      assert.equal(mapped.externalId, index === 0 && source !== 'admin' ? 'INVENTORY-0' : expectedId, label);
    }
    assert.equal(f.requests.length, source === 'snapshot' ? 0 : 1);
  });
}

test('catalogue price validation does not tighten existing general numeric helpers', () => {
  assert.equal(hasAmount(-6), true, 'Recorded negative amounts remain supported');
  assert.equal(hasAmount('-6.25'), true);
  assert.equal(hasCataloguePrice('-6.25'), false);
  assert.equal(amount('0x10'), 16, 'General conversion is not replaced by catalogue validation');
  assert.equal(amount(false), 0);
  assert.equal(amount(''), 0);
  assert.equal(amount('not numeric', 9), 9);
});

test('Admin inventory-only sync preserves unselected retained prices, products and variants', async t => {
  const f = await fixture(t, 'admin', [variant(['omitted', undefined], 0), variant(['malformed', []], 1), variant(['changed', '99.99'], 2)]);
  const retainedVariants = [
    { id: 'gid://shopify/ProductVariant/801', sku: 'PRICE-0', price: 0, inventory: 2, available: false },
    { id: 'gid://shopify/ProductVariant/802', sku: 'PRICE-1', price: 12.5, inventory: 2, available: false },
    { id: 'gid://shopify/ProductVariant/803', sku: 'PRICE-2', price: null, inventory: 2, available: false },
    { id: 'gid://shopify/ProductVariant/804', sku: 'RETAINED', price: '9.75', inventory: 8, available: true }
  ];
  const retainedOtherProduct = { id: 'retained-other-product', provider: 'shopify', title: 'Retained product', variants: [{ id: 'retained-other-variant', price: 0 }] };
  f.state.products = [{ id: productId, provider: 'shopify', title: 'Retained title', inventory: 2, variants: structuredClone(retainedVariants) }, structuredClone(retainedOtherProduct)];
  f.state.orders = [{ id: 'retained-order', provider: 'shopify', total: 0 }];
  f.state.economics = { 'PRICE-0': costs() };
  const retainedOrders = structuredClone(f.state.orders), retainedEconomics = structuredClone(f.state.economics);
  await f.service.syncShopify(f.state, { areas: ['inventory'] });
  const mapped = f.state.products[0];
  assert.deepEqual(mapped.variants.map(row => row.price), [0, 12.5, null, '9.75']);
  assert.deepEqual(mapped.variants.slice(0, 3).map(row => row.inventory), [50, 50, 50]);
  assert.ok(mapped.variants.slice(0, 3).every(row => row.available === true));
  assert.deepEqual(mapped.variants[3], retainedVariants[3]);
  assert.equal(mapped.title, 'Retained title');
  assert.deepEqual(f.state.products[1], retainedOtherProduct);
  assert.deepEqual(f.state.orders, retainedOrders);
  assert.deepEqual(f.state.economics, retainedEconomics);
  assert.equal(f.requests.length, 1);
});
