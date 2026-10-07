import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewedActionFixture } from './reviewed-action-test-fixture.mjs';
import { prepareExperimentOutcomeMeasurement } from '../lib/experiment-measurements.mjs';
import { createHash } from 'node:crypto';
import { deriveImpact } from '../lib/impact-engine.mjs';
import { deriveLearning } from '../lib/learning-engine.mjs';
import { deriveOperations } from '../lib/operations.mjs';
import { deriveBusinessState } from '../lib/business-state.mjs';
import { scoreOpportunity } from '../lib/opportunity-engine.mjs';
import { derivePortfolioAllocation } from '../lib/portfolio-engine.mjs';
import { deriveExecutionPlan } from '../lib/execution-plan.mjs';
import {
  aggregateBusinessOutcomes, createBusinessOutcomeCandidate,
  correctBusinessOutcomeCandidate, createOutcomePublicationBoundary,
  withdrawBusinessOutcomeCandidate
} from '../lib/business-outcomes.mjs';

const NOW = '2026-10-06T20:00:00.000Z';
const WORKSPACE = 'tenant-a';
const OPTIONS = { workspaceId: WORKSPACE, now: NOW };
const WINDOW = { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' };
const digest = value => createHash('sha256').update(value).digest('hex');
const consumers = [['impact', deriveImpact], ['learning', deriveLearning]];

function input(key = 'one', { amount = '10', currency = 'GBP', window = WINDOW, method = 'holdout', ...patch } = {}) {
  const measurementDigest = digest(`measurement:${key}`);
  return {
    source: { type: 'experiment_measurement', experimentId: `experiment_${key}`, measurementRevision: 1, measurementDigest },
    metric: 'incrementalContribution', amount, currency, window: { ...window },
    coverage: { status: 'complete', scopeId: `population_${key}`, observedCount: 10, expectedCount: 10 },
    method: { kind: method, definitionVersion: 'incremental-contribution/v1' },
    provenance: {
      observationId: `observation_${key}`,
      sourceRefs: [{ type: 'measurement_report', id: `report_${key}`, digest: digest(`report:${key}`) }],
      observedAt: '2026-10-06T12:00:00.000Z', aggregation: 'non_overlapping_scopes_attested'
    },
    verification: { kind: 'owner_attestation', actorId: 'user_owner', verifiedAt: '2026-10-06T14:00:00.000Z', measurementDigest },
    ...patch
  };
}

const candidate = (key, patch) => createBusinessOutcomeCandidate(input(key, patch), OPTIONS);
const state = () => ({ workspace: { id: WORKSPACE }, subscription: { monthlyPriceGbp: 100 }, workRecords: [], approvals: [], automationRuns: [], revenueEngine: { experiments: [] } });

function head(row, patch = {}) {
  return {
    schema: 'runvara-outcome-head/v1', workspaceId: row.workspaceId, outcomeId: row.outcomeId,
    revision: row.revision, versionId: row.versionId, digest: row.digest,
    status: row.status === 'withdrawn' ? 'withdrawn' : 'published',
    publicationId: `publication_${row.revision}`, committedAt: '2026-10-06T19:00:00.000Z',
    commitRevision: 'state_committed_revision', ...patch
  };
}

function proof(current, settings = {}) {
  const pairs = new Map(current.map(row => [row.outcomeId, { head: head(row), version: row }]));
  return createOutcomePublicationBoundary({
    workspaceId: WORKSPACE, snapshotId: 'committed_snapshot_consumers', complete: true,
    expectedOutcomeCount: pairs.size,
    resolveCommittedPublication: ({ workspaceId, outcomeId }) => workspaceId === WORKSPACE ? pairs.get(outcomeId) ?? null : null,
    ...settings
  });
}

const snapshot = (versions, publicationBoundary = proof(versions)) => ({ versions, publicationBoundary });
const exclusionCodes = result => result.outcomeCoverage.exclusions.map(row => row.code);
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function assertGuardrails(kind, result) {
  assert.equal(result.workspaceId, WORKSPACE);
  assert.ok(Array.isArray(result.qualifiedOutcomeGroups));
  assert.equal(typeof result.outcomeCoverage.publicationProofAvailable, 'boolean');
  assert.equal(typeof result.outcomeCoverage.complete, 'boolean');
  assert.ok(Object.hasOwn(result.outcomeCoverage, 'unavailableReason'));
  assert.ok(Array.isArray(result.outcomeCoverage.exclusions));
  if (kind === 'impact') {
    for (const field of ['incrementalRevenue', 'incrementalContribution', 'contributionProtected', 'costAvoided', 'verifiedValue', 'hoursSaved']) {
      assert.equal(result.verified[field], null, `Legacy verified.${field} must never be a scalar total`);
    }
    for (const field of ['subscriptionCost', 'verifiedValue', 'multiple']) {
      assert.equal(result.roi[field], null, `ROI ${field} must remain unavailable`);
    }
  } else {
    assert.deepEqual(result.priors, [], 'Publication evidence alone cannot establish immutable action/domain attribution');
    assert.equal(result.summary.domainsUsableForGuidance, 0);
    for (const group of result.qualifiedOutcomeGroups) {
      assert.equal(group.descriptiveOnly, true);
      assert.equal(group.usableForGuidance, false);
    }
  }
}

function evaluateBoth(outcomeSnapshot, currentState = state(), settings = {}) {
  return consumers.map(([kind, derive]) => {
    const result = derive(currentState, { now: NOW, ...settings, outcomeSnapshot });
    assertGuardrails(kind, result);
    return result;
  });
}

function assertAggregateGroups(result, expectedGroups) {
  const groups = result.qualifiedOutcomeGroups;
  assert.equal(groups.length, expectedGroups.length);
  for (const expected of expectedGroups) {
    const actual = groups.find(group => group.id === expected.id);
    assert.ok(actual, `Missing comparable group ${expected.id}`);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, `Group field ${key} must preserve authoritative aggregation`);
  }
}

