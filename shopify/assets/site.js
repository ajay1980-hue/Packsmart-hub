// Packsmart theme interactions
const recommendations={
  'Clothing|Small (A5)|1 item':{title:'Grey mailing bag 230 × 300mm',band:'Likely Large Letter if packed depth remains under 25mm.',note:'Ideal for children\'s clothing, lightweight tops and small garments.'},
  'Clothing|Medium (A4)|1 item':{title:'Grey mailing bag 250 × 350mm',band:'Potential Large Letter if packed depth remains under 25mm.',note:'A strong everyday choice for one folded T-shirt or shirt.'},
  'Clothing|Large|1 item':{title:'Grey mailing bag 305 × 405mm',band:'Usually Small Parcel.',note:'Recommended for hoodies, jumpers and dresses.'},
  'Books & media|Small (A5)|1 item':{title:'EP4 bubble envelope',band:'Often Large Letter depending on thickness and weight.',note:'Protects book corners and small boxed media.'},
  'Small items|Small (A5)|1 item':{title:'EP1 bubble envelope',band:'Often Large Letter.',note:'Use suitable internal protection for jewellery and valuable parts.'},
  'Fragile items|Medium (A4)|1 item':{title:'Foam wrap plus corrugated box',band:'Small Parcel or courier service.',note:'Fragile goods should not be posted in a mailing bag alone.'}
};
function renderFinderResult(rec){const el=document.querySelector('#finderResult');if(!el)return;el.replaceChildren();const h=document.createElement('h3');h.textContent=rec.title;const band=document.createElement('p');const strong=document.createElement('strong');strong.textContent='Postal guidance: ';band.append(strong,document.createTextNode(rec.band));const note=document.createElement('p');note.textContent=rec.note;el.append(h,band,note)}
function findSize(){const send=document.querySelector('#sendType')?.value||'Clothing';const size=document.querySelector('#itemSize')?.value||'Medium (A4)';const qty=document.querySelector('#quantity')?.value||'1 item';renderFinderResult(recommendations[`${send}|${size}|${qty}`]||{title:'Speak to Packsmart for a tailored recommendation',band:'Postal band depends on packed dimensions and weight.',note:'For multi-item or bulky orders, we will help calculate the best packaging and carrier.'})}
function updateProductImage(button){const image=document.getElementById('ProductMainImage');if(!image)return;image.src=button.dataset.productImage;image.alt=button.dataset.productAlt||image.alt;document.querySelectorAll('.product-thumb').forEach(item=>item.classList.remove('is-active'));button.classList.add('is-active')}
function updateVariant(select){const option=select.options[select.selectedIndex];const price=document.getElementById('ProductPrice');if(!price)return;const compare=option.dataset.comparePrice||'';const current=option.dataset.price||'';const unit=option.dataset.unitLabel||'';price.replaceChildren();if(compare){const del=document.createElement('del');del.textContent=compare;price.append(del)}price.append(document.createTextNode(current));const unitEl=document.getElementById('ProductUnitPrice');if(unitEl){unitEl.textContent=unit;unitEl.hidden=!unit}}
document.addEventListener('click',event=>{const thumb=event.target.closest('[data-product-image]');if(thumb){updateProductImage(thumb);return}const finder=event.target.closest('[data-finder-submit]');if(finder){findSize();return}const chip=event.target.closest('.chip');if(chip){document.querySelectorAll('.chip').forEach(item=>item.classList.remove('active'));chip.classList.add('active');try{renderFinderResult(JSON.parse(chip.dataset.result||'{}'))}catch(error){console.warn('Unable to read packaging recommendation.',error)}}});
document.addEventListener('change',event=>{if(event.target.id==='ProductVariant')updateVariant(event.target);if(event.target.matches('[data-sort-select]')&&event.target.form)event.target.form.submit()});
document.addEventListener('DOMContentLoaded',()=>{const result=document.querySelector('#finderResult');if(result&&result.textContent.trim()==='Get the right packaging and pay the right postage.')findSize();document.querySelectorAll('.lux-mobile__panel a').forEach(link=>link.addEventListener('click',()=>{const details=link.closest('details');if(details)details.open=false}))});

