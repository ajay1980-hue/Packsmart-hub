import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';

const SECRET = 'compatibility-reader-synthetic-session-secret-long-enough';
const CANARY = 'PRIVATE_RETAINED_ENVELOPE_CANARY';
const privateValue = { nested: { source: CANARY } };
const ROLES = ['owner', 'admin', 'member', 'viewer'];
const retained = state => JSON.stringify({ writes: state.connectionWrites, approvals: state.approvals });
const hidden = value => assert.equal(JSON.stringify(value).includes(CANARY), false);
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-reader-projection-'));
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: SECRET, CREDENTIALS_KEY: SECRET,
    SAAS_STATE_FILE: path.join(dir, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' },
  { schedulerEnabled: false, agentOpsEnabled: false, fetchImpl: async () => assert.fail('Reader checks must not call a provider') });
  const tokens = {};
  for (const tenant of ['privacy', 'foreign']) {
    const state = seedWorkspaceState({}, { workspaceId: tenant, email: `${tenant}@example.test`, passwordHash: 'synthetic-only' });
    state.users = ROLES.map(role => ({ ...state.users[0], id: `${tenant}-${role}`, email: `${tenant}-${role}@example.test`, role, passwordChangeRequired: false }));
    for (const user of state.users) tokens[user.id] = createSessionToken({ workspaceId: tenant, userId: user.id, email: user.email, role: user.role, sessionVersion: 1 }, SECRET);
    if (tenant === 'privacy') {
      state.connectionWrites = [{ id: 'write_retained', requestId: 'retained_request_001', provider: 'shopify',
        input: { operation: 'product_content', productId: 'gid://shopify/Product/71', title: 'Exact café title', description: 'Line 1\n第二行', futurePrivate: privateValue },
        digest: 'public-input-digest', connectionId: 'public-connection', account: 'public.myshopify.com',
        requestedBy: 'privacy-owner', approvalId: 'approval_retained', requiresApproval: true, status: 'completed',
        createdAt: '2026-10-01T00:00:00.000Z', completedAt: '2026-10-02T00:00:00.000Z',
        result: { externalId: 'gid://shopify/Product/71', confirmed: true, recovery: 'Public result detail', futurePrivate: privateValue },
        objectivePolicyProposal: { schema: 'future-unsupported-policy', source: privateValue },
        dispatchClaim: privateValue, providerState: privateValue, recordedActionContext: privateValue, futurePrivate: privateValue }];
      state.approvals = [{ id: 'approval_retained', type: 'customer_facing_publish', action: 'Public reviewed action', reason: 'Public objective reference and narrative',
        expectedBenefit: 'Public benefit', risk: 'Public risk', source: 'objective-content', requestedBy: 'privacy-owner', revision: 1,
        status: 'pending', createdAt: '2026-10-01T00:00:00.000Z', executedExternally: false, financialImpact: null,
        payload: { connectionWriteId: 'write_retained', digest: 'public-input-digest', opportunityId: 'opportunity_retained', marketingCampaignId: 'campaign_retained',
          objectivePolicyProposalDigest: CANARY, futurePrivate: privateValue },
        evidence: [{ type: 'reference', id: 'public-evidence', detail: 'Public evidence narrative', futurePrivate: privateValue }],
        history: [{ revision: 1, status: 'pending', note: 'Public previous note', futurePrivate: privateValue,
          evidence: [{ type: 'reference', id: 'public-history', detail: 'Public historical evidence', source: privateValue }] }],
        stableApproval: privateValue, futurePrivate: privateValue }];
      state.aiEconomics = { routingMode: 'quality', monthlyCostLimitUsd: 0, pricingUpdatedAt: '2026-09-27', governance: privateValue, futurePrivate: privateValue };
      state.opportunities = [{ id: 'opportunity_retained', status: 'requires_approval', present: true, title: 'Public opportunity' }];
      state.marketing = { campaigns: [{ id: 'campaign_retained', product: { title: 'Public product' }, status: 'awaiting_approval', publish: { approvalId: 'approval_retained' } }] };
    }
    await server.packsmart.store.save(tenant, state);
  }
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await server.packsmart.drain(); await fs.rm(dir, { recursive: true, force: true }); });
  const request = async (route, { role = 'owner', tenant = 'privacy', method = 'GET', body } = {}) => {
    const token = tokens[`${tenant}-${role}`];
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method,
      headers: { Cookie: `packsmart_session=${token}`, 'Content-Type': 'application/json', 'X-CSRF-Token': verifySessionToken(token, SECRET).csrf },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { request, store: server.packsmart.store, integrations: server.packsmart.integrations };
}

