import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  EBAY_READONLY_SCOPES,
  IntegrationService,
  SHOPIFY_ORDERS_QUERY,
  SHOPIFY_PRODUCTS_QUERY
} from '../lib/integrations.mjs';
import { encryptCredentials } from '../lib/security.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('Shopify snapshot remains a safe server-side fallback', async () => {
  const service = new IntegrationService({ SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' }, { repoRoot });
  const state = { workspace: { id: 'packsmart-solutions' }, products: [], orders: [], integrationStatus: {} };
  const status = await service.syncShopify(state);
  assert.equal(status.status, 'degraded');
  assert.equal(status.source, 'repository-snapshot');
  assert.ok(state.products.length > 0);
  assert.ok(state.products.every(product => Array.isArray(product.variants)));
});

test('Packsmart customer-zero syncs the live public Shopify catalogue without credentials or writes', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return Response.json({ products: [{
      id: 15952658465102,
      title: 'Grey Mailing Bags | 230 × 300mm (9 × 12in)',
      handle: 'grey-mailing-bags-230-x-300mm-9-x-12',
      product_type: 'Mailing Bags',
      body_html: '<p>Strong grey mailing bags for ecommerce orders.</p>',
      updated_at: '2026-09-08T07:00:30Z',
      image: { src: 'https://cdn.shopify.com/product.jpg' },
      variants: [{
        id: 60415428755790,
        title: 'Pack of 50',
        sku: 'GM-230x300-50',
        price: '2.50',
        available: false
      }]
    }] });
  };
  const service = new IntegrationService({}, { fetchImpl, repoRoot });
  const state = { workspace: { id: 'packsmart-solutions' }, products: [], orders: [], integrationStatus: {} };
  const status = await service.syncShopify(state);
  assert.equal(status.status, 'degraded');
  assert.equal(status.source, 'public-storefront');
  assert.equal(status.readOnly, true);
  assert.equal(status.exactInventory, false);
  assert.equal(state.products[0].id, 'gid://shopify/Product/15952658465102');
  assert.equal(state.products[0].variants[0].id, 'GM-230x300-50');
  assert.equal(state.products[0].variants[0].externalId, 'gid://shopify/ProductVariant/60415428755790');
  assert.equal(state.products[0].variants[0].inventory, null);
  assert.equal(state.products[0].variants[0].available, false);
  assert.equal(state.products[0].description, 'Strong grey mailing bags for ecommerce orders.');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://packsmartsolutions.com/products.json?limit=250');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal('Authorization' in requests[0].options.headers, false);
});

test('the safe repository snapshot remains available if the live public catalogue fails', async () => {
  const service = new IntegrationService({}, {
    repoRoot,
    fetchImpl: async () => Response.json({ error: 'temporarily unavailable' }, { status: 503 })
  });
  const state = { workspace: { id: 'packsmart-solutions' }, products: [], orders: [], integrationStatus: {} };
  const status = await service.syncShopify(state);
  assert.equal(status.status, 'degraded');
  assert.equal(status.source, 'repository-snapshot');
  assert.ok(state.products.length > 0);
  assert.ok(status.lastError);
  assert.ok(status.publicAttemptedAt);
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
  assert.equal(state.products[0].variants[0].id, 'TAPE-BROWN');
  assert.equal(state.products[0].variants[0].externalId, 'gid://shopify/ProductVariant/2');
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
  assert.equal(status.source, 'unconfigured');
  assert.equal(status.status, 'not_configured');
  assert.equal(state.products.length, 0);
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
    workspace: { id: 'packsmart-solutions' },
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
  assert.ok(requests.every(request => request.options.redirect === 'error'));
  assert.ok(requests.every(request => request.options.headers.Authorization === 'Bearer private-backend-token'));
});

