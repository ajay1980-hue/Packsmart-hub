import fs from 'node:fs/promises';

export const SHOPIFY_PRODUCTS_QUERY = `
  query PacksmartOpsProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        title
        handle
        status
        productType
        description
        updatedAt
        totalInventory
        featuredMedia { preview { image { url } } }
        variants(first: 100) {
          nodes {
            id
            title
            sku
            price
            inventoryQuantity
            media(first: 1) { nodes { preview { image { url } } } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

export const SHOPIFY_ORDERS_QUERY = `
  query PacksmartOpsOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        updatedAt
        cancelledAt
        displayFinancialStatus
        displayFulfillmentStatus
        currentTotalPriceSet { shopMoney { amount currencyCode } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

function integrationError(message, status = 502, code = 'INTEGRATION_ERROR') {
  return Object.assign(new Error(message), { status, code });
}

function normalizeDomain(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!raw || !/^[a-z0-9][a-z0-9.-]+$/.test(raw)) throw integrationError('Invalid Shopify store domain', 503, 'SHOPIFY_CONFIG_INVALID');
  return raw;
}

function validateRemoteBase(value, { allowLocal = false } = {}) {
  let parsed;
  try { parsed = new URL(value); } catch { throw integrationError('Invalid integration base URL', 503, 'INTEGRATION_CONFIG_INVALID'); }
  if (parsed.username || parsed.password) throw integrationError('Integration URL must not contain credentials', 503, 'INTEGRATION_CONFIG_INVALID');
  if (parsed.protocol !== 'https:' && !(allowLocal && parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) {
    throw integrationError('Integration URL must use HTTPS', 503, 'INTEGRATION_CONFIG_INVALID');
  }
  return parsed.origin;
}

function mapAdminProduct(product) {
  const productImage = product.featuredMedia?.preview?.image?.url || null;
  return {
    id: String(product.id),
    externalId: String(product.id),
    provider: 'shopify',
    title: String(product.title || ''),
    handle: String(product.handle || ''),
    status: String(product.status || 'UNKNOWN').toLowerCase(),
    productType: String(product.productType || ''),
    description: String(product.description || ''),
    image: productImage,
    inventory: Number.isFinite(Number(product.totalInventory)) ? Number(product.totalInventory) : null,
    updatedAt: product.updatedAt || null,
    variants: (product.variants?.nodes || []).map(variant => ({
      id: String(variant.id),
      externalId: String(variant.id),
      title: String(variant.title || 'Default'),
      sku: String(variant.sku || ''),
      price: Number(variant.price || 0),
      inventory: Number.isFinite(Number(variant.inventoryQuantity)) ? Number(variant.inventoryQuantity) : null,
      available: Number(variant.inventoryQuantity || 0) > 0,
      image: variant.media?.nodes?.[0]?.preview?.image?.url || productImage
    }))
  };
}

function mapSnapshotProduct(product) {
  return {
    id: String(product.id),
    externalId: String(product.id),
    provider: 'shopify',
    title: String(product.title || ''),
    handle: String(product.handle || ''),
    status: String(product.status || 'active').toLowerCase(),
    productType: String(product.product_type || product.productType || ''),
    description: String(product.description || product.body_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    image: product.image?.src || product.image || product.images?.[0]?.src || null,
    inventory: null,
    updatedAt: product.updated_at || null,
    variants: (product.variants || []).map(variant => ({
      id: String(variant.id || variant.sku || `${product.id}-${variant.title}`),
      externalId: String(variant.id || variant.sku || ''),
      title: String(variant.title || 'Default'),
      sku: String(variant.sku || ''),
      price: Number(variant.price || 0),
      inventory: Number.isFinite(Number(variant.inventory_quantity)) ? Number(variant.inventory_quantity) : null,
      available: variant.available !== false,
      image: variant.featured_image?.src || product.image?.src || product.image || product.images?.[0]?.src || null
    }))
  };
}

function mapOrder(order) {
  return {
    id: String(order.id),
    externalId: String(order.id),
    provider: 'shopify',
    name: String(order.name || ''),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    cancelledAt: order.cancelledAt || null,
    financialStatus: String(order.displayFinancialStatus || 'UNKNOWN'),
    fulfillmentStatus: String(order.displayFulfillmentStatus || 'UNFULFILLED'),
    total: Number(order.currentTotalPriceSet?.shopMoney?.amount || 0),
    currency: String(order.currentTotalPriceSet?.shopMoney?.currencyCode || 'GBP')
  };
}

async function responseJson(response, label) {
  let data;
  try { data = await response.json(); } catch { throw integrationError(`${label} returned an invalid response`); }
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403
      ? `${label} authentication failed`
      : `${label} request failed (${response.status})`;
    throw integrationError(message, 502, 'UPSTREAM_REQUEST_FAILED');
  }
  return data;
}

export class IntegrationService {
  constructor(env = process.env, { fetchImpl = fetch, repoRoot } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.repoRoot = repoRoot;
  }

  async shopifyGraphql(query, variables) {
    const domain = normalizeDomain(this.env.SHOPIFY_STORE_DOMAIN);
    const version = String(this.env.SHOPIFY_ADMIN_API_VERSION || '2026-07');
    if (!/^20\d\d-(01|04|07|10)$/.test(version)) throw integrationError('Invalid Shopify API version', 503, 'SHOPIFY_CONFIG_INVALID');
    const token = String(this.env.SHOPIFY_ADMIN_ACCESS_TOKEN || '');
    if (!token) throw integrationError('Shopify Admin API is not configured', 503, 'SHOPIFY_NOT_CONFIGURED');
    const response = await this.fetch(`https://${domain}/admin/api/${version}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
        'User-Agent': 'Packsmart-Ops/3.0'
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20000)
    });
    const payload = await responseJson(response, 'Shopify');
    if (Array.isArray(payload.errors) && payload.errors.length) {
      throw integrationError('Shopify returned a GraphQL error', 502, 'SHOPIFY_GRAPHQL_ERROR');
    }
    return payload.data;
  }

  async fetchShopifyProducts() {
    const products = [];
    let after = null;
    for (let page = 0; page < 10; page += 1) {
      const data = await this.shopifyGraphql(SHOPIFY_PRODUCTS_QUERY, { first: 50, after });
      const connection = data?.products;
      products.push(...(connection?.nodes || []).map(mapAdminProduct));
      if (!connection?.pageInfo?.hasNextPage) break;
      after = connection.pageInfo.endCursor;
    }
    return products;
  }

  async fetchShopifyOrders() {
    const orders = [];
    let after = null;
    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    for (let page = 0; page < 10; page += 1) {
      const data = await this.shopifyGraphql(SHOPIFY_ORDERS_QUERY, { first: 50, after, query: `created_at:>=${cutoff}` });
      const connection = data?.orders;
      orders.push(...(connection?.nodes || []).map(mapOrder));
      if (!connection?.pageInfo?.hasNextPage) break;
      after = connection.pageInfo.endCursor;
    }
    return orders;
  }

  async loadShopifySnapshot() {
    if (!this.repoRoot) throw integrationError('Shopify snapshot is unavailable', 503, 'SHOPIFY_SNAPSHOT_UNAVAILABLE');
    const url = new URL('ebay-manager/shopify-products.json', `file://${this.repoRoot}/`);
    const payload = JSON.parse(await fs.readFile(url, 'utf8'));
    if (!Array.isArray(payload.products)) throw integrationError('Shopify snapshot is invalid', 500, 'SHOPIFY_SNAPSHOT_INVALID');
    return {
      products: payload.products.map(mapSnapshotProduct),
      syncedAt: payload.syncedAt || null,
      source: payload.source || 'repository snapshot'
    };
  }

  async syncShopify(state) {
    const now = new Date().toISOString();
    if (this.env.SHOPIFY_ADMIN_ACCESS_TOKEN && this.env.SHOPIFY_STORE_DOMAIN) {
      const [products, orders] = await Promise.all([this.fetchShopifyProducts(), this.fetchShopifyOrders()]);
      state.products = products;
      state.orders = orders;
      state.integrationStatus = {
        ...(state.integrationStatus || {}),
        shopify: {
          status: 'connected',
          detail: `${products.length} products and ${orders.length} recent orders synced read-only.`,
          source: 'admin-graphql',
          lastSyncAt: now,
          lastError: null
        }
      };
      return state.integrationStatus.shopify;
    }

    const snapshot = await this.loadShopifySnapshot();
    state.products = snapshot.products;
    state.integrationStatus = {
      ...(state.integrationStatus || {}),
      shopify: {
        status: 'degraded',
        detail: `${snapshot.products.length} products loaded from the safe repository snapshot; live orders and inventory need the Admin API connection.`,
        source: 'repository-snapshot',
        snapshotSyncedAt: snapshot.syncedAt,
        lastSyncAt: now,
        lastError: 'Live Shopify Admin connection is not configured'
      }
    };
    return state.integrationStatus.shopify;
  }

  ebayHeaders() {
    const headers = { Accept: 'application/json', 'User-Agent': 'Packsmart-Ops/3.0' };
    if (this.env.EBAY_MANAGER_API_TOKEN) headers.Authorization = `Bearer ${this.env.EBAY_MANAGER_API_TOKEN}`;
    return headers;
  }

  async ebayGet(base, paths) {
    let lastStatus = 0;
    for (const path of paths) {
      const response = await this.fetch(`${base}${path}`, {
        method: 'GET',
        headers: this.ebayHeaders(),
        signal: AbortSignal.timeout(15000)
      });
      lastStatus = response.status;
      if (response.status === 404 || response.status === 405) continue;
      return responseJson(response, 'eBay Manager');
    }
    throw integrationError(`eBay Manager read route was not found (${lastStatus || 'network error'})`, 502, 'EBAY_ROUTE_NOT_FOUND');
  }

  async syncEbay(state) {
    const now = new Date().toISOString();
    if (!this.env.EBAY_MANAGER_BASE_URL) {
      const status = {
        status: 'not_configured',
        detail: 'Existing eBay Manager backend URL is required; no duplicate OAuth connection has been created.',
        lastSyncAt: null,
        lastError: null
      };
      state.integrationStatus = { ...(state.integrationStatus || {}), ebay: status };
      return status;
    }
    const base = validateRemoteBase(this.env.EBAY_MANAGER_BASE_URL, { allowLocal: this.env.NODE_ENV !== 'production' });
    const statusPayload = await this.ebayGet(base, ['/api/ebay/status', '/api/status', '/api/health']);
    const account = String(statusPayload.account || statusPayload.username || statusPayload.ebayUser || '');
    const connected = statusPayload.connected === true || statusPayload.authenticated === true || statusPayload.ebayConnected === true;
    const expected = String(this.env.EBAY_EXPECTED_ACCOUNT || 'packsmartsolutions20').toLowerCase();
    if (!connected || !account) throw integrationError('eBay Manager did not confirm its connected account', 502, 'EBAY_ACCOUNT_UNCONFIRMED');
    if (account.toLowerCase() !== expected) throw integrationError('eBay Manager reported the wrong seller account', 502, 'EBAY_ACCOUNT_MISMATCH');

    const [listingPayload, draftPayload] = await Promise.all([
      this.ebayGet(base, ['/api/ebay/listings', '/api/listings']).catch(() => ({ listings: [] })),
      this.ebayGet(base, ['/api/ebay/drafts', '/api/drafts']).catch(() => ({ drafts: [] }))
    ]);
    const listings = Array.isArray(listingPayload) ? listingPayload : listingPayload.listings || listingPayload.items || [];
    const drafts = Array.isArray(draftPayload) ? draftPayload : draftPayload.drafts || draftPayload.items || [];
    const shopifySkus = new Set((state.products || []).flatMap(product => (product.variants || []).map(variant => variant.sku).filter(Boolean)));
    const listingSkus = new Set(listings.map(item => item.sku).filter(Boolean));
    const missingOnEbay = [...shopifySkus].filter(sku => !listingSkus.has(sku));
    const staleOnEbay = [...listingSkus].filter(sku => !shopifySkus.has(sku));
    state.ebay = {
      account,
      marketplaceId: statusPayload.marketplaceId || 'EBAY_GB',
      listings: listings.slice(0, 500).map(item => ({
        id: String(item.id || item.itemId || ''),
        title: String(item.title || ''),
        sku: String(item.sku || ''),
        price: Number(item.price || 0),
        quantity: Number.isFinite(Number(item.quantity)) ? Number(item.quantity) : null,
        status: String(item.status || 'unknown'),
        adRate: Number.isFinite(Number(item.adRate ?? item.promotionRate)) ? Number(item.adRate ?? item.promotionRate) : null,
        listingUrl: item.listingUrl || item.url || null
      })),
      drafts: drafts.slice(0, 500).map(item => ({ id: String(item.id || ''), title: String(item.title || ''), sku: String(item.sku || ''), updatedAt: item.updatedAt || null })),
      health: { missingOnEbay: missingOnEbay.slice(0, 100), staleOnEbay: staleOnEbay.slice(0, 100) },
      syncedAt: now
    };
    const status = {
      status: 'connected',
      detail: `${listings.length} listings and ${drafts.length} drafts read from the existing ${account} backend. Writes remain disabled.`,
      account,
      listingCount: listings.length,
      draftCount: drafts.length,
      mismatchCount: missingOnEbay.length + staleOnEbay.length,
      lastSyncAt: now,
      lastError: null
    };
    state.integrationStatus = { ...(state.integrationStatus || {}), ebay: status };
    return status;
  }
}
