import test from 'node:test';
import assert from 'node:assert/strict';
import { businessObjectivesSnapshot, evaluateObjectivePlan, upsertBusinessObjective, MAX_BUSINESS_OBJECTIVES } from '../lib/business-objectives.mjs';
import { RISKY_ACTION_TYPES } from '../lib/security.mjs';

const NOW = '2026-10-06T12:00:00.000Z';
const OPTIONS = { workspaceId: 'tenant-a', now: new Date(NOW) };
function state(workspaceId = 'tenant-a') {
  return { workspace: { id: workspaceId }, settings: { currency: 'GBP', growthCapacityHours: 10, marginFloor: 20 },
    approvals: [{ id: 'approval-existing', type: 'advertising_spend', status: 'approved' }],
    autopilot: { enabled: true, spendLimit: 0 }, connections: [{ provider: 'shopify', encryptedCredentials: 'private-token' }] };
}
function objective(overrides = {}) {
  return { title: 'Increase profitable sales', metric: 'revenue', baseline: 100, target: 200, direction: 'increase',
    startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-31T23:59:59.000Z', status: 'active',
    limits: { minGrossMarginPercent: 20, maxMonthlyAdBudget: 0, currency: 'GBP', minStockCoverDays: 0, profitFirst: true, approvalRequiredKinds: [] }, ...overrides };
}
function fixture(overrides = {}) {
  const tenant = state();
  const row = upsertBusinessObjective(tenant, objective(overrides), OPTIONS);
  return { tenant, row };
}
function plan(row, overrides = {}) {
  return { workspaceId: 'tenant-a', objectiveId: row.id, kind: 'internal_analysis', mode: 'internal_preparation',
    startsAt: '2026-10-06T12:00:00.000Z', endsAt: '2026-10-07T12:00:00.000Z',
    evidence: { observedAt: NOW, sourceRefs: ['economics:verified-quote', 'orders:october-summary'], metricValue: 100,
      estimatedCost: 0, effortHours: 1, costsComplete: true, currency: 'GBP', grossMarginPercent: 25,
      monthToDateAdSpend: 0, plannedAdSpend: 0, adSpendMonth: '2026-10', stockCoverDays: 0, contributionProfitDelta: 0 }, ...overrides };
}
const codes = result => result.blockers.map(item => item.code);
const validation = fn => assert.throws(fn, error => error.status === 400 && error.code === 'VALIDATION_FAILED');
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
}

test('objectives live only in their existing tenant state and opaque IDs survive validated updates', () => {
  const a = state(), b = state('tenant-b');
  const originalA = structuredClone(a);
  const row = upsertBusinessObjective(a, objective(), OPTIONS);
  const other = upsertBusinessObjective(b, objective(), { workspaceId: 'tenant-b', now: NOW });
  assert.match(row.id, /^objective_[0-9a-f-]{36}$/);
  assert.notEqual(row.id, other.id);
  assert.equal(row.id.includes('tenant-a'), false);
  const changed = upsertBusinessObjective(a, { id: row.id, revision: 1, target: 300 }, OPTIONS);
  assert.equal(changed.id, row.id);
  assert.equal(changed.revision, 2);
  assert.equal(changed.baseline, 100);
  assert.equal(a.businessObjectives.length, 1);
  assert.equal(b.businessObjectives[0].target, 200);
  const { businessObjectives: _rows, ...rest } = a;
  assert.deepEqual(rest, originalA, 'no settings, authorization, audit, approval, or provider data changes');
  changed.limits.approvalRequiredKinds.push('refund');
  assert.deepEqual(a.businessObjectives[0].limits.approvalRequiredKinds, []);
  assert.throws(() => upsertBusinessObjective(a, { id: row.id, revision: 1, target: 400 }, OPTIONS), error => error.code === 'OBJECTIVE_CONFLICT');
});