// Packsmart Conversion Boost v4 — lightweight basket-building enhancements.
function packsmartInjectConversionStyles(){
  if(document.getElementById('PacksmartConversionStyles'))return;
  const style=document.createElement('style');
  style.id='PacksmartConversionStyles';
  style.textContent=`
    .product-value-tip{display:flex;gap:10px;align-items:flex-start;margin:-8px 0 18px;padding:12px 13px;border:1px solid rgba(212,163,60,.38);border-radius:7px;background:#0f1112;color:#bbb6ac;font-size:11px;line-height:1.45}.product-value-tip::before{content:'★';color:var(--gold-light);font-size:13px}.product-value-tip strong{display:block;color:var(--gold-light);font-size:11px}.product-value-tip span{display:block}.product-value-tip.is-best{border-color:rgba(118,189,115,.48);background:#0c120e}.product-value-tip.is-best::before,.product-value-tip.is-best strong{color:#bfe6bc}
    .cart-line__stockup{display:inline-flex;margin:0 0 0 10px;padding:0;border:0;background:none;color:var(--gold-light);font:inherit;font-size:11px;font-weight:850;text-decoration:underline;text-underline-offset:3px;cursor:pointer}.cart-line__stockup:hover{color:#fff0ad}
    .cart-addons{margin:18px 0 0;padding:18px;border:1px solid rgba(212,163,60,.4);border-radius:10px;background:linear-gradient(155deg,#151719,#0b0d0e)}.cart-addons__head{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:14px}.cart-addons__head h2{margin:0;font-size:20px}.cart-addons__head p{max-width:460px;margin:0;color:#aaa7a0;font-size:11px;line-height:1.5;text-align:right}.cart-addons__grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.cart-addon{display:flex;min-width:0;flex-direction:column;padding:11px;border:1px solid #34373a;border-radius:8px;background:#0d0f10}.cart-addon__media{display:block;aspect-ratio:1/1;margin-bottom:10px;border-radius:6px;background:#090b0c;overflow:hidden}.cart-addon__media img{width:100%;height:100%;object-fit:contain;padding:5px}.cart-addon h3{margin:0 0 9px;font-size:12px;line-height:1.35}.cart-addon h3 a{text-decoration:none}.cart-addon select{width:100%;min-height:40px;margin-top:auto;padding:8px;border:1px solid #45484b;border-radius:5px;background:#101214;color:#fff;font-size:10px}.cart-addon__add{width:100%;min-height:42px;margin-top:8px;border:1px solid var(--gold);border-radius:5px;background:linear-gradient(180deg,#edc35c,#b87415);color:#090a0b;font-size:11px;font-weight:900;cursor:pointer}.cart-addon__add:disabled{opacity:.6;cursor:wait}.cart-addon__view{display:inline-flex;align-items:center;justify-content:center;min-height:42px;margin-top:8px;border:1px solid rgba(212,163,60,.5);border-radius:5px;color:var(--gold-light);font-size:11px;font-weight:850;text-decoration:none}
    @media(max-width:720px){.cart-addons__head{display:block}.cart-addons__head p{margin-top:6px;text-align:left}.cart-addons__grid{grid-template-columns:1fr}.cart-addon{display:grid;grid-template-columns:86px minmax(0,1fr);column-gap:10px}.cart-addon__media{grid-row:1/5;margin:0}.cart-addon h3{margin-top:2px}.cart-addon select,.cart-addon__add,.cart-addon__view{grid-column:2}.cart-line__stockup{margin-left:8px}}
    @media(prefers-reduced-motion:reduce){.cart-addon__add,.cart-line__stockup{scroll-behavior:auto}}
  `;
  document.head.append(style);
}

function packsmartReadUnitPrice(option){
  const label=option?.dataset?.unitLabel||'';
  const match=label.match(/£\s*([\d,.]+)/);
  if(!match)return null;
  const value=Number(match[1].replace(/,/g,''));
  return Number.isFinite(value)?value:null;
}

function packsmartEnhanceBestValue(){
  const select=document.getElementById('ProductVariant');
  if(!select||select.dataset.conversionEnhanced==='true')return;
  const candidates=[...select.options].map(option=>({option,value:packsmartReadUnitPrice(option)})).filter(item=>item.value!==null&&!item.option.disabled);
  if(candidates.length<2)return;
  candidates.sort((a,b)=>a.value-b.value);
  const best=candidates[0];
  const bestTitle=(best.option.textContent||'').split(' — ')[0].trim();
  best.option.textContent=`${best.option.textContent} — BEST VALUE`;
  select.dataset.conversionEnhanced='true';
  const tip=document.createElement('div');
  tip.className='product-value-tip';
  tip.setAttribute('aria-live','polite');
  const render=()=>{
    const isBest=select.options[select.selectedIndex]===best.option;
    tip.classList.toggle('is-best',isBest);
    const text=document.createElement('div');
    const strong=document.createElement('strong');
    const span=document.createElement('span');
    strong.textContent=isBest?'Best value selected':'Best value tip';
    span.textContent=isBest?'This option has the lowest price per item in this range.':`Choose ${bestTitle} for the lowest price per item.`;
    text.append(strong,span);
    tip.replaceChildren(text);
  };
  select.closest('.product-form__group')?.append(tip);
  select.addEventListener('change',render);
  render();
}

function packsmartEnhanceCartLines(){
  document.querySelectorAll('.cart-line').forEach((line,index)=>{
    if(line.querySelector('.cart-line__stockup'))return;
    const quantity=line.querySelector('input[name="updates[]"]');
    const remove=line.querySelector('.cart-line__remove');
    if(!quantity||!remove)return;
    const button=document.createElement('button');
    button.type='button';
    button.className='cart-line__stockup';
    button.textContent='+ 1 more pack';
    button.setAttribute('aria-label','Add one more pack of this item');
    button.addEventListener('click',()=>{
      const current=Math.max(0,Number.parseInt(quantity.value,10)||0);
      window.location.assign(`/cart/change?line=${index+1}&quantity=${current+1}`);
    });
    remove.insertAdjacentElement('afterend',button);
  });
}

