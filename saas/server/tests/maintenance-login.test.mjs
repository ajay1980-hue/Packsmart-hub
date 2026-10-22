import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import { maintenanceFixture, ownerState, PASSWORD, SECRET } from './maintenance-login-fixture.mjs';
import { createSessionToken, hashPassword } from '../lib/security.mjs';

async function fixture(t, options) {
  t.mock.method(console, 'error', () => {});
  const f = await maintenanceFixture(options); t.after(f.close); return f;
}
const writes = f => f.calls.filter(call => !['GET', 'HEAD'].includes(call.method));
const cookieValue = result => result.cookie?.split(';')[0];
function noSession(result) { assert.equal(result.cookie, null); assert.equal(result.headers.get('cache-control'), 'no-store'); }
function assertOnlyLoginChanged(before, after, count) {
  assert.equal(after.audit.length, before.audit.length + count);
  assert.deepEqual(after.audit.slice(count), before.audit, 'no audit history trimmed');
  for (const audit of after.audit.slice(0, count)) {
    assert.equal(audit.type, 'user_login'); assert.equal(audit.actor, before.users[0].id);
    assert.deepEqual(audit.detail, { method: 'workspace-password', maintenance: true });
  }
  const normalized = structuredClone(after);
  normalized.audit = before.audit; normalized._revision = before._revision; normalized.workspace.updatedAt = before.workspace.updatedAt;
  assert.deepEqual(normalized, before, 'business state is byte-equivalent apart from audit/revision/time');
}

test('maintenance login persists only audit, keeps every prior entry, and binds repeated sessions to their real tenant', async t => {
  const alpha = ownerState(); alpha.audit = Array.from({ length: 301 }, (_, i) => ({ id: `old-${i}`, type: 'existing', detail: { i } }));
  const f = await fixture(t, { states: [alpha, ownerState('beta')] });
  const betaBefore = structuredClone(f.fake.states.get('beta'));
  for (let i = 0; i < 2; i++) {
    const result = await f.login({ workspaceId: 'beta', role: 'admin' }, { headers: { 'X-Workspace-Id': 'beta' } });
    assert.equal(result.status, 200);
    assert.equal(result.payload.maintenance, true);
    assert.match(result.cookie, /HttpOnly/); assert.match(result.cookie, /Secure/); assert.match(result.cookie, /SameSite=Strict/);
    assert.equal(result.payload.workspace.id, 'alpha'); assert.equal(result.payload.user.role, 'owner');
    assert.equal(result.payload.user.passwordHash, undefined);
    const beforeRead = f.calls.length;
    const session = await f.request('/api/auth/session?workspaceId=beta', { cookie: cookieValue(result), headers: { 'X-Workspace-Id': 'beta' } });
    assert.equal(session.status, 200); assert.equal(session.payload.workspace.id, 'alpha');
    assert.equal(session.payload.maintenance, true);
    assert.equal(f.calls.length, beforeRead + 1); assert.match(f.calls.at(-1).url.searchParams.get('select'), /^state->workspace,state->users$/);
  }
  assertOnlyLoginChanged(alpha, f.fake.states.get('alpha'), 2);
  assert.deepEqual(f.fake.states.get('beta'), betaBefore);
  assert.equal(writes(f).length, 2);
  assert.ok(writes(f).every(call => call.method === 'PATCH' && call.url.pathname.endsWith('/saas_workspace_state')));
  assert.equal(f.fake.tables.size, 0, 'no mirrors, audit archives or new tables written');
  const second = await f.login({ email: 'beta@example.test' });
  assert.equal(second.payload.workspace.id, 'beta');
});

test('maintenance allowance keeps business routes, alternate methods, workers and integrity closed', async t => {
  const f = await fixture(t);
  const routes = ['/api/bootstrap', '/api/brief', '/api/auth/signup', '/api/auth/signup-options', '/api/auth/activate-owner', '/api/auth/logout', '/api/auth/change-password',
    '/api/webhooks/stripe', '/api/public/support', '/api/integrations/shopify/oauth/callback?code=x', '/api/marketing/providers/canva/oauth/callback?code=x',
    '/api/connections/shopify/sync', '/api/connections/shopify/refresh', '/api/connection-writes/write_1/execute', '/api/agents/command', '/api/agent-ops/jobs',
    '/api/autopilot/run', '/api/marketing/campaigns', '/api/web-intelligence/scan', '/api/billing/checkout', '/api/meta-production/campaigns/test/proposals',
    '/api/meta-publication-assets/production-v1/test/test.jpg', '/api/auth/login/', '/api/auth/%6cogin'];
  for (const route of routes) for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
    // Fetch forbids TRACE; the policy's separate matrix covers that verb.
    if (method === 'TRACE') continue;
    const r = await f.request(route, { method, ...(['GET', 'HEAD'].includes(method) ? {} : { body: '{invalid' }) });
    assert.equal(r.status, 503, `${method} ${route}`); noSession(r);
    if (method !== 'HEAD') assert.equal(r.payload.code, 'STARTUP_QUIET_MODE');
  }
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) assert.equal((await f.request('/api/auth/login', { method })).status, 503);
  assert.equal((await f.request('/api/auth/login?workspaceId=beta', { method: 'POST', body: '{invalid' })).status, 400);
  f.server.packsmart.scheduler.start(); f.server.packsmart.agentOps.start();
  await Promise.all([f.server.packsmart.scheduler.tick(), f.server.packsmart.scheduler.runWorkspace('alpha', { force: true }), f.server.packsmart.agentOps.tick()]);
  assert.deepEqual(f.calls, []);
  const health = await f.request('/api/health');
  assert.equal(health.payload.startupMode, 'quiet'); assert.equal(health.payload.quietOwnerLogin, true);
  assert.equal(health.payload.productionReady, false); assert.equal(health.payload.agentOps.lastTickAt, null);
  assert.equal(health.payload.persistence.lastIntegrityCheckAt, null);
});

