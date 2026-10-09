/** Fresh real-PG proof. Explicit synthetic localhost database only. No skip. */
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createShopifyOrderRecoveryBinding,createShopifyOrderRecoveryStage,appendShopifyOrderRecoveryPage,resumeShopifyOrderRecoveryStage,shopifyOrderRecoveryLogicalBytes} from '../lib/shopify-order-recovery.mjs';
import {prepareShopifyOrderRead,stageShopifyOrderRead} from '../lib/shopify-order-source.mjs';
import {validateImportedData} from '../lib/connection-doctor.mjs';
import {mergeProviderRecords} from '../lib/integrations.mjs';
const ciChild=!process.env.ORDER_RECOVERY_TEST_DATABASE_URL;
assert.equal(ciChild?process.env.OUTCOME_ALLOW_DISPOSABLE_TEST_DB:process.env.ORDER_RECOVERY_ALLOW_DISPOSABLE_TEST_DB,'1');
let connectionString=process.env.ORDER_RECOVERY_TEST_DATABASE_URL||process.env.OUTCOME_TEST_DATABASE_URL;const url=new URL(connectionString);
assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.pathname,ciChild?'/runvara_outcome_test':'/runvara_order_recovery_test');assert.equal(url.search,'');assert.equal(url.hash,'');
let baseAdmin,childDatabase;
const require=createRequire(new URL('./atomic-usage/package.json',import.meta.url)),{Client}=require('pg');
let admin,sql,protectedBefore;const clients=new Set(),schemaPath=new URL('../supabase/schema.sql',import.meta.url);
async function connect(role='service_role'){const c=new Client({connectionString,ssl:false,connectionTimeoutMillis:5000,statement_timeout:20000});await c.connect();clients.add(c);assert.equal(c.connection.stream.remoteAddress,'127.0.0.1');if(role!=='postgres')await c.query('SET ROLE '+role);return c;}
async function close(c){clients.delete(c);await c.end();}
async function using(fn,role='service_role'){const c=await connect(role);try{return await fn(c);}finally{await close(c);}}
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rawFingerprint=raw=>'sha256:'+createHash('sha256').update(raw).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const digest=value=>hash(canonical(value));
async function rpc(kind,r,c){if(!c)return using(c=>rpc(kind,r,c));return(await c.query(`SELECT public.runvara_${kind}_order_recovery($1) result`,[typeof r==='string'?r:JSON.stringify(r)])).rows[0].result;}
async function state(f){return(await admin.query('select state from public.saas_workspace_state where workspace_id=$1',[f.id])).rows[0].state;}
async function save(f,s){s._revision=randomUUID();return using(c=>c.query('update public.saas_workspace_state set state=$2 where workspace_id=$1',[f.id,s]));}
const actor=()=>({id:'owner',sessionVersion:1,sessionDigest:'a'.repeat(64),expiresAt:new Date(Date.now()+3600000).toISOString()});
async function fixture({id='recovery_'+randomUUID(),first=false,hold=null}={}){
 const startedAt=new Date(Date.now()-60000).toISOString(),a=actor();
 const s={_revision:randomUUID(),workspace:{id,name:'Synthetic',slug:id},users:[{id:a.id,role:'owner',active:true,sessionVersion:1,passwordChangeRequired:false}],
 connections:[{id:'connection-one',provider:'shopify',status:'connected',encryptedCredentials:'synthetic-not-secret',metadata:{shopDomain:'synthetic.myshopify.com',shopId:'shop-one'}}],
 connectionSettings:{shopify:{revision:0,areas:['orders'],disconnected:false}},connectionDoctor:{shopify:{}},connectionSyncs:[],
 integrationStatus:{shopify:{status:'connected',orderReadHold:hold,areaSuccessAt:{products:'2025-01-01T00:00:00.000Z'}},supabase:{}},channelData:{shopify:{}},orders:[],products:[],audit:[],workRecords:[],automationRuns:[],agentRuns:[],dailyBriefs:[]};
 if(first)s.connectionFirstSync={shopify:{status:'failed',actor:'original-owner',identityVerifiedAt:startedAt,startedAt,areas:{orders:'failed',products:'failed'},failures:{orders:{code:'OLD'},products:{code:'PRODUCT_FAILED'}},validation:{ok:false},completedAt:null}};
 await admin.query('insert into public.workspaces(id,name,slug) values($1,$1,$1)',[id]);await admin.query('insert into public.saas_workspace_state(workspace_id,state) values($1,$2)',[id,s]);
 const binding=createShopifyOrderRecoveryBinding(s,null,{startedAt});return{id,state:s,actor:a,binding,stageId:'stage_'+randomUUID(),requests:[]};
}
function reserveRequest(f,{prior=null}={}){
 const s=structuredClone(f.state),runId='sync_'+randomUUID(),now=new Date().toISOString(),leaseUntil=new Date(Date.now()+540000).toISOString();
 const admission={runId,leaseUntil,attempt:Math.max(s.connectionDoctor.shopify.attempts||0,s.connectionDoctor.shopify.pendingReadAttempts||0)+1,workspaceRevision:s._revision,actorId:f.actor.id,actorSessionVersion:f.actor.sessionVersion,sessionDigest:f.actor.sessionDigest};
 const stage=prior?resumeShopifyOrderRecoveryStage(prior,admission):createShopifyOrderRecoveryStage({id:f.stageId,binding:f.binding,admission});
 s.connectionSyncs.unshift({id:runId,provider:'shopify',areas:['orders'],automatic:false,actor:f.actor.id,status:'running',stage:'Reading selected data',startedAt:now,leaseUntil,orderRecoveryStageId:f.stageId});
 s.connectionDoctor.shopify={...s.connectionDoctor.shopify,attempts:admission.attempt,exhausted:admission.attempt>=5,orderReadBinding:f.binding.source};
 s.integrationStatus.shopify.orderRecovery={schema:'shopify-order-recovery-marker/v1',stageId:f.stageId,runId,status:stage.status,attempt:admission.attempt};
 const expectedRevision=s._revision;s._revision=randomUUID();
 return{r:{schema:'runvara-order-recovery/v1',kind:'reserve',workspaceId:f.id,stageId:f.stageId,actor:f.actor,admission,expectedStageRevision:prior?.revision||0,expectedRevision,nextRevision:s._revision,state:s,binding:f.binding},stage};
}
async function reserve(f,opts){const{r,stage}=reserveRequest(f,opts);const ack=await rpc('reserve',r);assert.equal(ack.logicalBytes,stage.logicalBytes);f.state=r.state;f.stage=stage;f.admission=r.admission;f.requests.push({kind:'reserve',r,ack});return ack;}
function order(f,id='order-one',{padding='',lines=1}={}){
 return{id,externalId:id,provider:'shopify',name:'Café 雪 😀 '+padding,createdAt:'2026-01-01T00:00:00Z',updatedAt:new Date(Date.parse(f.binding.startedAt)-1000).toISOString(),cancelledAt:null,
 financialStatus:'PAID',fulfillmentStatus:'UNFULFILLED',customerEmailHash:null,statusPageUrl:null,total:'10.00',currentTotal:'10.00',currency:'GBP',refunds:null,tax:null,currentTax:'0.00',discounts:'0.00',shippingCharged:'0.00',paymentGatewayNames:[],paymentFees:null,channelFees:null,advertisingCost:null,actualShippingCost:null,otherVariableCosts:null,
 lineItems:Array.from({length:lines},(_,i)=>({id:id+'-line-'+i,name:'Line',sku:'SKU',quantity:1,gross:'10.00',net:'10.00'}))};
}
function page(f,{orders=[order(f)],more=false,cursor='cursor-'+f.stage.pages.length}={}){return{schema:'shopify-order-recovery-page/v1',index:f.stage.pages.length,after:f.stage.after,cursor,orders,legacyBytes:Math.max(2,Buffer.byteLength(JSON.stringify(orders))),evidence:{rows:orders.length,hasNextPage:more,cursorDigest:cursor?hash(cursor):null,apiVersion:'2026-07'},capturedAt:new Date().toISOString()};}
async function append(f,p=page(f)){const r={schema:'runvara-order-recovery/v1',kind:'append',workspaceId:f.id,stageId:f.stageId,actor:f.actor,admission:f.admission,expectedStageRevision:f.stage.revision,page:p};const ack=await rpc('append',r);f.requests.push({kind:'append',r,ack});f.stage=appendShopifyOrderRecoveryPage(f.stage,p);assert.equal(ack.logicalBytes,f.stage.logicalBytes);return ack;}
async function read(f,view='full'){return rpc('read',{schema:'runvara-order-recovery/v1',workspaceId:f.id,stageId:f.stageId,actor:f.actor,view});}
async function lookup(f,item){return rpc('lookup',{schema:'runvara-order-recovery/v1',workspaceId:f.id,stageId:f.stageId,actor:f.actor,kind:item.kind,requestFingerprint:rawFingerprint(JSON.stringify(item.r))});}
function finalizeRequest(f){
 const s=structuredClone(f.state),stage=f.stage,orders=stage.pages.flatMap(p=>p.orders),finishedAt=new Date().toISOString();
 const recovery={schema:'shopify-order-recovery-observation/v1',stageId:stage.id,continued:stage.continued,originalStartedAt:stage.binding.startedAt,lastCapturedAt:stage.pages.at(-1).capturedAt,pageCaptureTimes:stage.pages.map(p=>p.capturedAt),snapshotConsistency:'unverified'};
 const read=prepareShopifyOrderRead({workspaceId:f.id,domain:f.binding.source.domain,apiVersion:f.binding.source.apiVersion},orders,stage.pages.map(p=>p.evidence),{query:stage.binding.window.query,window:stage.binding.window,startedAt:stage.binding.startedAt,finishedAt,legacyBytes:stage.legacyBytes,recovery});
 s.orders=mergeProviderRecords(s.orders,'shopify',read.orders);stageShopifyOrderRead(s,read,f.state);
 const run=s.connectionSyncs.find(r=>r.id===f.admission.runId);Object.assign(run,{status:'completed',stage:'Finished',completedAt:finishedAt,errorCode:null});
 Object.assign(s.integrationStatus.shopify,{lastSyncAt:stage.binding.startedAt,lastSuccessfulSyncAt:stage.binding.startedAt,lastError:null,areaSuccessAt:{...s.integrationStatus.shopify.areaSuccessAt,orders:stage.binding.startedAt},orderReadAttempt:{status:'complete',at:stage.binding.startedAt,retryable:false},orderRecovery:{...s.integrationStatus.shopify.orderRecovery,status:'committed'}});delete s.integrationStatus.shopify.orderReadHold;
 const first=s.connectionFirstSync?.shopify,unrelated=[...new Set([...(f.state.integrationStatus.shopify.failedAreas||[]),...Object.keys(first?.failures||{}),...Object.entries(first?.areas||{}).filter(([,status])=>status!=='completed').map(([area])=>area)])].filter(area=>area!=='orders');
 Object.assign(s.integrationStatus.shopify,{status:unrelated.length?'degraded':'connected',failedAreas:unrelated,lastError:unrelated.length?(f.state.integrationStatus.shopify.lastError??null):null});
 if(first&&stage.binding.firstSync){first.areas.orders='completed';delete first.failures.orders;first.validation=validateImportedData(s,'shopify',{areas:Object.keys(first.areas)});first.status=Object.values(first.areas).every(v=>v==='completed')&&!Object.keys(first.failures).length&&first.validation.ok?'completed':'partial';first.completedAt=finishedAt;}
 const expectedRevision=s._revision;s._revision=randomUUID();return{schema:'runvara-order-recovery/v1',kind:'finalize',workspaceId:f.id,stageId:f.stageId,actor:f.actor,admission:f.admission,expectedStageRevision:stage.revision,expectedRevision,nextRevision:s._revision,state:s};
}
async function finalize(f){const r=finalizeRequest(f);const ack=await rpc('finalize',r);f.state=r.state;f.requests.push({kind:'finalize',r,ack});return ack;}
async function isolation(fn){await admin.query('begin');try{await fn();}finally{await admin.query('rollback');}}
const rejected=async(p,code='P0Q')=>assert.rejects(p,e=>{assert.ok(e.code.startsWith(code),`${e.code}: ${e.message}`);return true;});
before(async()=>{
 if(ciChild){baseAdmin=new Client({connectionString,ssl:false,connectionTimeoutMillis:5000});await baseAdmin.connect();const info=(await baseAdmin.query("select current_database() db,current_user role,current_setting('server_version_num')::int version")).rows[0];assert.equal(info.db,'runvara_outcome_test');assert.equal(info.role,'postgres');assert.ok(info.version>=170000&&info.version<180000);childDatabase='runvara_order_recovery_'+randomUUID().replaceAll('-','');await baseAdmin.query('CREATE DATABASE '+childDatabase);const childUrl=new URL(connectionString);childUrl.pathname='/'+childDatabase;connectionString=childUrl.toString();await baseAdmin.end();baseAdmin=null;}
 admin=await connect('postgres');const info=(await admin.query("select current_database() db,current_user role,current_setting('server_version_num')::int version,current_setting('listen_addresses') listen")).rows[0];
 assert.equal(info.db,childDatabase||'runvara_order_recovery_test');assert.equal(info.role,'postgres');if(!ciChild)assert.equal(info.listen,'127.0.0.1');assert.ok(info.version>=170000&&info.version<180000);
 assert.equal((await admin.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'")).rows[0].n,0);
 await admin.query("DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role");
 await admin.query(await readFile(schemaPath,'utf8'));
 // Existing protected receipts install unchanged and their signatures/ACLs are frozen.
 const paths=(await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(n=>/^20261007(100823|175355)|^20261008055400|^20261008144414|^20261008163558/.test(n)).sort();
 for(const p of paths)await admin.query(await readFile(new URL('../supabase/migrations/'+p,import.meta.url),'utf8'));
 protectedBefore=(await admin.query("select oid::regprocedure::text signature,proacl::text acl,prosrc from pg_proc where proname like 'runvara_%content%receipt%' order by 1")).rows;
 const name=(await readdir(new URL('../supabase/migrations/',import.meta.url))).find(n=>n.endsWith('_bounded_shopify_order_recovery_rebuilt.sql'));sql=await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');await admin.query(sql);
 console.log(JSON.stringify({local:true,synthetic:true,postgres:info.version,migration:name,liveCalls:0}));
});
after(async()=>{for(const c of clients)await close(c);if(childDatabase&&!baseAdmin){baseAdmin=new Client({connectionString:url.toString(),ssl:false,connectionTimeoutMillis:5000});await baseAdmin.connect();}if(baseAdmin){try{if(childDatabase){await baseAdmin.query('DROP DATABASE '+childDatabase);assert.equal((await baseAdmin.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1',[childDatabase])).rows[0].n,0);console.log(JSON.stringify({disposableChildDropped:true,database:childDatabase}));}}finally{await baseAdmin.end();}}});
test('prepared latch, five RPC ACLs, empty private ledger and schema reapply',async()=>{
 const f=await fixture();await rejected(reserve(f),'P0Q03');assert.equal((await read(f)).mode,'prepared');
 for(const role of ['service_role','anon','authenticated'])for(const table of ['control','quota','stages','pages','receipts'])await using(c=>assert.rejects(c.query('select * from public.runvara_order_recovery_'+table),e=>e.code==='42501'),role);
 const acl=()=>admin.query("select p.oid::regprocedure::text signature,has_function_privilege('service_role',p.oid,'EXECUTE') service,has_function_privilege('anon',p.oid,'EXECUTE') anon from pg_proc p where proname like 'runvara_recovery_%' or proname like 'runvara_%_order_recovery' order by 1");
 const before=(await acl()).rows;assert.equal(before.filter(r=>r.service).length,5);assert.ok(before.every(r=>!r.anon));await admin.query(await readFile(schemaPath,'utf8'));assert.deepEqual((await acl()).rows,before);
 assert.deepEqual((await admin.query("select oid::regprocedure::text signature,proacl::text acl,prosrc from pg_proc where proname like 'runvara_%content%receipt%' order by 1")).rows,protectedBefore);
 await admin.query("update public.runvara_order_recovery_control set mode='enforced'");
});
test('reserve, append, canonical promotion, costs, durable exact ACK and slot reuse',async()=>{
 const f=await fixture();f.state.orders=[{id:'order-one',provider:'shopify',costOverrides:{paymentFees:7},paymentFees:7},{id:'old-out-of-window',provider:'shopify',name:'retained'}];await save(f,f.state);
 await reserve(f);assert.deepEqual((await read(f)).stage,f.stage);
 const summary=(await read(f,'summary')).stage;assert.ok(!('pages'in summary)&&!('after'in summary));
 await append(f);await finalize(f);assert.equal((await read(f)).stage,null);assert.equal((await state(f)).orders[0].paymentFees,7);assert.equal((await state(f)).orders[1].id,'old-out-of-window');
 for(const item of f.requests)assert.deepEqual(await lookup(f,item),{...item.ack,replayed:true});
 const oldRequests=f.requests.slice(),oldStageId=f.stageId;f.state=await state(f);f.binding=createShopifyOrderRecoveryBinding(f.state,null,{startedAt:new Date().toISOString()});f.stageId='reuse_'+randomUUID();await reserve(f);
 for(const item of oldRequests)assert.deepEqual(await rpc('lookup',{schema:'runvara-order-recovery/v1',workspaceId:f.id,stageId:oldStageId,actor:f.actor,kind:item.kind,requestFingerprint:rawFingerprint(JSON.stringify(item.r))}),{...item.ack,replayed:true});
 await append(f,page(f,{orders:[]}));await finalize(f);
});

test('nullable and changed source/actor/session/admission reserve probes never create a stage',async()=>{
 for(const mutate of [s=>delete s.users[0].role,s=>s.users[0].role=null,s=>s.users[0].active=false,s=>s.users[0].passwordChangeRequired=true,s=>s.users[0].sessionVersion=2,s=>delete s.connections[0].id,s=>delete s.connections[0].encryptedCredentials,s=>s.connections[0].metadata.shopId='changed',s=>s.connectionSettings.shopify.revision=1,s=>s.connections.push(structuredClone(s.connections[0])),s=>s.integrationStatus.shopify.orderReadHold={code:'SHOPIFY_ORDER_SOURCE_INVALID'}]){
  const f=await fixture(),{r}=reserveRequest(f),s=structuredClone(f.state);mutate(s);await save(f,s);await rejected(rpc('reserve',r));assert.equal((await read(f).catch(()=>({stage:null}))).stage,null);
 }
 const f=await fixture();for(const change of [r=>r.actor.expiresAt=new Date(Date.now()-1).toISOString(),r=>r.admission.leaseUntil=new Date(Date.now()-1).toISOString(),r=>r.admission.workspaceRevision='not-uuid',r=>r.kind=null,r=>r.actor.role='owner',r=>r.binding.window.query='all orders',r=>r.state.users[0].role='admin',r=>delete r.state.connectionSyncs[0].areas,r=>delete r.state.connectionSyncs[0].actor]){const r=structuredClone(reserveRequest(f).r);change(r);await rejected(rpc('reserve',r));}
 assert.equal((await read(f)).stage,null);
});
test('whole page validation rejects malformed/null/source/cursor/duplicate input atomically',async()=>{
 const f=await fixture();await reserve(f);
 for(const change of [p=>p.schema=null,p=>p.index=1,p=>p.after='wrong',p=>p.orders[0].sourceReadRef='forged',p=>p.orders[0].paymentFees=1,p=>delete p.orders[0].currentTotal,p=>p.orders[0].customerEmailHash='bad',p=>p.orders[0].lineItems[0].quantity=-1,p=>p.orders[0].updatedAt=f.binding.startedAt,p=>p.orders[0].currency='gbp',p=>p.orders.push(structuredClone(p.orders[0])),p=>p.cursor=null,p=>p.evidence.apiVersion='anything',p=>delete p.evidence.hasNextPage,p=>p.orders[0].lineItems.push(structuredClone(p.orders[0].lineItems[0]))]){
  const p=page(f,{more:true});change(p);const r={schema:'runvara-order-recovery/v1',kind:'append',workspaceId:f.id,stageId:f.stageId,actor:f.actor,admission:f.admission,expectedStageRevision:f.stage.revision,page:p};await rejected(rpc('append',r));assert.deepEqual((await read(f)).stage,f.stage);
 }
 await append(f,page(f,{more:true}));for(const p of [page(f,{orders:[order(f)],more:false,cursor:'new'}),page(f,{orders:[order(f,'another')],cursor:f.stage.after})])await rejected(rpc('append',{schema:'runvara-order-recovery/v1',kind:'append',workspaceId:f.id,stageId:f.stageId,actor:f.actor,admission:f.admission,expectedStageRevision:f.stage.revision,page:p}));
 await append(f,page(f,{orders:[order(f,'another')]}));await finalize(f);
});
test('first-sync other failed areas remain partial and required final fields cannot disappear',async()=>{
 const f=await fixture({first:true});f.state.integrationStatus.shopify.lastError='PRODUCT_FAILED';f.state.integrationStatus.shopify.failedAreas=['orders','products'];await save(f,f.state);await reserve(f);await append(f);
 const baseline=await state(f);
 for(const change of [r=>delete r.state.integrationStatus.shopify.lastSyncAt,r=>delete r.state.integrationStatus.shopify.lastSuccessfulSyncAt,r=>delete r.state.integrationStatus.shopify.areaSuccessAt.orders,r=>delete r.state.integrationStatus.shopify.orderReadAttempt,r=>delete r.state.connectionSyncs[0].errorCode,r=>delete r.state.connectionSyncs[0].status,r=>r.state.connectionFirstSync.shopify.status='completed',r=>r.state.connectionFirstSync.shopify.areas.products='completed',r=>r.state.connectionFirstSync.shopify.validation.counts.products=999,r=>r.state.orders[0].paymentFees=999,r=>r.state.workspace.name='changed']){
  const r=finalizeRequest(f);change(r);await rejected(rpc('finalize',r));assert.deepEqual(await state(f),baseline);assert.deepEqual((await read(f)).stage,f.stage);
 }
 await finalize(f);const saved=await state(f);assert.equal(saved.connectionFirstSync.shopify.status,'partial');assert.equal(saved.connectionFirstSync.shopify.areas.orders,'completed');assert.equal(saved.connectionFirstSync.shopify.areas.products,'failed');assert.equal(saved.integrationStatus.shopify.status,'degraded');assert.equal(saved.integrationStatus.shopify.lastError,'PRODUCT_FAILED');assert.equal(saved.integrationStatus.shopify.lastSuccessfulSyncAt,f.binding.startedAt);
});
test('generic old writer cannot erase marker/debt/pinned run or inject orders; unrelated saves survive',async()=>{
 const f=await fixture();f.state.connectionDoctor.shopify.pendingReadAttempts=1;await save(f,f.state);await reserve(f);
 for(const change of [s=>delete s.integrationStatus.shopify.orderRecovery,s=>s.connectionDoctor.shopify.attempts=0,s=>{delete s.connectionDoctor.shopify.pendingReadAttempts;s.connectionDoctor.shopify.attempts=1;},s=>s.connectionSyncs=[],s=>s.connectionSyncs.push({...s.connectionSyncs[0],id:'forged',automatic:true}),s=>{s.users[0].role='admin';s.connectionSyncs.push({...s.connectionSyncs[0],id:'new',orderRecoveryStageId:undefined});}]){
  const s=structuredClone(f.state);change(s);await rejected(save(f,s),'P0Q05');
 }
 const s=structuredClone(f.state);delete s.connectionDoctor.shopify.pendingReadAttempts;s.workspace.name='Allowed unrelated';s.integrationStatus.reporting={status:'connected'};s._revision=randomUUID();await save(f,s);f.state=s;await append(f);await finalize(f);
});
test('transaction cleanup and immutable receipt insertion roll back together on injected canonical failure',async()=>{
 const f=await fixture();await reserve(f);await append(f);const before=await state(f),stage=(await read(f)).stage,q=(await admin.query('select * from public.runvara_order_recovery_quota')).rows;
 await admin.query("create function public.recovery_test_fail() returns trigger language plpgsql as $$begin if NEW.state#>>'{integrationStatus,shopify,orderRecovery,status}'='committed' then raise exception 'synthetic rollback';end if;return new;end$$;create trigger zz_recovery_test_failure before update on public.saas_workspace_state for each row execute function public.recovery_test_fail()");
 await assert.rejects(rpc('finalize',finalizeRequest(f)),e=>e.message==='synthetic rollback');assert.deepEqual(await state(f),before);assert.deepEqual((await read(f)).stage,stage);assert.deepEqual((await admin.query('select * from public.runvara_order_recovery_quota')).rows,q);assert.equal((await admin.query('select count(*)::int n from public.runvara_order_recovery_receipts where workspace_id=$1',[f.id])).rows[0].n,0);
 await admin.query('drop trigger zz_recovery_test_failure on public.saas_workspace_state;drop function public.recovery_test_fail()');await finalize(f);
});

test('five admissions, ten full pages, 500 orders, maximum identity receipt and every ACK survive reuse',async()=>{
 const f=await fixture({id:'w'.repeat(256),first:true});f.state.connectionFirstSync.shopify.actor='f'.repeat(300);f.actor.id='a'.repeat(256);f.state.users[0].id=f.actor.id;f.state.connections[0].id='c'.repeat(256);f.state.connections[0].metadata.shopId='d'.repeat(300);f.state.connections[0].metadata.shopDomain='s'.repeat(239)+'.myshopify.com';f.stageId='t'.repeat(256);await save(f,f.state);f.binding=createShopifyOrderRecoveryBinding(f.state,null,{startedAt:f.binding.startedAt});
 for(let admission=0;admission<5;admission++){
  if(admission){f.state=await state(f);f.state.connectionSyncs.find(r=>r.id===f.admission.runId).status='failed';await save(f,f.state);await reserve(f,{prior:f.stage});}else await reserve(f);
  for(let p=0;p<2;p++){const index=admission*2+p;await append(f,page(f,{orders:Array.from({length:50},(_,i)=>order(f,`${index}-${i}-`+'i'.repeat(240))),more:index<9,cursor:'cursor-'+index}));assert.deepEqual((await read(f)).stage,f.stage,'cold hydration after every page');}
 }
 const ack=await finalize(f);assert.equal(ack.status,'committed');assert.equal(f.requests.length,16);
 const receipt=(await admin.query('select receipt,logical_bytes from public.runvara_order_recovery_receipts where workspace_id=$1',[f.id])).rows[0];assert.ok(receipt.logical_bytes<=16384);assert.deepEqual(receipt.receipt.binding,f.binding);assert.equal(receipt.receipt.operations.length,16);assert.ok(!JSON.stringify(receipt.receipt).includes('leaseUntil'));assert.ok(!JSON.stringify(receipt.receipt).includes('cursor-'));
 for(const item of f.requests){const replay=await lookup(f,item);assert.deepEqual(replay,{...item.ack,replayed:true});assert.ok(Buffer.byteLength(JSON.stringify(replay))<=2048);}
 const oldStage=f.stageId,old=f.requests.slice();f.state=await state(f);f.state.connectionDoctor.shopify={};await save(f,f.state);f.stageId='replacement';f.binding=createShopifyOrderRecoveryBinding(f.state,null,{startedAt:new Date().toISOString()});await reserve(f);await append(f,page(f,{orders:[]}));await finalize(f);
 for(const item of old)assert.deepEqual(await rpc('lookup',{schema:'runvara-order-recovery/v1',workspaceId:f.id,stageId:oldStage,actor:f.actor,kind:item.kind,requestFingerprint:rawFingerprint(JSON.stringify(item.r))}),{...item.ack,replayed:true});
});
test('source/actor/session/lease changes reject append and late old admission is fenced by resume',async()=>{
 const f=await fixture();await reserve(f);const original=structuredClone(f.state),p=page(f);const r={schema:'runvara-order-recovery/v1',kind:'append',workspaceId:f.id,stageId:f.stageId,actor:f.actor,admission:f.admission,expectedStageRevision:f.stage.revision,page:p};
 for(const change of [s=>s.users[0].active=false,s=>s.users[0].sessionVersion++,s=>s.users[0].passwordChangeRequired=true,s=>s.connections[0].metadata.shopId='changed',s=>s.connectionSettings.shopify.revision++]){const s=structuredClone(original);change(s);await save(f,s);await rejected(rpc('append',r));await save(f,original);}
 const expired=structuredClone(r);expired.actor.expiresAt=new Date(Date.now()-1).toISOString();await rejected(rpc('append',expired));
 f.state=structuredClone(original);f.state.connectionSyncs[0].status='failed';await save(f,f.state);await reserve(f,{prior:f.stage});await rejected(rpc('append',r),'P0Q04');await append(f);await finalize(f);
});
test('uncertain reserve/append/final responses have one exact immutable lookup and no replayed mutation',async()=>{
 const f=await fixture(),{r,stage}=reserveRequest(f);const reserveAck=await rpc('reserve',JSON.stringify(r));f.state=r.state;f.stage=stage;f.admission=r.admission;
 const item={kind:'reserve',r,ack:reserveAck};assert.deepEqual(await lookup(f,item),{...reserveAck,replayed:true});assert.deepEqual(await rpc('reserve',r),{...reserveAck,replayed:true});
 await append(f);assert.deepEqual(await rpc('append',f.requests.at(-1).r),{...f.requests.at(-1).ack,replayed:true});await finalize(f);assert.deepEqual(await rpc('finalize',f.requests.at(-1).r),{...f.requests.at(-1).ack,replayed:true});
 const altered=JSON.stringify(r)+' ';assert.equal(await rpc('lookup',{schema:'runvara-order-recovery/v1',workspaceId:f.id,stageId:f.stageId,actor:f.actor,kind:'reserve',requestFingerprint:rawFingerprint(altered)}),null);
 const saved=await state(f);saved.integrationStatus.shopify.orderRecovery=null;saved.channelData.shopify.orderReads=null;saved._revision=randomUUID();await save(f,saved);assert.deepEqual(await lookup(f,f.requests.at(-1)),{...f.requests.at(-1).ack,replayed:true});
});
test('row lock rechecks actor/session/lease after waits and reads settle started mutations',async()=>{
 const f=await fixture();await reserve(f);const blocker=await connect('postgres'),worker=await connect();
 try{
  await blocker.query('begin');const changed=structuredClone(f.state);changed.users[0].sessionVersion=2;changed._revision=randomUUID();await blocker.query('update public.saas_workspace_state set state=$2 where workspace_id=$1',[f.id,changed]);
  const pending=rpc('append',{schema:'runvara-order-recovery/v1',kind:'append',workspaceId:f.id,stageId:f.stageId,actor:f.actor,admission:f.admission,expectedStageRevision:f.stage.revision,page:page(f)},worker);await delay(30);await blocker.query('commit');await rejected(pending,'P0Q02');
  await save(f,f.state);await append(f);await finalize(f);
 }finally{await blocker.query('rollback').catch(()=>{});await close(blocker);await close(worker);}
});
test('completed and unverified first-sync history stays byte-for-byte unchanged',async()=>{
 for(const verified of [true,false]){
  const f=await fixture({first:true});const first=f.state.connectionFirstSync.shopify;
  if(verified){first.status='completed';first.areas={orders:'completed',products:'completed'};first.failures={};first.completedAt='2026-01-02T00:00:00.000Z';}else first.identityVerifiedAt=null;
  await save(f,f.state);f.binding=createShopifyOrderRecoveryBinding(f.state,null,{startedAt:f.binding.startedAt});assert.equal(f.binding.firstSync,null);const original=structuredClone(first);
  await reserve(f);await append(f);await finalize(f);assert.deepEqual((await state(f)).connectionFirstSync.shopify,original);
 }
});
test('Unicode ID whitespace rejects before admission',async()=>{
 const f=await fixture();for(const prefix of ['\u00a0','\ufeff','\u2000','\u2028','\u2029','\u202f','\u205f','\u3000']){const r=structuredClone(reserveRequest(f).r);r.stageId=prefix+'stage';r.state.connectionSyncs[0].orderRecoveryStageId=r.stageId;r.state.integrationStatus.shopify.orderRecovery.stageId=r.stageId;await rejected(rpc('reserve',r));}
 assert.equal((await read(f)).stage,null);
});

test('eight global unfinished slots race; paused and superseded stages remain charged and guard parent deletion',async()=>{
 const fixtures=await Promise.all(Array.from({length:9},()=>fixture()));const results=await Promise.allSettled(fixtures.map(f=>reserve(f)));assert.equal(results.filter(r=>r.status==='fulfilled').length,8);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='P0Q03').length,1);
 const f=fixtures[results.findIndex(r=>r.status==='fulfilled')],initial=(await admin.query('select * from public.runvara_order_recovery_quota')).rows[0];assert.equal(initial.unfinished_stages,8);
 // A complete valid page at the cap pauses without accepting a prefix or changing canonical rows.
 const huge=page(f,{orders:[order(f,'huge',{padding:'x'.repeat(2090000)})],more:true});huge.legacyBytes=2;
 const r={schema:'runvara-order-recovery/v1',kind:'append',workspaceId:f.id,stageId:f.stageId,actor:f.actor,admission:f.admission,expectedStageRevision:f.stage.revision,page:huge};const ack=await rpc('append',r);assert.equal(ack.status,'paused');const paused=(await read(f)).stage;assert.equal(paused.pages.length,0);assert.equal(paused.logicalBytes,shopifyOrderRecoveryLogicalBytes(paused));assert.deepEqual((await state(f)).orders,[]);
 let next=await state(f);const retainedRun=next.connectionSyncs[0];retainedRun.status='failed';next.connectionSyncs.unshift({id:'fresh_'+randomUUID(),provider:'shopify',areas:['orders'],automatic:false,actor:f.actor.id,status:'running',stage:'Reading selected data',startedAt:new Date().toISOString(),leaseUntil:new Date(Date.now()+540000).toISOString()});next.connectionDoctor.shopify={};await save(f,next);
 const superseded=(await read(f)).stage;assert.equal(superseded.status,'superseded');assert.equal(superseded.logicalBytes,shopifyOrderRecoveryLogicalBytes(superseded));assert.equal((await state(f)).integrationStatus.shopify.orderRecovery.status,'superseded');
 const restoring=await state(f);restoring.integrationStatus.shopify.orderRecovery.status='reading';await save(f,restoring);assert.equal((await state(f)).integrationStatus.shopify.orderRecovery.status,'superseded');
 next=await state(f);next.connectionSyncs[0].status='failed';next.connectionSyncs.unshift({id:'auto_'+randomUUID(),provider:'shopify',areas:['orders'],automatic:true,actor:'connection-doctor',status:'running',startedAt:new Date().toISOString(),leaseUntil:new Date(Date.now()+540000).toISOString()});await save(f,next);
 assert.equal((await admin.query('select * from public.runvara_order_recovery_quota')).rows[0].unfinished_stages,8);
 await rejected(admin.query('delete from public.saas_workspace_state where workspace_id=$1',[f.id]));await rejected(admin.query('delete from public.workspaces where id=$1',[f.id]));await rejected(admin.query('truncate public.workspaces cascade'));
 await rejected(admin.query('delete from public.runvara_order_recovery_stages where workspace_id=$1',[f.id]));await rejected(admin.query('truncate public.runvara_order_recovery_pages'));
});

test('narrow context checks mode, exact revision and indexes without returning pages or raw cursor',async()=>{
 const row=(await admin.query("select workspace_id,stage_id from public.runvara_order_recovery_stages where not superseded and stage->>'status'='reading' limit 1")).rows[0];
 const f={id:row.workspace_id,stageId:row.stage_id,actor:actor()};f.state=await state(f);f.stage=(await read(f)).stage;
 const context={workspaceId:f.id,revision:f.state._revision,actorId:'owner',connectionId:'connection-one',runId:f.stage.admissions.at(-1).runId,actorIndex:0,connectionIndex:0,runIndex:0};
 const request={schema:'runvara-order-recovery/v1',workspaceId:f.id,stageId:f.stageId,actor:f.actor,view:'context',context};
 const result=await rpc('read',request);assert.equal(result.schema,'shopify-order-recovery-context/v1');assert.equal(result.revision,f.state._revision);assert.equal(result.mode,'enforced');assert.ok(!('pages' in result)&&!('after' in result));assert.ok(Buffer.byteLength(JSON.stringify(result))<=32768);
 for(const field of ['revision','actorIndex','connectionIndex','runIndex']){const altered=structuredClone(request);altered.context[field]=field==='revision'?randomUUID():10;await rejected(rpc('read',altered));}
 await admin.query("update public.runvara_order_recovery_control set mode='paused'");await rejected(rpc('read',request),'P0Q03');await admin.query("update public.runvara_order_recovery_control set mode='enforced'");
 const changed=structuredClone(f.state);changed.users.push({...changed.users[0]});await rejected(using(c=>c.query('update public.saas_workspace_state set state=$2 where workspace_id=$1',[f.id,changed])),'P0Q04');
});

test('global 16MiB counts immutable receipts with free slots; two append races cannot overspend',async()=>{
 // Synthetic prior receipts populate the permanent-capacity edge without thousands
 // of redundant imports. Their full compact bytes are counted, never purged.
 const rows=(await admin.query("select workspace_id,stage_id from public.runvara_order_recovery_stages where not superseded and stage->>'status'='reading' order by workspace_id")).rows;
 const fxs=[];
 for(const row of rows){const s=(await admin.query('select state from public.saas_workspace_state where workspace_id=$1',[row.workspace_id])).rows[0].state;const f={id:row.workspace_id,stageId:row.stage_id,state:s,actor:actor(),requests:[]};f.stage=(await read(f)).stage;f.binding=f.stage.binding;f.admission=f.stage.admissions.at(-1);fxs.push(f);}
 for(const f of fxs.slice(2)){await append(f,page(f,{orders:[]}));await finalize(f);}
 const pair=fxs.slice(0,2),prototype=(await admin.query('select receipt from public.runvara_order_recovery_receipts limit 1')).rows[0].receipt;
 const requests=pair.map(f=>({schema:'runvara-order-recovery/v1',kind:'append',workspaceId:f.id,stageId:f.stageId,actor:f.actor,admission:f.admission,expectedStageRevision:f.stage.revision,page:page(f,{orders:[order(f,'quota',{padding:'q'.repeat(50000)})],more:true})}));
 const additions=pair.map((f,i)=>shopifyOrderRecoveryLogicalBytes(appendShopifyOrderRecoveryPage(f.stage,requests[i].page))-f.stage.logicalBytes);
 const target=16777216-Math.max(...additions)-10;
 let bytes=Number((await admin.query('select logical_bytes from public.runvara_order_recovery_quota')).rows[0].logical_bytes),counter=0;
 while(bytes<target){const receipt={...prototype,stageId:'synthetic-capacity-'+counter,capacityFixture:'x'.repeat(Math.min(12000,Math.max(0,target-bytes-6000)))};const size=Buffer.byteLength(JSON.stringify(receipt));if(bytes+size>target)break;await admin.query('insert into public.runvara_order_recovery_receipts(workspace_id,stage_id,receipt,logical_bytes) values($1,$2,$3,$4)',[prototype.workspaceId,receipt.stageId,receipt,size]);bytes+=size;counter++;}
 const remainder=target-bytes;
 if(remainder>0){const receipt={schema:'synthetic-capacity-boundary/v1',padding:''},base=Buffer.byteLength(JSON.stringify(receipt));if(remainder>=base){receipt.padding='x'.repeat(remainder-base);await admin.query('insert into public.runvara_order_recovery_receipts values($1,$2,$3,$4)',[prototype.workspaceId,'synthetic-tail',receipt,remainder]);bytes+=remainder;}}
 await admin.query('update public.runvara_order_recovery_quota set logical_bytes=$1 where id',[bytes]);
 const checks=await Promise.all(requests.map(r=>rpc('append',r)));assert.equal(checks.filter(a=>a.status==='reading').length,1);assert.equal(checks.filter(a=>a.status==='paused').length,1);
 const q=(await admin.query('select * from public.runvara_order_recovery_quota')).rows[0];assert.ok(Number(q.logical_bytes)<=16777216);assert.equal(q.unfinished_stages,3);
 const counted=(await admin.query('select 4096+(select coalesce(sum(logical_bytes),0) from public.runvara_order_recovery_stages)+(select coalesce(sum(logical_bytes),0) from public.runvara_order_recovery_receipts) total')).rows[0].total;assert.equal(q.logical_bytes,counted);
 const extra=await fixture();await rejected(reserve(extra),'P0Q03');assert.equal((await read(extra)).stage,null,'receipts can stop admission even with five free slots');
 console.log(JSON.stringify({globalCap:16777216,logicalBytes:Number(q.logical_bytes),unfinishedStages:q.unfinished_stages,priorReceiptFixtureCount:counter}));
});
