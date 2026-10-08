import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
import { reviewedActionFixture } from './reviewed-action-test-fixture.mjs';
import { CONTENT_EXECUTION_RECEIPT_CONTRACT, CONTENT_EXECUTION_RECEIPT_ACK_SCHEMA,
  prepareContentExecutionAdmission, completeContentExecutionReceipt, assertContentReceiptAcknowledgement,
  contentReceiptRequestFingerprint } from '../lib/content-execution-receipt.mjs';
import { prepareContentReceiptTransaction, commitContentReceiptTransaction,
  CONTENT_RECEIPT_TRANSACTION_MAX_BYTES, CONTENT_RECEIPT_HTTP_BODY_MAX_BYTES } from '../lib/content-execution-receipt-store.mjs';

const WS = 'tenant-a', SECRET = 'private-source-body-do-not-log';
const env = { SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-test-key',
  CONTENT_EXECUTION_RECEIPT_CONTRACT };
function fixture(kind = 'reserve') {
  const f = reviewedActionFixture({ description: SECRET }), phase = f.write.dispatchClaim.phases.shopify_mutation;
  const reserve = prepareContentExecutionAdmission({ state: f.state, write: f.write, preparedInput: f.write.input,
    actor: 'user_owner', actorSession: { sessionVersion: 1 }, approval: f.approval,
    objectivePolicy: { workspaceId: WS, policies: [] }, dispatchRequestDigest: phase.requestDigest,
    claimId: f.write.dispatchClaim.id, claimIdentity: f.write.dispatchClaim.identity,
    authorityDigest: f.write.dispatchClaim.authority, apiVersion: '2026-07', phaseAt: phase.at,
    comparisonContract: 'runvara-reviewed-action/v1' });
  const state = { ...seedWorkspaceState({}, { workspaceId: WS, userId: 'user_owner', email: 'owner@example.test' }),
    ...f.state, _revision: randomUUID() };
  const descriptor = kind === 'reserve' ? reserve : completeContentExecutionReceipt(reserve,
    { completedAt: f.write.completedAt, resultId: f.write.input.productId });
  return { ...f, state, descriptor };
}
function ackFor(r, raw, replayed = false) {
  return { schema: CONTENT_EXECUTION_RECEIPT_ACK_SCHEMA, kind: r.kind, workspaceId: r.workspaceId,
    attemptId: r.admission.attemptId, admissionDigest: r.admission.digest, intentDigest: r.admission.intentDigest,
    requestFingerprint: contentReceiptRequestFingerprint(raw), expectedRevision: r.expectedRevision, nextRevision: r.nextRevision,
    receiptDigest: r.kind === 'finalize' ? r.receipt.digest : null, reservedBytes: 40960, replayed };
}
function protectedFake(state, { mutate, lookup, ordinary } = {}) {
  const fake = fakeSupabase({ initialStates: [state] }), ledger = new Map(); let mutations = 0, reads = 0;
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input), table = url.pathname.split('/').pop();
    if (['runvara_reserve_content_receipt', 'runvara_finalize_content_receipt'].includes(table)) {
      fake.calls.push({ url, method: options.method, headers: options.headers, body: options.body });
      const outer = JSON.parse(options.body);
      assert.deepEqual(Object.keys(outer), ['p_request_json']);
      const raw = outer.p_request_json, request = JSON.parse(raw), key = `${request.kind}:${request.admission.attemptId}`;
      const commit = () => {
        const saved = ledger.get(key);
        if (saved) return saved.raw === raw ? Response.json({ ...saved.ack, replayed: true }) : Response.json({ code: 'P0R04' }, { status: 409 });
        if (fake.states.get(WS)._revision !== request.expectedRevision) return Response.json({ code: 'P0R02' }, { status: 409 });
        const ack = ackFor(request, raw);
        ledger.set(key, { raw, ack }); fake.states.set(WS, structuredClone(request.state));
        return Response.json(ack);
      };
      const index = ++mutations;
      return mutate ? mutate({ index, request, raw, commit, fake, ledger }) : commit();
    }
    if (table === 'runvara_read_content_receipt') {
      fake.calls.push({ url, method: options.method, headers: options.headers, body: options.body });
      const p = JSON.parse(options.body);
      assert.deepEqual(Object.keys(p).sort(), ['p_workspace_id','p_attempt_id','p_kind','p_request_fingerprint','p_actor_id','p_actor_session_version'].sort());
      assert.equal(p.p_workspace_id, WS); assert.equal(p.p_actor_id, 'user_owner'); assert.equal(p.p_actor_session_version, 1);
      assert.ok(Buffer.byteLength(options.body) <= 4096); assert.ok(!options.body.includes(SECRET));
      const read = () => {
        const saved = ledger.get(`${p.p_kind}:${p.p_attempt_id}`);
        return Response.json(saved && saved.ack.requestFingerprint === p.p_request_fingerprint ? { ...saved.ack, replayed: true } : null);
      };
      const index = ++reads;
      return lookup ? lookup({ index, params: p, read, fake, ledger }) : read();
    }
    if (ordinary) await ordinary({ url, options, fake });
    return fake.fetchImpl(input, options);
  };
  return { ...fake, ledger, fetchImpl, counts: () => ({ mutations, reads }) };
}
const rpcCalls = fake => fake.calls.filter(c => /runvara_(reserve|finalize|read)_content_receipt$/.test(c.url.pathname));

