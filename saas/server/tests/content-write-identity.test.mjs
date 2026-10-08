import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { contentWriteIdentityContract, contentWritePreimage, contentInputPreimage, contentApprovalPayloadPreimage,
  contentConsentPreimage, contentWriteSnapshot, contentApprovalDecisionSnapshot,
  CONTENT_WRITE_SNAPSHOT_MAX_BYTES, CONTENT_WRITE_SNAPSHOT_MAX_DEPTH } from '../lib/content-write-identity.mjs';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reorder(value[key])])) : value;
const legacyIdentity = write => ({ id: write.id, requestId: write.requestId, provider: write.provider, input: write.input,
  digest: write.digest, connectionId: write.connectionId, account: write.account, requestedBy: write.requestedBy,
  requiresApproval: write.requiresApproval, approvalId: write.approvalId || null,
  ...(Object.hasOwn(write, 'objectivePolicyProposal') ? { objectivePolicyProposal: write.objectivePolicyProposal } : {}) });

function fixture(family = 'manual', consentKind = 'absent') {
  const input = { productId: 'gid://shopify/Product/71', operation: 'product_content', title: 'Ceramic “cup” ☕',
    description: 'Quoted "text", slash \\, <tag> & coffee\nSecond line 日本語.' };
  const write = { id: 'write_00000000-0000-0000-0000-000000000001', requestId: 'content-request-fixed-0001', provider: 'shopify', input,
    digest: hash(input), connectionId: 'connection-fixed', account: 'fixture.myshopify.com', requestedBy: 'owner-fixed',
    requiresApproval: true, approvalId: 'approval_fixed', status: 'ready' };
  const approval = { id: write.approvalId, type: 'customer_facing_publish', payload: { connectionWriteId: write.id, digest: write.digest },
    revision: 1, status: 'approved', decidedBy: write.requestedBy, decidedAt: '2026-10-01T00:00:00.000Z',
    financialImpact: 12.25, history: [{ revision: 1, status: 'approved', actor: write.requestedBy, at: '2026-10-01T00:00:00.000Z', note: null }] };
  if (family !== 'manual') {
    const proposal = { schema: 'runvara-objective-dispatch-proposal/v1', workspaceId: 'workspace-fixed', origin: 'owner_manual',
      writeId: write.id, provider: 'shopify', operation: 'product_content', inputDigest: write.digest,
      connectionId: write.connectionId, account: write.account, requestedBy: write.requestedBy,
      approvalKind: 'customer_facing_publish', policies: [
        { objectiveId: 'objective_00000000-0000-0000-0000-000000000001', revision: 1, digest: '1'.repeat(64) },
        { objectiveId: 'objective_00000000-0000-0000-0000-000000000002', revision: 2, digest: '2'.repeat(64) }
      ], evidenceQualification: 'no_financial_execution_evidence' };
    if (family === 'objective-v2') {
      proposal.schema = 'runvara-objective-dispatch-proposal/v2'; proposal.origin = 'owner_objective_content';
      proposal.source = { schema: 'runvara-objective-content-source/v1', objectiveId: proposal.policies[0].objectiveId,
        objectiveRevision: 1, objectiveDigest: '3'.repeat(64), jobId: 'job_fixed', jobIdentityDigest: '4'.repeat(64),
        reportId: `objective_review_${'5'.repeat(32)}`, payloadDigest: '6'.repeat(64), resultDigest: '7'.repeat(64),
        actorId: write.requestedBy, actorSessionVersion: 1, inputFingerprint: '8'.repeat(32), opportunityId: 'opportunity-fixed',
        opportunityDigest: '9'.repeat(64), productId: input.productId, productDigest: 'a'.repeat(64), approvalSourceDigest: 'b'.repeat(64) };
      proposal.approvalId = approval.id; proposal.approvalDigest = 'c'.repeat(64);
    }
    proposal.digest = hash(proposal); write.objectivePolicyProposal = proposal;
    approval.payload.objectivePolicyProposalDigest = proposal.digest;
  }
  const consent = consentKind === 'absent' ? undefined : consentKind === 'null' ? null
    : { actor: write.requestedBy, at: '2026-10-01T00:00:00.000Z', mode: 'automatic' };
  return { write, approval, consent };
}
const authorityPreimage = ({ write, approval, consent }, contract = null) => ({ actor: write.requestedBy, sessionVersion: 1,
  connectionId: write.connectionId, account: write.account, credentials: hash('opaque-synthetic-ciphertext'),
  scopes: ['write_products', 'read_products'].sort(), permissionMode: consent?.mode || 'approval_gated',
  consent: contract ? contentConsentPreimage(consent) : consent || null,
  approval: { id: approval.id, revision: approval.revision || 1, decidedBy: approval.decidedBy, decidedAt: approval.decidedAt,
    payload: contract ? contentApprovalPayloadPreimage(approval.payload, contract) : approval.payload } });