test('direct eBay OAuth sync uses only read scopes and read API methods while preserving encrypted refresh credentials', async () => {
  const credentialKey = 'direct-ebay-oauth-encryption-key-more-than-thirty-two-characters';
  const refreshToken = 'long-lived-refresh-token-test-only';
  const accessToken = 'short-lived-access-token-test-only';
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url) === 'https://api.ebay.com/identity/v1/oauth2/token') {
      assert.equal(options.method, 'POST');
      assert.match(options.headers.Authorization, /^Basic /);
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'), 'refresh_token');
      assert.equal(form.get('refresh_token'), refreshToken);
      assert.deepEqual(form.get('scope').split(' '), EBAY_READONLY_SCOPES);
      return Response.json({ access_token: accessToken, expires_in: 7200, token_type: 'User Access Token' });
    }
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, `Bearer ${accessToken}`);
    if (String(url) === 'https://apiz.ebay.com/commerce/identity/v1/user/') {
      return Response.json({ username: 'packsmartsolutions20', userId: 'immutable-user-id' });
    }
    if (String(url).startsWith('https://api.ebay.com/sell/fulfillment/v1/order?')) {
      return Response.json({ total: 1, orders: [{
        orderId: 'ebay-order-oauth-1', creationDate: '2026-09-06T12:00:00.000Z', orderPaymentStatus: 'PAID', orderFulfillmentStatus: 'NOT_STARTED',
        pricingSummary: { total: { value: '12.99', currency: 'GBP' }, tax: { value: '2.16', currency: 'GBP' }, deliveryCost: { value: '3.20', currency: 'GBP' } },
        totalMarketplaceFee: { value: '1.50', currency: 'GBP' },
        lineItems: [{ lineItemId: 'line-oauth-1', title: 'Packing tape', sku: 'TAPE-BROWN', quantity: 1, lineItemCost: { value: '9.79', currency: 'GBP' } }]
      }] });
    }
    if (String(url).startsWith('https://api.ebay.com/sell/inventory/v1/inventory_item?')) {
      return Response.json({ total: 1, inventoryItems: [{
        sku: 'TAPE-BROWN', product: { title: 'Packing tape', imageUrls: ['https://i.ebayimg.com/tape.jpg'] },
        availability: { shipToLocationAvailability: { quantity: 40 } }
      }] });
    }
    if (String(url).startsWith('https://api.ebay.com/sell/inventory/v1/offer?')) {
      return Response.json({ total: 1, offers: [{
        offerId: 'offer-44', sku: 'TAPE-BROWN', marketplaceId: 'EBAY_GB', status: 'PUBLISHED', availableQuantity: 38,
        pricingSummary: { price: { value: '3.49', currency: 'GBP' } }, listing: { listingId: '44', soldQuantity: 2 }
      }] });
    }
    if (String(url).startsWith('https://api.ebay.com/sell/marketing/v1/ad_campaign?')) {
      assert.equal(options.headers['X-EBAY-C-MARKETPLACE-ID'], 'EBAY_GB');
      return Response.json({ campaigns: [{ campaignId: 'campaign-1', campaignName: 'Core products', campaignStatus: 'RUNNING', marketplaceId: 'EBAY_GB' }] });
    }
    if (String(url).includes('/sell/marketing/v1/ad_campaign/campaign-1/ad?')) {
      return Response.json({ ads: [{ adId: 'ad-1', listingId: '44', bidPercentage: '4.5', adStatus: 'ACTIVE' }] });
    }
    return new Response(null, { status: 404 });
  };
  const connection = {
    id: 'conn-ebay-oauth', provider: 'ebay_oauth', label: 'eBay read-only OAuth', status: 'configured',
    encryptedCredentials: encryptCredentials({
      mode: 'direct_oauth', refreshToken, scopes: EBAY_READONLY_SCOPES,
      expectedAccount: 'packsmartsolutions20', marketplaceId: 'EBAY_GB'
    }, credentialKey),
    metadata: {}, createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z'
  };
  const state = {
    workspace: { id: 'packsmart-solutions' },
    products: [{ variants: [{ sku: 'TAPE-BROWN' }, { sku: 'MAILER-2' }] }],
    orders: [], connections: [connection], integrationStatus: {}
  };
  const service = new IntegrationService({
    NODE_ENV: 'production', CREDENTIALS_KEY: credentialKey, EBAY_OAUTH_ENABLED: 'true',
    EBAY_ENV_WORKSPACE_ID: 'packsmart-solutions', EBAY_CLIENT_ID: 'production-client-id',
    EBAY_CLIENT_SECRET: 'production-client-secret-value', EBAY_REDIRECT_URI_NAME: 'Packsmart-Operations-ReadOnly-RuName',
    EBAY_EXPECTED_ACCOUNT: 'packsmartsolutions20', EBAY_MARKETPLACE_ID: 'EBAY_GB'
  }, { fetchImpl });

  assert.equal(service.ebayOAuthReady(state), true);
  const status = await service.syncEbay(state);
  assert.equal(status.status, 'connected');
  assert.equal(status.source, 'ebay-oauth-readonly');
  assert.equal(state.ebay.account, 'packsmartsolutions20');
  assert.equal(state.ebay.listings[0].sku, 'TAPE-BROWN');
  assert.equal(state.ebay.listings[0].adRate, 4.5);
  assert.equal(state.ebay.listings[0].quantity, 38);
  assert.deepEqual(state.ebay.health.missingOnEbay, ['MAILER-2']);
  assert.equal(state.orders[0].total, 12.99);
  assert.equal(state.orders[0].channelFees, 1.5);
  assert.equal(state.ebay.fees[0].amount, 1.5);
  assert.equal(state.ebay.promotions.length, 1);
  assert.equal(connection.status, 'connected');
  assert.equal(JSON.stringify(state).includes(refreshToken), false);
  assert.equal(JSON.stringify(state).includes(accessToken), false);
  assert.equal(requests.filter(request => request.options.method === 'POST').length, 1);
  assert.ok(requests.filter(request => request.options.method === 'GET').every(request => request.options.redirect === 'error'));
});

