import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
import { BRIEF_HISTORY_CONTRACT, BRIEF_HISTORY_POST_MAX_BYTES, planBriefHistoryCompaction,
  briefHistoryList, briefHistoryIntegrity } from '../lib/brief-history.mjs';

const WORKSPACE = 'tenant-brief-history';
const ENV = { SUPABASE_URL: 'https://brief-history.test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fixture-only',
  BRIEF_HISTORY_COMPACTION_CONTRACT: BRIEF_HISTORY_CONTRACT };
const brief = (id, days = 2) => ({ id, generatedAt: new Date(Date.now() - days * 86400000).toISOString(),
  summary: `Recorded brief ${id}`, logic: 'deterministic-v2', orders30d: 12,
  rows: [{ description: 'Recorded original '.repeat(120), revenue: 12, units: 3 }] });
function workspace(count = 2) {
  const state = seedWorkspaceState({}, { workspaceId: WORKSPACE, email: 'owner@brief-history.test' });
  state._revision = 'original-revision';
  state.dailyBriefs = [brief('current', 0), ...Array.from({ length: count }, (_, index) => brief(`old-${index}`))];
  return state;
}
function fixture(state = workspace(), controls = {}) {
  const fake = fakeSupabase({ initialStates: [state], fault: input => controls.fault?.(input) });
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    const call = { url, method, headers: options.headers, body: options.body || '' }; calls.push(call);
    if (url.pathname.endsWith('/operations_briefs')) {
      const result = await controls.beforeArchive?.(call, fake);
      if (result instanceof Response) return result;
    }
    let result = await fake.fetchImpl(input, options);
    if (url.pathname.endsWith('/operations_briefs')) {
      const replacement = await controls.afterArchive?.(call, fake, result);
      if (replacement instanceof Response) result = replacement;
    }
    return result;
  };
  const makeStore = (env = {}) => createStore({ ...ENV, ...env }, { fetchImpl });
  return { ...fake, calls, controls, makeStore, store: makeStore() };
}
const archiveCalls = calls => calls.filter(call => call.url.pathname.endsWith('/operations_briefs'));
const newPosts = calls => archiveCalls(calls).filter(call => call.method === 'POST' && new Headers(call.headers).get('prefer')?.includes('ignore-duplicates'));
const archiveReads = calls => archiveCalls(calls).filter(call => call.method === 'GET');
const primary = calls => calls.filter(call => call.url.pathname.endsWith('/saas_workspace_state') && call.method === 'PATCH');

test('new producer is closed for absent, unknown, case-changed and padded flags; current rows remain exact', async () => {
  for (const flag of [undefined, '', 'true', 'runvara-brief-history/v2', 'RUNVARA-BRIEF-HISTORY/V1', ` ${BRIEF_HISTORY_CONTRACT}`]) {
    const state = workspace(), before = structuredClone(state.dailyBriefs), f = fixture(state);
    await f.makeStore({ BRIEF_HISTORY_COMPACTION_CONTRACT: flag }).save(WORKSPACE, state);
    assert.deepEqual(state.dailyBriefs, before);
    assert.equal(newPosts(f.calls).length, 0);
    assert.equal(archiveReads(f.calls).length, 0);
  }
  const state = workspace(0); state.dailyBriefs.push(brief('today-2', 0));
  const before = structuredClone(state.dailyBriefs), f = fixture(state);
  await f.store.save(WORKSPACE, state);
  assert.deepEqual(state.dailyBriefs, before);
  assert.equal(newPosts(f.calls).length, 0);
});

