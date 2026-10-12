import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { COST_SOURCE_REVIEW_CONTRACT } from '../lib/cost-source-stage.mjs';
import { objectiveContentApiFixture } from './objective-content-test-fixture.mjs';

const selector = { productId: 'gid://shopify/Product/10', variantId: 'gid://shopify/ProductVariant/100', sku: 'BOX-100' };
const contextPath = '/api/economics/source-review?' + new URLSearchParams(selector);
const basis = { currency: 'GBP', taxBasis: 'net', effectiveFrom: '2026-10-01', effectiveUntil: null,
  sources: [{ component: 'landed', kind: 'invoice', identifier: 'SUPPLIER-REFERENCE-001', issuedOn: '2026-09-30' }] };
const bodyFor = context => ({ sku: selector.sku, sourceReview: { ...selector, sourceRevision: context.sourceRevision, requestId: crypto.randomUUID(), basis: structuredClone(basis) } });
function populate(state) {
  state.products = [{ id: selector.productId, provider: 'shopify', title: 'Box', description: '', variants: [{ id: selector.variantId, sku: selector.sku, price: 8, inventory: 10 }] }];
  state.economics = { [selector.sku]: { landed: 0, packing: 1, notes: 'Ordinary retained note', updatedAt: '2026-10-01T00:00:00.000Z' } };
  state.connections = [{ id: 'saved-shopify-account', provider: 'shopify', metadata: { shopDomain: 'synthetic-costs.myshopify.com' } }];
}
async function fixture(t, { enabled = true } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-cost-source-'));
  const secret = crypto.randomBytes(32).toString('hex');
  const env = { NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret, SAAS_STATE_FILE: path.join(dir, 'state.json'),
    SHOPIFY_PUBLIC_SYNC_ENABLED: 'false', ...(enabled ? { COST_SOURCE_REVIEW_CONTRACT } : {}) };
  const server = createPacksmartServer(env, { schedulerEnabled: false, agentOpsEnabled: false,
    fetchImpl: async () => assert.fail('Source review must not call a provider or model') });
  const store = server.packsmart.store;
  for (const workspaceId of ['cost-alpha', 'cost-beta']) {
    const state = seedWorkspaceState({}, { workspaceId, userId: `${workspaceId}-owner`, email: `${workspaceId}@example.test`, passwordHash: 'synthetic-fixture' });
    state.users.push(...['admin', 'viewer'].map(role => ({ ...state.users[0], id: `${workspaceId}-${role}`, email: `${workspaceId}-${role}@example.test`, role })));
    populate(state); await store.save(workspaceId, state);
  }
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await server.packsmart.drain(); if (server.listening) await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const auth = (workspaceId = 'cost-alpha', role = 'owner', sessionVersion = 1) => {
    const token = createSessionToken({ workspaceId, userId: `${workspaceId}-${role}`, role, email: `${workspaceId}-${role}@example.test`, sessionVersion }, secret);
    return { token, csrf: verifySessionToken(token, secret).csrf };
  };
  const request = async (route = contextPath, { method = 'GET', body, identity = auth(), csrf = true } = {}) => {
    const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}) };
    if (identity) { headers.Cookie = `packsmart_session=${identity.token}`; if (csrf) headers['X-CSRF-Token'] = identity.csrf; }
    const response = await fetch(`http://127.0.0.1:${server.address().port}` + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const context = async () => { const r = await request(); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  const put = body => request('/api/economics', { method: 'PUT', body });
  const change = async callback => { const state = await store.get('cost-alpha'); callback(state); await store.save('cost-alpha', state); };
  return { server, store, auth, request, context, put, change, env };
}

test('cost source context is owner/admin scoped, performs no saves and has no provider prerequisite', async t => {
  const f = await fixture(t), before = await f.store.get('cost-alpha');
  for (const role of ['owner', 'admin']) {
    const r = await f.request(contextPath, { identity: f.auth('cost-alpha', role) });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.current, null); assert.equal(r.body.costs.landed, 0);
    assert.equal(r.body.target.variantId, selector.variantId); assert.equal(r.body.producerEnabled, true);
  }
  assert.equal((await f.request(contextPath, { identity: null })).status, 401);
  assert.equal((await f.request(contextPath, { identity: f.auth('cost-alpha', 'viewer') })).status, 403);
  assert.equal((await f.request(contextPath + '&workspaceId=cost-beta')).status, 400);
  assert.equal((await f.request(contextPath + '&sku=BOX-100')).status, 400);
  assert.deepEqual(await f.store.get('cost-alpha'), before);
});