test('all admitted roles read retained records without private envelopes or stored record changes', async t => {
  const f = await fixture(t), before = retained(await f.store.get('privacy'));
  for (const role of ROLES) {
    for (const route of ['/api/bootstrap', '/api/connection-centre', '/api/approvals', '/api/agent-ops']) {
      const response = await f.request(route, { role }); assert.equal(response.status, 200, `${role} ${route}`); hidden(response.body);
      const writes = response.body.connectionWrites || response.body.writes;
      if (writes) {
        assert.equal(writes[0].id, 'write_retained'); assert.equal(writes[0].digest, 'public-input-digest');
        assert.deepEqual(writes[0].input, { operation: 'product_content', productId: 'gid://shopify/Product/71', title: 'Exact café title', description: 'Line 1\n第二行' });
        assert.equal(writes[0].result.externalId, 'gid://shopify/Product/71');
      }
      if (response.body.approvals) {
        const approval = response.body.approvals[0]; assert.equal(approval.reason, 'Public objective reference and narrative');
        assert.equal(approval.payload.digest, 'public-input-digest'); assert.equal(approval.evidence[0].detail, 'Public evidence narrative');
        assert.equal(approval.history[0].evidence[0].detail, 'Public historical evidence');
      }
      const foreign = await f.request(route, { role, tenant: 'foreign' }); assert.equal(foreign.status, 200); hidden(foreign.body);
      assert.equal(JSON.stringify(foreign.body).includes('write_retained'), false);
    }
  }
  assert.equal(retained(await f.store.get('privacy')), before);
});

test('reused approvals and already completed writes use the same privacy projection', async t => {
  const f = await fixture(t), before = retained(await f.store.get('privacy'));
  for (const route of ['/api/opportunities/opportunity_retained/approval', '/api/marketing/campaigns/campaign_retained/request-publish-approval']) {
    const response = await f.request(route, { method: 'POST', body: {} }); assert.equal(response.status, 202); hidden(response.body);
    assert.equal(response.body.approval.id, 'approval_retained');
  }
  const completed = await f.request('/api/connection-writes/write_retained/execute', { method: 'POST', body: {} });
  assert.equal(completed.status, 200); hidden(completed.body); assert.equal(completed.body.executedExternally, true);
  assert.equal(retained(await f.store.get('privacy')), before);
  for (const role of ROLES.slice(1)) assert.equal((await f.request('/api/connection-writes/write_retained/execute', { role, method: 'POST', body: {} })).status, 403);
});

