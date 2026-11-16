import { parcel2GoCanonicalJson as json } from './parcel2go-live-canonical.mjs';
import { assertShopifySourceScope } from './shopify-order-source.mjs';

const parts = ['pouches', 'bands', 'outer'];
const positive = x => Number.isSafeInteger(x) && x > 0 && x <= 1000000;
const synthetic = x => typeof x === 'string' && /^synthetic-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x) && x.length <= 100;
const fail = code => { throw new Error(code); };
const exact = (x, keys) => {
  if (!x || Array.isArray(x) || typeof x !== 'object' || Object.keys(x).sort().join('|') !== keys.split(' ').sort().join('|')) fail('planning_shape');
};
function scope(x, workspaceId) {
  if (!x || typeof x !== 'object') return;
  if (!Array.isArray(x)) assertShopifySourceScope(x, workspaceId);
  for (const value of Object.values(x)) scope(value, workspaceId);
}
const result = (status, blockers, proposals = [], packing = null) => ({
  schema: 'runvara-wholesale-planning-fixture/v1', status, blockers, proposals, packing,
  planningOnly: true, synthetic: true, sourceVerified: false, packingVerified: false,
  quoteEvidence: null, quoteReady: false, variantCreationAllowed: false, bookingAllowed: false, liveReady: false
});

// Unmounted synthetic-fixture calculations only. The host must supply invented
// fixtures, never relabel real catalogue or packing data as synthetic. Prefixes
// distinguish fixture references; they do not authenticate a caller or source.
export function reviewWholesalePlanningFixture(packet, { mode = 'disabled/v1', workspaceId } = {}) {
  if (mode === 'disabled/v1') return result('disabled', ['disabled']);
  if (mode !== 'offline-fixture/v1') return result('blocked', ['planning_mode']);
  try {
    const input = JSON.parse(json(packet));
    if (!synthetic(workspaceId) || input.workspaceId !== workspaceId) return result('blocked', ['planning_scope']);
    scope(input, workspaceId);
    exact(input, 'workspaceId source catalogue packingPlan');
    if (input.source !== 'synthetic_fixture') fail('planning_source');
    const c = input.catalogue;
    exact(c, 'hasNextPage products');
    if (c.hasNextPage !== false || !Array.isArray(c.products) || !c.products.length || c.products.length > 100) fail('catalogue_coverage');
    const seen = new Set(), refs = new Set(), proposals = [];
    for (const row of c.products) {
      exact(row, 'prefix productRef existingPackUnits holds');
      if (!synthetic(row.prefix) || seen.has(row.prefix) || refs.has(row.productRef) || !synthetic(row.productRef)) fail('catalogue_mapping');
      if (!Array.isArray(row.existingPackUnits) || row.existingPackUnits.length > 100 ||
          !row.existingPackUnits.every(positive) || new Set(row.existingPackUnits).size !== row.existingPackUnits.length ||
          row.existingPackUnits.some(units => units === 500 || units === 1000)) fail('catalogue_existing_variant');
      if (!Array.isArray(row.holds) || row.holds.length > 10 || row.holds.some(hold => !synthetic(hold)) ||
          new Set(row.holds).size !== row.holds.length) fail('catalogue_holds');
      seen.add(row.prefix); refs.add(row.productRef);
      for (const units of [500, 1000]) proposals.push({ workspaceId, productRef: row.productRef,
        proposedSku: `${row.prefix}-${units}`, units, variantId: null, created: false,
        inventory: null, pricePence: null, priceStatus: 'HOLD', deliveryPolicy: 'wholesale_review_required', holds: row.holds });
    }
    const p = input.packingPlan;
    exact(p, 'prefix units measurement additions');
    if (!seen.has(p.prefix) || !positive(p.units)) fail('packing_selection');
    const m = p.measurement;
    exact(m, 'prefix scope basis units grams includes');
    if (m.prefix !== p.prefix) fail('packing_product_binding');
    if (!['components', 'whole_package'].includes(m.scope) || !['measured', 'estimated'].includes(m.basis) ||
        !positive(m.units) || !positive(m.grams) || !Array.isArray(m.includes) || !m.includes.includes('pouches') ||
        m.includes.some(part => !parts.includes(part)) || new Set(m.includes).size !== m.includes.length ||
        !Array.isArray(p.additions) || p.additions.length > 2) fail('packing_measurement');
    const blockers = ['synthetic_fixture_only', 'wholesale_variants_not_created', 'prices_on_hold',
      'tax_review_required', 'actual_carrier_cost_required', 'wholesale_freight_policy_required',
      ...c.products.find(row => row.prefix === p.prefix).holds];
    if (p.units >= 2000) blockers.push('2000_plus_units_quotation_required');
    let packing;
    if (m.scope === 'whole_package') {
      // A complete package already contains its tare; do not scale retail gross.
      if (m.units !== p.units || !m.includes.includes('outer')) fail('whole_package_scope');
      if (p.additions.length) fail('packing_tare_double_count');
      if (m.basis !== 'measured') blockers.push('estimated_package_mass');
      packing = { scope: m.scope, basis: m.basis, units: p.units, fixturePackageGrams: m.grams,
        componentSumGrams: null, includes: m.includes, dimensionsMm: null };
    } else {
      // Outer packaging cannot be scaled as if it were part of each unit group.
      if (m.includes.includes('outer')) fail('component_scope');
      const scaled = m.grams * p.units / m.units;
      if (!Number.isSafeInteger(scaled) || scaled <= 0 || scaled > 1e12) fail('component_scaling');
      const included = new Set(m.includes); let sum = scaled;
      for (const addition of p.additions) {
        exact(addition, 'part units grams basis');
        if (addition.units !== p.units) fail('packing_addition_scope');
        if (!['bands', 'outer'].includes(addition.part) || !positive(addition.grams) ||
            !['measured', 'estimated'].includes(addition.basis)) fail('packing_addition');
        if (included.has(addition.part)) fail('packing_tare_double_count');
        included.add(addition.part); sum += addition.grams;
      }
      blockers.push('whole_package_measurement_required');
      if (m.basis === 'estimated' || p.additions.some(row => row.basis === 'estimated')) blockers.push('estimated_component_mass');
      const missing = ['pouches', 'outer'].filter(part => !included.has(part));
      if (missing.length) blockers.push('packing_components_missing');
      packing = { scope: m.scope, basis: 'component_arithmetic_only', units: p.units,
        scaledComponentGrams: scaled, scaledIncludes: m.includes, additions: p.additions,
        componentSumGrams: sum, missingParts: missing, fixturePackageGrams: null, dimensionsMm: null };
    }
    return result('fixture_planning_only', blockers, proposals, packing);
  } catch (error) {
    const code = error.message;
    return result('blocked', [/^(planning_|catalogue_|packing_|whole_package_|component_)[a-z_]+$/.test(code) ? code : 'planning_input_invalid']);
  }
}