function importedState() {
  const current = state();
  const order = (id, currency, amount) => ({ id, externalId: id, provider: 'shopify', currency,
    createdAt: '2026-10-06T12:00:00.000Z', financialStatus: 'PAID', fulfillmentStatus: 'FULFILLED',
    total: amount, currentTotal: amount, refunds: '0', currentTax: '0', tax: '0', discounts: '0', shippingCharged: '0',
    lineItems: [{ sku: 'UNQUALIFIED', quantity: 1, net: amount }] });
  current.orders = [order('gbp', 'GBP', '900.000001'), order('unknown', 'GBP', null), order('usd', 'USD', '700.000001')];
  current.economics = {}; current.products = [];
  return current;
}

test('corrected exact owner outcomes stay separate from incomplete mixed-currency imported cohorts', () => {
  const currentState = importedState(), before = structuredClone(currentState.orders);
  const previous = candidate('one', { amount: '999999999999999999.999999' });
  const replacement = input('one', { amount: '-0.000001' });
  replacement.source.measurementRevision = 2;
  replacement.source.measurementDigest = replacement.verification.measurementDigest = digest('cross_feature_corrected_measurement');
  const current = correctBusinessOutcomeCandidate(previous, replacement, OPTIONS);
  const outcomeSnapshot = snapshot([previous, current], proof([current]));
  const operations = deriveOperations(currentState, { now: new Date(NOW) });
  const groups = operations.last30d.importedOrderEvidence.groups;
  const gbp = groups.find(group => group.currency === 'GBP');
  assert.equal(gbp.recordedAmounts.netTotal.knownSubtotal, '900.000001');
  assert.equal(gbp.recordedAmounts.netTotal.unknownCount, 1);
  assert.equal(gbp.recordedAmounts.netTotal.completeCohortTotal, null);
  assert.equal(groups.find(group => group.currency === 'USD').recordedAmounts.netTotal.knownSubtotal, '700.000001');
  assert.equal(operations.last30d.revenue, null);
  assert.equal(operations.last30d.operatingProfit, null);
  for (const result of evaluateBoth(outcomeSnapshot, currentState)) {
    assert.equal(result.qualifiedOutcomeGroups.length, 1);
    assert.equal(result.qualifiedOutcomeGroups[0].amount, '-0.000001');
    assert.equal(result.qualifiedOutcomeGroups[0].currency, 'GBP');
    assert.deepEqual(result.qualifiedOutcomeGroups[0].versionIds, [current.versionId]);
  }
  for (const result of evaluateBoth(snapshot([previous], proof([current])), currentState)) {
    assert.deepEqual(result.qualifiedOutcomeGroups, []);
    assert.equal(result.outcomeCoverage.complete, false, 'a missing corrected head cannot borrow imported amounts');
  }
  assert.deepEqual(currentState.orders, before);
});

