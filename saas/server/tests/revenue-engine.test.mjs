import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCustomerIntelligence, deriveAttribution, deriveBasketIntelligence, deriveIntentRecovery, deriveSalesPipeline, deriveGrowthPlan, ensureRevenueEngine, createExperiment, createOpportunityExperiment, recordExperimentMeasurement, verifyExperimentMeasurement, revenueEngineSnapshot } from '../lib/revenue-engine.mjs';

const now = new Date('2026-10-01T12:00:00.000Z');
function order(id, customer, createdAt, lines, total=120) {
  return { id, provider:'shopify', customerEmailHash:customer, createdAt, financialStatus:'PAID', fulfillmentStatus:'FULFILLED', total, currentTotal:total, refunds:0, tax:20, currentTax:20, discounts:0, shippingCharged:0, actualShippingCost:5, paymentFees:2, channelFees:0, advertisingCost:0, otherVariableCosts:0, lineItems:lines };
}
const economics = {
  A:{ landedCost:20, packing:1, handling:1, delivery:0, paymentFee:0, channelFee:0, advertising:0, otherVariable:0 },
  B:{ landedCost:10, packing:1, handling:1, delivery:0, paymentFee:0, channelFee:0, advertising:0, otherVariable:0 }
};

test('customer intelligence uses privacy-preserving order identity and evidence-backed retention', () => {
  const state={economics,orders:[
    order('o1','abc123','2026-07-01T00:00:00Z',[{sku:'A',name:'A',quantity:1,net:100}]),
    order('o2','abc123','2026-08-01T00:00:00Z',[{sku:'A',name:'A',quantity:1,net:100},{sku:'B',name:'B',quantity:1,net:20}]),
    order('o3','other','2026-09-25T00:00:00Z',[{sku:'B',name:'B',quantity:1,net:120}])
  ]};
  const result=deriveCustomerIntelligence(state,{now});
  assert.equal(result.summary.customers,2);
  assert.equal(result.summary.repeatCustomers,1);
  assert.equal(result.coverage.namesAndEmailsExposed,false);
  const repeat=result.customers.find(c=>c.id==='shopify:abc123');
  assert.equal(repeat.orderCount,2);
  assert.equal(repeat.averageReorderDays,31);
  assert.equal(repeat.signals.churnRisk,true);
  assert.ok(repeat.contribution === null || typeof repeat.contribution === 'number');
  assert.equal(repeat.profitCoverage, 0);
});

test('attribution does not invent traffic sources from provider channel', () => {
  const state={economics,orders:[order('o1','abc','2026-09-01T00:00:00Z',[{sku:'A',quantity:1,net:100}])],revenueEngine:{attributionTouches:[]}};
  const result=deriveAttribution(state);
  assert.equal(result.orders[0].source,null);
  assert.equal(result.orders[0].confidence,'channel-only');
  assert.equal(result.coverage.sourceCoveragePercent,0);
  state.revenueEngine.attributionTouches=[{orderId:'o1',kind:'utm_source',value:'google',confidence:'confirmed'}];
  const sourced=deriveAttribution(state);
  assert.equal(sourced.orders[0].source,'google');
  assert.equal(sourced.coverage.sourceCoveragePercent,100);
});

test('basket intelligence only recommends repeated observed pairs', () => {
  const state={economics,orders:[
    order('o1','a','2026-09-01T00:00:00Z',[{sku:'A',quantity:1},{sku:'B',quantity:1}]),
    order('o2','b','2026-09-02T00:00:00Z',[{sku:'A',quantity:1},{sku:'B',quantity:1}])
  ]};
  const result=deriveBasketIntelligence(state);
  assert.equal(result.pairs[0].ordersTogether,2);
  assert.equal(result.recommendations.length,1);
  assert.equal(result.recommendations[0].approvalRequired,true);
});

test('intent recovery, B2B pipeline and commander keep outbound actions approval controlled', () => {
  const state={economics,orders:[],revenueEngine:{}};
  const engine=ensureRevenueEngine(state);
  engine.intentEvents=[{type:'checkout_started',sessionId:'s1',value:500,createdAt:'2026-09-30T00:00:00Z'}];
  engine.leads=[{id:'l1',company:'Trade Co',stage:'quote'}];
  engine.quotes=[{id:'q1',status:'draft',followUpAt:'2026-09-30T00:00:00Z',lines:[{sku:'A',quantity:100,unitPrice:2,unitContribution:.8}]}];
  const recovery=deriveIntentRecovery(state,{now});
  assert.equal(recovery.recoveries[0].recommendedAction,'sales-follow-up');
  assert.equal(recovery.recoveries[0].approvalRequired,true);
  const sales=deriveSalesPipeline(state,{now});
  assert.equal(sales.summary.openPipeline,200);
  assert.equal(sales.summary.overdueFollowUps,1);
  const plan=deriveGrowthPlan(state);
  assert.ok(plan.opportunities.some(item=>item.kind==='b2b'&&item.approvalRequired));
  assert.ok(plan.opportunities.every(item=>item.estimatedImpact===null));
});


