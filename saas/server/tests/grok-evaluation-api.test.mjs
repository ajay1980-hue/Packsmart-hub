import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createPacksmartServer } from '../server.mjs';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

const SECRET = 'grok-evaluation-test-session-secret-more-than-thirty-two-characters';
const WS = 'packsmart-solutions', OTHER = 'grok-test-customer', OWNER = 'internal-owner@example.test';
const TEST_KEY = 'xai-' + 'synthetic-test-only-'.repeat(3);
const ROUTE = '/api/operator/grok-evaluation';
async function fixture(t, env = {}) {
  const states = [WS, OTHER].map(workspaceId => {
    const state = seedWorkspaceState({}, { workspaceId, email: OWNER, passwordHash: 'private-password-sentinel' });
    state._revision = 'synthetic-stored-revision'; state.users[0].passwordChangeRequired = false;
    for (const role of ['admin', 'member', 'viewer']) state.users.push({ ...state.users[0], id: workspaceId + '-' + role, role, email: role + '@example.test' });
    state.privateSentinel = 'private-tenant-business-data'; return state;
  });
  const fake = fakeSupabase({ initialStates: states });
  const store = createStore({ SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_SERVICE_ROLE_KEY: 'private-service-key-sentinel' }, { fetchImpl: fake.fetchImpl });
  store.integrityCheck = undefined;
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: SECRET, PACKSMART_ADMIN_EMAIL: OWNER,
    SHOPIFY_PUBLIC_SYNC_ENABLED: 'false', XAI_API_KEY: TEST_KEY, ...env }, {
    store, schedulerEnabled: false, agentOpsEnabled: false, fetchImpl: async () => assert.fail('Evaluation must not call a provider')
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await server.packsmart.drain(); await new Promise(resolve => server.close(resolve)); });
  const auth = (workspaceId = WS, role = 'owner') => {
    const user = fake.states.get(workspaceId).users.find(item => item.role === role);
    const token = createSessionToken({ workspaceId, userId: user.id, email: user.email, role, sessionVersion: 1 }, SECRET);
    return { token, csrf: verifySessionToken(token, SECRET).csrf };
  };
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route = ROUTE, { identity = auth(), method = 'GET', body, headers = {}, csrf = true } = {}) => {
    if (identity) { headers.Cookie = `packsmart_session=${identity.token}`; if (csrf) headers['X-CSRF-Token'] = identity.csrf; }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return { fake, store, server, auth, request, base };
}

test('internal preparation uses one compact identity read and no business, job or accounting writes', async t => {
  const f = await fixture(t, { RUNVARA_XAI_INTERNAL_EVAL_ENABLED: 'true', RUNVARA_XAI_PAID_USAGE_APPROVED: 'true' });
  for (const name of ['get', 'save', 'listWorkspaceIds', 'listAgentJobs', 'enqueueAgentJob', 'reserveProviderUsage', 'settleProviderUsage', 'getOperatorBriefContext']) f.store[name] = async () => assert.fail(`${name} must not be called`);
  const before = structuredClone([...f.fake.states]), result = await f.request();
  assert.equal(result.status, 200); assert.equal(result.body.workspaceId, WS); assert.equal(result.body.configuration.secretStored, true);
  assert.equal(result.body.executionAuthorized, false); assert.equal(result.body.customerEnabled, false);
  assert.equal(result.headers.get('cache-control'), 'no-store'); assert.equal(f.fake.calls.length, 1);
  assert.equal(f.fake.calls[0].method, 'GET'); assert.equal(f.fake.calls[0].url.searchParams.get('select'), 'state->workspace,state->users');
  assert.equal(f.fake.calls[0].url.searchParams.get('workspace_id'), 'eq.' + WS); assert.deepEqual([...f.fake.states], before);
  const encoded = JSON.stringify(result.body);
  for (const value of [TEST_KEY, OTHER, OWNER, 'private-password-sentinel', 'private-service-key-sentinel', 'private-tenant-business-data']) assert.ok(!encoded.includes(value));
});

test('customers, non-owner roles and changed platform owner identities are denied', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(ROUTE, { identity: null })).status, 401); assert.equal(f.fake.calls.length, 0);
  for (const role of ['admin', 'member', 'viewer']) {
    const denied = await f.request(ROUTE, { identity: f.auth(WS, role) }); assert.equal(denied.status, 403); assert.equal(denied.body.code, 'PLATFORM_ADMIN_REQUIRED');
  }
  const customer = await f.request(ROUTE, { identity: f.auth(OTHER) }); assert.equal(customer.status, 403); assert.equal(customer.body.code, 'PLATFORM_ADMIN_REQUIRED');
  const identity = f.auth(); f.fake.states.get(WS).users[0].email = 'another-owner@example.test';
  assert.equal((await f.request(ROUTE, { identity })).body.code, 'PLATFORM_ADMIN_REQUIRED');
  assert.ok(f.fake.calls.every(call => call.method === 'GET'));
});

