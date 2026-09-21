import crypto from 'node:crypto';
import { decryptCredentials, encryptCredentials, safeEqual } from './security.mjs';
import { connectionError, connectionSettings, validateAreas } from './connection-centre.mjs';

import { META_VERSION, META_READ_SCOPES, META_CATALOG_SCOPES, META_PUBLISH_SCOPES } from './meta-capabilities.mjs';

const APPS = {
  shopify: { prefix: 'SHOPIFY_OAUTH', scopes: ['read_products', 'read_inventory', 'read_orders'] },
  meta: { prefix: 'META', scopes: META_READ_SCOPES, auth: `https://www.facebook.com/${META_VERSION}/dialog/oauth`, token: `https://graph.facebook.com/${META_VERSION}/oauth/access_token` },
  google_youtube: { prefix: 'GOOGLE', scopes: ['https://www.googleapis.com/auth/youtube.readonly'], auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token' },
  pinterest: { prefix: 'PINTEREST', scopes: ['user_accounts:read', 'boards:read', 'pins:read'], auth: 'https://www.pinterest.com/oauth/', token: 'https://api.pinterest.com/v5/oauth/token' }
};
const enabled = value => ['true', '1'].includes(String(value));
const domain = value => {
  const normalized = String(value || '').trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/$/, '');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(normalized)) throw connectionError('Enter your store’s permanent address ending in .myshopify.com.', 'SHOPIFY_DOMAIN_INVALID');
  return normalized;
};
function app(service, provider) {
  const definition = APPS[provider];
  if (!definition) throw connectionError('Runvara is waiting for this channel’s connection service to be enabled.', 'OAUTH_NOT_CONFIGURED', 409);
  return { ...definition, clientId: String(service.env[`${definition.prefix}_CLIENT_ID`] || ''), clientSecret: String(service.env[`${definition.prefix}_CLIENT_SECRET`] || '') };
}
async function json(service, url, options = {}) {
  const response = await service.fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
  let payload; try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok || payload.error) throw Object.assign(connectionError('The channel could not confirm access. Please reconnect or try again.', [400, 401, 403].includes(response.status) ? 'CONNECTION_AUTH_REQUIRED' : 'CONNECTION_READ_FAILED', 422), { upstreamStatus: response.status });
  return payload;
}
const scopes = value => Array.isArray(value) ? value : String(value || '').split(/[ ,]+/).filter(Boolean);
function packTokens(payload, old = {}) {
  if (!payload.access_token) throw connectionError('The channel did not return access. Please reconnect.', 'CONNECTION_AUTH_REQUIRED', 422);
  return { ...old, mode: 'oauth', accessToken: payload.access_token, refreshToken: payload.refresh_token || old.refreshToken || null,
    expiresAt: payload.expires_in ? Date.now() + Number(payload.expires_in) * 1000 : null, scopes: payload.scope ? scopes(payload.scope) : old.scopes || [],
    refreshTokenExpiresAt: payload.refresh_token_expires_in ? Date.now() + Number(payload.refresh_token_expires_in) * 1000 : old.refreshTokenExpiresAt || null };
}

