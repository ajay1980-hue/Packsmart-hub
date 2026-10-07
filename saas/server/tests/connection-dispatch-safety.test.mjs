import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { IntegrationService } from '../lib/integrations.mjs';
import { executeConnectionWrite, proposeConnectionWrite } from '../lib/connection-writes.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

const WORKSPACE = 'dispatch-safety-fixture';
const PRODUCT = 'gid://shopify/Product/71';
const SHOP = 'dispatch-safety.myshopify.com';
const PAGE = '101', INSTAGRAM = '202', CONTAINER = '303', CATALOG = '404', META_PRODUCT = '505';
const TOKEN = 'synthetic-dispatch-test-token';
const META_SCOPES = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'instagram_basic',
  'instagram_content_publish', 'catalog_management', 'business_management'];
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = value => Response.json(value);

function gate() {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  return { entered, release, async block() { enter(); await released; } };
}

async function reached(g, running) {
  await Promise.race([g.entered, running.then(value => {
    throw new Error(`Execution finished before the race boundary: ${value?.errorCode || value?.code || value?.status}`);
  })]);
}

// FileStore fixtures model same-process interleavings only. durableStore:true
// explicitly models the production capability in these synthetic unit tests;
// real FileStore-backed production dispatch is separately required to deny it.
// Supabase fixtures exercise its adapter against mocked conditional PATCHes,
// not a live Postgres instance. All provider and storage traffic is synthetic.
async function fixture(t, { provider = 'shopify', operation = 'product_content', baseline = false, storage = 'file' } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-dispatch-safety-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const database = storage === 'mock-supabase' ? fakeSupabase() : null;
  const env = database ? { SUPABASE_URL: 'https://dispatch-safety.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-storage-test-key' }
    : { SAAS_STATE_FILE: path.join(directory, 'state.json') };
  const storageOptions = database ? { fetchImpl: database.fetchImpl } : {};
  const store = createStore(env, storageOptions), replica = createStore(env, storageOptions);
  const seeded = seedWorkspaceState({}, { workspaceId: WORKSPACE, userId: 'synthetic-owner', email: 'owner@example.test', passwordHash: 'synthetic-hash' });
  seeded.products = [{ id: PRODUCT, provider: 'shopify', title: 'Original title' }];
  seeded.connections = [
    { id: 'shopify-fixture', provider: 'shopify', encryptedCredentials: 'synthetic-credential-marker',
      metadata: { shopDomain: SHOP, grantedScopes: ['read_products', 'write_products'] } },
    { id: 'meta-fixture', provider: 'meta', encryptedCredentials: 'synthetic-credential-marker',
      metadata: { accountId: '606', grantedScopes: META_SCOPES.slice(),
        assets: { pages: [{ id: PAGE, name: 'Fixture Page', instagram: { id: INSTAGRAM } }], catalogs: [{ id: CATALOG }] } } }
  ];
  seeded.connectionSettings = { shopify: { permissionMode: 'approval_gated' },
    meta: { permissionMode: 'approval_gated', metaPageIds: [PAGE], metaCatalogIds: [CATALOG] } };
  seeded.channelData = { meta: { products: [{ id: META_PRODUCT, catalogId: CATALOG }] } };
  if (operation === 'facebook_update') seeded.connectionWrites = [{ id: 'previous-facebook-write', provider: 'meta', status: 'completed',
    input: { operation: 'facebook_publish', pageId: PAGE }, result: { externalId: `${PAGE}_909` } }];
  const body = provider === 'shopify'
    ? operation.startsWith('product_tags_')
      ? { operation, productId: PRODUCT, tags: ['approved-tag'], ...(baseline ? { expectedTags: ['existing'] } : {}) }
      : operation === 'internal_note'
        ? { operation, productId: PRODUCT, note: 'Approved internal note' }
        : { operation, productId: PRODUCT, title: 'Approved title', description: 'Approved <description>\nSecond line' }
    : operation.startsWith('catalog_')
      ? { operation, catalogId: CATALOG, productId: META_PRODUCT, quantity: 9, availability: 'in stock', visibility: 'staging', name: 'Approved product', description: 'Approved description',
        retailerId: 'approved-sku', brand: 'Approved brand', category: 'Home & Garden', url: 'https://example.test/approved', imageUrl: 'https://example.test/approved.jpg', priceMinor: 1099, currency: 'GBP' }
      : { operation, pageId: PAGE, message: 'Approved post', imageUrl: 'https://example.test/approved.jpg', url: 'https://example.test/approved', postId: `${PAGE}_909` };
  const requested = proposeConnectionWrite(seeded, provider, { ...body, requestId: 'dispatch-safety-request-0001' }, seeded.users[0].id);
  const approved = seeded.approvals.find(item => item.id === requested.approvalId);
  Object.assign(approved, { status: 'approved', decidedBy: seeded.users[0].id, decidedAt: new Date().toISOString() });
  await store.save(WORKSPACE, seeded);
  const state = await store.get(WORKSPACE);
  const write = state.connectionWrites.find(item => item.id === requested.id);
  const calls = [], mutations = [], durableClaims = [];
  const hooks = { fetch: null, credentials: null, token: null };
  const service = new IntegrationService({ META_CLIENT_ID: 'synthetic-client', META_CLIENT_SECRET: 'synthetic-client-secret' }, {
    fetchImpl: async (url, options = {}) => {
      const target = new URL(url);
      assert.ok([SHOP, 'other.myshopify.com', 'graph.facebook.com'].includes(target.hostname), `Unexpected synthetic transport host: ${target.hostname}`);
      const body = options.body ? JSON.parse(options.body) : null;
      const isShopify = target.hostname.endsWith('.myshopify.com');
      const mutation = isShopify ? /^\s*mutation\b/.test(body?.query || '') : options.method !== 'GET';
      const call = { url: target, options, body, mutation };
      calls.push(call);
      if (mutation) mutations.push(call);
      if (hooks.fetch) {
        const response = await hooks.fetch(call);
        if (response !== undefined) return response;
      }
      if (isShopify) {
        if (!mutation) return json({ data: { product: { id: PRODUCT, title: 'Original title', tags: ['existing'] } } });
        if (body.query.includes('tagsAdd')) return json({ data: { tagsAdd: { node: { id: PRODUCT }, userErrors: [] } } });
        if (body.query.includes('tagsRemove')) return json({ data: { tagsRemove: { node: { id: PRODUCT }, userErrors: [] } } });
        if (body.query.includes('metafieldsSet')) return json({ data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/1' }], userErrors: [] } } });
        return json({ data: { productUpdate: { product: { id: PRODUCT, title: 'Approved title' }, userErrors: [] } } });
      }
      const resource = target.pathname.replace(/^\/v\d+\.\d+/, '');
      if (mutation) return json({ id: resource.endsWith('/media') ? CONTAINER : '707' });
      if (resource === '/me/permissions') return json({ data: META_SCOPES.map(permission => ({ permission, status: 'granted' })) });
      if (resource === '/me/accounts') return json({ data: [{ id: PAGE, name: 'Fixture Page', access_token: TOKEN, instagram_business_account: { id: INSTAGRAM } }] });
      if (resource === '/debug_token') return json({ data: { is_valid: false } });
      if (resource === '/me/businesses') return json({ data: [{ id: '808' }] });
      if (resource === '/808/owned_product_catalogs') return json({ data: [{ id: CATALOG }] });
      if (resource === '/808/client_product_catalogs') return json({ data: [] });
      if (resource === `/${META_PRODUCT}`) return json({ id: META_PRODUCT, product_catalog: { id: CATALOG } });
      if (resource === `/${INSTAGRAM}/content_publishing_limit`) return json({ data: [{ quota_usage: 0, config: { quota_total: 100 } }] });
      if (resource === `/${CONTAINER}`) return json({ status_code: 'FINISHED' });
      assert.fail(`Unexpected synthetic Meta request: ${resource}`);
    }
  });
  service.shopifyConfig = current => {
    const connection = current.connections.find(item => item.provider === 'shopify');
    return { mode: 'oauth', accessToken: TOKEN, workspaceId: WORKSPACE, domain: connection.metadata.shopDomain,
      apiVersion: '2026-07', cacheKey: 'synthetic-cache-key', connection };
  };
  service.connectorCredentials = async (current, selectedProvider) => {
    await hooks.credentials?.(current, selectedProvider);
    return { mode: 'oauth', accessToken: TOKEN, storeDomain: SHOP };
  };
  service.shopifyAccessToken = async config => {
    await hooks.token?.(config);
    return IntegrationService.prototype.shopifyAccessToken.call(service, config);
  };
  const persist = async () => {
    const saved = await store.save(WORKSPACE, state);
    durableClaims.push(structuredClone(saved));
    return saved;
  };
  const options = { durableStore: true,
    actorSession: Object.freeze({ workspaceId: WORKSPACE, userId: state.users[0].id, sessionVersion: 1 }),
    loadFreshState: context => database ? store.getConnectionWriteContext(WORKSPACE, context) : store.get(WORKSPACE) };
  const run = (save = persist, opts = options) => executeConnectionWrite(state, write.id, state.users[0].id, service, save, opts);
  const observe = (save = persist, opts = options) => run(save, opts).catch(error => error);
  const changeReplica = async change => {
    const current = await replica.get(WORKSPACE);
    change(current);
    return replica.save(WORKSPACE, current);
  };
  return { store, replica, database, state, write, service, calls, mutations, durableClaims, hooks, persist, options, run, observe, changeReplica };
}

function assertBlocked(outcome, mutations, count = 0) {
  assert.equal(mutations.length, count, 'No additional provider mutation may cross the transport boundary');
  assert.notEqual(outcome?.status, 'completed');
  assert.ok(outcome instanceof Error || ['failed', 'uncertain', 'blocked'].includes(outcome?.status),
    `Expected an explicit blocked outcome, received ${JSON.stringify(outcome)}`);
}

const alterations = {
  pause(state) { state.connectionSettings.shopify.permissionMode = 'read_only'; },
  disconnect(state) { state.connectionSettings.shopify.disconnected = true; },
  revokeApproval(state) { state.approvals[0].status = 'rejected'; },
  removeOwner(state) { state.users[0].active = false; },
  changeAccount(state) { state.connections.find(item => item.provider === 'shopify').metadata.shopDomain = 'other.myshopify.com'; },
  removeScope(state) { state.connections.find(item => item.provider === 'shopify').metadata.grantedScopes = ['read_products']; },
  changePayload(state) {
    const write = state.connectionWrites[0];
    write.input = { ...write.input, title: 'Unapproved replacement' };
  },
  replaceApprovedPayload(state) {
    const write = state.connectionWrites[0];
    write.input = { ...write.input, title: 'Unapproved replacement' };
    write.digest = fingerprint(write.input);
    state.approvals.find(item => item.id === write.approvalId).payload.digest = write.digest;
  }
};

test('manual Shopify execution with autopilot off sends the exact approved payload once', async t => {
  const f = await fixture(t);
  assert.equal(f.state.autopilot.enabled, false);
  f.hooks.fetch = async call => {
    if (call.mutation) {
      const durable = await f.replica.get(WORKSPACE);
      assert.equal(durable.connectionWrites[0].status, 'executing');
      assert.ok(f.durableClaims.length > 0);
    }
  };
  const result = await f.run();
  assert.equal(result.status, 'completed');
  assert.equal(f.mutations.length, 1);
  assert.equal(f.durableClaims.length, 3, 'Initial claim, mutation phase and final result each save once');
  const call = f.mutations[0];
  assert.equal(call.url.origin, `https://${SHOP}`);
  assert.equal(call.url.pathname, '/admin/api/2026-07/graphql.json');
  assert.deepEqual(call.body.variables, { product: { id: PRODUCT, title: 'Approved title', descriptionHtml: '<p>Approved &lt;description&gt;<br>Second line</p>' } });
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.headers['X-Shopify-Access-Token'], TOKEN);
  await f.persist();
  assert.equal((await f.run()).status, 'completed');
  assert.equal(f.mutations.length, 1, 'A completed write must not be replayed');
});

test('a missing authoritative reload capability fails closed', async t => {
  const f = await fixture(t, { operation: 'product_tags_add', baseline: true });
  let credentialCalls = 0;
  f.hooks.credentials = () => { credentialCalls++; };
  const result = await f.observe(f.persist, { durableStore: true, actorSession: f.options.actorSession });
  assertBlocked(result, f.mutations);
  assert.equal(f.calls.length, 0);
  assert.equal(credentialCalls, 0);
});

test('FileStore-backed production execution denies missing or unsupported durable-store capability', async t => {
  for (const durableStore of [undefined, false, 'true', 1]) await t.test(String(durableStore), async t => {
    const f = await fixture(t, { operation: 'product_tags_add', baseline: true });
    assert.equal(f.store.provider, 'file');
    let credentialCalls = 0;
    f.hooks.credentials = () => { credentialCalls++; };
    const options = { actorSession: f.options.actorSession, loadFreshState: () => f.store.get(WORKSPACE),
      ...(durableStore === undefined ? {} : { durableStore }) };
    const result = await f.observe(f.persist, options);
    assertBlocked(result, f.mutations);
    assert.equal(result.code, 'WRITE_DURABLE_STORE_REQUIRED');
    assert.equal(f.calls.length, 0);
    assert.equal(credentialCalls, 0);
    assert.equal(f.durableClaims.length, 0);
    assert.equal((await f.replica.get(WORKSPACE)).connectionWrites[0].status, 'pending_approval');
  });
});

test('unsupported and no-op persistence callbacks cannot authorize dispatch', async t => {
  for (const [name, save] of [
    ['missing', undefined], ['undefined acknowledgement', async () => undefined],
    ['boolean acknowledgement', async () => true], ['empty acknowledgement', async () => ({})],
    ['same unsaved state', null]
  ]) await t.test(name, async t => {
    const f = await fixture(t);
    const persist = name === 'same unsaved state' ? async () => f.state : save;
    const result = await executeConnectionWrite(f.state, f.write.id, f.state.users[0].id, f.service, persist, f.options).catch(error => error);
    assertBlocked(result, f.mutations);
    assert.equal((await f.replica.get(WORKSPACE)).connectionWrites[0].status, 'pending_approval');
  });
});

test('a save acknowledgement must match the exact persisted workspace and claim', async t => {
  const corruptions = {
    workspace(ack) { ack.workspace.id = 'different-workspace'; },
    revision(ack) { ack._revision = 'wrong-revision'; },
    missingRevision(ack) { delete ack._revision; },
    missingWrite(ack) { ack.connectionWrites = []; },
    status(ack) { ack.connectionWrites[0].status = 'pending_approval'; },
    digest(ack) { ack.connectionWrites[0].digest = '00'.repeat(32); },
    account(ack) { ack.connectionWrites[0].account = 'other.myshopify.com'; },
    payload(ack) { ack.connectionWrites[0].input.title = 'Unapproved replacement'; }
  };
  for (const [name, corrupt] of Object.entries(corruptions)) await t.test(name, async t => {
    const f = await fixture(t);
    const result = await f.observe(async () => {
      const ack = structuredClone(await f.persist());
      corrupt(ack);
      return ack;
    });
    assertBlocked(result, f.mutations);
  });
});

for (const [name, alter] of Object.entries(alterations)) {
  test(`same-process FileStore ${name} after the acknowledged claim prevents Shopify transport dispatch`, async t => {
    const f = await fixture(t), g = gate();
    t.after(g.release);
    let saves = 0;
    const running = f.observe(async () => {
      const ack = await f.persist();
      if (++saves === 1) await g.block();
      return ack;
    });
    await reached(g, running);
    await f.changeReplica(alter);
    g.release();
    assertBlocked(await running, f.mutations);
  });

  test(`same-object ${name} during Shopify token acquisition prevents mutation`, async t => {
    const f = await fixture(t), g = gate();
    t.after(g.release);
    f.hooks.token = () => g.block();
    const running = f.observe();
    await reached(g, running);
    alter(f.state);
    g.release();
    assertBlocked(await running, f.mutations);
  });
}

test('a same-process FileStore permission revocation during Shopify token acquisition is reloaded at dispatch', async t => {
  const f = await fixture(t), g = gate();
  t.after(g.release);
  f.hooks.token = () => g.block();
  const running = f.observe();
  await reached(g, running);
  await f.changeReplica(alterations.pause);
  g.release();
  assertBlocked(await running, f.mutations);
});

test('a permission change while credentials are awaited blocks Shopify mutation', async t => {
  const f = await fixture(t), g = gate();
  t.after(g.release);
  f.hooks.credentials = () => g.block();
  const running = f.observe();
  await reached(g, running);
  await f.changeReplica(alterations.pause);
  g.release();
  assertBlocked(await running, f.mutations);
});

test('a matching tag baseline cannot override revocation while its read is in flight', async t => {
  const f = await fixture(t, { operation: 'product_tags_add', baseline: true }), g = gate();
  t.after(g.release);
  f.hooks.fetch = async call => { if (!call.mutation) await g.block(); };
  const running = f.observe();
  await reached(g, running);
  await f.changeReplica(alterations.revokeApproval);
  g.release();
  assertBlocked(await running, f.mutations);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].mutation, false);
});

