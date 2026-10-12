import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { costSourceReviewContext, prepareCostSourceReview, publicEconomicsSources, publicCostSourceHistory,
  productCostSourceReviews, COST_SOURCE_COMPONENTS, COST_SOURCE_REVIEW_MAX_BYTES, COST_SOURCE_HISTORY_MAX_BYTES } from '../lib/cost-source-review.mjs';

const NOW = new Date('2026-10-12T10:00:00.000Z');
const PRODUCT = 'gid://shopify/Product/101', VARIANT = 'gid://shopify/ProductVariant/201';
const SELECTOR = { productId: PRODUCT, variantId: VARIANT, sku: 'CUP-1' };
const ACTOR = { workspaceId: 'cost-workspace', userId: 'owner-1', sessionVersion: 1 };
function seed() {
  return { workspace: { id: ACTOR.workspaceId }, users: [{ id: ACTOR.userId, role: 'owner', active: true, passwordChangeRequired: false, sessionVersion: 1 }],
    products: [{ id: PRODUCT, externalId: PRODUCT, provider: 'shopify', variants: [{ id: VARIANT, externalId: VARIANT, sku: SELECTOR.sku }] }],
    connections: [{ id: 'shopify-1', provider: 'shopify', status: 'connected', encryptedCredentials: 'DO NOT READ',
      metadata: { shopDomain: 'cost-fixture.myshopify.com', accountId: 'gid://shopify/Shop/1', grantedScopes: ['read_products'] } }],
    economics: { [SELECTOR.sku]: { landed: 0, packing: '0.25', handling: null, delivery: '', notes: 'Keep this ordinary cost note', marginFloor: 20 } },
    costHistory: [], connectionSettings: { shopify: { permissionMode: 'read_only' } },
    businessObjectives: [{ id: 'unchanged-objective', limits: { profitFirst: true, spend: 0 } }],
    approvals: [{ id: 'unchanged-approval', status: 'pending' }], agentOps: { paused: true }, settings: { stockHold: true } };
}
const basis = (identifier = 'INV-2026-001') => ({ currency: null, taxBasis: 'unknown', effectiveFrom: null, effectiveUntil: null,
  sources: [{ component: 'landed', kind: 'invoice', identifier, issuedOn: null }] });
function input(state, source = basis(), selector = SELECTOR, actor = ACTOR) {
  return { ...selector, sourceRevision: costSourceReviewContext(state, selector, actor, { now: NOW }).sourceRevision, requestId: crypto.randomUUID(), basis: source };
}
const prepare = (state, value = input(state), actor = ACTOR) => prepareCostSourceReview(state, value, actor, { now: NOW });
function apply(state, result) {
  if (result.duplicate) return;
  state.economics[result.record.target.sku] = result.economics;
  state.costHistory = [result.historyEvent, ...state.costHistory];
}
const context = state => costSourceReviewContext(state, SELECTOR, ACTOR, { now: NOW });
function reordered(value) {
  if (Array.isArray(value)) return value.map(reordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).reverse().map(key => [key, reordered(value[key])]));
  return value;
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test('pure review of explicit zero keeps unknown facts, saved costs, and all holds unchanged', () => {
  const state = seed(), before = structuredClone(state), request = input(state);
  freeze(state); freeze(request);
  const plan = prepare(state, request);
  assert.equal(plan.duplicate, false); assert.equal(plan.current, true);
  assert.equal(plan.record.costs.landed, 0); assert.equal(plan.record.costs.handling, null);
  assert.deepEqual(plan.record.basis, basis()); assert.equal(plan.record.actor.role, 'owner');
  assert.deepEqual(plan.historyEvent.changedFields, ['sourceBasis']); assert.equal(plan.historyEvent.before.sourceBasis, null);
  assert.equal(plan.record.previousId, null); assert.equal(plan.economics.marginFloor, 20);
  assert.deepEqual(state, before); assert.equal(context(state).costs.handling, null);
  assert.match(context(state).notice, /mutable owner\/admin attestations/);
  plan.economics.sourceBasis.basis.sources[0].identifier = 'Changed output';
  assert.equal(plan.record.basis.sources[0].identifier, 'INV-2026-001');
});

