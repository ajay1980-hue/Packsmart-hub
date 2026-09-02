(() => {
  'use strict';

  const SHOP_URL = 'https://packsmartsolutions.com';
  const SNAPSHOT_URL = './shopify-products.json';
  const EXPECTED_EBAY_ACCOUNT = 'packsmartsolutions20';
  const core = window.PacksmartEbayCore;
  const backendLib = window.PacksmartEbayBackend;
  if (!core || !backendLib) throw new Error('Packsmart eBay Manager modules failed to load.');

  const MAX_PHOTOS = core.MAX_PHOTOS;
  const state = {
    products: [],
    photos: [],
    label: null,
    selectedProduct: null,
    catalogueSource: null,
    ebayAccountVerified: null
  };
  const backend = backendLib.createBackend(window.PACKSMART_EBAY_CONFIG || {});

  const $ = id => document.getElementById(id);
  const productSelect = $('productSelect');
  const photoInput = $('photoInput');
  const photoGrid = $('photoGrid');
  const photoCount = $('photoCount');
  const dropzone = $('dropzone');
  const title = $('title');
  const price = $('price');
  const sku = $('sku');
  const description = $('description');
  const shippingService = $('shippingService');
  const shippingCost = $('shippingCost');
  const fulfillmentPolicyId = $('fulfillmentPolicyId');
  const postageCostField = $('postageCostField');
  const postageHint = $('postageHint');
  const promotionType = $('promotionType');
  const adRatePercent = $('adRatePercent');
  const adRateField = $('adRateField');
  const labelInput = $('labelInput');
  const labelDropzone = $('labelDropzone');
  const labelPreview = $('labelPreview');
  const labelFrame = $('labelFrame');
  const labelImage = $('labelImage');
  const openLabel = $('openLabel');
  const ebayStatus = $('ebayStatus');
  const resultCard = $('resultCard');
  const resultText = $('resultText');

  const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'
  }[c]));
  const money = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(2) : '';
  };
  const normalizeAccount = value => String(value || '').trim().toLowerCase();
  const formatBytes = bytes => {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  };

  function showResult(message, tone) {
    resultText.textContent = message;
    resultCard.dataset.tone = tone || 'info';
    resultCard.hidden = false;
  }

  function summarizeResponse(data, fallback) {
    if (!data || typeof data !== 'object') return fallback;
    const id = data.itemId || data.listingId || data.offerId || data.draftId || data.id;
    const url = data.url || data.listingUrl || data.ebayUrl;
    if (id && url) return `${fallback} • ${id} • ${url}`;
    if (id) return `${fallback} • ${id}`;
    if (data.message) return `${fallback} • ${data.message}`;
    return fallback;
  }

  function backendErrorMessage(error) {
    if (!error) return 'Unknown hosted-backend error.';
    if (error.status === 413) return 'The hosted upload limit was exceeded. Keep each photo under 12 MB or increase the server upload limit.';
    if (error.status === 415) return 'The hosted backend rejected the image format. Use JPG or PNG, or update its media-upload handler.';
    if (error.status === 422 || error.status === 400) return `eBay rejected part of the listing: ${error.message}`;
    if (/No compatible|route .* returned|Failed to fetch|NetworkError|fetch failed/i.test(error.message || '')) {
      return 'No compatible hosted eBay upload route could be reached. The browser UI is ready, but its server-side eBay endpoint still needs to be deployed or configured.';
    }
    return error.message || 'The hosted eBay backend did not accept the request.';
  }

  function populateProductSelect() {
    productSelect.innerHTML = '<option value="">Choose a product…</option>' +
      state.products.map((p, i) => `<option value="${i}">${esc(p.title)}</option>`).join('');
  }

  async function tryPublicCatalogue() {
    const res = await fetch(`${SHOP_URL}/products.json?limit=250`, { credentials: 'omit' });
    if (!res.ok) throw new Error(`Shopify public feed returned ${res.status}`);
    const data = await res.json();
    const products = Array.isArray(data.products)
      ? data.products.map(p => core.normalizePublicProduct(p, document))
      : [];
    if (!products.length) throw new Error('Shopify public feed returned no products');
    return { products, source: 'live' };
  }

  async function loadSyncedCatalogue() {
    const res = await fetch(SNAPSHOT_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Synced catalogue returned ${res.status}`);
    const data = await res.json();
    const products = Array.isArray(data.products) ? data.products.map(core.normalizeSnapshotProduct) : [];
    if (!products.length) throw new Error('Synced catalogue contains no products');
    return { products, source: 'synced', syncedAt: data.syncedAt || null };
  }

  async function loadProducts() {
    $('storeStatus').textContent = 'Store: connecting…';
    $('refreshProducts').disabled = true;
    try {
      let catalogue;
      try {
        catalogue = await tryPublicCatalogue();
      } catch (publicError) {
        console.info('Public Shopify feed unavailable; using synced Packsmart catalogue.', publicError);
        catalogue = await loadSyncedCatalogue();
      }
      state.products = catalogue.products;
      state.catalogueSource = catalogue.source;
      populateProductSelect();
      $('storeStatus').textContent = `Store: ${catalogue.source === 'live' ? 'live' : 'synced'} • ${state.products.length} products`;
    } catch (e) {
      console.error(e);
      state.products = [];
      state.catalogueSource = null;
      populateProductSelect();
      $('storeStatus').textContent = 'Store: catalogue unavailable';
    } finally {
      $('refreshProducts').disabled = false;
    }
  }

  async function checkBackend() {
    ebayStatus.textContent = 'eBay: checking…';
    ebayStatus.dataset.state = 'checking';
    $('checkEbay').disabled = true;
    try {
      const result = await backend.status();
      const data = result.data || {};
      const account = core.extractEbayAccount(data);
      const explicitConnected = data.connected === true || data.authorized === true ||
        data.authenticated === true || data.ebayConnected === true;
      const explicitDisconnected = data.connected === false || data.authorized === false ||
        data.authenticated === false || data.ebayConnected === false;

      if (account && normalizeAccount(account) !== EXPECTED_EBAY_ACCOUNT) {
        state.ebayAccountVerified = false;
        ebayStatus.textContent = `eBay: wrong account • ${account}`;
        ebayStatus.dataset.state = 'error';
        showResult(`Live publishing is blocked because the hosted manager reported ${account}, not ${EXPECTED_EBAY_ACCOUNT}.`, 'error');
      } else if (explicitConnected && account) {
        state.ebayAccountVerified = true;
        ebayStatus.textContent = `eBay: connected • ${account}`;
        ebayStatus.dataset.state = 'ok';
      } else if (explicitConnected) {
        state.ebayAccountVerified = null;
        ebayStatus.textContent = 'eBay: connected • account not reported';
        ebayStatus.dataset.state = 'neutral';
      } else if (explicitDisconnected) {
        state.ebayAccountVerified = null;
        ebayStatus.textContent = 'eBay: sign-in required';
        ebayStatus.dataset.state = 'warn';
      } else {
        state.ebayAccountVerified = null;
        ebayStatus.textContent = 'eBay: backend reachable • OAuth unconfirmed';
        ebayStatus.dataset.state = 'neutral';
      }
    } catch (e) {
      console.info('eBay status route not verified yet.', e);
      state.ebayAccountVerified = null;
      ebayStatus.textContent = e && (e.status === 401 || e.status === 403) ? 'eBay: sign-in required' : 'eBay: backend not verified';
      ebayStatus.dataset.state = e && (e.status === 401 || e.status === 403) ? 'warn' : 'neutral';
    } finally {
      $('checkEbay').disabled = false;
    }
  }

  function importProduct(index) {
    if (index === '') return;
    const p = state.products[Number(index)];
    if (!p) return;

    state.selectedProduct = p;
    const v = (p.variants || [])[0] || {};
    title.value = (p.title || '').slice(0, 80);
    price.value = money(v.price);
    sku.value = v.sku || '';
    description.value = p.description || '';
    [50, 100, 200].forEach((quantity, rowIndex) => {
      const match = (p.variants || []).find(variant => new RegExp(`(^|\\D)${quantity}(\\D|$)`).test(variant.title || '')) || (p.variants || [])[rowIndex] || {};
      $(`variation${quantity}Price`).value = money(match.price || (rowIndex === 0 ? v.price : ''));
      $(`variation${quantity}Sku`).value = match.sku || (v.sku ? `${v.sku}-${quantity}` : '');
    });
    updateTitleCount();

    const incoming = (p.images || []).map((url, i) => ({
      id: `shopify-${String(p.id).replace(/[^a-z0-9]/gi, '-')}-${i}-${Date.now()}`,
      kind: 'remote',
      url,
      name: `Shopify image ${i + 1}`,
      file: null
    }));
    state.photos = core.appendPhotos(state.photos, incoming, MAX_PHOTOS);
    renderPhotos();
  }

  function addFiles(fileList) {
    const selected = Array.from(fileList || []);
    const rejected = [];
    const files = selected.filter(file => {
      const error = core.validatePhotoFile(file);
      if (error) rejected.push(error);
      return !error;
    });
    const remaining = MAX_PHOTOS - state.photos.length;
    const incoming = files.slice(0, Math.max(0, remaining)).map(file => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`,
      kind: 'file',
      url: URL.createObjectURL(file),
      name: file.name,
      file
    }));
    state.photos = core.appendPhotos(state.photos, incoming, MAX_PHOTOS);
    const messages = rejected.slice(0, 2);
    if (files.length > remaining) messages.push(`eBay allows ${MAX_PHOTOS} photos. Extra images were not added.`);
    $('photoHint').textContent = messages.length
      ? messages.join(' ')
      : `${incoming.length} photo${incoming.length === 1 ? '' : 's'} added. The first photo is the main image.`;
    photoInput.value = '';
    renderPhotos();
  }

  function cleanup(item) {
    if (item?.kind === 'file' && item.url) URL.revokeObjectURL(item.url);
  }

  function removePhoto(i) {
    const item = state.photos[i];
    state.photos.splice(i, 1);
    cleanup(item);
    renderPhotos();
  }

  function movePhoto(i, direction) {
    state.photos = core.movePhoto(state.photos, i, direction);
    renderPhotos();
  }

  function makeMain(i) {
    state.photos = core.makeMain(state.photos, i);
    renderPhotos();
  }

  function renderPhotos() {
    photoCount.textContent = `${state.photos.length} / ${MAX_PHOTOS}`;
    photoGrid.innerHTML = '';
    state.photos.forEach((photo, i) => {
      const card = document.createElement('article');
      card.className = 'photo-card' + (i === 0 ? ' main' : '');
      card.innerHTML = `
        ${i === 0 ? '<span class="badge">MAIN</span>' : ''}
        <img src="${esc(photo.url)}" alt="${esc(photo.name)}">
        <span class="preview-fallback">Preview unavailable; the file can still be uploaded.</span>
        <div class="photo-meta">
          <div class="photo-name" title="${esc(photo.name)}">${esc(photo.name)}</div>
          <div class="photo-controls">
            <button type="button" data-a="left" aria-label="Move photo left">←</button>
            <button type="button" data-a="main" aria-label="Make main photo">★</button>
            <button type="button" data-a="right" aria-label="Move photo right">→</button>
            <button type="button" data-a="remove" aria-label="Remove photo">×</button>
          </div>
        </div>`;
      card.querySelector('img').onerror = () => card.classList.add('preview-unavailable');
      card.querySelector('[data-a="left"]').onclick = () => movePhoto(i, -1);
      card.querySelector('[data-a="main"]').onclick = () => makeMain(i);
      card.querySelector('[data-a="right"]').onclick = () => movePhoto(i, 1);
      card.querySelector('[data-a="remove"]').onclick = () => removePhoto(i);
      photoGrid.appendChild(card);
    });
  }

  function updateTitleCount() {
    $('titleCount').textContent = title.value.length;
  }

  function selectedPostageMode() {
    return document.querySelector('input[name="postageMode"]:checked')?.value || 'free';
  }

  function updatePostageFields() {
    const paid = selectedPostageMode() === 'paid';
    postageCostField.hidden = !paid;
    shippingCost.required = paid;
    postageHint.textContent = paid
      ? 'The buyer will be charged this flat amount on the first domestic service.'
      : 'Free postage will be sent as £0.00 on the first domestic service.';
  }

  function shippingServiceName() {
    return shippingService.options[shippingService.selectedIndex]?.textContent.trim() || '';
  }

  function variationRows() {
    return [50, 100, 200].map(quantity => ({
      quantity,
      enabled: $(`variation${quantity}Enabled`).checked,
      price: $(`variation${quantity}Price`).value,
      sku: $(`variation${quantity}Sku`).value
    }));
  }

  function updateVariationFields(quantity) {
    const enabled = $(`variation${quantity}Enabled`).checked;
    $(`variation${quantity}Price`).disabled = !enabled;
    $(`variation${quantity}Sku`).disabled = !enabled;
  }

  function updatePromotionFields() {
    const enabled = promotionType.value === 'promoted-listings-standard';
    adRateField.hidden = !enabled;
    adRatePercent.required = enabled;
    $('promotionHint').textContent = enabled
      ? 'The hosted backend must add the published listing to an eBay advertising campaign at this rate.'
      : 'No eBay advertising fee will be requested.';
  }

  function clearLabel() {
    if (state.label?.url) URL.revokeObjectURL(state.label.url);
    state.label = null;
    labelInput.value = '';
    labelFrame.removeAttribute('src');
    labelImage.removeAttribute('src');
    openLabel.removeAttribute('href');
    labelFrame.hidden = true;
    labelImage.hidden = true;
    labelPreview.hidden = true;
    $('labelHint').textContent = 'Postage labels are order documents, so they are kept separate from listing photos.';
  }

  function addLabelFile(file) {
    const error = core.validateLabelFile(file);
    labelInput.value = '';
    if (error) {
      $('labelHint').textContent = error;
      return;
    }

    clearLabel();
    const kind = core.labelFileKind(file);
    const url = URL.createObjectURL(file);
    state.label = { file, kind, url };
    $('labelName').textContent = file.name || 'Postage label';
    $('labelMeta').textContent = `${kind.toUpperCase()} • ${formatBytes(file.size)} • kept locally`;
    openLabel.href = url;
    labelFrame.hidden = kind !== 'pdf';
    labelImage.hidden = kind !== 'image';
    if (kind === 'pdf') labelFrame.src = url;
    else labelImage.src = url;
    labelPreview.hidden = false;
    $('labelHint').textContent = 'Label ready. Use Open / print label to print from your browser or PDF viewer.';
  }

  function currentDraft() {
    return core.buildDraft({
      title: title.value,
      price: price.value,
      sku: sku.value,
      description: description.value,
      ebayAccount: EXPECTED_EBAY_ACCOUNT,
      postageMode: selectedPostageMode(),
      shippingServiceCode: shippingService.value,
      shippingServiceName: shippingServiceName(),
      shippingCost: shippingCost.value,
      fulfillmentPolicyId: fulfillmentPolicyId.value
      ,variations: variationRows()
      ,promotionType: promotionType.value
      ,adRatePercent: adRatePercent.value
    }, state.photos, state.selectedProduct, state.catalogueSource);
  }

  function validateCurrentDraft() {
    const draft = currentDraft();
    const errors = core.validateDraft(draft, state.photos.length);
    if (errors.length) {
      alert(errors[0]);
      return null;
    }
    return draft;
  }

  function canWriteToExpectedAccount() {
    if (state.ebayAccountVerified === true) return true;
    const detail = state.ebayAccountVerified === false
      ? 'The hosted manager reported a different eBay account.'
      : 'The hosted status route has not confirmed its eBay username.';
    showResult(`${detail} The eBay write is blocked until it explicitly confirms ${EXPECTED_EBAY_ACCOUNT}.`, 'error');
    return false;
  }

  async function withBusy(button, busyText, task) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = busyText;
    try { return await task(); }
    finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  async function saveDraft() {
    const draft = validateCurrentDraft();
    if (!draft) return;
    localStorage.setItem('packsmart-ebay-draft', JSON.stringify(draft));

    if (!canWriteToExpectedAccount()) {
      resultText.textContent += ' A local recovery draft has still been saved in this browser.';
      return;
    }

    await withBusy($('saveDraft'), 'Saving…', async () => {
      try {
        const result = await backend.saveDraft(draft, state.photos);
        showResult(summarizeResponse(result.data, `Draft saved to hosted eBay Manager • ${state.photos.length} photos`), 'ok');
        ebayStatus.textContent = `eBay: backend connected • target ${EXPECTED_EBAY_ACCOUNT}`;
        ebayStatus.dataset.state = 'ok';
      } catch (e) {
        console.error(e);
        if (e.status === 401 || e.status === 403) {
          ebayStatus.textContent = 'eBay: sign-in required';
          ebayStatus.dataset.state = 'warn';
          showResult('Draft saved locally. Sign in to the hosted eBay Manager to save it server-side.', 'warn');
        } else {
          showResult(`Draft saved locally. ${backendErrorMessage(e)}`, 'warn');
        }
      }
    });
  }

  async function createLiveListing() {
    const draft = validateCurrentDraft();
    if (!draft) return;
    if (!canWriteToExpectedAccount()) return;
    const postageSummary = draft.postage.freeShipping
      ? 'Free postage'
      : `Buyer postage: £${draft.postage.shippingCost.value}`;
    if (!confirm(`Create this listing live on ${EXPECTED_EBAY_ACCOUNT}?\n\n${draft.title}\n£${draft.price}\n${postageSummary}\n${state.photos.length} photo${state.photos.length === 1 ? '' : 's'}`)) return;

    await withBusy($('createListing'), 'Creating listing…', async () => {
      try {
        const result = await backend.createListing(draft, state.photos);
        localStorage.setItem('packsmart-ebay-last-listing', JSON.stringify(result.data || {}));
        showResult(summarizeResponse(result.data, 'Live eBay listing created'), 'ok');
        ebayStatus.textContent = `eBay: connected • ${EXPECTED_EBAY_ACCOUNT}`;
        ebayStatus.dataset.state = 'ok';
      } catch (e) {
        console.error(e);
        if (e.status === 401 || e.status === 403) {
          ebayStatus.textContent = 'eBay: sign-in required';
          ebayStatus.dataset.state = 'warn';
          showResult('eBay sign-in is required before a live listing can be created.', 'warn');
        } else {
          showResult(`Live listing was not created. ${backendErrorMessage(e)}`, 'error');
        }
      }
    });
  }

  function clearDraft() {
    state.photos.forEach(cleanup);
    state.photos = [];
    state.selectedProduct = null;
    productSelect.value = '';
    title.value = '';
    price.value = '';
    sku.value = '';
    description.value = '';
    document.querySelector('input[name="postageMode"][value="free"]').checked = true;
    shippingCost.value = '';
    fulfillmentPolicyId.value = '';
    [50, 100, 200].forEach(quantity => {
      $(`variation${quantity}Enabled`).checked = true;
      $(`variation${quantity}Price`).value = '';
      $(`variation${quantity}Sku`).value = '';
      updateVariationFields(quantity);
    });
    promotionType.value = 'none';
    adRatePercent.value = '';
    updatePromotionFields();
    localStorage.removeItem('packsmart-ebay-draft');
    resultCard.hidden = true;
    $('photoHint').textContent = 'The first photo is used as the main image unless you choose another.';
    updatePostageFields();
    updateTitleCount();
    renderPhotos();
  }

  photoInput.addEventListener('change', e => addFiles(e.target.files));
  labelInput.addEventListener('change', e => addLabelFile(e.target.files && e.target.files[0]));
  productSelect.addEventListener('change', e => importProduct(e.target.value));
  $('refreshProducts').addEventListener('click', loadProducts);
  $('checkEbay').addEventListener('click', checkBackend);
  $('saveDraft').addEventListener('click', saveDraft);
  $('createListing').addEventListener('click', createLiveListing);
  $('clearDraft').addEventListener('click', clearDraft);
  title.addEventListener('input', updateTitleCount);
  document.querySelectorAll('input[name="postageMode"]').forEach(input =>
    input.addEventListener('change', updatePostageFields)
  );
  [50, 100, 200].forEach(quantity => $('variation' + quantity + 'Enabled').addEventListener('change', () => updateVariationFields(quantity)));
  promotionType.addEventListener('change', updatePromotionFields);
  $('clearLabel').addEventListener('click', clearLabel);

  ['dragenter', 'dragover'].forEach(evt =>
    dropzone.addEventListener(evt, e => {
      e.preventDefault();
      dropzone.classList.add('drag');
    })
  );
  ['dragleave', 'drop'].forEach(evt =>
    dropzone.addEventListener(evt, e => {
      e.preventDefault();
      dropzone.classList.remove('drag');
    })
  );
  dropzone.addEventListener('drop', e => addFiles(e.dataTransfer.files));

  ['dragenter', 'dragover'].forEach(evt =>
    labelDropzone.addEventListener(evt, e => {
      e.preventDefault();
      labelDropzone.classList.add('drag');
    })
  );
  ['dragleave', 'drop'].forEach(evt =>
    labelDropzone.addEventListener(evt, e => {
      e.preventDefault();
      labelDropzone.classList.remove('drag');
    })
  );
  labelDropzone.addEventListener('drop', e => addLabelFile(e.dataTransfer.files && e.dataTransfer.files[0]));
  window.addEventListener('beforeunload', () => {
    state.photos.forEach(cleanup);
    if (state.label?.url) URL.revokeObjectURL(state.label.url);
  });

  renderPhotos();
  updateTitleCount();
  updatePostageFields();
  [50, 100, 200].forEach(updateVariationFields);
  updatePromotionFields();
  loadProducts();
  checkBackend();
})();
