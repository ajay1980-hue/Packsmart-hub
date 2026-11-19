/**
 * Actual PostgreSQL integration tests, never a mock or a production migration.
 * CI: .github/workflows/atomic-usage-check.yml (official postgres:17.6 service).
 * Local: start a disposable PostgreSQL 17 with max_connections >= 110 and an
 * empty database named runvara_atomic_usage_test, install with
 * npm --prefix saas/server/tests/atomic-usage ci --ignore-scripts, then run:
 * ATOMIC_USAGE_ALLOW_DISPOSABLE_TEST_DB=1 \
 * ATOMIC_USAGE_TEST_DATABASE_URL=postgres://postgres:password@127.0.0.1:5432/runvara_atomic_usage_test \
 * ATOMIC_USAGE_POSTGREST_BIN=/absolute/path/to/verified/postgrest-14.5 \
 * npm --prefix saas/server/tests/atomic-usage test
 * This runner deliberately fails rather than skipping when PostgreSQL is absent.
 */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createAiProvider } from '../lib/ai-provider.mjs';
import { createStore } from '../lib/store.mjs';
import { OPERATOR_BRIEF_ENDPOINT, OPERATOR_BRIEF_SHAPE } from '../lib/operator-brief-policy.mjs';
import { runPostgrestTimeoutCases } from './atomic-usage-postgrest-timeout-cases.mjs';
import { runFutureAllowanceCases, futureFixture, futureRequest, reserveFuture, futureEvidence, installFuture, enableFuture } from './future-allowance-postgres-cases.mjs';

const require = createRequire(new URL('./atomic-usage/package.json', import.meta.url));
const { Client } = require('pg');
const connectionString = process.env.ATOMIC_USAGE_TEST_DATABASE_URL;
assert.equal(process.env.ATOMIC_USAGE_ALLOW_DISPOSABLE_TEST_DB, '1', 'Explicit disposable database opt-in required');
assert.ok(connectionString, 'ATOMIC_USAGE_TEST_DATABASE_URL is required; integration tests may not silently skip');
const databaseUrl = new URL(connectionString);
assert.ok(['postgres:', 'postgresql:'].includes(databaseUrl.protocol));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname), 'Only a local disposable PostgreSQL server is allowed');
assert.equal(databaseUrl.pathname, '/runvara_atomic_usage_test', 'Refusing any database except runvara_atomic_usage_test');
assert.equal(databaseUrl.search, '', 'Connection-string options that could override the local target are forbidden');

const W = 'public.runvara_provider_usage_windows';
const R = 'public.runvara_provider_usage_reservations';
const RESERVE_SIGNATURE = 'public.runvara_reserve_provider_usage(text,text,text,integer,text,text,text,text,text,bigint,bigint,text,timestamp with time zone)';
const SETTLE_SIGNATURE = 'public.runvara_settle_provider_usage(text,text,text,text,jsonb)';
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const worker = 'synthetic-test-worker';
const routeUntil = () => new Date(Date.now() + 60_000).toISOString();
const monthStart = (delta = 0) => { const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + delta, 1)); };
const monthKey = delta => monthStart(delta).toISOString().slice(0, 10);
let admin;
const clients = new Set();

async function connect(role = 'service_role') {
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000, statement_timeout: 30_000, application_name: 'runvara-atomic-usage-test' });
  await client.connect();
  clients.add(client);
  // Role values only come from this literal allowlist; never request input.
  assert.ok(['service_role', 'anon', 'authenticated', 'atomic_usage_untrusted', 'postgres'].includes(role));
  if (role !== 'postgres') await client.query(`SET ROLE ${role}`);
  await client.query("SET TIME ZONE 'UTC'");
  return client;
}
async function close(client) { clients.delete(client); await client.end(); }
async function using(role, fn) { const client = await connect(role); try { return await fn(client); } finally { await close(client); } }
const limits = extra => ({ maxRequests: 1000, maxInputTokens: 1_000_000, maxOutputTokens: 1_000_000, maxTotalTokens: 2_000_000, maxCostMicros: 100_000_000, ...extra });
function providerPolicy(provider = 'openai') {
  const adapter = `${provider}-responses`;
  return {
    enabled: true, allowedAdapters: [adapter], allowedModels: ['synthetic-model'], limits: limits(),
    adapters: { [adapter]: { enabled: true } },
    pricing: [{ version: 'v1', adapterId: adapter, modelId: 'synthetic-model', verified: true,
      checkedAt: Date.now() - 1000, expiresAt: Date.now() + 300_000, currency: 'USD', allInUpperBound: true,
      inputMicrosPerMillionTokens: 0, cachedInputMicrosPerMillionTokens: 0,
      cacheWriteMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0, requestMicros: 10_000 }]
  };
}
async function fixture({ count = 2, mutate = () => {}, monthlyCostLimitUsd = null } = {}) {
  const workspaceId = `atomic-test-${randomUUID()}`;
  const governance = { version: 1, enabled: true, currency: 'USD', accountingStartAt: monthStart(-1).getTime(), configuredAt: monthStart(-1).getTime() - 1, tenantLimits: limits(), providers: { openai: providerPolicy(), xai: providerPolicy('xai') } };
  mutate(governance);
  const state = { workspace: { id: workspaceId }, aiEconomics: { monthlyCostLimitUsd, governance } };
  await admin.query('INSERT INTO public.workspaces (id,name,slug) VALUES ($1,$1,$1)', [workspaceId]);
  await admin.query('INSERT INTO public.saas_workspace_state (workspace_id,state) VALUES ($1,$2)', [workspaceId, state]);
  const jobs = Array.from({ length: count }, (_, index) => `${workspaceId}-job-${index}`);
  for (const jobId of jobs) {
    await admin.query(`INSERT INTO public.runvara_agent_jobs
      (id,workspace_id,type,status,attempts,worker_id,lease_until,idempotency_key)
      VALUES ($1,$2,'agent_command','running',1,$3,clock_timestamp()+interval '10 minutes',$1)`, [jobId, workspaceId, worker]);
  }
  return { workspaceId, jobs, state, governance };
}
async function saveState(f) {
  await admin.query('UPDATE public.saas_workspace_state SET state=$2,updated_at=clock_timestamp() WHERE workspace_id=$1', [f.workspaceId, f.state]);
}
function request(f, index = 0, extra = {}) {
  const jobId = f.jobs[index];
  return { workspaceId: f.workspaceId, jobId, workerId: worker, attempt: 1, callKey: `${jobId}:operator-brief:v1`, fingerprint: hash(jobId), provider: 'openai', adapter: 'openai-responses', model: 'synthetic-model', input: 4, output: 6, pricing: 'v1', validUntil: routeUntil(), ...extra };
}
async function reserve(client, r) {
  const result = await client.query(`SELECT public.runvara_reserve_provider_usage(
    $1::text,$2::text,$3::text,$4::integer,$5::text,$6::text,$7::text,$8::text,$9::text,$10::bigint,$11::bigint,$12::text,$13::timestamptz) AS value`,
  [r.workspaceId, r.jobId, r.workerId, r.attempt, r.callKey, r.fingerprint, r.provider, r.adapter, r.model, r.input, r.output, r.pricing, r.validUntil]);
  return result.rows[0].value;
}
const admit = r => using('service_role', c => reserve(c, r));
function receipt(r, extra = {}) {
  return { jobId: r.jobId, providerRequestId: `synthetic-${hash(r.jobId).slice(0, 24)}`, inputTokens: r.input, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: r.output, totalTokens: r.input + r.output, ...extra };
}
async function settle(client, r, reservationId, outcome = 'complete', data = receipt(r)) {
  const result = await client.query('SELECT public.runvara_settle_provider_usage($1,$2,$3,$4,$5::jsonb) AS value', [r.workspaceId, reservationId, r.fingerprint, outcome, data]);
  return result.rows[0].value;
}
const finish = (r, id, outcome = 'complete', data = receipt(r)) => using('service_role', c => settle(c, r, id, outcome, data));
const denied = (result, reason = 'AI_BUDGET_EXCEEDED') => { assert.equal(result.dispatch_allowed, false); assert.equal(result.reason, reason); };
async function windows(f) { return (await admin.query(`SELECT *,window_start::text AS month FROM ${W} WHERE workspace_id=$1 ORDER BY scope_key,window_start`, [f.workspaceId])).rows; }
async function reservations(f) { return (await admin.query(`SELECT * FROM ${R} WHERE workspace_id=$1 ORDER BY id`, [f.workspaceId])).rows; }
async function measured(f) { return (await admin.query('SELECT * FROM public.runvara_ai_usage WHERE workspace_id=$1 ORDER BY id', [f.workspaceId])).rows; }
function counter(row, name, value) { assert.equal(BigInt(row[name]), BigInt(value), `${row.scope_key}.${name}`); }
async function assertExposure(f, expected, month = monthKey(0)) {
  const rows = (await windows(f)).filter(r => r.month === month);
  assert.equal(rows.length, 2, 'Both tenant and provider counters must exist');
  for (const row of rows) for (const [key, value] of Object.entries(expected)) counter(row, key, value);
}
// A JavaScript start barrier over already-connected, distinct pg.Client objects.
// Every task has its own physical PostgreSQL backend; no Pool/query serialization.
async function race(count, fn) {
  const sessions = await Promise.all(Array.from({ length: count }, () => connect()));
  try {
    const pids = await Promise.all(sessions.map(c => c.query('SELECT pg_backend_pid() AS pid')));
    assert.equal(new Set(pids.map(r => r.rows[0].pid)).size, count, 'Race must use distinct database connections');
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    let ready = 0;
    const tasks = sessions.map((c, i) => (async () => { ready += 1; await barrier; return fn(c, i); })());
    assert.equal(ready, count);
    release();
    const results = await Promise.allSettled(tasks);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    return results.map(r => r.value);
  } finally { await Promise.all(sessions.map(close)); }
}
async function waitUntilBlocked(observer, targetPid, blockerPid) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const result = await observer.query('SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked', [targetPid, blockerPid]);
    if (result.rows[0].blocked) return;
    await delay(10);
  }
  assert.fail('Reservation did not wait for the transaction lock; serialization guarantee missing');
}

