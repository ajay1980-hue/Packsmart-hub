import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { createSessionToken, decryptCredentials, sessionCookie } from '../lib/security.mjs';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { createBusinessOutcomePersistence } from '../lib/business-outcome-store.mjs';
import { createOutcomePublicationBoundary } from '../lib/business-outcomes.mjs';

const SESSION_SECRET = 'server-integration-session-secret-more-than-thirty-two-characters';
const BOOTSTRAP_PASSWORD = 'BootstrapOnly!789Abc';
const OWNER_PASSWORD = 'PacksmartOwner!2026Secure';
const ACTIVATION_TOKEN = 'one-time-owner-activation-token-more-than-thirty-two-characters';

function requestFactory(base) {
  return async function request(pathname, { method = 'GET', body, cookie, csrf, redirect } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const response = await fetch(base + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect
    });
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = text; }
    return { response, payload, setCookie: response.headers.get('set-cookie') || '' };
  };
}

function cookieValue(setCookie) {
  return String(setCookie).split(';')[0];
}

test('explicit current graph reads share outcome allowance, keep roles and read each authenticated snapshot once', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-current-graph-'));
  let providerCalls = 0;
  const server = createPacksmartServer({ NODE_ENV: 'test', APP_PUBLIC_URL: 'http://localhost:8787',
    SAAS_STATE_FILE: path.join(directory, 'state.json'), SESSION_SECRET,
    SHOPIFY_PUBLIC_SYNC_ENABLED: 'false', BETA_SIGNUPS_ENABLED: 'false', BILLING_CHECKOUT_ENABLED: 'false' },
  { schedulerEnabled: false, agentOpsEnabled: false,
    fetchImpl: async () => { providerCalls++; assert.fail('Graph reads must not call providers or remote networks'); },
    aiProvider: { enhanceCommander: async () => { providerCalls++; assert.fail('Graph reads must not invoke a model'); } } });
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const { store } = server.packsmart;
  const state = seedWorkspaceState({}, { workspaceId: 'graph-tenant', email: 'graph-owner@example.test' });
  state.users[0].passwordChangeRequired = false;
  for (const role of ['admin', 'member', 'viewer']) state.users.push({ ...state.users[0], id: `graph-${role}`, role, email: `graph-${role}@example.test` });
  await store.save(state.workspace.id, state);
  const cookieFor = role => {
    const user = state.users.find(row => row.role === role);
    return cookieValue(sessionCookie(createSessionToken({ userId: user.id, workspaceId: state.workspace.id, email: user.email, role,
      sessionVersion: user.sessionVersion }, SESSION_SECRET), { secure: false }));
  };
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const request = requestFactory(`http://127.0.0.1:${server.address().port}`), owner = cookieFor('owner');
  let currentReads = 0, stateReads = 0, writes = 0, evidenceReads = 0, reviewReads = 0;
  const selectedTenants = [];
  const persistence = createBusinessOutcomePersistence({ request: async (target, options) => {
    assert.match(target, /^runvara_business_outcome_heads\?workspace_id=eq.graph-tenant&/);
    assert.match(target, /limit=51$/); assert.equal(target.includes('source_action'), false); assert.equal(target.includes('source_measurement'), false);
    assert.equal(options.maxResponseBytes, 2 * 1024 * 1024); return { data: [], contentRange: '*/0' };
  } });
  let readMode = 'available';
  store.businessOutcomeSummary = async tenant => {
    currentReads++; selectedTenants.push(tenant);
    if (readMode === 'incomplete') return { versions: [], summary: { generatedAt: new Date().toISOString(), coverage: { complete: true } },
      publicationBoundary: createOutcomePublicationBoundary({ workspaceId: tenant, snapshotId: 'incomplete-read', complete: false,
        expectedOutcomeCount: 1, resolveCommittedPublication: () => null }) };
    if (readMode !== 'available') throw Object.assign(new Error('private upstream error'), { code: readMode });
    return persistence.current(tenant);
  };
  await request('/api/bootstrap', { cookie: owner });
  assert.equal(currentReads, 0, 'bootstrap does not inspect current outcomes');
  const get = store.get.bind(store); store.get = async (...args) => { stateReads++; return get(...args); };
  for (const method of ['save', 'publishBusinessOutcome', 'reserveProviderUsage', 'settleProviderUsage', 'enqueueAgentJob']) store[method] = async () => { writes++; assert.fail(`Unexpected write ${method}`); };
  store.getBusinessOutcomeReview = async () => { reviewReads++; return { selected: true }; };
  store.getBusinessOutcomeEvidence = async () => { evidenceReads++; return { currentStatus: 'not_checked' }; };

  await t.test('bootstrap and default/detail graph add no outcome calls and preserve fixed bounds', async () => {
    for (const target of ['/api/bootstrap', '/api/business-graph', '/api/business-graph?detail=true&nodeLimit=999999&workspaceId=foreign']) {
      const result = await request(target, { cookie: owner }); assert.equal(result.response.status, 200);
      assert.equal(result.payload.reviewedOutcomes, undefined);
      if (target.includes('detail')) assert.deepEqual(result.payload.limits, { recordLimit: 50, nestedLimit: 25, scanLimit: 2000, nodeLimit: 200, edgeLimit: 400, unknownLimit: 100 });
    }
    assert.equal(currentReads, 0); assert.equal(writes, 0);
  });
  await t.test('invalid opt-in and tenant/limit/proof overrides are rejected before outcome access', async () => {
    const anonymous = await request('/api/business-graph?outcomes=current'); assert.equal(anonymous.response.status, 401);
    for (const query of ['outcomes=history', 'outcomes=', 'outcomes=current&outcomes=current', 'outcomes=current&workspaceId=foreign',
      'outcomes=current&nodeLimit=9999', 'outcomes=current&publicationBoundary=forged', 'outcomes=current&detail=maybe', 'outcomes=current&detail=true&detail=false']) {
      const result = await request(`/api/business-graph?${query}`, { cookie: owner });
      assert.equal(result.response.status, 400); assert.equal(result.payload.code, 'OUTCOME_REQUEST_INVALID');
    }
    assert.equal(currentReads, 0);
  });
  await t.test('all authenticated roles get one state and one private head read without evidence hydration', async () => {
    for (const role of ['owner', 'admin', 'member', 'viewer']) {
      const before = { currentReads, stateReads };
      const result = await request('/api/business-graph?outcomes=current&detail=true', { cookie: cookieFor(role) });
      assert.equal(result.response.status, 200); assert.equal(currentReads, before.currentReads + 1); assert.equal(stateReads, before.stateReads + 1);
      assert.equal(result.payload.reviewedOutcomes.status, 'available'); assert.equal(result.payload.reviewedOutcomes.counts.currentHeadsRead, 0);
      assert.equal(result.payload.reviewedOutcomes.coverage.publicationHeadsComplete, true);
      assert.ok(result.payload.reviewedOutcomes.snapshots.workspace.readCompletedAt <= result.payload.reviewedOutcomes.snapshots.outcomes.readCompletedAt);
      assert.equal(result.payload.reviewedOutcomes.snapshots.independent, true);
      assert.equal(result.payload.summary.verifiedOutcomeRecords, 0);
    }
    assert.equal(evidenceReads, 0); assert.equal(reviewReads, 0); assert.equal(writes, 0);
    assert.ok(selectedTenants.every(tenant => tenant === state.workspace.id));
  });
  await t.test('existing selected-review and evidence role matrix is unchanged', async () => {
    for (const role of ['owner', 'admin', 'member', 'viewer']) {
      const review = await request('/api/business-outcomes/experiments/example', { cookie: cookieFor(role) });
      assert.equal(review.response.status, ['owner', 'admin'].includes(role) ? 200 : 403);
      const evidence = await request(`/api/business-outcomes/versions/outcome_version_${'a'.repeat(64)}`, { cookie: cookieFor(role) });
      assert.equal(evidence.response.status, 200); assert.equal(evidence.payload.currentStatus, 'not_checked');
    }
    assert.equal(reviewReads, 2); assert.equal(evidenceReads, 4);
  });
  await t.test('incomplete and unavailable storage stay distinct from a complete empty read', async () => {
    for (const mode of ['incomplete', 'OUTCOME_STORAGE_UNAVAILABLE', 'OUTCOME_COVERAGE_UNAVAILABLE', 'OUTCOME_RESPONSE_TOO_LARGE']) {
      readMode = mode;
      const result = await request('/api/business-graph?outcomes=current', { cookie: cookieFor('viewer') });
      assert.equal(result.response.status, 200); assert.equal(result.payload.reviewedOutcomes.coverage.publicationHeadsComplete, false);
      assert.equal(result.payload.reviewedOutcomes.status, mode === 'incomplete' ? 'incomplete' : 'unavailable');
      assert.deepEqual(result.payload.reviewedOutcomes.groups, []);
      if (mode !== 'incomplete') assert.equal(result.payload.reviewedOutcomes.counts.currentHeadsRead, null);
      assert.equal(JSON.stringify(result.payload).includes('private upstream error'), false);
    }
    readMode = 'available';
  });
  await t.test('graph and outcome endpoints consume the same ten-read allowance', async () => {
    // Owner has used graph + selected review + exact evidence = three reads.
    for (let index = 0; index < 7; index++) {
      const result = await request(index % 2 ? '/api/business-outcomes' : '/api/business-graph?outcomes=current', { cookie: owner });
      assert.equal(result.response.status, 200);
    }
    const reads = currentReads;
    for (const target of ['/api/business-outcomes', '/api/business-graph?outcomes=current', '/api/business-graph?outcomes=current&detail=true']) {
      const denied = await request(target, { cookie: owner }); assert.equal(denied.response.status, 429); assert.equal(denied.payload.code, 'OUTCOME_RATE_LIMITED');
    }
    assert.equal(currentReads, reads);
    assert.equal((await request('/api/business-graph', { cookie: owner })).response.status, 200);
    assert.equal(writes, 0); assert.equal(providerCalls, 0);
  });
});

