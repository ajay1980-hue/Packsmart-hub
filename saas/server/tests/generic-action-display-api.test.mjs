import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { objectiveCanonicalDigest } from '../lib/objective-dispatch-policy.mjs';
import { objectiveContentApiFixture, OBJECTIVE_CONTENT_POST, OBJECTIVE_CONTENT_PRODUCT as PRODUCT,
  OBJECTIVE_CONTENT_OPPORTUNITY as OPPORTUNITY } from './objective-content-test-fixture.mjs';
import { objectiveContentFixture, CONTENT_WORKSPACE, CONTENT_PRODUCT } from './objective-content-fixture.mjs';

const ROLES = ['owner', 'admin', 'member', 'viewer'];
const READS = ['/api/bootstrap', '/api/connection-centre', '/api/approvals'];
const SECRET = 'generic-action-display-synthetic-secret-at-least-thirty-two';
const success = (response, status = 200) => assert.equal(response.status, status, JSON.stringify(response.body));
const privateValues = scope => {
  const values = [];
  const value = name => { const next = `PRIVATE_CANARY_${scope}_${name}_never_serialize`; values.push(next); return next; };
  return { values, value };
};
function assertPrivateAbsent(body, privateData, label = '') {
  const json = JSON.stringify(body);
  for (const value of privateData.values) assert.equal(json.includes(value), false, `${label}: exposed ${value}`);
}
function poisonApproval(approval, secret) {
  approval.futurePrivate = { value: secret.value('approval_root') };
  approval.stableApproval = { source: secret.value('stable_approval') };
  approval.payload = { ...approval.payload, futurePrivate: secret.value('payload_future'),
    source: { resultDigest: secret.value('payload_source') }, dispatchClaim: { id: secret.value('payload_claim') },
    objectivePolicyProposal: { source: { inputFingerprint: secret.value('payload_envelope') } } };
  approval.evidence ||= [];
  approval.evidence.push({ type: 'objective_review', id: 'report_public_alias', detail: 'An intentional public evidence narrative.',
    at: '2026-10-08T00:00:00.000Z', source: { actorSessionVersion: secret.value('evidence_source') },
    futurePrivate: [secret.value('evidence_future')] });
  approval.evidence.push({ type: 'reference', id: { private: secret.value('evidence_object_id') }, detail: { private: secret.value('evidence_object_detail') } });
  approval.history ||= [];
  approval.history.push({ revision: 1, status: 'pending', actor: approval.requestedBy, at: '2026-10-08T00:00:00.000Z',
    note: 'An intentional public historical narrative.', reason: 'Keep the previous reviewed reason.',
    payload: { source: secret.value('history_payload') }, futurePrivate: secret.value('history_future'),
    evidence: [{ type: 'reference', id: 'historical_public_alias', detail: 'An intentional historical evidence detail.',
      source: { binding: secret.value('history_evidence_source') }, nested: [secret.value('history_evidence_future')] }] });
}
function poisonWrite(write, secret, { input = true } = {}) {
  write.futurePrivate = { value: secret.value('write_root') };
  write.source = { binding: secret.value('write_source') };
  write.dispatchClaim = { id: secret.value('write_claim'), phases: { hidden: { resultId: secret.value('write_phase') } } };
  write.providerState = { source: secret.value('provider_state') };
  write.recordedActionContext = { source: secret.value('recorded_context') };
  write.stableApproval = { source: secret.value('write_stable_approval') };
  if (input) write.input.futurePrivate = { nested: [secret.value('input_future')] };
  write.result = { externalId: PRODUCT, confirmed: true, recovery: 'Review the recorded result.',
    futurePrivate: { source: secret.value('result_future') }, source: { digest: secret.value('result_source') } };
}
const actionBody = (payload = {}) => ({ type: 'customer_facing_publish', action: 'Review an exact public action',
  reason: 'An intentional user-authored narrative with objective_public_reference.', financialImpact: null,
  expectedBenefit: 'Review the authored product description.', risk: 'Customer-facing text needs review.', payload,
  evidence: [{ type: 'reference', id: 'public_evidence_reference', detail: 'Keep this evidence text.' }] });