test('every explicit tenant mismatch fails without mutating or leaking another tenant objective', () => {
  const { tenant, row } = fixture();
  const before = structuredClone(tenant);
  for (const fn of [
    () => upsertBusinessObjective(tenant, objective({ workspaceId: 'tenant-b' }), OPTIONS),
    () => upsertBusinessObjective(tenant, objective({ tenantId: 'tenant-b' }), OPTIONS),
    () => businessObjectivesSnapshot(tenant, { workspaceId: 'tenant-b', now: NOW }),
    () => evaluateObjectivePlan(tenant, plan(row, { workspaceId: 'tenant-b' }), OPTIONS),
    () => evaluateObjectivePlan(tenant, plan(row, { evidence: { ...plan(row).evidence, tenantId: 'tenant-b' } }), OPTIONS)
  ]) assert.throws(fn, error => error.code === 'WORKSPACE_MISMATCH' && error.status === 403);
  assert.throws(() => evaluateObjectivePlan(state('tenant-b'), { ...plan(row), workspaceId: 'tenant-b' }, { workspaceId: 'tenant-b', now: NOW }), error => error.code === 'OBJECTIVE_NOT_FOUND');
  assert.throws(() => upsertBusinessObjective(tenant, objective({ id: 'objective_person@example.com' }), OPTIONS), error => error.code === 'OBJECTIVE_NOT_FOUND');
  assert.deepEqual(tenant, before);
  tenant.businessObjectives[0].workspaceId = 'tenant-b';
  assert.throws(() => businessObjectivesSnapshot(tenant, OPTIONS), error => error.code === 'WORKSPACE_MISMATCH');
  assert.throws(() => businessObjectivesSnapshot({}, OPTIONS), error => error.code === 'WORKSPACE_REQUIRED');
});

test('strict objective validation rejects impossible targets, numeric coercion, unknown enums, and invalid calendar dates atomically', () => {
  const tenant = state();
  const invalidRows = [
    { baseline: -1 }, { baseline: NaN }, { target: Infinity }, { baseline: '' }, { baseline: '100' }, { target: null },
    { direction: 'increase', target: 50 }, { direction: 'decrease', target: 200 }, { direction: 'maintain', target: 101 },
    { metric: 'invented_metric' }, { status: null }, { status: 'enabled' }, { direction: 'up' }, { title: 'x'.repeat(161) },
    { startsAt: '2026-02-30T00:00:00Z' }, { startsAt: '2026-10-01' }, { startsAt: '2026-10-01T00:00:00+00:00' },
    { endsAt: '2026-10-01T00:00:00.000Z' }, { endsAt: '2040-10-01T00:00:00.000Z' },
    { metric: 'gross_margin_percent', baseline: 20, target: 101 }, { metric: 'orders', baseline: 1, target: 1.5 },
    { authorization: 'all_actions_allowed' }, { limits: null }, { limits: [] }, { limits: { profitFirst: 'false' } },
    { limits: { maxMonthlyAdBudget: -1, currency: 'GBP' } }, { limits: { maxMonthlyAdBudget: NaN, currency: 'GBP' } },
    { limits: { maxMonthlyAdBudget: 0 } }, { limits: { currency: 'gbp' } }, { limits: { currency: 'ZZZ' } },
    { limits: { currency: 'GBP', minGrossMarginPercent: -1 } }, { limits: { currency: 'GBP', minGrossMarginPercent: 101 } },
    { limits: { currency: 'GBP', minStockCoverDays: -1 } }, { limits: { currency: 'GBP', minStockCoverDays: Infinity } },
    { limits: { currency: 'GBP', approvalRequiredKinds: false } }, { limits: { currency: 'GBP', approvalRequiredKinds: ['execute_anything'] } },
    { limits: { currency: 'GBP', approvalsRequired: false } }
  ];
  for (const patch of invalidRows) {
    const before = structuredClone(tenant);
    validation(() => upsertBusinessObjective(tenant, objective(patch), OPTIONS));
    assert.deepEqual(tenant, before, JSON.stringify(patch));
  }
});

test('explicit null baseline stays unknown; real negative profit is representable without fabricated gains', () => {
  const { tenant, row } = fixture({ baseline: null });
  assert.equal(businessObjectivesSnapshot(tenant, OPTIONS).objectives[0].baseline, null);
  assert.ok(codes(evaluateObjectivePlan(tenant, plan(row), OPTIONS)).includes('BASELINE_UNKNOWN'));
  const loss = upsertBusinessObjective(tenant, objective({ metric: 'contribution_profit', baseline: -100, target: 0 }), OPTIONS);
  assert.equal(loss.baseline, -100);
  assert.equal(loss.target, 0);
});

