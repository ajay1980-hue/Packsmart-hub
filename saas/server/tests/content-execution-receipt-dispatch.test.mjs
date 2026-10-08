import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { contentJsonbFixture, CONTENT_FAMILIES, CONTENT_WORKSPACE, CONTENT_PRODUCT } from './content-jsonb-test-fixture.mjs';
import { objectiveContentFixture } from './objective-content-fixture.mjs';
import { publicConnectionWrite } from '../lib/action-display.mjs';
import { CONTENT_EXECUTION_RECEIPT_CONTRACT, CONTENT_EXECUTION_RECEIPT_ACK_SCHEMA,
  recordContentReceiptAcknowledgement, contentExecutionSourceIntent } from '../lib/content-execution-receipt.mjs';
import { REVIEWED_ACTION_STATE_MAX_BYTES } from '../lib/reviewed-action-evidence.mjs';

// Dispatch tests use the existing synthetic store/provider fixture and model
// only an adapter's verified private ACK. Atomic SQL and transport are exercised
// in their own tests; no test below claims a database receipt was inserted.
function withReceiptAcknowledgements(f) {
  const save = f.store.save.bind(f.store), run = f.run;
  f.receiptCommits = []; f.receiptHooks = {};
  f.store.save = async (workspaceId, state, options) => {
    const descriptor = options?.protectedContentCommit, previous = state._revision;
    const legacyOptions = options ? { ...options } : undefined;
    if (legacyOptions) delete legacyOptions.protectedContentCommit;
    if (descriptor) {
      f.receiptCommits.push(descriptor);
      assert.ok(Object.isFrozen(descriptor)); assert.equal(options.ownedSnapshot, true);
      await f.receiptHooks.beforeCommit?.(descriptor);
    }
    const saved = await save(workspaceId, state, legacyOptions);
    if (descriptor && !f.receiptHooks.omitAck) {
      const a = descriptor.admission;
      const ack = { schema: CONTENT_EXECUTION_RECEIPT_ACK_SCHEMA, kind: descriptor.kind, workspaceId,
        attemptId: a.attemptId, admissionDigest: a.digest, intentDigest: a.intentDigest,
        requestFingerprint: crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex'),
        expectedRevision: previous, nextRevision: saved._revision,
        receiptDigest: descriptor.kind === 'finalize' ? descriptor.receipt.digest : null, reservedBytes: 40960, replayed: false };
      await f.receiptHooks.ack?.(ack, descriptor);
      recordContentReceiptAcknowledgement(saved, descriptor, ack);
    }
    return saved;
  };
  f.run = (overrides = {}) => run({ protectedContentReceipts: CONTENT_EXECUTION_RECEIPT_CONTRACT, ...overrides });
  return f;
}

test('manual and objective dispatch replace only phase/final boundaries, preserving original byte identities and reads', async t => {
  for (const family of CONTENT_FAMILIES) await t.test(family, async () => {
    const f = withReceiptAcknowledgements(await contentJsonbFixture({ family, privateOrder: true }));
    const result = await f.run();
    assert.equal(result.status, 'completed', result.errorCode);
    assert.equal(f.counts.mutations, 1); assert.equal(f.counts.saves, 3); assert.equal(f.counts.fresh, 2);
    assert.equal(f.counts.job, family === 'objective-v2' ? 3 : 0);
    assert.deepEqual(f.receiptCommits.map(commit => commit.kind), ['reserve','finalize']);
    const [reservation, final] = f.receiptCommits;
    assert.equal(reservation.admission.actorId, f.session.userId);
    assert.equal(reservation.admission.actorSessionVersion, f.session.sessionVersion);
    assert.equal(reservation.admission.claimIdentity, f.expected.identity);
    assert.equal(reservation.admission.authorityDigest, f.expected.authority);
    assert.equal(reservation.admission.dispatchRequestDigest, f.expected.requestDigest);
    assert.deepEqual(final.admission, reservation.admission);
    assert.equal(final.receipt.source.context.origin, family === 'objective-v2' ? 'owner_objective_content' : 'owner_manual');
    assert.equal(final.receipt.source.context.completedAt, result.completedAt);
    assert.equal(contentExecutionSourceIntent(final.receipt.source), reservation.admission.intentDigest);
    assert.equal(f.requests[0].body, f.expected.request.body);
    assert.equal(f.requests[0].url, f.expected.request.url);
    const display = publicConnectionWrite(result);
    for (const key of ['receipt','sourceTemplate','admission','recordedActionContext','dispatchClaim']) assert.equal(Object.hasOwn(display, key), false);
    const serialized = JSON.stringify(f.database.states.get(CONTENT_WORKSPACE));
    assert.equal(serialized.includes('runvara-content-execution-receipt'), false, 'Protected document is never copied into workspace JSON');
    await f.run(); assert.equal(f.counts.mutations, 1); assert.equal(f.receiptCommits.length, 2);
  });
});

