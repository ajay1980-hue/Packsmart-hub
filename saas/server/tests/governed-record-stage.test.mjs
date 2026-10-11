import test from 'node:test';
import assert from 'node:assert/strict';
import { createGovernedRecordStage, GOVERNED_RECORD_PRODUCER_CONTRACT,
  governedRecordCreationEnabled, assertGovernedRecordCreation,
  hasGovernedConnectionWriteMarkers } from '../lib/governed-record-stage.mjs';

const paused = { status: 503, code: 'GOVERNED_RECORDS_PAUSED' };
test('only the exact own process-start producer contract opens a trusted frozen stage', () => {
  for (const value of [undefined, null, false, true, 0, 1, '', 'true', 'enabled',
    ` ${GOVERNED_RECORD_PRODUCER_CONTRACT}`, `${GOVERNED_RECORD_PRODUCER_CONTRACT}\n`,
    'runvara-governed-record-producers/v2', new String(GOVERNED_RECORD_PRODUCER_CONTRACT), {}]) {
    const stage = createGovernedRecordStage({ GOVERNED_RECORD_PRODUCER_CONTRACT: value });
    assert.ok(Object.isFrozen(stage)); assert.equal(governedRecordCreationEnabled(stage), false);
    assert.throws(() => assertGovernedRecordCreation(stage), paused);
  }
  const env = { GOVERNED_RECORD_PRODUCER_CONTRACT }, stage = createGovernedRecordStage(env);
  assert.ok(Object.isFrozen(stage)); assert.equal(governedRecordCreationEnabled(stage), true);
  assert.doesNotThrow(() => assertGovernedRecordCreation(stage));
  env.GOVERNED_RECORD_PRODUCER_CONTRACT = 'closed';
  assert.equal(governedRecordCreationEnabled(stage), true, 'An admitted process is not a hot mutable switch');
  assert.equal(governedRecordCreationEnabled(createGovernedRecordStage(env)), false);
  const closed = createGovernedRecordStage(env); env.GOVERNED_RECORD_PRODUCER_CONTRACT = GOVERNED_RECORD_PRODUCER_CONTRACT;
  assert.equal(governedRecordCreationEnabled(closed), false);
});

test('missing, forged, cloned, inherited and accessor stages never confer admission', () => {
  const trusted = createGovernedRecordStage({ GOVERNED_RECORD_PRODUCER_CONTRACT });
  for (const forged of [undefined, null, true, GOVERNED_RECORD_PRODUCER_CONTRACT,
    { enabled: true }, Object.freeze({ enabled: true }), structuredClone(trusted), { ...trusted },
    Object.create(trusted), new Proxy(trusted, {})]) {
    assert.equal(governedRecordCreationEnabled(forged), false);
    assert.throws(() => assertGovernedRecordCreation(forged), paused);
  }
  for (const env of [undefined, null, false, Object.create({ GOVERNED_RECORD_PRODUCER_CONTRACT }),
    { get GOVERNED_RECORD_PRODUCER_CONTRACT() { assert.fail('Accessor must not be read'); } },
    new Proxy({}, { getOwnPropertyDescriptor() { assert.fail('Proxy must not be inspected'); } })]) {
    assert.equal(governedRecordCreationEnabled(createGovernedRecordStage(env)), false);
  }
});

test('governed marker classification uses presence without promoting malformed envelopes to ordinary writes', () => {
  assert.equal(hasGovernedConnectionWriteMarkers({}, {}), false);
  for (const value of [null, false, '', {}, { schema: 'unknown' }]) {
    assert.equal(hasGovernedConnectionWriteMarkers({ objectivePolicyProposal: value }, {}), true);
    assert.equal(hasGovernedConnectionWriteMarkers({}, { payload: { objectivePolicyProposalDigest: value } }), true);
  }
  assert.equal(hasGovernedConnectionWriteMarkers({}, { source: 'objective-content' }), true);
  assert.equal(hasGovernedConnectionWriteMarkers({ origin: 'owner_objective_content' }, {}), true);
  assert.equal(hasGovernedConnectionWriteMarkers({ get objectivePolicyProposal() { assert.fail('Envelope getter must not run'); } }, {}), true);
  assert.equal(hasGovernedConnectionWriteMarkers({}, { payload: new Proxy({}, { getOwnPropertyDescriptor() { assert.fail('Proxy must not run'); } }) }), true);
});
