import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { prepareExperimentOutcomeMeasurement, assessExperimentOutcomeMeasurement } from '../lib/experiment-measurements.mjs';
import { createBusinessOutcomeCandidate } from '../lib/business-outcomes.mjs';
const html = await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8');
const script = await fs.readFile(new URL('../../outcomes-ui.js', import.meta.url), 'utf8');
const now = '2026-10-06T20:00:00.000Z', workspaceId = 'outcomes-ui', experimentId = 'experiment_one';
const input = { expectedRevision: 0, amount: '999999999999999999.999999', currency: 'GBP', window: { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' }, coverage: { status: 'complete', observedCount: 2, expectedCount: 2 }, method: { kind: 'reconciled_manual' }, observedAt: '2026-10-06T12:00:00.000Z', report: { description: '<img src=x onerror="window.injected=true"> Measured retained facts.', costsComplete: true } };
const measurement = (body = input, previousMeasurement = null) => prepareExperimentOutcomeMeasurement(body, { workspaceId, experimentId, actorId: 'owner_one', now, previousMeasurement });
const assessment = m => assessExperimentOutcomeMeasurement(m, { workspaceId, experimentId, now });
function publication(m, publicationId = 'publication_one') {
  const version = createBusinessOutcomeCandidate({ source: { type: 'experiment_measurement', experimentId, measurementRevision: m.revision, measurementDigest: m.digest }, metric: m.metric, amount: m.amount, currency: m.currency, window: m.window, coverage: m.coverage, method: m.method, provenance: m.provenance, links: m.links, verification: { kind: 'owner_attestation', actorId: 'owner_one', verifiedAt: now, measurementDigest: m.digest } }, { workspaceId, now });
  return { version, head: { workspaceId, versionId: version.versionId, digest: version.digest, status: 'published', publicationId } };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(fn) { for (let n = 0; n < 200; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail('UI did not settle'); }
async function harness(t, options = {}) {
  const errors = [], virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, { url: 'https://runvara.example.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window, d = w.document; w.AbortController = AbortController; w.HTMLElement.prototype.scrollIntoView = () => {};
  t.after(() => { dom.window.close(); assert.deepEqual(errors, []); });
  const h = { w, d, calls: [], context: { workspaceId, userId: 'owner_one', role: options.role || 'owner', session: {}, view: 'revenue-engine', experiments: [{ id: experimentId, title: 'Recorded experiment' }] } };
  h.m = options.measurement || measurement(); h.p = options.publication || null;
  h.detail = () => ({ workspaceId, workspaceRevision: 'revision_one', experiment: { id: experimentId, title: 'Recorded experiment', status: 'measured' }, measurement: h.m, assessment: assessment(h.m), currentPublication: h.p });
  h.summary = { workspaceId, current: options.current || [], summary: { groups: options.groups || [], coverage: { complete: true }, exclusions: [] } };
  h.handler = async (path, config) => {
    if (path === '/api/business-outcomes') return structuredClone(h.summary);
    if (path.endsWith('/measurement')) { const body = JSON.parse(config.body); h.m = measurement(body, h.m); return { workspaceId, workspaceRevision: 'revision_two', measurement: h.m, assessment: assessment(h.m) }; }
    if (path === '/api/business-outcomes/publish') { const body = JSON.parse(config.body); h.p = publication(h.m, body.publicationId); return { publication: h.p, replayed: false, isCurrent: true }; }
    if (path.includes('/versions/')) return { publication: h.p, sourceMeasurement: h.m, currentStatus: 'not_checked', source: 'immutable_business_outcome_version' };
    return structuredClone(h.detail());
  };
  w.eval(script); w.RunvaraOutcomes.init({ getContext: () => h.context, request: (path, config = {}) => { h.calls.push({ path, ...config }); return h.handler(path, config); } });
  h.$ = id => d.getElementById(id); h.panel = h.$('business-outcomes-panel'); h.form = h.$('business-outcomes-form');
  h.open = async () => { h.panel.open = true; await until(() => h.calls.some(c => c.path === '/api/business-outcomes')); await until(() => !h.$('business-outcomes-refresh').disabled); };
  h.load = async () => { h.$('business-outcomes-experiment').value = experimentId; h.$('business-outcomes-load').click(); await until(() => h.$('business-outcomes-detail').textContent.includes('Recorded experiment')); };
  h.submit = () => h.form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  h.review = action => d.querySelector(`[data-outcome-action="${action}"]`).click();
  h.confirm = () => { h.$('business-outcomes-attest').checked = true; h.$('business-outcomes-attest').dispatchEvent(new w.Event('change', { bubbles: true })); h.$('business-outcomes-confirm').click(); };
  h.writes = () => h.calls.filter(c => c.method === 'PUT' || c.method === 'POST');
  return h;
}

test('panel is collapsed and has no background requests; reads never bootstrap and repeated clicks coalesce', async t => {
  const h = await harness(t); assert.equal(h.panel.open, false); assert.equal(h.calls.length, 0);
  await h.open(); const before = h.calls.length, hold = deferred(), original = h.handler; h.handler = (p,c) => p.includes('/experiments/') ? hold.promise : original(p,c);
  h.$('business-outcomes-experiment').value = experimentId;
  const b = h.$('business-outcomes-load'); b.click(); b.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true })); b.click();
  assert.equal(h.calls.length, before + 1); hold.resolve(h.detail()); await until(() => !b.disabled);
  h.panel.open = false; await new Promise(r => setTimeout(r, 10)); h.panel.open = true; await new Promise(r => setTimeout(r, 10));
  assert.equal(h.calls.length, before + 1); assert.equal(h.writes().length, 0); assert.equal(h.calls.some(c => c.path.includes('bootstrap')), false);
});

test('exact decimals, zero, negative and unknown values remain distinct with explicit currency/window and escaped report', async t => {
  const h = await harness(t); await h.open(); await h.load();
  const root = h.$('business-outcomes-detail'); assert.match(root.textContent, /999999999999999999\.999999 GBP/); assert.match(root.textContent, /UTC, end exclusive/);
  assert.equal(root.querySelector('img'), null); assert.match(root.textContent, /<img/);
  for (const value of ['0', '-0.000001', null]) {
    h.m = measurement({ ...input, amount: value }); await h.load(); assert.match(root.textContent, new RegExp((value ?? 'Unknown').replace('.', '\\.')));
  }
  assert.equal(h.w.injected, undefined);
});

test('draft writes preserve unknown costs and zero counts without defaulting currency, amount or dates', async t => {
  const h = await harness(t); await h.open(); await h.load();
  for (const n of ['amount','currency','startsAt','endsAt','observedAt']) h.form.elements[n].value = '';
  h.form.elements.coverageStatus.value = 'unknown'; h.form.elements.observedCount.value = '0'; h.form.elements.expectedCount.value = '0'; h.form.elements.costsComplete.value = ''; h.form.elements.method.value = 'unknown';
  h.submit(); h.submit(); await until(() => h.$('business-outcomes-status').textContent.includes('Draft saved'));
  const body = JSON.parse(h.writes()[0].body); assert.equal(h.writes().length, 1);
  assert.equal(body.amount, null); assert.equal(body.currency, null); assert.equal(body.window, null); assert.equal(body.observedAt, null); assert.equal(body.report.costsComplete, null); assert.equal(body.coverage.observedCount, 0); assert.equal(body.expectedRevision, 1);
  assert.equal(h.d.querySelector('[data-outcome-action="publish"]'), null);
});

test('publication requires exact reviewed details, checked attestation, cancel, and one stable UUID per pending action', async t => {
  const h = await harness(t); await h.open(); await h.load(); h.review('publish');
  assert.equal(h.$('business-outcomes-confirm').disabled, true); h.$('business-outcomes-confirm').click(); assert.equal(h.writes().length, 0);
  h.$('business-outcomes-cancel').click(); assert.ok(h.$('business-outcomes-review').classList.contains('hidden')); assert.equal(h.writes().length, 0);
  h.review('publish'); const hold = deferred(); h.handler = () => hold.promise; h.confirm(); h.$('business-outcomes-confirm').dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  assert.equal(h.writes().length, 1); const payload = JSON.parse(h.writes()[0].body); assert.match(payload.publicationId, /^[a-f0-9-]{36}$/); assert.equal(payload.expectedMeasurementDigest, h.m.digest); assert.equal(payload.expectedWorkspaceRevision, 'revision_one');
  hold.resolve({ publication: publication(h.m, payload.publicationId), replayed: false, isCurrent: true }); await until(() => h.$('business-outcomes-status').textContent.includes('Reviewed action recorded'));
  assert.equal(h.writes().length, 1); assert.equal(h.form.elements.amount.disabled, true);
});

test('uncertain publication retries only on explicit review with identical payload and identity', async t => {
  const h = await harness(t); await h.open(); await h.load(); h.review('publish'); h.handler = async () => { throw new Error('lost response'); }; h.confirm();
  await until(() => h.$('business-outcomes-confirm').textContent.includes('Retry same')); assert.equal(h.writes().length, 1);
  assert.equal(h.$('business-outcomes-confirm').disabled, true); assert.equal(h.form.elements.amount.disabled, true);
  h.confirm(); await until(() => h.writes().length === 2); assert.equal(h.writes()[0].body, h.writes()[1].body);
});

test('conflicts require explicit refresh and discard the stale reviewed action', async t => {
  const h = await harness(t); await h.open(); await h.load(); h.review('publish');
  h.handler = async () => { throw Object.assign(new Error('stale revision'), { status: 409 }); }; h.confirm();
  await until(() => h.$('business-outcomes-status').textContent.includes('not accepted')); assert.equal(h.writes().length, 1); assert.equal(h.$('business-outcomes-review').childElementCount, 0); assert.equal(h.form.elements.amount.disabled, true);
});

test('withdrawal binds old published measurement and leaves later draft untouched', async t => {
  const first = measurement(), p = publication(first), later = measurement({ ...input, expectedRevision: 1, amount: '2' }, first);
  const h = await harness(t, { measurement: later, publication: p }); await h.open(); await h.load(); h.review('withdraw');
  assert.match(h.$('business-outcomes-review').textContent, /999999999999999999\.999999 GBP/);
  h.$('business-outcomes-reason').value = 'incorrect_measurement'; h.handler = async () => { throw new Error('fixture pending'); }; h.confirm();
  await until(() => h.writes().length === 1); const body = JSON.parse(h.writes()[0].body);
  assert.equal(body.expectedMeasurementRevision, 1); assert.equal(body.expectedMeasurementDigest, first.digest); assert.equal(body.expectedHeadVersionId, p.head.versionId); assert.equal(body.withdrawalReason, 'incorrect_measurement');
  assert.equal(h.writes()[0].method, 'POST'); assert.equal(h.m.digest, later.digest);
});

test('admins prepare but cannot publish; members only read', async t => {
  for (const role of ['admin','member']) {
    const h = await harness(t, { role }); await h.open(); await h.load();
    assert.equal(h.d.querySelector('[data-outcome-action]'), null); assert.equal(h.form.classList.contains('hidden'), role === 'member');
    if (role === 'member') { h.submit(); assert.equal(h.writes().length, 0); }
  }
});

test('current-source evidence is explicit, bound to exact tenant/version/digest, escaped and coalesced', async t => {
  const m = measurement(), p = publication(m), h = await harness(t, { publication: p, current: [p] }); await h.open();
  assert.equal(h.calls.some(c => c.path.includes('/versions/')), false); const button = h.d.querySelector('[data-outcome-evidence]'), hold = deferred(); h.handler = () => hold.promise;
  button.click(); button.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true })); assert.equal(h.calls.filter(c => c.path.includes('/versions/')).length, 1);
  hold.resolve({ publication: p, sourceMeasurement: m, currentStatus: 'not_checked', source: 'immutable_business_outcome_version' });
  await until(() => button.textContent === 'Retained source loaded'); assert.match(button.nextElementSibling.textContent, /current status has not been rechecked/); assert.equal(button.nextElementSibling.querySelector('img'), null);
});

