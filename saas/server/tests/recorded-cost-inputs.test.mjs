import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { ECONOMICS_FIELDS, deriveLandedCost, unitEconomics } from '../lib/profit.mjs';

const orderFields = ['actualShippingCost', 'paymentFees', 'channelFees', 'advertisingCost', 'otherVariableCosts'];
const invalid = [' ', '\t\n', false, true, [], [null], [0], ['1'], {}, { value: 0 }, { toString: null, valueOf: 0 }, '0x10', '0b10', '0o10', 'Infinity', 'NaN', '1e309', '1,000', '£1', '1 GBP'];
async function fixture(t, workspaceId = 'packsmart-solutions') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recorded-cost-inputs-'));
  const secret = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(24).toString('hex');
  let providerCalls = 0;
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret,
    SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' },
  { schedulerEnabled: false, agentOpsEnabled: false, fetchImpl: async () => { providerCalls++; assert.fail('Cost entry must not call a provider'); } });
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const { store } = server.packsmart;
  const state = seedWorkspaceState({}, { workspaceId, email: 'owner@example.test', passwordHash: 'synthetic-fixture' });
  state.users[0].passwordChangeRequired = false;
  for (const role of ['admin', 'member', 'viewer']) state.users.push({ ...state.users[0], id: `cost-${role}`, role, email: `${role}@example.test` });
  state.orders = [{ id: 'order-one', provider: 'shopify', currency: 'GBP', createdAt: '2026-01-01T00:00:00.000Z',
    financialStatus: 'PAID', fulfillmentStatus: 'FULFILLED', total: '10', tax: '0', lineItems: [{ sku: 'A', quantity: 1, net: '10' }] }];
  state.economics = { A: { landed: 7, notes: 'Retain this record' } };
  await store.save(workspaceId, state);
  const foreign = seedWorkspaceState({}, { workspaceId: 'foreign-cost-fixture', email: 'foreign@example.test', passwordHash: 'synthetic-fixture' });
  foreign.economics = { A: { landed: 99 } }; await store.save(foreign.workspace.id, foreign);
  let saves = 0; const save = store.save.bind(store); store.save = async (...args) => { saves++; return save(...args); };
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const request = async (target, body, { role = 'owner', sentCsrf = csrf, method = target === '/api/economics' || target.includes('/orders/') ? 'PUT' : 'POST', anonymous = false } = {}) => {
    const user = state.users.find(row => row.role === role);
    const token = createSessionToken({ userId: user.id, workspaceId, email: user.email, role, sessionVersion: 1, csrf }, secret);
    const response = await fetch(`http://127.0.0.1:${server.address().port}${target}`, { method,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': sentCsrf, ...(!anonymous ? { Cookie: `packsmart_session=${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, payload: await response.json() };
  };
  return { store, state, request, counters: () => ({ saves, providerCalls }), save,
    coldSnapshot: () => createStore({ SAAS_STATE_FILE: path.join(directory, 'state.json') }).get(workspaceId),
    snapshot: () => store.get(workspaceId), foreign: () => store.get(foreign.workspace.id) };
}

for (const field of ECONOMICS_FIELDS) test(`catalogue/supplier ${field} rejects ambiguous JSON input before persistence`, async t => {
  const f = await fixture(t); const before = await f.snapshot();
  for (const value of invalid) {
    const result = await f.request('/api/economics', { sku: 'A', economics: { [field]: value } });
    assert.equal(result.status, 400, `${field}: ${JSON.stringify(value)}`); assert.equal(result.payload.code, 'VALIDATION_FAILED');
  }
  assert.equal(f.counters().saves, 0); assert.deepEqual(await f.snapshot(), before); assert.equal(f.counters().providerCalls, 0);
});

test('every order override rejects ambiguous JSON input without changing retained source or overrides', async t => {
  const f = await fixture(t); const before = await f.snapshot();
  for (const field of orderFields) for (const value of invalid) {
    const result = await f.request('/api/orders/order-one/economics', { [field]: value });
    assert.equal(result.status, 400, `${field}: ${JSON.stringify(value)}`); assert.equal(result.payload.code, 'VALIDATION_FAILED');
  }
  assert.equal(f.counters().saves, 0); assert.deepEqual(await f.snapshot(), before);
});

test('advertising spend and optional attributed revenue share the recorded decimal contract', async t => {
  const f = await fixture(t); const before = await f.snapshot();
  for (const field of ['spend', 'attributableRevenue']) for (const value of invalid) {
    const result = await f.request('/api/advertising-costs', { channel: 'meta', spend: 0, [field]: value });
    assert.equal(result.status, 400, `${field}: ${JSON.stringify(value)}`); assert.equal(result.payload.code, 'VALIDATION_FAILED');
  }
  assert.equal(f.counters().saves, 0); assert.deepEqual(await f.snapshot(), before);
  for (const value of [0, '0', '-0', ' .0 ', '+0e2']) {
    const result = await f.request('/api/advertising-costs', { channel: 'meta', spend: value, attributableRevenue: value });
    assert.equal(result.status, 201); assert.equal(result.payload.record.spend, 0); assert.equal(result.payload.record.attributableRevenue, 0);
  }
  for (const value of ['', null, undefined]) {
    const result = await f.request('/api/advertising-costs', { channel: 'meta', spend: 0, attributableRevenue: value });
    assert.equal(result.status, 201); assert.equal(result.payload.record.attributableRevenue, null);
  }
  assert.equal(f.counters().providerCalls, 0);
});

test('valid unit decimals retain precision while order/ad rounding and field limits remain available', async t => {
  const f = await fixture(t);
  for (const value of [0, '0', '-0', ' .0 ', '+0e2', '1.', '.25', ' 2.50 ', '+3e-1']) {
    const catalogue = await f.request('/api/economics', { sku: 'A', economics: { landed: value } });
    assert.equal(catalogue.status, 200); assert.equal(catalogue.payload.economics.landed, Number(value) || 0);
    const order = await f.request('/api/orders/order-one/economics', { actualShippingCost: value });
    assert.equal(order.status, 200); assert.equal(order.payload.order.actualShippingCost, Number(Number(value).toFixed(4)) || 0);
  }
  const rounded = await f.request('/api/economics', { sku: 'A', economics: { landed: '1.23456', supplierVatRecoverable: false } });
  assert.equal(rounded.payload.economics.landed, 1.23456); assert.equal(rounded.payload.economics.supplierVatRecoverable, false);
  const ad = await f.request('/api/advertising-costs', { channel: 'meta', spend: '1.234', attributableRevenue: '+2e1' });
  assert.equal(ad.payload.record.spend, 1.23); assert.equal(ad.payload.record.attributableRevenue, 20);
  for (const value of ['', null]) {
    assert.equal((await f.request('/api/economics', { sku: 'A', economics: { landed: value } })).payload.economics.landed, '');
    assert.equal((await f.request('/api/orders/order-one/economics', { actualShippingCost: value })).payload.order.actualShippingCost, null);
  }
  for (const [field, maximum] of [['landed', 1000000], ['marginFloor', 100], ['supplierVatRate', 100], ['boxQuantity', 100000000]]) {
    assert.equal((await f.request('/api/economics', { sku: 'A', economics: { [field]: maximum } })).status, 200);
    for (const value of [-1, maximum + 1]) assert.equal((await f.request('/api/economics', { sku: 'A', economics: { [field]: value } })).status, 400);
  }
  for (const field of orderFields) for (const value of [-1, 10000001]) assert.equal((await f.request('/api/orders/order-one/economics', { [field]: value })).status, 400);
  for (const body of [{ spend: -1 }, { spend: 10000001 }, { spend: 0, attributableRevenue: -1 }, { spend: 0, attributableRevenue: 100000001 }]) {
    assert.equal((await f.request('/api/advertising-costs', { channel: 'meta', ...body })).status, 400);
  }
  assert.equal((await f.snapshot()).economics.A.notes, 'Retain this record'); assert.equal(f.counters().providerCalls, 0);
});

test('invoice unit costs survive save, cold store read, bootstrap and inventory aggregation', async t => {
  const f = await fixture(t);
  const initial = await f.snapshot();
  initial.products = [{ id: 'p', title: 'Synthetic individual item', status: 'active', variants: [{ id: 'v', sku: 'A', price: 0.1, inventory: 1000 }] }];
  initial.costHistory = [{ id: 'retained-history', sku: 'A', before: { landed: 6 }, after: { landed: 7 }, createdAt: '2026-09-01T00:00:00Z' }];
  await f.save(initial.workspace.id, initial);
  const before = await f.coldSnapshot();
  // Invoice gross already includes its recorded VAT: do not add VAT again.
  const derived = deriveLandedCost({ boxPrice: 20.29, boxQuantity: 1000, supplierDelivery: 0, supplierVatRate: 0, supplierVatRecoverable: false });
  assert.equal(derived.value, 0.02029);
  const result = await f.request('/api/economics', { sku: 'A', economics: { landed: String(derived.value), packing: '0.00001' } });
  assert.equal(result.status, 200);
  assert.equal(result.payload.economics.landed, 0.02029);
  assert.equal(result.payload.economics.packing, 0.00001);
  const saved = await f.coldSnapshot();
  assert.equal(saved.economics.A.landed, 0.02029);
  assert.equal(saved.economics.A.packing, 0.00001);
  assert.equal(saved.economics.A.notes, before.economics.A.notes);
  assert.equal(saved.costHistory[0].before.landed, 7);
  assert.equal(saved.costHistory[0].after.landed, 0.02029);
  assert.deepEqual(saved.costHistory.slice(1), before.costHistory);
  assert.deepEqual(saved.approvals, before.approvals);
  const boot = await f.request('/api/bootstrap', undefined, { method: 'GET' });
  assert.equal(boot.status, 200);
  assert.equal(boot.payload.economics.A.landed, 0.02029);
  assert.equal(Math.round(boot.payload.economics.A.landed * 1000 * 100), 2029);
  assert.equal(boot.payload.dashboard.stockValue, 20.29);
  assert.equal(unitEconomics({ price: 0.1 }, saved.economics.A).contribution, null);
  assert.equal(boot.payload.dashboard.last30d.operatingProfit, null);
  assert.equal((await f.foreign()).economics.A.landed, 99);
  assert.equal(f.counters().providerCalls, 0);
});

test('pack material plus one outer retains five decimals and unknown costs stay blocked', async t => {
  const f = await fixture(t);
  // Integer source oracle: 2029 pence per 1000 physical items = 2029 units of 1e-5 GBP each.
  const physical = 2029n, product = physical * 50n, outer = physical;
  const decimal5 = value => `${value / 100000n}.${String(value % 100000n).padStart(5, '0')}`;
  const response = await f.request('/api/economics', { sku: 'A', economics: { landed: decimal5(product), packing: decimal5(outer) } });
  assert.equal(response.status, 200);
  const record = (await f.coldSnapshot()).economics.A;
  assert.equal(record.landed, 1.0145);
  assert.equal(record.packing, 0.02029);
  // 1000 packs each using 50 items plus one outer: settle only after aggregation.
  assert.equal(Math.round((record.landed + record.packing) * 1000 * 100), Number((product + outer) * 1000n / 1000n));
  assert.equal(Math.round((record.landed + record.packing) * 1000 * 100), 103479);
  const incomplete = unitEconomics({ price: 2.55 }, record);
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.contribution, null);
  assert.equal(incomplete.margin, null);
  assert.equal(incomplete.missingFields.length, 6);
  assert.equal(f.counters().providerCalls, 0);
});

