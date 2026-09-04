(() => {
  'use strict';

  const TOKEN_KEY = 'packsmart-saas-session-v2';
  const ECONOMICS_KEY = 'packsmart-saas-economics-v1';
  const AUTOMATIONS_KEY = 'packsmart-saas-automations-v1';
  let health = null;
  let bootstrap = null;

  const account = document.querySelector('#cloud-account');
  const approvalsPanel = document.querySelector('#cloud-approvals');
  const badge = document.querySelector('.live-badge');

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function setToken(token) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  }

  function readLocal(key, fallback = {}) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const token = getToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...options, headers, cache: 'no-store' });
    let data = {};
    try { data = await response.json(); } catch {}
    if (response.status === 401) setToken('');
    if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
    return data;
  }

  async function probeHealth() {
    try {
      health = await request('/api/health');
      badge.textContent = health.storage === 'supabase' ? 'Cloud' : 'Server';
      badge.classList.add('cloud-ready');
      return true;
    } catch {
      health = null;
      badge.textContent = 'Pilot local';
      return false;
    }
  }

  async function loadBootstrap() {
    if (!getToken()) return null;
    try {
      bootstrap = await request('/api/bootstrap');
      return bootstrap;
    } catch (error) {
      if (error.status === 401) bootstrap = null;
      return null;
    }
  }

  async function migrateLocalPilotData() {
    const localEconomics = readLocal(ECONOMICS_KEY, {});
    for (const [sku, economics] of Object.entries(localEconomics)) {
      if (!economics || !Object.values(economics).some(value => value !== '' && value !== null && value !== undefined)) continue;
      await request('/api/economics', {
        method: 'PUT',
        body: JSON.stringify({ sku, economics })
      });
    }

    const localAutomations = readLocal(AUTOMATIONS_KEY, {});
    for (const [id, enabled] of Object.entries(localAutomations)) {
      try {
        await request('/api/automations', {
          method: 'PUT',
          body: JSON.stringify({ id, enabled: Boolean(enabled) })
        });
      } catch (error) {
        if (error.status !== 400) throw error;
      }
    }
  }

  async function syncFromCloud({ reload = false } = {}) {
    const data = await request('/api/bootstrap');
    localStorage.setItem(ECONOMICS_KEY, JSON.stringify(data.economics || {}));
    localStorage.setItem(AUTOMATIONS_KEY, JSON.stringify(data.automations || {}));
    bootstrap = data;
    if (reload) location.reload();
    return data;
  }

  async function login(email, password) {
    const data = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    setToken(data.token);
    await migrateLocalPilotData();
    await syncFromCloud({ reload: true });
  }

  async function billingStatus() {
    if (!getToken()) return null;
    try { return await request('/api/billing'); } catch { return null; }
  }

  async function renderAccount() {
    if (!account) return;
    if (!health) {
      account.innerHTML = `
        <div class="cloud-box">
          <div><p class="eyebrow">PHASE 2 BACKEND</p><h3>Local pilot mode</h3><p class="muted">This host is serving the Phase 1 browser cockpit without the new SaaS server. Nothing is broken; cloud sync activates when the Node backend is deployed.</p></div>
          <span class="tag warn">Not active here</span>
        </div>`;
      return;
    }

    const data = bootstrap || await loadBootstrap();
    const billing = data ? await billingStatus() : null;
    const storageLabel = health.storage === 'supabase' ? 'Supabase cloud' : 'Local server store';
    const storageClass = health.storage === 'supabase' ? 'good' : 'warn';

    if (!data) {
      account.innerHTML = `
        <div class="cloud-box cloud-stack">
          <div class="cloud-head">
            <div><p class="eyebrow">PHASE 2 BACKEND</p><h3>Packsmart cloud account</h3></div>
            <span class="tag ${storageClass}">${escapeHtml(storageLabel)}</span>
          </div>
          <div class="status-grid">
            <span>Secure login <b>${health.authConfigured ? 'Ready' : 'Needs server env'}</b></span>
            <span>Credential encryption <b>${health.credentialEncryptionConfigured ? 'Ready' : 'Needs server env'}</b></span>
            <span>Stripe billing <b>${health.billingConfigured ? 'Ready' : 'Dormant'}</b></span>
            <span>Stripe webhook <b>${health.billingWebhookConfigured ? 'Ready' : 'Dormant'}</b></span>
          </div>
          ${health.authConfigured ? `
          <form id="cloud-login" class="cloud-login">
            <input name="email" type="email" autocomplete="username" value="sales@packsmartsolutions.com" aria-label="Email" required />
            <input name="password" type="password" autocomplete="current-password" placeholder="Password" aria-label="Password" required />
            <button class="primary" type="submit">Sign in & migrate pilot data</button>
            <span id="cloud-login-error" class="form-error" role="alert"></span>
          </form>` : '<p class="muted">Set the server environment secrets to enable Packsmart owner login. No secrets belong in GitHub.</p>'}
        </div>`;

      const form = document.querySelector('#cloud-login');
      if (form) {
        form.addEventListener('submit', async event => {
          event.preventDefault();
          const button = form.querySelector('button');
          const error = document.querySelector('#cloud-login-error');
          button.disabled = true;
          button.textContent = 'Signing in…';
          error.textContent = '';
          try {
            await login(form.email.value, form.password.value);
          } catch (loginError) {
            error.textContent = loginError.message;
            button.disabled = false;
            button.textContent = 'Sign in & migrate pilot data';
          }
        });
      }
      return;
    }

    const pending = (data.approvals || []).filter(item => item.status === 'pending').length;
    account.innerHTML = `
      <div class="cloud-box cloud-stack">
        <div class="cloud-head">
          <div><p class="eyebrow">PHASE 2 BACKEND</p><h3>${escapeHtml(data.workspace?.name || 'Packsmart workspace')}</h3><p class="muted">Signed in as ${escapeHtml(data.user?.email || 'owner')} · ${escapeHtml(data.user?.role || 'member')}</p></div>
          <span class="tag good">Authenticated</span>
        </div>
        <div class="status-grid">
          <span>Persistence <b>${escapeHtml(storageLabel)}</b></span>
          <span>Pending approvals <b>${pending}</b></span>
          <span>Plan <b>${escapeHtml(billing?.subscription?.plan || data.subscription?.plan || 'customer-zero')}</b></span>
          <span>Billing <b>${billing?.checkoutConfigured ? 'Checkout ready' : 'Not configured'}</b></span>
        </div>
        <div class="cloud-actions">
          <button id="sync-cloud" class="secondary" type="button">Sync from cloud</button>
          <button id="sign-out-cloud" class="secondary" type="button">Sign out</button>
        </div>
        <p class="muted tiny">Cloud sync overwrites this device's local economics and automation settings with the authenticated workspace copy.</p>
      </div>`;

    document.querySelector('#sync-cloud')?.addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      event.currentTarget.textContent = 'Syncing…';
      try { await syncFromCloud({ reload: true }); }
      catch (error) {
        event.currentTarget.disabled = false;
        event.currentTarget.textContent = error.message;
      }
    });
    document.querySelector('#sign-out-cloud')?.addEventListener('click', () => {
      setToken('');
      location.reload();
    });
  }

  async function renderApprovals() {
    if (!approvalsPanel) return;
    if (!health || !getToken()) {
      approvalsPanel.innerHTML = '';
      return;
    }
    try {
      const data = await request('/api/approvals');
      const pending = (data.approvals || []).filter(item => item.status === 'pending');
      approvalsPanel.innerHTML = `
        <div class="cloud-box cloud-stack">
          <div class="cloud-head"><div><p class="eyebrow">LIVE APPROVAL QUEUE</p><h3>${pending.length ? `${pending.length} awaiting decision` : 'Nothing waiting'}</h3></div><span class="tag ${pending.length ? 'warn' : 'good'}">${pending.length ? 'Action required' : 'Clear'}</span></div>
          <div class="live-approval-list">
            ${pending.length ? pending.map(item => `
              <div class="live-approval">
                <div><b>${escapeHtml(item.type.replaceAll('_', ' '))}</b><small>Requested ${escapeHtml(new Date(item.createdAt).toLocaleString())}</small></div>
                <div class="approval-actions">
                  <button class="secondary" data-approval-id="${escapeHtml(item.id)}" data-decision="rejected">Reject</button>
                  <button class="primary" data-approval-id="${escapeHtml(item.id)}" data-decision="approved">Approve</button>
                </div>
              </div>`).join('') : '<p class="muted">Risk-sensitive actions will appear here instead of executing automatically.</p>'}
          </div>
          <p class="muted tiny">Approval records the decision only. External execution remains disabled until a specific tested executor is connected for that action type.</p>
        </div>`;

      approvalsPanel.querySelectorAll('[data-approval-id]').forEach(button => {
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await request(`/api/approvals/${encodeURIComponent(button.dataset.approvalId)}/decision`, {
              method: 'POST',
              body: JSON.stringify({ decision: button.dataset.decision })
            });
            await renderApprovals();
            bootstrap = await request('/api/bootstrap');
            await renderAccount();
          } catch (error) {
            button.disabled = false;
            button.textContent = error.message;
          }
        });
      });
    } catch {
      approvalsPanel.innerHTML = '';
    }
  }

  async function mirrorEconomics(row) {
    if (!getToken()) return;
    const sku = row?.dataset?.sku;
    if (!sku) return;
    const economics = {};
    row.querySelectorAll('.econ-input').forEach(input => { economics[input.dataset.field] = input.value; });
    try {
      await request('/api/economics', { method: 'PUT', body: JSON.stringify({ sku, economics }) });
    } catch (error) {
      console.warn('Packsmart cloud economics sync failed:', error.message);
    }
  }

  async function mirrorAutomation(id) {
    if (!getToken() || !id) return;
    await new Promise(resolve => setTimeout(resolve, 0));
    const current = document.querySelector(`[data-automation="${CSS.escape(id)}"]`);
    if (!current) return;
    try {
      await request('/api/automations', {
        method: 'PUT',
        body: JSON.stringify({ id, enabled: current.classList.contains('on') })
      });
    } catch (error) {
      console.warn('Packsmart cloud automation sync failed:', error.message);
    }
  }

  document.addEventListener('change', event => {
    if (event.target.matches('.econ-input')) mirrorEconomics(event.target.closest('tr'));
  });

  document.addEventListener('click', event => {
    const automation = event.target.closest('[data-automation]');
    if (automation) mirrorAutomation(automation.dataset.automation);
  });

  (async () => {
    await probeHealth();
    if (health && getToken()) await loadBootstrap();
    await renderAccount();
    await renderApprovals();
  })();
})();
