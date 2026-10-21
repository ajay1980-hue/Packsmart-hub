import test from 'node:test';
import assert from 'node:assert/strict';
import {productionFixture} from './meta-production-fixture.mjs';
import {createStore} from '../lib/store.mjs';
import {createMetaProductionController} from '../lib/meta-production.mjs';
import {encryptCredentials} from '../lib/security.mjs';
import {publicApproval} from '../lib/action-display.mjs';
import {fakeSupabase} from './fake-supabase.mjs';
import {createServer} from 'node:http';
import {gzipSync, deflateSync, brotliCompressSync} from 'node:zlib';
import {decodedMetaProductionResponse} from '../lib/meta-production-transport.mjs';
import {metaBoundedBytes} from '../lib/meta-publication-bounded.mjs';

test('production defaults closed before DB mutation, credentials or provider access', async t => {
  const f = await productionFixture(t), before = await f.get();
  for (const patch of [{RUNVARA_META_PUBLICATION: undefined}, {APP_PUBLIC_URL: 'https://other.invalid'}, {CREDENTIALS_KEY: ''}, {META_CLIENT_SECRET: ''}]) {
    const controller = f.reopen({...f.env, ...patch});
    assert.equal(controller.enabled, false);
    assert.equal((await controller.context(f.campaignId, f.session)).enabled, false);
    await assert.rejects(controller.prepare(f.campaignId, f.body, f.session), {code: 'META_PRODUCTION_CLOSED'});
    await assert.rejects(controller.deliver('a'.repeat(64), 'b'.repeat(64)), {code: 'META_PRODUCTION_CLOSED'});
  }
  assert.deepEqual(await f.get(), before); assert.equal(f.calls.length, 0); assert.equal(f.providerCalls.length, 0);
});

test('real controller, IntegrationService and serializer use injected network; exact image/approval and restart cannot resend', async t => {
  const f = await productionFixture(t); await f.prepare();
  assert.equal(f.providerCalls.length, 0); assert.equal(f.assetCalls.length, 0);
  const image = await f.controller.image(f.campaignId, f.body.requestId, f.session);
  assert.deepEqual(Buffer.from(image.bytesBase64, 'base64'), f.bytes);
  await assert.rejects(f.execute(), {code: 'META_PRODUCTION_CONSENT_CHANGED'});
  await f.approve(); const result = await f.execute(); assert.equal(result.resultId, '900002');
  const posts = f.providerCalls.filter(c => c.options.method === 'POST'); assert.equal(posts.length, 2);
  for (const c of f.providerCalls) {assert.equal(c.options.redirect, 'error'); assert.match(c.url, /^https:\/\/graph.facebook.com\/v/);}
  for (const c of posts) assert.equal(c.options.headers.Authorization, 'Bearer synthetic-page-token');
  const first = JSON.parse(posts[0].options.body); assert.equal(first.caption, f.proposal.consent.caption);
  assert.match(first.image_url, /^https:\/\/packsmart-ops.onrender.com\/api\/meta-publication-assets\/production-v1\/[a-f0-9]{64}\/[a-f0-9]{64}\.jpg$/);
  assert.deepEqual(JSON.parse(posts[1].options.body), {creation_id: '900001'});
  assert.equal(f.assetCalls.length, 2); assert.equal(f.assetCalls[0].options.headers.Authorization, undefined);
  f.controller = f.reopen(); const saved = await f.read(); assert.equal(saved.retained.phase, 'published');
  assert.equal(saved.retained.canContinue, false); assert.equal((await f.execute()).resultId, '900002');
  assert.equal(f.providerCalls.filter(c => c.options.method === 'POST').length, 2);
  const publicView = JSON.stringify(publicApproval((await f.get()).approvals[0]));
  assert.ok(!publicView.includes('tokenDigest')); assert.ok(!publicView.includes('encryptedCredentials'));
  assert.equal(JSON.parse(publicView).payload.metaProduction.requestId, f.body.requestId);
});

test('exact consent, source changes, owner/session and tenant boundary prevent dispatch', async t => {
  const f = await productionFixture(t); await f.prepare();
  const consent = {...f.proposal.consent, caption: f.proposal.consent.caption + '!'};
  await assert.rejects(f.controller.decide(f.campaignId, f.body.requestId, {decision: 'approved', consent}, f.session), {code: 'META_PRODUCTION_CONSENT_CHANGED'});
  for (const session of [{...f.session, sessionVersion: 2}, {...f.session, userId: 'other-owner'}, {...f.session, workspaceId: 'other-workspace'}]) {
    await assert.rejects(f.controller.read(f.campaignId, f.body.requestId, session));
  }
  await f.approve(); await f.change(s => {s.economics.BAGS.landed += 0.000001;});
  await assert.rejects(f.execute()); assert.equal(f.providerCalls.length, 0);
});

