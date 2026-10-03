import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';

test('Revenue Engine bootstrap reads stay stable while mutations remain authenticated, CSRF protected and tenant scoped', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-revenue-'));
  const secret = 'revenue-test-session-secret-more-than-thirty-two-characters';
  const providerCalls = [];
  const server = createPacksmartServer({
    NODE_ENV: 'test', SESSION_SECRET: secret,
    CREDENTIALS_KEY: 'revenue-test-credential-key-more-than-thirty-two-characters',
    SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false'
  }, { fetchImpl: async url => { providerCalls.push(String(url)); throw new Error('Reads must not call providers'); } });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const alpha = seedWorkspaceState({}, { workspaceId: 'revenue-alpha', email: 'alpha@example.test', passwordHash: 'test-only' });
  const beta = seedWorkspaceState({}, { workspaceId: 'revenue-beta', email: 'beta@example.test', passwordHash: 'test-only' });
  alpha.users.push({ id: 'member-alpha', email: 'member@example.test', role: 'member', active: true, sessionVersion: 1 });
  alpha.revenueEngine.leads = [{ id: 'alpha-lead', company: 'Alpha retained company', stage: 'quote' }];
  alpha.revenueEngine.quotes = [{ id: 'alpha-quote', status: 'draft', lines: [{ sku: 'A', quantity: 20, unitPrice: 12 }] }];
  await server.packsmart.store.save(alpha.workspace.id, alpha);
  await server.packsmart.store.save(beta.workspace.id, beta);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const credentials = (state, user = state.users[0]) => {
    const token = createSessionToken({ userId: user.id, workspaceId: state.workspace.id, email: user.email, role: user.role, sessionVersion: 1 }, secret);
    return { cookie: `packsmart_session=${token}`, csrf: verifySessionToken(token, secret).csrf };
  };
  const owner = credentials(alpha), other = credentials(beta), member = credentials(alpha, alpha.users[1]);
  const request = async (route, { auth, method = 'GET', body, csrf = true } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Cookie = auth.cookie;
    if (auth && csrf) headers['X-CSRF-Token'] = auth.csrf;
    const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, payload: await response.json() };
  };
  assert.equal((await request('/api/revenue-engine')).status, 401);
  const first = await request('/api/bootstrap', { auth: owner });
  assert.equal(first.status, 200);
  assert.equal(first.payload.revenueEngine.sales.summary.openPipeline, 240);
  assert.equal(first.payload.revenueEngine.sales.leads[0].company, 'Alpha retained company');
  const before = await server.packsmart.store.get(alpha.workspace.id);
  const originalSave = server.packsmart.store.save.bind(server.packsmart.store);
  let saves = 0;
  server.packsmart.store.save = async (...args) => { saves += 1; return originalSave(...args); };
  for (let i = 0; i < 3; i++) {
    const read = await request('/api/bootstrap', { auth: owner });
    assert.equal(read.status, 200);
    assert.equal(read.payload.brief.id, first.payload.brief.id);
    assert.equal(read.payload.brief.sourceSignature, first.payload.brief.sourceSignature);
    const snapshot = await request('/api/revenue-engine', { auth: owner });
    assert.equal(snapshot.status, 200);
    assert.deepEqual(snapshot.payload.sales, read.payload.revenueEngine.sales);
  }
  assert.equal(saves, 0, 'unchanged bootstrap and Revenue Engine reads never persist computed timestamps');
  assert.deepEqual(await server.packsmart.store.get(alpha.workspace.id), before, 'reads preserve revision, audit and retained state');
  for (const [route, body] of [
    ['/api/revenue-engine/leads', { company: 'New private company' }],
    ['/api/revenue-engine/quotes', { lines: [{ sku: 'A', quantity: 2, unitPrice: 10 }] }],
    ['/api/revenue-engine/attribution', { orderId: 'o1', kind: 'utm_source', value: 'google' }]
  ]) {
    assert.equal((await request(route, { method: 'POST', body })).status, 401);
    assert.equal((await request(route, { auth: owner, method: 'POST', body, csrf: false })).status, 403);
    assert.equal((await request(route, { auth: member, method: 'POST', body })).status, 403);
  }
  const intentBody = { type: 'checkout_started', sessionId: 's1' };
  assert.equal((await request('/api/revenue-engine/intent', { method: 'POST', body: intentBody })).status, 401);
  assert.equal((await request('/api/revenue-engine/intent', { auth: member, method: 'POST', body: intentBody, csrf: false })).status, 403);
  assert.equal(saves, 0, 'denied mutations cannot change persistence');
  const lead = await request('/api/revenue-engine/leads', { auth: owner, method: 'POST', body: { company: 'New private company', workspaceId: beta.workspace.id } });
  assert.equal(lead.status, 201);
  const quote = await request('/api/revenue-engine/quotes', { auth: owner, method: 'POST', body: { leadId: lead.payload.lead.id, lines: [{ sku: 'A', quantity: 2, unitPrice: 10 }], status: 'approved', customerFacing: true } });
  assert.equal(quote.status, 201);
  assert.equal(quote.payload.quote.status, 'draft');
  assert.equal(quote.payload.quote.customerFacing, false);
  assert.equal(quote.payload.executedExternally, false);
  const changed = await request('/api/bootstrap', { auth: owner });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.payload.brief.sourceSignature, first.payload.brief.sourceSignature, 'persisted Revenue Engine changes still invalidate the brief');
  assert.notEqual(changed.payload.brief.id, first.payload.brief.id);
  assert.equal(changed.payload.revenueEngine.sales.summary.openPipeline, 260);
  saves = 0;
  const reread = await request('/api/bootstrap', { auth: owner });
  assert.equal(reread.payload.brief.id, changed.payload.brief.id);
  assert.equal(saves, 0, 'the refreshed brief is stable on the next read');
  const isolated = await request(`/api/bootstrap?workspaceId=${alpha.workspace.id}`, { auth: other });
  assert.equal(isolated.status, 200);
  assert.equal(isolated.payload.workspace.id, beta.workspace.id);
  assert.equal(isolated.payload.revenueEngine.sales.summary.openPipeline, 0);
  assert.deepEqual(isolated.payload.revenueEngine.sales.leads, []);
  const otherSnapshot = await request(`/api/revenue-engine?workspaceId=${alpha.workspace.id}`, { auth: other });
  assert.equal(otherSnapshot.status, 200);
  assert.deepEqual(otherSnapshot.payload.sales.quotes, []);
  assert.deepEqual(providerCalls, [], 'bootstrap never performs provider reads or outbound actions');
});
