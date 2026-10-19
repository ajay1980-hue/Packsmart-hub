import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DESCRIPTION_EDIT_SCHEMA, descriptionEditPreimage, replaceDescriptionParagraph } from '../lib/description-edit.mjs';
import { contentInputPreimage, contentWriteIdentityContract, contentWritePreimage } from '../lib/content-write-identity.mjs';
import { createContentPilot, pauseContentPilot, assertContentPilotScope } from '../lib/content-pilot.mjs';
import { executeConnectionWrite, proposeConnectionWrite, prepareObjectiveContentRequest } from '../lib/connection-writes.mjs';
import { createGovernedRecordStage, GOVERNED_RECORD_PRODUCER_CONTRACT } from '../lib/governed-record-stage.mjs';
import { DESCRIPTION_EXECUTION_RECEIPT_CONTRACT, validateContentExecutionCommit, contentReceiptRequestFingerprint } from '../lib/content-execution-receipt.mjs';
import { prepareContentReceiptTransaction, commitContentReceiptTransaction } from '../lib/content-execution-receipt-store.mjs';
import { digestReviewedActionValue, validateReviewedSourceAction, supportsReviewedActionSource } from '../lib/reviewed-action-evidence.mjs';
import { resolveProtectedReceiptEvidence, publicProtectedReceiptSource } from '../lib/protected-receipt-source.mjs';
import { publicConnectionWrite } from '../lib/action-display.mjs';
import { descriptionInput, descriptionFixture, paragraphCases, descriptionTimestampCases, PREFIX, SUFFIX, RESULT_PARAGRAPH } from './description-edit-fixture.mjs';
import { objectiveContentFixture } from './objective-content-fixture.mjs';
import { contentPilotFixture } from './content-pilot-test-fixture.mjs';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sign = value => { const { digest, ...body } = value; return { ...body, digest: digestReviewedActionValue(body) }; };

test('bounded paragraph selection preserves surrounding HTML bytes', async t => {
  for (const row of paragraphCases) await t.test(row.name, () => {
    if (row.expected) assert.equal(replaceDescriptionParagraph(row.html, row.paragraph, row.text), row.expected);
    else assert.throws(() => replaceDescriptionParagraph(row.html, row.paragraph, row.text), { code: 'WRITE_DESCRIPTION_EDIT_INVALID' });
  });
  const result = descriptionEditPreimage(descriptionInput());
  assert.deepEqual(Buffer.from(result.descriptionHtml), Buffer.from(PREFIX + RESULT_PARAGRAPH + SUFFIX));
});

test('exact versioned input rejects widening, accessors, unknown versions and changed result', () => {
  const input = descriptionInput();
  assert.deepEqual(contentInputPreimage(Object.fromEntries(Object.entries(input).reverse())), input);
  for (const changed of [{ ...input, title: 'Do not send' }, { ...input, schema: 'unknown' }, { ...input, descriptionHtml: '<p>Flattened</p>' },
    { ...input, paragraphHtml: '<p>Missing</p>' }, { ...input, replacementText: 'Different' }, { ...input, baselineUpdatedAt: 'invalid' },
    { ...input, baselineUpdatedAt: '0000-01-01T00:00:00Z' }, { ...input, baselineUpdatedAt: '2026-02-30T00:00:00Z' }]) {
    assert.throws(() => contentInputPreimage(changed));
  }
  let read = false;
  assert.throws(() => descriptionEditPreimage({ ...input, get baselineHtml() { read = true; return input.baselineHtml; } }));
  assert.equal(read, false);
});

test('description baseline UTC timestamps match the SQL boundary corpus', () => {
  for (const [baselineUpdatedAt, valid] of descriptionTimestampCases) {
    const run = () => descriptionEditPreimage({ ...descriptionInput(), baselineUpdatedAt });
    if (valid) assert.doesNotThrow(run); else assert.throws(run, { code: 'WRITE_DESCRIPTION_EDIT_INVALID' });
  }
});

