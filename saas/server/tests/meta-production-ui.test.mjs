import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash, webcrypto} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {jpegFixture} from './marketing-local-jpeg-fixture.mjs';
const until = async fn => {for (let i = 0; i < 100; i++) {if (fn()) return; await new Promise(r => setTimeout(r, 10));} assert.fail('UI did not settle');};
async function fixture(t, {enabled = true, role = 'owner'} = {}) {
  const dom = new JSDOM('<body><article><button data-publication-choices="campaign-1">Preview</button></article></body>', {url: 'https://packsmart-ops.onrender.com', runScripts: 'outside-only'});
  t.after(() => dom.window.close()); const w = dom.window, d = w.document;
  w.HTMLDialogElement.prototype.showModal = function () {this.open = true;}; w.HTMLDialogElement.prototype.close = function () {this.open = false;};
  Object.defineProperty(w, 'crypto', {value: webcrypto});
  const bytes = jpegFixture(), sha256 = createHash('sha256').update(bytes).digest('hex');
  const context = {workspaceId: 'workspace-1', userId: 'owner-1'}, calls = [];
  const f = {w, d, calls, valid: true, bytes, context};
  f.saved = {campaignId: 'campaign-1', requestId: 'production-request-ui-0001', status: 'pending', enabled, expiresAt: Date.now() + 3600000,
    consent: {postCount: 1, caption: 'Exact <img src=x onerror="window.injected=true"> caption', imageSha256: sha256, byteLength: bytes.length,
      sourceRevision: 'a'.repeat(64), target: {pageId: '202', instagramId: '303', account: '101'}}, retained: {phase: 'not_started', canContinue: true}};
  f.image = {mediaType: 'image/jpeg', sha256, bytesBase64: bytes.toString('base64')};
  f.request = async (route, options = {}) => {
    calls.push({route, options}); if (f.hook) {const value = await f.hook(route, options); if (value !== undefined) return value;}
    if (route.endsWith('/context')) return {enabled, notice: enabled ? 'Exact review' : 'Publishing closed', pages: [{pageId: '202', instagramId: '303'}], assets: [{creativeRequestId: 'creative-1', assetUrl: 'https://source.invalid/image.jpg'}]};
    if (route.endsWith('/proposals')) {f.saved.requestId = JSON.parse(options.body).requestId; return structuredClone(f.saved);}
    if (route.endsWith('/image')) return structuredClone(f.image);
    if (route.endsWith('/decision')) {f.saved.status = JSON.parse(options.body).decision; return structuredClone(f.saved);}
    if (route.endsWith('/execute')) {f.saved.retained = {phase: 'published', canContinue: false, resultId: '900002'}; return {resultId: '900002'};}
    return structuredClone(f.saved);
  };
  w.eval(await readFile(new URL('../../meta-production-ui.js', import.meta.url), 'utf8'));
  w.RunvaraMetaProduction.init({request: f.request, getContext: () => context, isCurrent: c => c === context && f.valid && role === 'owner'});
  w.RunvaraMetaProduction.render(); f.open = () => d.querySelector('[data-meta-production-open]')?.click();
  f.openSaved = () => {const button = d.createElement('button'); button.dataset.metaProductionCampaign = 'campaign-1'; button.dataset.metaProductionRequest = f.saved.requestId; d.body.append(button); button.click();};
  f.button = text => [...d.querySelectorAll('#meta-production-dialog button')].find(b => b.textContent === text);
  return f;
}

test('actual production UI is owner-only and closed mode performs no mutation', async t => {
  const viewer = await fixture(t, {role: 'viewer'}); assert.equal(viewer.d.querySelector('[data-meta-production-open]'), null);
  const f = await fixture(t, {enabled: false}); f.open(); await until(() => f.d.querySelector('[role=status]').textContent === 'Publishing closed');
  assert.equal(f.d.querySelector('[data-meta-production-form]'), null); assert.equal(f.calls.length, 1);
});

