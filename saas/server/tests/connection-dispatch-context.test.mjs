import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from '../lib/store.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

const WORKSPACE = 'dispatch-context-fixture';
const REVISION = 'context-revision-one';
const ROOT_SCOPE = ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id', 'tenant'];
const MAX_BYTES = 32768;
const input = (provider = 'shopify') => ({ revision: REVISION, provider, writeId: 'write-selected', connectionId: 'connection-selected',
  actorId: 'owner-actor', approverId: 'owner-approver', approvalId: 'approval-selected',
  writeIndex: 1, connectionIndex: 1, actorIndex: 1, approverIndex: 2, approvalIndex: 1 });

function stateFor(provider = 'shopify') {
  return { _revision: REVISION, workspace: { id: WORKSPACE, name: 'Context fixture' },
    users: [{ id: 'unrelated-user', privateData: 'must-not-load-unrelated-user' },
      { id: 'owner-actor', role: 'owner', active: true, sessionVersion: 1 },
      { id: 'owner-approver', role: 'owner', active: true, sessionVersion: 1 }],
    connectionSettings: { [provider]: { permissionMode: 'approval_gated',
      ...(provider === 'meta' ? { metaPageIds: ['101'], metaCatalogIds: ['202'] } : {}) },
    unrelated: { history: 'must-not-load-other-provider-settings' } },
    connections: [{ id: 'unrelated-connection', privateData: 'must-not-load-other-connection' },
      { id: 'connection-selected', provider, encryptedCredentials: 'synthetic-encrypted-marker', metadata: {
        grantedScopes: provider === 'shopify' ? ['read_products', 'write_products'] : ['pages_manage_posts'],
        ...(provider === 'shopify' ? { shopDomain: 'context.myshopify.com' } : { accountId: '101' }) } }],
    approvals: [{ id: 'unrelated-approval', privateData: 'must-not-load-other-approval' },
      { id: 'approval-selected', status: 'approved', decidedBy: 'owner-approver',
        payload: { connectionWriteId: 'write-selected', digest: 'synthetic-digest' } }],
    connectionWrites: [{ id: 'unrelated-write', privateData: 'must-not-load-write-history' },
      { id: 'write-selected', provider, connectionId: 'connection-selected', approvalId: 'approval-selected', requiresApproval: true,
        input: { operation: provider === 'shopify' ? 'product_content' : 'facebook_publish' }, digest: 'synthetic-digest' }],
    products: [{ id: 'unrelated-product', description: 'unrelated-product-data'.repeat(80000) }],
    audit: [{ privateData: 'must-not-load-audit-history' }], providerUsage: [{ privateData: 'must-not-load-usage-history' }] };
}

function fixture({ state = stateFor(), mutate = null, response = null } = {}) {
  const database = fakeSupabase({ initialStates: [state] });
  const store = createStore({ SUPABASE_URL: 'https://context-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key' }, {
    fetchImpl: async (...args) => {
      const original = await database.fetchImpl(...args);
      if (response) return response();
      if (mutate) return Response.json(mutate(await original.json()));
      return original;
    }
  });
  return { store, database };
}

async function unavailable(action) {
  await assert.rejects(action, error => {
    assert.equal(error.code, 'WRITE_CONTEXT_UNAVAILABLE');
    assert.equal(error.status, 503);
    assert.equal(error.cause, undefined);
    assert.equal(error.message.includes('private'), false);
    assert.equal(JSON.stringify(error).includes('synthetic-service-key'), false);
    return true;
  });
}

