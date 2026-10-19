// SIMULATION ONLY. No real credentials, provider transport, database, or live mode.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createPacksmartServer } from '../server.mjs';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken, verifySessionToken, encryptCredentials } from '../lib/security.mjs';
import { IntegrationService } from '../lib/integrations.mjs';
import { createContentPilot, DESCRIPTION_PILOT_SCHEMA, DESCRIPTION_PILOT_BASELINE_QUERY } from '../lib/content-pilot.mjs';
import { DESCRIPTION_EDIT_SCHEMA, descriptionEditMutation, replaceDescriptionParagraph } from '../lib/description-edit.mjs';
import { DESCRIPTION_EXECUTION_RECEIPT_CONTRACT, CONTENT_EXECUTION_RECEIPT_ACK_SCHEMA,
  CONTENT_EXECUTION_RESERVED_BYTES, contentReceiptRequestFingerprint, validateContentExecutionCommit } from '../lib/content-execution-receipt.mjs';
import { resolveProtectedReceiptEvidence } from '../lib/protected-receipt-source.mjs';
import { REVIEWED_DESCRIPTION_ACTION_CONTRACT } from '../lib/reviewed-action-evidence.mjs';
import { fakeSupabase } from '../tests/fake-supabase.mjs';
import { createSyntheticAttempt, assertSyntheticAttemptBinding, syntheticAttemptDetails,
  consumeSyntheticAttempt, syntheticAttemptCheckpoint } from './simulation-attempt.mjs';

export const SIMULATION_CONFIG = Object.freeze({
  mode: 'simulated', workspaceId: 'runvara-description-simulation',
  shopDomain: 'runvara-description-simulation.myshopify.com', productId: 'gid://shopify/Product/900000000001',
  connectionId: 'simulation-shopify', apiVersion: '2026-07', listenHost: '127.0.0.1',
  publicUrl: 'http://127.0.0.1', storageUrl: 'https://runvara-simulation.invalid',
  publicSync: false, environmentFallback: false, repositoryFallback: false
});
const TOKEN = 'SIMULATED_ONLY_NOT_A_SHOPIFY_TOKEN';
const OWNER = 'simulation-owner', EXPERIMENT = 'experiment_simulated_description';
export const SIMULATED_RECEIPT_ROUTE = `/api/business-outcomes/experiments/${EXPERIMENT}/content-sources`;
const faults = new Set(['none', 'stale_baseline', 'provider_lost_response', 'provider_wrong_id',
  'reserve_refused', 'reserve_ack_lost', 'reserve_unknown', 'finalize_ack_lost', 'finalize_unknown']);
const fail = (code = 'SIMULATION_ISOLATION_REQUIRED') => Object.assign(new Error(code), { code });
const copy = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function plain(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) throw fail();
}
export function validateSimulationConfig(config) {
  plain(config);
  if (Object.keys(config).length !== Object.keys(SIMULATION_CONFIG).length
    || Object.entries(SIMULATION_CONFIG).some(([key, value]) => !Object.hasOwn(config, key) || config[key] !== value)) throw fail();
  return SIMULATION_CONFIG;
}
function workspace(id) { if (id !== SIMULATION_CONFIG.workspaceId) throw fail(); }
function stateScope(state) {
  workspace(state?.workspace?.id);
  if (state.connections?.length !== 1 || state.connections[0].id !== SIMULATION_CONFIG.connectionId
    || state.connections[0].provider !== 'shopify' || state.connections[0].metadata?.shopDomain !== SIMULATION_CONFIG.shopDomain
    || state.products?.length !== 1 || state.products[0].id !== SIMULATION_CONFIG.productId) throw fail();
}