test('default capability is private and disabled; missing, unknown, invalid baseline and FileStore fail before I/O', async () => {
  const f = fixture();
  for (const marker of [undefined, null, '', false, 0, 'runvara-content-execution-receipts/v2']) {
    let calls = 0;
    const store = createStore({ ...env, CONTENT_EXECUTION_RECEIPT_CONTRACT: marker }, { fetchImpl: async () => { calls++; throw new Error('Unexpected I/O'); } });
    assert.equal(store.contentExecutionReceiptCapability, marker ?? null);
    assert.equal(Object.keys(store).includes('contentExecutionReceiptCapability'), false);
    assert.throws(() => { store.contentExecutionReceiptCapability = CONTENT_EXECUTION_RECEIPT_CONTRACT; }, TypeError);
    await assert.rejects(store.save(WS, f.state, { protectedContentCommit: f.descriptor }), { code: 'CONTENT_RECEIPT_UNAVAILABLE' });
    assert.equal(calls, 0);
  }
  const file = createStore({ CONTENT_EXECUTION_RECEIPT_CONTRACT, SAAS_STATE_FILE: '/tmp/unused-receipt-contract.json' });
  await assert.rejects(file.save(WS, f.state, { protectedContentCommit: f.descriptor }), { code: 'CONTENT_RECEIPT_UNAVAILABLE' });
  const store = createStore(env, { fetchImpl: async () => { throw new Error('Unexpected I/O'); } });
  await assert.rejects(store.save(WS, { ...f.state, _revision: 'legacy-revision' }, { protectedContentCommit: f.descriptor }), { code: 'CONTENT_RECEIPT_INVALID' });
});

test('normal protected save replaces only primary request, preserves reporting and binds private ACK to primary revisions', async () => {
  for (const kind of ['reserve', 'finalize']) {
    const f = fixture(kind), fake = protectedFake(f.state), store = createStore(env, { fetchImpl: fake.fetchImpl });
    const before = f.state._revision;
    const saved = await store.save(WS, f.state, { protectedContentCommit: f.descriptor });
    const ack = assertContentReceiptAcknowledgement(saved, structuredClone(f.descriptor)), calls = rpcCalls(fake);
    assert.equal(calls.length, 1); assert.equal(ack.expectedRevision, before); assert.notEqual(saved._revision, ack.nextRevision);
    assert.equal(fake.states.get(WS)._revision, saved._revision); assert.equal(saved.integrationStatus.reporting.status, 'connected');
    assert.ok(fake.calls.some(c => c.url.pathname.endsWith('/runvara_commit_reporting_status')));
    assert.equal(fake.calls.filter(c => c.method === 'PATCH').length, 0);
    assert.ok(fake.tables.has('users')); assert.ok(store.schedulerCache.has(WS));
    const wire = JSON.parse(JSON.parse(calls[0].body).p_request_json);
    assert.equal(wire.expectedRevision, before); assert.equal(wire.nextRevision, ack.nextRevision);
    assert.equal(ack.requestFingerprint, contentReceiptRequestFingerprint(JSON.parse(calls[0].body).p_request_json));
    assert.ok(!JSON.stringify(saved).includes('requestFingerprint')); assert.ok(!JSON.stringify(saved).includes('content_attempt_'));
    assert.throws(() => assertContentReceiptAcknowledgement(structuredClone(saved), f.descriptor), { code: 'CONTENT_RECEIPT_ACK_INVALID' });
    const observed = store.activitySnapshot(WS);
    assert.equal(observed.db.operations.state_commit, 1); assert.equal(observed.db.operations.reporting_commit, 1);
    assert.equal(observed.db.requestBody.bytes, fake.calls.reduce((n, c) => n + Buffer.byteLength(c.body), 0));
    assert.ok(!JSON.stringify(store.diagnostics()).includes(SECRET)); assert.ok(!JSON.stringify(observed).includes(SECRET));
  }
});

