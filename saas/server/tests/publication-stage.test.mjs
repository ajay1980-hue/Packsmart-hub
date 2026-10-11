import test from 'node:test';
import assert from 'node:assert/strict';
import { businessOutcomePublicationParams, businessOutcomePublicationIntentDigest, OUTCOME_PUBLICATION_READ_BYTES, OUTCOME_HEAD_READ_BYTES, OUTCOME_IDENTITY_READ_BYTES } from '../lib/business-outcome-store.mjs';
import { createGovernedRecordStage, GOVERNED_RECORD_PRODUCER_CONTRACT } from '../lib/governed-record-stage.mjs';
import { digestMeasurementValue } from '../lib/experiment-measurements.mjs';
import { createStore } from '../lib/store.mjs';
import { publicationHarness, OPEN_STAGE } from './publication-stage-fixture.mjs';

const mutations = f => f.calls.filter(call => call.path === 'rpc/runvara_publish_business_outcome');
const publish = (f, adapter, input, options) => adapter.publish(f.workspaceId, f.actor, input, options);
const budgets = calls => ({ requests: calls.length, mutationRequests: calls.filter(call => call.path === 'rpc/runvara_publish_business_outcome').length,
  requestBytes: calls.reduce((n, call) => n + call.requestBytes, 0), responseBytes: calls.reduce((n, call) => n + (call.responseBytes ?? 0), 0),
  responseCeilings: calls.map(call => call.options.maxResponseBytes), responseCeiling: calls.reduce((n, call) => n + call.options.maxResponseBytes, 0) });

test('only authentic exact startup stage keeps publication on its existing single-RPC path', async () => {
  const f = publicationHarness({ linked: true }), input = f.input();
  const response = await publish(f, f.adapter(OPEN_STAGE), input);
  assert.equal(response.replayed,false); assert.equal(f.calls.length,1); assert.equal(f.invalidations.length,1);
  assert.equal(f.calls[0].path,'rpc/runvara_publish_business_outcome');
  assert.deepEqual(JSON.parse(f.calls[0].options.body),f.params(input));
  assert.equal(f.calls[0].options.maxResponseBytes,OUTCOME_PUBLICATION_READ_BYTES);
  for (const stage of [undefined,null,{},Object.freeze({ enabled:true }),structuredClone(OPEN_STAGE),
    ...[undefined,null,'',false,true,'true',`${GOVERNED_RECORD_PRODUCER_CONTRACT} `,'runvara-governed-record-producers/v2']
      .map(value => createGovernedRecordStage({ GOVERNED_RECORD_PRODUCER_CONTRACT: value }))]) {
    const closed = publicationHarness({linked:true}), before = structuredClone(closed.state);
    await assert.rejects(publish(closed,closed.adapter(stage),closed.input(),{governedRecordStage:OPEN_STAGE}),{code:'GOVERNED_RECORDS_PAUSED',status:503});
    assert.equal(closed.calls.length,2); assert.equal(mutations(closed).length,0); assert.equal(closed.invalidations.length,0);
    assert.deepEqual(closed.state,before); assert.equal(closed.rows.size,0);
  }
});

test('closed initial and correction admit only exact fresh unlinked v1 fences', async () => {
  const f = publicationHarness(), adapter = f.adapter();
  const first = await publish(f,adapter,f.input());
  assert.equal(f.calls.length,3); assert.equal(mutations(f).length,1);
  f.setMeasurement(); f.calls.length = 0;
  const next = await publish(f,adapter,f.fences('correct'));
  assert.equal(next.publication.version.revision,2); assert.equal(f.calls.length,4); assert.equal(mutations(f).length,1);
  assert.equal(next.publication.version.lineage.previousVersionId,first.publication.version.versionId);
  for (const [patch,code] of [[{expectedWorkspaceRevision:'old_workspace'},'OUTCOME_WORKSPACE_CONFLICT'],
    [{expectedMeasurementRevision:9},'OUTCOME_MEASUREMENT_CONFLICT'],[{expectedMeasurementDigest:'a'.repeat(64)},'OUTCOME_MEASUREMENT_CONFLICT'],
    [{expectedHeadVersionId:'outcome_version_'+'a'.repeat(64)},'OUTCOME_HEAD_CONFLICT']]) {
    f.setMeasurement(); f.calls.length = 0;
    await assert.rejects(publish(f,adapter,f.fences('correct',patch)),{code});
    assert.equal(f.calls.length,2); assert.equal(mutations(f).length,0);
  }
});

