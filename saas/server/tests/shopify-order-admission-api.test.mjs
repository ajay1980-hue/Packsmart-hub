import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { IntegrationService } from '../lib/integrations.mjs';
import { connectionSettings, shopifyOrderReadBinding } from '../lib/connection-centre.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shopify-admission-api-'));
  const workspaceId = 'shopify-admission-api', secret = 'shopify-admission-session-fixture-over-thirty-two-characters';
  const env = { NODE_ENV: 'test', SESSION_SECRET: secret, SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false',
    SHOPIFY_ENV_WORKSPACE_ID: workspaceId, SHOPIFY_STORE_DOMAIN: 'admission.myshopify.com', SHOPIFY_ADMIN_ACCESS_TOKEN: 'synthetic-access-token', SHOPIFY_ADMIN_API_VERSION: '2026-07' };
  const calls = [];
  let failOrders = false;
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body.query);
    if (body.query.includes('PacksmartOpsProducts')) return Response.json({ data: { products: { nodes: [], pageInfo: { hasNextPage: false } } } });
    assert.match(body.query, /PacksmartOpsOrders/);
    if (failOrders) return Response.json({ data: { orders: { nodes: [], pageInfo: {} } } });
    return Response.json({ data: { orders: { nodes: [], pageInfo: { hasNextPage: false } } } }, { headers: { 'X-Shopify-API-Version': '2026-07' } });
  };
  const server = createPacksmartServer(env, { fetchImpl, schedulerEnabled: false, agentOpsEnabled: false });
  t.after(async () => { await server.packsmart.drain(); if (server.listening) await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const state = seedWorkspaceState({}, { workspaceId, email: 'owner@admission.test', passwordHash: 'fixture' });
  state.users[0].passwordChangeRequired = false;
  state.connectionSettings = { shopify: { ...connectionSettings(state, 'shopify'), areas: ['products', 'orders'] } };
  state.orders = []; state.products = [];
  state.connectionDoctor = { shopify: { attempts: 5, exhausted: true, orderReadBinding: shopifyOrderReadBinding(state, new IntegrationService(env)) } };
  await server.packsmart.store.save(workspaceId, state);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = createSessionToken({ workspaceId, userId: state.users[0].id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  const csrf = verifySessionToken(token, secret).csrf;
  const request = (route, body, { authenticated = true, csrfToken = csrf } = {}) => fetch(base + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: `packsmart_session=${token}`, 'X-CSRF-Token': csrfToken } : {}) }, body: JSON.stringify(body) });
  return { calls, request, get: () => server.packsmart.store.get(workspaceId),
    save: state => server.packsmart.store.save(workspaceId, state), failOrders: () => { failOrders = true; } };
}

test('manual products-only and malformed scopes cannot reset an uncertain orders budget', async t => {
  const f = await fixture(t), budget = structuredClone((await f.get()).connectionDoctor.shopify);
  const route = '/api/connections/shopify/sync';
  assert.equal((await f.request(route, { areas: ['orders'] }, { authenticated: false })).status, 401);
  assert.equal((await f.request(route, { areas: ['orders'] }, { csrfToken: 'wrong' })).status, 403);
  for (const areas of [null, [], ['unsupported'], ['orders', 'unsupported']]) {
    assert.equal((await f.request(route, { areas })).status, 400);
    assert.deepEqual((await f.get()).connectionDoctor.shopify, budget);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.request(route, { areas: ['products'] })).status, 200);
  assert.deepEqual((await f.get()).connectionDoctor.shopify, budget);
  assert.equal(f.calls.length, 1); assert.match(f.calls[0], /Products/);
  assert.equal((await f.request(route, { areas: ['orders'] })).status, 200);
  const after = await f.get();
  assert.equal(Boolean(after.connectionDoctor.shopify.exhausted), false);
  assert.equal(after.connectionDoctor.shopify.orderReadBinding, undefined);
});

test('implicit first-sync retry preserves order budget when only products remain incomplete', async t => {
  const f = await fixture(t), state = await f.get();
  const budget = structuredClone(state.connectionDoctor.shopify);
  state.connectionFirstSync = { shopify: { status: 'failed', identityVerifiedAt: '2026-10-07T10:00:00.000Z',
    actor: state.users[0].id, areas: { products: 'failed', orders: 'completed' }, failures: {} } };
  await f.save(state);
  assert.equal((await f.request('/api/connections/shopify/sync', {})).status, 200);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0], /PacksmartOpsProducts/);
  assert.deepEqual((await f.get()).connectionDoctor.shopify, budget);
});

for (const route of ['/api/integrations/shopify/sync', '/api/integrations/sync']) {
  test(`failed source read retains the consumed budget through ${route}`, async t => {
    const f = await fixture(t), before = (await f.get()).connectionDoctor.shopify;
    f.failOrders();
    assert.equal((await f.request(route, {})).status, route === '/api/integrations/sync' ? 200 : 422);
    const state = await f.get();
    assert.deepEqual(state.connectionDoctor.shopify, before);
    assert.match(state.integrationStatus.shopify.orderReadHold.code, /^SHOPIFY_ORDER_SOURCE_/);
    assert.equal(f.calls.filter(query => query.includes('PacksmartOpsOrders')).length, 1);
  });
  test(`actual admitted source success releases the budget through ${route}`, async t => {
    const f = await fixture(t);
    assert.equal((await f.request(route, {})).status, 200);
    const state = await f.get();
    assert.equal(state.integrationStatus.shopify.orderReadAttempt.status, 'complete');
    assert.equal(state.connectionDoctor.shopify.attempts, 0);
    assert.equal(state.connectionDoctor.shopify.exhausted, false);
    assert.equal(state.connectionDoctor.shopify.orderReadBinding, undefined);
    assert.equal(f.calls.filter(query => query.includes('PacksmartOpsOrders')).length, 1);
  });
}
