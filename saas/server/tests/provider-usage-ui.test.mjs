// The real app code/HTML, synthetic bootstrap and accounting fixtures only.
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

const usagePath = '/api/operator/provider-usage';
const fixtures = {
  available: true, admissionMonth: '2026-10', workspaceId: 'packsmart-solutions', currency: 'USD',
  source: 'governed_reservations_only', excludesLegacyUsage: true, excludesProviderBill: true,
  scopes: [
    { scopeKey: 'tenant', settled: { requests: 2, inputTokens: 3000, outputTokens: 1000, totalTokens: 4000, costMicros: 1250000 }, held: { requests: 1, inputTokens: 4000, outputTokens: 1000, totalTokens: 5000, costMicros: 750000 } },
    { scopeKey: 'provider:openai', settled: { requests: 2, inputTokens: 3000, outputTokens: 1000, totalTokens: 4000, costMicros: 1250000 }, held: { requests: 1, inputTokens: 4000, outputTokens: 1000, totalTokens: 5000, costMicros: 750000 } }
  ]
};
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function until(condition, diagnostic = () => '') {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`UI did not reach expected state: ${diagnostic()}`);
}
async function harness(t, { launchAdmin = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-usage-ui-'));
  const secret = 'provider-usage-ui-test-only-secret-more-than-32-characters';
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
    PACKSMART_ADMIN_EMAIL: 'usage-admin@example.test', SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' });
  const state = seedWorkspaceState({}, { workspaceId: 'packsmart-solutions', name: 'Synthetic usage admin', email: 'usage-admin@example.test', passwordHash: 'fixture-only' });
  state.products = [];
  await server.packsmart.store.save(state.workspace.id, state);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  const response = await fetch(base + '/api/bootstrap', { headers: { Cookie: `packsmart_session=${token}` } });
  assert.equal(response.status, 200);
  const bootstrap = await response.json(); bootstrap.launchAdmin = launchAdmin;
  await new Promise(resolve => server.close(resolve));
  const errors = [], calls = [], console = new VirtualConsole();
  console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8'), { url: base, runScripts: 'outside-only', virtualConsole: console, pretendToBeVisual: true });
  t.after(async () => { dom.window.close(); await fs.rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  const window = dom.window, document = window.document;
  const h = { window, document, bootstrap, calls, errors, usageHandler: async () => Response.json(structuredClone(fixtures)) };
  window.Headers = Headers; window.AbortController = AbortController; window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.localStorage.setItem('packsmart-saas-cloud-migration-v3:packsmart-solutions', 'fixture-complete');
  window.RunvaraControl = { init(api) { h.controls = api; }, render() {}, evidence() { return ''; }, history() { return ''; } };
  h.fleet = { workspaces: [
    { workspaceId: 'packsmart-solutions', name: 'Synthetic usage admin' },
    { workspaceId: 'tenant-ui-b', name: 'Synthetic second tenant' }
  ], totals: {}, worker: {}, modelCatalog: [] };
  window.fetch = async (route, options = {}) => {
    calls.push({ route: String(route), method: options.method || 'GET', credentials: options.credentials, cache: options.cache });
    if (String(route).startsWith(usagePath)) return h.usageHandler(route, options);
    if (route === '/api/auth/session' || route === '/api/auth/login') return Response.json({ user: h.bootstrap.user, workspace: h.bootstrap.workspace, csrf: h.bootstrap.csrf });
    if (route === '/api/bootstrap') return Response.json(h.bootstrap);
    if (route === '/api/operator/agent-ops') return Response.json(h.fleet);
    if (route === '/api/auth/logout') return Response.json({ ok: true });
    if (route === '/api/auth/signup-options') return Response.json({ enabled: false });
    throw new Error(`Unexpected synthetic request: ${route}`);
  };
  for (const file of ['presentation.js', 'app.js']) window.eval(await fs.readFile(new URL(`../../${file}`, import.meta.url), 'utf8'));
  await until(() => !document.querySelector('#app-shell').classList.contains('hidden'), () => document.querySelector('#startup-error').textContent + errors.join(';'));
  h.button = document.querySelector('#fleet-provider-usage-refresh');
  h.workspace = document.querySelector('#fleet-provider-usage-workspace');
  h.month = document.querySelector('#fleet-provider-usage-month');
  h.result = document.querySelector('#fleet-provider-usage-result');
  h.details = h.button.closest('details');
  h.usageCalls = () => calls.filter(call => call.route.startsWith(usagePath));
  h.openFleet = async () => {
    document.querySelector('#main-nav [data-view="fleet"]').click();
    await until(() => h.workspace.options.length === 2);
    h.details.open = true;
    h.month.value = '2026-10';
  };
  h.inspect = async () => {
    const before = h.usageCalls().length;
    h.button.click();
    await until(() => !h.button.disabled && h.usageCalls().length === before + 1, () => h.result.textContent);
  };
  return h;
}

test('governed usage is opt-in: startup, navigation, details reopening, and fleet refresh never request it', async t => {
  const h = await harness(t);
  assert.equal(h.usageCalls().length, 0);
  await h.openFleet();
  assert.equal(h.usageCalls().length, 0);
  h.details.open = false; h.details.open = true;
  h.workspace.value = 'tenant-ui-b'; h.workspace.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  h.month.value = '2026-09'; h.month.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  h.document.querySelector('#fleet-refresh').click();
  await until(() => !h.document.querySelector('#fleet-refresh').disabled);
  assert.equal(h.usageCalls().length, 0);
  assert.equal(h.result.textContent, '');
  assert.match(h.details.textContent, /not your provider bill/);
  await h.inspect();
  assert.equal(h.usageCalls().length, 1);
  const call = h.usageCalls()[0], url = new URL(call.route, 'https://fixture.example');
  assert.equal(url.searchParams.get('workspaceId'), 'tenant-ui-b');
  assert.equal(url.searchParams.get('month'), '2026-09');
  assert.equal(call.method, 'GET');
  assert.equal(call.credentials, 'same-origin');
  assert.equal(call.cache, 'no-store');
  assert.equal(h.calls.some(item => !['GET'].includes(item.method)), false);
});

test('governed usage clearly labels overlapping scope rows, held bounds, and estimated USD costs', async t => {
  const h = await harness(t); await h.openFleet(); await h.inspect();
  assert.match(h.result.textContent, /tenant2026-10/);
  assert.match(h.result.textContent, /provider:openai/);
  assert.match(h.result.textContent, /Tenant and provider rows overlap; do not add them together/);
  assert.match(h.result.textContent, /Held amounts include requests whose final usage is not established/);
  assert.match(h.result.textContent, /2 settled requests/);
  assert.match(h.result.textContent, /1 held or uncertain requests/);
  assert.match(h.result.textContent, /Estimated settled cost \/ held exposure/);
  assert.match(h.result.textContent, /\$1\.25 \/ \$0\.7500/);
  assert.match(h.result.textContent, /4000 \/ 5000/);
  assert.match(h.result.textContent, /2026-10 · USD · recorded governed usage only/);
  assert.equal(h.result.getAttribute('aria-live'), 'polite');
});

test('unavailable accounting cannot be presented as zero spend, and an empty month excludes legacy billing', async t => {
  const h = await harness(t); await h.openFleet();
  h.usageHandler = async () => Response.json({ available: false, reason: 'LEDGER_UNAVAILABLE', scopes: fixtures.scopes });
  await h.inspect();
  assert.match(h.result.textContent, /accounting is unavailable/i);
  assert.match(h.result.textContent, /does not mean zero provider spend/);
  assert.doesNotMatch(h.result.textContent, /\$0|0 settled requests|provider:openai/);
  h.usageHandler = async () => Response.json({ admissionMonth: '2026-10', scopes: [] });
  await h.inspect();
  assert.match(h.result.textContent, /accounting is unavailable/i, 'missing availability must fail closed');
  h.usageHandler = async () => Response.json({ available: true, admissionMonth: '2026-10', scopes: [] });
  await h.inspect();
  assert.match(h.result.textContent, /No governed reservations recorded for this month/);
  assert.match(h.result.textContent, /Legacy activity and provider billing are not included/);
  assert.doesNotMatch(h.result.textContent, /\$0|zero provider spend/);
});

test('unknown costs/tokens/requests render unavailable markers while explicit zero remains zero', async t => {
  const h = await harness(t); await h.openFleet();
  h.usageHandler = async () => Response.json({ available: true, admissionMonth: '2026-10', scopes: [{ scopeKey: 'tenant:unknown', settled: { costMicros: null }, held: {} }] });
  await h.inspect();
  assert.match(h.result.textContent, /Unknown settled requests/);
  assert.match(h.result.textContent, /Unknown held or uncertain requests/);
  assert.match(h.result.textContent, /— \/ —/);
  assert.match(h.result.textContent, /Unknown \/ Unknown/);
  assert.doesNotMatch(h.result.textContent, /\$0/);
  h.usageHandler = async () => Response.json({ available: true, admissionMonth: '2026-10', scopes: [{ scopeKey: 'tenant:zero', settled: { requests: 0, totalTokens: 0, costMicros: 0 }, held: { requests: 0, totalTokens: 0, costMicros: 0 } }] });
  await h.inspect();
  assert.match(h.result.textContent, /0 settled requests/);
  assert.match(h.result.textContent, /\$0\.0000 \/ \$0\.0000/);
  assert.match(h.result.textContent, /0 \/ 0/);
});

test('rapid repeated clicks issue one request and lock selectors until the request finishes', async t => {
  const h = await harness(t); await h.openFleet();
  const pending = deferred(); h.usageHandler = () => pending.promise;
  h.button.click(); h.button.click();
  h.button.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.equal(h.usageCalls().length, 1);
  assert.equal(h.button.disabled, true);
  assert.equal(h.workspace.disabled, true);
  assert.equal(h.month.disabled, true);
  assert.equal(h.button.textContent, 'Reading ledger…');
  pending.resolve(Response.json(fixtures));
  await until(() => !h.button.disabled);
  assert.equal(h.workspace.disabled, false); assert.equal(h.month.disabled, false);
  assert.equal(h.button.textContent, 'Inspect governed usage');
  h.details.open = false; h.details.open = true;
  assert.equal(h.usageCalls().length, 1);
});

test('invalid selections and non-admin users never request the ledger', async t => {
  const h = await harness(t); await h.openFleet();
  for (const month of ['', '2026-13', 'bad']) {
    h.month.value = month; h.button.click();
    assert.match(h.result.textContent, /Select a workspace and valid UTC month/);
  }
  h.month.value = '2026-10'; h.workspace.value = ''; h.button.click();
  assert.equal(h.usageCalls().length, 0);
  const restricted = await harness(t, { launchAdmin: false });
  const option = restricted.document.createElement('option'); option.value = 'packsmart-solutions'; restricted.workspace.append(option);
  restricted.month.value = '2026-10'; restricted.button.click();
  assert.equal(restricted.usageCalls().length, 0);
  assert.equal(restricted.document.querySelector('#operator-fleet-nav').classList.contains('hidden'), true);
});

test('scope labels, accounting values, availability reasons, and request errors are inert text', async t => {
  const h = await harness(t); await h.openFleet();
  const malicious = '<img src=x onerror="window.usageInjected=true">';
  h.usageHandler = async () => Response.json({ available: true, admissionMonth: malicious, scopes: [{ scopeKey: malicious, settled: { requests: malicious, totalTokens: malicious }, held: { requests: malicious, totalTokens: malicious } }] });
  await h.inspect();
  assert.ok(h.result.textContent.includes(malicious));
  assert.equal(h.result.querySelector('img,script,[onerror]'), null);
  assert.equal(h.window.usageInjected, undefined);
  h.usageHandler = async () => Response.json({ available: false, reason: malicious });
  await h.inspect();
  assert.equal(h.result.querySelector('img,script,[onerror]'), null);
  h.usageHandler = async () => Response.json({ error: malicious }, { status: 503 });
  await h.inspect();
  assert.match(h.result.textContent, /Could not read governed accounting/);
  assert.ok(h.result.textContent.includes(malicious));
  assert.equal(h.result.querySelector('img,script,[onerror]'), null);
  assert.equal(h.window.usageInjected, undefined);
  assert.equal(h.workspace.disabled, false); assert.equal(h.month.disabled, false);
  h.usageHandler = async () => Response.json(fixtures);
  await h.inspect(); assert.match(h.result.textContent, /provider:openai/);
});

test('a stale successful or failed ledger response cannot repopulate a refreshed session snapshot', async t => {
  const h = await harness(t); await h.openFleet();
  for (const [index, response] of [Response.json(fixtures), Response.json({ error: 'OLD-SNAPSHOT-ERROR' }, { status: 503 })].entries()) {
    const pending = deferred(); h.usageHandler = () => pending.promise;
    h.button.click(); assert.equal(h.button.disabled, true);
    if (index) h.bootstrap.csrf = `new-csrf-${h.usageCalls().length}`; // First refresh tests the generation guard with unchanged CSRF.
    await h.controls.reload({ migrate: false });
    assert.equal(h.result.textContent, '');
    pending.resolve(response);
    await until(() => !h.button.disabled);
    assert.equal(h.result.textContent, '', 'late response cannot restore a previous session result');
    assert.equal(h.workspace.disabled, false); assert.equal(h.month.disabled, false);
  }
});

test('a late unauthorized ledger response after logout and login cannot end the newer session', async t => {
  const h = await harness(t); await h.openFleet();
  const pending = deferred(); h.usageHandler = () => pending.promise;
  h.button.click();
  h.document.querySelector('#logout').click();
  await until(() => !h.document.querySelector('#login-screen').classList.contains('hidden'));
  h.bootstrap.csrf = 'synthetic-new-login-csrf';
  const form = h.document.querySelector('#login-form');
  Object.defineProperty(form, 'email', { value: form.elements.email });
  Object.defineProperty(form, 'password', { value: form.elements.password });
  form.email.value = 'usage-admin@example.test'; form.password.value = 'fixture-not-a-real-password';
  form.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !h.document.querySelector('#app-shell').classList.contains('hidden'));
  assert.equal(h.result.textContent, '');
  pending.resolve(Response.json({ error: 'Old session expired', code: 'AUTH_REQUIRED' }, { status: 401 }));
  await until(() => !h.button.disabled);
  assert.equal(h.document.querySelector('#app-shell').classList.contains('hidden'), false);
  assert.equal(h.document.querySelector('#login-screen').classList.contains('hidden'), true);
  assert.equal(h.result.textContent, '');
});
