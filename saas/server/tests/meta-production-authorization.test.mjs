import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createPacksmartServer} from '../server.mjs';
import {createSessionToken, sessionCookie} from '../lib/security.mjs';
import {productionFixture} from './meta-production-fixture.mjs';

// The production server and authorization run unchanged. Persistence RPCs and
// identities are synthetic; this does not qualify hosted SQL or a deployed fleet.
async function boundaryFixture(t, {enabled = true} = {}) {
  const f = await productionFixture(t), foreign = await productionFixture(t);
  await f.change(s => {
    for (const role of ['admin', 'member', 'viewer']) s.users.push({...s.users[0], id: 'synthetic-' + role,
      email: role + '@example.test', role});
  });
  await f.prepare(); await f.approve();
  const tenants = new Map([f, foreign].map(item => [item.workspaceId, item]));
  const reads = [], writes = [], unexpectedNetwork = [];
  for (const item of tenants.values()) item.network = async url => {
    unexpectedNetwork.push(String(url)); throw Error('Unexpected synthetic transport attempt');
  };
  const store = {
    provider: 'supabase',
    async get(workspaceId, options) {reads.push(workspaceId); return tenants.get(workspaceId)?.store.get(workspaceId, options) ?? null;},
    async getIdentity(workspaceId) {reads.push(workspaceId); return tenants.get(workspaceId)?.store.getIdentity(workspaceId) ?? null;},
    async save(workspaceId, state, options) {writes.push(workspaceId); assert.ok(tenants.has(workspaceId)); return tenants.get(workspaceId).store.save(workspaceId, state, options);},
    async metaProductionRpc(name, body, options) {
      assert.ok(tenants.has(options.workspaceId), 'Authenticated RPC must retain its exact tenant');
      return tenants.get(options.workspaceId).store.metaProductionRpc(name, body, options);
    }
  };
  const env = {...f.env, RUNVARA_META_PUBLICATION: enabled ? 'enabled/v1' : 'disabled/v1'};
  const server = createPacksmartServer(env, {store, integrations: f.integrations, schedulerEnabled: false, agentOpsEnabled: false});
  t.after(async () => {await server.packsmart.drain(); if (server.listening) await new Promise(resolve => server.close(resolve));});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const actor = (item = f, {userId = item.session.userId, role = 'owner', version = 1, ttl = 3600} = {}) => {
    const csrf = 'synthetic-csrf-' + item.workspaceId + '-' + userId;
    const token = createSessionToken({workspaceId: item.workspaceId, userId, role, email: 'synthetic@example.test',
      sessionVersion: version, csrf}, env.SESSION_SECRET, ttl);
    return {token, csrf};
  };
  const owner = actor(), foreignOwner = actor(foreign), root = '/api/meta-production/campaigns/' + f.campaignId;
  const requestRoot = root + '/requests/' + f.body.requestId;
  const routes = [
    {name: 'context', path: root + '/context', method: 'GET'},
    {name: 'proposal', path: root + '/proposals', method: 'POST', body: f.body},
    {name: 'saved review', path: requestRoot, method: 'GET'},
    {name: 'saved image', path: requestRoot + '/image', method: 'GET'},
    {name: 'decision', path: requestRoot + '/decision', method: 'POST', body: {decision: 'approved', consent: f.proposal.consent}},
    {name: 'execution', path: requestRoot + '/execute', method: 'POST', body: {consent: f.proposal.consent}}
  ];
  const http = async (route, options = {}) => {
    const identity = Object.hasOwn(options, 'actor') ? options.actor : owner;
    const csrf = Object.hasOwn(options, 'csrf') ? options.csrf : identity?.csrf;
    const method = options.method ?? route.method, body = options.body ?? route.body;
    const response = await fetch(base + route.path + (options.query ?? ''), {method, redirect: 'error', headers: {
      ...(identity ? {Cookie: sessionCookie(identity.token, {secure: true}).split(';')[0]} : {}),
      ...(csrf ? {'X-CSRF-Token': csrf} : {}), Origin: options.origin ?? env.APP_PUBLIC_URL,
      ...(body && method !== 'GET' ? {'Content-Type': 'application/json'} : {})
    }, ...(body && method !== 'GET' ? {body: JSON.stringify(body)} : {})});
    return {status: response.status, value: await response.json(), cacheControl: response.headers.get('cache-control')};
  };
  const snapshot = async () => ({states: await Promise.all([...tenants.values()].map(item => item.get())),
    events: structuredClone([...tenants.values()].map(item => item.events)),
    readiness: structuredClone([...tenants.values()].map(item => item.readiness)),
    assets: structuredClone([...tenants.values()].map(item => [...item.assetRows])),
    rpcCounts: [...tenants.values()].map(item => item.calls.length), writes: [...writes], unexpectedNetwork: [...unexpectedNetwork]});
  let rejected = 0;
  const deny = async (route, options, status, code, allowedWorkspace = f.workspaceId) => {
    const before = await snapshot(), firstRead = reads.length, response = await http(route, options), label = route.name;
    assert.equal(response.status, status, label + ': ' + JSON.stringify(response.value));
    assert.equal(response.value.code, code, label);
    assert.deepEqual(Object.keys(response.value).sort(), ['code', 'error'], label + ' must not disclose saved fields');
    assert.match(response.cacheControl, /no-store/, label);
    assert.deepEqual(await snapshot(), before, label + ' denial must preserve both tenants and avoid all RPC/write/transport attempts');
    assert.ok(reads.slice(firstRead).every(id => id === allowedWorkspace), label + ' must not load another tenant');
    rejected++;
  };
  // Positive controls prove that a real, current owner reaches the saved routes
  // and that the foreign identity is independently valid in its own tenant.
  for (const route of routes.filter(route => route.method === 'GET')) assert.equal((await http(route)).status, 200, route.name);
  assert.equal((await http({...routes[0], path: '/api/meta-production/campaigns/' + foreign.campaignId + '/context'}, {actor: foreignOwner})).status, 200);
  assert.equal(unexpectedNetwork.length, 0);
  t.after(() => {assert.equal(unexpectedNetwork.length, 0); t.diagnostic('rejected HTTP cases: ' + rejected);});
  return {f, foreign, actor, owner, foreignOwner, routes, http, deny, snapshot, writes, unexpectedNetwork};
}

