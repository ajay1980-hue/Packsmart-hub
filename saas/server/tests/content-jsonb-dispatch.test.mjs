import test from 'node:test';
import assert from 'node:assert/strict';
import { executeConnectionWrite, readObjectiveContentRequest } from '../lib/connection-writes.mjs';
import { reviewedActionClaimIdentity, sourceActionFromRecordedContext } from '../lib/reviewed-action-evidence.mjs';
import { upsertBusinessObjective } from '../lib/business-objectives.mjs';
import { contentJsonbFixture, CONTENT_FAMILIES, CONTENT_CONSENTS, CONTENT_WORKSPACE, CONTENT_PRODUCT,
  CONTENT_TITLE, CONTENT_DESCRIPTION, jsonbOrder, reverseObjectOrder, fingerprint } from './content-jsonb-test-fixture.mjs';

async function blocked(f, mutations = 0) {
  const result = await f.run().catch(error => error);
  assert.notEqual(result?.status, 'completed', 'A changed authority/request must not complete');
  assert.ok(result instanceof Error || ['failed', 'uncertain'].includes(result?.status), 'Rejection must be explicit');
  assert.equal(f.counts.mutations, mutations, 'No extra provider mutation may be submitted');
  return result;
}

async function completed(f) {
  const result = await f.run();
  assert.equal(result.status, 'completed', result.errorCode);
  assert.equal(f.counts.mutations, 1); assert.equal(f.counts.credentials, 1);
  assert.equal(f.counts.saves, 3); assert.equal(f.counts.fresh, 2);
  assert.equal(f.counts.job, f.family === 'objective-v2' ? 3 : 0);
  assert.deepEqual(f.trace.filter(event => !event.startsWith('job:')),
    ['credentials', 'save:1', 'fresh:1', 'save:2', 'fresh:2', 'provider', 'save:3']);
  assert.equal(f.expected.inputText, JSON.stringify({ productId: CONTENT_PRODUCT, operation: 'product_content',
    title: CONTENT_TITLE, description: CONTENT_DESCRIPTION }));
  assert.equal(result.digest, f.expected.inputDigest);
  assert.equal(result.dispatchClaim.identity, f.expected.identity);
  assert.equal(result.dispatchClaim.authority, f.expected.authority);
  assert.equal(result.dispatchClaim.phases.shopify_mutation.requestDigest, f.expected.requestDigest);
  assert.equal(result.dispatchClaim.phases.shopify_mutation.status, 'dispatching', 'Existing phase representation stays unchanged');
  assert.equal(f.requests[0].body, f.expected.request.body, 'Provider body remains exact original producer bytes');
  assert.equal(f.requests[0].url, f.expected.request.url);
  assert.equal(f.requests[0].method, f.expected.request.method);
  for (const saved of f.saves) {
    assert.equal(saved.connectionWrites[0].dispatchClaim.id, result.dispatchClaim.id);
    assert.equal(saved.connectionWrites[0].dispatchClaim.identity, f.expected.identity);
    assert.equal(saved.connectionWrites[0].dispatchClaim.authority, f.expected.authority);
  }
  assert.deepEqual(f.saves.map(snapshot => snapshot.connectionWrites[0].status), ['executing', 'executing', 'completed']);
  assert.equal(f.saves[0].connectionWrites[0].dispatchClaim.phases.shopify_mutation, undefined);
  assert.equal(f.saves[1].connectionWrites[0].dispatchClaim.phases.shopify_mutation.status, 'dispatching');
  assert.equal(f.saves[2].connectionWrites[0].dispatchClaim.phases.shopify_mutation.status, 'dispatching');
  assert.equal(new Set(f.saves.map(snapshot => snapshot._revision)).size, 3);
  for (let i = 0; i < 2; i++) {
    assert.equal(f.contexts[i].revision, f.saves[i]._revision);
    assert.equal(f.contexts[i].writeId, f.write.id);
    assert.deepEqual(Object.keys(f.contexts[i]).sort(), ['revision', 'provider', 'writeId', 'connectionId', 'actorId',
      'approverId', 'approvalId', 'writeIndex', 'connectionIndex', 'actorIndex', 'approverIndex', 'approvalIndex'].sort());
  }
  if (f.family === 'objective-v2') {
    assert.equal(result.recordedActionContext, undefined);
    assert.equal(result.recordedActionUnavailable, 'objective_origin_unsupported');
  } else {
    const source = sourceActionFromRecordedContext(result, CONTENT_WORKSPACE);
    assert.equal(reviewedActionClaimIdentity(source.input, source.context), f.expected.identity,
      'Existing manual v1 evidence validator and identity remain compatible');
    assert.equal(result.recordedActionUnavailable, undefined);
  }
  const cold = await f.coldHistory();
  assert.equal(cold.history.found, true); assert.equal(cold.history.request.status, 'completed');
  assert.equal(cold.history.request.id, result.id); assert.deepEqual(cold.history.request.input, result.input);
  const durable = structuredClone(f.database.states.get(CONTENT_WORKSPACE));
  const prior = { ...f.counts };
  const replay = await executeConnectionWrite(cold.state, result.id, f.session.userId, f.service, f.persist,
    { durableStore: true, actorSession: f.session, loadObjectiveJob: f.loadJob, loadFreshState: f.loadFreshState });
  assert.equal(replay.status, 'completed'); assert.deepEqual(f.counts, prior);
  assert.deepEqual(f.database.states.get(CONTENT_WORKSPACE), durable, 'Cold completed history never rewrites claims or evidence');
  return result;
}

