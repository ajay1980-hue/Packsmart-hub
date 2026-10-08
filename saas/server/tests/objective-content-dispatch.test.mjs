import test from 'node:test';
import assert from 'node:assert/strict';
import { objectiveContentFixture, objectiveContentSeed, objectiveContentJob, objectiveContentBody, CONTENT_WORKSPACE, CONTENT_PRODUCT } from './objective-content-fixture.mjs';
import { readObjectiveContentRequest, prepareObjectiveContentRequest } from '../lib/connection-writes.mjs';
import { captureObjectiveDispatchPolicy, assertObjectiveDispatchBinding } from '../lib/objective-dispatch-policy.mjs';
import { objectiveContentContext } from '../lib/objective-content-source.mjs';
import { createStore } from '../lib/store.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

test('objective content synthetic dispatch binds source, reads history at admission and both phase checks, and preserves known completion', async () => {
  const f = await objectiveContentFixture();
  const result = await f.run();
  assert.equal(result.status, 'completed', result.errorCode);
  assert.equal(f.counts.mutations, 1); assert.equal(f.counts.credentials, 1); assert.equal(f.counts.job, 3); assert.equal(f.counts.fresh, 2);
  assert.equal(result.objectivePolicyProposal.origin, 'owner_objective_content');
  assert.equal(result.recordedActionContext.schema, 'runvara-recorded-action-context/v2'); assert.equal(result.recordedActionUnavailable, undefined);
  assert.equal(result.recordedActionContext.origin, 'owner_objective_content');
  assert.equal(f.counts.saves, 3, 'context uses the existing single final save');
  const again = await f.run(); assert.equal(again.status, 'completed'); assert.equal(f.counts.mutations, 1);
});

test('all financial and stock limits including zero remain pre-credential blockers for objective requests', async t => {
  for (const limits of [{ profitFirst: true }, { profitFirst: false, minGrossMarginPercent: 0 },
    { profitFirst: false, minStockCoverDays: 0 }, { profitFirst: false, maxMonthlyAdBudget: 0, currency: 'GBP' }]) {
    await t.test(JSON.stringify(limits), async () => {
      const f = await objectiveContentFixture({ limits });
      assert.equal(f.context.policy.allowed, false);
      await assert.rejects(f.run, error => error.code === 'WRITE_POLICY_EVIDENCE_REQUIRED');
      assert.equal(f.counts.credentials, 0); assert.equal(f.counts.mutations, 0);
    });
  }
});

