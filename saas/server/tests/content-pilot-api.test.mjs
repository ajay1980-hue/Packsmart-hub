import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { contentPilotFixture } from './content-pilot-test-fixture.mjs';
import { descriptionFixture } from './description-edit-fixture.mjs';
import { objectiveContentJob, objectiveContentBody } from './objective-content-fixture.mjs';
import { objectiveContentContext } from '../lib/objective-content-source.mjs';
import { governedApproval } from '../lib/control.mjs';

for (const version of ['legacy', 'description']) test(`${version}: trusted composition admits only the exact manual proposal and approval; unrelated producers remain closed`, async t => {
  const f = version === 'description' ? await descriptionFixture() : await contentPilotFixture({ family: 'manual-v1-policy' });
  f.state.connectionWrites = []; f.state.approvals = [];
  await f.store.save(f.state.workspace.id, f.state);
  const secret = 'content-pilot-api-synthetic-session-key-000000001';
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret }, {
    store: f.store, integrations: f.service, contentPilot: f.pilot, schedulerEnabled: false, agentOpsEnabled: false,
    fetchImpl: async () => assert.fail('Unexpected external transport')
  });
  t.after(async () => { await server.packsmart.drain(); if (server.listening) await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const token = createSessionToken({ userId: f.session.userId, workspaceId: f.state.workspace.id,
    email: f.state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  const csrf = verifySessionToken(token, secret).csrf;
  const request = async (route, body, method = 'POST') => {
    const result = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method,
      headers: { Cookie: `packsmart_session=${token}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: result.status, body: await result.json() };
  };
  const wrong = await request('/api/connections/shopify/writes', { ...f.body, requestId: 'wrong-pilot-request-0001' });
  assert.equal(wrong.status, 409, JSON.stringify(wrong));
  assert.equal(wrong.body.code, 'CONTENT_PILOT_SCOPE_MISMATCH');
  const forged = await request('/api/connections/shopify/writes', { ...f.body, contentPilot: f.scope });
  assert.equal(forged.status, 400, JSON.stringify(forged));
  const prepared = await request('/api/connections/shopify/writes', f.body);
  assert.equal(prepared.status, 200, JSON.stringify(prepared));
  const pending = (await f.store.get(f.state.workspace.id)).connectionWrites[0];
  const approved = await request(`/api/approvals/${pending.approvalId}/decision`, { decision: 'approved', revision: 1 });
  assert.equal(approved.status, 200, JSON.stringify(approved));
  const durable = await f.store.get(f.state.workspace.id);
  assert.equal(durable.approvals[0].status, 'approved');
  assert.equal(durable.approvals[0].executedExternally, false);
  const objective = durable.businessObjectives[0];
  const update = await request('/api/business-objectives', { id: objective.id, revision: objective.revision, title: 'Unrelated policy edit' }, 'PUT');
  assert.equal(update.status, 503, JSON.stringify(update));
  assert.equal(update.body.code, 'GOVERNED_RECORDS_PAUSED');
  const job = objectiveContentJob(durable, objective);
  f.database.tables.set('runvara_agent_jobs', [job]);
  const context = await objectiveContentContext(durable, job.id, 'opportunity-content', f.session, async () => job);
  const objectiveRequest = await request('/api/objective-content/requests', objectiveContentBody(context, 'objective-pilot-request-001'));
  assert.equal(objectiveRequest.status, 503, JSON.stringify(objectiveRequest));
  assert.equal(objectiveRequest.body.code, 'GOVERNED_RECORDS_PAUSED');
  assert.equal(f.counts.mutations, 0); assert.equal(f.baselineReads.length, 0);
});

test('capability removal also closes approval of an existing description request without objective policies', async t => {
  const f = await descriptionFixture({ family: 'manual' });
  f.write.status = 'pending_approval'; f.state.approvals[0].status = 'pending';
  assert.equal(f.write.objectivePolicyProposal, undefined);
  assert.equal(governedApproval(f.state, f.state.approvals[0]), true);
  await f.store.save(f.state.workspace.id, f.state);
  const secret = 'description-pilot-removal-synthetic-secret-0000001';
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret },
    { store: f.store, integrations: f.service, schedulerEnabled: false, agentOpsEnabled: false, fetchImpl: async () => assert.fail('No external transport') });
  t.after(async () => { await server.packsmart.drain(); if (server.listening) await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const token = createSessionToken({ userId: f.session.userId, workspaceId: f.state.workspace.id,
    email: f.state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/approvals/${f.write.approvalId}/decision`, {
    method: 'POST', headers: { Cookie: `packsmart_session=${token}`, 'X-CSRF-Token': verifySessionToken(token, secret).csrf,
      'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'approved', revision: 1 }) });
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'CONTENT_PILOT_REQUIRED');
  assert.equal((await f.store.get(f.state.workspace.id)).approvals[0].status, 'pending');
  assert.equal(f.counts.mutations, 0); assert.equal(f.counts.credentials, 0);
});
