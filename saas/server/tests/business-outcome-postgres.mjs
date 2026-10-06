/** Real PostgreSQL 17 concurrency/privilege gate; never silently skipped.
 * Only an explicitly opted-in, empty, local disposable database is accepted.
 * The matching Actions workflow uses official postgres:17.6, no deployment keys.
 */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BUSINESS_OUTCOME_CURRENCIES, BUSINESS_OUTCOME_CURRENCY_CONTRACT_VERSION, createBusinessOutcomeCandidate, correctBusinessOutcomeCandidate, withdrawBusinessOutcomeCandidate, validateBusinessOutcomeCandidate } from '../lib/business-outcomes.mjs';
import { canonical, hash, sourceMeasurement, resign, fixtureData, request, parameters, callSql, RPC_SIGNATURE } from './business-outcome-postgres-fixture.mjs';

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
let admin, baseline, originalLedgerAcl;
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
  return (await c.query(`SELECT h.workspace_id,h.outcome_id,h.version_id,to_jsonb(v)-'source_measurement' AS version
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
  const matches = (await readdir(dir)).filter(x => /^\d{14}_business_outcome_publication\.sql$/.test(x)); assert.equal(matches.length, 1);
  await admin.query(await readFile(new URL(matches[0], dir), 'utf8'));
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
  assert.deepEqual(draft, { workspaceId: f.workspaceId, workspaceRevision: f.state._revision, experiment: { id: f.experimentId, title: 'Bounded review', status: 'measured' }, measurement: f.source, current: null });
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