test('operator provider usage requires platform-owner auth and stays read-only when durable accounting is unavailable', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-provider-usage-auth-'));
  const stateFile = path.join(directory, 'state.json');
  const server = createPacksmartServer({
    NODE_ENV: 'test', APP_PUBLIC_URL: 'http://localhost:8787', SAAS_STATE_FILE: stateFile,
    PACKSMART_ADMIN_EMAIL: 'sales@packsmartsolutions.com', SESSION_SECRET,
    SHOPIFY_PUBLIC_SYNC_ENABLED: 'false', BETA_SIGNUPS_ENABLED: 'false', BILLING_CHECKOUT_ENABLED: 'false'
  }, { schedulerEnabled: false, agentOpsEnabled: false });
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const { store } = server.packsmart;
  const platformState = seedWorkspaceState({}, { workspaceId: 'packsmart-solutions', email: 'sales@packsmartsolutions.com' });
  const tenantState = seedWorkspaceState({}, { workspaceId: 'usage-tenant', email: 'owner@usage-tenant.test' });
  for (const state of [platformState, tenantState]) {
    state.users[0].passwordChangeRequired = false;
    await store.save(state.workspace.id, state);
  }
  const cookieFor = state => cookieValue(sessionCookie(createSessionToken({
    userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email,
    role: state.users[0].role, sessionVersion: state.users[0].sessionVersion
  }, SESSION_SECRET), { secure: false }));
  const platformCookie = cookieFor(platformState);
  const tenantCookie = cookieFor(tenantState);
  const before = await fs.readFile(stateFile, 'utf8');
  const summaries = [];
  const originalSummary = store.providerUsageSummary.bind(store);
  store.providerUsageSummary = async (...args) => {
    summaries.push(args);
    return originalSummary(...args);
  };
  let writes = 0;
  for (const method of ['save', 'reserveProviderUsage', 'settleProviderUsage', 'recordAiUsage', 'enqueueAgentJob']) {
    store[method] = async () => { writes++; throw new Error('Provider usage GET must not write'); };
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const request = requestFactory(`http://127.0.0.1:${server.address().port}`);

  await t.test('unauthenticated access and tenant-owner query spoofing are rejected before usage lookup', async () => {
    const anonymous = await request('/api/operator/provider-usage?month=2026-10');
    assert.equal(anonymous.response.status, 401);
    assert.equal(anonymous.payload.code, 'AUTH_REQUIRED');
    assert.equal(tenantState.users[0].role, 'owner');
    for (const target of ['', '&workspaceId=packsmart-solutions', '&workspaceId=another-tenant']) {
      const denied = await request(`/api/operator/provider-usage?month=2026-10${target}`, { cookie: tenantCookie });
      assert.equal(denied.response.status, 403);
      assert.equal(denied.payload.code, 'PLATFORM_ADMIN_REQUIRED');
      assert.equal(denied.payload.scopes, undefined);
    }
    assert.equal(summaries.length, 0);
  });

  await t.test('platform owner gets explicit FileStore unavailability, with no invented zero totals', async () => {
    const own = await request('/api/operator/provider-usage?month=2026-10', { cookie: platformCookie });
    assert.equal(own.response.status, 200);
    assert.deepEqual(own.payload, { workspaceId: 'packsmart-solutions', source: 'governed_reservations_only',
      excludesLegacyUsage: true, excludesProviderBill: true, available: false, reason: 'AI_USAGE_NOT_CONFIGURED' });
    const selected = await request('/api/operator/provider-usage?workspaceId=usage-tenant&month=2026-09', { cookie: platformCookie });
    assert.equal(selected.response.status, 200);
    assert.equal(selected.payload.workspaceId, 'usage-tenant');
    assert.equal(selected.payload.available, false);
    for (const key of ['scopes', 'totals', 'held', 'settled', 'costMicros']) assert.equal(selected.payload[key], undefined);
    assert.deepEqual(summaries, [['packsmart-solutions', '2026-10'], ['usage-tenant', '2026-09']]);
  });

  await t.test('invalid admission months return a safe 400 without changing accounting', async () => {
    for (const month of ['2026-13', '2026-00', '2026-10-01', '2026-1', '0000-01', '2026-10&select=*']) {
      const invalid = await request(`/api/operator/provider-usage?month=${encodeURIComponent(month)}`, { cookie: platformCookie });
      assert.equal(invalid.response.status, 400);
      assert.equal(invalid.payload.code, 'AI_USAGE_INPUT_INVALID');
      assert.equal(invalid.payload.available, undefined);
      assert.equal(invalid.payload.scopes, undefined);
    }
  });

  assert.equal(writes, 0, 'on-demand inspection must never reserve, settle, enqueue, or persist');
  assert.equal(await fs.readFile(stateFile, 'utf8'), before, 'GETs preserve every byte of persisted workspace data');
  assert.deepEqual(store.aiUsage, []);
  assert.deepEqual(store.agentJobs, []);
});

