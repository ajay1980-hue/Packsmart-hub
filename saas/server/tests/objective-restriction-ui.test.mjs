// Real app HTML/JS, synthetic workspace definitions, and controlled responses only.
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

const NOW = '2026-10-07T12:00:00.000Z', API = '/api/business-objectives';
const schema = 'runvara-objective-execution-policy/v1';
const copy = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { resolve, reject, promise }; };
const delay = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(condition, detail = () => '') {
  for (let i = 0; i < 200; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Restriction UI did not settle: ' + detail());
}
const connection = (id = 'conn_fixture_a', account = 'fixture-a.myshopify.com') => ({ id, provider: 'shopify', status: 'disconnected', label: '<img src=x onerror="window.injected=true">', metadata: { shopDomain: account } });
const policy = (row = connection()) => ({ schema, mode: 'enforce', scope: { provider: 'shopify', operation: 'product_content', connectionId: row.id, account: row.metadata.shopDomain } });
async function harness(t, { role = 'owner', connections = [connection(), connection('conn_fixture_b', 'fixture-b.myshopify.com')], enforced = false, limits = {} } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-restriction-ui-'));
  const secret = 'synthetic-restriction-test-only-over-thirty-two-characters';
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret, SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' });
  const state = seedWorkspaceState({}, { workspaceId: 'restriction-ui', name: 'Synthetic restriction workspace', email: 'restriction@example.test', passwordHash: 'fixture-only' });
  state.products = []; state.connections = [connection(), connection('conn_fixture_b', 'fixture-b.myshopify.com')];
  const objective = upsertBusinessObjective(state, { title: 'Saved profit conditions', metric: 'contribution_profit', baseline: null, target: 100.005, direction: 'increase', startsAt: '2026-10-01T01:02:03.456Z', endsAt: '2027-10-01T02:03:04.567Z', limits: {
    currency: 'CAD', minGrossMarginPercent: 0, maxMonthlyAdBudget: 0, minStockCoverDays: 1.25, profitFirst: true, approvalRequiredKinds: ['supplier_order'], ...limits }, ...(enforced ? { executionPolicy: policy() } : {}) }, { workspaceId: state.workspace.id, now: NOW, actorId: state.users[0].id });
  await server.packsmart.store.save(state.workspace.id, state);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  const response = await fetch(base + '/api/bootstrap', { headers: { Cookie: `packsmart_session=${token}` } });
  assert.equal(response.status, 200); const bootstrap = await response.json(); bootstrap.user.role = role; state.connections = connections;
  await new Promise(resolve => server.close(resolve));
  const errors = [], calls = [], virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8'), { url: base, runScripts: 'outside-only', virtualConsole, pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  const h = { w, d, calls, state, objective, bootstrap, errors, hidden: false, snapshot: () => businessObjectivesSnapshot(state, { workspaceId: state.workspace.id, now: NOW }) };
  t.after(async () => { dom.window.close(); await fs.rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  Object.defineProperty(d, 'hidden', { configurable: true, get: () => h.hidden });
  w.Headers = Headers; w.AbortController = AbortController; w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  h.get = async () => Response.json(h.snapshot());
  h.references = async () => Response.json({ connections: h.state.connections });
  h.bootstrapHandler = async () => Response.json(h.bootstrap);
  h.savedResult = body => {
    const objective = upsertBusinessObjective(state, body, { workspaceId: state.workspace.id, actorId: state.users[0].id, now: NOW });
    return { objective, snapshot: h.snapshot() };
  };
  h.put = async (_route, options) => Response.json(h.savedResult(JSON.parse(options.body)));
  w.fetch = async (route, options = {}) => {
    calls.push({ route, method: options.method || 'GET', body: options.body, signal: options.signal });
    if (route === API) { if (options.method === 'PUT') return h.put(route, options); const response = await h.get(route, options), json = response.json.bind(response); response.json = async () => { h.currentSnapshot = await json(); return h.currentSnapshot; }; return response; }
    if (route === '/api/connections') return h.references(route, options);
    if (route === '/api/bootstrap') { const response = await h.bootstrapHandler(), json = response.json.bind(response); response.json = async () => { h.currentBootstrap = await json(); return h.currentBootstrap; }; return response; }
    if (route === '/api/auth/login' || route === '/api/auth/session') { h.currentSession = copy({ user: h.bootstrap.user, workspace: h.bootstrap.workspace, csrf: h.bootstrap.csrf }); return { ok:true, status:200, json:async()=>h.currentSession }; }
    if (route === '/api/auth/logout') return Response.json({ ok: true });
    if (route === '/api/auth/signup-options') return Response.json({ enabled: false });
    if (route === '/api/auth/change-password') return Response.json({ csrf: 'replacement-csrf' });
    throw new Error('Unexpected synthetic route: ' + route);
  };
  for (const file of ['presentation.js','control-ui.js']) w.eval(await fs.readFile(new URL(`../../${file}`, import.meta.url), 'utf8'));
  const init = w.RunvaraControl.init; w.RunvaraControl.init = api => { h.controls = api; init(api); };
  w.eval(await fs.readFile(new URL('../../app.js', import.meta.url), 'utf8'));
  await until(() => !d.querySelector('#app-shell').classList.contains('hidden'), () => d.querySelector('#startup-error').textContent);
  h.currentBootstrap.connections = copy(connections);
  h.el = id => d.getElementById(id);
  h.form = h.el('objective-restriction-form'); h.panel = h.el('business-objective-restriction'); h.details = d.querySelector('.business-objectives-panel');
  h.mode = h.el('objective-restriction-mode'); h.account = h.el('objective-restriction-connection'); h.ack = h.el('objective-restriction-ack'); h.save = h.el('save-objective-restriction');
  h.error = h.el('objective-restriction-error'); h.status = h.el('objective-restriction-status');
  h.writes = () => calls.filter(call => call.route === API && call.method === 'PUT');
  h.objectiveReads = () => calls.filter(call => call.route === API && call.method === 'GET');
  h.change = (element, value) => { if (element.type === 'checkbox') element.checked = value; else element.value = value; element.dispatchEvent(new w.Event('change', { bubbles: true })); };
  h.submit = () => h.form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  h.load = async () => { h.el('load-business-objectives').click(); await until(() => !h.el('load-business-objectives').disabled); };
  h.open = async () => { h.controls.setView('ai-team'); h.details.open = true; await h.load(); h.d.querySelector('[data-manage-objective-restriction]')?.click(); };
  h.choose = (id = connection().id) => { h.change(h.mode, 'enforce'); h.change(h.account, id); h.change(h.ack, true); };
  h.reload = async () => { h.el('reload-objective-restriction').click(); await until(() => h.form.getAttribute('aria-busy') === 'false'); };
  h.login = async () => { const form = h.el('login-form'); for(const name of ['email','password']) if(!Object.hasOwn(form,name)) Object.defineProperty(form,name,{value:form.elements[name]}); form.elements.email.value = 'restriction@example.test'; form.elements.password.value = 'fixture-only'; form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await until(() => !h.el('app-shell').classList.contains('hidden')); };
  return h;
}

test('restriction is saved only after explicit account and exact review; payload preserves every planning field', async t => {
  const h = await harness(t), before = copy(h.objective);
  assert.equal(h.objectiveReads().length, 0); assert.equal(h.calls.filter(call => call.route === '/api/connections').length, 0);
  await h.open(); assert.equal(h.mode.value, 'preparation_only'); assert.equal(h.account.value, ''); assert.equal(h.writes().length, 0);
  assert.match(h.el('objective-restriction-context').textContent, /minimum gross margin 0%.*maximum monthly ad budget 0.*1.25.*profit first yes.*Supplier Order/);
  assert.match(h.status.textContent, /including any explicit zero limit/);
  h.change(h.mode, 'enforce'); h.submit(); assert.equal(h.writes().length, 0);
  h.change(h.account, connection().id); h.submit(); assert.equal(h.writes().length, 0);
  h.change(h.ack, true); h.change(h.account, 'conn_fixture_b'); assert.equal(h.ack.checked, false); h.submit(); assert.equal(h.writes().length, 0);
  h.change(h.ack, true); h.account.value = connection().id; h.submit(); assert.equal(h.writes().length, 0, 'silent account replacement cannot reuse acknowledgement');
  h.change(h.account, connection().id); h.change(h.ack, true);
  const pending = deferred(); h.put = (_route, options) => { h.pendingBody = JSON.parse(options.body); return pending.promise; };
  h.submit(); h.submit(); assert.equal(h.writes().length, 1); assert.equal(h.el('cancel-objective-restriction').disabled, true);
  assert.deepEqual(h.pendingBody, { id: before.id, revision: 1, executionPolicy: policy() });
  pending.resolve(Response.json(h.savedResult(h.pendingBody)));
  await until(() => h.panel.classList.contains('hidden'));
  const after = h.state.businessObjectives[0]; const { revision, updatedAt, executionPolicy, ...definition } = after;
  const { revision: originalRevision, updatedAt: originalTime, ...original } = before;
  assert.deepEqual(definition, original); assert.equal(revision, 2); assert.deepEqual(executionPolicy, policy());
  assert.equal(h.d.activeElement.dataset.manageObjectiveRestriction, before.id);
  h.d.querySelector('[data-manage-objective-restriction]').click(); h.submit(); assert.equal(h.writes().length, 1, 'no-op does not advance revision');
  assert.equal(h.ack.checked, false); assert.equal(h.save.disabled, true);
  h.change(h.account, 'conn_fixture_b'); assert.match(h.el('objective-restriction-consequence').textContent, /fixture-a.myshopify.com.*fixture-b.myshopify.com/);
  h.change(h.ack, true); h.el('cancel-objective-restriction').click(); assert.equal(h.writes().length, 1);
  h.d.querySelector('[data-manage-objective-restriction]').click(); assert.equal(h.account.value, connection().id); assert.equal(h.ack.checked, false);
  assert.equal(h.calls.some(call => /sync|approvals|reviews|jobs|dispatch|\/connections\//.test(call.route)), false);
});

test('owner role is required at event time while admin planning omits executionPolicy', async t => {
  for (const role of ['admin','member','viewer']) {
    const h = await harness(t, { role }); await h.open();
    assert.equal(h.d.querySelector('[data-manage-objective-restriction]'), null);
    const forged = h.d.createElement('button'); forged.dataset.manageObjectiveRestriction = h.objective.id; h.el('business-objectives-list').append(forged); forged.click();
    assert.equal(h.panel.classList.contains('hidden'), true); h.choose(); h.submit(); assert.equal(h.writes().length, 0);
    if (role === 'admin') {
      h.d.querySelector('[data-edit-objective]').click();
      const form = h.el('business-objective-form'); form.elements.title.value = 'Admin planning edit';
      form.dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true })); await until(() => !form.querySelector('button').disabled);
      assert.equal(h.writes().length, 1); assert.equal(Object.hasOwn(JSON.parse(h.writes()[0].body), 'executionPolicy'), false);
    }
  }
  const owner = await harness(t); await owner.open(); owner.choose();
  const oldButton = owner.d.querySelector('[data-manage-objective-restriction]').cloneNode(true);
  owner.bootstrap.user.role = 'admin'; await owner.controls.reload({ migrate: false });
  owner.el('business-objectives-list').append(oldButton); oldButton.click(); owner.submit();
  assert.equal(owner.writes().length, 0); assert.equal(owner.panel.classList.contains('hidden'), true); assert.equal(owner.ack.checked, false);
});

test('account references reject malformed, duplicate and foreign records and never infer an account', async t => {
  const bad = [connection('duplicate'), connection('duplicate','duplicate-other.myshopify.com'), connection('x'.repeat(201)), connection('invalid/id'),
    connection('domain-url','https://fixture.myshopify.com'), connection('domain-case','Fixture.myshopify.com'), connection('domain-object',{}),
    connection('domain-array',['fixture.myshopify.com']), connection('long-domain','x'.repeat(241)+'.myshopify.com'),
    { ...connection('foreign'), workspaceId: 'other-workspace' }, { ...connection('foreign-nested'), workspace: { id: 'other-workspace' } }, { ...connection('foreign-scalar'), workspace: 'other' }, { ...connection('foreign-tenant'), tenant: { id:'other' } },
    { ...connection('channel'), provider: 'ebay' }, { ...connection(), id: {} }, null];
  const valid = connection('conn_saved:disconnected'); const h = await harness(t, { connections: [valid, ...bad] }); await h.open();
  assert.deepEqual(Array.from(h.account.options, option => option.value), ['', valid.id]); h.change(h.mode, 'enforce');
  assert.equal(h.account.value, '', 'a sole eligible disconnected account is not automatically selected');
  assert.equal(h.panel.querySelector('img,script,[onerror]'), null); assert.equal(h.w.injected, undefined);
  h.choose(valid.id); assert.equal(h.save.disabled, false);
  const empty = await harness(t, { connections: [] }); await empty.open(); empty.change(empty.mode,'enforce'); empty.change(empty.ack,true); empty.submit();
  assert.equal(empty.writes().length, 0); assert.match(empty.status.textContent, /No eligible saved Shopify account/);
});

test('an unavailable or changed saved binding stays explicit; removal and rebinding require fresh review', async t => {
  const h = await harness(t, { enforced: true }); h.bootstrap.connections = [connection('conn_fixture_a','replacement.myshopify.com')]; await h.controls.reload({migrate:false}); await h.open();
  assert.equal(h.account.value, '__unavailable__'); assert.match(h.account.textContent, /Unavailable saved binding.*fixture-a.myshopify.com/); h.submit(); assert.equal(h.writes().length, 0);
  assert.match(h.status.textContent, /missing, replaced or changed/);
  h.state.connections = [];
  await h.reload(); assert.equal(h.account.value,'__unavailable__'); assert.equal(h.ack.checked, false);
  h.change(h.mode, 'preparation_only'); assert.match(h.el('objective-restriction-consequence').textContent, /Remove.*fixture-a.myshopify.com/);
  h.change(h.ack,true); h.submit(); await until(() => h.panel.classList.contains('hidden'));
  assert.deepEqual(JSON.parse(h.writes()[0].body), { id:h.objective.id, revision:1, executionPolicy:{schema,mode:'preparation_only'} });
  assert.equal(h.state.businessObjectives[0].limits.profitFirst,true);
});

test('dirty planning and restriction drafts remain mutually exclusive and cancel discards only deliberately', async t => {
  const h = await harness(t); h.controls.setView('ai-team'); h.details.open=true; await h.load();
  const planning = h.el('business-objective-form'); planning.elements.title.value='Unsaved planning';
  h.d.querySelector('[data-manage-objective-restriction]').click(); assert.equal(h.panel.classList.contains('hidden'),true);
  assert.equal(planning.elements.title.value,'Unsaved planning'); assert.match(h.el('business-objective-error').textContent,/Save or cancel your planning edits/);
  h.el('cancel-objective-edit').click(); h.d.querySelector('[data-manage-objective-restriction]').click(); h.choose();
  h.d.querySelector('[data-edit-objective]').click(); assert.match(h.error.textContent,/Save or cancel restriction editing/); assert.equal(h.ack.checked,true);
  h.el('load-business-objectives').click(); assert.equal(h.objectiveReads().length,1);
  planning.dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true})); assert.equal(h.writes().length,0);
  h.el('cancel-objective-restriction').click(); assert.equal(planning.classList.contains('hidden'),false);
  h.d.querySelector('[data-edit-objective]').click(); assert.equal(planning.elements.title.value,h.objective.title);
});

