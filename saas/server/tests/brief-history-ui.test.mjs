import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';

const html = await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8');
const script = await fs.readFile(new URL('../../brief-history-ui.js', import.meta.url), 'utf8');
const when = '2026-10-01T12:00:00.000Z';
const brief = (id = 'brief/one?selected=1') => ({ id, generatedAt: when, summary: 'Historical summary only.', today: { profit: null, revenue: '12.3400', currency: 'GBP' },
  topActions: [{ title: 'Review recorded coverage', detail: 'Profit remained unknown.' }], recommendations: [{ title: 'Saved recommendation', detail: 'A recommendation is not an executed action.' }], originalExtra: { source: 'Complete recorded evidence' } });
const listing = (id = 'brief/one?selected=1', integrity = 'archive_pending_read') => ({ limit: 30, briefs: [{ id, generatedAt: when, summary: 'Historical summary only.', archived: integrity !== 'retained', integrity }] });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Saved brief UI did not settle'); }
async function harness(t) {
  const errors = [], virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, { url: 'https://brief-history.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window, d = w.document;
  w.AbortController = AbortController;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; d.getElementById('brief-history-close').focus(); };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  const h = { w, d, calls: [], context: { session: {}, userId: 'user-one', role: 'owner', workspaceId: 'workspace-one', view: 'overview', generation: 1, csrf: 'one', sessionUserId: 'user-one', sessionWorkspaceId: 'workspace-one', sessionRole: 'owner' } };
  h.handler = async route => route.includes('?view=history') ? listing() : { brief: brief(), integrity: 'verified_archive' };
  w.eval(script); w.RunvaraBriefHistory.init({ getContext: () => h.context, request: (route, config) => { h.calls.push({ route, config }); return h.handler(route, config); } });
  h.$ = id => d.getElementById(id); h.dialog = h.$('brief-history-dialog'); h.list = h.$('brief-history-list'); h.detail = h.$('brief-history-detail'); h.status = h.$('brief-history-status');
  h.open = async () => { h.$('open-brief-history').focus(); h.$('open-brief-history').click(); await h.settle(); };
  h.settle = async () => until(() => h.$('brief-history-body').getAttribute('aria-busy') === 'false');
  h.read = async () => { h.list.querySelector('button').click(); await h.settle(); };
  t.after(async () => { await new Promise(r => setTimeout(r, 5)); w.close(); assert.deepEqual(errors, []); });
  return h;
}

test('startup and resets are quiet; one bounded list and one selected encoded detail are read only on demand', async t => {
  const h = await harness(t);
  assert.equal(h.calls.length, 0); assert.equal(h.dialog.open, false);
  h.w.RunvaraBriefHistory.reset(); h.w.RunvaraBriefHistory.pause(); assert.equal(h.calls.length, 0);
  await h.open(); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].route, '/api/briefs?view=history');
  assert.match(h.list.textContent, /integrity not checked yet/); assert.doesNotMatch(h.list.textContent, /integrity matched/);
  assert.equal(h.detail.textContent, '');
  await h.read(); assert.equal(h.calls.length, 2); assert.equal(h.calls[1].route, '/api/briefs/' + encodeURIComponent(brief().id));
  assert.match(h.detail.textContent, /Archive integrity matched/); assert.match(h.detail.textContent, /does not establish accuracy or immutability/);
  assert.match(h.detail.textContent, /Historical record only/); assert.match(h.detail.textContent, /Top actions recorded at the time/); assert.match(h.detail.textContent, /Recommendations recorded at the time/);
  assert.equal(h.detail.querySelector('details').open, false); assert.deepEqual(JSON.parse(h.detail.querySelector('pre').textContent), brief());
  assert.match(h.detail.textContent, /Missing or null amounts remain unknown/);
  assert.equal(h.calls.every(call => !call.config.method && !call.config.body), true);
  h.$('brief-history-back').click(); assert.equal(h.calls.length, 2); assert.equal(h.detail.textContent, '');
  h.$('brief-history-close').click(); assert.equal(h.list.textContent, ''); assert.equal(h.detail.textContent, '');
  assert.equal(h.d.activeElement, h.$('open-brief-history'));
  await h.open(); assert.equal(h.calls.length, 3, 'reopening reads a new bounded list and never prefetches detail');
});

