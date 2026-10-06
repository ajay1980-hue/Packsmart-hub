import test from 'node:test';
import assert from 'node:assert/strict';
import { seedWorkspaceState } from '../lib/store.mjs';
import { detectOpportunities, putDecision } from '../lib/control.mjs';
import { createExperiment, createOpportunityExperiment, recordExperimentMeasurement, verifyExperimentMeasurement } from '../lib/revenue-engine.mjs';
import { deriveBusinessState, projectCanonicalOpportunities } from '../lib/business-state.mjs';
import { deriveOpportunityQueue, scoreOpportunity } from '../lib/opportunity-engine.mjs';
import { deriveLearning } from '../lib/learning-engine.mjs';
import { runGrowthCouncil } from '../lib/growth-council.mjs';
import { derivePortfolioAllocation } from '../lib/portfolio-engine.mjs';
import { deriveExecutionPlan } from '../lib/execution-plan.mjs';

const now = new Date('2026-10-06T12:00:00.000Z');
function business() {
  const state = seedWorkspaceState({}, { workspaceId:'tenant-canonical' });
  state.products = [{ id:'p1', title:'Protective packaging for ecommerce', handle:'packaging', status:'active',
    description:'Useful protective packaging description for our recorded catalogue of ecommerce products.', image:'https://example.test/product.jpg',
    variants:[{ id:'v1', externalId:'v1', sku:'SKU-1', title:'Pack', price:10, inventory:2, available:true }] }];
  state.economics['SKU-1'] = { landed:9, packing:0, handling:0, delivery:0, paymentFee:0, channelFee:0, advertising:0, otherVariable:0 };
  detectOpportunities(state, 'system', { now });
  return state;
}
function verified(state, opportunity, metrics = { incrementalContribution:75 }) {
  const experiment = createOpportunityExperiment(state, opportunity, {}, 'owner');
  recordExperimentMeasurement(state, experiment.id, { method:'holdout', ...metrics }, 'analyst');
  verifyExperimentMeasurement(state, experiment.id, { note:'Settled contribution evidence reviewed.' }, 'owner');
  return experiment;
}
function project(state) {
  const businessState = deriveBusinessState(state, { now });
  return { businessState, queue:deriveOpportunityQueue(businessState, { learning:deriveLearning(state) }) };
}
function candidate(id, extra = {}) {
  return { id, title:`Review ${id}`, kind:'pricing', reference:id, status:'open', present:true, confidence:0.85, risk:'high', effort:'low', ...extra };
}

test('detected opportunity keeps its identity and verified posture through measurement, business state and Command queue', () => {
  const state = business();
  const pricing = state.opportunities.find(item => item.kind === 'pricing');
  assert.ok(pricing.id);
  assert.equal(pricing.estimatedImpact.amount, 1.25);
  assert.match(pricing.estimatedImpact.unit, /per unit/);
  const experiment = verified(state, pricing, { incrementalRevenue:900, incrementalContribution:75, costAvoided:5 });
  const historical = createExperiment(state, { kind:'pricing', title:'Prior pricing test' }, 'owner');
  recordExperimentMeasurement(state, historical.id, { method:'holdout', incrementalContribution:10 }, 'analyst');
  verifyExperimentMeasurement(state, historical.id, { note:'Historical contribution verified.' }, 'owner');
  const before = structuredClone(state);
  const { businessState, queue } = project(state);
  const projected = businessState.opportunities.find(item => item.id === pricing.id);
  const row = queue.opportunities.find(item => item.id === pricing.id);
  assert.equal(projected.kind, 'pricing');
  assert.equal(row.kind, 'margin');
  assert.equal(row.evidenceKind, 'pricing');
  assert.equal(row.experimentId, experiment.id);
  assert.equal(row.evidenceDecision, 'ready-for-owner-review');
  assert.equal(row.verifiedContributionValue, 80);
  assert.equal(row.evidenceVerified, true);
  assert.equal(row.expectedContributionProfit, null);
  assert.equal(row.score, null);
  assert.equal(row.learning.samples, 2);
  assert.equal(row.approvalRequired, true);
  assert.equal(row.requiredAction, 'major_price_change');
  assert.equal(row.actionType, 'major_price_change');
  assert.ok(!queue.opportunities.some(item => ['margin-stop-loss', 'inventory-protect-sales'].includes(item.id)));
  const council = runGrowthCouncil(businessState, queue);
  const review = council.deliberations.find(item => item.opportunityId === pricing.id);
  assert.ok(review.reviews.some(item => item.agentId === 'pricing'));
  assert.equal(review.approvalRequired, true);
  assert.equal(review.financiallyReady, false);
  assert.deepEqual(state, before, 'derivation must be read-only');
});