before(async () => {
  admin = await connect('postgres');
  const info = (await admin.query('SELECT current_database() AS db,current_user AS role,current_setting(\'server_version_num\')::int AS version,current_setting(\'max_connections\')::int AS capacity')).rows[0];
  assert.equal(info.db, 'runvara_atomic_usage_test');
  assert.ok(info.version >= 170000 && info.version < 180000, 'This gate is verified against PostgreSQL 17');
  assert.ok(info.capacity >= 110, 'Set max_connections >= 110 for the 100-client concurrency test');
  const existing = (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows;
  assert.deepEqual(existing, [], 'Refusing a nonempty database: use a fresh disposable service');
  await admin.query(await readFile(new URL('./atomic-usage-postgres-fixture.sql', import.meta.url), 'utf8'));
  for (const name of ['20260927113000_runvara_agent_operations.sql', '20260927122500_ai_usage_economics.sql']) {
    await admin.query(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  }
  // The preexisting append-only history must survive adding the accounting layer.
  await admin.query("INSERT INTO public.workspaces (id,name,slug) VALUES ('legacy-fixture','Legacy synthetic fixture','legacy-fixture')");
  await admin.query(`INSERT INTO public.runvara_ai_usage (id,workspace_id,task_type,provider,model,input_tokens,output_tokens,estimated_cost_usd,request_id,occurred_at)
    VALUES ('legacy-usage-sentinel','legacy-fixture','synthetic','openai','synthetic-model',7,3,0.01,'legacy-sentinel','2000-01-01T00:00:00Z')`);
  const migration = await readFile(new URL('../supabase/migrations/20261006190318_atomic_provider_usage.sql', import.meta.url), 'utf8');
  assert.ok(migration.includes('runvara_settle_provider_usage'), 'Atomic usage migration must be complete');
  await admin.query(migration);
  await admin.query(await readFile(new URL('../supabase/migrations/20261118185735_verified_provider_usage_opening.sql', import.meta.url), 'utf8'));
  await admin.query(await readFile(new URL('../supabase/migrations/20261119060000_future_provider_allowance.sql', import.meta.url), 'utf8'));
}, { timeout: 30_000 });
after(async () => { await Promise.all([...clients].map(c => close(c).catch(() => {}))); });

test('100 concurrent $0.01 calls admit exactly 10 under a 10-request / $0.10 budget', { timeout: 60_000 }, async () => {
  const f = await fixture({ count: 100, mutate(g) { g.tenantLimits = limits({ maxRequests: 10, maxCostMicros: 100_000 }); g.providers.openai.limits = limits({ maxRequests: 10, maxCostMicros: 100_000 }); } });
  const results = await race(100, (c, i) => reserve(c, request(f, i)));
  assert.equal(results.filter(r => r.dispatch_allowed).length, 10);
  results.filter(r => !r.dispatch_allowed).forEach(r => denied(r));
  assert.equal((await reservations(f)).length, 10);
  await assertExposure(f, { held_requests: 10, held_cost_micros: 100_000, held_input_tokens: 40, held_output_tokens: 60, held_total_tokens: 100, settled_requests: 0 });
  assert.equal((await measured(f)).length, 0, 'Reservations are not measured receipts');
});

for (const scope of ['tenant', 'provider']) {
  for (const [dimension, ceiling] of Object.entries({ maxRequests: 2, maxInputTokens: 8, maxOutputTokens: 12, maxTotalTokens: 20, maxCostMicros: 20_000 })) {
    test(`${scope} ${dimension} independently enforces its finite ceiling`, async () => {
      const f = await fixture({ count: 8, mutate(g) { const target = scope === 'tenant' ? g.tenantLimits : g.providers.openai.limits; target[dimension] = ceiling; } });
      const results = await race(8, (c, i) => reserve(c, request(f, i)));
      assert.equal(results.filter(r => r.dispatch_allowed).length, 2);
      results.filter(r => !r.dispatch_allowed).forEach(r => denied(r));
      await assertExposure(f, { held_requests: 2, held_input_tokens: 8, held_output_tokens: 12, held_total_tokens: 20, held_cost_micros: 20_000 });
    });
  }
}

test('tenant budgets aggregate across providers; provider budgets isolate providers', async () => {
  const tenant = await fixture({ count: 3, mutate(g) { g.tenantLimits.maxRequests = 1; } });
  assert.equal((await admit(request(tenant))).dispatch_allowed, true);
  denied(await admit(request(tenant, 1, { provider: 'xai', adapter: 'xai-responses' })));
  const provider = await fixture({ count: 3, mutate(g) { g.providers.openai.limits.maxRequests = 1; } });
  assert.equal((await admit(request(provider))).dispatch_allowed, true);
  denied(await admit(request(provider, 1)));
  assert.equal((await admit(request(provider, 2, { provider: 'xai', adapter: 'xai-responses' }))).dispatch_allowed, true);
});

test('monthlyCostLimitUsd is an additional exact micro-dollar ceiling', async () => {
  const f = await fixture({ count: 3, monthlyCostLimitUsd: 0.02 });
  assert.equal((await admit(request(f, 0))).dispatch_allowed, true);
  assert.equal((await admit(request(f, 1))).dispatch_allowed, true);
  denied(await admit(request(f, 2)));
});

test('duplicate logical call race grants dispatch once and retries never reacquire it', async () => {
  const f = await fixture();
  const r = request(f);
  const results = await race(16, c => reserve(c, r));
  assert.equal(results.filter(x => x.dispatch_allowed).length, 1);
  assert.equal(new Set(results.map(x => x.reservation_id)).size, 1);
  const id = results[0].reservation_id;
  await assertExposure(f, { held_requests: 1, held_cost_micros: 10_000 });
  assert.equal((await reservations(f)).length, 1);
  denied(await admit(r), 'AI_LOGICAL_CALL_EXISTS');
  await assert.rejects(admit({ ...r, fingerprint: hash('changed') }), /CONFLICT/);
  await assert.rejects(admit({ ...r, model: 'changed-model' }), /CONFLICT/);
  await finish(r, id);
  const retry = await admit(r);
  denied(retry, 'AI_LOGICAL_CALL_EXISTS');
  assert.equal(retry.status, 'settled');
  assert.equal((await measured(f)).length, 1);
});

test('concurrent identical settlements append one receipt and release reservation exactly once', async () => {
  const f = await fixture();
  const r = request(f, 0, { input: 10, output: 20 });
  const held = await admit(r);
  const actual = receipt(r, { inputTokens: 4, outputTokens: 5, totalTokens: 9 });
  const results = await race(12, c => settle(c, r, held.reservation_id, 'complete', actual));
  assert.ok(results.every(x => x.status === 'settled'));
  await assertExposure(f, { held_requests: 0, held_input_tokens: 0, held_output_tokens: 0, held_total_tokens: 0, held_cost_micros: 0,
    settled_requests: 1, settled_input_tokens: 4, settled_output_tokens: 5, settled_total_tokens: 9, settled_cost_micros: 10_000 });
  const rows = await measured(f);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].input_tokens), 4);
  assert.equal(Number(rows[0].output_tokens), 5);
  assert.equal(Number(rows[0].estimated_cost_usd), 0.01);
  await assert.rejects(finish(r, held.reservation_id, 'complete', { ...actual, outputTokens: 6, totalTokens: 10 }), /CONFLICT/);
  assert.equal((await measured(f)).length, 1);
});

test('uncertain dispatch retains exposure through retry and stale lease until a receipt resolves it', async () => {
  const f = await fixture({ mutate(g) { g.tenantLimits.maxRequests = 1; } });
  const r = request(f);
  const held = await admit(r);
  const uncertainty = { jobId: r.jobId, errorCode: 'SYNTHETIC_TIMEOUT' };
  assert.equal((await finish(r, held.reservation_id, 'uncertain', uncertainty)).status, 'uncertain');
  assert.equal((await finish(r, held.reservation_id, 'uncertain', uncertainty)).status, 'uncertain');
  await assert.rejects(finish(r, held.reservation_id, 'uncertain', { ...uncertainty, errorCode: 'DIFFERENT_ERROR' }), /AI_SETTLEMENT_CONFLICT/);
  await admin.query("UPDATE public.runvara_agent_jobs SET lease_until=clock_timestamp()-interval '1 minute', attempts=2, worker_id='replacement-test-worker' WHERE id=$1", [r.jobId]);
  denied(await admit({ ...r, workerId: 'replacement-test-worker', attempt: 2 }), 'AI_LOGICAL_CALL_EXISTS');
  denied(await admit(request(f, 1)));
  await assert.rejects(finish(r, held.reservation_id, 'cancelled_pre_dispatch', { jobId: r.jobId, dispatchStarted: false, proof: 'local_pre_dispatch' }));
  await assertExposure(f, { held_requests: 1, held_cost_micros: 10_000, settled_requests: 0 });
  assert.equal((await measured(f)).length, 0);
  assert.equal((await finish(r, held.reservation_id)).status, 'settled');
  await assertExposure(f, { held_requests: 0, settled_requests: 1, settled_cost_micros: 10_000 });
  denied(await admit(request(f, 1)));
});

test('only proven pre-dispatch cancellation releases a held reservation', async () => {
  const f = await fixture({ mutate(g) { g.tenantLimits.maxRequests = 1; } });
  const r = request(f);
  const held = await admit(r);
  await assert.rejects(finish(r, held.reservation_id, 'cancelled_pre_dispatch', { jobId: r.jobId, dispatchStarted: true, proof: 'local_pre_dispatch' }));
  await assert.rejects(finish(r, held.reservation_id, 'cancelled_pre_dispatch', { jobId: r.jobId, dispatchStarted: false }));
  const proof = { jobId: r.jobId, dispatchStarted: false, proof: 'local_pre_dispatch' };
  assert.equal((await finish(r, held.reservation_id, 'cancelled_pre_dispatch', proof)).status, 'cancelled_pre_dispatch');
  assert.equal((await finish(r, held.reservation_id, 'cancelled_pre_dispatch', proof)).status, 'cancelled_pre_dispatch');
  denied(await admit(r), 'AI_LOGICAL_CALL_EXISTS');
  await assert.rejects(finish(r, held.reservation_id));
  await assertExposure(f, { held_requests: 0, held_cost_micros: 0, settled_requests: 0 });
  assert.equal((await admit(request(f, 1))).dispatch_allowed, true);
  assert.equal((await measured(f)).length, 0);
});

