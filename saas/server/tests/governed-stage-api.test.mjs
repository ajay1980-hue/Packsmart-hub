import test from 'node:test';
import assert from 'node:assert/strict';
import { createGovernedRecordStage, GOVERNED_RECORD_PRODUCER_CONTRACT } from '../lib/governed-record-stage.mjs';
import { proposeConnectionWrite, prepareObjectiveContentRequest } from '../lib/connection-writes.mjs';
import { resolveManualContentTarget } from '../lib/manual-content-target.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { OBJECTIVE_EXECUTION_POLICY_SCHEMA } from '../lib/business-objectives.mjs';
import { objectiveContentApiFixture, OBJECTIVE_CONTENT_POST as POST } from './objective-content-test-fixture.mjs';
import { fixture as outcomeFixture, BASE, REVIEW, MEASURE, measurementInput } from './business-outcomes-api-fixture.mjs';
import { contentJsonbFixture } from './content-jsonb-test-fixture.mjs';
import { reviewedActionFixture } from './reviewed-action-test-fixture.mjs';
import { protectedReceiptFixture } from './protected-receipt-source-fixture.mjs';

const openStage = createGovernedRecordStage({ GOVERNED_RECORD_PRODUCER_CONTRACT });
const closed = { GOVERNED_RECORD_PRODUCER_CONTRACT: undefined };
const good = result => { assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
const paused = result => { assert.equal(result.status, 503, JSON.stringify(result.body)); assert.equal(result.body.code, 'GOVERNED_RECORDS_PAUSED'); };
const manual = (state, requestId) => ({ operation: 'product_content', requestId, productId: state.products[0].id,
  title: 'Exactly reviewed title', description: 'Exactly reviewed description', target: resolveManualContentTarget(state).target });

test('actual HTTP startup contract is exact and cannot be enabled by request headers, body or tenant fields', async t => {
  for (const marker of [undefined, null, '', 'true', ` ${GOVERNED_RECORD_PRODUCER_CONTRACT}`, 'runvara-governed-record-producers/v999']) {
    await t.test(String(marker), async t => {
      const f = await objectiveContentApiFixture(t, { env: { GOVERNED_RECORD_PRODUCER_CONTRACT: marker } });
      const before = await f.store.get(f.workspaceId), body = f.body(await f.context());
      let saves = 0; const save = f.store.save.bind(f.store); f.store.save = async (...args) => { saves++; return save(...args); };
      paused(await f.request(POST, { method: 'POST', body }));
      const identity = f.auth();
      const response = await fetch(f.base + POST, { method: 'POST', headers: { Cookie: `packsmart_session=${identity.token}`,
        'X-CSRF-Token': identity.csrf, 'Content-Type': 'application/json', 'GOVERNED_RECORD_PRODUCER_CONTRACT': GOVERNED_RECORD_PRODUCER_CONTRACT,
        'X-Governed-Record-Producers': GOVERNED_RECORD_PRODUCER_CONTRACT, 'X-Workspace-Id': 'content-beta' }, body: JSON.stringify(body) });
      paused({ status: response.status, body: await response.json() });
      for (const extra of [{ GOVERNED_RECORD_PRODUCER_CONTRACT }, { governedRecordStage: { enabled: true } }, { workspaceId: 'content-beta' }]) {
        const result = await f.request(POST, { method: 'POST', body: { ...body, ...extra } });
        assert.equal(result.status, 400, JSON.stringify(result.body));
      }
      for (const tenant of ['content-alpha', 'content-beta']) {
        const state = await f.store.get(tenant);
        paused(await f.request('/api/connections/shopify/writes', { method: 'POST', identity: f.auth(tenant), body: manual(state, `closed_manual_${tenant}_001`) }));
      }
      assert.equal(saves, 0); assert.deepEqual(await f.store.get(f.workspaceId), before);
    });
  }
  const forward = await objectiveContentApiFixture(t);
  good(await forward.request(POST, { method: 'POST', body: forward.body(await forward.context()) }));
});

test('closed objective policy create, edits, omission and removal are held without weakening retained zero limits', async t => {
  const f = await objectiveContentApiFixture(t, { env: closed });
  await f.change(state => Object.assign(state.businessObjectives[0].limits, { profitFirst: true, maxMonthlyAdBudget: 0, currency: 'GBP' }));
  const before = await f.store.get(f.workspaceId), objective = before.businessObjectives[0];
  let saves = 0; const save = f.store.save.bind(f.store); f.store.save = async (...args) => { saves++; return save(...args); };
  for (const edit of [{}, { status: 'paused' }, { executionPolicy: { schema: OBJECTIVE_EXECUTION_POLICY_SCHEMA, mode: 'preparation_only' } },
    { limits: { profitFirst: false, maxMonthlyAdBudget: 999 } }, { title: 'Changed title' }]) {
    paused(await f.request('/api/business-objectives', { method: 'PUT', body: { id: objective.id, revision: objective.revision, ...edit } }));
  }
  assert.equal((await f.request('/api/business-objectives', { method: 'PUT', body: { id: objective.id, revision: objective.revision, executionPolicy: null } })).status, 400);
  const { id, revision, workspaceId, createdAt, updatedAt, createdBy, updatedBy, ...definition } = objective;
  paused(await f.request('/api/business-objectives', { method: 'PUT', body: definition }));
  assert.equal(saves, 0); assert.deepEqual(await f.store.get(f.workspaceId), before);
  const ordinary = good(await f.request('/api/business-objectives', { method: 'PUT', body: { title: 'Prepare only', metric: 'orders',
    baseline: 0, target: 1, direction: 'increase', startsAt: objective.startsAt, endsAt: objective.endsAt } }));
  assert.equal(ordinary.objective.executionPolicy, undefined);
  assert.deepEqual((await f.store.get(f.workspaceId)).businessObjectives.find(row => row.id === objective.id), objective);
});

test('closed approval cannot evade classification through missing, changed or malformed companion authority', async t => {
  for (const corruption of ['missing-digest', 'changed-digest', 'missing-payload-id', 'null-marker', 'approval-only-marker']) await t.test(corruption, async t => {
    const f = await objectiveContentApiFixture(t, { env: closed }), state = await f.store.get(f.workspaceId);
    const write = proposeConnectionWrite(state, 'shopify', manual(state, 'tampered_governed_approval_001'), f.actorId, { governedRecordStage: openStage });
    const approval = state.approvals.find(row => row.id === write.approvalId);
    if (corruption === 'missing-digest') delete approval.payload.digest;
    if (corruption === 'changed-digest') approval.payload.digest = '0'.repeat(64);
    if (corruption === 'missing-payload-id') delete approval.payload.connectionWriteId;
    if (corruption === 'null-marker') write.objectivePolicyProposal = null;
    if (corruption === 'approval-only-marker') { state.businessObjectives = []; delete write.objectivePolicyProposal; approval.payload.objectivePolicyProposalDigest = null; }
    await f.store.save(f.workspaceId, state); const before = await f.store.get(f.workspaceId);
    let saves = 0; const save = f.store.save.bind(f.store); f.store.save = async (...args) => { saves++; return save(...args); };
    paused(await f.request(`/api/approvals/${approval.id}/decision`, { method: 'POST', body: { decision: 'approved', revision: 1 } }));
    assert.equal(saves, 0); assert.deepEqual(await f.store.get(f.workspaceId), before);
  });
});

test('closed retained v1/v2 request replay and history are read-only; governed approval holds and rejection works', async t => {
  for (const family of ['manual-v1', 'objective-v2']) await t.test(family, async t => {
    const f = await objectiveContentApiFixture(t, { env: closed }), review = await f.context();
    const state = await f.store.get(f.workspaceId), body = family === 'manual-v1' ? manual(state, 'retained_manual_request_001') : f.body(review);
    let write;
    if (family === 'manual-v1') write = proposeConnectionWrite(state, 'shopify', body, f.actorId, { governedRecordStage: openStage });
    else {
      const prepared = await prepareObjectiveContentRequest(state, body, { workspaceId: f.workspaceId, userId: f.actorId, sessionVersion: 1 }, {
        governedRecordStage: openStage, loadJob: id => f.store.getAgentJob(f.workspaceId, id, { includeReport: true }), persist: options => f.store.save(f.workspaceId, state, options) });
      write = state.connectionWrites.find(row => row.id === prepared.request.id);
    }
    if (family === 'manual-v1') await f.store.save(f.workspaceId, state);
    const before = await f.store.get(f.workspaceId);
    let saves = 0; const save = f.store.save.bind(f.store); f.store.save = async (...args) => { saves++; return save(...args); };
    const route = family === 'manual-v1' ? '/api/connections/shopify/writes' : POST;
    const history = family === 'manual-v1' ? `/api/connections/shopify/content-requests/${body.requestId}` : `${POST}/${body.requestId}`;
    assert.equal(good(await f.request(history)).request.id, write.id);
    good(await f.request(route, { method: 'POST', body }));
    const conflict = await f.request(route, { method: 'POST', body: { ...body, title: 'Changed intent' } });
    assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'WRITE_CONFLICT');
    paused(await f.request(`/api/approvals/${write.approvalId}/decision`, { method: 'POST', body: { decision: 'approved', revision: 1 } }));
    assert.equal(saves, 0); assert.deepEqual(await f.store.get(f.workspaceId), before);
    good(await f.request(`/api/approvals/${write.approvalId}/decision`, { method: 'POST', body: { decision: 'rejected', revision: 1 } }));
    const after = await f.store.get(f.workspaceId);
    assert.equal(after.connectionWrites.find(row => row.id === write.id).status, 'rejected');
    assert.deepEqual(after.connectionWrites.find(row => row.id === write.id).objectivePolicyProposal, write.objectivePolicyProposal);
    assert.equal(saves, 1);
  });
});