test('unavailable imported profit cannot become an economic zero, forecast ranking or execution authority', () => {
  const currentState = importedState();
  const metrics = deriveOperations(currentState, { now: new Date(NOW) });
  const proposal = scoreOpportunity({ id: 'imported-profit-proposal', title: 'Review recorded orders',
    expectedContributionProfit: metrics.last30d.operatingProfit, executionCost: 0, effortHours: 1,
    confidence: 1, probability: 1, risk: 'low', actionType: 'safe' });
  assert.equal(proposal.expectedContributionProfit, null);
  assert.equal(proposal.score, null);
  assert.equal(proposal.economicEvidenceComplete, false);
  assert.ok(proposal.needsEvidence.includes('expectedContributionProfit'));
  currentState.settings = { growthCapacityHours: 10, maxConcurrentGrowthExperiments: 5 };
  currentState.opportunities = [{ ...proposal, workspaceId: WORKSPACE, experimentId: 'experiment_claim',
    expectedContributionProfit: 900, verifiedContributionValue: 900, evidenceVerified: true, evidenceDecision: 'ready-for-owner-review' }];
  currentState.revenueEngine.experiments = [{ id: 'experiment_claim', opportunityId: proposal.id, status: 'completed',
    impact: { verified: true, incrementalContribution: 900, currency: 'GBP' } }];
  const business = deriveBusinessState(currentState, { now: new Date(NOW) });
  assert.equal(business.commerce.revenue30d, null);
  const portfolio = derivePortfolioAllocation(currentState), row = portfolio.portfolio[0];
  assert.equal(row.verifiedContribution, null);
  assert.equal(row.contributionPerPound, null);
  assert.equal(row.contributionPerHour, null);
  assert.equal(row.evidenceDecision, 'needs-more-evidence');
  assert.equal(portfolio.allocation.nextPound, null);
  assert.equal(portfolio.allocation.nextExecutable, null);
  const plan = deriveExecutionPlan(portfolio);
  assert.deepEqual(plan.sequence, []);
  assert.ok(plan.blocked[0].blockers.includes('more economic evidence is required'));
  assert.equal(plan.safeguards.externalWrites, false);
  assert.equal(plan.safeguards.spendCommitted, false);
});

