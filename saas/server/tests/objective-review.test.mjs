import test from 'node:test';
import assert from 'node:assert/strict';
import { buildObjectiveReview, OBJECTIVE_REVIEW_LIMITS } from '../lib/objective-review.mjs';
import { upsertBusinessObjective } from '../lib/business-objectives.mjs';
import { RISKY_ACTION_TYPES } from '../lib/security.mjs';

const NOW = '2026-10-06T18:00:00.000Z';
function fixture(metric = 'contribution_profit') {
  const state = { workspace: { id: 'tenant-a' }, settings: { currency: 'GBP', growthCapacityHours: 4, maxConcurrentGrowthExperiments: 2 },
    opportunities: [{ id: 'opportunity_1', kind: 'pricing', present: true, status: 'open', title: 'Raise recorded product margin', executionCost: 0, effortHours: 1, confidence: 0.9, risk: 'low', requiredAction: 'major_price_change', experimentId: 'experiment_1' },
      { id: 'opportunity_2', kind: 'operations', present: true, status: 'open', title: 'Internal operations analysis', executionCost: 0, effortHours: 1, confidence: 0.8, risk: 'low' }],
    decisions: [], approvals: [], exceptions: [], revenueEngine: { experiments: [{ id: 'experiment_1', opportunityId: 'opportunity_1', status: 'completed', completedAt: NOW, impact: { verified: true, incrementalContribution: 100 } }] } };
  const objective = upsertBusinessObjective(state, { title: 'Improve contribution', metric, baseline: metric === 'stock_cover_days' ? 5 : 20,
    target: metric === 'stock_cover_days' ? 20 : 40, direction: 'increase', startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-31T23:59:59.000Z',
    limits: { currency: 'GBP', minGrossMarginPercent: 10, minStockCoverDays: 5, profitFirst: true, maxMonthlyAdBudget: metric === 'monthly_ad_spend' ? 50 : 0 } }, { workspaceId: 'tenant-a', now: NOW });
  const input = { objectiveId: objective.id, objectiveRevision: objective.revision, jobId: 'job_fixture' };
  const options = { workspaceId: 'tenant-a', now: NOW };
  return { state, objective, input, options };
}
const run = fixture => buildObjectiveReview(fixture.state, fixture.input, fixture.options);
const codes = row => row.blockers.map(blocker => blocker.code);
function freeze(value) { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }

test('an active objective produces a stable, bounded specialist diagnostic report with commercial proposals still blocked', () => {
  const f = fixture(); const report = run(f);
  assert.equal(report.reportCompleted, true);
  assert.equal(report.reportStatus, 'completed_with_gaps');
  assert.equal(report.commercialReady, false);
  assert.equal(report.objectiveId, f.objective.id);
  assert.equal(report.objectiveRevision, f.objective.revision);
  assert.equal(report.jobId, f.input.jobId);
  assert.deepEqual(report.specialists.map(row => row.agentId), ['finance', 'pricing', 'stock']);
  assert.equal(report.specialists.length, 3);
  assert.ok(report.specialists.every(task => task.status === 'completed' && task.dependsOn[0] === report.sourceResolution.id));
  assert.deepEqual(report.synthesis.dependsOn, report.specialists.map(row => row.id));
  assert.deepEqual(report.proposals.map(row => row.opportunityId), ['opportunity_1', 'opportunity_2']);
  assert.ok(report.proposals.every(row => row.readyForPreparation === false && row.commercialReady === false && row.externalExecutionAllowed === false));
  assert.equal(report.summary.proposalsReady, 0);
  assert.equal(report.summary.proposalsBlocked, 2);
  assert.deepEqual(run(f), report, 'same source, job and clock give an identical result');
  const again = run({ ...f, options: { ...f.options, now: '2026-10-06T18:01:00.000Z' } });
  assert.equal(again.id, report.id);
  assert.deepEqual(again.specialists.map(row => row.id), report.specialists.map(row => row.id));
  assert.notEqual(run({ ...f, input: { ...f.input, jobId: 'job_another' } }).id, report.id);
});

