import http from 'node:http';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createSessionToken,
  verifySessionToken,
  safeEqual,
  requiresApproval,
  encryptCredentials,
  publicConnection
} from './lib/security.mjs';
import { createStore, getOrSeed, addAudit } from './lib/store.mjs';

const env = process.env;
const PORT = Number(env.PORT || 8787);
const WORKSPACE_ID = 'packsmart-solutions';
const store = createStore(env);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const STATIC_FILES = new Map([
  ['/', ['saas/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['saas/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['saas/app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['saas/styles.css', 'text/css; charset=utf-8']],
  ['/ebay-manager/shopify-products.json', ['ebay-manager/shopify-products.json', 'application/json; charset=utf-8']]
]);

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...headers
  });
  res.end(payload);
}

async function rawBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(req) {
  const raw = await rawBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function bearer(req) {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function sessionFor(req) {
  return verifySessionToken(bearer(req), env.SESSION_SECRET);
}

function requireSession(req, res) {
  const session = sessionFor(req);
  if (!session) {
    send(res, 401, { error: 'Authentication required' });
    return null;
  }
  if (session.workspaceId !== WORKSPACE_ID) {
    send(res, 403, { error: 'Workspace access denied' });
    return null;
  }
  return session;
}

async function workspaceState() {
  return getOrSeed(store, WORKSPACE_ID, env);
}

async function persist(state) {
  return store.save(WORKSPACE_ID, state);
}

function cleanEconomics(value = {}) {
  const clean = {};
  for (const field of ['landed', 'packing', 'delivery']) {
    const raw = value[field];
    if (raw === '' || raw === null || raw === undefined) clean[field] = '';
    else {
      const number = Number(raw);
      if (!Number.isFinite(number) || number < 0 || number > 1000000) {
        throw Object.assign(new Error(`Invalid ${field} cost`), { status: 400 });
      }
      clean[field] = Number(number.toFixed(4));
    }
  }
  return clean;
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function stripeConfigured() {
  return Boolean(env.STRIPE_SECRET_KEY && env.APP_PUBLIC_URL && (
    env.STRIPE_PRICE_STARTER || env.STRIPE_PRICE_GROWTH || env.STRIPE_PRICE_PRO
  ));
}

function stripePrice(plan) {
  const map = {
    starter: env.STRIPE_PRICE_STARTER,
    growth: env.STRIPE_PRICE_GROWTH,
    pro: env.STRIPE_PRICE_PRO
  };
  return map[plan] || null;
}

async function createStripeCheckout(session, plan) {
  const price = stripePrice(plan);
  if (!env.STRIPE_SECRET_KEY || !price || !env.APP_PUBLIC_URL) {
    throw Object.assign(new Error('Stripe checkout is not configured for this plan'), { status: 503 });
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
    body: params
  });
  const data = await response.json();
  if (!response.ok || !data.url) {
    throw Object.assign(new Error(data?.error?.message || 'Stripe checkout creation failed'), { status: 502 });
  }
  return { id: data.id, url: data.url };
}

function verifyStripeSignature(raw, header) {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const values = Object.fromEntries(String(header).split(',').map(part => {
    const [key, value] = part.split('=');
    return [key, value];
  }));
  const timestamp = Number(values.t);
  const signature = values.v1;
  if (!timestamp || !signature) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw.toString('utf8')}`).digest('hex');
  return safeEqual(signature, expected);
}

async function stripeWebhook(req, res) {
  const raw = await rawBody(req, 2 * 1024 * 1024);
  if (!verifyStripeSignature(raw, req.headers['stripe-signature'])) {
    send(res, 400, { error: 'Invalid Stripe signature' });
    return;
  }
  const event = JSON.parse(raw.toString('utf8'));
  const object = event?.data?.object || {};
  const workspaceId = object?.metadata?.workspace_id || object?.client_reference_id;
  if (workspaceId !== WORKSPACE_ID) {
    send(res, 200, { received: true, ignored: true });
    return;
  }

  const state = await workspaceState();
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
  await persist(state);
  send(res, 200, { received: true });
}

async function serveStatic(pathname, res) {
  const item = STATIC_FILES.get(pathname);
  if (!item) return false;
  const [relative, contentType] = item;
  try {
    const body = await fs.readFile(new URL(relative, `file://${repoRoot}/`));
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': pathname.endsWith('.json') ? 'no-store' : 'public, max-age=60',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' https://cdn.shopify.com data:; style-src 'self'; script-src 'self'; base-uri 'self'; frame-ancestors 'none'"
    });
    res.end(body);
  } catch {
    send(res, 404, { error: 'Static file not found' });
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    if (req.method === 'POST' && pathname === '/api/webhooks/stripe') {
      await stripeWebhook(req, res);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/health') {
      send(res, 200, {
        ok: true,
        version: '2.0.0',
        storage: store.provider,
        authConfigured: Boolean(env.PACKSMART_ADMIN_PASSWORD && env.SESSION_SECRET),
        credentialEncryptionConfigured: Boolean(env.CREDENTIALS_KEY),
        billingConfigured: stripeConfigured(),
        billingWebhookConfigured: Boolean(env.STRIPE_WEBHOOK_SECRET)
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      if (!env.PACKSMART_ADMIN_PASSWORD || !env.SESSION_SECRET) {
        send(res, 503, { error: 'Server authentication is not configured' });
        return;
      }
      const body = await jsonBody(req);
      const expectedEmail = env.PACKSMART_ADMIN_EMAIL || 'sales@packsmartsolutions.com';
      if (!safeEqual(String(body.email || '').toLowerCase(), expectedEmail.toLowerCase()) ||
          !safeEqual(body.password || '', env.PACKSMART_ADMIN_PASSWORD)) {
        send(res, 401, { error: 'Invalid email or password' });
        return;
      }
      const token = createSessionToken({
        userId: 'packsmart-admin',
        workspaceId: WORKSPACE_ID,
        email: expectedEmail
      }, env.SESSION_SECRET);
      send(res, 200, { token, workspaceId: WORKSPACE_ID, role: 'owner' });
      return;
    }

    if (pathname.startsWith('/api/')) {
      const session = requireSession(req, res);
      if (!session) return;
      const state = await workspaceState();

      if (req.method === 'GET' && pathname === '/api/bootstrap') {
        const catalogue = JSON.parse(await fs.readFile(new URL('ebay-manager/shopify-products.json', `file://${repoRoot}/`), 'utf8'));
        send(res, 200, {
          workspace: state.workspace,
          user: state.users.find(user => user.id === session.sub) || null,
          products: catalogue.products || [],
          syncedAt: catalogue.syncedAt || null,
          economics: state.economics || {},
          automations: state.automations || {},
          approvals: state.approvals || [],
          subscription: state.subscription || null,
          connections: (state.connections || []).map(publicConnection),
          storage: store.provider
        });
        return;
      }

      if (req.method === 'PUT' && pathname === '/api/economics') {
        const body = await jsonBody(req);
        const sku = String(body.sku || '').trim().slice(0, 160);
        if (!sku) throw Object.assign(new Error('SKU is required'), { status: 400 });
        state.economics[sku] = cleanEconomics(body.economics);
        addAudit(state, { type: 'economics_updated', actor: session.sub, detail: { sku } });
        await persist(state);
        send(res, 200, { sku, economics: state.economics[sku] });
        return;
      }

      if (req.method === 'PUT' && pathname === '/api/automations') {
        const body = await jsonBody(req);
        const id = String(body.id || '').trim();
        if (!(id in (state.automations || {}))) throw Object.assign(new Error('Unknown automation rule'), { status: 400 });
        state.automations[id] = Boolean(body.enabled);
        addAudit(state, { type: 'automation_rule_updated', actor: session.sub, detail: { id, enabled: state.automations[id] } });
        await persist(state);
        send(res, 200, { id, enabled: state.automations[id] });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/actions') {
        const body = await jsonBody(req);
        const type = String(body.type || '').trim();
        if (!type) throw Object.assign(new Error('Action type is required'), { status: 400 });
        if (requiresApproval(type)) {
          const approval = {
            id: id('approval'),
            type,
            payload: body.payload || {},
            status: 'pending',
            requestedBy: session.sub,
            createdAt: new Date().toISOString(),
            decidedAt: null,
            decidedBy: null
          };
          state.approvals = [approval, ...(state.approvals || [])].slice(0, 500);
          addAudit(state, { type: 'approval_requested', actor: session.sub, detail: { approvalId: approval.id, actionType: type } });
          await persist(state);
          send(res, 202, { approvalRequired: true, approval });
          return;
        }
        const event = addAudit(state, { type: 'safe_action_recorded', actor: session.sub, detail: { actionType: type, payload: body.payload || {} } });
        await persist(state);
        send(res, 200, { approvalRequired: false, executedExternally: false, auditEvent: event });
        return;
      }

      const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/decision$/);
      if (req.method === 'POST' && approvalMatch) {
        const body = await jsonBody(req);
        const decision = body.decision === 'approved' ? 'approved' : body.decision === 'rejected' ? 'rejected' : null;
        if (!decision) throw Object.assign(new Error('Decision must be approved or rejected'), { status: 400 });
        const approval = (state.approvals || []).find(item => item.id === approvalMatch[1]);
        if (!approval) throw Object.assign(new Error('Approval request not found'), { status: 404 });
        if (approval.status !== 'pending') throw Object.assign(new Error('Approval already decided'), { status: 409 });
        approval.status = decision;
        approval.decidedAt = new Date().toISOString();
        approval.decidedBy = session.sub;
        addAudit(state, { type: 'approval_decided', actor: session.sub, detail: { approvalId: approval.id, decision } });
        await persist(state);
        send(res, 200, { approval, executedExternally: false });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/approvals') {
        send(res, 200, { approvals: state.approvals || [] });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/audit') {
        send(res, 200, { events: (state.audit || []).slice(0, 250) });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/connections') {
        send(res, 200, { connections: (state.connections || []).map(publicConnection) });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/connections') {
        if (!env.CREDENTIALS_KEY) throw Object.assign(new Error('Credential encryption is not configured'), { status: 503 });
        const body = await jsonBody(req);
        const provider = String(body.provider || '').trim().toLowerCase().slice(0, 50);
        if (!provider || !body.credentials || typeof body.credentials !== 'object') {
          throw Object.assign(new Error('Provider and credentials are required'), { status: 400 });
        }
        const now = new Date().toISOString();
        const existing = (state.connections || []).find(item => item.provider === provider);
        const connection = existing || { id: id('conn'), provider, createdAt: now };
        connection.label = String(body.label || provider).slice(0, 100);
        connection.status = 'configured';
        connection.encryptedCredentials = encryptCredentials(body.credentials, env.CREDENTIALS_KEY);
        connection.updatedAt = now;
        state.connections = [connection, ...(state.connections || []).filter(item => item.id !== connection.id)];
        addAudit(state, { type: 'connection_configured', actor: session.sub, detail: { provider } });
        await persist(state);
        send(res, 200, { connection: publicConnection(connection) });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/billing') {
        send(res, 200, {
          subscription: state.subscription,
          checkoutConfigured: stripeConfigured(),
          plans: {
            starter: Boolean(env.STRIPE_PRICE_STARTER),
            growth: Boolean(env.STRIPE_PRICE_GROWTH),
            pro: Boolean(env.STRIPE_PRICE_PRO)
          }
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/billing/checkout') {
        const body = await jsonBody(req);
        const plan = String(body.plan || '').toLowerCase();
        const checkout = await createStripeCheckout(session, plan);
        addAudit(state, { type: 'billing_checkout_created', actor: session.sub, detail: { plan, checkoutSessionId: checkout.id } });
        await persist(state);
        send(res, 200, checkout);
        return;
      }

      send(res, 404, { error: 'API route not found' });
      return;
    }

    if (req.method === 'GET' && await serveStatic(pathname, res)) return;
    send(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    send(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Packsmart Ops server listening on http://localhost:${PORT} using ${store.provider} persistence`);
});