test('all known producer families preserve original bytes through cold JSONB, both narrow reads, private/ACK copies and exact cold history', async t => {
  for (const family of CONTENT_FAMILIES) for (const consent of CONTENT_CONSENTS) await t.test(`${family}:${consent}`, async () => {
    const f = await contentJsonbFixture({ family, consent, privateOrder: true, ackOrder: true });
    assert.notEqual(JSON.stringify(f.write.input), f.expected.inputText, 'Fixture must actually erase original key order');
    assert.deepEqual(f.write.input, f.before.connectionWrites[0].input);
    await completed(f);
  });
});

test('each isolated ordering boundary succeeds without needing another boundary to normalize it', async t => {
  for (const family of CONTENT_FAMILIES) for (const boundary of ['cold', 'narrow:1', 'narrow:2', 'private', 'ack:1', 'ack:2', 'ack:3']) {
    await t.test(`${family}:${boundary}`, async () => {
      const f = await contentJsonbFixture({ family, consent: 'settings', cold: boundary === 'cold',
        storageOrder: boundary === 'cold', privateOrder: boundary === 'private', reorder: reverseObjectOrder });
      if (boundary.startsWith('narrow:')) f.hooks.fresh = (snapshot, count) => count === Number(boundary.slice(-1)) ? reverseObjectOrder(snapshot) : snapshot;
      if (boundary.startsWith('ack:')) f.hooks.ack = (snapshot, count) => {
        if (count !== Number(boundary.slice(-1))) return;
        for (const key of ['connectionWrites', 'approvals', 'connectionSettings']) snapshot[key] = reverseObjectOrder(snapshot[key]);
      };
      await completed(f);
    });
  }
});

test('objective preparation accepts order-only private and synthetic ACK snapshots before the complete dispatch flow', async t => {
  for (const consent of CONTENT_CONSENTS) await t.test(consent, async () => {
    const f = await contentJsonbFixture({ family: 'objective-v2', consent, preparePrivateOrder: true,
      prepareAckOrder: true, ackOrder: true, privateOrder: true });
    assert.equal(f.preparation.saves, 1); assert.equal(f.preparation.privateChecks, 2);
    await completed(f);
  });
});

test('nested input, proposal, policy, source, payload and consent order recover independently', async t => {
  for (const family of CONTENT_FAMILIES) {
    const targets = ['input', 'write', 'approval', 'payload', 'consent',
      ...(family !== 'manual' ? ['proposal', 'policies'] : []), ...(family === 'objective-v2' ? ['source'] : [])];
    for (const target of targets) await t.test(`${family}:${target}`, async () => {
      const reorder = value => {
        const snapshot = structuredClone(value), write = snapshot.connectionWrites?.[0], approval = snapshot.approvals?.[0];
        if (target === 'write' && write) snapshot.connectionWrites[0] = reverseObjectOrder(write);
        if (target === 'input' && write) write.input = reverseObjectOrder(write.input);
        if (target === 'approval' && approval) snapshot.approvals[0] = reverseObjectOrder(approval);
        if (target === 'payload' && approval) approval.payload = reverseObjectOrder(approval.payload);
        if (target === 'consent' && snapshot.connectionSettings?.shopify?.consent) snapshot.connectionSettings.shopify.consent = reverseObjectOrder(snapshot.connectionSettings.shopify.consent);
        if (target === 'proposal' && write?.objectivePolicyProposal) write.objectivePolicyProposal = reverseObjectOrder(write.objectivePolicyProposal);
        if (target === 'policies' && write?.objectivePolicyProposal) write.objectivePolicyProposal.policies = reverseObjectOrder(write.objectivePolicyProposal.policies);
        if (target === 'source' && write?.objectivePolicyProposal?.source) write.objectivePolicyProposal.source = reverseObjectOrder(write.objectivePolicyProposal.source);
        return snapshot;
      };
      await completed(await contentJsonbFixture({ family, consent: 'settings', reorder, ackOrder: true, privateOrder: true }));
    });
  }
});

const mutationCases = {
  'input-value': state => { state.connectionWrites[0].input.title += ' changed'; },
  'input-key': state => { state.connectionWrites[0].input.extra = true; },
  'input-missing': state => { delete state.connectionWrites[0].input.description; },
  'input-null': state => { state.connectionWrites[0].input.title = null; },
  'input-type': state => { state.connectionWrites[0].input.description = 1; },
  request: state => { state.connectionWrites[0].requestId += '_changed'; },
  approvalRequired: state => { state.connectionWrites[0].requiresApproval = false; },
  approval: state => { state.approvals[0].status = 'rejected'; },
  'approval-revision': state => { state.approvals[0].revision = 2; },
  'approval-decider': state => { state.approvals[0].decidedBy = 'another-owner'; },
  'approval-payload': state => { state.approvals[0].payload.extra = null; },
  'owner-active': state => { state.users[0].active = false; },
  'owner-role': state => { state.users[0].role = 'viewer'; },
  'owner-session': state => { state.users[0].sessionVersion = 2; },
  'owner-password': state => { state.users[0].passwordChangeRequired = true; },
  account: state => { state.connections[0].metadata.shopDomain = 'changed.myshopify.com'; },
  credentials: state => { state.connections[0].encryptedCredentials = 'replacement-credential'; },
  scopes: state => { state.connections[0].metadata.grantedScopes = ['read_products']; },
  consent: state => { state.connectionSettings.shopify.consent.actor = 'another-owner'; },
  'nested-tenant': state => { state.approvals[0].payload.tenant = { id: CONTENT_WORKSPACE, nested: { tenant_id: 'another-workspace' } }; }
};

