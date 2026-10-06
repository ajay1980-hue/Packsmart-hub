import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { newCreativeRequest } from '../lib/creative-safety.mjs';

test('creative API preserves auth/scope and reports an explicit allowance blocker without any provider POST', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-safety-api-'));
  const key = 'synthetic-creative-safety-key-more-than-32-characters';
  const server = createPacksmartServer({ NODE_ENV: 'test', CREDENTIALS_KEY: key, SESSION_SECRET: key,
    SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false',
    MARKETING_ENV_WORKSPACE_ID: 'creative-api', RUNWAY_API_KEY: 'synthetic-existing-provider-key' }, { schedulerEnabled: false, agentOpsEnabled: false });
  const state = seedWorkspaceState({}, { workspaceId: 'creative-api', email: 'owner@example.test', passwordHash: 'synthetic-only' });
  state.users.push({ ...state.users[0], id: 'synthetic_viewer', role: 'viewer', email: 'viewer@example.test' });
  const campaign = { id: 'campaign_fresh', status: 'draft', product: { image: 'https://cdn.shopify.com/synthetic.jpg' }, creativeRequests: [], publish: { approvalRequired: true, status: 'not_requested' } };
  campaign.creativeRequests.push(newCreativeRequest({ workspaceId: state.workspace.id, campaignId: campaign.id, provider: 'runway', kind: 'product_video', formats: [] }));
  const legacy = { id: 'campaign_existing', status: 'creative_generation', creativeRequests: [{ provider: 'runway', status: 'in_progress', stage: 'generation', taskId: 'existing_task' }] };
  state.marketing.campaigns = [campaign, legacy];
  await server.packsmart.store.save(state.workspace.id, state);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch; const providerCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith(base)) return originalFetch(url, options);
    providerCalls.push({ url: String(url), method: options.method || 'GET' });
    assert.equal(String(url), 'https://api.dev.runwayml.com/v1/tasks/existing_task');
    assert.equal(options.method || 'GET', 'GET');
    return Response.json({ status: 'SUCCEEDED', output: ['https://example.test/existing.mp4'] });
  };
  t.after(async () => { globalThis.fetch = originalFetch; await server.packsmart.drain(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const identity = role => {
    const user = state.users.find(user => user.role === role);
    const token = createSessionToken({ workspaceId: state.workspace.id, userId: user.id, role: user.role, email: user.email, sessionVersion: user.sessionVersion }, key);
    return { token, csrf: verifySessionToken(token, key).csrf };
  };
  async function request(id, { who = identity('owner'), csrf = true, body = {} } = {}) {
    const response = await fetch(`${base}/api/marketing/campaigns/${id}/creatives/advance`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(who ? { Cookie: `packsmart_session=${who.token}` } : {}), ...(who && csrf ? { 'X-CSRF-Token': who.csrf } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await request(campaign.id, { who: null })).status, 401);
  assert.equal((await request(campaign.id, { who: identity('viewer') })).status, 403);
  assert.equal((await request(campaign.id, { csrf: false })).status, 403);
  assert.equal((await request('campaign_foreign')).status, 404);
  const blocked = await request(campaign.id, { body: { maxCostMicros: 999999, allowance: { allowed: true }, autoCreative: true } });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'CREATIVE_ALLOWANCE_REQUIRED');
  assert.match(blocked.body.error, /owner.*approve.*exact creative phase/i);
  assert.equal(blocked.body.effects.submissionAttempts, 0); assert.equal(providerCalls.length, 0, 'An explicit blocked campaign must not poll another campaign');
  const before = await server.packsmart.store.get(state.workspace.id);
  assert.equal(before.marketing.campaigns[1].creativeRequests[0].taskId, 'existing_task');
  const read = await request(legacy.id);
  assert.equal(read.status, 200); assert.equal(read.body.campaign.id, legacy.id); assert.equal(read.body.campaign.creativeRequests[0].status, 'complete');
  assert.equal(read.body.effects.providerReads, 1); assert.equal(read.body.effects.submissionAttempts, 0); assert.equal(read.body.effects.spend, null);
  assert.deepEqual(providerCalls.map(call => call.method), ['GET']);
  const saved = await server.packsmart.store.get(state.workspace.id);
  const audit = saved.audit.find(event => event.type === 'marketing_creatives_advanced' && event.detail.campaignId === legacy.id);
  assert.equal(audit.detail.effects.costStatus, 'unknown');
  assert.equal(saved.marketing.campaigns[0].creativeRequests[0].blockReason, 'CREATIVE_ALLOWANCE_REQUIRED');
});
