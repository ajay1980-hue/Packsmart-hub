import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { reviewedActionFixture } from './reviewed-action-test-fixture.mjs';
import { canonicalReviewedActionJson, digestReviewedActionValue, reviewedActionClaimIdentity,
  reviewedActionDispatchRequest, REVIEWED_ACTION_MAX_BYTES } from '../lib/reviewed-action-evidence.mjs';
import { CONTENT_EXECUTION_RECEIPT_CONTRACT, CONTENT_EXECUTION_RECEIPT_ACK_SCHEMA,
  contentExecutionReceiptRequired, contentReceiptJsonbBytes, contentExecutionSourceIntent,
  prepareContentExecutionAdmission, completeContentExecutionReceipt, validateContentExecutionCommit,
  recordContentReceiptAcknowledgement, assertContentReceiptAcknowledgement } from '../lib/content-execution-receipt.mjs';

const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const phaseAt = '2026-10-05T11:59:00.000Z';
function prepare(description = 'Frozen approved source', workspaceId = 'tenant-a') {
  const f = reviewedActionFixture({ workspaceId });
  f.write.input.description = description;
  f.write.digest = fingerprint(f.write.input); f.approval.payload.digest = f.write.digest;
  const claimIdentity = reviewedActionClaimIdentity(f.write.input, { writeId: f.write.id, requestId: f.write.requestId,
    provider: 'shopify', inputDigest: f.write.digest, connectionId: f.write.connectionId, account: f.write.account,
    requestedBy: f.write.requestedBy, approval: f.approval, proposal: null });
  const descriptor = prepareContentExecutionAdmission({ state: f.state, write: f.write, preparedInput: f.write.input,
    actor: f.write.requestedBy, actorSession: { sessionVersion: 3 }, approval: f.approval,
    objectivePolicy: { workspaceId: f.state.workspace.id, policies: [] },
    dispatchRequestDigest: fingerprint(reviewedActionDispatchRequest(f.write.input, f.write.account, '2026-07')),
    claimId: f.write.dispatchClaim.id, claimIdentity, authorityDigest: 'b'.repeat(64), apiVersion: '2026-07', phaseAt,
    comparisonContract: { family: 'manual' } });
  return { f, descriptor };
}
export function receiptAck(descriptor, overrides = {}) {
  const a = descriptor.admission;
  return { schema: CONTENT_EXECUTION_RECEIPT_ACK_SCHEMA, kind: descriptor.kind, workspaceId: a.workspaceId,
    attemptId: a.attemptId, admissionDigest: a.digest, intentDigest: a.intentDigest, requestFingerprint: 'c'.repeat(64),
    expectedRevision: crypto.randomUUID(), nextRevision: crypto.randomUUID(),
    receiptDigest: descriptor.kind === 'finalize' ? descriptor.receipt.digest : null, reservedBytes: 40960, replayed: false,
    ...overrides };
}

test('only an exact server-selected capability enables protected preparation', () => {
  for (const disabled of [undefined, null, '']) assert.equal(contentExecutionReceiptRequired(disabled), false);
  assert.equal(contentExecutionReceiptRequired(CONTENT_EXECUTION_RECEIPT_CONTRACT), true);
  for (const unknown of [true, {}, 'unknown', `${CONTENT_EXECUTION_RECEIPT_CONTRACT} `]) {
    assert.throws(() => contentExecutionReceiptRequired(unknown), { code: 'CONTENT_RECEIPT_UNAVAILABLE' });
  }
});

test('receipt workspace identity retains the existing 256-character boundary and exact tenant binding', () => {
  for (const workspaceId of ['w'.repeat(200), 'w'.repeat(256)]) {
    const { descriptor } = prepare('Bounded source', workspaceId);
    assert.equal(descriptor.admission.workspaceId, workspaceId);
    assert.equal(descriptor.sourceTemplate.context.workspaceId, workspaceId);
    const changed = structuredClone(descriptor);
    changed.admission.workspaceId = 'other-tenant';
    assert.throws(() => validateContentExecutionCommit(changed));
  }
  for (const workspaceId of ['', 'w'.repeat(257), ' tenant', 'tenant ', 'tenant\nname', 'tenant\u007fname']) {
    assert.throws(() => prepare('Bounded source', workspaceId));
  }
});