test('real value, key, type, owner and authority changes reject at credential, ACK and both narrow boundaries after JSONB', async t => {
  for (const family of CONTENT_FAMILIES) for (const boundary of ['credentials', 'ack', 'narrow:1', 'narrow:2']) {
    for (const [name, mutate] of Object.entries(mutationCases)) await t.test(`${family}:${boundary}:${name}`, async () => {
      const f = await contentJsonbFixture({ family, consent: 'settings', ackOrder: true });
      if (boundary === 'credentials') f.hooks.credentials = mutate;
      if (boundary === 'ack') f.hooks.ack = (saved, number) => { if (number === 1) mutate(saved); };
      if (boundary.startsWith('narrow:')) f.hooks.fresh = (snapshot, number) => {
        if (number === Number(boundary.slice(-1))) mutate(snapshot);
      };
      await blocked(f);
      if (boundary === 'credentials') assert.equal(f.counts.saves, 0);
    });
  }
});

test('v2 admission and both source observations retain request values across awaited job reads', async t => {
  for (const phase of [1, 2, 3]) for (const [name, mutate] of Object.entries(mutationCases)) await t.test(`${phase}:${name}`, async () => {
    const f = await contentJsonbFixture({ family: 'objective-v2', consent: 'settings', ackOrder: true });
    f.hooks.job = number => { if (number === phase) mutate(f.state); };
    await blocked(f);
    if (phase === 1) assert.equal(f.counts.credentials, 0);
  });
});

test('private pre-commit snapshots cannot replace original write or approval values', async t => {
  for (const family of CONTENT_FAMILIES) for (const [name, mutate] of Object.entries(mutationCases)) await t.test(`${family}:${name}`, async () => {
    const f = await contentJsonbFixture({ family, consent: 'settings', privateOrder: true });
    const before = structuredClone(f.database.states.get(CONTENT_WORKSPACE));
    let reached = false;
    f.hooks.beforeCommit = (snapshot, number, live) => {
      if (number === 1 && !live) { reached = true; mutate(snapshot); }
    };
    await blocked(f);
    assert.equal(reached, true, 'Supported content must guard its actual private store snapshot');
    assert.deepEqual(f.database.states.get(CONTENT_WORKSPACE), before, 'Changed private authority cannot reach CAS');
  });
});

test('returned copies cannot hide live request mutations during an awaited save or narrow read', async t => {
  for (const family of CONTENT_FAMILIES) for (const boundary of ['save', 'narrow:1', 'narrow:2']) await t.test(`${family}:${boundary}`, async () => {
    const f = await contentJsonbFixture({ family, consent: 'settings', ackOrder: true });
    if (boundary === 'save') f.hooks.ack = (saved, number) => { if (number === 1) f.write.input.description += ' live mutation'; };
    else f.hooks.fresh = (fresh, number) => { if (number === Number(boundary.slice(-1))) f.write.requestId += '_live'; };
    await blocked(f);
  });
});

test('supported family remains pinned when an awaited mutation changes schema, origin or signed layout', async t => {
  for (const family of CONTENT_FAMILIES) for (const change of ['extra', 'remove-proposal', 'null-proposal', 'schema', 'origin']) await t.test(`${family}:${change}`, async () => {
    const f = await contentJsonbFixture({ family, consent: 'settings' });
    f.hooks.credentials = () => {
      if (change === 'extra') f.write.input.tenantId = CONTENT_WORKSPACE;
      if (change === 'remove-proposal') {
        if (family === 'manual') f.write.objectivePolicyProposal = {};
        else delete f.write.objectivePolicyProposal;
      }
      if (change === 'null-proposal') f.write.objectivePolicyProposal = null;
      if (change === 'schema') f.write.objectivePolicyProposal = { ...f.write.objectivePolicyProposal, schema: 'runvara-objective-dispatch-proposal/v999' };
      if (change === 'origin') f.write.objectivePolicyProposal = { ...f.write.objectivePolicyProposal, origin: 'owner_manual' === f.write.objectivePolicyProposal?.origin ? 'owner_objective_content' : 'owner_manual' };
    };
    await blocked(f);
  });
});