test('all supported objective metrics route at most three known typed specialists', () => {
  for (const metric of ['revenue', 'orders', 'gross_profit', 'contribution_profit', 'gross_margin_percent', 'monthly_ad_spend', 'stock_cover_days']) {
    const report = run(fixture(metric));
    assert.equal(report.reportCompleted, true, metric);
    assert.ok(report.specialists.length > 0 && report.specialists.length <= OBJECTIVE_REVIEW_LIMITS.specialists);
    assert.equal(new Set(report.specialists.map(row => row.id)).size, report.specialists.length);
    assert.ok(report.specialists.every(row => ['economics_review', 'margin_review', 'stock_constraint_review', 'advertising_budget_review', 'revenue_review'].includes(row.type)));
  }
});

test('tenant scope, objective revision, server-assigned job identity and request shape are strict', () => {
  const f = fixture();
  for (const patch of [{ workspaceId: 'tenant-b' }, { tenantId: 'tenant-b' }, { tenant_id: 'tenant-b' }, { workspace_id: 'tenant-b' }]) {
    assert.throws(() => buildObjectiveReview(f.state, { ...f.input, ...patch }, f.options), e => e.code === 'WORKSPACE_MISMATCH');
  }
  assert.throws(() => buildObjectiveReview(f.state, f.input, { ...f.options, workspaceId: 'tenant-b' }), e => e.code === 'WORKSPACE_MISMATCH');
  assert.throws(() => run({ ...f, input: { ...f.input, objectiveRevision: 2 } }), e => e.code === 'OBJECTIVE_CONFLICT');
  assert.throws(() => run({ ...f, input: { ...f.input, objectiveId: 'unknown' } }), e => e.code === 'OBJECTIVE_NOT_FOUND');
  for (const patch of [{ objectiveRevision: '1' }, { objectiveRevision: NaN }, { objectiveRevision: 0 }, { jobId: 'customer@example.com' }, { jobId: '' }, { command: 'publish now' }, { provider: 'openai' }, { evidence: {} }, { agentIds: ['marketing'] }, { approved: true }]) {
    assert.throws(() => run({ ...f, input: { ...f.input, ...patch } }), e => e.code === 'VALIDATION_FAILED');
  }
  assert.throws(() => run({ ...f, options: { ...f.options, proposalLimit: 1000 } }), e => e.code === 'VALIDATION_FAILED');
  assert.throws(() => run({ ...f, state: { ...f.state, tenantId: 'tenant-b' } }), e => e.code === 'WORKSPACE_MISMATCH');
  f.state.businessObjectives[0].workspaceId = 'tenant-b';
  assert.throws(() => run(f), e => e.code === 'WORKSPACE_MISMATCH');
});

test('paused, disabled, cancelled, completed, scheduled and expired objectives produce no tasks', () => {
  for (const status of ['paused', 'disabled', 'cancelled', 'completed']) {
    const f = fixture(); f.state.businessObjectives[0].status = status;
    const report = run(f);
    assert.equal(report.reportCompleted, false); assert.equal(report.reportStatus, 'blocked');
    assert.deepEqual(report.specialists, []); assert.deepEqual(report.proposals, []);
    assert.ok(codes(report).includes('OBJECTIVE_NOT_ACTIVE'));
  }
  for (const now of ['2026-09-30T12:00:00.000Z', '2026-11-01T00:00:00.000Z']) {
    const f = fixture(); f.options.now = now;
    assert.ok(codes(run(f)).includes('OBJECTIVE_NOT_ACTIVE'));
  }
});

