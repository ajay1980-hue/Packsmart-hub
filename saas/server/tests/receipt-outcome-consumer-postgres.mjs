/**
 * Explicit disposable PostgreSQL 17 proof of the receipt-to-outcome consumer.
 * Deliberately outside *.test.mjs. No provider, Supabase, deployment, or account
 * connection is used. All roles, grants, fixtures, and activation are local.
 */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { canonical, hash, actionFixture, linkedMeasurement, sourceMeasurement, resign, request, parameters, callSql } from './business-outcome-postgres-fixture.mjs';
import { BUSINESS_OUTCOME_CURRENCIES } from '../lib/business-outcomes.mjs';
import { objectivePublicationFixture } from './objective-publication-fixture.mjs';

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
let consumerMigration;
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
function rejected(code = ['P0R01', 'P0R02', 'P0R03', 'P0R04', 'P0R05', 'P0R06', 'P0R07', 'P0O01', 'P0O03', 'P0O04', 'P0O06', 'P0O07', 'P0O10', '23503', '0A000']) { return error => {
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
  f.experimentId = 'experiment-one';
  f.state.revenueEngine = { experiments: [{ id: f.experimentId, title: 'Synthetic receipt experiment', status: 'measured' }] };
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
  const database = 'runvara_receipt_consumer_test_' + randomUUID().replaceAll('-', '');
  assert.match(database, /^runvara_receipt_consumer_test_[a-f0-9]{32}$/);
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
  consumerMigration = await readFile(new URL('../supabase/migrations/20261008163558_receipt_outcome_consumer.sql', import.meta.url), 'utf8');
  await admin.query(consumerMigration);
  assert.deepEqual(await assertSecurity(), securityBefore);
  assert.equal((await admin.query('SELECT mode FROM public.runvara_content_receipt_control WHERE id')).rows[0].mode, 'prepared');
  await admin.query("UPDATE public.runvara_content_receipt_control SET mode='enforced' WHERE id");
  assert.deepEqual(await roles(), roleStateBefore, 'Receipt migration never creates/expands roles');
  console.log('CONTENT_RECEIPT_SAFETY=' + JSON.stringify({ ...info, host: admin.connection.stream.remoteAddress,
    emptyAtStart: true, syntheticLocalRoles: true, applicationConnections: 0, providerSubmissions: 0 }));
}, { timeout: 30000 });
after(async () => {
  try {
    await Promise.all([...clients].map(close));
    if (createdDatabase) {
      assert.match(createdDatabase, /^runvara_receipt_consumer_test_[a-f0-9]{32}$/);
      await baseAdmin.query('DROP DATABASE ' + createdDatabase);
      assert.equal((await baseAdmin.query('SELECT 1 FROM pg_database WHERE datname=$1', [createdDatabase])).rowCount, 0);
      console.log('CONTENT_RECEIPT_DATABASE_CLEANUP=' + JSON.stringify({ droppedCreatedDatabase: createdDatabase, predecessorDatabaseUnchanged: 'runvara_outcome_test' }));
    }
  } finally { if (baseAdmin) await baseAdmin.end(); }
});

const selectorFor = f => ({ attemptId: f.admission.attemptId, receiptDigest: f.receipt.digest, sourceDigest: f.sourceAction.digest });
const referenceFor = f => ({ schema: 'runvara-protected-content-source/v1', workspaceId: f.workspaceId, ...selectorFor(f), commitRevision: f.commitRevision });
async function review(f, { actorId = 'owner', sessionVersion = 1, selector = null, after = null, resolveSaved = true } = {}, c) {
  if (!c) return using('service_role', c => review(f, { actorId, sessionVersion, selector, after, resolveSaved }, c));
  return (await c.query('SELECT public.runvara_read_outcome_content_sources($1,$2,$3,$4::bigint,$5::jsonb,$6,$7::boolean) result',
    [f.workspaceId, f.experimentId, actorId, sessionVersion, selector, after, resolveSaved])).rows[0].result;
}
async function publish(r, c) {
  if (!c) return using('service_role', c => publish(r, c));
  return (await c.query(callSql, parameters(r))).rows[0].receipt;
}
function protectedMeasurement(f, options = {}) {
  const m = linkedMeasurement(f.workspaceId, f.experimentId, f.sourceAction, options);
  m.schema = 'runvara-experiment-measurement/v4'; m.report.schema = 'runvara-measurement-report/v4';
  if (f.sourceAction.schema === 'runvara-reviewed-source-action/v2') {
    m.intervention = { ...m.intervention, schema: 'runvara-owner-action-association/v2', origin: 'owner_objective_content',
      originatingObjective: structuredClone(f.sourceAction.context.originatingObjective) };
    m.recordedAt = m.report.recordedAt = new Date().toISOString();
  }
  m.receiptSource = referenceFor(f); m.report.facts.receiptSource = structuredClone(m.receiptSource);
  m.report.facts.intervention = structuredClone(m.intervention);
  return resign(m);
}
async function saveMeasurement(f, source = protectedMeasurement(f)) {
  const next = await state(f); next._revision = randomUUID(); next.revenueEngine.experiments[0].outcomeMeasurement = source;
  await setState(f, next); f.state = next; f.source = source; return source;
}
async function completed(options = {}) {
  const f = await fixture(options), r = reserveRequest(f), finish = finalizeRequest(f, r);
  await call('reserve', r); await call('finalize', finish); f.commitRevision = finish.nextRevision; f.state = finish.state;
  return f;
}
async function storedVersion(f, versionId) {
  return (await admin.query('SELECT * FROM public.runvara_business_outcome_versions WHERE workspace_id=$1 AND version_id=$2', [f.workspaceId, versionId])).rows[0];
}
async function assertConsumerSecurity() {
  const functions = (await admin.query(`SELECT p.proname,p.prosecdef,p.proconfig,
    has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
    has_function_privilege('service_role',p.oid,'EXECUTE') service,
    EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) WHERE grantee=0 AND privilege_type='EXECUTE') public
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY($1::text[]) ORDER BY p.proname`,
    [['runvara_outcome_validate_receipt_reference','runvara_outcome_validate_receipt_selector','runvara_outcome_validate_receipt_association','runvara_outcome_validate_content_rows',
      'runvara_outcome_content_reference','runvara_outcome_content_evidence','runvara_read_outcome_content_sources']])).rows;
  assert.equal(functions.length, 7);
  for (const f of functions) {
    assert.equal(f.anon, false); assert.equal(f.authenticated, false); assert.equal(f.public, false);
    assert.equal(f.service, f.proname === 'runvara_read_outcome_content_sources');
    assert.equal(f.prosecdef, f.proname === 'runvara_read_outcome_content_sources');
    assert.ok(f.proconfig.includes('search_path=""'));
  }
  assert.ok(functions.find(f => f.service).proconfig.includes('statement_timeout=5s'));
  assert.equal((await admin.query("SELECT prosecdef FROM pg_proc WHERE oid='public.runvara_read_business_outcome_review(text,text)'::regprocedure")).rows[0].prosecdef, false);
  assert.deepEqual(await assertSecurity(), securityBefore);
  return functions;
}

