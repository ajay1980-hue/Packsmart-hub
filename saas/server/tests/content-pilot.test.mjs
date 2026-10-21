import test from 'node:test';
import assert from 'node:assert/strict';
import { createContentPilot, assertContentPilotScope, assertContentPilotConfiguration, pauseContentPilot,
  assertContentProducerAdmission } from '../lib/content-pilot.mjs';
import { createGovernedRecordStage, assertGovernedRecordCreation, GOVERNED_RECORD_PRODUCER_CONTRACT } from '../lib/governed-record-stage.mjs';
import { executeConnectionWrite, proposeConnectionWrite } from '../lib/connection-writes.mjs';
import { contentPilotFixture } from './content-pilot-test-fixture.mjs';

test('exact pilot dispatch leaves the broad gate closed and retains byte-identical protected receipt evidence', async () => {
  const f = await contentPilotFixture({ family: 'manual-v1-policy' });
  assert.throws(() => assertGovernedRecordCreation(f.closedStage), { code: 'GOVERNED_RECORDS_PAUSED' });
  const result = await f.run();
  assert.equal(result.status, 'completed', result.errorCode);
  assert.equal(f.counts.mutations, 1); assert.equal(f.baselineReads.length, 1);
  assert.deepEqual(f.receiptCommits.map(c => c.kind), ['reserve', 'finalize']);
  assert.equal(f.requests[0].body, f.expected.request.body);
  assert.equal(f.receiptCommits[1].receipt.source.context.dispatchRequestDigest, f.expected.requestDigest);
  assert.equal(f.receiptCommits[1].receipt.source.input.title, f.scope.baseline.title);
  assert.throws(() => assertGovernedRecordCreation(f.closedStage), { code: 'GOVERNED_RECORDS_PAUSED' });
  await f.run(); assert.equal(f.counts.mutations, 1);
});

test('capability cannot be forged, copied, widened or combined with the broad producer gate', async () => {
  const f = await contentPilotFixture();
  for (const capability of [{}, { ...f.pilot }, structuredClone(f.pilot), f.scope, false]) {
    await assert.rejects(() => f.run({ contentPilot: capability }), { code: 'CONTENT_PILOT_INVALID' });
  }
  const open = createGovernedRecordStage({ GOVERNED_RECORD_PRODUCER_CONTRACT });
  assert.throws(() => assertContentPilotConfiguration(f.pilot, open), { code: 'CONTENT_PILOT_BROAD_GATE_OPEN' });
  await assert.rejects(() => f.run({ governedRecordStage: open }), { code: 'CONTENT_PILOT_BROAD_GATE_OPEN' });
  await assert.rejects(() => f.run({ protectedContentReceipts: null }), { code: 'CONTENT_PILOT_RECEIPT_REQUIRED' });
  assert.equal(f.counts.credentials, 0); assert.equal(f.counts.saves, 0); assert.equal(f.counts.mutations, 0);
  let read = false;
  assert.throws(() => createContentPilot({ ...f.scope, get account() { read = true; return 'other.myshopify.com'; } }));
  assert.equal(read, false);
});

test('scope binds every target and exact payload before credentials, persistence or provider access', async t => {
  const changes = {
    tenant: (s, w) => { s.workspace.id = 'other-workspace'; },
    account: (s, w) => { w.account = 'other.myshopify.com'; },
    connection: (s, w) => { w.connectionId = 'other-connection'; },
    product: (s, w) => { w.input.productId = 'gid://shopify/Product/999'; },
    request: (s, w) => { w.requestId = 'other-request-0000001'; },
    requester: (s, w) => { w.requestedBy = 'other-owner'; },
    provider: (s, w) => { w.provider = 'meta'; },
    operation: (s, w) => { w.input.operation = 'product_tags_add'; },
    payload: (s, w) => { w.input.description = 'Unapproved wording'; },
    title: (s, w) => { w.input.title = 'Another title'; },
    digest: (s, w) => { w.digest = 'a'.repeat(64); },
    settings: (s, w) => { s.connectionSettings.shopify.revision++; },
    objective: (s, w) => { w.objectivePolicyProposal = { origin: 'owner_objective_content' }; },
    duplicate: (s, w) => { s.connectionWrites.push(structuredClone(w)); }
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    const f = await contentPilotFixture(); change(f.state, f.write);
    assert.throws(() => assertContentPilotScope(f.pilot, f.state, f.write));
    await assert.rejects(f.run);
    assert.equal(f.counts.credentials, 0); assert.equal(f.counts.mutations, 0); assert.equal(f.counts.saves, 0);
  });
});

