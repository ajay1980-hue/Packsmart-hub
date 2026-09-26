import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeSupabase } from './fake-supabase.mjs';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';

test('mirror failure preserves authoritative state and emits only safe diagnostics', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  const fake = fakeSupabase({ fault: ({ table, method }) => table === 'workspaces' && method === 'POST' ? { code: '23505', message: 'private row value', details: 'secret' } : null });
  const store = createStore({ SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'secret' }, { fetchImpl: fake.fetchImpl });
  console.warn = message => warnings.push(JSON.parse(message));
  try {
    await store.save('packsmart-solutions', seedWorkspaceState());
  } finally { console.warn = originalWarn; }
  assert.equal(fake.states.has('packsmart-solutions'), true);
  assert.equal(fake.states.get('packsmart-solutions').integrationStatus.reporting.status, 'degraded');
  assert.ok(fake.tables.has('users'), 'other reporting tables still refresh');
  assert.deepEqual(warnings, [{ event: 'supabase_mirror_refresh_failed', workspaceId: 'packsmart-solutions',
    code: 'SUPABASE_PERSISTENCE_FAILED', table: 'workspaces', httpStatus: 409, databaseCode: '23505' }]);
});

test('Supabase persistence mirrors every production table and restores lossless workspace state', async () => {
  const serviceKey = 'test-service-role-value-that-never-enters-a-response';
  const { fetchImpl, calls } = fakeSupabase();

  const store = createStore({
    NODE_ENV: 'production',
    SUPABASE_URL: 'https://packsmart-test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: serviceKey
  }, { fetchImpl });
  assert.equal(store.provider, 'supabase');

  const state = seedWorkspaceState();
  const now = new Date().toISOString();
  state.products = [{
    id: 'gid://shopify/Product/1',
    externalId: 'gid://shopify/Product/1',
    provider: 'shopify',
    title: 'Test product',
    handle: 'test-product',
    status: 'active',
    productType: 'Packaging',
    description: 'A sufficiently descriptive product for persistence coverage.',
    image: 'https://cdn.shopify.com/test.jpg',
    inventory: 9,
    updatedAt: now,
    variants: [{
      id: 'gid://shopify/ProductVariant/11',
      externalId: 'gid://shopify/ProductVariant/11',
      title: 'Default',
      sku: 'PS-TEST-11',
      price: 12.5,
      inventory: 9,
      available: true,
      image: 'https://cdn.shopify.com/test.jpg'
    }]
  }];
  state.orders = [{
    id: 'gid://shopify/Order/22',
    externalId: 'gid://shopify/Order/22',
    provider: 'shopify',
    name: '#1022',
    financialStatus: 'PAID',
    fulfillmentStatus: 'UNFULFILLED',
    total: 12.5,
    currency: 'GBP',
    createdAt: now,
    updatedAt: now,
    cancelledAt: null
  }];
  state.economics['PS-TEST-11'] = { landed: 4, packing: 0.4, delivery: 2.5, channelFee: 0.8, marginFloor: 20 };
  state.costHistory = [{
    id: 'cost_history_test', sku: 'PS-TEST-11', changedBy: 'packsmart-admin',
    changedFields: ['landed'], before: { landed: null }, after: { landed: 4 }, createdAt: now
  }];
  state.advertisingCosts = [{
    id: 'adcost_test', channel: 'meta', spend: 10, attributableRevenue: 25,
    date: now, source: 'manual', createdAt: now, updatedAt: now
  }];
  state.connections = [{
    id: 'conn_test',
    provider: 'meta',
    label: 'Meta Shops',
    status: 'configured',
    encryptedCredentials: 'v1.encrypted.only',
    capabilities: ['catalogue'],
    metadata: { channel: 'meta' },
    createdAt: now,
    updatedAt: now
  }];
  state.approvals = [{
    id: 'approval_test',
    type: 'supplier_order',
    action: 'Order cartons',
    reason: 'Stock cover is low',
    financialImpact: 100,
    expectedBenefit: 'Avoid stockout',
    risk: 'Excess stock',
    requestedBy: 'packsmart-admin',
    source: 'test',
    payload: {},
    status: 'pending',
    createdAt: now,
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    executedExternally: false,
    executionStatus: 'not_connected'
  }];
  state.dailyBriefs = [{ id: 'brief_test', summary: 'Test brief', logic: 'deterministic-v1', generatedAt: now }];

  await store.save(state.workspace.id, state);
  const writtenTables = new Set(calls.filter(call => call.method === 'POST').map(call => call.url.pathname.split('/').pop()));
  for (const table of [
    'workspaces', 'users', 'connections', 'products', 'variants', 'economics',
    'automation_rules', 'approval_requests', 'audit_events', 'subscriptions',
    'orders', 'operations_briefs', 'runvara_create_workspace', 'suppliers',
    'product_cost_profiles', 'cost_history', 'order_financials', 'advertising_costs'
  ]) {
    assert.ok(writtenTables.has(table), `${table} must be mirrored`);
  }
  assert.ok(calls.filter(call => call.method === 'POST').every(call => !String(call.body).includes(serviceKey)));

  const restored = await store.get('packsmart-solutions');
  assert.equal(restored.storageReady, true);
  assert.equal(restored.economics['PS-TEST-11'].landed, 4);
  assert.equal(restored.approvals[0].executedExternally, false);
  const found = await store.findUserByEmail('SALES@PACKSMARTSOLUTIONS.COM');
  assert.equal(found.workspaceId, 'packsmart-solutions');
  assert.equal(await store.ping(), true);
});

