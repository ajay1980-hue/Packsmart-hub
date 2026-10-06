/**
 * Dedicated actual-PostgreSQL gate for deterministic objective preparation jobs.
 * CI: .github/workflows/objective-job-check.yml, official postgres:17.6.
 * Local: use a fresh PostgreSQL 17 cluster and empty runvara_objective_job_test
 * database, then install the existing pinned test-only driver:
 * npm --prefix saas/server/tests/atomic-usage ci --ignore-scripts
 * OBJECTIVE_JOB_ALLOW_DISPOSABLE_TEST_DB=1 \
 * OBJECTIVE_JOB_TEST_DATABASE_URL=postgres://postgres:password@127.0.0.1:5432/runvara_objective_job_test \
 * node --test --test-concurrency=1 saas/server/tests/objective-job-postgres.mjs
 * No Supabase project, credentials, production calls, or accounting migration.
 * Missing PostgreSQL is a failure, never a skip or a mock substitution.
 */
import assert from 'node:assert/strict';
import { before, after, afterEach, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const connectionString = process.env.OBJECTIVE_JOB_TEST_DATABASE_URL;
assert.equal(process.env.OBJECTIVE_JOB_ALLOW_DISPOSABLE_TEST_DB, '1', 'Explicit disposable database opt-in required');
assert.ok(connectionString, 'OBJECTIVE_JOB_TEST_DATABASE_URL is required; integration tests may not silently skip');
const databaseUrl = new URL(connectionString);
assert.ok(['postgres:', 'postgresql:'].includes(databaseUrl.protocol));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname), 'Only local disposable PostgreSQL is allowed');
assert.equal(databaseUrl.pathname, '/runvara_objective_job_test', 'Refusing any database except runvara_objective_job_test');
assert.equal(databaseUrl.search, '', 'Connection-string options that could override the local target are forbidden');
assert.equal(databaseUrl.hash, '', 'Connection-string fragments are forbidden');
const require = createRequire(new URL('./atomic-usage/package.json', import.meta.url));
const { Client } = require('pg');
const JOBS = 'public.runvara_agent_jobs';
const CLAIM = 'public.runvara_claim_agent_jobs(text,integer,integer)';
const GUARD = 'public.runvara_guard_objective_prepare_job()';
const TERMINAL = ['succeeded', 'blocked', 'dead_letter'];
const LEGACY = ['agent_command', 'connection_sync', 'connection_doctor', 'marketing_plan'];
const clients = new Set();
const fixtures = [];
let admin;
let beforeAcl;
let beforeClaim;
let legacyBefore;
let migrationSql;