test('objective collection is bounded without deleting existing records; updates remain available at the limit', () => {
  const tenant = state();
  for (let n = 0; n < MAX_BUSINESS_OBJECTIVES; n++) upsertBusinessObjective(tenant, objective({ title: `Objective ${n}` }), OPTIONS);
  const before = structuredClone(tenant);
  assert.throws(() => upsertBusinessObjective(tenant, objective(), OPTIONS), error => error.code === 'OBJECTIVE_LIMIT_REACHED');
  assert.deepEqual(tenant, before);
  const first = tenant.businessObjectives[0];
  upsertBusinessObjective(tenant, { id: first.id, revision: first.revision, status: 'paused' }, OPTIONS);
  assert.equal(tenant.businessObjectives.length, MAX_BUSINESS_OBJECTIVES);
});

test('known explicit zeros preserve budget, margin, stock cover, cost, effort, and profit constraints', () => {
  const { tenant, row } = fixture({ metric: 'monthly_ad_spend', baseline: 10, target: 0, direction: 'decrease',
    limits: { minGrossMarginPercent: 0, maxMonthlyAdBudget: 0, currency: 'GBP', minStockCoverDays: 0, profitFirst: true } });
  tenant.settings.growthCapacityHours = 0;
  const input = plan(row);
  Object.assign(input.evidence, { effortHours: 0, grossMarginPercent: 0, metricValue: 0 });
  const result = evaluateObjectivePlan(tenant, input, OPTIONS);
  assert.equal(result.readyForPreparation, true);
  assert.equal(result.approvalRequired, false);
  assert.equal(result.metric.current, 0);
  assert.equal(result.metric.target, 0);
  assert.equal(result.safeguards.externalExecutionAllowed, false);
  assert.ok(result.checks.every(check => check.actual === 0 && check.limit === 0 && check.passed));
  const overBudget = evaluateObjectivePlan(tenant, { ...input, evidence: { ...input.evidence, plannedAdSpend: 0.01 } }, OPTIONS);
  assert.ok(codes(overBudget).includes('AD_BUDGET_EXCEEDED'));
  assert.ok(overBudget.approvalRequiredKinds.includes('advertising_spend'));
});

test('missing, null, malformed, and stale evidence cannot silently become zero or ready', () => {
  const { tenant, row } = fixture();
  const baseline = plan(row);
  for (const field of ['metricValue', 'estimatedCost', 'effortHours', 'grossMarginPercent', 'stockCoverDays', 'contributionProfitDelta', 'monthToDateAdSpend', 'plannedAdSpend']) {
    const evidence = { ...baseline.evidence, [field]: null };
    const result = evaluateObjectivePlan(tenant, { ...baseline, evidence }, OPTIONS);
    assert.equal(result.readyForPreparation, false, field);
    assert.equal(result.evidence[field], null);
    for (const value of [NaN, Infinity, '', '0', false]) validation(() => evaluateObjectivePlan(tenant, { ...baseline, evidence: { ...baseline.evidence, [field]: value } }, OPTIONS));
  }
  for (const evidence of [{}, { ...baseline.evidence, observedAt: null }, { ...baseline.evidence, sourceRefs: [] },
    { ...baseline.evidence, observedAt: '2026-08-01T00:00:00.000Z' }, { ...baseline.evidence, observedAt: '2026-10-07T00:00:00.000Z' },
    { ...baseline.evidence, costsComplete: false }, { ...baseline.evidence, currency: null }]) {
    assert.equal(evaluateObjectivePlan(tenant, { ...baseline, evidence }, OPTIONS).readyForPreparation, false);
  }
  for (const field of ['estimatedCost', 'effortHours', 'monthToDateAdSpend', 'plannedAdSpend', 'stockCoverDays']) validation(() => evaluateObjectivePlan(tenant, { ...baseline, evidence: { ...baseline.evidence, [field]: -1 } }, OPTIONS));
  const noCapacity = structuredClone(tenant); delete noCapacity.settings.growthCapacityHours;
  assert.ok(codes(evaluateObjectivePlan(noCapacity, baseline, OPTIONS)).includes('CAPACITY_UNKNOWN'));
  assert.ok(codes(evaluateObjectivePlan(tenant, { ...baseline, startsAt: null }, OPTIONS)).includes('TIME_BOUNDS_UNKNOWN'));
});

