const REQUIRED_UNIT_COSTS = Object.freeze([
  { id: 'landed', label: 'landed product cost' },
  { id: 'packing', label: 'packing cost' },
  { id: 'handling', label: 'picking / handling cost' },
  { id: 'delivery', label: 'actual outbound delivery cost' },
  { id: 'paymentFee', label: 'payment processing fee' },
  { id: 'channelFee', label: 'marketplace / channel fee' },
  { id: 'advertising', label: 'advertising allocation' },
  { id: 'otherVariable', label: 'other variable cost' }
]);

export const ECONOMICS_FIELDS = Object.freeze([
  'supplierUnitCost',
  'supplierDelivery',
  'supplierVatRate',
  'boxQuantity',
  'boxPrice',
  'landed',
  'packing',
  'handling',
  'delivery',
  'paymentFee',
  'channelFee',
  'advertising',
  'otherVariable',
  'marginFloor'
]);

export const ECONOMICS_TEXT_FIELDS = Object.freeze(['supplierId', 'supplierSku', 'notes']);
export { REQUIRED_UNIT_COSTS };

// Recorded amounts accept finite numbers and signed decimal strings only.
// Blank/coerced values are unknown; explicit zero and historical negatives remain valid.
export function hasAmount(value) {
  return (typeof value === 'number' || (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))) &&
    Number.isFinite(Number(value));
}

// Catalogue prices may arrive as decimal strings. Blank/coerced values do not
// establish a selling price; an explicitly recorded zero does.
export function hasCataloguePrice(value) {
  return hasAmount(value) && Number(value) >= 0;
}

export function amount(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rounded(value, places = 2) {
  if (!Number.isFinite(value)) return null;
  const multiplier = 10 ** places;
  return Math.round((value + Number.EPSILON) * multiplier) / multiplier;
}

// Policy decisions use source numbers before any supplier arithmetic or display
// rounding. Rational division also retains repeating box allocations exactly.
// Input normalization still uses Number; precision already lost at ingestion or
// in historical records cannot be recovered by these comparisons.
function fraction(n, d = 1n) {
  if (d < 0n) { n = -n; d = -d; }
  let a = n < 0n ? -n : n, b = d;
  while (b) [a, b] = [b, a % b];
  return { n: n / a, d: d / a };
}

function decimalNumber(value) {
  const [mantissa, exponent = '0'] = String(value).split('e');
  const [whole, decimals = ''] = mantissa.split('.');
  const n = BigInt(whole + decimals), scale = decimals.length - Number(exponent);
  return scale >= 0 ? fraction(n, 10n ** BigInt(scale)) : fraction(n * 10n ** BigInt(-scale));
}

const add = (a, b) => fraction(a.n * b.d + b.n * a.d, a.d * b.d);
const subtract = (a, b) => fraction(a.n * b.d - b.n * a.d, a.d * b.d);
const multiply = (a, b) => fraction(a.n * b.n, a.d * b.d);
const divide = (a, b) => fraction(a.n * b.d, a.d * b.n);
const sourceAmount = value => hasAmount(value) ? decimalNumber(Number(value)) : null;

function exactLandedCost(record) {
  const landed = sourceAmount(record.landed);
  if (landed) return landed;
  let unit = sourceAmount(record.supplierUnitCost);
  if (!unit) {
    const box = sourceAmount(record.boxPrice), quantity = sourceAmount(record.boxQuantity);
    if (box && quantity?.n > 0n) unit = divide(box, quantity);
  }
  const delivery = sourceAmount(record.supplierDelivery), rate = sourceAmount(record.supplierVatRate);
  if (!unit || !delivery || !rate || typeof record.supplierVatRecoverable !== 'boolean') return null;
  const vat = record.supplierVatRecoverable ? fraction(0n) : divide(multiply(unit, rate), fraction(100n));
  return add(add(unit, delivery), vat);
}

function exactVariableCost(record = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (!deriveLandedCost(record).complete) return null;
  const values = [exactLandedCost(record), ...REQUIRED_UNIT_COSTS.slice(1).map(field => sourceAmount(record[field.id]))];
  return values.every(Boolean) ? values.reduce(add, fraction(0n)) : null;
}

function exactContribution(price, record) {
  const cost = exactVariableCost(record);
  if (!Number.isFinite(price) || !cost) return null;
  const revenue = decimalNumber(price);
  return { price: revenue, value: subtract(revenue, cost) };
}

// Pass the original economics record, never the derived/displayed costs.
export function contributionMeetsMargin(price, record, minimumPercent) {
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(minimumPercent)) return false;
  const contribution = exactContribution(price, record);
  if (!contribution) return false;
  const floor = decimalNumber(minimumPercent);
  return contribution.value.n * 100n * floor.d * contribution.price.d >=
    contribution.price.n * floor.n * contribution.value.d;
}