test('protected snapshot and descriptor detach before archive awaits and transport bytes detach before RPC awaits', async () => {
  const f = fixture(), descriptor = structuredClone(f.descriptor), original = structuredClone(descriptor);
  f.state.workRecords = Array.from({ length: 101 }, (_, i) => ({ id: `work_${i}`, text: 'original' }));
  let mutated = false;
  const fake = protectedFake(f.state, { ordinary: async ({ url }) => {
    if (!mutated && url.pathname.endsWith('/runvara_history')) {
      mutated = true; descriptor.sourceTemplate.input.description = 'changed descriptor'; descriptor.admission.actorId = 'other';
      f.state.connectionWrites[0].input.description = 'changed caller'; f.state.workRecords[0].text = 'changed history';
    }
  }, mutate: async ({ raw, request, commit }) => {
    f.state.workspace.name = 'changed during send'; await Promise.resolve();
    assert.equal(JSON.parse(raw).state.connectionWrites[0].input.description, SECRET);
    assert.equal(request.state.workRecords[0].text, 'original');
    assert.deepEqual(request.sourceTemplate, original.sourceTemplate); return commit();
  } });
  const store = createStore(env, { fetchImpl: fake.fetchImpl });
  const saved = await store.save(WS, f.state, { protectedContentCommit: descriptor });
  assert.equal(mutated, true); assert.equal(saved.connectionWrites[0].input.description, SECRET);
  assert.ok(assertContentReceiptAcknowledgement(saved, original));
});

test('missing/denied/schema mismatched RPC and deterministic SQL failures never retry, look up or fall back', async () => {
  const failures = { PGRST202: 'CONTENT_RECEIPT_UNAVAILABLE', '42501': 'CONTENT_RECEIPT_UNAVAILABLE',
    '42P01': 'CONTENT_RECEIPT_UNAVAILABLE', P0R01: 'CONTENT_RECEIPT_INVALID', P0R02: 'STATE_CONFLICT',
    P0R03: 'CONTENT_RECEIPT_ACTOR_REQUIRED', P0R04: 'CONTENT_RECEIPT_IDENTITY_CONFLICT',
    P0R05: 'CONTENT_RECEIPT_CAPACITY_EXHAUSTED', P0R06: 'CONTENT_RECEIPT_GUARD_REQUIRED', P0R07: 'CONTENT_RECEIPT_UNAVAILABLE',
    P0O10: 'CONTENT_RECEIPT_TOO_LARGE' };
  for (const [databaseCode, code] of Object.entries(failures)) {
    const f = fixture(), fake = protectedFake(f.state, { mutate: () => Response.json({ code: databaseCode, message: SECRET }, { status: 409 }) });
    const store = createStore(env, { fetchImpl: fake.fetchImpl }), before = f.state._revision;
    await assert.rejects(store.save(WS, f.state, { protectedContentCommit: f.descriptor }), error => error.code === code && !String(error).includes(SECRET));
    assert.deepEqual(fake.counts(), { mutations: 1, reads: 0 }); assert.equal(fake.calls.length, 1);
    assert.equal(f.state._revision, before); assert.equal(fake.states.get(WS)._revision, before);
  }
});