test('navigation aborts and ignores late reads; new session clears old measurement and pending review', async t => {
  const h = await harness(t); await h.open(); const hold = deferred(); h.handler = () => hold.promise; h.$('business-outcomes-experiment').value = experimentId; h.$('business-outcomes-load').click();
  const request = h.calls.at(-1); h.context.view = 'overview'; h.w.RunvaraOutcomes.pause(); assert.equal(request.signal.aborted, true);
  hold.resolve(h.detail()); await new Promise(r => setTimeout(r, 10)); assert.equal(h.$('business-outcomes-detail').textContent, '');
  h.context = { ...h.context, session: {}, workspaceId: 'another-tenant', experiments: [] }; h.w.RunvaraOutcomes.reset(); assert.equal(h.panel.open, false); assert.equal(h.$('business-outcomes-experiment').options.length, 1); assert.equal(h.writes().length, 0);
});

test('summary DOM stays bounded and incomplete, mixed-currency or standalone groups never become invented totals', async t => {
  const m = measurement(), p = publication(m), groups = Array.from({ length: 200 }, (_, i) => ({ currency: i % 2 ? 'EUR' : 'GBP', method: 'reconciled_manual', window: m.window, amount: '3', amountStatus: 'standalone_observations', measuredCount: 1 }));
  const h = await harness(t, { current: Array(200).fill(p), groups }); await h.open();
  assert.equal(h.$('business-outcomes-summary').querySelectorAll('.outcome-record').length, 40); assert.match(h.$('business-outcomes-summary').textContent, /Showing 20 of 200/); assert.equal(h.$('business-outcomes-summary').querySelector('strong').textContent, 'No additive total');
  h.summary.summary.coverage.complete = false; h.summary.summary.groups[0].amountStatus = 'measured_sum'; h.$('business-outcomes-refresh').click(); await until(() => !h.$('business-outcomes-refresh').disabled); assert.equal(h.$('business-outcomes-summary').querySelector('strong').textContent, 'No additive total');
});