// GBP catalogue proposals settle to pennies only after source-cost division.
// Withhold a proposal if it cannot be represented and verified safely.
export function minimumPriceForMargin(record, minimumPercent) {
  if (!Number.isFinite(minimumPercent) || minimumPercent >= 100) return null;
  const cost = exactVariableCost(record);
  if (!cost) return null;
  const retainedPercent = subtract(fraction(100n), decimalNumber(minimumPercent));
  const cents = divide(multiply(cost, fraction(10000n)), retainedPercent);
  const ceiling = cents.n <= 0n ? 1n : (cents.n + cents.d - 1n) / cents.d;
  if (ceiling > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const price = Number(ceiling) / 100, represented = decimalNumber(price);
  if (represented.n * 100n !== ceiling * represented.d) return null;
  return contributionMeetsMargin(price, record, minimumPercent) ? price : null;
}

export function deriveLandedCost(record = {}) {
  if (hasAmount(record.landed)) {
    return { value: amount(record.landed), source: 'recorded', complete: true, missing: [] };
  }

  let unitCost = null;
  let unitSource = null;
  if (hasAmount(record.supplierUnitCost)) {
    unitCost = amount(record.supplierUnitCost);
    unitSource = 'supplier-unit-cost';
  } else if (hasAmount(record.boxPrice) && hasAmount(record.boxQuantity) && amount(record.boxQuantity) > 0) {
    unitCost = amount(record.boxPrice) / amount(record.boxQuantity);
    unitSource = 'supplier-box-price';
  }

  const missing = [];
  if (unitCost === null) missing.push('supplier unit cost or box price / quantity');
  if (!hasAmount(record.supplierDelivery)) missing.push('supplier delivery allocation');
  if (!hasAmount(record.supplierVatRate)) missing.push('supplier VAT rate');
  if (typeof record.supplierVatRecoverable !== 'boolean') missing.push('supplier VAT recovery treatment');
  if (missing.length) return { value: null, source: 'unknown', complete: false, missing };

  const vat = record.supplierVatRecoverable ? 0 : unitCost * amount(record.supplierVatRate) / 100;
  const exact = exactLandedCost(record);
  const numerator = Number(exact.n), denominator = Number(exact.d);
  // Convert after the source arithmetic, without rounding away sub-penny costs.
  // Extreme rational operands can exceed Number even when their ratio is finite;
  // retain the existing numeric derivation in that case and apply its range guard.
  const value = Number.isFinite(numerator) && Number.isFinite(denominator)
    ? numerator / denominator
    : unitCost + amount(record.supplierDelivery) + vat;
  if (!Number.isFinite(value)) return { value: null, source: 'unknown', complete: false, missing: ['supplier landed cost within supported range'] };
  return {
    // Keep sub-penny unit precision until the caller aggregates or displays it.
    value,
    source: unitSource,
    complete: true,
    missing: []
  };
}

export function unitEconomics(item = {}, record = {}, options = {}) {
  const landed = deriveLandedCost(record);
  const costs = { landed: landed.value };
  const missingFields = [...landed.missing];

  for (const field of REQUIRED_UNIT_COSTS.slice(1)) {
    if (!hasAmount(record[field.id])) {
      missingFields.push(field.label);
      costs[field.id] = null;
    } else {
      costs[field.id] = amount(record[field.id]);
    }
  }

  // Cost completeness is useful independently of selling price (for example,
  // graph cost-coverage nodes). It does not establish contribution or margin.
  const complete = missingFields.length === 0;
  const recordedCost = Object.values(costs).filter(Number.isFinite).reduce((sum, value) => sum + value, 0);
  const price = hasCataloguePrice(item.price) ? amount(item.price) : null;
  const totalVariableCost = complete ? recordedCost : null;
  const contribution = complete && price !== null ? price - totalVariableCost : null;
  const margin = contribution !== null && price > 0 ? contribution / price * 100 : null;
  const configuredFloor = hasAmount(record.marginFloor) ? amount(record.marginFloor) : hasAmount(options.marginFloor) ? amount(options.marginFloor) : 20;
  const preciseContribution = complete && price !== null ? exactContribution(price, record) : null;
  const status = !complete
    ? 'missing-costs'
    : price === null
      ? 'missing-price'
      : preciseContribution && preciseContribution.value.n < 0n
        ? 'loss-making'
        : !Number.isFinite(margin)
          ? 'margin-unavailable'
          : !contributionMeetsMargin(price, record, configuredFloor)
            ? 'below-floor'
            : 'profitable';

  return {
    complete,
    estimated: landed.source !== 'recorded',
    missingFields,
    landedSource: landed.source,
    costs,
    recordedCost: rounded(recordedCost, 4),
    totalVariableCost: rounded(totalVariableCost, 4),
    contribution: rounded(contribution, 4),
    margin: rounded(margin, 2),
    marginFloor: configuredFloor,
    status
  };
}

function orderRefunds(order) {
  if (hasAmount(order.refunds)) return Math.max(0, amount(order.refunds));
  if (String(order.financialStatus || '').toUpperCase() === 'REFUNDED' && hasAmount(order.total)) return Math.max(0, amount(order.total));
  return null;
}

export function orderRevenue(order = {}) {
  const originalTotal = hasAmount(order.total) ? amount(order.total) : null;
  const refunds = orderRefunds(order);
  const currentTotal = hasAmount(order.currentTotal) ? amount(order.currentTotal) : null;
  const netRevenue = currentTotal !== null
    ? currentTotal
    : originalTotal !== null && refunds !== null
      ? Math.max(0, originalTotal - refunds)
      : null;
  const tax = hasAmount(order.currentTax)
    ? amount(order.currentTax)
    : hasAmount(order.tax)
      ? amount(order.tax)
      : null;
  const revenueExTax = netRevenue !== null && tax !== null ? netRevenue - tax : null;
  return {
    grossRevenue: rounded(originalTotal),
    netRevenue: rounded(netRevenue),
    revenueExTax: rounded(revenueExTax),
    refunds: rounded(refunds),
    tax: rounded(tax),
    discounts: hasAmount(order.discounts) ? rounded(amount(order.discounts)) : null,
    shippingCharged: hasAmount(order.shippingCharged) ? rounded(amount(order.shippingCharged)) : null
  };
}

function explicitOrderCost(order, field) {
  return hasAmount(order[field]) ? amount(order[field]) : null;
}

export function calculateOrderProfit(order = {}, economics = {}, options = {}) {
  const revenue = orderRevenue(order);
  const lines = Array.isArray(order.lineItems) ? order.lineItems : [];
  const missing = [];
  const breakdown = {
    landed: 0,
    packing: 0,
    handling: 0,
    delivery: 0,
    paymentFee: 0,
    channelFee: 0,
    advertising: 0,
    otherVariable: 0
  };

  if (!lines.length) missing.push('order line items');
  if (revenue.netRevenue === null) missing.push('net order revenue');
  if (revenue.refunds === null) missing.push('refund amount');
  if (revenue.tax === null) missing.push('tax / VAT amount');

  const overrides = {
    delivery: explicitOrderCost(order, 'actualShippingCost'),
    paymentFee: explicitOrderCost(order, 'paymentFees'),
    channelFee: explicitOrderCost(order, 'channelFees'),
    advertising: explicitOrderCost(order, 'advertisingCost'),
    otherVariable: explicitOrderCost(order, 'otherVariableCosts')
  };
  const lineDetails = [];

  for (const line of lines) {
    const sku = String(line.sku || '').trim();
    const quantity = hasAmount(line.quantity) ? Math.max(0, Math.floor(amount(line.quantity))) : 0;
    if (!sku) missing.push('line item SKU');
    if (!quantity) missing.push(`${sku || 'line item'} quantity`);
    const record = economics[sku] || {};
    const landed = deriveLandedCost(record);
    const lineMissing = [];
    if (!landed.complete) lineMissing.push(...landed.missing);
    else breakdown.landed += landed.value * quantity;

    for (const field of REQUIRED_UNIT_COSTS.slice(1)) {
      if (Object.hasOwn(overrides, field.id) && overrides[field.id] !== null) continue;
      if (!hasAmount(record[field.id])) lineMissing.push(field.label);
      else breakdown[field.id] += amount(record[field.id]) * quantity;
    }
    if (lineMissing.length) missing.push(...lineMissing.map(field => `${sku || 'line item'}: ${field}`));
    lineDetails.push({
      id: String(line.id || ''),
      sku,
      name: String(line.name || line.title || sku || 'Order item'),
      quantity,
      netSales: hasAmount(line.net) ? rounded(amount(line.net)) : hasAmount(line.discountedTotal) ? rounded(amount(line.discountedTotal)) : null,
      missingFields: lineMissing
    });
  }

  for (const [field, value] of Object.entries(overrides)) {
    if (value !== null) breakdown[field] = value;
  }

  const uniqueMissing = [...new Set(missing)];
  const complete = uniqueMissing.length === 0;
  const totalVariableCost = complete ? Object.values(breakdown).reduce((sum, value) => sum + value, 0) : null;
  const contribution = complete ? revenue.revenueExTax - totalVariableCost : null;
  const margin = contribution !== null && revenue.revenueExTax > 0 ? contribution / revenue.revenueExTax * 100 : null;
  const grossProfit = complete ? revenue.revenueExTax - breakdown.landed : null;
  const actualCostCoverage = ['actualShippingCost', 'paymentFees', 'channelFees', 'advertisingCost']
    .filter(field => explicitOrderCost(order, field) !== null);

  return {
    ...revenue,
    complete,
    basis: complete && actualCostCoverage.length === 4 ? 'confirmed-costs' : complete ? 'estimated-costs' : 'incomplete',
    missingFields: uniqueMissing,
    breakdown: Object.fromEntries(Object.entries(breakdown).map(([key, value]) => [key, rounded(value, 4)])),
    totalVariableCost: rounded(totalVariableCost),
    grossProfit: rounded(grossProfit),
    contribution: rounded(contribution),
    margin: rounded(margin, 2),
    lines: lineDetails
  };
}

export function settledOrder(order = {}) {
  return ['PAID', 'PARTIALLY_PAID', 'AUTHORIZED', 'PARTIALLY_REFUNDED', 'REFUNDED']
    .includes(String(order.financialStatus || '').toUpperCase());
}

export function withinDays(value, days, now = new Date()) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= now.getTime() - days * 86400000 && timestamp <= now.getTime() + 60000;
}

