import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { JSDOM, VirtualConsole } from 'jsdom';
import { receiptUiFixture } from './business-outcomes-receipt-ui-fixture.mjs';
import { objectivePublicationFixture } from './objective-publication-fixture.mjs';
import { fixture as apiFixture, EXPERIMENT as API_EXPERIMENT } from './business-outcomes-api-fixture.mjs';
import { protectedReceiptFixture } from './protected-receipt-source-fixture.mjs';
const html = await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8');
const script = await fs.readFile(new URL('../../outcomes-ui.js', import.meta.url), 'utf8');
const clone = structuredClone;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(fn) { for (let n = 0; n < 250; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail('Protected receipt UI did not settle'); }
const tick = () => new Promise(r => setTimeout(r, 20));
async function harness(t, { fixture = receiptUiFixture(), role = 'owner' } = {}) {
  const errors = [], virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(html, { url: 'https://receipt-ui.example.test', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window, d = w.document; w.TextEncoder = TextEncoder; w.AbortController = AbortController;
  Object.defineProperty(w.crypto, 'subtle', { value: webcrypto.subtle, configurable: true }); w.HTMLElement.prototype.scrollIntoView = () => {};
  t.after(() => { dom.window.close(); assert.deepEqual(errors, []); });
  const h = { f: fixture, w, d, calls: [], context: { workspaceId: fixture.workspaceId, userId: 'owner_one', role, session: {}, view: 'revenue-engine', experiments: [fixture.experiment] } };
  h.handler = fixture.request;
  w.eval(script); w.RunvaraOutcomes.init({ getContext: () => h.context, request: (path, config = {}) => { h.calls.push({ path, ...config }); return h.handler(path, config); } });
  h.$ = id => d.getElementById(id); h.panel = h.$('business-outcomes-panel'); h.form = h.$('business-outcomes-form');
  h.open = async () => { h.panel.open = true; await until(() => h.$('business-outcomes-status').textContent.startsWith('Results loaded')); };
  h.load = async () => { h.$('business-outcomes-experiment').value = fixture.experimentId; h.$('business-outcomes-load').click(); await until(() => /Experiment loaded|Could not load/.test(h.$('business-outcomes-status').textContent)); };
  h.select = (source = fixture.sources[0]) => { const select = h.$('business-outcomes-action'); select.value = typeof source === 'string' ? source : 'receipt:' + source.selector.attemptId; select.dispatchEvent(new w.Event('change', { bubbles: true })); };
  h.preview = async () => { h.d.querySelector('[data-receipt-read="preview"]').click(); await until(() => /preview loaded|source loaded|Could not load|experiment changed/.test(h.$('business-outcomes-status').textContent)); };
  h.page = async kind => { h.d.querySelector(`[data-receipt-read="${kind}"]`).click(); await until(() => /Receipt page loaded|Could not load|experiment changed/.test(h.$('business-outcomes-status').textContent)); };
  h.submit = () => h.form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  h.save = async () => { h.submit(); await until(() => /Draft saved|not confirmed|measurement changed|changed action evidence/.test(h.$('business-outcomes-status').textContent)); };
  h.review = kind => h.d.querySelector(`[data-outcome-action="${kind}"]`).click();
  h.confirm = () => { h.$('business-outcomes-attest').checked = true; h.$('business-outcomes-attest').dispatchEvent(new w.Event('change', { bubbles: true })); h.$('business-outcomes-confirm').click(); };
  h.publish = async kind => { h.review(kind); if (kind === 'withdraw') h.$('business-outcomes-reason').value = 'incorrect_measurement'; h.confirm(); await until(() => /Review saved|not accepted|not received/.test(h.$('business-outcomes-status').textContent)); };
  h.writes = () => h.calls.filter(c => c.method === 'PUT' || c.path.endsWith('/publish'));
  h.receiptReads = () => h.calls.filter(c => c.path.endsWith('/content-sources'));
  await h.open(); await h.load(); return h;
}

test('explicit receipt selection previews one bounded source and saves only three selection assertions', async t => {
  const h = await harness(t), first = h.f.sources[0];
  assert.equal(h.calls.length, 2); assert.equal(h.$('business-outcomes-action').value, '');
  h.select(); assert.equal(h.calls.length, 2); h.submit(); assert.equal(h.writes().length, 0); assert.match(h.$('business-outcomes-status').textContent, /Preview this exact/);
  const button = h.d.querySelector('[data-receipt-read="preview"]'); button.click(); button.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  await until(() => h.$('business-outcomes-status').textContent.includes('preview loaded')); assert.equal(h.receiptReads().length, 1);
  assert.deepEqual(JSON.parse(h.receiptReads()[0].body), { receipt: first.selector, afterAttemptId: null });
  const shown = h.$('business-outcomes-action-details').textContent;
  for (const value of [first.receiptSource.attemptId, first.receiptSource.receiptDigest, first.receiptSource.commitRevision, first.display.completedAt, first.display.input.description]) assert.ok(shown.includes(value));
  assert.match(shown, /Application-observed completion/); assert.match(shown, /not a database commit timestamp/); assert.match(shown, /Provider authentication is not established/);
  assert.equal(h.$('business-outcomes-action-details').querySelector('img,script,[onerror]'), null); assert.equal(h.w.receiptInjected, undefined);
  h.submit(); h.submit(); await until(() => h.$('business-outcomes-status').textContent.includes('Draft saved'));
  assert.equal(h.writes().length, 1); assert.deepEqual(JSON.parse(h.writes()[0].body).actionSelection, { receipt: first.selector });
  assert.equal(h.f.measurement.schema, 'runvara-experiment-measurement/v4'); assert.equal(h.$('business-outcomes-action').value, 'saved');
  const serialized = h.writes()[0].body;
  for (const forbidden of ['receiptSource', 'commitRevision', 'admission', 'authorityDigest', 'sourceTemplate', 'claimIdentity', 'approval']) assert.equal(serialized.includes('"' + forbidden + '"'), false);
  h.review('publish'); assert.match(h.$('business-outcomes-review').textContent, /Protected completion commit revision/); assert.equal(h.$('business-outcomes-confirm').disabled, true);
});

test('paging is explicit, finite and bounded; cursor changes clear receipt selection and keep draft inputs', async t => {
  const h = await harness(t); h.select(); await h.preview(); h.form.elements.amount.value = '4.25';
  await h.page('next'); assert.equal(h.$('business-outcomes-action').value, ''); assert.equal(h.form.elements.amount.value, '4.25');
  assert.equal(h.$('business-outcomes-receipt-preview'), null); assert.equal(h.d.querySelector('[data-receipt-read="next"]'), null);
  assert.equal([...h.$('business-outcomes-action').options].filter(o => o.value.startsWith('receipt:')).length, 2);
  assert.deepEqual(JSON.parse(h.receiptReads().at(-1).body), { receipt: null, afterAttemptId: h.f.sources[19].selector.attemptId });
  const before = h.calls.length; await tick(); assert.equal(h.calls.length, before, 'no automatic page fetch');
  h.select(h.f.sources[21]); await h.preview(); await h.save(); assert.deepEqual(h.f.measurement.receiptSource, h.f.sources[21].receiptSource);
  await h.load(); assert.equal(h.$('business-outcomes-action').value, 'saved'); assert.ok(h.$('business-outcomes-receipt-preview').textContent.includes(h.f.sources[21].display.input.description));
  await h.page('next'); assert.equal(h.$('business-outcomes-action').value, 'saved'); assert.match(h.$('business-outcomes-receipt-preview').textContent, /not been loaded/);
});

test('receipt contracts reject unknown readers, bounds, unsorted duplicates, private fields and invalid cursors without rendering or fallback', async t => {
  const h = await harness(t), base = h.f.detail();
  const mutations = [d => { d.receiptLinkContract = 'future'; }, d => { d.receiptChoices[0].admission = 'PRIVATE'; },
    d => { d.receiptChoices[0].receiptSource.workspaceId = 'foreign'; }, d => { d.receiptChoices[0].receiptSource.commitRevision = 'not-a-uuid'; },
    d => { d.receiptChoices[0].receiptSource.receiptDigest = 'F'.repeat(64); }, d => { d.receiptChoices[0].receiptSource.extra = 'PRIVATE'; },
    d => { d.receiptChoices[0].origin = 'provider_authenticated'; }, d => { d.receiptChoices[0].originatingObjective = {}; },
    d => { d.receiptChoices.reverse(); }, d => { d.receiptChoices[1] = clone(d.receiptChoices[0]); },
    d => { d.receiptChoices.push(clone(d.receiptChoices[0])); }, d => { d.nextReceiptCursor = d.receiptChoices[0].receiptSource.attemptId; },
    d => { d.hasMoreReceipts = false; }, d => { d.hasMoreReceipts = 'false'; }, d => { d.nextReceiptCursor = 'invalid'; },
    d => { d.receiptChoices.forEach(c => { c.actionId = 'x'.repeat(160); c.title = 'x'.repeat(200); c.account = 'x'.repeat(235) + '.myshopify.com'; }); }];
  for (const mutate of mutations) {
    h.handler = async () => { const d = clone(base); mutate(d); return d; }; const count = h.calls.length; await h.load();
    assert.match(h.$('business-outcomes-status').textContent, /Could not load/); assert.equal(h.calls.length, count + 1); assert.equal(h.$('business-outcomes-detail').textContent, '');
    assert.equal(h.d.querySelector('[data-receipt-read]'), null); assert.doesNotMatch(h.d.body.textContent, /PRIVATE/);
  }
  assert.equal(h.writes().length, 0);
});

test('malformed protected previews fail closed and cannot be used to save', async t => {
  const h = await harness(t), f = h.f, source = f.sources[0];
  const mutations = [r => { r.selectedReceiptSource = null; }, r => { r.selectedReceiptSource = clone(source.evidence); },
    r => { r.selectedReceiptSource.schema = 'future'; }, r => { r.selectedReceiptSource.admission = 'PRIVATE'; },
    r => { r.selectedReceiptSource.decision.payload = 'PRIVATE'; }, r => { r.selectedReceiptSource.input.private = 'PRIVATE'; },
    r => { r.selectedReceiptSource.input.description = 'x'.repeat(10001); }, r => { r.selectedReceiptSource.validation.providerAuthentication = 'verified'; },
    r => { r.selectedReceiptSource.validation.protection = 'provider_commit'; }, r => { r.selectedReceiptSource.validation.currentStatus = 'eligible'; },
    r => { r.selectedReceiptSource.receiptSource.receiptDigest = 'a'.repeat(64); }, r => { r.selectedReceiptSource.action.digest = 'b'.repeat(64); },
    r => { r.selectedReceiptSource.account = 'foreign.myshopify.com'; }, r => { r.selectedReceiptSource.input.title = 'Changed preview title'; }];
  for (const mutate of mutations) {
    h.handler = f.request; await h.load(); h.select();
    h.handler = async () => { const r = f.detail({ receipt: source.selector }); mutate(r); return r; }; const before = h.calls.length;
    await h.preview(); assert.match(h.$('business-outcomes-status').textContent, /Could not load/); h.submit();
    assert.match(h.$('business-outcomes-status').textContent, /Preview this exact/); assert.equal(h.calls.length, before + 1); assert.equal(h.writes().length, 0);
    assert.doesNotMatch(h.d.body.textContent, /PRIVATE|Changed preview title/);
  }
});

for (const transition of ['selection', 'close', 'navigate', 'back', 'session', 'account', 'role', 'experiment']) test(`late receipt preview after ${transition} cannot repopulate source or save`, async t => {
  const h = await harness(t); h.select(); const hold = deferred(); h.handler = () => hold.promise;
  h.d.querySelector('[data-receipt-read="preview"]').click(); const request = h.calls.at(-1), old = h.$('business-outcomes-receipt-preview');
  if (transition === 'selection') h.select(h.f.sources[1]);
  if (transition === 'close') { h.panel.open = false; await tick(); }
  if (transition === 'navigate') { h.context.view = 'overview'; h.w.RunvaraOutcomes.pause(); }
  if (transition === 'back') h.w.dispatchEvent(new h.w.PopStateEvent('popstate'));
  if (transition === 'session') { h.context = { ...h.context, session: {} }; h.w.RunvaraOutcomes.reset(); }
  if (transition === 'account') { h.context = { ...h.context, workspaceId: 'other-account' }; h.w.RunvaraOutcomes.reset(); }
  if (transition === 'role') h.context.role = 'viewer';
  if (transition === 'experiment') { h.$('business-outcomes-experiment').value = ''; h.$('business-outcomes-experiment').dispatchEvent(new h.w.Event('change')); }
  hold.resolve(h.f.detail({ receipt: h.f.sources[0].selector })); await tick();
  assert.equal(request.isCurrent(), false); assert.doesNotMatch(old.textContent, /END OF RECEIPT/); assert.equal(h.writes().length, 0);
  if (!['role'].includes(transition)) assert.equal(request.signal.aborted, true);
});

test('stale preview snapshot and nonadvancing page block all writes until an explicit reload', async t => {
  const h = await harness(t); h.select(); h.handler = async () => ({ ...h.f.detail({ receipt: h.f.sources[0].selector }), workspaceRevision: 'newer_workspace' });
  await h.preview(); assert.match(h.$('business-outcomes-status').textContent, /experiment changed/); h.submit(); assert.equal(h.writes().length, 0); assert.equal(h.form.elements.amount.disabled, true);
  h.handler = h.f.request; await h.load(); h.handler = async () => h.f.detail(); await h.page('next');
  assert.match(h.$('business-outcomes-status').textContent, /Could not load/); assert.equal(h.receiptReads().length, 2);
});

test('saved v4 source remains exact through publish, immutable reuse, correction, removal and withdrawal', async t => {
  const h = await harness(t); h.select(); await h.preview(); await h.save(); await h.publish('publish'); await h.load();
  const versionId = h.f.publication.head.versionId, ref = clone(h.f.measurement.receiptSource), first = clone(h.f.measurement);
  const evidenceButton = h.d.querySelector('[data-outcome-source-current]'); evidenceButton.click(); await until(() => evidenceButton.dataset.loaded === 'true');
  assert.match(h.$('business-outcomes-current-source').textContent, /Exact protected action input/); assert.doesNotMatch(h.$('business-outcomes-current-source').textContent, /immutable only when the outcome is published/);
  h.select('reuse:' + versionId); await h.save(); assert.equal(h.f.measurement.intervention.reuseVersionId, versionId); assert.deepEqual(h.f.measurement.receiptSource, ref);
  await h.load(); assert.equal(h.$('business-outcomes-action').value, 'saved'); assert.match(h.d.querySelector('[data-receipt-read="preview"]').textContent, /reused publication/);
  const before = h.receiptReads().length; await h.preview(); assert.equal(h.receiptReads().length, before); assert.ok(h.calls.at(-1).path.endsWith('/versions/' + versionId));
  h.submit(); await until(() => h.$('business-outcomes-status').textContent.includes('Draft saved')); assert.deepEqual(JSON.parse(h.writes().at(-1).body).actionSelection, { reuseVersionId: versionId });
  await h.publish('correct'); await h.load(); h.select(''); await h.save(); assert.equal(h.f.measurement.schema, 'runvara-experiment-measurement/v1');
  assert.equal(JSON.parse(h.writes().at(-1).body).actionSelection, null); const unlinked = h.f.measurement.digest;
  await h.publish('withdraw'); await h.load(); assert.equal(h.f.measurement.digest, unlinked); assert.equal(h.d.querySelector('[data-outcome-action]'), null);
  const current = h.d.querySelector('[data-outcome-source-current]'); current.click(); await until(() => current.dataset.loaded === 'true');
  assert.ok(h.$('business-outcomes-current-source').textContent.includes(first.receiptSource.commitRevision));
});

test('protected objective origin and admin preparation stay separate from owner publication', async t => {
  const sourceFixture = await objectivePublicationFixture(), f = receiptUiFixture({ workspaceId: sourceFixture.workspaceId, sourceFixture });
  const h = await harness(t, { fixture: f, role: 'admin' }); h.select(); await h.preview(); await h.save();
  assert.equal(f.measurement.intervention.origin, 'owner_objective_content'); assert.equal(f.measurement.schema, 'runvara-experiment-measurement/v4');
  assert.ok(h.$('business-outcomes-action-details').textContent.includes(sourceFixture.source.context.originatingObjective.id));
  assert.match(h.$('business-outcomes-detail').textContent, /Only the owner/); assert.equal(h.d.querySelector('[data-outcome-action]'), null);
});

test('protected publication uncertainty freezes exact receipt digest and never retries without an owner action', async t => {
  const h = await harness(t); h.select(); await h.preview(); await h.save(); h.review('publish'); const hold = deferred(); h.handler = () => hold.promise;
  h.confirm(); h.$('business-outcomes-confirm').dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
  const first = h.writes().at(-1); assert.equal(h.writes().length, 2); hold.reject(new Error('lost acknowledgement'));
  await until(() => h.$('business-outcomes-confirm').textContent.includes('Retry same')); const n = h.calls.length; await tick(); assert.equal(h.calls.length, n);
  assert.ok(h.$('business-outcomes-review').textContent.includes(h.f.measurement.receiptSource.receiptDigest)); assert.equal(h.$('business-outcomes-action').disabled, true);
  h.confirm(); await tick(); assert.equal(h.writes().at(-1).body, first.body); assert.equal(h.$('business-outcomes-confirm').disabled, true);
});

test('saved protected draft references, hashes and projected source are validated before any owner review is shown', async t => {
  const f = receiptUiFixture(); f.save({ ...f.input, expectedRevision: f.measurement.revision, actionSelection: { receipt: f.sources[0].selector } });
  const h = await harness(t, { fixture: f }), base = f.detail();
  const mutations = [d => { delete d.measurement.receiptSource; }, d => { delete d.measurement.report.facts.receiptSource; },
    d => { d.measurement.receiptSource.schema = 'future'; }, d => { d.measurement.receiptSource.workspaceId = 'foreign'; },
    d => { d.measurement.receiptSource.sourceDigest = 'b'.repeat(64); }, d => { d.measurement.receiptSource.commitRevision = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; },
    d => { d.measurement.report.facts.receiptSource.receiptDigest = 'b'.repeat(64); }, d => { d.measurement.receiptSource.admission = 'PRIVATE'; },
    d => { d.measurement.report.description = 'changed without rehashing'; }, d => { d.measurement.schema = 'runvara-experiment-measurement/v2'; },
    d => { d.measurement.report.schema = 'runvara-measurement-report/v3'; }, d => { d.receiptLinkContract = null; },
    d => { d.selectedReceiptSource = null; }, d => { d.selectedReceiptSource.approval.id = 'different_approval'; },
    d => { d.selectedReceiptSource.receiptSource.commitRevision = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; }];
  for (const mutate of mutations) {
    h.handler = async () => { const d = clone(base); mutate(d); return d; }; await h.load();
    assert.match(h.$('business-outcomes-status').textContent, /Could not load/); assert.equal(h.d.querySelector('[data-outcome-action]'), null);
    assert.equal(h.$('business-outcomes-action-details').textContent, ''); assert.doesNotMatch(h.d.body.textContent, /PRIVATE/);
  }
  assert.equal(h.writes().length, 0);
});

test('saving cannot silently replace the exact previewed receipt with another valid source', async t => {
  const h = await harness(t); h.select(); await h.preview();
  h.handler = async (path, config) => h.f.request(path, path.endsWith('/measurement') ? { ...config, body: JSON.stringify({ ...JSON.parse(config.body), actionSelection: { receipt: h.f.sources[1].selector } }) } : config);
  await h.save(); assert.match(h.$('business-outcomes-status').textContent, /changed action evidence/); assert.equal(h.writes().length, 1);
  assert.equal(h.form.elements.amount.disabled, true); h.review('publish'); assert.equal(h.$('business-outcomes-review').textContent, '');
  h.submit(); assert.equal(h.writes().length, 1);
});

for (const transition of ['close', 'session', 'account', 'back']) test(`late protected draft save after ${transition} stays stale or outside the replacement session`, async t => {
  const h = await harness(t); h.select(); await h.preview(); const hold = deferred(); let completed;
  h.handler = async (path, config) => { completed = await h.f.request(path, config); return hold.promise; }; h.submit(); await until(() => completed);
  const request = h.calls.at(-1);
  if (transition === 'close') { h.panel.open = false; await tick(); }
  if (transition === 'session') { h.context = { ...h.context, session: {} }; h.w.RunvaraOutcomes.reset(); }
  if (transition === 'account') { h.context = { ...h.context, workspaceId: 'replacement' }; h.w.RunvaraOutcomes.reset(); }
  if (transition === 'back') h.w.dispatchEvent(new h.w.PopStateEvent('popstate'));
  hold.resolve(completed); await tick(); assert.equal(request.isCurrent(), false); assert.equal(h.writes().length, 1);
  assert.doesNotMatch(h.$('business-outcomes-status').textContent, /Draft saved/);
  if (['session', 'account'].includes(transition)) assert.equal(h.$('business-outcomes-detail').textContent, '');
  else { h.panel.open = true; await tick(); assert.equal(h.form.elements.amount.disabled, true); }
});

test('published protected manual source can never reach the legacy raw serializer or render private canaries', async t => {
  const f = receiptUiFixture(); f.save({ ...f.input, expectedRevision: f.measurement.revision, actionSelection: { receipt: f.sources[0].selector } }); f.publish(f.publicationInput());
  const h = await harness(t, { fixture: f }), path = '/api/business-outcomes/versions/' + f.publication.head.versionId, original = await f.request(path);
  const mutations = [r => { r.sourceAction = clone(f.source.source); }, r => { r.sourceAction.receipt = 'PRIVATE'; },
    r => { r.sourceAction.decision.payload = 'PRIVATE'; }, r => { r.sourceAction.validation.providerAuthentication = 'verified'; },
    r => { r.sourceAction.originatingObjective = { id: 'invented' }; }, r => { r.sourceAction.receiptSource.attemptId = 'content_attempt_' + 'a'.repeat(64); },
    r => { r.sourceMeasurement.report.facts.receiptSource.receiptDigest = 'b'.repeat(64); }, r => { r.sourceMeasurement.receiptSource.commitRevision = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; },
    r => { r.sourceMeasurement.report.description = 'PRIVATE'; }, r => { r.publication.version.runvaraAttribution = 'established'; },
    r => { r.selectedEvidence = 'PRIVATE'; }];
  for (const mutate of mutations) {
    h.handler = f.request; await h.load(); h.handler = async () => { const r = clone(original); mutate(r); return r; };
    const before = h.calls.length, button = h.d.querySelector('[data-outcome-source-current]'); button.click(); button.click();
    await until(() => h.$('business-outcomes-status').textContent.includes('Could not load'));
    assert.equal(button.dataset.loaded, undefined); assert.equal(h.$('business-outcomes-current-source').textContent, '');
    assert.equal(h.calls.length, before + 1); assert.doesNotMatch(h.d.body.textContent, /PRIVATE/); assert.equal(h.writes().length, 0);
  }
});

test('saved immutable reuse permits null preview but refuses a downgraded legacy save response', async t => {
  const f = receiptUiFixture(); f.save({ ...f.input, expectedRevision: f.measurement.revision, actionSelection: { receipt: f.sources[0].selector } }); f.publish(f.publicationInput());
  f.save({ ...f.input, expectedRevision: f.measurement.revision, actionSelection: { reuseVersionId: f.publication.head.versionId } });
  const h = await harness(t, { fixture: f }); assert.equal(h.$('business-outcomes-action').value, 'saved');
  assert.match(h.$('business-outcomes-receipt-preview').textContent, /not been loaded/);
  const baseRequest = f.request;
  h.handler = async (path, config) => {
    const result = await baseRequest(path, config);
    if (path.endsWith('/measurement')) { delete result.measurement.receiptSource; delete result.measurement.report.facts.receiptSource; result.measurement.schema = 'runvara-experiment-measurement/v2'; result.measurement.report.schema = 'runvara-measurement-report/v2'; }
    return result;
  };
  await h.save(); assert.match(h.$('business-outcomes-status').textContent, /changed action evidence|not confirmed/); assert.equal(h.form.elements.amount.disabled, true);
  assert.deepEqual(JSON.parse(h.writes()[0].body).actionSelection, { reuseVersionId: f.publication.head.versionId }); assert.equal(h.receiptReads().length, 0);
});

test('real authenticated API responses drive receipt preview, draft, publication and ledger-free historical reuse in JSDOM', async t => {
  const protectedSource = protectedReceiptFixture({ workspaceId: 'outcome-alpha' });
  const f = await apiFixture(t, { linkedContract: 'runvara-reviewed-action/v2', protectedSources: [protectedSource.evidence] });
  const identity = f.auth(), responses = [], bridge = { workspaceId: f.primaryWorkspace, experimentId: API_EXPERIMENT,
    experiment: { id: API_EXPERIMENT, title: 'Actual API protected-source review' }, sources: [protectedSource] };
  bridge.request = async (path, config = {}) => {
    const response = await f.request(path, { method: config.method || 'GET', ...(config.body ? { rawBody: config.body } : {}), identity });
    responses.push({ path, ...response }); if (response.status >= 400) throw Object.assign(new Error('Actual API rejected fixture request'), { status: response.status });
    if (response.body.publication) bridge.publication = response.body.publication;
    return response.body;
  };
  const h = await harness(t, { fixture: bridge }), measurement = () => f.states.get(f.primaryWorkspace).revenueEngine.experiments[0].outcomeMeasurement;
  assert.equal(h.calls.length, 2); h.select(); const beforePreview = f.calls.length; await h.preview(); assert.equal(f.calls.length, beforePreview + 1);
  assert.match(h.$('business-outcomes-action-details').textContent, /Application-observed completion/);
  const beforeSave = f.calls.length; await h.save(); assert.equal(f.calls.length, beforeSave + 1); assert.equal(measurement().schema, 'runvara-experiment-measurement/v4');
  assert.match(h.$('business-outcomes-status').textContent, /Draft saved/); assert.equal(h.$('business-outcomes-action').value, 'saved');
  const original = clone(measurement()), beforePublish = f.calls.length; await h.publish('publish'); assert.equal(f.calls.length, beforePublish + 1); await h.load();
  assert.equal(h.$('business-outcomes-action').value, 'saved'); assert.ok(h.$('business-outcomes-receipt-preview').textContent.includes(protectedSource.source.input.description));
  const versionId = bridge.publication.head.versionId, button = h.d.querySelector('[data-outcome-source-current]'); button.click(); await until(() => button.dataset.loaded === 'true');
  assert.match(h.$('business-outcomes-current-source').textContent, /Exact protected action input/);
  // Remove all current source availability after the immutable publication.
  f.protectedEvidence.clear(); const state = f.states.get(f.primaryWorkspace); delete state.approvals; delete state.connectionWrites; delete state.connections;
  h.select('reuse:' + versionId); await h.save(); assert.equal(measurement().intervention.reuseVersionId, versionId); assert.deepEqual(measurement().receiptSource, original.receiptSource);
  await h.load(); assert.match(h.$('business-outcomes-status').textContent, /Experiment loaded/); assert.match(h.$('business-outcomes-receipt-preview').textContent, /not been loaded/);
  const readCount = h.receiptReads().length; await h.preview(); assert.equal(h.receiptReads().length, readCount); assert.ok(h.calls.at(-1).path.endsWith('/versions/' + versionId));
  await h.publish('correct'); await h.load(); assert.equal(bridge.publication.version.revision, 2);
  await h.publish('withdraw'); await h.load(); assert.equal(bridge.publication.head.status, 'withdrawn'); assert.equal(h.d.querySelector('[data-outcome-action]'), null);
  assert.equal(f.counts.providerCalls, 0); assert.equal(f.protectedEvidence.size, 0);
  for (const response of responses) for (const key of ['admission', 'authorityDigest', 'actorSessionVersion', 'claimIdentity', 'stableApproval', 'dispatchRequestDigest'])
    assert.equal(JSON.stringify(response.body).includes('"' + key + '"'), false, key);
});