test('closed linked measurement selection, source reuse and removal preserve v2/v3/v4; ordinary v1 still saves', async t => {
  for (const family of ['manual-v2', 'objective-v3', 'receipt-v4']) await t.test(family, async t => {
    let state, selection, receipts = [];
    if (family === 'objective-v3') {
      const producer = await contentJsonbFixture({ family: 'objective-v2' }); await producer.run();
      state = producer.state; selection = { actionId: producer.write.id };
    } else {
      const producer = reviewedActionFixture({ workspaceId: 'outcome-alpha' });
      state = { ...seedWorkspaceState({}, { workspaceId: 'outcome-alpha', userId: 'user_owner', email: 'outcome-alpha@example.test', passwordHash: 'synthetic-only' }), ...producer.state };
      selection = { actionId: producer.write.id };
      if (family === 'receipt-v4') { const receipt = protectedReceiptFixture({ fixture: producer }); receipts = [receipt.evidence]; selection = { receipt: receipt.selector }; }
    }
    const forward = await outcomeFixture(t, { measured: false, primaryState: state, linkedContract: 'runvara-reviewed-action/v2', protectedSources: receipts });
    const saved = good(await forward.request(MEASURE, { method: 'PUT', body: { ...measurementInput(), actionSelection: selection } }));
    const expectedSchema = { 'manual-v2': 'v2', 'objective-v3': 'v3', 'receipt-v4': 'v4' }[family];
    assert.equal(saved.measurement.schema, `runvara-experiment-measurement/${expectedSchema}`);
    const published = good(await forward.request(`${BASE}/publish`, { method: 'POST', body: forward.publicationInput() }));
    const f = await outcomeFixture(t, { measured: false, primaryState: state, linkedContract: 'runvara-reviewed-action/v2', protectedSources: receipts, env: closed });
    paused(await f.request(MEASURE, { method: 'PUT', body: { ...measurementInput(), actionSelection: selection } }));
    assert.equal(f.counts.saves, 0);
    for (const [id, value] of forward.states) f.states.set(id, structuredClone(value));
    for (const [id, value] of forward.rows) f.rows.set(id, structuredClone(value));
    const before = structuredClone(f.states.get(f.primaryWorkspace)), rows = structuredClone([...f.rows]);
    const review = good(await f.request(REVIEW)); assert.deepEqual(review.measurement, saved.measurement);
    good(await f.request(`${BASE}/versions/${published.publication.head.versionId}`));
    for (const actionSelection of [selection, null, { reuseVersionId: published.publication.head.versionId }]) {
      paused(await f.request(MEASURE, { method: 'PUT', body: { ...measurementInput(1), actionSelection } }));
    }
    assert.equal(f.counts.saves, 0); assert.deepEqual(f.states.get(f.primaryWorkspace), before); assert.deepEqual([...f.rows], rows);
    const beta = f.states.get('outcome-beta').revenueEngine.experiments[0].outcomeMeasurement;
    const unlinked = good(await f.request(MEASURE, { method: 'PUT', identity: f.auth('outcome-beta'), body: measurementInput(beta?.revision ?? 0) }));
    assert.equal(unlinked.measurement.schema, 'runvara-experiment-measurement/v1');
    assert.equal(f.counts.saves, 1); assert.equal(f.counts.providerCalls, 0);
  });
});