test('Commander and specialist enablement and malformed policies fail closed', () => {
  for (const commander of [{ enabled: false }, { enabled: 'true' }, { autonomy: 4 }, { autonomy: null }, { workspaceId: 'tenant-b' }]) {
    const f = fixture(); f.state.agentSettings = { commander };
    const report = run(f);
    assert.equal(report.reportCompleted, false); assert.equal(report.specialists.length, 0);
  }
  const f = fixture(); f.state.agentSettings = { pricing: { enabled: false }, stock: { autonomy: '3' } };
  const report = run(f);
  assert.equal(report.reportCompleted, true);
  assert.equal(report.summary.specialistsCompleted, 1);
  for (const task of report.specialists.filter(row => row.status === 'blocked')) {
    assert.deepEqual(task.findings, []); assert.deepEqual(task.sourceRefs, []); assert.deepEqual(task.recommendations, []);
  }
  f.state.agentSettings.finance = { enabled: false };
  assert.equal(run(f).reportCompleted, false);
  f.state.agentSettings = { workspaceId: 'tenant-b' };
  assert.equal(run(f).reportCompleted, false);
});

test('observe-only policy never produces recommendations or business proposals', () => {
  const f = fixture(); f.state.agentSettings = { commander: { autonomy: 0 } };
  const report = run(f);
  assert.equal(report.reportCompleted, true);
  assert.equal(report.summary.recommendationsSuppressed, true);
  assert.deepEqual(report.proposals, []);
  assert.ok(report.specialists.every(task => task.mode === 'observe' && task.recommendations.length === 0));
  f.state.agentSettings = { finance: { autonomy: 0 } };
  assert.equal(run(f).specialists.find(row => row.agentId === 'finance').recommendations.length, 0);
});

test('resolved original references contain typed facts but no raw source text, customer identity or credentials', () => {
  const f = fixture();
  f.state.connections = [{ encryptedCredentials: 'credential-secret' }];
  f.state.orders = [{ customerEmail: 'customer@example.com', address: 'private-address' }];
  Object.assign(f.state.opportunities[0], { title: 'source-title-secret', reference: 'raw-sku-secret', recommendedNextStep: 'INJECTED_INSTRUCTION',
    evidence: [{ type: 'economics', detail: 'private-evidence-secret', payload: { token: 'payload-secret' } }], customerEmail: 'email-secret' });
  f.state.revenueEngine.experiments[0].impact.notes = 'experiment-note-secret';
  const report = run(f), json = JSON.stringify(report);
  for (const value of ['credential-secret', 'customer@example.com', 'private-address', 'source-title-secret', 'raw-sku-secret', 'INJECTED_INSTRUCTION', 'private-evidence-secret', 'payload-secret', 'email-secret', 'experiment-note-secret']) assert.equal(json.includes(value), false, value);
  const row = report.proposals.find(row => row.opportunityId === 'opportunity_1');
  assert.equal(row.sourceReferenceResolved, true);
  assert.equal(row.sourceRef.recordId, 'opportunity_1');
  assert.equal(row.sourceRef.collection, 'opportunities');
  assert.match(row.sourceRef.identityHash, /^[a-f0-9]{32}$/);
  assert.equal(row.evidence.historicalSourceRef.collection, 'revenueEngine.experiments');
  assert.equal(row.measurementsVerified, false);
  f.state.opportunities.push({ id: 'private@example.com', kind: 'operations' });
  const excluded = run(f);
  assert.equal(excluded.sourceResolution.unsafeIdentityExcluded, 1);
  assert.equal(JSON.stringify(excluded).includes('private@example.com'), false);
});