test('mismatched tenant payload is never rendered', async t => {
  const h = await harness(t); h.handler = async () => ({ workspaceId: 'foreign', current: [], summary: { groups: [{ amount: '9876' }] } }); await h.open();
  assert.match(h.$('business-outcomes-status').textContent, /Could not load/); assert.equal(h.$('business-outcomes-summary').textContent, '');
});

test('navigation during publication aborts display transport, coalesces the running request and retains retry identity', async t => {
  const h = await harness(t); await h.open(); await h.load(); h.review('publish'); const hold = deferred(); h.handler = () => hold.promise; h.confirm();
  const first = h.writes()[0]; h.context.view = 'overview'; h.w.RunvaraOutcomes.pause(); assert.equal(first.signal.aborted, true);
  await new Promise(r => setTimeout(r, 10)); h.context.view = 'revenue-engine'; h.panel.open = true; await new Promise(r => setTimeout(r, 10));
  h.confirm(); assert.equal(h.writes().length, 1, 'navigation cannot launch a second concurrent mutation');
  hold.reject(new Error('response lost')); await until(() => !h.$('business-outcomes-cancel').disabled);
  h.handler = async () => { throw new Error('still unavailable'); }; h.confirm(); await until(() => h.writes().length === 2); assert.equal(h.writes()[1].body, first.body);
});

