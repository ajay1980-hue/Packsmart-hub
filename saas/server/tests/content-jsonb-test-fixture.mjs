import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createStore } from '../lib/store.mjs';
import { connectionSettings, saveConnectionSettings } from '../lib/connection-centre.mjs';
import { executeConnectionWrite, prepareObjectiveContentRequest, proposeConnectionWrite,
  readManualContentRequest, readObjectiveContentRequest } from '../lib/connection-writes.mjs';
import { resolveManualContentTarget } from '../lib/manual-content-target.mjs';
import { objectiveContentContext } from '../lib/objective-content-source.mjs';
import { IntegrationService } from '../lib/integrations.mjs';
import { objectiveContentSeed, objectiveContentJob, objectiveContentBody, approveObjectiveContent,
  CONTENT_WORKSPACE, CONTENT_PRODUCT, CONTENT_ACCOUNT } from './objective-content-fixture.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

export { CONTENT_WORKSPACE, CONTENT_PRODUCT, CONTENT_ACCOUNT };
export const CONTENT_FAMILIES = ['manual', 'manual-v1-policy', 'objective-v2'];
export const CONTENT_CONSENTS = ['absent', 'null', 'settings'];
export const CONTENT_TITLE = 'Owner’s "exact" cup ☕';
export const CONTENT_DESCRIPTION = 'Owner reviewed <cup> & saucer.\nSecond line: "é" \\ /\t終';
export const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Models only JSONB object ordering. It deliberately preserves array order,
// scalar values and property presence. The separate opted-in PG test replaces
// this function with actual PostgreSQL ::jsonb casts.
export function jsonbOrder(value) {
  if (Array.isArray(value)) return value.map(jsonbOrder);
  if (!value || typeof value !== 'object') return value;
  const keys = Object.keys(value).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b)
    || Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return Object.fromEntries(keys.map(key => [key, jsonbOrder(value[key])]));
}
export function reverseObjectOrder(value) {
  if (Array.isArray(value)) return value.map(reverseObjectOrder);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverseObjectOrder(value[key])]));
}

// Capture the ORIGINAL producer bytes. This never calls the compatibility
// implementation or reorders its input, and is used as a durable golden oracle.
export function originalContentPreimages(state, write) {
  const user = state.users.find(row => row.id === write.requestedBy);
  const connection = state.connections.find(row => row.id === write.connectionId);
  const settings = connectionSettings(state, write.provider);
  const approval = state.approvals.find(row => row.id === write.approvalId);
  const identity = { id: write.id, requestId: write.requestId, provider: write.provider, input: write.input,
    digest: write.digest, connectionId: write.connectionId, account: write.account, requestedBy: write.requestedBy,
    requiresApproval: write.requiresApproval, approvalId: write.approvalId || null,
    ...(Object.hasOwn(write, 'objectivePolicyProposal') ? { objectivePolicyProposal: write.objectivePolicyProposal } : {}) };
  const authority = { actor: write.requestedBy, sessionVersion: user.sessionVersion || 1,
    connectionId: connection.id, account: write.account, credentials: fingerprint(connection.encryptedCredentials),
    scopes: [...connection.metadata.grantedScopes].sort(), permissionMode: settings.permissionMode,
    consent: settings.consent || null, approval: { id: approval.id, revision: approval.revision || 1,
      decidedBy: approval.decidedBy, decidedAt: approval.decidedAt, payload: approval.payload } };
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const request = { provider: 'shopify', phase: 'shopify_mutation', method: 'POST',
    url: `https://${CONTENT_ACCOUNT}/admin/api/2026-07/graphql.json`, body: JSON.stringify({
      query: 'mutation RunvaraProductContent($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id title } userErrors { field message } } }',
      variables: { product: { id: write.input.productId, title: write.input.title,
        descriptionHtml: `<p>${escape(write.input.description).replace(/\n/g, '<br>')}</p>` } }
    }) };
  return { inputText: JSON.stringify(write.input), inputDigest: fingerprint(write.input),
    identityText: JSON.stringify(identity), identity: fingerprint(identity),
    authorityText: JSON.stringify(authority), authority: fingerprint(authority),
    requestText: JSON.stringify(request), requestDigest: fingerprint(request), request };
}

