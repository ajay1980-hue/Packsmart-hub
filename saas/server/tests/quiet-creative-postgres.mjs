import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import {before,after,test} from 'node:test';
import {seedWorkspaceState} from '../lib/store.mjs';
import {creativeDigest,newCreativeRequest} from '../lib/creative-safety.mjs';
import {createQuietCreativePilot,runQuietCreativePilot,CREATIVE_PILOT_SCHEMA} from '../lib/quiet-creative-pilot.mjs';
import {runwayCreativeInput} from '../lib/marketing-providers.mjs';
import {creativeBinding,creativeRpcParams,creativeRpcResult} from '../lib/creative-allowance.mjs';
const tests=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(tests,'../../..');
const folder=path.resolve(process.env.CREATIVE_NATIVE_EVIDENCE_DIR||path.join(os.tmpdir(),'runvara-creative-native-'+randomUUID()));fs.mkdirSync(folder,{recursive:true});
assert.equal(process.env.OUTCOME_ALLOW_DISPOSABLE_TEST_DB,'1','Explicit disposable local database opt-in is required');
const url=new URL(process.env.OUTCOME_TEST_DATABASE_URL);assert.equal(url.protocol,'postgres:');assert.equal(url.hostname,'127.0.0.1');assert.equal(url.username,'postgres');assert.ok(['/runvara_outcome_test','/runvara_atomic_usage_test'].includes(url.pathname));assert.equal(url.search,'');assert.equal(url.hash,'');
const dependencies=process.env.CREATIVE_NATIVE_DEPENDENCIES||path.join(tests,'atomic-usage/package.json');
const require=createRequire(dependencies);const {Client}=require('pg');assert.equal(require('pg/package.json').version,'8.16.3');
const hash=x=>createHash('sha256').update(x).digest('hex');
let root,admin,child,database,externalAttempts=0;const clients=new Set();
globalThis.fetch=async()=>{externalAttempts++;throw Error('External transport forbidden');};
async function connect(role='service_role') {const c=new Client({connectionString:child.toString(),ssl:false,options:'',connectionTimeoutMillis:3000,statement_timeout:12000});await c.connect();clients.add(c);assert.equal(c.connection.stream.remoteAddress,'127.0.0.1');if(role!=='postgres')await c.query('SET SESSION AUTHORIZATION '+role);return c;}
async function close(c){clients.delete(c);await c.end();}
async function using(fn,role='service_role'){const c=await connect(role);try{return await fn(c);}finally{await close(c);}}
async function rpc(name,params,c=null){assert.match(name,/^(prepare|review|decide|reserve|confirm|observe|settle)$/);const keys=Object.keys(params);assert.ok(keys.every(k=>/^p_[a-z_]+$/.test(k)));const run=async client=>(await client.query('SELECT public.runvara_creative_'+name+'('+keys.map((k,i)=>k+'=> $'+(i+1)).join(',')+') result',Object.values(params).map(v=>v&&typeof v==='object'?JSON.stringify(v):v))).rows[0].result;return c?run(c):using(run);}
async function call(name,f,input,c){const p=creativeRpcParams(name,f.id,input);return creativeRpcResult(name,await rpc(name,p,c),p);}
before(async()=>{
 root=new Client({connectionString:url.toString(),ssl:false,options:'',connectionTimeoutMillis:3000});await root.connect();
 const info=(await root.query("SELECT current_setting('server_version_num')::int version,current_setting('data_directory') dir,current_setting('listen_addresses') listen")).rows[0];assert.ok(info.version>=170000&&info.version<180000);assert.equal(info.listen,'127.0.0.1');if(process.env.CREATIVE_NATIVE_DATA)assert.equal(path.resolve(info.dir),path.resolve(process.env.CREATIVE_NATIVE_DATA));
 database='runvara_creative_'+randomUUID().replaceAll('-','');await root.query('CREATE DATABASE '+database);child=new URL(url);child.pathname='/'+database;admin=await connect('postgres');
 let foundation=fs.readFileSync(path.join(repo,'saas/server/tests/atomic-usage-postgres-fixture.sql'),'utf8');
 for(const role of ['anon','authenticated','service_role','atomic_usage_untrusted']){if((await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount) foundation=foundation.replace(new RegExp('create role '+role+' [^;]+;'),'');}
 await admin.query(foundation);
 const catalog=JSON.parse(fs.readFileSync(path.join(tests,'creative-allowance-postgres-fixture.json')));
 for(const f of catalog.sqlFiles){const sql=fs.readFileSync(path.join(repo,'saas/server/supabase',f.path),'utf8').replaceAll('\r\n','\n');assert.equal(hash(sql),f.executedLfSha256);await admin.query(sql);}
 await admin.query('GRANT SELECT, INSERT, UPDATE, DELETE ON public.saas_workspace_state TO service_role');
 const candidate=fs.readFileSync(path.join(repo,'saas/server/supabase/migrations/20261025131500_creative_allowances.sql'),'utf8');
 fs.writeFileSync(path.join(folder,'migration-executed.sql'),candidate);await admin.query(candidate);
 fs.writeFileSync(path.join(folder,'installed-contract.json'),JSON.stringify({postgres:info.version,baselineSources:catalog.sqlFiles.length,installedSourceHashesVerified:true,candidateSha256:hash(candidate),hostedExecution:false},null,2));
});
after(async()=>{assert.equal(externalAttempts,0);await Promise.all([...clients].map(close));if(database&&root)await root.query('DROP DATABASE '+database);await root?.end();fs.writeFileSync(path.join(folder,'native-result.json'),JSON.stringify({childDropped:!!database,externalAttempts,hostedPostgrest:false,syntheticOnly:true},null,2));});

async function fixture({account='native-account-'+randomUUID(),tenantLimit=1000,accountLimit=1000,policyWindowMs=599000}={}) {
 const id='native-'+randomUUID(), state=seedWorkspaceState({}, {workspaceId:id,email:'owner@synthetic.test'});
 Object.assign(state.users[0],{active:true,passwordChangeRequired:false,sessionVersion:1});state._revision=randomUUID();
 const campaign={id:'campaign-'+randomUUID(),product:{image:'https://example.test/synthetic.png',title:'Synthetic carton'},copy:{headline:'Synthetic'},creativeRequests:[]};
 const request=newCreativeRequest({workspaceId:id,campaignId:campaign.id,provider:'runway',kind:'product_video',formats:[]});campaign.creativeRequests.push(request);state.marketing.campaigns=[campaign];
 const auth={user:state.users[0],session:{workspaceId:id,sub:state.users[0].id,sessionVersion:1}};
 const env={RUNVARA_STARTUP_MODE:'quiet',MARKETING_ENV_WORKSPACE_ID:id,RUNWAY_API_KEY:'synthetic-only-key'},input=runwayCreativeInput(campaign,request,env);
 const d={schema:CREATIVE_PILOT_SCHEMA,workspaceId:id,ownerId:state.users[0].id,campaignId:campaign.id,requestId:request.id,providerAccountId:account,
  policyRevision:'creative-policy:'+createHash('md5').update('budget-v1|account-v1|account:runway:'+account).digest('hex'),priceRevision:'price-v1',
  inputDigest:creativeDigest({workspaceId:id,campaignId:campaign.id,requestId:request.id,provider:'runway',phase:'generation',endpoint:input.endpoint,payloadDigest:input.payloadDigest,accountBinding:input.accountBinding,sourceDigest:input.sourceDigest}),
  sourceDigest:input.sourceDigest,payloadDigest:input.payloadDigest,accountBinding:input.accountBinding,operationId:randomUUID(),maxCostMicros:600,
  notBefore:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+599000).toISOString()};
 env.RUNVARA_QUIET_CREATIVE_PILOT=JSON.stringify(d);
 const policyExpiry=new Date(Math.min(Date.parse(d.expiresAt),Date.now()+policyWindowMs)).toISOString();
 await admin.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$1,$1)',[id]);await admin.query('INSERT INTO saas_workspace_state(workspace_id,state) VALUES($1,$2)',[id,JSON.stringify(state)]);
 await admin.query("INSERT INTO runvara_creative_budgets(scope_key,workspace_id,policy_revision,enabled,baseline_verified,not_before,valid_until,limit_cost_micros) VALUES($1,$2,'budget-v1',true,true,clock_timestamp()-interval '1 minute',$3,$4)",['tenant:'+id,id,policyExpiry,tenantLimit]);
 await admin.query("INSERT INTO runvara_creative_budgets(scope_key,provider,provider_account_id,policy_revision,enabled,baseline_verified,not_before,valid_until,limit_cost_micros) VALUES($1,'runway',$2,'account-v1',true,true,clock_timestamp()-interval '1 minute',$3,$4) ON CONFLICT DO NOTHING",['account:runway:'+account,account,policyExpiry,accountLimit]);
 await admin.query("INSERT INTO runvara_creative_prices(workspace_id,provider,phase,contract_id,account_binding,provider_account_id,price_revision,verified,entitlement_verified,max_cost_micros,valid_until,evidence_reference) VALUES($1,'runway','generation','runway-product-ad-10s/v1',$2,$3,'price-v1',true,true,600,$4,'synthetic fixture only')",[id,input.accountBinding,account,policyExpiry]);
 const hooks={},posts=[],reads=[],saves=[],calls=[];let clockOffset=0;
 const current=async()=>using(async c=>(await c.query('SELECT state FROM saas_workspace_state WHERE workspace_id=$1',[id])).rows[0].state);
 const store={provider:'supabase',get:async(workspace,options)=>{assert.equal(workspace,id);assert.equal(options.exactSnapshot,true);await hooks.get?.();return current();},
  async save(workspace,value,options){assert.equal(workspace,id);assert.equal(options.ownedSnapshot,true);const n=saves.length+1;
   options.beforeEffects(value,{});await hooks.beforeSave?.(value,n);options.beforeCommit(value);const previous=value._revision,proposal=structuredClone(value);proposal._revision=randomUUID();
   await using(async c=>{await c.query('BEGIN');try{const r=await c.query("UPDATE saas_workspace_state SET state=$2 WHERE workspace_id=$1 AND state->>'_revision'=$3 RETURNING state",[id,JSON.stringify(proposal),previous]);if(r.rowCount!==1)throw Object.assign(Error('STATE_CONFLICT'),{code:'STATE_CONFLICT'});await hooks.beforeCommit?.(c);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}});
   value._revision=proposal._revision;saves.push(proposal);await hooks.afterSave?.(value,n);return structuredClone(proposal);
  },
  async creativeAllowanceRpc(name,workspace,args){assert.equal(workspace,id);calls.push(name);await hooks.beforeRpc?.(name,args);const p=creativeRpcParams(name,id,args),r=creativeRpcResult(name,await rpc(name,p),p);await hooks.afterRpc?.(name,r);return r;}
 };
 const makePilot=()=>createQuietCreativePilot(env,{now:()=>Date.now()+clockOffset});let pilot=makePilot();
 const fetchImpl=async(url,options={})=>{if(options.method==='POST'){posts.push(url);assert.equal(url,input.endpoint);assert.equal(options.body,input.body);}else{reads.push(url);assert.equal(url,'https://api.dev.runwayml.com/v1/tasks/native-task');}return hooks.provider?hooks.provider(url,options):Response.json(options.method==='POST'?{id:'native-task'}:{status:'RUNNING',progress:10});};
 const f={id,state,auth,env,d,store,hooks,posts,reads,saves,calls,current,get pilot(){return pilot;},restart(){pilot=makePilot();},advance(ms){clockOffset+=ms;},
  run(operation,body={requestId:request.id},p=pilot){return runQuietCreativePilot({pilot:p,store,auth,env,operation,body,fetchImpl});},
  async ready(){await f.run('prepare');const a=(await f.run('review')).allowance;return f.run('decide',{requestId:request.id,approvalId:a.id,revision:a.revision,decision:'approved'});},
  async budgets(){return(await admin.query('SELECT * FROM runvara_creative_budgets WHERE scope_key=ANY($1::text[]) ORDER BY scope_key',[['tenant:'+id,'account:runway:'+account]])).rows;},
  async mutate(fn){const s=await current();fn(s);await admin.query('UPDATE saas_workspace_state SET state=$2 WHERE workspace_id=$1',[id,JSON.stringify(s)]);}
 };return f;
}

