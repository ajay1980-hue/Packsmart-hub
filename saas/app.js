(() => {
  'use strict';

  const STORAGE = {
    economics: 'packsmart-saas-economics-v1',
    automations: 'packsmart-saas-automations-v1'
  };

  const state = {
    products: [],
    syncedAt: null,
    source: null,
    query: '',
    packFilter: 'all',
    economics: loadJson(STORAGE.economics, {}),
    automations: loadJson(STORAGE.automations, {
      profitGuard: true,
      lowStockAlerts: true,
      dailyOpsBrief: true,
      seoChecks: true,
      priceRecommendations: true,
      customerReplyDrafts: true
    })
  };

  const automationDefinitions = [
    { id: 'profitGuard', name: 'Profit guard', detail: 'Flag products when recorded costs leave weak contribution. Advisory only; does not change prices.', safe: true },
    { id: 'lowStockAlerts', name: 'Low-stock alerts', detail: 'Surface replenishment risks when inventory data is connected. Supplier orders still require approval.', safe: true },
    { id: 'dailyOpsBrief', name: 'Daily operations brief', detail: 'Summarise catalogue, margin coverage and actions needing attention.', safe: true },
    { id: 'seoChecks', name: 'SEO checks', detail: 'Identify catalogue pages that need metadata/content attention. No automatic publishing in the pilot.', safe: true },
    { id: 'priceRecommendations', name: 'Price recommendations', detail: 'Calculate and queue suggested price changes. Major price changes cannot execute automatically.', safe: true },
    { id: 'customerReplyDrafts', name: 'Customer reply drafts', detail: 'Prepare suggested replies for review before anything customer-facing is sent.', safe: true }
  ];

  const approvals = [
    ['Spend money', 'Advertising, paid services or any other spend must be explicitly approved.'],
    ['Place supplier orders', 'The system can calculate replenishment needs but cannot place a purchase order automatically.'],
    ['Issue refunds', 'Refund recommendations may be prepared; release of funds stays human-approved.'],
    ['Major price changes', 'The system may recommend pricing, but material changes remain blocked pending approval.'],
    ['Risk-sensitive live actions', 'Publishing or changing external marketplace actions can be gated when commercial or account checks fail.']
  ];

  const connections = [
    { name: 'Shopify catalogue', detail: 'Uses the Packsmart synced Shopify product snapshot already stored in this repository.', status: 'ready' },
    { name: 'eBay Manager', detail: 'Existing Packsmart manager contains listing, photo, postage and profit-protection workflows. OAuth remains server-side.', status: 'ready' },
    { name: 'Payments / subscriptions', detail: 'Not connected in the customer-zero pilot. This becomes Stripe billing when multi-tenant accounts are enabled.', status: 'planned' },
    { name: 'Multi-tenant database', detail: 'Not required for the single-business pilot. Supabase/Postgres is the planned tenant/auth layer.', status: 'planned' },
    { name: 'AI provider', detail: 'Current priority logic is deterministic. Model-backed briefings can be added server-side without exposing API keys.', status: 'planned' }
  ];

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? `£${n.toFixed(2)}` : '—';
  }

  function number(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function packSize(variant) {
    const match = String(variant.title || '').match(/(50|100|200)/);
    return match ? match[1] : '';
  }

  function flattenProducts() {
    return state.products.flatMap(product =>
      (product.variants || []).map(variant => ({
        productId: product.id,
        productTitle: product.title,
        handle: product.handle,
        image: product.image,
        sku: variant.sku || `${product.handle}-${variant.title}`,
        variantTitle: variant.title,
        pack: packSize(variant),
        price: number(variant.price)
      }))
    );
  }

  function getEconomics(sku) {
    return state.economics[sku] || { landed: '', packing: '', delivery: '' };
  }

  function contribution(item) {
    const e = getEconomics(item.sku);
    const hasLanded = e.landed !== '' && Number.isFinite(Number(e.landed));
    if (!hasLanded) return null;
    const profit = item.price - number(e.landed) - number(e.packing) - number(e.delivery);
    const margin = item.price > 0 ? (profit / item.price) * 100 : 0;
    return { profit, margin };
  }

  function economicsCoverage() {
    const items = flattenProducts();
    if (!items.length) return 0;
    const covered = items.filter(item => getEconomics(item.sku).landed !== '').length;
    return Math.round((covered / items.length) * 100);
  }

  function readinessScore() {
    if (!state.products.length) return 20;
    const coverage = economicsCoverage();
    const integrationBase = 45;
    const safety = state.automations.profitGuard ? 15 : 5;
    return Math.min(100, integrationBase + safety + Math.round(coverage * 0.4));
  }

  function renderOverview() {
    const items = flattenProducts();
    const coverage = economicsCoverage();
    $('#kpi-products').textContent = String(state.products.length || 0);
    $('#kpi-variants').textContent = String(items.length || 0);
    $('#kpi-cost-coverage').textContent = `${coverage}%`;
    $('#readiness-score').textContent = `${readinessScore()}%`;

    const weak = items
      .map(item => ({ item, result: contribution(item) }))
      .filter(x => x.result && x.result.margin < 20);
    const missing = items.filter(item => getEconomics(item.sku).landed === '').length;

    let brief = `Catalogue loaded: ${state.products.length} products and ${items.length} variants.`;
    if (missing) brief += ` ${missing} variants still need landed-cost data before the system can make trustworthy profit decisions.`;
    if (weak.length) brief += ` ${weak.length} recorded variants are currently below a 20% contribution margin and should be reviewed before promotion.`;
    if (!missing && !weak.length) brief += ' Recorded unit economics currently show no variants below the 20% pilot threshold.';
    $('#ops-brief').textContent = brief;

    const channelList = $('#channel-list');
    channelList.innerHTML = [
      ['Shopify', `${state.products.length} products available to the pilot`, state.products.length ? 'Ready' : 'Check', state.products.length ? 'good' : 'warn'],
      ['eBay', 'Existing manager module preserved; publishing remains behind its account/profit guard', 'Ready', 'good'],
      ['Packsmart Android app', 'Kept separate from this SaaS branch; no app code changed', 'Protected', 'good'],
      ['Billing', 'Multi-tenant subscription billing comes after customer-zero validation', 'Phase 2', 'warn']
    ].map(([name, detail, tag, cls]) => `
      <div class="channel"><div class="channel-main"><b>${escapeHtml(name)}</b><small>${escapeHtml(detail)}</small></div><span class="tag ${cls}">${escapeHtml(tag)}</span></div>`).join('');

    const priorities = [];
    if (missing) priorities.push(`Add landed-cost data for ${missing} variants so margin protection becomes reliable.`);
    if (weak.length) priorities.push(`Review ${weak.length} variant${weak.length === 1 ? '' : 's'} below the 20% pilot contribution threshold.`);
    priorities.push('Use the existing eBay commercial engine for marketplace-specific fees before approving live listings.');
    priorities.push('Keep customer zero single-tenant until Packsmart workflows prove which automations are genuinely valuable.');
    priorities.push('After validation: add account login, tenant database and subscription billing for beta customers.');
    $('#priority-list').innerHTML = priorities.slice(0, 5).map(item => `<li>${escapeHtml(item)}</li>`).join('');
  }

  function filteredItems() {
    const q = state.query.trim().toLowerCase();
    return flattenProducts().filter(item => {
      const matchesQuery = !q || `${item.productTitle} ${item.sku} ${item.variantTitle}`.toLowerCase().includes(q);
      const matchesPack = state.packFilter === 'all' || item.pack === state.packFilter;
      return matchesQuery && matchesPack;
    });
  }

  function marginClass(margin) {
    if (margin >= 25) return 'good';
    if (margin >= 20) return 'warn';
    return 'bad';
  }

  function renderEconomics() {
    const body = $('#economics-body');
    const items = filteredItems();
    if (!items.length) {
      body.innerHTML = '<tr><td colspan="7" class="empty">No matching products.</td></tr>';
      return;
    }
    body.innerHTML = items.map(item => {
      const e = getEconomics(item.sku);
      const result = contribution(item);
      return `<tr data-sku="${escapeHtml(item.sku)}">
        <td><div class="product-cell"><b>${escapeHtml(item.productTitle)}</b><small>${escapeHtml(item.variantTitle)} · ${escapeHtml(item.sku)}</small></div></td>
        <td>${money(item.price)}</td>
        <td><input class="money-input econ-input" inputmode="decimal" data-field="landed" value="${escapeHtml(e.landed)}" placeholder="0.00" /></td>
        <td><input class="money-input econ-input" inputmode="decimal" data-field="packing" value="${escapeHtml(e.packing)}" placeholder="0.00" /></td>
        <td><input class="money-input econ-input" inputmode="decimal" data-field="delivery" value="${escapeHtml(e.delivery)}" placeholder="0.00" /></td>
        <td class="js-profit">${result ? money(result.profit) : '—'}</td>
        <td class="js-margin margin ${result ? marginClass(result.margin) : ''}">${result ? `${result.margin.toFixed(1)}%` : '—'}</td>
      </tr>`;
    }).join('');

    $$('.econ-input').forEach(input => {
      input.addEventListener('input', event => {
        const row = event.target.closest('tr');
        const sku = row.dataset.sku;
        const field = event.target.dataset.field;
        state.economics[sku] = { ...getEconomics(sku), [field]: event.target.value };
        saveJson(STORAGE.economics, state.economics);
        const item = flattenProducts().find(x => x.sku === sku);
        const result = contribution(item);
        row.querySelector('.js-profit').textContent = result ? money(result.profit) : '—';
        const marginCell = row.querySelector('.js-margin');
        marginCell.textContent = result ? `${result.margin.toFixed(1)}%` : '—';
        marginCell.className = `js-margin margin ${result ? marginClass(result.margin) : ''}`;
        renderOverview();
      });
    });
  }

  function renderAutomations() {
    $('#automation-list').innerHTML = automationDefinitions.map(rule => {
      const enabled = Boolean(state.automations[rule.id]);
      return `<div class="rule"><div class="rule-main"><b>${escapeHtml(rule.name)}</b><small>${escapeHtml(rule.detail)}</small></div><button class="toggle ${enabled ? 'on' : ''}" data-automation="${rule.id}" aria-pressed="${enabled}" aria-label="Toggle ${escapeHtml(rule.name)}"></button></div>`;
    }).join('');

    $$('[data-automation]').forEach(button => {
      button.addEventListener('click', () => {
        const id = button.dataset.automation;
        state.automations[id] = !state.automations[id];
        saveJson(STORAGE.automations, state.automations);
        renderAutomations();
        renderOverview();
      });
    });
  }

  function renderApprovals() {
    $('#approval-list').innerHTML = approvals.map(([name, detail]) => `
      <div class="approval"><div class="approval-main"><b>${escapeHtml(name)}</b><small>${escapeHtml(detail)}</small></div><span class="tag warn">Approval required</span></div>`).join('');
  }

  function renderConnections() {
    $('#connection-list').innerHTML = connections.map(item => `
      <div class="connection"><div class="connection-main"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.detail)}</small></div><span class="tag ${item.status === 'ready' ? 'good' : 'warn'}">${item.status === 'ready' ? 'Ready' : 'Planned'}</span></div>`).join('');
  }

  function renderAll() {
    renderOverview();
    renderEconomics();
    renderAutomations();
    renderApprovals();
    renderConnections();
  }

  function setView(view) {
    $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
    $$('.view').forEach(section => section.classList.toggle('active', section.id === `view-${view}`));
    const titles = { overview: 'Command Centre', products: 'Products & Profit', automations: 'Automation Rules', approvals: 'Approval Centre', connections: 'Connections' };
    $('#page-title').textContent = titles[view] || 'Packsmart Ops';
  }

  async function loadCatalogue() {
    $('#refresh-products').disabled = true;
    $('#refresh-products').textContent = 'Refreshing…';
    try {
      const response = await fetch('../ebay-manager/shopify-products.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Catalogue HTTP ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.products)) throw new Error('Invalid catalogue payload');
      state.products = data.products;
      state.syncedAt = data.syncedAt || null;
      state.source = data.source || 'repository snapshot';
      renderAll();
    } catch (error) {
      console.error(error);
      state.products = [];
      renderAll();
      $('#ops-brief').textContent = 'The SaaS shell is running, but the Shopify catalogue snapshot could not be loaded from this host. Serve the repository root so the existing ebay-manager/shopify-products.json file is available.';
    } finally {
      $('#refresh-products').disabled = false;
      $('#refresh-products').textContent = 'Refresh catalogue';
    }
  }

  $$('.nav-item').forEach(item => item.addEventListener('click', () => setView(item.dataset.view)));
  $('#refresh-products').addEventListener('click', loadCatalogue);
  $('#product-search').addEventListener('input', event => { state.query = event.target.value; renderEconomics(); });
  $('#pack-filter').addEventListener('change', event => { state.packFilter = event.target.value; renderEconomics(); });

  renderAutomations();
  renderApprovals();
  renderConnections();
  loadCatalogue();
})();
