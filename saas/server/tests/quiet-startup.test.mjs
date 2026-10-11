import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { createSessionToken, sessionCookie, verifySessionToken } from '../lib/security.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { verifyProductionHealth, PRODUCTION_HEALTH_URL } from '../lib/production-health-verifier.mjs';

const SECRET = 'quiet-startup-session-fixture-over-thirty-two-characters';
const ENV = { NODE_ENV: 'production', SESSION_SECRET: SECRET, CREDENTIALS_KEY: SECRET,
  APP_PUBLIC_URL: 'https://quiet.example.test', RUNVARA_STARTUP_MODE: 'quiet' };
const ASSETS = ['/', '/index.html', '/app.js', '/presentation.js', '/control-ui.js', '/outcomes-ui.js',
  '/activity-ui.js', '/connections-ui.js', '/styles.css', '/favicon.svg'];
// Include both read-looking routes with side effects and every mutation family.
const BLOCKED = [
  '/api/public/support', '/api/webhooks/stripe', '/api/auth/activate-owner', '/api/auth/login', '/api/auth/signup-options',
  '/api/auth/signup', '/api/auth/logout', '/api/auth/change-password', '/api/bootstrap', '/api/brief', '/api/briefs', '/api/briefs/brief_1',
  '/api/marketing/providers/canva/oauth/callback?code=fixture&state=fixture',
  ...['ebay', 'shopify', 'meta', 'google', 'tiktok', 'pinterest', 'unknown_provider'].flatMap(provider => [
    `/api/integrations/${provider}/oauth/callback?code=fixture&state=fixture`, `/api/integrations/${provider}/oauth/start`
  ]),
  '/api/marketing', '/api/marketing/settings', '/api/marketing/providers/canva/application', '/api/marketing/providers/canva/oauth/start',
  '/api/marketing/providers/canva/refresh', '/api/marketing/providers/canva/templates', '/api/marketing/providers/canva/template',
  '/api/marketing/providers/canva', '/api/marketing/providers/runway', '/api/marketing/providers/runway/test',
  '/api/marketing/campaigns', '/api/marketing/campaigns/campaign_1/creatives/advance', '/api/marketing/campaigns/campaign_1/request-publish-approval',
  '/api/business-outcomes', '/api/business-outcomes/experiments/experiment_1', '/api/business-outcomes/experiments/experiment_1/content-sources',
  '/api/business-outcomes/experiments/experiment_1/measurement', '/api/business-outcomes/publish', '/api/business-outcomes/versions/outcome_version_' + 'a'.repeat(64),
  '/api/admin/launch', '/api/admin/invitations', '/api/business-objectives', '/api/business-objectives/evaluate',
  '/api/business-objectives/reviews', '/api/business-objectives/reviews/job_fixture', '/api/business-graph', '/api/automation-runs/run_1/archive',
  '/api/migrate-pilot', '/api/economics', '/api/suppliers', '/api/suppliers/supplier_1', '/api/orders/order_1/economics', '/api/advertising-costs',
  '/api/web-intelligence', '/api/web-intelligence/settings', '/api/web-intelligence/targets', '/api/web-intelligence/targets/target_1', '/api/web-intelligence/scan',
  '/api/automations', '/api/actions', '/api/approvals', '/api/approvals/approval_1', '/api/approvals/approval_1/decision', '/api/audit',
  '/api/agents', '/api/agents/command', '/api/agents/commander/settings', '/api/control', '/api/agent-ops', '/api/agent-ops/jobs', '/api/agent-ops/jobs/job_1/retry',
  '/api/activity', '/api/operator/provider-usage', '/api/operator/agent-ops', '/api/operator/agent-ops/workspaces/alpha',
  '/api/operator/agent-ops/workspaces/alpha/jobs/job_1/retry', '/api/operator/providers', '/api/autopilot', '/api/autopilot/run',
  '/api/decision-memory', '/api/decision-memory/decision_1', '/api/exceptions/exception_1', '/api/opportunities/opportunity_1/approval',
  '/api/opportunities/opportunity_1/experiment', '/api/revenue-engine', '/api/hypergrowth/settings', '/api/revenue-engine/leads', '/api/revenue-engine/quotes',
  '/api/revenue-engine/intent', '/api/revenue-engine/attribution', '/api/revenue-engine/experiments', '/api/revenue-engine/experiments/experiment_1/measure',
  '/api/revenue-engine/experiments/experiment_1/verify', '/api/reports/accounting.csv', '/api/objective-content/context', '/api/objective-content/requests',
  '/api/objective-content/requests/' + 'a'.repeat(16), '/api/connections/shopify/content-requests/' + 'a'.repeat(16),
  '/api/connections/shopify/order-recovery', '/api/connections/shopify/order-recovery/start', '/api/connections/shopify/order-recovery/resume',
  '/api/connection-centre', '/api/connections/shopify/write-preview', '/api/connection-writes/write_1/execute',
  ...['settings', 'disconnect', 'test', 'refresh', 'sync', 'setup-request', 'writes'].map(action => `/api/connections/shopify/${action}`),
  '/api/integrations', '/api/integrations/sync', '/api/integrations/shopify/sync', '/api/integrations/ebay/sync', '/api/connections',
  '/api/billing', '/api/billing/checkout', '/api/onboarding', '/api/startup', '/api/startup/normal', '/api/health/', '/api/auth/session/',
  '/health', '/healthz', '/ready', '/missing.js', '/api%2fhealth', '/API/health', '/api/auth/%73ession'
];

