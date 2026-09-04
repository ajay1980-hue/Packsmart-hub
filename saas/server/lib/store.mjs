import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_AUTOMATIONS = {
  profitGuard: true,
  lowStockAlerts: true,
  dailyOpsBrief: true,
  seoChecks: true,
  priceRecommendations: true,
  customerReplyDrafts: true
};

export function seedWorkspaceState(env = process.env) {
  const now = new Date().toISOString();
  return {
    workspace: {
      id: 'packsmart-solutions',
      name: 'Packsmart Solutions Ltd',
      slug: 'packsmart-solutions',
      createdAt: now
    },
    users: [{
      id: 'packsmart-admin',
      email: env.PACKSMART_ADMIN_EMAIL || 'sales@packsmartsolutions.com',
      role: 'owner',
      createdAt: now
    }],
    economics: {},
    automations: { ...DEFAULT_AUTOMATIONS },
    approvals: [],
    audit: [{
      id: cryptoId(),
      type: 'workspace_seeded',
      actor: 'system',
      detail: { source: 'customer-zero' },
      createdAt: now
    }],
    subscription: {
      plan: 'customer-zero',
      status: 'internal',
      usage: {},
      updatedAt: now
    },
    connections: []
  };
}

function cryptoId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function addAudit(state, event) {
  const entry = {
    id: cryptoId(),
    type: event.type,
    actor: event.actor || 'system',
    detail: event.detail || {},
    createdAt: new Date().toISOString()
  };
  state.audit = [entry, ...(state.audit || [])].slice(0, 1000);
  return entry;
}

class FileStore {
  constructor(env) {
    this.env = env;
    const defaultPath = fileURLToPath(new URL('../data/state.json', import.meta.url));
    this.filePath = env.SAAS_STATE_FILE || defaultPath;
  }

  get provider() { return 'file'; }

  async #readAll() {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return {};
    }
  }

  async get(workspaceId) {
    const all = await this.#readAll();
    return all[workspaceId] || null;
  }

  async save(workspaceId, state) {
    const all = await this.#readAll();
    all[workspaceId] = state;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(all, null, 2), { mode: 0o600 });
    await fs.rename(temp, this.filePath);
    return state;
  }
}

class SupabaseStore {
  constructor(env) {
    this.url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
    this.key = env.SUPABASE_SERVICE_ROLE_KEY;
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

  async get(workspaceId) {
    const url = `${this.url}/rest/v1/saas_workspace_state?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=state&limit=1`;
    const response = await fetch(url, { headers: this.headers() });
    if (!response.ok) throw new Error(`Supabase read failed: ${response.status}`);
    const rows = await response.json();
    return rows[0]?.state || null;
  }

  async save(workspaceId, state) {
    const response = await fetch(`${this.url}/rest/v1/saas_workspace_state?on_conflict=workspace_id`, {
      method: 'POST',
      headers: this.headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify({
        workspace_id: workspaceId,
        state,
        updated_at: new Date().toISOString()
      })
    });
    if (!response.ok) throw new Error(`Supabase write failed: ${response.status}`);
    return state;
  }
}

export function createStore(env = process.env) {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) return new SupabaseStore(env);
  return new FileStore(env);
}

export async function getOrSeed(store, workspaceId, env = process.env) {
  const existing = await store.get(workspaceId);
  if (existing) return existing;
  const seeded = seedWorkspaceState(env);
  seeded.workspace.id = workspaceId;
  await store.save(workspaceId, seeded);
  return seeded;
}