for (const provider of ['shopify', 'meta']) test(`${provider}: one bounded indexed read returns only the exact dispatch context`, async () => {
  const state = stateFor(provider), expected = input(provider), { store, database } = fixture({ state });
  assert.ok(Buffer.byteLength(JSON.stringify(state)) > 1600000);
  const context = await store.getConnectionWriteContext(WORKSPACE, expected);
  assert.deepEqual(context, { _revision: REVISION, workspace: state.workspace,
    users: [state.users[1], state.users[2]], connectionSettings: { [provider]: state.connectionSettings[provider] },
    connections: [state.connections[1]], approvals: [state.approvals[1]], connectionWrites: [state.connectionWrites[1]] });
  assert.ok(Buffer.byteLength(JSON.stringify(context)) < 2048);
  assert.equal(JSON.stringify(context).includes('must-not-load'), false);
  assert.equal(database.calls.length, 1);
  assert.equal(store.activitySnapshot(WORKSPACE).db.attempted, 1);
  assert.equal(store.activitySnapshot(WORKSPACE).db.operations.state_read, 1);
  assert.equal(store.activityMeter.instanceSnapshot().unattributed.db.attempted, 0);
  const { url, method, body } = database.calls[0];
  assert.equal(method, 'GET');
  assert.equal(body, '');
  assert.equal(url.pathname, '/rest/v1/saas_workspace_state');
  assert.equal(url.searchParams.get('workspace_id'), `eq.${WORKSPACE}`);
  assert.equal(url.searchParams.get('state->>_revision'), `eq.${REVISION}`);
  assert.equal(url.searchParams.get('limit'), '2');
  assert.equal(url.searchParams.get('select'), ['workspace_id', 'revision:state->>_revision', 'workspace:state->workspace',
    ...ROOT_SCOPE.map(key => `scope_${key}:state->${key}`), `settings:state->connectionSettings->${provider}`,
    'actor:state->users->1', 'approver:state->users->2', 'connection:state->connections->1',
    'approval:state->approvals->1', 'write:state->connectionWrites->1'].join(','));
  assert.deepEqual([...url.searchParams.keys()].sort(), ['limit', 'select', 'state->>_revision', 'workspace_id']);
});

test('interleaved dispatch reads attribute foreign and malformed replies to the requesting workspace', async () => {
  const other = 'dispatch-context-other', secondState = stateFor(); secondState.workspace.id = other;
  const database = fakeSupabase({ initialStates: [stateFor(), secondState] }), pending = [];
  const store = createStore({ SUPABASE_URL: 'https://context-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key' }, {
    fetchImpl: (url, options) => {
      const response = database.fetchImpl(url, options);
      return new Promise(resolve => pending.push({ response, resolve }));
    }
  });
  const first = unavailable(() => store.getConnectionWriteContext(WORKSPACE, input()));
  const second = unavailable(() => store.getConnectionWriteContext(other, input()));
  assert.equal(pending.length, 2);
  assert.equal(store.activitySnapshot(WORKSPACE).db.inflight, 1); assert.equal(store.activitySnapshot(other).db.inflight, 1);
  const malformed = 'private truncated dispatch response é🌍';
  pending[1].resolve(new Response(malformed)); await second;
  const foreignRows = await (await pending[0].response).json(); foreignRows[0].workspace_id = other;
  const foreignText = JSON.stringify(foreignRows);
  pending[0].resolve(new Response(foreignText)); await first;
  assert.equal(database.calls.length, 2);
  const own = store.activitySnapshot(WORKSPACE), another = store.activitySnapshot(other);
  for (const observed of [own, another]) {
    assert.equal(observed.db.attempted, 1); assert.equal(observed.db.completed, 1); assert.equal(observed.db.inflight, 0);
    assert.equal(observed.db.operations.state_read, 1); assert.equal(observed.db.requestBody.bytes, 0);
    assert.equal(Object.values(observed.db.retries).reduce((a, b) => a + b, 0), 0);
    assert.doesNotMatch(JSON.stringify(observed), /private|synthetic-encrypted-marker|context.myshopify.com/);
  }
  assert.equal(own.db.succeeded, 1, 'decoded transport success does not establish valid dispatch authority');
  assert.equal(own.db.responseBody.bytes, Buffer.byteLength(foreignText));
  assert.equal(another.db.outcomes.invalid_response, 1); assert.equal(another.db.responseBody.bytes, Buffer.byteLength(malformed));
  assert.equal(store.activityMeter.instanceSnapshot().unattributed.db.attempted, 0);
});

test('dispatch observations count exact UTF-8 projection bytes and remain optional at meter capacity', async () => {
  const other = 'dispatch-context-other', firstState = stateFor(), secondState = stateFor();
  firstState.workspace.name = 'Révision vérifiée 🌍'; secondState.workspace.id = other;
  const database = fakeSupabase({ initialStates: [firstState, secondState] }), texts = [];
  const store = createStore({ SUPABASE_URL: 'https://context-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key' }, {
    activityOptions: { maxTenants: 1 }, fetchImpl: async (url, options) => {
      const response = await database.fetchImpl(url, options), text = await response.text(); texts.push(text);
      return new Response(text, { status: response.status });
    }
  });
  assert.equal((await store.getConnectionWriteContext(WORKSPACE, input())).workspace.name, firstState.workspace.name);
  assert.equal((await store.getConnectionWriteContext(other, input())).workspace.id, other);
  assert.equal(database.calls.length, 2);
  assert.equal(store.activitySnapshot(WORKSPACE).db.responseBody.bytes, Buffer.byteLength(texts[0]));
  assert.ok(Buffer.byteLength(texts[0]) > texts[0].length);
  assert.equal(store.activitySnapshot(other).db.attempted, null);
  assert.equal(store.activityMeter.instanceSnapshot().unattributed.db.attempted, 0);
});

