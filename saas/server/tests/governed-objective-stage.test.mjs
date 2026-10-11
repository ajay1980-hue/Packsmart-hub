import assert from 'node:assert/strict';
import test from 'node:test';
import { upsertBusinessObjective, OBJECTIVE_EXECUTION_POLICY_SCHEMA } from '../lib/business-objectives.mjs';
import { createGovernedRecordStage, GOVERNED_RECORD_PRODUCER_CONTRACT } from '../lib/governed-record-stage.mjs';

const now = new Date('2026-10-11T10:00:00.000Z');
const open = createGovernedRecordStage({ GOVERNED_RECORD_PRODUCER_CONTRACT });
const closed = createGovernedRecordStage();
const scope = { provider: 'shopify', operation: 'product_content', connectionId: 'shopify_stage', account: 'stage-fixture.myshopify.com' };
function fixture() {
  return { workspace: { id: 'stage_objectives' }, users: [{ id: 'owner_stage', role: 'owner' }],
    connections: [{ id: scope.connectionId, provider: 'shopify', metadata: { shopDomain: scope.account } }] };
}
function input() {
  return { title: 'Synthetic stage objective', metric: 'orders', baseline: 1, target: 2, direction: 'increase',
    startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-11-01T00:00:00.000Z', limits: { profitFirst: false },
    executionPolicy: { schema: OBJECTIVE_EXECUTION_POLICY_SCHEMA, mode: 'enforce', scope } };
}
const options = governedRecordStage => ({ workspaceId: 'stage_objectives', actorId: 'owner_stage', now, governedRecordStage });

test('direct objective producer is closed before any retained-state change by default or forged opt-in', () => {
  for (const stage of [undefined, closed, {}, { enabled: true }]) {
    const state = fixture(), before = structuredClone(state);
    assert.throws(() => upsertBusinessObjective(state, input(), options(stage)), { code: 'GOVERNED_RECORDS_PAUSED' });
    assert.deepEqual(state, before);
  }
});

test('closed stage preserves enforced objectives against every supported edit, including disable and policy removal', () => {
  for (const patch of [{ title: 'Different' }, { target: 3 }, { status: 'paused' }, { status: 'disabled' },
    { status: 'completed' }, { status: 'cancelled' }, { limits: { profitFirst: false, minGrossMarginPercent: 0 } },
    { executionPolicy: { schema: OBJECTIVE_EXECUTION_POLICY_SCHEMA, mode: 'preparation_only' } }]) {
    const state = fixture(), objective = upsertBusinessObjective(state, input(), options(open));
    const before = structuredClone(state);
    assert.throws(() => upsertBusinessObjective(state, { id: objective.id, revision: 1, ...patch }, options(closed)),
      { code: 'GOVERNED_RECORDS_PAUSED' });
    assert.deepEqual(state, before);
  }
});

test('ordinary planning remains editable while closed, and valid zero stays a restriction when enabled', () => {
  const state = fixture(), ordinary = input(); delete ordinary.executionPolicy;
  const row = upsertBusinessObjective(state, ordinary, options(closed));
  const edited = upsertBusinessObjective(state, { id: row.id, revision: 1, target: 3 }, options(closed));
  assert.equal(edited.revision, 2); assert.equal(edited.target, 3);
  const governed = upsertBusinessObjective(state, { ...input(), limits: { profitFirst: false, minGrossMarginPercent: 0 } }, options(open));
  assert.equal(governed.limits.minGrossMarginPercent, 0);
  assert.equal(governed.executionPolicy.mode, 'enforce');
});