test('two historical compactions verify exact bounded projections before CAS and report measured savings', async t => {
  const state = workspace(4), full = structuredClone(state.dailyBriefs), f = fixture(state);
  const beforeBytes = Buffer.byteLength(JSON.stringify(state.dailyBriefs));
  const candidatePlan = planBriefHistoryCompaction(state);
  await f.store.save(WORKSPACE, state);
  assert.equal(newPosts(f.calls).length, 2);
  assert.equal(archiveReads(f.calls).length, 2);
  assert.deepEqual(state.dailyBriefs[0], full[0]);
  assert.deepEqual(state.dailyBriefs.slice(3), full.slice(3));
  assert.equal(state.dailyBriefs.filter(item => item.archive).length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(state.dailyBriefs)) < beforeBytes);
  for (const [index, call] of newPosts(f.calls).entries()) {
    assert.equal(JSON.parse(call.body).length, 1);
    assert.ok(Buffer.byteLength(call.body) <= BRIEF_HISTORY_POST_MAX_BYTES);
    assert.equal(Buffer.byteLength(call.body), candidatePlan.candidates[index].postBytes);
    assert.equal(call.url.searchParams.get('on_conflict'), 'id');
    assert.equal(call.headers.Prefer, 'resolution=ignore-duplicates,return=minimal');
  }
  for (const call of archiveReads(f.calls)) {
    assert.equal(call.url.searchParams.get('select'), 'id,workspace_id,metrics');
    assert.equal(call.url.searchParams.get('workspace_id'), `eq.${WORKSPACE}`);
    assert.equal(call.url.searchParams.get('limit'), '2');
    assert.ok(f.calls.indexOf(call) < f.calls.indexOf(primary(f.calls)[0]));
  }
  t.diagnostic(JSON.stringify({ retained: state.dailyBriefs.length, compacted: 2, beforeBriefBytes: beforeBytes,
    afterBriefBytes: Buffer.byteLength(JSON.stringify(state.dailyBriefs)), archivePostBytes: newPosts(f.calls).reduce((total, call) => total + Buffer.byteLength(call.body), 0),
    archiveRequests: 4 }));
});

test('repeat unchanged saves, ordinary reads, lists and scheduler cache do not read or rewrite archived bodies', async () => {
  const state = workspace(), f = fixture(state);
  await f.store.save(WORKSPACE, state);
  const archives = structuredClone(f.tables.get('operations_briefs'));
  f.calls.length = 0;
  await f.store.save(WORKSPACE, state);
  await f.store.get(WORKSPACE);
  await f.store.getForScheduler(WORKSPACE);
  briefHistoryList(state);
  assert.equal(archiveCalls(f.calls).length, 0);
  assert.deepEqual(f.tables.get('operations_briefs'), archives);
});

test('optional archive failures keep full rows and allow known business completion within the primary limit', async () => {
  const warn = console.warn, warnings = []; console.warn = value => warnings.push(JSON.parse(value));
  try { for (const mode of ['write', 'read', 'corrupt']) {
    const state = workspace(), before = structuredClone(state), f = fixture(state, {
      fault: ({ table, method }) => {
        if (table === 'saas_workspace_state' && method === 'PATCH') {
          assert.deepEqual(state.dailyBriefs, before.dailyBriefs, 'caller history stays full before primary acknowledgement');
          assert.equal(state._revision, before._revision);
        }
      },
      beforeArchive: call => (mode === 'write' && call.method === 'POST' && call.headers.Prefer?.includes('ignore-duplicates') || mode === 'read' && call.method === 'GET')
        ? Response.json({ code: 'PGRST000' }, { status: 503 }) : null,
      afterArchive: async (call, fake, response) => {
        if (mode !== 'corrupt' || call.method !== 'GET') return;
        const rows = await response.json(); rows[0].metrics.summary = 'Corrupt response'; return Response.json(rows);
      }
    });
    state.agentSettings.commander.lastResult = 'Known completed work';
    before.agentSettings.commander.lastResult = 'Known completed work';
    await f.store.save(WORKSPACE, state);
    assert.deepEqual(state.dailyBriefs, before.dailyBriefs, mode);
    assert.deepEqual(f.states.get(WORKSPACE).dailyBriefs, before.dailyBriefs, mode);
    assert.equal(f.states.get(WORKSPACE).agentSettings.commander.lastResult, 'Known completed work');
    assert.equal(newPosts(f.calls).length, 2, 'failed attempts consume both candidate slots');
    assert.equal(primary(f.calls).length, 1);
  } } finally { console.warn = warn; }
  assert.equal(warnings.length, 6);
  assert.ok(warnings.every(entry => Object.keys(entry).join(',') === 'event,workspaceId,code'));
  assert.equal(JSON.stringify(warnings).includes('Recorded'), false);
});

