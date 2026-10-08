import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken, verifySessionToken, encryptCredentials } from '../lib/security.mjs';
import { IntegrationService } from '../lib/integrations.mjs';
import { connectionCentre, activateConnection, saveConnectionSettings } from '../lib/connection-centre.mjs';
import { resolveManualContentTarget, MANUAL_CONTENT_TARGET_SCHEMA } from '../lib/manual-content-target.mjs';
import { proposeConnectionWrite, readManualContentRequest } from '../lib/connection-writes.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

const ID = 'exact-content-alpha', ACTOR = 'exact-content-owner', PRODUCT = 'gid://shopify/Product/123';
const secret = 'synthetic-content-test-secret-more-than-thirty-two-characters';
function seed(workspaceId = ID) {
  const state = seedWorkspaceState({}, { workspaceId, userId: ACTOR, email: `${workspaceId}@example.test`, passwordHash: 'synthetic-only' });
  state.users.push({ ...state.users[0], id: 'exact-content-admin', role: 'admin', email: `admin-${workspaceId}@example.test` },
    { ...state.users[0], id: 'exact-content-viewer', role: 'viewer', email: `viewer-${workspaceId}@example.test` });
  state.products = [{ id: PRODUCT, provider: 'shopify', title: 'Original title' }];
  state.connections = [{ id: 'connection-b', provider: 'shopify', encryptedCredentials: 'synthetic-opaque-marker', metadata: { shopDomain: 'exact-b.myshopify.com', grantedScopes: ['read_products', 'write_products'] } }];
  state.connectionSettings = { shopify: { permissionMode: 'approval_gated', revision: 7 } };
  return state;
}
const body = (state, requestId = 'exact-content-request-0001') => ({ operation: 'product_content', requestId, productId: PRODUCT,
  title: '  Exact reviewed title  ', description: 'Exact <description>\nSecond line', target: resolveManualContentTarget(state).target });
const propose = (state, request = body(state), actor = ACTOR) => proposeConnectionWrite(state, 'shopify', request, actor);
const code = (fn, expected) => assert.throws(fn, error => error.code === expected, expected);

test('separate content target is exact B behind display A and agrees with existing credential selectors', async () => {
  const state = seed();
  state.connections[0].encryptedCredentials = encryptCredentials({ storeDomain: 'exact-b.myshopify.com', accessToken: 'synthetic-b-token', mode: 'oauth' }, secret);
  state.connections.unshift({ id: 'connection-a', provider: 'shopify', metadata: { shopDomain: 'display-a.myshopify.com' } });
  const integrations = new IntegrationService({ CREDENTIALS_KEY: secret }, { fetchImpl: async () => assert.fail('Preparation must not contact a provider') });
  const channel = connectionCentre(state, integrations).find(row => row.id === 'shopify');
  assert.equal(channel.identity, 'display-a.myshopify.com');
  assert.equal(channel.writeAccessGranted, false);
  assert.deepEqual(channel.contentPreparation, { available: true, target: { schema: MANUAL_CONTENT_TARGET_SCHEMA,
    connectionId: 'connection-b', account: 'exact-b.myshopify.com', settingsRevision: 7 } });
  const request = body(state), write = propose(state, request);
  assert.equal(write.connectionId, 'connection-b'); assert.equal(write.account, 'exact-b.myshopify.com');
  assert.equal(integrations.shopifyConnection(state).id, write.connectionId);
  assert.equal(integrations.shopifyConfig(state).domain, write.account);
  assert.equal((await integrations.connectorCredentials(state, 'shopify')).accessToken, 'synthetic-b-token');
  state.connections.reverse(); assert.equal(propose(state, request), write);
  assert.equal(state.connectionWrites.length, 1); assert.equal(state.approvals.length, 1);
  assert.equal(JSON.stringify(channel.contentPreparation).includes('synthetic-opaque'), false);
});

