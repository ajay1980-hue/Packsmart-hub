import crypto from 'node:crypto';
import { connectionError, connectionSettings, validateAreas } from './connection-centre.mjs';

import { META_VERSION, META_READ_SCOPES, META_CATALOG_SCOPES, META_PUBLISH_SCOPES, META_WRITES, META_ORDER_RESTRICTION } from './meta-capabilities.mjs';
export { META_VERSION, META_READ_SCOPES, META_CATALOG_SCOPES, META_PUBLISH_SCOPES, META_WRITES, META_ORDER_RESTRICTION };
const numericId = value => /^\d{1,32}$/.test(String(value || ''));
const required = (value, max, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw connectionError(`Enter ${name} (up to ${max} characters).`);
  return value.trim();
};
function publicUrl(value, name) {
  let url; try { url = new URL(value); } catch { throw connectionError(`Enter a public HTTPS ${name}.`); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') || /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname) || url.hostname.includes(':') || url.href.length > 2000) throw connectionError(`Enter a public HTTPS ${name}.`);
  return url.href;
}
export function metaWriteScopes(operation) {
  return operation.startsWith('catalog_') ? META_CATALOG_SCOPES : operation === 'instagram_publish' ? ['instagram_basic', 'instagram_content_publish', 'pages_read_engagement'] : ['pages_manage_posts', 'pages_read_engagement'];
}
export function requireMetaScopes(granted, requiredScopes) {
  if (requiredScopes.some(scope => !granted?.includes(scope))) throw connectionError('Meta has not granted the access needed for this action. Reconnect and select the relevant catalogue or publishing access.', 'META_PERMISSION_REQUIRED', 403);
}
export function prepareMetaWrite(state, body) {
  if (!META_WRITES.includes(body.operation)) throw connectionError('This Meta write action is not supported.', 'WRITE_UNSUPPORTED', 422);
  const input = { operation: body.operation }, saved = state.channelData?.meta || {}, settings = connectionSettings(state, 'meta');
  if (body.operation.startsWith('catalog_')) {
    if (!numericId(body.catalogId) || !settings.metaCatalogIds?.includes(body.catalogId)) throw connectionError('Select a catalogue authorised for this workspace.', 'META_ASSET_REQUIRED', 409);
    input.catalogId = body.catalogId;
    if (body.operation !== 'catalog_product_create') {
      const product = saved.products?.find(item => item.id === body.productId && item.catalogId === input.catalogId);
      if (!product) throw connectionError('Sync and select a product from this workspace’s catalogue.', 'PRODUCT_NOT_FOUND', 404);
      input.productId = product.id;
    }
    if (body.operation === 'catalog_visibility') {
      if (!['staging','published'].includes(body.visibility)) throw connectionError('Choose draft or published visibility.');
      input.visibility = body.visibility;
    } else if (body.operation === 'catalog_inventory') {
      if (!Number.isSafeInteger(body.quantity) || body.quantity < 0 || body.quantity > 100000000) throw connectionError('Enter a whole stock quantity between 0 and 100,000,000.');
      input.quantity = body.quantity;
      if (!['in stock', 'out of stock', 'preorder', 'available for order', 'discontinued'].includes(body.availability)) throw connectionError('Choose a valid availability.');
      input.availability = body.availability;
    } else {
      input.name = required(body.name, 200, 'the product name'); input.description = required(body.description, 5000, 'the product description');
      if (body.operation === 'catalog_product_create') {
        input.retailerId = required(body.retailerId, 100, 'your SKU'); input.brand = required(body.brand, 100, 'the brand');
        input.category = required(body.category, 750, 'the product category'); input.url = publicUrl(body.url, 'product address'); input.imageUrl = publicUrl(body.imageUrl, 'image address');
        if (!Number.isSafeInteger(body.priceMinor) || body.priceMinor <= 0 || body.priceMinor > 100000000 || !/^[A-Z]{3}$/.test(body.currency || '')) throw connectionError('Enter a positive price in minor currency units and a three-letter currency.');
        input.priceMinor = body.priceMinor; input.currency = body.currency; input.availability = 'out of stock'; input.condition = 'new'; input.visibility = 'staging';
      }
    }
  } else {
    if (!numericId(body.pageId) || !settings.metaPageIds?.includes(body.pageId)) throw connectionError('Select a Facebook Page authorised for this workspace.', 'META_ASSET_REQUIRED', 409);
    const page = state.connections?.find(item => item.provider === 'meta')?.metadata?.assets?.pages?.find(item => item.id === body.pageId);
    if (!page) throw connectionError('Test the connection to refresh available Pages.', 'META_ASSET_REQUIRED', 409);
    input.pageId = body.pageId;
    if (body.operation === 'instagram_publish') {
      if (!numericId(page.instagram?.id)) throw connectionError('This Page needs a linked Instagram professional account.', 'META_INSTAGRAM_REQUIRED', 409);
      input.instagramId = page.instagram.id; input.caption = required(body.message, 2200, 'the caption'); input.imageUrl = publicUrl(body.imageUrl, 'JPEG image address');
    } else {
      input.message = required(body.message, 5000, 'the post text');
      if (body.operation === 'facebook_publish' && body.url) input.link = publicUrl(body.url, 'link');
      if (body.operation === 'facebook_update') {
        const original = state.connectionWrites?.find(item => item.provider === 'meta' && item.status === 'completed' && item.input.operation === 'facebook_publish' && item.input.pageId === input.pageId && item.result?.externalId === body.postId);
        if (!original) throw connectionError('Meta only permits editing posts created by this app. Select a post published by Runvara in this workspace.', 'META_POST_NOT_OWNED', 409);
        input.postId = original.result.externalId;
      }
    }
  }
  return input;
}

export const metaMethods = {
  async metaRequest(path, token, { method = 'GET', query = {}, body } = {}) {
    if (!/^\/(?:me|debug_token|\d{1,32}(?:_\d{1,32})?)(?:\/[a-z_]+)?$/.test(path)) throw connectionError('This Meta operation is unavailable.', 'META_PATH_INVALID');
    const url = new URL(`https://graph.facebook.com/${META_VERSION}${path}`);
    url.search = new URLSearchParams({ ...query, appsecret_proof: crypto.createHmac('sha256', this.env.META_CLIENT_SECRET || '').update(token).digest('hex') }).toString();
    const response = await this.fetch(url.toString(), { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(20000) });
    let value; try { value = await response.json(); } catch { throw connectionError('Meta did not confirm the result. Check the channel before repeating a change.', 'META_RESULT_UNKNOWN', 422); }
    if (!response.ok || value.error) {
      const code = Number(value.error?.code), auth = code === 190 || response.status === 401, permission = [10, 200].includes(code) || response.status === 403;
      const rate = [4, 17, 32, 613, 80004, 80014].includes(code) || response.status === 429;
      throw Object.assign(connectionError(auth ? 'Your Meta connection has expired. Reconnect your account.' : permission ? 'Meta has not granted access to this data or action. Reconnect with the required access, or ask the business administrator to assign this asset.' : rate ? 'Meta is limiting requests. Wait before trying again.' : 'Meta declined this request. Check the selected asset and submitted fields.', auth ? 'META_AUTH_REQUIRED' : permission ? 'META_PERMISSION_REQUIRED' : rate ? 'META_RATE_LIMITED' : 'META_REQUEST_REJECTED', 422), { upstreamStatus: response.status, upstreamCode: Number.isSafeInteger(code) ? code : null, upstreamSubcode: Number.isSafeInteger(value.error?.error_subcode) ? value.error.error_subcode : null, definitive: response.status < 500 && Boolean(value.error) });
    }
    return value;
  },
  async metaList(path, token, query = {}) {
    const rows = []; let after;
    for (let page = 0; page < 20; page++) {
      const value = await this.metaRequest(path, token, { query: { ...query, limit: '100', ...(after ? { after } : {}) } });
      if (!Array.isArray(value.data)) throw connectionError('Meta returned incomplete data. Previous records are retained.', 'META_READ_INCOMPLETE', 422);
      rows.push(...value.data);
      if (!value.paging?.next) return rows;
      after = value.paging?.cursors?.after;
      if (!after) throw connectionError('Meta did not provide a safe continuation. Previous records are retained.', 'META_READ_INCOMPLETE', 422);
    }
    throw connectionError('This asset exceeds the 2,000-record sync limit. Previous records are retained.', 'META_COVERAGE_LIMIT', 422);
  },
  async metaPermissions(credentials) {
    return (await this.metaList('/me/permissions', credentials.accessToken)).filter(item => item.status === 'granted').map(item => item.permission);
  },
  async metaAssets(credentials, granted) {
    const rawPages = granted.includes('pages_show_list') ? await this.metaList('/me/accounts', credentials.accessToken, { fields: `id,name,tasks,access_token${granted.includes('instagram_basic') ? ',instagram_business_account{id,username}' : ''}` }) : [];
    const discovery = { checkedAt: new Date().toISOString(), source: 'me/accounts', returnedPageCount: rawPages.length, pageChecks: [] };
    // Granular grants can include Pages omitted by /me/accounts. Verify the
    // token with the same app, then ask Graph for those exact granted targets.
    // Neither an app token nor a Page token is persisted in public metadata.
    try {
      const debug = await this.metaRequest('/debug_token', `${this.env.META_CLIENT_ID}|${this.env.META_CLIENT_SECRET}`, { query: { input_token: credentials.accessToken } });
      if (debug.data?.is_valid && String(debug.data.app_id) === String(this.env.META_CLIENT_ID)) {
        const targets = [...new Set((debug.data.granular_scopes || []).filter(item => item.scope === 'pages_show_list').flatMap(item => item.target_ids || []).map(String).filter(numericId))];
        discovery.grantedPageIds = targets;
        for (const id of targets.filter(id => !rawPages.some(page => String(page.id) === id)).slice(0,20)) {
          try {
            const page = await this.metaRequest(`/${id}`, credentials.accessToken, { query: { fields: `id,name,access_token${granted.includes('instagram_basic') ? ',instagram_business_account{id,username}' : ''}` } });
            if (String(page.id) !== id) throw connectionError('Meta returned a different Page.', 'META_ASSET_MISMATCH', 422);
            rawPages.push(page);
            discovery.pageChecks.push({ pageId:id, result:'granted_page_recovered' });
          } catch (error) { discovery.pageChecks.push({ pageId:id, result:'lookup_failed', code:error.code || 'META_READ_FAILED', httpStatus:error.upstreamStatus || null, providerCode:error.upstreamCode || null, providerSubcode:error.upstreamSubcode || null }); }
        }
      } else discovery.tokenCheck = 'unconfirmed';
    } catch { discovery.tokenCheck = 'unavailable'; }
    // Use only Pages returned for this workspace token, never caller-supplied IDs.
    if (granted.includes('instagram_basic')) for (const page of rawPages.slice(0,20)) {
      if (page.instagram_business_account || !numericId(page.id) || !page.access_token) continue;
      try {
        const detail = await this.metaRequest(`/${page.id}`, page.access_token, { query: { fields: 'id,instagram_business_account{id,username}' } });
        if (String(detail.id) !== String(page.id)) throw connectionError('Meta returned a different Page.', 'META_ASSET_MISMATCH', 422);
        if (detail.instagram_business_account) page.instagram_business_account = detail.instagram_business_account;
        discovery.pageChecks.push({ pageId: String(page.id), result: page.instagram_business_account ? 'linked' : 'no_link_returned' });
      } catch (error) {
        discovery.pageChecks.push({ pageId: String(page.id), result: 'lookup_failed', code: error.code || 'META_READ_FAILED', httpStatus: error.upstreamStatus || null, providerCode: error.upstreamCode || null, providerSubcode: error.upstreamSubcode || null });
      }
    }
    const pages = rawPages.map(item => ({ id: String(item.id), name: String(item.name || ''), tasks: item.tasks || [], ...(item.instagram_business_account ? { instagram: { id: String(item.instagram_business_account.id), username: String(item.instagram_business_account.username || '') } } : {}) }));
    const catalogs = [];
    if (META_CATALOG_SCOPES.every(scope => granted.includes(scope))) {
      const businesses = await this.metaList('/me/businesses', credentials.accessToken, { fields: 'id,name' });
      if (businesses.length > 20) throw connectionError('Select fewer businesses during Meta sign-in.', 'META_COVERAGE_LIMIT', 422);
      for (const business of businesses) for (const edge of ['owned_product_catalogs', 'client_product_catalogs']) {
        for (const catalog of await this.metaList(`/${business.id}/${edge}`, credentials.accessToken, { fields: 'id,name,vertical' })) if (!catalogs.some(item => item.id === String(catalog.id))) catalogs.push({ id: String(catalog.id), name: String(catalog.name || ''), businessId: String(business.id), vertical: String(catalog.vertical || '') });
      }
    }
    // Page tokens exist only in this server-side return, never in public metadata.
    return { pages, catalogs, discovery, pageTokens: Object.fromEntries(rawPages.map(item => [String(item.id), item.access_token])) };
  },
  async metaIdentity(credentials) {
    const user = await this.metaRequest('/me', credentials.accessToken, { query: { fields: 'id,name' } });
    const grantedScopes = await this.metaPermissions(credentials), { pages, catalogs, discovery } = await this.metaAssets(credentials, grantedScopes);
    return { account: String(user.name || ''), accountId: String(user.id || ''), grantedScopes, assets: { pages, catalogs }, discovery };
  },
  async syncMeta(state, options = {}) {
    const selected = validateAreas('meta', options.areas || connectionSettings(state, 'meta').areas), settings = connectionSettings(state, 'meta');
    const credentials = await this.connectorCredentials(state, 'meta'), granted = await this.metaPermissions(credentials);
    const assets = await this.metaAssets(credentials, granted), data = structuredClone(state.channelData?.meta || {});
    if (selected.includes('accounts')) data.accounts = assets.pages;
    if (selected.includes('catalogs')) { requireMetaScopes(granted, META_CATALOG_SCOPES); data.catalogs = assets.catalogs; }
    if (selected.some(area => ['products', 'inventory', 'prices'].includes(area))) {
      requireMetaScopes(granted, META_CATALOG_SCOPES);
      if (!settings.metaCatalogIds?.length) throw connectionError('Choose a catalogue in this connection’s asset settings before syncing products.', 'META_ASSET_REQUIRED', 409);
      const products = [];
      for (const catalogId of settings.metaCatalogIds) {
        if (!assets.catalogs.some(item => item.id === catalogId)) throw connectionError('This catalogue is no longer authorised. Review selected assets.', 'META_PERMISSION_REQUIRED', 403);
        const fields = ['id', 'retailer_id', ...(selected.includes('products') ? ['name','description','url','image_url','visibility','retailer_product_group_id'] : []), ...(selected.includes('inventory') ? ['availability','inventory','quantity_to_sell_on_facebook'] : []), ...(selected.includes('prices') ? ['price','currency'] : [])];
        for (const item of await this.metaList(`/${catalogId}/products`, credentials.accessToken, { fields: fields.join(',') })) {
          const prior = data.products?.find(product => product.id === String(item.id) && product.catalogId === catalogId) || {};
          products.push({ ...prior, id: String(item.id), catalogId, retailerId: String(item.retailer_id || ''), ...(selected.includes('products') ? { name: String(item.name || ''), description: String(item.description || ''), url: String(item.url || ''), imageUrl: String(item.image_url || ''), visibility: String(item.visibility || ''), groupId: String(item.retailer_product_group_id || '') } : {}), ...(selected.includes('inventory') ? { availability: String(item.availability || ''), quantity: item.quantity_to_sell_on_facebook ?? item.inventory ?? null } : {}), ...(selected.includes('prices') ? { price: item.price ?? null, currency: String(item.currency || '') } : {}) });
        }
        if (products.length > 2000) throw connectionError('The selected catalogues exceed the 2,000-product sync limit. Previous records are retained.', 'META_COVERAGE_LIMIT', 422);
      }
      const merged = new Map((data.products || []).map(item => [item.id, item])); for (const item of products) merged.set(item.id, item); data.products = [...merged.values()];
    }
    if (selected.includes('posts')) {
      requireMetaScopes(granted, ['pages_read_engagement']);
      if (!settings.metaPageIds?.length) throw connectionError('Choose a Facebook Page before syncing posts.', 'META_ASSET_REQUIRED', 409);
      const posts = [];
      for (const pageId of settings.metaPageIds) {
        if (!assets.pages.some(item => item.id === pageId) || !assets.pageTokens[pageId]) throw connectionError('The selected Page needs reconnecting.', 'META_PERMISSION_REQUIRED', 403);
        for (const post of await this.metaList(`/${pageId}/published_posts`, assets.pageTokens[pageId], { fields: 'id,message,created_time,permalink_url' })) posts.push({ id: String(post.id), pageId, message: String(post.message || ''), createdAt: post.created_time || null, url: String(post.permalink_url || '') });
      }
      if (posts.length > 2000) throw connectionError('Select fewer Pages to keep this sync below 2,000 posts.', 'META_COVERAGE_LIMIT', 422);
      data.posts = posts;
    }
    const now = new Date().toISOString(), record = state.connections.find(item => item.provider === 'meta');
    state.channelData = { ...state.channelData, meta: data };
    Object.assign(record, { status: 'connected', lastSyncAt: now, lastError: null, metadata: { ...record.metadata, grantedScopes: granted, assets: { pages: assets.pages, catalogs: assets.catalogs }, discovery: assets.discovery } });
    return (state.integrationStatus.meta = { ...state.integrationStatus.meta, status: 'connected', lastSyncAt: now, lastError: null, detail: 'Selected Meta data synced successfully.' });
  },
  async executeMetaWrite(state, write, persistClaim) {
    const input = write.input, credentials = await this.connectorCredentials(state, 'meta'), granted = await this.metaPermissions(credentials);
    requireMetaScopes(granted, metaWriteScopes(input.operation));
    const assets = await this.metaAssets(credentials, granted), settings = connectionSettings(state, 'meta');
    let result;
    if (input.operation.startsWith('catalog_')) {
      if (!settings.metaCatalogIds?.includes(input.catalogId) || !assets.catalogs.some(item => item.id === input.catalogId)) throw connectionError('This catalogue is no longer selected or authorised.', 'META_PERMISSION_REQUIRED', 403);
      if (input.operation !== 'catalog_product_create') {
        const product = await this.metaRequest(`/${input.productId}`, credentials.accessToken, { query: { fields: 'id,product_catalog' } });
        if (String(product.product_catalog?.id) !== input.catalogId) throw connectionError('The product does not belong to the approved catalogue.', 'META_ASSET_MISMATCH', 403);
      }
      const body = input.operation === 'catalog_visibility' ? { visibility: input.visibility } : input.operation === 'catalog_inventory' ? { inventory: input.quantity, availability: input.availability } : { name: input.name, description: input.description };
      if (input.operation === 'catalog_product_create') Object.assign(body, { retailer_id: input.retailerId, brand: input.brand, category: input.category, url: input.url, image_url: input.imageUrl, price: input.priceMinor, currency: input.currency, availability: input.availability, condition: input.condition, visibility: input.visibility });
      result = await this.metaRequest(input.operation === 'catalog_product_create' ? `/${input.catalogId}/products` : `/${input.productId}`, credentials.accessToken, { method: 'POST', body });
    } else {
      const page = assets.pages.find(item => item.id === input.pageId), token = assets.pageTokens[input.pageId];
      if (!settings.metaPageIds?.includes(input.pageId) || !page || !token) throw connectionError('This Page is no longer selected or authorised.', 'META_PERMISSION_REQUIRED', 403);
      if (input.operation === 'instagram_publish') {
        if (page.instagram?.id !== input.instagramId) throw connectionError('The linked Instagram account changed. Prepare a new request.', 'META_ASSET_MISMATCH', 403);
        if (write.providerState?.publishStartedAt) throw connectionError('Check Instagram before creating another request. This publication will not be repeated.', 'META_RESULT_UNKNOWN', 409);
        if (write.providerState?.checkAfter && Date.now() < write.providerState.checkAfter) return { pending: true };
        if (!write.providerState?.containerId) {
          const limit = await this.metaRequest(`/${input.instagramId}/content_publishing_limit`, token, { query: { fields: 'quota_usage,config' } });
          if (limit.data?.some(item => Number(item.quota_usage) >= Number(item.config?.quota_total || 100))) throw connectionError('Instagram’s publishing limit has been reached. Try later with a new approved request.', 'META_RATE_LIMITED', 429);
          const container = await this.metaRequest(`/${input.instagramId}/media`, token, { method: 'POST', body: { image_url: input.imageUrl, caption: input.caption } });
          if (!numericId(container.id)) throw connectionError('Instagram did not confirm the media container.', 'META_RESULT_UNKNOWN', 422);
          write.providerState = { containerId: String(container.id), createdAt: new Date().toISOString() }; await persistClaim();
        }
        const status = await this.metaRequest(`/${write.providerState.containerId}`, token, { query: { fields: 'status_code' } });
        if (status.status_code === 'IN_PROGRESS') { write.providerState.checkAfter = Date.now() + 60000; return { pending: true }; }
        if (status.status_code !== 'FINISHED') throw connectionError('Instagram could not confirm that this image is ready. Check Instagram before creating another request.', 'META_MEDIA_NOT_READY', 422);
        write.providerState.publishStartedAt = new Date().toISOString(); await persistClaim();
        result = await this.metaRequest(`/${input.instagramId}/media_publish`, token, { method: 'POST', body: { creation_id: write.providerState.containerId } });
      } else result = await this.metaRequest(input.operation === 'facebook_publish' ? `/${input.pageId}/feed` : `/${input.postId}`, token, { method: 'POST', body: { message: input.message, ...(input.link ? { link: input.link } : {}) } });
    }
    if (!result?.id && result?.success !== true) throw connectionError('Meta did not confirm this change. Check the channel before repeating it.', 'META_RESULT_UNKNOWN', 422);
    return { externalId: String(result.id || input.productId || input.postId), confirmed: true };
  }
};