for (const [name,status,code] of [['objective conflict',409,'OBJECTIVE_CONFLICT'],['workspace conflict',409,'STATE_CONFLICT'],['account substitution',409,'OBJECTIVE_POLICY_CONNECTION_REQUIRED'],['missing objective',404,'OBJECTIVE_NOT_FOUND'],['validation',400,'OBJECTIVE_INVALID'],['server error',500,'INTERNAL_ERROR']]) {
  test(name+' retains exact stale choices and original revision until explicit reload',async t=>{
    const h=await harness(t);await h.open();h.choose();
    h.put=async()=>Response.json({error:name,code},{status});h.submit();await until(()=>h.form.getAttribute('aria-busy')==='false');
    assert.equal(h.writes().length,1);assert.equal(h.account.value,connection().id);assert.equal(h.mode.value,'enforce');assert.equal(h.ack.checked,false);assert.equal(h.save.disabled,true);
    h.submit();h.change(h.ack,true);h.submit();assert.equal(h.writes().length,1);
    h.state.businessObjectives[0].revision=2;await h.reload();assert.equal(h.mode.value,'preparation_only');assert.equal(h.account.value,'');assert.equal(h.ack.checked,false);
    assert.match(h.el('objective-restriction-context').textContent,/Revision 2/);assert.equal(h.calls.filter(call=>call.route==='/api/connections').length,1);
    h.put=async(_route,options)=>Response.json(h.savedResult(JSON.parse(options.body)));h.choose();h.submit();await until(()=>h.panel.classList.contains('hidden'));
    assert.equal(JSON.parse(h.writes()[1].body).revision,2);assert.equal(h.writes().length,2);
  });
}

