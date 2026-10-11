import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

const SECRET = 'brief-history-api-synthetic-session-over-thirty-two-characters';
const WS = 'history-alpha', OTHER = 'history-beta';
const full = (id, summary = 'Recorded summary; contribution remains unknown.') => ({
  id, generatedAt: '2020-01-02T12:00:00.000Z', summary, logic: 'deterministic-v2',
  calculationVersion: 'synthetic-history/v1', sourceSignature: 'retained-synthetic-source',
  today: { revenue: null, contribution: null, evidence: Array.from({ length: 40 }, (_, n) => ({ id: n, status: 'unknown', detail: 'Synthetic recorded source. '.repeat(5) })) },
  recommendations: [{ title: 'Review source coverage', reason: 'No complete total is established.' }]
});

async function fixture(t, { archive = false } = {}) {
  const states = [WS, OTHER].map(id => {
    const state = seedWorkspaceState({}, { workspaceId: id, email: `${id}@example.test`, passwordHash: 'synthetic-unusable-password-hash' });
    state._revision = 'synthetic-predecessor';
    state.users[0].passwordChangeRequired = false;
    for (const role of ['admin', 'member', 'viewer']) state.users.push({ ...state.users[0], id: `${id}-${role}`, role, email: `${role}-${id}@example.test` });
    state.dailyBriefs = [full('latest', `${id} latest`), full('saved:older', `${id} recorded history`)];
    return state;
  });
  const fake = fakeSupabase({ initialStates: states });
  const store = createStore({ SUPABASE_URL: 'https://brief-history.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only',
    ...(archive ? { BRIEF_HISTORY_COMPACTION_CONTRACT: 'runvara-brief-history/v1' } : {}) }, { fetchImpl: fake.fetchImpl });
  if (archive) await store.save(WS, await store.get(WS));
  store.integrityCheck = undefined;
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: SECRET, SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' },
    { store, schedulerEnabled: false, agentOpsEnabled: false, fetchImpl: async () => assert.fail('History reads cannot call providers') });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await server.packsmart.drain(); if (server.listening) await new Promise(resolve => server.close(resolve)); });
  const auth = (workspace = WS, role = 'owner') => {
    const user = fake.states.get(workspace).users.find(item => item.role === role);
    return createSessionToken({ userId: user.id, workspaceId: workspace, email: user.email, role, sessionVersion: 1 }, SECRET);
  };
  const request = async (route, { token = auth(), method = 'GET', headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: { ...(token ? { Cookie: `packsmart_session=${token}` } : {}), ...headers } });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  fake.calls.length = 0;
  return { fake, store, server, auth, request, originals: states };
}