const turn = () => new Promise(resolve => setImmediate(resolve));

async function listen(t, server) {
  t.after(async () => {
    await server.packsmart.drain();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (pathname, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: pathname, method,
      headers: { ...headers, ...(body === undefined ? {} : { 'Content-Length': Buffer.byteLength(body) }) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', error => reject(new Error(`${method} ${pathname}: ${error.message}`, { cause: error })));
    req.end(body);
  });
}

async function fixture(t, { env = {}, schedulerEnabled = true, agentOpsEnabled = true, storeOverrides = {} } = {}) {
  const calls = [];
  let saved = seedWorkspaceState({}, { workspaceId: 'alpha', email: 'owner@example.test' });
  saved.users[0].passwordChangeRequired = false;
  saved.autopilot.enabled = true;
  saved.agentOps = { enabled: true, paused: false };
  const record = (name, action) => (...args) => { calls.push(name); return action(...args); };
  const store = {
    provider: 'supabase', ping: record('ping', async () => true),
    diagnostics: record('diagnostics', () => ({ primaryPersistence: true, stateSizeStatus: 'healthy' })),
    getIdentity: record('identity', async () => ({ workspace: structuredClone(saved.workspace), users: structuredClone(saved.users) })),
    get: record('get', async () => structuredClone(saved)),
    save: record('save', async (_id, state) => { saved = structuredClone(state); return saved; }),
    listWorkspaceIds: record('listWorkspaces', async () => []),
    claimAgentJobs: record('claim', async () => []),
    integrityCheck: record('integrity', async () => ({ healthy: true })), ...storeOverrides
  };
  const config = { ...ENV, ...env };
  const options = { store, schedulerEnabled, agentOpsEnabled,
    fetchImpl: async () => { calls.push('fetch'); assert.fail('Unexpected external request'); } };
  const server = createPacksmartServer(config, options);
  server.prependListener('request', req => {
    const iterator = req[Symbol.asyncIterator];
    req[Symbol.asyncIterator] = function (...args) { calls.push('body'); return iterator.apply(this, args); };
  });
  const request = await listen(t, server);
  const token = createSessionToken({ userId: saved.users[0].id, workspaceId: saved.workspace.id, email: saved.users[0].email,
    role: 'owner', sessionVersion: saved.users[0].sessionVersion }, SECRET);
  const headers = { Cookie: sessionCookie(token, { secure: true }).split(';')[0],
    'X-CSRF-Token': verifySessionToken(token, SECRET).csrf, 'Content-Type': 'application/json' };
  return { calls, server, config, options, store, request, headers, state: () => saved };
}

function assertQuiet(response, method = 'GET') {
  assert.equal(response.status, 503);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['retry-after'], undefined);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.headers.location, undefined);
  assert.ok(response.headers['x-request-id']);
  if (method === 'HEAD') assert.equal(response.text, '');
  else {
    assert.deepEqual(JSON.parse(response.text), { code: 'STARTUP_QUIET_MODE',
      error: 'New work is temporarily paused for an update. Earlier work may still be running.' });
    assert.doesNotMatch(response.text, /retry|try again|token|credential/i);
  }
}