test('new admission rejects expired lease, wrong worker, wrong attempt, and expired routing evidence', async () => {
  const f = await fixture({ count: 4 });
  await admin.query("UPDATE public.runvara_agent_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.jobs[0]]);
  denied(await admit(request(f, 0)), 'AI_JOB_LEASE_INVALID');
  denied(await admit(request(f, 1, { workerId: 'different-test-worker' })), 'AI_JOB_LEASE_INVALID');
  denied(await admit(request(f, 2, { attempt: 2 })), 'AI_JOB_LEASE_INVALID');
  denied(await admit(request(f, 3, { validUntil: new Date(Date.now() - 1000).toISOString() })), 'AI_ROUTE_EXPIRED');
  assert.equal((await reservations(f)).length, 0);
});

test('concurrent policy reduction is observed after the authoritative workspace lock', async () => {
  const f = await fixture();
  const blocker = await connect('postgres');
  const contender = await connect();
  let pending;
  try {
    await blocker.query('BEGIN');
    await blocker.query("UPDATE public.saas_workspace_state SET state=jsonb_set(state,'{aiEconomics,governance,tenantLimits,maxRequests}','0'::jsonb) WHERE workspace_id=$1", [f.workspaceId]);
    pending = reserve(contender, request(f));
    pending.catch(() => {}); // Attach now; assertions still await the original promise.
    await waitUntilBlocked(admin, contender.processID, blocker.processID);
    await blocker.query('COMMIT');
    denied(await pending);
    assert.equal((await reservations(f)).length, 0);
  } finally { await blocker.query('ROLLBACK'); await pending?.catch(() => {}); await close(blocker); await close(contender); }
});

test('a lease invalidated while reservation waits for the job lock cannot authorize dispatch', async () => {
  const f = await fixture();
  const blocker = await connect('postgres');
  const contender = await connect();
  let pending;
  try {
    await blocker.query('BEGIN');
    await blocker.query("UPDATE public.runvara_agent_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [f.jobs[0]]);
    pending = reserve(contender, request(f));
    pending.catch(() => {}); // Attach now; assertions still await the original promise.
    await waitUntilBlocked(admin, contender.processID, blocker.processID);
    await blocker.query('COMMIT');
    denied(await pending, 'AI_JOB_LEASE_INVALID');
    assert.equal((await reservations(f)).length, 0);
  } finally { await blocker.query('ROLLBACK'); await pending?.catch(() => {}); await close(blocker); await close(contender); }
});

// This is a fixture-only time shift by the disposable database administrator.
// There is deliberately no clock override or mutable-window RPC in production.
async function shiftHeldToPreviousMonth(f, id) {
  const previous = monthKey(-1);
  await admin.query('BEGIN');
  try {
    await admin.query(`UPDATE ${R} SET window_start=$2::date,created_at=$2::date::timestamp AT TIME ZONE 'UTC' WHERE id=$1`, [id, previous]);
    await admin.query(`UPDATE ${W} SET window_start=$2::date WHERE workspace_id=$1`, [f.workspaceId, previous]);
    await admin.query('COMMIT');
  } catch (error) { await admin.query('ROLLBACK'); throw error; }
}

test('UTC window identity is stable and late settlement debits its original month', async () => {
  const f = await fixture();
  const oldRequest = request(f);
  const original = await using('service_role', async c => {
    await c.query("SET TIME ZONE 'Pacific/Kiritimati'");
    return reserve(c, oldRequest);
  });
  assert.equal(original.window_start, monthKey(0));
  await shiftHeldToPreviousMonth(f, original.reservation_id);
  const current = await admit(request(f, 1));
  assert.equal(current.dispatch_allowed, true);
  const settled = await using('service_role', async c => {
    await c.query("SET TIME ZONE 'America/Los_Angeles'");
    return settle(c, oldRequest, original.reservation_id);
  });
  assert.equal(settled.window_start, monthKey(-1));
  await assertExposure(f, { held_requests: 0, settled_requests: 1, settled_cost_micros: 10_000 }, monthKey(-1));
  await assertExposure(f, { held_requests: 1, settled_requests: 0, held_cost_micros: 10_000 }, monthKey(0));
  assert.equal((await measured(f))[0].occurred_at.toISOString().slice(0, 10), monthKey(-1));
});

test('a provider token overrun is recorded in full and blocks it even in a fresh month', async () => {
  const f = await fixture({ count: 3 });
  const r = request(f);
  const held = await admit(r);
  await shiftHeldToPreviousMonth(f, held.reservation_id);
  const overrunReceipt = receipt(r, { inputTokens: 5, outputTokens: 7, totalTokens: 12 });
  const result = await finish(r, held.reservation_id, 'complete', overrunReceipt);
  assert.equal(result.status, 'overrun');
  await assertExposure(f, { held_requests: 0, settled_requests: 1, settled_input_tokens: 5, settled_output_tokens: 7, settled_total_tokens: 12 }, monthKey(-1));
  denied(await admit(request(f, 1)), 'AI_PROVIDER_OVERRUN_BLOCKED');
  assert.equal((await admit(request(f, 2, { provider: 'xai', adapter: 'xai-responses' }))).dispatch_allowed, true);
  const otherTenant = await fixture();
  assert.equal((await admit(request(otherTenant))).dispatch_allowed, true);
  assert.equal((await finish(r, held.reservation_id, 'complete', overrunReceipt)).status, 'overrun');
  assert.equal((await measured(f)).length, 1);
});

test('explicit billed-cost overrun is not clamped to the reserved estimate', async () => {
  const f = await fixture();
  const r = request(f);
  const held = await admit(r);
  const result = await finish(r, held.reservation_id, 'complete', receipt(r, { billedCostMicros: 15_000 }));
  assert.equal(result.status, 'overrun');
  assert.equal(Number(result.accounted_cost_micros), 15_000);
  assert.equal(Number((await measured(f))[0].estimated_cost_usd), 0.015);
  await assertExposure(f, { held_cost_micros: 0, settled_cost_micros: 15_000 });
  denied(await admit(request(f, 1)), 'AI_PROVIDER_OVERRUN_BLOCKED');
});

test('workspace and job identities cannot be substituted at admission or settlement', async () => {
  const a = await fixture();
  const b = await fixture();
  const aRequest = request(a);
  denied(await admit({ ...aRequest, jobId: b.jobs[0], callKey: `${b.jobs[0]}:operator-brief:v1` }), 'AI_JOB_LEASE_INVALID');
  const held = await admit(aRequest);
  await assert.rejects(finish({ ...aRequest, workspaceId: b.workspaceId }, held.reservation_id), /AI_RESERVATION_NOT_FOUND/);
  await assert.rejects(finish(aRequest, held.reservation_id, 'complete', receipt(aRequest, { jobId: b.jobs[0] })), /AI_SETTLEMENT_JOB_MISMATCH/);
  await assert.rejects(finish({ ...aRequest, fingerprint: hash('other-request') }, held.reservation_id), /AI_RESERVATION_FINGERPRINT_CONFLICT/);
  await assertExposure(a, { held_requests: 1, settled_requests: 0 });
  assert.equal((await reservations(b)).length, 0);
  assert.equal((await measured(a)).length, 0);
  assert.equal((await measured(b)).length, 0);
});

test('a reused provider receipt ID rolls back every settlement change', async () => {
  const f = await fixture();
  const first = request(f);
  const second = request(f, 1);
  const a = await admit(first);
  const b = await admit(second);
  const oneReceipt = receipt(first);
  await finish(first, a.reservation_id, 'complete', oneReceipt);
  await assert.rejects(finish(second, b.reservation_id, 'complete', receipt(second, { providerRequestId: oneReceipt.providerRequestId })), error => error.code === '23505');
  await assertExposure(f, { held_requests: 1, settled_requests: 1, held_cost_micros: 10_000, settled_cost_micros: 10_000 });
  const pending = (await reservations(f)).find(r => r.id === b.reservation_id);
  assert.equal(pending.status, 'held');
  assert.equal((await measured(f)).length, 1);
});

test('missing or incoherent measured usage remains uncertain with the entire hold', async () => {
  for (const change of [
    r => ({ jobId: r.jobId }),
    r => receipt(r, { totalTokens: 999 }),
    r => receipt(r, { cachedInputTokens: r.input + 1 }),
    r => receipt(r, { outputTokens: -1 }),
    r => receipt(r, { inputTokens: '4' }),
    r => receipt(r, { billedCostMicros: -1 }),
    r => receipt(r, { providerRequestId: '' })
  ]) {
    const f = await fixture();
    const r = request(f);
    const held = await admit(r);
    assert.equal((await finish(r, held.reservation_id, 'complete', change(r))).status, 'uncertain');
    await assertExposure(f, { held_requests: 1, held_cost_micros: 10_000, held_input_tokens: 4, held_output_tokens: 6, settled_requests: 0 });
    assert.equal((await measured(f)).length, 0);
  }
});

test('unrecognized content fields never enter a reservation or measured receipt', async () => {
  const f = await fixture();
  const r = request(f);
  const held = await admit(r);
  for (const field of ['prompt', 'response', 'apiKey', 'authorization', 'pricing']) {
    await assert.rejects(finish(r, held.reservation_id, 'complete', receipt(r, { [field]: 'SYNTHETIC_CONTENT_MUST_NOT_BE_PERSISTED' })), /AI_SETTLEMENT_INPUT_INVALID/);
  }
  assert.ok(!(JSON.stringify(await reservations(f))).includes('SYNTHETIC_CONTENT_MUST_NOT_BE_PERSISTED'));
  assert.equal((await measured(f)).length, 0);
});

test('pricing reserves worst-case cache rates with upward rounding and settlement uses its immutable snapshot', async () => {
  const f = await fixture({ mutate(g) {
    Object.assign(g.providers.openai.pricing[0], { requestMicros: 0, inputMicrosPerMillionTokens: 1, cachedInputMicrosPerMillionTokens: 2, cacheWriteMicrosPerMillionTokens: 1_000_001, outputMicrosPerMillionTokens: 1 });
  } });
  const r = request(f, 0, { input: 1, output: 1 });
  const held = await admit(r);
  assert.equal(held.reserved_cost_micros, 3, 'ceil(1.000001) + ceil(0.000001)');
  f.governance.providers.openai.pricing[0].cacheWriteMicrosPerMillionTokens = 999_000_000;
  f.governance.providers.openai.pricing[0].outputMicrosPerMillionTokens = 999_000_000;
  await saveState(f);
  const result = await finish(r, held.reservation_id, 'complete', receipt(r, { cacheWriteTokens: 1 }));
  assert.equal(result.status, 'settled');
  assert.equal(result.accounted_cost_micros, 3, 'Settlement must use original stored rates');
  await assertExposure(f, { held_cost_micros: 0, settled_cost_micros: 3 });
});

test('zero limits stay zero; absent, negative, fractional, string, and unsafe limits fail closed', async () => {
  for (const scope of ['tenant', 'provider']) {
    for (const value of [0, undefined, null, -1, 0.5, '100', 9_007_199_254_740_992]) {
      const f = await fixture({ mutate(g) {
        const target = scope === 'tenant' ? g.tenantLimits : g.providers.openai.limits;
        if (value === undefined) delete target.maxRequests;
        else target.maxRequests = value;
      } });
      denied(await admit(request(f)), value === 0 ? 'AI_BUDGET_EXCEEDED' : 'AI_POLICY_LIMIT_INVALID');
      assert.equal((await reservations(f)).length, 0);
    }
  }
});

test('missing governance, disallowed providers, stale prices, ambiguous versions, and invalid bounds cannot reserve', async () => {
  for (const [change, reason] of [
    [g => { g.enabled = false; }, 'AI_GOVERNANCE_NOT_CONFIGURED'],
    [g => { g.accountingStartAt = Date.now(); }, 'AI_ACCOUNTING_BASELINE_UNVERIFIED'],
    [g => { g.configuredAt = g.accountingStartAt + 1; }, 'AI_ACCOUNTING_BASELINE_UNVERIFIED'],
    [g => { g.providers.openai.enabled = false; }, 'AI_PROVIDER_NOT_ALLOWED'],
    [g => { g.providers.openai.adapters['openai-responses'].enabled = false; }, 'AI_PROVIDER_NOT_ALLOWED'],
    [g => { g.providers.openai.allowedModels = []; }, 'AI_PROVIDER_NOT_ALLOWED'],
    [g => { g.providers.openai.pricing[0].verified = false; }, 'AI_PRICING_UNVERIFIED'],
    [g => { g.providers.openai.pricing.push({ ...g.providers.openai.pricing[0] }); }, 'AI_PRICING_UNVERIFIED'],
    [g => { g.providers.openai.pricing[0].expiresAt = Date.now() - 1000; }, 'AI_PRICING_EXPIRED'],
    [g => { g.providers.openai.pricing[0].checkedAt = Date.now() - 31 * 86_400_000; }, 'AI_PRICING_EXPIRED'],
    [g => { delete g.providers.openai.pricing[0].cacheWriteMicrosPerMillionTokens; }, 'AI_PRICING_UNVERIFIED'],
    [g => { g.providers.openai.pricing[0].requestMicros = '10000'; }, 'AI_PRICING_UNVERIFIED']
  ]) {
    const f = await fixture({ mutate: change });
    denied(await admit(request(f)), reason);
    assert.equal((await reservations(f)).length, 0);
  }
  const f = await fixture();
  for (const change of [{ input: -1 }, { input: 1_000_001 }, { output: 128_001 }, { fingerprint: 'not-a-sha256' }, { callKey: 'arbitrary-key' }]) {
    await assert.rejects(admit({ ...request(f), ...change }), /AI_RESERVATION_INPUT_INVALID/);
  }
  assert.equal((await reservations(f)).length, 0);
});

test('preexisting ledger history survives migration and unaccounted current usage blocks activation', async () => {
  const sentinel = (await admin.query("SELECT * FROM public.runvara_ai_usage WHERE id='legacy-usage-sentinel'")).rows[0];
  assert.equal(sentinel.workspace_id, 'legacy-fixture');
  assert.equal(sentinel.request_id, 'legacy-sentinel');
  assert.equal(sentinel.input_tokens, '7');
  assert.equal(sentinel.output_tokens, '3');
  assert.equal(Number(sentinel.estimated_cost_usd), 0.01);
  const f = await fixture();
  await admin.query(`INSERT INTO public.runvara_ai_usage (id,workspace_id,job_id,task_type,provider,model,input_tokens,output_tokens,estimated_cost_usd)
    VALUES ($1,$2,$3,'agent_command','openai','synthetic-model',1,1,0.01)`, [`legacy-${randomUUID()}`, f.workspaceId, f.jobs[0]]);
  denied(await admit(request(f)), 'AI_ACCOUNTING_BASELINE_UNVERIFIED');
  assert.equal((await reservations(f)).length, 0);
  assert.equal((await measured(f)).length, 1);
});

test('RPCs are invoker-only, fixed-search-path, server-executable; tables keep RLS and append-only usage grants', async () => {
  const functions = (await admin.query(`SELECT proname,prosecdef,proconfig FROM pg_proc
    WHERE oid IN ($1::regprocedure,$2::regprocedure)`, [RESERVE_SIGNATURE, SETTLE_SIGNATURE])).rows;
  assert.equal(functions.length, 2);
  for (const fn of functions) {
    assert.equal(fn.prosecdef, false, `${fn.proname} must be SECURITY INVOKER`);
    assert.ok(fn.proconfig.some(x => x.startsWith('search_path=') && x.slice('search_path='.length).replaceAll('"', '').trim() === ''), 'Empty fixed search_path required');
  }
  const tables = ['runvara_provider_usage_windows', 'runvara_provider_usage_reservations', 'runvara_ai_usage'];
  const rls = (await admin.query('SELECT relname,relrowsecurity FROM pg_class WHERE relnamespace=\'public\'::regnamespace AND relname=ANY($1::text[])', [tables])).rows;
  assert.equal(rls.length, 3);
  assert.ok(rls.every(r => r.relrowsecurity));
  const counters = (await admin.query("SELECT column_name,data_type,numeric_precision,numeric_scale FROM information_schema.columns WHERE table_schema='public' AND table_name='runvara_provider_usage_windows' AND (column_name LIKE 'held_%' OR column_name LIKE 'settled_%')")).rows;
  assert.equal(counters.length, 10);
  assert.ok(counters.every(c => c.data_type === 'numeric' && c.numeric_precision === 60 && c.numeric_scale === 0), 'All ten aggregate counters must preserve exact nonnegative integers beyond bigint range');
  for (const role of ['anon', 'authenticated', 'atomic_usage_untrusted']) {
    for (const signature of [RESERVE_SIGNATURE, SETTLE_SIGNATURE]) {
      const result = await admin.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed', [role, signature]);
      assert.equal(result.rows[0].allowed, false, `${role} cannot execute ${signature}`);
    }
    await using(role, async c => {
      for (const table of tables) await assert.rejects(c.query(`SELECT * FROM public.${table}`), e => e.code === '42501');
    });
  }
  for (const signature of [RESERVE_SIGNATURE, SETTLE_SIGNATURE]) {
    assert.equal((await admin.query('SELECT has_function_privilege(\'service_role\',$1,\'EXECUTE\') AS allowed', [signature])).rows[0].allowed, true);
  }
  for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
    assert.equal((await admin.query('SELECT has_table_privilege(\'service_role\',\'public.runvara_ai_usage\',$1) AS allowed', [privilege])).rows[0].allowed, false);
  }
  const f = await fixture();
  const r = request(f);
  const held = await admit(r);
  await using('service_role', async c => {
    const identity = (await c.query('SELECT current_user AS role,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser')).rows[0];
    assert.equal(identity.role, 'service_role');
    assert.equal(identity.superuser, false);
    for (const column of ['workspace_id', 'job_id', 'request_fingerprint', 'pricing_snapshot', 'window_start', 'reserved_cost_micros']) {
      await assert.rejects(c.query(`UPDATE ${R} SET ${column}=${column} WHERE id=$1`, [held.reservation_id]), e => e.code === '42501');
    }
    await assert.rejects(c.query(`DELETE FROM ${R} WHERE id=$1`, [held.reservation_id]), e => e.code === '42501');
    await assert.rejects(c.query("UPDATE public.runvara_ai_usage SET input_tokens=99 WHERE id='legacy-usage-sentinel'"), e => e.code === '42501');
    await assert.rejects(c.query("DELETE FROM public.runvara_ai_usage WHERE id='legacy-usage-sentinel'"), e => e.code === '42501');
  });
  for (const role of ['anon', 'authenticated']) {
    await using(role, async c => {
      await assert.rejects(reserve(c, r), e => e.code === '42501');
      await assert.rejects(settle(c, r, held.reservation_id), e => e.code === '42501');
    });
  }
});

test('RLS denies rows even if a browser table SELECT grant is accidentally restored', async () => {
  // Transaction-local test grant proves the RLS layer separately from REVOKE.
  await admin.query('BEGIN');
  try {
    await admin.query(`GRANT SELECT ON ${W},${R},public.runvara_ai_usage TO authenticated`);
    await admin.query('SET LOCAL ROLE authenticated');
    for (const table of [W, R, 'public.runvara_ai_usage']) assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
  } finally { await admin.query('ROLLBACK'); }
});

test('hostile caller search_path cannot shadow trusted accounting tables', async () => {
  const f = await fixture();
  const result = await using('service_role', async c => {
    await c.query("SET search_path=pg_temp,public");
    await c.query('CREATE TEMP TABLE saas_workspace_state (workspace_id text,state jsonb)');
    await c.query('CREATE TEMP TABLE runvara_agent_jobs (id text)');
    await c.query('CREATE TEMP TABLE runvara_provider_usage_windows (workspace_id text)');
    return reserve(c, request(f));
  });
  assert.equal(result.dispatch_allowed, true);
  await assertExposure(f, { held_requests: 1, held_cost_micros: 10_000 });
});

test('large measured overrun remains exact beyond the legacy USD 1m numeric ceiling', async () => {
  const f = await fixture({ mutate(g) {
    Object.assign(g.providers.openai.pricing[0], { requestMicros: 0, inputMicrosPerMillionTokens: 1_000_000 });
  } });
  const r = request(f, 0, { output: 0 });
  const held = await admit(r);
  const result = await finish(r, held.reservation_id, 'complete', receipt(r, { inputTokens: 2_000_000_000_000, outputTokens: 0, totalTokens: 2_000_000_000_000 }));
  assert.equal(result.status, 'overrun');
  assert.equal(result.accounted_cost_micros, 2_000_000_000_000);
  const usage = (await measured(f))[0];
  assert.equal(usage.estimated_cost_usd, '2000000.00000000');
  assert.equal(usage.input_tokens, '2000000000000');
  await assertExposure(f, { held_cost_micros: 0, settled_cost_micros: 2_000_000_000_000 });
  denied(await admit(request(f, 1)), 'AI_PROVIDER_OVERRUN_BLOCKED');
});

test('routing evidence that expires while waiting on the workspace lock is rejected', async () => {
  const f = await fixture();
  const blocker = await connect('postgres');
  const contender = await connect();
  let pending;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM public.saas_workspace_state WHERE workspace_id=$1 FOR UPDATE', [f.workspaceId]);
    const r = request(f, 0, { validUntil: new Date(Date.now() + 200).toISOString() });
    pending = reserve(contender, r);
    pending.catch(() => {});
    await waitUntilBlocked(admin, contender.processID, blocker.processID);
    await delay(Math.max(0, Date.parse(r.validUntil) - Date.now()) + 30);
    await blocker.query('COMMIT');
    denied(await pending, 'AI_ROUTE_EXPIRED');
    assert.equal((await reservations(f)).length, 0);
  } finally { await blocker.query('ROLLBACK'); await pending?.catch(() => {}); await close(blocker); await close(contender); }
});

