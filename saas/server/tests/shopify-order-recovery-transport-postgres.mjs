// Actual application store + importer through a minimal local PostgREST/SQL
// transport. All rows, credentials and provider responses are synthetic.
import assert from 'node:assert/strict';
import { before,after,test } from 'node:test';
import { readFile,readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { createStore } from '../lib/store.mjs';
import { createOrderRecoveryRunner } from '../lib/shopify-order-recovery-run.mjs';
import { recoveryFixture } from './shopify-order-recovery-fixture.mjs';
import { beginConnectionSync } from '../lib/connection-centre.mjs';
import { createShopifyOrderRecoveryBinding } from '../lib/shopify-order-recovery.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { monitoredSync } from '../lib/scheduler.mjs';

const sharedFixture=!process.env.ORDER_RECOVERY_TEST_DATABASE_URL;
assert.equal(sharedFixture?process.env.OUTCOME_ALLOW_DISPOSABLE_TEST_DB:process.env.ORDER_RECOVERY_ALLOW_DISPOSABLE_TEST_DB,'1');
const baseConnectionString=sharedFixture?process.env.OUTCOME_TEST_DATABASE_URL:process.env.ORDER_RECOVERY_TEST_DATABASE_URL,url=new URL(baseConnectionString);
assert.ok(['postgres:','postgresql:'].includes(url.protocol));assert.equal(url.username,'postgres');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,sharedFixture?'/runvara_outcome_test':'/runvara_order_recovery_test');assert.equal(url.search,'');assert.equal(url.hash,'');
let connectionString=baseConnectionString;
const {Client}=createRequire(new URL('./atomic-usage/package.json',import.meta.url))('pg');
let admin,service,baseAdmin,createdDatabase;
before(async()=>{
  if(sharedFixture) {
    baseAdmin=new Client({connectionString:baseConnectionString,ssl:false});await baseAdmin.connect();assert.equal(baseAdmin.connection.stream.remoteAddress,'127.0.0.1');
    assert.equal((await baseAdmin.query('select current_database() db,current_user role')).rows[0].db,'runvara_outcome_test');
    createdDatabase='runvara_recovery_transport_'+crypto.randomBytes(8).toString('hex');
    await baseAdmin.query('create database "'+createdDatabase+'"');const child=new URL(baseConnectionString);child.pathname='/'+createdDatabase;connectionString=child.toString();
  }
  admin=new Client({connectionString,ssl:false});await admin.connect();assert.equal(admin.connection.stream.remoteAddress,'127.0.0.1');
  assert.equal((await admin.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'")).rows[0].n,0);
  await admin.query("do $$ begin if not exists(select from pg_roles where rolname='anon') then create role anon nologin;end if;if not exists(select from pg_roles where rolname='authenticated') then create role authenticated nologin;end if;if not exists(select from pg_roles where rolname='service_role') then create role service_role nologin bypassrls;end if;end $$;grant usage on schema public to anon,authenticated,service_role");
  await admin.query(await readFile(new URL('../supabase/schema.sql',import.meta.url),'utf8'));
  const migrations=await readdir(new URL('../supabase/migrations/',import.meta.url));
  for(const name of migrations.filter(n=>/^20261007(074031|100823|175355)|^20261008055400|^20261008144414|^20261008163558/.test(n)).sort())await admin.query(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  const name=migrations.find(n=>n.endsWith('_bounded_shopify_order_recovery_rebuilt.sql'));await admin.query(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
  await admin.query("update public.runvara_order_recovery_control set mode='enforced'");
  service=new Client({connectionString,ssl:false});await service.connect();await service.query('set role service_role');
});
after(async()=>{
  await service?.end();await admin?.end();
  if(createdDatabase){assert.match(createdDatabase,/^runvara_recovery_transport_[a-f0-9]{16}$/);await baseAdmin.query('drop database "'+createdDatabase+'"');assert.equal((await baseAdmin.query('select count(*)::int n from pg_database where datname=$1',[createdDatabase])).rows[0].n,0);console.log('Verified disposable transport database removed.');}
  await baseAdmin?.end();
});
const ident=value=>{assert.match(value,/^[A-Za-z_][A-Za-z0-9_]*$/);return '"'+value+'"';};
function projection(select) {
  return select.split(',').map(expression=>{
    const match=/^(?:([A-Za-z_]\w*):)?(workspace_id|state)((?:(?:->>|->)(?:[A-Za-z_]\w*|\d+))*)$/.exec(expression);assert.ok(match,expression);
    let[,alias,column,path]=match,sql=ident(column),last=column;
    for(const[,op,segment]of path.matchAll(/(->>|->)([A-Za-z_]\w*|\d+)/g)){sql+=op+(/^\d+$/.test(segment)?segment:"'"+segment+"'");last=segment;}
    return sql+' as '+ident(alias||last);
  }).join(',');
}
async function fixture({count=51,first=false}={}) {
  const f=recoveryFixture({count,workspaceId:'transport_'+crypto.randomUUID()}),calls=[],control={lose:null,lookupNull:false,advanceAfterFinal:false,failCleanup:false,contexts:0,beforeContext:null};
  if(first) {f.state.connectionFirstSync={shopify:{status:'failed',startedAt:new Date().toISOString(),actor:f.actor.id,identityVerifiedAt:new Date().toISOString(),areas:{orders:'failed',products:'failed'},failures:{orders:{code:'OLD'},products:{code:'PRODUCT_FAILED'}},validation:{ok:false},completedAt:null}};f.state.integrationStatus.shopify={status:'degraded',lastError:'PRODUCT_FAILED',areaSuccessAt:{products:'2026-09-01T00:00:00.000Z'}};}
  f.state.users[0].email=f.state.workspace.id+'@recovery.test';
  await admin.query('insert into public.workspaces(id,name,slug) values($1,$1,$1)',[f.state.workspace.id]);
  await admin.query('insert into public.saas_workspace_state(workspace_id,state) values($1,$2)',[f.state.workspace.id,f.state]);
  const fetchImpl=async(input,options={})=>{
    const u=new URL(input),name=u.pathname.split('/').at(-1),body=options.body?JSON.parse(options.body):null,method=options.method||'GET';calls.push({name,method,body});
    assert.equal(u.hostname,'recovery.supabase.test','Unexpected network destination in local PostgreSQL transport');
    try {
      if (name==='saas_workspace_state') {
        const ws=u.searchParams.get('workspace_id').slice(3),revision=u.searchParams.get('state->>_revision')?.slice(3);
        if(method==='PATCH')return Response.json((await service.query('update public.saas_workspace_state set state=$2,updated_at=$3 where workspace_id=$1 and state->>\'_revision\'=$4 returning workspace_id',[ws,body.state,body.updated_at,revision])).rows);
        return Response.json((await service.query('select '+projection(u.searchParams.get('select'))+' from public.saas_workspace_state where workspace_id=$1'+(revision?' and state->>\'_revision\'=$2':'')+' limit 2',revision?[ws,revision]:[ws])).rows);
      }
      if(/^runvara_(reserve|append|finalize|read|lookup)_order_recovery$/.test(name)) {
        if(name==='runvara_read_order_recovery'&&JSON.parse(body.p_request).view==='context')await control.beforeContext?.(++control.contexts);
        if(name.includes('lookup')&&control.lookupNull)return Response.json(null);
        const result=(await service.query('select public.'+ident(name)+'($1) result',[body.p_request])).rows[0].result;
        if(name.includes('finalize')&&control.advanceAfterFinal)await admin.query("update public.saas_workspace_state set state=jsonb_set(state,'{_revision}',to_jsonb($2::text)) where workspace_id=$1",[f.state.workspace.id,crypto.randomUUID()]);
        if(control.lose&&name.includes(control.lose)){control.lose=null;throw Object.assign(new Error('synthetic lost reply'),{lost:true});}
        return Response.json(result);
      }
      if(name==='runvara_commit_reporting_status')return Response.json((await service.query('select * from public.runvara_commit_reporting_status($1,$2,$3,$4,$5)',[body.p_workspace_id,body.p_expected_revision,body.p_next_revision,body.p_report,body.p_updated_at])).rows);
      if(method==='POST') {
        assert.ok(Array.isArray(body));if(!body.length)return new Response(null,{status:204});
        const columns=Object.keys(body[0]),conflict=u.searchParams.get('on_conflict').split(','),updates=columns.filter(key=>!conflict.includes(key));
        const statement='insert into public.'+ident(name)+'('+columns.map(ident).join(',')+') select '+columns.map(ident).join(',')+' from jsonb_populate_recordset(null::public.'+ident(name)+',$1::jsonb) on conflict('+conflict.map(ident).join(',')+') '+(updates.length?'do update set '+updates.map(key=>ident(key)+'=excluded.'+ident(key)).join(','):'do nothing');
        await service.query(statement,[JSON.stringify(body)]);return new Response(null,{status:204});
      }
      const ws=u.searchParams.get('workspace_id')?.slice(3);return Response.json((await service.query('select * from public.'+ident(name)+(ws?' where workspace_id=$1':''),ws?[ws]:[])).rows);
    } catch(error) {
      if(error.lost)throw new TypeError('synthetic dropped PostgREST response');
      if(error.message==='ORDER_RECOVERY_STATE_SCOPE'){const p=JSON.parse(body.p_request);const diff=(await admin.query('select public.runvara_recovery_stable(state) old,public.runvara_recovery_stable($2::jsonb) next from public.saas_workspace_state where workspace_id=$1',[p.workspaceId,p.state])).rows[0];console.log(JSON.stringify({stableDifference:Object.keys({...diff.old,...diff.next}).filter(k=>JSON.stringify(diff.old[k])!==JSON.stringify(diff.next[k]))}));}
      calls.at(-1).error={code:error.code,message:error.message};console.log(JSON.stringify({name,code:error.code,message:error.message}));return Response.json({code:error.code||'XX000',message:error.message},{status:409});
    }
  };
  const store=createStore(f.env,{fetchImpl}),runner=createOrderRecoveryRunner({store,integrations:f.integrations,env:f.env});
  await store.save(f.state.workspace.id,await store.get(f.state.workspace.id));calls.length=0;
  return {...f,store,runner,calls,control,get:()=>store.get(f.state.workspace.id),persisted:async()=>(await admin.query('select state from public.saas_workspace_state where workspace_id=$1',[f.state.workspace.id])).rows[0].state};
}
async function execute(f){const state=await f.get(),preview=await f.runner.preview(state,f.actor);assert.equal(preview.canStart,true,JSON.stringify(preview));const result=await f.runner.run(state,f.actor,'start',{selection:preview.selection});return{preview,result};}
test('actual store/importer→PG reserve append promotion reporting and mirrors satisfy SQL contract',async()=>{
  const f=await fixture(),{preview,result}=await execute(f);assert.equal(result.status,'committed',JSON.stringify({result,errors:f.calls.filter(c=>c.error)}));
  const s=await f.persisted();assert.equal(s.orders.length,51);assert.equal(s.integrationStatus.shopify.lastSyncAt,preview.originalStartedAt);
  assert.equal((await admin.query('select count(*)::int n from public.runvara_order_recovery_pages where workspace_id=$1',[s.workspace.id])).rows[0].n,0);
  assert.equal((await admin.query('select count(*)::int n from public.runvara_order_recovery_receipts where workspace_id=$1',[s.workspace.id])).rows[0].n,1);
  assert.equal(f.controls.providerCalls,2);assert.ok(f.calls.some(c=>c.name==='orders'));assert.ok(f.calls.some(c=>c.name==='runvara_commit_reporting_status'));
});
test('failed unrelated first-sync areas and original area timestamps survive real final transaction',async()=>{
  const f=await fixture({count:1,first:true}),{result}=await execute(f);assert.equal(result.status,'committed',JSON.stringify({result,errors:f.calls.filter(c=>c.error)}));
  const s=await f.persisted();assert.equal(s.connectionFirstSync.shopify.status,'partial');assert.equal(s.connectionFirstSync.shopify.areas.products,'failed');assert.equal(s.integrationStatus.shopify.areaSuccessAt.products,'2026-09-01T00:00:00.000Z');assert.equal(s.integrationStatus.shopify.lastError,'PRODUCT_FAILED');
});
test('lost final ACK uses only private exact receipt and skips stale reporting/mirror maintenance after newer revision',async()=>{
  const f=await fixture({count:1});f.control.lose='finalize';f.control.advanceAfterFinal=true;const {result}=await execute(f);assert.equal(result.status,'committed',JSON.stringify({result,errors:f.calls.filter(c=>c.error)}));
  const at=f.calls.findIndex(c=>c.name==='runvara_finalize_order_recovery');assert.deepEqual(f.calls.slice(at+1).map(c=>c.name),['runvara_lookup_order_recovery']);assert.equal((await f.persisted()).orders.length,1);
});
test('unconfirmed final stays held when later explicit review has no exact private receipt proof',async()=>{
  const f=await fixture({count:1});f.control.lose='finalize';f.control.lookupNull=true;const {result}=await execute(f);assert.equal(result.status,'unknown');
  const review=await f.runner.preview(await f.get(),f.actor);assert.equal(review.reason,'ORDER_RECOVERY_UNKNOWN');assert.equal(f.controls.providerCalls,1);
  f.control.lookupNull=false;const settled=await f.runner.preview(await f.get(),f.actor);assert.notEqual(settled.reason,'ORDER_RECOVERY_UNKNOWN');assert.equal(f.controls.providerCalls,1);
});
test('explicit ordinary fresh admission durably supersedes retained recovery before failed provider response',async()=>{
  const f=await fixture({count:51}),s=await f.get(),binding=createShopifyOrderRecoveryBinding(s,f.integrations),stageId='short_'+crypto.randomUUID();
  const oldRun=beginConnectionSync(s,'shopify',{areas:['orders'],actor:f.actor.id});oldRun.leaseUntil=new Date(Date.now()+250).toISOString();oldRun.orderRecoveryStageId=stageId;
  const admission={runId:oldRun.id,leaseUntil:oldRun.leaseUntil,attempt:1,workspaceRevision:s._revision,actorId:f.actor.id,actorSessionVersion:1,sessionDigest:f.actor.sessionDigest};
  s.connectionDoctor={...s.connectionDoctor,shopify:{attempts:1,exhausted:false,orderReadBinding:binding.source}};
  s.integrationStatus.shopify={...s.integrationStatus.shopify,orderRecovery:{schema:'shopify-order-recovery-marker/v1',stageId,runId:oldRun.id,status:'reading',attempt:1}};
  await f.store.save(s.workspace.id,s,{protectedOrderRecovery:{kind:'reserve',stageId,admission,actor:f.actor,expectedStageRevision:0,binding,expectedStatus:'reading'}});
  await delay(Math.max(0,Date.parse(oldRun.leaseUntil)-Date.now()+5));
  const run=beginConnectionSync(s,'shopify',{areas:['orders'],actor:f.actor.id});await f.store.save(s.workspace.id,s);
  assert.equal((await admin.query('select superseded from public.runvara_order_recovery_stages where workspace_id=$1',[s.workspace.id])).rows[0].superseded,true);
  f.controls.providerFailureAt=f.controls.providerCalls+1;await assert.rejects(()=>monitoredSync(s,f.integrations,'shopify',{run,retry:false}));await f.store.save(s.workspace.id,s);
  assert.equal((await admin.query('select superseded from public.runvara_order_recovery_stages where workspace_id=$1',[s.workspace.id])).rows[0].superseded,true);
});
test('definite provider failure is durably finished and explicit recovery immediately continues under a new charged admission',async()=>{
  const f=await fixture({count:51});f.controls.providerFailureAt=2;const {result,preview}=await execute(f);assert.equal(result.status,'interrupted');
  let state=await f.get();assert.equal(state.connectionSyncs[0].status,'failed');assert.equal(state.orders.length,0);
  const review=await f.runner.preview(state,f.actor);assert.equal(review.canResume,true,JSON.stringify(review));assert.equal(review.originalStartedAt,preview.originalStartedAt);
  const resumed=await f.runner.run(state,f.actor,'resume',{selection:review.selection});assert.equal(resumed.status,'committed',JSON.stringify({resumed,errors:f.calls.filter(c=>c.error)}));
  assert.equal(f.controls.providerCalls,3);state=await f.persisted();assert.equal(state.connectionDoctor.shopify.attempts,2);assert.equal(state.orders.length,51);
});
test('private control pause between token gates stops the actual importer before provider dispatch',async()=>{
  const f=await fixture({count:1});f.control.beforeContext=async count=>{if(count===2)await admin.query("update public.runvara_order_recovery_control set mode='paused'");};
  try {const {result}=await execute(f);assert.equal(result.status,'interrupted');assert.equal(f.controls.providerCalls,0);assert.equal((await f.persisted()).orders.length,0);}
  finally {await admin.query("update public.runvara_order_recovery_control set mode='enforced'");}
});
test('concurrent owner cost edit fences old completion and a fresh explicit admission preserves that edit',async()=>{
  const f=await fixture({count:1});let source=await f.get();source.orders=[{id:'gid://shopify/Order/0',externalId:'gid://shopify/Order/0',provider:'shopify',createdAt:'2026-01-01T00:00:00.000Z',total:1,lineItems:[],actualShippingCost:1,costOverrides:{actualShippingCost:1}}];await f.store.save(source.workspace.id,source);
  f.control.beforeContext=async count=>{if(count!==3)return;const current=await f.persisted();current.orders[0].actualShippingCost=17;current.orders[0].costOverrides.actualShippingCost=17;current.orders[0].costUpdatedAt=new Date().toISOString();current._revision=crypto.randomUUID();await service.query('update public.saas_workspace_state set state=$2 where workspace_id=$1',[source.workspace.id,current]);};
  // A short, otherwise ordinary ten-minute admission is obtained by advancing
  // from an earlier synthetic admission clock to real time before its SQL save.
  // No private rows/guards are edited to manufacture lease expiry.
  const actualNow=Date.now,save=f.store.save.bind(f.store);let shortened=false;
  f.store.save=async(ws,state,options)=>{if(options?.protectedOrderRecovery?.kind==='reserve'&&!shortened){shortened=true;Date.now=actualNow;}return save(ws,state,options);};
  let result;
  try {source=await f.get();const preview=await f.runner.preview(source,f.actor);Date.now=()=>actualNow()-599000;result=await f.runner.run(source,f.actor,'start',{selection:preview.selection});}
  finally {Date.now=actualNow;}
  assert.equal(result.status,'interrupted',JSON.stringify(result));assert.equal(f.controls.providerCalls,1);const edited=await f.persisted();assert.equal(edited.orders[0].actualShippingCost,17);
  await delay(Math.max(0,Date.parse(edited.connectionSyncs[0].leaseUntil)-Date.now()+5));
  const state=await f.get(),review=await f.runner.preview(state,f.actor);assert.equal(review.canResume,true,JSON.stringify(review));
  const resumed=await f.runner.run(state,f.actor,'resume',{selection:review.selection});assert.equal(resumed.status,'committed',JSON.stringify({resumed,errors:f.calls.filter(c=>c.error)}));
  assert.equal((await f.persisted()).orders[0].actualShippingCost,17);assert.equal(f.controls.providerCalls,1,'exhausted retained pages need no provider replay');
});
test('completed and unverified historical first-sync objects survive real promotion without being completed again',async()=>{
  for(const first of [
    {status:'completed',startedAt:new Date().toISOString(),actor:'old-owner',identityVerifiedAt:new Date().toISOString(),areas:{orders:'completed'},failures:{},completedAt:'2026-09-01T00:00:00.000Z'},
    {status:'failed',areas:{orders:'failed',products:'failed'},failures:{products:{code:'UNVERIFIED'}},identityVerifiedAt:null}
  ]) {
    const f=await fixture({count:1}),s=await f.get();s.connectionFirstSync={shopify:first};await f.store.save(s.workspace.id,s);
    const {result}=await execute(f);assert.equal(result.status,'committed',JSON.stringify({result,errors:f.calls.filter(c=>c.error)}));assert.deepEqual((await f.persisted()).connectionFirstSync.shopify,first);
  }
});
test('acknowledged terminal page pause retains all pages but releases the finished run for ordinary fresh admission',async()=>{
  const f=await fixture({count:501}),{result}=await execute(f);assert.equal(result.status,'interrupted');assert.equal(f.controls.providerCalls,10);
  const state=await f.get();assert.equal(state.connectionSyncs[0].status,'failed',JSON.stringify({result,errors:f.calls.filter(c=>c.error)}));assert.equal(state.integrationStatus.shopify.orderRecovery.status,'paused');assert.equal(state.orders.length,0);
  assert.equal((await admin.query('select count(*)::int n from public.runvara_order_recovery_pages where workspace_id=$1',[state.workspace.id])).rows[0].n,10);
  beginConnectionSync(state,'shopify',{areas:['orders'],actor:f.actor.id});await f.store.save(state.workspace.id,state);
  assert.equal((await admin.query('select superseded from public.runvara_order_recovery_stages where workspace_id=$1',[state.workspace.id])).rows[0].superseded,true);
});
