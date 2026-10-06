import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { addWebIntelligenceTarget } from '../lib/web-intelligence.mjs';

test('manual Firecrawl API remains owner/scoped, cannot bypass the stop, and preserves saved evidence', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'web-safety-api-'));
  const key = 'synthetic-web-safety-secret-more-than-32-characters';
  let calls = 0;
  const server = createPacksmartServer({ NODE_ENV: 'test', CREDENTIALS_KEY: key, SESSION_SECRET: key,
    SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false', FIRECRAWL_API_KEY: 'synthetic-only-key' },
  { schedulerEnabled: false, agentOpsEnabled: false, fetchImpl: async () => { calls++; assert.fail('No provider calls'); } });
  const s = seedWorkspaceState({}, { workspaceId: 'web-safety-api', email: 'owner@example.test', passwordHash: 'synthetic-only' });
  s.users.push({ ...s.users[0], id: 'synthetic_viewer', role: 'viewer', email: 'viewer@example.test' });
  const target = addWebIntelligenceTarget(s, { url: 'https://example.test/prices', name: 'Saved public page' });
  target.snapshot = { fingerprint: 'b'.repeat(64), prices: [10], excerpt: 'Saved £10 evidence' };
  Object.assign(target, { lastStatus: 'connected', lastScannedAt: '2026-10-01T00:00:00.000Z', lastSuccessfulScan: { id: 'original' }, lastSuccessfulScanAt: '2026-10-01T00:00:00.000Z' });
  s.webIntelligence.findings = [{ id: 'finding-original', targetId: target.id, detail: 'Saved finding' }];
  s.webIntelligence.scans = [{ id: 'scan-original', targetId: target.id, status: 'completed' }];
  s.webIntelligence.lastRunAt = target.lastScannedAt;
  await server.packsmart.store.save(s.workspace.id, s);
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => { if (String(url).startsWith(base)) return originalFetch(url, options); calls++; assert.fail('No external HTTP of any kind'); });
  t.after(async () => { await server.packsmart.drain(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const identity = role => {
    const user = s.users.find(user => user.role === role);
    const token = createSessionToken({ workspaceId: s.workspace.id, userId: user.id, role: user.role, email: user.email, sessionVersion: user.sessionVersion }, key);
    return { token, csrf: verifySessionToken(token, key).csrf };
  };
  async function request(route, { method = 'POST', who = identity('owner'), csrf = true, body = {} } = {}) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json',
      ...(who ? { Cookie: `packsmart_session=${who.token}` } : {}), ...(who && csrf ? { 'X-CSRF-Token': who.csrf } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await request('/api/web-intelligence/scan', { who: null })).status, 401);
  assert.equal((await request('/api/web-intelligence/scan', { who: identity('viewer') })).status, 403);
  assert.equal((await request('/api/web-intelligence/scan', { csrf: false })).status, 403);
  assert.equal((await request('/api/web-intelligence/scan', { body: { targetId: 'foreign' } })).status, 404);
  const before = structuredClone((await server.packsmart.store.get(s.workspace.id)).webIntelligence);
  for (const body of [{ targetId: target.id }, { force: true, allowed: true, maxCredits: 9999, allowance: { approved: true }, authorizeScan: 'caller-defined' }]) {
    const blocked = await request('/api/web-intelligence/scan', { body });
    assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'WEB_SCAN_ALLOWANCE_REQUIRED');
    assert.match(blocked.body.error, /per-target request and credit accounting/i);
    assert.equal(blocked.body.result.scanned, 0); assert.equal(blocked.body.result.effects.submissionAttempts, 0);
    assert.equal(blocked.body.result.effects.spend, null); assert.equal(blocked.body.result.effects.externalWrites, false);
  }
  const saved = await server.packsmart.store.get(s.workspace.id);
  assert.deepEqual(saved.webIntelligence, before); assert.equal(calls, 0);
  assert.equal(saved.audit.filter(row => row.type === 'web_intelligence_scan_blocked').length, 2);
  assert.equal(saved.audit.filter(row => row.type === 'web_intelligence_scan_completed').length, 0);
  const read = await request('/api/web-intelligence', { method: 'GET', who: identity('viewer') });
  assert.equal(read.status, 200); assert.equal(read.body.findings[0].id, 'finding-original');
  assert.equal(read.body.provider.configured, true); assert.equal(read.body.provider.liveScanningAvailable, false);
  assert.notEqual(read.body.provider.status, 'connected');
  const added = await request('/api/web-intelligence/targets', { body: { url: 'https://example.test/another', name: 'Another saved target' } });
  assert.equal(added.status, 201);
  assert.equal((await request(`/api/web-intelligence/targets/${added.body.target.id}`, { method: 'PUT', body: { active: false } })).status, 200);
  const disabled = await request('/api/web-intelligence/settings', { method: 'PUT', body: { enabled: false } }); assert.equal(disabled.status, 200);
  const noop = await request('/api/web-intelligence/scan'); assert.equal(noop.status, 200); assert.equal(noop.body.result.scanned, 0);
  assert.equal(noop.body.result.reason, 'WEB_SCANNING_DISABLED'); assert.equal(calls, 0);
});