test('review context includes an exact detached raw cost snapshot for response consistency', () => {
  const state = seed(); state.economics[SELECTOR.sku].supplierVatRecoverable = false;
  const value = context(state), expected = { landed: 0, packing: '0.25', handling: null, delivery: '', supplierVatRecoverable: false };
  assert.deepEqual(value.costSnapshot, expected);
  assert.equal(value.costs.packing, 0.25); assert.equal(value.costs.delivery, null);
  assert.deepEqual(prepare(state, { ...SELECTOR, sourceRevision: value.sourceRevision, requestId: crypto.randomUUID(), basis: basis() }).record.costs, value.costSnapshot);
  value.costSnapshot.packing = '99';
  assert.equal(state.economics[SELECTOR.sku].packing, '0.25');
  assert.equal(Object.hasOwn(value.costSnapshot, 'marginFloor'), false);
  assert.equal(Object.hasOwn(value.costSnapshot, 'advertising'), false);
});

test('fresh state revalidates exact owner/admin, scope, active/password state and session', async t => {
  for (const [name, mutate, actor] of [
    ['member', s => { s.users[0].role = 'member'; }], ['viewer', s => { s.users[0].role = 'viewer'; }],
    ['inactive', s => { s.users[0].active = false; }], ['truthy active', s => { s.users[0].active = 'yes'; }],
    ['password reset required', s => { s.users[0].passwordChangeRequired = true; }], ['session changed', s => { s.users[0].sessionVersion++; }],
    ['duplicate user', s => { s.users.push({ ...s.users[0] }); }], ['foreign user', s => { s.users[0].workspaceId = 'foreign'; }],
    ['foreign actor', () => {}, { ...ACTOR, workspaceId: 'foreign' }], ['forged role', () => {}, { ...ACTOR, role: 'owner' }]
  ]) await t.test(name, () => { const state = seed(), request = input(state); mutate(state); assert.throws(() => prepare(state, request, actor ?? ACTOR)); });
  const state = seed(); state.users[0].role = 'admin'; assert.equal(prepare(state).record.actor.role, 'admin');
});

test('unique canonical Shopify product and variant IDs, SKU and workspace scope are mandatory', async t => {
  const mutations = {
    duplicateProduct: s => s.products.push({ ...s.products[0], variants: [] }),
    duplicateVariant: s => s.products[0].variants.push({ ...s.products[0].variants[0], sku: 'OTHER' }),
    duplicateSku: s => s.products.push({ id: 'gid://shopify/Product/102', provider: 'shopify', variants: [{ id: 'gid://shopify/ProductVariant/202', sku: SELECTOR.sku }] }),
    whitespaceAlias: s => s.products[0].variants.push({ id: 'gid://shopify/ProductVariant/202', sku: ` ${SELECTOR.sku} ` }),
    foreignProduct: s => { s.products[0].workspace_id = 'foreign'; },
    nestedForeignVariant: s => { s.products[0].variants[0].metadata = { tenant: { id: 'foreign' } }; },
    otherProvider: s => { s.products[0].provider = 'ebay'; },
    wrongExternalId: s => { s.products[0].variants[0].externalId = '201'; },
    wrongProduct: s => { s.products[0].variants[0].productId = 'gid://shopify/Product/999'; },
    wrongConnection: s => { s.products[0].connectionId = 'another'; },
    wrongAccount: s => { s.products[0].accountId = 'gid://shopify/Shop/2'; },
    unknownCostRecord: s => { delete s.economics[SELECTOR.sku]; },
    foreignEconomics: s => { s.economics[SELECTOR.sku].tenantId = 'foreign'; },
    foreignRoot: s => { s.tenantId = 'foreign'; }
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => { const state = seed(), request = input(state); mutate(state); assert.throws(() => prepare(state, request)); });
  for (const selector of [{ ...SELECTOR, productId: '101' }, { ...SELECTOR, variantId: 'gid://shopify/Product/201' }, { ...SELECTOR, sku: ' CUP-1' }]) assert.throws(() => costSourceReviewContext(seed(), selector, ACTOR));
});