// This transport has no network delegate. Its input is a real adapter request;
// its output is explicitly fabricated and cannot prove PostgreSQL enforcement.
function simulatedStorage(initial, fault, trace) {
  const database = fakeSupabase({ initialStates: [initial] }), ledger = new Map();
  const calls = { reserve: 0, finalize: 0, lookup: 0, receiptRead: 0 };
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    if (url.origin !== SIMULATION_CONFIG.storageUrl || url.username || url.password
      || !url.pathname.startsWith('/rest/v1/')) throw fail();
    const name = url.pathname.split('/').at(-1), body = options.body ? JSON.parse(options.body) : null;
    if (url.searchParams.has('workspace_id')) {
      if (url.searchParams.get('workspace_id') !== `eq.${SIMULATION_CONFIG.workspaceId}`) throw fail();
    }
    if (body?.p_workspace_id !== undefined) workspace(body.p_workspace_id);
    if (body?.state) stateScope(body.state);
    if (Array.isArray(body)) for (const row of body) if (row.workspace_id !== undefined) workspace(row.workspace_id);
    if (name === 'runvara_reserve_content_receipt' || name === 'runvara_finalize_content_receipt') {
      const raw = body.p_request_json, r = JSON.parse(raw), kind = name.includes('_reserve_') ? 'reserve' : 'finalize';
      workspace(r.workspaceId); stateScope(r.state);
      if (r.kind !== kind || r.contract !== DESCRIPTION_EXECUTION_RECEIPT_CONTRACT) throw fail();
      validateContentExecutionCommit({ contract: r.contract, kind, admission: r.admission,
        ...(kind === 'reserve' ? { sourceTemplate: r.sourceTemplate } : { receipt: r.receipt }) });
      calls[kind]++; trace.push(`simulated_storage:${kind}`);
      const key = `${kind}:${r.admission.attemptId}`, saved = ledger.get(key);
      const unknown = fault === `${kind}_unknown`;
      if (saved) {
        if (saved.raw !== raw) return Response.json({ code: 'P0R04' }, { status: 409 });
        if (unknown) throw fail('SIMULATED_ACK_UNAVAILABLE');
        return Response.json({ ...saved.ack, replayed: true });
      }
      if (fault === 'reserve_refused' && kind === 'reserve') return Response.json({ code: 'P0R05' }, { status: 409 });
      if (database.states.get(r.workspaceId)?._revision !== r.expectedRevision) return Response.json({ code: 'P0R02' }, { status: 409 });
      if (kind === 'finalize' && !ledger.has(`reserve:${r.admission.attemptId}`)) throw fail();
      const ack = { schema: CONTENT_EXECUTION_RECEIPT_ACK_SCHEMA, kind, workspaceId: r.workspaceId,
        attemptId: r.admission.attemptId, admissionDigest: r.admission.digest, intentDigest: r.admission.intentDigest,
        requestFingerprint: contentReceiptRequestFingerprint(raw), expectedRevision: r.expectedRevision, nextRevision: r.nextRevision,
        receiptDigest: kind === 'finalize' ? r.receipt.digest : null, reservedBytes: CONTENT_EXECUTION_RESERVED_BYTES, replayed: false };
      ledger.set(key, { raw, ack, request: copy(r) }); database.states.set(r.workspaceId, copy(r.state));
      if (unknown || fault === `${kind}_ack_lost`) throw fail('SIMULATED_ACK_LOST');
      return Response.json(ack);
    }
    if (name === 'runvara_read_content_receipt') {
      calls.lookup++; trace.push('simulated_storage:reconciliation');
      if (fault === `${body.p_kind}_unknown`) throw fail('SIMULATED_LOOKUP_UNAVAILABLE');
      const row = ledger.get(`${body.p_kind}:${body.p_attempt_id}`);
      return Response.json(row?.ack.requestFingerprint === body.p_request_fingerprint ? { ...row.ack, replayed: true } : null);
    }
    if (name === 'runvara_read_outcome_content_sources') {
      calls.receiptRead++;
      const state = database.states.get(body.p_workspace_id), actor = state.users.find(user => user.id === body.p_actor_id);
      if (!actor || actor.role !== 'owner' || !actor.active || actor.sessionVersion !== body.p_actor_session_version) return Response.json({ code: 'P0O03' }, { status: 403 });
      if (body.p_experiment_id !== EXPERIMENT) return Response.json({ code: 'P0O09' }, { status: 409 });
      const final = [...ledger.values()].find(row => row.request.kind === 'finalize');
      const evidence = final ? { schema: 'runvara-outcome-content-source-private/v1', admission: final.request.admission,
        receipt: final.request.receipt, commitRevision: final.request.nextRevision } : null;
      const resolved = evidence ? resolveProtectedReceiptEvidence(evidence, { workspaceId: body.p_workspace_id }) : null;
      if (body.p_receipt_selector) {
        if (!evidence) return Response.json({ code: 'P0O01' }, { status: 409 });
        resolveProtectedReceiptEvidence(evidence, { workspaceId: body.p_workspace_id, selector: body.p_receipt_selector });
      }
      const c = resolved?.source.context;
      const choices = resolved && (!body.p_after_attempt_id || resolved.receiptSource.attemptId > body.p_after_attempt_id)
        ? [{ receiptSource: resolved.receiptSource, actionId: c.writeId, account: c.account,
          productId: resolved.source.input.productId, title: 'Shopify description change', completedAt: c.completedAt,
          origin: c.origin, originatingObjective: c.originatingObjective }] : [];
      return Response.json({ schema: 'runvara-outcome-content-source-reader/v1',
        review: { workspaceId: state.workspace.id, workspaceRevision: state._revision,
          experiment: { id: EXPERIMENT, title: 'SIMULATED receipt display only', status: 'draft' }, measurement: null,
          current: null, actionLinkContract: REVIEWED_DESCRIPTION_ACTION_CONTRACT, currentActionAssociation: null, actionChoices: [] },
        receiptChoices: choices, nextCursor: null, hasMore: false, selectedEvidence: body.p_receipt_selector ? evidence : null });
    }
    // No unknown RPC can silently gain behavior from the permissive table fake.
    if (url.pathname.includes('/rpc/') && name !== 'runvara_commit_reporting_status') throw fail('SIMULATION_RPC_NOT_ALLOWED');
    return database.fetchImpl(url, options);
  };
  return { fetchImpl, database, ledger, calls };
}

