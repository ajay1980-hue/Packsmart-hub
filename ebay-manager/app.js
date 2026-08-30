(() => {
  'use strict';
  const SHOP_URL = 'https://packsmartsolutions.com';
  const MAX_PHOTOS = 24;
  const state = { products: [], photos: [], selectedProduct: null };
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

  const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const stripHtml = html => { const d=document.createElement('div'); d.innerHTML=html||''; return (d.textContent||d.innerText||'').trim(); };
  const money = v => { const n=Number(v); return Number.isFinite(n)?n.toFixed(2):''; };

  async function loadProducts() {
    $('storeStatus').textContent = 'Store: connecting…';
    $('refreshProducts').disabled = true;
    try {
      const res = await fetch(`${SHOP_URL}/products.json?limit=250`, { credentials:'omit' });
      if (!res.ok) throw new Error(`Shopify returned ${res.status}`);
      const data = await res.json();
      state.products = Array.isArray(data.products) ? data.products : [];
      productSelect.innerHTML = '<option value="">Choose a product…</option>' +
        state.products.map((p,i)=>`<option value="${i}">${esc(p.title||'Untitled product')}</option>`).join('');
      $('storeStatus').textContent = `Store: connected • ${state.products.length} products`;
    } catch (e) {
      console.error(e);
      $('storeStatus').textContent = 'Store: connection needs deployment check';
    } finally {
      $('refreshProducts').disabled = false;
    }
  }

  function importProduct(index) {
    if (index === '') return;
    const p = state.products[Number(index)];
    if (!p) return;
    state.selectedProduct = p;
    const v = (p.variants||[])[0] || {};
    title.value = (p.title||'').slice(0,80);
    price.value = money(v.price);
    sku.value = v.sku || '';
    description.value = stripHtml(p.body_html || '');
    updateTitleCount();

    const remaining = MAX_PHOTOS - state.photos.length;
    (p.images||[]).slice(0, remaining).forEach((img,i) => {
      state.photos.push({
        id:`shopify-${p.id}-${i}-${Date.now()}`,
        kind:'remote',
        url:img.src,
        name:`Shopify image ${i+1}`,
        file:null
      });
    });
    renderPhotos();
  }

  function addFiles(fileList) {
    const files = Array.from(fileList||[]).filter(f => f.type.startsWith('image/'));
    const remaining = MAX_PHOTOS - state.photos.length;
    files.slice(0, remaining).forEach(file => {
      state.photos.push({
        id:`${file.name}-${file.size}-${file.lastModified}-${Math.random()}`,
        kind:'file',
        url:URL.createObjectURL(file),
        name:file.name,
        file
      });
    });
    if (files.length > remaining) $('photoHint').textContent = `eBay allows ${MAX_PHOTOS} photos. Extra images were not added.`;
    photoInput.value = '';
    renderPhotos();
  }

  function cleanup(item) { if (item?.kind==='file' && item.url) URL.revokeObjectURL(item.url); }
  function removePhoto(i) { const [x]=state.photos.splice(i,1); cleanup(x); renderPhotos(); }
  function movePhoto(i,d) {
    const to=i+d; if (to<0 || to>=state.photos.length) return;
    const [x]=state.photos.splice(i,1); state.photos.splice(to,0,x); renderPhotos();
  }
  function makeMain(i) { if (i<=0 || i>=state.photos.length) return; const [x]=state.photos.splice(i,1); state.photos.unshift(x); renderPhotos(); }

  function renderPhotos() {
    photoCount.textContent = `${state.photos.length} / ${MAX_PHOTOS}`;
    photoGrid.innerHTML = '';
    state.photos.forEach((p,i) => {
      const card=document.createElement('article');
      card.className='photo-card'+(i===0?' main':'');
      card.innerHTML=`
        ${i===0?'<span class="badge">MAIN</span>':''}
        <img src="${esc(p.url)}" alt="${esc(p.name)}">
        <div class="photo-meta">
          <div class="photo-name" title="${esc(p.name)}">${esc(p.name)}</div>
          <div class="photo-controls">
            <button type="button" data-a="left">←</button>
            <button type="button" data-a="main">★</button>
            <button type="button" data-a="right">→</button>
            <button type="button" data-a="remove">×</button>
          </div>
        </div>`;
      card.querySelector('[data-a="left"]').onclick=()=>movePhoto(i,-1);
      card.querySelector('[data-a="main"]').onclick=()=>makeMain(i);
      card.querySelector('[data-a="right"]').onclick=()=>movePhoto(i,1);
      card.querySelector('[data-a="remove"]').onclick=()=>removePhoto(i);
      photoGrid.appendChild(card);
    });
  }

  function updateTitleCount(){ $('titleCount').textContent=title.value.length; }

  function buildDraft() {
    return {
      source:'packsmart-ebay-manager',
      shopifyProductId:state.selectedProduct?.id||null,
      shopifyHandle:state.selectedProduct?.handle||null,
      title:title.value.trim(),
      price:price.value.trim(),
      sku:sku.value.trim(),
      description:description.value.trim(),
      imageUrls:state.photos.filter(p=>p.kind==='remote').map(p=>p.url),
      localPhotoCount:state.photos.filter(p=>p.kind==='file').length,
      photoOrder:state.photos.map(p=>({kind:p.kind,name:p.name,url:p.kind==='remote'?p.url:null}))
    };
  }

  function saveDraft() {
    const d=buildDraft();
    if (!d.title) return alert('Add a listing title first.');
    if (!state.photos.length) return alert('Add at least one product photo.');
    localStorage.setItem('packsmart-ebay-draft', JSON.stringify(d));
    $('resultText').textContent=`Saved: ${d.title} • ${state.photos.length} photo${state.photos.length===1?'':'s'} • main image is photo 1.`;
    $('resultCard').hidden=false;
  }

  function clearDraft() {
    state.photos.forEach(cleanup);
    state.photos=[]; state.selectedProduct=null; productSelect.value='';
    title.value=''; price.value=''; sku.value=''; description.value='';
    localStorage.removeItem('packsmart-ebay-draft');
    $('resultCard').hidden=true;
    $('photoHint').textContent='The first photo is used as the main image unless you choose another.';
    updateTitleCount(); renderPhotos();
  }

  photoInput.addEventListener('change', e=>addFiles(e.target.files));
  productSelect.addEventListener('change', e=>importProduct(e.target.value));
  $('refreshProducts').addEventListener('click', loadProducts);
  $('saveDraft').addEventListener('click', saveDraft);
  $('clearDraft').addEventListener('click', clearDraft);
  title.addEventListener('input', updateTitleCount);

  ['dragenter','dragover'].forEach(evt=>dropzone.addEventListener(evt,e=>{e.preventDefault();dropzone.classList.add('drag');}));
  ['dragleave','drop'].forEach(evt=>dropzone.addEventListener(evt,e=>{e.preventDefault();dropzone.classList.remove('drag');}));
  dropzone.addEventListener('drop',e=>addFiles(e.dataTransfer.files));

  loadProducts();
})();