test('concurrent deliberate sign-ins keep distinct audit entries without lost updates', async t => {
  const state = ownerState(), f = await fixture(t, { states: [state] });
  const results = await Promise.all(Array.from({ length: 6 }, () => f.login()));
  assert.ok(results.every(result => result.status === 200 && result.cookie));
  assertOnlyLoginChanged(state, f.fake.states.get('alpha'), 6);
  assert.equal(new Set(f.fake.states.get('alpha').audit.slice(0, 6).map(row => row.id)).size, 6);
  assert.equal(writes(f).length, 6); assert.equal(f.fake.tables.size, 0);
});

test('malformed and oversized login bodies do not reach persistence', async t => {
  const f = await fixture(t);
  for (const body of ['{invalid', JSON.stringify({ email: 'alpha@example.test', password: 'x'.repeat(32768) })]) {
    const result = await f.request('/api/auth/login', { method: 'POST', body });
    assert.ok([400, 413].includes(result.status)); noSession(result);
  }
  assert.deepEqual(f.calls, []);
});

test('maintenance login cannot be enabled after construction and unsupported persistence fails closed', async t => {
  const f = await fixture(t, { env: { RUNVARA_QUIET_OWNER_LOGIN: 'disabled/v1' } });
  f.config.RUNVARA_QUIET_OWNER_LOGIN = 'enabled/v1';
  assert.equal((await f.login()).status, 503); assert.deepEqual(f.calls, []);
  const unsupported = await fixture(t, { beforeListen: ({ store }) => { store.recordMaintenanceLogin = undefined; } });
  const result = await unsupported.login(); assert.equal(result.status, 503); noSession(result); assert.deepEqual(unsupported.calls, []);
});

test('bad, missing, non-owner and bootstrap-only credentials never seed or write', async t => {
  for (const kind of ['wrong-password', 'unknown', 'missing-admin', 'viewer', 'admin', 'inactive', 'missing-hash', 'missing-workspace', 'ambiguous-email']) await t.test(kind, async t => {
    const state = ownerState(), other = ownerState('beta');
    if (['viewer', 'admin'].includes(kind)) state.users[0].role = kind;
    if (kind === 'inactive') state.users[0].active = false;
    if (kind === 'missing-hash') delete state.users[0].passwordHash;
    if (kind === 'ambiguous-email') other.users[0].email = state.users[0].email;
    const f = await fixture(t, { states: [state, other],
      intercept: kind === 'missing-workspace' ? ({ url, proceed }) => url.searchParams.get('select') === 'state->workspace,state->users' ? Response.json([]) : proceed() : undefined });
    const result = await f.login({ ...(kind === 'wrong-password' ? { password: 'wrong' } : {}),
      ...(['unknown', 'missing-admin'].includes(kind) ? { email: kind === 'unknown' ? 'unknown@example.test' : 'missing-owner@example.test' } : {}) });
    assert.notEqual(result.status, 200); noSession(result); assert.equal(writes(f).length, 0);
    assert.deepEqual(f.fake.states.get('alpha'), state); assert.equal(f.fake.states.size, 2);
  });
});

test('owner identity changes after password verification cannot receive a maintenance session', async t => {
  for (const field of ['role', 'active', 'passwordHash', 'sessionVersion', 'email', 'removed', 'duplicate', 'workspace']) await t.test(field, async t => {
    const f = await fixture(t, { intercept: ({ url, fake, proceed }) => {
      if (url.searchParams.get('select') === 'state') {
        const state = fake.states.get('alpha'), user = state.users[0];
        if (field === 'role') user.role = 'viewer';
        if (field === 'active') user.active = false;
        if (field === 'passwordHash') user.passwordHash = hashPassword('Changed-Synthetic!2026');
        if (field === 'sessionVersion') user.sessionVersion++;
        if (field === 'email') user.email = 'changed@example.test';
        if (field === 'removed') state.users = [];
        if (field === 'duplicate') state.users.push(structuredClone(user));
        if (field === 'workspace') state.workspace.id = 'beta';
      }
      return proceed();
    } });
    const r = await f.login(); assert.notEqual(r.status, 200); noSession(r); assert.equal(writes(f).length, 0);
  });
});