test('required oversize or unsupported Unicode stops before reservation and provider, retaining no invented receipt', async t => {
  for (const description of ['雪'.repeat(6000), '\u0001'.repeat(3500), '\ud800', '\0']) await t.test(JSON.stringify(description.slice(0, 10)), async () => {
    const f = withReceiptAcknowledgements(await objectiveContentFixture({ contentInput: { description } }));
    const result = await f.run();
    assert.equal(result.status, 'failed'); assert.equal(result.dispatchBlocked, true);
    assert.ok(['CONTENT_RECEIPT_TOO_LARGE','CONTENT_RECEIPT_SOURCE_UNAVAILABLE'].includes(result.errorCode), result.errorCode);
    assert.equal(f.counts.mutations, 0); assert.equal(f.receiptCommits.length, 0);
    assert.equal(result.dispatchClaim.phases.shopify_mutation, undefined);
  });
});

test('unknown server capability and unsupported signed layouts fail closed before preparation awaits', async () => {
  const unknown = withReceiptAcknowledgements(await contentJsonbFixture());
  await assert.rejects(() => unknown.run({ protectedContentReceipts: 'future-contract' }), { code: 'CONTENT_RECEIPT_UNAVAILABLE' });
  assert.equal(unknown.counts.credentials, 0); assert.equal(unknown.counts.saves, 0); assert.equal(unknown.counts.mutations, 0);
  const unsupported = withReceiptAcknowledgements(await contentJsonbFixture({ initialChange: state => { state.approvals[0].payload.futureSignedField = 'unknown'; } }));
  await assert.rejects(unsupported.run, { code: 'CONTENT_RECEIPT_SOURCE_UNAVAILABLE' });
  assert.equal(unsupported.counts.credentials, 0); assert.equal(unsupported.counts.saves, 0);
});

test('missing private proof or mismatched ACK blocks Shopify even after a workspace phase save', async t => {
  for (const mode of ['missing','wrong-attempt','wrong-reservation']) await t.test(mode, async () => {
    const f = withReceiptAcknowledgements(await contentJsonbFixture());
    if (mode === 'missing') f.receiptHooks.omitAck = true;
    else f.receiptHooks.ack = ack => { if (mode === 'wrong-attempt') ack.attemptId = `content_attempt_${'a'.repeat(64)}`; else ack.reservedBytes = 1; };
    await assert.rejects(f.run, { code: 'CONTENT_RECEIPT_ACK_INVALID' });
    const result = f.write;
    assert.equal(result.status, 'executing'); assert.equal(result.errorCode, undefined);
    assert.equal(f.counts.mutations, 0); assert.equal(f.receiptCommits.length, 1);
    assert.equal(f.counts.saves, 2, 'Unacknowledged phase never enters a generic terminal save');
    assert.ok(result.dispatchClaim.phases.shopify_mutation);
    await assert.rejects(f.run, { code: 'WRITE_ALREADY_ATTEMPTED' }); assert.equal(f.counts.mutations, 0);
  });
});

test('protected reserve refusal propagates its exact code without saving the unadmitted local phase', async () => {
  for (const code of ['CONTENT_RECEIPT_CAPACITY_EXHAUSTED','CONTENT_RECEIPT_UNAVAILABLE','CONTENT_RECEIPT_COMMIT_UNCONFIRMED']) {
    const f = withReceiptAcknowledgements(await contentJsonbFixture());
    f.receiptHooks.beforeCommit = () => { throw Object.assign(new Error(code), { code, definitive: true }); };
    await assert.rejects(f.run, { code });
    assert.equal(f.counts.saves, 2); assert.equal(f.counts.mutations, 0);
    assert.equal(f.write.status, 'executing'); assert.ok(f.write.dispatchClaim.phases.shopify_mutation);
    const retained = f.database.states.get(CONTENT_WORKSPACE).connectionWrites[0];
    assert.equal(retained.status, 'executing'); assert.equal(retained.dispatchClaim.phases.shopify_mutation, undefined);
    await assert.rejects(f.run, { code: 'WRITE_ALREADY_ATTEMPTED' });
    assert.equal(f.counts.saves, 2); assert.equal(f.counts.mutations, 0);
  }
});