test('preflight retains one immutable source and finalization changes only fixed-width observation and digests', () => {
  const { f, descriptor } = prepare();
  const original = canonicalReviewedActionJson(descriptor);
  f.write.input.description = 'A later mutable edit'; f.approval.decidedBy = 'other';
  const final = completeContentExecutionReceipt(descriptor, { completedAt: '2026-10-05T12:01:00.000Z', resultId: descriptor.sourceTemplate.input.productId });
  assert.equal(final.receipt.source.input.description, 'Frozen approved source');
  assert.equal(final.receipt.source.context.approval.decidedBy, 'user_owner');
  assert.equal(contentExecutionSourceIntent(final.receipt.source), descriptor.admission.intentDigest);
  assert.equal(contentReceiptJsonbBytes(final.receipt.source), contentReceiptJsonbBytes(descriptor.sourceTemplate));
  assert.equal(canonicalReviewedActionJson(descriptor), original);
  assert.ok(Object.isFrozen(descriptor.sourceTemplate.context.approval.payload));
  assert.ok(Object.isFrozen(final.receipt.source));
  const checked = validateContentExecutionCommit(final);
  assert.notEqual(checked, final); assert.deepEqual(checked, final); assert.ok(Object.isFrozen(checked.receipt.source.input));
  for (const forbidden of ['accessToken','encryptedCredentials','clientSecret']) assert.equal(JSON.stringify(final).includes(forbidden), false);
});

test('exact canonical source boundary is admitted and one extra byte fails before observation', () => {
  const base = prepare('').descriptor.sourceTemplate;
  const available = REVIEWED_ACTION_MAX_BYTES - Buffer.byteLength(canonicalReviewedActionJson(base));
  const escaped = '\u0001'.repeat(Math.floor(available / 6)) + 'x'.repeat(available % 6);
  const admitted = prepare(escaped).descriptor;
  assert.equal(Buffer.byteLength(canonicalReviewedActionJson(admitted.sourceTemplate)), REVIEWED_ACTION_MAX_BYTES);
  assert.throws(() => prepare(escaped + 'x'), { code: 'CONTENT_RECEIPT_TOO_LARGE' });
});

test('JSONB byte preflight counts every separator and UTF-8 escape without reading accessors', () => {
  const value = { a: '雪\n\u0001\\"', b: [1, true, null], c: {} };
  const expected = '{"a": "雪\\n\\u0001\\\\\\\"", "b": [1, true, null], "c": {}}';
  assert.equal(contentReceiptJsonbBytes(value), Buffer.byteLength(expected));
  let invoked = false;
  const getter = Object.defineProperty({}, 'a', { enumerable: true, get() { invoked = true; return 'x'; } });
  assert.throws(() => contentReceiptJsonbBytes(getter)); assert.equal(invoked, false);
  for (const unsupported of ['\0', '\ud800']) assert.throws(() => prepare(unsupported), { code: 'CONTENT_RECEIPT_SOURCE_UNAVAILABLE' });
});

test('changed admission, source intent, observation or receipt payload cannot reuse an attempt', () => {
  const { descriptor } = prepare();
  const final = completeContentExecutionReceipt(descriptor, { completedAt: '2026-10-05T12:01:00.000Z', resultId: descriptor.sourceTemplate.input.productId });
  for (const change of [d => { d.admission.actorSessionVersion++; }, d => { d.admission.authorityDigest = '0'.repeat(64); },
    d => { d.receipt.source.context.completedAt = '2026-10-05T11:58:00.000Z'; },
    d => { d.receipt.source.input.description = 'Changed'; }, d => { d.receipt.observation = 'unconfirmed'; },
    d => { d.receipt.unreviewed = true; }]) {
    const altered = structuredClone(final); change(altered); assert.throws(() => validateContentExecutionCommit(altered));
  }
  assert.throws(() => completeContentExecutionReceipt(descriptor, { completedAt: phaseAt, resultId: 'gid://shopify/Product/other' }));
});

test('private acknowledgement survives equivalent descriptor ordering and never serializes to state', () => {
  const { descriptor } = prepare(), state = { workspace: { id: descriptor.admission.workspaceId } };
  const ack = receiptAck(descriptor);
  recordContentReceiptAcknowledgement(state, descriptor, ack);
  assert.deepEqual(assertContentReceiptAcknowledgement(state, validateContentExecutionCommit(descriptor)), ack);
  assert.equal(JSON.stringify(state), JSON.stringify({ workspace: { id: descriptor.admission.workspaceId } }));
  assert.throws(() => assertContentReceiptAcknowledgement(structuredClone(state), descriptor), { code: 'CONTENT_RECEIPT_ACK_INVALID' });
  for (const overrides of [{ kind: 'finalize' }, { receiptDigest: 'd'.repeat(64) }, { requestFingerprint: '' },
    { reservedBytes: 1 }, { expectedRevision: ack.nextRevision }, { extra: true }, { replayed: 1 }]) {
    assert.throws(() => recordContentReceiptAcknowledgement({}, descriptor, receiptAck(descriptor, { ...ack, ...overrides })), { code: 'CONTENT_RECEIPT_ACK_INVALID' });
  }
  const changed = structuredClone(descriptor); changed.admission.actorSessionVersion++;
  changed.admission.digest = digestReviewedActionValue(Object.fromEntries(Object.entries(changed.admission).filter(([key]) => key !== 'digest')));
  assert.throws(() => assertContentReceiptAcknowledgement(state, changed), { code: 'CONTENT_RECEIPT_ACK_INVALID' });
});