test('new service reader has current authority and no direct ledger or helper access', async () => {
  await assertConsumerSecurity();
  for (const role of ['anon','authenticated']) await using(role, c => assert.rejects(review({ workspaceId: 'w', experimentId: 'e' }, {}, c), rejected('42501')));
  await using('service_role', async c => {
    for (const table of TABLES) await assert.rejects(c.query('SELECT * FROM public.' + table), rejected('42501'));
    await assert.rejects(c.query('SELECT public.runvara_outcome_content_evidence($1,$2)', ['w', {}]), rejected('42501'));
  });
});

test('protected review and publication survive missing optional context, approval, connection and >500 writes', async () => {
  const f = await completed(), next = await state(f);
  delete next.connectionWrites[0].recordedActionContext; next.approvals = []; next.connections = [];
  next.connectionWrites.push(...Array.from({ length: 501 }, (_, n) => ({ id: 'unrelated-' + n })));
  next._revision = randomUUID(); await setState(f, next);
  const read = await review(f, { selector: selectorFor(f) });
  assert.deepEqual(Object.keys(read).sort(), ['schema','review','receiptChoices','nextCursor','hasMore','selectedEvidence'].sort());
  assert.equal(read.schema, 'runvara-outcome-content-source-reader/v1'); assert.deepEqual(read.review.actionChoices, []);
  assert.deepEqual(read.selectedEvidence, { schema: 'runvara-outcome-content-source-private/v1', admission: f.admission, receipt: f.receipt, commitRevision: f.commitRevision });
  assert.deepEqual(read.receiptChoices[0].receiptSource, referenceFor(f));
  assert.equal(read.hasMore, false); assert.equal(read.nextCursor, null);
  await saveMeasurement(f);
  assert.deepEqual((await review(f)).selectedEvidence, read.selectedEvidence);
  const result = await publish(request(f)), version = await storedVersion(f, result.publication.head.versionId);
  assert.deepEqual(version.source_action, f.sourceAction); assert.deepEqual(version.source_measurement, f.source);
  assert.equal(Buffer.byteLength(JSON.stringify(version.source_measurement)) <= 8192, true);
  console.log('RECEIPT_OUTCOME_EXACT_SOURCE=' + JSON.stringify({ optionalContextAbsent: true, approvalsAbsent: true,
    connectionsAbsent: true, unrelatedWrites: 501, canonicalSourceBytes: Buffer.byteLength(canonical(version.source_action)),
    sourceJsonbBytes: (await admin.query('SELECT octet_length(source_action::text) n FROM public.runvara_business_outcome_versions WHERE version_id=$1', [version.version_id])).rows[0].n }));
});

test('current admin or new owner may review the historical executor; admin cannot publish', async () => {
  const f = await completed(), next = await state(f);
  next.users = [{ id: 'new-owner', role: 'owner', active: true, sessionVersion: 7 }, { id: 'admin', role: 'admin', sessionVersion: 2 }];
  next._revision = randomUUID(); await setState(f, next);
  for (const [actorId, sessionVersion] of [['new-owner', 7], ['admin', 2]]) {
    assert.deepEqual((await review(f, { actorId, sessionVersion, selector: selectorFor(f) })).selectedEvidence.receipt, f.receipt);
  }
  await saveMeasurement(f);
  await assert.rejects(publish(request(f, { actorId: 'admin', sessionVersion: 2 })), rejected('P0O03'));
  assert.equal((await publish(request(f, { actorId: 'new-owner', sessionVersion: 7 }))).publication.head.status, 'published');
});

test('stale role/session, forced password change, aliases and tenant scope fail closed', async () => {
  const f = await completed();
  for (const user of [{ id: 'owner', role: 'viewer', sessionVersion: 1 }, { id: 'owner', role: 'owner', sessionVersion: 2 },
    { id: 'owner', role: 'owner', sessionVersion: 1, active: false }, { id: 'owner', role: 'owner', sessionVersion: null },
    { id: 'owner', role: 'owner', passwordChangeRequired: true }, { id: 'owner', role: 'owner', workspaceId: 'foreign' }]) {
    const next = await state(f); next.users = [user]; next._revision = randomUUID(); await setState(f, next);
    await assert.rejects(review(f, { selector: selectorFor(f) }), rejected());
  }
  const next = await state(f); next.users = [{ id: 'owner', role: 'owner' }, { id: 'owner', role: 'owner' }]; next._revision = randomUUID(); await setState(f, next);
  await assert.rejects(review(f), rejected('P0O03'));
  const foreign = await completed();
  await assert.rejects(review(foreign, { selector: selectorFor(f) }), rejected('P0O01'));
});