test('every production route denies unauthenticated and non-owner identities, including forged owner role claims', async t => {
  const h = await boundaryFixture(t);
  for (const route of h.routes) await h.deny(route, {actor: null}, 401, 'AUTH_REQUIRED');
  for (const role of ['admin', 'member', 'viewer']) {
    for (const claim of [role, 'owner']) {
      const actor = h.actor(h.f, {userId: 'synthetic-' + role, role: claim});
      for (const route of h.routes) await h.deny(route, {actor}, 403,
        role === 'viewer' && route.method === 'POST' ? 'ROLE_DENIED' : 'OWNER_APPROVAL_REQUIRED');
    }
  }
});

test('every production route denies expired, stale, inactive and removed owner sessions without side effects', async t => {
  const h = await boundaryFixture(t), owner = structuredClone((await h.f.get()).users[0]);
  for (const [actor, code] of [[h.actor(h.f, {ttl: -60}), 'AUTH_REQUIRED'], [h.actor(h.f, {version: 999}), 'SESSION_INVALID']]) {
    for (const route of h.routes) await h.deny(route, {actor}, 401, code);
  }
  await h.f.change(s => {s.users[0].active = false;});
  for (const route of h.routes) await h.deny(route, {}, 401, 'SESSION_INVALID');
  await h.f.change(s => {s.users = s.users.filter(user => user.id !== owner.id);});
  for (const route of h.routes) await h.deny(route, {}, 401, 'SESSION_INVALID');
});

test('production mutations require the owner session CSRF token and same-origin header; routes reject scope overrides', async t => {
  const h = await boundaryFixture(t);
  for (const route of h.routes.filter(route => route.method === 'POST')) {
    for (const csrf of [null, 'synthetic-wrong-token', h.foreignOwner.csrf]) await h.deny(route, {csrf}, 403, 'CSRF_INVALID');
    await h.deny(route, {origin: 'https://foreign.example.test'}, 403, 'ORIGIN_DENIED');
    await h.deny(route, {body: {...route.body, workspaceId: h.foreign.workspaceId}}, 400, 'META_PRODUCTION_INPUT_INVALID');
  }
  for (const route of h.routes) {
    await h.deny(route, {query: '?workspaceId=' + h.foreign.workspaceId}, 400, 'META_PRODUCTION_INPUT_INVALID');
    await h.deny(route, {method: 'PUT'}, 405, 'METHOD_NOT_ALLOWED');
  }
});

