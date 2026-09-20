import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  SlidingWindowLimiter,
  assertCsrf,
  clearSessionCookie,
  createEbayOAuthStateToken,
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
  verifyEbayOAuthStateToken,
  verifyPassword,
  verifySessionToken
} from './lib/security.mjs';
import { IntegrationService } from './lib/integrations.mjs';
import { ECONOMICS_FIELDS, ECONOMICS_TEXT_FIELDS, calculateOrderProfit, hasAmount } from './lib/profit.mjs';
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
import { AGENT_DEFINITIONS, AUTONOMY_LEVELS, agentTeamSnapshot, recordAgentRun, runCommander } from './lib/agents.mjs';
import { configureAutopilot, controlSnapshot, detectExceptions, detectOpportunities, ensureControl, modifyApproval, putDecision, requestOpportunityApproval, setExceptionStatus } from './lib/control.mjs';
import { recordWork } from './lib/events.mjs';
import { createScheduler, monitoredSync } from './lib/scheduler.mjs';

const CUSTOMER_ZERO_WORKSPACE = 'packsmart-solutions';
const VERSION = '6.0.3';
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const STATIC_FILES = new Map([
  ['/', ['saas/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['saas/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['saas/app.js', 'text/javascript; charset=utf-8']],
  ['/control-ui.js', ['saas/control-ui.js', 'text/javascript; charset=utf-8']],
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
  for (const field of ECONOMICS_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const raw = value[field];
    if (raw === '' || raw === null || raw === undefined) clean[field] = '';
    else {
      const number = Number(raw);
      const maximum = ['marginFloor', 'supplierVatRate'].includes(field) ? 100 : field === 'boxQuantity' ? 100000000 : 1000000;
      if (!Number.isFinite(number) || number < 0 || number > maximum) {
        throw Object.assign(new Error(`Invalid ${field} value`), { status: 400, code: 'VALIDATION_FAILED' });
      }
      clean[field] = Number(number.toFixed(4));
    }
  }
  for (const field of ECONOMICS_TEXT_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    clean[field] = text(value[field], field === 'notes' ? 1000 : 160);
  }
  if (Object.hasOwn(value, 'supplierVatRecoverable')) {
    if (value.supplierVatRecoverable === '' || value.supplierVatRecoverable === null || value.supplierVatRecoverable === undefined) clean.supplierVatRecoverable = null;
    else if (value.supplierVatRecoverable === true || value.supplierVatRecoverable === 'true') clean.supplierVatRecoverable = true;
    else if (value.supplierVatRecoverable === false || value.supplierVatRecoverable === 'false') clean.supplierVatRecoverable = false;
    else throw Object.assign(new Error('Invalid supplier VAT recovery treatment'), { status: 400, code: 'VALIDATION_FAILED' });
  }
  return clean;
}

function cleanOrderCosts(value = {}) {
  const clean = {};
  for (const field of ['actualShippingCost', 'paymentFees', 'channelFees', 'advertisingCost', 'otherVariableCosts']) {
    if (!Object.hasOwn(value, field)) continue;
    const raw = value[field];
    if (raw === '' || raw === null || raw === undefined) clean[field] = null;
    else {
      const number = Number(raw);
      if (!Number.isFinite(number) || number < 0 || number > 10000000) throw Object.assign(new Error(`Invalid ${field} value`), { status: 400, code: 'VALIDATION_FAILED' });
      clean[field] = Number(number.toFixed(4));
    }
  }
  return clean;
}

function text(value, max = 200) {
  return String(value || '').trim().slice(0, max);
}

function cleanShopifyCredentials(value) {
  const storeDomain = text(value?.storeDomain, 253).toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const clientId = text(value?.clientId, 200);
  const clientSecret = String(value?.clientSecret || '').trim();
  const accessToken = String(value?.accessToken || '').trim();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(storeDomain)) {
    throw Object.assign(new Error('Enter the permanent .myshopify.com store domain'), { status: 400, code: 'SHOPIFY_DOMAIN_INVALID' });
  }
  if (accessToken) {
    if (clientId || clientSecret) throw Object.assign(new Error('Use either an Admin API access token or client credentials, not both'), { status: 400, code: 'SHOPIFY_AUTH_METHOD_AMBIGUOUS' });
    if (accessToken.length < 16 || accessToken.length > 512 || /\s/.test(accessToken)) {
      throw Object.assign(new Error('The Shopify Admin API access token is incomplete or contains spaces'), { status: 400, code: 'SHOPIFY_ACCESS_TOKEN_INVALID' });
    }
    return { storeDomain, accessToken };
  }
  if (!clientId) throw Object.assign(new Error('Enter the Shopify Client ID, or use an Admin API access token'), { status: 400, code: 'SHOPIFY_CLIENT_ID_REQUIRED' });
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(clientId)) throw Object.assign(new Error('The Shopify Client ID is incomplete or contains invalid characters'), { status: 400, code: 'SHOPIFY_CLIENT_ID_INVALID' });
  if (!clientSecret) throw Object.assign(new Error('Enter the Shopify Client secret'), { status: 400, code: 'SHOPIFY_CLIENT_SECRET_REQUIRED' });
  if (clientSecret.length < 16 || clientSecret.length > 512 || /\s/.test(clientSecret)) throw Object.assign(new Error('The Shopify Client secret is incomplete or contains spaces'), { status: 400, code: 'SHOPIFY_CLIENT_SECRET_INVALID' });
  return { storeDomain, clientId, clientSecret };
}

