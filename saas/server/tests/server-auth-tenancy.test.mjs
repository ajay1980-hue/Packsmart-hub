import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { createSessionToken, decryptCredentials, sessionCookie } from '../lib/security.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';

const SESSION_SECRET = 'server-integration-session-secret-more-than-thirty-two-characters';
const BOOTSTRAP_PASSWORD = 'BootstrapOnly!789Abc';
const OWNER_PASSWORD = 'PacksmartOwner!2026Secure';
const ACTIVATION_TOKEN = 'one-time-owner-activation-token-more-than-thirty-two-characters';

function requestFactory(base) {
  return async function request(pathname, { method = 'GET', body, cookie, csrf, redirect } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const response = await fetch(base + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect
    });
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = text; }
    return { response, payload, setCookie: response.headers.get('set-cookie') || '' };
  };
}

function cookieValue(setCookie) {
  return String(setCookie).split(';')[0];
}

test('production auth, CSRF, approval, logout and tenant isolation work end to end', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'packsmart-ops-test-'));
  const stateFile = path.join(directory, 'state.json');
  const server = createPacksmartServer({
    NODE_ENV: 'test',
    APP_PUBLIC_URL: 'http://localhost:8787',
    SAAS_STATE_FILE: stateFile,
    PACKSMART_ADMIN_EMAIL: 'sales@packsmartsolutions.com',
    PACKSMART_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
    SESSION_SECRET,
    CREDENTIALS_KEY: 'server-integration-credential-key-more-than-thirty-two-characters',
    BETA_SIGNUPS_ENABLED: 'false',
    BILLING_CHECKOUT_ENABLED: 'false'
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const request = requestFactory(base);

  const health = await request('/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.payload.ok, true);
  assert.equal(health.payload.checks.billingCharging, false);

  const appAsset = await request('/app.js');
  assert.equal(appAsset.response.status, 200);
  assert.match(appAsset.response.headers.get('content-type'), /javascript/);
  assert.equal(appAsset.response.headers.get('cache-control'), 'no-cache');
  assert.match(String(appAsset.payload), /HttpOnly|packsmart/i);
  const home = await request('/');
  assert.equal(home.response.status, 200);
  assert.match(String(home.payload), /app\.js\?v=4\.3\.0/);

  const protectedResponse = await request('/api/bootstrap');
  assert.equal(protectedResponse.response.status, 401);

  const wrongLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'sales@packsmartsolutions.com', password: 'WrongPassword!1234' }
  });
  assert.equal(wrongLogin.response.status, 401);
  assert.equal(wrongLogin.payload.error, 'Invalid email or password');

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'sales@packsmartsolutions.com', password: BOOTSTRAP_PASSWORD }
  });
  assert.equal(login.response.status, 200);
  assert.match(login.setCookie, /HttpOnly/);
  assert.match(login.setCookie, /SameSite=Strict/);
  assert.equal(login.payload.user.passwordChangeRequired, true);
  let cookie = cookieValue(login.setCookie);
  let csrf = login.payload.csrf;

  const session = await request('/api/auth/session', { cookie });
  assert.equal(session.response.status, 200);
  assert.equal(session.payload.workspace.id, 'packsmart-solutions');

  const csrfFailure = await request('/api/economics', {
    method: 'PUT',
    cookie,
    body: { sku: 'BP1-50', economics: { landed: 1 } }
  });
  assert.equal(csrfFailure.response.status, 403);

  const bootstrap = await request('/api/bootstrap', { cookie });
  assert.equal(bootstrap.response.status, 200);
  assert.equal(bootstrap.payload.products.length, 15);
  assert.equal(bootstrap.payload.storage, 'file');
  assert.equal(bootstrap.payload.integrations.some(item => item.id === 'meta'), true);
  assert.equal(bootstrap.payload.suppliers.some(item => item.name === 'Europlast'), true);

  const originalSave = server.packsmart.store.save.bind(server.packsmart.store);
  let redundantBootstrapSaves = 0;
  server.packsmart.store.save = async (...args) => {
    redundantBootstrapSaves += 1;
    return originalSave(...args);
  };
  const repeatedBootstrap = await request('/api/bootstrap', { cookie });
  assert.equal(repeatedBootstrap.response.status, 200);
  assert.equal(redundantBootstrapSaves, 0, 'an unchanged read-only bootstrap must not rewrite persistence');
  server.packsmart.store.save = originalSave;

  const economics = await request('/api/economics', {
    method: 'PUT',
    cookie,
    csrf,
    body: { sku: 'BP1-50', economics: { landed: 2.1, packing: 0.2, delivery: 3.1, channelFee: 0.3 } }
  });
  assert.equal(economics.response.status, 200);
  assert.equal(economics.payload.economics.landed, 2.1);

  const supplier = await request('/api/suppliers', {
    method: 'POST', cookie, csrf,
    body: { name: 'Test Packaging Supplier', notes: 'Workspace-specific test supplier' }
  });
  assert.equal(supplier.response.status, 201);
  assert.equal(supplier.payload.supplier.name, 'Test Packaging Supplier');

  const advertising = await request('/api/advertising-costs', {
    method: 'POST', cookie, csrf,
    body: { channel: 'meta', spend: 12.5, attributableRevenue: 40, date: new Date().toISOString() }
  });
  assert.equal(advertising.response.status, 201);
  assert.equal(advertising.payload.record.spend, 12.5);

  const accounting = await request('/api/reports/accounting.csv', { cookie });
  assert.equal(accounting.response.status, 200);
  assert.match(accounting.response.headers.get('content-type'), /text\/csv/);
  assert.match(String(accounting.payload), /operating_contribution/);

  const approval = await request('/api/actions', {
    method: 'POST',
    cookie,
    csrf,
    body: {
      type: 'supplier_order',
      action: 'Order one launch carton',
      reason: 'Prevent launch stockout',
      financialImpact: 95,
      expectedBenefit: 'Keep core SKU available',
      risk: 'Cash tied up in stock',
      source: 'test-suite'
    }
  });
  assert.equal(approval.response.status, 202);
  assert.equal(approval.payload.executedExternally, false);
  assert.equal(approval.payload.approval.status, 'pending');

  const decision = await request('/api/approvals/' + approval.payload.approval.id + '/decision', {
    method: 'POST',
    cookie,
    csrf,
    body: { decision: 'approved', note: 'Approved for later executor test' }
  });
  assert.equal(decision.response.status, 200);
  assert.equal(decision.payload.approval.status, 'approved');
  assert.equal(decision.payload.executedExternally, false);

  const shopifySecret = 'shopify-client-secret-value-test-only';
  const shopifyConnection = await request('/api/connections', {
    method: 'POST', cookie, csrf,
    body: {
      provider: 'shopify',
      capabilities: ['write_products', 'write_inventory'],
      credentials: {
        storeDomain: 'wavtzm-vy.myshopify.com',
        clientId: 'shopify-client-id-test',
        clientSecret: shopifySecret
      }
    }
  });
  assert.equal(shopifyConnection.response.status, 200);
  assert.deepEqual(shopifyConnection.payload.connection.capabilities, ['catalogue', 'inventory', 'orders']);
  assert.equal(JSON.stringify(shopifyConnection.payload).includes(shopifySecret), false);
  assert.equal(JSON.stringify(shopifyConnection.payload).includes('shopify-client-id-test'), false);

  const publicConnections = await request('/api/connections', { cookie });
  assert.equal(publicConnections.response.status, 200);
  assert.equal(JSON.stringify(publicConnections.payload).includes(shopifySecret), false);
  assert.equal(JSON.stringify(publicConnections.payload).includes('shopify-client-id-test'), false);

  const ebaySecret = 'existing-ebay-manager-token-test-only';
  const ebayConnection = await request('/api/connections', {
    method: 'POST', cookie, csrf,
    body: {
      provider: 'ebay',
      capabilities: ['create_listing', 'change_price'],
      credentials: {
        baseUrl: 'https://existing-ebay-manager.example.test/path-is-normalized',
        expectedAccount: 'packsmartsolutions20',
        apiToken: ebaySecret
      }
    }
  });
  assert.equal(ebayConnection.response.status, 200);
  assert.deepEqual(ebayConnection.payload.connection.capabilities, ['status', 'listings', 'drafts', 'orders', 'fees', 'promotions']);
  assert.equal(JSON.stringify(ebayConnection.payload).includes(ebaySecret), false);
  assert.equal(JSON.stringify(ebayConnection.payload).includes('existing-ebay-manager.example.test'), false);

  const unsupportedConnection = await request('/api/connections', {
    method: 'POST', cookie, csrf,
    body: { provider: 'meta', credentials: { token: 'must-not-be-stored-without-an-adapter' } }
  });
  assert.equal(unsupportedConnection.response.status, 400);

  const persistedWithConnection = await server.packsmart.store.get('packsmart-solutions');
  const persistedShopify = persistedWithConnection.connections.find(item => item.provider === 'shopify');
  assert.equal(persistedShopify.encryptedCredentials.includes(shopifySecret), false);
  assert.deepEqual(decryptCredentials(persistedShopify.encryptedCredentials, 'server-integration-credential-key-more-than-thirty-two-characters'), {
    storeDomain: 'wavtzm-vy.myshopify.com',
    clientId: 'shopify-client-id-test',
    clientSecret: shopifySecret
  });
  const persistedEbay = persistedWithConnection.connections.find(item => item.provider === 'ebay');
  assert.equal(persistedEbay.encryptedCredentials.includes(ebaySecret), false);
  assert.deepEqual(decryptCredentials(persistedEbay.encryptedCredentials, 'server-integration-credential-key-more-than-thirty-two-characters'), {
    baseUrl: 'https://existing-ebay-manager.example.test',
    expectedAccount: 'packsmartsolutions20',
    apiToken: ebaySecret
  });

  const changed = await request('/api/auth/change-password', {
    method: 'POST',
    cookie,
    csrf,
    body: { newPassword: OWNER_PASSWORD }
  });
  assert.equal(changed.response.status, 200);
  cookie = cookieValue(changed.setCookie);
  csrf = changed.payload.csrf;

  const staleSession = await request('/api/auth/session', { cookie: cookieValue(login.setCookie) });
  assert.equal(staleSession.response.status, 401);

  const oldPassword = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'sales@packsmartsolutions.com', password: BOOTSTRAP_PASSWORD }
  });
  assert.equal(oldPassword.response.status, 401);
  const newPassword = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'sales@packsmartsolutions.com', password: OWNER_PASSWORD }
  });
  assert.equal(newPassword.response.status, 200);

  const betaState = seedWorkspaceState({}, {
    workspaceId: 'beta-workspace',
    name: 'Beta Ltd',
    slug: 'beta-workspace',
    email: 'beta@example.test',
    passwordHash: null
  });
  betaState.users[0].passwordChangeRequired = false;
  await server.packsmart.store.save('beta-workspace', betaState);
  const betaUser = betaState.users[0];
  const betaToken = createSessionToken({
    userId: betaUser.id,
    workspaceId: 'beta-workspace',
    email: betaUser.email,
    role: betaUser.role,
    sessionVersion: betaUser.sessionVersion
  }, SESSION_SECRET);
  const betaCookie = cookieValue(sessionCookie(betaToken, { secure: false }));
  const isolated = await request('/api/bootstrap?workspaceId=packsmart-solutions', { cookie: betaCookie });
  assert.equal(isolated.response.status, 200);
  assert.equal(isolated.payload.workspace.id, 'beta-workspace');
  assert.notEqual(isolated.payload.workspace.id, 'packsmart-solutions');

  const logout = await request('/api/auth/logout', {
    method: 'POST',
    cookie,
    csrf,
    body: {}
  });
  assert.equal(logout.response.status, 200);
  assert.match(logout.setCookie, /Max-Age=0/);
});