export function descriptionSimulationInput() {
  const paragraphHtml = '<p class="details">Original <strong>simulated</strong> wording.</p>';
  const baselineHtml = '<div>\r\n<p>Keep &amp; preserve.</p>\n' + paragraphHtml + '\n<ul><li>Keep this list.</li></ul></div>';
  const replacementText = 'Approved simulation & only <text>.\nCaf\u00e9 \u{1f642}';
  return { schema: DESCRIPTION_EDIT_SCHEMA, productId: SIMULATION_CONFIG.productId, operation: 'product_content',
    baselineHtml, baselineUpdatedAt: '2026-10-15T00:00:00Z', paragraphHtml, replacementText,
    descriptionHtml: replaceDescriptionParagraph(baselineHtml, paragraphHtml, replacementText) };
}
export function descriptionSimulationBinding(input = descriptionSimulationInput()) {
  return { mode: 'simulated', workspaceId: SIMULATION_CONFIG.workspaceId, connectionId: SIMULATION_CONFIG.connectionId,
    account: SIMULATION_CONFIG.shopDomain, productId: SIMULATION_CONFIG.productId, operation: 'product_content',
    requestedBy: OWNER, settingsRevision: 1, apiVersion: '2026-07', inputDigest: hash(input) };
}

export function createSimulatedProvider(input, { fault = 'none', trace = [], attempt = null } = {}) {
  if (!faults.has(fault)) throw fail();
  const expected = descriptionEditMutation(input), requests = [], counts = { baseline: 0, mutations: 0 };
  const binding = descriptionSimulationBinding(input);
  if (attempt) assertSyntheticAttemptBinding(attempt, binding);
  let retainedAttempt = attempt ? Promise.resolve(attempt) : null;
  let descriptionHtml = input.baselineHtml;
  const fetchImpl = async (url, options = {}) => {
    if (url !== `https://${SIMULATION_CONFIG.shopDomain}/admin/api/2026-07/graphql.json`
      || options.method !== 'POST' || options.redirect !== 'error'
      || new Headers(options.headers).get('X-Shopify-Access-Token') !== TOKEN) throw fail('SIMULATION_PROVIDER_REQUEST_DENIED');
    const body = JSON.parse(options.body);
    if (body.query === DESCRIPTION_PILOT_BASELINE_QUERY && JSON.stringify(body.variables) === JSON.stringify({ id: SIMULATION_CONFIG.productId })
      && Object.keys(body).length === 2) {
      counts.baseline++; trace.push('simulated_provider:baseline');
      return Response.json({ data: { product: { id: SIMULATION_CONFIG.productId,
        descriptionHtml: fault === 'stale_baseline' ? '<p>Changed in the simulation.</p>' : descriptionHtml, updatedAt: input.baselineUpdatedAt } } });
    }
    if (options.body !== JSON.stringify(expected) || expected.variables.product.id !== SIMULATION_CONFIG.productId) throw fail('SIMULATION_PROVIDER_REQUEST_DENIED');
    if (counts.mutations !== 0) throw fail('SIMULATION_ATTEMPT_CONSUMED');
    retainedAttempt ??= createSyntheticAttempt(binding);
    const durableAttempt = await retainedAttempt;
    await consumeSyntheticAttempt(durableAttempt, binding);
    counts.mutations++; trace.push('simulated_provider:mutation'); requests.push({ url, body: options.body });
    descriptionHtml = input.descriptionHtml;
    await syntheticAttemptCheckpoint(durableAttempt, 'simulated_submission');
    if (fault === 'provider_lost_response') throw fail('SIMULATED_PROVIDER_RESPONSE_LOST');
    return Response.json({ data: { productUpdate: { product: { id: fault === 'provider_wrong_id' ? 'gid://shopify/Product/999' : SIMULATION_CONFIG.productId }, userErrors: [] } } });
  };
  return { fetchImpl, counts, requests, snapshot: () => ({ simulated: true, descriptionHtml }) };
}