test('provider usage keeps unsafe NUMERIC summaries unavailable while preserving exact settlement costs', async () => {
  const numericRow = { workspace_id: 'usage-tenant', scope_key: 'tenant', window_start: '2026-10-01', currency: 'USD',
    held_requests: 0, held_input_tokens: 0, held_output_tokens: 0, held_total_tokens: 0, held_cost_micros: 0,
    settled_requests: 1, settled_input_tokens: 10, settled_output_tokens: 2, settled_total_tokens: 12, settled_cost_micros: 20 };
  let responseBody;
  const calls = [];
  const store = createStore({ SUPABASE_URL: 'https://usage-numeric-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-key' }, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(responseBody, { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/1' } });
    }
  });
  for (const key of ['held_requests', 'held_input_tokens', 'held_total_tokens', 'held_cost_micros',
    'settled_requests', 'settled_output_tokens', 'settled_total_tokens', 'settled_cost_micros']) {
    for (const decimal of ['9007199254740993', '999999999999999999999999999999999999999999999999999999999999']) {
      // SQL may explicitly return a lossless decimal string. It must never be
      // coerced/rounded into a displayed money, token, or request total.
      responseBody = JSON.stringify([{ ...numericRow, [key]: decimal }]);
      assert.deepEqual(await store.providerUsageSummary('usage-tenant', '2026-10'), { available: false, reason: 'AI_USAGE_RESPONSE_INVALID' });
      // PostgREST numeric aggregates also arrive as JSON number literals.
      responseBody = responseBody.replace(`"${decimal}"`, decimal);
      assert.deepEqual(await store.providerUsageSummary('usage-tenant', '2026-10'), { available: false, reason: 'AI_USAGE_RESPONSE_INVALID' });
    }
  }
  assert.ok(calls.every(call => new URL(call.url).pathname === '/rest/v1/runvara_provider_usage_windows'));
  responseBody = JSON.stringify([{ ...numericRow, settled_cost_micros: Number.MAX_SAFE_INTEGER }]);
  const safe = await store.providerUsageSummary('usage-tenant', '2026-10');
  assert.equal(safe.available, true);
  assert.equal(safe.scopes[0].settled.costMicros, Number.MAX_SAFE_INTEGER);

  const settlementInput = {
    reservationId: 'reservation-numeric-test', requestFingerprint: 'a'.repeat(64), outcome: 'complete',
    receipt: { jobId: 'usage-job', providerRequestId: 'provider-request', inputTokens: 10, cachedInputTokens: 0,
      cacheWriteTokens: 0, outputTokens: 2, totalTokens: 12 }
  };
  const exactSqlCost = '81129638414606663681390496';
  responseBody = JSON.stringify({ reservation_id: 'reservation-numeric-test', status: 'overrun',
    accounted_cost_micros: exactSqlCost, window_start: '2026-10-01', idempotent: false });
  const settled = await store.settleProviderUsage('usage-tenant', settlementInput);
  assert.deepEqual(settled, { reservationId: 'reservation-numeric-test', status: 'overrun',
    accountedCostMicros: exactSqlCost, windowStart: '2026-10-01', idempotent: false });
  assert.equal(typeof settled.accountedCostMicros, 'string');
  responseBody = JSON.stringify({ reservation_id: 'reservation-numeric-test', status: 'overrun',
    accounted_cost_micros: exactSqlCost, idempotent: true });
  assert.deepEqual(await store.settleProviderUsage('usage-tenant', settlementInput), {
    reservationId: 'reservation-numeric-test', status: 'overrun', accountedCostMicros: exactSqlCost, idempotent: true
  });
  responseBody = JSON.stringify({ reservation_id: 'reservation-numeric-test', status: 'overrun',
    accounted_cost_micros: '9'.repeat(60), window_start: '2026-10-01', idempotent: false });
  assert.equal((await store.settleProviderUsage('usage-tenant', settlementInput)).accountedCostMicros, '9'.repeat(60));
  for (const cost of ['', ' ', '00', '01', '+1', '-1', '1.0', '1.5', '1e30', 'Infinity', '9'.repeat(61), `${exactSqlCost}\n`]) {
    responseBody = JSON.stringify({ reservation_id: 'reservation-numeric-test', status: 'overrun',
      accounted_cost_micros: cost, window_start: '2026-10-01', idempotent: false });
    await assert.rejects(() => store.settleProviderUsage('usage-tenant', settlementInput),
      error => error.code === 'AI_USAGE_RESPONSE_INVALID' && error.dispatchAllowed === false);
  }
  assert.equal(new URL(calls.at(-1).url).pathname, '/rest/v1/rpc/runvara_settle_provider_usage');
});