test('target resolution rejects ambiguity, duplicate identity, scope and exotic records without reading getters', () => {
  const variants = [
    state => { state.connections = []; },
    state => state.connections.push({ ...structuredClone(state.connections[0]), id: 'connection-c' }),
    state => state.connections.push({ id: 'connection-b', provider: 'meta' }),
    state => { state.connections[0].workspaceId = 'foreign'; },
    state => { state.connections[0].metadata.tenant = { id: 'foreign' }; },
    state => { state.connections[0].metadata.shopDomain = 'UPPER.myshopify.com'; },
    state => { state.connections[0].metadata.grantedScopes = ['read_products']; },
    state => { state.connections[0].metadata.grantedScopes = Array(2); },
    state => { Object.setPrototypeOf(state.connections[0].metadata.grantedScopes, { includes() { assert.fail('inherited method ran'); } }); },
    state => { state.connectionSettings.shopify.revision = -1; },
    state => { state.connectionSettings.shopify.workspace = 'foreign'; },
    state => { state.connections = Array(2); },
    state => { state.connections = Array.from({ length: 1001 }, () => structuredClone(state.connections[0])); },
    state => { Object.defineProperty(state.connections[0], 'encryptedCredentials', { get() { assert.fail('credential getter ran'); } }); },
    state => { Object.defineProperty(state.connectionSettings, 'shopify', { get() { assert.fail('settings getter ran'); } }); },
  ];
  for (const change of variants) {
    const state = seed(); change(state);
    assert.equal(resolveManualContentTarget(state).available, false);
    assert.equal(state.approvals.length, 0); assert.equal(state.connectionWrites?.length || 0, 0);
  }
});

test('new content requires an exact asserted account, unique product and original current requester', () => {
  const state = seed(), request = body(state);
  const missing = { ...request }; delete missing.target;
  code(() => propose(state, missing), 'WRITE_TARGET_REVIEW_REQUIRED');
  code(() => propose(state, { ...request, target: { ...request.target, extra: true } }), 'WRITE_TARGET_REVIEW_REQUIRED');
  const hidden = { ...request.target }; Object.defineProperty(hidden, 'extra', { value: true });
  code(() => propose(state, { ...request, target: hidden }), 'WRITE_TARGET_REVIEW_REQUIRED');
  code(() => propose(state, { ...request, target: { ...request.target, account: 'wrong.myshopify.com' } }), 'WRITE_TARGET_CHANGED');
  code(() => propose(state, { ...request, workspaceId: 'foreign' }), 'WRITE_CONTENT_INPUT_INVALID');
  code(() => propose(state, { ...request, requestId: { toString() { assert.fail('request ID coercion ran'); } } }), 'WRITE_REQUEST_ID_REQUIRED');
  const inherited = Object.assign(Object.create({ operation: 'product_content' }), request); delete inherited.operation;
  code(() => propose(state, inherited), 'WRITE_CONTENT_INPUT_INVALID');
  const accessor = { ...request }; Object.defineProperty(accessor, 'operation', { get() { assert.fail('operation getter ran'); } });
  code(() => propose(state, accessor), 'WRITE_CONTENT_INPUT_INVALID');
  code(() => propose(state, request, 'exact-content-viewer'), 'WRITE_ACTOR_CHANGED');
  state.products.push(structuredClone(state.products[0])); code(() => propose(state, request), 'PRODUCT_NOT_FOUND'); state.products.pop();
  state.products[0].tenantId = 'foreign'; code(() => propose(state, request), 'WRITE_TARGET_INVALID'); delete state.products[0].tenantId;
  state.users.push(structuredClone(state.users[0])); code(() => propose(state, request), 'WRITE_ACTOR_CHANGED'); state.users.pop();
  assert.equal(state.approvals.length, 0); assert.equal(state.connectionWrites.length, 0);
});

test('notes and tags retain their prior preparation contract without the new content assertion', () => {
  const state = seed();
  const note = proposeConnectionWrite(state, 'shopify', { operation: 'internal_note', requestId: 1234567890123456,
    productId: PRODUCT, note: 'Private note' }, ACTOR);
  assert.equal(note.requestId, 1234567890123456); assert.equal(note.input.note, 'Private note');
  const tags = proposeConnectionWrite(state, 'shopify', { operation: 'product_tags_add', requestId: 'existing-tag-request-001',
    productId: PRODUCT, tags: 'Existing, Reviewed' }, ACTOR);
  assert.deepEqual(tags.input.tags, ['Existing', 'Reviewed']);
  assert.equal(Object.hasOwn(note, 'target'), false); assert.equal(Object.hasOwn(tags, 'target'), false);
});