test('measured lower cost releases only unused exposure, keeping settled spend in later admissions', async () => {
  const f = await fixture({ count: 3, mutate(g) {
    g.tenantLimits.maxCostMicros = 30;
    Object.assign(g.providers.openai.pricing[0], { requestMicros: 0, inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 1_000_000 });
  } });
  const r = request(f, 0, { input: 10, output: 20 });
  const held = await admit(r);
  assert.equal(held.reserved_cost_micros, 30);
  denied(await admit(request(f, 1)));
  await finish(r, held.reservation_id, 'complete', receipt(r, { inputTokens: 4, outputTokens: 5, totalTokens: 9 }));
  await assertExposure(f, { held_cost_micros: 0, settled_cost_micros: 9 });
  const second = await admit(request(f, 1, { input: 10, output: 11 }));
  assert.equal(second.dispatch_allowed, true);
  assert.equal(second.reserved_cost_micros, 21);
  denied(await admit(request(f, 2)));
  await assertExposure(f, { held_cost_micros: 21, settled_cost_micros: 9 });
});

test('maximum-supported measured monetary overrun settles exactly above bigint and JS-safe ranges', async () => {
  const f = await fixture({ mutate(g) {
    g.tenantLimits.maxCostMicros = Number.MAX_SAFE_INTEGER;
    g.providers.openai.limits.maxCostMicros = Number.MAX_SAFE_INTEGER;
    Object.assign(g.providers.openai.pricing[0], { requestMicros: 0, inputMicrosPerMillionTokens: Number.MAX_SAFE_INTEGER });
  } });
  const r = request(f, 0, { input: 1, output: 0 });
  const held = await admit(r);
  assert.equal(held.reserved_cost_micros, Number((BigInt(Number.MAX_SAFE_INTEGER) + 999_999n) / 1_000_000n));
  const amount = (BigInt(Number.MAX_SAFE_INTEGER) ** 2n + 999_999n) / 1_000_000n;
  assert.ok(amount > 9_223_372_036_854_775_807n);
  const actual = receipt(r, { inputTokens: Number.MAX_SAFE_INTEGER, totalTokens: Number.MAX_SAFE_INTEGER });
  const result = await finish(r, held.reservation_id, 'complete', actual);
  assert.equal(result.status, 'overrun');
  assert.equal(result.accounted_cost_micros, amount.toString(), 'Unsafe JavaScript monetary values must be exact decimal strings');
  const repeated = await finish(r, held.reservation_id, 'complete', actual);
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.accounted_cost_micros, amount.toString());
  await assertExposure(f, { held_requests: 0, held_cost_micros: 0, settled_requests: 1, settled_cost_micros: amount.toString(), settled_input_tokens: String(Number.MAX_SAFE_INTEGER) });
  const usage = await measured(f);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].estimated_cost_usd, `${amount / 1_000_000n}.${String(amount % 1_000_000n).padStart(6, '0')}00`);
  assert.equal((await reservations(f))[0].accounted_cost_micros, amount.toString());
  denied(await admit(request(f, 1)), 'AI_PROVIDER_OVERRUN_BLOCKED');
});

