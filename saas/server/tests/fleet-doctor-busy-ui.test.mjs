// Actual Fleet HTML, renderer, and retry callback; synthetic local data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';

const fleetPath = '/api/operator/agent-ops';
const busyCode = 'CONNECTION_CHECK_BUSY';
const explanation = "Connection check needs review: another run may still be active, or an earlier run's completion is uncertain. Review connection activity before retrying.";
const doctorJob = (changes = {}) => ({ id: 'busy-doctor', type: 'connection_doctor', provider: 'shopify', status: 'blocked', attempts: 1, maxAttempts: 5, errorCode: busyCode, ...changes });
function fleetFixture(jobs = [doctorJob()]) {
  return {
    workspaces: [{ workspaceId: 'tenant-review', name: 'Synthetic review workspace', jobs, counts: { blocked: 1 } }],
    totals: { workspaces: 1, blocked: 1 }, worker: { lastTickAt: '2026-10-10T12:00:00.000Z' }, modelCatalog: []
  };
}
async function until(condition) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Synthetic Fleet UI did not reach the expected state');
}
async function harness(t, fleet = fleetFixture(), { launchAdmin = true, role = 'owner' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-fleet-doctor-ui-'));
  const secret = randomBytes(32).toString('hex');
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
    PACKSMART_ADMIN_EMAIL: 'fleet-admin@example.test', SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' });
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const state = seedWorkspaceState({}, { workspaceId: 'packsmart-solutions', name: 'Synthetic Fleet owner', email: 'fleet-admin@example.test', passwordHash: 'fixture-only' });
  state.products = [];
  await server.packsmart.store.save(state.workspace.id, state);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  const response = await fetch(base + '/api/bootstrap', { headers: { Cookie: `packsmart_session=${token}` } });
  assert.equal(response.status, 200);
  const bootstrap = await response.json(); bootstrap.launchAdmin = launchAdmin; bootstrap.user.role = role;
  await new Promise(resolve => server.close(resolve));
  const errors = [], calls = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8'), { url: base, runScripts: 'outside-only', virtualConsole, pretendToBeVisual: true });
  t.after(() => { dom.window.close(); assert.deepEqual(errors, []); });
  const { window } = dom, document = window.document;
  const h = { window, document, bootstrap, fleet, calls, retryHandler: async () => Response.json({ ok: true }) };
  window.Headers = Headers; window.AbortController = AbortController; window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.localStorage.setItem('packsmart-saas-cloud-migration-v3:packsmart-solutions', 'fixture-complete');
  window.RunvaraControl = { init() {}, render() {}, evidence() { return ''; }, history() { return ''; } };
  window.fetch = async (route, options = {}) => {
    calls.push({ route: String(route), method: options.method || 'GET', body: options.body,
      csrf: new Headers(options.headers).get('X-CSRF-Token'), credentials: options.credentials, cache: options.cache });
    if (route === '/api/auth/session') return Response.json({ user: bootstrap.user, workspace: bootstrap.workspace, csrf: bootstrap.csrf });
    if (route === '/api/bootstrap') return Response.json(bootstrap);
    if (route === fleetPath) return Response.json(h.fleet);
    if (String(route).startsWith(fleetPath + '/workspaces/') && String(route).endsWith('/retry')) return h.retryHandler(route, options);
    if (route === '/api/auth/signup-options') return Response.json({ enabled: false });
    throw new Error(`Unexpected request in Fleet Doctor fixture: ${route}`);
  };
  for (const file of ['presentation.js', 'app.js']) window.eval(await fs.readFile(new URL(`../../${file}`, import.meta.url), 'utf8'));
  await until(() => !document.querySelector('#app-shell').classList.contains('hidden'));
  h.open = async () => {
    document.querySelector('#operator-fleet-nav').click();
    await until(() => document.querySelector('#fleet-kpis').children.length === 6);
  };
  h.row = id => [...document.querySelectorAll('[data-fleet-retry]')].find(button => button.dataset.fleetRetry === id)?.closest('.fleet-job');
  h.retryCalls = () => calls.filter(call => call.method === 'POST');
  return h;
}

test('blocked busy Doctor shows bounded review wording without payloads, unsafe HTML, or automatic retry', async t => {
  const privateText = 'SYNTHETIC_PRIVATE_PAYLOAD_<img src=x onerror="window.injected=true">';
  const h = await harness(t, fleetFixture([doctorJob({ payload: { command: privateText }, result: { detail: privateText }, error: privateText, errorMessage: privateText })]));
  assert.equal(h.calls.some(call => call.route === fleetPath), false, 'startup does not load Fleet');
  await h.open();
  const row = h.row('busy-doctor'), button = row.querySelector('button');
  assert.equal(row.querySelector('.bad-text').textContent, explanation);
  assert.match(row.textContent, /Connection Doctor.*Shopify · Blocked · attempt 1\/5/);
  assert.doesNotMatch(row.textContent, /CONNECTION_CHECK_BUSY|provider failed|repair completed|repaired|safely/i);
  assert.equal(button.tagName, 'BUTTON', 'retry retains the native accessible button role');
  assert.equal(button.textContent, 'Retry check');
  assert.equal(button.disabled, false);
  assert.equal(button.dataset.workspace, 'tenant-review');
  assert.equal(h.document.querySelector('#view-fleet').innerHTML.includes('SYNTHETIC_PRIVATE_PAYLOAD'), false);
  assert.equal(row.querySelector('img,script,[onerror]'), null);
  assert.equal(h.window.injected, undefined);
  const before = h.calls.length, details = row.closest('details');
  details.open = true; details.open = false; details.open = true;
  const search = h.document.querySelector('#fleet-search');
  search.value = 'Synthetic'; search.dispatchEvent(new h.window.Event('input', { bubbles: true }));
  assert.equal(h.calls.length, before, 'disclosure and filtering add no requests');
  assert.equal(h.retryCalls().length, 0, 'rendering never queues a retry');
  assert.equal(h.document.querySelector('#fleet-worker-status').textContent, 'Worker healthy');
});

test('healthy, policy-held, successful, failed, and unrelated queue cases keep their existing presentation', async t => {
  const hostileCode = '<img src=x onerror="window.injected=true">CONNECTION_CHECK_BUSY';
  const jobs = [
    doctorJob({ id: 'policy-held', errorCode: 'SHOPIFY_ORDER_READ_HELD' }),
    doctorJob({ id: 'provider-failed', status: 'dead_letter', errorCode: 'UPSTREAM_REQUEST_FAILED' }),
    doctorJob({ id: 'other-type', type: 'connection_sync' }),
    doctorJob({ id: 'different-status', status: 'dead_letter' }),
    doctorJob({ id: 'near-match', errorCode: busyCode + ' ' }),
    doctorJob({ id: 'hostile-code', errorCode: hostileCode }),
    doctorJob({ id: 'healthy-running', status: 'running', errorCode: null }),
    doctorJob({ id: 'healthy-queued', status: 'queued', errorCode: null }),
    doctorJob({ id: 'successful', status: 'succeeded', errorCode: null }),
    doctorJob({ id: 'hidden-failed', status: 'failed', errorCode: 'FAILED_NOT_SHOWN' })
  ];
  const fleet = fleetFixture(jobs);
  fleet.workspaces.push({ workspaceId: 'healthy-workspace', name: 'Healthy workspace', jobs: [], counts: {} });
  const h = await harness(t, fleet); await h.open();
  for (const job of jobs.slice(0, 6)) {
    const row = h.row(job.id);
    assert.equal(row.querySelector('.bad-text').textContent, job.errorCode, job.id);
    assert.equal(row.querySelector('button').textContent, 'Retry safely', job.id);
    assert.equal(row.querySelector('[data-fleet-check-busy]'), null, job.id);
  }
  const rows = [...h.document.querySelectorAll('.fleet-job')];
  assert.equal(rows.length, 8, 'succeeded and failed retain the existing hidden behavior');
  assert.equal(rows[6].querySelector('button,.bad-text'), null);
  assert.match(rows[6].textContent, /Running/);
  assert.equal(rows[7].querySelector('button,.bad-text'), null);
  assert.match(rows[7].textContent, /Queued/);
  assert.equal(h.document.querySelector('[data-fleet-workspace="healthy-workspace"] .tag').textContent, 'Healthy');
  assert.equal(h.document.querySelector('[data-fleet-workspace="healthy-workspace"] .empty-state').textContent, 'No active or failed jobs.');
  assert.equal(h.document.querySelector('#fleet-workspaces img, #fleet-workspaces [onerror]'), null);
  assert.equal(h.window.injected, undefined);
  assert.equal(h.retryCalls().length, 0);
  const retry = h.row('policy-held').querySelector('button');
  retry.click();
  await until(() => !retry.disabled && h.document.querySelector('#global-success').textContent === 'Job returned to the safe queue.');
  assert.equal(h.retryCalls().length, 1, 'the unrelated retry acknowledgement also stays unchanged');
});

test('Retry check uses the existing scoped CSRF request and refresh callback with a neutral queue acknowledgement', async t => {
  const workspaceId = 'tenant/"?review', jobId = 'doctor/"?busy';
  const fleet = fleetFixture([doctorJob({ id: jobId })]); fleet.workspaces[0].workspaceId = workspaceId;
  fleet.workspaces.push({ workspaceId: 'other-tenant', name: 'Other tenant', jobs: [doctorJob({ id: 'other-job' })] });
  const h = await harness(t, fleet); await h.open();
  let finish;
  h.retryHandler = () => new Promise(resolve => { finish = resolve; });
  const button = h.row(jobId).querySelector('button'), location = h.window.location.href, historyLength = h.window.history.length;
  const beforeRetry = h.calls.length;
  button.click(); button.click();
  await until(() => Boolean(finish));
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Queueing…');
  assert.deepEqual(h.retryCalls(), [{ route: fleetPath + '/workspaces/' + encodeURIComponent(workspaceId) + '/jobs/' + encodeURIComponent(jobId) + '/retry', method: 'POST', body: '{}',
    csrf: h.bootstrap.csrf, credentials: 'same-origin', cache: 'no-store' }]);
  assert.equal(h.calls.filter(call => call.route === fleetPath).length, 1, 'no Fleet refresh while the retry is pending');
  fleet.workspaces[0].jobs[0].status = 'queued'; fleet.workspaces[0].jobs[0].errorCode = null;
  finish(Response.json({ ok: true }));
  await until(() => !button.disabled && h.document.querySelector('#global-success').textContent === 'Check returned to the queue.');
  assert.equal(h.document.querySelector('#global-success').getAttribute('role'), 'status');
  assert.equal(h.calls.filter(call => call.route === fleetPath).length, 2, 'the existing callback refreshes once');
  assert.equal(h.row(jobId), undefined, 'the queued job no longer has a retry button');
  assert.equal(h.row('other-job').querySelector('button').textContent, 'Retry check', 'other workspace remains blocked');
  assert.equal(h.retryCalls().length, 1, 'repeated click while disabled does not duplicate the request');
  assert.deepEqual(h.calls.slice(beforeRetry).map(({ route, method }) => ({ route, method })), [
    { route: fleetPath + '/workspaces/' + encodeURIComponent(workspaceId) + '/jobs/' + encodeURIComponent(jobId) + '/retry', method: 'POST' },
    { route: fleetPath, method: 'GET' }
  ], 'this callback only retries the selected existing job and reloads Fleet; it adds no repair, sync, or write endpoint');
  assert.equal(h.document.querySelector('.view.active').id, 'view-fleet');
  assert.equal(h.window.location.href, location);
  assert.equal(h.window.history.length, historyLength);
});

test('retry denial and expired-session responses retain the existing handler and restore Retry check', async t => {
  const h = await harness(t); await h.open();
  const button = h.row('busy-doctor').querySelector('button');
  h.retryHandler = async () => Response.json({ error: 'Synthetic owner permission required.', code: 'FORBIDDEN' }, { status: 403 });
  button.click();
  await until(() => !button.disabled);
  assert.equal(h.document.querySelector('#global-error').textContent, 'Synthetic owner permission required.');
  assert.equal(button.textContent, 'Retry check');
  assert.equal(h.row('busy-doctor').querySelector('.bad-text').textContent, explanation);
  assert.equal(h.calls.filter(call => call.route === fleetPath).length, 1, 'denial does not refresh or report queue success');
  h.retryHandler = async () => Response.json({ error: 'Synthetic expired session.', code: 'AUTH_REQUIRED' }, { status: 401 });
  button.click();
  await until(() => !button.disabled && !h.document.querySelector('#login-screen').classList.contains('hidden'));
  assert.equal(h.document.querySelector('#app-shell').classList.contains('hidden'), true);
  assert.equal(h.document.querySelector('#global-error').textContent, 'Your Runvara session has expired. Sign in again to continue.');
  assert.equal(button.textContent, 'Retry check');
  assert.equal(h.retryCalls().length, 2);
  assert.equal(h.calls.filter(call => call.route === fleetPath).length, 1);
});

test('non-operator roles cannot expose the busy Doctor control through Fleet navigation', async t => {
  for (const role of ['owner', 'admin', 'viewer']) await t.test(role, async subtest => {
    const h = await harness(subtest, fleetFixture(), { launchAdmin: false, role });
    const nav = h.document.querySelector('#operator-fleet-nav');
    assert.equal(nav.classList.contains('hidden'), true);
    nav.click();
    assert.equal(h.calls.some(call => call.route.startsWith('/api/operator/')), false);
    assert.equal(h.document.querySelector('[data-fleet-retry]'), null);
    assert.equal(h.document.querySelector('.view.active').id, 'view-overview');
  });
});
