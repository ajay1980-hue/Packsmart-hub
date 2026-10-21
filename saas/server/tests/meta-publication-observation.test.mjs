import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { observationFixture } from './meta-publication-observation-fixture.mjs';
import { metaPublicationObservations, createMetaObservationSimulation, appendMetaObservation, validateMetaObservation, META_OBSERVATION_READ_MAX } from '../lib/meta-publication-observation.mjs';
const read = f => metaPublicationObservations(f.observationStore, f.writeId, f.session);
const capture = (f, capability = f.simulation(), requestId = randomUUID()) => metaPublicationObservations(f.observationStore, f.writeId, f.session, { capability, requestId });

test('pure history reads retain nothing and never call a provider or mutation adapter', async t => {
  const f = await observationFixture(t), before = await f.get();
  const result = await read(f); assert.equal(result.captureAvailable, false); assert.deepEqual(result.observations, []);
  assert.equal(result.resultId, null); assert.equal(result.replayPermitted, false); assert.deepEqual(await f.get(), before);
  assert.ok(f.calls.every(call => call.operation === 'state_read'));
  assert.ok(f.calls.find(call => call.path.endsWith('observations')).settings.maxResponseBytes === META_OBSERVATION_READ_MAX);
});
for (const status of ['PUBLISHED','FINISHED','IN_PROGRESS','ERROR','EXPIRED']) test(status + ' retains a separate simulated observation without settling or resending the original write', async t => {
  const f = await observationFixture(t), before = await f.get(), requestId = randomUUID();
  const result = await capture(f, f.simulation(status), requestId);
  assert.equal(result.observations.length, 1); const row = result.observations[0];
  assert.equal(row.statusCode, status); assert.equal(row.resultId, null); assert.equal(row.outcome, 'unresolved_do_not_resend');
  assert.equal(row.simulated, true); assert.equal(row.providerReadPerformed, false); assert.equal(row.replayPermitted, false);
  assert.deepEqual(await f.get(), before); assert.equal(f.executions[0].simulation.observations().length, 2);
  assert.deepEqual((await read(f)).observations, result.observations);
  await capture(f, f.simulation(status), requestId); assert.equal(f.observations.length, 1);
});
test('a new simulator instance and fresh history read do not depend on the old dispatch capability', async t => {
  const f = await observationFixture(t); const first = await capture(f);
  const second = await capture(f, f.simulation('ERROR'));
  assert.equal(second.observations.length, 2); assert.notEqual(second.observations[0].digest, second.observations[1].digest);
  assert.deepEqual(second.observations[0], first.observations[0]); assert.equal(second.outcome, 'unresolved_do_not_resend');
});
test('lost container response stays unresolved with no guessed observation target', async t => {
  const f = await observationFixture(t, { phase: 'instagram_container' });
  const result = await read(f); assert.equal(result.anchor, null); assert.deepEqual(result.observations, []);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].operation, 'state_read');
});
test('plain/cloned capabilities, scope overrides, unknown statuses and media IDs are rejected', async t => {
  const f = await observationFixture(t);
  for (const capability of [{}, structuredClone(f.simulation()), null]) await assert.rejects(capture(f, capability), { code: 'META_OBSERVATION_PRODUCTION_CLOSED' });
  for (const response of [{ id: '999', status_code: 'PUBLISHED' }, { id: f.anchor.containerId, status_code: 'OTHER' },
    { id: f.anchor.containerId, status_code: 'PUBLISHED', media_id: '900000002' }]) assert.throws(() => createMetaObservationSimulation([{ anchor: f.anchor, response }]));
  const foreign = createMetaObservationSimulation([{ anchor: { ...f.anchor, instagramId: '999' }, response: { id: f.anchor.containerId, status_code: 'PUBLISHED' } }]);
  await assert.rejects(capture(f, foreign), { code: 'META_OBSERVATION_PRODUCTION_CLOSED' }); assert.equal(f.observations.length, 0);
});
for (const phase of ['receipt','observations']) test('fresh authority reload detects owner revocation during ' + phase + ' read', async t => {
  const f = await observationFixture(t); let changed = false;
  f.controls.after = async path => { if (!changed && path.endsWith(phase)) { changed = true; await f.change(s => { s.users[0].role = 'member'; }); } };
  await assert.rejects(capture(f)); assert.ok(changed); assert.equal(f.observations.length, 0);
});
test('session rotation, disabled owners and foreign workspaces cannot read retained observations', async t => {
  const f = await observationFixture(t); await capture(f);
  await f.change(s => { s.users[0].sessionVersion = 2; }); await assert.rejects(read(f));
  await f.change(s => { s.users[0].sessionVersion = 1; s.users[0].active = false; }); await assert.rejects(read(f));
  await assert.rejects(metaPublicationObservations(f.observationStore, f.writeId, { ...f.session, workspaceId: 'other' }));
});
test('append acknowledgement loss uses one exact read and no append retry', async t => {
  const f = await observationFixture(t); f.controls.after = path => { if (path.endsWith('append_meta_observation')) throw Error('synthetic reply lost'); };
  const result = await capture(f); assert.equal(result.observations.length, 1);
  assert.equal(f.calls.filter(call => call.operation === 'state_commit').length, 1);
});
test('failed recovery preserves unknown commit without repeating append', async t => {
  const f = await observationFixture(t); f.controls.after = path => { if (path.endsWith('append_meta_observation')) { f.observations.length = 0; throw Error('lost'); } };
  await assert.rejects(capture(f), { code: 'META_OBSERVATION_COMMIT_UNKNOWN' });
  assert.equal(f.calls.filter(call => call.operation === 'state_commit').length, 1);
});
test('retention cap stops before append and serialized descriptors cannot select the write RPC', async t => {
  const f = await observationFixture(t); for (let i = 0; i < 8; i++) await capture(f);
  await assert.rejects(capture(f), { code: 'META_OBSERVATION_CAPACITY_OR_MODE' }); assert.equal(f.observations.length, 8);
  const calls = f.calls.length;
  await assert.rejects(appendMetaObservation(f.request, f.workspaceId, f.writeId, f.session, f.observations[0], f.anchor));
  assert.equal(f.calls.length, calls);
});
test('tampered, cross-admission and duplicate retained rows fail closed', async t => {
  const f = await observationFixture(t); await capture(f); const original = structuredClone(f.observations[0]);
  f.observations.push(original); await assert.rejects(read(f)); f.observations.pop();
  f.observations[0].digest = '0'.repeat(64); await assert.rejects(read(f));
  assert.throws(() => validateMetaObservation(original, { ...f.anchor, receiptDigest: 'b'.repeat(64) }));
});

for (const [key,value] of [['disabled',true],['disabled','true'],['active','false'],['status','disabled']]) {
  for (const phase of ['runvara_read_meta_observations','runvara_append_meta_observation']) test('fresh '+key+'='+value+' revocation after '+phase+' prevents disclosure',async t=>{
    const f=await observationFixture(t);let changed=false;
    f.controls.after=async path=>{if(!changed&&path.endsWith(phase)){changed=true;await f.change(s=>{s.users[0][key]=value;});}};
    await assert.rejects(capture(f));assert.ok(changed);
    assert.equal(f.observations.length,phase.endsWith('append_meta_observation')?1:0);
  });
}
