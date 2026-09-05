import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  SlidingWindowLimiter,
  assertCsrf,
  clearSessionCookie,
  createSessionToken,
  encryptCredentials,
  hashPassword,
  normalizeEmail,
  publicConnection,
  safeEqual,
  sanitizeError,
  sessionCookie,
  tokenFromRequest,
  validatePassword,
  verifyPassword,
  verifySessionToken
} from './lib/security.mjs';
import { IntegrationService } from './lib/integrations.mjs';
import {
  APPROVAL_TYPES,
  AUTOMATION_DEFINITIONS,
  buildDailyBrief,
  deriveOperations,
  integrationMatrix,
  normalizeApprovalRequest,
  onboardingState
} from './lib/operations.mjs';
import { addAudit, createStore, getOrSeed, seedWorkspaceState } from './lib/store.mjs';

const CUSTOMER_ZERO_WORKSPACE = 'packsmart-solutions';
const VERSION = '3.0.1';
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const STATIC_FILES = new Map([
  ['/', ['saas/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['saas/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['saas/app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['saas/styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['saas/favicon.svg', 'image/svg+xml']]
]);

const PLANS = Object.freeze({
  starter: { name: 'Starter', indicativeMonthlyGbp: 29, features: ['1 workspace', 'Shopify connection', 'Profit and approval controls'] },
  growth: { name: 'Growth', indicativeMonthlyGbp: 79, features: ['All Starter features', 'eBay and social commerce', 'Daily operations brief'] },
  pro: { name: 'Pro', indicativeMonthlyGbp: 149, features: ['All Growth features', 'Advanced automation', 'Priority support'] }
});

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function clamp(value, minimum, maximum, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function cleanEconomics(value = {}) {
  const clean = {};
  for (const field of ['landed', 'packing', 'delivery', 'channelFee', 'marginFloor']) {
    const raw = value[field];
    if (raw === '' || raw === null || raw === undefined) clean[field] = '';
    else {
      const number = Number(raw);
      const maximum = field === 'marginFloor' ? 100 : 1000000;
      if (!Number.isFinite(number) || number < 0 || number > maximum) {
        throw Object.assign(new Error(`Invalid ${field} value`), { status: 400, code: 'VALIDATION_FAILED' });
      }
      clean[field] = Number(number.toFixed(4));
    }
  }
  return clean;
}

function text(value, max = 200) {
  return String(value || '').trim().slice(0, max);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    passwordChangeRequired: Boolean(user.passwordChangeRequired)
  };
}

function stripeConfigured(env) {
  return Boolean(env.STRIPE_SECRET_KEY && env.APP_PUBLIC_URL && (
    env.STRIPE_PRICE_STARTER || env.STRIPE_PRICE_GROWTH || env.STRIPE_PRICE_PRO
  ));
}

function stripePrice(env, plan) {
  return {
    starter: env.STRIPE_PRICE_STARTER,
    growth: env.STRIPE_PRICE_GROWTH,
    pro: env.STRIPE_PRICE_PRO
  }[plan] || null;
}

async function createStripeCheckout(env, session, plan) {
  const price = stripePrice(env, plan);
  if (!truthy(env.BILLING_CHECKOUT_ENABLED)) {
    throw Object.assign(new Error('Paid checkout is disabled during customer-zero testing'), { status: 403, code: 'BILLING_DISABLED' });
  }
  if (!env.STRIPE_SECRET_KEY || !price || !env.APP_PUBLIC_URL) {
    throw Object.assign(new Error('Stripe checkout is not configured for this plan'), { status: 503, code: 'BILLING_NOT_CONFIGURED' });
  }
  const params = new URLSearchParams();
  params.set('mode', 'subscription');
  params.set('line_items[0][price]', price);
  params.set('line_items[0][quantity]', '1');
  params.set('success_url', `${env.APP_PUBLIC_URL.replace(/\/$/, '')}/?billing=success`);
  params.set('cancel_url', `${env.APP_PUBLIC_URL.replace(/\/$/, '')}/?billing=cancelled`);
  params.set('customer_email', session.email);
  params.set('client_reference_id', session.workspaceId);
  params.set('metadata[workspace_id]', session.workspaceId);
  params.set('metadata[plan]', plan);
  params.set('subscription_data[metadata][workspace_id]', session.workspaceId);
  params.set('subscription_data[metadata][plan]', plan);

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params,
    signal: AbortSignal.timeout(20000)
  });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok || !data.url) {
    throw Object.assign(new Error('Stripe checkout creation failed'), { status: 502, code: 'STRIPE_REQUEST_FAILED' });
  }
  return { id: data.id, url: data.url };
}