test('missing, unresolved and forged exact selectors cannot downgrade into legacy review', async () => {
  const f = await completed();
  for (const selector of [{ ...selectorFor(f), extra: true }, { ...selectorFor(f), sourceDigest: '0'.repeat(64) },
    { ...selectorFor(f), receiptDigest: '0'.repeat(64) }, { ...selectorFor(f), attemptId: 'content_attempt_' + '0'.repeat(64) },
    { ...selectorFor(f), attemptId: selectorFor(f).attemptId.toUpperCase() }, {}, null]) {
    if (selector === null) continue;
    await assert.rejects(review(f, { selector }), rejected('P0O01'));
  }
  await assert.rejects(review(f, { selector: selectorFor(f), after: f.admission.attemptId }), rejected('P0O01'));
  await assert.rejects(review(f, { after: 'invalid' }), rejected('P0O01'));
  const pending = await fixture(); await call('reserve', reserveRequest(pending));
  assert.deepEqual((await review(pending)).receiptChoices, []);
  await assert.rejects(review(pending, { selector: selectorFor(pending) }), rejected('P0O01'));
});

// This synthetic administrator helper is used only for row-binding and finite
// page boundary probes. Main publication fixtures use real reserve/finalize RPCs.
async function seedPageRow(f, id, options = {}) {
  const a = { workspaceId: f.workspaceId, ...action(f.workspaceId, { id, ...options }) }; Object.assign(a, descriptor(a));
  a.commitRevision = randomUUID();
  await admin.query(`INSERT INTO public.runvara_content_admissions(workspace_id,attempt_id,write_id,admission,request_fingerprint,expected_revision,commit_revision,write_identity_digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$5)`, [f.workspaceId, a.admission.attemptId, id, a.admission, 'a'.repeat(64), randomUUID(), randomUUID()]);
  await admin.query(`INSERT INTO public.runvara_content_receipts(workspace_id,attempt_id,receipt,request_fingerprint,expected_revision,commit_revision,final_projection_digest)
    VALUES($1,$2,$3,$4,$5,$6,$4)`, [f.workspaceId, a.admission.attemptId, a.receipt, 'b'.repeat(64), randomUUID(), a.commitRevision]);
  return a;
}

test('explicit finite pages retain whole rows, enforce 16KiB and resolve selections outside the page', async () => {
  const f = await completed(), all = [f];
  for (let i = 0; i < 26; i++) all.push(await seedPageRow(f, 'page-' + i));
  const sorted = all.map(a => a.admission.attemptId).sort(), seen = []; let after = null, pages = 0;
  do {
    const read = await review(f, { after }); pages++;
    assert.ok(read.receiptChoices.length <= 20); assert.ok(Buffer.byteLength(JSON.stringify(read.receiptChoices)) <= 16384);
    assert.ok((await admin.query('SELECT octet_length($1::jsonb::text) n', [JSON.stringify(read.receiptChoices)])).rows[0].n <= 16384);
    seen.push(...read.receiptChoices.map(row => row.receiptSource.attemptId));
    assert.equal(read.hasMore, read.nextCursor !== null);
    if (read.hasMore) assert.equal(read.nextCursor, seen.at(-1));
    after = read.nextCursor;
  } while (after);
  assert.deepEqual(seen, sorted); assert.ok(pages >= 2);
  const last = all.find(a => a.admission.attemptId === sorted.at(-1));
  assert.deepEqual((await review(f, { selector: selectorFor(last) })).selectedEvidence.receipt, last.receipt);
  const exhausted = await review(f, { after: sorted.at(-1) }); assert.deepEqual(exhausted.receiptChoices, []); assert.equal(exhausted.hasMore, false);
  console.log('RECEIPT_OUTCOME_PAGES=' + JSON.stringify({ candidates: all.length, pages, maxRows: 20, maxJsonbBytes: 16384, exactOutsidePage: true }));
});

test('independent immutable-row proof rejects admission, receipt, intent, source and commit tampering', async () => {
  const f = await completed();
  const a = (await admin.query('SELECT to_jsonb(a) row FROM public.runvara_content_admissions a WHERE workspace_id=$1', [f.workspaceId])).rows[0].row;
  const r = (await admin.query('SELECT to_jsonb(r) row FROM public.runvara_content_receipts r WHERE workspace_id=$1', [f.workspaceId])).rows[0].row;
  const validate = (admission, receipt) => admin.query(`SELECT public.runvara_outcome_validate_content_rows(
    jsonb_populate_record(null::public.runvara_content_admissions,$1::jsonb),jsonb_populate_record(null::public.runvara_content_receipts,$2::jsonb),$3)`, [admission, receipt, f.workspaceId]);
  await validate(a, r);
  for (const change of [x => { x.workspace_id = 'foreign'; }, x => { x.attempt_id = 'content_attempt_' + '0'.repeat(64); },
    x => { x.commit_revision = 'not-a-uuid'; }, x => { x.receipt.extra = true; }, x => { x.receipt.observation = 'unresolved'; },
    x => { x.receipt.source.input.title = 'changed'; }, x => { x.receipt.digest = '0'.repeat(64); },
    x => { x.receipt.admissionDigest = '0'.repeat(64); x.receipt = sign(x.receipt); }]) {
    const forged = structuredClone(r); change(forged); await assert.rejects(validate(a, forged), rejected());
  }
  for (const change of [x => { x.write_id = 'other'; }, x => { x.admission.actorId = 'other'; x.admission = sign(x.admission); },
    x => { x.admission.intentDigest = '0'.repeat(64); x.admission = sign(x.admission); }]) {
    const forged = structuredClone(a); change(forged); await assert.rejects(validate(forged, r), rejected());
  }
});

test('v4 rejects commit/reference/source mismatches and preserves unchanged measurement limits', async () => {
  const f = await completed();
  for (const modify of [m => { m.receiptSource.commitRevision = randomUUID(); }, m => { m.receiptSource.workspaceId = 'foreign'; },
    m => { m.receiptSource.sourceDigest = '0'.repeat(64); }, m => { m.receiptSource.extra = true; },
    m => { m.report.facts.receiptSource.receiptDigest = '0'.repeat(64); }, m => { m.schema = 'runvara-experiment-measurement/v3'; },
    m => { m.report.schema = 'runvara-measurement-report/v2'; }]) {
    let m = protectedMeasurement(f); modify(m);
    // Retain a deliberate report-copy mismatch if requested; otherwise both copies change.
    if (m.report.facts.receiptSource.receiptDigest !== '0'.repeat(64)) m.report.facts.receiptSource = structuredClone(m.receiptSource);
    await saveMeasurement(f, resign(m)); await assert.rejects(publish(request(f)), rejected('P0O01'));
  }
  let oversized = protectedMeasurement(f); oversized.report.description = 'x'.repeat(8192); oversized = resign(oversized);
  await saveMeasurement(f, oversized); await assert.rejects(publish(request(f)), rejected('P0O10'));
  const ref = referenceFor(f);
  await assert.rejects(admin.query('SELECT public.runvara_outcome_validate_receipt_reference($1,$2)', [{ ...ref, commitRevision: 'x'.repeat(2048) }, f.workspaceId]), rejected());
});