test('expired and paused scopes reject before dispatch; scope source is detached from later edits', async () => {
  const f = await contentPilotFixture();
  const expired = createContentPilot({ ...f.scope, expiresAt: '2000-01-01T00:00:00Z' });
  await assert.rejects(() => f.run({ contentPilot: expired }), { code: 'CONTENT_PILOT_EXPIRED' });
  pauseContentPilot(f.pilot);
  await assert.rejects(f.run, { code: 'CONTENT_PILOT_PAUSED' });
  const fresh = await contentPilotFixture(); fresh.scope.productId = 'gid://shopify/Product/999';
  assert.doesNotThrow(() => assertContentPilotScope(fresh.pilot, fresh.state, fresh.write));
});

test('richer HTML and multiple paragraphs fail closed under the unchanged receipt contract', async () => {
  const f = await contentPilotFixture();
  for (const descriptionHtml of ['<p>One</p><p>Two</p>', '<p><strong>Styled</strong></p>', '<ul><li>Keep me</li></ul>', 'plain text']) {
    assert.throws(() => createContentPilot({ ...f.scope, baseline: { ...f.scope.baseline, descriptionHtml } }), { code: 'CONTENT_PILOT_UNSUPPORTED_CONTENT' });
  }
});

test('current provider title, HTML, timestamp, missing product and unavailable read prevent mutation', async t => {
  for (const field of ['title', 'descriptionHtml', 'updatedAt', 'id', 'missing', 'unavailable']) await t.test(field, async () => {
    const f = await contentPilotFixture();
    f.hooks.baseline = product => {
      if (field === 'unavailable') throw new Error('Synthetic provider read failure');
      if (field === 'missing') return { product: null };
      return { product: { ...product, [field]: 'newer value' } };
    };
    const result = await f.run();
    assert.equal(result.status, 'failed'); assert.equal(result.dispatchBlocked, true);
    assert.equal(f.counts.mutations, 0); assert.equal(f.baselineReads.length, 1);
    assert.deepEqual(f.receiptCommits.map(c => c.kind), ['reserve']);
    await assert.rejects(f.run, { code: 'WRITE_ALREADY_ATTEMPTED' });
  });
});

test('financial restrictions remain blocking despite an exact scoped owner approval', async t => {
  for (const limits of [{ profitFirst: true }, { maxMonthlyAdBudget: 0, currency: 'GBP' }, { minGrossMarginPercent: 1 }, { minStockCoverDays: 1 }]) {
    await t.test(JSON.stringify(limits), async () => {
      const f = await contentPilotFixture({ family: 'manual-v1-policy', seedChange: state => Object.assign(state.businessObjectives[0].limits, limits) });
      await assert.rejects(f.run, { code: 'WRITE_POLICY_EVIDENCE_REQUIRED' });
      assert.equal(f.counts.credentials, 0); assert.equal(f.counts.mutations, 0); assert.equal(f.counts.saves, 0);
    });
  }
});

test('settings, approval, actor and expiry changes across the provider read prevent the final send', async t => {
  for (const kind of ['settings', 'approval', 'actor', 'pause', 'expiry']) await t.test(kind, async t => {
    const f = await contentPilotFixture();
    f.hooks.baseline = () => {
      if (kind === 'settings') f.state.connectionSettings.shopify.revision++;
      if (kind === 'approval') f.state.approvals[0].status = 'rejected';
      if (kind === 'actor') f.state.users[0].sessionVersion++;
      if (kind === 'pause') pauseContentPilot(f.pilot);
      if (kind === 'expiry') t.mock.method(Date, 'now', () => Date.parse(f.scope.expiresAt));
    };
    await f.run().catch(() => {});
    assert.equal(f.counts.mutations, 0);
    assert.deepEqual(f.receiptCommits.map(c => c.kind), ['reserve']);
  });
});