test('quiet denies every business route/method before authentication, body reads, providers or persistence', async t => {
  const f = await fixture(t);
  const before = structuredClone(f.state());
  for (const pathname of BLOCKED) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
      const response = await f.request(pathname, { method, headers: { ...f.headers, 'X-CSRF-Token': 'deliberately-invalid' },
        ...(!['GET', 'HEAD'].includes(method) ? { body: '{invalid-json' } : {}) });
      assertQuiet(response, method);
    }
  }
  for (const pathname of [...ASSETS, '/api/health', '/api/auth/session']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', ...(pathname === '/api/auth/session' ? ['HEAD'] : [])]) {
      assertQuiet(await f.request(pathname, { method, headers: f.headers, body: 'invalid' }), method);
    }
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.state(), before);
});

test('quiet admits only health, valid session inspection and exact static GET/HEAD with existing health/cache/auth semantics', async t => {
  const f = await fixture(t);
  for (const pathname of ASSETS) {
    const first = await f.request(pathname);
    assert.equal(first.status, 200, pathname);
    assert.ok(first.text.length > 0);
    const head = await f.request(pathname, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.text, '');
    for (const method of ['GET', 'HEAD']) {
      const cached = await f.request(pathname, { method, headers: { 'If-None-Match': first.headers.etag } });
      assert.equal(cached.status, 304); assert.equal(cached.text, '');
    }
  }
  assert.deepEqual(f.calls, []);
  const health = await f.request('/api/health');
  const body = JSON.parse(health.text);
  assert.equal(health.status, 200); assert.equal(body.startupMode, 'quiet');
  assert.equal(body.ok, true); assert.equal(body.productionReady, false);
  assert.equal(body.agentOps.running, false); assert.equal(body.agentOps.lastTickAt, null);
  assert.deepEqual(body.checks, { persistence: true, primaryPersistence: true, stateSizeSafe: true,
    authentication: true, credentialEncryption: true, billingCharging: false });
  const head = await f.request('/api/health', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.text, '');
  assert.equal((await f.request('/api/auth/session')).status, 401);
  assert.equal((await f.request('/api/auth/session', { headers: { Cookie: '__Host-packsmart_session=invalid' } })).status, 401);
  const session = await f.request('/api/auth/session', { headers: f.headers });
  assert.equal(session.status, 200); assert.equal(JSON.parse(session.text).workspace.id, 'alpha');
  assert.deepEqual(f.calls, ['ping', 'diagnostics', 'diagnostics', 'identity']);
});

test('quiet cannot be reopened by env/options/tenant mutation or request headers and query overrides', async t => {
  const f = await fixture(t);
  f.config.RUNVARA_STARTUP_MODE = 'normal'; f.server.packsmart.env.RUNVARA_STARTUP_MODE = 'normal';
  f.options.schedulerEnabled = true; f.options.agentOpsEnabled = true; f.options.startupMode = 'normal';
  f.state().RUNVARA_STARTUP_MODE = 'normal'; f.state().startupMode = 'normal';
  assert.throws(() => { f.server.packsmart.startupMode = 'normal'; }, TypeError);
  for (const pathname of ['/api/bootstrap', '/api/marketing/providers/canva/templates', '/api/auth/login']) {
    assertQuiet(await f.request(pathname + '?startupMode=normal&RUNVARA_STARTUP_MODE=normal&workspaceId=beta', {
      headers: { ...f.headers, 'X-Runvara-Startup-Mode': 'normal', 'X-Startup-Mode': 'normal', 'X-HTTP-Method-Override': 'GET',
        'X-Original-URL': '/api/health', 'X-Rewrite-URL': '/api/auth/session', 'X-Workspace-Id': 'beta' }
    }));
  }
  f.server.packsmart.scheduler.start(); f.server.packsmart.agentOps.start();
  await Promise.all([f.server.packsmart.scheduler.tick(), f.server.packsmart.agentOps.tick(),
    f.server.packsmart.scheduler.runWorkspace('alpha', { force: true })]);
  assert.deepEqual(f.calls, []);
  assert.equal(JSON.parse((await f.request('/api/health')).text).startupMode, 'quiet');
});