async function allRolesFixture(t) {
  const f = await objectiveContentApiFixture(t);
  // Keep the shared fixture unchanged: this test alone adds the fourth tenant role.
  for (const tenant of Object.keys(f.states)) {
    const state = await f.store.get(tenant);
    const member = { ...state.users[0], id: `${tenant}-member`, email: `${tenant}-member@example.test`, role: 'member' };
    state.users.push(member); f.states[tenant].state.users.push(member); await f.store.save(tenant, state);
  }
  return f;
}
const retainedBytes = state => JSON.stringify({ writes: state.connectionWrites, approvals: state.approvals });

test('generic reads hide nested private values for every admitted role and preserve exact owner-only source routes', async t => {
  const f = await allRolesFixture(t), context = await f.context(), body = f.body(context);
  const created = await f.request(OBJECTIVE_CONTENT_POST, { method: 'POST', body }); success(created);
  const exactRoute = `${OBJECTIVE_CONTENT_POST}/${body.requestId}`;
  const exact = await f.request(exactRoute); success(exact);
  assert.deepEqual(exact.body.request.source, context.source);
  assert.equal(exact.body.request.source.actorSessionVersion, 1);
  assert.equal(objectiveCanonicalDigest(exact.body.request.source), context.sourceRevision);
  for (const role of ROLES.slice(1)) {
    const identity = f.auth(f.workspaceId, role);
    assert.equal((await f.request(f.contextRoute, { identity })).status, 403);
    assert.equal((await f.request(exactRoute, { identity })).status, 403);
  }
  const foreignExact = await f.request(exactRoute, { identity: f.auth('content-beta') }); success(foreignExact);
  assert.equal(foreignExact.body.found, false); assert.equal(foreignExact.body.request, null);
  const secret = privateValues('reads');
  const state = await f.change(state => {
    const write = state.connectionWrites[0];
    poisonWrite(write, secret);
    poisonApproval(state.approvals[0], secret);
    // Distinct future and malformed origins must never enable a raw fallback.
    for (const [suffix, envelope] of [
      ['future', { schema: 'runvara-objective-dispatch-proposal/v999', origin: 'future_origin', source: { binding: secret.value('future_envelope') } }],
      ['malformed', { schema: 'runvara-objective-dispatch-proposal/v2', origin: 'owner_objective_content', source: { binding: secret.value('malformed_envelope') } }],
      ['legacy', undefined]
    ]) {
      const copy = structuredClone(write); copy.id = `write_${suffix}_privacy`; copy.requestId = `${suffix}_privacy_request_001`;
      if (envelope) copy.objectivePolicyProposal = envelope; else delete copy.objectivePolicyProposal;
      state.connectionWrites.push(copy);
    }
  });
  const source = state.connectionWrites[0].objectivePolicyProposal.source;
  const before = retainedBytes(state), proposalDigest = objectiveCanonicalDigest(state.connectionWrites[0].objectivePolicyProposal);
  for (const role of ROLES) {
    for (const route of READS) {
      const response = await f.request(route, { identity: f.auth(f.workspaceId, role) }); success(response);
      assertPrivateAbsent(response.body, secret, `${role} ${route}`);
      const writes = route === '/api/bootstrap' ? response.body.connectionWrites : response.body.writes;
      if (writes) {
        const write = writes.find(row => row.id === created.body.request.id);
        assert.deepEqual(write.input, { productId: PRODUCT, operation: 'product_content', title: body.title, description: body.description });
        assert.deepEqual(write.sourceDisplay, { schema: 'runvara-objective-content-display/v1', origin: 'owner_objective_content', status: 'available',
          objectiveId: source.objectiveId, objectiveRevision: source.objectiveRevision, jobId: source.jobId,
          reportId: source.reportId, opportunityId: source.opportunityId, productId: source.productId });
        for (const key of ['objectivePolicyProposal', 'source', 'dispatchClaim', 'providerState', 'recordedActionContext', 'stableApproval']) assert.equal(Object.hasOwn(write, key), false, key);
        const unavailable = writes.find(row => row.id === 'write_malformed_privacy');
        assert.equal(unavailable.sourceDisplay.origin, 'owner_objective_content'); assert.equal(unavailable.sourceDisplay.status, 'unavailable');
        const future = writes.find(row => row.id === 'write_future_privacy');
        if (future.sourceDisplay) { assert.equal(future.sourceDisplay.origin, 'unknown'); assert.equal(future.sourceDisplay.status, 'unavailable'); }
      }
      const approvals = response.body.approvals;
      if (approvals) {
        const approval = approvals.find(row => row.id === created.body.request.approvalId);
        assert.ok(approval.reason.includes(source.objectiveId), 'intentional generated objective narrative is retained');
        assert.equal(approval.payload.connectionWriteId, created.body.request.id);
        assert.deepEqual(Object.keys(approval.payload), ['connectionWriteId']);
        assert.equal(approval.evidence.find(row => row.id === 'report_public_alias').detail, 'An intentional public evidence narrative.');
        assert.equal(approval.history[0].note, 'An intentional public historical narrative.');
        assert.equal(approval.history[0].evidence[0].detail, 'An intentional historical evidence detail.');
      }
    }
    const foreign = await f.request('/api/bootstrap', { identity: f.auth('content-beta', role) }); success(foreign);
    assertPrivateAbsent(foreign.body, secret);
    assert.equal(JSON.stringify(foreign.body).includes(created.body.request.id), false);
  }
  for (const route of ['/api/business-graph', '/api/business-graph?detail=true', '/api/control', '/api/agents', '/api/agent-ops', '/api/revenue-engine', '/api/audit', '/api/brief']) {
    const response = await f.request(route); success(response); assertPrivateAbsent(response.body, secret, route);
  }
  const after = await f.store.get(f.workspaceId);
  assert.equal(retainedBytes(after), before, 'generic projections leave retained writes and approvals byte-identical');
  assert.equal(objectiveCanonicalDigest(after.connectionWrites[0].objectivePolicyProposal), proposalDigest);
});