test('empty history and missing summary/date remain explicit without fabricated numbers', async t => {
  const h = await harness(t); h.handler = async () => ({ limit: 30, briefs: [] }); await h.open();
  assert.match(h.status.textContent, /No saved briefs are retained/); assert.equal(h.list.children.length, 0);
  h.$('brief-history-close').click();
  h.handler = async route => route.includes('?view=history') ? { limit: 30, briefs: [{ id: 'unknown', archived: false, integrity: 'retained' }] } : { brief: { id: 'unknown', today: { profit: null } }, integrity: 'retained' };
  await h.open(); assert.match(h.list.textContent, /Date unknown/); assert.match(h.list.textContent, /No summary was recorded/);
  await h.read(); assert.match(h.detail.textContent, /Date unknown/); assert.match(h.detail.textContent, /No summary was recorded/);
  assert.deepEqual(JSON.parse(h.detail.querySelector('pre').textContent), { id: 'unknown', today: { profit: null } });
});

test('legacy archives stay explicitly unverified and unavailable reads never masquerade as complete summaries', async t => {
  const h = await harness(t); h.handler = async route => route.includes('?view=history') ? listing(undefined, 'legacy_archive_unverified') : { brief: brief(), integrity: 'legacy_archive_unverified' };
  await h.open(); await h.read(); assert.match(h.detail.textContent, /Legacy archive · integrity unverified/); assert.match(h.detail.textContent, /could not be checked against/);
  for (const status of [404, 503, 403, 401, 500]) {
    h.$('brief-history-back').click(); h.handler = async () => { throw Object.assign(new Error('private server diagnostic'), { status }); }; await h.read();
    assert.equal(h.detail.textContent, ''); assert.equal(h.$('brief-history-retry').hidden, false); assert.doesNotMatch(h.status.textContent, /private server diagnostic/);
    if (status === 503) assert.match(h.status.textContent, /unavailable or could not be verified/);
    if (status === 404) assert.match(h.status.textContent, /no longer available/);
  }
});

test('unavailable archive references remain listed without implying that complete detail was recovered', async t => {
  const h = await harness(t); h.handler = async route => {
    if (route.includes('?view=history')) return listing(undefined, 'archive_unavailable');
    throw Object.assign(new Error('unsupported-reference'), { status: 503 });
  };
  await h.open(); assert.match(h.list.textContent, /Full snapshot unavailable/); assert.doesNotMatch(h.list.textContent, /integrity matched/);
  await h.read(); assert.equal(h.detail.textContent, ''); assert.match(h.status.textContent, /unavailable or could not be verified/);
});

test('oversized archived details keep their stored-content explanation without raw diagnostics, truncation or automatic retries', async t => {
  const h = await harness(t); await h.open();
  h.handler = async () => { throw Object.assign(new Error('private archive path and byte count'), { status: 503, code: 'BRIEF_ARCHIVE_TOO_LARGE' }); };
  await h.read();
  assert.equal(h.status.textContent, 'This saved brief is too large to open safely here. It remains stored; no detail has been deleted or truncated.');
  assert.equal(h.detail.textContent, ''); assert.equal(h.$('brief-history-retry').hidden, false);
  assert.doesNotMatch(h.dialog.textContent, /private archive path|byte count/);
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(h.calls.length, 2, 'no automatic retry or alternate export request');
  h.$('brief-history-retry').click(); await h.settle(); assert.equal(h.calls.length, 3, 'only an explicit retry reads the same selected ID');
  assert.equal(h.calls[2].route, h.calls[1].route); assert.equal(h.detail.textContent, '');
});