test('one saved account binds attestations without granting provider authority or reading credentials', () => {
  const state = seed(); let credentialCalls = 0;
  state.connections[0].encryptedCredentials = new Proxy({}, { ownKeys() { credentialCalls++; throw new Error('credential traversal'); }, get() { credentialCalls++; throw new Error('credential read'); } });
  state.users[0].passwordHash = state.connections[0].encryptedCredentials;
  const original = context(state).sourceRevision;
  state.connections[0].status = 'disconnected'; state.connectionSettings.shopify.disconnected = true;
  state.connections[0].metadata.grantedScopes = [];
  assert.equal(context(state).sourceRevision, original);
  assert.equal(prepare(state).record.target.account, 'cost-fixture.myshopify.com');
  assert.equal(credentialCalls, 0);
  state.connections.push({ ...state.connections[0], id: 'second-shop' });
  assert.throws(() => context(state), error => error.code === 'COST_SOURCE_ACCOUNT_UNAVAILABLE');
});

test('account absence/conflict refuses new review and changing saved identity invalidates open input', () => {
  for (const change of [s => { s.connections = []; }, s => { delete s.connections[0].metadata.shopDomain; },
    s => { s.connections[0].metadata.shopId = 'gid://shopify/Shop/2'; }, s => { s.connections[0].metadata.workspaceId = 'foreign'; }]) {
    const state = seed(); change(state); assert.throws(() => context(state));
  }
  for (const field of ['connection', 'domain', 'accountId']) {
    const state = seed(), request = input(state);
    if (field === 'connection') state.connections[0].id += '-new';
    if (field === 'domain') state.connections[0].metadata.shopDomain = 'other.myshopify.com';
    if (field === 'accountId') state.connections[0].metadata.accountId = 'gid://shopify/Shop/2';
    assert.throws(() => prepare(state, request), error => error.code === 'COST_SOURCE_STALE');
  }
});

test('no getters, proxy traps, inherited fields or toJSON code execute through review input', () => {
  let calls = 0;
  const getter = { get() { calls++; throw new Error('getter'); }, enumerable: true };
  for (const make of [
    s => { Object.defineProperty(s.products[0], 'title', getter); return input(s); },
    s => { Object.defineProperty(s.economics[SELECTOR.sku], 'landed', getter); return input(s); },
    s => { const value = input(s); Object.defineProperty(value.basis.sources[0], 'identifier', getter); return value; },
    s => { s.products = new Proxy(s.products, { get() { calls++; throw new Error('trap'); } }); return input(s); },
    s => { const value = input(s); return new Proxy(value, { getPrototypeOf() { calls++; throw new Error('trap'); } }); },
    s => { const value = input(s); value.basis = Object.assign(Object.create({ currency: null }), value.basis); return value; },
    s => { s.economics[SELECTOR.sku].toJSON = () => { calls++; return {}; }; return input(s); }
  ]) { const state = seed(); assert.throws(() => prepare(state, make(state))); }
  assert.equal(calls, 0);
});

test('safe source identifiers, exact supported inputs and real calendar dates are required', async t => {
  for (const bad of ['https://example.com/invoice', 'www.example.com', 'person@example.com', 'example.com', 'A\nB', 'A: B', 'A'.repeat(81), ' only-space ', '---', '£50']) {
    await t.test(JSON.stringify(bad), () => { const state = seed(); assert.throws(() => prepare(state, input(state, basis(bad)))); });
  }
  for (const change of [
    b => { b.currency = 'gbp'; }, b => { b.taxBasis = 'tax-free'; }, b => { b.effectiveFrom = '2026-02-30'; },
    b => { b.effectiveFrom = '2026-10-12'; b.effectiveUntil = '2026-10-11'; }, b => { b.sources[0].issuedOn = '2025-02-29'; },
    b => { b.sources[0].component = 'marginFloor'; }, b => { b.sources.push({ ...b.sources[0] }); },
    b => { b.sources = []; }, b => { b.sources[0].body = 'full invoice'; }, b => { b.evidenceVerified = true; }
  ]) { const state = seed(), source = basis(); change(source); assert.throws(() => prepare(state, input(state, source))); }
  const state = seed(), source = basis('INV #12 (A)/2026.10_1'); source.currency = 'GBP'; source.effectiveFrom = '2024-02-29'; source.effectiveUntil = '2026-12-31';
  assert.equal(prepare(state, input(state, source)).record.basis.currency, 'GBP');
});

