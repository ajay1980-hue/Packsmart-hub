import test from 'node:test';
import assert from 'node:assert/strict';
import { createGovernedRecordStage, GOVERNED_RECORD_PRODUCER_CONTRACT } from '../lib/governed-record-stage.mjs';
import { executeConnectionWrite, prepareObjectiveContentRequest, proposeConnectionWrite,
  readManualContentRequest, readObjectiveContentRequest } from '../lib/connection-writes.mjs';
import { createStore } from '../lib/store.mjs';
import { objectiveContentContext } from '../lib/objective-content-source.mjs';
import { resolveManualContentTarget } from '../lib/manual-content-target.mjs';
import { CONTENT_EXECUTION_RECEIPT_CONTRACT, CONTENT_EXECUTION_RECEIPT_ACK_SCHEMA, contentReceiptRequestFingerprint } from '../lib/content-execution-receipt.mjs';
import { contentJsonbFixture, CONTENT_FAMILIES, CONTENT_PRODUCT } from './content-jsonb-test-fixture.mjs';
import { objectiveContentSeed, objectiveContentJob, objectiveContentBody } from './objective-content-fixture.mjs';

const governedRecordStage = createGovernedRecordStage({ GOVERNED_RECORD_PRODUCER_CONTRACT });
const closedStages = [undefined, createGovernedRecordStage({}),
  createGovernedRecordStage({ GOVERNED_RECORD_PRODUCER_CONTRACT: 'unknown' }), Object.freeze({ enabled: true })];
const paused = { status: 503, code: 'GOVERNED_RECORDS_PAUSED' };
const manualBody = state => ({ operation: 'product_content', requestId: 'governed-stage-request-0001',
  productId: CONTENT_PRODUCT, title: 'Reviewed title', description: 'Reviewed description', target: resolveManualContentTarget(state).target });

test('closed manual policy-envelope creation is atomic and exact retained IDs still reconcile', () => {
  for (const stage of closedStages) for (const absentWrites of [false, true]) {
    const { state, session } = objectiveContentSeed();
    if (absentWrites) delete state.connectionWrites;
    const body = manualBody(state), before = structuredClone(state);
    assert.throws(() => proposeConnectionWrite(state, 'shopify', body, session.userId, { governedRecordStage: stage }), paused);
    assert.deepEqual(state, before, 'No array creation, approval or audit on denial');
    const write = proposeConnectionWrite(state, 'shopify', body, session.userId, { governedRecordStage });
    const retained = structuredClone(state);
    assert.equal(proposeConnectionWrite(state, 'shopify', body, session.userId), write);
    assert.equal(readManualContentRequest(state, body.requestId, session.userId).request.id, write.id);
    assert.deepEqual(state, retained);
    assert.throws(() => proposeConnectionWrite(state, 'shopify', { ...body, title: 'Changed intent' }, session.userId), { code: 'WRITE_CONFLICT' });
  }
});

test('closed objective creation refuses before source lookup, persistence and any state mutation', async () => {
  for (const stage of closedStages) for (const absentWrites of [false, true]) {
    const { state, objective, session } = objectiveContentSeed();
    const job = objectiveContentJob(state, objective);
    const context = await objectiveContentContext(state, job.id, 'opportunity-content', session, async () => job);
    if (absentWrites) delete state.connectionWrites;
    const before = structuredClone(state);
    await assert.rejects(prepareObjectiveContentRequest(state, objectiveContentBody(context), session, {
      governedRecordStage: stage, loadJob: async () => assert.fail('No source read on new closed admission'),
      persist: async () => assert.fail('No save on new closed admission') }), paused);
    assert.deepEqual(state, before);
  }
});

test('closed retained objective preparation and both history readers preserve original records and changed-intent conflicts', async () => {
  for (const family of ['manual-v1-policy', 'objective-v2']) {
    const f = await contentJsonbFixture({ family });
    const before = structuredClone(f.state);
    if (family === 'objective-v2') {
      const result = await prepareObjectiveContentRequest(f.state, f.body, f.session, { loadJob: f.loadJob,
        persist: async () => assert.fail('Exact reconciliation must not save') });
      assert.equal(result.request.id, f.write.id);
      assert.equal((await readObjectiveContentRequest(f.state, f.body.requestId, f.session, f.loadJob)).request.id, f.write.id);
      await assert.rejects(prepareObjectiveContentRequest(f.state, { ...f.body, title: 'Different title' }, f.session,
        { loadJob: f.loadJob }), { code: 'WRITE_CONFLICT' });
    } else {
      assert.equal(proposeConnectionWrite(f.state, 'shopify', f.body, f.session.userId), f.write);
      assert.equal(readManualContentRequest(f.state, f.body.requestId, f.session.userId).request.id, f.write.id);
    }
    assert.deepEqual(f.state, before); assert.equal(f.counts.saves, 0); assert.equal(f.counts.mutations, 0);
  }
});