test('source-only save preserves numerical costs, update time, corrections and exact replay without another save', async t => {
  const f = await fixture(t), input = bodyFor(await f.context()), original = (await f.store.get('cost-alpha')).economics[selector.sku];
  const first = await f.put(input); assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.current, true); assert.equal(first.body.duplicate, false);
  const state = await f.store.get('cost-alpha'), { sourceBasis, ...costs } = state.economics[selector.sku];
  assert.deepEqual(costs, original); assert.equal(state.costHistory.length, 1); assert.equal(sourceBasis.basis.sources[0].identifier, basis.sources[0].identifier);
  const revision = state._revision;
  assert.equal((await f.put(input)).body.duplicate, true);
  assert.equal((await f.store.get('cost-alpha'))._revision, revision);
  const unchanged = bodyFor(await f.context()); assert.equal((await f.put(unchanged)).body.duplicate, true);
  assert.equal((await f.store.get('cost-alpha'))._revision, revision);
  const correction = bodyFor(await f.context()); correction.sourceReview.basis.sources[0].identifier = 'CORRECTED-REFERENCE-002';
  const changed = await f.put(correction); assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const after = await f.store.get('cost-alpha'); assert.equal(after.costHistory.length, 2);
  assert.equal(after.costHistory[0].before.sourceBasis, first.body.record.id);
  assert.equal(after.costHistory[1].after.sourceBasis.basis.sources[0].identifier, basis.sources[0].identifier);
  const historical = await f.put(input); assert.equal(historical.body.current, false); assert.equal(historical.body.duplicate, true);
  assert.equal((await f.store.get('cost-alpha')).economics[selector.sku].sourceBasis.id, changed.body.record.id);
});

test('annotation gate is independently closed by default while ordinary costs and source reads remain available', async t => {
  const f = await fixture(t, { enabled: false }), context = await f.context();
  assert.equal(context.producerEnabled, false);
  const r = await f.put(bodyFor(context)); assert.equal(r.status, 503); assert.equal(r.body.code, 'COST_SOURCE_REVIEW_PAUSED');
  assert.match(r.body.error, /paused/); assert.equal((await f.store.get('cost-alpha')).costHistory.length, 0);
  const ordinary = await f.put({ sku: selector.sku, economics: { packing: 2 } }); assert.equal(ordinary.status, 200);
  assert.equal(ordinary.body.economics.packing, 2);
});

test('source routes reject simultaneous numeric edits, CSRF omissions, stale sessions, stale prices and cross-tenant preview replay', async t => {
  const f = await fixture(t), input = bodyFor(await f.context());
  assert.equal((await f.put({ ...input, economics: { landed: 99 } })).status, 400);
  assert.equal((await f.request('/api/economics', { method: 'PUT', body: input, csrf: false })).status, 403);
  const foreign = await f.request('/api/economics', { method: 'PUT', body: input, identity: f.auth('cost-beta') });
  assert.equal(foreign.status, 409);
  await f.change(state => { state.economics[selector.sku].packing = 4; });
  assert.equal((await f.put(input)).body.code, 'COST_SOURCE_STALE');
  const refreshed = bodyFor(await f.context());
  await f.change(state => { state.users[0].sessionVersion = 2; });
  assert.equal((await f.put(refreshed)).status, 401);
  assert.equal((await f.store.get('cost-alpha')).costHistory.length, 0);
});

