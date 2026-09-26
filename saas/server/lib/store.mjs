import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactDailyBrief, defaultAutomations } from './operations.mjs';
import { defaultAgentSettings } from './agents.mjs';
import { normalizeEmail } from './security.mjs';
import { ensureControl } from './control.mjs';
import { ensureMarketing } from './marketing.mjs';
export { addAudit } from './events.mjs';

const PERSISTED = Symbol('persisted');
function markPersisted(state) { Object.defineProperty(state, PERSISTED, { value: true, configurable: true }); return state; }
function conflict() { return Object.assign(new Error('Workspace changed; refresh and try again'), { status: 409, code: 'STATE_CONFLICT' }); }
function assertWorkspace(workspaceId, state) {
  if (!workspaceId || state?.workspace?.id !== workspaceId) throw Object.assign(new Error('Workspace identity mismatch'), { status: 403, code: 'WORKSPACE_MISMATCH' });
}
const fileQueues = new Map();

export function seedWorkspaceState(env = process.env, options = {}) {
  const now = new Date().toISOString();
  const workspaceId = options.workspaceId || 'packsmart-solutions';
  const ownerEmail = normalizeEmail(options.email || env.PACKSMART_ADMIN_EMAIL || 'sales@packsmartsolutions.com');
  const ownerId = options.userId || (workspaceId === 'packsmart-solutions' ? 'packsmart-admin' : `user_${crypto.randomUUID()}`);
  const seeded = {
    schemaVersion: 6,
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
    suppliers: workspaceId === 'packsmart-solutions' ? [{
      id: 'supplier_europlast',
      name: 'Europlast',
      active: true,
      notes: 'Primary Packsmart packaging supplier.',
      createdAt: now,
      updatedAt: now
    }] : [],
    costHistory: [],
    advertisingCosts: [],
    shippingProviders: workspaceId === 'packsmart-solutions' ? [{
      id: 'shipping_royal_mail',
      name: 'Royal Mail',
      active: true,
      createdAt: now,
      updatedAt: now
    }] : [],
    settings: {
      currency: 'GBP',
      marginFloor: 20,
      lowStockThreshold: 20
    },
    marketplaceSettings: {},
    automations: defaultAutomations(),
    agentSettings: defaultAgentSettings(),
    agentRuns: [],
    agentActivity: [],
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
    oauthChallenges: [],
    integrationStatus: {},
    migrations: {},
    storageReady: false
  });
  return ensureMarketing(ensureControl(seeded));
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
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
    schemaVersion: 6,
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
    suppliers: Array.isArray(state?.suppliers) ? state.suppliers : seeded.suppliers,
    costHistory: Array.isArray(state?.costHistory) ? state.costHistory : [],
    advertisingCosts: Array.isArray(state?.advertisingCosts) ? state.advertisingCosts : [],
    shippingProviders: Array.isArray(state?.shippingProviders) ? state.shippingProviders : seeded.shippingProviders,
    settings: { ...seeded.settings, ...(state?.settings || {}) },
    marketplaceSettings: state?.marketplaceSettings && typeof state.marketplaceSettings === 'object' ? state.marketplaceSettings : {},
    automations: { ...defaultAutomations(), ...(state?.automations || {}) },
    agentSettings: { ...defaultAgentSettings(), ...(state?.agentSettings || {}) },
    agentRuns: Array.isArray(state?.agentRuns) ? state.agentRuns : [],
    agentActivity: Array.isArray(state?.agentActivity) ? state.agentActivity : [],
    approvals: Array.isArray(state?.approvals) ? state.approvals : [],
    audit: Array.isArray(state?.audit) ? state.audit : seeded.audit,
    dailyBriefs: Array.isArray(state?.dailyBriefs) ? state.dailyBriefs : [],
    subscription: { ...seeded.subscription, ...(state?.subscription || {}) },
    connections: Array.isArray(state?.connections) ? state.connections : [],
    oauthChallenges: Array.isArray(state?.oauthChallenges) ? state.oauthChallenges : [],
    integrationStatus: state?.integrationStatus && typeof state.integrationStatus === 'object' ? state.integrationStatus : {},
    migrations: state?.migrations && typeof state.migrations === 'object' ? state.migrations : {}
  };
  return ensureMarketing(ensureControl(upgraded));
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
    return all[workspaceId] ? markPersisted(upgradeState(all[workspaceId])) : null;
  }

  async save(workspaceId, state) {
    assertWorkspace(workspaceId, state);
    const previous = fileQueues.get(this.filePath) || Promise.resolve();
    const write = previous.catch(() => {}).then(async () => {
      const all = await this.readAll();
      const existing = all[workspaceId];
      if (existing && (!(state[PERSISTED] || state._revision) || (existing._revision || null) !== (state._revision || null))) throw conflict();
      for (const other of Object.values(all)) if (other.workspace.id !== workspaceId && (other.users || []).some(user => (state.users || []).some(next => normalizeEmail(next.email) === normalizeEmail(user.email)))) {
        throw Object.assign(new Error('An account already exists for this email'), { status: 409, code: 'ACCOUNT_EXISTS' });
      }
      const upgraded = { ...upgradeState(state), _revision: crypto.randomUUID(), storageReady: false };
      all[workspaceId] = upgraded;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${crypto.randomUUID()}.tmp`;
      const handle = await fs.open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(all)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, this.filePath);
      state._revision = upgraded._revision;
      markPersisted(state);
      return markPersisted(upgraded);
    });
    fileQueues.set(this.filePath, write);
    try { return await write; } finally { if (fileQueues.get(this.filePath) === write) fileQueues.delete(this.filePath); }
  }

  async listWorkspaceIds() { return Object.keys(await this.readAll()); }

  async getBrief(workspaceId, briefId) { return (await this.get(workspaceId))?.dailyBriefs?.find(item => item.id === briefId) || null; }

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
    this.mirrorDigests = new Map();
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
      error.httpStatus = response.status;
      error.table = pathname.split('?')[0];
      error.payloadBytes = Buffer.byteLength(options.body || '');
      // Never log PostgREST messages/details: they can contain row data.
      try {
        const payload = await response.json();
        if (typeof payload?.code === 'string' && /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(payload.code)) {
          error.databaseCode = payload.code;
        }
      } catch { /* Non-JSON error responses retain HTTP/table diagnostics. */ }
      throw error;
    }
    if (response.status === 204 || options.method === 'HEAD') return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async getIdentity(workspaceId) {
    const rows = await this.request(`saas_workspace_state?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=state->workspace,state->users&limit=1`);
    const state = rows?.[0];
    if (!state?.workspace || !Array.isArray(state.users)) return null;
    assertWorkspace(workspaceId, state);
    return { workspace: state.workspace, users: state.users.map(user => ({
      active: true, sessionVersion: 1, ...user,
      passwordChangeRequired: typeof user.passwordChangeRequired === 'boolean' ? user.passwordChangeRequired : workspaceId === 'packsmart-solutions' && !user.passwordHash
    })) };
  }

  async get(workspaceId) {
    const rows = await this.request(`saas_workspace_state?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=state&limit=1`);
    if (!rows?.[0]?.state) return null;
    const state = upgradeState(rows[0].state);
    state.storageReady = true;
    assertWorkspace(workspaceId, state);
    return markPersisted(state);
  }

  async upsert(table, rows, conflict, options = {}) {
    if (!rows.length) return;
    await this.request(`${table}?on_conflict=${encodeURIComponent(conflict)}`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows),
      ...options
    });
  }

  async mirrorNormalized(workspaceId, state) {
    const errors = [];
    const deadline = Date.now() + 12000;
    const mirror = async (table, rows, conflict) => {
      if (!rows.length) return;
      try {
        const cacheKey = `${workspaceId}:${table}`, previous = this.mirrorDigests.get(cacheKey) || new Map();
        const fingerprinted = rows.map(row => ({ row, key: conflict.split(',').map(key => String(row[key])).join(':'), hash: crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex') }));
        const changed = fingerprinted.filter(item => previous.get(item.key) !== item.hash);
        if (!changed.length) return;
        if (Date.now() >= deadline) throw Object.assign(new Error('Mirror deferred'), { code: 'MIRROR_DEFERRED' });
        await this.upsert(table, changed.map(item => item.row), conflict, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
        // Cache only confirmed writes. Failed mirrors are retried on the next save.
        this.mirrorDigests.set(cacheKey, new Map(fingerprinted.map(item => [item.key, item.hash])));
      } catch (error) {
        errors.push({ table, code: error.code === 'SUPABASE_PERSISTENCE_FAILED' ? error.code : 'MIRROR_DEFERRED', httpStatus: error.httpStatus || null, databaseCode: error.databaseCode || null });
      }
    };
    const workspace = state.workspace;
    await mirror('workspaces', [{
      id: workspaceId,
      name: workspace.name,
      slug: workspace.slug,
      settings: { schemaVersion: state.schemaVersion },
      created_at: workspace.createdAt,
      updated_at: workspace.updatedAt || new Date().toISOString()
    }], 'id');

    await mirror('users', (state.users || []).map(user => ({
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

    await mirror('connections', (state.connections || []).map(connection => ({
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
    await mirror('products', products.map(product => ({
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

    // Preserve old reporting IDs while matching on source identity, never SKU.
    const existingVariants = new Map();
    let variantsAvailable = true;
    if (products.length) try {
      for (let offset = 0; ; offset += 500) {
        const rows = await this.request(`variants?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=id,product_id,external_id&order=id&limit=500&offset=${offset}`, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
        for (const row of rows || []) existingVariants.set(`${row.product_id}:${row.external_id}`, row.id);
        if ((rows || []).length < 500) break;
      }
    } catch (error) {
      variantsAvailable = false;
      errors.push({ table: 'variants', code: 'VARIANT_IDENTITY_READ_FAILED', httpStatus: error.httpStatus || null, databaseCode: error.databaseCode || null });
    }
    const variants = products.flatMap(product => (product.variants || []).map(variant => ({
      id: existingVariants.get(`${product.id}:${variant.externalId || variant.id || ''}`) || variant.externalId || `${product.id}:${variant.id || variant.sku}`,
      workspace_id: workspaceId,
      product_id: product.id,
      external_id: variant.externalId || variant.id || '',
      sku: variant.sku || '',
      title: variant.title || 'Default',
      price: numericOrNull(variant.price) ?? 0,
      inventory_quantity: variant.inventory,
      available: variant.available !== false,
      image_url: variant.image || product.image || null,
      raw: {},
      updated_at: new Date().toISOString()
    })));
    if (variantsAvailable) await mirror('variants', variants, 'workspace_id,id');

    const variantBySku = new Map();
    if (variantsAvailable) for (const variant of variants) variantBySku.set(variant.sku, variantBySku.has(variant.sku) ? null : variant.id);
    await mirror('economics', Object.entries(state.economics || {}).map(([sku, economics]) => ({
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

    await mirror('product_cost_profiles', Object.entries(state.economics || {}).map(([sku, economics]) => ({
      workspace_id: workspaceId,
      sku,
      cost_data: economics,
      updated_at: economics.updatedAt || new Date().toISOString()
    })), 'workspace_id,sku');

    await mirror('suppliers', (state.suppliers || []).map(supplier => ({
      id: supplier.id,
      workspace_id: workspaceId,
      name: supplier.name,
      active: supplier.active !== false,
      notes: supplier.notes || '',
      metadata: supplier.metadata || {},
      created_at: supplier.createdAt,
      updated_at: supplier.updatedAt || supplier.createdAt
    })), 'id');

    await mirror('cost_history', (state.costHistory || []).slice(0, 5000).map(event => ({
      id: event.id,
      workspace_id: workspaceId,
      sku: event.sku,
      changed_by: event.changedBy || 'system',
      changed_fields: event.changedFields || [],
      before_data: event.before || {},
      after_data: event.after || {},
      created_at: event.createdAt
    })), 'id');

    await mirror('automation_rules', Object.entries(state.automations || {}).map(([ruleId, enabled]) => ({
      workspace_id: workspaceId,
      rule_id: ruleId,
      enabled: Boolean(enabled),
      config: state.autopilot?.rules?.[ruleId] || {},
      updated_at: new Date().toISOString()
    })), 'workspace_id,rule_id');

    await mirror('approval_requests', (state.approvals || []).map(approval => ({
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

    await mirror('audit_events', (state.audit || []).map(event => ({
      id: event.id,
      workspace_id: workspaceId,
      type: event.type,
      actor: event.actor,
      detail: event.detail || {},
      created_at: event.createdAt
    })), 'id');

    await mirror('subscriptions', [{
      workspace_id: workspaceId,
      plan: state.subscription?.plan || 'starter',
      status: state.subscription?.status || 'pending',
      stripe_customer_id: state.subscription?.stripeCustomerId || null,
      stripe_subscription_id: state.subscription?.stripeSubscriptionId || null,
      usage: state.subscription?.usage || {},
      updated_at: state.subscription?.updatedAt || new Date().toISOString()
    }], 'workspace_id');

    await mirror('orders', (state.orders || []).map(order => ({
      id: order.id,
      workspace_id: workspaceId,
      provider: order.provider || 'shopify',
      external_id: order.externalId || order.id,
      order_name: order.name || '',
      financial_status: order.financialStatus || 'UNKNOWN',
      fulfillment_status: order.fulfillmentStatus || 'UNKNOWN',
      total: numericOrNull(order.total) ?? 0,
      currency: order.currency || 'GBP',
      ordered_at: order.createdAt,
      source_updated_at: order.updatedAt || order.createdAt,
      cancelled_at: order.cancelledAt || null,
      updated_at: new Date().toISOString()
    })), 'workspace_id,id');

    await mirror('order_financials', (state.orders || []).map(order => ({
      workspace_id: workspaceId,
      order_id: order.id,
      provider: order.provider || 'shopify',
      financial_data: {
        currentTotal: order.currentTotal,
        discounts: order.discounts,
        refunds: order.refunds,
        tax: order.tax,
        currentTax: order.currentTax,
        shippingCharged: order.shippingCharged,
        actualShippingCost: order.actualShippingCost,
        paymentFees: order.paymentFees,
        channelFees: order.channelFees,
        advertisingCost: order.advertisingCost,
        otherVariableCosts: order.otherVariableCosts,
        paymentGatewayNames: order.paymentGatewayNames || []
      },
      line_items: order.lineItems || [],
      updated_at: order.updatedAt || new Date().toISOString()
    })), 'workspace_id,order_id');

    await mirror('advertising_costs', (state.advertisingCosts || []).map(record => ({
      id: record.id,
      workspace_id: workspaceId,
      channel: record.channel,
      spend: numericOrNull(record.spend),
      attributable_revenue: numericOrNull(record.attributableRevenue),
      period_date: record.date || record.createdAt,
      source: record.source || 'manual',
      metadata: record.metadata || {},
      created_at: record.createdAt,
      updated_at: record.updatedAt || record.createdAt
    })), 'id');

    // Archived full snapshots are immutable: never replace them with summaries.
    await mirror('operations_briefs', (state.dailyBriefs || []).filter(brief => !brief.archive).map(brief => ({
      id: brief.id,
      workspace_id: workspaceId,
      summary: brief.summary,
      metrics: brief,
      logic: brief.logic || 'deterministic-v1',
      created_at: brief.generatedAt
    })), 'id');
    return errors;
  }

  async commit(workspaceId, state, expectedRevision, existing) {
    const record = { workspace_id: workspaceId, state, updated_at: new Date().toISOString() };
    if (existing) {
      const revisionFilter = expectedRevision ? `eq.${encodeURIComponent(expectedRevision)}` : 'is.null';
      const path = `saas_workspace_state?workspace_id=eq.${encodeURIComponent(workspaceId)}&state->>_revision=${revisionFilter}&select=workspace_id`;
      const options = { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(record) };
      let rows;
      try { rows = await this.request(path, options); }
      catch (error) {
        if (error.databaseCode !== '57014') throw error;
        // PostgreSQL cancelled this statement. Retry the same revision-guarded
        // write once; do not repeat any provider operation or business callback.
        rows = await this.request(path, options);
      }
      if (!rows?.length) throw conflict();
    } else {
      // Atomically create the FK parent, unique login identity and primary state.
      try { await this.request('rpc/runvara_create_workspace', { method: 'POST', body: JSON.stringify({ p_state: state }) }); }
      catch (error) { if (error.databaseCode === '23505') throw conflict(); throw error; }
    }
  }

  async save(workspaceId, state) {
    assertWorkspace(workspaceId, state);
    const existing = Boolean(state[PERSISTED] || state._revision);
    const upgraded = { ...upgradeState(state), _revision: crypto.randomUUID(), storageReady: true };
    upgraded.workspace.updatedAt = new Date().toISOString();
    if (existing) {
      const briefs = [];
      for (const brief of upgraded.dailyBriefs) {
        if (brief.archive || Buffer.byteLength(JSON.stringify(brief)) <= 65536) { briefs.push(brief); continue; }
        // Commit the full historical snapshot before replacing it with a pointer.
        // One snapshot per request also avoids the gateway's bulk payload limit.
        await this.upsert('operations_briefs', [{ id: brief.id, workspace_id: workspaceId, summary: brief.summary,
          metrics: brief, logic: brief.logic || 'deterministic-v1', created_at: brief.generatedAt }], 'id');
        briefs.push({ ...compactDailyBrief(brief), archive: { table: 'operations_briefs', id: brief.id, sha256: crypto.createHash('sha256').update(JSON.stringify(brief)).digest('hex') } });
      }
      upgraded.dailyBriefs = briefs;
    }
    const now = new Date().toISOString();
    upgraded.integrationStatus.supabase = { status: 'connected', detail: 'Authoritative workspace state committed.', lastSyncAt: now, lastError: null };
    upgraded.integrationStatus.reporting = { ...upgraded.integrationStatus.reporting, status: 'degraded', detail: 'Reporting refresh pending; authoritative state is durable.' };
    await this.commit(workspaceId, upgraded, state._revision, existing);
    state._revision = upgraded._revision;
    state.dailyBriefs = upgraded.dailyBriefs;
    markPersisted(state);
    const failures = await this.mirrorNormalized(workspaceId, upgraded);
    const report = { status: failures.length ? 'degraded' : 'connected', detail: failures.length ? `${failures.length} reporting tables need repair; primary workspace data remains durable.` : 'Reporting refresh completed.',
      lastSyncAt: failures.length ? (state.integrationStatus?.reporting?.lastSyncAt || null) : now,
      lastFailureAt: failures.length ? now : (state.integrationStatus?.reporting?.lastFailureAt || null), lastError: failures[0]?.databaseCode || failures[0]?.code || null, failures };
    for (const failure of failures) console.warn(JSON.stringify({ event: 'supabase_mirror_refresh_failed', workspaceId, ...failure }));
    upgraded.integrationStatus.reporting = report;
    const expected = upgraded._revision;
    upgraded._revision = crypto.randomUUID();
    try {
      await this.commit(workspaceId, upgraded, expected, true);
      state._revision = upgraded._revision;
      state.integrationStatus = upgraded.integrationStatus;
    } catch (error) {
      // Primary commit already succeeded. Never replay its business action, and
      // never overwrite a newer concurrent state merely to update diagnostics.
      upgraded._revision = expected;
      upgraded.integrationStatus.reporting = { status: 'degraded', detail: 'Reporting status update deferred; primary workspace data is durable.', lastError: 'REPORTING_STATUS_DEFERRED' };
      console.warn(JSON.stringify({ event: 'reporting_status_deferred', workspaceId, code: error.code || 'PERSISTENCE_UNAVAILABLE' }));
    }
    return markPersisted(upgraded);
  }

  async findUserByEmail(email) {
    const normalized = normalizeEmail(email);
    const filter = encodeURIComponent(JSON.stringify([{ email: normalized }]));
    const rows = await this.request(`saas_workspace_state?state->users=cs.${filter}&select=workspace_id,state->users&limit=2`);
    if (rows?.length > 1) throw Object.assign(new Error('Ambiguous account'), { code: 'ACCOUNT_CONFLICT' });
    const user = rows?.[0]?.users?.find(item => normalizeEmail(item.email) === normalized);
    return user ? { ...user, workspaceId: rows[0].workspace_id } : null;
  }

  async getBrief(workspaceId, briefId) {
    const state = await this.get(workspaceId);
    const brief = state?.dailyBriefs?.find(item => item.id === briefId);
    if (!brief?.archive) return brief || null;
    const rows = await this.request(`operations_briefs?workspace_id=eq.${encodeURIComponent(workspaceId)}&id=eq.${encodeURIComponent(briefId)}&select=metrics&limit=1`);
    if (!rows?.[0]?.metrics) throw Object.assign(new Error('Historical brief is temporarily unavailable'), { status: 503, code: 'BRIEF_ARCHIVE_UNAVAILABLE' });
    return rows[0].metrics;
  }

  async listWorkspaceIds() {
    const ids = [];
    for (let offset = 0; ; offset += 200) {
      const rows = await this.request(`saas_workspace_state?select=workspace_id&order=workspace_id&limit=200&offset=${offset}`);
      ids.push(...(rows || []).map(row => row.workspace_id));
      if ((rows || []).length < 200) return ids;
    }
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
  try { return await store.save(workspaceId, seeded); }
  catch (error) { if (error.code === 'STATE_CONFLICT') { const concurrent = await store.get(workspaceId); if (concurrent) return concurrent; } throw error; }
}
