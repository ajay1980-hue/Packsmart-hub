import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

const WORKSPACE = 'owned-save-test';
const sourceKeys = ['products', 'connections', 'users', 'approvals', 'connectionWrites'];
function workspace() {
  const state = seedWorkspaceState({}, { workspaceId: WORKSPACE, email: 'owner@owned-save.test', passwordHash: 'fixture' });
  state._revision = 'revision-before';
  state.products = [{ id: 'product-one', title: 'Original title', description: 'Retained content' }];
  state.connections = [{ id: 'connection-one', provider: 'shopify', metadata: { shop: 'original.myshopify.com' } }];
  state.approvals = [{ id: 'approval-one', requestedBy: state.users[0].id, status: 'approved', payload: { digest: 'original' }, executionStatus: 'not_started' }];
  state.connectionWrites = [{ id: 'write-one', status: 'ready', input: { title: 'Requested title' }, objectivePolicyProposal: { schema: 'source-test/v2', digest: 'original' } }];
  state.workRecords = Array.from({ length: 101 }, (_, index) => ({ id: `work-${index}`, detail: { source: 'original' } }));
  return state;
}
function sourceGuard(state) {
  const selected = () => sourceKeys.map(key => state[key]);
  const baseline = structuredClone(selected());
  return () => {
    if (!isDeepStrictEqual(selected(), baseline)) throw Object.assign(new Error('Selected source changed'), { code: 'SOURCE_CHANGED' });
  };
}
function fixture(initial = workspace(), controls = {}, env = {}) {
  const base = fakeSupabase({ initialStates: [initial] });
  const store = createStore({ SUPABASE_URL: 'https://owned-save.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fixture', ...env }, {
    fetchImpl: async (url, options = {}) => {
      const table = new URL(url).pathname.split('/').at(-1);
      const result = await base.fetchImpl(url, options);
      if (options.method === 'POST' && table === 'runvara_history') await controls.afterArchive?.();
      if (options.method === 'POST' && table === 'workspaces') await controls.duringMirror?.();
      if (options.method === 'PATCH' && table === 'saas_workspace_state') await controls.afterPrimary?.();
      if (table === 'runvara_commit_reporting_status') await controls.afterReporting?.();
      return result;
    }
  });
  return { ...base, store, controls };
}
const primaryWrites = calls => calls.filter(call => call.method === 'PATCH' && call.url.pathname.endsWith('/saas_workspace_state'));

test('owned saves reject source changes during archive awaits before serializing a primary commit', async () => {
  const mutations = [
    state => { state.products[0].title = 'Changed title'; },
    state => { state.connections[0].metadata.shop = 'changed.myshopify.com'; },
    state => { state.users[0].sessionVersion++; },
    state => { state.approvals[0].payload.digest = 'changed'; },
    state => { state.connectionWrites[0].objectivePolicyProposal.digest = 'changed'; }
  ];
  for (const mutate of mutations) {
    const f = fixture(), state = await f.store.get(WORKSPACE), beforeCommit = sourceGuard(state);
    const originalRevision = state._revision, persisted = structuredClone(f.states.get(WORKSPACE));
    f.controls.afterArchive = () => mutate(state);
    await assert.rejects(() => f.store.save(WORKSPACE, state, { ownedSnapshot: true, beforeCommit }), error => error.code === 'SOURCE_CHANGED');
    assert.equal(primaryWrites(f.calls).length, 0);
    assert.deepEqual(f.states.get(WORKSPACE), persisted);
    assert.equal(state._revision, originalRevision);
  }
});

test('owned snapshots stay isolated from caller source and history aliases throughout archive and mirror awaits', async () => {
  const f = fixture(), state = await f.store.get(WORKSPACE);
  const originalSources = sourceKeys.map(key => structuredClone(state[key]));
  const originalAudit = structuredClone(state.audit), originalWork = structuredClone(state.workRecords[0]);
  f.controls.afterArchive = () => {
    state.products[0].title = 'Late title';
    state.approvals[0].payload.digest = 'late';
    state.connectionWrites[0].objectivePolicyProposal.digest = 'late';
    state.workRecords[0].detail.source = 'late';
  };
  f.controls.duringMirror = () => { state.audit[0].detail.source = 'late after CAS'; };
  const saved = await f.store.save(WORKSPACE, state, { ownedSnapshot: true });
  for (const value of [saved, f.states.get(WORKSPACE)]) {
    assert.deepEqual(sourceKeys.map(key => value[key]), originalSources);
    assert.deepEqual(value.audit, originalAudit);
    assert.deepEqual(value.workRecords[0], originalWork);
  }
  assert.equal(state.products[0].title, 'Late title');
  assert.equal(state.audit[0].detail.source, 'late after CAS');
  assert.equal(Object.isFrozen(state.approvals[0]), false);
});

test('owned saves preserve automation run handles and allow later approval and run completion', async () => {
  for (const retentionEnabled of [true, false]) {
    const initial = workspace(), timestamp = new Date().toISOString();
    initial.automationRuns = [{ id: 'active-run', ruleId: 'profitGuard', status: 'IN PROGRESS', startedAt: timestamp,
      completedAt: null, leaseUntil: new Date(Date.now() + 60000).toISOString(), evidence: [] }];
    const f = fixture(initial, {}, { AUTOMATION_RETENTION_ENABLED: String(retentionEnabled) }), state = await f.store.get(WORKSPACE);
    const handle = state.automationRuns[0], approval = state.approvals[0];
    await f.store.save(WORKSPACE, state, { ownedSnapshot: true, beforeCommit: sourceGuard(state) });
    assert.equal(state.automationRuns[0], handle); assert.equal(state.approvals[0], approval);
    handle.status = 'COMPLETED'; handle.completedAt = timestamp; handle.evidence.push({ type: 'recorded', id: 'done' });
    approval.executionStatus = 'completed'; approval.executedExternally = true;
    await f.store.save(WORKSPACE, state, { ownedSnapshot: true, beforeCommit: sourceGuard(state) });
    assert.equal(f.states.get(WORKSPACE).automationRuns[0].status, 'COMPLETED');
    assert.equal(f.states.get(WORKSPACE).approvals[0].executionStatus, 'completed');
    assert.equal(state.automationRuns[0], handle);
  }
});