test('ordinary cost edit preserves source history, marks it stale and redacts source material from every generic response', async t => {
  const f = await fixture(t), input = bodyFor(await f.context()); assert.equal((await f.put(input)).status, 200);
  const ordinary = await f.put({ sku: selector.sku, economics: { landed: 1 } }); assert.equal(ordinary.status, 200);
  assert.equal(ordinary.body.economics.sourceBasis, undefined);
  const context = await f.context(); assert.equal(context.current.stale, true); assert.equal(context.history.length, 1);
  for (const route of ['/api/bootstrap', '/api/dashboard', '/api/audit', '/api/business-graph', '/api/connection-centre']) {
    const r = await f.request(route, { identity: f.auth('cost-alpha', 'viewer') });
    if (r.status !== 404) assert.equal(r.status, 200, JSON.stringify(r.body));
    const json = JSON.stringify(r.body); assert.ok(!json.includes(basis.sources[0].identifier), route); assert.ok(!json.includes('requestDigest'), route);
  }
  const retained = await f.store.get('cost-alpha'); assert.equal(retained.costHistory.filter(row => row.after?.sourceBasis).length, 1);
  assert.equal(retained.economics[selector.sku].sourceBasis.basis.sources[0].identifier, basis.sources[0].identifier);
});

test('concurrent source corrections admit one revision and retain the rejected contender unchanged', async t => {
  const f = await fixture(t), context = await f.context(), a = bodyFor(context), b = bodyFor(context);
  b.sourceReview.basis.sources[0].identifier = 'OTHER-REFERENCE';
  const results = await Promise.all([f.put(a), f.put(b)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await f.store.get('cost-alpha')).costHistory.length, 1);
});

test('lost save acknowledgment reconciles exact retained request without writing or restoring older costs', async t => {
  const f = await fixture(t), input = bodyFor(await f.context()), originalSave = f.store.save.bind(f.store);
  let fail = true;
  f.store.save = async (...args) => { const result = await originalSave(...args); if (fail) { fail = false; throw Object.assign(new Error('Synthetic acknowledgment lost'), { status: 503, code: 'TIMEOUT' }); } return result; };
  assert.equal((await f.put(input)).status, 503);
  const retained = await f.store.get('cost-alpha'), revision = retained._revision;
  assert.equal((await f.context()).history[0].requestId, input.sourceReview.requestId);
  const replay = await f.put(input); assert.equal(replay.status, 200); assert.equal(replay.body.duplicate, true);
  assert.equal((await f.store.get('cost-alpha'))._revision, revision);
});