async function connect(role = 'service_role') {
  const client = new Client({ connectionString, ssl: false, options: '', connectionTimeoutMillis: 5000,
    statement_timeout: 20_000, application_name: 'runvara-objective-job-test' });
  await client.connect();
  clients.add(client);
  assert.ok(['postgres', 'service_role', 'anon', 'authenticated', 'atomic_usage_untrusted'].includes(role));
  if (role !== 'postgres') await client.query(`SET ROLE ${role}`);
  await client.query("SET TIME ZONE 'UTC'");
  return client;
}
async function close(client) { clients.delete(client); await client.end(); }
async function using(role, fn) { const client = await connect(role); try { return await fn(client); } finally { await close(client); } }
async function readJob(id, client = admin) {
  const result = await client.query(`SELECT j.*,j.lease_until::text AS lease_token FROM ${JOBS} j WHERE id=$1`, [id]);
  return result.rows[0];
}
async function workspaceSnapshot(workspaceId) {
  return (await admin.query(`SELECT to_jsonb(w) AS workspace,to_jsonb(s) AS state
    FROM public.workspaces w JOIN public.saas_workspace_state s ON s.workspace_id=w.id WHERE w.id=$1`, [workspaceId])).rows[0];
}
async function fixture({ status = 'running', type = 'objective_prepare', leaseMs = 60_000, tier = 'deterministic', provider = null,
  aiProvider = null, aiModel = null, aiUnits = 0, attempts = status === 'queued' ? 0 : 1, maxAttempts = 3 } = {}) {
  const workspaceId = `objective-pg-${randomUUID()}`;
  const id = `${workspaceId}-job`;
  await admin.query('INSERT INTO public.workspaces (id,name,slug,settings) VALUES ($1,$1,$1,$2)', [workspaceId, { untouched: true }]);
  await admin.query('INSERT INTO public.saas_workspace_state (workspace_id,state) VALUES ($1,$2)',
    [workspaceId, { workspace: { id: workspaceId }, objective: { sentinel: 'never mutate workspace state' } }]);
  await admin.query(`INSERT INTO ${JOBS}
    (id,workspace_id,type,status,attempts,worker_id,lease_until,idempotency_key,payload,result,ai_tier,provider,ai_provider,ai_model,ai_units,completed_at,max_attempts)
    VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $4='running' THEN clock_timestamp()+$7*interval '1 millisecond' ELSE NULL END,
      $1,$8,$9,$10,$11,$12,$13,$14,CASE WHEN $4 IN ('succeeded','blocked','dead_letter') THEN clock_timestamp() ELSE NULL END,$15)`,
    [id, workspaceId, type, status, attempts, status === 'running' ? 'objective-worker-old' : null,
      leaseMs, { objectiveId: 'synthetic-objective', mode: 'preparation_only' }, { sentinel: 'original-result' }, tier, provider, aiProvider, aiModel, aiUnits, maxAttempts]);
  const f = { workspaceId, id, job: await readJob(id), workspace: await workspaceSnapshot(workspaceId) };
  fixtures.push(f);
  return f;
}
async function assertUnchanged(f, job = f.job) {
  assert.deepEqual(await readJob(f.id), job, 'Rejected write must leave every job field, including result, unchanged');
  assert.deepEqual(await workspaceSnapshot(f.workspaceId), f.workspace, 'Job writes must never mutate workspace/state');
}
async function aclSnapshot() {
  return (await admin.query(`SELECT 'relation' AS kind,n.nspname||'.'||c.relname AS name,
      c.relowner::regrole::text AS owner,c.relacl::text AS acl,c.relrowsecurity AS rls
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    UNION ALL
    SELECT 'function',p.oid::regprocedure::text,p.proowner::regrole::text,p.proacl::text,NULL
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.oid<>coalesce(to_regprocedure($1),0::oid)
    ORDER BY kind,name`, [GUARD])).rows;
}
// These are the same independent fencing predicates required from the store.
// The client timestamp is intentionally bound before the statement is sent; the
// database trigger must still reject expiry during a later row-lock wait.
async function fencedWrite(client, f, { status = 'succeeded', report = { prepared: true }, expected = {}, errorCode = null } = {}) {
  const old = { workspace_id: f.workspaceId, id: f.id, worker_id: f.job.worker_id,
    attempts: f.job.attempts, lease_token: f.job.lease_token, clientNow: new Date().toISOString(), ...expected };
  return client.query(`UPDATE ${JOBS} SET status=$7,result=$8::jsonb,worker_id=NULL,lease_until=NULL,
      completed_at=CASE WHEN $7='queued' THEN NULL ELSE clock_timestamp() END,
      available_at=CASE WHEN $7='queued' THEN clock_timestamp()+interval '1 second' ELSE available_at END,
      error_code=$9,updated_at=clock_timestamp()
    WHERE workspace_id=$1 AND id=$2 AND type='objective_prepare' AND status='running'
      AND worker_id=$3 AND attempts=$4 AND lease_until=$5::timestamptz AND lease_until>$6::timestamptz
    RETURNING *`, [old.workspace_id, old.id, old.worker_id, old.attempts, old.lease_token, old.clientNow, status, report, errorCode]);
}
async function directWrite(client, f, status) {
  return client.query(`UPDATE ${JOBS} SET status=$2,result='{"tampered":true}'::jsonb,
    worker_id=NULL,lease_until=NULL,completed_at=CASE WHEN $2='queued' THEN NULL ELSE clock_timestamp() END,
    error_code='ORDINARY_RETRY',updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [f.id, status]);
}
async function claim(client, worker = 'objective-worker-new', leaseSeconds = 60) {
  return client.query('SELECT * FROM public.runvara_claim_agent_jobs($1,50,$2)', [worker, leaseSeconds]);
}
async function waitForActualLeaseExpiry(job) {
  // Real wall time, with no trigger disabling, clock mocking, or lease editing.
  const remaining = (await admin.query('SELECT greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp()))*1000)::float8 AS ms', [job.lease_token])).rows[0].ms;
  await delay(remaining + 100);
  assert.equal((await admin.query('SELECT clock_timestamp()>$1::timestamptz AS expired', [job.lease_token])).rows[0].expired, true);
}
function assertExhausted(job, original) {
  assert.equal(job.status, 'dead_letter');
  assert.equal(job.error_code, 'OBJECTIVE_LEASE_ATTEMPTS_EXHAUSTED');
  assert.ok(job.completed_at instanceof Date && Number.isFinite(job.completed_at.getTime()));
  assert.deepEqual(job.updated_at, job.completed_at, 'Exhaustion timestamps must share the fresh wall-clock check');
  assert.equal(job.worker_id, null);
  assert.equal(job.lease_until, null);
  assert.equal(job.lease_token, null);
  for (const key of ['id', 'workspace_id', 'type', 'attempts', 'max_attempts', 'payload', 'result',
    'idempotency_key', 'actor', 'provider', 'ai_provider', 'ai_model', 'ai_tier', 'ai_units', 'priority', 'concurrency_limit', 'created_at']) {
    assert.deepEqual(job[key], original[key], `Exhaustion must preserve ${key}`);
  }
}
async function waitUntilBlocked(targetPid, blockerPid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await admin.query('SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) AS blocked', [targetPid, blockerPid]);
    if (result.rows[0].blocked) return;
    await delay(10);
  }
  assert.fail('The independent worker did not wait on the expected row-lock holder');
}

before(async () => {
  admin = await connect('postgres');
  const info = (await admin.query(`SELECT current_database() AS db,current_user AS role,
    current_setting('server_version_num')::int AS version`)).rows[0];
  assert.equal(info.db, 'runvara_objective_job_test');
  assert.ok(info.version >= 170000 && info.version < 180000, 'This gate requires actual PostgreSQL 17');
  assert.equal(info.role, 'postgres', 'Disposable setup requires the isolated test-cluster postgres owner');
  // Docker port forwarding makes inet_server_addr() an internal container IP;
  // inspect the actual client socket peer instead of rejecting official CI.
  assert.ok(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(admin.connection.stream.remoteAddress),
    'Resolved PostgreSQL connection must terminate on this machine');
  // Reject relations/functions in every user schema, not merely public tables.
  const objects = (await admin.query(`SELECT n.nspname,c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
    UNION ALL SELECT n.nspname,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'`)).rows;
  assert.deepEqual(objects, [], 'Refusing a nonempty database: use a fresh disposable service');
  await admin.query(await readFile(new URL('./atomic-usage-postgres-fixture.sql', import.meta.url), 'utf8'));
  for (const file of ['20260927113000_runvara_agent_operations.sql', '20260927122500_ai_usage_economics.sql']) {
    await admin.query(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
  }
  await admin.query("INSERT INTO public.workspaces(id,name,slug) VALUES ('objective-legacy-sentinel','Legacy','objective-legacy-sentinel')");
  await admin.query(`INSERT INTO ${JOBS}(id,workspace_id,type,status,idempotency_key,provider,ai_provider,ai_model,ai_tier,ai_units,result)
    VALUES ('objective-legacy-sentinel','objective-legacy-sentinel','agent_command','succeeded','legacy','openai','openai','legacy-model','standard',4,'{"legacy":true}')`);
  legacyBefore = await readJob('objective-legacy-sentinel');
  beforeAcl = await aclSnapshot();
  beforeClaim = (await admin.query('SELECT pg_get_functiondef($1::regprocedure) AS definition', [CLAIM])).rows[0].definition;
  const directory = new URL('../supabase/migrations/', import.meta.url);
  const matches = (await readdir(directory)).filter(name => /^\d{14}_objective_prepare_job_guard\.sql$/.test(name));
  assert.equal(matches.length, 1, 'Exactly one CLI-created objective_prepare_job_guard migration is required');
  migrationSql = await readFile(new URL(matches[0], directory), 'utf8');
  await admin.query(migrationSql);
}, { timeout: 30_000 });

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    try { assert.deepEqual(await workspaceSnapshot(f.workspaceId), f.workspace, 'No successful or rejected job write may mutate workspace/state'); }
    finally { await admin.query('DELETE FROM public.workspaces WHERE id=$1', [f.workspaceId]); }
  }
});
after(async () => { await Promise.all([...clients].map(client => close(client).catch(() => {}))); });