test('reorder learning uses the actual evidence kind while retaining inventory specialist routing', () => {
  const state = business();
  const reorder = state.opportunities.find(item => item.kind === 'reorder');
  verified(state, reorder, { contributionProtected:12 });
  const businessState = deriveBusinessState(state, { now });
  const queue = deriveOpportunityQueue(businessState, { learning:{ workspaceId:state.workspace.id, priors:[
    { kind:'reorder', usableForGuidance:true, samples:4, confidence:'medium', positiveRatePercent:75 },
    { kind:'inventory', usableForGuidance:true, samples:8, confidence:'high', positiveRatePercent:100 }
  ] } });
  const row = queue.opportunities.find(item => item.id === reorder.id);
  assert.equal(row.kind, 'inventory');
  assert.equal(row.evidenceKind, 'reorder');
  assert.equal(row.learning.samples, 4);
  assert.equal(row.verifiedContributionValue, 12);
  assert.equal(row.approvalRequired, true);
  assert.equal(row.expectedContributionProfit, null);
  const foreign = deriveOpportunityQueue(businessState, { learning:{ workspaceId:'another-tenant', priors:[{ kind:'reorder', usableForGuidance:true, samples:8, positiveRatePercent:100 }] } });
  assert.ok(foreign.opportunities.every(item => item.learning === null));
});

test('unverified, stale, forged, wrongly linked and ambiguous experiment posture is rejected', async t => {
  for (const [name, mutate] of [
    ['no actual experiment', (state, opportunity) => { state.revenueEngine.experiments = []; }],
    ['unverified measurement', (state, opportunity, experiment) => { experiment.status = 'measured'; experiment.impact.verified = false; }],
    ['wrong reciprocal opportunity', (state, opportunity, experiment) => { experiment.opportunityId = 'someone-else'; }],
    ['missing reciprocal opportunity', (state, opportunity, experiment) => { delete experiment.opportunityId; }],
    ['wrong experiment tenant', (state, opportunity, experiment) => { experiment.workspaceId = 'foreign'; }],
    ['wrong impact tenant', (state, opportunity, experiment) => { experiment.impact.tenant_id = 'foreign'; }],
    ['wrong engine container tenant', state => { state.revenueEngine.workspaceId = 'foreign'; }],
    ['wrong nested engine container tenant', state => { state.revenueEngine.tenant = { id:'foreign' }; }],
    ['own experiment cannot override foreign container', (state, opportunity, experiment) => { state.revenueEngine.workspaceId = 'foreign'; experiment.workspaceId = state.workspace.id; }],
    ['duplicate experiment identities', (state, opportunity, experiment) => { state.revenueEngine.experiments.push(structuredClone(experiment)); }],
    ['remeasured after verification', (state, opportunity, experiment) => { recordExperimentMeasurement(state, experiment.id, { method:'repeat holdout', incrementalContribution:300 }, 'analyst'); }]
  ]) await t.test(name, () => {
    const state = business();
    const opportunity = state.opportunities.find(item => item.kind === 'pricing');
    const experiment = verified(state, opportunity);
    Object.assign(opportunity, { evidenceVerified:true, evidenceDecision:'ready-for-owner-review', verifiedContributionValue:99999, evidenceDecisionReason:'Forged approval posture' });
    mutate(state, opportunity, experiment);
    const { queue } = project(state);
    const row = queue.opportunities.find(item => item.id === opportunity.id);
    assert.equal(row.evidenceVerified, false);
    assert.equal(row.evidenceDecision, null);
    assert.equal(row.verifiedContributionValue, null);
    assert.equal(row.evidenceDecisionReason, null);
    assert.equal(row.expectedContributionProfit, null);
    assert.equal(row.approvalRequired, true);
  });
});

