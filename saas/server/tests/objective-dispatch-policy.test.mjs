import assert from 'node:assert/strict';
import test from 'node:test';
import { businessObjectivesSnapshot, upsertBusinessObjective, OBJECTIVE_EXECUTION_POLICY_SCHEMA } from '../lib/business-objectives.mjs';
import { captureObjectiveDispatchPolicy, prepareObjectiveDispatchProposal, assertObjectiveDispatchBinding,
  assertObjectiveDispatchAllowed, assertObjectivePolicySource, protectObjectivePolicySource, assessObjectiveDispatchPolicy,
  OBJECTIVE_DISPATCH_PROPOSAL_MAX_BYTES } from '../lib/objective-dispatch-policy.mjs';

const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const scope = { provider: 'shopify', operation: 'product_content', connectionId: 'shopify-a', account: 'policy-fixture.myshopify.com' };
function fixture() {
  const state = { workspace: { id: 'policy-tenant' }, users: [{ id: 'owner-a', role: 'owner' }, { id: 'admin-a', role: 'admin' }],
    connections: [{ id: scope.connectionId, provider: 'shopify', metadata: { shopDomain: scope.account } }] };
  const write = { id: 'write-fixture', provider: 'shopify', input: { operation: 'product_content' }, digest: 'a'.repeat(64),
    connectionId: scope.connectionId, account: scope.account, requestedBy: 'owner-a' };
  const approval = { type: 'customer_facing_publish', payload: {} };
  return { state, write, approval };
}
function add(state, patch = {}) {
  return upsertBusinessObjective(state, { title: 'Explicit owner restriction', metric: 'orders', baseline: 1, target: 2, direction: 'increase',
    startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-11-01T00:00:00.000Z',
    limits: { profitFirst: false }, executionPolicy: { schema: OBJECTIVE_EXECUTION_POLICY_SCHEMA, mode: 'enforce', scope }, ...patch },
  { workspaceId: state.workspace.id, actorId: 'owner-a', now: new Date(NOW) });
}
function bind(f) {
  const context = captureObjectiveDispatchPolicy(f.state, f.write);
  f.write.objectivePolicyProposal = prepareObjectiveDispatchProposal(f.write, context);
  f.approval.payload.objectivePolicyProposalDigest = f.write.objectivePolicyProposal.digest;
  return context;
}
const throws = (fn, code) => assert.throws(fn, error => error.code === code);

test('missing and explicitly preparation-only goals never activate dispatch restrictions', () => {
  const f = fixture();
  assert.equal(prepareObjectiveDispatchProposal(f.write, captureObjectiveDispatchPolicy(f.state, f.write)), null);
  const goal = add(f.state, { executionPolicy: { schema: OBJECTIVE_EXECUTION_POLICY_SCHEMA, mode: 'preparation_only' } });
  assert.equal(goal.executionPolicy.mode, 'preparation_only');
  assert.equal(captureObjectiveDispatchPolicy(f.state, f.write).policies.length, 0);
  delete f.state.businessObjectives[0].executionPolicy;
  assert.equal(businessObjectivesSnapshot(f.state).objectives[0].executionPolicy, undefined);
  assertObjectiveDispatchBinding(f.write, f.approval, captureObjectiveDispatchPolicy(f.state, f.write));
});

test('only actual current owners may activate, disable or change any enforced goal field', () => {
  const f = fixture(), row = add(f.state), before = structuredClone(f.state);
  for (const patch of [{ status: 'paused' }, { endsAt: '2026-10-08T00:00:00.000Z' }, { limits: { profitFirst: false } },
    { title: 'Changed' }, { executionPolicy: { schema: OBJECTIVE_EXECUTION_POLICY_SCHEMA, mode: 'preparation_only' } }]) {
    for (const actorId of ['admin-a', 'missing']) throws(() => upsertBusinessObjective(f.state,
      { id: row.id, revision: 1, ...patch }, { actorId, now: new Date(NOW) }), 'OWNER_APPROVAL_REQUIRED');
  }
  assert.deepEqual(f.state, before);
  const disabled = upsertBusinessObjective(f.state, { id: row.id, revision: 1,
    executionPolicy: { schema: OBJECTIVE_EXECUTION_POLICY_SCHEMA, mode: 'preparation_only' } }, { actorId: 'owner-a', now: new Date(NOW) });
  assert.equal(disabled.revision, 2);
  throws(() => upsertBusinessObjective(f.state, { id: row.id, revision: 1, status: 'paused' }, { actorId: 'owner-a', now: new Date(NOW) }), 'OBJECTIVE_CONFLICT');
  const second = fixture();
  second.state.users[0].active = false;
  throws(() => add(second.state), 'OWNER_APPROVAL_REQUIRED');
  second.state.users[0].active = true; second.state.users[0].passwordChangeRequired = true;
  throws(() => add(second.state), 'OWNER_APPROVAL_REQUIRED');
});