test('exact retained bytes/caption and one-post consent require distinct approval and publication clicks', async t => {
  const f = await fixture(t); f.openSaved(); await until(() => f.button('Approve this exact proposal'));
  assert.equal(f.d.querySelector('img').getAttribute('src'), 'data:image/jpeg;base64,' + f.image.bytesBase64);
  assert.equal(f.d.querySelectorAll('img').length, 1); assert.equal(f.w.injected, undefined);
  assert.ok(f.d.querySelector('pre').textContent.includes('<img src=x'));
  f.button('Approve this exact proposal').click(); assert.equal(f.calls.filter(c => c.options.method === 'POST').length, 0);
  f.d.querySelector('[data-meta-production-consent]').checked = true; f.button('Approve this exact proposal').click();
  await until(() => f.button('Publish this exact one post'));
  assert.equal(f.calls.filter(c => c.route.endsWith('/execute')).length, 0);
  f.d.querySelector('[data-meta-production-consent]').checked = true; f.button('Publish this exact one post').click();
  await until(() => f.d.querySelector('section').textContent.includes('900002'));
  assert.equal(f.calls.filter(c => c.route.endsWith('/execute')).length, 1);
  assert.deepEqual(JSON.parse(f.calls.find(c => c.route.endsWith('/execute')).options.body).consent, f.saved.consent);
  assert.equal(f.button('Publish this exact one post'), undefined);
});

test('image-byte disagreement cannot expose approval or publication actions', async t => {
  const f = await fixture(t); f.image.bytesBase64 = Buffer.alloc(100).toString('base64'); f.openSaved();
  await until(() => f.d.querySelector('[role=status]').textContent.includes('could not be confirmed'));
  assert.equal(f.button('Approve this exact proposal'), undefined); assert.equal(f.d.querySelector('img'), null);
  assert.equal(f.calls.filter(c => c.options.method === 'POST').length, 0);
});

test('retained unresolved and terminal readiness cannot expose a continuation button or claim a publication ID', async t => {
  for (const phase of ['readiness_unresolved', 'publication_id_unresolved', 'container_error', 'container_expired', 'readiness_budget_closed', 'readiness_waiting']) {
    const f = await fixture(t); f.saved.status = 'approved'; f.saved.retained = {phase, canContinue: false, resultId: null, retryAfter: new Date(Date.now() + 60000).toISOString()};
    f.openSaved(); await until(() => f.button('Read saved outcome without contacting Meta'));
    assert.equal(f.button('Check readiness and publish this approved post'), undefined);
    assert.equal(f.button('Publish this exact one post'), undefined);
    assert.ok(!f.d.querySelector('section').textContent.includes('Retained provider result:'));
    f.button('Read saved outcome without contacting Meta').click();
    await until(() => f.button('Read saved outcome without contacting Meta'));
    assert.equal(f.calls.filter(c => c.options.method === 'POST').length, 0);
  }
});

test('session change discards late private results and retained storage contains only request reference', async t => {
  const f = await fixture(t); f.open(); await until(() => f.d.querySelector('[data-meta-production-form]'));
  const form = f.d.querySelector('form'); Object.defineProperty(form.querySelector('input'), 'files', {value: [new f.w.File([f.bytes], 'synthetic.jpg', {type: 'image/jpeg'})]});
  let release; f.hook = async route => {if (route.endsWith('/proposals')) return new Promise(resolve => {release = resolve;});};
  form.dispatchEvent(new f.w.Event('submit', {bubbles: true, cancelable: true})); await until(() => release);
  assert.equal(f.w.sessionStorage.length, 1); assert.match(f.w.sessionStorage.getItem(f.w.sessionStorage.key(0)), /^[A-Za-z0-9_-]{16,100}$/);
  f.valid = false; f.w.RunvaraMetaProduction.render(); release(f.saved); await new Promise(r => setTimeout(r, 30));
  assert.equal(f.d.querySelector('dialog').open, false); assert.equal(f.d.querySelector('dialog').textContent, '');
  assert.equal(f.calls.filter(c => c.route.endsWith('/image')).length, 0);
});