test('legacy verified flags, archive claims and raw summaries cannot establish outcomes or learning', () => {
  const row = candidate('one');
  const rawSummary = aggregateBusinessOutcomes([row], { ...OPTIONS, publicationBoundary: proof([row]) });
  const legacy = { verified: true, status: 'verified', incrementalRevenue: 500, incrementalContribution: 180, contributionProtected: 50, costAvoided: 25, minutesSaved: 90, currency: 'GBP' };
  const currentState = {
    ...state(),
    workRecords: [{ id: 'work_one', kind: 'retention', status: 'COMPLETED', evidence: [{ impact: legacy }] }],
    approvals: [{ id: 'approval_one', status: 'approved', executionStatus: 'executed', impact: legacy }],
    revenueEngine: { experiments: [{ id: 'experiment_one', kind: 'retention', status: 'completed', impact: legacy }] },
    businessOutcomes: rawSummary, outcomeSummary: rawSummary,
    qualifiedOutcomeGroups: rawSummary.groups, outcomeSnapshot: snapshot([row])
  };
  for (const result of evaluateBoth(undefined, currentState, { minSamples: 1 })) {
    assert.deepEqual(result.qualifiedOutcomeGroups, []);
    assert.equal(result.outcomeCoverage.publicationProofAvailable, false);
    assert.equal(result.outcomeCoverage.complete, false);
    assert.ok(result.outcomeCoverage.unavailableReason);
  }
});

test('only an actual branded publication boundary qualifies; copied proof and raw summaries fail closed', () => {
  const row = candidate('one'), realBoundary = proof([row]);
  const rawSummary = aggregateBusinessOutcomes([row], { ...OPTIONS, publicationBoundary: realBoundary });
  const invalidSnapshots = [
    null, rawSummary, { ...rawSummary, publicationBoundary: realBoundary },
    { versions: [row] }, { versions: [row], publicationBoundary: null },
    { versions: [row], publicationBoundary: { committed: true, verified: true } },
    { versions: [row], publicationBoundary: { ...realBoundary } },
    JSON.parse(JSON.stringify(snapshot([row], realBoundary)))
  ];
  for (const invalid of invalidSnapshots) {
    for (const result of evaluateBoth(invalid)) {
      assert.deepEqual(result.qualifiedOutcomeGroups, []);
      assert.equal(result.outcomeCoverage.complete, false);
      assert.ok(result.outcomeCoverage.unavailableReason, 'Rejected snapshot must explain why outcome evidence is unavailable');
    }
  }
});

test('currencies, exact windows and methods remain separate exact groups without lifetime totals', () => {
  const rows = [
    candidate('gbp', { amount: '100.123456' }),
    candidate('usd', { amount: '200.654321', currency: 'USD' }),
    candidate('earlier', { amount: '-0.000001', window: { startsAt: '2026-09-26T00:00:00.000Z', endsAt: WINDOW.startsAt } }),
    candidate('observational', { amount: '0', method: 'before_after' })
  ];
  const outcomeSnapshot = snapshot(rows);
  const expected = aggregateBusinessOutcomes(rows, { ...OPTIONS, publicationBoundary: outcomeSnapshot.publicationBoundary });
  assert.equal(expected.groups.length, 4);
  for (const result of evaluateBoth(outcomeSnapshot)) {
    assertAggregateGroups(result, expected.groups);
    assert.equal(result.outcomeCoverage.publicationProofAvailable, true);
    assert.equal(result.outcomeCoverage.complete, true);
    assert.equal(result.outcomeCoverage.unavailableReason, null);
    assert.ok(result.qualifiedOutcomeGroups.every(group => typeof group.amount === 'string'));
  }
});

test('large positive, tiny negative and zero values retain exact decimal units while unknown stays excluded', () => {
  const rows = [candidate('large_one', { amount: '999999999999999999.999999' }), candidate('large_two', { amount: '999999999999999999.999999' }), candidate('negative', { amount: '-0.000001' }), candidate('zero', { amount: '0' }), candidate('unknown', { amount: null })];
  for (const result of evaluateBoth(snapshot(rows))) {
    assert.equal(result.qualifiedOutcomeGroups.length, 1);
    const group = result.qualifiedOutcomeGroups[0];
    assert.equal(group.amount, '1999999999999999999.999997');
    assert.equal(group.measuredCount, 4);
    assert.equal(group.knownZeroCount, 1);
    assert.equal(group.negativeCount, 1);
    assert.equal(group.positiveCount, 2);
    assert.ok(result.outcomeCoverage.exclusions.some(row => row.code === 'UNQUALIFIED_MEASUREMENT' && row.blockers.some(blocker => blocker.code === 'AMOUNT_UNKNOWN')));
  }
  for (const result of evaluateBoth(snapshot([candidate('only_zero', { amount: '0' })]))) {
    assert.equal(result.qualifiedOutcomeGroups[0].amount, '0');
    assert.equal(result.qualifiedOutcomeGroups[0].knownZeroCount, 1);
  }
  for (const result of evaluateBoth(snapshot([candidate('only_unknown', { amount: null })]))) assert.deepEqual(result.qualifiedOutcomeGroups, []);
});