test('eBay authorization URL is purpose-scoped to read-only consent', () => {
  const service = new IntegrationService({
    CREDENTIALS_KEY: 'oauth-url-credential-key-more-than-thirty-two-characters',
    EBAY_OAUTH_ENABLED: 'true', EBAY_ENV_WORKSPACE_ID: 'packsmart-solutions',
    EBAY_CLIENT_ID: 'production-client-id', EBAY_CLIENT_SECRET: 'production-client-secret-value',
    EBAY_REDIRECT_URI_NAME: 'Packsmart-Operations-ReadOnly-RuName'
  });
  const state = { workspace: { id: 'packsmart-solutions' } };
  const url = new URL(service.ebayAuthorizationUrl('signed-oauth-state-value-more-than-thirty-two-characters', state));
  assert.equal(url.origin, 'https://auth.ebay.com');
  assert.equal(url.pathname, '/oauth2/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.deepEqual(url.searchParams.get('scope').split(' '), EBAY_READONLY_SCOPES);
  assert.ok(EBAY_READONLY_SCOPES.every(scope => scope.endsWith('.readonly')));
  assert.equal(url.searchParams.get('redirect_uri'), 'Packsmart-Operations-ReadOnly-RuName');
  assert.equal(url.searchParams.get('state'), 'signed-oauth-state-value-more-than-thirty-two-characters');
});

test('eBay read-only sync stays connected when optional seller APIs are unavailable', async () => {
  const credentialKey = 'partial-ebay-sync-key-more-than-thirty-two-characters';
  const fetchImpl = async (url) => {
    if (String(url).includes('/identity/v1/oauth2/token')) {
      return Response.json({ access_token: 'temporary-access-token', expires_in: 7200 });
    }
    if (String(url) === 'https://apiz.ebay.com/commerce/identity/v1/user/') {
      return Response.json({ username: 'packsmartsolutions20' });
    }
    if (String(url).includes('/sell/inventory/v1/inventory_item?')) {
      return Response.json({ total: 0, inventoryItems: [] });
    }
    if (String(url).includes('/sell/fulfillment/v1/order?')) {
      return Response.json({ errors: [{ errorId: 30500 }] }, { status: 500 });
    }
    if (String(url).includes('/sell/marketing/v1/ad_campaign?')) {
      return Response.json({ errors: [{ errorId: 35001 }] }, { status: 403 });
    }
    return new Response(null, { status: 404 });
  };
  const connection = {
    id: 'conn-ebay-partial', provider: 'ebay_oauth', label: 'eBay read-only OAuth', status: 'configured',
    encryptedCredentials: encryptCredentials({
      mode: 'direct_oauth', refreshToken: 'encrypted-refresh-token-source-value', scopes: EBAY_READONLY_SCOPES,
      expectedAccount: 'packsmartsolutions20', marketplaceId: 'EBAY_GB'
    }, credentialKey),
    metadata: {}, createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z'
  };
  const state = {
    workspace: { id: 'packsmart-solutions' }, products: [], orders: [], connections: [connection], integrationStatus: {}
  };
  const service = new IntegrationService({
    NODE_ENV: 'production', CREDENTIALS_KEY: credentialKey, EBAY_OAUTH_ENABLED: 'true',
    EBAY_ENV_WORKSPACE_ID: 'packsmart-solutions', EBAY_CLIENT_ID: 'production-client-id',
    EBAY_CLIENT_SECRET: 'production-client-secret-value', EBAY_REDIRECT_URI_NAME: 'Packsmart-Operations-ReadOnly-RuName',
    EBAY_EXPECTED_ACCOUNT: 'packsmartsolutions20', EBAY_MARKETPLACE_ID: 'EBAY_GB'
  }, { fetchImpl });

  const status = await service.syncEbay(state);
  assert.equal(status.status, 'connected');
  assert.equal(status.account, 'packsmartsolutions20');
  assert.deepEqual(state.ebay.coverage.unavailableSurfaces.sort(), ['marketing', 'orders']);
  assert.equal(state.ebay.coverage.inventoryAvailable, true);
  assert.equal(state.ebay.coverage.ordersAvailable, false);
  assert.equal(state.ebay.coverage.marketingAvailable, false);
  assert.match(status.detail, /Some eBay read data is currently unavailable: orders, marketing\./);
  assert.equal(connection.status, 'connected');
});

test('eBay sync rejects an unexpected seller account', async () => {
  const service = new IntegrationService({
    NODE_ENV: 'production',
    EBAY_MANAGER_BASE_URL: 'https://ebay-manager.example.test',
    EBAY_EXPECTED_ACCOUNT: 'packsmartsolutions20'
  }, {
    fetchImpl: async () => Response.json({ connected: true, account: 'another-seller' })
  });
  await assert.rejects(() => service.syncEbay({ workspace: { id: 'packsmart-solutions' }, integrationStatus: {} }), error => error.code === 'EBAY_ACCOUNT_MISMATCH');
});

test('encrypted workspace eBay Manager credentials stay server-side and preserve the existing OAuth backend', async () => {
  const credentialKey = 'workspace-ebay-encryption-key-more-than-thirty-two-characters';
  const privateToken = 'private-existing-manager-token';
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/api/ebay/status')) {
      return Response.json({ connected: true, account: 'packsmartsolutions20', marketplaceId: 'EBAY_GB' });
    }
    return new Response(null, { status: 404 });
  };
  const state = {
    workspace: { id: 'packsmart-solutions' },
    products: [], orders: [], integrationStatus: {},
    connections: [{
      id: 'conn-ebay', provider: 'ebay', status: 'configured',
      encryptedCredentials: encryptCredentials({
        baseUrl: 'https://existing-ebay-manager.example.test',
        expectedAccount: 'packsmartsolutions20',
        apiToken: privateToken
      }, credentialKey),
      metadata: {}, createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z'
    }]
  };
  const service = new IntegrationService({ NODE_ENV: 'production', CREDENTIALS_KEY: credentialKey }, { fetchImpl });
  const status = await service.syncEbay(state);
  assert.equal(status.status, 'connected');
  assert.equal(state.connections[0].status, 'connected');
  assert.equal(state.connections[0].metadata.account, 'packsmartsolutions20');
  assert.equal(state.connections[0].metadata.listingCount, 0);
  assert.ok(requests.length > 0);
  assert.ok(requests.every(request => request.options.method === 'GET'));
  assert.ok(requests.every(request => request.options.headers.Authorization === `Bearer ${privateToken}`));
  assert.equal(JSON.stringify(state).includes(privateToken), false);
});

