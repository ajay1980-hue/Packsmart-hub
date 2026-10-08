/**
 * Real PostgreSQL JSONB compatibility proof, deliberately outside *.test.mjs.
 * Run only through the explicit disposable runner, or with its existing
 * OUTCOME_* opt-in contract and locked atomic-usage pg dependency available.
 * There is no Supabase/Shopify network, migration, schema, or production state.
 */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { executeConnectionWrite } from '../lib/connection-writes.mjs';
import { digestReviewedActionValue, resolveRecordedActionEvidence, validateReviewedSourceAction } from '../lib/reviewed-action-evidence.mjs';
import { contentJsonbFixture, CONTENT_FAMILIES, CONTENT_CONSENTS } from './content-jsonb-test-fixture.mjs';
import { openJsonbFixture } from './content-jsonb-postgres-fixture.mjs';

let pg, unexpectedNetwork = 0;
const originalFetch = globalThis.fetch;
before(async () => {
  globalThis.fetch = async () => { unexpectedNetwork++; throw new Error('Real storage/provider network is forbidden in this fixture'); };
  pg = await openJsonbFixture();
  console.log(JSON.stringify({ safety: pg.info, emptyFixture: true, applicationSchemaChanges: 0, mutationSql: false }));
});
after(async () => {
  try {
    if (pg) {
      await pg.close();
      console.log(JSON.stringify({ realJsonbCasts: pg.casts.length, orderChangingCasts: pg.casts.filter(row => row.orderChanged).length,
        emptyAtFinish: true, applicationSchemaChanges: 0, unexpectedNetwork }));
    }
    assert.equal(unexpectedNetwork, 0);
  } finally { globalThis.fetch = originalFetch; }
});