test('current committed correction contributes once and an unpublished correction cannot replace it', () => {
  const previous = candidate('one');
  const replacement = input('one', { amount: '-2.004' });
  replacement.source.measurementRevision = 2;
  replacement.source.measurementDigest = replacement.verification.measurementDigest = digest('corrected_measurement');
  replacement.verification.verifiedAt = '2026-10-06T15:00:00.000Z';
  const current = correctBusinessOutcomeCandidate(previous, replacement, OPTIONS);
  for (const result of evaluateBoth(snapshot([previous, current, current, structuredClone(current)], proof([current])))) {
    assert.equal(result.qualifiedOutcomeGroups[0].amount, '-2.004');
    assert.equal(result.qualifiedOutcomeGroups[0].measuredCount, 1);
    assert.deepEqual(result.qualifiedOutcomeGroups[0].versionIds, [current.versionId]);
  }
  for (const result of evaluateBoth(snapshot([previous, current], proof([previous])))) assert.equal(result.qualifiedOutcomeGroups[0].amount, '10');
  for (const result of evaluateBoth(snapshot([previous], proof([current])))) {
    assert.deepEqual(result.qualifiedOutcomeGroups, []);
    assert.equal(result.outcomeCoverage.complete, false);
    assert.ok(exclusionCodes(result).includes('CURRENT_VERSION_UNPROVED'));
  }
});

test('withdrawal follows the trusted head and preserves no stale qualified outcome', () => {
  const previous = candidate('one');
  const withdrawn = withdrawBusinessOutcomeCandidate(previous, { reason: 'incorrect_measurement', verification: { ...previous.verification, verifiedAt: '2026-10-06T16:00:00.000Z' } }, OPTIONS);
  for (const result of evaluateBoth(snapshot([previous, withdrawn], proof([previous])))) assert.equal(result.qualifiedOutcomeGroups[0].amount, '10');
  for (const result of evaluateBoth(snapshot([previous, withdrawn], proof([withdrawn])))) {
    assert.deepEqual(result.qualifiedOutcomeGroups, []);
    assert.ok(exclusionCodes(result).includes('OUTCOME_WITHDRAWN'));
  }
});

test('provisional archive records and unpublished candidates remain excluded even alongside a branded boundary', () => {
  const unpublished = candidate('one');
  const archive = { id: 'archived_work', workspaceId: WORKSPACE, status: 'COMPLETED', impact: { verified: true, incrementalContribution: 900000, currency: 'GBP' } };
  for (const [versions, code] of [[[archive], 'INVALID_OUTCOME_VERSION'], [[unpublished], 'UNPUBLISHED_OUTCOME']]) {
    for (const result of evaluateBoth(snapshot(versions, proof([], { expectedOutcomeCount: 1 })))) {
      assert.deepEqual(result.qualifiedOutcomeGroups, []);
      assert.equal(result.outcomeCoverage.complete, false);
      assert.ok(exclusionCodes(result).includes(code));
    }
  }
});