test('sources require explicit finite saved components and never infer missing amounts or margin floors', () => {
  for (const bad of [null, '', '  ', '0x10', 'Infinity', 'NaN', '1e309']) {
    const state = seed(); state.economics[SELECTOR.sku].landed = bad;
    assert.equal(context(state).costs.landed, null);
    assert.throws(() => prepare(state), error => error.code === 'COST_SOURCE_COST_UNKNOWN');
  }
  for (const invalid of [false, true, {}, [], Infinity, NaN]) {
    const state = seed(); state.economics[SELECTOR.sku].landed = invalid; assert.throws(() => context(state));
  }
  for (const explicit of [0, '0', ' .0 ', '-0', '-2.5', 1e20]) {
    const state = seed(); state.economics[SELECTOR.sku].landed = explicit;
    assert.equal(prepare(state).record.costs.landed, explicit);
  }
});

test('cost/source/account changes are stale while unrelated holds and JSONB key order are not', () => {
  const state = seed(), request = input(state), initial = context(state).sourceRevision;
  state.economics[SELECTOR.sku].notes = 'Another ordinary note'; state.economics[SELECTOR.sku].marginFloor = 45;
  state.businessObjectives[0].limits.spend = 1;
  assert.equal(context(state).sourceRevision, initial);
  assert.equal(context(reordered(state)).sourceRevision, initial);
  const plan = prepare(reordered(state), reordered(request)); apply(state, plan);
  assert.equal(context(reordered(state)).current.stale, false);
  const open = input(state, basis('INV-NEW'));
  state.economics[SELECTOR.sku].landed = '0';
  assert.equal(context(state).current.stale, true); assert.deepEqual(context(state).current.staleReasons, ['saved_costs_changed']);
  assert.throws(() => prepare(state, open), error => error.code === 'COST_SOURCE_STALE');
  const next = prepare(state, input(state, basis('INV-NEW'))); assert.equal(next.record.costs.landed, '0'); assert.equal(next.record.previousId, plan.record.id);
});

test('correction chain retains full records and exact replay/no-op never adds history', () => {
  const state = seed(), firstInput = input(state), first = prepare(state, firstInput); apply(state, first);
  assert.equal(prepare(state, firstInput).duplicate, true); assert.equal(prepare(state, firstInput).current, true);
  const noOp = prepare(state, input(state)); assert.equal(noOp.duplicate, true); assert.equal(noOp.historyEvent, null);
  const second = prepare(state, input(state, basis('CORRECTION-2'))); apply(state, second);
  assert.deepEqual(second.historyEvent.before, { sourceBasis: first.record.id }); assert.equal(state.costHistory.length, 2);
  const replay = prepare(state, reordered(firstInput)); assert.equal(replay.duplicate, true); assert.equal(replay.current, false);
  assert.equal(replay.economics.sourceBasis.id, second.record.id); assert.equal(replay.historyEvent, null);
  assert.deepEqual(context(state).history.map(record => record.id), [second.record.id, first.record.id]);
  state.economics[SELECTOR.sku].landed = 1;
  const staleReplay = prepare(state, firstInput); assert.equal(staleReplay.current, false); assert.equal(staleReplay.economics.landed, 1);
});

test('UUID replay is case-normalized and conflicting request/body/actor cannot be reused', () => {
  const state = seed(), request = input(state), result = prepare(state, request); apply(state, result);
  assert.equal(prepare(state, { ...request, requestId: request.requestId.toUpperCase() }).duplicate, true);
  assert.throws(() => prepare(state, { ...request, basis: basis('DIFFERENT') }), error => error.code === 'COST_SOURCE_REQUEST_CONFLICT');
  assert.throws(() => prepare(state, { ...request, sourceRevision: 'a'.repeat(64) }), error => error.code === 'COST_SOURCE_REQUEST_CONFLICT');
  assert.throws(() => prepare(state, { ...request, requestId: result.record.id }));
  state.users.push({ ...state.users[0], id: 'other-owner' });
  assert.throws(() => prepare(state, request, { ...ACTOR, userId: 'other-owner' }), error => error.code === 'COST_SOURCE_REQUEST_CONFLICT');
});