test('rich description dispatch omits title and retains exact approval, source and protected receipt identities', async () => {
  const f = await descriptionFixture();
  const contract = contentWriteIdentityContract(f.write, f.state.approvals[0], f.state.connectionSettings.shopify.consent);
  assert.equal(hash(contentWritePreimage(f.write, contract)), f.expected.identity);
  assert.equal((await f.run()).status, 'completed');
  assert.equal(f.counts.mutations, 1); assert.equal(f.baselineReads.length, 1);
  const body = JSON.parse(f.requests[0].body);
  assert.deepEqual(body.variables.product, { id: 'gid://shopify/Product/71', descriptionHtml: PREFIX + RESULT_PARAGRAPH + SUFFIX });
  assert.ok(!body.query.includes('title')); assert.ok(!f.baselineReads[0].query.includes('title'));
  assert.deepEqual(f.receiptCommits.map(row => row.contract), [DESCRIPTION_EXECUTION_RECEIPT_CONTRACT, DESCRIPTION_EXECUTION_RECEIPT_CONTRACT]);
  const descriptor = f.receiptCommits[1], source = descriptor.receipt.source;
  assert.equal(source.schema, 'runvara-reviewed-source-action/v3');
  assert.equal(source.context.approval.payload.digest, hash(descriptionInput()));
  assert.deepEqual(contentInputPreimage(source.input), descriptionInput());
  assert.equal(source.context.dispatchRequestDigest, f.expected.requestDigest);
  assert.deepEqual(publicConnectionWrite(f.write).input, descriptionInput());
  const resolved = resolveProtectedReceiptEvidence({ schema: 'runvara-outcome-content-source-private/v1',
    admission: descriptor.admission, receipt: descriptor.receipt, commitRevision: randomUUID() }, { workspaceId: f.state.workspace.id });
  assert.deepEqual(publicProtectedReceiptSource(source, { workspaceId: f.state.workspace.id, receiptSource: resolved.receiptSource }).input, descriptionInput());
  await f.run(); assert.equal(f.counts.mutations, 1);
  assert.deepEqual((await f.coldHistory()).history.request.input, f.write.input);
});

test('old and new sources coexist; mixed envelopes and relabelled sources reject', async () => {
  const old = await contentPilotFixture(), fresh = await descriptionFixture();
  await old.run(); await fresh.run();
  for (const f of [old, fresh]) assert.doesNotThrow(() => validateContentExecutionCommit(f.receiptCommits[1]));
  const legacy = old.receiptCommits[1], current = fresh.receiptCommits[1];
  assert.equal(supportsReviewedActionSource('runvara-reviewed-action/v3', legacy.receipt.source), true);
  assert.equal(supportsReviewedActionSource('runvara-reviewed-action/v2', current.receipt.source), false);
  assert.equal(supportsReviewedActionSource('runvara-reviewed-action/v3', current.receipt.source), true);
  for (const descriptor of [{ ...current, contract: legacy.contract }, { ...current, admission: legacy.admission },
    { ...current, receipt: sign({ ...current.receipt, schema: legacy.receipt.schema }) },
    { ...legacy, receipt: sign({ ...legacy.receipt, source: current.receipt.source }) }]) assert.throws(() => validateContentExecutionCommit(descriptor));
  const source = current.receipt.source;
  for (const changed of [sign({ ...source, schema: 'runvara-reviewed-source-action/v1' }),
    sign({ ...source, input: { ...source.input, descriptionHtml: '<p>unapproved</p>' } }),
    sign({ ...source, context: { ...source.context, account: 'other.myshopify.com' } })]) {
    assert.throws(() => validateReviewedSourceAction(changed, { workspaceId: fresh.state.workspace.id }));
  }
});

test('scope and approval changes refuse description dispatch before credentials or writes', async t => {
  const changes = {
    tenant: f => { f.state.workspace.id = 'other'; }, account: f => { f.write.account = 'other.myshopify.com'; },
    connection: f => { f.write.connectionId = 'other'; }, request: f => { f.write.requestId = 'other-request-0000001'; },
    product: f => { f.write.input.productId = 'gid://shopify/Product/72'; }, requester: f => { f.write.requestedBy = 'other'; },
    baseline: f => { f.write.input.baselineHtml += ' '; }, result: f => { f.write.input.descriptionHtml += ' '; },
    approval: f => { f.state.approvals[0].payload.digest = 'a'.repeat(64); },
    settings: f => { f.state.connectionSettings.shopify.revision++; }, duplicate: f => { f.state.connectionWrites.push(structuredClone(f.write)); },
    title: f => { f.write.input.title = 'Unapproved title'; }, pause: f => pauseContentPilot(f.pilot)
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    const f = await descriptionFixture(); change(f); await assert.rejects(f.run);
    assert.equal(f.counts.mutations, 0); assert.equal(f.counts.credentials, 0); assert.equal(f.counts.saves, 0);
  });
});

