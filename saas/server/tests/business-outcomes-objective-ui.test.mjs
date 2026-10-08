// Consume real authenticated API responses and production DTO validators in
// JSDOM. Only the durable database/provider transports are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { fixture, BASE, REVIEW, MEASURE, EXPERIMENT } from './business-outcomes-api-fixture.mjs';
import { objectivePublicationFixture } from './objective-publication-fixture.mjs';
import { actionUiFixture } from './business-outcomes-action-ui-fixture.mjs';
import { digestMeasurementValue } from '../lib/experiment-measurements.mjs';

const html = await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8');
const script = await fs.readFile(new URL('../../outcomes-ui.js', import.meta.url), 'utf8');
const clone = structuredClone;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(predicate) { for (let n = 0; n < 300; n++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail('Objective outcome UI did not settle'); }
async function harness(t, { role = 'owner', published = false, linked = false, contentInput } = {}) {
  const source = await objectivePublicationFixture({ contentInput: contentInput || { title: 'Captured <img src=x onerror="window.objectiveInjected=true"> title', description: 'Retained <script>window.objectiveInjected=true</script>\n' + 'Exact content '.repeat(30) } });
  const f = await fixture(t, { primaryState: source.state, linkedContract: 'runvara-reviewed-action/v2' });
  const workspaceId = f.primaryWorkspace, identity = f.auth(workspaceId, role), errors = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, { url: 'https://outcome-objective.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window, d = w.document; w.TextEncoder = TextEncoder; w.AbortController = AbortController;
  Object.defineProperty(w.crypto, 'subtle', { value: webcrypto.subtle, configurable: true }); w.HTMLElement.prototype.scrollIntoView = () => {};
  t.after(() => { dom.window.close(); assert.deepEqual(errors, []); assert.equal(f.counts.providerCalls, 0); });
  const h = { f, source, workspaceId, w, d, calls: [], responses: [], context: { workspaceId, userId: role === 'owner' ? source.state.users[0].id : `${workspaceId}-${role}`, role, session: {}, view: 'revenue-engine', experiments: [{ id: EXPERIMENT, title: 'Retained contribution review' }] } };
  h.actual = async (path, config = {}) => {
    const result = await f.request(path, { method: config.method || 'GET', ...(config.body ? { rawBody: config.body } : {}), identity });
    h.responses.push({ path, result });
    if (result.status >= 400) throw Object.assign(new Error('Synthetic API request rejected'), { status: result.status });
    return result.body;
  };
  h.handler = h.actual;
  w.eval(script); w.RunvaraOutcomes.init({ getContext: () => h.context, request: (path, config = {}) => { h.calls.push({ path, ...config }); return h.handler(path, config); } });
  h.$ = id => d.getElementById(id); h.panel = h.$('business-outcomes-panel'); h.form = h.$('business-outcomes-form');
  h.open = async () => { h.panel.open = true; await until(() => h.$('business-outcomes-status').textContent.startsWith('Results loaded')); };
  h.load = async () => { h.$('business-outcomes-experiment').value = EXPERIMENT; h.$('business-outcomes-load').click(); await until(() => /Experiment loaded|Could not load/.test(h.$('business-outcomes-status').textContent)); };
  h.select = value => { h.$('business-outcomes-action').value = value; h.$('business-outcomes-action').dispatchEvent(new w.Event('change', { bubbles: true })); };
  h.submit = () => h.form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  h.save = async () => { h.submit(); await until(() => /Draft saved|not confirmed|measurement changed/.test(h.$('business-outcomes-status').textContent)); };
  h.review = kind => d.querySelector(`[data-outcome-action="${kind}"]`).click();
  h.confirm = () => { h.$('business-outcomes-attest').checked = true; h.$('business-outcomes-attest').dispatchEvent(new w.Event('change', { bubbles: true })); h.$('business-outcomes-confirm').click(); };
  h.publish = async kind => { h.review(kind); if (kind === 'withdraw') h.$('business-outcomes-reason').value = 'incorrect_measurement'; h.confirm(); await until(() => /Review saved|not accepted|not received/.test(h.$('business-outcomes-status').textContent)); };
  h.evidence = async () => { const button = d.querySelector('[data-outcome-source-current]') || d.querySelector('[data-outcome-evidence]'); button.click(); await until(() => button.dataset.loaded === 'true' || h.$('business-outcomes-status').textContent.includes('Could not load')); return button; };
  h.writes = () => h.calls.filter(c => ['POST', 'PUT'].includes(c.method));
  h.measurement = () => f.states.get(workspaceId).revenueEngine.experiments[0].outcomeMeasurement;
  await h.open(); await h.load();
  if (linked || published) {
    if (role === 'owner' || role === 'admin') { h.select('action:' + source.write.id); await h.save(); }
    else {
      const owner = f.auth(workspaceId), before = h.measurement();
      const result = await f.request(MEASURE, { method: 'PUT', identity: owner, body: { expectedRevision: before.revision, actionSelection: { actionId: source.write.id }, amount: before.amount, currency: before.currency, window: before.window, coverage: { status: before.coverage.status, observedCount: before.coverage.observedCount, expectedCount: before.coverage.expectedCount }, method: { kind: before.method.kind }, observedAt: before.provenance.observedAt, report: { description: before.report.description, costsComplete: before.report.costsComplete } } });
      assert.equal(result.status, 200);
    }
    if (published) {
      const result = await f.request(BASE + '/publish', { method: 'POST', body: f.publicationInput(workspaceId), identity: f.auth(workspaceId) }); assert.equal(result.status, 200);
      h.initialPublication = result.body.publication;
      if (role === 'owner' || role === 'admin') await h.load();
      else { h.$('business-outcomes-refresh').click(); await until(() => h.$('business-outcomes-summary').querySelector('[data-outcome-evidence]')); }
    }
  }
  return h;
}

test('actual objective API selection, review, publication, exact public evidence, correction reuse and withdrawal are consumed end to end', async t => {
  const h = await harness(t), origin = h.source.source.context.originatingObjective;
  const field = h.$('business-outcomes-action'); assert.equal(field.value, ''); assert.equal(field.options.length, 2);
  const before = h.calls.length; h.select('action:' + h.source.write.id); assert.equal(h.calls.length, before);
  const selection = h.$('business-outcomes-action-details').textContent;
  for (const value of [origin.id, String(origin.revision), origin.digest, h.source.write.account, h.source.write.input.productId]) assert.ok(selection.includes(value));
  assert.match(selection, /does not establish.*objective progress/);
  h.submit(); h.submit(); await until(() => h.$('business-outcomes-status').textContent.includes('Draft saved'));
  assert.equal(h.writes().length, 1); assert.deepEqual(JSON.parse(h.writes()[0].body).actionSelection, { actionId: h.source.write.id });
  assert.equal(h.measurement().schema, 'runvara-experiment-measurement/v3'); assert.equal(h.measurement().report.schema, 'runvara-measurement-report/v3');
  assert.equal(h.measurement().links.objective, null); assert.equal(h.measurement().links.opportunity, null);
  h.review('publish'); assert.match(h.$('business-outcomes-review').textContent, new RegExp(origin.id));
  assert.equal(h.$('business-outcomes-confirm').disabled, true); h.$('business-outcomes-cancel').click(); assert.equal(h.writes().length, 1);
  await h.publish('publish'); assert.match(h.$('business-outcomes-status').textContent, /Review saved/); await h.load();
  const firstVersion = [...h.f.rows.values()][0], beforeEvidence = h.calls.length;
  const button = await h.evidence(); assert.equal(button.dataset.loaded, 'true'); button.click(); assert.equal(h.calls.length, beforeEvidence + 1);
  const evidence = h.$('business-outcomes-current-source');
  assert.ok(evidence.textContent.includes(h.source.source.input.description)); assert.ok(evidence.textContent.includes(h.source.source.input.title));
  assert.match(evidence.textContent, /server validated the complete private action snapshot/); assert.match(evidence.textContent, /cannot recompute the private action snapshot digest/);
  assert.equal(evidence.querySelector('img,script,[onerror]'), null); assert.equal(h.w.objectiveInjected, undefined);
  const publicBody = h.responses.find(r => r.path.includes('/versions/')).result.body;
  assert.equal(publicBody.sourceAction.schema, 'runvara-reviewed-source-action-display/v2');
  for (const field of ['context', 'stableApproval', 'proposal', 'claimIdentity', 'securityEpoch', 'approvalDigest', 'dispatchRequestDigest']) assert.equal(Object.hasOwn(publicBody.sourceAction, field), false);
  // Correction consumes the retained immutable source even after its mutable origin disappears.
  const state = h.f.states.get(h.workspaceId); state.connectionWrites = []; state.approvals = []; state.businessObjectives = [];
  await h.load(); h.submit(); assert.match(h.$('business-outcomes-status').textContent, /no longer an exact current choice/);
  assert.equal(h.writes().length, 2);
  h.select('reuse:' + firstVersion.version_id); h.form.elements.amount.value = '7.5'; await h.save();
  assert.equal(h.measurement().intervention.reuseVersionId, firstVersion.version_id); assert.deepEqual(h.measurement().intervention.originatingObjective, origin);
  await h.publish('correct'); assert.match(h.$('business-outcomes-status').textContent, /Review saved/); await h.load(); await h.evidence();
  const correction = [...h.f.rows.values()].find(r => r.revision === 2); assert.deepEqual(correction.source_action, firstVersion.source_action);
  // A separate unlinked draft never rewrites the published historical origin.
  h.select(''); await h.save(); assert.equal(h.measurement().schema, 'runvara-experiment-measurement/v1');
  assert.equal(JSON.parse(h.writes().at(-1).body).actionSelection, null); const unlinkedDigest = h.measurement().digest;
  await h.publish('withdraw'); assert.match(h.$('business-outcomes-status').textContent, /Review saved/); await h.load(); await h.evidence();
  const withdrawn = [...h.f.rows.values()].find(r => r.revision === 3); assert.deepEqual(withdrawn.source_action, firstVersion.source_action);
  assert.equal(h.measurement().digest, unlinkedDigest); assert.equal(h.d.querySelector('[data-outcome-action]'), null);
  assert.equal([...field.options].some(o => o.value.startsWith('reuse:')), false);
  assert.ok(h.$('business-outcomes-current-source').textContent.includes(origin.id));
  assert.equal(h.f.counts.providerCalls, 0);
});

test('public v2 evidence rejects private canaries, future fields, wrong origin, linkage and validation labels without fallback or retry', async t => {
  const h = await harness(t, { published: true });
  const detail = await h.actual(REVIEW), evidence = await h.actual(BASE + '/versions/' + h.initialPublication.version.versionId);
  const mutations = [
    r => { r.privateSource = 'PRIVATE-CANARY'; }, r => { r.publication.head.future = 'PRIVATE-CANARY'; }, r => { r.publication.version.future = 'PRIVATE-CANARY'; },
    r => { r.sourceAction = clone(h.source.source); }, r => { r.sourceAction = null; },
    r => { r.sourceAction.schema = 'runvara-reviewed-source-action-display/v3'; },
    ...['context', 'stableApproval', 'proposal', 'claimIdentity', 'securityEpoch'].map(key => r => { r.sourceAction[key] = 'PRIVATE-CANARY'; }),
    r => { r.sourceAction.input.extra = 'PRIVATE-CANARY'; }, r => { r.sourceAction.decision.payload = 'PRIVATE-CANARY'; },
    r => { r.sourceAction.origin = 'owner_manual'; }, r => { r.sourceAction.originatingObjective = null; },
    r => { r.sourceAction.originatingObjective.workspaceId = 'foreign'; }, r => { r.sourceAction.originatingObjective.revision++; },
    r => { r.sourceAction.action.digest = 'a'.repeat(64); }, r => { r.sourceAction.approval.id = 'foreign-approval'; },
    r => { r.sourceAction.account = 'other.myshopify.com'; }, r => { r.sourceAction.completedAt = '2026-02-30T00:00:00.000Z'; },
    r => { r.sourceAction.policies = []; }, r => { r.sourceAction.policies[0].digest = 'c'.repeat(64); },
    r => { r.sourceAction.policies.push(clone(r.sourceAction.policies[0])); },
    r => { r.sourceAction.validation.snapshot = 'browser_verified'; }, r => { r.sourceAction.validation.providerAuthentication = 'verified'; },
    r => { r.sourceAction.validation.goalAttainment = true; }, r => { r.sourceAction.input.description = 'x'.repeat(10001); },
    r => { r.sourceMeasurement.report.description = 'PRIVATE-CANARY'; }, r => { r.sourceMeasurement.report.future = 'PRIVATE-CANARY'; },
    r => { r.publication.version.lineage.future = 'PRIVATE-CANARY'; }, r => { r.publication.version.runvaraAttribution = 'established'; }
  ];
  for (const mutate of mutations) {
    h.handler = async () => clone(detail); await h.load();
    h.handler = async () => { const result = clone(evidence); mutate(result); return result; };
    const before = h.calls.length, button = await h.evidence();
    assert.equal(button.dataset.loaded, undefined); assert.equal(h.$('business-outcomes-current-source').textContent, '');
    assert.equal(h.calls.length, before + 1); assert.equal(h.writes().length, 1);
    assert.doesNotMatch(h.d.body.textContent, /PRIVATE-CANARY/);
  }
});

test('objective draft schemas, public hashes and captured origin reject future, stale and foreign contracts before review', async t => {
  const h = await harness(t, { linked: true });
  const detail = await h.actual(REVIEW);
  const mutations = [d => { d.measurement.schema = 'runvara-experiment-measurement/v4'; }, d => { d.measurement.schema = 'runvara-experiment-measurement/v2'; },
    d => { d.measurement.report.schema = 'runvara-measurement-report/v2'; }, d => { d.measurement.intervention.schema = 'runvara-owner-action-association/v3'; },
    d => { d.measurement.report.facts.intervention.origin = 'owner_manual'; }, d => { d.measurement.intervention.originatingObjective = null; },
    d => { d.measurement.intervention.originatingObjective.workspaceId = 'foreign'; }, d => { d.measurement.intervention.originatingObjective.revision = 0; },
    d => { d.measurement.intervention.originatingObjective.future = 'PRIVATE-CANARY'; }, d => { d.measurement.report.facts.future = 'PRIVATE-CANARY'; },
    d => { d.measurement.report.description = 'Changed without a matching hash'; }, d => { d.measurement.future = 'PRIVATE-CANARY'; },
    d => { d.measurement.links.objective = d.measurement.intervention.originatingObjective; },
    d => { d.measurement.intervention.comparison = 'established'; }, d => { d.actionLinkContract = 'runvara-reviewed-action/v1'; },
    d => { d.actionLinkContract = 'runvara-reviewed-action/v3'; }
  ];
  for (const mutate of mutations) {
    h.handler = async () => { const result = clone(detail); mutate(result); return result; };
    await h.load(); assert.match(h.$('business-outcomes-status').textContent, /Could not load/);
    assert.equal(h.$('business-outcomes-detail').textContent, ''); assert.equal(h.d.querySelector('[data-outcome-action]'), null); assert.doesNotMatch(h.d.body.textContent, /PRIVATE-CANARY/);
  }
});

test('forward action choices keep manual compatibility and fail closed for legacy storage, malformed references and bounded choices', async t => {
  const h = await harness(t), base = await h.actual(REVIEW), manual = actionUiFixture(h.workspaceId);
  for (const marker of ['runvara-reviewed-action/v1', 'runvara-reviewed-action/v2']) {
    h.handler = async () => ({ ...clone(base), actionLinkContract: marker, actionChoices: [manual.choice] }); await h.load();
    assert.equal(h.$('business-outcomes-action').disabled, false); assert.equal(h.$('business-outcomes-action').value, '');
    if (marker.endsWith('/v1')) assert.match(h.$('business-outcomes-action-hint').textContent, /manual actions only/);
  }
  const mutations = [d => { d.actionLinkContract = 'runvara-reviewed-action/v1'; }, d => { d.actionLinkContract = 'future'; },
    d => { d.actionChoices[0].originatingObjective.revision = 0; }, d => { d.actionChoices[0].originatingObjective.workspaceId = 'foreign'; },
    d => { d.actionChoices[0].originatingObjective.future = 'PRIVATE-CANARY'; }, d => { d.actionChoices[0].stableApproval = 'PRIVATE-CANARY'; },
    d => { d.actionChoices = Array(21).fill(d.actionChoices[0]); }, d => { d.actionChoices.push(clone(d.actionChoices[0])); },
    d => { const c = d.actionChoices[0]; d.actionChoices = Array.from({ length: 20 }, (_, i) => ({ ...clone(c), id: 'action_' + i + 'x'.repeat(145), title: 'x'.repeat(200), originatingObjective: { ...c.originatingObjective, id: 'objective_' + 'x'.repeat(145), workspaceId: h.workspaceId } })); }
  ];
  for (const mutate of mutations) {
    const detail = clone(base); mutate(detail); h.handler = async () => detail; await h.load();
    assert.equal(h.$('business-outcomes-action').disabled, true); assert.equal(h.$('business-outcomes-action').value, '');
    assert.match(h.$('business-outcomes-action-hint').textContent, /linking is unavailable/); assert.doesNotMatch(h.d.body.textContent, /PRIVATE-CANARY/);
  }
});

test('unknown objective publication outcome retains exact intent through repeated click, close and explicit retry', async t => {
  const h = await harness(t, { linked: true }); h.review('publish');
  const hold = deferred(); h.handler = async (path, config) => path === BASE + '/publish' ? hold.promise : h.actual(path, config);
  h.confirm(); h.$('business-outcomes-confirm').dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  assert.equal(h.writes().filter(c => c.method === 'POST').length, 1); const first = h.writes().at(-1);
  hold.reject(new Error('Unknown publication outcome')); await until(() => h.$('business-outcomes-confirm').textContent.includes('Retry same'));
  const origin = h.source.source.context.originatingObjective; assert.ok(h.$('business-outcomes-review').textContent.includes(origin.id));
  assert.equal(h.$('business-outcomes-confirm').disabled, true); h.$('business-outcomes-cancel').click();
  h.panel.open = false; await new Promise(r => setTimeout(r, 10)); h.panel.open = true; await until(() => !h.$('business-outcomes-review').classList.contains('hidden'));
  assert.equal(h.writes().filter(c => c.method === 'POST').length, 1); h.handler = h.actual; h.confirm();
  await until(() => h.$('business-outcomes-status').textContent.includes('Review saved'));
  assert.equal(h.writes().at(-1).body, first.body); assert.equal(h.writes().filter(c => c.method === 'POST').length, 2);
});

for (const role of ['admin', 'member', 'viewer']) test(`${role} preserves objective evidence reader access and separate owner-only publication`, async t => {
  const h = await harness(t, { role, published: true }); assert.equal(h.d.querySelector('[data-outcome-action]'), null);
  assert.equal(h.form.classList.contains('hidden'), role !== 'admin');
  const before = h.writes().length; if (role !== 'admin') h.submit(); assert.equal(h.writes().length, before);
  const button = await h.evidence(); assert.equal(button.dataset.loaded, 'true'); assert.match(button.nextElementSibling.textContent, /Captured objective ID/);
});

for (const transition of ['close', 'navigation', 'back', 'session', 'workspace']) test(`late objective public hash completion after ${transition} cannot render or retry`, async t => {
  const h = await harness(t, { published: true }), hold = deferred(); let started = false;
  Object.defineProperty(h.w.crypto, 'subtle', { value: { digest: async (...args) => { started = true; await hold.promise; return webcrypto.subtle.digest(...args); } } });
  h.d.querySelector('[data-outcome-source-current]').click(); await until(() => started); const target = h.$('business-outcomes-current-source'), before = h.calls.length;
  if (transition === 'close') h.panel.open = false;
  else if (transition === 'navigation') { h.context.view = 'overview'; h.w.RunvaraOutcomes.pause(); }
  else if (transition === 'back') h.w.dispatchEvent(new h.w.PopStateEvent('popstate'));
  else { h.context = { ...h.context, session: {}, ...(transition === 'workspace' ? { workspaceId: 'different-tenant', experiments: [] } : {}) }; h.w.RunvaraOutcomes.reset(); }
  hold.resolve(); await new Promise(r => setTimeout(r, 30)); assert.equal(target.textContent, ''); assert.equal(h.calls.length, before);
});

test('objective public hash check rejects coherently rehashed report facts that contradict the recorded measurement', async t => {
  const h = await harness(t, { linked: true }); h.handler = async (path, config) => {
    const result = await h.actual(path, config); if (path === REVIEW) {
      const m = result.measurement; m.report.facts.amount = '999';
      const { digest: reportDigest, ...r } = m.report; m.report.digest = digestMeasurementValue(r); m.provenance.sourceRefs[0].digest = m.report.digest;
      const { digest: measurementDigest, ...body } = m; m.digest = digestMeasurementValue(body);
    } return result;
  };
  await h.load(); assert.match(h.$('business-outcomes-status').textContent, /Could not load/); assert.equal(h.$('business-outcomes-detail').textContent, '');
});

for (const change of ['digest', 'objective', 'origin']) test(`changed first-selection ${change} in the saved response requires explicit reload and fresh review`, async t => {
  const h = await harness(t);
  h.handler = async (path, config) => {
    const result = await h.actual(path, config);
    if (path === REVIEW) {
      const choice = result.actionChoices[0];
      if (change === 'digest') choice.digest = 'd'.repeat(64);
      if (change === 'objective') choice.originatingObjective.revision++;
      if (change === 'origin') { delete choice.origin; delete choice.originatingObjective; }
    }
    return result;
  };
  await h.load(); h.select('action:' + h.source.write.id); h.submit();
  await until(() => h.$('business-outcomes-status').textContent.includes('draft was saved with changed action evidence'));
  assert.equal(h.measurement().schema, 'runvara-experiment-measurement/v3'); assert.equal(h.writes().length, 1);
  assert.equal(h.d.querySelector('[data-outcome-action="publish"]').disabled, true);
  h.d.querySelector('[data-outcome-action="publish"]').dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  assert.equal(h.$('business-outcomes-review').textContent, ''); assert.equal(h.writes().length, 1);
  h.handler = h.actual; await h.load();
  assert.equal(h.d.querySelector('[data-outcome-action="publish"]').disabled, false);
  h.review('publish'); assert.ok(h.$('business-outcomes-review').textContent.includes(h.source.source.context.originatingObjective.id));
  assert.equal(h.$('business-outcomes-confirm').disabled, true); assert.equal(h.writes().length, 1);
});

test('a captured objective association cannot bypass incomplete-cost financial review blockers', async t => {
  const h = await harness(t); h.select('action:' + h.source.write.id); h.form.elements.costsComplete.value = 'false'; await h.save();
  assert.equal(h.measurement().schema, 'runvara-experiment-measurement/v3'); assert.equal(h.d.querySelector('[data-outcome-action]'), null);
  assert.match(h.$('business-outcomes-detail').textContent, /Some relevant costs are missing/); assert.equal(h.writes().length, 1);
});