test('each required job observation rejects missing, nonsucceeded or replaced history with unchanged workspace revision', async t => {
  for (const phase of [1, 2, 3]) for (const change of ['missing', 'status', 'payload', 'report']) await t.test(`${phase}:${change}`, async () => {
    const f = await objectiveContentFixture(), initialRevision = f.state._revision;
    f.hooks.job = async count => {
      if (count !== phase) return;
      assert.equal(f.state._revision, f.database.states.get(CONTENT_WORKSPACE)._revision);
      if (phase === 1) assert.equal(f.state._revision, initialRevision);
      if (change === 'missing') f.database.tables.set('runvara_agent_jobs', []);
      if (change === 'status') f.job.status = 'dead_letter';
      if (change === 'payload') f.job.payload.actorSessionVersion = 2;
      if (change === 'report') f.job.result.proposals[0].nextStep = 'Altered retained report';
    };
    const result = await f.run().catch(error => error);
    assert.notEqual(result.status, 'completed'); assert.equal(f.counts.mutations, 0);
    assert.equal(f.counts.credentials, phase === 1 ? 0 : 1);
    if (phase === 3) assert.equal(f.write.dispatchClaim.phases.shopify_mutation.status, 'dispatching');
    if (phase > 1) { await assert.rejects(f.run); assert.equal(f.counts.mutations, 0); }
  });
});
test('fresh workspace authority runs after the awaited job read and detects a competing replica change', async t => {
  for (const phase of [2, 3]) await t.test(String(phase), async () => {
    const f = await objectiveContentFixture(), order = [];
    f.hooks.job = async count => {
      order.push(`job:${count}`);
      if (count === phase) {
        const other = await f.replica.get(CONTENT_WORKSPACE); other.users[0].active = false;
        await f.replica.save(CONTENT_WORKSPACE, other);
      }
    };
    f.hooks.fresh = async count => { order.push(`workspace:${count}`); };
    const outcome = await f.run().catch(error => error);
    assert.notEqual(outcome.status, 'completed'); assert.equal(f.counts.mutations, 0);
    assert.ok(order.indexOf(`job:${phase}`) < order.indexOf(`workspace:${phase - 1}`));
    assert.equal(f.database.states.get(CONTENT_WORKSPACE).users[0].active, false, 'failed final save cannot overwrite replica change');
  });
});
test('source, requester and write mutations across admission/credential/archive awaits stop before provider submission', async t => {
  for (const boundary of ['admission', 'credentials', 'archive']) for (const kind of ['product', 'requestId', 'epoch']) await t.test(`${boundary}:${kind}`, async () => {
    const f = await objectiveContentFixture();
    const mutate = () => {
      if (kind === 'product') f.state.products[0].description = 'Changed while awaiting';
      if (kind === 'requestId') f.write.requestId += '-changed';
      if (kind === 'epoch') f.state.users[0].sessionVersion++;
    };
    if (boundary === 'admission') f.hooks.job = count => { if (count === 1) mutate(); };
    if (boundary === 'credentials') f.hooks.credentials = mutate;
    if (boundary === 'archive') {
      const archive = f.store.archiveAndCompact.bind(f.store);
      f.store.archiveAndCompact = async (...args) => { const result = await archive(...args); mutate(); return result; };
    }
    const previous = structuredClone(f.database.states.get(CONTENT_WORKSPACE));
    await assert.rejects(f.run); assert.equal(f.counts.mutations, 0);
    assert.deepEqual(f.database.states.get(CONTENT_WORKSPACE), previous, 'changed local source never reaches CAS serialization');
  });
});
test('a prepared v1-only envelope guard rejects actual v2 and unknown versions in every executable status', async t => {
  const f = await objectiveContentFixture();
  for (const status of ['pending_approval', 'ready', 'processing']) for (const variant of ['v2', 'unknown', 'provider', 'operation']) await t.test(`${status}:${variant}`, () => {
    const write = structuredClone(f.write); write.status = status;
    if (variant === 'unknown') write.objectivePolicyProposal.schema = 'runvara-objective-dispatch-proposal/v999';
    if (variant === 'provider') write.provider = 'meta';
    if (variant === 'operation') write.input.operation = 'internal_note';
    const policy = captureObjectiveDispatchPolicy(f.state, write);
    assert.throws(() => assertObjectiveDispatchBinding(write, f.state.approvals[0], policy));
  });
  assert.equal(f.counts.credentials, 0); assert.equal(f.counts.mutations, 0);
});
test('known results survive post-submission source disappearance, eligibility loss, and clock expiry', async t => {
  for (const changed of ['product', 'job', 'owner', 'expiry']) await t.test(changed, async () => {
    const f = await objectiveContentFixture(), originalNow = Date.now, pinnedProposal = structuredClone(f.write.objectivePolicyProposal);
    f.hooks.fetch = async () => {
      if (changed === 'product') f.state.products = [];
      if (changed === 'job') f.database.tables.set('runvara_agent_jobs', []);
      if (changed === 'owner') f.state.users[0].active = false;
      if (changed === 'expiry') Date.now = () => Date.parse(f.state.businessObjectives[0].endsAt) + 1;
      return Response.json({ data: { productUpdate: { product: { id: CONTENT_PRODUCT }, userErrors: [] } } });
    };
    try {
      const result = await f.run(); assert.equal(result.status, 'completed'); assert.equal(f.counts.mutations, 1);
      assert.deepEqual(result.recordedActionContext.proposal, pinnedProposal, 'context preserves the originally approved source after submission');
      assert.equal(result.recordedActionContext.schema, 'runvara-recorded-action-context/v2'); assert.equal(f.counts.saves, 3);
      assert.equal(f.database.states.get(CONTENT_WORKSPACE).connectionWrites[0].status, 'completed');
      assert.equal((await f.run()).status, 'completed'); assert.equal(f.counts.mutations, 1);
      if (['product', 'job'].includes(changed)) {
        const history = await readObjectiveContentRequest(f.state, f.body.requestId, f.session, f.loadJob);
        assert.equal(history.request.status, 'completed'); assert.notEqual(history.sourceStatus.status, 'current');
      }
    } finally { Date.now = originalNow; }
  });
});
test('expiry at the last pre-dispatch observation still denies and retains its phase claim', async () => {
  const f = await objectiveContentFixture(), originalNow = Date.now;
  f.hooks.fresh = count => { if (count === 2) Date.now = () => Date.parse(f.state.businessObjectives[0].endsAt) + 1; };
  try {
    const result = await f.run(); assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'WRITE_POLICY_NOT_ACTIVE');
    assert.equal(f.counts.mutations, 0); assert.ok(f.write.dispatchClaim.phases.shopify_mutation);
  } finally { Date.now = originalNow; }
});
test('known rejection, unknown provider response and lost final save never replay provider mutation', async t => {
  for (const mode of ['rejected', 'unknown', 'lost-final']) await t.test(mode, async () => {
    const f = await objectiveContentFixture();
    if (mode === 'rejected') f.hooks.fetch = async () => Response.json({ data: { productUpdate: { product: null, userErrors: [{ field: 'title', message: 'synthetic rejection' }] } } });
    if (mode === 'unknown') f.hooks.fetch = async () => { throw new Error('lost synthetic provider response'); };
    if (mode === 'lost-final') {
      const save = f.store.save.bind(f.store);
      f.store.save = async (...args) => { const result = await save(...args); if (f.counts.saves === 3) throw new Error('lost final save acknowledgement'); return result; };
    }
    const result = await f.run().catch(error => error);
    if (mode === 'rejected') assert.equal(result.status, 'failed');
    if (mode === 'unknown') assert.equal(result.status, 'uncertain');
    if (mode === 'lost-final') assert.ok(result instanceof Error);
    if (mode === 'lost-final') {
      assert.equal(f.database.states.get(CONTENT_WORKSPACE).connectionWrites[0].status, 'completed');
      assert.equal(f.database.states.get(CONTENT_WORKSPACE).connectionWrites[0].recordedActionContext.schema, 'runvara-recorded-action-context/v2');
    } else assert.equal(f.write.recordedActionContext, undefined, 'failed or uncertain dispatch is never optional action evidence');
    assert.equal(f.counts.mutations, 1);
    await f.run().catch(error => error); assert.equal(f.counts.mutations, 1);
  });
});
test('final CAS conflict preserves the competing workspace and an unreplayable submitted claim', async () => {
  const f = await objectiveContentFixture();
  f.hooks.fetch = async () => {
    const other = await f.replica.get(CONTENT_WORKSPACE); other.products = [];
    await f.replica.save(CONTENT_WORKSPACE, other);
    return Response.json({ data: { productUpdate: { product: { id: CONTENT_PRODUCT }, userErrors: [] } } });
  };
  await assert.rejects(f.run, error => error.code === 'STATE_CONFLICT');
  assert.deepEqual(f.database.states.get(CONTENT_WORKSPACE).products, []);
  assert.equal(f.database.states.get(CONTENT_WORKSPACE).connectionWrites[0].status, 'executing');
  assert.ok(f.database.states.get(CONTENT_WORKSPACE).connectionWrites[0].dispatchClaim.phases.shopify_mutation);
  assert.equal(f.write.status, 'completed', 'known local response is retained even if CAS acknowledgement fails');
  assert.equal(f.write.recordedActionContext.schema, 'runvara-recorded-action-context/v2');
  assert.equal(f.database.states.get(CONTENT_WORKSPACE).connectionWrites[0].recordedActionContext, undefined, 'unacknowledged local evidence is not persisted by a competing CAS');
  assert.equal(f.counts.mutations, 1);
  await f.run(); assert.equal(f.counts.mutations, 1);
});

