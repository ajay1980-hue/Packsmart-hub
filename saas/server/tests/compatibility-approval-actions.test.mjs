import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';

const SECRET = 'compatibility-approval-synthetic-session-over-32';
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'compatibility-approval-'));
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: SECRET,
    SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' },
  { schedulerEnabled: false, agentOpsEnabled: false, fetchImpl: async () => assert.fail('No provider request is permitted in this fixture') });
  const state = seedWorkspaceState({}, { workspaceId: 'bridge-approval', email: 'owner@bridge.test', passwordHash: 'fixture' });
  const owner = state.users[0];
  state.approvals = [{ id: 'approval-one', type: 'product_edit', action: 'Reviewed edit', reason: 'Synthetic proposal',
    status: 'pending', revision: 1, requestedBy: owner.id, payload: { connectionWriteId: 'future-write', digest: 'future-digest' } }];
  state.connectionWrites = [
    { id: 'ordinary-write', approvalId: 'approval-one', provider: 'shopify', input: { operation: 'product_content' }, digest: 'other-digest', status: 'pending_approval' },
    { id: 'future-write', approvalId: 'approval-one', provider: 'shopify', input: { operation: 'product_content' }, digest: 'future-digest', status: 'pending_approval',
      objectivePolicyProposal: { schema: 'future/v2', privateSource: 'must-remain-retained' } }
  ];
  await server.packsmart.store.save(state.workspace.id, state);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await server.packsmart.drain(); await fs.rm(directory, { recursive: true, force: true }); });
  const token = createSessionToken({ userId: owner.id, workspaceId: state.workspace.id, email: owner.email, role: 'owner', sessionVersion: 1 }, SECRET);
  return { store: server.packsmart.store, state, request: async (suffix, method, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/approvals/${suffix}`, { method,
      headers: { Cookie: `packsmart_session=${token}`, 'X-CSRF-Token': verifySessionToken(token, SECRET).csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  } };
}
for (const decision of ['approved', 'rejected', 'edit']) test(`ambiguous retained future write cannot be ${decision} through a preceding ordinary link`, async t => {
  const f = await fixture(t), before = await f.store.get(f.state.workspace.id);
  const result = decision === 'edit' ? await f.request('approval-one', 'PATCH', { revision: 1, action: 'Changed' })
    : await f.request('approval-one/decision', 'POST', { revision: 1, decision });
  assert.equal(result.status, 409); assert.equal(result.body.code, 'WRITE_POLICY_UNSUPPORTED');
  assert.deepEqual(await f.store.get(f.state.workspace.id), before);
});
test('standalone future approval binding is retained and unknown IDs remain not found', async t => {
  const f = await fixture(t), state = await f.store.get(f.state.workspace.id);
  state.connectionWrites = []; state.approvals[0].payload.objectivePolicyBinding = { source: 'private future authority' };
  await f.store.save(state.workspace.id, state);
  const before = await f.store.get(state.workspace.id);
  for (const [suffix, method, body] of [['approval-one/decision', 'POST', { revision: 1, decision: 'approved' }], ['approval-one', 'PATCH', { revision: 1, action: 'Changed' }]]) {
    const result = await f.request(suffix, method, body);
    assert.equal(result.status, 409); assert.equal(result.body.code, 'WRITE_POLICY_UNSUPPORTED');
    assert.deepEqual(await f.store.get(state.workspace.id), before);
  }
  assert.equal((await f.request('absent', 'PATCH', { revision: 1, action: 'Changed' })).status, 404);
});
