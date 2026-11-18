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
const R = 'public.runvara_provider_usage_reservations';
const W = 'public.runvara_provider_usage_windows';
const digest = value => createHash('sha256').update(value).digest('hex');
const input = r => ({ jobId: r.jobId, workerId: r.workerId, jobAttempt: r.attempt,
  callKey: r.callKey, requestFingerprint: r.fingerprint, provider: r.provider,
  adapterId: r.adapter, model: r.model, inputTokenBound: r.input,
  outputTokenBound: r.output, pricingVersion: r.pricing, routeValidUntil: r.validUntil });
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function runPostgrestTimeoutCases(t, api) {
  const { admin, connectionString, openingFixture, openingEvidence, installOpening, enableOpening,
    request, windows, reservations, using, noOpeningEffects } = api;
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
  async function gateway(name, hoisted) {
    const port = await freePort();
    const url = new URL(target); url.username = authRole; url.password = password;
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
  const snapshot = async f => ({ windows: await windows(f), reservations: await reservations(f) });
  async function slow(f, seconds = 16) {
    await admin.query('INSERT INTO public.synthetic_atomic_timeout_delay VALUES ($1,$2)', [f.workspaceId, seconds]);
  }
  async function sleeping() {
    const until = performance.now() + 5000;
    while (performance.now() < until) {
      const result = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=$1 AND wait_event='PgSleep'", [authRole]);
      if (result.rows[0].n > 0) return;
      await delay(20);
    }
    assert.fail('Injected delay was not reached');
  }
  function timed(result, name, code, minimum) {
    observations.push({ name, status: result.status, code: result.value.code ?? null, ms: result.ms });
    assert.equal(result.value.code, code);
    assert.ok(result.ms >= minimum && result.ms < 22000, `${name}: ${result.ms} ms`);
  }
  try {
    // Identifiers/password are generated here from restricted hex, never input.
    await admin.query(`CREATE ROLE ${authRole} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'; GRANT anon, service_role TO ${authRole}`);
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

    await t.test('HTTP requires service authority; disabled governance and installer privileges stay closed', async () => {
      const f = await openingFixture(), r = request(f);
      const unsigned = await rpc(bounded, 'runvara_reserve_provider_usage', providerUsageReservationParams(f.workspaceId, input(r)), false);
      assert.ok([401, 403].includes(unsigned.status));
      const disabled = await reserve(bounded, r);
      assert.equal(disabled.status, 200); assert.equal(disabled.value.dispatch_allowed, false);
      assert.equal(disabled.value.reason, 'AI_GOVERNANCE_NOT_CONFIGURED');
      const installer = await rpc(bounded, 'runvara_install_provider_usage_opening', { p_workspace_id: f.workspaceId, p_attestation: await openingEvidence(f) });
      assert.ok([401, 403].includes(installer.status));
      await noOpeningEffects(f);
    });

    await t.test('real HTTP concurrent logical calls preserve opening floors and a one-call allowance', async () => {
      const f = await fixture({ count: 4, mutate(g) { g.tenantLimits.maxRequests = 3; } }); // opening already includes two
      const results = await Promise.all([0, 0, 1, 2].map(i => reserve(bounded, request(f, i))));
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

    await t.test('concurrent workspace waiter hits 5s lock limit; other tenant progresses; late holder rolls back', async () => {
      const f = await fixture(), other = await fixture(), before = await snapshot(f); await slow(f);
      const first = reserve(bounded, request(f));
      try {
        await sleeping();
        const [waiter, independent] = await Promise.all([reserve(bounded, request(f, 1)), reserve(bounded, request(other))]);
        assert.equal(waiter.status, 500); timed(waiter, 'workspace lock deadline', '55P03', 4500);
        assert.equal(independent.status, 200); assert.equal(independent.value.dispatch_allowed, true);
        assert.ok(independent.ms < 5000, 'Unrelated tenant must not wait on the blocked workspace');
      } finally {
        const result = await first; timed(result, 'concurrent holder deadline', '57014', 14500);
      }
      assert.deepEqual(await snapshot(f), before);
      assert.equal((await reservations(other)).length, 1);
    });

    await t.test('lost HTTP acknowledgment remains uncertain; store sends once and duplicate cannot regain dispatch', async () => {
      const f = await fixture(), r = request(f); let sends = 0;
      const store = createStore({ SUPABASE_URL: bounded.url, SUPABASE_SERVICE_ROLE_KEY: token }, {
        fetchImpl: async (url, options) => {
          const parsed = new URL(url); assert.equal(parsed.origin, bounded.url);
          assert.equal(parsed.pathname, '/rest/v1/rpc/runvara_reserve_provider_usage'); sends++;
          // Only remove Supabase's URL prefix; actual HTTP/SQL remain unchanged.
          const response = await fetch(bounded.url + parsed.pathname.slice('/rest/v1'.length), options);
          assert.equal(response.status, 200); assert.equal((await response.json()).dispatch_allowed, true);
          throw new Error('Synthetic lost acknowledgment AFTER real commit');
        }
      });
      await assert.rejects(store.reserveProviderUsage(f.workspaceId, input(r)), /AI_USAGE_RESERVATION_UNCERTAIN/);
      assert.equal(sends, 1); assert.equal((await reservations(f)).length, 1);
      // Deliberate synthetic duplicate tests the SQL contract, not an application retry.
      const duplicate = await reserve(bounded, r);
      assert.equal(duplicate.value.dispatch_allowed, false); assert.equal(duplicate.value.reason, 'AI_LOGICAL_CALL_EXISTS');
      for (const row of await windows(f)) { assert.equal(+row.held_requests, 1); assert.equal(+row.settled_requests, 2); }
    });

    await t.test('administrator outer 15s transaction timeout rolls back opening and seeded counters', async () => {
      const f = await openingFixture(), evidence = await openingEvidence(f); await slow(f);
      await using('postgres', async client => {
        await client.query('BEGIN');
        try {
          // Separate protocol commands arm the timeout BEFORE installer execution.
          await client.query("SET LOCAL statement_timeout='15s'");
          const started = performance.now();
          await assert.rejects(installOpening(f, evidence, client), error => error.code === '57014');
          const ms = Math.round(performance.now() - started);
          observations.push({ name: 'explicit outer installer deadline', ms, code: '57014' });
          assert.ok(ms >= 14500 && ms < 22000);
          await assert.rejects(client.query('SELECT 1'), error => error.code === '25P02');
        } finally { await client.query('ROLLBACK'); }
      });
      await noOpeningEffects(f);
      assert.equal((await admin.query("SELECT state#>'{aiEconomics,governance,enabled}' AS enabled FROM public.saas_workspace_state WHERE workspace_id=$1", [f.workspaceId])).rows[0].enabled, false);
    });
  } finally {
    // Close only these two loopback gateways before removing their synthetic hooks.
    await Promise.all(gateways.map(async g => {
      if (g.exited || g.spawnError) return;
      g.child.kill('SIGTERM');
      await Promise.race([g.finished, delay(3000)]);
      if (!g.exited) { g.child.kill('SIGKILL'); await g.finished; }
    }));
    if (delayObjectsCreated) await admin.query(`DROP TRIGGER synthetic_atomic_timeout_delay ON ${W}; DROP FUNCTION public.synthetic_atomic_timeout_delay(); DROP TABLE public.synthetic_atomic_timeout_delay`);
    if (roleCreated) await admin.query(`DROP ROLE ${authRole}`);
    console.log('ATOMIC_TIMEOUT_HTTP_PROOF=' + JSON.stringify({ postgres: '17.x disposable', postgrest: '14.5', providerCalls: 0, observations, gatewaysStopped: gateways.every(g => g.exited || g.spawnError) }));
  }
}
