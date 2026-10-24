import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { maintenanceFixture, ownerState, SECRET } from './maintenance-login-fixture.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { upgradeState } from '../lib/store.mjs';
import { createQuietApprovalPilot, PILOT_SCHEMA, PILOT_BASE, PILOT_SOURCE } from '../lib/quiet-approval-pilot.mjs';
import { approvalFixture, input } from './approval-request-fixture.mjs';
import { createStartupPolicy } from '../lib/startup-mode.mjs';
const descriptor = (overrides = {}) => ({ schema: PILOT_SCHEMA, workspaceId: 'alpha', ownerId: 'alpha-owner', requestId: randomUUID(),
  notBefore: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 590000).toISOString(), ...overrides });
const envFor = d => ({ RUNVARA_STARTUP_MODE: 'quiet', RUNVARA_QUIET_OWNER_LOGIN: 'disabled/v1', RUNVARA_QUIET_COMMERCE_PREVIEW: 'disabled/v1', RUNVARA_QUIET_APPROVAL_PILOT: JSON.stringify(d) });
const writes = f => f.calls.filter(c => c.method !== 'GET');
const primary = f => f.calls.filter(c => c.method === 'PATCH');
function identity(id = 'alpha', overrides = {}) {
  const token = createSessionToken({ userId: id + '-owner', workspaceId: id, role: 'owner', email: id + '@example.test', sessionVersion: 1, ...overrides }, SECRET);
  return { cookie: '__Host-packsmart_session=' + token, headers: { Origin: 'https://maintenance.example.test', 'X-CSRF-Token': verifySessionToken(token, SECRET).csrf } };
}
async function fixture(t, options = {}) {
  t.mock.method(console, 'error', () => {}); t.mock.method(console, 'warn', () => {});
  const d = options.descriptor || descriptor();
  const states = options.states || ['alpha', 'beta'].map(id => upgradeState(ownerState(id), {}));
  const f = await maintenanceFixture({ ...options, states, env: { ...envFor(d), ...options.env } }); t.after(f.close);
  const auth = identity(); const body = { requestId: d.requestId };
  return Object.assign(f, { d, auth, body, call: (op, payload = body, overrides = {}) => f.request(PILOT_BASE + op, { method: 'POST', body: payload, ...auth, ...overrides }) });
}

test('pilot configuration is exact, quiet-only, isolated from other flags and immutable', () => {
  assert.equal(createQuietApprovalPilot({}), null); assert.equal(createQuietApprovalPilot({ RUNVARA_QUIET_APPROVAL_PILOT: 'disabled/v1' }), null);
  for (const raw of ['', 'enabled/v1', 'null', '{}', [], true]) assert.throws(() => createQuietApprovalPilot({ RUNVARA_STARTUP_MODE: 'quiet', RUNVARA_QUIET_APPROVAL_PILOT: raw }), { code: 'QUIET_APPROVAL_PILOT_INVALID' });
  const d = descriptor();
  for (const change of [{ workspaceId: '*' }, { workspaceId: 12 }, { ownerId: 12 }, { ownerId: '' }, { requestId: 'x' }, { schema: 'other' }, { extra: true }, { notBefore: d.expiresAt }, { expiresAt: new Date(Date.parse(d.notBefore) + 600001).toISOString() }, { expiresAt: '2026-10-24' }]) assert.throws(() => createQuietApprovalPilot(envFor({ ...d, ...change })), { code: 'QUIET_APPROVAL_PILOT_INVALID' });
  for (const change of [{ RUNVARA_STARTUP_MODE: 'normal' }, { RUNVARA_QUIET_OWNER_LOGIN: 'enabled/v1' }, { RUNVARA_QUIET_COMMERCE_PREVIEW: 'enabled/v1' }]) assert.throws(() => createQuietApprovalPilot({ ...envFor(d), ...change }), { code: 'QUIET_APPROVAL_PILOT_INVALID' });
  const env = envFor(d), policy = createStartupPolicy(env, []); env.RUNVARA_QUIET_APPROVAL_PILOT = 'disabled/v1';
  assert.equal(policy.approvalPilot.status().open, true); assert.throws(() => { policy.approvalPilot.descriptor.ownerId = 'other'; });
});