test('the same actor and approver is deduplicated, with identical projected records required', async () => {
  const state = stateFor(), expected = { ...input(), approverId: 'owner-actor', approverIndex: 1 };
  state.approvals[1].decidedBy = 'owner-actor';
  const { store } = fixture({ state });
  assert.deepEqual((await store.getConnectionWriteContext(WORKSPACE, expected)).users, [state.users[1]]);
  const malformed = fixture({ state, mutate: rows => { rows[0].approver.role = 'member'; return rows; } });
  await unavailable(() => malformed.store.getConnectionWriteContext(WORKSPACE, expected));
});

test('automatic internal notes omit the approval projection and retain the consent owner', async () => {
  const state = stateFor(), expected = { ...input(), approvalId: null, approvalIndex: null };
  delete state.connectionWrites[1].approvalId;
  state.connectionWrites[1].requiresApproval = false;
  state.connectionWrites[1].input = { operation: 'internal_note', note: 'Synthetic note' };
  state.connectionSettings.shopify = { permissionMode: 'automatic', consent: { mode: 'automatic', actor: 'owner-approver' } };
  const { store, database } = fixture({ state });
  const context = await store.getConnectionWriteContext(WORKSPACE, expected);
  assert.deepEqual(context.approvals, []);
  assert.equal(database.calls[0].url.searchParams.get('select').includes('approval:'), false);
  for (const mutate of [row => { row.write.input.operation = 'product_content'; }, row => { row.write.requiresApproval = true; },
    row => { row.settings.consent.actor = 'foreign-owner'; }, row => { row.settings.permissionMode = 'approval_gated'; },
    row => { row.write.approvalId = 'unprojected-approval'; }]) {
    const bad = fixture({ state, mutate: rows => { mutate(rows[0]); return rows; } });
    await unavailable(() => bad.store.getConnectionWriteContext(WORKSPACE, expected));
  }
});