test('budget period, currency, stock cover, profit, gross margin, and time limits fail closed', () => {
  const { tenant, row } = fixture({ limits: { currency: 'GBP', minGrossMarginPercent: 20, minStockCoverDays: 10, maxMonthlyAdBudget: 10, profitFirst: true } });
  const input = plan(row); input.evidence.stockCoverDays = 10;
  assert.equal(evaluateObjectivePlan(tenant, input, OPTIONS).readyForPreparation, true);
  for (const [patch, expected] of [
    [{ currency: 'USD' }, 'CURRENCY_MISMATCH'], [{ grossMarginPercent: 19.99 }, 'GROSS_MARGIN_BELOW_LIMIT'],
    [{ monthToDateAdSpend: 11 }, 'AD_BUDGET_EXCEEDED'], [{ adSpendMonth: '2026-09' }, 'AD_SPEND_PERIOD_UNKNOWN'],
    [{ stockCoverDays: 9.99 }, 'STOCK_COVER_BELOW_LIMIT'], [{ contributionProfitDelta: -0.01 }, 'PROFIT_FIRST_LIMIT'],
    [{ effortHours: 10.01 }, 'TIME_CAPACITY_EXCEEDED'],
    [{ effortHours: 24.01 }, 'EFFORT_EXCEEDS_TIME_WINDOW'], [{ observedAt: '2026-09-30T12:00:00.000Z' }, 'AD_SPEND_EVIDENCE_PERIOD_MISMATCH']
  ]) assert.ok(codes(evaluateObjectivePlan(tenant, { ...input, evidence: { ...input.evidence, ...patch } }, OPTIONS)).includes(expected), expected);
  assert.ok(codes(evaluateObjectivePlan(tenant, { ...input, endsAt: '2026-11-01T00:00:00.000Z' }, OPTIONS)).includes('TIME_OUTSIDE_OBJECTIVE'));
  validation(() => evaluateObjectivePlan(tenant, { ...input, endsAt: input.startsAt }, OPTIONS));
  validation(() => evaluateObjectivePlan(tenant, { ...input, endsAt: '2026-12-31T00:00:00.000Z' }, OPTIONS));
});

test('objective limits cannot disable existing mandatory approvals or authorize external execution', () => {
  const { tenant, row } = fixture({ limits: { currency: 'GBP', profitFirst: false, approvalRequiredKinds: [] } });
  const before = structuredClone(tenant);
  for (const kind of RISKY_ACTION_TYPES) {
    const result = evaluateObjectivePlan(tenant, plan(row, { kind }), OPTIONS);
    assert.equal(result.approvalRequired, true, kind);
    assert.equal(result.readyForPreparation, false, kind);
    assert.ok(result.approvalRequiredKinds.includes(kind));
    assert.equal(result.safeguards.externalExecutionAllowed, false);
    assert.ok(codes(result).includes('OWNER_APPROVAL_REQUIRED'));
  }
  const paid = plan(row); paid.evidence.estimatedCost = 0.01;
  assert.ok(evaluateObjectivePlan(tenant, paid, OPTIONS).approvalRequiredKinds.includes('spend_money'));
  for (const patch of [{ approvalRequired: false }, { approved: true }, { mode: 'external_execution' }, { kind: 'safe_refund' }]) validation(() => evaluateObjectivePlan(tenant, plan(row, patch), OPTIONS));
  assert.deepEqual(tenant, before, 'approved records, settings and policies remain unchanged');
  const updated = upsertBusinessObjective(tenant, { id: row.id, revision: row.revision, limits: { approvalRequiredKinds: ['internal_analysis'] } }, OPTIONS);
  const additional = evaluateObjectivePlan(tenant, plan(updated), OPTIONS);
  assert.equal(additional.approvalRequired, true);
  assert.ok(additional.approvalRequiredKinds.includes('internal_analysis'));
});