function cleanEbayCredentials(value) {
  let parsed;
  try { parsed = new URL(text(value?.baseUrl, 2048)); }
  catch { throw Object.assign(new Error('Enter the HTTPS URL of the existing eBay Manager backend'), { status: 400, code: 'EBAY_URL_INVALID' }); }
  const hostname = parsed.hostname.toLowerCase();
  const ipHostname = hostname.replace(/^\[|\]$/g, '');
  if (
    parsed.protocol !== 'https:' || parsed.username || parsed.password ||
    isIP(ipHostname) || hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') || hostname.endsWith('.internal')
  ) {
    throw Object.assign(new Error('The eBay Manager must use a public HTTPS URL without embedded credentials'), { status: 400, code: 'EBAY_URL_INVALID' });
  }
  const expectedAccount = text(value?.expectedAccount || 'packsmartsolutions20', 100);
  if (!/^[A-Za-z0-9._-]{2,100}$/.test(expectedAccount)) {
    throw Object.assign(new Error('Enter the expected eBay seller username'), { status: 400, code: 'EBAY_ACCOUNT_INVALID' });
  }
  const apiToken = String(value?.apiToken || '').trim();
  if (apiToken.length > 2048 || /[\r\n]/.test(apiToken)) {
    throw Object.assign(new Error('The eBay Manager API token is invalid'), { status: 400, code: 'EBAY_TOKEN_INVALID' });
  }
  return { baseUrl: parsed.origin, expectedAccount, apiToken };
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

function csvCell(value) {
  let string = value === null || value === undefined ? '' : String(value);
  if (typeof value === 'string' && /^[\s]*[=+@\-]/.test(string)) string = `'${string}`;
  return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

function accountingCsv(state) {
  const headings = [
    'order_id', 'order_date', 'channel', 'financial_status', 'gross_revenue', 'net_revenue',
    'vat_tax', 'refunds', 'shipping_charged', 'landed_cost', 'packing_cost', 'handling_cost',
    'actual_shipping_cost', 'payment_fees', 'channel_fees', 'advertising_cost', 'other_variable_cost',
    'gross_profit', 'operating_contribution', 'margin_percent', 'profit_basis', 'missing_inputs'
  ];
  const rows = (state.orders || []).map(order => {
    const profit = calculateOrderProfit(order, state.economics || {});
    return [
      order.name || order.id, order.createdAt, order.provider || 'shopify', order.financialStatus,
      profit.grossRevenue, profit.netRevenue, profit.tax, profit.refunds, profit.shippingCharged,
      profit.complete ? profit.breakdown.landed : null,
      profit.complete ? profit.breakdown.packing : null,
      profit.complete ? profit.breakdown.handling : null,
      profit.complete ? profit.breakdown.delivery : null,
      profit.complete ? profit.breakdown.paymentFee : null,
      profit.complete ? profit.breakdown.channelFee : null,
      profit.complete ? profit.breakdown.advertising : null,
      profit.complete ? profit.breakdown.otherVariable : null,
      profit.grossProfit, profit.contribution, profit.margin, profit.basis, profit.missingFields.join('; ')
    ].map(csvCell).join(',');
  });
  return [headings.join(','), ...rows].join('\r\n') + '\r\n';
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
  const apiLimiter = new SlidingWindowLimiter({ limit: 240, windowMs: 60000, blockMs: 60000 });
  const commandLimiter = new SlidingWindowLimiter({ limit: 10, windowMs: 60000, blockMs: 60000 });
  const startedAt = new Date().toISOString();

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

  function redirectHome(res, ebayResult) {
    const location = new URL('/', publicUrl);
    location.searchParams.set('ebay', ebayResult);
    res.writeHead(303, {
      ...headers('text/plain; charset=utf-8'),
      Location: location.toString()
    });
    res.end('Returning to Packsmart Ops');
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
    try {
      const parsed = JSON.parse(raw.toString('utf8'), (key, value) => {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Reserved key');
        return value;
      });
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Object required');
      return parsed;
    }
    catch { throw Object.assign(new Error('Invalid JSON'), { status: 400, code: 'JSON_INVALID' }); }
  }

  async function serveStatic(pathname, res, { head = false } = {}) {
    const item = STATIC_FILES.get(pathname);
    if (!item) return false;
    const [relative, contentType] = item;
    try {
      const body = await fs.readFile(new URL(relative, `file://${repoRoot}/`));
      const csp = "default-src 'self'; connect-src 'self'; img-src 'self' https://cdn.shopify.com data:; style-src 'self'; script-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";
      const cacheControl = ['/','/index.html','/app.js','/control-ui.js'].includes(pathname) ? 'no-cache' : 'public, max-age=300';
      res.writeHead(200, {
        ...headers(contentType, cacheControl),
        'Content-Security-Policy': csp
      });
      res.end(head ? undefined : body);
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

  function requireApprover(auth) {
    if (auth.user.role !== 'owner') throw Object.assign(new Error('Workspace owner approval required'), { status: 403, code: 'OWNER_APPROVAL_REQUIRED' });
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
      const currentUser = state.users.find(item => item.id === auth.user.id);
      if (!currentUser || currentUser.active === false || currentUser.role !== auth.user.role || Number(currentUser.sessionVersion || 1) !== Number(auth.session.sessionVersion || 1)) throw Object.assign(new Error('Session changed; sign in again'), { status: 401, code: 'SESSION_INVALID' });
      const result = await callback(state);
      await store.save(auth.session.workspaceId, state);
      return result;
    });
  }

  async function refreshOperationalState(state, { force = false } = {}) {
    const lastShopify = Date.parse(state.integrationStatus?.shopify?.lastSyncAt || 0);
    const stale = !Number.isFinite(lastShopify) || Date.now() - lastShopify > clamp(env.SYNC_INTERVAL_MS, 60000, 86400000, 15 * 60 * 1000);
    const shopifyRefreshAvailable = integrations.shopifyRefreshAvailable(state);
    const needsLiveCatalogueUpgrade = state.integrationStatus?.shopify?.source === 'repository-snapshot' &&
      Boolean(integrations.shopifyPublicCatalogueUrl(state)) &&
      !state.integrationStatus?.shopify?.publicAttemptedAt;
    if (shopifyRefreshAvailable && (force || !state.products?.length || stale || needsLiveCatalogueUpgrade)) {
      const previous = state.integrationStatus?.shopify || {};
      if (!force && (/AUTH|CREDENTIAL|TOKEN_EXPIRED/.test(previous.lastError || '') || Date.now() - Date.parse(previous.lastFailureAt || 0) < 15 * 60000)) return false;
      try { await monitoredSync(state, integrations, 'shopify', { automatic: !force }); }
      catch (error) {
        state.integrationStatus = {
          ...(state.integrationStatus || {}),
          shopify: {
            ...state.integrationStatus?.shopify,
            status: /AUTH|CREDENTIAL|TOKEN_EXPIRED/.test(error.code || '') ? 'auth_expired' : state.products?.length ? 'degraded' : 'error',
            detail: state.products?.length ? 'Last known catalogue retained after a live sync error.' : 'Shopify data is unavailable.',
            lastSyncAt: state.integrationStatus?.shopify?.lastSyncAt || null,
            lastError: error.code || 'SHOPIFY_SYNC_FAILED'
          }
        };
      }
      return true;
    }
    return false;
  }

  function briefSourceSignature(state) {
    const source = {
      products: state.products || [],
      orders: state.orders || [],
      economics: state.economics || {},
      advertisingCosts: state.advertisingCosts || [],
      approvals: state.approvals || [],
      integrationStatus: Object.fromEntries(Object.entries(state.integrationStatus || {}).map(([key, value]) => [key, { status: value.status, source: value.source, lastError: value.lastError, lastSyncAt: ['supabase', 'reporting', 'render'].includes(key) ? null : value.lastSyncAt }])),
      automations: state.automations || {},
      suppliers: state.suppliers || [],
      decisions: (state.decisions || []).filter(item => item.status === 'active').map(item => item.id),
      exceptions: (state.exceptions || []).map(item => [item.id, item.status]),
      automationFailures: (state.automationRuns || []).filter(item => ['FAILED', 'BLOCKED'].includes(item.status)).map(item => item.id)
    };
    return crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex').slice(0, 32);
  }

  function currentBrief(state) {
    const today = new Date().toISOString().slice(0, 10);
    const sourceSignature = briefSourceSignature(state);
    const existing = (state.dailyBriefs || []).find(brief =>
      String(brief.generatedAt || '').startsWith(today) &&
      brief.logic === 'deterministic-v2' &&
      brief.sourceSignature === sourceSignature
    );
    if (existing) return existing;
    const brief = { ...buildDailyBrief(state, {
      lowStockThreshold: state.settings?.lowStockThreshold ?? clamp(env.LOW_STOCK_THRESHOLD, 0, 100000, 20),
      marginFloor: state.settings?.marginFloor ?? clamp(env.MARGIN_FLOOR_PERCENT, 0, 100, 20)
    }), sourceSignature };
    brief.attention = { exceptions: (state.exceptions || []).filter(item => ['open', 'acknowledged'].includes(item.status)).length,
      approvals: (state.approvals || []).filter(item => item.status === 'pending').length,
      failedAutomations: (state.automationRuns || []).filter(item => ['FAILED', 'BLOCKED'].includes(item.status) && item.startedAt.startsWith(today)).length,
      opportunities: (state.opportunities || []).filter(item => item.present && item.status === 'open').length };
    brief.summary += ` ${brief.attention.exceptions} open exceptions; ${brief.attention.failedAutomations} failed or blocked automations today; ${brief.attention.opportunities} opportunities to review.`;
    state.dailyBriefs = [brief, ...(state.dailyBriefs || [])];
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
      suppliers: state.suppliers || [],
      costHistory: state.costHistory || [],
      advertisingCosts: state.advertisingCosts || [],
      shippingProviders: state.shippingProviders || [],
      settings: state.settings || {},
      automations: state.automations || {},
      automationDefinitions: AUTOMATION_DEFINITIONS,
      approvals: state.approvals || [],
      subscription: state.subscription || null,
      connections: (state.connections || []).map(publicConnection),
      integrations: integrationMatrix(state, env),
      ebayOAuth: integrations.ebayOAuthStatus(state),
      ebay: state.ebay || null,
      dashboard: deriveOperations(state, {
        lowStockThreshold: clamp(env.LOW_STOCK_THRESHOLD, 0, 100000, 20),
        marginFloor: clamp(env.MARGIN_FLOOR_PERCENT, 0, 100, 20)
      }),
      brief,
      onboarding: onboardingState(state, env),
      aiTeam: agentTeamSnapshot(state),
      agentDefinitions: AGENT_DEFINITIONS,
      autonomyLevels: AUTONOMY_LEVELS,
      agentActivity: (state.agentActivity || []).slice(0, 100),
      agentRuns: (state.agentRuns || []).slice(0, 20),
      storage: store.provider,
      ...controlSnapshot(state)
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
    if (!env.SESSION_SECRET || String(env.SESSION_SECRET).length < 32) {
      send(res, 503, { error: 'Server authentication is not configured', code: 'AUTH_NOT_CONFIGURED' });
      return;
    }
    const body = await jsonBody(req, 32768);
    const email = normalizeEmail(body.email);
    const key = crypto.createHash('sha256').update(email).digest('hex');
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
        : Boolean(env.PACKSMART_ADMIN_PASSWORD) && found?.workspaceId === CUSTOMER_ZERO_WORKSPACE && email === adminEmail && safeEqual(suppliedPassword, env.PACKSMART_ADMIN_PASSWORD)
    ));
    if (!valid) {
      loginLimiter.fail(key);
      await new Promise(resolve => setTimeout(resolve, 120));
      send(res, 401, { error: 'Invalid email or password', code: 'LOGIN_FAILED' });
      return;
    }
    loginLimiter.reset(key);
    await withWorkspaceLock(found.workspaceId, async () => {
      const fresh = await store.get(found.workspaceId);
      const current = fresh?.users.find(item => item.id === user.id);
      if (!current || current.active === false || current.passwordHash !== user.passwordHash || current.sessionVersion !== user.sessionVersion) throw Object.assign(new Error('Account changed; sign in again'), { status: 401, code: 'SESSION_INVALID' });
      addAudit(fresh, { type: 'user_login', actor: user.id, detail: { method: user.passwordHash ? 'workspace-password' : 'customer-zero-bootstrap' } });
      await store.save(found.workspaceId, fresh);
    });
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

  async function ebayOAuthCallback(url, res) {
    const token = String(url.searchParams.get('state') || '');
    const oauthState = verifyEbayOAuthStateToken(token, env.SESSION_SECRET);
    if (!oauthState) {
      send(res, 400, { error: 'eBay connection request is invalid or expired', code: 'EBAY_OAUTH_STATE_INVALID' });
      return;
    }

    await withWorkspaceLock(oauthState.workspaceId, async () => {
      const state = await store.get(oauthState.workspaceId);
      const challenge = state?.oauthChallenges?.find(item =>
        item.provider === 'ebay' && item.nonce === oauthState.nonce && item.userId === oauthState.userId
      );
      const user = state?.users?.find(item => item.id === oauthState.userId && item.active !== false);
      if (!state || !challenge || Date.parse(challenge.expiresAt || 0) <= Date.now() || !user || !['owner', 'admin'].includes(user.role)) {
        send(res, 400, { error: 'eBay connection request is invalid or expired', code: 'EBAY_OAUTH_CHALLENGE_INVALID' });
        return;
      }

      state.oauthChallenges = (state.oauthChallenges || []).filter(item => item.nonce !== oauthState.nonce);
      if (url.searchParams.get('error')) {
        addAudit(state, { type: 'ebay_oauth_declined', actor: user.id, detail: { readOnly: true } });
        await store.save(oauthState.workspaceId, state);
        redirectHome(res, 'declined');
        return;
      }

      const code = String(url.searchParams.get('code') || '');
      if (!code) {
        addAudit(state, { type: 'ebay_oauth_failed', actor: user.id, detail: { code: 'EBAY_AUTHORIZATION_CODE_MISSING' } });
        await store.save(oauthState.workspaceId, state);
        redirectHome(res, 'error');
        return;
      }

      try {
        const authorization = await integrations.exchangeEbayAuthorizationCode(code);
        const identity = await integrations.ebayIdentity(authorization.accessToken);
        const account = String(identity.username || '');
        const expectedAccount = String(env.EBAY_EXPECTED_ACCOUNT || 'packsmartsolutions20');
        if (!account || account.toLowerCase() !== expectedAccount.toLowerCase()) {
          throw Object.assign(new Error('Unexpected eBay seller account'), { status: 403, code: 'EBAY_ACCOUNT_MISMATCH' });
        }
        const now = new Date().toISOString();
        const marketplaceId = String(env.EBAY_MARKETPLACE_ID || 'EBAY_GB');
        const existing = (state.connections || []).find(item => item.provider === 'ebay_oauth');
        const connection = existing || { id: `conn_${crypto.randomUUID()}`, provider: 'ebay_oauth', createdAt: now };
        connection.label = 'eBay read-only OAuth';
        connection.status = 'configured';
        connection.capabilities = ['identity', 'inventory', 'listings', 'drafts', 'orders', 'fees', 'promotions'];
        connection.metadata = { account, marketplaceId, listingCount: 0, draftCount: 0, channel: 'direct_oauth' };
        connection.lastError = null;
        connection.encryptedCredentials = encryptCredentials({
          mode: 'direct_oauth',
          refreshToken: authorization.refreshToken,
          scopes: authorization.scopes,
          expectedAccount,
          marketplaceId,
          refreshTokenExpiresAt: authorization.refreshTokenExpiresIn > 0
            ? new Date(Date.now() + authorization.refreshTokenExpiresIn * 1000).toISOString()
            : null
        }, env.CREDENTIALS_KEY);
        connection.updatedAt = now;
        state.connections = [connection, ...(state.connections || []).filter(item => item.id !== connection.id)];
        addAudit(state, { type: 'ebay_oauth_connected', actor: user.id, detail: { account, marketplaceId, readOnly: true, existingManagerPreserved: true } });
        try {
          const status = await integrations.syncEbay(state);
          addAudit(state, { type: 'ebay_read_sync', actor: user.id, detail: { status: status.status, source: status.source || 'manager' } });
        } catch (syncError) {
          connection.status = 'error';
          connection.lastError = syncError.code || 'EBAY_SYNC_FAILED';
          state.integrationStatus = {
            ...(state.integrationStatus || {}),
            ebay: { status: 'error', detail: 'eBay authorization was saved, but its first read sync needs retrying.', lastSyncAt: null, lastError: connection.lastError }
          };
          addAudit(state, { type: 'ebay_read_sync_failed', actor: user.id, detail: { code: connection.lastError } });
        }
        await store.save(oauthState.workspaceId, state);
        redirectHome(res, 'connected');
      } catch (error) {
        addAudit(state, { type: 'ebay_oauth_failed', actor: user.id, detail: { code: error.code || 'EBAY_OAUTH_FAILED' } });
        await store.save(oauthState.workspaceId, state);
        redirectHome(res, error.code === 'EBAY_ACCOUNT_MISMATCH' ? 'account-mismatch' : 'error');
      }
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
    await withWorkspaceLock(workspaceId, async () => {
      const state = await store.get(workspaceId);
      if (!state || workspaceId === CUSTOMER_ZERO_WORKSPACE) {
        send(res, 200, { received: true, ignored: true });
        return;
      }
      if (!event.id || !Number.isFinite(event.created)) throw Object.assign(new Error('Invalid Stripe event identity'), { status: 400, code: 'STRIPE_EVENT_INVALID' });
      state.billingEvents ||= [];
      if (state.billingEvents.some(item => item.id === event.id)) { send(res, 200, { received: true, duplicate: true }); return; }
      const outdated = event.created < (state.subscription?.lastEventCreated || 0);
      if (!outdated && event.type === 'checkout.session.completed') {
        state.subscription = {
          ...state.subscription,
          plan: object.metadata?.plan || state.subscription?.plan || 'unknown',
          status: 'checkout_completed',
          stripeCustomerId: object.customer || null,
          stripeSubscriptionId: object.subscription || null,
          updatedAt: new Date().toISOString()
        };
      } else if (!outdated && (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted')) {
        state.subscription = {
          ...state.subscription,
          plan: object.metadata?.plan || state.subscription?.plan || 'unknown',
          status: object.status || (event.type.endsWith('deleted') ? 'cancelled' : 'unknown'),
          stripeCustomerId: object.customer || state.subscription?.stripeCustomerId || null,
          stripeSubscriptionId: object.id || state.subscription?.stripeSubscriptionId || null,
          updatedAt: new Date().toISOString()
        };
      }
      state.billingEvents.push({ id: event.id, created: event.created, type: event.type, ignored: outdated });
      if (!outdated) state.subscription.lastEventCreated = event.created;
      addAudit(state, { type: 'stripe_webhook', actor: 'stripe', detail: { eventId: event.id, eventType: event.type, outdated } });
      await store.save(workspaceId, state);
      send(res, 200, { received: true });
    });
  }

  const server = http.createServer(async (req, res) => {
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (['GET', 'HEAD'].includes(req.method) && pathname === '/api/health') {
        let persistence = false;
        try { persistence = await store.ping(); } catch {}
        const authConfigured = Boolean(env.SESSION_SECRET && String(env.SESSION_SECRET).length >= 32);
        const encryptionConfigured = Boolean(env.CREDENTIALS_KEY && String(env.CREDENTIALS_KEY).length >= 32);
        const ready = persistence && (!isProduction || (store.provider === 'supabase' && authConfigured && encryptionConfigured));
        send(res, ready ? 200 : 503, req.method === 'HEAD' ? '' : {
          ok: ready,
          version: VERSION,
          commit: env.RENDER_GIT_COMMIT || null,
          startedAt,
          storage: store.provider,
          productionReady: persistence && store.provider === 'supabase' && authConfigured && encryptionConfigured,
          checks: {
            persistence,
            authentication: authConfigured,
            credentialEncryption: encryptionConfigured,
            billingCharging: truthy(env.BILLING_CHECKOUT_ENABLED)
          }
        });
        return;
      }

      if (isProduction && pathname.startsWith('/api/') && store.provider !== 'supabase') throw Object.assign(new Error('Durable persistence must be configured before using production'), { status: 503, code: 'PERSISTENCE_REQUIRED' });

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
      if (req.method === 'GET' && pathname === '/api/integrations/ebay/oauth/callback') {
        await ebayOAuthCallback(url, res);
        return;
      }

      if (pathname.startsWith('/api/')) {
        const auth = await authenticate(req, res);
        if (!auth) return;
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) assertCsrf(req, auth.session, publicUrl);
        const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
        if (auth.user.passwordChangeRequired && !['/api/auth/session', '/api/auth/logout', '/api/auth/change-password'].includes(pathname)) throw Object.assign(new Error('Replace the temporary password before accessing business data'), { status: 403, code: 'PASSWORD_CHANGE_REQUIRED' });
        if (mutating && auth.user.role === 'viewer' && !['/api/auth/logout', '/api/auth/change-password'].includes(pathname)) throw Object.assign(new Error('Read-only workspace access'), { status: 403, code: 'ROLE_DENIED' });
        const rateKey = `${auth.session.workspaceId}:${auth.user.id}`;
        const rate = apiLimiter.check(rateKey);
        if (!rate.allowed) throw Object.assign(new Error('Request limit reached; try again shortly'), { status: 429, code: 'API_RATE_LIMITED' });
        apiLimiter.fail(rateKey);

        if (req.method === 'GET' && pathname === '/api/auth/session') {
          send(res, 200, { workspace: auth.state.workspace, user: publicUser(auth.user), csrf: auth.session.csrf, expiresAt: new Date(auth.session.exp * 1000).toISOString() });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/auth/logout') {
          await mutate(auth, async state => {
            const user = state.users.find(item => item.id === auth.user.id);
            user.sessionVersion = Number(user.sessionVersion || 1) + 1;
            addAudit(state, { type: 'user_logout', actor: auth.user.id, detail: { sessionsRevoked: true } });
          });
          send(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie({ secure: secureCookies }) });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/auth/change-password') {
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
          const payload = await withWorkspaceLock(auth.session.workspaceId, async () => {
            const state = await store.get(auth.session.workspaceId);
            const briefIdsBefore = new Set((state.dailyBriefs || []).map(item => item.id));
            const operationalStateChanged = await refreshOperationalState(state);
            ensureControl(state);
            const signature = briefSourceSignature(state);
            const controlChanged = state.controlSignature !== signature;
            if (controlChanged) { detectExceptions(state); detectOpportunities(state); }
            const payload = bootstrapPayload(state, auth.user, auth.session.csrf);
            state.controlSignature = briefSourceSignature(state);
            if (operationalStateChanged || controlChanged || !briefIdsBefore.has(payload.brief.id)) await store.save(auth.session.workspaceId, state);
            return payload;
          });
          send(res, 200, payload);
          return;
        }

        if (req.method === 'POST' && pathname === '/api/migrate-pilot') {
          requireOwner(auth);
          if (auth.session.workspaceId !== CUSTOMER_ZERO_WORKSPACE) throw Object.assign(new Error('Pilot migration belongs to customer-zero'), { status: 403, code: 'MIGRATION_SCOPE_DENIED' });
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
              if (!Object.hasOwn(state.automations, id)) continue;
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
                status: 'pending',
                createdAt: item.createdAt || new Date().toISOString(),
                decidedAt: null,
                decidedBy: null,
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
          requireOwner(auth);
          const body = await jsonBody(req, 32768);
          const sku = text(body.sku, 160);
          if (!sku) throw Object.assign(new Error('SKU is required'), { status: 400, code: 'VALIDATION_FAILED' });
          const incoming = cleanEconomics(body.economics);
          const economics = await mutate(auth, async state => {
            const before = { ...(state.economics[sku] || {}) };
            const next = { ...before, ...incoming, updatedAt: new Date().toISOString() };
            const changedFields = Object.keys(incoming).filter(field => JSON.stringify(before[field]) !== JSON.stringify(next[field]));
            state.economics[sku] = next;
            if (changedFields.length) {
              state.costHistory = [{
                id: `cost_${crypto.randomUUID()}`,
                sku,
                changedBy: auth.user.id,
                changedFields,
                before: Object.fromEntries(changedFields.map(field => [field, before[field] ?? null])),
                after: Object.fromEntries(changedFields.map(field => [field, next[field] ?? null])),
                createdAt: next.updatedAt
              }, ...(state.costHistory || [])];
              addAudit(state, { type: 'economics_updated', actor: auth.user.id, detail: { sku, changedFields } });
            }
            return next;
          });
          send(res, 200, { sku, economics });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/suppliers') {
          requireOwner(auth);
          const body = await jsonBody(req, 32768);
          const name = text(body.name, 120);
          if (name.length < 2) throw Object.assign(new Error('Supplier name is required'), { status: 400, code: 'VALIDATION_FAILED' });
          const supplier = await mutate(auth, async state => {
            if ((state.suppliers || []).some(item => item.name.toLowerCase() === name.toLowerCase())) throw Object.assign(new Error('This supplier already exists'), { status: 409, code: 'SUPPLIER_EXISTS' });
            const now = new Date().toISOString();
            const next = { id: `supplier_${crypto.randomUUID()}`, name, active: true, notes: text(body.notes, 1000), createdAt: now, updatedAt: now };
            state.suppliers = [...(state.suppliers || []), next];
            addAudit(state, { type: 'supplier_created', actor: auth.user.id, detail: { supplierId: next.id, name: next.name } });
            return next;
          });
          send(res, 201, { supplier });
          return;
        }

        const supplierMatch = pathname.match(/^\/api\/suppliers\/([^/]+)$/);
        if (req.method === 'PUT' && supplierMatch) {
          requireOwner(auth);
          const body = await jsonBody(req, 32768);
          const supplier = await mutate(auth, async state => {
            const current = (state.suppliers || []).find(item => item.id === supplierMatch[1]);
            if (!current) throw Object.assign(new Error('Supplier not found'), { status: 404, code: 'SUPPLIER_NOT_FOUND' });
            if (Object.hasOwn(body, 'name')) {
              const name = text(body.name, 120);
              if (name.length < 2) throw Object.assign(new Error('Supplier name is required'), { status: 400, code: 'VALIDATION_FAILED' });
              current.name = name;
            }
            if (Object.hasOwn(body, 'notes')) current.notes = text(body.notes, 1000);
            if (Object.hasOwn(body, 'active')) current.active = Boolean(body.active);
            current.updatedAt = new Date().toISOString();
            addAudit(state, { type: 'supplier_updated', actor: auth.user.id, detail: { supplierId: current.id } });
            return current;
          });
          send(res, 200, { supplier });
          return;
        }

        const orderEconomicsMatch = pathname.match(/^\/api\/orders\/([^/]+)\/economics$/);
        if (req.method === 'PUT' && orderEconomicsMatch) {
          requireOwner(auth);
          const body = await jsonBody(req, 32768);
          const costs = cleanOrderCosts(body);
          const result = await mutate(auth, async state => {
            const order = (state.orders || []).find(item => item.id === decodeURIComponent(orderEconomicsMatch[1]));
            if (!order) throw Object.assign(new Error('Order not found'), { status: 404, code: 'ORDER_NOT_FOUND' });
            Object.assign(order, costs, { costUpdatedAt: new Date().toISOString() });
            order.costOverrides = { ...order.costOverrides, ...costs };
            addAudit(state, { type: 'order_costs_updated', actor: auth.user.id, detail: { orderId: order.id, changedFields: Object.keys(costs) } });
            return { order, profitability: calculateOrderProfit(order, state.economics || {}) };
          });
          send(res, 200, result);
          return;
        }

        if (req.method === 'POST' && pathname === '/api/advertising-costs') {
          requireOwner(auth);
          const body = await jsonBody(req, 32768);
          const channel = text(body.channel, 50).toLowerCase();
          if (!/^[a-z0-9_]+$/.test(channel) || !hasAmount(body.spend)) throw Object.assign(new Error('Channel and spend are required'), { status: 400, code: 'VALIDATION_FAILED' });
          const spend = Number(body.spend);
          const attributableRevenue = body.attributableRevenue === '' || body.attributableRevenue === null || body.attributableRevenue === undefined ? null : Number(body.attributableRevenue);
          const periodTimestamp = body.date ? Date.parse(body.date) : Date.now();
          if (spend < 0 || spend > 10000000 || !Number.isFinite(periodTimestamp) || (attributableRevenue !== null && (!Number.isFinite(attributableRevenue) || attributableRevenue < 0 || attributableRevenue > 100000000))) throw Object.assign(new Error('Advertising amounts or date are invalid'), { status: 400, code: 'VALIDATION_FAILED' });
          const record = await mutate(auth, async state => {
            const now = new Date().toISOString();
            const next = { id: `adcost_${crypto.randomUUID()}`, channel, spend: Number(spend.toFixed(2)), attributableRevenue: attributableRevenue === null ? null : Number(attributableRevenue.toFixed(2)), date: new Date(periodTimestamp).toISOString(), source: 'manual', createdAt: now, updatedAt: now };
            state.advertisingCosts = [next, ...(state.advertisingCosts || [])].slice(0, 5000);
            addAudit(state, { type: 'advertising_cost_recorded', actor: auth.user.id, detail: { recordId: next.id, channel, spend: next.spend } });
            return next;
          });
          send(res, 201, { record });
          return;
        }

        if (req.method === 'PUT' && pathname === '/api/automations') {
          requireOwner(auth);
          const body = await jsonBody(req, 32768);
          const ruleId = text(body.id, 80);
          const result = await mutate(auth, async state => {
            if (!Object.hasOwn(state.automations || {}, ruleId) || typeof body.enabled !== 'boolean') throw Object.assign(new Error('Known rule and boolean enabled value are required'), { status: 400, code: 'VALIDATION_FAILED' });
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
            state.approvals = [approval, ...(state.approvals || [])];
            addAudit(state, { type: 'approval_requested', actor: auth.user.id, detail: { approvalId: approval.id, actionType: approval.type, financialImpact: approval.financialImpact } });
          });
          send(res, 202, { approvalRequired: true, approval, executedExternally: false });
          return;
        }

        const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
        if (req.method === 'POST' && approvalMatch) {
          requireApprover(auth);
          const body = await jsonBody(req, 32768);
          const decision = body.decision === 'approved' ? 'approved' : body.decision === 'rejected' ? 'rejected' : null;
          if (!decision) throw Object.assign(new Error('Decision must be approved or rejected'), { status: 400, code: 'VALIDATION_FAILED' });
          const result = await mutate(auth, async state => {
            const approval = (state.approvals || []).find(item => item.id === approvalMatch[1]);
            if (!approval) throw Object.assign(new Error('Approval request not found'), { status: 404, code: 'APPROVAL_NOT_FOUND' });
            if (approval.status !== 'pending') throw Object.assign(new Error('Approval already decided'), { status: 409, code: 'APPROVAL_ALREADY_DECIDED' });
            if ((body.revision ?? 1) !== (approval.revision || 1)) throw Object.assign(new Error('Approval changed; review its current revision'), { status: 409, code: 'APPROVAL_CONFLICT' });
            approval.status = decision;
            approval.decidedAt = new Date().toISOString();
            approval.decidedBy = auth.user.id;
            approval.decisionNote = text(body.note, 500) || null;
            approval.executedExternally = false;
            approval.executionStatus = 'not_connected';
            approval.workStatus = decision === 'approved' ? 'BLOCKED' : 'COMPLETED';
            approval.history = [...(approval.history || []), { revision: approval.revision || 1, status: decision, actor: auth.user.id, at: approval.decidedAt, note: approval.decisionNote }];
            recordWork(state, { id: approval.id, title: approval.action, source: 'approval-centre', status: decision === 'approved' ? 'BLOCKED' : 'COMPLETED',
              evidence: [{ type: 'approval_decision', id: approval.id, detail: `${decision}; external execution unavailable` }], executedExternally: false });
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
          const brief = await withWorkspaceLock(auth.session.workspaceId, async () => {
            const state = await store.get(auth.session.workspaceId);
            const previous = state.dailyBriefs?.[0]?.id;
            const value = currentBrief(state);
            if (previous !== value.id) await store.save(auth.session.workspaceId, state);
            return value;
          });
          send(res, 200, { brief });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/agents/command') {
          const rate = commandLimiter.check(rateKey);
          if (!rate.allowed) throw Object.assign(new Error('Commander frequency limit reached'), { status: 429, code: 'COMMAND_RATE_LIMITED' });
          commandLimiter.fail(rateKey);
          const body = await jsonBody(req, 32768);
          const command = text(body.command, 1000);
          if (!command) throw Object.assign(new Error('Command required'), { status: 400, code: 'COMMAND_REQUIRED' });
          const runId = `agent_run_${crypto.randomUUID()}`;
          await mutate(auth, async state => { recordWork(state, { id: runId, title: command, source: 'commander', status: 'IN PROGRESS', evidence: [] }); });
          try {
          const run = await mutate(auth, async state => {
            const next = await runCommander(state, command, {
              actor: auth.user.id, runId, lowStockThreshold: state.settings?.lowStockThreshold ?? 20,
              marginFloor: state.settings?.marginFloor ?? 20
            });
            recordAgentRun(state, next, auth.user.id);
            addAudit(state, { type: 'commander_run_completed', actor: auth.user.id, detail: { runId: next.id, routedAgents: next.routedAgents, status: next.status } });
            return next;
          });
          send(res, 200, { run, executedExternally: false });
          } catch (error) {
            try { await mutate(auth, async state => recordWork(state, { id: runId, title: command, source: 'commander', status: error.code === 'COMMANDER_DISABLED' ? 'BLOCKED' : 'FAILED', errorCode: error.code || 'COMMAND_FAILED', evidence: [{ type: 'command_failure', id: runId, detail: error.code || 'COMMAND_FAILED' }] })); }
            catch { /* A failed persistence write cannot be claimed as completed. */ }
            throw error;
          }
          return;
        }

        if (req.method === 'GET' && pathname === '/api/agents') {
          send(res, 200, { team: agentTeamSnapshot(auth.state), activity: (auth.state.agentActivity || []).slice(0, 250), runs: (auth.state.agentRuns || []).slice(0, 50), autonomyLevels: AUTONOMY_LEVELS });
          return;
        }

        if (req.method === 'GET' && pathname === '/api/control') {
          send(res, 200, { ...controlSnapshot(auth.state), scheduler: scheduler.status }); return;
        }
        if (req.method === 'GET' && pathname === '/api/briefs') {
          send(res, 200, { briefs: auth.state.dailyBriefs || [] }); return;
        }
        const historicalBrief = pathname.match(/^\/api\/briefs\/([^/]+)$/);
        if (req.method === 'GET' && historicalBrief) {
          const brief = await store.getBrief(auth.session.workspaceId, historicalBrief[1]);
          if (!brief) throw Object.assign(new Error('Brief not found'), { status: 404, code: 'BRIEF_NOT_FOUND' });
          send(res, 200, { brief }); return;
        }
        if (req.method === 'PUT' && pathname === '/api/autopilot') {
          requireOwner(auth);
          const body = await jsonBody(req, 32768);
          const autopilot = await mutate(auth, async state => configureAutopilot(state, body, auth.user.id));
          send(res, 200, { autopilot }); return;
        }
        if (req.method === 'POST' && pathname === '/api/autopilot/run') {
          requireOwner(auth);
          send(res, 200, await scheduler.runWorkspace(auth.session.workspaceId, { manual: true })); return;
        }
        if (req.method === 'POST' && pathname === '/api/decision-memory') {
          requireOwner(auth);
          const body = await jsonBody(req, 16384);
          const decision = await mutate(auth, async state => putDecision(state, body, auth.user.id));
          send(res, 201, { decision }); return;
        }
        const decisionMemoryMatch = pathname.match(/^\/api\/decision-memory\/([^/]+)$/);
        if (req.method === 'PUT' && decisionMemoryMatch) {
          requireOwner(auth);
          const body = await jsonBody(req, 16384);
          const decision = await mutate(auth, async state => putDecision(state, body, auth.user.id, decisionMemoryMatch[1]));
          send(res, 200, { decision }); return;
        }
        const exceptionMatch = pathname.match(/^\/api\/exceptions\/([^/]+)$/);
        if (req.method === 'PATCH' && exceptionMatch) {
          const body = await jsonBody(req, 16384);
          const exception = await mutate(auth, async state => setExceptionStatus(state, exceptionMatch[1], body, auth.user.id));
          send(res, 200, { exception }); return;
        }
        const opportunityMatch = pathname.match(/^\/api\/opportunities\/([^/]+)\/approval$/);
        if (req.method === 'POST' && opportunityMatch) {
          const approval = await mutate(auth, async state => requestOpportunityApproval(state, opportunityMatch[1], auth.user.id));
          send(res, 202, { approval, executedExternally: false }); return;
        }
        const modifyMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/);
        if (req.method === 'PATCH' && modifyMatch) {
          requireApprover(auth);
          const body = await jsonBody(req, 32768);
          const approval = await mutate(auth, async state => modifyApproval(state, modifyMatch[1], body, auth.user.id));
          send(res, 200, { approval, executedExternally: false }); return;
        }

        const agentSettingMatch = pathname.match(/^\/api\/agents\/([^/]+)\/settings$/);
        if (req.method === 'PUT' && agentSettingMatch) {
          requireOwner(auth);
          const body = await jsonBody(req, 32768);
          const agentId = text(agentSettingMatch[1], 80);
          if (!AGENT_DEFINITIONS.some(item => item.id === agentId)) throw Object.assign(new Error('Unknown agent'), { status: 404, code: 'AGENT_NOT_FOUND' });
          const autonomy = Number(body.autonomy);
          if (![0, 1, 2, 3].includes(autonomy)) throw Object.assign(new Error('Autonomy must be level 0, 1, 2 or 3'), { status: 400, code: 'VALIDATION_FAILED' });
          const setting = await mutate(auth, async state => {
            const previous = state.agentSettings?.[agentId] || {};
            if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw Object.assign(new Error('Enabled must be a boolean'), { status: 400, code: 'VALIDATION_FAILED' });
            const next = { ...previous, autonomy, enabled: body.enabled === undefined ? previous.enabled !== false : body.enabled };
            state.agentSettings = { ...(state.agentSettings || {}), [agentId]: next };
            addAudit(state, { type: 'agent_autonomy_updated', actor: auth.user.id, detail: { agentId, autonomy, enabled: next.enabled } });
            return next;
          });
          send(res, 200, { agentId, setting });
          return;
        }

        if (req.method === 'GET' && pathname === '/api/reports/accounting.csv') {
          const csv = accountingCsv(auth.state);
          send(res, 200, csv, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="packsmart-operations-${new Date().toISOString().slice(0, 10)}.csv"`
          });
          return;
        }

        if (req.method === 'GET' && pathname === '/api/integrations') {
          send(res, 200, { integrations: integrationMatrix(auth.state, env), ebayOAuth: integrations.ebayOAuthStatus(auth.state), ebay: auth.state.ebay || null });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/integrations/ebay/oauth/start') {
          requireOwner(auth);
          if (!integrations.ebayOAuthReady(auth.state)) {
            throw Object.assign(new Error('eBay read-only sign-in is not ready yet'), { status: 503, code: 'EBAY_OAUTH_NOT_CONFIGURED' });
          }
          const nonce = crypto.randomBytes(32).toString('base64url');
          const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
          const stateToken = createEbayOAuthStateToken({
            workspaceId: auth.session.workspaceId,
            userId: auth.user.id,
            nonce
          }, env.SESSION_SECRET, 10 * 60);
          await mutate(auth, async state => {
            state.oauthChallenges = [
              { provider: 'ebay', nonce, userId: auth.user.id, expiresAt, createdAt: new Date().toISOString() },
              ...(state.oauthChallenges || []).filter(item => Date.parse(item.expiresAt || 0) > Date.now() && item.provider !== 'ebay')
            ].slice(0, 10);
            addAudit(state, { type: 'ebay_oauth_started', actor: auth.user.id, detail: { readOnly: true, existingManagerPreserved: true } });
          });
          send(res, 200, {
            authorizationUrl: integrations.ebayAuthorizationUrl(stateToken, auth.state),
            expiresAt,
            readOnly: true,
            existingManagerPreserved: true
          });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/integrations/sync') {
          requireOwner(auth);
          const results = await mutate(auth, async state => {
            const output = {};
            try { output.shopify = await monitoredSync(state, integrations, 'shopify'); }
            catch (error) {
              output.shopify = state.integrationStatus.shopify;
              const connection = (state.connections || []).find(item => item.provider === 'shopify');
              if (connection) { connection.status = 'error'; connection.lastError = output.shopify.lastError; }
            }
            if (integrations.ebayConfigured(state)) {
              try { output.ebay = await monitoredSync(state, integrations, 'ebay'); }
              catch (error) {
                output.ebay = state.integrationStatus.ebay;
                const connection = integrations.ebayConnection(state);
                if (connection) { connection.status = 'error'; connection.lastError = output.ebay.lastError; }
              }
            }
            state.integrationStatus = { ...(state.integrationStatus || {}), ...output };
            addAudit(state, { type: 'commerce_read_sync', actor: auth.user.id, detail: { providers: Object.keys(output), statuses: Object.fromEntries(Object.entries(output).map(([id, value]) => [id, value.status])) } });
            return output;
          });
          send(res, 200, { integrations: results, readOnly: true, writesEnabled: false });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/integrations/shopify/sync') {
          requireOwner(auth);
          const outcome = await mutate(auth, async state => {
            try {
              const result = await monitoredSync(state, integrations, 'shopify');
              addAudit(state, { type: 'shopify_read_sync', actor: auth.user.id, detail: { status: result.status, source: result.source } });
              return { status: result, error: null };
            } catch (error) {
              const failedStatus = {
                status: state.products?.length ? 'degraded' : 'error',
                detail: 'The live Shopify read connection could not be verified; last known catalogue data was retained.',
                lastSyncAt: state.integrationStatus?.shopify?.lastSyncAt || null,
                lastError: error.code || 'SHOPIFY_SYNC_FAILED'
                , lastFailureAt: new Date().toISOString()
              };
              state.integrationStatus = { ...(state.integrationStatus || {}), shopify: failedStatus };
              const connection = (state.connections || []).find(item => item.provider === 'shopify');
              if (connection) { connection.status = 'error'; connection.lastError = failedStatus.lastError; }
              addAudit(state, { type: 'shopify_read_sync_failed', actor: auth.user.id, detail: { code: failedStatus.lastError } });
              return { status: failedStatus, error: { status: 422, code: failedStatus.lastError } };
            }
          });
          if (outcome.error) {
            throw Object.assign(new Error('Shopify could not verify this read-only connection. Check the app is installed and the credentials are current.'), outcome.error);
          }
          send(res, 200, { status: outcome.status, readOnly: true });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/integrations/ebay/sync') {
          requireOwner(auth);
          const outcome = await mutate(auth, async state => {
            try {
              const result = await monitoredSync(state, integrations, 'ebay');
              addAudit(state, { type: 'ebay_read_sync', actor: auth.user.id, detail: { status: result.status, account: result.account || null } });
              return { status: result, error: null };
            } catch (error) {
              const failedStatus = {
                status: 'error',
                detail: 'The eBay read connection could not be verified; the existing Manager was not changed.',
                lastSyncAt: state.integrationStatus?.ebay?.lastSyncAt || null,
                lastFailureAt: new Date().toISOString(),
                lastError: error.code || 'EBAY_SYNC_FAILED'
              };
              state.integrationStatus = {
                ...(state.integrationStatus || {}),
                ebay: failedStatus
              };
              const connection = integrations.ebayConnection(state);
              if (connection) { connection.status = 'error'; connection.lastError = failedStatus.lastError; }
              addAudit(state, { type: 'ebay_read_sync_failed', actor: auth.user.id, detail: { code: error.code || 'EBAY_SYNC_FAILED' } });
              return { status: failedStatus, error: { status: 422, code: error.code || 'EBAY_SYNC_FAILED' } };
            }
          });
          if (outcome.error) {
            throw Object.assign(new Error('The eBay read connection could not be verified. Check the saved connection and seller account.'), outcome.error);
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
          if (!['shopify', 'ebay'].includes(provider) || !body.credentials || typeof body.credentials !== 'object' || Array.isArray(body.credentials)) {
            throw Object.assign(new Error('Provider and credentials are required'), { status: 400, code: 'VALIDATION_FAILED' });
          }
          const credentials = provider === 'shopify' ? cleanShopifyCredentials(body.credentials) : cleanEbayCredentials(body.credentials);
          const connection = await mutate(auth, async state => {
            const now = new Date().toISOString();
            const existing = (state.connections || []).find(item => item.provider === provider);
            const next = existing || { id: `conn_${crypto.randomUUID()}`, provider, createdAt: now };
            next.label = provider === 'shopify' ? 'Shopify' : 'eBay Manager';
            next.status = 'configured';
            next.capabilities = provider === 'shopify'
              ? ['catalogue', 'inventory', 'orders']
              : ['status', 'listings', 'drafts', 'orders', 'fees', 'promotions'];
            next.metadata = provider === 'shopify'
              ? { shopDomain: credentials.storeDomain }
              : { account: credentials.expectedAccount, marketplaceId: 'EBAY_GB' };
            next.lastError = null;
            next.encryptedCredentials = encryptCredentials(credentials, env.CREDENTIALS_KEY);
            next.updatedAt = now;
            state.connections = [next, ...(state.connections || []).filter(item => item.id !== next.id)];
            addAudit(state, { type: 'connection_configured', actor: auth.user.id, detail: { provider, readOnly: true } });
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
          await mutate(auth, async state => addAudit(state, { type: 'billing_checkout_created', actor: auth.user.id, detail: { plan, checkoutSessionId: checkout.id } }));
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

      if (['GET', 'HEAD'].includes(req.method) && await serveStatic(pathname, res, { head: req.method === 'HEAD' })) return;
      send(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
    } catch (error) {
      const safe = sanitizeError(error);
      const path = String(req.url || '').split('?')[0].slice(0, 200);
      console.error(JSON.stringify({ event: 'request_error', requestId, method: req.method, path, status: safe.status, code: safe.code }));
      send(res, safe.status, { error: safe.publicMessage, code: safe.code });
    }
  });

  const scheduler = createScheduler({ store, integrations, withWorkspaceLock, currentBrief,
    enabled: options.schedulerEnabled ?? isProduction, intervalMs: clamp(env.AUTOPILOT_TICK_MS, 15000, 3600000, 60000) });
  server.once('listening', () => scheduler.start());
  server.once('close', () => scheduler.stop());
  server.headersTimeout = 15000;
  server.requestTimeout = 120000;
  server.packsmart = { store, integrations, env, scheduler };
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
