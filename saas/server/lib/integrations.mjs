import fs from 'node:fs/promises';
import { isIP } from 'node:net';
import { decryptCredentials } from './security.mjs';

const CUSTOMER_ZERO_WORKSPACE = 'packsmart-solutions';

export const EBAY_READONLY_SCOPES = Object.freeze([
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.marketing.readonly'
]);

const EBAY_PRODUCTION = Object.freeze({
  authorize: 'https://auth.ebay.com/oauth2/authorize',
  token: 'https://api.ebay.com/identity/v1/oauth2/token',
  identity: 'https://apiz.ebay.com/commerce/identity/v1/user/',
  fulfillment: 'https://api.ebay.com/sell/fulfillment/v1',
  inventory: 'https://api.ebay.com/sell/inventory/v1',
  marketing: 'https://api.ebay.com/sell/marketing/v1'
});

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
        totalPriceSet { shopMoney { amount currencyCode } }
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        currentTotalTaxSet { shopMoney { amount currencyCode } }
        currentTotalDiscountsSet { shopMoney { amount currencyCode } }
        currentShippingPriceSet { shopMoney { amount currencyCode } }
        paymentGatewayNames
        lineItems(first: 100) {
          nodes {
            id
            name
            sku
            quantity
            originalTotalSet { shopMoney { amount currencyCode } }
            discountedTotalSet { shopMoney { amount currencyCode } }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

function integrationError(message, status = 502, code = 'INTEGRATION_ERROR') {
  return Object.assign(new Error(message), { status, code });
}

function normalizeDomain(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!raw || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(raw)) throw integrationError('Invalid Shopify store domain', 503, 'SHOPIFY_CONFIG_INVALID');
  return raw;
}

function validateRemoteBase(value, { allowLocal = false } = {}) {
  let parsed;
  try { parsed = new URL(value); } catch { throw integrationError('Invalid integration base URL', 503, 'INTEGRATION_CONFIG_INVALID'); }
  if (parsed.username || parsed.password) throw integrationError('Integration URL must not contain credentials', 503, 'INTEGRATION_CONFIG_INVALID');
  if (parsed.protocol !== 'https:' && !(allowLocal && parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) {
    throw integrationError('Integration URL must use HTTPS', 503, 'INTEGRATION_CONFIG_INVALID');
  }
  const hostname = parsed.hostname.toLowerCase();
  const ipHostname = hostname.replace(/^\[|\]$/g, '');
  if (!allowLocal && (
    isIP(ipHostname) ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  )) {
    throw integrationError('Integration URL must use a public HTTPS hostname', 503, 'INTEGRATION_CONFIG_INVALID');
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
  const originalTotal = order.totalPriceSet?.shopMoney || order.currentTotalPriceSet?.shopMoney || {};
  const currentTotal = order.currentTotalPriceSet?.shopMoney || originalTotal;
  const gross = Number(originalTotal.amount || 0);
  const current = Number(currentTotal.amount || 0);
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
    total: gross,
    currentTotal: current,
    currency: String(currentTotal.currencyCode || originalTotal.currencyCode || 'GBP'),
    refunds: Number(Math.max(0, gross - current).toFixed(2)),
    tax: order.currentTotalTaxSet?.shopMoney ? Number(order.currentTotalTaxSet.shopMoney.amount || 0) : null,
    currentTax: order.currentTotalTaxSet?.shopMoney ? Number(order.currentTotalTaxSet.shopMoney.amount || 0) : null,
    discounts: order.currentTotalDiscountsSet?.shopMoney ? Number(order.currentTotalDiscountsSet.shopMoney.amount || 0) : null,
    shippingCharged: order.currentShippingPriceSet?.shopMoney ? Number(order.currentShippingPriceSet.shopMoney.amount || 0) : null,
    paymentGatewayNames: Array.isArray(order.paymentGatewayNames) ? order.paymentGatewayNames.map(String).slice(0, 10) : [],
    paymentFees: null,
    channelFees: null,
    advertisingCost: null,
    actualShippingCost: null,
    otherVariableCosts: null,
    lineItems: (order.lineItems?.nodes || []).map(line => ({
      id: String(line.id || ''),
      name: String(line.name || ''),
      sku: String(line.sku || ''),
      quantity: Number(line.quantity || 0),
      gross: line.originalTotalSet?.shopMoney ? Number(line.originalTotalSet.shopMoney.amount || 0) : null,
      net: line.discountedTotalSet?.shopMoney ? Number(line.discountedTotalSet.shopMoney.amount || 0) : null
    }))
  };
}

function mergeProviderRecords(existing = [], provider, incoming = []) {
  return [...incoming, ...existing.filter(item => String(item.provider || '') !== provider)];
}

function payloadItems(payload, keys = []) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key];
  return [];
}

function nullableNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value?.value ?? value?.amount ?? value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sumAmounts(items, selector = value => value) {
  if (!Array.isArray(items) || !items.length) return null;
  const values = items.map(item => nullableNumber(selector(item))).filter(value => value !== null);
  if (!values.length) return null;
  return Number(values.reduce((sum, value) => sum + value, 0).toFixed(2));
}

function mapEbayOrder(order) {
  const total = nullableNumber(order.total ?? order.orderTotal ?? order.pricingSummary?.total);
  const refunds = nullableNumber(order.refunds ?? order.refundAmount ?? order.pricingSummary?.refunds) ??
    sumAmounts(order.paymentSummary?.refunds, refund => refund.refundAmount ?? refund.amount) ??
    sumAmounts(order.lineItems?.flatMap(line => line.refunds || []), refund => refund.refundAmount ?? refund.amount);
  const channelFees = nullableNumber(order.channelFees ?? order.ebayFees ?? order.fees ?? order.totalMarketplaceFee);
  const advertisingCost = nullableNumber(order.advertisingCost ?? order.promotedListingFee ?? order.adFees);
  const currentTotal = total === null ? null : Math.max(0, total - (refunds || 0));
  return {
    id: String(order.id || order.orderId || order.legacyOrderId || ''),
    externalId: String(order.externalId || order.orderId || order.id || ''),
    provider: 'ebay',
    name: String(order.name || order.orderId || order.id || ''),
    createdAt: order.createdAt || order.creationDate || order.orderDate || new Date().toISOString(),
    updatedAt: order.updatedAt || order.lastModifiedDate || order.createdAt || new Date().toISOString(),
    cancelledAt: order.cancelledAt || null,
    financialStatus: String(order.financialStatus || order.paymentStatus || (refunds && total && refunds >= total ? 'REFUNDED' : 'PAID')).toUpperCase(),
    fulfillmentStatus: String(order.fulfillmentStatus || order.orderFulfillmentStatus || 'UNFULFILLED').toUpperCase(),
    total,
    currentTotal,
    currency: String(order.currency || order.pricingSummary?.total?.currency || 'GBP'),
    refunds,
    tax: nullableNumber(order.tax ?? order.taxAmount ?? order.pricingSummary?.tax),
    currentTax: nullableNumber(order.currentTax ?? order.tax ?? order.taxAmount ?? order.pricingSummary?.tax),
    discounts: nullableNumber(order.discounts ?? order.discountAmount ?? order.pricingSummary?.priceDiscount),
    shippingCharged: nullableNumber(order.shippingCharged ?? order.deliveryCost ?? order.pricingSummary?.deliveryCost),
    actualShippingCost: nullableNumber(order.actualShippingCost ?? order.postageCost),
    paymentFees: nullableNumber(order.paymentFees ?? order.paymentProcessingFees),
    channelFees,
    advertisingCost,
    otherVariableCosts: nullableNumber(order.otherVariableCosts),
    lineItems: payloadItems(order.lineItems || order.items || order.orderLines, ['lineItems', 'items']).map(line => ({
      id: String(line.id || line.lineItemId || ''),
      name: String(line.name || line.title || ''),
      sku: String(line.sku || line.legacyItemId || ''),
      quantity: Number(line.quantity || 0),
      gross: nullableNumber(line.gross ?? line.total ?? line.lineItemCost),
      net: nullableNumber(line.net ?? line.total ?? line.lineItemCost)
    }))
  };
}