test('malformed, forged, missing, reordered or duplicate retained corrections fail closed', async t => {
  const original = seed(); apply(original, prepare(original)); apply(original, prepare(original, input(original, basis('SECOND'))));
  const mutations = {
    noHistory: s => { s.costHistory = []; }, missingFirst: s => { s.costHistory.pop(); },
    reversed: s => { s.costHistory.reverse(); }, duplicate: s => { s.costHistory.push(structuredClone(s.costHistory[0])); },
    forgedId: s => { s.economics[SELECTOR.sku].sourceBasis.id = `cost_source_${crypto.randomUUID()}`; },
    forgedBasis: s => { s.costHistory[0].after.sourceBasis.basis.sources[0].identifier = 'FORGED'; },
    missingLatest: s => { delete s.economics[SELECTOR.sku].sourceBasis; },
    foreign: s => { s.costHistory[0].after.sourceBasis.target.workspaceId = 'foreign'; },
    wrongBefore: s => { s.costHistory[0].before.sourceBasis = null; },
    wrongChangedFields: s => { s.costHistory[0].changedFields.push('landed'); },
    wrongReviewer: s => { s.costHistory[0].changedBy = 'other'; },
    dangerousRequestId: s => { s.costHistory[0].after.sourceBasis.requestId = { toString() { assert.fail('coercion ran'); } }; }
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => { const state = structuredClone(original); mutate(state); assert.throws(() => context(state)); });
});

test('exact retained history stays visible but unwritable when current account or catalogue is unavailable', () => {
  for (const change of [s => { s.products = []; }, s => { s.connections = []; }, s => { s.products[0].variants.push({ id: 'gid://shopify/ProductVariant/202', sku: SELECTOR.sku }); }]) {
    const state = seed(), request = input(state); apply(state, prepare(state, request)); change(state);
    const value = context(state); assert.equal(value.writable, false); assert.equal(value.sourceRevision, null);
    assert.equal(value.costSnapshot, null);
    assert.equal(value.current.stale, true); assert.deepEqual(value.current.staleReasons, ['target_unavailable']);
    assert.ok(Object.values(value.costs).every(value => value === null)); assert.equal(value.history.length, 1);
    assert.throws(() => prepare(state, request));
    assert.throws(() => costSourceReviewContext(state, { ...SELECTOR, variantId: 'gid://shopify/ProductVariant/999' }, ACTOR));
  }
});

test('actual UTF-8 2 KiB record and 64 KiB retained material budgets fail without pruning', () => {
  const large = seed(), source = basis();
  for (const component of COST_SOURCE_COMPONENTS) large.economics[SELECTOR.sku][component] = 1;
  source.sources = COST_SOURCE_COMPONENTS.map(component => ({ component, kind: 'invoice', identifier: 'I'.repeat(80), issuedOn: '2026-10-01' }));
  assert.throws(() => prepare(large, input(large, source)), error => error.code === 'COST_SOURCE_REVIEW_TOO_LARGE');
  assert.equal(large.costHistory.length, 0);
  const state = seed(); let blocked = false, priorBytes = 0;
  for (let index = 0; index < 100; index++) {
    const before = structuredClone(state), nextInput = input(state, basis(`CORRECTION-${index}`));
    try {
      const plan = prepare(state, nextInput); assert.ok(Buffer.byteLength(JSON.stringify(plan.record)) <= COST_SOURCE_REVIEW_MAX_BYTES); apply(state, plan);
      const expectedBytes = Buffer.byteLength(JSON.stringify({ latest: [state.economics[SELECTOR.sku].sourceBasis], history: state.costHistory }));
      assert.equal(context(state).budget.retainedBytes, expectedBytes); assert.ok(expectedBytes > priorBytes); priorBytes = expectedBytes;
    } catch (error) { assert.equal(error.code, 'COST_SOURCE_HISTORY_FULL'); assert.deepEqual(state, before); blocked = true; break; }
  }
  assert.equal(blocked, true); assert.ok(state.costHistory.length > 10); assert.ok(priorBytes <= COST_SOURCE_HISTORY_MAX_BYTES);
  assert.ok(context(state).history.some(record => record.basis.sources[0].identifier === 'CORRECTION-0'));
});

