import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { upsertBusinessObjective } from '../lib/business-objectives.mjs';
import { detectOpportunities } from '../lib/control.mjs';
import { createSessionToken, hashPasswordAsync } from '../lib/security.mjs';

test('cockpit renders authenticated controls and submits real persisted workflows', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-cockpit-'));
  const secret = 'ui-test-only-session-secret-more-than-32-characters';
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: 'ui-test-only-credential-key-more-than-32-characters', SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' });
  const state = seedWorkspaceState({}, { workspaceId: 'ui-test', email: 'ui@example.test', passwordHash: await hashPasswordAsync('GraphSessionTest!2026') });
  state.products = [{ id: 'p1', title: '<img src=x onerror=alert(1)>', status: 'active', variants: [{ id: 'v1', sku: 'SKU-1', price: 10, inventory: 1, available: true }] }];
  state.products[0].variants.push({ id: 'known-margin', sku: 'KNOWN-MARGIN', price: 10, inventory: 50 }, { id: 'missing-price', sku: 'MISSING-PRICE', price: null, inventory: 50 });
  const completeCosts = { landed: 6, packing: 0, handling: 0, delivery: 0, paymentFee: 0, channelFee: 0, advertising: 0, otherVariable: 0 };
  state.economics['KNOWN-MARGIN'] = { ...completeCosts };
  state.economics['MISSING-PRICE'] = { ...completeCosts };
  state.revenueEngine.quotes = [{ id: 'q1', status: 'draft', lines: [{ sku: 'SKU-1', quantity: 20, unitPrice: 12 }] }];
  detectOpportunities(state);
  const evidencedOpportunity = state.opportunities[0];
  assert.ok(evidencedOpportunity);
  evidencedOpportunity.experimentId = 'verified-ui-experiment';
  state.revenueEngine.experiments = [{id:'verified-ui-experiment',opportunityId:evidencedOpportunity.id,status:'completed',impact:{verified:true,incrementalContribution:12.34}}];
  await server.packsmart.store.save('ui-test', state);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = createSessionToken({ userId: state.users[0].id, workspaceId: 'ui-test', email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  const errors = [], calls = [], console = new VirtualConsole(); console.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8'), { url: base, runScripts: 'outside-only', virtualConsole: console, pretendToBeVisual: true });
  t.after(async () => { dom.window.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const { window } = dom, document = window.document;
  window.Headers = Headers; window.AbortController = AbortController; window.scrollTo = () => {}; window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.fetch = async (route, options = {}) => {
    const headers = new Headers(options.headers); headers.set('Cookie', `packsmart_session=${token}`);
    const response = await fetch(base + route, { ...options, headers });
    if (route === '/api/auth/login' && response.ok) token = response.headers.get('set-cookie').split(';')[0].split('=').slice(1).join('=');
    calls.push({ route, method: options.method || 'GET', status: response.status }); return response;
  };
  const until = async condition => {
    for (let attempt = 0; attempt < 150; attempt++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail(`UI did not reach expected state. Errors: ${errors.join('; ')}; message: ${document.querySelector('#global-error').textContent}`);
  };
  for (const file of ['presentation.js', 'control-ui.js', 'app.js']) window.eval(await fs.readFile(new URL(`../../${file}`, import.meta.url), 'utf8'));
  await until(() => !document.querySelector('#app-shell').classList.contains('hidden'));
  assert.equal(document.querySelector('#kpi-margin').textContent, '40.0%');
  assert.match(document.querySelector('#kpi-margin-coverage').textContent, /1 of 3 catalogue variants · unweighted/);
  assert.match(document.querySelector('#kpi-margin').parentElement.textContent, /Mean known contribution margin/);
  assert.equal(document.querySelector('#kpi-low-margin').textContent, '0 below floor');
  const missingPriceRow = document.querySelector('.economics-row[data-sku="MISSING-PRICE"]');
  assert.match(missingPriceRow.textContent, /Missing Price/);
  assert.doesNotMatch(document.querySelector('#best-products').textContent, /MISSING-PRICE/);
  assert.ok(!calls.some(call => call.route === '/api/migrate-pilot'), 'a future tenant never imports the customer-zero browser cache');
  const investigate = document.querySelector('[data-investigate-opportunity="' + evidencedOpportunity.id + '"]');
  assert.ok(investigate, 'Command links the original durable opportunity');
  assert.match(investigate.closest('li').textContent, /Needs evidence/);
  assert.doesNotMatch(investigate.closest('li').textContent, /Ready for owner review|verified contribution|£12.34/);
  assert.match(document.querySelector('#re-experiment-list').textContent, /Legacy recorded \/ unqualified/);
  assert.match(document.querySelector('#re-experiment-list').textContent, /12.34 recorded contribution/);
  assert.equal((await server.packsmart.store.get('ui-test')).revenueEngine.experiments[0].impact.incrementalContribution,12.34);
  assert.match(document.querySelector('#hypergrowth-evidence-badge').textContent,/1 legacy records · unqualified/);
  assert.match(document.querySelector('#hg-impact').textContent,/ROI unavailable/);
  assert.doesNotMatch(document.querySelector('#hg-impact').textContent,/Verified ROI|£|×/);
  assert.equal(document.querySelector('#hg-value').textContent,'—');
  assert.equal(document.querySelector('#hg-hours').textContent,'—');
  assert.match(document.querySelector('#hg-learning').textContent,/do not establish qualified learning priors/);
  assert.match(document.querySelector('#hg-experiments').textContent,/Legacy reviewed \/ unqualified/);
  assert.doesNotMatch(document.querySelector('#hg-experiments').textContent,/£12.34|Verified result/);
  assert.equal(calls.some(call=>call.route.startsWith('/api/business-outcomes')),false,'descriptive bootstrap display never loads publication proof automatically');
  const beforeInvestigate = calls.length;
  investigate.click();
  assert.equal(document.querySelector('.view.active').id,'view-opportunities');
  assert.equal(document.activeElement.className,'control-record');
  assert.equal(calls.length,beforeInvestigate,'investigation navigates to evidence without requesting approval or executing');
  const graphButton = document.getElementById('load-business-graph');
  const graphDetails = document.querySelector('.business-graph-inspector');
  assert.equal(calls.filter(call => call.route.startsWith('/api/business-graph')).length, 0, 'bootstrap never polls the graph');
  document.querySelector('#main-nav [data-view=overview]').click();
  graphDetails.open = true;
  graphButton.click(); graphButton.click();
  await until(() => !graphButton.disabled);
  assert.equal(calls.filter(call => call.route.startsWith('/api/business-graph')).length, 1, 'repeated clicks coalesce through the disabled button');
  assert.match(document.getElementById('business-graph-result').textContent, /Evidence-backed links/);
  assert.equal(document.getElementById('business-graph-result').querySelector('[onerror]'), null);
  graphDetails.open = false; graphDetails.dispatchEvent(new window.Event('toggle')); graphDetails.open = true;
  assert.equal(calls.filter(call => call.route.startsWith('/api/business-graph')).length, 1, 'close/reopen does not add a provider or graph request');
  const graphFetch = window.fetch;
  window.fetch = async (route, options) => route.startsWith('/api/business-graph') ? Response.json({error:'Temporary graph failure'}, {status:503}) : graphFetch(route, options);
  graphButton.click();
  await until(() => !graphButton.disabled);
  assert.match(document.getElementById('business-graph-result').textContent, /Could not inspect relationships/);
  window.fetch = graphFetch;
  graphButton.click();
  await until(() => !graphButton.disabled);
  assert.match(document.getElementById('business-graph-result').textContent, /Recorded entities inspected/);
  graphDetails.open = false;

  await t.test('objective create, edit, cancel, currency and stale-load flows preserve owner input', async () => {
    const form=document.getElementById('business-objective-form'), fields=form.elements, button=form.querySelector('button[type=submit]');
    assert.equal(calls.filter(call=>call.route==='/api/business-objectives').length,0,'no automatic objective polling');
    const fill = title => {
      fields.title.value=title;fields.metric.value='revenue';fields.direction.value='increase';fields.baseline.value='100';fields.target.value='125';fields.currency.value='GBP';
      fields.startsAt.value=new Date(Date.now()-60000).toISOString().slice(0,16);fields.endsAt.value=new Date(Date.now()+86400000).toISOString().slice(0,16);
      fields.maxMonthlyAdBudget.value='0';fields.minGrossMarginPercent.value='35';
    };
    const submit=()=>form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
    fill('Profitable packaging growth');submit();submit();
    await until(()=>!button.disabled);
    assert.equal(document.getElementById('business-objective-error').textContent,'');
    let saved=await server.packsmart.store.get('ui-test');
    assert.equal(saved.businessObjectives.length,1);assert.equal(saved.businessObjectives[0].limits.maxMonthlyAdBudget,0);
    assert.match(document.getElementById('business-objectives-list').textContent,/Ads ≤ 0 GBP/);
    document.querySelector('[data-edit-objective]').click();fields.status.value='paused';submit();await until(()=>!button.disabled);
    saved=await server.packsmart.store.get('ui-test');assert.equal(saved.businessObjectives[0].status,'paused');assert.equal(saved.businessObjectives[0].revision,2);
    document.querySelector('[data-edit-objective]').click();fields.title.value='Not saved';
    const beforeCancel=calls.length;document.getElementById('cancel-objective-edit').click();assert.equal(calls.length,beforeCancel);assert.equal(form.dataset.objectiveId,undefined);
    const cad=upsertBusinessObjective(saved,{title:'CAD objective',metric:'revenue',baseline:1,target:2,direction:'increase',startsAt:'2026-10-01T01:02:03.456Z',endsAt:'2027-10-01T02:03:04.567Z',limits:{currency:'CAD',minGrossMarginPercent:35.55,minStockCoverDays:1.25,maxMonthlyAdBudget:0.005}});
    await server.packsmart.store.save('ui-test',saved);
    document.getElementById('load-business-objectives').click();await until(()=>!document.getElementById('load-business-objectives').disabled);
    document.querySelector('[data-edit-objective="'+cad.id+'"]').click();assert.equal(fields.currency.value,'CAD');assert.equal(fields.minGrossMarginPercent.validity.stepMismatch,false);assert.equal(fields.minStockCoverDays.validity.stepMismatch,false);assert.equal(fields.maxMonthlyAdBudget.validity.stepMismatch,false);fields.status.value='paused';submit();await until(()=>!button.disabled);
    saved=await server.packsmart.store.get('ui-test');const edited=saved.businessObjectives.find(item=>item.id===cad.id);
    assert.equal(edited.startsAt,cad.startsAt);assert.equal(edited.endsAt,cad.endsAt);assert.equal(edited.limits.currency,'CAD');
    const countGoal=upsertBusinessObjective(saved,{title:'Order count target',metric:'orders',baseline:1,target:2,direction:'increase',startsAt:cad.startsAt,endsAt:cad.endsAt,limits:{currency:null}});
    await server.packsmart.store.save('ui-test',saved);
    document.getElementById('load-business-objectives').click();await until(()=>!document.getElementById('load-business-objectives').disabled);
    document.querySelector('[data-edit-objective="'+countGoal.id+'"]').click();assert.equal(fields.currency.value,'');fields.status.value='paused';submit();await until(()=>!button.disabled);
    assert.equal(document.getElementById('business-objective-error').textContent,'');
    saved=await server.packsmart.store.get('ui-test');assert.equal(saved.businessObjectives.find(item=>item.id===countGoal.id).limits.currency,null);
    let resolveOld;const fetchBefore=window.fetch;
    window.fetch=(route,options={})=>route==='/api/business-objectives' && (!options.method || options.method==='GET') ? new Promise(resolve=>{resolveOld=resolve;}) : fetchBefore(route,options);
    document.getElementById('load-business-objectives').click();await until(()=>Boolean(resolveOld));
    fill('Newer saved objective');submit();await until(()=>!button.disabled);
    assert.match(document.getElementById('business-objectives-list').textContent,/Newer saved objective/);
    resolveOld(Response.json({workspaceId:'ui-test',objectives:[]}));await until(()=>!document.getElementById('load-business-objectives').disabled);
    assert.match(document.getElementById('business-objectives-list').textContent,/Newer saved objective/,'late load cannot replace saved result');
    window.fetch=fetchBefore;
  });
  document.querySelector('[data-view="revenue-engine"]').click();
  assert.equal(document.querySelector('.view.active').id, 'view-revenue-engine');
  assert.equal(document.getElementById('re-pipeline').textContent, '£240.00', 'Revenue Engine renders retained tenant data from bootstrap');
  assert.equal(document.getElementById('re-attribution').textContent, 'Unavailable');
  assert.equal(document.querySelector('[onerror]'), null, 'source text is escaped');
  assert.ok(document.querySelector('#attention-queue .attention-item'));
  assert.ok(!document.getElementById('attention-queue').textContent.includes('No recorded exceptions or approvals need attention.'), 'active exceptions never show an all-clear message');
  const search = document.getElementById('workspace-search-dialog'), searchInput = document.getElementById('workspace-search-input');
  const openingCalls = calls.length;
  document.getElementById('open-workspace-search').click();
  assert.equal(search.open, true);
  assert.equal(document.activeElement, searchInput);
  assert.equal(document.querySelectorAll('.search-result').length, 17);
  searchInput.value = 'billing'; searchInput.dispatchEvent(new window.Event('input'));
  assert.equal(document.querySelectorAll('.search-result').length, 1);
  assert.equal(document.querySelector('.search-result').dataset.viewLink, 'audit');
  searchInput.value = '<img src=x onerror=alert(1)>'; searchInput.dispatchEvent(new window.Event('input'));
  assert.equal(document.querySelectorAll('.search-result').length, 0);
  assert.ok(search.textContent.includes('No matching pages'));
  assert.equal(search.querySelector('[onerror]'), null);
  searchInput.value = 'approval'; searchInput.dispatchEvent(new window.Event('input'));
  searchInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.ok(document.activeElement.classList.contains('search-result'));
  document.activeElement.click();
  assert.equal(search.open, false);
  assert.equal(searchInput.value, '');
  assert.equal(document.querySelector('.view.active').id, 'view-approvals');
  assert.equal(calls.length, openingCalls, 'workspace search is local navigation and does not fetch or mutate data');
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  assert.equal(search.open, true);
  searchInput.value = 'Shopify'; searchInput.dispatchEvent(new window.Event('input'));
  searchInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(document.querySelector('.view.active').id, 'view-channels');
  assert.equal(search.open, false);
  document.getElementById('connection-dialog').showModal();
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  assert.equal(search.open, false, 'search cannot interrupt an existing connection dialog');
  document.getElementById('connection-dialog').close();
  document.querySelector('[data-period="week"]').click();
  assert.equal(document.getElementById('week-metrics').hidden, false);
  assert.equal(document.getElementById('month-metrics').hidden, true);
  assert.equal(document.querySelector('[data-period="week"]').getAttribute('aria-pressed'), 'true');
  document.querySelector('[data-period="month"]').click();
  assert.equal(document.getElementById('week-metrics').hidden, true);
  assert.equal(document.getElementById('month-metrics').hidden, false);
  assert.match(document.getElementById('revenue-chart').textContent, /unverified/i);
  assert.equal(document.getElementById('revenue-chart').querySelector('svg'), null);
  document.querySelector('[data-view="analytics"]').click();
  assert.equal(document.querySelector('.view.active').id, 'view-analytics');
  assert.ok(document.getElementById('analytics-summary').textContent.includes('Runvara'));
  assert.equal(document.getElementById('analytics-orders').textContent, '0');
  for (const button of document.querySelectorAll('#main-nav [data-view]:not(.hidden)')) { button.click(); assert.ok(document.getElementById(`view-${button.dataset.view}`).classList.contains('active')); }
  const decision = document.getElementById('decision-form');
  for (const [key, value] of Object.entries({ key: 'ui-goal', category: 'goal', title: 'A verified UI goal', content: 'Check operations daily.', source: 'DOM integration test' })) decision.elements[key].value = value;
  decision.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => document.getElementById('decision-list').textContent.includes('A verified UI goal'));
  document.getElementById('autopilot-toggle').click();
  await until(() => document.getElementById('autopilot-status').textContent.startsWith('ON'));
  const opportunity = document.querySelector('[data-opportunity]'); assert.ok(opportunity); opportunity.click();
  await until(() => document.querySelector('[data-modify-approval]'));
  document.querySelector('[data-modify-approval]').click();
  const edit = document.getElementById('approval-edit-form'); edit.elements.action.value = 'Revised UI proposal';
  edit.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => document.getElementById('approval-list').textContent.includes('Revised UI proposal'));
  document.querySelector('[data-approval][data-decision="approved"]').click();
  await until(() => calls.some(call => call.route.endsWith('/decision') && call.status === 200));
  const agent = document.querySelector('[data-agent-form="stock"]'); agent.elements.enabled.value = 'false';
  agent.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(async () => (await server.packsmart.store.get('ui-test')).agentSettings.stock.enabled === false);
  await until(() => document.getElementById('global-success').textContent === 'Agent policy saved.');
  const saved = await server.packsmart.store.get('ui-test');
  assert.equal(saved.approvals[0].status, 'approved'); assert.equal(saved.approvals[0].revision, 2);
  assert.equal(saved.approvals[0].executedExternally, false); assert.ok(saved.decisions.some(item => item.key === 'ui-goal'));
  assert.deepEqual(errors, []); assert.ok(!calls.some(call => call.status >= 400));
  await t.test('Commander console renders real delegation and preserves approval gates', async () => {
    const form = document.getElementById('commander-form'), card = form.closest('.command-card');
    const input = form.elements.command, button = form.querySelector('button');
    const result = document.getElementById('commander-result');
    // jsdom does not implement browser named properties on HTMLFormElement.
    Object.defineProperty(form, 'command', { value: input });
    const submit = async command => {
      input.value = command;
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      assert.equal(card.getAttribute('aria-busy'), 'true'); assert.equal(button.disabled, true);
      await until(() => card.getAttribute('aria-busy') === 'false');
      assert.equal(button.disabled, false);
    };
    await submit('Check pricing');
    let recorded = await server.packsmart.store.get('ui-test'), run = recorded.agentRuns[0];
    assert.equal(document.getElementById('commander-error').textContent, '');
    assert.equal(result.classList.contains('hidden'), false);
    assert.equal(result.querySelector('.brief-result-summary').textContent, run.summary);
    assert.deepEqual([...result.querySelectorAll('.delegation-chip')].map(chip => chip.textContent), ['Pricing & Margin']);
    assert.equal(document.getElementById('commander-team-size').textContent, '14 specialists');
    assert.equal(document.querySelectorAll('#agent-grid .agent-mark svg').length, 15);
    assert.equal(document.querySelectorAll('[data-agent-form]').length, 15);
    assert.equal(recorded.products.length, 1);
    assert.equal(run.executedExternally, false);
    assert.equal(result.querySelector('[onerror]'), null);
    await submit('Change prices for all products');
    recorded = await server.packsmart.store.get('ui-test'); run = recorded.agentRuns[0];
    assert.equal(result.querySelector('.brief-result-heading .tag').textContent, 'REQUIRES APPROVAL');
    assert.equal(run.workStatus, 'REQUIRES APPROVAL');
    assert.equal(recorded.approvals.find(item => item.id === run.approvalId).status, 'pending');
    assert.equal(run.executedExternally, false);
    assert.equal(recorded.products[0].variants[0].price, 10);
    assert.equal(result.querySelector('.brief-result-summary').textContent, run.summary);
    recorded.agentSettings.commander.enabled = false;
    await server.packsmart.store.save('ui-test', recorded);
    const runCount = recorded.agentRuns.length;
    await submit('Check pricing');
    assert.match(document.getElementById('commander-error').textContent, /disabled/i);
    assert.equal(input.value, 'Check pricing', 'a failed command remains available to retry');
    assert.equal((await server.packsmart.store.get('ui-test')).agentRuns.length, runCount);
    assert.deepEqual(errors, []);
  });
  const bootstrap = await (await window.fetch('/api/bootstrap')).json();
  for (const scenario of [
    { name: 'legacy positive, negative, zero and null scalars cannot revive financial charts', values: [250, -50, 0, null] },
    { name: 'channel evidence treats no channels as unavailable', values: [] },
    { name: 'channel evidence does not turn unknown scalars into zero', values: [null, undefined] }
  ]) await t.test(scenario.name, async () => {
    const chartErrors = [], virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', error => chartErrors.push(error.message));
    const chartDom = new JSDOM(await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8'), { url: base, runScripts: 'outside-only', virtualConsole });
    try {
      const w = chartDom.window;
      w.Headers = Headers; w.AbortController = AbortController; w.scrollTo = () => {};
      w.RunvaraControl = { init() {}, render() {}, evidence() { return ''; }, history() { return ''; } };
      const data = { ...bootstrap, integrations: scenario.values.map((revenue, index) => ({ id: 'channel-' + index, name: index ? 'Channel ' + index : '<img src=x onerror=alert(1)>', kind: 'commerce', status: 'connected', metrics30d: { revenue } })) };
      w.fetch = async route => new Response(JSON.stringify(route === '/api/auth/session' ? { user: bootstrap.user, workspace: bootstrap.workspace, csrf: bootstrap.csrf } : data), { status: 200 });
      w.eval(await fs.readFile(new URL('../../presentation.js', import.meta.url), 'utf8'));
      w.eval(await fs.readFile(new URL('../../app.js', import.meta.url), 'utf8'));
      for (let i = 0; i < 100 && w.document.getElementById('app-shell').classList.contains('hidden'); i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(w.document.getElementById('app-shell').classList.contains('hidden'), false, w.document.getElementById('startup-error').textContent + '; ' + chartErrors.join('; '));
      const chart = w.document.getElementById('revenue-chart');
      assert.equal(chart.querySelector('[onerror]'), null);
      assert.equal(chart.querySelector('svg'), null, 'unqualified financial scalars cannot produce a chart');
      assert.doesNotMatch(chart.textContent, /£|\$|250|50|£0/);
      if (scenario.values.length) {
        assert.equal(chart.querySelectorAll('details').length, scenario.values.length);
        assert.match(chart.textContent, /Imported order evidence unavailable/);
        assert.match(chart.textContent, /Source-period coverage is unverified/);
      } else assert.ok(chart.textContent.includes('No imported channel evidence is available yet'));
      assert.deepEqual(chartErrors, []);
    } finally { chartDom.window.close(); }
  });
  // A late 401 from the old session must not sign out a newly authenticated one.
  let resolveOldGraph;
  const currentFetch = window.fetch;
  window.fetch = (route, options) => route.startsWith('/api/business-graph') ? new Promise(resolve => { resolveOldGraph = resolve; }) : currentFetch(route, options);
  document.querySelector('#main-nav [data-view=overview]').click();
  graphDetails.open = true;
  document.getElementById('load-business-graph').click();
  await until(() => Boolean(resolveOldGraph));
  document.getElementById('logout').click();
  await until(() => document.getElementById('app-shell').classList.contains('hidden'));
  const loginForm = document.getElementById('login-form');
  Object.defineProperty(loginForm, 'email', {value:loginForm.elements.email});
  Object.defineProperty(loginForm, 'password', {value:loginForm.elements.password});
  loginForm.elements.email.value = 'ui@example.test';
  loginForm.elements.password.value = 'GraphSessionTest!2026';
  loginForm.dispatchEvent(new window.Event('submit', { bubbles:true, cancelable:true }));
  await until(() => !document.getElementById('app-shell').classList.contains('hidden'));
  resolveOldGraph(Response.json({code:'AUTH_REQUIRED'}, {status:401}));
  await until(() => !document.getElementById('load-business-graph').disabled);
  assert.equal(document.getElementById('app-shell').classList.contains('hidden'), false, 'old-session graph failure must not invalidate the new session');
  assert.equal(document.getElementById('business-graph-result').textContent, '', 'old graph results stay cleared after new login');
  window.fetch = currentFetch;
  document.getElementById('signup-form').elements.invitation.required = false;
  document.getElementById('open-workspace-search').click();
  document.getElementById('logout').click();
  await until(() => document.getElementById('app-shell').classList.contains('hidden'));
  await until(() => document.getElementById('signup-form').elements.invitation.required);
  assert.equal(search.open, false, 'sign-out closes the navigation overlay');
  assert.equal(document.getElementById('workspace-search-results').childElementCount, 0);
  assert.equal(document.getElementById('commander-result').childElementCount, 0, 'sign-out clears the previous workspace brief');
  assert.equal(document.getElementById('commander-result').classList.contains('hidden'), true);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  assert.equal(search.open, false, 'a signed-out user cannot open workspace navigation');
});

test('reviewed-result graph inspection has an explicit, session-scoped request lifecycle', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-graph-dom-'));
  const secret = 'graph-dom-fixture-session-secret-more-than-32-characters';
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
    SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' });
  const stored = seedWorkspaceState({}, { workspaceId: 'graph-dom', email: 'graph@example.test', passwordHash: 'fixture-only' });
  await server.packsmart.store.save(stored.workspace.id, stored);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = createSessionToken({ userId: stored.users[0].id, workspaceId: stored.workspace.id, email: stored.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  const bootstrapResponse = await fetch(base + '/api/bootstrap', { headers: { Cookie: `packsmart_session=${token}` } });
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json();
  const [html, presentation, app] = await Promise.all(['../../index.html', '../../presentation.js', '../../app.js'].map(file => fs.readFile(new URL(file, import.meta.url), 'utf8')));
  const graph = () => ({ summary: { nodes: 4, edges: 2, unknownMappings: 1, nodesByType: { reviewed_outcome: 3 }, unknownByReason: { target_not_found: 1 } }, coverage: { complete: true },
    reviewedOutcomes: { status: 'available', unavailableReason: null,
      snapshots: { workspace: { revisionRef: 'workspace_revision_one', readCompletedAt: '2026-10-07T12:00:00.000Z' }, outcomes: { id: 'outcome_snapshot_two', readCompletedAt: '2026-10-07T12:00:01.000Z' }, independent: true },
      counts: { currentHeadsRead: 3, publishedHeads: 2, withdrawnHeads: 1, projectedRecords: 3, resolvedExperimentLinks: 2, unresolvedExperimentLinks: 1, qualifiedMeasurements: 1 },
      coverage: { publicationHeadsComplete: true, retainedGraphComplete: true, projectionComplete: true, completeLifetimeHistoryClaimed: false },
      omitted: { records: 0, relationships: 0, groups: 0, mappings: 0 },
      records: [{ nodeId: 'reviewed_one', versionRef: 'version_one', status: 'published', measurementComplete: true, qualifiedGroupIncluded: true, relationship: { status: 'resolved', reason: null, targetNodeId: 'experiment_one' } },
        { nodeId: 'reviewed_two', versionRef: 'version_two', status: 'published', measurementComplete: true, qualifiedGroupIncluded: false, relationship: { status: 'resolved', reason: null, targetNodeId: 'experiment_two' } },
        { nodeId: 'reviewed_three', versionRef: 'version_three', status: 'withdrawn', measurementComplete: false, qualifiedGroupIncluded: false, relationship: { status: 'unresolved', reason: 'unresolved_reference' } }],
      groups: [{ id: 'group_one', metric: 'incrementalContribution', definitionVersion: 'incremental-contribution/v1', method: 'reconciled_manual', currency: 'GBP',
        window: { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' }, measuredCount: 1, knownZeroCount: 0, negativeCount: 1, positiveCount: 0, amount: '-123456789012345678.123456', amountStatus: 'measured_sum' }],
      limits: { byteLimit: 16384 }, safeguards: { externalWrites: false } } });
  const harness = async () => {
    const errors = [], virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', error => errors.push(error.message));
    const dom = new JSDOM(html, { url: base, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
    const window = dom.window, document = window.document, calls = [], pending = [];
    let control, login = { user: bootstrap.user, workspace: bootstrap.workspace, csrf: bootstrap.csrf }, holdBootstrap, holdLogout, holdPassword;
    window.Headers = Headers; window.AbortController = AbortController; window.scrollTo = () => {};
    window.RunvaraControl = { init(api) { control = api; }, render() {}, evidence() { return ''; }, history() { return ''; } };
    window.fetch = (route, options = {}) => {
      calls.push({ route, options });
      if (route.startsWith('/api/business-graph')) return new Promise((resolve, reject) => pending.push({ resolve, reject, signal: options.signal, options }));
      if (route === '/api/bootstrap' && holdBootstrap) return new Promise(resolve => { holdBootstrap.resolve = resolve; });
      if (route === '/api/auth/logout' && holdLogout) return new Promise(resolve => { holdLogout.resolve = resolve; });
      if (route === '/api/auth/change-password' && holdPassword) return new Promise(resolve => { holdPassword.resolve = resolve; });
      return Promise.resolve(Response.json(route === '/api/bootstrap' ? bootstrap : route === '/api/auth/session' || route === '/api/auth/login' ? login : {}));
    };
    const until = async condition => {
      for (let attempt = 0; attempt < 100; attempt++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
      assert.fail('Graph DOM state did not settle: ' + errors.join('; '));
    };
    window.eval(presentation); window.eval(app);
    await until(() => !document.getElementById('app-shell').classList.contains('hidden'));
    const panel = document.querySelector('.business-graph-inspector'), button = document.getElementById('load-business-graph'), result = document.getElementById('business-graph-result');
    const settle = () => new Promise(resolve => setTimeout(resolve, 10));
    const begin = () => { panel.open = true; button.click(); return pending[pending.length - 1]; };
    const authenticate = payload => {
      login = payload;
      const form = document.getElementById('login-form');
      for (const name of ['email', 'password']) if (!Object.hasOwn(form, name)) Object.defineProperty(form, name, { value: form.elements[name] });
      form.elements.email.value = 'graph@example.test'; form.elements.password.value = 'fixture-only';
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    };
    return { window, document, errors, calls, pending, panel, button, result, begin, settle, until, authenticate, control,
      holdBootstrap() { holdBootstrap = {}; return holdBootstrap; }, holdLogout() { holdLogout = {}; return holdLogout; }, holdPassword() { holdPassword = {}; return holdPassword; },
      login: () => login, close: () => dom.window.close() };
  };

  await t.test('open, focus, repeated click, close and reopen only fetch on explicit inspection', async () => {
    const h = await harness();
    try {
      assert.equal(h.pending.length, 0);
      h.document.getElementById('open-reviewed-results').click();
      assert.equal(h.panel.open, true); assert.equal(h.document.activeElement, h.button); assert.equal(h.pending.length, 0);
      const first = h.begin(); h.button.click(); h.button.dispatchEvent(new h.window.Event('click'));
      assert.equal(h.pending.length, 1); assert.equal(h.calls.filter(call => call.route.startsWith('/api/business-graph'))[0].route, '/api/business-graph?outcomes=current');
      assert.equal(first.options.method || 'GET', 'GET'); assert.ok(first.signal); assert.equal(typeof first.options.isCurrent, 'function');
      first.resolve(Response.json(graph())); await h.until(() => !h.button.disabled);
      assert.match(h.result.textContent, /Published results loaded2/); assert.match(h.result.textContent, /Withdrawn results loaded1/);
      assert.match(h.result.textContent, /-123456789012345678.123456/); assert.match(h.result.textContent, /GBP/);
      assert.match(h.result.textContent, /2026-10-01T00:00:00.000Z/); assert.match(h.result.textContent, /2026-10-06T00:00:00.000Z/);
      assert.match(h.result.textContent, /Excluded or withheld from groups/); assert.match(h.result.textContent, /Experiment absent from retained records; deletion is not established/);
      assert.match(h.result.textContent, /independent, not atomic or synchronized/); assert.match(h.result.textContent, /not commit times or freshness guarantees/);
      h.panel.open = false; h.panel.open = true; await h.settle();
      assert.equal(h.result.textContent, ''); assert.equal(h.pending.length, 1);
      const second = h.begin(); assert.match(h.result.textContent, /^Reading current/); assert.doesNotMatch(h.result.textContent, /workspace_revision_one/);
      second.resolve(Response.json({ error: '<img src=x onerror=alert(1)> failed' }, { status: 503 })); await h.until(() => !h.button.disabled);
      assert.match(h.result.textContent, /Select Inspect reviewed results and links to try again/); assert.equal(h.result.querySelector('[onerror]'), null);
      await h.settle(); assert.equal(h.pending.length, 2, 'errors do not retry automatically');
      const third = h.begin(); third.resolve(Response.json(graph())); await h.until(() => !h.button.disabled);
      assert.match(h.result.textContent, /Snapshot available/); assert.equal(h.pending.length, 3);
      assert.equal(h.document.getElementById('hg-value').textContent, '—'); assert.equal(h.document.getElementById('hg-hours').textContent, '—');
      assert.match(h.document.getElementById('hg-learning').textContent, /do not establish qualified learning priors/);
      assert.equal(h.calls.some(call => call.route.startsWith('/api/business-outcomes')), false);
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  });

  for (const outcome of ['success', 'error', '401', 'network failure']) await t.test('close and navigation discard abandoned ' + outcome + ' and its finally callback', async () => {
    const h = await harness();
    try {
      const old = h.begin(); h.panel.open = false; h.panel.open = true; await h.settle();
      const current = h.begin();
      assert.equal(old.signal.aborted, true); assert.equal(h.pending.length, 2);
      if (outcome === 'network failure') old.reject(new TypeError('Abandoned network failure'));
      else old.resolve(outcome === 'success' ? Response.json(graph()) : Response.json({ code: outcome === '401' ? 'AUTH_REQUIRED' : 'FAILED', error: 'Abandoned failure' }, { status: outcome === '401' ? 401 : 503 }));
      await h.settle(); assert.equal(h.button.disabled, true); assert.match(h.result.textContent, /^Reading current/);
      assert.equal(h.document.getElementById('app-shell').classList.contains('hidden'), false);
      const latest = graph(); latest.reviewedOutcomes.snapshots.workspace.revisionRef = 'new_workspace_snapshot';
      current.resolve(Response.json(latest)); await h.until(() => !h.button.disabled); assert.match(h.result.textContent, /new_workspace_snapshot/);
      const navigated = h.begin(); h.control.setView('ai-team'); assert.equal(navigated.signal.aborted, true); assert.equal(h.result.textContent, '');
      h.control.setView('overview'); h.panel.open = true;
      navigated.resolve(Response.json(graph())); await h.settle();
      assert.equal(h.result.textContent, ''); assert.equal(h.pending.length, 3, 'returning to Command never revives or fetches a snapshot');
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  });

  await t.test('bootstrap resets at request start and does not retain snapshot claims', async () => {
    const h = await harness();
    try {
      const old = h.begin(), blocked = h.holdBootstrap(), loading = h.control.reload({ migrate: false });
      assert.equal(old.signal.aborted, true); assert.equal(h.result.textContent, '');
      old.resolve(Response.json(graph())); await h.settle(); assert.equal(h.result.textContent, '');
      const duringReload = h.begin();
      blocked.resolve(Response.json(bootstrap)); await loading;
      assert.equal(duringReload.signal.aborted, true); assert.equal(h.button.disabled, false);
      duringReload.resolve(Response.json(graph())); await h.settle();
      assert.equal(h.pending.length, 2); assert.equal(h.result.textContent, '');
    } finally { h.close(); }
  });

  for (const replacement of ['same identities', 'different workspace', 'password setup']) await t.test('session replacement invalidates graph work: ' + replacement, async () => {
    const h = await harness();
    try {
      const old = h.begin(), payload = structuredClone(h.login());
      if (replacement === 'different workspace') { payload.workspace.id = 'replacement-workspace'; payload.user.id = 'replacement-user'; payload.csrf = 'replacement-csrf'; }
      if (replacement === 'password setup') payload.user.passwordChangeRequired = true;
      h.authenticate(payload);
      await h.until(() => old.signal.aborted);
      old.resolve(Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 })); await h.settle();
      assert.equal(h.result.textContent, ''); assert.equal(h.button.disabled, false);
      assert.equal(h.document.getElementById('login-screen').classList.contains('hidden'), true, 'stale 401 cannot sign out replacement session');
      assert.equal(h.document.getElementById('password-screen').classList.contains('hidden'), replacement !== 'password setup');
      assert.equal(h.pending.length, 1);
    } finally { h.close(); }
  });

  await t.test('logout clears and aborts immediately, before its network request completes', async () => {
    const h = await harness();
    try {
      const old = h.begin(), logout = h.holdLogout(); h.document.getElementById('logout').click();
      assert.equal(old.signal.aborted, true); assert.equal(h.result.textContent, ''); assert.equal(h.panel.open, false);
      old.resolve(Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 })); await h.settle(); assert.equal(h.result.textContent, '');
      logout.resolve(Response.json({ ok: true })); await h.until(() => !h.document.getElementById('login-screen').classList.contains('hidden'));
      h.authenticate(structuredClone(h.login())); await h.until(() => !h.document.getElementById('app-shell').classList.contains('hidden'));
      assert.equal(h.result.textContent, ''); assert.equal(h.pending.length, 1);
    } finally { h.close(); }
  });

  await t.test('password change invalidates inspection at submission and when the session context changes', async () => {
    const h = await harness();
    try {
      const old = h.begin(), password = h.holdPassword(), form = h.document.getElementById('account-password-form');
      for (const name of ['currentPassword', 'newPassword']) Object.defineProperty(form, name, { value: form.elements[name] });
      form.dispatchEvent(new h.window.Event('submit', { bubbles: true, cancelable: true }));
      assert.equal(old.signal.aborted, true); assert.equal(h.result.textContent, '');
      const newer = h.begin(); password.resolve(Response.json({ csrf: 'changed-password-session' }));
      await h.until(() => newer.signal.aborted); assert.equal(h.button.disabled, false);
      old.resolve(Response.json(graph())); newer.resolve(Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 }));
      await h.settle(); assert.equal(h.result.textContent, '');
      assert.equal(h.document.getElementById('app-shell').classList.contains('hidden'), false);
    } finally { h.close(); }
  });

  await t.test('abandoned callbacks cannot replace a newer explicit-retry message', async () => {
    const h = await harness();
    try {
      const old = h.begin(); h.control.setView('ai-team'); h.control.setView('overview');
      const current = h.begin(); current.resolve(Response.json({ error: 'Latest inspection failed' }, { status: 503 }));
      await h.until(() => !h.button.disabled);
      old.resolve(Response.json(graph())); await h.settle();
      assert.match(h.result.textContent, /Latest inspection failed/); assert.match(h.result.textContent, /try again/);
      assert.equal(h.button.disabled, false);
    } finally { h.close(); }
  });

  await t.test('active-session 401 still signs out normally', async () => {
    const h = await harness();
    try {
      h.begin().resolve(Response.json({ code: 'AUTH_REQUIRED' }, { status: 401 }));
      await h.until(() => !h.document.getElementById('login-screen').classList.contains('hidden'));
      assert.equal(h.result.textContent, ''); assert.equal(h.button.disabled, false);
    } finally { h.close(); }
  });

  await t.test('scoped output escapes payload fields and keeps three completeness claims independent', async () => {
    const h = await harness();
    try {
      const payload = graph(), reviewed = payload.reviewedOutcomes, injection = '<img src=x onerror=alert(1)>';
      reviewed.status = 'incomplete'; reviewed.coverage.retainedGraphComplete = false; reviewed.coverage.projectionComplete = false;
      reviewed.omitted = { records: 2, relationships: 3, groups: 4, mappings: 5 };
      reviewed.snapshots.workspace.revisionRef = injection; reviewed.records[0].versionRef = injection;
      reviewed.records[2].relationship.reason = injection; reviewed.groups[0].currency = injection; reviewed.groups[0].method = injection;
      reviewed.groups[0].definitionVersion = injection; reviewed.groups[0].window.startsAt = injection;
      h.begin().resolve(Response.json(payload)); await h.until(() => !h.button.disabled);
      assert.equal(h.result.querySelector('[onerror]'), null); assert.equal(h.result.querySelector('img'), null);
      assert.match(h.result.textContent, /Complete current-result read/); assert.match(h.result.textContent, /Available relationship recordsIncomplete or unavailable/);
      assert.match(h.result.textContent, /Shown results, links and groupsIncomplete or unavailable/);
      assert.match(h.result.textContent, /Reviewed results omitted2/); assert.match(h.result.textContent, /Experiment links omitted3/); assert.match(h.result.textContent, /Measurement groups omitted4/); assert.match(h.result.textContent, /Unresolved link details omitted5/);
      assert.match(h.result.textContent, /-123456789012345678.123456/);
      reviewed.coverage.publicationHeadsComplete = false;
      h.begin().resolve(Response.json(payload)); await h.until(() => !h.button.disabled);
      assert.match(h.result.textContent, /Exact scoped amountWithheld/); assert.doesNotMatch(h.result.textContent, /-123456789012345678.123456/);
      reviewed.status = 'unavailable'; reviewed.unavailableReason = 'OUTCOME_STORAGE_UNAVAILABLE'; reviewed.counts.currentHeadsRead = null;
      h.begin().resolve(Response.json(payload)); await h.until(() => !h.button.disabled);
      assert.match(h.result.textContent, /Current reviewed results loadedUnknown/); assert.match(h.result.textContent, /does not establish zero outcomes/);
      assert.match(h.result.textContent, /An empty list or zero shown reviewed results does not establish zero tenant outcomes/);
      assert.equal(h.result.querySelectorAll('img').length, 0); assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  });
});
