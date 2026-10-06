(() => {
  'use strict';

  const LOCAL = {
    economics: 'packsmart-saas-economics-v1',
    automations: 'packsmart-saas-automations-v1',
    migrated: 'packsmart-saas-cloud-migration-v3'
  };
  const state = {
    csrf: '', session: null, data: null, graphGeneration: 0, objectiveGeneration: 0, objectiveSnapshot: null, audit: [], fleet: null, fleetQuery: '', view: 'overview',
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

  function usd(value) {
    if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: Number(value) < 1 ? 4 : 2, maximumFractionDigits: Number(value) < 1 ? 6 : 2 }).format(Number(value));
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
    const originatingSession = state.session, originatingCsrf = state.csrf;
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
    if (response.status === 401 && state.session === originatingSession && state.csrf === originatingCsrf && !path.endsWith('/login') && !path.endsWith('/activate-owner') && !path.endsWith('/signup-options')) {
      state.session = null; state.data = null; state.csrf = ''; showLogin();
    }
    if (!response.ok) {
      const error = new Error(payload.code === 'AUTH_REQUIRED' ? 'Your Runvara session has expired. Sign in again to continue.' : payload.error || 'Request failed (' + response.status + ')');
      error.status = response.status; error.code = payload.code; throw error;
    }
    return payload;
  }

  function showLogin() {
    resetObjectiveReview(); resetAutomationHistory();
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
    resetObjectiveReview(); resetAutomationHistory();
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
    if (state.data?.workspace?.id !== data.workspace.id) resetObjectiveForm();
    state.data = data; state.csrf = data.csrf || state.csrf;
    state.graphGeneration++; state.objectiveGeneration++; resetObjectiveReview(); resetAutomationHistory();
    $('#business-graph-result').replaceChildren();
    $('#business-objectives-list').replaceChildren();
    $('#fleet-provider-usage-result').replaceChildren();
    state.objectiveSnapshot = null;
    $('#business-objective-form').classList.toggle('hidden', !['owner','admin'].includes(data.user?.role));
    $('#workspace-label').textContent = data.workspace.name;
    $('#workspace-heading').textContent = data.workspace.name;
    $('#sidebar-workspace').textContent = data.workspace.name;
    $('#sidebar-account').textContent = data.workspace.id === 'packsmart-solutions' ? 'Customer zero · internal' : 'Independent workspace';
    $('#launch-controls').classList.toggle('hidden', !data.launchAdmin);
    $('#operator-fleet-nav').classList.toggle('hidden', !data.launchAdmin);
    $('#operator-nav-label').classList.toggle('hidden', !data.launchAdmin);
    if (!data.launchAdmin && state.view === 'fleet') state.view = 'overview';
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
    if (view !== state.view) pauseObjectiveReview('Status checks paused after leaving the review. Select Check status to continue.');
    closeWorkspaceSearch();
    state.view = view;
    $$('.nav-item').forEach(item => { item.classList.toggle('active', item.dataset.view === view); if (item.dataset.view === view) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); });
    document.body.classList.remove('nav-open'); $('#mobile-menu').setAttribute('aria-expanded','false');
    $$('.view').forEach(item => item.classList.toggle('active', item.id === 'view-' + view));
    const titles = { overview: 'Command Centre', 'revenue-engine': 'Revenue Engine', analytics: 'Analytics', 'ai-team': 'AI Team', marketing: 'Marketing Autopilot', 'market-radar': 'Market Radar', profit: 'Products & Profit', orders: 'Order Profitability', suppliers: 'Suppliers & Costs', channels: 'Connection Centre', approvals: 'Approval Centre', automations: 'Automation Rules', issues: 'Exception Centre', opportunities: 'Opportunities', memory: 'Decision Memory', value: 'Value & Work', audit: 'Audit & Account', fleet: 'Operator Fleet' };
    $('#page-title').textContent = titles[view] || 'Packsmart Ops';
    if (view === 'audit') {
      loadAudit().catch(error => showMessage(error.message, 'error'));
      if (state.data?.launchAdmin) loadLaunch().catch(error => showMessage(error.message, 'error'));
      loadBilling().catch(error => showMessage(error.message, 'error'));
    }
    if (view === 'fleet') {
      if (!state.data?.launchAdmin) { setView('overview'); return; }
      loadFleet().catch(error => showMessage(error.message, 'error'));
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const navigationHints = {
    overview: 'Dashboard, daily brief and business performance', 'revenue-engine': 'Customers, retention, attribution, B2B sales, basket intelligence and growth plans', analytics: 'Revenue, profit, channel performance, attribution and marketing efficiency', issues: 'Exceptions, alerts and problems to review',
    'ai-team': 'Commander and specialist agents', marketing: 'Campaign planning, creatives and channel publishing controls', 'market-radar': 'Competitor, supplier and market web intelligence', profit: 'Products, inventory, stock and margins',
    orders: 'Sales, refunds and order profitability', suppliers: 'Supplier records and product costs',
    channels: 'Connection Centre, onboarding, Shopify, eBay and Meta', approvals: 'Review proposed actions and approval history',
    automations: 'Automation rules, policies and autopilot', opportunities: 'Recommendations and potential improvements',
    memory: 'Business decisions, goals and context', value: 'Results, action history and proof of work',
    audit: 'Account, billing, subscription, settings and audit history',
    fleet: 'Platform owner fleet health, AI usage, queue pressure and workspace controls'
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
    const results = Array.from($('#main-nav').querySelectorAll('[data-view]')).filter(button => !button.classList.contains('hidden')).map(button => ({
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

  function renderRevenueEngine() {
    const re = state.data.revenueEngine || {};
    const customers = re.customers || { summary:{}, customers:[], recommendations:[] };
    const attribution = re.attribution || { coverage:{}, bySource:[] };
    const sales = re.sales || { summary:{}, quotes:[] };
    const intent = re.intent || { recoveries:[] };
    const baskets = re.baskets || { pairs:[] };
    const advertising = re.advertising || { summary:{} };
    const growth = re.growthPlan || { opportunities:[] };
    $('#re-customers').textContent = String(customers.summary.customers || 0);
    $('#re-repeat').textContent = percent(customers.summary.repeatRate) + ' repeat rate';
    $('#re-reorder').textContent = String(customers.summary.reorderDue || 0);
    $('#re-churn').textContent = String(customers.summary.churnRisk || 0);
    $('#re-pipeline').textContent = money(sales.summary.openPipeline);
    $('#re-followups').textContent = String(sales.summary.overdueFollowUps || 0) + ' follow-ups due';
    $('#re-attribution').textContent = percent(attribution.coverage.sourceCoveragePercent);
    $('#re-intent').textContent = String(intent.recoveries?.length || 0);
    $('#re-customer-summary').innerHTML = [
      ['Known customer revenue', money(customers.summary.totalRevenue)],
      ['Known contribution', money(customers.summary.knownContribution)],
      ['Dormant customers', String(customers.summary.dormant || 0)],
      ['Identity model', 'Hashed / channel-scoped']
    ].map(item=>'<div><span>'+escapeHtml(item[0])+'</span><b>'+escapeHtml(item[1])+'</b></div>').join('');
    $('#re-customers-list').innerHTML = (customers.customers || []).slice(0,8).map(customer =>
      '<div class="ranking-row"><div><b>'+escapeHtml(customer.privacyLabel)+'</b><small>'+escapeHtml(statusLabel(customer.segment))+' · '+customer.orderCount+' orders · last '+escapeHtml(String(customer.daysSinceLastOrder))+' days ago</small></div><strong>'+escapeHtml(money(customer.revenue))+'</strong></div>'
    ).join('') || '<div class="empty-state">Customer intelligence appears when settled orders contain a privacy-safe customer identity.</div>';
    $('#re-growth-plan').innerHTML = (growth.opportunities || []).map(item =>
      '<div class="priority-item"><div><b>'+escapeHtml(item.title)+'</b><p>'+escapeHtml(item.evidence)+'</p><small>'+escapeHtml(statusLabel(item.confidence))+' confidence · '+(item.approvalRequired?'approval required':'read-only action')+'</small></div></div>'
    ).join('') || '<div class="empty-state">No evidence-backed growth action is strong enough to recommend yet.</div>';
    $('#re-attribution-list').innerHTML = [
      ['Confirmed source coverage', percent(attribution.coverage.sourceCoveragePercent)],
      ['Orders assessed', String(attribution.coverage.orders || 0)],
      ['Source-attributed orders', String(attribution.coverage.sourceAttributedOrders || 0)]
    ].map(item=>'<div><span>'+escapeHtml(item[0])+'</span><b>'+escapeHtml(item[1])+'</b></div>').join('') + '<p class="muted tiny">'+escapeHtml(attribution.coverage.note || '')+'</p>';
    $('#re-baskets').innerHTML = (baskets.pairs || []).slice(0,8).map(pair =>
      '<div class="ranking-row"><div><b>'+escapeHtml(pair.a)+' + '+escapeHtml(pair.b)+'</b><small>'+pair.ordersTogether+' orders together</small></div><strong>'+escapeHtml(percent(pair.affinity))+'</strong></div>'
    ).join('') || '<div class="empty-state">Repeated product pairs will appear as order history grows.</div>';
    $('#re-sales').innerHTML = [
      ['Leads', String(sales.summary.leads || 0)], ['Open quotes', String(sales.summary.openQuotes || 0)],
      ['Open pipeline', money(sales.summary.openPipeline)], ['Quote conversion', percent(sales.summary.conversionPercent)]
    ].map(item=>'<div><span>'+escapeHtml(item[0])+'</span><b>'+escapeHtml(item[1])+'</b></div>').join('');
    $('#re-advertising').innerHTML = [
      ['Recorded spend', money(advertising.summary.spend)], ['Attributed revenue', money(advertising.summary.attributedRevenue)],
      ['ROAS', advertising.summary.roas == null ? '—' : Number(advertising.summary.roas).toFixed(2)+'×'], ['Attribution coverage', percent(advertising.summary.attributionCoverage)]
    ].map(item=>'<div><span>'+escapeHtml(item[0])+'</span><b>'+escapeHtml(item[1])+'</b></div>').join('');

    const experiments = Array.isArray(re.experiments) ? re.experiments : [];
    const durableOpportunities = (state.data.opportunities || []).filter(item => item.present !== false && !['resolved','dismissed'].includes(item.status));
    const createSelect = $('#re-experiment-opportunity');
    createSelect.innerHTML = '<option value="">Choose an opportunity</option>' + durableOpportunities.map(item =>
      '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.title || item.id) + '</option>'
    ).join('');
    const measurable = experiments.filter(item => ['draft','running','completed','measured'].includes(String(item.status || '').toLowerCase()) && item.status !== 'completed');
    $('#re-experiment-measure').innerHTML = '<option value="">Choose an active experiment</option>' + measurable.map(item =>
      '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.title || item.id) + ' · ' + escapeHtml(statusLabel(item.status || 'draft')) + '</option>'
    ).join('');
    const measured = experiments.filter(item => String(item.status || '').toLowerCase() === 'measured' && item.impact?.verified !== true);
    $('#re-experiment-verify').innerHTML = '<option value="">Choose a measured experiment</option>' + measured.map(item =>
      '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.title || item.id) + '</option>'
    ).join('');
    $('#re-experiment-count').textContent = experiments.length + ' experiment' + (experiments.length === 1 ? '' : 's');
    $('#re-experiment-list').innerHTML = experiments.slice(0,20).map(item => {
      const verified = item.impact?.verified === true;
      const contribution = Number.isFinite(Number(item.impact?.incrementalContribution)) ? money(item.impact.incrementalContribution) + ' contribution' : 'contribution not verified';
      return '<div class="control-row"><div><b>' + escapeHtml(item.title || statusLabel(item.kind || 'Experiment')) + '</b><small>' + escapeHtml(statusLabel(item.kind || 'unknown')) + ' · ' + escapeHtml(item.metric || 'incremental_contribution') + '</small><small>' + escapeHtml(verified ? 'Verified · ' + contribution : statusLabel(item.status || 'draft')) + '</small></div><span class="tag ' + (verified ? 'good' : item.status === 'measured' ? 'warn' : 'neutral') + '">' + escapeHtml(verified ? 'Verified' : statusLabel(item.status || 'draft')) + '</span></div>';
    }).join('') || '<div class="empty-state">No experiments yet. Start from a recorded opportunity above.</div>';
    const capacityForm = $('#re-growth-capacity-form');
    if (capacityForm) {
      capacityForm.elements.growthCapacityHours.value = state.data.settings?.growthCapacityHours ?? '';
      capacityForm.elements.maxConcurrentGrowthExperiments.value = state.data.settings?.maxConcurrentGrowthExperiments ?? '';
    }
  }

  function renderAnalytics() {
    const dashboard = state.data.dashboard || {};
    const month = dashboard.last30d || {};
    const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const salesChannels = (state.data.integrations || []).filter(item =>
      ['commerce', 'marketplace', 'social-commerce'].includes(item.kind) &&
      (item.metrics30d || item.status === 'connected' || item.lastSyncAt)
    );
    const adCosts = (state.data.advertisingCosts || []).filter(item => {
      const when = Date.parse(item.date || item.createdAt || '');
      return Number.isFinite(when) && when >= cutoff;
    });
    const adSpend = adCosts.reduce((sum, item) => sum + (Number(item.spend) || 0), 0);
    const attributableRecords = adCosts.filter(item => item.attributableRevenue !== null && item.attributableRevenue !== undefined && Number.isFinite(Number(item.attributableRevenue)));
    const attributableRevenue = attributableRecords.reduce((sum, item) => sum + Number(item.attributableRevenue || 0), 0);
    const roas = adSpend > 0 && attributableRecords.length ? attributableRevenue / adSpend : null;

    $('#analytics-revenue').textContent = money(month.revenue);
    $('#analytics-orders').textContent = String(month.orders || 0);
    $('#analytics-profit').textContent = money(month.operatingProfit);
    $('#analytics-margin').textContent = percent(month.margin);
    $('#analytics-ad-spend').textContent = money(adSpend);
    $('#analytics-roas').textContent = roas === null ? '—' : roas.toFixed(2) + '×';
    $('#analytics-roas-note').textContent = roas === null ? (adSpend ? 'add attributable revenue to calculate' : 'no ad spend recorded') : money(attributableRevenue) + ' attributed revenue';

    const ranked = [...salesChannels].sort((a,b) => Number(b.metrics30d?.revenue || 0) - Number(a.metrics30d?.revenue || 0));
    const top = ranked.find(item => Number(item.metrics30d?.revenue || 0) !== 0);
    $('#analytics-summary').textContent = top
      ? top.name + ' is currently the largest recorded sales channel at ' + money(top.metrics30d?.revenue) + ' over the last 30 days. Runvara keeps source gaps visible rather than guessing.'
      : 'Connect and sync your sales channels to build a reliable cross-channel performance picture. Runvara will not invent attribution where source data is missing.';

    $('#analytics-channel-table').innerHTML = ranked.length ? '<div class="analytics-table-head"><span>Channel</span><span>Orders</span><span>Revenue</span><span>Contribution</span><span>Ads</span></div>' + ranked.map(channel => {
      const m = channel.metrics30d || {};
      return '<button class="analytics-table-row" data-view-link="channels"><span><b>' + escapeHtml(channel.name) + '</b><small>' + escapeHtml(statusLabel(channel.status || 'unknown')) + '</small></span><span>' + escapeHtml(String(m.orders || 0)) + '</span><span>' + escapeHtml(money(m.revenue)) + '</span><span>' + escapeHtml(money(m.operatingProfit)) + '</span><span>' + escapeHtml(money(m.advertisingSpend)) + '</span></button>';
    }).join('') : '<div class="empty-state">No connected sales-channel metrics are available yet.</div>';

    const totalChannelOrders = ranked.reduce((sum, channel) => sum + Number(channel.metrics30d?.orders || 0), 0);
    $('#analytics-source-mix').innerHTML = totalChannelOrders ? ranked.filter(channel => Number(channel.metrics30d?.orders || 0) > 0).map(channel => {
      const orders = Number(channel.metrics30d?.orders || 0);
      const share = totalChannelOrders ? (orders / totalChannelOrders * 100) : 0;
      return '<div class="source-row"><div><span>' + escapeHtml(channel.name) + '</span><strong>' + escapeHtml(String(orders)) + ' orders · ' + share.toFixed(1) + '%</strong></div><div class="source-track"><span style="width:' + Math.max(2, Math.min(100, share)).toFixed(1) + '%"></span></div></div>';
    }).join('') : '<div class="empty-state">Order-source mix will appear after connected channels import recent orders.</div>';

    const marketingByChannel = {};
    adCosts.forEach(item => {
      const key = String(item.channel || 'other');
      const row = marketingByChannel[key] || { spend: 0, revenue: 0, attributed: false };
      row.spend += Number(item.spend || 0);
      if (item.attributableRevenue !== null && item.attributableRevenue !== undefined && Number.isFinite(Number(item.attributableRevenue))) {
        row.revenue += Number(item.attributableRevenue); row.attributed = true;
      }
      marketingByChannel[key] = row;
    });
    const marketingRows = Object.entries(marketingByChannel).sort((a,b) => b[1].spend - a[1].spend);
    $('#analytics-marketing').innerHTML = marketingRows.length ? '<div class="analytics-table-head analytics-marketing-head"><span>Channel</span><span>Spend</span><span>Attributed revenue</span><span>ROAS</span></div>' + marketingRows.map(([channel, row]) => {
      const channelRoas = row.attributed && row.spend > 0 ? row.revenue / row.spend : null;
      return '<div class="analytics-table-row analytics-marketing-row"><span><b>' + escapeHtml(statusLabel(channel)) + '</b><small>recorded marketing cost</small></span><span>' + escapeHtml(money(row.spend)) + '</span><span>' + escapeHtml(row.attributed ? money(row.revenue) : '—') + '</span><span>' + escapeHtml(channelRoas === null ? '—' : channelRoas.toFixed(2) + '×') + '</span></div>';
    }).join('') : '<div class="empty-state">No marketing spend has been recorded in the last 30 days. Add costs as campaigns begin so Runvara can calculate return.</div>';

    const connected = salesChannels.filter(item => item.status === 'connected').length;
    const profitCoverage = Number(month.profitCoverage || 0);
    const attributionCoverage = adCosts.length ? Math.round(attributableRecords.length / adCosts.length * 100) : 0;
    $('#analytics-coverage').innerHTML = [
      ['Sales-channel coverage', connected + ' connected', connected ? 'good' : 'warn', 'Live/synced commerce sources available to the workspace'],
      ['Profit coverage', profitCoverage + '%', profitCoverage >= 90 ? 'good' : 'warn', 'Orders with enough cost data for contribution analysis'],
      ['Marketing attribution', adCosts.length ? attributionCoverage + '%' : 'Not started', adCosts.length && attributionCoverage >= 80 ? 'good' : 'warn', 'Recorded ad-cost rows that include attributable revenue'],
      ['Traffic-source attribution', 'Needs source data', 'neutral', 'GA4/UTM or equivalent visitor-source data is not inferred from order channels']
    ].map(item => '<div class="coverage-item"><div><span>' + escapeHtml(item[0]) + '</span><strong class="' + item[2] + '">' + escapeHtml(item[1]) + '</strong></div><small>' + escapeHtml(item[3]) + '</small></div>').join('');

    const insights = [];
    if (top) insights.push({ tone: 'good', title: top.name + ' leads recorded channel revenue', detail: money(top.metrics30d?.revenue) + ' in the last 30 days across imported source data.' });
    if (profitCoverage < 100) insights.push({ tone: profitCoverage < 70 ? 'warn' : 'neutral', title: 'Profit confidence can improve', detail: profitCoverage + '% of recent orders currently have sufficient cost coverage. Filling missing landed, fulfilment and fee inputs will make channel decisions stronger.' });
    if (adSpend > 0 && !attributableRecords.length) insights.push({ tone: 'warn', title: 'Advertising spend is recorded without attributed revenue', detail: money(adSpend) + ' of spend is visible, but Runvara cannot responsibly calculate ROAS until attributable revenue is supplied by a connected source or recorded evidence.' });
    if (!adSpend) insights.push({ tone: 'neutral', title: 'Marketing efficiency is ready for data', detail: 'As paid campaigns start, record or connect spend and attributable revenue so Runvara can compare growth with actual return.' });
    if (!connected) insights.push({ tone: 'warn', title: 'Connect a commerce source to unlock channel intelligence', detail: 'Analytics stays evidence-based and will expand automatically as connected platforms supply orders, revenue and costs.' });
    $('#analytics-insights').innerHTML = insights.length ? insights.slice(0,5).map(item => '<article class="analytics-insight"><span class="tag ' + item.tone + '">' + escapeHtml(item.tone === 'good' ? 'Signal' : item.tone === 'warn' ? 'Attention' : 'Next') + '</span><div><b>' + escapeHtml(item.title) + '</b><p>' + escapeHtml(item.detail) + '</p></div></article>').join('') : '<div class="empty-state">No analytics insight is available yet.</div>';
  }

  function renderHypergrowthCommand() {
    const hg = state.data.hypergrowth || {};
    const business = hg.businessState || {};
    const queue = hg.opportunityQueue || { opportunities:[], summary:{} };
    const council = hg.growthCouncil || { deliberations:[], commander:{} };
    const impact = hg.impact || { verified:{}, activity:{}, coverage:{} };
    const learning = hg.learning || { priors:[], summary:{} };
    const experiments = state.data.revenueEngine?.experiments || [];
    const portfolio = hg.portfolio || { portfolio:[], allocation:{}, coverage:{} };
    const executionPlan = hg.executionPlan || { sequence:[], blocked:[], summary:{} };
    const verified = impact.verified || {};
    $('#hg-value').textContent = money(verified.verifiedValue);
    $('#hg-hours').textContent = verified.hoursSaved == null ? '—' : Number(verified.hoursSaved).toFixed(1) + 'h';
    $('#hg-coverage').textContent = String(business.profitability?.profitCoveragePercent ?? 0) + '%';
    $('#hg-coverage-note').textContent = String(business.profitability?.profitCoveredOrders ?? 0) + ' profit-covered orders';
    const recommended = council.commander?.recommended?.length || 0;
    const approvals = council.commander?.prepareForApproval?.length || 0;
    const evidence = council.commander?.needsEvidence?.length || 0;
    $('#hg-council').textContent = String(recommended + approvals + evidence);
    $('#hg-council-note').textContent = recommended + ' ready · ' + approvals + ' approval · ' + evidence + ' evidence';
    $('#hg-opportunity-count').textContent = String(queue.summary?.total || 0) + ' detected';
    $('#hypergrowth-evidence-badge').textContent = (impact.activity?.verifiedImpactEvents || 0) + ' verified impact events';
    $('#hypergrowth-evidence-badge').className = 'tag ' + ((impact.activity?.verifiedImpactEvents || 0) ? 'good' : 'neutral');
    $('#hg-opportunities').innerHTML = (queue.opportunities || []).slice(0,5).map((item,index) => {
      const learned = item.learning ? ' · learned from ' + item.learning.samples + ' verified result' + (item.learning.samples === 1 ? '' : 's') + ' · ' + item.learning.positiveRatePercent + '% positive' : '';
      const posture = item.evidenceDecision === 'ready-for-owner-review' ? 'Ready for owner review' : item.evidenceDecision === 'deprioritise' ? 'Deprioritise' : item.evidenceDecision === 'needs-more-evidence' ? 'Needs more evidence' : item.score !== null ? money(item.score) : item.learning ? 'Learned signal' : 'Needs evidence';
      const tone = item.evidenceDecision === 'deprioritise' ? 'bad' : item.evidenceDecision === 'ready-for-owner-review' ? 'good' : item.evidenceDecision === 'needs-more-evidence' ? 'warn' : item.score !== null ? 'good' : 'neutral';
      const verifiedOutcome = item.evidenceDecision ? ' · ' + (item.evidenceDecisionReason || 'verified experiment updated decision posture') + (item.verifiedContributionValue !== null && item.verifiedContributionValue !== undefined && item.verifiedContributionValue !== '' && Number.isFinite(Number(item.verifiedContributionValue)) ? ' · verified contribution ' + money(item.verifiedContributionValue) : '') : '';
      const recorded = (state.data.opportunities || []).some(row => row.id === item.id);
      const investigate = recorded ? '<button class="text-button" type="button" data-investigate-opportunity="' + escapeHtml(item.id) + '">Investigate</button>' : '<button class="text-button" type="button" data-view-link="profit">Inspect evidence</button>';
      return '<li><span class="priority-number">' + (index + 1) + '</span><span class="priority-link"><b>' + escapeHtml(item.title) + '</b><small>' + escapeHtml((item.evidence || '') + learned + verifiedOutcome) + '</small>' + investigate + '</span><span class="tag ' + tone + '">' + escapeHtml(posture) + '</span></li>';
    }).join('') || '<li class="empty-state">No Hypergrowth opportunities detected yet.</li>';
    $('#hg-council-list').innerHTML = [
      ['Recommended now', recommended, recommended ? 'good':'neutral'],
      ['Prepare for approval', approvals, approvals ? 'warn':'good'],
      ['Needs economic evidence', evidence, evidence ? 'warn':'good'],
      ['External writes authorised', council.commander?.externalWrites ? 'Yes':'No', council.commander?.externalWrites ? 'bad':'good']
    ].map(item => '<div><span>' + escapeHtml(item[0]) + '</span><b class="' + item[2] + '">' + escapeHtml(item[1]) + '</b></div>').join('');
    $('#hg-impact').innerHTML = [
      ['Incremental revenue', money(verified.incrementalRevenue), 'neutral'],
      ['Incremental contribution', money(verified.incrementalContribution), 'good'],
      ['Contribution protected', money(verified.contributionProtected), 'good'],
      ['Costs avoided', money(verified.costAvoided), 'good'],
      ['Verified ROI', impact.roi?.multiple == null ? '—' : Number(impact.roi.multiple).toFixed(2) + '×', impact.roi?.multiple > 1 ? 'good':'neutral']
    ].map(item => '<div><span>' + escapeHtml(item[0]) + '</span><b class="' + item[2] + '">' + escapeHtml(item[1]) + '</b></div>').join('');
    const connectionIssues = (business.connections || []).filter(item => !item.healthy).length;
    $('#hg-controls').innerHTML = [
      ['Pending approvals', business.controls?.pendingApprovals || 0, business.controls?.pendingApprovals ? 'warn':'good'],
      ['Connection issues', connectionIssues, connectionIssues ? 'warn':'good'],
      ['Stock risks', business.inventory?.stockRisks || 0, business.inventory?.stockRisks ? 'warn':'good'],
      ['Missing cost variants', business.profitability?.missingCostVariants || 0, business.profitability?.missingCostVariants ? 'warn':'good'],
      ['Profit truth policy', 'Unknown stays unknown', 'good']
    ].map(item => '<div><span>' + escapeHtml(item[0]) + '</span><b class="' + item[2] + '">' + escapeHtml(item[1]) + '</b></div>').join('');

    const usable = Number(learning.summary?.domainsUsableForGuidance || 0);
    const learningEvents = Number(learning.summary?.verifiedLearningEvents || 0);
    $('#hg-learning-badge').textContent = usable ? usable + ' learned domain' + (usable === 1 ? '' : 's') : 'Learning safely';
    $('#hg-learning-badge').className = 'tag ' + (usable ? 'good' : 'neutral');
    $('#hg-learning').innerHTML = (learning.priors || []).slice(0,5).map(item =>
      '<div class="learning-row"><div><b>' + escapeHtml(statusLabel(item.kind)) + '</b><small>' + escapeHtml(item.samples + ' verified outcomes · ' + (item.positiveRatePercent == null ? 'positive rate unknown' : item.positiveRatePercent + '% positive')) + '</small></div><span class="tag ' + (item.usableForGuidance ? 'good' : 'neutral') + '">' + escapeHtml(item.usableForGuidance ? statusLabel(item.confidence) + ' guidance' : 'More evidence') + '</span></div>'
    ).join('') || '<div class="empty-state">Runvara will learn here after repeated verified experiment or work outcomes. Forecasts and unverified results never count.</div>';
    if (!learningEvents && learning.priors?.length) $('#hg-learning').insertAdjacentHTML('beforeend','<p class="muted tiny">No verified learning events are currently counted.</p>');

    const statusTone = status => status === 'completed' ? 'good' : status === 'measured' ? 'warn' : status === 'running' ? 'neutral' : 'neutral';
    $('#hg-experiments').innerHTML = experiments.slice(0,6).map(item => {
      const impactState = item.impact?.verified ? 'Verified result' : item.status === 'measured' ? 'Awaiting verification' : 'No verified result yet';
      const contribution = item.impact?.incrementalContribution;
      return '<div class="experiment-row"><div><b>' + escapeHtml(item.title || statusLabel(item.kind || 'Experiment')) + '</b><small>' + escapeHtml(statusLabel(item.kind || 'unknown') + ' · ' + impactState + (Number.isFinite(Number(contribution)) ? ' · ' + money(contribution) + ' contribution' : '')) + '</small></div><span class="tag ' + statusTone(String(item.status || '').toLowerCase()) + '">' + escapeHtml(statusLabel(item.status || 'draft')) + '</span></div>';
    }).join('') || '<div class="empty-state">No experiments yet. Create one from the Revenue Engine when there is a measurable hypothesis worth testing.</div>';

    const nextPound = portfolio.allocation?.nextPound;
    const nextHour = portfolio.allocation?.nextHour;
    const topPriority = portfolio.allocation?.topEvidencePriority;
    const nextExecutable = portfolio.allocation?.nextExecutable;
    const allocationReady = Boolean(nextPound || nextHour);
    $('#hg-allocation-badge').textContent = allocationReady ? 'Efficiency evidence ready' : 'Needs cost/time evidence';
    $('#hg-allocation-badge').className = 'tag ' + (allocationReady ? 'good' : 'neutral');
    $('#hg-allocation').innerHTML = [
      {
        label:'Evidence / planned cost',
        title:nextPound?.title || 'Not enough cost evidence',
        value:nextPound ? Number(nextPound.verifiedContributionPerPound).toFixed(2) + '× verified contribution / £' : '—',
        note:nextPound ? 'Historical contribution divided by recorded planned cost; not forecast profit or measured ROI.' : 'Add execution cost to a verified opportunity before Runvara recommends capital efficiency.'
      },
      {
        label:'Evidence / planned hour',
        title:nextHour?.title || 'Not enough effort evidence',
        value:nextHour ? money(nextHour.verifiedContributionPerHour) + ' / hour' : '—',
        note:nextHour ? 'Historical contribution divided by recorded planned hours; no future return is promised.' : 'Add effort hours to a verified opportunity before Runvara recommends time efficiency.'
      },
      {
        label:'Top evidence priority',
        title:topPriority?.title || 'No portfolio evidence yet',
        value:topPriority ? 'Priority ' + Number(topPriority.priorityIndex || 0).toFixed(3) : '—',
        note:topPriority ? (topPriority.verifiedContribution == null ? 'Evidence-weighted priority; no verified contribution value yet.' : 'Verified contribution ' + money(topPriority.verifiedContribution) + '.') : 'Runvara will rank opportunities as verified evidence accumulates.'
      },
      {
        label:'Ready for internal preparation',
        title:nextExecutable?.title || 'No safe work fits current constraints',
        value:nextExecutable ? 'Priority ' + Number(nextExecutable.priorityIndex || 0).toFixed(3) : '—',
        note:nextExecutable ? 'Fits current capacity and needs no owner-gated external action.' : (portfolio.capacity?.availableGrowthHours == null ? 'Set growth capacity hours to make execution-fit recommendations stricter.' : 'Current approval, experiment or capacity constraints block the remaining portfolio.')
      }
    ].map(item => '<div class="allocation-card"><span class="eyebrow">' + escapeHtml(item.label) + '</span><b>' + escapeHtml(item.title) + '</b><strong>' + escapeHtml(item.value) + '</strong><small>' + escapeHtml(item.note) + '</small></div>').join('');
    const sequence = executionPlan.sequence || [];
    const blocked = executionPlan.blocked || [];
    $('#hg-execution-badge').textContent = sequence.length ? sequence.length + ' safe step' + (sequence.length === 1 ? '' : 's') : 'No safe step';
    $('#hg-execution-badge').className = 'tag ' + (sequence.length ? 'good' : 'neutral');
    $('#hg-execution').innerHTML = sequence.slice(0,6).map(item =>
      '<li><span class="priority-number">' + escapeHtml(item.step) + '</span><div><b>' + escapeHtml(item.title) + '</b><small>' + escapeHtml(item.nextAction || '') + (item.verifiedContribution !== null && item.verifiedContribution !== undefined && item.verifiedContribution !== '' && Number.isFinite(Number(item.verifiedContribution)) ? ' · verified contribution ' + escapeHtml(money(item.verifiedContribution)) : '') + '</small></div></li>'
    ).join('') || '<li class="empty-state">No safe internal step is ready under the current evidence, approval and capacity constraints.</li>';
    $('#hg-blocked-badge').textContent = blocked.length + ' blocked';
    $('#hg-blocked-badge').className = 'tag ' + (blocked.length ? 'warn' : 'good');
    $('#hg-blocked').innerHTML = blocked.slice(0,6).map(item =>
      '<div class="blocked-row"><div><b>' + escapeHtml(item.title) + '</b><small>' + escapeHtml((item.blockers || []).join(' · ')) + '</small></div><small class="unlock-note">Unlock: ' + escapeHtml((item.unlocks || []).join(' · ') || 'No unlock action recorded') + '</small></div>'
    ).join('') || '<div class="empty-state">Nothing is blocked right now.</div>';

  }

  function renderOverview() {
    const dashboard = state.data.dashboard || {};
    const brief = state.data.brief || {};
    const today = dashboard.today || {};
    const top = dashboard.recommendations?.[0];
    $('#command-headline').textContent = dashboard.pendingApprovals ? `${dashboard.pendingApprovals} decisions await your judgement.` : dashboard.integrationIssues ? 'Your channels need attention.' : dashboard.stockRisks ? 'Keep your inventory in view.' : dashboard.products ? 'Your business, in perspective.' : 'Your command centre starts here.';
    $('#command-direction').textContent = top ? top.title + '. ' + top.detail : 'Connect your chosen channels to build a reliable operational picture.';
    const pendingApprovals = Number(dashboard.pendingApprovals || 0);
    $('#command-posture').innerHTML = window.RunvaraUI.badge(state.data.autopilot?.enabled ? 'Autopilot on' : 'Autopilot paused','neutral') +
      window.RunvaraUI.badge(pendingApprovals ? pendingApprovals + (pendingApprovals === 1 ? ' approval waiting' : ' approvals waiting') : 'No approvals waiting', pendingApprovals ? 'warn' : 'good') +
      '<small>Protected actions still require owner approval before execution</small>';
    renderHypergrowthCommand(); renderTrajectory(); renderOperationsStream();
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

  function renderMarketing() {
    const marketing = state.data.marketing || {};
    const settings = marketing.settings || {};
    const modes = marketing.modes || [];
    const providers = marketing.providers || {};
    const campaigns = marketing.campaigns || [];
    $('#marketing-pending-count').textContent = String(marketing.pendingCampaigns || 0);
    $('#marketing-last-run').textContent = marketing.lastPlannerRunAt ? 'Planner last ran ' + date(marketing.lastPlannerRunAt) : 'Planner has not run yet';
    $('#marketing-provider-chips').innerHTML = Object.values(providers).map(provider => '<span class="tag ' + (provider.status === 'connected' ? 'good' : 'warn') + '">' + escapeHtml(provider.name) + ' · ' + escapeHtml(({connected:'Connected',degraded:'Degraded',action_required:'Action required',disconnected:'Disconnected',configured:'Test required'})[provider.status] || 'API setup required') + '</span>').join('');
    $('#marketing-provider-list').innerHTML = Object.values(providers).map(provider => {
      const ready = provider.status === 'connected';
      const stateLabel = ready ? 'Connected' : ({action_required:'Action required',degraded:'Degraded',disconnected:'Disconnected',configured:'Configured'})[provider.status] || 'Not configured';
      const actions = '<div class="button-row">' + (provider.configured ? '<button class="secondary small-button" data-marketing-provider-test="' + escapeHtml(provider.id) + '">Test</button>' : '') + '<button class="secondary small-button" data-marketing-provider-open="' + escapeHtml(provider.id) + '">' + (provider.id === 'canva' ? 'Setup / reconnect' : 'Update key') + '</button>' + (provider.id === 'canva' && provider.refreshSupported ? '<button class="secondary small-button" data-marketing-provider-refresh="canva">Refresh access</button>' : '') + (provider.source ? '<button class="secondary small-button danger" data-marketing-provider-disconnect="' + escapeHtml(provider.id) + '">Disconnect</button>' : '') + '</div>';
      const detail = provider.lastTestAt ? 'Last tested ' + date(provider.lastTestAt) : provider.source === 'environment' ? 'Server configuration' : 'No connection test recorded';
      return '<div class="control-row"><div><b>' + escapeHtml(provider.name + ' ' + provider.planTarget) + '</b><small>' + escapeHtml(provider.capability) + '</small><small>' + escapeHtml(detail) + '</small>' + (provider.recovery ? '<small>' + escapeHtml(provider.recovery) + '</small>' : '') + (provider.id === 'canva' && provider.refreshSupported ? '<small>Automatic token refresh enabled</small>' : '') + '</div><div><span class="tag ' + (ready ? 'good' : 'warn') + '">' + escapeHtml(stateLabel) + '</span>' + actions + '</div></div>';
    }).join('');
    $('#marketing-canva-setup')?.classList.toggle('hidden', providers.canva?.status === 'connected');
    $('#marketing-runway-setup')?.classList.toggle('hidden', providers.runway?.status === 'connected');
    const form = $('#marketing-settings-form');
    $('#marketing-mode').innerHTML = modes.map(mode => '<option value="' + escapeHtml(mode.id) + '"' + (mode.id === settings.mode ? ' selected' : '') + '>' + escapeHtml(mode.name) + '</option>').join('');
    form.elements.dailyOrganicLimit.value = settings.dailyOrganicLimit ?? 2;
    form.elements.minMarginPercent.value = settings.minMarginPercent ?? 20;
    form.elements.minInventory.value = settings.minInventory ?? 5;
    form.elements.enabled.checked = settings.enabled !== false;
    form.elements.autoCreative.checked = settings.autoCreative !== false;
    $('#marketing-campaign-list').innerHTML = campaigns.length ? campaigns.map(campaign => {
      const product = campaign.product || {};
      const copy = campaign.copy || {};
      const providerStates = (campaign.creativeRequests || []).map(item => item.provider + ': ' + item.status).join(' · ');
      const approvalButton = campaign.publish?.approvalId
        ? '<button class="secondary small-button" data-view-link="approvals">Open approval</button>'
        : '<button class="secondary small-button" data-marketing-approval="' + escapeHtml(campaign.id) + '">Request publish approval</button>';
      const creativeButton = (campaign.creativeRequests || []).some(item => ['pending', 'in_progress', 'failed'].includes(item.status)) ? '<button class="secondary small-button" data-marketing-creatives="' + escapeHtml(campaign.id) + '">Generate / refresh creatives</button>' : '';
      return '<article class="opportunity-card"><div class="section-head"><div><span class="tag ' + statusClass(campaign.status) + '">' + escapeHtml(statusLabel(campaign.status)) + '</span><h3>' + escapeHtml(product.title || 'Prepared campaign') + '</h3></div><strong>' + escapeHtml(percent(product.margin)) + ' margin</strong></div><p>' + escapeHtml(copy.longCaption || '') + '</p><div class="signal-chips">' + (campaign.channels || []).map(channel => '<span class="tag neutral">' + escapeHtml(statusLabel(channel)) + '</span>').join('') + '</div><small class="muted">' + escapeHtml(providerStates || 'Creative requests pending') + '</small><div class="button-row">' + creativeButton + approvalButton + '</div></article>';
    }).join('') : '<div class="empty-state">No campaigns prepared yet. Runvara will only select active, in-stock products that meet the configured margin floor and have an image.</div>';
  }

  function renderMarketRadar() {
    const intelligence = state.data.webIntelligence || {};
    const provider = intelligence.provider || {};
    const radar = intelligence.radar || {};
    const targets = intelligence.targets || [];
    const findings = intelligence.findings || [];
    $('#radar-provider-chip').innerHTML = '<span class="tag warn">Firecrawl · ' + escapeHtml(provider.readinessLabel || 'Paid scans paused') + '</span>';
    $('#radar-change-count').textContent = String(radar.changes24h || 0);
    $('#radar-target-count').textContent = String(radar.monitoredTargets || 0);
    $('#radar-price-count').textContent = String(radar.priceSignals24h || 0);
    $('#radar-competitor-count').textContent = String(radar.competitorChanges24h || 0);
    $('#radar-supplier-count').textContent = String(radar.supplierChanges24h || 0);
    $('#radar-last-run').textContent = radar.lastRunAt ? 'Last scan ' + date(radar.lastRunAt) : 'No scans yet';
    $('#radar-target-list').innerHTML = targets.length ? targets.map(target =>
      '<div class="control-row"><div><b>' + escapeHtml(target.name) + '</b><small>' + escapeHtml(statusLabel(target.kind)) + ' · ' + escapeHtml(target.url) + '</small><small>' + escapeHtml(target.lastScannedAt ? 'Last scanned ' + date(target.lastScannedAt) : 'Not scanned yet') + (target.lastError ? ' · ' + escapeHtml(target.lastError) : '') + '</small></div><div class="button-row"><span class="tag ' + statusClass(target.lastStatus) + '">' + escapeHtml(statusLabel(target.lastStatus)) + '</span><button class="secondary small-button" data-radar-scan="' + escapeHtml(target.id) + '">Scan</button><button class="toggle ' + (target.active ? 'on' : '') + '" data-radar-toggle="' + escapeHtml(target.id) + '" aria-pressed="' + target.active + '" aria-label="Toggle ' + escapeHtml(target.name) + '"><span></span></button></div></div>'
    ).join('') : '<div class="empty-state">Add competitor or supplier pages to start building your Market Radar.</div>';
    $('#radar-finding-list').innerHTML = findings.length ? findings.map(item =>
      '<article class="opportunity-card"><div class="section-head"><div><span class="tag ' + (item.type === 'price_change' ? 'warn' : 'neutral') + '">' + escapeHtml(statusLabel(item.type)) + '</span><h3>' + escapeHtml(item.title) + '</h3></div><small>' + escapeHtml(date(item.detectedAt)) + '</small></div><p>' + escapeHtml(item.detail) + '</p><a class="text-button" href="' + escapeHtml(item.sourceUrl) + '" target="_blank" rel="noopener noreferrer">Open evidence ↗</a></article>'
    ).join('') : '<div class="empty-state">No market changes recorded yet. The first successful scan establishes a baseline.</div>';
  }

  const automationHistory = { cache: new Map(), pending: new Map(), errors: new Map(), epoch: 0 };
  const historyRecord = value => value && typeof value === 'object' && !Array.isArray(value);
  const historyId = (value, max = 180) => typeof value === 'string' && value.length > 0 && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
  function historyScope(record, workspaceId) {
    if (!historyRecord(record) || !historyId(workspaceId, 256)) return false;
    const ids = ['workspaceId','workspace_id','tenantId','tenant_id'].filter(key => Object.hasOwn(record, key)).map(key => record[key]);
    for (const key of ['workspace','tenant']) if (Object.hasOwn(record, key)) ids.push(historyRecord(record[key]) ? record[key].id : record[key]);
    return ids.every(id => id === workspaceId);
  }
  function historyTimestamp(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === (value.includes('.') ? value : value.slice(0,-1) + '.000Z');
  }
  function automationArchiveReference(run) {
    const workspaceId = state.data?.workspace?.id, ref = run?.archive;
    if (!historyScope(run, workspaceId) || !historyId(run.id) || !historyId(run.ruleId) || run.status !== 'COMPLETED' || !historyTimestamp(run.startedAt) || !historyTimestamp(run.completedAt) || !Array.isArray(run.evidence) || run.evidence.length || !Number.isSafeInteger(run.evidenceCount) || run.evidenceCount < 0) return null;
    if (!historyRecord(ref) || ref.schema !== 'runvara-automation-run-archive/v1' || ref.table !== 'runvara_history' || ref.collection !== 'automationRuns' || ref.workspaceId !== workspaceId || ref.runId !== run.id || typeof ref.recordId !== 'string' || !/^automation-v1:[0-9a-f]{64}$/.test(ref.recordId) || typeof ref.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(ref.sha256)) return null;
    // The authenticated server reconstructs and verifies the immutable reference.
    // Tenant/table fields are never submitted by the browser.
    return { recordId: ref.recordId, sha256: ref.sha256 };
  }
  const automationArchiveKey = (run, ref) => JSON.stringify([run.id, ref.recordId, ref.sha256]);
  const historyText = (value, max = 2000) => typeof value !== 'string' ? null : value.length > max ? value.slice(0, max) + '… [text shortened]' : value;
  function resetAutomationHistory() {
    automationHistory.epoch++;
    for (const pending of automationHistory.pending.values()) pending.controller.abort();
    automationHistory.pending.clear(); automationHistory.cache.clear(); automationHistory.errors.clear();
    $('#automation-history-list').replaceChildren();
  }
  function automationHistoryEvidence(evidence, index, open) {
    if (!Array.isArray(evidence)) return '<p class="muted">Supporting evidence is unavailable.</p>';
    const shown = evidence.slice(0,100), omitted = evidence.length - shown.length;
    const disclosure = omitted ? '<p class="muted tiny">Showing ' + shown.length + ' of ' + evidence.length + ' recorded evidence items. ' + omitted + ' additional items remain in the retained record and are not displayed here.</p>' : '';
    return '<details class="automation-history-evidence" data-history-evidence="' + index + '"' + (open ? ' open' : '') + '><summary>Recorded evidence (' + evidence.length + ')</summary>' + disclosure + (shown.map(item => {
      if (!historyRecord(item)) return '<p>' + escapeHtml(historyText(item) || 'This evidence item has no readable description.') + '</p>';
      const detail = historyText(item.detail) || historyText(item.message) || 'No readable description recorded.';
      const type = historyText(item.type, 80), id = historyText(item.id, 160);
      return '<div><p>' + escapeHtml(detail) + '</p><small>' + escapeHtml(type ? statusLabel(type) : 'Recorded evidence') + (id ? ' · ' + escapeHtml(id) : '') + (historyTimestamp(item.at) ? ' · ' + escapeHtml(date(item.at)) : '') + '</small></div>';
    }).join('') || '<p>No supporting evidence was recorded.</p>') + '</details>';
  }
  function renderAutomationHistory() {
    const root = $('#automation-history-list'), workspaceId = state.data?.workspace?.id;
    const open = new Set(Array.from(root.querySelectorAll('[data-history-evidence][open]')).map(item => item.dataset.historyEvidence));
    const rows = (Array.isArray(state.data?.automationRuns) ? state.data.automationRuns : []).slice(0,100);
    const definitions = Array.isArray(state.data?.automationDefinitions) ? state.data.automationDefinitions : [];
    root.innerHTML = rows.map((run, index) => {
      if (!historyScope(run, workspaceId)) return '';
      const ref = automationArchiveReference(run), key = ref ? automationArchiveKey(run, ref) : null;
      const cached = key ? automationHistory.cache.get(key) : null, pending = key ? automationHistory.pending.has(key) : false;
      const title = historyText(definitions.find(rule => rule.id === run.ruleId)?.name, 160) || 'Recorded check';
      const label = ['IN PROGRESS','COMPLETED','FAILED','BLOCKED'].includes(run.status) ? ({'IN PROGRESS':'In progress',COMPLETED:'Completed',FAILED:'Failed',BLOCKED:'Blocked'})[run.status] : 'Unknown status';
      let evidence;
      if (ref) {
        evidence = '<p class="muted">' + run.evidenceCount + ' evidence ' + (run.evidenceCount === 1 ? 'item retained' : 'items retained') + '. ' + (cached ? 'Archived evidence was read for this view.' : 'Evidence has not been loaded in this view.') + '</p>' +
          '<button class="secondary" type="button" data-read-automation-archive="' + index + '"' + (pending || cached ? ' disabled' : '') + '>' + (pending ? 'Reading archived evidence…' : cached ? 'Archived evidence loaded' : 'Read archived evidence') + '</button>' +
          (automationHistory.errors.has(key) ? '<p class="form-error" role="status">' + escapeHtml(automationHistory.errors.get(key)) + '</p>' : '') +
          (cached ? automationHistoryEvidence(cached.evidence, index, open.has(String(index)) || cached.openOnRead) : '');
        if (cached) cached.openOnRead = false;
      } else {
        evidence = (Object.hasOwn(run, 'archive') || Object.hasOwn(run, 'evidenceCount') ? '<p class="muted">Archived evidence is unavailable because its reference could not be verified.</p>' : '') + automationHistoryEvidence(run.evidence, index, open.has(String(index)));
      }
      return '<article class="automation-history-record" aria-busy="' + pending + '"><div class="automation-history-heading"><h3>' + escapeHtml(title) + '</h3><span class="tag neutral">' + label + '</span></div><p class="muted tiny">Started ' + escapeHtml(historyTimestamp(run.startedAt) ? date(run.startedAt) : 'Unknown') + (run.completedAt ? ' · Finished ' + escapeHtml(historyTimestamp(run.completedAt) ? date(run.completedAt) : 'Unknown') : '') + '</p>' + evidence + '</article>';
    }).join('') || '<p class="muted">No recent check history is available in this workspace snapshot.</p>';
  }
  $('#automation-history-list').addEventListener('click', async event => {
    const button = event.target.closest('[data-read-automation-archive]');
    if (!button || button.disabled || !state.session || !state.data?.workspace?.id) return;
    const index = Number(button.dataset.readAutomationArchive);
    if (!Number.isSafeInteger(index) || index < 0 || index >= 100) return;
    const run = state.data.automationRuns?.[index], ref = automationArchiveReference(run);
    if (!ref) return;
    const key = automationArchiveKey(run, ref);
    if (automationHistory.cache.has(key) || automationHistory.pending.has(key)) return;
    const snapshot = state.data, session = state.session, csrf = state.csrf, generation = state.graphGeneration, epoch = automationHistory.epoch;
    const current = () => state.data === snapshot && state.session === session && state.csrf === csrf && state.graphGeneration === generation && automationHistory.epoch === epoch;
    const pending = { controller: new AbortController() };
    automationHistory.pending.set(key, pending); automationHistory.errors.delete(key); renderAutomationHistory();
    try {
      const payload = await request('/api/automation-runs/' + encodeURIComponent(run.id) + '/archive?recordId=' + encodeURIComponent(ref.recordId) + '&sha256=' + encodeURIComponent(ref.sha256), { signal: pending.controller.signal });
      if (!current()) return;
      const full = payload?.run;
      if (payload?.workspaceId !== snapshot.workspace.id || payload?.runId !== run.id || payload?.source !== 'immutable_automation_archive' || !historyScope(full, snapshot.workspace.id) || full.id !== run.id || full.ruleId !== run.ruleId || full.status !== 'COMPLETED' || full.startedAt !== run.startedAt || full.completedAt !== run.completedAt || !Array.isArray(full.evidence) || full.evidence.length !== run.evidenceCount || Object.hasOwn(full, 'archive') || Object.hasOwn(full, 'evidenceCount')) throw new Error('Archive response binding failed');
      automationHistory.cache.set(key, { evidence: full.evidence, openOnRead: true });
    } catch (error) {
      if (current()) automationHistory.errors.set(key, error.status === 404 ? 'Archived evidence is unavailable. The retained count is unchanged.' : 'Could not read archived evidence. Select Read archived evidence to try again.');
    } finally {
      if (current() && automationHistory.pending.get(key) === pending) { automationHistory.pending.delete(key); renderAutomationHistory(); }
    }
  });

  function renderAutomations() {
    renderAutomationHistory();
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

  function fleetRisk(workspace) {
    return Number(workspace.counts?.dead_letter || 0) * 5 + Number(workspace.counts?.blocked || 0) * 4 +
      Number(workspace.unhealthyConnections || 0) * 3 + Number(workspace.openExceptions || 0) * 2 +
      Number(workspace.counts?.queued || 0);
  }

  function fleetTone(workspace) {
    if ((workspace.counts?.dead_letter || 0) || workspace.unhealthyConnections || workspace.openExceptions) return 'bad';
    if ((workspace.counts?.blocked || 0) || (workspace.counts?.queued || 0) || workspace.paused) return 'warn';
    return 'good';
  }

  function renderFleet() {
    if (!state.fleet || !state.data?.launchAdmin) return;
    const fleet = state.fleet, totals = fleet.totals || {}, worker = fleet.worker || {};
    const usageWorkspace = $('#fleet-provider-usage-workspace'), selectedUsageWorkspace = usageWorkspace.value;
    usageWorkspace.replaceChildren();
    for (const workspace of fleet.workspaces || []) { const option=document.createElement('option');option.value=workspace.workspaceId;option.textContent=workspace.name || workspace.workspaceId;usageWorkspace.append(option); }
    if (Array.from(usageWorkspace.options).some(option=>option.value===selectedUsageWorkspace)) usageWorkspace.value=selectedUsageWorkspace;
    else if (state.data?.workspace?.id) usageWorkspace.value=state.data.workspace.id;
    if (!$('#fleet-provider-usage-month').value) $('#fleet-provider-usage-month').value=new Date().toISOString().slice(0,7);

    const workerHealthy = !worker.lastError && Boolean(worker.lastTickAt);
    $('#fleet-worker-status').textContent = workerHealthy ? 'Worker healthy' : worker.lastError ? 'Worker needs attention' : 'Worker starting';
    $('#fleet-worker-status').className = 'tag ' + (workerHealthy ? 'good' : worker.lastError ? 'bad' : 'warn');

    $('#fleet-kpis').innerHTML = [
      ['Workspaces', totals.workspaces || 0, 'independent tenants'],
      ['Running', totals.running || 0, 'jobs now'],
      ['Queued', totals.queued || 0, 'waiting safely'],
      ['Blocked', totals.blocked || 0, 'needs attention'],
      ['Recorded AI cost · month', usd(totals.aiEstimatedCostUsdMonth || 0), (totals.aiRequestsMonth || 0) + ' metered requests'],
      ['Plan value · month', money(totals.planMonthlyValueGbp || 0), 'GBP list/billing value']
    ].map(item => '<article class="card kpi"><span>' + escapeHtml(item[0]) + '</span><strong>' + escapeHtml(item[1]) + '</strong><small>' + escapeHtml(item[2]) + '</small></article>').join('');

    $('#fleet-worker-detail').innerHTML = [
      ['Worker ID', worker.workerId || '—'],
      ['Last tick', worker.lastTickAt ? date(worker.lastTickAt) : 'Not yet'],
      ['Processed', worker.processed || 0],
      ['Failures', worker.failed || 0],
      ['Dead-lettered', worker.deadLettered || 0],
      ['Queue polls · since restart', worker.pollCalls ?? 'Not measured'],
      ['Empty queue polls', worker.emptyPolls ?? 'Not measured'],
      ['Polling delay', worker.backoffMs == null ? 'Not measured' : Math.round(worker.backoffMs / 1000) + ' seconds'],
      ['Last error', worker.lastError || 'None']
    ].map(item => '<div><span>' + escapeHtml(item[0]) + '</span><b>' + escapeHtml(item[1]) + '</b></div>').join('');

    const used = Number(totals.aiUnitsToday || 0), limit = Number(totals.dailyAiUnitLimit || 0), pct = limit ? Math.min(100, used / limit * 100) : 0;
    $('#fleet-ai-capacity').innerHTML = '<div class="fleet-meter"><span style="width:' + pct.toFixed(1) + '%"></span></div><div class="section-head"><b>' + escapeHtml(used) + ' AI units reserved today</b><span class="tag ' + (pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'good') + '">' + escapeHtml(limit ? Math.round(pct) + '%' : 'No AI capacity') + '</span></div><p class="muted tiny">Units reserve workload capacity. Provider token cost is metered separately from real response usage.</p>';

    $('#fleet-ai-provider-status').textContent = fleet.aiProviderConfigured ? 'Provider metering ready' : 'Deterministic fallback';
    $('#fleet-ai-provider-status').className = 'tag ' + (fleet.aiProviderConfigured ? 'good' : 'neutral');
    $('#fleet-economics-summary').innerHTML = [
      ['Metered AI requests this month', totals.aiRequestsMonth || 0],
      ['Estimated provider cost', usd(totals.aiEstimatedCostUsdMonth || 0) + ' USD'],
      ['Monthly plan value', money(totals.planMonthlyValueGbp || 0) + ' GBP'],
      ['Cost accounting', 'Measured tokens only'],
      ['Currency treatment', 'USD cost and GBP value kept separate']
    ].map(item => '<div><span>' + escapeHtml(item[0]) + '</span><b>' + escapeHtml(item[1]) + '</b></div>').join('');

    const models = fleet.modelCatalog || [];
    $('#fleet-model-catalog').innerHTML = models.length ? models.map(model => {
      const deterministic = model.model === 'deterministic';
      const pricing = deterministic ? 'No provider charge' : '$' + Number(model.inputPerMillionUsd || 0).toFixed(2) + ' in · $' + Number(model.cachedInputPerMillionUsd || 0).toFixed(2) + ' cached · $' + Number(model.outputPerMillionUsd || 0).toFixed(2) + ' out / 1M';
      return '<div class="model-row"><div><span class="tag ' + (deterministic ? 'neutral' : model.tier === 'quality' ? 'warn' : 'good') + '">' + escapeHtml(statusLabel(model.tier)) + '</span><b>' + escapeHtml(model.model) + '</b><small>' + escapeHtml(model.provider) + ' · pricing checked ' + escapeHtml(model.pricingUpdatedAt || '—') + '</small></div><span>' + escapeHtml(pricing) + '</span></div>';
    }).join('') : '<div class="empty-state">No model routing catalogue is available.</div>';

    const query = String(state.fleetQuery || '').trim().toLowerCase();
    const workspaces = (fleet.workspaces || []).filter(item => !query || [item.name,item.workspaceId,item.plan,item.subscriptionStatus,item.aiRoutingMode].join(' ').toLowerCase().includes(query));
    $('#fleet-workspaces').innerHTML = workspaces.length ? workspaces.map(workspace => {
      const counts = workspace.counts || {}, risk = fleetRisk(workspace), tone = fleetTone(workspace);
      const aiPct = workspace.dailyAiUnitLimit ? Math.min(100, Number(workspace.aiUnitsToday || 0) / Number(workspace.dailyAiUnitLimit) * 100) : 0;
      const aiMonth = workspace.aiUsageMonth?.totals || {};
      const jobs = (workspace.jobs || []).filter(job => ['running','queued','blocked','dead_letter'].includes(job.status));
      const jobHtml = jobs.length ? jobs.map(job => '<div class="fleet-job"><div><b>' + escapeHtml(statusLabel(job.type)) + '</b><small>' + escapeHtml(job.provider ? statusLabel(job.provider) + ' · ' : '') + escapeHtml(statusLabel(job.status)) + ' · attempt ' + escapeHtml(job.attempts || 0) + '/' + escapeHtml(job.maxAttempts || '—') + '</small>' + (job.aiModel ? '<small>AI route: ' + escapeHtml(job.aiModel) + ' · ' + escapeHtml(statusLabel(job.aiTier || '')) + '</small>' : '') + (job.errorCode ? '<small class="bad-text">' + escapeHtml(job.errorCode) + '</small>' : '') + '</div>' + (['blocked','dead_letter'].includes(job.status) ? '<button class="secondary" data-fleet-retry="' + escapeHtml(job.id) + '" data-workspace="' + escapeHtml(workspace.workspaceId) + '">Retry safely</button>' : '') + '</div>').join('') : '<div class="empty-state compact">No active or failed jobs.</div>';
      const sourceLabel = workspace.planValueSource === 'billing' ? 'billing value' : workspace.planValueSource === 'indicative_list_price' ? 'list price' : workspace.planValueSource === 'internal' ? 'internal' : 'unknown';
      return '<article class="fleet-workspace" data-fleet-workspace="' + escapeHtml(workspace.workspaceId) + '"><div class="fleet-workspace-head"><div><span class="tag ' + tone + '">' + escapeHtml(risk ? 'Attention ' + risk : 'Healthy') + '</span><h3>' + escapeHtml(workspace.name) + '</h3><small>' + escapeHtml(workspace.workspaceId) + ' · ' + escapeHtml(statusLabel(workspace.plan)) + ' · ' + escapeHtml(statusLabel(workspace.subscriptionStatus)) + '</small></div><div class="fleet-workspace-actions"><button class="secondary" data-fleet-pause="' + escapeHtml(workspace.workspaceId) + '" data-paused="' + (workspace.paused ? 'true' : 'false') + '">' + (workspace.paused ? 'Resume Agent Ops' : 'Pause Agent Ops') + '</button></div></div>' +
        '<div class="fleet-signal-grid"><div><span>Running</span><b>' + escapeHtml(counts.running || 0) + '</b></div><div><span>Queued</span><b>' + escapeHtml(counts.queued || 0) + '</b></div><div><span>Blocked</span><b>' + escapeHtml(counts.blocked || 0) + '</b></div><div><span>AI cost · month</span><b>' + escapeHtml(usd(aiMonth.estimatedCostUsd || 0)) + '</b></div><div><span>Plan value · month</span><b>' + escapeHtml(money(workspace.planMonthlyValueGbp || 0)) + '</b></div><div><span>Connection issues</span><b>' + escapeHtml(workspace.unhealthyConnections || 0) + '</b></div></div>' +
        '<div class="fleet-meter small"><span style="width:' + aiPct.toFixed(1) + '%"></span></div><div class="fleet-ai-line"><span>AI units ' + escapeHtml(workspace.aiUnitsToday || 0) + ' / ' + escapeHtml(workspace.dailyAiUnitLimit || 0) + '</span><span>' + escapeHtml(aiMonth.requests || 0) + ' model calls · ' + escapeHtml(sourceLabel) + '</span><span>' + escapeHtml(workspace.pendingApprovals || 0) + ' pending approvals</span></div>' +
        '<form class="fleet-settings fleet-settings-economics" data-fleet-settings="' + escapeHtml(workspace.workspaceId) + '"><label>Concurrent jobs<input name="maxConcurrentJobs" type="number" min="1" max="10" value="' + escapeHtml(workspace.maxConcurrentJobs || 1) + '" required></label><label>Daily AI units<input name="dailyAiUnitLimit" type="number" min="0" max="100000" value="' + escapeHtml(workspace.dailyAiUnitLimit || 0) + '" required></label><label>AI routing<select name="routingMode"><option value="economy"' + (workspace.aiRoutingMode==='economy'?' selected':'') + '>Economy</option><option value="balanced"' + (workspace.aiRoutingMode==='balanced'?' selected':'') + '>Balanced</option><option value="quality"' + (workspace.aiRoutingMode==='quality'?' selected':'') + '>Quality</option></select></label><label>Monthly AI cap (USD)<input name="monthlyCostLimitUsd" type="number" min="0" max="1000000" step="0.01" placeholder="No cap" value="' + escapeHtml(workspace.monthlyAiCostLimitUsd ?? '') + '"></label><button class="secondary" type="submit">Save AI policy</button></form><details class="fleet-jobs"><summary>Recent queue activity</summary>' + jobHtml + '</details></article>';
    }).join('') : '<div class="empty-state">No workspaces match this filter.</div>';
  }

  async function loadFleet() {
    if (!state.data?.launchAdmin) return;
    state.fleet = await request('/api/operator/agent-ops');
    renderFleet();
  }

  function renderAll() {
    const cloud = state.data.storage === 'supabase';
    $('#storage-badge').textContent = cloud ? 'Cloud persistent' : 'Server fallback';
    $('#storage-badge').className = 'tag ' + (cloud ? 'good' : 'warn');
    renderOverview(); renderRevenueEngine(); renderAnalytics(); renderAiTeam(); renderMarketing(); renderMarketRadar(); renderProducts(); renderOrders(); renderSuppliers(); renderApprovals(); renderAutomations(); renderChannels(); renderIssues(); renderAccount();
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
  const objectiveReview = { active: null, timer: null, controller: null, epoch: 0 };
  const reviewTerminal = new Set(['succeeded','blocked','dead_letter','failed','cancelled']);
  const reviewStatuses = new Set(['queued','running', ...reviewTerminal]);
  const reviewRows = (value, limit = 24) => Array.isArray(value) ? value.slice(0, limit) : [];
  const canPrepareReview = () => ['owner','admin'].includes(state.data?.user?.role);
  const reviewVisible = () => state.view === 'ai-team' && !document.hidden && $('.business-objectives-panel').open && !$('#app-shell').classList.contains('hidden');
  const sameReviewSession = active => objectiveReview.active === active && active.workspaceId === state.data?.workspace?.id && active.csrf === state.csrf && active.session === state.session && active.generation === state.graphGeneration && canPrepareReview();
  const currentReviewRequest = (active, epoch) => sameReviewSession(active) && objectiveReview.epoch === epoch && reviewVisible();
  function stopReviewRequests() {
    clearTimeout(objectiveReview.timer); objectiveReview.timer = null;
    objectiveReview.epoch++;
    objectiveReview.controller?.abort(); objectiveReview.controller = null;
  }
  function resetObjectiveReview() {
    stopReviewRequests(); objectiveReview.active = null;
    $('#business-objective-review').classList.add('hidden');
    $('#business-objective-review-result').replaceChildren();
    $('#business-objective-review-status').textContent = '';
    $('#resume-objective-review').classList.add('hidden');
    $('#refresh-objective-review').classList.add('hidden');
  }
  function pauseObjectiveReview(message) {
    stopReviewRequests();
    const active = objectiveReview.active;
    if (!active) return;
    active.busy = false; active.paused = true;
    if (!active.report) active.message = message || 'Status checks paused. Select Check status to continue.';
    renderObjectiveReview();
  }
  function renderObjectiveReview() {
    const active = objectiveReview.active;
    if (!active || !sameReviewSession(active)) return;
    const panel = $('#business-objective-review'), status = $('#business-objective-review-status'), resume = $('#resume-objective-review');
    panel.classList.remove('hidden');
    $('#business-objective-review-title').textContent = 'Review: ' + active.title;
    const job = active.job;
    status.textContent = active.message || (active.creating ? 'Preparing diagnostic review…' : job ? statusLabel(job.status) + ' · attempt ' + (job.attempts ?? 'Unknown') + ' of ' + (job.maxAttempts ?? 'Unknown') : 'Review status is not yet available.');
    panel.setAttribute('aria-busy', String(active.creating || active.busy));
    resume.classList.toggle('hidden', !job || active.creating || Boolean(active.report) || (!active.paused && !reviewTerminal.has(job.status)));
    resume.disabled = active.busy || active.creating;
    const currentObjective = state.objectiveSnapshot?.objectives?.find(item => item.id === active.objectiveId);
    const refresh = $('#refresh-objective-review');
    refresh.classList.toggle('hidden', !active.report || currentObjective?.effectiveStatus !== 'active');
    refresh.disabled = active.busy || active.creating;
    resume.textContent = job?.status === 'succeeded' ? 'Load report' : 'Check status';
    $$('[data-prepare-objective-review]').forEach(button => {
      button.disabled = active.creating;
      button.textContent = button.dataset.prepareObjectiveReview === active.objectiveId && Number(button.dataset.objectiveRevision) === active.objectiveRevision && job && !active.stale ? 'View review' : 'Prepare review';
    });
    const report = active.report, root = $('#business-objective-review-result');
    if (!report) { root.replaceChildren(); return; }
    const list = items => '<ul>' + reviewRows(items).map(item => '<li>' + escapeHtml(item?.message || item?.detail || item?.code || 'Evidence not established') + '</li>').join('') + '</ul>';
    const stale = active.stale ? '<p class="objective-review-stale" role="status">Historical review: the objective or source inputs have changed. ' + escapeHtml(statusLabel(active.staleReason || 'Revalidation required')) + '. Prepare a new review for the current objective before relying on this snapshot.</p>' : '';
    const metric = report.metricEvidence || {}, source = report.sourceAsOf || {};
    root.innerHTML = stale + '<div class="objective-review-outcomes"><section><h4>Diagnostic review</h4><p>' + escapeHtml(report.reportCompleted === true ? (report.reportStatus === 'completed' ? 'Completed' : 'Completed with evidence gaps') : 'Blocked or incomplete') + '</p></section><section><h4>Commercial proposals</h4><p>Blocked. Evidence and any required owner approval must be established separately.</p></section></div>' +
      '<p class="muted tiny">Historical source snapshot. This diagnostic is not a forecast, proof of objective progress, or permission to execute.</p>' +
      '<dl class="objective-review-facts"><div><dt>Objective revision</dt><dd>' + escapeHtml(report.objectiveRevision) + '</dd></div><div><dt>Snapshot read</dt><dd>' + escapeHtml(source.snapshotReadAt ? date(source.snapshotReadAt) : 'Unknown') + '</dd></div><div><dt>Financial source as-of</dt><dd>' + escapeHtml(source.financialObservedAt ? date(source.financialObservedAt) : 'Unknown') + '</dd></div><div><dt>Measured objective progress</dt><dd>' + escapeHtml(metric.value == null ? 'Unknown; objective-period evidence is unresolved' : metric.value) + '</dd></div><div><dt>Source coverage</dt><dd>' + (report.sourceResolution?.complete === true ? 'Complete within the recorded review scope' : 'Incomplete or bounded; inspect evidence gaps') + '</dd></div></dl>' +
      '<section><h4>Evidence gaps and review blockers</h4>' + (reviewRows(report.evidenceGaps).length || reviewRows(report.blockers).length ? list([...reviewRows(report.blockers), ...reviewRows(report.evidenceGaps)]) : '<p>No additional gaps were recorded. Commercial readiness is still not established.</p>') + '</section>' +
      '<section><h4>Specialist findings</h4>' + (reviewRows(report.specialists, 3).map(task => '<article class="objective-review-specialist"><h5>' + escapeHtml(statusLabel(task.agentId)) + ' · ' + escapeHtml(statusLabel(task.status)) + '</h5><p class="muted tiny">' + escapeHtml(statusLabel(task.mode)) + ' mode</p>' + list([...reviewRows(task.findings, 8), ...reviewRows(task.blockers, 8), ...reviewRows(task.recommendations, 4)]) + '</article>').join('') || '<p>No specialist findings are available.</p>') + '</section>' +
      '<section><h4>Blocked commercial proposals</h4>' + (reviewRows(report.proposals, 10).map(proposal => {
        const sourceExists = proposal.sourceReferenceResolved === true && (state.data?.opportunities || []).some(item => item.id === proposal.opportunityId && item.present === true);
        return '<article class="objective-review-proposal"><h5>' + escapeHtml(proposal.title || 'Recorded opportunity') + '</h5><p>' + (proposal.approvalRequired ? 'Blocked · owner approval required' : 'Blocked · missing verified evidence') + '</p>' + list(proposal.blockers) + '<p>' + escapeHtml(proposal.nextStep || 'Inspect the original record and resolve missing evidence.') + '</p>' + (sourceExists ? '<button class="secondary" type="button" data-investigate-review-opportunity="' + escapeHtml(proposal.opportunityId) + '">Investigate original opportunity</button>' : '<p class="muted tiny">Original opportunity is not available in the current workspace snapshot.</p>') + '</article>';
      }).join('') || '<p>No commercial proposals were prepared. This is not a statement that the objective is achieved.</p>') + '</section>';
  }
  function acceptReviewJob(active, payload) {
    const job = payload?.job;
    if (!job || typeof job.id !== 'string' || !/^job_[A-Za-z0-9_-]{1,100}$/.test(job.id) || job.type !== 'objective_prepare' || job.objectiveId !== active.objectiveId || job.objectiveRevision !== active.objectiveRevision || !reviewStatuses.has(job.status) || (active.job && active.job.id !== job.id)) throw new Error('The review response does not match this objective and job. Reload before trying again.');
    active.job = job; active.stale = active.stale || payload.stale === true;
    if (payload.stale) active.staleReason = payload.staleReason || 'Source inputs changed';
  }
  async function loadObjectiveReviewReport(active, epoch) {
    if (!currentReviewRequest(active, epoch) || active.reportRequested || active.report) return;
    active.reportRequested = true; active.busy = true; active.message = 'Loading the completed diagnostic…'; renderObjectiveReview();
    const controller = new AbortController(); objectiveReview.controller = controller;
    try {
      const payload = await request('/api/business-objectives/reviews/' + encodeURIComponent(active.job.id) + '?report=true', { signal: controller.signal });
      if (!currentReviewRequest(active, epoch)) return;
      acceptReviewJob(active, payload);
      const report = payload.report;
      if (active.job.status !== 'succeeded' || !report || report.schema !== 'runvara-objective-review/v1' || report.workspaceId !== active.workspaceId || report.jobId !== active.job.id || report.objectiveId !== active.objectiveId || report.objectiveRevision !== active.objectiveRevision) throw new Error('A matching persisted review report is not available.');
      active.report = report; active.message = report.reportCompleted === true ? 'Diagnostic completed. Commercial proposals remain blocked.' : 'Diagnostic finished with blockers. Commercial proposals remain blocked.';
    } catch (error) { if (currentReviewRequest(active, epoch)) { active.message = 'Could not load the review: ' + error.message; active.paused = true; } }
    finally { if (objectiveReview.controller === controller) objectiveReview.controller = null; if (currentReviewRequest(active, epoch)) { active.busy = false; renderObjectiveReview(); } }
  }
  function scheduleObjectiveReview(active, epoch) {
    if (!currentReviewRequest(active, epoch) || active.paused || active.busy) return;
    if (active.checks >= 8) { active.paused = true; active.message = 'Automatic status checks paused after 8 requests. Select Check status when you want to continue.'; renderObjectiveReview(); return; }
    const delay = [2000,4000,8000,10000][Math.min(active.checks,3)];
    objectiveReview.timer = setTimeout(() => { objectiveReview.timer = null; checkObjectiveReview(active, epoch); }, delay);
  }
  async function checkObjectiveReview(active, epoch) {
    if (!currentReviewRequest(active, epoch) || active.paused || active.busy || active.checks >= 8) return;
    active.checks++; active.busy = true; active.message = ''; renderObjectiveReview();
    const controller = new AbortController(); objectiveReview.controller = controller;
    let complete = false;
    try {
      const payload = await request('/api/business-objectives/reviews/' + encodeURIComponent(active.job.id), { signal: controller.signal });
      if (!currentReviewRequest(active, epoch)) return;
      acceptReviewJob(active, payload);
      complete = active.job.status === 'succeeded';
      if (reviewTerminal.has(active.job.status)) {
        active.paused = true;
        active.message = complete ? 'Diagnostic finished; loading report.' : 'Review ' + statusLabel(active.job.status).toLowerCase() + (active.job.errorCode ? ': ' + statusLabel(active.job.errorCode) : '') + '. No business action was executed.';
      }
    } catch (error) { if (currentReviewRequest(active, epoch)) { active.paused = true; active.message = 'Status check paused: ' + error.message; } }
    finally { if (objectiveReview.controller === controller) objectiveReview.controller = null; if (currentReviewRequest(active, epoch)) { active.busy = false; renderObjectiveReview(); } }
    if (!currentReviewRequest(active, epoch)) return;
    if (complete) await loadObjectiveReviewReport(active, epoch);
    else scheduleObjectiveReview(active, epoch);
  }
  function beginObjectiveReviewWatch(active, manual = false) {
    if (!sameReviewSession(active) || !reviewVisible() || !active.job || active.creating || active.busy) return;
    stopReviewRequests(); active.checks = 0; active.paused = false; active.message = ''; active.reportRequested = false;
    const epoch = objectiveReview.epoch; renderObjectiveReview();
    if (active.report) return;
    if (reviewTerminal.has(active.job.status) && active.job.status !== 'succeeded' && !manual) { active.paused = true; active.message = 'Review ' + statusLabel(active.job.status).toLowerCase() + (active.job.errorCode ? ': ' + statusLabel(active.job.errorCode) : '') + '. No business action was executed.'; renderObjectiveReview(); return; }
    if (active.job.status === 'succeeded') loadObjectiveReviewReport(active, epoch);
    else scheduleObjectiveReview(active, epoch);
  }
  async function prepareObjectiveReview(item, force = false) {
    if (!canPrepareReview() || !reviewVisible() || objectiveReview.active?.creating) return;
    const previous = objectiveReview.active;
    if (!force && !previous?.stale && previous?.objectiveId === item.id && previous.objectiveRevision === item.revision && sameReviewSession(previous) && previous.job) { renderObjectiveReview(); if (!previous.busy && !previous.report) beginObjectiveReviewWatch(previous, true); return; }
    resetObjectiveReview();
    const active = { objectiveId: item.id, objectiveRevision: item.revision, title: item.title, workspaceId: state.data.workspace.id, csrf: state.csrf, session: state.session, generation: state.graphGeneration,
      creating: true, busy: false, paused: false, checks: 0, job: null, report: null, stale: false, reportRequested: false, message: '' };
    objectiveReview.active = active; renderObjectiveReview();
    try {
      const payload = await request('/api/business-objectives/reviews', { method: 'POST', body: JSON.stringify({ objectiveId: item.id, objectiveRevision: item.revision }) });
      if (!sameReviewSession(active)) return;
      acceptReviewJob(active, payload);
      active.creating = false; renderObjectiveReview();
      if (reviewVisible() && !active.paused) beginObjectiveReviewWatch(active);
      else { active.paused = true; active.message = 'Review requested. Select Check status when you return.'; renderObjectiveReview(); }
    } catch (error) { if (sameReviewSession(active)) { active.creating = false; active.paused = true; active.message = 'Could not prepare the review: ' + error.message; renderObjectiveReview(); } }
  }
  $('#refresh-objective-review').addEventListener('click', () => {
    const active = objectiveReview.active, item = state.objectiveSnapshot?.objectives?.find(row => row.id === active?.objectiveId);
    if (active && sameReviewSession(active) && item?.effectiveStatus === 'active' && state.objectiveSnapshot.workspaceId === active.workspaceId) prepareObjectiveReview(item, true);
  });
  $('#resume-objective-review').addEventListener('click', () => { if (objectiveReview.active) beginObjectiveReviewWatch(objectiveReview.active, true); });
  $('.business-objectives-panel').addEventListener('toggle', () => { if (!$('.business-objectives-panel').open) pauseObjectiveReview('Status checks paused while the objectives panel is closed. Select Check status to continue.'); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseObjectiveReview('Status checks paused while this tab is hidden. Select Check status to continue.'); });
  $('#business-objective-review-result').addEventListener('click', event => {
    const button = event.target.closest('[data-investigate-review-opportunity]');
    if (button) investigateOpportunity(button.dataset.investigateReviewOpportunity);
  });

  function resetObjectiveForm() {
    const form = $('#business-objective-form');
    form.reset(); Object.keys(form.dataset).forEach(key => { delete form.dataset[key]; });
    $('#cancel-objective-edit').classList.add('hidden');
    $('#business-objective-error').textContent = '';
  }
  function renderBusinessObjectives(snapshot) {
    state.objectiveSnapshot = snapshot;
    const root = $('#business-objectives-list'), canEdit = ['owner','admin'].includes(state.data?.user?.role);
    root.innerHTML = (snapshot.objectives || []).length ? snapshot.objectives.map(item => {
      const limits = item.limits || {};
      const policies = [limits.minGrossMarginPercent == null ? null : 'Margin ≥ ' + limits.minGrossMarginPercent + '%', limits.maxMonthlyAdBudget == null ? null : 'Ads ≤ ' + limits.maxMonthlyAdBudget + ' ' + limits.currency + '/month', limits.minStockCoverDays == null ? null : 'Stock ≥ ' + limits.minStockCoverDays + ' days', limits.profitFirst ? 'Profit first' : null].filter(Boolean).join(' · ');
      return '<div><span>' + escapeHtml(item.title) + '<small>' + escapeHtml(statusLabel(item.metric)) + ' · ' + escapeHtml(statusLabel(item.effectiveStatus)) + '</small><small>' + escapeHtml(policies) + '</small></span><b>' + escapeHtml(item.baseline == null ? 'Unknown' : item.baseline) + ' → ' + escapeHtml(item.target) + '</b>' + (canEdit ? '<button class="text-button" type="button" data-edit-objective="' + escapeHtml(item.id) + '">Edit</button>' : '') + (canEdit && item.effectiveStatus === 'active' ? '<button class="secondary" type="button" data-prepare-objective-review="' + escapeHtml(item.id) + '" data-objective-revision="' + escapeHtml(item.revision) + '">Prepare review</button>' : '') + '</div>';
    }).join('') : '<p class="muted">No saved objectives yet.</p>';
    const active = objectiveReview.active;
    if (active) {
      const current = (snapshot.objectives || []).find(item => item.id === active.objectiveId);
      if (!current || current.revision !== active.objectiveRevision || current.effectiveStatus !== 'active') { active.stale = true; active.staleReason = 'Objective changed'; pauseObjectiveReview('Objective changed. This review refers to the previously saved revision.'); }
      renderObjectiveReview();
    }
  }
  $('#cancel-objective-edit').addEventListener('click', resetObjectiveForm);
  $('#business-objectives-list').addEventListener('click', event => {
    const prepare = event.target.closest('[data-prepare-objective-review]');
    if (prepare) {
      const item = state.objectiveSnapshot?.objectives?.find(row => row.id === prepare.dataset.prepareObjectiveReview);
      if (!prepare.disabled && !$('#business-objective-form').querySelector('button[type=submit]').disabled && item?.effectiveStatus === 'active' && item.revision === Number(prepare.dataset.objectiveRevision) && state.objectiveSnapshot.workspaceId === state.data?.workspace?.id) prepareObjectiveReview(item);
      return;
    }
    const button = event.target.closest('[data-edit-objective]');
    if (!button || $('#business-objective-form').querySelector('button[type=submit]').disabled) return;
    const item = state.objectiveSnapshot?.objectives?.find(row => row.id === button.dataset.editObjective);
    if (!item || state.objectiveSnapshot.workspaceId !== state.data?.workspace?.id) return;
    const form = $('#business-objective-form'), fields = form.elements;
    form.dataset.objectiveId = item.id; form.dataset.revision = String(item.revision);
    for (const key of ['title','metric','direction','status','baseline','target']) fields[key].value = item[key] ?? '';
    for (const key of ['startsAt','endsAt']) { const value = new Date(item[key]); fields[key].value = new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0,-1); form.dataset[key + 'Original'] = item[key]; form.dataset[key + 'Display'] = fields[key].value; }
    if (item.limits.currency && !Array.from(fields.currency.options).some(option => option.value === item.limits.currency)) { const option = document.createElement('option'); option.value = item.limits.currency; option.textContent = item.limits.currency; fields.currency.append(option); }
    for (const key of ['currency','minGrossMarginPercent','maxMonthlyAdBudget','minStockCoverDays']) fields[key].value = item.limits[key] ?? '';
    fields.profitFirst.checked = item.limits.profitFirst;
    $('#cancel-objective-edit').classList.remove('hidden');
    fields.title.focus();
  });
  function investigateOpportunity(id) {
    if (!(state.data?.opportunities || []).some(item => item.id === id)) return;
    setView('opportunities');
    const target = Array.from(document.querySelectorAll('[data-opportunity-record]')).find(item => item.dataset.opportunityRecord === id);
    if (target) { target.tabIndex = -1; target.scrollIntoView({block:'center'}); target.focus(); }
  }
  $('#hg-opportunities').addEventListener('click', event => {
    const button = event.target.closest('[data-investigate-opportunity]');
    if (button) investigateOpportunity(button.dataset.investigateOpportunity);
  });

  $('#load-business-objectives').addEventListener('click', async event => {
    const button = event.currentTarget, generation = state.graphGeneration, csrf = state.csrf;
    if (button.disabled || $('#business-objective-form').querySelector('button[type=submit]').disabled) return;
    const objectiveGeneration = ++state.objectiveGeneration;
    setBusy(button, true, 'Loading…');
    try {
      const snapshot = await request('/api/business-objectives');
      if (generation === state.graphGeneration && csrf === state.csrf && objectiveGeneration === state.objectiveGeneration) renderBusinessObjectives(snapshot);
    } catch(error) { if (generation === state.graphGeneration && csrf === state.csrf && objectiveGeneration === state.objectiveGeneration) $('#business-objectives-list').textContent = error.message; }
    finally { setBusy(button, false); }
  });
  $('#business-objective-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, fields = form.elements, button = form.querySelector('button'), error = $('#business-objective-error');
    if (button.disabled) return;
    const generation = state.graphGeneration, csrf = state.csrf, objectiveGeneration = ++state.objectiveGeneration;
    const number = name => fields[name].value.trim() === '' ? null : Number(fields[name].value);
    const timestamp = name => form.dataset[name + 'Original'] && fields[name].value === form.dataset[name + 'Display'] ? form.dataset[name + 'Original'] : new Date(fields[name].value).toISOString();
    error.textContent = ''; setBusy(button, true, 'Saving…');
    Array.from(fields).forEach(field => { field.disabled = true; });
    try {
      const body = {...(form.dataset.objectiveId ? {id:form.dataset.objectiveId,revision:Number(form.dataset.revision)} : {}), title:fields.title.value, status:fields.status.value, metric:fields.metric.value, baseline:number('baseline'), target:number('target'), direction:fields.direction.value,
        startsAt:timestamp('startsAt'), endsAt:timestamp('endsAt'),
        limits:{currency:fields.currency.value || null, minGrossMarginPercent:number('minGrossMarginPercent'), maxMonthlyAdBudget:number('maxMonthlyAdBudget'), minStockCoverDays:number('minStockCoverDays'), profitFirst:fields.profitFirst.checked}};
      const result = await request('/api/business-objectives', {method:'PUT',body:JSON.stringify(body)});
      if (generation !== state.graphGeneration || csrf !== state.csrf || objectiveGeneration !== state.objectiveGeneration) return;
      renderBusinessObjectives(result.snapshot); resetObjectiveForm(); showMessage('Objective saved. Approval and execution safeguards remain in force.');
    } catch(cause) { if (generation === state.graphGeneration && csrf === state.csrf) error.textContent = cause.message; }
    finally { Array.from(fields).forEach(field => { field.disabled = false; }); setBusy(button, false); }
  });

  $('#load-business-graph').addEventListener('click', async event => {
    const button = event.currentTarget;
    if (button.disabled || !state.data?.workspace?.id) return;
    const workspaceId = state.data.workspace.id, generation = state.graphGeneration, csrf = state.csrf;
    const target = $('#business-graph-result');
    setBusy(button, true, 'Inspecting…');
    target.textContent = 'Reading recorded relationships…';
    try {
      const graph = await request('/api/business-graph');
      if (state.data?.workspace?.id !== workspaceId || state.csrf !== csrf || state.graphGeneration !== generation) return;
      const summary = graph.summary || {}, coverage = graph.coverage || {};
      const rows = [
        ['Recorded entities inspected', summary.nodes || 0],
        ['Evidence-backed links', summary.edges || 0],
        ['Missing or ambiguous mappings', summary.unknownMappings || 0],
        ['Coverage', coverage.truncated ? 'Bounded sample; not the whole business' : 'Retained workspace records only'],
        ...Object.entries(summary.nodesByType || {}).map(([kind,count]) => [statusLabel(kind), count]),
        ...Object.entries(summary.unknownByReason || {}).slice(0,12).map(([reason,count]) => [statusLabel(reason), count])
      ];
      target.innerHTML = rows.map(([label,value]) => '<div><span>' + escapeHtml(label) + '</span><b>' + escapeHtml(value) + '</b></div>').join('') +
        '<p class="muted tiny">Read-only links to existing records. A shared SKU is not proof of the same product, and a campaign link is not proof of revenue attribution.</p>';
    } catch(error) {
      if (state.data?.workspace?.id === workspaceId && state.csrf === csrf && state.graphGeneration === generation) target.textContent = 'Could not inspect relationships: ' + error.message;
    } finally { setBusy(button, false); }
  });

  $('#fleet-provider-usage-refresh').addEventListener('click', async event => {
    const button=event.currentTarget, workspace=$('#fleet-provider-usage-workspace'), month=$('#fleet-provider-usage-month'), target=$('#fleet-provider-usage-result');
    if (button.disabled || !state.data?.launchAdmin) return;
    const generation=state.graphGeneration, csrf=state.csrf;
    if (!workspace.value || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month.value)) { target.textContent='Select a workspace and valid UTC month.'; return; }
    setBusy(button,true,'Reading ledger…');workspace.disabled=true;month.disabled=true;
    try {
      const result=await request('/api/operator/provider-usage?workspaceId='+encodeURIComponent(workspace.value)+'&month='+encodeURIComponent(month.value));
      if (generation!==state.graphGeneration || csrf!==state.csrf) return;
      if (!result.available) { target.textContent='Governed accounting is unavailable: '+statusLabel(result.reason || 'unknown')+'. This does not mean zero provider spend.'; return; }
      if (!result.scopes?.length) { target.textContent='No governed reservations recorded for this month. Legacy activity and provider billing are not included.'; return; }
      target.innerHTML=result.scopes.map(scope=>{
        const held=scope.held || {}, settled=scope.settled || {};
        return '<div><span>'+escapeHtml(scope.scopeKey)+'<small>'+escapeHtml(result.admissionMonth)+' · USD · recorded governed usage only</small></span><b>'+escapeHtml(settled.requests ?? 'Unknown')+' settled requests<small>'+escapeHtml(held.requests ?? 'Unknown')+' held or uncertain requests</small></b></div>'+
          '<div><span>Estimated settled cost / held exposure</span><b>'+escapeHtml(usd(settled.costMicros == null ? null : settled.costMicros/1000000))+' / '+escapeHtml(usd(held.costMicros == null ? null : held.costMicros/1000000))+'</b></div>'+
          '<div><span>Settled tokens / held token bounds</span><b>'+escapeHtml(settled.totalTokens ?? 'Unknown')+' / '+escapeHtml(held.totalTokens ?? 'Unknown')+'</b></div>';
      }).join('')+'<p class="muted tiny">Tenant and provider rows overlap; do not add them together. Held amounts include requests whose final usage is not established.</p>';
    } catch(error) { if (generation===state.graphGeneration && csrf===state.csrf) target.textContent='Could not read governed accounting: '+error.message; }
    finally { workspace.disabled=false;month.disabled=false;setBusy(button,false); }
  });

  $('#fleet-refresh').addEventListener('click', async event => {
    const button=event.currentTarget; setBusy(button,true,'Refreshing…');
    try { await loadFleet(); showMessage('Fleet status refreshed.'); } catch(error) { showMessage(error.message,'error'); }
    finally { setBusy(button,false); }
  });
  $('#fleet-search').addEventListener('input', event => { state.fleetQuery=event.target.value; renderFleet(); });
  $('#fleet-workspaces').addEventListener('click', async event => {
    const pause=event.target.closest('[data-fleet-pause]');
    const retry=event.target.closest('[data-fleet-retry]');
    if (pause) {
      setBusy(pause,true,pause.dataset.paused==='true'?'Resuming…':'Pausing…');
      try { await request('/api/operator/agent-ops/workspaces/'+encodeURIComponent(pause.dataset.fleetPause),{method:'PUT',body:JSON.stringify({paused:pause.dataset.paused!=='true'})}); await loadFleet(); showMessage('Workspace Agent Ops control updated.'); }
      catch(error){showMessage(error.message,'error');} finally{setBusy(pause,false);}
    }
    if (retry) {
      setBusy(retry,true,'Queueing…');
      try { await request('/api/operator/agent-ops/workspaces/'+encodeURIComponent(retry.dataset.workspace)+'/jobs/'+encodeURIComponent(retry.dataset.fleetRetry)+'/retry',{method:'POST',body:'{}'}); await loadFleet(); showMessage('Job returned to the safe queue.'); }
      catch(error){showMessage(error.message,'error');} finally{setBusy(retry,false);}
    }
  });
  $('#fleet-workspaces').addEventListener('submit', async event => {
    const form=event.target.closest('[data-fleet-settings]'); if(!form)return; event.preventDefault();
    const button=form.querySelector('button[type="submit"]'); setBusy(button,true,'Saving…');
    const monthlyRaw=form.elements.monthlyCostLimitUsd.value.trim();
    try { await request('/api/operator/agent-ops/workspaces/'+encodeURIComponent(form.dataset.fleetSettings),{method:'PUT',body:JSON.stringify({
      maxConcurrentJobs:Number(form.elements.maxConcurrentJobs.value),
      dailyAiUnitLimit:Number(form.elements.dailyAiUnitLimit.value),
      routingMode:form.elements.routingMode.value,
      monthlyCostLimitUsd:monthlyRaw===''?null:Number(monthlyRaw)
    })}); await loadFleet(); showMessage('Fleet AI routing and limits saved.'); }
    catch(error){showMessage(error.message,'error');} finally{setBusy(button,false);}
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

  $('#marketing-provider-list').addEventListener('click', async event => {
    const open = event.target.closest('[data-marketing-provider-open]');
    if (open) {
      const details = $('#marketing-' + open.dataset.marketingProviderOpen + '-setup');
      details?.classList.remove('hidden'); if (details) details.open = true;
      details?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return;
    }
    const test = event.target.closest('[data-marketing-provider-test]');
    if (test) {
      setBusy(test, true, 'Testing…');
      try { const payload = await request('/api/marketing/providers/' + encodeURIComponent(test.dataset.marketingProviderTest) + '/test', { method:'POST', body:'{}' }); await loadBootstrap({ migrate:false }); setView('marketing'); showMessage(payload.result?.limitation ? 'Authentication verified. The API project requires attention before generation.' : 'Provider connection verified.'); }
      catch (error) { showMessage(error.message, 'error'); }
      finally { setBusy(test, false); }
      return;
    }
    const refresh = event.target.closest('[data-marketing-provider-refresh]');
    if (refresh) {
      setBusy(refresh, true, 'Refreshing…');
      try { await request('/api/marketing/providers/canva/refresh', { method:'POST', body:'{}' }); await loadBootstrap({ migrate:false }); setView('marketing'); showMessage('Canva access renewed and tested.'); }
      catch (error) { await loadBootstrap({ migrate:false }); showMessage(error.message, 'error'); }
      finally { setBusy(refresh, false); }
      return;
    }
    const disconnect = event.target.closest('[data-marketing-provider-disconnect]');
    if (disconnect) {
      if (!window.confirm('Disconnect this creative provider from Runvara? Existing campaign history will be kept.')) return;
      setBusy(disconnect, true, 'Disconnecting…');
      try { await request('/api/marketing/providers/' + encodeURIComponent(disconnect.dataset.marketingProviderDisconnect), { method:'DELETE' }); await loadBootstrap({ migrate:false }); setView('marketing'); showMessage('Creative provider disconnected.'); }
      catch (error) { showMessage(error.message, 'error'); }
      finally { setBusy(disconnect, false); }
    }
  });

  $('#marketing-canva-oauth').addEventListener('click', async event => {
    const button = event.currentTarget;
    setBusy(button, true, 'Opening Canva…');
    try { const payload = await request('/api/marketing/providers/canva/oauth/start', { method:'POST', body:'{}' }); window.location.assign(payload.authorizationUrl); }
    catch (error) { showMessage(error.message, 'error'); setBusy(button, false); }
  });
  $('#marketing-canva-application').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button[type="submit"]');
    setBusy(button, true, 'Saving…');
    try { await request('/api/marketing/providers/canva/application', { method:'PUT', body:JSON.stringify(Object.fromEntries(new FormData(form))) }); form.reset(); await loadBootstrap({ migrate:false }); showMessage('Application saved securely. Sign in with Canva next.'); }
    catch (error) { showMessage(error.message, 'error'); }
    finally { setBusy(button, false); }
  });
  let canvaContinuation = '';
  $('#marketing-canva-discover').addEventListener('click', async event => {
    const button = event.currentTarget; setBusy(button, true, 'Loading…');
    try {
      const payload = await request('/api/marketing/providers/canva/templates' + (canvaContinuation ? '?continuation=' + encodeURIComponent(canvaContinuation) : ''));
      const select = $('#marketing-canva-templates');
      if (!canvaContinuation) select.innerHTML = '<option value="">Choose an autofill Brand Template</option>';
      select.insertAdjacentHTML('beforeend', (payload.items || []).map(item => '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.title) + '</option>').join(''));
      canvaContinuation = payload.continuation || '';
      showMessage(payload.items?.length ? 'Choose your Packsmart template and use & test it.' : 'No autofill Brand Templates were found. Create and tag a template in Canva first.');
    } catch (error) { showMessage(error.message, 'error'); }
    finally { setBusy(button, false); button.textContent = canvaContinuation ? 'Load more Brand Templates' : 'Load Brand Templates'; }
  });
  $('#marketing-canva-template').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button[type="submit"]');
    setBusy(button, true, 'Testing…');
    try { await request('/api/marketing/providers/canva/template', { method:'PUT', body:JSON.stringify(Object.fromEntries(new FormData(form))) }); await loadBootstrap({ migrate:false }); showMessage('Canva Brand Template verified and connected.'); }
    catch (error) { showMessage(error.message, 'error'); }
    finally { setBusy(button, false); }
  });

  $$('[data-marketing-provider-form]').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    const provider = form.dataset.marketingProviderForm, button = form.querySelector('button[type="submit"]');
    const payload = Object.fromEntries(new FormData(form));
    setBusy(button, true, 'Connecting…');
    try {
      await request('/api/marketing/providers/' + encodeURIComponent(provider), { method:'PUT', body:JSON.stringify(payload) });
      form.reset(); await loadBootstrap({ migrate:false }); setView('marketing'); showMessage(state.data.marketing?.providers?.[provider]?.status === 'connected' ? 'Creative provider connected.' : 'API credentials verified. Review the provider recovery message.');
    } catch (error) { form.reset(); await loadBootstrap({ migrate:false }); showMessage(error.message, 'error'); }
    finally { setBusy(button, false); }
  }));

  $('#marketing-settings-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    setBusy(button, true, 'Saving…');
    try {
      await request('/api/marketing/settings', { method: 'PUT', body: JSON.stringify({
        enabled: form.elements.enabled.checked,
        mode: form.elements.mode.value,
        dailyOrganicLimit: Number(form.elements.dailyOrganicLimit.value),
        minMarginPercent: Number(form.elements.minMarginPercent.value),
        minInventory: Number(form.elements.minInventory.value),
        autoCreative: form.elements.autoCreative.checked,
        allowPaidAds: false
      }) });
      await loadBootstrap({ migrate: false });
      showMessage('Marketing Autopilot controls saved.');
    } catch (error) { showMessage(error.message, 'error'); }
    finally { setBusy(button, false); }
  });

  $('#re-experiment-create-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form=event.currentTarget, button=form.querySelector('button[type="submit"]');
    const opportunityId=form.elements.opportunityId.value;
    if(!opportunityId) return;
    setBusy(button,true,'Creating…');
    try {
      await request('/api/opportunities/'+encodeURIComponent(opportunityId)+'/experiment',{method:'POST',body:JSON.stringify({
        metric:form.elements.metric.value,
        hypothesis:form.elements.hypothesis.value
      })});
      form.reset(); await loadBootstrap({migrate:false}); setView('revenue-engine'); showMessage('Draft experiment created from the selected opportunity.');
    } catch(error){ showMessage(error.message,'error'); }
    finally{ setBusy(button,false); }
  });

  $('#re-experiment-measure-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form=event.currentTarget, button=form.querySelector('button[type="submit"]'), id=form.elements.experimentId.value;
    if(!id) return;
    const payload={method:form.elements.method.value};
    for(const field of ['incrementalContribution','contributionProtected','costAvoided','incrementalRevenue','minutesSaved']){
      const raw=form.elements[field].value.trim();
      if(raw!=='') payload[field]=Number(raw);
    }
    setBusy(button,true,'Recording…');
    try {
      await request('/api/revenue-engine/experiments/'+encodeURIComponent(id)+'/measure',{method:'POST',body:JSON.stringify(payload)});
      form.reset(); await loadBootstrap({migrate:false}); setView('revenue-engine'); showMessage('Measurement recorded. It will not influence learning until explicitly verified.');
    } catch(error){ showMessage(error.message,'error'); }
    finally{ setBusy(button,false); }
  });

  $('#re-experiment-verify-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form=event.currentTarget, button=form.querySelector('button[type="submit"]'), id=form.elements.experimentId.value;
    if(!id) return;
    setBusy(button,true,'Verifying…');
    try {
      await request('/api/revenue-engine/experiments/'+encodeURIComponent(id)+'/verify',{method:'POST',body:JSON.stringify({note:form.elements.note.value})});
      form.reset(); await loadBootstrap({migrate:false}); setView('revenue-engine'); showMessage('Experiment verified. Runvara can now use the realised result as learning evidence.');
    } catch(error){ showMessage(error.message,'error'); }
    finally{ setBusy(button,false); }
  });

  $('#re-growth-capacity-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form=event.currentTarget, button=form.querySelector('button[type="submit"]');
    const hours=form.elements.growthCapacityHours.value.trim(), concurrent=form.elements.maxConcurrentGrowthExperiments.value.trim();
    setBusy(button,true,'Saving…');
    try {
      await request('/api/hypergrowth/settings',{method:'PUT',body:JSON.stringify({
        growthCapacityHours:hours===''?null:Number(hours),
        maxConcurrentGrowthExperiments:concurrent===''?null:Number(concurrent)
      })});
      await loadBootstrap({migrate:false}); setView('revenue-engine'); showMessage('Growth capacity saved. Runvara execution priorities have been refreshed.');
    } catch(error){ showMessage(error.message,'error'); }
    finally{ setBusy(button,false); }
  });

  $('#marketing-new-campaign').addEventListener('click', async event => {
    const button = event.currentTarget;
    setBusy(button, true, 'Preparing…');
    try {
      const payload = await request('/api/marketing/campaigns', { method: 'POST', body: '{}' });
      await loadBootstrap({ migrate: false });
      setView('marketing');
      showMessage('Campaign prepared for ' + (payload.campaign?.product?.title || 'an eligible product') + '.');
    } catch (error) { showMessage(error.message, 'error'); }
    finally { setBusy(button, false); }
  });

  $('#marketing-campaign-list').addEventListener('click', async event => {
    const creativeButton = event.target.closest('[data-marketing-creatives]');
    if (creativeButton) {
      setBusy(creativeButton, true, 'Working…');
      try {
        const result = await request('/api/marketing/campaigns/' + encodeURIComponent(creativeButton.dataset.marketingCreatives) + '/creatives/advance', { method: 'POST', body: '{}' });
        await loadBootstrap({ migrate: false });
        setView('marketing');
        showMessage(result.ownerAction || 'Creative status checked. New generation requires an approved provider allowance.');
      } catch (error) { showMessage(error.message, 'error'); }
      finally { setBusy(creativeButton, false); }
      return;
    }
    const button = event.target.closest('[data-marketing-approval]');
    if (!button) return;
    setBusy(button, true, 'Requesting…');
    try {
      await request('/api/marketing/campaigns/' + encodeURIComponent(button.dataset.marketingApproval) + '/request-publish-approval', { method: 'POST', body: '{}' });
      await loadBootstrap({ migrate: false });
      setView('approvals');
      showMessage('Marketing publication approval added to the Approval Centre.');
    } catch (error) { showMessage(error.message, 'error'); }
    finally { setBusy(button, false); }
  });

  $('#radar-target-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, button = form.querySelector('button[type="submit"]');
    setBusy(button, true, 'Adding…');
    try {
      await request('/api/web-intelligence/targets', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.reset(); await loadBootstrap({ migrate: false }); setView('market-radar');
      showMessage('Market Radar watchlist updated.');
    } catch (error) { showMessage(error.message, 'error'); }
    finally { setBusy(button, false); }
  });

  $('#radar-scan-all').addEventListener('click', async event => {
    const button = event.currentTarget; setBusy(button, true, 'Scanning…');
    try {
      const payload = await request('/api/web-intelligence/scan', { method: 'POST', body: '{}' });
      await loadBootstrap({ migrate: false }); setView('market-radar');
      showMessage(payload.result?.ownerAction || ((payload.result?.scanned || 0) > 0 ? 'Market Radar verified ' + payload.result.scanned + ' page(s).' : 'No new scans ran. Saved targets and findings remain available.'));
    } catch (error) { showMessage(error.message, 'error'); }
    finally { setBusy(button, false); }
  });

  $('#radar-target-list').addEventListener('click', async event => {
    const scan = event.target.closest('[data-radar-scan]');
    if (scan) {
      setBusy(scan, true, 'Scanning…');
      try {
        const payload = await request('/api/web-intelligence/scan', { method: 'POST', body: JSON.stringify({ targetId: scan.dataset.radarScan }) });
        await loadBootstrap({ migrate: false }); setView('market-radar'); showMessage(payload.result?.ownerAction || 'No new scan ran. Saved findings remain available.');
      } catch (error) { showMessage(error.message, 'error'); }
      finally { setBusy(scan, false); }
      return;
    }
    const toggle = event.target.closest('[data-radar-toggle]');
    if (!toggle) return;
    toggle.disabled = true;
    try {
      await request('/api/web-intelligence/targets/' + encodeURIComponent(toggle.dataset.radarToggle), { method: 'PUT', body: JSON.stringify({ active: toggle.getAttribute('aria-pressed') !== 'true' }) });
      await loadBootstrap({ migrate: false }); setView('market-radar');
    } catch (error) { showMessage(error.message, 'error'); toggle.disabled = false; }
  });

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
  $('#logout').addEventListener('click', async () => { pauseObjectiveReview('Signing out. Status checks paused.'); resetAutomationHistory(); try { await request('/api/auth/logout', { method: 'POST', body: '{}' }); } finally { state.session = null; state.data = null; state.csrf = ''; showLogin(); } });
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
        if (connectionReturn.searchParams.has('canva')) {
          setView('marketing');
          showMessage(connectionReturn.searchParams.get('canva') === 'authorised' ? 'Canva sign-in complete. Load Brand Templates and choose the Packsmart template.' : 'Canva requires attention. Open setup and reconnect.', connectionReturn.searchParams.get('canva') === 'authorised' ? undefined : 'error');
          connectionReturn.searchParams.delete('canva'); window.history.replaceState(null, '', connectionReturn.pathname + connectionReturn.search);
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
