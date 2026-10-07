/**
 * Actual PostgreSQL 17 gate for the narrow reporting-status CAS operation.
 * Use a fresh disposable cluster and empty runvara_reporting_status_test DB:
 * npm --prefix saas/server/tests/atomic-usage ci --ignore-scripts
 * REPORTING_STATUS_ALLOW_DISPOSABLE_TEST_DB=1 \
 * REPORTING_STATUS_TEST_DATABASE_URL=postgres://postgres:password@127.0.0.1:5432/runvara_reporting_status_test \
 * node --test --test-concurrency=1 saas/server/tests/reporting-status-postgres.mjs
 *
 * Reuses the locked test-only pg driver. No production project or credentials.
 * Missing configuration/PostgreSQL fails the gate; it never silently skips.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const connectionString = process.env.REPORTING_STATUS_TEST_DATABASE_URL;
assert.equal(process.env.REPORTING_STATUS_ALLOW_DISPOSABLE_TEST_DB, '1', 'Explicit disposable database opt-in required');
assert.ok(connectionString, 'REPORTING_STATUS_TEST_DATABASE_URL is required; PostgreSQL tests may not silently skip');
const databaseUrl = new URL(connectionString);
assert.ok(['postgres:', 'postgresql:'].includes(databaseUrl.protocol));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname), 'Only a local disposable PostgreSQL server is allowed');
assert.equal(databaseUrl.pathname, '/runvara_reporting_status_test', 'Refusing any database except runvara_reporting_status_test');
assert.equal(databaseUrl.search, '', 'Connection-string target overrides are forbidden');
assert.equal(databaseUrl.hash, '', 'Connection-string fragments are forbidden');
const require = createRequire(new URL('./atomic-usage/package.json', import.meta.url));
const { Client } = require('pg');
const TABLE = 'public.saas_workspace_state';
const SIGNATURE = 'public.runvara_commit_reporting_status(text,text,text,jsonb,timestamp with time zone)';
const OLD = '2026-10-01T00:00:00.000Z';
const NOW = '2026-10-07T07:00:00.000Z';
const clients = new Set();
let admin;
let foundationAcl;
let migrationSql;
let preMigrationFixture;

async function connect(role = 'service_role') {
  const client = new Client({ connectionString, ssl: false, options: '', connectionTimeoutMillis: 5000,
    statement_timeout: 15_000, application_name: 'runvara-reporting-status-test' });
  await client.connect();
  clients.add(client);
  assert.ok(['postgres', 'service_role', 'anon', 'authenticated', 'atomic_usage_untrusted'].includes(role));
  if (role !== 'postgres') await client.query(`SET ROLE ${role}`);
  await client.query("SET TIME ZONE 'UTC'");
  return client;
}
async function close(client) { clients.delete(client); await client.end(); }
async function using(role, fn) { const client = await connect(role); try { return await fn(client); } finally { await close(client); } }
function report(extra = {}) {
  return { status: 'connected', detail: 'Reporting refresh completed.', lastSyncAt: NOW,
    lastFailureAt: null, lastError: null, failures: [], ...extra };
}
function failure(extra = {}) {
  return { table: 'products', code: 'MIRROR_DEFERRED', httpStatus: 503, databaseCode: 'PGRST205', ...extra };
}
function degraded(extra = {}) {
  return report({ status: 'degraded', detail: '1 reporting table needs repair.', lastSyncAt: OLD,
    lastFailureAt: NOW, lastError: 'PGRST205', failures: [failure()], ...extra });
}
async function fixture({ mutate = () => {}, large = false, revision = randomUUID() } = {}) {
  const workspaceId = `reporting-pg-${randomUUID()}`;
  const state = { _revision: revision, workspace: { id: workspaceId, updatedAt: OLD, name: 'Synthetic workspace' },
    businessObjectives: [{ id: 'objective-1', status: 'active', nested: { '雪🚀': [null, 0, true, 'unchanged'] } }],
    automationRuns: [{ id: 'run-1', evidence: large ? 'Recorded business evidence. '.repeat(10_000) : 'Keep all evidence' }],
    aiEconomics: { monthlyCostLimitUsd: 30, governance: { enabled: false } },
    integrationStatus: { supabase: { status: 'connected', lastSyncAt: OLD },
      shopify: { status: 'connected', sentinel: ['雪', null, false] },
      reporting: degraded({ lastFailureAt: OLD, lastSyncAt: null }) } };
  mutate(state);
  await admin.query('INSERT INTO public.workspaces(id,name,slug,settings,created_at,updated_at) VALUES ($1,$1,$1,$2,$3,$3)',
    [workspaceId, { untouched: ['settings', '雪', null] }, OLD]);
  await admin.query(`INSERT INTO ${TABLE}(workspace_id,state,updated_at) VALUES ($1,$2::jsonb,$3::timestamptz)`,
    [workspaceId, JSON.stringify(state), OLD]);
  return { workspaceId, revision, state, before: await snapshot(workspaceId) };
}
async function snapshot(workspaceId) {
  // Compare actual PostgreSQL JSONB send bytes, not JavaScript object order.
  // xmin also catches a write that merely rewrites equal data on a rejected call.
  return (await admin.query(`SELECT s.state,s.state->>'_revision' AS revision,s.updated_at::text AS updated_at,
      s.xmin::text AS xmin,encode(jsonb_send(to_jsonb(s)), 'hex') AS row_bytes,
      encode(jsonb_send(CASE WHEN jsonb_typeof(s.state->'integrationStatus')='object'
        THEN (s.state - '_revision') #- '{integrationStatus,reporting}' ELSE s.state - '_revision' END), 'hex') AS business_bytes,
      encode(jsonb_send(to_jsonb(w)), 'hex') AS workspace_bytes
    FROM ${TABLE} s JOIN public.workspaces w ON w.id=s.workspace_id WHERE s.workspace_id=$1`, [workspaceId])).rows[0];
}
async function commit(client, f, extra = {}) {
  const input = { workspaceId: f.workspaceId, expectedRevision: f.revision, nextRevision: randomUUID(),
    report: report(), updatedAt: NOW, ...extra };
  const result = await client.query(`SELECT * FROM public.runvara_commit_reporting_status(
    $1::text,$2::text,$3::text,$4::jsonb,$5::timestamptz)`,
  [input.workspaceId, input.expectedRevision, input.nextRevision,
    input.report === undefined ? null : JSON.stringify(input.report), input.updatedAt]);
  return { rows: result.rows, input };
}
const attempt = (f, extra) => using('service_role', client => commit(client, f, extra));
async function assertUnchanged(f) {
  assert.deepEqual(await snapshot(f.workspaceId), f.before, 'Rejected/missed CAS must leave every byte and tuple version unchanged');
}
function assertBusinessPreserved(before, after) {
  assert.equal(after.business_bytes, before.business_bytes, 'Every business field and sibling integration must remain byte-identical');
  assert.equal(after.workspace_bytes, before.workspace_bytes, 'The normalized workspace row must remain byte-identical');
}
async function aclSnapshot() {
  return (await admin.query(`SELECT n.nspname||'.'||c.relname AS name,c.relowner::regrole::text AS owner,
      c.relacl::text AS acl,c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY name`)).rows;
}
async function waitForLocks(pids) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await admin.query(`SELECT count(*)::int AS blocked FROM pg_stat_activity
      WHERE pid=ANY($1::integer[]) AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0`, [pids]);
    if (result.rows[0].blocked === pids.length) return;
    await delay(10);
  }
  assert.fail('Independent reporting sessions did not both wait on the row lock');
}

before(async () => {
  admin = await connect('postgres');
  const info = (await admin.query("SELECT current_database() AS db,current_setting('server_version_num')::int AS version")).rows[0];
  assert.equal(info.db, 'runvara_reporting_status_test');
  assert.ok(info.version >= 170000 && info.version < 180000, 'This gate requires actual PostgreSQL 17');
  assert.deepEqual((await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows, [],
    'Refusing a nonempty database: use a fresh disposable PostgreSQL cluster');
  await admin.query(await readFile(new URL('./atomic-usage-postgres-fixture.sql', import.meta.url), 'utf8'));
  foundationAcl = await aclSnapshot();
  preMigrationFixture = await fixture({ large: true });
  const directory = new URL('../supabase/migrations/', import.meta.url);
  const names = (await readdir(directory)).filter(name => name.endsWith('_reporting_status_cas.sql'));
  assert.equal(names.length, 1, 'Exactly one reporting-status CAS migration must exist');
  migrationSql = await readFile(new URL(names[0], directory), 'utf8');
  await admin.query(migrationSql);
}, { timeout: 30_000 });
after(async () => { await Promise.all([...clients].map(client => close(client).catch(() => {}))); });

test('function is invoker-only with empty search_path and unchanged table grants/RLS', async () => {
  const config = (await admin.query('SELECT prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure', [SIGNATURE])).rows[0];
  assert.equal(config.prosecdef, false);
  assert.ok(config.proconfig.includes('search_path=""'), 'Function must pin an empty search_path');
  const grants = (await admin.query(`SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS role,
      a.privilege_type FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid=$1::regprocedure AND a.grantee<>p.proowner ORDER BY role,a.privilege_type`, [SIGNATURE])).rows;
  assert.deepEqual(grants, [{ role: 'service_role', privilege_type: 'EXECUTE' }]);
  assert.deepEqual(await aclSnapshot(), foundationAcl, 'Migration may not broaden table access or disable RLS');
});

for (const status of ['connected', 'degraded']) {
  test(`${status} reporting update changes exactly reporting, revision, and row updated_at`, async () => {
    const f = await fixture({ large: true }), tenant = await fixture();
    const nextReport = status === 'connected' ? report() : degraded();
    const result = await attempt(f, { report: nextReport });
    assert.deepEqual(result.rows, [{ workspace_id: f.workspaceId }]);
    const saved = await snapshot(f.workspaceId);
    assert.equal(saved.revision, result.input.nextRevision);
    assert.deepEqual(saved.state.integrationStatus.reporting, nextReport);
    assert.equal(new Date(saved.updated_at).toISOString(), NOW);
    assert.notEqual(saved.xmin, f.before.xmin);
    assertBusinessPreserved(f.before, saved);
    await assertUnchanged(tenant);
  });
}

test('stale revision, wrong tenant revision, missing tenant, and replay return zero rows without writes', async () => {
  const f = await fixture(), tenant = await fixture();
  for (const extra of [{ expectedRevision: randomUUID() }, { workspaceId: tenant.workspaceId },
    { workspaceId: `absent-${randomUUID()}` }]) {
    assert.deepEqual((await attempt(f, extra)).rows, []);
    await assertUnchanged(f);
    await assertUnchanged(tenant);
  }
  const first = await attempt(f);
  const committed = await snapshot(f.workspaceId);
  assert.deepEqual((await attempt(f, first.input)).rows, [], 'An exact retry cannot rewrite a successful CAS');
  assert.deepEqual(await snapshot(f.workspaceId), committed);
  await assertUnchanged(tenant);
});

test('two physical sessions racing the same predecessor produce exactly one committed winner', { timeout: 20_000 }, async t => {
  const f = await fixture({ large: true }), tenant = await fixture();
  const sessions = await Promise.all([connect(), connect()]);
  let pending = [];
  try {
    const pids = await Promise.all(sessions.map(async c => (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
    assert.equal(new Set(pids).size, 2, 'The race must use distinct PostgreSQL backends');
    await admin.query('BEGIN');
    await admin.query(`SELECT workspace_id FROM ${TABLE} WHERE workspace_id=$1 FOR UPDATE`, [f.workspaceId]);
    pending = sessions.map((client, i) => commit(client, f, { report: report({ detail: `Concurrent writer ${i}` }) })
      .then(value => ({ value }), error => ({ error })));
    await waitForLocks(pids);
    await admin.query('COMMIT');
    const settled = await Promise.all(pending);
    for (const result of settled) if (result.error) throw result.error;
    const results = settled.map(result => result.value);
    assert.deepEqual(results.map(result => result.rows.length).sort(), [0, 1]);
    const winner = results.find(result => result.rows.length === 1);
    assert.deepEqual(winner.rows, [{ workspace_id: f.workspaceId }]);
    const saved = await snapshot(f.workspaceId);
    assert.equal(saved.revision, winner.input.nextRevision);
    assert.deepEqual(saved.state.integrationStatus.reporting, winner.input.report);
    assertBusinessPreserved(f.before, saved);
    await assertUnchanged(tenant);
    t.diagnostic(`Observed two blocked PostgreSQL backends (${pids.join(', ')}), then one winner and one CAS miss`);
  } finally {
    await admin.query('ROLLBACK');
    await Promise.all(pending);
    await Promise.all(sessions.map(close));
  }
});

test('reporting blocked behind a newer business commit cannot overwrite that commit', { timeout: 20_000 }, async () => {
  const f = await fixture(), client = await connect();
  let pending;
  try {
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const businessRevision = randomUUID();
    await admin.query('BEGIN');
    await admin.query(`UPDATE ${TABLE} SET state=jsonb_set(jsonb_set(state,'{_revision}',to_jsonb($2::text)),
      '{businessObjectives,0,status}','"completed"'::jsonb),updated_at=$3::timestamptz WHERE workspace_id=$1`,
    [f.workspaceId, businessRevision, NOW]);
    pending = commit(client, f).then(value => ({ value }), error => ({ error }));
    await waitForLocks([pid]);
    const newer = await snapshot(f.workspaceId);
    await admin.query('COMMIT');
    const result = await pending;
    if (result.error) throw result.error;
    assert.deepEqual(result.value.rows, []);
    assert.deepEqual(await snapshot(f.workspaceId), newer, 'CAS miss must preserve the complete newer business commit');
  } finally {
    await admin.query('ROLLBACK');
    if (pending) await pending;
    await close(client);
  }
});

for (const role of ['anon', 'authenticated', 'atomic_usage_untrusted']) {
  test(`${role} cannot execute the function, including through PUBLIC membership`, async () => {
    const f = await fixture();
    assert.equal((await admin.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed', [role, SIGNATURE])).rows[0].allowed, false);
    await assert.rejects(using(role, client => commit(client, f)), { code: '42501' });
    await assertUnchanged(f);
  });
}

test('SECURITY INVOKER cannot write when its service role lacks table UPDATE', async () => {
  const f = await fixture();
  await admin.query(`REVOKE UPDATE ON ${TABLE} FROM service_role`);
  try {
    await assert.rejects(attempt(f), { code: '42501' });
    await assertUnchanged(f);
  } finally { await admin.query(`GRANT UPDATE ON ${TABLE} TO service_role`); }
});

for (const [name, mutate] of [
  ['embedded workspace mismatch', state => { state.workspace.id = 'different-workspace'; }],
  ['missing embedded workspace', state => { delete state.workspace; }],
  ['missing integrationStatus', state => { delete state.integrationStatus; }],
  ['null integrationStatus', state => { state.integrationStatus = null; }],
  ['array integrationStatus', state => { state.integrationStatus = []; }],
  ['scalar integrationStatus', state => { state.integrationStatus = 'invalid'; }]
]) {
  test(`${name} fails closed without inserting or changing any field`, async () => {
    const f = await fixture({ mutate });
    assert.deepEqual((await attempt(f)).rows, []);
    await assertUnchanged(f);
  });
}

test('a valid integrationStatus object can gain a missing reporting key without losing siblings', async () => {
  const f = await fixture({ mutate(state) { delete state.integrationStatus.reporting; } });
  assert.equal((await attempt(f)).rows.length, 1);
  assertBusinessPreserved(f.before, await snapshot(f.workspaceId));
});

test('maximum valid field lengths and 32 failures remain accepted and preserve all business bytes', async () => {
  const f = await fixture();
  const bounded = degraded({ detail: '雪'.repeat(320), lastError: 'X'.repeat(80),
    failures: Array.from({ length: 32 }, () => failure({ table: 'x'.repeat(80), code: 'X'.repeat(80), databaseCode: null })) });
  assert.equal((await attempt(f, { report: bounded })).rows.length, 1);
  const saved = await snapshot(f.workspaceId);
  assert.deepEqual(saved.state.integrationStatus.reporting, bounded);
  assertBusinessPreserved(f.before, saved);
});

const invalidReports = [
  ['SQL NULL report', undefined], ['JSON null report', null], ['array report', []], ['string report', 'invalid'], ['numeric report', 1],
  ['missing required keys', { status: 'connected' }], ['unknown report key', report({ workspace: { id: 'other' } })],
  ['unknown status', report({ status: 'ready' })], ['numeric status', report({ status: 1 })],
  ['null detail', report({ detail: null })], ['object detail', report({ detail: {} })], ['oversize detail', report({ detail: 'x'.repeat(321) })],
  ['invalid sync date', report({ lastSyncAt: 'not-a-date' })], ['non-UTC sync date', report({ lastSyncAt: '2026-10-07T07:00:00.000+00:00' })],
  ['normalized next-day sync date', report({ lastSyncAt: '2026-10-07T24:00:00.000Z' })],
  ['normalized leap-second sync date', report({ lastSyncAt: '2026-10-07T07:00:60.000Z' })],
  ['impossible sync date', report({ lastSyncAt: '2026-02-31T07:00:00.000Z' })], ['numeric failure date', report({ lastFailureAt: 1 })],
  ['nonarray failures', report({ failures: {} })], ['null failures', report({ failures: null })],
  ['connected with failures', report({ failures: [failure()] })], ['connected with error', report({ lastError: 'PGRST205' })],
  ['degraded without failures', degraded({ failures: [] })], ['degraded error mismatch', degraded({ lastError: 'DIFFERENT_ERROR' })],
  ['invalid error characters', degraded({ lastError: 'private detail' })], ['oversize error', degraded({ lastError: 'X'.repeat(81) })],
  ['too many failures', degraded({ failures: Array.from({ length: 33 }, () => failure()) })],
  ['nonobject failure', degraded({ failures: [null] })], ['missing failure keys', degraded({ failures: [{ table: 'products' }] })],
  ['unknown failure key', degraded({ failures: [failure({ payload: { private: 'unbounded' } })] })],
  ['invalid table name', degraded({ failures: [failure({ table: 'products; DROP TABLE workspaces' })] })],
  ['oversize table name', degraded({ failures: [failure({ table: 'x'.repeat(81) })] })],
  ['invalid failure code', degraded({ failures: [failure({ code: 'arbitrary detail' })] })],
  ['oversize failure code', degraded({ failures: [failure({ code: 'X'.repeat(81) })] })],
  ['HTTP status too low', degraded({ failures: [failure({ httpStatus: 99 })] })],
  ['HTTP status too high', degraded({ failures: [failure({ httpStatus: 600 })] })],
  ['fractional HTTP status', degraded({ failures: [failure({ httpStatus: 503.5 })] })],
  ['string HTTP status', degraded({ failures: [failure({ httpStatus: '503' })] })],
  ['invalid database code', degraded({ failures: [failure({ databaseCode: 'secret-detail' })] })],
  ['oversize JSONB report', degraded({ detail: '雪'.repeat(6000) })]
];
for (const [name, invalid] of invalidReports) {
  test(`${name} is rejected with 22023 and no writes`, async () => {
    const f = await fixture(), tenant = await fixture();
    await assert.rejects(attempt(f, { report: invalid }), { code: '22023', message: 'REPORTING_STATUS_INPUT_INVALID' });
    await assertUnchanged(f);
    await assertUnchanged(tenant);
  });
}

for (const [name, extra] of [
  ['null workspace', { workspaceId: null }], ['empty workspace', { workspaceId: '' }], ['untrimmed workspace', { workspaceId: ' workspace ' }],
  ['oversize workspace', { workspaceId: 'x'.repeat(257) }], ['control character workspace', { workspaceId: 'workspace\nvalue' }],
  ['null expected revision', { expectedRevision: null }], ['invalid expected revision', { expectedRevision: 'invalid' }],
  ['null next revision', { nextRevision: null }], ['invalid next revision', { nextRevision: 'invalid' }],
  ['uppercase next revision', { nextRevision: 'AAAAAAAA-AAAA-4AAA-AAAA-AAAAAAAAAAAA' }],
  ['null update timestamp', { updatedAt: null }], ['infinite update timestamp', { updatedAt: 'infinity' }],
  ['negative infinite update timestamp', { updatedAt: '-infinity' }]
]) {
  test(`${name} is rejected with 22023 and no writes`, async () => {
    const f = await fixture();
    await assert.rejects(attempt(f, extra), { code: '22023', message: 'REPORTING_STATUS_INPUT_INVALID' });
    await assertUnchanged(f);
  });
}

test('equal predecessor and successor revisions are rejected without writes', async () => {
  const f = await fixture();
  await assert.rejects(attempt(f, { nextRevision: f.revision }), { code: '22023', message: 'REPORTING_STATUS_INPUT_INVALID' });
  await assertUnchanged(f);
});

test('migration preserves preexisting workspace bytes and table grants', async () => {
  await assertUnchanged(preMigrationFixture);
  assert.deepEqual(await aclSnapshot(), foundationAcl);
});
