import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  IntegrationService,
  SHOPIFY_ORDERS_QUERY,
  SHOPIFY_PRODUCTS_QUERY
} from '../lib/integrations.mjs';
import { encryptCredentials } from '../lib/security.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('Shopify snapshot remains a safe server-side fallback', async () => {
  const service = new IntegrationService({}, { repoRoot });
  const state = { workspace: { id: 'packsmart-solutions' }, products: [], orders: [], integrationStatus: {} };
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
        totalPriceSet: { shopMoney: { amount: '12.99', currencyCode: 'GBP' } },
        currentTotalPriceSet: { shopMoney: { amount: '9.99', currencyCode: 'GBP' } },
        currentTotalTaxSet: { shopMoney: { amount: '1.67', currencyCode: 'GBP' } },
        currentTotalDiscountsSet: { shopMoney: { amount: '1.00', currencyCode: 'GBP' } },
        currentShippingPriceSet: { shopMoney: { amount: '3.49', currencyCode: 'GBP' } },
        paymentGatewayNames: ['shopify_payments'],
        lineItems: { nodes: [{
          id: 'gid://shopify/LineItem/4',
          name: 'Packing tape',
          sku: 'TAPE-BROWN',
          quantity: 1,
          originalTotalSet: { shopMoney: { amount: '10.50', currencyCode: 'GBP' } },
          discountedTotalSet: { shopMoney: { amount: '9.50', currencyCode: 'GBP' } }
        }] }
      }],
      pageInfo: { hasNextPage: false, endCursor: null }
    } } });
  };
  const service = new IntegrationService({
    SHOPIFY_STORE_DOMAIN: 'wavtzm-vy.myshopify.com',
    SHOPIFY_ADMIN_API_VERSION: '2026-07',
    SHOPIFY_ADMIN_ACCESS_TOKEN: 'server-only-test-token'
  }, { fetchImpl, repoRoot });
  const state = { workspace: { id: 'packsmart-solutions' }, products: [], orders: [], integrationStatus: {} };
  const status = await service.syncShopify(state);
  assert.equal(status.status, 'connected');
  assert.equal(status.source, 'admin-graphql');
  assert.equal(state.products[0].variants[0].sku, 'TAPE-BROWN');
  assert.equal(state.products[0].variants[0].inventory, 42);
  assert.equal(state.products[0].variants[0].image, 'https://cdn.shopify.com/product.jpg');
  assert.equal(state.orders[0].total, 12.99);
  assert.equal(state.orders[0].currentTotal, 9.99);
  assert.equal(state.orders[0].refunds, 3);
  assert.equal(state.orders[0].tax, 1.67);
  assert.equal(state.orders[0].shippingCharged, 3.49);
  assert.equal(state.orders[0].lineItems[0].sku, 'TAPE-BROWN');
  assert.ok(requests.every(request => request.options.method === 'POST'));
  assert.ok(requests.every(request => !/\bmutation\b/i.test(request.body.query)));
  assert.ok(requests.every(request => request.options.headers['X-Shopify-Access-Token'] === 'server-only-test-token'));
  assert.ok(!SHOPIFY_PRODUCTS_QUERY.includes('mutation'));
  assert.ok(!SHOPIFY_ORDERS_QUERY.includes('mutation'));
});

