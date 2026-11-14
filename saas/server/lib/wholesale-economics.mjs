import { REQUIRED_UNIT_COSTS, contributionMeetsMargin } from './profit.mjs';

// Pure, caller-supplied evidence review only. No order/state/provider access.
// Values are whole-consignment GBP pennies, never per-piece catalogue costs.
const validMoney = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e12;

export function reviewWholesaleContribution(input = {}) {
  const result = (status, blockers, extra = {}) => ({
    schema: 'runvara-wholesale-contribution/v1', currency: 'GBP', status, blockers,
    contributionPence: null, marginPercent: null, targetPercent: null,
    bookingAllowed: false, liveReady: false, ...extra
  });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return result('blocked', ['input']);
  const { packs, revenue, costs, vatTreatment } = input;
  if (!Array.isArray(packs) || !packs.length || packs.length > 100 ||
      !Array.from(packs).every(size => size === 500 || size === 1000)) return result('blocked', ['pack_sizes']);
  if (packs.reduce((sum, size) => sum + size, 0) >= 2000) {
    return result('quotation_required', ['2000_plus_units']);
  }
  // Mixed packs use the stricter target pending a separately approved mixed policy.
  const targetPercent = packs.includes(500) ? 32 : 30;
  const blockers = [];
  if (input.currency !== 'GBP') blockers.push('currency');
  if (input.priceApproval !== 'approved') blockers.push('price_approval');
  if (vatTreatment?.verified !== true || vatTreatment.status !== 'not_registered' ||
      vatTreatment.basis !== 'gross_non_reclaimable') blockers.push('vat_treatment');
  if (revenue?.verified !== true || !validMoney(revenue.pence) || revenue.pence === 0 ||
      revenue.basis !== 'received_after_discounts_including_shipping') blockers.push('received_revenue');
  const record = {};
  for (const { id } of REQUIRED_UNIT_COSTS) {
    const cost = costs?.[id];
    // A workbook zero is unknown unless independently verified, including free costs.
    if (cost?.verified !== true || !validMoney(cost.pence)) blockers.push(`cost:${id}`);
    else record[id] = cost.pence / 100;
  }
  if (blockers.length) return result('blocked', blockers, { targetPercent });
  const totalCostPence = REQUIRED_UNIT_COSTS.reduce((sum, { id }) => sum + costs[id].pence, 0);
  const contributionPence = revenue.pence - totalCostPence;
  const meetsTarget = contributionMeetsMargin(revenue.pence / 100, record, targetPercent);
  return result(meetsTarget ? 'meets_target' : 'below_target', [], {
    targetPercent, totalCostPence, receivedRevenuePence: revenue.pence,
    contributionPence, marginPercent: contributionPence / revenue.pence * 100
  });
}