test('migration preserves all existing grants, RLS, claim implementation, and legacy jobs', async () => {
  assert.deepEqual(await aclSnapshot(), beforeAcl, 'No existing object grants or RLS settings may change');
  assert.equal((await admin.query('SELECT pg_get_functiondef($1::regprocedure) AS definition', [CLAIM])).rows[0].definition, beforeClaim);
  assert.deepEqual(await readJob('objective-legacy-sentinel'), legacyBefore);
  assert.equal((await admin.query("SELECT count(*)::int AS count FROM pg_policies WHERE schemaname='public'")).rows[0].count, 0);
});

test('guard is a row BEFORE UPDATE SECURITY INVOKER trigger with empty search_path and no table reads', async () => {
  const result = await admin.query(`SELECT p.prosecdef,p.proconfig,p.prosrc,p.provolatile,t.tgtype,t.tgenabled
    FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid=$1::regclass AND NOT t.tgisinternal`, [JOBS]);
  assert.equal(result.rows.length, 1);
  const guard = result.rows[0];
  assert.equal(guard.prosecdef, false);
  assert.deepEqual(guard.proconfig, ['search_path=""']);
  assert.equal(guard.provolatile, 'v');
  assert.equal(guard.tgtype, 19, 'Trigger must run BEFORE UPDATE FOR EACH ROW');
  assert.equal(guard.tgenabled, 'O');
  const body = guard.prosrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').replace(/'(?:''|[^'])*'/g, "''");
  assert.match(body, /\bclock_timestamp\s*\(/i, 'Wall clock must be checked after the row lock');
  assert.doesNotMatch(body, /\b(?:select|insert|update|delete|merge|perform|execute|call)\b/i, 'Guard must inspect OLD/NEW only, with no reads/writes/dynamic SQL on any table');
  assert.doesNotMatch(migrationSql.replace(/--[^\n]*/g, ''), /\bgrant\b/i, 'Migration may revoke helper execution but must not add grants');
  const grants = (await admin.query(`SELECT a.grantee::regrole::text AS grantee,a.privilege_type
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid=$1::regprocedure AND a.grantee<>p.proowner`, [GUARD])).rows;
  assert.deepEqual(grants, [], 'No PUBLIC, browser, service-role, or other explicit trigger-helper EXECUTE grants');
});

test('objective_prepare is additive and restricted to deterministic zero-cost jobs', async () => {
  for (const tier of [null, 'deterministic']) assert.equal((await fixture({ tier })).job.type, 'objective_prepare');
  for (const type of LEGACY) {
    const f = await fixture({ type, provider: 'synthetic-provider', aiProvider: 'synthetic-provider', aiModel: 'synthetic-model', aiUnits: 2, tier: 'standard' });
    assert.equal(f.job.type, type);
  }
  const f = fixtures[0];
  for (const [column, value] of [['provider', 'openai'], ['ai_provider', 'openai'], ['ai_model', 'model'], ['ai_units', 1], ['ai_tier', 'standard']]) {
    await assert.rejects(admin.query(`INSERT INTO ${JOBS}(id,workspace_id,type,idempotency_key,${column})
      VALUES ($1,$2,'objective_prepare',$1,$3)`, [`rejected-${randomUUID()}`, f.workspaceId, value]), { code: '23514' });
  }
  await assert.rejects(admin.query(`INSERT INTO ${JOBS}(id,workspace_id,type,idempotency_key) VALUES ($1,$2,'unrecognized_job',$1)`,
    [`rejected-${randomUUID()}`, f.workspaceId]), { code: '23514' });
});

test('objective identity and input remain immutable even with a live owner lease', async () => {
  const f = await fixture();
  for (const set of ["id=id||'-changed'", "workspace_id=workspace_id||'-changed'", "type='agent_command'",
    "payload='{}'::jsonb", "idempotency_key=idempotency_key||'-changed'", "actor='another-actor'", 'priority=priority+1']) {
    await assert.rejects(using('service_role', c => c.query(`UPDATE ${JOBS} SET ${set} WHERE id=$1`, [f.id])), { code: 'P0L02' });
    await assertUnchanged(f);
  }
});

test('live running jobs cannot extend their own lease or transfer ownership', async () => {
  const f = await fixture();
  for (const set of ["lease_until=lease_until+interval '1 minute'", "worker_id='objective-worker-other'", 'attempts=attempts+1']) {
    await assert.rejects(using('service_role', c => c.query(`UPDATE ${JOBS} SET ${set} WHERE id=$1`, [f.id])),
      error => ['P0L02', 'P0L03'].includes(error.code));
    await assertUnchanged(f);
  }
});

for (const status of TERMINAL) {
  test(`live lease permits fenced ${status} publication without workspace mutation`, async () => {
    const f = await fixture();
    const report = { objectiveId: 'synthetic-objective', prepared: true, version: 1 };
    assert.equal((await using('service_role', c => fencedWrite(c, f, { status, report }))).rowCount, 1);
    const job = await readJob(f.id);
    assert.equal(job.status, status);
    assert.deepEqual(job.result, report);
    assert.equal(job.worker_id, null);
    assert.equal(job.lease_until, null);
    assert.ok(job.completed_at);
  });
}

test('live lease permits ordinary fenced retry', async () => {
  const f = await fixture();
  assert.equal((await using('service_role', c => fencedWrite(c, f, { status: 'queued', report: f.job.result, errorCode: 'TEMPORARY_PREPARATION_ERROR' }))).rowCount, 1);
  const job = await readJob(f.id);
  assert.equal(job.status, 'queued');
  assert.equal(job.attempts, f.job.attempts);
  assert.equal(job.completed_at, null);
});

for (const status of [...TERMINAL, 'queued']) {
  test(`already expired lease rejects direct ${status} write and preserves result`, async () => {
    const f = await fixture({ leaseMs: -1000 });
    await assert.rejects(using('service_role', c => directWrite(c, f, status)), { code: 'P0L01' });
    await assertUnchanged(f);
  });
}

for (const status of [...TERMINAL, 'queued']) {
  test(`independent ${status} writer blocked past lease expiry cannot publish or retry`, { timeout: 15_000 }, async () => {
    const blocker = await connect();
    const writer = await connect();
    let pending;
    let inTransaction = false;
    try {
      const f = await fixture({ leaseMs: 2000 });
      const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      assert.notEqual(blockerPid, writerPid, 'Must exercise two independent PostgreSQL sessions');
      await blocker.query('BEGIN');
      inTransaction = true;
      await blocker.query(`SELECT id FROM ${JOBS} WHERE id=$1 FOR UPDATE`, [f.id]);
      assert.equal((await admin.query('SELECT clock_timestamp()<$1::timestamptz AS live', [f.job.lease_token])).rows[0].live, true);
      // Capture rejection immediately to avoid an unhandled rejection while waiting.
      pending = fencedWrite(writer, f, { status, errorCode: status === 'queued' ? 'ORDINARY_RETRY' : null })
        .then(value => ({ value }), error => ({ error }));
      await waitUntilBlocked(writerPid, blockerPid);
      await admin.query('SELECT pg_sleep(greatest(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.10)', [f.job.lease_token]);
      assert.equal((await admin.query('SELECT clock_timestamp()>$1::timestamptz AS expired', [f.job.lease_token])).rows[0].expired, true);
      await blocker.query('COMMIT');
      inTransaction = false;
      const result = await pending;
      assert.equal(result.error?.code, 'P0L01', 'The pre-lock client/statement time must not let an expired lease commit');
      await assertUnchanged(f);
    } finally {
      if (inTransaction) await blocker.query('ROLLBACK');
      if (pending) await pending;
      await Promise.all([close(blocker), close(writer)]);
    }
  });
}

for (const [name, expected] of [
  ['workspace', f => ({ workspace_id: `${f.workspaceId}-other` })],
  ['job ID', f => ({ id: `${f.id}-other` })],
  ['worker', () => ({ worker_id: 'objective-worker-stale' })],
  ['attempt', f => ({ attempts: f.job.attempts + 1 })],
  ['exact lease', f => ({ lease_token: new Date(new Date(f.job.lease_token).getTime() + 1).toISOString() })],
  ['client expiry', f => ({ clientNow: new Date(new Date(f.job.lease_token).getTime() + 1).toISOString() })],
]) {
  test(`store ${name} fence affects zero rows and leaves result unchanged`, async () => {
    const f = await fixture();
    assert.equal((await using('service_role', c => fencedWrite(c, f, { expected: expected(f) }))).rowCount, 0);
    await assertUnchanged(f);
  });
}
for (const config of [{ type: 'agent_command' }, { status: 'queued' }, { status: 'succeeded' }]) {
  test(`store exact type/running fence excludes ${JSON.stringify(config)}`, async () => {
    const f = await fixture(config);
    assert.equal((await using('service_role', c => fencedWrite(c, f))).rowCount, 0);
    await assertUnchanged(f);
  });
}

test('current two-step expired recovery preserves report, claims new attempt, and fences old owner', async () => {
  const f = await fixture({ leaseMs: -1000 });
  // A test-only observer records actual intermediate versions from the unchanged
  // production claim function; no replacement/reimplementation of that RPC.
  await admin.query(`CREATE TABLE public.objective_test_transitions(step integer GENERATED ALWAYS AS IDENTITY,status text,worker_id text,lease_until timestamptz,
    attempts integer,result jsonb,error_code text,completed_at timestamptz,available_at timestamptz,updated_at timestamptz,transaction_time timestamptz);
    CREATE FUNCTION public.objective_test_observe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO public.objective_test_transitions VALUES(DEFAULT,NEW.status,NEW.worker_id,NEW.lease_until,NEW.attempts,NEW.result,
        NEW.error_code,NEW.completed_at,NEW.available_at,NEW.updated_at,now()); RETURN NEW; END $$;
    CREATE TRIGGER objective_test_observer AFTER UPDATE ON ${JOBS} FOR EACH ROW EXECUTE FUNCTION public.objective_test_observe();
    GRANT INSERT ON public.objective_test_transitions TO service_role;`);
  try {
    const rows = (await using('service_role', c => claim(c))).rows;
    const claimed = rows.find(row => row.id === f.id);
    assert.ok(claimed, 'Unchanged claim RPC must recover and claim the expired objective job');
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.worker_id, 'objective-worker-new');
    assert.equal(claimed.attempts, f.job.attempts + 1);
    assert.deepEqual(claimed.result, f.job.result);
    const transitions = (await admin.query('SELECT * FROM public.objective_test_transitions ORDER BY step')).rows;
    assert.equal(transitions.length, 2);
    const recovered = transitions[0];
    assert.equal(recovered.status, 'queued');
    for (const column of ['worker_id', 'lease_until', 'completed_at']) assert.equal(recovered[column], null);
    assert.equal(recovered.error_code, 'WORKER_LEASE_EXPIRED');
    assert.equal(recovered.attempts, f.job.attempts);
    assert.deepEqual(recovered.result, f.job.result);
    assert.deepEqual(recovered.available_at, recovered.transaction_time);
    assert.deepEqual(recovered.updated_at, recovered.transaction_time);
    assert.equal(transitions[1].status, 'running');
    const newJob = await readJob(f.id);
    assert.equal((await using('service_role', c => fencedWrite(c, f))).rowCount, 0);
    await assertUnchanged(f, newJob);
    assert.equal((await using('service_role', c => fencedWrite(c, { ...f, job: newJob }))).rowCount, 1);
  } finally {
    await admin.query(`DROP TRIGGER objective_test_observer ON ${JOBS}; DROP FUNCTION public.objective_test_observe(); DROP TABLE public.objective_test_transitions;`);
  }
});

test('fresh queued objective jobs remain claimable through the existing RPC', async () => {
  const f = await fixture({ status: 'queued' });
  const job = (await using('service_role', c => claim(c))).rows.find(row => row.id === f.id);
  assert.ok(job);
  assert.equal(job.status, 'running');
  assert.equal(job.attempts, 1);
  assert.equal(job.worker_id, 'objective-worker-new');
});

test('repeated real objective lease expiries stop at max_attempts and never reclaim the terminal job', { timeout: 90_000 }, async () => {
  const f = await fixture({ leaseMs: -1000, attempts: 1, maxAttempts: 3 });
  let lastOwner = f.job;
  for (const attempt of [2, 3]) {
    const returned = await using('service_role', c => claim(c, `objective-repeated-worker-${attempt}`, 30));
    assert.equal(returned.rows.length, 1);
    assert.equal(returned.rows[0].id, f.id);
    lastOwner = await readJob(f.id);
    assert.equal(lastOwner.status, 'running');
    assert.equal(lastOwner.attempts, attempt);
    assert.deepEqual(lastOwner.result, f.job.result);
    await waitForActualLeaseExpiry(lastOwner);
  }
  assert.deepEqual((await using('service_role', c => claim(c))).rows, []);
  const exhausted = await readJob(f.id);
  assertExhausted(exhausted, lastOwner);
  assert.equal(exhausted.attempts, exhausted.max_attempts);
  assert.deepEqual((await using('service_role', c => claim(c))).rows, [], 'Exhausted objective must never be automatically requeued');
  await assertUnchanged(f, exhausted);
});

test('mixed reclaim batch dead-letters exhausted and over-limit objectives without rolling back other claims', async () => {
  const exhausted = await fixture({ leaseMs: -1000, attempts: 3, maxAttempts: 3 });
  const overLimit = await fixture({ leaseMs: -1000, attempts: 7, maxAttempts: 3 });
  const recoverable = await fixture({ leaseMs: -1000, attempts: 1, maxAttempts: 3 });
  const queued = await fixture({ status: 'queued' });
  const legacy = await fixture({ type: 'agent_command', leaseMs: -1000, attempts: 7, maxAttempts: 3 });
  let transactionTime;
  let observedTime;
  const returned = await using('service_role', async c => {
    await c.query('BEGIN');
    try {
      transactionTime = (await c.query('SELECT transaction_timestamp() AS time')).rows[0].time;
      await c.query('SELECT pg_sleep(0.025)');
      const result = await claim(c);
      observedTime = (await c.query('SELECT clock_timestamp() AS time')).rows[0].time;
      await c.query('COMMIT');
      return result;
    } catch (error) { await c.query('ROLLBACK'); throw error; }
  });
  assert.deepEqual(returned.rows.map(row => row.id).sort(), [recoverable.id, queued.id, legacy.id].sort());
  for (const f of [exhausted, overLimit]) {
    const job = await readJob(f.id);
    assertExhausted(job, f.job);
    assert.ok(job.completed_at.getTime() > transactionTime.getTime(), 'Completion must use fresh clock time, not transaction start');
    assert.ok(job.completed_at.getTime() <= observedTime.getTime());
  }
  assert.equal((await readJob(recoverable.id)).attempts, 2);
  assert.equal((await readJob(queued.id)).attempts, 1);
  assert.equal((await readJob(legacy.id)).attempts, 8, 'Legacy automatic recovery must retain its previous behavior');
});

test('attempt exhaustion does not permit forged recovery, report erasure, or identity changes', async () => {
  for (const attempts of [3, 7]) {
    const f = await fixture({ leaseMs: -1000, attempts, maxAttempts: 3 });
    const base = { status: "'queued'", worker_id: 'NULL', lease_until: 'NULL', completed_at: 'NULL',
      error_code: "'WORKER_LEASE_EXPIRED'", available_at: 'now()', updated_at: 'now()' };
    for (const extra of [{ result: "'{}'::jsonb" }, { attempts: '0' }, { payload: "'{}'::jsonb" },
      { max_attempts: 'max_attempts+1' }, { completed_at: 'clock_timestamp()' }, { status: "'dead_letter'" },
      { error_code: "'OBJECTIVE_LEASE_ATTEMPTS_EXHAUSTED'" }, { available_at: "now()+interval '1 second'" },
      { worker_id: "'objective-forged-worker'" }, { lease_until: 'lease_until' }]) {
      const set = Object.entries({ ...base, ...extra }).map(([key, value]) => `${key}=${value}`).join(',');
      await assert.rejects(using('service_role', c => c.query(`UPDATE ${JOBS} SET ${set} WHERE id=$1`, [f.id])),
        error => ['P0L01', 'P0L02'].includes(error.code));
      await assertUnchanged(f);
    }
  }
});

test('exhausted terminal report fences stale owners and explicit manual retry starts a fresh attempt', async () => {
  const f = await fixture({ leaseMs: -1000, attempts: 3, maxAttempts: 3 });
  assert.deepEqual((await using('service_role', c => claim(c))).rows, []);
  const terminal = await readJob(f.id);
  assertExhausted(terminal, f.job);
  assert.equal((await using('service_role', c => fencedWrite(c, f))).rowCount, 0);
  await assert.rejects(using('service_role', c => c.query(`UPDATE ${JOBS} SET result='{"staleOverwrite":true}' WHERE id=$1`, [f.id])), { code: 'P0L02' });
  await assertUnchanged(f, terminal);
  const retry = await using('service_role', c => c.query(`UPDATE ${JOBS} SET status='queued',attempts=0,
    worker_id=NULL,lease_until=NULL,completed_at=NULL,error_code=NULL,available_at=now(),updated_at=now() WHERE id=$1 RETURNING *`, [f.id]));
  assert.equal(retry.rowCount, 1);
  assert.equal(retry.rows[0].attempts, 0);
  assert.deepEqual(retry.rows[0].result, terminal.result);
  assert.equal(retry.rows[0].error_code, null);
  assert.equal(retry.rows[0].completed_at, null);
  assert.equal((await using('service_role', c => claim(c))).rows.find(row => row.id === f.id)?.attempts, 1);
  const fresh = await readJob(f.id);
  assert.equal((await using('service_role', c => fencedWrite(c, f))).rowCount, 0);
  await assertUnchanged(f, fresh);
  assert.equal((await using('service_role', c => fencedWrite(c, { ...f, job: fresh }))).rowCount, 1);
});

for (const [column, value] of [['result', "'{}'::jsonb"], ['attempts', 'attempts+1'], ['payload', "'{}'::jsonb"],
  ['error_code', "'SPOOFED_RECOVERY'"], ['available_at', "now()+interval '1 second'"]]) {
  const mutation = `${column}=${value}`;
  test(`expired recovery rejects nonexact recovery shape: ${mutation}`, async () => {
    const f = await fixture({ leaseMs: -1000 });
    const assignments = { status: "'queued'", worker_id: 'NULL', lease_until: 'NULL', error_code: "'WORKER_LEASE_EXPIRED'",
      available_at: 'now()', updated_at: 'now()', [column]: value };
    const set = Object.entries(assignments).map(([key, sql]) => `${key}=${sql}`).join(',');
    await assert.rejects(using('service_role', c => c.query(`UPDATE ${JOBS} SET ${set} WHERE id=$1`, [f.id])),
    error => ['P0L01', 'P0L02'].includes(error.code));
    await assertUnchanged(f);
  });
}

for (const status of TERMINAL) {
  test(`${status} result is immutable and cannot be republished`, async () => {
    const f = await fixture({ status });
    await assert.rejects(using('service_role', c => c.query(`UPDATE ${JOBS} SET result='{"overwritten":true}' WHERE id=$1`, [f.id])), { code: 'P0L02' });
    await assertUnchanged(f);
  });
}
for (const status of ['blocked', 'dead_letter']) {
  test(`${status} permits explicit clean manual retry while preserving terminal report`, async () => {
    const f = await fixture({ status });
    const result = await using('service_role', c => c.query(`UPDATE ${JOBS} SET status='queued',attempts=0,
      worker_id=NULL,lease_until=NULL,completed_at=NULL,error_code=NULL,available_at=now(),updated_at=now() WHERE id=$1 RETURNING *`, [f.id]));
    assert.equal(result.rowCount, 1);
    assert.deepEqual(result.rows[0].result, f.job.result);
    assert.equal(result.rows[0].attempts, 0);
    assert.equal((await using('service_role', c => claim(c))).rows.find(row => row.id === f.id)?.attempts, 1);
  });
}
test('manual retry cannot erase a terminal report or retain stale attempt/completion data', async () => {
  const f = await fixture({ status: 'blocked' });
  const base = { status: "'queued'", attempts: '0', worker_id: 'NULL', lease_until: 'NULL',
    completed_at: 'NULL', error_code: 'NULL', available_at: 'now()', updated_at: 'now()' };
  for (const extra of [{ result: "'{}'::jsonb" }, { attempts: '1' }, { completed_at: 'completed_at' }, { error_code: "'STALE_ERROR'" }]) {
    const set = Object.entries({ ...base, ...extra }).map(([key, value]) => `${key}=${value}`).join(',');
    await assert.rejects(using('service_role', c => c.query(`UPDATE ${JOBS} SET ${set} WHERE id=$1`, [f.id])),
      error => ['P0L02', 'P0L03'].includes(error.code));
    await assertUnchanged(f);
  }
});

test('succeeded jobs cannot use the manual-retry transition', async () => {
  const f = await fixture({ status: 'succeeded' });
  await assert.rejects(using('service_role', c => c.query(`UPDATE ${JOBS} SET status='queued',attempts=0,
    worker_id=NULL,lease_until=NULL,completed_at=NULL,error_code=NULL,available_at=now(),updated_at=now() WHERE id=$1`, [f.id])),
  error => ['P0L02', 'P0L03'].includes(error.code));
  await assertUnchanged(f);
});

for (const type of LEGACY) {
  test(`expired legacy ${type} retains its previous write behavior`, async () => {
    const f = await fixture({ type, leaseMs: -1000 });
    assert.equal((await using('service_role', c => directWrite(c, f, 'succeeded'))).rowCount, 1);
    assert.equal((await readJob(f.id)).status, 'succeeded');
  });
}

for (const role of ['anon', 'authenticated', 'atomic_usage_untrusted']) {
  test(`${role} cannot access jobs, claim RPC, or guard helper`, async () => {
    const f = await fixture();
    await using(role, async c => {
      for (const sql of [`SELECT * FROM ${JOBS}`, `UPDATE ${JOBS} SET result='{}' WHERE id=$1`, `DELETE FROM ${JOBS} WHERE id=$1`,
        `INSERT INTO ${JOBS}(id,workspace_id,type,idempotency_key) VALUES ('denied',$1,'objective_prepare','denied')`]) {
        await assert.rejects(c.query(sql, sql.includes('$1') ? [f.id] : []), { code: '42501' });
      }
      await assert.rejects(claim(c), { code: '42501' });
      await assert.rejects(c.query(`SELECT ${GUARD}`), { code: '42501' });
    });
    await assertUnchanged(f);
  });
}