function packsmartProductHandle(href){
  try{const url=new URL(href,window.location.origin);const match=url.pathname.match(/\/products\/([^/?#]+)/);return match?match[1]:null}catch(error){return null}
}

function packsmartFormatProductJsonPrice(value){
  const amount=Number.parseFloat(String(value));
  if(!Number.isFinite(amount))return '';
  return new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP'}).format(amount);
}

async function packsmartLoadCartAddons(){
  const cartLines=document.querySelector('.cart-lines');
  const actions=document.querySelector('.cart-actions');
  if(!cartLines||!actions||document.querySelector('.cart-addons'))return;
  try{
    const response=await fetch('/collections/best-sellers/products.json?limit=12',{credentials:'same-origin',headers:{Accept:'application/json'}});
    if(!response.ok)return;
    const payload=await response.json();
    const inCart=new Set([...document.querySelectorAll('.cart-line__title a')].map(link=>packsmartProductHandle(link.href)).filter(Boolean));
    const products=(payload.products||[]).filter(product=>{
      const tags=Array.isArray(product.tags)?product.tags.join(' ').toLowerCase():String(product.tags||'').toLowerCase();
      const type=String(product.product_type||product.type||'').toLowerCase();
      const available=(product.variants||[]).some(variant=>variant.available!==false);
      return available&&!inCart.has(product.handle)&&!tags.includes('quote-required')&&!tags.includes('delivery:two-metre-freight')&&!type.includes('foam');
    }).slice(0,3);
    if(!products.length)return;

    const section=document.createElement('section');
    section.className='cart-addons';
    section.setAttribute('aria-labelledby','CartAddonsTitle');
    const head=document.createElement('div');
    head.className='cart-addons__head';
    const title=document.createElement('h2');
    title.id='CartAddonsTitle';
    title.textContent='Complete your order';
    const intro=document.createElement('p');
    const progress=document.querySelector('.cart-progress__text');
    const remaining=progress?.querySelector('strong')?.textContent?.trim();
    if(progress&&progress.textContent.toLowerCase().includes('unlocked'))intro.textContent='Eligible free UK standard delivery is showing as unlocked. Add anything else you need before checkout.';
    else if(remaining)intro.textContent=`You’re ${remaining} away from eligible free UK standard delivery. One useful add-on may get you there.`;
    else intro.textContent='Add another useful size or pack now and build one complete packaging order.';
    head.append(title,intro);
    const grid=document.createElement('div');
    grid.className='cart-addons__grid';

    products.forEach(product=>{
      const card=document.createElement('article');
      card.className='cart-addon';
      const media=document.createElement('a');
      media.className='cart-addon__media';
      media.href=`/products/${product.handle}`;
      media.setAttribute('aria-label',`View ${product.title}`);
      const rawImage=product.images?.[0];
      const imageSrc=typeof rawImage==='string'?rawImage:rawImage?.src;
      if(imageSrc){const image=document.createElement('img');image.src=imageSrc;image.alt=product.title;image.loading='lazy';media.append(image)}
      const heading=document.createElement('h3');
      const productLink=document.createElement('a');
      productLink.href=media.href;
      productLink.textContent=product.title;
      heading.append(productLink);
      const variants=(product.variants||[]).filter(variant=>variant.available!==false);
      if(!variants.length)return;
      const select=document.createElement('select');
      select.setAttribute('aria-label',`Choose ${product.title} option`);
      variants.forEach(variant=>{
        const option=document.createElement('option');
        option.value=variant.id;
        const variantTitle=variant.title&&variant.title!=='Default Title'?variant.title:'One pack';
        option.textContent=`${variantTitle} — ${packsmartFormatProductJsonPrice(variant.price)}`;
        select.append(option);
      });
      const add=document.createElement('button');
      add.type='button';
      add.className='cart-addon__add';
      add.textContent='Add to basket';
      add.addEventListener('click',async()=>{
        add.disabled=true;
        add.textContent='Adding…';
        try{
          const addResponse=await fetch('/cart/add.js',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({items:[{id:Number(select.value),quantity:1}]})});
          if(!addResponse.ok)throw new Error('Unable to add item');
          window.location.reload();
        }catch(error){add.disabled=false;add.textContent='Try again';console.warn('Packsmart add-on could not be added.',error)}
      });
      card.append(media,heading,select,add);
      grid.append(card);
    });
    if(!grid.children.length)return;
    section.append(head,grid);
    actions.parentNode.insertBefore(section,actions);
  }catch(error){console.warn('Packsmart add-ons unavailable.',error)}
}

function packsmartRunConversionBoost(){
  packsmartInjectConversionStyles();
  packsmartEnhanceBestValue();
  packsmartEnhanceCartLines();
  packsmartLoadCartAddons();
}

document.addEventListener('DOMContentLoaded',packsmartRunConversionBoost);