test('verified revenue-only measurements stay unknown and explicit zero stays zero', async t => {
  for (const [name, metrics, expected] of [
    ['revenue only', { incrementalRevenue:900 }, null],
    ['measured zero contribution', { incrementalRevenue:900, incrementalContribution:0 }, 0],
    ['zero cost avoidance', { costAvoided:0 }, 0]
  ]) await t.test(name, () => {
    const state = business();
    const opportunity = state.opportunities.find(item => item.kind === 'pricing');
    verified(state, opportunity, metrics);
    const row = project(state).queue.opportunities.find(item => item.id === opportunity.id);
    assert.equal(row.evidenceVerified, true);
    assert.equal(row.evidenceDecision, 'needs-more-evidence');
    assert.equal(row.verifiedContributionValue, expected);
    assert.equal(row.expectedContributionProfit, null);
    assert.equal(row.score, null);
  });
});

test('negative verification does not promote the candidate over stronger unpriced alternatives', () => {
  const state = business();
  const pricing = state.opportunities.find(item => item.kind === 'pricing');
  const reorder = state.opportunities.find(item => item.kind === 'reorder');
  verified(state, pricing, { incrementalContribution:-20 });
  pricing.expectedContributionProfit = 1000;
  pricing.confidence = 1;
  const queue = project(state).queue;
  assert.ok(queue.opportunities.findIndex(item => item.id === reorder.id) < queue.opportunities.findIndex(item => item.id === pricing.id));
  const row = queue.opportunities.find(item => item.id === pricing.id);
  assert.equal(row.evidenceDecision, 'deprioritise');
  assert.equal(row.verifiedContributionValue, -20);
  assert.equal(row.approvalRequired, true);
});

test('dismissal, absence, exclusions and rejected ideas suppress canonical work without generic resurrection', () => {
  const state = business();
  state.opportunities = [
    candidate('dismissed', { status:'dismissed' }), candidate('resolved', { status:'resolved' }),
    candidate('absent', { present:false }), candidate('excluded', { reference:'SKU-1' }),
    candidate('rejected-id'), candidate('rejected-fingerprint', { fingerprint:'fingerprint-rejected' }),
    candidate('cancelled', { status:'cancelled' })
  ];
  state.decisions = [
    { status:'active', category:'product_exclusion', target:'SKU-1' },
    { status:'active', category:'rejected_idea', target:'rejected-id' },
    { status:'active', category:'rejected_idea', target:'fingerprint-rejected' }
  ];
  state.economics = {};
  const { businessState, queue } = project(state);
  assert.deepEqual(businessState.opportunities, []);
  assert.deepEqual(queue.opportunities.map(item => item.id), ['evidence-complete-costs']);
  assert.equal(queue.opportunities[0].approvalRequired, false);
  assert.equal(queue.opportunities[0].expectedContributionProfit, null);
  assert.ok(businessState.inventory.risks.length, 'aggregate stock evidence still exists but must not resurrect work');
});

test('active decisions are respected before the next detector run and foreign decisions cannot suppress own work', () => {
  const state = business();
  const pricing = state.opportunities.find(item => item.kind === 'pricing');
  state.decisions.push({ status:'active', category:'rejected_idea', target:pricing.id, workspaceId:'foreign' });
  assert.ok(project(state).queue.opportunities.some(item => item.id === pricing.id));
  putDecision(state, { key:'skip-pricing', category:'rejected_idea', title:'Skip this idea', content:'This is not a current priority.', source:'Owner review', target:pricing.id }, 'owner');
  assert.equal(pricing.present, true, 'detector has not been rerun');
  assert.ok(!project(state).queue.opportunities.some(item => item.id === pricing.id));
});

test('canonical identities deduplicate conservatively and enforce explicit tenant fields', () => {
  const state = business();
  state.opportunities = [
    candidate('keep', { fingerprint:'same-fingerprint' }), candidate('keep', { title:'Duplicate ID' }),
    candidate('other-id', { fingerprint:'same-fingerprint' }),
    candidate('dismissed-duplicate'), candidate('dismissed-duplicate', { status:'dismissed' }),
    candidate('foreign-workspace', { workspaceId:'foreign' }), candidate('foreign-tenant', { tenantId:'foreign' }),
    candidate('foreign-snake', { workspace_id:'foreign' }), candidate('foreign-nested', { workspace:{ id:'foreign' } }),
    candidate('null-scope', { tenant_id:null }),
    candidate('own-explicit', { workspaceId:state.workspace.id, tenant_id:state.workspace.id }),
    candidate('keep', { tenantId:'foreign', status:'dismissed' })
  ];
  assert.deepEqual(projectCanonicalOpportunities(state).map(item => item.id), ['own-explicit']);
  assert.deepEqual(project(state).queue.opportunities.map(item => item.id).sort(), ['own-explicit']);
});