test('scope contract rejects unsupported scopes, account substitution and foreign objective identity', () => {
  for (const patch of [{ provider: 'meta' }, { operation: 'product_tags_add' }, { account: 'https://policy-fixture.myshopify.com' },
    { connectionId: '' }, { account: 'OTHER.myshopify.com' }, { wildcard: true }]) {
    const f = fixture();
    throws(() => add(f.state, { executionPolicy: { schema: OBJECTIVE_EXECUTION_POLICY_SCHEMA, mode: 'enforce', scope: { ...scope, ...patch } } }), 'VALIDATION_FAILED');
    assert.equal(f.state.businessObjectives, undefined);
  }
  const f = fixture();
  throws(() => add(f.state, { executionPolicy: { schema: OBJECTIVE_EXECUTION_POLICY_SCHEMA, mode: 'enforce', scope: { ...scope, connectionId: 'other' } } }), 'OBJECTIVE_POLICY_CONNECTION_REQUIRED');
  add(f.state); f.state.businessObjectives[0].workspaceId = 'foreign';
  throws(() => captureObjectiveDispatchPolicy(f.state, f.write), 'WORKSPACE_MISMATCH');
});

test('paused, future, expired and disabled restrictions stay matched and block matching manual writes', () => {
  for (const patch of [{ status: 'paused' }, { status: 'disabled' }, { status: 'completed' }, { status: 'cancelled' },
    { startsAt: '2026-10-08T00:00:00.000Z' }, { endsAt: new Date(NOW).toISOString() }]) {
    const f = fixture(); add(f.state, patch); const context = bind(f);
    assert.equal(context.policies.length, 1);
    assertObjectiveDispatchBinding(f.write, f.approval, context);
    throws(() => assertObjectiveDispatchAllowed(f.write, context, NOW), 'WRITE_POLICY_NOT_ACTIVE');
  }
});

test('all financial constraints including zero require qualified evidence rather than supplied assertions', () => {
  for (const limits of [{ minGrossMarginPercent: 0 }, { minStockCoverDays: 0 }, { maxMonthlyAdBudget: 0, currency: 'GBP' }, { profitFirst: true }]) {
    const f = fixture(); add(f.state, { limits: { profitFirst: false, ...limits } });
    f.state.economics = { reported: { complete: true, margin: 90 } };
    f.write.financialEvidence = { verified: true, grossMarginPercent: 100, plannedAdSpend: 0, contributionProfitDelta: 100 };
    f.approval.financialImpact = 100;
    const context = bind(f);
    throws(() => assertObjectiveDispatchAllowed(f.write, context, NOW), 'WRITE_POLICY_EVIDENCE_REQUIRED');
  }
});

test('multiple matching restrictions are conjunctive and cannot be hidden by order, scope or weaker policy', () => {
  const f = fixture(); add(f.state); add(f.state, { limits: { profitFirst: false, minGrossMarginPercent: 0, currency: 'GBP' } });
  add(f.state, { limits: { profitFirst: false, currency: 'EUR' } });
  const first = bind(f); const proposal = structuredClone(f.write.objectivePolicyProposal);
  f.state.businessObjectives.reverse();
  const second = captureObjectiveDispatchPolicy(f.state, f.write);
  assert.deepEqual(prepareObjectiveDispatchProposal(f.write, second), proposal);
  assert.deepEqual(assessObjectiveDispatchPolicy(f.write, first, NOW).blockers.map(row => row.code), ['WRITE_POLICY_EVIDENCE_REQUIRED', 'WRITE_POLICY_CONFLICT']);
  f.write.connectionId = 'replacement-connection';
  assert.ok(assessObjectiveDispatchPolicy(f.write, second, NOW).blockers.some(row => row.code === 'WRITE_POLICY_CONNECTION_CHANGED'));
  f.write.account = 'different.myshopify.com';
  assert.equal(captureObjectiveDispatchPolicy(f.state, f.write).policies.length, 0, 'exact account scope does not invent authority over another account');
});