test('copied economic observations and conflicting immutable versions cannot create qualified groups', () => {
  const one = candidate('one');
  const copiedInput = input('copy');
  copiedInput.provenance.observationId = one.provenance.observationId;
  const copied = createBusinessOutcomeCandidate(copiedInput, OPTIONS);
  for (const result of evaluateBoth(snapshot([one, copied]))) {
    assert.deepEqual(result.qualifiedOutcomeGroups, []);
    assert.ok(exclusionCodes(result).includes('DUPLICATE_OBSERVATION'));
  }
  for (const result of evaluateBoth(snapshot([one, { ...one, amount: '999' }], proof([one])))) {
    assert.deepEqual(result.qualifiedOutcomeGroups, []);
    assert.equal(result.outcomeCoverage.complete, false);
    assert.ok(exclusionCodes(result).includes('CONFLICTING_OUTCOME_VERSION'));
  }
});

test('incomplete reads retain uncertainty instead of exposing partial group totals', () => {
  const one = candidate('one'), two = candidate('two');
  for (const publicationBoundary of [proof([one], { complete: false }), proof([one], { expectedOutcomeCount: 2 }), proof([one, two])]) {
    for (const result of evaluateBoth(snapshot([one], publicationBoundary))) {
      assert.equal(result.outcomeCoverage.publicationProofAvailable, true);
      assert.equal(result.outcomeCoverage.complete, false);
      assert.deepEqual(result.qualifiedOutcomeGroups, []);
      assert.equal(result.outcomeCoverage.unavailableReason, 'COMMITTED_OUTCOME_SNAPSHOT_INCOMPLETE');
    }
  }
});

test('standalone observations are descriptive without an invented additive amount', () => {
  const rows = ['one', 'two'].map(key => {
    const value = input(key);
    value.provenance.aggregation = 'standalone';
    return createBusinessOutcomeCandidate(value, OPTIONS);
  });
  for (const result of evaluateBoth(snapshot(rows))) {
    assert.equal(result.outcomeCoverage.complete, true);
    assert.equal(result.qualifiedOutcomeGroups.length, 1);
    assert.equal(result.qualifiedOutcomeGroups[0].amount, null);
    assert.equal(result.qualifiedOutcomeGroups[0].measuredCount, 2);
    assert.equal(result.qualifiedOutcomeGroups[0].amountStatus, 'standalone_observations');
    assert.equal(result.qualifiedOutcomeGroups[0].learningComparable, false);
  }
});

test('invalid, throwing and asynchronous committed resolvers fail closed without leaking private errors', () => {
  const row = candidate('one');
  const resolvers = [
    () => ({ head: head(row, { digest: 'f'.repeat(64) }), version: row }),
    () => { throw new Error('private database failure with sensitive details'); },
    () => Promise.resolve({ head: head(row), version: row })
  ];
  for (const resolveCommittedPublication of resolvers) {
    for (const result of evaluateBoth(snapshot([row], proof([row], { resolveCommittedPublication })))) {
      assert.deepEqual(result.qualifiedOutcomeGroups, []);
      assert.equal(result.outcomeCoverage.complete, false);
      assert.ok(exclusionCodes(result).includes('PUBLICATION_UNAVAILABLE'));
      assert.equal(JSON.stringify(result).includes('private database failure'), false);
    }
  }
});

test('foreign publication boundaries and versions throw WORKSPACE_MISMATCH instead of downgrading to missing proof', () => {
  const local = candidate('one');
  const foreign = createBusinessOutcomeCandidate(input('foreign'), { ...OPTIONS, workspaceId: 'tenant-b' });
  const foreignBoundary = proof([foreign], { workspaceId: 'tenant-b', resolveCommittedPublication: () => ({ head: head(foreign), version: foreign }) });
  for (const [, derive] of consumers) {
    assert.throws(() => derive(state(), { now: NOW, outcomeSnapshot: snapshot([local], foreignBoundary) }), { code: 'WORKSPACE_MISMATCH' });
    assert.throws(() => derive(state(), { now: NOW, outcomeSnapshot: snapshot([foreign], proof([foreign])) }), { code: 'WORKSPACE_MISMATCH' });
    const foreignResolver = proof([local], { resolveCommittedPublication: () => ({ head: head(foreign), version: foreign }) });
    assert.throws(() => derive(state(), { now: NOW, outcomeSnapshot: snapshot([local], foreignResolver) }), { code: 'WORKSPACE_MISMATCH' });
  }
});