test('actions, owner modification and decisions project payload/history without removing retained authority', async t => {
  const f = await allRolesFixture(t), secret = privateValues('actions');
  let approvalId;
  for (const role of ROLES) {
    const payload = { connectionWriteId: 'write_public_navigation', opportunityId: 'opportunity_public_reference', experimentId: 'experiment_public_reference',
      verifiedExperiment: false, legacyReviewRecorded: true, marketingCampaignId: 'marketing_public_reference',
      source: { resultDigest: secret.value(`${role}_payload_source`) }, futurePrivate: secret.value(`${role}_payload_future`) };
    const response = await f.request('/api/actions', { method: 'POST', body: actionBody(payload), identity: f.auth(f.workspaceId, role) });
    if (role === 'viewer') { assert.equal(response.status, 403); continue; }
    success(response, 202); assertPrivateAbsent(response.body, secret);
    assert.equal(response.body.approval.reason, actionBody().reason);
    assert.deepEqual(response.body.approval.payload, { connectionWriteId: payload.connectionWriteId, opportunityId: payload.opportunityId,
      experimentId: payload.experimentId, verifiedExperiment: false, legacyReviewRecorded: true, marketingCampaignId: payload.marketingCampaignId });
    if (role === 'owner') approvalId = response.body.approval.id;
  }
  await f.change(state => poisonApproval(state.approvals.find(row => row.id === approvalId), secret));
  const before = (await f.store.get(f.workspaceId)).approvals.find(row => row.id === approvalId);
  for (const role of ROLES.slice(1)) {
    const identity = f.auth(f.workspaceId, role);
    assert.equal((await f.request(`/api/approvals/${approvalId}`, { method: 'PATCH', identity, body: { revision: 1, action: 'Blocked edit' } })).status, 403);
    assert.equal((await f.request(`/api/approvals/${approvalId}/decision`, { method: 'POST', identity, body: { revision: 1, decision: 'approved' } })).status, 403);
  }
  const patch = await f.request(`/api/approvals/${approvalId}`, { method: 'PATCH', body: { revision: 1, action: 'Owner changed public action', reason: 'Owner changed public reason' } });
  success(patch); assertPrivateAbsent(patch.body, secret); assert.equal(patch.body.approval.revision, 2);
  assert.equal(patch.body.approval.history.at(-1).reason, before.reason);
  assert.equal(patch.body.approval.history.at(-1).evidence.find(row => row.id === 'report_public_alias').detail, 'An intentional public evidence narrative.');
  const decision = await f.request(`/api/approvals/${approvalId}/decision`, { method: 'POST', body: { revision: 2, decision: 'approved', note: 'Reviewed exact action.' } });
  success(decision); assertPrivateAbsent(decision.body, secret);
  assert.equal(decision.body.approval.status, 'approved'); assert.equal(decision.body.approval.history.at(-1).note, 'Reviewed exact action.');
  const retained = (await f.store.get(f.workspaceId)).approvals.find(row => row.id === approvalId);
  assert.deepEqual(retained.payload, before.payload, 'projection never replaces the stored execution payload');
  assert.deepEqual(retained.futurePrivate, before.futurePrivate);
  assert.deepEqual(retained.history[0], before.history[0]);
  assert.equal((await f.request(`/api/approvals/${approvalId}/decision`, { method: 'POST', identity: f.auth('content-beta'), body: { decision: 'approved' } })).status, 404);
});

