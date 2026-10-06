// Real UI with synthetic full records, valid immutable references, and no provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { automationArchivePayloadDigest, isAutomationArchiveStub } from '../lib/automation-retention.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(condition, detail = () => '') {
  for (let i = 0; i < 200; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`Automation history did not settle: ${detail()}`);
}
function fixtures(workspaceId = 'history-ui') {
  const run = { id: 'automation/archived?fixture=1', workspaceId, ruleId: 'profitGuard', status: 'COMPLETED', startedAt: '2026-10-06T12:00:00.000Z', completedAt: '2026-10-06T12:01:00.000Z', risk: 'low', spend: 0, errorCode: null,
    evidence: [{ type: 'recorded_check', id: 'source_fixture', detail: 'Archived synthetic supporting detail' }, { type: 'coverage', detail: 'The recorded source covered the selected items.' }] };
  const sha256 = automationArchivePayloadDigest(run);
  const archive = { schema: 'runvara-automation-run-archive/v1', table: 'runvara_history', workspaceId, collection: 'automationRuns', runId: run.id,
    recordId: 'automation-v1:' + createHash('sha256').update(JSON.stringify([workspaceId, run.id, sha256])).digest('hex'), sha256 };
  const stub = { id: run.id, ruleId: run.ruleId, status: run.status, startedAt: run.startedAt, completedAt: run.completedAt, risk: run.risk, spend: run.spend, errorCode: null, evidence: [], evidenceCount: run.evidence.length, archive };
  assert.equal(isAutomationArchiveStub(stub, workspaceId), true);
  const active = { ...run, id: 'automation_active', status: 'IN PROGRESS', completedAt: undefined, evidence: [{ type: 'recorded_check', detail: 'Active check supporting evidence' }] };
  const failed = { ...run, id: 'automation_failed', status: 'FAILED', errorCode: 'SYNTHETIC_FAILURE', evidence: [{ type: 'failure_context', detail: 'Failed check retained diagnostic evidence' }] };
  return { run, stub, active, failed };
}
function replaceArchivedEvidence(f, evidence) {
  f.run.evidence = evidence; f.stub.evidenceCount = evidence.length;
  const sha256 = automationArchivePayloadDigest(f.run);
  f.stub.archive.sha256 = sha256;
  f.stub.archive.recordId = 'automation-v1:' + createHash('sha256').update(JSON.stringify([f.stub.archive.workspaceId, f.run.id, sha256])).digest('hex');
  assert.equal(isAutomationArchiveStub(f.stub, f.stub.archive.workspaceId), true);
  return f;
}
async function harness(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-history-ui-'));
  const secret = 'automation-history-ui-fixture-more-than-thirty-two-characters';
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret, SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' });
  const state = seedWorkspaceState({}, { workspaceId: 'history-ui', name: 'Synthetic history tenant', email: 'history@example.test', passwordHash: 'fixture-only' });
  state.products = [];
  await server.packsmart.store.save(state.workspace.id, state);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  const response = await fetch(base + '/api/bootstrap', { headers: { Cookie: `packsmart_session=${token}` } }); assert.equal(response.status, 200);
  const bootstrap = await response.json();
  await new Promise(resolve => server.close(resolve));
  const f = fixtures(); bootstrap.automationRuns = options.runs || [f.active, f.stub, f.failed];
  if (options.ruleName) bootstrap.automationDefinitions.find(rule => rule.id === 'profitGuard').name = options.ruleName;
  const errors = [], calls = [], console = new VirtualConsole(); console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8'), { url: base, runScripts: 'outside-only', virtualConsole: console, pretendToBeVisual: true });
  t.after(async () => { await new Promise(resolve => setTimeout(resolve, 5)); dom.window.close(); await fs.rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  const w = dom.window, document = w.document, h = { ...f, w, document, bootstrap, calls, errors };
  w.Headers = Headers; w.AbortController = AbortController; w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  h.archiveHandler = async () => Response.json({ workspaceId: 'history-ui', runId: h.run.id, source: 'immutable_automation_archive', run: h.run });
  w.fetch = async (route, options = {}) => {
    calls.push({ route: String(route), method: options.method || 'GET', signal: options.signal });
    if (String(route).startsWith('/api/automation-runs/')) return h.archiveHandler(route, options);
    if (route === '/api/bootstrap') return Response.json(h.bootstrap);
    if (route === '/api/auth/session' || route === '/api/auth/login') return Response.json({ user: h.bootstrap.user, workspace: h.bootstrap.workspace, csrf: h.bootstrap.csrf });
    if (route === '/api/auth/logout') return Response.json({ ok: true });
    if (route === '/api/auth/signup-options') return Response.json({ enabled: false });
    throw new Error(`Unexpected synthetic route: ${route}`);
  };
  for (const file of ['presentation.js', 'control-ui.js']) w.eval(await fs.readFile(new URL(`../../${file}`, import.meta.url), 'utf8'));
  const init = w.RunvaraControl.init; w.RunvaraControl.init = api => { h.controls = api; init(api); };
  w.eval(await fs.readFile(new URL('../../app.js', import.meta.url), 'utf8'));
  await until(() => !document.querySelector('#app-shell').classList.contains('hidden'), () => document.querySelector('#startup-error').textContent);
  h.panel = document.querySelector('#automation-history-panel'); h.root = document.querySelector('#automation-history-list');
  h.archiveCalls = () => calls.filter(call => call.route.startsWith('/api/automation-runs/'));
  h.button = () => h.root.querySelector('[data-read-automation-archive]');
  h.open = () => { document.querySelector('#main-nav [data-view="automations"]').click(); h.panel.open = true; };
  h.read = async () => { h.button().click(); await until(() => h.root.querySelector('[aria-busy="true"]') === null, () => h.root.textContent); };
  return h;
}

test('history is collapsed and renders active/full evidence from the snapshot without fetches or financial claims', async t => {
  const h = await harness(t);
  assert.equal(h.panel.open, false); assert.equal(h.archiveCalls().length, 0);
  assert.equal(h.root.querySelectorAll('.automation-history-record').length, 3);
  const name = h.bootstrap.automationDefinitions.find(rule => rule.id === 'profitGuard').name;
  assert.equal(h.root.querySelector('h3').textContent, name); assert.doesNotMatch(h.root.textContent, /profitGuard/);
  assert.match(h.root.textContent, /In progress/); assert.match(h.root.textContent, /Failed/);
  assert.match(h.root.textContent, /Active check supporting evidence/); assert.match(h.root.textContent, /Failed check retained diagnostic evidence/);
  assert.match(h.root.textContent, /2 evidence items retained/); assert.match(h.root.textContent, /Evidence has not been loaded/);
  assert.doesNotMatch(h.root.textContent, /Archived synthetic supporting detail|revenue created|money saved|spend|£|\$/i);
  assert.equal(h.root.innerHTML.includes(h.stub.archive.sha256), false);
  assert.equal(h.root.innerHTML.includes(h.stub.archive.recordId), false);
  assert.equal(h.root.textContent.includes('runvara_history'), false);
  h.open(); h.panel.open = false; h.panel.open = true;
  h.document.querySelector('#main-nav [data-view="overview"]').click(); h.open();
  assert.equal(h.archiveCalls().length, 0); assert.equal(h.calls.every(call => call.method === 'GET'), true);
});

test('explicit archive reads use only encoded run/ref fields, coalesce, and cache verified evidence for the snapshot', async t => {
  const h = await harness(t); h.open(); const pending = deferred(); h.archiveHandler = () => pending.promise;
  const button = h.button(); button.click(); button.click(); button.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  assert.equal(h.archiveCalls().length, 1); assert.equal(h.button().disabled, true);
  assert.match(h.button().textContent, /Reading archived evidence/);
  const call = h.archiveCalls()[0], url = new URL(call.route, 'https://fixture.example');
  assert.equal(url.pathname, '/api/automation-runs/' + encodeURIComponent(h.run.id) + '/archive');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['recordId', 'sha256']);
  assert.equal(url.searchParams.get('recordId'), h.stub.archive.recordId); assert.equal(url.searchParams.get('sha256'), h.stub.archive.sha256);
  assert.equal(call.method, 'GET');
  pending.resolve(Response.json({ workspaceId: 'history-ui', runId: h.run.id, source: 'immutable_automation_archive', run: h.run }));
  await until(() => h.root.textContent.includes('Archived synthetic supporting detail'));
  assert.equal(h.button().disabled, true); assert.equal(h.button().textContent, 'Archived evidence loaded');
  h.button().dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  h.panel.open = false; h.panel.open = true; h.open();
  assert.equal(h.archiveCalls().length, 1);
  assert.equal(h.root.querySelector('[data-history-evidence="1"]').open, true);
});

test('errors do not fabricate evidence, never retry automatically, and can be retried explicitly', async t => {
  const h = await harness(t); h.open();
  h.archiveHandler = async () => Response.json({ error: h.stub.archive.recordId }, { status: 404 });
  await h.read(); assert.match(h.root.textContent, /Archived evidence is unavailable. The retained count is unchanged/);
  assert.match(h.root.textContent, /2 evidence items retained/); assert.doesNotMatch(h.root.textContent, /Archived synthetic supporting detail/);
  assert.equal(h.root.textContent.includes(h.stub.archive.recordId), false);
  assert.equal(h.button().disabled, false); assert.equal(h.archiveCalls().length, 1);
  h.panel.open = false; h.panel.open = true; assert.equal(h.archiveCalls().length, 1);
  h.archiveHandler = async () => Response.json({ workspaceId: 'history-ui', runId: h.run.id, source: 'immutable_automation_archive', run: h.run });
  await h.read(); assert.equal(h.archiveCalls().length, 2); assert.match(h.root.textContent, /Archived synthetic supporting detail/);
});

test('archive payloads must match tenant, run, immutable source, rule, timing, and the real evidence count', async t => {
  const h = await harness(t); h.open();
  const valid = () => ({ workspaceId: 'history-ui', runId: h.run.id, source: 'immutable_automation_archive', run: structuredClone(h.run) });
  const changes = [
    payload => { payload.workspaceId = 'foreign'; }, payload => { payload.runId = 'other-run'; }, payload => { payload.source = 'unverified'; },
    payload => { payload.run.workspaceId = 'foreign'; }, payload => { payload.run.id = 'other-run'; }, payload => { payload.run.ruleId = 'other-rule'; },
    payload => { payload.run.startedAt = '2026-10-05T12:00:00.000Z'; }, payload => { payload.run.evidence = []; },
    payload => { payload.run.status = 'IN PROGRESS'; }, payload => { payload.run.archive = h.stub.archive; }, payload => { payload.run = null; }
  ];
  for (const change of changes) {
    const payload = valid(); change(payload); h.archiveHandler = async () => Response.json(payload);
    await h.read(); assert.match(h.root.textContent, /Could not read archived evidence/);
    assert.doesNotMatch(h.root.textContent, /Archived synthetic supporting detail/); assert.equal(h.button().disabled, false);
  }
  assert.equal(h.archiveCalls().length, changes.length);
});

test('malformed or foreign stubs are not dereferenced and a retained count never becomes fake evidence', async t => {
  const f = fixtures();
  const malformed = { ...f.stub, id: 'bad-ref', archive: { ...f.stub.archive, runId: 'wrong-run' }, evidenceCount: 999 };
  const foreign = { ...f.stub, id: 'foreign', archive: { ...f.stub.archive, workspaceId: 'another-tenant' } };
  const foreignFull = { ...f.active, tenant_id: 'another-tenant', evidence: [{ detail: 'FOREIGN PRIVATE CONTENT' }] };
  const h = await harness(t, { runs: [malformed, foreign, foreignFull] }); h.open();
  assert.equal(h.button(), null); assert.match(h.root.textContent, /reference could not be verified/);
  assert.doesNotMatch(h.root.textContent, /999|FOREIGN PRIVATE CONTENT/);
  assert.equal(h.archiveCalls().length, 0);
});

test('all stored labels and full/archived evidence remain inert text', async t => {
  const hostile = '<img src=x onerror="window.historyInjected=true">';
  const f = replaceArchivedEvidence(fixtures(), [{ type: hostile, id: hostile, detail: hostile }, { detail: hostile }]); f.active.evidence = [{ type: hostile, id: hostile, detail: hostile }];
  const h = await harness(t, { ruleName: hostile, runs: [f.active, f.stub] }); h.run = f.run; h.stub = f.stub; h.open();
  await h.read();
  assert.ok(h.root.textContent.includes(hostile)); assert.equal(h.root.querySelector('img,script,[onerror]'), null);
  assert.equal(h.w.historyInjected, undefined); assert.equal(h.root.textContent.includes(h.stub.archive.sha256), false);
});

test('late archive results are discarded across bootstrap/session boundaries and successful caches expire on reload', async t => {
  const h = await harness(t); h.open(); const pending = deferred(); h.archiveHandler = () => pending.promise;
  h.button().click(); const signal = h.archiveCalls()[0].signal;
  await h.controls.reload({ migrate: false }); assert.equal(signal.aborted, true);
  pending.resolve(Response.json({ workspaceId: 'history-ui', runId: h.run.id, source: 'immutable_automation_archive', run: h.run }));
  await new Promise(resolve => setTimeout(resolve, 10)); assert.doesNotMatch(h.root.textContent, /Archived synthetic supporting detail/);
  h.archiveHandler = async () => Response.json({ workspaceId: 'history-ui', runId: h.run.id, source: 'immutable_automation_archive', run: h.run });
  await h.read(); assert.match(h.root.textContent, /Archived synthetic supporting detail/);
  await h.controls.reload({ migrate: false }); assert.doesNotMatch(h.root.textContent, /Archived synthetic supporting detail/);
  assert.equal(h.button().disabled, false); assert.equal(h.archiveCalls().length, 2);
  const old = deferred(); h.archiveHandler = () => old.promise; h.button().click();
  h.document.querySelector('#logout').click(); assert.equal(h.archiveCalls().at(-1).signal.aborted, true);
  await until(() => !h.document.querySelector('#login-screen').classList.contains('hidden'));
  old.resolve(Response.json({ workspaceId: 'history-ui', runId: h.run.id, source: 'immutable_automation_archive', run: h.run }));
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(h.root.textContent, '');
});

test('the panel is bounded to the at-most-100 recent snapshot rows', async t => {
  const f = fixtures(); const runs = Array.from({ length: 110 }, (_, i) => ({ ...f.active, id: 'active-' + i, ruleId: i === 0 ? 'unknown-rule-id' : 'profitGuard' }));
  const h = await harness(t, { runs });
  assert.equal(h.root.querySelectorAll('.automation-history-record').length, 100);
  assert.equal(h.root.querySelector('h3').textContent, 'Recorded check'); assert.doesNotMatch(h.root.textContent, /unknown-rule-id/);
  assert.equal(h.archiveCalls().length, 0);
});

test('an explicit zero-evidence archive stays distinct from an unavailable or unread archive', async t => {
  const f = replaceArchivedEvidence(fixtures(), []);
  const h = await harness(t, { runs: [f.stub] }); h.run = f.run; h.stub = f.stub; h.open();
  assert.match(h.root.textContent, /0 evidence items retained/); assert.match(h.root.textContent, /Evidence has not been loaded/);
  assert.equal(h.root.querySelector('.automation-history-evidence'), null, 'the retained count is not a replacement evidence array');
  await h.read(); assert.match(h.root.textContent, /No supporting evidence was recorded/);
  assert.equal(h.root.querySelector('.automation-history-evidence summary').textContent, 'Recorded evidence (0)');
});

test('a late archive 401 cannot replace a newer authenticated session or its history', async t => {
  const h = await harness(t); h.open(); const pending = deferred(); h.archiveHandler = () => pending.promise; h.button().click();
  h.document.querySelector('#logout').click();
  await until(() => !h.document.querySelector('#login-screen').classList.contains('hidden'));
  h.bootstrap.csrf = 'synthetic-new-history-session';
  const form = h.document.querySelector('#login-form');
  Object.defineProperty(form, 'email', { value: form.elements.email }); Object.defineProperty(form, 'password', { value: form.elements.password });
  form.email.value = 'history@example.test'; form.password.value = 'synthetic-fixture-only';
  form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => !h.document.querySelector('#app-shell').classList.contains('hidden'));
  pending.resolve(Response.json({ code: 'AUTH_REQUIRED', error: 'Old session only' }, { status: 401 }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.document.querySelector('#app-shell').classList.contains('hidden'), false);
  assert.equal(h.document.querySelector('#login-screen').classList.contains('hidden'), true);
  assert.match(h.root.textContent, /Evidence has not been loaded/); assert.doesNotMatch(h.root.textContent, /Old session only|Archived synthetic supporting detail/);
});

test('compact many-item archives retain their full count but render at most 100 evidence entries', async t => {
  const f = replaceArchivedEvidence(fixtures(), Array(200000).fill(null));
  assert.ok(Buffer.byteLength(JSON.stringify(f.run)) < 2 * 1024 * 1024, 'a small valid archive can contain many individual items');
  const h = await harness(t, { runs: [f.stub] }); h.run = f.run; h.stub = f.stub; h.open();
  await h.read();
  const evidence = h.root.querySelector('.automation-history-evidence');
  assert.equal(evidence.querySelector('summary').textContent, 'Recorded evidence (200000)');
  assert.match(evidence.textContent, /Showing 100 of 200000 recorded evidence items/);
  assert.match(evidence.textContent, /199900 additional items remain in the retained record/);
  assert.equal(evidence.querySelectorAll(':scope > p:not(.muted)').length, 100);
  assert.ok(h.root.querySelectorAll('*').length < 125, 'DOM size is independent of the complete evidence array length');
  assert.equal(h.run.evidence.length, 200000, 'display limits do not alter the retained full archive');
});

test('evidence text is bounded and malformed object fields are never coerced into markup or executable accessors', async t => {
  const long = 'x'.repeat(50000), malformed = { toString: 'not a function', valueOf: 'not a function' };
  const f = replaceArchivedEvidence(fixtures(), [
    { type: long, id: long, detail: long, at: malformed },
    { type: malformed, id: malformed, detail: malformed, message: malformed, at: malformed },
    null, [], true, 123, long
  ]);
  const h = await harness(t, { runs: [f.stub] }); h.run = f.run; h.stub = f.stub; h.open(); await h.read();
  const evidence = h.root.querySelector('.automation-history-evidence');
  assert.match(evidence.textContent, /text shortened/); assert.match(evidence.textContent, /No readable description recorded/);
  assert.ok(evidence.textContent.length < 6000, 'each detail/string is capped at 2000 characters, type at 80, and ID at 160');
  assert.equal(evidence.querySelector('script,img,[onerror]'), null); assert.equal(h.run.evidence[0].detail.length, 50000);
});
