/** Real PostgreSQL 17 concurrency/privilege gate; never silently skipped.
 * Only an explicitly opted-in, empty, local disposable database is accepted.
 * The matching Actions workflow uses official postgres:17.6, no deployment keys.
 */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BUSINESS_OUTCOME_CURRENCIES, BUSINESS_OUTCOME_CURRENCY_CONTRACT_VERSION, createBusinessOutcomeCandidate, correctBusinessOutcomeCandidate, withdrawBusinessOutcomeCandidate, validateBusinessOutcomeCandidate } from '../lib/business-outcomes.mjs';
import { createBusinessOutcomePersistence } from '../lib/business-outcome-store.mjs';
import { canonical, hash, sourceMeasurement, resign, fixtureData, request, parameters, callSql, RPC_SIGNATURE, actionFixture, actionRequest, linkedMeasurement, withAction } from './business-outcome-postgres-fixture.mjs';

assert.equal(process.env.OUTCOME_ALLOW_DISPOSABLE_TEST_DB, '1', 'Explicit disposable database opt-in required');
const connectionString = process.env.OUTCOME_TEST_DATABASE_URL;
assert.ok(connectionString, 'OUTCOME_TEST_DATABASE_URL required; PostgreSQL tests cannot silently skip');
const url = new URL(connectionString);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
assert.equal(url.pathname, '/runvara_outcome_test');
assert.equal(url.search, ''); assert.equal(url.hash, '');
const require = createRequire(new URL('./atomic-usage/package.json', import.meta.url));
const { Client } = require('pg');
const clients = new Set();
const REVIEW_SIGNATURE = 'public.runvara_read_business_outcome_review(text,text)';
const REPORTING_SIGNATURE = 'public.runvara_commit_reporting_status(text,text,text,jsonb,timestamp with time zone)';
let admin, baseline, originalLedgerAcl, originalOutcomeSecurity;
async function connect(role = 'service_role') {
  const c = new Client({ connectionString, ssl: false, options: '', connectionTimeoutMillis: 5000, statement_timeout: 20_000, application_name: 'runvara-outcome-test' });
  await c.connect(); clients.add(c);
  assert.ok(['postgres', 'service_role', 'anon', 'authenticated'].includes(role));
  if (role !== 'postgres') await c.query('SET ROLE ' + role);
  await c.query("SET TIME ZONE 'UTC'"); return c;
}
async function close(c) { clients.delete(c); await c.end(); }
async function using(role, fn) { const c = await connect(role); try { return await fn(c); } finally { await close(c); } }
async function publish(r, c) {
  if (!c) return using('service_role', c => publish(r, c));
  return (await c.query(callSql, parameters(r))).rows[0].receipt;
}
async function review(f, c) {
  if (!c) return using('service_role', c => review(f, c));
  return (await c.query('SELECT public.runvara_read_business_outcome_review($1,$2) AS review', [f.workspaceId, f.experimentId])).rows[0].review;
}
async function fixture() {
  const f = fixtureData();
  await admin.query('INSERT INTO public.workspaces(id,name,slug) VALUES($1,$1,$1)', [f.workspaceId]);
  await admin.query('INSERT INTO public.saas_workspace_state(workspace_id,state) VALUES($1,$2)', [f.workspaceId, f.state]);
  return f;
}
async function state(f, c = admin) { return (await c.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1', [f.workspaceId])).rows[0].state; }
async function setState(f, s) { await admin.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1', [f.workspaceId, s]); }
async function joined(f, c = admin) {
  return (await c.query(`SELECT h.workspace_id,h.outcome_id,h.version_id,to_jsonb(v)-'source_measurement'-'source_action' AS version
    FROM public.runvara_business_outcome_heads h JOIN public.runvara_business_outcome_versions v
    ON (v.workspace_id,v.outcome_id,v.version_id)=(h.workspace_id,h.outcome_id,h.version_id)
    WHERE h.workspace_id=$1 ORDER BY h.outcome_id LIMIT 51`, [f.workspaceId])).rows;
}
async function unchanged(f, expected = f.state) {
  assert.deepEqual(await state(f), expected);
  assert.equal((await joined(f)).length, 0);
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.audit_events WHERE workspace_id=$1', [f.workspaceId])).rows[0].n, 0);
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.runvara_business_outcome_versions WHERE workspace_id=$1', [f.workspaceId])).rows[0].n, 0);
}
function code(expected) { return e => { assert.equal(e.code, expected, e.message); assert.ok(!e.message.includes('Synthetic')); return true; }; }
function candidateInput(source, verification) { return { source: { type: 'experiment_measurement', experimentId: source.experimentId, measurementRevision: source.revision, measurementDigest: source.digest }, ...Object.fromEntries(['metric','amount','currency','window','coverage','method','provenance','links'].map(k => [k, source[k]])), verification }; }
async function correction(f, prior, revision = 2) {
  const s = await state(f), source = sourceMeasurement(f.workspaceId, f.experimentId, { revision, amount: '-0.123456' });
  s.revenueEngine.experiments[0].outcomeMeasurement = source; s._revision = randomUUID(); await setState(f, s);
  return request(f, { action: 'correct', workspaceRevision: s._revision, measurementRevision: source.revision, measurementDigest: source.digest, headVersionId: prior.publication.head.versionId, headDigest: prior.publication.head.digest });
}
async function ledgerAcl() {
  return (await admin.query(`SELECT c.relname,c.relrowsecurity,has_table_privilege('service_role',c.oid,'SELECT') AS can_select,
    has_table_privilege('service_role',c.oid,'INSERT') AS can_insert,has_table_privilege('service_role',c.oid,'UPDATE') AS can_update,
    has_table_privilege('service_role',c.oid,'DELETE') AS can_delete,has_table_privilege('anon',c.oid,'SELECT') AS anon_select,
    has_table_privilege('authenticated',c.oid,'SELECT') AS auth_select,
    ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      AND has_column_privilege('service_role',c.oid,a.attnum,'UPDATE') ORDER BY a.attname) AS update_columns
    FROM pg_class c WHERE c.oid IN ('public.runvara_ai_usage'::regclass,'public.runvara_provider_usage_windows'::regclass,'public.runvara_provider_usage_reservations'::regclass)
    ORDER BY c.relname`)).rows;
}
async function outcomeSecurity() {
  const functions = (await admin.query(`SELECT p.oid::regprocedure::text signature,p.proowner::regrole::text owner,p.prosecdef,p.provolatile,p.proconfig,p.proacl::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND (p.proname LIKE 'runvara%outcome%' OR p.proname='runvara_commit_reporting_status') ORDER BY signature`)).rows;
  const tables = (await admin.query(`SELECT c.relname,c.relowner::regrole::text owner,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text,
    ARRAY(SELECT pol.polname::text FROM pg_policy pol WHERE pol.polrelid=c.oid ORDER BY pol.polname) policies
    FROM pg_class c WHERE c.oid IN ('public.runvara_business_outcome_versions'::regclass,'public.runvara_business_outcome_heads'::regclass) ORDER BY c.relname`)).rows;
  const columns = (await admin.query(`SELECT c.relname,a.attname,a.attacl::text,
    ARRAY(SELECT r.rolname::text FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role') AND
      (has_column_privilege(r.oid,c.oid,a.attnum,'INSERT') OR has_column_privilege(r.oid,c.oid,a.attnum,'UPDATE') OR has_column_privilege(r.oid,c.oid,a.attnum,'REFERENCES')) ORDER BY r.rolname) writers
    FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid WHERE c.oid IN ('public.runvara_business_outcome_versions'::regclass,'public.runvara_business_outcome_heads'::regclass)
      AND a.attnum>0 AND NOT a.attisdropped AND a.attname<>'source_action' ORDER BY c.relname,a.attname`)).rows;
  return { functions, tables, columns };
}
async function assertOutcomeSecurity() {
  const after = await outcomeSecurity(), existing = new Set(originalOutcomeSecurity.functions.map(f => f.signature));
  assert.deepEqual({ ...after, functions: after.functions.filter(f => existing.has(f.signature)) }, originalOutcomeSecurity, 'Every preexisting signature, ACL, owner, mode, search_path, table policy and column privilege must remain exact');
  const helpers = after.functions.filter(f => !existing.has(f.signature)); assert.equal(helpers.length, 7);
  for (const helper of helpers) {
    assert.equal(helper.prosecdef, false); assert.equal(helper.owner, 'postgres'); assert.ok(helper.proconfig.includes('search_path=""'));
    for (const role of ['anon','authenticated','service_role']) assert.equal((await admin.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [role, helper.signature])).rows[0].allowed, false, `${role} must not execute ${helper.signature}`);
    assert.equal((await admin.query("SELECT EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) WHERE grantee=0 AND privilege_type='EXECUTE') allowed FROM pg_proc WHERE oid=$1::regprocedure", [helper.signature])).rows[0].allowed, false, `PUBLIC must not execute ${helper.signature}`);
  }
  const newColumn = (await admin.query(`SELECT has_column_privilege('service_role','public.runvara_business_outcome_versions','source_action','SELECT') readable,
    has_column_privilege('service_role','public.runvara_business_outcome_versions','source_action','UPDATE') mutable,
    has_column_privilege('anon','public.runvara_business_outcome_versions','source_action','SELECT') anon_readable,
    has_column_privilege('authenticated','public.runvara_business_outcome_versions','source_action','SELECT') auth_readable`)).rows[0];
  assert.deepEqual(newColumn, { readable: true, mutable: false, anon_readable: false, auth_readable: false });
  return after;
}
async function linkedFixture(options = {}) { const f = withAction(await fixture(), options); await setState(f, f.state); return f; }
async function storedAction(f, versionId) { return (await admin.query('SELECT source_action FROM public.runvara_business_outcome_versions WHERE workspace_id=$1 AND version_id=$2', [f.workspaceId, versionId])).rows[0]?.source_action; }
async function blocked(pid, blocker) {
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    if ((await admin.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [pid, blocker])).rows[0].blocked) return;
    await delay(10);
  }
  assert.fail('Expected independent transaction to wait on workspace row lock');
}
before(async () => {
  admin = await connect('postgres');
  const info = (await admin.query('SELECT current_database() db,current_user role,current_setting(\'server_version_num\')::int version')).rows[0];
  assert.equal(info.db, 'runvara_outcome_test'); assert.equal(info.role, 'postgres'); assert.ok(info.version >= 170000 && info.version < 180000);
  assert.ok(['127.0.0.1','::1','::ffff:127.0.0.1'].includes(admin.connection.stream.remoteAddress));
  const objects = (await admin.query(`SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
    UNION ALL SELECT n.nspname,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'`)).rows;
  assert.deepEqual(objects, [], 'Refusing nonempty database');
  await admin.query(await readFile(new URL('./atomic-usage-postgres-fixture.sql', import.meta.url), 'utf8'));
  baseline = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  await admin.query(baseline);
  // Exercise the actual existing ledgers, not permissive stand-in schemas.
  for (const file of ['20260927113000_runvara_agent_operations.sql','20260927122500_ai_usage_economics.sql','20261006190318_atomic_provider_usage.sql']) {
    await admin.query(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
  }
  originalLedgerAcl = await ledgerAcl();
  const dir = new URL('../supabase/migrations/', import.meta.url);
  // The incremental outcome release follows the already-installed reporting
  // repair. Exercise that actual predecessor without changing either migration.
  const reporting = (await readdir(dir)).filter(x => /^\d{14}_reporting_status_cas\.sql$/.test(x)); assert.equal(reporting.length, 1);
  await admin.query(await readFile(new URL(reporting[0], dir), 'utf8'));
  const matches = (await readdir(dir)).filter(x => /^\d{14}_business_outcome_publication\.sql$/.test(x)); assert.equal(matches.length, 1);
  await admin.query(await readFile(new URL(matches[0], dir), 'utf8'));
  originalOutcomeSecurity = await outcomeSecurity();
  const forward = (await readdir(dir)).filter(x => /^\d{14}_reviewed_action_outcome_snapshot\.sql$/.test(x)); assert.equal(forward.length, 1);
  assert.ok(forward[0] > matches[0] && matches[0] > reporting[0], 'Actual predecessor migration order');
  await admin.query(await readFile(new URL(forward[0], dir), 'utf8'));
  const afterSecurity = await assertOutcomeSecurity();
  console.log('OUTCOME_SECURITY_BEFORE=' + JSON.stringify(originalOutcomeSecurity));
  console.log('OUTCOME_SECURITY_AFTER=' + JSON.stringify(afterSecurity));
}, { timeout: 30_000 });
after(async () => { await Promise.all([...clients].map(close)); });

test('SQL canonical goldens equal exact JavaScript strings/digests, rejecting unsafe/deep/oversize inputs', async () => {
  for (const v of [null, true, false, 0, -1, Number.MAX_SAFE_INTEGER, { z: 'Café 😀\n"\\', a: ['999999999999999999.123456', 1, null] }, { integer: 1 }]) {
    const r = (await admin.query('SELECT public.runvara_outcome_canonical($1::jsonb) text,public.runvara_outcome_hash($1::jsonb) digest', [JSON.stringify(v)])).rows[0];
    assert.equal(r.text, canonical(v)); assert.equal(r.digest, hash(v));
  }
  assert.equal((await admin.query("SELECT public.runvara_outcome_canonical('{\"integer\":1.000}'::jsonb) text")).rows[0].text, '{"integer":1}');
  for (const json of ['1.2', '9007199254740992', '-9007199254740992', '['.repeat(18) + '0' + ']'.repeat(18), JSON.stringify({ text: 'x'.repeat(33000) })]) {
    await assert.rejects(admin.query('SELECT public.runvara_outcome_canonical($1::jsonb)', [json]), code('P0O01'));
  }
});

test('persisted measurement golden matches the final JS source/report envelope and both exact hashes', async () => {
  const golden = JSON.parse(await readFile(new URL('./fixtures/business-outcome-measurement-golden.json', import.meta.url), 'utf8'));
  assert.equal(golden.measurement.digest, '8a3f07f810777a260ed6bbe8ba0d632d6ce386f565b1b1ff027adf77995ec76a');
  assert.equal(golden.measurement.report.digest, '6e8ef5f0974c31d67049604048c810f63bf83d7c575a83d1e38eec10f7e477b8');
  const result = (await admin.query("SELECT public.runvara_outcome_hash($1::jsonb-'digest') measurement_digest,public.runvara_outcome_hash(($1::jsonb->'report')-'digest') report_digest,public.runvara_outcome_validate_measurement($1::jsonb,$2,$3,$4::timestamptz) record", [golden.measurement, golden.context.workspaceId, golden.context.experimentId, golden.context.now])).rows[0];
  assert.equal(result.measurement_digest, golden.measurement.digest); assert.equal(result.report_digest, golden.measurement.report.digest);
  assert.equal(result.record.amount, '123.45');
  const vector = { a: '雪🚀', amount: '-0.000001', arr: [0,true,null], n: 0, z: 12 };
  assert.equal((await admin.query('SELECT public.runvara_outcome_hash($1::jsonb) hash', [vector])).rows[0].hash, 'cdcd190371f0aeabdb6ed7e6b0d78f24893073849fb124e6fac57605be0e17a4');
});

test('frozen currency contract accepts supported units and rejects unknown or malformed codes', async () => {
  assert.equal(BUSINESS_OUTCOME_CURRENCY_CONTRACT_VERSION, 'runvara-supported-currencies/v1');
  const sql = (await admin.query("SELECT pg_get_functiondef('public.runvara_outcome_validate_measurement(jsonb,text,text,timestamptz)'::regprocedure) definition")).rows[0].definition;
  const codes = sql.match(/string_to_array\('([^']+)',' '\)/)?.[1].split(' ');
  assert.equal(codes?.length, 162); assert.deepEqual(codes, BUSINESS_OUTCOME_CURRENCIES);
  assert.ok(sql.includes(BUSINESS_OUTCOME_CURRENCY_CONTRACT_VERSION));
  for (const currency of ['EUR','GBP','USD','JPY','XCG']) {
    const f = await fixture(); f.source = sourceMeasurement(f.workspaceId, f.experimentId, { currency }); f.state.revenueEngine.experiments[0].outcomeMeasurement = f.source; await setState(f, f.state);
    assert.equal((await publish(request(f))).publication.version.currency, currency);
  }
  for (const currency of ['ZZZ','XXX','usd',123]) {
    const f = await fixture(); f.source = sourceMeasurement(f.workspaceId, f.experimentId, { currency }); f.state.revenueEngine.experiments[0].outcomeMeasurement = f.source; await setState(f, f.state);
    await assert.rejects(publish(request(f)), code('P0O01')); await unchanged(f);
  }
});

test('real publication matches pure candidate exactly; targeted CAS and immutable source receipt', async () => {
  const f = await fixture(), r = await publish(request(f));
  assert.deepEqual(r.publication.version, createBusinessOutcomeCandidate(candidateInput(f.source, r.publication.version.verification), { workspaceId: f.workspaceId, now: r.publication.head.committedAt }));
  assert.equal(r.replayed, false); assert.equal(r.isCurrent, true);
  const audit = (await admin.query('SELECT id,workspace_id,type,actor,detail,to_char(created_at at time zone \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') created_at FROM public.audit_events WHERE workspace_id=$1', [f.workspaceId])).rows;
  assert.deepEqual(audit, [{ id: 'outcome_audit_' + hash([f.workspaceId, r.publication.head.publicationId]), workspace_id: f.workspaceId, type: 'outcome-published', actor: 'owner', detail: { outcomeId: r.publication.head.outcomeId, versionId: r.publication.head.versionId, publicationId: r.publication.head.publicationId }, created_at: r.publication.head.committedAt }]);
  const s = await state(f), expected = structuredClone(f.state);
  expected._revision = r.publication.head.commitRevision;
  expected.revenueEngine.experiments[0].outcomeVerification = r.publication.version.verification;
  expected.revenueEngine.experiments[0].currentOutcome = r.publication.head;
  assert.deepEqual(s, expected);
  const stored = (await admin.query('SELECT * FROM public.runvara_business_outcome_versions WHERE workspace_id=$1', [f.workspaceId])).rows[0];
  assert.deepEqual(stored.source_measurement, f.source);
  assert.ok(!JSON.stringify(r).includes('secretNeverReturned'));
  assert.equal((await joined(f))[0].version.source_measurement, undefined);
  validateBusinessOutcomeCandidate(r.publication.version, { workspaceId: f.workspaceId, now: r.publication.head.committedAt });
});

test('reporting and outcome publishers serialize on the same revision without overwriting each other', async () => {
  for (const first of ['reporting', 'outcome']) {
    const f = await fixture();
    f.state.integrationStatus = { shopify: { sentinel: 'unrelated integration' }, reporting: { status: 'degraded', detail: 'previous status' } };
    await setState(f, f.state);
    const report = { status: 'connected', detail: 'Synthetic reporting refresh.', lastSyncAt: '2026-10-07T07:00:00.000Z', lastFailureAt: null, lastError: null, failures: [] };
    const reportRevision = randomUUID();
    const writeReport = async (c, expected, next = reportRevision) => (await c.query(
      'SELECT * FROM public.runvara_commit_reporting_status($1,$2,$3,$4::jsonb,$5::timestamptz)',
      [f.workspaceId, expected, next, JSON.stringify(report), report.lastSyncAt])).rows;
    const a = await connect(), b = await connect();
    let pending;
    try {
      await a.query('BEGIN');
      await a.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1 FOR UPDATE', [f.workspaceId]);
      const apid = (await a.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const bpid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      pending = (first === 'reporting' ? publish(request(f), b) : writeReport(b, f.state._revision))
        .then(value => ({ value }), error => ({ error }));
      await blocked(bpid, apid);
      const winner = first === 'reporting' ? await writeReport(a, f.state._revision) : await publish(request(f), a);
      await a.query('COMMIT');
      const loser = await pending;
      if (first === 'reporting') {
        assert.deepEqual(winner, [{ workspace_id: f.workspaceId }]);
        assert.equal(loser.error?.code, 'P0O04', 'stale publication requires a new review of the reporting-updated revision');
        const expected = structuredClone(f.state); expected._revision = reportRevision; expected.integrationStatus.reporting = report;
        await unchanged(f, expected);
        const fresh = await publish(request(f, { workspaceRevision: reportRevision }));
        assert.equal((await state(f))._revision, fresh.publication.head.commitRevision);
        assert.deepEqual((await state(f)).integrationStatus, expected.integrationStatus);
      } else {
        assert.deepEqual(loser.value, [], 'stale reporting CAS cannot replace the publication revision');
        const publishedState = await state(f), publishedRows = await joined(f);
        assert.equal(publishedState._revision, winner.publication.head.commitRevision);
        assert.deepEqual(publishedState.integrationStatus, f.state.integrationStatus);
        assert.deepEqual(await writeReport(a, publishedState._revision), [{ workspace_id: f.workspaceId }]);
        const expected = structuredClone(publishedState); expected._revision = reportRevision; expected.integrationStatus.reporting = report;
        assert.deepEqual(await state(f), expected);
        assert.deepEqual(await joined(f), publishedRows, 'reporting cannot rewrite immutable outcome versions or current heads');
      }
      assert.equal((await admin.query('SELECT count(*)::int n FROM public.audit_events WHERE workspace_id=$1', [f.workspaceId])).rows[0].n, 1);
      assert.equal((await joined(f)).length, 1);
    } finally {
      await a.query('ROLLBACK').catch(() => {});
      if (pending) await pending;
      await close(a); await close(b);
    }
  }
});

test('owner-only authorization and session rotation, including replay, are checked after locking', async () => {
  for (const change of [{ role: 'admin' }, { role: 'member' }, { active: false }, { active: null }, { active: 'true' }, { sessionVersion: 2 }, { sessionVersion: null }, { sessionVersion: '1' }, { sessionVersion: 'invalid' }, { passwordChangeRequired: true }, { passwordChangeRequired: null }, { passwordChangeRequired: 'false' }, { passwordChangeRequired: 0 }]) {
    const f = await fixture(); Object.assign(f.state.users[0], change); await setState(f, f.state);
    await assert.rejects(publish(request(f)), code('P0O03')); await unchanged(f);
  }
  const f = await fixture(), req = request(f); await publish(req);
  const s = await state(f); s.users[0].sessionVersion = 2; await setState(f, s);
  await assert.rejects(publish(req), code('P0O03'));
  s.users[0].sessionVersion = 1; s.users[0].passwordChangeRequired = true; await setState(f, s);
  await assert.rejects(publish(req), code('P0O03'));
});

test('legacy owners retain missing-field auth defaults without accepting explicit malformed values', async () => {
  const f = await fixture(); delete f.state.users[0].active; delete f.state.users[0].sessionVersion; await setState(f, f.state);
  const result = await publish(request(f)); assert.equal(result.publication.version.verification.actorId, 'owner');
  const g = await fixture(); g.state.users[0].passwordChangeRequired = false; await setState(g, g.state);
  assert.equal((await publish(request(g))).publication.version.verification.actorId, 'owner');
});

test('source, link, tenant, report and legacy flags cannot claim qualification', async () => {
  const cases = [
    m => { m.links.action = { workspaceId: m.workspaceId, id: 'invented', revision: 1, digest: 'a'.repeat(64) }; },
    m => { m.workspaceId = 'other-tenant'; },
    m => { m.report.facts.amount = '999'; },
    m => { m.report.id = 'invented-report'; },
    m => { m.provenance.aggregation = 'non_overlapping_scopes_attested'; },
    m => { m.coverage.scopeId = 'invented-scope'; m.report.facts.coverage.scopeId = 'invented-scope'; },
    m => { m.coverage.observedCount = 1.1; m.report.facts.coverage.observedCount = 1.1; },
    m => { m.revision = Number.MAX_SAFE_INTEGER + 1; },
    m => { m.report.description = ' '; },
    m => { m.report.description = 'illegal\ncontrol'; },
    m => { m.report.description = '🚀'.repeat(501); },
    m => { m.report.description = '\u00a0leading'; },
    m => { m.amount = '1.00'; m.report.facts.amount = '1.00'; }
  ];
  for (const mutate of cases) {
    const f = await fixture(); mutate(f.source); f.source = resign(f.source); f.state.revenueEngine.experiments[0].outcomeMeasurement = f.source; await setState(f, f.state);
    await assert.rejects(publish(request(f)), e => ['P0O01','P0O07'].includes(e.code)); await unchanged(f);
  }
  const f = await fixture(); delete f.state.revenueEngine.experiments[0].outcomeMeasurement; f.state.revenueEngine.experiments[0].impact = { verified: true, incrementalContribution: 500 };
  await setState(f, f.state); await assert.rejects(publish(request(f)), code('P0O07')); await unchanged(f);
  const g = await fixture(), r = request(g, { workspaceId: f.workspaceId }); await assert.rejects(publish(r), code('P0O04'));
});

test('incomplete costs/unknown amount/incomplete population and zero-population nonzero never publish', async () => {
  for (const mutate of [m => { m.report.costsComplete = false; }, m => { m.report.costsComplete = null; }, m => { m.amount = null; m.report.facts.amount = null; }, m => { m.coverage.status = 'partial'; m.report.facts.coverage.status = 'partial'; }, m => { m.coverage.observedCount = m.coverage.expectedCount = 0; m.report.facts.coverage = structuredClone(m.coverage); }]) {
    const f = await fixture(); mutate(f.source); f.source = resign(f.source); f.state.revenueEngine.experiments[0].outcomeMeasurement = f.source; await setState(f, f.state);
    await assert.rejects(publish(request(f)), e => ['P0O01','P0O02'].includes(e.code)); await unchanged(f);
  }
  const f = await fixture(); f.source = sourceMeasurement(f.workspaceId, f.experimentId, { amount: '0' });
  f.source.coverage.observedCount = f.source.coverage.expectedCount = 0; f.source.report.facts.coverage = f.source.coverage; f.source = resign(f.source);
  f.state.revenueEngine.experiments[0].outcomeMeasurement = f.source; await setState(f, f.state);
  assert.equal((await publish(request(f))).publication.version.amount, '0');
});

test('bounds, null qualification, unsupported references and zero numeric scale all fail closed', async () => {
  for (const [mutate, expected] of [
    [m => { m.report.description = 'x'.repeat(9000); }, 'P0O10'],
    [m => { m.coverage.status = null; m.report.facts.coverage.status = null; }, 'P0O02'],
    [m => { m.provenance.sourceRefs = [{ type: 'ledger_snapshot', id: 'invented', digest: 'a'.repeat(64) }]; }, 'P0O01']
  ]) {
    const f = await fixture(); mutate(f.source);
    if (expected !== 'P0O01') f.source = resign(f.source);
    else { delete f.source.digest; f.source.digest = hash(f.source); }
    f.state.revenueEngine.experiments[0].outcomeMeasurement = f.source; await setState(f, f.state);
    await assert.rejects(publish(request(f)), code(expected)); await unchanged(f);
  }
  const f = await fixture(); f.source.coverage.observedCount = f.source.coverage.expectedCount = 0;
  f.source.report.facts.coverage = structuredClone(f.source.coverage); f.source = resign(f.source);
  const raw = JSON.stringify(f.source).replaceAll('"observedCount":0', '"observedCount":0.0').replaceAll('"expectedCount":0', '"expectedCount":0.00');
  await assert.rejects(admin.query('SELECT public.runvara_outcome_validate_measurement($1::jsonb,$2,$3,clock_timestamp())', [raw, f.workspaceId, f.experimentId]), code('P0O01'));
});

test('stale workspace, source and head preconditions cannot leave provisional committed outcomes', async () => {
  const f = await fixture();
  await assert.rejects(publish(request(f, { workspaceRevision: randomUUID() })), code('P0O04')); await unchanged(f);
  await assert.rejects(publish(request(f, { measurementDigest: 'a'.repeat(64) })), code('P0O07')); await unchanged(f);
  const first = await publish(request(f)), next = await correction(f, first);
  await assert.rejects(publish({ ...next, headDigest: 'b'.repeat(64) }), code('P0O05'));
  assert.equal((await joined(f))[0].version_id, first.publication.head.versionId);
  const g = await fixture();
  await assert.rejects(admin.query('INSERT INTO public.runvara_business_outcome_heads(workspace_id,outcome_id,version_id) VALUES($1,$2,$3)', [g.workspaceId, first.publication.head.outcomeId, first.publication.head.versionId]), code('23503'));
  await unchanged(g);
});

test('conflicting common tenant markers never confer authority, even with a matching source', async () => {
  for (const path of [[], ['workspace'], ['users', 0], ['revenueEngine'], ['revenueEngine', 'experiments', 0]]) {
    for (const [key, value] of [['workspaceId', 'tenant-b'], ['workspace_id', 'tenant-b'], ['tenantId', 'tenant-b'], ['tenant_id', 'tenant-b'], ['tenant', { id: 'tenant-b' }]]) {
      const f = await fixture(); let row = f.state; for (const part of path) row = row[part]; row[key] = value;
      await setState(f, f.state); await assert.rejects(publish(request(f)), code('P0O01')); await unchanged(f);
    }
  }
});

test('bounded authority/experiment scans and post-patch 2 MiB limit roll all publication writes back', async () => {
  for (const collection of ['users','experiments']) {
    const f = await fixture();
    if (collection === 'users') f.state.users.push(...Array.from({ length: 500 }, (_, i) => ({ id: 'extra' + i })));
    else f.state.revenueEngine.experiments.push(...Array.from({ length: 499 }, (_, i) => ({ id: 'extra' + i })));
    await setState(f, f.state); await assert.rejects(publish(request(f)), code('P0O10')); await unchanged(f);
  }
  const f = await fixture();
  await admin.query("UPDATE public.saas_workspace_state SET state=jsonb_set(state,'{padding}',to_jsonb(repeat('x',2097152-octet_length(jsonb_set(state,'{padding}',to_jsonb(''::text))::text)-100))) WHERE workspace_id=$1", [f.workspaceId]);
  const original = await state(f);
  assert.equal((await admin.query('SELECT octet_length(state::text) bytes FROM public.saas_workspace_state WHERE workspace_id=$1', [f.workspaceId])).rows[0].bytes, 2097152 - 100);
  await assert.rejects(publish(request(f)), code('P0O10')); await unchanged(f, original);
});

test('lost acknowledgement replays immutable receipt; changed intent conflicts; superseded replay does not rewind', async () => {
  const f = await fixture(), req = request(f), c = await connect();
  const first = await publish(req, c); await close(c); // caller loses/discards response after committed transaction
  const replay = await publish(req); assert.deepEqual(replay.publication, first.publication); assert.equal(replay.replayed, true);
  await assert.rejects(publish({ ...req, experimentId: 'changed' }), code('P0O06'));
  const next = await publish(await correction(f, first));
  const old = await publish(req); assert.equal(old.isCurrent, false); assert.deepEqual(old.publication, first.publication);
  assert.equal((await joined(f))[0].version_id, next.publication.head.versionId);
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.audit_events WHERE workspace_id=$1', [f.workspaceId])).rows[0].n, 2);
});

test('correction and final withdrawal preserve predecessor evidence and newer draft', async () => {
  const f = await fixture(), first = await publish(request(f)), corr = await correction(f, first), second = await publish(corr);
  const currentSource = (await state(f)).revenueEngine.experiments[0].outcomeMeasurement;
  assert.deepEqual(second.publication.version, correctBusinessOutcomeCandidate(first.publication.version, candidateInput(currentSource, second.publication.version.verification), { workspaceId: f.workspaceId, now: second.publication.head.committedAt }));
  const s = await state(f), draft = sourceMeasurement(f.workspaceId, f.experimentId, { revision: 3, amount: '777' });
  s.revenueEngine.experiments[0].outcomeMeasurement = draft; s._revision = randomUUID(); await setState(f, s);
  const withdraw = request(f, { action: 'withdraw', workspaceRevision: s._revision, measurementRevision: 2, measurementDigest: currentSource.digest, headVersionId: second.publication.head.versionId, headDigest: second.publication.head.digest, withdrawalReason: 'incorrect_measurement' });
  const result = await publish(withdraw);
  assert.deepEqual(result.publication.version, withdrawBusinessOutcomeCandidate(second.publication.version, { reason: withdraw.withdrawalReason, verification: result.publication.version.verification }, { workspaceId: f.workspaceId, now: result.publication.head.committedAt }));
  assert.deepEqual((await state(f)).revenueEngine.experiments[0].outcomeMeasurement, draft);
  const rows = (await admin.query('SELECT source_measurement FROM public.runvara_business_outcome_versions WHERE workspace_id=$1 ORDER BY revision', [f.workspaceId])).rows;
  assert.deepEqual(rows.map(x => x.source_measurement), [f.source, currentSource, currentSource]);
  assert.deepEqual((await admin.query('SELECT type FROM public.audit_events WHERE workspace_id=$1 ORDER BY type', [f.workspaceId])).rows.map(x => x.type), ['outcome-corrected','outcome-published','outcome-withdrawn']);
  const restore = request(f, { action: 'correct', workspaceRevision: result.publication.head.commitRevision, measurementRevision: 3, measurementDigest: draft.digest, headVersionId: result.publication.head.versionId, headDigest: result.publication.head.digest });
  await assert.rejects(publish(restore), code('P0O08'));
});

test('compact review returns exactly one source and joined current version without writes or full-state leakage', async () => {
  const f = await fixture(); f.state.padding = 'x'.repeat(1_600_000); f.state.revenueEngine.experiments[0].title = 'Bounded review';
  for (let i = 0; i < 100; i++) f.state.revenueEngine.experiments.push({ id: 'other' + i, outcomeMeasurement: { marker: 'unrelated report', large: 'x'.repeat(100) } });
  await setState(f, f.state);
  const draft = await review(f);
  assert.deepEqual(draft, { workspaceId: f.workspaceId, workspaceRevision: f.state._revision, experiment: { id: f.experimentId, title: 'Bounded review', status: 'measured' }, measurement: f.source, current: null, actionLinkContract: 'runvara-reviewed-action/v1', actionChoices: [], currentActionAssociation: null });
  assert.ok(Buffer.byteLength(JSON.stringify(draft)) < 12000); await unchanged(f);
  const publication = await publish(request(f)), before = await state(f), current = await joined(f);
  await using('service_role', async c => { await c.query('BEGIN READ ONLY');
    const read = await review(f, c); await c.query('COMMIT');
    assert.deepEqual(read.measurement, f.source); assert.deepEqual(read.current, current[0]);
    assert.equal(read.workspaceRevision, publication.publication.head.commitRevision);
    assert.equal(read.current.version.source_measurement, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(read)) < 32768);
    assert.ok(!JSON.stringify(read).includes('unrelated report')); assert.ok(!JSON.stringify(read).includes('secretNeverReturned'));
  });
  assert.deepEqual(await state(f), before); assert.deepEqual(await joined(f), current);
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.audit_events WHERE workspace_id=$1', [f.workspaceId])).rows[0].n, 1);
});

test('review rejects ambiguous targets, scope conflicts and oversized source instead of returning broad data', async () => {
  for (const mutate of [s => { s.workspaceId = 'tenant-b'; }, s => { s.workspace.tenantId = 'tenant-b'; }, s => { s.revenueEngine.workspace = { id: 'tenant-b' }; }, s => { s.revenueEngine.experiments[0].workspace_id = 'tenant-b'; }]) {
    const f = await fixture(); mutate(f.state); await setState(f, f.state); await assert.rejects(review(f), code('P0O01')); await unchanged(f);
  }
  const f = await fixture(); f.state.revenueEngine.experiments.push(structuredClone(f.state.revenueEngine.experiments[0])); await setState(f, f.state);
  await assert.rejects(review(f), code('P0O09')); await unchanged(f);
  const g = await fixture(); g.state.revenueEngine.experiments[0].outcomeMeasurement = { large: 'x'.repeat(13000) }; await setState(g, g.state);
  await assert.rejects(review(g), code('P0O10')); await unchanged(g);
  await assert.rejects(review({ workspaceId: 'missing-workspace', experimentId: f.experimentId }), code('P0O09'));
});

test('two independent initial publishers and corrections serialize; identical concurrent retry replays', async () => {
  for (const correcting of [false, true]) for (const sameIntent of [false, true]) {
    const f = await fixture();
    const req = correcting ? await correction(f, await publish(request(f))) : request(f);
    const a = await connect(), b = await connect();
    await a.query('BEGIN'); await a.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1 FOR UPDATE', [f.workspaceId]);
    const apid = (await a.query('SELECT pg_backend_pid() pid')).rows[0].pid, bpid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const pending = publish(sameIntent ? req : { ...req, publicationId: randomUUID() }, b).then(value => ({ value }), error => ({ error }));
    await blocked(bpid, apid);
    const winner = await publish(req, a); await a.query('COMMIT');
    const loser = await pending;
    if (sameIntent) { assert.equal(loser.value.replayed, true); assert.deepEqual(loser.value.publication, winner.publication); }
    else assert.equal(loser.error.code, 'P0O04');
    assert.equal((await admin.query('SELECT count(*)::int n FROM public.runvara_business_outcome_versions WHERE workspace_id=$1', [f.workspaceId])).rows[0].n, correcting ? 2 : 1);
    await close(a); await close(b);
  }
});

test('publication uses actual wall clock after the lock wait, not transaction-start time', async () => {
  const f = await fixture(), a = await connect(), b = await connect();
  const future = (await admin.query(`SELECT to_char(date_trunc('milliseconds',clock_timestamp()+interval '500 milliseconds') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') t`)).rows[0].t;
  f.source.recordedAt = future; f.source.report.recordedAt = future; f.source = resign(f.source);
  f.state.revenueEngine.experiments[0].outcomeMeasurement = f.source; await setState(f, f.state);
  await a.query('BEGIN'); await a.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1 FOR UPDATE', [f.workspaceId]);
  const apid = (await a.query('SELECT pg_backend_pid() pid')).rows[0].pid, bpid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const pending = publish(request(f), b).then(value => ({ value }), error => ({ error }));
  await blocked(bpid, apid); await delay(550); await a.query('COMMIT');
  const result = await pending; assert.equal(result.error, undefined); assert.ok(result.value.publication.head.committedAt >= future);
  await close(a); await close(b);
});

test('authorization rotates while publisher waits: changed session or password requirement is denied', async () => {
  for (const field of ['sessionVersion','passwordChangeRequired']) {
    const f = await fixture(), a = await connect(), b = await connect();
    await a.query('BEGIN'); await a.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1 FOR UPDATE', [f.workspaceId]);
    const apid = (await a.query('SELECT pg_backend_pid() pid')).rows[0].pid, bpid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const pending = publish(request(f), b).then(value => ({ value }), error => ({ error }));
    await blocked(bpid, apid);
    await a.query("UPDATE public.saas_workspace_state SET state=jsonb_set(state,ARRAY['users','0',$2],$3::jsonb) WHERE workspace_id=$1", [f.workspaceId, field, field === 'sessionVersion' ? '2' : 'true']);
    await a.query('COMMIT'); assert.equal((await pending).error.code, 'P0O03');
    assert.equal((await joined(f)).length, 0); await close(a); await close(b);
  }
});

test('review takes no row lock and source/head share the snapshot during correction', async () => {
  const f = await fixture(), first = await publish(request(f)), a = await connect(), b = await connect();
  await a.query('BEGIN'); await a.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1 FOR UPDATE', [f.workspaceId]);
  let unlocked;
  try { unlocked = await Promise.race([review(f, b), delay(1500).then(() => { throw new Error('Review incorrectly waited for a row lock'); })]); }
  finally { await a.query('ROLLBACK'); }
  assert.equal(unlocked.current.version_id, first.publication.head.versionId);
  await b.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const before = await review(f, b), next = await publish(await correction(f, first));
  assert.deepEqual(await review(f, b), before); await b.query('COMMIT');
  const latest = await review(f, b);
  assert.equal(latest.current.version_id, next.publication.head.versionId);
  assert.equal(latest.measurement.digest, next.publication.version.source.measurementDigest);
  assert.equal(latest.workspaceRevision, next.publication.head.commitRevision);
  await close(a); await close(b);
});

test('one statement head/version reads remain consistent through a concurrent correction', async () => {
  const f = await fixture(), first = await publish(request(f)), r = await connect();
  await r.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const before = await joined(f, r), next = await publish(await correction(f, first));
  assert.deepEqual(await joined(f, r), before); await r.query('COMMIT');
  const after = await joined(f, r);
  assert.equal(after[0].version_id, next.publication.head.versionId);
  assert.equal(after[0].version.payload.versionId, after[0].version_id);
  assert.equal(after[0].version.payload.digest, after[0].version.digest);
  assert.equal(before[0].version_id, first.publication.head.versionId); await close(r);
});

test('failure after version/head writes rolls the entire publication back', async () => {
  const f = await fixture();
  await admin.query(`CREATE FUNCTION public.outcome_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.state->>'outcomeTestFail'='yes' THEN RAISE EXCEPTION USING ERRCODE='P0T01',MESSAGE='synthetic post-write failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER outcome_test_failure BEFORE UPDATE ON public.saas_workspace_state FOR EACH ROW EXECUTE FUNCTION public.outcome_test_failure()`);
  // Insert flag via original INSERT-free test path: trigger only rejects UPDATE
  await admin.query('ALTER TABLE public.saas_workspace_state DISABLE TRIGGER outcome_test_failure');
  f.state.outcomeTestFail = 'yes'; await setState(f, f.state);
  await admin.query('ALTER TABLE public.saas_workspace_state ENABLE TRIGGER outcome_test_failure');
  try { await assert.rejects(publish(request(f)), code('P0T01')); await unchanged(f); }
  finally { await admin.query('DROP TRIGGER outcome_test_failure ON public.saas_workspace_state; DROP FUNCTION public.outcome_test_failure()'); }
});

test('audit insert failure rolls back workspace, head and version as one transaction', async () => {
  const f = await fixture();
  await admin.query(`CREATE FUNCTION public.outcome_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION USING ERRCODE='P0T02',MESSAGE='synthetic audit failure'; END $$;
    CREATE TRIGGER outcome_test_audit_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.outcome_test_audit_failure()`);
  try { await assert.rejects(publish(request(f)), code('P0T02')); await unchanged(f); }
  finally { await admin.query('DROP TRIGGER outcome_test_audit_failure ON public.audit_events; DROP FUNCTION public.outcome_test_audit_failure()'); }
});

test('service has SELECT plus sole publisher capability; browsers/generic mutation/copy/delete cannot publish', async () => {
  const f = await fixture(), receipt = await publish(request(f));
  for (const role of ['anon', 'authenticated']) {
    await using(role, async c => {
      await assert.rejects(c.query('SELECT * FROM public.runvara_business_outcome_heads'), code('42501'));
      await assert.rejects(publish(request(f), c), code('42501'));
      await assert.rejects(review(f, c), code('42501'));
    });
  }
  async function check() {
    await assertOutcomeSecurity();
    assert.deepEqual(await ledgerAcl(), originalLedgerAcl, 'Bootstrap must preserve every approved usage-ledger table/column privilege');
    const usage = originalLedgerAcl.find(x => x.relname === 'runvara_ai_usage'), windows = originalLedgerAcl.find(x => x.relname === 'runvara_provider_usage_windows'), reservations = originalLedgerAcl.find(x => x.relname === 'runvara_provider_usage_reservations');
    assert.equal(usage.can_select && usage.can_insert, true); assert.equal(usage.can_update || usage.can_delete, false);
    assert.equal(windows.can_select && windows.can_insert && windows.can_update, true); assert.equal(windows.can_delete, false);
    assert.equal(reservations.can_select && reservations.can_insert, true); assert.equal(reservations.can_update || reservations.can_delete, false);
    assert.deepEqual(reservations.update_columns, ['status','observed_input_tokens','observed_cached_input_tokens','observed_cache_write_tokens','observed_output_tokens','observed_total_tokens','accounted_cost_micros','provider_request_id','settlement_fingerprint','error_code','updated_at','settled_at'].sort());
    assert.ok(originalLedgerAcl.every(x => x.relrowsecurity && !x.anon_select && !x.auth_select));
    await using('service_role', async c => {
      assert.equal((await joined(f, c)).length, 1);
      for (const sql of [
        'DELETE FROM public.runvara_ai_usage', 'UPDATE public.runvara_ai_usage SET input_tokens=input_tokens',
        'DELETE FROM public.runvara_provider_usage_windows', 'DELETE FROM public.runvara_provider_usage_reservations',
        'UPDATE public.runvara_provider_usage_reservations SET reserved_input_tokens=reserved_input_tokens',
        'UPDATE public.runvara_provider_usage_reservations SET pricing_snapshot=pricing_snapshot',
        'DELETE FROM public.runvara_business_outcome_versions', 'UPDATE public.runvara_business_outcome_versions SET payload=payload',
        'TRUNCATE public.runvara_business_outcome_versions', 'DELETE FROM public.runvara_business_outcome_heads',
        'UPDATE public.runvara_business_outcome_heads SET version_id=version_id',
        'UPDATE public.runvara_business_outcome_versions SET source_action=source_action',
        "SELECT public.runvara_outcome_validate_source_action('{}'::jsonb,'test')",
        "SELECT public.runvara_outcome_resolve_action('{}'::jsonb,'test','write')",
        'INSERT INTO public.runvara_business_outcome_versions SELECT * FROM public.runvara_business_outcome_versions',
        'INSERT INTO public.runvara_business_outcome_heads SELECT * FROM public.runvara_business_outcome_heads',
        "SELECT public.runvara_outcome_hash('{}'::jsonb)", "SELECT public.runvara_outcome_canonical('{}'::jsonb)"]) {
        await assert.rejects(c.query(sql), code('42501'));
      }
      const p = (await c.query('SELECT has_function_privilege(current_user,$1,\'EXECUTE\') AS allowed', [RPC_SIGNATURE])).rows[0]; assert.equal(p.allowed, true);
      assert.equal((await c.query('SELECT has_function_privilege(current_user,$1,\'EXECUTE\') AS allowed', [REVIEW_SIGNATURE])).rows[0].allowed, true);
      assert.equal((await review(f, c)).current.version_id, receipt.publication.head.versionId);
    });
    const meta = (await admin.query(`SELECT c.relname,c.relrowsecurity FROM pg_class c WHERE c.oid IN ('public.runvara_business_outcome_versions'::regclass,'public.runvara_business_outcome_heads'::regclass)`)).rows;
    assert.ok(meta.every(x => x.relrowsecurity));
    const definer = (await admin.query('SELECT prosecdef,proconfig,proowner::regrole::text owner FROM pg_proc WHERE oid=$1::regprocedure', [RPC_SIGNATURE])).rows[0];
    const reader = (await admin.query('SELECT prosecdef,provolatile,proconfig FROM pg_proc WHERE oid=$1::regprocedure', [REVIEW_SIGNATURE])).rows[0];
    assert.equal(reader.prosecdef, false); assert.equal(reader.provolatile, 's'); assert.ok(reader.proconfig.includes('search_path=\"\"'));
    assert.equal(definer.prosecdef, true); assert.equal(definer.owner, 'postgres'); assert.ok(definer.proconfig.includes('search_path=""'));
    const reporter = (await admin.query('SELECT prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure', [REPORTING_SIGNATURE])).rows[0];
    assert.equal(reporter.prosecdef, false); assert.ok(reporter.proconfig.includes('search_path=""'));
    for (const role of ['service_role', 'anon', 'authenticated']) {
      const allowed = (await admin.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') allowed', [role, REPORTING_SIGNATURE])).rows[0].allowed;
      assert.equal(allowed, role === 'service_role', 'outcome migration/bootstrap must preserve reporting function access');
    }
  }
  await admin.query('REVOKE SELECT ON public.saas_workspace_state FROM service_role');
  try { await assert.rejects(review(f), code('42501')); } finally { await admin.query('GRANT SELECT ON public.saas_workspace_state TO service_role'); }
  await check(); await admin.query(baseline); await check(); await admin.query(baseline); await check();
  await assert.rejects(admin.query('UPDATE public.runvara_business_outcome_versions SET payload=payload WHERE workspace_id=$1', [f.workspaceId]), code('P0O11'));
  await assert.rejects(admin.query('DELETE FROM public.runvara_business_outcome_versions WHERE workspace_id=$1', [f.workspaceId]), code('P0O11'));
  await assert.rejects(admin.query('TRUNCATE public.runvara_business_outcome_versions CASCADE'), code('P0O11'));
  assert.equal((await joined(f))[0].version_id, receipt.publication.head.versionId);
  // Unrelated operational history remains under the pre-existing server ACL.
  await using('service_role', c => c.query("INSERT INTO public.runvara_history(workspace_id,collection,record_id,payload) VALUES($1,'agentRuns','legacy','{\"verified\":true}')", [f.workspaceId]));
});

test('reviewed source canonical/dispatch goldens agree with independent JS for escaped, unicode and policy snapshots', async () => {
  for (const options of [{}, { policyCount: 3 }, { policyCount: 50 }, { description: '&<>\n\r\t\b\f"\\ 雪 😀\u2028\u2029' }]) {
    const f = await linkedFixture(options);
    const r = (await admin.query(`SELECT public.runvara_outcome_validate_source_action($1::jsonb,$2) source,
      public.runvara_outcome_resolve_action($3::jsonb,$2,$4) resolved,
      public.runvara_outcome_action_request_digest($5::jsonb,$6,$7) dispatch,public.runvara_outcome_action_identity_digest($1::jsonb) identity`, [f.sourceAction, f.workspaceId, f.state, f.write.id, f.write.input, f.write.account, f.sourceAction.context.apiVersion])).rows[0];
    assert.deepEqual(r.source, f.sourceAction); assert.deepEqual(r.resolved, f.sourceAction);
    if (options.policyCount === 3) {
      const scaled = JSON.stringify(f.sourceAction).replaceAll('"revision":1,', '"revision":1.000,');
      const normalized = (await admin.query('SELECT public.runvara_outcome_validate_source_action($1::jsonb,$2) source', [scaled, f.workspaceId])).rows[0].source;
      assert.deepEqual(normalized, f.sourceAction);
    }
    assert.equal(r.dispatch, f.sourceAction.context.dispatchRequestDigest); assert.equal(r.identity, f.sourceAction.context.claimIdentity);
    const candidate = await publish(request(f));
    assert.deepEqual(await storedAction(f, candidate.publication.head.versionId), f.sourceAction);
    assert.deepEqual(candidate.publication.version.links.action, f.source.intervention.action);
    assert.equal(candidate.publication.version.links.objective, null); assert.equal(candidate.publication.version.links.opportunity, null);
    assert.equal(candidate.publication.version.publicationAuthority, false); assert.equal(candidate.publication.version.sourceReferencesResolved, false);
    assert.equal(candidate.publication.version.runvaraAttribution, 'unestablished');
    assert.ok(!JSON.stringify(candidate).includes(f.write.input.description));
  }
});

test('unlinked v1 stores null action and immutable reviewed v2 stores the exact selected source', async () => {
  const legacy = await fixture(), l = await publish(request(legacy)); assert.equal(await storedAction(legacy, l.publication.head.versionId), null);
  const f = await linkedFixture({ policyCount: 2 }), r = await publish(request(f));
  assert.deepEqual(await storedAction(f, r.publication.head.versionId), f.sourceAction);
  const selected = await review(f);
  assert.deepEqual(selected.currentActionAssociation, f.source.intervention);
  assert.deepEqual(selected.actionChoices, [{ id: f.write.id, account: f.write.account, productId: f.write.input.productId, title: f.write.input.title, completedAt: f.write.completedAt, digest: f.sourceAction.digest }]);
  assert.equal(selected.current.version.source_action, undefined); assert.equal(selected.current.version.source_measurement, undefined);
  assert.equal(JSON.stringify(selected).includes(f.write.input.description), false);
  const saved = await state(f); saved.connectionWrites[0].input.description = 'mutated after publication'; delete saved.approvals; delete saved.connections; await setState(f, saved);
  assert.deepEqual(await storedAction(f, r.publication.head.versionId), f.sourceAction);
  await assert.rejects(admin.query('UPDATE public.runvara_business_outcome_versions SET source_action=NULL WHERE workspace_id=$1', [f.workspaceId]), code('P0O11'));
});

test('fresh evidence rejects fabricated/legacy completions and changed write, claim, result, decision, connection or nested tenant', async () => {
  const mutations = [
    f => { delete f.write.recordedActionContext; }, f => { f.write.recordedActionContext.acknowledged = true; },
    f => { f.write.status = 'processing'; }, f => { f.write.status = 'uncertain'; }, f => { f.write.status = 'failed'; },
    f => { f.write.provider = 'meta'; }, f => { f.write.account = 'other.myshopify.com'; }, f => { f.write.requestId += '_changed'; },
    f => { f.write.connectionId = 'other'; }, f => { f.write.input.title = 'modified input'; }, f => { f.write.requiresApproval = false; },
    f => { f.write.dispatchClaim.id += 'changed'; }, f => { f.write.dispatchClaim.identity = 'a'.repeat(64); }, f => { f.write.dispatchClaim.authority = 'malformed'; }, f => { f.write.dispatchClaim.workspaceId = 'foreign'; },
    f => { f.write.dispatchClaim.phases.shopify_mutation.requestDigest = 'a'.repeat(64); }, f => { f.write.dispatchClaim.phases.shopify_mutation.status = 'claimed'; },
    f => { f.write.dispatchClaim.phases.shopify_mutation.at = '2026-01-02T00:00:00.000Z'; }, f => { f.write.dispatchClaim.phases.other = {}; }, f => { f.write.dispatchClaim.phases.shopify_mutation.acknowledged = true; },
    f => { delete f.write.result; }, f => { f.write.result.externalId = 'gid://shopify/Product/456'; }, f => { f.write.result.acknowledged = true; },
    f => { f.write.observationErrorCode = 'WRITE_RESULT_UNKNOWN'; }, f => { f.write.errorCode = 'WRITE_FAILED'; }, f => { f.write.dispatchBlocked = true; },
    f => { f.approval.status = 'rejected'; }, f => { f.approval.revision = 2; }, f => { f.approval.revision = null; }, f => { f.approval.decidedBy = 'another'; },
    f => { f.approval.decidedAt = '2026-01-01T00:00:00.500Z'; }, f => { f.approval.payload.digest = 'a'.repeat(64); }, f => { f.approval.payload.connectionWriteId = 'other'; },
    f => { f.approval.type = 'integration_change'; }, f => { f.state.connectionWrites.push(structuredClone(f.write)); },
    f => { const duplicate = structuredClone(f.write); duplicate.id = 'another'; duplicate.dispatchClaim.id = 'different-claim'; f.state.connectionWrites.push(duplicate); },
    f => { const duplicate = structuredClone(f.write); duplicate.id = 'another'; duplicate.requestId = 'different_request_00001'; f.state.connectionWrites.push(duplicate); }, f => { f.state.approvals.push(structuredClone(f.approval)); },
    f => { f.state.connections.push(structuredClone(f.connection)); }, f => { f.connection.metadata.shopDomain = 'other.myshopify.com'; }, f => { f.connection.provider = 'meta'; },
    f => { f.write.unrelated = { nested: { tenant_id: 'foreign' } }; }, f => { f.approval.payload.metadata = { workspaceId: 'foreign' }; },
    f => { f.connection.metadata.nested = { workspace: { id: 'foreign' } }; }, f => { f.write.recordedActionContext.snapshotDigest = 'a'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const f = await linkedFixture(); mutate(f); await setState(f, f.state);
    await assert.rejects(publish(request(f)), code('P0O01')); await unchanged(f);
  }
});

test('strict source and intervention shapes reject caller inventions even after all easy hashes are recomputed', async () => {
  for (const mutate of [
    s => { s.context.claimIdentity = 'malformed'; }, s => { s.context.requestId = 'copied_claim_000000000'; }, s => { s.context.requestedBy = 'other-requester'; }, s => { s.context.apiVersion = '2026-08'; }, s => { s.context.provider = 'meta'; },
    s => { s.context.origin = 'objective'; }, s => { s.context.originatingObjective = { id: 'invented' }; }, s => { s.context.completedAt = '2026-02-30T00:00:00.000Z'; },
    s => { s.context.dispatchRequestDigest = 'a'.repeat(64); }, s => { s.context.inputDigest = 'a'.repeat(64); }, s => { s.context.resultId = 'gid://shopify/Product/9'; },
    s => { s.context.approval.revision = 2; s.context.approval.digest = hash(Object.fromEntries(Object.entries(s.context.approval).filter(([k]) => k !== 'digest'))); },
    s => { s.context.approval.payload.ownerNote = 'invented'; s.context.approval.digest = hash(Object.fromEntries(Object.entries(s.context.approval).filter(([k]) => k !== 'digest'))); },
    s => { s.context.policies.push({ objectiveId: 'invented', revision: 1, digest: 'a'.repeat(64) }); },
  ]) {
    const f = await linkedFixture(), s = structuredClone(f.sourceAction); mutate(s); s.digest = hash(Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'digest')));
    await assert.rejects(admin.query('SELECT public.runvara_outcome_validate_source_action($1::jsonb,$2)', [s, f.workspaceId]), code('P0O01'));
  }
  for (const mutate of [
    m => { m.intervention.relationship = 'caused'; }, m => { m.intervention.comparison = 'holdout'; }, m => { m.intervention.action.revision = 2; },
    m => { m.intervention.action.workspaceId = 'foreign'; }, m => { m.intervention.approval.digest = 'a'.repeat(64); }, m => { m.intervention.completedAt = '2026-01-03T00:00:00.001Z'; },
    m => { m.intervention.account = 'other.myshopify.com'; }, m => { m.intervention.productId = 'gid://shopify/Product/9'; }, m => { m.intervention.reuseVersionId = 'invalid'; },
    m => { m.links.objective = m.intervention.action; }, m => { m.intervention.sourceAction = {}; },
  ]) {
    const f = await linkedFixture(); mutate(f.source); f.source.report.facts.intervention = structuredClone(f.source.intervention); f.source = resign(f.source);
    f.state.revenueEngine.experiments[0].outcomeMeasurement = f.source; await setState(f, f.state);
    await assert.rejects(publish(request(f)), code('P0O01')); await unchanged(f);
  }
});