test('multibyte saved identities count UTF-8 bytes rather than JavaScript code units', () => {
  const state = seed(), sku = '界'.repeat(150), selected = { ...SELECTOR, sku };
  state.products[0].variants[0].sku = sku; state.economics[sku] = state.economics[SELECTOR.sku]; delete state.economics[SELECTOR.sku];
  let rejected = false;
  for (let count = 1; count <= 6; count++) {
    const source = basis(); source.sources = COST_SOURCE_COMPONENTS.slice(0, count).map(component => ({ component, kind: 'invoice', identifier: 'I'.repeat(80), issuedOn: null }));
    for (const component of COST_SOURCE_COMPONENTS) state.economics[sku][component] = 0;
    try { const result = prepare(state, input(state, source, selected)); assert.ok(Buffer.byteLength(JSON.stringify(result.record)) <= 2048); }
    catch (error) { assert.equal(error.code, 'COST_SOURCE_REVIEW_TOO_LARGE'); rejected = true; break; }
  }
  assert.equal(rejected, true);
});

test('retention accounting and UUID collision checks span every SKU in the workspace', () => {
  const state = seed(), second = { productId: PRODUCT, variantId: 'gid://shopify/ProductVariant/202', sku: 'CUP-2' };
  state.products[0].variants.push({ id: second.variantId, sku: second.sku }); state.economics[second.sku] = { landed: 2 };
  const firstRequest = input(state), first = prepare(state, firstRequest); apply(state, first);
  const secondRequest = input(state, basis('SECOND-SKU'), second), secondPlan = prepare(state, secondRequest); apply(state, secondPlan);
  const expected = Buffer.byteLength(JSON.stringify({ latest: Object.values(state.economics).map(row => row.sourceBasis), history: state.costHistory }));
  assert.equal(context(state).budget.retainedBytes, expected);
  assert.equal(costSourceReviewContext(state, second, ACTOR).budget.retainedBytes, expected);
  assert.throws(() => prepare(state, { ...input(state, basis('SECOND-SKU'), second), requestId: firstRequest.requestId }), error => error.code === 'COST_SOURCE_REQUEST_CONFLICT');
  assert.equal(context(state).history.length, 1); assert.equal(costSourceReviewContext(state, second, ACTOR).history.length, 1);
});

test('retained catalogue accepts 500 products and 50,000 variants then fails above either bound', () => {
  const state = seed();
  state.products = Array.from({ length: 500 }, (_, p) => ({ id: `gid://shopify/Product/${p + 1000}`, provider: 'shopify',
    variants: Array.from({ length: 100 }, (_, v) => ({ id: `gid://shopify/ProductVariant/${p * 100 + v + 1000}`, sku: `SKU-${p}-${v}` })) }));
  const selected = { productId: state.products[0].id, variantId: state.products[0].variants[0].id, sku: state.products[0].variants[0].sku };
  state.economics[selected.sku] = { landed: 0 };
  assert.equal(costSourceReviewContext(state, selected, ACTOR).costs.landed, 0);
  state.products[499].variants.push({ id: 'gid://shopify/ProductVariant/999999', sku: 'OVER' });
  assert.throws(() => costSourceReviewContext(state, selected, ACTOR), error => error.code === 'COST_SOURCE_SCAN_LIMIT');
  state.products[499].variants.pop(); state.products.push({ id: 'gid://shopify/Product/999999', provider: 'shopify', variants: [] });
  assert.throws(() => costSourceReviewContext(state, selected, ACTOR), error => error.code === 'COST_SOURCE_SCAN_LIMIT');
});