export async function createDescriptionSimulation(options = {}) {
  plain(options);
  if (Object.keys(options).some(key => !['config', 'fault', 'attempt'].includes(key))) throw fail();
  const config = validateSimulationConfig(options.config ?? SIMULATION_CONFIG), fault = options.fault ?? 'none';
  if (!faults.has(fault)) throw fail();
  const trace = [], secret = randomBytes(32).toString('hex'), encryption = randomBytes(32).toString('hex');
  const env = { NODE_ENV: 'test', APP_PUBLIC_URL: config.publicUrl, SESSION_SECRET: secret, CREDENTIALS_KEY: encryption,
    SHOPIFY_PUBLIC_SYNC_ENABLED: 'false', SHOPIFY_ENV_WORKSPACE_ID: 'simulation-environment-disabled',
    SHOPIFY_ADMIN_API_VERSION: config.apiVersion, CONTENT_EXECUTION_RECEIPT_CONTRACT: DESCRIPTION_EXECUTION_RECEIPT_CONTRACT };
  const state = seedWorkspaceState({}, { workspaceId: config.workspaceId, userId: OWNER, email: 'simulation-owner@example.test', passwordHash: 'SIMULATED_LOGIN_DISABLED' });
  state._revision = randomUUID(); state.storageReady = true;
  state.connections = [{ id: config.connectionId, provider: 'shopify',
    encryptedCredentials: encryptCredentials({ storeDomain: config.shopDomain, accessToken: TOKEN }, encryption),
    metadata: { shopDomain: config.shopDomain, grantedScopes: ['read_products', 'write_products'] } }];
  state.connectionSettings = { shopify: { permissionMode: 'approval_gated', revision: 1 } };
  state.products = [{ id: config.productId, provider: 'shopify', title: 'SIMULATED product only', status: 'draft' }];
  state.connectionWrites = []; state.businessObjectives = [];
  state.revenueEngine.experiments = [{ id: EXPERIMENT, title: 'SIMULATED receipt display only', status: 'draft' }];
  const input = descriptionSimulationInput(), binding = descriptionSimulationBinding(input);
  const attempt = options.attempt ?? await createSyntheticAttempt(binding);
  assertSyntheticAttemptBinding(attempt, binding);
  const attemptDetails = syntheticAttemptDetails(attempt), requestId = attemptDetails.requestId;
  const pilot = createContentPilot({ schema: DESCRIPTION_PILOT_SCHEMA, workspaceId: config.workspaceId,
    connectionId: config.connectionId, account: config.shopDomain, productId: config.productId,
    operation: 'product_content', requestId, requestedBy: OWNER, inputDigest: hash(input), settingsRevision: 1,
    expiresAt: new Date(Date.now() + 300000).toISOString(), input });
  const storage = simulatedStorage(state, fault, trace), provider = createSimulatedProvider(input, { fault, trace, attempt });
  const adapter = createStore({ ...env, SUPABASE_URL: config.storageUrl, SUPABASE_SERVICE_ROLE_KEY: 'SIMULATED_ONLY' }, { fetchImpl: storage.fetchImpl });
  // Retain real adapter methods; expose only the workspace-scoped surface needed
  // by this flow. No integrityCheck means no customer-zero startup probe.
  const store = Object.freeze({ provider: adapter.provider, contentExecutionReceiptCapability: adapter.contentExecutionReceiptCapability,
    get: id => { workspace(id); return adapter.get(id); },
    getIdentity: id => { workspace(id); return adapter.getIdentity(id); },
    save: (id, next, settings) => {
      workspace(id); stateScope(next);
      if (next.connections[0].encryptedCredentials !== state.connections[0].encryptedCredentials) throw fail();
      return adapter.save(id, next, settings);
    },
    getConnectionWriteContext: (id, context) => { workspace(id); return adapter.getConnectionWriteContext(id, context); },
    getBusinessOutcomeReview: (id, ...args) => { workspace(id); return adapter.getBusinessOutcomeReview(id, ...args); }
  });
  const integrations = new IntegrationService(env, { fetchImpl: provider.fetchImpl });
  const server = createPacksmartServer(env, { store, integrations, contentPilot: pilot, schedulerEnabled: false,
    agentOpsEnabled: false, fetchImpl: async () => { throw fail('SIMULATION_EXTERNAL_TRANSPORT_DISABLED'); } });
  const token = createSessionToken({ userId: OWNER, workspaceId: config.workspaceId, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  const csrf = verifySessionToken(token, secret).csrf;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await server.packsmart.drain(); }
    finally { if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  };
  try { server.listen(0, config.listenHost); await once(server, 'listening'); }
  catch (error) { await close(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || address.family !== 'IPv4') {
    await close(); throw fail('SIMULATION_LISTENER_NOT_LOOPBACK');
  }
  const port = address.port;
  const request = async (route, body, { method = body === undefined ? 'GET' : 'POST', authenticated = true, withCsrf = true } = {}) => {
    if (closed || !/^\/api\/[A-Za-z0-9_/-]+$/.test(route) || !['GET', 'POST', 'PUT'].includes(method)) throw fail('SIMULATION_HTTP_REQUEST_DENIED');
    const data = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path: route, method, agent: false,
        headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: `packsmart_session=${token}` } : {}),
          ...(withCsrf ? { 'X-CSRF-Token': csrf } : {}) } }, res => {
        let raw = ''; res.setEncoding('utf8');
        res.on('data', chunk => { raw += chunk; if (raw.length > 262144) req.destroy(fail('SIMULATION_RESPONSE_TOO_LARGE')); });
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); } catch (error) { reject(error); } });
      });
      req.setTimeout(10000, () => req.destroy(fail('SIMULATION_HTTP_TIMEOUT')));
      req.on('error', reject); req.end(data);
    });
  };
  return { simulated: true, input: copy(input), body: { ...copy(input), requestId,
    target: { schema: 'runvara-manual-content-target/v1', connectionId: config.connectionId, account: config.shopDomain, settingsRevision: 1 } },
    requestId, request, close, store, integrations, provider, storage, trace, port, attemptDetails,
    lifecycle: () => ({ host: address.address, family: address.family, port, listening: server.listening, closed,
      address: server.address(),
      scheduler: { ...server.packsmart.scheduler.status }, agentOps: { ...server.packsmart.agentOps.status } }) };
}