test('routine action, edit, decision and AI settings responses preserve public fields and retained private data', async t => {
  const f = await fixture(t);
  const created = await f.request('/api/actions', { method: 'POST', body: { type: 'customer_facing_publish', action: 'Public proposed action',
    reason: 'Public reason', expectedBenefit: 'Public benefit', risk: 'Public risk', payload: { opportunityId: 'public-navigation', source: privateValue } } });
  assert.equal(created.status, 202); hidden(created.body);
  const id = created.body.approval.id;
  const state = await f.store.get('privacy'), approval = state.approvals.find(item => item.id === id);
  approval.futurePrivate = privateValue; approval.history.push({ note: 'Public history note', futurePrivate: privateValue });
  await f.store.save('privacy', state);
  const payload = structuredClone(approval.payload);
  const modified = await f.request(`/api/approvals/${id}`, { method: 'PATCH', body: { revision: 1, action: 'Public changed action' } });
  assert.equal(modified.status, 200); hidden(modified.body); assert.equal(modified.body.approval.action, 'Public changed action');
  const decided = await f.request(`/api/approvals/${id}/decision`, { method: 'POST', body: { revision: 2, decision: 'approved', note: 'Public decision note' } });
  assert.equal(decided.status, 200); hidden(decided.body); assert.equal(decided.body.approval.decisionNote, 'Public decision note');
  const settings = await f.request('/api/agent-ops', { method: 'PUT', body: { routingMode: 'economy', monthlyCostLimitUsd: 2 } });
  assert.equal(settings.status, 200); hidden(settings.body); assert.equal(settings.body.settings.aiEconomics.routingMode, 'economy');
  const after = await f.store.get('privacy'), saved = after.approvals.find(item => item.id === id);
  assert.deepEqual(saved.payload, payload); assert.deepEqual(saved.futurePrivate, privateValue);
  assert.deepEqual(saved.history[0].futurePrivate, privateValue); assert.deepEqual(after.aiEconomics.governance, privateValue);
});

test('newly produced eBay cooldown survives route failure replacement and blocks the next read', async t => {
  const f = await fixture(t), state = await f.store.get('privacy');
  state.integrationStatus.ebay = { status: 'connected', retryAt: '2000-01-01T00:00:00.000Z', retryReviewRequired: false };
  await f.store.save('privacy', state);
  let calls = 0;
  f.integrations.syncProvider = async () => { calls++; throw Object.assign(new Error('Synthetic provider throttle'), { code: 'EBAY_RATE_LIMIT', upstreamStatus: 429, retryAfterMs: 60000 }); };
  const first = await f.request('/api/integrations/ebay/sync', { method: 'POST', body: {} });
  assert.equal(first.status, 422); assert.equal(first.body.code, 'EBAY_RATE_LIMIT');
  const saved = await f.store.get('privacy');
  assert.ok(Date.parse(saved.integrationStatus.ebay.retryAt) > Date.now());
  assert.equal(saved.integrationStatus.ebay.retryReviewRequired, false);
  const preserved = JSON.stringify({ status: saved.integrationStatus.ebay, doctor: saved.connectionDoctor, runs: saved.connectionSyncs });
  for (const route of ['/api/integrations/ebay/sync', '/api/connections/ebay/sync', '/api/connections/ebay/test', '/api/connections/ebay/refresh']) {
    const result = await f.request(route, { method: 'POST', body: {} });
    assert.equal(result.status, 429); assert.equal(result.body.code, 'EBAY_READ_DEFERRED');
  }
  const after = await f.store.get('privacy');
  assert.equal(JSON.stringify({ status: after.integrationStatus.ebay, doctor: after.connectionDoctor, runs: after.connectionSyncs }), preserved);
  assert.equal(calls, 1);
});

test('a compatibility marker observed with a test error is not persisted as a provider failure', async t => {
  const f = await fixture(t), before = await f.store.get('privacy');
  let calls = 0;
  f.integrations.testConnection = async state => {
    calls++;
    state.connectionDoctor = { ...state.connectionDoctor, shopify: { pendingReadAttempts: 1 } };
    throw Object.assign(new Error('Synthetic token failure'), { code: 'TOKEN_EXPIRED' });
  };
  const response = await f.request('/api/connections/shopify/test', { method: 'POST', body: {} });
  assert.equal(response.status, 409); assert.equal(response.body.code, 'READ_COMPATIBILITY_DEFERRED');
  assert.equal(calls, 1); assert.deepEqual(await f.store.get('privacy'), before);
});