test('last fresh authority failure retains the admitted attempt without provider dispatch or completion receipt', async () => {
  const f = withReceiptAcknowledgements(await contentJsonbFixture());
  f.hooks.fresh = (fresh, count) => { if (count === 2) fresh.users[0].sessionVersion++; return fresh; };
  const result = await f.run();
  assert.equal(result.status, 'failed'); assert.equal(result.dispatchBlocked, true);
  assert.equal(f.counts.mutations, 0); assert.deepEqual(f.receiptCommits.map(commit => commit.kind), ['reserve']);
});

test('known success keeps its immutable receipt when optional context is omitted at the workspace size ceiling', async t => {
  for (const family of ['manual','objective-v2']) await t.test(family, async () => {
    const f = withReceiptAcknowledgements(await contentJsonbFixture({ family }));
    const bytes = Buffer.byteLength(JSON.stringify(f.state));
    f.state.padding = 'x'.repeat(REVIEWED_ACTION_STATE_MAX_BYTES - bytes - 19000);
    await f.store.save(CONTENT_WORKSPACE, f.state); f.counts.saves = 0;
    const result = await f.run();
    assert.equal(result.status, 'completed', result.errorCode); assert.equal(result.recordedActionContext, undefined);
    assert.equal(f.receiptCommits.length, 2); assert.equal(f.receiptCommits[1].receipt.source.context.resultId, CONTENT_PRODUCT);
    assert.equal(f.receiptCommits[1].receipt.source.input.description, f.before.connectionWrites[0].input.description);
    assert.equal(f.counts.mutations, 1); assert.equal(f.counts.saves, 3);
  });
});

test('known final workspace growth fails before reserve or provider, including a large copied approval title', async t => {
  for (const kind of ['state-headroom','approval-title']) await t.test(kind, async () => {
    const f = withReceiptAcknowledgements(await contentJsonbFixture());
    if (kind === 'approval-title') f.state.approvals[0].action = 'x'.repeat(20000);
    const bytes = Buffer.byteLength(JSON.stringify(f.state));
    f.state.padding = 'x'.repeat(REVIEWED_ACTION_STATE_MAX_BYTES - bytes - (kind === 'approval-title' ? 30000 : 14500));
    await f.store.save(CONTENT_WORKSPACE, f.state); f.counts.saves = 0;
    const result = await f.run();
    assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'CONTENT_RECEIPT_STATE_CAPACITY_EXHAUSTED');
    assert.equal(f.counts.mutations, 0); assert.equal(f.receiptCommits.length, 0);
  });
});

test('provider rejection and unknown response retain admission only and never replay', async t => {
  for (const kind of ['rejected','unknown']) await t.test(kind, async () => {
    const f = withReceiptAcknowledgements(await contentJsonbFixture());
    f.hooks.fetch = async () => {
      if (kind === 'unknown') throw new Error('Synthetic lost provider response');
      return Response.json({ data: { productUpdate: { product: null, userErrors: [{ field: 'title', message: 'Synthetic rejection' }] } } });
    };
    const result = await f.run(); assert.equal(result.status, kind === 'rejected' ? 'failed' : 'uncertain');
    assert.deepEqual(f.receiptCommits.map(commit => commit.kind), ['reserve']);
    assert.equal(f.counts.mutations, 1); await assert.rejects(f.run, { code: 'WRITE_ALREADY_ATTEMPTED' });
    assert.equal(f.counts.mutations, 1);
  });
});

test('unconfirmed final persistence leaves the known local success intact and cannot replay the provider', async () => {
  const f = withReceiptAcknowledgements(await contentJsonbFixture({ family: 'objective-v2' }));
  f.receiptHooks.beforeCommit = descriptor => { if (descriptor.kind === 'finalize') throw Object.assign(new Error('Synthetic final CAS conflict'), { code: 'STATE_CONFLICT' }); };
  await assert.rejects(f.run, { code: 'STATE_CONFLICT' });
  assert.equal(f.write.status, 'completed'); assert.equal(f.counts.mutations, 1);
  assert.equal(f.database.states.get(CONTENT_WORKSPACE).connectionWrites[0].status, 'executing');
  assert.equal(f.receiptCommits[1].receipt.source.context.resultId, CONTENT_PRODUCT);
  await f.run(); assert.equal(f.counts.mutations, 1);
});