test('hostile summary, action, recommendation and complete fields are text, never executable HTML', async t => {
  const h = await harness(t), hostile = '<img src=x onerror="window.injected=true"><script>window.injected=true</script>';
  const full = { ...brief(), summary: hostile, topActions: [{ title: hostile, detail: hostile, qualification: hostile }], recommendations: [hostile, null, { title: hostile, action: hostile }], extra: hostile };
  h.handler = async route => route.includes('?view=history') ? { ...listing(), briefs: [{ ...listing().briefs[0], summary: hostile }] } : { brief: full, integrity: 'verified_archive' };
  await h.open(); assert.ok(h.list.textContent.includes(hostile)); await h.read();
  assert.ok(h.detail.textContent.includes(hostile)); assert.equal(h.dialog.querySelectorAll('img,script,[onerror]').length, 0); assert.equal(h.w.injected, undefined);
  assert.deepEqual(JSON.parse(h.detail.querySelector('pre').textContent), full);
});

test('malformed, oversized and duplicate lists fail closed without rendering partial results', async t => {
  const h = await harness(t);
  for (const payload of [null, {}, [], { briefs: [], limit: 31 }, { limit: 30, briefs: {} }, { limit: 30, briefs: [null] },
    { limit: 30, briefs: [...listing().briefs, ...listing().briefs] }, { limit: 30, briefs: Array.from({ length: 31 }, (_, i) => ({ ...listing().briefs[0], id: String(i) })) },
    { limit: 30, briefs: [{ ...listing().briefs[0], summary: {} }] }, { limit: 30, briefs: [{ ...listing().briefs[0], integrity: 'verified_archive' }] }]) {
    h.handler = async () => payload; await h.open(); assert.equal(h.list.children.length, 0); assert.match(h.status.textContent, /could not be listed/); h.$('brief-history-close').click();
  }
});

test('malformed detail, mismatched IDs and hot stubs fail closed with a manual retry', async t => {
  const h = await harness(t); await h.open();
  for (const payload of [null, {}, { brief: null, integrity: 'retained' }, { brief: { ...brief(), id: 'different' }, integrity: 'retained' }, { brief: brief(), integrity: 'archive_pending_read' },
    { brief: { ...brief(), archived: true }, integrity: 'verified_archive' }, { brief: { ...brief(), archive: { schema: 'runvara-brief-history/v1' } }, integrity: 'retained' },
    { brief: { ...brief(), archive: { schema: 'unknown-reference' } }, integrity: 'verified_archive' }, { brief: { ...brief(), archive: null }, integrity: 'retained' }]) {
    h.handler = async () => payload; await h.read(); assert.equal(h.detail.textContent, ''); assert.match(h.status.textContent, /No complete detail can be shown/); h.$('brief-history-back').click();
  }
  let reads = 0; h.handler = async () => { reads++; return { brief: brief(), integrity: 'retained' }; }; await h.read(); assert.equal(reads, 1);
});

test('repeated open, detail and retry clicks never overlap requests or scan other IDs', async t => {
  const h = await harness(t), hold = deferred(); h.handler = () => hold.promise;
  h.$('open-brief-history').click(); h.$('open-brief-history').click(); h.$('open-brief-history').dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  assert.equal(h.calls.length, 1); hold.resolve({ limit: 30, briefs: Array.from({ length: 30 }, (_, i) => ({ ...listing().briefs[0], id: 'brief_' + i })) }); await h.settle();
  const detail = deferred(); h.handler = () => detail.promise; const buttons = [...h.list.querySelectorAll('button')];
  buttons[0].click(); buttons[0].dispatchEvent(new h.w.MouseEvent('click', { bubbles: true })); buttons[1].dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  h.$('brief-history-retry').dispatchEvent(new h.w.MouseEvent('click', { bubbles: true })); assert.equal(h.calls.length, 2);
  detail.resolve({ brief: brief('brief_0'), integrity: 'retained' }); await h.settle(); assert.equal(h.calls.length, 2);
});