test('production auth, CSRF, approval, logout and tenant isolation work end to end', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'packsmart-ops-test-'));
  const stateFile = path.join(directory, 'state.json');
  const server = createPacksmartServer({
    NODE_ENV: 'test',
    APP_PUBLIC_URL: 'http://localhost:8787',
    SAAS_STATE_FILE: stateFile,
    PACKSMART_ADMIN_EMAIL: 'sales@packsmartsolutions.com',
    PACKSMART_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
    SESSION_SECRET,
    CREDENTIALS_KEY: 'server-integration-credential-key-more-than-thirty-two-characters',
    SHOPIFY_PUBLIC_SYNC_ENABLED: 'false',
    BETA_SIGNUPS_ENABLED: 'false',
    BILLING_CHECKOUT_ENABLED: 'false'
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const request = requestFactory(base);

  const health = await request('/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.payload.ok, true);
  assert.equal(health.payload.checks.billingCharging, false);

  const appAsset = await request('/app.js');
  assert.equal(appAsset.response.status, 200);
  assert.match(appAsset.response.headers.get('content-type'), /javascript/);
  assert.equal(appAsset.response.headers.get('cache-control'), 'no-cache');
  assert.match(String(appAsset.payload), /HttpOnly|packsmart/i);
  const home = await request('/');
  assert.equal(home.response.status, 200);
  assert.ok(String(home.payload).includes(`/app.js?v=${health.payload.version}`), 'browser assets use the deployed release version');
  const head = await request('/', { method: 'HEAD' });
  assert.equal(head.response.status, 200);
  assert.deepEqual(head.payload, {});

  const protectedResponse = await request('/api/bootstrap');
  assert.equal(protectedResponse.response.status, 401);
  assert.equal((await request('/api/business-graph')).response.status, 401);

  const wrongLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'sales@packsmartsolutions.com', password: 'WrongPassword!1234' }
  });
  assert.equal(wrongLogin.response.status, 401);
  assert.equal(wrongLogin.payload.error, 'Invalid email or password');

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'sales@packsmartsolutions.com', password: BOOTSTRAP_PASSWORD }
  });
  assert.equal(login.response.status, 200);
  assert.match(login.setCookie, /HttpOnly/);
  assert.match(login.setCookie, /SameSite=Strict/);
  assert.equal(login.payload.user.passwordChangeRequired, true);
  let cookie = cookieValue(login.setCookie);
  let csrf = login.payload.csrf;

  const session = await request('/api/auth/session', { cookie });
  assert.equal(session.response.status, 200);
  assert.equal(session.payload.workspace.id, 'packsmart-solutions');

  const csrfFailure = await request('/api/economics', {
    method: 'PUT',
    cookie,
    body: { sku: 'BP1-50', economics: { landed: 1 } }
  });
  assert.equal(csrfFailure.response.status, 403);

  const protectedBootstrap = await request('/api/bootstrap', { cookie });
  assert.equal(protectedBootstrap.response.status, 403);
  assert.equal(protectedBootstrap.payload.code, 'PASSWORD_CHANGE_REQUIRED');
  const changed = await request('/api/auth/change-password', {
    method: 'POST',
    cookie,
    csrf,
    body: { newPassword: OWNER_PASSWORD }
  });
  assert.equal(changed.response.status, 200);
  cookie = cookieValue(changed.setCookie);
  csrf = changed.payload.csrf;

  const emptyBootstrap = await request('/api/bootstrap', { cookie });
  assert.equal(emptyBootstrap.payload.products.length, 0, 'dashboard loading never imports data implicitly');
  const firstSync = await request('/api/integrations/shopify/sync', { method: 'POST', cookie, csrf, body: {} });
  assert.equal(firstSync.response.status, 200);
  const bootstrap = await request('/api/bootstrap', { cookie });
  assert.equal(bootstrap.response.status, 200);
  assert.equal(bootstrap.payload.products.length, 15);
  assert.equal(bootstrap.payload.storage, 'file');
  assert.equal(bootstrap.payload.integrations.some(item => item.id === 'meta'), true);
  assert.equal(bootstrap.payload.suppliers.some(item => item.name === 'Europlast'), true);

  const originalSave = server.packsmart.store.save.bind(server.packsmart.store);
  let redundantBootstrapSaves = 0;
  server.packsmart.store.save = async (...args) => {
    redundantBootstrapSaves += 1;
    return originalSave(...args);
  };
  const repeatedBootstrap = await request('/api/bootstrap', { cookie });
  assert.equal(repeatedBootstrap.response.status, 200);
  assert.equal(redundantBootstrapSaves, 0, 'an unchanged read-only bootstrap must not rewrite persistence');
  const graph = await request('/api/business-graph', { cookie });
  assert.equal(graph.response.status, 200);
  assert.equal(graph.payload.workspaceId, 'packsmart-solutions');
  assert.equal(graph.payload.mode, 'summary');
  assert.equal(graph.payload.nodes, undefined, 'summary does not ship entity rows');
  const detailedGraph = await request('/api/business-graph?detail=true&nodeLimit=999999', { cookie });
  assert.equal(detailedGraph.response.status, 200);
  assert.ok(detailedGraph.payload.nodes.length <= 200, 'caller cannot expand server limits');
  assert.ok(detailedGraph.payload.edges.length <= 400);
  for (const result of [graph.payload, detailedGraph.payload]) {
    assert.equal(result.summary.verifiedOutcomeRecords, 0);
    assert.equal(typeof result.summary.recordedOutcomeRecords, 'number');
    assert.equal(result.outcomeCoverage.publicationProofAvailable, false);
    assert.equal(result.outcomeCoverage.complete, false);
    assert.equal(result.outcomeCoverage.unavailableReason, 'COMMITTED_OUTCOME_SNAPSHOT_NOT_SUPPLIED');
  }
  assert.equal(redundantBootstrapSaves, 0, 'graph reads must never write persistence');
  assert.equal(JSON.stringify(detailedGraph.payload).includes('passwordHash'), false);
  server.packsmart.store.save = originalSave;

  const economics = await request('/api/economics', {
    method: 'PUT',
    cookie,
    csrf,
    body: { sku: 'BP1-50', economics: { landed: 2.1, packing: 0.2, delivery: 3.1, channelFee: 0.3 } }
  });
  assert.equal(economics.response.status, 200);
  assert.equal(economics.payload.economics.landed, 2.1);

  const refreshedBrief = await request('/api/bootstrap', { cookie });
  assert.equal(refreshedBrief.response.status, 200);
  assert.notEqual(refreshedBrief.payload.brief.id, bootstrap.payload.brief.id, 'the daily brief must refresh when its source data changes');
  assert.match(refreshedBrief.payload.brief.sourceSignature, /^[a-f0-9]{32}$/);

  const supplier = await request('/api/suppliers', {
    method: 'POST', cookie, csrf,
    body: { name: 'Test Packaging Supplier', notes: 'Workspace-specific test supplier' }
  });
  assert.equal(supplier.response.status, 201);
  assert.equal(supplier.payload.supplier.name, 'Test Packaging Supplier');

  const advertising = await request('/api/advertising-costs', {
    method: 'POST', cookie, csrf,
    body: { channel: 'meta', spend: 12.5, attributableRevenue: 40, date: new Date().toISOString() }
  });
  assert.equal(advertising.response.status, 201);
  assert.equal(advertising.payload.record.spend, 12.5);

  const accounting = await request('/api/reports/accounting.csv', { cookie });
  assert.equal(accounting.response.status, 200);
  assert.match(accounting.response.headers.get('content-type'), /text\/csv/);
  assert.match(String(accounting.payload), /operating_contribution/);

  const approval = await request('/api/actions', {
    method: 'POST',
    cookie,
    csrf,
    body: {
      type: 'supplier_order',
      action: 'Order one launch carton',
      reason: 'Prevent launch stockout',
      financialImpact: 95,
      expectedBenefit: 'Keep core SKU available',
      risk: 'Cash tied up in stock',
      source: 'test-suite'
    }
  });
  assert.equal(approval.response.status, 202);
  assert.equal(approval.payload.executedExternally, false);
  assert.equal(approval.payload.approval.status, 'pending');

  const decision = await request('/api/approvals/' + approval.payload.approval.id + '/decision', {
    method: 'POST',
    cookie,
    csrf,
    body: { decision: 'approved', note: 'Approved for later executor test' }
  });
  assert.equal(decision.response.status, 200);
  assert.equal(decision.payload.approval.status, 'approved');
  assert.equal(decision.payload.executedExternally, false);

  const shopifySecret = 'shopify-client-secret-value-test-only';
  const missingShopifySecret = await request('/api/connections', {
    method: 'POST', cookie, csrf,
    body: { provider: 'shopify', credentials: { storeDomain: 'wavtzm-vy.myshopify.com', clientId: 'valid-client-id' } }
  });
  assert.equal(missingShopifySecret.response.status, 400);
  assert.equal(missingShopifySecret.payload.code, 'SHOPIFY_CLIENT_SECRET_REQUIRED');

  const ambiguousShopifyAuth = await request('/api/connections', {
    method: 'POST', cookie, csrf,
    body: { provider: 'shopify', credentials: { storeDomain: 'wavtzm-vy.myshopify.com', accessToken: 'shpat_valid-test-token', clientId: 'valid-client-id', clientSecret: shopifySecret } }
  });
  assert.equal(ambiguousShopifyAuth.response.status, 400);
  assert.equal(ambiguousShopifyAuth.payload.code, 'SHOPIFY_AUTH_METHOD_AMBIGUOUS');

  const shopifyConnection = await request('/api/connections', {
    method: 'POST', cookie, csrf,
    body: {
      provider: 'shopify',
      capabilities: ['write_products', 'write_inventory'],
      credentials: {
        storeDomain: 'wavtzm-vy.myshopify.com',
        clientId: 'shopify-client-id-test',
        clientSecret: shopifySecret
      }
    }
  });
  assert.equal(shopifyConnection.response.status, 200);
  assert.deepEqual(shopifyConnection.payload.connection.capabilities, ['catalogue', 'inventory', 'orders']);
  assert.equal(JSON.stringify(shopifyConnection.payload).includes(shopifySecret), false);
  assert.equal(JSON.stringify(shopifyConnection.payload).includes('shopify-client-id-test'), false);

  const publicConnections = await request('/api/connections', { cookie });
  assert.equal(publicConnections.response.status, 200);
  assert.equal(JSON.stringify(publicConnections.payload).includes(shopifySecret), false);
  assert.equal(JSON.stringify(publicConnections.payload).includes('shopify-client-id-test'), false);

  const ebaySecret = 'existing-ebay-manager-token-test-only';
  const ebayConnection = await request('/api/connections', {
    method: 'POST', cookie, csrf,
    body: {
      provider: 'ebay',
      capabilities: ['create_listing', 'change_price'],
      credentials: {
        baseUrl: 'https://existing-ebay-manager.example.test/path-is-normalized',
        expectedAccount: 'packsmartsolutions20',
        apiToken: ebaySecret
      }
    }
  });
  assert.equal(ebayConnection.response.status, 200);
  assert.deepEqual(ebayConnection.payload.connection.capabilities, ['status', 'listings', 'drafts', 'orders', 'fees', 'promotions']);
  assert.equal(JSON.stringify(ebayConnection.payload).includes(ebaySecret), false);
  assert.equal(JSON.stringify(ebayConnection.payload).includes('existing-ebay-manager.example.test'), false);

  const unsupportedConnection = await request('/api/connections', {
    method: 'POST', cookie, csrf,
    body: { provider: 'meta', credentials: { token: 'must-not-be-stored-without-an-adapter' } }
  });
  assert.equal(unsupportedConnection.response.status, 400);

  const persistedWithConnection = await server.packsmart.store.get('packsmart-solutions');
  const persistedShopify = persistedWithConnection.connections.find(item => item.provider === 'shopify');
  assert.equal(persistedShopify.encryptedCredentials.includes(shopifySecret), false);
  assert.deepEqual(decryptCredentials(persistedShopify.encryptedCredentials, 'server-integration-credential-key-more-than-thirty-two-characters'), {
    storeDomain: 'wavtzm-vy.myshopify.com',
    clientId: 'shopify-client-id-test',
    clientSecret: shopifySecret
  });

  const accessToken = 'shpat_test-access-token-value-never-returned';
  const tokenConnection = await request('/api/connections', {
    method: 'POST', cookie, csrf,
    body: { provider: 'shopify', credentials: { storeDomain: 'https://wavtzm-vy.myshopify.com/', accessToken } }
  });
  assert.equal(tokenConnection.response.status, 200);
  assert.equal(JSON.stringify(tokenConnection.payload).includes(accessToken), false);
  const persistedWithToken = await server.packsmart.store.get('packsmart-solutions');
  const persistedTokenConnection = persistedWithToken.connections.find(item => item.provider === 'shopify');
  assert.deepEqual(decryptCredentials(persistedTokenConnection.encryptedCredentials, 'server-integration-credential-key-more-than-thirty-two-characters'), {
    storeDomain: 'wavtzm-vy.myshopify.com', accessToken
  });
  const persistedEbay = persistedWithConnection.connections.find(item => item.provider === 'ebay');
  assert.equal(persistedEbay.encryptedCredentials.includes(ebaySecret), false);
  assert.deepEqual(decryptCredentials(persistedEbay.encryptedCredentials, 'server-integration-credential-key-more-than-thirty-two-characters'), {
    baseUrl: 'https://existing-ebay-manager.example.test',
    expectedAccount: 'packsmartsolutions20',
    apiToken: ebaySecret
  });



  const staleSession = await request('/api/auth/session', { cookie: cookieValue(login.setCookie) });
  assert.equal(staleSession.response.status, 401);

  const oldPassword = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'sales@packsmartsolutions.com', password: BOOTSTRAP_PASSWORD }
  });
  assert.equal(oldPassword.response.status, 401);
  const newPassword = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'sales@packsmartsolutions.com', password: OWNER_PASSWORD }
  });
  assert.equal(newPassword.response.status, 200);

  const betaState = seedWorkspaceState({}, {
    workspaceId: 'beta-workspace',
    name: 'Beta Ltd',
    slug: 'beta-workspace',
    email: 'beta@example.test',
    passwordHash: null
  });
  betaState.users[0].passwordChangeRequired = false;
  await server.packsmart.store.save('beta-workspace', betaState);
  const betaUser = betaState.users[0];
  const betaToken = createSessionToken({
    userId: betaUser.id,
    workspaceId: 'beta-workspace',
    email: betaUser.email,
    role: betaUser.role,
    sessionVersion: betaUser.sessionVersion
  }, SESSION_SECRET);
  const betaCookie = cookieValue(sessionCookie(betaToken, { secure: false }));
  const isolated = await request('/api/bootstrap?workspaceId=packsmart-solutions', { cookie: betaCookie });
  assert.equal(isolated.response.status, 200);
  assert.equal(isolated.payload.workspace.id, 'beta-workspace');
  assert.notEqual(isolated.payload.workspace.id, 'packsmart-solutions');
  const isolatedGraph = await request('/api/business-graph?workspaceId=packsmart-solutions&detail=true', { cookie: betaCookie });
  assert.equal(isolatedGraph.response.status, 200);
  assert.equal(isolatedGraph.payload.workspaceId, 'beta-workspace');
  assert.equal(JSON.stringify(isolatedGraph.payload).includes('packsmart-solutions'), false, 'graph tenant comes only from authenticated session');


  const deniedFleet = await request('/api/operator/agent-ops', { cookie: betaCookie });
  assert.equal(deniedFleet.response.status, 403);
  assert.equal(deniedFleet.payload.code, 'PLATFORM_ADMIN_REQUIRED');

  const fleet = await request('/api/operator/agent-ops', { cookie });
  assert.equal(fleet.response.status, 200);
  assert.equal(fleet.payload.workspaces.some(item => item.workspaceId === 'beta-workspace'), true);
  assert.equal(JSON.stringify(fleet.payload).includes('passwordHash'), false);

  const fleetControl = await request('/api/operator/agent-ops/workspaces/beta-workspace', {
    method: 'PUT', cookie, csrf, body: { paused: true, maxConcurrentJobs: 3, dailyAiUnitLimit: 50 }
  });
  assert.equal(fleetControl.response.status, 200);
  assert.equal(fleetControl.payload.settings.paused, true);
  const betaAfterFleetControl = await server.packsmart.store.get('beta-workspace');
  assert.equal(betaAfterFleetControl.agentOps.paused, true);
  assert.equal(betaAfterFleetControl.agentOps.maxConcurrentJobs, 3);
  assert.equal(betaAfterFleetControl.agentOps.dailyAiUnitLimit, 50);

  const logout = await request('/api/auth/logout', {
    method: 'POST',
    cookie,
    csrf,
    body: {}
  });
  assert.equal(logout.response.status, 200);
  assert.match(logout.setCookie, /Max-Age=0/);
});