test('stale primary CAS refuses receipt without installing an old snapshot', async () => {
  const f = fixture('finalize'), fake = protectedFake(f.state), newer = randomUUID(); fake.states.get(WS)._revision = newer;
  const store = createStore(env, { fetchImpl: fake.fetchImpl });
  await assert.rejects(store.save(WS, f.state, { protectedContentCommit: f.descriptor }), { code: 'STATE_CONFLICT' });
  assert.equal(fake.states.get(WS)._revision, newer); assert.equal(fake.ledger.size, 0); assert.equal(fake.calls.length, 1);
});

test('lost ACK before or after a newer revision proves original transaction and skips all stale maintenance', async () => {
  for (const kind of ['reserve', 'finalize']) for (const newer of [false, true]) {
    const f = fixture(kind); let committedRevision;
    const fake = protectedFake(f.state, { mutate: ({ request, commit, fake }) => {
      commit(); committedRevision = request.nextRevision;
      if (newer) { const current = fake.states.get(WS); current._revision = randomUUID(); current.workspace.name = 'newer committed workspace'; }
      throw new Error(SECRET);
    } });
    const store = createStore(env, { fetchImpl: fake.fetchImpl }); store.rememberSchedulerState(WS, f.state); store.mirrorRevisions.set(WS, f.state._revision);
    store.mirrorDigests.set(`${WS}:users`, 'prior');
    const saved = await store.save(WS, f.state, { protectedContentCommit: f.descriptor });
    const ack = assertContentReceiptAcknowledgement(saved, f.descriptor);
    assert.equal(ack.replayed, true); assert.equal(saved._revision, committedRevision);
    assert.equal(f.state._revision, committedRevision, 'reserve and final continuations use only their proven primary revision');
    assert.deepEqual(fake.counts(), { mutations: 1, reads: 1 }); assert.equal(fake.calls.length, 2);
    assert.equal(store.schedulerCache.has(WS), false); assert.equal(store.mirrorRevisions.has(WS), false); assert.equal(store.mirrorDigests.size, 0);
    if (newer) { assert.notEqual(fake.states.get(WS)._revision, saved._revision); assert.equal(fake.states.get(WS).workspace.name, 'newer committed workspace'); }
    const activity = store.activitySnapshot(WS); assert.equal(activity.db.operations.state_commit, 1); assert.equal(activity.db.operations.state_read, 1);
    assert.equal(activity.db.operations.reporting_commit, 0); assert.equal(activity.db.operations.reporting_write, 0);
  }
});

test('unknown first commit retries exact frozen body once and never uses revision-only recovery', async () => {
  const f = fixture('finalize'), fake = protectedFake(f.state, { mutate: ({ index, commit }) => {
    if (index === 1) throw new Error('connection dropped before send'); return commit();
  } });
  const store = createStore(env, { fetchImpl: fake.fetchImpl }), saved = await store.save(WS, f.state, { protectedContentCommit: f.descriptor });
  assert.ok(assertContentReceiptAcknowledgement(saved, f.descriptor));
  assert.deepEqual(fake.counts(), { mutations: 2, reads: 1 }); assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls[0].body, fake.calls[2].body); assert.equal(fake.calls[0].url.href, fake.calls[2].url.href);
  assert.equal(store.activitySnapshot(WS).db.retries.primary_network_reconciled, 1);
  assert.equal(store.schedulerCache.has(WS), false);
});

test('known cancellation retries exactly once and preserves ordinary maintenance after clean retry', async () => {
  for (const always of [false, true]) {
    const f = fixture(), fake = protectedFake(f.state, { mutate: ({ index, commit }) => index === 1 || always ? Response.json({ code: '57014' }, { status: 500 }) : commit() });
    const store = createStore(env, { fetchImpl: fake.fetchImpl });
    if (always) await assert.rejects(store.save(WS, f.state, { protectedContentCommit: f.descriptor }), { code: 'CONTENT_RECEIPT_COMMIT_UNCONFIRMED' });
    else assert.ok(assertContentReceiptAcknowledgement(await store.save(WS, f.state, { protectedContentCommit: f.descriptor }), f.descriptor));
    assert.deepEqual(fake.counts(), { mutations: 2, reads: 0 }); assert.equal(fake.calls[0].body, fake.calls[1].body);
    assert.equal(store.activitySnapshot(WS).db.retries.primary_statement_cancelled, 1);
    if (!always) assert.ok(fake.calls.some(c => c.url.pathname.endsWith('/runvara_commit_reporting_status')));
  }
});