test('lost response reconciles saved state without retry or claiming the request receipt',async t=>{
  const h=await harness(t);await h.open();h.choose();
  h.put=async(_route,options)=>{h.savedResult(JSON.parse(options.body));throw new Error('Synthetic response lost');};
  h.submit();await until(()=>h.form.getAttribute('aria-busy')==='false');assert.match(h.error.textContent,/outcome is unknown.*may have been saved/);assert.equal(h.writes().length,1);
  await h.reload();assert.equal(h.mode.value,'enforce');assert.equal(h.account.value,connection().id);assert.equal(h.save.disabled,true);assert.equal(h.ack.checked,false);
  assert.match(h.status.textContent,/Reloaded saved state/);assert.equal(h.writes().length,1);h.submit();assert.equal(h.writes().length,1);
});

for (const malformed of ['missing policy','wrong schema','forbidden scope','wrong objective','wrong workspace','wrong revision','changed limit','snapshot mismatch']) {
  test('malformed removal success is unknown: '+malformed,async t=>{
    const h=await harness(t,{enforced:true});await h.open();h.change(h.mode,'preparation_only');h.change(h.ack,true);
    h.put=async(_route,options)=>{
      const result=h.savedResult(JSON.parse(options.body));
      if(malformed==='missing policy')delete result.objective.executionPolicy;
      if(malformed==='wrong schema')result.objective.executionPolicy.schema='wrong';
      if(malformed==='forbidden scope')result.objective.executionPolicy.scope={};
      if(malformed==='wrong objective')result.objective.id='other';
      if(malformed==='wrong workspace')result.objective.workspaceId='other';
      if(malformed==='wrong revision')result.objective.revision=999;
      if(malformed==='changed limit')result.objective.limits.maxMonthlyAdBudget=null;
      if(malformed==='snapshot mismatch')result.snapshot.objectives[0].limits.profitFirst=false;
      return Response.json(result);
    };
    h.submit();await until(()=>h.form.getAttribute('aria-busy')==='false');assert.match(h.error.textContent,/outcome is unknown/);assert.equal(h.panel.classList.contains('hidden'),false);assert.equal(h.save.disabled,true);
    assert.equal(h.writes().length,1);assert.doesNotMatch(h.el('global-success').textContent,/Restriction saved/);
  });
}