test('saved v4 current-reference mismatch is rejected and generic CAS never rebases a stale draft', async () => {
  const f = await completed(); await saveMeasurement(f);
  const stale = structuredClone(f.state), next = await state(f); next._revision = randomUUID(); next.otherChange = true; await setState(f, next);
  const update = await using('service_role', c => c.query("UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1 AND state->>'_revision'=$3 RETURNING workspace_id", [f.workspaceId, stale, stale._revision]));
  assert.equal(update.rowCount, 0); assert.equal((await state(f)).otherChange, true);
  const m = protectedMeasurement(f); m.receiptSource.commitRevision = randomUUID(); m.report.facts.receiptSource = structuredClone(m.receiptSource); await saveMeasurement(f, resign(m));
  await assert.rejects(review(f), rejected('P0O01'));
});

async function withoutLedgerLookup(fn) {
  await admin.query('BEGIN');
  try {
    await admin.query(`CREATE OR REPLACE FUNCTION public.runvara_outcome_content_evidence(p_workspace_id text,p_selector jsonb)
      RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P0O01',MESSAGE='UNEXPECTED_LEDGER_LOOKUP'; END $$`);
    await admin.query('SET LOCAL ROLE service_role');
    await fn(admin);
  } finally { await admin.query('ROLLBACK'); }
}

test('identical publication replay precedes source resolution and changed intent conflicts', async () => {
  const f = await completed(); await saveMeasurement(f); const r = request(f), first = await publish(r);
  await withoutLedgerLookup(async c => {
    const replay = await publish(r, c); assert.equal(replay.replayed, true);
    assert.equal(replay.publication.head.versionId, first.publication.head.versionId);
    await assert.rejects(publish({ ...r, measurementDigest: '0'.repeat(64) }, c), rejected('P0O06'));
  });
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.runvara_business_outcome_versions WHERE workspace_id=$1', [f.workspaceId])).rows[0].n, 1);
});

test('protected correction reuse and withdrawal retain exact snapshots without fresh ledger lookup', async () => {
  const f = await completed(); await saveMeasurement(f); const first = await publish(request(f)), head = first.publication.head;
  const original = await storedVersion(f, head.versionId);
  await saveMeasurement(f, protectedMeasurement(f, { revision: 2, amount: '5', reuseVersionId: head.versionId }));
  const correction = request(f, { action: 'correct', headVersionId: head.versionId, headDigest: head.digest });
  await withoutLedgerLookup(async c => {
    const corrected = await publish(correction, c), row = (await c.query('SELECT * FROM public.runvara_business_outcome_versions WHERE version_id=$1', [corrected.publication.head.versionId])).rows[0];
    assert.deepEqual(row.source_action, original.source_action); assert.deepEqual(row.source_measurement.receiptSource, original.source_measurement.receiptSource);
  });
  const corrected = await publish(correction), current = corrected.publication.head;
  await withoutLedgerLookup(async c => {
    const withdrawn = await publish(request(f, { action: 'withdraw', publicationId: randomUUID(), workspaceRevision: corrected.publication.head.commitRevision,
      headVersionId: current.versionId, headDigest: current.digest, withdrawalReason: 'evidence_retracted' }), c);
    const before = (await c.query('SELECT source_measurement,source_action FROM public.runvara_business_outcome_versions WHERE version_id=$1', [current.versionId])).rows[0];
    const after = (await c.query('SELECT source_measurement,source_action FROM public.runvara_business_outcome_versions WHERE version_id=$1', [withdrawn.publication.head.versionId])).rows[0];
    assert.deepEqual(after, before);
  });
});

test('protected source cannot be downgraded through legacy reuse or a changed protected reference', async () => {
  const f = await completed(); await saveMeasurement(f); const first = await publish(request(f)), head = first.publication.head;
  for (const m of [linkedMeasurement(f.workspaceId, f.experimentId, f.sourceAction, { revision: 2, reuseVersionId: head.versionId }),
    protectedMeasurement(f, { revision: 2, reuseVersionId: head.versionId })]) {
    if (m.receiptSource) { m.receiptSource.commitRevision = randomUUID(); m.report.facts.receiptSource = structuredClone(m.receiptSource); }
    await saveMeasurement(f, resign(m));
    await assert.rejects(publish(request(f, { action: 'correct', headVersionId: head.versionId, headDigest: head.digest })), rejected('P0O01'));
  }
});

test('v1 legacy measurement publication still works with empty protected choices', async () => {
  const f = await fixture(); await saveMeasurement(f, sourceMeasurement(f.workspaceId, f.experimentId));
  const read = await review(f); assert.deepEqual(read.receiptChoices, []); assert.equal(read.selectedEvidence, null);
  const result = await publish(request(f)); assert.equal((await storedVersion(f, result.publication.head.versionId)).source_action, null);
});

test('schema reapplication preserves narrow consumer grant, ledger ACLs, role state and immutable evidence', async () => {
  const f = await completed(); const prior = await review(f, { selector: selectorFor(f) });
  await admin.query(baseline); await assertConsumerSecurity(); assert.deepEqual(await roles(), roleStateBefore);
  assert.deepEqual(await review(f, { selector: selectorFor(f) }), prior);
  console.log('RECEIPT_OUTCOME_SECURITY=' + JSON.stringify({ serviceReaderOnly: true, legacyReviewSecurityInvoker: true,
    ledgerSelectGranted: false, sourceHelpersGranted: false, roleChanges: false, schemaReapplySafe: true, consumerFunctions: 7 }));
});