test('primary conflict or full-state hard limit still fail without changing caller histories', async () => {
  const warn = console.warn; console.warn = () => {};
  try { for (const mode of ['conflict', 'oversized']) {
    const state = workspace();
    if (mode === 'oversized') state.agentSettings.commander.largeExistingPayload = 'x'.repeat(2097152);
    const before = structuredClone(state), f = fixture(state, {
      fault: ({ table, method }) => table === 'saas_workspace_state' && method === 'PATCH' && mode === 'conflict' ? Response.json([]) : null,
      beforeArchive: call => mode === 'oversized' && call.method === 'GET' ? Response.json([], { status: 200 }) : null
    });
    const array = state.dailyBriefs;
    await assert.rejects(() => f.store.save(WORKSPACE, state), { code: mode === 'conflict' ? 'STATE_CONFLICT' : 'STATE_SIZE_LIMIT' });
    assert.equal(state.dailyBriefs, array); assert.deepEqual(state.dailyBriefs, before.dailyBriefs);
    assert.equal(state._revision, before._revision); assert.deepEqual(f.states.get(WORKSPACE), before);
    if (mode === 'oversized') assert.equal(primary(f.calls).length, 0);
  } } finally { console.warn = warn; }
});

test('same-ID edits at each archive await abort without publishing a stale stub', async () => {
  for (const method of ['POST', 'GET']) {
    const state = workspace(), persisted = structuredClone(state);
    let changed = false;
    const f = fixture(state, { afterArchive: call => {
      if (call.method === method && !changed) { changed = true; state.dailyBriefs[1].rows[0].description = 'New original content'; }
    } });
    await assert.rejects(() => f.store.save(WORKSPACE, state), { code: 'BRIEF_HISTORY_SOURCE_CHANGED' });
    assert.equal(changed, true);
    assert.equal(state.dailyBriefs[1].archive, undefined);
    assert.equal(state.dailyBriefs[1].rows[0].description, 'New original content');
    assert.deepEqual(f.states.get(WORKSPACE), persisted);
    assert.equal(primary(f.calls).length, 0);
  }
});

test('ordinary mutable completion handles remain live across new awaits while source-bound guards still abort', async () => {
  const state = workspace(), f = fixture(state, { afterArchive: call => {
    if (call.method === 'POST') state.agentSettings.commander.lastResult = 'Finished while archiving';
  } });
  await f.store.save(WORKSPACE, state);
  assert.equal(f.states.get(WORKSPACE).agentSettings.commander.lastResult, 'Finished while archiving');
  for (const method of ['POST', 'GET']) {
    const guarded = workspace(), original = structuredClone(guarded);
    let authorizationCurrent = true;
    const g = fixture(guarded, { afterArchive: call => { if (call.method === method) authorizationCurrent = false; } });
    await assert.rejects(() => g.store.save(WORKSPACE, guarded, { ownedSnapshot: true, beforeCommit: snapshot => {
      assert.equal(snapshot.workspace.id, WORKSPACE);
      if (!authorizationCurrent) throw Object.assign(new Error('Source authorization changed'), { code: 'SOURCE_CHANGED' });
    } }), { code: 'SOURCE_CHANGED' });
    assert.equal(primary(g.calls).length, 0);
    assert.deepEqual(guarded, original);
  }
});