test('quiet production creates no workers or integrity timers even with due jobs, unhealthy state and forced worker options', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const scheduled = [];
  const interval = globalThis.setInterval, timeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setInterval', (...args) => { scheduled.push('interval'); return interval(...args); });
  t.mock.method(globalThis, 'setTimeout', (...args) => { scheduled.push('timeout'); return timeout(...args); });
  const calls = [], badState = seedWorkspaceState({}, { workspaceId: 'alpha', email: 'owner@example.test' });
  badState.agentRuns = Array.from({ length: 20 }, (_, i) => ({ id: String(i) }));
  const dueJob = { id: 'job_due', workspace_id: 'alpha', status: 'queued', available_at: '2000-01-01T00:00:00.000Z' };
  const server = createPacksmartServer({ ...ENV, SUPABASE_URL: 'https://quiet-db.example.test', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only' }, {
    schedulerEnabled: true, agentOpsEnabled: true, fetchImpl: async (url, options = {}) => {
      calls.push([options.method || 'GET', String(url)]);
      return Response.json(String(url).includes('claim') ? [dueJob] : [{ workspace_id: 'alpha', state: badState }]);
    }
  });
  assert.deepEqual(calls, [], 'real store and provider constructors perform no I/O');
  await listen(t, server);
  t.mock.timers.tick(86400001); await turn();
  server.packsmart.scheduler.start(); server.packsmart.agentOps.start();
  await Promise.all([server.packsmart.scheduler.tick(), server.packsmart.agentOps.tick(), server.packsmart.scheduler.runWorkspace('alpha', { force: true })]);
  t.mock.timers.tick(86400001); await turn();
  assert.deepEqual(scheduled, [], 'quiet must not allocate application timers');
  assert.deepEqual(calls, [], 'no queue claims, integrity reads/repairs, database writes or provider traffic');
  assert.equal(server.packsmart.scheduler.status.lastTickAt, null);
  assert.equal(server.packsmart.agentOps.status.pollCalls, 0);
});

test('quiet file-store startup and health/session inspection do not create or change persisted files', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-quiet-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'uncreated', 'state.json');
  const server = createPacksmartServer({ ...ENV, NODE_ENV: 'test', SAAS_STATE_FILE: stateFile }, {
    schedulerEnabled: true, agentOpsEnabled: true, fetchImpl: async () => assert.fail('Unexpected provider request')
  });
  const request = await listen(t, server);
  assert.equal((await request('/api/health')).status, 200);
  assert.equal((await request('/api/auth/session')).status, 401);
  assert.deepEqual(await fs.readdir(dir), []);
  const state = seedWorkspaceState({}, { workspaceId: 'alpha', email: 'owner@example.test' });
  await fs.mkdir(path.dirname(stateFile));
  const bytes = JSON.stringify({ alpha: state }); await fs.writeFile(stateFile, bytes);
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: 'alpha', email: state.users[0].email,
    role: 'owner', sessionVersion: state.users[0].sessionVersion }, SECRET);
  assert.equal((await request('/api/auth/session', { headers: { Cookie: sessionCookie(token, { secure: true }).split(';')[0] } })).status, 200);
  assert.equal(await fs.readFile(stateFile, 'utf8'), bytes);
});

test('quiet actual Supabase health/session use only narrow GET reads and never seed or repair state', async t => {
  const state = seedWorkspaceState({}, { workspaceId: 'alpha', email: 'owner@example.test' }), calls = [];
  const server = createPacksmartServer({ ...ENV, SUPABASE_URL: 'https://quiet-db.example.test', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only' }, {
    schedulerEnabled: true, agentOpsEnabled: true, fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url); calls.push({ method: options.method || 'GET', path: parsed.pathname, select: parsed.searchParams.get('select') });
      if (parsed.searchParams.get('select') === 'workspace_id') return Response.json([{ workspace_id: 'alpha' }]);
      if (parsed.searchParams.get('select') === 'state->workspace,state->users') return Response.json([{ workspace: state.workspace, users: state.users }]);
      assert.fail('Unexpected persistence query');
    }
  });
  const request = await listen(t, server);
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: 'alpha', email: state.users[0].email,
    role: 'owner', sessionVersion: state.users[0].sessionVersion }, SECRET);
  assert.deepEqual(calls, []);
  assert.equal((await request('/api/health')).status, 200);
  assert.equal((await request('/api/auth/session', { headers: { Cookie: sessionCookie(token, { secure: true }).split(';')[0] } })).status, 200);
  assert.deepEqual(calls, [
    { method: 'GET', path: '/rest/v1/saas_workspace_state', select: 'workspace_id' },
    { method: 'GET', path: '/rest/v1/saas_workspace_state', select: 'state->workspace,state->users' }
  ]);
});

