import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
import { once } from 'node:events';
import { createPacksmartServer } from '../server.mjs';
const key = 'private-test-key-never-returned';
const env = { SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_SERVICE_ROLE_KEY: key };
const factory = fetchImpl => createStore(env,{fetchImpl});
const state = () => ({workspace:{id:'tenant-one'},_revision:'next-revision'});

test('malformed nonempty JSON and empty GET responses never become successful reads or leak content', async () => {
  for (const response of [new Response(`private malformed body ${key}`),new Response(''),new Response(null,{status:204}),new Response('   ')]) {
    const store = factory(async()=>response);
    await assert.rejects(store.request('saas_workspace_state?workspace_id=eq.tenant-one&select=state'), error => {
      assert.equal(error.code,'SUPABASE_RESPONSE_INVALID'); assert.equal(error.cause,undefined);
      assert.ok(!error.message.includes(key)); assert.ok(!error.stack.includes('private malformed')); return true;
    });
    const d=store.diagnostics(); assert.equal(d.lastSuccessfulReadAt,null); assert.ok(d.lastFailureAt);
    assert.equal(d.lastFailureCode,'SUPABASE_RESPONSE_INVALID'); assert.equal(d.lastFailureTable,'saas_workspace_state');
    assert.ok(!JSON.stringify(d).includes(key));
  }
  const store=factory(async()=>Response.json([]));
  assert.deepEqual(await store.request('saas_workspace_state?workspace_id=eq.missing&select=state'),[]);
  assert.ok(store.diagnostics().lastSuccessfulReadAt);
});