test('all three producer families recover exact complete legacy preimage text, including consent states', () => {
  for (const family of ['manual', 'manual-v1-policy', 'objective-v2']) for (const consentKind of ['absent', 'null', 'producer']) {
    const original = fixture(family, consentKind), stored = reorder(original);
    const contract = contentWriteIdentityContract(stored.write, stored.approval, stored.consent);
    assert.equal(contract.family, family);
    assert.ok(Object.isFrozen(contract));
    assert.equal(JSON.stringify(contentInputPreimage(stored.write.input)), JSON.stringify(original.write.input));
    assert.equal(hash(contentInputPreimage(stored.write.input)), original.write.digest);
    assert.equal(JSON.stringify(contentWritePreimage(stored.write, contract)), JSON.stringify(legacyIdentity(original.write)));
    assert.equal(JSON.stringify(authorityPreimage(stored, contract)), JSON.stringify(authorityPreimage(original)));
    assert.notEqual(JSON.stringify(legacyIdentity(stored.write)), JSON.stringify(legacyIdentity(original.write)));
    assert.equal(contentWriteSnapshot(stored.write), contentWriteSnapshot(original.write));
  }
});

test('known legacy input bytes are fixed and never globally sorted', () => {
  const { write } = fixture();
  assert.equal(JSON.stringify(contentInputPreimage(reorder(write.input))),
    '{"productId":"gid://shopify/Product/71","operation":"product_content","title":"Ceramic “cup” ☕","description":"Quoted \\"text\\", slash \\\\, <tag> & coffee\\nSecond line 日本語."}');
  assert.equal(hash(contentInputPreimage(reorder(write.input))), write.digest);
  assert.notEqual(hash(reorder(write.input)), write.digest);
});

test('unknown signed layouts remain legacy, including matching scope extras and unknown consent', () => {
  const cases = [
    f => { f.write.input.workspaceId = 'workspace-fixed'; f.write.digest = hash(f.write.input); f.approval.payload.digest = f.write.digest; },
    f => { f.approval.payload.tenant = { id: 'workspace-fixed' }; },
    f => { f.consent = { actor: 'owner-fixed', at: '2026-10-01T00:00:00.000Z', mode: 'automatic', extra: true }; },
    f => { f.write.objectivePolicyProposal = null; },
    f => { f.write.objectivePolicyProposal.schema = 'unknown/v3'; },
    f => { f.write.objectivePolicyProposal.policies[0].extra = true; },
    f => { f.write.objectivePolicyProposal.source.extra = true; },
    f => { f.write.input.title = ' needs trimming '; },
    f => { f.write.provider = 'meta'; },
    f => { f.write.input.operation = 'internal_note'; },
    f => { f.write.input.operation = 'product_tags_add'; }
  ];
  for (const mutate of cases) {
    const f = fixture('objective-v2'); mutate(f);
    assert.equal(contentWriteIdentityContract(f.write, f.approval, f.consent), null);
  }
});

test('malformed signed rows cannot select the legacy fallback', () => {
  let invoked = 0;
  for (const mutate of [
    f => { f.write[Symbol('hidden')] = true; },
    f => { Object.defineProperty(f.write, 'hidden', { value: true }); },
    f => { Object.defineProperty(f.write.input, 'title', { get() { invoked++; return 'cup'; } }); },
    f => { f.approval.payload.extra = undefined; },
    f => { f.consent = { actor: 'owner-fixed', at: '2026-10-01T00:00:00.000Z', mode: 'automatic', extra: NaN }; }
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => contentWriteIdentityContract(f.write, f.approval, f.consent), { code: 'WRITE_REQUEST_CHANGED' });
  }
  assert.equal(invoked, 0);
});

test('a pinned family rejects signed additions, absence, type changes and another supported family', () => {
  for (const mutate of [
    f => { f.write.input.extra = null; }, f => { delete f.write.input.description; }, f => { f.write.input.title = 12; },
    f => { f.write.requiresApproval = false; }, f => { f.write.approvalId = null; },
    f => { f.write.objectivePolicyProposal = fixture('manual-v1-policy').write.objectivePolicyProposal; }
  ]) {
    const f = fixture(), contract = contentWriteIdentityContract(f.write, f.approval, f.consent); mutate(f);
    assert.throws(() => contentWritePreimage(f.write, contract), { code: 'WRITE_REQUEST_CHANGED' });
  }
  const f = fixture('objective-v2'), contract = contentWriteIdentityContract(f.write, f.approval, f.consent);
  const before = contentWriteSnapshot(f.write), identity = hash(contentWritePreimage(f.write, contract));
  f.write.objectivePolicyProposal.policies.reverse();
  assert.notEqual(contentWriteSnapshot(f.write), before);
  assert.notEqual(hash(contentWritePreimage(f.write, contract)), identity);
});