test('history list projects only retained summaries on demand with one authenticated state read', async t => {
  const f = await fixture(t, { archive: true });
  const before = structuredClone([...f.fake.states]);
  const response = await f.request('/api/briefs?view=history');
  assert.equal(response.status, 200); assert.equal(response.body.limit, 30);
  assert.deepEqual(response.body.briefs.map(item => item.id), ['latest', 'saved:older']);
  assert.equal(response.body.briefs[1].integrity, 'archive_pending_read');
  for (const row of response.body.briefs) assert.deepEqual(Object.keys(row).sort(), ['archived', 'generatedAt', 'id', 'integrity', 'summary']);
  assert.equal(f.fake.calls.length, 1); assert.equal(f.fake.calls[0].method, 'GET');
  assert.ok(f.fake.calls[0].url.pathname.endsWith('/saas_workspace_state'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual([...f.fake.states], before);
  const text = JSON.stringify(response.body);
  for (const forbidden of ['sourceSignature', 'sha256', 'archiveId', 'today', OTHER, 'synthetic-unusable-password-hash']) assert.ok(!text.includes(forbidden));
});

test('full archived detail reuses authenticated snapshot and verifies one exact archive row', async t => {
  const f = await fixture(t, { archive: true });
  const response = await f.request('/api/briefs/saved%3Aolder');
  assert.equal(response.status, 200); assert.equal(response.body.integrity, 'verified_archive');
  assert.deepEqual(response.body.brief, f.originals[0].dailyBriefs[1]);
  assert.equal(response.body.brief.today.contribution, null);
  assert.equal(f.fake.calls.length, 2);
  assert.ok(f.fake.calls.every(call => call.method === 'GET'));
  const archive = f.fake.calls[1];
  assert.ok(archive.url.pathname.endsWith('/operations_briefs'));
  assert.equal(archive.url.searchParams.get('workspace_id'), `eq.${WS}`);
  assert.equal(archive.url.searchParams.get('select'), 'id,workspace_id,metrics');
  assert.equal(archive.url.searchParams.get('limit'), '2');
});

test('ordinary full detail and legacy list preserve the current authenticated read contract', async t => {
  const f = await fixture(t);
  const fullResult = await f.request('/api/briefs/saved%3Aolder');
  assert.equal(fullResult.status, 200); assert.equal(fullResult.body.integrity, 'retained');
  assert.deepEqual(fullResult.body.brief, f.originals[0].dailyBriefs[1]);
  assert.equal(f.fake.calls.length, 1);
  const list = await f.request('/api/briefs');
  assert.deepEqual(list.body, { briefs: f.originals[0].dailyBriefs });
  assert.equal((await f.request('/api/briefs?view=other')).body.code, 'INVALID_BRIEF_VIEW');
});

test('existing role access remains tenant scoped and request selectors cannot promote archive authority', async t => {
  const f = await fixture(t, { archive: true });
  for (const role of ['owner', 'admin', 'member', 'viewer']) {
    const result = await f.request(`/api/briefs?view=history&workspaceId=${OTHER}`, { token: f.auth(WS, role), headers: { 'X-Workspace-Id': OTHER } });
    assert.equal(result.status, 200);
    assert.ok(result.body.briefs.every(row => row.summary.startsWith(WS)));
  }
  const row = f.fake.states.get(WS).dailyBriefs[1];
  const arbitrary = await f.request('/api/briefs/' + encodeURIComponent(row.archive.archiveId));
  assert.equal(arbitrary.status, 404); assert.equal(arbitrary.body.code, 'BRIEF_NOT_FOUND');
  const other = await f.request('/api/briefs/saved%3Aolder', { token: f.auth(OTHER) });
  assert.equal(other.status, 200); assert.equal(other.body.integrity, 'retained');
  assert.equal(other.body.brief.summary, `${OTHER} recorded history`);
});

test('missing and corrupted archives fail closed without returning the hot stub or mutating state', async t => {
  const f = await fixture(t, { archive: true });
  const row = f.fake.states.get(WS).dailyBriefs[1];
  const table = f.fake.tables.get('operations_briefs');
  const archive = table.find(item => item.id === row.archive.archiveId);
  assert.ok(archive);
  const before = structuredClone([...f.fake.states]);
  archive.metrics.summary = 'Changed after compaction';
  const corrupt = await f.request('/api/briefs/saved%3Aolder');
  assert.equal(corrupt.status, 503); assert.equal(corrupt.body.brief, undefined);
  f.fake.tables.set('operations_briefs', table.filter(item => item !== archive));
  const missing = await f.request('/api/briefs/saved%3Aolder');
  assert.equal(missing.status, 503); assert.equal(missing.body.brief, undefined);
  assert.deepEqual([...f.fake.states], before);
  assert.ok(f.fake.calls.every(call => call.method === 'GET'));
});

test('history reads retain fresh session checks and do not disclose rows to unauthenticated callers', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/briefs?view=history', { token: null })).status, 401);
  assert.equal(f.fake.calls.length, 0);
  const token = f.auth(), owner = f.fake.states.get(WS).users[0];
  owner.sessionVersion = 2;
  assert.equal((await f.request('/api/briefs/latest', { token })).body.code, 'SESSION_INVALID');
  owner.sessionVersion = 1; owner.passwordChangeRequired = true;
  assert.equal((await f.request('/api/briefs/latest', { token })).body.code, 'PASSWORD_CHANGE_REQUIRED');
  owner.passwordChangeRequired = false; owner.active = false;
  assert.equal((await f.request('/api/briefs/latest', { token })).body.code, 'SESSION_INVALID');
  assert.ok(f.fake.calls.every(call => call.method === 'GET'));
});

test('oversized legacy detail stays stored and is distinct from a missing history row', async t => {
  const f = await fixture(t), id = 'saved:older', saved = f.fake.states.get(WS);
  saved.dailyBriefs[1] = { id, summary: 'Saved historical summary', generatedAt: '2020-01-02T12:00:00.000Z',
    archive: { table: 'operations_briefs', id, sha256: 'a'.repeat(64) } };
  const row = { id, workspace_id: WS, metrics: { ...full(id), detail: 'x'.repeat(2097152) } };
  f.fake.tables.set('operations_briefs', [row]);
  const before = structuredClone(saved);
  const oversized = await f.request('/api/briefs/saved%3Aolder');
  assert.equal(oversized.status, 503); assert.equal(oversized.body.code, 'BRIEF_ARCHIVE_TOO_LARGE');
  assert.equal(oversized.body.brief, undefined); assert.deepEqual(saved, before);
  assert.equal(f.fake.tables.get('operations_briefs')[0], row);
  assert.equal(row.metrics.detail.length, 2097152);
  f.fake.tables.set('operations_briefs', []);
  const missing = await f.request('/api/briefs/saved%3Aolder');
  assert.equal(missing.status, 503); assert.equal(missing.body.code, 'BRIEF_ARCHIVE_UNAVAILABLE');
  assert.ok(f.fake.calls.every(call => call.method === 'GET'));
});