test('conflicting duplicate IDs or fingerprints cannot choose the least restrictive authority or enter execution', async t => {
  for (const fingerprint of [false, true]) for (const reverse of [false, true]) await t.test(`${fingerprint ? 'fingerprint' : 'ID'} collision, ${reverse ? 'restricted' : 'safe'} record first`, () => {
    const state = business();
    state.settings = { ...state.settings, growthCapacityHours:8, maxConcurrentGrowthExperiments:2 };
    const safe = candidate('ambiguous', { kind:'operations', fingerprint:fingerprint ? 'shared' : undefined, requiredAction:null, actionType:'safe', approvalRequired:false, executionCost:0, effortHours:1 });
    const restricted = { ...safe, id:fingerprint ? 'different-id' : safe.id, requiredAction:'supplier_order', executionCost:100 };
    state.opportunities = reverse ? [restricted, safe] : [safe, restricted];
    assert.deepEqual(projectCanonicalOpportunities(state), []);
    assert.deepEqual(project(state).queue.opportunities, []);
    assert.deepEqual(deriveOpportunityQueue({ workspaceId:state.workspace.id, opportunities:state.opportunities }).opportunities, []);
    const portfolio = derivePortfolioAllocation(state);
    assert.equal(portfolio.allocation.nextExecutable, null);
    assert.deepEqual(deriveExecutionPlan(portfolio).sequence, []);
  });
});

test('later duplicate authority and dismissal are checked beyond the output bound', () => {
  const state = business();
  const safe = candidate('first', { requiredAction:null, approvalRequired:false, executionCost:0, effortHours:1 });
  state.opportunities = [safe, ...Array.from({ length:120 }, (_, index) => candidate(`filler-${index}`)), { ...safe, requiredAction:'supplier_order', executionCost:100 }];
  assert.ok(projectCanonicalOpportunities(state).every(item => item.id !== safe.id));
  assert.ok(deriveOpportunityQueue({ workspaceId:state.workspace.id, opportunities:state.opportunities }).opportunities.every(item => item.id !== safe.id));
  state.opportunities.at(-1).status = 'dismissed';
  assert.ok(projectCanonicalOpportunities(state).every(item => item.id !== safe.id));
});

test('explicit root and workspace descriptor scope conflicts fail closed', () => {
  for (const mutate of [state => { state.tenantId = 'foreign'; }, state => { state.workspace_id = 'foreign'; }, state => { state.workspace.tenantId = 'foreign'; }]) {
    const state = business();
    mutate(state);
    assert.deepEqual(projectCanonicalOpportunities(state), []);
    assert.throws(() => deriveBusinessState(state, { now }), error => error.code === 'WORKSPACE_MISMATCH');
  }
  const queue = deriveOpportunityQueue({ workspaceId:'own', tenantId:'foreign', opportunities:[candidate('first')], profitability:{ missingCostVariants:1 } });
  assert.deepEqual(queue.opportunities, []);
  assert.equal(queue.workspaceId, '');
});

test('foreign-scoped nested evidence cannot be exported as own opportunity text', () => {
  const state = business();
  state.opportunities = [candidate('own', { evidence:[
    { type:'economics', workspaceId:'foreign', detail:'foreign-economics-secret' },
    { type:'variant', tenant:{ id:'foreign' }, detail:'foreign-stock-secret' },
    { type:'product', tenant_id:null, detail:'unknown-tenant-secret' },
    { type:'economics', workspaceId:state.workspace.id, detail:'Own recorded costs.' }
  ] })];
  const { businessState, queue } = project(state);
  assert.equal(businessState.opportunities[0].evidence, 'Own recorded costs.');
  assert.equal(queue.opportunities[0].evidence, 'Own recorded costs.');
  assert.ok(!JSON.stringify({ businessState, queue }).includes('-secret'));
});

