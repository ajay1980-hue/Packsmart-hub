'use strict';

const assert = require('assert');
const core = require('../core.js');
const backendLib = require('../backend.js');

function photo(name, kind = 'remote') {
  return {
    name,
    kind,
    url: kind === 'remote' ? `https://img.example/${name}.jpg` : `blob:${name}`,
    file: kind === 'file' ? new Blob([name], { type: 'image/jpeg' }) : null
  };
}

(async () => {
  const thirty = Array.from({ length: 30 }, (_, i) => photo(`p${i + 1}`));
  const capped = core.appendPhotos([], thirty);
  assert.equal(capped.length, 24, 'photo selection must cap at 24');

  const existing = [photo('a'), photo('b')];
  const appended = core.appendPhotos(existing, [photo('c'), photo('d')]);
  assert.deepEqual(appended.map(x => x.name), ['a', 'b', 'c', 'd'], 'adding photos must preserve current selection');

  const moved = core.movePhoto(appended, 3, -1);
  assert.deepEqual(moved.map(x => x.name), ['a', 'b', 'd', 'c'], 'reorder must move a photo one slot');

  const main = core.makeMain(moved, 2);
  assert.deepEqual(main.map(x => x.name), ['d', 'a', 'b', 'c'], 'main-image selection must move chosen photo to position 1');

  assert.equal(core.validatePhotoFile({ name: 'photo.png', type: 'image/png', size: 1024 }), '', 'PNG photos must be accepted');
  assert.match(
    core.validatePhotoFile({ name: 'notes.pdf', type: 'application/pdf', size: 1024 }),
    /not an eBay-supported image/,
    'PDF files must not be silently accepted as listing photos'
  );
  assert.match(
    core.validatePhotoFile({ name: 'huge.jpg', type: 'image/jpeg', size: core.MAX_PHOTO_BYTES + 1 }),
    /12 MB/,
    'oversized eBay photos must be rejected before upload'
  );
  assert.equal(core.validateLabelFile({ name: 'label.pdf', type: 'application/pdf', size: 2048 }), '', 'PDF postage labels must be accepted');
  assert.equal(core.labelFileKind({ name: 'label.webp', type: 'image/webp' }), 'image', 'image postage labels must be accepted');

  const product = core.normalizePublicProduct({
    id: 123,
    handle: 'sample',
    title: 'Sample product',
    body_html: '<p>Useful <strong>description</strong></p>',
    variants: [{ title: 'Pack of 50', price: '9.99', sku: 'SKU-50' }],
    images: [{ src: 'https://cdn.example/1.jpg' }, { src: 'https://cdn.example/2.jpg' }]
  });
  assert.equal(product.title, 'Sample product');
  assert.equal(product.variants[0].sku, 'SKU-50');
  assert.equal(product.images.length, 2);
  assert.equal(product.description, 'Useful description');

  const local = photo('local', 'file');
  const draft = core.buildDraft(
    {
      title: 'A valid eBay title',
      price: '12.50',
      sku: 'ABC',
      description: 'Description',
      ebayAccount: 'packsmartsolutions20',
      postageMode: 'paid',
      shippingServiceCode: 'UK_RoyalMailTracked',
      shippingServiceName: 'Royal Mail Tracked 48',
      shippingCost: '3.71'
    },
    [main[0], local, main[1]],
    product,
    'live'
  );
  assert.equal(draft.photoOrder[0].main, true, 'first image must be main');
  assert.equal(draft.photoOrder[1].localFileIndex, 0, 'local file index must match upload order');
  assert.equal(draft.localPhotoCount, 1);
  assert.equal(draft.ebayAccount, 'packsmartsolutions20');
  assert.equal(draft.postage.freeShipping, false);
  assert.equal(draft.postage.shippingCost.value, '3.71');
  assert.equal(draft.shippingDetails.shippingServiceOptions[0].shippingService, 'UK_RoyalMailTracked');
  assert.deepEqual(core.validateDraft(draft, 3), []);

  const freePostage = core.normalizePostage({
    postageMode: 'free',
    shippingServiceCode: 'UK_RoyalMailTracked',
    shippingCost: '99.99'
  });
  assert.equal(freePostage.freeShipping, true);
  assert.equal(freePostage.shippingCost.value, '0.00', 'free postage must always send a zero charge');

  const invalidPaid = Object.assign({}, draft, {
    postage: core.normalizePostage({ postageMode: 'paid', shippingServiceCode: 'UK_RoyalMailTracked', shippingCost: '' })
  });
  assert.match(core.validateDraft(invalidPaid, 3).join(' '), /paid-postage amount/, 'paid postage must require a positive cost');
  assert.equal(core.extractEbayAccount({ user: { username: 'packsmartsolutions20' } }), 'packsmartsolutions20');

  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/ebay/drafts')) {
      return new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(JSON.stringify({ ok: true, id: 'draft-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  const backend = backendLib.createBackend({ fetchImpl: fakeFetch, baseUrl: 'https://manager.example' });
  const result = await backend.saveDraft(draft, [main[0], local, main[1]]);
  assert.equal(result.data.ok, true);
  assert.equal(calls.length, 2, 'backend should try next compatible route only after 404/405');
  assert.ok(calls[1].init.body instanceof FormData, 'draft request must use multipart FormData');
  assert.equal(calls[1].init.body.getAll('photos').length, 1, 'multipart request must include local photos');
  assert.equal(JSON.parse(calls[1].init.body.get('photoOrder'))[0].main, true, 'multipart payload must preserve main image');
  assert.equal(calls[1].init.body.get('ebayAccount'), 'packsmartsolutions20', 'multipart payload must target the correct eBay account');
  assert.equal(calls[1].init.body.get('freeShipping'), 'false', 'multipart payload must preserve paid-postage choice');
  assert.equal(calls[1].init.body.get('shippingCost'), '3.71', 'multipart payload must include buyer postage cost');
  assert.equal(JSON.parse(calls[1].init.body.get('postage')).serviceCode, 'UK_RoyalMailTracked');

  console.log('Packsmart eBay Manager tests passed');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