test('closed correction blocks introducing, reusing, removing and downgrading a linked immutable source', async () => {
  for (const [beforeLinked,afterLinked] of [[false,true],[true,true],[true,false]]) {
    const f = publicationHarness({linked:beforeLinked});
    await publish(f,f.adapter(OPEN_STAGE),f.input()); f.setMeasurement({linked:afterLinked}); f.calls.length = 0;
    const before = structuredClone([...f.rows]);
    await assert.rejects(publish(f,f.adapter(),f.fences('correct')),{code:'GOVERNED_RECORDS_PAUSED'});
    assert.equal(mutations(f).length,0); assert.deepEqual([...f.rows],before);
    assert.equal(f.calls.length,afterLinked ? 2 : 3);
  }
});

test('closed withdrawal verifies immutable source and ignores malformed or changed mutable draft', async () => {
  const f = publicationHarness({linked:true});
  const first = await publish(f,f.adapter(OPEN_STAGE),f.input());
  const input = f.fences('withdraw'); f.state.measurement = { schema:'future-invalid-draft' }; f.calls.length=0;
  const result = await publish(f,f.adapter(),input);
  assert.equal(result.publication.head.status,'withdrawn');
  assert.deepEqual(result.publication.version.source,first.publication.version.source);
  assert.deepEqual(result.publication.version.links,first.publication.version.links);
  assert.equal(f.calls.length,5); assert.equal(mutations(f).length,1);
  assert.ok(f.calls.every(call => !call.path.includes('read_outcome_content_sources')));
  assert.deepEqual(f.rows.get(f.head).source_action,f.action.sourceAction);
  assert.equal(f.calls[2].options.maxResponseBytes,OUTCOME_PUBLICATION_READ_BYTES);
  assert.equal(f.calls[3].options.maxResponseBytes,OUTCOME_IDENTITY_READ_BYTES);
});

test('withdrawal refuses stale head, source, workspace and revoked authority before mutation', async () => {
  for (const [change,code] of [
    [(f,input)=>{ input.expectedHeadVersionId='outcome_version_'+'a'.repeat(64); },'OUTCOME_HEAD_CONFLICT'],
    [(f,input)=>{ input.expectedHeadDigest='a'.repeat(64); },'OUTCOME_HEAD_CONFLICT'],
    [(f,input)=>{ input.expectedMeasurementDigest='a'.repeat(64); },'OUTCOME_MEASUREMENT_CONFLICT'],
    [(f,input)=>{ input.expectedWorkspaceRevision='old_workspace'; },'OUTCOME_WORKSPACE_CONFLICT'],
    [(f)=>{ f.state.users[0].active=false; },'OUTCOME_OWNER_SESSION_CHANGED'],
    [(f)=>{ f.rows.get(f.head).source_measurement.report.description='tampered'; },'OUTCOME_SOURCE_INVALID']]) {
    const f = publicationHarness({linked:true}); await publish(f,f.adapter(OPEN_STAGE),f.input());
    const input=f.fences('withdraw'); change(f,input); f.calls.length=0;
    await assert.rejects(publish(f,f.adapter(),input),{code}); assert.equal(mutations(f).length,0);
  }
});

test('exact historical replay is three bounded SELECTs with current identity and no invalidation', async () => {
  const f = publicationHarness({linked:true}), firstInput = f.input(), first = await publish(f,f.adapter(OPEN_STAGE),firstInput);
  f.setMeasurement({linked:true}); await publish(f,f.adapter(OPEN_STAGE),f.fences('correct'));
  f.calls.length=0; f.invalidations.length=0; f.state.measurement=null;
  const before=structuredClone([...f.rows]), result=await publish(f,f.adapter(),firstInput);
  assert.deepEqual(result,{publication:first.publication,replayed:true,isCurrent:false});
  assert.equal(f.calls.length,3); assert.equal(mutations(f).length,0); assert.equal(f.invalidations.length,0);
  assert.deepEqual(f.calls.map(call=>call.options.maxResponseBytes),[OUTCOME_PUBLICATION_READ_BYTES,OUTCOME_HEAD_READ_BYTES,OUTCOME_IDENTITY_READ_BYTES]);
  assert.ok(f.calls.every(call=>!call.options.method && !call.options.body)); assert.deepEqual([...f.rows],before);
  assert.ok(!f.calls[0].path.includes('source_measurement')); assert.ok(!f.calls[0].path.includes('source_action'));
});