test('saved tiny supplier quantity retains its source but an overflowing derivation stays incomplete', async t => {
  const f = await fixture(t);
  const response = await f.request('/api/economics', { sku: 'A', economics: { landed: '', boxPrice: 1000000,
    boxQuantity: '1e-320', supplierDelivery: 0, supplierVatRate: 0, supplierVatRecoverable: false,
    packing: 0, handling: 0, delivery: 0, paymentFee: 0, channelFee: 0, advertising: 0, otherVariable: 0 } });
  assert.equal(response.status, 200);
  const record = (await f.coldSnapshot()).economics.A;
  assert.equal(record.boxQuantity, 1e-320);
  const row = unitEconomics({ price: 1 }, record);
  assert.equal(row.complete, false);
  assert.equal(row.contribution, null);
  assert.equal(row.margin, null);
  assert.equal(f.counters().providerCalls, 0);
});

test('pilot import validates all costs and rolls back the whole request when a later record is malformed', async t => {
  const f = await fixture(t); const before = await f.snapshot();
  for (const value of invalid) {
    const result = await f.request('/api/migrate-pilot', { migrationId: 'cost-validation', economics: { FIRST: { landed: 1 }, BAD: { packing: value } } });
    assert.equal(result.status, 400, JSON.stringify(value)); assert.equal(result.payload.code, 'VALIDATION_FAILED');
    assert.deepEqual(await f.snapshot(), before, 'No partial economics or migration history may survive');
  }
  assert.equal(f.counters().saves, 0);
  const accepted = await f.request('/api/migrate-pilot', { migrationId: 'cost-validation', economics: { FIRST: { landed: '+.0' }, A: { landed: 0, packing: '2.34567' } } });
  assert.equal(accepted.status, 200);
  const after = await f.snapshot(); assert.equal(after.economics.FIRST.landed, 0); assert.equal(after.economics.A.landed, 7, 'Existing recorded amount is not replaced');
  assert.equal(after.economics.A.packing, 2.34567); assert.ok(after.migrations['cost-validation']);
});

