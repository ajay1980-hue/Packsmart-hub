/** Real loopback PostgREST HTTP against the disposable atomic-usage fixture.
 * No production connection, provider, credentials or RPC definition changes.
 * Called by atomic-usage-postgres.mjs after its SQL tests, not a standalone runner.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createStore } from '../lib/store.mjs';
import { providerUsageReservationParams } from '../lib/usage-governance.mjs';

const binaryHash = '39ce04b0597c6b3c3eb4c5f34fe6ab590a2d0172616eeaccf1e4c659b822295a';
const W = 'public.runvara_provider_usage_windows';
const digest = value => createHash('sha256').update(value).digest('hex');
const input = r => ({ jobId: r.jobId, workerId: r.workerId, jobAttempt: r.attempt,
  callKey: r.callKey, requestFingerprint: r.fingerprint, provider: r.provider,
  adapterId: r.adapter, model: r.model, inputTokenBound: r.input,
  outputTokenBound: r.output, pricingVersion: r.pricing, routeValidUntil: r.validUntil,
  ...(r.futureGrantId ? {futureGrantId:r.futureGrantId,credentialDigest:r.credentialDigest} : {}) });
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function runPostgrestTimeoutCases(t, api) {
  const { admin, connectionString, openingFixture, openingEvidence, installOpening, enableOpening,
    request, windows, reservations, using, noOpeningEffects, saveState, waitUntilBlocked } = api;
  const binary = process.env.ATOMIC_USAGE_POSTGREST_BIN;
  assert.ok(binary?.startsWith('/'), 'ATOMIC_USAGE_POSTGREST_BIN must name the verified local PostgREST 14.5 binary; this gate never skips');
  assert.equal(digest(await readFile(binary)), binaryHash);
  assert.equal((await promisify(execFile)(binary, ['--version'])).stdout.trim(), 'PostgREST 14.5');
  assert.equal(process.env.ATOMIC_USAGE_ALLOW_DISPOSABLE_TEST_DB, '1');
  const target = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
  assert.equal(target.pathname, '/runvara_atomic_usage_test');
  assert.equal(target.search, ''); assert.equal(target.hash, '');
  // Do not inherit any environment into the gateway; use a fresh, local-only
  // authenticator and signing secret. Neither is logged or written to a file.
  const authRole = 'atomic_timeout_' + randomUUID().replaceAll('-', '');
  const strictRole = authRole + '_8';
  const password = randomBytes(24).toString('hex'), secret = randomBytes(48).toString('hex');
  const signed = [ { alg: 'HS256', typ: 'JWT' }, { role: 'service_role', exp: Math.floor(Date.now() / 1000) + 600 } ]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  const token = signed + '.' + createHmac('sha256', secret).update(signed).digest('base64url');
  const gateways = [], observations = [];
  let roleCreated = false, delayObjectsCreated = false;
  async function rpc(gateway, name, body, authenticated = true) {
    const started = performance.now();
    const response = await fetch(`${gateway.url}/rpc/${name}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(25000) });
    return { status: response.status, value: await response.json(), ms: Math.round(performance.now() - started) };
  }
  const reserve = (gateway, r) => rpc(gateway, 'runvara_reserve_provider_usage', providerUsageReservationParams(r.workspaceId, input(r)));
  async function gateway(name, hoisted, role = authRole) {
    const port = await freePort();
    const url = new URL(target); url.username = role; url.password = password;
    const child = spawn(binary, ['+RTS', '-N2', '-RTS'], { env: {
      PATH: '/usr/bin:/bin', PGRST_DB_URI: url.toString(), PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon',
      PGRST_JWT_SECRET: secret, PGRST_SERVER_HOST: '127.0.0.1', PGRST_SERVER_PORT: String(port),
      PGRST_DB_CONFIG: 'false', PGRST_DB_CHANNEL_ENABLED: 'false', PGRST_DB_POOL: '4',
      PGRST_DB_POOL_ACQUISITION_TIMEOUT: '3', PGRST_LOG_LEVEL: 'error',
      // An empty value falls back to PostgREST's default; the negative control
      // needs a nonempty list that explicitly excludes statement_timeout.
      PGRST_DB_HOISTED_TX_SETTINGS: hoisted ? 'statement_timeout,plan_filter.statement_cost_limit,default_transaction_isolation' : 'plan_filter.statement_cost_limit,default_transaction_isolation'
    }, stdio: 'ignore' });
    const g = { child, url: `http://127.0.0.1:${port}`, name, exited: false };
    g.finished = new Promise(resolve => child.once('exit', () => { g.exited = true; resolve(); }));
    child.once('error', error => { g.spawnError = error; }); gateways.push(g);
    const until = performance.now() + 10000;
    while (performance.now() < until) {
      assert.ok(!g.exited && !g.spawnError, 'Disposable gateway failed to start');
      try {
        const response = await fetch(g.url + '/', { signal: AbortSignal.timeout(500) });
        await response.arrayBuffer();
        if (response.ok) return g;
      } catch { /* bounded readiness polling only; never retry a mutation */ }
      await delay(50);
    }
    assert.fail('Disposable gateway readiness deadline exceeded');
  }
  async function fixture(options) {
    const f = await openingFixture(options);
    await enableOpening(f, await installOpening(f, await openingEvidence(f)));
    return f;
  }
  const stateRow = async f => (await admin.query('SELECT state,updated_at::text AS revision FROM public.saas_workspace_state WHERE workspace_id=$1', [f.workspaceId])).rows[0];
  const snapshot = async f => ({ windows: await windows(f), reservations: await reservations(f), state: await stateRow(f),
    openings: (await admin.query('SELECT * FROM public.runvara_provider_usage_openings WHERE workspace_id=$1', [f.workspaceId])).rows,
    grants: (await admin.query('SELECT * FROM public.runvara_provider_future_allowances WHERE workspace_id=$1', [f.workspaceId])).rows,
    usage: (await admin.query('SELECT * FROM public.runvara_ai_usage WHERE workspace_id=$1 ORDER BY id', [f.workspaceId])).rows });
  function assertFutureCounters(rows, r = null) {
    assert.deepEqual(rows.map(row => row.scope_key).sort(), ['provider:openai', 'tenant']);
    const expected = { held_requests: r ? 1 : 0, held_input_tokens: r?.input ?? 0,
      held_output_tokens: r?.output ?? 0, held_total_tokens: r ? r.input + r.output : 0,
      held_cost_micros: r ? 10000 : 0, settled_requests: 0, settled_input_tokens: 0,
      settled_output_tokens: 0, settled_total_tokens: 0, settled_cost_micros: 0 };
    for (const row of rows) for (const [key, value] of Object.entries(expected)) {
      assert.equal(BigInt(row[key]), BigInt(value), `${row.scope_key}.${key}`);
    }
  }
  // Disposable qualification only, not a production config writer or an RPC.
  // Native JSONB merges preserve unrelated numeric precision and missing parents.
  async function prepareDisabled(client, f, revision) {
    await client.query('BEGIN');
    try {
      const row = (await client.query(`SELECT updated_at::text AS revision,
        state#>'{aiEconomics,governance,enabled}'='false'::jsonb AS already_disabled
        FROM public.saas_workspace_state WHERE workspace_id=$1 FOR UPDATE`, [f.workspaceId])).rows[0];
      assert.equal(row?.revision, revision, 'SYNTHETIC_STATE_REVISION_CONFLICT');
      if (!row.already_disabled) {
        const result = await client.query(`UPDATE public.saas_workspace_state
          SET state=jsonb_set(state,'{aiEconomics}',
            coalesce(state->'aiEconomics','{}'::jsonb) || jsonb_build_object('governance',
              coalesce(state#>'{aiEconomics,governance}','{}'::jsonb) || '{"enabled":false}'::jsonb)),
            updated_at=clock_timestamp()
          WHERE workspace_id=$1 AND updated_at=$2::timestamptz
            AND jsonb_typeof(state)='object'
            AND (NOT state ? 'aiEconomics' OR jsonb_typeof(state->'aiEconomics')='object')
            AND (NOT coalesce(state->'aiEconomics','{}'::jsonb) ? 'governance' OR jsonb_typeof(state#>'{aiEconomics,governance}')='object')
            AND (NOT coalesce(state#>'{aiEconomics,governance}','{}'::jsonb) ? 'enabled' OR state#>'{aiEconomics,governance,enabled}'='false'::jsonb)`,
        [f.workspaceId, revision]);
        assert.equal(result.rowCount, 1, 'SYNTHETIC_STATE_SHAPE_CONFLICT');
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }
  async function slow(f, seconds = 16) {
    await admin.query('INSERT INTO public.synthetic_atomic_timeout_delay VALUES ($1,$2)', [f.workspaceId, seconds]);
  }
  async function sleeping(role = authRole) {
    const until = performance.now() + 5000;
    while (performance.now() < until) {
      const result = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=$1 AND wait_event='PgSleep'", [role]);
      if (result.rows[0].n > 0) return;
      await delay(20);
    }
    assert.fail('Injected delay was not reached');
  }
  function timed(result, name, code, minimum, maximum = 22000) {
    observations.push({ name, status: result.status, code: result.value.code ?? null, ms: result.ms });
    assert.equal(result.value.code, code);
    assert.ok(result.ms >= minimum && result.ms < maximum, `${name}: ${result.ms} ms`);
  }
  try {
    // Identifiers/password are generated here from restricted hex, never input.
    await admin.query(`CREATE ROLE ${authRole} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'; GRANT anon, service_role TO ${authRole};
      CREATE ROLE ${strictRole} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'; GRANT anon, service_role TO ${strictRole};
      ALTER ROLE ${strictRole} SET statement_timeout='8s'; ALTER ROLE ${strictRole} SET lock_timeout='8s'`);
    roleCreated = true;
    await admin.query(`CREATE TABLE public.synthetic_atomic_timeout_delay(workspace_id text PRIMARY KEY, seconds numeric NOT NULL CHECK(seconds BETWEEN 0 AND 16));
      REVOKE ALL ON public.synthetic_atomic_timeout_delay FROM PUBLIC, anon, authenticated;
      GRANT SELECT ON public.synthetic_atomic_timeout_delay TO service_role;
      CREATE FUNCTION public.synthetic_atomic_timeout_delay() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE seconds numeric;
      BEGIN
        IF NEW.scope_key='provider:openai' THEN
          SELECT d.seconds INTO seconds FROM public.synthetic_atomic_timeout_delay d WHERE d.workspace_id=NEW.workspace_id;
          IF seconds IS NOT NULL THEN PERFORM pg_sleep(seconds); END IF;
        END IF;
        RETURN NEW;
      END; $$;
      REVOKE ALL ON FUNCTION public.synthetic_atomic_timeout_delay() FROM PUBLIC;
      CREATE TRIGGER synthetic_atomic_timeout_delay AFTER INSERT OR UPDATE ON ${W}
        FOR EACH ROW EXECUTE FUNCTION public.synthetic_atomic_timeout_delay()`);
    delayObjectsCreated = true;
    const bounded = await gateway('hoisting-enabled', true), unbounded = await gateway('hoisting-disabled', false);
    const strict = await gateway('connection-8s-no-statement-hoisting', false, strictRole);
    const overridden = await gateway('connection-8s-hoisted-function-15s', true, strictRole);
    await t.test('future grant overload is reachable through real PostgREST and the old signature cannot bypass it', async()=>{
      const f=await api.futureFixture(),r=api.futureRequest(f);
      const old=await reserve(strict,{...r,futureGrantId:undefined,credentialDigest:undefined});
      assert.equal(old.status,200);assert.equal(old.value.reason,'AI_FUTURE_ALLOWANCE_UNVERIFIED');
      const admitted=await reserve(strict,r);
      assert.equal(admitted.status,200);assert.equal(admitted.value.dispatch_allowed,true);
      const again=await reserve(strict,r);assert.equal(again.value.dispatch_allowed,false);assert.equal(again.value.reason,'AI_LOGICAL_CALL_EXISTS');
    });
    const strictSettings = async () => (await admin.query('SELECT rolconfig FROM pg_roles WHERE rolname=$1', [strictRole])).rows[0].rolconfig;
    assert.deepEqual((await strictSettings()).sort(), ['lock_timeout=8s', 'statement_timeout=8s']);
    // This models the supplied connection defaults, not unknown managed overrides.
    assert.deepEqual((await admin.query("SELECT setconfig FROM pg_db_role_setting WHERE setrole='service_role'::regrole")).rows, []);

    await t.test('absent governance denies HTTP admission and administrator installation without effects', async () => {
      const f = await openingFixture(); delete f.state.aiEconomics.governance; await saveState(f);
      const before = await snapshot(f), result = await reserve(strict, request(f));
      assert.equal(result.status, 200); assert.equal(result.value.dispatch_allowed, false);
      assert.equal(result.value.reason, 'AI_GOVERNANCE_NOT_CONFIGURED');
      await assert.rejects(installOpening(f, await openingEvidence(f)), /AI_OPENING_REQUIRES_DISABLED_GOVERNANCE/);
      assert.deepEqual(await snapshot(f), before); await noOpeningEffects(f);
    });

    await t.test('guarded disabled preparation creates missing parents, preserves JSONB and stays disabled after installation', async () => {
      for (const shape of ['economics-absent', 'governance-absent', 'enabled-absent']) {
        const f = await openingFixture(), other = await openingFixture();
        if (shape === 'economics-absent') delete f.state.aiEconomics;
        else if (shape === 'governance-absent') delete f.state.aiEconomics.governance;
        else f.state.aiEconomics.governance = { syntheticNote: 'retain' };
        f.state.syntheticHistory = [{ id: 'synthetic-only', note: 'retain' }];
        await saveState(f);
        // Above JS's exact integer range: compare natively in SQL, never roundtrip it.
        await admin.query(`UPDATE public.saas_workspace_state SET state=state||'{"exactSyntheticNumber":9007199254740993}'::jsonb WHERE workspace_id=$1`, [f.workspaceId]);
        const before = await stateRow(f), otherBefore = await snapshot(other);
        const originalJson = (await admin.query('SELECT state::text AS value FROM public.saas_workspace_state WHERE workspace_id=$1', [f.workspaceId])).rows[0].value;
        await using('postgres', c => prepareDisabled(c, f, before.revision));
        const prepared = await stateRow(f);
        assert.equal(prepared.state.aiEconomics.governance.enabled, false);
        const preservation = (await admin.query(`SELECT
          state-'aiEconomics'=$2::jsonb-'aiEconomics' AS root_preserved,
          (state->'aiEconomics')-'governance'=coalesce($2::jsonb->'aiEconomics','{}'::jsonb)-'governance' AS economics_preserved,
          (state#>'{aiEconomics,governance}')-'enabled'=coalesce($2::jsonb#>'{aiEconomics,governance}','{}'::jsonb)-'enabled' AS governance_preserved,
          state->>'exactSyntheticNumber' AS exact_number
          FROM public.saas_workspace_state WHERE workspace_id=$1`, [f.workspaceId, originalJson])).rows[0];
        assert.deepEqual(preservation, { root_preserved: true, economics_preserved: true,
          governance_preserved: true, exact_number: '9007199254740993' });
        await using('postgres', c => prepareDisabled(c, f, prepared.revision));
        assert.deepEqual(await stateRow(f), prepared, 'Repeated disabled preparation is a read-only no-op');
        assert.deepEqual(await snapshot(other), otherBefore);
        await installOpening(f, await openingEvidence(f));
        assert.deepEqual(await stateRow(f), prepared, 'Installer cannot enable or rewrite policy');
        const denied = await reserve(strict, request(f));
        assert.equal(denied.value.dispatch_allowed, false); assert.equal(denied.value.reason, 'AI_GOVERNANCE_NOT_CONFIGURED');
        assert.equal((await reservations(f)).length, 0);
      }
    });

    await t.test('disabled preparation refuses malformed parents, active governance and stale revisions', async () => {
      for (const economics of [null, [], { governance: null }, { governance: [] }, { governance: { enabled: true } }, { governance: { enabled: 'false' } }]) {
        const f = await openingFixture(); f.state.aiEconomics = economics; await saveState(f);
        const before = await snapshot(f);
        await assert.rejects(using('postgres', c => prepareDisabled(c, f, before.state.revision)), /SYNTHETIC_STATE_SHAPE_CONFLICT/);
        assert.deepEqual(await snapshot(f), before); await noOpeningEffects(f);
      }
      const f = await openingFixture(); delete f.state.aiEconomics.governance; await saveState(f);
      const original = await stateRow(f);
      await using('postgres', async writer => using('postgres', async preparer => {
        const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const preparerPid = (await preparer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await writer.query('BEGIN');
        try {
          await writer.query(`UPDATE public.saas_workspace_state SET state=state||'{"concurrentSyntheticChange":"preserve"}'::jsonb,
            updated_at=clock_timestamp() WHERE workspace_id=$1`, [f.workspaceId]);
          const pending = prepareDisabled(preparer, f, original.revision);
          const rejected = assert.rejects(pending, /SYNTHETIC_STATE_REVISION_CONFLICT/);
          await waitUntilBlocked(admin, preparerPid, writerPid);
          await writer.query('COMMIT'); await rejected;
        } finally { await writer.query('ROLLBACK'); }
      }));
      const after = await stateRow(f);
      assert.equal(after.state.concurrentSyntheticChange, 'preserve');
      assert.equal(Object.hasOwn(after.state.aiEconomics, 'governance'), false);
      await noOpeningEffects(f);
    });

    await t.test('HTTP requires service authority; disabled governance and installer privileges stay closed', async () => {
      const f = await openingFixture(), r = request(f);
      const unsigned = await rpc(strict, 'runvara_reserve_provider_usage', providerUsageReservationParams(f.workspaceId, input(r)), false);
      assert.ok([401, 403].includes(unsigned.status));
      const disabled = await reserve(strict, r);
      assert.equal(disabled.status, 200); assert.equal(disabled.value.dispatch_allowed, false);
      assert.equal(disabled.value.reason, 'AI_GOVERNANCE_NOT_CONFIGURED');
      const installer = await rpc(strict, 'runvara_install_provider_usage_opening', { p_workspace_id: f.workspaceId, p_attestation: await openingEvidence(f) });
      assert.ok([401, 403].includes(installer.status));
      await noOpeningEffects(f);
    });

    await t.test('real HTTP concurrent logical calls preserve opening floors and a one-call allowance', async () => {
      const f = await fixture({ count: 4, mutate(g) { g.tenantLimits.maxRequests = 3; } }); // opening already includes two
      const results = await Promise.all([0, 0, 1, 2].map(i => reserve(strict, request(f, i))));
      assert.ok(results.every(x => x.status === 200));
      assert.equal(results.filter(x => x.value.dispatch_allowed).length, 1);
      assert.equal((await reservations(f)).length, 1);
      for (const row of await windows(f)) { assert.equal(+row.held_requests, 1); assert.equal(+row.settled_requests, 2); }
    });

    await t.test('negative control: function-local 15s alone permits a 16s HTTP admission', async () => {
      const f = await fixture(); await slow(f);
      const result = await reserve(unbounded, request(f));
      observations.push({ name: 'hoisting disabled, same function', ms: result.ms, status: result.status, code: result.value.code ?? null });
      assert.equal(result.status, 200); assert.equal(result.value.dispatch_allowed, true);
      assert.ok(result.ms >= 15500 && result.ms < 22000);
      assert.equal((await reservations(f)).length, 1);
    });

    await t.test('hoisted 15s timeout rolls back reservation AND updated counters, preserving opening and other tenants', async () => {
      const f = await fixture(), other = await fixture(), before = await snapshot(f), otherBefore = await snapshot(other);
      await slow(f);
      const result = await reserve(bounded, request(f));
      assert.equal(result.status, 500); timed(result, 'hoisted admission deadline', '57014', 14500);
      assert.deepEqual(await snapshot(f), before); assert.deepEqual(await snapshot(other), otherBefore);
    });

    await t.test('8s connection deadline rolls back exact admission state without hoisting or weakening limits', async () => {
      const f = await fixture(), other = await fixture(), before = await snapshot(f), otherBefore = await snapshot(other);
      await slow(f);
      const result = await reserve(strict, request(f));
      assert.equal(result.status, 500); timed(result, 'connection 8s admission deadline', '57014', 7500, 11000);
      assert.deepEqual(await snapshot(f), before); assert.deepEqual(await snapshot(other), otherBefore);
      assert.deepEqual((await strictSettings()).sort(), ['lock_timeout=8s', 'statement_timeout=8s']);
    });

    await t.test('explicit hoisting overrides the same 8s connection default with 15s, only in this disposable comparison', async () => {
      const f = await fixture(), before = await snapshot(f); await slow(f);
      const result = await reserve(overridden, request(f));
      assert.equal(result.status, 500); timed(result, '8s role overridden by 15s hoisting', '57014', 14500);
      assert.deepEqual(await snapshot(f), before);
      assert.deepEqual((await strictSettings()).sort(), ['lock_timeout=8s', 'statement_timeout=8s']);
    });

    await t.test('future allowance under the 15s profile rolls back late writes, bounds a concurrent waiter and isolates another tenant', async () => {
      const f = await api.futureFixture({ count: 3 }), other = await api.futureFixture();
      assert.equal((await reserve(overridden, api.futureRequest(f))).value.dispatch_allowed, true);
      const before = await snapshot(f), otherBefore = await snapshot(other);
      await slow(f);
      const pending = reserve(overridden, api.futureRequest(f, 1));
      try {
        await sleeping(strictRole);
        const [waiter, independent] = await Promise.all([
          reserve(overridden, api.futureRequest(f, 2)), reserve(overridden, api.futureRequest(other))
        ]);
        assert.equal(waiter.status, 500); timed(waiter, 'future allowance 5s waiter', '55P03', 4500, 7500);
        assert.equal(independent.status, 200); assert.equal(independent.value.dispatch_allowed, true);
        assert.ok(independent.ms < 5000);
      } finally {
        const holder = await pending;
        assert.equal(holder.status, 500); timed(holder, 'future allowance 15s holder rollback', '57014', 14500);
      }
      assert.deepEqual(await snapshot(f), before, 'Prior consumption, grant, history and unrelated state survive rollback');
      const otherAfter = await snapshot(other);
      assert.deepEqual(otherAfter.grants, otherBefore.grants);
      assert.deepEqual(otherAfter.state, otherBefore.state);
      assert.deepEqual(otherAfter.usage, otherBefore.usage);
      assert.equal(otherAfter.reservations.length, 1);
      assertFutureCounters(otherAfter.windows, api.futureRequest(other));
    });

    await t.test('future grant expiry during a wait beyond 8s still denies admission under the 15s profile', async () => {
      const f = await api.futureFixture({}, { expiresAt: Date.now() + 7000 });
      const before = await snapshot(f);
      await slow(f, 9);
      const result = await reserve(overridden, api.futureRequest(f, 0, {
        validUntil: new Date(f.installed.futureAllowance.expiresAt).toISOString()
      }));
      observations.push({ name: 'future expiry during 9s wait', status: result.status, reason: result.value.reason, ms: result.ms });
      assert.equal(result.status, 200); assert.equal(result.value.dispatch_allowed, false);
      assert.equal(result.value.reason, 'AI_ADMISSION_EVIDENCE_EXPIRED');
      assert.ok(result.ms >= 8500);
      const after = await snapshot(f);
      assert.deepEqual(after.reservations, before.reservations); assert.deepEqual(after.grants, before.grants);
      assert.deepEqual(after.state, before.state); assert.deepEqual(after.usage, before.usage);
      assertFutureCounters(after.windows);
    });

    await t.test('future allowance lost acknowledgement under the 15s profile keeps its single consumed hold', async () => {
      const f = await api.futureFixture({}, { limits: { maxRequests: 1, maxInputTokens: 100,
        maxOutputTokens: 100, maxTotalTokens: 200, maxCostMicros: 10000 } });
      const before = await snapshot(f), r = api.futureRequest(f); let sends = 0;
      const store = createStore({ SUPABASE_URL: overridden.url, SUPABASE_SERVICE_ROLE_KEY: token }, {
        fetchImpl: async (url, options) => {
          const parsed = new URL(url); assert.equal(parsed.origin, overridden.url);
          assert.equal(parsed.pathname, '/rest/v1/rpc/runvara_reserve_provider_usage'); sends++;
          const response = await fetch(overridden.url + parsed.pathname.slice('/rest/v1'.length), options);
          assert.equal(response.status, 200); assert.equal((await response.json()).dispatch_allowed, true);
          throw new Error('Synthetic future allowance lost acknowledgement after real commit');
        }
      });
      await assert.rejects(store.reserveProviderUsage(f.workspaceId, input(r)), /AI_USAGE_RESERVATION_UNCERTAIN/);
      assert.equal(sends, 1);
      // Deliberate fixture requests verify refusal, never an application retry.
      const duplicate = await reserve(overridden, r);
      assert.equal(duplicate.value.dispatch_allowed, false); assert.equal(duplicate.value.reason, 'AI_LOGICAL_CALL_EXISTS');
      const next = await reserve(overridden, api.futureRequest(f, 1));
      assert.equal(next.value.dispatch_allowed, false); assert.equal(next.value.reason, 'AI_FUTURE_ALLOWANCE_EXHAUSTED');
      const after = await snapshot(f);
      assert.equal(after.reservations.length, 1); assert.equal(after.reservations[0].status, 'held');
      assertFutureCounters(after.windows, r);
      assert.deepEqual(after.grants, before.grants); assert.deepEqual(after.state, before.state);
      assert.deepEqual(after.usage, before.usage);
    });

    await t.test('concurrent workspace waiter hits 5s lock limit; other tenant progresses; late holder rolls back', async () => {
      const f = await fixture(), other = await fixture(), before = await snapshot(f); await slow(f);
      const first = reserve(strict, request(f));
      try {
        await sleeping(strictRole);
        const [waiter, independent] = await Promise.all([reserve(strict, request(f, 1)), reserve(strict, request(other))]);
        assert.equal(waiter.status, 500); timed(waiter, 'workspace lock deadline', '55P03', 4500, 7500);
        assert.equal(independent.status, 200); assert.equal(independent.value.dispatch_allowed, true);
        assert.ok(independent.ms < 5000, 'Unrelated tenant must not wait on the blocked workspace');
      } finally {
        const result = await first; timed(result, 'concurrent 8s holder deadline', '57014', 7500, 11000);
      }
      assert.deepEqual(await snapshot(f), before);
      assert.equal((await reservations(other)).length, 1);
    });

    await t.test('lost HTTP acknowledgment remains uncertain; store sends once and duplicate cannot regain dispatch', async () => {
      const f = await fixture(), r = request(f); let sends = 0;
      const store = createStore({ SUPABASE_URL: strict.url, SUPABASE_SERVICE_ROLE_KEY: token }, {
        fetchImpl: async (url, options) => {
          const parsed = new URL(url); assert.equal(parsed.origin, strict.url);
          assert.equal(parsed.pathname, '/rest/v1/rpc/runvara_reserve_provider_usage'); sends++;
          // Only remove Supabase's URL prefix; actual HTTP/SQL remain unchanged.
          const response = await fetch(strict.url + parsed.pathname.slice('/rest/v1'.length), options);
          assert.equal(response.status, 200); assert.equal((await response.json()).dispatch_allowed, true);
          throw new Error('Synthetic lost acknowledgment AFTER real commit');
        }
      });
      await assert.rejects(store.reserveProviderUsage(f.workspaceId, input(r)), /AI_USAGE_RESERVATION_UNCERTAIN/);
      assert.equal(sends, 1); assert.equal((await reservations(f)).length, 1);
      // Deliberate synthetic duplicate tests the SQL contract, not an application retry.
      const duplicate = await reserve(strict, r);
      assert.equal(duplicate.value.dispatch_allowed, false); assert.equal(duplicate.value.reason, 'AI_LOGICAL_CALL_EXISTS');
      for (const row of await windows(f)) { assert.equal(+row.held_requests, 1); assert.equal(+row.settled_requests, 2); }
    });

    await t.test('administrator outer 8s transaction timeout rolls back opening and seeded counters', async () => {
      const f = await openingFixture(), evidence = await openingEvidence(f); await slow(f);
      await using('postgres', async client => {
        await client.query('BEGIN');
        try {
          // Separate protocol commands arm the timeout BEFORE installer execution.
          await client.query("SET LOCAL statement_timeout='8s'");
          const started = performance.now();
          await assert.rejects(installOpening(f, evidence, client), error => error.code === '57014');
          const ms = Math.round(performance.now() - started);
          observations.push({ name: 'explicit outer 8s installer deadline', ms, code: '57014' });
          assert.ok(ms >= 7500 && ms < 11000);
          await assert.rejects(client.query('SELECT 1'), error => error.code === '25P02');
        } finally { await client.query('ROLLBACK'); }
      });
      await noOpeningEffects(f);
      assert.equal((await admin.query("SELECT state#>'{aiEconomics,governance,enabled}' AS enabled FROM public.saas_workspace_state WHERE workspace_id=$1", [f.workspaceId])).rows[0].enabled, false);
    });
  } finally {
    // Close only these loopback gateways before removing their synthetic hooks.
    await Promise.all(gateways.map(async g => {
      if (g.exited || g.spawnError) return;
      g.child.kill('SIGTERM');
      await Promise.race([g.finished, delay(3000)]);
      if (!g.exited) { g.child.kill('SIGKILL'); await g.finished; }
    }));
    if (delayObjectsCreated) await admin.query(`DROP TRIGGER synthetic_atomic_timeout_delay ON ${W}; DROP FUNCTION public.synthetic_atomic_timeout_delay(); DROP TABLE public.synthetic_atomic_timeout_delay`);
    if (roleCreated) await admin.query(`DROP ROLE ${authRole}; DROP ROLE ${strictRole}`);
    console.log('ATOMIC_TIMEOUT_HTTP_PROOF=' + JSON.stringify({ postgres: '17.x disposable', postgrest: '14.5', providerCalls: 0, observations, gatewaysStopped: gateways.every(g => g.exited || g.spawnError) }));
  }
}
