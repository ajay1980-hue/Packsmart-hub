// Real server and SupabaseStore; database transport and identities are synthetic.
// This module never inherits application environment or uses external services.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createPacksmartServer } from '../server.mjs';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { hashPassword } from '../lib/security.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

export const PASSWORD = 'Maintenance-Synthetic!2026';
export const SECRET = 'maintenance-login-synthetic-session-secret-at-least-32-characters';
const passwordHash = hashPassword(PASSWORD);
export function ownerState(id = 'alpha') {
  const state = seedWorkspaceState({}, { workspaceId: id, email: `${id}@example.test` });
  Object.assign(state.users[0], { id: `${id}-owner`, passwordHash, passwordChangeRequired: false, role: 'owner', active: true, sessionVersion: 1 });
  state._revision = randomUUID();
  state.autopilot.enabled = true;
  state.agentOps = { enabled: true, paused: false };
  return state;
}
export async function maintenanceFixture({ states = [ownerState(), ownerState('beta')], fault, intercept, env = {}, beforeListen } = {}) {
  const fake = fakeSupabase({ initialStates: states, fault });
  const calls = [];
  const transport = async (url, options = {}) => {
    assert.equal(new URL(url).origin, 'https://maintenance.supabase.invalid', 'database-only synthetic origin');
    calls.push({ url: new URL(url), method: options.method || 'GET', body: options.body });
    const proceed = () => fake.fetchImpl(url, options);
    return intercept ? intercept({ url: new URL(url), options, fake, proceed }) : proceed();
  };
  const config = { NODE_ENV: 'production', RUNVARA_STARTUP_MODE: 'quiet', RUNVARA_QUIET_OWNER_LOGIN: 'enabled/v1',
    SESSION_SECRET: SECRET, CREDENTIALS_KEY: SECRET, APP_PUBLIC_URL: 'https://maintenance.example.test',
    SUPABASE_URL: 'https://maintenance.supabase.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only',
    PACKSMART_ADMIN_EMAIL: 'missing-owner@example.test', PACKSMART_ADMIN_PASSWORD: PASSWORD, ...env };
  const store = createStore(config, { fetchImpl: transport });
  const server = createPacksmartServer(config, { store, schedulerEnabled: true, agentOpsEnabled: true,
    fetchImpl: async () => assert.fail('Provider request forbidden') });
  beforeListen?.({ store, server, fake, calls });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, { method = 'GET', body, cookie, headers = {}, signal } = {}) => {
    const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }), signal });
    const text = await response.text();
    let payload; try { payload = JSON.parse(text); } catch { payload = text; }
    return { status: response.status, payload, cookie: response.headers.get('set-cookie'), headers: response.headers };
  };
  const login = (body = {}, options = {}) => request('/api/auth/login', { method: 'POST', body: { email: 'alpha@example.test', password: PASSWORD, ...body }, ...options });
  const close = async () => { await server.packsmart.drain(); if (server.listening) await new Promise(resolve => server.close(resolve)); };
  return { fake, store, server, config, calls, base, request, login, close };
}
