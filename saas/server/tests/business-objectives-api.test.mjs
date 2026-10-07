import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createPacksmartServer} from '../server.mjs';
import {seedWorkspaceState} from '../lib/store.mjs';
import { OBJECTIVE_EXECUTION_POLICY_SCHEMA } from '../lib/business-objectives.mjs';
import {createSessionToken,verifySessionToken} from '../lib/security.mjs';

test('objectives are owner-only, revision protected, audited and tenant isolated', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'runvara-objectives-'));
  const secret = 'objective-api-test-secret-more-than-32-characters';
  const server = createPacksmartServer({NODE_ENV:'test',SESSION_SECRET:secret,CREDENTIALS_KEY:secret,SAAS_STATE_FILE:path.join(dir,'state.json')});
  const tokens = {};
  for (const id of ['alpha','beta','member']) {
    const state=seedWorkspaceState({}, {workspaceId:id,email:`${id}@example.test`,passwordHash:'fixture-only'});
    if(id==='member') state.users[0].role='member';
    await server.packsmart.store.save(id,state);
    tokens[id]=createSessionToken({workspaceId:id,userId:state.users[0].id,email:state.users[0].email,role:state.users[0].role,sessionVersion:1},secret);
  }
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
  const request=async(route,{id='alpha',method='GET',body,csrf=true}={})=>{
    const headers={'Cookie':`packsmart_session=${tokens[id]}`,'Content-Type':'application/json'};
    if(csrf) headers['X-CSRF-Token']=verifySessionToken(tokens[id],secret).csrf;
    const response=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  let writes=0;const save=server.packsmart.store.save.bind(server.packsmart.store);
  server.packsmart.store.save=async(...args)=>{writes++;return save(...args);};
  const empty=await request('/api/business-objectives'); assert.equal(empty.status,200); assert.deepEqual(empty.body.objectives,[]); assert.equal(writes,0);
  const now=Date.now(), start=new Date(now-60000).toISOString(), end=new Date(now+30*86400000).toISOString();
  const definition={title:'Profitable packaging growth',metric:'revenue',baseline:100,target:125,direction:'increase',startsAt:start,endsAt:end,limits:{currency:'GBP',maxMonthlyAdBudget:0,minGrossMarginPercent:35,profitFirst:true}};
  assert.equal((await request('/api/business-objectives',{method:'PUT',csrf:false,body:definition})).status,403);
  assert.equal((await request('/api/business-objectives',{id:'member',method:'PUT',body:definition})).status,403);
  assert.equal((await request('/api/business-objectives',{method:'PUT',body:{...definition,workspaceId:'beta'}})).status,403);
  assert.equal(writes,0);
  const created=await request('/api/business-objectives',{method:'PUT',body:definition});assert.equal(created.status,200);
  const objective=created.body.objective;
  assert.equal(objective.limits.maxMonthlyAdBudget,0);assert.equal(objective.revision,1);
  const stored=await server.packsmart.store.get('alpha');
  assert.equal(stored.businessObjectives[0].id,objective.id);
  assert.ok(stored.audit.some(item=>item.type==='business_objective_configured'&&item.detail.objectiveId===objective.id));
  assert.deepEqual((await request('/api/business-objectives?workspaceId=alpha',{id:'beta'})).body.objectives,[]);
  assert.equal((await request('/api/business-objectives',{id:'beta',method:'PUT',body:{id:objective.id,revision:1,status:'paused'}})).status,404);
  const updated=await request('/api/business-objectives',{method:'PUT',body:{id:objective.id,revision:1,status:'paused'}});assert.equal(updated.status,200);assert.equal(updated.body.objective.revision,2);
  assert.equal((await request('/api/business-objectives',{method:'PUT',body:{id:objective.id,revision:1,status:'active'}})).status,409);
  const before=writes;
  const evaluated=await request('/api/business-objectives/evaluate',{method:'POST',body:{objectiveId:objective.id,kind:'prepare_report',mode:'internal_preparation',evidence:{}}});
  assert.equal(evaluated.status,200);assert.equal(evaluated.body.readyForPreparation,false);assert.equal(evaluated.body.safeguards.externalExecutionAllowed,false);
  assert.equal(writes,before,'evaluation never saves or executes');
  assert.equal((await request('/api/business-objectives/evaluate',{id:'member',method:'POST',body:{}})).status,403);
});

