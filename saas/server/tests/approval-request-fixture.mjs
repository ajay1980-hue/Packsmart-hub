import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';
export const SECRET = 'approval-request-synthetic-secret-more-than-thirty-two';
export const input = (requestId = randomUUID(), extra = {}) => ({ requestId, type: 'customer_facing_publish', action: 'Synthetic unconnected review',
  reason: 'Check retry safety locally', expectedBenefit: 'Exact request recovery', risk: 'No executor connected', source: 'owner-review',
  financialImpact: null, payload: { a: 1, b: ['retained'] }, ...extra });
export async function approvalFixture(t) {
  const states = new Map(), calls = { saves: 0, commits: 0, reads: 0, providers: 0 }, hooks = {};
  for (const workspaceId of ['alpha', 'beta']) {
    const state = seedWorkspaceState({}, { workspaceId, email: workspaceId + '@example.test', passwordHash: 'synthetic-only' });
    Object.assign(state.users[0], { id: 'shared-owner', role: 'owner', active: true, passwordChangeRequired: false, sessionVersion: 1 });
    for (const role of ['admin', 'member', 'viewer']) state.users.push({ ...structuredClone(state.users[0]), id: workspaceId + '-' + role, role });
    state._revision = randomUUID(); state.approvals = []; state.audit = [{ id: workspaceId + '-baseline', type: 'synthetic' }];
    state.connectionWrites = []; states.set(workspaceId, state);
  }
  const store = { provider: 'synthetic-approval',
    async get(id) { calls.reads++; if (hooks.readFailure) throw Error('synthetic unavailable'); const result = structuredClone(states.get(id)); await hooks.afterRead?.(id, result); return result; },
    async save(id, state, options = {}) {
      calls.saves++; await hooks.beforeSave?.(id, state); options.beforeCommit?.(state);
      if (state._revision !== states.get(id)._revision) throw Object.assign(Error('CAS conflict'), { status: 409, code: 'STATE_CONFLICT' });
      if (hooks.fail === 'before') throw Error('synthetic private error');
      state._revision = randomUUID(); states.set(id, structuredClone(state)); calls.commits++;
      await hooks.afterCommit?.(id, state);
      if (hooks.fail === 'after') throw Error('synthetic private error');
      return state;
    }
  };
  const servers = [], bases = [];
  async function start() {
    const server = createPacksmartServer({ NODE_ENV: 'test', APP_PUBLIC_URL: 'https://approval.example.test', SESSION_SECRET: SECRET,
      CREDENTIALS_KEY: SECRET, RUNVARA_META_PUBLICATION: 'disabled/v1' }, { store, schedulerEnabled: false, agentOpsEnabled: false,
      fetchImpl: async () => { calls.providers++; assert.fail('External provider call'); } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); servers.push(server); bases.push('http://127.0.0.1:' + server.address().port);
    return bases.length - 1;
  }
  await start();
  const auth = (workspaceId = 'alpha', role = 'owner', overrides = {}) => {
    const csrf = randomUUID(), token = createSessionToken({ userId: role === 'owner' ? 'shared-owner' : workspaceId + '-' + role,
      workspaceId, role, email: role + '@example.test', sessionVersion: 1, ...overrides, csrf }, SECRET);
    return { Cookie: '__Host-packsmart_session=' + token, 'X-CSRF-Token': csrf };
  };
  const request = async (body, { server = 0, reconcile = false, identity = auth(), route, signal } = {}) => {
    const response = await fetch(bases[server] + (route || (reconcile ? '/api/actions/reconcile' : '/api/actions')), {
      method: 'POST', headers: { ...identity, Origin: 'https://approval.example.test', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    return { status: response.status, body: await response.json() };
  };
  t.mock.method(console, 'error', () => {});
  t.after(async () => { for (const server of servers) { await server.packsmart.drain(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
    assert.equal(calls.providers, 0); });
  return { states, calls, hooks, store, servers, start, auth, request };
}

