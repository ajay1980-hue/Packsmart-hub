import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { nativeHttpFixture } from './parcel2go-native-http-fixture.mjs';
import { fixture } from './parcel2go-live-integrated-fixture.mjs';
import { KEY, CLIENT, SECRET_VALUE, TOKEN } from './parcel2go-sandbox-fixture.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { deriveExactQuoteApproval } from '../lib/parcel2go-exact-input-producer.mjs';
import { createExactQuoteApproval, decideExactQuoteApproval } from '../lib/parcel2go-exact-approval.mjs';
import { createParcel2GoExactQuoteCandidate as candidate, createParcel2GoLiveAdmission } from '../lib/parcel2go-live-admission.mjs';
import { parcel2GoCanonicalHash as hash } from '../lib/parcel2go-live-canonical.mjs';

const ORIGIN = 'https://synthetic-quote.example.test';
const writes = f => f.calls.filter(call => call.settings.method === 'PATCH');
async function setup(t, responseFor = () => ({})) {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-16T12:00:00.000Z'));
  let context;
  const calls = nativeHttpFixture(t, operation => responseFor(operation, context));
  const f = await fixture(), workspaceId = f.config.trustedBinding.workspaceId;
  const state = await f.store.get(workspaceId, { exactSnapshot: true }), user = state.users[0];
  const token = createSessionToken({ userId: user.id, workspaceId, email: user.email, role: 'owner', csrf: f.session.csrf }, KEY);
  const session = verifySessionToken(token, KEY, f.getTime() / 1000), auth = { state, session, user };
  const derived = deriveExactQuoteApproval({ mode: 'synthetic-input-derivation/v1', auth, input: f.args.input,
    requestId: f.config.requestId, connectionId: f.config.trustedBinding.connectionId, termsReference: f.config.termsReference,
    accountEvidenceReference: 'synthetic-entitlement', expectedAccountEvidenceReference: 'synthetic-entitlement',
    expectedCredentialReceiptHash: f.config.expectedCredentialReceiptHash, now: f.getTime() });
  await createExactQuoteApproval({ mode: 'local-contract/v1', store: f.store, auth, intent: derived.intent, now: f.getTime });
  const approvalId = derived.intent.approval.id, operationHash = derived.intent.approval.payload.operationHash;
  const next = decideExactQuoteApproval({ mode: 'local-contract/v1', state: await f.store.get(workspaceId, { exactSnapshot: true }),
    auth, approvalId, confirmation: { decision: 'approved', revision: 1, operationHash }, now: f.getTime() });
  await f.store.save(workspaceId, next, { ownedSnapshot: true });
  const saved = await f.store.get(workspaceId, { exactSnapshot: true });
  const options = { mode: 'unmounted-exact-https-candidate/v1', origin: ORIGIN, sessionSecret: KEY,
    // Deliberately no process-local serialization: concurrency must rely on CAS.
    withWorkspaceLock: async (id, run) => { assert.equal(id, workspaceId); return run(); },
    admission: { ...f.config, mode: 'disabled/v1', mockRequest: undefined, expectedRevision: saved._revision,
      expectedSessionFingerprint: hash(session) },
    exactApproval: { approvalId, operationHash, accountEvidenceReference: 'synthetic-entitlement' } };
  const make = (extra = {}) => candidate({ ...options, ...extra,
    admission: { ...options.admission, ...extra.admission }, exactApproval: { ...options.exactApproval, ...extra.exactApproval } });
  const controller = new AbortController();
  const request = { headers: { cookie: `__Host-packsmart_session=${token}`, origin: ORIGIN, 'x-csrf-token': session.csrf },
    signal: controller.signal, input: structuredClone(f.args.input),
    confirmation: { approvalId, operationHash, requestId: f.config.requestId, confirmed: true } };
  const runner = make(); t.after(() => runner.close()); f.calls.length = 0;
  context = { f, calls, options, request, runner, make, controller, saved, workspaceId, session, token };
  return context;
}
const row = c => c.f.fake.states.get(c.workspaceId).parcel2goLiveQuoteRuns.find(r => r.requestId === c.options.admission.requestId);
function redacted(value) {
  const text = JSON.stringify(value);
  for (const secret of [KEY, CLIENT, SECRET_VALUE, TOKEN]) assert.equal(text.includes(secret), false);
}

test('default disabled and direct native configuration cannot bypass exact admission', async () => {
  const runner = candidate({ get admission() { assert.fail('Disabled candidate read configuration'); } });
  await assert.rejects(runner.run({}));
  assert.throws(() => createParcel2GoLiveAdmission({ mode: 'approved-https-integrated/v1', exactApproval: {} }));
});