test('a late rejected publication cannot discard a review in a newer authenticated session', async t => {
  const h = await harness(t); await h.open(); await h.load(); h.review('publish'); const original = h.handler, hold = deferred(); h.handler = () => hold.promise; h.confirm();
  h.context = { ...h.context, session: {} }; h.w.RunvaraOutcomes.reset(); h.handler = original; await h.open(); await h.load(); h.review('publish');
  hold.reject(Object.assign(new Error('old conflict'), { status: 409 })); await new Promise(r => setTimeout(r, 10));
  assert.equal(h.$('business-outcomes-review').classList.contains('hidden'), false); assert.ok(h.$('business-outcomes-attest')); assert.equal(h.form.elements.amount.disabled, false);
});

test('source-envelope mismatches do not reveal foreign or inconsistent evidence', async t => {
  const m = measurement(), p = publication(m), h = await harness(t, { publication: p, current: [p] }); await h.open();
  h.handler = async () => ({ publication: p, sourceMeasurement: { ...m, workspaceId: 'foreign', report: { description: 'PRIVATE FOREIGN FACT' } }, currentStatus: 'not_checked', source: 'immutable_business_outcome_version' });
  h.d.querySelector('[data-outcome-evidence]').click(); await until(() => h.$('business-outcomes-status').textContent.includes('Could not load'));
  assert.equal(h.$('business-outcomes-summary').textContent.includes('PRIVATE FOREIGN FACT'), false);
});