test('baseline and final local authority changes prevent sending after reservation', async t => {
  for (const name of ['html', 'updatedAt', 'settings', 'approval', 'session', 'expiry', 'pause']) await t.test(name, async t => {
    const f = await descriptionFixture();
    f.hooks.baseline = async product => {
      if (name === 'html') return { product: { ...product, descriptionHtml: product.descriptionHtml + ' ' } };
      if (name === 'updatedAt') return { product: { ...product, updatedAt: '2026-10-14T12:01:00Z' } };
      if (name === 'pause') { pauseContentPilot(f.pilot); return; }
      if (name === 'expiry') { t.mock.method(Date, 'now', () => Date.parse(f.scope.expiresAt)); return; }
      const newer = await f.replica.get(f.state.workspace.id);
      if (name === 'settings') newer.connectionSettings.shopify.revision++;
      if (name === 'approval') newer.approvals[0].status = 'rejected';
      if (name === 'session') newer.users[0].sessionVersion++;
      await f.replica.save(newer.workspace.id, newer);
    };
    const result = await f.run().catch(error => ({ status: 'thrown', error }));
    assert.notEqual(result.status, 'completed'); assert.equal(f.counts.mutations, 0);
    assert.deepEqual(f.receiptCommits.map(row => row.kind), ['reserve']);
  });
});

test('profit-first and finite financial restrictions still block', async t => {
  for (const limits of [{ profitFirst: true }, { maxMonthlyAdBudget: 0, currency: 'GBP' }, { minGrossMarginPercent: 1 }, { minStockCoverDays: 1 }]) await t.test(JSON.stringify(limits), async () => {
    const f = await descriptionFixture({ seedChange: state => { Object.assign(state.businessObjectives[0].limits, limits); } });
    await assert.rejects(f.run, { code: 'WRITE_POLICY_EVIDENCE_REQUIRED' });
    assert.equal(f.counts.credentials, 0); assert.equal(f.counts.saves, 0); assert.equal(f.counts.mutations, 0);
  });
});

test('a complete valid objective path cannot enter the pilot', async () => {
  const objective = await objectiveContentFixture(), f = await descriptionFixture();
  const before = structuredClone(objective.state);
  await assert.rejects(() => prepareObjectiveContentRequest(objective.state, { ...objective.body, requestId: 'valid-objective-closed-001' }, objective.session,
    { governedRecordStage: f.closedStage, loadJob: objective.loadJob, persist: () => assert.fail('Must not persist') }), { code: 'GOVERNED_RECORDS_PAUSED' });
  assert.deepEqual(objective.state, before);
  await assert.rejects(() => objective.run({ governedRecordStage: f.closedStage, contentPilot: f.pilot,
    protectedContentReceipts: DESCRIPTION_EXECUTION_RECEIPT_CONTRACT }));
  assert.equal(objective.counts.credentials, 0); assert.equal(objective.counts.mutations, 0);
});

test('capability removal, legacy receipt support and a broad gate cannot activate new edits', async () => {
  const f = await descriptionFixture();
  for (const overrides of [{ contentPilot: null }, { protectedContentReceipts: 'runvara-content-execution-receipts/v1' },
    { governedRecordStage: createGovernedRecordStage({ GOVERNED_RECORD_PRODUCER_CONTRACT }) }]) await assert.rejects(() => f.run(overrides));
  f.state.connectionWrites = []; f.state.approvals = [];
  assert.throws(() => proposeConnectionWrite(f.state, 'shopify', f.body, f.session.userId,
    { governedRecordStage: createGovernedRecordStage({ GOVERNED_RECORD_PRODUCER_CONTRACT }) }), { code: 'CONTENT_PILOT_REQUIRED' });
  assert.equal(f.state.connectionWrites.length, 0); assert.equal(f.counts.mutations, 0);
});

