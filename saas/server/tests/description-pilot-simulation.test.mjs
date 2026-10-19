// All provider and storage responses are SIMULATED. Only HTTP is real loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createDescriptionSimulation, createSimulatedProvider, SIMULATION_CONFIG,
  SIMULATED_RECEIPT_ROUTE, runDescriptionSimulation, validateSimulationConfig } from '../scripts/simulate-description-pilot.mjs';
import { descriptionEditMutation } from '../lib/description-edit.mjs';
import { DESCRIPTION_PILOT_BASELINE_QUERY } from '../lib/content-pilot.mjs';

async function refusedPort(port) {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Loopback shutdown check timed out')); });
    socket.once('connect', () => { socket.destroy(); reject(new Error('Simulation listener remained open')); });
    socket.once('error', error => { socket.destroy(); error.code === 'ECONNREFUSED' ? resolve() : reject(error); });
  });
}
async function fixture(t, options = {}) {
  const f = await createDescriptionSimulation(options);
  t.after(async () => { await f.close(); assert.equal(f.lifecycle().listening, false); await refusedPort(f.port); });
  return f;
}
async function propose(f, body = f.body) {
  const response = await f.request('/api/connections/shopify/writes', body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.write;
}
async function approve(f, write) {
  const response = await f.request(`/api/approvals/${write.approvalId}/decision`, { decision: 'approved', revision: 1 });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}
const execute = (f, write) => f.request(`/api/connection-writes/${write.id}/execute`, {});
const history = f => f.request(`/api/connections/shopify/content-requests/${f.requestId}`);
const receipts = f => [...f.storage.ledger.values()].filter(row => row.request.kind === 'finalize');

test('SIMULATED genuine HTTP proposal, approval, execution and protected receipt read', async t => {
  const f = await fixture(t);
  assert.equal(f.lifecycle().host, '127.0.0.1');
  assert.equal(f.lifecycle().scheduler.running, false); assert.equal(f.lifecycle().scheduler.lastTickAt, null);
  assert.equal(f.lifecycle().agentOps.running, false); assert.equal(f.lifecycle().agentOps.pollCalls, 0);
  const write = await propose(f);
  assert.equal(write.status, 'pending_approval'); assert.equal(f.provider.counts.mutations, 0);
  await approve(f, write);
  assert.equal(f.provider.counts.mutations, 0, 'Approval alone must never dispatch');
  const result = await execute(f, write);
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.write.status, 'completed');
  assert.equal(result.body.executedExternally, true, 'Real route DTO; enclosing harness labels its provider as simulated');
  assert.equal(f.provider.counts.mutations, 1); assert.equal(f.provider.counts.baseline, 1);
  assert.deepEqual(f.trace, ['simulated_storage:reserve', 'simulated_provider:baseline', 'simulated_provider:mutation', 'simulated_storage:finalize']);
  const mutation = JSON.parse(f.provider.requests[0].body);
  assert.deepEqual(Object.keys(mutation.variables.product).sort(), ['descriptionHtml', 'id']);
  assert.deepEqual(mutation, descriptionEditMutation(f.input));
  assert.equal(f.provider.snapshot().descriptionHtml, f.input.descriptionHtml);
  const final = receipts(f)[0].request;
  assert.equal(final.contract, 'runvara-content-execution-receipts/v2');
  assert.deepEqual(final.receipt.source.input, f.input);
  const selector = { attemptId: final.receipt.attemptId, receiptDigest: final.receipt.digest, sourceDigest: final.receipt.source.digest };
  const read = await f.request(SIMULATED_RECEIPT_ROUTE, { receipt: selector, afterAttemptId: null });
  assert.equal(read.status, 200, JSON.stringify(read.body)); assert.deepEqual(read.body.selectedReceiptSource.input, f.input);
  assert.equal(read.body.receiptChoices[0].title, 'Shopify description change');
  assert.equal((await history(f)).status, 200);
  const exposed = JSON.stringify([result.body, read.body]);
  for (const forbidden of ['encryptedCredentials', 'SIMULATED_ONLY_NOT_A_SHOPIFY_TOKEN', 'authorityDigest', 'actorSessionVersion', 'claimIdentity']) assert.equal(exposed.includes(forbidden), false, forbidden);
  assert.equal(f.storage.database.states.has('packsmart-solutions'), false);
  assert.equal(f.storage.database.calls.some(call => call.url.href.includes('packsmart-solutions')), false);
});