test('actual objective v2 protected completion publishes unchanged source under v4 and original ACK remains exact', async () => {
  const actual = await objectivePublicationFixture({ workspaceId: 'consumer-objective-' + randomUUID() });
  const f = { ...actual, sourceAction: actual.source, state: structuredClone(actual.state), experimentId: 'experiment-one' };
  f.state._revision = randomUUID(); f.state.revenueEngine = { experiments: [{ id: f.experimentId, status: 'measured' }] };
  const beforeWrite = f.state.connectionWrites.find(w => w.id === f.write.id);
  beforeWrite.status = 'executing'; beforeWrite.dispatchClaim.phases = {};
  delete beforeWrite.result; delete beforeWrite.completedAt; delete beforeWrite.recordedActionContext;
  Object.assign(f, descriptor(f));
  await admin.query('INSERT INTO public.workspaces(id,name,slug) VALUES($1,$1,$1)', [f.workspaceId]);
  await admin.query('INSERT INTO public.saas_workspace_state(workspace_id,state) VALUES($1,$2)', [f.workspaceId, f.state]);
  const reserve = reserveRequest(f), finish = finalizeRequest(f, reserve, { nextRevision: '11111111-2222-3333-4444-555555555555' });
  await call('reserve', reserve); await call('finalize', finish); f.commitRevision = finish.nextRevision;
  assert.deepEqual(await lookup(f, 'finalize', finish), expectedAck(f, 'finalize', finish, true));
  await assert.rejects(lookup(f, 'finalize', finish, { actorId: 'new-owner' }), rejected());
  const next = await state(f); next.approvals = []; next.connections = []; next.objectives = [];
  delete next.connectionWrites[0].recordedActionContext; next._revision = randomUUID(); await setState(f, next);
  await saveMeasurement(f);
  const read = await review(f, { actorId: 'content-owner' });
  assert.deepEqual(read.selectedEvidence.receipt.source, actual.source);
  assert.equal(read.receiptChoices[0].origin, 'owner_objective_content');
  assert.deepEqual(read.receiptChoices[0].originatingObjective, actual.source.context.originatingObjective);
  const result = await publish(request(f, { actorId: 'content-owner' })), row = await storedVersion(f, result.publication.head.versionId);
  assert.deepEqual(row.source_action, actual.source); assert.equal(row.source_measurement.schema, 'runvara-experiment-measurement/v4');
  assert.deepEqual(row.source_measurement.receiptSource, referenceFor(f));
  console.log('RECEIPT_OUTCOME_OBJECTIVE=' + JSON.stringify({ originalSourceSchema: row.source_action.schema,
    measurementSchema: row.source_measurement.schema, lowercaseNonV4CommitUuidAccepted: true, originalAckIdentityUnchanged: true }));
});

test('maximum canonical source survives exact JSONB reader and copied publication bounds', async () => {
  const workspaceId = 'receipt-pg-' + randomUUID(), empty = action(workspaceId, { description: '' });
  const room = 24576 - Buffer.byteLength(canonical(empty.sourceAction));
  const f = await completed({ workspaceId, description: '雪'.repeat(Math.floor(room / 3)) + 'x'.repeat(room % 3) });
  assert.equal(Buffer.byteLength(canonical(f.sourceAction)), 24576); await saveMeasurement(f);
  const read = await review(f), sizes = (await admin.query(`SELECT octet_length($1::jsonb::text) private,
    octet_length($2::jsonb::text) response,octet_length($3::jsonb::text) source,octet_length($4::jsonb::text) receipt`,
    [read.selectedEvidence, read, f.sourceAction, f.receipt])).rows[0];
  assert.ok(sizes.private <= 43008); assert.ok(sizes.response <= 131072); assert.ok(sizes.source <= 32768); assert.ok(sizes.receipt <= 36864);
  assert.ok(Buffer.byteLength(JSON.stringify(read.selectedEvidence)) <= 43008);
  const result = await publish(request(f)); assert.deepEqual((await storedVersion(f, result.publication.head.versionId)).source_action, f.sourceAction);
  console.log('RECEIPT_OUTCOME_MAX_SOURCE=' + JSON.stringify({ canonical: 24576, ...sizes, unchangedSourceJsonbLimit: 32768,
    unchangedPrivateLimit: 43008, unchangedResponseLimit: 131072 }));
});

test('v4 exact 8192 canonical measurement boundary accepts and one extra byte rejects', async () => {
  let selected;
  for (let n = 1; n < 210; n++) {
    const workspaceId = 'receipt-boundary-' + '雪'.repeat(n) + randomUUID();
    const f = { workspaceId, experimentId: 'experiment-one', ...action(workspaceId), commitRevision: randomUUID() }; Object.assign(f, descriptor(f));
    const m = protectedMeasurement(f); m.report.description = ''; const base = Buffer.byteLength(canonical(resign(m))), room = 8192 - base;
    if (room > 1 && room < 2800) { selected = { workspaceId, room }; break; }
  }
  assert.ok(selected); const f = await completed({ workspaceId: selected.workspaceId });
  let m = protectedMeasurement(f); m.report.description = '';
  const room = 8192 - Buffer.byteLength(canonical(resign(m)));
  m.report.description = '雪'.repeat(Math.floor(room / 3)) + 'x'.repeat(room % 3); m = resign(m);
  assert.equal(Buffer.byteLength(canonical(m)), 8192); assert.ok(m.report.description.length <= 1000);
  await saveMeasurement(f, m); const first = await publish(request(f)); assert.ok(first.publication.head.versionId);
  const tooLarge = structuredClone(m); tooLarge.report.description += 'x';
  assert.equal(Buffer.byteLength(canonical(resign(tooLarge))), 8193);
  await assert.rejects(admin.query('SELECT public.runvara_outcome_validate_measurement($1,$2,$3,clock_timestamp())', [resign(tooLarge), f.workspaceId, f.experimentId]), rejected('P0O10'));
  console.log('RECEIPT_OUTCOME_MEASUREMENT_BOUNDARY=' + JSON.stringify({ acceptedCanonical: 8192, rejectedCanonical: 8193,
    storedJsonb: (await admin.query('SELECT octet_length(source_measurement::text) n FROM public.runvara_business_outcome_versions WHERE version_id=$1', [first.publication.head.versionId])).rows[0].n,
    unchangedJsonbLimit: 12288 }));
});

