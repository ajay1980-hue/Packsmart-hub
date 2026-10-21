// Synthetic child executor. No HTTP transport is available: all store traffic
// is routed to the proven local database and provider responses are in-memory.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createStore } from '../lib/store.mjs';
import { executeConnectionWrite } from '../lib/connection-writes.mjs';
import { createGovernedRecordStage } from '../lib/governed-record-stage.mjs';
import { createContentPilot, DESCRIPTION_PILOT_SCHEMA, DESCRIPTION_PILOT_BASELINE_QUERY } from '../lib/content-pilot.mjs';
import { DESCRIPTION_EXECUTION_RECEIPT_CONTRACT } from '../lib/content-execution-receipt.mjs';
import { descriptionEditPreimage } from '../lib/description-edit.mjs';
import { IntegrationService } from '../lib/integrations.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
import { originalContentPreimages } from './content-jsonb-test-fixture.mjs';

assert.equal(process.env.OUTCOME_ALLOW_DISPOSABLE_TEST_DB, '1');
assert.ok(process.send, 'IPC-only synthetic child');
const { Client } = createRequire(new URL('./atomic-usage/package.json', import.meta.url))('pg');
const releases = new Map();
process.on('message', message => { if (message.kind === 'continue') releases.get(message.point)?.(); });
const configuration = await new Promise(resolve => process.once('message', resolve));
const { connectionString, workspaceId, pauseAt = [] } = configuration;
const url = new URL(connectionString);
assert.ok(['postgres:','postgresql:'].includes(url.protocol));
assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.username, 'postgres');
assert.match(url.pathname, /^\/runvara_receipt_consumer_test_[a-f0-9]{32}$/);
assert.equal(url.search, ''); assert.equal(url.hash, '');
const client = new Client({ connectionString, ssl: false, options: '', connectionTimeoutMillis: 5000, statement_timeout: 20000 });
const point = async name => {
  const pending = pauseAt.includes(name) ? new Promise(resolve => releases.set(name, resolve)) : null;
  process.send({ kind: 'point', point: name, pid: process.pid });
  if (pending) { await pending; releases.delete(name); }
};
try {
  await client.connect();
  const info = (await client.query("SELECT current_database() db,current_setting('server_version_num')::int version,current_setting('listen_addresses') listen,current_setting('data_directory') data")).rows[0];
  assert.equal(info.db, url.pathname.slice(1)); assert.equal(info.listen, '127.0.0.1');
  assert.ok(info.version >= 170000 && info.version < 180000); assert.equal(info.data, configuration.dataDirectory);
  await client.query('SET SESSION AUTHORIZATION service_role'); await client.query("SET TIME ZONE 'UTC'");
  const fake = fakeSupabase();
  const current = async () => (await client.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1', [workspaceId])).rows[0].state;
  const sync = async () => { const state = await current(); fake.states.set(workspaceId, state); return state; };
  const fetchImpl = async (input, options = {}) => {
    const target = new URL(input), name = target.pathname.split('/').pop(), method = options.method || 'GET';
    assert.equal(target.origin, 'https://description-process.invalid');
    const body = options.body ? JSON.parse(options.body) : null;
    try {
      if (name === 'runvara_reserve_content_receipt' || name === 'runvara_finalize_content_receipt') {
        const kind = name.includes('_reserve_') ? 'reserve' : 'finalize';
        await point(kind + '-before-commit');
        const holdTransaction = pauseAt.includes(kind + '-uncommitted');
        if (holdTransaction) await client.query('BEGIN');
        const ack = (await client.query(`SELECT public.runvara_${kind}_content_receipt($1::text) ack`, [body.p_request_json])).rows[0].ack;
        if (holdTransaction) { await point(kind + '-uncommitted'); await client.query('COMMIT'); }
        await point(kind + '-committed'); await sync(); return Response.json(ack);
      }
      if (name === 'runvara_read_content_receipt') return Response.json((await client.query('SELECT public.runvara_read_content_receipt($1,$2,$3,$4,$5,$6::bigint) ack',
        [body.p_workspace_id, body.p_attempt_id, body.p_kind, body.p_request_fingerprint, body.p_actor_id, body.p_actor_session_version])).rows[0].ack);
      if (name === 'runvara_commit_reporting_status') {
        const result = await client.query('SELECT * FROM public.runvara_commit_reporting_status($1,$2,$3,$4::jsonb,$5::timestamptz)',
          [body.p_workspace_id, body.p_expected_revision, body.p_next_revision, body.p_report, body.p_updated_at]);
        await sync(); return Response.json(result.rows);
      }
      if (name === 'saas_workspace_state') {
        assert.equal(target.searchParams.get('workspace_id'), 'eq.' + workspaceId);
        if (method === 'PATCH') {
          const fence = target.searchParams.get('state->>_revision'); assert.ok(fence.startsWith('eq.'));
          const result = await client.query("UPDATE public.saas_workspace_state SET state=$2,updated_at=$3 WHERE workspace_id=$1 AND state->>'_revision'=$4 RETURNING workspace_id",
            [workspaceId, body.state, body.updated_at, fence.slice(3)]);
          if (result.rowCount) await point('initial-committed');
          await sync(); return Response.json(result.rows);
        }
        assert.equal(method, 'GET'); await sync();
      }
      return fake.fetchImpl(input, options);
    } catch (error) { if (error.code) return Response.json({ code: error.code, message: error.message }, { status: 409 }); throw error; }
  };
  const store = createStore({ SUPABASE_URL: 'https://description-process.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only', CONTENT_EXECUTION_RECEIPT_CONTRACT: DESCRIPTION_EXECUTION_RECEIPT_CONTRACT }, { fetchImpl });
  const state = await store.get(workspaceId), write = state.connectionWrites[0], input = descriptionEditPreimage(write.input);
  const pilot = createContentPilot({ schema: DESCRIPTION_PILOT_SCHEMA, workspaceId, connectionId: write.connectionId, account: write.account,
    productId: input.productId, operation: input.operation, requestId: write.requestId, requestedBy: write.requestedBy,
    inputDigest: createHash('sha256').update(JSON.stringify(input)).digest('hex'), settingsRevision: state.connectionSettings.shopify.revision,
    expiresAt: new Date(Date.now() + 600000).toISOString(), input });
  const expected = originalContentPreimages(state, write);
  const provider = new IntegrationService({}, { fetchImpl: async (target, options) => {
    assert.equal(target, expected.request.url); assert.equal(options.body, expected.request.body);
    await point('provider-confirmed');
    return Response.json({ data: { productUpdate: { product: { id: input.productId }, userErrors: [] } } });
  } });
  provider.shopifyConfig = () => ({ domain: write.account, workspaceId, mode: 'oauth', apiVersion: '2026-07', accessToken: 'synthetic-only' });
  provider.connectorCredentials = async () => ({ accessToken: 'synthetic-only' });
  const graphql = provider.shopifyGraphql.bind(provider);
  provider.shopifyGraphql = (query, variables, config, options) => query === DESCRIPTION_PILOT_BASELINE_QUERY
    ? Promise.resolve({ product: { id: input.productId, descriptionHtml: input.baselineHtml, updatedAt: input.baselineUpdatedAt } })
    : graphql(query, variables, config, options);
  await point('ready');
  try {
    const result = await executeConnectionWrite(state, write.id, configuration.session.userId, provider, options => store.save(workspaceId, state, options), {
      governedRecordStage: createGovernedRecordStage({}), contentPilot: pilot, durableStore: true, actorSession: configuration.session,
      protectedContentReceipts: store.contentExecutionReceiptCapability, loadFreshState: request => store.getConnectionWriteContext(workspaceId, request) });
    process.send({ kind: 'result', status: result.status, pid: process.pid });
  } catch (error) { process.send({ kind: 'result', errorCode: error.code || 'UNEXPECTED_EXECUTOR_ERROR', message: error.message, pid: process.pid }); }
} catch (error) {
  process.send({ kind: 'fatal', errorCode: error.code || 'WORKER_FAILURE', message: error.message, pid: process.pid }); process.exitCode = 1;
} finally { await client.end(); process.disconnect(); }