test('signed owner and saved exact decision reach durable native transport with audited identity', async t => {
  const c = await setup(t), out = await c.runner.run(c.request);
  assert.equal(out.status, 'completed'); assert.equal(out.fixture, false, 'native code marker; all IO is intercepted');
  assert.equal(out.liveReady, false); assert.equal(out.purchaseAllowed, false);
  assert.equal(out.quote.responseSource, 'live-http'); assert.equal(out.quote.quotes[0].totalDecimal, '12.66');
  assert.deepEqual(c.calls.map(call => new URL(call.url).pathname), ['/auth/connect/token', '/api/quotes']);
  assert.equal(writes(c.f).length, 2);
  const receipt = row(c), approval = c.saved.approvals.find(a => a.id === c.options.exactApproval.approvalId);
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.projectionHash, hash(out.quote));
  assert.deepEqual(receipt.exactApproval, { approvalId: approval.id, operationHash: approval.payload.operationHash,
    decisionHash: hash(approval.decisionEvidence) });
  assert.equal(JSON.stringify(receipt).includes('12.66'), false); redacted(out); redacted(receipt);
  const stored = c.f.fake.states.get(c.workspaceId);
  const audits = stored.audit.filter(a => a.detail.requestId === c.options.admission.requestId);
  assert.deepEqual(audits.map(a => a.type), ['parcel2go_live_completed', 'parcel2go_live_reserved']);
  for (const audit of audits) assert.equal(audit.detail.approvalId, approval.id);
  for (const field of ['approvals', 'connections', 'users', 'orders', 'products', 'autopilot', 'agentOps']) {
    assert.deepEqual(stored[field], c.saved[field], field);
  }
  await assert.rejects(c.runner.run(c.request));
  await assert.rejects(c.make({ admission: { expectedRevision: stored._revision } }).run(c.request));
  assert.equal(c.calls.length, 2); assert.equal(writes(c.f).length, 2);
});

for (const bad of ['cookie', 'bearer', 'tenant', 'csrf', 'origin', 'confirmation', 'input', 'pending', 'rejected',
  'operation', 'receipt', 'account', 'terms', 'evidence', 'new-request-id', 'decision', 'async-guard']) {
  test(`exact native admission refuses ${bad} before reservation`, async t => {
    const c = await setup(t), extra = {}, stored = c.f.fake.states.get(c.workspaceId);
    const approval = stored.approvals.find(a => a.id === c.options.exactApproval.approvalId);
    if (bad === 'cookie') c.request.headers.cookie += 'tampered';
    if (bad === 'bearer') { delete c.request.headers.cookie; c.request.headers.authorization = `Bearer ${c.token}`; }
    if (bad === 'tenant') c.request.headers.cookie = '__Host-packsmart_session=' + createSessionToken({
      userId: c.session.sub, workspaceId: 'synthetic-other-tenant', email: c.session.email, role: 'owner', csrf: c.session.csrf }, KEY);
    if (bad === 'csrf') c.request.headers['x-csrf-token'] = 'wrong';
    if (bad === 'origin') c.request.headers.origin = 'https://synthetic-other.example.test';
    if (bad === 'confirmation') c.request.confirmation.confirmed = false;
    if (bad === 'input') c.request.input.parcel.weightGrams = '6000';
    if (bad === 'pending' || bad === 'rejected') approval.status = bad;
    if (bad === 'operation') extra.exactApproval = { operationHash: '0'.repeat(64) };
    if (bad === 'receipt') extra.admission = { expectedCredentialReceiptHash: '0'.repeat(64) };
    if (bad === 'account') extra.admission = { trustedBinding: { ...c.options.admission.trustedBinding, accountId: 'synthetic-other' } };
    if (bad === 'terms') extra.admission = { termsReference: 'synthetic-other-terms' };
    if (bad === 'evidence') extra.exactApproval = { accountEvidenceReference: 'synthetic-other-entitlement' };
    if (bad === 'new-request-id') { const requestId = randomUUID(); extra.admission = { requestId }; c.request.confirmation.requestId = requestId; }
    if (bad === 'decision') approval.decisionEvidence.operationHash = '0'.repeat(64);
    if (bad === 'async-guard') extra.admission = { assertCurrent: async () => {} };
    await assert.rejects(c.make(extra).run(c.request));
    assert.equal(c.calls.length, 0); assert.equal(writes(c.f).length, 0);
  });
}

