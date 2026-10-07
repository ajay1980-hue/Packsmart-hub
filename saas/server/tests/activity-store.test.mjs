import test from 'node:test';
import assert from 'node:assert/strict';
import {createStore,seedWorkspaceState} from '../lib/store.mjs';
import {fakeSupabase} from './fake-supabase.mjs';
const WS='activity-one', OTHER='activity-two', SECRET='never-retain-this-secret';
const env={SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:SECRET};
const activityOptions={now:()=>Date.parse('2026-10-07T00:00:00.000Z'),instanceId:'activity-test-one'};
function seeded(id=WS){const s=seedWorkspaceState({}, {workspaceId:id,email:`${id}@example.test`,passwordHash:SECRET});s._revision='old-revision';return s;}
const storeFor=fetchImpl=>createStore(env,{fetchImpl,activityOptions});

test('trusted tenant reads observe one actual request and logical response bytes without retaining body data',async()=>{
  const s=seeded(),fake=fakeSupabase({initialStates:[s]}),store=storeFor(fake.fetchImpl);
  await store.get(WS);
  const result=store.activitySnapshot(WS);
  assert.equal(fake.calls.length,1);assert.equal(result.db.attempted,1);assert.equal(result.db.completed,1);assert.equal(result.db.succeeded,1);
  assert.equal(result.db.operations.state_read,1);assert.equal(result.db.requestBody.bytes,0);
  assert.equal(result.db.responseBody.bytes,Buffer.byteLength(JSON.stringify([{state:s}])));
  assert.equal(result.db.responseBody.unknownObservations,0);assert.equal(result.hotState.confirmed.bytes,null);
  const serialized=JSON.stringify(result);for(const value of [SECRET,s.users[0].email,'synthetic.invalid','old-revision'])assert.ok(!serialized.includes(value));
  const calls=fake.calls.length;for(let i=0;i<100;i++)store.activitySnapshot(WS);assert.equal(fake.calls.length,calls,'Snapshots add no I/O');
});

test('tenant attribution never comes from URL, request body, headers or returned claimed jobs',async()=>{
  const store=storeFor(async()=>Response.json([{workspace_id:WS}]));
  await store.request(`private_table?workspace_id=eq.${WS}`,{method:'POST',headers:{'X-Workspace-Id':WS},body:JSON.stringify({workspaceId:WS})});
  await store.claimAgentJobs('worker-observation',1,300);
  const tenant=store.activitySnapshot(WS);assert.equal(tenant.coverage.status,'not_observed');assert.equal(tenant.db.attempted,null);
  const internal=store.activityMeter.instanceSnapshot();assert.equal(internal.unattributed.db.attempted,2);
  assert.equal(internal.totals.db.attempted,2);assert.ok(!JSON.stringify(tenant).includes('unattributed'));
});

test('primary cancellation retry counts API attempts and repeated logical body bytes without added operations',async()=>{
  const s=seeded();let failures=1;
  const fake=fakeSupabase({initialStates:[s],fault:({table,method})=>table==='saas_workspace_state'&&method==='PATCH'&&failures-->0?{status:500,code:'57014'}:null});
  const store=storeFor(fake.fetchImpl),next={...s,_revision:'new-revision'};
  await store.commit(WS,next,s._revision,true);
  const result=store.activitySnapshot(WS);assert.equal(fake.calls.length,2);assert.equal(result.db.attempted,2);assert.equal(result.db.failed,1);assert.equal(result.db.succeeded,1);
  assert.equal(result.db.retries.primary_statement_cancelled,1);assert.equal(result.db.requestBody.bytes,fake.calls.reduce((n,c)=>n+Buffer.byteLength(c.body),0));
  assert.equal(fake.calls[0].body,fake.calls[1].body);
  assert.equal(result.hotState.attempted.bytes,Buffer.byteLength(JSON.stringify(next)));assert.equal(result.hotState.confirmed.bytes,result.hotState.attempted.bytes);
});

test('network upsert retry remains explicitly counted with unknown response bytes for the failed attempt',async()=>{
  const calls=[];const store=storeFor(async(url,options)=>{calls.push({url,options});if(calls.length===1)throw new Error(SECRET);return new Response(null,{status:204});});
  await store.upsert('products',[{workspace_id:WS,id:'product_one'}],'workspace_id,id',{}, {workspaceId:WS,operation:'reporting_write'});
  const result=store.activitySnapshot(WS);assert.equal(calls.length,2);assert.equal(result.db.retries.upsert_network,1);
  assert.equal(result.db.outcomes.network_error,1);assert.equal(result.db.responseBody.unknownObservations,1);assert.equal(result.db.responseBody.knownObservations,1);assert.equal(result.db.responseBody.bytes,0);
  assert.ok(!JSON.stringify(result).includes(SECRET));assert.equal(calls[0].options.body,calls[1].options.body);
});

test('failed primary inputs do not replace confirmed hot-state samples and different tenants never share samples',async()=>{
  let fail=false;const fake=fakeSupabase({initialStates:[seeded(),seeded(OTHER)],fault:({table,method})=>fail&&table==='saas_workspace_state'&&method==='PATCH'?{status:500,code:'XX000'}:null});
  const store=storeFor(fake.fetchImpl),first={...seeded(),_revision:'first'};await store.commit(WS,first,'old-revision',true);
  const known=store.activitySnapshot(WS).hotState.confirmed;
  fail=true;await assert.rejects(store.commit(WS,{...first,_revision:'failed',extra:'x'.repeat(1000)},'first',true));
  const failed=store.activitySnapshot(WS);assert.deepEqual(failed.hotState.confirmed,known);assert.ok(failed.hotState.attempted.bytes>known.bytes);
  fail=false;await store.commit(OTHER,{...seeded(OTHER),_revision:'other'},'old-revision',true);
  assert.deepEqual(store.activitySnapshot(WS).hotState.confirmed,known);assert.equal(store.activitySnapshot(WS).db.attempted,2);
});