test('durable projection fails closed without a valid workspace and never truncates scope into another tenant', () => {
  for (const workspaceId of [undefined, null, '', ' ', ' tenant ', 'x'.repeat(257), 'tenant\nforeign']) {
    const state = { workspace:{ id:workspaceId }, opportunities:[candidate('unscoped')] };
    assert.deepEqual(projectCanonicalOpportunities(state), []);
    const queue = deriveOpportunityQueue({ workspaceId, opportunities:state.opportunities, profitability:{ missingCostVariants:1 } });
    assert.equal(queue.workspaceId, '');
    assert.deepEqual(queue.opportunities, []);
  }
  const prefix = 'tenant-'.repeat(20);
  const workspaceId = `${prefix}own`;
  const foreignId = `${prefix}foreign`;
  const state = business();
  state.workspace.id = workspaceId;
  state.opportunities = [candidate('own', { workspaceId }), candidate('foreign', { workspaceId:foreignId })];
  const { businessState, queue } = project(state);
  assert.equal(businessState.workspaceId, workspaceId);
  assert.equal(businessState.opportunities[0].workspaceId, workspaceId);
  assert.equal(queue.workspaceId, workspaceId);
  assert.equal(queue.safeguards.tenantScope, workspaceId);
  assert.deepEqual(queue.opportunities.map(item => item.id), ['own']);
});

test('canonical projection and queue are bounded and omit raw records, customer payloads and secrets', () => {
  const state = business();
  state.opportunities = Array.from({ length:160 }, (_, index) => candidate(`row-${index}`, {
    title:'T'.repeat(1000), raw:{ secret:'raw-order-secret' }, customerEmail:'private@example.test', accessToken:'private-token',
    history:[{ note:'private-history-secret' }], estimatedImpact:{ amount:99999, raw:'private-estimate-secret' },
    evidence:[{ type:'customer', detail:'private@example.test' }, { type:'economics', detail:'E'.repeat(10000), accessToken:'private-evidence-secret' }],
    needsEvidence:Array(50).fill('N'.repeat(1000)), requiredAction:'supplier_order', executionCost:0, effortHours:0
  }));
  const experiment = verified(state, state.opportunities[0]);
  experiment.impact.verificationNote = 'private-verification-secret';
  experiment.raw = { accessToken:'private-experiment-secret' };
  const { businessState, queue } = project(state);
  assert.equal(businessState.opportunities.length, 100);
  assert.equal(queue.opportunities.length, 50);
  assert.equal(projectCanonicalOpportunities(state, { limit:1000 }).length, 100);
  assert.equal(deriveOpportunityQueue(businessState, { limit:1000 }).opportunities.length, 50);
  assert.equal(deriveOpportunityQueue(businessState, { limit:3 }).opportunities.length, 3);
  assert.equal(deriveOpportunityQueue(businessState, { limit:0 }).opportunities.length, 0);
  assert.equal(projectCanonicalOpportunities(state, { limit:0 }).length, 0);
  const row = businessState.opportunities[0];
  assert.equal(row.title.length, 180);
  assert.ok(row.evidence.length <= 600);
  assert.equal(row.needsEvidence.length, 12);
  assert.ok(row.needsEvidence.every(value => value.length <= 160));
  assert.equal(row.executionCost, 0);
  assert.equal(row.effortHours, 0);
  const json = JSON.stringify({ businessState, queue });
  assert.ok(!json.includes('private-'));
  assert.ok(!json.includes('private@example.test'));
  assert.ok(!json.includes('raw-order-secret'));
  assert.ok(!json.includes('99999'));
});