test('a retry denial or cancellation cannot downgrade an earlier ambiguous transaction', async () => {
  for (const kind of ['reserve','finalize']) for (const second of ['403','57014']) for (const late of ['absent','committed','lookup-unavailable']) {
    const f = fixture(kind); let lateCommit;
    const fake = protectedFake(f.state, { mutate: ({ index, commit }) => {
      if (index === 1) { lateCommit = commit; throw new Error('Synthetic first response lost'); }
      return second === '403' ? Response.json({ code: '42501' }, { status: 403 }) : Response.json({ code: '57014' }, { status: 500 });
    }, lookup: ({ index, read }) => {
      if (index === 1) { if (late !== 'absent') lateCommit(); return Response.json(null); }
      if (late === 'lookup-unavailable') throw new Error('Synthetic exact lookup unavailable');
      return read();
    } });
    const store = createStore(env, { fetchImpl: fake.fetchImpl });
    if (late === 'committed') {
      const saved = await store.save(WS, f.state, { protectedContentCommit: f.descriptor });
      assert.equal(assertContentReceiptAcknowledgement(saved, f.descriptor).replayed, true);
    } else await assert.rejects(store.save(WS, f.state, { protectedContentCommit: f.descriptor }), { code: 'CONTENT_RECEIPT_COMMIT_UNCONFIRMED' });
    assert.deepEqual(fake.counts(), { mutations: 2, reads: 2 });
    assert.equal(fake.ledger.size, late === 'absent' ? 0 : 1);
    assert.equal(fake.calls.length, 4, 'No fallback state save or reporting follows ambiguity');
  }
});

test('null, unavailable, inexact or malformed lookup never proves commit; retries remain bounded', async () => {
  for (const mode of ['null', 'unavailable', 'wrong-fingerprint', 'array', 'not-replayed', 'unknown-field', 'oversized']) {
    const f = fixture('finalize'); let ack;
    const fake = protectedFake(f.state, { mutate: ({ request, raw }) => { ack = ackFor(request, raw, true); throw new Error(SECRET); },
      lookup: () => {
        if (mode === 'unavailable') throw new Error(SECRET);
        if (mode === 'null') return Response.json(null);
        if (mode === 'array') return Response.json([ack]);
        if (mode === 'wrong-fingerprint') return Response.json({ ...ack, requestFingerprint: 'a'.repeat(64) });
        if (mode === 'not-replayed') return Response.json({ ...ack, replayed: false });
        return Response.json({ ...ack, extra: mode === 'oversized' ? SECRET.repeat(1000) : 'unexpected' });
      } });
    const store = createStore(env, { fetchImpl: fake.fetchImpl });
    await assert.rejects(store.save(WS, f.state, { protectedContentCommit: f.descriptor }), { code: 'CONTENT_RECEIPT_COMMIT_UNCONFIRMED' });
    assert.deepEqual(fake.counts(), { mutations: 2, reads: 2 }); assert.equal(fake.calls.length, 4);
    assert.equal(fake.calls[0].body, fake.calls[2].body); assert.equal(store.schedulerCache.has(WS), false);
    assert.ok(!JSON.stringify(store.diagnostics()).includes(SECRET));
  }
});

test('every ACK identity, digest, fence, count and boolean is mandatory and exact', async () => {
  const f = fixture('finalize'), next = { ...f.state, _revision: randomUUID() };
  const transaction = prepareContentReceiptTransaction(WS, next, f.state._revision, f.descriptor);
  const good = { ...transaction.expectedAck, replayed: false };
  const altered = Object.keys(good).map(key => ({ ...good, [key]: key === 'replayed' ? 'false' : key === 'reservedBytes' ? 1 : 'altered' }));
  altered.push({ ...good, extra: true }, Object.fromEntries(Object.entries(good).filter(([key]) => key !== 'intentDigest')));
  for (const ack of altered) {
    let mutations = 0, lookups = 0;
    await assert.rejects(commitContentReceiptTransaction(transaction, async (op) => {
      if (op === 'state_read') { lookups++; return null; } mutations++; return ack;
    }), { code: 'CONTENT_RECEIPT_COMMIT_UNCONFIRMED' });
    assert.equal(mutations, 2); assert.equal(lookups, 2);
  }
});