test('governed execution and protected manual receipt admission fail closed before credentials, claims or saves', async () => {
  for (const family of CONTENT_FAMILIES) for (const stage of closedStages) {
    const f = await contentJsonbFixture({ family });
    const before = structuredClone(f.state);
    await assert.rejects(f.run({ governedRecordStage: stage,
      ...(family === 'manual' ? { protectedContentReceipts: CONTENT_EXECUTION_RECEIPT_CONTRACT } : {}) }), paused);
    assert.deepEqual(f.state, before); assert.deepEqual(f.counts, { job: 0, credentials: 0, saves: 0, fresh: 0, mutations: 0, privateChecks: 0 });
  }
});

test('unknown or null retained envelope markers are held, including approval-only and source-only markers', async () => {
  const mutations = [
    f => { f.write.objectivePolicyProposal = null; },
    f => { f.write.objectivePolicyProposal = { schema: 'unknown' }; },
    f => { f.state.approvals[0].payload.objectivePolicyProposalDigest = null; },
    f => { f.state.approvals[0].source = 'objective-content'; },
    f => { f.write.origin = 'owner_objective_content'; }
  ];
  for (const change of mutations) {
    const f = await contentJsonbFixture({ family: 'manual' }); change(f);
    const before = structuredClone(f.state);
    await assert.rejects(f.run({ governedRecordStage: undefined }), paused);
    assert.deepEqual(f.state, before); assert.equal(f.counts.credentials, 0); assert.equal(f.counts.saves, 0);
  }
});

test('current enforced policy still closes an older unmarked manual request', async () => {
  const f = await contentJsonbFixture({ family: 'manual-v1-policy' });
  delete f.write.objectivePolicyProposal; delete f.state.approvals[0].payload.objectivePolicyProposalDigest;
  const before = structuredClone(f.state);
  await assert.rejects(f.run({ governedRecordStage: undefined }), paused);
  assert.deepEqual(f.state, before); assert.equal(f.counts.credentials, 0); assert.equal(f.counts.mutations, 0);
  await assert.rejects(f.run(), { code: 'WRITE_POLICY_REVIEW_REQUIRED' });
});

test('ordinary closed content succeeds with both fresh reads and omits only optional new context', async () => {
  for (const existingContext of [undefined, { schema: 'retained-context', preserved: true }]) {
    const f = await contentJsonbFixture({ family: 'manual' });
    if (existingContext) { f.write.recordedActionContext = structuredClone(existingContext); await f.store.save(f.state.workspace.id, f.state); }
    const result = await f.run({ governedRecordStage: undefined });
    assert.equal(result.status, 'completed'); assert.equal(result.result.externalId, CONTENT_PRODUCT);
    assert.deepEqual(result.recordedActionContext, existingContext); assert.equal(Object.hasOwn(result, 'recordedActionUnavailable'), false);
    assert.equal(f.counts.mutations, 1); assert.equal(f.counts.saves, 3); assert.equal(f.counts.fresh, 2);
    const saved = (await f.coldHistory()).state.connectionWrites[0];
    assert.deepEqual(saved.recordedActionContext, existingContext);
    const before = structuredClone(f.counts);
    assert.equal((await f.run({ governedRecordStage: undefined })).status, 'completed');
    assert.deepEqual(f.counts, before, 'Completed return never replays or creates new context');
  }
});

test('opening producers retains existing financial restrictions', async () => {
  const f = await contentJsonbFixture({ family: 'manual-v1-policy', seedChange: state => {
    state.businessObjectives[0].limits.profitFirst = true;
  } });
  await assert.rejects(f.run(), { code: 'WRITE_POLICY_EVIDENCE_REQUIRED' });
  assert.equal(f.counts.credentials, 0); assert.equal(f.counts.saves, 0); assert.equal(f.counts.mutations, 0);
});

test('startup admission stays immutable at source, credentials, both reads, provider and final save', async () => {
  for (const boundary of ['source', 'credentials', 'fresh-1', 'fresh-2', 'provider', 'final-save']) {
    const env = { GOVERNED_RECORD_PRODUCER_CONTRACT };
    const originalStage = createGovernedRecordStage(env), f = await contentJsonbFixture({ family: 'objective-v2' });
    let reached = false;
    const closeSuccessor = () => { reached = true; env.GOVERNED_RECORD_PRODUCER_CONTRACT = ''; };
    if (boundary === 'source') f.hooks.job = count => { if (count === 1) closeSuccessor(); };
    if (boundary === 'credentials') f.hooks.credentials = closeSuccessor;
    if (boundary.startsWith('fresh-')) f.hooks.beforeFresh = count => { if (count === Number(boundary.at(-1))) closeSuccessor(); };
    if (boundary === 'provider') f.hooks.fetch = closeSuccessor;
    if (boundary === 'final-save') f.hooks.persist = count => { if (count === 3) closeSuccessor(); };
    const result = await f.run({ governedRecordStage: originalStage });
    assert.equal(reached, true, boundary); assert.equal(result.status, 'completed', boundary);
    assert.equal(f.counts.mutations, 1); assert.equal(f.counts.saves, 3); assert.equal(f.counts.fresh, 2);
    assert.ok(result.recordedActionContext, 'The already-open process stays open while a closed successor can be constructed');
    const closedSuccessor = createGovernedRecordStage(env), retained = structuredClone(f.state), counts = structuredClone(f.counts);
    assert.equal((await f.run({ governedRecordStage: closedSuccessor })).status, 'completed');
    assert.deepEqual(f.state, retained); assert.deepEqual(f.counts, counts);
  }
});