test('maximum 256 admission scan has bounded finite pages and exact outside-page evidence', async () => {
  const f = await completed(), all = [f];
  for (let i = 1; i < 256; i++) all.push(await seedPageRow(f, 'max-page-' + i));
  const sorted = all.map(x => x.admission.attemptId).sort(), seen = [], latencies = [], bytes = []; let after = null;
  do {
    const start = performance.now(), read = await review(f, { after }); latencies.push(performance.now() - start);
    assert.ok(read.receiptChoices.length > 0 && read.receiptChoices.length <= 20);
    bytes.push((await admin.query('SELECT octet_length($1::jsonb::text) n', [read])).rows[0].n);
    seen.push(...read.receiptChoices.map(x => x.receiptSource.attemptId));
    if (read.hasMore) assert.equal(read.nextCursor, seen.at(-1));
    after = read.nextCursor;
  } while (after);
  assert.deepEqual(seen, sorted);
  const last = all.find(x => x.admission.attemptId === sorted.at(-1)); const selected = await review(f, { selector: selectorFor(last) });
  assert.deepEqual(selected.selectedEvidence.receipt, last.receipt);
  assert.ok(!selected.receiptChoices.some(x => x.receiptSource.attemptId === last.admission.attemptId));
  console.log('RECEIPT_OUTCOME_MAX_TENANT=' + JSON.stringify({ admissions: 256, pages: latencies.length,
    maxPageResponseJsonbBytes: Math.max(...bytes), firstReadMs: latencies[0], maxReadMs: Math.max(...latencies),
    totalReadMs: latencies.reduce((a, b) => a + b, 0), syntheticLocalOnly: true, costClaim: false }));
  await seedPageRow(f, 'overflow-257'); await assert.rejects(review(f), rejected('P0O10'));
});

test('oversized invalid first candidate fails explicitly instead of returning an empty nonadvancing page', async () => {
  const f = await fixture(), source = action(f.workspaceId, { id: 'oversized-candidate' });
  source.sourceAction.input.title = 'x'.repeat(20000); source.sourceAction = sign(source.sourceAction);
  const a = { workspaceId: f.workspaceId, ...source }; Object.assign(a, descriptor(a));
  await admin.query(`INSERT INTO public.runvara_content_admissions(workspace_id,attempt_id,write_id,admission,request_fingerprint,expected_revision,commit_revision,write_identity_digest)
    VALUES($1,$2,$3,$4,$5,$6,$7,$5)`, [f.workspaceId, a.admission.attemptId, a.write.id, a.admission, 'a'.repeat(64), randomUUID(), randomUUID()]);
  await admin.query(`INSERT INTO public.runvara_content_receipts(workspace_id,attempt_id,receipt,request_fingerprint,expected_revision,commit_revision,final_projection_digest)
    VALUES($1,$2,$3,$4,$5,$6,$4)`, [f.workspaceId, a.admission.attemptId, a.receipt, 'b'.repeat(64), randomUUID(), randomUUID()]);
  await assert.rejects(review(f), rejected());
});

test('same receipt correction preserves reference, association removal is explicit, and withdrawal is final', async () => {
  const f = await completed(); await saveMeasurement(f); const first = await publish(request(f));
  await saveMeasurement(f, protectedMeasurement(f, { revision: 2, amount: '4' }));
  const second = await publish(request(f, { action: 'correct', headVersionId: first.publication.head.versionId, headDigest: first.publication.head.digest }));
  assert.deepEqual((await storedVersion(f, second.publication.head.versionId)).source_measurement.receiptSource, referenceFor(f));
  await saveMeasurement(f, sourceMeasurement(f.workspaceId, f.experimentId, { revision: 3, amount: '2' }));
  const third = await publish(request(f, { action: 'correct', headVersionId: second.publication.head.versionId, headDigest: second.publication.head.digest }));
  assert.equal((await storedVersion(f, third.publication.head.versionId)).source_action, null);
  const withdrawal = request(f, { action: 'withdraw', workspaceRevision: third.publication.head.commitRevision,
    headVersionId: third.publication.head.versionId, headDigest: third.publication.head.digest, withdrawalReason: 'evidence_retracted' });
  const last = await publish(withdrawal);
  await assert.rejects(publish({ ...withdrawal, publicationId: randomUUID(), workspaceRevision: last.publication.head.commitRevision,
    headVersionId: last.publication.head.versionId, headDigest: last.publication.head.digest }), rejected('P0O08'));
});

test('concurrent identical protected publish returns one immutable commit and one replay', async () => {
  const f = await completed(); await saveMeasurement(f); const r = request(f), a = await connect(), b = await connect();
  try {
    const replies = await Promise.all([publish(r, a), publish(r, b)]);
    assert.equal(replies.filter(x => x.replayed).length, 1); assert.deepEqual(replies[0].publication, replies[1].publication);
    assert.equal((await admin.query('SELECT count(*)::int n FROM public.runvara_business_outcome_versions WHERE workspace_id=$1', [f.workspaceId])).rows[0].n, 1);
  } finally { await close(a); await close(b); }
});

test('saved protected reuse review proves same-outcome immutable version and exact provenance', async () => {
  const f = await completed(); await saveMeasurement(f); const first = await publish(request(f)), head = first.publication.head;
  await saveMeasurement(f, protectedMeasurement(f, { revision: 2, reuseVersionId: head.versionId }));
  await withoutLedgerLookup(async c => { const read = await review(f, {}, c); assert.equal(read.selectedEvidence, null); });
  const foreign = await completed(); await saveMeasurement(foreign); const other = await publish(request(foreign));
  for (const edit of [m => { m.intervention.reuseVersionId = 'outcome_version_' + '0'.repeat(64); },
    m => { m.intervention.reuseVersionId = other.publication.head.versionId; },
    m => { m.receiptSource.commitRevision = randomUUID(); }, m => { m.intervention.approval.digest = '0'.repeat(64); },
    m => { m.intervention.completedAt = '2026-01-01T00:00:03.000Z'; }]) {
    const m = protectedMeasurement(f, { revision: 2, reuseVersionId: head.versionId }); edit(m);
    m.report.facts.receiptSource = structuredClone(m.receiptSource); m.report.facts.intervention = structuredClone(m.intervention);
    await saveMeasurement(f, resign(m)); await assert.rejects(review(f), rejected('P0O01'));
  }
});