test('all recorded policy refs survive without becoming an objective origin, and changed proposal bindings fail', async () => {
  const f = await linkedFixture({ policyCount: 3 });
  f.state.businessObjectives = [{ id: 'later-objective', target: 25.5, revision: 9 }]; await setState(f, f.state);
  const result = await publish(request(f)); assert.deepEqual((await storedAction(f, result.publication.head.versionId)).context.policies, f.sourceAction.context.policies);
  assert.equal(result.publication.version.links.objective, null);
  for (const mutate of [
    g => { g.write.objectivePolicyProposal.policies[0].revision++; }, g => { g.write.objectivePolicyProposal.policies.pop(); },
    g => { g.approval.payload.objectivePolicyProposalDigest = 'a'.repeat(64); }, g => { delete g.write.objectivePolicyProposal; },
  ]) {
    const g = await linkedFixture({ policyCount: 3 }); mutate(g); await setState(g, g.state); await assert.rejects(publish(request(g)), code('P0O01')); await unchanged(g);
  }
});

async function linkedCorrection(f, previous, { source = f.sourceAction, reuseVersionId = null } = {}) {
  const s = await state(f), measurement = linkedMeasurement(f.workspaceId, f.experimentId, source, { revision: previous.publication.version.source.measurementRevision + 1, amount: '44.5', reuseVersionId });
  s.revenueEngine.experiments[0].outcomeMeasurement = measurement; s._revision = randomUUID(); await setState(f, s);
  return request(f, { action: 'correct', workspaceRevision: s._revision, measurementRevision: measurement.revision, measurementDigest: measurement.digest,
    headVersionId: previous.publication.head.versionId, headDigest: previous.publication.head.digest });
}