test('provider completion handles retain baseline timing across archive, primary and reporting awaits', async t => {
  for (const boundary of ['archive', 'primary', 'reporting']) for (const replace of [false, true]) for (const ownedSnapshot of [false, true]) {
    await t.test(`${boundary}, ${replace ? 'replace provider object' : 'in-place provider change'}, owned=${ownedSnapshot}`, async () => {
      const state = workspace(1);
      state.integrationStatus.shopify = { status: 'syncing', orderRecovery: { status: 'admitted' } };
      const container = state.integrationStatus;
      let changed = false;
      const complete = () => {
        if (changed) return; changed = true;
        if (replace) state.integrationStatus.shopify = { status: 'connected', orderRecovery: { status: 'committed' } };
        else { state.integrationStatus.shopify.status = 'connected'; state.integrationStatus.shopify.orderRecovery.status = 'committed'; }
      };
      const f = fixture(state, {
        afterArchive: call => { if (boundary === 'archive' && call.method === 'POST') complete(); },
        fault: ({ table, method }) => {
          if (boundary === 'primary' && table === 'saas_workspace_state' && method === 'PATCH'
            || boundary === 'reporting' && table === 'runvara_commit_reporting_status') complete();
        }
      });
      await f.store.save(WORKSPACE, state, { ownedSnapshot });
      assert.equal(changed, true);
      // Only pre-serialization changes enter this primary commit. Later
      // completion stays on ordinary caller handles for its own future save.
      const persistedStatus = boundary === 'archive' && !ownedSnapshot ? 'connected' : 'syncing';
      assert.equal(f.states.get(WORKSPACE).integrationStatus.shopify.status, persistedStatus);
      assert.equal(f.states.get(WORKSPACE).integrationStatus.shopify.orderRecovery.status, persistedStatus === 'connected' ? 'committed' : 'admitted');
      assert.equal(state.integrationStatus.shopify.status, ownedSnapshot ? 'syncing' : 'connected');
      assert.equal(state.integrationStatus.shopify.orderRecovery.status, ownedSnapshot ? 'admitted' : 'committed');
      assert.equal(state.integrationStatus === container, !ownedSnapshot);
      assert.equal(primary(f.calls).length, 1, 'never replay primary merely to persist late bookkeeping');
    });
  }
});

test('two stale replicas preserve distinct same-original-ID versions and never overwrite archived content', async () => {
  const f = fixture(workspace(1)), first = await f.store.get(WORKSPACE), secondStore = f.makeStore(), second = await secondStore.get(WORKSPACE);
  second.dailyBriefs[1].rows[0].description = 'Second concurrent version '.repeat(100);
  const beforeSecond = structuredClone(second), firstRef = planBriefHistoryCompaction(first).candidates[0].reference;
  const secondRef = planBriefHistoryCompaction(second).candidates[0].reference;
  assert.notEqual(firstRef.archiveId, secondRef.archiveId);
  await f.store.save(WORKSPACE, first);
  const firstArchive = structuredClone(f.tables.get('operations_briefs').find(row => row.id === firstRef.archiveId));
  await assert.rejects(() => secondStore.save(WORKSPACE, second), { code: 'STATE_CONFLICT' });
  assert.deepEqual(second.dailyBriefs, beforeSecond.dailyBriefs); assert.equal(second._revision, beforeSecond._revision);
  assert.deepEqual(f.tables.get('operations_briefs').find(row => row.id === firstRef.archiveId), firstArchive);
  assert.equal(f.tables.get('operations_briefs').filter(row => row.id.startsWith('brief-v1:')).length, 2);
  assert.deepEqual(await f.store.getBrief(WORKSPACE, 'old-0', { state: first }), firstArchive.metrics);
});

test('insert-ignore must verify an existing exact version, and privileged archive mutation is detected', async () => {
  const state = workspace(1), f = fixture(state), candidate = planBriefHistoryCompaction(state).candidates[0];
  const corrupt = structuredClone(candidate.row); corrupt.metrics.summary = 'Previously corrupted';
  f.tables.set('operations_briefs', [corrupt]);
  await f.store.save(WORKSPACE, state);
  assert.equal(state.dailyBriefs[1].archive, undefined);
  assert.equal(f.tables.get('operations_briefs')[0].metrics.summary, 'Previously corrupted', 'ignore did not overwrite');
  assert.equal(primary(f.calls).length, 1);
  f.tables.set('operations_briefs', [structuredClone(candidate.row)]);
  await f.store.save(WORKSPACE, state);
  f.tables.get('operations_briefs').find(row => row.id === candidate.row.id).metrics.orders30d++;
  await assert.rejects(() => f.store.getBrief(WORKSPACE, 'old-0', { state }), { code: 'BRIEF_ARCHIVE_INTEGRITY_FAILED' });
});

test('partial archive failure compacts only verified rows and does not attempt a third candidate', async () => {
  const state = workspace(4), full = structuredClone(state.dailyBriefs), f = fixture(state);
  let posts = 0;
  f.controls.beforeArchive = call => {
    if (call.method === 'POST' && call.headers.Prefer?.includes('ignore-duplicates') && ++posts === 1) {
      return Response.json({ code: 'PGRST000' }, { status: 503 });
    }
  };
  await f.store.save(WORKSPACE, state);
  assert.equal(posts, 2);
  assert.deepEqual(state.dailyBriefs[1], full[1]);
  assert.equal(state.dailyBriefs[2].archive.schema, BRIEF_HISTORY_CONTRACT);
  assert.deepEqual(state.dailyBriefs.slice(3), full.slice(3));
});

