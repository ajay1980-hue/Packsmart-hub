import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { JSDOM, VirtualConsole } from 'jsdom';
import { webcrypto } from 'node:crypto';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { prepareExperimentOutcomeMeasurement, assessExperimentOutcomeMeasurement, digestMeasurementValue } from '../lib/experiment-measurements.mjs';
import { createBusinessOutcomeCandidate } from '../lib/business-outcomes.mjs';
import { actionUiFixture } from './business-outcomes-action-ui-fixture.mjs';
import { objectivePublicationFixture } from './objective-publication-fixture.mjs';
import { createActivityMeter } from '../lib/activity-meter.mjs';

const workspaceId = 'outcome-app-lifecycle', experimentId = 'experiment_one', actorId = 'owner_one';
const now = '2026-10-06T20:00:00.000Z';
const measurement = prepareExperimentOutcomeMeasurement({ expectedRevision: 0, amount: '10', currency: 'GBP',
  window: { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' },
  coverage: { status: 'complete', observedCount: 2, expectedCount: 2 }, method: { kind: 'reconciled_manual' },
  observedAt: '2026-10-06T12:00:00.000Z', report: { description: 'Synthetic owner-reconciled contribution.', costsComplete: true }
}, { workspaceId, experimentId, actorId, now, previousMeasurement: null });
const detail = { workspaceId, workspaceRevision: 'fixture_revision', experiment: { id: experimentId, title: 'Recorded experiment', status: 'measured' },
  measurement, assessment: assessExperimentOutcomeMeasurement(measurement, { workspaceId, experimentId, now }), currentPublication: null };
const opaque = (kind, value) => `${kind}_${digestMeasurementValue([workspaceId, kind, value])}`;
detail.relationships = { schema: 'runvara-selected-outcome-relationships/v1', scope: 'selected_experiment_only',
  snapshot: { id: opaque('selected_snapshot', 'fixture'), workspaceRevisionRef: opaque('selected_revision', detail.workspaceRevision), readCompletedAt: now },
  publication: { state: 'none', qualification: 'none', versionDigest: null, draftRelationship: 'no_publication', draftDigest: measurement.digest },
  nodes: [{ id: opaque('selected_experiment', experimentId), type: 'experiment_reference', canonicalGraphRef: { status: 'unresolved', reason: 'separate_graph_not_resolved', identityHash: digestMeasurementValue(['experiment', experimentId]) } }], edges: [],
  coverage: { selectedExperimentConfirmed: true, currentHeadChecked: true, wholeGraphSynchronized: false, otherOutcomesChecked: false, crossOutcomeComparabilityChecked: false },
  safeguards: { causalAttribution: false, forecastingAuthorized: false, learningAuthorized: false, executionAuthorized: false, rawIdentifiersIncluded: false, amountsIncluded: false } };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate) {
  for (let n = 0; n < 200; n++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('Outcome app lifecycle did not settle');
}
const expired = () => Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 });

