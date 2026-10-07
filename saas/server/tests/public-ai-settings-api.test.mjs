import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { AI_PRICING_UPDATED_AT } from '../lib/ai-economics.mjs';
import { operatorBriefPolicy, OPERATOR_BRIEF_ENDPOINT } from '../lib/operator-brief-policy.mjs';
import { legacyAiUsagePage, legacyAiUsageUnknown } from '../lib/legacy-ai-usage.mjs';

const privateMarker = 'synthetic-server-only-ai-settings';
const publicKeys = ['monthlyCostLimitUsd', 'pricingUpdatedAt', 'routingMode', 'updatedAt', 'updatedBy'];

function assertPublic(settings) {
  assert.deepEqual(Object.keys(settings).sort(), publicKeys);
  assert.equal(JSON.stringify(settings).includes(privateMarker), false);
  assert.ok(Object.values(settings).every(value => value === null || ['string', 'number'].includes(typeof value)));
  assert.ok(Buffer.byteLength(JSON.stringify(settings)) < 1024);
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-public-ai-settings-'));
  const stateFile = path.join(directory, 'state.json');
  const secret = 'public-ai-settings-test-session-secret-more-than-thirty-two-characters';
  let externalCalls = 0;
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, SAAS_STATE_FILE: stateFile,
    PACKSMART_ADMIN_EMAIL: 'sales@packsmartsolutions.com', SHOPIFY_PUBLIC_SYNC_ENABLED: 'false',
    BETA_SIGNUPS_ENABLED: 'false', BILLING_CHECKOUT_ENABLED: 'false' }, {
    schedulerEnabled: false, agentOpsEnabled: false,
    fetchImpl: async () => { externalCalls++; assert.fail('AI settings inspection/configuration must never call providers'); }
  });
  const { store } = server.packsmart, states = {};
  for (const workspaceId of ['packsmart-solutions', 'settings-alpha', 'settings-beta']) {
    const state = seedWorkspaceState({}, { workspaceId,
      email: workspaceId === 'packsmart-solutions' ? 'sales@packsmartsolutions.com' : `${workspaceId}@example.test`,
      passwordHash: 'synthetic-only' });
    for (const role of ['admin', 'member', 'viewer']) {
      state.users.push({ ...state.users[0], id: `${workspaceId}-${role}`, email: `${role}-${workspaceId}@example.test`, role });
    }
    state.aiEconomics = { routingMode: workspaceId === 'settings-alpha' ? 'quality' : 'economy',
      monthlyCostLimitUsd: workspaceId === 'settings-alpha' ? 0 : null, pricingUpdatedAt: AI_PRICING_UPDATED_AT,
      updatedAt: '2026-10-01T12:34:56.789Z', updatedBy: `${workspaceId}-owner`,
      governance: { version: 1, enabled: false, currency: 'USD', configuredAt: 1,
        providers: { openai: { enabled: false, accountId: privateMarker, credentials: { apiKey: privateMarker } } } },
      providerApiKey: privateMarker, futurePrivateConfiguration: { nested: [privateMarker] } };
    await store.save(workspaceId, state);
    states[workspaceId] = state;
  }
  const calls = { get: 0, listAgentJobs: 0, agentOpsUsage: 0, aiUsageSummary: 0, save: 0 };
  for (const method of Object.keys(calls)) {
    const original = store[method].bind(store);
    store[method] = async (...args) => { calls[method]++; return original(...args); };
  }
  for (const method of ['reserveProviderUsage', 'settleProviderUsage', 'recordAiUsage', 'enqueueAgentJob', 'claimAgentJobs']) {
    store[method] = async () => assert.fail(`AI settings routes must not call ${method}`);
  }
  server.packsmart.aiProvider.enhanceCommander = async () => assert.fail('settings routes must not execute AI work');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await server.packsmart.drain();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
    assert.equal(externalCalls, 0);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = (workspaceId = 'settings-alpha', role = 'owner', overrides = {}) => {
    const user = states[workspaceId].users.find(user => user.role === role);
    const token = createSessionToken({ userId: user.id, workspaceId, email: user.email, role,
      sessionVersion: user.sessionVersion, ...overrides }, secret);
    return { token, csrf: verifySessionToken(token, secret).csrf, userId: user.id };
  };
  const request = async (route, { method = 'GET', body, identity = auth(), csrf = true } = {}) => {
    const headers = {};
    if (identity) { headers.Cookie = `packsmart_session=${identity.token}`; if (csrf) headers['X-CSRF-Token'] = identity.csrf; }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    assert.equal(text.includes(privateMarker), false, 'no route response may expose synthetic private configuration');
    return { status: response.status, body: JSON.parse(text) };
  };
  return { server, store, states, stateFile, calls, auth, request };
}