test('an authoritative reload failure after a successful claim prevents mutation', async t => {
  const f = await fixture(t);
  let saved = false;
  const result = await f.observe(async () => { const ack = await f.persist(); saved = true; return ack; }, {
    ...f.options,
    loadFreshState: async () => {
      if (saved) throw Object.assign(new Error('Synthetic store unavailable'), { code: 'STORE_UNAVAILABLE' });
      return f.store.get(WORKSPACE);
    }
  });
  assertBlocked(result, f.mutations);
  assert.ok(saved);
});

test('concurrent same-process FileStore attempts dispatch a Shopify write at most once', async t => {
  const f = await fixture(t);
  const second = await f.replica.get(WORKSPACE);
  const results = await Promise.all([
    f.observe(),
    executeConnectionWrite(second, f.write.id, second.users[0].id, f.service,
      () => f.replica.save(WORKSPACE, second), { ...f.options, loadFreshState: () => f.replica.get(WORKSPACE) }).catch(error => error)
  ]);
  assert.equal(f.mutations.length, 1);
  assert.equal(results.filter(result => result.status === 'completed').length, 1);
  assert.equal(results.filter(result => result instanceof Error || ['uncertain', 'failed', 'blocked'].includes(result.status)).length, 1);
});

test('an uncertain Shopify response is recorded and never replayed from stale or fresh state', async t => {
  const f = await fixture(t);
  f.hooks.fetch = async call => { if (call.mutation) throw new TypeError('Synthetic response lost after send'); };
  const result = await f.run();
  assert.equal(result.status, 'uncertain');
  assert.equal(f.mutations.length, 1);
  await f.persist();
  assertBlocked(await f.observe(), f.mutations, 1);
  const replicaState = await f.replica.get(WORKSPACE);
  const replay = await executeConnectionWrite(replicaState, f.write.id, replicaState.users[0].id, f.service,
    () => f.replica.save(WORKSPACE, replicaState), { ...f.options, loadFreshState: () => f.replica.get(WORKSPACE) }).catch(error => error);
  assertBlocked(replay, f.mutations, 1);
});

