import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { detectExceptions, detectOpportunities } from '../lib/control.mjs';

test('control endpoints enforce tenant isolation, roles, revision review, CSRF and logout revocation', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-api-'));
  const secret = 'runvara-control-test-session-secret-over-32-characters';
  const server = createPacksmartServer({ NODE_ENV: 'test', SAAS_STATE_FILE: path.join(directory, 'state.json'), SESSION_SECRET: secret, CREDENTIALS_KEY: 'runvara-credential-test-key-over-32-characters', SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' });
  const a = seedWorkspaceState({}, { workspaceId: 'alpha', email: 'owner@alpha.test', passwordHash: 'test-only' });
  a.products = [{ id: 'private-product', title: 'Alpha product', variants: [{ id: 'v1', sku: 'alpha-sku', price: 10, inventory: 1 }] }];
  for (const role of ['member', 'viewer', 'admin']) a.users.push({ id: role, role, email: `${role}@alpha.test`, active: true, sessionVersion: 1, passwordChangeRequired: false });
  detectExceptions(a); detectOpportunities(a);
  const b = seedWorkspaceState({}, { workspaceId: 'beta', email: 'owner@beta.test', passwordHash: 'test-only' });
  await server.packsmart.store.save('alpha', a); await server.packsmart.store.save('beta', b);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = (workspace, user) => {
    const token = createSessionToken({ userId: user.id, workspaceId: workspace.workspace.id, email: user.email, role: user.role, sessionVersion: 1 }, secret);
    return { token, csrf: verifySessionToken(token, secret).csrf };
  };
  const owner = session(a, a.users[0]), beta = session(b, b.users[0]), viewer = session(a, a.users.find(item => item.role === 'viewer')), admin = session(a, a.users.find(item => item.role === 'admin'));
  async function request(who, route, method = 'GET', body, csrf = who.csrf) {
    const response = await fetch(base + route, { method, headers: { Cookie: `packsmart_session=${who.token}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const decision = await request(owner, '/api/decision-memory', 'POST', { key: 'alpha-goal', category: 'goal', title: 'Alpha secret goal', content: 'Keep private', source: 'Owner' });
  assert.equal(decision.status, 201);
  const proposal = await request(owner, `/api/opportunities/${a.opportunities[0].id}/approval`, 'POST', {});
  assert.equal(proposal.status, 202); const approval = proposal.body.approval;
  assert.equal((await request(admin, `/api/approvals/${approval.id}/decision`, 'POST', { decision: 'approved' })).status, 403);
  assert.equal((await request(viewer, '/api/autopilot', 'PUT', { enabled: true })).status, 403);
  assert.equal((await request(viewer, '/api/actions', 'POST', {})).status, 403);
  assert.equal((await request(viewer, `/api/exceptions/${a.exceptions[0].id}`, 'PATCH', { status: 'dismissed', note: 'No permission' })).status, 403);
  assert.equal((await request(owner, '/api/autopilot', 'PUT', { enabled: true }, '')).status, 403);
  assert.equal((await request(owner, '/api/autopilot', 'PUT', '[]')).status, 400);
  assert.equal((await request(owner, '/api/autopilot', 'PUT', '{"__proto__":{"enabled":true}}')).status, 400);
  const ownBefore = await request(owner, '/api/control');
  const other = await request(beta, '/api/control?workspaceId=alpha');
  assert.ok(!JSON.stringify(other.body).includes('Alpha secret goal'));
  assert.equal((await request(beta, `/api/decision-memory/${decision.body.decision.id}`, 'PUT', { revision: 1 })).status, 404);
  assert.equal((await request(beta, `/api/exceptions/${a.exceptions[0].id}`, 'PATCH', { status: 'dismissed', note: 'Cross tenant' })).status, 404);
  assert.equal((await request(beta, `/api/approvals/${approval.id}/decision`, 'POST', { decision: 'approved' })).status, 404);
  assert.equal((await request(beta, `/api/opportunities/${a.opportunities[0].id}/approval`, 'POST', {})).status, 404);
  assert.equal((await request(owner, '/api/control')).body.decisions.length, ownBefore.body.decisions.length);
  const modified = await request(owner, `/api/approvals/${approval.id}`, 'PATCH', { revision: 1, action: 'Revised supplier proposal' });
  assert.equal(modified.status, 200); assert.equal(modified.body.approval.revision, 2);
  assert.equal((await request(owner, `/api/approvals/${approval.id}/decision`, 'POST', { decision: 'approved', revision: 1 })).status, 409);
  const approved = await request(owner, `/api/approvals/${approval.id}/decision`, 'POST', { decision: 'approved', revision: 2 });
  assert.equal(approved.status, 200); assert.equal(approved.body.approval.workStatus, 'BLOCKED'); assert.equal(approved.body.executedExternally, false);
  assert.equal((await request(owner, `/api/approvals/${approval.id}/decision`, 'POST', { decision: 'rejected', revision: 2 })).status, 409);
  assert.equal((await request(owner, '/api/agents/commander/settings', 'PUT', { autonomy: 2, enabled: false })).status, 200);
  assert.equal((await request(owner, '/api/agents/command', 'POST', { command: 'Check stock' })).status, 409);
  assert.equal((await request(owner, '/api/control')).body.workRecords[0].status, 'BLOCKED');
  assert.equal((await request(owner, '/api/auth/logout', 'POST', {})).status, 200);
  assert.equal((await request(owner, '/api/control')).status, 401);
});

test('production refuses ephemeral persistence while development remains usable', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-production-'));
  const server = createPacksmartServer({ NODE_ENV: 'production', SAAS_STATE_FILE: path.join(directory, 'state.json'), SESSION_SECRET: 'test-session-secret-more-than-32-characters', CREDENTIALS_KEY: 'test-credential-key-more-than-32-characters', PACKSMART_ADMIN_PASSWORD: 'TestProduction!2026Only', AUTOPILOT_ENABLED: 'false' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
  assert.equal(response.status, 503); assert.equal((await response.json()).productionReady, false);
});