test('new detail reader reuses an authenticated exact-workspace state with the producer disabled', async () => {
  const state = workspace(1), full = structuredClone(state.dailyBriefs[1]), f = fixture(state);
  await f.store.save(WORKSPACE, state);
  const reader = f.makeStore({ BRIEF_HISTORY_COMPACTION_CONTRACT: undefined });
  f.calls.length = 0;
  assert.deepEqual(await reader.getBrief(WORKSPACE, full.id, { state }), full);
  assert.equal(f.calls.length, 1);
  assert.equal(archiveReads(f.calls).length, 1);
  assert.equal(briefHistoryIntegrity(state.dailyBriefs[1], { workspaceId: WORKSPACE, verified: true }), 'verified_archive');
  f.calls.length = 0;
  await assert.rejects(() => reader.getBrief('other', full.id, { state }), { code: 'WORKSPACE_MISMATCH' });
  await assert.rejects(() => reader.getBrief(WORKSPACE, full.id, { state: null }), { code: 'WORKSPACE_MISMATCH' });
  assert.equal(f.calls.length, 0);
});

test('detail fails closed for forged, unknown-version, missing, duplicate, oversized and corrupt responses', async () => {
  const state = workspace(1), f = fixture(state);
  await f.store.save(WORKSPACE, state);
  const stub = state.dailyBriefs[1], originalRef = structuredClone(stub.archive);
  for (const edit of [ref => { ref.workspaceId = 'other'; }, ref => { ref.schema = 'runvara-brief-history/v2'; },
    ref => { delete ref.schema; }, ref => { delete ref.hashFormat; }, ref => { ref.extra = 'extra'; }]) {
    stub.archive = structuredClone(originalRef); edit(stub.archive); f.calls.length = 0;
    await assert.rejects(() => f.store.getBrief(WORKSPACE, stub.id, { state }), { code: 'BRIEF_ARCHIVE_REFERENCE_INVALID' });
    assert.equal(f.calls.length, 0);
  }
  stub.archive = originalRef;
  for (const mode of ['missing', 'duplicate', 'oversized', 'corrupt', 'wrong-tenant']) {
    f.controls.afterArchive = async (call, fake, response) => {
      if (call.method !== 'GET') return;
      const rows = await response.json();
      if (mode === 'missing') return Response.json([]);
      if (mode === 'duplicate') return Response.json([rows[0], rows[0]]);
      if (mode === 'oversized') return new Response(' '.repeat(131073), { status: 200 });
      if (mode === 'wrong-tenant') rows[0].workspace_id = 'other';
      if (mode === 'corrupt') rows[0].metrics.rows[0].units = '3';
      return Response.json(rows);
    };
    await assert.rejects(() => f.store.getBrief(WORKSPACE, stub.id, { state }), error => error.code.startsWith('BRIEF_ARCHIVE_'));
  }
});

test('aged-out versioned stubs skip the legacy reread/upsert path and keep exactly 30 retained IDs', async () => {
  const state = workspace(1), f = fixture(state); await f.store.save(WORKSPACE, state);
  const stub = state.dailyBriefs[1], archived = structuredClone(f.tables.get('operations_briefs').find(row => row.id === stub.archive.archiveId));
  state.dailyBriefs = [...Array.from({ length: 30 }, (_, index) => brief(`fresh-${index}`, 0)), stub];
  f.calls.length = 0; await f.store.save(WORKSPACE, state);
  assert.equal(state.dailyBriefs.length, 30);
  assert.equal(archiveReads(f.calls).length, 0);
  assert.equal(newPosts(f.calls).length, 0);
  assert.ok(archiveCalls(f.calls).every(call => !call.body.includes(stub.id)));
  assert.deepEqual(f.tables.get('operations_briefs').find(row => row.id === archived.id), archived);
});

