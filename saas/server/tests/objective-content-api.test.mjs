import test from 'node:test';
import assert from 'node:assert/strict';
import { objectiveContentApiFixture, OBJECTIVE_CONTENT_POST as POST, OBJECTIVE_CONTENT_PRODUCT as PRODUCT,
  OBJECTIVE_CONTENT_OPPORTUNITY as OPPORTUNITY } from './objective-content-test-fixture.mjs';

const route = requestId => `${POST}/${requestId}`;
const post = (f, body, options = {}) => f.request(POST, { method: 'POST', body, ...options });
const assertCode = (response, status, code) => { assert.equal(response.status, status, JSON.stringify(response.body)); assert.equal(response.body.code, code); };
const noRequests = async f => { const state = await f.store.get(f.workspaceId); assert.equal(state.connectionWrites.length, 0); assert.equal(state.approvals.length, 0); };

test('objective content API creates one owner-bound request from a real succeeded diagnostic and keeps approval/apply separate', async t => {
  const f = await objectiveContentApiFixture(t), before = await f.store.get(f.workspaceId), context = await f.context();
  assert.equal(context.schema, 'runvara-objective-content-context/v1'); assert.match(context.sourceRevision, /^[0-9a-f]{64}$/);
  assert.equal(context.product.id, PRODUCT); assert.equal(context.product.provenance, 'unverified');
  assert.equal(context.candidate.opportunityId, OPPORTUNITY); assert.match(context.notice, /not execution proof|not independently authenticated/);
  assert.deepEqual(await f.store.get(f.workspaceId), before, 'context GET does not save state');
  const body = f.body(context), created = await post(f, body);
  assert.equal(created.status, 200, JSON.stringify(created.body)); assert.equal(created.body.found, true);
  assert.equal(created.body.request.origin, 'owner_objective_content'); assert.equal(created.body.request.status, 'pending_approval');
  assert.equal(created.body.request.source.actorId, f.actorId); assert.equal(created.body.request.source.actorSessionVersion, 1);
  assert.equal(created.body.sourceStatus.status, 'current');
  const duplicate = await post(f, body); assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.request.id, created.body.request.id);
  const state = await f.store.get(f.workspaceId); assert.equal(state.connectionWrites.length, 1); assert.equal(state.approvals.length, 1);
  assert.equal(state.approvals[0].status, 'pending'); assert.equal(state.approvals[0].executedExternally, false);
  assert.equal(state.connectionWrites[0].dispatchClaim, undefined);
  const read = await f.request(route(body.requestId)); assert.equal(read.status, 200); assert.deepEqual(read.body, created.body);
  const historical = await f.request(`/api/business-objectives/reviews/${f.jobId}?report=true`);
  assert.equal(historical.status, 200); assert.equal(historical.body.stale, true, 'own-approval comparison does not rewrite ordinary review currentness');
});

test('objective content routes enforce owner role, authentication, CSRF and current account security epoch', async t => {
  const f = await objectiveContentApiFixture(t), body = f.body(await f.context());
  assertCode(await f.request(f.contextRoute, { identity: null }), 401, 'AUTH_REQUIRED');
  assert.equal((await post(f, body, { csrf: false })).status, 403);
  for (const role of ['admin', 'viewer']) {
    const identity = f.auth(f.workspaceId, role);
    assertCode(await f.request(f.contextRoute, { identity }), 403, 'OWNER_APPROVAL_REQUIRED');
    assertCode(await post(f, body, { identity }), 403, role === 'viewer' ? 'ROLE_DENIED' : 'OWNER_APPROVAL_REQUIRED');
    assertCode(await f.request(route(body.requestId), { identity }), 403, 'OWNER_APPROVAL_REQUIRED');
  }
  await f.change(state => { state.users[0].sessionVersion = 2; });
  assertCode(await post(f, body), 401, 'SESSION_INVALID');
  const currentIdentity = f.auth(f.workspaceId, 'owner', 2);
  assertCode(await post(f, body, { identity: currentIdentity }), 409, 'OBJECTIVE_CONTENT_SOURCE_CHANGED');
  await noRequests(f);
});

test('objective content rejects missing or forged source revision, client authority, and unconfirmed destinations without saving', async t => {
  const f = await objectiveContentApiFixture(t), body = f.body(await f.context());
  const { sourceRevision: omitted, ...missing } = body;
  assertCode(await post(f, missing), 400, 'OBJECTIVE_CONTENT_INPUT_INVALID');
  assertCode(await post(f, { ...body, sourceRevision: '0'.repeat(64) }), 409, 'OBJECTIVE_CONTENT_SOURCE_CHANGED');
  for (const extra of [{ source: {} }, { origin: 'owner_manual' }, { objectivePolicyProposal: {} }, { financialEvidence: {} }, { workspaceId: 'content-beta' }]) {
    assertCode(await post(f, { ...body, ...extra }), 400, 'OBJECTIVE_CONTENT_INPUT_INVALID');
  }
  assertCode(await post(f, { ...body, confirmedDestinationProduct: false }), 400, 'OBJECTIVE_CONTENT_INPUT_INVALID');
  assert.equal((await post(f, { ...body, target: { ...body.target, account: 'different.myshopify.com' } })).status, 409);
  assert.equal((await f.request(f.contextRoute + '&jobId=' + f.jobId)).status, 400);
  assert.equal((await f.request(f.contextRoute + '&workspaceId=content-beta')).status, 400);
  assert.equal((await f.request(route(body.requestId) + '?all=true')).status, 400);
  assertCode(await post(f, { ...body, description: 'x'.repeat(24000) }), 413, 'REQUEST_TOO_LARGE');
  await noRequests(f);
});