test('close, Escape, native close, reset and view pause abort pending work and clear all records', async t => {
  for (const close of [h => h.$('brief-history-close').click(), h => h.dialog.dispatchEvent(new h.w.Event('cancel', { cancelable: true })), h => h.dialog.close(), h => h.w.RunvaraBriefHistory.reset(), h => h.w.RunvaraBriefHistory.pause()]) {
    const h = await harness(t); await h.open(); const hold = deferred(); h.handler = () => hold.promise; h.list.querySelector('button').click();
    close(h); close(h); assert.equal(h.calls[1].config.signal.aborted, true); assert.equal(h.dialog.open, false);
    assert.equal(h.list.textContent, ''); assert.equal(h.detail.textContent, '');
    hold.resolve({ brief: brief(), integrity: 'verified_archive' }); await new Promise(r => setTimeout(r, 5));
    assert.equal(h.list.textContent, ''); assert.equal(h.detail.textContent, ''); assert.equal(h.status.textContent, '');
  }
});

test('every context fence rejects stale success and stale error, including the same user in a new session', async t => {
  for (const key of ['session', 'workspaceId', 'userId', 'role', 'view', 'generation', 'csrf', 'sessionWorkspaceId', 'sessionUserId', 'sessionRole']) {
    for (const reject of [false, true]) {
      const h = await harness(t); await h.open(); const hold = deferred(); h.handler = () => hold.promise; h.list.querySelector('button').click();
      h.context[key] = key === 'session' ? {} : key === 'generation' ? 2 : 'new-' + key;
      assert.equal(h.calls[1].config.isCurrent(), false); assert.equal(h.calls[1].config.signal.aborted, true);
      if (reject) hold.reject(Object.assign(new Error('Old session only'), { status: 401 })); else hold.resolve({ brief: brief(), integrity: 'verified_archive' });
      await new Promise(r => setTimeout(r, 5)); assert.equal(h.dialog.open, false); assert.equal(h.detail.textContent, ''); assert.equal(h.list.textContent, ''); assert.equal(h.status.textContent, '');
    }
  }
});

test('out-of-order list/detail responses and a delayed native close cannot overwrite a reopened modal', async t => {
  const h = await harness(t), oldList = deferred(); h.handler = () => oldList.promise;
  h.$('open-brief-history').click(); h.$('brief-history-close').click(); h.handler = async () => listing('new-list', 'retained'); await h.open();
  h.dialog.dispatchEvent(new h.w.Event('close')); assert.equal(h.dialog.open, true); assert.equal(h.list.querySelector('button').dataset.briefId, 'new-list');
  oldList.resolve(listing('old-list')); await h.settle(); assert.equal(h.list.querySelector('button').dataset.briefId, 'new-list');
  const oldDetail = deferred(); h.handler = () => oldDetail.promise; h.list.querySelector('button').click(); h.$('brief-history-back').click();
  h.handler = async () => ({ brief: { ...brief('new-list'), summary: 'Newest result' }, integrity: 'retained' }); await h.read();
  oldDetail.reject(Object.assign(new Error('Stale 401'), { status: 401 })); await new Promise(r => setTimeout(r, 5));
  assert.match(h.detail.textContent, /Newest result/); assert.doesNotMatch(h.status.textContent, /Stale|Sign in/); assert.equal(h.dialog.open, true);
});

