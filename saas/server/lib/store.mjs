import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultAutomations } from './operations.mjs';
import { normalizeEmail } from './security.mjs';

export function seedWorkspaceState(env = process.env, options = {}) {
  const now = new Date().toISOString();
  const workspaceId = options.workspaceId || 'packsmart-solutions';
  const ownerEmail = normalizeEmail(options.email || env.PACKSMART_ADMIN_EMAIL || 'sales@packsmartsolutions.com');
  const ownerId = options.userId || (workspaceId === 'packsmart-solutions' ? 'packsmart-admin' : `user_${crypto.randomUUID()}`);
  return {
    schemaVersion: 3,
    workspace: {
      id: workspaceId,
      name: options.name || (workspaceId === 'packsmart-solutions' ? 'Packsmart Solutions Ltd' : 'New business'),
      slug: options.slug || workspaceId,
      createdAt: now,
      updatedAt: now
    },
    users: [{
      id: ownerId,
      email: ownerEmail,
      role: 'owner',
      active: true,
      passwordHash: options.passwordHash || null,
      passwordChangeRequired: !options.passwordHash && workspaceId === 'packsmart-solutions',
      sessionVersion: 1,
      createdAt: now,
      updatedAt: now
    }],
    products: [],
    orders: [],
    economics: {},
    automations: defaultAutomations(),
    approvals: [],
    audit: [{
      id: id('audit'),
      type: 'workspace_seeded',
      actor: 'system',
      detail: { source: workspaceId === 'packsmart-solutions' ? 'customer-zero' : 'beta-onboarding' },
      createdAt: now
    }],
    dailyBriefs: [],
    subscription: {
      plan: workspaceId === 'packsmart-solutions' ? 'customer-zero' : (options.plan || 'starter'),
      status: workspaceId === 'packsmart-solutions' ? 'internal' : 'pending',
      usage: {},
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      updatedAt: now
    },
    connections: [],
    integrationStatus: {},
    migrations: {},
    storageReady: false
  };
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function addAudit(state, event) {
  const entry = {
    id: id('audit'),
    type: String(event.type || 'event').slice(0, 100),
    actor: String(event.actor || 'system').slice(0, 160),
    detail: event.detail && typeof event.detail === 'object' ? event.detail : {},
    createdAt: new Date().toISOString()
  };
  state.audit = [entry, ...(state.audit || [])].slice(0, 2000);
  return entry;
}

export function upgradeState(state, env = process.env) {
  const workspaceId = state?.workspace?.id || 'packsmart-solutions';
  const seeded = seedWorkspaceState(env, {
    workspaceId,
    name: state?.workspace?.name,
    slug: state?.workspace?.slug,
    email: state?.users?.[0]?.email
  });
  const upgraded = {
    ...seeded,
    ...(state || {}),
    schemaVersion: 3,
    workspace: { ...seeded.workspace, ...(state?.workspace || {}), updatedAt: state?.workspace?.updatedAt || new Date().toISOString() },
    users: Array.isArray(state?.users) && state.users.length ? state.users.map(user => {
      const upgradedUser = { active: true, sessionVersion: 1, passwordHash: null, ...user };
      if (typeof user.passwordChangeRequired !== 'boolean') {
        upgradedUser.passwordChangeRequired = workspaceId === 'packsmart-solutions' && !user.passwordHash;
      }
      return upgradedUser;
    }) : seeded.users,
    products: Array.isArray(state?.products) ? state.products : [],
    orders: Array.isArray(state?.orders) ? state.orders : [],
    economics: state?.economics && typeof state.economics === 'object' ? state.economics : {},
    automations: { ...defaultAutomations(), ...(state?.automations || {}) },
    approvals: Array.isArray(state?.approvals) ? state.approvals : [],
    audit: Array.isArray(state?.audit) ? state.audit : seeded.audit,
    dailyBriefs: Array.isArray(state?.dailyBriefs) ? state.dailyBriefs : [],
    subscription: { ...seeded.subscription, ...(state?.subscription || {}) },
    connections: Array.isArray(state?.connections) ? state.connections : [],
    integrationStatus: state?.integrationStatus && typeof state.integrationStatus === 'object' ? state.integrationStatus : {},
    migrations: state?.migrations && typeof state.migrations === 'object' ? state.migrations : {}
  };
  return upgraded;
}

class FileStore {
  constructor(env) {
    const defaultPath = fileURLToPath(new URL('../data/state.json', import.meta.url));
    this.filePath = env.SAAS_STATE_FILE || defaultPath;
  }

  get provider() { return 'file'; }

  async readAll() {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return {};
    }
  }

  async get(workspaceId) {
    const all = await this.readAll();
    return all[workspaceId] ? upgradeState(all[workspaceId]) : null;
  }

  async save(workspaceId, state) {
    const all = await this.readAll();
    const upgraded = upgradeState(state);
    upgraded.storageReady = false;
    all[workspaceId] = upgraded;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(all, null, 2), { mode: 0o600 });
    await fs.rename(temp, this.filePath);
    return upgraded;
  }

  async findUserByEmail(email) {
    const normalized = normalizeEmail(email);
    const all = await this.readAll();
    for (const state of Object.values(all)) {
      const user = (state.users || []).find(item => normalizeEmail(item.email) === normalized);
      if (user) return { ...user, workspaceId: state.workspace.id };
    }
    return null;
  }

  async ping() { return true; }
}