test('every review purpose grounds saved protected references and full intervention before exposing them', async () => {
  const f = await completed();
  for (const mutate of [m => { m.receiptSource.commitRevision = randomUUID(); }, m => { m.intervention.approval.digest = '0'.repeat(64); },
    m => { m.intervention.productId = 'gid://shopify/Product/999'; }, m => { m.intervention.completedAt = '2026-01-01T00:00:03.000Z'; }]) {
    const m = protectedMeasurement(f); mutate(m); m.report.facts.intervention = structuredClone(m.intervention); m.report.facts.receiptSource = structuredClone(m.receiptSource);
    await saveMeasurement(f, resign(m));
    for (const options of [{}, { after: f.admission.attemptId }, { selector: selectorFor(f) }]) await assert.rejects(review(f, options), rejected('P0O01'));
    await withoutLedgerLookup(async c => {
      const safe = await review(f, { resolveSaved: false }, c);
      assert.equal(safe.review.measurement, null); assert.equal(safe.selectedEvidence, null);
      assert.deepEqual(safe.receiptChoices, []); assert.equal(safe.nextCursor, null); assert.equal(safe.hasMore, false);
    });
  }
  await saveMeasurement(f);
  const selected = await review(f, { resolveSaved: false, selector: selectorFor(f) });
  assert.equal(selected.review.measurement, null); assert.deepEqual(selected.selectedEvidence.receipt, f.receipt);
  await assert.rejects(review(f, { resolveSaved: null }), rejected('P0O01'));
});

test('unqualified protected drafts remain readable while publication qualification stays mandatory', async () => {
  const f = await completed(), m = protectedMeasurement(f);
  m.amount = null; m.report.facts.amount = null; m.report.costsComplete = false;
  await saveMeasurement(f, resign(m)); assert.deepEqual((await review(f)).selectedEvidence.receipt, f.receipt);
  await assert.rejects(publish(request(f)), rejected('P0O02'));
});

test('stored reuse from another outcome in the same workspace cannot ground saved protected review', async () => {
  const f = await completed(); await saveMeasurement(f); const original = await publish(request(f));
  const other = { ...f, experimentId: 'experiment-other' }, next = await state(f);
  other.source = protectedMeasurement(other); next._revision = randomUUID();
  next.revenueEngine.experiments.push({ id: other.experimentId, outcomeMeasurement: other.source }); await setState(f, next); other.state = next;
  const elsewhere = await publish(request(other));
  const m = protectedMeasurement(f, { revision: 2, reuseVersionId: elsewhere.publication.head.versionId }); await saveMeasurement(f, m);
  for (const options of [{}, { after: f.admission.attemptId }, { selector: selectorFor(f) }]) await assert.rejects(review(f, options), rejected('P0O01'));
  await saveMeasurement(f, protectedMeasurement(f, { revision: 2, reuseVersionId: original.publication.head.versionId }));
  assert.equal((await review(f)).selectedEvidence, null);
});

async function addCompletedAction(f, id) {
  const a = { workspaceId: f.workspaceId, experimentId: f.experimentId, ...action(f.workspaceId, { id }) }, c = a.sourceAction.context;
  a.write.requestId = c.requestId = 'synthetic_request_' + randomUUID().replaceAll('-', '');
  a.write.approvalId = a.approval.id = c.approval.id = 'approval-' + id; c.approval = sign(c.approval);
  const identity = Object.fromEntries(['id','requestId','provider','input','digest','connectionId','account','requestedBy','requiresApproval','approvalId'].map(k => [k, a.write[k]]));
  c.claimIdentity = a.write.dispatchClaim.identity = rawHash(JSON.stringify(identity)); a.sourceAction = sign(a.sourceAction);
  a.write.recordedActionContext = { ...structuredClone(a.sourceAction.context), snapshotDigest: a.sourceAction.digest };
  Object.assign(a, descriptor(a));
  const next = await state(f), before = structuredClone(a.write); before.status = 'executing'; before.dispatchClaim.phases = {};
  delete before.result; delete before.completedAt; delete before.recordedActionContext;
  next.connectionWrites.push(before); next.approvals.push({ ...structuredClone(a.approval), executionStatus: 'approved', executedExternally: false });
  next._revision = randomUUID(); await setState(f, next); a.state = next;
  const reserve = reserveRequest(a), finish = finalizeRequest(a, reserve); await call('reserve', reserve); await call('finalize', finish);
  a.commitRevision = finish.nextRevision; a.state = finish.state; return a;
}

test('correction explicitly selects another completed receipt and copies only that exact source', async () => {
  const f = await completed(); await saveMeasurement(f); const first = await publish(request(f));
  const secondSource = await addCompletedAction(f, 'replacement-source');
  await saveMeasurement(f, protectedMeasurement(secondSource, { revision: 2, amount: '3' }));
  const second = await publish(request(f, { action: 'correct', headVersionId: first.publication.head.versionId, headDigest: first.publication.head.digest }));
  const row = await storedVersion(f, second.publication.head.versionId);
  assert.deepEqual(row.source_action, secondSource.sourceAction); assert.deepEqual(row.source_measurement.receiptSource, referenceFor(secondSource));
  assert.deepEqual((await storedVersion(f, first.publication.head.versionId)).source_action, f.sourceAction);
});