async function appHarness(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-brief-app-'));
  const secret = 'brief-app-lifecycle-fixture-over-thirty-two-characters';
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret, SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' }, { schedulerEnabled: false, agentOpsEnabled: false });
  const state = seedWorkspaceState({}, { workspaceId: 'brief-app', email: 'owner@brief-app.test', passwordHash: 'synthetic-only' }); state.products = [];
  await server.packsmart.store.save(state.workspace.id, state); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bootstrap`, { headers: { Cookie: `packsmart_session=${token}` } }); assert.equal(response.status, 200); const bootstrap = await response.json();
  await new Promise(r => server.close(r));
  const errors = [], virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, { url: 'https://brief-app.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window, d = w.document, h = { w, d, calls: [], bootstrap, $: id => d.getElementById(id) };
  w.Headers = Headers; w.AbortController = AbortController; w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  h.handler = async route => Response.json(route.includes('?view=history') ? listing() : { brief: brief(), integrity: 'verified_archive' });
  w.fetch = async (route, config = {}) => {
    h.calls.push({ route, config });
    if (route === '/api/bootstrap') return Response.json(bootstrap);
    if (['/api/auth/session', '/api/auth/login'].includes(route)) return Response.json({ user: bootstrap.user, workspace: bootstrap.workspace, csrf: bootstrap.csrf });
    if (route === '/api/auth/logout') return Response.json({ ok: true });
    if (route === '/api/auth/signup-options') return Response.json({ enabled: false });
    if (route.startsWith('/api/briefs')) return h.handler(route, config);
    throw new Error('Unexpected fixture route ' + route);
  };
  for (const file of ['presentation.js', 'control-ui.js', 'brief-history-ui.js', 'app.js']) w.eval(await fs.readFile(new URL('../../' + file, import.meta.url), 'utf8'));
  await until(() => !h.$('app-shell').classList.contains('hidden'));
  h.open = async () => { h.$('open-brief-history').click(); await until(() => h.$('brief-history-list').querySelector('button')); };
  h.begin = async () => { await h.open(); const hold = deferred(); h.handler = () => hold.promise; h.$('brief-history-list').querySelector('button').click(); return hold; };
  t.after(async () => { await new Promise(r => setTimeout(r, 10)); w.close(); await fs.rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  return h;
}

test('real app boot/navigation stay quiet and view changes clear and abort selected history reads', async t => {
  const h = await appHarness(t); assert.equal(h.calls.filter(call => call.route.startsWith('/api/briefs')).length, 0);
  h.d.querySelector('#main-nav [data-view="profit"]').click(); h.d.querySelector('#main-nav [data-view="overview"]').click();
  assert.equal(h.calls.filter(call => call.route.startsWith('/api/briefs')).length, 0);
  const hold = await h.begin(), call = h.calls.at(-1); h.d.querySelector('#main-nav [data-view="profit"]').click();
  assert.equal(call.config.signal.aborted, true); assert.equal(h.$('brief-history-dialog').open, false); assert.equal(h.$('brief-history-list').textContent, '');
  hold.resolve(Response.json({ brief: brief(), integrity: 'verified_archive' })); await new Promise(r => setTimeout(r, 10)); assert.equal(h.$('brief-history-detail').textContent, '');
});

test('real app ignores a late old-session 401 after logout and a new login', async t => {
  const h = await appHarness(t), hold = await h.begin();
  h.$('logout').click(); await until(() => !h.$('login-screen').classList.contains('hidden')); assert.equal(h.$('brief-history-list').textContent, '');
  h.bootstrap.csrf = 'new-brief-session'; const form = h.$('login-form');
  Object.defineProperty(form, 'email', { value: form.elements.email }); Object.defineProperty(form, 'password', { value: form.elements.password });
  form.email.value = 'owner@brief-app.test'; form.password.value = 'synthetic-only'; form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !h.$('app-shell').classList.contains('hidden'));
  hold.resolve(Response.json({ code: 'AUTH_REQUIRED', error: 'Old session only' }, { status: 401 })); await new Promise(r => setTimeout(r, 10));
  assert.equal(h.$('app-shell').classList.contains('hidden'), false); assert.equal(h.$('login-screen').classList.contains('hidden'), true);
  assert.equal(h.$('brief-history-dialog').open, false); assert.equal(h.$('brief-history-detail').textContent, ''); assert.equal(h.$('brief-history-status').textContent, '');
});