test('repeating a proposal requires the same frozen asset/selection/expiry and keeps one approval', async t => {
  const f = await productionFixture(t); await f.prepare();
  assert.equal((await f.prepare()).replayed, true);
  for (const body of [{...f.body, expiresAt: f.body.expiresAt + 1}, {...f.body, selection: {...f.selection, pageId: '999'}}]) {
    await assert.rejects(f.controller.prepare(f.campaignId, body, f.session), {code: 'META_PRODUCTION_REQUEST_CONFLICT'});
  }
  assert.equal((await f.get()).approvals.filter(a => a.type === 'protected_meta_production_publication').length, 1);
});

test('unknown container acknowledgement remains held across new controller; GET recovery never calls provider', async t => {
  const f = await productionFixture(t); await f.prepare(); await f.approve();
  f.providerHook = path => {if (path === '/303/media') throw Error('synthetic unknown');};
  await assert.rejects(f.execute()); const count = f.providerCalls.length;
  f.controller = f.reopen(); const result = await f.read(); assert.equal(result.retained.phase, 'container_unresolved'); assert.equal(result.retained.canContinue, false);
  await f.execute(); assert.equal(f.providerCalls.length, count); assert.equal(f.providerCalls.filter(c => c.options.method === 'POST').length, 1);
});

test('readiness IN_PROGRESS cannot publish; explicit next action within cadence does not poll', async t => {
  const f = await productionFixture(t); await f.prepare(); await f.approve();
  f.providerHook = path => path === '/900001' ? Response.json({id: '900001', status_code: 'IN_PROGRESS'}) : undefined;
  await f.execute(); await f.execute();
  assert.equal(f.providerCalls.filter(c => c.p === '/900001').length, 1);
  assert.equal(f.providerCalls.filter(c => c.p === '/303/media_publish').length, 0);
  const retained = (await f.read()).retained;
  assert.equal(retained.phase, 'readiness_waiting'); assert.equal(retained.canContinue, false);
  assert.ok(Date.parse(retained.retryAfter) > Date.now());
});

test('lost and terminal readiness responses stay closed in retained recovery without another provider call', async t => {
  for (const status of [null, 'ERROR', 'EXPIRED', 'PUBLISHED']) {
    const f = await productionFixture(t); await f.prepare(); await f.approve();
    f.providerHook = path => {if (path === '/900001') {if (status === null) throw Error('synthetic lost readiness'); return Response.json({id: '900001', status_code: status});}};
    if (status === null) await assert.rejects(f.execute()); else await f.execute();
    const count = f.providerCalls.length; f.controller = f.reopen();
    const retained = (await f.read()).retained;
    assert.equal(retained.phase, status === null ? 'readiness_unresolved' : status === 'PUBLISHED' ? 'publication_id_unresolved' : 'container_' + status.toLowerCase());
    assert.equal(retained.canContinue, false); assert.equal(retained.resultId, null);
    await f.execute(); assert.equal(f.providerCalls.length, count);
    assert.equal(f.providerCalls.filter(c => c.p === '/303/media_publish').length, 0);
  }
});

test('actual Node fetch decoded gzip, deflate and brotli retain bounded production JSON and exact JPEG bytes', async t => {
  for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]]) {
    let pending, seen = 0;
    const server = createServer((req, res) => {
      assert.equal(req.headers['accept-encoding'], 'identity'); seen++;
      const body = compress(pending.bytes);
      res.writeHead(200, {'Content-Type': pending.mediaType, 'Content-Encoding': encoding, 'Content-Length': body.length}); res.end(body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const f = await productionFixture(t), network = f.network;
      f.network = async (url, options) => {
        const response = await network(url, options);
        pending = {bytes: Buffer.from(await response.arrayBuffer()), mediaType: response.headers.get('content-type')};
        return fetch('http://127.0.0.1:' + server.address().port, {signal: options.signal, redirect: 'error', headers: {'Accept-Encoding': options.headers['Accept-Encoding']}});
      };
      await f.prepare(); await f.approve(); assert.equal((await f.execute()).resultId, '900002');
      assert.equal(seen, f.providerCalls.length + f.assetCalls.length);
      assert.equal(f.providerCalls.filter(c => c.options.method === 'POST').length, 2);
    } finally {await new Promise(resolve => server.close(resolve));}
  }
});

test('production decoded response adaptation preserves redirect, error, media and decoded-size rejection', async () => {
  const read = response => metaBoundedBytes(() => decodedMetaProductionResponse(response, 64), {maxBytes: 64, mediaType: 'application/json'});
  for (const [body, headers, status, redirected] of [
    ['{}', {'content-encoding': 'gzip'}, 200, true],
    ['{}', {'content-encoding': 'gzip'}, 500, false],
    ['{}', {'content-encoding': 'unknown'}, 200, false],
    ['{}', {'content-encoding': 'gzip', 'content-type': 'text/html'}, 200, false],
    ['x'.repeat(65), {'content-encoding': 'gzip', 'content-length': '20'}, 200, false],
    ['{}', {'content-encoding': 'gzip', 'content-length': '999'}, 200, false],
    ['{}', {'content-encoding': 'gzip', 'content-length': 'bad'}, 200, false],
    ['{}', {'content-encoding': 'identity', 'content-length': '3'}, 200, false]
  ]) {
    const response = new Response(body, {status, headers: {'content-type': 'application/json', ...headers}});
    await assert.rejects(read({status, redirected, headers: response.headers, body: response.body}), {code: 'META_DELIVERY_RESPONSE_UNKNOWN'});
  }
});