test('canonical dismissals, exclusions, reciprocal verification and ambiguous identities remain authoritative', () => {
  const f = fixture();
  f.state.opportunities.push({ id: 'dismissed', status: 'dismissed', kind: 'pricing' }, { id: 'absent', present: false },
    { id: 'excluded', reference: 'SKU-EXCLUDED' }, { id: 'rejected' }, { id: 'duplicate', executionCost: 0 }, { id: 'duplicate', executionCost: 100 },
    { id: 'fingerprint_a', fingerprint: 'same' }, { id: 'fingerprint_b', fingerprint: 'same' }, { id: 'foreign', tenant_id: 'tenant-b' });
  f.state.decisions = [{ status: 'active', category: 'product_exclusion', target: 'SKU-EXCLUDED' }, { status: 'active', category: 'rejected_idea', target: 'rejected' }];
  assert.deepEqual(run(f).proposals.map(row => row.opportunityId), ['opportunity_1', 'opportunity_2']);
  f.state.revenueEngine.experiments[0].opportunityId = 'another';
  const row = run(f).proposals.find(row => row.opportunityId === 'opportunity_1');
  assert.equal(row.evidence.historicalContribution, null);
  assert.equal(row.evidence.historicalEvidenceVerified, false);
});

test('foreign and duplicate experiment evidence cannot confer verified contribution or affect local capacity', () => {
  for (const patch of [{ workspaceId: 'tenant-b' }, { tenant: { id: 'tenant-b' } }]) {
    const f = fixture(); Object.assign(f.state.revenueEngine.experiments[0].impact, patch);
    const row = run(f).proposals.find(row => row.opportunityId === 'opportunity_1');
    assert.equal(row.evidence.historicalContribution, null);
  }
  const duplicate = fixture(); duplicate.state.revenueEngine.experiments.push(structuredClone(duplicate.state.revenueEngine.experiments[0]));
  assert.equal(run(duplicate).proposals.find(row => row.opportunityId === 'opportunity_1').evidence.historicalContribution, null);
  const invalidDuplicate = fixture();
  invalidDuplicate.state.revenueEngine.experiments.push({ ...structuredClone(invalidDuplicate.state.revenueEngine.experiments[0]), impact: { workspaceId: 'tenant-b', verified: true, incrementalContribution: 1000 } });
  assert.equal(run(invalidDuplicate).proposals.find(row => row.opportunityId === 'opportunity_1').evidence.historicalContribution, null, 'discarded nested foreign evidence must not allow its duplicate to confer verification');
  const foreign = fixture(); foreign.state.revenueEngine.workspaceId = 'tenant-b';
  assert.ok(run(foreign).evidenceGaps.some(row => row.code === 'SOURCE_SCOPE_EXCLUDED'));
  assert.equal(run(foreign).proposals.find(row => row.opportunityId === 'opportunity_1').evidence.historicalContribution, null);
});

test('unknown objective periods, gross margin, stock cover, currency and forecasts are never filled from rolling or arbitrary values', () => {
  const f = fixture('gross_margin_percent');
  f.state.profitability = { margin30d: 90, grossProfit30d: 10000 };
  f.state.advertisingCosts = [];
  Object.assign(f.state.opportunities[0], { grossMarginPercent: 99, stockCoverDays: 100, currency: 'GBP', forecastContribution: 10000, observedAt: NOW, costsComplete: true });
  const report = run(f);
  assert.equal(report.metricEvidence.value, null);
  assert.equal(report.metricEvidence.sourcePeriod, null);
  assert.equal(report.metricEvidence.currency.workspace, 'GBP');
  assert.equal(report.metricEvidence.currency.measured, null);
  const row = report.proposals[0];
  for (const field of ['grossMarginPercent', 'stockCoverDays', 'currency', 'monthlyAdSpend', 'forecastContribution', 'observedAt']) assert.equal(row.evidence[field], null, field);
  assert.equal(row.evidence.historicalContribution, 100);
  for (const code of ['TIME_BOUNDS_UNKNOWN', 'EVIDENCE_TIME_UNKNOWN', 'EVIDENCE_UNKNOWN', 'COST_EVIDENCE_INCOMPLETE', 'CURRENCY_UNKNOWN', 'STOCK_COVER_UNKNOWN', 'PROFIT_IMPACT_UNKNOWN', 'AD_SPEND_UNKNOWN']) assert.ok(codes(row).includes(code), code);
  assert.ok(report.metricEvidence.blockers.some(row => row.code === 'GROSS_MARGIN_UNRESOLVED'));
  assert.ok(run(fixture('stock_cover_days')).metricEvidence.blockers.some(row => row.code === 'STOCK_COVER_UNRESOLVED'));
  assert.ok(run(fixture('monthly_ad_spend')).metricEvidence.blockers.some(row => row.code === 'AD_MONTH_UNRESOLVED'));
});