test('oversized or unsupported optional objective context preserves exact known success and one final save', async t => {
  for (const kind of ['oversized-unicode', 'oversized-escaped', 'unsupported-unicode', 'unsupported-null']) await t.test(kind, async () => {
    const f = await objectiveContentFixture({ contentInput: { description: kind === 'oversized-unicode' ? '雪'.repeat(6000)
      : kind === 'oversized-escaped' ? '\u0001'.repeat(3500) : kind === 'unsupported-unicode' ? '\ud800' : '\0' } });
    const result = await f.run(); assert.equal(result.status, 'completed');
    assert.deepEqual(result.result, { externalId: CONTENT_PRODUCT }); assert.equal(result.recordedActionContext, undefined);
    assert.equal(result.recordedActionUnavailable, kind.startsWith('unsupported') ? 'context_unavailable' : 'source_size_limit');
    assert.equal(f.counts.mutations, 1); assert.equal(f.counts.saves, 3); assert.equal(f.counts.job, 3);
    assert.equal(f.database.states.get(CONTENT_WORKSPACE).connectionWrites[0].status, 'completed');
    await f.run(); assert.equal(f.counts.mutations, 1); assert.equal(f.counts.saves, 3);
  });
});

test('optional objective context respects the unchanged whole-state ceiling without erasing known success', async () => {
  const f = await objectiveContentFixture();
  f.state.unrelatedRetainedText = 'x'.repeat(2065000);
  await f.store.save(CONTENT_WORKSPACE, f.state);
  const result = await f.run();
  assert.equal(result.status, 'completed', result.errorCode); assert.equal(result.recordedActionContext, undefined);
  assert.equal(result.recordedActionUnavailable, 'state_size_limit'); assert.equal(f.counts.saves, 3); assert.equal(f.counts.mutations, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(f.database.states.get(CONTENT_WORKSPACE))) <= 2097152);
  await f.run(); assert.equal(f.counts.mutations, 1); assert.equal(f.counts.saves, 3);
});
test('final private snapshots and acknowledgements cannot substitute approval, claim or admission identity', async t => {
  for (const boundary of ['private', 'ack']) for (const field of ['approval', 'claim', 'admissions', 'context', 'stableApproval']) await t.test(`${boundary}:${field}`, async () => {
    const f = await objectiveContentFixture(), save = f.store.save.bind(f.store);
    const mutate = snapshot => {
      if (field === 'approval') snapshot.approvals[0].decidedBy = 'forged-owner';
      if (field === 'claim') snapshot.connectionWrites[0].dispatchClaim.id = 'forged-claim';
      if (field === 'admissions') snapshot.connectionDispatchAdmissions = [];
      if (field === 'context') snapshot.connectionWrites[0].recordedActionContext.originatingObjective.digest = 'a'.repeat(64);
      if (field === 'stableApproval') snapshot.connectionWrites[0].recordedActionContext.stableApproval.reason = 'forged reason';
    };
    f.store.save = async (workspaceId, state, options) => {
      if (f.counts.saves !== 3) return save(workspaceId, state, options);
      if (boundary === 'private') { const copy = structuredClone(state); mutate(copy); options.beforeCommit(copy); return copy; }
      const result = await save(workspaceId, state, options); mutate(result); return result;
    };
    await assert.rejects(f.run); assert.equal(f.counts.mutations, 1);
    assert.equal(f.write.status, 'completed');
    await f.run(); assert.equal(f.counts.mutations, 1, 'an unconfirmed final snapshot never authorizes another provider mutation');
  });
});
test('two replicas cannot both claim and submit one objective-bound write', async () => {
  const f = await objectiveContentFixture(), secondState = await f.replica.get(CONTENT_WORKSPACE);
  const { executeConnectionWrite } = await import('../lib/connection-writes.mjs');
  const second = () => executeConnectionWrite(secondState, f.write.id, f.session.userId, f.service,
    options => f.replica.save(CONTENT_WORKSPACE, secondState, options), { durableStore: true, actorSession: f.session, loadObjectiveJob: f.loadJob,
      loadFreshState: input => f.replica.getConnectionWriteContext(CONTENT_WORKSPACE, input) });
  const outcomes = await Promise.allSettled([f.run(), second()]);
  assert.equal(f.counts.mutations, 1); assert.equal(outcomes.filter(row => row.status === 'fulfilled' && row.value.status === 'completed').length, 1);
});
test('two replicas preparing one exact ID converge through CAS and exact reconciliation without duplicate approval', async () => {
  const f = objectiveContentSeed(), database = fakeSupabase(), env = { SUPABASE_URL: 'https://objective-content.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only' };
  const store = createStore(env, { fetchImpl: database.fetchImpl }), replica = createStore(env, { fetchImpl: database.fetchImpl });
  await store.save(CONTENT_WORKSPACE, f.state);
  const first = await store.get(CONTENT_WORKSPACE), second = await replica.get(CONTENT_WORKSPACE), job = objectiveContentJob(first, f.objective);
  database.tables.set('runvara_agent_jobs', [job]);
  const loadJob = id => store.getAgentJob(CONTENT_WORKSPACE, id, { includeReport: true });
  const context = await objectiveContentContext(first, job.id, 'opportunity-content', f.session, loadJob), body = objectiveContentBody(context);
  const results = await Promise.allSettled([
    prepareObjectiveContentRequest(first, body, f.session, { loadJob, persist: options => store.save(CONTENT_WORKSPACE, first, options) }),
    prepareObjectiveContentRequest(second, body, f.session, { loadJob, persist: options => replica.save(CONTENT_WORKSPACE, second, options) })
  ]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.find(row => row.status === 'rejected').reason.code, 'OBJECTIVE_CONTENT_SAVE_UNKNOWN');
  const retained = await replica.get(CONTENT_WORKSPACE);
  assert.equal(retained.connectionWrites.length, 1); assert.equal(retained.approvals.length, 1);
  const history = await readObjectiveContentRequest(retained, body.requestId, f.session, loadJob);
  assert.equal(history.found, true); assert.equal(history.sourceStatus.status, 'current');
  let writes = 0;
  const reused = await prepareObjectiveContentRequest(retained, body, f.session, { loadJob, persist: async () => { writes++; } });
  assert.equal(reused.request.id, history.request.id); assert.equal(writes, 0);
});
