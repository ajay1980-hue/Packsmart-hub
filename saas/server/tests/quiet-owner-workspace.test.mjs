import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { maintenanceFixture, ownerState, SECRET } from './maintenance-login-fixture.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { createStartupPolicy } from '../lib/startup-mode.mjs';
import { assertQuietOwnerWorkspace } from '../lib/quiet-owner-workspace.mjs';
import { quietCreativeFixture } from './quiet-creative-fixture.mjs';

const ID = 'packsmart-solutions', enabled = { RUNVARA_QUIET_OWNER_LOGIN: 'disabled/v1', RUNVARA_QUIET_OWNER_WORKSPACE: 'enabled/v1' };
const cookie = (id = ID, changes = {}, ttl) => '__Host-packsmart_session=' + createSessionToken({ userId: id + '-owner', workspaceId: id,
  email: id + '@example.test', role: 'owner', sessionVersion: 1, ...changes }, SECRET, ttl);
const writes = f => f.calls.filter(call => !['GET', 'HEAD'].includes(call.method));
async function fixture(t, options = {}) {
  t.mock.method(console, 'error', () => {});
  const f = await maintenanceFixture({ states: [ownerState(ID), ownerState('beta')], ...options, env: { ...enabled, ...options.env } }); t.after(f.close); return f;
}
test('owner workspace is exact, quiet-only, disabled by default and immutable', () => {
  for (const value of ['', 'true', 'enabled/v1 ', null, true, {}, 1]) assert.throws(() => createStartupPolicy({ RUNVARA_STARTUP_MODE: 'quiet', RUNVARA_QUIET_OWNER_WORKSPACE: value }, []), { code: 'QUIET_OWNER_WORKSPACE_INVALID' });
  assert.throws(() => createStartupPolicy({ RUNVARA_QUIET_OWNER_WORKSPACE: 'enabled/v1' }, []), { code: 'QUIET_OWNER_WORKSPACE_INVALID' });
  const env = { RUNVARA_STARTUP_MODE: 'quiet', ...enabled }, p = createStartupPolicy(env, []);
  env.RUNVARA_QUIET_OWNER_WORKSPACE = 'disabled/v1'; assert.equal(p.quietOwnerWorkspace, true); assert.equal(Object.isFrozen(p), true);
  assert.equal(createStartupPolicy({ RUNVARA_STARTUP_MODE: 'quiet' }, []).allowsRequest('GET', '/api/bootstrap'), false);
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']) for (const path of ['/api/bootstrap', '/api/bootstrap/', '/api/migrate-pilot', '/api/integrations/sync', '/api/integrations/shopify/sync', '/api/connections/shopify/sync', '/api/auth/login', '/api/marketing']) assert.equal(p.allowsRequest(method, path), method === 'GET' && path === '/api/bootstrap');
});
test('existing support and creative exceptions retain their own admission, not widened by owner workspace', () => {
  const support = createStartupPolicy({ RUNVARA_STARTUP_MODE: 'quiet', ...enabled, RUNVARA_QUIET_PUBLIC_SUPPORT: 'enabled/v1' }, []);
  assert.equal(support.allowsRequest('POST', '/api/public/support'), true); assert.equal(support.allowsRequest('PUT', '/api/public/support'), false);
  const creative = quietCreativeFixture(), policy = createStartupPolicy({ ...creative.env, RUNVARA_QUIET_OWNER_WORKSPACE: 'enabled/v1' }, []);
  assert.equal(policy.allowsRequest('POST', '/api/maintenance/creative-pilot/submit'), true);
  assert.equal(policy.allowsRequest('POST', '/api/marketing/campaigns/x/advance'), false);
});
test('existing bootstrap uses detached exact snapshot, no persistence, no migration and no worker tick', async t => {
  const f = await fixture(t), before = structuredClone([...f.fake.states]);
  for (let i = 0; i < 2; i++) {
    const r = await f.request('/api/bootstrap', { cookie: cookie() });
    assert.equal(r.status, 200, JSON.stringify(r.payload)); assert.equal(r.payload.ownerWorkspace, true); assert.equal(r.payload.automaticWorkPaused, true);
    assert.equal(r.payload.workspace.id, ID); assert.equal(r.payload.brief.transient, true); assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.cookie, null);
    for (const key of ['dashboard', 'products', 'orders', 'connectionCentre', 'approvals', 'hypergrowth']) assert.ok(Object.hasOwn(r.payload, key), key);
    assert.doesNotMatch(JSON.stringify(r.payload), /passwordHash|encryptedCredentials/);
  }
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.url.searchParams.get('select') === 'state' && call.url.searchParams.get('workspace_id') === 'eq.' + ID));
  assert.deepEqual([...f.fake.states], before); assert.equal(writes(f).length, 0); assert.equal(f.fake.tables.size, 0); assert.equal(f.store.schedulerCache.size, 0);
  const reads = f.calls.length;
  f.server.packsmart.scheduler.start(); f.server.packsmart.agentOps.start(); await f.server.packsmart.scheduler.tick(); await f.server.packsmart.agentOps.tick(); await turn();
  assert.equal(f.calls.length, reads); assert.equal(f.server.packsmart.scheduler.status.lastTickAt, null); assert.equal(f.server.packsmart.agentOps.status.lastTickAt, null);
});
test('even a shared deeply frozen workspace object is not mutated by bootstrap derivation', async t => {
  const f = await fixture(t), shared = ownerState(ID), before = structuredClone(shared);
  const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }; freeze(shared);
  t.mock.method(f.store, 'get', async (_id, options) => { assert.equal(options.exactSnapshot, true); return shared; });
  const r = await f.request('/api/bootstrap', { cookie: cookie() }); assert.equal(r.status, 200, JSON.stringify(r.payload)); assert.deepEqual(shared, before); assert.equal(writes(f).length, 0);
});
test('session advertises capability only to strict owner of the fixed tenant', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/auth/session', { cookie: cookie() })).payload.ownerWorkspace, true);
  assert.equal((await f.request('/api/auth/session', { cookie: cookie('beta') })).payload.ownerWorkspace, undefined);
  assert.equal((await f.request('/api/bootstrap', { cookie: cookie('beta') })).status, 403);
});
for (const role of ['admin', 'viewer', 'operator']) test(`bootstrap denies ${role}, despite a signed owner role claim`, async t => {
  const f = await fixture(t); f.fake.states.get(ID).users[0].role = role;
  assert.equal((await f.request('/api/bootstrap', { cookie: cookie() })).status, 403); assert.equal((await f.request('/api/auth/session', { cookie: cookie() })).payload.ownerWorkspace, undefined); assert.equal(writes(f).length, 0);
});
test('expired, forged, inactive, revoked and mismatched sessions fail closed', async t => {
  const f = await fixture(t);
  for (const c of [undefined, '__Host-packsmart_session=forged', cookie(ID, {}, -1), cookie('beta', { userId: ID + '-owner' })]) assert.equal((await f.request('/api/bootstrap', { cookie: c })).status, 401);
  const user = f.fake.states.get(ID).users[0]; user.active = false; assert.equal((await f.request('/api/bootstrap', { cookie: cookie() })).status, 401);
  user.active = true; user.sessionVersion++; assert.equal((await f.request('/api/bootstrap', { cookie: cookie() })).status, 401); assert.equal(writes(f).length, 0);
});
test('password setup, duplicate actors and nested foreign scope are refused', async t => {
  const f = await fixture(t), s = f.fake.states.get(ID);
  s.users[0].passwordChangeRequired = true; assert.equal((await f.request('/api/bootstrap', { cookie: cookie() })).status, 403);
  s.users[0].passwordChangeRequired = false; s.users.push(structuredClone(s.users[0])); assert.equal((await f.request('/api/bootstrap', { cookie: cookie() })).status, 403);
  s.users.pop(); s.products.push({ id: 'foreign', workspaceId: 'beta' }); assert.equal((await f.request('/api/bootstrap', { cookie: cookie() })).status, 403); assert.equal(writes(f).length, 0);
});
test('bounded evidence validation fails closed without rewriting scope', () => {
  const s = ownerState(ID); s.example = Array.from({ length: 100001 }, () => ({}));
  assert.throws(() => assertQuietOwnerWorkspace({ state: s, session: { workspaceId: ID, sub: ID + '-owner', sessionVersion: 1 } }), { code: 'QUIET_OWNER_WORKSPACE_SCOPE_LIMIT' });
});
test('disabled gate and alternate methods/routes/queries reject before storage', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/bootstrap?workspaceId=beta', { cookie: cookie() })).status, 400);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) assert.equal((await f.request('/api/bootstrap', { method, cookie: cookie() })).status, 503);
  for (const path of ['/api/migrate-pilot', '/api/integrations/sync', '/api/connections/shopify/sync', '/api/integrations/shopify/sync', '/api/auth/login', '/api/marketing/providers/runway/test', '/api/connection-writes/x/execute', '/api/public/support', '/api/maintenance/creative-pilot/submit', '/api/maintenance/approval-pilot/request']) assert.equal((await f.request(path, { method: 'POST', cookie: cookie() })).status, 503);
  assert.equal(f.calls.length, 0);
  const closed = await fixture(t, { env: { RUNVARA_QUIET_OWNER_WORKSPACE: 'disabled/v1' } }); assert.equal((await closed.request('/api/bootstrap', { cookie: cookie() })).status, 503); assert.equal(closed.calls.length, 0);
});
test('revocation during read and read failure return no bootstrap', async t => {
  const revoked = await fixture(t, { intercept: ({ fake, proceed }) => { fake.states.get(ID).users[0].role = 'admin'; return proceed(); } });
  assert.equal((await revoked.request('/api/bootstrap', { cookie: cookie() })).status, 403); assert.equal(writes(revoked).length, 0);
  const failed = await fixture(t, { fault: ({ method }) => method === 'GET' ? new Response('{}', { status: 503 }) : null });
  const r = await failed.request('/api/bootstrap', { cookie: cookie() }); assert.notEqual(r.status, 200); assert.equal(r.payload.products, undefined); assert.equal(writes(failed).length, 0);
});
