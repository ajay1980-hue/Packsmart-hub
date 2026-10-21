import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { publicationFixture } from './marketing-publication-fixture.mjs';

const secret = 'synthetic-meta-publication-api-secret-over-thirty-two-characters';
async function api(t, { quiet = false, durable = true, enabledLegacyProducers = false } = {}) {
  const f = await publicationFixture(t), beta = await publicationFixture(t, 'meta-foreign');
  await f.change(state => { for (const role of ['admin', 'member', 'viewer']) state.users.push({ ...state.users[0], id: 'meta-' + role, email: `${role}@example.test`, role }); });
  let saves = 0, reads = 0, externalCalls = 0;
  const stores = new Map([[f.workspaceId, f.store], [beta.workspaceId, beta.store]]);
  // The durable designation is a test adapter only; storage remains local.
  const store = { provider: durable ? 'supabase' : 'file',
    get: async id => { reads++; return stores.get(id)?.get(id); },
    getIdentity: async id => { reads++; return stores.get(id)?.getIdentity(id); },
    save: async (id, state, options) => { saves++; return stores.get(id).save(id, state, options); } };
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
    ...(enabledLegacyProducers ? { GOVERNED_RECORD_PRODUCER_CONTRACT: 'runvara-governed-record-producers/v1' } : {}),
    ...(quiet ? { RUNVARA_STARTUP_MODE: 'quiet' } : {}) }, { store, schedulerEnabled: false, agentOpsEnabled: false,
    fetchImpl: async () => { externalCalls++; assert.fail('Provider/network access forbidden'); } });
  t.after(async () => { await server.packsmart.drain(); if (server.listening) await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const route = `/api/marketing/campaigns/${f.campaignId}/publication/meta`;
  const preview = route + '/preview?' + new URLSearchParams(f.selection);
  async function token(role = 'owner', fixture = f, version) {
    const state = await fixture.get(), user = state.users.find(row => row.role === role);
    return createSessionToken({ workspaceId: fixture.workspaceId, userId: user.id, role,
      email: user.email, sessionVersion: version ?? user.sessionVersion }, secret);
  }
  async function request(pathname, { method = 'GET', body, auth, csrf } = {}) {
    const response = await fetch(base + pathname, { method, headers: { ...(auth ? { Cookie: `packsmart_session=${auth}` } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() };
  }
  return { ...f, beta, route, preview, token, request, counters: () => ({ saves, reads, externalCalls }) };
}

test('publication endpoints enforce roles, sessions, tenant isolation, exact selections and no-store', async t => {
  const f = await api(t);
  assert.equal((await f.request(f.preview)).status, 401);
  for (const role of ['admin', 'member', 'viewer']) assert.equal((await f.request(f.preview, { auth: await f.token(role) })).status, 403);
  assert.equal((await f.request(f.preview, { auth: await f.token('owner', f, 999) })).status, 401);
  assert.equal((await f.request(f.preview, { auth: await f.token('owner', f.beta) })).status, 404);
  const auth = await f.token(), preview = await f.request(f.preview, { auth });
  assert.equal(preview.status, 200, JSON.stringify(preview.body)); assert.match(preview.cache, /no-store/);
  assert.equal(preview.body.publishingEnabled, false);
  assert.equal((await f.request(f.preview + '&workspaceId=foreign', { auth })).status, 400);
  assert.equal((await f.request(f.preview + '&pageId=202', { auth })).status, 400);
  assert.equal(f.counters().saves, 0); assert.equal(f.counters().externalCalls, 0);
});

test('HTTP production preparation is closed even on durable stores with legacy producers enabled', async t => {
  const f = await api(t, { enabledLegacyProducers: true }), auth = await f.token(), body = await f.body();
  const before = await f.get();
  assert.equal((await f.request(f.route, { method: 'POST', auth, body })).status, 403);
  const csrf = (await f.request('/api/auth/session', { auth })).body.csrf;
  for (const request of [body, { ...body, preparationSimulation: {} }, { ...body, allowPublishing: true }]) {
    const denied = await f.request(f.route, { method: 'POST', auth, csrf, body: request });
    assert.equal(denied.status, request === body ? 409 : 400);
    assert.equal(denied.body.code, request === body ? 'META_PUBLICATION_PREPARATION_CLOSED' : 'META_PUBLICATION_INPUT_INVALID');
  }
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => f.request(f.route, { method: 'POST', auth, csrf, body })));
  assert.ok(concurrent.every(result => result.status === 409 && result.body.code === 'META_PUBLICATION_PREPARATION_CLOSED'));
  const after = await f.get();
  assert.deepEqual(after, before);
  assert.equal(f.counters().saves, 0); assert.equal(f.counters().externalCalls, 0);
  assert.equal((await f.request(`${f.route}/requests/${body.requestId}`, { auth })).body.found, false);
});

test('locally simulated preparation remains reviewable by its owner and generic HTTP execution is closed', async t => {
  const f = await api(t), auth = await f.token(), body = await f.body();
  const csrf = (await f.request('/api/auth/session', { auth })).body.csrf;
  const prepared = await f.prepare(body);
  assert.equal(prepared.executedExternally, false);
  const history = await f.request(`${f.route}/requests/${body.requestId}`, { auth });
  assert.equal(history.body.writeId, prepared.writeId); assert.match(history.cache, /no-store/);
  const approved = await f.request(`/api/approvals/${prepared.approvalId}/decision`, { method: 'POST', auth, csrf, body: { decision: 'approved', revision: 1 } });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const before = f.counters().saves;
  const execution = await f.request(`/api/connection-writes/${prepared.writeId}/execute`, { method: 'POST', auth, csrf, body: {} });
  assert.equal(execution.status, 409); assert.equal(execution.body.code, 'META_PUBLICATION_PRODUCTION_CLOSED');
  assert.equal(f.counters().saves, before); assert.equal(f.counters().externalCalls, 0);
  const foreign = await f.request(`${f.route}/requests/${body.requestId}`, { auth: await f.token('owner', f.beta) });
  assert.equal(foreign.body.found, false);
});

test('normal FileStore cannot prepare a durable publication; quiet startup refuses before storage', async t => {
  const f = await api(t, { durable: false }), auth = await f.token();
  const csrf = (await f.request('/api/auth/session', { auth })).body.csrf;
  const denied = await f.request(f.route, { method: 'POST', auth, csrf, body: await f.body() });
  assert.equal(denied.status, 409); assert.equal(denied.body.code, 'META_PUBLICATION_PREPARATION_CLOSED'); assert.equal(f.counters().saves, 0);
  const q = await api(t, { quiet: true });
  assert.equal((await q.request(q.preview, { auth: await q.token() })).status, 503);
  assert.deepEqual(q.counters(), { saves: 0, reads: 0, externalCalls: 0 });
});

test('saved publication choices are bounded owner-only reads and still require an exact current preview',async t=>{
 const f=await api(t),auth=await f.token();
 assert.equal((await f.request(f.route+'/choices',{auth:await f.token('admin')})).status,403);
 const choices=await f.request(f.route+'/choices',{auth});assert.equal(choices.status,200);assert.match(choices.cache,/no-store/);
 assert.deepEqual(choices.body.pages,[{pageId:'202',instagramId:'303'}]);assert.equal(choices.body.assets[0].assetUrl,f.selection.assetUrl);
 assert.equal(choices.body.publishingEnabled,false);assert.equal(f.counters().saves,0);assert.equal(f.counters().externalCalls,0);
 assert.equal((await f.request(f.route+'/choices?workspaceId=other',{auth})).status,400);
 await f.change(s=>{s.products[0].variants[0].inventory=0;});assert.equal((await f.request(f.preview,{auth})).status,409);
});

for(const [key,value] of [['disabled',true],['status','disabled'],['active','false'],['disabled','false']])test('publication reads reject non-active owner '+key+'='+value,async t=>{
 const f=await api(t),auth=await f.token();await f.change(s=>{s.users[0][key]=value;});
 for(const route of [f.route+'/choices',f.preview])assert.ok([401,403].includes((await f.request(route,{auth})).status));
 assert.equal(f.counters().saves,0);assert.equal(f.counters().externalCalls,0);
});
