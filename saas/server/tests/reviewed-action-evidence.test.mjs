import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewedActionFixture } from './reviewed-action-test-fixture.mjs';
import { canonicalReviewedActionJson, digestReviewedActionValue, validateReviewedSourceAction, resolveRecordedActionEvidence, REVIEWED_ACTION_MAX_BYTES, actionIntervention, validateActionSelection } from '../lib/reviewed-action-evidence.mjs';
import { prepareExperimentOutcomeMeasurement, validateExperimentOutcomeMeasurement } from '../lib/experiment-measurements.mjs';
const now = '2026-10-06T20:00:00.000Z';
const input = () => ({ expectedRevision: 0, amount: '10', currency: 'GBP', window: { startsAt: '2026-10-01T00:00:00.000Z', endsAt: '2026-10-06T00:00:00.000Z' },
  coverage: { status: 'complete', observedCount: 10, expectedCount: 10 }, method: { kind: 'before_after' }, observedAt: '2026-10-06T12:00:00.000Z', report: { description: 'Reconciled synthetic report', costsComplete: true } });
const context = { workspaceId: 'tenant-a', experimentId: 'experiment_1', actorId: 'user_owner', now, previousMeasurement: null };
const reversed = v => Array.isArray(v) ? v.map(reversed) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k,x]) => [k,reversed(x)])) : v;

test('exact source survives JSONB-style key order and records no duplicate action text or authority', () => {
  const f = reviewedActionFixture();
  assert.deepEqual(resolveRecordedActionEvidence(reversed(f.state), f.write.id), f.source);
  assert.equal(f.source.context.origin, 'owner_manual'); assert.equal(f.source.context.originatingObjective, null);
  assert.equal(f.source.context.acknowledged, undefined); assert.equal(f.source.context.input, undefined);
  assert.equal(f.write.recordedActionContext.snapshotDigest, f.source.digest);
  assert.equal(f.source.input.description, f.write.input.description);
  for (const secret of ['encryptedCredentials','accessToken','clientSecret']) assert.equal(JSON.stringify(f.source).includes(secret), false);
  const historical = structuredClone(f.source); delete f.state.connectionWrites; delete f.state.approvals;
  assert.deepEqual(validateReviewedSourceAction(historical, { workspaceId: 'tenant-a' }), historical);
});

test('legacy flags, forged context shapes, mismatched input/result/claim/decision/proposal and duplicates fail closed', () => {
  const mutations = [
    f => { delete f.write.recordedActionContext; }, f => { f.write.recordedActionContext = { acknowledged: true }; },
    f => { f.write.status = 'uncertain'; }, f => { f.write.status = 'processing'; }, f => { f.write.status = 'failed'; },
    f => { f.write.input.title = 'changed'; }, f => { f.write.result.externalId = 'gid://shopify/Product/99'; },
    f => { f.write.provider = 'meta'; }, f => { f.write.account = 'other.myshopify.com'; },
    f => { f.write.dispatchClaim.identity = 'c'.repeat(64); }, f => { f.write.dispatchClaim.id = 'different'; },
    f => { f.write.dispatchClaim.phases.shopify_mutation.requestDigest = 'd'.repeat(64); },
    f => { f.write.dispatchClaim.phases.shopify_mutation.at = '2027-01-01T00:00:00.000Z'; },
    f => { f.write.dispatchClaim.phases.extra = {}; }, f => { f.write.errorCode = 'WRITE_RESULT_UNKNOWN'; },
    f => { f.approval.revision = 0; }, f => { f.approval.decidedBy = 'another_owner'; }, f => { f.approval.status = 'rejected'; },
    f => { f.approval.payload.tenantId = 'foreign'; }, f => { f.state.approvals.push(structuredClone(f.approval)); },
    f => { f.state.connectionWrites.push(structuredClone(f.write)); }, f => { f.state.connections.push(structuredClone(f.state.connections[0])); },
    f => { f.write.objectivePolicyProposal = { fake: true }; }, f => { f.write.recordedActionContext.policies = [{ objectiveId:'fake',revision:1,digest:'a'.repeat(64) }]; },
    f => { f.write.recordedActionContext.tenant = { id:'foreign' }; }, f => { f.write.recordedActionContext.apiVersion = 'unstable'; }
  ];
  for (const mutate of mutations) { const f = reviewedActionFixture(); mutate(f); assert.throws(() => resolveRecordedActionEvidence(f.state, 'write_synthetic')); }
  // Even re-signing a source cannot mask mismatched dispatch/input fingerprint.
  const f = reviewedActionFixture(), forged = structuredClone(f.source); forged.context.dispatchRequestDigest = 'd'.repeat(64);
  forged.digest = digestReviewedActionValue(Object.fromEntries(Object.entries(forged).filter(([k]) => k !== 'digest')));
  assert.throws(() => validateReviewedSourceAction(forged, { workspaceId: 'tenant-a' }));
});

