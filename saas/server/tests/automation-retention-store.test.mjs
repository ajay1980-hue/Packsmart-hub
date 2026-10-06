import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
import { dueRules, valueSummary } from '../lib/control.mjs';
import { createScheduler } from '../lib/scheduler.mjs';
import { planAutomationRetention, applyAutomationRetention, isAutomationArchiveStub, automationArchivePayloadDigest } from '../lib/automation-retention.mjs';

const WORKSPACE = 'tenant-retention';
function run(id, index = 0, count = 250, bytes = 5000) {
  const now = Date.now(), day = Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00.000Z');
  const timestamp = new Date(day + Math.floor(Math.max(0, now-day-1) * (count-index) / (count+1))).toISOString();
  return { id, ruleId:'profitGuard', status:'COMPLETED', startedAt:timestamp, completedAt:timestamp,
    leaseUntil:timestamp, risk:'low', spend:0, errorCode:null, evidence:[{type:'recorded',id,detail:'x'.repeat(bytes)}] };
}
function workspace(count = 250, bytes = 5000) {
  const state = seedWorkspaceState({}, { workspaceId:WORKSPACE, email:'owner@retention.test', passwordHash:'fixture' });
  state._revision = 'revision-before';
  state.automationRuns = Array.from({length:count},(_,i)=>run(`run-${String(i).padStart(4,'0')}`,i,count,bytes));
  state.autopilot.enabled = true;
  state.autopilot.rules.profitGuard.maxRunsPerDay = count;
  return state;
}
function oldErrorWorkspace(count = 500) {
  const state = workspace(0);
  state.automationRuns = Array.from({length:count}, (_,index) => {
    const timestamp = new Date(Date.now() - 3*86400000 - index*1000).toISOString();
    return {...run(`old-error-${index}`,0,1,1500),status:index%2 ? 'BLOCKED' : 'FAILED',errorCode:index%2 ? 'OWNER_APPROVAL_REQUIRED' : 'READ_FAILED',
      startedAt:timestamp,completedAt:timestamp,leaseUntil:timestamp};
  });
  return state;
}
function fixture(initialState = workspace(), controls = {}) {
  const base = fakeSupabase({ initialStates:[initialState] }), calls = [], archives = new Map();
  let archivePosts = 0;
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : null;
    const call = {url,method,headers:options.headers,body:options.body || '',bytes:Buffer.byteLength(options.body || '')}; calls.push(call);
    if (url.pathname.endsWith('/runvara_history')) {
      if (method === 'POST') {
        archivePosts++;
        if (controls.failArchiveAt === archivePosts) return Response.json({code:'57014',message:'private archive body'}, {status:503});
        for (const row of body) {
          const key = JSON.stringify([row.workspace_id,row.collection,row.record_id]);
          if (!archives.has(key) || !String(options.headers.Prefer).includes('ignore-duplicates')) archives.set(key,structuredClone(row));
        }
        await controls.afterArchive?.(body, archivePosts);
        if (controls.loseArchiveReplyAt === archivePosts) throw new Error('private network body');
        return new Response(null,{status:204});
      }
      if (controls.rawReadBody !== undefined) return new Response(controls.rawReadBody,{status:200,headers:{'Content-Type':'application/json'}});
      if (controls.readOverride) return Response.json(controls.readOverride());
      return Response.json([...archives.values()].filter(row => row.workspace_id === url.searchParams.get('workspace_id')?.slice(3)
        && row.collection === url.searchParams.get('collection')?.slice(3) && row.record_id === url.searchParams.get('record_id')?.slice(3)));
    }
    if (method === 'PATCH' && url.pathname.endsWith('/saas_workspace_state')) {
      await controls.beforePrimary?.(body);
      if (controls.failPrimary) return Response.json([]);
    }
    return base.fetchImpl(input, options);
  };
  const makeStore = (env = {}) => createStore({SUPABASE_URL:'https://retention-test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'private-service-key',...env}, {fetchImpl});
  return {store:makeStore(),makeStore,calls,archives,states:base.states,controls};
}
const archiveCalls = calls => calls.filter(call => call.url.pathname.endsWith('/runvara_history'));
const archivePosts = calls => archiveCalls(calls).filter(call => call.method === 'POST');
const primaryBodies = calls => calls.filter(call => call.method === 'PATCH' && call.url.pathname.endsWith('/saas_workspace_state'));

test('first compaction preserves quota/value counts, bounds immutable POSTs and removes all archive traffic on unchanged saves', async t => {
  const f = fixture(), state = await f.store.get(WORKSPACE), original = structuredClone(state.automationRuns);
  const beforeBytes = Buffer.byteLength(JSON.stringify(state)), beforeValue = valueSummary(state).actual;
  const due = dueRules(state).map(rule=>rule.id); f.calls.length=0;
  await f.store.save(WORKSPACE,state);
  const first = [...f.calls], firstPosts = archivePosts(first);
  assert.equal(state.automationRuns.length,250,'every current UTC quota member remains counted');
  assert.equal(state.automationRuns.filter(row=>isAutomationArchiveStub(row,WORKSPACE)).length,225);
  assert.deepEqual(valueSummary(state).actual,beforeValue); assert.deepEqual(dueRules(state).map(rule=>rule.id),due);
  assert.match(valueSummary(state).explanation,/not all-time history/);
  for (const call of firstPosts) {
    const rows=JSON.parse(call.body); assert.ok(rows.length<=200); assert.ok(call.bytes<=1048576 || (rows.length===1 && call.bytes<=2097152));
    assert.equal(call.headers.Prefer,'resolution=ignore-duplicates,return=minimal');
    assert.equal(call.url.searchParams.get('on_conflict'),'workspace_id,collection,record_id');
    assert.ok(rows.every(row=>!Object.hasOwn(row,'archived_at') && !Object.hasOwn(row.payload,'archive')));
  }
  assert.equal(firstPosts.length,2); assert.equal(archiveCalls(first).some(call=>call.method==='GET'),false);
  const firstPrimaryIndex=first.findIndex(call=>call.method==='PATCH');
  assert.ok(first.findLastIndex(call=>call.url.pathname.endsWith('/runvara_history'))<firstPrimaryIndex);
  const afterBytes=Buffer.byteLength(JSON.stringify(state)); assert.ok(afterBytes<beforeBytes*0.3);
  const archiveSnapshot=structuredClone([...f.archives.values()]); f.calls.length=0;
  await f.store.save(WORKSPACE,state);
  const unchanged=[...f.calls]; assert.equal(archiveCalls(unchanged).length,0);
  assert.deepEqual([...f.archives.values()],archiveSnapshot,'stubs never overwrite archived full versions');
  assert.ok(primaryBodies(unchanged).every(call=>{
    const retained=JSON.parse(call.body).state.automationRuns.find(row=>row.id===original[100].id);
    return retained.evidence.length===0 && retained.evidenceCount===original[100].evidence.length;
  }));
  t.diagnostic(JSON.stringify({runs:250,compacted:225,initialStateBytes:beforeBytes,compactedStateBytes:afterBytes,
    firstArchiveRequests:firstPosts.length,firstArchiveBodyBytes:firstPosts.reduce((sum,call)=>sum+call.bytes,0),
    unchangedArchiveRequests:0,unchangedArchiveBodyBytes:0,firstTotalRequests:first.length,unchangedTotalRequests:unchanged.length,
    firstPrimaryBodyBytes:primaryBodies(first).reduce((sum,call)=>sum+call.bytes,0),unchangedPrimaryBodyBytes:primaryBodies(unchanged).reduce((sum,call)=>sum+call.bytes,0)}));
});

test('partial archive failure leaves full caller and primary records intact; confirmed retry never overwrites versions', async () => {
  const f=fixture(workspace(),{failArchiveAt:2}), state=await f.store.get(WORKSPACE);
  const array=state.automationRuns, before=JSON.stringify(state), persisted=JSON.stringify(f.states.get(WORKSPACE));
  await assert.rejects(()=>f.store.save(WORKSPACE,state),error=>error.httpStatus===503);
  assert.equal(state.automationRuns,array); assert.equal(JSON.stringify(state),before); assert.equal(JSON.stringify(f.states.get(WORKSPACE)),persisted);
  assert.equal(primaryBodies(f.calls).length,0); const acknowledgedBefore=structuredClone([...f.archives.values()]);
  f.controls.failArchiveAt=null; await f.store.save(WORKSPACE,state);
  for (const row of acknowledgedBefore) assert.deepEqual(f.archives.get(JSON.stringify([row.workspace_id,row.collection,row.record_id])),row);
  assert.equal(state.automationRuns.filter(row=>row.archive).length,225);
});

test('lost immutable archive reply retries the exact ignore-duplicates body once without any readback', async () => {
  const f=fixture(workspace(40,1000),{loseArchiveReplyAt:1}), state=await f.store.get(WORKSPACE); f.calls.length=0;
  await f.store.save(WORKSPACE,state); const writes=archivePosts(f.calls);
  assert.equal(writes.length,2); assert.equal(writes[0].body,writes[1].body); assert.equal(writes[0].url.href,writes[1].url.href);
  assert.equal(f.archives.size,15); assert.equal(archiveCalls(f.calls).some(call=>call.method==='GET'),false);
});

test('two replicas retain separate immutable versions and failed CAS never installs staged stubs', async () => {
  const f=fixture(workspace(26,1000)), other=f.makeStore();
  const a=await f.store.get(WORKSPACE), b=await other.get(WORKSPACE);
  b.automationRuns[25].evidence[0].detail='other replica version'.repeat(60);
  const planA=planAutomationRetention(a), planB=planAutomationRetention(b), refA=planA.archiveCandidates[0].reference, refB=planB.archiveCandidates[0].reference;
  assert.notEqual(refA.recordId,refB.recordId);
  await f.store.save(WORKSPACE,a); const original=b.automationRuns, revision=b._revision;
  await assert.rejects(()=>other.save(WORKSPACE,b),error=>error.code==='STATE_CONFLICT');
  assert.equal(b.automationRuns,original); assert.equal(b._revision,revision); assert.equal(b.automationRuns[25].archive,undefined);
  assert.equal(f.archives.size,2);
  assert.equal((await f.store.getArchivedAutomationRun(WORKSPACE,refA.runId,refA)).evidence[0].detail,'x'.repeat(1000));
  assert.equal((await f.store.getArchivedAutomationRun(WORKSPACE,refB.runId,refB)).evidence[0].detail,'other replica version'.repeat(60));
});

test('source changes during archival invalidate the plan rather than compacting changed evidence', async () => {
  const f=fixture(workspace(26,1000)), state=await f.store.get(WORKSPACE), array=state.automationRuns;
  f.controls.afterArchive=()=>{state.automationRuns[25].evidence.push({type:'later',id:'new-evidence'});};
  await assert.rejects(()=>f.store.save(WORKSPACE,state),error=>error.code==='RETENTION_PLAN_STALE');
  assert.equal(primaryBodies(f.calls).length,0); assert.equal(state.automationRuns,array); assert.equal(state.automationRuns[25].archive,undefined);
  assert.equal(state.automationRuns[25].evidence.at(-1).id,'new-evidence');
});

test('exact on-demand archive reads verify tenant, run, version and canonical digest without workspace hydration', async () => {
  const f=fixture(workspace(26,1000)), state=await f.store.get(WORKSPACE); await f.store.save(WORKSPACE,state);
  const stub=state.automationRuns[25], ref=stub.archive; f.calls.length=0;
  const full=await f.store.getArchivedAutomationRun(WORKSPACE,stub.id,ref);
  assert.equal(full.id,stub.id); assert.equal(automationArchivePayloadDigest(full),ref.sha256); assert.equal(f.calls.length,1);
  const query=f.calls[0].url.searchParams;
  assert.equal(query.get('workspace_id'),`eq.${WORKSPACE}`); assert.equal(query.get('collection'),'eq.automationRuns');
  assert.equal(query.get('record_id'),`eq.${ref.recordId}`); assert.equal(query.get('limit'),'1');
  assert.equal(query.get('select'),'workspace_id,collection,record_id,payload');
  for(const [tenant,id,reference] of [['other',stub.id,ref],[WORKSPACE,'other-run',ref],
    [WORKSPACE,stub.id,{...ref,schema:'runvara-automation-run-archive/v2'}],[WORKSPACE,stub.id,{...ref,table:'saas_workspace_state'}]]) {
    const before=f.calls.length;
    await assert.rejects(()=>f.store.getArchivedAutomationRun(tenant,id,reference),error=>error.code==='AUTOMATION_ARCHIVE_REFERENCE_INVALID');
    assert.equal(f.calls.length,before);
  }
  const row=[...f.archives.values()][0];
  for(const corrupt of [{...row,workspace_id:'other'},{...row,collection:'workRecords'},
    {...row,payload:{...row.payload,evidence:[{detail:'private corrupt body'}]}}]) {
    f.controls.readOverride=()=>[corrupt];
    await assert.rejects(()=>f.store.getArchivedAutomationRun(WORKSPACE,stub.id,ref),error=>error.code==='AUTOMATION_ARCHIVE_INTEGRITY_FAILED'&&!JSON.stringify(error).includes('private'));
  }
  f.controls.readOverride=()=>[]; assert.equal(await f.store.getArchivedAutomationRun(WORKSPACE,stub.id,ref),null);
  const file=createStore({SAAS_STATE_FILE:'/unused-archive-test'});
  await assert.rejects(()=>file.getArchivedAutomationRun(WORKSPACE,stub.id,ref),error=>error.code==='AUTOMATION_ARCHIVE_UNAVAILABLE');
  await assert.rejects(()=>f.store.archiveHistory(WORKSPACE,'automationRuns',[stub]),error=>error.code==='AUTOMATION_ARCHIVE_VERSION_REQUIRED');
});

test('expired valid stubs are evicted without archive rewrites or history reads', async () => {
  const historical=workspace(26,1000); historical.automationRuns=historical.automationRuns.map((row,index)=>({...row,
    startedAt:new Date(Date.parse('2026-01-01T19:00:00Z')-index*1000).toISOString(),completedAt:new Date(Date.parse('2026-01-01T19:00:00Z')-index*1000).toISOString()}));
  const plan=planAutomationRetention(historical,{now:new Date('2026-01-01T20:00:00Z')});
  const applied=applyAutomationRetention(plan,{acknowledgedArchives:plan.archiveCandidates.map(candidate=>({...candidate.reference,confirmed:true}))});
  historical.automationRuns=applied.automationRuns; assert.ok(historical.automationRuns[25].archive);
  const f=fixture(historical), state=await f.store.get(WORKSPACE); f.calls.length=0;
  await f.store.save(WORKSPACE,state); assert.equal(state.automationRuns.length,25); assert.equal(archiveCalls(f.calls).length,0);
});

test('explicit archive reads reject oversized wire responses and JSON roundtrip expansion', async () => {
  const f=fixture(workspace(26,1000)), state=await f.store.get(WORKSPACE); await f.store.save(WORKSPACE,state);
  const stub=state.automationRuns[25];
  f.controls.rawReadBody=' '.repeat(2097152)+'[]';
  await assert.rejects(()=>f.store.getArchivedAutomationRun(WORKSPACE,stub.id,stub.archive),error=>error.code==='AUTOMATION_ARCHIVE_UNAVAILABLE');
  // Short exponent spellings can parse below the wire cap but serialize above it.
  f.controls.rawReadBody='['+Array(110000).fill('1e20').join(',')+']';
  assert.ok(Buffer.byteLength(f.controls.rawReadBody)<2097152);
  assert.ok(Buffer.byteLength(JSON.stringify(JSON.parse(f.controls.rawReadBody)))>2097152);
  await assert.rejects(()=>f.store.getArchivedAutomationRun(WORKSPACE,stub.id,stub.archive),error=>error.code==='AUTOMATION_ARCHIVE_UNAVAILABLE');
});

test('real scheduler claim/save/finish/save preserves the live run object through retention', async () => {
  const initial=workspace(40,1000); initial.autopilot.timeZone='UTC'; initial.autopilot.morningHour=0;
  for(const key of Object.keys(initial.automations)) initial.automations[key]=key==='dailyOpsBrief';
  const f=fixture(initial); const originalSave=f.store.save.bind(f.store); let activeHandle=null;
  f.store.save=async(workspaceId,state)=>{
    const active=state.automationRuns.find(row=>row.status==='IN PROGRESS');
    const result=await originalSave(workspaceId,state);
    if(active){assert.ok(state.automationRuns.includes(active));activeHandle=active;}
    return result;
  };
  const scheduler=createScheduler({store:f.store,integrations:{},withWorkspaceLock:async(_id,callback)=>callback(),
    currentBrief:()=>({id:'brief-safe',summary:'Recorded local brief'}),env:{},enabled:false});
  const result=await scheduler.runWorkspace(WORKSPACE);
  assert.equal(result.skipped,false); assert.equal(result.runs.length,1); assert.equal(result.runs[0],activeHandle);
  assert.equal(activeHandle.status,'COMPLETED'); assert.equal(activeHandle.evidence[0].id,'brief-safe');
  const persisted=f.states.get(WORKSPACE).automationRuns.find(row=>row.id===activeHandle.id);
  assert.equal(persisted.status,'COMPLETED'); assert.deepEqual(persisted.evidence,activeHandle.evidence);
  assert.equal(archiveCalls(f.calls).some(call=>call.method==='GET'),false);
});

test('500 old terminal errors compact to latest-per-rule with immutable archive-only versions and readable FAILED/BLOCKED evidence', async () => {
  const f=fixture(oldErrorWorkspace()),state=await f.store.get(WORKSPACE),beforeBytes=Buffer.byteLength(JSON.stringify(state));
  const latest=state.automationRuns[0],plan=planAutomationRetention(state);
  assert.equal(plan.archiveCandidates.length,499); assert.ok(plan.archiveCandidates.every(candidate=>candidate.targetAction==='archive-only'));
  f.calls.length=0; await f.store.save(WORKSPACE,state);
  assert.equal(state.automationRuns.length,1); assert.equal(state.automationRuns[0],latest);
  assert.equal(state.automationRuns.some(row=>row.archive),false,'terminal errors never become quota stubs');
  assert.equal(f.archives.size,499); assert.equal(archivePosts(f.calls).length,3);
  assert.ok(archivePosts(f.calls).every(call=>JSON.parse(call.body).length<=200 && call.bytes<=1048576 && call.headers.Prefer==='resolution=ignore-duplicates,return=minimal'));
  assert.ok(Buffer.byteLength(JSON.stringify(state))<beforeBytes*0.05);
  for(const status of ['FAILED','BLOCKED']) {
    const candidate=plan.archiveCandidates.find(item=>item.row.payload.status===status);
    const restored=await f.store.getArchivedAutomationRun(WORKSPACE,candidate.reference.runId,candidate.reference);
    assert.deepEqual(restored,candidate.row.payload); assert.equal(restored.status,status); assert.ok(restored.evidence.length);
  }
  const archiveSnapshot=structuredClone([...f.archives.values()]); f.calls.length=0;
  await f.store.save(WORKSPACE,state);
  assert.equal(archiveCalls(f.calls).length,0); assert.deepEqual([...f.archives.values()],archiveSnapshot);
  const candidate=plan.archiveCandidates[0];
  for(const status of ['IN PROGRESS','running','REQUIRES APPROVAL','unknown']) {
    f.controls.readOverride=()=>[{...candidate.row,payload:{...candidate.row.payload,status}}];
    await assert.rejects(()=>f.store.getArchivedAutomationRun(WORKSPACE,candidate.reference.runId,candidate.reference),error=>error.code==='AUTOMATION_ARCHIVE_INTEGRITY_FAILED');
  }
});

test('partial terminal-error archive failure preserves all 500 full records and retry never overwrites acknowledged versions', async () => {
  const f=fixture(oldErrorWorkspace(),{failArchiveAt:2}),state=await f.store.get(WORKSPACE);
  const originalArray=state.automationRuns,original=JSON.stringify(state),persisted=JSON.stringify(f.states.get(WORKSPACE));
  await assert.rejects(()=>f.store.save(WORKSPACE,state),error=>error.httpStatus===503);
  assert.equal(state.automationRuns,originalArray); assert.equal(state.automationRuns.length,500);
  assert.equal(JSON.stringify(state),original); assert.equal(JSON.stringify(f.states.get(WORKSPACE)),persisted); assert.equal(primaryBodies(f.calls).length,0);
  const acknowledged=structuredClone([...f.archives.values()]); assert.equal(acknowledged.length,200);
  f.controls.failArchiveAt=null; await f.store.save(WORKSPACE,state);
  assert.equal(state.automationRuns.length,1); assert.equal(f.archives.size,499);
  for(const row of acknowledged) assert.deepEqual(f.archives.get(JSON.stringify([row.workspace_id,row.collection,row.record_id])),row);
});

test('same-ID FAILED/BLOCKED versions remain independently readable and losing CAS cannot evict error records', async () => {
  const f=fixture(oldErrorWorkspace(2)),other=f.makeStore(),a=await f.store.get(WORKSPACE),b=await other.get(WORKSPACE);
  b.automationRuns[1].status='FAILED'; b.automationRuns[1].errorCode='DIFFERENT_FAILURE'; b.automationRuns[1].evidence[0].detail='Second immutable error version';
  const refA=planAutomationRetention(a).archiveCandidates[0].reference,refB=planAutomationRetention(b).archiveCandidates[0].reference;
  assert.equal(refA.runId,refB.runId); assert.notEqual(refA.recordId,refB.recordId);
  await f.store.save(WORKSPACE,a); const original=b.automationRuns,revision=b._revision;
  await assert.rejects(()=>other.save(WORKSPACE,b),error=>error.code==='STATE_CONFLICT');
  assert.equal(b.automationRuns,original); assert.equal(b.automationRuns.length,2); assert.equal(b._revision,revision); assert.equal(f.states.get(WORKSPACE).automationRuns.length,1);
  assert.equal(f.archives.size,2);
  assert.equal((await f.store.getArchivedAutomationRun(WORKSPACE,refA.runId,refA)).status,'BLOCKED');
  const versionB=await f.store.getArchivedAutomationRun(WORKSPACE,refB.runId,refB);
  assert.equal(versionB.status,'FAILED'); assert.equal(versionB.errorCode,'DIFFERENT_FAILURE');
  assert.equal(versionB.evidence[0].detail,'Second immutable error version');
});

test('server-only disabled retention preserves full automation records while other archive retention continues', async () => {
  const initial=workspace(40,1000);
  initial.workRecords=Array.from({length:140},(_,index)=>({id:`work-${index}`,status:'COMPLETED',evidence:[{type:'recorded'}],updatedAt:new Date().toISOString()}));
  const f=fixture(initial),disabled=f.makeStore({AUTOMATION_RETENTION_ENABLED:'false'});
  assert.equal(f.store.diagnostics().automationRetentionEnabled,true);
  assert.equal(disabled.diagnostics().automationRetentionEnabled,false);
  const state=await disabled.get(WORKSPACE),originalArray=state.automationRuns,originalRuns=structuredClone(originalArray);
  f.calls.length=0; await disabled.save(WORKSPACE,state);
  assert.equal(state.automationRuns,originalArray); assert.deepEqual(state.automationRuns,originalRuns);
  assert.equal(state.automationRuns.some(row=>row.archive),false);
  assert.equal(state.workRecords.length,100,'the flag only disables automation retention');
  assert.equal([...f.archives.values()].filter(row=>row.collection==='automationRuns').length,0);
  assert.equal([...f.archives.values()].filter(row=>row.collection==='workRecords').length,40);
  assert.ok(archivePosts(f.calls).every(call=>JSON.parse(call.body).every(row=>row.collection!=='automationRuns')));
  assert.equal(archiveCalls(f.calls).some(call=>call.method==='GET'),false);
});

test('disabled retention keeps existing aged stubs readable and counted without eviction, hydration or legacy upsert', async () => {
  const initial=workspace(26,1000),past=new Date(Date.now()-3*86400000);
  initial.automationRuns=initial.automationRuns.map((row,index)=>({...row,
    startedAt:new Date(past.getTime()-index).toISOString(),completedAt:new Date(past.getTime()-index).toISOString()}));
  const plan=planAutomationRetention(initial,{now:past});
  initial.automationRuns=applyAutomationRetention(plan,{acknowledgedArchives:plan.archiveCandidates.map(candidate=>({...candidate.reference,confirmed:true}))}).automationRuns;
  const stub=initial.automationRuns[25]; assert.ok(isAutomationArchiveStub(stub,WORKSPACE));
  const f=fixture(initial),disabled=f.makeStore({AUTOMATION_RETENTION_ENABLED:'false'});
  for(const candidate of plan.archiveCandidates) f.archives.set(JSON.stringify([candidate.row.workspace_id,candidate.row.collection,candidate.row.record_id]),structuredClone(candidate.row));
  const state=await disabled.get(WORKSPACE),before=structuredClone(state.automationRuns),counts=valueSummary(state).actual;
  f.calls.length=0; await disabled.save(WORKSPACE,state);
  assert.deepEqual(state.automationRuns,before); assert.equal(state.automationRuns.length,26);
  assert.deepEqual(valueSummary(state).actual,counts); assert.equal(archiveCalls(f.calls).length,0);
  assert.deepEqual(await disabled.getArchivedAutomationRun(WORKSPACE,stub.id,stub.archive),plan.archiveCandidates[0].row.payload);
  assert.equal(archiveCalls(f.calls).length,1); assert.equal(archiveCalls(f.calls)[0].method,'GET');
  await assert.rejects(()=>disabled.archiveHistory(WORKSPACE,'automationRuns',[stub]),error=>error.code==='AUTOMATION_ARCHIVE_VERSION_REQUIRED');
});