test('eBay read-only OAuth uses a one-time callback while preserving the existing Manager', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'packsmart-ops-ebay-oauth-test-'));
  const credentialsKey = 'server-integration-credential-key-more-than-thirty-two-characters';
  const managerSecret = 'existing-manager-secret-test-only';
  const refreshSecret = 'ebay-refresh-token-test-only';
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    const method = options.method || 'GET';
    calls.push({ href, method, body: String(options.body || '') });
    const json = payload => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    if (href === 'https://api.ebay.com/identity/v1/oauth2/token') {
      const form = new URLSearchParams(String(options.body || ''));
      if (form.get('grant_type') === 'authorization_code') {
        return json({
          access_token: 'initial-access-token-test-only',
          expires_in: 7200,
          refresh_token: refreshSecret,
          refresh_token_expires_in: 47304000
        });
      }
      return json({ access_token: 'refreshed-access-token-test-only', expires_in: 7200 });
    }
    if (href === 'https://apiz.ebay.com/commerce/identity/v1/user/') return json({ username: 'packsmartsolutions20' });
    if (href.includes('/sell/fulfillment/v1/order?')) return json({ total: 0, orders: [] });
    if (href.includes('/sell/inventory/v1/inventory_item?')) return json({ total: 0, inventoryItems: [] });
    if (href.includes('/sell/marketing/v1/ad_campaign?')) return json({ total: 0, campaigns: [] });
    throw new Error(`Unexpected eBay test request: ${method} ${href}`);
  };
  const server = createPacksmartServer({
    NODE_ENV: 'test',
    APP_PUBLIC_URL: 'http://localhost:8787',
    SAAS_STATE_FILE: path.join(directory, 'state.json'),
    PACKSMART_ADMIN_EMAIL: 'sales@packsmartsolutions.com',
    PACKSMART_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
    SESSION_SECRET,
    CREDENTIALS_KEY: credentialsKey,
    BETA_SIGNUPS_ENABLED: 'false',
    BILLING_CHECKOUT_ENABLED: 'false',
    EBAY_OAUTH_ENABLED: 'true',
    EBAY_CLIENT_ID: 'packsmart-client-id-test',
    EBAY_CLIENT_SECRET: 'packsmart-client-secret-test-only',
    EBAY_REDIRECT_URI_NAME: 'Packsmart-Ops-Read-Only-Test-RuName',
    EBAY_EXPECTED_ACCOUNT: 'packsmartsolutions20',
    EBAY_MARKETPLACE_ID: 'EBAY_GB'
  }, { fetchImpl });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const request = requestFactory(`http://127.0.0.1:${server.address().port}`);
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'sales@packsmartsolutions.com', password: BOOTSTRAP_PASSWORD }
  });
  assert.equal(login.response.status, 200);
  const cookie = cookieValue(login.setCookie);
  const csrf = login.payload.csrf;

  const manager = await request('/api/connections', {
    method: 'POST', cookie, csrf,
    body: {
      provider: 'ebay',
      credentials: {
        baseUrl: 'https://existing-ebay-manager.example.test',
        expectedAccount: 'packsmartsolutions20',
        apiToken: managerSecret
      }
    }
  });
  assert.equal(manager.response.status, 200);

  const started = await request('/api/integrations/ebay/oauth/start', { method: 'POST', cookie, csrf, body: {} });
  assert.equal(started.response.status, 200);
  assert.equal(started.payload.readOnly, true);
  assert.equal(started.payload.existingManagerPreserved, true);
  const authorizationUrl = new URL(started.payload.authorizationUrl);
  assert.equal(authorizationUrl.origin, 'https://auth.ebay.com');
  const oauthState = authorizationUrl.searchParams.get('state');
  assert.ok(oauthState);

  const forged = await request(`/api/integrations/ebay/oauth/callback?state=${encodeURIComponent(`${oauthState}x`)}&code=forged`, { redirect: 'manual' });
  assert.equal(forged.response.status, 400);

  const callback = await request(`/api/integrations/ebay/oauth/callback?state=${encodeURIComponent(oauthState)}&code=authorized-code`, { redirect: 'manual' });
  assert.equal(callback.response.status, 303);
  assert.equal(callback.response.headers.get('location'), 'http://localhost:8787/?ebay=connected');
  assert.equal(String(callback.payload).includes(refreshSecret), false);

  const persisted = await server.packsmart.store.get('packsmart-solutions');
  const managerConnection = persisted.connections.find(item => item.provider === 'ebay');
  const oauthConnection = persisted.connections.find(item => item.provider === 'ebay_oauth');
  assert.ok(managerConnection, 'the existing eBay Manager connection must remain stored');
  assert.ok(oauthConnection, 'the read-only connection must be stored separately');
  assert.equal(oauthConnection.encryptedCredentials.includes(refreshSecret), false);
  assert.equal(decryptCredentials(oauthConnection.encryptedCredentials, credentialsKey).refreshToken, refreshSecret);
  assert.equal(decryptCredentials(managerConnection.encryptedCredentials, credentialsKey).apiToken, managerSecret);
  assert.equal(persisted.oauthChallenges.length, 0, 'the callback challenge must be consumed exactly once');
  assert.equal(persisted.audit.some(event => event.type === 'ebay_oauth_connected'), true);
  assert.equal(persisted.audit.some(event => event.type === 'ebay_read_sync'), true);

  const replay = await request(`/api/integrations/ebay/oauth/callback?state=${encodeURIComponent(oauthState)}&code=replayed-code`, { redirect: 'manual' });
  assert.equal(replay.response.status, 400);
  const publicConnections = await request('/api/connections', { cookie });
  assert.equal(JSON.stringify(publicConnections.payload).includes(refreshSecret), false);
  assert.equal(JSON.stringify(publicConnections.payload).includes(managerSecret), false);
  assert.equal(calls.filter(call => call.href.includes('/sell/') || call.href.includes('/commerce/')).every(call => call.method === 'GET'), true);
});

