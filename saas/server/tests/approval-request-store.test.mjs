import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { createApprovalRequest, prepareApprovalRequest } from '../lib/approval-request.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

function fixture(t) {
  t.mock.method(console, 'warn', () => {});
  const state = seedWorkspaceState({}, { workspaceId: 'approval-store-alpha', email: 'synthetic@example.test' });
  Object.assign(state.users[0], { active: true, passwordChangeRequired: false, sessionVersion: 1 });
  state._revision = randomUUID(); state.approvals = []; state.audit = [];
  const fake = fakeSupabase({ initialStates: [state] }), hooks = {};
  const primary = (url, options) => new URL(url).pathname.endsWith('/saas_workspace_state') && options.method === 'PATCH';
  const transport = async (url, options = {}) => {
    assert.equal(new URL(url).origin, 'https://approval-store.invalid');
    await hooks.before?.(url, options);
    const response = await fake.fetchImpl(url, options);
    await hooks.after?.(url, options, response);
    return response;
  };
  const makeStore = () => createStore({ SUPABASE_URL: 'https://approval-store.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-placeholder' }, { fetchImpl: transport });
  const auth = { session: { workspaceId: state.workspace.id, sub: state.users[0].id, sessionVersion: 1 }, user: { role: 'owner' } };
  const body = { requestId: randomUUID(), type: 'customer_facing_publish', reason: 'Synthetic retry check', expectedBenefit: 'Exact intent', risk: 'No provider connected' };
  const run = (store = makeStore(), overrides = {}) => createApprovalRequest({ store, auth, intent: prepareApprovalRequest({ ...body, ...overrides }, auth.session.sub), admit() {} });
  const current = () => fake.states.get(state.workspace.id);
  const writes = () => fake.calls.filter(c => primary(c.url, c));
  return { fake, hooks, primary, makeStore, auth, body, run, current, writes };
}

test('real adapter preserves identity through upgrade, primary CAS, mirrors and fresh-process reconciliation', async t => {
  const f = fixture(t), first = await f.run(), before = structuredClone(f.current()), calls = f.fake.calls.length;
  const second = await f.run();
  assert.equal(first.approval.id, second.approval.id); assert.equal(second.replayed, true);
  assert.equal(f.writes().length, 1); assert.equal(before.audit.length, 1);
  assert.equal(before.approvals[0].requestIdentity.requestId, f.body.requestId);
  assert.deepEqual(f.current(), before);
  assert.ok(f.fake.calls.slice(calls).every(c => (c.method || 'GET') === 'GET'));
  assert.equal(f.fake.tables.get('approval_requests').length, 1);
  assert.equal(f.fake.tables.get('audit_events').filter(row => row.type === 'approval_requested').length, 1);
});

test('lost primary acknowledgement is confirmed by the adapter without repeating the primary write', async t => {
  const f = fixture(t); f.hooks.after = (url, options) => { if (f.primary(url, options)) throw Error('Synthetic lost response'); };
  const result = await f.run();
  assert.equal(result.replayed, false, 'adapter confirms its exact committed revision before acknowledging save');
  assert.equal(f.writes().length, 1); assert.equal(f.current().audit.length, 1);
  f.hooks.after = null;
  assert.equal((await f.run()).approval.id, result.approval.id); assert.equal(f.writes().length, 1);
});

test('primary failure and unreadable confirmation remain unknown; later exact identity recovers', async t => {
  const f = fixture(t); let committed = false;
  f.hooks.after = (url, options) => { if (f.primary(url, options)) { committed = true; throw Error('Lost acknowledgement'); } };
  f.hooks.before = () => { if (committed) throw Error('Synthetic read outage'); };
  await assert.rejects(f.run(), { code: 'APPROVAL_REQUEST_OUTCOME_UNKNOWN' });
  assert.equal(f.current().approvals.length, 1); assert.equal(f.writes().length, 1);
  f.hooks.before = f.hooks.after = null;
  assert.equal((await f.run()).replayed, true); assert.equal(f.writes().length, 1);
});

for (const conflict of [false, true]) test('real adapter CAS settles competing ' + (conflict ? 'conflicting' : 'same') + ' intents', async t => {
  const f = fixture(t); let count = 0, release; const gate = new Promise(resolve => { release = resolve; });
  f.hooks.before = async (url, options) => { if (f.primary(url, options)) { if (++count === 2) release(); await gate; } };
  const results = await Promise.allSettled([f.run(), f.run(f.makeStore(), conflict ? { reason: 'Different accepted content' } : {})]);
  assert.equal(f.writes().length, 2); assert.equal(f.current().approvals.length, 1); assert.equal(f.current().audit.length, 1);
  if (conflict) { assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.find(r => r.status === 'rejected').reason.code, 'APPROVAL_REQUEST_CONFLICT'); }
  else { assert.ok(results.every(r => r.status === 'fulfilled')); assert.equal(results[0].value.approval.id, results[1].value.approval.id); }
});

test('revocation wins primary CAS and unknown prior transport cannot overwrite it', async t => {
  const f = fixture(t);
  f.hooks.before = (url, options) => { if (f.primary(url, options)) { f.current().users[0].active = false; f.current()._revision = randomUUID(); } };
  await assert.rejects(f.run(), { code: 'SESSION_INVALID' });
  assert.equal(f.current().approvals.length, 0); assert.equal(f.current().audit.length, 0); assert.equal(f.writes().length, 1);
});