test('all original intent fields are mandatory, ordered and immutable across an awaited preflight', async () => {
  const f=publicationHarness(), input=f.input(); await publish(f,f.adapter(OPEN_STAGE),input); f.calls.length=0;
  const params=f.params(input), ordered=[params.p_workspace_id,params.p_actor_id,params.p_actor_session_version,params.p_publication_id,
    params.p_action,params.p_experiment_id,params.p_expected_workspace_revision,params.p_expected_measurement_revision,
    params.p_expected_measurement_digest,params.p_expected_head_version_id,params.p_expected_head_digest,params.p_withdrawal_reason];
  assert.equal(businessOutcomePublicationIntentDigest(params),digestMeasurementValue(ordered));
  for (const patch of [{expectedWorkspaceRevision:'changed'},{expectedMeasurementRevision:2},{expectedMeasurementDigest:'a'.repeat(64)},
    {experimentId:'other_experiment'}, {action:'correct',expectedHeadVersionId:'outcome_version_'+'a'.repeat(64),expectedHeadDigest:'a'.repeat(64)}]) {
    f.calls.length=0;
    await assert.rejects(publish(f,f.adapter(),{...input,...patch}),{code:'OUTCOME_PUBLICATION_CONFLICT'});
    assert.equal(f.calls.length,1); assert.equal(mutations(f).length,0);
  }
  for (const actor of [{...f.actor,sessionVersion:4},{...f.actor,id:'other_owner'}]) {
    await assert.rejects(f.adapter().publish(f.workspaceId,actor,input),{code:'OUTCOME_PUBLICATION_CONFLICT'});
  }
  const g=publicationHarness(), mutable=g.input(), original=structuredClone(mutable);
  g.hooks.transport=async(path,options,normal)=>{if(path.startsWith('runvara_business_outcome_versions')) mutable.expectedWorkspaceRevision='forged_after_await';return normal();};
  await publish(g,g.adapter(),mutable);
  assert.deepEqual(JSON.parse(mutations(g)[0].options.body),g.params(original));
});

test('publication pause permits verified replay and otherwise performs only one bounded read', async () => {
  const f=publicationHarness(), input=f.input(); await publish(f,f.adapter(OPEN_STAGE),input); f.calls.length=0;
  assert.equal((await publish(f,f.adapter(OPEN_STAGE,{publicationEnabled:false}),input,{publicationEnabled:true})).replayed,true);
  assert.equal(f.calls.length,3); assert.equal(mutations(f).length,0);
  f.calls.length=0;
  await assert.rejects(publish(f,f.adapter(OPEN_STAGE),f.input(),{publicationEnabled:false}),{code:'OUTCOME_PUBLICATION_PAUSED'});
  assert.equal(f.calls.length,1); assert.equal(mutations(f).length,0);
});

test('replay rechecks strict raw owner defaults, revocation, duplicates, tenant scope and size', async () => {
  for (const change of [
    f=>{f.state.users[0].active=false;},f=>{f.state.users[0].active=null;},f=>{f.state.users[0].active='true';},
    f=>{f.state.users[0].role='admin';},f=>{f.state.users[0].passwordChangeRequired=true;},f=>{f.state.users[0].passwordChangeRequired=null;},
    f=>{f.state.users[0].sessionVersion=null;},f=>{f.state.users[0].sessionVersion='3';},f=>{f.state.users[0].sessionVersion=4;},
    f=>{f.state.users.push({...f.state.users[0]});},f=>{f.state.users[0].workspaceId='foreign';},
    f=>{f.state.users.push({id:1.0});},f=>{f.state.users.push({id:true});},
    f=>{f.state.workspaceId=null;},f=>{f.state.tenant={id:'foreign'};},f=>{f.state.workspace.tenantId='foreign';}]) {
    const f=publicationHarness(), input=f.input(); await publish(f,f.adapter(OPEN_STAGE),input);change(f);f.calls.length=0;
    await assert.rejects(publish(f,f.adapter(),input),{code:'OUTCOME_OWNER_SESSION_CHANGED'}); assert.equal(mutations(f).length,0);
  }
  for (const change of [f=>{f.state.users=Array.from({length:501},(_,i)=>({id:`user_${i}`}));},f=>{f.state.users[0].extra='x'.repeat(256*1024);}]) {
    const f=publicationHarness(),input=f.input();await publish(f,f.adapter(OPEN_STAGE),input);change(f);f.calls.length=0;
    await assert.rejects(publish(f,f.adapter(),input),{code:'OUTCOME_SIZE_LIMIT'});assert.equal(mutations(f).length,0);
  }
  const f=publicationHarness();f.actor.sessionVersion=1;f.state.users[0].sessionVersion=1;
  const input=f.input();await publish(f,f.adapter(OPEN_STAGE),input);
  for(const key of ['active','sessionVersion','passwordChangeRequired']) delete f.state.users[0][key];
  assert.equal((await publish(f,f.adapter(),input)).replayed,true);
});