for (const interruption of ['cancel','panel close','navigation','history','hidden tab','same workspace bootstrap','logout']) {
  test('late account GET cannot revive a dismissed editor after '+interruption,async t=>{
    const h=await harness(t);await h.open();h.choose();const pending=deferred();h.references=()=>pending.promise;
    h.el('reload-objective-restriction').click();h.el('reload-objective-restriction').click();
    assert.equal(h.calls.filter(call=>call.route==='/api/connections').length,1);
    const signal=h.calls.find(call=>call.route==='/api/connections').signal;
    if(interruption==='cancel')h.el('cancel-objective-restriction').click();
    if(interruption==='panel close'){h.details.open=false;h.details.open=true;}
    if(interruption==='navigation'){h.controls.setView('overview');h.controls.setView('ai-team');}
    if(interruption==='history')h.w.dispatchEvent(new h.w.PopStateEvent('popstate'));
    if(interruption==='hidden tab'){h.hidden=true;h.d.dispatchEvent(new h.w.Event('visibilitychange'));h.hidden=false;h.d.dispatchEvent(new h.w.Event('visibilitychange'));}
    if(interruption==='same workspace bootstrap')await h.controls.reload({migrate:false});
    if(interruption==='logout'){h.el('logout').click();await until(()=>!h.el('login-screen').classList.contains('hidden'));await h.login();}
    await delay();assert.equal(signal.aborted,true);pending.resolve(Response.json({connections:[connection('late','late.myshopify.com')]}));await delay();
    if(interruption==='hidden tab'){assert.equal(h.panel.classList.contains('hidden'),false);assert.equal(h.account.value,connection().id);assert.match(h.error.textContent,/unsent choices remain visible/);assert.equal(h.save.disabled,true);}else{assert.equal(h.panel.classList.contains('hidden'),true);assert.equal(h.account.options.length,0);}
    assert.equal(h.ack.checked,false);assert.equal(h.writes().length,0);assert.equal(h.calls.filter(call=>call.route==='/api/connections').length,1);
  });
}

