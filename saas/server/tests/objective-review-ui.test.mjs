// Real app HTML/JS with synthetic server snapshots and deterministic poll clocks.
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
import { upsertBusinessObjective, businessObjectivesSnapshot } from '../lib/business-objectives.mjs';
import { buildObjectiveReview } from '../lib/objective-review.mjs';

const BASE = '/api/business-objectives/reviews';
const NOW = '2026-10-06T18:00:00.000Z';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
async function until(condition, detail = () => '') {
  for (let i = 0; i < 200; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`Review UI did not settle: ${detail()}`);
}
async function harness(t, { role = 'owner' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-review-ui-'));
  const secret = 'objective-review-ui-test-only-more-than-thirty-two-characters';
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret, SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' });
  const state = seedWorkspaceState({}, { workspaceId: 'review-ui', name: 'Synthetic review tenant', email: 'review@example.test', passwordHash: 'fixture-only' });
  state.settings = { ...state.settings, currency: 'GBP', growthCapacityHours: 4, maxConcurrentGrowthExperiments: 2 };
  state.products = []; state.approvals = []; state.exceptions = []; state.decisions = [];
  state.opportunities = [{ id: 'opportunity_ui', kind: 'pricing', present: true, status: 'open', title: 'Synthetic margin opportunity', executionCost: 0, effortHours: 1, confidence: 0.9, risk: 'low', requiredAction: 'major_price_change', evidence: [], recommendedNextStep: 'Inspect existing economics' }];
  const objective = upsertBusinessObjective(state, { title: 'Improve recorded contribution', metric: 'contribution_profit', baseline: null, target: 100, direction: 'increase', startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2027-10-31T00:00:00.000Z', limits: { currency: 'GBP', minGrossMarginPercent: 10, minStockCoverDays: 5, maxMonthlyAdBudget: 0, profitFirst: true } }, { workspaceId: state.workspace.id, now: NOW });
  const report = buildObjectiveReview(state, { objectiveId: objective.id, objectiveRevision: objective.revision, jobId: 'job_ui_review' }, { workspaceId: state.workspace.id, now: NOW });
  await server.packsmart.store.save(state.workspace.id, state);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  const response = await fetch(base + '/api/bootstrap', { headers: { Cookie: `packsmart_session=${token}` } });
  assert.equal(response.status, 200);
  const bootstrap = await response.json(); bootstrap.user.role = role; bootstrap.opportunities = state.opportunities;
  await new Promise(resolve => server.close(resolve));
  const errors = [], calls = [], timers = new Map(), delays = [], console = new VirtualConsole(); let timerId = -1;
  console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8'), { url: base, runScripts: 'outside-only', virtualConsole: console, pretendToBeVisual: true });
  t.after(async () => { await new Promise(resolve => setTimeout(resolve, 5)); dom.window.close(); await fs.rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  const w = dom.window, document = w.document;
  const h = { w, document, bootstrap, objective, report, calls, timers, delays, hidden: false, errors,
    snapshot: businessObjectivesSnapshot(state, { workspaceId: state.workspace.id, now: NOW }),
    job: { id: 'job_ui_review', type: 'objective_prepare', status: 'queued', objectiveId: objective.id, objectiveRevision: objective.revision, attempts: 0, maxAttempts: 3, createdAt: NOW, updatedAt: NOW, completedAt: null, errorCode: null, reportAvailable: false } };
  const realTimeout = w.setTimeout.bind(w), realClear = w.clearTimeout.bind(w);
  w.setTimeout = (fn, delay, ...args) => {
    if (![2000,4000,8000,10000].includes(delay)) return realTimeout(fn, delay, ...args);
    const id = timerId--; timers.set(id, () => fn(...args)); delays.push(delay); return id;
  };
  w.clearTimeout = id => { if (timers.has(id)) timers.delete(id); else realClear(id); };
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => h.hidden });
  w.Headers = Headers; w.AbortController = AbortController; w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  h.createHandler = async () => Response.json({ job: h.job, stale: false, staleReason: null });
  h.statusHandler = async () => Response.json({ job: h.job, stale: false, staleReason: null });
  h.reportHandler = async () => Response.json({ job: h.job, stale: false, staleReason: null, report: h.report });
  w.fetch = async (route, options = {}) => {
    calls.push({ route: String(route), method: options.method || 'GET', body: options.body, signal: options.signal });
    if (route === BASE && options.method === 'POST') return h.createHandler(route, options);
    if (String(route).startsWith(BASE + '/')) return String(route).endsWith('?report=true') ? h.reportHandler(route, options) : h.statusHandler(route, options);
    if (route === '/api/business-objectives') return Response.json(h.snapshot);
    if (route === '/api/auth/session' || route === '/api/auth/login') return Response.json({ user: h.bootstrap.user, workspace: h.bootstrap.workspace, csrf: h.bootstrap.csrf });
    if (route === '/api/bootstrap') return Response.json(h.bootstrap);
    if (route === '/api/auth/logout') return Response.json({ ok: true });
    if (route === '/api/auth/signup-options') return Response.json({ enabled: false });
    throw new Error(`Unexpected synthetic route: ${route}`);
  };
  for (const file of ['presentation.js', 'control-ui.js']) w.eval(await fs.readFile(new URL(`../../${file}`, import.meta.url), 'utf8'));
  const init = w.RunvaraControl.init; w.RunvaraControl.init = api => { h.controls = api; init(api); };
  w.eval(await fs.readFile(new URL('../../app.js', import.meta.url), 'utf8'));
  await until(() => !document.querySelector('#app-shell').classList.contains('hidden'), () => document.querySelector('#startup-error').textContent);
  h.panel = document.querySelector('#business-objective-review'); h.result = document.querySelector('#business-objective-review-result'); h.status = document.querySelector('#business-objective-review-status');
  h.resume = document.querySelector('#resume-objective-review'); h.details = document.querySelector('.business-objectives-panel');
  h.reviewCalls = () => calls.filter(call => call.route.startsWith(BASE));
  h.statusCalls = () => h.reviewCalls().filter(call => call.method === 'GET' && !call.route.includes('?report=true'));
  h.reportCalls = () => h.reviewCalls().filter(call => call.route.includes('?report=true'));
  h.open = async () => {
    document.querySelector('#main-nav [data-view="ai-team"]').click(); h.details.open = true;
    document.querySelector('#load-business-objectives').click();
    await until(() => !document.querySelector('#load-business-objectives').disabled);
    h.prepare = document.querySelector('[data-prepare-objective-review]');
  };
  h.start = async () => { h.prepare.click(); await until(() => h.panel.getAttribute('aria-busy') === 'false', () => h.status.textContent); };
  h.tick = async () => {
    assert.equal(timers.size, 1, 'one polling timer only'); const [id, callback] = [...timers][0]; timers.delete(id); callback();
    await until(() => h.panel.getAttribute('aria-busy') === 'false', () => h.status.textContent);
  };
  return h;
}

test('review preparation is explicit, owner/admin-only, revision-bound, and rapid duplicate submissions coalesce', async t => {
  const h = await harness(t); assert.equal(h.reviewCalls().length, 0); await h.open();
  assert.equal(h.reviewCalls().length, 0); assert.equal(h.timers.size, 0);
  const pending = deferred(); h.createHandler = () => pending.promise;
  h.prepare.click(); h.prepare.click(); h.prepare.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  assert.equal(h.reviewCalls().length, 1); assert.equal(h.prepare.disabled, true);
  assert.deepEqual(JSON.parse(h.reviewCalls()[0].body), { objectiveId: h.objective.id, objectiveRevision: 1 });
  pending.resolve(Response.json({ job: h.job, stale: false }));
  await until(() => h.timers.size === 1);
  assert.deepEqual(h.delays, [2000]); assert.equal(h.prepare.textContent, 'View review');
  const readOnly = await harness(t, { role: 'viewer' }); await readOnly.open();
  assert.equal(readOnly.prepare, null); assert.equal(readOnly.reviewCalls().length, 0);
  const admin = await harness(t, { role: 'admin' }); await admin.open(); assert.ok(admin.prepare);
  admin.snapshot.objectives[0].effectiveStatus = 'paused'; admin.document.querySelector('#load-business-objectives').click();
  await until(() => !admin.document.querySelector('#load-business-objectives').disabled);
  assert.equal(admin.document.querySelector('[data-prepare-objective-review]'), null);
});

test('status polling backs off, makes at most eight status reads, and resumes only with an explicit click', async t => {
  const h = await harness(t); await h.open(); await h.start();
  for (let i = 0; i < 8; i++) await h.tick();
  assert.equal(h.statusCalls().length, 8); assert.equal(h.reportCalls().length, 0); assert.equal(h.timers.size, 0);
  assert.deepEqual(h.delays, [2000,4000,8000,10000,10000,10000,10000,10000]);
  assert.match(h.status.textContent, /paused after 8 requests/); assert.equal(h.resume.classList.contains('hidden'), false);
  h.details.open = false; h.details.open = true;
  assert.equal(h.statusCalls().length, 8); assert.equal(h.timers.size, 0);
  h.resume.click(); assert.equal(h.timers.size, 1); assert.equal(h.delays.at(-1), 2000);
  await h.tick(); assert.equal(h.statusCalls().length, 9);
  assert.equal(h.reviewCalls().filter(call => call.method === 'POST').length, 1);
});

test('succeeded review fetches its persisted report once and distinguishes diagnostics from blocked business proposals', async t => {
  const h = await harness(t); await h.open(); await h.start();
  h.job = { ...h.job, status: 'succeeded', reportAvailable: true, attempts: 1, completedAt: NOW };
  await h.tick();
  assert.equal(h.reportCalls().length, 1); assert.equal(h.timers.size, 0);
  assert.match(h.status.textContent, /Diagnostic completed. Commercial proposals remain blocked/);
  assert.match(h.result.textContent, /Completed with evidence gaps/);
  assert.match(h.result.textContent, /Commercial proposalsBlocked/);
  assert.match(h.result.textContent, /Evidence gaps and review blockers/);
  assert.match(h.result.textContent, /Specialist findings/);
  assert.match(h.result.textContent, /Financial source as-ofUnknown/);
  assert.match(h.result.textContent, /Measured objective progressUnknown/);
  assert.match(h.result.textContent, /not a forecast/);
  assert.equal(h.result.querySelector('[data-approval], [data-opportunity], [type="submit"]'), null);
  h.prepare.click(); assert.equal(h.reportCalls().length, 1); assert.equal(h.timers.size, 0);
  const investigate = h.result.querySelector('[data-investigate-review-opportunity]'); assert.ok(investigate);
  const calls = h.calls.length; investigate.click();
  assert.equal(h.document.querySelector('.view.active').id, 'view-opportunities');
  assert.equal(h.document.activeElement.dataset.opportunityRecord, 'opportunity_ui');
  assert.equal(h.calls.length, calls, 'investigation reuses local navigation without creating approvals or actions');
});

test('navigation, details close, and hidden-tab interruption stop checks without silently restarting', async t => {
  const h = await harness(t); await h.open(); await h.start();
  h.document.querySelector('#main-nav [data-view="overview"]').click(); assert.equal(h.timers.size, 0);
  h.document.querySelector('#main-nav [data-view="ai-team"]').click(); assert.equal(h.timers.size, 0);
  h.resume.click(); assert.equal(h.timers.size, 1);
  h.hidden = true; h.document.dispatchEvent(new h.w.Event('visibilitychange')); assert.equal(h.timers.size, 0);
  h.hidden = false; h.document.dispatchEvent(new h.w.Event('visibilitychange')); assert.equal(h.timers.size, 0);
  h.resume.click(); assert.equal(h.timers.size, 1);
  h.details.open = false; h.details.dispatchEvent(new h.w.Event('toggle')); assert.equal(h.timers.size, 0);
  h.details.open = true; h.details.dispatchEvent(new h.w.Event('toggle')); assert.equal(h.timers.size, 0);
  assert.equal(h.statusCalls().length, 0);
});

test('late status/report responses cannot cross navigation epochs, bootstrap generations, or logout', async t => {
  const h = await harness(t); await h.open(); await h.start();
  const pending = deferred(); h.statusHandler = () => pending.promise;
  const [id, callback] = [...h.timers][0]; h.timers.delete(id); callback();
  await until(() => h.statusCalls().length === 1);
  const signal = h.statusCalls()[0].signal;
  h.document.querySelector('#main-nav [data-view="overview"]').click(); assert.equal(signal.aborted, true);
  h.document.querySelector('#main-nav [data-view="ai-team"]').click();
  pending.resolve(Response.json({ job: { ...h.job, status: 'succeeded', reportAvailable: true } }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.reportCalls().length, 0); assert.equal(h.result.textContent, ''); assert.equal(h.timers.size, 0);
  h.statusHandler = async () => Response.json({ job: { ...h.job, status: 'succeeded', reportAvailable: true } });
  const delayedReport = deferred(); h.reportHandler = () => delayedReport.promise;
  h.resume.click(); const [nextId, next] = [...h.timers][0]; h.timers.delete(nextId); next();
  await until(() => h.reportCalls().length === 1);
  await h.controls.reload({ migrate: false });
  delayedReport.resolve(Response.json({ job: { ...h.job, status: 'succeeded', reportAvailable: true }, report: h.report }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.panel.classList.contains('hidden'), true); assert.equal(h.result.textContent, '');
  await h.open(); await h.start(); h.document.querySelector('#logout').click();
  await until(() => !h.document.querySelector('#login-screen').classList.contains('hidden'));
  assert.equal(h.timers.size, 0); assert.equal(h.panel.classList.contains('hidden'), true);
});

test('stale historical reports and hostile findings are displayed safely; unresolved source links are not actionable', async t => {
  const h = await harness(t); await h.open();
  const hostile = '<img src=x onerror="window.reviewInjected=true">';
  h.job = { ...h.job, status: 'succeeded', reportAvailable: true };
  h.report.evidenceGaps.push({ message: hostile }); h.report.specialists[0].findings.push({ message: hostile });
  h.report.proposals[0].title = hostile; h.report.proposals[0].opportunityId = 'foreign-or-missing';
  h.reportHandler = async () => Response.json({ job: h.job, stale: true, staleReason: hostile, report: h.report });
  await h.start();
  assert.equal(h.reportCalls().length, 1); assert.equal(h.statusCalls().length, 0);
  assert.match(h.result.textContent, /Historical review: the objective or source inputs have changed/);
  assert.ok(h.result.textContent.includes(hostile)); assert.equal(h.result.querySelector('img,script,[onerror]'), null);
  assert.equal(h.w.reviewInjected, undefined); assert.equal(h.result.querySelector('[data-investigate-review-opportunity]'), null);
});

test('terminal errors and unavailable reports stop polling, and wrong job/tenant binding is rejected', async t => {
  const h = await harness(t); await h.open();
  h.job = { ...h.job, status: 'blocked', errorCode: 'OBJECTIVE_CONFLICT' }; await h.start();
  assert.equal(h.timers.size, 0); assert.equal(h.statusCalls().length, 0); assert.match(h.status.textContent, /blocked/i);
  h.job = { ...h.job, status: 'succeeded', reportAvailable: true }; h.report.workspaceId = 'foreign-tenant';
  h.resume.click(); await h.tick();
  assert.equal(h.timers.size, 0); assert.match(h.status.textContent, /matching persisted review report is not available/);
  assert.equal(h.result.textContent, ''); assert.equal(h.reportCalls().length, 1);
  const broken = await harness(t); await broken.open();
  broken.createHandler = async () => Response.json({ job: { ...broken.job, objectiveRevision: 999 } });
  await broken.start(); assert.match(broken.status.textContent, /does not match this objective and job/);
  assert.equal(broken.timers.size, 0);
});

test('an updated review is a new explicit revision-bound request, while the old report remains historical', async t => {
  const h = await harness(t); await h.open();
  h.job = { ...h.job, status: 'succeeded', reportAvailable: true }; await h.start();
  assert.equal(h.reportCalls().length, 1);
  h.snapshot.objectives[0].revision = 2;
  h.document.querySelector('#load-business-objectives').click();
  await until(() => !h.document.querySelector('#load-business-objectives').disabled);
  assert.match(h.result.textContent, /Historical review/);
  assert.equal(h.reviewCalls().filter(call => call.method === 'POST').length, 1, 'loading newer definitions never queues a review');
  h.job = { ...h.job, id: 'job_ui_review_new', objectiveRevision: 2, status: 'queued', reportAvailable: false };
  const button = h.document.querySelector('#refresh-objective-review'); assert.equal(button.classList.contains('hidden'), false);
  button.click(); button.click();
  await until(() => h.timers.size === 1);
  const posts = h.reviewCalls().filter(call => call.method === 'POST');
  assert.equal(posts.length, 2);
  assert.deepEqual(JSON.parse(posts[1].body), { objectiveId: h.objective.id, objectiveRevision: 2 });
  assert.equal(h.result.textContent, ''); assert.equal(h.reportCalls().length, 1);
});

test('a request started before bootstrap or logout cannot render a stale job, and logout pauses immediately', async t => {
  const h = await harness(t); await h.open();
  const pendingCreate = deferred(); h.createHandler = () => pendingCreate.promise;
  h.prepare.click(); await h.controls.reload({ migrate: false });
  pendingCreate.resolve(Response.json({ job: h.job, stale: false }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.panel.classList.contains('hidden'), true); assert.equal(h.timers.size, 0);
  await h.open(); h.createHandler = async () => Response.json({ job: h.job, stale: false }); await h.start();
  const pendingLogout = deferred(), fetch = h.w.fetch;
  h.w.fetch = (route, options) => route === '/api/auth/logout' ? pendingLogout.promise : fetch(route, options);
  h.document.querySelector('#logout').click();
  assert.equal(h.timers.size, 0, 'no polling continues while logout acknowledgement is pending');
  pendingLogout.resolve(Response.json({ ok: true }));
  await until(() => !h.document.querySelector('#login-screen').classList.contains('hidden'));
  assert.equal(h.panel.classList.contains('hidden'), true);
});