test('malformed responses are failures with measured text while oversized/incomplete bodies stay unknown',async()=>{
  let mode='malformed';const store=storeFor(async()=>new Response(mode==='malformed'?`bad JSON ${SECRET}`:'x'.repeat(100)));
  await assert.rejects(store.scopedRequest(WS,'state_read','saas_workspace_state'));
  let result=store.activitySnapshot(WS);assert.equal(result.db.outcomes.invalid_response,1);assert.equal(result.db.responseBody.bytes,Buffer.byteLength(`bad JSON ${SECRET}`));
  mode='oversized';await assert.rejects(store.scopedRequest(WS,'state_read','saas_workspace_state',{maxResponseBytes:50}));
  result=store.activitySnapshot(WS);assert.equal(result.db.outcomes.oversized_response,1);assert.equal(result.db.responseBody.unknownObservations,1);assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('job transition observations require a matched successful fenced update and do not count stale acknowledgements',async()=>{
  const job={id:'job_one',workspace_id:WS,type:'agent_command',status:'running',attempts:1,worker_id:'worker_one',lease_until:new Date(Date.now()+60000).toISOString()};let fresh=true;
  const store=storeFor(async()=>Response.json(fresh?[{...job,status:'blocked'}]:[]));
  await store.finishAgentJob(job,{status:'blocked',completedAt:new Date().toISOString()});fresh=false;
  assert.equal(await store.finishAgentJob(job,{status:'blocked',completedAt:new Date().toISOString()}),null);
  const result=store.activitySnapshot(WS);assert.equal(result.db.attempted,2);assert.equal(result.jobs.blocked,1);assert.equal(result.jobs.dead_letter,0);
});

test('normal saves retain original request volume and report reporting/archive writes only in their trusted scope',async()=>{
  const fake=fakeSupabase(),store=storeFor(fake.fetchImpl),s=seeded();delete s._revision;
  await store.save(WS,s);
  const result=store.activitySnapshot(WS);
  assert.equal(result.db.attempted,fake.calls.length);assert.equal(result.db.operations.state_commit,1);assert.equal(result.db.operations.reporting_commit,1);
  assert.ok(result.db.operations.reporting_write>0);assert.equal(store.activityMeter.instanceSnapshot().unattributed.db.attempted,0);
  assert.equal(result.db.requestBody.bytes,fake.calls.reduce((n,c)=>n+Buffer.byteLength(c.body),0));
  const before=fake.calls.length;await store.save(WS,s);
  assert.equal(fake.calls.length-before,3,'Unchanged save remains2 CAS writes plus1 existing variants read, with no meter writes');
  assert.equal(store.activitySnapshot(OTHER).db.attempted,null);
});

test('FileStore and fresh instances expose unknown DB coverage, never durable zero totals',()=>{
  const file=createStore({SAAS_STATE_FILE:'/tmp/activity-no-file-should-be-created'}, {activityOptions});
  const sample=file.activitySnapshot(WS);assert.equal(sample.coverage.dbAvailable,false);assert.equal(sample.db.attempted,null);assert.equal(sample.db.responseBody.bytes,null);
  const a=storeFor(async()=>Response.json([])),b=createStore(env,{fetchImpl:async()=>Response.json([]),activityOptions:{...activityOptions,instanceId:'activity-test-restarted'}});
  assert.notEqual(a.activitySnapshot(WS).instanceId,b.activitySnapshot(WS).instanceId);assert.equal(b.activitySnapshot(WS).db.attempted,null);
});

test('network reconciliation counts its read separately and only counts an actual repeated primary request as retry',async()=>{
  for(const committedBeforeLoss of [false,true]){
    const s=seeded(),fake=fakeSupabase({initialStates:[s]}),attempts=[];let lost=false;
    const store=storeFor(async(url,options={})=>{
      attempts.push({url:new URL(url),method:options.method||'GET',body:options.body||''});
      if(options.method==='PATCH'&&!lost){lost=true;if(committedBeforeLoss)await fake.fetchImpl(url,options);throw new Error('synthetic lost acknowledgement');}
      return fake.fetchImpl(url,options);
    });
    await store.commit(WS,{...s,_revision:'reconciled'},'old-revision',true);
    const result=store.activitySnapshot(WS);
    assert.equal(result.db.attempted,committedBeforeLoss?2:3);
    assert.equal(result.db.operations.state_read,1);assert.equal(result.db.methods.GET,1);
    assert.equal(result.db.retries.primary_network_reconciled,committedBeforeLoss?0:1);
    assert.equal(attempts.filter(x=>x.method==='PATCH').length,committedBeforeLoss?1:2);
    assert.equal(result.db.requestBody.bytes,attempts.reduce((n,c)=>n+Buffer.byteLength(c.body),0));
    assert.equal(result.db.responseBody.unknownObservations,1);assert.ok(result.hotState.confirmed.bytes>0);
  }
});
