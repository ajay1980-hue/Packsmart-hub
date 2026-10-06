/**
 * Real PostgreSQL 17 JSONB/JSON archive read roundtrip gate. Run sequentially
 * after atomic-usage-postgres.mjs against its existing disposable localhost DB:
 * node --test --test-concurrency=1 saas/server/tests/automation-retention-postgres.mjs
 *
 * Uses the existing locked pg driver and ATOMIC_USAGE_* test-only environment.
 * Creates one connection-local TEMP table only; no public table, migration,
 * role/grant, service, production endpoint, or persistence fallback is used.
 * Missing PostgreSQL/configuration is a failure, never a silently skipped gate.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
import {
  planAutomationRetention, applyAutomationRetention, verifyAutomationArchivePayload,
  estimateAutomationArchiveReadBodyBytes, AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES
} from '../lib/automation-retention.mjs';

const connectionString = process.env.ATOMIC_USAGE_TEST_DATABASE_URL;
assert.equal(process.env.ATOMIC_USAGE_ALLOW_DISPOSABLE_TEST_DB, '1', 'Explicit disposable database opt-in required');
assert.ok(connectionString, 'ATOMIC_USAGE_TEST_DATABASE_URL is required; serialization proof may not silently skip');
const databaseUrl = new URL(connectionString);
assert.ok(['postgres:', 'postgresql:'].includes(databaseUrl.protocol));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname), 'Only a local disposable PostgreSQL server is allowed');
assert.equal(databaseUrl.pathname, '/runvara_atomic_usage_test', 'Refusing any database except runvara_atomic_usage_test');
assert.equal(databaseUrl.search, '', 'Connection-string target overrides are forbidden');
const require = createRequire(new URL('./atomic-usage/package.json', import.meta.url));
const { Client } = require('pg');
const NOW = '2026-10-06T20:00:00.000Z';
const TABLE = 'pg_temp.automation_retention_roundtrip';
const LIMIT = AUTOMATION_ARCHIVE_SINGLE_BODY_MAX_BYTES;
let client;

before(async () => {
  client = new Client({ connectionString, connectionTimeoutMillis: 10_000, statement_timeout: 30_000,
    application_name: 'runvara-automation-retention-test' });
  await client.connect();
  const info = (await client.query("SELECT current_database() AS db,current_setting('server_version_num')::int AS version")).rows[0];
  assert.equal(info.db, 'runvara_atomic_usage_test');
  assert.ok(info.version >= 170000 && info.version < 180000, 'Serialization gate requires PostgreSQL 17');
  await client.query("SET TIME ZONE 'UTC'");
  await client.query(`CREATE TEMP TABLE automation_retention_roundtrip (
    workspace_id text NOT NULL, collection text NOT NULL, record_id text NOT NULL,
    payload jsonb NOT NULL, occurred_at timestamptz,
    PRIMARY KEY (workspace_id, collection, record_id)
  ) ON COMMIT PRESERVE ROWS`);
}, { timeout: 30_000 });
after(async () => { if (client) await client.end(); });

function run(id, evidence, extra = {}) {
  return { id, ruleId: 'profitGuard', status: 'COMPLETED', startedAt: '2026-10-06T18:00:00.000Z',
    completedAt: '2026-10-06T18:01:00.000Z', risk: 'low', spend: 0, evidence, ...extra };
}
function planFor(record, workspaceId = 'retention-pg-fixture') {
  const state = { workspace: { id: workspaceId }, autopilot: { timeZone: 'UTC' },
    automationRuns: [run('latest-protected', []), record] };
  return { state, plan: planAutomationRetention(state, { now: NOW, recentCompletedLimit: 0 }) };
}
async function readJsonbRow(row) {
  // Real JSONB storage, not an in-memory Response.json representation.
  await client.query(`INSERT INTO ${TABLE} (workspace_id,collection,record_id,payload,occurred_at)
    VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz) ON CONFLICT DO NOTHING`,
  [row.workspace_id, row.collection, row.record_id, JSON.stringify(row.payload), row.occurred_at]);
  // Match the production GET selection. Casting the aggregate to TEXT prevents
  // node-postgres from parsing away PostgreSQL's lexical spaces/exponents.
  const result = await client.query(`SELECT COALESCE(json_agg(selected), '[]'::json)::text AS wire_body
    FROM (SELECT workspace_id,collection,record_id,payload FROM ${TABLE}
      WHERE workspace_id=$1 AND collection=$2 AND record_id=$3 LIMIT 1) selected`,
  [row.workspace_id, row.collection, row.record_id]);
  return result.rows[0].wire_body;
}
async function assertRetrievable(candidate) {
  if (candidate.targetAction === 'retain-stub') {
    assert.ok(candidate.stubBytes < candidate.originalRunBytes, 'Positive stubbing fixtures must actually reduce retained UTF-8 bytes');
    assert.equal(candidate.retainedBytesSaved, candidate.originalRunBytes - candidate.stubBytes);
  }
  const body = await readJsonbRow(candidate.row), bytes = Buffer.byteLength(body, 'utf8');
  const estimate = estimateAutomationArchiveReadBodyBytes(candidate.row);
  assert.equal(candidate.estimatedReadBodyBytes, estimate);
  assert.ok(bytes <= estimate, `Actual PostgreSQL read ${bytes} exceeds conservative estimate ${estimate}`);
  assert.ok(estimate <= LIMIT, 'Every admitted candidate must fit the existing read cap');
  assert.ok(bytes <= LIMIT, 'Every admitted candidate must fit the actual streaming-read cap');
  const rows = JSON.parse(body);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].workspace_id, candidate.reference.workspaceId);
  assert.equal(rows[0].collection, candidate.reference.collection);
  assert.equal(rows[0].record_id, candidate.reference.recordId);
  assert.deepEqual(rows[0].payload, candidate.row.payload);
  assert.equal(verifyAutomationArchivePayload(candidate.reference, rows[0].payload,
    candidate.reference.workspaceId, candidate.reference.runId), true);
  assert.ok(Buffer.byteLength(JSON.stringify(rows), 'utf8') <= LIMIT, 'Parsed/re-serialized store response must also fit');
  const apiBody = { workspaceId: candidate.reference.workspaceId, runId: candidate.reference.runId, run: rows[0].payload, source: 'immutable_automation_archive' };
  const apiBytes = Buffer.byteLength(JSON.stringify(apiBody), 'utf8');
  assert.equal(candidate.responseBodyBytes, apiBytes, 'API body accounting must match its real parsed-payload envelope');
  assert.ok(candidate.estimatedResponseBodyBytes >= apiBytes && candidate.estimatedResponseBodyBytes <= LIMIT);
  assert.ok(apiBytes <= LIMIT, 'The final API envelope must fit without assuming it is the same size as the selected database row');
  return { writeBytes: candidate.requestBodyBytes, readBytes: bytes, estimatedReadBytes: estimate };
}
function candidate(plan) {
  assert.equal(plan.archiveCandidates.length, 1, 'Expected one admitted non-latest record');
  assert.equal(plan.pending.length, 0);
  assert.equal(plan.skipped.length, 0, 'Positive serialization fixtures must contain enough recorded evidence to justify a stub');
  return plan.archiveCandidates[0];
}
function recordedInputEvidence() {
  // A real-shaped retained calculation context makes the positive fixtures
  // economically worth compacting; short scalar-only records should stay full.
  return { type: 'calculation_inputs', source: 'synthetic-recorded-ledger', records: Array.from({ length: 16 }, (_, index) => ({
    recordId: `ledger-${index}`, currency: 'GBP', periodDate: '2026-10-06', quantity: index + 1,
    netRevenue: (index + 1) * 12, recordedCost: (index + 1) * 4, basis: 'recorded-order-and-cost-inputs'
  })) };
}
function rejectedRow(record, workspaceId, tag) {
  // Test-only selected-row envelope for proving that a refused payload really
  // expands in PostgreSQL. This row is never an acknowledged archive candidate.
  return { workspace_id: workspaceId, collection: 'automationRuns', record_id: `refused-fixture:${tag}`,
    payload: record, occurred_at: record.completedAt };
}

test('dense null evidence is rejected before compaction when real PostgreSQL JSONB expands beyond the read cap', { timeout: 30_000 }, async t => {
  const record = run('dense-nulls', Array(400000).fill(null));
  const { state, plan } = planFor(record);
  assert.equal(plan.archiveCandidates.length, 0);
  assert.equal(plan.pending.length, 1);
  assert.equal(plan.pending[0].reason, 'ARCHIVE_READ_ENVELOPE_TOO_LARGE');
  assert.ok(plan.pending[0].requestBodyBytes <= LIMIT, 'The legacy compact write-byte check would admit this payload');
  const actual = await readJsonbRow(rejectedRow(record, state.workspace.id, 'dense-nulls'));
  assert.ok(Buffer.byteLength(actual, 'utf8') > LIMIT, 'Regression must exercise genuine PostgreSQL lexical expansion');
  const applied = applyAutomationRetention(plan);
  assert.equal(applied.automationRuns[1], record, 'Rejected source remains fully retained by identity');
  assert.equal(applied.compacted, 0);
  assert.equal(applied.pendingArchives, 1);
  const small = candidate(planFor(run('bounded-nulls', Array(10000).fill(null))).plan);
  t.diagnostic(JSON.stringify({ rejectedReadBytes: Buffer.byteLength(actual, 'utf8'), ...(await assertRetrievable(small)) }));
});

test('expanded large, tiny and subnormal numbers are bounded using actual PostgreSQL decimal output', { timeout: 30_000 }, async t => {
  const numbers = [1e308, -1e308, Number.MAX_VALUE, 1e21, 1e20, 1e-7, 1e-6, Number.MIN_VALUE, -Number.MIN_VALUE, 0, 0.1, -0.1];
  const stats = await assertRetrievable(candidate(planFor(run('number-extremes', [...numbers, recordedInputEvidence()])).plan));
  assert.ok(stats.readBytes > stats.writeBytes + 1000, 'Extremal decimal numbers must actually expand in PostgreSQL');
  for (const [name, number] of [['subnormal', Number.MIN_VALUE], ['huge-positive', 1e308], ['huge-negative', -1e308]]) {
    const record = run(`many-${name}`, Array(7000).fill(number));
    const { state, plan } = planFor(record);
    assert.equal(plan.archiveCandidates.length, 0, name);
    assert.equal(plan.pending[0].reason, 'ARCHIVE_READ_ENVELOPE_TOO_LARGE', name);
    assert.ok(plan.pending[0].requestBodyBytes < LIMIT, name);
    const body = await readJsonbRow(rejectedRow(record, state.workspace.id, name));
    assert.ok(Buffer.byteLength(body, 'utf8') > LIMIT, name);
    assert.equal(applyAutomationRetention(plan).automationRuns[1], record);
  }
  t.diagnostic(JSON.stringify(stats));
});

test('UTF-8, escaped keys and values, nesting and JSONB key reordering preserve digest and fit the bound', async t => {
  const evidence = [{ '雪🚀': 'é 雪 🚀 \u2028 \u2029 \n \r \t \\ " / \b \f',
    'numeric-order': { '10': 'ten', '2': 'two', '1': 'one' },
    'quotes"\\key': [null, true, false, { 'tab\tkey': 'control\u0001value', 'a': [1e-7, Number.MIN_VALUE] }] }];
  const record = run('utf8-雪-🚀', evidence, { extra: { 'nested': [{ '🔒': '🧭'.repeat(1000) }] } });
  const stats = await assertRetrievable(candidate(planFor(record, 'tenant-雪-🚀').plan));
  t.diagnostic(JSON.stringify(stats));
});

function lastAcceptedAsciiBoundary({ id = 'ascii-boundary', workspaceId = 'retention-pg-fixture', expandedNumber = true } = {}) {
  let low = 0, high = LIMIT, accepted;
  while (low <= high) {
    const size = Math.floor((low + high) / 2);
    const built = planFor(run(id, [{ detail: 'x'.repeat(size) }, ...(expandedNumber ? [1e308] : [])]), workspaceId);
    if (built.plan.archiveCandidates.length) { accepted = { size, ...built }; low = size + 1; }
    else high = size - 1;
  }
  assert.ok(accepted, 'At least one genuinely larger recorded payload must fit');
  return accepted;
}

test('the last accepted ASCII boundary and its immediate successor agree with real PostgreSQL retrieval', { timeout: 30_000 }, async t => {
  const boundary = lastAcceptedAsciiBoundary(), admitted = candidate(boundary.plan);
  assert.equal(admitted.estimatedReadBodyBytes, LIMIT, 'The accepted estimator boundary must exercise the exact cap');
  const stats = await assertRetrievable(admitted);
  assert.ok(stats.readBytes >= LIMIT - 16, 'Accepted boundary should be genuinely close to the wire ceiling');
  const next = planFor(run('ascii-boundary', [{ detail: 'x'.repeat(boundary.size + 1) }, 1e308]));
  assert.equal(next.plan.archiveCandidates.length, 0);
  assert.ok(['ARCHIVE_READ_ENVELOPE_TOO_LARGE', 'ARCHIVE_API_ENVELOPE_TOO_LARGE', 'ARCHIVE_PAYLOAD_TOO_LARGE'].includes(next.plan.pending[0].reason));
  assert.equal(applyAutomationRetention(next.plan).automationRuns[1], next.state.automationRuns[1]);
  t.diagnostic(JSON.stringify({ detailCharacters: boundary.size, ...stats }));
});

test('many accepted mixed numeric and UTF-8 candidates all survive the selected-read envelope', { timeout: 30_000 }, async () => {
  for (const count of [1, 7, 64, 511, 2048]) {
    const evidence = Array.from({ length: count }, (_, i) => ({ id: `row-${i}`, detail: i % 2 ? '雪🚀' : '"\\\n',
      amount: [1e-7, 1e308, Number.MIN_VALUE, -Number.MIN_VALUE, 0][i % 5], nullable: null }));
    const built = planFor(run(`mixed-${count}`, [...evidence, recordedInputEvidence()]));
    await assertRetrievable(candidate(built.plan));
  }
});

test('well-formed historical terminal errors archive as full immutable payloads without making quota stubs', async () => {
  for (const status of ['FAILED', 'BLOCKED']) {
    const record = run(`terminal-${status.toLowerCase()}`, [{ type: 'monitor_failure', detail: 'Recorded source failure' }], {
      status, errorCode: 'SOURCE_COVERAGE_INCOMPLETE', startedAt: '2026-10-01T18:00:00.000Z', completedAt: '2026-10-01T18:01:00.000Z'
    });
    const { state, plan } = planFor(record), admitted = candidate(plan);
    assert.equal(admitted.targetAction, 'archive-only');
    await assertRetrievable(admitted);
    assert.equal(applyAutomationRetention(plan).automationRuns[1], record, 'No acknowledged archival means no eviction');
    const confirmed = applyAutomationRetention(plan, { acknowledgedArchives: [{ ...admitted.reference, confirmed: true }] });
    assert.equal(confirmed.automationRuns.length, 1);
    assert.equal(confirmed.automationRuns[0], state.automationRuns[0]);
    assert.equal(confirmed.compacted, 0, 'Failures do not acquire completed-evidence stubs');
  }
});

test('a long-identity API-envelope boundary remains retrievable and rejects the next payload byte', { timeout: 30_000 }, async t => {
  const id = 'r'.repeat(180), workspaceId = 'w'.repeat(256);
  const boundary = lastAcceptedAsciiBoundary({ id, workspaceId, expandedNumber: false });
  const admitted = candidate(boundary.plan);
  assert.equal(admitted.estimatedResponseBodyBytes, LIMIT, 'This fixture must reach the API wrapper bound, not only the database bound');
  const stats = await assertRetrievable(admitted);
  const next = planFor(run(id, [{ detail: 'x'.repeat(boundary.size + 1) }]), workspaceId);
  assert.equal(next.plan.archiveCandidates.length, 0);
  assert.equal(next.plan.pending[0].reason, 'ARCHIVE_API_ENVELOPE_TOO_LARGE');
  assert.equal(applyAutomationRetention(next.plan).automationRuns[1], next.state.automationRuns[1]);
  t.diagnostic(JSON.stringify({ detailCharacters: boundary.size, apiResponseBytes: admitted.responseBodyBytes, ...stats }));
});

test('short current-day records skip unhelpful stubs without becoming pending failures; old short records still archive-only', async () => {
  const record = run('short-current-day', [{ type: 'checked' }]);
  const { plan } = planFor(record);
  assert.equal(plan.archiveCandidates.length, 0);
  assert.deepEqual(plan.archiveBatches, []);
  assert.deepEqual(plan.pending, [], 'A beneficial-compaction skip is not an archival failure');
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].reason, 'STUB_NOT_SMALLER');
  assert.ok(plan.skipped[0].stubBytes >= plan.skipped[0].originalRunBytes);
  const unchanged = applyAutomationRetention(plan);
  assert.equal(unchanged.automationRuns[1], record);
  assert.equal(unchanged.pendingArchives, 0);
  assert.equal(unchanged.compacted, 0);
  const old = { ...record, id: 'short-old-record', startedAt: '2026-10-01T18:00:00.000Z', completedAt: '2026-10-01T18:01:00.000Z' };
  const aged = planFor(old), admitted = candidate(aged.plan);
  assert.equal(admitted.targetAction, 'archive-only');
  await assertRetrievable(admitted);
  const confirmed = applyAutomationRetention(aged.plan, { acknowledgedArchives: [{ ...admitted.reference, confirmed: true }] });
  assert.equal(confirmed.automationRuns.length, 1);
  assert.equal(confirmed.evicted, 1);
});
