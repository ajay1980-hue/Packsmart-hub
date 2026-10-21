// Explicit disposable native test, intentionally outside *.test.mjs.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { publicationFixture } from './marketing-publication-fixture.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
import { createStore } from '../lib/store.mjs';
import { executeConnectionWrite } from '../lib/connection-writes.mjs';
import { createMetaPublicationPreparationSimulation, createMetaPublicationSimulation, prepareMetaMarketingPublication,
  reconcileMetaPublicationSimulation, readMetaMarketingPublication, createMetaPublicationLocalAsset } from '../lib/marketing-publication.mjs';
import { png } from './marketing-publication-asset-fixture.mjs';
import { META_RECEIPT_CONTRACT, protectedMetaPublicationAdmission } from '../lib/meta-publication-receipt.mjs';
import { metaPublicationObservations, createMetaObservationSimulation } from '../lib/meta-publication-observation.mjs';
import { contentWriteSnapshot } from '../lib/content-write-identity.mjs';

assert.equal(process.env.OUTCOME_ALLOW_DISPOSABLE_TEST_DB,'1');
const baseUrl=new URL(process.env.OUTCOME_TEST_DATABASE_URL);
assert.ok(['postgres:','postgresql:'].includes(baseUrl.protocol));
assert.ok(['127.0.0.1','localhost','[::1]'].includes(baseUrl.hostname));
assert.equal(baseUrl.pathname,'/runvara_outcome_test');assert.equal(baseUrl.username,'postgres');
assert.equal(baseUrl.search,'');assert.equal(baseUrl.hash,'');
const {Client}=createRequire(new URL('./atomic-usage/package.json',import.meta.url))('pg');
const clients=new Set(), database='runvara_meta_receipt_test_'+randomUUID().replaceAll('-','');
let baseAdmin,admin,childUrl,baseline;
async function connect(role='service_role'){
 const c=new Client({connectionString:childUrl.toString(),ssl:false,options:'',connectionTimeoutMillis:5000,statement_timeout:20000});
 await c.connect();clients.add(c);assert.ok(['postgres','service_role','anon','authenticated'].includes(role));
 if(role!=='postgres')await c.query('SET SESSION AUTHORIZATION '+role);return c;
}
async function close(c){clients.delete(c);await c.end();}
async function using(role,fn){const c=await connect(role);try{return await fn(c);}finally{await close(c);}}
const service=fn=>using('service_role',fn);
before(async()=>{
 baseAdmin=new Client({connectionString:baseUrl.toString(),ssl:false,options:''});await baseAdmin.connect();
 const info=(await baseAdmin.query("SELECT current_database() db,current_user role,current_setting('server_version_num')::int version,current_setting('listen_addresses') listen")).rows[0];
 assert.equal(info.db,'runvara_outcome_test');assert.equal(info.role,'postgres');assert.equal(info.listen,'127.0.0.1');assert.ok(info.version>=170000&&info.version<180000);
 assert.ok(['127.0.0.1','::1','::ffff:127.0.0.1'].includes(baseAdmin.connection.stream.remoteAddress));
 await baseAdmin.query('CREATE DATABASE '+database);childUrl=new URL(baseUrl);childUrl.pathname='/'+database;admin=await connect('postgres');
 assert.equal((await admin.query("SELECT count(*)::int n FROM pg_class WHERE relnamespace='public'::regnamespace")).rows[0].n,0);
 let fixture=await readFile(new URL('./atomic-usage-postgres-fixture.sql',import.meta.url),'utf8');
 for(const name of ['anon','authenticated','service_role','atomic_usage_untrusted']){
  const existing=(await admin.query('SELECT rolsuper,rolcanlogin,rolbypassrls FROM pg_roles WHERE rolname=$1',[name])).rows[0];
  if(existing){assert.deepEqual(existing,{rolsuper:false,rolcanlogin:false,rolbypassrls:name==='service_role'});fixture=fixture.replace(new RegExp('create role '+name+' [^;]+;'),'');}
 }
 await admin.query(fixture);baseline=await readFile(new URL('../supabase/schema.sql',import.meta.url),'utf8');await admin.query(baseline);
 await admin.query(await readFile(new URL('../supabase/migrations/20261007074031_reporting_status_cas.sql',import.meta.url),'utf8'));
 await admin.query(await readFile(new URL('../supabase/prepared/synthetic-meta-receipts.sql',import.meta.url),'utf8'));
 await admin.query(await readFile(new URL('../supabase/prepared/synthetic-meta-observations.sql',import.meta.url),'utf8'));
 console.log('META_NATIVE_SAFETY='+JSON.stringify({...info,syntheticOnly:true,emptyDatabase:true,providerRequests:0}));
});
after(async()=>{try{await Promise.all([...clients].map(close));if(childUrl){await baseAdmin.query('DROP DATABASE '+database);console.log('META_NATIVE_DATABASE_DROPPED='+database);}}finally{await baseAdmin?.end();}});
const rejected=(codes=['P0M01','P0M02','P0M03','P0M04','P0M05','23505','23503','42501'])=>error=>{assert.ok(codes.includes(error.code),error.code+': '+error.message);return true;};
async function fixture(t){
 const f=await publicationFixture(t,'meta-native-'+randomUUID()),seed=await f.get(),fake=fakeSupabase();
 await admin.query('INSERT INTO public.workspaces(id,name,slug) VALUES($1,$1,$1)',[f.workspaceId]);
 await admin.query('INSERT INTO public.saas_workspace_state(workspace_id,state) VALUES($1,$2)',[f.workspaceId,seed]);
 const raw=async()=>(await service(c=>c.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1',[f.workspaceId]))).rows[0].state;
 const requests=[],runs=[],controls={beforeCommit:null,afterCommit:null,hideLookup:false,malformedAck:false};
 const fetchImpl=async(input,options={})=>{
  const url=new URL(input),name=url.pathname.split('/').pop(),method=options.method||'GET';assert.equal(url.origin,'https://meta-native.invalid');
  try{
   if(['runvara_commit_meta_receipt','runvara_lookup_meta_receipt','runvara_read_meta_receipt','runvara_read_meta_observations','runvara_append_meta_observation'].includes(name)){
    const body=JSON.parse(options.body);requests.push({name,raw:body.p_request});
    if(name==='runvara_lookup_meta_receipt'&&controls.hideLookup)return Response.json(null);
    if(name==='runvara_commit_meta_receipt')await controls.beforeCommit?.(JSON.parse(body.p_request));
    if(name==='runvara_append_meta_observation')await controls.beforeObservation?.(JSON.parse(body.p_request));
    const value=(await service(c=>c.query(`SELECT public.${name}($1::text) value`,[body.p_request]))).rows[0].value;
    if(name==='runvara_commit_meta_receipt'){
     await controls.afterCommit?.(JSON.parse(body.p_request),value);
     if(controls.malformedAck)return Response.json({...value,eventDigest:'0'.repeat(64)});
    }
    if(name==='runvara_append_meta_observation')await controls.afterObservation?.(JSON.parse(body.p_request),value);
    return Response.json(value);
   }
   if(name==='runvara_commit_reporting_status'){
    const b=JSON.parse(options.body);
    const rows=(await service(c=>c.query('SELECT * FROM public.runvara_commit_reporting_status($1,$2,$3,$4::jsonb,$5::timestamptz)',[b.p_workspace_id,b.p_expected_revision,b.p_next_revision,b.p_report,b.p_updated_at]))).rows;
    return Response.json(rows);
   }
   if(name==='saas_workspace_state'){
    assert.equal(url.searchParams.get('workspace_id'),'eq.'+f.workspaceId);
    if(method==='PATCH'){
     const b=JSON.parse(options.body),revision=url.searchParams.get('state->>_revision');assert.ok(revision.startsWith('eq.'));
     return Response.json((await service(c=>c.query("UPDATE public.saas_workspace_state SET state=$2,updated_at=$3 WHERE workspace_id=$1 AND state->>'_revision'=$4 RETURNING workspace_id",[f.workspaceId,b.state,b.updated_at,revision.slice(3)]))).rows);
    }
    fake.states.set(f.workspaceId,await raw());
   }
   return fake.fetchImpl(input,options);
  }catch(error){if(!error.code)throw error;if(!/^P0M|^235|^425/.test(error.code))console.log('META_NATIVE_SQL_ERROR='+JSON.stringify({rpc:name,code:error.code,message:error.message}));return Response.json({code:error.code,message:error.code},{status:400});}
 };
 const store=createStore({SUPABASE_URL:'https://meta-native.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-only'},{fetchImpl}),get=()=>store.get(f.workspaceId);
 async function prepare(){const state=await get(),body=await f.body();const capability=createMetaPublicationPreparationSimulation(state,f.campaignId,body,f.session,{protectedReceipts:true});
  return prepareMetaMarketingPublication(state,f.campaignId,body,f.session,{durableStore:true,preparationSimulation:capability,persist:o=>store.save(f.workspaceId,state,o)});}
 async function approve(){const state=await get(),write=state.connectionWrites[0];Object.assign(state.approvals.find(r=>r.id===write.approvalId),{status:'approved',decidedBy:f.session.userId,decidedAt:new Date().toISOString()});await store.save(f.workspaceId,state);}
 async function execute(options={},composition={}){const state=await get(),write=state.connectionWrites[0],simulation=createMetaPublicationSimulation(state,write,options,composition),run={state,write,simulation};runs.push(run);
  run.result=await executeConnectionWrite(state,write.id,f.session.userId,simulation.integrations,o=>store.save(f.workspaceId,state,o),{
   durableStore:true,actorSession:f.session,metaPublicationSimulation:simulation.capability,loadFreshState:r=>store.getConnectionWriteContext(f.workspaceId,r)});return run;}
 const read=async()=>{const s=await get();return store.readProtectedMetaPublication(f.workspaceId,s.connectionWrites[0].id,f.session);};
 const reconcile=async(run,reader=read)=>{const s=await get();return reconcileMetaPublicationSimulation(s,s.connectionWrites[0].id,f.session,run.simulation.capability,reader);};
 return {...f,store,get,raw,prepare,approve,execute,read,reconcile,requests,runs,controls};
}

test('dormant schema rejects execution and grants cannot be widened by service role',async t=>{
 const f=await fixture(t);await f.prepare();await f.approve();await assert.rejects(f.execute(),{code:'META_RECEIPT_CAPACITY_OR_MODE'});
 assert.equal(f.runs[0].simulation.observations().length,0);
 await service(c=>assert.rejects(c.query("UPDATE public.runvara_meta_receipt_control SET mode='enforced'"),rejected(['42501'])));
 await admin.query("UPDATE public.runvara_meta_receipt_control SET mode='enforced'");
});
test('whole synthetic chain commits through native JSONB and exact protected reads',async t=>{
 const f=await fixture(t);await f.prepare();await f.approve();const run=await f.execute();assert.equal(run.result.status,'completed');
 assert.deepEqual(run.simulation.observations().map(r=>r.phase),['instagram_container','instagram_publish']);
 const proof=await f.read();assert.equal(proof.events.length,5);assert.equal(proof.executedExternally,false);
 const projections=proof.events.map(d=>JSON.parse(d.eventText).projection.write);
 assert.deepEqual(projections.map(w=>Object.keys(w.dispatchClaim.phases).length),[0,1,1,2,2]);
 assert.equal(projections[2].providerState.containerId,'900000001');assert.equal(projections[4].result.externalId,'900000002');
 const state=await f.get();assert.equal(readMetaMarketingPublication(state,f.campaignId,'meta-publication-request-0001',f.session).receiptStatus,'simulated_confirmed');
 assert.equal(proof.contract,META_RECEIPT_CONTRACT);assert.equal(f.requests.filter(r=>r.name==='runvara_commit_meta_receipt').length,5);
});
test('lost publish response permits exact container status observation but no media ID or resend',async t=>{
 const f=await fixture(t);await f.prepare();await f.approve();const run=await f.execute({loseResponsePhase:'instagram_publish'});assert.equal(run.result.status,'uncertain');
 const before=await f.raw(),requests=f.requests.filter(r=>r.name==='runvara_commit_meta_receipt').length;
 const result=await f.reconcile(run);assert.equal(result.statusCode,'PUBLISHED');assert.equal(result.resultId,null);assert.equal(result.replayPermitted,false);assert.equal(result.executedExternally,false);
 await f.reconcile(run);assert.deepEqual(await f.raw(),before);assert.equal(f.requests.filter(r=>r.name==='runvara_commit_meta_receipt').length,requests);
 assert.equal(run.simulation.observations().length,2);await assert.rejects(f.execute(),{code:'WRITE_ALREADY_ATTEMPTED'});
 const state=await f.get(),fresh=createMetaPublicationSimulation(state,state.connectionWrites[0]);
 assert.equal((await reconcileMetaPublicationSimulation(state,state.connectionWrites[0].id,f.session,fresh.capability,f.read)).outcome,'unresolved_do_not_resend');
});

test('exact old acknowledgements prove only their immutable commit and never overwrite later state',async t=>{
 const f=await fixture(t);await f.prepare();await f.approve();await f.execute();const before=await f.raw();
 const raw=f.requests.find(r=>r.name==='runvara_commit_meta_receipt').raw;
 const ack=(await service(c=>c.query('SELECT public.runvara_commit_meta_receipt($1) ack',[raw]))).rows[0].ack;
 assert.equal(ack.replayed,true);assert.equal(ack.sequence,1);assert.deepEqual(await f.raw(),before);
 await service(c=>assert.rejects(c.query('SELECT public.runvara_commit_meta_receipt($1)',[raw+' ']),rejected(['P0M04'])));
 assert.deepEqual(await f.raw(),before);
});
test('ambiguous successful commits use one exact lookup without repeating mutations',async t=>{
 const f=await fixture(t);await f.prepare();await f.approve();f.controls.afterCommit=()=>{throw Error('synthetic lost acknowledgement');};
 const run=await f.execute();assert.equal(run.result.status,'completed');assert.equal(run.simulation.observations().length,2);
 assert.equal(f.requests.filter(r=>r.name==='runvara_commit_meta_receipt').length,5);
 assert.equal(f.requests.filter(r=>r.name==='runvara_lookup_meta_receipt').length,5);
});
test('missing proof after phase admission stops before dispatch and never performs a generic fallback',async t=>{
 const f=await fixture(t);await f.prepare();await f.approve();f.controls.hideLookup=true;
 f.controls.afterCommit=r=>{if(JSON.parse(r.descriptor.eventText).sequence===2)throw Error('synthetic lost acknowledgement');};
 await assert.rejects(f.execute(),{code:'META_RECEIPT_COMMIT_UNKNOWN'});assert.equal(f.runs[0].simulation.observations().length,0);
 const state=await f.raw();assert.equal(state.connectionWrites[0].metaReceiptCursor.sequence,2);assert.equal(state.connectionWrites[0].status,'executing');
 assert.equal(f.requests.filter(r=>r.name==='runvara_commit_meta_receipt').length,2);
 await assert.rejects(f.execute(),{code:'WRITE_ALREADY_ATTEMPTED'});assert.deepEqual(await f.raw(),state);
});
test('a newer workspace revision after recovered admission prevents the next send',async t=>{
 const f=await fixture(t);await f.prepare();await f.approve();let changed=false;
 f.controls.afterCommit=async r=>{if(!changed&&JSON.parse(r.descriptor.eventText).sequence===2){changed=true;const s=await f.raw();s._revision=randomUUID();s.workspace.name='Concurrent harmless edit';
  await service(c=>c.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1',[f.workspaceId,s]));throw Error('lost ack after concurrent edit');}};
 await assert.rejects(f.execute());assert.equal(f.runs[0].simulation.observations().length,0);
 const state=await f.raw();assert.equal(state.workspace.name,'Concurrent harmless edit');assert.equal(state.connectionWrites[0].metaReceiptCursor.sequence,2);
});
test('concurrent executors admit and send each synthetic phase at most once',async t=>{
 const f=await fixture(t);await f.prepare();await f.approve();const results=await Promise.allSettled([f.execute(),f.execute()]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.deepEqual(f.runs.flatMap(r=>r.simulation.observations()).map(r=>r.phase),['instagram_container','instagram_publish']);
 assert.equal((await f.read()).events.length,5);
});
test('a lost container response has no guessed ID and cannot be reconciled into publication',async t=>{
 const f=await fixture(t);await f.prepare();await f.approve();const run=await f.execute({loseResponsePhase:'instagram_container'});
 assert.equal(run.result.status,'uncertain');const outcome=await f.reconcile(run);assert.equal(outcome.statusCode,null);assert.equal(outcome.containerId,null);
 assert.equal(outcome.outcome,'unresolved_do_not_resend');assert.equal(run.simulation.observations().length,1);
});
test('ordinary and predecessor whole-state writers cannot erase, downgrade, reset or forge retained evidence even paused',async t=>{
 const f=await fixture(t);await f.prepare();await f.approve();await f.execute();const before=await f.raw();
 await admin.query("UPDATE public.runvara_meta_receipt_control SET mode='paused'");
 const changes=[s=>s.connectionWrites=[],s=>s.connectionWrites.push(structuredClone(s.connectionWrites[0])),
  s=>delete s.connectionWrites[0].marketingPublication.receiptContract,s=>delete s.connectionWrites[0].marketingPublication,
  s=>delete s.connectionWrites[0].metaReceiptCursor,s=>s.connectionWrites[0].dispatchClaim.phases={},
  s=>s.connectionWrites[0].providerState.containerId='999',s=>s.connectionWrites[0].marketingPublicationReceipt.resultId='999',
  s=>delete s.connectionWrites[0].marketingPublicationReceipt,s=>s.connectionWrites[0].status='ready',
  s=>s.connectionWrites[0].result.externalId='999',s=>s.approvals[0].status='pending'];
 try{for(const change of changes){const s=structuredClone(before);change(s);await service(c=>assert.rejects(c.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1',[f.workspaceId,s]),rejected(['P0M05'])));}
  const s=structuredClone(before);s.workspace.name='Unrelated edits remain possible';await service(c=>c.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1',[f.workspaceId,s]));
  assert.equal((await f.read()).events.length,5);
 }finally{await admin.query("UPDATE public.runvara_meta_receipt_control SET mode='enforced'");}
});
test('role grants, immutability, FK deletion, truncate and baseline replay preserve the ledger',async t=>{
 const f=await fixture(t);await f.prepare();await f.approve();await f.execute();const before=await f.read();
 for(const role of ['anon','authenticated','service_role'])for(const sql of [
  'SELECT * FROM public.runvara_meta_receipt_events','UPDATE public.runvara_meta_receipt_events SET event_digest=event_digest',
  'DELETE FROM public.runvara_meta_receipt_events','TRUNCATE public.runvara_meta_receipt_events'])await using(role,c=>assert.rejects(c.query(sql),rejected(['42501'])));
 for(const sql of ['UPDATE public.runvara_meta_receipt_events SET event_digest=event_digest','DELETE FROM public.runvara_meta_receipt_events','TRUNCATE public.runvara_meta_receipt_events',
  'TRUNCATE public.saas_workspace_state CASCADE']) {
  if (sql==='TRUNCATE public.runvara_meta_receipt_events') {
   await assert.rejects(admin.query(sql),rejected(['0A000']));
   await assert.rejects(admin.query(sql+' CASCADE'),rejected(['P0M05']));
  } else await assert.rejects(admin.query(sql),rejected(['P0M05']));
 }
 await service(c=>assert.rejects(c.query('DELETE FROM public.saas_workspace_state WHERE workspace_id=$1',[f.workspaceId]),rejected(['P0M05'])));
 await service(c=>assert.rejects(c.query('DELETE FROM public.workspaces WHERE id=$1',[f.workspaceId]),rejected(['P0M05','23503'])));
 await admin.query(baseline);await service(c=>assert.rejects(c.query('SELECT * FROM public.runvara_meta_receipt_events'),rejected(['42501'])));
 assert.deepEqual(await f.read(),before);
});
test('protected reads enforce current owner/session and exact tenant without granting JSON evidence authority',async t=>{
 const f=await fixture(t);await f.prepare();await f.approve();const run=await f.execute({loseResponsePhase:'instagram_publish'});const proof=await f.read();
 await assert.rejects(f.reconcile(run,async()=>structuredClone(proof)),{code:'META_RECEIPT_READ_INVALID'});
 const altered=await f.read();altered.events[0].digest='0'.repeat(64);await assert.rejects(f.reconcile(run,async()=>altered),{code:'META_RECEIPT_READ_INVALID'});
 const s=await f.get(),writeId=s.connectionWrites[0].id;
 await assert.rejects(f.store.readProtectedMetaPublication(f.workspaceId,writeId,{...f.session,sessionVersion:2}));
 await assert.rejects(f.store.readProtectedMetaPublication('other-workspace',writeId,f.session),{code:'META_RECEIPT_ACTOR_INVALID'});
 s.users[0].active=false;await service(c=>c.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1',[f.workspaceId,s]));
 await assert.rejects(f.read());await assert.rejects(f.reconcile(run),{code:'WRITE_ACTOR_CHANGED'});
});

test('reconciliation survives later product costs, stock, settings and day changes without renewing authority',async t=>{
 const f=await fixture(t);await f.prepare();await f.approve();const run=await f.execute({loseResponsePhase:'instagram_publish'});
 const s=await f.get();s.products[0].variants[0].inventory=0;s.economics.BAGS.landed=100;s.connectionSettings.meta.permissionMode='read_only';
 await service(c=>c.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1',[f.workspaceId,s]));
 const before=await f.raw(),outcome=await f.reconcile(run);assert.equal(outcome.statusCode,'PUBLISHED');assert.equal(outcome.replayPermitted,false);
 assert.deepEqual(await f.raw(),before);assert.equal(run.simulation.observations().length,2);
});
test('pending checks reserve publication/finalization capacity and refuse before sending at exhaustion',async t=>{
 let clock=Date.now();t.mock.method(Date,'now',()=>clock);
 for(const pendingResumes of [4,5]){
  const f=await fixture(t);await f.prepare();await f.approve();await f.execute({containerStatus:'IN_PROGRESS'});
  for(let i=0;i<pendingResumes;i++){clock+=60001;assert.equal((await f.execute({containerStatus:'IN_PROGRESS'})).result.status,'processing');}
  assert.equal((await f.raw()).connectionWrites[0].metaReceiptCursor.sequence,4+2*pendingResumes);clock+=60001;
  if(pendingResumes===4){assert.equal((await f.execute()).result.status,'completed');assert.equal((await f.read()).events.length,15);}
  else{await assert.rejects(f.execute(),{code:'META_RECEIPT_CAPACITY_OR_MODE'});assert.equal((await f.read()).events.length,14);}
  assert.equal(f.runs.flatMap(r=>r.simulation.observations()).filter(r=>r.phase==='instagram_container').length,1);
  assert.equal(f.runs.flatMap(r=>r.simulation.observations()).filter(r=>r.phase==='instagram_publish').length,pendingResumes===4?1:0);
 }
});
test('native RPC refuses null predecessor and noncanonical envelopes with no partial commit',async t=>{
 const f=await fixture(t);await f.prepare();await f.approve();let captured;
 f.controls.beforeCommit=r=>{if(JSON.parse(r.descriptor.eventText).sequence===2){captured=r;throw Error('intercept before native mutation');}};
 await assert.rejects(f.execute(),{code:'META_RECEIPT_COMMIT_UNKNOWN'});const before=await f.raw();assert.equal(before.connectionWrites[0].metaReceiptCursor.sequence,1);
 const mutate=(change,pretty=false)=>{
  const r=structuredClone(captured),event=JSON.parse(r.descriptor.eventText);change(event);
  r.descriptor.eventText=pretty?JSON.stringify(event,null,2):contentWriteSnapshot(event);
  r.descriptor.digest=createHash('sha256').update(r.descriptor.eventText).digest('hex');
  r.state.connectionWrites[0].metaReceiptCursor.digest=r.descriptor.digest;return JSON.stringify(r);
 };
 for(const raw of [mutate(e=>e.previousDigest=null),mutate(()=>{},true),mutate(e=>e.previousDigest='0'.repeat(64)),mutate(e=>e.simulated=false)]){
  await service(c=>assert.rejects(c.query('SELECT public.runvara_commit_meta_receipt($1)',[raw]),rejected()));assert.deepEqual(await f.raw(),before);
 }
 assert.equal((await f.read()).events.length,1);assert.equal(f.runs[0].simulation.observations().length,0);
});
test('native event append and workspace CAS roll back together on an injected state-write failure',async t=>{
 const f=await fixture(t);await f.prepare();await f.approve();const before=await f.raw();
 await admin.query("CREATE FUNCTION public.synthetic_meta_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state#>'{connectionWrites,0,metaReceiptCursor}' IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='P0M04',MESSAGE='synthetic rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_meta_fail BEFORE UPDATE ON public.saas_workspace_state FOR EACH ROW EXECUTE FUNCTION public.synthetic_meta_fail()");
 try{await assert.rejects(f.execute(),{code:'META_RECEIPT_CONFLICT'});assert.equal(f.runs[0].simulation.observations().length,0);assert.deepEqual(await f.raw(),before);
  assert.equal((await admin.query('SELECT count(*)::int n FROM public.runvara_meta_receipt_events WHERE workspace_id=$1',[f.workspaceId])).rows[0].n,0);
 }finally{await admin.query('DROP TRIGGER synthetic_meta_fail ON public.saas_workspace_state; DROP FUNCTION public.synthetic_meta_fail()');}
});
test('capacity reservations are bounded by tenant and global counts before the first send',async t=>{
 const f=await fixture(t);await f.prepare();await f.approve();let captured;f.controls.beforeCommit=r=>{captured=r;throw Error('intercept before first append');};
 await assert.rejects(f.execute(),{code:'META_RECEIPT_COMMIT_UNKNOWN'});const before=await f.raw();
 for(const scope of ['tenant','global']){
  const c=await connect('postgres');await c.query('BEGIN');
  try{
   const existing=(await c.query('SELECT count(*)::int n FROM public.runvara_meta_receipt_events WHERE sequence=1')).rows[0].n;
   const count=scope==='tenant'?16:64-existing;
   let workspaceId=f.workspaceId;
   if(scope==='global'){workspaceId='synthetic-global-capacity';await c.query('INSERT INTO public.workspaces(id,name,slug) VALUES($1,$1,$1)',[workspaceId]);await c.query('INSERT INTO public.saas_workspace_state(workspace_id,state) VALUES($1,$2)',[workspaceId,{workspace:{id:workspaceId}}]);}
   for(let i=0;i<count;i++)await c.query("INSERT INTO public.runvara_meta_receipt_events VALUES($1,$2,1,$2,'{}',$3,'{}',$4,$2,$2)",[workspaceId,'synthetic-capacity-'+scope+'-'+i,'0'.repeat(64),createHash('sha256').update(scope+String(i)).digest('hex')]);
   await c.query('SET LOCAL ROLE service_role');await assert.rejects(c.query('SELECT public.runvara_commit_meta_receipt($1)',[JSON.stringify(captured)]),rejected(['P0M03']));
  }finally{await c.query('ROLLBACK');await close(c);}
  assert.deepEqual(await f.raw(),before);
 }
});

test('escape-heavy approval, decoded asset and fifteen native events exceed the old read bound safely',async t=>{
 const f=await fixture(t),bodyState=await f.get();bodyState.marketing.campaigns[0].copy.longCaption='\\'.repeat(2200);
 f.selection.assetUrl='https://example.test/'+ 'x'.repeat(900);
 bodyState.marketing.campaigns[0].creativeRequests[0].assetUrls=[f.selection.assetUrl];
 await f.store.save(f.workspaceId,bodyState);
 const {previewMetaMarketingPublication}=await import('../lib/marketing-publication.mjs');
 const assetSnapshot=createMetaPublicationLocalAsset(await f.get(),f.campaignId,f.selection,f.session,png(),'image/png');
 const preview=previewMetaMarketingPublication(await f.get(),f.campaignId,f.selection,f.session,{assetSnapshot});
 const body={requestId:'meta-publication-request-0001',sourceRevision:preview.sourceRevision,target:preview.target,caption:preview.caption,asset:preview.asset};
 const state=await f.get(),capability=createMetaPublicationPreparationSimulation(state,f.campaignId,body,f.session,{protectedReceipts:true,assetSnapshot});
 await prepareMetaMarketingPublication(state,f.campaignId,body,f.session,{durableStore:true,preparationSimulation:capability,persist:o=>f.store.save(f.workspaceId,state,o)});await f.approve();
 let clock=Date.now();t.mock.method(Date,'now',()=>clock);await f.execute({containerStatus:'IN_PROGRESS'},{assetSnapshot});
 for(let i=0;i<4;i++){clock+=60001;await f.execute({containerStatus:'IN_PROGRESS'},{assetSnapshot});}clock+=60001;await f.execute({}, {assetSnapshot});
 const proof=await f.read();assert.equal(proof.events.length,15);assert.equal(JSON.parse(proof.events[0].eventText).projection.write.input.caption,preview.caption);
 assert.equal(JSON.parse(proof.events.at(-1).eventText).projection.write.marketingPublicationReceipt.localAssetSnapshot.decoded,true);
 const bytes=Buffer.byteLength(JSON.stringify(proof));assert.ok(bytes>560000);console.log('META_ENCODED_HISTORY_BYTES='+bytes);
});
test('near-full state refuses admission before either simulated mutation and retains its predecessor',async t=>{
 const f=await fixture(t);await f.prepare();await f.approve();const state=await f.raw();state.syntheticPadding='x'.repeat(2080768-Buffer.byteLength(JSON.stringify(state))-800);
 await service(c=>c.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1',[f.workspaceId,state]));
 await assert.rejects(f.execute(),{code:'META_RECEIPT_CAPACITY_OR_MODE'});assert.equal(f.runs[0].simulation.observations().length,0);
 const after=await f.raw();assert.equal(after.connectionWrites[0].metaReceiptCursor.sequence,1);assert.deepEqual(after.connectionWrites[0].dispatchClaim.phases,{});
});
test('state growth after container admission still reserves final receipt space before publishing',async t=>{
 const f=await fixture(t);await f.prepare();await f.approve();
 f.controls.afterCommit=r=>{if(JSON.parse(r.descriptor.eventText).sequence===3){const state=f.runs.at(-1).state;
  state.syntheticPadding='x'.repeat(2080768-Buffer.byteLength(JSON.stringify(state))-1000);}};
 await assert.rejects(f.execute(),{code:'META_RECEIPT_CAPACITY_OR_MODE'});
 assert.deepEqual(f.runs[0].simulation.observations().map(r=>r.phase),['instagram_container']);
 const state=await f.raw();assert.equal(state.connectionWrites[0].metaReceiptCursor.sequence,3);assert.equal(state.connectionWrites[0].dispatchClaim.phases.instagram_publish,undefined);
});


async function observationReady(t){
 const f=await fixture(t);await f.prepare();await f.approve();await f.execute({loseResponsePhase:'instagram_publish'});
 const proof=await f.read(),writeId=(await f.get()).connectionWrites[0].id,anchor=protectedMetaPublicationAdmission(proof,f.workspaceId,writeId);
 const capability=createMetaObservationSimulation([{anchor,response:{id:anchor.containerId,status_code:'PUBLISHED'}}]);
 const read=()=>metaPublicationObservations(f.store,writeId,f.session);
 const capture=(requestId=randomUUID())=>metaPublicationObservations(f.store,writeId,f.session,{capability,requestId});
 return {...f,writeId,anchor,capability,readObservations:read,capture};
}
test('native observations are dormant until the isolated fixture explicitly enables them',async t=>{
 const f=await observationReady(t);await assert.rejects(f.capture(),{code:'META_OBSERVATION_CAPACITY_OR_MODE'});
 assert.deepEqual((await f.readObservations()).observations,[]);
 await service(c=>assert.rejects(c.query("UPDATE public.runvara_meta_observation_control SET mode='enforced'"),rejected(['42501'])));
 await admin.query("UPDATE public.runvara_meta_observation_control SET mode='enforced'");
});
test('native observation retention is separate, restart-readable and never settles missing media IDs',async t=>{
 const f=await observationReady(t),before=await f.raw(),requestId=randomUUID();
 const saved=await f.capture(requestId);assert.equal(saved.observations.length,1);assert.equal(saved.observations[0].statusCode,'PUBLISHED');
 assert.equal(saved.observations[0].resultId,null);assert.equal(saved.replayPermitted,false);assert.equal(saved.providerReadPerformed,false);
 assert.deepEqual(await f.raw(),before);assert.deepEqual((await f.readObservations()).observations,saved.observations);
 await f.capture(requestId);assert.equal((await f.readObservations()).observations.length,1);
 const fresh=createMetaObservationSimulation([{anchor:f.anchor,response:{id:f.anchor.containerId,status_code:'ERROR'}}]);
 await metaPublicationObservations(f.store,f.writeId,f.session,{capability:fresh,requestId:randomUUID()});
 assert.deepEqual((await f.readObservations()).observations.map(row=>row.statusCode),['PUBLISHED','ERROR']);
 assert.deepEqual(await f.raw(),before);assert.equal(f.runs[0].simulation.observations().length,2);
});
test('native observation lost acknowledgement recovers by exact read with one append',async t=>{
 const f=await observationReady(t);f.controls.afterObservation=()=>{throw Error('synthetic append reply lost');};
 const result=await f.capture();assert.equal(result.observations.length,1);
 assert.equal(f.requests.filter(row=>row.name==='runvara_append_meta_observation').length,1);
});
test('native fresh authority inside append rejects concurrent owner/session changes',async t=>{
 const f=await observationReady(t);f.controls.beforeObservation=async()=>{const s=await f.raw();s.users[0].sessionVersion=2;
  await service(c=>c.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1',[f.workspaceId,s]));};
 await assert.rejects(f.capture());assert.equal((await admin.query('SELECT count(*)::int n FROM public.runvara_meta_observations WHERE workspace_id=$1',[f.workspaceId])).rows[0].n,0);
 await assert.rejects(f.readObservations());
});
test('native concurrent observation appends cannot exceed the eight-row cap',async t=>{
 const f=await observationReady(t);for(let i=0;i<7;i++)await f.capture();
 const outcomes=await Promise.allSettled([f.capture(),f.capture()]);assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1);
 assert.equal((await f.readObservations()).observations.length,8);await assert.rejects(f.capture(),{code:'META_OBSERVATION_CAPACITY_OR_MODE'});
});
test('native direct RPC rejects invented media IDs, wrong admission and altered provenance',async t=>{
 const f=await observationReady(t);await f.capture();
 const original=JSON.parse(f.requests.find(row=>row.name==='runvara_append_meta_observation').raw);
 for(const mutate of [o=>o.resultId='900000002',o=>o.anchor.containerId='999',o=>o.anchor.receiptDigest='0'.repeat(64),
  o=>o.providerReadPerformed=true,o=>o.executedExternally=true,o=>o.replayPermitted=true,o=>o.statusCode='SUCCESS',o=>o.actor.extra=true,
  o=>o.requestId=1234567890123456,o=>o.observedAt=o.observedAt.replace(/T\d\d:/,'T24:')]){
  const request=structuredClone(original),o=JSON.parse(request.descriptor.observationText);o.requestId=randomUUID();mutate(o);
  request.descriptor.observationText=contentWriteSnapshot(o);request.descriptor.digest=createHash('sha256').update(request.descriptor.observationText).digest('hex');
  await service(c=>assert.rejects(c.query('SELECT public.runvara_append_meta_observation($1)',[JSON.stringify(request)]),rejected(['P0O01'])));
 }
 const duplicate=structuredClone(original);duplicate.descriptor.observationText=duplicate.descriptor.observationText.replace('"simulated":true','"simulated":false,"simulated":true');
 duplicate.descriptor.digest=createHash('sha256').update(duplicate.descriptor.observationText).digest('hex');
 await service(c=>assert.rejects(c.query('SELECT public.runvara_append_meta_observation($1)',[JSON.stringify(duplicate)]),rejected(['P0O01'])));
 assert.equal((await f.readObservations()).observations.length,1);
});
test('native immutable observations survive paused control, old writers and base schema replay',async t=>{
 const f=await observationReady(t);await f.capture();const before=await f.readObservations();
 await admin.query("UPDATE public.runvara_meta_observation_control SET mode='paused'");
 try{
  await assert.rejects(f.capture(),{code:'META_OBSERVATION_CAPACITY_OR_MODE'});
  for(const role of ['anon','authenticated','service_role'])for(const sql of [
   'SELECT * FROM public.runvara_meta_observations','UPDATE public.runvara_meta_observations SET sequence=sequence','DELETE FROM public.runvara_meta_observations','TRUNCATE public.runvara_meta_observations'])
   await using(role,c=>assert.rejects(c.query(sql),rejected(['42501'])));
  for(const sql of ['DELETE FROM public.runvara_meta_observations','UPDATE public.runvara_meta_observations SET sequence=sequence','TRUNCATE public.runvara_meta_observations'])await assert.rejects(admin.query(sql),rejected(['P0M05']));
  await admin.query(baseline);
  for(const role of ['anon','authenticated','service_role'])await using(role,c=>assert.rejects(c.query('SELECT * FROM public.runvara_meta_observations'),rejected(['42501'])));
  const s=await f.raw();s.workspace.name='Unrelated predecessor state edit';await service(c=>c.query('UPDATE public.saas_workspace_state SET state=$2 WHERE workspace_id=$1',[f.workspaceId,s]));
  assert.deepEqual((await f.readObservations()).observations,before.observations);
 }finally{await admin.query("UPDATE public.runvara_meta_observation_control SET mode='enforced'");}
});
test('native observation readers cannot cross tenants or use rotated requester sessions',async t=>{
 const f=await observationReady(t);await f.capture();
 const r=JSON.parse(f.requests.find(row=>row.name==='runvara_read_meta_observations').raw);
 for(const mutate of [r=>r.workspaceId='other-tenant',r=>r.actor.sessionVersion=999,r=>r.actor.userId='other-owner']){
  const copy=structuredClone(r);mutate(copy);await service(c=>assert.rejects(c.query('SELECT public.runvara_read_meta_observations($1)',[JSON.stringify(copy)]),rejected(['P0M02','P0O02'])));
 }
});