test('unproven totals, unit estimates, historical amounts and missing money remain distinct', () => {
  const state = business();
  state.opportunities = [
    candidate('unknown', { expectedContributionProfit:null, executionCost:null, effortHours:null, estimatedImpact:{ amount:50, unit:'GBP per unit' } }),
    candidate('zero', { expectedContributionProfit:0, executionCost:0, effortHours:0, confidence:0, risk:0 }),
    candidate('forecast', { expectedContributionProfit:100, executionCost:5, requiredAction:'supplier_order', approvalRequired:false }),
    candidate('invalid', { expectedContributionProfit:true, executionCost:'', effortHours:Infinity })
  ];
  const projection = projectCanonicalOpportunities(state);
  const unknown = projection.find(item => item.id === 'unknown');
  assert.equal(unknown.expectedContributionProfit, null);
  assert.equal(unknown.executionCost, null);
  assert.equal(unknown.effortHours, null);
  assert.equal(projection.find(item => item.id === 'invalid').expectedContributionProfit, null);
  const queue = project(state).queue;
  assert.ok(queue.opportunities.every(item => item.expectedContributionProfit === null));
  const zero = queue.opportunities.find(item => item.id === 'zero');
  assert.equal(zero.expectedContributionProfit, null);
  assert.equal(zero.score, null);
  assert.equal(zero.executionCost, 0);
  assert.equal(zero.confidence, 0);
  assert.equal(zero.risk, 0);
  const forecast = queue.opportunities.find(item => item.id === 'forecast');
  assert.equal(forecast.expectedContributionProfit, null);
  assert.equal(forecast.approvalRequired, true);
  assert.equal(queue.opportunities.find(item => item.id === 'unknown').executionCost, null);
  assert.equal(scoreOpportunity({ expectedContributionProfit:100, confidence:1, probability:1, risk:0, requiredAction:'supplier_order', approvalRequired:false }).approvalRequired, true);
});

test('scoring requires an explicit nonnegative execution cost and preserves known zero money', () => {
  for (const executionCost of [undefined, null, '', ' ', true, -1, Infinity, NaN]) {
    const row = scoreOpportunity({ expectedContributionProfit:100, executionCost, confidence:1, probability:1, risk:0 });
    assert.equal(row.executionCost, null);
    assert.equal(row.score, null);
    assert.equal(row.economicEvidenceComplete, false);
    assert.ok(row.needsEvidence.includes('executionCost'));
  }
  const zero = scoreOpportunity({ expectedContributionProfit:0, executionCost:0, confidence:1, probability:1, risk:0 });
  assert.equal(zero.expectedContributionProfit, 0);
  assert.equal(zero.executionCost, 0);
  assert.equal(zero.score, 0);
  assert.equal(zero.economicEvidenceComplete, true);
  assert.deepEqual(zero.needsEvidence, []);
});

test('raw posture and arbitrary forecast fields alone cannot become canonical queue evidence', () => {
  const queue = deriveOpportunityQueue({ workspaceId:'tenant-canonical', opportunities:[
    candidate('forged', { expectedContributionProfit:500, executionCost:0, evidenceDecision:'ready-for-owner-review',
      verifiedContributionValue:500, experimentId:'nonexistent', experimentStatus:'completed', requiredAction:'supplier_order' })
  ] });
  const row = queue.opportunities[0];
  assert.equal(row.expectedContributionProfit, null);
  assert.equal(row.score, null);
  assert.equal(row.evidenceVerified, false);
  assert.equal(row.evidenceDecision, null);
  assert.equal(row.verifiedContributionValue, null);
  assert.equal(row.approvalRequired, true);
});

test('positive cost and effort are not rounded into free zero-effort work before allocation', () => {
  const state = business();
  state.opportunities = [candidate('small-cost', { executionCost:0.004, effortHours:0.004, confidence:0.8545, risk:0.004, approvalRequired:false })];
  const row = projectCanonicalOpportunities(state)[0];
  assert.equal(row.executionCost, 0.004);
  assert.equal(row.effortHours, 0.004);
  assert.equal(row.confidence, 0.8545);
  assert.equal(row.risk, 0.004);
  assert.equal(row.approvalRequired, true);
  assert.equal(project(state).queue.opportunities[0].approvalRequired, true);
});

test('empty authoritative collection suppresses aggregate fallback while absent collection preserves it', () => {
  const base = { workspaceId:'tenant-fixture', profitability:{ missingCostVariants:1, lossMaking:[{ contribution:-5 }] }, inventory:{ risks:[{ sku:'LOW' }] },
    recommendations:[{ id:'seo', title:'Prepare catalogue review', detail:'Recorded catalogue issue', actionType:'customer_facing_publish', view:'marketing' }] };
  assert.equal(deriveOpportunityQueue(base).opportunities.length, 4);
  assert.deepEqual(deriveOpportunityQueue({ ...base, opportunities:[] }).opportunities.map(item => item.id), ['evidence-complete-costs']);
  const state = business();
  delete state.opportunities;
  assert.equal(projectCanonicalOpportunities(state), null);
  assert.equal(Object.hasOwn(deriveBusinessState(state, { now }), 'opportunities'), false);
});
