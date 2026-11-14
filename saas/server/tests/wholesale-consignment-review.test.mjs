import assert from 'node:assert/strict';
import test from 'node:test';
import { wholesaleOrderFixture } from './wholesale-fixture.mjs';
import { createWholesaleConsignmentReview as create } from '../lib/wholesale-consignment-review.mjs';

const at = '2026-11-14T12:00:00.000Z', start = Date.parse(at);
// Entirely synthetic host fixtures; these are not supplier or carrier facts.
function fixture() {
  const { state, context } = wholesaleOrderFixture('packsmart-solutions');
  context.economics.costs.landed.pence = 6000;
  context.economics.costs.packing.pence = 50;
  context.economics.costs.delivery.pence = 500;
  const binding = Object.fromEntries(['workspaceId', 'orderId', 'revision', 'sourceReadRef', 'updatedAt'].map(key => [key, context[key]]));
  const parcel = { evidenceId: 'synthetic-measured', provenance: 'measured_packed_parcel', observedAt: at,
    weightGrams: '1000', lengthMm: '200', widthMm: '150', heightMm: '100', declaredValueDecimal: '100.00' };
  const supplier = { binding, evidenceRef: 'synthetic-supplier', supplier: 'Europlast', site: 'Blackburn', collectionMode: 'direct_courier',
    observedAt: at, expiresAt: '2026-11-14T12:05:00.000Z',
    packingStatus: 'packed_ready', transportMode: 'parcel', preparationCostPence: 50, preparationEvidenceRef: 'synthetic-preparation', collectionPostcode: 'AA1 1AA',
    parcel, readyAt: at, requirements: { tailLift: false, residential: true, deliveryBy: '2026-11-16T12:00:00.000Z' },
    stock: [{ lineId: 'line-1', sku: 'existing-fixture-variant', catalogueCode: 'BP1', packUnits: 500, packs: 1, availablePacks: 3 }] };
  const service = { binding, evidenceRef: 'synthetic-service', mode: 'parcel', serviceCode: 'synthetic-parcel', status: 'quoted', currency: 'GBP',
    observedAt: at,
    expiresAt: '2026-11-14T12:05:00.000Z', totalPence: 500,
    charges: { base: 400, vat: 80, fuel: 20, collection: 0, tailLift: 0, residential: 0, insurance: 0, other: 0 },
    limits: { weightGrams: 2000, lengthMm: 500, widthMm: 500, heightMm: 500 }, support: { tailLift: false, residential: true, insuranceCoverPence: 10000 },
    collectionAt: '2026-11-14T13:00:00.000Z', deliveryBy: '2026-11-15T12:00:00.000Z',
    input: { operation: 'quote', account: { workspaceId: context.workspaceId, accountId: 'synthetic-account', environment: 'live', currency: 'GBP',
      collectionVatStatus: 'NotRegistered', deliveryVatStatus: 'NotRegistered', verifiedAt: at }, parcel,
      route: { collectionCountry: 'GBR', deliveryCountry: 'GBR', collectionPostcode: 'AA1 1AA', deliveryPostcode: 'BB1 1BB' } } };
  return { state, context, supplier, service };
}
const run = f => create({ mode: 'offline-fixture/v1', fixture: f, now: () => start }).review(f.state);

test('default disabled; live admission refused; complete fixtures never recommend, book or expose costs', () => {
  assert.equal(create().review({ verified: true }).status, 'disabled');
  assert.throws(() => create({ mode: 'enabled/v1' }), /live evidence admission unavailable/);
  const result = run(fixture());
  assert.equal(result.status, 'fixture_checked');
  assert.equal(result.synthetic, true);
  for (const key of ['supplierVerified', 'serviceVerified', 'quoteRecommendationAllowed', 'bookingAllowed', 'liveReady']) assert.equal(result[key], false);
  assert.deepEqual(Object.keys(result).sort(), ['schema', 'status', 'blockers', 'synthetic', 'supplierVerified', 'serviceVerified', 'quoteRecommendationAllowed', 'bookingAllowed', 'liveReady'].sort());
});

test('host pins facts; user verified flags and later fixture replacements add no authority', () => {
  const f = fixture(); f.supplier.stock[0].availablePacks = 0;
  const review = create({ mode: 'offline-fixture/v1', fixture: f, now: () => start }).review;
  f.supplier.stock[0].availablePacks = 100; f.supplier.verified = true;
  f.state.supplier = { verified: true, stockAvailable: true };
  const before = structuredClone(f.state);
  assert.ok(review(f.state, { verified: true, supplier: f.supplier }).blockers.includes('stock_unavailable'));
  assert.deepEqual(review(f.state), review(f.state));
  assert.deepEqual(f.state, before);
});

