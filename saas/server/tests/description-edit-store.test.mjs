import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStore } from '../lib/store.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
import { descriptionFixture } from './description-edit-fixture.mjs';
import { executeConnectionWrite } from '../lib/connection-writes.mjs';
import { createContentPilot, pauseContentPilot } from '../lib/content-pilot.mjs';
import { DESCRIPTION_EXECUTION_RECEIPT_CONTRACT, contentReceiptRequestFingerprint } from '../lib/content-execution-receipt.mjs';

// Real adapter and dispatcher, synthetic transport/ledger. This is NOT SQL proof.
export async function descriptionAdapterFixture({ loseAck, capacity = false, loseLookup = false } = {}) {
  const f = await descriptionFixture(), database = fakeSupabase({ initialStates: [f.state] }), ledger = new Map();
  const calls = { reserve: 0, finalize: 0, lookup: 0 };
  const fetchImpl = async (url, options = {}) => {
    const name = new URL(url).pathname.split('/').at(-1);
    if (['runvara_reserve_content_receipt', 'runvara_finalize_content_receipt'].includes(name)) {
      const raw = JSON.parse(options.body).p_request_json, r = JSON.parse(raw), key = r.kind + ':' + r.admission.attemptId;
      calls[r.kind]++;
      const saved = ledger.get(key);
      if (saved) return saved.raw === raw ? Response.json({ ...saved.ack, replayed: true }) : Response.json({ code: 'P0R04' }, { status: 409 });
      if (capacity && r.kind === 'reserve') return Response.json({ code: 'P0R05' }, { status: 409 });
      if (database.states.get(r.workspaceId)._revision !== r.expectedRevision) return Response.json({ code: 'P0R02' }, { status: 409 });
      const ack = { schema: 'runvara-content-execution-commit-ack/v1', kind: r.kind, workspaceId: r.workspaceId,
        attemptId: r.admission.attemptId, admissionDigest: r.admission.digest, intentDigest: r.admission.intentDigest,
        requestFingerprint: contentReceiptRequestFingerprint(raw), expectedRevision: r.expectedRevision, nextRevision: r.nextRevision,
        receiptDigest: r.kind === 'finalize' ? r.receipt.digest : null, reservedBytes: 40960, replayed: false };
      ledger.set(key, { raw, ack, request: r }); database.states.set(r.workspaceId, structuredClone(r.state));
      if (loseAck === r.kind) throw new Error('Synthetic committed response lost');
      return Response.json(ack);
    }
    if (name === 'runvara_read_content_receipt') {
      calls.lookup++;
      if (loseLookup) throw new Error('Synthetic reconciliation unavailable');
      const p = JSON.parse(options.body), row = ledger.get(p.p_kind + ':' + p.p_attempt_id);
      return Response.json(row?.ack.requestFingerprint === p.p_request_fingerprint ? { ...row.ack, replayed: true } : null);
    }
    return database.fetchImpl(url, options);
  };
  const env = { SUPABASE_URL: 'https://synthetic-description.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only',
    CONTENT_EXECUTION_RECEIPT_CONTRACT: DESCRIPTION_EXECUTION_RECEIPT_CONTRACT };
  const store = createStore(env, { fetchImpl }), state = await store.get(f.state.workspace.id), write = state.connectionWrites[0];
  const run = (overrides = {}) => executeConnectionWrite(state, write.id, f.session.userId, f.service,
    options => store.save(state.workspace.id, state, options), { governedRecordStage: f.closedStage, contentPilot: f.pilot,
      protectedContentReceipts: DESCRIPTION_EXECUTION_RECEIPT_CONTRACT, durableStore: true, actorSession: f.session,
      loadFreshState: input => store.getConnectionWriteContext(state.workspace.id, input), ...overrides });
  return { ...f, state, write, run, store, database, ledger, calls, env, fetchImpl };
}

test('closed broad stage admits an exact opaque pilot permit through the real storage adapter', async () => {
  const f = await descriptionAdapterFixture();
  assert.equal((await f.run()).status, 'completed');
  assert.equal(f.counts.mutations, 1); assert.deepEqual(f.calls, { reserve: 1, finalize: 1, lookup: 0 });
  assert.equal(f.ledger.size, 2);
  for (const row of f.ledger.values()) assert.equal(row.request.contract, DESCRIPTION_EXECUTION_RECEIPT_CONTRACT);
});

test('real adapter reconciles committed but lost reserve and finalize ACKs', async t => {
  for (const kind of ['reserve', 'finalize']) await t.test(kind, async () => {
    const f = await descriptionAdapterFixture({ loseAck: kind });
    assert.equal((await f.run()).status, 'completed');
    assert.equal(f.counts.mutations, 1); assert.equal(f.calls[kind], 1); assert.equal(f.calls.lookup, 1);
    assert.equal(f.ledger.size, 2);
    const coldStore = createStore(f.env, { fetchImpl: f.fetchImpl }), cold = await coldStore.get(f.state.workspace.id);
    const result = await executeConnectionWrite(cold, f.write.id, f.session.userId, f.service,
      () => assert.fail('Completed history must not save'), { contentPilot: createContentPilot(f.scope) });
    assert.equal(result.status, 'completed'); assert.equal(f.counts.mutations, 1);
  });
});

test('capacity refusal and removal of the narrow permit cannot send', async () => {
  const full = await descriptionAdapterFixture({ capacity: true });
  await assert.rejects(full.run, { code: 'CONTENT_RECEIPT_CAPACITY_EXHAUSTED' });
  assert.equal(full.counts.mutations, 0); assert.equal(full.ledger.size, 0);
  const f = await descriptionFixture(); await f.run();
  const descriptor = f.receiptCommits[0];
  let calls = 0;
  const store = createStore({ SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic',
    CONTENT_EXECUTION_RECEIPT_CONTRACT: DESCRIPTION_EXECUTION_RECEIPT_CONTRACT }, { fetchImpl: async () => { calls++; assert.fail('No I/O'); } });
  for (const permit of [undefined, {}, f.pilot, structuredClone(f.pilot)]) {
    await assert.rejects(() => store.save(f.state.workspace.id, f.state, { protectedContentCommit: descriptor, contentPilotPermit: permit }), { code: 'CONTENT_PILOT_REQUIRED' });
    await assert.rejects(() => store.commit(f.state.workspace.id, { ...f.state, _revision: randomUUID() }, f.state._revision, true,
      { protectedContentCommit: descriptor, contentPilotPermit: permit }), { code: 'CONTENT_PILOT_REQUIRED' });
  }
  assert.equal(calls, 0);
  let read = false;
  const accessor = { ...descriptor, get contract() { read = true; return DESCRIPTION_EXECUTION_RECEIPT_CONTRACT; } };
  await assert.rejects(() => store.save(f.state.workspace.id, f.state, { protectedContentCommit: accessor }));
  await assert.rejects(() => store.commit(f.state.workspace.id, { ...f.state, _revision: randomUUID() }, f.state._revision, true, { protectedContentCommit: accessor }));
  assert.equal(read, false); assert.equal(calls, 0);
});

test('pause after submission still finalizes through the closed real adapter', async () => {
  const f = await descriptionAdapterFixture(); f.hooks.fetch = () => { pauseContentPilot(f.pilot); };
  assert.equal((await f.run()).status, 'completed'); assert.equal(f.calls.finalize, 1);
});