test('correction explicitly reuses immutable source after mutable records are removed; withdrawal copies source and keeps newer draft', async () => {
  const f = await linkedFixture({ policyCount: 3 }), firstReq = request(f), first = await publish(firstReq);
  const s = await state(f); delete s.connectionWrites; delete s.approvals; delete s.connections; delete s.businessObjectives; await setState(f, s);
  const correctionReq = await linkedCorrection(f, first, { reuseVersionId: first.publication.head.versionId });
  const second = await publish(correctionReq); assert.deepEqual(await storedAction(f, second.publication.head.versionId), f.sourceAction);
  assert.deepEqual(await storedAction(f, first.publication.head.versionId), f.sourceAction);
  const replay = await publish(firstReq); assert.equal(replay.replayed, true); assert.equal(replay.isCurrent, false); assert.deepEqual(replay.publication, first.publication);
  const before = await state(f), laterDraft = sourceMeasurement(f.workspaceId, f.experimentId, { revision: 3 }); before.revenueEngine.experiments[0].outcomeMeasurement = laterDraft; await setState(f, before);
  const last = await publish(request(f, { action: 'withdraw', workspaceRevision: before._revision, measurementRevision: second.publication.version.source.measurementRevision,
    measurementDigest: second.publication.version.source.measurementDigest, headVersionId: second.publication.head.versionId, headDigest: second.publication.head.digest, withdrawalReason: 'evidence_retracted' }));
  assert.deepEqual(await storedAction(f, last.publication.head.versionId), f.sourceAction);
  assert.deepEqual((await state(f)).revenueEngine.experiments[0].outcomeMeasurement, laterDraft);
  assert.equal(last.publication.head.status, 'withdrawn');
  const selected = await review(f); assert.deepEqual(selected.currentActionAssociation, linkedMeasurement(f.workspaceId, f.experimentId, f.sourceAction, { reuseVersionId: first.publication.head.versionId }).intervention);
  const restore = await linkedCorrection(f, last, { reuseVersionId: first.publication.head.versionId }); await assert.rejects(publish(restore), code('P0O08'));
});

