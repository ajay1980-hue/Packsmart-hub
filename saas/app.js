(() => {
  'use strict';

  const LOCAL = {
    economics: 'packsmart-saas-economics-v1',
    automations: 'packsmart-saas-automations-v1',
    migrated: 'packsmart-saas-cloud-migration-v3'
  };
  const state = {
    csrf: '', session: null, data: null, audit: [], view: 'overview',
    productQuery: '', productStatus: 'active', productSort: 'product',
    orderFilter: 'all', approvalFilter: 'pending'
  };
  let ownerActivationToken = '';
  try {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    ownerActivationToken = String(fragment.get('activate') || '');
    if (ownerActivationToken) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch {}

  const $ = selector => document.querySelector(selector);
  const $$ = selector => Array.from(document.querySelectorAll(selector));

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function money(value) {
    if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(value));
  }

  function percent(value) {
    return value === '' || value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(1) + '%';
  }

  function date(value, withTime) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '—';
    return new Intl.DateTimeFormat('en-GB', withTime === false ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' }).format(parsed);
  }

  function readLocal(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch { return fallback; }
  }

  function showMessage(message, type) {
    const isError = type === 'error';
    const target = isError ? $('#global-error') : $('#global-success');
    const other = isError ? $('#global-success') : $('#global-error');
    other.classList.add('hidden');
    target.textContent = message;
    target.classList.remove('hidden');
    clearTimeout(showMessage.timer);
    showMessage.timer = setTimeout(() => target.classList.add('hidden'), 6500);
  }

  async function request(path, options) {
    const config = options || {};
    const headers = new Headers(config.headers || {});
    const method = String(config.method || 'GET').toUpperCase();
    if (config.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (state.csrf && method !== 'GET' && method !== 'HEAD') headers.set('X-CSRF-Token', state.csrf);
    const response = await fetch(path, Object.assign({}, config, { headers, credentials: 'same-origin', cache: 'no-store' }));
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (response.status === 401 && !path.endsWith('/login') && !path.endsWith('/activate-owner')) {
      state.session = null; state.data = null; state.csrf = ''; showLogin();
    }
    if (!response.ok) {
      const error = new Error(payload.error || 'Request failed (' + response.status + ')');
      error.status = response.status; error.code = payload.code; throw error;
    }
    return payload;
  }

  function showLogin() {
    $('#login-screen').classList.remove('hidden');
    $('#password-screen').classList.add('hidden');
    $('#app-shell').classList.add('hidden');
  }

  function showPasswordSetup() {
    $('#login-screen').classList.add('hidden');
    $('#password-screen').classList.remove('hidden');
    $('#app-shell').classList.add('hidden');
  }

  function showApp() {
    $('#login-screen').classList.add('hidden');
    $('#password-screen').classList.add('hidden');
    $('#app-shell').classList.remove('hidden');
  }

  async function loadSession() {
    try {
      const session = await request('/api/auth/session');
      state.session = session; state.csrf = session.csrf;
      if (session.user && session.user.passwordChangeRequired) { showPasswordSetup(); return false; }
      return true;
    } catch (error) {
      if (error.status !== 401) $('#login-error').textContent = error.message;
      showLogin(); return false;
    }
  }

  async function migratePilotData() {
    if (localStorage.getItem(LOCAL.migrated)) return;
    const result = await request('/api/migrate-pilot', {
      method: 'POST',
      body: JSON.stringify({ migrationId: 'browser-pilot-v1', economics: readLocal(LOCAL.economics, {}), automations: readLocal(LOCAL.automations, {}), approvals: [] })
    });
    localStorage.setItem(LOCAL.migrated, JSON.stringify({ migratedAt: new Date().toISOString(), result }));
  }

  async function loadBootstrap(options) {
    const config = Object.assign({ migrate: true }, options || {});
    if (config.migrate) {
      try { await migratePilotData(); }
      catch (error) { showMessage('Pilot migration needs attention: ' + error.message, 'error'); }
    }
    const data = await request('/api/bootstrap');
    state.data = data; state.csrf = data.csrf || state.csrf;
    localStorage.setItem(LOCAL.economics, JSON.stringify(data.economics || {}));
    localStorage.setItem(LOCAL.automations, JSON.stringify(data.automations || {}));
    renderAll(); showApp();
  }

  function setBusy(button, busy, busyText) {
    if (!button) return;
    if (busy) { button.dataset.originalText = button.textContent; button.textContent = busyText; button.disabled = true; }
    else { button.textContent = button.dataset.originalText || button.textContent; button.disabled = false; }
  }

  function setView(view) {
    state.view = view;
    $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
    $$('.view').forEach(item => item.classList.toggle('active', item.id === 'view-' + view));
    const titles = { overview: 'Command Centre', profit: 'Products & Profit', orders: 'Order Profitability', suppliers: 'Suppliers & Costs', channels: 'Sales Channels', approvals: 'Approval Centre', automations: 'Automation Rules', issues: 'Operations Issues', audit: 'Audit & Account' };
    $('#page-title').textContent = titles[view] || 'Packsmart Ops';
    if (view === 'audit') {
      loadAudit().catch(error => showMessage(error.message, 'error'));
      loadBilling().catch(error => showMessage(error.message, 'error'));
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function applyTarget(view, filter) {
    if (view === 'profit' && filter) { state.productStatus = filter; $('#product-status').value = filter; renderProducts(); }
    if (view === 'orders' && filter) { state.orderFilter = filter; $('#order-filter').value = filter; renderOrders(); }
    if (view === 'approvals' && filter) { state.approvalFilter = filter; $('#approval-filter').value = filter; renderApprovals(); }
  }

  function statusClass(status) {
    if (['connected', 'ready', 'configured', 'deterministic', 'internal', 'profitable', 'confirmed-costs'].includes(status)) return 'good';
    if (['error', 'failed', 'loss-making'].includes(status)) return 'bad';
    if (['degraded', 'not_configured', 'dormant', 'configured_disabled', 'below-floor', 'missing-costs', 'incomplete', 'estimated-costs'].includes(status)) return 'warn';
    return 'neutral';
  }

  function statusLabel(status) {
    return String(status || 'unknown').replaceAll('_', ' ').replaceAll('-', ' ').replace(/\b\w/g, value => value.toUpperCase());
  }

  function metricRows(period) {
    return [
      ['Revenue', money(period.revenue)], ['Orders', period.orders || 0], ['Open', period.openOrders || 0],
      ['Gross profit', money(period.grossProfit)], ['Operating contribution', money(period.operatingProfit)],
      ['Margin', percent(period.margin)], ['Refunds', money(period.refunds)], ['Profit coverage', (period.profitCoverage || 0) + '%']
    ].map(item => '<div><span>' + escapeHtml(item[0]) + '</span><strong>' + escapeHtml(item[1]) + '</strong></div>').join('');
  }

  function channelCard(channel) {
    const metrics = channel.metrics30d;
    const metricHtml = metrics ? '<div class="channel-metrics"><span><b>' + escapeHtml(metrics.orders || 0) + '</b> orders</span><span><b>' + escapeHtml(money(metrics.revenue)) + '</b> revenue</span><span><b>' + escapeHtml(money(metrics.operatingProfit)) + '</b> contribution</span><span><b>' + escapeHtml(money(metrics.advertisingSpend)) + '</b> ads</span></div>' : '';
    const sync = channel.lastSyncAt ? 'Last sync ' + date(channel.lastSyncAt) : 'No successful live sync';
    return '<article class="channel-card"><div class="channel-icon">' + escapeHtml(channel.name.slice(0, 2).toUpperCase()) + '</div><div><b>' + escapeHtml(channel.name) + '</b><small>' + escapeHtml(channel.detail) + '</small><div class="capabilities">' + (channel.capabilities || []).map(item => '<span>' + escapeHtml(item) + '</span>').join('') + '</div>' + metricHtml + '<p class="channel-sync">' + escapeHtml(sync) + (channel.lastError ? ' · ' + escapeHtml(statusLabel(channel.lastError)) : '') + '</p></div><span class="tag ' + statusClass(channel.status) + '">' + escapeHtml(statusLabel(channel.status)) + '</span></article>';
  }

  function ranking(items, risk) {
    return items.length ? items.map(item => '<button class="ranking-row" data-view-link="profit" data-target-filter="' + (risk ? escapeHtml(item.status) : 'profitable') + '"><span><b>' + escapeHtml(item.productTitle) + '</b><small>' + escapeHtml(item.sku) + '</small></span><strong class="' + statusClass(item.status) + '">' + escapeHtml(money(item.contribution)) + '<small>' + escapeHtml(percent(item.margin)) + '</small></strong></button>').join('') : '<div class="empty-state">No fully costed products yet.</div>';
  }

  function renderOverview() {
    const dashboard = state.data.dashboard || {};
    const brief = state.data.brief || {};
    const today = dashboard.today || {};
    $('#brief-summary').textContent = brief.summary || 'No daily brief is available.';
    $('#brief-generated').textContent = brief.generatedAt ? 'Generated ' + date(brief.generatedAt) + ' · ' + (brief.logic || 'deterministic') : '';
    $('#readiness-score').textContent = String(dashboard.readiness || 0) + '%';
    $('#today-revenue').textContent = money(today.revenue);
    $('#today-orders').textContent = String(today.orders || 0);
    $('#today-open').textContent = String(today.openOrders || 0) + ' open';
    $('#today-profit').textContent = money(today.operatingProfit);
    $('#today-profit-coverage').textContent = 'coverage ' + String(today.profitCoverage || 0) + '%';
    $('#today-margin').textContent = percent(today.margin);
    $('#week-metrics').innerHTML = metricRows(dashboard.last7d || {});
    $('#month-metrics').innerHTML = metricRows(dashboard.last30d || {});
    $('#kpi-products').textContent = String(dashboard.products || 0);
    $('#kpi-variants').textContent = String(dashboard.variants || 0) + ' variants';
    $('#kpi-stock').textContent = String(dashboard.stockRisks || 0);
    $('#kpi-out-stock').textContent = String(dashboard.outOfStock || 0) + ' out of stock';
    $('#kpi-coverage').textContent = String(dashboard.costCoverage || 0) + '%';
    $('#kpi-missing-costs').textContent = String(dashboard.missingCosts || 0) + ' missing';
    $('#kpi-margin').textContent = percent(dashboard.averageMargin);
    $('#kpi-low-margin').textContent = String(dashboard.lowMargin || 0) + ' below floor';
    $('#kpi-loss').textContent = String(dashboard.negativeMargin || 0);
    $('#kpi-stock-value').textContent = money(dashboard.stockValue);
    $('#kpi-stock-value-coverage').textContent = 'coverage ' + String(dashboard.stockValueCoverage || 0) + '%';

    $('#priority-list').innerHTML = (dashboard.recommendations || []).map((item, index) => '<li><span class="priority-number">' + (index + 1) + '</span><button class="priority-link" data-view-link="' + escapeHtml(item.view || 'overview') + '" data-target-filter="' + escapeHtml(item.filter || '') + '"><b>' + escapeHtml(item.title) + '</b><small>' + escapeHtml(item.detail) + '</small></button><span class="tag ' + (item.actionType === 'safe' ? 'good">Safe' : 'warn">Approval') + '</span></li>').join('') || '<li class="empty-state">No recommended actions.</li>';
    $('#control-status').innerHTML = [
      ['Pending approvals', dashboard.pendingApprovals || 0, dashboard.pendingApprovals ? 'warn' : 'good'],
      ['Active automations', String(dashboard.activeAutomations || 0) + '/' + String(dashboard.automationCount || 0), dashboard.activeAutomations ? 'good' : 'warn'],
      ['SEO issues', dashboard.seoIssues || 0, dashboard.seoIssues ? 'warn' : 'good'],
      ['Customer-service issues', dashboard.customerServiceIssues || 0, dashboard.customerServiceIssues ? 'warn' : 'good'],
      ['Integration issues', dashboard.integrationIssues || 0, dashboard.integrationIssues ? 'warn' : 'good'],
      ['Ad spend · 30d', money(dashboard.advertising && dashboard.advertising.spend), 'neutral']
    ].map(item => '<div><span>' + escapeHtml(item[0]) + '</span><b class="' + item[2] + '">' + escapeHtml(item[1]) + '</b></div>').join('');
    $('#overview-channels').innerHTML = (state.data.integrations || []).filter(item => ['commerce', 'marketplace', 'social-commerce'].includes(item.kind)).map(channelCard).join('');
    $('#best-products').innerHTML = ranking(dashboard.mostProfitable || [], false);
    $('#risk-products').innerHTML = ranking([...(dashboard.negativeMarginItems || []), ...(dashboard.lowMarginItems || [])].slice(0, 10), true);
  }

  function inputValue(value) { return value === null || value === undefined ? '' : value; }

  function moneyInput(field, label, economics) {
    return '<label class="money-input"><span>£</span><input class="econ-input" data-field="' + field + '" inputmode="decimal" type="number" min="0" step="0.01" value="' + escapeHtml(inputValue(economics[field])) + '" aria-label="' + escapeHtml(label) + '"></label>';
  }

  function productMatches(item) {
    const filter = state.productStatus;
    if (filter === 'all') return true;
    if (filter === 'active') return String(item.productStatus).toLowerCase() === 'active';
    if (filter === 'missing-costs') return !item.complete;
    if (filter === 'profitable') return item.status === 'profitable';
    if (filter === 'below-floor') return item.status === 'below-floor';
    if (filter === 'loss-making') return item.status === 'loss-making';
    if (filter === 'low-stock') return item.inventory !== null && item.inventory <= Number(state.data.settings && state.data.settings.lowStockThreshold || 20);
    if (filter === 'out-of-stock') return item.inventory !== null && item.inventory <= 0;
    return true;
  }

  function sortProducts(items) {
    const rows = [...items];
    if (state.productSort === 'contribution-desc') rows.sort((a, b) => (b.contribution ?? -Infinity) - (a.contribution ?? -Infinity));
    else if (state.productSort === 'margin-desc') rows.sort((a, b) => (b.margin ?? -Infinity) - (a.margin ?? -Infinity));
    else if (state.productSort === 'revenue-desc') rows.sort((a, b) => (b.revenue30d || 0) - (a.revenue30d || 0));
    else if (state.productSort === 'units-desc') rows.sort((a, b) => (b.units30d || 0) - (a.units30d || 0));
    else if (state.productSort === 'stock-asc') rows.sort((a, b) => (a.inventory ?? Infinity) - (b.inventory ?? Infinity));
    else rows.sort((a, b) => (a.productTitle + a.title).localeCompare(b.productTitle + b.title));
    return rows;
  }

  function renderProducts() {
    const dashboard = state.data.dashboard || {};
    const lowStockThreshold = Number(state.data.settings && state.data.settings.lowStockThreshold || 20);
    const query = state.productQuery.toLowerCase();
    const products = sortProducts((dashboard.productRows || []).filter(item => {
      const matchesQuery = !query || (item.productTitle + ' ' + item.sku + ' ' + item.title).toLowerCase().includes(query);
      return matchesQuery && productMatches(item);
    }));
    const suppliers = state.data.suppliers || [];
    $('#economics-body').innerHTML = products.map(item => {
      const economics = state.data.economics && state.data.economics[item.sku] || {};
      const image = item.productImage ? '<img src="' + escapeHtml(item.productImage) + '" alt="">' : '<span class="image-placeholder">PS</span>';
      const supplierOptions = '<option value="">No supplier mapped</option>' + suppliers.map(supplier => '<option value="' + escapeHtml(supplier.id) + '"' + (economics.supplierId === supplier.id ? ' selected' : '') + '>' + escapeHtml(supplier.name) + '</option>').join('');
      const missingTitle = item.missingFields && item.missingFields.length ? item.missingFields.join(', ') : 'Complete cost coverage';
      return '<tr class="economics-row" data-sku="' + escapeHtml(item.sku) + '"><td><div class="product-cell">' + image + '<div><b>' + escapeHtml(item.productTitle) + '</b><small>' + escapeHtml(item.title) + ' · ' + escapeHtml(item.sku || 'No SKU') + '</small><small>30d: ' + escapeHtml(item.units30d || 0) + ' units · ' + escapeHtml(money(item.revenue30d)) + '</small></div></div></td><td class="numeric">' + money(item.price) + '</td><td class="numeric ' + (item.inventory !== null && item.inventory <= lowStockThreshold ? 'warn' : '') + '">' + (item.inventory == null ? '—' : escapeHtml(item.inventory)) + '</td><td><select class="econ-input compact-select" data-field="supplierId" aria-label="Supplier for ' + escapeHtml(item.sku) + '">' + supplierOptions + '</select></td><td>' + moneyInput('landed', 'Landed cost for ' + item.sku, economics) + '</td><td>' + moneyInput('packing', 'Packing cost for ' + item.sku, economics) + '</td><td>' + moneyInput('handling', 'Handling cost for ' + item.sku, economics) + '</td><td>' + moneyInput('delivery', 'Actual postage cost for ' + item.sku, economics) + '</td><td>' + moneyInput('paymentFee', 'Payment fee for ' + item.sku, economics) + '</td><td>' + moneyInput('channelFee', 'Channel fee for ' + item.sku, economics) + '</td><td>' + moneyInput('advertising', 'Advertising allocation for ' + item.sku, economics) + '</td><td>' + moneyInput('otherVariable', 'Other variable cost for ' + item.sku, economics) + '</td><td class="numeric">' + money(item.totalVariableCost) + '</td><td class="numeric ' + statusClass(item.status) + '">' + money(item.contribution) + '</td><td class="numeric ' + statusClass(item.status) + '">' + percent(item.margin) + '</td><td><span class="tag ' + statusClass(item.status) + '" title="' + escapeHtml(missingTitle) + '">' + escapeHtml(statusLabel(item.status)) + '</span><div class="table-actions"><button class="text-button cost-details" type="button">Supplier detail</button><button class="primary small-button save-economics" type="button">Save</button></div></td></tr>' +
        '<tr class="cost-detail-row hidden" data-sku="' + escapeHtml(item.sku) + '"><td colspan="16"><div class="cost-detail-grid"><label>Supplier SKU<input class="econ-input" data-field="supplierSku" value="' + escapeHtml(inputValue(economics.supplierSku)) + '"></label><label>Box quantity<input class="econ-input" data-field="boxQuantity" type="number" min="0" step="1" value="' + escapeHtml(inputValue(economics.boxQuantity)) + '"></label><label>Box price (£)<input class="econ-input" data-field="boxPrice" type="number" min="0" step="0.01" value="' + escapeHtml(inputValue(economics.boxPrice)) + '"></label><label>Supplier unit cost (£)<input class="econ-input" data-field="supplierUnitCost" type="number" min="0" step="0.0001" value="' + escapeHtml(inputValue(economics.supplierUnitCost)) + '"></label><label>Delivery allocation / unit (£)<input class="econ-input" data-field="supplierDelivery" type="number" min="0" step="0.0001" value="' + escapeHtml(inputValue(economics.supplierDelivery)) + '"></label><label>Supplier VAT rate (%)<input class="econ-input" data-field="supplierVatRate" type="number" min="0" max="100" step="0.1" value="' + escapeHtml(inputValue(economics.supplierVatRate)) + '"></label><label>VAT recoverable<select class="econ-input" data-field="supplierVatRecoverable"><option value=""' + (economics.supplierVatRecoverable == null ? ' selected' : '') + '>Unknown</option><option value="true"' + (economics.supplierVatRecoverable === true ? ' selected' : '') + '>Yes</option><option value="false"' + (economics.supplierVatRecoverable === false ? ' selected' : '') + '>No</option></select></label><label>Margin floor (%)<input class="econ-input" data-field="marginFloor" type="number" min="0" max="100" step="0.1" value="' + escapeHtml(inputValue(economics.marginFloor)) + '"></label><label class="detail-notes">Notes<textarea class="econ-input" data-field="notes">' + escapeHtml(inputValue(economics.notes)) + '</textarea></label></div><p class="muted tiny">If landed cost is blank, it is derived only when unit/box cost, supplier delivery, VAT rate and VAT recovery treatment are all known.</p></td></tr>';
    }).join('') || '<tr><td colspan="16" class="empty-state">No products match this filter.</td></tr>';
  }

  function orderMatches(order) {
    const p = order.profitability || {};
    if (state.orderFilter === 'all') return true;
    if (state.orderFilter === 'open') return !['FULFILLED', 'RESTOCKED'].includes(String(order.fulfillmentStatus).toUpperCase());
    if (state.orderFilter === 'refunded') return Number(p.refunds || 0) > 0 || String(order.financialStatus).includes('REFUND');
    if (state.orderFilter === 'missing-profit') return !p.complete;
    if (state.orderFilter === 'profitable') return p.complete && p.contribution >= 0;
    if (state.orderFilter === 'loss-making') return p.complete && p.contribution < 0;
    if (state.orderFilter === 'today') return new Date(order.createdAt).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
    return true;
  }

  function costField(label, field, order) {
    return '<label>' + escapeHtml(label) + '<input class="order-cost-input" data-field="' + field + '" type="number" min="0" step="0.01" value="' + escapeHtml(inputValue(order[field])) + '" placeholder="Unknown"></label>';
  }

  function renderOrders() {
    const dashboard = state.data.dashboard || {};
    const month = dashboard.last30d || {};
    $('#orders-revenue').textContent = money(month.revenue);
    $('#orders-total').textContent = String(month.orders || 0);
    $('#orders-open').textContent = String(month.openOrders || 0) + ' open';
    $('#orders-refunds-value').textContent = money(month.refunds);
    $('#orders-refunded').textContent = String(dashboard.refundedOrders30d || 0) + ' affected orders';
    $('#orders-profit').textContent = money(month.operatingProfit);
    $('#orders-profit-coverage').textContent = String(month.profitCoverage || 0) + '%';
    const orders = (dashboard.orderProfitability || []).filter(orderMatches);
    $('#order-list').innerHTML = orders.length ? orders.slice(0, 250).map(order => {
      const p = order.profitability || {};
      const profitStatus = !p.complete ? 'incomplete' : p.contribution < 0 ? 'loss-making' : 'profitable';
      const missing = (p.missingFields || []).length ? '<div class="missing-inputs"><b>Missing inputs</b><span>' + escapeHtml(p.missingFields.join(' · ')) + '</span></div>' : '';
      const lines = (p.lines || []).length ? p.lines.map(line => '<div><span>' + escapeHtml(line.name) + '<small>' + escapeHtml(line.sku || 'No SKU') + ' × ' + escapeHtml(line.quantity) + '</small></span><strong>' + escapeHtml(money(line.netSales)) + '</strong></div>').join('') : '<div class="empty-state">Line items have not been imported.</div>';
      return '<details class="order-profit-card" data-order-id="' + escapeHtml(order.id) + '"><summary><div><b>' + escapeHtml(order.name || order.id) + '</b><small>' + date(order.createdAt) + ' · ' + escapeHtml(statusLabel(order.provider || 'shopify')) + '</small></div><div class="order-state"><span class="tag ' + statusClass(order.financialStatus === 'REFUNDED' ? 'loss-making' : order.financialStatus === 'PAID' ? 'connected' : 'degraded') + '">' + escapeHtml(statusLabel(order.financialStatus)) + '</span><span class="tag ' + statusClass(order.fulfillmentStatus === 'FULFILLED' ? 'connected' : 'degraded') + '">' + escapeHtml(statusLabel(order.fulfillmentStatus)) + '</span></div><div class="order-total"><strong>' + escapeHtml(money(p.netRevenue)) + '</strong><span class="' + statusClass(profitStatus) + '">' + escapeHtml(money(p.contribution)) + '</span></div></summary><div class="order-detail"><div class="order-metrics"><div><span>Gross order</span><b>' + money(p.grossRevenue) + '</b></div><div><span>Discounts</span><b>' + money(p.discounts) + '</b></div><div><span>Refunds</span><b>' + money(p.refunds) + '</b></div><div><span>VAT / tax</span><b>' + money(p.tax) + '</b></div><div><span>Customer shipping</span><b>' + money(p.shippingCharged) + '</b></div><div><span>Variable costs</span><b>' + money(p.totalVariableCost) + '</b></div><div><span>Gross profit</span><b>' + money(p.grossProfit) + '</b></div><div><span>Operating contribution</span><b class="' + statusClass(profitStatus) + '">' + money(p.contribution) + '</b></div><div><span>Margin</span><b>' + percent(p.margin) + '</b></div><div><span>Basis</span><b>' + escapeHtml(statusLabel(p.basis)) + '</b></div></div>' + missing + '<div class="order-detail-grid"><div><h3>Order lines</h3><div class="line-item-list">' + lines + '</div></div><div><h3>Actual business costs</h3><div class="order-cost-grid">' + costField('Actual shipping (£)', 'actualShippingCost', order) + costField('Payment fees (£)', 'paymentFees', order) + costField('Channel fees (£)', 'channelFees', order) + costField('Advertising (£)', 'advertisingCost', order) + costField('Other variable (£)', 'otherVariableCosts', order) + '</div><button class="primary small-button save-order-costs" type="button">Save order costs</button></div></div></div></details>';
    }).join('') : '<div class="empty-state">No orders match this filter. Live order data appears after a read-only channel connection.</div>';
  }

  function approvalCard(item) {
    const pending = item.status === 'pending';
    const actions = pending ? '<div class="approval-actions"><button class="secondary danger" data-approval="' + escapeHtml(item.id) + '" data-decision="rejected">Reject</button><button class="primary" data-approval="' + escapeHtml(item.id) + '" data-decision="approved">Approve</button></div>' : '<p class="decision-note">Decision recorded ' + date(item.decidedAt) + ' · External execution: disabled</p>';
    return '<article class="approval-card"><div class="approval-title"><div><span class="tag ' + (pending ? 'warn' : item.status === 'approved' ? 'good' : 'bad') + '">' + escapeHtml(statusLabel(item.status)) + '</span><h3>' + escapeHtml(item.action || statusLabel(item.type)) + '</h3></div><strong>' + (item.financialImpact == null ? 'Impact not quantified' : money(item.financialImpact)) + '</strong></div><dl><div><dt>Reason</dt><dd>' + escapeHtml(item.reason || '—') + '</dd></div><div><dt>Expected benefit</dt><dd>' + escapeHtml(item.expectedBenefit || '—') + '</dd></div><div><dt>Risk</dt><dd>' + escapeHtml(item.risk || '—') + '</dd></div><div><dt>Requested by</dt><dd>' + escapeHtml(item.requestedBy || 'system') + ' · ' + escapeHtml(item.source || 'Packsmart Ops') + ' · ' + date(item.createdAt) + '</dd></div></dl>' + actions + '</article>';
  }

  function renderApprovals() {
    const approvals = (state.data.approvals || []).filter(item => state.approvalFilter === 'all' || item.status === state.approvalFilter);
    $('#approval-list').innerHTML = approvals.length ? approvals.map(approvalCard).join('') : '<div class="empty-state">No approval requests match this view.</div>';
    const pending = (state.data.approvals || []).filter(item => item.status === 'pending').length;
    $('#nav-approval-count').textContent = String(pending); $('#nav-approval-count').classList.toggle('hidden', !pending);
  }

  function renderAutomations() {
    $('#automation-list').innerHTML = (state.data.automationDefinitions || []).map(rule => {
      const enabled = Boolean(state.data.automations && state.data.automations[rule.id]);
      return '<div class="rule"><div><b>' + escapeHtml(rule.name) + '</b><small>' + escapeHtml(rule.detail) + '</small></div><button class="toggle ' + (enabled ? 'on' : '') + '" data-automation="' + escapeHtml(rule.id) + '" aria-pressed="' + enabled + '" aria-label="Toggle ' + escapeHtml(rule.name) + '"><span></span></button></div>';
    }).join('');
  }

  function renderChannels() {
    $('#channel-grid').innerHTML = (state.data.integrations || []).map(channelCard).join('');
    const ebay = state.data.ebay;
    if (!ebay) { $('#ebay-health').innerHTML = '<div class="empty-state">The existing eBay Manager has not yet been verified from Packsmart Ops. No duplicate OAuth setup will be created.</div>'; return; }
    $('#ebay-health').innerHTML = [
      ['Connected account', ebay.account || '—'], ['Listings', ebay.listings && ebay.listings.length || 0], ['Drafts', ebay.drafts && ebay.drafts.length || 0],
      ['Orders', (state.data.orders || []).filter(order => order.provider === 'ebay').length], ['Fee records', ebay.fees && ebay.fees.length || 0], ['Promotions', ebay.promotions && ebay.promotions.length || 0],
      ['Missing on eBay', ebay.health && ebay.health.missingOnEbay && ebay.health.missingOnEbay.length || 0], ['Stale on eBay', ebay.health && ebay.health.staleOnEbay && ebay.health.staleOnEbay.length || 0], ['Last read sync', date(ebay.syncedAt)]
    ].map(item => '<div><span>' + escapeHtml(item[0]) + '</span><b>' + escapeHtml(item[1]) + '</b></div>').join('');
  }

  function renderSuppliers() {
    const suppliers = state.data.suppliers || [];
    $('#supplier-list').innerHTML = suppliers.length ? suppliers.map(item => '<article class="supplier-row"><span class="channel-icon">' + escapeHtml(item.name.slice(0, 2).toUpperCase()) + '</span><div><b>' + escapeHtml(item.name) + '</b><small>' + escapeHtml(item.notes || 'No notes') + '</small></div><span class="tag ' + (item.active === false ? 'neutral' : 'good') + '">' + (item.active === false ? 'Inactive' : 'Active') + '</span></article>').join('') : '<div class="empty-state">No suppliers recorded.</div>';
    const shipping = state.data.shippingProviders || [];
    $('#shipping-provider-list').innerHTML = shipping.length ? shipping.map(item => '<div><span>' + escapeHtml(item.name) + '</span><b class="' + (item.active === false ? 'neutral' : 'good') + '">' + (item.active === false ? 'Inactive' : 'Supported') + '</b></div>').join('') : '<div class="empty-state">No delivery providers recorded.</div>';
    const history = state.data.costHistory || [];
    $('#cost-history-list').innerHTML = history.length ? history.slice(0, 100).map(event => '<div class="audit-row"><span class="audit-dot"></span><div><b>' + escapeHtml(event.sku) + '</b><small>' + escapeHtml((event.changedFields || []).join(', ')) + ' · ' + date(event.createdAt) + '</small></div><code>' + escapeHtml(event.changedBy || 'system') + '</code></div>').join('') : '<div class="empty-state">Cost changes will be recorded here.</div>';
  }

  function issueRows(items, template) {
    return items.length ? items.map(template).join('') : '<div class="empty-state">No issues detected.</div>';
  }

  function renderIssues() {
    const d = state.data.dashboard || {};
    $('#seo-issue-list').innerHTML = issueRows(d.seoIssueItems || [], item => '<button class="issue-row" data-view-link="profit" data-target-filter="all"><span><b>' + escapeHtml(item.product) + '</b><small>' + escapeHtml(item.issue) + '</small></span><span class="tag warn">Review</span></button>');
    $('#customer-issue-list').innerHTML = issueRows(d.customerServiceItems || [], item => '<button class="issue-row" data-view-link="orders" data-target-filter="open"><span><b>' + escapeHtml(item.name || item.id) + '</b><small>' + escapeHtml(statusLabel(item.financialStatus)) + ' · ' + escapeHtml(statusLabel(item.fulfillmentStatus)) + ' · ' + date(item.createdAt) + '</small></span><span class="tag warn">Review</span></button>');
    $('#stock-issue-list').innerHTML = issueRows(d.stockRiskItems || [], item => '<button class="issue-row" data-view-link="profit" data-target-filter="low-stock"><span><b>' + escapeHtml(item.productTitle) + '</b><small>' + escapeHtml(item.sku) + ' · stock ' + escapeHtml(item.inventory) + '</small></span><span class="tag ' + (item.inventory <= 0 ? 'bad' : 'warn') + '">' + (item.inventory <= 0 ? 'Out' : 'Low') + '</span></button>');
    $('#cost-issue-list').innerHTML = issueRows(d.missingCostItems || [], item => '<button class="issue-row" data-view-link="profit" data-target-filter="missing-costs"><span><b>' + escapeHtml(item.productTitle) + '</b><small>' + escapeHtml(item.sku) + ' · ' + escapeHtml((item.missingFields || []).join(', ')) + '</small></span><span class="tag warn">Incomplete</span></button>');
  }

  function renderAccount() {
    const user = state.data.user || {}; const workspace = state.data.workspace || {};
    $('#account-workspace').textContent = workspace.name || 'Workspace';
    $('#account-details').innerHTML = [
      ['Owner', user.email || '—'], ['Role', statusLabel(user.role)], ['Workspace ID', workspace.id || '—'],
      ['Persistence', state.data.storage === 'supabase' ? 'Supabase cloud' : 'Development file store'], ['Session', 'Secure HTTP-only cookie'], ['App version', state.data.version || '—']
    ].map(item => '<div><span>' + escapeHtml(item[0]) + '</span><b>' + escapeHtml(item[1]) + '</b></div>').join('');
  }

  function renderAll() {
    const cloud = state.data.storage === 'supabase';
    $('#storage-badge').textContent = cloud ? 'Cloud persistent' : 'Server fallback';
    $('#storage-badge').className = 'tag ' + (cloud ? 'good' : 'warn');
    renderOverview(); renderProducts(); renderOrders(); renderSuppliers(); renderApprovals(); renderAutomations(); renderChannels(); renderIssues(); renderAccount();
  }

  async function loadAudit() {
    const payload = await request('/api/audit?limit=250'); state.audit = payload.events || [];
    $('#audit-list').innerHTML = state.audit.length ? state.audit.map(event => '<div class="audit-row"><span class="audit-dot"></span><div><b>' + escapeHtml(statusLabel(event.type)) + '</b><small>' + escapeHtml(event.actor) + ' · ' + date(event.createdAt) + '</small></div><code>' + escapeHtml(JSON.stringify(event.detail || {})) + '</code></div>').join('') : '<div class="empty-state">No audit events.</div>';
  }

  async function loadBilling() {
    const billing = await request('/api/billing');
    $('#billing-status').innerHTML = [
      ['Current plan', billing.subscription && billing.subscription.plan || '—'], ['Current status', billing.subscription && billing.subscription.status || '—'],
      ['Packsmart charge', billing.customerZeroFree ? '£0 · internal testing' : 'Not started'], ['Checkout', billing.checkoutEnabled ? 'Enabled' : 'Disabled']
    ].map(item => '<div><span>' + escapeHtml(item[0]) + '</span><b>' + escapeHtml(statusLabel(item[1])) + '</b></div>').join('');
    $('#plan-grid').innerHTML = Object.entries(billing.plans || {}).map(([id, plan]) => '<div class="plan"><b>' + escapeHtml(plan.name) + '</b><strong>~£' + escapeHtml(plan.indicativeMonthlyGbp) + '<small>/mo</small></strong><span>' + escapeHtml((plan.features || []).join(' · ')) + '</span><em>' + escapeHtml(id) + '</em></div>').join('');
  }

  async function saveEconomics(button) {
    const main = button.closest('tr'); const sku = main.dataset.sku;
    const rows = Array.from($('#economics-body').querySelectorAll('tr')).filter(row => row.dataset.sku === sku);
    const economics = {};
    rows.flatMap(row => Array.from(row.querySelectorAll('.econ-input'))).forEach(field => { economics[field.dataset.field] = field.value; });
    setBusy(button, true, 'Saving…');
    try { await request('/api/economics', { method: 'PUT', body: JSON.stringify({ sku, economics }) }); await loadBootstrap({ migrate: false }); showMessage('Costs saved to the Packsmart cloud workspace.'); }
    catch (error) { showMessage(error.message, 'error'); setBusy(button, false); }
  }

  async function saveOrderCosts(button) {
    const card = button.closest('[data-order-id]'); const costs = {};
    card.querySelectorAll('.order-cost-input').forEach(input => { costs[input.dataset.field] = input.value; });
    setBusy(button, true, 'Saving…');
    try { await request('/api/orders/' + encodeURIComponent(card.dataset.orderId) + '/economics', { method: 'PUT', body: JSON.stringify(costs) }); await loadBootstrap({ migrate: false }); showMessage('Actual order costs saved and profitability recalculated.'); }
    catch (error) { showMessage(error.message, 'error'); setBusy(button, false); }
  }

  async function syncProvider(provider, button) {
    setBusy(button, true, 'Syncing…');
    try { await request('/api/integrations/' + provider + '/sync', { method: 'POST', body: '{}' }); await loadBootstrap({ migrate: false }); showMessage(statusLabel(provider) + ' read-only sync completed.'); }
    catch (error) { showMessage(error.message, 'error'); }
    finally { setBusy(button, false); }
  }

  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); const error = $('#login-error'); error.textContent = ''; setBusy(button, true, 'Signing in…');
    try { const payload = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: form.email.value, password: form.password.value }) }); state.session = payload; state.csrf = payload.csrf; form.password.value = ''; if (payload.user && payload.user.passwordChangeRequired) showPasswordSetup(); else await loadBootstrap(); }
    catch (loginError) { error.textContent = loginError.message; }
    finally { setBusy(button, false); }
  });

  $('#password-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); const error = $('#password-error'); error.textContent = '';
    if (form.newPassword.value !== form.confirmPassword.value) { error.textContent = 'The two passwords do not match.'; return; }
    setBusy(button, true, 'Securing account…');
    try { const activation = Boolean(ownerActivationToken); const payload = await request(activation ? '/api/auth/activate-owner' : '/api/auth/change-password', { method: 'POST', body: JSON.stringify(activation ? { token: ownerActivationToken, newPassword: form.newPassword.value } : { newPassword: form.newPassword.value }) }); state.session = payload; state.csrf = payload.csrf; ownerActivationToken = ''; form.reset(); await loadBootstrap(); showMessage('Owner password secured and temporary sessions revoked.'); }
    catch (passwordError) { error.textContent = passwordError.message; }
    finally { setBusy(button, false); }
  });

  $('#main-nav').addEventListener('click', event => { const button = event.target.closest('[data-view]'); if (button) setView(button.dataset.view); });
  document.addEventListener('click', event => {
    const link = event.target.closest('[data-view-link]');
    if (link) { event.preventDefault(); setView(link.dataset.viewLink); applyTarget(link.dataset.viewLink, link.dataset.targetFilter); }
  });
  $('#product-search').addEventListener('input', event => { state.productQuery = event.target.value; renderProducts(); });
  $('#product-status').addEventListener('change', event => { state.productStatus = event.target.value; renderProducts(); });
  $('#product-sort').addEventListener('change', event => { state.productSort = event.target.value; renderProducts(); });
  $('#order-filter').addEventListener('change', event => { state.orderFilter = event.target.value; renderOrders(); });
  $('#approval-filter').addEventListener('change', event => { state.approvalFilter = event.target.value; renderApprovals(); });

  $('#economics-body').addEventListener('click', event => {
    const detail = event.target.closest('.cost-details');
    if (detail) { const row = detail.closest('tr'); const next = row.nextElementSibling; if (next && next.classList.contains('cost-detail-row')) next.classList.toggle('hidden'); return; }
    const save = event.target.closest('.save-economics'); if (save) saveEconomics(save);
  });
  $('#order-list').addEventListener('click', event => { const save = event.target.closest('.save-order-costs'); if (save) { event.preventDefault(); saveOrderCosts(save); } });

  $('#automation-list').addEventListener('click', async event => {
    const button = event.target.closest('[data-automation]'); if (!button) return; const id = button.dataset.automation; const enabled = !Boolean(state.data.automations[id]); button.disabled = true;
    try { await request('/api/automations', { method: 'PUT', body: JSON.stringify({ id, enabled }) }); state.data.automations[id] = enabled; localStorage.setItem(LOCAL.automations, JSON.stringify(state.data.automations)); renderAutomations(); }
    catch (error) { button.disabled = false; showMessage(error.message, 'error'); }
  });

  $('#supplier-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); const error = $('#supplier-form-error'); error.textContent = ''; setBusy(button, true, 'Adding…');
    try { await request('/api/suppliers', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.reset(); await loadBootstrap({ migrate: false }); showMessage('Supplier added to this workspace.'); }
    catch (supplierError) { error.textContent = supplierError.message; }
    finally { setBusy(button, false); }
  });

  $('#advertising-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); const error = $('#advertising-form-error'); error.textContent = ''; setBusy(button, true, 'Recording…');
    try { await request('/api/advertising-costs', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) }); form.reset(); await loadBootstrap({ migrate: false }); showMessage('Confirmed advertising spend recorded. No campaign was changed.'); }
    catch (adError) { error.textContent = adError.message; }
    finally { setBusy(button, false); }
  });

  $('#approval-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); $('#approval-form-error').textContent = ''; setBusy(button, true, 'Creating request…');
    const values = Object.fromEntries(new FormData(form));
    try { const payload = await request('/api/actions', { method: 'POST', body: JSON.stringify(Object.assign({}, values, { source: 'owner-command-centre' })) }); state.data.approvals.unshift(payload.approval); form.reset(); renderApprovals(); showMessage('Approval request created. No external action was executed.'); }
    catch (error) { $('#approval-form-error').textContent = error.message; }
    finally { setBusy(button, false); }
  });

  $('#approval-list').addEventListener('click', async event => {
    const button = event.target.closest('[data-approval]'); if (!button) return; setBusy(button, true, button.dataset.decision === 'approved' ? 'Approving…' : 'Rejecting…');
    try { const payload = await request('/api/approvals/' + encodeURIComponent(button.dataset.approval) + '/decision', { method: 'POST', body: JSON.stringify({ decision: button.dataset.decision }) }); const index = state.data.approvals.findIndex(item => item.id === payload.approval.id); if (index >= 0) state.data.approvals[index] = payload.approval; renderApprovals(); showMessage(statusLabel(payload.approval.status) + ' recorded. External execution remains disabled.'); }
    catch (error) { showMessage(error.message, 'error'); setBusy(button, false); }
  });

  $('#sync-shopify').addEventListener('click', event => syncProvider('shopify', event.currentTarget));
  $('#sync-ebay').addEventListener('click', event => syncProvider('ebay', event.currentTarget));
  $('#sync-all-channels').addEventListener('click', async event => { const button = event.currentTarget; setBusy(button, true, 'Syncing…'); try { await request('/api/integrations/sync', { method: 'POST', body: '{}' }); await loadBootstrap({ migrate: false }); showMessage('All available commerce sources refreshed read-only.'); } catch (error) { showMessage(error.message, 'error'); } finally { setBusy(button, false); } });
  $('#refresh-all').addEventListener('click', async event => { const button = event.currentTarget; setBusy(button, true, 'Refreshing…'); try { await request('/api/integrations/sync', { method: 'POST', body: '{}' }); await loadBootstrap({ migrate: false }); showMessage('Packsmart operations data refreshed.'); } catch (error) { showMessage(error.message, 'error'); } finally { setBusy(button, false); } });
  $('#refresh-audit').addEventListener('click', event => { const button = event.currentTarget; setBusy(button, true, 'Refreshing…'); loadAudit().catch(error => showMessage(error.message, 'error')).finally(() => setBusy(button, false)); });
  $('#logout').addEventListener('click', async () => { try { await request('/api/auth/logout', { method: 'POST', body: '{}' }); } finally { state.session = null; state.data = null; state.csrf = ''; showLogin(); } });
  $('#show-password-change').addEventListener('click', () => $('#account-password-form').classList.toggle('hidden'));
  $('#account-password-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); const error = form.querySelector('.form-error'); error.textContent = ''; setBusy(button, true, 'Updating…');
    try { const payload = await request('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: form.currentPassword.value, newPassword: form.newPassword.value }) }); state.csrf = payload.csrf; form.reset(); form.classList.add('hidden'); showMessage('Password updated and older sessions revoked.'); }
    catch (passwordError) { error.textContent = passwordError.message; }
    finally { setBusy(button, false); }
  });

  (async () => {
    try { const health = await request('/api/health'); if (!health.ok) throw new Error('Packsmart Ops health check is not ready.'); if (ownerActivationToken) { showPasswordSetup(); return; } if (await loadSession()) await loadBootstrap(); }
    catch (error) { $('#login-error').textContent = error.status === 401 ? '' : error.message; showLogin(); }
  })();
})();