export function sameUtcDay(value, now = new Date()) {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
}

export function summarizeOrders(orders = [], economics = {}, predicate = () => true) {
  const selected = orders.filter(order => !order.cancelledAt && predicate(order));
  const settled = selected.filter(settledOrder);
  const results = settled.map(order => ({ order, result: calculateOrderProfit(order, economics) }));
  const complete = results.filter(entry => entry.result.complete);
  const revenue = settled.reduce((sum, order) => sum + (orderRevenue(order).netRevenue || 0), 0);
  const grossSales = settled.reduce((sum, order) => sum + (orderRevenue(order).grossRevenue || 0), 0);
  const refunds = settled.reduce((sum, order) => sum + (orderRevenue(order).refunds || 0), 0);
  const tax = settled.reduce((sum, order) => sum + (orderRevenue(order).tax || 0), 0);
  const contribution = complete.reduce((sum, entry) => sum + entry.result.contribution, 0);
  const grossProfit = complete.reduce((sum, entry) => sum + entry.result.grossProfit, 0);
  const coveredRevenue = complete.reduce((sum, entry) => sum + entry.result.revenueExTax, 0);
  const open = selected.filter(order => !['FULFILLED', 'RESTOCKED'].includes(String(order.fulfillmentStatus || '').toUpperCase()));
  return {
    orders: selected.length,
    paidOrders: settled.length,
    openOrders: open.length,
    grossSales: rounded(grossSales),
    revenue: rounded(revenue),
    refunds: rounded(refunds),
    tax: rounded(tax),
    grossProfit: complete.length ? rounded(grossProfit) : null,
    operatingProfit: complete.length ? rounded(contribution) : null,
    margin: complete.length && coveredRevenue > 0 ? rounded(contribution / coveredRevenue * 100, 1) : null,
    profitCoveredOrders: complete.length,
    profitCoverage: settled.length ? Math.round(complete.length / settled.length * 100) : 0
  };
}