test('an admitted known provider success settles through a closed successor store with one mandatory receipt and no fresh reservation', async () => {
  for (const family of ['manual', 'objective-v2']) {
    const f = await contentJsonbFixture({ family }), commits = [], workspaceId = f.state.workspace.id;
    const fetchImpl = async (input, options = {}) => {
      const name = new URL(input).pathname.split('/').pop();
      if (['runvara_reserve_content_receipt', 'runvara_finalize_content_receipt'].includes(name)) {
        const raw = JSON.parse(options.body).p_request_json, r = JSON.parse(raw);
        assert.equal(f.database.states.get(workspaceId)._revision, r.expectedRevision);
        commits.push(r); f.database.states.set(workspaceId, structuredClone(r.state));
        return Response.json({ schema: CONTENT_EXECUTION_RECEIPT_ACK_SCHEMA, kind: r.kind, workspaceId,
          attemptId: r.admission.attemptId, admissionDigest: r.admission.digest, intentDigest: r.admission.intentDigest,
          requestFingerprint: contentReceiptRequestFingerprint(raw), expectedRevision: r.expectedRevision, nextRevision: r.nextRevision,
          receiptDigest: r.kind === 'finalize' ? r.receipt.digest : null, reservedBytes: 40960, replayed: false });
      }
      return f.database.fetchImpl(input, options);
    };
    const env = { SUPABASE_URL: 'https://receipt-stage.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only', CONTENT_EXECUTION_RECEIPT_CONTRACT };
    const openStore = createStore({ ...env, GOVERNED_RECORD_PRODUCER_CONTRACT }, { fetchImpl });
    const closedStore = createStore(env, { fetchImpl });
    f.store.save = openStore.save.bind(openStore);
    f.hooks.fetch = () => { f.store.save = closedStore.save.bind(closedStore); };
    const result = await f.run({ protectedContentReceipts: CONTENT_EXECUTION_RECEIPT_CONTRACT });
    assert.equal(result.status, 'completed'); assert.equal(f.counts.mutations, 1); assert.equal(f.counts.saves, 3);
    assert.deepEqual(commits.map(row => row.kind), ['reserve', 'finalize']);
    assert.deepEqual(commits[1].admission, commits[0].admission);
    assert.equal(commits[1].receipt.source.context.completedAt, result.completedAt);
    assert.equal(f.database.states.get(workspaceId).connectionWrites[0].status, 'completed');
    const before = structuredClone(f.counts);
    await f.run({ governedRecordStage: undefined, protectedContentReceipts: CONTENT_EXECUTION_RECEIPT_CONTRACT });
    assert.deepEqual(f.counts, before); assert.equal(commits.length, 2);
  }
});

test('missing or unknown capture cannot fall back around an enforced phase boundary', async () => {
  for (const capture of [undefined, 'runvara-content-execution-receipts/unknown']) {
    const f = await contentJsonbFixture({ family: 'manual' });
    // Synthetic database guard: the real SQL guard has separate integration
    // coverage. Every unprotected phase save is refused, including terminal
    // attempts; the adapter must not turn this into a provider or receipt retry.
    f.hooks.persist = (_count, options) => {
      if (f.write.dispatchClaim?.phases?.shopify_mutation) {
        assert.equal(options?.protectedContentCommit, undefined);
        throw Object.assign(new Error('Synthetic enforced receipt guard'), { code: 'CONTENT_RECEIPT_GUARD_REQUIRED' });
      }
    };
    await assert.rejects(f.run({ governedRecordStage: undefined, protectedContentReceipts: capture }),
      { code: capture === undefined ? 'CONTENT_RECEIPT_GUARD_REQUIRED' : 'CONTENT_RECEIPT_UNAVAILABLE' });
    assert.equal(f.counts.mutations, 0); assert.equal(f.write.recordedActionContext, undefined);
    const retained = f.database.states.get(f.state.workspace.id).connectionWrites[0];
    if (capture === undefined) {
      assert.equal(retained.status, 'executing'); assert.deepEqual(retained.dispatchClaim.phases, {});
    } else {
      assert.equal(retained.status, 'ready'); assert.equal(retained.dispatchClaim, undefined);
      assert.equal(f.counts.credentials, 0); assert.equal(f.counts.saves, 0);
    }
  }
});