test('zero and fractional costs/effort are preserved while approval requirements are never cleared', () => {
  const f = fixture(); f.state.settings.growthCapacityHours = 0;
  f.state.opportunities[1].effortHours = 0;
  const zero = run(f).proposals.find(row => row.opportunityId === 'opportunity_2');
  assert.equal(zero.evidence.executionCost, 0); assert.equal(zero.evidence.effortHours, 0);
  assert.equal(zero.commercialReady, false);
  assert.equal(run(f).objective.limits.maxMonthlyAdBudget, 0);
  f.state.opportunities[1].executionCost = 0.004; f.state.opportunities[1].effortHours = 0.004;
  const fractional = run(f).proposals.find(row => row.opportunityId === 'opportunity_2');
  assert.equal(fractional.evidence.executionCost, 0.004); assert.equal(fractional.evidence.effortHours, 0.004);
  assert.equal(fractional.approvalRequired, true);
  assert.ok(fractional.approvalRequiredKinds.includes('spend_money'));
  assert.ok(codes(fractional).includes('TIME_CAPACITY_EXCEEDED'));
  for (const kind of RISKY_ACTION_TYPES) {
    f.state.opportunities[1].requiredAction = kind;
    f.state.businessObjectives[0].limits.approvalRequiredKinds = [];
    f.state.approvals = [{ id: 'approved', status: 'approved', payload: { opportunityId: 'opportunity_2' } }];
    const row = run(f).proposals.find(row => row.opportunityId === 'opportunity_2');
    assert.equal(row.approvalRequired, true, kind); assert.ok(row.approvalRequiredKinds.includes(kind), kind);
  }
  f.state.opportunities[1].requiredAction = 'REFUND';
  assert.ok(run(f).proposals.find(row => row.opportunityId === 'opportunity_2').approvalRequiredKinds.includes('refund'));
});

test('existing portfolio pending approvals, active experiments and cumulative time blockers are retained', () => {
  const f = fixture();
  f.state.settings.growthCapacityHours = 1;
  delete f.state.opportunities[0].requiredAction; delete f.state.opportunities[0].experimentId;
  const report = run(f);
  assert.ok(report.proposals.some(row => row.blockers.some(blocker => blocker.message.includes('cumulative'))));
  f.state.approvals = [{ id: 'approval_1', status: 'pending', payload: { opportunityId: 'opportunity_2' } }];
  f.state.revenueEngine.experiments.push({ id: 'experiment_active', opportunityId: 'opportunity_2', status: 'running' });
  const row = run(f).proposals.find(row => row.opportunityId === 'opportunity_2');
  assert.equal(row.approvalRequired, true);
  assert.ok(row.blockers.some(blocker => blocker.message.includes('approval is pending')));
  assert.ok(row.blockers.some(blocker => blocker.message.includes('experiment is already active')));
});

test('unknown source collections are diagnosed without recreating dismissed or aggregate fallback work', () => {
  const f = fixture(); delete f.state.opportunities;
  f.state.products = [{ id: 'product', variants: [{ id: 'variant', price: 10, inventory: 0 }] }];
  const report = run(f);
  assert.equal(report.reportCompleted, true); assert.equal(report.proposals.length, 0);
  assert.equal(report.sourceResolution.complete, false);
  assert.ok(report.evidenceGaps.some(row => row.code === 'CANONICAL_OPPORTUNITIES_UNAVAILABLE'));
  f.state.opportunities = [];
  assert.equal(run(f).proposals.length, 0);
});