function mapEbayOAuthListing(item, offer, adByListingId) {
  const listingId = String(offer?.listing?.listingId || '');
  const price = nullableNumber(offer?.pricingSummary?.price ?? offer?.price) ?? 0;
  const inventoryQuantity = nullableNumber(item?.availability?.shipToLocationAvailability?.quantity);
  const offerQuantity = nullableNumber(offer?.availableQuantity);
  const ad = listingId ? adByListingId.get(listingId) : null;
  return {
    id: String(offer?.offerId || listingId || item?.sku || ''),
    title: String(item?.product?.title || item?.product?.subtitle || item?.sku || ''),
    sku: String(item?.sku || offer?.sku || ''),
    price,
    currency: String(offer?.pricingSummary?.price?.currency || 'GBP'),
    quantity: offerQuantity ?? inventoryQuantity,
    status: String(offer?.status || (listingId ? 'PUBLISHED' : 'UNPUBLISHED')),
    adRate: nullableNumber(ad?.bidPercentage),
    buyerShippingCharge: null,
    listingUrl: listingId ? `https://www.ebay.co.uk/itm/${encodeURIComponent(listingId)}` : null,
    image: item?.product?.imageUrls?.[0] || null,
    listingId,
    offerId: String(offer?.offerId || '')
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
    this.shopifyTokenCache = new Map();
    this.shopifyTokenRequests = new Map();
    this.ebayTokenCache = new Map();
    this.ebayTokenRequests = new Map();
  }

  shopifyConnection(state) {
    return (state?.connections || []).find(connection => connection.provider === 'shopify' && connection.encryptedCredentials) || null;
  }

  ebayOAuthConnection(state) {
    return (state?.connections || []).find(connection => connection.provider === 'ebay_oauth' && connection.encryptedCredentials) || null;
  }

  ebayManagerConnection(state) {
    return (state?.connections || []).find(connection => connection.provider === 'ebay' && connection.encryptedCredentials) || null;
  }

  ebayConnection(state) {
    const oauth = this.ebayOAuthConnection(state);
    return (oauth && this.ebayOAuthReady(state) ? oauth : null) || this.ebayManagerConnection(state) || oauth;
  }

  shopifyConfigured(state) {
    if (this.shopifyConnection(state)) return true;
    const workspaceId = String(state?.workspace?.id || '');
    const environmentWorkspace = String(this.env.SHOPIFY_ENV_WORKSPACE_ID || CUSTOMER_ZERO_WORKSPACE);
    return workspaceId === environmentWorkspace && Boolean(
      this.env.SHOPIFY_STORE_DOMAIN && (
        this.env.SHOPIFY_ADMIN_ACCESS_TOKEN ||
        (this.env.SHOPIFY_CLIENT_ID && this.env.SHOPIFY_CLIENT_SECRET)
      )
    );
  }

  shopifyConfig(state) {
    const workspaceId = String(state?.workspace?.id || '');
    const connection = this.shopifyConnection(state);
    if (connection) {
      let credentials;
      try {
        credentials = decryptCredentials(connection.encryptedCredentials, this.env.CREDENTIALS_KEY);
      } catch {
        throw integrationError('Stored Shopify credentials are invalid', 503, 'SHOPIFY_CREDENTIALS_INVALID');
      }
      const domain = normalizeDomain(credentials.storeDomain);
      const accessToken = String(credentials.accessToken || '');
      const clientId = String(credentials.clientId || '');
      const clientSecret = String(credentials.clientSecret || '');
      if (!accessToken && (!clientId || !clientSecret)) {
        throw integrationError('Stored Shopify credentials are incomplete', 503, 'SHOPIFY_CREDENTIALS_INVALID');
      }
      return {
        workspaceId,
        domain,
        apiVersion: String(this.env.SHOPIFY_ADMIN_API_VERSION || '2026-07'),
        accessToken,
        clientId,
        clientSecret,
        cacheKey: `connection:${workspaceId}:${connection.id}:${connection.updatedAt || connection.createdAt || ''}`,
        connection
      };
    }

    const environmentWorkspace = String(this.env.SHOPIFY_ENV_WORKSPACE_ID || CUSTOMER_ZERO_WORKSPACE);
    if (workspaceId !== environmentWorkspace) {
      throw integrationError('Shopify Admin API is not configured for this workspace', 503, 'SHOPIFY_NOT_CONFIGURED');
    }
    const domain = normalizeDomain(this.env.SHOPIFY_STORE_DOMAIN);
    const accessToken = String(this.env.SHOPIFY_ADMIN_ACCESS_TOKEN || '');
    const clientId = String(this.env.SHOPIFY_CLIENT_ID || '');
    const clientSecret = String(this.env.SHOPIFY_CLIENT_SECRET || '');
    if (!accessToken && (!clientId || !clientSecret)) {
      throw integrationError('Shopify Admin API is not configured', 503, 'SHOPIFY_NOT_CONFIGURED');
    }
    return {
      workspaceId,
      domain,
      apiVersion: String(this.env.SHOPIFY_ADMIN_API_VERSION || '2026-07'),
      accessToken,
      clientId,
      clientSecret,
      cacheKey: `environment:${workspaceId}:${domain}:${clientId}`,
      connection: null
    };
  }

  async shopifyAccessToken(config) {
    const configuredToken = String(config.accessToken || '');
    if (configuredToken) return configuredToken;

    const clientId = String(config.clientId || '');
    const clientSecret = String(config.clientSecret || '');
    if (!clientId || !clientSecret) {
      throw integrationError('Shopify Admin API is not configured', 503, 'SHOPIFY_NOT_CONFIGURED');
    }
    const cached = this.shopifyTokenCache.get(config.cacheKey);
    if (cached?.token && Date.now() + 60000 < cached.expiresAt) {
      return cached.token;
    }
    if (!this.shopifyTokenRequests.has(config.cacheKey)) {
      const request = (async () => {
        const response = await this.fetch(`https://${config.domain}/admin/oauth/access_token`, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Packsmart-Ops/4.2'
          },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret
          }).toString(),
          signal: AbortSignal.timeout(20000)
        });
        const payload = await responseJson(response, 'Shopify token');
        const token = String(payload.access_token || '');
        const expiresIn = Number(payload.expires_in || 0);
        if (!token || !Number.isFinite(expiresIn) || expiresIn < 60) {
          throw integrationError('Shopify returned an invalid access token', 502, 'SHOPIFY_TOKEN_INVALID');
        }
        this.shopifyTokenCache.set(config.cacheKey, { token, expiresAt: Date.now() + expiresIn * 1000 });
        return token;
      })();
      this.shopifyTokenRequests.set(config.cacheKey, request);
    }
    const request = this.shopifyTokenRequests.get(config.cacheKey);
    try { return await request; }
    finally {
      if (this.shopifyTokenRequests.get(config.cacheKey) === request) this.shopifyTokenRequests.delete(config.cacheKey);
    }
  }

  async shopifyGraphql(query, variables, config) {
    const version = String(config.apiVersion || '2026-07');
    if (!/^20\d\d-(01|04|07|10)$/.test(version)) throw integrationError('Invalid Shopify API version', 503, 'SHOPIFY_CONFIG_INVALID');
    const token = await this.shopifyAccessToken(config);
    const response = await this.fetch(`https://${config.domain}/admin/api/${version}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
        'User-Agent': 'Packsmart-Ops/4.2'
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

  async fetchShopifyProducts(config) {
    const products = [];
    let after = null;
    for (let page = 0; page < 10; page += 1) {
      const data = await this.shopifyGraphql(SHOPIFY_PRODUCTS_QUERY, { first: 50, after }, config);
      const connection = data?.products;
      products.push(...(connection?.nodes || []).map(mapAdminProduct));
      if (!connection?.pageInfo?.hasNextPage) break;
      after = connection.pageInfo.endCursor;
    }
    return products;
  }

  async fetchShopifyOrders(config) {
    const orders = [];
    let after = null;
    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    for (let page = 0; page < 10; page += 1) {
      const data = await this.shopifyGraphql(SHOPIFY_ORDERS_QUERY, { first: 50, after, query: `created_at:>=${cutoff}` }, config);
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
    if (this.shopifyConfigured(state)) {
      const config = this.shopifyConfig(state);
      const [products, orders] = await Promise.all([this.fetchShopifyProducts(config), this.fetchShopifyOrders(config)]);
      state.products = products;
      state.orders = mergeProviderRecords(state.orders, 'shopify', orders);
      if (config.connection) {
        config.connection.status = 'connected';
        config.connection.lastSyncAt = now;
        config.connection.lastError = null;
        config.connection.metadata = {
          ...(config.connection.metadata || {}),
          shopDomain: config.domain,
          itemCount: products.length
        };
      }
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

  ebayOAuthReady(state) {
    const workspaceId = String(state?.workspace?.id || '');
    const environmentWorkspace = String(this.env.EBAY_ENV_WORKSPACE_ID || CUSTOMER_ZERO_WORKSPACE);
    return workspaceId === environmentWorkspace &&
      ['1', 'true', 'yes', 'on'].includes(String(this.env.EBAY_OAUTH_ENABLED || '').toLowerCase()) &&
      String(this.env.EBAY_CLIENT_ID || '').length >= 8 &&
      String(this.env.EBAY_CLIENT_SECRET || '').length >= 16 &&
      String(this.env.EBAY_REDIRECT_URI_NAME || '').length >= 8 &&
      String(this.env.CREDENTIALS_KEY || '').length >= 32;
  }

  ebayOAuthStatus(state) {
    const connection = this.ebayOAuthConnection(state);
    return {
      ready: this.ebayOAuthReady(state),
      connected: Boolean(connection),
      readOnly: true,
      marketplaceId: String(connection?.metadata?.marketplaceId || this.env.EBAY_MARKETPLACE_ID || 'EBAY_GB')
    };
  }

  ebayAuthorizationUrl(oauthState, state) {
    if (!this.ebayOAuthReady(state)) throw integrationError('eBay read-only OAuth is not configured', 503, 'EBAY_OAUTH_NOT_CONFIGURED');
    const stateValue = String(oauthState || '');
    if (stateValue.length < 32 || stateValue.length > 4096 || /[\r\n]/.test(stateValue)) {
      throw integrationError('Invalid eBay authorization state', 400, 'EBAY_OAUTH_STATE_INVALID');
    }
    const url = new URL(EBAY_PRODUCTION.authorize);
    url.search = new URLSearchParams({
      client_id: String(this.env.EBAY_CLIENT_ID),
      redirect_uri: String(this.env.EBAY_REDIRECT_URI_NAME),
      response_type: 'code',
      scope: EBAY_READONLY_SCOPES.join(' '),
      state: stateValue,
      locale: 'en-GB'
    }).toString();
    return url.toString();
  }

  ebayOAuthHeaders() {
    const clientId = String(this.env.EBAY_CLIENT_ID || '');
    const clientSecret = String(this.env.EBAY_CLIENT_SECRET || '');
    if (clientId.length < 8 || clientSecret.length < 16) throw integrationError('eBay OAuth credentials are incomplete', 503, 'EBAY_OAUTH_NOT_CONFIGURED');
    return {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'User-Agent': 'Packsmart-Ops/4.3'
    };
  }

  async ebayTokenRequest(form, code) {
    const response = await this.fetch(EBAY_PRODUCTION.token, {
      method: 'POST',
      headers: this.ebayOAuthHeaders(),
      body: new URLSearchParams(form).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(20000)
    });
    let payload;
    try { payload = await response.json(); } catch { payload = {}; }
    if (!response.ok) throw integrationError('eBay OAuth token request failed', 502, code);
    const accessToken = String(payload.access_token || '');
    const expiresIn = Number(payload.expires_in || 0);
    if (!accessToken || !Number.isFinite(expiresIn) || expiresIn < 60) {
      throw integrationError('eBay returned an invalid access token', 502, 'EBAY_ACCESS_TOKEN_INVALID');
    }
    return { ...payload, accessToken, expiresIn };
  }

  async exchangeEbayAuthorizationCode(authorizationCode) {
    const code = String(authorizationCode || '');
    if (!code || code.length > 4096 || /[\r\n]/.test(code)) throw integrationError('eBay authorization code is invalid', 400, 'EBAY_AUTHORIZATION_CODE_INVALID');
    const payload = await this.ebayTokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: String(this.env.EBAY_REDIRECT_URI_NAME || '')
    }, 'EBAY_AUTHORIZATION_EXCHANGE_FAILED');
    const refreshToken = String(payload.refresh_token || '');
    if (!refreshToken || refreshToken.length > 8192) throw integrationError('eBay did not return a refresh token', 502, 'EBAY_REFRESH_TOKEN_INVALID');
    return {
      accessToken: payload.accessToken,
      expiresIn: payload.expiresIn,
      refreshToken,
      refreshTokenExpiresIn: Number(payload.refresh_token_expires_in || 0),
      scopes: EBAY_READONLY_SCOPES.slice()
    };
  }

  async ebayAccessToken(config) {
    const cached = this.ebayTokenCache.get(config.cacheKey);
    if (cached?.token && Date.now() + 60000 < cached.expiresAt) return cached.token;
    if (!this.ebayTokenRequests.has(config.cacheKey)) {
      const request = (async () => {
        const payload = await this.ebayTokenRequest({
          grant_type: 'refresh_token',
          refresh_token: config.refreshToken,
          scope: EBAY_READONLY_SCOPES.join(' ')
        }, 'EBAY_REFRESH_FAILED');
        this.ebayTokenCache.set(config.cacheKey, { token: payload.accessToken, expiresAt: Date.now() + payload.expiresIn * 1000 });
        return payload.accessToken;
      })();
      this.ebayTokenRequests.set(config.cacheKey, request);
    }
    const request = this.ebayTokenRequests.get(config.cacheKey);
    try { return await request; }
    finally {
      if (this.ebayTokenRequests.get(config.cacheKey) === request) this.ebayTokenRequests.delete(config.cacheKey);
    }
  }

  async ebayApiGet(url, accessToken, { marketplaceId } = {}) {
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'Packsmart-Ops/4.3'
    };
    if (marketplaceId) headers['X-EBAY-C-MARKETPLACE-ID'] = marketplaceId;
    const response = await this.fetch(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(20000)
    });
    return responseJson(response, 'eBay read API');
  }

  async ebayIdentity(accessToken) {
    return this.ebayApiGet(EBAY_PRODUCTION.identity, accessToken);
  }

  ebayConfigured(state) {
    if (this.ebayOAuthConnection(state) && this.ebayOAuthReady(state)) return true;
    if (this.ebayManagerConnection(state)) return true;
    const workspaceId = String(state?.workspace?.id || '');
    const environmentWorkspace = String(this.env.EBAY_ENV_WORKSPACE_ID || CUSTOMER_ZERO_WORKSPACE);
    return workspaceId === environmentWorkspace && Boolean(this.env.EBAY_MANAGER_BASE_URL);
  }

  ebayConfig(state) {
    const workspaceId = String(state?.workspace?.id || '');
    const oauthConnection = this.ebayOAuthConnection(state);
    if (oauthConnection && this.ebayOAuthReady(state)) {
      let credentials;
      try {
        credentials = decryptCredentials(oauthConnection.encryptedCredentials, this.env.CREDENTIALS_KEY);
      } catch {
        throw integrationError('Stored eBay OAuth credentials are invalid', 503, 'EBAY_CREDENTIALS_INVALID');
      }
      const refreshToken = String(credentials.refreshToken || '');
      if (credentials.mode !== 'direct_oauth' || !refreshToken || refreshToken.length > 8192) {
        throw integrationError('Stored eBay OAuth credentials are incomplete', 503, 'EBAY_CREDENTIALS_INVALID');
      }
      return {
        mode: 'direct_oauth',
        workspaceId,
        refreshToken,
        expectedAccount: String(credentials.expectedAccount || 'packsmartsolutions20'),
        marketplaceId: String(credentials.marketplaceId || this.env.EBAY_MARKETPLACE_ID || 'EBAY_GB'),
        cacheKey: `connection:${workspaceId}:${oauthConnection.id}:${oauthConnection.updatedAt || oauthConnection.createdAt || ''}`,
        connection: oauthConnection
      };
    }

    const connection = this.ebayManagerConnection(state);
    if (connection) {
      let credentials;
      try {
        credentials = decryptCredentials(connection.encryptedCredentials, this.env.CREDENTIALS_KEY);
      } catch {
        throw integrationError('Stored eBay Manager credentials are invalid', 503, 'EBAY_CREDENTIALS_INVALID');
      }
      return {
        mode: 'manager',
        workspaceId,
        base: validateRemoteBase(credentials.baseUrl, { allowLocal: this.env.NODE_ENV !== 'production' }),
        apiToken: String(credentials.apiToken || ''),
        expectedAccount: String(credentials.expectedAccount || 'packsmartsolutions20'),
        connection
      };
    }

    const environmentWorkspace = String(this.env.EBAY_ENV_WORKSPACE_ID || CUSTOMER_ZERO_WORKSPACE);
    if (workspaceId !== environmentWorkspace || !this.env.EBAY_MANAGER_BASE_URL) {
      throw integrationError('eBay is not configured for this workspace', 503, 'EBAY_NOT_CONFIGURED');
    }
    return {
      mode: 'manager',
      workspaceId,
      base: validateRemoteBase(this.env.EBAY_MANAGER_BASE_URL, { allowLocal: this.env.NODE_ENV !== 'production' }),
      apiToken: String(this.env.EBAY_MANAGER_API_TOKEN || ''),
      expectedAccount: String(this.env.EBAY_EXPECTED_ACCOUNT || 'packsmartsolutions20'),
      connection: null
    };
  }

  ebayHeaders(config) {
    const headers = { Accept: 'application/json', 'User-Agent': 'Packsmart-Ops/4.3' };
    if (config.apiToken) headers.Authorization = `Bearer ${config.apiToken}`;
    return headers;
  }

  async ebayGet(config, paths) {
    let lastStatus = 0;
    for (const path of paths) {
      const response = await this.fetch(`${config.base}${path}`, {
        method: 'GET',
        headers: this.ebayHeaders(config),
        redirect: 'error',
        signal: AbortSignal.timeout(15000)
      });
      lastStatus = response.status;
      if (response.status === 404 || response.status === 405) continue;
      return responseJson(response, 'eBay Manager');
    }
    throw integrationError(`eBay Manager read route was not found (${lastStatus || 'network error'})`, 502, 'EBAY_ROUTE_NOT_FOUND');
  }

  async fetchEbayOrders(accessToken) {
    const orders = [];
    for (let page = 0; page < 3; page += 1) {
      const offset = page * 200;
      const url = `${EBAY_PRODUCTION.fulfillment}/order?limit=200&offset=${offset}`;
      const payload = await this.ebayApiGet(url, accessToken);
      const batch = payloadItems(payload, ['orders']);
      orders.push(...batch);
      const total = Number(payload?.total);
      if (batch.length < 200 || (Number.isFinite(total) && total > 0 && orders.length >= total)) break;
    }
    return orders.slice(0, 500);
  }

  async fetchEbayInventoryItems(accessToken) {
    const items = [];
    for (let page = 0; page < 3; page += 1) {
      const offset = page * 200;
      const url = `${EBAY_PRODUCTION.inventory}/inventory_item?limit=200&offset=${offset}`;
      const payload = await this.ebayApiGet(url, accessToken);
      const batch = payloadItems(payload, ['inventoryItems']);
      items.push(...batch);
      const total = Number(payload?.total);
      if (batch.length < 200 || (Number.isFinite(total) && total > 0 && items.length >= total)) break;
    }
    return items.slice(0, 500);
  }

  async fetchEbayOffers(accessToken, inventoryItems, marketplaceId) {
    const offers = [];
    for (let index = 0; index < inventoryItems.length; index += 10) {
      const batch = inventoryItems.slice(index, index + 10);
      const results = await Promise.all(batch.map(async item => {
        const params = new URLSearchParams({ sku: String(item.sku || ''), limit: '25', marketplace_id: marketplaceId });
        const payload = await this.ebayApiGet(`${EBAY_PRODUCTION.inventory}/offer?${params}`, accessToken, { marketplaceId });
        return payloadItems(payload, ['offers']).map(offer => ({ item, offer }));
      }));
      offers.push(...results.flat());
    }
    return offers.slice(0, 1000);
  }

  async fetchEbayMarketing(accessToken, marketplaceId) {
    const campaignPayload = await this.ebayApiGet(`${EBAY_PRODUCTION.marketing}/ad_campaign?limit=100&offset=0`, accessToken, { marketplaceId });
    const campaigns = payloadItems(campaignPayload, ['campaigns']).slice(0, 100);
    const ads = [];
    for (let index = 0; index < campaigns.length; index += 5) {
      const batch = campaigns.slice(index, index + 5);
      const results = await Promise.all(batch.map(async campaign => {
        const campaignId = String(campaign.campaignId || '');
        if (!campaignId) return [];
        const payload = await this.ebayApiGet(`${EBAY_PRODUCTION.marketing}/ad_campaign/${encodeURIComponent(campaignId)}/ad?limit=500&offset=0`, accessToken, { marketplaceId });
        return payloadItems(payload, ['ads']).map(ad => ({ ...ad, campaignId }));
      }));
      ads.push(...results.flat());
    }
    return { campaigns, ads: ads.slice(0, 5000) };
  }

  async syncEbayOAuth(state, config) {
    const now = new Date().toISOString();
    const accessToken = await this.ebayAccessToken(config);
    const identity = await this.ebayIdentity(accessToken);
    const account = String(identity.username || identity.userId || '');
    if (!account) throw integrationError('eBay did not confirm the connected seller account', 502, 'EBAY_ACCOUNT_UNCONFIRMED');
    if (account.toLowerCase() !== config.expectedAccount.toLowerCase()) {
      throw integrationError('eBay reported the wrong seller account', 502, 'EBAY_ACCOUNT_MISMATCH');
    }

    const [rawOrders, inventoryItems, marketing] = await Promise.all([
      this.fetchEbayOrders(accessToken),
      this.fetchEbayInventoryItems(accessToken),
      this.fetchEbayMarketing(accessToken, config.marketplaceId).catch(() => ({ campaigns: [], ads: [], unavailable: true }))
    ]);
    const offerPairs = await this.fetchEbayOffers(accessToken, inventoryItems, config.marketplaceId);
    const adByListingId = new Map(marketing.ads.map(ad => [String(ad.listingId || ''), ad]));
    const listings = offerPairs.map(({ item, offer }) => mapEbayOAuthListing(item, offer, adByListingId)).filter(item => item.id);
    const drafts = listings.filter(item => !item.listingId || item.status.toUpperCase() !== 'PUBLISHED');
    const published = listings.filter(item => item.listingId && item.status.toUpperCase() === 'PUBLISHED');
    const orders = rawOrders.map(mapEbayOrder).filter(order => order.id);
    const fees = rawOrders.map(order => ({
      orderId: String(order.orderId || ''),
      amount: nullableNumber(order.totalMarketplaceFee),
      currency: String(order.totalMarketplaceFee?.currency || order.pricingSummary?.total?.currency || 'GBP')
    })).filter(record => record.orderId && record.amount !== null);
    state.orders = mergeProviderRecords(state.orders, 'ebay', orders);

    const shopifySkus = new Set((state.products || []).flatMap(product => (product.variants || []).map(variant => variant.sku).filter(Boolean)));
    const listingSkus = new Set(published.map(item => item.sku).filter(Boolean));
    const missingOnEbay = [...shopifySkus].filter(sku => !listingSkus.has(sku));
    const staleOnEbay = [...listingSkus].filter(sku => !shopifySkus.has(sku));
    state.ebay = {
      account,
      marketplaceId: config.marketplaceId,
      source: 'ebay-oauth-readonly',
      listings: published.slice(0, 500),
      drafts: drafts.slice(0, 500).map(item => ({ id: item.offerId || item.id, title: item.title, sku: item.sku, updatedAt: null })),
      fees: fees.slice(0, 1000),
      promotions: marketing.campaigns.slice(0, 500),
      health: { missingOnEbay: missingOnEbay.slice(0, 100), staleOnEbay: staleOnEbay.slice(0, 100) },
      coverage: {
        inventoryApiItems: inventoryItems.length,
        marketingAvailable: !marketing.unavailable,
        standardManagerPreserved: true
      },
      syncedAt: now
    };
    config.connection.status = 'connected';
    config.connection.lastSyncAt = now;
    config.connection.lastError = null;
    config.connection.metadata = {
      ...(config.connection.metadata || {}),
      account,
      marketplaceId: config.marketplaceId,
      listingCount: published.length,
      draftCount: drafts.length,
      channel: 'direct_oauth'
    };
    const status = {
      status: 'connected',
      detail: `${published.length} Inventory API listings, ${drafts.length} drafts and ${orders.length} recent orders synced directly from eBay read-only. The existing Manager remains unchanged.`,
      source: 'ebay-oauth-readonly',
      account,
      listingCount: published.length,
      draftCount: drafts.length,
      orderCount: orders.length,
      feeRecordCount: fees.length,
      promotionCount: marketing.campaigns.length,
      mismatchCount: missingOnEbay.length + staleOnEbay.length,
      lastSyncAt: now,
      lastError: null
    };
    state.integrationStatus = { ...(state.integrationStatus || {}), ebay: status };
    return status;
  }

  async syncEbay(state) {
    const now = new Date().toISOString();
    if (!this.ebayConfigured(state)) {
      const status = {
        status: 'not_configured',
        detail: 'Existing eBay Manager backend URL is required; no duplicate OAuth connection has been created.',
        lastSyncAt: null,
        lastError: null
      };
      state.integrationStatus = { ...(state.integrationStatus || {}), ebay: status };
      return status;
    }
    const config = this.ebayConfig(state);
    if (config.mode === 'direct_oauth') return this.syncEbayOAuth(state, config);
    const statusPayload = await this.ebayGet(config, ['/api/ebay/status', '/api/status', '/api/health']);
    const account = String(statusPayload.account || statusPayload.username || statusPayload.ebayUser || '');
    const connected = statusPayload.connected === true || statusPayload.authenticated === true || statusPayload.ebayConnected === true;
    const expected = config.expectedAccount.toLowerCase();
    if (!connected || !account) throw integrationError('eBay Manager did not confirm its connected account', 502, 'EBAY_ACCOUNT_UNCONFIRMED');
    if (account.toLowerCase() !== expected) throw integrationError('eBay Manager reported the wrong seller account', 502, 'EBAY_ACCOUNT_MISMATCH');

    const [listingPayload, draftPayload, orderPayload, feePayload, promotionPayload] = await Promise.all([
      this.ebayGet(config, ['/api/ebay/listings', '/api/listings']).catch(() => ({ listings: [] })),
      this.ebayGet(config, ['/api/ebay/drafts', '/api/drafts']).catch(() => ({ drafts: [] })),
      this.ebayGet(config, ['/api/ebay/orders', '/api/orders']).catch(() => ({ orders: [] })),
      this.ebayGet(config, ['/api/ebay/fees', '/api/fees']).catch(() => ({ fees: [] })),
      this.ebayGet(config, ['/api/ebay/promotions', '/api/promotions']).catch(() => ({ promotions: [] }))
    ]);
    const listings = payloadItems(listingPayload, ['listings', 'items']);
    const drafts = payloadItems(draftPayload, ['drafts', 'items']);
    const orders = payloadItems(orderPayload, ['orders', 'items']).map(mapEbayOrder).filter(order => order.id);
    const fees = payloadItems(feePayload, ['fees', 'items']);
    const promotions = payloadItems(promotionPayload, ['promotions', 'campaigns', 'items']);
    state.orders = mergeProviderRecords(state.orders, 'ebay', orders);
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
        buyerShippingCharge: nullableNumber(item.buyerShippingCharge ?? item.shippingCost),
        listingUrl: item.listingUrl || item.url || null
      })),
      drafts: drafts.slice(0, 500).map(item => ({ id: String(item.id || ''), title: String(item.title || ''), sku: String(item.sku || ''), updatedAt: item.updatedAt || null })),
      fees: fees.slice(0, 1000),
      promotions: promotions.slice(0, 500),
      health: { missingOnEbay: missingOnEbay.slice(0, 100), staleOnEbay: staleOnEbay.slice(0, 100) },
      syncedAt: now
    };
    if (config.connection) {
      config.connection.status = 'connected';
      config.connection.lastSyncAt = now;
      config.connection.lastError = null;
      config.connection.metadata = {
        ...(config.connection.metadata || {}),
        account,
        marketplaceId: statusPayload.marketplaceId || 'EBAY_GB',
        listingCount: listings.length,
        draftCount: drafts.length
      };
    }
    const status = {
      status: 'connected',
      detail: `${listings.length} listings, ${drafts.length} drafts and ${orders.length} orders read from the existing ${account} backend. Writes remain disabled.`,
      account,
      listingCount: listings.length,
      draftCount: drafts.length,
      orderCount: orders.length,
      feeRecordCount: fees.length,
      promotionCount: promotions.length,
      mismatchCount: missingOnEbay.length + staleOnEbay.length,
      lastSyncAt: now,
      lastError: null
    };
    state.integrationStatus = { ...(state.integrationStatus || {}), ebay: status };
    return status;
  }
}