test('matching signed scope extras remain on the original legacy path and cannot be silently projected away', async t => {
  for (const reordered of [false, true]) await t.test(reordered ? 'legacy-order-damage-rejects' : 'legacy-original-order-completes', async () => {
    const f = await contentJsonbFixture({ cold: reordered, storageOrder: reordered, initialChange: state => {
      const write = state.connectionWrites[0], approval = state.approvals[0];
      for (const value of [state, state.workspace, write, write.input, approval, approval.payload, state.users[0], state.connections[0], state.connections[0].metadata]) {
        Object.assign(value, { workspaceId: CONTENT_WORKSPACE, workspace_id: CONTENT_WORKSPACE, tenantId: CONTENT_WORKSPACE,
          tenant_id: CONTENT_WORKSPACE, tenant: { id: CONTENT_WORKSPACE } });
      }
      write.digest = fingerprint(write.input); approval.payload.digest = write.digest;
    } });
    if (reordered) await blocked(f);
    else {
      const result = await f.run(); assert.equal(result.status, 'completed'); assert.equal(f.counts.mutations, 1);
      assert.equal(result.dispatchClaim.identity, f.expected.identity); assert.equal(result.dispatchClaim.authority, f.expected.authority);
      assert.equal(result.input.tenant_id, CONTENT_WORKSPACE);
    }
  });
});

test('unknown signed consent and payload fields pin the entire request to legacy comparisons', async t => {
  for (const extra of ['consent', 'payload']) for (const orderDamage of [false, true]) await t.test(`${extra}:${orderDamage}`, async () => {
    const f = await contentJsonbFixture({ consent: 'settings', cold: false, storageOrder: false,
      initialChange: state => {
        const target = extra === 'consent' ? state.connectionSettings.shopify.consent : state.approvals[0].payload;
        target.legacyContext = { retained: 'Unknown signed data', list: ['first', 'second'] };
      } });
    if (orderDamage) {
      // Changing only input order must still fail: selecting compatibility for
      // just that component would partially normalize an unsupported family.
      f.hooks.fresh = snapshot => { snapshot.connectionWrites[0].input = reverseObjectOrder(snapshot.connectionWrites[0].input); };
      await blocked(f);
    } else {
      const result = await f.run(); assert.equal(result.status, 'completed'); assert.equal(f.counts.mutations, 1);
      assert.equal(result.dispatchClaim.identity, f.expected.identity);
      assert.equal(result.dispatchClaim.authority, f.expected.authority);
    }
  });
});

test('required approval is never inferred from automatic consent, pending status or a malformed approval requirement', async t => {
  for (const family of CONTENT_FAMILIES) for (const variant of ['pending', 'missing-approval', 'false-requirement', 'missing-requirement']) await t.test(`${family}:${variant}`, async () => {
    const f = await contentJsonbFixture({ family, consent: 'settings' });
    if (variant === 'pending') { f.write.status = 'pending_approval'; f.state.approvals[0].status = 'pending'; }
    if (variant === 'missing-approval') f.state.approvals = [];
    if (variant === 'false-requirement') f.write.requiresApproval = false;
    if (variant === 'missing-requirement') delete f.write.requiresApproval;
    await blocked(f);
  });
});

test('a request’s own approved decision remains valid, and a different approval cannot borrow its source exception', async t => {
  for (const family of ['manual-v1-policy', 'objective-v2']) await t.test(family, async () => {
    const f = await contentJsonbFixture({ family });
    // Successful complete fixtures use the owner’s own exact approved request;
    // there must be no newly introduced blanket ban on that decision.
    assert.equal(f.state.approvals[0].decidedBy, f.write.requestedBy);
    await completed(f);
  });
  const f = await contentJsonbFixture({ family: 'objective-v2' });
  f.state.approvals.push({ ...structuredClone(f.state.approvals[0]), id: 'foreign-approval', status: 'pending' });
  await f.store.save(CONTENT_WORKSPACE, f.state);
  await blocked(f); assert.equal(f.counts.credentials, 0);
});

test('terminal statuses and previously claimed phases never replay after JSONB', async t => {
  for (const family of CONTENT_FAMILIES) for (const status of ['executing', 'failed', 'uncertain', 'rejected', 'completed']) await t.test(`${family}:${status}`, async () => {
    const f = await contentJsonbFixture({ family });
    f.write.status = status;
    const before = structuredClone(f.write);
    const result = await f.run().catch(error => error);
    if (status === 'completed') assert.equal(result.status, 'completed');
    else assert.equal(result.code, 'WRITE_ALREADY_ATTEMPTED');
    assert.deepEqual(f.write, before); assert.equal(f.counts.mutations, 0); assert.equal(f.counts.credentials, 0); assert.equal(f.counts.saves, 0);
  });
  for (const family of CONTENT_FAMILIES) for (const status of ['ready', 'pending_approval', 'processing'])
    for (const phase of ['dispatching', 'completed', 'uncertain']) await t.test(`${family}:${status}:phase:${phase}`, async () => {
    const f = await contentJsonbFixture({ family });
    f.write.status = status;
    f.write.dispatchClaim = { id: 'existing_claim', workspaceId: CONTENT_WORKSPACE,
      identity: f.expected.identity, authority: f.expected.authority,
      phases: { shopify_mutation: { requestDigest: f.expected.requestDigest, status: phase, at: new Date().toISOString() } } };
    await f.store.save(CONTENT_WORKSPACE, f.state);
    await blocked(f);
    assert.equal(f.write.dispatchClaim.id, 'existing_claim');
    assert.equal(f.write.dispatchClaim.phases.shopify_mutation.status, phase);
    await blocked(f); assert.equal(f.counts.mutations, 0);
  });
});

