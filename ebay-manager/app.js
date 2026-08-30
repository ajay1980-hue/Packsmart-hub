(() => {
  'use strict';

  const SHOP_URL = 'https://packsmartsolutions.com';
  const SNAPSHOT_URL = './shopify-products.json';
  const core = window.PacksmartEbayCore;
  const backendLib = window.PacksmartEbayBackend;
  if (!core || !backendLib) throw new Error('Packsmart eBay Manager modules failed to load.');

  const MAX_PHOTOS = core.MAX_PHOTOS;
  const state = { products: [], photos: [], selectedProduct: null, catalogueSource: null };
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
      const connected = data.connected !== false && data.authorized !== false && data.authenticated !== false;
      ebayStatus.textContent = connected ? 'eBay: connected' : 'eBay: sign-in required';
      ebayStatus.dataset.state = connected ? 'ok' : 'warn';
    } catch (e) {
      console.info('eBay status route not verified yet.', e);
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
    const files = Array.from(fileList || []).filter(f => f.type.startsWith('image/'));
    const remaining = MAX_PHOTOS - state.photos.length;
    const incoming = files.slice(0, Math.max(0, remaining)).map(file => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`,
      kind: 'file',
      url: URL.createObjectURL(file),
      name: file.name,
      file
    }));
    state.photos = core.appendPhotos(state.photos, incoming, MAX_PHOTOS);
    $('photoHint').textContent = files.length > remaining
      ? `eBay allows ${MAX_PHOTOS} photos. Extra images were not added.`
      : 'The first photo is used as the main image unless you choose another.';
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
        <div class="photo-meta">
          <div class="photo-name" title="${esc(photo.name)}">${esc(photo.name)}</div>
          <div class="photo-controls">
            <button type="button" data-a="left" aria-label="Move photo left">←</button>
            <button type="button" data-a="main" aria-label="Make main photo">★</button>
            <button type="button" data-a="right" aria-label="Move photo right">→</button>
            <button type="button" data-a="remove" aria-label="Remove photo">×</button>
          </div>
        </div>`;
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

  function currentDraft() {
    return core.buildDraft({
      title: title.value,
      price: price.value,
      sku: sku.value,
      description: description.value
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

    await withBusy($('saveDraft'), 'Saving…', async () => {
      try {
        const result = await backend.saveDraft(draft, state.photos);
        showResult(summarizeResponse(result.data, `Draft saved to hosted eBay Manager • ${state.photos.length} photos`), 'ok');
        ebayStatus.textContent = 'eBay: backend connected';
        ebayStatus.dataset.state = 'ok';
      } catch (e) {
        console.error(e);
        if (e.status === 401 || e.status === 403) {
          ebayStatus.textContent = 'eBay: sign-in required';
          ebayStatus.dataset.state = 'warn';
          showResult('Draft saved locally. Sign in to the hosted eBay Manager to save it server-side.', 'warn');
        } else {
          showResult(`Draft saved locally. Hosted backend did not accept it yet: ${e.message}`, 'warn');
        }
      }
    });
  }

  async function createLiveListing() {
    const draft = validateCurrentDraft();
    if (!draft) return;
    if (!confirm(`Create this listing live on eBay now?\n\n${draft.title}\n£${draft.price}\n${state.photos.length} photo${state.photos.length === 1 ? '' : 's'}`)) return;

    await withBusy($('createListing'), 'Creating listing…', async () => {
      try {
        const result = await backend.createListing(draft, state.photos);
        localStorage.setItem('packsmart-ebay-last-listing', JSON.stringify(result.data || {}));
        showResult(summarizeResponse(result.data, 'Live eBay listing created'), 'ok');
        ebayStatus.textContent = 'eBay: connected';
        ebayStatus.dataset.state = 'ok';
      } catch (e) {
        console.error(e);
        if (e.status === 401 || e.status === 403) {
          ebayStatus.textContent = 'eBay: sign-in required';
          ebayStatus.dataset.state = 'warn';
          showResult('eBay sign-in is required before a live listing can be created.', 'warn');
        } else {
          showResult(`Live listing was not created: ${e.message}`, 'error');
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
    localStorage.removeItem('packsmart-ebay-draft');
    resultCard.hidden = true;
    $('photoHint').textContent = 'The first photo is used as the main image unless you choose another.';
    updateTitleCount();
    renderPhotos();
  }

  photoInput.addEventListener('change', e => addFiles(e.target.files));
  productSelect.addEventListener('change', e => importProduct(e.target.value));
  $('refreshProducts').addEventListener('click', loadProducts);
  $('checkEbay').addEventListener('click', checkBackend);
  $('saveDraft').addEventListener('click', saveDraft);
  $('createListing').addEventListener('click', createLiveListing);
  $('clearDraft').addEventListener('click', clearDraft);
  title.addEventListener('input', updateTitleCount);

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

  renderPhotos();
  updateTitleCount();
  loadProducts();
  checkBackend();
})();