test('every request retains fresh session revocation, role and forced password checks', async t => {
  const f = await fixture(t), identity = f.auth(), user = f.fake.states.get(WS).users[0];
  user.sessionVersion = 2; assert.equal((await f.request(ROUTE, { identity })).body.code, 'SESSION_INVALID');
  user.sessionVersion = 1; user.active = false; assert.equal((await f.request(ROUTE, { identity })).body.code, 'SESSION_INVALID');
  user.active = true; user.passwordChangeRequired = true; assert.equal((await f.request(ROUTE, { identity })).body.code, 'PASSWORD_CHANGE_REQUIRED');
  user.passwordChangeRequired = false; user.role = 'admin'; assert.equal((await f.request(ROUTE, { identity })).body.code, 'PLATFORM_ADMIN_REQUIRED');
  user.role = 'owner'; assert.equal((await f.request(ROUTE, { identity })).status, 200);
});

test('scope, model and execution overrides are rejected and headers cannot select another tenant', async t => {
  const f = await fixture(t);
  for (const query of ['?workspaceId=' + OTHER, '?tenantId=' + WS, '?model=grok-4.7', '?execute=true', '?approve=true']) {
    const result = await f.request(ROUTE + query); assert.equal(result.status, 400); assert.equal(result.body.code, 'GROK_EVALUATION_REQUEST_INVALID');
  }
  const result = await f.request(ROUTE, { headers: { 'X-Workspace-Id': OTHER, 'X-XAI-Model': 'different-model' } });
  assert.equal(result.status, 200); assert.equal(result.body.workspaceId, WS); assert.equal(result.body.model, 'grok-4.7');
  assert.ok(f.fake.calls.every(call => call.url.searchParams.get('workspace_id') === 'eq.' + WS));
});

test('POST execution, CSRF failures and GET bodies never mutate state or start paid work', async t => {
  const f = await fixture(t), before = structuredClone([...f.fake.states]);
  const post = await f.request(ROUTE, { method: 'POST', body: { execute: true, workspaceId: OTHER } });
  assert.equal(post.status, 405); assert.equal(post.body.code, 'GROK_EVALUATION_READ_ONLY');
  const csrf = await f.request(ROUTE, { method: 'POST', body: { approve: true }, csrf: false });
  assert.equal(csrf.status, 403); assert.equal(csrf.body.code, 'CSRF_INVALID');
  const identity = f.auth(), body = JSON.stringify({ execute: true });
  const getBody = await new Promise((resolve, reject) => {
    const req = http.request(f.base + ROUTE, { method: 'GET', headers: { Cookie: `packsmart_session=${identity.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      const chunks = []; res.on('data', part => chunks.push(part)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    }); req.on('error', reject); req.end(body);
  });
  assert.equal(getBody.status, 400); assert.equal(getBody.body.code, 'GROK_EVALUATION_REQUEST_INVALID');
  assert.deepEqual([...f.fake.states], before); assert.ok(f.fake.calls.every(call => call.method === 'GET'));
});

test('unsigned, forged and expired sessions cannot read evaluation state', async t => {
  const f = await fixture(t), identity = f.auth(), [encoded, signature] = identity.token.split('.');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  const forged = Buffer.from(JSON.stringify({ ...payload, workspaceId: OTHER })).toString('base64url') + '.' + signature;
  const expired = createSessionToken({ workspaceId: WS, userId: payload.sub, email: OWNER, role: 'owner' }, SECRET, -60);
  for (const token of [forged, expired, 'unsigned-session']) assert.equal((await f.request(ROUTE, { identity: { token } })).status, 401);
  assert.equal(f.fake.calls.length, 0);
});

test('missing compact identity support, duplicate users and mismatched stored workspaces fail closed', async t => {
  const f = await fixture(t), identity = f.auth(), getIdentity = f.store.getIdentity.bind(f.store);
  f.store.get = async () => assert.fail('No full-state authentication fallback is allowed');
  f.store.getIdentity = undefined;
  const unavailable = await f.request(ROUTE, { identity });
  assert.equal(unavailable.status, 503); assert.equal(unavailable.body.code, 'GROK_EVALUATION_IDENTITY_UNAVAILABLE'); assert.equal(f.fake.calls.length, 0);
  f.store.getIdentity = getIdentity;
  const state = f.fake.states.get(WS); state.users.push({ ...state.users[0] });
  assert.equal((await f.request(ROUTE, { identity })).body.code, 'GROK_EVALUATION_IDENTITY_INVALID');
  state.users.pop(); state.workspace.id = OTHER;
  const mismatched = await f.request(ROUTE, { identity });
  assert.equal(mismatched.status, 403); assert.equal(mismatched.body.code, 'WORKSPACE_MISMATCH');
});

test('public health excludes Grok settings, requests and credential presence', async t => {
  const f = await fixture(t), health = await f.request('/api/health', { identity: null });
  assert.equal(health.status, 200);
  const encoded = JSON.stringify(health.body);
  for (const value of ['grok', 'xai', TEST_KEY, WS, 'secretStored', 'paidUsageApproved', 'runvara-grok-evaluation/v1']) assert.ok(!encoded.toLowerCase().includes(value.toLowerCase()));
});