test('an eligible matching existing claim preserves its ID and original fingerprints', async t => {
  for (const family of CONTENT_FAMILIES) await t.test(family, async () => {
    const f = await contentJsonbFixture({ family, privateOrder: true, ackOrder: true });
    f.write.dispatchClaim = { id: 'original_claim_id', workspaceId: CONTENT_WORKSPACE,
      identity: f.expected.identity, authority: f.expected.authority, phases: {} };
    await f.store.save(CONTENT_WORKSPACE, f.state);
    const result = await completed(f);
    assert.equal(result.dispatchClaim.id, 'original_claim_id');
  });
});

test('saved claim fingerprints and workspace cannot be relabelled to recover a mismatch', async t => {
  for (const family of CONTENT_FAMILIES) for (const field of ['identity', 'authority', 'workspaceId']) await t.test(`${family}:${field}`, async () => {
    const f = await contentJsonbFixture({ family });
    f.write.dispatchClaim = { id: 'saved_claim', workspaceId: CONTENT_WORKSPACE,
      identity: f.expected.identity, authority: f.expected.authority, phases: {} };
    f.write.dispatchClaim[field] = 'mismatched';
    const before = structuredClone(f.write.dispatchClaim);
    await blocked(f); assert.deepEqual(f.write.dispatchClaim, before); assert.equal(f.counts.saves, 0);
  });
});

test('two cold JSONB replicas cannot both claim and submit the same request', async t => {
  for (const family of CONTENT_FAMILIES) await t.test(family, async () => {
    const f = await contentJsonbFixture({ family, consent: 'settings', ackOrder: true });
    const secondState = await f.replica.get(CONTENT_WORKSPACE);
    const second = () => executeConnectionWrite(secondState, f.write.id, f.session.userId, f.service,
      options => f.replica.save(CONTENT_WORKSPACE, secondState, options), { durableStore: true, actorSession: f.session,
        loadObjectiveJob: f.loadJob, loadFreshState: input => f.replica.getConnectionWriteContext(CONTENT_WORKSPACE, input) });
    const results = await Promise.allSettled([f.run(), second()]);
    assert.equal(f.counts.mutations, 1);
    assert.equal(results.filter(row => row.status === 'fulfilled' && row.value.status === 'completed').length, 1);
    assert.equal(f.database.states.get(CONTENT_WORKSPACE).connectionWrites[0].status, 'completed');
  });
});

test('a competing revision observed after each source await blocks dispatch and cannot be overwritten', async t => {
  for (const sourcePhase of [2, 3]) await t.test(String(sourcePhase), async () => {
    const f = await contentJsonbFixture({ family: 'objective-v2', ackOrder: true });
    let competing;
    f.hooks.job = async count => {
      if (count !== sourcePhase) return;
      const other = await f.replica.get(CONTENT_WORKSPACE); other.users[0].active = false;
      await f.replica.save(CONTENT_WORKSPACE, other);
      competing = structuredClone(f.database.states.get(CONTENT_WORKSPACE));
    };
    await blocked(f);
    assert.equal(f.counts.fresh, sourcePhase - 1, 'The revision-guarded context read remains after the exact source observation');
    assert.deepEqual(f.database.states.get(CONTENT_WORKSPACE), competing, 'Failed request cannot overwrite the competing revision');
  });
});

test('row uniqueness and retained live object membership remain significant after order-only repair', async t => {
  for (const family of CONTENT_FAMILIES) for (const boundary of ['credentials', 'ack', 'narrow:1', 'narrow:2'])
    for (const kind of ['duplicate-write', 'duplicate-approval', 'live-write-replacement', 'live-approval-replacement']) await t.test(`${family}:${boundary}:${kind}`, async () => {
      const f = await contentJsonbFixture({ family, ackOrder: true });
      const mutate = snapshot => {
        if (kind === 'duplicate-write') snapshot.connectionWrites.push(structuredClone(snapshot.connectionWrites[0]));
        if (kind === 'duplicate-approval') snapshot.approvals.push(structuredClone(snapshot.approvals[0]));
        if (kind === 'live-write-replacement') f.state.connectionWrites = f.state.connectionWrites.map(row => structuredClone(row));
        if (kind === 'live-approval-replacement') f.state.approvals = f.state.approvals.map(row => structuredClone(row));
      };
      if (boundary === 'credentials') f.hooks.credentials = mutate;
      if (boundary === 'ack') f.hooks.ack = (snapshot, count) => { if (count === 1) mutate(snapshot); };
      if (boundary.startsWith('narrow:')) f.hooks.fresh = (snapshot, count) => { if (count === Number(boundary.slice(-1))) mutate(snapshot); };
      await blocked(f);
    });
});