test('legacy experiment lifecycle separates owner review from financial qualification', () => {
  const state={workspace:{id:'tenant-loop'},economics:{},orders:[],revenueEngine:{}};
  const experiment=createExperiment(state,{kind:'retention',title:'Win-back test',hypothesis:'A targeted reminder improves contribution.'},'owner-1');
  assert.equal(experiment.status,'draft');
  assert.equal(experiment.externalWrites,false);

  const measured=recordExperimentMeasurement(state,experiment.id,{method:'holdout',incrementalRevenue:300,incrementalContribution:90},'analyst-1');
  assert.equal(measured.status,'measured');
  assert.equal(measured.impact.verified,false);
  assert.equal(measured.impact.legacyReviewed,false);
  assert.equal(measured.impact.financiallyQualified,false);
  assert.equal(measured.impact.incrementalContribution,90);

  const verified=verifyExperimentMeasurement(state,experiment.id,{note:'Matched holdout reviewed against settled orders.'},'owner-1');
  assert.equal(verified.status,'completed');
  assert.equal(verified.impact.verified,true);
  assert.equal(verified.impact.status,'verified');
  assert.equal(verified.impact.verifiedBy,'owner-1');
  assert.equal(verified.impact.legacyReviewed,true);
  assert.equal(verified.impact.financiallyQualified,false);
  assert.equal(verified.evidenceQualification,'legacy_unqualified');
  assert.equal(verified.verifiedContributionValue,null);
});

test('experiment verification requires a measured result and an explicit verification note', () => {
  const state={workspace:{id:'tenant-guard'},economics:{},orders:[],revenueEngine:{}};
  const experiment=createExperiment(state,{kind:'conversion',title:'Checkout recovery test'},'owner-1');
  assert.throws(()=>verifyExperimentMeasurement(state,experiment.id,{note:'too early'},'owner-1'),error=>error.code==='EXPERIMENT_NOT_MEASURED');
  recordExperimentMeasurement(state,experiment.id,{method:'before-after',incrementalContribution:15},'analyst-1');
  assert.throws(()=>verifyExperimentMeasurement(state,experiment.id,{},'owner-1'),error=>error.code==='VALIDATION_FAILED');
});


test('opportunity experiment links the existing opportunity without authorising a write', () => {
  const state={workspace:{id:'tenant-link'},economics:{},orders:[],revenueEngine:{}};
  const opportunity={id:'opportunity-1',kind:'retention',title:'Recover lapsed buyers',recommendedNextStep:'Test a controlled reminder',status:'open'};
  const experiment=createOpportunityExperiment(state,opportunity,{},'owner-1');
  assert.equal(experiment.opportunityId,'opportunity-1');
  assert.equal(opportunity.experimentId,experiment.id);
  assert.equal(opportunity.experimentStatus,'draft');
  assert.equal(experiment.externalWrites,false);
});


test('legacy owner review preserves measured values and history without qualifying linked opportunity posture', () => {
  const state={workspace:{id:'tenant-posture'},economics:{},orders:[],opportunities:[],revenueEngine:{}};
  const opportunity={id:'opportunity-1',kind:'retention',title:'Retention test',status:'open',evidenceVerified:true,verifiedContributionValue:999,financiallyQualified:true};
  state.opportunities.push(opportunity);
  const experiment=createOpportunityExperiment(state,opportunity,{},'owner-1');
  const values={incrementalRevenue:500,incrementalContribution:75,contributionProtected:10,costAvoided:20,minutesSaved:30};
  recordExperimentMeasurement(state,experiment.id,{method:'holdout',...values},'analyst-1');
  const measuredAt=experiment.impact.measuredAt;
  const verified=verifyExperimentMeasurement(state,experiment.id,{note:'Settled order contribution checked.'},'owner-1');
  for(const [key,value] of Object.entries(values)) assert.equal(verified.impact[key],value);
  assert.equal(verified.impact.method,'holdout');
  assert.equal(verified.impact.measuredAt,measuredAt);
  assert.equal(verified.impact.recordedBy,'analyst-1');
  assert.equal(verified.impact.verifiedBy,'owner-1');
  assert.equal(verified.impact.verificationNote,'Settled order contribution checked.');
  assert.equal(verified.impact.verifiedAt,verified.completedAt);
  assert.equal(verified.decisionPosture.status,'needs-more-evidence');
  assert.equal(verified.decisionPosture.verifiedContributionValue,null);
  assert.equal(verified.decisionPosture.financiallyQualified,false);
  assert.equal(opportunity.evidenceDecision,'needs-more-evidence');
  assert.equal(opportunity.verifiedContributionValue,null);
  assert.equal(opportunity.evidenceVerified,false);
  assert.equal(opportunity.financiallyQualified,false);
  assert.equal(opportunity.legacyReviewRecorded,true);
  assert.equal(opportunity.evidenceQualification,'legacy_unqualified');
});