test('authenticated agent-ops GET returns only public settings for every own-workspace role with unchanged reads', async t => {
  const { request, auth, calls, stateFile, store, states } = await fixture(t);
  const before = await fs.readFile(stateFile, 'utf8');
  for (const role of ['owner', 'admin', 'member', 'viewer']) {
    const countsBefore = { ...calls };
    const result = await request('/api/agent-ops?workspaceId=settings-beta', { identity: auth('settings-alpha', role) });
    assert.equal(result.status, 200);
    assertPublic(result.body.aiSettings);
    assert.equal(result.body.aiSettings.routingMode, 'quality');
    assert.equal(result.body.aiSettings.monthlyCostLimitUsd, 0);
    assert.equal(result.body.aiSettings.updatedBy, 'settings-alpha-owner', 'query does not select another tenant');
    for (const method of ['get', 'listAgentJobs', 'agentOpsUsage', 'aiUsageSummary']) assert.equal(calls[method] - countsBefore[method], 1, method);
    assert.equal(calls.save, 0);
  }
  const beta = await request('/api/agent-ops', { identity: auth('settings-beta', 'viewer') });
  assert.equal(beta.status, 200);
  assertPublic(beta.body.aiSettings);
  assert.equal(beta.body.aiSettings.routingMode, 'economy');
  assert.equal(beta.body.aiSettings.monthlyCostLimitUsd, null);
  assert.equal((await request('/api/agent-ops', { identity: null })).status, 401);
  assert.equal((await request('/api/agent-ops', { identity: auth('settings-alpha', 'owner', { sessionVersion: 2 }) })).status, 401);
  assert.equal(await fs.readFile(stateFile, 'utf8'), before, 'GETs never persist or narrow the internal state');
  assert.deepEqual((await store.get('settings-alpha')).aiEconomics, states['settings-alpha'].aiEconomics);
});

test('authenticated GET drops nested or oversized metadata without rewriting stored configuration', async t => {
  const { request, store, stateFile } = await fixture(t);
  for (const invalid of [{ nested: { apiKey: privateMarker } }, [privateMarker], `${privateMarker}${'x'.repeat(5000)}`]) {
    const state = await store.get('settings-alpha');
    Object.assign(state.aiEconomics, { pricingUpdatedAt: invalid, updatedAt: invalid, updatedBy: invalid });
    await store.save('settings-alpha', state);
    const before = await fs.readFile(stateFile, 'utf8');
    const result = await request('/api/agent-ops');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.aiSettings, { routingMode: 'quality', monthlyCostLimitUsd: 0, pricingUpdatedAt: AI_PRICING_UPDATED_AT });
    assert.equal(await fs.readFile(stateFile, 'utf8'), before);
    assert.deepEqual((await store.get('settings-alpha')).aiEconomics.updatedBy, invalid);
  }
});

test('own-workspace settings PUT preserves role, CSRF, input validation and private governance', async t => {
  const { request, auth, store, states, calls, stateFile } = await fixture(t);
  const route = '/api/agent-ops', body = { routingMode: 'balanced', monthlyCostLimitUsd: 12.5 };
  const before = await fs.readFile(stateFile, 'utf8');
  assert.equal((await request(route, { method: 'PUT', body, identity: null })).status, 401);
  const csrf = await request(route, { method: 'PUT', body, csrf: false });
  assert.equal(csrf.status, 403); assert.equal(csrf.body.code, 'CSRF_INVALID');
  for (const role of ['member', 'viewer']) {
    const denied = await request(route, { method: 'PUT', body, identity: auth('settings-alpha', role) });
    assert.equal(denied.status, 403); assert.equal(denied.body.code, 'ROLE_DENIED');
  }
  for (const input of [{ routingMode: 'invalid' }, { monthlyCostLimitUsd: -1 }, { monthlyCostLimitUsd: 1000001 }]) {
    assert.equal((await request(route, { method: 'PUT', body: input })).status, 400);
  }
  assert.equal(calls.save, 0);
  assert.equal(await fs.readFile(stateFile, 'utf8'), before);
  for (const [role, limit] of [['owner', 12.5], ['admin', 0], ['owner', null]]) {
    const identity = auth('settings-alpha', role), beforeSaves = calls.save;
    const result = await request(`${route}?workspaceId=settings-beta`, { method: 'PUT', identity,
      body: { ...body, monthlyCostLimitUsd: limit, workspaceId: 'settings-beta', governance: { enabled: true }, providerApiKey: 'ignored-input' } });
    assert.equal(result.status, 200);
    assertPublic(result.body.settings.aiEconomics);
    assert.equal(result.body.settings.aiEconomics.monthlyCostLimitUsd, limit);
    assert.equal(result.body.settings.aiEconomics.routingMode, 'balanced');
    assert.equal(result.body.settings.aiEconomics.updatedBy, identity.userId);
    assert.equal(calls.save - beforeSaves, 1, 'each authorized update keeps the existing single save');
    const persisted = await store.get('settings-alpha');
    assert.deepEqual(persisted.aiEconomics.governance, states['settings-alpha'].aiEconomics.governance);
    assert.equal(persisted.aiEconomics.providerApiKey, privateMarker);
    assert.deepEqual(persisted.aiEconomics.futurePrivateConfiguration, states['settings-alpha'].aiEconomics.futurePrivateConfiguration);
    assert.deepEqual(operatorBriefPolicy({ state: persisted, workspaceId: 'settings-alpha', model: 'gpt-5.6-luna',
      outputTokens: 500, endpoint: OPERATOR_BRIEF_ENDPOINT, now: Date.now() }), { allowed: false, reason: 'AI_GOVERNANCE_NOT_CONFIGURED' });
    assert.deepEqual((await store.get('settings-beta')).aiEconomics, states['settings-beta'].aiEconomics);
  }
});