test('SIMULATED production hosts, workspaces, credentials and fallback configuration are rejected', async t => {
  const changes = [
    { shopDomain: 'wavtzm-vy.myshopify.com' }, { shopDomain: 'runvara-qa-pygr0cgf.myshopify.com' },
    { workspaceId: 'packsmart-solutions' }, { connectionId: 'production-shopify' },
    { publicUrl: 'https://packsmart-ops.onrender.com' }, { storageUrl: 'https://production.supabase.co' },
    { listenHost: '0.0.0.0' }, { listenHost: '::' }, { publicSync: true }, { environmentFallback: true },
    { repositoryFallback: true }, { mode: 'live' }, { productId: 'gid://shopify/Product/1' },
    { apiVersion: '2026-10' }, { token: 'UNTRUSTED_FAKE_TOKEN' }, { repoRoot: '.' }, { NODE_ENV: 'production' }
  ];
  for (const change of changes) await t.test(JSON.stringify(change), async () => {
    assert.throws(() => validateSimulationConfig({ ...SIMULATION_CONFIG, ...change }), { code: 'SIMULATION_ISOLATION_REQUIRED' });
    await assert.rejects(() => createDescriptionSimulation({ config: { ...SIMULATION_CONFIG, ...change } }), { code: 'SIMULATION_ISOLATION_REQUIRED' });
  });
  for (const unknown of [{ env: {} }, { fetchImpl: () => {} }, { credentials: {} }, { contentPilot: {} }, { fault: 'live' }]) {
    await assert.rejects(() => createDescriptionSimulation(unknown), { code: 'SIMULATION_ISOLATION_REQUIRED' });
  }
});

test('SIMULATED runner ignores hostile ambient environment and has no CLI live arguments', async () => {
  const script = fileURLToPath(new URL('../scripts/simulate-description-pilot.mjs', import.meta.url));
  const child = promisify(execFile);
  // Construct only fake variables; never read or copy the executor environment.
  const env = { NODE_ENV: 'production', APP_PUBLIC_URL: 'https://packsmart-ops.onrender.com',
    SHOPIFY_STORE_DOMAIN: 'wavtzm-vy.myshopify.com', SHOPIFY_CLIENT_SECRET: 'SIMULATED_HOSTILE_VALUE',
    SHOPIFY_ADMIN_ACCESS_TOKEN: 'SIMULATED_HOSTILE_VALUE', SHOPIFY_PUBLIC_SYNC_ENABLED: 'true',
    SUPABASE_URL: 'https://production.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'SIMULATED_HOSTILE_VALUE',
    GOVERNED_RECORD_PRODUCER_CONTRACT: 'runvara-governed-record-producers/v1' };
  const { stdout, stderr } = await child(process.execPath, [script], { env, windowsHide: true, timeout: 20000 });
  assert.equal(stderr, '');
  const report = JSON.parse(stdout);
  assert.equal(report.simulated, true); assert.equal(report.serverStopped, true); assert.equal(report.provider.mutations, 1);
  assert.match(report.acceptance, /not Shopify or hosted Supabase acceptance/);
  await refusedPort(report.loopbackPort);
  await assert.rejects(() => child(process.execPath, [script, '--live'], { env, windowsHide: true, timeout: 10000 }), error => {
    assert.match(error.stderr, /SIMULATION_ARGUMENTS_NOT_SUPPORTED/); return true;
  });
});

test('SIMULATED store blocks production workspace, connection and credential replacement', async t => {
  const f = await fixture(t);
  assert.throws(() => f.store.get('packsmart-solutions'), { code: 'SIMULATION_ISOLATION_REQUIRED' });
  assert.throws(() => f.store.getIdentity('packsmart-solutions'), { code: 'SIMULATION_ISOLATION_REQUIRED' });
  for (const change of ['workspace', 'account', 'connection', 'credentials', 'product']) {
    const state = await f.store.get(SIMULATION_CONFIG.workspaceId);
    if (change === 'workspace') state.workspace.id = 'packsmart-solutions';
    if (change === 'account') state.connections[0].metadata.shopDomain = 'wavtzm-vy.myshopify.com';
    if (change === 'connection') state.connections[0].id = 'production-shopify';
    if (change === 'credentials') state.connections[0].encryptedCredentials = 'UNTRUSTED_FAKE_CIPHERTEXT';
    if (change === 'product') state.products[0].id = 'gid://shopify/Product/1';
    assert.throws(() => f.store.save(SIMULATION_CONFIG.workspaceId, state), { code: 'SIMULATION_ISOLATION_REQUIRED' });
  }
  assert.equal(f.integrations.shopifyPublicCatalogueUrl(await f.store.get(SIMULATION_CONFIG.workspaceId)), null);
  const state = await f.store.get(SIMULATION_CONFIG.workspaceId); state.connections = [];
  assert.equal(f.integrations.shopifyConfigured(state), false);
  assert.throws(() => f.integrations.shopifyConfig(state), { code: 'SHOPIFY_NOT_CONFIGURED' });
  await assert.rejects(() => f.integrations.loadShopifySnapshot(), { code: 'SHOPIFY_SNAPSHOT_UNAVAILABLE' });
});

