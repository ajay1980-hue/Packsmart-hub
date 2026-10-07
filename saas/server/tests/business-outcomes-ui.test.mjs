import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { actionUiFixture } from './business-outcomes-action-ui-fixture.mjs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { prepareExperimentOutcomeMeasurement, assessExperimentOutcomeMeasurement, digestMeasurementValue } from '../lib/experiment-measurements.mjs';
import { createBusinessOutcomeCandidate, correctBusinessOutcomeCandidate, withdrawBusinessOutcomeCandidate, assessBusinessOutcomeCandidate } from '../lib/business-outcomes.mjs';
const html = await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8');
const script = await fs.readFile(new URL('../../outcomes-ui.js', import.meta.url), 'utf8');
const now = '2026-10-06T20:00:00.000Z', workspaceId = 'outcomes-ui', experimentId = 'experiment_one';
const input = { expectedRevision: 0, amount: '999999999999999999.999999', currency: 'GBP', window: { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' }, coverage: { status: 'complete', observedCount: 2, expectedCount: 2 }, method: { kind: 'reconciled_manual' }, observedAt: '2026-10-06T12:00:00.000Z', report: { description: '<img src=x onerror="window.injected=true"> Measured retained facts.', costsComplete: true } };
const measurement = (body = input, previousMeasurement = null, actionEvidence = null) => prepareExperimentOutcomeMeasurement(body, { workspaceId, experimentId, actorId: 'owner_one', now, previousMeasurement, ...(body.actionSelection ? { actionEvidence, reuseVersionId: body.actionSelection.reuseVersionId ?? null } : {}) });
const assessment = m => assessExperimentOutcomeMeasurement(m, { workspaceId, experimentId, now });
function publication(m, publicationId = 'publication_one') {
  const version = createBusinessOutcomeCandidate({ source: { type: 'experiment_measurement', experimentId, measurementRevision: m.revision, measurementDigest: m.digest }, metric: m.metric, amount: m.amount, currency: m.currency, window: m.window, coverage: m.coverage, method: m.method, provenance: m.provenance, links: m.links, verification: { kind: 'owner_attestation', actorId: 'owner_one', verifiedAt: now, measurementDigest: m.digest } }, { workspaceId, now });
  return { version, head: { workspaceId, versionId: version.versionId, digest: version.digest, status: 'published', publicationId } };
}
function relationships(detail) {
  const p = detail.currentPublication, m = detail.measurement;
  const opaque = (kind, ...parts) => `${kind}_${digestMeasurementValue([workspaceId, kind, ...parts])}`;
  const graphRef = identity => ({ status: 'unresolved', reason: 'separate_graph_not_resolved', identityHash: digestMeasurementValue(identity) });
  const experiment = { id: opaque('selected_experiment', experimentId), type: 'experiment_reference', canonicalGraphRef: graphRef(['experiment', experimentId]) };
  const qualification = !p ? 'none' : p.head.status === 'withdrawn' ? 'withdrawn'
    : assessBusinessOutcomeCandidate(p.version, { workspaceId, now }).measurementComplete ? 'owner_attested_measurement' : 'unqualified';
  const outcome = p ? { id: opaque('selected_outcome', p.version.outcomeId), type: p.head.status === 'withdrawn' ? 'withdrawn_measurement_reference' : 'published_measurement_reference', qualification,
    sourceVersionRef: opaque('selected_version', p.head.versionId, p.head.digest), canonicalGraphRef: graphRef(['outcome', p.head.versionId]) } : null;
  return { schema: 'runvara-selected-outcome-relationships/v1', scope: 'selected_experiment_only',
    snapshot: { id: opaque('selected_snapshot', 'fixture'), workspaceRevisionRef: opaque('selected_revision', detail.workspaceRevision), readCompletedAt: now },
    publication: { state: p?.head.status || 'none', qualification, versionDigest: p?.version.digest ?? null,
      draftRelationship: !m ? 'no_draft' : !p ? 'no_publication' : m.digest === p.version.source.measurementDigest && m.revision === p.version.source.measurementRevision ? 'matches_publication' : 'different_from_publication', draftDigest: m?.digest ?? null },
    nodes: outcome ? [experiment, outcome] : [experiment], edges: outcome ? [{ id: opaque('selected_edge', p.head.versionId), from: outcome.id, to: experiment.id, relation: 'measurement_recorded_for_experiment', basis: 'same_review_snapshot' }] : [],
    coverage: { selectedExperimentConfirmed: true, currentHeadChecked: true, wholeGraphSynchronized: false, otherOutcomesChecked: false, crossOutcomeComparabilityChecked: false },
    safeguards: { causalAttribution: false, forecastingAuthorized: false, learningAuthorized: false, executionAuthorized: false, rawIdentifiersIncluded: false, amountsIncluded: false } };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(fn) { for (let n = 0; n < 200; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail('UI did not settle'); }
async function harness(t, options = {}) {
  const errors = [], virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, { url: 'https://runvara.example.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window, d = w.document; w.TextEncoder = TextEncoder; Object.defineProperty(w.crypto, 'subtle', { value: webcrypto.subtle, configurable: true }); w.AbortController = AbortController; w.HTMLElement.prototype.scrollIntoView = () => {};
  t.after(() => { dom.window.close(); assert.deepEqual(errors, []); });
  const h = { w, d, calls: [], context: { workspaceId, userId: 'owner_one', role: options.role || 'owner', session: {}, view: 'revenue-engine', experiments: [{ id: experimentId, title: 'Recorded experiment' }] } };
  h.action = options.action || null; h.currentActionAssociation = options.currentActionAssociation;
  h.m = options.measurement || measurement(); h.p = options.publication || null;
  h.detail = () => {
    const detail = { workspaceId, workspaceRevision: 'revision_one', experiment: { id: experimentId, title: 'Recorded experiment', status: 'measured' }, measurement: h.m, assessment: h.m ? assessment(h.m) : null, currentPublication: h.p };
    return { ...detail, relationships: relationships(detail), ...(h.action ? { actionLinkContract: 'runvara-reviewed-action/v1', actionChoices: [h.action.choice], currentActionAssociation: h.currentActionAssociation ?? (h.p && h.m?.digest === h.p.version.source.measurementDigest ? h.m.intervention : null) } : {}) };
  };
  h.summary = { workspaceId, current: options.current || [], summary: { groups: options.groups || [], coverage: { complete: true }, exclusions: [] } };
  h.handler = async (path, config) => {
    if (path === '/api/business-outcomes') return structuredClone(h.summary);
    if (path.endsWith('/measurement')) { const body = JSON.parse(config.body); h.m = measurement(body, h.m, h.action?.source); return { workspaceId, workspaceRevision: 'revision_two', measurement: h.m, assessment: assessment(h.m) }; }
    if (path === '/api/business-outcomes/publish') { const body = JSON.parse(config.body); h.p = publication(h.m, body.publicationId); return { publication: h.p, replayed: false, isCurrent: true }; }
    if (path.includes('/versions/')) return { publication: h.p, sourceMeasurement: options.sourceMeasurement || h.m, sourceAction: h.action?.source ?? null, currentStatus: 'not_checked', source: 'immutable_business_outcome_version' };
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
  assert.match(h.$('business-outcomes-relationship').textContent, /No owner-reviewed result was found/);
  h.panel.open = false; await new Promise(r => setTimeout(r, 10)); h.panel.open = true; await new Promise(r => setTimeout(r, 10));
  assert.equal(h.calls.length, before + 1); assert.equal(h.writes().length, 0); assert.equal(h.calls.some(c => c.path.includes('bootstrap')), false);
  assert.equal(h.$('business-outcomes-relationship'), null, 'reopening cannot revive a previous selected-detail check');
  await h.load(); assert.equal(h.calls.length, before + 2); assert.ok(h.$('business-outcomes-relationship'));
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
  hold.resolve({ publication: publication(h.m, payload.publicationId), replayed: false, isCurrent: true }); await until(() => h.$('business-outcomes-status').textContent.includes('Review saved'));
  assert.equal(h.writes().length, 1); assert.equal(h.form.elements.amount.disabled, true);
  assert.equal(h.$('business-outcomes-relationship'), null, 'successful publication waits for an explicit selected-detail refresh');
  assert.match(h.$('business-outcomes-detail').textContent, /This saved version has already been reviewed/);
  assert.doesNotMatch(h.$('business-outcomes-detail').textContent, /ready for owner review/);
  assert.equal(h.d.querySelector('[data-outcome-action="publish"]').disabled, true);
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
  await until(() => button.textContent === 'Original report loaded'); assert.match(button.nextElementSibling.textContent, /current status has not been rechecked/); assert.equal(button.nextElementSibling.querySelector('img'), null);
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
  assert.equal(h.$('business-outcomes-summary').querySelectorAll('.outcome-record').length, 40); assert.match(h.$('business-outcomes-summary').textContent, /Showing 20 of 200/); assert.equal(h.$('business-outcomes-summary').querySelector('strong').textContent, 'Total unavailable');
  h.summary.summary.coverage.complete = false; h.summary.summary.groups[0].amountStatus = 'measured_sum'; h.$('business-outcomes-refresh').click(); await until(() => !h.$('business-outcomes-refresh').disabled); assert.equal(h.$('business-outcomes-summary').querySelector('strong').textContent, 'Total unavailable');
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
  await until(()=>d.getElementById('business-outcomes-status').textContent.includes('Results loaded'));
  held=deferred(); d.getElementById('business-outcomes-refresh').click(); const old=calls.at(-1); const oldPromise=held;
  d.querySelector('#main-nav [data-view="overview"]').click(); assert.equal(old.config.signal.aborted,true); held=null;
  await new Promise(r=>setTimeout(r,10)); d.querySelector('#main-nav [data-view="revenue-engine"]').click(); panel.open=true; await new Promise(r=>setTimeout(r,10)); d.getElementById('business-outcomes-refresh').click();
  await until(()=>d.getElementById('business-outcomes-status').textContent.includes('Results loaded'));
  oldPromise.resolve(Response.json({code:'AUTH_REQUIRED'},{status:401})); await new Promise(r=>setTimeout(r,10));
  assert.equal(d.getElementById('app-shell').classList.contains('hidden'),false); assert.equal(d.getElementById('login-screen').classList.contains('hidden'),true);
  assert.equal(calls.filter(c=>c.route==='/api/bootstrap').length,1,'all read-only outcomes loads avoid full bootstrap');
  held=deferred(); d.getElementById('business-outcomes-refresh').click(); held.resolve(Response.json({code:'AUTH_REQUIRED'},{status:401}));
  await until(()=>d.getElementById('app-shell').classList.contains('hidden')); assert.equal(panel.open,false); assert.equal(d.getElementById('business-outcomes-summary').textContent,'');
});

test('owner-facing labels translate methods, totals and missing-evidence reasons without changing recorded values', async t => {
  const m = measurement({ ...input, amount: '0' }), p = publication(m);
  const groups = [{ method: 'reconciled_manual', amountStatus: 'measured_sum', amount: '0', currency: 'GBP', window: m.window, measuredCount: 1 },
    { method: 'before_after', amountStatus: 'standalone_observations', amount: null, currency: 'EUR', window: m.window, measuredCount: 2 },
    { method: 'holdout', amountStatus: 'incomplete_publication_read', amount: null, currency: 'USD', window: m.window, measuredCount: 1 }];
  const h = await harness(t, { measurement: m, current: [p], groups });
  h.summary.summary.exclusions = [{ code: 'OVERLAPPING_SCOPE' }, { code: 'REUSED_MEASUREMENT_REPORT' }, { code: 'toString' }];
  await h.open(); await h.load();
  const text = h.$('business-outcomes-summary').textContent;
  assert.match(text, /GBP · Reconciled records/); assert.match(text, /Recorded total · 1 measurement/); assert.match(text, /0 GBP/);
  assert.match(text, /EUR · Before and after/); assert.match(text, /Separate results; no combined total/);
  assert.match(text, /USD · Holdout comparison/); assert.match(text, /Results incomplete; total unavailable/);
  assert.match(text, /Measurement periods overlap for the same business activity/); assert.match(text, /The same report supports more than one result/);
  assert.match(text, /More evidence is needed before this result can be included/);
  assert.doesNotMatch(text, /reconciled_manual|before_after|measured_sum|standalone_observations|incomplete_publication_read|OVERLAPPING_SCOPE|REUSED_MEASUREMENT_REPORT|toString|native code|committed selection|publications/);
  assert.equal(h.$('business-outcomes-refresh').textContent, 'Refresh reviewed results');
  assert.equal(h.form.querySelector('h3').textContent, 'Record a business result');
  assert.equal(h.form.elements.method.value, 'reconciled_manual');
  assert.equal(h.form.elements.method.selectedOptions[0].textContent, 'Reconciled records');
  h.review('publish'); assert.match(h.$('business-outcomes-review').textContent, /Review result/);
  assert.equal(h.$('business-outcomes-confirm').textContent, 'Confirm result'); assert.equal(h.$('business-outcomes-confirm').disabled, true);
  assert.match(h.$('business-outcomes-review').textContent, /attest that this measurement and its costs are complete/);
  assert.match(h.$('business-outcomes-review').textContent, /does not prove Runvara caused the result/);
  assert.equal(h.writes().length, 0);
});

test('incomplete drafts describe unknowns and costs plainly without exposing assessment codes', async t => {
  const m = measurement({ expectedRevision: 0, report: { description: 'Reconciliation is incomplete.', costsComplete: false } });
  const h = await harness(t, { measurement: m }); await h.open(); await h.load();
  const text = h.$('business-outcomes-detail').textContent;
  assert.match(text, /More detail is needed before owner review/); assert.match(text, /The measured amount is unknown/);
  assert.match(text, /The currency is unknown/); assert.match(text, /The measurement period is unknown/);
  assert.match(text, /Some relevant costs are missing/); assert.match(text, /All relevant costs included: No/);
  assert.doesNotMatch(text, /AMOUNT_UNKNOWN|CURRENCY_UNKNOWN|WINDOW_UNKNOWN|COSTS_INCOMPLETE/);
  assert.equal(h.form.elements.amount.value, ''); assert.equal(h.form.elements.currency.value, ''); assert.equal(h.form.elements.costsComplete.value, 'false');
  assert.equal(h.d.querySelector('[data-outcome-action="publish"]'), null);
});

test('an already reviewed saved version explains correction requirements without offering another review', async t => {
  const m = measurement(), p = publication(m), h = await harness(t, { measurement: m, publication: p }); await h.open(); await h.load();
  assert.match(h.$('business-outcomes-detail').textContent, /This saved version has already been reviewed\. Save an updated draft to request a correction/);
  assert.doesNotMatch(h.$('business-outcomes-detail').textContent, /ready for owner review/);
  assert.equal(h.d.querySelector('[data-outcome-action="publish"]'), null); assert.equal(h.d.querySelector('[data-outcome-action="correct"]'), null);
  assert.ok(h.d.querySelector('[data-outcome-action="withdraw"]')); assert.equal(h.writes().length, 0);
  h.m = measurement({ ...input, expectedRevision: 1, amount: '-2' }, m); await h.load();
  assert.match(h.$('business-outcomes-detail').textContent, /ready for owner review/);
  assert.ok(h.d.querySelector('[data-outcome-action="correct"]')); assert.match(h.$('business-outcomes-detail').textContent, /-2 GBP/);
});

test('selected relationship follows the published version through newer drafts, correction and withdrawal', async t => {
  const first = measurement(), initial = publication(first), h = await harness(t, { measurement: first, publication: initial });
  await h.open(); await h.load();
  const linked = 'An owner-reviewed result was linked to this experiment when loaded.';
  assert.match(h.$('business-outcomes-relationship').textContent, /Only this experiment was checked; the rest of the workspace was not/);
  assert.ok(h.$('business-outcomes-relationship').textContent.startsWith(linked));
  assert.doesNotMatch(h.$('business-outcomes-relationship').outerHTML, /999999|GBP|owner_one|experiment_one|selected_snapshot|selected_outcome|digest|qualification|canonical|forecast|learning|execution/);
  h.m = measurement({ ...input, expectedRevision: 1, amount: null }, first); await h.load();
  assert.ok(h.$('business-outcomes-relationship').textContent.startsWith(linked), 'an incomplete later draft cannot relabel the reviewed result');
  assert.match(h.$('business-outcomes-detail').textContent, /The measured amount is unknown/);
  assert.match(h.d.querySelector('.outcome-current').textContent, /999999999999999999\.999999 GBP/);
  h.m = measurement({ ...input, expectedRevision: 2, amount: '-2' }, h.m);
  const replacement = publication(h.m).version;
  const replacementInput = Object.fromEntries(['source', 'metric', 'amount', 'currency', 'window', 'coverage', 'method', 'provenance', 'links', 'verification'].map(key => [key, replacement[key]]));
  const corrected = correctBusinessOutcomeCandidate(initial.version, replacementInput, { workspaceId, now });
  h.p = { version: corrected, head: { ...initial.head, versionId: corrected.versionId, digest: corrected.digest } };
  await h.load(); assert.ok(h.$('business-outcomes-relationship').textContent.startsWith(linked));
  assert.match(h.d.querySelector('.outcome-current').textContent, /version 2/); assert.match(h.d.querySelector('.outcome-current').textContent, /-2 GBP/);
  const withdrawn = withdrawBusinessOutcomeCandidate(corrected, { reason: 'incorrect_measurement', verification: corrected.verification }, { workspaceId, now });
  h.p = { version: withdrawn, head: { ...h.p.head, versionId: withdrawn.versionId, digest: withdrawn.digest, status: 'withdrawn' } };
  await h.load(); assert.match(h.$('business-outcomes-relationship').textContent, /withdrawn and no longer qualifies/);
  assert.doesNotMatch(h.$('business-outcomes-relationship').textContent, /An owner-reviewed result was linked/);
  assert.equal(h.calls.filter(c => !c.method).length, 5, 'all relationship states arrive with the existing explicit detail reads');
  assert.equal(h.writes().length, 0);
});

test('no-publication indication works with and without a draft and missing DTOs make no relationship claim', async t => {
  const h = await harness(t); await h.open(); await h.load();
  assert.match(h.$('business-outcomes-relationship').textContent, /No owner-reviewed result was found/);
  h.m = null; await h.load(); assert.match(h.$('business-outcomes-relationship').textContent, /No owner-reviewed result was found/);
  assert.match(h.$('business-outcomes-detail').textContent, /No business result recorded yet/);
  h.handler = async () => { const d = h.detail(); delete d.relationships; return d; };
  await h.load(); assert.equal(h.$('business-outcomes-relationship'), null); assert.match(h.$('business-outcomes-detail').textContent, /Recorded experiment/);
});

test('an unqualified publication never receives qualified wording and requires matching qualification in both places', async t => {
  const m = measurement({ ...input, amount: null }), h = await harness(t, { measurement: m, publication: publication(m) });
  await h.open(); await h.load();
  assert.match(h.$('business-outcomes-relationship').textContent, /missing required measurement details/);
  assert.doesNotMatch(h.$('business-outcomes-relationship').textContent, /An owner-reviewed result was linked/);
  h.handler = async () => { const d = h.detail(); d.relationships.publication.qualification = 'owner_attested_measurement'; d.relationships.nodes[1].qualification = 'owner_attested_measurement'; return d; };
  await h.load(); assert.equal(h.$('business-outcomes-relationship'), null);
});

test('draft-save attempts immediately hide relationship checks and only explicit detail refresh restores them', async t => {
  const first = measurement(), h = await harness(t, { publication: publication(first) }); await h.open(); await h.load();
  const hold = deferred(), original = h.handler;
  h.handler = (path, config) => path.endsWith('/measurement') ? hold.promise : original(path, config);
  h.form.elements.amount.value = '3'; h.submit();
  assert.equal(h.$('business-outcomes-relationship'), null, 'clear before awaiting a possibly committed save');
  h.m = measurement({ ...input, expectedRevision: 1, amount: '3' }, h.m);
  hold.resolve({ workspaceId, workspaceRevision: 'revision_two', measurement: h.m, assessment: assessment(h.m), relationships: h.detail().relationships });
  await until(() => h.$('business-outcomes-status').textContent.includes('Draft saved'));
  assert.equal(h.$('business-outcomes-relationship'), null, 'a write response cannot restore a read indication');
  const calls = h.calls.length; h.$('business-outcomes-refresh').click(); await until(() => !h.$('business-outcomes-refresh').disabled);
  assert.equal(h.$('business-outcomes-relationship'), null, 'overview refresh has no selected-detail authority');
  assert.equal(h.calls.length, calls + 1); h.handler = original; await h.load(); assert.ok(h.$('business-outcomes-relationship'));
  h.handler = async () => { throw new Error('save response lost'); }; h.submit();
  await until(() => h.$('business-outcomes-status').textContent.includes('Save was not confirmed'));
  assert.equal(h.$('business-outcomes-relationship'), null);
});

test('publish, correction and withdrawal attempts never retain relationships after uncertain or rejected replies', async t => {
  for (const action of ['publish', 'correct', 'withdraw']) {
    const first = measurement(), p = publication(first), later = measurement({ ...input, expectedRevision: 1, amount: '2' }, first);
    const h = await harness(t, { measurement: action === 'correct' ? later : first, publication: action === 'publish' ? null : p });
    await h.open(); await h.load(); assert.ok(h.$('business-outcomes-relationship')); h.review(action);
    if (action === 'withdraw') h.$('business-outcomes-reason').value = 'incorrect_measurement';
    const hold = deferred(); h.handler = () => hold.promise; h.confirm();
    assert.equal(h.$('business-outcomes-relationship'), null, action + ' clears its indication before a response');
    hold.reject(action === 'correct' ? Object.assign(new Error('changed'), { status: 409 }) : new Error('lost response'));
    await until(() => h.$('business-outcomes-status').textContent.includes(action === 'correct' ? 'not accepted' : 'Confirmation was not received'));
    assert.equal(h.$('business-outcomes-relationship'), null); assert.equal(h.writes().length, 1);
    assert.equal(h.calls.filter(c => !c.method).length, 2, 'writes never refresh relationships automatically');
  }
});

test('selected relationship ignores forged flags, stale digests, malformed references and private DTO fields', async t => {
  const m = measurement(), p = publication(m), h = await harness(t, { publication: p }); await h.open();
  const mutations = [
    d => { d.relationships.scope = 'whole_workspace'; },
    d => { d.relationships.schema = 'runvara-selected-outcome-relationships/v2'; },
    d => { d.relationships.coverage.wholeGraphSynchronized = true; },
    d => { d.relationships.coverage.currentHeadChecked = false; },
    d => { d.relationships.coverage.otherOutcomesChecked = true; },
    d => { d.relationships.coverage.crossOutcomeComparabilityChecked = true; },
    ...['causalAttribution', 'forecastingAuthorized', 'learningAuthorized', 'executionAuthorized', 'rawIdentifiersIncluded', 'amountsIncluded'].map(key => d => { d.relationships.safeguards[key] = true; }),
    d => { d.relationships.publication.state = 'withdrawn'; },
    d => { d.relationships.publication.qualification = 'owner_attested_measurement<script>PRIVATE RELATIONSHIP</script>'; },
    d => { d.relationships.publication.versionDigest = 'a'.repeat(64); },
    d => { d.relationships.publication.draftDigest = 'b'.repeat(64); },
    d => { d.relationships.publication.draftRelationship = 'different_from_publication'; },
    d => { d.relationships.snapshot.id = 'PRIVATE RELATIONSHIP'; },
    d => { d.relationships.snapshot.workspaceRevisionRef = workspaceId; },
    d => { d.relationships.snapshot.readCompletedAt = '<img src=x onerror="window.injected=true">'; },
    d => { d.relationships.nodes[0].canonicalGraphRef.status = 'resolved'; },
    d => { d.relationships.nodes[1].sourceVersionRef = p.head.versionId; },
    d => { d.relationships.nodes[1].qualification = 'withdrawn'; },
    d => { d.relationships.edges[0].from = d.relationships.nodes[0].id; },
    d => { d.relationships.edges[0].relation = 'causes_profit'; },
    d => { d.relationships.edges[0].basis = 'whole_graph'; },
    d => { d.relationships.edges.push({ ...d.relationships.edges[0] }); },
    d => { d.relationships.nodes = Array(100).fill(d.relationships.nodes[0]); },
    d => { d.relationships.actor = 'PRIVATE RELATIONSHIP'; },
    d => { d.relationships.nodes[1].amount = 'PRIVATE RELATIONSHIP'; },
    d => { d.relationships.publication.privateReport = '<img src=x onerror="window.injected=true">PRIVATE RELATIONSHIP'; },
    d => { d.currentPublication.version.source.experimentId = 'other_experiment'; },
    d => { d.currentPublication.version.verification.measurementDigest = 'c'.repeat(64); }
  ];
  for (const mutate of mutations) {
    h.handler = async () => { const d = structuredClone(h.detail()); mutate(d); return d; };
    await h.load(); assert.equal(h.$('business-outcomes-relationship'), null, mutate.toString());
    assert.match(h.$('business-outcomes-detail').textContent, /Recorded experiment/);
    assert.doesNotMatch(h.$('business-outcomes-detail').textContent, /PRIVATE RELATIONSHIP/);
  }
  assert.equal(h.w.injected, undefined); assert.equal(h.writes().length, 0);
  assert.equal(h.calls.length, mutations.length + 1, 'malformed projections add no fallback reads');
});

test('navigation and session replacement cannot revive a cached or late relationship indication', async t => {
  const m = measurement(), p = publication(m), h = await harness(t, { publication: p }); await h.open(); await h.load();
  const count = h.calls.length; h.context.view = 'overview'; h.w.RunvaraOutcomes.pause();
  assert.equal(h.$('business-outcomes-relationship'), null);
  h.context.view = 'revenue-engine'; h.panel.open = true; await new Promise(r => setTimeout(r, 10));
  assert.equal(h.$('business-outcomes-relationship'), null); assert.equal(h.calls.length, count);
  const oldDetail = h.detail(), hold = deferred(), original = h.handler; h.handler = () => hold.promise; h.$('business-outcomes-load').click();
  const oldRequest = h.calls.at(-1); h.context = { ...h.context, session: {} }; h.w.RunvaraOutcomes.reset();
  assert.equal(oldRequest.signal.aborted, true); assert.equal(h.$('business-outcomes-relationship'), null);
  h.p = null; h.handler = original; await h.open(); await h.load();
  assert.match(h.$('business-outcomes-relationship').textContent, /No owner-reviewed result was found/);
  hold.resolve(oldDetail); await new Promise(r => setTimeout(r, 10));
  assert.match(h.$('business-outcomes-relationship').textContent, /No owner-reviewed result was found/);
  assert.equal(oldRequest.isCurrent(), false); assert.equal(h.writes().length, 0);
});

test('recorded action choices are optional, explicit, escaped and saved only as selection IDs', async t => {
  const action = actionUiFixture(workspaceId), h = await harness(t, { action }); await h.open(); await h.load();
  const select = h.$('business-outcomes-action'), before = h.calls.length;
  assert.equal(select.value, ''); assert.equal(select.disabled, false); assert.equal(select.options.length, 2);
  assert.equal(h.form.querySelector('img,script,[onerror]'), null); assert.equal(h.w.actionInjected, undefined);
  select.value = 'action:' + action.choice.id; select.dispatchEvent(new h.w.Event('change', { bubbles: true }));
  const text = h.$('business-outcomes-action-details').textContent;
  for (const expected of [action.choice.id, action.choice.account, action.choice.productId, action.choice.completedAt]) assert.ok(text.includes(expected));
  assert.match(text, /does not establish a comparison, causality or commercial benefit/);
  assert.equal(h.calls.length, before, 'selection never fetches a provider, preview or source');
  h.submit(); h.submit(); await until(() => h.$('business-outcomes-status').textContent.includes('Draft saved'));
  assert.equal(h.writes().length, 1); assert.deepEqual(JSON.parse(h.writes()[0].body).actionSelection, { actionId: action.choice.id });
  assert.equal(h.m.schema, 'runvara-experiment-measurement/v2'); assert.equal(select.value, 'saved');
  h.review('publish');
  const review = h.$('business-outcomes-review').textContent;
  for (const expected of [action.choice.id, action.choice.account, action.choice.productId, action.choice.completedAt]) assert.ok(review.includes(expected));
  assert.match(review, /explicitly associate the recorded action shown above/); assert.equal(h.$('business-outcomes-confirm').disabled, true);
  assert.equal(h.calls.some(c => c.path.includes('/versions/')), false);
});

test('missing, unknown, malformed, oversized and duplicate action contracts cannot enable linking', async t => {
  const action = actionUiFixture(workspaceId), h = await harness(t, { action }); await h.open();
  for (const mutate of [d => { delete d.actionLinkContract; }, d => { d.actionLinkContract = 'unknown'; },
    d => { d.actionChoices[0].description = 'NOT ALLOWED'; }, d => { d.actionChoices.push(d.actionChoices[0]); },
    d => { d.actionChoices = Array(21).fill(d.actionChoices[0]); }, d => { d.actionChoices[0].digest = 'forged'; }]) {
    h.handler = async () => { const d = structuredClone(h.detail()); mutate(d); return d; };
    await h.load(); assert.equal(h.$('business-outcomes-action').disabled, true); assert.equal(h.$('business-outcomes-action').value, '');
    assert.match(h.$('business-outcomes-action-hint').textContent, /linking is unavailable/);
    const option = h.d.createElement('option'); option.value = 'action:' + action.choice.id; h.$('business-outcomes-action').append(option); h.$('business-outcomes-action').value = option.value;
    h.submit(); assert.equal(h.writes().length, 0); assert.match(h.$('business-outcomes-status').textContent, /linking is unavailable/);
  }
});

test('saved action selection is preserved and cannot silently resolve a changed or removed mutable action', async t => {
  const action = actionUiFixture(workspaceId), first = measurement({ ...input, actionSelection: { actionId: action.choice.id } }, null, action.source);
  const p = publication(first), h = await harness(t, { action, measurement: first, publication: p }); await h.open(); await h.load();
  assert.equal(h.$('business-outcomes-action').value, 'saved');
  h.action.choice.digest = 'f'.repeat(64); await h.load(); h.submit();
  assert.equal(h.writes().length, 0); assert.match(h.$('business-outcomes-status').textContent, /no longer an exact current choice/);
  const original = h.handler; h.handler = async (path, config) => {
    if (path.endsWith('/measurement')) return original(path, config);
    const d = h.detail(); d.actionChoices = []; return d;
  };
  await h.load(); assert.equal(h.$('business-outcomes-action').value, 'saved');
  h.submit(); assert.equal(h.writes().length, 0);
  h.$('business-outcomes-action').value = 'reuse:' + p.head.versionId;
  h.$('business-outcomes-action').dispatchEvent(new h.w.Event('change', { bubbles: true }));
  assert.match(h.$('business-outcomes-action-details').textContent, /write_reviewed_action/);
  h.submit(); await until(() => h.$('business-outcomes-status').textContent.includes('Draft saved'));
  assert.deepEqual(JSON.parse(h.writes()[0].body).actionSelection, { reuseVersionId: p.head.versionId });
  assert.equal(h.m.intervention.action.digest, first.intervention.action.digest); assert.equal(h.m.intervention.reuseVersionId, p.head.versionId);
  assert.equal(h.$('business-outcomes-action').value, 'saved');
  h.submit(); await until(() => h.writes().length === 2);
  assert.deepEqual(JSON.parse(h.writes()[1].body).actionSelection, { reuseVersionId: p.head.versionId });
  assert.equal(h.calls.some(c => c.path.includes('/versions/')), false, 'reuse is derived only from the selected review snapshot');
});

test('clearing a saved link explicitly sends null and produces an unlinked next revision', async t => {
  const action = actionUiFixture(workspaceId), first = measurement({ ...input, actionSelection: { actionId: action.choice.id } }, null, action.source);
  const h = await harness(t, { action, measurement: first }); await h.open(); await h.load();
  h.$('business-outcomes-action').value = ''; h.submit(); await until(() => h.$('business-outcomes-status').textContent.includes('Draft saved'));
  assert.equal(JSON.parse(h.writes()[0].body).actionSelection, null); assert.equal(h.m.revision, 2); assert.equal(h.m.schema, 'runvara-experiment-measurement/v1');
  assert.equal(h.m.links.action, null); assert.equal(h.$('business-outcomes-action').value, '');
});

test('v2 draft review rejects malformed, extra-field, foreign and causality-claiming interventions', async t => {
  const action = actionUiFixture(workspaceId), m = measurement({ ...input, actionSelection: { actionId: action.choice.id } }, null, action.source);
  const h = await harness(t, { action, measurement: m }); await h.open();
  for (const mutate of [d => { d.measurement.intervention.comparison = 'proven'; }, d => { d.measurement.intervention.extra = true; },
    d => { d.measurement.intervention.action.workspaceId = 'foreign'; }, d => { d.measurement.report.facts.intervention.action.digest = 'a'.repeat(64); },
    d => { d.measurement.links.objective = d.measurement.links.action; }, d => { delete d.measurement.intervention; },
    d => { d.measurement.intervention.productId = d.measurement.report.facts.intervention.productId = 'gid://shopify/Product/' + '1'.repeat(140); },
    d => { d.measurement.intervention.approval.revision = d.measurement.report.facts.intervention.approval.revision = d.measurement.links.approval.revision = 2; }]) {
    h.handler = async () => { const d = structuredClone(h.detail()); mutate(d); return d; };
    h.$('business-outcomes-experiment').value = experimentId; h.$('business-outcomes-load').click();
    await until(() => h.$('business-outcomes-status').textContent.includes('Could not load'));
    assert.equal(h.$('business-outcomes-detail').textContent, ''); assert.equal(h.d.querySelector('[data-outcome-action]'), null); assert.equal(h.writes().length, 0);
  }
});

test('linked evidence checks exact source hashes and renders full stored input only after explicit read', async t => {
  const description = 'Safe prefix <img src=x onerror="window.actionInjected=true">\n' + 'x'.repeat(9000) + ' EXACT END';
  const action = actionUiFixture(workspaceId, { description }), m = measurement({ ...input, actionSelection: { actionId: action.choice.id } }, null, action.source), p = publication(m);
  const h = await harness(t, { action, measurement: m, publication: p, current: [p] }); await h.open(); await h.load();
  assert.doesNotMatch(h.$('business-outcomes-summary').textContent, /Safe prefix|Product title|write_reviewed_action/);
  assert.equal(h.calls.some(c => c.path.includes('/versions/')), false);
  const button = h.d.querySelector('[data-outcome-source-current]'); button.click(); button.click();
  await until(() => button.dataset.loaded === 'true');
  const target = h.$('business-outcomes-current-source'); assert.ok(target.textContent.includes(description)); assert.ok(target.textContent.includes(action.source.input.title));
  assert.match(target.textContent, /Current status was not checked/); assert.match(target.textContent, /immutable only when the outcome is published/);
  assert.equal(target.querySelector('img,script,[onerror]'), null); assert.equal(h.w.actionInjected, undefined);
  assert.equal(h.calls.filter(c => c.path.includes('/versions/')).length, 1);
});

test('missing or malformed linked evidence fails closed without rendering source or retrying', async t => {
  const action = actionUiFixture(workspaceId), m = measurement({ ...input, actionSelection: { actionId: action.choice.id } }, null, action.source), p = publication(m);
  for (const mutate of [r => { delete r.sourceAction; }, r => { r.sourceAction = null; }, r => { r.sourceAction.digest = 'f'.repeat(64); },
    r => { r.sourceAction.input.description = 'TAMPERED'; }, r => { r.sourceAction.context.account = 'foreign.myshopify.com'; },
    r => { r.sourceAction.context.approval.workspaceId = 'foreign'; }, r => { r.sourceAction.context.originatingObjective = 'invented'; },
    r => { r.sourceAction.input.extra = 'forged'; }, r => { r.sourceMeasurement.intervention.action.digest = 'f'.repeat(64); },
    r => { r.sourceAction.context.policies = [{ objectiveId: 'invented', revision: 1, digest: 'a'.repeat(64) }]; }]) {
    const h = await harness(t, { action, measurement: m, publication: p, current: [p] }); await h.open();
    h.handler = async () => { const r = structuredClone({ publication: p, sourceMeasurement: m, sourceAction: action.source, currentStatus: 'not_checked', source: 'immutable_business_outcome_version' }); mutate(r); return r; };
    const button = h.d.querySelector('[data-outcome-evidence]'); button.click();
    await until(() => h.$('business-outcomes-status').textContent.includes('Could not load'));
    assert.equal(button.dataset.loaded, undefined); assert.equal(button.nextElementSibling.textContent, '');
    assert.equal(h.calls.filter(c => c.path.includes('/versions/')).length, 1); assert.equal(h.writes().length, 0);
  }
});

test('late source integrity checks cannot render into a closed or replaced session', async t => {
  const action = actionUiFixture(workspaceId), m = measurement({ ...input, actionSelection: { actionId: action.choice.id } }, null, action.source), p = publication(m);
  for (const transition of ['close', 'navigate', 'session']) {
    const h = await harness(t, { action, measurement: m, publication: p }); await h.open(); await h.load();
    const hold = deferred(); let started = false;
    Object.defineProperty(h.w.crypto, 'subtle', { value: { digest: async (...args) => { started = true; await hold.promise; return webcrypto.subtle.digest(...args); } } });
    h.d.querySelector('[data-outcome-source-current]').click(); await until(() => started);
    const target = h.$('business-outcomes-current-source');
    if (transition === 'close') h.panel.open = false;
    else if (transition === 'navigate') { h.context.view = 'overview'; h.w.RunvaraOutcomes.pause(); }
    else { h.context = { ...h.context, session: {} }; h.w.RunvaraOutcomes.reset(); }
    hold.resolve(); await new Promise(r => setTimeout(r, 30));
    assert.equal(target.textContent, ''); assert.equal(h.writes().length, 0); assert.equal(h.calls.filter(c => c.path.includes('/versions/')).length, 1);
  }
});

test('linked uncertain publications keep the reviewed association and identical retry intent', async t => {
  const action = actionUiFixture(workspaceId), m = measurement({ ...input, actionSelection: { actionId: action.choice.id } }, null, action.source);
  const h = await harness(t, { action, measurement: m }); await h.open(); await h.load(); h.review('publish');
  h.handler = async () => { throw new Error('lost acknowledgement'); }; h.confirm();
  await until(() => h.$('business-outcomes-confirm').textContent.includes('Retry same'));
  const review = h.$('business-outcomes-review').textContent; assert.match(review, /write_reviewed_action/); assert.match(review, /synthetic-shop.myshopify.com/);
  assert.equal(h.$('business-outcomes-action').disabled, true); h.confirm(); await until(() => h.writes().length === 2);
  assert.equal(h.writes()[0].body, h.writes()[1].body); assert.equal(JSON.parse(h.writes()[0].body).expectedMeasurementDigest, m.digest);
});

test('withdrawal keeps exact historical action evidence while a later unlinked draft stays separate', async t => {
  const action = actionUiFixture(workspaceId), first = measurement({ ...input, actionSelection: { actionId: action.choice.id } }, null, action.source), p = publication(first);
  const later = measurement({ ...input, expectedRevision: 1, amount: '2', actionSelection: null }, first);
  const h = await harness(t, { action, measurement: later, publication: p, sourceMeasurement: first, currentActionAssociation: first.intervention });
  await h.open(); await h.load(); assert.equal(h.$('business-outcomes-action').value, '');
  h.review('withdraw'); assert.match(h.$('business-outcomes-review').textContent, /write_reviewed_action/); assert.match(h.$('business-outcomes-review').textContent, /999999999999999999/);
  h.$('business-outcomes-cancel').click();
  h.d.querySelector('[data-outcome-source-current]').click(); await until(() => h.d.querySelector('[data-outcome-source-current]').dataset.loaded === 'true');
  assert.match(h.$('business-outcomes-current-source').textContent, /Exact recorded action input/); assert.equal(h.m.digest, later.digest); assert.equal(h.writes().length, 0);
});

test('exact historical source accepts every bounded policy reference without inventing objective origin', async t => {
  for (const policyCount of [3, 50]) {
    const action = actionUiFixture(workspaceId, { policyCount }), m = measurement({ ...input, actionSelection: { actionId: action.choice.id } }, null, action.source), p = publication(m);
    const h = await harness(t, { action, measurement: m, publication: p }); await h.open(); await h.load();
    const button = h.d.querySelector('[data-outcome-source-current]'); button.click(); await until(() => button.dataset.loaded === 'true');
    assert.match(h.$('business-outcomes-current-source').textContent, /restrictions, not an originating objective/);
    assert.equal(h.m.links.objective, null); assert.equal(action.source.context.policies.length, policyCount);
    assert.equal(h.calls.filter(c => c.path.includes('/versions/')).length, 1);
  }
});

test('withdrawn linked versions keep their historical source while removing all review and reuse actions', async t => {
  const action = actionUiFixture(workspaceId), m = measurement({ ...input, actionSelection: { actionId: action.choice.id } }, null, action.source), p = publication(m);
  const version = withdrawBusinessOutcomeCandidate(p.version, { reason: 'incorrect_measurement', verification: p.version.verification }, { workspaceId, now });
  const withdrawn = { head: { ...p.head, versionId: version.versionId, digest: version.digest, status: 'withdrawn' }, version };
  const h = await harness(t, { action, measurement: m, publication: withdrawn, currentActionAssociation: m.intervention }); await h.open(); await h.load();
  assert.match(h.$('business-outcomes-relationship').textContent, /withdrawn and no longer qualifies/); assert.equal(h.d.querySelector('[data-outcome-action]'), null);
  assert.equal([...h.$('business-outcomes-action').options].some(o => o.value.startsWith('reuse:')), false);
  const button = h.d.querySelector('[data-outcome-source-current]'); button.click(); await until(() => button.dataset.loaded === 'true');
  assert.match(h.$('business-outcomes-current-source').textContent, /Exact recorded action input/); assert.equal(h.writes().length, 0);
});

test('rehashing a changed claim identity cannot make its typed source evidence displayable', async t => {
  for (const policyCount of [0, 3]) {
    const action = actionUiFixture(workspaceId, { policyCount }), m = measurement({ ...input, actionSelection: { actionId: action.choice.id } }, null, action.source), p = publication(m);
    const h = await harness(t, { action, measurement: m, publication: p, current: [p] }); await h.open();
    h.handler = async () => {
      const result = structuredClone({ publication: p, sourceMeasurement: m, sourceAction: action.source, currentStatus: 'not_checked', source: 'immutable_business_outcome_version' });
      result.sourceAction.context.claimIdentity = 'a'.repeat(64);
      const { digest: oldDigest, ...body } = result.sourceAction;
      const changedDigest = digestMeasurementValue(body); assert.notEqual(changedDigest, oldDigest);
      result.sourceAction.digest = changedDigest;
      // Self-consistent source hashes/refs alone must not override the typed
      // legacy claim fingerprint, even in an invalid DTO the server would deny.
      result.sourceMeasurement.intervention.action.digest = changedDigest;
      result.sourceMeasurement.report.facts.intervention.action.digest = changedDigest;
      result.sourceMeasurement.links.action.digest = changedDigest;
      result.publication.version.links.action.digest = changedDigest;
      return result;
    };
    const button = h.d.querySelector('[data-outcome-evidence]'); button.click();
    await until(() => h.$('business-outcomes-status').textContent.includes('Could not load'));
    assert.equal(button.dataset.loaded, undefined); assert.equal(button.nextElementSibling.textContent, '');
    assert.equal(h.calls.filter(c => c.path.includes('/versions/')).length, 1); assert.equal(h.writes().length, 0);
  }
});
