import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  IntegrationService,
  SHOPIFY_ORDERS_QUERY,
  SHOPIFY_PRODUCTS_QUERY
} from '../lib/integrations.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('Shopify snapshot remains a safe server-side fallback', async () => {
  const service = new IntegrationService({}, { repoRoot });
  const state = { products: [], orders: [], integrationStatus: {} };
  const status = await service.syncShopify(state);
  assert.equal(status.status, 'degraded');
  assert.equal(status.source, 'repository-snapshot');
  assert.ok(state.products.length > 0);
  assert.ok(state.products.every(product => Array.isArray(product.variants)));
});

test('Shopify Admin sync imports products, variants, inventory, images and orders read-only', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, options, body });
    if (body.query.includes('PacksmartOpsProducts')) {
      return Response.json({ data: { products: {
        nodes: [{
          id: 'gid://shopify/Product/1',
          title: 'Packing tape',
          handle: 'packing-tape',
          status: 'ACTIVE',
          productType: 'Tape',
          description: 'A reliable packing tape for shipping cartons and warehouse use.',
          updatedAt: '2026-09-05T10:00:00Z',
          totalInventory: 42,
          featuredMedia: { preview: { image: { url: 'https://cdn.shopify.com/product.jpg' } } },
          variants: { nodes: [{
            id: 'gid://shopify/ProductVariant/2',
            title: 'Brown',
            sku: 'TAPE-BROWN',
            price: '3.49',
            inventoryQuantity: 42,
            media: { nodes: [] }
          }] }
        }],
        pageInfo: { hasNextPage: false, endCursor: null }
      } } });
    }
    return Response.json({ data: { orders: {
      nodes: [{
        id: 'gid://shopify/Order/3',
        name: '#1003',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        cancelledAt: null,
        displayFinancialStatus: 'PAID',
        displayFulfillmentStatus: 'UNFULFILLED',
        currentTotalPriceSet: { shopMoney: { amount: '9.99', currencyCode: 'GBP' } }
      }],
      pageInfo: { hasNextPage: false, endCursor: null }
    } } });
  };
  const service = new IntegrationService({
    SHOPIFY_STORE_DOMAIN: 'wavtzm-vy.myshopify.com',
    SHOPIFY_ADMIN_API_VERSION: '2026-07',
    SHOPIFY_ADMIN_ACCESS_TOKEN: 'server-only-test-token'
  }, { fetchImpl, repoRoot });
  const state = { products: [], orders: [], integrationStatus: {} };
  const status = await service.syncShopify(state);
  assert.equal(status.status, 'connected');
  assert.equal(status.source, 'admin-graphql');
  assert.equal(state.products[0].variants[0].sku, 'TAPE-BROWN');
  assert.equal(state.products[0].variants[0].inventory, 42);
  assert.equal(state.products[0].variants[0].image, 'https://cdn.shopify.com/product.jpg');
  assert.equal(state.orders[0].total, 9.99);
  assert.ok(requests.every(request => request.options.method === 'POST'));
  assert.ok(requests.every(request => !/\bmutation\b/i.test(request.body.query)));
  assert.ok(requests.every(request => request.options.headers['X-Shopify-Access-Token'] === 'server-only-test-token'));
  assert.ok(!SHOPIFY_PRODUCTS_QUERY.includes('mutation'));
  assert.ok(!SHOPIFY_ORDERS_QUERY.includes('mutation'));
});

test('eBay sync reuses and verifies the existing seller backend without writes', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/api/ebay/status')) return Response.json({ connected: true, account: 'packsmartsolutions20', marketplaceId: 'EBAY_GB' });
    if (url.endsWith('/api/ebay/listings')) return Response.json({ listings: [{ itemId: '44', title: 'Tape', sku: 'TAPE-BROWN', price: 3.49, quantity: 40, status: 'ACTIVE', promotionRate: 4.5 }] });
    if (url.endsWith('/api/ebay/drafts')) return Response.json({ drafts: [{ id: 'draft-1', title: 'Carton', sku: 'CARTON-1' }] });
    return new Response(null, { status: 404 });
  };
  const service = new IntegrationService({
    NODE_ENV: 'production',
    EBAY_MANAGER_BASE_URL: 'https://ebay-manager.example.test',
    EBAY_MANAGER_API_TOKEN: 'private-backend-token',
    EBAY_EXPECTED_ACCOUNT: 'packsmartsolutions20'
  }, { fetchImpl });
  const state = {
    products: [{ variants: [{ sku: 'TAPE-BROWN' }, { sku: 'MAILER-2' }] }],
    integrationStatus: {}
  };
  const status = await service.syncEbay(state);
  assert.equal(status.status, 'connected');
  assert.equal(status.account, 'packsmartsolutions20');
  assert.equal(state.ebay.listings[0].adRate, 4.5);
  assert.deepEqual(state.ebay.health.missingOnEbay, ['MAILER-2']);
  assert.ok(requests.every(request => request.options.method === 'GET'));
  assert.ok(requests.every(request => request.options.headers.Authorization === 'Bearer private-backend-token'));
});

test('eBay sync rejects an unexpected seller account', async () => {
  const service = new IntegrationService({
    NODE_ENV: 'production',
    EBAY_MANAGER_BASE_URL: 'https://ebay-manager.example.test',
    EBAY_EXPECTED_ACCOUNT: 'packsmartsolutions20'
  }, {
    fetchImpl: async () => Response.json({ connected: true, account: 'another-seller' })
  });
  await assert.rejects(() => service.syncEbay({ integrationStatus: {} }), error => error.code === 'EBAY_ACCOUNT_MISMATCH');
});