test('owned saves keep retention stale-source and CAS rejection behavior', async () => {
  const initial = workspace(), timestamp = new Date().toISOString();
  initial.automationRuns = Array.from({ length: 26 }, (_, index) => ({ id: `run-${index}`, ruleId: 'profitGuard', status: 'COMPLETED',
    startedAt: timestamp, completedAt: timestamp, leaseUntil: timestamp, evidence: [{ type: 'recorded', id: 'source', detail: 'x'.repeat(2000) }] }));
  const f = fixture(initial), state = await f.store.get(WORKSPACE), original = state.automationRuns;
  f.controls.afterArchive = () => { state.automationRuns[25].evidence[0].detail = 'changed'; };
  await assert.rejects(() => f.store.save(WORKSPACE, state, { ownedSnapshot: true }), error => error.code === 'RETENTION_PLAN_STALE');
  assert.equal(primaryWrites(f.calls).length, 0); assert.equal(state.automationRuns, original);
  const other = fixture(), first = await other.store.get(WORKSPACE), stale = await other.store.get(WORKSPACE);
  await other.store.save(WORKSPACE, first, { ownedSnapshot: true });
  const staleRevision = stale._revision, staleRuns = stale.automationRuns;
  await assert.rejects(() => other.store.save(WORKSPACE, stale, { ownedSnapshot: true }), error => error.code === 'STATE_CONFLICT');
  assert.equal(stale._revision, staleRevision); assert.equal(stale.automationRuns, staleRuns);
});

test('save guards run at entry and before serialization, remain out of storage, and must be synchronous', async () => {
  const f = fixture(), state = await f.store.get(WORKSPACE); f.calls.length = 0;
  let guarded = 0;
  const checked = [];
  await f.store.save(WORKSPACE, state, { ownedSnapshot: true, beforeCommit: snapshot => {
    guarded++; checked.push(snapshot);
    assert.deepEqual(sourceKeys.map(key => snapshot[key]), sourceKeys.map(key => state[key]));
  } });
  assert.equal(guarded, 2);
  assert.equal(checked[0], state); assert.notEqual(checked[1], state);
  assert.deepEqual(JSON.parse(primaryWrites(f.calls)[0].body).state.products, checked[1].products);
  assert.equal(primaryWrites(f.calls).some(call => call.body.includes('beforeCommit')), false);
  f.calls.length = 0;
  await assert.rejects(() => f.store.save(WORKSPACE, state, { ownedSnapshot: true, beforeCommit: () => { throw new Error('entry denial'); } }), /entry denial/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(() => f.store.save(WORKSPACE, state, { ownedSnapshot: true, beforeCommit: async () => {} }), /must be synchronous/);
  assert.equal(f.calls.length, 0);
});

test('owned save acknowledgement recovery does not resend the source or replay the guard', async () => {
  for (const phase of ['afterPrimary', 'afterReporting']) {
    const f = fixture(), state = await f.store.get(WORKSPACE);
    let guarded = 0;
    f.controls[phase] = () => { throw new TypeError('Synthetic lost acknowledgement'); };
    const saved = await f.store.save(WORKSPACE, state, { ownedSnapshot: true, beforeCommit: () => { guarded++; } });
    assert.equal(guarded, 2);
    assert.equal(primaryWrites(f.calls).length, 1);
    assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/runvara_commit_reporting_status')).length, 1);
    assert.equal(state._revision, f.states.get(WORKSPACE)._revision);
    assert.equal(saved._revision, state._revision);
    assert.equal(saved.connectionWrites[0].objectivePolicyProposal.digest, 'original');
  }
});

test('FileStore owns the snapshot before queue waits and runs a pre-serialization source guard', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-owned-save-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createStore({ SAAS_STATE_FILE: path.join(directory, 'state.json') }), state = workspace();
  // Existing callers may queue saves of one live state; the earlier save must
  // still install the revision used by the next queued default save.
  const first = store.save(WORKSPACE, state), second = store.save(WORKSPACE, state);
  await Promise.all([first, second]);
  assert.equal(state._revision, (await store.get(WORKSPACE))._revision);
  const beforeCommit = sourceGuard(state), pending = store.save(WORKSPACE, state, { ownedSnapshot: true, beforeCommit });
  state.products[0].title = 'Changed while queued';
  await assert.rejects(() => pending, error => error.code === 'SOURCE_CHANGED');
  assert.equal((await store.get(WORKSPACE)).products[0].title, 'Original title');
  state.products[0].title = 'Selected title';
  const isolated = store.save(WORKSPACE, state, { ownedSnapshot: true });
  state.products[0].title = 'Another queued mutation';
  const saved = await isolated;
  assert.equal(saved.products[0].title, 'Selected title');
  assert.equal((await store.get(WORKSPACE)).products[0].title, 'Selected title');
  assert.equal(state.products[0].title, 'Another queued mutation');
  await assert.rejects(() => store.getConnectionWriteContext(), error => error.code === 'WRITE_CONTEXT_UNAVAILABLE');
});