for (const resultType of ['success','network failure','401','403']) {
  test('late PUT '+resultType+' cannot clear or unlock a newer draft after navigation and explicit reconciliation',async t=>{
    const h=await harness(t);await h.open();h.choose();const pending=deferred();let body;
    h.put=(_route,options)=>{body=JSON.parse(options.body);return pending.promise;};h.submit();
    h.controls.setView('overview');h.controls.setView('ai-team');assert.match(h.el('business-objectives-list').textContent,/save outcome is unknown/);
    await h.load();h.d.querySelector('[data-manage-objective-restriction]').click();h.choose('conn_fixture_b');
    const newer=deferred();h.references=()=>newer.promise;h.el('reload-objective-restriction').click();
    if(resultType==='success')pending.resolve(Response.json(h.savedResult(body)));
    if(resultType==='network failure')pending.reject(new Error('lost'));
    if(resultType==='401'||resultType==='403')pending.resolve(Response.json({error:'late authorization failure'},{status:Number(resultType)}));
    await delay();assert.equal(h.form.getAttribute('aria-busy'),'true');assert.equal(h.el('reload-objective-restriction').disabled,true);assert.equal(h.el('app-shell').classList.contains('hidden'),false);
    newer.resolve(Response.json({connections:h.state.connections}));await until(()=>h.form.getAttribute('aria-busy')==='false');
    assert.equal(h.writes().length,1);assert.equal(h.ack.checked,false);
  });
}

