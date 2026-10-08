/**
 * Explicit disposable PostgreSQL 17 proof of the protected receipt contract.
 * Deliberately outside *.test.mjs. No provider, Supabase, deployment, or account
 * connection is used. All roles, grants, fixtures, and activation are local.
 */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { canonical, hash, actionFixture } from './business-outcome-postgres-fixture.mjs';
import { objectivePublicationFixture } from './objective-publication-fixture.mjs';
import { runContentReceiptDispatcherPgTests } from './content-execution-receipt-pg-dispatch.mjs';

assert.equal(process.env.OUTCOME_ALLOW_DISPOSABLE_TEST_DB, '1', 'Explicit disposable database opt-in required');
const baseConnectionString = process.env.OUTCOME_TEST_DATABASE_URL;
assert.ok(baseConnectionString, 'OUTCOME_TEST_DATABASE_URL required; never silently skipped');
const url = new URL(baseConnectionString);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
assert.equal(url.pathname, '/runvara_outcome_test');
assert.equal(url.username, 'postgres');
assert.equal(url.search, ''); assert.equal(url.hash, '');
const require = createRequire(new URL('./atomic-usage/package.json', import.meta.url));
const { Client } = require('pg');
const CONTRACT = 'runvara-content-execution-receipts/v1';
const RESERVED_BYTES = 40960;
const REQUEST_BYTES = 2162688;
const TABLES = ['runvara_content_receipt_control', 'runvara_content_receipt_quotas', 'runvara_content_admissions', 'runvara_content_receipts'];
const RPC = {
  reserve: 'public.runvara_reserve_content_receipt(text)',
  finalize: 'public.runvara_finalize_content_receipt(text)',
  lookup: 'public.runvara_read_content_receipt(text,text,text,text,text,bigint)'
};
const clients = new Set();
const rawHash = text => createHash('sha256').update(text).digest('hex');
const withoutDigest = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'digest'));
const sign = value => ({ ...withoutDigest(value), digest: hash(withoutDigest(value)) });
let admin, baseline, migration, securityBefore, roleStateBefore, baseAdmin, createdDatabase;
let connectionString;