test('reuse is tenant/outcome/version/digest exact, never a fresh fallback or an initial-publication shortcut', async () => {
  const foreign = await linkedFixture(), foreignResult = await publish(request(foreign));
  for (const choice of ['foreign', 'nonexistent', 'mismatched-source', 'initial']) {
    const f = await linkedFixture(); let previous = null;
    if (choice !== 'initial') previous = await publish(request(f));
    const reuseVersionId = choice === 'foreign' ? foreignResult.publication.head.versionId : choice === 'nonexistent' ? 'outcome_version_' + 'a'.repeat(64) : previous?.publication.head.versionId || foreignResult.publication.head.versionId;
    let r;
    if (choice === 'initial') { f.source = linkedMeasurement(f.workspaceId, f.experimentId, f.sourceAction, { reuseVersionId }); f.state.revenueEngine.experiments[0].outcomeMeasurement = f.source; await setState(f, f.state); r = request(f); }
    else {
      const source = choice === 'mismatched-source' ? actionFixture(f.workspaceId, { id: 'different-write' }).sourceAction : f.sourceAction;
      r = await linkedCorrection(f, previous, { source, reuseVersionId });
    }
    const before = await state(f); await assert.rejects(publish(r), code('P0O01')); assert.deepEqual(await state(f), before);
    assert.equal((await admin.query('SELECT count(*)::int n FROM public.runvara_business_outcome_versions WHERE workspace_id=$1', [f.workspaceId])).rows[0].n, previous ? 1 : 0);
  }
});