test('source has a concrete UTF8 bound without truncation, including escaped and multibyte maximum inputs', () => {
  const ascii = reviewedActionFixture({ description:'x'.repeat(10000) }); assert.equal(ascii.source.input.description.length, 10000);
  for (const description of ['雪'.repeat(10000),'\u0001'.repeat(10000)]) assert.throws(() => reviewedActionFixture({ description }), { code:'OUTCOME_ACTION_TOO_LARGE' });
  let lo=0, hi=10000;
  while (lo<hi) { const mid=Math.ceil((lo+hi)/2); try { reviewedActionFixture({ description:'雪'.repeat(mid) }); lo=mid; } catch { hi=mid-1; } }
  const exact = reviewedActionFixture({ description:'雪'.repeat(lo) });
  const bytes = Buffer.byteLength(canonicalReviewedActionJson(exact.source)); assert.ok(bytes <= REVIEWED_ACTION_MAX_BYTES && bytes > REVIEWED_ACTION_MAX_BYTES-3);
  assert.throws(() => reviewedActionFixture({ description:'雪'.repeat(lo+1) }), { code:'OUTCOME_ACTION_TOO_LARGE' });
});

test('v2 requires explicit resolved selection; binds intervention into report/envelope and removal advances revision', () => {
  const f=reviewedActionFixture(), body={...input(),actionSelection:{actionId:f.write.id}};
  assert.throws(() => prepareExperimentOutcomeMeasurement(body, context));
  assert.throws(() => prepareExperimentOutcomeMeasurement(input(), {...context,actionEvidence:f.source}));
  const m=prepareExperimentOutcomeMeasurement(body,{...context,actionEvidence:f.source});
  assert.equal(m.schema,'runvara-experiment-measurement/v2'); assert.equal(m.report.schema,'runvara-measurement-report/v2');
  assert.deepEqual(m.report.facts.intervention,m.intervention); assert.deepEqual(m.intervention,actionIntervention(f.source));
  assert.equal(m.links.objective,null); assert.equal(m.links.opportunity,null); assert.equal(m.intervention.comparison,'not_established');
  assert.deepEqual(validateExperimentOutcomeMeasurement(reversed(m),{workspaceId:'tenant-a',experimentId:'experiment_1',now}),m);
  assert.equal(JSON.stringify(m).includes(f.source.input.description),false);
  const changedSource=reviewedActionFixture({description:'Different recorded action body under reused ID'}).source;
  assert.throws(()=>prepareExperimentOutcomeMeasurement({...body,expectedRevision:1},{...context,previousMeasurement:m,actionEvidence:changedSource}),{code:'MEASUREMENT_ACTION_CONFLICT'});
  assert.throws(()=>prepareExperimentOutcomeMeasurement({...input(),expectedRevision:1},{...context,previousMeasurement:m}),{code:'MEASUREMENT_INVALID'});
  const removed=prepareExperimentOutcomeMeasurement({...input(),expectedRevision:1,actionSelection:null},{...context,previousMeasurement:m});
  assert.equal(removed.schema,'runvara-experiment-measurement/v1'); assert.equal(removed.revision,2); assert.notEqual(removed.digest,m.digest);
  assert.equal(removed.links.action,null);
  const reuseVersionId='outcome_version_'+'e'.repeat(64);
  const reuse=prepareExperimentOutcomeMeasurement({...input(),actionSelection:{reuseVersionId}},{...context,actionEvidence:f.source,reuseVersionId});
  assert.equal(reuse.intervention.reuseVersionId,reuseVersionId); assert.notEqual(reuse.digest,m.digest);
  for (const selection of [{actionId:f.write.id,digest:f.source.digest},{actionId:f.write.id,reuseVersionId},{workspaceId:'foreign'},{}]) assert.throws(()=>validateActionSelection(selection));
});


test('copied request and claim identities, changed request payload and accessor tenant markers are rejected', () => {
  for(const key of ['requestId','claimId']) {
    const f=reviewedActionFixture(), other=structuredClone(f.write); other.id='write_other';
    if(key==='requestId') other.dispatchClaim.id='claim_other'; else other.requestId='different_request_0001';
    f.state.connectionWrites.push(other); assert.throws(()=>resolveRecordedActionEvidence(f.state,f.write.id));
  }
  const f=reviewedActionFixture(); let invoked=false;
  Object.defineProperty(f.write,'tenantId',{enumerable:true,get(){invoked=true; return 'foreign';}});
  assert.throws(()=>resolveRecordedActionEvidence(f.state,f.write.id)); assert.equal(invoked,false);
  const nested=reviewedActionFixture(); nested.write.workspace={};
  Object.defineProperty(nested.write.workspace,'id',{enumerable:true,get(){invoked=true;return 'tenant-a';}});
  assert.throws(()=>resolveRecordedActionEvidence(nested.state,nested.write.id)); assert.equal(invoked,false);
  const changed=reviewedActionFixture(), c=changed.write.recordedActionContext;
  changed.write.requestId='changed_request_0001'; c.requestId=changed.write.requestId;
  const source={schema:changed.source.schema,revision:1,context:Object.fromEntries(Object.entries(c).filter(([k])=>k!=='snapshotDigest')),input:changed.write.input};
  c.snapshotDigest=digestReviewedActionValue(source);
  assert.throws(()=>resolveRecordedActionEvidence(changed.state,changed.write.id),'source re-signing cannot retain an old claim identity for a changed request');
});


test('measurement schema dispatch rejects computed fields without executing their getter', () => {
  const f=reviewedActionFixture(), m=prepareExperimentOutcomeMeasurement({...input(),actionSelection:{actionId:f.write.id}},{...context,actionEvidence:f.source});
  let executed=false;
  Object.defineProperty(m,'schema',{enumerable:true,get(){executed=true;return 'runvara-experiment-measurement/v2';}});
  assert.throws(()=>validateExperimentOutcomeMeasurement(m,{workspaceId:'tenant-a',experimentId:'experiment_1',now}));
  assert.equal(executed,false);
});