test('execution restrictions require explicit owner configuration and cannot be relaxed through admin planning or replacement routes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-objective-policy-api-'));
  const secret = 'objective-policy-api-synthetic-secret-more-than-thirty-two-characters';
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
    SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' });
  const state = seedWorkspaceState({}, { workspaceId: 'policy-alpha', userId: 'policy-owner', email: 'owner@example.test', passwordHash: 'fixture-only' });
  state.users.push({ ...state.users[0], id: 'policy-admin', role: 'admin', email: 'admin@example.test' });
  state.connections = [{ id: 'policy-shopify', provider: 'shopify', metadata: { shopDomain: 'policy-fixture.myshopify.com' } }];
  await server.packsmart.store.save(state.workspace.id, state);
  const foreign = seedWorkspaceState({}, { workspaceId: 'policy-beta', userId: 'foreign-owner', email: 'foreign@example.test', passwordHash: 'fixture-only' });
  await server.packsmart.store.save(foreign.workspace.id, foreign);
  const tokens = Object.fromEntries([...state.users.map(user => [user.id, state.workspace.id, user]), [foreign.users[0].id, foreign.workspace.id, foreign.users[0]]]
    .map(([id, workspaceId, user]) => [id, createSessionToken({ workspaceId, userId: id, email: user.email, role: user.role, sessionVersion: 1 }, secret)]));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const request = async (body, { actor = 'policy-owner', csrf = true, method = 'PUT', route = '/api/business-objectives' } = {}) => {
    const headers = { Cookie: `packsmart_session=${tokens[actor]}`, 'Content-Type': 'application/json' };
    if (csrf) headers['X-CSRF-Token'] = verifySessionToken(tokens[actor], secret).csrf;
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const now = Date.now(), executionPolicy = { schema: OBJECTIVE_EXECUTION_POLICY_SCHEMA, mode: 'enforce', scope: {
    provider: 'shopify', operation: 'product_content', connectionId: 'policy-shopify', account: 'policy-fixture.myshopify.com' } };
  const definition = { title: 'Owner configured scope', metric: 'orders', baseline: 1, target: 2, direction: 'increase',
    startsAt: new Date(now - 60000).toISOString(), endsAt: new Date(now + 86400000).toISOString(), limits: { profitFirst: false }, executionPolicy };
  assert.equal((await request(definition, { csrf: false })).status, 403);
  assert.equal((await request(definition, { actor: 'policy-admin' })).status, 403);
  assert.equal((await request({ ...definition, workspaceId: foreign.workspace.id })).status, 403);
  assert.equal((await request(definition, { actor: 'foreign-owner' })).body.code, 'OBJECTIVE_POLICY_CONNECTION_REQUIRED');
  const created = await request(definition); assert.equal(created.status, 200);
  const row = created.body.objective;
  for (const patch of [{ status: 'paused' }, { status: 'cancelled' }, { status: 'disabled' },
    { startsAt: new Date(now + 1000).toISOString() }, { endsAt: new Date(now + 1000).toISOString() }, { target: 3 },
    { limits: { profitFirst: true } }, { executionPolicy: { schema: OBJECTIVE_EXECUTION_POLICY_SCHEMA, mode: 'preparation_only' } }]) {
    const response = await request({ id: row.id, revision: 1, ...patch }, { actor: 'policy-admin' });
    assert.equal(response.status, 403); assert.equal(response.body.code, 'OWNER_APPROVAL_REQUIRED');
  }
  assert.equal((await request({ businessObjectives: [] }, { actor: 'policy-admin' })).status, 400);
  assert.equal((await request({ id: row.id, revision: 1 }, { actor: 'policy-admin', method: 'DELETE' })).status, 404);
  assert.equal((await request({ id: row.id, revision: 1, status: 'active' }, { actor: 'foreign-owner' })).status, 404);
  const saved = await server.packsmart.store.get(state.workspace.id);
  assert.deepEqual(saved.businessObjectives[0], row);
  assert.ok(saved.audit.some(event => event.type === 'business_objective_configured' && event.detail.executionPolicyMode === 'enforce' && event.actor === 'policy-owner'));
  const { executionPolicy: _policy, ...planning } = definition;
  assert.equal((await request(planning, { actor: 'policy-admin' })).status, 200, 'existing admin planning capability is preserved');
  const disabled = await request({ id: row.id, revision: 1, executionPolicy: { schema: OBJECTIVE_EXECUTION_POLICY_SCHEMA, mode: 'preparation_only' } });
  assert.equal(disabled.status, 200); assert.equal(disabled.body.objective.revision, 2);
  assert.equal((await request({ id: row.id, revision: 1, executionPolicy })).status, 409);
});