test('known rejection, transport ambiguity and lost final ACK remain unreplayable across cold JSONB loads', async t => {
  for (const family of CONTENT_FAMILIES) for (const mode of ['rejected', 'unknown', 'lost-final']) await t.test(`${family}:${mode}`, async () => {
    const f = await contentJsonbFixture({ family, ackOrder: true });
    if (mode === 'rejected') f.hooks.fetch = () => Response.json({ data: { productUpdate: { product: null,
      userErrors: [{ field: 'title', message: 'synthetic rejection' }] } } });
    if (mode === 'unknown') f.hooks.fetch = () => { throw new Error('synthetic transport ambiguity'); };
    if (mode === 'lost-final') f.hooks.ack = (snapshot, count) => { if (count === 3) throw new Error('lost final ACK'); };
    const result = await f.run().catch(error => error);
    if (mode === 'rejected') assert.equal(result.status, 'failed');
    if (mode === 'unknown') assert.equal(result.status, 'uncertain');
    if (mode === 'lost-final') assert.ok(result instanceof Error);
    assert.equal(f.counts.mutations, 1);
    const { state, history } = await f.coldHistory();
    assert.equal(history.request.status, mode === 'lost-final' ? 'completed' : mode === 'rejected' ? 'failed' : 'uncertain');
    const claim = structuredClone(state.connectionWrites[0].dispatchClaim);
    await executeConnectionWrite(state, f.write.id, f.session.userId, f.service, f.persist,
      { durableStore: true, actorSession: f.session, loadObjectiveJob: f.loadJob, loadFreshState: f.loadFreshState }).catch(error => error);
    assert.equal(f.counts.mutations, 1); assert.deepEqual(state.connectionWrites[0].dispatchClaim, claim);
  });
});

test('final revision conflict preserves competing workspace and the known local result without provider replay', async () => {
  const f = await contentJsonbFixture({ family: 'objective-v2', ackOrder: true });
  f.hooks.fetch = async () => {
    const other = await f.replica.get(CONTENT_WORKSPACE); other.products = [];
    await f.replica.save(CONTENT_WORKSPACE, other);
  };
  await assert.rejects(f.run, error => error.code === 'STATE_CONFLICT');
  assert.equal(f.write.status, 'completed'); assert.equal(f.counts.mutations, 1);
  const { state } = await f.coldHistory();
  assert.deepEqual(state.products, []); assert.equal(state.connectionWrites[0].status, 'executing');
  assert.equal(state.connectionWrites[0].dispatchClaim.phases.shopify_mutation.status, 'dispatching');
  await executeConnectionWrite(state, f.write.id, f.session.userId, f.service, f.persist,
    { durableStore: true, actorSession: f.session, loadObjectiveJob: f.loadJob, loadFreshState: f.loadFreshState }).catch(error => error);
  assert.equal(f.counts.mutations, 1);
});

test('known v2 success survives post-submission source and eligibility loss with reordered final snapshots', async t => {
  for (const change of ['product', 'job', 'owner', 'policy-expiry']) await t.test(change, async () => {
    const f = await contentJsonbFixture({ family: 'objective-v2', privateOrder: true, ackOrder: true });
    const originalNow = Date.now;
    f.hooks.fetch = () => {
      if (change === 'product') f.state.products = [];
      if (change === 'job') f.database.tables.set('runvara_agent_jobs', []);
      if (change === 'owner') f.state.users[0].active = false;
      if (change === 'policy-expiry') Date.now = () => Date.parse(f.state.businessObjectives[0].endsAt) + 1;
    };
    try {
      const result = await f.run(); assert.equal(result.status, 'completed'); assert.equal(f.counts.mutations, 1);
      assert.equal(f.database.states.get(CONTENT_WORKSPACE).connectionWrites[0].status, 'completed');
      assert.equal((await f.run()).status, 'completed'); assert.equal(f.counts.mutations, 1);
      if (['product', 'job'].includes(change)) {
        const cold = await f.coldHistory(); assert.equal(cold.history.request.status, 'completed');
        assert.notEqual(cold.history.sourceStatus.status, 'current');
      }
    } finally { Date.now = originalNow; }
  });
});

test('post-submission immutable decision, claim and admission substitutions still reject despite reordered snapshots', async t => {
  for (const boundary of ['provider', 'private', 'ack']) for (const field of
    ['approval', 'claim', 'admissions', 'input', ...(boundary === 'provider' ? [] : ['result', 'context'])]) await t.test(`${boundary}:${field}`, async () => {
    const f = await contentJsonbFixture({ family: 'objective-v2', privateOrder: true, ackOrder: true });
    const mutate = snapshot => {
      if (field === 'approval') snapshot.approvals[0].decisionNote = 'substituted decision';
      if (field === 'claim') snapshot.connectionWrites[0].dispatchClaim.id = 'substituted_claim';
      if (field === 'admissions') snapshot.connectionDispatchAdmissions = [];
      if (field === 'input') snapshot.connectionWrites[0].input.title = 'substituted input';
      if (field === 'result') snapshot.connectionWrites[0].result = { externalId: 'gid://shopify/Product/999' };
      if (field === 'context') snapshot.connectionWrites[0].recordedActionContext = { schema: 'forged-evidence' };
    };
    if (boundary === 'provider') {
      f.hooks.fetch = () => mutate(f.state);
    }
    if (boundary === 'private') f.hooks.beforeCommit = (snapshot, count, live) => { if (count === 3 && !live) mutate(snapshot); };
    if (boundary === 'ack') f.hooks.ack = (snapshot, count) => { if (count === 3) mutate(snapshot); };
    await assert.rejects(f.run); assert.equal(f.counts.mutations, 1);
  });
});