test('absolute expiry survives restart and closes on backwards wall/monotonic time or manual closure', () => {
  const begin = Date.parse('2026-10-24T00:00:00.000Z'); let wall = begin, mono = 50;
  const d = descriptor({ notBefore: new Date(begin + 100).toISOString(), expiresAt: new Date(begin + 600000).toISOString() });
  const clocks = { now: () => wall, monotonic: () => mono }; const p = createQuietApprovalPilot(envFor(d), clocks);
  assert.equal(p.available(), false); wall += 200; mono += 200; assert.equal(p.available(), true);
  wall = begin + 599999; mono += 599799; const restart = createQuietApprovalPilot(envFor(d), clocks); assert.equal(restart.available(), true);
  wall++; mono++; assert.equal(p.available(), false); assert.equal(restart.available(), false); assert.equal(createQuietApprovalPilot(envFor(d), clocks).available(), false);
  wall = begin + 500; mono = 1000; const backward = createQuietApprovalPilot(envFor(d), clocks); wall--; assert.equal(backward.available(), false); wall += 200; assert.equal(backward.available(), false);
  const monotonic = createQuietApprovalPilot(envFor(d), clocks); mono += 600000; assert.equal(monotonic.available(), false);
  const closed = createQuietApprovalPilot(envFor(d), clocks); closed.close(); assert.equal(closed.available(), false);
});

test('inert create, exact replay, rejection and reconciliation retain one audit/history/work transition', async t => {
  const f = await fixture(t), beta = structuredClone(f.fake.states.get('beta'));
  const session = await f.request('/api/auth/session', f.auth); assert.equal(session.payload.approvalPilot.requestId, f.d.requestId);
  const first = await f.call('request'); assert.equal(first.status, 200, JSON.stringify(first.payload)); assert.equal(first.payload.approval.status, 'pending');
  const saved = structuredClone(f.fake.states.get('alpha')), n = writes(f).length;
  const repeat = await f.call('request'); assert.equal(repeat.payload.replayed, true); assert.equal(writes(f).length, n); assert.deepEqual(f.fake.states.get('alpha'), saved);
  const body = { ...f.body, approvalId: first.payload.approval.id, revision: 1, decision: 'rejected' };
  const rejected = await f.call('reject', body); assert.equal(rejected.status, 200, JSON.stringify(rejected.payload)); assert.equal(rejected.payload.approval.status, 'rejected');
  const final = structuredClone(f.fake.states.get('alpha')), total = writes(f).length;
  assert.equal(final.approvals.length, 1); assert.equal(final.approvals[0].history.length, 1); assert.equal(final.workRecords.filter(w => w.id === body.approvalId).length, 1);
  assert.equal(final.audit.filter(a => a.type === 'approval_requested').length, 1); assert.equal(final.audit.filter(a => a.type === 'approval_decided').length, 1);
  assert.equal((await f.call('reject', body)).payload.replayed, true); assert.equal((await f.call('reconcile')).payload.approval.status, 'rejected'); assert.equal(writes(f).length, total);
  assert.deepEqual(f.fake.states.get('alpha'), final); assert.deepEqual(f.fake.states.get('beta'), beta); assert.equal(primary(f).length, 2);
  assert.equal((await f.request('/api/health')).payload.quietApprovalPilot.open, false);
  assert.equal(f.server.packsmart.scheduler.status.lastTickAt, null); assert.equal(f.server.packsmart.agentOps.status.lastTickAt, null);
});

test('all general routes remain closed; foreign signed scope is rejected before database reads', async t => {
  const f = await fixture(t);
  for (const path of ['/api/actions', '/api/actions/reconcile', '/api/approvals/test/decision', '/api/bootstrap', '/api/auth/login', '/api/auth/signup', '/api/maintenance/commerce', '/api/webhooks/stripe', '/api/integrations/shopify/oauth/callback', '/api/connections/shopify/refresh', '/api/meta-production/context']) assert.equal((await f.request(path, { method: 'POST', body: {}, ...f.auth })).status, 503);
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) assert.equal((await f.request(PILOT_BASE + 'request', { method, ...f.auth })).status, 503);
  assert.equal((await f.call('request/', f.body)).status, 503); assert.equal(f.calls.length, 0);
  for (const auth of [identity('beta'), identity('alpha', { userId: 'other-owner' })]) assert.equal((await f.call('request', f.body, auth)).status, 403);
  assert.equal((await f.call('request', f.body, { cookie: undefined })).status, 401); assert.equal(f.calls.length, 0);
  const health = await f.request('/api/health'); assert.equal(health.payload.startupMode, 'quiet'); assert.doesNotMatch(JSON.stringify(health.payload.quietApprovalPilot), /alpha|owner|requestId/);
});