test('actual Shopify transport refuses unbranded mutation capabilities but permits reads', async t => {
  const f = await fixture(t);
  const config = { ...f.service.shopifyConfig(f.state), accessToken: TOKEN };
  const mutation = 'mutation Test($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id } } }';
  for (const options of [undefined, {}, { dispatch: async () => true }, { dispatch: { allowed: true } }]) {
    await assert.rejects(() => f.service.shopifyGraphql(mutation, { product: { id: PRODUCT, title: 'Unapproved' } }, config, options));
  }
  assert.equal(f.mutations.length, 0);
  const read = await f.service.shopifyGraphql('query Test($id: ID!) { product(id: $id) { id tags } }', { id: PRODUCT }, config);
  assert.equal(read.product.id, PRODUCT);
  assert.equal(f.calls.length, 1);
});

test('Shopify transport does not follow or retry redirect responses', async t => {
  const f = await fixture(t);
  f.hooks.fetch = async call => call.mutation
    ? new Response('', { status: 307, headers: { Location: 'https://other.myshopify.com/redirect-target' } })
    : undefined;
  const result = await f.run();
  assertBlocked(result, f.mutations, 1);
  assert.equal(f.mutations[0].options.redirect, 'error');
  assertBlocked(await f.observe(), f.mutations, 1);
});

test('Meta Facebook publication sends only the approved Page and content', async t => {
  const f = await fixture(t, { provider: 'meta', operation: 'facebook_publish' });
  const result = await f.run();
  assert.equal(result.status, 'completed');
  assert.equal(f.mutations.length, 1);
  const call = f.mutations[0];
  assert.equal(call.url.pathname, `/v26.0/${PAGE}/feed`);
  assert.deepEqual(call.body, { message: 'Approved post', link: 'https://example.test/approved' });
  assert.equal(call.options.redirect, 'error');
});

test('Meta reloads Page selection after asset discovery before a Facebook mutation', async t => {
  const f = await fixture(t, { provider: 'meta', operation: 'facebook_publish' }), g = gate();
  t.after(g.release);
  f.hooks.fetch = async call => { if (call.url.pathname.endsWith('/me/accounts')) await g.block(); };
  const running = f.observe();
  await reached(g, running);
  await f.changeReplica(state => { state.connectionSettings.meta.metaPageIds = []; });
  g.release();
  assertBlocked(await running, f.mutations);
});

test('Meta Instagram uses separate acknowledged claims for container creation and publication', async t => {
  const f = await fixture(t, { provider: 'meta', operation: 'instagram_publish' });
  const claimsAtDispatch = [];
  f.hooks.fetch = async call => { if (call.mutation) claimsAtDispatch.push(f.durableClaims.length); };
  const result = await f.run();
  assert.equal(result.status, 'completed');
  assert.equal(f.durableClaims.length, 5, 'Initial, container phase/result, publish phase and final result save once each');
  assert.deepEqual(f.mutations.map(call => call.url.pathname), [`/v26.0/${INSTAGRAM}/media`, `/v26.0/${INSTAGRAM}/media_publish`]);
  assert.deepEqual(f.mutations.map(call => call.body), [
    { image_url: 'https://example.test/approved.jpg', caption: 'Approved post' }, { creation_id: CONTAINER }
  ]);
  assert.ok(claimsAtDispatch[0] > 0);
  assert.ok(claimsAtDispatch[1] > claimsAtDispatch[0], 'Publish must have a new durable phase claim');
  assert.ok(f.mutations.every(call => call.options.redirect === 'error'));
});

test('revocation after an Instagram container exists blocks the separate publish mutation', async t => {
  const f = await fixture(t, { provider: 'meta', operation: 'instagram_publish' }), g = gate();
  t.after(g.release);
  f.hooks.fetch = async call => { if (call.url.pathname === `/v26.0/${CONTAINER}`) await g.block(); };
  const running = f.observe();
  await reached(g, running);
  assert.equal(f.mutations.length, 1);
  await f.changeReplica(state => { state.approvals[0].status = 'rejected'; });
  g.release();
  assertBlocked(await running, f.mutations, 1);
  assert.ok(!f.mutations.some(call => call.url.pathname.endsWith('/media_publish')));
});

test('a missing durable acknowledgement for the Instagram publish phase prevents publication', async t => {
  const f = await fixture(t, { provider: 'meta', operation: 'instagram_publish' });
  const result = await f.observe(async () => {
    if (f.write.providerState?.publishStartedAt) return undefined;
    return f.persist();
  });
  assertBlocked(result, f.mutations, 1);
  assert.ok(!f.mutations.some(call => call.url.pathname.endsWith('/media_publish')));
});

test('Shopify capability cannot authorize a substituted transport payload or account', async t => {
  for (const substitution of ['payload', 'account', 'query']) await t.test(substitution, async t => {
    const f = await fixture(t);
    const actualTransport = f.service.shopifyGraphql.bind(f.service);
    f.service.shopifyGraphql = (query, variables, config, options) => {
      if (substitution === 'payload') variables = { product: { ...variables.product, title: 'Unapproved transport title' } };
      if (substitution === 'account') config = { ...config, domain: 'other.myshopify.com' };
      if (substitution === 'query') query = query.replace('productUpdate(product: $product)', 'productUpdate(product: $product, synchronous: true)');
      return actualTransport(query, variables, config, options);
    };
    assertBlocked(await f.observe(), f.mutations);
  });
});