test('new selected action needs fresh reviewed source; removing association returns to unchanged v1', async () => {
  const f = await linkedFixture(), first = await publish(request(f)), newer = actionFixture(f.workspaceId, { id: 'write-second', description: 'Second exact action' });
  const s = await state(f); s.connectionWrites = [newer.write]; s.approvals = [newer.approval]; await setState(f, s);
  const second = await publish(await linkedCorrection(f, first, { source: newer.sourceAction }));
  assert.deepEqual(await storedAction(f, second.publication.head.versionId), newer.sourceAction); assert.deepEqual(await storedAction(f, first.publication.head.versionId), f.sourceAction);
  const third = await publish(await correction(f, second, 3)); assert.equal(await storedAction(f, third.publication.head.versionId), null); assert.equal(third.publication.version.links.action, null);
});

test('reviewed publication enforces source byte/UTF16 limits without truncation and caps compact choices', async () => {
  for (const options of [{ description: 'x'.repeat(10001) }, { description: '雪'.repeat(9000) }, { description: '"'.repeat(10000), policyCount: 50 }]) {
    const f = await linkedFixture(options); await assert.rejects(publish(request(f)), e => { assert.ok(['P0O01','P0O10'].includes(e.code), e.message); return true; }); await unchanged(f);
  }
  const f = await linkedFixture({ description: '雪'.repeat(5000), policyCount: 3 }), r = await publish(request(f)); assert.deepEqual(await storedAction(f, r.publication.head.versionId), f.sourceAction);
  assert.ok(Buffer.byteLength(JSON.stringify({ source: f.source, sourceAction: f.sourceAction, publication: r.publication })) < 131072);
  const s = await state(f);
  s.connectionWrites = Array.from({ length: 22 }, (_, i) => actionFixture(f.workspaceId, { id: 'choice-' + i }).write);
  s.connectionWrites.push(structuredClone(s.connectionWrites[0])); await setState(f, s);
  const result = await review(f); assert.equal(result.actionChoices.length, 20); assert.ok(result.actionChoices.every(c => c.id !== 'choice-0'));
  assert.ok(result.actionChoices.every(c => Object.keys(c).sort().join(',') === 'account,completedAt,digest,id,productId,title'));
});

test('action edits after review and while waiting for workspace lock cannot publish stale evidence', async () => {
  const f = await linkedFixture(), requestBeforeEdit = request(f), holder = await connect('postgres'), publisher = await connect();
  try {
    await holder.query('BEGIN'); await holder.query('SELECT 1 FROM public.saas_workspace_state WHERE workspace_id=$1 FOR UPDATE', [f.workspaceId]);
    const pid = (await publisher.query('SELECT pg_backend_pid() pid')).rows[0].pid, holderPid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const pending = publish(requestBeforeEdit, publisher); const rejected = assert.rejects(pending, code('P0O01')); await blocked(pid, holderPid);
    const edited = structuredClone(f.state); edited.connectionWrites[0].result.externalId = 'gid://shopify/Product/9';
    await holder.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1', [f.workspaceId, edited]); await holder.query('COMMIT');
    await rejected; await unchanged(f, edited);
  } finally { await holder.query('ROLLBACK'); await close(holder); await close(publisher); }
});

test('linked racing publishers, corrections and exact lost-response replay remain linearizable', async () => {
  const f = await linkedFixture(), req = request(f), c1 = await connect(), c2 = await connect();
  try {
    const [a,b] = await Promise.all([publish(req,c1),publish(req,c2)]); assert.equal([a,b].filter(r => r.replayed).length,1); assert.deepEqual(a.publication,b.publication);
    const correctionReq = await linkedCorrection(f,a,{reuseVersionId:a.publication.head.versionId});
    const results = await Promise.allSettled([publish(correctionReq,c1),publish({...correctionReq,publicationId:randomUUID()},c2)]);
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1); assert.equal(results.find(x=>x.status==='rejected').reason.code,'P0O04');
    assert.equal((await admin.query('SELECT count(*)::int n FROM public.runvara_business_outcome_versions WHERE workspace_id=$1 AND source_action IS NOT NULL',[f.workspaceId])).rows[0].n,2);
  } finally { await close(c1); await close(c2); }
});

test('audit and state failures roll back action snapshot/version/head/targeted state together', async () => {
  for (const target of ['audit_events','saas_workspace_state']) {
    const f = await linkedFixture();
    await admin.query(`CREATE FUNCTION public.outcome_action_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P0T03',MESSAGE='synthetic rollback'; END $$;
      CREATE TRIGGER outcome_action_test_failure BEFORE ${target === 'audit_events' ? 'INSERT' : 'UPDATE'} ON public.${target} FOR EACH ROW EXECUTE FUNCTION public.outcome_action_test_failure()`);
    try { await assert.rejects(publish(request(f)),code('P0T03')); await unchanged(f); }
    finally { await admin.query(`DROP TRIGGER outcome_action_test_failure ON public.${target}; DROP FUNCTION public.outcome_action_test_failure()`); }
  }
});

test('source-specific security remains exact after linked versions and repeated bootstrap', async () => {
  const f = await linkedFixture(); await publish(request(f));
  for (let i=0;i<2;i++) { await admin.query(baseline); await assertOutcomeSecurity(); }
  await using('service_role',async c => {
    for (const sql of ['UPDATE public.runvara_business_outcome_versions SET source_action=NULL','DELETE FROM public.runvara_business_outcome_versions','TRUNCATE public.runvara_business_outcome_versions',
      'INSERT INTO public.runvara_business_outcome_versions SELECT * FROM public.runvara_business_outcome_versions',"SELECT public.runvara_outcome_action_request_digest('{}','test','2026-07')"]) await assert.rejects(c.query(sql),code('42501'));
  });
  await assert.rejects(admin.query('UPDATE public.runvara_business_outcome_versions SET source_action=source_action WHERE workspace_id=$1',[f.workspaceId]),code('P0O11'));
});

test('source canonical bound admits exactly 24 KiB, rejects one byte over and counts astral input as UTF16', async () => {
  const f = await fixture(), empty = actionFixture(f.workspaceId, { description: '' });
  const room = 24576 - Buffer.byteLength(canonical(empty.sourceAction));
  assert.ok(room > 0);
  const description = '雪'.repeat(Math.floor(room / 3)) + 'x'.repeat(room % 3);
  withAction(f, { description }); assert.equal(Buffer.byteLength(canonical(f.sourceAction)), 24576); await setState(f, f.state);
  const r = await publish(request(f)); assert.deepEqual(await storedAction(f, r.publication.head.versionId), f.sourceAction);
  const sourceBytes = (await admin.query(`SELECT octet_length(public.runvara_outcome_canonical(source_action)) source_canonical_bytes,
    octet_length(source_action::text) source_jsonb_bytes,octet_length(payload::text) payload_jsonb_bytes,
    octet_length(source_measurement::text) source_measurement_jsonb_bytes
    FROM public.runvara_business_outcome_versions WHERE workspace_id=$1 AND version_id=$2`, [f.workspaceId, r.publication.head.versionId])).rows[0];
  assert.equal(sourceBytes.source_canonical_bytes,24576); assert.ok(sourceBytes.source_jsonb_bytes<=32768);
  console.log('REVIEWED_ACTION_MAX_SOURCE_BYTES=' + JSON.stringify(sourceBytes));
  const g = await fixture(), emptyG = actionFixture(g.workspaceId, { description: '' }), remaining = 24577 - Buffer.byteLength(canonical(emptyG.sourceAction));
  withAction(g, { description: '雪'.repeat(Math.floor(remaining / 3)) + 'x'.repeat(remaining % 3) });
  assert.equal(Buffer.byteLength(canonical(g.sourceAction)), 24577); await setState(g, g.state); await assert.rejects(publish(request(g)), code('P0O10')); await unchanged(g);
  for (const count of [5000, 5001]) {
    const astral = await linkedFixture({ description: '😀'.repeat(count) });
    if (count === 5000) assert.deepEqual(await storedAction(astral, (await publish(request(astral))).publication.head.versionId), astral.sourceAction);
    else { await assert.rejects(publish(request(astral)), code('P0O01')); await unchanged(astral); }
  }
});