test('Shopify client credentials are exchanged server-side and the short-lived token is reused', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/admin/oauth/access_token')) {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'), 'client_credentials');
      assert.equal(form.get('client_id'), 'server-client-id');
      assert.equal(form.get('client_secret'), 'server-client-secret');
      return Response.json({ access_token: 'short-lived-server-token', scope: 'read_products,read_inventory,read_orders', expires_in: 86399 });
    }
    const body = JSON.parse(options.body);
    assert.equal(options.headers['X-Shopify-Access-Token'], 'short-lived-server-token');
    if (body.query.includes('PacksmartOpsProducts')) {
      return Response.json({ data: { products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    return Response.json({ data: { orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
  };
  const service = new IntegrationService({
    SHOPIFY_STORE_DOMAIN: 'wavtzm-vy.myshopify.com',
    SHOPIFY_ADMIN_API_VERSION: '2026-07',
    SHOPIFY_CLIENT_ID: 'server-client-id',
    SHOPIFY_CLIENT_SECRET: 'server-client-secret'
  }, { fetchImpl, repoRoot });
  const state = { workspace: { id: 'packsmart-solutions' }, products: [], orders: [], integrationStatus: {} };
  const status = await service.syncShopify(state);
  assert.equal(status.status, 'connected');
  assert.equal(status.source, 'admin-graphql');
  assert.equal(requests.filter(request => request.url.endsWith('/admin/oauth/access_token')).length, 1);
  assert.equal(requests.filter(request => request.url.includes('/graphql.json')).length, 2);
  assert.ok(requests.filter(request => request.url.includes('/graphql.json')).every(request => !/\bmutation\b/i.test(JSON.parse(request.options.body).query)));
});

test('encrypted workspace Shopify credentials are decrypted only server-side and update the connection status', async () => {
  const credentialKey = 'workspace-shopify-encryption-key-more-than-thirty-two-characters';
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/admin/oauth/access_token')) {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('client_id'), 'workspace-client-id');
      assert.equal(form.get('client_secret'), 'workspace-client-secret-value');
      return Response.json({ access_token: 'workspace-short-lived-token', expires_in: 86399 });
    }
    const body = JSON.parse(options.body);
    assert.equal(options.headers['X-Shopify-Access-Token'], 'workspace-short-lived-token');
    if (body.query.includes('PacksmartOpsProducts')) {
      return Response.json({ data: { products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    return Response.json({ data: { orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
  };
  const encryptedCredentials = encryptCredentials({
    storeDomain: 'wavtzm-vy.myshopify.com',
    clientId: 'workspace-client-id',
    clientSecret: 'workspace-client-secret-value'
  }, credentialKey);
  const state = {
    workspace: { id: 'packsmart-solutions' },
    products: [], orders: [], integrationStatus: {},
    connections: [{
      id: 'conn-shopify', provider: 'shopify', status: 'configured', encryptedCredentials,
      metadata: {}, createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z'
    }]
  };
  const service = new IntegrationService({ CREDENTIALS_KEY: credentialKey, SHOPIFY_ADMIN_API_VERSION: '2026-07' }, { fetchImpl, repoRoot });
  const status = await service.syncShopify(state);
  assert.equal(status.status, 'connected');
  assert.equal(state.connections[0].status, 'connected');
  assert.equal(state.connections[0].metadata.shopDomain, 'wavtzm-vy.myshopify.com');
  assert.equal(state.connections[0].metadata.itemCount, 0);
  assert.equal(requests.filter(request => request.url.endsWith('/admin/oauth/access_token')).length, 1);
  assert.equal(JSON.stringify(state).includes('workspace-client-secret-value'), false);
});

test('a future tenant never inherits Packsmart Shopify environment credentials', async () => {
  let remoteRequests = 0;
  const service = new IntegrationService({
    SHOPIFY_ENV_WORKSPACE_ID: 'packsmart-solutions',
    SHOPIFY_STORE_DOMAIN: 'wavtzm-vy.myshopify.com',
    SHOPIFY_CLIENT_ID: 'packsmart-client-id',
    SHOPIFY_CLIENT_SECRET: 'packsmart-client-secret'
  }, { fetchImpl: async () => { remoteRequests += 1; throw new Error('Tenant isolation failure'); }, repoRoot });
  const state = { workspace: { id: 'beta-workspace' }, products: [], orders: [], integrationStatus: {}, connections: [] };
  assert.equal(service.shopifyConfigured(state), false);
  const status = await service.syncShopify(state);
  assert.equal(status.source, 'repository-snapshot');
  assert.equal(remoteRequests, 0);
});

test('eBay sync reuses and verifies the existing seller backend without writes', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/api/ebay/status')) return Response.json({ connected: true, account: 'packsmartsolutions20', marketplaceId: 'EBAY_GB' });
    if (url.endsWith('/api/ebay/listings')) return Response.json({ listings: [{ itemId: '44', title: 'Tape', sku: 'TAPE-BROWN', price: 3.49, quantity: 40, status: 'ACTIVE', promotionRate: 4.5 }] });
    if (url.endsWith('/api/ebay/drafts')) return Response.json({ drafts: [{ id: 'draft-1', title: 'Carton', sku: 'CARTON-1' }] });
    if (url.endsWith('/api/ebay/orders')) return Response.json({ orders: [{ orderId: 'ebay-order-1', creationDate: new Date().toISOString(), orderTotal: 8.99, taxAmount: 1.5, refundAmount: 0, ebayFees: 1.2, promotedListingFee: 0.4, postageCost: 2.7, items: [{ lineItemId: 'line-1', title: 'Tape', sku: 'TAPE-BROWN', quantity: 1, total: 8.99 }] }] });
    if (url.endsWith('/api/ebay/fees')) return Response.json({ fees: [{ orderId: 'ebay-order-1', amount: 1.2 }] });
    if (url.endsWith('/api/ebay/promotions')) return Response.json({ promotions: [{ id: 'promo-1', rate: 4.5 }] });
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
  assert.equal(state.orders[0].provider, 'ebay');
  assert.equal(state.orders[0].channelFees, 1.2);
  assert.equal(state.ebay.fees.length, 1);
  assert.equal(state.ebay.promotions.length, 1);
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
