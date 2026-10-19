import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createPacksmartServer} from '../server.mjs';
import {createSessionToken, sessionCookie} from '../lib/security.mjs';
import {productionFixture} from './meta-production-fixture.mjs';

async function apiFixture(t, {enabled = true} = {}) {
  const f = await productionFixture(t);
  await f.change(s => {s.users.push({...s.users[0], id: 'admin-user', role: 'admin'});});
  const env = {...f.env, ...(!enabled ? {RUNVARA_META_PUBLICATION: undefined} : {})};
  const server = createPacksmartServer(env, {store: f.store, integrations: f.integrations, schedulerEnabled: false, agentOpsEnabled: false});
  t.after(async () => {await server.packsmart.drain(); if (server.listening) await new Promise(resolve => server.close(resolve));});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  f.token = (role = 'owner', version = 1) => createSessionToken({workspaceId: f.workspaceId, userId: role === 'owner' ? f.session.userId : 'admin-user', role, email: 'synthetic@example.test', sessionVersion: version}, env.SESSION_SECRET);
  f.http = async (route, {method = 'GET', body, token, csrf, origin = env.APP_PUBLIC_URL} = {}) => {
    const response = await fetch(base + route, {method, headers: {...(token ? {Cookie: sessionCookie(token, {secure: true}).split(';')[0]} : {}),
      ...(csrf ? {'X-CSRF-Token': csrf, Origin: origin} : {}), ...(body ? {'Content-Type': 'application/json'} : {})},
      ...(body ? {body: JSON.stringify(body)} : {})});
    return {status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer())};
  };
  f.route = '/api/meta-production/campaigns/' + f.campaignId;
  f.ownerToken = f.token(); f.csrf = JSON.parse((await f.http('/api/auth/session', {token: f.ownerToken})).bytes).csrf;
  f.post = (route, body) => f.http(route, {method: 'POST', token: f.ownerToken, csrf: f.csrf, body});
  return f;
}

test('registered production routes enforce owner/session, CSRF, query scope and default-closed state', async t => {
  const f = await apiFixture(t, {enabled: false}), route = f.route + '/context';
  assert.equal((await f.http(route)).status, 401);
  assert.equal((await f.http(route, {token: f.token('admin')})).status, 403);
  assert.equal((await f.http(route, {token: f.token('owner', 999)})).status, 401);
  const context = await f.http(route, {token: f.ownerToken}); assert.equal(context.status, 200); assert.equal(JSON.parse(context.bytes).enabled, false);
  assert.match(context.headers.get('cache-control'), /no-store/);
  assert.equal((await f.http(route + '?workspaceId=other', {token: f.ownerToken})).status, 400);
  assert.equal((await f.http(f.route + '/proposals', {method: 'POST', token: f.ownerToken, body: f.body})).status, 403);
  assert.equal((await f.post(f.route + '/proposals', f.body)).status, 503);
  assert.equal(f.providerCalls.length, 0); assert.equal(f.calls.length, 0);
});

test('actual HTTP proposal/exact decision/execution/recovery and bearer asset routes are connected', async t => {
  const f = await apiFixture(t), prepared = await f.post(f.route + '/proposals', f.body);
  assert.equal(prepared.status, 200, prepared.bytes.toString()); f.proposal = JSON.parse(prepared.bytes); f.binding = f.proposal.binding;
  const route = f.route + '/requests/' + f.body.requestId;
  assert.equal((await f.post('/api/approvals/' + f.proposal.approvalId + '/decision', {decision: 'approved', revision: 1})).status, 409);
  assert.equal((await f.http('/api/approvals/' + f.proposal.approvalId, {method: 'PATCH', token: f.ownerToken, csrf: f.csrf, body: {action: 'changed'}})).status, 409);
  assert.equal((await f.post(route + '/decision', {decision: 'approved', consent: f.proposal.consent})).status, 200);
  const executed = await f.post(route + '/execute', {consent: f.proposal.consent}); assert.equal(executed.status, 200, executed.bytes.toString());
  assert.equal(JSON.parse(executed.bytes).resultId, '900002');
  const saved = await f.http(route, {token: f.ownerToken}); assert.equal(saved.status, 200); assert.equal(JSON.parse(saved.bytes).retained.phase, 'published');
  const delivered = await f.http(new URL(f.assetCalls[0].url).pathname); assert.equal(delivered.status, 200); assert.deepEqual(delivered.bytes, f.bytes);
  assert.equal(delivered.headers.get('content-type'), 'image/jpeg'); assert.match(delivered.headers.get('cache-control'), /no-store/);
  const hidden = await f.http(new URL(f.assetCalls[0].url).pathname.replace(/.{64}\.jpg$/, '0'.repeat(64) + '.jpg')); assert.equal(hidden.status, 404);
  assert.equal((await f.http(new URL(f.assetCalls[0].url).pathname + '?override=1')).status, 404);
  assert.equal(f.providerCalls.filter(c => c.options.method === 'POST').length, 2);
});