test('cumulative monetary overruns cross bigint range without losing either settlement', async () => {
  const f = await fixture({ mutate(g) {
    g.tenantLimits.maxCostMicros = Number.MAX_SAFE_INTEGER;
    g.providers.openai.limits.maxCostMicros = Number.MAX_SAFE_INTEGER;
    Object.assign(g.providers.openai.pricing[0], { requestMicros: 0, inputMicrosPerMillionTokens: 9_000_000_000_000_000 });
  } });
  const a = request(f, 0, { input: 1, output: 0 });
  const b = request(f, 1, { input: 1, output: 0 });
  // Both holds precede the first overrun, which correctly blocks new admissions.
  const first = await admit(a);
  const second = await admit(b);
  const oneCost = 9_000_000_000_000_000_000n;
  for (const [r, hold] of [[a, first], [b, second]]) {
    const actual = receipt(r, { inputTokens: 1_000_000_000, totalTokens: 1_000_000_000 });
    const result = await finish(r, hold.reservation_id, 'complete', actual);
    assert.equal(result.status, 'overrun');
    assert.equal(result.accounted_cost_micros, oneCost.toString());
    assert.equal((await finish(r, hold.reservation_id, 'complete', actual)).idempotent, true);
  }
  await assertExposure(f, { held_requests: 0, held_cost_micros: 0, settled_requests: 2, settled_cost_micros: (2n * oneCost).toString(), settled_input_tokens: 2_000_000_000 });
  const usage = await measured(f);
  assert.equal(usage.length, 2);
  assert.ok(usage.every(row => row.estimated_cost_usd === '9000000000000.00000000'));
});

test('cumulative observed token totals remain exact when historical usage crosses bigint range', async () => {
  const f = await fixture({ mutate(g) { g.providers.openai.pricing[0].requestMicros = 0; } });
  const r = request(f, 0, { input: 1, output: 0 });
  const held = await admit(r);
  const historical = 9_223_372_036_854_775_807n - 5n;
  // Disposable administrator fixture simulates a large sum of old measured
  // receipts. No privileged counter mutation is exposed by a production RPC.
  await admin.query(`UPDATE ${W} SET settled_requests=2000,settled_input_tokens=$2::numeric,settled_total_tokens=$2::numeric WHERE workspace_id=$1`, [f.workspaceId, historical.toString()]);
  const actual = receipt(r, { inputTokens: 10, totalTokens: 10 });
  const result = await finish(r, held.reservation_id, 'complete', actual);
  assert.equal(result.status, 'overrun');
  assert.equal(result.accounted_cost_micros, 0);
  await assertExposure(f, { held_requests: 0, held_input_tokens: 0, held_total_tokens: 0,
    settled_requests: 2001, settled_input_tokens: (historical + 10n).toString(), settled_output_tokens: 0,
    settled_total_tokens: (historical + 10n).toString(), settled_cost_micros: 0 });
  assert.equal((await finish(r, held.reservation_id, 'complete', actual)).idempotent, true);
  await assertExposure(f, { settled_input_tokens: (historical + 10n).toString(), settled_total_tokens: (historical + 10n).toString() });
  const usage = await measured(f);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].input_tokens, '10');
  denied(await admit(request(f, 1)), 'AI_PROVIDER_OVERRUN_BLOCKED');
});