test('a valid foreign owner cannot read, approve, prepare or execute another tenant production request', async t => {
  const h = await boundaryFixture(t);
  assert.notEqual(h.f.workspaceId, h.foreign.workspaceId); assert.notEqual(h.f.campaignId, h.foreign.campaignId);
  for (const route of h.routes) await h.deny(route, {actor: h.foreignOwner}, 404,
    ['context', 'proposal'].includes(route.name) ? 'MARKETING_CAMPAIGN_NOT_FOUND' : 'META_PRODUCTION_NOT_FOUND', h.foreign.workspaceId);
});

test('disabled production HTTP keeps exact owner review and revocation available but closes preparation, approval and execution', async t => {
  const h = await boundaryFixture(t, {enabled: false});
  const context = await h.http(h.routes[0]); assert.equal(context.value.enabled, false);
  const saved = await h.http(h.routes[2]); assert.deepEqual(saved.value.consent, h.f.proposal.consent);
  assert.equal(saved.value.retained.publishingEnabled, false);
  const image = await h.http(h.routes[3]); assert.equal(image.value.bytesBase64, h.f.body.jpegBase64);
  assert.equal(image.value.sha256, h.f.proposal.consent.imageSha256);
  for (const route of h.routes.filter(route => route.method === 'POST')) await h.deny(route, {}, 503, 'META_PRODUCTION_CLOSED');
  for (const route of h.routes) await h.deny(route, {actor: h.actor(h.f, {userId: 'synthetic-admin', role: 'owner'})}, 403, 'OWNER_APPROVAL_REQUIRED');
  const before = await h.snapshot();
  const rejected = await h.http(h.routes[4], {body: {decision: 'rejected', consent: h.f.proposal.consent}});
  assert.equal(rejected.status, 200); assert.equal(rejected.value.status, 'rejected');
  const after = await h.snapshot();
  assert.deepEqual(after.states[1], before.states[1]); assert.deepEqual(after.events, before.events);
  assert.deepEqual(after.readiness, before.readiness); assert.deepEqual(after.assets, before.assets);
  assert.deepEqual(after.rpcCounts, before.rpcCounts); assert.deepEqual(after.writes, [...before.writes, h.f.workspaceId]);
  const oldApproval = before.states[0].approvals.find(a => a.id === h.f.proposal.approvalId);
  const newApproval = after.states[0].approvals.find(a => a.id === h.f.proposal.approvalId);
  const decisionAt = newApproval.decidedAt, historyAt = newApproval.history.at(-1).at;
  assert.equal(new Date(decisionAt).toISOString(), decisionAt); assert.equal(new Date(historyAt).toISOString(), historyAt);
  assert.deepEqual(newApproval, {...oldApproval, status: 'rejected', decidedAt: decisionAt, decidedBy: h.f.session.userId,
    history: [...oldApproval.history, {revision: oldApproval.revision, status: 'rejected', actor: h.f.session.userId, at: historyAt}]});
  const audit = after.states[0].audit[0];
  assert.equal(audit.type, 'meta_production_decided'); assert.equal(audit.actor, h.f.session.userId);
  assert.deepEqual(audit.detail, {approvalId: oldApproval.id, bindingDigest: oldApproval.payload.bindingDigest, decision: 'rejected'});
  assert.notEqual(after.states[0]._revision, before.states[0]._revision);
  assert.deepEqual(after.states[0], {...before.states[0], _revision: after.states[0]._revision,
    approvals: before.states[0].approvals.map(a => a.id === oldApproval.id ? newApproval : a), audit: [audit, ...before.states[0].audit]});
  assert.equal((await h.http(h.routes[2])).value.status, 'rejected');
  assert.equal((await h.http(h.routes[3])).value.bytesBase64, h.f.body.jpegBase64);
  assert.deepEqual((await h.snapshot()).states, after.states);
  t.diagnostic('closed HTTP recovery: exact review/image and one retained revocation; zero provider transport');
});
