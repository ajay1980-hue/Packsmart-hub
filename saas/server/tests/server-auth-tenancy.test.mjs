import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { createSessionToken, sessionCookie } from '../lib/security.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';

const SESSION_SECRET = 'server-integration-session-secret-more-than-thirty-two-characters';
const BOOTSTRAP_PASSWORD = 'BootstrapOnly!789Abc';
const OWNER_PASSWORD = 'PacksmartOwner!2026Secure';
const ACTIVATION_TOKEN = 'one-time-owner-activation-token-more-than-thirty-two-characters';

function requestFactory(base) {
  return async function request(pathname, { method = 'GET', body, cookie, csrf } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const response = await fetch(base + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
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
  assert.match(String(home.payload), /app\.js\?v=3\.0\.1/);

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

  const economics = await request('/api/economics', {
    method: 'PUT',
    cookie,
    csrf,
    body: { sku: 'BP1-50', economics: { landed: 2.1, packing: 0.2, delivery: 3.1, channelFee: 0.3 } }
  });
  assert.equal(economics.response.status, 200);
  assert.equal(economics.payload.economics.landed, 2.1);

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
