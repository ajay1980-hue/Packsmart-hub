import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewWholesalePlanningFixture as review } from '../lib/wholesale-planning.mjs';
import { prepareParcel2GoLiveQuotePlan } from '../lib/parcel2go-live-quote-plan.mjs';
import { wholesalePlanningFixture as fixture } from './wholesale-planning-fixture.mjs';

const options = { mode: 'offline-fixture/v1', workspaceId: 'synthetic-workspace' };
const run = input => review(input, options);
function denied(result) {
  for (const key of ['sourceVerified', 'packingVerified', 'quoteReady', 'variantCreationAllowed', 'bookingAllowed', 'liveReady']) assert.equal(result[key], false);
  assert.equal(result.quoteEvidence, null); assert.equal(result.synthetic, true);
  assert.throws(() => prepareParcel2GoLiveQuotePlan(result, Date.parse('2030-01-01T12:00:00.000Z')));
}
function blocked(input) {
  const result = run(input);
  assert.equal(result.status, 'blocked'); assert.deepEqual(result.proposals, []); assert.equal(result.packing, null); denied(result);
  return result;
}

test('default disabled without reading input; unsupported modes cannot admit fixtures', () => {
  let read = false;
  assert.equal(review({ get workspaceId() { read = true; throw new Error('no'); } }).status, 'disabled');
  assert.equal(read, false);
  for (const mode of ['enabled/v1', 'offline-planning/v1', 'live', true, null]) {
    const result = review(fixture(), { ...options, mode });
    assert.deepEqual(result.blockers, ['planning_mode']); denied(result);
  }
});

test('invented products yield uncreated proposals with no retail IDs, prices or freight assumptions', () => {
  const result = run(fixture());
  assert.equal(result.status, 'fixture_planning_only'); denied(result);
  assert.deepEqual(result.proposals.map(row => [row.proposedSku, row.productRef]), [
    ['synthetic-alpha-500', 'synthetic-product-alpha'], ['synthetic-alpha-1000', 'synthetic-product-alpha'],
    ['synthetic-beta-500', 'synthetic-product-beta'], ['synthetic-beta-1000', 'synthetic-product-beta']
  ]);
  for (const row of result.proposals) {
    assert.equal(row.workspaceId, options.workspaceId);
    assert.equal(row.variantId, null); assert.equal(row.created, false);
    assert.equal(row.inventory, null); assert.equal(row.pricePence, null); assert.equal(row.priceStatus, 'HOLD');
    assert.equal(row.deliveryPolicy, 'wholesale_review_required');
    assert.equal(Object.hasOwn(row, 'productId'), false);
  }
  assert.deepEqual(result.proposals[2].holds, ['synthetic-size-conflict']);
});

test('absent, non-fixture or conflicting workspace and nested scope cannot expose proposals', () => {
  for (const workspaceId of [undefined, '', 'ordinary-workspace', 'synthetic-other']) {
    const result = review(fixture(), { ...options, workspaceId });
    assert.equal(result.status, 'blocked'); assert.deepEqual(result.proposals, []);
  }
  for (const location of ['root', 'catalogue', 'product', 'packing', 'measurement', 'addition']) {
    const p = fixture(); p.packingPlan.additions = [{ part: 'outer', units: 500, grams: 60, basis: 'estimated' }];
    const target = { root: p, catalogue: p.catalogue, product: p.catalogue.products[0], packing: p.packingPlan,
      measurement: p.packingPlan.measurement, addition: p.packingPlan.additions[0] }[location];
    target.tenant = { id: 'synthetic-other' }; blocked(p);
  }
});

test('non-fixture references, retail IDs and source/verification claims cannot enter fixture planning', () => {
  for (const change of [p => { p.catalogue.products[0].prefix = 'ordinary-product'; },
    p => { p.catalogue.products[0].productRef = 'retail-product-reference'; },
    p => { p.catalogue.products[0].variantId = 'synthetic-retail-variant'; },
    p => { p.catalogue.products[0].productId = 'synthetic-product-id'; },
    p => { p.catalogue.products[0].created = true; }, p => { p.source = 'reported_catalogue'; },
    p => { p.verified = true; }, p => { p.packingPlan.measurement.verified = true; }]) {
    const p = fixture(); change(p); blocked(p);
  }
});

test('incomplete, duplicate or already-existing variant mappings fail closed', () => {
  for (const change of [p => { p.catalogue.hasNextPage = true; }, p => { p.catalogue.products = []; },
    p => { p.catalogue.products = Array(101).fill(p.catalogue.products[0]); },
    p => { p.catalogue.products[1].prefix = p.catalogue.products[0].prefix; },
    p => { p.catalogue.products[1].productRef = p.catalogue.products[0].productRef; },
    p => { p.catalogue.products[0].existingPackUnits.push(500); },
    p => { p.catalogue.products[0].existingPackUnits.push(1000); },
    p => { p.catalogue.products[0].existingPackUnits.push(10); },
    p => { p.catalogue.products[0].existingPackUnits = ['10']; },
    p => { p.catalogue.products[0].holds = ['ordinary-hold']; }]) {
    const p = fixture(); change(p); blocked(p);
  }
});

