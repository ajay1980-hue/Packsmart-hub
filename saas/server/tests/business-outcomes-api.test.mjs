/** HTTP/auth/DTO regression tests. The synthetic transport below uses the real
 * preparation and publication validators. It is not evidence of database
 * durability; the separate actual-PostgreSQL gate covers transactions/locks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPacksmartServer } from '../server.mjs';
import { seedWorkspaceState, createStore } from '../lib/store.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { createBusinessOutcomePersistence } from '../lib/business-outcome-store.mjs';
import { prepareExperimentOutcomeMeasurement, validateExperimentOutcomeMeasurement, assessExperimentOutcomeMeasurement, digestMeasurementValue } from '../lib/experiment-measurements.mjs';
import { createBusinessOutcomeCandidate, correctBusinessOutcomeCandidate, withdrawBusinessOutcomeCandidate } from '../lib/business-outcomes.mjs';
import { reviewedActionFixture } from './reviewed-action-test-fixture.mjs';
import { resolveRecordedActionEvidence, REVIEWED_ACTION_CONTRACT } from '../lib/reviewed-action-evidence.mjs';
import { evidenceInWorkspace } from '../lib/business-evidence-scope.mjs';

import { BASE, EXPERIMENT, REVIEW, MEASURE, SECRET, sqlError, measurementInput, fixture } from './business-outcomes-api-fixture.mjs';

function assertError(result, status, code) { assert.equal(result.status,status,JSON.stringify(result.body)); if (code) assert.equal(result.body.code,code); }

test('summary, review and exact evidence use compact auth/reads without whole state, mutations or provider calls', async t => {
  const f = await fixture(t, { published: true });
  f.store.get = async () => assert.fail('Read-only outcome route downloaded full workspace');
  const versionId = f.initialPublication.publication.head.versionId;
  for (const route of [BASE, REVIEW, `${BASE}/versions/${versionId}`]) {
    const result = await f.request(route); assert.equal(result.status,200,JSON.stringify(result.body)); assert.ok(result.bytes < 32768);
    assert.ok(!JSON.stringify(result.body).includes('never-download-the-whole-workspace'));
    assert.equal(result.headers.get('cache-control'),'no-store');
    if (route === REVIEW) {
      const { relationships, ...original } = result.body;
      assert.equal(relationships.schema, 'runvara-selected-outcome-relationships/v1');
      assert.equal(relationships.publication.versionDigest, result.body.currentPublication.version.digest);
      assert.equal(relationships.publication.draftDigest, result.body.measurement.digest);
      assert.equal(relationships.nodes.length, 2); assert.equal(relationships.edges.length, 1);
      assert.equal(relationships.coverage.wholeGraphSynchronized, false);
      assert.ok(result.bytes - Buffer.byteLength(JSON.stringify(original)) <= 4096);
    } else assert.equal(Object.hasOwn(result.body, 'relationships'), false, 'overview and historical reads never inherit selected proof');
  }
  assert.equal(f.counts.identities,3); assert.equal(f.calls.length,3); assert.equal(f.counts.saves,0); assert.equal(f.counts.providerCalls,0);
  assert.equal(f.calls[0].options.maxResponseBytes,2*1024*1024); assert.equal(f.calls[0].options.headers.Prefer,'count=exact');
  assert.match(f.calls[0].path,/limit=51/); assert.equal(f.calls[1].path,'rpc/runvara_read_outcome_content_sources');
  assert.equal(f.calls[1].options.maxResponseBytes,128*1024); assert.match(f.calls[2].path,/limit=2/);
  assert.deepEqual(JSON.parse(f.calls[1].options.body),{p_workspace_id:'outcome-alpha',p_experiment_id:EXPERIMENT,p_actor_id:f.states.get('outcome-alpha').users[0].id,p_actor_session_version:1,p_receipt_selector:null,p_after_attempt_id:null,p_resolve_saved_source:true});
});

test('HTTP authentication, CSRF and roles distinguish review/draft from owner-only publication', async t => {
  const f = await fixture(t,{published:true}); const input = f.publicationInput();
  for (const route of [BASE,REVIEW,`${BASE}/versions/outcome_version_${'a'.repeat(64)}`]) assertError(await f.request(route,{identity:null}),401,'AUTH_REQUIRED');
  assertError(await f.request(MEASURE,{method:'PUT',body:measurementInput(1),csrf:false}),403,'CSRF_INVALID');
  assertError(await f.request(`${BASE}/publish`,{method:'POST',body:input,csrf:false}),403,'CSRF_INVALID');
  for (const role of ['member','viewer']) {
    assertError(await f.request(REVIEW,{identity:f.auth('outcome-alpha',role)}),403,'ROLE_DENIED');
    assertError(await f.request(MEASURE,{method:'PUT',body:measurementInput(1),identity:f.auth('outcome-alpha',role)}),403,'ROLE_DENIED');
  }
  assertError(await f.request(`${BASE}/publish`,{method:'POST',body:input,identity:f.auth('outcome-alpha','admin')}),403,'OWNER_APPROVAL_REQUIRED');
  assert.equal((await f.request(REVIEW,{identity:f.auth('outcome-alpha','admin')})).status,200);
  assert.equal((await f.request(BASE,{identity:f.auth('outcome-alpha','viewer')})).status,200,'Existing readers may inspect qualified evidence');
  assert.equal((await f.request(`${BASE}/versions/${f.initialPublication.publication.head.versionId}`,{identity:f.auth('outcome-alpha','viewer')})).status,200);
  assert.equal(f.counts.saves,0); assert.equal(f.calls.filter(x=>x.path==='rpc/runvara_publish_business_outcome').length,0);
});

test('owner/admin draft recording uses fresh state and preserves legacy verified impact', async t => {
  const f = await fixture(t,{measured:false}), s = f.states.get('outcome-alpha'), legacy = structuredClone(s.revenueEngine.experiments[0].impact);
  const result = await f.request(MEASURE,{method:'PUT',body:measurementInput(),identity:f.auth('outcome-alpha','admin')});
  assert.equal(result.status,200,JSON.stringify(result.body)); assert.equal(result.body.measurement.revision,1); assert.equal(result.body.measurement.amount,'10.25');
  assert.equal(result.body.measurement.recordedBy,'outcome-alpha-admin'); assert.equal(result.body.assessment.publicationAuthority,false);
  const saved = f.states.get('outcome-alpha'); assert.deepEqual(saved.revenueEngine.experiments[0].impact,legacy);
  assert.equal(saved.revenueEngine.experiments[0].currentOutcome,undefined); assert.equal(f.rows.size,0);
  assert.equal(f.counts.gets,1); assert.equal(f.counts.saves,1); assert.equal(f.calls.length,0);
  assert.equal(result.body.workspaceRevision,saved._revision); assert.equal(f.counts.providerCalls,0);
  assertError(await f.request(MEASURE,{method:'PUT',body:measurementInput()}),409,'MEASUREMENT_CONFLICT');
  assert.equal(f.counts.saves,1,'Stale measurement input must not trigger save');
});

test('publication binds authenticated owner/tenant and never follows receipt with generic save', async t => {
  const f = await fixture(t), input = f.publicationInput(); f.store.get = async () => assert.fail('Publication loaded full workspace');
  f.store.save = async () => assert.fail('Publication was followed by generic save');
  const first = await f.request(`${BASE}/publish`,{method:'POST',body:input}); assert.equal(first.status,200,JSON.stringify(first.body));
  assert.equal(first.body.publication.version.amount,'10.25'); assert.equal(first.body.publication.version.publicationAuthority,false);
  assert.equal(first.body.replayed,false); assert.equal(f.calls.length,1); assert.equal(f.counts.identities,1);
  const params = JSON.parse(f.calls[0].options.body); assert.equal(params.p_workspace_id,'outcome-alpha'); assert.equal(params.p_actor_id,f.states.get('outcome-alpha').users[0].id); assert.equal(params.p_actor_session_version,1);
  assert.deepEqual(f.invalidations,['outcome-alpha']); assert.equal(f.counts.providerCalls,0);
});

test('stale reviewed workspace/source/head preconditions remain conflicts with no generic save or retry', async t => {
  for (const [patch, code] of [
    [{expectedWorkspaceRevision:'stale-revision'},'OUTCOME_WORKSPACE_CONFLICT'],
    [{expectedMeasurementDigest:'a'.repeat(64)},'OUTCOME_MEASUREMENT_CONFLICT'],
    [{action:'correct',expectedHeadVersionId:'outcome_version_'+ 'b'.repeat(64),expectedHeadDigest:'c'.repeat(64)},'OUTCOME_HEAD_CONFLICT']
  ]) {
    const f = await fixture(t), before = structuredClone(f.states.get('outcome-alpha'));
    assertError(await f.request(`${BASE}/publish`,{method:'POST',body:{...f.publicationInput(),...patch}}),409,code);
    assert.equal(f.calls.length,1); assert.equal(f.counts.gets,0); assert.equal(f.counts.saves,0); assert.equal(f.rows.size,0);
    assert.deepEqual(f.states.get('outcome-alpha'),before);
  }
});

test('uncertain or malformed publication receipt is surfaced once without automatic replay or leaked bodies', async t => {
  for (const malformed of [false,true]) {
    const f = await fixture(t);
    f.hooks.transport = async () => { if (malformed) return { publicationAuthority:true,secret:'private upstream body' }; throw new Error('private upstream body'); };
    const result = await f.request(`${BASE}/publish`,{method:'POST',body:f.publicationInput()});
    assertError(result,503,'OUTCOME_PUBLICATION_UNCERTAIN'); assert.equal(f.calls.length,1); assert.equal(f.counts.gets,0); assert.equal(f.counts.saves,0);
    assert.equal(f.invalidations.length,1); assert.ok(!JSON.stringify(result.body).includes('private upstream'));
  }
});

test('tenant/query overrides are rejected and exact version reads stay in the authenticated tenant', async t => {
  const f = await fixture(t,{published:true}), version = f.initialPublication.publication.head.versionId;
  for (const route of [BASE+'?workspaceId=outcome-beta',REVIEW+'?tenantId=outcome-beta',`${BASE}/versions/${version}?select=*`,BASE+'?cursor=next',REVIEW+'?workspaceId=outcome-alpha&workspaceId=outcome-beta']) {
    assertError(await f.request(route),400,'OUTCOME_REQUEST_INVALID');
  }
  assert.equal(f.calls.length,0);
  const foreign = await f.request(`${BASE}/versions/${version}`,{identity:f.auth('outcome-beta')}); assertError(foreign,404,'OUTCOME_VERSION_NOT_FOUND');
  assert.match(f.calls.at(-1).path,/workspace_id=eq.outcome-beta/);
  const review = await f.request(REVIEW,{identity:f.auth('outcome-beta')}); assert.equal(review.status,200); assert.equal(review.body.workspaceId,'outcome-beta'); assert.equal(review.body.measurement.workspaceId,'outcome-beta'); assert.equal(review.body.currentPublication,null);
  const summary = await f.request(BASE,{identity:f.auth('outcome-beta')}); assert.equal(summary.status,200); assert.deepEqual(summary.body.current,[]); assert.equal(summary.body.summary.overallAmount,null);
  assert.equal(f.counts.gets,0); assert.equal(f.counts.saves,0);
});

test('server-authored measurement fields and publication authority cannot be supplied in HTTP bodies', async t => {
  for (const extra of [{workspaceId:'outcome-beta'},{actorId:'someone_else'},{recordedAt:new Date().toISOString()},{digest:'a'.repeat(64)},
    {provenance:{sourceRefs:[]}},{links:{action:null}},{verification:{kind:'owner_attestation'}},{publicationAuthority:true}]) {
    const f = await fixture(t); const before = structuredClone(f.states.get('outcome-alpha'));
    assertError(await f.request(MEASURE,{method:'PUT',body:{...measurementInput(1),...extra}}),400);
    assert.equal(f.counts.saves,0); assert.deepEqual(f.states.get('outcome-alpha'),before);
  }
  for (const extra of [{workspaceId:'outcome-beta'},{actorId:'someone_else'},{sessionVersion:999},{amount:'999999'},{verified:true},{candidate:{}},{head:{}},{publicationAuthority:true}]) {
    const f = await fixture(t);
    assertError(await f.request(`${BASE}/publish`,{method:'POST',body:{...f.publicationInput(),...extra}}),400,'OUTCOME_REQUEST_INVALID');
    assert.equal(f.calls.length,0); assert.equal(f.counts.gets,0); assert.equal(f.counts.saves,0);
  }
});

test('malformed, duplicate and explicitly foreign experiment records cannot be changed', async t => {
  for (const mutate of [
    s => { s.revenueEngine.experiments = {}; }, s => { s.revenueEngine.experiments = []; },
    s => { s.revenueEngine.experiments.push(structuredClone(s.revenueEngine.experiments[0])); },
    s => { s.revenueEngine.experiments[0].workspaceId = 'outcome-beta'; }, s => { s.revenueEngine.tenantId = 'outcome-beta'; },
    s => { s.workspace.tenant_id = 'outcome-beta'; }, s => { s.tenantId = 'outcome-beta'; },
    s => { s.users.push(structuredClone(s.users[0])); }, s => { s.users[0].workspaceId = 'outcome-beta'; }
  ]) {
    const f = await fixture(t); mutate(f.states.get('outcome-alpha')); const before = structuredClone(f.states.get('outcome-alpha'));
    assertError(await f.request(MEASURE,{method:'PUT',body:measurementInput(1)}),404,'OUTCOME_SOURCE_NOT_FOUND');
    assert.equal(f.counts.saves,0); assert.deepEqual(f.states.get('outcome-alpha'),before);
  }
  const f = await fixture(t); f.states.get('outcome-alpha').revenueEngine.experiments[0].outcomeMeasurement.report.facts.amount = '100';
  assertError(await f.request(MEASURE,{method:'PUT',body:measurementInput(1)}),409,'MEASUREMENT_INTEGRITY_FAILED'); assert.equal(f.counts.saves,0);
});

test('raw persisted foreign engine markers survive store upgrade and block preparation without any save', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'runvara-outcome-raw-api-')), file = path.join(dir,'state.json');
  const state = seedWorkspaceState({}, {workspaceId:'outcome-raw',email:'raw@example.test',passwordHash:'synthetic-only'});
  state._revision = randomUUID(); state.users[0].passwordChangeRequired = false;
  state.revenueEngine.tenantId = 'tenant-b';
  state.revenueEngine.experiments = [{id:EXPERIMENT,title:'Foreign source',status:'draft',impact:{verified:true,incrementalContribution:200}}];
  const original = JSON.stringify({'outcome-raw':state}); await fs.writeFile(file,original);
  const store = createStore({SAAS_STATE_FILE:file}), save = store.save.bind(store); let saves = 0;
  store.save = async (...args) => { saves++; return save(...args); };
  const server = createPacksmartServer({NODE_ENV:'test',SESSION_SECRET:SECRET,CREDENTIALS_KEY:SECRET,SHOPIFY_PUBLIC_SYNC_ENABLED:'false'}, {store,schedulerEnabled:false,agentOpsEnabled:false,fetchImpl:async()=>assert.fail('No provider network is allowed')});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{await server.packsmart.drain();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});});
  const user = state.users[0], token = createSessionToken({userId:user.id,workspaceId:'outcome-raw',email:user.email,role:user.role,sessionVersion:1},SECRET);
  const response = await fetch(`http://127.0.0.1:${server.address().port}${MEASURE}`,{method:'PUT',headers:{Cookie:`packsmart_session=${token}`,'X-CSRF-Token':verifySessionToken(token,SECRET).csrf,'Content-Type':'application/json'},body:JSON.stringify(measurementInput())});
  assert.equal(response.status,404,JSON.stringify(await response.clone().json())); assert.equal((await response.json()).code,'OUTCOME_SOURCE_NOT_FOUND');
  assert.equal(saves,0); assert.equal(await fs.readFile(file,'utf8'),original);
  assert.equal((await store.get('outcome-raw')).revenueEngine.tenantId,'tenant-b');
  // Actual FileStore must expose explicit unavailability for durable outcomes.
  for (const route of [BASE,REVIEW,`${BASE}/versions/outcome_version_${'a'.repeat(64)}`]) {
    const unavailable = await fetch(`http://127.0.0.1:${server.address().port}${route}`,{headers:{Cookie:`packsmart_session=${token}`}});
    assert.equal(unavailable.status,503); const body = await unavailable.json(); assert.equal(body.code,'OUTCOME_STORAGE_UNAVAILABLE'); assert.equal(body.summary,undefined);
  }
  assert.equal(saves,0); assert.equal(await fs.readFile(file,'utf8'),original);
});

test('actor role/activity/session changes between compact authentication and preparation fail fresh validation', async t => {
  for (const patch of [{role:'member'},{active:false},{sessionVersion:2}]) {
    const f = await fixture(t), identity = f.auth(); f.hooks.afterIdentity = () => Object.assign(f.states.get('outcome-alpha').users[0],patch);
    assertError(await f.request(MEASURE,{method:'PUT',body:measurementInput(1),identity}),401,'SESSION_INVALID'); assert.equal(f.counts.saves,0);
  }
  const f = await fixture(t), identity = f.auth(); f.hooks.afterIdentity = () => { f.states.get('outcome-alpha').users[0].passwordChangeRequired = true; };
  assertError(await f.request(MEASURE,{method:'PUT',body:measurementInput(1),identity}),404,'OUTCOME_SOURCE_NOT_FOUND'); assert.equal(f.counts.saves,0);
});

test('publication passes the original authenticated session to atomic validation after identity changes', async t => {
  for (const patch of [{role:'admin'},{active:false},{sessionVersion:2},{passwordChangeRequired:true}]) {
    const f = await fixture(t), identity = f.auth(), input = f.publicationInput();
    f.hooks.afterIdentity = () => Object.assign(f.states.get('outcome-alpha').users[0],patch);
    assertError(await f.request(`${BASE}/publish`,{method:'POST',body:input,identity}),403,'OUTCOME_OWNER_SESSION_CHANGED');
    assert.equal(f.calls.length,1); assert.equal(JSON.parse(f.calls[0].options.body).p_actor_session_version,1);
    assert.equal(f.counts.gets,0); assert.equal(f.counts.saves,0); assert.equal(f.rows.size,0);
  }
});

test('invalid sessions and password-change-required users are denied before outcome storage', async t => {
  const f = await fixture(t), identity = f.auth(); f.states.get('outcome-alpha').users[0].sessionVersion = 2;
  assertError(await f.request(BASE,{identity}),401,'SESSION_INVALID'); assert.equal(f.calls.length,0);
  f.states.get('outcome-alpha').users[0].sessionVersion = 1; f.states.get('outcome-alpha').users[0].passwordChangeRequired = true;
  for (const route of [BASE,REVIEW]) assertError(await f.request(route,{identity}),403,'PASSWORD_CHANGE_REQUIRED');
  assertError(await f.request(`${BASE}/publish`,{method:'POST',body:f.publicationInput(),identity}),403,'PASSWORD_CHANGE_REQUIRED'); assert.equal(f.calls.length,0);
});

test('malformed/big input bodies and hostile origins stop before draft saves or publication requests', async t => {
  const f = await fixture(t);
  assertError(await f.request(MEASURE,{method:'PUT',rawBody:'[]'}),400,'JSON_INVALID');
  assertError(await f.request(MEASURE,{method:'PUT',rawBody:'{"__proto__":{}}'}),400,'JSON_INVALID');
  assertError(await f.request(MEASURE,{method:'PUT',body:{padding:'x'.repeat(17000)}}),413,'REQUEST_TOO_LARGE');
  assertError(await f.request(`${BASE}/publish`,{method:'POST',body:{padding:'x'.repeat(4200)}}),413,'REQUEST_TOO_LARGE');
  assertError(await f.request(`${BASE}/publish`,{method:'POST',body:f.publicationInput(),origin:'https://foreign.example'}),403,'ORIGIN_DENIED');
  assert.equal(f.counts.saves,0); assert.equal(f.calls.length,0);
});

test('incomplete measured drafts preserve unknown values and never publish from legacy verification', async t => {
  const f = await fixture(t,{measured:false});
  const input = measurementInput(); input.amount = null; input.currency = null; input.report.costsComplete = false;
  const drafted = await f.request(MEASURE,{method:'PUT',body:input}); assert.equal(drafted.status,200);
  assert.equal(drafted.body.measurement.amount,null); assert.equal(drafted.body.measurement.currency,null); assert.equal(drafted.body.assessment.measurementComplete,false);
  assertError(await f.request(`${BASE}/publish`,{method:'POST',body:f.publicationInput()}),409,'OUTCOME_MEASUREMENT_INCOMPLETE');
  const summary = await f.request(BASE); assert.equal(summary.status,200); assert.deepEqual(summary.body.current,[]);
  assert.deepEqual(summary.body.summary.groups,[]); assert.equal(summary.body.summary.overallAmount,null); assert.equal(summary.body.summary.roi,null);
  assert.equal(f.states.get('outcome-alpha').revenueEngine.experiments[0].impact.verified,true);
});

test('missing storage and invalid/oversized read envelopes are unavailable, never invented zero evidence', async t => {
  for (const route of [BASE,REVIEW,`${BASE}/versions/outcome_version_${'a'.repeat(64)}`]) {
    const f = await fixture(t); f.hooks.transport = async () => { throw sqlError('42P01'); };
    assertError(await f.request(route),503,'OUTCOME_STORAGE_UNAVAILABLE'); assert.equal(f.calls.length,1); assert.equal(f.counts.gets,0);
  }
  const f = await fixture(t); f.hooks.transport = async () => ({data:[],contentRange:null});
  assertError(await f.request(BASE),503,'OUTCOME_COVERAGE_UNAVAILABLE');
  f.hooks.transport = async () => ({workspaceId:'outcome-beta',workspaceRevision:randomUUID(),experiment:{id:EXPERIMENT,title:null,status:null},measurement:null,current:null});
  assertError(await f.request(REVIEW),503,'OUTCOME_REVIEW_INVALID');
  f.hooks.transport = async () => ({padding:'x'.repeat(128*1024)});
  assertError(await f.request(REVIEW),503,'OUTCOME_RESPONSE_TOO_LARGE');
  assert.equal(f.counts.saves,0);
});

test('explicit outcome reads, draft updates and publication attempts have separate bounded rates', async t => {
  const reads = await fixture(t);
  for (let i=0;i<10;i++) assert.equal((await reads.request(BASE)).status,200);
  assertError(await reads.request(REVIEW),429,'OUTCOME_RATE_LIMITED'); assert.equal(reads.calls.length,10);
  const drafts = await fixture(t,{measured:false});
  for (let i=0;i<5;i++) assert.equal((await drafts.request(MEASURE,{method:'PUT',body:measurementInput(i)})).status,200);
  assertError(await drafts.request(MEASURE,{method:'PUT',body:measurementInput(5)}),429,'OUTCOME_RATE_LIMITED'); assert.equal(drafts.counts.saves,5);
  const published = await fixture(t), input = published.publicationInput();
  for (let i=0;i<3;i++) assert.equal((await published.request(`${BASE}/publish`,{method:'POST',body:input})).status,200);
  assertError(await published.request(`${BASE}/publish`,{method:'POST',body:input}),429,'OUTCOME_RATE_LIMITED');
  assert.equal(published.calls.length,3,'Only explicitly requested retries may reach publication storage'); assert.equal(published.rows.size,1);
  assert.equal(published.counts.gets,0); assert.equal(published.counts.saves,0);
});


test('publication rollback switch and malformed values pause mutations while existing summary/evidence stay readable', async t => {
  for (const value of ['false', '', 'yes', 'malformed']) {
    const f = await fixture(t, { published: true, env: { BUSINESS_OUTCOME_PUBLICATION_ENABLED: value } });
    const beforeState = structuredClone(f.states.get('outcome-alpha')), beforeRows = structuredClone([...f.rows]);
    const input = f.publicationInput();
    for (let attempt = 0; attempt < 2; attempt++) {
      assertError(await f.request(`${BASE}/publish`, { method: 'POST', body: input }), 503, 'OUTCOME_PUBLICATION_PAUSED');
    }
    assert.equal(f.calls.length, 0, 'Paused publication must not reach or retry the ledger transport');
    assert.equal(f.invalidations.length, 0); assert.equal(f.counts.gets, 0); assert.equal(f.counts.saves, 0);
    const summary = await f.request(BASE);
    const evidence = await f.request(`${BASE}/versions/${f.initialPublication.publication.head.versionId}`);
    assert.equal(summary.status, 200); assert.equal(evidence.status, 200);
    assert.equal(summary.body.current[0].head.versionId, f.initialPublication.publication.head.versionId);
    assert.equal(evidence.body.publication.head.versionId, f.initialPublication.publication.head.versionId);
    assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => !call.path.startsWith('rpc/runvara_publish')));
    assert.deepEqual(f.states.get('outcome-alpha'), beforeState); assert.deepEqual([...f.rows], beforeRows);
    assert.equal(f.counts.providerCalls, 0);
  }
});


test('linked measurement save fails closed without compatible SQL and rejects caller evidence injection', async t => {
  const f=await fixture(t), before=structuredClone(f.states.get('outcome-alpha'));
  const r=await f.request(MEASURE,{method:'PUT',body:{...measurementInput(1),actionSelection:{actionId:'write_synthetic'}}});
  assertError(r,503,'OUTCOME_ACTION_STORAGE_UNAVAILABLE'); assert.equal(f.counts.saves,0); assert.equal(f.counts.providerCalls,0);
  assert.deepEqual(f.states.get('outcome-alpha'),before);
  const g=await fixture(t,{linkedContract:true});
  const injected=await g.request(MEASURE,{method:'PUT',body:{...measurementInput(1),actionSelection:{actionId:'write_synthetic',digest:'a'.repeat(64)}}});
  assert.equal(injected.status,409); assert.equal(g.calls.length,0); assert.equal(g.counts.saves,0);
});

test('HTTP explicit action association publishes exact immutable evidence and correction reuses after mutable deletion', async t => {
  const f=await fixture(t,{linkedContract:true}), state=f.states.get('outcome-alpha'), action=reviewedActionFixture({workspaceId:'outcome-alpha'});
  Object.assign(state,{connectionWrites:action.state.connectionWrites,approvals:action.state.approvals,connections:action.state.connections});
  const review=await f.request(REVIEW); assert.equal(review.status,200); assert.equal(review.body.actionChoices.length,1);
  assert.equal(JSON.stringify(review.body).includes(action.source.input.description),false);
  const saved=await f.request(MEASURE,{method:'PUT',body:{...measurementInput(1),actionSelection:{actionId:action.write.id}}});
  assert.equal(saved.status,200); assert.equal(saved.body.measurement.schema,'runvara-experiment-measurement/v2');
  assert.equal(saved.body.measurement.intervention.action.digest,action.source.digest);
  const first=await f.request(BASE+'/publish',{method:'POST',body:f.publicationInput()}); assert.equal(first.status,200);
  const versionId=first.body.publication.head.versionId;
  const evidence=await f.request(BASE+'/versions/'+versionId); assert.equal(evidence.status,200); assert.deepEqual(evidence.body.sourceAction,action.source);
  assert.equal(evidence.body.currentStatus,'not_checked'); assert.ok(evidence.bytes<128*1024);
  const current=f.states.get('outcome-alpha'); delete current.connectionWrites; delete current.approvals; delete current.connections;
  const reused=await f.request(MEASURE,{method:'PUT',body:{...measurementInput(2),amount:'11',actionSelection:{reuseVersionId:versionId}}});
  assert.equal(reused.status,200); assert.equal(reused.body.measurement.intervention.reuseVersionId,versionId);
  const correction={...f.publicationInput(),action:'correct',expectedHeadVersionId:versionId,expectedHeadDigest:first.body.publication.head.digest};
  const next=await f.request(BASE+'/publish',{method:'POST',body:correction}); assert.equal(next.status,200);
  const old=await f.request(BASE+'/versions/'+versionId); assert.deepEqual(old.body.sourceAction,action.source);
  const nextSource=await f.request(BASE+'/versions/'+next.body.publication.head.versionId); assert.deepEqual(nextSource.body.sourceAction,action.source);
  assert.equal(f.counts.providerCalls,0);
});

test('linked save revalidates session and mutable action after the compatibility read', async t => {
  for(const change of ['session','action']) {
    const f=await fixture(t,{linkedContract:true}), state=f.states.get('outcome-alpha'), action=reviewedActionFixture({workspaceId:'outcome-alpha'});
    Object.assign(state,{connectionWrites:action.state.connectionWrites,approvals:action.state.approvals,connections:action.state.connections});
    const original=f.store.getBusinessOutcomeReview;
    f.store.getBusinessOutcomeReview=async(...args)=>{const result=await original(...args); if(change==='session')state.users[0].sessionVersion++; else state.connectionWrites[0].input.title='Changed after review'; return result;};
    const r=await f.request(MEASURE,{method:'PUT',body:{...measurementInput(1),actionSelection:{actionId:action.write.id}}});
    assert.ok([401,409].includes(r.status)); assert.equal(f.counts.saves,0); assert.equal(f.counts.providerCalls,0);
  }
});