test('active 401/403 and owner loss during save clear the private restriction draft',async t=>{
  for(const status of [401,403]){
    const h=await harness(t);await h.open();h.choose();h.put=async()=>Response.json({error:'authorization expired',code:status===401?'AUTH_REQUIRED':'OWNER_APPROVAL_REQUIRED'},{status});h.submit();
    await until(()=>h.panel.classList.contains('hidden'));assert.equal(h.account.options.length,0);assert.equal(h.ack.checked,false);assert.equal(h.writes().length,1);
  }
  const h=await harness(t);await h.open();h.choose();const pending=deferred();h.put=()=>pending.promise;h.submit();
  h.bootstrap.user.role='admin';await h.controls.reload({migrate:false});pending.resolve(Response.json({objective:h.objective,snapshot:h.snapshot()}));await delay();
  assert.equal(h.panel.classList.contains('hidden'),true);assert.equal(h.account.options.length,0);assert.equal(h.ack.checked,false);assert.equal(h.writes().length,1);
});

test('non-active windows and null/false limits never claim permission to execute',async t=>{
  const h=await harness(t,{limits:{profitFirst:false,minGrossMarginPercent:null,maxMonthlyAdBudget:null,minStockCoverDays:null}});
  h.state.businessObjectives[0].status='disabled';await h.open();assert.match(h.status.textContent,/Other restrictions and exact approval may still block/);assert.match(h.status.textContent,/outside its active status\/window/);
  assert.match(h.el('objective-restriction-context').textContent,/profit first no/);assert.doesNotMatch(h.panel.textContent,/ready to execute|profit protected|goal running|unlock execution/i);
  h.choose();h.submit();await until(()=>h.panel.classList.contains('hidden'));assert.equal(h.state.businessObjectives[0].status,'disabled');assert.equal(h.state.businessObjectives[0].limits.profitFirst,false);
});