test('CSRF, current owner role, password and session revocation fail without writes', async t => {
  for (const mode of ['csrf', 'origin', 'admin', 'member', 'viewer', 'inactive', 'session', 'password']) await t.test(mode, async t => {
    const f = await fixture(t), user = f.fake.states.get('alpha').users[0]; const overrides = {};
    if (mode === 'csrf') overrides.headers = { Origin: 'https://maintenance.example.test' };
    if (mode === 'origin') overrides.headers = { ...f.auth.headers, Origin: 'https://other.invalid' };
    if (['admin','member','viewer'].includes(mode)) user.role = mode;
    if (mode === 'inactive') user.active = false; if (mode === 'session') user.sessionVersion++; if (mode === 'password') user.passwordChangeRequired = true;
    assert.ok([401,403].includes((await f.call('request', f.body, overrides)).status)); assert.equal(writes(f).length, 0);
  });
});

test('strict input and rejection identity prevent arbitrary payload, approval, target or revision', async t => {
  const f = await fixture(t);
  for (const body of [null, [], {}, { ...f.body, payload: {} }, { requestId: randomUUID() }]) assert.equal((await f.call('request', body)).status, 400);
  assert.equal((await f.call('request?workspaceId=beta')).status, 400); assert.equal(writes(f).length, 0);
  const first = await f.call('request'); const correct = { ...f.body, approvalId: first.payload.approval.id, revision: 1, decision: 'rejected' };
  for (const body of [{ ...correct, decision: 'approved' }, { ...correct, revision: 2 }, { ...correct, note: 'override' }]) assert.equal((await f.call('reject', body)).status, 400);
  const before = structuredClone(f.fake.states.get('alpha')); assert.equal((await f.call('reject', { ...correct, approvalId: 'different' })).status, 409); assert.deepEqual(f.fake.states.get('alpha'), before);
});

test('pre-archive upgrade guard refuses unrelated changes and unsupported retention with zero writes', async t => {
  for (const mode of ['schema', 'retention']) await t.test(mode, async t => {
    const states = ['alpha','beta'].map(id => upgradeState(ownerState(id), {})); states[0].audit = Array.from({ length: 350 }, (_, i) => ({ id: 'old-' + i, type: 'old', actor: 'synthetic', detail: {}, createdAt: '2026-01-01T00:00:00.000Z' }));
    if (mode === 'schema') states[0].schemaVersion = 7; else states[0].agentRuns = [{ id: 'one' }, { id: 'two' }];
    const f = await fixture(t, { states }), before = structuredClone([...f.fake.states]); const r = await f.call('request'); assert.equal(r.status, 503); assert.equal(r.payload.code, 'APPROVAL_REQUEST_OUTCOME_UNKNOWN'); assert.equal(writes(f).length, 0); assert.deepEqual([...f.fake.states], before);
  });
});

test('supported audit compaction remains bounded and primary rejection leaves committed archive explicit', async t => {
  const states = ['alpha','beta'].map(id => upgradeState(ownerState(id), {})); states[0].audit = Array.from({ length: 302 }, (_, i) => ({ id: 'old-' + i, type: 'old', actor: 'synthetic', detail: {}, createdAt: '2026-01-01T00:00:00.000Z' }));
  const f = await fixture(t, { states, intercept: async ({ options, proceed }) => options.method === 'PATCH' ? Response.json({ code: 'P0L05', message: 'Synthetic guard rejection' }, { status: 400 }) : proceed() });
  const before = structuredClone(f.fake.states.get('alpha')); const r = await f.call('request'); assert.equal(r.status, 503); assert.equal(r.payload.code, 'APPROVAL_REQUEST_OUTCOME_UNKNOWN');
  assert.deepEqual(f.fake.states.get('alpha'), before); assert.equal(f.fake.tables.get('audit_events').length, 3); const n = writes(f).length; assert.equal((await f.call('request')).status, 503); assert.equal(writes(f).length, n);
  const check = await f.call('reconcile'); assert.equal(check.status, 200); assert.equal(check.payload.found, false);
});