test('stable request identity coalesces exact intent and conflicts on actor/account/input/duplicate records', () => {
  const state = seed(), request = body(state), write = propose(state, request);
  assert.equal(propose(state, { ...request, title: 'Exact reviewed title' }), write);
  code(() => propose(state, request, 'exact-content-admin'), 'WRITE_CONFLICT');
  code(() => propose(state, { ...request, title: 'Different title' }), 'WRITE_CONFLICT');
  code(() => propose(state, { ...request, target: { ...request.target, account: 'other.myshopify.com' } }), 'WRITE_CONFLICT');
  state.connectionWrites.push(structuredClone(write)); code(() => propose(state, request), 'WRITE_CONFLICT'); state.connectionWrites.pop();
  state.approvals.push(structuredClone(state.approvals[0])); code(() => propose(state, request), 'APPROVAL_REQUIRED'); state.approvals.pop();
  state.approvals[0].payload.digest = 'changed'; code(() => propose(state, request), 'APPROVAL_REQUIRED');
  assert.equal(state.connectionWrites.length, 1); assert.equal(state.approvals.length, 1);
});

test('pending approval is independently validated before nested reads and target changes force review', () => {
  const state = seed(), request = body(state); propose(state, request);
  Object.defineProperty(state.approvals[0], 'payload', { get() { assert.fail('approval getter ran'); }, configurable: true });
  code(() => propose(state, request), 'WRITE_TARGET_INVALID');
  const clean = seed(), target = body(clean); propose(clean, target);
  saveConnectionSettings(clean, 'shopify', { revision: 7, autoSync: false }, clean.users[0]);
  code(() => propose(clean, target), 'WRITE_TARGET_CHANGED');
  const fresh = body(clean); assert.equal(propose(clean, fresh).requestId, target.requestId, 'fresh revision is not claimed to bind historical credential generation');
  activateConnection(clean, 'shopify', ACTOR); code(() => propose(clean, fresh), 'WRITE_NOT_AUTHORISED');
});

test('terminal exact requests remain history after target removal and old v1 bytes are not rewritten', () => {
  const state = seed(), request = body(state), write = propose(state, request);
  write.status = 'completed'; write.dispatchClaim = { id: 'existing-claim', identity: 'existing-v1-identity', phases: {} };
  const before = JSON.stringify(write); state.connections = []; state.connectionSettings.shopify.disconnected = true; state.products = [];
  assert.equal(propose(state, request), write); assert.equal(JSON.stringify(write), before);
  const result = readManualContentRequest(state, request.requestId, ACTOR);
  assert.equal(result.found, true); assert.equal(result.request.status, 'completed');
  assert.equal(Object.hasOwn(write, 'target'), false); assert.equal(Object.hasOwn(write.input, 'target'), false);
  assert.equal(write.digest, crypto.createHash('sha256').update(JSON.stringify({ productId: PRODUCT, operation: 'product_content', title: 'Exact reviewed title', description: request.description })).digest('hex'));
  code(() => readManualContentRequest(state, request.requestId, 'exact-content-admin'), 'WRITE_CONFLICT');
});

test('exact reconciliation scans beyond presentation limits but refuses incomplete or malformed coverage', () => {
  const state = seed(), write = propose(state);
  state.connectionWrites.unshift(...Array.from({ length: 60 }, (_, i) => ({ id: `other-${i}`, requestId: `other-request-${i}` })));
  assert.equal(readManualContentRequest(state, write.requestId, ACTOR).request.id, write.id);
  assert.deepEqual(readManualContentRequest(state, 'absent-request-0001', ACTOR), { schema: 'runvara-manual-content-request/v1', workspaceId: ID,
    requestId: 'absent-request-0001', requestedBy: ACTOR, found: false, request: null });
  state.connectionWrites = Array.from({ length: 10001 }, () => ({ requestId: 'irrelevant' }));
  code(() => readManualContentRequest(state, 'absent-request-0001', ACTOR), 'WRITE_TARGET_INVALID');
});

