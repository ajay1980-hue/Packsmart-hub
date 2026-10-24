import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { approvalFixture, input } from './approval-request-fixture.mjs';
const error = (r, status, code) => { assert.equal(r.status, status, JSON.stringify(r.body)); assert.equal(r.body.code, code); };

test('stable creation, exact read/reuse and later edited or decided record preserve one identity and audit', async t => {
  const f = await approvalFixture(t), body = input(), before = structuredClone(f.states.get('beta'));
  const first = await f.request(body); assert.equal(first.status, 202); assert.equal(first.body.replayed, false);
  const saved = structuredClone(f.states.get('alpha')), calls = f.calls.saves;
  const read = await f.request(body, { reconcile: true }); assert.equal(read.body.found, true);
  const repeat = await f.request({ ...body, payload: { b: ['retained'], a: 1 } }); assert.equal(repeat.status, 200); assert.equal(repeat.body.replayed, true);
  assert.equal(repeat.body.approval.id, first.body.approval.id); assert.equal(f.calls.saves, calls);
  assert.deepEqual(f.states.get('alpha'), saved); assert.deepEqual(f.states.get('beta'), before);
  assert.equal(saved.audit.length, 2); assert.equal(saved.approvals.length, 1);
  assert.equal(JSON.stringify(repeat.body).includes('contentSha256'), false);
  f.states.get('alpha').approvals[0].action = 'Edited by owner'; f.states.get('alpha').approvals[0].revision = 2;
  f.states.get('alpha').approvals[0].status = 'rejected';
  const current = await f.request(body); assert.equal(current.body.approval.action, 'Edited by owner'); assert.equal(current.body.approval.status, 'rejected');
  assert.equal(f.calls.saves, calls);
});
test('keyless and invalid identifiers fail closed; historical records do not acquire retry identity', async t => {
  const f = await approvalFixture(t), before = structuredClone([...f.states]);
  for (const requestId of [undefined, '', 'legacy-id', 'A'.repeat(36), null]) error(await f.request(input(requestId, { requestId })), 400, 'APPROVAL_REQUEST_ID_REQUIRED');
  assert.equal(f.calls.saves, 0); assert.deepEqual([...f.states], before);
  const body = input(); f.states.get('alpha').approvals.push({ id: body.requestId, requestedBy: 'shared-owner', status: 'pending' });
  const read = await f.request(body, { reconcile: true }); assert.equal(read.body.found, false); assert.equal(f.calls.saves, 0);
});
test('same identity with changed normalized content conflicts without writes, including reconciliation', async t => {
  const f = await approvalFixture(t), body = input(); await f.request(body); const before = structuredClone([...f.states]);
  for (const change of [{ action: 'Different' }, { financialImpact: 0 }, { payload: { a: 2 } }, { evidence: [{ detail: 'Changed' }] }]) {
    for (const reconcile of [false, true]) error(await f.request({ ...body, ...change }, { reconcile }), 409, 'APPROVAL_REQUEST_CONFLICT');
  }
  assert.equal(f.calls.saves, 1); assert.deepEqual([...f.states], before);
});
test('tenant scope, actor ownership and current role/session remain mandatory for replay and read', async t => {
  const f = await approvalFixture(t), body = input(); const a = await f.request(body);
  const b = await f.request(body, { identity: f.auth('beta') }); assert.equal(b.status, 202); assert.notEqual(a.body.approval.id, b.body.approval.id);
  const before = structuredClone([...f.states]);
  for (const reconcile of [false, true]) {
    error(await f.request(body, { identity: f.auth('alpha', 'admin'), reconcile }), 403, 'APPROVAL_REQUEST_ACTOR_MISMATCH');
    error(await f.request(body, { identity: f.auth('alpha', 'viewer', { role: 'owner' }), reconcile }), 403, 'ROLE_DENIED');
  }
  assert.deepEqual([...f.states], before);
  const token = f.auth(); f.states.get('alpha').users[0].sessionVersion++;
  error(await f.request(body, { identity: token }), 401, 'SESSION_INVALID');
});
for (const change of ['role', 'active', 'sessionVersion', 'passwordChangeRequired']) test('fresh locked read catches changed ' + change, async t => {
  const f = await approvalFixture(t), body = input(); let once = true;
  f.hooks.afterRead = () => { if (!once) return; once = false; const user = f.states.get('alpha').users[0];
    user[change] = ({ role: 'viewer', active: false, sessionVersion: 2, passwordChangeRequired: true })[change]; };
  const r = await f.request(body); assert.ok([401, 403].includes(r.status)); assert.equal(f.calls.saves, 0);
});
for (const phase of ['before', 'after']) test('uncertain ' + phase + '-commit save never automatically replays', async t => {
  const f = await approvalFixture(t), body = input(); f.hooks.fail = phase;
  const r = await f.request(body);
  if (phase === 'before') error(r, 503, 'APPROVAL_REQUEST_OUTCOME_UNKNOWN');
  else { assert.equal(r.status, 200); assert.equal(r.body.replayed, true); }
  assert.equal(f.calls.saves, 1); assert.equal(f.calls.commits, phase === 'after' ? 1 : 0);
  f.hooks.fail = null; const retry = await f.request(body); assert.equal(retry.status, phase === 'before' ? 202 : 200);
  assert.equal(f.states.get('alpha').approvals.length, 1); assert.equal(f.states.get('alpha').audit.length, 2);
});
test('unreadable post-commit confirmation stays unknown; a new server later recovers exactly', async t => {
  const f = await approvalFixture(t), body = input(); f.hooks.afterCommit = () => { f.hooks.readFailure = true; };
  error(await f.request(body), 503, 'APPROVAL_REQUEST_OUTCOME_UNKNOWN'); assert.equal(f.calls.saves, 1);
  f.hooks.readFailure = false; f.hooks.afterCommit = null; const server = await f.start();
  const recovered = await f.request(body, { server }); assert.equal(recovered.status, 200); assert.equal(recovered.body.replayed, true); assert.equal(f.calls.saves, 1);
});
for (const different of [false, true]) test('two servers compete through CAS for ' + (different ? 'conflicting' : 'identical') + ' content', async t => {
  const f = await approvalFixture(t), server = await f.start(), body = input(); let entered = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  f.hooks.beforeSave = async () => { if (++entered === 2) release(); await gate; };
  const responses = await Promise.all([f.request(body), f.request(different ? { ...body, reason: 'Changed' } : body, { server })]);
  assert.deepEqual(responses.map(r => r.status).sort(), different ? [202, 409] : [200, 202]);
  assert.equal(f.calls.saves, 2); assert.equal(f.calls.commits, 1); assert.equal(f.states.get('alpha').approvals.length, 1); assert.equal(f.states.get('alpha').audit.length, 2);
});
test('unrelated CAS winner is preserved and absence remains unknown until a deliberate same-id retry', async t => {
  const f = await approvalFixture(t), body = input(); f.hooks.beforeSave = () => {
    f.states.get('alpha')._revision = randomUUID(); f.states.get('alpha').businessSentinel = 'concurrent';
  };
  error(await f.request(body), 503, 'APPROVAL_REQUEST_OUTCOME_UNKNOWN'); assert.equal(f.calls.saves, 1); assert.equal(f.calls.commits, 0);
  f.hooks.beforeSave = null; assert.equal((await f.request(body)).status, 202); assert.equal(f.states.get('alpha').businessSentinel, 'concurrent');
});
test('duplicate or malformed retained bindings fail closed instead of selecting a convenient record', async t => {
  const f = await approvalFixture(t), body = input(); await f.request(body);
  const saved = f.states.get('alpha').approvals[0]; f.states.get('alpha').approvals.push(structuredClone(saved));
  error(await f.request(body), 409, 'APPROVAL_REQUEST_STATE_INVALID'); f.states.get('alpha').approvals.pop();
  saved.requestIdentity.workspaceId = 'beta'; error(await f.request(body, { reconcile: true }), 409, 'APPROVAL_REQUEST_STATE_INVALID');
  assert.equal(f.calls.saves, 1);
});
test('query overrides and revoked authority after commit cannot disclose a successful result', async t => {
  const f = await approvalFixture(t), body = input();
  error(await f.request(body, { route: '/api/actions?workspaceId=beta' }), 400, 'APPROVAL_REQUEST_INPUT_INVALID');
  f.hooks.afterCommit = () => { f.states.get('alpha').users[0].active = false; };
  error(await f.request(body), 401, 'SESSION_INVALID'); assert.equal(f.calls.commits, 1); assert.equal(f.states.get('alpha').approvals.length, 1);
});