test('legacy approval cannot borrow current policy, and a bound approval cannot silently change or lose it', () => {
  const f = fixture(); add(f.state);
  throws(() => assertObjectiveDispatchBinding(f.write, f.approval, captureObjectiveDispatchPolicy(f.state, f.write)), 'WRITE_POLICY_REVIEW_REQUIRED');
  const context = bind(f); assertObjectiveDispatchBinding(f.write, f.approval, context);
  f.approval.payload.objectivePolicyProposalDigest = 'f'.repeat(64);
  throws(() => assertObjectiveDispatchBinding(f.write, f.approval, context), 'WRITE_POLICY_APPROVAL_REQUIRED');
  f.approval.payload.objectivePolicyProposalDigest = f.write.objectivePolicyProposal.digest;
  for (const patch of [{ inputDigest: 'c'.repeat(64) }, { origin: 'objective' }, { policies: [] }, { extra: true }]) {
    const copy = { ...f.write, objectivePolicyProposal: { ...f.write.objectivePolicyProposal, ...patch } };
    throws(() => assertObjectiveDispatchBinding(copy, f.approval, context), 'WRITE_POLICY_REVIEW_REQUIRED');
  }
  const row = f.state.businessObjectives[0];
  upsertBusinessObjective(f.state, { id: row.id, revision: row.revision, executionPolicy: { schema: OBJECTIVE_EXECUTION_POLICY_SCHEMA, mode: 'preparation_only' } }, { actorId: 'owner-a', now: new Date(NOW) });
  throws(() => assertObjectiveDispatchBinding(f.write, f.approval, captureObjectiveDispatchPolicy(f.state, f.write)), 'WRITE_POLICY_REVIEW_REQUIRED');
});

test('policy snapshot is immutable, bounded, rejects malformed sources and does not execute accessors', () => {
  const f = fixture();
  for (let index = 0; index < 50; index++) add(f.state);
  throws(() => bind(f), 'WRITE_POLICY_PROPOSAL_TOO_LARGE');
  f.state.businessObjectives = f.state.businessObjectives.slice(0, 40);
  const context = bind(f);
  assert.ok(Buffer.byteLength(JSON.stringify(f.write.objectivePolicyProposal)) <= OBJECTIVE_DISPATCH_PROPOSAL_MAX_BYTES);
  protectObjectivePolicySource(f.state, context);
  throws(() => assertObjectivePolicySource({ ...f.state, businessObjectives: [] }, context), 'WRITE_POLICY_SOURCE_CHANGED');
  assert.throws(() => { f.state.businessObjectives[0].status = 'paused'; }, TypeError);
  assert.throws(() => { f.state.businessObjectives = []; }, TypeError);
  assertObjectivePolicySource(f.state, context);
  for (const value of [null, {}, Array(1), [f.state.businessObjectives[0], f.state.businessObjectives[0]]]) {
    throws(() => captureObjectiveDispatchPolicy({ ...f.state, businessObjectives: value }, f.write), 'WRITE_POLICY_INVALID');
  }
  const malicious = fixture(); let touched = false;
  Object.defineProperty(malicious.state, 'businessObjectives', { get() { touched = true; return []; } });
  throws(() => captureObjectiveDispatchPolicy(malicious.state, malicious.write), 'WRITE_POLICY_INVALID');
  assert.equal(touched, false);
  const locked = fixture(); add(locked.state);
  Object.defineProperty(locked.state, 'businessObjectives', { value: locked.state.businessObjectives, configurable: false, writable: false });
  protectObjectivePolicySource(locked.state, captureObjectiveDispatchPolicy(locked.state, locked.write));
  assert.throws(() => { locked.state.businessObjectives[0].status = 'paused'; }, TypeError);
});