test('all known families reject actual result and optional evidence replacement at final private and ACK boundaries', async t => {
  for (const family of CONTENT_FAMILIES) for (const boundary of ['private', 'ack', 'live-save'])
    for (const field of ['result', 'context']) await t.test(`${family}:${boundary}:${field}`, async () => {
      const f = await contentJsonbFixture({ family, privateOrder: true, ackOrder: true });
      const mutate = snapshot => {
        const write = snapshot.connectionWrites[0];
        if (field === 'result') write.result = { externalId: 'gid://shopify/Product/999' };
        else write.recordedActionContext = { schema: 'substituted-context', workspaceId: CONTENT_WORKSPACE };
      };
      if (boundary === 'private') f.hooks.beforeCommit = (snapshot, count, live) => { if (count === 3 && !live) mutate(snapshot); };
      if (boundary === 'ack') f.hooks.ack = (snapshot, count) => { if (count === 3) mutate(snapshot); };
      if (boundary === 'live-save') f.hooks.persist = count => { if (count === 3) mutate(f.state); };
      await assert.rejects(f.run); assert.equal(f.counts.mutations, 1);
      const cold = await f.coldHistory();
      assert.notEqual(cold.state.connectionWrites[0].result?.externalId, 'gid://shopify/Product/999');
      assert.notEqual(cold.state.connectionWrites[0].recordedActionContext?.schema, 'substituted-context');
      if (boundary === 'ack') assert.equal(cold.history.request.status, 'completed', 'A forged returned copy cannot erase a correctly committed known result');
    });
});

test('policy, approval-history and admission arrays preserve order, length and scalar identity', async t => {
  const addPolicy = state => {
    const first = state.businessObjectives[0];
    upsertBusinessObjective(state, { title: 'Second exact content restriction', metric: first.metric,
      baseline: first.baseline, target: first.target, direction: first.direction, startsAt: first.startsAt,
      endsAt: first.endsAt, limits: first.limits, executionPolicy: first.executionPolicy }, { actorId: state.users[0].id });
  };
  for (const family of ['manual-v1-policy', 'objective-v2']) await t.test(`two-policies:${family}:valid`, async () => {
    const f = await contentJsonbFixture({ family, seedChange: addPolicy, privateOrder: true, ackOrder: true });
    assert.equal(f.write.objectivePolicyProposal.policies.length, 2);
    await completed(f);
  });
  for (const family of ['manual-v1-policy', 'objective-v2']) for (const mutation of ['reverse', 'remove', 'duplicate']) await t.test(`policies:${family}:${mutation}`, async () => {
    const f = await contentJsonbFixture({ family, seedChange: addPolicy });
    assert.equal(f.write.objectivePolicyProposal.policies.length, 2);
    f.hooks.credentials = () => {
      const policies = f.write.objectivePolicyProposal.policies;
      if (mutation === 'reverse') policies.reverse();
      if (mutation === 'remove') policies.pop();
      if (mutation === 'duplicate') policies.push(structuredClone(policies[0]));
    };
    await blocked(f);
  });
  for (const family of CONTENT_FAMILIES) for (const boundary of ['credentials', 'private', 'ack']) for (const mutation of ['reverse', 'type', 'remove']) {
    await t.test(`admissions:${family}:${boundary}:${mutation}`, async () => {
      const f = await contentJsonbFixture({ family, privateOrder: true, ackOrder: true,
        initialChange: state => { state.connectionDispatchAdmissions = [Date.now() - 10000, Date.now() - 5000]; } });
      const mutate = state => {
        const values = [...state.connectionDispatchAdmissions];
        if (mutation === 'reverse') values.reverse();
        if (mutation === 'type') values[0] = String(values[0]);
        if (mutation === 'remove') values.pop();
        state.connectionDispatchAdmissions = values;
      };
      if (boundary === 'credentials') f.hooks.credentials = mutate;
      if (boundary === 'private') f.hooks.beforeCommit = (snapshot, count, live) => { if (count === 1 && !live) mutate(snapshot); };
      if (boundary === 'ack') f.hooks.ack = (snapshot, count) => { if (count === 1) mutate(snapshot); };
      await blocked(f);
    });
  }
  for (const boundary of ['credentials', 'narrow:1', 'narrow:2', 'provider']) await t.test(`approval-history:${boundary}`, async () => {
    const f = await contentJsonbFixture({ family: 'objective-v2' });
    const mutate = state => { state.approvals[0].history.push({ ...state.approvals[0].history[0], note: 'additional decision' }); };
    if (boundary === 'credentials') f.hooks.credentials = mutate;
    if (boundary.startsWith('narrow:')) f.hooks.fresh = (snapshot, count) => { if (count === Number(boundary.slice(-1))) mutate(snapshot); };
    if (boundary === 'provider') f.hooks.fetch = () => mutate(f.state);
    await blocked(f, boundary === 'provider' ? 1 : 0);
  });
});