test('expired connection cannot refresh OAuth and owner revocation during credential resolution cannot send', async t => {
  const f = await productionFixture(t); await f.prepare(); await f.approve();
  await f.change(s => {s.connections[0].encryptedCredentials = encryptCredentials({accessToken: 'synthetic-expired', expiresAt: Date.now() - 1, refreshToken: 'synthetic-never-use'}, f.env.CREDENTIALS_KEY);});
  await assert.rejects(f.execute()); assert.equal(f.providerCalls.length, 0);
  const g = await productionFixture(t); await g.prepare(); await g.approve();
  const original = g.integrations.connectorCredentials.bind(g.integrations);
  g.integrations.connectorCredentials = async (...args) => {const result = await original(...args); await g.change(s => {s.users[0].sessionVersion += 1;}); return result;};
  await assert.rejects(g.execute()); assert.equal(g.providerCalls.length, 0);
});

test('Supabase production bridge rejects duplicate JSON keys, foreign scope and arbitrary RPC; no automatic resend', async () => {
  let calls = 0, duplicate = true;
  const store = createStore({SUPABASE_URL: 'https://synthetic-db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-role'}, {fetchImpl: async () => {
    calls++; return new Response(duplicate ? '{"value":1,"value":2}' : '{"value":1}', {headers: {'content-type': 'application/json'}});
  }});
  const body = {p_request: JSON.stringify({workspaceId: 'scope-a'})};
  await assert.rejects(store.metaProductionRpc('arbitrary', body, {workspaceId: 'scope-a'}));
  await assert.rejects(store.metaProductionRpc('runvara_read_meta_prod_asset_v1', body, {workspaceId: 'scope-b'}));
  assert.equal(calls, 0);
  await assert.rejects(store.metaProductionRpc('runvara_read_meta_prod_asset_v1', body, {workspaceId: 'scope-a'}), {code: 'SUPABASE_RESPONSE_INVALID'});
  assert.equal(calls, 1); duplicate = false;
  assert.deepEqual(await (await store.metaProductionRpc('runvara_read_meta_prod_asset_v1', body, {workspaceId: 'scope-a'})).json(), {value: 1});
});

test('delivery closes after approval revocation or source change even with an already-issued bearer URL', async t => {
  for (const changedSource of [false, true]) {
    const f = await productionFixture(t); await f.prepare(); await f.approve(); await f.execute();
    const parts = new URL(f.assetCalls[0].url).pathname.split('/'), digest = parts.at(-2), token = parts.at(-1).slice(0, -4);
    if (changedSource) await f.change(s => {s.economics.BAGS.landed += 0.000001;});
    else await f.controller.decide(f.campaignId, f.body.requestId, {decision: 'rejected', consent: f.proposal.consent}, f.session);
    await assert.rejects(f.controller.deliver(digest, token));
    assert.equal((await f.controller.image(f.campaignId, f.body.requestId, f.session)).bytesBase64, f.body.jpegBase64);
  }
});

test('normal Supabase store preserves exact stored snapshot and completes the production controller through injected PostgREST', async t => {
  const f = await productionFixture(t), initial = await f.get(), fake = fakeSupabase();
  delete initial.storageReady;
  fake.states.set(f.workspaceId, structuredClone(initial));
  const fetchImpl = async (url, options) => {
    const name = new URL(url).pathname.split('/').at(-1);
    if (/^runvara_(?:commit|read|lookup|deliver)_meta_prod_/.test(name)) return f.rpc(name, JSON.parse(options.body), {signal: options.signal});
    return fake.fetchImpl(url, options);
  };
  f.store = createStore({SUPABASE_URL: 'https://synthetic-db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-role'}, {fetchImpl});
  f.get = () => f.store.get(f.workspaceId, {exactSnapshot: true});
  assert.deepEqual(structuredClone(await f.get()), initial);
  assert.equal((await f.store.get(f.workspaceId)).storageReady, true);
  f.controller = f.reopen(); await f.prepare(); await f.approve(); assert.equal((await f.execute()).resultId, '900002');
  const assetRequest = f.calls.find(c => c.name === 'runvara_commit_meta_prod_asset_v1').r;
  assert.equal(Object.hasOwn(assetRequest.expectedState, 'storageReady'), false);
  assert.equal(f.providerCalls.filter(c => c.options.method === 'POST').length, 2);
});
