// Entirely invented tenant, references, products, holds and weights. This is not
// a copy, redaction or encoding of any real catalogue or business evidence.
export function wholesalePlanningFixture() {
  return {
    workspaceId: 'synthetic-workspace', source: 'synthetic_fixture',
    catalogue: { hasNextPage: false, products: [
      { prefix: 'synthetic-alpha', productRef: 'synthetic-product-alpha', existingPackUnits: [10, 20], holds: [] },
      { prefix: 'synthetic-beta', productRef: 'synthetic-product-beta', existingPackUnits: [10, 20], holds: ['synthetic-size-conflict'] }
    ] },
    packingPlan: { prefix: 'synthetic-alpha', units: 500,
      measurement: { prefix: 'synthetic-alpha', scope: 'components', basis: 'measured', units: 10, grams: 240, includes: ['pouches', 'bands'] },
      additions: [] }
  };
}