test('opportunity and marketing approval creation and reuse share the same nested privacy boundary', async t => {
  const f = await allRolesFixture(t), secret = privateValues('reuse');
  await f.change(state => {
    state.opportunities[0].id = `${OPPORTUNITY}_alpha_only`;
    state.opportunities[0].recommendedNextStep = 'Review the retained product title.';
    state.marketing = { campaigns: [{ id: 'campaign_privacy', product: { title: 'Public product' }, status: 'draft',
      evidence: [{ type: 'product', id: PRODUCT, detail: 'Public campaign evidence.', futurePrivate: secret.value('campaign_input_evidence') }] }] };
  });
  const opportunityRoute = `/api/opportunities/${OPPORTUNITY}_alpha_only/approval`, marketingRoute = '/api/marketing/campaigns/campaign_privacy/request-publish-approval';
  const opportunity = await f.request(opportunityRoute, { method: 'POST', body: {}, identity: f.auth(f.workspaceId, 'member') }); success(opportunity, 202);
  assert.equal(opportunity.body.approval.payload.opportunityId, `${OPPORTUNITY}_alpha_only`);
  const campaign = await f.request(marketingRoute, { method: 'POST', body: {}, identity: f.auth(f.workspaceId, 'admin') }); success(campaign, 202);
  assert.equal(campaign.body.approval.payload.marketingCampaignId, 'campaign_privacy'); assertPrivateAbsent(campaign.body, secret);
  await f.change(state => {
    poisonApproval(state.approvals.find(row => row.id === opportunity.body.approval.id), secret);
    poisonApproval(state.approvals.find(row => row.id === campaign.body.approval.id), secret);
  });
  const before = retainedBytes(await f.store.get(f.workspaceId));
  for (const role of ROLES) {
    for (const [route, allowed, expectedId] of [[opportunityRoute, role !== 'viewer', opportunity.body.approval.id],
      [marketingRoute, ['owner', 'admin'].includes(role), campaign.body.approval.id]]) {
      const response = await f.request(route, { method: 'POST', body: {}, identity: f.auth(f.workspaceId, role) });
      if (!allowed) { assert.equal(response.status, 403); continue; }
      success(response, 202); assertPrivateAbsent(response.body, secret, `${role} ${route}`); assert.equal(response.body.approval.id, expectedId);
    }
  }
  assert.equal(retainedBytes(await f.store.get(f.workspaceId)), before, 'reuse returns a projection without rewriting retained approvals');
  for (const route of [opportunityRoute, marketingRoute]) assert.equal((await f.request(route, { method: 'POST', body: {}, identity: f.auth('content-beta') })).status, 404);
});