test('two independent candidates compete through primary CAS for one provider pair', async t => {
  const c = await setup(t);
  const outcomes = await Promise.allSettled([c.runner.run(c.request), c.make().run(c.request)]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(c.calls.length, 2); assert.equal(row(c).status, 'completed');
});

test('a consistent approval hash cannot authorize a misleading parcel summary', async t => {
  const c = await setup(t), approval = c.f.fake.states.get(c.workspaceId).approvals.find(a => a.id === c.options.exactApproval.approvalId);
  approval.payload.operation.reviewSummary.parcel = 'Synthetic parcel summary that disagrees with the wire input';
  const operationHash = hash(approval.payload.operation);
  approval.payload.operationHash = operationHash; approval.decisionEvidence.operationHash = operationHash;
  approval.requestIdentity.contentSha256 = hash({ type: approval.type, payload: approval.payload });
  c.request.confirmation.operationHash = operationHash;
  await assert.rejects(c.make({ exactApproval: { operationHash } }).run(c.request));
  assert.equal(c.calls.length, 0); assert.equal(writes(c.f).length, 0);
});

test('durable approval identity prevents replay even if its request ID is replaced', async t => {
  const c = await setup(t); await c.runner.run(c.request);
  const saved = c.f.fake.states.get(c.workspaceId), requestId = randomUUID();
  saved.approvals.find(a => a.id === c.options.exactApproval.approvalId).requestIdentity.requestId = requestId;
  c.request.confirmation.requestId = requestId;
  await assert.rejects(c.make({ admission: { requestId, expectedRevision: saved._revision } }).run(c.request));
  assert.equal(c.calls.length, 2); assert.equal(writes(c.f).length, 2);
});

for (const change of ['expired', 'monotonic', 'rollback', 'abort', 'closed']) {
  test(`${change} candidate refuses before provider or store writes`, async t => {
    const c = await setup(t);
    if (change === 'expired') c.f.advance(300000);
    if (change === 'monotonic') c.f.setMono(300000);
    if (change === 'rollback') c.f.advance(-1);
    if (change === 'abort') c.controller.abort();
    if (change === 'closed') c.runner.close();
    await assert.rejects(c.runner.run(c.request));
    assert.equal(c.calls.length, 0); assert.equal(writes(c.f).length, 0);
  });
}

for (const boundary of ['token', 'quote']) for (const change of ['approval', 'owner', 'credential', 'expiry', 'abort']) {
  test(`${change} after ${boundary} prevents completion and leaves the reservation spent`, async t => {
    const c = await setup(t, (operation, c) => {
      if (operation !== boundary) return;
      const state = c.f.fake.states.get(c.workspaceId);
      if (change === 'approval') state.approvals.find(a => a.id === c.options.exactApproval.approvalId).status = 'rejected';
      if (change === 'owner') state.users[0].active = false;
      if (change === 'credential') state.connections.find(x => x.id === c.options.admission.trustedBinding.connectionId).encryptedCredentials = 'synthetic-replaced';
      if (change === 'expiry') c.f.advance(300000);
      if (change === 'abort') c.controller.abort();
    });
    await assert.rejects(c.runner.run(c.request));
    assert.equal(c.calls.length, boundary === 'token' ? 1 : 2);
    assert.equal(writes(c.f).length, 1); assert.equal(row(c).status, 'reserved');
    await assert.rejects(c.runner.run(c.request));
  });
}

for (const failure of ['reservation_ack', 'quote_response', 'completion_ack']) {
  test(`uncertain ${failure} cannot replay through a fresh candidate`, async t => {
    const c = await setup(t, operation => failure === 'quote_response' && operation === 'quote' ? { reset: true } : {});
    const save = c.f.store.save.bind(c.f.store); let count = 0;
    c.f.store.save = async (...args) => {
      const out = await save(...args); count++;
      if (failure === 'reservation_ack' && count === 1 || failure === 'completion_ack' && count === 2) throw Error('Synthetic acknowledgement lost');
      return out;
    };
    await assert.rejects(c.runner.run(c.request), error => { redacted({ message: error.message, code: error.code }); return true; });
    assert.equal(row(c).status, failure === 'completion_ack' ? 'completed' : 'reserved');
    assert.equal(c.calls.length, failure === 'reservation_ack' ? 0 : 2);
    const before = c.calls.length, saves = writes(c.f).length;
    await assert.rejects(c.make({ admission: { expectedRevision: c.f.fake.states.get(c.workspaceId)._revision } }).run(c.request));
    assert.equal(c.calls.length, before); assert.equal(writes(c.f).length, saves);
  });
}

test('post-completion guard cannot release a result after closing the window', async t => {
  const c = await setup(t);
  const runner = c.make({ admission: { assertCurrent: () => { if (row(c)?.status === 'completed') c.f.advance(300000); } } });
  await assert.rejects(runner.run(c.request));
  assert.equal(c.calls.length, 2); assert.equal(row(c).status, 'completed');
});