test('generic DTOs remove source identifiers without changing ordinary fields or input', () => {
  const state = seed(); apply(state, prepare(state));
  const ordinary = { id: 'ordinary-1', sku: SELECTOR.sku, changedBy: ACTOR.userId, changedFields: ['landed'], before: { landed: null }, after: { landed: 0 }, createdAt: NOW.toISOString() };
  state.costHistory.push(ordinary);
  const before = structuredClone(state), economics = publicEconomicsSources(state.economics), history = publicCostSourceHistory(state.costHistory);
  assert.deepEqual(economics, { [SELECTOR.sku]: before.economics[SELECTOR.sku] && { landed: 0, packing: '0.25', handling: null, delivery: '', notes: 'Keep this ordinary cost note', marginFloor: 20 } });
  assert.deepEqual(history, [ordinary]); assert.deepEqual(state, before);
  const mixed = [{ ...ordinary, changedFields: ['sourceBasis', 'landed'], before: { landed: null, sourceBasis: 'private-id' }, after: { landed: 0, sourceBasis: { identifier: 'PRIVATE' } } }];
  const clean = publicCostSourceHistory(mixed); assert.deepEqual(clean[0].changedFields, ['landed']); assert.deepEqual(clean[0].after, { landed: 0 });
  assert.ok(!JSON.stringify([economics, history, clean]).includes('INV-2026'));
  for (const sku of ['TOKEN-BOX', 'password', 'secret', 'APIKEY-GIFT', 'sourceBasis']) {
    const ordinary = { [sku]: { landed: 0, notes: 'An ordinary saved text field', sourceBasis: { identifier: 'PRIVATE' } } };
    assert.deepEqual(publicEconomicsSources(ordinary), { [sku]: { landed: 0, notes: 'An ordinary saved text field' } });
  }
});

test('product diagnostic sidecar is bounded, contains no history and degrades safely', () => {
  const state = seed(); apply(state, prepare(state));
  let sidecar = productCostSourceReviews(state, PRODUCT, ACTOR, { now: NOW });
  assert.equal(sidecar.available, true); assert.equal(sidecar.reviews[0].status, 'current'); assert.equal(sidecar.reviews[0].basis.sources[0].identifier, 'INV-2026-001');
  assert.ok(!JSON.stringify(sidecar).includes('requestDigest')); assert.ok(!JSON.stringify(sidecar).includes('history'));
  state.economics[SELECTOR.sku].landed = 2;
  sidecar = productCostSourceReviews(state, PRODUCT, ACTOR); assert.equal(sidecar.reviews[0].status, 'stale');
  assert.equal(productCostSourceReviews(state, PRODUCT, { ...ACTOR, workspaceId: 'foreign' }).available, false);
  state.products[0].variants = Array.from({ length: 101 }, (_, index) => ({ id: `gid://shopify/ProductVariant/${index + 500}`, sku: `SKU-${index}` }));
  sidecar = productCostSourceReviews(state, PRODUCT, ACTOR); assert.equal(sidecar.available, false); assert.deepEqual(sidecar.reviews, []);
});

test('unsupported sibling references make only the optional whole-product sidecar unavailable', () => {
  for (const variant of [{ id: VARIANT, sku: '' }, { id: VARIANT, sku: ' CUP-1 ' }, { id: '201', sku: SELECTOR.sku },
    { id: 'gid://shopify/Product/201', sku: SELECTOR.sku }]) {
    const state = seed(); state.products[0].variants = [variant];
    const before = structuredClone(state), result = productCostSourceReviews(state, PRODUCT, ACTOR);
    assert.equal(result.available, false); assert.equal(result.code, 'COST_SOURCE_TARGET_INVALID'); assert.deepEqual(result.reviews, []);
    assert.deepEqual(state, before);
  }
});

test('sidecar enforces actual output bytes without truncating the saved source records', () => {
  const state = seed();
  state.products[0].variants = Array.from({ length: 100 }, (_, index) => ({ id: `gid://shopify/ProductVariant/${index + 500}`, sku: `SKU-${index}-${'X'.repeat(145)}` }));
  state.economics = {};
  for (const variant of state.products[0].variants) state.economics[variant.sku] = { landed: 0 };
  const variant = state.products[0].variants[0], selected = { productId: PRODUCT, variantId: variant.id, sku: variant.sku };
  apply(state, prepare(state, input(state, basis(), selected)));
  const before = structuredClone(state), sidecar = productCostSourceReviews(state, PRODUCT, ACTOR);
  assert.equal(sidecar.available, false); assert.equal(sidecar.code, 'COST_SOURCE_PROJECTION_TOO_LARGE'); assert.deepEqual(sidecar.reviews, []);
  assert.deepEqual(state, before); assert.equal(state.costHistory.length, 1);
});