for(const drift of ['session user','session workspace','session csrf','session role','bootstrap user','bootstrap workspace','bootstrap role','password required']) {
  test('in-place '+drift+' drift clears a draft before any policy PUT',async t=>{
    const h=await harness(t);await h.open();h.choose();
    if(drift==='session user')h.currentSession.user.id='replacement-user';
    if(drift==='session workspace')h.currentSession.workspace.id='replacement-workspace';
    if(drift==='session csrf')h.currentSession.csrf='replacement-csrf';
    if(drift==='session role')h.currentSession.user.role='admin';
    if(drift==='bootstrap user')h.currentBootstrap.user.id='replacement-user';
    if(drift==='bootstrap workspace')h.currentBootstrap.workspace.id='replacement-workspace';
    if(drift==='bootstrap role')h.currentBootstrap.user.role='admin';
    if(drift==='password required')h.currentSession.user.passwordChangeRequired=true;
    h.submit();assert.equal(h.writes().length,0);assert.equal(h.panel.classList.contains('hidden'),true);assert.equal(h.ack.checked,false);assert.equal(h.account.options.length,0);
  });
}

test('same-revision saved conditions and account mutations invalidate the reviewed choice',async t=>{
  const h=await harness(t);await h.open();h.choose();h.currentSnapshot.objectives[0].limits.maxMonthlyAdBudget=1;
  h.submit();assert.equal(h.writes().length,0);assert.equal(h.ack.checked,false);assert.match(h.error.textContent,/Saved objective data changed/);
  await h.controls.reload({migrate:false});await h.open();h.choose();
  h.currentBootstrap.connections[0].metadata.shopDomain='replacement.myshopify.com';h.submit();
  assert.equal(h.writes().length,0);assert.equal(h.ack.checked,false);assert.match(h.error.textContent,/saved account references changed/);assert.equal(h.account.value,connection().id);
});

test('unsent hidden-tab choices survive without resuming work or carrying acknowledgement',async t=>{
  const h=await harness(t);await h.open();h.choose('conn_fixture_b');const before=h.calls.length;
  h.hidden=true;h.d.dispatchEvent(new h.w.Event('visibilitychange'));h.hidden=false;h.d.dispatchEvent(new h.w.Event('visibilitychange'));
  assert.equal(h.mode.value,'enforce');assert.equal(h.account.value,'conn_fixture_b');assert.equal(h.ack.checked,false);assert.equal(h.save.disabled,true);assert.equal(h.calls.length,before);
  h.submit();assert.equal(h.writes().length,0);await h.reload();assert.equal(h.mode.value,'preparation_only');assert.equal(h.account.value,'');
});