test('a closed compatible process can read and reconcile an open process record but cannot append a correction', async t => {
  const f = await fixture(t), input = bodyFor(await f.context()); assert.equal((await f.put(input)).status, 200);
  const peer = createPacksmartServer({ ...f.env, COST_SOURCE_REVIEW_CONTRACT: undefined }, { store: f.store, schedulerEnabled: false, agentOpsEnabled: false,
    fetchImpl: async () => assert.fail('No provider transport') });
  peer.listen(0, '127.0.0.1'); await once(peer, 'listening');
  t.after(async () => { await peer.packsmart.drain(); if (peer.listening) await new Promise(resolve => peer.close(resolve)); });
  const identity = f.auth(), peerRequest = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${peer.address().port}` + route, { method: body ? 'PUT' : 'GET',
      headers: { Cookie: `packsmart_session=${identity.token}`, 'X-CSRF-Token': identity.csrf, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  const context = await peerRequest(contextPath); assert.equal(context.status, 200); assert.equal(context.body.producerEnabled, false);
  assert.equal(context.body.current.record.requestId, input.sourceReview.requestId);
  const before = await f.store.get('cost-alpha');
  assert.equal((await peerRequest('/api/economics', input)).body.duplicate, true);
  const correction = bodyFor(context.body); correction.sourceReview.basis.sources[0].identifier = 'NEW-REF';
  assert.equal((await peerRequest('/api/economics', correction)).body.code, 'COST_SOURCE_REVIEW_PAUSED');
  assert.deepEqual(await f.store.get('cost-alpha'), before);
});

test('saved source history remains explicitly stale and read-only after its current catalogue target disappears', async t => {
  const f = await fixture(t), input = bodyFor(await f.context()); assert.equal((await f.put(input)).status, 200);
  await f.change(state => { state.products = []; });
  const context = await f.context(); assert.equal(context.writable, false); assert.equal(context.sourceRevision, null);
  assert.equal(context.current.stale, true); assert.ok(context.current.staleReasons.includes('target_unavailable'));
  assert.equal(context.history[0].requestId, input.sourceReview.requestId);
  const before = await f.store.get('cost-alpha'); assert.notEqual((await f.put(input)).status, 200);
  assert.deepEqual(await f.store.get('cost-alpha'), before);
});

test('late cost, actor and retained-record changes are rejected by the final snapshot guard', async t => {
  for (const change of [state => { state.economics[selector.sku].landed = 6; },
    state => { state.users[0].role = 'viewer'; }, state => { state.economics[selector.sku].sourceBasis.basis.currency = 'USD'; }]) {
    await t.test(String(change), async t => {
      const f = await fixture(t), input = bodyFor(await f.context()), before = await f.store.get('cost-alpha'), save = f.store.save.bind(f.store);
      f.store.save = async (workspaceId, state, options) => { change(state); return save(workspaceId, state, options); };
      const response = await f.put(input); assert.ok([400, 403, 409].includes(response.status), JSON.stringify(response));
      assert.deepEqual(await f.store.get('cost-alpha'), before);
    });
  }
});

test('a mismatched save acknowledgment is uncertain, and subsequent exact history remains recoverable', async t => {
  const f = await fixture(t), input = bodyFor(await f.context()), save = f.store.save.bind(f.store);
  f.store.save = async (...args) => { await save(...args); return { _revision: 'wrong' }; };
  const response = await f.put(input); assert.equal(response.status, 503); assert.equal(response.body.code, 'COST_SOURCE_SAVE_UNCONFIRMED');
  assert.match(response.body.error, /exact request/);
  assert.equal((await f.context()).history[0].requestId, input.sourceReview.requestId);
});

test('source reads add one existing state read; annotation writes reuse cost-save reads and do not create daily-brief persistence churn', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/bootstrap')).status, 200);
  const get = f.store.get.bind(f.store), save = f.store.save.bind(f.store); let reads = 0, writes = 0;
  f.store.get = async (...args) => { reads++; return get(...args); };
  f.store.save = async (...args) => { writes++; return save(...args); };
  const context = await f.context(); assert.equal(reads, 1); assert.equal(writes, 0);
  const input = bodyFor(context); reads = 0;
  assert.equal((await f.put(input)).status, 200); assert.equal(reads, 2); assert.equal(writes, 1);
  const after = await get('cost-alpha'); reads = 0; writes = 0;
  for (let index = 0; index < 3; index++) assert.equal((await f.request('/api/bootstrap')).status, 200);
  assert.equal(reads, 3); assert.equal(writes, 0);
  assert.equal((await get('cost-alpha')).dailyBriefs.length, after.dailyBriefs.length);
  reads = 0;
  assert.equal((await f.put(input)).body.duplicate, true); assert.equal(reads, 2); assert.equal(writes, 0);
});

test('source sidecar appears only on owner objective context and cannot alter proposal source or financial holds', async t => {
  const f = await objectiveContentApiFixture(t, { env: { COST_SOURCE_REVIEW_CONTRACT } });
  const first = await f.context();
  await f.change(state => {
    state.products[0].variants = [{ id: selector.variantId, sku: selector.sku, price: 8, inventory: 10 }];
    state.economics = { [selector.sku]: { landed: 0 } };
  });
  const cost = await f.request(contextPath); assert.equal(cost.status, 200, JSON.stringify(cost.body));
  const saved = await f.request('/api/economics', { method: 'PUT', body: bodyFor(cost.body) }); assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const context = await f.context();
  assert.deepEqual(context.source, first.source); assert.equal(context.sourceRevision, first.sourceRevision);
  assert.ok(context.costSources); assert.match(JSON.stringify(context.costSources), /attest/i);
  assert.deepEqual(context.policy, first.policy);
  assert.equal((await f.request(f.contextRoute, { identity: f.auth(f.workspaceId, 'admin') })).status, 403);
});