test('reservation timestamp uses post-lock wall time rather than the outer transaction start', async () => {
  const f = await fixture();
  await using('service_role', async c => {
    await c.query('BEGIN');
    try {
      // PostgreSQL now()/transaction_timestamp() stays fixed for this entire
      // transaction. The reservation must record its actual admission time.
      const transactionStart = (await c.query('SELECT transaction_timestamp()::text AS value')).rows[0].value;
      await delay(30);
      const beforeReserve = (await c.query('SELECT clock_timestamp()::text AS value')).rows[0].value;
      const result = await reserve(c, request(f));
      assert.equal(result.dispatch_allowed, true);
      const row = (await c.query(`SELECT
        created_at >= $2::timestamptz AS after_reserve_start,
        created_at > $3::timestamptz AS after_transaction_start,
        window_start = date_trunc('month',created_at AT TIME ZONE 'UTC')::date AS same_utc_month
        FROM ${R} WHERE id=$1`, [result.reservation_id, beforeReserve, transactionStart])).rows[0];
      assert.equal(row.after_reserve_start, true, 'created_at must use fresh wall time captured after the admission locks');
      assert.equal(row.after_transaction_start, true, 'created_at must not use the outer transaction timestamp');
      assert.equal(row.same_utc_month, true, 'Reservation timestamp and accounting month must agree in UTC');
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
});

// Verified openings are administrator attestations, never measurements inferred
// from these deliberately synthetic fixtures or an empty ledger.
const O = 'public.runvara_provider_usage_openings';
const openingBalance = extra => ({ requests: 2, inputTokens: 8, outputTokens: 12, totalTokens: 20, costMicros: 20_000, ...extra });
const legacyFingerprint = async f => (await admin.query('SELECT public.runvara_legacy_usage_fingerprint($1) AS value', [f.workspaceId])).rows[0].value;
async function openingEvidence(f, providers = { openai: openingBalance() }) {
  return { version: 1, workspaceId: f.workspaceId, currency: 'USD', windowStart: monthKey(0),
    evidenceHash: hash(`SYNTHETIC-NOT-BILLING:${f.workspaceId}`), verifiedAt: Date.now(), legacyDispatchStoppedAt: Date.now() - 1000,
    legacyDispatchersRetired: true, historicalExposureReconciled: true, monthUsageComplete: true,
    legacyUsageFingerprint: await legacyFingerprint(f), providers };
}
async function installOpening(f, evidence, client = admin) {
  return (await client.query('SELECT public.runvara_install_provider_usage_opening($1,$2) AS value', [f.workspaceId, evidence])).rows[0].value;
}
async function openingFixture(options = {}) {
  const f = await fixture(options);
  f.governance.enabled = false;
  await saveState(f);
  return f;
}
async function enableOpening(f, opening, { freshJobs = true } = {}) {
  f.governance.enabled = true;
  f.governance.accountingStartAt = opening.accountingStartAt;
  f.governance.configuredAt = Date.now();
  await saveState(f);
  // Test fixture only: model jobs actually enqueued after cutover. Production
  // must create new jobs; modifying old jobs is never a cutover instruction.
  if (freshJobs) await admin.query('UPDATE public.runvara_agent_jobs SET created_at=clock_timestamp() WHERE workspace_id=$1', [f.workspaceId]);
}
async function legacyRow(f, { provider = 'openai', occurredAt = new Date(), input = 4, output = 6, cost = 0.01 } = {}) {
  await admin.query(`INSERT INTO public.runvara_ai_usage (id,workspace_id,task_type,provider,model,input_tokens,output_tokens,estimated_cost_usd,occurred_at)
    VALUES ($1,$2,'synthetic',$3,'synthetic-model',$4,$5,$6,$7)`, [`synthetic-legacy-${randomUUID()}`, f.workspaceId, provider, input, output, cost, occurredAt]);
}
async function noOpeningEffects(f) {
  assert.equal((await admin.query(`SELECT * FROM ${O} WHERE workspace_id=$1`, [f.workspaceId])).rowCount, 0);
  assert.equal((await windows(f)).length, 0);
  assert.equal((await reservations(f)).length, 0);
}

test('opening installation records real database time, preserves history and stays disabled', async () => {
  const f = await openingFixture();
  await legacyRow(f);
  const before = await measured(f), evidence = await openingEvidence(f);
  const start = Date.now(), result = await installOpening(f, evidence);
  assert.ok(result.accountingStartAt >= start && result.accountingStartAt <= Date.now());
  assert.equal(result.windowStart, monthKey(0));
  assert.equal(result.idempotent, false);
  assert.deepEqual(await measured(f), before);
  assert.equal((await reservations(f)).length, 0);
  await assertExposure(f, { settled_requests: 2, settled_input_tokens: 8, settled_output_tokens: 12, settled_total_tokens: 20, settled_cost_micros: 20_000, held_requests: 0 });
  denied(await admit(request(f)), 'AI_GOVERNANCE_NOT_CONFIGURED');
  const saved = (await admin.query(`SELECT * FROM ${O} WHERE workspace_id=$1`, [f.workspaceId])).rows[0];
  assert.deepEqual(saved.attestation, evidence);
  assert.equal(saved.recorded_by, 'postgres');
  await enableOpening(f, result);
  assert.equal((await admit(request(f))).dispatch_allowed, true);
});

for (const scope of ['tenant', 'provider']) {
  for (const [dimension, ceiling] of Object.entries({ maxRequests: 3, maxInputTokens: 12, maxOutputTokens: 18, maxTotalTokens: 30, maxCostMicros: 30_000 })) {
    test(`verified opening consumes ${scope} ${dimension} before concurrent admission`, async () => {
      const f = await openingFixture({ count: 8, mutate(g) { (scope === 'tenant' ? g.tenantLimits : g.providers.openai.limits)[dimension] = ceiling; } });
      const installed = await installOpening(f, await openingEvidence(f));
      await enableOpening(f, installed);
      const results = await race(8, (c, i) => reserve(c, request(f, i)));
      assert.equal(results.filter(r => r.dispatch_allowed).length, 1);
      results.filter(r => !r.dispatch_allowed).forEach(r => denied(r));
      await assertExposure(f, { settled_requests: 2, settled_cost_micros: 20_000, held_requests: 1, held_cost_micros: 10_000 });
    });
  }
}

test('opening aggregates providers and retains the owner lower cap', async () => {
  const f = await openingFixture({ monthlyCostLimitUsd: 0.05 });
  const installed = await installOpening(f, await openingEvidence(f, { openai: openingBalance(), xai: openingBalance() }));
  await enableOpening(f, installed);
  const rows = await windows(f);
  counter(rows.find(r => r.scope_key === 'tenant'), 'settled_cost_micros', 40_000);
  counter(rows.find(r => r.scope_key === 'provider:openai'), 'settled_cost_micros', 20_000);
  assert.equal((await admit(request(f))).dispatch_allowed, true);
  denied(await admit(request(f, 1, { provider: 'xai', adapter: 'xai-responses' })));
});

test('invalid, incomplete, unknown or backdated opening attestations fail without effects', async () => {
  const changes = [
    e => { e.workspaceId = 'other-tenant'; }, e => { e.currency = 'GBP'; }, e => { e.version = 2; },
    e => { delete e.evidenceHash; }, e => { e.evidenceHash = 'not-verified'; },
    e => { e.historicalExposureReconciled = false; }, e => { delete e.legacyDispatchersRetired; },
    e => { e.monthUsageComplete = 'true'; }, e => { e.verifiedAt = Date.now() + 60000; },
    e => { e.verifiedAt = Date.now() - 86400001; }, e => { e.legacyDispatchStoppedAt = e.verifiedAt + 1; },
    e => { e.windowStart = monthKey(-1); }, e => { e.accountingStartAt = monthStart().getTime(); },
    e => { e.providers = {}; }, e => { e.providers.openai.costMicros = -1; },
    e => { e.providers.openai.requests = '2'; }, e => { e.providers.openai.inputTokens = 1.5; },
    e => { e.providers.openai.totalTokens = 999; }, e => { e.providers.openai.costMicros = 9007199254740992; },
    e => { e.providers.openai.extra = 'not permitted'; }, e => { e.providers = { 'invalid?': openingBalance() }; },
    e => { e.providers.xai = openingBalance({ costMicros: Number.MAX_SAFE_INTEGER }); }
  ];
  for (const change of changes) {
    const f = await openingFixture(), evidence = await openingEvidence(f);
    change(evidence);
    await assert.rejects(installOpening(f, evidence), /AI_OPENING_/);
    await noOpeningEffects(f);
  }
});

test('opening refuses missing provider, understated measured amounts, changed history and future receipts', async () => {
  for (const change of [e => { delete e.providers.openai; e.providers.xai = openingBalance(); },
    e => { e.providers.openai.requests = 0; }, e => { e.providers.openai.inputTokens = 3; e.providers.openai.totalTokens = 15; },
    e => { e.providers.openai.outputTokens = 5; e.providers.openai.totalTokens = 13; },
    e => { e.providers.openai.costMicros = 9999; }]) {
    const f = await openingFixture(); await legacyRow(f);
    const before = await measured(f), evidence = await openingEvidence(f); change(evidence);
    await assert.rejects(installOpening(f, evidence), /AI_OPENING_BELOW_RECORDED_USAGE/);
    await noOpeningEffects(f); assert.deepEqual(await measured(f), before);
  }
  const drift = await openingFixture(), old = await openingEvidence(drift);
  await legacyRow(drift, { occurredAt: monthStart(-1) });
  await assert.rejects(installOpening(drift, old), /AI_OPENING_LEGACY_HISTORY_CHANGED/);
  await noOpeningEffects(drift);
  const future = await openingFixture(); await legacyRow(future, { occurredAt: new Date(Date.now() + 60000) });
  await assert.rejects(installOpening(future, await openingEvidence(future)), /AI_OPENING_LEGACY_HISTORY_INVALID/);
  await noOpeningEffects(future);
});

test('opening cannot reset governed held, uncertain, settled, cancelled or empty window history', async () => {
  for (const status of ['held', 'uncertain', 'settled', 'cancelled_pre_dispatch', 'window']) {
    const f = await fixture(), r = request(f);
    if (status === 'window') {
      f.governance.tenantLimits.maxRequests = 0; await saveState(f); denied(await admit(r));
    } else {
      const held = await admit(r);
      if (status === 'uncertain') await finish(r, held.reservation_id, status, { jobId: r.jobId, errorCode: 'SYNTHETIC_TIMEOUT' });
      if (status === 'settled') await finish(r, held.reservation_id);
      if (status === 'cancelled_pre_dispatch') await finish(r, held.reservation_id, status, { jobId: r.jobId, dispatchStarted: false, proof: 'local_pre_dispatch' });
    }
    f.governance.enabled = false; await saveState(f);
    const before = [await windows(f), await reservations(f), await measured(f)];
    await assert.rejects(installOpening(f, await openingEvidence(f)), /AI_OPENING_GOVERNED_HISTORY_EXISTS/);
    assert.deepEqual([await windows(f), await reservations(f), await measured(f)], before);
  }
  const enabled = await fixture();
  await assert.rejects(installOpening(enabled, await openingEvidence(enabled)), /AI_OPENING_REQUIRES_DISABLED_GOVERNANCE/);
  await noOpeningEffects(enabled);
});

test('concurrent duplicate opening installs once, lost acknowledgement reconciles and conflict cannot replace it', async () => {
  const f = await openingFixture(), evidence = await openingEvidence(f);
  const results = await Promise.all(Array.from({ length: 6 }, () => using('postgres', c => installOpening(f, evidence, c))));
  assert.equal(results.filter(r => !r.idempotent).length, 1);
  assert.equal(new Set(results.map(r => r.accountingStartAt)).size, 1);
  await assertExposure(f, { settled_requests: 2, settled_cost_micros: 20_000 });
  const before = await windows(f);
  // Simulated lost reply after a committed transaction: exact readback exists,
  // and even duplicate delivery cannot increment the opening a second time.
  assert.equal((await installOpening(f, evidence)).idempotent, true);
  await assert.rejects(installOpening(f, { ...evidence, evidenceHash: hash('different evidence') }), /AI_OPENING_CONFLICT/);
  assert.deepEqual(await windows(f), before);
});

test('opening transaction rollback cannot leave an attestation or partially seeded counters', async () => {
  const f = await openingFixture(), evidence = await openingEvidence(f);
  await using('postgres', async c => {
    await c.query('BEGIN');
    await installOpening(f, evidence, c);
    await c.query('ROLLBACK');
  });
  await noOpeningEffects(f);
  assert.equal((await installOpening(f, evidence)).idempotent, false);
});

test('runtime and tenant roles cannot install or mutate verified opening evidence', async () => {
  const f = await openingFixture(), evidence = await openingEvidence(f);
  for (const role of ['service_role', 'anon', 'authenticated', 'atomic_usage_untrusted']) {
    await using(role, async c => {
      await assert.rejects(installOpening(f, evidence, c), /permission denied/);
      await assert.rejects(c.query(`INSERT INTO ${O} (workspace_id) VALUES ($1)`, [f.workspaceId]), /permission denied/);
      await assert.rejects(c.query(`UPDATE ${O} SET accounting_start_at=1 WHERE workspace_id=$1`, [f.workspaceId]), /permission denied/);
      await assert.rejects(c.query(`DELETE FROM ${O} WHERE workspace_id=$1`, [f.workspaceId]), /permission denied/);
      await assert.rejects(c.query(`TRUNCATE ${O}`), /permission denied/);
    });
  }
  await installOpening(f, evidence);
  await admin.query(`GRANT SELECT ON ${O} TO atomic_usage_untrusted`);
  try { await using('atomic_usage_untrusted', async c => assert.equal((await c.query(`SELECT * FROM ${O}`)).rowCount, 0)); }
  finally { await admin.query(`REVOKE SELECT ON ${O} FROM atomic_usage_untrusted`); }
  const other = await openingFixture();
  await assert.rejects(installOpening(other, evidence), /AI_OPENING_ATTESTATION_INVALID/);
  await noOpeningEffects(other);
});

test('opening baseline cannot be backdated, changed, used by stale jobs or extended to an unattested provider', async () => {
  const f = await openingFixture();
  await delay(3);
  const installed = await installOpening(f, await openingEvidence(f));
  await enableOpening(f, installed, { freshJobs: false });
  denied(await admit(request(f)), 'AI_ACCOUNTING_BASELINE_UNVERIFIED');
  await enableOpening(f, installed);
  denied(await admit(request(f, 0, { provider: 'xai', adapter: 'xai-responses' })), 'AI_ACCOUNTING_BASELINE_UNVERIFIED');
  const original = structuredClone(f.governance);
  for (const change of [g => { g.accountingStartAt = monthStart().getTime(); }, g => { g.configuredAt = installed.accountingStartAt - 1; },
    g => { g.configuredAt = Date.now() + 60000; }, g => { g.configuredAt = String(installed.accountingStartAt); }]) {
    Object.assign(f.governance, structuredClone(original)); change(f.governance); await saveState(f);
    denied(await admit(request(f)), 'AI_ACCOUNTING_BASELINE_UNVERIFIED');
  }
  Object.assign(f.governance, original); await saveState(f);
  assert.equal((await admit(request(f))).dispatch_allowed, true);
});

test('opening survives settlement and uncertainty without refunding historical balances or enabling replay', async () => {
  const f = await openingFixture({ count: 3, mutate(g) { g.tenantLimits.maxRequests = 4; } });
  await enableOpening(f, await installOpening(f, await openingEvidence(f)));
  const r = request(f), held = await admit(r);
  await finish(r, held.reservation_id);
  const next = request(f, 1), uncertain = await admit(next);
  await finish(next, uncertain.reservation_id, 'uncertain', { jobId: next.jobId, errorCode: 'SYNTHETIC_TIMEOUT' });
  denied(await admit(next), 'AI_LOGICAL_CALL_EXISTS');
  denied(await admit(request(f, 2)));
  await assertExposure(f, { settled_requests: 3, settled_cost_micros: 30_000, held_requests: 1, held_cost_micros: 10_000 });
  assert.equal((await measured(f)).length, 1, 'Only real mock-provider settlement produced a measured row');
});

test('late legacy rows in either current or past month invalidate the opening without erasing holds', async () => {
  for (const occurredAt of [new Date(), monthStart(-2)]) {
    const f = await openingFixture(); await enableOpening(f, await installOpening(f, await openingEvidence(f)));
    assert.equal((await admit(request(f))).dispatch_allowed, true);
    const before = await windows(f);
    await legacyRow(f, { occurredAt });
    denied(await admit(request(f, 1)), 'AI_ACCOUNTING_BASELINE_UNVERIFIED');
    assert.deepEqual(await windows(f), before);
  }
});

test('legacy fingerprint is stable across timezone changes and detects changed old rows', async () => {
  const f = await openingFixture(); await legacyRow(f, { occurredAt: monthStart(-1) });
  const original = await legacyFingerprint(f);
  await using('service_role', async c => {
    await c.query("SET TIME ZONE 'Pacific/Auckland'");
    assert.equal((await c.query('SELECT public.runvara_legacy_usage_fingerprint($1) AS value', [f.workspaceId])).rows[0].value, original);
  });
  await admin.query('UPDATE public.runvara_ai_usage SET estimated_cost_usd=1 WHERE workspace_id=$1', [f.workspaceId]);
  assert.notEqual(await legacyFingerprint(f), original);
});

test('corrupted opening counters fail closed instead of silently resetting the historical floor', async () => {
  const f = await openingFixture(); await enableOpening(f, await installOpening(f, await openingEvidence(f)));
  await admin.query(`UPDATE ${W} SET settled_cost_micros=0 WHERE workspace_id=$1`, [f.workspaceId]);
  denied(await admit(request(f)), 'AI_ACCOUNTING_BASELINE_UNVERIFIED');
  assert.equal((await reservations(f)).length, 0);
});

test('late legacy write during a counter-lock wait denies the same admission', async () => {
  const f = await openingFixture(); await enableOpening(f, await installOpening(f, await openingEvidence(f)));
  await using('postgres', async blocker => {
    await blocker.query('BEGIN');
    try {
      await blocker.query(`SELECT * FROM ${W} WHERE workspace_id=$1 FOR UPDATE`, [f.workspaceId]);
      await using('service_role', async candidate => {
        const candidatePid = (await candidate.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const pending = reserve(candidate, request(f));
        await waitUntilBlocked(admin, candidatePid, blockerPid);
        await legacyRow(f, { occurredAt: monthStart(-1) });
        await blocker.query('COMMIT');
        denied(await pending, 'AI_ACCOUNTING_BASELINE_UNVERIFIED');
      });
    } finally { await blocker.query('ROLLBACK'); }
  });
  assert.equal((await reservations(f)).length, 0);
});

test('failed second counter insert rolls back opening evidence and every counter', async () => {
  const f = await openingFixture(), evidence = await openingEvidence(f);
  await admin.query(`CREATE FUNCTION public.synthetic_opening_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.scope_key = 'provider:openai' THEN RAISE EXCEPTION 'synthetic insertion failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER synthetic_opening_failure BEFORE INSERT ON ${W} FOR EACH ROW EXECUTE FUNCTION public.synthetic_opening_failure()`);
  try { await assert.rejects(installOpening(f, evidence), /synthetic insertion failure/); await noOpeningEffects(f); }
  finally { await admin.query(`DROP TRIGGER synthetic_opening_failure ON ${W}; DROP FUNCTION public.synthetic_opening_failure()`); }
});

for (const scenario of ['complete', 'unverified-opening', 'lost-reservation-ack', 'unknown-provider-outcome',
  'future-complete','future-lost-reservation-ack','future-unknown-provider-outcome','future-disabled',
  'future-account-mismatch','future-late-ack','future-policy-change']) {
  test(`real operator brief + SupabaseStore + PostgreSQL opening, mocked transport: ${scenario}`, async () => {
    const f = await openingFixture();
    f.governance.providers.openai.allowedModels = ['gpt-5.6-luna'];
    f.governance.providers.openai.pricing[0].modelId = 'gpt-5.6-luna';
    const adapter = f.governance.providers.openai.adapters['openai-responses'];
    adapter.atomicUsageCutoverAt = Date.now() - 1000;
    adapter.models = { 'gpt-5.6-luna': { verified: true, allBillableInputTokensCovered: true,
      outputLimitCoversAllBillableOutput: true, requestShape: OPERATOR_BRIEF_SHAPE, endpoint: OPERATOR_BRIEF_ENDPOINT,
      maxBillableInputTokens: 4, maxBillableOutputTokens: 64, checkedAt: Date.now() - 1000,
      expiresAt: Date.now() + 300000, cacheWriteMode: 'reported' } };
    await saveState(f);
    let posts = 0, reserveCalls = 0, clockOffset=0;
    const isFuture=scenario.startsWith('future-');
    const store = createStore({ SUPABASE_URL: 'https://synthetic-opening.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-test-key-only' }, {
      fetchImpl: async (url, options) => {
        const parsed = new URL(url), path = parsed.pathname;
        const p = options.body ? JSON.parse(options.body) : null;
        if (path === '/rest/v1/rpc/runvara_reserve_provider_usage') {
          reserveCalls++;
          const result = await using('service_role', c => (p.p_future_grant_id ? reserveFuture : reserve)(c, { workspaceId: p.p_workspace_id, jobId: p.p_job_id,
            workerId: p.p_worker_id, attempt: p.p_job_attempt, callKey: p.p_call_key, fingerprint: p.p_request_fingerprint,
            provider: p.p_provider, adapter: p.p_adapter_id, model: p.p_model, input: p.p_input_token_bound,
            output: p.p_output_token_bound, pricing: p.p_pricing_version, validUntil: p.p_route_valid_until,
            futureGrantId:p.p_future_grant_id,credentialDigest:p.p_credential_digest }));
          if (scenario.endsWith('lost-reservation-ack') && result.dispatch_allowed) throw new Error('Synthetic lost acknowledgement AFTER commit');
          if (scenario==='future-late-ack')clockOffset=310000;
          if (scenario==='future-policy-change'){f.governance.futureAllowance.projectId='proj_changed';await saveState(f);}
          return Response.json(result);
        }
        if (path === '/rest/v1/rpc/runvara_settle_provider_usage') {
          const result = await using('service_role', c => settle(c, { workspaceId: p.p_workspace_id, fingerprint: p.p_request_fingerprint },
            p.p_reservation_id, p.p_outcome, p.p_receipt));
          return Response.json(result);
        }
        assert.equal(parsed.searchParams.get('workspace_id'), `eq.${f.workspaceId}`);
        if (path === '/rest/v1/saas_workspace_state') {
          const row = (await admin.query(`SELECT workspace_id,state->'aiEconomics'->'governance' AS governance,
            state->'aiEconomics'->'monthlyCostLimitUsd' AS monthly_cost_limit_usd FROM public.saas_workspace_state WHERE workspace_id=$1`, [f.workspaceId])).rows;
          return Response.json(row);
        }
        if (path === '/rest/v1/runvara_agent_jobs') {
          assert.equal(parsed.searchParams.get('id'), `eq.${f.jobs[0]}`);
          return Response.json((await admin.query('SELECT * FROM public.runvara_agent_jobs WHERE workspace_id=$1 AND id=$2', [f.workspaceId, f.jobs[0]])).rows);
        }
        assert.fail(`Unexpected synthetic transport path: ${path}`);
      }
    });
    const provider = createAiProvider({ store, now:()=>Date.now()+clockOffset, env: { RUNVARA_OPENAI_ENABLED: 'true',
      RUNVARA_AI_FUTURE_ALLOWANCE_ENABLED:scenario==='future-disabled'?'false':'true',
      OPENAI_API_KEY:scenario==='future-account-mismatch'?'synthetic-wrong-provider-key':'synthetic-provider-key-only', RUNVARA_AI_MAX_OUTPUT_TOKENS: '64' },
      fetchImpl: async (url,init) => {
        assert.equal(url, OPERATOR_BRIEF_ENDPOINT);
        const rows = await reservations(f);
        assert.equal(rows.length, 1); assert.equal(rows[0].status, 'held', 'Committed hold must precede even mocked provider transport');
        posts++;
        if (isFuture){assert.equal(init.headers['OpenAI-Organization'],'org_synthetic');assert.equal(init.headers['OpenAI-Project'],'proj_synthetic');}
        if (scenario.endsWith('unknown-provider-outcome')) throw new Error('Synthetic lost provider response');
        const result = Response.json({ id: 'synthetic-response', object: 'response', model: 'gpt-5.6-luna', status: 'completed', output_text: 'Synthetic brief',
          usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } });
        Object.defineProperty(result, 'url', { value: OPERATOR_BRIEF_ENDPOINT });
        return result;
      }
    });
    const args = { workspaceId: f.workspaceId, jobId: f.jobs[0], state: f.state, command: 'Synthetic local report',
      route: { provider: 'openai', model: 'gpt-5.6-luna', tier: 'economy' }, run: { summary: 'Deterministic Commander remains available', priorities: [], urgentRisks: [] } };
    const originalJob = (await admin.query('SELECT * FROM public.runvara_agent_jobs WHERE id=$1', [f.jobs[0]])).rows[0];
    args.jobContext = { workspaceId: f.workspaceId, jobId: originalJob.id, type: originalJob.type, status: originalJob.status,
      workerId: originalJob.worker_id, attempt: originalJob.attempts, createdAt: originalJob.created_at.toISOString(), leaseUntil: originalJob.lease_until.toISOString() };
    assert.equal((await provider.enhanceCommander(args)).reason, 'AI_GOVERNANCE_NOT_CONFIGURED');
    assert.equal(posts, 0); assert.equal(reserveCalls, 0, 'Default disabled path does not acquire a reservation');
    if(isFuture)await enableFuture({admin,saveState},f,await installFuture({admin},f,await futureEvidence({admin},f)));
    else await enableOpening(f, scenario === 'unverified-opening' ? { accountingStartAt: Date.now() } : await installOpening(f, await openingEvidence(f)));
    await admin.query("UPDATE public.runvara_agent_jobs SET ai_provider='openai',ai_model='gpt-5.6-luna' WHERE workspace_id=$1", [f.workspaceId]);
    const job = (await admin.query('SELECT * FROM public.runvara_agent_jobs WHERE id=$1', [f.jobs[0]])).rows[0];
    args.jobContext = { workspaceId: f.workspaceId, jobId: job.id, type: job.type, status: job.status,
      workerId: job.worker_id, attempt: job.attempts, createdAt: job.created_at.toISOString(), leaseUntil: job.lease_until.toISOString() };
    const result = await provider.enhanceCommander(args);
    if (isFuture){
      assert.equal(result.effects.accountingScope,'additional_after_cutover');
      assert.deepEqual(result.effects.historicalExposure,{status:'unknown',costMicros:null,reconciled:false});
      if(['future-disabled','future-account-mismatch','future-late-ack','future-policy-change'].includes(scenario)){
        assert.equal(result.used,false);assert.equal(posts,0);
        assert.equal(reserveCalls,['future-late-ack','future-policy-change'].includes(scenario)?1:0);
        assert.equal((await reservations(f)).length,reserveCalls);return;
      }
    }
    if (scenario === 'unverified-opening') {
      assert.equal(result.reason, 'AI_ACCOUNTING_BASELINE_UNVERIFIED'); assert.equal(posts, 0);
      assert.equal((await reservations(f)).length, 0); assert.equal(reserveCalls, 1);
      assert.equal(args.run.summary, 'Deterministic Commander remains available'); return;
    }
    const completed=scenario.endsWith('complete'),lostAck=scenario.endsWith('lost-reservation-ack');
    assert.equal(result.used, completed, result.reason);
    assert.equal(posts, lostAck ? 0 : 1);
    assert.equal(reserveCalls, 1);
    assert.equal((await reservations(f))[0].status, completed ? 'settled' : lostAck ? 'held' : 'uncertain');
    assert.equal((await measured(f)).length, completed ? 1 : 0);
    assert.equal((await provider.enhanceCommander(args)).used, false, 'Same job cannot acquire a second dispatch');
    assert.equal(posts, lostAck ? 0 : 1);
    assert.equal(args.run.summary, 'Deterministic Commander remains available');
    if (!completed) { assert.equal(result.effects.costStatus, 'unknown'); await assertExposure(f, { settled_cost_micros: isFuture?0:20_000, held_cost_micros: 10_000 }); }
  });
}

test('later months use fresh counters but cannot discard an installed opening or changed legacy history', async () => {
  const f = await openingFixture({ count: 3 });
  const installed = await installOpening(f, await openingEvidence(f));
  // Disposable administrator fixture models an opening installed last month.
  // Never backdate an attestation or edit production history this way.
  const previousStart = monthStart(-1).getTime() + 86400000;
  await admin.query(`UPDATE ${W} SET window_start=$2::date WHERE workspace_id=$1`, [f.workspaceId, monthKey(-1)]);
  await admin.query(`UPDATE ${O} SET window_start=$2::date,accounting_start_at=$3::bigint,
    recorded_at=to_timestamp($3::bigint::numeric/1000) WHERE workspace_id=$1`, [f.workspaceId, monthKey(-1), previousStart]);
  await enableOpening(f, { ...installed, accountingStartAt: previousStart });
  assert.equal((await admit(request(f))).dispatch_allowed, true);
  await assertExposure(f, { settled_requests: 0, held_requests: 1, held_cost_micros: 10_000 });
  await assertExposure(f, { settled_requests: 2, settled_cost_micros: 20_000, held_requests: 0 }, monthKey(-1));
  f.governance.accountingStartAt = monthStart().getTime(); await saveState(f);
  denied(await admit(request(f, 1)), 'AI_ACCOUNTING_BASELINE_UNVERIFIED');
  f.governance.accountingStartAt = previousStart; await saveState(f);
  await legacyRow(f, { occurredAt: monthStart(-1) });
  denied(await admit(request(f, 2)), 'AI_ACCOUNTING_BASELINE_UNVERIFIED');
});

test('opening installation rechecks disabled governance after waiting for the shared workspace lock', async () => {
  const f = await openingFixture(), evidence = await openingEvidence(f);
  await using('postgres', async blocker => {
    await blocker.query('BEGIN');
    try {
      f.governance.enabled = true;
      await blocker.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1', [f.workspaceId, f.state]);
      await using('postgres', async installer => {
        const installerPid = (await installer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const pending = installOpening(f, evidence, installer);
        const rejected = assert.rejects(pending, /AI_OPENING_REQUIRES_DISABLED_GOVERNANCE/);
        await waitUntilBlocked(admin, installerPid, blockerPid);
        await blocker.query('COMMIT');
        await rejected;
      });
    } finally { await blocker.query('ROLLBACK'); }
  });
  await noOpeningEffects(f);
});

test('explicit zero opening does not loosen a zero allowance and an over-budget opening cannot dispatch', async () => {
  for (const balance of [openingBalance({ requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 }), openingBalance()]) {
    const f = await openingFixture({ mutate(g) { g.tenantLimits.maxCostMicros = 0; } });
    await enableOpening(f, await installOpening(f, await openingEvidence(f, { openai: balance })));
    denied(await admit(request(f)));
    assert.equal((await reservations(f)).length, 0);
  }
});

test('future-only allowance integrated with the real reservation and settlement functions', {timeout:60000}, async t=>{
  await runFutureAllowanceCases(t,{admin,using,openingFixture,openingEvidence,installOpening,request,reserve,windows,reservations,
    saveState,legacyRow,measured,finish,receipt,waitUntilBlocked});
});

test('real PostgREST opening admission deadlines, rollback and concurrency', { timeout: 180000 }, async t => {
  await runPostgrestTimeoutCases(t, { admin, connectionString, openingFixture, openingEvidence,
    installOpening, enableOpening, request, windows, reservations, using, noOpeningEffects, saveState, waitUntilBlocked,
    futureFixture: async()=>futureFixture({admin,openingFixture,saveState}),
    futureRequest:f=>futureRequest(request,f) });
});
