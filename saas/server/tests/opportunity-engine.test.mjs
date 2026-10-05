import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveOpportunityQueue, scoreOpportunity } from '../lib/opportunity-engine.mjs';

test('opportunity scoring ranks verified contribution profit after confidence probability risk and cost', () => {
  const strong = scoreOpportunity({ expectedContributionProfit:1000, confidence:0.8, probability:0.75, risk:0.1, executionCost:50 });
  assert.equal(strong.score, 490);
  assert.equal(strong.economicEvidenceComplete, true);

  const unknown = scoreOpportunity({ expectedContributionProfit:null, confidence:'high', probability:1, risk:'low' });
  assert.equal(unknown.score, null);
  assert.equal(unknown.economicEvidenceComplete, false);
  assert.ok(unknown.needsEvidence.includes('expectedContributionProfit'));
});

test('opportunity queue never fabricates pounds for incomplete cost, margin or stock recommendations', () => {
  const businessState = {
    workspaceId:'tenant-a',
    generatedAt:'2026-10-05T15:00:00.000Z',
    profitability:{
      missingCostVariants:2,
      lossMaking:[{sku:'LOSS-1', contribution:-2.5}]
    },
    inventory:{risks:[{sku:'LOW-1',inventory:1}]},
    recommendations:[{id:'open-orders',title:'Check open orders',detail:'Review fulfilment.',actionType:'safe',view:'orders'}]
  };
  const queue = deriveOpportunityQueue(businessState);
  assert.equal(queue.workspaceId,'tenant-a');
  assert.equal(queue.summary.total,4);
  assert.equal(queue.summary.economicallyScored,0);
  assert.equal(queue.summary.awaitingEconomicEvidence,4);
  assert.ok(queue.opportunities.every(item => item.score === null));
  assert.ok(queue.opportunities.every(item => item.expectedContributionProfit === null));
  assert.equal(queue.safeguards.unknownProfitRanksAsMoney,false);
});

test('verified opportunities outrank unpriced ideas without crossing tenant scope', () => {
  const verified = scoreOpportunity({id:'verified',title:'Verified',expectedContributionProfit:500,confidence:'medium',probability:.8,risk:'low',executionCost:10});
  const base = {
    workspaceId:'tenant-b',
    generatedAt:'2026-10-05T15:00:00.000Z',
    profitability:{missingCostVariants:1,lossMaking:[]},
    inventory:{risks:[]},
    recommendations:[]
  };
  const queue = deriveOpportunityQueue(base);
  const ranked = [verified,...queue.opportunities].sort((a,b)=>(b.score ?? -1)-(a.score ?? -1));
  assert.equal(ranked[0].id,'verified');
  assert.equal(queue.safeguards.tenantScope,'tenant-b');
  assert.equal(JSON.stringify(queue).includes('tenant-a'),false);
});