async function assertCompleted(f, { storageOrder = true } = {}) {
  const producerOrder = Object.keys(f.before.connectionWrites[0].input);
  const coldOrder = Object.keys(f.write.input);
  if (storageOrder) assert.notDeepEqual(coldOrder, producerOrder, 'Actual PostgreSQL must exercise changed input order');
  assert.deepEqual(f.write.input, f.before.connectionWrites[0].input);
  const inputAtAdmission = JSON.stringify(f.write.input), proposalAtAdmission = JSON.stringify(f.write.objectivePolicyProposal);
  const acknowledgements = [], narrowInputOrders = [];
  const fetch = f.store.fetch.bind(f.store), fresh = f.hooks.fresh;
  f.store.fetch = async (url, options = {}) => {
    const response = await fetch(url, options);
    if (new URL(url).pathname.endsWith('/saas_workspace_state') && options.method === 'PATCH') {
      const acknowledgement = await response.clone().json();
      assert.deepEqual(acknowledgement, [{ workspace_id: f.session.workspaceId }],
        'The actual Supabase adapter primary response acknowledges only workspace_id');
      acknowledgements.push(acknowledgement);
    }
    return response;
  };
  f.hooks.fresh = async (snapshot, number, input) => {
    const inspected = await fresh?.(snapshot, number, input) ?? snapshot;
    const order = Object.keys(inspected.connectionWrites[0].input);
    narrowInputOrders.push(order);
    if (storageOrder) assert.deepEqual(order, coldOrder, 'Both narrow reads retain actual PostgreSQL key order');
    return inspected;
  };
  const result = await f.run();
  assert.equal(result.status, 'completed', `${f.family}/${f.consent}: ${result.errorCode || result.code || result.status}`);
  assert.equal(f.counts.mutations, 1, 'Exactly one mocked provider submission');
  assert.equal(f.counts.fresh, 2, 'Both narrow authority rereads must execute');
  assert.equal(f.counts.saves, 3, 'Claim, phase, and final completion must each save');
  assert.equal(acknowledgements.length, 3);
  assert.equal(f.saves.length, 3);
  assert.equal(JSON.stringify(result.input), inputAtAdmission, 'Execution must not normalize or reorder persisted input');
  assert.equal(JSON.stringify(result.objectivePolicyProposal), proposalAtAdmission, 'Execution must not rewrite persisted proposal');
  assert.equal(result.digest, f.expected.inputDigest);
  assert.equal(result.dispatchClaim.identity, f.expected.identity, 'Original producer claim fingerprint bytes');
  assert.equal(result.dispatchClaim.authority, f.expected.authority, 'Original producer authority fingerprint bytes');
  assert.equal(result.dispatchClaim.phases.shopify_mutation.requestDigest, f.expected.requestDigest);
  assert.equal(result.dispatchClaim.phases.shopify_mutation.status, 'dispatching', 'Existing retained phase representation stays unchanged');
  assert.equal(f.requests[0].url, f.expected.request.url);
  assert.equal(f.requests[0].method, f.expected.request.method);
  assert.equal(f.requests[0].body, f.expected.request.body, 'Exact provider body bytes unchanged');
  for (const saved of f.saves) {
    const claim = saved.connectionWrites[0].dispatchClaim;
    assert.equal(claim.identity, f.expected.identity);
    assert.equal(claim.authority, f.expected.authority);
    assert.equal(saved.connectionWrites[0].digest, f.expected.inputDigest);
    assert.deepEqual(saved.connectionWrites[0].input, f.before.connectionWrites[0].input);
  }
  const cold = await f.coldHistory(), savedWrite = cold.state.connectionWrites.find(row => row.id === result.id);
  assert.equal(cold.history.found, true);
  assert.equal(cold.history.request.status, 'completed');
  assert.equal(savedWrite.status, 'completed');
  if (storageOrder) assert.deepEqual(Object.keys(savedWrite.input), coldOrder, 'Final cold history retains actual PostgreSQL key order');
  assert.deepEqual(savedWrite.dispatchClaim, result.dispatchClaim);
  assert.deepEqual(savedWrite.result, result.result);
  assert.equal(cold.state.connectionDispatchAdmissions.length, 1);
  assert.equal(f.saves.at(-1).connectionWrites[0].status, 'completed');
  if (f.family !== 'objective-v2') {
    const evidence = resolveRecordedActionEvidence(cold.state, result.id);
    assert.deepEqual(validateReviewedSourceAction(evidence, { workspaceId: f.session.workspaceId }), evidence);
    assert.equal(evidence.input.description, f.before.connectionWrites[0].input.description);
    assert.equal(evidence.context.origin, 'owner_manual');
    assert.equal(evidence.context.policies.length, f.family === 'manual-v1-policy' ? 1 : 0);
    assert.equal(evidence.context.claimIdentity, f.expected.identity);
  } else {
    const originalWrite = f.before.connectionWrites[0], proposal = originalWrite.objectivePolicyProposal;
    const approval = f.before.approvals.find(row => row.id === originalWrite.approvalId);
    const evidence = resolveRecordedActionEvidence(cold.state, result.id);
    assert.deepEqual(validateReviewedSourceAction(evidence, { workspaceId: f.session.workspaceId }), evidence);
    assert.equal(evidence.schema, 'runvara-reviewed-source-action/v2');
    assert.equal(evidence.context.schema, 'runvara-recorded-action-context/v2');
    assert.equal(evidence.context.origin, 'owner_objective_content');
    assert.deepEqual(savedWrite.recordedActionContext, { ...evidence.context, snapshotDigest: evidence.digest });
    assert.deepEqual(evidence.input, originalWrite.input);
    assert.deepEqual(evidence.context.proposal, proposal, 'Cold evidence retains the exact approved source and proposal');
    assert.deepEqual(evidence.context.originatingObjective, { workspaceId: f.session.workspaceId,
      id: f.objective.id, revision: f.objective.revision, digest: proposal.source.objectiveDigest });
    assert.deepEqual(evidence.context.policies, proposal.policies);
    const decision = { workspaceId: f.session.workspaceId, id: approval.id, revision: approval.revision,
      status: approval.status, decidedBy: approval.decidedBy, decidedAt: approval.decidedAt, payload: approval.payload };
    assert.deepEqual(evidence.context.approval, { ...decision, digest: digestReviewedActionValue(decision) });
    assert.deepEqual(evidence.context.stableApproval, {
      id: approval.id, type: approval.type, action: approval.action, reason: approval.reason,
      financialImpact: approval.financialImpact, expectedBenefit: approval.expectedBenefit, risk: approval.risk,
      requestedBy: approval.requestedBy, source: approval.source,
      payload: { connectionWriteId: originalWrite.id, digest: f.expected.inputDigest },
      evidence: approval.evidence, revision: approval.revision, agentId: approval.agentId, createdAt: approval.createdAt
    }, 'Cold evidence retains the original stable approval, without its circular proposal digest');
    assert.equal(evidence.context.inputDigest, f.expected.inputDigest);
    assert.equal(evidence.context.claimIdentity, f.expected.identity, 'Evidence retains original producer claim fingerprint bytes');
    assert.equal(evidence.context.dispatchRequestDigest, f.expected.requestDigest);
    assert.equal(savedWrite.dispatchClaim.authority, f.expected.authority);
  }
  const beforeRepeat = { ...f.counts }, claimBeforeRepeat = JSON.stringify(savedWrite.dispatchClaim);
  await executeConnectionWrite(cold.state, result.id, f.session.userId, f.service,
    async () => { assert.fail('Completed cold history must not save a new claim'); }, {
      durableStore: true, actorSession: f.session, loadObjectiveJob: f.loadJob,
      loadFreshState: async () => { assert.fail('Completed cold history must not reopen authority'); }
    });
  assert.equal(f.counts.mutations, beforeRepeat.mutations);
  assert.equal(f.counts.credentials, beforeRepeat.credentials);
  assert.equal(JSON.stringify(savedWrite.dispatchClaim), claimBeforeRepeat);
  return { family: f.family, consent: f.consent, producerOrder, actualPostgresOrder: coldOrder, narrowInputOrders,
    counts: f.counts, claimIdentity: result.dispatchClaim.identity, authority: result.dispatchClaim.authority,
    providerRequestDigest: result.dispatchClaim.phases.shopify_mutation.requestDigest, repeatProviderSubmissions: 0 };
}

