/** Real HTTP qualification: createStore -> prefix-only loopback relay ->
 * PostgREST 14.5 -> ephemeral authenticator -> SET LOCAL ROLE -> PostgreSQL 17.6.
 * SQL is used only for synthetic fixture setup, deliberate races, and assertions.
 * No HTTP URL is interpreted as SQL and no HTTP/database error is translated here.
 */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID, createHmac, createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { disposablePostgrestTarget } from './staged-reader-postgrest-guard.mjs';
import { fixtureData, sourceMeasurement, withAction } from './business-outcome-postgres-fixture.mjs';
import { stagedReceiptFixtures } from './staged-reader-postgres-fixture.mjs';
import { createStore } from '../lib/store.mjs';
import { GOVERNED_RECORD_PRODUCER_CONTRACT } from '../lib/governed-record-stage.mjs';
import { selectedProtectedReceiptEvidence } from '../lib/business-outcome-store.mjs';
import { prepareContentReceiptTransaction, commitContentReceiptTransaction } from '../lib/content-execution-receipt-store.mjs';

const { url: baseUrl, mode } = disposablePostgrestTarget(process.env);
assert.equal(Number(process.versions.node.split('.')[0]), 22, 'Lexical JSON.parse requires Node 22');
const binary = process.env.STAGED_READER_POSTGREST_BIN;
const evidenceDir = process.env.STAGED_READER_EVIDENCE_DIR;
assert.ok(binary?.startsWith('/')); assert.ok(evidenceDir?.startsWith('/'));
const { Client } = createRequire(new URL('./atomic-usage/package.json', import.meta.url))('pg');
const exec = promisify(execFile);
const scopeKeys = ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id', 'tenant'];
const actor = { id: 'owner', sessionVersion: 1 };
const contract = 'runvara-content-execution-receipts/v1';
const protectedSignature = 'public.runvara_read_outcome_content_sources(text,text,text,bigint,jsonb,text,boolean)';
const migrations = [
  '20260927113000_runvara_agent_operations.sql', '20260927122500_ai_usage_economics.sql',
  '20261006190318_atomic_provider_usage.sql', '20261006194326_objective_prepare_job_guard.sql',
  '20261007074031_reporting_status_cas.sql', '20261007100823_business_outcome_publication.sql',
  '20261007175355_reviewed_action_outcome_snapshot.sql', '20261008055400_objective_action_outcome_snapshot.sql',
  '20261008144414_protected_content_execution_receipts.sql', '20261008163558_receipt_outcome_consumer.sql',
  '20261009053240_bounded_shopify_order_recovery_rebuilt.sql'
];
const databases = [], gateways = [], traces = [], observations = [], createdSharedRoles = [];
const authRole = 'runvara_pgrst_' + randomUUID().replaceAll('-', '');
const authPassword = randomBytes(24).toString('hex');
const jwtSecret = randomBytes(48).toString('hex');
let base, full, old, ordinary, limited, legacy, roleCreated = false;
let setupPromise, shuttingDown = false;
const assertRunning = () => { assert.ok(!shuttingDown, 'Disposable qualification is shutting down'); };
const ident = value => { assert.match(value, /^[a-z][a-z0-9_]*$/); return '"' + value + '"'; };
const digest = value => createHash('sha256').update(value).digest('hex');
const cleanLog = value => String(value).replaceAll(authPassword, '[ephemeral credential]').replaceAll(jwtSecret, '[ephemeral signing secret]');
const jwt = (role, secret = jwtSecret) => {
  const payload = [ { alg: 'HS256', typ: 'JWT' }, { role, exp: Math.floor(Date.now() / 1000) + 600 } ]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
};
async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const selected = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return selected;
}
async function assertPortClosed(selected) {
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: selected });
    socket.setTimeout(1000);
    socket.once('connect', () => { socket.destroy(); reject(new Error(`Unexpected live local socket ${selected}`)); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Socket cleanup check timed out')); });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
  });
}
async function connect(database) {
  const target = new URL(baseUrl); target.pathname = '/' + database;
  const client = new Client({ connectionString: target.toString(), ssl: false, connectionTimeoutMillis: 5000,
    statement_timeout: 15000, query_timeout: 18000, options: '-c log_min_error_statement=panic', application_name: 'runvara_postgrest_synthetic_fixture' });
  await client.connect(); assert.equal(client.connection.stream.remoteAddress, '127.0.0.1'); return client;
}
async function makeDatabase(label, count) {
  assertRunning();
  const name = 'runvara_pgrst_' + label + '_' + randomUUID().replaceAll('-', '');
  await base.query('CREATE DATABASE ' + ident(name));
  const db = { name, admin: null }; databases.push(db); assertRunning(); db.admin = await connect(name);
  assert.equal((await db.admin.query("SELECT count(*)::int n FROM pg_class WHERE relnamespace='public'::regnamespace")).rows[0].n, 0);
  await db.admin.query('GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role');
  await db.admin.query(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
  await storageProfile(db, label + '-schema-only');
  for (const [index, file] of migrations.slice(0, count).entries()) {
    assertRunning();
    await db.admin.query(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
    if (index === 5) await storageProfile(db, label + '-publication-baseline');
  }
  await storageProfile(db, label + '-migrated');
  // Test-only invoker probe proves real HTTP role switching without widening app ACLs.
  await db.admin.query(`CREATE FUNCTION public.runvara_postgrest_test_identity() RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
    AS $$ SELECT jsonb_build_object('role',current_user,'session',session_user,'claimRole',current_setting('request.jwt.claims',true)::jsonb->>'role') $$;
    REVOKE ALL ON FUNCTION public.runvara_postgrest_test_identity() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.runvara_postgrest_test_identity() TO service_role;`);
  return db;
}
async function storageProfile(db, label) {
  const functions = (await db.admin.query(`SELECT p.oid::regprocedure::text signature,md5(pg_get_functiondef(p.oid)) definition_md5,
    p.proowner::regrole::text owner,p.prosecdef security_definer FROM pg_proc p
    WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'runvara_%' ORDER BY signature`)).rows;
  const tables = (await db.admin.query(`SELECT c.relname,r.rolname,c.relrowsecurity,
    has_table_privilege(r.oid,c.oid,'SELECT') can_select,has_table_privilege(r.oid,c.oid,'INSERT') can_insert,
    has_table_privilege(r.oid,c.oid,'UPDATE') can_update,has_table_privilege(r.oid,c.oid,'DELETE') can_delete
    FROM pg_class c CROSS JOIN pg_roles r WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
    AND r.rolname IN ('anon','authenticated','service_role') ORDER BY c.relname,r.rolname`)).rows;
  await writeFile(`${evidenceDir}/postgrest-profile-${label}.json`, JSON.stringify({ label, functions, tables }, null, 2) + '\n');
}
async function startGateway(db, maxRows, name) {
  assertRunning();
  const backendPort = await port();
  assertRunning();
  const target = new URL(baseUrl); target.pathname = '/' + db.name; target.username = authRole; target.password = authPassword;
  const child = spawn(binary, ['+RTS', '-N2', '-RTS'], { env: {
    PATH: '/usr/bin:/bin', PGRST_DB_URI: target.toString(), PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon',
    PGRST_JWT_SECRET: jwtSecret, PGRST_SERVER_HOST: '127.0.0.1', PGRST_SERVER_PORT: String(backendPort),
    PGRST_DB_POOL: '2', PGRST_DB_POOL_ACQUISITION_TIMEOUT: '3', PGRST_DB_POOL_MAX_LIFETIME: '60',
    PGRST_DB_MAX_ROWS: String(maxRows), PGRST_DB_CHANNEL_ENABLED: 'false', PGRST_LOG_LEVEL: 'error',
    PGRST_DB_PREPARED_STATEMENTS: 'true', PGRST_SERVER_TIMING_ENABLED: 'false'
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  const gateway = { child, backendPort, name, maxRows, relay: null, relayPort: null, log: '', exit: null };
  gateways.push(gateway);
  child.stdout.on('data', data => { gateway.log += data; }); child.stderr.on('data', data => { gateway.log += data; });
  child.once('error', error => { gateway.spawnError = error; });
  child.once('exit', (code, signal) => { gateway.exit = { code, signal }; });
  const deadline = Date.now() + 15000;
  let ready = false;
  while (Date.now() < deadline) {
    assertRunning();
    if (gateway.spawnError) throw gateway.spawnError;
    if (gateway.exit) throw new Error(`PostgREST ${name} exited during readiness: ${cleanLog(gateway.log)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${backendPort}/rpc/runvara_postgrest_test_identity`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + jwt('service_role'), 'Content-Type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(1000), redirect: 'error' });
      if (response.ok) { assert.deepEqual(await response.json(), { role: 'service_role', session: authRole, claimRole: 'service_role' }); ready = true; break; }
      await response.arrayBuffer();
    } catch (error) { if (error instanceof assert.AssertionError) throw error; }
    await delay(100);
  }
  assert.ok(ready, `Bounded PostgREST readiness failed: ${cleanLog(gateway.log)}`);
  assertRunning();
  gateway.ready = true;
  // This relay never parses a URL, query string, JSON document or error. The sole
  // transformation is removing the exact Supabase prefix from the request target.
  const relay = http.createServer((request, response) => {
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) || !request.url.startsWith('/rest/v1/')) {
      response.writeHead(400); response.end(); return;
    }
    const upstream = http.request({ hostname: '127.0.0.1', port: backendPort, method: request.method,
      path: '/' + request.url.slice('/rest/v1/'.length), headers: request.rawHeaders, timeout: 10000 }, reply => {
      response.writeHead(reply.statusCode, reply.statusMessage, reply.rawHeaders); reply.pipe(response);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('Local gateway timeout')));
    upstream.on('error', () => response.destroy()); request.on('error', () => upstream.destroy());
    request.pipe(upstream);
  });
  relay.requestTimeout = 12000; relay.headersTimeout = 5000; relay.keepAliveTimeout = 100;
  gateway.relay = relay;
  await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(0, '127.0.0.1', resolve); });
  gateway.relayPort = relay.address().port; gateway.url = `http://127.0.0.1:${gateway.relayPort}`;
  assertRunning();
  return gateway;
}
function store(gateway = ordinary, { open = false, briefCompaction = false, role = 'service_role', token = jwt(role), beforeFetch } = {}) {
  return createStore({ SUPABASE_URL: gateway.url, SUPABASE_SERVICE_ROLE_KEY: token,
    CONTENT_EXECUTION_RECEIPT_CONTRACT: contract, ...(open ? { GOVERNED_RECORD_PRODUCER_CONTRACT } : {}),
    ...(briefCompaction ? { BRIEF_HISTORY_COMPACTION_CONTRACT: 'runvara-brief-history/v1' } : {}) }, {
    fetchImpl: async (input, options) => {
      assertRunning();
      const target = new URL(input); assert.equal(target.origin, gateway.url); assert.ok(target.pathname.startsWith('/rest/v1/'));
      await beforeFetch?.(target, options);
      const response = await fetch(input, { ...options, signal: AbortSignal.timeout(10000), redirect: 'error' });
      const text = await response.clone().text();
      const trace = { gateway: gateway.name, path: target.pathname + target.search, method: options.method ?? 'GET',
        status: response.status, contentRange: response.headers.get('content-range'), prefer: new Headers(options.headers).get('prefer'),
        requestBytes: Buffer.byteLength(options.body ?? ''), responseBytes: Buffer.byteLength(text), responseSha256: digest(text) };
      Object.defineProperties(trace, { body: { value: options.body }, text: { value: text }, json: { value: text ? JSON.parse(text) : null } });
      traces.push(trace); return response;
    }
  });
}
function inputFor(f, overrides = {}) {
  return { publicationId: randomUUID(), action: 'publish', experimentId: f.experimentId,
    expectedWorkspaceRevision: f.state._revision, expectedMeasurementRevision: f.source.revision,
    expectedMeasurementDigest: f.source.digest, expectedHeadVersionId: null, expectedHeadDigest: null, withdrawalReason: null, ...overrides };
}
async function seed(db = full, { linked = false, workspaceId } = {}) {
  assertRunning();
  let f = fixtureData();
  if (workspaceId) { f.workspaceId = workspaceId; f.state.workspace.id = workspaceId; f.source = sourceMeasurement(workspaceId, f.experimentId); f.state.revenueEngine.experiments[0].outcomeMeasurement = f.source; }
  if (linked) f = withAction(f);
  await db.admin.query('INSERT INTO public.workspaces(id,name,slug) VALUES($1,$1,$1)', [f.workspaceId]);
  await db.admin.query('INSERT INTO public.saas_workspace_state(workspace_id,state) VALUES($1,$2)', [f.workspaceId, f.state]);
  return f;
}
const stateFor = async f => (await full.admin.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1', [f.workspaceId])).rows[0].state;
const setState = (f, state) => full.admin.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1', [f.workspaceId, state]);
const rowsFor = async f => (await full.admin.query('SELECT count(*)::int n FROM public.runvara_business_outcome_versions WHERE workspace_id=$1', [f.workspaceId])).rows[0].n;
const protectedBody = f => ({ p_workspace_id: f.workspaceId, p_experiment_id: f.experimentId, p_actor_id: actor.id,
  p_actor_session_version: actor.sessionVersion, p_receipt_selector: null, p_after_attempt_id: null, p_resolve_saved_source: true });

before(() => {
  setupPromise = setup();
  return setupPromise;
}, { timeout: 60000 });
async function setup() {
  assertRunning();
  await mkdir(evidenceDir, { recursive: true });
  assert.equal(digest(await readFile(binary)), '39ce04b0597c6b3c3eb4c5f34fe6ab590a2d0172616eeaccf1e4c659b822295a', 'Expected verified official Linux x64 PostgREST 14.5 binary');
  const version = (await exec(binary, ['--version'], { env: { PATH: '/usr/bin:/bin' }, timeout: 3000 })).stdout.trim();
  assert.equal(version, 'PostgREST 14.5');
  base = await connect('runvara_outcome_test');
  assertRunning();
  const info = (await base.query("SELECT current_database() db,current_user role,current_setting('server_version_num')::int version,current_setting('listen_addresses') listen")).rows[0];
  assert.equal(info.db, 'runvara_outcome_test'); assert.equal(info.role, 'postgres'); assert.equal(info.version, 170006);
  assert.equal(info.listen, mode === 'local' ? '127.0.0.1' : '*');
  for (const name of ['anon', 'authenticated', 'service_role']) {
    assertRunning();
    if (!(await base.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [name])).rowCount) {
      await base.query('CREATE ROLE ' + ident(name) + ' NOLOGIN' + (name === 'service_role' ? ' BYPASSRLS' : ''));
      createdSharedRoles.push(name);
    }
  }
  const roles = (await base.query("SELECT rolname,rolsuper,rolcanlogin FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')")).rows;
  assert.equal(roles.length, 3); for (const role of roles) { assert.equal(role.rolsuper, false); assert.equal(role.rolcanlogin, false); }
  assertRunning();
  await base.query(`CREATE ROLE ${ident(authRole)} NOINHERIT LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 6 PASSWORD '${authPassword}'`); roleCreated = true;
  await base.query(`GRANT anon,authenticated,service_role TO ${ident(authRole)}; ALTER ROLE ${ident(authRole)} SET statement_timeout='8s'`);
  full = await makeDatabase('full', migrations.length); old = await makeDatabase('old', 6);
  ordinary = await startGateway(full, 1000, 'full'); limited = await startGateway(full, 1, 'lower-max-rows'); legacy = await startGateway(old, 1000, 'old-schema');
  observations.push({ versions: { node: process.versions.node, postgres: info.version, postgrest: version },
    syntheticLocalOnly: true, actualPostgrest: true, externalProviderCalls: 0, maxRows: [1000, 1], databases: databases.map(db => db.name),
    scope: 'Real createStore HTTP grammar, roles, errors, projections, cardinality and receipt transport; cloned response capture does not qualify streaming cancellation or production topology.' });
}

let cleanupPromise;
const watchdog = setTimeout(() => process.kill(process.pid, 'SIGTERM'), 180000);
watchdog.unref();
async function cleanupAll() {
  if (cleanupPromise) return cleanupPromise;
  shuttingDown = true;
  cleanupPromise = performCleanup();
  return cleanupPromise;
}
async function performCleanup() {
  clearTimeout(watchdog);
  // Stop setup at its next await boundary before snapshotting resources. Every
  // successfully created role/database/process is registered before that check.
  try { await setupPromise; } catch { /* The resource records still require cleanup. */ }
  const errors = [], cleanup = { gateways: [], databases: [], authenticatorRemoved: false };
  for (const gateway of gateways.toReversed()) {
    let relayClosed = false, processClosed = false, backendClosed = false;
    try {
      if (gateway.relay) { gateway.relay.closeAllConnections(); await new Promise(resolve => gateway.relay.close(resolve)); await assertPortClosed(gateway.relayPort); }
      relayClosed = true;
    } catch (error) { errors.push(error); }
    try {
      if (!gateway.exit && !gateway.spawnError) {
        gateway.child.kill('SIGTERM'); const deadline = Date.now() + 5000;
        while (!gateway.exit && Date.now() < deadline) await delay(50);
        if (!gateway.exit) { gateway.child.kill('SIGKILL'); const end = Date.now() + 2000; while (!gateway.exit && Date.now() < end) await delay(50); }
        assert.ok(gateway.exit, 'PostgREST process did not terminate');
      }
      if (gateway.child.pid) assert.throws(() => process.kill(gateway.child.pid, 0), { code: 'ESRCH' });
      processClosed = true;
    } catch (error) { errors.push(error); }
    try { await assertPortClosed(gateway.backendPort); backendClosed = true; } catch (error) { errors.push(error); }
    try { await writeFile(`${evidenceDir}/postgrest-${gateway.name}.log`, cleanLog(gateway.log)); } catch (error) { errors.push(error); }
    cleanup.gateways.push({ name: gateway.name, pid: gateway.child.pid, exit: gateway.exit, processClosed, socketsClosed: relayClosed && backendClosed });
  }
  for (const db of databases.toReversed()) {
    try {
      await db.admin?.end();
      assert.equal((await base.query('SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1', [db.name])).rows[0].n, 0);
      await base.query('DROP DATABASE ' + ident(db.name));
      assert.equal((await base.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1', [db.name])).rows[0].n, 0);
      cleanup.databases.push({ name: db.name, dropped: true, sessionsClosed: true });
    } catch (error) { errors.push(error); }
  }
  if (roleCreated) try {
    await base.query('DROP ROLE ' + ident(authRole));
    assert.equal((await base.query('SELECT count(*)::int n FROM pg_roles WHERE rolname=$1', [authRole])).rows[0].n, 0); cleanup.authenticatorRemoved = true;
  } catch (error) { errors.push(error); }
  for (const name of createdSharedRoles.toReversed()) try {
    await base.query('DROP ROLE ' + ident(name));
    assert.equal((await base.query('SELECT count(*)::int n FROM pg_roles WHERE rolname=$1', [name])).rows[0].n, 0);
  } catch (error) { errors.push(error); }
  await base?.end();
  await writeFile(`${evidenceDir}/postgrest-http-traces.json`, JSON.stringify(traces, null, 2) + '\n');
  await writeFile(`${evidenceDir}/postgrest-proof.json`, JSON.stringify({ observations, cleanup, errors: errors.map(error => error.message) }, null, 2) + '\n');
  console.log('POSTGREST_QUALIFICATION=' + JSON.stringify({ actualPostgrest: gateways.some(gateway => gateway.ready), postgres: '17.6', postgrest: '14.5', externalProviderCalls: 0, httpRequests: traces.length, cleanup }));
  assert.deepEqual(errors.map(error => error.message), [], 'All processes, sockets, databases and ephemeral role must be removed');
}
after(cleanupAll, { timeout: 30000 });
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => {
  cleanupAll().then(() => process.exit(code), error => { console.error('Qualification cleanup failed: ' + error.message); process.exit(99); });
});
process.once('exit', () => { for (const gateway of gateways) if (!gateway.exit) gateway.child.kill('SIGKILL'); });

test('verified brief history uses existing schema, real insert-ignore and JSONB-safe recovery with compaction closed', async () => {
  const f = await seed(old);
  const brief = { id: 'recorded-brief-' + randomUUID(), generatedAt: '2020-01-02T12:00:00.000Z',
    summary: 'Historical synthetic snapshot; totals remain unknown.', logic: 'deterministic-v2',
    sourceSignature: 'synthetic-recorded-source', calculationVersion: 'synthetic-history/v1',
    today: { unknown: null, nested: { z: 1e-7, a: 'Unicode 雪', values: [false, 0, '0', null] },
      records: Array.from({ length: 40 }, (_, n) => ({ id: n, detail: 'Recorded synthetic source; no provider calls. '.repeat(4) })) } };
  f.state.dailyBriefs = [{ id: 'latest-' + randomUUID(), generatedAt: new Date().toISOString(), summary: 'Current brief' }, brief];
  await old.admin.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1', [f.workspaceId, f.state]);
  const producer = store(legacy, { briefCompaction: true });
  const before = traces.length;
  await producer.save(f.workspaceId, await producer.get(f.workspaceId));
  const reader = store(legacy), saved = await reader.get(f.workspaceId), pointer = saved.dailyBriefs[1].archive;
  assert.equal(pointer.schema, 'runvara-brief-history/v1');
  assert.notEqual(pointer.archiveId, brief.id);
  assert.deepEqual(await reader.getBrief(f.workspaceId, brief.id, { state: saved }), brief);
  const insert = traces.slice(before).find(call => call.path.startsWith('/rest/v1/operations_briefs?') && call.prefer?.includes('ignore-duplicates'));
  assert.ok(insert, 'The real gateway must receive insert-ignore');
  assert.equal(insert.status, 201);
  const archiveRead = traces.at(-1);
  assert.match(archiveRead.path, /select=id,workspace_id,metrics/);
  assert.deepEqual(Object.keys(archiveRead.json[0]).sort(), ['id', 'metrics', 'workspace_id']);

  const conflicting = { id: pointer.archiveId, workspace_id: f.workspaceId, summary: 'Ignored collision',
    metrics: { ...brief, summary: 'Ignored collision' }, logic: brief.logic, created_at: brief.generatedAt };
  await reader.upsert('operations_briefs', [conflicting], 'id', { headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' } },
    { workspaceId: f.workspaceId, operation: 'archive_write' });
  assert.deepEqual(await reader.getBrief(f.workspaceId, brief.id, { state: saved }), brief);
  // A stale pre-format reporting writer uses the original ID. It cannot change
  // the separately keyed snapshot selected by the retained v1 reference.
  await reader.upsert('operations_briefs', [{ ...conflicting, id: brief.id }], 'id', {},
    { workspaceId: f.workspaceId, operation: 'reporting_write' });
  assert.deepEqual(await reader.getBrief(f.workspaceId, brief.id, { state: saved }), brief);
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(store(legacy, { role }).request('operations_briefs?select=id&limit=1'), { databaseCode: '42501' });
  }
  await old.admin.query("UPDATE public.operations_briefs SET metrics=jsonb_set(metrics,'{summary}',to_jsonb('corrupt fixture'::text)) WHERE id=$1", [pointer.archiveId]);
  await assert.rejects(reader.getBrief(f.workspaceId, brief.id, { state: saved }), error => error.status === 503);
  await old.admin.query('DELETE FROM public.operations_briefs WHERE id=$1', [pointer.archiveId]);
  await assert.rejects(reader.getBrief(f.workspaceId, brief.id, { state: saved }), error => error.status === 503);
  observations.push({ briefHistory: { baselineSchemaOnly: true, actualInsertIgnore: true, jsonbKeyOrderSafe: true,
    closedProducerReader: true, staleOriginalIdMirrorIsolated: true, privilegedCorruptionDetected: true,
    missingArchiveRejected: true, addedSchemaOrGrants: false, requests: traces.length - before } });
});

test('genuine authenticator JWT role switching and anonymous/authenticated/invalid-token denials', async () => {
  const role = (await base.query('SELECT rolinherit,rolsuper,rolcanlogin,rolbypassrls FROM pg_roles WHERE rolname=$1', [authRole])).rows[0];
  assert.deepEqual(role, { rolinherit: false, rolsuper: false, rolcanlogin: true, rolbypassrls: false });
  assert.deepEqual(await store().request('rpc/runvara_postgrest_test_identity', { method: 'POST', body: '{}' }),
    { role: 'service_role', session: authRole, claimRole: 'service_role' });
  const f = await seed();
  for (const role of ['anon', 'authenticated']) {
    const reader = store(ordinary, { role });
    await assert.rejects(reader.request('rpc/runvara_read_outcome_content_sources', { method: 'POST', body: JSON.stringify(protectedBody(f)) }),
      error => { assert.equal(error.databaseCode, '42501'); assert.equal(error.httpStatus, role === 'anon' ? 401 : 403); return true; });
    await assert.rejects(reader.request('saas_workspace_state?select=workspace_id&limit=1'), { databaseCode: '42501' });
  }
  await assert.rejects(store(ordinary, { token: jwt('service_role', randomBytes(48).toString('hex')) }).request('rpc/runvara_postgrest_test_identity', { method: 'POST', body: '{}' }),
    { httpStatus: 401, databaseCode: 'PGRST301' });
  const response = await fetch(ordinary.url + '/rest/v1/rpc/runvara_postgrest_test_identity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000), redirect: 'error' });
  assert.equal(response.status, 401); assert.equal((await response.json()).code, '42501');
  const sessions = (await base.query('SELECT DISTINCT usename,application_name FROM pg_stat_activity WHERE datname=ANY($1::text[]) AND usename=$2', [databases.map(db => db.name), authRole])).rows;
  assert.ok(sessions.length); assert.ok(sessions.every(row => row.usename === authRole && row.application_name === 'PostgREST 14.5'));
  observations.push({ authentication: role, jwtRoleSwitch: true, deniedRoles: ['anon', 'authenticated'], invalidJwt: 'PGRST301', sessions });
});

test('closed replay uses real JSON-arrow scope filters including reserved workspace operands', async () => {
  for (const workspaceId of ['scope-(comma,colon:dot.)-quote"-slash\\-percent%-amp&-plus+-snow雪-' + randomUUID(), 'scope-simple-' + randomUUID()]) {
    const f = await seed(full, { workspaceId }), input = inputFor(f);
    await store(ordinary, { open: true }).publishBusinessOutcome(f.workspaceId, actor, input);
    const saved = await stateFor(f);
    for (const key of scopeKeys) for (const marker of [undefined, null, true, 3, [], {}, 'foreign', f.workspaceId, ...(key === 'tenant' ? [{ id: f.workspaceId }, { id: 'foreign' }] : [])]) {
      const next = structuredClone(saved); if (marker !== undefined) next[key] = marker; await setState(f, next);
      const start = traces.length, expected = marker === undefined || marker === f.workspaceId || key === 'tenant' && marker?.id === f.workspaceId;
      if (expected) assert.equal((await store().publishBusinessOutcome(f.workspaceId, actor, input)).replayed, true);
      else await assert.rejects(store().publishBusinessOutcome(f.workspaceId, actor, input), { code: 'OUTCOME_OWNER_SESSION_CHANGED' });
      const calls = traces.slice(start); assert.ok(calls.every(call => call.method === 'GET'));
      const identity = calls.at(-1); assert.equal(identity.status, 200); assert.ok(identity.path.includes('users_json:state-%3E%3Eusers') || decodeURIComponent(identity.path).includes('users_json:state->>users'));
      const body = identity.json; assert.equal(body.length, expected ? 1 : 0);
      if (expected) { assert.equal(typeof body[0].users_json, 'string'); assert.equal(body[0].workspace_id, workspaceId); assert.equal(Object.hasOwn(body[0], 'state'), false); }
    }
    await setState(f, saved); assert.equal(await rowsFor(f), 1);
  }
  observations.push({ scopeFilters: 'actual PostgREST JSON arrows, absent versus JSON null, all five root keys, quoted reserved operands', mutationsDuringClosedReplay: 0 });
});

test('closed replay preserves lexical session text and rejects stale, duplicate and foreign authority', async () => {
  const f = await seed(), input = inputFor(f); await store(ordinary, { open: true }).publishBusinessOutcome(f.workspaceId, actor, input);
  const saved = await stateFor(f), lexical = [];
  for (const [literal, expected] of [['1', true], ['1.000', false], ['1e0', true], ['10e-1', false], ['1.0000000000000000000000000000001', false], ['0.9999999999999999999999999999999', false], ['9007199254740991.00000000000001', false], ['"1"', false], ['2', false]]) {
    await full.admin.query("UPDATE public.saas_workspace_state SET state=jsonb_set(state,'{users,0,sessionVersion}',$2::jsonb) WHERE workspace_id=$1", [f.workspaceId, literal]);
    if (expected) assert.equal((await store().publishBusinessOutcome(f.workspaceId, actor, input)).replayed, true);
    else await assert.rejects(store().publishBusinessOutcome(f.workspaceId, actor, input), { code: 'OUTCOME_OWNER_SESSION_CHANGED' });
    const users = traces.at(-1).json[0].users_json;
    const stored = (await full.admin.query("SELECT state->>'users' users FROM public.saas_workspace_state WHERE workspace_id=$1", [f.workspaceId])).rows[0].users;
    assert.equal(users, stored); lexical.push({ literal, transmittedUsers: users, accepted: expected });
  }
  for (const mutate of [state => state.users[0].role = 'member', state => state.users[0].active = false,
    state => state.users[0].tenantId = 'foreign', state => state.users.push({ ...state.users[0] }), state => state.workspace.id = 'foreign']) {
    const next = structuredClone(saved); mutate(next); await setState(f, next);
    await assert.rejects(store().publishBusinessOutcome(f.workspaceId, actor, input), { code: 'OUTCOME_OWNER_SESSION_CHANGED' });
  }
  await setState(f, saved);
  await assert.rejects(store().publishBusinessOutcome(f.workspaceId, actor, { ...input, expectedWorkspaceRevision: randomUUID() }), { code: 'OUTCOME_PUBLICATION_CONFLICT' });
  const defaults = structuredClone(saved); delete defaults.users[0].sessionVersion; delete defaults.users[0].active;
  await setState(f, defaults); assert.equal((await store().publishBusinessOutcome(f.workspaceId, actor, input)).replayed, true);
  const max = await seed(), maxActor = { ...actor, sessionVersion: Number.MAX_SAFE_INTEGER };
  max.state.users[0].sessionVersion = maxActor.sessionVersion; await setState(max, max.state); const maxInput = inputFor(max);
  await store(ordinary, { open: true }).publishBusinessOutcome(max.workspaceId, maxActor, maxInput);
  assert.equal((await store().publishBusinessOutcome(max.workspaceId, maxActor, maxInput)).replayed, true);
  await full.admin.query("UPDATE public.saas_workspace_state SET state=jsonb_set(state,'{users,0,sessionVersion}','9007199254740991.00000000000001'::jsonb) WHERE workspace_id=$1", [max.workspaceId]);
  await assert.rejects(store().publishBusinessOutcome(max.workspaceId, maxActor, maxInput), { code: 'OUTCOME_OWNER_SESSION_CHANGED' });
  assert.equal(await rowsFor(f), 1); observations.push({ lexicalSessions: lexical });
});

test('closed withdrawal fences reject stale inputs and authoritative races over real RPC responses', async () => {
  const f = await seed(full, { linked: true }), input = inputFor(f), first = await store(ordinary, { open: true }).publishBusinessOutcome(f.workspaceId, actor, input);
  f.state = await stateFor(f);
  const withdrawal = inputFor(f, { action: 'withdraw', expectedHeadVersionId: first.publication.head.versionId, expectedHeadDigest: first.publication.head.digest, withdrawalReason: 'evidence_retracted' });
  for (const [patch, code] of [[{ expectedHeadDigest: '0'.repeat(64) }, 'OUTCOME_HEAD_CONFLICT'], [{ expectedMeasurementDigest: '0'.repeat(64) }, 'OUTCOME_MEASUREMENT_CONFLICT'], [{ expectedWorkspaceRevision: randomUUID() }, 'OUTCOME_WORKSPACE_CONFLICT']]) {
    const start = traces.length; await assert.rejects(store().publishBusinessOutcome(f.workspaceId, actor, { ...withdrawal, ...patch }), { code });
    assert.ok(traces.slice(start).every(call => call.method === 'GET'));
  }
  for (const race of ['revision', 'session', 'tenant']) {
    await setState(f, f.state); let raced = 0;
    const writer = store(ordinary, { beforeFetch: async target => {
      if (target.pathname === '/rest/v1/rpc/runvara_publish_business_outcome') {
        raced++; const next = structuredClone(f.state);
        if (race === 'revision') next._revision = randomUUID(); else if (race === 'session') next.users[0].sessionVersion = 2; else next.tenant = 'foreign';
        await setState(f, next);
      }
    } });
    await assert.rejects(writer.publishBusinessOutcome(f.workspaceId, actor, withdrawal), { code: race === 'revision' ? 'OUTCOME_WORKSPACE_CONFLICT' : race === 'session' ? 'OUTCOME_OWNER_SESSION_CHANGED' : 'OUTCOME_SOURCE_INVALID' });
    assert.equal(raced, 1); assert.equal(traces.at(-1).status, 500); assert.match(traces.at(-1).json.code, /^P0O/); assert.equal(await rowsFor(f), 1);
  }
  await setState(f, f.state);
  assert.equal((await store().publishBusinessOutcome(f.workspaceId, actor, withdrawal)).publication.head.status, 'withdrawn');
  assert.equal((await store().publishBusinessOutcome(f.workspaceId, actor, input)).isCurrent, false);
});

test('selected dispatch context uses real indexed JSON projections and exact revision fencing', async () => {
  const f = await seed(full, { linked: true });
  f.state.connectionSettings = { shopify: { permissionMode: 'approval_required' } };
  f.state.connections[0].metadata.grantedScopes = ['write_products'];
  f.state.connectionWrites.unshift({ id: 'unselected', sentinel: 'not projected' });
  f.state.connections.unshift({ id: 'unselected' }); f.state.approvals.unshift({ id: 'unselected' }); f.state.users.unshift({ id: 'unselected' });
  await setState(f, f.state);
  const request = { revision: f.state._revision, provider: 'shopify', writeId: f.write.id, connectionId: f.connection.id,
    actorId: 'owner', approverId: 'owner', approvalId: f.approval.id, writeIndex: 1, connectionIndex: 1, actorIndex: 1, approverIndex: 1, approvalIndex: 1 };
  const reader = store(), projected = await reader.getConnectionWriteContext(f.workspaceId, request);
  assert.equal(projected.connectionWrites.length, 1); assert.deepEqual(projected.connectionWrites[0], f.write);
  const trace = traces.at(-1), select = new URL(trace.path, ordinary.url).searchParams.get('select');
  for (const fragment of ['actor:state->users->1', 'connection:state->connections->1', 'approval:state->approvals->1', 'write:state->connectionWrites->1']) assert.ok(select.includes(fragment));
  assert.ok(!trace.text.includes('secretNeverReturned')); assert.ok(!trace.text.includes('not projected')); assert.ok(trace.responseBytes < 32768);
  await assert.rejects(reader.getConnectionWriteContext(f.workspaceId, { ...request, revision: randomUUID() }), { code: 'WRITE_CONTEXT_UNAVAILABLE' });
  assert.deepEqual(traces.at(-1).json, []);
  await assert.rejects(reader.getConnectionWriteContext(f.workspaceId, { ...request, writeIndex: 0 }), { code: 'WRITE_CONTEXT_UNAVAILABLE' });
  const changed = structuredClone(f.state); changed.users[1].tenantId = 'foreign'; await setState(f, changed);
  await assert.rejects(reader.getConnectionWriteContext(f.workspaceId, request), { code: 'WRITE_CONTEXT_UNAVAILABLE' });
  const automatic = structuredClone(f.state);
  automatic.connectionSettings.shopify = { permissionMode: 'automatic', consent: { mode: 'automatic', actor: 'owner' } };
  automatic.connectionWrites[1].input.operation = 'internal_note'; automatic.connectionWrites[1].requiresApproval = false; automatic.connectionWrites[1].approvalId = null;
  await setState(f, automatic);
  const noApproval = { ...request, approvalId: null, approvalIndex: null };
  assert.deepEqual((await reader.getConnectionWriteContext(f.workspaceId, noApproval)).approvals, []);
  assert.ok(!new URL(traces.at(-1).path, ordinary.url).searchParams.get('select').includes('approval:'));
  automatic.connectionWrites[1].input.description = 'x'.repeat(40000); await setState(f, automatic);
  const oversizedStart = traces.length;
  await assert.rejects(reader.getConnectionWriteContext(f.workspaceId, noApproval), { code: 'WRITE_CONTEXT_UNAVAILABLE' });
  assert.equal(traces.length - oversizedStart, 1); assert.ok(traces.at(-1).responseBytes > 32768);
  observations.push({ selectedDispatch: { indexedRecords: 1, responseBytes: trace.responseBytes, wholeStateRead: false, staleRevisionRejected: true, approvalNull: true, oversizedResponseRejected: true } });
});

test('actual missing protected RPC permits one legacy fallback while genuine permission denial never falls back', async () => {
  const f = await seed(old), reader = store(legacy); let start = traces.length;
  const review = await reader.getBusinessOutcomeReview(f.workspaceId, f.experimentId, actor);
  assert.equal(review.workspaceId, f.workspaceId);
  let calls = traces.slice(start); assert.equal(calls.length, 2); assert.equal(calls[0].status, 404); assert.equal(calls[0].json.code, 'PGRST202');
  assert.equal(calls[1].path, '/rest/v1/rpc/runvara_read_business_outcome_review'); assert.equal(calls[1].status, 200);
  start = traces.length;
  await assert.rejects(reader.getBusinessOutcomeReview(f.workspaceId, f.experimentId, actor, { requireReceiptContract: true }), { code: 'OUTCOME_STORAGE_UNAVAILABLE' });
  assert.equal(traces.length - start, 1);
  const publication = await store(legacy, { open: true }).publishBusinessOutcome(f.workspaceId, actor, inputFor(f));
  start = traces.length;
  const evidence = await reader.getBusinessOutcomeEvidence(f.workspaceId, publication.publication.head.versionId);
  assert.equal(evidence.sourceAction, null); assert.equal(evidence.sourceMeasurement.schema, 'runvara-experiment-measurement/v1');
  calls = traces.slice(start); assert.equal(calls.length, 2); assert.equal(calls[0].json.code, '42703'); assert.equal(calls[0].status, 400);
  assert.ok(calls[0].path.includes('source_action')); assert.ok(!calls[1].path.includes('source_action')); assert.equal(calls[1].status, 200);
  const protectedFixture = await seed();
  await full.admin.query('REVOKE EXECUTE ON FUNCTION ' + protectedSignature + ' FROM service_role');
  try {
    start = traces.length;
    await assert.rejects(store().getBusinessOutcomeReview(protectedFixture.workspaceId, protectedFixture.experimentId, actor), { code: 'OUTCOME_READ_UNAVAILABLE' });
    calls = traces.slice(start); assert.equal(calls.length, 1); assert.equal(calls[0].status, 403); assert.equal(calls[0].json.code, '42501');
  } finally { await full.admin.query('GRANT EXECUTE ON FUNCTION ' + protectedSignature + ' TO service_role'); }
  observations.push({ compatibility: { appliedMigrations: 6, missing: { status: 404, code: 'PGRST202', legacyCalls: 1 },
    missingSourceActionColumn: { status: 400, code: '42703', compatibilityCalls: 1 }, permissionDenied: { status: 403, code: '42501', legacyCalls: 0 } } });
});

test('embedded current and one use real relationships and Content-Range; lower max-rows marks incomplete', async () => {
  const f = await seed();
  f.state.revenueEngine.experiments = Array.from({ length: 3 }, (_, i) => ({ id: `experiment-${i}`, status: 'measured', outcomeMeasurement: sourceMeasurement(f.workspaceId, `experiment-${i}`) }));
  await setState(f, f.state); const writer = store(ordinary, { open: true });
  for (const experiment of f.state.revenueEngine.experiments) {
    f.state = await stateFor(f); f.experimentId = experiment.id; f.source = experiment.outcomeMeasurement;
    await writer.publishBusinessOutcome(f.workspaceId, actor, inputFor(f));
  }
  const summary = await store().businessOutcomeSummary(f.workspaceId), complete = traces.at(-1);
  assert.equal(complete.contentRange, '0-2/3'); assert.equal(complete.prefer, 'count=exact'); assert.equal(summary.publications.length, 3);
  assert.equal(summary.summary.coverage.totalCurrentHeads, 3); assert.equal(summary.summary.coverage.overflow, false);
  for (const row of complete.json) { assert.equal(typeof row.version, 'object'); assert.equal(row.version.version_id, row.version_id); }
  const one = await store().getBusinessOutcome(f.workspaceId, f.experimentId);
  assert.equal(one.version.source.experimentId, f.experimentId); assert.equal(traces.at(-1).json.length, 1);
  const partial = await store(limited).businessOutcomeSummary(f.workspaceId), truncated = traces.at(-1);
  assert.equal(truncated.contentRange, '0-0/3'); assert.equal(truncated.status, 206); assert.equal(partial.publications.length, 1);
  assert.equal(partial.summary.coverage.totalCurrentHeads, 3); assert.equal(partial.summary.coverage.overflow, true);
  assert.equal(partial.summary.coverage.complete, false); assert.equal(partial.summary.groups[0].amount, null);
  assert.equal((await store(limited).getBusinessOutcome(f.workspaceId, f.experimentId)).head.versionId, one.head.versionId);
  const empty = await seed(), none = await store().businessOutcomeSummary(empty.workspaceId);
  assert.equal(traces.at(-1).contentRange, '*/0'); assert.equal(none.publications.length, 0); assert.equal(none.summary.coverage.overflow, false);
  observations.push({ contentRange: { complete: complete.contentRange, truncated: truncated.contentRange, empty: '*/0' }, exactRelationship: 'runvara_outcome_head_version_fk', lowerMaxRows: 1 });
});

test('one exact protected reserve/finalize/lookup and private source reader round trip through createStore HTTP', async () => {
  await full.admin.query("UPDATE public.runvara_content_receipt_control SET mode='enforced'");
  const fixtures = stagedReceiptFixtures(full.admin), f = await fixtures.fixture(), reserve = fixtures.reserveRequest(f), finish = fixtures.finalizeRequest(f, reserve);
  const transport = store(ordinary, { open: true }), request = (operation, path, options) => transport.scopedRequest(f.workspaceId, operation, path, options);
  const reserveTx = prepareContentReceiptTransaction(f.workspaceId, reserve.state, reserve.expectedRevision, { contract, kind: 'reserve', admission: f.admission, sourceTemplate: f.sourceTemplate });
  const start = traces.length, reserved = await commitContentReceiptTransaction(reserveTx, request);
  assert.deepEqual(reserved.ack, { ...reserveTx.expectedAck, replayed: false });
  const reserveLookup = await transport.request('rpc/runvara_read_content_receipt', { method: 'POST', body: reserveTx.lookupBody });
  assert.deepEqual(reserveLookup, { ...reserveTx.expectedAck, replayed: true });
  const quotas = (await full.admin.query('SELECT scope_key,quota FROM public.runvara_content_receipt_quotas ORDER BY scope_key')).rows;
  await full.admin.query("UPDATE public.runvara_content_receipt_control SET mode='paused'");
  const finishTx = prepareContentReceiptTransaction(f.workspaceId, finish.state, finish.expectedRevision, { contract, kind: 'finalize', admission: f.admission, receipt: f.receipt });
  const finished = await commitContentReceiptTransaction(finishTx, (operation, path, options) => store().scopedRequest(f.workspaceId, operation, path, options));
  assert.deepEqual(finished.ack, { ...finishTx.expectedAck, replayed: false });
  const finishLookup = await transport.request('rpc/runvara_read_content_receipt', { method: 'POST', body: finishTx.lookupBody });
  assert.deepEqual(finishLookup, { ...finishTx.expectedAck, replayed: true });
  assert.deepEqual((await full.admin.query('SELECT scope_key,quota FROM public.runvara_content_receipt_quotas ORDER BY scope_key')).rows, quotas);
  const roundTrip = traces.slice(start); assert.deepEqual(roundTrip.map(call => call.path), ['/rest/v1/rpc/runvara_reserve_content_receipt', '/rest/v1/rpc/runvara_read_content_receipt', '/rest/v1/rpc/runvara_finalize_content_receipt', '/rest/v1/rpc/runvara_read_content_receipt']);
  assert.equal(roundTrip[0].body, reserveTx.body); assert.equal(roundTrip[2].body, finishTx.body);
  assert.equal((await full.admin.query('SELECT count(*)::int n FROM public.runvara_content_receipts WHERE workspace_id=$1', [f.workspaceId])).rows[0].n, 1);
  for (const table of ['runvara_content_admissions', 'runvara_content_receipts']) await assert.rejects(transport.request(table + '?select=*&limit=1'), { httpStatus: 403, databaseCode: '42501' });
  const selector = { attemptId: f.admission.attemptId, receiptDigest: f.receipt.digest, sourceDigest: f.sourceAction.digest };
  const review = await transport.getBusinessOutcomeReview(f.workspaceId, f.experimentId, actor, { receipt: selector, requireReceiptContract: true });
  assert.equal(review.receiptChoices.length, 1); assert.equal(review.receiptChoices[0].receiptSource.attemptId, f.admission.attemptId);
  const privateEvidence = selectedProtectedReceiptEvidence(review);
  assert.deepEqual(privateEvidence.admission, f.admission); assert.deepEqual(privateEvidence.receipt, f.receipt); assert.equal(privateEvidence.commitRevision, finish.nextRevision);
  const serialized = JSON.stringify(review); assert.ok(!serialized.includes('actorSessionVersion')); assert.ok(!serialized.includes('authorityDigest'));
  assert.ok(!serialized.includes('claimIdentity')); assert.ok(!serialized.includes('requestFingerprint'));
  await assert.rejects(transport.getBusinessOutcomeReview(f.workspaceId, f.experimentId, { ...actor, sessionVersion: 2 }, { receipt: selector }), { code: 'OUTCOME_OWNER_SESSION_CHANGED' });
  observations.push({ receiptRoundTrip: { reserve: reserved.ack.kind, finalize: finished.ack.kind, exactLookups: 2,
    requestFingerprints: [reserveTx.expectedAck.requestFingerprint, finishTx.expectedAck.requestFingerprint], receipts: 1,
    privateTablesDenied: true, privateEvidenceRetainedOutOfSerialization: true, finalizedWhilePaused: true } });
});
