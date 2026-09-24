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
  let invitationToken = '';
  let ownerActivationToken = '';
  try {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    ownerActivationToken = String(fragment.get('activate') || '');
    invitationToken = String(fragment.get('invite') || '');
    if (ownerActivationToken || invitationToken) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch {}
  let ebayReturnResult = '';
  try {
    const current = new URL(window.location.href);
    ebayReturnResult = String(current.searchParams.get('ebay') || '');
    if (ebayReturnResult) {
      current.searchParams.delete('ebay');
      window.history.replaceState(null, '', current.pathname + current.search + current.hash);
    }
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
    let response, payload = {};
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), method === 'GET' ? 30000 : 120000);
    const cancel = () => controller.abort();
    if (config.signal?.aborted) controller.abort();
    else config.signal?.addEventListener('abort', cancel, { once: true });
    try {
      response = await fetch(path, Object.assign({}, config, { headers, credentials: 'same-origin', cache: 'no-store', signal: controller.signal }));
      try { payload = await response.json(); } catch (error) { if (controller.signal.aborted) throw error; }
    } catch (cause) {
      throw Object.assign(new Error(cause.name === 'TimeoutError' || cause.name === 'AbortError' ? 'The request took too long. Check connection activity before retrying; it may still be running.' : 'Runvara could not be reached. Check your internet connection and connection activity before retrying any change.'), { code: 'REQUEST_UNAVAILABLE' });
    } finally { clearTimeout(timeout); config.signal?.removeEventListener('abort', cancel); }
    if (response.status === 401 && !path.endsWith('/login') && !path.endsWith('/activate-owner') && !path.endsWith('/signup-options')) {
      state.session = null; state.data = null; state.csrf = ''; showLogin();
    }
    if (!response.ok) {
      const error = new Error(payload.code === 'AUTH_REQUIRED' ? 'Your Runvara session has expired. Sign in again to continue.' : payload.error || 'Request failed (' + response.status + ')');
      error.status = response.status; error.code = payload.code; throw error;
    }
    return payload;
  }

  function showLogin() {
    closeWorkspaceSearch();
    $('#commander-result').replaceChildren(); $('#commander-result').classList.add('hidden');
    $('#loading-screen')?.classList.add('hidden');
    window.RunvaraConnections?.endSession();
    $('#login-screen').classList.remove('hidden');
    request('/api/auth/signup-options').then(options => {
      $('#signup-options')?.classList.toggle('hidden', !options.enabled);
      $('#signup-invitation-label')?.classList.toggle('hidden', !options.invitationRequired);
      const input = $('#signup-form').elements.invitation; input.required = Boolean(options.invitationRequired); input.value = invitationToken;
      if (invitationToken && options.enabled) $('#signup-options').open = true;
    }).catch(error => { $('#login-error').textContent = error.message; });
    $('#password-screen').classList.add('hidden');
    $('#app-shell').classList.add('hidden');
  }

  function showPasswordSetup() {
    closeWorkspaceSearch();
    $('#loading-screen')?.classList.add('hidden');
    $('#login-screen').classList.add('hidden');
    $('#password-screen').classList.remove('hidden');
    $('#app-shell').classList.add('hidden');
  }

  function showApp() {
    $('#loading-screen')?.classList.add('hidden');
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
      if (error.status !== 401) throw error;
      showLogin(); return false;
    }
  }

  async function migratePilotData() {
    if (state.session?.workspace?.id !== 'packsmart-solutions' || state.session?.user?.role !== 'owner') return;
    const marker = LOCAL.migrated + ':' + state.session.workspace.id;
    if (localStorage.getItem(marker)) return;
    const result = await request('/api/migrate-pilot', {
      method: 'POST',
      body: JSON.stringify({ migrationId: 'browser-pilot-v1', economics: readLocal(LOCAL.economics, {}), automations: readLocal(LOCAL.automations, {}), approvals: [] })
    });
    localStorage.setItem(marker, JSON.stringify({ migratedAt: new Date().toISOString(), result }));
  }

  async function loadBootstrap(options) {
    const config = Object.assign({ migrate: true }, options || {});
    if (config.migrate) {
      try { await migratePilotData(); }
      catch (error) { showMessage('Pilot migration needs attention: ' + error.message, 'error'); }
    }
    const data = await request('/api/bootstrap');
    state.data = data; state.csrf = data.csrf || state.csrf;
    $('#workspace-label').textContent = data.workspace.name;
    $('#workspace-heading').textContent = data.workspace.name;
    $('#sidebar-workspace').textContent = data.workspace.name;
    $('#sidebar-account').textContent = data.workspace.id === 'packsmart-solutions' ? 'Customer zero · internal' : 'Independent workspace';
    $('#launch-controls').classList.toggle('hidden', !data.launchAdmin);
    $('#customer-zero-manager').classList.toggle('hidden', data.workspace.id !== 'packsmart-solutions');
    localStorage.removeItem(LOCAL.economics);
    localStorage.removeItem(LOCAL.automations);
    renderAll(); showApp();
  }

  function setBusy(button, busy, busyText) {
    if (!button) return;
    if (busy) { button.dataset.originalText = button.textContent; button.textContent = busyText; button.disabled = true; }
    else { button.textContent = button.dataset.originalText || button.textContent; button.disabled = false; }
  }

  function setView(view) {
    closeWorkspaceSearch();
    state.view = view;
    $$('.nav-item').forEach(item => { item.classList.toggle('active', item.dataset.view === view); if (item.dataset.view === view) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); });
    document.body.classList.remove('nav-open'); $('#mobile-menu').setAttribute('aria-expanded','false');
    $$('.view').forEach(item => item.classList.toggle('active', item.id === 'view-' + view));
    const titles = { overview: 'Command Centre', 'ai-team': 'AI Team', profit: 'Products & Profit', orders: 'Order Profitability', suppliers: 'Suppliers & Costs', channels: 'Connection Centre', approvals: 'Approval Centre', automations: 'Automation Rules', issues: 'Exception Centre', opportunities: 'Opportunities', memory: 'Decision Memory', value: 'Value & Work', audit: 'Audit & Account' };
    $('#page-title').textContent = titles[view] || 'Packsmart Ops';
    if (view === 'audit') {
      loadAudit().catch(error => showMessage(error.message, 'error'));
      if (state.data?.launchAdmin) loadLaunch().catch(error => showMessage(error.message, 'error'));
      loadBilling().catch(error => showMessage(error.message, 'error'));
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const navigationHints = {
    overview: 'Dashboard, daily brief and business performance', issues: 'Exceptions, alerts and problems to review',
    'ai-team': 'Commander and specialist agents', profit: 'Products, inventory, stock and margins',
    orders: 'Sales, refunds and order profitability', suppliers: 'Supplier records and product costs',
    channels: 'Connection Centre, onboarding, Shopify, eBay and Meta', approvals: 'Review proposed actions and approval history',
    automations: 'Automation rules, policies and autopilot', opportunities: 'Recommendations and potential improvements',
    memory: 'Business decisions, goals and context', value: 'Results, action history and proof of work',
    audit: 'Account, billing, subscription, settings and audit history'
  };

  function closeWorkspaceSearch() {
    const dialog = $('#workspace-search-dialog');
    if (dialog.open) dialog.close();
    $('#workspace-search-input').value = '';
    $('#workspace-search-results').replaceChildren();
    $('#workspace-search-count').textContent = '';
  }

  function renderWorkspaceSearch() {
    const query = $('#workspace-search-input').value.trim().toLowerCase();
    const results = Array.from($('#main-nav').querySelectorAll('[data-view]')).map(button => ({
      view: button.dataset.view,
      title: Array.from(button.childNodes).filter(node => node.nodeType === 3).map(node => node.textContent).join('').trim(),
      hint: navigationHints[button.dataset.view] || '', icon: button.querySelector('svg')?.outerHTML || ''
    })).filter(item => (item.title + ' ' + item.hint).toLowerCase().includes(query));
    $('#workspace-search-count').textContent = results.length + (results.length === 1 ? ' page' : ' pages');
    $('#workspace-search-results').innerHTML = results.length ? results.map(item => '<button type="button" class="search-result" data-view-link="' + escapeHtml(item.view) + '"><span class="search-result-icon" aria-hidden="true">' + item.icon + '</span><span><b>' + escapeHtml(item.title) + '</b><small>' + escapeHtml(item.hint) + '</small></span><span aria-hidden="true">↗</span></button>').join('') : '<div class="empty-state">No matching pages. Try a page name such as Products or Approvals.</div>';
  }

  function openWorkspaceSearch() {
    if (!state.session || !state.data || $('#app-shell').classList.contains('hidden') || $('dialog[open]')) return;
    document.body.classList.remove('nav-open'); $('#mobile-menu').setAttribute('aria-expanded', 'false');
    renderWorkspaceSearch(); $('#workspace-search-dialog').showModal(); $('#workspace-search-input').focus();
  }

  function renderRevenueChart() {
    const channels = (state.data.integrations || []).filter(item => ['commerce', 'marketplace', 'social-commerce'].includes(item.kind) && (item.metrics30d?.orders > 0 || Number(item.metrics30d?.revenue) || item.lastSyncAt || item.status === 'connected'));
    const revenue = channel => {
      const value = channel.metrics30d?.revenue;
      return value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
    };
    const values = channels.map(revenue).filter(value => value !== null);
    if (!values.length) { $('#revenue-chart').innerHTML = '<div class="empty-state">No channel revenue is available yet. Connect a sales channel and import orders to see performance here.</div>'; return; }
    const min = Math.min(0, ...values), max = Math.max(0, ...values), range = max - min || 1;
    const zero = -min / range * 1000;
    $('#revenue-chart').innerHTML = channels.map(channel => {
      const value = revenue(channel), end = value === null ? zero : (value - min) / range * 1000;
      return '<div class="revenue-row"><div><span>' + escapeHtml(channel.name) + '</span><strong' + (value < 0 ? ' class="bad"' : '') + '>' + escapeHtml(money(value)) + '</strong></div>' + (value === null ? '<small class="muted">No imported revenue data</small>' : '<svg viewBox="0 0 1000 14" preserveAspectRatio="none" aria-hidden="true"><rect class="revenue-track" width="1000" height="14" rx="7"/><rect class="revenue-bar' + (value < 0 ? ' negative' : '') + '" x="' + Math.min(zero, end).toFixed(2) + '" width="' + Math.abs(end - zero).toFixed(2) + '" height="14" rx="7"/><line class="revenue-zero" x1="' + zero.toFixed(2) + '" x2="' + zero.toFixed(2) + '" y1="0" y2="14"/></svg>') + '</div>';
    }).join('');
  }

  function applyTarget(view, filter) {
    if (view === 'profit' && filter) { state.productStatus = filter; $('#product-status').value = filter; renderProducts(); }
    if (view === 'orders' && filter) { state.orderFilter = filter; $('#order-filter').value = filter; renderOrders(); }
    if (view === 'approvals' && filter) { state.approvalFilter = filter; $('#approval-filter').value = filter; renderApprovals(); }
  }

  function statusClass(status) {
    if (['connected', 'ready', 'configured', 'deterministic', 'internal', 'profitable', 'confirmed-costs'].includes(status)) return 'good';
    if (['error', 'failed', 'auth_expired', 'loss-making'].includes(status)) return 'bad';
    if (['warning', 'needs approval', 'degraded', 'not_configured', 'dormant', 'configured_disabled', 'below-floor', 'missing-costs', 'incomplete', 'estimated-costs'].includes(status)) return 'warn';
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
    const connected = (state.data.connectionCentre || []).find(item => item.id === channel.id);
    const sync = connected?.lastSuccessfulSyncAt || channel.lastSyncAt;
    const areas = connected ? connected.settings?.areas || [] : channel.capabilities || [];
    const message = connected ? window.RunvaraUI.connectionMessage(connected) : channel.detail;
    return `<article class="channel-card"><div class="channel-icon">${window.RunvaraUI.logo(channel.id)}</div><div><b>${escapeHtml(channel.name)}</b><small>${escapeHtml(message)}</small><div class="capabilities">${areas.map(item => `<span>${escapeHtml(statusLabel(item))}</span>`).join('')}</div>${metricHtml}<p class="channel-sync">${escapeHtml(sync ? 'Last successful sync ' + date(sync) : 'No successful live sync')}</p></div><span class="tag ${statusClass(connected?.status || channel.status)}">${escapeHtml(statusLabel(connected?.status || channel.status))}</span></article>`;
  }

  function ranking(items, risk) {
    return items.length ? items.map(item => '<button class="ranking-row" data-view-link="profit" data-target-filter="' + (risk ? escapeHtml(item.status) : 'profitable') + '"><span><b>' + escapeHtml(item.productTitle) + '</b><small>' + escapeHtml(item.sku) + '</small></span><strong class="' + statusClass(item.status) + '">' + escapeHtml(money(item.contribution)) + '<small>' + escapeHtml(percent(item.margin)) + '</small></strong></button>').join('') : '<div class="empty-state">No fully costed products yet.</div>';
  }

  function renderTrajectory() {
    const signals = state.data.dashboard?.revenueSignals;
    const root = $('#revenue-trajectory');
    if (!signals?.daily?.length) { root.innerHTML = '<p class="empty-state">Import orders to build a revenue history.</p>'; return; }
    const days = signals.daily, values = days.filter(item => item.revenue !== null).map(item => item.revenue);
    const minimum = Math.min(0,...values), maximum = Math.max(1,...values), range = maximum - minimum;
    const x = index => 12 + index * 576 / Math.max(1,days.length - 1), y = value => 140 - (value - minimum) / range * 120;
    const segments = []; let segment = [];
    days.forEach((item,index) => { if (item.revenue === null) { if (segment.length) segments.push(segment); segment = []; } else segment.push(`${x(index).toFixed(1)},${y(item.revenue).toFixed(1)}`); });
    if (segment.length) segments.push(segment);
    const comparison = signals.comparisons?.[30];
    const delta = comparison?.change;
    const comparisonText = delta != null ? `${delta > 0 ? '+' : ''}${delta}% against the previous 30 days` : comparison?.previous?.revenue === null || comparison?.current?.revenue === null ? 'Incomplete revenue values — comparison unavailable' : 'No positive previous-period baseline';
    const orders = days.reduce((sum,item)=>sum+item.orders,0), unknown = days.reduce((sum,item)=>sum+item.orders-item.knownOrders,0);
    const caption = orders ? `${orders} settled imported orders. ${unknown ? `${unknown} have unknown revenue; gaps remain visible.` : 'Zero days mean no settled orders in the imported records.'}` : 'No settled orders in the imported records for these dates.';
    root.innerHTML = `<div class="trajectory-reading"><strong>${money(comparison?.current?.revenue)}</strong><span>${escapeHtml(comparisonText)}<small>Rolling 30-day net revenue</small></span></div><svg class="trajectory" viewBox="0 0 600 168" role="img" aria-label="Daily imported net revenue over 30 UTC days"><title>Daily imported net revenue</title><desc>${escapeHtml(caption)} Exact values are in the data table below.</desc><defs><linearGradient id="revenue-signal" x1="0" x2="1"><stop stop-color="#4c8eff"/><stop offset="1" stop-color="#37d8ef"/></linearGradient></defs><path class="trajectory-grid" d="M12 20H588M12 80H588M12 140H588"/>${segments.map(points=>`<polyline class="trajectory-line" points="${points.join(' ')}"/>`).join('')}${days.map((item,index)=>item.revenue!==null&&item.orders ? `<circle class="trajectory-point" cx="${x(index)}" cy="${y(item.revenue)}" r="3"><title>${escapeHtml(item.date + ': ' + money(item.revenue))}</title></circle>`:'').join('')}<text x="12" y="164">${escapeHtml(days[0].date)}</text><text x="588" y="164" text-anchor="end">${escapeHtml(days.at(-1).date)}</text></svg><p class="signal-note">${escapeHtml(caption)}</p><details class="evidence trajectory-data"><summary>View exact daily values</summary><div class="table-scroll"><table><thead><tr><th scope="col">UTC date</th><th scope="col">Settled orders</th><th scope="col">Net revenue</th></tr></thead><tbody>${days.map(item=>`<tr><td>${escapeHtml(item.date)}</td><td>${item.orders}</td><td>${money(item.revenue)}${item.revenue===null ? ` <small>Known subtotal ${money(item.knownRevenue)}</small>`:''}</td></tr>`).join('')}</tbody></table></div></details>`;
  }

  function renderOperationsStream() {
    const ui = window.RunvaraUI, data = state.data;
    const running = (data.connectionCentre || []).filter(channel=>channel.progress);
    const records = [...(data.workRecords || [])].sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0,4);
    $('#operations-stream').innerHTML = `<p class="stream-state">${ui.badge(running.length ? 'Sync in progress' : data.autopilot?.enabled ? 'Monitoring scheduled' : 'Monitoring paused',running.length ? 'good':'neutral')}<span>${escapeHtml(running.length ? running.map(channel=>channel.name).join(', ') : data.autopilot?.lastRunAt ? 'Last cycle '+date(data.autopilot.lastRunAt) : 'No monitoring cycle recorded')}</span></p><ol class="operation-timeline">${records.map(item=>{const status=ui.workState(item);return `<li><div class="section-head"><b>${escapeHtml(ui.workName(item,data))}</b>${ui.badge(status.text,status.tone)}</div><small>${escapeHtml(date(item.updatedAt))} · ${escapeHtml(statusLabel(item.source))}</small><p>${escapeHtml(ui.issueCopy(item.evidence?.find(entry=>entry.type==='monitor_failure')?.detail) || `${(item.evidence || []).length} supporting records`)}</p></li>`;}).join('') || '<li class="empty-state">Work appears here when a check or command records a result.</li>'}</ol><button class="text-button" data-view-link="ai-team">Give the Commander a task ↗</button>`;
  }

  function renderOverview() {
    const dashboard = state.data.dashboard || {};
    const brief = state.data.brief || {};
    const today = dashboard.today || {};
    const top = dashboard.recommendations?.[0];
    $('#command-headline').textContent = dashboard.pendingApprovals ? `${dashboard.pendingApprovals} decisions await your judgement.` : dashboard.integrationIssues ? 'Your channels need attention.' : dashboard.stockRisks ? 'Keep your inventory in view.' : dashboard.products ? 'Your business, in perspective.' : 'Your command centre starts here.';
    $('#command-direction').textContent = top ? top.title + '. ' + top.detail : 'Connect your chosen channels to build a reliable operational picture.';
    $('#command-posture').innerHTML = window.RunvaraUI.badge(state.data.autopilot?.enabled ? 'Autopilot on' : 'Autopilot paused','neutral') + window.RunvaraUI.badge('Owner approval protected','warn') + '<small>Based on recorded workspace data</small>';
    renderTrajectory(); renderOperationsStream();
    $('#brief-summary').textContent = brief.summary || 'No daily brief is available.';
    $('#brief-generated').textContent = brief.generatedAt ? 'Generated ' + date(brief.generatedAt) + ' · rules-based assessment' : '';
    $('#readiness-score').textContent = String(dashboard.readiness || 0) + '%';
    const readiness = Number(dashboard.readiness);
    $('#readiness-arc').setAttribute('stroke-dasharray', (Number.isFinite(readiness) ? Math.max(0, Math.min(100, readiness)) : 0) + ' 100');
    $('#today-revenue').textContent = money(today.revenue);
    $('#today-orders').textContent = String(today.orders || 0);
    $('#today-open').textContent = String(today.openOrders || 0) + ' open';
    $('#today-profit').textContent = money(today.operatingProfit);
    $('#today-profit-coverage').textContent = 'coverage ' + String(today.profitCoverage || 0) + '%';
    $('#today-margin').textContent = percent(today.margin);
    $('#week-metrics').innerHTML = metricRows(dashboard.last7d || {});
    $('#month-metrics').innerHTML = metricRows(dashboard.last30d || {});
    renderRevenueChart();
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
    if (filter === 'low-stock') return (item.inventory !== null && item.inventory <= Number(state.data.settings && state.data.settings.lowStockThreshold || 20)) || item.available === false;
    if (filter === 'out-of-stock') return (item.inventory !== null && item.inventory <= 0) || item.available === false;
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
    const write = (state.data.connectionWrites || []).find(write => write.approvalId === item.id);
    const affected = write ? (state.data.connectionCentre || []).find(channel => channel.id === write.provider)?.name || statusLabel(write.provider) : 'See proposal and supporting evidence';
    const executionNote = item.executionStatus === 'ready' ? 'Ready to apply in the Connection Centre.' : item.executionStatus === 'completed' ? 'The channel confirmed the change.' : item.executionStatus === 'cancelled' ? 'No channel change made.' : 'External execution: disabled';
    const actions = pending && state.data.user?.role === 'owner' ? '<div class="approval-actions">' + (item.payload?.connectionWriteId ? '<button class="secondary" data-view-link="channels">Review exact change</button>' : '<button class="secondary" data-modify-approval="' + escapeHtml(item.id) + '">Modify</button>') + '<button class="secondary danger" data-approval="' + escapeHtml(item.id) + '" data-decision="rejected">Reject</button><button class="primary" data-approval="' + escapeHtml(item.id) + '" data-decision="approved">Approve</button></div>' : '<p class="decision-note">' + (pending ? 'Awaiting owner decision' : 'Decision recorded ' + date(item.decidedAt)) + ' · ' + escapeHtml(executionNote) + '</p>' + (item.executionStatus === 'ready' ? '<button class="secondary" data-view-link="channels">Open Connection Centre</button>' : '');
    return '<article class="approval-card"><div class="approval-title"><div><span class="tag ' + (pending ? 'warn' : item.status === 'approved' ? 'good' : 'bad') + '">' + escapeHtml(statusLabel(item.status)) + '</span><h3>' + escapeHtml(item.action || statusLabel(item.type)) + '</h3></div><strong>' + (item.financialImpact == null ? 'Impact not quantified' : money(item.financialImpact)) + '</strong></div><dl><div><dt>Affected channel / scope</dt><dd>' + escapeHtml(affected) + '</dd></div><div><dt>Reason</dt><dd>' + escapeHtml(item.reason || '—') + '</dd></div><div><dt>Expected benefit</dt><dd>' + escapeHtml(item.expectedBenefit || '—') + '</dd></div><div><dt>Risk</dt><dd>' + escapeHtml(item.risk || '—') + '</dd></div><div><dt>Requested by</dt><dd>' + escapeHtml(item.requestedBy || 'system') + ' · ' + escapeHtml(item.source || 'Runvara') + ' · ' + date(item.createdAt) + '</dd></div><div><dt>Requesting agent</dt><dd>' + escapeHtml(item.agentId || item.requestedBy) + '</dd></div></dl>' + window.RunvaraControl.evidence(item.evidence) + window.RunvaraControl.history(item.history) + actions + '</article>';
  }

  function renderApprovals() {
    const approvals = (state.data.approvals || []).filter(item => state.approvalFilter === 'all' || item.status === state.approvalFilter);
    $('#approval-list').innerHTML = approvals.length ? approvals.map(approvalCard).join('') : '<div class="empty-state">No approval requests match this view.</div>';
    const pending = (state.data.approvals || []).filter(item => item.status === 'pending').length;
    $('#approval-summary').innerHTML = `<div><p class="eyebrow">YOUR JUDGEMENT / RUNVARA EXECUTION</p><h2>${pending} ${pending===1?'decision':'decisions'} waiting for you</h2><p>Review the evidence, benefit and risk. Approval records your decision; supported live changes are applied separately.</p></div>${window.RunvaraUI.badge('Owner controlled','warn')}`;
    $('#nav-approval-count').textContent = String(pending); $('#nav-approval-count').classList.toggle('hidden', !pending);
  }

  function renderAutomations() {
    $('#automation-list').innerHTML = (state.data.automationDefinitions || []).map(rule => {
      const enabled = Boolean(state.data.automations && state.data.automations[rule.id]);
      return '<div class="rule"><div><b>' + escapeHtml(rule.name) + '</b><small>' + escapeHtml(rule.detail) + '</small></div><button class="toggle ' + (enabled ? 'on' : '') + '" data-automation="' + escapeHtml(rule.id) + '" aria-pressed="' + enabled + '" aria-label="Toggle ' + escapeHtml(rule.name) + '"><span></span></button></div>';
    }).join('');
  }

  function renderChannels() {
    window.RunvaraConnections?.render(state.data);
    $('#channel-grid').innerHTML = (state.data.integrations || []).filter(item => ['system', 'billing', 'intelligence'].includes(item.kind)).map(channelCard).join('');
    const shopifyConnection = (state.data.connections || []).find(item => item.provider === 'shopify');
    const shopifyStatus = (state.data.integrations || []).find(item => item.id === 'shopify');
    const canConfigure = ['owner', 'admin'].includes(String(state.data.user?.role || ''));
    $('#shopify-connection-card').classList.toggle('hidden', !canConfigure);
    const connectionState = $('#shopify-connection-state');
    const publicCatalogueLive = shopifyStatus?.source === 'public-storefront';
    connectionState.textContent = shopifyStatus?.status === 'connected' ? 'Connected · read-only' : publicCatalogueLive ? 'Live catalogue · read-only' : shopifyConnection ? 'Saved · verification needed' : 'Not configured';
    connectionState.className = 'tag ' + (shopifyStatus?.status === 'connected' ? 'good' : publicCatalogueLive || shopifyConnection ? 'warn' : 'neutral');
    const savedDomain = shopifyConnection?.metadata?.shopDomain;
    if (savedDomain) $('#shopify-connection-form').elements.storeDomain.value = savedDomain;
    const ebayOauth = state.data.ebayOAuth || {};
    const ebayOauthConnection = (state.data.connections || []).find(item => item.provider === 'ebay_oauth');
    const ebayManagerConnection = (state.data.connections || []).find(item => item.provider === 'ebay');
    const ebayConnection = ebayOauthConnection || ebayManagerConnection;
    const ebayStatus = (state.data.integrations || []).find(item => item.id === 'ebay');
    $('#ebay-connection-form').classList.toggle('hidden', !canConfigure);
    const ebayOauthButton = $('#connect-ebay-oauth');
    ebayOauthButton.classList.toggle('hidden', !canConfigure || !ebayOauth.ready || ebayOauth.connected);
    const ebayConnectionState = $('#ebay-connection-state');
    ebayConnectionState.textContent = ebayStatus?.status === 'connected' ? 'Connected · read-only' : ebayStatus?.status === 'degraded' ? 'Connected · partial read coverage' : ebayConnection ? 'Saved · verification needed' : 'Not configured';
    ebayConnectionState.className = 'tag ' + (ebayStatus?.status === 'connected' ? 'good' : ebayConnection ? 'warn' : 'neutral');
    const savedAccount = ebayConnection?.metadata?.account;
    if (savedAccount) $('#ebay-connection-form').elements.expectedAccount.value = savedAccount;
    const ebay = state.data.ebay;
    if (!ebay) { $('#ebay-health').innerHTML = '<div class="empty-state">eBay is ready for a secure read-only connection. The existing Manager remains available and unchanged.</div>'; return; }
    const coverage = ebay.coverage || {};
    const inventoryOnly = ebay.source === 'ebay-oauth-readonly';
    const listingsAvailable = coverage.offersAvailable !== false && coverage.inventoryAvailable !== false && !/unavailable:.*(?:inventory|offers)/i.test(ebayStatus?.lastError || '');
    const comparisonAvailable = listingsAvailable && !inventoryOnly && coverage.fullCatalogueAvailable !== false;
    $('#ebay-health').innerHTML = [
      ['Connected account', ebay.account || '—'], ['Catalogue coverage', inventoryOnly ? 'Inventory API only; full comparison needs the existing Manager feed' : 'Existing Manager catalogue'], [inventoryOnly ? 'Inventory API listings' : 'Listings', !listingsAvailable ? 'Source unavailable' : ebay.listings && ebay.listings.length || 0], ['Drafts', !listingsAvailable ? 'Source unavailable' : ebay.drafts && ebay.drafts.length || 0],
      ['Orders', (state.data.orders || []).filter(order => order.provider === 'ebay').length], ['Fee records', ebay.fees && ebay.fees.length || 0], ['Promotions', ebay.promotions && ebay.promotions.length || 0],
      ['Missing on eBay', !comparisonAvailable ? 'Cannot compare' : ebay.health && ebay.health.missingOnEbay && ebay.health.missingOnEbay.length || 0], ['Stale on eBay', !comparisonAvailable ? 'Cannot compare' : ebay.health && ebay.health.staleOnEbay && ebay.health.staleOnEbay.length || 0], ['Last read sync', date(ebay.syncedAt)]
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
    $('#stock-issue-list').innerHTML = issueRows(d.stockRiskItems || [], item => {
      const out = item.available === false || (item.inventory !== null && item.inventory <= 0);
      const stock = item.inventory === null ? (out ? 'unavailable' : 'quantity unknown') : item.inventory;
      return '<button class="issue-row" data-view-link="profit" data-target-filter="low-stock"><span><b>' + escapeHtml(item.productTitle) + '</b><small>' + escapeHtml(item.sku) + ' · stock ' + escapeHtml(stock) + '</small></span><span class="tag ' + (out ? 'bad' : 'warn') + '">' + (out ? 'Out' : 'Low') + '</span></button>';
    });
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

  // Presentation-only glyphs. The server's aiTeam array remains the source of
  // specialist identity, status, policy, findings and membership.
  const agentGlyphs = {
    commander: '<path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/><circle cx="12" cy="12" r="2"/>',
    stock: '<path d="m3 7 9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10M7 5l9 4"/>',
    pricing: '<path d="M3 21h18M6 17v-5m6 5V8m6 9V3M4 8l5-4 4 1 6-4"/>',
    product_scout: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6M7 10h6m-3-3v6"/>',
    supplier: '<path d="M2 6h12v12H2zM14 10h4l4 5v3h-8"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/>',
    ebay: '<path d="M3 9h18l-2-6H5zM4 9v12h16V9M9 21v-7h6v7M3 9c0 4 5 4 5 0 0 4 8 4 8 0 0 4 5 4 5 0"/>',
    shopify: '<path d="M4 7h16v14H4zM8 7V5a4 4 0 0 1 8 0v2M9 13l2 2 4-4"/>',
    seo: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6M5 10h10M10 3c-4 4-4 10 0 14 4-4 4-10 0-14"/>',
    marketing: '<path d="m3 9 16-6v18L3 15zM3 9v6m4 1 2 5h4l-2-4M22 8v8"/>',
    customer_service: '<path d="M4 13V9a8 8 0 0 1 16 0v8c0 3-2 4-6 4M4 11H2v7h4v-7zm16 0h2v7h-4v-7zM11 21h3"/>',
    sales: '<path d="m3 17 6-6 4 4 8-10M15 5h6v6M3 22h18"/>',
    finance: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 11h1m6 0h1m-8 4h1m6 0h1m-8 4h1m6 0h1"/>',
    health_watch: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
    operations: '<rect x="8" y="8" width="8" height="8" rx="2"/><path d="M9 2v6m6-6v6M9 16v6m6-6v6M2 9h6m-6 6h6m8-6h6m-6 6h6"/>',
    compliance: '<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6zM8 12l3 3 5-6"/>'
  };
  function agentIcon(id) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (Object.hasOwn(agentGlyphs, id) ? agentGlyphs[id] : '<circle cx="12" cy="12" r="8"/><path d="M8 12h8m-4-4v8"/>') + '</svg>';
  }

  function renderCommanderBrief(run) {
    const name = id => (state.data.aiTeam || []).find(agent => agent.id === id)?.name || statusLabel(id);
    const outcome = String(run.workStatus || run.status || 'Unknown');
    const tone = outcome === 'COMPLETED' ? 'good' : outcome === 'FAILED' ? 'bad' : ['REQUIRES APPROVAL', 'BLOCKED'].includes(outcome) ? 'warn' : 'neutral';
    $('#commander-result').innerHTML = '<div class="brief-result-heading"><span class="agent-mark commander-mark">' + agentIcon('commander') + '</span><div><p class="eyebrow">COMMANDER BRIEF</p><span class="muted tiny">Analysis returned by your team</span></div><span class="tag ' + tone + '">' + escapeHtml(outcome) + '</span></div><h3 class="brief-result-summary">' + escapeHtml(run.summary) + '</h3><div class="delegation"><span class="delegation-label">Delegated <span aria-hidden="true">→</span></span><div class="delegation-agents">' + ((run.routedAgents || []).map(id => '<span class="delegation-chip">' + agentIcon(id) + escapeHtml(name(id)) + '</span>').join('') || '<span class="muted">No specialist delegation returned.</span>') + '</div></div>' + ((run.priorities || []).length ? '<ol class="brief-priorities">' + run.priorities.map(item => '<li><span class="priority-agent">' + agentIcon(item.agentId) + escapeHtml(name(item.agentId)) + '</span><p>' + escapeHtml(item.action) + '</p></li>').join('') + '</ol>' : '');
    $('#commander-result').classList.remove('hidden');
  }

  function renderAiTeam() {
    const team = state.data.aiTeam || [];
    const commander = team.find(agent => agent.id === 'commander');
    $('#commander-team-size').textContent = String(team.filter(agent => agent.id !== 'commander').length) + ' specialists';
    $('#commander-autonomy').textContent = commander ? (state.data.autonomyLevels || {})[commander.autonomy] || 'Unknown' : 'Not reported';
    $('#commander-last-run').textContent = commander?.lastRun ? date(commander.lastRun) : 'Not run yet';
    $('#commander-status').textContent = commander?.enabled === false ? 'Disabled' : commander?.status || 'Not reported';
    $('#commander-status').className = 'tag ' + (commander?.enabled === false ? 'neutral' : statusClass(String(commander?.status).toLowerCase()));
    $('#agent-grid').innerHTML = team.map(agent => {
      const runs = (state.data.agentRuns || []).filter(run=>agent.id==='commander'||run.results?.some(result=>result.agentId===agent.id));
      const pending = (state.data.approvals || []).filter(item=>item.status==='pending'&&(item.agentId===agent.id||item.requestedBy===agent.id));
      const decisions = runs[0]?.decisionContext?.length || 0;
      return `<article class="agent-card" data-agent-id="${escapeHtml(agent.id)}"><div class="agent-head"><span class="agent-mark">${agentIcon(agent.id)}</span><div><b>${escapeHtml(agent.name)}</b><small>${escapeHtml(window.RunvaraUI.role(agent.id))}</small></div>${window.RunvaraUI.badge(agent.enabled===false?'Disabled':agent.status,agent.enabled===false?'neutral':statusClass(String(agent.status).toLowerCase()))}</div><div class="agent-task"><span class="eyebrow">${agent.currentTask ? 'CURRENT TASK' : 'LATEST FINDING'}</span><p class="agent-finding">${escapeHtml(agent.currentTask || agent.lastFinding || 'Ready for its first analysis.')}</p></div><dl><div><dt>Last run</dt><dd>${escapeHtml(agent.lastRun ? date(agent.lastRun) : 'Not yet run')}</dd></div><div><dt>Issues detected</dt><dd>${escapeHtml(agent.issuesDetected || 0)}</dd></div><div><dt>Rule confidence</dt><dd>${escapeHtml(agent.confidence == null ? '—' : agent.confidence+'%')}</dd></div></dl><div class="agent-context"><span>${runs.length} analyses in recent team history</span><span>${decisions} decisions consulted in latest run</span>${pending.length ? `<button class="text-button" data-view-link="approvals">${pending.length} awaiting approval ↗</button>` : '<span>No pending requests from this agent</span>'}</div></article>`;
    }).join('') || '<div class="empty-state">No specialists were returned for this workspace.</div>';
    const activity = state.data.agentActivity || [];
    $('#agent-activity').innerHTML = activity.length ? activity.map(item => '<div class="activity-row"><span class="activity-dot ' + statusClass(String(item.status).toLowerCase()) + '"></span><div><b>' + escapeHtml(statusLabel(item.agentId)) + '</b><p>' + escapeHtml(item.message) + '</p><small>' + escapeHtml(date(item.createdAt)) + (item.confidence === undefined ? '' : ' · confidence ' + Math.round(item.confidence * 100) + '%') + '</small></div></div>').join('') : '<div class="empty-state">No agent runs yet. Send the Commander a quick command.</div>';
  }

  function renderAll() {
    const cloud = state.data.storage === 'supabase';
    $('#storage-badge').textContent = cloud ? 'Cloud persistent' : 'Server fallback';
    $('#storage-badge').className = 'tag ' + (cloud ? 'good' : 'warn');
    renderOverview(); renderAiTeam(); renderProducts(); renderOrders(); renderSuppliers(); renderApprovals(); renderAutomations(); renderChannels(); renderIssues(); renderAccount();
    window.RunvaraControl.render(state.data);
  }

  async function loadAudit() {
    const payload = await request('/api/audit?limit=250'); state.audit = payload.events || [];
    $('#audit-list').innerHTML = state.audit.length ? state.audit.map(event => '<div class="audit-row"><span class="audit-dot"></span><div><b>' + escapeHtml(statusLabel(event.type)) + '</b><small>' + escapeHtml(event.actor) + ' · ' + date(event.createdAt) + '</small></div><code>' + escapeHtml(JSON.stringify(event.detail || {})) + '</code></div>').join('') : '<div class="empty-state">No audit events.</div>';
  }

  async function loadBilling() {
    const billing = await request('/api/billing');
    $('#billing-status').innerHTML = [
      ['Current plan', billing.subscription && billing.subscription.plan || '—'], ['Current status', billing.subscription && billing.subscription.status || '—'],
      ['Billing', billing.customerZeroFree ? '£0 · internal testing' : 'No charge started'], ['Checkout', billing.checkoutEnabled ? 'Enabled' : 'Disabled']
    ].map(item => '<div><span>' + escapeHtml(item[0]) + '</span><b>' + escapeHtml(statusLabel(item[1])) + '</b></div>').join('');
    $('#plan-grid').textContent = 'Commercial plans and pricing await owner confirmation.';
  }

  async function saveEconomics(button) {
    const main = button.closest('tr'); const sku = main.dataset.sku;
    const rows = Array.from($('#economics-body').querySelectorAll('tr')).filter(row => row.dataset.sku === sku);
    const economics = {};
    rows.flatMap(row => Array.from(row.querySelectorAll('.econ-input'))).forEach(field => { economics[field.dataset.field] = field.value; });
    setBusy(button, true, 'Saving…');
    try { await request('/api/economics', { method: 'PUT', body: JSON.stringify({ sku, economics }) }); await loadBootstrap({ migrate: false }); showMessage('Costs saved to your workspace.'); }
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

  $('#signup-form')?.addEventListener('submit', async event => {
    event.preventDefault();const form=event.currentTarget, button=form.querySelector('button');$('#signup-error').textContent='';
    if(form.password.value!==form.confirmPassword.value){$('#signup-error').textContent='The passwords do not match.';return;}
    setBusy(button,true,'Creating your workspace…');
    try {const payload=await request('/api/auth/signup',{method:'POST',body:JSON.stringify({businessName:form.businessName.value,email:form.email.value,password:form.password.value,invitation:form.invitation.value})});state.session=payload;state.csrf=payload.csrf;form.reset();invitationToken='';await loadBootstrap();setView('channels');}
    catch(error){$('#signup-error').textContent=error.message;}
    finally{setBusy(button,false);}
  });

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

  $('#commander-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); const error = $('#commander-error'); error.textContent = ''; setBusy(button, true, 'Team working…');
    form.closest('.command-card').setAttribute('aria-busy', 'true');
    try {
      const payload = await request('/api/agents/command', { method: 'POST', body: JSON.stringify({ command: form.command.value }) });
      const run = payload.run; renderCommanderBrief(run);
      form.reset(); await loadBootstrap({ migrate: false }); setView('ai-team'); showMessage('Commander analysis: ' + run.workStatus + '. Evidence is recorded in Value & Work.');
    } catch (commandError) { error.textContent = commandError.message; }
    finally { form.closest('.command-card').setAttribute('aria-busy', 'false'); setBusy(button, false); }
  });

  $('#economics-body').addEventListener('click', event => {
    const detail = event.target.closest('.cost-details');
    if (detail) { const row = detail.closest('tr'); const next = row.nextElementSibling; if (next && next.classList.contains('cost-detail-row')) next.classList.toggle('hidden'); return; }
    const save = event.target.closest('.save-economics'); if (save) saveEconomics(save);
  });
  $('#order-list').addEventListener('click', event => { const save = event.target.closest('.save-order-costs'); if (save) { event.preventDefault(); saveOrderCosts(save); } });

  $('#automation-list').addEventListener('click', async event => {
    const button = event.target.closest('[data-automation]'); if (!button) return; const id = button.dataset.automation; const enabled = !Boolean(state.data.automations[id]); button.disabled = true;
    try { await request('/api/automations', { method: 'PUT', body: JSON.stringify({ id, enabled }) }); state.data.automations[id] = enabled; await loadBootstrap({ migrate: false }); }
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

  $('#shopify-connection-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget; const button = form.querySelector('button'); const error = $('#shopify-connection-error'); error.textContent = '';
    const credentials = { storeDomain: form.elements.storeDomain.value, accessToken: form.elements.accessToken.value, clientId: form.elements.clientId.value, clientSecret: form.elements.clientSecret.value };
    setBusy(button, true, 'Encrypting & verifying…');
    try {
      await request('/api/connections', { method: 'POST', body: JSON.stringify({ provider: 'shopify', credentials }) });
      form.elements.accessToken.value = ''; form.elements.clientId.value = ''; form.elements.clientSecret.value = '';
      await request('/api/integrations/shopify/sync', { method: 'POST', body: '{}' });
      await loadBootstrap({ migrate: false });
      showMessage('Shopify connected. Live products, inventory and recent orders synced read-only.');
    } catch (connectionError) { error.textContent = connectionError.message; }
    finally {
      credentials.accessToken = ''; credentials.clientId = ''; credentials.clientSecret = '';
      form.elements.accessToken.value = ''; form.elements.clientSecret.value = '';
      setBusy(button, false);
    }
  });

  $('#ebay-connection-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget; const button = form.querySelector('button'); const error = $('#ebay-connection-error'); error.textContent = '';
    const credentials = { baseUrl: form.elements.baseUrl.value, expectedAccount: form.elements.expectedAccount.value, apiToken: form.elements.apiToken.value };
    setBusy(button, true, 'Encrypting & verifying…');
    try {
      await request('/api/connections', { method: 'POST', body: JSON.stringify({ provider: 'ebay', credentials }) });
      form.elements.apiToken.value = '';
      await request('/api/integrations/ebay/sync', { method: 'POST', body: '{}' });
      await loadBootstrap({ migrate: false });
      showMessage('Existing eBay Manager verified read-only. Its OAuth and live listing controls were not changed.');
    } catch (connectionError) { error.textContent = connectionError.message; }
    finally {
      credentials.apiToken = '';
      form.elements.apiToken.value = '';
      setBusy(button, false);
    }
  });

  $('#connect-ebay-oauth').addEventListener('click', async event => {
    const button = event.currentTarget; const error = $('#ebay-oauth-error'); error.textContent = '';
    setBusy(button, true, 'Opening secure eBay sign-in…');
    try {
      const payload = await request('/api/integrations/ebay/oauth/start', { method: 'POST', body: '{}' });
      if (!payload.authorizationUrl) throw new Error('eBay sign-in could not be opened.');
      window.location.assign(payload.authorizationUrl);
    } catch (oauthError) {
      error.textContent = oauthError.message;
      setBusy(button, false);
    }
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
    try { const payload = await request('/api/approvals/' + encodeURIComponent(button.dataset.approval) + '/decision', { method: 'POST', body: JSON.stringify({ decision: button.dataset.decision, revision: state.data.approvals.find(item => item.id === button.dataset.approval)?.revision || 1 }) }); const index = state.data.approvals.findIndex(item => item.id === payload.approval.id); if (index >= 0) state.data.approvals[index] = payload.approval; const write = state.data.connectionWrites?.find(item => item.approvalId === payload.approval.id); if (write && payload.approval.executionStatus === 'ready') write.status = 'ready'; if (write && payload.approval.status === 'rejected') write.status = 'rejected'; renderApprovals(); showMessage(payload.approval.executionStatus === 'ready' ? 'Approved. Review and apply the exact change in the Connection Centre.' : statusLabel(payload.approval.status) + ' recorded. No external action was executed.'); }
    catch (error) { showMessage(error.message, 'error'); setBusy(button, false); }
  });

  $('#sync-shopify').addEventListener('click', event => syncProvider('shopify', event.currentTarget));
  $('#sync-ebay').addEventListener('click', event => syncProvider('ebay', event.currentTarget));
  $('#sync-all-channels').addEventListener('click', async event => { const button = event.currentTarget; setBusy(button, true, 'Syncing…'); try { await request('/api/integrations/sync', { method: 'POST', body: '{}' }); await loadBootstrap({ migrate: false }); showMessage('All available commerce sources refreshed read-only.'); } catch (error) { showMessage(error.message, 'error'); } finally { setBusy(button, false); } });
  $('#refresh-all').addEventListener('click', async event => { const button = event.currentTarget; setBusy(button, true, 'Refreshing…'); try { await request('/api/integrations/sync', { method: 'POST', body: '{}' }); await loadBootstrap({ migrate: false }); showMessage('Operations data refreshed.'); } catch (error) { showMessage(error.message, 'error'); } finally { setBusy(button, false); } });
  $('#refresh-audit').addEventListener('click', event => { const button = event.currentTarget; setBusy(button, true, 'Refreshing…'); loadAudit().catch(error => showMessage(error.message, 'error')).finally(() => setBusy(button, false)); });
  $('#logout').addEventListener('click', async () => { try { await request('/api/auth/logout', { method: 'POST', body: '{}' }); } finally { state.session = null; state.data = null; state.csrf = ''; showLogin(); } });
  $('#show-password-change').addEventListener('click', () => $('#account-password-form').classList.toggle('hidden'));
  $('#account-password-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); const error = form.querySelector('.form-error'); error.textContent = ''; setBusy(button, true, 'Updating…');
    try { const payload = await request('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: form.currentPassword.value, newPassword: form.newPassword.value }) }); state.csrf = payload.csrf; form.reset(); form.classList.add('hidden'); showMessage('Password updated and older sessions revoked.'); }
    catch (passwordError) { error.textContent = passwordError.message; }
    finally { setBusy(button, false); }
  });


  $('#mobile-menu').addEventListener('click', () => { const open = document.body.classList.toggle('nav-open'); $('#mobile-menu').setAttribute('aria-expanded', String(open)); });
  $('#open-workspace-search').addEventListener('click', openWorkspaceSearch);
  $('#close-workspace-search').addEventListener('click', closeWorkspaceSearch);
  $('#workspace-search-dialog').addEventListener('close', closeWorkspaceSearch);
  $('#workspace-search-input').addEventListener('input', renderWorkspaceSearch);
  $('#workspace-search-dialog').addEventListener('keydown', event => {
    const results = Array.from($('#workspace-search-results').querySelectorAll('button'));
    if (!results.length) return;
    const index = results.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      results[event.key === 'ArrowDown' ? (index + 1) % results.length : (index < 0 ? results.length - 1 : (index - 1 + results.length) % results.length)].focus();
    } else if (event.key === 'Enter' && event.target === $('#workspace-search-input')) { event.preventDefault(); results[0].click(); }
  });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && state.session && state.data && !$('#app-shell').classList.contains('hidden') && !$('dialog[open]')) { event.preventDefault(); openWorkspaceSearch(); }
  });
  $$('[data-period]').forEach(button => button.addEventListener('click', () => {
    $$('[data-period]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    $('#week-metrics').hidden = button.dataset.period !== 'week';
    $('#month-metrics').hidden = button.dataset.period !== 'month';
  }));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { document.body.classList.remove('nav-open'); $('#mobile-menu').setAttribute('aria-expanded', 'false'); } });
  $('#startup-retry').addEventListener('click', () => window.location.reload());
  async function loadLaunch() {
    const launch = await request('/api/admin/launch');
    $('#launch-mode-form').elements.mode.value = launch.mode;
    $('#invitation-list').innerHTML = (launch.invitations || []).map(invite => '<div class="control-record"><b>' + escapeHtml(invite.email) + '</b><p>Expires ' + date(invite.expiresAt) + (invite.revoked ? ' · Revoked' : '') + '</p>' + (!invite.revoked ? '<button class="secondary" data-revoke-invite="' + escapeHtml(invite.id) + '">Revoke invitation</button>' : '') + '</div>').join('');
  }
  $('#launch-mode-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget;
    try { const result = await request('/api/admin/launch', { method:'PUT', body:JSON.stringify({mode:form.elements.mode.value,confirm:form.elements.confirm.value}) }); form.elements.confirm.value=''; $('#launch-feedback').textContent='Signup mode: '+result.mode; }
    catch(error) { $('#launch-feedback').textContent=error.message; }
  });
  $('#invite-form').addEventListener('submit', async event => {
    event.preventDefault(); const form=event.currentTarget, button=form.querySelector('button');setBusy(button,true,'Creating…');
    try { const result=await request('/api/admin/invitations',{method:'POST',body:JSON.stringify({email:form.elements.email.value})});$('#invite-link').value=result.url;$('#invite-link-label').classList.remove('hidden');await loadLaunch(); }
    catch(error){$('#launch-feedback').textContent=error.message;}finally{setBusy(button,false);}
  });
  $('#invitation-list').addEventListener('click', async event => {
    const button=event.target.closest('[data-revoke-invite]');if(!button)return;
    try{await request('/api/admin/invitations',{method:'DELETE',body:JSON.stringify({id:button.dataset.revokeInvite})});await loadLaunch();}catch(error){$('#launch-feedback').textContent=error.message;}
  });

  window.RunvaraControl.init({ request, reload: loadBootstrap, notify: showMessage, setView, money, date, escapeHtml });
  window.RunvaraConnections?.init({ request, reload: loadBootstrap, notify: showMessage, setView, date, escapeHtml });

  (async () => {
    try {
      if (ownerActivationToken) { showPasswordSetup(); return; }
      if (await loadSession()) {
        await loadBootstrap();
        const connectionReturn = new URL(window.location.href);
        if (connectionReturn.searchParams.has('connection')) {
          const channel = connectionReturn.searchParams.get('channel');
          const outcome = connectionReturn.searchParams.get('connection');
          setView('channels');
          if (state.data.connectionCentre?.some(item => item.id === channel)) window.RunvaraConnections?.open(channel);
          showMessage(outcome === 'connected' ? 'Connected successfully. Choose what to sync. Write permissions remain read-only.' : outcome === 'cancelled' ? 'Connection cancelled. Your existing connection was preserved.' : outcome === 'account-mismatch' ? 'A different account was selected. Your existing connection was preserved.' : 'Sign-in could not be completed. Open the channel and try reconnecting.', outcome === 'connected' ? undefined : 'error');
          connectionReturn.searchParams.delete('connection'); connectionReturn.searchParams.delete('channel'); window.history.replaceState(null, '', connectionReturn.pathname + connectionReturn.search);
        }
        if (ebayReturnResult) setView('channels');
        if (ebayReturnResult === 'connected') showMessage('eBay connected read-only. Live writes remain disabled and the existing Manager was not changed.');
        else if (ebayReturnResult === 'declined') showMessage('eBay connection was cancelled. Nothing was changed.', 'error');
        else if (ebayReturnResult === 'account-mismatch') showMessage('The eBay account did not match Packsmart, so no credential was saved.', 'error');
        else if (ebayReturnResult === 'error') showMessage('eBay sign-in could not be completed. No marketplace change was made.', 'error');
      }
    }
    catch (error) { $('#startup-error').textContent = error.message; $('#startup-retry').classList.remove('hidden'); $('#loading-screen').querySelector('.skeleton-group')?.classList.add('hidden'); }
  })();
})();