test('malformed, future, foreign, oversized and duplicate replay rows never reach mutation', async () => {
  for (const mutate of [rows=>[...rows,...rows], rows=>[{...rows[0],workspace_id:'foreign'}], rows=>[{...rows[0],publication_id:'foreign'}],
    rows=>[{...rows[0],intent_digest:'future-format'}], rows=>[{...rows[0],committed_at:'2027-01-01T00:00:00.000Z'}],
    rows=>[{...rows[0],payload:{...rows[0].payload,schema:'runvara-business-outcome/v2'}}], rows=>[{...rows[0],extra:'x'.repeat(OUTCOME_PUBLICATION_READ_BYTES)}]]) {
    const f=publicationHarness(),input=f.input();await publish(f,f.adapter(OPEN_STAGE),input); f.calls.length=0;
    f.hooks.transport=async(path,options,normal)=>path.startsWith('runvara_business_outcome_versions')?mutate(await normal()):normal();
    await assert.rejects(publish(f,f.adapter(),input));assert.equal(f.calls.length,1);assert.equal(mutations(f).length,0);
  }
  for (const target of ['runvara_business_outcome_heads','saas_workspace_state']) {
    const f=publicationHarness(),input=f.input();await publish(f,f.adapter(OPEN_STAGE),input);f.calls.length=0;
    f.hooks.transport=async(path,options,normal)=>{const rows=await normal();return path.startsWith(target)?[...rows,...rows]:rows;};
    await assert.rejects(publish(f,f.adapter(),input));assert.equal(mutations(f).length,0);
  }
});

test('raw JSONB fractional session values cannot acquire authority through binary-number rounding', async () => {
  for(const token of ['3.0000000000000000000000000000001','2.9999999999999999999999999999999','9007199254740991.1','3e0','3.0000']) {
    const f=publicationHarness();
    if(token.startsWith('9007')){f.actor.sessionVersion=Number.MAX_SAFE_INTEGER;f.state.users[0].sessionVersion=Number.MAX_SAFE_INTEGER;}
    const input=f.input();await publish(f,f.adapter(OPEN_STAGE),input);f.calls.length=0;
    f.hooks.transport=async(path,options,normal)=>{
      const rows=await normal();
      if(path.startsWith('saas_workspace_state'))rows[0].users_json=rows[0].users_json.replace(/"sessionVersion":\d+/,`"sessionVersion":${token}`);
      return rows;
    };
    await assert.rejects(publish(f,f.adapter(),input),{code:'OUTCOME_OWNER_SESSION_CHANGED'});assert.equal(mutations(f).length,0);
  }
});

test('a runtime without original numeric-token support fails replay closed rather than normalizing authority', async () => {
  const f=publicationHarness(),input=f.input();await publish(f,f.adapter(OPEN_STAGE),input);f.calls.length=0;
  const parse=JSON.parse;
  try {
    JSON.parse=(source,reviver)=>parse(source,reviver && function(key,value){return reviver.call(this,key,value);});
    await assert.rejects(publish(f,f.adapter(),input),{code:'OUTCOME_OWNER_SESSION_CHANGED'});
    assert.equal(mutations(f).length,0);
  } finally {JSON.parse=parse;}
  assert.equal((await publish(f,f.adapter(),input)).replayed,true);
});

