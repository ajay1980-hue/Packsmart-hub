(() => {
  'use strict';

  const LOCAL = {
    economics: 'packsmart-saas-economics-v1',
    automations: 'packsmart-saas-automations-v1',
    migrated: 'packsmart-saas-cloud-migration-v3'
  };
  const state = {
    csrf: '',
    session: null,
    data: null,
    audit: [],
    view: 'overview',
    productQuery: '',
    productStatus: 'active',
    approvalFilter: 'pending'
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
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function money(value) {
    const number = Number(value);
    return Number.isFinite(number)
      ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(number)
      : '—';
  }

  function date(value, withTime) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '—';
    return new Intl.DateTimeFormat('en-GB', withTime === false
      ? { dateStyle: 'medium' }
      : { dateStyle: 'medium', timeStyle: 'short' }
    ).format(parsed);
  }

  function readLocal(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
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
    const response = await fetch(path, Object.assign({}, config, {
      headers: headers,
      credentials: 'same-origin',
      cache: 'no-store'
    }));
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (response.status === 401 && !path.endsWith('/login') && !path.endsWith('/activate-owner')) {
      state.session = null;
      state.data = null;
      state.csrf = '';
      showLogin();
    }
    if (!response.ok) {
      const error = new Error(payload.error || 'Request failed (' + response.status + ')');
      error.status = response.status;
      error.code = payload.code;
      throw error;
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
      state.session = session;
      state.csrf = session.csrf;
      if (session.user && session.user.passwordChangeRequired) {
        showPasswordSetup();
        return false;
      }
      return true;
    } catch (error) {
      if (error.status !== 401) $('#login-error').textContent = error.message;
      showLogin();
      return false;
    }
  }

  async function migratePilotData() {
    if (localStorage.getItem(LOCAL.migrated)) return;
    const result = await request('/api/migrate-pilot', {
      method: 'POST',
      body: JSON.stringify({
        migrationId: 'browser-pilot-v1',
        economics: readLocal(LOCAL.economics, {}),
        automations: readLocal(LOCAL.automations, {}),
        approvals: []
      })
    });
    localStorage.setItem(LOCAL.migrated, JSON.stringify({
      migratedAt: new Date().toISOString(),
      result: result
    }));
  }

  async function loadBootstrap(options) {
    const config = Object.assign({ migrate: true }, options || {});
    if (config.migrate) {
      try { await migratePilotData(); }
      catch (error) { showMessage('Pilot migration needs attention: ' + error.message, 'error'); }
    }
    const data = await request('/api/bootstrap');
    state.data = data;
    state.csrf = data.csrf || state.csrf;
    localStorage.setItem(LOCAL.economics, JSON.stringify(data.economics || {}));
    localStorage.setItem(LOCAL.automations, JSON.stringify(data.automations || {}));
    renderAll();
    showApp();
  }

  function setBusy(button, busy, busyText) {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = busyText;
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalText || button.textContent;
      button.disabled = false;
    }
  }

  function setView(view) {
    state.view = view;
    $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
    $$('.view').forEach(item => item.classList.toggle('active', item.id === 'view-' + view));
    const titles = {
      overview: 'Command Centre',
      profit: 'Products & Profit',
      orders: 'Orders',
      approvals: 'Approval Centre',
      automations: 'Automation Rules',
      channels: 'Sales Channels',
      audit: 'Audit & Account'
    };
    $('#page-title').textContent = titles[view] || 'Packsmart Ops';
    if (view === 'audit') {
      loadAudit().catch(error => showMessage(error.message, 'error'));
      loadBilling().catch(error => showMessage(error.message, 'error'));
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function statusClass(status) {
    if (['connected', 'ready', 'configured', 'deterministic', 'internal'].includes(status)) return 'good';
    if (['error', 'failed'].includes(status)) return 'bad';
    if (['degraded', 'not_configured', 'dormant', 'configured_disabled'].includes(status)) return 'warn';
    return 'neutral';
  }

  function statusLabel(status) {
    return String(status || 'unknown').replaceAll('_', ' ').replace(/\b\w/g, value => value.toUpperCase());
  }

  function flattenProducts() {
    return (state.data && state.data.products || []).flatMap(product => (product.variants || []).map(variant => Object.assign({}, variant, {
      productId: product.id,
      productTitle: product.title,
      productStatus: product.status,
      productImage: product.image,
      productType: product.productType
    })));
  }

  function contribution(item) {
    const economics = state.data && state.data.economics && state.data.economics[item.sku] || {};
    if (economics.landed === '' || economics.landed == null) return null;
    const costs = ['landed', 'packing', 'delivery', 'channelFee']
      .reduce((sum, field) => sum + (Number(economics[field]) || 0), 0);
    const amount = Number(item.price || 0) - costs;
    const margin = Number(item.price) > 0 ? amount / Number(item.price) * 100 : 0;
    return { amount: amount, margin: margin };
  }

  function channelCard(channel) {
    return '<article class="channel-card">' +
      '<div class="channel-icon">' + escapeHtml(channel.name.slice(0, 2).toUpperCase()) + '</div>' +
      '<div><b>' + escapeHtml(channel.name) + '</b><small>' + escapeHtml(channel.detail) + '</small>' +
      '<div class="capabilities">' + (channel.capabilities || []).map(item => '<span>' + escapeHtml(item) + '</span>').join('') + '</div></div>' +
      '<span class="tag ' + statusClass(channel.status) + '">' + escapeHtml(statusLabel(channel.status)) + '</span></article>';
  }

  function renderOverview() {
    const dashboard = state.data.dashboard || {};
    const brief = state.data.brief || {};
    $('#brief-summary').textContent = brief.summary || 'No daily brief is available.';
    $('#brief-generated').textContent = brief.generatedAt
      ? 'Generated ' + date(brief.generatedAt) + ' · ' + (brief.logic || 'deterministic')
      : '';
    $('#readiness-score').textContent = String(dashboard.readiness || 0) + '%';
    $('#kpi-revenue').textContent = money(dashboard.revenue30d);
    $('#kpi-orders').textContent = String(dashboard.orders30d || 0);
    $('#kpi-open-orders').textContent = String(dashboard.openOrders || 0) + ' open';
    $('#kpi-products').textContent = String(dashboard.products || 0);
    $('#kpi-variants').textContent = String(dashboard.variants || 0) + ' variants';
    $('#kpi-stock').textContent = String(dashboard.stockRisks || 0);
    $('#kpi-coverage').textContent = String(dashboard.costCoverage || 0) + '%';
    $('#kpi-missing-costs').textContent = String(dashboard.missingCosts || 0) + ' missing';
    $('#kpi-margin').textContent = dashboard.averageMargin == null ? '—' : dashboard.averageMargin + '%';
    $('#kpi-low-margin').textContent = String(dashboard.lowMargin || 0) + ' below floor';

    $('#priority-list').innerHTML = (dashboard.recommendations || []).map((item, index) =>
      '<li><span class="priority-number">' + (index + 1) + '</span><div><b>' + escapeHtml(item.title) +
      '</b><small>' + escapeHtml(item.detail) + '</small></div><span class="tag ' +
      (item.actionType === 'safe' ? 'good">Safe' : 'warn">Approval') + '</span></li>'
    ).join('') || '<li class="empty-state">No recommended actions.</li>';

    $('#control-status').innerHTML = [
      ['Pending approvals', dashboard.pendingApprovals || 0, dashboard.pendingApprovals ? 'warn' : 'good'],
      ['Active automations', String(dashboard.activeAutomations || 0) + '/' + String(dashboard.automationCount || 0), dashboard.activeAutomations ? 'good' : 'warn'],
      ['SEO issues', dashboard.seoIssues || 0, dashboard.seoIssues ? 'warn' : 'good'],
      ['Customer-service issues', dashboard.customerServiceIssues || 0, dashboard.customerServiceIssues ? 'warn' : 'good']
    ].map(item => '<div><span>' + escapeHtml(item[0]) + '</span><b class="' + item[2] + '">' + escapeHtml(item[1]) + '</b></div>').join('');

    $('#overview-channels').innerHTML = (state.data.integrations || [])
      .filter(item => ['shopify', 'ebay', 'meta', 'tiktok_shop'].includes(item.id))
      .map(channelCard).join('');
  }

  function renderProducts() {
    const query = state.productQuery.toLowerCase();
    const products = flattenProducts().filter(item => {
      const matchesQuery = !query || (item.productTitle + ' ' + item.sku + ' ' + item.title).toLowerCase().includes(query);
      const matchesStatus = state.productStatus === 'all' || String(item.productStatus).toLowerCase() === state.productStatus;
      return matchesQuery && matchesStatus;
    });
    $('#economics-body').innerHTML = products.map(item => {
      const economics = state.data.economics && state.data.economics[item.sku] || {};
      const result = contribution(item);
      const marginClass = !result ? 'neutral' : result.margin < 0 ? 'bad' : result.margin < 20 ? 'warn' : 'good';
      const image = item.productImage
        ? '<img src="' + escapeHtml(item.productImage) + '" alt="">'
        : '<span class="image-placeholder">PS</span>';
      const costCells = ['landed', 'packing', 'delivery', 'channelFee'].map(field =>
        '<td><label class="money-input"><span>£</span><input class="econ-input" data-field="' + field +
        '" inputmode="decimal" type="number" min="0" step="0.01" value="' + escapeHtml(economics[field] == null ? '' : economics[field]) +
        '" aria-label="' + field + ' cost for ' + escapeHtml(item.sku) + '"></label></td>'
      ).join('');
      return '<tr data-sku="' + escapeHtml(item.sku) + '"><td><div class="product-cell">' + image +
        '<div><b>' + escapeHtml(item.productTitle) + '</b><small>' + escapeHtml(item.sku || item.title) + ' · ' +
        escapeHtml(item.productStatus) + '</small></div></div></td><td class="numeric">' + money(item.price) +
        '</td><td class="numeric ' + (Number(item.inventory) <= 20 && item.inventory != null ? 'warn' : '') + '">' +
        (item.inventory == null ? '—' : escapeHtml(item.inventory)) + '</td>' + costCells +
        '<td class="numeric js-contribution">' + (result ? money(result.amount) : '—') +
        '</td><td class="numeric js-margin ' + marginClass + '">' + (result ? result.margin.toFixed(1) + '%' : '—') + '</td></tr>';
    }).join('') || '<tr><td colspan="9" class="empty-state">No products match this filter.</td></tr>';
  }

  function renderOrders() {
    const dashboard = state.data.dashboard || {};
    $('#orders-revenue').textContent = money(dashboard.revenue30d);
    $('#orders-total').textContent = String(dashboard.orders30d || 0);
    $('#orders-open').textContent = String(dashboard.openOrders || 0);
    $('#orders-refunded').textContent = String(dashboard.refundedOrders30d || 0);
    const orders = state.data.orders || [];
    $('#order-list').innerHTML = orders.length ? orders.slice(0, 100).map(order =>
      '<div class="order-row"><div><b>' + escapeHtml(order.name || order.id) + '</b><small>' + date(order.createdAt) +
      ' · ' + escapeHtml(order.provider || 'shopify') + '</small></div><div class="order-state"><span class="tag ' +
      (['PAID', 'AUTHORIZED'].includes(order.financialStatus) ? 'good' : order.financialStatus === 'REFUNDED' ? 'bad' : 'warn') +
      '">' + escapeHtml(statusLabel(order.financialStatus)) + '</span><span class="tag ' +
      (order.fulfillmentStatus === 'FULFILLED' ? 'good' : 'warn') + '">' +
      escapeHtml(statusLabel(order.fulfillmentStatus)) + '</span></div><strong>' + money(order.total) + '</strong></div>'
    ).join('') : '<div class="empty-state">Live order data will appear after the read-only Shopify Admin connection is completed.</div>';
  }

  function approvalCard(item) {
    const pending = item.status === 'pending';
    const actions = pending
      ? '<div class="approval-actions"><button class="secondary danger" data-approval="' + escapeHtml(item.id) +
        '" data-decision="rejected">Reject</button><button class="primary" data-approval="' + escapeHtml(item.id) +
        '" data-decision="approved">Approve</button></div>'
      : '<p class="decision-note">Decision recorded ' + date(item.decidedAt) + ' · External execution: disabled</p>';
    return '<article class="approval-card"><div class="approval-title"><div><span class="tag ' +
      (pending ? 'warn' : item.status === 'approved' ? 'good' : 'bad') + '">' + escapeHtml(statusLabel(item.status)) +
      '</span><h3>' + escapeHtml(item.action || statusLabel(item.type)) + '</h3></div><strong>' +
      (item.financialImpact == null ? 'Impact not quantified' : money(item.financialImpact)) + '</strong></div><dl>' +
      '<div><dt>Reason</dt><dd>' + escapeHtml(item.reason || '—') + '</dd></div>' +
      '<div><dt>Expected benefit</dt><dd>' + escapeHtml(item.expectedBenefit || '—') + '</dd></div>' +
      '<div><dt>Risk</dt><dd>' + escapeHtml(item.risk || '—') + '</dd></div>' +
      '<div><dt>Requested by</dt><dd>' + escapeHtml(item.requestedBy || 'system') + ' · ' + date(item.createdAt) +
      '</dd></div></dl>' + actions + '</article>';
  }

  function renderApprovals() {
    const approvals = (state.data.approvals || []).filter(item =>
      state.approvalFilter === 'all' || item.status === state.approvalFilter
    );
    $('#approval-list').innerHTML = approvals.length
      ? approvals.map(approvalCard).join('')
      : '<div class="empty-state">No approval requests match this view.</div>';
    const pending = (state.data.approvals || []).filter(item => item.status === 'pending').length;
    $('#nav-approval-count').textContent = String(pending);
    $('#nav-approval-count').classList.toggle('hidden', !pending);
  }

  function renderAutomations() {
    $('#automation-list').innerHTML = (state.data.automationDefinitions || []).map(rule => {
      const enabled = Boolean(state.data.automations && state.data.automations[rule.id]);
      return '<div class="rule"><div><b>' + escapeHtml(rule.name) + '</b><small>' + escapeHtml(rule.detail) +
        '</small></div><button class="toggle ' + (enabled ? 'on' : '') + '" data-automation="' +
        escapeHtml(rule.id) + '" aria-pressed="' + enabled + '" aria-label="Toggle ' + escapeHtml(rule.name) +
        '"><span></span></button></div>';
    }).join('');
  }

  function renderChannels() {
    $('#channel-grid').innerHTML = (state.data.integrations || []).map(channelCard).join('');
    const ebay = state.data.ebay;
    if (!ebay) {
      $('#ebay-health').innerHTML = '<div class="empty-state">The existing eBay Manager has not yet been verified from Packsmart Ops. No duplicate OAuth setup will be created.</div>';
      return;
    }
    $('#ebay-health').innerHTML = [
      ['Connected account', ebay.account || '—'],
      ['Listings', ebay.listings && ebay.listings.length || 0],
      ['Drafts', ebay.drafts && ebay.drafts.length || 0],
      ['Missing on eBay', ebay.health && ebay.health.missingOnEbay && ebay.health.missingOnEbay.length || 0],
      ['Stale on eBay', ebay.health && ebay.health.staleOnEbay && ebay.health.staleOnEbay.length || 0],
      ['Last read sync', date(ebay.syncedAt)]
    ].map(item => '<div><span>' + escapeHtml(item[0]) + '</span><b>' + escapeHtml(item[1]) + '</b></div>').join('');
  }

  function renderAccount() {
    const user = state.data.user || {};
    const workspace = state.data.workspace || {};
    $('#account-workspace').textContent = workspace.name || 'Workspace';
    $('#account-details').innerHTML = [
      ['Owner', user.email || '—'],
      ['Role', statusLabel(user.role)],
      ['Workspace ID', workspace.id || '—'],
      ['Persistence', state.data.storage === 'supabase' ? 'Supabase cloud' : 'Development file store'],
      ['Session', 'Secure HTTP-only cookie']
    ].map(item => '<div><span>' + escapeHtml(item[0]) + '</span><b>' + escapeHtml(item[1]) + '</b></div>').join('');
  }

  function renderAll() {
    const cloud = state.data.storage === 'supabase';
    $('#storage-badge').textContent = cloud ? 'Cloud persistent' : 'Server fallback';
    $('#storage-badge').className = 'tag ' + (cloud ? 'good' : 'warn');
    renderOverview();
    renderProducts();
    renderOrders();
    renderApprovals();
    renderAutomations();
    renderChannels();
    renderAccount();
  }

  async function loadAudit() {
    const payload = await request('/api/audit?limit=250');
    state.audit = payload.events || [];
    $('#audit-list').innerHTML = state.audit.length ? state.audit.map(event =>
      '<div class="audit-row"><span class="audit-dot"></span><div><b>' + escapeHtml(statusLabel(event.type)) +
      '</b><small>' + escapeHtml(event.actor) + ' · ' + date(event.createdAt) + '</small></div><code>' +
      escapeHtml(JSON.stringify(event.detail || {})) + '</code></div>'
    ).join('') : '<div class="empty-state">No audit events.</div>';
  }

  async function loadBilling() {
    const billing = await request('/api/billing');
    $('#billing-status').innerHTML = [
      ['Current plan', billing.subscription && billing.subscription.plan || '—'],
      ['Current status', billing.subscription && billing.subscription.status || '—'],
      ['Packsmart charge', billing.customerZeroFree ? '£0 · internal testing' : 'Not started'],
      ['Checkout', billing.checkoutEnabled ? 'Enabled' : 'Disabled']
    ].map(item => '<div><span>' + escapeHtml(item[0]) + '</span><b>' + escapeHtml(statusLabel(item[1])) + '</b></div>').join('');
    $('#plan-grid').innerHTML = Object.entries(billing.plans || {}).map(entry => {
      const id = entry[0];
      const plan = entry[1];
      return '<div class="plan"><b>' + escapeHtml(plan.name) + '</b><strong>~£' +
        escapeHtml(plan.indicativeMonthlyGbp) + '<small>/mo</small></strong><span>' +
        escapeHtml((plan.features || []).join(' · ')) + '</span><em>' + escapeHtml(id) + '</em></div>';
    }).join('');
  }

  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    const error = $('#login-error');
    error.textContent = '';
    setBusy(button, true, 'Signing in…');
    try {
      const payload = await request('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: form.email.value, password: form.password.value })
      });
      state.session = payload;
      state.csrf = payload.csrf;
      form.password.value = '';
      if (payload.user && payload.user.passwordChangeRequired) showPasswordSetup();
      else await loadBootstrap();
    } catch (loginError) {
      error.textContent = loginError.message;
    } finally {
      setBusy(button, false);
    }
  });

  $('#password-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    const error = $('#password-error');
    error.textContent = '';
    if (form.newPassword.value !== form.confirmPassword.value) {
      error.textContent = 'The two passwords do not match.';
      return;
    }
    setBusy(button, true, 'Securing account…');
    try {
      const activation = Boolean(ownerActivationToken);
      const payload = await request(activation ? '/api/auth/activate-owner' : '/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify(activation
          ? { token: ownerActivationToken, newPassword: form.newPassword.value }
          : { newPassword: form.newPassword.value })
      });
      state.session = payload;
      state.csrf = payload.csrf;
      ownerActivationToken = '';
      form.reset();
      await loadBootstrap();
      showMessage('Owner password secured and temporary sessions revoked.');
    } catch (passwordError) {
      error.textContent = passwordError.message;
    } finally {
      setBusy(button, false);
    }
  });

  $('#main-nav').addEventListener('click', event => {
    const button = event.target.closest('[data-view]');
    if (button) setView(button.dataset.view);
  });
  document.addEventListener('click', event => {
    const link = event.target.closest('[data-view-link]');
    if (link) setView(link.dataset.viewLink);
  });
  $('#product-search').addEventListener('input', event => {
    state.productQuery = event.target.value;
    renderProducts();
  });
  $('#product-status').addEventListener('change', event => {
    state.productStatus = event.target.value;
    renderProducts();
  });
  $('#approval-filter').addEventListener('change', event => {
    state.approvalFilter = event.target.value;
    renderApprovals();
  });

  $('#economics-body').addEventListener('change', async event => {
    const input = event.target.closest('.econ-input');
    if (!input) return;
    const row = input.closest('tr');
    const sku = row.dataset.sku;
    const economics = {};
    row.querySelectorAll('.econ-input').forEach(field => { economics[field.dataset.field] = field.value; });
    try {
      const payload = await request('/api/economics', {
        method: 'PUT',
        body: JSON.stringify({ sku: sku, economics: economics })
      });
      state.data.economics[sku] = payload.economics;
      localStorage.setItem(LOCAL.economics, JSON.stringify(state.data.economics));
      const item = flattenProducts().find(variant => variant.sku === sku);
      const result = contribution(item);
      row.querySelector('.js-contribution').textContent = result ? money(result.amount) : '—';
      const margin = row.querySelector('.js-margin');
      margin.textContent = result ? result.margin.toFixed(1) + '%' : '—';
      margin.className = 'numeric js-margin ' + (!result ? 'neutral' : result.margin < 0 ? 'bad' : result.margin < 20 ? 'warn' : 'good');
    } catch (error) {
      showMessage(error.message, 'error');
    }
  });

  $('#automation-list').addEventListener('click', async event => {
    const button = event.target.closest('[data-automation]');
    if (!button) return;
    const id = button.dataset.automation;
    const enabled = !Boolean(state.data.automations[id]);
    button.disabled = true;
    try {
      await request('/api/automations', {
        method: 'PUT',
        body: JSON.stringify({ id: id, enabled: enabled })
      });
      state.data.automations[id] = enabled;
      localStorage.setItem(LOCAL.automations, JSON.stringify(state.data.automations));
      renderAutomations();
    } catch (error) {
      button.disabled = false;
      showMessage(error.message, 'error');
    }
  });

  $('#approval-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    $('#approval-form-error').textContent = '';
    setBusy(button, true, 'Creating request…');
    const values = Object.fromEntries(new FormData(form));
    try {
      const payload = await request('/api/actions', {
        method: 'POST',
        body: JSON.stringify(Object.assign({}, values, { source: 'owner-command-centre' }))
      });
      state.data.approvals.unshift(payload.approval);
      form.reset();
      renderApprovals();
      showMessage('Approval request created. No external action was executed.');
    } catch (error) {
      $('#approval-form-error').textContent = error.message;
    } finally {
      setBusy(button, false);
    }
  });

  $('#approval-list').addEventListener('click', async event => {
    const button = event.target.closest('[data-approval]');
    if (!button) return;
    setBusy(button, true, button.dataset.decision === 'approved' ? 'Approving…' : 'Rejecting…');
    try {
      const payload = await request('/api/approvals/' + encodeURIComponent(button.dataset.approval) + '/decision', {
        method: 'POST',
        body: JSON.stringify({ decision: button.dataset.decision })
      });
      const index = state.data.approvals.findIndex(item => item.id === payload.approval.id);
      if (index >= 0) state.data.approvals[index] = payload.approval;
      renderApprovals();
      showMessage(statusLabel(payload.approval.status) + ' recorded. External execution remains disabled.');
    } catch (error) {
      showMessage(error.message, 'error');
      setBusy(button, false);
    }
  });

  async function syncProvider(provider, button) {
    setBusy(button, true, 'Syncing…');
    try {
      await request('/api/integrations/' + provider + '/sync', { method: 'POST', body: '{}' });
      await loadBootstrap({ migrate: false });
      showMessage(statusLabel(provider) + ' read-only sync completed.');
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      setBusy(button, false);
    }
  }

  $('#sync-shopify').addEventListener('click', event => syncProvider('shopify', event.currentTarget));
  $('#sync-ebay').addEventListener('click', event => syncProvider('ebay', event.currentTarget));
  $('#refresh-all').addEventListener('click', async event => {
    const button = event.currentTarget;
    setBusy(button, true, 'Refreshing…');
    try {
      await request('/api/integrations/shopify/sync', { method: 'POST', body: '{}' });
      await loadBootstrap({ migrate: false });
      showMessage('Packsmart operations data refreshed.');
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      setBusy(button, false);
    }
  });
  $('#refresh-audit').addEventListener('click', event => {
    const button = event.currentTarget;
    setBusy(button, true, 'Refreshing…');
    loadAudit().catch(error => showMessage(error.message, 'error')).finally(() => setBusy(button, false));
  });
  $('#logout').addEventListener('click', async () => {
    try { await request('/api/auth/logout', { method: 'POST', body: '{}' }); }
    finally {
      state.session = null;
      state.data = null;
      state.csrf = '';
      showLogin();
    }
  });
  $('#show-password-change').addEventListener('click', () => $('#account-password-form').classList.toggle('hidden'));
  $('#account-password-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    const error = form.querySelector('.form-error');
    error.textContent = '';
    setBusy(button, true, 'Updating…');
    try {
      const payload = await request('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: form.currentPassword.value,
          newPassword: form.newPassword.value
        })
      });
      state.csrf = payload.csrf;
      form.reset();
      form.classList.add('hidden');
      showMessage('Password updated and older sessions revoked.');
    } catch (passwordError) {
      error.textContent = passwordError.message;
    } finally {
      setBusy(button, false);
    }
  });

  (async () => {
    try {
      const health = await request('/api/health');
      if (!health.ok) throw new Error('Packsmart Ops health check is not ready.');
      if (ownerActivationToken) {
        showPasswordSetup();
        return;
      }
      if (await loadSession()) await loadBootstrap();
    } catch (error) {
      $('#login-error').textContent = error.status === 401 ? '' : error.message;
      showLogin();
    }
  })();
})();