test('operator settings PUT and fleet GET retain platform-owner isolation and public-only AI settings', async t => {
  const { request, auth, store, states, calls } = await fixture(t);
  const route = '/api/operator/agent-ops/workspaces/settings-beta';
  const body = { routingMode: 'quality', monthlyCostLimitUsd: 0, paused: true };
  assert.equal((await request(route, { method: 'PUT', body, identity: null })).status, 401);
  assert.equal((await request('/api/operator/agent-ops', { identity: null })).status, 401);
  for (const workspace of ['settings-alpha', 'settings-beta', 'packsmart-solutions']) {
    for (const role of ['owner', 'admin', 'member', 'viewer']) {
      if (workspace === 'packsmart-solutions' && role === 'owner') continue;
      const identity = auth(workspace, role);
      const put = await request(route, { method: 'PUT', body, identity });
      assert.equal(put.status, 403); assert.equal(put.body.code, role === 'viewer' ? 'ROLE_DENIED' : 'PLATFORM_ADMIN_REQUIRED');
      const get = await request('/api/operator/agent-ops', { identity });
      assert.equal(get.status, 403); assert.equal(get.body.code, 'PLATFORM_ADMIN_REQUIRED');
    }
  }
  const platform = auth('packsmart-solutions');
  const deniedCsrf = await request(route, { method: 'PUT', body, identity: platform, csrf: false });
  assert.equal(deniedCsrf.status, 403); assert.equal(deniedCsrf.body.code, 'CSRF_INVALID');
  assert.equal(calls.save, 0);
  const result = await request(route, { method: 'PUT', body, identity: platform });
  assert.equal(result.status, 200);
  assertPublic(result.body.settings.aiEconomics);
  assert.equal(result.body.settings.aiEconomics.routingMode, 'quality');
  assert.equal(result.body.settings.aiEconomics.monthlyCostLimitUsd, 0);
  assert.equal(result.body.settings.aiEconomics.updatedBy, platform.userId);
  assert.equal(result.body.settings.paused, true);
  assert.equal(calls.save, 1);
  const beta = await store.get('settings-beta');
  assert.deepEqual(beta.aiEconomics.governance, states['settings-beta'].aiEconomics.governance);
  assert.equal(beta.aiEconomics.providerApiKey, privateMarker);
  for (const workspace of ['settings-alpha', 'packsmart-solutions']) {
    assert.deepEqual((await store.get(workspace)).aiEconomics, states[workspace].aiEconomics);
  }
  const fleet = await request('/api/operator/agent-ops', { identity: platform });
  assert.equal(fleet.status, 200);
  assert.equal(fleet.body.workspaces.length, 3);
  assert.equal(fleet.body.workspaces.find(workspace => workspace.workspaceId === 'settings-beta').monthlyAiCostLimitUsd, 0);
  assert.equal(fleet.body.workspaces.find(workspace => workspace.workspaceId === 'packsmart-solutions').monthlyAiCostLimitUsd, null);
  for (const workspace of fleet.body.workspaces) {
    assert.equal(Object.hasOwn(workspace, 'aiSettings'), false);
    assert.equal(Object.hasOwn(workspace, 'aiEconomics'), false);
    assert.equal(Object.hasOwn(workspace, 'governance'), false);
  }
  assert.equal(calls.save, 1, 'fleet inspection adds no writes');
});