test('large relevant source collections fail closed rather than miss late duplicates or policy records', () => {
  for (const collection of ['opportunities', 'decisions', 'approvals', 'exceptions', 'experiments']) {
    const f = fixture();
    const rows = Array.from({ length: OBJECTIVE_REVIEW_LIMITS.sourceRecordsPerCollection + 1 }, (_, n) => ({ id: `row_${n}` }));
    if (collection === 'experiments') f.state.revenueEngine.experiments = rows; else f.state[collection] = rows;
    const report = run(f);
    assert.equal(report.proposals.length, 0, collection);
    assert.equal(report.sourceResolution.complete, false);
    assert.equal(report.sourceResolution.scanned[collection], 0);
    assert.ok(report.evidenceGaps.some(row => row.code === 'SOURCE_SCAN_LIMIT' && row.field === collection));
  }
});

test('source and output bounds are not controlled by callers and persisted reports stay compact', () => {
  const f = fixture();
  f.state.opportunities = Array.from({ length: 180 }, (_, n) => ({ id: `opportunity_${n}`, kind: 'operations', title: 'x'.repeat(100000), executionCost: 0, effortHours: 0 }));
  const report = run(f);
  assert.equal(report.sourceResolution.canonical, OBJECTIVE_REVIEW_LIMITS.canonicalOpportunities);
  assert.equal(report.proposals.length, OBJECTIVE_REVIEW_LIMITS.proposals);
  assert.equal(report.sourceResolution.proposalsOmitted, 90);
  assert.equal(report.sourceResolution.complete, false);
  assert.ok(report.evidenceGaps.some(row => row.code === 'CANONICAL_VIEW_BOUNDED'));
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 65536);
});

test('frozen source/request/clock options remain unchanged and output references are detached', () => {
  const f = fixture(), before = structuredClone(f);
  freeze(f);
  const report = run(f);
  report.objective.limits.approvalRequiredKinds.push('refund');
  report.proposals[0].sourceRef.fields.push('unrelated');
  report.specialists[0].recommendations[0].opportunityIds.push('unrelated');
  assert.deepEqual(f, before);
  assert.equal(run(f).objective.limits.approvalRequiredKinds.includes('refund'), false);
});

test('review never calls providers, changes approval records or consumes execution permissions', () => {
  const f = fixture(), before = structuredClone(f.state);
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Unexpected provider request'); };
  try {
    const report = run(f);
    assert.equal(report.safeguards.providerCalls, 0); assert.equal(report.safeguards.modelCalls, 0);
    assert.equal(report.safeguards.externalWrites, false); assert.equal(report.safeguards.approvalsCreated, false);
    assert.equal(report.safeguards.externalExecutionAllowed, false); assert.equal(report.safeguards.spendCommitted, false);
    assert.equal(report.safeguards.callerMustAuthorizeAndRevalidateQueueWork, true);
    assert.deepEqual(f.state, before);
  } finally { globalThis.fetch = previousFetch; }
});

test('source-as-of identity distinguishes read time, state revision and relevant typed evidence without claiming observation freshness', () => {
  const f = fixture(); f.state._revision = 'state_revision_1';
  const first = run(f);
  assert.equal(first.sourceAsOf.snapshotReadAt, NOW);
  assert.equal(first.sourceAsOf.stateRevision, 'state_revision_1');
  assert.equal(first.sourceAsOf.financialObservedAt, null);
  assert.match(first.sourceAsOf.typedInputFingerprint, /^[a-f0-9]{32}$/);
  f.state.opportunities[0].evidence = [{ detail: 'An unrelated private note' }];
  f.state.connections = [{ encryptedCredentials: 'must-not-enter-fingerprint' }];
  const unchanged = run(f);
  assert.equal(unchanged.sourceAsOf.typedInputFingerprint, first.sourceAsOf.typedInputFingerprint);
  f.state.opportunities[0].executionCost = 0.004;
  const changed = run(f);
  assert.equal(changed.id, first.id, 'stable job identity is separate from evidence identity');
  assert.notEqual(changed.sourceAsOf.typedInputFingerprint, first.sourceAsOf.typedInputFingerprint);
  f.state.agentSettings = { finance: { enabled: false } };
  assert.notEqual(run(f).sourceAsOf.typedInputFingerprint, changed.sourceAsOf.typedInputFingerprint);
  f.state._revision = 'state_revision_2';
  assert.equal(run(f).sourceAsOf.stateRevision, 'state_revision_2');
});