test('aged-out malformed new pointers never enter the legacy path even with the version key removed', async () => {
  const source = workspace(1), original = planBriefHistoryCompaction(source).candidates[0].stub;
  for (const edit of [stub => { delete stub.archive.schema; }, stub => { delete stub.archive.hashFormat; },
    stub => { stub.archive.schema = 'runvara-brief-history/v2'; }, stub => { stub.archive = null; },
    stub => { stub.archive = {}; }, stub => { stub.archive = { table: 'operations_briefs', id: 'other', sha256: 'a'.repeat(64) }; }]) {
    const state = workspace(0), stub = structuredClone(original); edit(stub);
    state.dailyBriefs = [...Array.from({ length: 30 }, (_, index) => brief(`today-${index}`, 0)), stub];
    const f = fixture(state), before = structuredClone(state.dailyBriefs);
    await assert.rejects(() => f.store.save(WORKSPACE, state), { code: 'BRIEF_ARCHIVE_REFERENCE_INVALID' });
    assert.equal(archiveCalls(f.calls).length, 0);
    assert.equal(primary(f.calls).length, 0);
    assert.deepEqual(state.dailyBriefs, before);
  }
});

test('legacy eviction requires bounded full-row verification and never rewrites missing/corrupt archives with stubs', async () => {
  for (const mode of ['valid', 'missing', 'corrupt', 'oversized']) {
    const state = workspace(0), full = brief('legacy-aged-out', 0); full.rows[0].description = 'x'.repeat(70000);
    state.dailyBriefs = [full];
    const f = fixture(state); await f.store.save(WORKSPACE, state);
    const stub = structuredClone(state.dailyBriefs[0]);
    state.dailyBriefs = [...Array.from({ length: 30 }, (_, index) => brief(`today-${index}`, 0)), stub];
    const history = structuredClone(state.dailyBriefs), stored = structuredClone(f.tables.get('operations_briefs'));
    const persistedBefore = structuredClone(f.states.get(WORKSPACE));
    f.calls.length = 0;
    f.controls.afterArchive = async (call, fake, response) => {
      if (call.method !== 'GET' || mode === 'valid') return;
      if (mode === 'missing') return Response.json([]);
      if (mode === 'oversized') return new Response(' '.repeat(2097153));
      const rows = await response.json(); rows[0].metrics = stub; return Response.json(rows);
    };
    if (mode === 'valid') {
      await f.store.save(WORKSPACE, state);
      assert.equal(state.dailyBriefs.length, 30);
    } else {
      await assert.rejects(() => f.store.save(WORKSPACE, state), error => error.code.startsWith('BRIEF_ARCHIVE_'));
      assert.deepEqual(state.dailyBriefs, history);
      assert.deepEqual(f.states.get(WORKSPACE), persistedBefore);
      assert.equal(primary(f.calls).length, 0);
    }
    assert.equal(archiveReads(f.calls).length, 1);
    assert.ok(archiveCalls(f.calls).filter(call => call.method === 'POST').every(call => !call.body.includes(full.id)));
    assert.deepEqual(f.tables.get('operations_briefs').find(row => row.id === full.id), stored.find(row => row.id === full.id));
  }
});

test('legacy 900KB snapshots keep their original-ID path and are never labeled digest-verified', async () => {
  const state = workspace(0), full = brief('legacy-large', 0); full.rows[0].description = 'x'.repeat(900000); state.dailyBriefs = [full];
  const f = fixture(state); await f.store.save(WORKSPACE, state);
  assert.equal(state.dailyBriefs[0].archive.schema, undefined);
  assert.equal(state.dailyBriefs[0].archive.id, full.id);
  assert.deepEqual(await f.store.getBrief(WORKSPACE, full.id, { state }), full);
  assert.equal(briefHistoryIntegrity(state.dailyBriefs[0], { verified: true }), 'legacy_archive_unverified');
  assert.equal(newPosts(f.calls).length, 0);
});

test('producer-off legacy reads explicitly reject over-2MiB responses without truncating or deleting stored data', async () => {
  const state = workspace(0), full = brief('legacy-over-two-mib', 0);
  full.rows[0].description = 'x'.repeat(2097152); state.dailyBriefs = [full];
  const f = fixture(state), reader = f.makeStore({ BRIEF_HISTORY_COMPACTION_CONTRACT: undefined });
  await reader.save(WORKSPACE, state);
  const stored = structuredClone(f.tables.get('operations_briefs')), stub = structuredClone(state.dailyBriefs[0]);
  f.calls.length = 0;
  await assert.rejects(() => reader.getBrief(WORKSPACE, full.id, { state }), { code: 'BRIEF_ARCHIVE_TOO_LARGE' });
  assert.deepEqual(f.tables.get('operations_briefs'), stored);
  assert.deepEqual(state.dailyBriefs[0], stub);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'GET');
  assert.equal(stored[0].metrics.rows[0].description.length, 2097152);
});