test('revenue-only verification cannot make an opportunity approval-ready', () => {
  const state={workspace:{id:'tenant-revenue-only'},economics:{},orders:[],opportunities:[],revenueEngine:{}};
  const opportunity={id:'opportunity-2',kind:'conversion',title:'Conversion test',status:'open'};
  state.opportunities.push(opportunity);
  const experiment=createOpportunityExperiment(state,opportunity,{},'owner-1');
  recordExperimentMeasurement(state,experiment.id,{method:'before-after',incrementalRevenue:1000},'analyst-1');
  verifyExperimentMeasurement(state,experiment.id,{note:'Revenue confirmed; contribution not established.'},'owner-1');
  assert.equal(opportunity.evidenceDecision,'needs-more-evidence');
  assert.equal(opportunity.verifiedContributionValue,null);
});

test('negative legacy review remains unqualified rather than conferring a financial ranking', () => {
  const state={workspace:{id:'tenant-negative'},economics:{},orders:[],opportunities:[],revenueEngine:{}};
  const opportunity={id:'opportunity-3',kind:'pricing',title:'Pricing test',status:'open'};
  state.opportunities.push(opportunity);
  const experiment=createOpportunityExperiment(state,opportunity,{},'owner-1');
  recordExperimentMeasurement(state,experiment.id,{method:'holdout',incrementalContribution:-20},'analyst-1');
  verifyExperimentMeasurement(state,experiment.id,{note:'Contribution loss confirmed.'},'owner-1');
  assert.equal(experiment.impact.incrementalContribution,-20);
  assert.equal(opportunity.evidenceDecision,'needs-more-evidence');
  assert.equal(opportunity.verifiedContributionValue,null);
});

test('explicit legacy zero is preserved as an observed value rather than qualified zero contribution', () => {
  const state={workspace:{id:'tenant-zero'},economics:{},orders:[],revenueEngine:{}};
  const experiment=createExperiment(state,{kind:'pricing',title:'Zero result'},'owner-1');
  recordExperimentMeasurement(state,experiment.id,{method:'holdout',incrementalContribution:0},'analyst-1');
  verifyExperimentMeasurement(state,experiment.id,{note:'Explicit zero was reviewed.'},'owner-1');
  assert.equal(experiment.impact.incrementalContribution,0);
  assert.equal(experiment.impact.legacyReviewed,true);
  assert.equal(experiment.decisionPosture.status,'needs-more-evidence');
  assert.equal(experiment.decisionPosture.verifiedContributionValue,null);
});

test('remeasurement clears stale legacy review and financial posture in the returned record', () => {
  const experiment={id:'old-result',status:'completed',impact:{verified:true,status:'verified',incrementalContribution:100},
    legacyReviewRecorded:true,evidenceVerified:true,financiallyQualified:true,qualified:true,verifiedContributionValue:100,
    decisionPosture:{status:'ready-for-owner-review',verifiedContributionValue:100}};
  const state={revenueEngine:{experiments:[experiment]}};
  const measured=recordExperimentMeasurement(state,experiment.id,{method:'new holdout',incrementalContribution:-10},'analyst-2');
  assert.equal(measured.impact.incrementalContribution,-10);
  assert.equal(measured.impact.legacyReviewed,false);
  assert.equal(measured.legacyReviewRecorded,false);
  assert.equal(measured.evidenceVerified,false);
  assert.equal(measured.financiallyQualified,false);
  assert.equal(measured.qualified,false);
  assert.equal(measured.decisionPosture.status,'needs-more-evidence');
  assert.equal(measured.verifiedContributionValue,null);
  assert.equal(measured.decisionPosture.verifiedContributionValue,null);
});