test('failed, conflicting and uncertain audit writes never get replayed or issue an unconfirmed session', async t => {
  for (const kind of ['conflict', 'cancelled', 'denied', 'malformed', 'network-before', 'network-after', 'network-after-newer', 'network-unreadable']) await t.test(kind, async t => {
    const f = await fixture(t, { intercept: async ({ url, options, fake, proceed }) => {
      if (options.method === 'PATCH') {
        if (kind === 'conflict') { fake.states.get('alpha')._revision = randomUUID(); return proceed(); }
        if (kind === 'cancelled') return Response.json({ code: '57014' }, { status: 500 });
        if (kind === 'denied') return Response.json({ code: '42501' }, { status: 403 });
        if (kind === 'malformed') return Response.json({ wrong: true });
        if (kind.startsWith('network-after')) {
          await proceed(); if (kind === 'network-after-newer') fake.states.get('alpha')._revision = randomUUID();
        }
        throw new Error('Synthetic lost response');
      }
      if (kind === 'network-unreadable' && url.searchParams.get('select') === 'revision:state->>_revision') throw new Error('Synthetic unavailable read');
      return proceed();
    } });
    const result = await f.login(); assert.equal(writes(f).length, 1, 'no repeated mutation');
    if (kind === 'network-after') { assert.equal(result.status, 200); assert.ok(result.cookie); assert.equal(f.fake.states.get('alpha').audit.filter(x => x.type === 'user_login').length, 1); }
    else { assert.notEqual(result.status, 200); noSession(result); }
  });
});

test('oversized state preserves all history and refuses login before any write', async t => {
  const state = ownerState(); state.audit.push({ id: 'large-prior-audit', detail: { text: 'x'.repeat(2097152) } });
  t.mock.method(console, 'warn', () => {});
  const f = await fixture(t, { states: [state] });
  const result = await f.login(); assert.equal(result.status, 503); noSession(result);
  assert.equal(writes(f).length, 0); assert.deepEqual(f.fake.states.get('alpha'), state);
});

test('missing or invalid revision and malformed audit fail closed without changing persistence', async t => {
  for (const kind of ['missing-revision', 'bad-revision', 'bad-audit']) await t.test(kind, async t => {
    const state = ownerState();
    if (kind === 'missing-revision') delete state._revision;
    if (kind === 'bad-revision') state._revision = 'not-a-revision';
    if (kind === 'bad-audit') state.audit = { invalid: true };
    const f = await fixture(t, { states: [state] });
    const result = await f.login(); assert.equal(result.status, 503); noSession(result);
    assert.equal(writes(f).length, 0); assert.deepEqual(f.fake.states.get('alpha'), state);
  });
});

test('drain and disconnect before or after submission cannot start later work or issue a session', async t => {
  for (const when of ['before', 'after']) for (const stop of ['drain', 'disconnect']) await t.test(`${when}-${stop}`, async t => {
    let arrived, release;
    const reached = new Promise(resolve => { arrived = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, { intercept: async ({ url, options, proceed }) => {
      if (when === 'before' && url.searchParams.get('select') === 'state') { arrived(); await held; }
      if (when === 'after' && options.method === 'PATCH') { const result = await proceed(); arrived(); await held; return result; }
      return proceed();
    } });
    const abort = new AbortController();
    const resultPromise = f.login({}, { signal: abort.signal }).catch(error => ({ aborted: error.name === 'AbortError' }));
    await reached;
    let draining;
    if (stop === 'drain') draining = f.server.packsmart.drain();
    else { abort.abort(); await turn(); await new Promise(resolve => setTimeout(resolve, 30)); }
    release(); const result = await resultPromise; if (draining) await draining;
    if (stop === 'drain') { assert.equal(result.status, 503); noSession(result); }
    else assert.equal(result.aborted, true);
    assert.equal(writes(f).length, when === 'before' ? 0 : 1);
    assert.equal(f.fake.states.get('alpha').audit.filter(x => x.type === 'user_login').length, when === 'before' ? 0 : 1);
    assert.equal(f.server.packsmart.agentOps.status.lastTickAt, null);
  });
});

test('maintenance retains login rate limits, invalid-session rejection and account revocation', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) await f.login({ password: 'wrong' });
  const limited = await f.login(); assert.equal(limited.status, 429); noSession(limited); assert.equal(writes(f).length, 0);
  const g = await fixture(t); const logged = await g.login(); assert.equal(logged.status, 200);
  const forged = createSessionToken({ userId: 'alpha-owner', workspaceId: 'beta', email: 'alpha@example.test', role: 'owner', sessionVersion: 1 }, SECRET);
  assert.equal((await g.request('/api/auth/session', { cookie: `__Host-packsmart_session=${forged}` })).status, 401);
  assert.equal((await g.request('/api/auth/session', { cookie: '__Host-packsmart_session=invalid' })).status, 401);
  g.fake.states.get('alpha').users[0].sessionVersion++;
  assert.equal((await g.request('/api/auth/session', { cookie: cookieValue(logged) })).status, 401);
  assert.equal(writes(g).length, 1, 'session reads cannot write');
});