test('SIMULATED proposal rejects unknown fields, another product, target and capability', async t => {
  const f = await fixture(t);
  for (const body of [{ ...f.body, title: 'Forbidden title' }, { ...f.body, price: '1.00' },
    { ...f.body, contentPilot: {} }, { ...f.body, productId: 'gid://shopify/Product/1' },
    { ...f.body, requestId: 'simulation_another_request' },
    { ...f.body, target: { ...f.body.target, account: 'wavtzm-vy.myshopify.com' } },
    { ...f.body, target: { ...f.body.target, settingsRevision: 2 } }]) {
    const response = await f.request('/api/connections/shopify/writes', body);
    assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(response));
  }
  assert.equal((await f.store.get(SIMULATION_CONFIG.workspaceId)).connectionWrites.length, 0);
  assert.equal(f.provider.counts.mutations, 0); assert.equal(f.storage.ledger.size, 0);
});

test('SIMULATED authentication, CSRF, missing approval and stale approval revision stop before provider', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/connections/shopify/writes', f.body, { authenticated: false })).status, 401);
  assert.equal((await f.request('/api/connections/shopify/writes', f.body, { withCsrf: false })).status, 403);
  const write = await propose(f);
  assert.equal((await execute(f, write)).status, 409);
  const revision = await f.request(`/api/approvals/${write.approvalId}/decision`, { decision: 'approved', revision: 2 });
  assert.equal(revision.status, 409); assert.equal(revision.body.code, 'APPROVAL_CONFLICT');
  assert.equal(f.provider.counts.baseline, 0); assert.equal(f.provider.counts.mutations, 0); assert.equal(f.storage.ledger.size, 0);
  const broad = await f.request('/api/business-objectives', { title: 'Unrelated producer', metric: 'orders', baseline: 1, target: 2,
    direction: 'increase', startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 86400000).toISOString(),
    limits: { profitFirst: true }, executionPolicy: { schema: 'runvara-objective-execution-policy/v1', mode: 'enforce',
      scope: { provider: 'shopify', operation: 'product_content', connectionId: SIMULATION_CONFIG.connectionId, account: SIMULATION_CONFIG.shopDomain } } }, { method: 'PUT' });
  assert.equal(broad.status, 503); assert.equal(broad.body.code, 'GOVERNED_RECORDS_PAUSED');
});

test('SIMULATED changed settings and revoked provider scope invalidate an approved request', async t => {
  for (const change of ['settings', 'scope']) await t.test(change, async t => {
    const f = await fixture(t), write = await propose(f); await approve(f, write);
    const state = await f.store.get(SIMULATION_CONFIG.workspaceId);
    if (change === 'settings') state.connectionSettings.shopify.revision++;
    else state.connections[0].metadata.grantedScopes = ['read_products'];
    await f.store.save(SIMULATION_CONFIG.workspaceId, state);
    const result = await execute(f, write);
    assert.equal(result.status, 409, JSON.stringify(result));
    assert.equal(f.provider.counts.mutations, 0); assert.equal(f.storage.ledger.size, 0);
  });
});

test('SIMULATED stale baseline reserves then refuses the mutation and any repeat', async t => {
  const f = await fixture(t, { fault: 'stale_baseline' }), write = await propose(f); await approve(f, write);
  const result = await execute(f, write);
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.write.status, 'failed');
  assert.equal(result.body.write.errorCode, 'WRITE_BASELINE_CHANGED');
  assert.equal(f.provider.counts.baseline, 1); assert.equal(f.provider.counts.mutations, 0);
  assert.equal(f.storage.calls.reserve, 1); assert.equal(receipts(f).length, 0);
  assert.equal((await execute(f, write)).status, 409);
});

test('SIMULATED concurrent and repeated execution permits only one mutation', async t => {
  const f = await fixture(t), write = await propose(f); await approve(f, write);
  const results = await Promise.all([execute(f, write), execute(f, write)]);
  for (const result of results) assert.equal(result.body.write?.status, 'completed', JSON.stringify(result));
  assert.equal(f.provider.counts.mutations, 1); assert.equal(f.storage.calls.reserve, 1); assert.equal(f.storage.calls.finalize, 1);
  assert.equal((await propose(f)).id, write.id);
  assert.equal((await execute(f, write)).body.write.status, 'completed');
  assert.equal(f.provider.counts.mutations, 1);
});

