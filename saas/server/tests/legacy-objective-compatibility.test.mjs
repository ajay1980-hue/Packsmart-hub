import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { IntegrationService } from '../lib/integrations.mjs';
import { executeConnectionWrite, proposeConnectionWrite, previewShopifyTagTest } from '../lib/connection-writes.mjs';
import { businessObjectivesSnapshot, evaluateObjectivePlan, upsertBusinessObjective } from '../lib/business-objectives.mjs';
import { assertLegacyObjectiveEnvelope } from '../lib/legacy-objective-policy.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

const WORKSPACE = 'legacy-objective-fixture', SHOP = 'legacy-objective.myshopify.com', PRODUCT = 'gid://shopify/Product/71';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const policy = (overrides = {}) => ({ schema: 'runvara-objective-execution-policy/v1', mode: 'enforce',
  scope: { provider: 'shopify', operation: 'product_content', connectionId: 'shopify-fixture', account: SHOP }, ...overrides });
function addObjective(state, executionPolicy) {
  const objective = upsertBusinessObjective(state, { title: 'Retain objective bytes', metric: 'orders', baseline: 1, target: 2,
    direction: 'increase', startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-31T00:00:00.000Z', limits: { profitFirst: false } });
  const stored = state.businessObjectives.find(row => row.id === objective.id);
  if (executionPolicy !== undefined) stored.executionPolicy = structuredClone(executionPolicy);
  return stored;
}
async function fixture({ operation = 'product_content' } = {}) {
  const database = fakeSupabase();
  const env = { SUPABASE_URL: 'https://legacy-objective.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-test-key' };
  const store = createStore(env, { fetchImpl: database.fetchImpl }), replica = createStore(env, { fetchImpl: database.fetchImpl });
  const seeded = seedWorkspaceState({}, { workspaceId: WORKSPACE, userId: 'synthetic-owner', email: 'owner@example.test', passwordHash: 'synthetic-hash' });
  seeded.products = [{ id: PRODUCT, provider: 'shopify', title: 'Original title' }];
  seeded.connections = [{ id: 'shopify-fixture', provider: 'shopify', encryptedCredentials: 'synthetic-credential-marker',
    metadata: { shopDomain: SHOP, grantedScopes: ['read_products', 'write_products'] } }];
  seeded.connectionSettings = { shopify: { permissionMode: 'approval_gated' } };
  const body = { requestId: 'legacy-objective-request-0001', operation, productId: PRODUCT,
    title: 'Approved title', description: 'Approved description', tags: ['approved'], note: 'Approved note' };
  const proposed = proposeConnectionWrite(seeded, 'shopify', body, seeded.users[0].id);
  Object.assign(seeded.approvals[0], { status: 'approved', decidedBy: seeded.users[0].id, decidedAt: new Date().toISOString() });
  await store.save(WORKSPACE, seeded);
  const state = await store.get(WORKSPACE), write = state.connectionWrites.find(row => row.id === proposed.id);
  const counts = { credentials: 0, providers: 0, saves: 0, fresh: 0 }, hooks = {};
  const service = new IntegrationService({}, { fetchImpl: async (_url, options) => {
    counts.providers++; await hooks.provider?.();
    const query = JSON.parse(options.body).query;
    if (query.includes('tagsAdd')) return Response.json({ data: { tagsAdd: { node: { id: PRODUCT }, userErrors: [] } } });
    if (query.includes('tagsRemove')) return Response.json({ data: { tagsRemove: { node: { id: PRODUCT }, userErrors: [] } } });
    if (query.includes('metafieldsSet')) return Response.json({ data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/1' }], userErrors: [] } } });
    return Response.json({ data: { productUpdate: { product: { id: PRODUCT, title: 'Approved title' }, userErrors: [] } } });
  } });
  service.shopifyConfig = current => ({ mode: 'oauth', accessToken: 'synthetic-token', workspaceId: WORKSPACE,
    domain: current.connections[0].metadata.shopDomain, apiVersion: '2026-07' });
  service.connectorCredentials = async () => { counts.credentials++; await hooks.credentials?.(); return { accessToken: 'synthetic-token' }; };
  const persist = async options => { counts.saves++; await hooks.save?.(options); return store.save(WORKSPACE, state, options); };
  const options = { durableStore: true, actorSession: { workspaceId: WORKSPACE, userId: state.users[0].id, sessionVersion: 1 },
    loadFreshState: async context => { counts.fresh++; await hooks.fresh?.(context); const fresh = await store.getConnectionWriteContext(WORKSPACE, context);
      assert.equal(Object.hasOwn(fresh, 'businessObjectives'), false, 'The production context is deliberately narrow'); return fresh; } };
  return { state, write, store, replica, database, service, counts, hooks, body, persist, options,
    run: () => executeConnectionWrite(state, write.id, state.users[0].id, service, persist, options) };
}
const held = error => /^WRITE_(POLICY|UNSUPPORTED|CLAIM|AUTHORITY)/.test(error.code || error.errorCode || '');

for (const operation of ['product_content', 'product_tags_add', 'product_tags_remove', 'internal_note']) {
  test(`ordinary baseline ${operation} executes exactly once through the current narrow store`, async () => {
    const f = await fixture({ operation });
    assert.equal((await f.run()).status, 'completed'); assert.equal(f.counts.providers, 1);
    assert.equal((await f.run()).status, 'completed'); assert.equal(f.counts.providers, 1);
  });
}

test('new envelopes and bindings cannot acquire legacy dispatch through forged provider, operation or version', async t => {
  const changes = {
    v1: f => { f.write.objectivePolicyProposal = { schema: 'runvara-objective-dispatch-proposal/v1' }; },
    v2: f => { f.write.objectivePolicyProposal = { schema: 'runvara-objective-dispatch-proposal/v2' }; },
    future: f => { f.write.objectivePolicyProposal = { schema: 'runvara-objective-dispatch-proposal/v999', origin: 'owner_objective_content' }; },
    nullEnvelope: f => { f.write.objectivePolicyProposal = null; },
    approvalOnly: f => { f.state.approvals[0].payload.objectivePolicyProposalDigest = 'a'.repeat(64); },
    approvalSourceOnly: f => { f.state.approvals[0].source = 'objective-content'; },
    unknownApprovalBinding: f => { f.state.approvals[0].payload.futureObjectiveBinding = {}; },
    provider: f => { f.write.provider = 'future-shopify'; f.write.objectivePolicyProposal = { schema: 'unknown' }; },
    operation: f => { f.write.input.operation = 'future-content'; f.write.digest = hash(f.write.input); f.state.approvals[0].payload.digest = f.write.digest; },
    disguisedAsNote: f => { f.write.input.operation = 'internal_note'; f.write.input.note = 'Forged'; f.write.objectivePolicyProposal = { schema: 'unknown' }; },
    writeVersion: f => { f.write.version = 2; },
    inputVersion: f => { f.write.input.version = 2; f.write.digest = hash(f.write.input); f.state.approvals[0].payload.digest = f.write.digest; }
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    const f = await fixture(); change(f); await f.store.save(WORKSPACE, f.state);
    const before = JSON.stringify(await f.replica.get(WORKSPACE)), local = JSON.stringify(f.state);
    await assert.rejects(f.run(), held);
    assert.deepEqual(f.counts, { credentials: 0, providers: 0, saves: 0, fresh: 0 });
    assert.equal(JSON.stringify(f.state), local); assert.equal(JSON.stringify(await f.replica.get(WORKSPACE)), before);
  });
});

test('unknown, missing and malformed provider/operation cannot reach the legacy content fallback', async t => {
  const malformed = [undefined, null, '', 'future_operation', 1, {}, []];
  for (const field of ['provider', 'operation']) for (const value of malformed) await t.test(`${field}:${JSON.stringify(value)}`, async () => {
    const f = await fixture();
    const target = field === 'provider' ? f.write : f.write.input;
    if (value === undefined) delete target[field]; else target[field] = value;
    f.write.digest = hash(f.write.input); f.state.approvals[0].payload.digest = f.write.digest;
    await f.store.save(WORKSPACE, f.state);
    const before = JSON.stringify(await f.replica.get(WORKSPACE));
    assert.throws(() => assertLegacyObjectiveEnvelope(f.write, f.state.approvals[0]), error => error.code === 'WRITE_UNSUPPORTED');
    await assert.rejects(f.run(), error => error.code === 'WRITE_UNSUPPORTED');
    assert.deepEqual(f.counts, { credentials: 0, providers: 0, saves: 0, fresh: 0 });
    assert.equal(JSON.stringify(await f.replica.get(WORKSPACE)), before);
  });
  const f = await fixture(); f.write.provider = 'meta'; f.write.input.operation = 'product_content';
  assert.throws(() => assertLegacyObjectiveEnvelope(f.write, f.state.approvals[0]), error => error.code === 'WRITE_UNSUPPORTED');
});

test('already-completed results return before newer authority eligibility without replay', async () => {
  const f = await fixture(); const confirmed = await f.run();
  assert.equal(confirmed.status, 'completed');
  f.write.provider = 'future_provider'; f.write.input.operation = 'future_operation';
  f.write.objectivePolicyProposal = { schema: 'future' };
  const before = { ...f.counts };
  const repeated = await f.run();
  assert.equal(repeated.status, 'completed'); assert.equal(repeated.completedAt, confirmed.completedAt);
  assert.deepEqual(f.counts, before);
});

test('applicable and unknown stored policies stay intact and deny before credentials', async t => {
  const cases = {
    enforce: policy(), paused: policy(), reconnected: policy({ scope: { ...policy().scope, connectionId: 'new-connection' } }),
    futureSchema: policy({ schema: 'runvara-objective-execution-policy/v2' }), unknownMode: policy({ mode: 'future' }),
    futureProvider: policy({ scope: { ...policy().scope, provider: 'future' } }),
    futureOperation: policy({ scope: { ...policy().scope, operation: 'future' } }),
    unknownPreparationField: { schema: 'runvara-objective-execution-policy/v1', mode: 'preparation_only', futureAuthority: true },
    unknownScopeField: policy({ scope: { ...policy().scope, futureAuthority: true } }), invalid: null
  };
  for (const [name, value] of Object.entries(cases)) await t.test(name, async () => {
    const f = await fixture(), objective = addObjective(f.state, value);
    if (name === 'paused') objective.status = 'paused';
    await f.store.save(WORKSPACE, f.state);
    const before = JSON.stringify(await f.replica.get(WORKSPACE)), local = JSON.stringify(f.state);
    await assert.rejects(f.run(), held);
    assert.deepEqual(f.counts, { credentials: 0, providers: 0, saves: 0, fresh: 0 });
    assert.equal(JSON.stringify(f.state), local); assert.equal(JSON.stringify(await f.replica.get(WORKSPACE)), before);
  });
});

test('legacy, preparation-only and unrelated exact restrictions preserve ordinary content execution', async t => {
  for (const value of [undefined, { schema: 'runvara-objective-execution-policy/v1', mode: 'preparation_only' },
    policy({ scope: { ...policy().scope, account: 'other.myshopify.com' } })]) await t.test(JSON.stringify(value) || 'legacy', async () => {
    const f = await fixture(); addObjective(f.state, value); await f.store.save(WORKSPACE, f.state);
    const before = JSON.stringify(f.state.businessObjectives);
    assert.equal((await f.run()).status, 'completed'); assert.equal(f.counts.providers, 1);
    assert.equal(JSON.stringify((await f.replica.get(WORKSPACE)).businessObjectives), before);
  });
});

test('credential-await policy and envelope mutations stop before save or provider request', async t => {
  for (const change of [f => { addObjective(f.state, policy()); }, f => { f.write.objectivePolicyProposal = { schema: 'future' }; },
    f => { f.state.approvals[0].payload.objectivePolicyProposalDigest = 'future'; }, f => { f.write.provider = 'future'; }]) await t.test(change.toString(), async () => {
    const f = await fixture(), before = JSON.stringify(await f.replica.get(WORKSPACE)); f.hooks.credentials = () => change(f);
    await assert.rejects(f.run(), held);
    assert.equal(f.counts.credentials, 1); assert.equal(f.counts.providers, 0); assert.equal(f.counts.saves, 0);
    assert.equal(JSON.stringify(await f.replica.get(WORKSPACE)), before);
  });
});

test('a concurrently committed policy invalidates the narrow workspace revision before dispatch', async () => {
  const f = await fixture();
  f.hooks.fresh = async () => { const current = await f.replica.get(WORKSPACE); addObjective(current, policy());
    await f.replica.save(WORKSPACE, current); f.hooks.fresh = null; };
  const result = await f.run().catch(error => error);
  assert.notEqual(result.status, 'completed'); assert.equal(f.counts.providers, 0);
  const saved = await f.replica.get(WORKSPACE);
  assert.equal(saved.businessObjectives[0].executionPolicy.mode, 'enforce'); assert.equal(saved.connectionWrites[0].status, 'executing');
});

test('a credential-await revision swap cannot attest stale policy absence against a newer stored policy', async () => {
  const f = await fixture();
  f.hooks.credentials = async () => {
    const current = await f.replica.get(WORKSPACE); addObjective(current, policy());
    const saved = await f.replica.save(WORKSPACE, current);
    f.state._revision = saved._revision;
  };
  await assert.rejects(f.run(), error => error.code === 'WRITE_POLICY_SOURCE_CHANGED');
  assert.equal(f.counts.saves, 0); assert.equal(f.counts.providers, 0);
  assert.equal((await f.replica.get(WORKSPACE)).businessObjectives[0].executionPolicy.mode, 'enforce');
});

test('initial and final phase archive awaits cannot smuggle changed policy or approval bytes into a claim', async t => {
  for (const phase of [1, 2]) for (const kind of ['policy', 'envelope', 'approval']) await t.test(`${phase}:${kind}`, async () => {
    const f = await fixture(); addObjective(f.state); await f.store.save(WORKSPACE, f.state);
    const originalObjectives = JSON.stringify(f.state.businessObjectives), originalApproval = JSON.stringify(f.state.approvals[0]);
    const archive = f.store.archiveAndCompact.bind(f.store); let saves = 0;
    f.store.archiveAndCompact = async (...args) => {
      await archive(...args);
      if (++saves !== phase) return;
      if (kind === 'policy') f.state.businessObjectives[0].executionPolicy = policy();
      if (kind === 'envelope') f.write.objectivePolicyProposal = { schema: 'future' };
      if (kind === 'approval') f.state.approvals[0].payload.objectivePolicyProposalDigest = 'future';
    };
    await assert.rejects(f.run(), held);
    assert.equal(f.counts.providers, 0);
    const saved = await f.replica.get(WORKSPACE);
    assert.equal(JSON.stringify(saved.businessObjectives), originalObjectives);
    assert.equal(JSON.stringify(saved.approvals[0]), originalApproval);
    assert.equal(Object.hasOwn(saved.connectionWrites[0], 'objectivePolicyProposal'), false);
    assert.equal(saved.connectionWrites[0].status, phase === 1 ? 'pending_approval' : 'executing');
    assert.deepEqual(saved.connectionWrites[0].dispatchClaim?.phases || {}, {});
  });
});

test('both absent and present policy sources stay pinned across final phase fresh reads', async t => {
  for (const present of [false, true]) await t.test(String(present), async () => {
    const f = await fixture();
    if (present) addObjective(f.state); else delete f.state.businessObjectives;
    await f.store.save(WORKSPACE, f.state);
    const original = JSON.stringify(f.state.businessObjectives);
    f.hooks.fresh = () => {
      if (f.counts.fresh === 2) {
        if (present) f.state.businessObjectives[0].executionPolicy = policy(); else addObjective(f.state, policy());
      }
    };
    await assert.rejects(f.run(), held);
    assert.equal(f.counts.providers, 0);
    const saved = await f.replica.get(WORKSPACE);
    assert.equal(JSON.stringify(saved.businessObjectives), original);
    assert.equal(saved.connectionWrites[0].dispatchClaim.phases.shopify_mutation.status, 'dispatching');
    assert.equal(saved.connectionWrites[0].status, 'executing');
  });
});

test('a later policy does not erase an already-submitted confirmed result or permit replay', async () => {
  const f = await fixture(); f.hooks.provider = () => { addObjective(f.state, policy()); };
  assert.equal((await f.run()).status, 'completed'); assert.equal(f.counts.providers, 1);
  const saved = await f.replica.get(WORKSPACE);
  assert.equal(saved.connectionWrites[0].status, 'completed'); assert.equal(saved.businessObjectives[0].executionPolicy.mode, 'enforce');
  assert.equal((await f.run()).status, 'completed'); assert.equal(f.counts.providers, 1);
});

test('a policy change while a submitted response is lost preserves the durable uncertain fence', async () => {
  const f = await fixture();
  f.hooks.provider = () => { addObjective(f.state, policy()); throw new TypeError('Synthetic lost provider response'); };
  const result = await f.run();
  assert.equal(result.status, 'uncertain'); assert.equal(f.counts.providers, 1);
  const saved = await f.replica.get(WORKSPACE);
  assert.equal(saved.connectionWrites[0].status, 'uncertain');
  assert.equal(saved.connectionWrites[0].dispatchClaim.phases.shopify_mutation.status, 'dispatching');
  assert.equal(saved.businessObjectives[0].executionPolicy.mode, 'enforce');
  await assert.rejects(f.run(), error => error.code === 'WRITE_ALREADY_ATTEMPTED');
  assert.equal(f.counts.providers, 1);
});

test('read-only objective display tolerates private future policies without exposure or lossy editing', () => {
  const state = { workspace: { id: WORKSPACE }, businessObjectives: [], settings: {} };
  const future = policy({ schema: 'runvara-objective-execution-policy/v77', ownerDecision: { private: 'FUTURE_PRIVATE_POLICY_CANARY', values: [0, false, null] } });
  const objective = addObjective(state, future), before = JSON.stringify(state), snapshot = businessObjectivesSnapshot(state);
  assert.equal(Object.hasOwn(snapshot.objectives[0], 'executionPolicy'), false);
  assert.equal(snapshot.objectives[0].executionPolicySupported, false); assert.equal(snapshot.safeguards.externalExecutionAllowed, false);
  assert.ok(!JSON.stringify(snapshot).includes('FUTURE_PRIVATE_POLICY_CANARY'));
  snapshot.objectives[0].limits.profitFirst = true;
  assert.equal(JSON.stringify(state), before);
  assert.throws(() => upsertBusinessObjective(state, { id: objective.id, revision: 1, target: 3 }), /Unsupported stored objective field/);
  assert.throws(() => evaluateObjectivePlan(state, { objectiveId: objective.id, kind: 'internal_analysis', mode: 'internal_preparation' }), /Unsupported stored objective field/);
  assert.equal(JSON.stringify(state), before);
});

test('legacy proposals reject newer authority input and stored policies without modifying state', async () => {
  const f = await fixture(), before = JSON.stringify(f.state);
  for (const extra of [{ objectivePolicyProposal: null }, { schema: 'future' }, { origin: 'owner_objective_content' }]) {
    assert.throws(() => proposeConnectionWrite(f.state, 'shopify', { ...f.body, requestId: 'new-legacy-request-0001', ...extra }, f.state.users[0].id), held);
    assert.equal(JSON.stringify(f.state), before);
  }
  addObjective(f.state, policy()); const restricted = JSON.stringify(f.state);
  assert.throws(() => proposeConnectionWrite(f.state, 'shopify', { ...f.body, requestId: 'new-legacy-request-0001' }, f.state.users[0].id), held);
  assert.equal(JSON.stringify(f.state), restricted);
});

test('standalone approval checks reject opaque authority while accepting ordinary approval payloads', () => {
  assert.doesNotThrow(() => assertLegacyObjectiveEnvelope(undefined, { payload: { campaignId: 'ordinary' } }));
  for (const approval of [{ objectivePolicyBinding: null }, { payload: { objectivePolicyProposalDigest: 'unknown' } }, { source: 'objective-content' }]) {
    assert.throws(() => assertLegacyObjectiveEnvelope(undefined, approval), held);
  }
});

test('tag preview and expected-tag baselines honor persisted read holds before credentials or reads', async t => {
  for (const kind of ['preview', 'baseline']) for (const timing of ['initial', 'credentials']) await t.test(`${kind}:${timing}`, async () => {
    const f = await fixture({ operation: 'product_tags_add' });
    const hold = () => { f.state.integrationStatus.shopify = { ...f.state.integrationStatus.shopify, orderReadHold: { schema: 'future' } }; };
    if (kind === 'baseline') {
      f.write.input.expectedTags = []; f.write.digest = hash(f.write.input); f.state.approvals[0].payload.digest = f.write.digest;
      await f.store.save(WORKSPACE, f.state);
    }
    if (timing === 'initial') hold(); else f.hooks.credentials = hold;
    const action = kind === 'preview' ? () => previewShopifyTagTest(f.state, PRODUCT, f.service) : f.run;
    await assert.rejects(action(), error => error.code === 'READ_COMPATIBILITY_DEFERRED');
    assert.equal(f.counts.credentials, timing === 'initial' ? 0 : 1);
    assert.equal(f.counts.providers, 0); assert.equal(f.counts.saves, 0);
  });
});

test('a read hold added during tag preview response prevents returning a stale usable preview', async () => {
  const f = await fixture({ operation: 'product_tags_add' });
  let reads = 0;
  f.service.shopifyGraphql = async () => {
    reads++; f.state.integrationStatus.shopify = { orderReadHold: { schema: 'future' } };
    return { product: { id: PRODUCT, title: 'Original title', tags: [] } };
  };
  await assert.rejects(previewShopifyTagTest(f.state, PRODUCT, f.service), error => error.code === 'READ_COMPATIBILITY_DEFERRED');
  assert.equal(reads, 1); assert.equal(f.counts.saves, 0);
});
