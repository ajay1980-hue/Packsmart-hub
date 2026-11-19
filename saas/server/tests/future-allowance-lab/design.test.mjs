// LOCAL DESIGN QUALIFICATION ONLY. Never calls a provider or a remote database.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { operatorBriefPolicy, OPERATOR_BRIEF_ENDPOINT } from '../../lib/operator-brief-policy.mjs';

const require = createRequire(new URL('../atomic-usage/package.json', import.meta.url));
const { Client } = require('pg');
assert.equal(process.env.FUTURE_ALLOWANCE_DISPOSABLE_OPT_IN, '1');
const url = new URL(process.env.FUTURE_ALLOWANCE_DATABASE_URL);
assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
assert.equal(url.pathname, '/runvara_future_allowance_test');
assert.equal(url.search, ''); assert.equal(url.hash, '');
const hash = x => createHash('sha256').update(x).digest('hex');
const unknown = { status: 'unknown', costMicros: null, reconciled: false };
const sessions = new Set();
let admin;
async function connect(role = 'future_allowance_service') {
  assert.ok(['postgres', 'future_allowance_service', 'future_allowance_reader'].includes(role));
  const c = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 3000,
    statement_timeout: 8000, application_name: 'future-allowance-disposable-design' });
  await c.connect(); sessions.add(c);
  if (role !== 'postgres') await c.query(`SET ROLE ${role}`);
  return c;
}
async function close(c) { sessions.delete(c); await c.end(); }
async function using(fn, role) { const c = await connect(role); try { return await fn(c); } finally { await close(c); } }
before(async () => {
  admin = await connect('postgres');
  const info = (await admin.query("SELECT current_database() AS name,current_setting('server_version_num')::int AS version")).rows[0];
  assert.equal(info.name, 'runvara_future_allowance_test');
  assert.ok(info.version >= 170000 && info.version < 180000);
  assert.deepEqual((await admin.query("SELECT tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")).rows, []);
  await admin.query(await readFile(new URL('../atomic-usage-postgres-fixture.sql', import.meta.url), 'utf8'));
  for (const name of ['20260927113000_runvara_agent_operations.sql', '20260927122500_ai_usage_economics.sql',
    '20261006190318_atomic_provider_usage.sql', '20261118185735_verified_provider_usage_opening.sql']) {
    await admin.query(await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8'));
  }
  await admin.query(await readFile(new URL('./design.sql', import.meta.url), 'utf8'));
});
after(async () => { await Promise.all([...sessions].map(close)); });

async function fixture({ enabled = true, count = 3, cap = {}, lifetimeMs = 60_000 } = {}) {
  const id = 'future-test-' + randomUUID(), grant = randomUUID(), binding = hash('synthetic-account-' + id);
  const limits = { requests: 3, input: 12, output: 18, total: 30, cost: 30000, ...cap };
  await admin.query(`INSERT INTO future_allowance_lab.grants
    (workspace_id,grant_id,provider,account_binding_hash,evidence_hash,approved_at,retired_at,expires_at,
    max_requests,max_input,max_output,max_total,max_cost_micros,historical_exposure,historical_evidence_hash)
    VALUES ($1,$2,'openai',$3,$4,clock_timestamp()-interval '1 second',clock_timestamp()-interval '1 second',clock_timestamp()+$5*interval '1 millisecond',
    $6,$7,$8,$9,$10,$11,$12)`, [id,grant,binding,hash('synthetic-approval'),lifetimeMs,limits.requests,
    limits.input,limits.output,limits.total,limits.cost,unknown,hash('synthetic-unresolved-history')]);
  await admin.query(`INSERT INTO future_allowance_lab.control(workspace_id,exercise_enabled,account_binding_hash) VALUES($1,$2,$3)`, [id,enabled,binding]);
  const jobs = Array.from({ length: count }, (_, i) => id + '-job-' + i);
  for (const job of jobs) await admin.query(`INSERT INTO future_allowance_lab.jobs VALUES
    ($1,$2,clock_timestamp(),'synthetic-worker',1,clock_timestamp()+interval '2 minutes','running')`, [id,job]);
  return { id, grant, binding, jobs };
}
function request(f, i = 0, patch = {}) {
  return { workspace: f.id, grant: f.grant, job: f.jobs[i], worker: 'synthetic-worker', attempt: 1,
    call: f.jobs[i]+':operator-brief:v1', fingerprint: hash(f.jobs[i]), binding: f.binding,
    input: 4, output: 6, cost: 10000, ...patch };
}
async function reserve(c, r) {
  const value = (await c.query(`SELECT future_allowance_lab.reserve($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS value`,
    [r.workspace,r.grant,r.job,r.worker,r.attempt,r.call,r.fingerprint,r.binding,r.input,r.output,r.cost])).rows[0].value;
  assert.equal(value.dispatch_allowed, false, 'A design experiment can NEVER grant provider dispatch');
  return value;
}
const admit = (f, i, patch) => using(c => reserve(c,request(f,i,patch)));
async function state(f) {
  return (await admin.query(`SELECT to_jsonb(g) AS grant,to_jsonb(c) AS control,
    (SELECT count(*)::int FROM future_allowance_lab.calls x WHERE x.workspace_id=g.workspace_id) AS calls,
    (SELECT count(*)::int FROM future_allowance_lab.audit a WHERE a.workspace_id=g.workspace_id) AS audit
    FROM future_allowance_lab.grants g JOIN future_allowance_lab.control c USING(workspace_id) WHERE g.workspace_id=$1`, [f.id])).rows[0];
}
function denied(v, reason) { assert.equal(v.simulation_reserved, false); assert.equal(v.reason, reason); }
async function blocked(pid, blocker) {
  const until = performance.now()+2500;
  while (performance.now()<until) {
    if ((await admin.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS yes',[pid,blocker])).rows[0].yes) return;
    await delay(10);
  }
  assert.fail('No actual PostgreSQL lock wait observed');
}

test('default disabled, historical unknown retained, and current production policy still denies', async () => {
  const f = await fixture({enabled:false});
  const before = await state(f);
  denied(await admit(f), 'DISABLED');
  assert.deepEqual(await state(f), before);
  assert.deepEqual(before.grant.historical_exposure, unknown);
  assert.equal(before.grant.accounting_scope, 'additional_after_cutover');
  assert.equal(before.grant.currency, 'USD');
  assert.equal(before.control.paid_dispatch_enabled, false);
  const result = operatorBriefPolicy({state:{workspace:{id:f.id},aiEconomics:{governance:{enabled:false}}},
    workspaceId:f.id,endpoint:OPERATOR_BRIEF_ENDPOINT,model:'synthetic-model',outputTokens:64,now:Date.now()});
  assert.equal(result.allowed,false); assert.equal(result.reason,'AI_GOVERNANCE_NOT_CONFIGURED');
});

test('actual opening installer rejects unresolved history; no opening or counters are created', async () => {
  const id = 'unknown-opening-' + randomUUID();
  await admin.query('INSERT INTO public.workspaces(id,name,slug) VALUES ($1,$1,$1)',[id]);
  await admin.query(`INSERT INTO public.saas_workspace_state(workspace_id,state) VALUES($1,'{"aiEconomics":{"governance":{"enabled":false}}}')`,[id]);
  const fingerprint = (await admin.query('SELECT public.runvara_legacy_usage_fingerprint($1) AS value',[id])).rows[0].value;
  const now = Date.now()-1;
  const evidence = {version:1,workspaceId:id,currency:'USD',windowStart:new Date(now).toISOString().slice(0,7)+'-01',
    evidenceHash:hash('synthetic'),verifiedAt:now,legacyDispatchStoppedAt:now,legacyDispatchersRetired:true,
    historicalExposureReconciled:false,monthUsageComplete:false,legacyUsageFingerprint:fingerprint,
    providers:{openai:{requests:0,inputTokens:0,outputTokens:0,totalTokens:0,costMicros:0}}};
  await assert.rejects(admin.query('SELECT public.runvara_install_provider_usage_opening($1,$2)',[id,evidence]),
    e=>e.code==='22023' && e.message==='AI_OPENING_ATTESTATION_INVALID');
  for (const table of ['runvara_provider_usage_openings','runvara_provider_usage_windows','runvara_provider_usage_reservations']) {
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM public.${table} WHERE workspace_id=$1`,[id])).rows[0].n,0);
  }
});

test('30 concurrent connections consume exactly seven bounded reservations and seven audit events', async () => {
  const f = await fixture({count:30,cap:{requests:7,input:28,output:42,total:70,cost:70000}});
  const clients = await Promise.all(Array.from({length:30},()=>connect()));
  try {
    const pids = await Promise.all(clients.map(c=>c.query('SELECT pg_backend_pid() AS pid')));
    assert.equal(new Set(pids.map(r=>r.rows[0].pid)).size,30);
    const results = await Promise.all(clients.map((c,i)=>reserve(c,request(f,i))));
    assert.equal(results.filter(r=>r.simulation_reserved).length,7);
    results.filter(r=>!r.simulation_reserved).forEach(r=>denied(r,'ALLOWANCE'));
    const s=await state(f); assert.equal(s.calls,7); assert.equal(s.audit,7);
    assert.equal(s.control.used_cost_micros,70000); assert.deepEqual(s.grant.historical_exposure,unknown);
  } finally { await Promise.all(clients.map(close)); }
});

for (const [dimension, ceiling] of Object.entries({requests:1,input:4,output:6,total:10,cost:10000})) {
  test('finite '+dimension+' ceiling independently binds the incremental allowance',async()=>{
    const f=await fixture({cap:{[dimension]:ceiling}});
    assert.equal((await admit(f,0)).simulation_reserved,true);
    denied(await admit(f,1),'ALLOWANCE');
  });
}

test('duplicate delivery, lost acknowledgement and changed fingerprint never reacquire entitlement',async()=>{
  const f=await fixture();
  await using(async c=>{ await reserve(c,request(f)); /* deliberately discard successful acknowledgement */ });
  const saved=await state(f);
  denied(await admit(f),'REPLAY'); denied(await admit(f,0,{fingerprint:hash('changed')}),'CONFLICT');
  assert.deepEqual(await state(f),saved);
  for(const status of ['uncertain','settled']) {
    await admin.query('UPDATE future_allowance_lab.calls SET status=$2 WHERE workspace_id=$1',[f.id,status]);
    denied(await admit(f),'REPLAY'); assert.deepEqual(await state(f),saved);
  }
});

test('cross-tenant jobs, grant, binding, stale worker and arbitrary call keys are rejected',async()=>{
  const a=await fixture(),b=await fixture();
  for(const [patch,reason] of [[{job:b.jobs[0]},'JOB'],[{grant:b.grant},'GRANT'],[{binding:b.binding},'BINDING'],
    [{worker:'old-worker'},'JOB'],[{attempt:2},'JOB'],[{call:'different-key'},'JOB']]) denied(await admit(a,0,patch),reason);
  assert.equal((await state(a)).calls,0); assert.equal((await state(b)).calls,0);
});

test('old jobs and expired leases cannot consume a new grant',async()=>{
  const f=await fixture();
  await admin.query(`UPDATE future_allowance_lab.jobs j SET created_at=g.started_at-interval '1 second'
    FROM future_allowance_lab.grants g WHERE j.workspace_id=g.workspace_id AND j.workspace_id=$1`,[f.id]);
  denied(await admit(f),'JOB');
  await admin.query(`UPDATE future_allowance_lab.jobs SET created_at=clock_timestamp(),lease_until=clock_timestamp()-interval '1 second' WHERE workspace_id=$1`,[f.id]);
  denied(await admit(f),'JOB');
});

test('future-created jobs and infinite leases are invalid evidence',async()=>{
  const f=await fixture();
  await admin.query(`UPDATE future_allowance_lab.jobs SET created_at=clock_timestamp()+interval '1 day' WHERE workspace_id=$1`,[f.id]);
  denied(await admit(f),'JOB');
  await assert.rejects(admin.query(`UPDATE future_allowance_lab.jobs SET lease_until='infinity' WHERE workspace_id=$1`,[f.id]),e=>e.code==='23514');
  assert.equal((await state(f)).calls,0);
});

test('expiry is rechecked after a real lock wait',async()=>{
  const f=await fixture({lifetimeMs:800}),holder=await connect('postgres'),waiter=await connect();
  let pending;
  try {
    await holder.query('BEGIN'); await holder.query('SELECT * FROM future_allowance_lab.control WHERE workspace_id=$1 FOR UPDATE',[f.id]);
    const hp=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const wp=(await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pending=reserve(waiter,request(f));
    await blocked(wp,hp); await delay(850);
    await holder.query('COMMIT'); denied(await pending,'EXPIRED');
    assert.equal((await state(f)).calls,0);
  } finally {await holder.query('ROLLBACK'); if(pending) await pending.catch(()=>{}); await close(holder);await close(waiter);}
});

test('current binding is re-read after lock wait; another tenant progresses',async()=>{
  const f=await fixture(),other=await fixture(),holder=await connect('postgres'),waiter=await connect();
  let pending;
  try {
    await holder.query('BEGIN'); await holder.query('UPDATE future_allowance_lab.control SET account_binding_hash=$2 WHERE workspace_id=$1',[f.id,hash('rotated')]);
    const hp=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const wp=(await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pending=reserve(waiter,request(f)); await blocked(wp,hp);
    assert.equal((await admit(other)).simulation_reserved,true);
    await holder.query('COMMIT'); denied(await pending,'BINDING');
    assert.equal((await state(f)).calls,0);
  } finally {await holder.query('ROLLBACK'); if(pending) await pending.catch(()=>{}); await close(holder);await close(waiter);}
});

test('outer cancellation rolls back budget, call and audit together',async()=>{
  const f=await fixture(),c=await connect();
  const original=await state(f);
  try {
    await c.query('BEGIN'); await c.query("SET LOCAL statement_timeout='100ms'");
    assert.equal((await reserve(c,request(f))).simulation_reserved,true);
    await assert.rejects(c.query('SELECT pg_sleep(1)'),e=>e.code==='57014');
    await c.query('ROLLBACK'); assert.deepEqual(await state(f),original);
  } finally {await c.query('ROLLBACK');await close(c);}
});

test('audit failure rolls back preceding counter and call writes',async()=>{
  const f=await fixture(),original=await state(f);
  await admin.query(`CREATE FUNCTION future_allowance_lab.fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'synthetic audit failure'; END $$;
    CREATE TRIGGER fail_audit BEFORE INSERT ON future_allowance_lab.audit FOR EACH ROW EXECUTE FUNCTION future_allowance_lab.fail_audit()`);
  try {await assert.rejects(admit(f),/synthetic audit failure/); assert.deepEqual(await state(f),original);}
  finally {await admin.query('DROP TRIGGER fail_audit ON future_allowance_lab.audit; DROP FUNCTION future_allowance_lab.fail_audit()');}
});

test('runtime role cannot edit grants, counters, evidence or enable paid dispatch',async()=>{
  const f=await fixture();
  for(const table of ['grants','control','calls','audit']) {
    await assert.rejects(using(c=>c.query(`DELETE FROM future_allowance_lab.${table} WHERE workspace_id=$1`,[f.id])),e=>e.code==='42501');
  }
  await assert.rejects(using(c=>reserve(c,request(f)),'future_allowance_reader'),e=>e.code==='42501');
  await assert.rejects(admin.query('UPDATE future_allowance_lab.control SET paid_dispatch_enabled=true WHERE workspace_id=$1',[f.id]),e=>e.code==='23514');
  await assert.rejects(admin.query(`UPDATE future_allowance_lab.grants SET historical_exposure='{"status":"known","costMicros":0,"reconciled":true}' WHERE workspace_id=$1`,[f.id]),e=>e.code==='23514');
});

test('an allowance spanning a calendar boundary is cumulative, with no replacement/reset path',async()=>{
  const f=await fixture({cap:{requests:1}});
  // Administrator-controlled synthetic timestamps simulate an existing grant from last month.
  await admin.query(`UPDATE future_allowance_lab.grants SET
    approved_at=date_trunc('month',clock_timestamp())-interval '1 day',
    retired_at=date_trunc('month',clock_timestamp())-interval '1 day',
    started_at=date_trunc('month',clock_timestamp())-interval '1 day' WHERE workspace_id=$1`,[f.id]);
  assert.equal((await admit(f)).simulation_reserved,true); denied(await admit(f,1),'ALLOWANCE');
  await assert.rejects(admin.query(`INSERT INTO future_allowance_lab.grants SELECT * FROM future_allowance_lab.grants WHERE workspace_id=$1`,[f.id]),e=>e.code==='23505');
  assert.equal((await state(f)).control.used_requests,1);
});

test('null, negative and unsafe bounds fail closed without leaking binding/evidence',async()=>{
  const f=await fixture();
  for(const patch of [{input:null},{output:-1},{cost:'9007199254740992'},{fingerprint:null},{attempt:null}]) {
    const v=await admit(f,0,patch); denied(v,'INVALID');
    const json=JSON.stringify(v); assert.ok(!json.includes(f.binding));assert.ok(!json.includes(f.id));
  }
  assert.equal((await state(f)).calls,0);
});