test('retained approval decision cannot mutate consistently behind captured copies during credentials, source or narrow awaits', async t => {
  for (const boundary of ['credentials', 'source:2', 'source:3', 'narrow:1', 'narrow:2']) await t.test(boundary, async () => {
    const f = await contentJsonbFixture({ family: 'objective-v2', ackOrder: true });
    const mutate = () => {
      f.state.approvals[0].decisionNote = 'A different decision recorded during await';
      f.state.approvals[0].history[0].note = f.state.approvals[0].decisionNote;
    };
    if (boundary === 'credentials') f.hooks.credentials = mutate;
    if (boundary.startsWith('source:')) f.hooks.job = count => { if (count === Number(boundary.slice(-1))) mutate(); };
    if (boundary.startsWith('narrow:')) f.hooks.fresh = (copy, count) => { if (count === Number(boundary.slice(-1))) mutate(); };
    await blocked(f);
  });
});

test('recursive tenant markers are validated in all retained authority objects before submission', async t => {
  const targets = {
    state: f => f.state, workspace: f => f.state.workspace, write: f => f.write, input: f => f.write.input,
    approval: f => f.state.approvals[0], payload: f => f.state.approvals[0].payload,
    owner: f => f.state.users[0], connection: f => f.state.connections[0], metadata: f => f.state.connections[0].metadata,
    settings: f => f.state.connectionSettings.shopify, consent: f => f.state.connectionSettings.shopify.consent,
    proposal: f => f.write.objectivePolicyProposal, policy: f => f.write.objectivePolicyProposal.policies[0],
    source: f => f.write.objectivePolicyProposal.source
  };
  for (const [name, target] of Object.entries(targets)) for (const depth of [0, 2, 5]) await t.test(`${name}:${depth}`, async () => {
    const f = await contentJsonbFixture({ family: 'objective-v2', consent: 'settings' });
    let value = target(f);
    for (let index = 0; index < depth; index++) { value.tenant = { id: CONTENT_WORKSPACE }; value = value.tenant; }
    value.tenant_id = 'different-workspace';
    await blocked(f); assert.equal(f.counts.credentials, 0); assert.equal(f.counts.saves, 0);
  });
});

test('JSONB source reads still reject absent jobs and changed job status, payload or report before dispatch', async t => {
  for (const phase of [1, 2, 3]) for (const change of ['absent', 'status', 'payload', 'report']) await t.test(`${phase}:${change}`, async () => {
    const f = await contentJsonbFixture({ family: 'objective-v2' });
    f.hooks.job = count => {
      if (count !== phase) return;
      if (change === 'absent') f.database.tables.set('runvara_agent_jobs', []);
      if (change === 'status') f.job.status = 'dead_letter';
      if (change === 'payload') f.job.payload.actorSessionVersion = 2;
      if (change === 'report') f.job.result.proposals[0].nextStep = 'replaced source report';
    };
    await blocked(f);
    if (phase === 1) assert.equal(f.counts.credentials, 0);
    if (phase === 3) assert.equal(f.write.dispatchClaim.phases.shopify_mutation.status, 'dispatching');
  });
});

test('non-JSON live snapshot values reject without executing accessors or silently discarding information', async t => {
  for (const shape of ['getter', 'symbol', 'undefined', 'nonfinite', 'cycle', 'sparse-array', 'decorated-array', 'prototype']) await t.test(shape, async () => {
    const f = await contentJsonbFixture({ family: 'objective-v2' });
    let getterCalls = 0;
    f.hooks.credentials = () => {
      const write = f.write;
      if (shape === 'getter') Object.defineProperty(write, 'extra', { enumerable: true, get() { getterCalls++; return 'ignored'; } });
      if (shape === 'symbol') write[Symbol('invisible')] = 'signed information';
      if (shape === 'undefined') write.extra = undefined;
      if (shape === 'nonfinite') write.extra = NaN;
      if (shape === 'cycle') write.extra = write;
      if (shape === 'sparse-array') write.extra = new Array(1);
      if (shape === 'decorated-array') { write.extra = []; write.extra.hidden = 'ignored by JSON.stringify'; }
      if (shape === 'prototype') write.extra = Object.create({ inherited: 'not ordinary JSON' });
    };
    await blocked(f); assert.equal(getterCalls, 0);
  });
});

test('order-only history await is accepted but real decision/request changes remain visible through retained copies', async t => {
  for (const mode of ['reorder', 'mutate']) await t.test(mode, async () => {
    const f = await contentJsonbFixture({ family: 'objective-v2' });
    const loadJob = async id => {
      const write = f.state.connectionWrites[0];
      if (mode === 'reorder') {
        write.input = reverseObjectOrder(write.input);
        write.objectivePolicyProposal = reverseObjectOrder(write.objectivePolicyProposal);
      } else write.input.description += ' changed';
      return f.store.getAgentJob(CONTENT_WORKSPACE, id, { includeReport: true });
    };
    if (mode === 'reorder') {
      const result = await readObjectiveContentRequest(f.state, f.body.requestId, f.session, loadJob);
      assert.equal(result.found, true);
    } else await assert.rejects(readObjectiveContentRequest(f.state, f.body.requestId, f.session, loadJob));
    assert.equal(f.counts.mutations, 0);
  });
});