// All storage/provider traffic is synthetic. Persistence still uses the real
// Supabase adapter, its private beforeCommit boundary, revision CAS, and narrow
// context projection. A returned reordered ACK is explicitly synthetic: the
// adapter's real primary storage response only acknowledges workspace_id.
export async function contentJsonbFixture({ family = 'manual', consent = 'absent', reorder = jsonbOrder,
  cold = true, storageOrder = true, ackOrder = false, privateOrder = false,
  preparePrivateOrder = false, prepareAckOrder = false, seedChange, initialChange } = {}) {
  assert.ok(CONTENT_FAMILIES.includes(family));
  assert.ok([...CONTENT_CONSENTS, 'producer'].includes(consent));
  const initial = objectiveContentSeed();
  if (family === 'manual') initial.state.businessObjectives = [];
  const database = fakeSupabase();
  let reordering = false;
  const fetchImpl = async (url, options) => {
    const response = await database.fetchImpl(url, options);
    if (reordering && storageOrder) {
      for (const [id, snapshot] of database.states) database.states.set(id, reorder(snapshot));
    }
    return response;
  };
  const env = { SUPABASE_URL: 'https://content-jsonb.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only' };
  const store = createStore(env, { fetchImpl }), replica = createStore(env, { fetchImpl });
  await store.save(CONTENT_WORKSPACE, initial.state);
  let state = await store.get(CONTENT_WORKSPACE);
  if (consent === 'null') state.connectionSettings.shopify.consent = null;
  if (['settings', 'producer'].includes(consent)) saveConnectionSettings(state, 'shopify', {
    revision: connectionSettings(state, 'shopify').revision, permissionMode: 'automatic',
    confirmPermission: 'shopify:automatic'
  }, state.users[0]);
  await seedChange?.(state);
  const job = family === 'objective-v2' ? objectiveContentJob(state, initial.objective) : null;
  if (job) database.tables.set('runvara_agent_jobs', [job]);
  const hooks = { job: null, credentials: null, persist: null, beforeCommit: null, ack: null,
    fresh: null, beforeFresh: null, fetch: null };
  const counts = { job: 0, credentials: 0, saves: 0, fresh: 0, mutations: 0, privateChecks: 0 };
  const trace = [], requests = [], saves = [], contexts = [];
  const loadJob = async id => {
    counts.job++; trace.push(`job:${counts.job}`);
    await hooks.job?.(counts.job);
    return store.getAgentJob(CONTENT_WORKSPACE, id, { includeReport: true });
  };
  let body, context;
  const preparation = { privateChecks: 0, saves: 0 };
  if (job) {
    context = await objectiveContentContext(state, job.id, 'opportunity-content', initial.session, loadJob);
    body = { ...objectiveContentBody(context, 'content-jsonb-request-0001'), title: CONTENT_TITLE, description: CONTENT_DESCRIPTION };
    await prepareObjectiveContentRequest(state, body, initial.session, { loadJob,
      persist: async options => {
        preparation.saves++;
        const saved = await store.save(CONTENT_WORKSPACE, state, { ...options, beforeCommit: snapshot => {
          preparation.privateChecks++;
          options.beforeCommit(preparePrivateOrder ? reorder(snapshot) : snapshot);
        } });
        return prepareAckOrder ? reorder(saved) : saved;
      } });
  } else {
    body = { operation: 'product_content', requestId: 'content-jsonb-request-0001', productId: CONTENT_PRODUCT,
      title: CONTENT_TITLE, description: CONTENT_DESCRIPTION, target: resolveManualContentTarget(state).target };
    proposeConnectionWrite(state, 'shopify', body, initial.session.userId);
  }
  approveObjectiveContent(state, state.connectionWrites[0]);
  await initialChange?.(state);
  const before = structuredClone(state), expected = originalContentPreimages(before, before.connectionWrites[0]);
  reordering = true;
  await store.save(CONTENT_WORKSPACE, state);
  if (cold) state = await store.get(CONTENT_WORKSPACE);
  const write = state.connectionWrites[0];
  const service = new IntegrationService({}, { fetchImpl: async (url, request) => {
    counts.mutations++; trace.push('provider'); requests.push({ url, ...request });
    const response = await hooks.fetch?.(url, request);
    return response ?? Response.json({ data: { productUpdate: { product: { id: CONTENT_PRODUCT, title: body.title }, userErrors: [] } } });
  } });
  service.shopifyConfig = snapshot => ({ domain: snapshot.connections[0].metadata.shopDomain,
    workspaceId: CONTENT_WORKSPACE, mode: 'oauth', apiVersion: '2026-07', accessToken: 'synthetic-token' });
  service.connectorCredentials = async () => {
    counts.credentials++; trace.push('credentials'); await hooks.credentials?.(state); return { accessToken: 'synthetic-token' };
  };
  const persist = async options => {
    const number = ++counts.saves; trace.push(`save:${number}`);
    await hooks.persist?.(number, options);
    const guarded = options?.beforeCommit ? { ...options, beforeCommit: snapshot => {
      counts.privateChecks++;
      const inspected = privateOrder ? reorder(snapshot) : snapshot;
      hooks.beforeCommit?.(inspected, number, snapshot === state);
      options.beforeCommit(inspected);
    } } : options;
    let saved = await store.save(CONTENT_WORKSPACE, state, guarded);
    saves.push(structuredClone(database.states.get(CONTENT_WORKSPACE)));
    if (ackOrder) saved = reorder(saved);
    await hooks.ack?.(saved, number);
    return saved;
  };
  const loadFreshState = async input => {
    const number = ++counts.fresh; trace.push(`fresh:${number}`); contexts.push(structuredClone(input));
    await hooks.beforeFresh?.(number, input);
    const fresh = await store.getConnectionWriteContext(CONTENT_WORKSPACE, input);
    return await hooks.fresh?.(fresh, number, input) ?? fresh;
  };
  const run = (overrides = {}) => executeConnectionWrite(state, write.id, initial.session.userId, service, persist,
    { durableStore: true, actorSession: initial.session, loadObjectiveJob: loadJob, loadFreshState, ...overrides });
  const coldHistory = async () => {
    const coldState = await replica.get(CONTENT_WORKSPACE);
    const history = job ? await readObjectiveContentRequest(coldState, body.requestId, initial.session, loadJob)
      : readManualContentRequest(coldState, body.requestId, initial.session.userId);
    return { state: coldState, history };
  };
  Object.keys(counts).forEach(key => { counts[key] = 0; }); trace.length = 0;
  return { ...initial, state, write, family, consent, before, expected, body, context, job, database, preparation,
    store, replica, service, hooks, counts, trace, requests, saves, contexts, loadJob, loadFreshState, persist, run, coldHistory };
}
