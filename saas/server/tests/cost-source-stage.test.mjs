import test from 'node:test';
import assert from 'node:assert/strict';
import { COST_SOURCE_REVIEW_CONTRACT, createCostSourceStage, costSourceCreationEnabled, assertCostSourceCreation } from '../lib/cost-source-stage.mjs';
import { GOVERNED_RECORD_PRODUCER_CONTRACT } from '../lib/governed-record-stage.mjs';

test('source annotations have their own exact process-start contract and default closed admission', () => {
  for (const value of [undefined, null, true, false, 1, '', 'true', 'enabled', ` ${COST_SOURCE_REVIEW_CONTRACT}`,
    `${COST_SOURCE_REVIEW_CONTRACT}\n`, 'runvara-cost-source-reviews/v2', new String(COST_SOURCE_REVIEW_CONTRACT), {}]) {
    const stage = createCostSourceStage({ COST_SOURCE_REVIEW_CONTRACT: value, GOVERNED_RECORD_PRODUCER_CONTRACT });
    assert.equal(costSourceCreationEnabled(stage), false);
    assert.throws(() => assertCostSourceCreation(stage), { status: 503, code: 'COST_SOURCE_REVIEW_PAUSED', definitive: true });
  }
  const env = { COST_SOURCE_REVIEW_CONTRACT }, open = createCostSourceStage(env);
  assert.ok(Object.isFrozen(open)); assert.equal(costSourceCreationEnabled(open), true);
  env.COST_SOURCE_REVIEW_CONTRACT = '';
  assert.equal(costSourceCreationEnabled(open), true);
  assert.equal(costSourceCreationEnabled(createCostSourceStage(env)), false);
});

test('forged or inherited source stage never opens admission and configuration accessors do not execute', () => {
  const open = createCostSourceStage({ COST_SOURCE_REVIEW_CONTRACT });
  for (const stage of [{ enabled: true }, { ...open }, structuredClone(open), Object.create(open), null, undefined, new Proxy(open, {})]) {
    assert.equal(costSourceCreationEnabled(stage), false);
  }
  for (const env of [Object.create({ COST_SOURCE_REVIEW_CONTRACT }),
    { get COST_SOURCE_REVIEW_CONTRACT() { assert.fail('accessor'); } },
    new Proxy({}, { getOwnPropertyDescriptor() { assert.fail('proxy'); } })]) {
    assert.equal(costSourceCreationEnabled(createCostSourceStage(env)), false);
  }
});
