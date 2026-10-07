import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { detectExceptions, detectOpportunities } from '../lib/control.mjs';
import { buildDailyBrief } from '../lib/operations.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
import { prepareExperimentOutcomeMeasurement } from '../lib/experiment-measurements.mjs';

// Frozen prior calculation-version cache contract. This deliberately does not use the current
// signature helper: the fixture must remain a cache written by the old logic.
function legacySignature(state, calculationVersion) {
  return createHash('sha256').update(JSON.stringify({
    calculationVersion,
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

for (const calculationVersion of ['catalogue-financial-eligibility/v1', 'imported-order-analytics/v2'])
for (const storage of ['file', 'mock-supabase']) test(`${storage}: bootstrap invalidates ${calculationVersion} analysis once while retaining source orders, owner evidence and history`, async t => {
  const signature = state => legacySignature(state, calculationVersion);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-brief-version-'));
  const secret = 'brief-version-fixture-session-secret-over-32-characters';
  const database = storage === 'mock-supabase' ? fakeSupabase() : null;
  const store = database ? createStore({ SUPABASE_URL: 'https://brief-version.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only' }, { fetchImpl: database.fetchImpl }) : null;
  const server = createPacksmartServer({ NODE_ENV: 'test', SESSION_SECRET: secret, CREDENTIALS_KEY: 'brief-version-fixture-credential-key-over-32-characters',
    SAAS_STATE_FILE: path.join(directory, 'state.json'), SHOPIFY_PUBLIC_SYNC_ENABLED: 'false' }, { schedulerEnabled: false, agentOpsEnabled: false, ...(store ? { store } : {}) });
  t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const state = seedWorkspaceState({}, { workspaceId: 'brief-version-fixture', email: 'owner@brief-version.test', passwordHash: 'test-only' });
  const now = new Date().toISOString();
  state.products = [{ id: 'p', provider: 'shopify', title: 'Recorded packaging fixture', status: 'active',
    description: 'Recorded packaging catalogue information. '.repeat(5), image: 'https://example.invalid/image.png',
    variants: [{ id: 'missing', sku: 'MISSING', price: null, inventory: 50 }, { id: 'stock', sku: 'STOCK', price: 10, inventory: 1 }] }];
  const costs = { landed: 6, packing: 0, handling: 0, delivery: 0, paymentFee: 0, channelFee: 0, advertising: 0, otherVariable: 0 };
  state.economics = { MISSING: { ...costs }, STOCK: { ...costs } };
  state.orders = [{ id: 'legacy-derived-refund-field', provider: 'shopify', currency: 'GBP',
    createdAt: new Date(Date.now() - 3600000).toISOString(), updatedAt: now, financialStatus: 'PAID', fulfillmentStatus: 'FULFILLED',
    total: 120, currentTotal: 100, refunds: 20, tax: 20, currentTax: 20,
    lineItems: [{ id: 'recorded-line', sku: 'STOCK', quantity: 1, gross: 120, net: 100 }] }];
  state.revenueEngine.experiments = [{ id: 'historical-owner-measurement', title: 'Owner recorded contribution', status: 'measured',
    outcomeMeasurement: prepareExperimentOutcomeMeasurement({ expectedRevision: 0, amount: '12.000001', currency: 'GBP',
      window: { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' },
      coverage: { status: 'complete', observedCount: 2, expectedCount: 2 }, method: { kind: 'reconciled_manual' },
      observedAt: '2026-10-06T12:00:00.000Z', report: { description: 'Synthetic owner evidence independent of catalogue calculations.', costsComplete: true }
    }, { workspaceId: state.workspace.id, experimentId: 'historical-owner-measurement', actorId: state.users[0].id,
      now: '2026-10-06T16:00:00.000Z', previousMeasurement: null }) }];
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
    summary: '1 fully costed variant is below its contribution-margin floor.', attention: { exceptions: 2 }, sourceSignature: signature(state) };
  legacyBrief.calculationVersion = calculationVersion;
  state.dailyBriefs = [legacyBrief];
  state.controlSignature = signature(state);
  state.agentRuns = [{ id: 'legacy-agent-run', completedAt: now, status: 'Completed', summary: '1 variant is below its margin floor.',
    results: [{ agentId: 'pricing', status: 'Warning', finding: '1 variant is below its margin floor.', confidence: 0.94, issues: [] }] }];
  await server.packsmart.store.save(state.workspace.id, state);
  if (store) {
    // Model an old cache over an already healthy saved Supabase snapshot.
    // Initial persistence establishes its ordinary reporting status first.
    state.controlSignature = signature(state);
    state.dailyBriefs[0].sourceSignature = state.controlSignature;
    await store.save(state.workspace.id, state);
  }
  const before = await server.packsmart.store.get(state.workspace.id);
  assert.equal(before.controlSignature, signature(before), 'The old implementation would skip reconciliation for these exact persisted inputs');
  assert.equal(before.dailyBriefs[0].sourceSignature, before.controlSignature);
  assert.equal(before.dailyBriefs[0].logic, 'deterministic-v2');
  const preservedBrief = structuredClone(before.dailyBriefs[0]);
  const preservedException = structuredClone(before.exceptions.find(row => row.id === oldException.id));
  const preservedAgentRuns = structuredClone(before.agentRuns);
  const preservedMeasurements = structuredClone(before.revenueEngine.experiments);
  const preservedOrders = structuredClone(before.orders);
  const preservedNormalizedBrief = database ? structuredClone(database.tables.get('operations_briefs').find(row => row.id === preservedBrief.id)) : null;
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
  const activityBefore = store?.activitySnapshot(state.workspace.id);
  const callsBefore = database?.calls.length;
  const first = await bootstrap();
  assert.notEqual(first.brief.id, preservedBrief.id, 'Changed calculation semantics must invalidate a same-day cache');
  assert.equal(first.dashboard.lowMargin, 0);
  assert.equal(first.brief.lowMargin, 0);
  assert.equal(first.brief.calculationVersion, 'imported-order-analytics/v3');
  assert.equal(first.dashboard.refundedOrders30d, 0, 'derived legacy amounts cannot survive as refund review counts');
  assert.equal(first.dashboard.customerServiceIssues, 0);
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
  assert.deepEqual(after.revenueEngine.experiments, preservedMeasurements, 'cache-version changes do not rewrite typed owner evidence');
  assert.deepEqual(after.orders, preservedOrders, 'cache-version changes do not rewrite source orders');
  if (database) {
    const calls = database.calls.slice(callsBefore);
    const primary = calls.filter(call => call.method === 'PATCH' && call.url.pathname.endsWith('/saas_workspace_state'));
    const reporting = calls.filter(call => call.url.pathname.endsWith('/rpc/runvara_commit_reporting_status'));
    const mirroredBriefs = calls.filter(call => call.method === 'POST' && call.url.pathname.endsWith('/operations_briefs'))
      .flatMap(call => JSON.parse(call.body));
    assert.equal(primary.length, 1, 'the calculation-version change causes exactly one primary reconciliation');
    assert.equal(reporting.length, 1);
    assert.ok(Buffer.byteLength(reporting[0].body) <= 16384);
    assert.equal(Object.hasOwn(JSON.parse(reporting[0].body), 'state'), false);
    assert.ok(preservedNormalizedBrief);
    assert.deepEqual(database.tables.get('operations_briefs').find(row => row.id === preservedBrief.id), preservedNormalizedBrief);
    assert.equal(mirroredBriefs.some(row => row.id === preservedBrief.id), false, 'unchanged historical normalized briefs are not rewritten');
    assert.ok(calls.every(call => !call.url.pathname.includes('business_outcome')), 'cache reconciliation cannot publish or rewrite outcome history');
    assert.ok(calls.every(call => call.method === 'GET' || !/\/(orders|order_financials)$/.test(call.url.pathname)), 'unchanged source orders do not trigger reporting reuploads');
    const observed = store.activitySnapshot(state.workspace.id);
    assert.equal(observed.db.operations.state_commit - activityBefore.db.operations.state_commit, 1);
    assert.equal(observed.db.operations.reporting_commit - activityBefore.db.operations.reporting_commit, 1);
    assert.equal(observed.hotState.confirmed.observations - activityBefore.hotState.confirmed.observations, 1);
    assert.equal(observed.hotState.confirmed.bytes, Buffer.byteLength(JSON.stringify(JSON.parse(primary[0].body).state)));
  }
  const secondCallsBefore = database?.calls.length;
  const secondActivityBefore = store?.activitySnapshot(state.workspace.id);
  const second = await bootstrap();
  const unchanged = await server.packsmart.store.get(state.workspace.id);
  assert.equal(second.brief.id, first.brief.id, 'The new cache is reusable without another calculation-version invalidation');
  assert.equal(unchanged._revision, after._revision, 'Unchanged reads do not introduce additional saves');
  assert.deepEqual(unchanged.dailyBriefs, after.dailyBriefs);
  assert.deepEqual(unchanged.revenueEngine.experiments, preservedMeasurements);
  assert.deepEqual(unchanged.orders, preservedOrders);
  if (database) {
    assert.ok(database.calls.slice(secondCallsBefore).every(call => call.method === 'GET'), 'unchanged bootstrap must not issue a primary, reporting or metadata write');
    const observed = store.activitySnapshot(state.workspace.id);
    assert.equal(observed.db.operations.state_commit, secondActivityBefore.db.operations.state_commit);
    assert.equal(observed.db.operations.reporting_commit, secondActivityBefore.db.operations.reporting_commit);
    assert.deepEqual(observed.hotState, secondActivityBefore.hotState);
    assert.deepEqual(database.tables.get('operations_briefs').find(row => row.id === preservedBrief.id), preservedNormalizedBrief);
  }
  assert.equal(providerCalls, 0);
});