test('reuse cannot cross two experiments in the same workspace', async () => {
  const f = await linkedFixture(), other = linkedMeasurement(f.workspaceId, 'other', f.sourceAction);
  f.state.revenueEngine.experiments[1].outcomeMeasurement = other; await setState(f, f.state);
  const otherResult = await publish(request(f,{experimentId:'other',measurementRevision:other.revision,measurementDigest:other.digest}));
  const currentState = await state(f), first = await publish(request(f,{workspaceRevision:currentState._revision}));
  const rejected = await linkedCorrection(f,first,{reuseVersionId:otherResult.publication.head.versionId});
  const before = await state(f); await assert.rejects(publish(rejected),code('P0O01')); assert.deepEqual(await state(f),before);
});

test('tenant head foreign key rejects a reviewed source version from another workspace', async () => {
  const f = await linkedFixture(), receipt = await publish(request(f)), g = await fixture();
  await assert.rejects(admin.query('INSERT INTO public.runvara_business_outcome_heads(workspace_id,outcome_id,version_id) VALUES($1,$2,$3)',
    [g.workspaceId, receipt.publication.head.outcomeId, receipt.publication.head.versionId]), e => { assert.equal(e.code, '23503'); return true; });
  await unchanged(g);
});


test('review choices preserve long UTF8 fields while returning a byte-bounded prefix accepted by the adapter', async () => {
  const f = await fixture(), title = '雪'.repeat(200);
  f.state.connectionWrites = Array.from({ length: 20 }, (_, i) => {
    const write = actionFixture(f.workspaceId, { id: 'choice-' + i }).write;
    write.input.title = title; return write;
  });
  await setState(f, f.state);
  const expected = f.state.connectionWrites.map(w => ({ id: w.id, account: w.account, productId: w.input.productId,
    title, completedAt: w.completedAt, digest: w.recordedActionContext.snapshotDigest }));
  assert.ok(Buffer.byteLength(JSON.stringify(expected)) > 16384, 'Regression fixture exceeds the adapter cap at twenty choices');
  const result = await review(f);
  assert.ok(result.actionChoices.length > 0 && result.actionChoices.length < 20);
  assert.deepEqual(result.actionChoices, expected.slice(0, result.actionChoices.length), 'Reduce cardinality, never shorten evidence fields');
  const jsonbBytes = (await admin.query('SELECT octet_length($1::jsonb::text) size', [JSON.stringify(result.actionChoices)])).rows[0].size;
  assert.ok(jsonbBytes <= 16384); assert.ok(Buffer.byteLength(JSON.stringify(result.actionChoices)) <= 16384);
  const nextBytes = (await admin.query('SELECT octet_length($1::jsonb::text) size', [JSON.stringify(expected.slice(0, result.actionChoices.length + 1))])).rows[0].size;
  assert.ok(nextBytes > 16384, 'Keep the largest ordered prefix that fits the conservative bound');
  console.log('REVIEWED_ACTION_CHOICE_BYTES=' + JSON.stringify({ count: result.actionChoices.length, jsonbBytes, wireBytes: Buffer.byteLength(JSON.stringify(result.actionChoices)), nextJsonbBytes: nextBytes, reviewWireBytes: Buffer.byteLength(JSON.stringify(result)) }));
  const adapter = createBusinessOutcomePersistence({ request: async () => result });
  const selected = await adapter.review(f.workspaceId, f.experimentId);
  assert.deepEqual(selected.actionChoices, result.actionChoices); assert.deepEqual(selected.measurement, f.source);
  await unchanged(f);
});

test('oversized or unsupported optional action collections do not break unlinked v1 selected review', async () => {
  for (const collection of [null, {}, 'unavailable', Array.from({ length: 501 }, (_, i) => ({ id: 'old-' + i })),
    [{ id: 'large-old-action', unrelated: 'x'.repeat(2097152) }]]) {
    const f = await fixture(); f.state.connectionWrites = collection; await setState(f, f.state);
    const result = await review(f);
    assert.deepEqual(result.actionChoices, []); assert.equal(result.actionLinkContract, 'runvara-reviewed-action/v1');
    assert.deepEqual(result.measurement, f.source); assert.equal(result.current, null);
    const adapter = createBusinessOutcomePersistence({ request: async () => result });
    assert.deepEqual((await adapter.review(f.workspaceId, f.experimentId)).measurement, f.source);
    await unchanged(f);
  }
  // The optional read fallback does not relax the privileged fresh resolver.
  for (const oversize of ['count', 'bytes']) {
    const f = await linkedFixture();
    if (oversize === 'count') f.state.connectionWrites.push(...Array.from({ length: 500 }, (_, i) => ({ id: 'old-' + i })));
    else f.state.connectionWrites.push({ id: 'large-old-action', unrelated: 'x'.repeat(2097152) });
    await setState(f, f.state);
    assert.deepEqual((await review(f)).actionChoices, []);
    await assert.rejects(publish(request(f)), code('P0O10')); await unchanged(f);
  }
});

// Preserve every pre-forward test above. Only this final suite installs the
// prepared objective-content union in the same disposable PostgreSQL service.
import { objectivePublicationFixture, objectivePublicationMeasurementInput } from './objective-publication-fixture.mjs';
import { prepareExperimentOutcomeMeasurement } from '../lib/experiment-measurements.mjs';
import { reviewedActionClaimIdentity, validateReviewedSourceAction, resolveRecordedActionEvidence } from '../lib/reviewed-action-evidence.mjs';
let objectiveSecurityBefore, objectiveTriggerBefore;
async function outcomeTriggers() {
  return (await admin.query(`SELECT c.relname,t.tgname,t.tgfoid::regprocedure::text function,t.tgenabled,pg_get_triggerdef(t.oid) definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal
    AND c.oid IN ('public.runvara_business_outcome_versions'::regclass,'public.runvara_business_outcome_heads'::regclass) ORDER BY c.relname,t.tgname`)).rows;
}
async function objectiveSecurity() {
  const sourceActionColumn=(await admin.query(`SELECT a.attname,a.attacl::text,r.rolname,
    has_column_privilege(r.oid,a.attrelid,a.attnum,'SELECT') can_select,
    has_column_privilege(r.oid,a.attrelid,a.attnum,'INSERT') can_insert,
    has_column_privilege(r.oid,a.attrelid,a.attnum,'UPDATE') can_update,
    has_column_privilege(r.oid,a.attrelid,a.attnum,'REFERENCES') can_reference
    FROM pg_attribute a CROSS JOIN pg_roles r WHERE a.attrelid='public.runvara_business_outcome_versions'::regclass
      AND a.attname='source_action' AND r.rolname IN ('anon','authenticated','service_role') ORDER BY r.rolname`)).rows;
  const roles=(await admin.query('SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolconfig FROM pg_roles ORDER BY rolname')).rows;
  const memberships=(await admin.query('SELECT roleid::regrole::text role,member::regrole::text member,grantor::regrole::text grantor,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY role,member,grantor')).rows;
  return {...await outcomeSecurity(),sourceActionColumn,roles,memberships};
}
async function objectiveFixture(options = {}) {
  const actual = await objectivePublicationFixture({ workspaceId: 'objective-outcome-' + randomUUID(), ...options });
  const f = { ...actual, sourceAction: actual.source, experimentId: 'objective-experiment' };
  f.state._revision = randomUUID();
  f.source = prepareExperimentOutcomeMeasurement(objectivePublicationMeasurementInput({ actionSelection: { actionId: f.write.id } }), {
    workspaceId: f.workspaceId, experimentId: f.experimentId, actorId: 'content-owner', now: new Date(), previousMeasurement: null,
    actionEvidence: f.sourceAction, reuseVersionId: null
  });
  f.state.revenueEngine.experiments = [{ id: f.experimentId, title: 'Synthetic reviewed objective association', status: 'measured', outcomeMeasurement: f.source }];
  await admin.query('INSERT INTO public.workspaces(id,name,slug) VALUES($1,$1,$1)', [f.workspaceId]);
  await admin.query('INSERT INTO public.saas_workspace_state(workspace_id,state) VALUES($1,$2)', [f.workspaceId, f.state]);
  return f;
}
const objectiveRequest = (f, overrides = {}) => request(f, { actorId: 'content-owner', ...overrides });
async function objectiveCorrection(f, prior, { evidence = f.sourceAction, reuseVersionId = null, remove = false } = {}) {
  const s = await state(f), previousMeasurement = s.revenueEngine.experiments[0].outcomeMeasurement;
  const selection = remove ? null : reuseVersionId ? { reuseVersionId } : { actionId: evidence.context.writeId };
  const measurement = prepareExperimentOutcomeMeasurement(objectivePublicationMeasurementInput({ expectedRevision: previousMeasurement.revision, actionSelection: selection, amount: '11.5' }), {
    workspaceId: f.workspaceId, experimentId: f.experimentId, actorId: 'content-owner', now: new Date(), previousMeasurement,
    actionEvidence: remove ? null : evidence, reuseVersionId: remove ? null : reuseVersionId
  });
  s.revenueEngine.experiments[0].outcomeMeasurement = measurement; s._revision = randomUUID(); await setState(f, s);
  return objectiveRequest(f, { action: 'correct', workspaceRevision: s._revision, measurementRevision: measurement.revision, measurementDigest: measurement.digest,
    headVersionId: prior.publication.head.versionId, headDigest: prior.publication.head.digest });
}
function resignObjectiveSource(source, { stable = true, claim = true, input = false } = {}) {
  const s = structuredClone(source), c = s.context, p = c.proposal;
  if (input) { c.inputDigest = actionFingerprint({ productId:s.input.productId,operation:s.input.operation,title:s.input.title,description:s.input.description }); p.inputDigest = c.inputDigest; c.approval.payload.digest = c.inputDigest; c.stableApproval.payload.digest = c.inputDigest;
    c.dispatchRequestDigest = actionFingerprint(actionRequest(s.input, c.account, c.apiVersion)); }
  if (stable) p.approvalDigest = hash(c.stableApproval);
  delete p.digest; p.digest = hash(p); c.approval.payload.objectivePolicyProposalDigest = p.digest;
  delete c.approval.digest; c.approval.digest = hash(c.approval);
  if (claim) c.claimIdentity = reviewedActionClaimIdentity(s.input, c);
  delete s.digest; s.digest = hash(s); return s;
}
const actionFingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function assertObjectiveSecurity() {
  const actual = await objectiveSecurity(), prior = new Set(objectiveSecurityBefore.functions.map(f => f.signature));
  assert.deepEqual({ ...actual, functions: actual.functions.filter(f => prior.has(f.signature)) }, objectiveSecurityBefore,
    'Forward union preserves every existing RPC/helper signature, owner, ACL, security mode, search_path, RLS and column privilege');
  assert.deepEqual(await outcomeTriggers(), objectiveTriggerBefore, 'All immutable triggers remain byte-identical');
  const helpers = actual.functions.filter(f => !prior.has(f.signature));
  assert.deepEqual(helpers.map(f => f.signature), ['runvara_outcome_validate_objective_action(jsonb,text)']);
  for (const helper of helpers) {
    assert.equal(helper.prosecdef, false); assert.equal(helper.owner, 'postgres'); assert.ok(helper.proconfig.includes('search_path=""'));
    for (const role of ['anon','authenticated','service_role']) assert.equal((await admin.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [role, helper.signature])).rows[0].allowed, false);
    assert.equal((await admin.query("SELECT EXISTS(SELECT 1 FROM aclexplode(coalesce(proacl,acldefault('f',proowner))) WHERE grantee=0 AND privilege_type='EXECUTE') allowed FROM pg_proc WHERE oid=$1::regprocedure", [helper.signature])).rows[0].allowed, false);
  }
  assert.deepEqual(await ledgerAcl(), originalLedgerAcl);
  return actual;
}

test('reader-first storage refuses objective v2 before the forward migration, then preserves all prior security contracts', async () => {
  const f = await objectiveFixture();
  assert.equal((await review(f)).actionLinkContract, 'runvara-reviewed-action/v1');
  assert.deepEqual((await review(f)).actionChoices, []);
  await assert.rejects(publish(objectiveRequest(f)), code('P0O01')); await unchanged(f);
  objectiveSecurityBefore = await objectiveSecurity(); objectiveTriggerBefore = await outcomeTriggers();
  const dir = new URL('../supabase/migrations/', import.meta.url), files = (await readdir(dir)).filter(x => /^\d{14}_objective_action_outcome_snapshot\.sql$/.test(x));
  assert.equal(files.length, 1); assert.ok(files[0] > '20261007175355_reviewed_action_outcome_snapshot.sql');
  await admin.query(await readFile(new URL(files[0], dir), 'utf8'));
  const after = await assertObjectiveSecurity();
  console.log('OBJECTIVE_OUTCOME_SECURITY_BEFORE=' + JSON.stringify({ ...objectiveSecurityBefore, triggers: objectiveTriggerBefore }));
  console.log('OBJECTIVE_OUTCOME_SECURITY_AFTER=' + JSON.stringify({ ...after, triggers: await outcomeTriggers() }));
  assert.equal((await review(f)).actionLinkContract, 'runvara-reviewed-action/v2');
  const result = await publish(objectiveRequest(f)); assert.deepEqual(await storedAction(f, result.publication.head.versionId), f.sourceAction);
});