function verifyStripeSignature(env, raw, header) {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const parsed = {};
  for (const part of String(header).split(',')) {
    const [key, value] = part.split('=');
    if (key && value && parsed[key] === undefined) parsed[key] = value;
  }
  const timestamp = Number(parsed.t);
  const signature = parsed.v1;
  if (!timestamp || !signature || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw.toString('utf8')}`).digest('hex');
  return safeEqual(signature, expected);
}

export function createPacksmartServer(customEnv = process.env, options = {}) {
  const env = { ...customEnv };
  const store = options.store || createStore(env, { fetchImpl: options.fetchImpl });
  const integrations = options.integrations || new IntegrationService(env, { fetchImpl: options.fetchImpl || fetch, repoRoot });
  const isProduction = env.NODE_ENV === 'production';
  const secureCookies = isProduction || String(env.APP_PUBLIC_URL || '').startsWith('https://');
  const publicUrl = env.APP_PUBLIC_URL || (secureCookies ? 'https://packsmart-ops.onrender.com' : 'http://localhost:8787');
  const allowBearer = truthy(env.ALLOW_BEARER_AUTH);
  const loginLimiter = new SlidingWindowLimiter({
    limit: clamp(env.LOGIN_ATTEMPT_LIMIT, 3, 30, 8),
    windowMs: clamp(env.LOGIN_WINDOW_MS, 60000, 86400000, 15 * 60 * 1000),
    blockMs: clamp(env.LOGIN_BLOCK_MS, 60000, 86400000, 15 * 60 * 1000)
  });
  const activationLimiter = new SlidingWindowLimiter({
    limit: clamp(env.ACTIVATION_ATTEMPT_LIMIT, 3, 20, 6),
    windowMs: clamp(env.ACTIVATION_WINDOW_MS, 60000, 86400000, 15 * 60 * 1000),
    blockMs: clamp(env.ACTIVATION_BLOCK_MS, 60000, 86400000, 30 * 60 * 1000)
  });
  const locks = new Map();

  function headers(contentType = 'application/json; charset=utf-8', cache = 'no-store') {
    return {
      'Content-Type': contentType,
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...(secureCookies ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {})
    };
  }

  function send(res, status, body, extraHeaders = {}) {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { ...headers(), ...extraHeaders });
    res.end(payload);
  }

  async function rawBody(req, maxBytes = 1024 * 1024) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBytes) throw Object.assign(new Error('Request too large'), { status: 413, code: 'REQUEST_TOO_LARGE' });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function jsonBody(req, maxBytes) {
    const contentType = String(req.headers['content-type'] || '').split(';')[0];
    if (contentType && contentType !== 'application/json') {
      throw Object.assign(new Error('Content-Type must be application/json'), { status: 415, code: 'CONTENT_TYPE_INVALID' });
    }
    const raw = await rawBody(req, maxBytes);
    if (!raw.length) return {};
    try { return JSON.parse(raw.toString('utf8')); }
    catch { throw Object.assign(new Error('Invalid JSON'), { status: 400, code: 'JSON_INVALID' }); }
  }

  async function serveStatic(pathname, res) {
    const item = STATIC_FILES.get(pathname);
    if (!item) return false;
    const [relative, contentType] = item;
    try {
      const body = await fs.readFile(new URL(relative, `file://${repoRoot}/`));
      const csp = "default-src 'self'; connect-src 'self'; img-src 'self' https://cdn.shopify.com data:; style-src 'self'; script-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";
      res.writeHead(200, {
        ...headers(contentType, pathname === '/' || pathname === '/index.html' ? 'no-cache' : 'public, max-age=300'),
        'Content-Security-Policy': csp
      });
      res.end(body);
    } catch {
      send(res, 404, { error: 'Static file not found', code: 'NOT_FOUND' });
    }
    return true;
  }

  function requestIp(req) {
    return text(String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0], 80);
  }

  function sessionFrom(req) {
    const token = tokenFromRequest(req, { allowBearer, secure: secureCookies });
    return verifySessionToken(token, env.SESSION_SECRET);
  }

  async function authenticate(req, res) {
    const session = sessionFrom(req);
    if (!session) {
      send(res, 401, { error: 'Authentication required', code: 'AUTH_REQUIRED' });
      return null;
    }
    const state = await store.get(session.workspaceId);
    const user = state?.users?.find(item => item.id === session.sub);
    if (!state || !user || user.active === false || Number(user.sessionVersion || 1) !== Number(session.sessionVersion || 1)) {
      send(res, 401, { error: 'Session is no longer valid', code: 'SESSION_INVALID' }, {
        'Set-Cookie': clearSessionCookie({ secure: secureCookies })
      });
      return null;
    }
    return { session, state, user };
  }

  function requireOwner(auth) {
    if (!['owner', 'admin'].includes(auth.user.role)) {
      throw Object.assign(new Error('Owner or admin access required'), { status: 403, code: 'ROLE_DENIED' });
    }
  }

  async function withWorkspaceLock(workspaceId, callback) {
    const previous = locks.get(workspaceId) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const queued = previous.then(() => current);
    locks.set(workspaceId, queued);
    await previous;
    try { return await callback(); }
    finally {
      release();
      if (locks.get(workspaceId) === queued) locks.delete(workspaceId);
    }
  }

  async function mutate(auth, callback) {
    return withWorkspaceLock(auth.session.workspaceId, async () => {
      const state = await store.get(auth.session.workspaceId);
      if (!state) throw Object.assign(new Error('Workspace not found'), { status: 404, code: 'WORKSPACE_NOT_FOUND' });
      const result = await callback(state);
      await store.save(auth.session.workspaceId, state);
      return result;
    });
  }

  async function refreshOperationalState(state, { force = false } = {}) {
    const lastShopify = Date.parse(state.integrationStatus?.shopify?.lastSyncAt || 0);
    const stale = !Number.isFinite(lastShopify) || Date.now() - lastShopify > clamp(env.SYNC_INTERVAL_MS, 60000, 86400000, 15 * 60 * 1000);
    if (force || !state.products?.length || (env.SHOPIFY_ADMIN_ACCESS_TOKEN && stale)) {
      try { await integrations.syncShopify(state); }
      catch (error) {
        state.integrationStatus = {
          ...(state.integrationStatus || {}),
          shopify: {
            status: state.products?.length ? 'degraded' : 'error',
            detail: state.products?.length ? 'Last known catalogue retained after a live sync error.' : 'Shopify data is unavailable.',
            lastSyncAt: state.integrationStatus?.shopify?.lastSyncAt || null,
            lastError: error.code || 'SHOPIFY_SYNC_FAILED'
          }
        };
      }
    }
  }

  function currentBrief(state) {
    const today = new Date().toISOString().slice(0, 10);
    const existing = (state.dailyBriefs || []).find(brief => String(brief.generatedAt || '').startsWith(today));
    if (existing) return existing;
    const brief = buildDailyBrief(state, {
      lowStockThreshold: clamp(env.LOW_STOCK_THRESHOLD, 0, 100000, 20),
      marginFloor: clamp(env.MARGIN_FLOOR_PERCENT, 0, 100, 20)
    });
    state.dailyBriefs = [brief, ...(state.dailyBriefs || [])].slice(0, 30);
    addAudit(state, { type: 'daily_operations_brief_generated', actor: 'system', detail: { briefId: brief.id, logic: brief.logic } });
    return brief;
  }

  function bootstrapPayload(state, user, csrf) {
    const brief = currentBrief(state);
    return {
      version: VERSION,
      workspace: state.workspace,
      user: publicUser(user),
      csrf,
      products: state.products || [],
      orders: state.orders || [],
      economics: state.economics || {},
      automations: state.automations || {},
      automationDefinitions: AUTOMATION_DEFINITIONS,
      approvals: state.approvals || [],
      subscription: state.subscription || null,
      connections: (state.connections || []).map(publicConnection),
      integrations: integrationMatrix(state, env),
      ebay: state.ebay || null,
      dashboard: deriveOperations(state, {
        lowStockThreshold: clamp(env.LOW_STOCK_THRESHOLD, 0, 100000, 20),
        marginFloor: clamp(env.MARGIN_FLOOR_PERCENT, 0, 100, 20)
      }),
      brief,
      onboarding: onboardingState(state, env),
      storage: store.provider
    };
  }

  async function activateOwner(req, res) {
    const configuredToken = String(env.OWNER_ACTIVATION_TOKEN || '');
    if (configuredToken.length < 32 || !env.SESSION_SECRET || String(env.SESSION_SECRET).length < 32) {
      send(res, 404, { error: 'Owner activation is unavailable', code: 'ACTIVATION_UNAVAILABLE' });
      return;
    }
    const key = requestIp(req);
    const rate = activationLimiter.check(key);
    if (!rate.allowed) {
      send(res, 429, { error: 'Too many activation attempts. Try again later.', code: 'ACTIVATION_RATE_LIMITED' }, {
        'Retry-After': String(Math.ceil(rate.retryAfterMs / 1000))
      });
      return;
    }
    const body = await jsonBody(req, 32768);
    if (!safeEqual(body.token, configuredToken)) {
      activationLimiter.fail(key);
      await new Promise(resolve => setTimeout(resolve, 120));
      send(res, 401, { error: 'Activation link is invalid or expired', code: 'ACTIVATION_INVALID' });
      return;
    }
    const passwordHash = hashPassword(body.newPassword);
    const adminEmail = normalizeEmail(env.PACKSMART_ADMIN_EMAIL || 'sales@packsmartsolutions.com');
    const result = await withWorkspaceLock(CUSTOMER_ZERO_WORKSPACE, async () => {
      const state = await getOrSeed(store, CUSTOMER_ZERO_WORKSPACE, env, {
        email: adminEmail,
        name: 'Packsmart Solutions Ltd',
        slug: CUSTOMER_ZERO_WORKSPACE
      });
      const user = state.users.find(item => item.email === adminEmail && item.role === 'owner');
      if (!user) throw Object.assign(new Error('Packsmart owner account was not found'), { status: 404, code: 'OWNER_NOT_FOUND' });
      if (user.passwordHash || !user.passwordChangeRequired) {
        throw Object.assign(new Error('Owner activation has already been completed'), { status: 409, code: 'ACTIVATION_USED' });
      }
      user.passwordHash = passwordHash;
      user.passwordChangeRequired = false;
      user.sessionVersion = Number(user.sessionVersion || 1) + 1;
      user.updatedAt = new Date().toISOString();
      addAudit(state, { type: 'owner_account_activated', actor: user.id, detail: { sessionsRevoked: true } });
      await store.save(CUSTOMER_ZERO_WORKSPACE, state);
      return { state, user };
    });
    activationLimiter.reset(key);
    const token = createSessionToken({
      userId: result.user.id,
      workspaceId: CUSTOMER_ZERO_WORKSPACE,
      email: result.user.email,
      role: result.user.role,
      sessionVersion: result.user.sessionVersion
    }, env.SESSION_SECRET, clamp(env.SESSION_TTL_SECONDS, 900, 86400, 12 * 60 * 60));
    const session = verifySessionToken(token, env.SESSION_SECRET);
    send(res, 200, {
      workspace: result.state.workspace,
      user: publicUser(result.user),
      csrf: session.csrf,
      expiresAt: new Date(session.exp * 1000).toISOString()
    }, { 'Set-Cookie': sessionCookie(token, { secure: secureCookies, maxAge: session.exp - Math.floor(Date.now() / 1000) }) });
  }

  async function login(req, res) {
    if (!env.PACKSMART_ADMIN_PASSWORD || !env.SESSION_SECRET || String(env.SESSION_SECRET).length < 32) {
      send(res, 503, { error: 'Server authentication is not configured', code: 'AUTH_NOT_CONFIGURED' });
      return;
    }
    const body = await jsonBody(req, 32768);
    const email = normalizeEmail(body.email);
    const key = `${requestIp(req)}:${email}`;
    const rate = loginLimiter.check(key);
    if (!rate.allowed) {
      send(res, 429, { error: 'Too many sign-in attempts. Try again later.', code: 'LOGIN_RATE_LIMITED' }, {
        'Retry-After': String(Math.ceil(rate.retryAfterMs / 1000))
      });
      return;
    }
    if (!validEmail(email)) {
      loginLimiter.fail(key);
      send(res, 401, { error: 'Invalid email or password', code: 'LOGIN_FAILED' });
      return;
    }

    let found = await store.findUserByEmail(email);
    const adminEmail = normalizeEmail(env.PACKSMART_ADMIN_EMAIL || 'sales@packsmartsolutions.com');
    if (!found && email === adminEmail) {
      const state = await getOrSeed(store, CUSTOMER_ZERO_WORKSPACE, env, { email: adminEmail, name: 'Packsmart Solutions Ltd', slug: CUSTOMER_ZERO_WORKSPACE });
      found = { ...state.users[0], workspaceId: CUSTOMER_ZERO_WORKSPACE };
    }
    const state = found ? await store.get(found.workspaceId) : null;
    const user = state?.users?.find(item => item.id === found?.id);
    const suppliedPassword = String(body.password || '');
    const valid = Boolean(user?.active !== false && (
      user?.passwordHash
        ? verifyPassword(suppliedPassword, user.passwordHash)
        : found?.workspaceId === CUSTOMER_ZERO_WORKSPACE && email === adminEmail && safeEqual(suppliedPassword, env.PACKSMART_ADMIN_PASSWORD)
    ));
    if (!valid) {
      loginLimiter.fail(key);
      await new Promise(resolve => setTimeout(resolve, 120));
      send(res, 401, { error: 'Invalid email or password', code: 'LOGIN_FAILED' });
      return;
    }
    loginLimiter.reset(key);
    addAudit(state, { type: 'user_login', actor: user.id, detail: { method: user.passwordHash ? 'workspace-password' : 'customer-zero-bootstrap' } });
    await store.save(found.workspaceId, state);
    const token = createSessionToken({
      userId: user.id,
      workspaceId: found.workspaceId,
      email: user.email,
      role: user.role,
      sessionVersion: user.sessionVersion || 1
    }, env.SESSION_SECRET, clamp(env.SESSION_TTL_SECONDS, 900, 86400, 12 * 60 * 60));
    const session = verifySessionToken(token, env.SESSION_SECRET);
    send(res, 200, {
      workspace: state.workspace,
      user: publicUser(user),
      csrf: session.csrf,
      expiresAt: new Date(session.exp * 1000).toISOString()
    }, { 'Set-Cookie': sessionCookie(token, { secure: secureCookies, maxAge: session.exp - Math.floor(Date.now() / 1000) }) });
  }

  async function signup(req, res) {
    if (!truthy(env.BETA_SIGNUPS_ENABLED)) {
      send(res, 404, { error: 'Beta onboarding is not open yet', code: 'BETA_CLOSED' });
      return;
    }
    const body = await jsonBody(req, 65536);
    const email = normalizeEmail(body.email);
    const name = text(body.businessName, 120);
    if (!validEmail(email) || name.length < 2) throw Object.assign(new Error('Valid business name and email are required'), { status: 400, code: 'VALIDATION_FAILED' });
    if (await store.findUserByEmail(email)) throw Object.assign(new Error('An account already exists for this email'), { status: 409, code: 'ACCOUNT_EXISTS' });
    const passwordHash = hashPassword(body.password);
    const slugBase = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'workspace';
    const workspaceId = `${slugBase}-${crypto.randomBytes(4).toString('hex')}`;
    const state = seedWorkspaceState(env, { workspaceId, name, slug: workspaceId, email, passwordHash, plan: PLANS[body.plan] ? body.plan : 'starter' });
    state.users[0].passwordChangeRequired = false;
    addAudit(state, { type: 'beta_account_created', actor: state.users[0].id, detail: { plan: state.subscription.plan } });
    await store.save(workspaceId, state);
    const user = state.users[0];
    const token = createSessionToken({ userId: user.id, workspaceId, email, role: 'owner', sessionVersion: 1 }, env.SESSION_SECRET);
    const session = verifySessionToken(token, env.SESSION_SECRET);
    send(res, 201, { workspace: state.workspace, user: publicUser(user), csrf: session.csrf }, {
      'Set-Cookie': sessionCookie(token, { secure: secureCookies })
    });
  }

  async function stripeWebhook(req, res) {
    const raw = await rawBody(req, 2 * 1024 * 1024);
    if (!verifyStripeSignature(env, raw, req.headers['stripe-signature'])) {
      send(res, 400, { error: 'Invalid Stripe signature', code: 'STRIPE_SIGNATURE_INVALID' });
      return;
    }
    let event;
    try { event = JSON.parse(raw.toString('utf8')); }
    catch { throw Object.assign(new Error('Invalid Stripe event'), { status: 400, code: 'STRIPE_EVENT_INVALID' }); }
    const object = event?.data?.object || {};
    const workspaceId = text(object?.metadata?.workspace_id || object?.client_reference_id, 100);
    if (!workspaceId) {
      send(res, 200, { received: true, ignored: true });
      return;
    }
    const state = await store.get(workspaceId);
    if (!state || workspaceId === CUSTOMER_ZERO_WORKSPACE) {
      send(res, 200, { received: true, ignored: true });
      return;
    }
    if (event.type === 'checkout.session.completed') {
      state.subscription = {
        ...state.subscription,
        plan: object.metadata?.plan || state.subscription?.plan || 'unknown',
        status: 'checkout_completed',
        stripeCustomerId: object.customer || null,
        stripeSubscriptionId: object.subscription || null,
        updatedAt: new Date().toISOString()
      };
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      state.subscription = {
        ...state.subscription,
        plan: object.metadata?.plan || state.subscription?.plan || 'unknown',
        status: object.status || (event.type.endsWith('deleted') ? 'cancelled' : 'unknown'),
        stripeCustomerId: object.customer || state.subscription?.stripeCustomerId || null,
        stripeSubscriptionId: object.id || state.subscription?.stripeSubscriptionId || null,
        updatedAt: new Date().toISOString()
      };
    }
    addAudit(state, { type: 'stripe_webhook', actor: 'stripe', detail: { eventType: event.type } });
    await store.save(workspaceId, state);
    send(res, 200, { received: true });
  }

  const server = http.createServer(async (req, res) => {
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (req.method === 'GET' && pathname === '/api/health') {
        let persistence = false;
        try { persistence = await store.ping(); } catch {}
        const authConfigured = Boolean(env.PACKSMART_ADMIN_PASSWORD && env.SESSION_SECRET && String(env.SESSION_SECRET).length >= 32);
        const encryptionConfigured = Boolean(env.CREDENTIALS_KEY && String(env.CREDENTIALS_KEY).length >= 32);
        send(res, persistence ? 200 : 503, {
          ok: persistence,
          version: VERSION,
          storage: store.provider,
          productionReady: store.provider === 'supabase' && authConfigured && encryptionConfigured,
          checks: {
            persistence,
            authentication: authConfigured,
            credentialEncryption: encryptionConfigured,
            billingCharging: truthy(env.BILLING_CHECKOUT_ENABLED)
          }
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/webhooks/stripe') {
        await stripeWebhook(req, res);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/auth/activate-owner') {
        await activateOwner(req, res);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/auth/login') {
        await login(req, res);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/auth/signup') {
        await signup(req, res);
        return;
      }

      if (pathname.startsWith('/api/')) {
        const auth = await authenticate(req, res);
        if (!auth) return;
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) assertCsrf(req, auth.session, publicUrl);

        if (req.method === 'GET' && pathname === '/api/auth/session') {
          send(res, 200, { workspace: auth.state.workspace, user: publicUser(auth.user), csrf: auth.session.csrf, expiresAt: new Date(auth.session.exp * 1000).toISOString() });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/auth/logout') {
          addAudit(auth.state, { type: 'user_logout', actor: auth.user.id });
          await store.save(auth.session.workspaceId, auth.state);
          send(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie({ secure: secureCookies }) });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/auth/change-password') {
          requireOwner(auth);
          const body = await jsonBody(req, 32768);
          validatePassword(body.newPassword);
          if (!auth.user.passwordChangeRequired && !verifyPassword(body.currentPassword, auth.user.passwordHash)) {
            throw Object.assign(new Error('Current password is incorrect'), { status: 401, code: 'PASSWORD_INCORRECT' });
          }
          const result = await mutate(auth, async state => {
            const user = state.users.find(item => item.id === auth.user.id);
            user.passwordHash = hashPassword(body.newPassword);
            user.passwordChangeRequired = false;
            user.sessionVersion = Number(user.sessionVersion || 1) + 1;
            user.updatedAt = new Date().toISOString();
            addAudit(state, { type: 'owner_password_changed', actor: user.id, detail: { sessionsRevoked: true } });
            return user;
          });
          const token = createSessionToken({
            userId: result.id,
            workspaceId: auth.session.workspaceId,
            email: result.email,
            role: result.role,
            sessionVersion: result.sessionVersion
          }, env.SESSION_SECRET);
          const session = verifySessionToken(token, env.SESSION_SECRET);
          send(res, 200, { user: publicUser(result), csrf: session.csrf }, {
            'Set-Cookie': sessionCookie(token, { secure: secureCookies })
          });
          return;
        }

        if (req.method === 'GET' && pathname === '/api/bootstrap') {
          await refreshOperationalState(auth.state);
          const payload = bootstrapPayload(auth.state, auth.user, auth.session.csrf);
          await store.save(auth.session.workspaceId, auth.state);
          send(res, 200, payload);
          return;
        }

        if (req.method === 'POST' && pathname === '/api/migrate-pilot') {
          const body = await jsonBody(req, 512 * 1024);
          const migrationId = text(body.migrationId || 'browser-pilot-v1', 120);
          const result = await mutate(auth, async state => {
            if (state.migrations?.[migrationId]) return { alreadyMigrated: true, ...state.migrations[migrationId] };
            const economicsEntries = Object.entries(body.economics || {}).slice(0, 1000);
            let economicsImported = 0;
            for (const [rawSku, rawEconomics] of economicsEntries) {
              const sku = text(rawSku, 160);
              if (!sku || !rawEconomics || typeof rawEconomics !== 'object') continue;
              const incoming = cleanEconomics(rawEconomics);
              const existing = state.economics[sku] || {};
              const merged = { ...existing };
              for (const [field, value] of Object.entries(incoming)) {
                if ((merged[field] === '' || merged[field] === null || merged[field] === undefined) && value !== '') merged[field] = value;
              }
              state.economics[sku] = merged;
              economicsImported += 1;
            }
            let automationsImported = 0;
            for (const [id, enabled] of Object.entries(body.automations || {})) {
              if (!(id in state.automations)) continue;
              state.automations[id] = Boolean(enabled);
              automationsImported += 1;
            }
            const importedApprovals = Array.isArray(body.approvals) ? body.approvals.slice(0, 500) : [];
            for (const item of importedApprovals) {
              if (!item?.type || !APPROVAL_TYPES[item.type]) continue;
              state.approvals.push({
                id: `approval_migrated_${crypto.randomUUID()}`,
                type: item.type,
                action: text(item.action || APPROVAL_TYPES[item.type], 180),
                reason: text(item.reason || 'Migrated pilot approval record', 1000),
                financialImpact: Number.isFinite(Number(item.financialImpact)) ? Number(item.financialImpact) : null,
                expectedBenefit: text(item.expectedBenefit || 'Historical pilot record', 1000),
                risk: text(item.risk || 'Historical record; external execution disabled', 1000),
                requestedBy: auth.user.id,
                source: 'pilot-migration',
                payload: {},
                status: ['approved', 'rejected'].includes(item.status) ? item.status : 'pending',
                createdAt: item.createdAt || new Date().toISOString(),
                decidedAt: item.decidedAt || null,
                decidedBy: item.decidedBy || null,
                executedExternally: false,
                executionStatus: 'not_connected'
              });
            }
            const record = { economicsImported, automationsImported, approvalsImported: importedApprovals.length, migratedAt: new Date().toISOString() };
            state.migrations = { ...(state.migrations || {}), [migrationId]: record };
            addAudit(state, { type: 'pilot_data_migrated', actor: auth.user.id, detail: record });
            return record;
          });
          send(res, 200, result);
          return;
        }

        if (req.method === 'PUT' && pathname === '/api/economics') {
          const body = await jsonBody(req, 32768);
          const sku = text(body.sku, 160);
          if (!sku) throw Object.assign(new Error('SKU is required'), { status: 400, code: 'VALIDATION_FAILED' });
          const economics = cleanEconomics(body.economics);
          await mutate(auth, async state => {
            state.economics[sku] = economics;
            addAudit(state, { type: 'economics_updated', actor: auth.user.id, detail: { sku } });
          });
          send(res, 200, { sku, economics });
          return;
        }

        if (req.method === 'PUT' && pathname === '/api/automations') {
          const body = await jsonBody(req, 32768);
          const ruleId = text(body.id, 80);
          const result = await mutate(auth, async state => {
            if (!(ruleId in (state.automations || {}))) throw Object.assign(new Error('Unknown automation rule'), { status: 400, code: 'VALIDATION_FAILED' });
            state.automations[ruleId] = Boolean(body.enabled);
            addAudit(state, { type: 'automation_rule_updated', actor: auth.user.id, detail: { id: ruleId, enabled: state.automations[ruleId] } });
            return state.automations[ruleId];
          });
          send(res, 200, { id: ruleId, enabled: result });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/actions') {
          const body = await jsonBody(req, 128 * 1024);
          const approval = normalizeApprovalRequest(body, auth.user.id);
          await mutate(auth, async state => {
            state.approvals = [approval, ...(state.approvals || [])].slice(0, 1000);
            addAudit(state, { type: 'approval_requested', actor: auth.user.id, detail: { approvalId: approval.id, actionType: approval.type, financialImpact: approval.financialImpact } });
          });
          send(res, 202, { approvalRequired: true, approval, executedExternally: false });
          return;
        }

        const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
        if (req.method === 'POST' && approvalMatch) {
          requireOwner(auth);
          const body = await jsonBody(req, 32768);
          const decision = body.decision === 'approved' ? 'approved' : body.decision === 'rejected' ? 'rejected' : null;
          if (!decision) throw Object.assign(new Error('Decision must be approved or rejected'), { status: 400, code: 'VALIDATION_FAILED' });
          const result = await mutate(auth, async state => {
            const approval = (state.approvals || []).find(item => item.id === approvalMatch[1]);
            if (!approval) throw Object.assign(new Error('Approval request not found'), { status: 404, code: 'APPROVAL_NOT_FOUND' });
            if (approval.status !== 'pending') throw Object.assign(new Error('Approval already decided'), { status: 409, code: 'APPROVAL_ALREADY_DECIDED' });
            approval.status = decision;
            approval.decidedAt = new Date().toISOString();
            approval.decidedBy = auth.user.id;
            approval.decisionNote = text(body.note, 500) || null;
            approval.executedExternally = false;
            approval.executionStatus = 'not_connected';
            addAudit(state, { type: 'approval_decided', actor: auth.user.id, detail: { approvalId: approval.id, decision, executedExternally: false } });
            return approval;
          });
          send(res, 200, { approval: result, executedExternally: false });
          return;
        }

        if (req.method === 'GET' && pathname === '/api/approvals') {
          send(res, 200, { approvals: auth.state.approvals || [] });
          return;
        }

        if (req.method === 'GET' && pathname === '/api/audit') {
          const limit = clamp(url.searchParams.get('limit'), 1, 500, 250);
          send(res, 200, { events: (auth.state.audit || []).slice(0, limit) });
          return;
        }

        if (req.method === 'GET' && pathname === '/api/brief') {
          const brief = currentBrief(auth.state);
          await store.save(auth.session.workspaceId, auth.state);
          send(res, 200, { brief });
          return;
        }

        if (req.method === 'GET' && pathname === '/api/integrations') {
          send(res, 200, { integrations: integrationMatrix(auth.state, env), ebay: auth.state.ebay || null });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/integrations/shopify/sync') {
          const status = await mutate(auth, async state => {
            const result = await integrations.syncShopify(state);
            addAudit(state, { type: 'shopify_read_sync', actor: auth.user.id, detail: { status: result.status, source: result.source } });
            return result;
          });
          send(res, 200, { status, readOnly: true });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/integrations/ebay/sync') {
          const outcome = await mutate(auth, async state => {
            try {
              const result = await integrations.syncEbay(state);
              addAudit(state, { type: 'ebay_read_sync', actor: auth.user.id, detail: { status: result.status, account: result.account || null } });
              return { status: result, error: null };
            } catch (error) {
              const failedStatus = {
                status: 'error',
                detail: 'The existing eBay Manager could not be verified.',
                lastSyncAt: null,
                lastError: error.code || 'EBAY_SYNC_FAILED'
              };
              state.integrationStatus = {
                ...(state.integrationStatus || {}),
                ebay: failedStatus
              };
              addAudit(state, { type: 'ebay_read_sync_failed', actor: auth.user.id, detail: { code: error.code || 'EBAY_SYNC_FAILED' } });
              return { status: failedStatus, error: { status: error.status || 502, code: error.code || 'EBAY_SYNC_FAILED' } };
            }
          });
          if (outcome.error) {
            throw Object.assign(new Error('The existing eBay Manager could not be verified'), outcome.error);
          }
          send(res, 200, { status: outcome.status, readOnly: true, writesEnabled: false });
          return;
        }

        if (req.method === 'GET' && pathname === '/api/connections') {
          send(res, 200, { connections: (auth.state.connections || []).map(publicConnection) });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/connections') {
          requireOwner(auth);
          if (!env.CREDENTIALS_KEY || String(env.CREDENTIALS_KEY).length < 32) throw Object.assign(new Error('Credential encryption is not configured'), { status: 503, code: 'ENCRYPTION_NOT_CONFIGURED' });
          const body = await jsonBody(req, 128 * 1024);
          const provider = text(body.provider, 50).toLowerCase();
          if (!/^[a-z0-9_]+$/.test(provider) || !body.credentials || typeof body.credentials !== 'object' || Array.isArray(body.credentials)) {
            throw Object.assign(new Error('Provider and credentials are required'), { status: 400, code: 'VALIDATION_FAILED' });
          }
          const connection = await mutate(auth, async state => {
            const now = new Date().toISOString();
            const existing = (state.connections || []).find(item => item.provider === provider);
            const next = existing || { id: `conn_${crypto.randomUUID()}`, provider, createdAt: now };
            next.label = text(body.label || provider, 100);
            next.status = 'configured';
            next.capabilities = Array.isArray(body.capabilities) ? body.capabilities.map(item => text(item, 50)).slice(0, 20) : [];
            next.metadata = {};
            next.encryptedCredentials = encryptCredentials(body.credentials, env.CREDENTIALS_KEY);
            next.updatedAt = now;
            state.connections = [next, ...(state.connections || []).filter(item => item.id !== next.id)];
            addAudit(state, { type: 'connection_configured', actor: auth.user.id, detail: { provider } });
            return next;
          });
          send(res, 200, { connection: publicConnection(connection), verified: false });
          return;
        }

        if (req.method === 'GET' && pathname === '/api/billing') {
          send(res, 200, {
            subscription: auth.state.subscription,
            customerZeroFree: auth.session.workspaceId === CUSTOMER_ZERO_WORKSPACE,
            checkoutEnabled: truthy(env.BILLING_CHECKOUT_ENABLED) && auth.session.workspaceId !== CUSTOMER_ZERO_WORKSPACE,
            checkoutConfigured: stripeConfigured(env),
            plans: PLANS
          });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/billing/checkout') {
          requireOwner(auth);
          if (auth.session.workspaceId === CUSTOMER_ZERO_WORKSPACE) throw Object.assign(new Error('Packsmart customer-zero remains internal and free'), { status: 403, code: 'CUSTOMER_ZERO_FREE' });
          const body = await jsonBody(req, 32768);
          const plan = text(body.plan, 30).toLowerCase();
          if (!PLANS[plan]) throw Object.assign(new Error('Unknown subscription plan'), { status: 400, code: 'VALIDATION_FAILED' });
          const checkout = await createStripeCheckout(env, auth.session, plan);
          addAudit(auth.state, { type: 'billing_checkout_created', actor: auth.user.id, detail: { plan, checkoutSessionId: checkout.id } });
          await store.save(auth.session.workspaceId, auth.state);
          send(res, 200, checkout);
          return;
        }

        if (req.method === 'GET' && pathname === '/api/onboarding') {
          send(res, 200, onboardingState(auth.state, env));
          return;
        }

        send(res, 404, { error: 'API route not found', code: 'NOT_FOUND' });
        return;
      }

      if (req.method === 'GET' && await serveStatic(pathname, res)) return;
      send(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
    } catch (error) {
      const safe = sanitizeError(error);
      const path = String(req.url || '').split('?')[0].slice(0, 200);
      console.error(JSON.stringify({ event: 'request_error', requestId, method: req.method, path, status: safe.status, code: safe.code }));
      send(res, safe.status, { error: safe.publicMessage, code: safe.code });
    }
  });

  server.packsmart = { store, integrations, env };
  return server;
}

export async function start() {
  const port = Number(process.env.PORT || 8787);
  const server = createPacksmartServer(process.env);
  server.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ event: 'server_started', service: 'packsmart-ops', version: VERSION, port, storage: server.packsmart.store.provider }));
  });
  const shutdown = signal => {
    console.log(JSON.stringify({ event: 'server_stopping', signal }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) start();
