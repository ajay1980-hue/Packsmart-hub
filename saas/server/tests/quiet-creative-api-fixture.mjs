import assert from 'node:assert/strict';
import { quietCreativeFixture } from './quiet-creative-fixture.mjs';
import { maintenanceFixture, SECRET, ownerState } from './maintenance-login-fixture.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { CREATIVE_PILOT_BASE } from '../lib/quiet-creative-pilot.mjs';

export async function creativeApiFixture(t, { disabled = false } = {}) {
  const synthetic = quietCreativeFixture(), providerCalls = [];
  const f = await maintenanceFixture({ states: [synthetic.state, ownerState('beta')], env: {
    ...synthetic.env, RUNVARA_QUIET_OWNER_LOGIN: 'disabled/v1', ...(disabled ? { RUNVARA_QUIET_CREATIVE_PILOT: 'disabled/v1' } : {})
  }, beforeListen({ store, fake }) {
    store.creativeAllowanceRpc = async (name, id, input) => { synthetic.setSaved(fake.states.get('alpha')); return synthetic.store.creativeAllowanceRpc(name, id, input); };
  } });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith(f.base + '/')) return original(url, options);
    providerCalls.push({ url: String(url), method: options.method || 'GET', body: options.body });
    assert.equal(new URL(url).origin, 'https://api.dev.runwayml.com');
    return Response.json(options.method === 'POST' ? { id: 'task-synthetic' } : { status: 'RUNNING', progress: 12 });
  };
  t.after(async () => { globalThis.fetch = original; await f.close(); });
  function identity(overrides = {}) {
    const token = createSessionToken({ workspaceId: 'alpha', userId: synthetic.auth.user.id, email: 'owner@alpha.test', role: 'owner', sessionVersion: 1, ...overrides }, SECRET);
    return { cookie: '__Host-packsmart_session=' + token, headers: { Origin: 'https://maintenance.example.test', 'X-CSRF-Token': verifySessionToken(token, SECRET).csrf } };
  }
  const auth = identity();
  const call = (op, body = { requestId: synthetic.request.id }, options = {}) => f.request(CREATIVE_PILOT_BASE + op, { method: op === 'review' ? 'GET' : 'POST', ...(op === 'review' ? {} : { body }), ...auth, ...options });
  return { ...f, synthetic, auth, identity, call, providerCalls };
}