test('eBay read-only OAuth uses a one-time callback while preserving the existing Manager', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'packsmart-ops-ebay-oauth-test-'));
  const credentialsKey = 'server-integration-credential-key-more-than-thirty-two-characters';
  const managerSecret = 'existing-manager-secret-test-only';
  const refreshSecret = 'ebay-refresh-token-test-only';
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    const method = options.method || 'GET';
    calls.push({ href, method, body: String(options.body || '') });
    const json = payload => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    if (href === 'https://api.ebay.com/identity/v1/oauth2/token') {
      const form = new URLSearchParams(String(options.body || ''));
      if (form.get('grant_type') === 'authorization_code') {
        return json({
          access_token: 'initial-access-token-test-only',
          expires_in: 7200,
          refresh_token: refreshSecret,
          refresh_token_expires_in: 47304000
        });
      }
      return json({ access_token: 'refreshed-access-token-test-only', expires_in: 7200 });
    }
    if (href === 'https://apiz.ebay.com/commerce/identity/v1/user/') return json({ username: 'packsmartsolutions20' });
    if (href.includes('/sell/fulfillment/v1/order?')) return json({ total: 0, orders: [] });
    if (href.includes('/sell/inventory/v1/inventory_item?')) return json({ total: 0, inventoryItems: [] });
    if (href.includes('/sell/marketing/v1/ad_campaign?')) return json({ total: 0, campaigns: [] });
    throw new Error(`Unexpected eBay test request: ${method} ${href}`);
  };
  const server = createPacksmartServer({
    NODE_ENV: 'test',
    APP_PUBLIC_URL: 'http://localhost:8787',
    SAAS_STATE_FILE: path.join(directory, 'state.json'),
    PACKSMART_ADMIN_EMAIL: 'sales@packsmartsolutions.com',
    PACKSMART_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
    SESSION_SECRET,
    CREDENTIALS_KEY: credentialsKey,
    SHOPIFY_PUBLIC_SYNC_ENABLED: 'false',
    BETA_SIGNUPS_ENABLED: 'false',
    BILLING_CHECKOUT_ENABLED: 'false',
    EBAY_OAUTH_ENABLED: 'true',
    EBAY_CLIENT_ID: 'packsmart-client-id-test',
    EBAY_CLIENT_SECRET: 'packsmart-client-secret-test-only',
    EBAY_REDIRECT_URI_NAME: 'Packsmart-Ops-Read-Only-Test-RuName',
    EBAY_EXPECTED_ACCOUNT: 'packsmartsolutions20',
    EBAY_MARKETPLACE_ID: 'EBAY_GB'
  }, { fetchImpl });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const request = requestFactory(`http://127.0.0.1:${server.address().port}`);
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'sales@packsmartsolutions.com', password: BOOTSTRAP_PASSWORD }
  });
  assert.equal(login.response.status, 200);
  const setup = await request('/api/auth/change-password', { method: 'POST', cookie: cookieValue(login.setCookie), csrf: login.payload.csrf, body: { newPassword: OWNER_PASSWORD } });
  assert.equal(setup.response.status, 200);
  const cookie = cookieValue(setup.setCookie);
  const csrf = setup.payload.csrf;

  const manager = await request('/api/connections', {
    method: 'POST', cookie, csrf,
    body: {
      provider: 'ebay',
      credentials: {
        baseUrl: 'https://existing-ebay-manager.example.test',
        expectedAccount: 'packsmartsolutions20',
        apiToken: managerSecret
      }
    }
  });
  assert.equal(manager.response.status, 200);

  const started = await request('/api/integrations/ebay/oauth/start', { method: 'POST', cookie, csrf, body: {} });
  assert.equal(started.response.status, 200);
  assert.equal(started.payload.readOnly, true);
  assert.equal(started.payload.existingManagerPreserved, true);
  const authorizationUrl = new URL(started.payload.authorizationUrl);
  assert.equal(authorizationUrl.origin, 'https://auth.ebay.com');
  const oauthState = authorizationUrl.searchParams.get('state');
  assert.ok(oauthState);

  const forged = await request(`/api/integrations/ebay/oauth/callback?state=${encodeURIComponent(`${oauthState}x`)}&code=forged`, { redirect: 'manual' });
  assert.equal(forged.response.status, 400);

  const callback = await request(`/api/integrations/ebay/oauth/callback?state=${encodeURIComponent(oauthState)}&code=authorized-code`, { cookie: cookieValue(started.setCookie), redirect: 'manual' });
  assert.equal(callback.response.status, 303);
  assert.equal(callback.response.headers.get('location'), 'http://localhost:8787/?ebay=connected');
  assert.equal(String(callback.payload).includes(refreshSecret), false);

  // Customer redirect is immediate; the authorised read continues durably.
  for(let i=0;i<200;i++){const current=await server.packsmart.store.get('packsmart-solutions');if(current.audit.some(e=>e.type==='ebay_read_sync'))break;await new Promise(resolve=>setTimeout(resolve,5));}
  const persisted = await server.packsmart.store.get('packsmart-solutions');
  const managerConnection = persisted.connections.find(item => item.provider === 'ebay');
  const oauthConnection = persisted.connections.find(item => item.provider === 'ebay_oauth');
  assert.ok(managerConnection, 'the existing eBay Manager connection must remain stored');
  assert.ok(oauthConnection, 'the read-only connection must be stored separately');
  assert.equal(oauthConnection.encryptedCredentials.includes(refreshSecret), false);
  assert.equal(decryptCredentials(oauthConnection.encryptedCredentials, credentialsKey).refreshToken, refreshSecret);
  assert.equal(decryptCredentials(managerConnection.encryptedCredentials, credentialsKey).apiToken, managerSecret);
  assert.equal(persisted.oauthChallenges.length, 0, 'the callback challenge must be consumed exactly once');
  assert.equal(persisted.audit.some(event => event.type === 'ebay_oauth_connected'), true);
  assert.equal(persisted.audit.some(event => event.type === 'ebay_read_sync'), true);

  const replay = await request(`/api/integrations/ebay/oauth/callback?state=${encodeURIComponent(oauthState)}&code=replayed-code`, { redirect: 'manual' });
  assert.equal(replay.response.status, 400);
  const publicConnections = await request('/api/connections', { cookie });
  assert.equal(JSON.stringify(publicConnections.payload).includes(refreshSecret), false);
  assert.equal(JSON.stringify(publicConnections.payload).includes(managerSecret), false);
  assert.equal(calls.filter(call => call.href.includes('/sell/') || call.href.includes('/commerce/')).every(call => call.method === 'GET'), true);
});