test('paused, disabled, completed, cancelled, expired, and future objectives never become ready', () => {
  for (const [patch, expected] of [
    [{ status: 'paused' }, 'paused'], [{ status: 'disabled' }, 'disabled'], [{ status: 'completed' }, 'completed'], [{ status: 'cancelled' }, 'cancelled'],
    [{ endsAt: '2026-10-06T12:00:00.000Z' }, 'expired'],
    [{ startsAt: '2026-10-07T12:00:00.000Z' }, 'scheduled']
  ]) {
    const { tenant, row } = fixture(patch);
    const result = evaluateObjectivePlan(tenant, plan(row), OPTIONS);
    assert.equal(result.readyForPreparation, false);
    assert.equal(result.objectiveStatus, expected);
    assert.ok(codes(result).includes('OBJECTIVE_NOT_ACTIVE'));
    assert.equal(businessObjectivesSnapshot(tenant, OPTIONS).objectives[0].effectiveStatus, expected);
  }
});

test('snapshot and evaluation are pure, detached, bounded projections without secret state', () => {
  const empty = deepFreeze(state());
  assert.deepEqual(businessObjectivesSnapshot(empty, OPTIONS).objectives, []);
  assert.equal(own(empty, 'businessObjectives'), false);
  const { tenant, row } = fixture();
  const original = structuredClone(tenant);
  deepFreeze(tenant);
  const result = businessObjectivesSnapshot(tenant, OPTIONS);
  const input = deepFreeze(plan(row));
  const evaluation = evaluateObjectivePlan(tenant, input, OPTIONS);
  assert.equal(evaluation.readyForPreparation, true);
  assert.equal(evaluation.evidence.providerVerified, false);
  assert.equal(evaluation.evidence.provenance, 'supplied_unverified');
  result.objectives[0].limits.approvalRequiredKinds.push('refund');
  evaluation.evidence.sourceRefs.push('unrelated');
  assert.deepEqual(tenant, original);
  assert.equal(input.evidence.sourceRefs.includes('unrelated'), false);
  assert.equal(JSON.stringify(result).includes('private-token'), false);
  assert.equal(JSON.stringify(evaluation).includes('private-token'), false);
});
function own(value, key) { return Object.hasOwn(value, key); }

test('objective targets cannot contradict their hard planning limits on create or update', () => {
  for (const patch of [
    {metric:'monthly_ad_spend',baseline:0,target:500,limits:{currency:'GBP',maxMonthlyAdBudget:0}},
    {metric:'gross_margin_percent',baseline:10,target:20,limits:{minGrossMarginPercent:35}},
    {metric:'stock_cover_days',baseline:5,target:10,limits:{minStockCoverDays:20}}
  ]) {
    const tenant=state(), before=structuredClone(tenant);
    validation(()=>upsertBusinessObjective(tenant,objective(patch),OPTIONS));
    assert.deepEqual(tenant,before);
  }
  const {tenant,row}=fixture({metric:'gross_margin_percent',baseline:10,target:35,limits:{minGrossMarginPercent:35}});
  const before=structuredClone(tenant);
  validation(()=>upsertBusinessObjective(tenant,{id:row.id,revision:1,target:20},OPTIONS));
  assert.deepEqual(tenant,before);
});

test('elapsed plan time cannot provide future preparation capacity', () => {
  const {tenant,row}=fixture();
  const proposed=plan(row,{startsAt:'2026-10-01T00:00:00.000Z',endsAt:'2026-10-06T12:01:00.000Z'});
  proposed.evidence.effortHours=10;
  const result=evaluateObjectivePlan(tenant,proposed,OPTIONS);
  assert.equal(result.readyForPreparation,false);
  assert.ok(codes(result).includes('EFFORT_EXCEEDS_TIME_WINDOW'));
  assert.equal(result.assessment,'conditional_on_supplied_evidence');
  assert.equal(result.sourceReferencesResolved,false);
});