// Methods are installed on the existing service; all connections use the same
// encrypted records, fetch boundary, tenant state and persistence transaction.
export const connectorMethods = {
  oauthReady(provider, state) {
    if (provider === 'ebay') return this.ebayOAuthReady(state);
    if (provider === 'tiktok_shop') return Boolean(enabled(this.env.TIKTOK_SHOP_OAUTH_ENABLED) && this.env.TIKTOK_SHOP_APP_KEY && this.env.TIKTOK_SHOP_APP_SECRET && this.env.TIKTOK_SHOP_SERVICE_ID && String(this.env.CREDENTIALS_KEY || '').length >= 32 && /^https:\/\//.test(this.env.APP_PUBLIC_URL || ''));
    const definition = APPS[provider];
    return Boolean(definition && enabled(this.env[`${definition.prefix}_ENABLED`] || this.env[`${definition.prefix}_OAUTH_ENABLED`]) && this.env[`${definition.prefix}_CLIENT_ID`] && this.env[`${definition.prefix}_CLIENT_SECRET`] && String(this.env.CREDENTIALS_KEY || '').length >= 32 && /^https:\/\//.test(this.env.APP_PUBLIC_URL || ''));
  },
  oauthRedirect(provider) { return `${String(this.env.APP_PUBLIC_URL || '').replace(/\/$/, '')}/api/integrations/${provider}/oauth/callback`; },
  authorizationUrl(provider, token, state, options = {}) {
    if (!this.oauthReady(provider, state)) throw connectionError('Secure sign-in for this channel is not available yet. Your workspace can record a setup request.', 'OAUTH_NOT_CONFIGURED', 409);
    if (provider === 'ebay') return this.ebayAuthorizationUrl(token, state);
    if (provider === 'tiktok_shop') {
      const url = new URL(this.env.TIKTOK_SHOP_MARKET === 'US' ? 'https://services.us.tiktokshop.com/open/authorize' : 'https://services.tiktokshop.com/open/authorize');
      url.search = new URLSearchParams({ service_id: this.env.TIKTOK_SHOP_SERVICE_ID, state: token }).toString(); return url.toString();
    }
    const config = app(this, provider), url = new URL(provider === 'shopify' ? `https://${domain(options.storeDomain)}/admin/oauth/authorize` : config.auth);
    const requested = config.scopes.slice();
    if (provider === 'meta' && options.catalogAccess) requested.push(...META_CATALOG_SCOPES);
    if (provider === 'meta' && options.writeAccess) requested.push(...META_PUBLISH_SCOPES);
    if (provider === 'meta' && options.businessInstagramAccess) requested.push('ads_read', 'ads_management');
    if (provider === 'shopify' && options.includeCustomers) requested.push('read_customers');
    if (provider === 'shopify' && options.writeAccess) requested.push('write_products');
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: this.oauthRedirect(provider), response_type: 'code', scope: requested.join(provider === 'shopify' ? ',' : ' '), state: token }).toString();
    if (provider === 'meta') {
      url.searchParams.set('scope', requested.join(',')); url.searchParams.set('auth_type', 'rerequest');
      if (this.env.META_LOGIN_CONFIG_ID) { url.searchParams.set('config_id', this.env.META_LOGIN_CONFIG_ID); url.searchParams.set('override_default_response_type', 'true'); }
    }
    if (provider === 'google_youtube') {
      url.searchParams.set('access_type', 'offline'); url.searchParams.set('prompt', 'consent');
      url.searchParams.set('code_challenge', crypto.createHash('sha256').update(options.verifier).digest('base64url')); url.searchParams.set('code_challenge_method', 'S256');
    }
    return url.toString();
  },
  async exchangeConnectorCode(provider, url, challenge) {
    const code = String(url.searchParams.get('code') || '');
    if (!code || code.length > 8192) throw connectionError('The channel did not return a valid sign-in response.', 'OAUTH_CODE_INVALID');
    if (provider === 'ebay') {
      const auth = await this.exchangeEbayAuthorizationCode(code);
      return { mode: 'direct_oauth', ...auth };
    }
    if (provider === 'tiktok_shop') return this.tiktokToken({ auth_code: code, grant_type: 'authorized_code' });
    const config = app(this, provider);
    if (provider === 'shopify') {
      const shop = domain(url.searchParams.get('shop'));
      if (shop !== challenge.storeDomain || Math.abs(Date.now() / 1000 - Number(url.searchParams.get('timestamp'))) > 600) throw connectionError('Shopify returned a different store or an expired response.', 'OAUTH_STATE_INVALID');
      const params = [...url.searchParams.entries()].filter(([key]) => key !== 'hmac').sort(([a], [b]) => a.localeCompare(b));
      const message = params.map(([key, value]) => `${key}=${value}`).join('&');
      const digest = crypto.createHmac('sha256', config.clientSecret).update(message).digest('hex');
      if (!safeEqual(digest, url.searchParams.get('hmac'))) throw connectionError('Shopify could not verify this response.', 'OAUTH_SIGNATURE_INVALID');
      const payload = await json(this, `https://${shop}/admin/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, expiring: 1 }) });
      return { ...packTokens(payload), storeDomain: shop };
    }
    const form = { grant_type: 'authorization_code', code, redirect_uri: this.oauthRedirect(provider) };
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (provider === 'pinterest') { headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`; form.continuous_refresh = 'true'; }
    else { form.client_id = config.clientId; form.client_secret = config.clientSecret; }
    if (provider === 'google_youtube') form.code_verifier = challenge.verifier;
    const payload = await json(this, config.token, { method: 'POST', headers, body: new URLSearchParams(form).toString() });
    const credentials = packTokens(payload, { scopes: config.scopes });
    if (provider === 'meta') {
      const extended = await json(this, config.token, { method: 'POST', headers, body: new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: config.clientId, client_secret: config.clientSecret, fb_exchange_token: credentials.accessToken }).toString() });
      return packTokens(extended, credentials);
    }
    return credentials;
  },
  async connectorGet(provider, path, credentials, query = {}) {
    const base = { google_youtube: 'https://www.googleapis.com/youtube/v3', pinterest: 'https://api.pinterest.com/v5' }[provider];
    if (!base || !/^\/[a-z_]+$/.test(path)) throw connectionError('This read operation is unavailable.', 'READ_UNSUPPORTED');
    const url = new URL(base + path); url.search = new URLSearchParams(query).toString();
    return json(this, url.toString(), { headers: { Authorization: `Bearer ${credentials.accessToken}`, Accept: 'application/json' } });
  },
  async connectorIdentity(provider, credentials) {
    if (provider === 'ebay') { const value = await this.ebayIdentity(credentials.accessToken); return { account: value.username || value.userId, accountId: value.userId || value.username }; }
    if (provider === 'tiktok_shop') {
      const data = await this.tiktokRead('/authorization/202309/shops', credentials);
      if (!data.shops?.length) throw connectionError('TikTok has not authorised a shop. Reconnect and select your shop.', 'CONNECTION_AUTH_REQUIRED', 422);
      return { account: data.shops.map(shop => shop.name).join(', '), accountId: credentials.openId, grantedScopes: credentials.scopes || [] };
    }
    if (provider === 'shopify') {
      const config = { ...credentials, domain: credentials.storeDomain, apiVersion: this.env.SHOPIFY_ADMIN_API_VERSION || '2026-07' };
      const data = await this.shopifyGraphql('query ConnectionIdentity { shop { id name myshopifyDomain } currentAppInstallation { accessScopes { handle } } }', {}, config);
      if (!data?.shop?.id || data.shop.myshopifyDomain !== config.domain) throw connectionError('Shopify could not confirm the expected store.', 'ACCOUNT_MISMATCH', 422);
      return { account: data.shop.name, shopDomain: config.domain, accountId: data.shop.id, grantedScopes: data.currentAppInstallation?.accessScopes?.map(scope => scope.handle) || [] };
    }
    if (provider === 'meta') return this.metaIdentity(credentials);
    if (provider === 'google_youtube') { const value = await this.connectorGet(provider, '/channels', credentials, { part: 'id,snippet', mine: 'true', maxResults: '50' }); return { account: value.items?.map(item => item.snippet?.title).join(', ') || 'Google account (no YouTube channel)', accountId: value.items?.map(item => item.id).sort().join(',') || 'no-channel' }; }
    const value = await this.connectorGet(provider, '/user_account', credentials);
    return { account: value.username, accountId: value.username };
  },
  clearConnectionCache(state, provider) {
    for (const cache of [this.shopifyTokenCache, this.ebayTokenCache]) for (const key of cache.keys()) if (key.includes(`:${state.workspace.id}:`)) cache.delete(key);
  },
  refreshSupported(state, provider) {
    try {
      if (provider === 'ebay') return this.ebayConfig(state).mode === 'direct_oauth';
      const record = (state.connections || []).find(item => item.provider === provider);
      if (!record) return provider === 'shopify' && Boolean(this.shopifyConfig(state).clientSecret);
      const credentials = decryptCredentials(record.encryptedCredentials, this.env.CREDENTIALS_KEY);
      return Boolean(credentials.refreshToken || (provider === 'shopify' && credentials.clientSecret));
    } catch { return false; }
  },
  async connectorCredentials(state, provider, { forceRefresh = false } = {}) {
    const record = (state.connections || []).find(item => item.provider === provider && item.encryptedCredentials);
    if (!record || connectionSettings(state, provider).disconnected) throw connectionError('Connect this channel first.', 'CONNECTION_DISCONNECTED', 409);
    let credentials;
    try { credentials = decryptCredentials(record.encryptedCredentials, this.env.CREDENTIALS_KEY); }
    catch { throw connectionError('Your saved connection needs reconnecting.', 'CONNECTION_CREDENTIALS_INVALID', 422); }
    if (forceRefresh || (credentials.expiresAt && Date.now() + 60000 >= credentials.expiresAt)) {
      if (!credentials.refreshToken) throw connectionError('Sign in again to renew this connection.', 'CONNECTION_AUTH_REQUIRED', 422);
      if (provider === 'tiktok_shop') {
        credentials = await this.tiktokToken({ refresh_token: credentials.refreshToken, grant_type: 'refresh_token' }, credentials);
        record.encryptedCredentials = encryptCredentials(credentials, this.env.CREDENTIALS_KEY); record.updatedAt = new Date().toISOString(); return credentials;
      }
      const config = app(this, provider), headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      const form = { grant_type: 'refresh_token', refresh_token: credentials.refreshToken };
      if (provider === 'pinterest') headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
      else { form.client_id = config.clientId; form.client_secret = config.clientSecret; }
      const endpoint = provider === 'shopify' ? `https://${domain(credentials.storeDomain)}/admin/oauth/access_token` : config.token;
      const payload = await json(this, endpoint, { method: 'POST', headers, body: new URLSearchParams(form).toString() });
      credentials = packTokens(payload, credentials);
      record.encryptedCredentials = encryptCredentials(credentials, this.env.CREDENTIALS_KEY);
      record.updatedAt = new Date().toISOString();
    }
    return credentials;
  },
  async testConnection(state, provider, { refresh = false } = {}) {
    if (connectionSettings(state, provider).disconnected) throw connectionError('Reconnect this channel first.', 'CONNECTION_DISCONNECTED', 409);
    let identity, record;
    if (provider === 'shopify') {
      const config = this.shopifyConfig(state); record = config.connection;
      if (config.mode === 'oauth') {
        const credentials = await this.connectorCredentials(state, provider, { forceRefresh: refresh });
        identity = await this.connectorIdentity(provider, credentials);
      } else {
        if (refresh) this.shopifyTokenCache.delete(config.cacheKey);
        identity = await this.connectorIdentity(provider, { ...config, accessToken: await this.shopifyAccessToken(config), storeDomain: config.domain });
      }
    } else if (provider === 'ebay') {
      const config = this.ebayConfig(state); record = config.connection;
      if (config.mode === 'direct_oauth') {
        if (refresh) this.ebayTokenCache.delete(config.cacheKey);
        identity = await this.connectorIdentity(provider, { accessToken: await this.ebayAccessToken(config) });
      } else {
        const value = await this.ebayGet(config, ['/api/ebay/status', '/api/status', '/api/health']);
        if (!(value.connected || value.authenticated || value.ebayConnected)) throw connectionError('Your eBay Manager connection needs attention.', 'CONNECTION_AUTH_REQUIRED', 422);
        identity = { account: value.account || value.username || value.ebayUser };
      }
      if (!identity.account || identity.account.toLowerCase() !== config.expectedAccount.toLowerCase()) throw connectionError('This is a different eBay seller. Reconnect the expected account.', 'ACCOUNT_MISMATCH', 422);
    } else {
      const credentials = await this.connectorCredentials(state, provider, { forceRefresh: refresh });
      identity = await this.connectorIdentity(provider, credentials);
      record = state.connections.find(item => item.provider === provider);
      if (record.metadata?.accountId && record.metadata.accountId !== identity.accountId) throw connectionError('This is a different account. Reconnect to confirm the change.', 'ACCOUNT_MISMATCH', 422);
    }
    if (record) { record.lastCheckedAt = new Date().toISOString(); record.metadata = { ...record.metadata, ...identity }; record.status = 'connected'; record.lastError = null; }
    const previous = state.integrationStatus?.[provider] || {};
    state.integrationStatus = { ...state.integrationStatus, [provider]: { ...previous, status: 'connected', lastError: null, detail: 'Connection tested successfully. Sync now to refresh your data.' } };
    return { ok: true, identity, checkedAt: record?.lastCheckedAt || new Date().toISOString() };
  },
  async syncProvider(state, provider, options = {}) {
    if (provider === 'shopify') return this.syncShopify(state, options);
    if (provider === 'ebay') return this.syncEbay(state, options);
    if (provider === 'meta') return this.syncMeta(state, options);
    const selected = validateAreas(provider, options.areas || connectionSettings(state, provider).areas);
    const credentials = await this.connectorCredentials(state, provider);
    const data = { ...state.channelData?.[provider] };
    const readAreas = provider === 'tiktok_shop' ? [...new Set(selected.map(area => ['variants','inventory','prices'].includes(area) ? 'products' : area))] : selected;
    let tiktokShops;
    if (provider === 'tiktok_shop') {
      tiktokShops = (await this.tiktokRead('/authorization/202309/shops', credentials)).shops || [];
      if (tiktokShops.length > 10) throw connectionError('This seller has more shops than this connection can read at once. Your previous data is retained.', 'CONNECTION_COVERAGE_LIMIT', 422);
    }
    for (const area of readAreas) {
      if (provider === 'tiktok_shop') {
        if (area === 'shops') { data.shops = tiktokShops.map(shop => ({ id: String(shop.id), name: String(shop.name), region: String(shop.region || '') })); continue; }
        const records = [];
        for (const shop of tiktokShops) {
          let cursor = null;
          for (let page = 0; page < 50; page++) {
            const path = area === 'products' ? '/product/202502/products/search' : '/order/202309/orders/search';
            const payload = await this.tiktokRead(path, credentials, { shop_cipher: shop.cipher, page_size: '100', ...(cursor ? { page_token: cursor } : {}) }, area === 'products' ? { status: 'ALL' } : { create_time_ge: Math.floor(Date.now() / 1000) - 90 * 86400 });
            if (!Array.isArray(payload[area])) throw connectionError('TikTok returned an incomplete response. Previous data is retained.', 'CONNECTION_READ_FAILED', 422);
            for (const item of payload[area]) {
              const id = `${shop.id}:${item.id}`;
              if (area === 'orders') records.push({ id, externalId: String(item.id), shopId: String(shop.id), status: String(item.status || ''), createdAt: Number(item.create_time) > 0 ? new Date(Number(item.create_time) * 1000).toISOString() : null });
              else {
                const previous = (data.products || []).find(record => record.id === id);
                if (!selected.includes('products') && !previous) continue;
                const product = selected.includes('products') ? { id, externalId: String(item.id), shopId: String(shop.id), title: String(item.title || ''), status: String(item.status || '') } : { ...previous };
                product.variants = (item.skus || []).flatMap(sku => {
                  const prior = previous?.variants?.find(variant => variant.id === sku.id);
                  if (!selected.includes('variants') && !prior) return [];
                  return [{ ...(selected.includes('variants') ? { id: String(sku.id), sku: String(sku.seller_sku || '') } : prior),
                    price: selected.includes('prices') ? sku.price?.sale_price ?? sku.price?.tax_exclusive_price ?? null : prior?.price ?? null,
                    currency: selected.includes('prices') ? sku.price?.currency || null : prior?.currency || null,
                    inventory: selected.includes('inventory') ? Array.isArray(sku.inventory) ? sku.inventory.reduce((sum, row) => sum + Number(row.quantity || 0), 0) : null : prior?.inventory ?? null }];
                });
                records.push(product);
              }
            }
            cursor = payload.next_page_token;
            if (!cursor) break;
            if (page === 49) throw connectionError('TikTok returned more records than can be read in one sync. Previous data is retained.', 'CONNECTION_COVERAGE_LIMIT', 422);
          }
        }
        if (area === 'orders') { const merged = new Map((data.orders || []).map(item => [item.id, item])); for (const item of records) merged.set(item.id, item); data.orders = [...merged.values()]; }
        else data.products = records;
        continue;
      }
      const items = []; let cursor = null;
      for (let page = 0; page < 20; page++) {
        const path = `/${area}`;
        const payload = await this.connectorGet(provider, path, credentials, provider === 'google_youtube' ? { part: 'id,snippet,statistics', mine: 'true', maxResults: '50', ...(cursor ? { pageToken: cursor } : {}) } : { page_size: '100', ...(cursor ? { bookmark: cursor } : {}) });
        const rows = payload.items || payload.data || [];
        items.push(...rows.map(item => ({ id: String(item.id || ''), name: String(item.name || item.title || item.snippet?.title || ''), description: String(item.description || item.snippet?.description || '').slice(0, 2000), ...(item.instagram_business_account ? { instagram: { id: String(item.instagram_business_account.id), username: String(item.instagram_business_account.username || '') } } : {}), ...(item.statistics ? { statistics: item.statistics } : {}) })));
        cursor = payload.nextPageToken || payload.bookmark || (payload.paging?.next ? payload.paging?.cursors?.after : null);
        if (!cursor) break;
        if (page === 19) throw connectionError('This account has more data than can be read in one sync. Your previous data has been retained.', 'CONNECTION_COVERAGE_LIMIT', 422);
      }
      data[area] = items;
    }
    state.channelData = { ...state.channelData, [provider]: data };
    const record = state.connections.find(item => item.provider === provider), now = new Date().toISOString();
    record.status = 'connected'; record.lastSyncAt = now; record.lastError = null;
    state.integrationStatus = { ...state.integrationStatus, [provider]: { ...state.integrationStatus?.[provider], status: 'connected', lastSyncAt: now, lastError: null, detail: 'Selected data synced successfully.' } };
    return state.integrationStatus[provider];
  },
  async tiktokToken(form, old = {}) {
    const endpoint = form.grant_type === 'refresh_token' ? 'refresh' : 'get';
    const url = new URL(`https://auth.tiktok-shops.com/api/v2/token/${endpoint}`);
    url.search = new URLSearchParams({ app_key: this.env.TIKTOK_SHOP_APP_KEY, app_secret: this.env.TIKTOK_SHOP_APP_SECRET, ...form }).toString();
    const payload = await json(this, url.toString());
    if (payload.code !== 0 || !payload.data?.access_token || ![0, 4, 5].includes(payload.data.user_type ?? old.userType)) throw connectionError('TikTok Shop could not renew seller access. Reconnect your shop.', 'CONNECTION_AUTH_REQUIRED', 422);
    const value = payload.data;
    return { ...old, mode: 'oauth', accessToken: value.access_token, refreshToken: value.refresh_token || old.refreshToken, expiresAt: Number(value.access_token_expire_in) * 1000,
      refreshTokenExpiresAt: Number(value.refresh_token_expire_in) * 1000, openId: value.open_id || old.openId, userType: value.user_type ?? old.userType, scopes: value.granted_scopes || old.scopes || [] };
  },
  async tiktokRead(path, credentials, params = {}, body) {
    if (!['/authorization/202309/shops', '/product/202502/products/search', '/order/202309/orders/search'].includes(path)) throw connectionError('This TikTok read is unavailable.', 'READ_UNSUPPORTED');
    const query = { app_key: this.env.TIKTOK_SHOP_APP_KEY, timestamp: String(Math.floor(Date.now() / 1000)), ...params };
    const rawBody = body ? JSON.stringify(body) : '';
    const url = new URL(`https://open-api.tiktokglobalshop.com${path}`);
    url.search = new URLSearchParams({ ...query, sign: tiktokSignature(path, query, rawBody, this.env.TIKTOK_SHOP_APP_SECRET) }).toString();
    const payload = await json(this, url.toString(), { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'x-tts-access-token': credentials.accessToken }, ...(body ? { body: rawBody } : {}) });
    if (payload.code !== 0) throw connectionError('TikTok could not read this data. Test the connection and reconnect if needed.', 'TIKTOK_READ_FAILED', 422);
    return payload.data;
  }
};

export function tiktokSignature(path, params, body, secret) {
  const values = Object.keys(params).filter(key => !['sign', 'access_token'].includes(key)).sort().map(key => key + params[key]).join('');
  return crypto.createHmac('sha256', secret).update(secret + path + values + body + secret).digest('hex');
}