test('manual preparation, exact reconciliation and completed execution preserve their distinct response contracts', async t => {
  const f = await allRolesFixture(t), context = await f.context(), secret = privateValues('manual');
  const body = { operation: 'product_content', requestId: 'manual_privacy_request_001', target: context.target, productId: PRODUCT,
    title: 'Exact café title', description: 'First line.\n第二行 <retained>.' };
  const route = '/api/connections/shopify/writes';
  const created = await f.request(route, { method: 'POST', body }); success(created);
  assert.equal(Object.hasOwn(created.body.write, 'objectivePolicyProposal'), false);
  assert.equal(created.body.write.input.description, body.description);
  const exactRoute = `/api/connections/shopify/content-requests/${body.requestId}`;
  const exact = await f.request(exactRoute); success(exact);
  assert.deepEqual(Object.keys(exact.body.request).sort(), ['id', 'requestId', 'provider', 'input', 'digest', 'connectionId', 'account', 'requestedBy', 'status', 'approvalId'].sort());
  const original = (await f.store.get(f.workspaceId)).connectionWrites[0];
  await f.change(state => {
    const write = state.connectionWrites[0];
    write.futurePrivate = { source: secret.value('prepare_root') };
    write.recordedActionContext = { source: secret.value('prepare_context') };
  });
  const reused = await f.request(route, { method: 'POST', body }); success(reused); assertPrivateAbsent(reused.body, secret);
  assert.equal(reused.body.write.id, created.body.write.id);
  const reconciled = await f.request(exactRoute); success(reconciled); assert.deepEqual(reconciled.body, exact.body);
  for (const role of ROLES.slice(1)) {
    const identity = f.auth(f.workspaceId, role);
    // Admin can author manual content but cannot reuse another author's request.
    assert.equal((await f.request(route, { method: 'POST', body, identity })).status, role === 'admin' ? 409 : 403);
    assert.equal((await f.request(exactRoute, { identity })).status, role === 'admin' ? 409 : 403);
  }
  await f.change(state => {
    const write = state.connectionWrites[0]; poisonWrite(write, secret, { input: false });
    write.status = 'completed'; write.completedAt = '2026-10-08T00:00:00.000Z';
    write.objectivePolicyProposal = { schema: 'future-private-envelope', source: { value: secret.value('completed_envelope') } };
  });
  const before = retainedBytes(await f.store.get(f.workspaceId)); let saves = 0;
  const save = f.store.save.bind(f.store); f.store.save = async (...args) => { saves++; return save(...args); };
  const executeRoute = `/api/connection-writes/${original.id}/execute`;
  const completed = await f.request(executeRoute, { method: 'POST', body: {} }); success(completed);
  assertPrivateAbsent(completed.body, secret); assert.equal(completed.body.executedExternally, true); assert.equal(completed.body.write.result.externalId, PRODUCT);
  assert.equal(saves, 0, 'already-completed return adds no save or provider dispatch');
  assert.equal(retainedBytes(await f.store.get(f.workspaceId)), before);
  for (const role of ROLES.slice(1)) assert.equal((await f.request(executeRoute, { method: 'POST', body: {}, identity: f.auth(f.workspaceId, role) })).status, 403);
  assert.equal((await f.request(executeRoute, { method: 'POST', body: {}, identity: f.auth('content-beta') })).status, 404);
});