test('objective content fails closed for stale retained product, changed report, unavailable history and foreign tenant', async t => {
  for (const kind of ['product', 'report', 'missing-job', 'foreign-tenant']) {
    await t.test(kind, async t => {
      const f = await objectiveContentApiFixture(t), body = f.body(await f.context());
      if (kind === 'product') await f.change(state => { state.products[0].description += ' Changed after review.'; });
      if (kind === 'report') f.store.agentJobs.find(row => row.id === f.jobId).result.summary.proposalsReady = 1;
      if (kind === 'missing-job') f.store.agentJobs = [];
      if (kind === 'foreign-tenant') assertCode(await f.request(f.contextRoute, { identity: f.auth('content-beta') }), 409, 'OBJECTIVE_CONTENT_SOURCE_UNAVAILABLE');
      const response = await post(f, body, kind === 'foreign-tenant' ? { identity: f.auth('content-beta') } : {});
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.ok(['OBJECTIVE_CONTENT_SOURCE_CHANGED', 'OBJECTIVE_CONTENT_SOURCE_UNAVAILABLE', 'WRITE_TARGET_CHANGED'].includes(response.body.code), response.body.code);
      await noRequests(f);
    });
  }
});

test('a separate job changed between preparation reads is rejected while workspace revision remains unchanged', async t => {
  const f = await objectiveContentApiFixture(t), body = f.body(await f.context()), before = await f.store.get(f.workspaceId);
  const getJob = f.store.getAgentJob.bind(f.store); let reads = 0;
  f.store.getAgentJob = async (...args) => {
    const value = await getJob(...args);
    if (++reads === 1) f.store.agentJobs.find(row => row.id === f.jobId).result.summary.proposalsReady = 1;
    return value;
  };
  assertCode(await post(f, body), 409, 'OBJECTIVE_CONTENT_SOURCE_CHANGED');
  assert.equal(reads, 2); assert.equal((await f.store.get(f.workspaceId))._revision, before._revision);
  await noRequests(f);
});

test('exact request reconciliation scans beyond the newest 50 and reports changed or unavailable source as retained history', async t => {
  const f = await objectiveContentApiFixture(t), body = f.body(await f.context());
  const created = await post(f, body); assert.equal(created.status, 200, JSON.stringify(created.body));
  await f.change(state => { state.connectionWrites.unshift(...Array.from({ length: 55 }, (_, i) => ({
    id: `write_filler_${i}`, requestId: `manual_filler_request_${i}`, provider: 'shopify', requestedBy: f.actorId, input: { operation: 'internal_note' }, status: 'completed'
  }))); });
  let exact = await f.request(route(body.requestId)); assert.equal(exact.status, 200); assert.equal(exact.body.found, true);
  assert.equal(exact.body.request.id, created.body.request.id); assert.equal(exact.body.sourceStatus.status, 'current');
  await f.change(state => { state.products[0].description = 'Changed retained baseline'; });
  exact = await f.request(route(body.requestId)); assert.equal(exact.status, 200); assert.equal(exact.body.sourceStatus.status, 'changed');
  f.store.agentJobs = [];
  exact = await f.request(route(body.requestId)); assert.equal(exact.status, 200); assert.equal(exact.body.sourceStatus.status, 'unavailable');
  assert.equal(exact.body.request.source.resultDigest, created.body.request.source.resultDigest);
  const missing = await f.request(route('objective_missing_request_999')); assert.equal(missing.status, 200); assert.equal(missing.body.found, false);
});

test('duplicate request identities and manual/objective request-ID collisions cannot rebind source in either direction', async t => {
  const f = await objectiveContentApiFixture(t), body = f.body(await f.context());
  const created = await post(f, body); assert.equal(created.status, 200, JSON.stringify(created.body));
  const manualBody = { operation: 'product_content', requestId: body.requestId, target: body.target, productId: body.productId, title: body.title, description: body.description };
  assertCode(await f.request('/api/connections/shopify/writes', { method: 'POST', body: manualBody }), 409, 'WRITE_CONFLICT');
  assertCode(await f.request('/api/connections/shopify/content-requests/' + body.requestId), 409, 'WRITE_CONFLICT');
  assertCode(await post(f, { ...body, title: 'Another exact title' }), 409, 'WRITE_CONFLICT');
  await f.change(state => { state.connectionWrites.push(structuredClone(state.connectionWrites[0])); });
  assertCode(await f.request(route(body.requestId)), 409, 'WRITE_CONFLICT');
  assertCode(await post(f, body), 409, 'WRITE_CONFLICT');
  const other = await objectiveContentApiFixture(t), selected = other.body(await other.context(), 'manual_first_request_001');
  const manual = await other.request('/api/connections/shopify/writes', { method: 'POST', body: {
    operation: 'product_content', requestId: selected.requestId, target: selected.target, productId: selected.productId, title: selected.title, description: selected.description
  } });
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
  assertCode(await post(other, selected), 409, 'WRITE_CONFLICT');
  assertCode(await other.request(route(selected.requestId)), 409, 'WRITE_CONFLICT');
});