async function harness(t, { linked = false, objective = false } = {}) {
  const captured = objective ? await objectivePublicationFixture() : null;
  const tenant = captured?.workspaceId || workspaceId, recordedAt = captured ? new Date().toISOString() : now;
  const c = captured?.source.context;
  const action = captured ? { source: captured.source, choice: { id: c.writeId, account: c.account, productId: captured.source.input.productId,
    title: captured.source.input.title, completedAt: c.completedAt, digest: captured.source.digest, origin: c.origin, originatingObjective: c.originatingObjective } } : linked ? actionUiFixture(tenant) : null;
  const selectedMeasurement = action ? prepareExperimentOutcomeMeasurement({ expectedRevision: 0, actionSelection: { actionId: action.choice.id }, amount: '10', currency: 'GBP', window: measurement.window, coverage: { status: 'complete', observedCount: 2, expectedCount: 2 }, method: { kind: 'reconciled_manual' }, observedAt: measurement.provenance.observedAt, report: { description: 'Linked lifecycle fixture', costsComplete: true } }, { workspaceId: tenant, experimentId, actorId, now: recordedAt, actionEvidence: action.source }) : measurement;
  const selectedDetail = structuredClone(detail); selectedDetail.workspaceId = tenant; selectedDetail.measurement = selectedMeasurement; selectedDetail.relationships.publication.draftDigest = selectedMeasurement.digest;
  if (action) Object.assign(selectedDetail, { actionLinkContract: objective ? 'runvara-reviewed-action/v2' : 'runvara-reviewed-action/v1', actionChoices: [action.choice], currentActionAssociation: null });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-outcome-app-'));
  const secret = 'outcome-app-lifecycle-fixture-over-thirty-two-characters';
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
    SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false'
  }, { schedulerEnabled: false, agentOpsEnabled: false });
  const state = seedWorkspaceState({}, { workspaceId: tenant, userId: actorId, email: 'owner@outcome-app.test', passwordHash: 'synthetic-only' });
  state.products = []; state.revenueEngine.experiments = [detail.experiment];
  await server.packsmart.store.save(tenant, state);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const token = createSessionToken({ workspaceId: tenant, userId: actorId, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bootstrap`, { headers: { Cookie: `packsmart_session=${token}` } });
  assert.equal(response.status, 200); const bootstrap = await response.json();
  await new Promise(r => server.close(r));
  const errors = [], virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', e => errors.push(e.message));
  const html = await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://outcome-app.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window, d = w.document;
  w.Headers = Headers; w.TextEncoder = TextEncoder; w.AbortController = AbortController; w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(w.crypto, 'subtle', { value: webcrypto.subtle });
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  t.after(async () => { await new Promise(r => setTimeout(r, 15)); dom.window.close(); await fs.rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  const h = { w, d, action, measurement: selectedMeasurement, calls: [], handler: null, logout: null, $: id => d.getElementById(id) };
  w.fetch = async (route, config = {}) => {
    h.calls.push({ route, config });
    if (route === '/api/bootstrap') return Response.json(bootstrap);
    if (['/api/auth/session', '/api/auth/login'].includes(route)) return Response.json({ user: bootstrap.user, workspace: bootstrap.workspace, csrf: bootstrap.csrf });
    if (route === '/api/auth/signup-options') return Response.json({ enabled: false });
    if (route === '/api/auth/logout') return h.logout ? h.logout.promise : Response.json({ ok: true });
    if (route === '/api/audit?limit=250') return Response.json({ events: [] });
    if (route === '/api/billing') return Response.json({});
    if (route === '/api/activity') return h.activityHandler ? h.activityHandler() : Response.json(createActivityMeter({ dbAvailable: false }).snapshot(workspaceId));
    if (route.startsWith('/api/business-outcomes')) {
      const held = h.handler?.(route, config); if (held) return held;
      if (route === '/api/business-outcomes') return Response.json({ workspaceId: tenant, current: [], summary: { groups: [], coverage: { complete: true } } });
      return Response.json(selectedDetail);
    }
    throw new Error('Unexpected fixture route ' + route);
  };
  for (const file of ['presentation.js', 'control-ui.js', 'outcomes-ui.js', 'activity-ui.js', 'app.js']) w.eval(await fs.readFile(new URL('../../' + file, import.meta.url), 'utf8'));
  await until(() => !h.$('app-shell').classList.contains('hidden'));
  h.panel = h.$('business-outcomes-panel');
  h.navigate = view => d.querySelector(`#main-nav [data-view="${view}"]`).click();
  h.open = async () => {
    h.navigate('revenue-engine'); h.panel.open = true;
    await until(() => h.$('business-outcomes-summary').textContent.includes('Reviewed results loaded'));
  };
  h.load = async () => {
    h.$('business-outcomes-experiment').value = experimentId; h.$('business-outcomes-load').click();
    await until(() => !h.$('business-outcomes-load').disabled && h.$('business-outcomes-detail').textContent.includes('Recorded experiment'));
  };
  h.confirm = () => {
    h.$('business-outcomes-attest').checked = true;
    h.$('business-outcomes-attest').dispatchEvent(new w.Event('change', { bubbles: true }));
    h.$('business-outcomes-confirm').click();
  };
  h.begin = async kind => {
    await h.open(); if (kind !== 'read') await h.load();
    const hold = deferred(); h.handler = () => hold.promise;
    if (kind === 'read') h.$('business-outcomes-refresh').click();
    else if (kind === 'save') h.$('business-outcomes-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    else { d.querySelector('[data-outcome-action="publish"]').click(); h.confirm(); }
    return { hold, request: h.calls.at(-1) };
  };
  h.signedIn = () => !h.$('app-shell').classList.contains('hidden');
  return h;
}

test('outcome and activity navigation discard each other’s stale 401 without signing out the active workspace', async t => {
  const h = await harness(t), oldOutcome = await h.begin('read');
  h.navigate('audit');
  const activityPanel = h.$('workspace-activity-panel');
  activityPanel.open = true;
  await until(() => h.$('workspace-activity-status').textContent.includes('Activity loaded'));
  oldOutcome.hold.resolve(expired());
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(h.signedIn(), true);
  assert.equal(oldOutcome.request.config.signal.aborted, true);
  assert.equal(oldOutcome.request.config.isCurrent(), false);
  assert.equal(activityPanel.open, true);
  assert.match(h.$('workspace-activity-result').textContent, /Database activity tracking is unavailable/);
  assert.equal(h.$('global-error').classList.contains('hidden'), true, 'audit navigation must settle without an unexpected-route error');

  const activityHold = deferred(); h.activityHandler = () => activityHold.promise;
  h.$('workspace-activity-refresh').click();
  const oldActivity = h.calls.at(-1);
  assert.equal(oldActivity.route, '/api/activity');
  h.handler = null;
  await h.open();
  activityHold.resolve(expired());
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(h.signedIn(), true);
  assert.equal(oldActivity.config.signal.aborted, true);
  assert.equal(oldActivity.config.isCurrent(), false);
  assert.equal(h.panel.open, true);
  assert.match(h.$('business-outcomes-summary').textContent, /Reviewed results loaded/);
  assert.equal(h.$('global-error').classList.contains('hidden'), true);
  const count = h.calls.length;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(h.calls.length, count, 'navigation never automatically retries a stale read or mutation');
  assert.equal(h.calls.filter(call => call.config.method === 'POST').length, 0);
  h.logout = deferred(); h.$('logout').click();
  assert.equal(h.panel.open, false, 'logout closes the outcome panel before its response');
  assert.equal(activityPanel.open, false, 'logout closes the activity panel before its response');
  assert.equal(h.$('workspace-activity-result').textContent, '');
  h.logout.resolve(Response.json({ ok: true }));
  await until(() => !h.signedIn());
});

test('real app navigation and logout immediately clear selected relationship checks without automatic detail reads', async t => {
  const h = await harness(t); await h.open(); await h.load();
  assert.match(h.$('business-outcomes-relationship').textContent, /No owner-reviewed result was found/);
  const detailReads = () => h.calls.filter(c => c.route === '/api/business-outcomes/experiments/' + experimentId).length;
  assert.equal(detailReads(), 1); h.navigate('overview');
  assert.equal(h.$('business-outcomes-relationship'), null, 'navigation hides the check synchronously');
  await h.open(); assert.equal(h.$('business-outcomes-relationship'), null); assert.equal(detailReads(), 1);
  await h.load(); assert.ok(h.$('business-outcomes-relationship')); assert.equal(detailReads(), 2);
  h.logout = deferred(); h.$('logout').click();
  assert.equal(h.$('business-outcomes-relationship'), null, 'logout hides the check before transport completes');
  h.logout.resolve(Response.json({ ok: true })); await until(() => !h.signedIn());
  assert.equal(h.$('business-outcomes-relationship'), null); assert.equal(detailReads(), 2);
});

for (const kind of ['read', 'save', 'publish']) {
  test(`${kind} response after same-task panel close cannot expire the current session`, async t => {
    const h = await harness(t), { hold, request } = await h.begin(kind);
    assert.equal(request.config.isCurrent(), true); assert.equal(request.config.signal.aborted, false);
    h.panel.open = false;
    assert.equal(request.config.signal.aborted, false, 'exercise the interval before the details-toggle listener runs');
    hold.resolve(expired());
    await new Promise(r => setTimeout(r, 15));
    assert.equal(h.signedIn(), true); assert.equal(request.config.isCurrent(), false);
    const count = h.calls.length;
    await new Promise(r => setTimeout(r, 15)); assert.equal(h.calls.length, count, 'no automatic mutation or read retry');
    if (kind === 'save') assert.equal(h.$('business-outcomes-form').elements.amount.disabled, true, 'unconfirmed save requires a fresh review');
    if (kind === 'publish') {
      h.panel.open = true; await until(() => h.$('business-outcomes-confirm')?.textContent.includes('Retry same'));
      assert.equal(h.$('business-outcomes-confirm').disabled, true, 'fresh attestation is required');
      const retry = deferred(); h.handler = () => retry.promise; h.confirm();
      assert.equal(h.calls.at(-1).config.body, request.config.body, 'closing does not cancel or replace the original publication identity');
      const payload = JSON.parse(request.config.body);
      const version = createBusinessOutcomeCandidate({ source: { type: 'experiment_measurement', experimentId,
        measurementRevision: measurement.revision, measurementDigest: measurement.digest },
        ...Object.fromEntries(['metric','amount','currency','window','coverage','method','provenance','links'].map(key => [key, measurement[key]])),
        verification: { kind: 'owner_attestation', actorId, verifiedAt: now, measurementDigest: measurement.digest }
      }, { workspaceId, now });
      retry.resolve(Response.json({ publication: { version, head: { workspaceId, versionId: version.versionId, digest: version.digest, status: 'published', publicationId: payload.publicationId } }, replayed: true, isCurrent: true }));
      await until(() => h.$('business-outcomes-status').textContent.includes('Review saved'));
    }
  });

  test(`${kind} response after navigation or replacement session is ignored while current 401 still signs out`, async t => {
    let h = await harness(t); const first = await h.begin(kind);
    h.navigate('overview');
    assert.equal(first.request.config.signal.aborted, true); assert.equal(first.request.config.isCurrent(), false);
    first.hold.resolve(expired()); await new Promise(r => setTimeout(r, 10)); assert.equal(h.signedIn(), true);
    h = await harness(t);
    const old = await h.begin(kind);
    h.logout = deferred(); h.$('logout').click();
    assert.equal(old.request.config.signal.aborted, true, 'logout invalidates outcomes before waiting for its transport');
    h.logout.resolve(Response.json({ ok: true })); await until(() => !h.signedIn());
    h.handler = null; h.logout = null;
    const form = h.$('login-form'); Object.defineProperty(form, 'email', { value: form.elements.email }); Object.defineProperty(form, 'password', { value: form.elements.password });
    form.elements.email.value = 'owner@outcome-app.test'; form.elements.password.value = 'synthetic-only';
    form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true })); await until(h.signedIn);
    old.hold.resolve(expired()); await new Promise(r => setTimeout(r, 10)); assert.equal(h.signedIn(), true);
    const active = await h.begin(kind); active.hold.resolve(expired()); await until(() => !h.signedIn());
    assert.equal(h.panel.open, false);
  });
}