test('exact duplicate replay returns original proof; changed body under same attempt fails without rebasing', async () => {
  const f = fixture('finalize'), fake = protectedFake(f.state), next = { ...f.state, _revision: randomUUID() };
  const store = createStore(env, { fetchImpl: fake.fetchImpl });
  const first = await store.commit(WS, next, f.state._revision, true, { protectedContentCommit: f.descriptor });
  assert.equal(first.recovered, false);
  fake.states.get(WS)._revision = randomUUID();
  const second = await store.commit(WS, next, f.state._revision, true, { protectedContentCommit: f.descriptor });
  assert.equal(second.recovered, true); assert.equal(second.ack.replayed, true);
  await assert.rejects(store.commit(WS, { ...next, privateChange: true }, f.state._revision, true,
    { protectedContentCommit: f.descriptor }), { code: 'CONTENT_RECEIPT_IDENTITY_CONFLICT' });
  assert.deepEqual(fake.counts(), { mutations: 3, reads: 0 });
});

test('state, transaction and encoded HTTP byte caps reject before transport and measure escaped bodies', async () => {
  const f = fixture(), next = { ...f.state, _revision: randomUUID() };
  assert.throws(() => prepareContentReceiptTransaction(WS, { ...next, oversize: 'x'.repeat(2097152) }, f.state._revision, f.descriptor), { code: 'STATE_SIZE_LIMIT' });
  const escaped = prepareContentReceiptTransaction(WS, { ...next, escaped: '\\"'.repeat(450000) }, f.state._revision, f.descriptor);
  const raw = JSON.parse(escaped.body).p_request_json;
  assert.ok(Buffer.byteLength(raw) <= CONTENT_RECEIPT_TRANSACTION_MAX_BYTES);
  assert.ok(Buffer.byteLength(escaped.body) <= CONTENT_RECEIPT_HTTP_BODY_MAX_BYTES);
  assert.ok(Buffer.byteLength(escaped.body) > Buffer.byteLength(raw));
  assert.equal(escaped.expectedAck.requestFingerprint, contentReceiptRequestFingerprint(raw));
  assert.equal(Object.isFrozen(escaped), true); assert.equal(Object.isFrozen(escaped.descriptor.sourceTemplate.input), true);
});

test('normal protected saves retain baseline mirror/reporting request counts and measure bounded overhead', async t => {
  for (const kind of ['reserve', 'finalize']) for (const warm of [false, true]) {
    const f = fixture(kind), plain = fakeSupabase({ initialStates: [f.state] }), guarded = protectedFake(f.state);
    const ordinaryStore = createStore(env, { fetchImpl: plain.fetchImpl }), protectedStore = createStore(env, { fetchImpl: guarded.fetchImpl });
    let ordinaryState = structuredClone(f.state), protectedState = structuredClone(f.state);
    if (warm) {
      ordinaryState = await ordinaryStore.save(WS, ordinaryState); protectedState = await protectedStore.save(WS, protectedState);
      plain.calls.length = 0; guarded.calls.length = 0;
    }
    await ordinaryStore.save(WS, ordinaryState);
    const result = await protectedStore.save(WS, protectedState, { protectedContentCommit: f.descriptor });
    assert.equal(plain.calls.length, guarded.calls.length);
    const normalize = call => call.url.pathname.endsWith('/saas_workspace_state') || /runvara_(reserve|finalize)_content_receipt$/.test(call.url.pathname)
      ? 'primary' : `${call.method}:${call.url.pathname}`;
    assert.deepEqual(plain.calls.map(normalize), guarded.calls.map(normalize));
    const commit = rpcCalls(guarded)[0], baseline = plain.calls.find(c => c.method === 'PATCH');
    const reporting = guarded.calls.filter(c => c.url.pathname.endsWith('/runvara_commit_reporting_status'));
    const wire = JSON.parse(commit.body).p_request_json;
    t.diagnostic(JSON.stringify({ kind, warm, httpRequests: guarded.calls.length, protectedPrimaryRequests: 1, baselinePrimaryRequests: 1,
      reportingRequests: reporting.length, primaryBodyBytes: Buffer.byteLength(commit.body), primaryTextBytes: Buffer.byteLength(wire),
      baselinePrimaryBodyBytes: Buffer.byteLength(baseline.body), reportingBodyBytes: Buffer.byteLength(reporting[0].body) }));
    // Reusing a retained attempt with a new whole-state transaction cannot be
    // mistaken for an exact retransmission or accepted under a new fence.
    const previous = result._revision, start = guarded.calls.length;
    await protectedStore.save(WS, result, { protectedContentCommit: f.descriptor }).catch(error => {
      // A new transaction under an old attempt is an intentional conflict.
      assert.equal(error.code, 'CONTENT_RECEIPT_IDENTITY_CONFLICT');
    });
    assert.equal(guarded.calls.slice(start).length, 1); assert.equal(result._revision, previous);
  }
});

