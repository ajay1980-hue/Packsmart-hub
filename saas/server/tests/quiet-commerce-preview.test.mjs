import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { maintenanceFixture, ownerState, SECRET } from './maintenance-login-fixture.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { quietCommercePreview } from '../lib/quiet-commerce-preview.mjs';
import { createStartupPolicy } from '../lib/startup-mode.mjs';

const ROUTE = '/api/maintenance/commerce';
const enabled = { RUNVARA_QUIET_OWNER_LOGIN: 'disabled/v1', RUNVARA_QUIET_COMMERCE_PREVIEW: 'enabled/v1' };
const cookie = (id = 'alpha', overrides = {}, ttl) => '__Host-packsmart_session=' + createSessionToken({ userId: id + '-owner', workspaceId: id,
  email: id + '@example.test', role: 'owner', sessionVersion: 1, ...overrides }, SECRET, ttl);
const writes = f => f.calls.filter(call => !['GET', 'HEAD'].includes(call.method));
function saved(id = 'alpha') {
  const s = ownerState(id);
  s.products = [{ id: 'p1', title: '<img src=https://forbidden.invalid onerror=alert(1)>', currency: 'GBP',
    image: 'https://forbidden.invalid/image.png', variants: [{ id: 'v1', title: 'Small', sku: 'shared', inventory: 0, price: '2.50' },
      { id: 'v2', title: 'Large', sku: 'shared', inventory: null, price: '' }] }];
  s.economics = { shared: { supplierUnitCost: '0.00', landed: null, supplierVatRate: false, currency: 'GBP', notes: 'private-note' },
    v2: { supplierUnitCost: '4.20', packing: '0.10', token: 'private-cost-token' } };
  s.connections = [{ provider: 'shopify', status: 'connected', credentials: 'private-connection' }];
  return s;
}
async function fixture(t, options = {}) {
  t.mock.method(console, 'error', () => {});
  const f = await maintenanceFixture({ states: [saved(), saved('beta')], ...options, env: { ...enabled, ...options.env } });
  t.after(f.close); return f;
}
test('preview policy is strict, disabled by default, quiet-only and immutable', () => {
  for (const value of ['', 'true', 'enabled', 'enabled/v1 ', null, true, {}, 1]) {
    assert.throws(() => createStartupPolicy({ RUNVARA_STARTUP_MODE: 'quiet', RUNVARA_QUIET_COMMERCE_PREVIEW: value }, []), { code: 'QUIET_COMMERCE_PREVIEW_INVALID' });
  }
  for (const mode of [undefined, 'normal']) assert.throws(() => createStartupPolicy({ RUNVARA_STARTUP_MODE: mode, RUNVARA_QUIET_COMMERCE_PREVIEW: 'enabled/v1' }, []), { code: 'QUIET_COMMERCE_PREVIEW_INVALID' });
  const env = { RUNVARA_STARTUP_MODE: 'quiet', ...enabled }, policy = createStartupPolicy(env, []);
  env.RUNVARA_QUIET_COMMERCE_PREVIEW = 'disabled/v1';
  assert.equal(policy.quietCommercePreview, true); assert.equal(policy.quietOwnerLogin, false);
  assert.throws(() => { policy.quietCommercePreview = false; }, TypeError);
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'get']) {
    for (const route of [ROUTE, ROUTE + '/', '/api/maintenance/%63ommerce', '/api/bootstrap', '/api/auth/login']) {
      assert.equal(policy.allowsRequest(method, route), method === 'GET' && route === ROUTE);
    }
  }
  for (const value of [undefined, 'disabled/v1']) assert.equal(createStartupPolicy({ RUNVARA_STARTUP_MODE: 'quiet', RUNVARA_QUIET_COMMERCE_PREVIEW: value }, []).allowsRequest('GET', ROUTE), false);
});
test('owner preview is an exact no-store tenant snapshot, repeated without hydration, joins, writes or provider calls', async t => {
  const f = await fixture(t), before = structuredClone([...f.fake.states]);
  for (let i = 0; i < 3; i++) {
    const r = await f.request(ROUTE + '?workspaceId=beta', { cookie: cookie(), headers: { 'X-Workspace-Id': 'beta' } });
    assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.cookie, null);
    assert.equal(r.payload.workspace.id, 'alpha'); assert.equal(r.payload.rows.length, 2);
    assert.deepEqual(r.payload.rows.map(row => [row.stock, row.price]), [['0', '2.50'], [null, null]]);
    assert.equal(r.payload.costs[0].amounts.supplierUnitCost, '0.00');
    assert.equal(r.payload.costs[0].amounts.supplierVatRate, null);
    assert.equal(r.payload.costs[1].key, 'v2'); assert.equal(r.payload.costs[1].amounts.supplierUnitCost, '4.20');
    assert.ok(r.payload.rows.every(row => !Object.hasOwn(row, 'cost')));
    assert.doesNotMatch(JSON.stringify(r.payload), /passwordHash|credentials|private-note|private-cost-token|private-connection|image\.png|csrf|audit/);
  }
  assert.equal(f.calls.length, 3);
  assert.equal(f.store.schedulerCache.size, 0, 'exact reads cannot hydrate or populate scheduler state');
  assert.ok(f.calls.every(call => call.method === 'GET' && call.url.searchParams.get('select') === 'state'
    && call.url.searchParams.get('workspace_id') === 'eq.alpha'));
  assert.deepEqual([...f.fake.states], before); assert.equal(writes(f).length, 0); assert.equal(f.fake.tables.size, 0);
  assert.equal(f.server.packsmart.scheduler.status.lastTickAt, null); assert.equal(f.server.packsmart.agentOps.status.lastTickAt, null);
  const beta = await f.request(ROUTE, { cookie: cookie('beta') }); assert.equal(beta.payload.workspace.id, 'beta');
  const session = await f.request('/api/auth/session', { cookie: cookie() }); assert.equal(session.payload.savedCommercePreview, true);
});
test('disabled/alternate routes reject before persistence, including malformed bodies and ready work', async t => {
  const f = await fixture(t);
  for (const route of [ROUTE + '/', '/api/maintenance/%63ommerce', '/api/bootstrap', '/api/migrate-pilot', '/api/auth/login', '/api/auth/signup',
    '/api/webhooks/stripe', '/api/integrations/shopify/oauth/callback', '/api/connections/shopify/refresh', '/api/marketing', '/api/meta-production/context']) {
    for (const method of ['GET', 'POST']) assert.equal((await f.request(route, { method, cookie: cookie(), ...(method === 'POST' ? { body: '{bad' } : {}) })).status, 503);
  }
  for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal((await f.request(ROUTE, { method, cookie: cookie() })).status, 503);
  assert.equal(f.calls.length, 0);
  const off = await fixture(t, { env: { RUNVARA_QUIET_COMMERCE_PREVIEW: 'disabled/v1' } });
  assert.equal((await off.request(ROUTE, { cookie: cookie() })).status, 503); assert.equal(off.calls.length, 0);
  assert.equal((await off.request('/api/auth/session', { cookie: cookie() })).payload.savedCommercePreview, undefined);
});
test('current owner role, password setup, identity and session revocation remain mandatory', async t => {
  const f = await fixture(t), user = f.fake.states.get('alpha').users[0];
  for (const role of ['admin', 'member', 'viewer', null]) {
    user.role = role;
    assert.equal((await f.request(ROUTE, { cookie: cookie() })).status, 403);
    assert.equal((await f.request('/api/auth/session', { cookie: cookie() })).payload.savedCommercePreview, undefined);
  }
  user.role = 'owner'; user.passwordChangeRequired = true;
  assert.equal((await f.request(ROUTE, { cookie: cookie() })).status, 403);
  delete user.passwordChangeRequired;
  assert.equal((await f.request(ROUTE, { cookie: cookie() })).status, 403);
  user.passwordChangeRequired = false;
  for (const c of [undefined, '__Host-packsmart_session=invalid', cookie('alpha', {}, -1), cookie('beta', { userId: 'alpha-owner' })]) {
    assert.equal((await f.request(ROUTE, { cookie: c })).status, 401);
  }
  user.active = false; assert.equal((await f.request(ROUTE, { cookie: cookie() })).status, 401);
  user.active = true; user.sessionVersion++;
  assert.equal((await f.request(ROUTE, { cookie: cookie() })).status, 401);
  assert.equal(writes(f).length, 0);
});
test('foreign/malformed evidence is excluded, duplicate actors refused and bounded outputs disclose truncation', () => {
  const state = saved();
  state.products.push({ workspaceId: 'beta', title: 'FOREIGN', variants: [] });
  state.products[0].variants.push({ tenant: { id: 'beta' }, title: 'FOREIGN', inventory: 1 });
  state.economics.foreign = { workspace_id: 'beta', supplierUnitCost: 999 };
  const auth = { state, session: { workspaceId: 'alpha', sub: 'alpha-owner' } };
  state.products[0].variants[1].currency = 'invalid';
  const result = quietCommercePreview(auth);
  assert.equal(result.rows[1].currency, null, 'invalid variant currency is not replaced with a product currency');
  assert.equal(result.partial, true); assert.doesNotMatch(JSON.stringify(result), /FOREIGN|999/);
  const frozen = structuredClone(state); quietCommercePreview(auth); assert.deepEqual(state, frozen);
  state.products = Array.from({ length: 110 }, (_, i) => ({ id: String(i), title: 'Saved', variants: [] }));
  state.economics = Object.fromEntries(Array.from({ length: 110 }, (_, i) => [String(i), { landed: 0 }]));
  const limited = quietCommercePreview(auth); assert.equal(limited.rows.length, 100); assert.equal(limited.costs.length, 100); assert.equal(limited.partial, true);
  state.users.push(structuredClone(state.users[0])); assert.throws(() => quietCommercePreview(auth), { code: 'COMMERCE_PREVIEW_SCOPE_INVALID' });
  state.users.pop(); state.tenantId = 'beta'; assert.throws(() => quietCommercePreview(auth), { code: 'COMMERCE_PREVIEW_SCOPE_INVALID' });
});
test('revocation during the saved read is checked against that same snapshot', async t => {
  const f = await fixture(t, { intercept: ({ fake, proceed }) => { fake.states.get('alpha').users[0].role = 'viewer'; return proceed(); } });
  assert.equal((await f.request(ROUTE, { cookie: cookie() })).status, 403);
  assert.equal(f.calls.length, 1); assert.equal(writes(f).length, 0);
});
test('failed and interrupted saved reads neither retry writes nor change retained state', async t => {
  const failed = await fixture(t, { fault: ({ method }) => method === 'GET' ? new Response('{}', { status: 503 }) : null });
  assert.notEqual((await failed.request(ROUTE, { cookie: cookie() })).status, 200);
  assert.equal(writes(failed).length, 0);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { intercept: async ({ proceed }) => { entered(); await gate; return proceed(); } });
  const before = structuredClone([...f.fake.states]), controller = new AbortController();
  const pending = f.request(ROUTE, { cookie: cookie(), signal: controller.signal });
  await started; controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); release();
  await turn(); await f.close();
  assert.equal(writes(f).length, 0); assert.deepEqual([...f.fake.states], before);
});
