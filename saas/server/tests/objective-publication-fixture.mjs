// Reuses the actual objective producer, approved retained request and dispatcher.
// Only provider and durable-store transports are synthetic. SQL transaction
// guarantees must be established by the separate actual PostgreSQL tests.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { objectiveContentFixture } from './objective-content-fixture.mjs';
import { resolveRecordedActionEvidence } from '../lib/reviewed-action-evidence.mjs';
import { createPacksmartServer } from '../server.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';

async function approveThroughExistingRoute({ store, workspaceId, session, write }) {
  const secret = 'objective-publication-approval-fixture-at-least-thirty-two-characters';
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: secret, SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' }, {
    store, schedulerEnabled: false, agentOpsEnabled: false,
    fetchImpl: async () => assert.fail('Approval must not call a provider')
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const token = createSessionToken({ ...session, email: 'content-owner@example.test', role: 'owner' }, secret);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/approvals/${write.approvalId}/decision`, {
      method: 'POST', headers: { Cookie: `packsmart_session=${token}`, 'X-CSRF-Token': verifySessionToken(token, secret).csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: 1, decision: 'approved' })
    });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.approval.status, 'approved');
  } finally {
    await server.packsmart.drain(); await new Promise(resolve => server.close(resolve));
  }
}

export async function objectivePublicationFixture(options = {}) {
  const f = await objectiveContentFixture({ ...options, approveRequest: approveThroughExistingRoute });
  if (options.beforeDispatch) await options.beforeDispatch(f);
  const completed = await f.run();
  assert.equal(completed.status, 'completed', completed.errorCode);
  assert.equal(f.counts.mutations, 1);
  const source = resolveRecordedActionEvidence(f.state, f.write.id);
  return { ...f, completed, source, workspaceId: f.state.workspace.id,
    approval: f.state.approvals.find(row => row.id === f.write.approvalId),
    connection: f.state.connections.find(row => row.id === f.write.connectionId) };
}

export function objectivePublicationMeasurementInput({ expectedRevision = 0, actionSelection, amount = '10.25', now = Date.now() } = {}) {
  const end = new Date(now - 86400000), start = new Date(end.valueOf() - 86400000);
  return { expectedRevision, amount, currency: 'GBP', window: { startsAt: start.toISOString(), endsAt: end.toISOString() },
    coverage: { status: 'complete', observedCount: 2, expectedCount: 2 }, method: { kind: 'reconciled_manual' }, observedAt: end.toISOString(),
    report: { description: 'Owner-reviewed synthetic revenue less recorded variable costs; no causal effect is established.', costsComplete: true },
    ...(actionSelection !== undefined ? { actionSelection } : {}) };
}