test('qualified outcomes stay descriptive even above minSamples and derivation never mutates state or evidence', () => {
  const rows = Array.from({ length: 8 }, (_, index) => candidate(`sample_${index}`, { amount: String(index) }));
  const currentState = freeze({ ...state(), revenueEngine: { experiments: rows.map((row, index) => ({ id: row.source.experimentId, kind: 'retention', status: 'completed', impact: { verified: true, incrementalContribution: index } })) } });
  const beforeState = structuredClone(currentState), beforeRows = structuredClone(rows);
  let resolutionCalls = 0;
  const pairs = new Map(rows.map(row => [row.outcomeId, { head: head(row), version: row }]));
  const publicationBoundary = proof(rows, { resolveCommittedPublication: request => {
    resolutionCalls++;
    assert.equal(request.workspaceId, WORKSPACE);
    assert.equal(request.snapshotId, 'committed_snapshot_consumers');
    return pairs.get(request.outcomeId);
  } });
  const outcomeSnapshot = freeze(snapshot(rows, publicationBoundary));
  for (const result of evaluateBoth(outcomeSnapshot, currentState, { minSamples: 2 })) {
    assert.equal(result.qualifiedOutcomeGroups[0].amount, '28');
    assert.equal(result.qualifiedOutcomeGroups[0].measuredCount, 8);
    assert.equal(result.qualifiedOutcomeGroups[0].forecastingAuthorized, false);
  }
  assert.equal(resolutionCalls, rows.length * consumers.length, 'Each consumer must resolve actual committed publications');
  assert.deepEqual(currentState, beforeState);
  assert.deepEqual(rows, beforeRows);
  assert.equal(outcomeSnapshot.publicationBoundary, publicationBoundary);
});


test('owner-associated immutable action and approval links remain descriptive with no learning or forecast authority', () => {
  const action=reviewedActionFixture({workspaceId:WORKSPACE});
  const m=prepareExperimentOutcomeMeasurement({expectedRevision:0,amount:'12',currency:'GBP',window:WINDOW,
    coverage:{status:'complete',observedCount:10,expectedCount:10},method:{kind:'holdout'},observedAt:'2026-10-06T12:00:00.000Z',
    report:{description:'Synthetic owner-associated action report',costsComplete:true},actionSelection:{actionId:action.write.id}},
    {workspaceId:WORKSPACE,experimentId:'experiment_linked',actorId:'user_owner',now:NOW,previousMeasurement:null,actionEvidence:action.source});
  const row=createBusinessOutcomeCandidate({source:{type:'experiment_measurement',experimentId:m.experimentId,measurementRevision:m.revision,measurementDigest:m.digest},
    ...Object.fromEntries(['metric','amount','currency','window','coverage','method','provenance','links'].map(k=>[k,m[k]])),
    verification:{kind:'owner_attestation',actorId:'user_owner',verifiedAt:NOW,measurementDigest:m.digest}},OPTIONS);
  assert.ok(row.links.action); assert.ok(row.links.approval); assert.equal(row.links.objective,null);
  const linkedHead=head(row,{committedAt:NOW});
  const publicationBoundary=proof([row],{resolveCommittedPublication:()=>({head:linkedHead,version:row})});
  for(const result of evaluateBoth(snapshot([row],publicationBoundary))) {
    assert.equal(result.qualifiedOutcomeGroups[0].measuredCount,1); assert.equal(result.qualifiedOutcomeGroups[0].amount,'12');
    assert.equal(result.qualifiedOutcomeGroups[0].learningComparable,false); assert.equal(result.qualifiedOutcomeGroups[0].forecastingAuthorized,false);
  }
  assert.equal(m.intervention.comparison,'not_established');
});