for (const [units, grams] of [[100, 2400], [200, 4800], [500, 12000], [1000, 24000]]) {
  test(`synthetic ${units}-unit component calculation preserves included bands and excludes outer`, () => {
    const p = fixture(); p.packingPlan.units = units;
    const result = run(p); denied(result);
    assert.equal(result.packing.scaledComponentGrams, grams); assert.equal(result.packing.componentSumGrams, grams);
    assert.deepEqual(result.packing.scaledIncludes, ['pouches', 'bands']);
    assert.deepEqual(result.packing.missingParts, ['outer']);
    assert.equal(result.packing.fixturePackageGrams, null); assert.equal(result.packing.dimensionsMm, null);
    assert.ok(result.blockers.includes('whole_package_measurement_required'));
  });
}

test('estimated outer tare remains component arithmetic, never a measured complete package', () => {
  const p = fixture(); p.packingPlan.units = 100;
  p.packingPlan.additions = [{ part: 'outer', units: 100, grams: 60, basis: 'estimated' }];
  const result = run(p); denied(result);
  assert.equal(result.packing.scaledComponentGrams, 2400); assert.equal(result.packing.componentSumGrams, 2460);
  assert.equal(result.packing.fixturePackageGrams, null);
  assert.ok(result.blockers.includes('estimated_component_mass'));
  assert.ok(result.blockers.includes('whole_package_measurement_required'));
});

test('estimated or measured component sums never become verified quote evidence', () => {
  for (const basis of ['measured', 'estimated']) {
    const p = fixture(); p.packingPlan.measurement.basis = basis;
    p.packingPlan.additions = [{ part: 'outer', units: 500, grams: 60, basis }];
    const result = run(p); denied(result);
    assert.equal(result.packing.fixturePackageGrams, null);
    assert.ok(result.blockers.includes('whole_package_measurement_required'));
  }
});

test('included bands and repeated outer additions cannot be counted twice', () => {
  for (const additions of [[{ part: 'bands', units: 500, grams: 12, basis: 'measured' }],
    [{ part: 'outer', units: 500, grams: 60, basis: 'estimated' }, { part: 'outer', units: 500, grams: 60, basis: 'measured' }]]) {
    const p = fixture(); p.packingPlan.additions = additions;
    assert.deepEqual(blocked(p).blockers, ['packing_tare_double_count']);
  }
});

test('whole-package fixtures must cover selected units and outer without scaling or additional tare', () => {
  const p = fixture();
  p.packingPlan.measurement = { prefix: 'synthetic-alpha', scope: 'whole_package', basis: 'measured', units: 500, grams: 13000, includes: ['pouches', 'bands', 'outer'] };
  const result = run(p); denied(result);
  assert.equal(result.packing.fixturePackageGrams, 13000); assert.equal(result.packing.componentSumGrams, null);
  assert.ok(result.blockers.includes('synthetic_fixture_only'));
  const estimate = structuredClone(p); estimate.packingPlan.measurement.basis = 'estimated';
  assert.ok(run(estimate).blockers.includes('estimated_package_mass')); denied(run(estimate));
  for (const change of [q => { q.packingPlan.measurement.units = 10; },
    q => { q.packingPlan.measurement.includes = ['pouches', 'bands']; },
    q => { q.packingPlan.additions = [{ part: 'outer', units: 500, grams: 60, basis: 'estimated' }]; }]) {
    const q = structuredClone(p); change(q); blocked(q);
  }
});

test('fixture holds, quotation-only quantities and financial/freight gates remain closed', () => {
  const p = fixture(); p.packingPlan.units = 2000;
  p.packingPlan.prefix = p.packingPlan.measurement.prefix = 'synthetic-beta';
  const result = run(p); denied(result);
  for (const code of ['synthetic-size-conflict', '2000_plus_units_quotation_required', 'prices_on_hold',
    'tax_review_required', 'actual_carrier_cost_required', 'wholesale_freight_policy_required']) assert.ok(result.blockers.includes(code));
  assert.ok(result.proposals.every(row => [500, 1000].includes(row.units)));
});

test('selected product cannot borrow another fixture product measurement', () => {
  const p = fixture(); p.packingPlan.prefix = 'synthetic-beta';
  assert.deepEqual(blocked(p).blockers, ['packing_product_binding']);
});

test('outer estimate for a smaller quantity cannot be reused for selected units', () => {
  const p = fixture(); p.packingPlan.additions = [{ part: 'outer', units: 100, grams: 60, basis: 'estimated' }];
  assert.deepEqual(blocked(p).blockers, ['packing_addition_scope']);
});

test('malformed measurements and fractional scaling fail closed; accessors never run', () => {
  for (const change of [p => { p.packingPlan.measurement.units = 0; }, p => { p.packingPlan.measurement.grams = '240'; },
    p => { p.packingPlan.measurement.units = 7; }, p => { p.packingPlan.measurement.includes.push('outer'); },
    p => { p.packingPlan.measurement.includes.push('bands'); }, p => { p.packingPlan.measurement.scope = 'net_contents'; }]) {
    const p = fixture(); change(p); blocked(p);
  }
  const p = fixture(); let invoked = false;
  Object.defineProperty(p.packingPlan.measurement, 'grams', { enumerable: true, get() { invoked = true; return 240; } });
  blocked(p); assert.equal(invoked, false);
});

test('fixture review is repeatable and detached; output mutations cannot alter the source', () => {
  const p = fixture(), before = structuredClone(p), first = run(p);
  assert.deepEqual(run(p), first); assert.deepEqual(p, before);
  first.proposals[0].created = true; first.proposals[0].variantId = 'synthetic-invented-variant';
  first.packing.scaledIncludes.push('outer'); first.quoteReady = true;
  const again = run(p); denied(again);
  assert.equal(again.proposals[0].created, false); assert.equal(again.proposals[0].variantId, null);
  assert.deepEqual(p, before);
});