test('actual objective producer source, stable approval and original durable JSONB fingerprints agree independently in SQL', async () => {
  const f = await objectiveFixture({ contentInput: { title: 'Café 雪 😀', description: 'Exact & < >\n"quoted" \\ backslash\r\t\b\f\u2028\u2029' } });
  const c = f.sourceAction.context;
  const result = (await admin.query(`SELECT public.runvara_outcome_validate_source_action($1::jsonb,$2) source,
    public.runvara_outcome_resolve_action($3::jsonb,$2,$4) resolved,public.runvara_outcome_action_identity_digest($1::jsonb) claim,
    public.runvara_outcome_action_request_digest($5::jsonb,$6,$7) request,public.runvara_outcome_hash($8::jsonb) stable,
    public.runvara_outcome_validate_measurement($9::jsonb,$2,$10,clock_timestamp()) measurement`,
    [f.sourceAction,f.workspaceId,f.state,f.write.id,f.write.input,f.write.account,c.apiVersion,c.stableApproval,f.source,f.experimentId])).rows[0];
  assert.deepEqual(result.source,f.sourceAction); assert.deepEqual(result.resolved,f.sourceAction);
  assert.equal(result.claim,c.claimIdentity); assert.equal(result.claim,f.write.dispatchClaim.identity);
  assert.equal(result.request,c.dispatchRequestDigest); assert.equal(result.stable,c.proposal.approvalDigest);
  assert.equal(result.measurement.links.objective,null); assert.equal(result.measurement.links.opportunity,null);
  const scaled = JSON.stringify(f.sourceAction).replaceAll('"revision":1,','"revision":1.000,');
  assert.deepEqual((await admin.query('SELECT public.runvara_outcome_validate_source_action($1::jsonb,$2) source',[scaled,f.workspaceId])).rows[0].source,f.sourceAction);
  const r = await publish(objectiveRequest(f)); assert.deepEqual(await storedAction(f,r.publication.head.versionId),f.sourceAction);
  assert.equal(r.publication.version.publicationAuthority,false); assert.equal(r.publication.version.sourceReferencesResolved,false); assert.equal(r.publication.version.runvaraAttribution,'unestablished');
  const selected = await review(f); assert.deepEqual(selected.currentActionAssociation,f.source.intervention);
  assert.deepEqual(selected.actionChoices,[{id:f.write.id,account:f.write.account,productId:f.write.input.productId,title:f.write.input.title,completedAt:f.write.completedAt,digest:f.sourceAction.digest,origin:'owner_objective_content',originatingObjective:c.originatingObjective}]);
  for (const secret of ['stableApproval','actorSessionVersion','claimIdentity','approvalDigest','dispatchRequestDigest','runvara-objective-content-source/v1']) assert.equal(JSON.stringify(selected).includes(secret),false,secret);
});

test('stable approval hashes are reconstructed from full captured bytes, and every v2 source relationship remains strict after resigning', async () => {
  const f = await objectiveFixture(), mutations = [
    s => { s.context.stableApproval.reason += ' changed'; },
    s => { s.context.stableApproval.payload.extra='future'; },
    s => { s.context.stableApproval.evidence.reverse(); },
    s => { s.context.stableApproval.evidence[0].id='objective_review_'+'0'.repeat(32); },
    s => { s.context.stableApproval.financialImpact=1; },
    s => { s.context.stableApproval.source='owner-manual'; },
    s => { s.context.stableApproval.createdAt='2099-01-01T00:00:00.000Z'; },
    s => { s.context.stableApproval.agentId='x'.repeat(81); },
    s => { s.context.stableApproval.reason=' untrimmed'; },
    s => { s.context.stableApproval.futureContext={secret:'unsupported'}; },
    s => { s.context.originatingObjective=null; },
    s => { s.context.originatingObjective.revision++; },
    s => { s.context.origin='owner_manual'; },
    s => { s.context.proposal.source.actorSessionVersion++; },
    s => { s.context.proposal.source.actorId='another-owner'; },
    s => { s.context.executedBy='another-owner'; },
    s => { s.context.proposal.source.jobId='job_other'; },
    s => { s.context.proposal.source.reportId='objective_review_'+'1'.repeat(32); },
    s => { s.context.proposal.source.productId='gid://shopify/Product/999'; },
    s => { s.context.proposal.source.inputFingerprint='0'.repeat(32); },
    s => { s.context.proposal.policies[0].digest='1'.repeat(64); s.context.policies[0].digest='1'.repeat(64); },
    s => { s.context.approval.payload.connectionWriteId='write-other'; },
    s => { s.context.proposal.approvalId='approval-other'; },
    s => { s.context.stableApproval.evidence[1].workspaceId='foreign'; },
    s => { s.context.proposal.source.tenantId='foreign'; }
  ];
  for (const [index,mutate] of mutations.entries()) {
    let source=structuredClone(f.sourceAction); mutate(source);
    source=resignObjectiveSource(source,{stable:index!==0,claim:![24].includes(index)});
    await assert.rejects(admin.query('SELECT public.runvara_outcome_validate_source_action($1::jsonb,$2)',[source,f.workspaceId]),code('P0O01'),`mutation ${index}`);
  }
  // A forged matching pair of supplied digest strings never replaces hashing.
  const matching=structuredClone(f.sourceAction); matching.context.proposal.approvalDigest='a'.repeat(64);
  matching.context.stableApproval.reason='coherently declared digest but different body';
  await assert.rejects(admin.query('SELECT public.runvara_outcome_validate_source_action($1::jsonb,$2)',[resignObjectiveSource(matching,{stable:false}),f.workspaceId]),code('P0O01'));
  await unchanged(f);
});

test('fresh objective publication rejects retained approval edits, duplicate identities, foreign scope and substituted source', async () => {
  const mutations = [
    f => { f.state.approvals[0].reason+=' changed'; },
    f => { f.state.approvals[0].futureStableField='unknown'; },
    ...['history','workStatus','executedExternally','executionStatus','decisionNote'].map(key=>f=>{delete f.state.approvals[0][key];}),
    f => { f.state.approvals[0].payload.future='unknown'; },
    f => { f.state.approvals[0].status='rejected'; },
    f => { f.state.approvals.push(structuredClone(f.approval)); },
    f => { f.state.connections.push(structuredClone(f.connection)); },
    f => { f.state.connectionWrites.push({...structuredClone(f.write),id:'other-write'}); },
    f => { f.state.connectionWrites.push({...structuredClone(f.write),id:'other-write',requestId:'different-request-0001'}); },
    f => { f.write.workspaceId='foreign'; },
    f => { f.write.dispatchClaim.workspaceId='foreign'; },
    f => { f.write.result.externalId='gid://shopify/Product/999'; },
    f => { f.write.status='uncertain'; },
    f => { delete f.write.recordedActionContext; },
    f => { f.state.connections[0].metadata.shopDomain='other.myshopify.com'; },
    f => { const source=resignObjectiveSource({...f.sourceAction,input:{...f.sourceAction.input,title:'Coherent later title'}},{input:true});
      f.write.input=source.input; f.write.digest=source.context.inputDigest; f.write.objectivePolicyProposal=source.context.proposal;
      f.write.recordedActionContext={...source.context,snapshotDigest:source.digest}; f.write.dispatchClaim.identity=source.context.claimIdentity;
      f.write.dispatchClaim.phases.shopify_mutation.requestDigest=source.context.dispatchRequestDigest;
      f.approval.payload=source.context.approval.payload; }
  ];
  for (const mutate of mutations) {
    const f=await objectiveFixture(); mutate(f); await setState(f,f.state);
    await assert.rejects(publish(objectiveRequest(f)),code('P0O01')); await unchanged(f);
  }
});

test('objective association/report schema and captured origin cannot be downgraded or supplied as generic goal links', async () => {
  for (const mutate of [m=>{m.schema='runvara-experiment-measurement/v2';},m=>{m.report.schema='runvara-measurement-report/v2';},
    m=>{m.intervention.schema='runvara-owner-action-association/v1';},m=>{m.intervention.originatingObjective.revision++;},
    m=>{m.links.objective=m.intervention.originatingObjective;},m=>{m.links.opportunity={workspaceId:m.workspaceId,id:'opportunity-content',revision:1,digest:'a'.repeat(64)};},
    m=>{m.intervention.originatingObjective.workspaceId='foreign';},m=>{m.intervention.origin='owner_manual';}]) {
    const f=await objectiveFixture(); mutate(f.source); f.source.report.facts.intervention=structuredClone(f.source.intervention); f.source=resign(f.source);
    f.state.revenueEngine.experiments[0].outcomeMeasurement=f.source; await setState(f,f.state);
    await assert.rejects(publish(objectiveRequest(f)),code('P0O01')); await unchanged(f);
  }
});

test('immutable objective reuse survives all mutable history disappearing; corrections and final withdrawal retain exact source and replay receipt', async () => {
  const f=await objectiveFixture(), firstRequest=objectiveRequest(f), first=await publish(firstRequest);
  const cleared=await state(f); for(const key of ['connectionWrites','approvals','connections','businessObjectives','products','opportunities']) delete cleared[key];
  await setState(f,cleared);
  const secondRequest=await objectiveCorrection(f,first,{reuseVersionId:first.publication.head.versionId}), second=await publish(secondRequest);
  assert.deepEqual(await storedAction(f,second.publication.head.versionId),f.sourceAction);
  const replay=await publish(firstRequest); assert.equal(replay.replayed,true); assert.equal(replay.isCurrent,false); assert.deepEqual(replay.publication,first.publication);
  await assert.rejects(publish({...firstRequest,withdrawalReason:'incorrect_scope'}),code('P0O01'));
  const before=await state(f), draft=sourceMeasurement(f.workspaceId,f.experimentId,{revision:3}); before.revenueEngine.experiments[0].outcomeMeasurement=draft; await setState(f,before);
  const withdrawal=objectiveRequest(f,{action:'withdraw',workspaceRevision:before._revision,measurementRevision:second.publication.version.source.measurementRevision,
    measurementDigest:second.publication.version.source.measurementDigest,headVersionId:second.publication.head.versionId,headDigest:second.publication.head.digest,withdrawalReason:'evidence_retracted'});
  const final=await publish(withdrawal); assert.equal(final.publication.head.status,'withdrawn');
  assert.deepEqual(await storedAction(f,final.publication.head.versionId),f.sourceAction); assert.deepEqual((await state(f)).revenueEngine.experiments[0].outcomeMeasurement,draft);
  const retry=await publish(secondRequest); assert.equal(retry.replayed,true); assert.equal(retry.isCurrent,false);
  await assert.rejects(publish({...withdrawal,publicationId:randomUUID(),workspaceRevision:(await state(f))._revision,headVersionId:final.publication.head.versionId,headDigest:final.publication.head.digest}),e=>['P0O04','P0O08'].includes(e.code));
});

test('objective correction reuse requires exact tenant/outcome/version/digest and explicit unlinked removal retains manual v1', async () => {
  const a=await objectiveFixture(), b=await objectiveFixture(), ar=await publish(objectiveRequest(a)), br=await publish(objectiveRequest(b));
  const bad=await objectiveCorrection(a,ar,{reuseVersionId:br.publication.head.versionId}); const prior=await state(a);
  await assert.rejects(publish(bad),code('P0O01')); assert.deepEqual(await state(a),prior);
  const removed=await objectiveCorrection(a,ar,{remove:true}), r=await publish(removed);
  assert.equal(await storedAction(a,r.publication.head.versionId),null); assert.equal((await state(a)).revenueEngine.experiments[0].outcomeMeasurement.schema,'runvara-experiment-measurement/v1');
  const initial=await objectiveFixture(); initial.source.intervention.reuseVersionId=ar.publication.head.versionId;
  initial.source.report.facts.intervention=structuredClone(initial.source.intervention); initial.source=resign(initial.source); initial.state.revenueEngine.experiments[0].outcomeMeasurement=initial.source;
  await setState(initial,initial.state); await assert.rejects(publish(objectiveRequest(initial)),code('P0O01')); await unchanged(initial);
});

