(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PacksmartEbayStrategy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULTS = Object.freeze({
    finalValuePercent: 12.5,
    regulatoryPercent: 0.35,
    feeVatPercent: 20,
    fixedOrderFee: 0.40,
    targetMarginPercent: 25,
    hardFloorMarginPercent: 20,
    freeShippingThreshold: 12.99,
    defaultBuyerShippingCharge: 3.49,
    bestOfferMaxDiscountPercent: 5,
    multiBuyTiers: [
      { quantity: 2, discountPercent: 3 },
      { quantity: 3, discountPercent: 5 },
      { quantity: 4, discountPercent: 7 }
    ]
  });

  function number(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : (fallback == null ? 0 : fallback);
  }

  function money(value) {
    return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : null;
  }

  function pct(value) {
    return Number.isFinite(Number(value)) ? Number(value).toFixed(1) : null;
  }

  function normalizeFeeModel(fields) {
    fields = fields || {};
    return {
      finalValuePercent: Math.max(0, number(fields.finalValuePercent, DEFAULTS.finalValuePercent)),
      regulatoryPercent: Math.max(0, number(fields.regulatoryPercent, DEFAULTS.regulatoryPercent)),
      feeVatPercent: Math.max(0, number(fields.feeVatPercent, DEFAULTS.feeVatPercent)),
      fixedOrderFee: Math.max(0, number(fields.fixedOrderFee, DEFAULTS.fixedOrderFee))
    };
  }

  function grossVariableFeeRate(feeModel, adRatePercent) {
    const fees = normalizeFeeModel(feeModel);
    const vatMultiplier = 1 + fees.feeVatPercent / 100;
    const ebayRate = (fees.finalValuePercent + fees.regulatoryPercent) / 100;
    const adRate = Math.max(0, number(adRatePercent, 0)) / 100;
    return (ebayRate + adRate) * vatMultiplier;
  }

  function calculateProfit(input) {
    input = input || {};
    const itemPrice = Math.max(0, number(input.itemPrice));
    const buyerShippingCharge = Math.max(0, number(input.buyerShippingCharge));
    const landedCost = Math.max(0, number(input.landedCost));
    const packingCost = Math.max(0, number(input.packingCost));
    const outboundShippingCost = Math.max(0, number(input.outboundShippingCost));
    const adRatePercent = Math.max(0, number(input.adRatePercent));
    const fees = normalizeFeeModel(input.feeModel);
    const revenue = itemPrice + buyerShippingCharge;
    const vatMultiplier = 1 + fees.feeVatPercent / 100;
    const ebayBaseFee = revenue * ((fees.finalValuePercent + fees.regulatoryPercent) / 100) + fees.fixedOrderFee;
    const ebayFeeGross = ebayBaseFee * vatMultiplier;
    const adBaseFee = revenue * (adRatePercent / 100);
    const adFeeGross = adBaseFee * vatMultiplier;
    const totalChannelFees = ebayFeeGross + adFeeGross;
    const totalDirectCosts = landedCost + packingCost + outboundShippingCost;
    const netProfit = revenue - totalChannelFees - totalDirectCosts;
    const netMarginPercent = revenue > 0 ? (netProfit / revenue) * 100 : -Infinity;

    return {
      itemPrice,
      buyerShippingCharge,
      revenue,
      landedCost,
      packingCost,
      outboundShippingCost,
      ebayFeeGross,
      adFeeGross,
      totalChannelFees,
      totalDirectCosts,
      netProfit,
      netMarginPercent,
      values: {
        revenue: money(revenue),
        ebayFeeGross: money(ebayFeeGross),
        adFeeGross: money(adFeeGross),
        totalChannelFees: money(totalChannelFees),
        totalDirectCosts: money(totalDirectCosts),
        netProfit: money(netProfit),
        netMarginPercent: pct(netMarginPercent)
      }
    };
  }

  function roundRetailUp(value) {
    const n = Math.max(0, number(value));
    if (!n) return 0;
    const rounded = Math.ceil((n + 0.001) * 2) / 2 - 0.01;
    return Math.max(n, Math.round(rounded * 100) / 100);
  }

  function minimumPriceForMargin(input) {
    input = input || {};
    const fees = normalizeFeeModel(input.feeModel);
    const targetMargin = Math.min(95, Math.max(0, number(input.targetMarginPercent, DEFAULTS.targetMarginPercent))) / 100;
    const adRatePercent = Math.max(0, number(input.adRatePercent));
    const buyerShippingCharge = Math.max(0, number(input.buyerShippingCharge));
    const costs =
      Math.max(0, number(input.landedCost)) +
      Math.max(0, number(input.packingCost)) +
      Math.max(0, number(input.outboundShippingCost));
    const vatMultiplier = 1 + fees.feeVatPercent / 100;
    const fixedGross = fees.fixedOrderFee * vatMultiplier;
    const variableRate = grossVariableFeeRate(fees, adRatePercent);
    const denominator = 1 - variableRate - targetMargin;
    if (denominator <= 0) return Infinity;
    const requiredRevenue = (costs + fixedGross) / denominator;
    const requiredItemPrice = Math.max(0, requiredRevenue - buyerShippingCharge);
    return roundRetailUp(requiredItemPrice);
  }

  function maxPromotionDiscount(fields) {
    fields = fields || {};
    const multi = fields.multiBuyEnabled === false ? 0 :
      Math.max(0, ...(fields.multiBuyTiers || DEFAULTS.multiBuyTiers).map(t => number(t.discountPercent)));
    const offer = fields.bestOfferEnabled ? Math.max(0, number(fields.bestOfferMaxDiscountPercent, DEFAULTS.bestOfferMaxDiscountPercent)) : 0;
    return Math.max(multi, offer);
  }

  function normalizeCostRows(rows) {
    const result = {};
    (rows || []).forEach(row => {
      const quantity = Number(row && row.quantity);
      if (![50, 100, 200].includes(quantity)) return;
      result[quantity] = {
        quantity,
        landedCost: String(row.landedCost == null ? '' : row.landedCost).trim(),
        packingCost: String(row.packingCost == null ? '' : row.packingCost).trim(),
        outboundShippingCost: String(row.outboundShippingCost == null ? '' : row.outboundShippingCost).trim()
      };
    });
    return result;
  }

  function rowIsComplete(row) {
    if (!row) return false;
    return [row.landedCost, row.packingCost, row.outboundShippingCost].every(v => {
      const text = String(v == null ? '' : v).trim();
      return text !== '' && Number.isFinite(Number(text)) && Number(text) >= 0;
    });
  }

  function recommendBuyerCharge(rows, fallback) {
    const shippingCosts = (rows || [])
      .filter(r => r && r.complete)
      .map(r => number(r.outboundShippingCost))
      .filter(n => n > 0);
    if (!shippingCosts.length) return number(fallback, DEFAULTS.defaultBuyerShippingCharge);
    const base = Math.min(...shippingCosts);
    return Math.min(3.99, Math.max(2.99, Math.round(base * 100) / 100));
  }

  function buildCommercial(fields, variations, promotion, postage) {
    fields = fields || {};
    variations = variations || [];
    promotion = promotion || {};
    postage = postage || {};
    const feeModel = normalizeFeeModel(fields);
    const targetMarginPercent = Math.max(0, number(fields.targetMarginPercent, DEFAULTS.targetMarginPercent));
    const hardFloorMarginPercent = Math.max(0, number(fields.hardFloorMarginPercent, DEFAULTS.hardFloorMarginPercent));
    const freeShippingThreshold = Math.max(0, number(fields.freeShippingThreshold, DEFAULTS.freeShippingThreshold));
    const guardEnabled = fields.guardEnabled !== false;
    const costMap = normalizeCostRows(fields.costRows);
    const adRatePercent = promotion.enabled ? Math.max(0, number(promotion.adRatePercent)) : 0;
    const buyerShippingCharge = postage.freeShipping ? 0 : Math.max(0, number(postage.shippingCost && postage.shippingCost.value));
    const bestOfferEnabled = Boolean(fields.bestOfferEnabled);
    const bestOfferMaxDiscountPercent = bestOfferEnabled
      ? Math.max(0, number(fields.bestOfferMaxDiscountPercent, DEFAULTS.bestOfferMaxDiscountPercent))
      : 0;
    const multiBuyEnabled = fields.multiBuyEnabled !== false;
    const tiers = (fields.multiBuyTiers || DEFAULTS.multiBuyTiers).map(t => ({
      quantity: Math.max(2, Math.floor(number(t.quantity, 2))),
      discountPercent: Math.max(0, number(t.discountPercent))
    }));
    const worstDiscountPercent = maxPromotionDiscount({
      multiBuyEnabled,
      multiBuyTiers: tiers,
      bestOfferEnabled,
      bestOfferMaxDiscountPercent
    });

    const rows = variations.map(variation => {
      const quantity = Number(variation.quantity);
      const costs = costMap[quantity] || {};
      const complete = rowIsComplete(costs);
      const itemPrice = Math.max(0, number(variation.price));
      const common = {
        feeModel,
        adRatePercent,
        landedCost: number(costs.landedCost),
        packingCost: number(costs.packingCost),
        outboundShippingCost: number(costs.outboundShippingCost)
      };
      const current = complete ? calculateProfit(Object.assign({}, common, {
        itemPrice,
        buyerShippingCharge
      })) : null;
      const free = complete ? calculateProfit(Object.assign({}, common, {
        itemPrice,
        buyerShippingCharge: 0
      })) : null;
      const discountedPrice = itemPrice * (1 - worstDiscountPercent / 100);
      const worstCase = complete ? calculateProfit(Object.assign({}, common, {
        itemPrice: discountedPrice,
        buyerShippingCharge
      })) : null;
      const suggestedPrice = complete ? minimumPriceForMargin(Object.assign({}, common, {
        targetMarginPercent,
        buyerShippingCharge
      })) : null;
      const safeFloorPrice = complete ? minimumPriceForMargin(Object.assign({}, common, {
        targetMarginPercent: hardFloorMarginPercent,
        buyerShippingCharge
      })) : null;

      return {
        quantity,
        sku: variation.sku || '',
        price: variation.price,
        complete,
        landedCost: costs.landedCost == null ? '' : costs.landedCost,
        packingCost: costs.packingCost == null ? '' : costs.packingCost,
        outboundShippingCost: costs.outboundShippingCost == null ? '' : costs.outboundShippingCost,
        current,
        freeShipping: free,
        worstCase,
        suggestedPrice: suggestedPrice == null ? null : money(suggestedPrice),
        safeFloorPrice: safeFloorPrice == null ? null : money(safeFloorPrice)
      };
    });

    const enabledCompleteRows = rows.filter(r => r.complete);
    const allComplete = rows.length > 0 && enabledCompleteRows.length === rows.length;
    const margins = enabledCompleteRows.map(r => r.worstCase && r.worstCase.netMarginPercent).filter(Number.isFinite);
    const minimumObservedMarginPercent = margins.length ? Math.min(...margins) : null;
    const publishAllowed = !guardEnabled || (
      allComplete &&
      minimumObservedMarginPercent != null &&
      minimumObservedMarginPercent >= hardFloorMarginPercent
    );

    let publishBlockReason = '';
    if (guardEnabled && !allComplete) {
      publishBlockReason = 'Enter landed cost, packing cost and actual delivery cost for every enabled pack size.';
    } else if (guardEnabled && minimumObservedMarginPercent < hardFloorMarginPercent) {
      publishBlockReason = `Worst-case net margin is ${pct(minimumObservedMarginPercent)}%, below the ${pct(hardFloorMarginPercent)}% floor.`;
    }

    const canFreeShip = allComplete && rows.every(r =>
      number(r.price) >= freeShippingThreshold &&
      r.freeShipping &&
      r.freeShipping.netMarginPercent >= hardFloorMarginPercent
    );
    const recommendedBuyerCharge = recommendBuyerCharge(rows, fields.defaultBuyerShippingCharge);

    return {
      guardEnabled,
      feeModel,
      targetMarginPercent,
      hardFloorMarginPercent,
      freeShippingThreshold,
      adRatePercent,
      buyerShippingCharge,
      worstDiscountPercent,
      rows,
      allComplete,
      minimumObservedMarginPercent,
      publishAllowed,
      publishBlockReason,
      shippingRecommendation: {
        mode: canFreeShip ? 'free' : 'paid',
        buyerCharge: canFreeShip ? '0.00' : money(recommendedBuyerCharge),
        reason: canFreeShip
          ? 'All enabled packs stay above the profit floor with free delivery.'
          : 'Buyer-paid delivery protects the lowest pack size; larger packs can still be priced to absorb postage.'
      },
      bestOffer: {
        enabled: bestOfferEnabled,
        scope: 'HIGHER_PACKS',
        maxDiscountPercent: bestOfferMaxDiscountPercent,
        floorMarginPercent: hardFloorMarginPercent,
        perVariationFloor: Object.fromEntries(rows.map(r => [r.quantity, r.safeFloorPrice]))
      },
      multiBuy: {
        enabled: multiBuyEnabled,
        tiers
      }
    };
  }

  function validateCommercial(commercial) {
    if (!commercial || commercial.guardEnabled === false) return [];
    if (commercial.publishAllowed) return [];
    return [commercial.publishBlockReason || 'Commercial profit guard blocked live publishing.'];
  }

  return {
    DEFAULTS,
    normalizeFeeModel,
    grossVariableFeeRate,
    calculateProfit,
    minimumPriceForMargin,
    roundRetailUp,
    maxPromotionDiscount,
    buildCommercial,
    validateCommercial
  };
});