test('independent capabilities compete on synthetic durable CAS; admitted restart cannot resend', async () => {
  const f = await descriptionFixture(), cold = await f.replica.get(f.state.workspace.id);
  const options = { governedRecordStage: f.closedStage, contentPilot: createContentPilot(f.scope), protectedContentReceipts: DESCRIPTION_EXECUTION_RECEIPT_CONTRACT,
    durableStore: true, actorSession: f.session, loadFreshState: f.loadFreshState };
  const results = await Promise.allSettled([f.run(), executeConnectionWrite(cold, f.write.id, f.session.userId, f.service,
    save => f.store.save(cold.workspace.id, cold, save), options)]);
  assert.equal(results.filter(row => row.status === 'fulfilled' && row.value.status === 'completed').length, 1);
  assert.equal(f.counts.mutations, 1);
  const lost = await descriptionFixture(); lost.receiptHooks.omitAck = true;
  await assert.rejects(lost.run, { code: 'CONTENT_RECEIPT_ACK_INVALID' });
  const restarted = await lost.replica.get(lost.state.workspace.id);
  await assert.rejects(() => executeConnectionWrite(restarted, lost.write.id, lost.session.userId, lost.service,
    () => assert.fail('Must not save'), { ...options, contentPilot: createContentPilot(lost.scope) }), { code: 'WRITE_ALREADY_ATTEMPTED' });
  assert.equal(lost.counts.mutations, 0);
});

test('committed but lost final ACK is reconciled by exact adapter lookup without a second commit', async () => {
  const f = await descriptionFixture(); await f.run();
  const descriptor = f.receiptCommits[1], previous = randomUUID(), state = { ...f.state, _revision: randomUUID() };
  const tx = prepareContentReceiptTransaction(state.workspace.id, state, previous, descriptor);
  let committed, writes = 0, reads = 0;
  const result = await commitContentReceiptTransaction(tx, async (operation, path, request) => {
    if (operation === 'state_commit') {
      writes++; const raw = JSON.parse(request.body).p_request_json, r = JSON.parse(raw);
      committed = { ...tx.expectedAck, replayed: false };
      assert.equal(committed.requestFingerprint, contentReceiptRequestFingerprint(raw));
      assert.equal(r.contract, DESCRIPTION_EXECUTION_RECEIPT_CONTRACT);
      throw new Error('Synthetic response lost after durable commit');
    }
    reads++; assert.equal(JSON.parse(request.body).p_request_fingerprint, committed.requestFingerprint);
    return { ...committed, replayed: true };
  });
  assert.equal(result.recovered, true); assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(f.counts.mutations, 1);
});

test('pause after provider submission allows exact finalization', async () => {
  const f = await descriptionFixture(); f.hooks.fetch = () => { pauseContentPilot(f.pilot); };
  assert.equal((await f.run()).status, 'completed');
  assert.deepEqual(f.receiptCommits.map(row => row.kind), ['reserve', 'finalize']);
});

test('combined protected source ceiling still refuses a large but individually valid HTML edit', async () => {
  const input = descriptionInput(), tail = '<p>' + 'x'.repeat(11000) + '</p>';
  Object.assign(input, { baselineHtml: '<p>Old</p>' + tail, paragraphHtml: '<p>Old</p>', replacementText: 'New', descriptionHtml: '<p>New</p>' + tail });
  assert.doesNotThrow(() => descriptionEditPreimage(input));
  const f = await descriptionFixture({ descriptionInput: input });
  const result = await f.run();
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'CONTENT_RECEIPT_TOO_LARGE');
  assert.equal(f.counts.mutations, 0); assert.equal(f.receiptCommits.length, 0); assert.equal(f.baselineReads.length, 0);
});

test('synthetic external edit after baseline read demonstrates the unresolved provider race', async () => {
  const f = await descriptionFixture(); let providerHtml = f.scope.input.baselineHtml;
  f.hooks.fetch = (_url, request) => {
    assert.equal(f.baselineReads.length, 1);
    providerHtml += '<p>A concurrent external addition.</p>';
    const product = JSON.parse(request.body).variables.product;
    // Shopify's documented input has no compare condition; this synthetic
    // provider accepts the submitted full HTML despite its intervening edit.
    assert.deepEqual(Object.keys(product), ['id', 'descriptionHtml']);
    providerHtml = product.descriptionHtml;
  };
  assert.equal((await f.run()).status, 'completed');
  assert.equal(providerHtml, f.scope.input.descriptionHtml);
  assert.equal(providerHtml.includes('concurrent external addition'), false);
});