test('fresh synthetic HTTP dispatch records known success before projection and does not add saves or replay', async t => {
  const f = await objectiveContentFixture(), secret = privateValues('dispatch');
  const before = await f.store.get(CONTENT_WORKSPACE), write = before.connectionWrites[0];
  write.futurePrivate = { value: secret.value('write_private') };
  write.sourceDisplay = { malformed: { value: secret.value('stored_display') } };
  write.recordedActionContext = { malformed: { value: secret.value('stored_context') } };
  await f.store.save(CONTENT_WORKSPACE, before);
  const proposalBytes = JSON.stringify(write.objectivePolicyProposal), approvalPayload = structuredClone(before.approvals[0].payload);
  let calls = 0, saves = 0;
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: SECRET, CREDENTIALS_KEY: SECRET, SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' }, {
    store: f.store, schedulerEnabled: false, agentOpsEnabled: false,
    fetchImpl: async (url, options) => {
      calls++; assert.match(String(url), /objective-content-fixture\.myshopify\.com\/admin\/api\/2026-07\/graphql\.json$/);
      const request = JSON.parse(options.body); assert.match(request.query, /mutation RunvaraProductContent/);
      assert.equal(request.variables.product.id, CONTENT_PRODUCT);
      return Response.json({ data: { productUpdate: { product: { id: CONTENT_PRODUCT, title: f.body.title }, userErrors: [] } } });
    }
  });
  server.packsmart.integrations.shopifyConfig = f.service.shopifyConfig;
  server.packsmart.integrations.connectorCredentials = f.service.connectorCredentials;
  t.after(async () => { await server.packsmart.drain(); if (server.listening) await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const token = createSessionToken({ workspaceId: CONTENT_WORKSPACE, userId: 'content-owner', email: 'content-owner@example.test', role: 'owner', sessionVersion: 1 }, SECRET);
  const base = `http://127.0.0.1:${server.address().port}`;
  const execute = async () => {
    const response = await fetch(`${base}/api/connection-writes/${write.id}/execute`, { method: 'POST',
      headers: { Cookie: `packsmart_session=${token}`, 'X-CSRF-Token': verifySessionToken(token, SECRET).csrf, 'Content-Type': 'application/json' }, body: '{}' });
    return { status: response.status, body: await response.json() };
  };
  const save = f.store.save.bind(f.store); f.store.save = async (...args) => { saves++; return save(...args); };
  const result = await execute(); success(result); assertPrivateAbsent(result.body, secret);
  assert.equal(result.body.write.status, 'completed'); assert.equal(result.body.executedExternally, true);
  assert.equal(result.body.write.sourceDisplay.status, 'available'); assert.deepEqual(result.body.write.result, { externalId: CONTENT_PRODUCT });
  assert.equal(calls, 1); assert.equal(saves, 3, 'same admission, provider-phase, and final-result saves');
  const retained = await f.store.get(CONTENT_WORKSPACE);
  assert.equal(retained.connectionWrites[0].status, 'completed'); assert.equal(retained.approvals[0].executedExternally, true);
  assert.equal(JSON.stringify(retained.connectionWrites[0].objectivePolicyProposal), proposalBytes);
  assert.deepEqual(retained.approvals[0].payload, approvalPayload);
  assert.deepEqual(retained.connectionWrites[0].futurePrivate, write.futurePrivate);
  assert.ok(retained.connectionWrites[0].dispatchClaim.phases.shopify_mutation);
  assert.equal(retained.connectionWrites[0].recordedActionUnavailable, 'objective_origin_unsupported');
  const again = await execute(); success(again); assertPrivateAbsent(again.body, secret);
  assert.equal(again.body.write.status, 'completed'); assert.equal(calls, 1); assert.equal(saves, 3);
});