test('lost save acknowledgement returns unknown and exact reconciliation keeps the original ID without another write', async t => {
  const f = await objectiveContentApiFixture(t), body = f.body(await f.context()), save = f.store.save.bind(f.store); let saves = 0;
  f.store.save = async (...args) => { saves++; await save(...args); throw new TypeError('Synthetic lost response'); };
  assertCode(await post(f, body), 503, 'OBJECTIVE_CONTENT_SAVE_UNKNOWN');
  const exact = await f.request(route(body.requestId)); assert.equal(exact.status, 200); assert.equal(exact.body.requestId, body.requestId);
  assert.equal(exact.body.found, true); assert.equal(exact.body.sourceStatus.status, 'current');
  assert.equal(saves, 1); assert.equal((await f.store.get(f.workspaceId)).connectionWrites.length, 1);
  const foreign = await f.request(route(body.requestId), { identity: f.auth('content-beta') });
  assert.equal(foreign.status, 200); assert.equal(foreign.body.found, false); assert.equal(foreign.body.request, null);
});

test('late local source mutation after acknowledged save returns unknown while retaining the original committed request', async t => {
  const f = await objectiveContentApiFixture(t), body = f.body(await f.context()), save = f.store.save.bind(f.store);
  f.store.save = async (workspaceId, state, options) => {
    const saved = await save(workspaceId, state, options);
    state.products[0].title = 'Late mutation';
    return saved;
  };
  assertCode(await post(f, body), 503, 'OBJECTIVE_CONTENT_SAVE_UNKNOWN');
  const exact = await f.request(route(body.requestId)); assert.equal(exact.status, 200); assert.equal(exact.body.found, true);
  assert.equal(exact.body.requestId, body.requestId); assert.equal(exact.body.sourceStatus.status, 'current');
  assert.equal((await f.store.get(f.workspaceId)).products[0].title, 'Box');
});

test('an absent reconciliation does not erase an unknown request whose original save can still commit later', async t => {
  const f = await objectiveContentApiFixture(t), body = f.body(await f.context()), save = f.store.save.bind(f.store);
  let release, pendingSave, saves = 0;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  f.store.save = async (...args) => {
    saves++;
    pendingSave = gate.then(() => save(...args));
    throw new TypeError('Synthetic response lost before the in-flight save finishes');
  };
  assertCode(await post(f, body), 503, 'OBJECTIVE_CONTENT_SAVE_UNKNOWN');
  const absent = await f.request(route(body.requestId));
  assert.equal(absent.status, 200); assert.equal(absent.body.found, false); assert.equal(absent.body.requestId, body.requestId);
  release(); await pendingSave;
  const found = await f.request(route(body.requestId));
  assert.equal(found.status, 200); assert.equal(found.body.found, true); assert.equal(found.body.requestId, body.requestId);
  assert.equal(found.body.sourceStatus.status, 'current'); assert.equal(saves, 1);
});

test('the fresh mutation snapshot rejects role, security epoch, password and duplicate-owner changes after initial authentication', async t => {
  for (const kind of ['role', 'epoch', 'password', 'duplicate-owner']) {
    await t.test(kind, async t => {
      const f = await objectiveContentApiFixture(t), body = f.body(await f.context());
      const getIdentity = f.store.getIdentity.bind(f.store); let changed = false;
      f.store.getIdentity = async workspaceId => {
        const identity = await getIdentity(workspaceId);
        if (!changed) {
          changed = true;
          await f.change(state => {
            if (kind === 'role') state.users[0].role = 'viewer';
            if (kind === 'epoch') state.users[0].sessionVersion++;
            if (kind === 'password') state.users[0].passwordChangeRequired = true;
            if (kind === 'duplicate-owner') state.users.push(structuredClone(state.users[0]));
          });
        }
        return identity;
      };
      assertCode(await post(f, body), ['role', 'epoch'].includes(kind) ? 401 : 403,
        ['role', 'epoch'].includes(kind) ? 'SESSION_INVALID' : 'WRITE_ACTOR_CHANGED');
      await noRequests(f);
    });
  }
});

test('objective content read and preparation routes share a bounded owner request rate', async t => {
  const f = await objectiveContentApiFixture(t);
  for (let i = 0; i < 20; i++) assert.equal((await f.request(route('missing_exact_request_001'))).status, 200);
  assertCode(await f.request(f.contextRoute), 429, 'OBJECTIVE_CONTENT_RATE_LIMITED');
  await noRequests(f);
});