test('malformed success can be recovered only by matching exact durable ACK, even after newer state', async () => {
  for (const mode of ['empty', 'invalid-json', 'oversized', 'wrong-workspace', 'direct-replay']) {
    const f = fixture('finalize');
    const fake = protectedFake(f.state, { mutate: ({ request, raw, commit, fake }) => {
      commit(); fake.states.get(WS)._revision = randomUUID();
      if (mode === 'empty') return new Response(null, { status: 204 });
      if (mode === 'invalid-json') return new Response(SECRET);
      if (mode === 'oversized') return new Response(JSON.stringify({ body: SECRET.repeat(1000) }));
      if (mode === 'wrong-workspace') return Response.json({ ...ackFor(request, raw), workspaceId: 'other-tenant' });
      return Response.json(ackFor(request, raw, true));
    } });
    const store = createStore(env, { fetchImpl: fake.fetchImpl });
    const saved = await store.save(WS, f.state, { protectedContentCommit: f.descriptor });
    assert.equal(assertContentReceiptAcknowledgement(saved, f.descriptor).replayed, true);
    assert.equal(f.state._revision, saved._revision, 'caller retains its acknowledged primary fence for dispatch checks');
    assert.notEqual(saved._revision, fake.states.get(WS)._revision);
    assert.deepEqual(fake.counts(), { mutations: 1, reads: mode === 'direct-replay' ? 0 : 1 });
    assert.equal(fake.calls.length, mode === 'direct-replay' ? 1 : 2); assert.equal(store.schedulerCache.has(WS), false);
  }
});

test('reporting conflict preserves exact primary receipt acknowledgement and cannot overwrite newer data', async () => {
  const f = fixture('finalize'); let newer;
  const fake = protectedFake(f.state, { ordinary: async ({ url, fake }) => {
    if (url.pathname.endsWith('/runvara_commit_reporting_status')) {
      newer = randomUUID(); fake.states.get(WS)._revision = newer;
      fake.states.get(WS).workspace.name = 'concurrent workspace';
    }
  } });
  const store = createStore(env, { fetchImpl: fake.fetchImpl }), warnings = [], originalWarn = console.warn;
  console.warn = message => warnings.push(message);
  let saved;
  try { saved = await store.save(WS, f.state, { protectedContentCommit: f.descriptor }); }
  finally { console.warn = originalWarn; }
  const ack = assertContentReceiptAcknowledgement(saved, f.descriptor);
  assert.equal(saved._revision, ack.nextRevision); assert.equal(fake.states.get(WS)._revision, newer);
  assert.equal(fake.states.get(WS).workspace.name, 'concurrent workspace'); assert.equal(store.schedulerCache.has(WS), false);
  assert.equal(store.diagnostics().primaryPersistence, true); assert.equal(saved.integrationStatus.reporting.lastError, 'REPORTING_STATUS_DEFERRED');
  assert.ok(!JSON.stringify(warnings).includes(SECRET)); assert.ok(!JSON.stringify(warnings).includes(CONTENT_EXECUTION_RECEIPT_CONTRACT));
});