test('lost reject acknowledgement confirms exact rejection; unreadable confirmation stops further writes', async t => {
  for (const unreadable of [false,true]) await t.test(String(unreadable), async t => {
    let rejecting = false, committed = false;
    const f = await fixture(t, { intercept: async ({ url, options, proceed }) => {
      if (unreadable && committed && (options.method || 'GET') === 'GET') throw Error('Synthetic read unavailable');
      if (rejecting && options.method === 'PATCH') { const r = await proceed(); committed = true; throw Error('Synthetic lost rejection acknowledgement'); }
      return proceed();
    } });
    const first = await f.call('request'); rejecting = true; const r = await f.call('reject', { ...f.body, approvalId: first.payload.approval.id, revision: 1, decision: 'rejected' });
    assert.equal(r.status, unreadable ? 503 : 200); if (unreadable) assert.equal(r.payload.code, 'MAINTENANCE_PILOT_OUTCOME_UNKNOWN');
    const saved = f.fake.states.get('alpha'); assert.equal(saved.approvals[0].status, 'rejected'); assert.equal(saved.approvals[0].history.length, 1); assert.equal(saved.audit.filter(a => a.type === 'approval_decided').length, 1); assert.equal(primary(f).length, 2);
  });
});

test('disabled pilot has no capabilities and rejects before authentication or persistence', async t => {
  const f = await fixture(t, { env: { RUNVARA_QUIET_APPROVAL_PILOT: 'disabled/v1' } });
  assert.equal((await f.call('request')).status, 503); assert.equal(f.calls.length, 0); assert.equal((await f.request('/api/auth/session', f.auth)).payload.approvalPilot, undefined);
});

test('normal decision path cannot approve either pilot marker; normal mode cannot admit pilot endpoints', async t => {
  const f = await approvalFixture(t);
  for (const marker of [{ source: PILOT_SOURCE }, { payload: { maintenancePilot: PILOT_SCHEMA } }]) {
    const created = await f.request(input(randomUUID(), marker)); assert.equal(created.status, 202);
    const approval = f.states.get('alpha').approvals[0], before = structuredClone(f.states.get('alpha')), saves = f.calls.saves;
    const denied = await f.request({ decision: 'approved', revision: 1 }, { route: '/api/approvals/' + approval.id + '/decision' });
    assert.equal(denied.status, 403); assert.equal(denied.body.code, 'MAINTENANCE_PILOT_EXECUTION_FORBIDDEN');
    assert.deepEqual(f.states.get('alpha'), before); assert.equal(f.calls.saves, saves);
  }
  const reads = f.calls.reads;
  assert.equal((await f.request({ requestId: randomUUID() }, { route: PILOT_BASE + 'request' })).status, 503);
  assert.equal(f.calls.reads, reads);
});

test('altered, linked, duplicate and cross-tenant retained records cannot be rejected', async t => {
  for (const mode of ['content','linked','duplicate','tenant','binding','history']) await t.test(mode, async t => {
    const f = await fixture(t), created = await f.call('request'); assert.equal(created.status, 200);
    const state = f.fake.states.get('alpha'), approval = state.approvals[0];
    if (mode === 'content') approval.action = 'Changed';
    if (mode === 'linked') state.connectionWrites = [{ id: 'linked', approvalId: approval.id }];
    if (mode === 'duplicate') state.approvals.push(structuredClone(approval));
    if (mode === 'tenant') state.workspace.id = 'beta';
    if (mode === 'binding') approval.requestIdentity.contentSha256 = '0'.repeat(64);
    if (mode === 'history') approval.history.push({ revision: 1, status: 'approved' });
    const before = structuredClone(state), count = writes(f).length;
    const rejected = await f.call('reject', { ...f.body, approvalId: approval.id, revision: 1, decision: 'rejected' });
    assert.ok([401,403,409].includes(rejected.status), JSON.stringify(rejected.payload));
    assert.equal(writes(f).length, count); assert.deepEqual(f.fake.states.get('alpha'), before);
  });
});

test('drain while an exact read is waiting prevents admission and all writes', async t => {
  let entered, release, gated = false;
  const started = new Promise(r => entered = r), gate = new Promise(r => release = r);
  const f = await fixture(t, { intercept: async ({ options, proceed }) => {
    if (!gated && (options.method || 'GET') === 'GET') { gated = true; entered(); await gate; }
    return proceed();
  } });
  const pending = f.call('request'); await started;
  const draining = f.server.packsmart.drain(); release();
  assert.equal((await pending).status, 503); assert.equal(writes(f).length, 0);
  await draining;
});
