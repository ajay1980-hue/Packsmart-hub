import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCustomerIntelligence, deriveAttribution, deriveBasketIntelligence, deriveIntentRecovery, deriveSalesPipeline, deriveGrowthPlan, ensureRevenueEngine, createExperiment, recordExperimentMeasurement, verifyExperimentMeasurement } from '../lib/revenue-engine.mjs';

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


test('experiment lifecycle separates measurement from verification before learning or impact can trust it', () => {
  const state={workspace:{id:'tenant-loop'},economics:{},orders:[],revenueEngine:{}};
  const experiment=createExperiment(state,{kind:'retention',title:'Win-back test',hypothesis:'A targeted reminder improves contribution.'},'owner-1');
  assert.equal(experiment.status,'draft');
  assert.equal(experiment.externalWrites,false);

  const measured=recordExperimentMeasurement(state,experiment.id,{method:'holdout',incrementalRevenue:300,incrementalContribution:90},'analyst-1');
  assert.equal(measured.status,'measured');
  assert.equal(measured.impact.verified,false);
  assert.equal(measured.impact.incrementalContribution,90);

  const verified=verifyExperimentMeasurement(state,experiment.id,{note:'Matched holdout reviewed against settled orders.'},'owner-1');
  assert.equal(verified.status,'completed');
  assert.equal(verified.impact.verified,true);
  assert.equal(verified.impact.status,'verified');
  assert.equal(verified.impact.verifiedBy,'owner-1');
});

test('experiment verification requires a measured result and an explicit verification note', () => {
  const state={workspace:{id:'tenant-guard'},economics:{},orders:[],revenueEngine:{}};
  const experiment=createExperiment(state,{kind:'conversion',title:'Checkout recovery test'},'owner-1');
  assert.throws(()=>verifyExperimentMeasurement(state,experiment.id,{note:'too early'},'owner-1'),error=>error.code==='EXPERIMENT_NOT_MEASURED');
  recordExperimentMeasurement(state,experiment.id,{method:'before-after',incrementalContribution:15},'analyst-1');
  assert.throws(()=>verifyExperimentMeasurement(state,experiment.id,{},'owner-1'),error=>error.code==='VALIDATION_FAILED');
});
