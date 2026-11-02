import assert from 'node:assert/strict';
import { maintenanceFixture, ownerState, PASSWORD } from './maintenance-login-fixture.mjs';

// Real login POST, issued browser cookie and current server session capability.
// Every account, database transport and failure injection is synthetic/localhost.
export async function verifyFreshOwnerLogin(browser) {
  let checks = 0, externalRequests = 0, providerCalls = 0;
  const cases = [], errors = [];
  const check = (value, message) => { assert.ok(value, message); checks++; };
  const scenarios = [
    { name: 'eligible owner mobile', width: 390, view: 'app' },
    { name: 'eligible owner desktop', width: 1200, view: 'app' },
    { name: 'workspace disabled', workspace: false, view: 'maintenance' },
    { name: 'nonowner login denied', role: 'admin', view: 'login', denied: true },
    { name: 'other tenant owner', tenant: 'beta', view: 'maintenance' },
    { name: 'password replacement required', password: true, view: 'maintenance' },
    { name: 'owner revoked before session check', fault: 'role', view: 'maintenance' },
    { name: 'session revoked before check', fault: 'revoked', view: 'login' },
    { name: 'issued cookie expired before check', fault: 'expired', view: 'login' },
    { name: 'session read unavailable', fault: 'session-read', view: 'login' },
    { name: 'bootstrap unavailable', fault: 'bootstrap', view: 'maintenance' }
  ];
  for (const scenario of scenarios) {
    const state = ownerState(scenario.tenant || 'packsmart-solutions');
    state.workspace.name = 'Synthetic fresh-login workspace';
    if (scenario.role) state.users[0].role = scenario.role;
    if (scenario.password) state.users[0].passwordChangeRequired = true;
    const before = structuredClone(state), requests = [], loginReceipts = [], sessionReceipts = [];
    const f = await maintenanceFixture({ states: [state], env: {
      NODE_ENV: 'test', APP_PUBLIC_URL: 'http://127.0.0.1',
      RUNVARA_QUIET_OWNER_WORKSPACE: scenario.workspace === false ? 'disabled/v1' : 'enabled/v1'
    }, providerFetch: async () => { providerCalls++; assert.fail('No provider call during login'); } });
    const context = await browser.newContext({ viewport: { width: scenario.width || 1200, height: 900 } });
    context.setDefaultTimeout(10000);
    let loggedIn = false;
    try {
      await context.addInitScript(() => {
        localStorage.setItem('packsmart-saas-economics-v1', '{"legacy-cost":"2.50"}');
        localStorage.setItem('packsmart-saas-automations-v1', '{"legacy-rule":false}');
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push({ case: scenario.name, message: error.message }));
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== f.base) { externalRequests++; return route.abort(); }
        requests.push({ method: request.method(), path: url.pathname });
        if (url.pathname === '/api/auth/login') {
          const response = await route.fetch(), receipt = await response.json();
          loginReceipts.push({ status: response.status(), maintenance: receipt.maintenance, ownerWorkspace: receipt.ownerWorkspace });
          loggedIn = response.status() === 200;
          if (loggedIn && scenario.fault === 'role') f.fake.states.get(state.workspace.id).users[0].role = 'admin';
          if (loggedIn && scenario.fault === 'revoked') f.fake.states.get(state.workspace.id).users[0].sessionVersion++;
          // Expire the actual issued cookie before the browser can use it; never seed a session.
          if (loggedIn && scenario.fault === 'expired') {
            const headers = response.headers();
            headers['set-cookie'] = headers['set-cookie'].replace(/Max-Age=\d+/i, 'Max-Age=0');
            return route.fulfill({ response, headers });
          }
          return route.fulfill({ response });
        }
        if (url.pathname === '/api/auth/session') {
          if (loggedIn && scenario.fault === 'session-read') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic identity read unavailable"}' });
          const response = await route.fetch(), receipt = await response.json();
          sessionReceipts.push({ status: response.status(), ownerWorkspace: receipt.ownerWorkspace, workspaceId: receipt.workspace?.id });
          return route.fulfill({ response });
        }
        if (url.pathname === '/api/bootstrap' && scenario.fault === 'bootstrap') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic bootstrap read unavailable"}' });
        return route.continue();
      });
      await page.goto(f.base, { waitUntil: 'networkidle' });
      await page.locator('#login-screen').waitFor({ state: 'visible' });
      check(!await page.locator('#app-shell').isVisible(), scenario.name + ': anonymous view gated');
      const initialReads = requests.filter(r => r.path === '/api/auth/session').length;
      await page.locator('#login-email').fill(state.users[0].email);
      await page.locator('#login-password').fill(PASSWORD);
      await page.locator('#login-form button').click();
      await page.waitForFunction(() => !document.querySelector('#login-form button').disabled);
      await page.waitForLoadState('networkidle');
      check(loginReceipts.length === 1, scenario.name + ': exactly one real login');
      check(loginReceipts[0].status === (scenario.denied ? 401 : 200), scenario.name + ': expected login decision');
      if (!scenario.denied) {
        check(loginReceipts[0].maintenance === true && loginReceipts[0].ownerWorkspace === undefined, scenario.name + ': login receipt is not the capability source');
        check(await page.locator('#login-password').inputValue() === '', scenario.name + ': password cleared');
      }
      check(requests.filter(r => r.path === '/api/auth/session').length === initialReads + (scenario.denied ? 0 : 1), scenario.name + ': one current-session check after successful login');
      if (scenario.view === 'app') {
        check(await page.locator('#app-shell').isVisible(), scenario.name + ': opens existing workspace without reload or Check session');
        check(!await page.locator('#loading-screen').isVisible(), scenario.name + ': no maintenance landing');
        check(sessionReceipts.at(-1).ownerWorkspace === true && sessionReceipts.at(-1).workspaceId === state.workspace.id, scenario.name + ': server verified fixed tenant owner');
        check(await page.locator('#owner-workspace-notice').isVisible(), scenario.name + ': saved-data notice remains');
        check(await page.locator('#sync-shopify').isDisabled() && await page.locator('#commander-form button').isDisabled(), scenario.name + ': import and paid actions remain off');
      } else {
        check(!await page.locator('#app-shell').isVisible(), scenario.name + ': workspace stays gated');
        check(await page.locator(scenario.view === 'login' ? '#login-screen' : '#loading-screen').isVisible(), scenario.name + ': safe fallback visible');
        check(!await page.locator('#password-screen').isVisible(), scenario.name + ': quiet mode never opens password mutation');
        if (scenario.fault === 'session-read') check((await page.locator('#login-error').textContent()).includes('Synthetic identity read unavailable'), 'session failure is visible');
      }
      check(requests.filter(r => r.path === '/api/bootstrap').length === (scenario.view === 'app' || scenario.fault === 'bootstrap' ? 1 : 0), scenario.name + ': no unverified bootstrap');
      check(requests.filter(r => r.method !== 'GET').every(r => r.method === 'POST' && r.path === '/api/auth/login'), scenario.name + ': only login POST');
      check(requests.filter(r => r.path.startsWith('/api/')).every(r => ['/api/auth/session', '/api/auth/signup-options', '/api/auth/login', '/api/bootstrap'].includes(r.path)), scenario.name + ': no migration, token, diagnostic, import or provider route');
      const local = await page.evaluate(() => ({ economics: localStorage.getItem('packsmart-saas-economics-v1'), automations: localStorage.getItem('packsmart-saas-automations-v1'), migrated: localStorage.getItem('packsmart-saas-cloud-migration-v3:packsmart-solutions') }));
      assert.deepEqual(local, { economics: '{"legacy-cost":"2.50"}', automations: '{"legacy-rule":false}', migrated: null }); checks++;
      const persisted = structuredClone(f.fake.states.get(state.workspace.id));
      const expectedAudits = scenario.denied ? 0 : 1;
      check(persisted.audit.length === before.audit.length + expectedAudits, scenario.name + ': baseline login audit preserved exactly once');
      if (expectedAudits) check(persisted.audit[0].type === 'user_login', scenario.name + ': only authentication audit');
      persisted.audit = before.audit; persisted._revision = before._revision; persisted.workspace.updatedAt = before.workspace.updatedAt;
      if (scenario.fault === 'role' || scenario.fault === 'revoked') persisted.users = structuredClone(before.users); // Test-injected revocation only.
      assert.deepEqual(persisted, before, scenario.name + ': no business-state mutation'); checks++;
      const writes = f.calls.filter(r => !['GET', 'HEAD'].includes(r.method));
      check(writes.length === expectedAudits && writes.every(r => r.method === 'PATCH' && r.url.pathname.endsWith('/saas_workspace_state')), scenario.name + ': auth-only persistence');
      check(f.fake.tables.size === 0, scenario.name + ': no mirror/credential/receipt tables');
      check(f.server.packsmart.scheduler.status.lastTickAt === null && f.server.packsmart.agentOps.status.lastTickAt === null, scenario.name + ': workers remain stopped');
      cases.push({ name: scenario.name, passed: true, loginRequests: loginReceipts.length, sessionChecksAfterLogin: requests.filter(r => r.path === '/api/auth/session').length - initialReads, bootstrapRequests: requests.filter(r => r.path === '/api/bootstrap').length, authAuditWrites: writes.length });
    } finally {
      await context.close();
      const drained = await f.server.packsmart.drain();
      assert.equal(drained.settled, true);
      f.server.closeAllConnections();
      await f.close();
    }
  }
  assert.deepEqual(errors, []); checks++;
  check(externalRequests === 0, 'zero external browser requests');
  check(providerCalls === 0, 'zero provider calls');
  return { checks, cases, externalRequests, providerCalls, browserErrors: errors };
}