test('supplier, service and order must bind to the same tenant/order/revision', () => {
  for (const target of ['supplier', 'service']) for (const change of [{ workspaceId: 'foreign' }, { orderId: 'other-order' }, { revision: 'old' }]) {
    const f = fixture(); f[target].binding = { ...f[target].binding, ...change };
    assert.equal(run(f).status, 'blocked');
  }
  for (const target of ['supplier', 'service', 'stock', 'charges', 'support']) {
    const f = fixture();
    const row = target === 'stock' ? f.supplier.stock[0] : target === 'charges' || target === 'support' ? f.service[target] : f[target];
    row.tenantId = 'foreign'; assert.equal(run(f).status, 'blocked');
  }
  const f = fixture(); f.state._revision = 'new-revision'; assert.equal(run(f).status, 'blocked');
  const g = fixture(); g.context.economics.priceApproval = 'rejected'; assert.equal(run(g).status, 'blocked');
});

test('Europlast Blackburn direct courier collection and packed readiness are mandatory', () => {
  for (const change of [{ supplier: 'other' }, { site: 'other' }, { collectionMode: 'customer_collection' }, { packingStatus: 'unknown' }]) {
    const f = fixture(); Object.assign(f.supplier, change); assert.equal(run(f).status, 'blocked');
  }
});

test('unknown stock, preparation cost, measurements, mapping and BP3 remain blocked', () => {
  for (const change of [f => { delete f.supplier.stock[0].availablePacks; }, f => { f.supplier.stock[0].availablePacks = 0; },
    f => { delete f.supplier.preparationCostPence; }, f => { f.supplier.preparationEvidenceRef = null; f.supplier.preparationCostPence = 0; },
    f => { f.supplier.preparationCostPence = 51; }, f => { f.supplier.expiresAt = at; },
    f => { delete f.supplier.observedAt; }, f => { delete f.supplier.parcel.weightGrams; },
    f => { f.supplier.parcel.provenance = 'owner_authorised_estimate'; }, f => { f.supplier.stock[0].catalogueCode = 'BP3'; },
    f => { f.supplier.stock[0].catalogueCode = 'unknown'; }, f => { f.supplier.stock[0].sku = 'different'; },
    f => { f.supplier.stock[0].packs = 2; }, f => { f.supplier.stock[0].packUnits = 1000; }]) {
    const f = fixture(); change(f); assert.equal(run(f).status, 'blocked');
  }
});

test('pallets stay blocked without a service contract; failed/expired/unknown quotes cannot pass', () => {
  for (const change of [{ mode: 'pallet' }, { status: 'failed' }, { status: 'unknown' }, { expiresAt: at },
    { expiresAt: null }, { observedAt: null }, { currency: 'EUR' }]) {
    const f = fixture(); Object.assign(f.service, change); assert.equal(run(f).status, 'blocked');
  }
  const f = fixture(); f.service.charges.vat = null; assert.ok(run(f).blockers.includes('all_in_shipping_cost'));
  const g = fixture(); g.service.totalPence = 499; assert.ok(run(g).blockers.includes('all_in_shipping_cost'));
});

test('service limits, postcodes, tail-lift, residential, insurance and timing are checked', () => {
  for (const change of [f => { f.service.limits.weightGrams = 999; }, f => { f.supplier.collectionPostcode = 'CC1 1CC'; },
    f => { f.service.input.route.deliveryPostcode = null; }, f => { f.supplier.transportMode = 'pallet'; }, f => { f.supplier.requirements.tailLift = true; },
    f => { f.service.support.residential = false; }, f => { f.service.support.insuranceCoverPence = 9999; },
    f => { f.supplier.readyAt = '2026-11-14T14:00:00.000Z'; }, f => { f.service.deliveryBy = '2026-11-17T12:00:00.000Z'; }]) {
    const f = fixture(); change(f); assert.equal(run(f).status, 'blocked');
  }
});

test('repeated SKU lines cannot each claim the same available stock', () => {
  const f = fixture();
  f.state.orders[0].lineItems.push({ ...f.state.orders[0].lineItems[0], id: 'line-2' });
  f.supplier.stock.push({ ...f.supplier.stock[0], lineId: 'line-2' });
  f.context.economics.packs = [500, 500];
  assert.ok(run(f).blockers.includes('stock_mapping'));
});

test('expiry and clock rollback invalidate repeat reviews without state writes', () => {
  const f = fixture(); let atMs = start;
  const candidate = create({ mode: 'offline-fixture/v1', fixture: f, now: () => atMs });
  assert.equal(candidate.review(f.state).status, 'fixture_checked');
  atMs += 300000; assert.ok(candidate.review(f.state).blockers.includes('quote_validity'));
  atMs = start; assert.deepEqual(candidate.review(f.state).blockers, ['clock']);
});