test('empty minimal writes, void workspace creation and HEAD stay valid; representation requests require JSON', async () => {
  for (const [path,options] of [['products',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'}}],
    ['rpc/runvara_create_workspace',{method:'POST'}],['saas_workspace_state',{method:'HEAD'}]]) {
    for (const status of [200,204]) {
      const store=factory(async()=>new Response(null,{status})); assert.equal(await store.request(path,options),null);
      assert.ok(store.diagnostics()[options.method==='HEAD'?'lastSuccessfulReadAt':'lastSuccessfulWriteAt']); assert.equal(store.diagnostics().lastFailureAt,null);
    }
  }
  for (const path of ['runvara_agent_jobs','rpc/runvara_reserve_provider_usage','rpc/runvara_claim_agent_jobs']) {
    const store=factory(async()=>new Response(null,{status:204}));
    await assert.rejects(store.request(path,{method:'POST',headers:{Prefer:'return=representation'}}),{code:'SUPABASE_RESPONSE_INVALID'});
    assert.equal(store.diagnostics().lastSuccessfulWriteAt,null);
  }
});

test('read-size/stream/decode failures preserve the prior successful observation and only safe diagnostics', async () => {
  let next=()=>Response.json([]); const store=factory(async()=>next());
  await store.request('workspaces'); const before=store.diagnostics().lastSuccessfulReadAt;
  for (const response of [()=>new Response('x'.repeat(20)),()=>new Response(new ReadableStream({start(controller){controller.error(new Error(key));}}))]) {
    next=response; await assert.rejects(store.request('workspaces',{maxResponseBytes:10}),error=>{
      assert.ok(['SUPABASE_RESPONSE_TOO_LARGE','SUPABASE_RESPONSE_INVALID'].includes(error.code)); assert.equal(error.cause,undefined); assert.ok(!error.stack.includes(key)); return true;
    });
    assert.equal(store.diagnostics().lastSuccessfulReadAt,before); assert.ok(store.diagnostics().lastFailureAt);
  }
});

test('metadata response support stays opt-in and is stripped from fetch options', async () => {
  const options=[]; const store=factory(async(_url,init)=>{options.push(init);return Response.json([],{headers:{'Content-Range':'*/0'}});});
  assert.deepEqual(await store.request('workspaces'),[]);
  assert.deepEqual(await store.request('workspaces',{includeResponseMetadata:true}),{data:[],contentRange:'*/0'});
  assert.ok(options.every(x=>!Object.hasOwn(x,'includeResponseMetadata')));
});

test('failed existing primary writes mark failure; a later acknowledged commit restores health even when timestamps tie', async () => {
  let failed=true; const store=factory(async()=>failed?Response.json({code:'XX000',message:key},{status:500}):Response.json([{workspace_id:'tenant-one'}]));
  store.telemetry.lastPrimaryWriteAt='9999-01-01T00:00:00.000Z';
  await assert.rejects(store.commit('tenant-one',state(),'old',true),error=>error.databaseCode==='XX000');
  assert.ok(store.diagnostics().lastPrimaryFailureAt); assert.equal(store.diagnostics().primaryPersistence,false,'Last outcome must not be guessed from wall-clock ordering');
  failed=false; await store.commit('tenant-one',state(),'old',true);
  assert.equal(store.diagnostics().primaryPersistence,true); assert.ok(store.diagnostics().lastPrimaryWriteAt);
});

test('unresolved transport failure and malformed primary acknowledgements remain unconfirmed', async () => {
  const network=factory(async()=>{throw new Error('network failed');});
  await assert.rejects(network.commit('tenant-one',state(),'old',true),{code:'SUPABASE_PERSISTENCE_FAILED'});
  assert.equal(network.diagnostics().primaryPersistence,false); assert.ok(network.diagnostics().lastPrimaryFailureAt);
  for (const value of [null,{},'not rows',[{workspace_id:'other'}]]) {
    const store=factory(async()=>Response.json(value));
    await assert.rejects(store.commit('tenant-one',state(),'old',true),{code:'SUPABASE_PERSISTENCE_RESPONSE_INVALID'});
    assert.equal(store.diagnostics().primaryPersistence,false);
  }
});

test('CAS conflicts preserve the previous primary outcome and never claim a database outage or recovery', async () => {
  const store=factory(async()=>Response.json([]));
  await assert.rejects(store.commit('tenant-one',state(),'stale',true),{code:'STATE_CONFLICT'});
  assert.equal(store.diagnostics().lastPrimaryFailureAt,null); assert.equal(store.diagnostics().primaryPersistence,true);
  store.primaryPersistenceHealthy=false; store.telemetry.lastPrimaryFailureAt='2026-01-01T00:00:00.000Z';
  await assert.rejects(store.commit('tenant-one',state(),'stale',true),{code:'STATE_CONFLICT'});
  assert.equal(store.diagnostics().primaryPersistence,false); assert.equal(store.diagnostics().lastPrimaryFailureAt,'2026-01-01T00:00:00.000Z');
});

test('duplicate new workspace identity is a conflict, not a persistence outage', async () => {
  const store=factory(async()=>Response.json({code:'23505'},{status:409}));
  await assert.rejects(store.commit('tenant-one',state(),null,false),{code:'STATE_CONFLICT'});
  assert.equal(store.diagnostics().lastPrimaryFailureAt,null); assert.equal(store.diagnostics().primaryPersistence,true);
});

test('mirror errors and deferred reporting-status commit preserve the successful primary commit', async () => {
  for (const failure of ['mirror','reporting']) {
    let reportingFailures=0;
    const fake=fakeSupabase({fault:({table,method})=>failure==='mirror'&&table==='workspaces'&&method==='POST'
      ? {status:500,code:'XX000'} : failure==='reporting'&&table==='runvara_commit_reporting_status'&&method==='POST'&&++reportingFailures===1 ? {status:500,code:'XX000'}:null});
    const store=factory(fake.fetchImpl), s=seedWorkspaceState();
    const result=await store.save(s.workspace.id,s);
    const d=store.diagnostics(); assert.ok(d.lastPrimaryWriteAt); assert.equal(d.lastPrimaryFailureAt,null); assert.equal(d.primaryPersistence,true);
    assert.ok(fake.states.has(s.workspace.id));
    if(failure==='mirror')assert.ok(d.reportingFailures>0);
    else { assert.equal(reportingFailures,1); assert.equal(result.integrationStatus.reporting.lastError,'REPORTING_STATUS_DEFERRED'); }
  }
});

test('reporting-status follow-up can neither clear an unrelated primary failure nor replace primary-write evidence', async () => {
  const store=factory(async()=>Response.json([{workspace_id:'tenant-one'}]));
  store.primaryPersistenceHealthy=false;store.telemetry.lastPrimaryFailureAt='2026-01-01T00:00:00.000Z';store.telemetry.lastPrimaryWriteAt='2025-01-01T00:00:00.000Z';
  await store.commit('tenant-one',state(),'old',true,{primary:false});
  assert.equal(store.diagnostics().primaryPersistence,false);assert.equal(store.diagnostics().lastPrimaryWriteAt,'2025-01-01T00:00:00.000Z');
});

test('narrow reporting RPC decode failures neither claim transport success nor change primary health', async () => {
  const report = { status:'connected',detail:'Synthetic reporting result.',lastSyncAt:'2026-10-07T10:00:00.000Z',lastFailureAt:null,lastError:null,failures:[] };
  for (const primaryHealthy of [false,true]) for (const [expectedCode,response] of [
    ['SUPABASE_RESPONSE_INVALID',() => new Response(`private malformed report ${key}`)],
    ['SUPABASE_RESPONSE_INVALID',() => new Response(null,{status:204})],
    ['SUPABASE_RESPONSE_INVALID',() => new Response(new ReadableStream({start(controller){controller.error(new Error(key));}}))],
    ['SUPABASE_RESPONSE_TOO_LARGE',() => new Response('x'.repeat(4097))],
    [null,() => Response.json([{workspace_id:'tenant-one'}])]
  ]) {
    let calls=0;
    const store=factory(async(url,options)=>{
      calls++;assert.equal(new URL(url).pathname,'/rest/v1/rpc/runvara_commit_reporting_status');assert.equal(options.method,'POST');
      assert.ok(Buffer.byteLength(options.body)<=16384);assert.equal(Object.hasOwn(JSON.parse(options.body),'state'),false);
      return response();
    });
    store.primaryPersistenceHealthy=primaryHealthy;
    store.telemetry.lastPrimaryFailureAt='2026-01-02T00:00:00.000Z';
    store.telemetry.lastPrimaryWriteAt='2026-01-01T00:00:00.000Z';
    store.telemetry.lastSuccessfulWriteAt='2026-01-03T00:00:00.000Z';
    let error;
    try { await store.commitReportingStatus('tenant-one',report,randomUUID(),randomUUID()); } catch (caught) { error=caught; }
    assert.equal(error?.code??null,expectedCode);
    assert.equal(calls,1,'unverified response decoding does not authorize an automatic mutation retry');
    assert.equal(store.diagnostics().primaryPersistence,primaryHealthy);
    assert.equal(store.telemetry.lastPrimaryFailureAt,'2026-01-02T00:00:00.000Z');
    assert.equal(store.telemetry.lastPrimaryWriteAt,'2026-01-01T00:00:00.000Z');
    if(error){
      assert.ok(['SUPABASE_RESPONSE_INVALID','SUPABASE_RESPONSE_TOO_LARGE'].includes(error.code));
      assert.equal(store.telemetry.lastSuccessfulWriteAt,'2026-01-03T00:00:00.000Z');
      assert.equal(store.telemetry.lastFailureCode,error.code);
      assert.doesNotMatch(JSON.stringify(store.diagnostics()),/private malformed report|private-test-key/);
    } else assert.notEqual(store.telemetry.lastSuccessfulWriteAt,'2026-01-03T00:00:00.000Z');
  }
});


test('public health diagnostics never include upstream bodies, SQL details, query/tenant identity or credentials', async t => {
  const tenant='private-tenant-sentinel', sql='private-sql-detail-sentinel', upstream='private-upstream-body-sentinel';
  let corrupt=true;
  const store=factory(async (_url,options={}) => options.method==='PATCH'
    ? Response.json({code:'XX000',message:upstream,details:sql,hint:tenant,credential:key},{status:500})
    : corrupt ? new Response(`${upstream} ${sql} ${tenant} ${key}`) : Response.json([]));
  // Keep this test's public health read isolated from the unrelated periodic
  // integrity repair task. The real store diagnostics/request/commit are used.
  store.integrityCheck=undefined;
  await assert.rejects(store.request(`saas_workspace_state?workspace_id=eq.${tenant}&select=state`),{code:'SUPABASE_RESPONSE_INVALID'});
  corrupt=false;
  const server=createPacksmartServer({NODE_ENV:'test',SESSION_SECRET:'public-health-test-session-secret-more-than-thirty-two-characters',SHOPIFY_PUBLIC_SYNC_ENABLED:'false'},
    {store,schedulerEnabled:false,agentOpsEnabled:false,fetchImpl:async()=>assert.fail('No provider network')});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await server.packsmart.drain();await new Promise(resolve=>server.close(resolve));});
  const read=async()=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/health`),body=await response.text();
    for(const value of [tenant,sql,upstream,key,'workspace_id=','select=state','https://synthetic.invalid']) assert.ok(!body.includes(value),`Public health leaked ${value}`);
    return {status:response.status,body:JSON.parse(body)};
  };
  const invalidRead=await read();assert.equal(invalidRead.body.persistence.lastFailureCode,'SUPABASE_RESPONSE_INVALID');
  await assert.rejects(store.commit(tenant,{workspace:{id:tenant},_revision:'next'},'old',true),error=>error.databaseCode==='XX000');
  const failedPrimary=await read();assert.equal(failedPrimary.status,503);assert.equal(failedPrimary.body.persistence.primaryPersistence,false);
  assert.equal(failedPrimary.body.persistence.lastFailureCode,'XX000');
});