test('one-time owner activation sets a private password without exposing the bootstrap secret', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'packsmart-ops-activation-test-'));
  const server = createPacksmartServer({
    NODE_ENV: 'test',
    APP_PUBLIC_URL: 'http://localhost:8787',
    SAAS_STATE_FILE: path.join(directory, 'state.json'),
    PACKSMART_ADMIN_EMAIL: 'sales@packsmartsolutions.com',
    PACKSMART_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
    OWNER_ACTIVATION_TOKEN: ACTIVATION_TOKEN,
    SESSION_SECRET,
    CREDENTIALS_KEY: 'server-integration-credential-key-more-than-thirty-two-characters',
    BETA_SIGNUPS_ENABLED: 'false',
    BILLING_CHECKOUT_ENABLED: 'false'
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = requestFactory(base);

  const invalid = await request('/api/auth/activate-owner', {
    method: 'POST',
    body: { token: 'wrong-token', newPassword: OWNER_PASSWORD }
  });
  assert.equal(invalid.response.status, 401);
  assert.equal(invalid.payload.code, 'ACTIVATION_INVALID');

  const weak = await request('/api/auth/activate-owner', {
    method: 'POST',
    body: { token: ACTIVATION_TOKEN, newPassword: 'too-weak' }
  });
  assert.equal(weak.response.status, 400);

  const activated = await request('/api/auth/activate-owner', {
    method: 'POST',
    body: { token: ACTIVATION_TOKEN, newPassword: OWNER_PASSWORD }
  });
  assert.equal(activated.response.status, 200);
  assert.equal(activated.payload.user.passwordChangeRequired, false);
  assert.match(activated.setCookie, /HttpOnly/);
  assert.match(activated.setCookie, /SameSite=Strict/);
  const cookie = cookieValue(activated.setCookie);

  const session = await request('/api/auth/session', { cookie });
  assert.equal(session.response.status, 200);
  assert.equal(session.payload.workspace.id, 'packsmart-solutions');

  const reused = await request('/api/auth/activate-owner', {
    method: 'POST',
    body: { token: ACTIVATION_TOKEN, newPassword: 'AnotherOwner!2026Password' }
  });
  assert.equal(reused.response.status, 409);
  assert.equal(reused.payload.code, 'ACTIVATION_USED');

  const bootstrapLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'sales@packsmartsolutions.com', password: BOOTSTRAP_PASSWORD }
  });
  assert.equal(bootstrapLogin.response.status, 401);
  const ownerLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { email: 'sales@packsmartsolutions.com', password: OWNER_PASSWORD }
  });
  assert.equal(ownerLogin.response.status, 200);

  const audit = await request('/api/audit', { cookie });
  assert.equal(audit.response.status, 200);
  assert.equal(audit.payload.events.some(event => event.type === 'owner_account_activated'), true);
});
