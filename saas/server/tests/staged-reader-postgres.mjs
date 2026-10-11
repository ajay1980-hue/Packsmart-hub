/** Actual PostgreSQL 17 staged-reader proof. The HTTP adapter below is a bounded
 * local SQL bridge, not PostgREST; no claim of real PostgREST execution is made. */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fixtureData, withAction, sourceMeasurement, callSql } from './business-outcome-postgres-fixture.mjs';
import { runStagedReceiptClosurePgTests } from './staged-reader-receipt-dispatch-postgres.mjs';
import { stagedReceiptFixtures } from './staged-reader-postgres-fixture.mjs';
import { createBusinessOutcomePersistence, businessOutcomePublicationParams, businessOutcomePublicationIntentDigest } from '../lib/business-outcome-store.mjs';
import { createGovernedRecordStage, GOVERNED_RECORD_PRODUCER_CONTRACT } from '../lib/governed-record-stage.mjs';
import { prepareContentReceiptTransaction, commitContentReceiptTransaction } from '../lib/content-execution-receipt-store.mjs';

assert.equal(process.env.OUTCOME_ALLOW_DISPOSABLE_TEST_DB, '1');
const baseUrl = new URL(process.env.OUTCOME_TEST_DATABASE_URL);
assert.equal(baseUrl.protocol, 'postgres:'); assert.equal(baseUrl.hostname, '127.0.0.1');
assert.equal(baseUrl.username, 'postgres'); assert.equal(baseUrl.pathname, '/runvara_outcome_test');
assert.equal(baseUrl.search, ''); assert.equal(baseUrl.hash, '');
const { Client } = createRequire(new URL('./atomic-usage/package.json', import.meta.url))('pg');
const openStage = createGovernedRecordStage({ GOVERNED_RECORD_PRODUCER_CONTRACT });
const scopeKeys = ['workspaceId','workspace_id','tenantId','tenant_id','tenant'];
const migrations = [
  '20260927113000_runvara_agent_operations.sql', '20260927122500_ai_usage_economics.sql',
  '20261006190318_atomic_provider_usage.sql', '20261006194326_objective_prepare_job_guard.sql',
  '20261007074031_reporting_status_cas.sql', '20261007100823_business_outcome_publication.sql',
  '20261007175355_reviewed_action_outcome_snapshot.sql', '20261008055400_objective_action_outcome_snapshot.sql',
  '20261008144414_protected_content_execution_receipts.sql', '20261008163558_receipt_outcome_consumer.sql',
  '20261009053240_bounded_shopify_order_recovery_rebuilt.sql'
];
let base, admin, service, database, baseline;
const profiles = [], bridgeCalls = [];
const wire = value => JSON.parse(JSON.stringify(value));
const ident = value => { assert.match(value, /^[A-Za-z_]\w*$/); return '"' + value + '"'; };
const sqlValues = p => [p.p_workspace_id,p.p_actor_id,p.p_actor_session_version,p.p_publication_id,p.p_action,p.p_experiment_id,
  p.p_expected_workspace_revision,p.p_expected_measurement_revision,p.p_expected_measurement_digest,p.p_expected_head_version_id,p.p_expected_head_digest,p.p_withdrawal_reason];
