(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PacksmartEbayCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_PHOTOS = 24;
  const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
  const MAX_LABEL_BYTES = 25 * 1024 * 1024;
  const PHOTO_EXTENSIONS = ['jpg', 'jpeg', 'gif', 'png', 'bmp', 'tif', 'tiff', 'avif', 'heic', 'webp'];
  const PHOTO_MIME_TYPES = [
    'image/jpeg', 'image/gif', 'image/png', 'image/bmp', 'image/tiff',
    'image/avif', 'image/heic', 'image/heif', 'image/webp'
  ];

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

  function fileExtension(name) {
    const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : '';
  }

  function validatePhotoFile(file) {
    if (!file) return 'No photo file was selected.';
    const type = String(file.type || '').toLowerCase();
    const extension = fileExtension(file.name);
    const supported = PHOTO_MIME_TYPES.includes(type) || PHOTO_EXTENSIONS.includes(extension);
    if (!supported) {
      return `${file.name || 'This file'} is not an eBay-supported image. Use JPG, PNG, GIF, BMP, TIFF, AVIF, HEIC or WEBP.`;
    }
    if (Number(file.size) > MAX_PHOTO_BYTES) {
      return `${file.name || 'This photo'} is larger than eBay's 12 MB image limit.`;
    }
    return '';
  }

  function labelFileKind(file) {
    const type = String(file && file.type || '').toLowerCase();
    const extension = fileExtension(file && file.name);
    if (type === 'application/pdf' || extension === 'pdf') return 'pdf';
    if (PHOTO_MIME_TYPES.includes(type) || PHOTO_EXTENSIONS.includes(extension)) return 'image';
    return '';
  }

  function validateLabelFile(file) {
    if (!file) return 'Choose a postage-label PDF or image first.';
    if (!labelFileKind(file)) return 'Postage labels must be a PDF or supported image file.';
    if (Number(file.size) > MAX_LABEL_BYTES) return 'The postage-label file is larger than 25 MB.';
    return '';
  }

  function normalizePostage(fields) {
    const mode = fields && fields.postageMode === 'paid' ? 'paid' : 'free';
    const enteredCost = String(fields && fields.shippingCost || '').trim();
    const numericCost = Number(enteredCost);
    const cost = mode === 'free'
      ? '0.00'
      : (Number.isFinite(numericCost) ? numericCost.toFixed(2) : enteredCost);

    return {
      mode,
      optionType: 'DOMESTIC',
      costType: 'FLAT_RATE',
      freeShipping: mode === 'free',
      buyerResponsibleForShipping: mode === 'paid',
      serviceCode: String(fields && fields.shippingServiceCode || '').trim(),
      serviceName: String(fields && fields.shippingServiceName || '').trim(),
      shippingCost: { value: cost, currency: 'GBP' },
      fulfillmentPolicyId: String(fields && fields.fulfillmentPolicyId || '').trim() || null
    };
  }

  function extractEbayAccount(data) {
    if (!data || typeof data !== 'object') return '';
    const account = data.ebayAccount || data.ebayUser || data.username || data.userId ||
      data.userID || data.accountName || (data.user && (data.user.username || data.user.userId));
    return String(account || '').trim();
  }

  function normalizeVariations(rows) {
    return (rows || []).filter(row => row && row.enabled !== false).map(row => ({
      name: 'Pack size',
      value: `Pack of ${Number(row.quantity)}`,
      quantity: Number(row.quantity),
      price: String(row.price || '').trim(),
      sku: String(row.sku || '').trim()
    })).filter(row => [50, 100, 200].includes(row.quantity));
  }

  function normalizePromotion(fields) {
    const enabled = fields && fields.promotionType === 'promoted-listings-standard';
    const rate = Number(fields && fields.adRatePercent);
    return {
      enabled,
      type: enabled ? 'PROMOTED_LISTINGS_STANDARD' : 'NONE',
      adRatePercent: enabled && Number.isFinite(rate) ? rate.toFixed(1) : null
    };
  }

  function buildDraft(fields, photos, selectedProduct, catalogueSource) {
    fields = fields || {};
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

    const postage = normalizePostage(fields || {});
    const variations = normalizeVariations(fields.variations);
    const promotion = normalizePromotion(fields);
    const shippingService = {
      shippingService: postage.serviceCode,
      shippingServiceCost: postage.shippingCost.value,
      freeShipping: postage.freeShipping,
      shippingServicePriority: 1
    };

    return {
      source: 'packsmart-ebay-manager',
      ebayAccount: String(fields.ebayAccount || '').trim() || null,
      marketplaceId: 'EBAY_GB',
      catalogueSource: catalogueSource || null,
      shopifyProductId: selectedProduct && selectedProduct.id || null,
      shopifyHandle: selectedProduct && selectedProduct.handle || null,
      title: String(fields.title || '').trim().slice(0, 80),
      price: String(fields.price || '').trim(),
      sku: String(fields.sku || '').trim(),
      description: String(fields.description || '').trim(),
      variations,
      promotion,
      imageUrls: ordered.filter(p => p.kind !== 'file' && p.url).map(p => p.url),
      localPhotoCount: localIndex,
      photoOrder,
      postage,
      freeShipping: postage.freeShipping,
      shippingCost: postage.shippingCost.value,
      shippingService: postage.serviceCode,
      fulfillmentPolicyId: postage.fulfillmentPolicyId,
      shippingDetails: {
        shippingType: 'Flat',
        shippingServiceOptions: [shippingService]
      }
    };
  }

  function validateDraft(draft, photoCount) {
    const errors = [];
    if (!draft.title) errors.push('Add a listing title first.');
    const price = Number(draft.price);
    if (!Number.isFinite(price) || price <= 0) errors.push('Add a valid price greater than £0.');
    if (!photoCount) errors.push('Add at least one product photo.');
    if (photoCount > MAX_PHOTOS) errors.push(`eBay allows a maximum of ${MAX_PHOTOS} photos.`);
    if (!draft.postage || !draft.postage.serviceCode) errors.push('Choose a UK postage service.');
    if (draft.postage && draft.postage.mode === 'paid') {
      const shippingCost = Number(draft.postage.shippingCost && draft.postage.shippingCost.value);
      if (!Number.isFinite(shippingCost) || shippingCost <= 0) {
        errors.push('Add a valid paid-postage amount greater than £0.');
      }
    }
    if (!draft.variations || !draft.variations.length) errors.push('Enable at least one pack-size variation.');
    (draft.variations || []).forEach(variation => {
      const variationPrice = Number(variation.price);
      if (!Number.isFinite(variationPrice) || variationPrice <= 0) errors.push(`${variation.value} needs a valid price greater than £0.`);
    });
    if (draft.promotion && draft.promotion.enabled) {
      const rate = Number(draft.promotion.adRatePercent);
      if (!Number.isFinite(rate) || rate < 2 || rate > 100) errors.push('Promoted Listings ad rate must be between 2% and 100%.');
    }
    return errors;
  }

  return {
    MAX_PHOTOS,
    MAX_PHOTO_BYTES,
    MAX_LABEL_BYTES,
    PHOTO_EXTENSIONS,
    stripHtml,
    normalizePublicProduct,
    normalizeSnapshotProduct,
    movePhoto,
    makeMain,
    appendPhotos,
    validatePhotoFile,
    validateLabelFile,
    labelFileKind,
    normalizePostage,
    normalizeVariations,
    normalizePromotion,
    extractEbayAccount,
    buildDraft,
    validateDraft
  };
});