test('native controller admission saves intent and accepted receipt using installed guards, completion keeps both holds',async()=>{
 const f=await fixture();await f.ready();const sent=await f.run('submit');assert.equal(sent.taskId,'native-task');assert.equal(f.posts.length,1);assert.equal(f.saves.length,2);
 f.hooks.provider=()=>Response.json({status:'SUCCEEDED',output:['https://example.test/synthetic.mp4']});const done=await f.run('observe');assert.equal(done.status,'complete');
 for(const b of await f.budgets()){assert.equal(b.held_cost_micros,'600');assert.equal(b.spent_cost_micros,'0');}
 assert.equal(f.pilot.status().open,false);assert.equal((await f.current()).audit.filter(a=>a.type==='maintenance_creative_saved').length,4);
});

test('independent controller instances competing for the same request cannot both dispatch',async()=>{
 const f=await fixture();await f.ready();const other=createQuietCreativePilot(f.env);const r=await Promise.allSettled([f.run('submit'),f.run('submit',undefined,other)]);
 assert.ok(f.posts.length<=1);assert.ok(r.some(x=>x.status==='rejected'));for(const b of await f.budgets())assert.equal(b.held_cost_micros,'600');
});

test('two tenants compete atomically for the same provider account without exceeding its budget',async()=>{
 const account='shared-'+randomUUID(),a=await fixture({account}),b=await fixture({account});await a.ready();await b.ready();
 const r=await Promise.allSettled([a.run('submit'),b.run('submit')]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(a.posts.length+b.posts.length,1);
 const accountRow=(await a.budgets()).find(x=>x.provider);assert.equal(accountRow.held_cost_micros,'600');
});

test('native known-task read cap survives process-object restarts and retains durable intent before transport',async()=>{
 const f=await fixture();await f.ready();await f.run('submit');for(let i=0;i<5;i++){f.restart();await f.run('observe');}
 f.restart();await assert.rejects(f.run('observe'),/READ_LIMIT/);assert.equal(f.reads.length,5);assert.equal(f.posts.length,1);
 assert.equal((await f.current()).marketing.campaigns[0].creativeRequests[0].safety.phases.generation.maintenanceObservationAttempts,5);
});

for(const boundary of ['reserve','confirm','observe'])test('lost native '+boundary+' acknowledgement retains evidence and forbids replay',async()=>{
 const f=await fixture();await f.ready();f.hooks.afterRpc=name=>{if(name===boundary)throw Error('synthetic lost acknowledgement');};await assert.rejects(f.run('submit'));
 delete f.hooks.afterRpc;f.restart();await assert.rejects(f.run('submit'));assert.equal(f.posts.length,boundary==='observe'?1:0);for(const b of await f.budgets())assert.equal(b.held_cost_micros,'600');
});

test('lost native claim-save acknowledgement cannot send and restart cannot replay',async()=>{
 const f=await fixture();await f.ready();f.hooks.afterSave=(_,n)=>{if(n===1)throw Error('synthetic save acknowledgement lost');};await assert.rejects(f.run('submit'));
 delete f.hooks.afterSave;f.restart();await assert.rejects(f.run('submit'));assert.equal(f.posts.length,0);for(const b of await f.budgets())assert.equal(b.held_cost_micros,'600');
});

test('native transaction rollback leaves reserved hold without falsely recording a dispatch or permitting retry',async()=>{
 const f=await fixture();await f.ready();const before=await f.current();f.hooks.beforeCommit=()=>{throw Error('synthetic rollback');};await assert.rejects(f.run('submit'));
 assert.deepEqual(await f.current(),before);assert.equal(f.posts.length,0);delete f.hooks.beforeCommit;f.restart();await assert.rejects(f.run('submit'));assert.equal(f.posts.length,0);for(const b of await f.budgets())assert.equal(b.held_cost_micros,'600');
});

for(const change of ['revocation','role','session','price','account'])test('native last admission rejects '+change+' drift while retaining reserved exposure',async()=>{
 const f=await fixture();const approved=await f.ready();f.hooks.beforeRpc=async name=>{if(name!=='confirm')return;
  if(change==='revocation')await rpc('decide',creativeRpcParams('decide',f.id,{auth:f.auth,approvalId:approved.allowance.id,revision:approved.allowance.revision,decision:'revoked'}));
  else if(change==='role')await f.mutate(s=>s.users[0].role='viewer');else if(change==='session')await f.mutate(s=>s.users[0].sessionVersion++);
  else await admin.query('UPDATE runvara_creative_prices SET '+(change==='price'?"price_revision='changed'":"provider_account_id='changed'")+' WHERE workspace_id=$1',[f.id]);
 };await assert.rejects(f.run('submit'));assert.equal(f.posts.length,0);for(const b of await f.budgets())assert.equal(b.held_cost_micros,'600');
});

test('native uncertain provider outcome survives closure and renewed object without second dispatch',async()=>{
 const f=await fixture();await f.ready();f.hooks.provider=()=>{throw Error('synthetic provider timeout');};await assert.rejects(f.run('submit'));
 const before=await f.budgets();assert.ok(before.every(b=>b.held_cost_micros==='600'&&b.uncertain_cost_micros==='600'));f.pilot.close();f.restart();await assert.rejects(f.run('submit'));assert.equal(f.posts.length,1);assert.deepEqual(await f.budgets(),before);
});

test('native accepted receipt completing after expiry is retained; fixed descriptor cannot reopen on restart',async()=>{
 const f=await fixture();await f.ready();f.hooks.provider=()=>{f.advance(600000);return Response.json({id:'native-task'});};await assert.rejects(f.run('submit'));
 assert.equal((await f.current()).marketing.campaigns[0].creativeRequests[0].taskId,'native-task');f.restart();assert.equal(f.pilot.available(),false);assert.equal(f.posts.length,1);for(const b of await f.budgets())assert.equal(b.held_cost_micros,'600');
});

test('missing native entitlement does not prepare approval, reserve budget or reach provider',async()=>{
 const f=await fixture();await admin.query('UPDATE runvara_creative_prices SET entitlement_verified=false WHERE workspace_id=$1',[f.id]);await assert.rejects(f.run('prepare'));assert.equal(f.posts.length,0);for(const b of await f.budgets())assert.equal(b.held_cost_micros,'0');
});

test('native approval deadline shorter than descriptor is rechecked after last snapshot wait',async()=>{
 const f=await fixture({policyWindowMs:120000});await f.ready();let admitted=false;
 f.hooks.afterRpc=name=>{if(name==='confirm')admitted=true;};f.hooks.get=()=>{if(admitted)f.advance(150000);};
 await assert.rejects(f.run('submit'));assert.equal(f.pilot.available(),true);assert.equal(f.posts.length,0);for(const b of await f.budgets())assert.equal(b.held_cost_micros,'600');
});

if(process.env.CREATIVE_NATIVE_PG_CTL)test('physical PostgreSQL restart retains known task, read cap, hold and audit; generation cannot replay',async()=>{
 const f=await fixture();await f.ready();await f.run('submit');await f.run('observe');
 const snapshot=async()=>({state:await f.current(),budgets:await f.budgets(),audit:(await admin.query('SELECT * FROM runvara_creative_audit WHERE workspace_id=$1 ORDER BY id',[f.id])).rows});const before=await snapshot();
 const data=path.resolve(process.env.CREATIVE_NATIVE_DATA),ctl=path.resolve(process.env.CREATIVE_NATIVE_PG_CTL),runtime=path.dirname(data);
 assert.equal(path.basename(data),'cluster');assert.equal(ctl,path.join(runtime,'postgresql-runtime/pgsql/bin/pg_ctl.exe'));assert.equal(path.basename(path.dirname(runtime)),'.local-db-tests');
 assert.equal(path.resolve((await admin.query("SELECT current_setting('data_directory') dir")).rows[0].dir),data);
 await Promise.all([...clients].map(close));await root.end();
 const result=spawnSync(ctl,['-D',data,'-m','fast','-w','-t','20','restart'],{encoding:'utf8',windowsHide:true,timeout:30000});fs.writeFileSync(path.join(folder,'physical-restart.log'),String(result.stdout||'')+String(result.stderr||''));assert.equal(result.status,0);
 root=new Client({connectionString:url.toString(),ssl:false,options:'',connectionTimeoutMillis:3000});await root.connect();admin=await connect('postgres');assert.deepEqual(await snapshot(),before);
 f.restart();await assert.rejects(f.run('submit'));assert.equal(f.posts.length,1);assert.equal((await f.current()).marketing.campaigns[0].creativeRequests[0].safety.phases.generation.maintenanceObservationAttempts,1);
});