test('raw nested source payloads are not scanned, serialized or copied into the canonical review inputs', () => {
  const f = fixture();
  Object.defineProperty(f.state.opportunities[0], 'evidence', { get() { throw new Error('Raw evidence must not be read'); } });
  Object.defineProperty(f.state.revenueEngine.experiments[0].impact, 'notes', { get() { throw new Error('Free-form notes must not be read'); } });
  assert.equal(run(f).reportCompleted, true);
  f.state.opportunities.push({ id: 'opportunity_2', reference: { deeply: ['malformed'] }, executionCost: 0 });
  assert.equal(run(f).proposals.some(row => row.opportunityId === 'opportunity_2'), false, 'malformed duplicate must not expose the weaker original');
});

test('the firm UTF-8 ceiling rejects oversized worst-case reports and admits bounded Unicode results', () => {
  const f = fixture();
  f.state.businessObjectives[0].title = '🚀'.repeat(80);
  f.state.businessObjectives[0].limits.approvalRequiredKinds = [...RISKY_ACTION_TYPES, 'internal_analysis', 'prepare_report', 'prepare_proposal', 'read_only_research'];
  f.state.opportunities = Array.from({ length: OBJECTIVE_REVIEW_LIMITS.canonicalOpportunities }, (_, n) => ({
    id: `opportunity_${n}_`.padEnd(180, 'x'), kind: 'operations', executionCost: 0.004, effortHours: 0.004,
    requiredAction: 'advertising_spend', approvalRequired: true, experimentId: `experiment_${n}_`.padEnd(180, 'e')
  }));
  f.state.revenueEngine.experiments = f.state.opportunities.map(row => ({ id: row.experimentId, opportunityId: row.id,
    status: 'completed', impact: { verified: true, incrementalContribution: Number.MAX_SAFE_INTEGER } }));
  assert.throws(() => run(f), error => error.code === 'OBJECTIVE_REVIEW_RESULT_TOO_LARGE' && error.status === 413);
  f.state.opportunities = f.state.opportunities.slice(0, 5);
  const report = run(f), encoded = JSON.stringify(report);
  assert.equal(report.proposals.length, 5);
  assert.ok(Buffer.byteLength(encoded, 'utf8') > encoded.length, 'the assertion measures UTF-8 bytes rather than character count');
  assert.ok(Buffer.byteLength(encoded, 'utf8') <= OBJECTIVE_REVIEW_LIMITS.serializedBytes);
  assert.equal(OBJECTIVE_REVIEW_LIMITS.serializedBytes, 65536);
});

test('malformed numeric inputs and foreign settings cannot turn unknown commercial cost or capacity into zero', () => {
  for (const value of [NaN, Infinity, -1, {}, [], false, '']) {
    const f = fixture(); Object.assign(f.state.opportunities[1], { executionCost: value, effortHours: value });
    const proposal = run(f).proposals.find(row => row.opportunityId === 'opportunity_2');
    assert.equal(proposal.evidence.executionCost, null);
    assert.equal(proposal.evidence.effortHours, null);
    assert.equal(proposal.commercialReady, false);
  }
  const f = fixture(); Object.assign(f.state.settings, { workspaceId: 'tenant-b', growthCapacityHours: 10000, currency: 'GBP' });
  const report = run(f);
  assert.equal(report.summary.availableGrowthHours, null);
  assert.equal(report.metricEvidence.currency.workspace, null);
  assert.ok(report.proposals.every(row => codes(row).includes('CAPACITY_UNKNOWN')));
});