test('old list GET cleanup cannot unlock a newer load or replace a saved planning result',async t=>{
  const h=await harness(t);h.controls.setView('ai-team');h.details.open=true;const old=deferred(),latest=deferred();h.get=()=>old.promise;
  h.el('load-business-objectives').click();h.controls.setView('overview');h.controls.setView('ai-team');h.get=()=>latest.promise;h.el('load-business-objectives').click();
  old.resolve(Response.json({workspaceId:'foreign',objectives:[]}));await delay();assert.equal(h.el('load-business-objectives').disabled,true);
  latest.resolve(Response.json(h.snapshot()));await until(()=>!h.el('load-business-objectives').disabled);assert.ok(h.d.querySelector('[data-manage-objective-restriction]'));
});

test('interrupted planning create is reconciled before a further mutation and old finally owns no newer form',async t=>{
  const h=await harness(t);const form=h.el('business-objective-form'),fields=form.elements;
  fields.title.value='Unsure planning create';fields.target.value='10';fields.startsAt.value='2026-10-01T00:00';fields.endsAt.value='2027-10-01T00:00';
  const old=deferred();h.put=()=>old.promise;const submit=()=>form.dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));submit();assert.equal(h.writes().length,1);
  h.controls.setView('ai-team');h.details.open=true;submit();assert.equal(h.writes().length,1);assert.match(h.el('business-objective-error').textContent,/Load saved objectives/);
  await h.load();h.el('cancel-objective-edit').click();h.d.querySelector('[data-edit-objective]').click();fields.title.value='Explicit revised planning';
  const newer=deferred();h.put=()=>newer.promise;submit();assert.equal(h.writes().length,2);old.resolve(Response.json({snapshot:h.snapshot()}));await delay();assert.equal(form.querySelector('button').disabled,true);
  newer.resolve(Response.json(h.savedResult(JSON.parse(h.writes()[1].body))));await until(()=>!form.querySelector('button').disabled);assert.equal(h.state.businessObjectives[0].title,'Explicit revised planning');
});

test('bootstrap reset begins before its response and expired password invalidates policy work immediately',async t=>{
  const h=await harness(t);await h.open();h.choose();const boot=deferred();h.bootstrapHandler=()=>boot.promise;const loading=h.controls.reload({migrate:false});
  assert.equal(h.panel.classList.contains('hidden'),true);assert.equal(h.ack.checked,false);boot.resolve(Response.json(h.bootstrap));await loading;
  await h.open();h.choose();const form=h.el('account-password-form');for(const name of ['currentPassword','newPassword'])Object.defineProperty(form,name,{value:form.elements[name]});
  form.elements.currentPassword.value='fixture';form.elements.newPassword.value='fixture-password-only';form.dispatchEvent(new h.w.Event('submit',{bubbles:true,cancelable:true}));
  assert.equal(h.panel.classList.contains('hidden'),true);assert.equal(h.account.options.length,0);await delay();assert.equal(h.writes().length,0);
});

test('explicitly reloaded exact account references remain authoritative after save/cancel/reopen',async t=>{
  const h=await harness(t,{enforced:true});await h.open();
  const replacement=connection('conn_replacement','replacement.myshopify.com');h.state.connections=[replacement];await h.reload();
  assert.equal(h.account.value,'__unavailable__');h.change(h.account,replacement.id);h.change(h.ack,true);h.submit();await until(()=>h.panel.classList.contains('hidden'));
  h.d.querySelector('[data-manage-objective-restriction]').click();assert.equal(h.account.value,replacement.id);assert.doesNotMatch(h.account.textContent,/Unavailable saved binding/);
  assert.equal(Array.from(h.account.options).some(option=>option.value===connection().id),false,'removed bootstrap references never reappear');
  h.el('cancel-objective-restriction').click();h.d.querySelector('[data-manage-objective-restriction]').click();assert.equal(h.account.value,replacement.id);
  h.bootstrap.connections=[replacement];await h.controls.reload({migrate:false});await h.open();assert.equal(h.account.value,replacement.id);assert.equal(h.ack.checked,false);
});