test('f431 original-ID reader fixture cannot resolve new content-addressed archives: rollback requires new reader', async () => {
  const state = workspace(1), f = fixture(state); await f.store.save(WORKSPACE, state);
  // Exact f431 lookup semantics: archive.id/schema are ignored and the URL uses
  // the retained brief's original ID. This intentionally demonstrates failure.
  const oldReader = async (workspaceId, briefId) => {
    const row = (await f.fetchImpl(`${ENV.SUPABASE_URL}/rest/v1/operations_briefs?workspace_id=eq.${workspaceId}&id=eq.${briefId}&select=metrics&limit=1`).then(response => response.json()))[0];
    if (!row?.metrics) throw Object.assign(new Error('Historical brief is temporarily unavailable'), { code: 'BRIEF_ARCHIVE_UNAVAILABLE' });
    return row.metrics;
  };
  await assert.rejects(() => oldReader(WORKSPACE, 'old-0'), { code: 'BRIEF_ARCHIVE_UNAVAILABLE' });
  assert.equal((await f.store.getBrief(WORKSPACE, 'old-0', { state })).id, 'old-0');
});

test('f431 original-ID reader can return a stale prior mirror instead of the referenced full version', async () => {
  const state = workspace(1), f = fixture(state), stale = structuredClone(state.dailyBriefs[1]);
  stale.summary = 'Earlier mirrored summary'; stale.rows[0].units = 1;
  f.tables.set('operations_briefs', [{ id: stale.id, workspace_id: WORKSPACE, summary: stale.summary,
    metrics: stale, logic: stale.logic, created_at: stale.generatedAt }]);
  await f.store.save(WORKSPACE, state);
  const response = await f.fetchImpl(`${ENV.SUPABASE_URL}/rest/v1/operations_briefs?workspace_id=eq.${WORKSPACE}&id=eq.${stale.id}&select=metrics&limit=1`);
  const oldResult = (await response.json())[0].metrics;
  assert.deepEqual(oldResult, stale);
  assert.notDeepEqual(oldResult, await f.store.getBrief(WORKSPACE, stale.id, { state }));
});

test('file mode validates supplied workspace and refuses to fabricate detail from an archive stub', async () => {
  const state = workspace(1), candidate = planBriefHistoryCompaction(state).candidates[0];
  const file = createStore({ PACKSMART_DATA_FILE: '/tmp/brief-history-unused.json' });
  assert.deepEqual(await file.getBrief(WORKSPACE, 'old-0', { state }), state.dailyBriefs[1]);
  await assert.rejects(() => file.getBrief('other', 'old-0', { state }), { code: 'WORKSPACE_MISMATCH' });
  state.dailyBriefs[1] = structuredClone(candidate.stub);
  await assert.rejects(() => file.getBrief(WORKSPACE, 'old-0', { state }), { code: 'BRIEF_ARCHIVE_UNAVAILABLE' });
});

test('a lost insert acknowledgement retries identical stable data within two candidate attempts', async () => {
  const state = workspace(), f = fixture(state);
  const lost = new Set();
  f.controls.afterArchive = call => {
    if (call.method !== 'POST' || !call.headers.Prefer?.includes('ignore-duplicates')) return;
    const id = JSON.parse(call.body)[0].id;
    if (!lost.has(id)) { lost.add(id); throw new Error('Simulated lost acknowledgement'); }
  };
  await f.store.save(WORKSPACE, state);
  const posts = newPosts(f.calls);
  assert.equal(posts.length, 4); assert.equal(archiveReads(f.calls).length, 2);
  assert.equal(posts[0].body, posts[1].body); assert.equal(posts[2].body, posts[3].body);
  assert.equal(f.tables.get('operations_briefs').filter(row => row.id.startsWith('brief-v1:')).length, 2);
});