test('agent-ops usage preserves completeness and own-tenant month scope for every permitted read role', async t => {
  const { request, auth, store, stateFile } = await fixture(t);
  const before = await fs.readFile(stateFile, 'utf8'), calls = [];
  let mode = 'complete';
  store.aiUsageSummary = async (workspaceId, startAt, endAt) => {
    calls.push({ workspaceId, startAt, endAt });
    if (mode === 'throw') throw new Error(privateMarker);
    if (mode === 'partial') return legacyAiUsageUnknown(workspaceId, startAt, endAt, 'AI_USAGE_TRUNCATED', 'partial');
    if (mode === 'malformed') return { status: 'complete', totals: { requests: 0, estimatedCostUsd: 0 }, secret: privateMarker };
    const summary = legacyAiUsagePage({ data: [], contentRange: '*/0' }, workspaceId, startAt, endAt);
    return mode === 'foreign' ? { ...summary, workspaceId: 'settings-beta' } : { ...summary, privateInternal: privateMarker };
  };
  const instant = new Date(), start = new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), 1)).toISOString();
  const end = new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth() + 1, 1)).toISOString();
  for (const role of ['owner', 'admin', 'member', 'viewer']) {
    for (mode of ['complete', 'partial', 'throw', 'malformed', 'foreign']) {
      const priorCalls = calls.length;
      const result = await request('/api/agent-ops?workspaceId=settings-beta&startAt=1900-01-01&endAt=9999-01-01', { identity: auth('settings-alpha', role) });
      assert.equal(result.status, 200); assertPublic(result.body.aiSettings);
      assert.equal(calls.length - priorCalls, 1); assert.deepEqual(calls.at(-1), { workspaceId: 'settings-alpha', startAt: start, endAt: end });
      const usage = result.body.aiUsageMonth;
      assert.equal(usage.workspaceId, 'settings-alpha'); assert.equal(usage.startAt, start); assert.equal(usage.endAt, end);
      assert.equal(usage.status, mode === 'complete' ? 'complete' : mode === 'partial' ? 'partial' : 'unavailable');
      if (mode === 'complete') { assert.equal(usage.totals.requests, 0); assert.equal(usage.totals.estimatedCostUsd, 0); }
      else assert.equal(usage.totals, null);
      assert.deepEqual(usage.byModel, []);
    }
  }
  const beforeDenied = calls.length;
  assert.equal((await request('/api/agent-ops', { identity: null })).status, 401);
  for (const role of ['owner', 'admin', 'member', 'viewer']) assert.equal((await request('/api/operator/agent-ops', { identity: auth('settings-alpha', role) })).status, 403);
  assert.equal(calls.length, beforeDenied);
  assert.equal(await fs.readFile(stateFile, 'utf8'), before);
});

test('operator fleet usage remains unknown for mixed evidence and cannot expose private store fields', async t => {
  const { request, auth, store, stateFile } = await fixture(t);
  const before = await fs.readFile(stateFile, 'utf8'), calls = [];
  store.aiUsageSummary = async (workspaceId, startAt, endAt) => {
    calls.push(workspaceId);
    if (workspaceId === 'settings-beta') throw new Error(privateMarker);
    return { ...legacyAiUsagePage({ data: [], contentRange: '*/0' }, workspaceId, startAt, endAt), credentials: privateMarker };
  };
  const result = await request('/api/operator/agent-ops?workspaceId=settings-beta', { identity: auth('packsmart-solutions') });
  assert.equal(result.status, 200); assert.equal(calls.length, 3);
  assert.equal(result.body.totals.aiUsageMonthStatus, 'partial');
  assert.equal(result.body.totals.aiUsageMonthCompleteWorkspaces, 2);
  assert.equal(result.body.totals.aiUsageMonthUnavailableWorkspaces, 1);
  assert.equal(result.body.totals.aiUsageMonthScope, 'returned_workspaces');
  assert.equal(result.body.totals.aiEstimatedCostUsdMonth, null); assert.equal(result.body.totals.aiRequestsMonth, null);
  const beta = result.body.workspaces.find(item => item.workspaceId === 'settings-beta');
  assert.equal(beta.aiUsageMonth.status, 'unavailable'); assert.equal(beta.aiUsageMonth.totals, null);
  assert.equal(await fs.readFile(stateFile, 'utf8'), before);
});