function inputFor(f, overrides = {}) {
  return { publicationId: randomUUID(), action: 'publish', experimentId: f.experimentId,
    expectedWorkspaceRevision: f.state._revision, expectedMeasurementRevision: f.source.revision,
    expectedMeasurementDigest: f.source.digest, expectedHeadVersionId: null, expectedHeadDigest: null, withdrawalReason: null, ...overrides };
}
const actor = { id: 'owner', sessionVersion: 1 };
async function seed({ linked = false } = {}) {
  const f = linked ? withAction(fixtureData()) : fixtureData();
  await admin.query('INSERT INTO public.workspaces(id,name,slug) VALUES($1,$1,$1)', [f.workspaceId]);
  await admin.query('INSERT INTO public.saas_workspace_state(workspace_id,state) VALUES($1,$2)', [f.workspaceId,f.state]);
  return f;
}
const stateFor = async f => (await admin.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1',[f.workspaceId])).rows[0].state;
const setState = (f,state) => admin.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1',[f.workspaceId,state]);
const rowsFor = async f => (await admin.query('SELECT count(*)::int n FROM public.runvara_business_outcome_versions WHERE workspace_id=$1',[f.workspaceId])).rows[0].n;
async function bridge(path, options = {}) {
  const trace = { path, method: options.method ?? 'GET', maxResponseBytes: options.maxResponseBytes }; bridgeCalls.push(trace);
  const body = options.body ? JSON.parse(options.body) : null;
  try {
    let result;
    if (path === 'rpc/runvara_publish_business_outcome') result = (await service.query(callSql,sqlValues(body))).rows[0].receipt;
    else if (path === 'rpc/runvara_read_business_outcome_review') result = (await service.query('SELECT public.runvara_read_business_outcome_review($1,$2) result',[body.p_workspace_id,body.p_experiment_id])).rows[0].result;
    else if (path === 'rpc/runvara_read_outcome_content_sources') result = (await service.query('SELECT public.runvara_read_outcome_content_sources($1,$2,$3,$4::bigint,$5::jsonb,$6,$7::boolean) result',
      [body.p_workspace_id,body.p_experiment_id,body.p_actor_id,body.p_actor_session_version,body.p_receipt_selector,body.p_after_attempt_id,body.p_resolve_saved_source])).rows[0].result;
    else {
      const url = new URL(path,'https://synthetic.invalid'), table = url.pathname.slice(1), select = url.searchParams.get('select');
      assert.equal(url.searchParams.get('limit'),'2');
      assert.ok(['runvara_business_outcome_versions','runvara_business_outcome_heads','saas_workspace_state'].includes(table));
      const workspaceId = url.searchParams.get('workspace_id').slice(3), values = [workspaceId], filters = ['workspace_id=$1'];
      let projection;
      if (table === 'saas_workspace_state') {
        const expectedSelect = ['workspace_id','revision:state->>_revision','workspace:state->workspace','users_json:state->>users',...scopeKeys.map(key=>'scope_'+key+':state->'+key)].join(',');
        assert.equal(select,expectedSelect);
        const expectedFilter = '(' + scopeKeys.map(key=>`or(state->${key}.is.null,state->>${key}.eq.${JSON.stringify(workspaceId)}${key === 'tenant' ? `,state->tenant->>id.eq.${JSON.stringify(workspaceId)}` : ''})`).join(',') + ')';
        assert.equal(url.searchParams.get('and'),expectedFilter,'Assert emitted filter grammar before independently executing its intended SQL semantics');
        filters.push(...scopeKeys.map(key=>`(state->'${key}' IS NULL OR state->>'${key}'=$1${key === 'tenant' ? " OR state->'tenant'->>'id'=$1" : ''})`));
        projection = "workspace_id,state->>'_revision' revision,state->'workspace' workspace,state->>'users' users_json," + scopeKeys.map(key=>`state->'${key}' AS "scope_${key}"`).join(',');
      } else {
        const allowed = ['workspace_id','outcome_id','revision','version_id','digest','status','payload','publication_id','intent_digest','committed_at','commit_revision','source_measurement','source_action'];
        projection = select.split(',').map(key=>{ assert.ok(allowed.includes(key),key); return ident(key); }).join(',');
        for (const key of ['publication_id','outcome_id','version_id']) if (url.searchParams.has(key)) {
          assert.ok(url.searchParams.get(key).startsWith('eq.')); values.push(url.searchParams.get(key).slice(3)); filters.push(ident(key)+'=$'+values.length);
        }
      }
      result = (await service.query('SELECT to_jsonb(selected) value FROM (SELECT '+projection+' FROM public.'+ident(table)+' WHERE '+filters.join(' AND ')+' LIMIT 2) selected',values)).rows.map(row=>row.value);
    }
    const value = wire(result); trace.responseBytes = Buffer.byteLength(JSON.stringify(value)); return value;
  } catch (error) {
    if (error.code) {
      // Explicit adapter emulation. A real PostgREST server is not installed.
      trace.sqlState = error.code;
      throw Object.assign(new Error('Synthetic SQL bridge rejection'), { databaseCode: error.code === '42883' ? 'PGRST202' : error.code });
    }
    throw error;
  }
}
const adapter = (stage, options = {}) => createBusinessOutcomePersistence({ request: bridge, governedRecordStage: stage, ...options });
async function capabilityProfile(name) {
  const row = (await admin.query(`SELECT to_regclass('public.runvara_business_outcome_versions') IS NOT NULL outcomes,
    to_regprocedure('public.runvara_read_business_outcome_review(text,text)') IS NOT NULL legacy_review,
    to_regprocedure('public.runvara_reserve_content_receipt(text)') IS NOT NULL receipts,
    to_regprocedure('public.runvara_read_outcome_content_sources(text,text,text,bigint,jsonb,text,boolean)') IS NOT NULL protected_review,
    to_regprocedure('public.runvara_reserve_order_recovery(text)') IS NOT NULL recovery`)).rows[0];
  profiles.push({ name, ...row }); return row;
}
before(async () => {
  base = new Client({ connectionString: baseUrl.toString(),ssl:false,connectionTimeoutMillis:5000 }); await base.connect();
  assert.equal(base.connection.stream.remoteAddress,'127.0.0.1');
  const info = (await base.query("SELECT current_setting('server_version_num')::int version,current_setting('listen_addresses') listen")).rows[0];
  assert.equal(info.version,170006); assert.equal(info.listen,'127.0.0.1');
  database = 'runvara_staged_reader_'+randomUUID().replaceAll('-',''); await base.query('CREATE DATABASE '+ident(database));
  const childUrl = new URL(baseUrl); childUrl.pathname = '/'+database;
  admin = new Client({ connectionString:childUrl.toString(),ssl:false,statement_timeout:20000 }); await admin.connect();
  assert.equal((await admin.query("SELECT count(*)::int n FROM pg_class WHERE relnamespace='public'::regnamespace")).rows[0].n,0);
  await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role");
  baseline = await readFile(new URL('../supabase/schema.sql',import.meta.url),'utf8'); await admin.query(baseline);
  service = new Client({connectionString:childUrl.toString(),ssl:false,statement_timeout:20000}); await service.connect(); await service.query('SET ROLE service_role');
});
after(async () => {
  await service?.end(); await admin?.end();
  if (database) { await base.query('DROP DATABASE '+ident(database)); assert.equal((await base.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1',[database])).rows[0].n,0); }
  await base?.end(); console.log('STAGED_READER_STORAGE_PROFILES='+JSON.stringify(profiles));
  console.log('STAGED_READER_PROOF='+JSON.stringify({localOnly:true,synthetic:true,postgres:'17.6',actualPostgrest:false,externalProviderCalls:0,cleanup:'child database removal verified'}));
});

test('exact baseline and ordered existing forward migrations support reader-first compatibility and missing capability refusal',async()=>{
  let profile = await capabilityProfile('schema.sql'); assert.equal(profile.outcomes,false);
  const early = await seed(); await assert.rejects(adapter().publish(early.workspaceId,actor,inputFor(early)),{code:'OUTCOME_STORAGE_UNAVAILABLE'});
  for (const file of migrations) {
    await admin.query(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
    profile = await capabilityProfile(file);
    if (profile.outcomes) {
      const f=await seed(), input=inputFor(f), published=await adapter().publish(f.workspaceId,actor,input);
      assert.equal(published.replayed,false); assert.equal(published.isCurrent,true);
      assert.equal((await adapter().publish(f.workspaceId,actor,input)).replayed,true);
      assert.equal(await rowsFor(f),1);
      if (!profile.protected_review) await assert.rejects(adapter().review(f.workspaceId,f.experimentId,actor,{requireReceiptContract:true}),{code:'OUTCOME_STORAGE_UNAVAILABLE'});
    }
  }
  assert.equal(profile.recovery,true); assert.equal(profile.protected_review,true);
});

test('ordered 12-field JavaScript publication intent equals SQL and stored intent across publish correction withdrawal',async()=>{
  const f=await seed(), inputs=[], out=adapter(openStage); let input=inputFor(f), prior;
  for (const action of ['publish','correct','withdraw']) {
    if (action !== 'publish') {
      f.state=await stateFor(f);
      if(action==='correct') { f.source=sourceMeasurement(f.workspaceId,f.experimentId,{revision:2,amount:'234.56'}); f.state.revenueEngine.experiments[0].outcomeMeasurement=f.source; f.state._revision=randomUUID(); await setState(f,f.state); }
      input=inputFor(f,{action,expectedHeadVersionId:prior.publication.head.versionId,expectedHeadDigest:prior.publication.head.digest,withdrawalReason:action==='withdraw'?'evidence_retracted':null});
    }
    const params=businessOutcomePublicationParams(f.workspaceId,actor,input), values=sqlValues(params);
    const sqlHash=(await admin.query('SELECT public.runvara_outcome_hash($1::jsonb) hash',[JSON.stringify(values)])).rows[0].hash;
    assert.equal(values.length,12); assert.equal(businessOutcomePublicationIntentDigest(params),sqlHash);
    prior=await out.publish(f.workspaceId,actor,input);
    const saved=(await admin.query('SELECT intent_digest FROM public.runvara_business_outcome_versions WHERE workspace_id=$1 AND publication_id=$2',[f.workspaceId,input.publicationId])).rows[0];
    assert.equal(saved.intent_digest,sqlHash); inputs.push(input);
  }
  for(const input of inputs) assert.equal((await adapter().publish(f.workspaceId,actor,input)).replayed,true);
  assert.equal(await rowsFor(f),3);
});

test('closed linked publication replays immutable versions after damaged draft and withdraws exact retained evidence',async()=>{
  const f=await seed({linked:true}), input=inputFor(f), first=await adapter(openStage).publish(f.workspaceId,actor,input);
  f.state=await stateFor(f); f.state.revenueEngine={experiments:[{id:f.experimentId,outcomeMeasurement:{malformed:true}}]}; f.state.connectionWrites=[]; f.state.approvals=[]; f.state._revision=randomUUID(); await setState(f,f.state);
  const before=await stateFor(f), start=bridgeCalls.length, replay=await adapter().publish(f.workspaceId,actor,input);
  assert.equal(replay.replayed,true); assert.deepEqual(await stateFor(f),before);
  assert.deepEqual(bridgeCalls.slice(start).map(x=>x.method),['GET','GET','GET']);
  const withdraw=inputFor(f,{action:'withdraw',expectedHeadVersionId:first.publication.head.versionId,expectedHeadDigest:first.publication.head.digest,withdrawalReason:'evidence_retracted'});
  const final=await adapter().publish(f.workspaceId,actor,withdraw); assert.equal(final.publication.head.status,'withdrawn');
  assert.equal((await adapter().publish(f.workspaceId,actor,input)).isCurrent,false);
  const retained=(await admin.query('SELECT source_action FROM public.runvara_business_outcome_versions WHERE workspace_id=$1 ORDER BY revision',[f.workspaceId])).rows;
  assert.deepEqual(retained[0].source_action,retained[1].source_action); assert.equal(await rowsFor(f),2);
});

test('closed gate refuses new linked publish/correction; exact stale intent, head, measurement and workspace fences fail before mutation',async()=>{
  const f=await seed({linked:true}), input=inputFor(f); let start=bridgeCalls.length;
  await assert.rejects(adapter().publish(f.workspaceId,actor,input),{code:'GOVERNED_RECORDS_PAUSED'});
  assert.equal(bridgeCalls.slice(start).filter(x=>x.path==='rpc/runvara_publish_business_outcome').length,0); assert.equal(await rowsFor(f),0);
  const first=await adapter(openStage).publish(f.workspaceId,actor,input); f.state=await stateFor(f);
  await assert.rejects(adapter().publish(f.workspaceId,actor,{...input,expectedWorkspaceRevision:randomUUID()}),{code:'OUTCOME_PUBLICATION_CONFLICT'});
  const correction=inputFor(f,{action:'correct',expectedHeadVersionId:first.publication.head.versionId,expectedHeadDigest:first.publication.head.digest});
  await assert.rejects(adapter().publish(f.workspaceId,actor,correction),{code:'GOVERNED_RECORDS_PAUSED'});
  const withdraw={...correction,action:'withdraw',withdrawalReason:'evidence_retracted'};
  for(const [patch,code] of [[{expectedHeadDigest:'0'.repeat(64)},'OUTCOME_HEAD_CONFLICT'],[{expectedHeadVersionId:'outcome_version_'+'0'.repeat(64)},'OUTCOME_HEAD_CONFLICT'],[{expectedMeasurementDigest:'0'.repeat(64)},'OUTCOME_MEASUREMENT_CONFLICT'],[{expectedWorkspaceRevision:randomUUID()},'OUTCOME_WORKSPACE_CONFLICT']]) {
    start=bridgeCalls.length; await assert.rejects(adapter().publish(f.workspaceId,actor,{...withdraw,...patch}),{code});
    assert.equal(bridgeCalls.slice(start).filter(x=>x.path==='rpc/runvara_publish_business_outcome').length,0);
  }
  assert.equal(await rowsFor(f),1);
});

test('publication pause permits exact replay and rejects absent identifiers without a mutation',async()=>{
  const f=await seed({linked:true}), input=inputFor(f);await adapter(openStage).publish(f.workspaceId,actor,input);
  const paused=adapter(openStage,{publicationEnabled:false}), start=bridgeCalls.length;
  assert.equal((await paused.publish(f.workspaceId,actor,input)).replayed,true);
  await assert.rejects(paused.publish(f.workspaceId,actor,{...input,publicationId:randomUUID()}),{code:'OUTCOME_PUBLICATION_PAUSED'});
  assert.equal(bridgeCalls.slice(start).filter(x=>x.path==='rpc/runvara_publish_business_outcome').length,0);assert.equal(await rowsFor(f),1);
});

test('SQL repeats authoritative workspace and owner fences after closed withdrawal preflight races',async()=>{
  for(const change of ['workspace','owner']){
    const f=await seed({linked:true}), first=await adapter(openStage).publish(f.workspaceId,actor,inputFor(f));f.state=await stateFor(f);
    const input=inputFor(f,{action:'withdraw',expectedHeadVersionId:first.publication.head.versionId,expectedHeadDigest:first.publication.head.digest,withdrawalReason:'evidence_retracted'});
    let mutations=0;const raced=createBusinessOutcomePersistence({request:async(path,options)=>{
      if(path==='rpc/runvara_publish_business_outcome'){mutations++;const current=await stateFor(f);if(change==='workspace')current._revision=randomUUID();else current.users[0].role='member';await setState(f,current);}
      return bridge(path,options);
    }});
    await assert.rejects(raced.publish(f.workspaceId,actor,input),{code:change==='workspace'?'OUTCOME_WORKSPACE_CONFLICT':'OUTCOME_OWNER_SESSION_CHANGED'});
    assert.equal(mutations,1);assert.equal(await rowsFor(f),1);
  }
});

test('actual JSONB projection distinguishes absent root markers from JSON null and preserves exact lexical user bytes',async()=>{
  const absent=(await admin.query("SELECT '{}'::jsonb->'tenant' IS NULL missing,'{\"tenant\":null}'::jsonb->'tenant' IS NULL explicit_null,('[{\"sessionVersion\":1.000,\"id\":\"owner\"}]'::jsonb)::text lexical")).rows[0];
  assert.equal(absent.missing,true); assert.equal(absent.explicit_null,false); assert.match(absent.lexical,/1\.000/);
  const f=await seed(), input=inputFor(f); await adapter(openStage).publish(f.workspaceId,actor,input); const saved=await stateFor(f);
  for(const key of scopeKeys) for(const marker of [undefined,null,3,true,[],{},'foreign',f.workspaceId,...(key==='tenant'?[{id:f.workspaceId},{id:'foreign'}]:[])]) {
    const state=structuredClone(saved); if(marker!==undefined)state[key]=marker; await setState(f,state);
    const expected=marker===undefined||marker===f.workspaceId||key==='tenant'&&marker?.id===f.workspaceId;
    let jsAccepted=true, sqlAccepted=true;
    try { await adapter().publish(f.workspaceId,actor,input); } catch { jsAccepted=false; }
    try { await service.query(callSql,sqlValues(businessOutcomePublicationParams(f.workspaceId,actor,input))); } catch { sqlAccepted=false; }
    assert.equal(jsAccepted,expected,`${key}:${JSON.stringify(marker)}`); assert.equal(jsAccepted,sqlAccepted);
  }
});

test('closed replay authority agrees with actual SQL for absent defaults, nulls, types, duplicates, sessions and raw user-byte limits',async()=>{
  const f=await seed(), input=inputFor(f); await adapter(openStage).publish(f.workspaceId,actor,input); const saved=await stateFor(f);
  const cases=[['defaults',s=>{delete s.users[0].active;delete s.users[0].sessionVersion;delete s.users[0].passwordChangeRequired;},true],
    ['null active',s=>s.users[0].active=null,false],['false active',s=>s.users[0].active=false,false],['string active',s=>s.users[0].active='true',false],
    ['null password',s=>s.users[0].passwordChangeRequired=null,false],['true password',s=>s.users[0].passwordChangeRequired=true,false],
    ['null session',s=>s.users[0].sessionVersion=null,false],['string session',s=>s.users[0].sessionVersion='1',false],['new session',s=>s.users[0].sessionVersion=2,false],
    ['fraction session',s=>s.users[0].sessionVersion=1.5,false],['duplicate',s=>s.users.push({...s.users[0]}),false],['foreign actor',s=>s.users[0].tenantId='foreign',false],
    ['null actor scope',s=>s.users[0].tenantId=null,false],['not array',s=>s.users={},false],['501 users',s=>s.users.push(...Array.from({length:500},(_,i)=>({id:'x'+i}))),false],
    ['JSONB lexical byte bound',s=>s.users[0].extra='x'.repeat(262144),false]];
  for(const [name,mutate,expected]of cases){const state=structuredClone(saved);mutate(state);await setState(f,state);let a=true,b=true;
    try{await adapter().publish(f.workspaceId,actor,input);}catch{a=false;}try{await service.query(callSql,sqlValues(businessOutcomePublicationParams(f.workspaceId,actor,input)));}catch{b=false;}
    assert.equal(a,expected,name);assert.equal(a,b,name+' SQL parity');}
  await setState(f,saved); await admin.query("UPDATE public.saas_workspace_state SET state=jsonb_set(state,'{users,0,sessionVersion}','1.000'::jsonb) WHERE workspace_id=$1",[f.workspaceId]);
  await assert.rejects(adapter().publish(f.workspaceId,actor,input),{code:'OUTCOME_OWNER_SESSION_CHANGED'});
});

test('reserved known-success content receipt finalizes after private pause without new charge or admission',async()=>{
  await admin.query("UPDATE public.runvara_content_receipt_control SET mode='enforced'");
  const fixtures=stagedReceiptFixtures(admin), f=await fixtures.fixture(), reserve=fixtures.reserveRequest(f), finish=fixtures.finalizeRequest(f,reserve);
  const reserved=(await service.query('SELECT public.runvara_reserve_content_receipt($1) ack',[JSON.stringify(reserve)])).rows[0].ack; assert.equal(reserved.kind,'reserve');
  const quotaBefore=(await admin.query('SELECT scope_key,quota FROM public.runvara_content_receipt_quotas ORDER BY scope_key')).rows;
  await admin.query("UPDATE public.runvara_content_receipt_control SET mode='paused'");
  const calls=[];
  const tx=prepareContentReceiptTransaction(f.workspaceId,finish.state,finish.expectedRevision,{contract:'runvara-content-execution-receipts/v1',kind:'finalize',admission:f.admission,receipt:f.receipt});
  const request=async(_operation,path,options)=>{calls.push(path);assert.equal(path,'rpc/runvara_finalize_content_receipt');return(await service.query('SELECT public.runvara_finalize_content_receipt($1) ack',[JSON.parse(options.body).p_request_json])).rows[0].ack;};
  const result=await commitContentReceiptTransaction(tx,request);assert.equal(result.ack.kind,'finalize');assert.equal(result.ack.replayed,false);
  assert.deepEqual((await admin.query('SELECT scope_key,quota FROM public.runvara_content_receipt_quotas ORDER BY scope_key')).rows,quotaBefore);
  const next=await fixtures.fixture();await assert.rejects(service.query('SELECT public.runvara_reserve_content_receipt($1)',[JSON.stringify(fixtures.reserveRequest(next))]),{code:'P0R07'});
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.runvara_content_receipts WHERE workspace_id=$1',[f.workspaceId])).rows[0].n,1);
  assert.deepEqual(calls,['rpc/runvara_finalize_content_receipt']);
  const replay=await commitContentReceiptTransaction(tx,request);assert.equal(replay.ack.replayed,true);
  await admin.query("UPDATE public.runvara_content_receipt_control SET mode='enforced'");
});

test('actual dispatcher finalizes after provider success, private pause and newly closed process store, for manual and objective content',async()=>{
  await admin.query("UPDATE public.runvara_content_receipt_control SET mode='enforced'");
  const summaries=await runStagedReceiptClosurePgTests({admin,withService:fn=>fn(service)});
  assert.equal(summaries.length,2);console.log('STAGED_RECEIPT_CLOSURE='+JSON.stringify(summaries));
});

test('raw fractional JSONB sessions that round in JavaScript remain rejected exactly like SQL',async()=>{
  const f=await seed(), input=inputFor(f);await adapter(openStage).publish(f.workspaceId,actor,input);
  const observations=[];
  for(const [literal,expected]of [['1.000',false],['1e0',true],['10e-1',false],['1.0000000000000000000000000000001',false],['0.9999999999999999999999999999999',false],['9007199254740991.00000000000001',false]]){
    await admin.query("UPDATE public.saas_workspace_state SET state=jsonb_set(state,'{users,0,sessionVersion}',$2::jsonb) WHERE workspace_id=$1",[f.workspaceId,literal]);
    let a=true,b=true,sqlState=null;try{await adapter().publish(f.workspaceId,actor,input);}catch{a=false;}try{await service.query(callSql,sqlValues(businessOutcomePublicationParams(f.workspaceId,actor,input)));}catch(error){b=false;sqlState=error.code;}
    const stored=(await admin.query("SELECT state#>>'{users,0,sessionVersion}' token FROM public.saas_workspace_state WHERE workspace_id=$1",[f.workspaceId])).rows[0].token;
    observations.push({literal,stored,jsAccepted:a,sqlAccepted:b,sqlState,expected});
  }
  console.log('STAGED_SESSION_LEXICAL_PROOF='+JSON.stringify(observations));
  for(const row of observations){assert.equal(row.sqlAccepted,row.expected,row.literal+' SQL contract');assert.equal(row.jsAccepted,row.sqlAccepted,row.literal+' SQL parity');}
});

test('text-extracted actor ID duplicates and maximum safe session fractional lexemes agree with SQL',async()=>{
  for(const id of ['1','true']){
    const f=await seed(), chosen={id,sessionVersion:1};f.state.users[0].id=id;await setState(f,f.state);const input=inputFor(f);await adapter(openStage).publish(f.workspaceId,chosen,input);
    f.state=await stateFor(f);f.state.users.push({id:id==='1'?1:true,role:'owner'});await setState(f,f.state);
    await assert.rejects(adapter().publish(f.workspaceId,chosen,input),{code:'OUTCOME_OWNER_SESSION_CHANGED'});
    await assert.rejects(service.query(callSql,sqlValues(businessOutcomePublicationParams(f.workspaceId,chosen,input))),{code:'P0O03'});
  }
  const f=await seed(), chosen={id:'owner',sessionVersion:Number.MAX_SAFE_INTEGER};f.state.users[0].sessionVersion=chosen.sessionVersion;await setState(f,f.state);
  const input=inputFor(f);await adapter(openStage).publish(f.workspaceId,chosen,input);
  await admin.query("UPDATE public.saas_workspace_state SET state=jsonb_set(state,'{users,0,sessionVersion}','9007199254740991.00000000000001'::jsonb) WHERE workspace_id=$1",[f.workspaceId]);
  await assert.rejects(adapter().publish(f.workspaceId,chosen,input),{code:'OUTCOME_OWNER_SESSION_CHANGED'});
  await assert.rejects(service.query(callSql,sqlValues(businessOutcomePublicationParams(f.workspaceId,chosen,input))),{code:'P0O03'});
});

test('full schema reapply preserves existing receipt and recovery SQL definitions, private latches and quota accounting',async()=>{
  const snapshot=async()=>({definitions:(await admin.query("SELECT proname,pg_get_functiondef(oid) definition,proacl::text acl FROM pg_proc WHERE pronamespace='public'::regnamespace AND (proname LIKE 'runvara_%content_receipt%' OR proname LIKE 'runvara_%order_recovery%') ORDER BY proname")).rows,
    receipt:(await admin.query('SELECT * FROM public.runvara_content_receipt_control')).rows,recovery:(await admin.query('SELECT * FROM public.runvara_order_recovery_control')).rows,
    quotas:(await admin.query('SELECT scope_key,quota FROM public.runvara_content_receipt_quotas ORDER BY scope_key')).rows});
  const before=await snapshot(); await admin.query(baseline); assert.deepEqual(await snapshot(),before);
  const f=await seed(), input=inputFor(f), published=await adapter().publish(f.workspaceId,actor,input);assert.equal(published.isCurrent,true);
  assert.equal((await adapter().publish(f.workspaceId,actor,input)).replayed,true); await capabilityProfile('schema.sql reapply');
});