async function connect(role = 'service_role') {
  const c = new Client({ connectionString, ssl: false, options: '', connectionTimeoutMillis: 5000,
    statement_timeout: 20_000, application_name: 'runvara-content-receipt-test' });
  await c.connect(); clients.add(c);
  assert.ok(['postgres', 'service_role', 'anon', 'authenticated'].includes(role));
  if (role !== 'postgres') await c.query('SET SESSION AUTHORIZATION ' + role);
  await c.query("SET TIME ZONE 'UTC'");
  return c;
}
async function close(c) { clients.delete(c); await c.end(); }
async function using(role, fn) { const c = await connect(role); try { return await fn(c); } finally { await close(c); } }
async function call(kind, request, c) {
  if (!c) return using('service_role', c => call(kind, request, c));
  assert.ok(['reserve', 'finalize'].includes(kind));
  const raw = typeof request === 'string' ? request : JSON.stringify(request);
  return (await c.query(`SELECT public.runvara_${kind}_content_receipt($1::text) ack`, [raw])).rows[0].ack;
}
async function lookup(f, kind, raw, overrides = {}, c) {
  if (!c) return using('service_role', c => lookup(f, kind, raw, overrides, c));
  const p = { workspaceId: f.workspaceId, attemptId: f.admission.attemptId, kind,
    fingerprint: rawHash(typeof raw === 'string' ? raw : JSON.stringify(raw)),
    actorId: f.admission.actorId, sessionVersion: f.admission.actorSessionVersion, ...overrides };
  return (await c.query('SELECT public.runvara_read_content_receipt($1,$2,$3,$4,$5,$6::bigint) ack',
    [p.workspaceId, p.attemptId, p.kind, p.fingerprint, p.actorId, p.sessionVersion])).rows[0].ack;
}
async function state(f) { return (await admin.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1', [f.workspaceId])).rows[0]?.state; }
async function setState(f, value, role = 'service_role') {
  return using(role, c => c.query('UPDATE public.saas_workspace_state SET state=$2::jsonb WHERE workspace_id=$1', [f.workspaceId, value]));
}
async function count(table, workspaceId) {
  assert.ok(TABLES.includes(table));
  return (await admin.query(`SELECT count(*)::int n FROM public.${table} WHERE workspace_id=$1`, [workspaceId])).rows[0].n;
}
function rejected(code = ['P0R01', 'P0R02', 'P0R03', 'P0R04', 'P0R05', 'P0R06', 'P0R07', 'P0O01', 'P0O10', '23503', '0A000']) { return error => {
  assert.ok(error.code, 'A database rejection must have a SQLSTATE');
  if (code) assert.ok([code].flat().includes(error.code), `${error.code}: ${error.message}`);
  assert.ok(!error.message.includes('Synthetic exact') && !error.message.includes('secretNeverReturned'), 'No source or workspace data in failure');
  return true;
}; }
function expectedAck(f, kind, request, replayed) {
  const raw = typeof request === 'string' ? request : JSON.stringify(request), r = JSON.parse(raw);
  return { schema: 'runvara-content-execution-commit-ack/v1', kind, workspaceId: f.workspaceId,
    attemptId: f.admission.attemptId, admissionDigest: f.admission.digest, intentDigest: f.admission.intentDigest,
    expectedRevision: r.expectedRevision, nextRevision: r.nextRevision,
    receiptDigest: kind === 'finalize' ? r.receipt.digest : null, reservedBytes: RESERVED_BYTES,
    replayed, requestFingerprint: rawHash(raw) };
}

// Independent producer: fixtures and canonical hashing predate the production
// receipt implementation. No production admission/receipt factory is imported.
function action(workspaceId, options = {}) {
  const f = actionFixture(workspaceId, { description: 'Synthetic exact Café 雪 😀 & < >\n"quoted" \\ bytes', ...options });
  const claimId = 'write_claim_' + randomUUID();
  f.write.dispatchClaim.id = claimId;
  f.sourceAction.context.claimId = claimId;
  f.sourceAction = sign(f.sourceAction);
  f.write.recordedActionContext = { ...structuredClone(f.sourceAction.context), snapshotDigest: f.sourceAction.digest };
  return f;
}
function descriptor(f) {
  const sourceTemplate = structuredClone(f.sourceAction);
  sourceTemplate.context.completedAt = f.write.dispatchClaim.phases.shopify_mutation.at;
  const signedTemplate = sign(sourceTemplate), c = signedTemplate.context;
  const intent = { ...withoutDigest(signedTemplate), context: { ...c, completedAt: null } };
  const admission = sign({ schema: 'runvara-content-execution-admission/v1', workspaceId: f.workspaceId,
    attemptId: 'content_attempt_' + hash([f.workspaceId, c.claimId, 'shopify_mutation']),
    writeId: c.writeId, requestId: c.requestId, claimId: c.claimId, claimIdentity: c.claimIdentity,
    authorityDigest: f.write.dispatchClaim.authority, actorId: c.executedBy, actorSessionVersion: 1,
    phase: 'shopify_mutation', dispatchRequestDigest: c.dispatchRequestDigest,
    intentDigest: hash(intent), admittedAt: c.completedAt, reservedBytes: RESERVED_BYTES });
  const receipt = sign({ schema: 'runvara-content-execution-receipt/v1', workspaceId: f.workspaceId,
    attemptId: admission.attemptId, admissionDigest: admission.digest, intentDigest: admission.intentDigest,
    observation: 'provider_confirmed', source: structuredClone(f.sourceAction) });
  return { admission, sourceTemplate: signedTemplate, receipt };
}
async function fixture(options = {}) {
  const workspaceId = options.workspaceId || 'receipt-pg-' + randomUUID();
  const f = { workspaceId, ...action(workspaceId, options) };
  options.transform?.(f);
  const beforeWrite = structuredClone(f.write);
  beforeWrite.status = 'executing';
  delete beforeWrite.completedAt; delete beforeWrite.result; delete beforeWrite.recordedActionContext;
  beforeWrite.dispatchClaim.phases = {};
  const beforeApproval = { ...structuredClone(f.approval), executionStatus: 'approved', executedExternally: false };
  f.state = { workspace: { id: workspaceId }, _revision: randomUUID(),
    users: [{ id: 'owner', role: 'owner', active: true, sessionVersion: 1 }],
    connectionWrites: [beforeWrite], approvals: [beforeApproval], connections: [f.connection],
    integrationStatus: { reporting: { status: 'degraded' }, shopify: { sentinel: 'preserve' } },
    ordinaryDecimals: { revenue: 25.5, ratio: 0.125, tiny: 1e-9 },
    sentinel: { secretNeverReturned: 'synthetic-not-a-secret' }, audit: [{ id: 'unchanged' }] };
  Object.assign(f, descriptor(f));
  await admin.query('INSERT INTO public.workspaces(id,name,slug) VALUES($1,$1,$1)', [workspaceId]);
  await admin.query('INSERT INTO public.saas_workspace_state(workspace_id,state) VALUES($1,$2)', [workspaceId, f.state]);
  return f;
}
function reserveRequest(f, { state: s = f.state, expectedRevision = s._revision, nextRevision = randomUUID() } = {}) {
  const next = structuredClone(s), w = next.connectionWrites.find(w => w.id === f.write.id);
  w.dispatchClaim.phases.shopify_mutation = structuredClone(f.write.dispatchClaim.phases.shopify_mutation);
  next._revision = nextRevision;
  return { contract: CONTRACT, kind: 'reserve', workspaceId: f.workspaceId, expectedRevision, nextRevision,
    state: next, admission: structuredClone(f.admission), sourceTemplate: structuredClone(f.sourceTemplate) };
}
function finalizeRequest(f, reserve, { state: s = reserve.state, expectedRevision = s._revision, nextRevision = randomUUID() } = {}) {
  const next = structuredClone(s);
  const index = next.connectionWrites.findIndex(w => w.id === f.write.id);
  next.connectionWrites[index] = structuredClone(f.write);
  next.approvals[next.approvals.findIndex(a => a.id === f.approval.id)] = structuredClone(f.approval);
  next._revision = nextRevision;
  return { contract: CONTRACT, kind: 'finalize', workspaceId: f.workspaceId, expectedRevision, nextRevision,
    state: next, admission: structuredClone(f.admission), receipt: structuredClone(f.receipt) };
}
function retainedArrays(f, count) {
  const next = structuredClone(f.state);
  for (const [field, selected] of [['connectionWrites', next.connectionWrites[0]], ['approvals', next.approvals[0]], ['connections', next.connections[0]]]) {
    next[field] = [...Array.from({ length: count - 1 }, (_, index) => ({ id: 'other-' + field + '-' + index })), selected];
  }
  return next;
}
function conservativeCompletionState(reserve) {
  const next = structuredClone(reserve.state), c = reserve.sourceTemplate.context;
  const writeIndex = next.connectionWrites.findIndex(w => w.id === reserve.admission.writeId);
  const w = next.connectionWrites[writeIndex];
  next.connectionWrites[writeIndex] = { ...w, status: 'completed', completedAt: c.completedAt,
    result: { externalId: c.resultId }, errorCode: null, observationErrorCode: null, dispatchBlocked: false,
    recordedActionContext: { ...structuredClone(c), snapshotDigest: reserve.sourceTemplate.digest } };
  const approvalIndex = next.approvals.findIndex(a => a.id === w.approvalId);
  next.approvals[approvalIndex] = { ...next.approvals[approvalIndex], executedExternally: true,
    executionStatus: 'completed', workStatus: 'COMPLETED' };
  return next;
}
function numericIdentityFixture(f) {
  const w = f.write, c = f.sourceAction.context;
  w.requestId = c.requestId = '1234567890123456';
  w.dispatchClaim.id = c.claimId = '1234567890';
  w.approvalId = f.approval.id = c.approval.id = '456';
  w.connectionId = f.connection.id = c.connectionId = '789';
  c.approval = sign(c.approval);
  const identity = Object.fromEntries(['id', 'requestId', 'provider', 'input', 'digest', 'connectionId', 'account',
    'requestedBy', 'requiresApproval', 'approvalId'].map(key => [key, w[key]]));
  w.dispatchClaim.identity = c.claimIdentity = rawHash(JSON.stringify(identity));
  f.sourceAction = sign(f.sourceAction);
  w.recordedActionContext = { ...structuredClone(f.sourceAction.context), snapshotDigest: f.sourceAction.digest };
}
async function unrelatedGenericCompatibility() {
  const f = await fixture();
  for (const value of [null, {}, [null, {}, 123, { id: null }, { id: 123 }, { id: '123' }],
    Array.from({ length: 10001 }, (_, i) => ({ id: 'ordinary-' + i }))]) {
    const next = { ...structuredClone(f.state), connectionWrites: value, _revision: randomUUID(), ordinaryChange: true };
    await setState(f, next); assert.deepEqual(await state(f), next);
  }
  assert.deepEqual(await retainedRows(f), { admissions: 0, receipts: 0 });
}
async function retainedRows(f) {
  return { admissions: await count('runvara_content_admissions', f.workspaceId), receipts: await count('runvara_content_receipts', f.workspaceId) };
}
async function blocked(pid) {
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    if ((await admin.query('SELECT cardinality(pg_blocking_pids($1::int))>0 blocked', [pid])).rows[0].blocked) return;
    await delay(10);
  }
  assert.fail('Expected transaction to wait on held PostgreSQL row lock');
}
async function quota(scopeKey) {
  return (await admin.query('SELECT quota FROM public.runvara_content_receipt_quotas WHERE scope_key=$1', [scopeKey])).rows[0]?.quota;
}
async function seedCounter(scopeKey, target) {
  // Synthetic administrator boundary setup exercises the immutable +1 rule;
  // no triggers are disabled and no counter is reduced or slot reclaimed.
  const current = (await quota(scopeKey)).attempts;
  assert.ok(current <= target);
  for (let n = current; n < target; n++) {
    await admin.query(`UPDATE public.runvara_content_receipt_quotas SET quota=jsonb_build_object('schema','runvara-content-receipt-quota/v1',
      'attempts',(quota->>'attempts')::int+1,'reservedBytes',((quota->>'attempts')::int+1)*40960) WHERE scope_key=$1`, [scopeKey]);
  }
}
async function roles() {
  return (await admin.query('SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolconfig FROM pg_roles ORDER BY rolname')).rows;
}
async function security() {
  const tables = (await admin.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relowner::regrole::text owner,
    r.rolname,has_table_privilege(r.oid,c.oid,'SELECT') sel,has_table_privilege(r.oid,c.oid,'INSERT') ins,
    has_table_privilege(r.oid,c.oid,'UPDATE') upd,has_table_privilege(r.oid,c.oid,'DELETE') del,
    has_table_privilege(r.oid,c.oid,'TRUNCATE') trunc
    FROM pg_class c CROSS JOIN pg_roles r WHERE c.relnamespace='public'::regnamespace
      AND c.relname=ANY($1::text[]) AND r.rolname IN ('anon','authenticated','service_role') ORDER BY c.relname,r.rolname`, [TABLES])).rows;
  const functions = (await admin.query(`SELECT p.oid::regprocedure::text signature,p.proname,p.prosecdef,p.proconfig,p.proowner::regrole::text owner,
    has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
    has_function_privilege('service_role',p.oid,'EXECUTE') service,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) WHERE grantee=0 AND privilege_type='EXECUTE') public
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND
      (p.proname LIKE 'runvara_content_%' OR p.proname IN ('runvara_reserve_content_receipt','runvara_finalize_content_receipt','runvara_read_content_receipt')) ORDER BY signature`)).rows;
  return { tables, functions };
}
async function assertSecurity() {
  const result = await security();
  assert.equal(result.tables.length, TABLES.length * 3);
  for (const row of result.tables) {
    assert.equal(row.relrowsecurity, true, row.relname);
    for (const permission of ['sel', 'ins', 'upd', 'del', 'trunc']) assert.equal(row[permission], false, `${row.rolname} ${row.relname} ${permission}`);
  }
  for (const row of result.functions) {
    assert.equal(row.anon, false, row.signature); assert.equal(row.authenticated, false, row.signature);
    assert.equal(row.public, false, row.signature); assert.ok(row.proconfig.includes('search_path=""'), row.signature);
    const exposed = Object.values(RPC).map(v => v.replace('public.', '')).includes(row.signature.replace('public.', ''));
    assert.equal(row.service, exposed, row.signature);
    if (exposed) assert.equal(row.prosecdef, true, row.signature);
  }
  assert.equal(result.functions.filter(row => row.service).length, 3);
  return result;
}

before(async () => {
  // CI predecessor suites use runvara_outcome_test. Their schema and data are
  // never reset: create a new random empty database on that disposable service.
  baseAdmin = new Client({ connectionString: baseConnectionString, ssl: false, options: '', connectionTimeoutMillis: 5000 });
  await baseAdmin.connect();
  const base = (await baseAdmin.query("SELECT current_database() db,current_user role,current_setting('server_version_num')::int version")).rows[0];
  assert.equal(base.db, 'runvara_outcome_test'); assert.equal(base.role, 'postgres');
  assert.ok(base.version >= 170000 && base.version < 180000);
  assert.ok(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(baseAdmin.connection.stream.remoteAddress));
  const database = 'runvara_content_receipt_test_' + randomUUID().replaceAll('-', '');
  assert.match(database, /^runvara_content_receipt_test_[a-f0-9]{32}$/);
  await baseAdmin.query('CREATE DATABASE ' + database);
  createdDatabase = database;
  const childUrl = new URL(baseConnectionString); childUrl.pathname = '/' + database;
  connectionString = childUrl.toString();
  admin = await connect('postgres');
  const info = (await admin.query("SELECT current_database() db,current_user role,current_setting('server_version_num')::int version,current_setting('listen_addresses') listen")).rows[0];
  assert.equal(info.db, createdDatabase); assert.equal(info.role, 'postgres');
  assert.ok(info.version >= 170000 && info.version < 180000);
  assert.ok(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(admin.connection.stream.remoteAddress));
  const objects = (await admin.query(`SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
    UNION ALL SELECT n.nspname,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'`)).rows;
  assert.deepEqual(objects, [], 'Refusing nonempty disposable database');
  let fixtureSql = await readFile(new URL('./atomic-usage-postgres-fixture.sql', import.meta.url), 'utf8');
  for (const name of ['anon', 'authenticated', 'service_role', 'atomic_usage_untrusted']) {
    const existing = (await admin.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1', [name])).rows[0];
    if (existing) {
      assert.deepEqual(existing, { rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolcanlogin: false,
        rolreplication: false, rolbypassrls: name === 'service_role' }, 'Only known synthetic predecessor roles are accepted');
      fixtureSql = fixtureSql.replace(new RegExp('create role ' + name + ' [^;]+;'), '');
    }
  }
  await admin.query(fixtureSql);
  baseline = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  await admin.query(baseline);
  for (const file of ['20260927113000_runvara_agent_operations.sql', '20260927122500_ai_usage_economics.sql',
    '20261006190318_atomic_provider_usage.sql', '20261007074031_reporting_status_cas.sql',
    '20261007100823_business_outcome_publication.sql', '20261007175355_reviewed_action_outcome_snapshot.sql',
    '20261008055400_objective_action_outcome_snapshot.sql']) {
    await admin.query(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
  }
  roleStateBefore = await roles();
  migration = await readFile(new URL('../supabase/migrations/20261008144414_protected_content_execution_receipts.sql', import.meta.url), 'utf8');
  assert.ok(migration.trim(), 'Prepared migration must exist');
  await admin.query(migration);
  securityBefore = await assertSecurity();
  assert.deepEqual(await roles(), roleStateBefore, 'Receipt migration never creates/expands roles');
  console.log('CONTENT_RECEIPT_SAFETY=' + JSON.stringify({ ...info, host: admin.connection.stream.remoteAddress,
    emptyAtStart: true, syntheticLocalRoles: true, applicationConnections: 0, providerSubmissions: 0 }));
}, { timeout: 30000 });
after(async () => {
  try {
    await Promise.all([...clients].map(close));
    if (createdDatabase) {
      assert.match(createdDatabase, /^runvara_content_receipt_test_[a-f0-9]{32}$/);
      await baseAdmin.query('DROP DATABASE ' + createdDatabase);
      assert.equal((await baseAdmin.query('SELECT 1 FROM pg_database WHERE datname=$1', [createdDatabase])).rowCount, 0);
      console.log('CONTENT_RECEIPT_DATABASE_CLEANUP=' + JSON.stringify({ droppedCreatedDatabase: createdDatabase, predecessorDatabaseUnchanged: 'runvara_outcome_test' }));
    }
  } finally { if (baseAdmin) await baseAdmin.end(); }
});

test('prepared latch is inactive; only local fixture administrator activates enforcement', async () => {
  assert.equal((await admin.query('SELECT mode FROM public.runvara_content_receipt_control WHERE id')).rows[0].mode, 'prepared');
  await unrelatedGenericCompatibility();
  const f = await fixture(), r = reserveRequest(f);
  await assert.rejects(call('reserve', r), rejected());
  assert.deepEqual(await retainedRows(f), { admissions: 0, receipts: 0 });
  assert.deepEqual(await state(f), f.state);
  await using('service_role', c => assert.rejects(c.query("UPDATE public.runvara_content_receipt_control SET mode='enforced' WHERE id"), rejected('42501')));
  const holder = await connect('postgres'), oldExecutor = await connect();
  try {
    await holder.query('BEGIN'); await holder.query('SELECT 1 FROM public.saas_workspace_state WHERE workspace_id=$1 FOR UPDATE', [f.workspaceId]);
    const pid = (await oldExecutor.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const stalePatch = oldExecutor.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1', [f.workspaceId, r.state]);
    const denied = assert.rejects(stalePatch, rejected('P0R06')); await blocked(pid);
    await admin.query("UPDATE public.runvara_content_receipt_control SET mode='enforced' WHERE id");
    await holder.query('COMMIT'); await denied;
    assert.deepEqual(await state(f), f.state);
  } finally { await holder.query('ROLLBACK'); await close(holder); await close(oldExecutor); }
  assert.equal((await admin.query('SELECT mode FROM public.runvara_content_receipt_control WHERE id')).rows[0].mode, 'enforced');
});

test('actual dispatcher and SupabaseStore preserve receipts through real PostgreSQL commits and lost ACKs', { timeout: 120000 }, async () => {
  await runContentReceiptDispatcherPgTests({ admin, withService: fn => using('service_role', fn) });
});

test('independent manual and policy sources reserve then finalize with exact ACK and frozen source bytes', async () => {
  for (const policyCount of [0, 2]) {
    const f = await fixture({ policyCount }), reserve = reserveRequest(f), finish = finalizeRequest(f, reserve);
    assert.deepEqual((await admin.query('SELECT public.runvara_outcome_validate_source_action($1::jsonb,$2) source', [f.sourceTemplate, f.workspaceId])).rows[0].source, f.sourceTemplate);
    assert.deepEqual(await call('reserve', reserve), expectedAck(f, 'reserve', reserve, false));
    assert.deepEqual(await retainedRows(f), { admissions: 1, receipts: 0 });
    assert.deepEqual(await state(f), reserve.state);
    assert.deepEqual(await call('finalize', finish), expectedAck(f, 'finalize', finish, false));
    assert.deepEqual(await state(f), finish.state);
    const stored = (await admin.query('SELECT receipt,request_fingerprint,expected_revision,commit_revision FROM public.runvara_content_receipts WHERE workspace_id=$1', [f.workspaceId])).rows[0];
    assert.deepEqual(stored, { receipt: f.receipt, request_fingerprint: rawHash(JSON.stringify(finish)), expected_revision: finish.expectedRevision, commit_revision: finish.nextRevision });
    assert.equal(hash(withoutDigest(stored.receipt)), stored.receipt.digest);
    assert.deepEqual(await retainedRows(f), { admissions: 1, receipts: 1 });
  }
});

test('objective v2 preserves original approval, policy, product and source bytes through reserve and receipt', async () => {
  // Existing objective producer uses only its explicitly synthetic provider and
  // local HTTP approval fixture. Admission/receipt hashes below stay independent.
  const actual = await objectivePublicationFixture({ workspaceId: 'receipt-objective-' + randomUUID() });
  const f = { ...actual, sourceAction: actual.source, state: structuredClone(actual.state) };
  f.state._revision = randomUUID();
  const beforeWrite = f.state.connectionWrites.find(w => w.id === f.write.id);
  beforeWrite.status = 'executing'; beforeWrite.dispatchClaim.phases = {};
  delete beforeWrite.result; delete beforeWrite.completedAt; delete beforeWrite.recordedActionContext;
  Object.assign(f, descriptor(f));
  await admin.query('INSERT INTO public.workspaces(id,name,slug) VALUES($1,$1,$1)', [f.workspaceId]);
  await admin.query('INSERT INTO public.saas_workspace_state(workspace_id,state) VALUES($1,$2)', [f.workspaceId, f.state]);
  assert.equal(f.sourceAction.schema, 'runvara-reviewed-source-action/v2');
  const reserve = reserveRequest(f), finish = finalizeRequest(f, reserve);
  assert.deepEqual(await call('reserve', reserve), expectedAck(f, 'reserve', reserve, false));
  assert.deepEqual(await call('finalize', finish), expectedAck(f, 'finalize', finish, false));
  const stored = (await admin.query('SELECT receipt FROM public.runvara_content_receipts WHERE workspace_id=$1', [f.workspaceId])).rows[0].receipt;
  assert.deepEqual(stored, f.receipt);
  assert.deepEqual(stored.source.context.proposal, actual.source.context.proposal);
  assert.deepEqual(stored.source.context.stableApproval, actual.source.context.stableApproval);
  assert.equal(stored.source.context.claimIdentity, actual.write.dispatchClaim.identity);
});

test('receipt source projection supports last-position targets in all 10000-row arrays without widening publication helpers', async () => {
  const f = await fixture(), prior = retainedArrays(f, 10000); await setState(f, prior);
  const reserve = reserveRequest(f, { state: prior }), finish = finalizeRequest(f, reserve);
  assert.ok(Buffer.byteLength(JSON.stringify(finish.state)) < 2097152);
  const arraySizes = (await admin.query("SELECT octet_length(($1::jsonb->'connectionWrites')::text) writes,octet_length(($1::jsonb->'approvals')::text) approvals,octet_length(($1::jsonb->'connections')::text) connections", [finish.state])).rows[0];
  for (const size of Object.values(arraySizes)) assert.ok(size <= 2097152);
  assert.deepEqual(await call('reserve', reserve), expectedAck(f, 'reserve', reserve, false));
  assert.deepEqual(await call('finalize', finish), expectedAck(f, 'finalize', finish, false));
  assert.deepEqual((await admin.query('SELECT receipt FROM public.runvara_content_receipts WHERE workspace_id=$1', [f.workspaceId])).rows[0].receipt, f.receipt);
  await assert.rejects(admin.query('SELECT public.runvara_outcome_resolve_action($1::jsonb,$2,$3)', [finish.state, f.workspaceId, f.write.id]), rejected('P0O10'));
  console.log('CONTENT_RECEIPT_LARGE_SOURCE_ARRAYS=' + JSON.stringify({ rowsEach: 10000, selectedOffsets: [9999, 9999, 9999],
    arrayJsonbBytes: arraySizes, stateRawBytes: Buffer.byteLength(JSON.stringify(finish.state)), unchangedPublicationCap: 500 }));
});

test('complete retained arrays reject late duplicate write, request, claim, approval and connection aliases', async () => {
  const cases = [
    ['write', (s, f) => s.connectionWrites.push({ id: f.write.id })],
    ['request', (s, f) => s.connectionWrites.push({ id: 'duplicate-request', requestId: f.write.requestId })],
    ['claim', (s, f) => s.connectionWrites.push({ id: 'duplicate-claim', dispatchClaim: { id: f.admission.claimId } })],
    ['approval', (s, f) => s.approvals.push({ id: f.approval.id })],
    ['connection', (s, f) => s.connections.push({ id: f.connection.id })],
    ['numeric write alias', (s, f) => s.connectionWrites.push({ id: Number(f.write.id) })],
    ['numeric request alias', (s, f) => s.connectionWrites.push({ id: 'numeric-request', requestId: Number(f.write.requestId) })],
    ['numeric claim alias', (s, f) => s.connectionWrites.push({ id: 'numeric-claim', dispatchClaim: { id: Number(f.admission.claimId) } })],
    ['numeric approval alias', (s, f) => s.approvals.push({ id: Number(f.approval.id) })],
    ['numeric connection alias', (s, f) => s.connections.push({ id: Number(f.connection.id) })]
  ];
  for (const [label, mutate] of cases) {
    const f = await fixture({ id: '123', transform: numericIdentityFixture });
    const prior = retainedArrays(f, 1000); await setState(f, prior);
    const reserve = reserveRequest(f, { state: prior }); mutate(reserve.state, f);
    const beforeQuota = await quota('global');
    await assert.rejects(call('reserve', reserve), rejected('P0R01'), label);
    assert.deepEqual(await state(f), prior, label);
    assert.deepEqual(await retainedRows(f), { admissions: 0, receipts: 0 }, label);
    assert.deepEqual(await quota('global'), beforeQuota, label);
  }
});

test('protected indexed writes reject missing/null IDs, numeric aliases, and malformed array replacements', async () => {
  const f = await fixture({ id: '123', transform: numericIdentityFixture }), prior = retainedArrays(f, 1000);
  await setState(f, prior); const reserve = reserveRequest(f, { state: prior }); await call('reserve', reserve);
  for (const mutate of [s => { s.connectionWrites[999].id = null; }, s => { delete s.connectionWrites[999].id; },
    s => { s.connectionWrites.push({ id: 123 }); }, s => { s.connectionWrites = null; },
    s => { s.connectionWrites = {}; }, s => { s.connectionWrites.push({ id: 'other-final-row' }, { id: 'last' }); s.connectionWrites[999].id = 'renamed'; }]) {
    const forged = structuredClone(reserve.state); mutate(forged);
    await assert.rejects(setState(f, forged), rejected('P0R06'));
    assert.deepEqual(await state(f), reserve.state);
  }
  await unrelatedGenericCompatibility();
});

test('source arrays retain exact row/JSONB bounds and preflight future completion headroom before charging', async () => {
  for (const field of ['connectionWrites', 'approvals', 'connections']) {
    for (const mode of ['malformed', 'rows', 'exactBytes', 'overBytes', ...(field === 'connections' ? [] : ['futureOver'])]) {
      const f = await fixture(), prior = structuredClone(f.state);
      const selected = prior[field][0];
      if (mode === 'malformed') prior[field] = {};
      else prior[field] = [...Array.from({ length: mode === 'rows' ? 10000 : 9999 }, (_, i) => ({ id: 'unrelated-' + i })), selected];
      if (['exactBytes', 'overBytes', 'futureOver'].includes(mode)) {
        prior[field][0].padding = '';
        const candidate = reserveRequest(f, { state: prior });
        const candidateArray = (mode === 'overBytes' ? candidate.state : conservativeCompletionState(candidate))[field];
        const beforeSize = (await admin.query('SELECT octet_length($1::jsonb::text) bytes', [JSON.stringify(candidateArray)])).rows[0].bytes;
        prior[field][0].padding = 'x'.repeat(2097152 + Number(mode !== 'exactBytes') - beforeSize);
        const sized = reserveRequest(f, { state: prior });
        const measured = (mode === 'overBytes' ? sized.state : conservativeCompletionState(sized))[field];
        assert.equal((await admin.query('SELECT octet_length($1::jsonb::text) bytes', [JSON.stringify(measured)])).rows[0].bytes, 2097152 + Number(mode !== 'exactBytes'));
        if (mode === 'futureOver') assert.ok((await admin.query('SELECT octet_length($1::jsonb::text) bytes', [JSON.stringify(sized.state[field])])).rows[0].bytes <= 2097152);
      }
      if (field === 'connectionWrites' && mode === 'malformed') {
        const reserve = reserveRequest(f); reserve.state[field] = {};
        await assert.rejects(call('reserve', reserve), rejected('P0R01'));
      } else {
        await setState(f, prior);
        const reserve = reserveRequest(f, { state: prior });
        assert.ok(Buffer.byteLength(JSON.stringify(reserve.state)) < 2097152, field + ' isolate array JSONB bound');
        if (mode === 'exactBytes') {
          assert.deepEqual(await call('reserve', reserve), expectedAck(f, 'reserve', reserve, false));
          const finish = finalizeRequest(f, reserve);
          assert.ok((await admin.query('SELECT octet_length($1::jsonb::text) bytes', [JSON.stringify(finish.state[field])])).rows[0].bytes <= 2097152);
          assert.deepEqual(await call('finalize', finish), expectedAck(f, 'finalize', finish, false));
        } else {
          const beforeQuota = await quota('global');
          await assert.rejects(call('reserve', reserve), error => {
            rejected('P0R01')(error);
            if (mode === 'futureOver') assert.equal(error.message, 'CONTENT_RECEIPT_FUTURE_SOURCE_TOO_LARGE');
            return true;
          });
          assert.deepEqual(await retainedRows(f), { admissions: 0, receipts: 0 });
          assert.deepEqual(await state(f), prior);
          assert.deepEqual(await quota('global'), beforeQuota);
          assert.equal(await quota('tenant:' + f.workspaceId), undefined);
        }
      }
    }
  }
});

test('workspace namespaces reject missing blank control oversized and cross-tenant identities while retaining the 256-character grammar', async () => {
  const f = await fixture(), base = reserveRequest(f), beforeQuota = await quota('global');
  for (const invalid of [undefined, '', ' ', ' tenant', 'tenant ', 'tenant\ncontrol', 'w'.repeat(257), null]) {
    const forged = structuredClone(base);
    if (invalid === undefined) delete forged.workspaceId; else forged.workspaceId = invalid;
    await assert.rejects(call('reserve', forged), rejected('P0R01'));
    assert.deepEqual(await retainedRows(f), { admissions: 0, receipts: 0 });
    assert.deepEqual(await state(f), f.state); assert.deepEqual(await quota('global'), beforeQuota);
  }
  const foreign = await fixture(), forged = structuredClone(base);
  forged.workspaceId = foreign.workspaceId; forged.state.workspace.id = foreign.workspaceId;
  await assert.rejects(call('reserve', forged), rejected('P0R01'));
  assert.deepEqual(await retainedRows(foreign), { admissions: 0, receipts: 0 });
  assert.deepEqual(await state(foreign), foreign.state);
  const valid = await fixture({ workspaceId: 'valid tenant:' + 'x'.repeat(243) });
  assert.equal(valid.workspaceId.length, 256);
  const reserve = reserveRequest(valid), finish = finalizeRequest(valid, reserve);
  assert.deepEqual(await call('reserve', reserve), expectedAck(valid, 'reserve', reserve, false));
  assert.deepEqual(await call('finalize', finish), expectedAck(valid, 'finalize', finish, false));
});

test('transaction fingerprint hashes exact request text including harmless decimal spellings and whitespace', async () => {
  const f = await fixture(), r = reserveRequest(f);
  const raw = JSON.stringify(r).replace('"revenue":25.5', '"revenue":25.5000');
  assert.deepEqual(await call('reserve', raw), expectedAck(f, 'reserve', raw, false));
  assert.deepEqual(await call('reserve', raw), expectedAck(f, 'reserve', raw, true));
  await assert.rejects(call('reserve', JSON.stringify(r)), rejected());
  await assert.rejects(call('reserve', raw + ' '), rejected());
  assert.deepEqual(await state(f), r.state);
  assert.deepEqual(await retainedRows(f), { admissions: 1, receipts: 0 });
});

test('independent concurrent retries produce exactly one durable admission and one final receipt', async () => {
  const f = await fixture(), reserve = reserveRequest(f), finish = finalizeRequest(f, reserve);
  const c1 = await connect(), c2 = await connect();
  try {
    for (const [kind, request] of [['reserve', reserve], ['finalize', finish]]) {
      const results = await Promise.all([call(kind, request, c1), call(kind, request, c2)]);
      assert.equal(results.filter(r => r.replayed).length, 1);
      for (const ack of results) assert.deepEqual(ack, expectedAck(f, kind, request, ack.replayed));
    }
  } finally { await close(c1); await close(c2); }
  assert.deepEqual(await retainedRows(f), { admissions: 1, receipts: 1 });
  assert.equal((await quota('tenant:' + f.workspaceId)).attempts, 1);
});

test('same transaction retries and lost ACK lookup survive a later workspace revision without replaying writes', async () => {
  const f = await fixture(), reserve = reserveRequest(f), finish = finalizeRequest(f, reserve);
  await call('reserve', reserve); await call('finalize', finish);
  const newer = { ...await state(f), _revision: randomUUID(), laterGenericChange: { keep: 12.25 } };
  await setState(f, newer);
  for (const [kind, request] of [['reserve', reserve], ['finalize', finish]]) {
    assert.deepEqual(await lookup(f, kind, request), expectedAck(f, kind, request, true));
    assert.deepEqual(await call(kind, request), expectedAck(f, kind, request, true));
  }
  assert.deepEqual(await state(f), newer);
  assert.deepEqual(await retainedRows(f), { admissions: 1, receipts: 1 });
  for (const override of [{ workspaceId: 'foreign' }, { attemptId: 'content_attempt_' + '0'.repeat(64) }]) {
    assert.equal(await lookup(f, 'finalize', finish, override), null);
  }
  for (const override of [{ actorId: 'stranger' }, { sessionVersion: 2 }, { fingerprint: '0'.repeat(64) }]) {
    await assert.rejects(lookup(f, 'finalize', finish, override), rejected(['P0R03', 'P0R04']));
  }
  const changed = structuredClone(finish); changed.state.laterGenericChange = true;
  await assert.rejects(call('finalize', changed), rejected());
  assert.deepEqual(await state(f), newer);
});

test('reserve and finalize CAS failures roll back counters, admission and receipt as one transaction', async () => {
  const f = await fixture(), reserve = reserveRequest(f);
  const stale = { ...reserve, expectedRevision: randomUUID() };
  const quotaBefore = (await admin.query('SELECT * FROM public.runvara_content_receipt_quotas ORDER BY scope_key')).rows;
  await assert.rejects(call('reserve', stale), rejected());
  assert.deepEqual(await state(f), f.state);
  assert.deepEqual(await retainedRows(f), { admissions: 0, receipts: 0 });
  assert.deepEqual((await admin.query('SELECT * FROM public.runvara_content_receipt_quotas ORDER BY scope_key')).rows, quotaBefore);
  await call('reserve', reserve);
  const finish = finalizeRequest(f, reserve, { expectedRevision: randomUUID() });
  await assert.rejects(call('finalize', finish), rejected());
  assert.deepEqual(await retainedRows(f), { admissions: 1, receipts: 0 });
  assert.deepEqual(await state(f), reserve.state);
  assert.equal(await lookup(f, 'finalize', finish), null);
});

test('reserve and finalize revision fences require exact lowercase UUIDs before charging or changing state', async () => {
  for (const kind of ['reserve', 'finalize']) {
    const f = await fixture(), reserve = reserveRequest(f);
    if (kind === 'finalize') await call('reserve', reserve);
    const request = kind === 'reserve' ? reserve : finalizeRequest(f, reserve);
    const beforeState = await state(f), beforeRows = await retainedRows(f), beforeQuota = await quota('global');
    for (const field of ['expectedRevision', 'nextRevision']) {
      for (const invalid of ['r'.repeat(160), 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE']) {
        const forged = structuredClone(request); forged[field] = invalid;
        if (field === 'nextRevision') forged.state._revision = invalid;
        await assert.rejects(call(kind, forged), rejected('P0R01'));
        assert.deepEqual(await state(f), beforeState);
        assert.deepEqual(await retainedRows(f), beforeRows);
        assert.deepEqual(await quota('global'), beforeQuota);
      }
    }
  }
});

test('candidate-only approval promotion cannot replace the locked prior authorization', async () => {
  const f = await fixture(), prior = structuredClone(f.state);
  prior.approvals[0].status = 'pending';
  delete prior.approvals[0].decidedBy; delete prior.approvals[0].decidedAt;
  await setState(f, prior);
  const r = reserveRequest(f, { state: prior });
  r.state.approvals[0] = structuredClone(f.approval);
  assert.equal(r.sourceTemplate.context.approval.status, 'approved');
  const beforeQuota = await quota('global');
  await assert.rejects(call('reserve', r), rejected(['P0O01', 'P0R01']));
  assert.deepEqual(await state(f), prior);
  assert.deepEqual(await retainedRows(f), { admissions: 0, receipts: 0 });
  assert.equal(await quota('tenant:' + f.workspaceId), undefined);
  assert.deepEqual(await quota('global'), beforeQuota);
});

test('a workspace update failure cannot leave a detached admission or confirmed receipt', async () => {
  const f = await fixture(), reserve = reserveRequest(f);
  await admin.query(`CREATE FUNCTION public.content_receipt_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P0T04',MESSAGE='synthetic workspace rollback'; END $$;
    CREATE TRIGGER zz_content_receipt_test_failure BEFORE UPDATE ON public.saas_workspace_state FOR EACH ROW EXECUTE FUNCTION public.content_receipt_test_failure()`);
  try {
    await assert.rejects(call('reserve', reserve), rejected('P0T04'));
    assert.deepEqual(await retainedRows(f), { admissions: 0, receipts: 0 });
    assert.deepEqual(await state(f), f.state);
  } finally { await admin.query('DROP TRIGGER zz_content_receipt_test_failure ON public.saas_workspace_state'); }
  await call('reserve', reserve);
  await admin.query('CREATE TRIGGER zz_content_receipt_test_failure BEFORE UPDATE ON public.saas_workspace_state FOR EACH ROW EXECUTE FUNCTION public.content_receipt_test_failure()');
  try {
    await assert.rejects(call('finalize', finalizeRequest(f, reserve)), rejected('P0T04'));
    assert.deepEqual(await retainedRows(f), { admissions: 1, receipts: 0 });
    assert.deepEqual(await state(f), reserve.state);
  } finally { await admin.query('DROP TRIGGER zz_content_receipt_test_failure ON public.saas_workspace_state; DROP FUNCTION public.content_receipt_test_failure()'); }
});

test('unknown and known rejection retain their charge and preserve frozen claim and intent', async () => {
  for (const status of ['uncertain', 'failed']) {
    const f = await fixture(), r = reserveRequest(f); await call('reserve', r);
    const rejectedState = { ...structuredClone(r.state), _revision: randomUUID() };
    rejectedState.connectionWrites[0].status = status;
    rejectedState.connectionWrites[0].errorCode = status === 'uncertain' ? 'PROVIDER_OUTCOME_UNKNOWN' : 'PROVIDER_REJECTED';
    await setState(f, rejectedState);
    assert.deepEqual(await state(f), rejectedState);
    assert.deepEqual(await retainedRows(f), { admissions: 1, receipts: 0 });
    assert.equal(await lookup(f, 'finalize', finalizeRequest(f, r)), null);
    for (const mutate of [s => { s.connectionWrites[0].input.title += ' forged'; },
      s => { s.connectionWrites[0].id += '-renamed'; },
      s => { s.connectionWrites[0].provider = 'email'; },
      s => { s.connectionWrites[0].input.operation = 'product_price'; },
      s => { s.connectionWrites[0].dispatchClaim.identity = '0'.repeat(64); },
      s => { s.connectionWrites[0].dispatchClaim.phases = {}; },
      s => { s.connectionWrites = []; }]) {
      const forged = structuredClone(rejectedState); mutate(forged);
      await assert.rejects(setState(f, forged), rejected());
      assert.deepEqual(await state(f), rejectedState);
    }
  }
});

test('legacy and mixed-version raw PATCH cannot manufacture protected phases, completions, or removal', async () => {
  const f = await fixture(), reserve = reserveRequest(f), finish = finalizeRequest(f, reserve);
  await assert.rejects(setState(f, reserve.state), rejected());
  await assert.rejects(setState(f, finish.state), rejected());
  await call('reserve', reserve);
  await assert.rejects(setState(f, finish.state), rejected());
  await call('finalize', finish);
  for (const mutate of [s => { s.connectionWrites[0].result.externalId = 'gid://shopify/Product/999'; },
    s => { s.connectionWrites[0].completedAt = '2026-01-01T00:00:03.000Z'; },
    s => { s.connectionWrites[0].status = 'approved'; }, s => { s.connectionWrites = []; }]) {
    const forged = structuredClone(finish.state); mutate(forged);
    await assert.rejects(setState(f, forged), rejected());
    assert.deepEqual(await state(f), finish.state);
  }
  for (const table of ['saas_workspace_state', 'workspaces']) {
    await using('service_role', c => assert.rejects(c.query(`DELETE FROM public.${table} WHERE ${table === 'workspaces' ? 'id' : 'workspace_id'}=$1`, [f.workspaceId]), rejected()));
  }
  await using('service_role', async c => {
    await c.query("SELECT set_config('runvara.content_receipt_bypass','on',false)");
    await assert.rejects(c.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1', [f.workspaceId, reserve.state]), rejected());
  });
});

test('generic, unrelated non-content, and targeted reporting updates remain available', async () => {
  const f = await fixture(), r = reserveRequest(f); await call('reserve', r);
  const generic = { ...await state(f), _revision: randomUUID(), ordinaryDecimals: { revenue: 123.456789, ratio: 1e-12 } };
  generic.connectionWrites.push({ id: 'unrelated-email', provider: 'email', input: { operation: 'send_message' }, status: 'completed', result: { id: 'synthetic' } });
  await setState(f, generic);
  assert.deepEqual(await state(f), generic);
  const report = { status: 'connected', detail: 'Synthetic reporting refresh.', lastSyncAt: '2026-10-08T10:00:00.000Z', lastFailureAt: null, lastError: null, failures: [] };
  const nextRevision = randomUUID();
  const rows = await using('service_role', c => c.query('SELECT * FROM public.runvara_commit_reporting_status($1,$2,$3,$4::jsonb,$5::timestamptz)',
    [f.workspaceId, generic._revision, nextRevision, report, '2026-10-08T10:00:00.000Z']));
  assert.deepEqual(rows.rows, [{ workspace_id: f.workspaceId }]);
  assert.deepEqual(await state(f), { ...generic, _revision: nextRevision, integrationStatus: { ...generic.integrationStatus, reporting: report } });
});

test('optional mutable observation cannot modify the separately protected final receipt', async () => {
  const f = await fixture(), r = reserveRequest(f), finish = finalizeRequest(f, r);
  await call('reserve', r); await call('finalize', finish);
  const changed = structuredClone(finish.state); delete changed.connectionWrites[0].recordedActionContext;
  changed._revision = randomUUID(); await setState(f, changed);
  assert.deepEqual((await admin.query('SELECT receipt FROM public.runvara_content_receipts WHERE workspace_id=$1', [f.workspaceId])).rows[0].receipt, f.receipt);
  assert.deepEqual(await lookup(f, 'finalize', finish), expectedAck(f, 'finalize', finish, true));
});

test('direct protected table access, helpers, deletion, cascade and truncate remain closed', async () => {
  for (const role of ['service_role', 'anon', 'authenticated']) {
    await using(role, async c => {
      await assert.rejects(c.query('SET ROLE postgres'), rejected('42501'));
      for (const table of TABLES) {
        for (const sql of [`SELECT * FROM public.${table}`, `DELETE FROM public.${table}`, `TRUNCATE public.${table}`]) {
          await assert.rejects(c.query(sql), rejected('42501'));
        }
      }
      if (role !== 'service_role') for (const kind of ['reserve', 'finalize']) await assert.rejects(call(kind, '{}', c), rejected('42501'));
    });
  }
  const f = await fixture(), r = reserveRequest(f); await call('reserve', r); await call('finalize', finalizeRequest(f, r));
  for (const table of ['runvara_content_admissions', 'runvara_content_receipts']) {
    for (const sql of [`UPDATE public.${table} SET request_fingerprint='${'0'.repeat(64)}' WHERE workspace_id=$1`, `DELETE FROM public.${table} WHERE workspace_id=$1`]) {
      await assert.rejects(admin.query(sql, [f.workspaceId]), rejected());
    }
    await assert.rejects(admin.query(`TRUNCATE public.${table}`), rejected());
  }
  await assert.rejects(admin.query('DELETE FROM public.workspaces WHERE id=$1', [f.workspaceId]), rejected());
  assert.deepEqual(await retainedRows(f), { admissions: 1, receipts: 1 });
  await assertSecurity();
});

test('bounds reject malformed or oversized envelopes before charging and retain exact canonical source limit', async () => {
  const f = await fixture(), r = reserveRequest(f);
  for (const mutate of [q => { q.admission.digest = '0'.repeat(64); }, q => { q.admission.extra = 'x'; },
    q => { q.admission.actorSessionVersion = 9007199254740992; }, q => { q.sourceTemplate.context.completedAt = '2026-01-01T00:00:03.000Z'; },
    q => { q.admission.actorId = 'stranger'; }, q => { q.sourceTemplate.input.title += ' tampered'; },
    q => { q.admission = { ...q.admission, padding: 'x'.repeat(4096) }; },
    q => { q.state.workspace.id = 'foreign'; }, q => { q.unknown = true; }]) {
    const forged = structuredClone(r); mutate(forged);
    await assert.rejects(call('reserve', forged), rejected());
    assert.deepEqual(await retainedRows(f), { admissions: 0, receipts: 0 });
    assert.deepEqual(await state(f), f.state);
  }
  await assert.rejects(call('reserve', ' '.repeat(REQUEST_BYTES + 1)), rejected());
  const empty = action(f.workspaceId, { description: '' });
  const room = 24576 - Buffer.byteLength(canonical(empty.sourceAction));
  const exact = action(f.workspaceId, { description: '雪'.repeat(Math.floor(room / 3)) + 'x'.repeat(room % 3) });
  assert.equal(Buffer.byteLength(canonical(exact.sourceAction)), 24576);
  assert.deepEqual((await admin.query('SELECT public.runvara_outcome_validate_source_action($1::jsonb,$2) source', [exact.sourceAction, f.workspaceId])).rows[0].source, exact.sourceAction);
  const over = action(f.workspaceId, { description: exact.sourceAction.input.description + 'x' });
  await assert.rejects(admin.query('SELECT public.runvara_outcome_validate_source_action($1::jsonb,$2)', [over.sourceAction, f.workspaceId]), rejected());
  const sizes = (await admin.query('SELECT octet_length($1::jsonb::text) admission,octet_length($2::jsonb::text) receipt,octet_length($3::jsonb::text) source', [f.admission, f.receipt, exact.sourceAction])).rows[0];
  assert.ok(sizes.admission <= 4096); assert.ok(sizes.receipt <= 36864); assert.ok(sizes.source <= 32768);
  console.log('CONTENT_RECEIPT_BOUNDS=' + JSON.stringify({ sourceCanonical: 24576, sourceJsonb: sizes.source,
    admissionJsonb: sizes.admission, receiptJsonb: sizes.receipt, requestMax: REQUEST_BYTES,
    sourceJsonbMax: 32768, admissionMax: 4096, receiptMax: 36864, reservedBytes: RESERVED_BYTES }));
  const max = await fixture({ description: exact.sourceAction.input.description });
  assert.equal(Buffer.byteLength(canonical(max.sourceAction)), 24576);
  const maxReserve = reserveRequest(max), maxFinish = finalizeRequest(max, maxReserve);
  await call('reserve', maxReserve); await call('finalize', maxFinish);
  assert.deepEqual((await admin.query('SELECT receipt FROM public.runvara_content_receipts WHERE workspace_id=$1', [max.workspaceId])).rows[0].receipt, max.receipt);
});

test('exact maximum request envelope and independent admission/receipt JSONB storage bounds are enforced', async () => {
  const f = await fixture(), r = reserveRequest(f), encoded = JSON.stringify(r);
  const raw = encoded + ' '.repeat(REQUEST_BYTES - Buffer.byteLength(encoded));
  assert.equal(Buffer.byteLength(raw), REQUEST_BYTES);
  assert.deepEqual(await call('reserve', raw), expectedAck(f, 'reserve', raw, false));
  await assert.rejects(call('reserve', raw + ' '), rejected('P0R01'));
  assert.deepEqual(await lookup(f, 'reserve', raw), expectedAck(f, 'reserve', raw, true));
  const emptyBytes = (await admin.query("SELECT octet_length('{\"padding\":\"\"}'::jsonb::text) n")).rows[0].n;
  for (const [table, field, limit] of [['runvara_content_admissions', 'admission', 4096], ['runvara_content_receipts', 'receipt', 36864]]) {
    for (const extra of [0, 1]) {
      const doc = { padding: 'x'.repeat(limit + extra - emptyBytes) };
      assert.equal((await admin.query('SELECT octet_length($1::jsonb::text) n', [doc])).rows[0].n, limit + extra);
      await admin.query('BEGIN');
      try {
        // Isolate the table-level size backstop with synthetic administrator
        // bytes, not a valid signed record. Always rolled back; app access stays
        // denied, and all successful RPC fixtures use fully validated records.
        const insert = table === 'runvara_content_admissions'
          ? admin.query(`INSERT INTO public.runvara_content_admissions(workspace_id,attempt_id,write_id,admission,request_fingerprint,expected_revision,commit_revision,write_identity_digest)
              VALUES($1,$2,'size-boundary-only',$3,$4,$5,$6,$4)`, [f.workspaceId, 'content_attempt_' + 'f'.repeat(64), doc, 'a'.repeat(64), randomUUID(), randomUUID()])
          : admin.query(`INSERT INTO public.runvara_content_receipts(workspace_id,attempt_id,receipt,request_fingerprint,expected_revision,commit_revision,final_projection_digest)
              VALUES($1,$2,$3,$4,$5,$6,$4)`, [f.workspaceId, f.admission.attemptId, doc, 'a'.repeat(64), randomUUID(), randomUUID()]);
        if (extra) await assert.rejects(insert, rejected('23514')); else assert.equal((await insert).rowCount, 1);
      } finally { await admin.query('ROLLBACK'); }
    }
  }
  assert.deepEqual(await retainedRows(f), { admissions: 1, receipts: 0 });
  console.log('CONTENT_RECEIPT_EXACT_BOUNDARIES=' + JSON.stringify({ requestUtf8: REQUEST_BYTES, admissionJsonb: 4096,
    receiptJsonb: 36864, oneByteOverRejected: true, tableBackstopProbesRolledBack: true }));
});

test('raw workspace state boundary accepts 2097151 bytes and rejects 2097152 before charging', async () => {
  for (const bytes of [2097151, 2097152]) {
    const f = await fixture(), r = reserveRequest(f);
    r.state.boundaryPadding = '';
    r.state.boundaryPadding = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(r.state)));
    const raw = JSON.stringify(r);
    assert.equal(Buffer.byteLength(JSON.stringify(r.state)), bytes);
    assert.ok(Buffer.byteLength(raw) < REQUEST_BYTES);
    if (bytes === 2097151) {
      assert.deepEqual(await call('reserve', raw), expectedAck(f, 'reserve', raw, false));
      assert.deepEqual(await state(f), r.state);
      assert.deepEqual(await retainedRows(f), { admissions: 1, receipts: 0 });
    } else {
      const beforeQuota = await quota('global');
      await assert.rejects(call('reserve', raw), rejected('P0R01'));
      assert.deepEqual(await state(f), f.state);
      assert.deepEqual(await retainedRows(f), { admissions: 0, receipts: 0 });
      assert.equal(await quota('tenant:' + f.workspaceId), undefined);
      assert.deepEqual(await quota('global'), beforeQuota);
    }
  }
  console.log('CONTENT_RECEIPT_RAW_STATE_BOUNDARY=' + JSON.stringify({ accepted: 2097151, rejected: 2097152,
    countedOriginalJsonUtf8: true, candidateOnlyApprovalPromotionRejected: true }));
});

test('schema reapply preserves closed grants, enforcement, and immutable retained evidence', async () => {
  const f = await fixture(), r = reserveRequest(f), finish = finalizeRequest(f, r);
  await call('reserve', r); await call('finalize', finish);
  // Reproduce an old schema's blanket grant only in this disposable fixture.
  await admin.query('GRANT SELECT,INSERT,UPDATE,DELETE ON public.runvara_content_receipt_control,public.runvara_content_receipt_quotas,public.runvara_content_admissions,public.runvara_content_receipts TO service_role');
  try {
    await using('service_role', async c => {
      await assert.rejects(c.query("UPDATE public.runvara_content_receipt_control SET mode='paused' WHERE id"), rejected('P0R06'));
      await assert.rejects(c.query("UPDATE public.runvara_content_receipt_quotas SET quota=jsonb_build_object('schema','runvara-content-receipt-quota/v1','attempts',(quota->>'attempts')::int+1,'reservedBytes',((quota->>'attempts')::int+1)*40960) WHERE scope_key='global'"), rejected('P0R06'));
      for (const table of ['runvara_content_admissions', 'runvara_content_receipts']) {
        await assert.rejects(c.query(`INSERT INTO public.${table} SELECT * FROM public.${table} WHERE workspace_id=$1`, [f.workspaceId]), rejected('P0R06'));
        await assert.rejects(c.query(`UPDATE public.${table} SET request_fingerprint=$2 WHERE workspace_id=$1`, [f.workspaceId, '0'.repeat(64)]), rejected('P0R06'));
        await assert.rejects(c.query(`DELETE FROM public.${table} WHERE workspace_id=$1`, [f.workspaceId]), rejected('P0R06'));
      }
    });
  } finally { await admin.query(baseline); }
  assert.deepEqual(await assertSecurity(), securityBefore);
  assert.equal((await admin.query('SELECT mode FROM public.runvara_content_receipt_control WHERE id')).rows[0].mode, 'enforced');
  assert.deepEqual(await lookup(f, 'finalize', finish), expectedAck(f, 'finalize', finish, true));
  assert.deepEqual(await state(f), finish.state);
  assert.deepEqual(await roles(), roleStateBefore);
});

test('paused rollout denies new admissions while preserving exact reconciliation of charged work', async () => {
  const f = await fixture(), r = reserveRequest(f), finish = finalizeRequest(f, r);
  await call('reserve', r); await call('finalize', finish);
  const pending = await fixture();
  await admin.query("UPDATE public.runvara_content_receipt_control SET mode='paused' WHERE id");
  try {
    await assert.rejects(call('reserve', reserveRequest(pending)), rejected());
    assert.deepEqual(await lookup(f, 'finalize', finish), expectedAck(f, 'finalize', finish, true));
    assert.deepEqual(await retainedRows(pending), { admissions: 0, receipts: 0 });
  } finally { await admin.query("UPDATE public.runvara_content_receipt_control SET mode='enforced' WHERE id"); }
});

test('tenant last-slot concurrency enforces 256 attempts without admitting a 257th claim', async () => {
  const f = await fixture(), first = reserveRequest(f); await call('reserve', first);
  await seedCounter('tenant:' + f.workspaceId, 255);
  function additional(id) {
    const a = action(f.workspaceId, { id });
    a.write.requestId = 'synthetic_request_' + id;
    a.sourceAction.context.requestId = a.write.requestId;
    a.approval.id = 'approval-' + id;
    a.write.approvalId = a.approval.id;
    a.sourceAction.context.approval.id = a.approval.id;
    a.sourceAction.context.approval = sign(a.sourceAction.context.approval);
    const identity = Object.fromEntries(['id', 'requestId', 'provider', 'input', 'digest', 'connectionId', 'account',
      'requestedBy', 'requiresApproval', 'approvalId'].map(k => [k, a.write[k]]));
    a.write.dispatchClaim.identity = rawHash(JSON.stringify(identity));
    a.sourceAction.context.claimIdentity = a.write.dispatchClaim.identity;
    a.sourceAction = sign(a.sourceAction);
    a.write.recordedActionContext = { ...structuredClone(a.sourceAction.context), snapshotDigest: a.sourceAction.digest };
    return Object.assign({ workspaceId: f.workspaceId, ...a }, descriptor({ workspaceId: f.workspaceId, ...a }));
  }
  const a = additional('tenant-last-a'), b = additional('tenant-last-b'), ready = await state(f);
  for (const next of [a, b]) {
    const w = structuredClone(next.write); w.status = 'executing'; w.dispatchClaim.phases = {};
    delete w.result; delete w.completedAt; delete w.recordedActionContext;
    ready.connectionWrites.push(w); ready.approvals.push(next.approval);
  }
  ready._revision = randomUUID(); await setState(f, ready);
  const ra = reserveRequest(a, { state: ready }), rb = reserveRequest(b, { state: ra.state });
  const c1 = await connect(), c2 = await connect();
  try {
    await c1.query('BEGIN');
    const admitted = await call('reserve', ra, c1);
    const pid2 = (await c2.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const pb = call('reserve', rb, c2), denied = assert.rejects(pb, rejected('P0R05')); await blocked(pid2);
    await c1.query('COMMIT');
    assert.deepEqual(admitted, expectedAck(a, 'reserve', ra, false)); await denied;
    assert.deepEqual(await retainedRows(f), { admissions: 2, receipts: 0 });
    assert.deepEqual(await quota('tenant:' + f.workspaceId), { schema: 'runvara-content-receipt-quota/v1', attempts: 256, reservedBytes: 256 * RESERVED_BYTES });
    assert.deepEqual(await state(f), ra.state);
  } finally { await c1.query('ROLLBACK'); await close(c1); await close(c2); }
});

test('global last-slot concurrency enforces 1024 attempts with no metadata for the denied tenant', async () => {
  await seedCounter('global', 1023);
  const a = await fixture(), b = await fixture(), ra = reserveRequest(a), rb = reserveRequest(b);
  const holder = await connect('postgres'), c1 = await connect(), c2 = await connect();
  try {
    await holder.query('BEGIN'); await holder.query("SELECT 1 FROM public.runvara_content_receipt_quotas WHERE scope_key='global' FOR UPDATE");
    const pid1 = (await c1.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const pid2 = (await c2.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const pa = call('reserve', ra, c1); await blocked(pid1);
    const pb = call('reserve', rb, c2), outcomes = Promise.allSettled([pa, pb]); await blocked(pid2);
    await holder.query('COMMIT');
    const results = await outcomes;
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const deniedIndex = results.findIndex(r => r.status === 'rejected');
    assert.equal(results[deniedIndex].reason.code, 'P0R05');
    const denied = [a, b][deniedIndex], allowed = [a, b][1 - deniedIndex];
    assert.deepEqual(await quota('global'), { schema: 'runvara-content-receipt-quota/v1', attempts: 1024, reservedBytes: 1024 * RESERVED_BYTES });
    assert.equal(await quota('tenant:' + denied.workspaceId), undefined);
    assert.deepEqual(await retainedRows(denied), { admissions: 0, receipts: 0 });
    assert.deepEqual(await state(denied), denied.state);
    assert.equal((await quota('tenant:' + allowed.workspaceId)).attempts, 1);
    await assert.rejects(call('reserve', reserveRequest(denied)), rejected('P0R05'));
    assert.equal(await quota('tenant:' + denied.workspaceId), undefined);
    console.log('CONTENT_RECEIPT_CAPACITY=' + JSON.stringify({ tenantCeiling: 256, globalCeiling: 1024,
      exactLocalConcurrentLoserSqlstate: 'P0R05', deniedTenantMetadataRows: 0,
      boundaryCounterSetup: 'synthetic administrator +1 increments; no trigger bypass, decrease, or reclamation' }));
  } finally { await holder.query('ROLLBACK'); await close(holder); await close(c1); await close(c2); }
});

test('actual local JSONB, heap, TOAST and index sizes remain observable with explicit retained row counts', async () => {
  const relations = (await admin.query(`SELECT c.relname,pg_relation_size(c.oid)::bigint heap_bytes,
    pg_indexes_size(c.oid)::bigint index_bytes,pg_total_relation_size(c.oid)::bigint total_bytes,
    CASE WHEN c.reltoastrelid=0 THEN 0 ELSE pg_total_relation_size(c.reltoastrelid) END::bigint toast_bytes
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY($1::text[]) ORDER BY c.relname`, [TABLES])).rows;
  const admissions = (await admin.query('SELECT count(*)::int rows,coalesce(sum(octet_length(admission::text)),0)::bigint jsonb_text_bytes,coalesce(sum(pg_column_size(admission)),0)::bigint stored_value_bytes FROM public.runvara_content_admissions')).rows[0];
  const receipts = (await admin.query('SELECT count(*)::int rows,coalesce(sum(octet_length(receipt::text)),0)::bigint jsonb_text_bytes,coalesce(sum(pg_column_size(receipt)),0)::bigint stored_value_bytes FROM public.runvara_content_receipts')).rows[0];
  assert.ok(admissions.rows >= receipts.rows && receipts.rows > 0);
  for (const row of relations) assert.ok(BigInt(row.total_bytes) >= BigInt(row.index_bytes) + BigInt(row.heap_bytes));
  console.log('CONTENT_RECEIPT_LOCAL_STORAGE=' + JSON.stringify({ relations, admissions, receipts,
    limits: { tenantAttempts: 256, globalAttempts: 1024, bytesPerAttempt: RESERVED_BYTES },
    productionMeasurement: false, indexAndTupleOverheadIncludedInRelations: true }));
});
