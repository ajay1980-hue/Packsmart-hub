(() => {
  'use strict';

  const SHOP_URL = 'https://packsmartsolutions.com';
  const SNAPSHOT_URL = './shopify-products.json';
  const MAX_PHOTOS = 24;
  const state = { products: [], photos: [], selectedProduct: null, catalogueSource: null };

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

  const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'
  }[c]));
  const stripHtml = html => {
    const d = document.createElement('div');
    d.innerHTML = html || '';
    return (d.textContent || d.innerText || '').trim();
  };
  const money = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(2) : '';
  };

  function normalizePublicProduct(p) {
    return {
      id: p.id,
      handle: p.handle || '',
      title: p.title || 'Untitled product',
      description: stripHtml(p.body_html || ''),
      variants: (p.variants || []).map(v => ({
        title: v.title || '',
        price: v.price || '',
        sku: v.sku || ''
      })),
      images: (p.images || []).map(img => img.src).filter(Boolean)
    };
  }

  function normalizeSnapshotProduct(p) {
    return {
      id: p.id,
      handle: p.handle || '',
      title: p.title || 'Untitled product',
      description: p.description || '',
      variants: (p.variants || []).map(v => ({
        title: v.title || '',
        price: v.price || '',
        sku: v.sku || ''
      })),
      images: p.image ? [p.image] : []
    };
  }

  function populateProductSelect() {
    productSelect.innerHTML = '<option value="">Choose a product…</option>' +
      state.products.map((p, i) =>
        `<option value="${i}">${esc(p.title)}</option>`
      ).join('');
  }

  async function tryPublicCatalogue() {
    const res = await fetch(`${SHOP_URL}/products.json?limit=250`, { credentials: 'omit' });
    if (!res.ok) throw new Error(`Shopify public feed returned ${res.status}`);
    const data = await res.json();
    const products = Array.isArray(data.products) ? data.products.map(normalizePublicProduct) : [];
    if (!products.length) throw new Error('Shopify public feed returned no products');
    return { products, source: 'live' };
  }

  async function loadSyncedCatalogue() {
    const res = await fetch(SNAPSHOT_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Synced catalogue returned ${res.status}`);
    const data = await res.json();
    const products = Array.isArray(data.products) ? data.products.map(normalizeSnapshotProduct) : [];
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
        console.info('Public Shopify feed unavailable; using authenticated Packsmart catalogue snapshot.', publicError);
        catalogue = await loadSyncedCatalogue();
      }

      state.products = catalogue.products;
      state.catalogueSource = catalogue.source;
      populateProductSelect();

      if (catalogue.source === 'live') {
        $('storeStatus').textContent = `Store: live • ${state.products.length} products`;
      } else {
        $('storeStatus').textContent = `Store: synced • ${state.products.length} products`;
      }
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

    const remaining = MAX_PHOTOS - state.photos.length;
    (p.images || []).slice(0, remaining).forEach((url, i) => {
      state.photos.push({
        id: `shopify-${String(p.id).replace(/[^a-z0-9]/gi, '-')}-${i}-${Date.now()}`,
        kind: 'remote',
        url,
        name: `Shopify image ${i + 1}`,
        file: null
      });
    });

    renderPhotos();
  }

  function addFiles(fileList) {
    const files = Array.from(fileList || []).filter(f => f.type.startsWith('image/'));
    const remaining = MAX_PHOTOS - state.photos.length;

    files.slice(0, remaining).forEach(file => {
      state.photos.push({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`,
        kind: 'file',
        url: URL.createObjectURL(file),
        name: file.name,
        file
      });
    });

    if (files.length > remaining) {
      $('photoHint').textContent = `eBay allows ${MAX_PHOTOS} photos. Extra images were not added.`;
    }

    photoInput.value = '';
    renderPhotos();
  }

  function cleanup(item) {
    if (item?.kind === 'file' && item.url) URL.revokeObjectURL(item.url);
  }

  function removePhoto(i) {
    const [item] = state.photos.splice(i, 1);
    cleanup(item);
    renderPhotos();
  }

  function movePhoto(i, direction) {
    const to = i + direction;
    if (to < 0 || to >= state.photos.length) return;
    const [item] = state.photos.splice(i, 1);
    state.photos.splice(to, 0, item);
    renderPhotos();
  }

  function makeMain(i) {
    if (i <= 0 || i >= state.photos.length) return;
    const [item] = state.photos.splice(i, 1);
    state.photos.unshift(item);
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

  function buildDraft() {
    return {
      source: 'packsmart-ebay-manager',
      catalogueSource: state.catalogueSource,
      shopifyProductId: state.selectedProduct?.id || null,
      shopifyHandle: state.selectedProduct?.handle || null,
      title: title.value.trim(),
      price: price.value.trim(),
      sku: sku.value.trim(),
      description: description.value.trim(),
      imageUrls: state.photos.filter(p => p.kind === 'remote').map(p => p.url),
      localPhotoCount: state.photos.filter(p => p.kind === 'file').length,
      photoOrder: state.photos.map((p, index) => ({
        position: index + 1,
        main: index === 0,
        kind: p.kind,
        name: p.name,
        url: p.kind === 'remote' ? p.url : null
      }))
    };
  }

  function saveDraft() {
    const draft = buildDraft();
    if (!draft.title) return alert('Add a listing title first.');
    if (!state.photos.length) return alert('Add at least one product photo.');

    localStorage.setItem('packsmart-ebay-draft', JSON.stringify(draft));
    $('resultText').textContent =
      `Saved: ${draft.title} • ${state.photos.length} photo${state.photos.length === 1 ? '' : 's'} • main image is photo 1.`;
    $('resultCard').hidden = false;
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
    $('resultCard').hidden = true;
    $('photoHint').textContent = 'The first photo is used as the main image unless you choose another.';
    updateTitleCount();
    renderPhotos();
  }

  photoInput.addEventListener('change', e => addFiles(e.target.files));
  productSelect.addEventListener('change', e => importProduct(e.target.value));
  $('refreshProducts').addEventListener('click', loadProducts);
  $('saveDraft').addEventListener('click', saveDraft);
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

  loadProducts();
})();