class SupabaseStore {
  constructor(env, fetchImpl) {
    this.url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
    this.key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
    this.fetch = fetchImpl;
    let parsed;
    try { parsed = new URL(this.url); } catch { throw new Error('SUPABASE_URL is invalid'); }
    if (parsed.protocol !== 'https:' && env.NODE_ENV === 'production') throw new Error('SUPABASE_URL must use HTTPS');
  }

  get provider() { return 'supabase'; }

  headers(extra = {}) {
    return {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      ...extra
    };
  }

  async request(pathname, options = {}) {
    const response = await this.fetch(`${this.url}/rest/v1/${pathname}`, {
      ...options,
      headers: this.headers(options.headers),
      signal: options.signal || AbortSignal.timeout(20000)
    });
    if (!response.ok) {
      const error = new Error(`Supabase persistence request failed (${response.status})`);
      error.code = 'SUPABASE_PERSISTENCE_FAILED';
      throw error;
    }
    if (response.status === 204 || options.method === 'HEAD') return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async get(workspaceId) {
    const rows = await this.request(`saas_workspace_state?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=state&limit=1`);
    if (!rows?.[0]?.state) return null;
    const state = upgradeState(rows[0].state);
    state.storageReady = true;
    return state;
  }

  async upsert(table, rows, conflict) {
    if (!rows.length) return;
    await this.request(`${table}?on_conflict=${encodeURIComponent(conflict)}`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows)
    });
  }

  async mirrorNormalized(workspaceId, state) {
    const workspace = state.workspace;
    await this.upsert('workspaces', [{
      id: workspaceId,
      name: workspace.name,
      slug: workspace.slug,
      settings: { schemaVersion: state.schemaVersion },
      created_at: workspace.createdAt,
      updated_at: workspace.updatedAt || new Date().toISOString()
    }], 'id');

    await this.upsert('users', (state.users || []).map(user => ({
      id: user.id,
      workspace_id: workspaceId,
      email: normalizeEmail(user.email),
      role: user.role,
      password_hash: user.passwordHash || null,
      password_change_required: Boolean(user.passwordChangeRequired),
      active: user.active !== false,
      session_version: Number(user.sessionVersion) || 1,
      created_at: user.createdAt,
      updated_at: user.updatedAt || user.createdAt
    })), 'id');

    await this.upsert('connections', (state.connections || []).map(connection => ({
      id: connection.id,
      workspace_id: workspaceId,
      provider: connection.provider,
      label: connection.label,
      status: connection.status,
      encrypted_credentials: connection.encryptedCredentials || null,
      capabilities: connection.capabilities || [],
      metadata: connection.metadata || {},
      last_sync_at: connection.lastSyncAt || null,
      last_error: connection.lastError || null,
      created_at: connection.createdAt,
      updated_at: connection.updatedAt || connection.createdAt
    })), 'id');

    const products = state.products || [];
    await this.upsert('products', products.map(product => ({
      id: product.id,
      workspace_id: workspaceId,
      provider: product.provider || 'shopify',
      external_id: product.externalId || product.id,
      title: product.title,
      handle: product.handle || '',
      status: product.status || 'unknown',
      product_type: product.productType || '',
      description: product.description || '',
      image_url: product.image || null,
      inventory_total: product.inventory,
      raw: {},
      source_updated_at: product.updatedAt || null,
      updated_at: new Date().toISOString()
    })), 'workspace_id,id');

    const variants = products.flatMap(product => (product.variants || []).map(variant => ({
      id: variant.id || variant.externalId || variant.sku,
      workspace_id: workspaceId,
      product_id: product.id,
      external_id: variant.externalId || variant.id || '',
      sku: variant.sku || '',
      title: variant.title || 'Default',
      price: Number(variant.price || 0),
      inventory_quantity: variant.inventory,
      available: variant.available !== false,
      image_url: variant.image || product.image || null,
      raw: {},
      updated_at: new Date().toISOString()
    })));
    await this.upsert('variants', variants, 'workspace_id,id');

    const variantBySku = new Map(variants.map(variant => [variant.sku, variant.id]));
    await this.upsert('economics', Object.entries(state.economics || {}).map(([sku, economics]) => ({
      workspace_id: workspaceId,
      sku,
      variant_id: variantBySku.get(sku) || null,
      landed_cost: numericOrNull(economics.landed),
      packing_cost: numericOrNull(economics.packing),
      delivery_cost: numericOrNull(economics.delivery),
      channel_fee: numericOrNull(economics.channelFee),
      margin_floor: numericOrNull(economics.marginFloor),
      updated_at: new Date().toISOString()
    })), 'workspace_id,sku');

    await this.upsert('automation_rules', Object.entries(state.automations || {}).map(([ruleId, enabled]) => ({
      workspace_id: workspaceId,
      rule_id: ruleId,
      enabled: Boolean(enabled),
      config: {},
      updated_at: new Date().toISOString()
    })), 'workspace_id,rule_id');

    await this.upsert('approval_requests', (state.approvals || []).map(approval => ({
      id: approval.id,
      workspace_id: workspaceId,
      type: approval.type,
      proposed_action: approval.action || approval.type,
      reason: approval.reason || '',
      financial_impact: approval.financialImpact,
      expected_benefit: approval.expectedBenefit || '',
      risk: approval.risk || '',
      requested_by: approval.requestedBy || 'system',
      source: approval.source || 'packsmart-ops',
      payload: approval.payload || {},
      status: approval.status,
      created_at: approval.createdAt,
      decided_at: approval.decidedAt,
      decided_by: approval.decidedBy,
      decision_note: approval.decisionNote,
      executed_externally: Boolean(approval.executedExternally),
      execution_status: approval.executionStatus || 'not_connected'
    })), 'id');

    await this.upsert('audit_events', (state.audit || []).map(event => ({
      id: event.id,
      workspace_id: workspaceId,
      type: event.type,
      actor: event.actor,
      detail: event.detail || {},
      created_at: event.createdAt
    })), 'id');

    await this.upsert('subscriptions', [{
      workspace_id: workspaceId,
      plan: state.subscription?.plan || 'starter',
      status: state.subscription?.status || 'pending',
      stripe_customer_id: state.subscription?.stripeCustomerId || null,
      stripe_subscription_id: state.subscription?.stripeSubscriptionId || null,
      usage: state.subscription?.usage || {},
      updated_at: state.subscription?.updatedAt || new Date().toISOString()
    }], 'workspace_id');

    await this.upsert('orders', (state.orders || []).map(order => ({
      id: order.id,
      workspace_id: workspaceId,
      provider: order.provider || 'shopify',
      external_id: order.externalId || order.id,
      order_name: order.name || '',
      financial_status: order.financialStatus || 'UNKNOWN',
      fulfillment_status: order.fulfillmentStatus || 'UNKNOWN',
      total: Number(order.total || 0),
      currency: order.currency || 'GBP',
      ordered_at: order.createdAt,
      source_updated_at: order.updatedAt || order.createdAt,
      cancelled_at: order.cancelledAt || null,
      updated_at: new Date().toISOString()
    })), 'workspace_id,id');

    await this.upsert('operations_briefs', (state.dailyBriefs || []).slice(0, 30).map(brief => ({
      id: brief.id,
      workspace_id: workspaceId,
      summary: brief.summary,
      metrics: brief,
      logic: brief.logic || 'deterministic-v1',
      created_at: brief.generatedAt
    })), 'id');
  }

  async save(workspaceId, state) {
    const upgraded = upgradeState(state);
    upgraded.storageReady = true;
    upgraded.workspace.updatedAt = new Date().toISOString();
    await this.mirrorNormalized(workspaceId, upgraded);
    await this.upsert('saas_workspace_state', [{
      workspace_id: workspaceId,
      state: upgraded,
      updated_at: new Date().toISOString()
    }], 'workspace_id');
    return upgraded;
  }

  async findUserByEmail(email) {
    const normalized = normalizeEmail(email);
    const rows = await this.request(`users?email=eq.${encodeURIComponent(normalized)}&select=id,workspace_id,email,role,password_hash,password_change_required,active,session_version,created_at,updated_at&limit=1`);
    if (!rows?.[0]) return null;
    const user = rows[0];
    return {
      id: user.id,
      workspaceId: user.workspace_id,
      email: user.email,
      role: user.role,
      passwordHash: user.password_hash,
      passwordChangeRequired: user.password_change_required,
      active: user.active,
      sessionVersion: user.session_version,
      createdAt: user.created_at,
      updatedAt: user.updated_at
    };
  }

  async ping() {
    await this.request('saas_workspace_state?select=workspace_id&limit=1');
    return true;
  }
}

function numericOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function createStore(env = process.env, options = {}) {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) return new SupabaseStore(env, options.fetchImpl || fetch);
  return new FileStore(env);
}

export async function getOrSeed(store, workspaceId, env = process.env, options = {}) {
  const existing = await store.get(workspaceId);
  if (existing) return existing;
  const seeded = seedWorkspaceState(env, { workspaceId, ...options });
  seeded.storageReady = store.provider === 'supabase';
  return store.save(workspaceId, seeded);
}
