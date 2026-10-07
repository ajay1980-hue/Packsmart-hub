import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState } from '../lib/store.mjs';
import { detectExceptions, detectOpportunities } from '../lib/control.mjs';
import { buildDailyBrief } from '../lib/operations.mjs';
import { createSessionToken } from '../lib/security.mjs';

// Frozen pre-version cache contract. This deliberately does not use the current
// signature helper: the fixture must remain a cache written by the old logic.
function legacySignature(state) {
  return createHash('sha256').update(JSON.stringify({
    products: state.products || [], orders: state.orders || [], economics: state.economics || {},
    advertisingCosts: state.advertisingCosts || [], revenueEngine: state.revenueEngine || {}, approvals: state.approvals || [],
    integrationStatus: Object.fromEntries(Object.entries(state.integrationStatus || {}).map(([key, value]) => [key, {
      status: value.status, source: value.source, lastError: value.lastError,
      lastSyncAt: ['supabase', 'reporting', 'render'].includes(key) ? null : value.lastSyncAt
    }])),
    automations: state.automations || {}, suppliers: state.suppliers || [],
    decisions: (state.decisions || []).filter(item => item.status === 'active').map(item => item.id),
    exceptions: (state.exceptions || []).map(item => [item.id, item.status]),
    automationFailures: (state.automationRuns || []).filter(item => ['FAILED', 'BLOCKED'].includes(item.status)).map(item => item.id)
  })).digest('hex').slice(0, 32);
}

test('bootstrap invalidates legacy same-input analysis once while retaining briefs, exception history and agent runs', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-brief-version-'));
  const secret = 'brief-version-fixture-session-secret-over-32-characters';
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: 'brief-version-fixture-credential-key-over-32-characters',
    SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' }, { schedulerEnabled: false, agentOpsEnabled: false });
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const state = seedWorkspaceState({}, { workspaceId: 'brief-version-fixture', email: 'owner@brief-version.test', passwordHash: 'test-only' });
  const now = new Date().toISOString();
  state.products = [{ id: 'p', provider: 'shopify', title: 'Recorded packaging fixture', status: 'active',
    description: 'Recorded packaging catalogue information. '.repeat(5), image: 'https://example.invalid/image.png',
    variants: [{ id: 'missing', sku: 'MISSING', price: null, inventory: 50 }, { id: 'stock', sku: 'STOCK', price: 10, inventory: 1 }] }];
  const costs = { landed: 6, packing: 0, handling: 0, delivery: 0, paymentFee: 0, channelFee: 0, advertising: 0, otherVariable: 0 };
  state.economics = { MISSING: { ...costs }, STOCK: { ...costs } };
  detectExceptions(state, 'fixture'); detectOpportunities(state, 'fixture');
  const acknowledged = state.exceptions.find(row => row.kind === 'stock');
  acknowledged.status = 'acknowledged';
  acknowledged.history.push({ status: 'acknowledged', actor: 'owner', at: now, note: 'Owner is reviewing the stock condition.' });
  const oldException = { id: 'legacy-null-margin', fingerprint: 'margin_' + createHash('sha256').update('MISSING').digest('hex').slice(0, 24),
    kind: 'margin', reference: 'MISSING', severity: 'medium', title: 'Margin attention: MISSING', status: 'open', present: true,
    businessImpact: 'Current recorded costs leave less contribution than the configured target.', rootCause: 'null% margin; target 20%.',
    recommendedAction: 'Review source costs and prepare a price proposal for approval.', owner: 'pricing', createdAt: now, lastSeenAt: now,
    evidence: [{ type: 'economics', id: 'MISSING', detail: 'Price null; variable cost 6.' }],
    history: [{ status: 'open', actor: 'system', at: now, note: 'Detected under prior calculation rules.' }] };
  state.exceptions.push(oldException);
  const legacyBrief = { ...buildDailyBrief(state), id: 'legacy-same-day-brief', lowMargin: 1, averageMargin: 20,
    summary: '1 fully costed variant is below its contribution-margin floor.', attention: { exceptions: 2 }, sourceSignature: legacySignature(state) };
  delete legacyBrief.calculationVersion;
  state.dailyBriefs = [legacyBrief];
  state.controlSignature = legacySignature(state);
  state.agentRuns = [{ id: 'legacy-agent-run', completedAt: now, status: 'Completed', summary: '1 variant is below its margin floor.',
    results: [{ agentId: 'pricing', status: 'Warning', finding: '1 variant is below its margin floor.', confidence: 0.94, issues: [] }] }];
  await server.packsmart.store.save(state.workspace.id, state);
  const before = await server.packsmart.store.get(state.workspace.id);
  assert.equal(before.controlSignature, legacySignature(before), 'The old implementation would skip reconciliation for these exact persisted inputs');
  assert.equal(before.dailyBriefs[0].sourceSignature, before.controlSignature);
  assert.equal(before.dailyBriefs[0].logic, 'deterministic-v2');
  const preservedBrief = structuredClone(before.dailyBriefs[0]);
  const preservedException = structuredClone(before.exceptions.find(row => row.id === oldException.id));
  const preservedAgentRuns = structuredClone(before.agentRuns);
  const preservedAcknowledgement = structuredClone(before.exceptions.find(row => row.id === acknowledged.id).history);
  let providerCalls = 0;
  server.packsmart.integrations.syncAll = async () => { providerCalls++; assert.fail('Cache reconciliation must not call providers'); };
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const token = createSessionToken({ userId: state.users[0].id, workspaceId: state.workspace.id, email: state.users[0].email, role: 'owner', sessionVersion: 1 }, secret);
  const bootstrap = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bootstrap`, { headers: { Cookie: `packsmart_session=${token}` } });
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await bootstrap();
  assert.notEqual(first.brief.id, preservedBrief.id, 'Changed calculation semantics must invalidate a same-day cache');
  assert.equal(first.dashboard.lowMargin, 0);
  assert.equal(first.brief.lowMargin, 0);
  assert.doesNotMatch(first.brief.summary, /below their contribution-margin floor|below its contribution-margin floor/);
  const active = first.exceptions.filter(row => row.present && ['open', 'acknowledged'].includes(row.status));
  assert.deepEqual(active.map(row => row.id), [acknowledged.id]);
  assert.equal(first.brief.attention.exceptions, active.length, 'Brief attention uses the same present-record predicate as the UI');
  assert.match(first.brief.summary, /1 open exceptions/);
  const after = await server.packsmart.store.get(state.workspace.id);
  assert.notEqual(after.controlSignature, before.controlSignature);
  assert.deepEqual(after.dailyBriefs.find(row => row.id === preservedBrief.id), preservedBrief);
  assert.deepEqual(after.exceptions.find(row => row.id === oldException.id), { ...preservedException, present: false });
  assert.deepEqual(after.exceptions.find(row => row.id === acknowledged.id).history, preservedAcknowledgement);
  assert.deepEqual(after.agentRuns, preservedAgentRuns);
  const second = await bootstrap();
  const unchanged = await server.packsmart.store.get(state.workspace.id);
  assert.equal(second.brief.id, first.brief.id, 'The new cache is reusable without another calculation-version invalidation');
  assert.equal(unchanged._revision, after._revision, 'Unchanged reads do not introduce additional saves');
  assert.deepEqual(unchanged.dailyBriefs, after.dailyBriefs);
  assert.equal(providerCalls, 0);
});
