import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';

test('Supabase persistence mirrors every production table and restores lossless workspace state', async () => {
  const calls = [];
  let savedState = null;
  const serviceKey = 'test-service-role-value-that-never-enters-a-response';
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method || 'GET';
    calls.push({ url, method, headers: options.headers, body: options.body || '' });
    assert.equal(options.headers.apikey, serviceKey);
    assert.equal(options.headers.Authorization, `Bearer ${serviceKey}`);

    if (method === 'POST') {
      if (url.pathname.endsWith('/saas_workspace_state')) {
        savedState = JSON.parse(options.body)[0].state;
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith('/users')) {
      const user = savedState.users[0];
      return Response.json([{
        id: user.id,
        workspace_id: savedState.workspace.id,
        email: user.email,
        role: user.role,
        password_hash: user.passwordHash,
        password_change_required: user.passwordChangeRequired,
        active: user.active,
        session_version: user.sessionVersion,
        created_at: user.createdAt,
        updated_at: user.updatedAt
      }]);
    }
    if (url.searchParams.get('select') === 'state') {
      return Response.json(savedState ? [{ state: savedState }] : []);
    }
    return Response.json(savedState ? [{ workspace_id: savedState.workspace.id }] : []);
  };

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
    'orders', 'operations_briefs', 'saas_workspace_state'
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
