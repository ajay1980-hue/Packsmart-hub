import { parcel2GoCanonicalJson as json, parcel2GoCanonicalHash as hash } from './parcel2go-live-canonical.mjs';
import { prepareParcel2GoLiveQuotePlan } from './parcel2go-live-quote-plan.mjs';
import { assertShopifySourceScope } from './shopify-order-source.mjs';
import { reviewWholesaleOrderContribution } from './wholesale-order-review.mjs';

const charges = ['base', 'vat', 'fuel', 'collection', 'tailLift', 'residential', 'insurance', 'other'];
const money = x => Number.isSafeInteger(x) && x >= 0 && x <= 1e12;
const positive = x => Number.isSafeInteger(x) && x > 0;
const syntheticRef = x => typeof x === 'string' && /^synthetic[-_.:][a-zA-Z0-9_.:-]{1,100}$/.test(x);
const time = x => typeof x === 'string' && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x ? Date.parse(x) : NaN;
const binding = ({ workspaceId, orderId, revision, sourceReadRef, updatedAt }) => ({ workspaceId, orderId, revision, sourceReadRef, updatedAt });

// Server-held fixture boundary, like existing offline quote foundations. Never
// mount this factory as request JSON admission: no real evidence adapter exists.
export function createWholesaleConsignmentReview({ mode = 'disabled/v1', fixture, now = Date.now } = {}) {
  const result = (blockers, enabled = true) => ({
    schema: 'runvara-wholesale-consignment-review/v1',
    status: !enabled ? 'disabled' : blockers.length ? 'blocked' : 'fixture_checked',
    blockers, synthetic: true, supplierVerified: false, serviceVerified: false,
    quoteRecommendationAllowed: false, bookingAllowed: false, liveReady: false
  });
  if (mode === 'disabled/v1') return Object.freeze({ review: () => result(['disabled'], false) });
  if (mode !== 'offline-fixture/v1') throw new Error('Wholesale consignment live evidence admission unavailable');
  // Detach and pin all facts at trusted-host construction. review accepts state
  // only, so request-supplied verified/approved/evidence replacements add no trust.
  const pinned = JSON.parse(json(fixture));
  let last = null, closed = false;
  return Object.freeze({ review(state) {
    const blockers = [], block = reason => blockers.push(reason);
    try {
      const at = now();
      if (!Number.isSafeInteger(at) || closed || last !== null && at < last) { closed = true; return result(['clock']); }
      last = at;
      const { context, supplier: s, service: q } = pinned;
      const orderReview = reviewWholesaleOrderContribution(state, context);
      if (orderReview.status !== 'recorded_order_review') return result(['order_or_economics', ...orderReview.blockers]);
      const expected = hash(binding(context)), workspaceId = context.workspaceId;
      for (const row of [s, q]) {
        assertShopifySourceScope(row, workspaceId);
        assertShopifySourceScope(row.binding, workspaceId);
        if (hash(row.binding) !== expected || !syntheticRef(row.evidenceRef)) return result(['fixture_binding']);
      }
      if (s.supplier !== 'Europlast' || s.site !== 'Blackburn' || s.collectionMode !== 'direct_courier') block('supplier_collection');
      if (!Number.isFinite(time(s.observedAt)) || time(s.observedAt) > at ||
          !Number.isFinite(time(s.expiresAt)) || time(s.expiresAt) <= at || time(s.expiresAt) <= time(s.observedAt)) block('supplier_validity');
      if (s.packingStatus !== 'packed_ready') block('packing_readiness');
      if (!money(s.preparationCostPence) || !syntheticRef(s.preparationEvidenceRef) ||
          s.preparationCostPence > context.economics.costs.packing.pence + context.economics.costs.handling.pence) block('preparation_cost');
      const order = state.orders.find(row => row.id === context.orderId && row.provider === 'shopify');
      if (!Array.isArray(s.stock) || s.stock.length !== order.lineItems.length || s.stock.length > 100) return result([...blockers, 'stock_mapping']);
      const seen = new Set(), seenSkus = new Set(), packs = [];
      for (const row of s.stock) {
        assertShopifySourceScope(row, workspaceId);
        const lines = order.lineItems.filter(line => line.id === row.lineId && line.sku === row.sku);
        if (seen.has(row.lineId) || seenSkus.has(row.sku) || lines.length !== 1 || !positive(row.packs) || row.packs > 100 ||
            row.packs !== lines[0].quantity || ![500, 1000].includes(row.packUnits)) return result([...blockers, 'stock_mapping']);
        seen.add(row.lineId); seenSkus.add(row.sku);
        if (!Number.isSafeInteger(row.availablePacks) || row.availablePacks < row.packs) block('stock_unavailable');
        if (row.catalogueCode === 'BP3' || /BP3/i.test(row.sku)) block('bp3_size_unresolved');
        if (typeof row.catalogueCode !== 'string' || !/^(BP[1-5]|EP[1-5]|grey_mailer)$/.test(row.catalogueCode)) block('catalogue_mapping');
        packs.push(...Array(row.packs).fill(row.packUnits));
      }
      if (hash(packs.sort()) !== hash([...context.economics.packs].sort())) block('pack_mapping');
      if (s.transportMode !== q.mode) block('consignment_service_mode');
      if (q.mode !== 'parcel') return result([...blockers, 'pallet_or_service_contract_unavailable']);
      assertShopifySourceScope(s.parcel, workspaceId);
      const plan = prepareParcel2GoLiveQuotePlan(q.input, at);
      if (plan.account.workspaceId !== workspaceId || !syntheticRef(plan.account.accountId) || plan.estimate || !syntheticRef(plan.parcel.evidenceId) ||
          hash(s.parcel) !== hash(plan.parcel) || s.collectionPostcode !== plan.route.collectionPostcode) block('packed_measurements');
      if (q.status !== 'quoted' || q.currency !== 'GBP' || !syntheticRef(q.serviceCode) ||
          !Number.isFinite(time(q.observedAt)) || time(q.observedAt) > at ||
          time(q.observedAt) < time(plan.parcel.observedAt) ||
          !Number.isFinite(time(q.expiresAt)) || time(q.expiresAt) <= at || time(q.expiresAt) > Date.parse(plan.expiresAt)) block('quote_validity');
      assertShopifySourceScope(q.charges, workspaceId);
      if (!charges.every(key => money(q.charges[key])) || Object.keys(q.charges).length !== charges.length ||
          !money(q.totalPence) || charges.reduce((sum, key) => sum + q.charges[key], 0) !== q.totalPence ||
          q.totalPence !== context.economics.costs.delivery.pence) block('all_in_shipping_cost');
      assertShopifySourceScope(q.limits, workspaceId);
      if (!['weightGrams', 'lengthMm', 'widthMm', 'heightMm'].every(key => positive(q.limits[key]) && Number(plan.parcel[key]) <= q.limits[key])) block('service_limits');
      assertShopifySourceScope(s.requirements, workspaceId);
      assertShopifySourceScope(q.support, workspaceId);
      for (const key of ['tailLift', 'residential']) {
        if (typeof s.requirements[key] !== 'boolean' || typeof q.support[key] !== 'boolean' || s.requirements[key] && !q.support[key]) block(`service_${key}`);
      }
      if (!money(q.support.insuranceCoverPence) || q.support.insuranceCoverPence < Number(plan.parcel.declaredValueDecimal.replace('.', ''))) block('service_insurance');
      if (![s.readyAt, s.requirements.deliveryBy, q.collectionAt, q.deliveryBy].every(x => Number.isFinite(time(x))) ||
          time(q.collectionAt) < at || time(s.readyAt) > time(q.collectionAt) || time(q.deliveryBy) < time(q.collectionAt) ||
          time(q.deliveryBy) > time(s.requirements.deliveryBy)) block('service_timing');
      return result(blockers);
    } catch { return result(['fixture_evidence_unavailable']); }
  } });
}