test('actual synthetic Meta processing responses hide retained container and claim material without replay', async t => {
  const f = await objectiveContentFixture(), secret = privateValues('meta');
  const scopes = ['pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish'];
  const state = await f.store.get(CONTENT_WORKSPACE);
  state.connections.push({ id: 'privacy-meta', provider: 'meta', encryptedCredentials: 'synthetic-meta-credential',
    metadata: { accountId: '100', grantedScopes: scopes, assets: { pages: [{ id: '200', instagram: { id: '300' } }], catalogs: [] } } });
  state.connectionSettings.meta = { permissionMode: 'approval_gated', revision: 1, metaPageIds: ['200'], metaCatalogIds: [] };
  await f.store.save(CONTENT_WORKSPACE, state);
  const calls = [], containerId = '8888888888888888888888888888888';
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: SECRET, CREDENTIALS_KEY: SECRET, SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' }, {
    store: f.store, schedulerEnabled: false, agentOpsEnabled: false, fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url); assert.equal(parsed.hostname, 'graph.facebook.com');
      const route = parsed.pathname.replace('/v26.0', ''), method = options.method || 'GET'; calls.push({ route, method });
      if (route === '/me/permissions') return Response.json({ data: scopes.map(permission => ({ permission, status: 'granted' })) });
      if (route === '/me/accounts') return Response.json({ data: [{ id: '200', name: 'Public Page', access_token: 'synthetic-page-token', instagram_business_account: { id: '300', username: 'public_account' } }] });
      if (route === '/debug_token') return Response.json({ data: { is_valid: false } });
      if (route === '/300/content_publishing_limit') return Response.json({ data: [{ quota_usage: 0, config: { quota_total: 100 } }] });
      if (route === '/300/media' && method === 'POST') {
        assert.deepEqual(JSON.parse(options.body), { image_url: 'https://example.test/approved.jpg', caption: 'Exact reviewed caption.' });
        return Response.json({ id: containerId });
      }
      if (route === `/${containerId}` && method === 'GET') return Response.json({ status_code: 'IN_PROGRESS' });
      assert.fail(`Unexpected synthetic Meta request ${method} ${route}`);
    }
  });
  server.packsmart.integrations.connectorCredentials = async () => ({ accessToken: 'synthetic-meta-token' });
  t.after(async () => { await server.packsmart.drain(); if (server.listening) await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const token = createSessionToken({ workspaceId: CONTENT_WORKSPACE, userId: 'content-owner', email: 'content-owner@example.test', role: 'owner', sessionVersion: 1 }, SECRET);
  const request = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: body ? 'POST' : 'GET',
      headers: { Cookie: `packsmart_session=${token}`, 'X-CSRF-Token': verifySessionToken(token, SECRET).csrf, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const created = await request('/api/connections/meta/writes', { operation: 'instagram_publish', requestId: 'meta_privacy_request_001',
    pageId: '200', message: 'Exact reviewed caption.', imageUrl: 'https://example.test/approved.jpg' }); success(created);
  const writeId = created.body.write.id;
  success(await request(`/api/approvals/${created.body.write.approvalId}/decision`, { decision: 'approved', revision: 1 }));
  const pending = await f.store.get(CONTENT_WORKSPACE), pendingWrite = pending.connectionWrites.find(row => row.id === writeId);
  pendingWrite.futurePrivate = { value: secret.value('write_root') };
  pendingWrite.source = { binding: secret.value('root_source') };
  pendingWrite.recordedActionContext = { value: secret.value('context') };
  await f.store.save(CONTENT_WORKSPACE, pending);
  const route = `/api/connection-writes/${writeId}/execute`;
  const processing = await request(route, {}); success(processing); assertPrivateAbsent(processing.body, secret);
  assert.equal(processing.body.write.status, 'processing'); assert.equal(processing.body.executedExternally, false);
  assert.equal(Object.hasOwn(processing.body.write, 'providerState'), false); assert.equal(Object.hasOwn(processing.body.write, 'dispatchClaim'), false);
  assert.equal(JSON.stringify(processing.body).includes(containerId), false);
  const retained = await f.store.get(CONTENT_WORKSPACE), retainedWrite = retained.connectionWrites.find(row => row.id === writeId);
  assert.equal(retainedWrite.providerState.containerId, containerId);
  assert.equal(retainedWrite.dispatchClaim.phases.instagram_container.resultId, containerId);
  retainedWrite.providerState.futurePrivate = { value: secret.value('container_future') };
  await f.store.save(CONTENT_WORKSPACE, retained);
  const again = await request(route, {}); success(again); assertPrivateAbsent(again.body, secret);
  assert.equal(again.body.write.status, 'processing'); assert.equal(JSON.stringify(again.body).includes(containerId), false);
  const centre = await request('/api/connection-centre'); success(centre); assertPrivateAbsent(centre.body, secret);
  assert.equal(calls.filter(row => row.method === 'POST').length, 1, 'the acknowledged container is never created or published again');
  assert.equal(calls.filter(row => row.route === `/${containerId}`).length, 1, 'the pending observation retains its retry delay');
});