test('legacy customer-zero owners without a password hash are forced through secure setup', async () => {
  let legacy = {
    workspace: { id: 'packsmart-solutions', name: 'Packsmart Solutions Ltd', slug: 'packsmart-solutions' },
    users: [{ id: 'packsmart-admin', email: 'sales@packsmartsolutions.com', role: 'owner' }]
  };
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    if ((options.method || 'GET') === 'POST') {
      if (url.pathname.endsWith('/saas_workspace_state')) legacy = JSON.parse(options.body)[0].state;
      return new Response(null, { status: 204 });
    }
    return Response.json([{ state: legacy }]);
  };
  const store = createStore({
    NODE_ENV: 'production',
    SUPABASE_URL: 'https://packsmart-test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-long-enough-for-tests'
  }, { fetchImpl });
  const restored = await store.get('packsmart-solutions');
  assert.equal(restored.users[0].passwordChangeRequired, true);
});

test('large historical briefs are archived losslessly before compact primary writes and remain tenant scoped', async () => {
  const state = seedWorkspaceState();
  state._revision = 'legacy';
  const brief = { id: 'large-historical-brief', summary: 'Original executive summary', generatedAt: new Date().toISOString(), logic: 'deterministic-v2', orders30d: 61, productRows: [{ description: 'x'.repeat(900000), sku: 'SKU-1' }] };
  state.dailyBriefs = [brief];
  const fake = fakeSupabase({ initialStates: [state] });
  const store = createStore({ SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test' }, { fetchImpl: fake.fetchImpl });
  const loaded = await store.get(state.workspace.id); await store.save(state.workspace.id, loaded);
  const restored = await store.get(state.workspace.id);
  assert.ok(restored.dailyBriefs[0].archive); assert.equal(restored.dailyBriefs[0].orders30d, 61);
  assert.ok(JSON.stringify(restored).length < 15000);
  assert.deepEqual(await store.getBrief(state.workspace.id, brief.id), brief);
  assert.equal(await store.getBrief('other-workspace', brief.id), null);
  await store.save(state.workspace.id, restored);
  assert.deepEqual(await store.getBrief(state.workspace.id, brief.id), brief, 'summary mirroring must not overwrite archived detail');
  assert.ok(fake.calls.findIndex(call => call.url.pathname.endsWith('/operations_briefs') && call.method === 'POST') < fake.calls.findIndex(call => call.method === 'PATCH'));
});

test('archive failure leaves full primary history intact and primary outage cannot claim success', async () => {
  const state = seedWorkspaceState(); state._revision = 'original';
  state.dailyBriefs = [{ id: 'brief', summary: 'History', generatedAt: new Date().toISOString(), productRows: [{ description: 'x'.repeat(70000) }] }];
  const fake = fakeSupabase({ initialStates: [state], fault: ({ table, method }) => table === 'operations_briefs' && method === 'POST' ? { status: 503, code: 'PGRST000' } : null });
  const store = createStore({ SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test' }, { fetchImpl: fake.fetchImpl });
  await assert.rejects(() => store.save(state.workspace.id, state), error => error.httpStatus === 503);
  assert.deepEqual((await store.get(state.workspace.id)).dailyBriefs, state.dailyBriefs);
  assert.equal(fake.calls.filter(call => call.method === 'PATCH').length, 0);
});

test('reporting mirrors only changed rows and never caches failed writes', async()=>{
  let fail=false;
  const fake=fakeSupabase({fault:({table,method})=>fail&&table==='audit_events'&&method==='POST'?{code:'57014',status:500}:null});
  const store=createStore({SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-only'},{fetchImpl:fake.fetchImpl});
  const state=seedWorkspaceState();await store.save(state.workspace.id,state);
  const count=()=>fake.calls.filter(call=>call.method==='POST'&&call.url.pathname.endsWith('/audit_events')).length;
  const baseline=count();await store.save(state.workspace.id,state);assert.equal(count(),baseline);
  state.audit.unshift({id:'new-event',type:'test',actor:'owner',createdAt:new Date().toISOString(),detail:{}});
  fail=true;await store.save(state.workspace.id,state);assert.equal(count(),baseline+1);
  fail=false;await store.save(state.workspace.id,state);assert.equal(count(),baseline+2);
  const written=JSON.parse(fake.calls.filter(call=>call.url.pathname.endsWith('/audit_events')).at(-1).body);
  assert.equal(written.length,1);assert.equal(written[0].id,'new-event');
  assert.equal(fake.tables.get('audit_events').length,state.audit.length);
});

test('cancelled primary statement retries once with identical revision guard; other failures do not retry', async()=>{
  let failures=0,code='57014';
  const fake=fakeSupabase({fault:({table,method})=>table==='saas_workspace_state'&&method==='PATCH'&&failures-->0?{code,status:500}:null});
  const store=createStore({SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-only'},{fetchImpl:fake.fetchImpl});
  const state=seedWorkspaceState();await store.save(state.workspace.id,state);
  const before=fake.calls.length;failures=1;await store.save(state.workspace.id,state);
  const patches=fake.calls.slice(before).filter(call=>call.method==='PATCH');
  assert.equal(patches[0].url.href,patches[1].url.href);assert.equal(patches[0].body,patches[1].body);
  failures=2;await assert.rejects(store.save(state.workspace.id,state),error=>error.databaseCode==='57014');
  failures=1;code='42501';const start=fake.calls.length;
  await assert.rejects(store.save(state.workspace.id,state),error=>error.databaseCode==='42501');
  assert.equal(fake.calls.slice(start).filter(call=>call.method==='PATCH').length,1);
});


test('existing Supabase workspaces archive growing operational histories before compacting hot state', async () => {
  const state = seedWorkspaceState();
  const fake = fakeSupabase();
  const store = createStore({ SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-only' }, { fetchImpl: fake.fetchImpl });
  await store.save(state.workspace.id, state);
  assert.equal(fake.calls.some(call => call.url.pathname.endsWith('/runvara_history')), false, 'new workspace must not archive before its FK parent exists');

  const loaded = await store.get(state.workspace.id);
  loaded.workRecords = Array.from({ length: 140 }, (_, i) => ({ id: `work_${i}`, title: `Work ${i}`, status: 'COMPLETED', evidence: [{ type: 'test', id: String(i) }], updatedAt: new Date(Date.now() - i * 1000).toISOString() }));
  loaded.automationRuns = Array.from({ length: 40 }, (_, i) => ({ id: `automation_${i}`, ruleId: 'profitGuard', status: 'COMPLETED', startedAt: new Date(Date.now() - (i < 5 ? i * 1000 : 86400000 + i * 1000)).toISOString(), completedAt: new Date().toISOString(), evidence: [] }));
  loaded.connectionSyncs = Array.from({ length: 130 }, (_, i) => ({ id: `sync_${i}`, provider: 'shopify', status: 'completed', startedAt: new Date(Date.now() - i * 1000).toISOString() }));
  loaded.agentRuns = [{ id: 'agent_new', completedAt: new Date().toISOString(), results: [] }, { id: 'agent_old', completedAt: new Date(Date.now() - 86400000).toISOString(), results: [] }];
  await store.save(state.workspace.id, loaded);

  const persisted = await store.get(state.workspace.id);
  assert.equal(persisted.workRecords.length, 100);
  assert.ok(persisted.automationRuns.length < 40);
  assert.equal(persisted.connectionSyncs.length, 100);
  assert.equal(persisted.agentRuns.length, 1);
  assert.ok((fake.tables.get('runvara_history') || []).length >= 72);
});