test('preflight race reaches unchanged original SQL fences, with no automatic retry or rebase', async () => {
  for (const boundary of ['workspace','head','measurement']) {
    const f=publicationHarness(),input=f.input();
    f.hooks.transport=async(path,options,normal)=>{
      const result=await normal();
      if(path==='rpc/runvara_read_outcome_content_sources') {
        if(boundary==='workspace') f.state._revision='concurrent_workspace';
        if(boundary==='head') f.head='outcome_version_'+'a'.repeat(64);
        if(boundary==='measurement') f.state.measurement={...f.state.measurement,digest:'a'.repeat(64)};
      }
      return result;
    };
    await assert.rejects(publish(f,f.adapter(),input),{code:boundary==='workspace'?'OUTCOME_WORKSPACE_CONFLICT':boundary==='head'?'OUTCOME_HEAD_CONFLICT':'OUTCOME_MEASUREMENT_CONFLICT'});
    assert.equal(mutations(f).length,1);assert.deepEqual(JSON.parse(mutations(f)[0].options.body),f.params(input));assert.equal(f.invalidations.length,1);
  }
});

test('unavailable and malformed preflights fail closed; only missing protected reader permits one compatibility read', async () => {
  for(const databaseCode of ['PGRST202','42P01','57014','unknown']) {
    const f=publicationHarness({linked:true});
    f.hooks.transport=async()=>{throw Object.assign(new Error('private synthetic failure'),{databaseCode});};
    await assert.rejects(publish(f,f.adapter(),f.input()),{code:['PGRST202','42P01'].includes(databaseCode)?'OUTCOME_STORAGE_UNAVAILABLE':'OUTCOME_READ_UNAVAILABLE'});
    assert.equal(f.calls.length,1);assert.equal(mutations(f).length,0);
  }
  for(const response of [null,{},[{}],{schema:'future',review:{}}]) {
    const f=publicationHarness();
    f.hooks.transport=async(path,options,normal)=>path==='rpc/runvara_read_outcome_content_sources'?response:normal();
    await assert.rejects(publish(f,f.adapter(),f.input()),{code:'OUTCOME_REVIEW_INVALID'});
    assert.equal(f.calls.length,2);assert.equal(mutations(f).length,0);
  }
  const f=publicationHarness();
  f.hooks.transport=async(path,options,normal)=>{
    if(path==='rpc/runvara_read_outcome_content_sources')throw Object.assign(new Error('missing protected reader'),{databaseCode:'PGRST202'});
    return normal();
  };
  await publish(f,f.adapter(),f.input());assert.equal(f.calls.length,4);assert.equal(mutations(f).length,1);
  assert.deepEqual(f.calls.slice(1,3).map(call=>call.path),['rpc/runvara_read_outcome_content_sources','rpc/runvara_read_business_outcome_review']);
});

test('legacy unlinked source compatibility adds at most one read per missing protected reader and source-action column', async t => {
  const costs={};
  for(const action of ['correct','withdraw']) {
    const f=publicationHarness();await publish(f,f.adapter(OPEN_STAGE),f.input());
    if(action==='correct')f.setMeasurement();
    const input=f.fences(action);f.calls.length=0;
    f.hooks.transport=async(path,options,normal)=>{
      if(path==='rpc/runvara_read_outcome_content_sources')throw Object.assign(new Error('missing function'),{databaseCode:'PGRST202'});
      if(path.startsWith('runvara_business_outcome_versions') && path.includes('source_action'))throw Object.assign(new Error('missing column'),{databaseCode:'42703'});
      return normal();
    };
    await publish(f,f.adapter(),input);
    assert.equal(f.calls.length,6);assert.equal(mutations(f).length,1);costs[action]=budgets(f.calls);
  }
  t.diagnostic(JSON.stringify({legacyPublicationStageCosts:costs}));
});