test('cost validation preserves role, CSRF, tenant, session reread and CAS protections', async t => {
  const f = await fixture(t); const before = await f.snapshot(), foreign = await f.foreign();
  const targets = [['/api/economics', { sku: 'A', economics: { landed: 0 } }], ['/api/orders/order-one/economics', { actualShippingCost: 0 }],
    ['/api/advertising-costs', { channel: 'meta', spend: 0 }], ['/api/migrate-pilot', { migrationId: 'denied', economics: { A: { landed: 0 } } }]];
  for (const [target, body] of targets) {
    for (const role of ['member', 'viewer']) assert.equal((await f.request(target, body, { role })).status, 403);
    assert.equal((await f.request(target, body, { sentCsrf: 'invalid' })).status, 403);
    assert.equal((await f.request(target, body, { anonymous: true })).status, 401);
  }
  assert.deepEqual(await f.snapshot(), before); assert.equal(f.counters().saves, 0);
  const admin = await f.request('/api/economics', { sku: 'A', economics: { landed: 0 }, workspaceId: foreign.workspace.id }, { role: 'admin' });
  assert.equal(admin.status, 200); assert.deepEqual(await f.foreign(), foreign);
  const get = f.store.get.bind(f.store); let reads = 0;
  f.store.get = async (...args) => { const state = await get(...args); if (++reads === 2) state.users[0].sessionVersion++; return state; };
  const stale = await f.request('/api/economics', { sku: 'A', economics: { landed: 10 } });
  assert.equal(stale.status, 401); assert.equal(stale.payload.code, 'SESSION_INVALID'); f.store.get = get;
  f.store.save = async () => { throw Object.assign(new Error('Synthetic concurrent state change'), { status: 409, code: 'STATE_CONFLICT' }); };
  const conflict = await f.request('/api/economics', { sku: 'A', economics: { landed: 10 } });
  assert.equal(conflict.status, 409); assert.equal(conflict.payload.code, 'STATE_CONFLICT'); assert.equal((await f.snapshot()).economics.A.landed, 0);
});