export async function runDescriptionSimulation() {
  const f = await createDescriptionSimulation();
  try {
    const proposal = await f.request('/api/connections/shopify/writes', f.body);
    assert.equal(proposal.status, 200, JSON.stringify(proposal.body));
    const write = proposal.body.write;
    const approval = await f.request(`/api/approvals/${write.approvalId}/decision`, { decision: 'approved', revision: 1 });
    assert.equal(approval.status, 200, JSON.stringify(approval.body));
    assert.equal(f.provider.counts.mutations, 0);
    const execution = await f.request(`/api/connection-writes/${write.id}/execute`, {});
    assert.equal(execution.status, 200, JSON.stringify(execution.body));
    assert.equal(execution.body.write.status, 'completed');
    const final = [...f.storage.ledger.values()].find(row => row.request.kind === 'finalize').request;
    const selector = { attemptId: final.receipt.attemptId, receiptDigest: final.receipt.digest, sourceDigest: final.receipt.source.digest };
    const receipt = await f.request(SIMULATED_RECEIPT_ROUTE, { receipt: selector, afterAttemptId: null });
    assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
    assert.deepEqual(receipt.body.selectedReceiptSource.input, f.input);
    return { simulated: true, acceptance: 'SIMULATED ONLY — not Shopify or hosted Supabase acceptance',
      proposalStatus: proposal.status, approvalStatus: approval.status, executionStatus: execution.body.write.status,
      receiptReadStatus: receipt.status, provider: { simulated: true, ...f.provider.counts },
      storage: { simulated: true, ...f.storage.calls }, receiptDigest: final.receipt.digest,
      trace: [...f.trace], persistedAttempt: f.attemptDetails, loopbackPort: f.port,
      boundAddress: f.lifecycle().address, serverStopped: (await f.close(), !f.lifecycle().listening) };
  } finally { await f.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw fail('SIMULATION_ARGUMENTS_NOT_SUPPORTED');
    process.stdout.write(JSON.stringify(await runDescriptionSimulation(), null, 2) + '\n');
  } catch (error) { process.stderr.write(`SIMULATED RUN FAILED: ${error.code || error.name}\n`); process.exitCode = 1; }
}