test('SIMULATED ambiguous provider responses never mint success receipts or resend', async t => {
  for (const fault of ['provider_lost_response', 'provider_wrong_id']) await t.test(fault, async t => {
    const f = await fixture(t, { fault }), write = await propose(f); await approve(f, write);
    const result = await execute(f, write);
    assert.equal(result.status, 200); assert.equal(result.body.write.status, 'uncertain');
    assert.equal(result.body.executedExternally, false); assert.equal(f.provider.counts.mutations, 1);
    assert.equal(receipts(f).length, 0); assert.equal((await execute(f, write)).status, 409);
    assert.equal(f.provider.counts.mutations, 1); assert.equal((await history(f)).status, 200);
  });
});

test('SIMULATED receipt refusal, lost acknowledgements and unknown outcomes remain bounded', async t => {
  for (const fault of ['reserve_refused', 'reserve_ack_lost', 'finalize_ack_lost', 'reserve_unknown', 'finalize_unknown']) await t.test(fault, async t => {
    const f = await fixture(t, { fault }), write = await propose(f); await approve(f, write);
    const result = await execute(f, write);
    if (fault.endsWith('ack_lost')) {
      assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.write.status, 'completed');
      assert.equal(f.storage.calls.lookup, 1); assert.equal(f.provider.counts.mutations, 1); assert.equal(receipts(f).length, 1);
    } else {
      assert.ok(result.status >= 400, JSON.stringify(result));
      assert.equal(result.body.code, fault === 'reserve_refused' ? 'CONTENT_RECEIPT_CAPACITY_EXHAUSTED' : 'CONTENT_RECEIPT_COMMIT_UNCONFIRMED');
      assert.equal(f.provider.counts.mutations, fault === 'finalize_unknown' ? 1 : 0);
      if (fault.endsWith('unknown')) assert.equal(f.storage.calls.lookup, 2);
    }
    const before = f.provider.counts.mutations; await execute(f, write);
    assert.equal(f.provider.counts.mutations, before, 'Reconciliation must never replay provider submission');
  });
});

test('SIMULATED transport rejects production, redirects, extra fields, products and second sends', async t => {
  const f = await fixture(t), expectedUrl = `https://${SIMULATION_CONFIG.shopDomain}/admin/api/2026-07/graphql.json`;
  const body = descriptionEditMutation(f.input);
  const options = { method: 'POST', redirect: 'error', headers: { 'X-Shopify-Access-Token': 'SIMULATED_ONLY_NOT_A_SHOPIFY_TOKEN' }, body: JSON.stringify(body) };
  const p = createSimulatedProvider(f.input);
  for (const [url, change] of [
    ['https://wavtzm-vy.myshopify.com/admin/api/2026-07/graphql.json', {}],
    ['https://packsmart-ops.onrender.com', {}], [expectedUrl + '?x=1', {}], [expectedUrl, { redirect: 'follow' }],
    [expectedUrl, { body: JSON.stringify({ ...body, variables: { product: { ...body.variables.product, title: 'No' } } }) }],
    [expectedUrl, { body: JSON.stringify({ ...body, variables: { product: { ...body.variables.product, id: 'gid://shopify/Product/2' } } }) }],
    [expectedUrl, { body: JSON.stringify({ query: DESCRIPTION_PILOT_BASELINE_QUERY, variables: { id: 'gid://shopify/Product/2' } }) }],
    [expectedUrl, { headers: { 'X-Shopify-Access-Token': 'UNTRUSTED_FAKE_TOKEN' } }]
  ]) await assert.rejects(() => p.fetchImpl(url, { ...options, ...change }), { code: 'SIMULATION_PROVIDER_REQUEST_DENIED' });
  assert.equal(p.counts.mutations, 0);
  await p.fetchImpl(expectedUrl, options);
  await assert.rejects(() => p.fetchImpl(expectedUrl, options), { code: 'SIMULATION_ATTEMPT_CONSUMED' });
  await assert.rejects(() => f.storage.fetchImpl('https://production.supabase.co/rest/v1/saas_workspace_state'), { code: 'SIMULATION_ISOLATION_REQUIRED' });
  await assert.rejects(() => f.request('https://packsmart-ops.onrender.com/api/health'), { code: 'SIMULATION_HTTP_REQUEST_DENIED' });
});

test('SIMULATED public runner returns explicit limitations and a stopped listener', async () => {
  const result = await runDescriptionSimulation();
  assert.equal(result.simulated, true); assert.equal(result.serverStopped, true);
  assert.equal(result.receiptReadStatus, 200); assert.equal(result.provider.mutations, 1);
  assert.match(result.acceptance, /SIMULATED ONLY/); await refusedPort(result.loopbackPort);
});