// These same controls run against the accepted base in the recorded baseline
// proof. They establish the expected legacy producer bytes independently of
// the compatibility helper before any storage order transformation is applied.
for (const family of CONTENT_FAMILIES) for (const consent of CONTENT_CONSENTS) {
  test(`original producer byte control / ${family} / ${consent}`, { timeout: 30000 }, async t => {
    const f = await contentJsonbFixture({ family, consent, reorder: pg.roundtrip, cold: false, storageOrder: false });
    t.diagnostic(JSON.stringify({ ...(await assertCompleted(f, { storageOrder: false })), ordinaryProducerOrderControl: true }));
  });
}

for (const family of CONTENT_FAMILIES) for (const consent of CONTENT_CONSENTS) {
  test(`real JSONB full storage roundtrip / ${family} / ${consent}`, { timeout: 120000 }, async t => {
    const start = pg.casts.length;
    const f = await contentJsonbFixture({ family, consent, reorder: pg.roundtrip });
    const summary = await assertCompleted(f);
    assert.ok(pg.casts.length > start);
    // Store primary PATCH returns workspace_id; its save API returns its local
    // upgraded snapshot. This ordinary case never fabricates a database echo.
    t.diagnostic(JSON.stringify({ ...summary, ack: 'real adapter local snapshot, primary workspace_id only', casts: pg.casts.length - start }));
  });

  test(`real JSONB plus synthetic reordered ACK and private guard / ${family} / ${consent}`, { timeout: 120000 }, async t => {
    const start = pg.casts.length;
    const f = await contentJsonbFixture({ family, consent, reorder: pg.roundtrip, ackOrder: true, privateOrder: true });
    const summary = await assertCompleted(f);
    assert.equal(f.counts.privateChecks, 6, 'Supported content must run both private save checks at all three saves');
    t.diagnostic(JSON.stringify({ ...summary, ack: 'synthetic returned snapshot reordered by actual JSONB', casts: pg.casts.length - start }));
  });
}

for (const family of CONTENT_FAMILIES) for (const boundary of [1, 2]) {
  test(`real JSONB isolated narrow read ${boundary} / ${family}`, { timeout: 120000 }, async t => {
    const f = await contentJsonbFixture({ family, consent: 'settings', reorder: pg.roundtrip, cold: false, storageOrder: false });
    let reordered = false;
    f.hooks.fresh = (snapshot, number) => {
      if (number !== boundary) return snapshot;
      const result = pg.roundtrip(snapshot);
      assert.notDeepEqual(Object.keys(result.connectionWrites[0].input), Object.keys(f.write.input));
      reordered = true;
      return result;
    };
    const summary = await assertCompleted(f, { storageOrder: false });
    assert.equal(reordered, true);
    t.diagnostic(JSON.stringify({ ...summary, isolatedNarrowRead: boundary }));
  });
}