test('real app wiring aborts navigation reads and a late 401 cannot sign out or clear a newer outcomes view', async t => {
  const { createPacksmartServer } = await import('../server.mjs');
  const { seedWorkspaceState } = await import('../lib/store.mjs');
  const { createSessionToken } = await import('../lib/security.mjs');
  const { once } = await import('node:events'); const { default: os } = await import('node:os'); const { default: path } = await import('node:path');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'outcomes-app-ui-'));
  const secret = 'outcome-app-ui-synthetic-longer-than-32-characters';
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret, SAAS_STATE_FILE: path.join(directory,'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' });
  const state = seedWorkspaceState({}, { workspaceId, name: 'Outcome UI fixture', email: 'outcomes@example.test', passwordHash: 'fixture-only' }); state.products = [];
  await server.packsmart.store.save(workspaceId,state); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const token = createSessionToken({ userId: state.users[0].id, workspaceId, email: state.users[0].email, role: 'owner', sessionVersion:1 }, secret);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bootstrap`, { headers: { Cookie:`packsmart_session=${token}` } }); assert.equal(response.status,200);
  const bootstrap = await response.json(); await new Promise(resolve => server.close(resolve)); bootstrap.revenueEngine.experiments = [{ id:experimentId,title:'Wired experiment',status:'measured',impact:{verified:true,incrementalContribution:null} }];
  const errors = [], console = new VirtualConsole(); console.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html,{url:'https://runvara.example.test',runScripts:'outside-only',virtualConsole:console,pretendToBeVisual:true});
  t.after(async()=>{await new Promise(resolve=>setTimeout(resolve,10)); dom.window.close(); await fs.rm(directory,{recursive:true,force:true}); assert.deepEqual(errors,[]);});
  const w=dom.window,d=w.document,calls=[]; w.Headers=Headers; w.AbortController=AbortController; w.scrollTo=()=>{}; w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;}; w.HTMLDialogElement.prototype.close=function(){this.open=false;};
  let held=null;
  w.fetch=async(route,config={})=>{
    calls.push({route,config});
    if(route==='/api/bootstrap') return Response.json(bootstrap);
    if(route==='/api/auth/session') return Response.json({user:bootstrap.user,workspace:bootstrap.workspace,csrf:bootstrap.csrf});
    if(route==='/api/auth/signup-options') return Response.json({enabled:false});
    if(route==='/api/business-outcomes') return held ? held.promise : Response.json({workspaceId,current:[],summary:{groups:[],coverage:{complete:true}}});
    throw new Error('Unexpected route '+route);
  };
  for(const file of ['presentation.js','control-ui.js','outcomes-ui.js','app.js']) w.eval(await fs.readFile(new URL('../../'+file,import.meta.url),'utf8'));
  await until(()=>!d.getElementById('app-shell').classList.contains('hidden'));
  assert.equal(calls.filter(c=>c.route.includes('business-outcomes')).length,0);
  assert.match(d.getElementById('re-experiment-list').textContent,/Legacy recorded \/ unqualified · contribution unknown/);
  assert.doesNotMatch(d.getElementById('re-experiment-list').textContent,/£0|0\.00/);
  d.querySelector('#main-nav [data-view="revenue-engine"]').click(); const panel=d.getElementById('business-outcomes-panel'); panel.open=true;
  await until(()=>d.getElementById('business-outcomes-status').textContent.includes('Loaded on request'));
  held=deferred(); d.getElementById('business-outcomes-refresh').click(); const old=calls.at(-1); const oldPromise=held;
  d.querySelector('#main-nav [data-view="overview"]').click(); assert.equal(old.config.signal.aborted,true); held=null;
  await new Promise(r=>setTimeout(r,10)); d.querySelector('#main-nav [data-view="revenue-engine"]').click(); panel.open=true; await new Promise(r=>setTimeout(r,10)); d.getElementById('business-outcomes-refresh').click();
  await until(()=>d.getElementById('business-outcomes-status').textContent.includes('Loaded on request'));
  oldPromise.resolve(Response.json({code:'AUTH_REQUIRED'},{status:401})); await new Promise(r=>setTimeout(r,10));
  assert.equal(d.getElementById('app-shell').classList.contains('hidden'),false); assert.equal(d.getElementById('login-screen').classList.contains('hidden'),true);
  assert.equal(calls.filter(c=>c.route==='/api/bootstrap').length,1,'all read-only outcomes loads avoid full bootstrap');
  held=deferred(); d.getElementById('business-outcomes-refresh').click(); held.resolve(Response.json({code:'AUTH_REQUIRED'},{status:401}));
  await until(()=>d.getElementById('app-shell').classList.contains('hidden')); assert.equal(panel.open,false); assert.equal(d.getElementById('business-outcomes-summary').textContent,'');
});