test('concurrent calls and lost admission acknowledgement never create a second send', async () => {
  const f = await contentPilotFixture();
  const results = await Promise.allSettled([f.run(), f.run()]);
  assert.equal(results.filter(r => r.status === 'fulfilled' && r.value.status === 'completed').length, 1);
  assert.equal(f.counts.mutations, 1);
  const lost = await contentPilotFixture(); lost.receiptHooks.omitAck = true;
  await assert.rejects(lost.run, { code: 'CONTENT_RECEIPT_ACK_INVALID' });
  await assert.rejects(lost.run, { code: 'WRITE_ALREADY_ATTEMPTED' });
  assert.equal(lost.counts.mutations, 0);
  // Reconstructing process capabilities cannot make a durable started request replayable.
  const cold = await lost.replica.get(lost.state.workspace.id);
  await assert.rejects(() => executeConnectionWrite(cold, lost.write.id, lost.session.userId, lost.service,
    () => { throw new Error('Must not save'); }, { contentPilot: createContentPilot(lost.scope) }), { code: 'WRITE_ALREADY_ATTEMPTED' });
});

test('independent replica capabilities still compete on the existing durable workspace CAS', async () => {
  const f = await contentPilotFixture(), cold = await f.replica.get(f.state.workspace.id);
  const other = () => executeConnectionWrite(cold, f.write.id, f.session.userId, f.service,
    options => f.store.save(cold.workspace.id, cold, options), {
      governedRecordStage: f.closedStage, contentPilot: createContentPilot(f.scope),
      protectedContentReceipts: 'runvara-content-execution-receipts/v1', durableStore: true,
      actorSession: f.session, loadFreshState: f.loadFreshState
    });
  const results = await Promise.allSettled([f.run(), other()]);
  assert.equal(results.filter(r => r.status === 'fulfilled' && r.value.status === 'completed').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal(f.counts.mutations, 1);
});

test('a durable settings change during the baseline read is caught by the final fresh authority check', async () => {
  const f = await contentPilotFixture();
  f.hooks.baseline = async () => {
    const newer = await f.replica.get(f.state.workspace.id);
    newer.connectionSettings.shopify.revision++;
    await f.replica.save(newer.workspace.id, newer);
  };
  await assert.rejects(f.run);
  assert.equal(f.counts.mutations, 0);
  assert.deepEqual(f.receiptCommits.map(c => c.kind), ['reserve']);
});

test('lost provider response and final acknowledgement preserve no-blind-resend behavior', async t => {
  for (const kind of ['provider', 'final']) await t.test(kind, async () => {
    const f = await contentPilotFixture();
    if (kind === 'provider') f.hooks.fetch = () => { throw new Error('Synthetic lost provider acknowledgement'); };
    else f.receiptHooks.beforeCommit = descriptor => { if (descriptor.kind === 'finalize') throw Object.assign(new Error('Synthetic final CAS conflict'), { code: 'STATE_CONFLICT' }); };
    if (kind === 'provider') assert.equal((await f.run()).status, 'uncertain');
    else await assert.rejects(f.run, { code: 'STATE_CONFLICT' });
    await f.run().catch(() => {});
    assert.equal(f.counts.mutations, 1);
    const cold = await f.replica.get(f.state.workspace.id);
    assert.notEqual(cold.connectionWrites[0].status, 'ready');
  });
});

test('pause after submission still permits exact receipt finalization; rollback without capability stays closed', async () => {
  const f = await contentPilotFixture();
  f.hooks.fetch = () => { pauseContentPilot(f.pilot); };
  assert.equal((await f.run()).status, 'completed');
  assert.deepEqual(f.receiptCommits.map(c => c.kind), ['reserve', 'finalize']);
  const stopped = await contentPilotFixture();
  await assert.rejects(() => stopped.run({ contentPilot: null }), { code: 'GOVERNED_RECORDS_PAUSED' });
  assert.equal(stopped.counts.mutations, 0);
});

test('scoped proposal can retain matching policies while rejecting other requests without records or audit changes', async () => {
  const f = await contentPilotFixture({ family: 'manual-v1-policy' });
  f.state.connectionWrites = []; f.state.approvals = [];
  const before = structuredClone(f.state);
  assert.throws(() => proposeConnectionWrite(f.state, 'shopify', { ...f.body, requestId: 'another-request-0000001' }, f.session.userId,
    { governedRecordStage: f.closedStage, contentPilot: f.pilot }), { code: 'CONTENT_PILOT_SCOPE_MISMATCH' });
  assert.deepEqual(f.state, before);
  const write = proposeConnectionWrite(f.state, 'shopify', f.body, f.session.userId,
    { governedRecordStage: f.closedStage, contentPilot: f.pilot });
  assert.equal(write.objectivePolicyProposal.origin, 'owner_manual');
  assert.equal(f.state.approvals.length, 1);
  assert.doesNotThrow(() => assertContentProducerAdmission(f.closedStage, f.pilot, f.state, write));
});
