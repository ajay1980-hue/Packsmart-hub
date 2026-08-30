(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PacksmartEbayCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_PHOTOS = 24;

  function stripHtml(html, documentRef) {
    if (!html) return '';
    if (documentRef && documentRef.createElement) {
      const d = documentRef.createElement('div');
      d.innerHTML = html;
      return (d.textContent || d.innerText || '').trim();
    }
    return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function normalizePublicProduct(p, documentRef) {
    return {
      id: p && p.id,
      handle: (p && p.handle) || '',
      title: (p && p.title) || 'Untitled product',
      description: stripHtml((p && p.body_html) || '', documentRef),
      variants: ((p && p.variants) || []).map(v => ({
        title: v.title || '',
        price: v.price || '',
        sku: v.sku || ''
      })),
      images: ((p && p.images) || []).map(img => img && img.src).filter(Boolean)
    };
  }

  function normalizeSnapshotProduct(p) {
    return {
      id: p && p.id,
      handle: (p && p.handle) || '',
      title: (p && p.title) || 'Untitled product',
      description: (p && p.description) || '',
      variants: ((p && p.variants) || []).map(v => ({
        title: v.title || '',
        price: v.price || '',
        sku: v.sku || ''
      })),
      images: p && p.image ? [p.image] : ((p && p.images) || []).filter(Boolean)
    };
  }

  function movePhoto(photos, index, direction) {
    const copy = photos.slice();
    const to = index + direction;
    if (index < 0 || index >= copy.length || to < 0 || to >= copy.length) return copy;
    const item = copy.splice(index, 1)[0];
    copy.splice(to, 0, item);
    return copy;
  }

  function makeMain(photos, index) {
    const copy = photos.slice();
    if (index <= 0 || index >= copy.length) return copy;
    const item = copy.splice(index, 1)[0];
    copy.unshift(item);
    return copy;
  }

  function appendPhotos(existing, incoming, maxPhotos) {
    const limit = Number.isFinite(maxPhotos) ? maxPhotos : MAX_PHOTOS;
    const copy = existing.slice(0, limit);
    const remaining = Math.max(0, limit - copy.length);
    return copy.concat(incoming.slice(0, remaining));
  }

  function buildDraft(fields, photos, selectedProduct, catalogueSource) {
    const ordered = photos.slice(0, MAX_PHOTOS);
    let localIndex = 0;
    const photoOrder = ordered.map((p, index) => {
      const isLocal = p.kind === 'file';
      const item = {
        position: index + 1,
        main: index === 0,
        kind: isLocal ? 'file' : 'remote',
        name: p.name || `Photo ${index + 1}`,
        url: isLocal ? null : (p.url || null),
        localFileIndex: isLocal ? localIndex : null
      };
      if (isLocal) localIndex += 1;
      return item;
    });

    return {
      source: 'packsmart-ebay-manager',
      catalogueSource: catalogueSource || null,
      shopifyProductId: selectedProduct && selectedProduct.id || null,
      shopifyHandle: selectedProduct && selectedProduct.handle || null,
      title: String(fields.title || '').trim().slice(0, 80),
      price: String(fields.price || '').trim(),
      sku: String(fields.sku || '').trim(),
      description: String(fields.description || '').trim(),
      imageUrls: ordered.filter(p => p.kind !== 'file' && p.url).map(p => p.url),
      localPhotoCount: localIndex,
      photoOrder
    };
  }

  function validateDraft(draft, photoCount) {
    const errors = [];
    if (!draft.title) errors.push('Add a listing title first.');
    const price = Number(draft.price);
    if (!Number.isFinite(price) || price <= 0) errors.push('Add a valid price greater than £0.');
    if (!photoCount) errors.push('Add at least one product photo.');
    if (photoCount > MAX_PHOTOS) errors.push(`eBay allows a maximum of ${MAX_PHOTOS} photos.`);
    return errors;
  }

  return {
    MAX_PHOTOS,
    stripHtml,
    normalizePublicProduct,
    normalizeSnapshotProduct,
    movePhoto,
    makeMain,
    appendPhotos,
    buildDraft,
    validateDraft
  };
});