test('temporary equality is lossless, immutable and insensitive only to object key order', () => {
  const value = { n: 1.25, zero: -0, exponent: 1e100, negative: -2.5, null: null, nested: [{ b: 1, a: 'a\n☕\ud800\0' }],
    oddKeys: { '0': false, '01': true, '__proto__': null, 'a-b': 'value' } };
  const captured = contentWriteSnapshot(value);
  assert.equal(contentWriteSnapshot(reorder(value)), captured);
  value.nested[0].a = 'changed';
  assert.notEqual(contentWriteSnapshot(value), captured);
  for (const [left, right] of [[{}, { a: null }], [{ a: '1' }, { a: 1 }], [[1, 2], [2, 1]],
    [{ a: 0 }, { a: -0 }], [{ a: true }, { a: false }], [{ a: [] }, { a: {} }], [[null], []]]) {
    assert.notEqual(contentWriteSnapshot(left), contentWriteSnapshot(right));
  }
});

test('temporary snapshots reject non-JSON, custom prototypes, cycles, hidden/symbol/accessor fields without invoking them', () => {
  let invoked = 0;
  const getter = Object.defineProperty({}, 'x', { enumerable: true, get() { invoked++; return 1; } });
  const toJSON = { toJSON() { invoked++; return {}; } };
  const arrayGetter = Object.defineProperty([1], '0', { enumerable: true, get() { invoked++; return 1; } });
  const proxy = new Proxy({}, { getPrototypeOf() { invoked++; return Object.prototype; }, ownKeys() { invoked++; return []; } });
  const cycle = {}; cycle.self = cycle;
  const cases = [undefined, 1n, NaN, Infinity, -Infinity, () => {}, Symbol('x'), new Date(), new Map(), new Set(),
    Object.create({ inherited: true }), getter, toJSON, arrayGetter, proxy, cycle, [1, , 2], Object.assign([], { extra: true }),
    Object.defineProperty({}, 'hidden', { value: true }), { [Symbol('x')]: true }, [undefined], { nested: undefined },
    Object.setPrototypeOf([], null), Object.defineProperty([1], '0', { value: 1, enumerable: false })];
  for (const item of cases) assert.throws(() => contentWriteSnapshot(item), { code: 'WRITE_REQUEST_CHANGED' });
  assert.equal(invoked, 0);
});

test('snapshot bounds preserve accepted string sizes and reject excessive bytes, depth and width', () => {
  const accepted = 'x'.repeat(CONTENT_WRITE_SNAPSHOT_MAX_BYTES - 2);
  assert.equal(Buffer.byteLength(contentWriteSnapshot(accepted)), CONTENT_WRITE_SNAPSHOT_MAX_BYTES);
  assert.throws(() => contentWriteSnapshot(accepted + 'x'), { code: 'WRITE_REQUEST_CHANGED' });
  assert.throws(() => contentWriteSnapshot('☕'.repeat(Math.ceil(CONTENT_WRITE_SNAPSHOT_MAX_BYTES / 3))), { code: 'WRITE_REQUEST_CHANGED' });
  let nested = 0;
  for (let depth = 0; depth < CONTENT_WRITE_SNAPSHOT_MAX_DEPTH; depth++) nested = { child: nested };
  assert.doesNotThrow(() => contentWriteSnapshot(nested));
  assert.throws(() => contentWriteSnapshot({ child: nested }), { code: 'WRITE_REQUEST_CHANGED' });
  assert.throws(() => contentWriteSnapshot(Array(CONTENT_WRITE_SNAPSHOT_MAX_BYTES / 2 + 1).fill(0)), { code: 'WRITE_REQUEST_CHANGED' });
});

test('submitted decision equality ignores exactly the three existing completion bookkeeping fields', () => {
  const { approval } = fixture('objective-v2');
  const captured = contentApprovalDecisionSnapshot(approval);
  Object.assign(approval, { executedExternally: true, executionStatus: 'completed', workStatus: 'COMPLETED' });
  assert.equal(contentApprovalDecisionSnapshot(reorder(approval)), captured);
  approval.history[0].note = 'substitution';
  assert.notEqual(contentApprovalDecisionSnapshot(approval), captured);
  let invoked = false;
  Object.defineProperty(approval, 'executionStatus', { get() { invoked = true; return 'completed'; } });
  assert.throws(() => contentApprovalDecisionSnapshot(approval), { code: 'WRITE_REQUEST_CHANGED' });
  assert.equal(invoked, false);
});
