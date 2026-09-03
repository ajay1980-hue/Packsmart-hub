(() => {
  'use strict';

  const strategy = window.PacksmartEbayStrategy;
  if (!strategy) throw new Error('Packsmart eBay strategy module failed to load.');

  const $ = id => document.getElementById(id);
  const quantities = [50, 100, 200];
  let productKey = 'default';

  function val(id, fallback) {
    const el = $(id);
    return el ? el.value : (fallback == null ? '' : fallback);
  }

  function checked(id, fallback) {
    const el = $(id);
    return el ? el.checked : Boolean(fallback);
  }

  function setVal(id, value) {
    const el = $(id);
    if (el) el.value = value == null ? '' : value;
  }

  function feeFields() {
    return {
      finalValuePercent: val('feeFinalValuePercent', strategy.DEFAULTS.finalValuePercent),
      regulatoryPercent: val('feeRegulatoryPercent', strategy.DEFAULTS.regulatoryPercent),
      feeVatPercent: val('feeVatPercent', strategy.DEFAULTS.feeVatPercent),
      fixedOrderFee: val('fixedOrderFee', strategy.DEFAULTS.fixedOrderFee),
      targetMarginPercent: val('targetMarginPercent', strategy.DEFAULTS.targetMarginPercent),
      hardFloorMarginPercent: val('hardFloorMarginPercent', strategy.DEFAULTS.hardFloorMarginPercent),
      freeShippingThreshold: val('freeShippingThreshold', strategy.DEFAULTS.freeShippingThreshold),
      guardEnabled: checked('profitGuardEnabled', true)
    };
  }

  function costRows() {
    return quantities.map(quantity => ({
      quantity,
      landedCost: val(`cost${quantity}Landed`),
      packingCost: val(`cost${quantity}Packing`),
      outboundShippingCost: val(`cost${quantity}Shipping`)
    }));
  }

  function variations() {
    return quantities
      .filter(quantity => checked(`variation${quantity}Enabled`, true))
      .map(quantity => ({
        quantity,
        price: val(`variation${quantity}Price`),
        sku: val(`variation${quantity}Sku`)
      }));
  }

  function promotion() {
    const enabled = val('promotionType') === 'promoted-listings-standard';
    return {
      enabled,
      adRatePercent: enabled ? val('adRatePercent') : 0
    };
  }

  function postage() {
    const mode = document.querySelector('input[name="postageMode"]:checked')?.value || 'free';
    return {
      freeShipping: mode === 'free',
      shippingCost: { value: mode === 'free' ? '0.00' : val('shippingCost') }
    };
  }

  function collectFields() {
    return Object.assign({}, feeFields(), {
      costRows: costRows(),
      bestOfferEnabled: checked('bestOfferEnabled', false),
      bestOfferMaxDiscountPercent: val('bestOfferMaxDiscountPercent', strategy.DEFAULTS.bestOfferMaxDiscountPercent),
      multiBuyEnabled: checked('multiBuyEnabled', true),
      multiBuyTiers: [
        { quantity: 2, discountPercent: val('multiBuy2', 3) },
        { quantity: 3, discountPercent: val('multiBuy3', 5) },
        { quantity: 4, discountPercent: val('multiBuy4', 7) }
      ]
    });
  }

  function build() {
    return strategy.buildCommercial(collectFields(), variations(), promotion(), postage());
  }

  function tone(margin, floor, target) {
    if (!Number.isFinite(margin)) return 'neutral';
    if (margin < floor) return 'danger';
    if (margin < target) return 'warn';
    return 'good';
  }

  function render() {
    const commercial = build();
    const body = $('profitRows');
    if (body) {
      body.innerHTML = commercial.rows.map(row => {
        const c = row.current;
        if (!row.complete) {
          return `<div class="profit-row neutral"><strong>Pack ${row.quantity}</strong><span>Enter all 3 costs</span><span>—</span><span>—</span></div>`;
        }
        const margin = row.worstCase ? row.worstCase.netMarginPercent : c.netMarginPercent;
        const rowTone = tone(margin, commercial.hardFloorMarginPercent, commercial.targetMarginPercent);
        return `<div class="profit-row ${rowTone}">
          <strong>Pack ${row.quantity}</strong>
          <span>Profit £${c.values.netProfit}</span>
          <span>Margin ${c.values.netMarginPercent}%</span>
          <span>Worst ${row.worstCase.values.netMarginPercent}%</span>
          <span>Target price £${row.suggestedPrice}</span>
        </div>`;
      }).join('');
    }

    const summary = $('profitSummary');
    if (summary) {
      if (!commercial.guardEnabled) {
        summary.textContent = 'Profit guard is OFF — drafts can publish without cost protection.';
        summary.dataset.tone = 'warn';
      } else if (!commercial.allComplete) {
        summary.textContent = 'Add costs for every enabled pack size to unlock protected live publishing.';
        summary.dataset.tone = 'neutral';
      } else if (commercial.publishAllowed) {
        summary.textContent = `Protected: worst enabled margin ${commercial.minimumObservedMarginPercent.toFixed(1)}% • floor ${commercial.hardFloorMarginPercent.toFixed(1)}%`;
        summary.dataset.tone = 'good';
      } else {
        summary.textContent = commercial.publishBlockReason;
        summary.dataset.tone = 'danger';
      }
    }

    const ship = $('shippingRecommendation');
    if (ship) {
      const rec = commercial.shippingRecommendation;
      ship.textContent = rec.mode === 'free'
        ? `Recommended: FREE delivery — ${rec.reason}`
        : `Recommended: buyer pays £${rec.buyerCharge} — ${rec.reason}`;
      ship.dataset.mode = rec.mode;
    }

    const offer = $('offerFloorHint');
    if (offer) {
      const floor200 = commercial.bestOffer.perVariationFloor[200];
      offer.textContent = checked('bestOfferEnabled', false) && floor200
        ? `Pack 200 safe offer floor: £${floor200} at the current profit-floor setting.`
        : 'Best Offer is off. Turn it on only for larger packs when you want negotiation room.';
    }

    saveProfiles();
    return commercial;
  }

  function applySuggestedPrices() {
    const commercial = build();
    let first = null;
    commercial.rows.forEach(row => {
      if (!row.complete || !row.suggestedPrice) return;
      setVal(`variation${row.quantity}Price`, row.suggestedPrice);
      if (first == null) first = row.suggestedPrice;
    });
    if (first != null) setVal('price', first);
    render();
  }

  function applyShippingRecommendation() {
    const commercial = build();
    const rec = commercial.shippingRecommendation;
    const radio = document.querySelector(`input[name="postageMode"][value="${rec.mode}"]`);
    if (radio) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (rec.mode === 'paid') setVal('shippingCost', rec.buyerCharge);
    render();
  }

  function globalKey() {
    return 'packsmart-ebay-fee-settings-v1';
  }

  function productStorageKey() {
    return `packsmart-ebay-economics-v1:${productKey}`;
  }

  function saveProfiles() {
    try {
      localStorage.setItem(globalKey(), JSON.stringify(Object.assign({}, feeFields(), {
        bestOfferEnabled: checked('bestOfferEnabled', false),
        bestOfferMaxDiscountPercent: val('bestOfferMaxDiscountPercent'),
        multiBuyEnabled: checked('multiBuyEnabled', true),
        multiBuy2: val('multiBuy2'),
        multiBuy3: val('multiBuy3'),
        multiBuy4: val('multiBuy4')
      })));
      localStorage.setItem(productStorageKey(), JSON.stringify({ costRows: costRows() }));
    } catch (_) {}
  }

  function loadGlobalProfile() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(globalKey()) || '{}'); } catch (_) {}
    const d = strategy.DEFAULTS;
    setVal('feeFinalValuePercent', saved.finalValuePercent ?? d.finalValuePercent);
    setVal('feeRegulatoryPercent', saved.regulatoryPercent ?? d.regulatoryPercent);
    setVal('feeVatPercent', saved.feeVatPercent ?? d.feeVatPercent);
    setVal('fixedOrderFee', saved.fixedOrderFee ?? d.fixedOrderFee);
    setVal('targetMarginPercent', saved.targetMarginPercent ?? d.targetMarginPercent);
    setVal('hardFloorMarginPercent', saved.hardFloorMarginPercent ?? d.hardFloorMarginPercent);
    setVal('freeShippingThreshold', saved.freeShippingThreshold ?? d.freeShippingThreshold);
    if ($('profitGuardEnabled')) $('profitGuardEnabled').checked = saved.guardEnabled !== false;
    if ($('bestOfferEnabled')) $('bestOfferEnabled').checked = Boolean(saved.bestOfferEnabled);
    setVal('bestOfferMaxDiscountPercent', saved.bestOfferMaxDiscountPercent ?? d.bestOfferMaxDiscountPercent);
    if ($('multiBuyEnabled')) $('multiBuyEnabled').checked = saved.multiBuyEnabled !== false;
    setVal('multiBuy2', saved.multiBuy2 ?? 3);
    setVal('multiBuy3', saved.multiBuy3 ?? 5);
    setVal('multiBuy4', saved.multiBuy4 ?? 7);
  }

  function loadProductProfile() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(productStorageKey()) || '{}'); } catch (_) {}
    const byQ = Object.fromEntries((saved.costRows || []).map(row => [Number(row.quantity), row]));
    quantities.forEach(quantity => {
      const row = byQ[quantity] || {};
      setVal(`cost${quantity}Landed`, row.landedCost || '');
      setVal(`cost${quantity}Packing`, row.packingCost || '');
      setVal(`cost${quantity}Shipping`, row.outboundShippingCost || '');
    });
  }

  function setProduct(product) {
    productKey = String(product && (product.handle || product.id || product.title) || 'default').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
    loadProductProfile();
    render();
  }

  function reset() {
    productKey = 'default';
    quantities.forEach(quantity => {
      setVal(`cost${quantity}Landed`, '');
      setVal(`cost${quantity}Packing`, '');
      setVal(`cost${quantity}Shipping`, '');
    });
    render();
  }

  const watchIds = [
    'feeFinalValuePercent','feeRegulatoryPercent','feeVatPercent','fixedOrderFee',
    'targetMarginPercent','hardFloorMarginPercent','freeShippingThreshold','profitGuardEnabled',
    'bestOfferEnabled','bestOfferMaxDiscountPercent','multiBuyEnabled','multiBuy2','multiBuy3','multiBuy4',
    'variation50Price','variation100Price','variation200Price',
    'variation50Enabled','variation100Enabled','variation200Enabled',
    'promotionType','adRatePercent','shippingCost',
    'cost50Landed','cost50Packing','cost50Shipping',
    'cost100Landed','cost100Packing','cost100Shipping',
    'cost200Landed','cost200Packing','cost200Shipping'
  ];

  loadGlobalProfile();
  loadProductProfile();
  watchIds.forEach(id => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', render);
    el.addEventListener('change', render);
  });
  document.querySelectorAll('input[name="postageMode"]').forEach(el => el.addEventListener('change', render));
  $('applySuggestedPrices')?.addEventListener('click', applySuggestedPrices);
  $('applyShippingRecommendation')?.addEventListener('click', applyShippingRecommendation);

  window.PacksmartEbayCommercial = {
    collectFields,
    build,
    render,
    applySuggestedPrices,
    applyShippingRecommendation,
    setProduct,
    reset
  };

  render();
})();
