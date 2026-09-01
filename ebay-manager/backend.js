(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PacksmartEbayBackend = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_ROUTES = {
    status: ['/api/ebay/status', '/api/status', '/api/health'],
    draft: ['/api/ebay/drafts', '/api/ebay/draft', '/api/drafts', '/api/draft'],
    listing: ['/api/ebay/listings', '/api/ebay/listing', '/api/create-listing', '/create-listing']
  };

  function joinUrl(baseUrl, path) {
    if (!baseUrl) return path;
    return `${String(baseUrl).replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`;
  }

  async function parseResponse(res) {
    const type = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    const text = await res.text();
    if (!text) return {};
    if (type.includes('application/json')) {
      try { return JSON.parse(text); } catch (_) { return { message: text }; }
    }
    try { return JSON.parse(text); } catch (_) { return { message: text }; }
  }

  function createBackend(options) {
    const config = options || {};
    const fetchImpl = config.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const FormDataCtor = config.FormDataCtor || (typeof FormData !== 'undefined' ? FormData : null);
    if (!fetchImpl) throw new Error('Fetch API is unavailable.');
    if (!FormDataCtor) throw new Error('FormData API is unavailable.');

    const baseUrl = config.baseUrl || '';
    const routes = {
      status: config.routes && config.routes.status || DEFAULT_ROUTES.status,
      draft: config.routes && config.routes.draft || DEFAULT_ROUTES.draft,
      listing: config.routes && config.routes.listing || DEFAULT_ROUTES.listing
    };
    const working = {};

    async function requestFirst(kind, init) {
      const candidates = working[kind] ? [working[kind]] : routes[kind];
      let last = null;
      for (const path of candidates) {
        const url = joinUrl(baseUrl, path);
        let res;
        try {
          res = await fetchImpl(url, Object.assign({ credentials: 'include' }, init));
        } catch (error) {
          last = error;
          continue;
        }
        if (res.status === 404 || res.status === 405) {
          last = new Error(`${kind} route ${path} returned ${res.status}`);
          continue;
        }
        const data = await parseResponse(res);
        if (!res.ok) {
          const message = data && (data.error || data.message) || `${kind} request failed (${res.status})`;
          const error = new Error(message);
          error.status = res.status;
          error.data = data;
          throw error;
        }
        working[kind] = path;
        return { data, path, status: res.status };
      }
      throw last || new Error(`No compatible ${kind} backend route found.`);
    }

    function buildMultipart(draft, photos, action) {
      const form = new FormDataCtor();
      const orderedLocal = [];
      (photos || []).forEach(photo => {
        if (photo.kind === 'file' && photo.file) orderedLocal.push(photo);
      });

      const payload = Object.assign({}, draft, {
        action,
        photoOrder: (draft.photoOrder || []).map(item => Object.assign({}, item))
      });

      form.append('payload', JSON.stringify(payload));
      form.append('draft', JSON.stringify(payload));
      form.append('listing', JSON.stringify(payload));
      form.append('title', draft.title || '');
      form.append('price', draft.price || '');
      form.append('sku', draft.sku || '');
      form.append('description', draft.description || '');
      form.append('ebayAccount', draft.ebayAccount || '');
      form.append('marketplaceId', draft.marketplaceId || 'EBAY_GB');
      form.append('imageUrls', JSON.stringify(draft.imageUrls || []));
      form.append('photoOrder', JSON.stringify(draft.photoOrder || []));
      form.append('postage', JSON.stringify(draft.postage || {}));
      form.append('freeShipping', String(Boolean(draft.freeShipping)));
      form.append('shippingCost', draft.shippingCost || '');
      form.append('shippingService', draft.shippingService || '');
      form.append('fulfillmentPolicyId', draft.fulfillmentPolicyId || '');

      orderedLocal.forEach((photo, index) => {
        const name = photo.name || `photo-${index + 1}.jpg`;
        form.append('photos', photo.file, name);
      });
      return form;
    }

    async function status() {
      return requestFirst('status', { method: 'GET', headers: { 'Accept': 'application/json' } });
    }

    async function saveDraft(draft, photos) {
      return requestFirst('draft', { method: 'POST', body: buildMultipart(draft, photos, 'draft') });
    }

    async function createListing(draft, photos) {
      return requestFirst('listing', { method: 'POST', body: buildMultipart(draft, photos, 'publish') });
    }

    return { status, saveDraft, createListing, workingRoutes: working, buildMultipart };
  }

  return { DEFAULT_ROUTES, createBackend, joinUrl };
});