test('unknown startup configuration fails before reading options or constructing stores/providers', () => {
  const options = new Proxy({}, { get() { assert.fail('Startup config must be validated before options/store/provider access'); } });
  for (const value of ['', 'QUIET', 'quiet ', 'enabled', 'private-fixture-value']) {
    assert.throws(() => createPacksmartServer({ ...ENV, RUNVARA_STARTUP_MODE: value, SUPABASE_URL: 'invalid-url', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only' }, options),
      error => error.code === 'STARTUP_MODE_INVALID' && !error.message.includes(value === '' ? 'private-fixture-value' : value));
  }
});

test('quiet preserves failures from production readiness checks', async t => {
  for (const [name, env, storeOverrides] of [
    ['persistence', {}, { ping: async () => false }],
    ['primary persistence', {}, { diagnostics: () => ({ primaryPersistence: false }) }],
    ['state size', {}, { diagnostics: () => ({ primaryPersistence: true, stateSizeStatus: 'critical' }) }],
    ['authentication', { SESSION_SECRET: 'short' }, {}],
    ['encryption', { CREDENTIALS_KEY: 'short' }, {}],
    ['production storage', {}, { provider: 'file' }]
  ]) {
    await t.test(name, async t => {
      const f = await fixture(t, { env, storeOverrides });
      const response = await f.request('/api/health'), body = JSON.parse(response.text);
      assert.equal(response.status, 503); assert.equal(body.ok, false); assert.equal(body.productionReady, false);
      assert.equal(body.startupMode, 'quiet'); assert.equal(body.code, undefined);
    });
  }
});

test('existing production verifier rejects quiet liveness but accepts normal and legacy health payloads', async t => {
  const commit = 'a'.repeat(40), deployedAt = new Date(Date.now() - 1000).toISOString();
  for (const mode of ['quiet', 'normal', undefined]) {
    await t.test(mode ?? 'legacy-compatible default', async t => {
      const f = await fixture(t, { env: { RUNVARA_STARTUP_MODE: mode, RENDER_GIT_COMMIT: commit }, schedulerEnabled: false, agentOpsEnabled: false });
      const response = await f.request('/api/health'), payload = JSON.parse(response.text);
      assert.equal(response.status, 200); assert.equal(payload.ok, true);
      const verify = body => verifyProductionHealth({ expectedCommit: commit, deployedAt, transport: async () => {
        const captured = Response.json(body, { status: response.status });
        Object.defineProperties(captured, { url: { value: PRODUCTION_HEALTH_URL }, redirected: { value: false } });
        return captured;
      } });
      if (mode === 'quiet') await assert.rejects(verify(payload), { code: 'HEALTH_FLAGS_NOT_READY' });
      else {
        assert.equal((await verify(payload)).productionReady, true);
        delete payload.startupMode;
        assert.equal((await verify(payload)).productionReady, true, 'legacy healthy payloads remain accepted');
      }
    });
  }
});

test('default and explicit normal retain bootstrap/brief saves and production worker/integrity admission', async t => {
  for (const mode of [undefined, 'normal']) {
    await t.test(mode ?? 'absent', async t => {
      const f = await fixture(t, { env: { RUNVARA_STARTUP_MODE: mode } });
      await turn();
      assert.ok(f.calls.includes('listWorkspaces')); assert.ok(f.calls.includes('claim')); assert.ok(f.calls.includes('integrity'));
      const health = await f.request('/api/health');
      assert.equal(health.status, 200); assert.equal(JSON.parse(health.text).startupMode, 'normal');
      f.calls.length = 0;
      const bootstrap = await f.request('/api/bootstrap', { headers: f.headers });
      assert.equal(bootstrap.status, 200); assert.ok(f.calls.includes('save'));
      f.calls.length = 0; f.state().dailyBriefs = [];
      f.config.RUNVARA_STARTUP_MODE = 'quiet'; f.server.packsmart.env.RUNVARA_STARTUP_MODE = 'quiet';
      const brief = await f.request('/api/brief', { headers: f.headers });
      assert.equal(brief.status, 200); assert.ok(f.calls.includes('save'));
      assert.equal(f.server.packsmart.startupMode, 'normal');
    });
  }
});