test('a future tenant never inherits the Packsmart eBay Manager environment connection', async () => {
  let remoteRequests = 0;
  const service = new IntegrationService({
    NODE_ENV: 'production',
    EBAY_ENV_WORKSPACE_ID: 'packsmart-solutions',
    EBAY_MANAGER_BASE_URL: 'https://existing-ebay-manager.example.test',
    EBAY_MANAGER_API_TOKEN: 'packsmart-only-token'
  }, { fetchImpl: async () => { remoteRequests += 1; throw new Error('Tenant isolation failure'); } });
  const state = { workspace: { id: 'beta-workspace' }, products: [], orders: [], integrationStatus: {}, connections: [] };
  assert.equal(service.ebayConfigured(state), false);
  const status = await service.syncEbay(state);
  assert.equal(status.status, 'not_configured');
  assert.equal(remoteRequests, 0);
});

test('eBay Manager rejects private network targets before making a request', async () => {
  let remoteRequests = 0;
  const service = new IntegrationService({
    NODE_ENV: 'production',
    EBAY_MANAGER_BASE_URL: 'https://127.0.0.1',
    EBAY_EXPECTED_ACCOUNT: 'packsmartsolutions20'
  }, { fetchImpl: async () => { remoteRequests += 1; return Response.json({}); } });
  await assert.rejects(
    () => service.syncEbay({ workspace: { id: 'packsmart-solutions' }, integrationStatus: {} }),
    error => error.code === 'INTEGRATION_CONFIG_INVALID'
  );
  assert.equal(remoteRequests, 0);
});
