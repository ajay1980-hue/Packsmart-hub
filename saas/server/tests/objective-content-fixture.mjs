import crypto from 'node:crypto';
import { seedWorkspaceState, createStore } from '../lib/store.mjs';
import { upsertBusinessObjective, OBJECTIVE_EXECUTION_POLICY_SCHEMA } from '../lib/business-objectives.mjs';
import { buildObjectiveReview } from '../lib/objective-review.mjs';
import { objectiveContentContext } from '../lib/objective-content-source.mjs';
import { prepareObjectiveContentRequest, executeConnectionWrite } from '../lib/connection-writes.mjs';
import { IntegrationService } from '../lib/integrations.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

export const CONTENT_WORKSPACE = 'objective-content-fixture';
export const CONTENT_PRODUCT = 'gid://shopify/Product/71';
export const CONTENT_ACCOUNT = 'objective-content-fixture.myshopify.com';
export function objectiveContentSeed({ limits = { profitFirst: false }, now = Date.now(), issue = 'Thin product title' } = {}) {
  const state = seedWorkspaceState({}, { workspaceId: CONTENT_WORKSPACE, userId: 'content-owner', email: 'content-owner@example.test', passwordHash: 'synthetic-only' });
  state.products = [{ id: CONTENT_PRODUCT, provider: 'shopify', title: 'Cup', description: 'Small cup.', status: 'active' }];
  state.connections = [{ id: 'content-shopify', provider: 'shopify', encryptedCredentials: 'synthetic-marker', metadata: { shopDomain: CONTENT_ACCOUNT, grantedScopes: ['read_products', 'write_products'] } }];
  state.connectionSettings = { shopify: { permissionMode: 'approval_gated', revision: 1 } };
  state.opportunities = [{ id: 'opportunity-content', kind: 'seo', reference: `${CONTENT_PRODUCT}:${issue}`, title: 'Improve catalogue content: Cup', status: 'open', present: true,
    evidence: [{ type: 'product', id: CONTENT_PRODUCT, detail: issue }], effort: 'low', risk: 'medium', confidence: 0.8,
    requiredAction: 'customer_facing_publish', executionCost: null, effortHours: 1 }];
  state.approvals = []; state.decisions = []; state.exceptions = []; state.revenueEngine = { experiments: [] }; state.connectionWrites = [];
  const objective = upsertBusinessObjective(state, { title: 'Improve catalogue content', metric: 'orders', baseline: 1, target: 2, direction: 'increase',
    startsAt: new Date(now - 60000).toISOString(), endsAt: new Date(now + 86400000).toISOString(), limits,
    executionPolicy: { schema: OBJECTIVE_EXECUTION_POLICY_SCHEMA, mode: 'enforce', scope: { provider: 'shopify', operation: 'product_content', connectionId: 'content-shopify', account: CONTENT_ACCOUNT } } },
  { actorId: 'content-owner', now: new Date(now) });
  return { state, objective, session: { workspaceId: CONTENT_WORKSPACE, userId: 'content-owner', sessionVersion: 1 } };
}
export function objectiveContentJob(state, objective, { id = 'job_objective_content', now = Date.now() } = {}) {
  const report = buildObjectiveReview(state, { objectiveId: objective.id, objectiveRevision: objective.revision, jobId: id }, { now: new Date(now) });
  const payload = { schema: 'runvara-objective-prepare/v1', objectiveId: objective.id, objectiveRevision: objective.revision,
    typedInputFingerprint: report.sourceAsOf.typedInputFingerprint, actorSessionVersion: 1 };
  return { id, workspace_id: state.workspace.id, type: 'objective_prepare', provider: null, status: 'succeeded', priority: 60, attempts: 1, max_attempts: 3,
    ai_units: 0, concurrency_limit: 6, idempotency_key: `objective_prepare:v1:${crypto.createHash('sha256').update(JSON.stringify([state.workspace.id, payload, 'content-owner'])).digest('hex')}`,
    actor: 'content-owner', ai_provider: null, ai_model: null, ai_tier: 'deterministic', available_at: new Date(now).toISOString(), lease_until: null, worker_id: null,
    error_code: null, created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), completed_at: new Date(now).toISOString(), payload, result: report };
}
export function objectiveContentBody(context, requestId = 'objective-content-request-0001') {
  return { requestId, jobId: context.source.jobId, opportunityId: context.source.opportunityId, sourceRevision: context.sourceRevision,
    target: context.target, productId: context.product.id, title: 'Owner authored cup title', description: 'Owner authored <description>\nSecond line.', confirmedDestinationProduct: true };
}
export function approveObjectiveContent(state, write, actor = 'content-owner') {
  const approval = state.approvals.find(row => row.id === write.approvalId), at = new Date().toISOString();
  Object.assign(approval, { status: 'approved', decidedBy: actor, decidedAt: at, decisionNote: null, executedExternally: false,
    executionStatus: 'ready', workStatus: 'PLANNED', history: [{ revision: 1, status: 'approved', actor, at, note: null }] });
  write.status = 'ready'; return approval;
}
export async function objectiveContentFixture(options = {}) {
  const initial = objectiveContentSeed(options), database = fakeSupabase();
  const env = { SUPABASE_URL: 'https://objective-content.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only' };
  const store = createStore(env, { fetchImpl: database.fetchImpl }), replica = createStore(env, { fetchImpl: database.fetchImpl });
  await store.save(CONTENT_WORKSPACE, initial.state);
  const state = await store.get(CONTENT_WORKSPACE), job = objectiveContentJob(state, initial.objective, options);
  database.tables.set('runvara_agent_jobs', [job]);
  const hooks = { job: null, credentials: null, save: null, fresh: null, fetch: null }, counts = { job: 0, credentials: 0, saves: 0, fresh: 0, mutations: 0 };
  const loadJob = async id => { counts.job++; if (hooks.job) await hooks.job(counts.job); return store.getAgentJob(CONTENT_WORKSPACE, id, { includeReport: true }); };
  const context = await objectiveContentContext(state, job.id, 'opportunity-content', initial.session, loadJob);
  const body = objectiveContentBody(context);
  const result = await prepareObjectiveContentRequest(state, body, initial.session, { loadJob, persist: options => store.save(CONTENT_WORKSPACE, state, options) });
  const write = state.connectionWrites.find(row => row.id === result.request.id);
  approveObjectiveContent(state, write); await store.save(CONTENT_WORKSPACE, state);
  const service = new IntegrationService({}, { fetchImpl: async (url, request) => {
    counts.mutations++;
    if (hooks.fetch) return hooks.fetch(url, request);
    return Response.json({ data: { productUpdate: { product: { id: CONTENT_PRODUCT, title: body.title }, userErrors: [] } } });
  } });
  service.shopifyConfig = snapshot => ({ domain: snapshot.connections[0].metadata.shopDomain, workspaceId: CONTENT_WORKSPACE, mode: 'oauth', apiVersion: '2026-07', accessToken: 'synthetic-token' });
  service.connectorCredentials = async () => { counts.credentials++; if (hooks.credentials) await hooks.credentials(); return { accessToken: 'synthetic-token' }; };
  const run = (overrides = {}) => executeConnectionWrite(state, write.id, 'content-owner', service,
    async options => { counts.saves++; if (hooks.save) await hooks.save(counts.saves, options); return store.save(CONTENT_WORKSPACE, state, options); }, {
      durableStore: true, actorSession: initial.session, loadObjectiveJob: loadJob,
      loadFreshState: async input => { counts.fresh++; if (hooks.fresh) await hooks.fresh(counts.fresh, input); return store.getConnectionWriteContext(CONTENT_WORKSPACE, input); }, ...overrides });
  Object.assign(counts, { job: 0, credentials: 0, saves: 0, fresh: 0, mutations: 0 });
  return { ...initial, state, database, store, replica, job, context, body, write, service, hooks, counts, loadJob, run };
}