test('saved restriction patches preserve definitions and legacy omissions; stale or missing-account updates never relax policy', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-objective-policy-patch-api-'));
  const secret = 'objective-policy-patch-synthetic-secret-more-than-thirty-two-characters';
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
    SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' });
  const state = seedWorkspaceState({}, { workspaceId: 'policy-patch', userId: 'patch-owner', email: 'owner@example.test', passwordHash: 'fixture-only' });
  state.users.push({ ...state.users[0], id: 'patch-admin', role: 'admin', email: 'admin@example.test' });
  state.connections = [{ id: 'patch-shopify', provider: 'shopify', status: 'disconnected', metadata: { shopDomain: 'patch-fixture.myshopify.com' } }];
  await server.packsmart.store.save(state.workspace.id, state);
  const tokens = Object.fromEntries(state.users.map(user => [user.id, createSessionToken({ workspaceId: state.workspace.id,
    userId: user.id, email: user.email, role: user.role, sessionVersion: 1 }, secret)]));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const request = async (body, actor = 'patch-owner') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/business-objectives`, { method: body === undefined ? 'GET' : 'PUT',
      headers: { Cookie: `packsmart_session=${tokens[actor]}`, 'Content-Type': 'application/json',
        'X-CSRF-Token': verifySessionToken(tokens[actor], secret).csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const getState = () => server.packsmart.store.get(state.workspace.id);
  const policy = { schema: OBJECTIVE_EXECUTION_POLICY_SCHEMA, mode: 'enforce', scope: {
    provider: 'shopify', operation: 'product_content', connectionId: 'patch-shopify', account: 'patch-fixture.myshopify.com' } };
  const preparationOnly = { schema: OBJECTIVE_EXECUTION_POLICY_SCHEMA, mode: 'preparation_only' };
  const definition = { title: 'Keep every saved field', metric: 'contribution_profit', baseline: -12.75, target: 83.125, direction: 'increase',
    startsAt: '2026-09-07T06:01:02.345Z', endsAt: '2027-01-09T07:08:09.876Z', status: 'paused',
    limits: { currency: 'JPY', maxMonthlyAdBudget: 0, minGrossMarginPercent: null, minStockCoverDays: 4.125,
      profitFirst: false, approvalRequiredKinds: ['supplier_order', 'customer_facing_publish'] } };
  const unchangedDefinition = ({ revision, updatedAt, executionPolicy, ...saved }) => saved;
  const assertRejectedWithoutMutation = async (body, status, code, actor) => {
    const before = await getState();
    const result = await request(body, actor);
    assert.equal(result.status, status); assert.equal(result.body.code, code);
    assert.deepEqual(await getState(), before, `${code} does not persist an objective or audit update`);
  };

  const created = await request(definition);
  assert.equal(created.status, 200);
  const original = created.body.objective;
  assert.equal(Object.hasOwn(original, 'executionPolicy'), false, 'new planning objectives retain the legacy absent-policy shape');
  const enabled = await request({ id: original.id, revision: original.revision, executionPolicy: policy });
  assert.equal(enabled.status, 200, 'an exact saved reference can be restricted while disconnected');
  assert.equal(enabled.body.objective.revision, original.revision + 1);
  assert.deepEqual(unchangedDefinition(enabled.body.objective), unchangedDefinition(original));
  assert.deepEqual((await getState()).businessObjectives[0], enabled.body.objective);
  assert.deepEqual(enabled.body.snapshot.objectives[0], { ...enabled.body.objective, effectiveStatus: 'paused' });

  const ownerPlanning = await request({ id: original.id, revision: 2, title: 'Legacy owner planning edit' });
  assert.equal(ownerPlanning.status, 200);
  assert.deepEqual(ownerPlanning.body.objective.executionPolicy, policy, 'omission by an old owner client preserves enforcement');
  assert.deepEqual(unchangedDefinition(ownerPlanning.body.objective), { ...unchangedDefinition(original), title: 'Legacy owner planning edit' });
  await assertRejectedWithoutMutation({ id: original.id, revision: 2, executionPolicy: preparationOnly }, 409, 'OBJECTIVE_CONFLICT');
  await assertRejectedWithoutMutation({ id: original.id, revision: 3, executionPolicy: null }, 400, 'VALIDATION_FAILED');

  const adminCreated = await request({ ...definition, title: 'Legacy admin planning', baseline: null,
    limits: { currency: 'CHF', maxMonthlyAdBudget: null, minGrossMarginPercent: 0, minStockCoverDays: null,
      profitFirst: true, approvalRequiredKinds: [] } }, 'patch-admin');
  assert.equal(adminCreated.status, 200);
  const adminUpdated = await request({ id: adminCreated.body.objective.id, revision: 1, title: 'Legacy admin revision' }, 'patch-admin');
  assert.equal(adminUpdated.status, 200);
  assert.equal(Object.hasOwn(adminUpdated.body.objective, 'executionPolicy'), false, 'admin omission does not emit an owner-only field');
  assert.deepEqual(adminUpdated.body.objective.limits, adminCreated.body.objective.limits);
  assert.equal(adminUpdated.body.objective.baseline, null);
  await assertRejectedWithoutMutation({ id: adminUpdated.body.objective.id, revision: 2, executionPolicy: preparationOnly }, 403, 'OWNER_APPROVAL_REQUIRED', 'patch-admin');
  const nullableRestricted = await request({ id: adminUpdated.body.objective.id, revision: 2, executionPolicy: policy });
  assert.equal(nullableRestricted.status, 200);
  assert.deepEqual(unchangedDefinition(nullableRestricted.body.objective), unchangedDefinition(adminUpdated.body.objective),
    'a policy-only update also preserves an unknown baseline, null budget/stock, explicit zero margin and profit-first true');

  const missingConnection = await getState();
  missingConnection.connections = [];
  await server.packsmart.store.save(state.workspace.id, missingConnection);
  const unavailable = await request();
  assert.deepEqual(unavailable.body.objectives.find(row => row.id === original.id).executionPolicy, policy, 'reads keep the unavailable binding visible');
  await assertRejectedWithoutMutation({ id: original.id, revision: 3, title: 'Cannot silently drop enforcement' }, 409, 'OBJECTIVE_POLICY_CONNECTION_REQUIRED');
  await assertRejectedWithoutMutation({ id: original.id, revision: 3, executionPolicy: policy }, 409, 'OBJECTIVE_POLICY_CONNECTION_REQUIRED');
  await assertRejectedWithoutMutation({ id: original.id, revision: 3, executionPolicy: preparationOnly }, 403, 'OWNER_APPROVAL_REQUIRED', 'patch-admin');

  const beforeRemoval = (await getState()).businessObjectives.find(row => row.id === original.id);
  const removed = await request({ id: original.id, revision: 3, executionPolicy: preparationOnly });
  assert.equal(removed.status, 200, 'the owner can explicitly remove a restriction after its saved account disappears');
  assert.deepEqual(removed.body.objective.executionPolicy, preparationOnly);
  assert.equal(Object.hasOwn(removed.body.objective.executionPolicy, 'scope'), false);
  assert.equal(removed.body.objective.revision, 4);
  assert.deepEqual(unchangedDefinition(removed.body.objective), unchangedDefinition(beforeRemoval));
  await assertRejectedWithoutMutation({ id: original.id, revision: 3, executionPolicy: policy }, 409, 'OBJECTIVE_CONFLICT');

  const save = server.packsmart.store.save.bind(server.packsmart.store);
  let saveAttempts = 0;
  server.packsmart.store.save = async () => { saveAttempts++; throw Object.assign(new Error('Synthetic workspace revision changed'), { status: 409, code: 'STATE_CONFLICT' }); };
  try {
    await assertRejectedWithoutMutation({ id: original.id, revision: 4, executionPolicy: preparationOnly }, 409, 'STATE_CONFLICT');
    assert.equal(saveAttempts, 1, 'a workspace conflict is returned without retrying or substituting a revision');
  } finally { server.packsmart.store.save = save; }
});
