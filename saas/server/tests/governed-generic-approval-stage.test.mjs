import test from 'node:test';
import assert from 'node:assert/strict';
import { objectiveContentApiFixture, objectiveContentState } from './objective-content-test-fixture.mjs';
import { createGovernedRecordStage, GOVERNED_RECORD_PRODUCER_CONTRACT } from '../lib/governed-record-stage.mjs';
import { proposeConnectionWrite } from '../lib/connection-writes.mjs';
import { resolveManualContentTarget } from '../lib/manual-content-target.mjs';
import { modifyApproval } from '../lib/control.mjs';

const stage = createGovernedRecordStage({ GOVERNED_RECORD_PRODUCER_CONTRACT });
const pausedMessage = 'New governed records are paused on this server. Existing records remain available for review and exact reconciliation.';
const paused = result => {
  assert.equal(result.status, 503, JSON.stringify(result.body));
  assert.equal(result.body.code, 'GOVERNED_RECORDS_PAUSED');
  assert.equal(result.body.error, pausedMessage);
};
const pendingWrite = state => proposeConnectionWrite(state, 'shopify', {
  operation: 'product_content', requestId: 'generic_approval_governed_001', productId: state.products[0].id,
  title: 'Exact reviewed title', description: 'Exact reviewed description', target: resolveManualContentTarget(state).target
}, state.users[0].id, { governedRecordStage: stage });

const request = extra => ({ type: 'customer_facing_publish', action: 'Review a proposed change',
  reason: 'Synthetic owner request', expectedBenefit: 'Owner review', risk: 'medium', ...extra });

test('closed generic approval creation cannot persist governed source or payload markers', async t => {
  const f = await objectiveContentApiFixture(t, { env: { GOVERNED_RECORD_PRODUCER_CONTRACT: undefined } });
  const before = await f.store.get(f.workspaceId);
  let saves = 0;
  const save = f.store.save.bind(f.store);
  f.store.save = async (...args) => { saves++; return save(...args); };
  const cases = [
    ['objective source', { source: 'objective-content' }],
    ['owner objective source', { source: 'owner_objective_content' }],
    ['null digest', { payload: { objectivePolicyProposalDigest: null } }],
    ['unknown digest', { payload: { objectivePolicyProposalDigest: 'unknown' } }],
    ['null proposal', { payload: { objectivePolicyProposal: null } }],
    ['unknown proposal', { payload: { objectivePolicyProposal: { schema: 'unknown' } } }],
    ['payload origin', { payload: { origin: 'owner_objective_content' } }],
    ['payload source', { payload: { source: 'objective-content' } }]
  ];
  for (const [name, extra] of cases) await t.test(name, async () => {
    const result = await f.request('/api/actions', { method: 'POST', body: request(extra) });
    paused(result);
    assert.equal(saves, 0);
    assert.deepEqual(await f.store.get(f.workspaceId), before);
  });
});

test('closed generic ordinary approval preserves its source, payload and normal save', async t => {
  const f = await objectiveContentApiFixture(t, { env: { GOVERNED_RECORD_PRODUCER_CONTRACT: undefined } });
  const before = await f.store.get(f.workspaceId);
  let saves = 0;
  const save = f.store.save.bind(f.store);
  f.store.save = async (...args) => { saves++; return save(...args); };
  const body = request({ source: 'owner-review', payload: { description: 'Ordinary request data', amount: 0 } });
  const result = await f.request('/api/actions', { method: 'POST', body });
  assert.equal(result.status, 202, JSON.stringify(result.body));
  const after = await f.store.get(f.workspaceId);
  const approval = after.approvals.find(row => row.id === result.body.approval.id);
  assert.ok(approval);
  assert.equal(approval.status, 'pending');
  assert.equal(approval.source, body.source);
  assert.deepEqual(approval.payload, body.payload);
  assert.equal(after.approvals.length, before.approvals.length + 1);
  assert.deepEqual(after.connectionWrites, before.connectionWrites);
  assert.deepEqual(after.businessObjectives, before.businessObjectives);
  assert.equal(saves, 1);
  const revised = await f.request(`/api/approvals/${approval.id}`, {
    method: 'PATCH', body: { revision: 1, action: 'Revised ordinary approval' }
  });
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  const saved = (await f.store.get(f.workspaceId)).approvals.find(row => row.id === approval.id);
  assert.equal(saved.revision, 2);
  assert.equal(saved.action, 'Revised ordinary approval');
  assert.deepEqual(saved.payload, body.payload);
  assert.equal(saves, 2);
});

test('direct governed approval edits need a trusted producer stage and preserve state on denial', () => {
  for (const governedRecordStage of [undefined, createGovernedRecordStage({}), Object.freeze({ enabled: true })]) {
    const { state } = objectiveContentState();
    const write = pendingWrite(state), before = structuredClone(state);
    assert.throws(() => modifyApproval(state, write.approvalId, { revision: 1, action: 'Changed intent' },
      state.users[0].id, { governedRecordStage }), { code: 'GOVERNED_RECORDS_PAUSED', status: 503 });
    assert.deepEqual(state, before);
  }
  const { state } = objectiveContentState();
  const write = pendingWrite(state);
  const edited = modifyApproval(state, write.approvalId, { revision: 1, action: 'Admitted edit' },
    state.users[0].id, { governedRecordStage: stage });
  assert.equal(edited.action, 'Admitted edit');
  assert.equal(edited.revision, 2);
});

test('closed HTTP PATCH keeps governed approvals intact despite damaged or removed companion markers', async t => {
  for (const corruption of ['intact', 'changed-digest', 'missing-payload-id', 'policy-only']) await t.test(corruption, async t => {
    const f = await objectiveContentApiFixture(t, { env: { GOVERNED_RECORD_PRODUCER_CONTRACT: undefined } });
    const state = await f.store.get(f.workspaceId), write = pendingWrite(state);
    const approval = state.approvals.find(row => row.id === write.approvalId);
    if (corruption === 'changed-digest') approval.payload.digest = '0'.repeat(64);
    if (corruption === 'missing-payload-id') delete approval.payload.connectionWriteId;
    if (corruption === 'policy-only') {
      delete write.objectivePolicyProposal;
      delete approval.payload.objectivePolicyProposalDigest;
    }
    await f.store.save(f.workspaceId, state);
    const before = await f.store.get(f.workspaceId);
    let saves = 0;
    const save = f.store.save.bind(f.store);
    f.store.save = async (...args) => { saves++; return save(...args); };
    paused(await f.request(`/api/approvals/${approval.id}`, {
      method: 'PATCH', body: { revision: 1, action: 'Changed governed intent' }
    }));
    assert.equal(saves, 0);
    assert.deepEqual(await f.store.get(f.workspaceId), before);
  });
});

test('closed generic approval creation follows a one-way reference to governed writes', async t => {
  const f = await objectiveContentApiFixture(t, { env: { GOVERNED_RECORD_PRODUCER_CONTRACT: undefined } });
  const state = await f.store.get(f.workspaceId), write = pendingWrite(state);
  await f.store.save(f.workspaceId, state);
  const before = await f.store.get(f.workspaceId);
  let saves = 0;
  const save = f.store.save.bind(f.store);
  f.store.save = async (...args) => { saves++; return save(...args); };
  for (const digest of [write.digest, '0'.repeat(64), null]) {
    paused(await f.request('/api/actions', { method: 'POST', body: request({ source: 'connection-centre',
      payload: { connectionWriteId: write.id, digest } }) }));
    assert.equal(saves, 0);
    assert.deepEqual(await f.store.get(f.workspaceId), before);
  }
});