test('two concurrent actual Shopify transports cannot reuse one phase capability', async t => {
  const f = await fixture(t);
  const actualTransport = f.service.shopifyGraphql.bind(f.service);
  let siblingResults;
  f.service.shopifyGraphql = async (...args) => {
    siblingResults = await Promise.allSettled([actualTransport(...args), actualTransport(...args)]);
    const success = siblingResults.find(result => result.status === 'fulfilled');
    if (!success) throw siblingResults[0].reason;
    return success.value;
  };
  const result = await f.run();
  assert.equal(result.status, 'completed');
  assert.equal(f.mutations.length, 1);
  assert.equal(siblingResults.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(siblingResults.filter(result => result.status === 'rejected').length, 1);
});

test('Meta capability cannot authorize a substituted transport body or Page', async t => {
  for (const substitution of ['body', 'page']) await t.test(substitution, async t => {
    const f = await fixture(t, { provider: 'meta', operation: 'facebook_publish' });
    const actualTransport = f.service.metaRequest.bind(f.service);
    f.service.metaRequest = (resource, token, options = {}) => {
      if (options.method === 'POST') {
        if (substitution === 'body') options = { ...options, body: { ...options.body, message: 'Unapproved transport post' } };
        if (substitution === 'page') resource = '/999/feed';
      }
      return actualTransport(resource, token, options);
    };
    assertBlocked(await f.observe(), f.mutations);
  });
});

test('actual Meta transport refuses unbranded mutation capabilities but permits reads', async t => {
  const f = await fixture(t, { provider: 'meta', operation: 'facebook_publish' });
  for (const dispatch of [undefined, async () => true, { allowed: true }]) {
    await assert.rejects(() => f.service.metaRequest(`/${PAGE}/feed`, TOKEN,
      { method: 'POST', body: { message: 'Unapproved post' }, dispatch }));
  }
  assert.equal(f.mutations.length, 0);
  const read = await f.service.metaRequest('/me/accounts', TOKEN);
  assert.equal(read.data[0].id, PAGE);
  assert.equal(f.calls.length, 1);
});

test('Meta catalogue ownership reads cannot outlive an account revocation', async t => {
  const f = await fixture(t, { provider: 'meta', operation: 'catalog_inventory' }), g = gate();
  t.after(g.release);
  f.hooks.fetch = async call => { if (call.url.pathname === `/v26.0/${META_PRODUCT}`) await g.block(); };
  const running = f.observe();
  await reached(g, running);
  await f.changeReplica(state => { state.connections.find(item => item.provider === 'meta').metadata.accountId = '999'; });
  g.release();
  assertBlocked(await running, f.mutations);
});

test('an uncertain Instagram container or publish response never repeats a mutation', async t => {
  for (const lostPhase of ['media', 'media_publish']) await t.test(lostPhase, async t => {
    const f = await fixture(t, { provider: 'meta', operation: 'instagram_publish' });
    f.hooks.fetch = async call => {
      if (call.mutation && call.url.pathname.endsWith(`/${lostPhase}`)) throw new TypeError('Synthetic Meta response lost after send');
    };
    const result = await f.run();
    const expected = lostPhase === 'media' ? 1 : 2;
    assert.equal(result.status, 'uncertain');
    assert.equal(f.mutations.length, expected);
    await f.persist();
    assertBlocked(await f.observe(), f.mutations, expected);
    const replicaState = await f.replica.get(WORKSPACE);
    const replay = await executeConnectionWrite(replicaState, f.write.id, replicaState.users[0].id, f.service,
      () => f.replica.save(WORKSPACE, replicaState), { ...f.options, loadFreshState: () => f.replica.get(WORKSPACE) }).catch(error => error);
    assertBlocked(replay, f.mutations, expected);
  });
});

test('a processing Instagram request resumes the saved container without recreating it', async t => {
  const f = await fixture(t, { provider: 'meta', operation: 'instagram_publish' });
  let processing = true;
  f.hooks.fetch = async call => call.url.pathname === `/v26.0/${CONTAINER}` && processing
    ? json({ status_code: 'IN_PROGRESS' }) : undefined;
  assert.equal((await f.run()).status, 'processing');
  assert.equal(f.mutations.length, 1);
  f.write.providerState.checkAfter = Date.now() - 1;
  await f.persist();
  processing = false;
  const resumed = await f.replica.get(WORKSPACE);
  const result = await executeConnectionWrite(resumed, f.write.id, resumed.users[0].id, f.service,
    () => f.replica.save(WORKSPACE, resumed), { ...f.options, loadFreshState: () => f.replica.get(WORKSPACE) });
  assert.equal(result.status, 'completed');
  assert.deepEqual(f.mutations.map(call => call.url.pathname), [`/v26.0/${INSTAGRAM}/media`, `/v26.0/${INSTAGRAM}/media_publish`]);
});

test('Shopify rechecks pause and revocation committed while its final phase acknowledgement is pending', async t => {
  for (const alteration of ['pause', 'revokeApproval']) await t.test(alteration, async t => {
    const f = await fixture(t), g = gate();
    t.after(g.release);
    let saves = 0;
    const running = f.observe(async () => {
      const ack = await f.persist();
      if (++saves === 2) await g.block();
      return ack;
    });
    await reached(g, running);
    assert.equal(f.mutations.length, 0);
    await f.changeReplica(alterations[alteration]);
    g.release();
    assertBlocked(await running, f.mutations);
  });
});

test('a malformed last phase acknowledgement blocks Shopify despite a valid initial claim', async t => {
  const f = await fixture(t);
  let saves = 0;
  const result = await f.observe(async () => {
    const ack = await f.persist();
    if (++saves === 2) return { ...ack, _revision: 'unacknowledged-revision' };
    return ack;
  });
  assertBlocked(result, f.mutations);
  assert.equal(saves, 3, 'The denied phase is followed by a validated terminal-result save');
  const saved = await f.replica.get(WORKSPACE);
  assert.equal(saved.connectionWrites[0].status, 'failed');
  assert.equal(saved.connectionWrites[0].errorCode, 'WRITE_CLAIM_ACK_INVALID');
  assertBlocked(await f.observe(), f.mutations);
});

test('Shopify tag and internal-note mutations preserve the exact approved fields', async t => {
  for (const operation of ['product_tags_add', 'product_tags_remove', 'internal_note']) await t.test(operation, async t => {
    const f = await fixture(t, { operation, baseline: operation.startsWith('product_tags_') });
    assert.equal((await f.run()).status, 'completed');
    assert.equal(f.mutations.length, 1);
    assert.deepEqual(f.mutations[0].body.variables, operation === 'internal_note'
      ? { metafields: [{ ownerId: PRODUCT, namespace: '$app:runvara', key: 'internal_note', type: 'single_line_text_field', value: 'Approved internal note' }] }
      : { id: PRODUCT, tags: ['approved-tag'] });
    if (operation.startsWith('product_tags_')) assert.equal(f.calls.filter(call => !call.mutation).length, 1);
  });
});

test('Meta catalogue and Facebook-update branches send exact approved targets and fields', async t => {
  const cases = {
    catalog_inventory: { resource: META_PRODUCT, body: { inventory: 9, availability: 'in stock' } },
    catalog_visibility: { resource: META_PRODUCT, body: { visibility: 'staging' } },
    catalog_product_update: { resource: META_PRODUCT, body: { name: 'Approved product', description: 'Approved description' } },
    catalog_product_create: { resource: `${CATALOG}/products`, body: {
      name: 'Approved product', description: 'Approved description', retailer_id: 'approved-sku', brand: 'Approved brand',
      category: 'Home & Garden', url: 'https://example.test/approved', image_url: 'https://example.test/approved.jpg',
      price: 1099, currency: 'GBP', availability: 'out of stock', condition: 'new', visibility: 'staging'
    } },
    facebook_update: { resource: `${PAGE}_909`, body: { message: 'Approved post' } }
  };
  for (const [operation, expected] of Object.entries(cases)) await t.test(operation, async t => {
    const f = await fixture(t, { provider: 'meta', operation });
    assert.equal((await f.run()).status, 'completed');
    assert.equal(f.mutations.length, 1);
    assert.equal(f.mutations[0].url.pathname, `/v26.0/${expected.resource}`);
    assert.deepEqual(f.mutations[0].body, expected.body);
  });
});

test('same-object Meta approval, account and payload changes during a permissions read fail closed', async t => {
  for (const alteration of ['approval', 'account', 'payload']) await t.test(alteration, async t => {
    const f = await fixture(t, { provider: 'meta', operation: 'facebook_publish' }), g = gate();
    t.after(g.release);
    f.hooks.fetch = async call => { if (call.url.pathname.endsWith('/me/permissions')) await g.block(); };
    const running = f.observe();
    await reached(g, running);
    if (alteration === 'approval') f.state.approvals[0].status = 'rejected';
    if (alteration === 'account') f.state.connections.find(item => item.provider === 'meta').metadata.accountId = '999';
    if (alteration === 'payload') f.write.input = { ...f.write.input, message: 'Unapproved replacement post' };
    g.release();
    assertBlocked(await running, f.mutations);
  });
});

async function assertInstagramSubstitutionCannotReplay(f, result, state = f.state, store = f.store) {
  assertBlocked(result, f.mutations, 1);
  assert.ok(!f.mutations.some(call => call.url.pathname.endsWith('/media_publish')));
  const saved = await store.get(WORKSPACE);
  assert.equal(saved.connectionWrites[0].providerState.containerId, CONTAINER);
  assert.equal(saved.connectionWrites[0].dispatchClaim.phases.instagram_container.resultId, CONTAINER);
  assert.notEqual(saved.connectionWrites[0].status, 'completed');
  const retry = current => executeConnectionWrite(current, f.write.id, current.users[0].id, f.service,
    () => store.save(WORKSPACE, current), { ...f.options, loadFreshState: () => store.get(WORKSPACE) }).catch(error => error);
  assertBlocked(await retry(state), f.mutations, 1);
  assertBlocked(await retry(saved), f.mutations, 1);
}

test('Instagram never publishes a container substituted while its status read is in flight', async t => {
  const f = await fixture(t, { provider: 'meta', operation: 'instagram_publish' }), g = gate();
  t.after(g.release);
  f.hooks.fetch = async call => { if (call.url.pathname === `/v26.0/${CONTAINER}`) await g.block(); };
  const running = f.observe();
  await reached(g, running);
  assert.equal(f.write.providerState.containerId, CONTAINER);
  assert.equal(f.mutations.length, 1);
  f.write.providerState.containerId = '999';
  g.release();
  const result = await running;
  assert.ok(result instanceof Error);
  assert.equal(result.code, 'WRITE_REQUEST_CHANGED');
  await assertInstagramSubstitutionCannotReplay(f, result);
});

test('Instagram keeps the result-derived container binding during a resumed permissions read', async t => {
  const f = await fixture(t, { provider: 'meta', operation: 'instagram_publish' }), g = gate();
  t.after(g.release);
  f.hooks.fetch = async call => call.url.pathname === `/v26.0/${CONTAINER}`
    ? json({ status_code: 'IN_PROGRESS' }) : undefined;
  assert.equal((await f.run()).status, 'processing');
  f.write.providerState.checkAfter = Date.now() - 1;
  await f.persist();
  const resumed = await f.replica.get(WORKSPACE);
  f.hooks.fetch = async call => { if (call.url.pathname.endsWith('/me/permissions')) await g.block(); };
  const running = executeConnectionWrite(resumed, f.write.id, resumed.users[0].id, f.service,
    () => f.replica.save(WORKSPACE, resumed), { ...f.options, loadFreshState: () => f.replica.get(WORKSPACE) }).catch(error => error);
  await reached(g, running);
  resumed.connectionWrites[0].providerState.containerId = '999';
  g.release();
  await assertInstagramSubstitutionCannotReplay(f, await running, resumed, f.replica);
});

test('Instagram rejects container substitution while a durable result acknowledgement is pending', async t => {
  const f = await fixture(t, { provider: 'meta', operation: 'instagram_publish' }), g = gate();
  t.after(g.release);
  const running = f.observe(async () => {
    const ack = await f.persist();
    if (f.write.providerState?.containerId && !f.write.providerState.publishStartedAt) await g.block();
    return ack;
  });
  await reached(g, running);
  assert.equal((await f.replica.get(WORKSPACE)).connectionWrites[0].providerState.containerId, CONTAINER);
  f.write.providerState.containerId = '999';
  g.release();
  const result = await running;
  assert.ok(result instanceof Error);
  assert.equal(result.code, 'WRITE_REQUEST_CHANGED');
  await assertInstagramSubstitutionCannotReplay(f, result);
});

test('two SupabaseStore adapters using mocked conditional PATCHes permit only one competing write attempt', async t => {
  const f = await fixture(t, { storage: 'mock-supabase' });
  assert.equal(f.store.provider, 'supabase');
  assert.notEqual(f.store, f.replica);
  const second = await f.replica.get(WORKSPACE);
  const results = await Promise.all([
    f.observe(),
    executeConnectionWrite(second, f.write.id, second.users[0].id, f.service,
      () => f.replica.save(WORKSPACE, second), { ...f.options,
        loadFreshState: context => f.replica.getConnectionWriteContext(WORKSPACE, context) }).catch(error => error)
  ]);
  assert.equal(f.mutations.length, 1);
  assert.equal(results.filter(result => result.status === 'completed').length, 1);
  assert.equal(results.filter(result => result.code === 'STATE_CONFLICT').length, 1);
  const commits = f.database.calls.filter(call => call.method === 'PATCH' && call.url.pathname.endsWith('/saas_workspace_state'));
  assert.ok(commits.length > 1);
  assert.ok(commits.every(call => /^eq\./.test(call.url.searchParams.get('state->>_revision'))));
});

test('a second SupabaseStore adapter can revoke authority before dispatch after a mocked phase CAS', async t => {
  const f = await fixture(t, { storage: 'mock-supabase' }), g = gate();
  t.after(g.release);
  let saves = 0;
  const running = f.observe(async () => {
    const ack = await f.persist();
    if (++saves === 2) await g.block();
    return ack;
  });
  await reached(g, running);
  assert.equal(f.mutations.length, 0);
  await f.changeReplica(alterations.pause);
  g.release();
  assertBlocked(await running, f.mutations);
  assert.equal((await f.replica.get(WORKSPACE)).connectionSettings.shopify.permissionMode, 'read_only');
});

test('mismatched or missing authenticated actor context denies all preparation and dispatch', async t => {
  const invalidSessions = {
    missing: undefined,
    workspace: { workspaceId: 'different-workspace', userId: 'synthetic-owner', sessionVersion: 1 },
    user: { workspaceId: WORKSPACE, userId: 'different-user', sessionVersion: 1 },
    version: { workspaceId: WORKSPACE, userId: 'synthetic-owner', sessionVersion: 2 },
    stringVersion: { workspaceId: WORKSPACE, userId: 'synthetic-owner', sessionVersion: '1' },
    incomplete: { workspaceId: WORKSPACE, userId: 'synthetic-owner' }
  };
  for (const [name, actorSession] of Object.entries(invalidSessions)) await t.test(name, async t => {
    const f = await fixture(t, { operation: 'product_tags_add', baseline: true });
    let credentialCalls = 0;
    f.hooks.credentials = () => { credentialCalls++; };
    const result = await f.observe(f.persist, { ...f.options, actorSession });
    assertBlocked(result, f.mutations);
    assert.equal(credentialCalls, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(f.durableClaims.length, 0);
  });
});

test('session, password-reset and approval-owner authority is frozen before credential awaits', async t => {
  const changes = {
    sessionVersion(state) { state.users.find(user => user.id === 'synthetic-owner').sessionVersion++; },
    passwordChangeRequired(state) { state.users.find(user => user.id === 'synthetic-owner').passwordChangeRequired = true; },
    decidingOwner(state) { state.approvals[0].decidedBy = 'replacement-owner'; }
  };
  for (const location of ['same-object', 'persisted']) {
    for (const [name, change] of Object.entries(changes)) await t.test(`${location} ${name}`, async t => {
      const f = await fixture(t), g = gate();
      t.after(g.release);
      f.state.users.push({ ...f.state.users[0], id: 'replacement-owner', email: 'replacement-owner@example.test' });
      await f.persist();
      f.hooks.credentials = () => g.block();
      const running = f.observe();
      await reached(g, running);
      if (location === 'same-object') change(f.state);
      else await f.changeReplica(change);
      g.release();
      assertBlocked(await running, f.mutations);
      assert.equal(f.calls.length, 0);
    });
  }
});

test('mutating the supplied actor context during credentials cannot adopt a newly bumped session', async t => {
  const f = await fixture(t), g = gate();
  t.after(g.release);
  const actorSession = { ...f.options.actorSession };
  f.hooks.credentials = () => g.block();
  const running = f.observe(f.persist, { ...f.options, actorSession });
  await reached(g, running);
  f.state.users[0].sessionVersion = 2;
  if (!Object.isFrozen(actorSession)) actorSession.sessionVersion = 2;
  g.release();
  assertBlocked(await running, f.mutations);
  assert.equal(f.calls.length, 0);
});

test('ten durable admissions block another execution before credentials, baseline HTTP or claims', async t => {
  const f = await fixture(t, { operation:'product_tags_add', baseline:true });
  f.state.connectionDispatchAdmissions = Array(10).fill(Date.now() - 1000);
  let credentialCalls = 0;
  f.hooks.credentials = () => { credentialCalls++; };
  const result = await f.observe();
  assertBlocked(result, f.mutations);
  assert.equal(result.code, 'WRITE_EXECUTION_RATE_LIMITED');
  assert.equal(result.status, 429);
  assert.equal(credentialCalls, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.durableClaims.length, 0);
  assert.equal(f.write.status, 'pending_approval');
  assert.equal(f.write.dispatchClaim, undefined);
});

test('malformed and future durable admission histories fail closed before preflight', async t => {
  const histories = {
    null:null, object:{}, string:'unlimited', invalidNumber:[NaN], fractional:[1.5], negative:[-1],
    stringTimestamp:['1'], nullTimestamp:[null], future:[Date.now() + 60000], tooMany:Array(11).fill(1)
  };
  for (const [name, history] of Object.entries(histories)) await t.test(name, async t => {
    const f = await fixture(t, { operation:'product_tags_add', baseline:true });
    f.state.connectionDispatchAdmissions = history;
    let credentialCalls = 0;
    f.hooks.credentials = () => { credentialCalls++; };
    const result = await f.observe();
    assertBlocked(result, f.mutations);
    assert.equal(result.code, 'WRITE_ADMISSION_UNAVAILABLE');
    assert.equal(credentialCalls, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(f.durableClaims.length, 0);
    assert.equal(f.write.dispatchClaim, undefined);
  });
});

test('expired admission timestamps are removed and the new count is saved with the initial claim', async t => {
  const f = await fixture(t);
  f.state.connectionDispatchAdmissions = Array(10).fill(Date.now() - 3600001);
  const before = Date.now();
  assert.equal((await f.run()).status, 'completed');
  assert.equal(f.mutations.length, 1);
  assert.equal(f.durableClaims[0].connectionDispatchAdmissions.length, 1);
  assert.ok(f.durableClaims[0].connectionDispatchAdmissions[0] >= before);
  assert.equal(f.durableClaims[0].connectionWrites[0].status, 'executing');
  assert.equal((await f.replica.get(WORKSPACE)).connectionDispatchAdmissions.length, 1);
});

test('the durable admission count survives a second SupabaseStore client and blocks its next write', async t => {
  const f = await fixture(t, { storage:'mock-supabase' });
  f.state.connectionDispatchAdmissions = Array(9).fill(Date.now() - 1000);
  await f.persist();
  assert.equal((await f.run()).status, 'completed');
  await f.persist();
  const current = await f.replica.get(WORKSPACE);
  assert.equal(current.connectionDispatchAdmissions.length, 10);
  const next = proposeConnectionWrite(current, 'shopify', { ...f.write.input, requestId:'durable-admission-second-request' }, current.users[0].id);
  Object.assign(current.approvals.find(row => row.id === next.approvalId), {
    status:'approved', decidedBy:current.users[0].id, decidedAt:new Date().toISOString()
  });
  await f.replica.save(WORKSPACE, current);
  const beforeCalls = f.calls.length, beforeStorage = f.database.calls.length;
  const result = await executeConnectionWrite(current, next.id, current.users[0].id, f.service,
    () => f.replica.save(WORKSPACE, current), { ...f.options,
      loadFreshState: context => f.replica.getConnectionWriteContext(WORKSPACE, context) }).catch(error => error);
  assertBlocked(result, f.mutations, 1);
  assert.equal(result.code, 'WRITE_EXECUTION_RATE_LIMITED');
  assert.equal(f.calls.length, beforeCalls);
  assert.equal(f.database.calls.length, beforeStorage, 'No claim or boundary read is needed for an exhausted admission window');
  assert.equal((await f.replica.get(WORKSPACE)).connectionDispatchAdmissions.length, 10);
});

const scopeTargets = {
  root: f => f.state,
  workspace: f => f.state.workspace,
  write: f => f.write,
  input: f => f.write.input,
  approval: f => f.state.approvals[0],
  payload: f => f.state.approvals[0].payload,
  actor: f => f.state.users[0],
  connection: f => f.state.connections[0],
  metadata: f => f.state.connections[0].metadata
};

test('scope markers on every dispatch authority object must match the authenticated workspace exactly', async t => {
  const markers = { workspaceId:'other-workspace', workspace_id:` ${WORKSPACE}`, tenantId:null, tenant_id:17,
    workspace:{id:'other-workspace'}, tenant:{id:WORKSPACE, workspace_id:'other-workspace'} };
  for (const [targetName, target] of Object.entries(scopeTargets)) {
    for (const [marker, value] of Object.entries(markers)) await t.test(`${targetName}.${marker}`, async t => {
      const f = await fixture(t);
      target(f)[marker] = structuredClone(value);
      let credentialCalls = 0;
      f.hooks.credentials = () => { credentialCalls++; };
      assertBlocked(await f.observe(), f.mutations);
      assert.equal(credentialCalls, 0);
      assert.equal(f.calls.length, 0);
      assert.equal(f.durableClaims.length, 0);
    });
  }
});

test('nested workspace and tenant markers cannot conceal a conflicting scope', async t => {
  for (const nested of ['workspace', 'tenant']) await t.test(nested, async t => {
    const f = await fixture(t);
    f.state.approvals[0].payload[nested] = { id:WORKSPACE, tenant:{ id:WORKSPACE, workspace:{ id:'other-workspace' } } };
    const result = await f.observe();
    assertBlocked(result, f.mutations);
    assert.equal(result.code, 'WRITE_SCOPE_CHANGED');
    assert.equal(f.calls.length, 0);
    assert.equal(f.durableClaims.length, 0);
  });
});

test('matching scope markers preserve an otherwise valid exact approval', async t => {
  const f = await fixture(t);
  for (const target of Object.values(scopeTargets)) Object.assign(target(f), {
    workspaceId:WORKSPACE, workspace_id:WORKSPACE, tenantId:WORKSPACE, tenant_id:WORKSPACE, tenant:{ id:WORKSPACE }
  });
  f.write.digest = fingerprint(f.write.input);
  f.state.approvals[0].payload.digest = f.write.digest;
  await f.persist();
  assert.equal((await f.run()).status, 'completed');
  assert.equal(f.mutations.length, 1);
});

test('Supabase dispatch uses only trusted bounded context selectors after the initial state load', async t => {
  const f = await fixture(t, { storage:'mock-supabase' });
  const before = f.database.calls.length, contexts = [];
  const result = await f.run(f.persist, { ...f.options, loadFreshState: async context => {
    contexts.push(structuredClone(context));
    return f.store.getConnectionWriteContext(WORKSPACE, context);
  } });
  assert.equal(result.status, 'completed');
  assert.equal(contexts.length, 2);
  for (const context of contexts) {
    assert.deepEqual(Object.keys(context).sort(), ['revision','provider','writeId','connectionId','actorId','approverId','approvalId',
      'writeIndex','connectionIndex','actorIndex','approverIndex','approvalIndex'].sort());
    assert.equal(context.writeId, f.write.id);
    assert.equal(context.connectionId, f.write.connectionId);
    assert.equal(context.actorId, f.options.actorSession.userId);
    assert.equal(context.approverId, f.options.actorSession.userId);
    assert.equal(context.approvalId, f.write.approvalId);
    assert.equal(context.writeIndex, 0);
    assert.equal(context.connectionIndex, 0);
    assert.equal(context.actorIndex, 0);
    assert.equal(context.approverIndex, 0);
    assert.equal(context.approvalIndex, 0);
  }
  const reads = f.database.calls.slice(before).filter(call => call.method === 'GET' && call.url.pathname.endsWith('/saas_workspace_state'));
  assert.ok(reads.length >= 2);
  assert.ok(reads.every(call => call.url.searchParams.get('select') !== 'state'));
});

test('dispatch preserves exact claims when narrow reporting is deferred or a lost reporting reply is reconciled', async t => {
  for (const failure of ['denied-reporting', 'lost-reporting-reply']) await t.test(failure, async t => {
    const f = await fixture(t, { storage: 'mock-supabase' });
    const originalFetch = f.store.fetch, reports = [], before = f.database.calls.length;
    f.store.fetch = async (url, options = {}) => {
      if (new URL(url).pathname.endsWith('/rpc/runvara_commit_reporting_status')) {
        reports.push({ body: options.body });
        if (failure === 'denied-reporting') return Response.json({ code: '42501' }, { status: 403 });
        await originalFetch(url, options);
        throw new TypeError('synthetic lost reporting reply');
      }
      return originalFetch(url, options);
    };
    const result = await f.run();
    assert.equal(result.status, 'completed');
    assert.equal(f.mutations.length, 1, 'reporting recovery must never repeat the approved external mutation');
    assert.equal(f.mutations[0].body.variables.product.title, 'Approved title');
    const storageCalls = f.database.calls.slice(before);
    assert.equal(storageCalls.filter(call => call.method === 'PATCH').length, 3, 'initial claim, phase claim and terminal result each save full state once');
    assert.equal(reports.length, 3, 'there is one narrow follow-up per full state save, without full-state fallback');
    for (const call of reports) {
      const body = JSON.parse(call.body);
      assert.ok(Buffer.byteLength(call.body) <= 16384);
      assert.deepEqual(Object.keys(body).sort(), ['p_expected_revision', 'p_next_revision', 'p_report', 'p_updated_at', 'p_workspace_id']);
      assert.equal(Object.hasOwn(body, 'state'), false);
    }
    assert.equal(storageCalls.filter(call => call.url.searchParams.get('select') === 'revision:state->>_revision').length,
      failure === 'lost-reporting-reply' ? 3 : 0);
    const saved = f.database.states.get(WORKSPACE);
    assert.equal(saved.connectionWrites[0].status, 'completed');
    assert.equal(saved.connectionDispatchAdmissions.length, 1);
    assert.equal(saved.approvals[0].executedExternally, true);
    assert.equal(saved._revision, f.state._revision);
    if (failure === 'denied-reporting') assert.match(saved.integrationStatus.reporting.detail, /pending/);
    else assert.equal(saved.integrationStatus.reporting.status, 'connected');
  });
});

test('an unverifiable reporting reply after the phase claim cannot permit mutation or replay the claimed phase', async t => {
  for (const kind of ['malformed', 'oversized']) await t.test(kind, async t => {
    const f = await fixture(t, { storage: 'mock-supabase' });
    const originalFetch = f.store.fetch;
    let reports = 0;
    f.store.fetch = async (url, options = {}) => {
      const response = await originalFetch(url, options);
      if (new URL(url).pathname.endsWith('/rpc/runvara_commit_reporting_status') && ++reports === 2) {
        return new Response(kind === 'malformed' ? 'private unverified reporting acknowledgement' : 'x'.repeat(4097));
      }
      return response;
    };
    const result = await f.observe();
    assertBlocked(result, f.mutations);
    assert.equal(result.code, 'STATE_CONFLICT');
    assert.equal(reports, 2);
    const durable = await f.replica.get(WORKSPACE);
    assert.equal(durable.connectionWrites[0].status, 'executing');
    assert.equal(durable.connectionWrites[0].dispatchClaim.phases.shopify_mutation.status, 'dispatching');
    assert.notEqual(durable._revision, f.state._revision);
    const before = f.database.calls.length;
    const replay = await executeConnectionWrite(durable, f.write.id, durable.users[0].id, f.service,
      () => f.replica.save(WORKSPACE, durable), { ...f.options,
        loadFreshState: context => f.replica.getConnectionWriteContext(WORKSPACE, context) }).catch(error => error);
    assertBlocked(replay, f.mutations);
    assert.equal(f.database.calls.length, before, 'an already-claimed phase cannot acquire fresh dispatch authority by retrying');
  });
});

test('undecodable final dispatch proof neither advances read success nor permits the claimed provider mutation', async t => {
  const failures={
    empty:()=>new Response(null,{status:204}),
    malformed:()=>new Response('private malformed dispatch proof'),
    oversized:()=>new Response('x'.repeat(32769)),
    stream:()=>new Response(new ReadableStream({start(controller){controller.error(new Error('private interrupted proof'));}}))
  };
  for(const [kind,response] of Object.entries(failures)) await t.test(kind,async t=>{
    const f=await fixture(t,{storage:'mock-supabase'}),originalFetch=f.store.fetch;
    let proofReads=0,diagnosticsAtRejection;
    f.store.fetch=async(url,options={})=>{
      const select=new URL(url).searchParams.get('select')||'';
      if(select.includes('scope_workspaceId:')&&++proofReads===2)return response();
      return originalFetch(url,options);
    };
    const result=await f.observe(f.persist,{...f.options,loadFreshState:async context=>{
      const sentinel='2026-01-01T00:00:00.000Z';
      if(proofReads===1)f.store.telemetry.lastSuccessfulReadAt=sentinel;
      try{return await f.store.getConnectionWriteContext(WORKSPACE,context);}
      catch(error){diagnosticsAtRejection=f.store.diagnostics();throw error;}
    }});
    assertBlocked(result,f.mutations);
    assert.equal(result.errorCode,'WRITE_CONTEXT_UNAVAILABLE');
    assert.equal(proofReads,2);
    assert.equal(diagnosticsAtRejection.lastSuccessfulReadAt,'2026-01-01T00:00:00.000Z');
    assert.equal(diagnosticsAtRejection.lastFailureCode,kind==='oversized'?'SUPABASE_RESPONSE_TOO_LARGE':'SUPABASE_RESPONSE_INVALID');
    assert.equal(diagnosticsAtRejection.primaryPersistence,true,'failed evidence reads do not revoke an acknowledged primary state commit');
    assert.doesNotMatch(JSON.stringify(diagnosticsAtRejection),/private malformed dispatch proof|private interrupted proof/);
    const durable=await f.replica.get(WORKSPACE);
    assert.equal(durable.connectionWrites[0].dispatchClaim.phases.shopify_mutation.status,'dispatching');
    assert.equal(durable.connectionWrites[0].status,'failed');
    const before=f.database.calls.length;
    const retry=await executeConnectionWrite(durable,f.write.id,durable.users[0].id,f.service,()=>f.replica.save(WORKSPACE,durable),{
      ...f.options,loadFreshState:context=>f.replica.getConnectionWriteContext(WORKSPACE,context)
    }).catch(error=>error);
    assertBlocked(retry,f.mutations);assert.equal(retry.code,'WRITE_ALREADY_ATTEMPTED');
    assert.equal(f.database.calls.length,before);
  });
});

test('Instagram status observation failures retain the acknowledged container through cooldown and later publish once', async t => {
  const raw = 'PRIVATE provider diagnostic with synthetic credentials';
  const cases = {
    transient: { code:'META_STATUS_UNAVAILABLE', response() { throw Object.assign(new TypeError(raw), {code:'invalid code: ' + raw}); } },
    malformedJson: { code:'META_RESULT_UNKNOWN', response() { return new Response(raw, {status:200}); } },
    malformedStatus: { code:'META_STATUS_UNVERIFIED', response() { return json({status_code:'UNEXPECTED', diagnostic:raw}); } }
  };
  for (const [name, observation] of Object.entries(cases)) await t.test(name, async t => {
    const f = await fixture(t, {provider:'meta', operation:'instagram_publish'});
    let failing = true, statusReads = 0;
    f.hooks.fetch = async call => {
      if (call.url.pathname === `/v26.0/${CONTAINER}`) {
        statusReads++;
        if (failing) return observation.response();
      }
      if (call.url.pathname.endsWith('/media_publish')) {
        const saved = await f.replica.get(WORKSPACE);
        assert.equal(saved.connectionWrites[0].dispatchClaim.phases.instagram_publish.status, 'dispatching');
        assert.ok(saved.connectionWrites[0].providerState.publishStartedAt);
        assert.equal(saved.connectionWrites[0].dispatchClaim.phases.instagram_container.resultId, CONTAINER);
      }
    };
    const initial = await f.run();
    assert.equal(initial.status, 'processing');
    assert.equal(initial.observationErrorCode, observation.code);
    assert.equal(initial.providerState.containerId, CONTAINER);
    assert.equal(initial.dispatchClaim.phases.instagram_container.resultId, CONTAINER);
    assert.ok(initial.providerState.checkAfter > Date.now());
    assert.equal(initial.providerState.publishStartedAt, undefined);
    assert.equal(f.mutations.length, 1);
    assert.equal(statusReads, 1);
    assert.ok(!JSON.stringify(f.state).includes(raw));
    await f.persist();

    const cooldown = await f.run();
    assert.equal(cooldown.status, 'processing');
    assert.equal(cooldown.observationErrorCode, observation.code, 'Cooldown must retain the last unverified observation');
    assert.equal(statusReads, 1, 'Cooldown does not poll the media status');
    assert.equal(f.mutations.length, 1);
    await f.persist();

    const resumed = await f.replica.get(WORKSPACE);
    assert.equal(resumed.connectionWrites[0].observationErrorCode, observation.code);
    resumed.connectionWrites[0].providerState.checkAfter = 0;
    await f.replica.save(WORKSPACE, resumed);
    failing = false;
    const execute = () => executeConnectionWrite(resumed, f.write.id, resumed.users[0].id, f.service,
      () => f.replica.save(WORKSPACE, resumed), {...f.options, loadFreshState:() => f.replica.get(WORKSPACE)});
    const completed = await execute();
    assert.equal(completed.status, 'completed');
    assert.equal(completed.observationErrorCode, null);
    assert.equal(statusReads, 2);
    assert.deepEqual(f.mutations.map(call => call.url.pathname), [`/v26.0/${INSTAGRAM}/media`, `/v26.0/${INSTAGRAM}/media_publish`]);
    assert.deepEqual(f.mutations[1].body, {creation_id:CONTAINER});
    await f.replica.save(WORKSPACE, resumed);
    assert.equal((await execute()).status, 'completed');
    assert.equal(f.mutations.length, 2);
    assert.ok(!JSON.stringify(await f.replica.get(WORKSPACE)).includes(raw));
  });
});

// Match the API mutate contract: a thrown execution callback must prevent its
// final whole-workspace save; a returned terminal result may be persisted.
async function executeThenSave(action, save) {
  const result = await action();
  await save();
  return result;
}

test('resetting admitted history during token acquisition cannot erase the durable tenth admission', async t => {
  const f = await fixture(t, {storage:'mock-supabase'}), g = gate();
  t.after(g.release);
  f.state.connectionDispatchAdmissions = Array(9).fill(Date.now() - 1000);
  await f.persist();
  let finalSaves = 0;
  f.hooks.token = () => g.block();
  const running = executeThenSave(() => f.run(), async () => { finalSaves++; await f.persist(); }).catch(error => error);
  await reached(g, running);
  assert.equal((await f.replica.get(WORKSPACE)).connectionDispatchAdmissions.length, 10);
  f.state.connectionDispatchAdmissions = [];
  g.release();
  const result = await running;
  assertBlocked(result, f.mutations);
  assert.ok(result instanceof Error);
  assert.equal(result.code, 'WRITE_CLAIM_CHANGED');
  assert.equal(finalSaves, 0);
  const saved = await f.replica.get(WORKSPACE);
  assert.equal(saved.connectionDispatchAdmissions.length, 10);
  assert.equal(saved.connectionWrites[0].status, 'executing');
  assert.deepEqual(saved.connectionWrites[0].dispatchClaim.phases, {});
});

test('resetting admitted history while the provider response is in flight throws before outer save and cannot replay', async t => {
  const f = await fixture(t, {storage:'mock-supabase'}), g = gate();
  t.after(g.release);
  f.state.connectionDispatchAdmissions = Array(9).fill(Date.now() - 1000);
  await f.persist();
  let finalSaves = 0;
  f.hooks.fetch = async call => { if (call.mutation) await g.block(); };
  const running = executeThenSave(() => f.run(), async () => { finalSaves++; await f.persist(); }).catch(error => error);
  await reached(g, running);
  assert.equal(f.mutations.length, 1);
  f.state.connectionDispatchAdmissions = [];
  g.release();
  const result = await running;
  assertBlocked(result, f.mutations, 1);
  assert.ok(result instanceof Error);
  assert.equal(result.code, 'WRITE_CLAIM_CHANGED');
  assert.equal(finalSaves, 0);
  const saved = await f.replica.get(WORKSPACE);
  assert.equal(saved.connectionDispatchAdmissions.length, 10);
  assert.equal(saved.connectionWrites[0].status, 'executing');
  assert.equal(saved.connectionWrites[0].dispatchClaim.phases.shopify_mutation.status, 'dispatching');
  assert.equal(saved.connectionWrites[0].completedAt, undefined);
  const replay = await executeThenSave(() => executeConnectionWrite(saved, f.write.id, saved.users[0].id, f.service,
    () => f.replica.save(WORKSPACE, saved), {...f.options,
      loadFreshState:context => f.replica.getConnectionWriteContext(WORKSPACE, context)}), async () => {
    finalSaves++;
    await f.replica.save(WORKSPACE, saved);
  }).catch(error => error);
  assertBlocked(replay, f.mutations, 1);
  assert.equal(replay.code, 'WRITE_ALREADY_ATTEMPTED');
  assert.equal(finalSaves, 0);
  assert.equal((await f.replica.get(WORKSPACE)).connectionDispatchAdmissions.length, 10);
});

test('a saved acknowledgement cannot replace the exact admitted history vector', async t => {
  for (const corruptSave of [1, 2]) await t.test(corruptSave === 1 ? 'initial claim' : 'mutation phase claim', async t => {
    const f = await fixture(t, {storage:'mock-supabase'});
    f.state.connectionDispatchAdmissions = Array(9).fill(Date.now() - 1000);
    await f.persist();
    let claims = 0, finalSaves = 0;
    const result = await executeThenSave(() => f.run(async () => {
      const ack = await f.persist();
      if (++claims === corruptSave) ack.connectionDispatchAdmissions = [];
      return ack;
    }), async () => { finalSaves++; await f.persist(); }).catch(error => error);
    assertBlocked(result, f.mutations);
    assert.equal(result.code || result.errorCode, 'WRITE_CLAIM_ACK_INVALID');
    assert.equal(finalSaves, corruptSave === 1 ? 0 : 1);
    const saved = await f.replica.get(WORKSPACE);
    assert.equal(saved.connectionDispatchAdmissions.length, 10);
    assert.equal(saved.connectionWrites[0].status, corruptSave === 1 ? 'executing' : 'failed');
  });
});

test('an in-place admitted-vector reset during a pending Supabase save cannot corrupt its shallow snapshot', async t => {
  const f = await fixture(t, {storage:'mock-supabase'});
  f.state.connectionDispatchAdmissions = Array(9).fill(Date.now() - 1000);
  await f.persist();
  let finalSaves = 0, attempts = 0;
  const result = await executeThenSave(() => f.run(async () => {
    const saving = f.persist();
    let resetError;
    try {
      attempts++;
      f.state.connectionDispatchAdmissions.length = 0;
    } catch (error) { resetError = error; }
    const ack = await saving;
    if (resetError) throw resetError;
    return ack;
  }), async () => { finalSaves++; await f.persist(); }).catch(error => error);
  assert.ok(result instanceof TypeError, 'The private admission vector must reject in-place mutation');
  assert.equal(attempts, 1);
  assertBlocked(result, f.mutations);
  assert.equal(finalSaves, 0);
  assert.equal(f.state.connectionDispatchAdmissions.length, 10);
  const saved = await f.replica.get(WORKSPACE);
  assert.equal(saved.connectionDispatchAdmissions.length, 10);
  assert.equal(saved.connectionWrites[0].status, 'executing');
  assert.deepEqual(saved.connectionWrites[0].dispatchClaim.phases, {});
  const replay = await executeConnectionWrite(saved, f.write.id, saved.users[0].id, f.service,
    () => f.replica.save(WORKSPACE, saved), {...f.options,
      loadFreshState:context => f.replica.getConnectionWriteContext(WORKSPACE, context)}).catch(error => error);
  assertBlocked(replay, f.mutations);
  assert.equal(replay.code, 'WRITE_ALREADY_ATTEMPTED');
});