test('one-time owner activation sets a private password without exposing the bootstrap secret', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'packsmart-ops-activation-test-'));
  const server = createPacksmartServer({
    NODE_ENV: 'test',
    APP_PUBLIC_URL: 'http://localhost:8787',
    SAAS_STATE_FILE: path.join(directory, 'state.json'),
    PACKSMART_ADMIN_EMAIL: 'sales@packsmartsolutions.com',
    PACKSMART_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
    OWNER_ACTIVATION_TOKEN: ACTIVATION_TOKEN,
    SESSION_SECRET,
    CREDENTIALS_KEY: 'server-integration-credential-key-more-than-thirty-two-characters',
    SHOPIFY_PUBLIC_SYNC_ENABLED: 'false',
    BETA_SIGNUPS_ENABLED: 'false',
    BILLING_CHECKOUT_ENABLED: 'false'
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = requestFactory(base);

  const invalid = await request('/api/auth/activate-owner', {
    method: 'POST',
    body: { token: 'wrong-token', newPassword: OWNER_PASSWORD }
  });
  assert.equal(invalid.response.status, 401);
  assert.equal(invalid.payload.code, 'ACTIVATION_INVALID');

  const weak = await request('/api/auth/activate-owner', {
    method: 'POST',
    body: { token: ACTIVATION_TOKEN, newPassword: 'too-weak' }
  });
  assert.equal(weak.response.status, 400);

  const activated = await request('/api/auth/activate-owner', {
    method: 'POST',
    body: { token: ACTIVATION_TOKEN, newPassword: OWNER_PASSWORD }
  });
  assert.equal(activated.response.status, 200);
  assert.equal(activated.payload.user.passwordChangeRequired, false);
  assert.match(activated.setCookie, /HttpOnly/);
  assert.match(activated.setCookie, /SameSite=Strict/);
  const cookie = cookieValue(activated.setCookie);

  const session = await request('/api/auth/session', { cookie });
  assert.equal(session.response.status, 200);
  assert.equal(session.payload.workspace.id, 'packsmart-solutions');

  const reused = await request('/api/auth/activate-owner', {
    method: 'POST',
    body: { token: ACTIVATION_TOKEN, newPassword: 'AnotherOwner!2026Password' }
  });
  assert.equal(reused.response.status, 409);
  assert.equal(reused.payload.code, 'ACTIVATION_USED');

  const bootstrapLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'sales@packsmartsolutions.com', password: BOOTSTRAP_PASSWORD }
  });
  assert.equal(bootstrapLogin.response.status, 401);
  const ownerLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'sales@packsmartsolutions.com', password: OWNER_PASSWORD }
  });
  assert.equal(ownerLogin.response.status, 200);

  const audit = await request('/api/audit', { cookie });
  assert.equal(audit.response.status, 200);
  assert.equal(audit.payload.events.some(event => event.type === 'owner_account_activated'), true);
});
