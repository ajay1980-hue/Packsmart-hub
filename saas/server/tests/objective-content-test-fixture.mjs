import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { upsertBusinessObjective, OBJECTIVE_EXECUTION_POLICY_SCHEMA } from '../lib/business-objectives.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';

export const OBJECTIVE_CONTENT_PRODUCT = 'gid://shopify/Product/10';
export const OBJECTIVE_CONTENT_OPPORTUNITY = 'opportunity_title_10';
export const OBJECTIVE_CONTENT_POST = '/api/objective-content/requests';
export function objectiveContentState(workspaceId = 'content-alpha') {
  const state = seedWorkspaceState({}, { workspaceId, userId: `${workspaceId}-owner`, email: `${workspaceId}@example.test`, passwordHash: 'synthetic-only' });
  state.users.push(...['admin', 'viewer'].map(role => ({ ...state.users[0], id: `${workspaceId}-${role}`, email: `${workspaceId}-${role}@example.test`, role })));
  state.products = [{ id: OBJECTIVE_CONTENT_PRODUCT, provider: 'shopify', title: 'Box', description: 'A retained original product description. No provider request established the source account.', status: 'active', variants: [] }];
  state.connections = [{ id: `${workspaceId}-shopify`, provider: 'shopify', encryptedCredentials: 'synthetic-opaque-credential-marker',
    metadata: { shopDomain: `${workspaceId}.myshopify.com`, grantedScopes: ['read_products', 'write_products'] } }];
  state.connectionSettings = { shopify: { permissionMode: 'approval_gated', revision: 4 } };
  state.opportunities = [{ id: OBJECTIVE_CONTENT_OPPORTUNITY, workspaceId, kind: 'seo', reference: `${OBJECTIVE_CONTENT_PRODUCT}:Thin product title`,
    title: 'Improve catalogue title', present: true, status: 'open', requiredAction: 'customer_facing_publish', approvalRequired: true,
    evidence: [{ type: 'product', id: OBJECTIVE_CONTENT_PRODUCT, detail: 'Thin product title' }], confidence: 0.8, effort: 'low', risk: 'medium' }];
  state.approvals = []; state.connectionWrites = []; state.decisions = []; state.exceptions = [];
  const now = Date.now();
  const objective = upsertBusinessObjective(state, { title: 'Review clearer product content', metric: 'orders', baseline: 0, target: 10, direction: 'increase',
    startsAt: new Date(now - 60000).toISOString(), endsAt: new Date(now + 7 * 86400000).toISOString(), limits: { profitFirst: false },
    executionPolicy: { schema: OBJECTIVE_EXECUTION_POLICY_SCHEMA, mode: 'enforce', scope: { provider: 'shopify', operation: 'product_content',
      connectionId: `${workspaceId}-shopify`, account: `${workspaceId}.myshopify.com` } } }, { workspaceId, actorId: state.users[0].id });
  return { state, objective };
}

export async function objectiveContentApiFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-objective-content-api-'));
  const secret = 'objective-content-api-synthetic-secret-more-than-thirty-two-characters';
  let providerCalls = 0;
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret,
    SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' }, {
    schedulerEnabled: false, agentOpsEnabled: false, fetchImpl: async () => { providerCalls++; assert.fail('External provider transport forbidden'); }
  });
  const store = server.packsmart.store, states = {};
  t.after(async () => {
    await server.packsmart.drain();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
    assert.equal(providerCalls, 0);
  });
  server.packsmart.aiProvider.enhanceCommander = async () => assert.fail('Objective content preparation must never call a model');
  for (const workspaceId of ['content-alpha', 'content-beta']) {
    states[workspaceId] = objectiveContentState(workspaceId);
    await store.save(workspaceId, states[workspaceId].state);
  }
  const workspaceId = 'content-alpha', actorId = states[workspaceId].state.users[0].id, objective = states[workspaceId].objective;
  const queued = await server.packsmart.agentOps.enqueueObjectiveReview(workspaceId, { objectiveId: objective.id, objectiveRevision: objective.revision }, { actorId, sessionVersion: 1 });
  await server.packsmart.agentOps.tick();
  const jobId = queued.job.id, job = await store.getAgentJob(workspaceId, jobId, { includeReport: true });
  assert.equal(job.status, 'succeeded'); assert.equal(job.result.proposals.length, 1);
  assert.equal(job.result.proposals[0].opportunityId, OBJECTIVE_CONTENT_OPPORTUNITY);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = (tenant = workspaceId, role = 'owner', sessionVersion = 1) => {
    const user = states[tenant].state.users.find(row => row.role === role);
    const token = createSessionToken({ userId: user.id, workspaceId: tenant, email: user.email, role: user.role, sessionVersion }, secret);
    return { token, csrf: verifySessionToken(token, secret).csrf };
  };
  const request = async (route, { method = 'GET', body, identity = auth(), csrf = true, signal } = {}) => {
    const headers = {};
    if (identity) { headers.Cookie = `packsmart_session=${identity.token}`; if (csrf) headers['X-CSRF-Token'] = identity.csrf; }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
    return { status: response.status, body: await response.json() };
  };
  const contextRoute = `/api/objective-content/context?jobId=${jobId}&opportunityId=${OBJECTIVE_CONTENT_OPPORTUNITY}`;
  const context = async () => { const response = await request(contextRoute); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; };
  const body = (review, requestId = 'objective_content_request_001') => ({ requestId, jobId, opportunityId: OBJECTIVE_CONTENT_OPPORTUNITY,
    sourceRevision: review.sourceRevision, target: structuredClone(review.target), productId: OBJECTIVE_CONTENT_PRODUCT,
    title: 'An exact reviewed product title', description: 'Owner reviewed description for this exact retained product.', confirmedDestinationProduct: true });
  const change = async callback => { const state = await store.get(workspaceId); await callback(state); await store.save(workspaceId, state); return state; };
  return { server, store, states, workspaceId, actorId, jobId, job, objective, auth, request, contextRoute, context, body, change, base };
}