function deepFreeze(value) {
  if(value && typeof value==='object' && !Object.isFrozen(value)) {
    for(const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test('raw snapshots normalize stored positive, zero and negative legacy flags without rewriting audit history', () => {
  const flags=[{verified:true,status:'verified'},{verified:true,status:'measured'},{verified:false,status:'verified'}];
  const experiments=[];
  for(const [index,flag] of flags.entries()) for(const value of [75,0,-20]) experiments.push({
    id:`stored-${index}-${value}`,status:'completed',completedAt:'2026-09-30T12:00:00.000Z',
    outcomeMeasurement:{schema:'typed-measurement-preserved',amount:String(value)},
    impact:{...flag,incrementalContribution:value,incrementalRevenue:500,contributionProtected:10,costAvoided:5,minutesSaved:30,
      method:'holdout',measuredAt:'2026-09-29T12:00:00.000Z',recordedBy:'analyst-1',
      verifiedAt:'2026-09-30T12:00:00.000Z',verifiedBy:'owner-1',verificationNote:'Historical owner review',
      financiallyQualified:true,qualified:true,qualification:'qualified'},
    decisionPosture:{status:value>0?'ready-for-owner-review':value<0?'deprioritise':'needs-more-evidence',
      verifiedContributionValue:value,reason:'Previously trusted legacy sum',readyToScale:true},
    evidenceVerified:true,financiallyQualified:true,qualified:true,verifiedContributionValue:value
  });
  const state=deepFreeze({workspace:{id:'tenant-history'},economics:{},orders:[],revenueEngine:{
    workspace_id:'tenant-history',experiments,updatedAt:'2026-09-30T12:00:00.000Z'}});
  const before=structuredClone(state);
  const snapshot=revenueEngineSnapshot(state);
  assert.deepEqual(state,before);
  assert.notEqual(snapshot.experiments,state.revenueEngine.experiments);
  for(const [index,row] of snapshot.experiments.entries()) {
    const stored=state.revenueEngine.experiments[index];
    assert.notEqual(row,stored);
    assert.notEqual(row.impact,stored.impact);
    assert.equal(row.impact.incrementalContribution,stored.impact.incrementalContribution);
    for(const field of ['incrementalRevenue','contributionProtected','costAvoided','minutesSaved','method','measuredAt','recordedBy','verified','status','verifiedAt','verifiedBy','verificationNote']) assert.equal(row.impact[field],stored.impact[field]);
    assert.deepEqual(row.outcomeMeasurement,stored.outcomeMeasurement);
    assert.equal(row.impact.legacyReviewed,true);
    assert.equal(row.impact.financiallyQualified,false);
    assert.equal(row.impact.qualified,false);
    assert.equal(row.impact.qualification,'legacy_unqualified');
    assert.equal(row.evidenceVerified,false);
    assert.equal(row.financiallyQualified,false);
    assert.equal(row.qualified,false);
    assert.equal(row.legacyReviewRecorded,true);
    assert.equal(row.evidenceQualification,'legacy_unqualified');
    assert.equal(row.verifiedContributionValue,null);
    assert.equal(row.decisionPosture.status,'needs-more-evidence');
    assert.equal(row.decisionPosture.verifiedContributionValue,null);
    assert.equal(row.decisionPosture.financiallyQualified,false);
    assert.equal(row.decisionPosture.readyToScale,undefined);
    assert.equal(row.decisionPosture.reason.includes('Previously trusted'),false);
  }
});

test('raw snapshot leaves absent revenue storage untouched and never invents a legacy owner review', () => {
  const empty=deepFreeze({orders:[],economics:{}});
  assert.deepEqual(revenueEngineSnapshot(empty).experiments,[]);
  assert.equal(Object.hasOwn(empty,'revenueEngine'),false);
  const state=deepFreeze({orders:[],economics:{},revenueEngine:{experiments:[{
    id:'measured',status:'measured',impact:{verified:false,status:'measured',incrementalContribution:100},
    decisionPosture:{status:'ready-for-owner-review',verifiedContributionValue:100}
  }]}});
  const row=revenueEngineSnapshot(state).experiments[0];
  assert.equal(row.impact.verified,false);
  assert.equal(row.impact.legacyReviewed,false);
  assert.equal(row.legacyReviewRecorded,false);
  assert.equal(row.decisionPosture.status,'needs-more-evidence');
  assert.equal(row.verifiedContributionValue,null);
});

test('growth plans do not infer qualified impact, forecasts, GBP or ROI from legacy experiment review', () => {
  const baseline=deriveGrowthPlan({orders:[],economics:{}});
  const state={orders:[],economics:{},revenueEngine:{experiments:[75,0,-20].map(value=>({
    id:`legacy-${value}`,status:'completed',impact:{verified:true,status:'verified',incrementalContribution:value,incrementalRevenue:999999},
    decisionPosture:{status:'ready-for-owner-review',verifiedContributionValue:value}
  }))}};
  const result=deriveGrowthPlan(state);
  assert.deepEqual(result.opportunities,baseline.opportunities);
  assert.equal(result.opportunities.every(row=>row.estimatedImpact===null),true);
  assert.equal(/£|GBP|\bROI\b|ready-for-owner-review|deprioritise/.test(JSON.stringify(result)),false);
  assert.match(result.note,/Legacy experiment review does not establish qualified contribution or future benefit/);
});