test('objective publishers and corrections serialize and same-intent retries cannot rewind a newer head', async () => {
  const f=await objectiveFixture(), req=objectiveRequest(f), c1=await connect(), c2=await connect();
  try {
    const [a,b]=await Promise.all([publish(req,c1),publish(req,c2)]); assert.equal([a,b].filter(r=>r.replayed).length,1); assert.deepEqual(a.publication,b.publication);
    const correction=await objectiveCorrection(f,a,{reuseVersionId:a.publication.head.versionId});
    const results=await Promise.allSettled([publish(correction,c1),publish({...correction,publicationId:randomUUID()},c2)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1); assert.equal(results.find(r=>r.status==='rejected').reason.code,'P0O04');
    assert.equal((await publish(req)).isCurrent,false);
    await assert.rejects(publish({...req,actorId:'unknown-owner'}),code('P0O03'));
    await assert.rejects(publish({...req,measurementDigest:'0'.repeat(64)}),code('P0O06'));
  } finally {await close(c1);await close(c2);}
});

test('fresh objective resolution and owner/session checks happen after acquiring the workspace lock', async () => {
  for(const mode of ['action','session']) {
    const f=await objectiveFixture(), holder=await connect('postgres'), publisher=await connect();
    try {
      await holder.query('BEGIN'); await holder.query('SELECT 1 FROM public.saas_workspace_state WHERE workspace_id=$1 FOR UPDATE',[f.workspaceId]);
      const pid=(await publisher.query('SELECT pg_backend_pid() pid')).rows[0].pid, blocker=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const pending=publish(objectiveRequest(f),publisher), rejected=assert.rejects(pending,code(mode==='action'?'P0O01':'P0O03')); await blocked(pid,blocker);
      const changed=structuredClone(f.state); if(mode==='action') changed.approvals[0].reason+='changed while waiting'; else changed.users[0].sessionVersion++;
      await holder.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1',[f.workspaceId,changed]); await holder.query('COMMIT');
      await rejected; await unchanged(f,changed);
    } finally {await holder.query('ROLLBACK');await close(holder);await close(publisher);}
  }
});

test('objective audit failures atomically roll back source/version/head/workspace and all new helpers stay closed', async () => {
  const f=await objectiveFixture();
  await admin.query(`CREATE FUNCTION public.objective_outcome_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P0T03',MESSAGE='synthetic rollback'; END $$;
    CREATE TRIGGER objective_outcome_test_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.objective_outcome_test_failure()`);
  try {await assert.rejects(publish(objectiveRequest(f)),code('P0T03'));await unchanged(f);}
  finally {await admin.query('DROP TRIGGER objective_outcome_test_failure ON public.audit_events; DROP FUNCTION public.objective_outcome_test_failure()');}
  await assertObjectiveSecurity();
  for(const role of ['service_role','anon','authenticated']) await using(role,c=>assert.rejects(c.query("SELECT public.runvara_outcome_validate_objective_action('{}','x')"),code('42501')));
});

test('forward union keeps manual/unlinked canonical bytes and exact source/measurement/choice limits', async () => {
  for(const options of [{},{policyCount:2}]) {const f=await linkedFixture(options),r=await publish(request(f));assert.deepEqual(await storedAction(f,r.publication.head.versionId),f.sourceAction);}
  const manual=await fixture(),m=await publish(request(manual));assert.equal(await storedAction(manual,m.publication.head.versionId),null);
  const f=await objectiveFixture(), empty=resignObjectiveSource({...f.sourceAction,input:{...f.sourceAction.input,description:''}},{input:true});
  const remaining=24576-Buffer.byteLength(canonical(empty));
  const exact=resignObjectiveSource({...empty,input:{...empty.input,description:'雪'.repeat(Math.floor(remaining/3))+'x'.repeat(remaining%3)}},{input:true});
  assert.equal(Buffer.byteLength(canonical(exact)),24576);
  assert.deepEqual((await admin.query('SELECT public.runvara_outcome_validate_source_action($1::jsonb,$2) source',[exact,f.workspaceId])).rows[0].source,exact);
  const over=resignObjectiveSource({...exact,input:{...exact.input,description:exact.input.description+'x'}},{input:true});
  await assert.rejects(admin.query('SELECT public.runvara_outcome_validate_source_action($1::jsonb,$2)',[over,f.workspaceId]),code('P0O10'));
  const stable=structuredClone(f.sourceAction); for(const key of ['reason','risk','expectedBenefit']) stable.context.stableApproval[key]='雪'.repeat(1000);
  await assert.rejects(admin.query('SELECT public.runvara_outcome_validate_source_action($1::jsonb,$2)',[resignObjectiveSource(stable),f.workspaceId]),code('P0O10'));
  const choices=await objectiveFixture(); choices.state.connectionWrites=Array.from({length:20},(_,i)=>{
    const w=structuredClone(choices.write);w.id='objective-choice-'+i;w.input.title='雪'.repeat(200);return w;});
  await setState(choices,choices.state);const reviewResult=await review(choices);
  assert.ok(reviewResult.actionChoices.length>0&&reviewResult.actionChoices.length<20);assert.ok(Buffer.byteLength(JSON.stringify(reviewResult.actionChoices))<=16384);
  assert.ok(Buffer.byteLength(JSON.stringify(reviewResult))<=131072);
  console.log('OBJECTIVE_OUTCOME_BOUNDS='+JSON.stringify({sourceCanonical:Buffer.byteLength(canonical(exact)),stableCanonical:Buffer.byteLength(canonical(stable.context.stableApproval)),choices:reviewResult.actionChoices.length,choiceBytes:Buffer.byteLength(JSON.stringify(reviewResult.actionChoices)),reviewBytes:Buffer.byteLength(JSON.stringify(reviewResult))}));
  await assertObjectiveSecurity();
});


test('fresh captured objective association survives current goal/report disappearance and producer truncation preserves stable approval bytes', async () => {
  const f=await objectiveFixture(), disappeared=await state(f); for(const key of ['businessObjectives','products','opportunities']) delete disappeared[key];
  await setState(f,disappeared); const r=await publish(objectiveRequest(f)); assert.deepEqual(await storedAction(f,r.publication.head.versionId),f.sourceAction);
  for(const key of ['action','reason','expectedBenefit','risk','agentId']) {
    const limit=key==='action'?180:key==='agentId'?80:1000;
    const source=structuredClone(f.sourceAction); source.context.stableApproval[key]='x'.repeat(limit-1)+' ';
    const signed=resignObjectiveSource(source);
    assert.deepEqual(validateReviewedSourceAction(signed,{workspaceId:f.workspaceId}),signed);
    assert.deepEqual((await admin.query('SELECT public.runvara_outcome_validate_source_action($1::jsonb,$2) source',[signed,f.workspaceId])).rows[0].source,signed);
  }
  const evidence=structuredClone(f.sourceAction); evidence.context.stableApproval.evidence[0].detail='x'.repeat(999)+' ';
  const signed=resignObjectiveSource(evidence); assert.deepEqual(validateReviewedSourceAction(signed,{workspaceId:f.workspaceId}),signed);
  assert.deepEqual((await admin.query('SELECT public.runvara_outcome_validate_source_action($1::jsonb,$2) source',[signed,f.workspaceId])).rows[0].source,signed);
  const reviewState=await state(f); await admin.query('UPDATE public.saas_workspace_state SET state=$2::jsonb WHERE workspace_id=$1',[f.workspaceId,JSON.stringify(reviewState).replaceAll('"revision":1,','"revision":1.0,')]);
  assert.equal((await review(f)).actionChoices.length,1,'JSONB numeric spelling does not remove a valid objective choice');
});

test('v2 stable approval SQL matches ECMAScript trim/slice and UTF16 caps, including exact 8 KiB bytes', async () => {
  const f=await objectiveFixture(), cases=[];
  const add=(name,expected,mutate)=>{const source=structuredClone(f.sourceAction);mutate(source.context.stableApproval);cases.push({name,expected,source:resignObjectiveSource(source)});};
  for(const [field,cap] of [['action',180],['reason',1000],['expectedBenefit',1000],['risk',1000],['agentId',80]]) {
    add(field+' astral exact UTF16 cap',true,s=>s[field]='😀'.repeat(cap/2));
    add(field+' astral over UTF16 cap',false,s=>s[field]='😀'.repeat(cap/2)+'a');
    add(field+' ASCII trailing whitespace at cap',true,s=>s[field]='a'.repeat(cap-1)+' ');
    add(field+' astral trailing NBSP at cap',true,s=>s[field]='😀'.repeat(cap/2-1)+'a\u00a0');
    add(field+' trailing whitespace below cap',false,s=>s[field]='a'.repeat(cap-2)+' ');
    add(field+' leading FEFF at cap',false,s=>s[field]='\ufeff'+'a'.repeat(cap-1));
  }
  for(const value of ['','a']) add('agentId '+(value?'one char':'empty'),true,s=>s.agentId=value);
  for(const ws of ['\t','\n','\r','\v','\f','\u00a0','\u1680','\u2000','\u200a','\u2028','\u2029','\u202f','\u205f','\u3000','\ufeff']) {
    add('reason U+'+ws.codePointAt(0).toString(16)+' at cap',true,s=>s.reason='a'.repeat(999)+ws);
    add('reason U+'+ws.codePointAt(0).toString(16)+' below cap',false,s=>s.reason='a'.repeat(998)+ws);
  }
  for(const char of ['\u0085','\u180e','\u200b']) add('non-ECMAScript-whitespace U+'+char.codePointAt(0).toString(16),true,s=>s.reason=char+'retained'+char);
  for(const [name,value,expected] of [['astral cap','😀'.repeat(500),true],['astral over','😀'.repeat(500)+'a',false],
    ['max trailing FEFF','a'.repeat(999)+'\ufeff',true],['below trailing FEFF','a'.repeat(998)+'\ufeff',false],['empty','',true]]) add('evidence '+name,expected,s=>s.evidence[0].detail=value);
  const bounded=structuredClone(f.sourceAction.context.stableApproval);
  for(const field of ['action','reason','expectedBenefit','risk'])bounded[field]='a';bounded.agentId='';for(const row of bounded.evidence)row.detail='';
  for(const [target,key] of [[bounded,'reason'],[bounded,'expectedBenefit'],[bounded,'risk'],[bounded.evidence[0],'detail'],[bounded.evidence[1],'detail']]) {
    while(target[key].length<1000&&Buffer.byteLength(canonical(bounded))+3<=8192)target[key]+='雪';
    while(target[key].length<1000&&Buffer.byteLength(canonical(bounded))+1<=8192)target[key]+='a';
  }
  assert.equal(Buffer.byteLength(canonical(bounded)),8192);
  add('stable exact 8192 canonical bytes',true,s=>{for(const key of Object.keys(s))delete s[key];Object.assign(s,structuredClone(bounded));});
  add('stable over 8192 canonical bytes',false,s=>{for(const key of Object.keys(s))delete s[key];Object.assign(s,structuredClone(bounded));s.agentId='a';});
  const results=[];
  for(const {name,expected,source} of cases) {
    let js=true,sql=true;try{validateReviewedSourceAction(source,{workspaceId:f.workspaceId});}catch{js=false;}
    try{await admin.query('SELECT public.runvara_outcome_validate_source_action($1::jsonb,$2)',[source,f.workspaceId]);}catch(error){assert.ok(['P0O01','P0O10'].includes(error.code),error.message);sql=false;}
    assert.equal(js,expected,name+' JS');assert.equal(sql,expected,name+' SQL');results.push({name,expected,js,sql});
  }
  console.log('OBJECTIVE_STABLE_UNICODE_PARITY='+JSON.stringify(results));
});

test('v2 preserves original product identity and proposal byte bounds without changing manual v1 limits', async () => {
  const f=await objectiveFixture(), prefix='gid://shopify/Product/';
  for(const length of [100,101]) {
    const source=structuredClone(f.sourceAction), productId=prefix+'1'.repeat(length-prefix.length);
    source.input.productId=productId;source.context.resultId=productId;source.context.proposal.source.productId=productId;source.context.stableApproval.evidence[1].id=productId;
    const signed=resignObjectiveSource(source,{input:true,claim:false});
    signed.context.claimIdentity=(await admin.query('SELECT public.runvara_outcome_action_identity_digest($1::jsonb) claim',[signed])).rows[0].claim;
    delete signed.digest;signed.digest=hash(signed);
    if(length===100){assert.deepEqual(validateReviewedSourceAction(signed,{workspaceId:f.workspaceId}),signed);assert.deepEqual((await admin.query('SELECT public.runvara_outcome_validate_source_action($1::jsonb,$2) source',[signed,f.workspaceId])).rows[0].source,signed);}
    else{assert.throws(()=>validateReviewedSourceAction(signed,{workspaceId:f.workspaceId}));await assert.rejects(admin.query('SELECT public.runvara_outcome_validate_source_action($1::jsonb,$2)',[signed,f.workspaceId]),code('P0O01'));}
  }
  for(const bytes of [8192,8193]) {
    const source=structuredClone(f.sourceAction), p=source.context.proposal;
    p.policies.push(...Array.from({length:49},(_,i)=>({objectiveId:'policy-'+i,revision:1,digest:'a'.repeat(64)})));
    assert.ok(Buffer.byteLength(canonical(p))<bytes);
    for(const row of p.policies.slice(1))while(row.objectiveId.length<160&&Buffer.byteLength(canonical(p))<bytes)row.objectiveId+='x';
    assert.equal(Buffer.byteLength(canonical(p)),bytes);source.context.policies=structuredClone(p.policies);
    const signed=resignObjectiveSource(source);
    assert.ok(Buffer.byteLength(canonical(signed))<24576,'Isolate the original proposal bound from the full source cap');
    if(bytes===8192){assert.deepEqual(validateReviewedSourceAction(signed,{workspaceId:f.workspaceId}),signed);assert.deepEqual((await admin.query('SELECT public.runvara_outcome_validate_source_action($1::jsonb,$2) source',[signed,f.workspaceId])).rows[0].source,signed);}
    else{assert.throws(()=>validateReviewedSourceAction(signed,{workspaceId:f.workspaceId}));await assert.rejects(admin.query('SELECT public.runvara_outcome_validate_source_action($1::jsonb,$2)',[signed,f.workspaceId]),code('P0O10'));}
  }
});


test('excluded mutable approval history is not a stable evidence gate while decisions, stable bytes and tenant scope remain bound', async () => {
  const f=await objectiveFixture();
  f.approval.history=Array.from({length:60},(_,index)=>({'future-key':index+0.25,details:{'future-note':'Excluded mutable history'}}));
  const source=resolveRecordedActionEvidence(f.state,f.write.id);assert.deepEqual(source,f.sourceAction);
  assert.equal(hash(source.context.stableApproval),source.context.proposal.approvalDigest);
  const resolved=(await admin.query('SELECT public.runvara_outcome_resolve_action($1::jsonb,$2,$3) source',[f.state,f.workspaceId,f.write.id])).rows[0].source;
  assert.deepEqual(resolved,f.sourceAction);
  for(const [label,mutate] of [
    ['stable bytes',approval=>{approval.reason+=' changed';}],
    ['captured decision',approval=>{approval.decidedBy='different-owner';}],
    ['foreign nested scope',approval=>{approval.history[0].workspaceId='foreign';}]
  ]) {
    const changed=structuredClone(f.state);mutate(changed.approvals.find(row=>row.id===f.write.approvalId));
    assert.throws(()=>resolveRecordedActionEvidence(changed,f.write.id),label);
    await assert.rejects(admin.query('SELECT public.runvara_outcome_resolve_action($1::jsonb,$2,$3)',[changed,f.workspaceId,f.write.id]),code('P0O01'),label);
  }
  await setState(f,f.state);const published=await publish(objectiveRequest(f));
  assert.deepEqual(await storedAction(f,published.publication.head.versionId),f.sourceAction);
  console.log('OBJECTIVE_EXCLUDED_HISTORY_PARITY='+JSON.stringify({entries:60,fractionalNumbers:true,futureKeys:true,jsFreshSourceUnchanged:true,sqlFreshSourceUnchanged:true,stableDigestUnchanged:true,publishedSourceUnchanged:true,stableDecisionForeignScopeMutationsRejected:true}));
});