test('trusted inputs reject malformed IDs, unbounded indexes, alternate projections, and accessors before network', async () => {
  const { store, database } = fixture();
  const invalid = [null, [], {}, { ...input(), workspaceId: 'foreign' }, { ...input(), provider: 'shopify,state' },
    { ...input(), provider: 'ebay' }, { ...input(), approvalId: null }, { ...input(), approvalIndex: null },
    { ...input(), approverId: 'owner-actor' }, { ...input(), approverIndex: 1 }];
  for (const field of ['revision', 'writeId', 'connectionId', 'actorId', 'approverId', 'approvalId']) {
    for (const value of ['', ' padded', 'bad\nidentity', 'a'.repeat(257), 1, null]) invalid.push({ ...input(), [field]: value });
  }
  for (const field of ['writeIndex', 'connectionIndex', 'actorIndex', 'approverIndex', 'approvalIndex']) {
    for (const value of [-1, 4096, 0.5, '1', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) invalid.push({ ...input(), [field]: value });
  }
  for (const value of invalid) await unavailable(() => store.getConnectionWriteContext(WORKSPACE, value));
  for (const workspace of ['', ' padded', 'a'.repeat(257), 'bad\u0000id', null, 1]) await unavailable(() => store.getConnectionWriteContext(workspace, input()));
  let invoked = false;
  const accessor = input();
  Object.defineProperty(accessor, 'actorIndex', { get() { invoked = true; return 1; } });
  await unavailable(() => store.getConnectionWriteContext(WORKSPACE, accessor));
  assert.equal(invoked, false);
  assert.equal(database.calls.length, 0);
});

test('maximum safe index is supported while missing or reordered entries fail closed', async () => {
  const state = stateFor(), expected = { ...input(), writeIndex: 4095 };
  state.connectionWrites[4095] = state.connectionWrites[1];
  const valid = fixture({ state });
  assert.equal((await valid.store.getConnectionWriteContext(WORKSPACE, expected)).connectionWrites[0].id, 'write-selected');
  for (const field of ['writeIndex', 'connectionIndex', 'actorIndex', 'approverIndex', 'approvalIndex']) {
    const { store, database } = fixture();
    await unavailable(() => store.getConnectionWriteContext(WORKSPACE, { ...input(), [field]: 4095 }));
    assert.equal(database.calls.length, 1);
  }
  const moved = stateFor();
  moved.connectionWrites.reverse();
  await unavailable(() => fixture({ state: moved }).store.getConnectionWriteContext(WORKSPACE, input()));
});

test('a changed revision, even with unchanged selected records, fails without a full-state fallback', async () => {
  const state = stateFor();
  state._revision = 'newer-revision';
  state.users.push({ id: 'added-owner', role: 'owner' });
  const { store, database } = fixture({ state });
  await unavailable(() => store.getConnectionWriteContext(WORKSPACE, input()));
  assert.equal(database.calls.length, 1);
});

test('a caller cannot change the trusted expected identity while a context request is in flight', async () => {
  const expected = input();
  const { store } = fixture({ mutate: rows => {
    expected.revision = 'later-revision';
    rows[0].revision = expected.revision;
    return rows;
  } });
  await unavailable(() => store.getConnectionWriteContext(WORKSPACE, expected));
});

test('empty, duplicate, malformed and incomplete projection responses never establish authority', async () => {
  const variants = [() => null, () => [], () => ({}), () => [null], () => [[]], rows => [rows[0], rows[0]],
    rows => ({ ...rows[0] }), rows => [{ ...rows[0], state: stateFor() }]];
  for (const field of ['workspace_id', 'revision', 'workspace', 'settings', 'actor', 'approver', 'connection', 'approval', 'write',
    ...ROOT_SCOPE.map(key => `scope_${key}`)]) variants.push(rows => { delete rows[0][field]; return rows; });
  for (const field of ['workspace', 'settings', 'actor', 'approver', 'connection', 'approval', 'write']) {
    for (const value of [null, [], 'malformed', 1]) variants.push(rows => { rows[0][field] = value; return rows; });
  }
  for (const mutate of variants) {
    const { store, database } = fixture({ mutate });
    await unavailable(() => store.getConnectionWriteContext(WORKSPACE, input()));
    assert.equal(database.calls.length, 1);
  }
});

test('entity identity, provider and nested binding mismatches fail closed', async () => {
  const changes = [['workspace_id', 'foreign-workspace'], ['revision', 'stale-revision'], ['revision', null],
    ['workspace.id', 'foreign-workspace'], ['actor.id', 'foreign-owner'], ['approver.id', 'foreign-owner'],
    ['connection.id', 'foreign-connection'], ['connection.provider', 'meta'], ['write.id', 'foreign-write'],
    ['write.provider', 'meta'], ['write.connectionId', 'foreign-connection'], ['write.approvalId', 'foreign-approval'],
    ['approval.id', 'foreign-approval'], ['approval.decidedBy', 'foreign-owner'], ['approval.payload.connectionWriteId', 'foreign-write'],
    ['settings.provider', 'meta'], ['approval.provider', 'meta'], ['connection.metadata', []], ['connection.metadata.grantedScopes', {}],
    ['connection.metadata.grantedScopes', ['write_products', null]], ['write.input', []], ['approval.payload', null],
    ['settings.consent', []], ['settings.metaPageIds', {}], ['settings.metaCatalogIds', [null]],
    ['write.dispatchClaim', []], ['write.providerState', 'malformed']];
  for (const [path, value] of changes) {
    const { store } = fixture({ mutate: rows => {
      const keys = path.split('.'), field = keys.pop(), object = keys.reduce((current, key) => current[key], rows[0]);
      object[field] = value;
      return rows;
    } });
    await unavailable(() => store.getConnectionWriteContext(WORKSPACE, input()));
  }
});

test('root tenant aliases accept absence or matching scope and reject foreign or malformed scope', async () => {
  const state = stateFor();
  for (const key of ROOT_SCOPE) state[key] = key === 'tenant' ? { id: WORKSPACE } : WORKSPACE;
  await fixture({ state }).store.getConnectionWriteContext(WORKSPACE, input());
  for (const key of ROOT_SCOPE) for (const value of ['foreign-workspace', '', false, [], { id: 'foreign-workspace' }]) {
    const bad = stateFor();
    bad[key] = value;
    await unavailable(() => fixture({ state: bad }).store.getConnectionWriteContext(WORKSPACE, input()));
  }
});

test('explicit null, foreign and malformed tenant markers are rejected throughout selected records', async () => {
  const paths = ['workspace', 'settings', 'settings.consent', 'actor', 'approver', 'connection', 'connection.metadata',
    'approval', 'approval.payload', 'write', 'write.input', 'write.dispatchClaim', 'write.dispatchClaim.phases', 'scope_tenant'];
  for (const path of paths) for (const marker of ['workspaceId', 'workspace_id', 'tenantId', 'tenant_id', 'workspace', 'tenant']) {
    const { store } = fixture({ mutate: rows => {
      const target = path.split('.').reduce((current, key) => current[key] ||= {}, rows[0]);
      if (path === 'scope_tenant') target.id = WORKSPACE;
      target[marker] = path.length % 2 ? null : { id: 'foreign-workspace' };
      return rows;
    } });
    await unavailable(() => store.getConnectionWriteContext(WORKSPACE, input()));
  }
  const valid = fixture({ mutate: rows => {
    for (const field of ['workspace', 'actor', 'approver', 'connection', 'write', 'approval', 'settings']) {
      Object.assign(rows[0][field], { workspaceId: WORKSPACE, workspace_id: WORKSPACE, tenantId: WORKSPACE,
        tenant_id: WORKSPACE, tenant: { id: WORKSPACE }, workspace: { id: WORKSPACE } });
    }
    return rows;
  } });
  await valid.store.getConnectionWriteContext(WORKSPACE, input());
});

test('oversized chunked responses are cancelled at the streamed 32 KiB bound', async () => {
  let pulled = 0, cancelled = false;
  const { store, database } = fixture({ response: () => new Response(new ReadableStream({
    pull(controller) { pulled++; controller.enqueue(new Uint8Array(8192).fill(120)); if (pulled === 100) controller.close(); },
    cancel() { cancelled = true; }
  }, { highWaterMark: 0 })) });
  await unavailable(() => store.getConnectionWriteContext(WORKSPACE, input()));
  assert.equal(pulled, 5);
  assert.equal(cancelled, true);
  assert.equal(database.calls.length, 1);
  const observed = store.activitySnapshot(WORKSPACE);
  assert.equal(observed.db.attempted, 1); assert.equal(observed.db.outcomes.oversized_response, 1);
  assert.equal(observed.db.responseBody.bytes, null); assert.equal(observed.db.responseBody.unknownObservations, 1);
});

test('oversized declared responses are rejected before body consumption', async () => {
  let pulled = 0, cancelled = false;
  const { store } = fixture({ response: () => new Response(new ReadableStream({
    pull(controller) { pulled++; controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; }
  }, { highWaterMark: 0 }), { headers: { 'content-length': String(MAX_BYTES + 1) } }) });
  await unavailable(() => store.getConnectionWriteContext(WORKSPACE, input()));
  assert.equal(pulled, 0);
  assert.equal(cancelled, true);
});

test('the byte bound counts UTF-8 bytes and rejects even otherwise valid oversized JSON', async () => {
  const { store } = fixture({ mutate: rows => { rows[0].workspace.padding = '界'.repeat(12000); return rows; } });
  await unavailable(() => store.getConnectionWriteContext(WORKSPACE, input()));
});

test('transport failures, invalid JSON, and unavailable persistence return only the safe blocker', async () => {
  for (const [outcome, response] of [['http_error', () => new Response('private upstream detail', { status: 503 })],
    ['invalid_response', () => new Response('private non-json response')], ['network_error', () => { throw new Error('private upstream failure'); }]]) {
    const { store, database } = fixture({ response });
    await unavailable(() => store.getConnectionWriteContext(WORKSPACE, input()));
    assert.equal(database.calls.length, 1);
    const observed = store.activitySnapshot(WORKSPACE);
    assert.equal(observed.db.attempted, 1); assert.equal(observed.db.outcomes[outcome], 1);
    assert.equal(observed.db.responseBody.unknownObservations, outcome === 'network_error' ? 1 : 0);
  }
  const file = createStore({ SAAS_STATE_FILE: '/not-read-by-context-helper.json' });
  file.readAll = async () => { throw new Error('FileStore must not read or confer durable authority'); };
  await unavailable(() => file.getConnectionWriteContext(WORKSPACE, input()));
});
