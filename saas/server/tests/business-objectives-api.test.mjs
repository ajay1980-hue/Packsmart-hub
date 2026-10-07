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
