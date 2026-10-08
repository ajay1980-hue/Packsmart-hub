(() => {
  'use strict';

  const LOCAL = {
    economics: 'packsmart-saas-economics-v1',
    automations: 'packsmart-saas-automations-v1',
    migrated: 'packsmart-saas-cloud-migration-v3'
  };
  const state = {
    csrf: '', session: null, data: null, graphGeneration: 0, graphInspectionGeneration: 0, graphTicket: null, objectiveGeneration: 0, objectiveSnapshot: null, audit: [], fleet: null, fleetQuery: '', view: 'overview',
    productQuery: '', productStatus: 'active', productSort: 'product',
    orderFilter: 'all', approvalFilter: 'pending'
  };
  const objectiveUI = { epoch: 0, editor: null, read: null, mutation: null, snapshotContext: null, referenceCache: null, planningBaseline: '', needsReload: false, unknownSave: false };
  const objectiveContent = { editor:null, ticket:null, handoff:null, epoch:0, previous:null };
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

  function countLabel(value) {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : 'Unknown';
  }

  function recordedDecimal(value) {
    // Projection decimals are exact strings. Never round or aggregate them in the browser.
    return typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) ? value : 'Unknown';
  }

  function recordedInput(value) {
    // Raw editor evidence keeps its spelling and is never a qualified financial amount.
    if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) return 'Unknown';
    if (typeof value !== 'string' && typeof value !== 'number') return 'Unknown';
    const raw = String(value);
    if (raw.length > 33 || !/^[+-]?(?:\d+(?:\.\d{1,6})?|\.\d{1,6})$/.test(raw)) return 'Unknown';
    const whole = raw.replace(/^[+-]/, '').split('.')[0];
    return (whole.replace(/^0+/, '') || '0').length <= 24 ? raw : 'Unknown';
  }

  function importedEvidence(period) {
    let evidence = period?.importedOrderEvidence;
    const ref = period?.evidenceRef;
    if (!evidence && ref?.period === 'last30d') {
      const shared = state.data.dashboard?.last30d?.importedOrderEvidence;
      if (shared?.schema === 'imported-order-evidence/v1') evidence = { ...shared,
        groups: (shared.groups || []).filter(group => group.provider === ref.provider),
        sourcePeriods: (shared.sourcePeriods || []).filter(source => source.provider === ref.provider),
        counts: { ...shared.counts, retainedOrders: period.orders }
      };
    }
    return evidence?.schema === 'imported-order-evidence/v1' ? evidence : null;
  }

  function recordedCurrency(group) {
    return typeof group?.currency === 'string' && /^[A-Z]{3}$/.test(group.currency)
      ? group.currency + ' · unverified recorded code' : 'Unknown currency · sums withheld';
  }

  function recordedMetric(metric, completeAllowed = true) {
    if (!metric) return '<span>Unknown</span>';
    return '<strong>' + escapeHtml(recordedDecimal(metric.knownSubtotal)) + '</strong><br><small>Known subtotal · ' +
      escapeHtml(countLabel(metric.knownCount)) + ' known / ' + escapeHtml(countLabel(metric.unknownCount)) + ' unknown</small><br><small>Complete retained cohort: ' +
      escapeHtml(completeAllowed && metric.complete === true ? recordedDecimal(metric.completeCohortTotal) : 'Unavailable') + '</small>';
  }

  function numericCostLabel(costs) {
    const ratio = costs?.orderCoverage;
    return ratio ? countLabel(ratio.numerator) + ' / ' + countLabel(ratio.denominator) + ' retained orders' : 'Unavailable';
  }

  function importedEvidenceTable(period, { details = false, collapsed = false } = {}) {
    const evidence = importedEvidence(period);
    if (!evidence) return '<p class="empty-state">Imported order evidence unavailable. Source-period coverage is unverified; business totals are unavailable.</p>';
    const completeness = evidence.completeness || {}, presentation = evidence.presentation || {};
    const clipped = presentation.truncated === true;
    const completeAllowed = !clipped && completeness.retainedCohortComplete === true;
    const truncatedAreas = Object.entries(completeness.truncated || {}).filter(([, value]) => value === true).map(([key]) => statusLabel(key));
    const clippingNote = clipped ? '<p class="missing-inputs">Partial grouped view: ' + escapeHtml(countLabel(presentation.groupsReturned)) + ' of ' + escapeHtml(countLabel(presentation.groupsAvailable)) + ' period groups returned. Other groups may be omitted; complete-cohort totals and value coverage are withheld.</p>' : '';
    const scanNote = truncatedAreas.length ? '<p class="missing-inputs">Bounded projection truncated: ' + escapeHtml(truncatedAreas.join(', ')) + '. Known subtotals describe only the scanned subset.</p>' : '';
    const windowLabel = evidence.period ? 'Recorded order dates: ' + evidence.period.startAt + ' (inclusive) to ' + evidence.period.endAt + ' (exclusive).' : 'Period unavailable';
    const retainedOrders = evidence.counts?.retainedOrders ?? (evidence.groups?.length === 1 ? evidence.groups[0].orders : undefined);
    const providers = (evidence.sourcePeriods || []).map(item => '<li>' + escapeHtml(statusLabel(item.provider)) + '</li>').join('');
    const unresolved = [!completeness.scanComplete && 'Scan incomplete', (!completeness.outputComplete || clipped) && 'Output incomplete', !completeness.eligibilityResolved && 'Eligibility unresolved'].filter(Boolean);
    const note = '<p class="imported-evidence-warning">Retained recorded amounts only, not verified business revenue, profit or collected cash. Source period unverified.</p>' +
      '<p class="signal-note">Retained orders: ' + escapeHtml(countLabel(retainedOrders)) + (unresolved.length ? ' · ' + escapeHtml(unresolved.join(' · ')) : '') + '</p>' + clippingNote + scanNote +
      '<details class="evidence imported-evidence-provenance"><summary>Source period and evidence details</summary><p class="signal-note">' + escapeHtml(windowLabel) + '</p>' +
      '<p class="muted tiny">Normalized recorded amounts may contain importer defaults or derived values. Currency recognition and source currency are unverified.</p>' +
      '<p class="muted tiny">The refund field may be a derived total difference, and the tax field may repeat current tax. Neither proves a provider refund or original tax. Refund review uses recorded financial status only; it does not verify a refund payment or completed action.</p>' +
      '<p class="muted tiny">Scan ' + (completeness.scanComplete ? 'complete' : 'incomplete') +
      ' · Output ' + (completeness.outputComplete && !clipped ? 'complete' : 'incomplete') + ' · Eligibility ' + (completeness.eligibilityResolved ? 'resolved' : 'unresolved') +
      '. Financial qualification unavailable. Numeric cost completeness does not establish historical cost assignment.</p>' +
      (providers ? '<p class="muted tiny">Source-period coverage is unverified for every provider listed here:</p><ul class="imported-source-list">' + providers + '</ul>' : '<p class="muted tiny">Source-period coverage is unverified.</p>') + '</details>';
    if (!evidence.groups?.length) return note + '<p class="empty-state">No retained order groups for this selection. An empty retained collection does not establish zero sales.</p>';
    const fields = [['total','Recorded total'],['currentTotal','Recorded current total'],['refunds','Stored refund field · basis unverified'],['tax','Stored tax field · basis unverified'],['currentTax','Recorded current tax'],['discounts','Recorded discounts'],['shippingCharged','Recorded shipping charged'],['netTotal','Normalized net total'],['netTotalExCurrentTax','Normalized net less current tax']];
    const rows = evidence.groups.map(group => {
      const costs = group.costNumbers || {}, coverage = completeAllowed ? costs.netTotalCoverage : null;
      const extra = details ? '<details class="evidence"><summary>Amounts and costs</summary><dl>' + fields.map(([key,label]) => '<div><dt>' + label + '</dt><dd>' + recordedMetric(group.recordedAmounts?.[key], completeAllowed) + '</dd></div>').join('') +
        '<div><dt>Net subtotal with numeric costs</dt><dd>' + recordedMetric(costs.coveredNetTotal, completeAllowed) + '</dd></div><div><dt>Exact numeric cost / net amount coverage</dt><dd>' +
        escapeHtml(coverage ? recordedDecimal(coverage.numerator) + ' / ' + recordedDecimal(coverage.denominator) : 'Unavailable') + '</dd></div></dl></details>' : '';
      return '<tr><td>' + escapeHtml(statusLabel(group.provider)) + '</td><td>' + escapeHtml(recordedCurrency(group)) + '</td><td>' + escapeHtml(statusLabel(group.financialStatus)) +
        '</td><td>' + (group.cancelled ? 'Cancelled' : 'Not recorded cancelled') + '</td><td>' + escapeHtml(countLabel(group.orders)) + '</td><td>' + recordedMetric(group.recordedAmounts?.netTotal, completeAllowed) + extra +
        '</td><td>' + recordedMetric(group.recordedAmounts?.refunds, completeAllowed) + '</td><td>' + escapeHtml(numericCostLabel(costs)) + '<small>' + escapeHtml(countLabel(costs.incompleteOrders)) +
        ' incomplete · retained cost cohort ' + (!completeAllowed ? 'unavailable' : costs.completeCohort === true ? 'complete' : costs.completeCohort === false ? 'incomplete' : 'unavailable') + '</small><small>Profit / margin / cash: unavailable</small></td></tr>';
    }).join('');
    const table = '<div class="table-wrap table-scroll"><table class="imported-evidence-table"><caption>Exact recorded amounts, grouped by provider, currency, status and cancellation</caption><thead><tr><th scope="col">Provider</th><th scope="col">Recorded currency</th><th scope="col">Recorded status</th><th scope="col">Cancellation</th><th scope="col">Orders</th><th scope="col">Recorded net amount</th><th scope="col">Stored refund field</th><th scope="col">Numeric cost availability</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    return note + (collapsed ? '<details class="evidence imported-evidence-cohorts"><summary>Inspect exact recorded groups</summary>' + table + '</details>' : table);
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
    if (response.status === 401 && !config.signal?.aborted && (typeof config.isCurrent !== 'function' || config.isCurrent()) && state.session === originatingSession && state.csrf === originatingCsrf && !path.endsWith('/login') && !path.endsWith('/activate-owner') && !path.endsWith('/signup-options')) {
      state.session = null; state.data = null; state.csrf = ''; showLogin();
    }
    if (!response.ok) {
      const error = new Error(payload.code === 'AUTH_REQUIRED' ? 'Your Runvara session has expired. Sign in again to continue.' : payload.error || 'Request failed (' + response.status + ')');
      error.status = response.status; error.code = payload.code; throw error;
    }
    return payload;
  }

  function showLogin() {
    resetObjectiveEditing(true);
    resetBusinessGraph(true);
    resetObjectiveReview(); resetAutomationHistory(); window.RunvaraOutcomes?.reset(); window.RunvaraActivity?.reset();
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
    window.RunvaraConnections?.interruptContent('Password replacement required', true);
    resetObjectiveEditing(true);
    resetBusinessGraph(true);
    resetObjectiveReview(); resetAutomationHistory(); window.RunvaraOutcomes?.reset(); window.RunvaraActivity?.reset();
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
      resetBusinessGraph(); state.session = session; state.csrf = session.csrf;
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
    window.RunvaraConnections?.interruptContent('Workspace refresh started');
    objectiveUI.referenceCache = null;
    resetObjectiveEditing();
    resetBusinessGraph();
    const config = Object.assign({ migrate: true }, options || {});
    if (config.migrate) {
      try { await migratePilotData(); }
      catch (error) { showMessage('Pilot migration needs attention: ' + error.message, 'error'); }
    }
    const data = await request('/api/bootstrap');
    resetBusinessGraph();
    if (state.data?.workspace?.id !== data.workspace.id || state.data?.user?.id !== data.user?.id || state.data?.user?.role !== data.user?.role) resetObjectiveEditing(true);
    state.data = data; state.csrf = data.csrf || state.csrf;
    state.graphGeneration++; state.objectiveGeneration++; resetObjectiveReview(); resetAutomationHistory(); window.RunvaraOutcomes?.reset(); window.RunvaraActivity?.reset();
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
    if (view !== state.view) window.RunvaraConnections?.interruptContent('Navigation changed');
    if (view !== state.view) resetObjectiveEditing();
    if (view !== 'overview') resetBusinessGraph(true);
    if (view !== state.view) { window.RunvaraOutcomes?.pause(); window.RunvaraActivity?.pause(); }
    if (view !== state.view) pauseObjectiveReview('Status checks paused after leaving the review. Select Check status to continue.');
    closeWorkspaceSearch();
    state.view = view;
    $$('.nav-item').forEach(item => { item.classList.toggle('active', item.dataset.view === view); if (item.dataset.view === view) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); });
    document.body.classList.remove('nav-open'); $('#mobile-menu').setAttribute('aria-expanded','false');
    $$('.view').forEach(item => item.classList.toggle('active', item.id === 'view-' + view));
    const titles = { overview: 'Command Centre', 'revenue-engine': 'Revenue Engine', analytics: 'Analytics', 'ai-team': 'AI Team', marketing: 'Marketing Autopilot', 'market-radar': 'Market Radar', profit: 'Products & Profit', orders: 'Orders & Recorded Costs', suppliers: 'Suppliers & Costs', channels: 'Connection Centre', approvals: 'Approval Centre', automations: 'Automation Rules', issues: 'Exception Centre', opportunities: 'Opportunities', memory: 'Decision Memory', value: 'Value & Work', audit: 'Audit & Account', fleet: 'Operator Fleet' };
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
    const channels = (state.data.integrations || []).filter(item => ['commerce', 'marketplace', 'social-commerce'].includes(item.kind) && (item.metrics30d || item.lastSyncAt || item.status === 'connected'));
    $('#revenue-chart').innerHTML = channels.length ? channels.map(channel => '<details class="evidence"><summary>' + escapeHtml(channel.name) + ' · ' + escapeHtml(countLabel(channel.metrics30d?.orders)) + ' retained orders</summary>' + importedEvidenceTable(channel.metrics30d) + '</details>').join('') : '<div class="empty-state">No imported channel evidence is available yet. Source-period coverage remains unverified.</div>';
  }

  function applyTarget(view, filter) {
    if (view === 'profit' && filter) { state.productStatus = filter; $('#product-status').value = filter; renderProducts(); }
    if (view === 'orders' && filter) { state.orderFilter = filter; $('#order-filter').value = filter; renderOrders(); }
    if (view === 'approvals' && filter) { state.approvalFilter = filter; $('#approval-filter').value = filter; renderApprovals(); }
  }

  function statusClass(status) {
    if (['connected', 'ready', 'configured', 'deterministic', 'internal', 'profitable', 'confirmed-costs'].includes(status)) return 'good';
    if (['error', 'failed', 'auth_expired', 'loss-making'].includes(status)) return 'bad';
    if (['warning', 'needs approval', 'degraded', 'not_configured', 'dormant', 'configured_disabled', 'below-floor', 'missing-costs', 'missing-price', 'margin-unavailable', 'incomplete', 'estimated-costs'].includes(status)) return 'warn';
    return 'neutral';
  }

  function statusLabel(status) {
    return String(status || 'unknown').replaceAll('_', ' ').replaceAll('-', ' ').replace(/\b\w/g, value => value.toUpperCase());
  }

  function metricRows(period) {
    return [
      ['Retained orders', countLabel(period.orders)], ['Recorded open orders', countLabel(period.openOrders)],
      ['Revenue / cash', 'Unavailable'], ['Profit / margin', 'Unavailable'],
      ['Numeric cost availability', numericCostLabel(period.numericCostCoverage)], ['Source-period coverage', 'Unverified']
    ].map(item => '<div><span>' + escapeHtml(item[0]) + '</span><strong>' + escapeHtml(item[1]) + '</strong></div>').join('') +
      '<details class="evidence"><summary>Inspect exact retained cohorts</summary>' + importedEvidenceTable(period, { details: true }) + '</details>';
  }

  function channelCard(channel) {
    const metrics = channel.metrics30d;
    const metricHtml = metrics ? '<div class="channel-metrics"><span><b>' + escapeHtml(countLabel(metrics.orders)) + '</b> retained orders</span><span>Source period unverified</span><span>Revenue / profit unavailable</span></div>' : '';
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
    const dashboard = state.data.dashboard || {}, signals = dashboard.revenueSignals || {};
    const period = signals.periodRef === 'last30d' ? dashboard.last30d : signals.period || dashboard.last30d;
    $('#revenue-trajectory').innerHTML = importedEvidenceTable(period, { details: true, collapsed: true });
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
    const recordedSourceCoverage = attribution.coverage.orders > 0 ? percent(attribution.coverage.recordedSourceCoveragePercent) : 'Unavailable';
    const growth = re.growthPlan || { opportunities:[] };
    $('#re-customers').textContent = countLabel(customers.summary.customers);
    $('#re-repeat').textContent = percent(customers.summary.repeatRate) + ' retained-cohort repeat rate';
    $('#re-reorder').textContent = countLabel(customers.summary.reorderDue);
    $('#re-churn').textContent = countLabel(customers.summary.churnRisk);
    $('#re-pipeline').textContent = money(sales.summary.openPipeline);
    $('#re-followups').textContent = String(sales.summary.overdueFollowUps || 0) + ' follow-ups due';
    $('#re-attribution').textContent = recordedSourceCoverage;
    $('#re-intent').textContent = String(intent.recoveries?.length || 0);
    $('#re-customer-summary').innerHTML = [
      ['Customer revenue / lifetime value', 'Unavailable'],
      ['Customer contribution', 'Unavailable'],
      ['Recorded dormant customers', countLabel(customers.summary.dormant)],
      ['Cohort basis', 'Retained recorded orders · source period unverified']
    ].map(item=>'<div><span>'+escapeHtml(item[0])+'</span><b>'+escapeHtml(item[1])+'</b></div>').join('');
    $('#re-customers-list').innerHTML = (customers.customers || []).slice(0,8).map(customer =>
      '<div class="ranking-row"><div><b>'+escapeHtml(customer.privacyLabel)+'</b><small>'+escapeHtml(statusLabel(customer.segment))+' · '+escapeHtml((customer.channels || []).map(statusLabel).join(', ') || 'Provider unverified')+' · '+escapeHtml(countLabel(customer.orderCount))+' retained orders · last '+escapeHtml(String(customer.daysSinceLastOrder))+' recorded days ago</small></div><strong>Value unavailable</strong></div>'
    ).join('') || '<div class="empty-state">No retained customer cohort is available. Source coverage and financial value remain unverified.</div>';
    if (customers.coverage?.detailRowsTruncated) $('#re-customers-list').insertAdjacentHTML('beforeend', '<p class="muted tiny">Bounded customer detail: ' + escapeHtml(countLabel(customers.coverage.customersReturned)) + ' of ' + escapeHtml(countLabel(customers.coverage.customersAvailable)) + ' recorded customers returned. Counts describe the full bounded retained cohort; source-period coverage is unverified.</p>');
    $('#re-growth-plan').innerHTML = (growth.opportunities || []).map(item =>
      '<div class="priority-item"><div><b>'+escapeHtml(item.title)+'</b><p>'+escapeHtml(item.evidence)+'</p><small>'+escapeHtml(statusLabel(item.confidence))+' confidence · '+(item.approvalRequired?'approval required':'read-only action')+'</small></div></div>'
    ).join('') || '<div class="empty-state">No evidence-backed growth action is strong enough to recommend yet.</div>';
    $('#re-attribution-list').innerHTML = [
      ['Recorded source coverage', recordedSourceCoverage],
      ['Retained orders assessed', countLabel(attribution.coverage.orders)],
      ['Orders with a recorded source', countLabel(attribution.coverage.recordedSourceOrders)]
    ].map(item=>'<div><span>'+escapeHtml(item[0])+'</span><b>'+escapeHtml(item[1])+'</b></div>').join('') + '<p class="muted tiny">'+escapeHtml(attribution.reason || attribution.coverage.note || 'Source-period coverage and financial attribution remain unverified.')+'</p>';
    if (attribution.coverage.detailRowsTruncated) $('#re-attribution-list').insertAdjacentHTML('beforeend', '<p class="muted tiny">Recorded source detail is truncated. ' + escapeHtml(countLabel(attribution.coverage.orderRowsReturned)) + ' of ' + escapeHtml(countLabel(attribution.coverage.orderRowsAvailable)) + ' order details returned; source-period coverage is unverified.</p>');
    $('#re-baskets').innerHTML = (baskets.pairs || []).slice(0,8).map(pair =>
      '<div class="ranking-row"><div><b>'+escapeHtml(pair.a)+' + '+escapeHtml(pair.b)+'</b><small>'+escapeHtml(statusLabel(pair.provider))+' · '+escapeHtml(countLabel(pair.ordersTogether))+' retained orders together · recorded SKU association only</small></div><strong>'+escapeHtml(percent(pair.affinity))+'<small>retained-cohort affinity</small></strong></div>'
    ).join('') || '<div class="empty-state">No retained recorded SKU pairs are available. Catalogue attribution and source-period coverage remain unverified.</div>';
    $('#re-sales').innerHTML = [
      ['Leads', String(sales.summary.leads || 0)], ['Open quotes', String(sales.summary.openQuotes || 0)],
      ['Open pipeline', money(sales.summary.openPipeline)], ['Quote conversion', percent(sales.summary.conversionPercent)]
    ].map(item=>'<div><span>'+escapeHtml(item[0])+'</span><b>'+escapeHtml(item[1])+'</b></div>').join('');
    $('#re-advertising').innerHTML = [
      ['Spend total', 'Unavailable'], ['Attributed revenue', 'Unavailable'],
      ['ROAS', 'Unavailable'], ['Financial attribution', 'Unverified']
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
      const rawContribution = item.impact?.incrementalContribution;
      const contribution = rawContribution !== null && rawContribution !== undefined && rawContribution !== '' ? String(rawContribution) + ' recorded contribution (currency/period unqualified)' : 'contribution unknown';
      return '<div class="control-row"><div><b>' + escapeHtml(item.title || statusLabel(item.kind || 'Experiment')) + '</b><small>' + escapeHtml(statusLabel(item.kind || 'unknown')) + ' · ' + escapeHtml(item.metric || 'incremental_contribution') + '</small><small>' + escapeHtml('Legacy recorded / unqualified · ' + contribution) + '</small></div><span class="tag ' + (verified ? 'good' : item.status === 'measured' ? 'warn' : 'neutral') + '">' + escapeHtml(verified ? 'Legacy reviewed' : statusLabel(item.status || 'draft')) + '</span></div>';
    }).join('') || '<div class="empty-state">No experiments yet. Start from a recorded opportunity above.</div>';
    const capacityForm = $('#re-growth-capacity-form');
    if (capacityForm) {
      capacityForm.elements.growthCapacityHours.value = state.data.settings?.growthCapacityHours ?? '';
      capacityForm.elements.maxConcurrentGrowthExperiments.value = state.data.settings?.maxConcurrentGrowthExperiments ?? '';
    }
  }

  function renderAnalytics() {
    const dashboard = state.data.dashboard || {}, month = dashboard.last30d || {};
    const salesChannels = (state.data.integrations || []).filter(item => ['commerce', 'marketplace', 'social-commerce'].includes(item.kind) && (item.metrics30d || item.status === 'connected' || item.lastSyncAt));
    const adCosts = state.data.advertisingCosts || [];
    $('#analytics-revenue').textContent = 'Unavailable';
    $('#analytics-orders').textContent = countLabel(month.orders);
    $('#analytics-profit').textContent = 'Unavailable';
    $('#analytics-margin').textContent = 'Unavailable';
    $('#analytics-ad-spend').textContent = 'Unavailable';
    $('#analytics-roas').textContent = 'Unavailable';
    $('#analytics-roas-note').textContent = 'Currency, period and attribution not qualified';
    $('#analytics-summary').textContent = 'Runvara shows retained orders by provider, currency, status and cancellation. Period coverage, revenue, profit and collected cash remain unverified.';
    $('#analytics-channel-table').innerHTML = importedEvidenceTable(month, { details: true });
    $('#analytics-source-mix').innerHTML = salesChannels.length ? salesChannels.map(channel => '<div class="source-row"><div><span>' + escapeHtml(channel.name) + '</span><strong>' + escapeHtml(countLabel(channel.metrics30d?.orders)) + ' retained orders</strong></div></div>').join('') : '<div class="empty-state">No channel evidence is available.</div>';
    $('#analytics-marketing').innerHTML = '<p class="muted tiny">All retained raw entries, with recorded dates shown. Currency, attribution and source-period coverage are unverified; totals and ROAS are unavailable.</p>' + (adCosts.length ? '<div class="table-wrap table-scroll"><table><thead><tr><th scope="col">Recorded date</th><th scope="col">Channel</th><th scope="col">Recorded currency</th><th scope="col">Recorded spend</th><th scope="col">Recorded attribution amount</th></tr></thead><tbody>' + adCosts.map(item => '<tr><td>' + escapeHtml(item.date || item.createdAt || 'Unknown') + '</td><td>' + escapeHtml(statusLabel(item.channel)) + '</td><td>' + escapeHtml(recordedCurrency(item)) + '</td><td>' + escapeHtml(recordedInput(item.spend)) + '</td><td>' + escapeHtml(recordedInput(item.attributableRevenue)) + '</td></tr>').join('') + '</tbody></table></div>' : '<div class="empty-state">No advertising cost entries retained. This does not establish zero spend.</div>');
    $('#analytics-coverage').innerHTML = [
      ['Source-period coverage', 'Unverified', 'A successful sync does not establish complete order coverage.'],
      ['Numeric cost availability', numericCostLabel(month.numericCostCoverage), 'Availability of recorded cost numbers only; historical assignment remains unverified.'],
      ['Financial qualification', 'Unavailable', 'Revenue, contribution, margin and collected cash are not qualified.'],
      ['Marketing attribution', 'Unavailable', 'Recorded attribution amounts do not establish reconciled campaign return.']
    ].map(item => '<div class="coverage-item"><div><span>' + escapeHtml(item[0]) + '</span><strong>' + escapeHtml(item[1]) + '</strong></div><small>' + escapeHtml(item[2]) + '</small></div>').join('');
    $('#analytics-insights').innerHTML = '<article class="analytics-insight"><span class="tag neutral">Evidence</span><div><b>Keep recorded cohorts separate</b><p>Known subtotals describe only scanned records in one provider, currency, status and cancellation cohort. Complete retained cohorts still do not establish business-period totals.</p></div></article><article class="analytics-insight"><span class="tag warn">Needs evidence</span><div><b>Financial comparisons are unavailable</b><p>Source coverage, original currencies, historical cost and tax treatment, settlements and attribution need qualification before financial rankings or return comparisons can be shown.</p></div></article>';
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
    const countLabel = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : 'Unknown';
    const legacyCount = countLabel(impact.legacy?.recordedEvents), legacyReviewed = countLabel(impact.legacy?.reviewedEvents);
    $('#hypergrowth-title').textContent = 'Next actions. Measured evidence.';
    $('#hg-value').previousElementSibling.textContent = 'Unscoped value';
    $('#hg-value').nextElementSibling.textContent = 'Use Business results for exact currency and window';
    $('#hg-hours').nextElementSibling.textContent = 'Qualified time-savings evidence unavailable';
    $('#hg-value').textContent = '—';
    $('#hg-hours').textContent = '—';
    $('#hg-coverage').textContent = 'Unavailable';
    $('#hg-coverage-note').textContent = 'Historical cost, currency and tax basis unverified';
    const recommended = council.commander?.recommended?.length || 0;
    const approvals = council.commander?.prepareForApproval?.length || 0;
    const evidence = council.commander?.needsEvidence?.length || 0;
    $('#hg-council').textContent = String(recommended + approvals + evidence);
    $('#hg-council-note').textContent = recommended + ' ready · ' + approvals + ' approval · ' + evidence + ' evidence';
    $('#hg-opportunity-count').textContent = String(queue.summary?.total || 0) + ' detected';
    $('#hypergrowth-evidence-badge').textContent = legacyCount + ' legacy records · unqualified';
    $('#hypergrowth-evidence-badge').className = 'tag neutral';
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
      ['Unscoped incremental revenue', '—', 'neutral'],
      ['Unscoped contribution', '—', 'neutral'],
      ['Contribution protected', '—', 'neutral'],
      ['Costs avoided', '—', 'neutral'],
      ['ROI unavailable', '—', 'neutral'],
      ['Legacy recorded measurements', legacyCount, 'neutral'],
      ['Legacy reviews (unqualified)', legacyReviewed, 'neutral']
    ].map(item => '<div><span>' + escapeHtml(item[0]) + '</span><b class="' + item[2] + '">' + escapeHtml(item[1]) + '</b></div>').join('');
    const connectionIssues = (business.connections || []).filter(item => !item.healthy).length;
    $('#hg-controls').innerHTML = [
      ['Pending approvals', business.controls?.pendingApprovals || 0, business.controls?.pendingApprovals ? 'warn':'good'],
      ['Connection issues', connectionIssues, connectionIssues ? 'warn':'good'],
      ['Stock risks', business.inventory?.stockRisks || 0, business.inventory?.stockRisks ? 'warn':'good'],
      ['Missing cost variants', business.profitability?.missingCostVariants || 0, business.profitability?.missingCostVariants ? 'warn':'good'],
      ['Profit truth policy', 'Unknown stays unknown', 'good']
    ].map(item => '<div><span>' + escapeHtml(item[0]) + '</span><b class="' + item[2] + '">' + escapeHtml(item[1]) + '</b></div>').join('');

    $('.command-learning h2').textContent = 'Descriptive measurement history';
    $('#hg-learning-badge').textContent = 'Guidance unavailable';
    $('#hg-learning-badge').className = 'tag neutral';
    $('#hg-learning').innerHTML = '<p class="muted">' + escapeHtml(countLabel(learning.legacy?.recordedEvents)) + ' legacy measurements; ' + escapeHtml(countLabel(learning.legacy?.reviewedEvents)) + ' recorded reviews. These do not establish qualified learning priors.</p><p class="muted tiny">Qualified groups are descriptive. Future guidance requires immutable action, domain and comparability evidence.</p><button class="text-button" type="button" data-view-link="revenue-engine">Find Business results in Revenue Engine</button><p class="muted tiny">Open the collapsed Business results panel to load committed measurements on demand.</p>';

    const statusTone = status => status === 'completed' ? 'good' : status === 'measured' ? 'warn' : status === 'running' ? 'neutral' : 'neutral';
    $('#hg-experiments').innerHTML = experiments.slice(0,6).map(item => {
      const impactState = item.impact?.verified ? 'Legacy reviewed / unqualified' : item.status === 'measured' ? 'Recorded / unqualified' : 'No legacy measurement yet';
      const contribution = item.impact?.incrementalContribution;
      return '<div class="experiment-row"><div><b>' + escapeHtml(item.title || statusLabel(item.kind || 'Experiment')) + '</b><small>' + escapeHtml(statusLabel(item.kind || 'unknown') + ' · ' + impactState + (contribution !== null && contribution !== undefined && contribution !== '' && Number.isFinite(Number(contribution)) ? ' · ' + String(contribution) + ' recorded contribution (currency/window unqualified)' : ' · contribution unknown')) + '</small></div><span class="tag ' + statusTone(String(item.status || '').toLowerCase()) + '">' + escapeHtml(statusLabel(item.status || 'draft')) + '</span></div>';
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
    $('#today-revenue').textContent = 'Unavailable';
    $('#today-orders').textContent = countLabel(today.orders);
    $('#today-open').textContent = countLabel(today.openOrders) + ' recorded open';
    $('#today-profit').textContent = 'Unavailable';
    $('#today-profit-coverage').textContent = 'Financial qualification unavailable';
    $('#today-margin').textContent = 'Unavailable';
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
    $('#kpi-margin-coverage').textContent = String(dashboard.marginCoveredVariants ?? 0) + ' of ' + String(dashboard.variants ?? 0) + ' catalogue variants · unweighted';
    $('#kpi-low-margin').textContent = String(dashboard.lowMargin || 0) + ' below floor';
    $('#kpi-loss').textContent = String(dashboard.negativeMargin || 0);
    $('#kpi-stock-value').textContent = money(dashboard.stockValue);
    $('#kpi-stock-value-coverage').textContent = 'coverage ' + String(dashboard.stockValueCoverage || 0) + '%';

    $('#priority-list').innerHTML = (dashboard.recommendations || []).map((item, index) => '<li><span class="priority-number">' + (index + 1) + '</span><button class="priority-link" data-view-link="' + escapeHtml(item.view || 'overview') + '" data-target-filter="' + escapeHtml(item.filter || '') + '"><b>' + escapeHtml(item.title) + '</b><small>' + escapeHtml(item.detail) + '</small></button><span class="tag ' + (item.actionType === 'safe' ? 'good">Safe' : 'warn">Approval') + '</span></li>').join('') || '<li class="empty-state">No recommended actions.</li>';
    $('#control-status').innerHTML = [
      ['Pending approvals', dashboard.pendingApprovals || 0, dashboard.pendingApprovals ? 'warn' : 'good'],
      ['Active automations', String(dashboard.activeAutomations || 0) + '/' + String(dashboard.automationCount || 0), dashboard.activeAutomations ? 'good' : 'warn'],
      ['SEO issues', dashboard.seoIssues || 0, dashboard.seoIssues ? 'warn' : 'good'],
      ['Recorded customer-service issues', countLabel(dashboard.customerServiceIssues), dashboard.customerServiceIssues == null ? 'neutral' : dashboard.customerServiceIssues ? 'warn' : 'good'],
      ['Integration issues', dashboard.integrationIssues || 0, dashboard.integrationIssues ? 'warn' : 'good'],
      ['Ad spend total', 'Unavailable · currency and period unverified', 'neutral']
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
      return '<tr class="economics-row" data-sku="' + escapeHtml(item.sku) + '"><td><div class="product-cell">' + image + '<div><b>' + escapeHtml(item.productTitle) + '</b><small>' + escapeHtml(item.title) + ' · ' + escapeHtml(item.sku || 'No SKU') + '</small><small>Order attribution unverified · sales and stock cover unavailable</small></div></div></td><td class="numeric">' + money(item.price) + '</td><td class="numeric ' + (item.inventory !== null && item.inventory <= lowStockThreshold ? 'warn' : '') + '">' + (item.inventory == null ? '—' : escapeHtml(item.inventory)) + '</td><td><select class="econ-input compact-select" data-field="supplierId" aria-label="Supplier for ' + escapeHtml(item.sku) + '">' + supplierOptions + '</select></td><td>' + moneyInput('landed', 'Landed cost for ' + item.sku, economics) + '</td><td>' + moneyInput('packing', 'Packing cost for ' + item.sku, economics) + '</td><td>' + moneyInput('handling', 'Handling cost for ' + item.sku, economics) + '</td><td>' + moneyInput('delivery', 'Actual postage cost for ' + item.sku, economics) + '</td><td>' + moneyInput('paymentFee', 'Payment fee for ' + item.sku, economics) + '</td><td>' + moneyInput('channelFee', 'Channel fee for ' + item.sku, economics) + '</td><td>' + moneyInput('advertising', 'Advertising allocation for ' + item.sku, economics) + '</td><td>' + moneyInput('otherVariable', 'Other variable cost for ' + item.sku, economics) + '</td><td class="numeric">' + money(item.totalVariableCost) + '</td><td class="numeric ' + statusClass(item.status) + '">' + money(item.contribution) + '</td><td class="numeric ' + statusClass(item.status) + '">' + percent(item.margin) + '</td><td><span class="tag ' + statusClass(item.status) + '" title="' + escapeHtml(missingTitle) + '">' + escapeHtml(statusLabel(item.status)) + '</span><div class="table-actions"><button class="text-button cost-details" type="button">Supplier detail</button><button class="primary small-button save-economics" type="button">Save</button></div></td></tr>' +
        '<tr class="cost-detail-row hidden" data-sku="' + escapeHtml(item.sku) + '"><td colspan="16"><div class="cost-detail-grid"><label>Supplier SKU<input class="econ-input" data-field="supplierSku" value="' + escapeHtml(inputValue(economics.supplierSku)) + '"></label><label>Box quantity<input class="econ-input" data-field="boxQuantity" type="number" min="0" step="1" value="' + escapeHtml(inputValue(economics.boxQuantity)) + '"></label><label>Box price (£)<input class="econ-input" data-field="boxPrice" type="number" min="0" step="0.01" value="' + escapeHtml(inputValue(economics.boxPrice)) + '"></label><label>Supplier unit cost (£)<input class="econ-input" data-field="supplierUnitCost" type="number" min="0" step="0.0001" value="' + escapeHtml(inputValue(economics.supplierUnitCost)) + '"></label><label>Delivery allocation / unit (£)<input class="econ-input" data-field="supplierDelivery" type="number" min="0" step="0.0001" value="' + escapeHtml(inputValue(economics.supplierDelivery)) + '"></label><label>Supplier VAT rate (%)<input class="econ-input" data-field="supplierVatRate" type="number" min="0" max="100" step="0.1" value="' + escapeHtml(inputValue(economics.supplierVatRate)) + '"></label><label>VAT recoverable<select class="econ-input" data-field="supplierVatRecoverable"><option value=""' + (economics.supplierVatRecoverable == null ? ' selected' : '') + '>Unknown</option><option value="true"' + (economics.supplierVatRecoverable === true ? ' selected' : '') + '>Yes</option><option value="false"' + (economics.supplierVatRecoverable === false ? ' selected' : '') + '>No</option></select></label><label>Margin floor (%)<input class="econ-input" data-field="marginFloor" type="number" min="0" max="100" step="0.1" value="' + escapeHtml(inputValue(economics.marginFloor)) + '"></label><label class="detail-notes">Notes<textarea class="econ-input" data-field="notes">' + escapeHtml(inputValue(economics.notes)) + '</textarea></label></div><p class="muted tiny">If landed cost is blank, it is derived only when unit/box cost, supplier delivery, VAT rate and VAT recovery treatment are all known.</p></td></tr>';
    }).join('') || '<tr><td colspan="16" class="empty-state">No products match this filter.</td></tr>';
  }

  function recordedOrderStatus(order) {
    if (order.recordedStatus) return { ...order.recordedStatus,
      hasRecordedRefund: ['PARTIALLY_REFUNDED', 'REFUNDED'].includes(order.recordedStatus.financialStatus) };
    const group = importedEvidence(order.profitability)?.groups?.[0];
    const status = typeof order.fulfillmentStatus === 'string' ? order.fulfillmentStatus.toUpperCase() : 'UNKNOWN';
    const fulfillmentStatus = ['FULFILLED','UNFULFILLED','PARTIAL','PARTIALLY_FULFILLED','RESTOCKED','IN_PROGRESS','ON_HOLD','OPEN','SCHEDULED'].includes(status) ? status : 'UNKNOWN';
    return { fulfillmentStatus, financialStatus: group?.financialStatus || 'UNKNOWN', cancelled: group?.cancelled === true,
      hasRecordedRefund: ['PARTIALLY_REFUNDED', 'REFUNDED'].includes(group?.financialStatus) };
  }

  function orderMatches(order) {
    if (state.orderFilter === 'all') return true;
    const recorded = recordedOrderStatus(order);
    if (state.orderFilter === 'open') return !recorded.cancelled && recorded.fulfillmentStatus !== 'UNKNOWN' && !['FULFILLED', 'RESTOCKED'].includes(recorded.fulfillmentStatus);
    if (state.orderFilter === 'refunded') return recorded.hasRecordedRefund === true;
    if (state.orderFilter === 'missing-profit') return true;
    if (state.orderFilter === 'profitable' || state.orderFilter === 'loss-making') return false;
    if (state.orderFilter === 'today') {
      const recorded = new Date(order.createdAt);
      return Number.isFinite(recorded.getTime()) && recorded.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
    }
    return true;
  }

  function costField(label, field, order) {
    return '<label>' + escapeHtml(label) + '<input class="order-cost-input" data-field="' + field + '" type="number" min="0" step="0.01" value="' + escapeHtml(inputValue(order[field])) + '" placeholder="Unknown"></label>';
  }

  function renderOrders() {
    const dashboard = state.data.dashboard || {}, month = dashboard.last30d || {};
    $('#orders-revenue').textContent = 'Unavailable';
    $('#orders-total').textContent = countLabel(month.orders);
    $('#orders-open').textContent = countLabel(month.openOrders) + ' recorded open';
    $('#orders-refunds-value').textContent = 'See recorded cohorts';
    $('#orders-refunded').textContent = 'Source-period refunds unverified';
    $('#orders-profit').textContent = 'Unavailable';
    $('#orders-profit-coverage').textContent = 'Unavailable';
    const orders = (dashboard.orderProfitability || []).filter(orderMatches);
    const detailCoverage = dashboard.orderDetailCoverage;
    const detailNote = detailCoverage?.truncated ? '<p class="missing-inputs">Partial order-detail view. Additional retained orders are not shown. Period cohorts are available in Analytics.</p>' : '';
    $('#order-list').innerHTML = detailNote + (orders.length ? orders.slice(0, 250).map(order => {
      const p = order.profitability || {}, evidence = importedEvidence(p), group = evidence?.groups?.length === 1 ? evidence.groups[0] : null;
      const recordedNet = group ? recordedDecimal(group.recordedAmounts?.netTotal?.knownSubtotal) : 'Unknown';
      const lines = (order.lineItems || []).length ? order.lineItems.map(line => '<div><span>' + escapeHtml(line.name || line.title || 'Recorded line') + '<small>' + escapeHtml(line.sku || 'No recorded SKU') + ' · recorded quantity ' + escapeHtml(recordedInput(line.quantity)) + '</small></span><strong>' + escapeHtml(recordedInput(line.net)) + '<small>Recorded line amount · currency / refund allocation unverified</small></strong></div>').join('') : '<div class="empty-state">Raw line items have not been retained.</div>';
      return '<details class="order-profit-card" data-order-id="' + escapeHtml(order.id) + '"><summary><div><b>' + escapeHtml(order.name || order.id) + '</b><small>' + date(order.createdAt) + ' · ' + escapeHtml(statusLabel(order.provider)) + '</small></div><div class="order-state"><span class="tag neutral">Recorded ' + escapeHtml(statusLabel(order.financialStatus)) + '</span><span class="tag neutral">' + (recordedOrderStatus(order).cancelled ? 'Cancelled' : 'Not recorded cancelled') + '</span><span class="tag neutral">' + escapeHtml(statusLabel(order.fulfillmentStatus)) + '</span></div><div class="order-total"><strong>' + escapeHtml(recordedNet) + '</strong><small>Normalized recorded net · ' + escapeHtml(recordedCurrency(group || order)) + '</small><span>Profit unavailable</span></div></summary><div class="order-detail">' + importedEvidenceTable(p, { details: true }) + '<div class="order-detail-grid"><div><h3>Recorded order lines</h3><p class="muted tiny">Recorded SKUs and quantities do not establish catalogue attribution or stock movement.</p><div class="line-item-list">' + lines + '</div></div><div><h3>Recorded cost inputs</h3><p class="muted tiny">Cost currency, tax treatment and historical assignment are unverified. Saving numeric inputs does not qualify profit.</p><div class="order-cost-grid">' + costField('Shipping cost', 'actualShippingCost', order) + costField('Payment fees', 'paymentFees', order) + costField('Channel fees', 'channelFees', order) + costField('Advertising cost', 'advertisingCost', order) + costField('Other variable costs', 'otherVariableCosts', order) + '</div><button class="primary small-button save-order-costs" type="button">Save order costs</button></div></div></div></details>';
    }).join('') : '<div class="empty-state">No retained orders match this filter. An empty selection does not establish zero sales.</div>');
  }

  function approvalCard(item) {
    const pending = item.status === 'pending';
    const write = (state.data.connectionWrites || []).find(write => write.approvalId === item.id);
    const affected = write ? (state.data.connectionCentre || []).find(channel => channel.id === write.provider)?.name || statusLabel(write.provider) : 'See proposal and supporting evidence';
    const source = window.RunvaraConnections.objectiveContentDisplay(write);
    const sourceIdentity = source?.status === 'available' ? 'Owner-written content associated with a saved goal. Commercial readiness and objective progress remain unverified.\nGoal: ' + source.objectiveId + ' · revision ' + source.objectiveRevision + '\nReport: ' + source.reportId + '\nReview job: ' + source.jobId + '\nOpportunity: ' + source.opportunityId :
      source ? (source.origin === 'owner_objective_content' ? 'Goal-associated source unavailable.' : 'Unsupported request origin. Saved source unavailable.') + ' This request must not be treated as a manual content request.' : '';
    const sourceDetail = source ? '<details><summary>' + (source.origin === 'owner_objective_content' ? 'Review full goal-associated content' : 'Review content with unsupported origin') + '</summary><p class="connection-exact-text">' + escapeHtml(sourceIdentity + '\nDestination: ' + (write.account || 'Unavailable saved target') + '\nConnection: ' + (write.connectionId || 'Unavailable saved reference') + (write.provider === 'shopify' && write.input?.operation === 'product_content' ? '\nProduct: ' + write.input.productId + '\nExact title: ' + write.input.title + '\nExact description:\n' + (write.input.description === '' ? 'Empty description: this clears the Shopify description.' : write.input.description) : '')) + '</p><p class="muted tiny">The retained product’s import account is unverified. Server-recorded history is not independently immutable proof. Saved financial and stock restrictions still apply; approval does not supply missing evidence. Applying the approved change is separate.</p></details>' : '';

    const executionNote = item.executionStatus === 'ready' ? 'Ready to apply in the Connection Centre.' : item.executionStatus === 'completed' ? 'The channel confirmed the change.' : item.executionStatus === 'cancelled' ? 'No channel change made.' : 'External execution: disabled';
    const actions = pending && state.data.user?.role === 'owner' ? '<div class="approval-actions">' + (item.payload?.connectionWriteId ? '<button class="secondary" data-view-link="channels">Review exact change</button>' : '<button class="secondary" data-modify-approval="' + escapeHtml(item.id) + '">Modify</button>') + '<button class="secondary danger" data-approval="' + escapeHtml(item.id) + '" data-decision="rejected">Reject</button><button class="primary" data-approval="' + escapeHtml(item.id) + '" data-decision="approved">Approve</button></div>' : '<p class="decision-note">' + (pending ? 'Awaiting owner decision' : 'Decision recorded ' + date(item.decidedAt)) + ' · ' + escapeHtml(executionNote) + '</p>' + (item.executionStatus === 'ready' ? '<button class="secondary" data-view-link="channels">Open Connection Centre</button>' : '');
    return '<article class="approval-card"><div class="approval-title"><div><span class="tag ' + (pending ? 'warn' : item.status === 'approved' ? 'good' : 'bad') + '">' + escapeHtml(statusLabel(item.status)) + '</span><h3>' + escapeHtml(item.action || statusLabel(item.type)) + '</h3></div><strong>' + (item.financialImpact == null ? 'Impact not quantified' : money(item.financialImpact)) + '</strong></div><dl><div><dt>Affected channel / scope</dt><dd>' + escapeHtml(affected) + '</dd></div><div><dt>Reason</dt><dd>' + escapeHtml(item.reason || '—') + '</dd></div><div><dt>Expected benefit</dt><dd>' + escapeHtml(item.expectedBenefit || '—') + '</dd></div><div><dt>Risk</dt><dd>' + escapeHtml(item.risk || '—') + '</dd></div><div><dt>Requested by</dt><dd>' + escapeHtml(item.requestedBy || 'system') + ' · ' + escapeHtml(item.source || 'Runvara') + ' · ' + date(item.createdAt) + '</dd></div><div><dt>Requesting agent</dt><dd>' + escapeHtml(item.agentId || item.requestedBy) + '</dd></div></dl>' + window.RunvaraControl.evidence(item.evidence) + window.RunvaraControl.history(item.history) + sourceDetail + actions + '</article>';
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
    const recordedOrderCount = (state.data.connectionCentre || []).find(channel => channel.id === 'ebay')?.counts?.orders;
    $('#ebay-health').innerHTML = [
      ['Connected account', ebay.account || '—'], ['Catalogue coverage', inventoryOnly ? 'Inventory API only; full comparison needs the existing Manager feed' : 'Existing Manager catalogue'], [inventoryOnly ? 'Inventory API listings' : 'Listings', !listingsAvailable ? 'Source unavailable' : ebay.listings && ebay.listings.length || 0], ['Drafts', !listingsAvailable ? 'Source unavailable' : ebay.drafts && ebay.drafts.length || 0],
      ['Recorded orders', countLabel(recordedOrderCount)], ['Fee records', ebay.fees && ebay.fees.length || 0], ['Promotions', ebay.promotions && ebay.promotions.length || 0],
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
    $('#agent-activity').innerHTML = activity.length ? activity.map(item => '<div class="activity-row"><span class="activity-dot ' + statusClass(String(item.status).toLowerCase()) + '"></span><div><b>' + escapeHtml(statusLabel(item.agentId)) + '</b><p>' + (item.historical ? 'Historical analysis (earlier calculation rules): ' : '') + escapeHtml(item.message) + '</p><small>' + escapeHtml(date(item.createdAt)) + (item.confidence === undefined ? '' : ' · confidence ' + Math.round(item.confidence * 100) + '%') + '</small></div></div>').join('') : '<div class="empty-state">No agent runs yet. Send the Commander a quick command.</div>';
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

  function legacyAiUsageDisplay(status, estimatedCostUsd, requests, reason) {
    // A complete recorded ledger can contain a genuine zero. Missing or invalid
    // evidence must never be coerced into a zero cost or request count.
    const complete = status === 'complete' && Number.isFinite(estimatedCostUsd) && estimatedCostUsd >= 0 && estimatedCostUsd < 2 ** 26 && !Object.is(estimatedCostUsd, -0) && Number.isSafeInteger(requests) && requests >= 0 && !Object.is(requests, -0);
    const label = complete ? 'Complete' : status === 'partial' ? 'Incomplete' : 'Unavailable';
    const reasons = {
      AI_USAGE_INPUT_INVALID: 'The recorded usage query could not be validated.',
      AI_USAGE_READ_UNAVAILABLE: 'Recorded usage could not be read.',
      AI_USAGE_RESPONSE_INVALID: 'Recorded usage could not be validated.',
      AI_USAGE_COUNT_UNVERIFIED: 'The recorded usage count could not be verified.',
      AI_USAGE_TRUNCATED: 'Only part of the recorded usage was returned.',
      AI_USAGE_ROW_LIMIT: 'Recorded usage exceeded the safe read limit.',
      AI_USAGE_VOLATILE_STORE: 'This store keeps usage in process memory, which resets on restart.'
    };
    return {
      complete,
      label,
      cost: complete ? usd(estimatedCostUsd) : label,
      requests: complete ? String(requests) : label,
      requestDescription: complete ? requests + ' recorded legacy requests' : 'Legacy requests ' + label.toLowerCase(),
      note: complete ? '' : typeof reason === 'string' && Object.hasOwn(reasons, reason) ? reasons[reason] : 'A complete recorded legacy usage total is not available.'
    };
  }

  function renderFleet() {
    if (!state.fleet || !state.data?.launchAdmin) return;
    const fleet = state.fleet, totals = fleet.totals || {}, worker = fleet.worker || {};
    const aiMonth = legacyAiUsageDisplay((fleet.workspaces || []).length ? totals.aiUsageMonthStatus : 'unavailable', totals.aiEstimatedCostUsdMonth, totals.aiRequestsMonth);
    const coverageCounts = [totals.aiUsageMonthCompleteWorkspaces, totals.aiUsageMonthPartialWorkspaces, totals.aiUsageMonthUnavailableWorkspaces];
    const usageCoverage = coverageCounts.every(count => Number.isSafeInteger(count) && count >= 0)
      ? coverageCounts[0] + ' complete · ' + coverageCounts[1] + ' incomplete · ' + coverageCounts[2] + ' unavailable' : 'Unavailable';
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
      ['Workspaces in snapshot', totals.workspaces || 0, 'returned tenants'],
      ['Running', totals.running || 0, 'jobs now'],
      ['Queued', totals.queued || 0, 'waiting safely'],
      ['Blocked', totals.blocked || 0, 'needs attention'],
      ['Legacy AI estimate · month', aiMonth.cost, aiMonth.requestDescription, !aiMonth.complete, true],
      ['Plan value · month', money(totals.planMonthlyValueGbp || 0), 'GBP list/billing value', false, true]
    ].map(item => '<article class="card kpi' + (item[4] ? ' kpi-monthly' : '') + '"><span>' + escapeHtml(item[0]) + '</span><strong' + (item[3] ? ' class="kpi-text-status"' : '') + '>' + escapeHtml(item[1]) + '</strong><small>' + escapeHtml(item[2]) + '</small></article>').join('');

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
    $('#fleet-ai-capacity').innerHTML = '<div class="fleet-meter"><span style="width:' + pct.toFixed(1) + '%"></span></div><div class="section-head"><b>' + escapeHtml(used) + ' AI units reserved today</b><span class="tag ' + (pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : 'good') + '">' + escapeHtml(limit ? Math.round(pct) + '%' : 'No AI capacity') + '</span></div><p class="muted tiny">' + escapeHtml('Units reserve workload capacity; they do not prove provider requests, metering coverage or spend.') + '</p>';

    $('#fleet-ai-provider-status').textContent = fleet.aiProviderConfigured ? 'Provider configured' : 'Provider not configured';
    $('#fleet-ai-provider-status').className = 'tag ' + (fleet.aiProviderConfigured ? 'good' : 'neutral');
    $('#fleet-economics-summary').innerHTML = [
      ['Recorded legacy requests · month', aiMonth.requests],
      ['Recorded legacy cost estimate · USD', aiMonth.cost],
      ['Recorded ledger status', aiMonth.label],
      ['Snapshot usage coverage', usageCoverage],
      ['Monthly plan value', money(totals.planMonthlyValueGbp || 0) + ' GBP'],
      ['Cost accounting', 'Recorded legacy usage estimates only'],
      ['Currency treatment', 'USD cost and GBP value kept separate']
    ].map(item => '<div><span>' + escapeHtml(item[0]) + '</span><b>' + escapeHtml(item[1]) + '</b></div>').join('');

    const models = fleet.modelCatalog || [];
    $('#fleet-model-catalog').innerHTML = models.length ? models.map(model => {
      const deterministic = model.model === 'deterministic';
      const pricing = deterministic ? 'No provider charge' : '$' + Number(model.inputPerMillionUsd || 0).toFixed(2) + ' in · $' + Number(model.cachedInputPerMillionUsd || 0).toFixed(2) + ' cached · $' + Number(model.outputPerMillionUsd || 0).toFixed(2) + ' out / 1M';
      return '<div class="model-row"><div><span class="tag ' + (deterministic ? 'neutral' : model.tier === 'quality' ? 'warn' : 'good') + '">' + escapeHtml(statusLabel(model.tier)) + '</span><b>' + escapeHtml(model.model) + '</b><small>' + escapeHtml(model.provider) + ' · ' + escapeHtml('Catalogue dated ' + (model.pricingUpdatedAt || '—')) + '</small></div><span>' + escapeHtml(pricing) + '</span></div>';
    }).join('') : '<div class="empty-state">No model routing catalogue is available.</div>';

    const query = String(state.fleetQuery || '').trim().toLowerCase();
    const workspaces = (fleet.workspaces || []).filter(item => !query || [item.name,item.workspaceId,item.plan,item.subscriptionStatus,item.aiRoutingMode].join(' ').toLowerCase().includes(query));
    $('#fleet-workspaces').innerHTML = workspaces.length ? workspaces.map(workspace => {
      const counts = workspace.counts || {}, risk = fleetRisk(workspace), tone = fleetTone(workspace);
      const aiPct = workspace.dailyAiUnitLimit ? Math.min(100, Number(workspace.aiUnitsToday || 0) / Number(workspace.dailyAiUnitLimit) * 100) : 0;
      const aiMonth = legacyAiUsageDisplay(workspace.aiUsageMonth?.status, workspace.aiUsageMonth?.totals?.estimatedCostUsd, workspace.aiUsageMonth?.totals?.requests, workspace.aiUsageMonth?.reason);
      const jobs = (workspace.jobs || []).filter(job => ['running','queued','blocked','dead_letter'].includes(job.status));
      const jobHtml = jobs.length ? jobs.map(job => '<div class="fleet-job"><div><b>' + escapeHtml(statusLabel(job.type)) + '</b><small>' + escapeHtml(job.provider ? statusLabel(job.provider) + ' · ' : '') + escapeHtml(statusLabel(job.status)) + ' · attempt ' + escapeHtml(job.attempts || 0) + '/' + escapeHtml(job.maxAttempts || '—') + '</small>' + (job.aiModel ? '<small>AI route: ' + escapeHtml(job.aiModel) + ' · ' + escapeHtml(statusLabel(job.aiTier || '')) + '</small>' : '') + (job.errorCode ? '<small class="bad-text">' + escapeHtml(job.errorCode) + '</small>' : '') + '</div>' + (['blocked','dead_letter'].includes(job.status) ? '<button class="secondary" data-fleet-retry="' + escapeHtml(job.id) + '" data-workspace="' + escapeHtml(workspace.workspaceId) + '">Retry safely</button>' : '') + '</div>').join('') : '<div class="empty-state compact">No active or failed jobs.</div>';
      const sourceLabel = workspace.planValueSource === 'billing' ? 'billing value' : workspace.planValueSource === 'indicative_list_price' ? 'list price' : workspace.planValueSource === 'internal' ? 'internal' : 'unknown';
      return '<article class="fleet-workspace" data-fleet-workspace="' + escapeHtml(workspace.workspaceId) + '"><div class="fleet-workspace-head"><div><span class="tag ' + tone + '">' + escapeHtml(risk ? 'Attention ' + risk : 'Healthy') + '</span><h3>' + escapeHtml(workspace.name) + '</h3><small>' + escapeHtml(workspace.workspaceId) + ' · ' + escapeHtml(statusLabel(workspace.plan)) + ' · ' + escapeHtml(statusLabel(workspace.subscriptionStatus)) + '</small></div><div class="fleet-workspace-actions"><button class="secondary" data-fleet-pause="' + escapeHtml(workspace.workspaceId) + '" data-paused="' + (workspace.paused ? 'true' : 'false') + '">' + (workspace.paused ? 'Resume Agent Ops' : 'Pause Agent Ops') + '</button></div></div>' +
        '<div class="fleet-signal-grid"><div><span>Running</span><b>' + escapeHtml(counts.running || 0) + '</b></div><div><span>Queued</span><b>' + escapeHtml(counts.queued || 0) + '</b></div><div><span>Blocked</span><b>' + escapeHtml(counts.blocked || 0) + '</b></div><div class="fleet-signal-monthly"><span>' + escapeHtml('Legacy AI estimate · month') + '</span><b' + (aiMonth.complete ? '' : ' class="kpi-text-status"') + '>' + escapeHtml(aiMonth.cost) + '</b></div><div class="fleet-signal-monthly"><span>Plan value · month</span><b>' + escapeHtml(money(workspace.planMonthlyValueGbp || 0)) + '</b></div><div><span>Connection issues</span><b>' + escapeHtml(workspace.unhealthyConnections || 0) + '</b></div></div>' +
        '<div class="fleet-meter small"><span style="width:' + aiPct.toFixed(1) + '%"></span></div><div class="fleet-ai-line"><span>AI units ' + escapeHtml(workspace.aiUnitsToday || 0) + ' / ' + escapeHtml(workspace.dailyAiUnitLimit || 0) + '</span><span>' + escapeHtml(aiMonth.requestDescription) + ' · ' + escapeHtml(sourceLabel) + '</span><span>' + escapeHtml(workspace.pendingApprovals || 0) + ' pending approvals</span></div>' +
        (aiMonth.note ? '<p class="muted tiny" data-legacy-ai-usage-note>' + escapeHtml(aiMonth.note) + '</p>' : '') +
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
    try { await request('/api/orders/' + encodeURIComponent(card.dataset.orderId) + '/economics', { method: 'PUT', body: JSON.stringify(costs) }); await loadBootstrap({ migrate: false }); showMessage('Recorded order costs saved. Financial qualification remains unavailable.'); }
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
    try {const payload=await request('/api/auth/signup',{method:'POST',body:JSON.stringify({businessName:form.businessName.value,email:form.email.value,password:form.password.value,invitation:form.invitation.value})});resetBusinessGraph();state.session=payload;state.csrf=payload.csrf;form.reset();invitationToken='';await loadBootstrap();setView('channels');}
    catch(error){$('#signup-error').textContent=error.message;}
    finally{setBusy(button,false);}
  });

  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); const error = $('#login-error'); error.textContent = ''; setBusy(button, true, 'Signing in…');
    try { const payload = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: form.email.value, password: form.password.value }) }); resetBusinessGraph(); state.session = payload; state.csrf = payload.csrf; form.password.value = ''; if (payload.user && payload.user.passwordChangeRequired) showPasswordSetup(); else await loadBootstrap(); }
    catch (loginError) { error.textContent = loginError.message; }
    finally { setBusy(button, false); }
  });

  $('#password-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); const error = $('#password-error'); error.textContent = '';
    if (form.newPassword.value !== form.confirmPassword.value) { error.textContent = 'The two passwords do not match.'; return; }
    setBusy(button, true, 'Securing account…');
    try { const activation = Boolean(ownerActivationToken); const payload = await request(activation ? '/api/auth/activate-owner' : '/api/auth/change-password', { method: 'POST', body: JSON.stringify(activation ? { token: ownerActivationToken, newPassword: form.newPassword.value } : { newPassword: form.newPassword.value }) }); resetBusinessGraph(); state.session = payload; state.csrf = payload.csrf; ownerActivationToken = ''; form.reset(); await loadBootstrap(); showMessage('Owner password secured and temporary sessions revoked.'); }
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
    interruptObjectiveContent('The selected review changed');
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
        return '<article class="objective-review-proposal"><h5>' + escapeHtml(proposal.title || 'Recorded opportunity') + '</h5><p>' + (proposal.approvalRequired ? 'Blocked · owner approval required' : 'Blocked · missing verified evidence') + '</p>' + list(proposal.blockers) + '<p>' + escapeHtml(proposal.nextStep || 'Inspect the original record and resolve missing evidence.') + '</p>' + (sourceExists ? '<button class="secondary" type="button" data-investigate-review-opportunity="' + escapeHtml(proposal.opportunityId) + '">Investigate original opportunity</button>' : '<p class="muted tiny">Original opportunity is not available in the current workspace snapshot.</p>') + (contentCandidate(active,proposal.opportunityId) ? '<p class="muted tiny">You can request your own exact title/description change for this goal. This does not qualify this commercial proposal.</p><button class="secondary" type="button" data-request-objective-content="' + escapeHtml(proposal.opportunityId) + '">Write a goal-associated content request</button>' : '') + '</article>';
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
    const content = event.target.closest('[data-request-objective-content]');
    if (content) { openObjectiveContent(content.dataset.requestObjectiveContent); return; }
    const button = event.target.closest('[data-investigate-review-opportunity]');
    if (button) investigateOpportunity(button.dataset.investigateReviewOpportunity);
  });

  // A separate, owner-authored source-bound request. Diagnostic readiness never
  // authorizes this form, and its exact history is not manual v1 history.
  const objectiveContentIdentityError = error => error.status === 401 || (error.status === 403 &&
    ['WRITE_ACTOR_CHANGED','OWNER_APPROVAL_REQUIRED','ROLE_DENIED','PASSWORD_CHANGE_REQUIRED','CSRF_INVALID'].includes(error.code));
  const objectiveContentSchema = 'runvara-objective-content-source/v1';
  const objectiveContentKeys = ['schema','objectiveId','objectiveRevision','objectiveDigest','jobId','reportId','payloadDigest','resultDigest','jobIdentityDigest','actorId','actorSessionVersion','inputFingerprint','opportunityId','opportunityDigest','productId','productDigest','approvalSourceDigest'];
  const contentRecordKeys = ['id','requestId','provider','input','digest','connectionId','account','requestedBy','status','approvalId','source','origin'];
  const exactContentKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
  const canonicalContent = value => JSON.stringify(value, function(_key, item) { return item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item; });
  const contentReference = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
  function sameObjectiveContentOwner(context) {
    const current = objectiveContext();
    return sameObjectiveSession(current, true) && context?.session === current.session && context.userId === current.userId &&
      context.workspaceId === current.workspaceId && context.sessionWorkspaceId === current.sessionWorkspaceId && context.csrf === current.csrf && context.sessionCsrf === current.sessionCsrf;
  }
  function contentCandidate(active, opportunityId) {
    const objective = state.objectiveSnapshot?.objectives?.find(row => row.id === active?.objectiveId);
    const candidates = active?.report?.proposals?.filter(row => row.opportunityId === opportunityId) || [];
    const rows = state.data?.opportunities?.filter(row => row.id === opportunityId) || [];
    const row = rows[0], evidence = Array.isArray(row?.evidence) ? row.evidence.filter(item => item?.type === 'product') : [];
    return sameObjectiveSession(objectiveContext(), true) && active && sameReviewSession(active) && !active.stale && active.job?.status === 'succeeded' &&
      active.report?.jobId === active.job.id && objective?.effectiveStatus === 'active' && objective.revision === active.objectiveRevision && objective.executionPolicy?.mode === 'enforce' &&
      candidates.length === 1 && candidates[0].sourceReferenceResolved === true && candidates[0].readyForPreparation === false && candidates[0].commercialReady === false && candidates[0].externalExecutionAllowed === false &&
      rows.length === 1 && row.present === true && !['dismissed','rejected'].includes(row.status) && row.kind === 'seo' && evidence.length === 1 &&
      ['Thin product title','Thin product description'].includes(evidence[0].detail);
  }
  function objectiveContentLocalKey(editor) {
    return canonicalContent([state.objectiveSnapshot?.objectives?.filter(row => row.id === editor.selection.objectiveId), state.data?.connections,
      state.data?.products?.filter(row => row.id === editor.loaded?.product.id), state.data?.opportunities?.filter(row => row.id === editor.selection.opportunityId),
      editor.review?.report, editor.review?.stale]);
  }
  function interruptObjectiveContent(reason = 'Editing interrupted', clear = false, hide = true) {
    objectiveContent.epoch++;
    objectiveContent.handoff?.controller.abort(); objectiveContent.handoff = null;
    const ticket = objectiveContent.ticket; objectiveContent.ticket = null; ticket?.controller.abort();
    const editor = objectiveContent.editor;
    if (!editor) return;
    if (clear || !sameObjectiveContentOwner(editor.context)) {
      objectiveContent.editor = null; objectiveContent.previous = null;
      $('#objective-content-form').reset();
      for (const id of ['purpose','policy','baseline','status','exact','error']) $('#objective-content-' + id).textContent = '';
      for (const id of ['account','product']) $('#objective-content-' + id).replaceChildren();
      $('#resume-objective-content').classList.add('hidden'); $('#objective-content-editor').classList.add('hidden'); return;
    }
    if (editor.attempt && !['saved','refused'].includes(editor.attempt.phase)) {
      if (editor.attempt.sent) { editor.attempt.phase = 'unknown'; editor.attempt.hadUnknown = true; editor.attempt.retryReady = false; } else editor.attempt = null;
    }
    editor.stale = true; editor.ackKey = null; editor.message = reason + '. Reload and review the source before preparing an unsent draft.';
    if (hide) { $('#objective-content-editor').classList.add('hidden'); $('#resume-objective-content').classList.remove('hidden'); }
    renderObjectiveContent();
  }
  function currentObjectiveContent(ticket) {
    clearClosedObjectivePanel(objectivePanelObserver.takeRecords());
    if (objectiveContent.ticket === ticket && !sameObjectiveContentOwner(ticket.context)) { interruptObjectiveContent('Owner session changed',true); return false; }
    if (objectiveContent.ticket === ticket && ticket.kind !== 'history' && ticket.sourceKey !== objectiveContentLocalKey(ticket.editor)) {
      interruptObjectiveContent('The selected source changed while the request was pending',false,false); return false;
    }
    return objectiveContent.ticket === ticket && ticket.epoch === objectiveContent.epoch && objectiveContent.editor === ticket.editor &&
      sameObjectiveSession(ticket.context, true) && reviewVisible() && !$('#objective-content-editor').classList.contains('hidden');
  }
  function objectiveContentTicket(kind, editor) {
    const ticket = { kind, editor, sourceKey:objectiveContentLocalKey(editor), context:objectiveContext(), epoch:objectiveContent.epoch, controller:new AbortController() };
    objectiveContent.ticket = ticket; return ticket;
  }
  function checkObjectiveContentIdentity() {
    const editor = objectiveContent.editor;
    if (editor && !sameObjectiveContentOwner(editor.context)) { interruptObjectiveContent('Owner session changed', true); return false; }
    return sameObjectiveSession(objectiveContext(), true) && reviewVisible();
  }
  function observeObjectiveContent() {
    const editor = objectiveContent.editor;
    if (!editor || !checkObjectiveContentIdentity()) return;
    if (editor.loaded && !editor.stale && (!sameObjectiveSession(editor.context, true) || editor.localKey !== objectiveContentLocalKey(editor))) {
      interruptObjectiveContent('The objective, report, product or destination changed', false, false);
    }
  }
  function objectiveContentFields() {
    return { account:$('#objective-content-account').value, product:$('#objective-content-product').value, title:$('#objective-content-title').value, description:$('#objective-content-description').value };
  }
  function objectiveContentChoiceKey() { return canonicalContent([objectiveContent.editor?.loaded, objectiveContentFields()]); }
  function validObjectiveContentDraft(editor) {
    const fields = objectiveContentFields();
    return editor.loaded && !editor.stale && fields.account === editor.loaded.target.connectionId && fields.product === editor.loaded.product.id &&
      fields.title.trim().length > 0 && fields.title.length <= 200 && fields.description.length <= 10000;
  }
  function renderObjectiveContent() {
    const editor = objectiveContent.editor; if (!editor) return;
    const attempt = editor.attempt, working = Boolean(objectiveContent.ticket), saved = attempt?.phase === 'saved', unresolved = attempt && !['saved','refused'].includes(attempt.phase);
    const ready = !working && (attempt ? Boolean(unresolved && attempt.retryReady && !editor.stale) : validObjectiveContentDraft(editor)), locked = working || Boolean(attempt) || editor.stale || !editor.loaded;
    for (const id of ['account','product','title','description']) $('#objective-content-' + id).disabled = locked;
    $('#objective-content-ack').disabled = !ready; if (!editor.ackKey) $('#objective-content-ack').checked = false;
    $('#objective-content-prepare').disabled = !ready || !$('#objective-content-ack').checked || editor.ackKey !== objectiveContentChoiceKey();
    $('#objective-content-prepare').classList.toggle('hidden', Boolean(attempt));
    $('#objective-content-retry').classList.toggle('hidden', !unresolved || !attempt.retryReady);
    $('#objective-content-retry').disabled = !ready || !$('#objective-content-ack').checked || editor.ackKey !== objectiveContentChoiceKey();
    $('#objective-content-check').classList.toggle('hidden', !unresolved); $('#objective-content-check').disabled = working;
    $('#objective-content-reload').classList.toggle('hidden', Boolean(unresolved) || saved); $('#objective-content-reload').disabled = working;
    $('#objective-content-approvals').classList.toggle('hidden', !saved); $('#objective-content-approvals').disabled = working;
    $('#objective-content-form').setAttribute('aria-busy', String(working));
    const source = attempt?.intent.source || editor.loaded?.source, target = attempt?.intent.target || editor.loaded?.target;
    const fields = attempt ? { product:attempt.intent.input.productId, title:attempt.intent.input.title, description:attempt.intent.input.description } : objectiveContentFields();
    $('#objective-content-exact').textContent = source ? 'Goal: ' + source.objectiveId + ' · revision ' + source.objectiveRevision + '\nReport: ' + source.reportId + '\nReview job: ' + source.jobId +
      '\nOpportunity: ' + source.opportunityId + '\nDestination account: ' + (attempt || objectiveContentFields().account ? target.account : 'Not selected') + '\nConnection: ' + (attempt || objectiveContentFields().account ? target.connectionId : 'Not selected') +
      '\nProduct reference: ' + (fields.product || 'Not selected') + '\nExact new title: ' + (fields.title.trim() || 'Not entered') + '\nExact new description:\n' + (fields.description === '' ? 'Empty description: this clears the Shopify description.' : fields.description) + (attempt ? '\nRequest reference: ' + attempt.requestId : '') : '';
    $('#objective-content-status').textContent = saved ? 'Exact goal-associated request found: ' + attempt.record.id + ' · ' + statusLabel(attempt.record.status) + '. Saved history does not authorize another apply. Source check: ' + attempt.sourceStatus.status + (attempt.sourceStatus.message ? '. ' + attempt.sourceStatus.message : '.') :
      attempt?.phase === 'submitting' ? 'Preparing this exact request. Leaving cannot cancel a server save.' : attempt?.phase === 'reconciling' ? 'Checking this exact request and its original goal/report source…' :
      unresolved ? (attempt.retryReady ? 'No matching request was found in the checked snapshot, and the original source and target still match. An earlier save could still commit. Review the retained exact fields and acknowledge them before deliberately retrying this same reference.' : 'The preparation outcome is unknown. Keep this exact request reference and check again. An absent lookup cannot prove an earlier save will not commit. No new request or retry is sent automatically.') :
      editor.message || (working ? 'Reading the selected report, opportunity, product and destination…' : 'Choose the exact destination and product, write the content, then acknowledge the full review.');
  }
  function validObjectiveContentSource(source, editor) {
    return exactContentKeys(source, objectiveContentKeys) && source.schema === objectiveContentSchema && source.objectiveId === editor.selection.objectiveId && source.objectiveRevision === editor.selection.objectiveRevision &&
      source.jobId === editor.selection.jobId && source.reportId === editor.selection.reportId && source.opportunityId === editor.selection.opportunityId && source.actorId === editor.context.userId &&
      Number.isSafeInteger(source.actorSessionVersion) && source.actorSessionVersion > 0 && /^gid:\/\/shopify\/Product\/\d+$/.test(source.productId) &&
      /^[a-f0-9]{32}$/.test(source.inputFingerprint) && ['objectiveDigest','payloadDigest','resultDigest','jobIdentityDigest','opportunityDigest','productDigest','approvalSourceDigest'].every(key => /^[a-f0-9]{64}$/.test(source[key]));
  }
  function validObjectiveContentContext(value, editor) {
    const target = value?.target;
    return exactContentKeys(value,['schema','workspaceId','requestedBy','source','sourceRevision','target','objective','candidate','product','policy','notice']) && value.schema === 'runvara-objective-content-context/v1' &&
      value.workspaceId === editor.context.workspaceId && value.requestedBy === editor.context.userId && /^[a-f0-9]{64}$/.test(value.sourceRevision) && validObjectiveContentSource(value.source,editor) &&
      exactContentKeys(target,['schema','connectionId','account','settingsRevision']) && target.schema === 'runvara-manual-content-target/v1' && contentReference(target.connectionId) &&
      typeof target.account === 'string' && target.account.length <= 253 && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(target.account) && Number.isSafeInteger(target.settingsRevision) && target.settingsRevision >= 0 &&
      value.objective?.id === value.source.objectiveId && value.objective.revision === value.source.objectiveRevision && typeof value.objective.title === 'string' &&
      value.candidate?.opportunityId === value.source.opportunityId && ['Thin product title','Thin product description'].includes(value.candidate.issue) &&
      value.product?.id === value.source.productId && value.product.provenance === 'unverified' && typeof value.product.title === 'string' && typeof value.product.description === 'string' &&
      typeof value.policy?.allowed === 'boolean' && Array.isArray(value.policy.blockers) && value.policy.blockers.length <= 100 && typeof value.notice === 'string';
  }
  async function loadObjectiveContent(editor) {
    if (!checkObjectiveContentIdentity() || objectiveContent.ticket || editor !== objectiveContent.editor || (editor.attempt && editor.attempt.phase !== 'refused')) return;
    editor.ackKey = null; editor.message = ''; $('#objective-content-error').textContent = '';
    const ticket = objectiveContentTicket('context',editor); renderObjectiveContent();
    try {
      const value = await request('/api/objective-content/context?jobId=' + encodeURIComponent(editor.selection.jobId) + '&opportunityId=' + encodeURIComponent(editor.selection.opportunityId), { signal:ticket.controller.signal,isCurrent:()=>currentObjectiveContent(ticket) });
      if (!currentObjectiveContent(ticket)) return;
      if (!validObjectiveContentContext(value,editor)) throw new Error('The response did not match the selected owner, objective, report and candidate. Reload the review before continuing.');
      const sourceHash = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalContent(value.source)));
      if (!currentObjectiveContent(ticket)) return;
      if (Array.from(new Uint8Array(sourceHash),byte=>byte.toString(16).padStart(2,'0')).join('') !== value.sourceRevision) throw new Error('The returned source and preview revision did not match. Reload the selected source.');
      editor.loaded = freezeObjective(objectiveCopy(value)); editor.context = objectiveContext(); editor.localKey = objectiveContentLocalKey(editor); editor.stale = false; editor.attempt = null;
      $('#objective-content-form').reset();
      $('#objective-content-account').innerHTML = '<option value="">Choose the destination Shopify account</option><option value="' + escapeHtml(value.target.connectionId) + '">' + escapeHtml(value.target.account + ' · ' + value.target.connectionId) + '</option>';
      $('#objective-content-product').innerHTML = '<option value="">Choose the exact product reference</option><option value="' + escapeHtml(value.product.id) + '">' + escapeHtml(value.product.title + ' · ' + value.product.id) + '</option>';
      $('#objective-content-purpose').textContent = value.objective.title + ' · revision ' + value.objective.revision + '\nSelected issue: ' + value.candidate.issue + '\nReport: ' + value.source.reportId + '\n' + value.notice;
      $('#objective-content-baseline').textContent = 'Retained title: ' + value.product.title + '\nRetained description:\n' + value.product.description;
      $('#objective-content-policy').textContent = (value.policy.allowed ? 'No financial qualification is claimed. Other safeguards and exact approval still apply.' : 'Execution is blocked by the saved conditions: ' + value.policy.blockers.map(row => typeof row === 'string' ? row : row.message || row.code || 'Unresolved condition').join(' · ')) +
        ' Profit-first and any financial or stock limit, including an explicit zero, require evidence this content request does not supply. Preparation does not remove those limits.';
      $('#objective-content-account').focus();
    } catch(error) {
      if (!currentObjectiveContent(ticket)) return;
      if (objectiveContentIdentityError(error)) { interruptObjectiveContent('Owner access unavailable',true); return; }
      editor.stale = true; editor.message = 'The selected source could not be loaded. No request was prepared.'; $('#objective-content-error').textContent = error.message;
    } finally { if (objectiveContent.ticket === ticket) { objectiveContent.ticket = null; renderObjectiveContent(); } }
  }
  function openObjectiveContent(opportunityId) {
    clearClosedObjectivePanel(objectivePanelObserver.takeRecords());
    const active = objectiveReview.active;
    if (!checkObjectiveContentIdentity() || objectiveUI.editor || objectiveUI.mutation || planningDraftOpen() || !contentCandidate(active,opportunityId)) return;
    if (objectiveContent.editor) {
      $('#objective-content-editor').classList.remove('hidden'); $('#resume-objective-content').classList.add('hidden');
      $('#objective-content-error').textContent = 'Review or close the retained request first. An unknown request must be reconciled before starting a different one.'; renderObjectiveContent(); return;
    }
    const editor = { context:objectiveContext(), review:active, selection:freezeObjective({objectiveId:active.objectiveId,objectiveRevision:active.objectiveRevision,jobId:active.job.id,reportId:active.report.id,opportunityId}), loaded:null, attempt:null, stale:false, ackKey:null, message:'' };
    objectiveContent.editor = editor; $('#objective-content-editor').classList.remove('hidden'); $('#resume-objective-content').classList.add('hidden'); loadObjectiveContent(editor);
  }
  function validObjectiveContentHistory(value, attempt) {
    const row = value?.request, intent = attempt.intent;
    if (!exactContentKeys(value,['schema','workspaceId','requestId','requestedBy','found','request','sourceStatus']) || value.schema !== 'runvara-objective-content-request/v1' || value.workspaceId !== attempt.context.workspaceId ||
      value.requestedBy !== attempt.context.userId || value.requestId !== attempt.requestId || typeof value.found !== 'boolean') return false;
    if (!value.found) return row === null && value.sourceStatus === null;
    return exactContentKeys(row,contentRecordKeys) && contentReference(row.id) && row.requestId === attempt.requestId && row.provider === 'shopify' && row.origin === 'owner_objective_content' &&
      row.requestedBy === attempt.context.userId && row.connectionId === intent.target.connectionId && row.account === intent.target.account && row.digest === intent.digest &&
      contentReference(row.approvalId) && ['pending_approval','ready','executing','processing','completed','uncertain','failed','rejected'].includes(row.status) &&
      canonicalContent(row.input) === canonicalContent(intent.input) && canonicalContent(row.source) === canonicalContent(intent.source) &&
      value.sourceStatus && ['current','changed','unavailable'].includes(value.sourceStatus.status) && Object.keys(value.sourceStatus).every(key=>['status','code','message'].includes(key)) &&
      (value.sourceStatus.code === undefined || typeof value.sourceStatus.code === 'string') && (value.sourceStatus.message === undefined || typeof value.sourceStatus.message === 'string');
  }
  function acceptObjectiveContentHistory(editor,value) {
    editor.attempt.phase = 'saved'; editor.attempt.retryReady = false; editor.attempt.record = freezeObjective(objectiveCopy(value.request)); editor.attempt.sourceStatus = freezeObjective(objectiveCopy(value.sourceStatus)); editor.ackKey = null;
    objectiveContent.previous = { key:editor.attempt.key,requestId:editor.attempt.requestId }; $('#objective-content-error').textContent = '';
  }
  async function prepareObjectiveContent(retry = false) {
    observeObjectiveContent();
    const editor = objectiveContent.editor;
    if (!editor || !checkObjectiveContentIdentity() || objectiveContent.ticket || editor.stale || !$('#objective-content-ack').checked || editor.ackKey !== objectiveContentChoiceKey()) return;
    let attempt = editor.attempt;
    if (retry) {
      if (!attempt?.retryReady || !sameObjectiveContentOwner(attempt.context)) return;
    } else {
      if (attempt || !validObjectiveContentDraft(editor)) return;
      const fields = objectiveContentFields(), input = {productId:fields.product,operation:'product_content',title:fields.title.trim(),description:fields.description};
      const key = canonicalContent([editor.loaded.source,editor.loaded.target.connectionId,editor.loaded.target.account,input]);
      if (objectiveContent.previous?.key === key) { $('#objective-content-error').textContent = 'This exact source and content already have a saved request. Prepare a fresh review for a different request.'; return; }
      attempt = {context:objectiveContext(),requestId:crypto.randomUUID(),key,phase:'submitting',sent:false,hadUnknown:false,retryReady:false,intent:freezeObjective({source:objectiveCopy(editor.loaded.source),sourceRevision:editor.loaded.sourceRevision,target:objectiveCopy(editor.loaded.target),input})};
      editor.attempt = attempt; $('#objective-content-title').value = input.title;
    }
    const input = attempt.intent.input;
    attempt.phase = 'submitting'; attempt.retryReady = false;
    const ticket = objectiveContentTicket('prepare',editor); $('#objective-content-error').textContent = ''; renderObjectiveContent();
    try {
      const hash = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(input)));
      if (!currentObjectiveContent(ticket)) return;
      attempt.intent = freezeObjective({...attempt.intent,digest:Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('')});
      const visible = objectiveContentFields();
      if (editor.localKey !== objectiveContentLocalKey(editor) || visible.account !== attempt.intent.target.connectionId || visible.product !== input.productId || visible.title.trim() !== input.title || visible.description !== input.description) throw Object.assign(new Error('The exact reviewed source or fields changed. Reload and review again.'),{status:400});
      attempt.sent = true;
      const value = await request('/api/objective-content/requests',{method:'POST',body:JSON.stringify({requestId:attempt.requestId,jobId:attempt.intent.source.jobId,opportunityId:attempt.intent.source.opportunityId,sourceRevision:attempt.intent.sourceRevision,target:attempt.intent.target,productId:input.productId,title:input.title,description:input.description,confirmedDestinationProduct:true}),signal:ticket.controller.signal,isCurrent:()=>currentObjectiveContent(ticket)});
      if (!currentObjectiveContent(ticket)) return;
      if (!validObjectiveContentHistory(value,attempt) || !value.found) throw new Error('The response did not confirm this exact goal-associated request.');
      acceptObjectiveContentHistory(editor,value);
    } catch(error) {
      if (!currentObjectiveContent(ticket)) return;
      if (objectiveContentIdentityError(error)) { interruptObjectiveContent('Owner access unavailable',true); return; }
      if (attempt.sent && (attempt.hadUnknown || !error.status || error.status >= 500 || error.code === 'STATE_CONFLICT')) { attempt.phase = 'unknown'; attempt.hadUnknown = true; editor.ackKey = null; }
      else { attempt.phase = 'refused'; editor.stale = true; editor.ackKey = null; editor.message = 'Preparation was refused. Reload and review the source before another draft.'; }
      $('#objective-content-error').textContent = error.message;
    } finally { if (objectiveContent.ticket === ticket) { objectiveContent.ticket = null; renderObjectiveContent(); } }
  }
  $('#objective-content-form').addEventListener('submit',event=>{event.preventDefault();prepareObjectiveContent();});
  $('#objective-content-retry').addEventListener('click',()=>prepareObjectiveContent(true));
  $('#objective-content-check').addEventListener('click',async()=>{
    const editor = objectiveContent.editor, attempt = editor?.attempt;
    if (!attempt?.sent || !attempt.intent.digest || ['saved','refused'].includes(attempt.phase) || !checkObjectiveContentIdentity() || objectiveContent.ticket) return;
    const ticket = objectiveContentTicket('history',editor); attempt.phase = 'reconciling'; attempt.retryReady = false; editor.ackKey = null; $('#objective-content-error').textContent = ''; renderObjectiveContent();
    try {
      const value = await request('/api/objective-content/requests/' + encodeURIComponent(attempt.requestId),{signal:ticket.controller.signal,isCurrent:()=>currentObjectiveContent(ticket)});
      if (!currentObjectiveContent(ticket)) return;
      if (!validObjectiveContentHistory(value,attempt)) throw new Error('The saved response did not match the original source, owner, account, product and content.');
      if (value.found) acceptObjectiveContentHistory(editor,value);
      else {
        attempt.phase = 'unknown'; attempt.hadUnknown = true;
        $('#objective-content-error').textContent = 'No matching request was found in this checked snapshot. The original save could still commit. Checking whether the original source and target still match; no request is being resent.';
        const fresh = await request('/api/objective-content/context?jobId=' + encodeURIComponent(attempt.intent.source.jobId) + '&opportunityId=' + encodeURIComponent(attempt.intent.source.opportunityId),{signal:ticket.controller.signal,isCurrent:()=>currentObjectiveContent(ticket)});
        if (!currentObjectiveContent(ticket)) return;
        if (!validObjectiveContentContext(fresh,editor) || fresh.sourceRevision !== attempt.intent.sourceRevision || canonicalContent(fresh.source) !== canonicalContent(attempt.intent.source) || canonicalContent(fresh.target) !== canonicalContent(attempt.intent.target)) throw new Error('The original source or destination no longer matches. Keep checking this exact saved reference; it cannot be replaced or rebased.');
        // Matching the original source (already hashed before submission) never
        // substitutes fresh content or a new request ID into the retained intent.
        editor.context = objectiveContext(); editor.localKey = objectiveContentLocalKey(editor); editor.stale = false; attempt.retryReady = true;
        $('#objective-content-error').textContent = 'No matching request was found in this checked snapshot. The original save could still commit. A retry requires a new acknowledgement and uses only the original exact reference.';
      }
    } catch(error) {
      if (!currentObjectiveContent(ticket)) return;
      if (objectiveContentIdentityError(error)) { interruptObjectiveContent('Owner access unavailable',true); return; }
      attempt.phase = 'unknown'; attempt.hadUnknown = true; attempt.retryReady = false; $('#objective-content-error').textContent = 'Could not reconcile this exact request. ' + error.message;
    } finally { if (objectiveContent.ticket === ticket) { objectiveContent.ticket = null; renderObjectiveContent(); } }
  });
  for (const type of ['input','change']) $('#objective-content-form').addEventListener(type,event=>{
    if (!checkObjectiveContentIdentity() || objectiveContent.ticket || !objectiveContent.editor) return;
    observeObjectiveContent(); const editor = objectiveContent.editor; if (!editor) return;
    editor.ackKey = event.target.id === 'objective-content-ack' && event.target.checked ? objectiveContentChoiceKey() : null; renderObjectiveContent();
  });
  $('#objective-content-reload').addEventListener('click',()=>{const editor=objectiveContent.editor;if(editor && !objectiveContent.ticket && (!editor.attempt || editor.attempt.phase==='refused')) loadObjectiveContent(editor);});
  $('#objective-content-cancel').addEventListener('click',()=>{
    const editor=objectiveContent.editor;if(!editor)return;
    interruptObjectiveContent('Content editor closed');
    if (!editor.attempt || editor.attempt.phase === 'refused' || editor.attempt.phase === 'saved') { objectiveContent.editor=null;$('#resume-objective-content').classList.add('hidden'); }
  });
  $('#resume-objective-content').addEventListener('click',()=>{if(checkObjectiveContentIdentity() && objectiveContent.editor){$('#objective-content-editor').classList.remove('hidden');$('#resume-objective-content').classList.add('hidden');observeObjectiveContent();renderObjectiveContent();}});
  $('#objective-content-approvals').addEventListener('click',async()=>{
    const editor=objectiveContent.editor;if(editor?.attempt?.phase!=='saved'||!checkObjectiveContentIdentity())return;
    setView('approvals');
    const ticket={context:objectiveContext(),epoch:objectiveContent.epoch,controller:new AbortController()}; objectiveContent.handoff=ticket;
    const current=()=>objectiveContent.handoff===ticket && ticket.epoch===objectiveContent.epoch && sameObjectiveSession(ticket.context,true) && state.view==='approvals' && !document.hidden;
    try {
      const snapshot=await request('/api/bootstrap',{signal:ticket.controller.signal,isCurrent:current});
      if(!current())return;
      if(snapshot?.workspace?.id!==ticket.context.workspaceId || snapshot.user?.id!==ticket.context.userId || snapshot.user.role!=='owner' || snapshot.user.active===false || snapshot.user.passwordChangeRequired || snapshot.csrf!==ticket.context.csrf || !Array.isArray(snapshot.approvals) || !Array.isArray(snapshot.connectionWrites)) throw new Error('A matching saved approval snapshot was not returned.');
      state.data.approvals=snapshot.approvals; state.data.connectionWrites=snapshot.connectionWrites; renderApprovals();
    } catch(error) {if(current())showMessage('Could not refresh the saved approval: '+error.message,'error');}
    finally {if(objectiveContent.handoff===ticket)objectiveContent.handoff=null;}
  });

  const restrictionSchema = 'runvara-objective-execution-policy/v1';
  const preparationPolicy = () => ({ schema: restrictionSchema, mode: 'preparation_only' });
  const objectiveCopy = value => JSON.parse(JSON.stringify(value));
  function freezeObjective(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freezeObjective); Object.freeze(value); }
    return value;
  }
  function objectiveContext() {
    return { session: state.session, data: state.data, csrf: state.csrf, sessionCsrf: state.session?.csrf,
      userId: state.session?.user?.id, workspaceId: state.data?.workspace?.id,
      sessionWorkspaceId: state.session?.workspace?.id, generation: state.graphGeneration };
  }
  function sameObjectiveSession(context, owner = false) {
    const session = state.session, data = state.data;
    return Boolean(context && session && data && context.session === session && context.data === data &&
      context.csrf === state.csrf && context.sessionCsrf === session.csrf && context.generation === state.graphGeneration &&
      context.userId === session.user?.id && context.userId === data.user?.id &&
      context.workspaceId === data.workspace?.id && context.workspaceId === session.workspace?.id &&
      context.sessionWorkspaceId === session.workspace?.id && !session.user?.passwordChangeRequired && !data.user?.passwordChangeRequired &&
      session.user?.active !== false && data.user?.active !== false &&
      (!owner || (session.user?.role === 'owner' && data.user?.role === 'owner')));
  }
  function canPlanObjective() {
    return sameObjectiveSession(objectiveContext()) && ['owner','admin'].includes(state.session.user.role) && state.session.user.role === state.data.user.role;
  }
  function planningSignature() {
    return JSON.stringify(Array.from($('#business-objective-form').elements).filter(field => field.name).map(field => [field.name, field.type === 'checkbox' ? field.checked : field.value]));
  }
  function planningDraftOpen() {
    return Boolean($('#business-objective-form').dataset.objectiveId) || planningSignature() !== objectiveUI.planningBaseline;
  }
  function restrictionVisible() {
    return state.view === 'ai-team' && $('.business-objectives-panel').open && !document.hidden && !$('#app-shell').classList.contains('hidden');
  }
  function currentRestriction(editor) {
    clearClosedObjectivePanel(objectivePanelObserver.takeRecords());
    if (objectiveUI.editor !== editor || editor?.epoch !== objectiveUI.epoch) return false;
    if (!sameObjectiveSession(editor.context, true)) { resetObjectiveEditing(true); return false; }
    const rows = editor.bootstrapReferences ? state.data.connections : editor.referenceRows;
    if (!editor.stale && JSON.stringify(exactRestrictionConnections(rows, editor.context.workspaceId)) !== editor.referenceKey) {
      staleRestriction(editor, 'The saved account references changed. Your choices remain visible. Reload the objective/accounts and review a deliberate account choice before saving.');
    }
    return restrictionVisible();
  }
  function resetObjectiveEditing(clearPrivate = false, preserveContent = false) {
    if (!preserveContent) interruptObjectiveContent('Workspace or navigation changed', clearPrivate);
    const editor = objectiveUI.editor;
    // Leaving a sent PUT does not cancel the saved change. Require a fresh read.
    if (objectiveUI.mutation) { objectiveUI.needsReload = true; objectiveUI.unknownSave = true; }
    objectiveUI.epoch++;
    editor?.controller?.abort();
    objectiveUI.editor = null;
    objectiveUI.read?.controller.abort(); objectiveUI.read = null;
    if (objectiveUI.mutation) { objectiveUI.mutation.controller?.abort(); objectiveUI.mutation = null; }
    const form = $('#objective-restriction-form');
    form.reset(); form.setAttribute('aria-busy', 'false');
    $('#objective-restriction-connection').replaceChildren();
    for (const id of ['context','status','consequence','error']) $('#objective-restriction-' + id).textContent = '';
    $('#business-objective-restriction').classList.add('hidden');
    Array.from($('#business-objective-form').elements).forEach(field => { field.disabled = false; });
    setBusy($('#business-objective-form').querySelector('button[type=submit]'), false);
    setBusy($('#load-business-objectives'), false);
    $('#business-objective-form').classList.toggle('hidden', !canPlanObjective());
    if (clearPrivate) { objectiveUI.needsReload = false; objectiveUI.unknownSave = false; objectiveUI.snapshotContext = null; objectiveUI.referenceCache = null; state.objectiveSnapshot = null; resetObjectiveForm(); $('#business-objectives-list').replaceChildren(); }
    else if (objectiveUI.needsReload) {
      objectiveUI.snapshotContext = null; state.objectiveSnapshot = null;
      $('#business-objectives-list').textContent = (objectiveUI.unknownSave ? 'The objective save outcome is unknown. ' : '') + 'Load saved objectives and review the saved state before another change.';
    }
  }
  function exactRestrictionConnections(rows, workspaceId) {
    if (!Array.isArray(rows)) return [];
    const shopify = rows.filter(row => row && row.provider === 'shopify');
    return shopify.filter(row => typeof row.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(row.id) &&
      shopify.filter(other => other.id === row.id).length === 1 &&
      [row.workspaceId, row.workspace_id, row.tenantId, row.tenant_id, row.workspace?.id, row.tenant?.id, typeof row.workspace === 'string' ? row.workspace : undefined, typeof row.tenant === 'string' ? row.tenant : undefined].every(value => value === undefined || value === workspaceId) &&
      typeof row.metadata?.shopDomain === 'string' && row.metadata.shopDomain.length <= 253 && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(row.metadata.shopDomain))
      .map(row => Object.freeze({ id: row.id, account: row.metadata.shopDomain }));
  }
  function restrictionPolicy(editor) {
    const mode = $('#objective-restriction-mode').value;
    if (mode === 'preparation_only') return preparationPolicy();
    if (mode !== 'enforce') return null;
    const connection = editor.connections.find(row => row.id === $('#objective-restriction-connection').value);
    if (!connection) return null;
    return { schema: restrictionSchema, mode: 'enforce', scope: { provider: 'shopify', operation: 'product_content', connectionId: connection.id, account: connection.account } };
  }
  function policyKey(policy) {
    if (!policy || policy.mode === 'preparation_only') return 'preparation_only';
    return JSON.stringify([policy.schema, policy.mode, policy.scope?.provider, policy.scope?.operation, policy.scope?.connectionId, policy.scope?.account]);
  }
  function confirmedRestrictionPolicy(actual, proposed) {
    if (!actual || actual.schema !== restrictionSchema || actual.mode !== proposed.mode || policyKey(actual) !== policyKey(proposed)) return false;
    if (actual.mode === 'preparation_only') return Object.keys(actual).sort().join(',') === 'mode,schema';
    return Object.keys(actual).sort().join(',') === 'mode,schema,scope' && actual.scope &&
      Object.keys(actual.scope).sort().join(',') === 'account,connectionId,operation,provider';
  }
  function savedObjectiveDefinition(item) {
    const { revision, updatedAt, effectiveStatus, executionPolicy, ...definition } = item || {};
    // Compare named fields independently of JSON property insertion order.
    return JSON.stringify(Object.keys(definition).sort().map(key => [key, definition[key]]));
  }
  function restrictionChoiceKey() {
    return JSON.stringify([$('#objective-restriction-mode').value, $('#objective-restriction-connection').value]);
  }
  function describeRestriction(policy) {
    return policy?.mode === 'enforce' ? policy.scope.account + ' (saved connection ' + policy.scope.connectionId + ')' : 'planning only';
  }
  function renderRestrictionChoice(editor) {
    const proposed = restrictionPolicy(editor), previous = editor.source.executionPolicy || preparationPolicy();
    const unchanged = proposed && policyKey(previous) === policyKey(proposed);
    const mode = $('#objective-restriction-mode').value;
    let consequence;
    if (unchanged) consequence = 'No change to the saved restriction. No save is needed.';
    else if (!proposed) consequence = 'Choose an available exact saved account before reviewing a restriction. An unavailable saved binding is never replaced automatically.';
    else if (proposed.mode === 'preparation_only') consequence = 'Remove this objective’s extra restriction from ' + describeRestriction(previous) + '. Other restrictions, write permissions and mandatory approval still apply. Existing approval authority is not refreshed.';
    else if (previous.mode === 'enforce') consequence = 'Move this objective’s restriction from ' + describeRestriction(previous) + ' to ' + describeRestriction(proposed) + '. The previous account loses this objective’s extra restriction. Saved conditions apply to the new account; previously bound requests may be stale.';
    else consequence = 'Apply this objective’s saved conditions to manual Shopify product-content changes at ' + describeRestriction(proposed) + '. Matching changes without the required conditions are blocked, and older unbound pending proposals become invalid.';
    $('#objective-restriction-consequence').textContent = consequence;
    const busy = Boolean(editor.busy), blocked = busy || editor.stale;
    $('#objective-restriction-mode').disabled = blocked;
    $('#objective-restriction-connection').disabled = blocked || mode !== 'enforce';
    $('#objective-restriction-ack').disabled = blocked || !proposed || unchanged;
    $('#save-objective-restriction').disabled = blocked || !proposed || unchanged || !$('#objective-restriction-ack').checked || editor.ackKey !== restrictionChoiceKey();
    $('#save-objective-restriction').textContent = editor.busy === 'save' ? 'Saving restriction…' : 'Save restriction';
    // During GET, cancellation remains available. During PUT its outcome is unknown.
    $('#cancel-objective-restriction').disabled = editor.busy === 'save';
    $('#reload-objective-restriction').disabled = busy;
    $('#objective-restriction-form').setAttribute('aria-busy', String(busy));
  }
  function populateRestriction(editor) {
    const source = editor.source, limits = source.limits || {}, policy = source.executionPolicy || preparationPolicy();
    $('#objective-restriction-context').textContent = source.title + ' · Revision ' + source.revision + ' · Saved status: ' + statusLabel(source.status) + ' · Current window: ' + statusLabel(source.effectiveStatus) +
      '. UTC window: ' + source.startsAt + ' to ' + source.endsAt + '. Metric: ' + statusLabel(source.metric) + '; baseline: ' + (source.baseline ?? 'unknown') + '; target: ' + source.target + '; direction: ' + source.direction +
      '. Saved limits: currency ' + (limits.currency ?? 'not specified') + '; minimum gross margin ' + (limits.minGrossMarginPercent == null ? 'not specified' : limits.minGrossMarginPercent + '%') +
      '; maximum monthly ad budget ' + (limits.maxMonthlyAdBudget ?? 'not specified') + '; minimum stock cover days ' + (limits.minStockCoverDays ?? 'not specified') +
      '; profit first ' + (limits.profitFirst ? 'yes' : 'no') + '; additional approval kinds ' + ((limits.approvalRequiredKinds || []).map(statusLabel).join(', ') || 'none') + '. Saved restriction: ' + describeRestriction(policy) + '.';
    const blocked = limits.profitFirst || ['minGrossMarginPercent','maxMonthlyAdBudget','minStockCoverDays'].some(key => limits[key] != null);
    $('#objective-restriction-status').textContent = (blocked ? 'When this objective’s restriction applies, matching changes are blocked because qualified financial or stock evidence is unavailable for these saved conditions, including any explicit zero limit. ' : 'Other restrictions and exact approval may still block a change. ') +
      (source.effectiveStatus !== 'active' ? 'This objective is outside its active status/window, which also blocks matching changes while restricted. ' : '') +
      'This editor changes no goal, financial limit, stock limit, date or approval requirement.';
    $('#objective-restriction-error').textContent = '';
    $('#objective-restriction-mode').value = policy.mode;
    const select = $('#objective-restriction-connection');
    select.replaceChildren(new Option('Choose an exact saved Shopify account', ''));
    for (const row of editor.connections) select.add(new Option(row.account + ' · ' + row.id + ' · saved reference', row.id));
    if (policy.mode === 'enforce') {
      const exact = editor.connections.find(row => row.id === policy.scope.connectionId && row.account === policy.scope.account);
      if (exact) select.value = exact.id;
      else {
        const option = new Option('Unavailable saved binding: ' + describeRestriction(policy), '__unavailable__'); option.disabled = true; select.add(option); select.value = option.value;
        $('#objective-restriction-status').textContent += ' The saved account is missing, replaced or changed. Review a different exact account or explicitly remove this restriction.';
      }
    } else select.value = '';
    if (!editor.connections.length) $('#objective-restriction-status').textContent += ' No eligible saved Shopify account references are available.';
    $('#objective-restriction-ack').checked = false; editor.ackKey = null; editor.initialChoice = restrictionChoiceKey();
    renderRestrictionChoice(editor);
  }
  function objectiveReferences() {
    const cache = objectiveUI.referenceCache;
    return cache && sameObjectiveSession(cache.context, true) ? cache.rows : state.data?.connections;
  }
  function openRestriction(item, focus = true, connections = objectiveReferences()) {
    const context = objectiveContext();
    if (!sameObjectiveSession(context, true) || !restrictionVisible() || objectiveUI.mutation || !sameObjectiveSession(objectiveUI.snapshotContext, true)) return;
    const source = freezeObjective(objectiveCopy(item));
    const references = exactRestrictionConnections(connections, context.workspaceId);
    const editor = { context, epoch: ++objectiveUI.epoch, source, connections: references, referenceRows: connections, referenceKey: JSON.stringify(references), bootstrapReferences: connections === state.data.connections, busy: null, stale: false, ackKey: null };
    objectiveUI.editor = editor;
    $('#business-objective-restriction').classList.remove('hidden'); $('#business-objective-form').classList.add('hidden');
    populateRestriction(editor);
    if (focus) $('#objective-restriction-mode').focus();
  }
  function staleRestriction(editor, message) {
    editor.stale = true; editor.ackKey = null; $('#objective-restriction-ack').checked = false;
    $('#objective-restriction-error').textContent = message; renderRestrictionChoice(editor);
  }
  function validObjectiveSnapshot(snapshot) {
    return snapshot?.workspaceId === state.data?.workspace?.id && Array.isArray(snapshot.objectives) && snapshot.objectives.length <= 50 &&
      snapshot.objectives.every(item => typeof item?.id === 'string' && item.workspaceId === snapshot.workspaceId && Number.isSafeInteger(item.revision) && item.revision > 0) &&
      new Set(snapshot.objectives.map(item => item.id)).size === snapshot.objectives.length;
  }
  $('#objective-restriction-form').addEventListener('change', event => {
    const editor = objectiveUI.editor;
    if (!editor || !currentRestriction(editor) || editor.busy || editor.stale) return;
    if (event.target.id === 'objective-restriction-ack') editor.ackKey = event.target.checked ? restrictionChoiceKey() : null;
    else { editor.ackKey = null; $('#objective-restriction-ack').checked = false; }
    renderRestrictionChoice(editor);
  });
  $('#cancel-objective-restriction').addEventListener('click', () => {
    const editor = objectiveUI.editor;
    if (!editor || !currentRestriction(editor) || editor.busy === 'save') return;
    const id = editor.source.id; resetObjectiveEditing();
    Array.from(document.querySelectorAll('[data-manage-objective-restriction]')).find(button => button.dataset.manageObjectiveRestriction === id)?.focus();
  });
  $('#reload-objective-restriction').addEventListener('click', async () => {
    const editor = objectiveUI.editor;
    if (!editor || !currentRestriction(editor) || editor.busy || objectiveUI.mutation) return;
    editor.busy = 'reload'; editor.ackKey = null; $('#objective-restriction-ack').checked = false;
    editor.controller = new AbortController(); renderRestrictionChoice(editor);
    $('#objective-restriction-error').textContent = ''; $('#objective-restriction-status').textContent = 'Reading the saved objective and current account references. This discards the previous draft.';
    try {
      const config = { signal: editor.controller.signal, isCurrent: () => currentRestriction(editor) };
      const [snapshot, publicReferences] = await Promise.all([request('/api/business-objectives', config), request('/api/connections', config)]);
      if (!currentRestriction(editor)) return;
      if (!validObjectiveSnapshot(snapshot) || !Array.isArray(publicReferences?.connections)) throw new Error('A matching saved objective and account snapshot was not returned.');
      const item = snapshot.objectives.find(row => row.id === editor.source.id);
      if (!item) throw new Error('This objective is no longer present. Cancel editing and load saved objectives.');
      const references = exactRestrictionConnections(publicReferences.connections, editor.context.workspaceId)
        .map(row => ({ id: row.id, provider: 'shopify', metadata: { shopDomain: row.account } }));
      objectiveUI.referenceCache = { context: objectiveContext(), rows: freezeObjective(references) };
      editor.busy = null; objectiveUI.editor = null; objectiveUI.needsReload = false; objectiveUI.unknownSave = false;
      renderBusinessObjectives(snapshot); openRestriction(item, false);
      $('#objective-restriction-status').textContent += ' Reloaded saved state. Review it and acknowledge any new change before saving.';
      $('#objective-restriction-mode').focus();
    } catch (error) {
      if (!currentRestriction(editor)) return;
      if (error.status === 401 || error.status === 403) { resetObjectiveEditing(true); showMessage('Restriction editing is unavailable for this session. Sign in or refresh your workspace before continuing.', 'error'); }
      else staleRestriction(editor, 'Could not reload the saved state: ' + error.message + ' Reload and review before saving.');
    } finally {
      if (objectiveUI.editor === editor && currentRestriction(editor)) { editor.busy = null; editor.controller = null; renderRestrictionChoice(editor); }
    }
  });
  $('#objective-restriction-form').addEventListener('submit', async event => {
    event.preventDefault();
    const editor = objectiveUI.editor;
    if (!editor || !currentRestriction(editor) || editor.busy || editor.stale || objectiveUI.mutation) return;
    const proposed = restrictionPolicy(editor);
    if (!proposed || policyKey(proposed) === policyKey(editor.source.executionPolicy) || !$('#objective-restriction-ack').checked || editor.ackKey !== restrictionChoiceKey()) return;
    const saved = state.objectiveSnapshot?.objectives?.find(row => row.id === editor.source.id);
    if (!sameObjectiveSession(objectiveUI.snapshotContext, true) || JSON.stringify(saved) !== JSON.stringify(editor.source)) { staleRestriction(editor, 'Saved objective data changed. Discard the draft and reload/review before saving.'); return; }
    editor.busy = 'save'; editor.controller = new AbortController();
    const ticket = { kind: 'restriction', editor, controller: editor.controller }; objectiveUI.mutation = ticket;
    ++state.objectiveGeneration; objectiveUI.read?.controller.abort(); objectiveUI.read = null; setBusy($('#load-business-objectives'), false);
    $('#objective-restriction-error').textContent = ''; renderRestrictionChoice(editor);
    const payload = { id: editor.source.id, revision: editor.source.revision, executionPolicy: proposed };
    try {
      const result = await request('/api/business-objectives', { method: 'PUT', body: JSON.stringify(payload), signal: editor.controller.signal, isCurrent: () => currentRestriction(editor) });
      if (!currentRestriction(editor) || objectiveUI.mutation !== ticket) return;
      const returned = result?.objective, rows = result?.snapshot?.objectives;
      const snapshotRow = Array.isArray(rows) ? rows.find(row => row.id === payload.id) : null;
      if (!validObjectiveSnapshot(result?.snapshot) || returned?.workspaceId !== editor.context.workspaceId || returned?.id !== payload.id || returned?.revision !== payload.revision + 1 ||
        !confirmedRestrictionPolicy(returned.executionPolicy, proposed) || snapshotRow?.revision !== returned.revision || !confirmedRestrictionPolicy(snapshotRow?.executionPolicy, proposed) ||
        savedObjectiveDefinition(returned) !== savedObjectiveDefinition(editor.source) || savedObjectiveDefinition(snapshotRow) !== savedObjectiveDefinition(returned) || snapshotRow?.updatedAt !== returned.updatedAt) {
        throw Object.assign(new Error('The response did not confirm the exact saved restriction.'), { code: 'RESTRICTION_RESULT_UNKNOWN' });
      }
      objectiveUI.mutation = null; objectiveUI.needsReload = false; objectiveUI.unknownSave = false; resetObjectiveEditing(); renderBusinessObjectives(result.snapshot);
      showMessage('Restriction saved. Exact approval and all other safeguards remain required.');
      Array.from(document.querySelectorAll('[data-manage-objective-restriction]')).find(button => button.dataset.manageObjectiveRestriction === payload.id)?.focus();
    } catch (error) {
      if (!currentRestriction(editor) || objectiveUI.mutation !== ticket) return;
      if (error.status === 401 || error.status === 403) { resetObjectiveEditing(true); showMessage('Restriction editing is unavailable for this session. Sign in or refresh your workspace before continuing.', 'error'); return; }
      objectiveUI.needsReload = true;
      objectiveUI.unknownSave = error.code === 'REQUEST_UNAVAILABLE' || error.code === 'RESTRICTION_RESULT_UNKNOWN' || error.status >= 500;
      const message = ['OBJECTIVE_CONFLICT','STATE_CONFLICT'].includes(error.code) ? 'The saved objective or workspace changed. Your choices remain visible but cannot be saved. Discard the draft and reload/review the current saved state.' :
        error.code === 'OBJECTIVE_POLICY_CONNECTION_REQUIRED' ? 'The saved account reference changed or is missing. Your exact old and proposed bindings remain visible. Reload the saved objective/accounts, deliberately choose a current reference and review again.' :
        error.code === 'REQUEST_UNAVAILABLE' || error.code === 'RESTRICTION_RESULT_UNKNOWN' || error.status >= 500 ? 'The restriction save outcome is unknown. It may have been saved. Reload the saved objective and review its current state before another save; this request will not be retried.' :
        'The restriction was not confirmed: ' + error.message + ' Reload the saved objective and review before another save.';
      staleRestriction(editor, message);
    } finally {
      if (objectiveUI.mutation === ticket) objectiveUI.mutation = null;
      if (objectiveUI.editor === editor && currentRestriction(editor)) { editor.busy = null; editor.controller = null; renderRestrictionChoice(editor); }
    }
  });
  const objectivePanel = $('.business-objectives-panel');
  function clearClosedObjectivePanel(changes) {
    if (changes.some((change, index) => change.oldValue !== null &&
      (index + 1 < changes.length ? changes[index + 1].oldValue : objectivePanel.getAttribute('open')) === null)) resetObjectiveEditing();
  }
  const objectivePanelObserver = new MutationObserver(clearClosedObjectivePanel);
  objectivePanelObserver.observe(objectivePanel, { attributes: true, attributeFilter: ['open'], attributeOldValue: true });
  objectivePanel.querySelector('summary').addEventListener('click', () => { if (objectivePanel.open) resetObjectiveEditing(); });
  objectivePanel.addEventListener('toggle', () => { if (!objectivePanel.open) resetObjectiveEditing(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    interruptObjectiveContent('The tab was hidden');
    const editor = objectiveUI.editor;
    if (!editor || editor.busy === 'save' || !sameObjectiveSession(editor.context, true)) { resetObjectiveEditing(); return; }
    // Merely switching tabs keeps unsent choices, but never their acknowledgement
    // or a read ticket. A new object prevents old reload callbacks from reviving.
    editor.controller?.abort(); objectiveUI.read?.controller.abort(); objectiveUI.read = null;
    const paused = { ...editor, epoch: ++objectiveUI.epoch, busy: null, controller: null, ackKey: null };
    objectiveUI.editor = paused;
    staleRestriction(paused, 'The tab was hidden. Your unsent choices remain visible. Discard the draft and reload/review the saved objective before saving.');
  });
  window.addEventListener('popstate', () => resetObjectiveEditing());
  window.addEventListener('pagehide', () => resetObjectiveEditing());

  function resetObjectiveForm() {
    const form = $('#business-objective-form');
    form.reset(); Object.keys(form.dataset).forEach(key => { delete form.dataset[key]; });
    $('#cancel-objective-edit').classList.add('hidden');
    $('#business-objective-error').textContent = '';
    objectiveUI.planningBaseline = planningSignature();
  }
  function renderBusinessObjectives(snapshot) {
    state.objectiveSnapshot = snapshot;
    observeObjectiveContent();
    objectiveUI.snapshotContext = objectiveContext();
    const editor = objectiveUI.editor;
    if (editor && JSON.stringify(snapshot.objectives?.find(row => row.id === editor.source.id)) !== JSON.stringify(editor.source)) staleRestriction(editor, 'Saved objective data changed. Discard the draft and reload/review before saving.');
    const root = $('#business-objectives-list'), canEdit = canPlanObjective(), owner = sameObjectiveSession(objectiveContext(), true);
    root.innerHTML = (snapshot.objectives || []).length ? snapshot.objectives.map(item => {
      const limits = item.limits || {};
      const enforced = item.executionPolicy?.mode === 'enforce';
      const editable = canEdit && (!enforced || state.data?.user?.role === 'owner');
      const scopeNote = enforced ? 'Owner execution restriction: Shopify content at ' + item.executionPolicy.scope.account : 'Planning only; no execution restriction';
      const policies = [limits.minGrossMarginPercent == null ? null : 'Margin ≥ ' + limits.minGrossMarginPercent + '%', limits.maxMonthlyAdBudget == null ? null : 'Ads ≤ ' + limits.maxMonthlyAdBudget + ' ' + limits.currency + '/month', limits.minStockCoverDays == null ? null : 'Stock ≥ ' + limits.minStockCoverDays + ' days', limits.profitFirst ? 'Profit first' : null].filter(Boolean).join(' · ');
      return '<div><span>' + escapeHtml(item.title) + '<small>' + escapeHtml(statusLabel(item.metric)) + ' · ' + escapeHtml(statusLabel(item.effectiveStatus)) + '</small><small>' + escapeHtml(policies) + '</small><small>' + escapeHtml(scopeNote) + '</small></span><b>' + escapeHtml(item.baseline == null ? 'Unknown' : item.baseline) + ' → ' + escapeHtml(item.target) + '</b>' + (editable ? '<button class="text-button" type="button" data-edit-objective="' + escapeHtml(item.id) + '">Edit</button>' : '') + (owner ? '<button class="secondary" type="button" data-manage-objective-restriction="' + escapeHtml(item.id) + '">Manage restriction</button>' : '') + (canEdit && item.effectiveStatus === 'active' ? '<button class="secondary" type="button" data-prepare-objective-review="' + escapeHtml(item.id) + '" data-objective-revision="' + escapeHtml(item.revision) + '">Prepare review</button>' : '') + '</div>';
    }).join('') : '<p class="muted">No saved objectives yet.</p>';
    const active = objectiveReview.active;
    if (active) {
      const current = (snapshot.objectives || []).find(item => item.id === active.objectiveId);
      if (!current || current.revision !== active.objectiveRevision || current.effectiveStatus !== 'active') { active.stale = true; active.staleReason = 'Objective changed'; pauseObjectiveReview('Objective changed. This review refers to the previously saved revision.'); }
      renderObjectiveReview();
    }
  }
  $('#cancel-objective-edit').addEventListener('click', () => { if (!objectiveUI.mutation && !objectiveUI.editor) resetObjectiveForm(); });
  for (const type of ['input','change']) $('#business-objective-form').addEventListener(type, () => { if (planningDraftOpen()) $('#cancel-objective-edit').classList.remove('hidden'); });
  $('#business-objectives-list').addEventListener('click', event => {
    const manage = event.target.closest('[data-manage-objective-restriction]');
    if (manage) {
      if (!sameObjectiveSession(objectiveUI.snapshotContext, true) || objectiveUI.mutation || objectiveUI.read || objectiveUI.needsReload || !restrictionVisible()) return;
      if (planningDraftOpen()) { $('#business-objective-error').textContent = 'Save or cancel your planning edits before managing a restriction.'; $('#cancel-objective-edit').classList.remove('hidden'); return; }
      if (objectiveUI.editor) {
        if (!currentRestriction(objectiveUI.editor) || objectiveUI.editor.busy) return;
        if (objectiveUI.editor.stale || restrictionChoiceKey() !== objectiveUI.editor.initialChoice) { $('#objective-restriction-error').textContent = 'Save, reload or cancel this restriction draft before opening another objective.'; return; }
      }
      const item = state.objectiveSnapshot?.objectives?.find(row => row.id === manage.dataset.manageObjectiveRestriction);
      if (item) openRestriction(item);
      return;
    }
    const prepare = event.target.closest('[data-prepare-objective-review]');
    if (prepare) {
      const item = state.objectiveSnapshot?.objectives?.find(row => row.id === prepare.dataset.prepareObjectiveReview);
      if (!objectiveUI.editor && !objectiveUI.mutation && !prepare.disabled && !$('#business-objective-form').querySelector('button[type=submit]').disabled && item?.effectiveStatus === 'active' && item.revision === Number(prepare.dataset.objectiveRevision) && state.objectiveSnapshot.workspaceId === state.data?.workspace?.id) prepareObjectiveReview(item);
      return;
    }
    const button = event.target.closest('[data-edit-objective]');
    if (!button || !canPlanObjective() || !sameObjectiveSession(objectiveUI.snapshotContext) || objectiveUI.mutation || objectiveUI.needsReload || $('#business-objective-form').querySelector('button[type=submit]').disabled) return;
    if (objectiveUI.editor) { $('#objective-restriction-error').textContent = 'Save or cancel restriction editing before changing planning fields.'; return; }
    const item = state.objectiveSnapshot?.objectives?.find(row => row.id === button.dataset.editObjective);
    if (!item || state.objectiveSnapshot.workspaceId !== state.data?.workspace?.id || (item.executionPolicy?.mode === 'enforce' && !sameObjectiveSession(objectiveUI.snapshotContext, true))) return;
    if (planningDraftOpen() && planningSignature() !== objectiveUI.planningBaseline) { $('#business-objective-error').textContent = 'Save or cancel your current planning edits before opening another objective.'; return; }
    const form = $('#business-objective-form'), fields = form.elements;
    form.dataset.objectiveId = item.id; form.dataset.revision = String(item.revision);
    for (const key of ['title','metric','direction','status','baseline','target']) fields[key].value = item[key] ?? '';
    for (const key of ['startsAt','endsAt']) { const value = new Date(item[key]); fields[key].value = new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0,-1); form.dataset[key + 'Original'] = item[key]; form.dataset[key + 'Display'] = fields[key].value; }
    if (item.limits.currency && !Array.from(fields.currency.options).some(option => option.value === item.limits.currency)) { const option = document.createElement('option'); option.value = item.limits.currency; option.textContent = item.limits.currency; fields.currency.append(option); }
    for (const key of ['currency','minGrossMarginPercent','maxMonthlyAdBudget','minStockCoverDays']) fields[key].value = item.limits[key] ?? '';
    fields.profitFirst.checked = item.limits.profitFirst;
    objectiveUI.planningBaseline = planningSignature();
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
    clearClosedObjectivePanel(objectivePanelObserver.takeRecords());
    const button = event.currentTarget;
    if (objectiveUI.read || objectiveUI.mutation || button.disabled) return;
    if (objectiveUI.editor) { $('#objective-restriction-error').textContent = 'Use Discard draft and reload saved objective/accounts, or cancel restriction editing first.'; return; }
    const ticket = { context: objectiveContext(), epoch: objectiveUI.epoch, generation: ++state.objectiveGeneration, controller: new AbortController() };
    if (!sameObjectiveSession(ticket.context)) return;
    objectiveUI.read = ticket;
    const current = () => objectiveUI.read === ticket && ticket.epoch === objectiveUI.epoch && ticket.generation === state.objectiveGeneration && sameObjectiveSession(ticket.context);
    setBusy(button, true, 'Loading…');
    try {
      const snapshot = await request('/api/business-objectives', { signal: ticket.controller.signal, isCurrent: current });
      if (!current()) return;
      if (!validObjectiveSnapshot(snapshot)) throw new Error('A matching saved objective snapshot was not returned.');
      objectiveUI.needsReload = false; objectiveUI.unknownSave = false; renderBusinessObjectives(snapshot);
    } catch(error) { if (current()) $('#business-objectives-list').textContent = error.message; }
    finally { if (objectiveUI.read === ticket) { objectiveUI.read = null; setBusy(button, false); } }
  });
  $('#business-objective-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, fields = form.elements, button = form.querySelector('button'), error = $('#business-objective-error');
    if (button.disabled || !canPlanObjective() || objectiveUI.mutation || objectiveUI.editor) return;
    if (objectiveUI.needsReload) { error.textContent = 'Load saved objectives and review the saved restriction state before another change.'; return; }
    const existing = state.objectiveSnapshot?.objectives?.find(row => row.id === form.dataset.objectiveId);
    if (form.dataset.objectiveId && (!sameObjectiveSession(objectiveUI.snapshotContext) || !existing || (existing.executionPolicy?.mode === 'enforce' && !sameObjectiveSession(objectiveUI.snapshotContext, true)))) return;
    const ticket = { kind: 'planning', context: objectiveContext(), generation: ++state.objectiveGeneration, controller: new AbortController() };
    objectiveUI.mutation = ticket;
    objectiveUI.read?.controller.abort(); objectiveUI.read = null; setBusy($('#load-business-objectives'), false);
    const current = () => objectiveUI.mutation === ticket && ticket.generation === state.objectiveGeneration && sameObjectiveSession(ticket.context) && canPlanObjective();
    const number = name => fields[name].value.trim() === '' ? null : Number(fields[name].value);
    const timestamp = name => form.dataset[name + 'Original'] && fields[name].value === form.dataset[name + 'Display'] ? form.dataset[name + 'Original'] : new Date(fields[name].value).toISOString();
    error.textContent = ''; setBusy(button, true, 'Saving…');
    Array.from(fields).forEach(field => { field.disabled = true; });
    try {
      const body = {...(form.dataset.objectiveId ? {id:form.dataset.objectiveId,revision:Number(form.dataset.revision)} : {}), title:fields.title.value, status:fields.status.value, metric:fields.metric.value, baseline:number('baseline'), target:number('target'), direction:fields.direction.value,
        startsAt:timestamp('startsAt'), endsAt:timestamp('endsAt'),
        limits:{currency:fields.currency.value || null, minGrossMarginPercent:number('minGrossMarginPercent'), maxMonthlyAdBudget:number('maxMonthlyAdBudget'), minStockCoverDays:number('minStockCoverDays'), profitFirst:fields.profitFirst.checked}};
      const result = await request('/api/business-objectives', {method:'PUT',body:JSON.stringify(body), signal: ticket.controller.signal, isCurrent: current});
      if (!current()) return;
      renderBusinessObjectives(result.snapshot); resetObjectiveForm(); showMessage('Objective saved. Approval and execution safeguards remain in force.');
    } catch(cause) { if (current()) error.textContent = cause.message; }
    finally { if (objectiveUI.mutation === ticket) { objectiveUI.mutation = null; Array.from(fields).forEach(field => { field.disabled = false; }); setBusy(button, false); } }
  });

  function resetBusinessGraph(closePanel = false) {
    const ticket = state.graphTicket;
    state.graphTicket = null;
    state.graphInspectionGeneration++;
    ticket?.controller.abort();
    $('#business-graph-result').replaceChildren();
    const button = $('#load-business-graph');
    button.disabled = false; button.textContent = 'Inspect reviewed results and links';
    button.removeAttribute('data-original-text');
    if (closePanel) $('.business-graph-inspector').open = false;
  }

  function graphInspectionCurrent(ticket) {
    clearClosedGraphPanel(graphPanelObserver.takeRecords());
    return state.graphTicket === ticket && !ticket.controller.signal.aborted &&
      state.session === ticket.session && state.csrf === ticket.csrf &&
      state.session?.csrf === ticket.sessionCsrf && state.session?.user?.id === ticket.userId &&
      state.session?.user?.role === ticket.sessionRole && state.data?.user?.role === ticket.role &&
      state.session?.user?.active !== false && !state.session?.user?.passwordChangeRequired &&
      state.data?.user?.active !== false && !state.data?.user?.passwordChangeRequired &&
      state.session?.workspace?.id === ticket.sessionWorkspaceId && state.data?.workspace?.id === ticket.workspaceId &&
      state.graphGeneration === ticket.generation && state.graphInspectionGeneration === ticket.inspectionGeneration &&
      state.view === 'overview' && ticket.panel.open && !$('#app-shell').classList.contains('hidden');
  }

  function renderRetainedRequests(value) {
    const object = item => item !== null && typeof item === 'object' && !Array.isArray(item);
    const labelFrom = (labels, item, fallback = 'Unavailable') => typeof item === 'string' && Object.hasOwn(labels, item) ? labels[item] : fallback;
    const row = (label, item) => '<div><span>' + escapeHtml(label) + '</span><b>' + escapeHtml(item) + '</b></div>';
    const revision = item => Number.isSafeInteger(item) && item > 0 ? String(item) : 'Unavailable';
    const navigation = '<nav class="history-navigation" aria-label="Saved history views"><button class="text-button" type="button" data-view-link="ai-team">Open saved goals in AI Team ↗</button>' +
      '<button class="text-button" type="button" data-view-link="approvals">Open Approval Centre ↗</button>' +
      '<button class="text-button" type="button" data-view-link="channels">Open Connection Centre ↗</button></nav>';
    const start = '<section class="retained-request-history" aria-labelledby="retained-request-history-title"><h3 id="retained-request-history-title">Saved goals and request history</h3>';
    const boundary = '<p class="muted tiny">These are mutable saved records. Recorded approval and request status do not authorize execution or retry, prove an action, or establish financial progress, goal attainment or causation. Current source and execution eligibility were not checked. No archives were read; full lifetime history is not claimed.</p>';
    if (!object(value) || value.schema !== 'runvara-retained-requests/v1' || !['available', 'incomplete'].includes(value.status) ||
      !Array.isArray(value.objectives) || !Array.isArray(value.records) || !object(value.counts) || !object(value.coverage) || !object(value.omitted)) {
      return start + '<p class="missing-inputs">Saved goal and request history is unavailable. This does not establish that no goals or requests exist.</p>' + boundary + navigation + '</section>';
    }
    // Only closed display labels and bounded numbers leave this DTO. Opaque graph
    // references are used solely to associate visible rows, never as record URLs.
    const goalStatuses = { active: 'Recorded active', paused: 'Recorded paused', disabled: 'Recorded disabled', completed: 'Recorded completed', cancelled: 'Recorded cancelled' };
    const effectiveStatuses = { active: 'Active in saved snapshot', paused: 'Paused in saved snapshot', disabled: 'Disabled in saved snapshot', completed: 'Completed in saved snapshot', cancelled: 'Cancelled in saved snapshot', scheduled: 'Scheduled in saved snapshot', expired: 'Expired in saved snapshot' };
    const requestStatuses = { pending_approval: 'Recorded pending approval', ready: 'Recorded ready', executing: 'Recorded executing', processing: 'Recorded processing', completed: 'Recorded completed', uncertain: 'Recorded uncertain', failed: 'Recorded failed', rejected: 'Recorded rejected' };
    const approvalStatuses = { pending: 'Recorded pending', approved: 'Recorded approved', rejected: 'Recorded rejected' };
    const origins = { owner_manual: 'Owner manual; originating goal not recorded', owner_objective_content: 'Recorded goal-associated content request', not_recorded: 'Origin not recorded', invalid: 'Recorded origin could not be validated' };
    const comparisons = { matches_retained_definition: 'Matches retained definition; source freshness not checked', saved_revision_changed: 'Saved revision changed; recorded association preserved', saved_definition_changed: 'Saved definition changed; recorded association preserved', unavailable: 'Saved definition comparison unavailable' };
    const reasons = {
      missing_reference: 'No reference was recorded', not_recorded: 'No originating goal was recorded',
      ambiguous_reference: 'More than one retained record matches the reference',
      target_index_incomplete: 'Target records are incomplete; a unique link cannot be confirmed',
      source_index_incomplete: 'Request records are incomplete; a unique request cannot be confirmed',
      source_identity_ambiguous: 'More than one retained request has this identity',
      unresolved_reference: 'Reference absent from the inspected retained snapshot; deletion is not established',
      archived_reference: 'The referenced record is archived', target_outside_projection: 'The known target was omitted by display limits',
      edge_limit: 'The recorded link was omitted by display limits', output_byte_limit: 'History details were omitted by the output size limit',
      invalid_record: 'The retained record is malformed or incomplete', invalid_proposal: 'The recorded proposal is inconsistent or malformed',
      unsupported_proposal: 'The recorded proposal format is unsupported', approval_binding_mismatch: 'The reciprocal approval binding does not match'
    };
    const objectives = value.objectives.slice(0, 50), records = value.records.slice(0, 50);
    const validGoal = item => object(item) && typeof item.nodeId === 'string' && item.nodeId.length > 0 && Object.hasOwn(goalStatuses, item.recordedStatus) && revision(item.revision) !== 'Unavailable';
    const validRequest = item => object(item) && typeof item.nodeId === 'string' && item.nodeId.length > 0 && Object.hasOwn(requestStatuses, item.recordedStatus) && Object.hasOwn(origins, item.origin) && object(item.approval) && object(item.objective);
    const validRelation = item => object(item) && (item.status === 'resolved' ? item.reason === null && typeof item.targetNodeId === 'string' && item.targetNodeId.length > 0 :
      item.status === 'unresolved' ? typeof item.reason === 'string' && Object.hasOwn(reasons, item.reason) : item.status === 'not_recorded' && item.reason === null);
    const goalMatches = relation => objectives.map((goal, goalIndex) => ({ goal, goalIndex })).filter(({ goal }) => validGoal(goal) && goal.nodeId === relation.targetNodeId);
    const validComparison = relation => revision(relation.recordedRevision) !== 'Unavailable' && revision(relation.savedRevision) !== 'Unavailable' &&
      typeof relation.revisionComparison === 'string' && Object.hasOwn(comparisons, relation.revisionComparison) &&
      (relation.revisionComparison !== 'matches_retained_definition' || relation.recordedRevision === relation.savedRevision);
    const invalidRows = objectives.filter(item => !validGoal(item)).length + records.filter(item => !validRequest(item)).length;
    const locallyLimited = value.objectives.length > 50 || value.records.length > 50;
    const countsValid = ['objectivesInspected', 'requestsInspected', 'projectedObjectives', 'projectedRequests', 'resolvedApprovalLinks', 'resolvedObjectiveLinks'].every(key => countLabel(value.counts[key]) !== 'Unknown') &&
      ['objectives', 'requests', 'relationships', 'mappings'].every(key => countLabel(value.omitted[key]) !== 'Unknown') &&
      value.counts.projectedObjectives === value.objectives.length && value.counts.projectedRequests === value.records.length &&
      value.counts.projectedObjectives <= value.counts.objectivesInspected && value.counts.projectedRequests <= value.counts.requestsInspected &&
      value.counts.resolvedApprovalLinks <= value.counts.projectedRequests && value.counts.resolvedObjectiveLinks <= value.counts.projectedRequests;
    const metadataValid = objectives.every(goal => validGoal(goal) && Object.hasOwn(effectiveStatuses, goal.effectiveStatus)) && records.every(record => validRequest(record) &&
      validRelation(record.approval) && validRelation(record.objective) &&
      (record.approval.status !== 'resolved' || Object.hasOwn(approvalStatuses, record.approval.recordedStatus)) &&
      (record.objective.status !== 'resolved' || record.origin === 'owner_objective_content' && validComparison(record.objective) &&
        goalMatches(record.objective).length === 1 && goalMatches(record.objective)[0].goal.revision === record.objective.savedRevision));
    const complete = value.status === 'available' && value.coverage.complete === true && countsValid && metadataValid && !invalidRows && !locallyLimited &&
      Object.values(value.omitted).every(count => count === 0);
    const overview = [
      ['Saved-history display coverage', complete ? 'Complete within this inspected display' : 'Incomplete within this inspected display'],
      ['Saved goals inspected / shown', countLabel(value.counts.objectivesInspected) + ' / ' + countLabel(objectives.length - objectives.filter(item => !validGoal(item)).length)],
      ['Requests inspected / shown', countLabel(value.counts.requestsInspected) + ' / ' + countLabel(records.length - records.filter(item => !validRequest(item)).length)],
      ['Saved goals omitted', countLabel(value.omitted.objectives)], ['Requests omitted', countLabel(value.omitted.requests)],
      ['Recorded relationships omitted', countLabel(value.omitted.relationships)], ['Unresolved history details omitted', countLabel(value.omitted.mappings)]
    ];
    const goalHtml = objectives.map((goal, index) => validGoal(goal) ? '<details class="evidence retained-goal"><summary>Saved goal ' + (index + 1) + ' · ' + escapeHtml(goalStatuses[goal.recordedStatus]) + '</summary><section class="status-list">' +
      row('Saved goal status', goalStatuses[goal.recordedStatus]) + row('Saved schedule status', labelFrom(effectiveStatuses, goal.effectiveStatus)) + row('Saved revision', revision(goal.revision)) + '</section></details>' : '').join('');
    const recordHtml = records.map((record, index) => {
      if (!validRequest(record)) return '';
      const approval = record.approval, objective = record.objective;
      const matches = goalMatches(objective);
      const objectiveResolved = record.origin === 'owner_objective_content' && objective.status === 'resolved' && validRelation(objective) && matches.length === 1;
      const approvalResolved = approval.status === 'resolved' && validRelation(approval) && Object.hasOwn(approvalStatuses, approval.recordedStatus);
      const comparisonAvailable = objectiveResolved && validComparison(objective) && matches[0].goal.revision === objective.savedRevision;
      return '<details class="evidence retained-request" id="graph-retained-request-' + index + '" tabindex="-1"><summary>Request ' + (index + 1) + ' · ' + escapeHtml(requestStatuses[record.recordedStatus]) + '</summary><section class="status-list">' +
        row('Request application status', requestStatuses[record.recordedStatus]) + row('Recorded origin', origins[record.origin]) +
        row('Recorded approval link', approvalResolved ? 'Linked to a retained approval' : approval.status === 'not_recorded' ? 'Approval reference not recorded' : 'Unresolved') +
        '<div id="graph-retained-approval-' + index + '" tabindex="-1"><span>Recorded approval status</span><b>' + escapeHtml(approvalResolved ? approvalStatuses[approval.recordedStatus] : 'Unavailable') + '</b></div>' +
        (approvalResolved ? '' : row('Approval link reason', approval.status === 'not_recorded' ? 'No approval reference was recorded' : labelFrom(reasons, approval.reason, 'The recorded approval link could not be established'))) +
        row('Recorded goal link', objectiveResolved ? 'Linked to saved goal ' + (matches[0].goalIndex + 1) : objective.status === 'not_recorded' && record.origin !== 'owner_objective_content' ? 'Originating goal not recorded' : 'Unresolved') +
        (objectiveResolved ? '' : row('Goal link reason', objective.status === 'not_recorded' && record.origin !== 'owner_objective_content' ? 'No originating goal was recorded' : labelFrom(reasons, objective.reason, 'The recorded goal link could not be established'))) +
        (record.origin === 'owner_objective_content' ? row('Recorded goal revision', revision(objective.recordedRevision)) + row('Currently saved revision', objectiveResolved ? revision(objective.savedRevision) : 'Unavailable') +
          row('Saved definition comparison', comparisonAvailable ? comparisons[objective.revisionComparison] : comparisons.unavailable) : '') +
        '</section></details>';
    }).join('');
    return start + '<p class="muted">Recorded relationships in this saved snapshot. Goal and request numbers identify rows in this display only.</p><section class="status-list">' + overview.map(([label, item]) => row(label, item)).join('') + '</section>' +
      (invalidRows || locallyLimited ? '<p class="missing-inputs">Some returned history rows were malformed or exceeded the display limit and were withheld.</p>' : '') +
      (!metadataValid || !countsValid ? '<p class="missing-inputs">Some returned history metadata is incomplete. Relationships and saved definition comparisons may be unavailable.</p>' : '') +
      goalHtml + recordHtml + (!goalHtml || !recordHtml ? '<p class="muted tiny">An empty or omitted list does not establish that no goals or requests exist.</p>' : '') + boundary + navigation + '</section>';
  }

  function renderBusinessGraph(graph) {
    graph = graph && typeof graph === 'object' && !Array.isArray(graph) ? graph : {};
    const summary = graph.summary || {}, coverage = graph.coverage || {};
    const rows = [
      ['Recorded entities inspected', countLabel(summary.nodes)],
      ['Recorded links inspected', countLabel(summary.edges)],
      ['Missing or ambiguous mappings', countLabel(summary.unknownMappings)],
      ['Relationship display coverage', coverage.complete === true ? 'Complete within this display' : 'Incomplete within this display'],
      ...Object.entries(summary.nodesByType || {}).map(([kind,count]) => [statusLabel(kind), countLabel(count)]),
      ...Object.entries(summary.unknownByReason || {}).slice(0,12).map(([reason,count]) => [statusLabel(reason), countLabel(count)])
    ];
    const row = (label, value) => '<div><span>' + escapeHtml(label) + '</span><b>' + escapeHtml(value) + '</b></div>';
    const reviewed = graph.reviewedOutcomes, counts = reviewed?.counts || {}, completeness = reviewed?.coverage || {};
    const available = reviewed?.status === 'available' || reviewed?.status === 'incomplete';
    const records = available && Array.isArray(reviewed.records) ? reviewed.records : [];
    const groups = available && Array.isArray(reviewed.groups) ? reviewed.groups : [];
    const currentCount = key => available ? countLabel(counts[key]) : 'Unknown';
    const outcomeRows = [
      ['Current reviewed results', available ? (reviewed.status === 'available' ? 'Snapshot available' : 'Incomplete snapshot') : 'Unavailable'],
      ['Current reviewed results loaded', currentCount('currentHeadsRead')],
      ['Published results loaded', currentCount('publishedHeads')],
      ['Withdrawn results loaded', currentCount('withdrawnHeads')],
      ['Reviewed results shown', countLabel(counts.projectedRecords)],
      ['Recorded experiment links found', countLabel(counts.resolvedExperimentLinks)],
      ['Unresolved experiment links', countLabel(counts.unresolvedExperimentLinks)],
      ['Recorded request links found', countLabel(counts.resolvedRequestLinks)],
      ['Unresolved recorded request links', countLabel(counts.unresolvedRequestLinks)],
      ['Recorded approval links found', countLabel(counts.resolvedApprovalLinks)],
      ['Unresolved recorded approval links', countLabel(counts.unresolvedApprovalLinks)],
      ['Measurements in descriptive groups', currentCount('qualifiedMeasurements')],
      ['Reviewed-result read coverage', available && completeness.publicationHeadsComplete === true ? 'Complete current-result read' : 'Incomplete or unavailable'],
      ['Available relationship records', completeness.retainedGraphComplete === true ? 'Complete within retained records' : 'Incomplete or unavailable'],
      ['Shown results, links and groups', available && completeness.projectionComplete === true ? 'Complete within this display' : 'Incomplete or unavailable'],
      ['Reviewed results omitted', countLabel(reviewed?.omitted?.records)],
      ['Reviewed-result links omitted', countLabel(reviewed?.omitted?.relationships)],
      ['Measurement groups omitted', countLabel(reviewed?.omitted?.groups)],
      ['Unresolved link details omitted', countLabel(reviewed?.omitted?.mappings)],
      ['Visible measurement groups', countLabel(groups.length)]
    ];
    const snapshots = reviewed?.snapshots || {};
    const snapshotRows = [
      ['Workspace revision reference', snapshots.workspace?.revisionRef || 'Unavailable'],
      ['Workspace read completed', snapshots.workspace?.readCompletedAt || 'Unavailable'],
      ['Outcome snapshot reference', snapshots.outcomes?.id || 'Unavailable'],
      ['Outcome read completed', snapshots.outcomes?.readCompletedAt || 'Unavailable']
    ];
    const linkReasons = {
      missing_reference: 'No experiment reference was recorded',
      ambiguous_reference: 'More than one experiment matches the reference',
      target_index_incomplete: 'Available experiment records are incomplete; a unique link cannot be confirmed',
      unresolved_reference: 'Experiment absent from retained records; deletion is not established',
      archived_reference: 'The referenced experiment is archived',
      target_outside_projection: 'The known experiment was omitted by display limits',
      edge_limit: 'The link was omitted by display limits'
    };
    const methodLabels = { reconciled_manual: 'Reconciled records', before_after: 'Before and after', holdout: 'Holdout comparison' };
    const amountLabels = { measured_sum: 'Measured sum for this currency and window', standalone_observations: 'Separate observations; no combined amount', incomplete_publication_read: 'Results incomplete; amount unavailable' };
    const labelFrom = (labels, value, fallback) => typeof value === 'string' && Object.hasOwn(labels, value) ? labels[value] : fallback;
    const referenceReasons = {
      invalid_reference_pair: 'The published request and approval references are incomplete or inconsistent',
      unresolved_reference: 'Reference absent from the inspected retained snapshot; deletion is not established',
      ambiguous_reference: 'More than one retained record matches the primary identity',
      archived_reference: 'The referenced record is explicitly archived',
      invalid_record: 'The retained record is malformed or incomplete',
      target_index_incomplete: 'Target records are incomplete; a unique primary identity cannot be confirmed',
      source_identity_ambiguous: 'More than one retained request has this identity',
      source_index_incomplete: 'Request records are incomplete; a unique request cannot be confirmed',
      unsupported_proposal: 'The retained proposal format is unsupported',
      invalid_proposal: 'The retained proposal is inconsistent or malformed',
      approval_binding_mismatch: 'The current reciprocal request and approval binding has changed or does not match',
      paired_request_unresolved: 'The paired request reference could not be resolved',
      paired_approval_unresolved: 'The paired approval reference could not be resolved',
      target_outside_projection: 'The known target was omitted by display limits',
      edge_limit: 'The recorded link was omitted by display limits',
      output_byte_limit: 'The recorded link was omitted by the output size limit'
    };
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const history = graph.retainedRequests;
    const historyAvailable = object(history) && history.schema === 'runvara-retained-requests/v1' && ['available', 'incomplete'].includes(history.status) &&
      Array.isArray(history.records) && Array.isArray(history.objectives) && object(history.counts) && object(history.coverage) && object(history.omitted);
    const requests = historyAvailable ? history.records.slice(0, 50) : [];
    const validRequest = record => object(record) && typeof record.nodeId === 'string' && record.nodeId.length > 0 &&
      ['pending_approval', 'ready', 'executing', 'processing', 'completed', 'uncertain', 'failed', 'rejected'].includes(record.recordedStatus) &&
      ['owner_manual', 'owner_objective_content', 'not_recorded', 'invalid'].includes(record.origin) && object(record.approval) && object(record.objective);
    const validReference = relation => object(relation) && relation.snapshotContentCompared === false &&
      (relation.status === 'resolved' ? relation.reason === null && typeof relation.targetNodeId === 'string' && relation.targetNodeId.length > 0 :
        relation.status === 'unresolved' ? Object.hasOwn(referenceReasons, relation.reason) && !Object.hasOwn(relation, 'targetNodeId') :
          relation.status === 'not_recorded' && relation.reason === null && !Object.hasOwn(relation, 'targetNodeId'));
    const recordedReferences = record => {
      const request = record.requestRelationship, approval = record.approvalRelationship;
      const matches = requests.map((item, index) => ({ item, index })).filter(({ item }) => object(item) && item.nodeId === request?.targetNodeId);
      const retained = matches[0]?.item;
      // Associate only already-rendered rows. IDs in href/data attributes are
      // local display indices, never returned record IDs or execution URLs.
      const displayedPair = history?.records?.length <= 50 && validReference(request) && validReference(approval) && request.status === 'resolved' && approval.status === 'resolved' &&
        matches.length === 1 && validRequest(retained) && retained.approval.status === 'resolved' && retained.approval.reason === null &&
        ['pending', 'approved', 'rejected'].includes(retained.approval.recordedStatus) && retained.approval.targetNodeId === approval.targetNodeId &&
        requests.filter(item => object(item) && item.approval?.targetNodeId === approval.targetNodeId).length === 1;
      const referenceRow = (label, relation, kind) => {
        if (!validReference(relation)) return row(label, 'Unavailable; a valid recorded reference was not returned');
        if (relation.status === 'not_recorded') return row(label, 'Not recorded in this publication');
        if (relation.status === 'unresolved') return row(label, 'Unresolved') + row(label + ' reason', referenceReasons[relation.reason]);
        if (!displayedPair) return row(label, 'Unavailable in this display; a unique reciprocal pair could not be shown');
        const target = 'graph-retained-' + kind + '-' + matches[0].index;
        return row(label, 'Resolved primary identity; current reciprocal binding recorded') + '<div><span>Inspect recorded ' + kind + '</span><b><a href="#' + target + '" data-graph-record-link="' + target + '">Show ' +
          (kind === 'request' ? 'retained request ' : 'retained approval for request ') + (matches[0].index + 1) + '</a></b></div>';
      };
      return referenceRow('Published request reference', request, 'request') + referenceRow('Published approval reference', approval, 'approval') +
        row('Snapshot content compared', validReference(request) && validReference(approval) ? 'False; current mutable content was not compared' : 'Unavailable; no content match is established');
    };
    const recordHtml = records.map((record, index) => {
      const relation = record.relationship || {};
      return '<details class="evidence reviewed-result"><summary>Reviewed result ' + (index + 1) + ' · ' +
        (record.status === 'published' ? 'Published' : record.status === 'withdrawn' ? 'Withdrawn' : 'Unknown status') + '</summary><section class="status-list">' +
        row('Immutable version reference', record.versionRef || 'Unavailable') +
        row('Measurement evidence', record.measurementComplete === true ? 'Complete owner-attested measurement' : 'Incomplete or withdrawn measurement') +
        row('Descriptive group inclusion', record.qualifiedGroupIncluded === true ? 'Included in a descriptive measurement group' : 'Excluded or withheld from groups') +
        row('Recorded experiment link', relation.status === 'resolved' ? 'Linked to a retained experiment' : 'Unresolved') +
        (relation.status === 'resolved' ? '' : row('Unresolved reason', labelFrom(linkReasons, relation.reason, 'The experiment link could not be established'))) + recordedReferences(record) + '</section></details>';
    }).join('');
    const groupHtml = groups.map((group, index) => '<details class="evidence" open><summary>Scoped measurement group ' + (index + 1) + '</summary><section class="status-list">' +
      row('Metric', group.metric === 'incrementalContribution' ? 'Incremental contribution' : 'Unknown') + row('Currency', group.currency || 'Unknown') +
      row('Observation window starts', group.window?.startsAt || 'Unknown') + row('Observation window ends (exclusive)', group.window?.endsAt || 'Unknown') +
      row('Method', labelFrom(methodLabels, group.method, 'Unknown')) + row('Definition', group.definitionVersion || 'Unknown') +
      row('Measurements in this group', countLabel(group.measuredCount)) +
      row('Exact scoped amount', completeness.publicationHeadsComplete === true && group.amountStatus === 'measured_sum' ? recordedDecimal(group.amount) : 'Withheld') +
      row('Amount status', labelFrom(amountLabels, group.amountStatus, 'Amount unavailable')) +
      row('Known zero / negative / positive observations', countLabel(group.knownZeroCount) + ' / ' + countLabel(group.negativeCount) + ' / ' + countLabel(group.positiveCount)) +
      '</section></details>').join('');
    return rows.map(([label,value]) => row(label,value)).join('') +
      '<p class="muted tiny">Read-only links to existing records. A shared SKU is not proof of the same product, and a campaign link is not proof of revenue attribution.</p>' +
      renderRetainedRequests(graph.retainedRequests) +
      outcomeRows.map(([label,value]) => row(label,value)).join('') +
      (!available ? '<p class="missing-inputs">Proof of current reviewed results is unavailable. This does not establish zero outcomes.</p>' + row('Outcome read reason', statusLabel(reviewed?.unavailableReason || 'publication_snapshot_unavailable')) : '') +
      '<p class="muted tiny">Current reviewed results only; corrections select the current version. Withdrawn results contribute no measured totals. A resolved experiment relationship does not imply inclusion in a descriptive measurement group.</p>' +
      '<p class="muted tiny">Published request and approval references describe recorded primary identities in independent snapshots. They do not prove current mutable content equals the published snapshot. The published source digest is not the current input digest. These links establish no immutable execution receipt, current execution authority, causal or commercial proof, qualified learning, or goal progress.</p>' +
      recordHtml + groupHtml +
      (!groups.length ? '<p class="muted tiny">No measurement groups displayed. An empty list or zero shown reviewed results does not establish zero tenant outcomes.</p>' : '') +
      '<p class="muted tiny">Amounts describe only each exact currency and observation window. No overall amount, ROI, forecast, learning prior, causal attribution or execution authority is established. Full lifetime coverage is not claimed.</p>' +
      '<details class="evidence"><summary>Independent snapshot details</summary><section class="status-list">' + snapshotRows.map(([label,value]) => row(label,value)).join('') + '</section>' +
      '<p class="muted tiny">Workspace and outcome reads are independent, not atomic or synchronized. Read times are not commit times or freshness guarantees. Publications can change after either read; select Inspect reviewed results and links for another snapshot.</p></details>' +
      '<button class="text-button" type="button" data-view-link="revenue-engine">Open Business results in Revenue Engine ↗</button>';
  }

  const graphPanel = $('.business-graph-inspector');
  const graphRecordLinks = new WeakMap(), graphRecordTargets = new WeakMap();
  function bindBusinessGraphLinks(graph, ticket) {
    const root = $('#business-graph-result');
    root.querySelectorAll('.reviewed-result').forEach((element, index) => {
      const record = graph.reviewedOutcomes?.records?.[index];
      element.querySelectorAll('[data-graph-record-link]').forEach(link => {
        const match = /^graph-retained-(request|approval)-(\d{1,2})$/.exec(link.dataset.graphRecordLink);
        if (!match) return;
        const retained = graph.retainedRequests?.records?.[Number(match[2])];
        const expectedNodeId = record?.[match[1] + 'Relationship']?.targetNodeId;
        const targetNodeId = match[1] === 'request' ? retained?.nodeId : retained?.approval?.targetNodeId;
        const target = document.getElementById(link.dataset.graphRecordLink);
        if (!expectedNodeId || targetNodeId !== expectedNodeId || !root.contains(target)) return;
        const binding = { target, nodeId: expectedNodeId, generation: ticket.inspectionGeneration };
        graphRecordTargets.set(target, binding); graphRecordLinks.set(link, binding);
      });
    });
  }
  window.addEventListener('popstate', () => resetBusinessGraph(true));
  $('#business-graph-result').addEventListener('click', event => {
    const link = event.target.closest?.('[data-graph-record-link]');
    if (!link) return;
    event.preventDefault();
    const name = link.dataset.graphRecordLink;
    const binding = graphRecordLinks.get(link);
    if (!binding || binding.generation !== state.graphInspectionGeneration || !$('#business-graph-result').contains(link) ||
      !/^graph-retained-(request|approval)-\d{1,2}$/.test(name) || !graphPanel.open || state.view !== 'overview' || $('#app-shell').classList.contains('hidden')) return;
    const target = document.getElementById(name);
    const retained = target && graphRecordTargets.get(target);
    if (!retained || binding.target !== target || retained.nodeId !== binding.nodeId || retained.generation !== binding.generation || !$('#business-graph-result').contains(target)) return;
    target.closest('.retained-request').open = true;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
  });
  function clearClosedGraphPanel(changes) {
    // The native toggle event can coalesce a close and reopen in one turn.
    // Observe the actual open-attribute transitions so an old ticket cannot revive.
    if (changes.some((change, index) => change.oldValue !== null &&
      (index + 1 < changes.length ? changes[index + 1].oldValue : graphPanel.getAttribute('open')) === null)) resetBusinessGraph();
  }
  const graphPanelObserver = new MutationObserver(clearClosedGraphPanel);
  graphPanelObserver.observe(graphPanel, { attributes: true, attributeFilter: ['open'], attributeOldValue: true });
  graphPanel.querySelector('summary').addEventListener('click', () => { if (graphPanel.open) resetBusinessGraph(); });
  graphPanel.addEventListener('toggle', () => { if (!graphPanel.open) resetBusinessGraph(); });
  $('#open-reviewed-results').addEventListener('click', () => {
    graphPanel.open = true;
    $('#load-business-graph').focus();
  });
  $('#load-business-graph').addEventListener('click', async event => {
    clearClosedGraphPanel(graphPanelObserver.takeRecords());
    const button = event.currentTarget;
    if (state.graphTicket || button.disabled || !state.session || !state.data?.workspace?.id || state.view !== 'overview' || !graphPanel.open) return;
    const ticket = { controller: new AbortController(), session: state.session, csrf: state.csrf, sessionCsrf: state.session.csrf,
      userId: state.session.user?.id, sessionRole: state.session.user?.role, role: state.data.user?.role, sessionWorkspaceId: state.session.workspace?.id, workspaceId: state.data.workspace.id,
      generation: state.graphGeneration, inspectionGeneration: ++state.graphInspectionGeneration, panel: graphPanel };
    state.graphTicket = ticket;
    const target = $('#business-graph-result');
    setBusy(button, true, 'Inspecting…');
    target.textContent = 'Reading current reviewed results and retained relationships…';
    try {
      const graph = await request('/api/business-graph?outcomes=current&detail=true', { signal: ticket.controller.signal, isCurrent: () => graphInspectionCurrent(ticket) });
      if (!graphInspectionCurrent(ticket)) return;
      target.innerHTML = renderBusinessGraph(graph);
      bindBusinessGraphLinks(graph, ticket);
    } catch(error) {
      if (graphInspectionCurrent(ticket)) target.textContent = 'Could not inspect relationships: ' + error.message + ' Select Inspect reviewed results and links to try again.';
    } finally {
      if (graphInspectionCurrent(ticket)) { state.graphTicket = null; setBusy(button, false); }
    }
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
      form.reset(); await loadBootstrap({migrate:false}); setView('revenue-engine'); showMessage('Legacy measurement recorded. It remains unqualified for business results and comparable learning.');
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
      form.reset(); await loadBootstrap({migrate:false}); setView('revenue-engine'); showMessage('Legacy review recorded. Use Business results to prepare and publish a qualified measurement.');
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
  $('#logout').addEventListener('click', async () => { window.RunvaraConnections?.interruptContent('Signing out', true); resetObjectiveEditing(true); resetBusinessGraph(true); window.RunvaraOutcomes?.reset(); window.RunvaraActivity?.reset(); pauseObjectiveReview('Signing out. Status checks paused.'); resetAutomationHistory(); try { await request('/api/auth/logout', { method: 'POST', body: '{}' }); } finally { state.session = null; state.data = null; state.csrf = ''; showLogin(); } });
  $('#show-password-change').addEventListener('click', () => $('#account-password-form').classList.toggle('hidden'));
  $('#account-password-form').addEventListener('submit', async event => {
    window.RunvaraConnections?.interruptContent('Password change started');
    interruptObjectiveContent('Password change started');
    resetObjectiveEditing(true, true);
    resetBusinessGraph();
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); const error = form.querySelector('.form-error'); error.textContent = ''; setBusy(button, true, 'Updating…');
    try { const payload = await request('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: form.currentPassword.value, newPassword: form.newPassword.value }) }); window.RunvaraConnections?.interruptContent('Password changed', true); resetObjectiveEditing(true); resetBusinessGraph(); state.csrf = payload.csrf; form.reset(); form.classList.add('hidden'); showMessage('Password updated and older sessions revoked.'); }
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

  window.RunvaraOutcomes?.init({ request, getContext: () => ({ session: state.session, workspaceId: state.data?.workspace?.id, userId: state.session?.user?.id, role: state.data?.user?.role, view: state.view, experiments: state.data?.revenueEngine?.experiments || [] }) });
  window.RunvaraActivity?.init({ request, getContext: () => ({ session:state.session, workspaceId:state.data?.workspace?.id, role:state.data?.user?.role, view:state.view }) });
  window.RunvaraControl.init({ request, reload: loadBootstrap, notify: showMessage, setView, money, date, escapeHtml });
  window.RunvaraConnections?.init({ request, reload: loadBootstrap, notify: showMessage, setView, date, escapeHtml,
    getContentContext: () => ({ session:state.session, csrf:state.csrf, sessionCsrf:state.session?.csrf, generation:state.graphGeneration, bootstrap:state.data, view:state.view,
      userId:state.session?.user?.id, dataUserId:state.data?.user?.id, workspaceId:state.session?.workspace?.id, dataWorkspaceId:state.data?.workspace?.id,
      role:state.session?.user?.role, dataRole:state.data?.user?.role, active:state.session?.user?.active, dataActive:state.data?.user?.active,
      passwordChangeRequired:state.session?.user?.passwordChangeRequired, dataPasswordChangeRequired:state.data?.user?.passwordChangeRequired }) });

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