test('store startup closure cannot be opened by caller options or later environment mutation', async () => {
  const f=publicationHarness({linked:true}), env={SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-test'};
  const store=createStore(env,{fetchImpl:async(url,options)=>{
    const path=new URL(url).pathname.replace('/rest/v1/','')+new URL(url).search;
    if(path.startsWith('runvara_business_outcome_versions'))return Response.json([]);
    if(path==='rpc/runvara_read_outcome_content_sources')return Response.json({schema:'runvara-outcome-content-source-reader/v1',
      review:{workspaceId:f.workspaceId,workspaceRevision:f.state._revision,experiment:{id:f.experimentId,title:null,status:null},measurement:f.state.measurement,current:null,
        actionLinkContract:'runvara-reviewed-action/v1',actionChoices:[],currentActionAssociation:null},receiptChoices:[],nextCursor:null,hasMore:false,selectedEvidence:null});
    assert.fail(path);
  }});
  env.GOVERNED_RECORD_PRODUCER_CONTRACT=GOVERNED_RECORD_PRODUCER_CONTRACT;
  await assert.rejects(store.publishBusinessOutcome(f.workspaceId,f.actor,f.input(),{governedRecordStage:OPEN_STAGE}),{code:'GOVERNED_RECORDS_PAUSED'});
  assert.equal(store.activitySnapshot(f.workspaceId).db.attempted,2);
  assert.throws(()=>{store.governedRecordStage=OPEN_STAGE;},TypeError);
});

test('publication request and response costs are measured on success, stale, replay, malformed and denied paths', async t => {
  const results={};
  for(const scenario of ['open','unlinked','correction','stale','replay','malformed','denied','withdraw']) {
    const f=publicationHarness({linked:['denied','withdraw'].includes(scenario)}),adapter=f.adapter(scenario==='open'?OPEN_STAGE:undefined);
    let input=f.input();
    if(['replay','malformed','withdraw','correction'].includes(scenario)) {
      await publish(f,f.adapter(OPEN_STAGE),input);f.calls.length=0;
      if(scenario==='withdraw')input=f.fences('withdraw');
      if(scenario==='correction'){f.setMeasurement();input=f.fences('correct');}
    }
    if(scenario==='stale') input.expectedWorkspaceRevision='old';
    if(scenario==='malformed') f.hooks.transport=async(path,options,normal)=>path.startsWith('runvara_business_outcome_versions')?[{malformed:true}]:normal();
    if(['stale','malformed','denied'].includes(scenario))await assert.rejects(publish(f,adapter,input));else await publish(f,adapter,input);
    results[scenario]=budgets(f.calls);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(results).map(([key,row])=>[key,[row.requests,row.mutationRequests]])),
    {open:[1,1],unlinked:[3,1],correction:[4,1],stale:[2,0],replay:[3,0],malformed:[1,0],denied:[2,0],withdraw:[5,1]});
  assert.equal(results.unlinked.requestBytes-results.open.requestBytes,Buffer.byteLength(JSON.stringify({p_workspace_id:'stage-tenant',p_experiment_id:'experiment_stage',p_actor_id:'owner',p_actor_session_version:3,p_receipt_selector:null,p_after_attempt_id:null,p_resolve_saved_source:true})));
  const deltaFromOpen=Object.fromEntries(Object.entries(results).map(([key,row])=>[key,Object.fromEntries(
    ['requests','mutationRequests','requestBytes','responseBytes','responseCeiling'].map(field=>[field,row[field]-results.open[field]]))]));
  const largestParams=businessOutcomePublicationParams('雪'.repeat(256),{id:'x'.repeat(160),sessionVersion:Number.MAX_SAFE_INTEGER},
    {publicationId:'x'.repeat(160),action:'withdraw',experimentId:'x'.repeat(160),expectedWorkspaceRevision:'x'.repeat(160),
      expectedMeasurementRevision:Number.MAX_SAFE_INTEGER,expectedMeasurementDigest:'a'.repeat(64),expectedHeadVersionId:'outcome_version_'+'a'.repeat(64),
      expectedHeadDigest:'a'.repeat(64),withdrawalReason:'incorrect_measurement'});
  const validUnicodePublicationRequestMaxBytes=Buffer.byteLength(JSON.stringify(largestParams));assert.equal(validUnicodePublicationRequestMaxBytes,1988);
  // Preserve the existing open DTO transport contract, which can serialize
  // malformed surrogate workspace text before SQL rejects it. Escapes cost six
  // bytes per code unit, so its transport bound is larger than valid Unicode.
  const publicationRequestMaxBytes=Buffer.byteLength(JSON.stringify({...largestParams,p_workspace_id:'\ud800'.repeat(256)}));assert.equal(publicationRequestMaxBytes,2756);
  t.diagnostic(JSON.stringify({publicationStageCosts:results,deltaFromOpen,publicationRequestMaxBytes,validUnicodePublicationRequestMaxBytes,identityJsonbUsersLimit:262144,identityUsersLimit:500}));
});