async function fixture(t, { durable = false, replica = false, fault } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-manual-content-'));
  const database = durable ? fakeSupabase({ fault }) : null;
  const env = { NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret, SHOPIFY_PUBLIC_SYNC_ENABLED: 'false',
    SAAS_STATE_FILE: path.join(dir, 'state.json'), ...(durable ? { SUPABASE_URL: 'https://manual-content.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only-storage' } : {}) };
  let providerCalls = 0;
  const make = () => createPacksmartServer(env, { fetchImpl: async () => { providerCalls++; throw new Error('Provider calls forbidden in preparation'); },
    ...(durable ? { store: createStore(env, { fetchImpl: database.fetchImpl }) } : {}) });
  const servers = [make(), ...(replica ? [make()] : [])], state = seed(), foreign = seed('foreign-content');
  await servers[0].packsmart.store.save(ID, state); await servers[0].packsmart.store.save(foreign.workspace.id, foreign);
  for (const server of servers) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  t.after(async () => { for (const server of servers) { await new Promise(resolve => server.close(resolve)); await server.packsmart.drain(); } await fs.rm(dir, { recursive: true, force: true }); assert.equal(providerCalls, 0); });
  const request = async (route, { method = 'GET', body: payload, actor = ACTOR, workspaceId = ID, csrf = true, server = 0 } = {}) => {
    const user = state.users.find(row => row.id === actor);
    const token = createSessionToken({ userId: actor, workspaceId, role: user?.role || 'owner', email: user?.email, sessionVersion: 1 }, secret);
    const headers = { Cookie: `packsmart_session=${token}`, 'Content-Type': 'application/json' };
    if (csrf) headers['X-CSRF-Token'] = verifySessionToken(token, secret).csrf;
    const response = await fetch(`http://127.0.0.1:${servers[server].address().port}${route}`, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  };
  return { servers, state, database, request, store: servers[0].packsmart.store };
}
const POST = '/api/connections/shopify/writes';
const lookup = id => `/api/connections/shopify/content-requests/${id}`;

for (const durable of [false, true]) test(`${durable ? 'Supabase' : 'FileStore'} loaded-state API uses exact target and current manager identity without provider calls`, async t => {
  const f = await fixture(t, { durable });
  const centre = await f.request('/api/connection-centre'); assert.equal(centre.status, 200);
  assert.equal(centre.body.channels.find(row => row.id === 'shopify').contentPreparation.available, true, 'persisted symbol is permitted only on root');
  const request = body(f.state);
  const missing = { ...request }; delete missing.target;
  assert.equal((await f.request(POST, { method: 'POST', body: missing })).body.code, 'WRITE_TARGET_REVIEW_REQUIRED');
  assert.equal((await f.request(POST, { method: 'POST', body: request, csrf: false })).status, 403);
  assert.equal((await f.request(POST, { method: 'POST', body: request, actor: 'exact-content-viewer' })).status, 403);
  const result = await f.request(POST, { method: 'POST', body: request, actor: 'exact-content-admin' }); assert.equal(result.status, 200);
  assert.equal(result.body.write.requestedBy, 'exact-content-admin');
  assert.equal((await f.request(`/api/connection-writes/${result.body.write.id}/execute`, { method: 'POST', body: {}, actor: 'exact-content-admin' })).status, 403);
  assert.equal((await f.request(lookup(request.requestId), { actor: 'exact-content-viewer' })).status, 403);
  assert.equal((await f.request(lookup(request.requestId))).body.code, 'WRITE_CONFLICT');
  assert.equal((await f.request(lookup(request.requestId), { actor: 'exact-content-admin' })).body.request.id, result.body.write.id);
  const older = await f.store.get(ID);
  older.connectionWrites.unshift(...Array.from({ length: 60 }, (_, i) => ({ id: `old-${i}`, requestId: `old-request-${i}`, provider: 'meta', input: { operation: 'facebook_publish' }, status: 'completed' })));
  await f.store.save(ID, older);
  assert.equal((await f.request(lookup(request.requestId), { actor: 'exact-content-admin' })).body.request.id, result.body.write.id, 'exact route finds the request beyond the first 50');
  assert.equal((await f.request(lookup(request.requestId), { workspaceId: 'foreign-content' })).body.found, false);
  assert.equal((await f.request(lookup(request.requestId) + '?workspaceId=foreign-content', { actor: 'exact-content-admin' })).status, 400);
  const saved = await f.store.get(ID); saved.users.find(row => row.id === 'exact-content-admin').sessionVersion = 2; await f.store.save(ID, saved);
  assert.equal((await f.request(lookup(request.requestId), { actor: 'exact-content-admin' })).status, 401);
  assert.equal((await f.store.get(ID)).approvals.length, 1);
});

test('independent replicas coalesce same-ID racing submissions through CAS and explicit reconciliation', async t => {
  const f = await fixture(t, { durable: true, replica: true }), request = body(f.state);
  const results = await Promise.all([0, 1].map(server => f.request(POST, { server, method: 'POST', body: request })));
  assert.ok(results.some(result => result.status === 200));
  assert.ok(results.every(result => [200, 409].includes(result.status)));
  const saved = await f.store.get(ID); assert.equal(saved.connectionWrites.length, 1); assert.equal(saved.approvals.length, 1);
  const reconciled = await f.request(lookup(request.requestId)); assert.equal(reconciled.body.request.id, saved.connectionWrites[0].id);
  const retry = await f.request(POST, { server: 1, method: 'POST', body: request }); assert.equal(retry.body.write.id, saved.connectionWrites[0].id);
  assert.equal((await f.store.get(ID)).approvals.length, 1);
});

test('lost save acknowledgement is reconciled without a second approval or changing v1 request identity', async t => {
  const f = await fixture(t, { durable: true }), request = body(f.state), save = f.store.save.bind(f.store);
  let lost = false;
  f.store.save = async (...args) => { const result = await save(...args); if (!lost && args[1].connectionWrites?.some(row => row.requestId === request.requestId)) { lost = true; throw new Error('Synthetic response lost after commit'); } return result; };
  assert.equal((await f.request(POST, { method: 'POST', body: request })).status, 500);
  const found = await f.request(lookup(request.requestId)); assert.equal(found.body.found, true);
  const retry = await f.request(POST, { method: 'POST', body: request }); assert.equal(retry.body.write.id, found.body.request.id);
  const saved = await f.store.get(ID); assert.equal(saved.approvals.length, 1); assert.equal(saved.connectionWrites.length, 1);
  assert.equal(Object.hasOwn(saved.connectionWrites[0], 'target'), false);
});

test('current actor changes after authentication refuse content preparation and exact reconciliation', async t => {
  const f = await fixture(t, { durable: true }), request = body(f.state);
  const created = await f.request(POST, { method: 'POST', body: request }); assert.equal(created.status, 200);
  const get = f.store.get.bind(f.store);
  let alter = false;
  f.store.get = async (...args) => { const state = await get(...args); if (alter && args[0] === ID) state.users.find(row => row.id === ACTOR).role = 'viewer'; return state; };
  // Reconciliation authenticates through the narrow identity reader, then
  // reacquires ordinary state; a role change at that boundary cannot borrow it.
  alter = true;
  assert.equal((await f.request(lookup(request.requestId))).status, 401);
  alter = false;
  let reads = 0;
  f.store.get = async (...args) => { const state = await get(...args); if (args[0] === ID && ++reads === 2) state.users.find(row => row.id === ACTOR).passwordChangeRequired = true; return state; };
  assert.equal((await f.request(POST, { method: 'POST', body: { ...request, requestId: 'changed-actor-request-001' } })).body.code, 'WRITE_ACTOR_CHANGED');
  assert.equal((await get(ID)).approvals.length, 1);
});

test('FileStore root workspace mismatch cannot borrow the authenticated tenant for content reads or proposals', async t => {
  const f = await fixture(t), request = body(f.state);
  assert.equal((await f.request(POST, { method: 'POST', body: request })).status, 200);
  const all = JSON.parse(await fs.readFile(f.store.filePath, 'utf8'));
  all[ID].workspace.id = 'foreign-content';
  await fs.writeFile(f.store.filePath, JSON.stringify(all));
  const read = await f.request(lookup(request.requestId)); assert.equal(read.status, 403); assert.equal(read.body.code, 'WORKSPACE_MISMATCH');
  assert.equal(Object.hasOwn(read.body, 'request'), false);
  const result = await f.request(POST, { method: 'POST', body: { ...request, requestId: 'wrong-root-request-0001' } });
  assert.equal(result.status, 403); assert.equal(result.body.code, 'WORKSPACE_MISMATCH');
  assert.equal((await f.store.get(ID)).approvals.length, 1);
});