test('new validator preserves original measurement golden and every supported currency', async () => {
  const golden = JSON.parse(await readFile(new URL('./fixtures/business-outcome-measurement-golden.json', import.meta.url), 'utf8'));
  assert.equal(golden.measurement.digest, '8a3f07f810777a260ed6bbe8ba0d632d6ce386f565b1b1ff027adf77995ec76a');
  const result = (await admin.query("SELECT public.runvara_outcome_hash($1::jsonb-'digest') measurement_digest,public.runvara_outcome_hash(($1::jsonb->'report')-'digest') report_digest,public.runvara_outcome_validate_measurement($1::jsonb,$2,$3,$4::timestamptz) record",
    [golden.measurement, golden.context.workspaceId, golden.context.experimentId, golden.context.now])).rows[0];
  assert.equal(result.measurement_digest, golden.measurement.digest); assert.equal(result.report_digest, golden.measurement.report.digest);
  assert.equal(BUSINESS_OUTCOME_CURRENCIES.length, 162);
  const measurements = BUSINESS_OUTCOME_CURRENCIES.map(currency => sourceMeasurement('currency-workspace', 'experiment-one', { currency }));
  const rows = (await admin.query("SELECT public.runvara_outcome_validate_measurement(m,'currency-workspace','experiment-one',clock_timestamp())->>'currency' currency FROM jsonb_array_elements($1::jsonb) m", [JSON.stringify(measurements)])).rows;
  assert.deepEqual(rows.map(x => x.currency), BUSINESS_OUTCOME_CURRENCIES);
  for (const mutate of [m => { m.currency = 'ZZZ'; m.report.facts.currency = 'ZZZ'; }, m => { m.amount = '1e3'; m.report.facts.amount = '1e3'; },
    m => { m.report.costsComplete = false; }, m => { m.amount = null; m.report.facts.amount = null; },
    m => { m.coverage.status = 'partial'; m.report.facts.coverage.status = 'partial'; }]) {
    const m = sourceMeasurement('currency-workspace', 'experiment-one'); mutate(m);
    await assert.rejects(admin.query("SELECT public.runvara_outcome_validate_measurement($1,'currency-workspace','experiment-one',clock_timestamp())", [resign(m)]), rejected(['P0O01','P0O02']));
  }
});

test('legacy v2 publication, immutable correction and withdrawal retain the old source grammar', async () => {
  const f = await completed(); await saveMeasurement(f, linkedMeasurement(f.workspaceId, f.experimentId, f.sourceAction));
  const first = await publish(request(f));
  await saveMeasurement(f, linkedMeasurement(f.workspaceId, f.experimentId, f.sourceAction, { revision: 2, reuseVersionId: first.publication.head.versionId }));
  const second = await publish(request(f, { action: 'correct', headVersionId: first.publication.head.versionId, headDigest: first.publication.head.digest }));
  const last = await publish(request(f, { action: 'withdraw', workspaceRevision: second.publication.head.commitRevision,
    headVersionId: second.publication.head.versionId, headDigest: second.publication.head.digest, withdrawalReason: 'evidence_retracted' }));
  const row = await storedVersion(f, last.publication.head.versionId); assert.equal(row.source_measurement.schema, 'runvara-experiment-measurement/v2');
  assert.deepEqual(row.source_action, f.sourceAction); assert.equal(Object.hasOwn(row.source_measurement, 'receiptSource'), false);
});

test('legacy v3 objective publication and immutable correction/withdrawal remain exact', async () => {
  const actual = await objectivePublicationFixture({ workspaceId: 'consumer-legacy-objective-' + randomUUID() });
  const f = { ...actual, sourceAction: actual.source, state: structuredClone(actual.state), experimentId: 'experiment-one' };
  f.state._revision = randomUUID(); f.state.revenueEngine = { experiments: [{ id: f.experimentId, status: 'measured' }] };
  const beforeWrite = f.state.connectionWrites.find(w => w.id === f.write.id);
  beforeWrite.status = 'executing'; beforeWrite.dispatchClaim.phases = {}; delete beforeWrite.result; delete beforeWrite.completedAt; delete beforeWrite.recordedActionContext;
  Object.assign(f, descriptor(f));
  await admin.query('INSERT INTO public.workspaces(id,name,slug) VALUES($1,$1,$1)', [f.workspaceId]);
  await admin.query('INSERT INTO public.saas_workspace_state(workspace_id,state) VALUES($1,$2)', [f.workspaceId, f.state]);
  const reserve = reserveRequest(f), finish = finalizeRequest(f, reserve); await call('reserve', reserve); await call('finalize', finish); f.commitRevision = finish.nextRevision;
  const legacy = options => { const m = protectedMeasurement(f, options); m.schema = 'runvara-experiment-measurement/v3'; m.report.schema = 'runvara-measurement-report/v3'; delete m.receiptSource; delete m.report.facts.receiptSource; return resign(m); };
  await saveMeasurement(f, legacy()); const first = await publish(request(f, { actorId: 'content-owner' }));
  const next = await state(f); next.approvals = []; next.connections = []; delete next.connectionWrites[0].recordedActionContext; next._revision = randomUUID(); await setState(f, next);
  await saveMeasurement(f, legacy({ revision: 2, reuseVersionId: first.publication.head.versionId }));
  const second = await publish(request(f, { actorId: 'content-owner', action: 'correct', headVersionId: first.publication.head.versionId, headDigest: first.publication.head.digest }));
  const last = await publish(request(f, { actorId: 'content-owner', action: 'withdraw', workspaceRevision: second.publication.head.commitRevision,
    headVersionId: second.publication.head.versionId, headDigest: second.publication.head.digest, withdrawalReason: 'evidence_retracted' }));
  const row = await storedVersion(f, last.publication.head.versionId); assert.equal(row.source_measurement.schema, 'runvara-experiment-measurement/v3');
  assert.deepEqual(row.source_action, f.sourceAction); assert.equal(Object.hasOwn(row.source_measurement, 'receiptSource'), false);
});

test('protected reference workspace boundary matches JavaScript UTF16 length and trimming', async () => {
  const f = await completed(), reference = referenceFor(f);
  for (const workspaceId of ['😀'.repeat(128), '雪'.repeat(256)]) {
    await admin.query('SELECT public.runvara_outcome_validate_receipt_reference($1,$2)', [{ ...reference, workspaceId }, workspaceId]);
  }
  for (const workspaceId of ['😀'.repeat(129), '雪'.repeat(257), '\u00a0workspace', 'workspace\ufeff', '\tworkspace', 'workspace\u2029']) {
    await assert.rejects(admin.query('SELECT public.runvara_outcome_validate_receipt_reference($1,$2)', [{ ...reference, workspaceId }, workspaceId]), rejected('P0O01'));
  }
});