for (const objective of [false, true]) for (const kind of ['save', 'publish']) {
  test(`${objective ? 'objective' : 'manual'} linked ${kind} preserves exact selection and ignores responses after navigation and replacement login`, async t => {
    const h = await harness(t, { linked: true, objective }), old = await h.begin(kind);
    const body = JSON.parse(old.request.config.body);
    if (kind === 'save') assert.deepEqual(body.actionSelection, { actionId: h.action.choice.id });
    else {
      assert.equal(body.expectedMeasurementDigest, h.measurement.digest);
      assert.ok(h.$('business-outcomes-review').textContent.includes(h.action.choice.id));
      assert.match(h.$('business-outcomes-review').textContent, /explicitly associate/);
    }
    h.navigate('overview'); assert.equal(old.request.config.isCurrent(), false); assert.equal(old.request.config.signal.aborted, true);
    h.logout = deferred(); h.$('logout').click(); h.logout.resolve(Response.json({ ok: true })); await until(() => !h.signedIn());
    h.handler = null; h.logout = null;
    const login = h.$('login-form'); Object.defineProperty(login, 'email', { value: login.elements.email }); Object.defineProperty(login, 'password', { value: login.elements.password });
    login.elements.email.value = 'owner@outcome-app.test'; login.elements.password.value = 'synthetic-only'; login.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true })); await until(h.signedIn);
    await h.open(); await h.load();
    const writes = h.calls.filter(c => ['PUT', 'POST'].includes(c.config.method) && c.route.startsWith('/api/business-outcomes')).length;
    old.hold.resolve(expired()); await new Promise(r => setTimeout(r, 20));
    assert.equal(h.signedIn(), true); assert.equal(h.$('business-outcomes-action').value, 'saved');
    assert.equal(h.$('business-outcomes-review').textContent, '', 'the old pending owner review cannot cross sessions');
    assert.equal(h.calls.filter(c => ['PUT', 'POST'].includes(c.config.method) && c.route.startsWith('/api/business-outcomes')).length, writes);
    assert.equal(h.calls.some(c => c.route.includes('/versions/')), false, 'replacement login does not eagerly hydrate action evidence');
  });
}
