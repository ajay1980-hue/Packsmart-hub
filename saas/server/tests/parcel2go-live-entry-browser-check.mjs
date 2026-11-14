import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { maintenanceFixture, ownerState, SECRET } from './maintenance-login-fixture.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { parcel2GoCanonicalHash as hash } from '../lib/parcel2go-live-canonical.mjs';

// Actual mounted server/UI, synthetic identity and fake persistence only. Exercise
// PR109's setup path as well as the previously covered prebound entry path.
for (const mode of ['prebound', 'setup']) {
  const state = ownerState('packsmart-solutions');
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id,
    email: 'synthetic@example.test', role: 'owner', csrf: 'synthetic-csrf-at-least-16' }, SECRET);
  const session = verifySessionToken(token, SECRET);
  const config = { requestId: randomUUID(),
    trustedBinding: { workspaceId: state.workspace.id, connectionId: 'synthetic-browser-live', accountId: 'synthetic-browser-alias', environment: 'live' },
    expectedClientId: 'synthetic-browser-client', termsReference: 'synthetic-reviewed-terms',
    expiresAt: new Date(Date.now() + 300000).toISOString(), principalEmail: 'synthetic@example.test',
    accountEvidenceReference: 'synthetic-observation', scope: 'private_storage_only',
    ...(mode === 'prebound' ? { expectedRevision: state._revision, expectedSessionFingerprint: hash(session) } : {}) };
  let providerRequests = 0, browser;
  const f = await maintenanceFixture({ states: [state], providerFetch: async () => {
    providerRequests++; assert.fail('Provider request forbidden in private entry browser acceptance');
  }, env: { RUNVARA_QUIET_OWNER_WORKSPACE: 'enabled/v1', ...(mode === 'setup' ? {
    RUNVARA_QUIET_PARCEL2GO_LIVE_SETUP: 'enabled/v1', RUNVARA_PARCEL2GO_LIVE_SETUP_CONFIG: JSON.stringify(config)
  } : {
    RUNVARA_QUIET_PARCEL2GO_LIVE_CREDENTIAL_ENTRY: 'enabled/v1', RUNVARA_PARCEL2GO_LIVE_ENTRY_CONFIG: JSON.stringify(config)
  }) } });
  try {
    browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    await context.addCookies([{ name: '__Host-packsmart_session', value: token, domain: 'maintenance.example.test', path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
    const posts = [], externalRequests = [];
    await context.route('**/*', async route => {
      const request = route.request(), u = new URL(request.url());
      if (u.origin !== 'https://maintenance.example.test') { externalRequests.push(u.origin); await route.abort(); return; }
      if (request.method() === 'POST') posts.push(u.pathname);
      const response = await route.fetch({ url: f.base + u.pathname + u.search, headers: request.headers() });
      await route.fulfill({ response });
    });
    const page = await context.newPage();
    if (mode === 'setup') {
      const response = await page.goto('https://maintenance.example.test/parcel2go-live-setup.html');
      assert.equal(response.headers()['cache-control'], 'no-store');
      assert.equal(response.headers()['referrer-policy'], 'no-referrer');
      assert.equal(posts.length, 0);
      assert.equal(await page.locator('#entry').isVisible(), false);
      await page.getByRole('button', { name: 'Prepare private entry', exact: true }).click();
      await page.getByText('Ready to review. No credentials have been saved by this action.').waitFor();
      assert.deepEqual(posts, ['/api/owner/parcel2go-live-setup']);
      assert.equal(f.calls.filter(x => x.method === 'PATCH').length, 0);
      const navigation = page.waitForResponse(response => response.url() === 'https://maintenance.example.test/parcel2go-live-entry.html');
      await page.getByRole('link', { name: 'Review account and enter credentials privately' }).click();
      const entryResponse = await navigation;
      assert.equal(entryResponse.headers()['cache-control'], 'no-store');
      assert.equal(entryResponse.headers()['referrer-policy'], 'no-referrer');
    } else {
      const response = await page.goto('https://maintenance.example.test/parcel2go-live-entry.html');
      assert.equal(response.headers()['cache-control'], 'no-store');
      assert.equal(response.headers()['referrer-policy'], 'no-referrer');
    }
    await page.getByText('Review the account and terms before saving.').waitFor();
    assert.equal(posts.length, mode === 'setup' ? 1 : 0);
    await page.getByLabel('Client ID', { exact: true }).fill(config.expectedClientId);
    await page.getByLabel('Client secret', { exact: true }).fill('synthetic-browser-secret');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Save privately once' }).click();
    await page.getByText('Credentials stored. No Parcel2Go token or quote request was made.').waitFor();
    assert.equal(await page.locator('#clientSecret').inputValue(), '');
    assert.deepEqual(posts, [...(mode === 'setup' ? ['/api/owner/parcel2go-live-setup'] : []), '/api/owner/parcel2go-live-credentials']);
    assert.equal(f.calls.filter(x => x.method === 'PATCH').length, 2);
    await page.reload();
    await page.getByText('Credentials are already stored. No repeat submission is needed.').waitFor();
    assert.equal(posts.length, mode === 'setup' ? 2 : 1);
    assert.equal(f.calls.filter(x => x.method === 'PATCH').length, 2);
    assert.equal(providerRequests, 0);
    assert.deepEqual(externalRequests, []);
    const screenshot = `/tmp/parcel2go-${mode}-entry-browser.png`;
    await page.screenshot({ path: screenshot, fullPage: true });
    console.log(JSON.stringify({ mode, browser: 'Chromium', realServer: true, database: 'fakeSupabase', principal: 'synthetic',
      routeProxy: 'HTTPS test origin proxied to loopback only', posts: posts.length, casWrites: 2,
      providerRequests, stored: true, reloadBlocked: true, secretCleared: true,
      privateCache: 'no-store', privateReferrer: 'no-referrer', screenshot }));
  } finally { await browser?.close(); await f.close(); }
}
