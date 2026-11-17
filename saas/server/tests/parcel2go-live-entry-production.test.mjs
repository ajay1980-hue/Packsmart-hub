import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {createLiveCredentialEntryController} from '../lib/parcel2go-live-entry-controller.mjs';
import {createWorkspaceLock} from '../lib/workspace-lock.mjs';
import {assertParcel2GoLivePersistencePermit} from '../lib/parcel2go-live-admission.mjs';
import {PARCEL2GO_WORKSPACE_LIMITS} from '../lib/parcel2go-workspace-fingerprint.mjs';
import {planAutomationRetention} from '../lib/automation-retention.mjs';
import {BRIEF_HISTORY_CONTRACT,planBriefHistoryCompaction} from '../lib/brief-history.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {maintenanceFixture,ownerState,SECRET} from './maintenance-login-fixture.mjs';import {createSessionToken,verifySessionToken} from '../lib/security.mjs';import {parcel2GoCanonicalHash as hash} from '../lib/parcel2go-live-canonical.mjs';import {LIVE_ENTRY_PATH} from '../lib/parcel2go-live-entry-window.mjs';
async function fixture(t,extra={}){const {entryConfig={},prepareState=()=>{},env:extraEnv={},...serverExtra}=extra;const state=ownerState('packsmart-solutions');prepareState(state);const token=createSessionToken({userId:state.users[0].id,workspaceId:state.workspace.id,email:'synthetic@example.test',role:'owner',csrf:'synthetic-csrf-at-least-16'},SECRET),session=verifySessionToken(token,SECRET);const config={requestId:randomUUID(),expectedRevision:state._revision,trustedBinding:{workspaceId:state.workspace.id,connectionId:'synthetic-live-entry',accountId:'synthetic-own-alias',environment:'live'},expectedClientId:'synthetic-client-id',termsReference:'synthetic-terms-owner-review',expiresAt:new Date(Date.now()+300000).toISOString(),expectedSessionFingerprint:hash(session),principalEmail:'synthetic@example.test',accountEvidenceReference:'synthetic-observed-account',scope:'private_storage_only',...entryConfig};const f=await maintenanceFixture({states:[state],env:{RUNVARA_QUIET_OWNER_WORKSPACE:'enabled/v1',RUNVARA_QUIET_PARCEL2GO_LIVE_CREDENTIAL_ENTRY:'enabled/v1',RUNVARA_PARCEL2GO_LIVE_ENTRY_CONFIG:JSON.stringify(config),...extraEnv},...serverExtra});t.after(f.close);const cookie='__Host-packsmart_session='+token;const status=()=>f.request(LIVE_ENTRY_PATH,{cookie});const descriptor=(await status()).payload;const body={clientId:config.expectedClientId,clientSecret:'synthetic-client-secret',requestId:config.requestId,expectedRevision:state._revision,reviewDigest:descriptor.reviewDigest,confirmed:true};const submit=(overrides={})=>f.request(LIVE_ENTRY_PATH,{method:'POST',cookie,headers:{Origin:f.config.APP_PUBLIC_URL,'X-CSRF-Token':session.csrf},body,...overrides});return {...f,state,session,config,cookie,body,status,submit};}
test('real server production storage path with synthetic inputs stores once, no provider',async t=>{const f=await fixture(t);assert.equal((await f.status()).payload.status,'ready');const r=await f.submit();assert.equal(r.status,200);assert.equal(r.payload.status,'stored');const stored=f.fake.states.get('packsmart-solutions');assert.equal(stored.connections.at(-1).provider,'parcel2go-live');assert.ok(!JSON.stringify(stored).includes('synthetic-client-secret'));assert.equal((await f.status()).payload.status,'stored');const before=f.calls.filter(x=>x.method==='PATCH').length;assert.equal((await f.submit()).status,409);assert.equal(f.calls.filter(x=>x.method==='PATCH').length,before)});
test('body cannot swap reviewed account scope',async t=>{const f=await fixture(t);f.body.reviewDigest='0'.repeat(64);assert.equal((await f.submit()).status,409);assert.equal(f.calls.filter(x=>x.method==='PATCH').length,0)});
for(const error of ['csrf','origin','bearer'])test('production route rejects '+error,async t=>{const f=await fixture(t);let options={};if(error==='bearer')options={cookie:undefined,headers:{Authorization:'Bearer '+f.cookie.split('=')[1],Origin:f.config.APP_PUBLIC_URL,'X-CSRF-Token':f.session.csrf}};else options={headers:{Origin:error==='origin'?'https://evil.example':f.config.APP_PUBLIC_URL,'X-CSRF-Token':error==='csrf'?'bad':f.session.csrf}};assert.equal((await f.submit(options)).status,409);assert.equal(f.calls.filter(x=>x.method==='PATCH').length,0)});
test('concurrent real HTTP submissions result in one stored save',async t=>{const f=await fixture(t);const results=await Promise.all([f.submit(),f.submit()]);assert.equal(results.filter(x=>x.status===200).length,1);assert.equal(f.calls.filter(x=>x.method==='PATCH').length,1)});
test('shutdown drains and closes admission',async t=>{const f=await fixture(t);await f.server.packsmart.drain();assert.notEqual((await f.submit()).status,200);assert.equal(f.calls.filter(x=>x.method==='PATCH').length,0)});
test('lost final DB acknowledgement reconciles on read without retry',async t=>{let patches=0;const f=await fixture(t,{beforeListen:({store})=>{const save=store.save.bind(store);store.save=async(...a)=>{const r=await save(...a);if(++patches===1)throw Error('synthetic-lost-ack');return r}}});assert.equal((await f.submit()).status,409);const before=patches;assert.equal((await f.status()).payload.status,'stored');assert.equal((await f.submit()).status,409);assert.equal(patches,before)});
test('real HTTP status read has bounded stalled-store deadline',async t=>{const f=await fixture(t);f.store.get=()=>new Promise(()=>{});const start=Date.now();const r=await f.status();assert.equal(r.status,409);assert.ok(Date.now()-start<4000);assert.equal(f.calls.filter(x=>x.method==='PATCH').length,0)});
test('real HTTP expired window cannot save',async t=>{const f=await fixture(t,{entryConfig:{expiresAt:new Date(Date.now()+1000).toISOString()}});await new Promise(r=>setTimeout(r,1100));assert.equal((await f.submit()).status,409);assert.equal(f.calls.filter(x=>x.method==='PATCH').length,0);assert.equal((await f.status()).payload.canSubmit,false)});
test('HTTP disconnect during authentication prevents admission',async t=>{let hold=false,release,entered;const gate=new Promise(r=>release=r),seen=new Promise(r=>entered=r);const f=await fixture(t,{intercept:async({options,proceed})=>{if(hold&&options.method!=='PATCH'){hold=false;entered();await gate;}return proceed()}});hold=true;const controller=new AbortController(),p=f.submit({signal:controller.signal});await seen;controller.abort();await assert.rejects(p);release();await f.server.packsmart.drain();assert.equal(f.calls.filter(x=>x.method==='PATCH').length,0)});
test('queued HTTP request cannot save after persisted owner revocation',async t=>{let pause=true,release,entered;const gate=new Promise(r=>release=r),seen=new Promise(r=>entered=r);const f=await fixture(t,{intercept:async({options,proceed})=>{if(pause&&options.method==='PATCH'){pause=false;entered();await gate;}return proceed()}});const a=f.submit();await seen;const b=f.submit();const persisted=f.fake.states.get('packsmart-solutions');persisted.users[0].role='member';persisted._revision=randomUUID();release();const results=await Promise.all([a,b]);assert.ok(results.every(x=>x.status===409));assert.ok(!f.fake.states.get('packsmart-solutions').connections.some(x=>x.provider==='parcel2go-live'))});

// Synthetic transport latency only: no production measurements or external IO.
// Controlled-clock cases isolate the IO budget; real timers exercise response
// timeout versus already-dispatched writes. Neither changes server limits.
function archiveNeeded(state){
 const at='2026-01-01T00:00:00.000Z';
 state.audit=Array.from({length:300},(_,i)=>({id:'synthetic-audit-'+i,type:'synthetic',actor:'system',detail:{},createdAt:at}));
 for(const [key,length] of [['workRecords',101],['connectionSyncs',101],['agentRuns',2]])state[key]=Array.from({length},(_,i)=>({id:'synthetic-'+key+'-'+i,status:'COMPLETED',createdAt:at}));
 state.dailyBriefs=Array.from({length:31},(_,i)=>({id:'synthetic-brief-'+i,summary:'Synthetic history',generatedAt:at}));
}
const latencyCases=[
 {name:'minimal-zero',read:0,write:0,archive:0},
 ...[100,200,222,223,250,400,444,445,666,667].map(ms=>({name:'minimal-each-'+ms,read:ms,write:ms,archive:ms})),
 {name:'minimal-read-300',read:300,write:0,archive:0},
 {name:'minimal-write-1000',read:0,write:1000,archive:0},
 ...[0,100,150,200,300].map(ms=>({name:'archive-each-'+ms,read:ms,write:ms,archive:ms,archives:true})),
 {name:'archive-only-400',read:0,write:0,archive:400,archives:true},
 {name:'real-minimal-each-150',read:150,write:150,archive:150,real:true},
 {name:'real-minimal-each-250',read:250,write:250,archive:250,real:true},
 {name:'real-minimal-read-1400',read:1400,write:0,archive:0,real:true},
 {name:'real-archive-slow',read:100,write:100,archive:400,archives:true,real:true},
 {name:'real-archive-stops-at-deadline',read:100,write:100,archive:1400,archives:true,real:true},
 {name:'real-atomic-commit-late',read:0,write:4100,archive:0,delayWrite:1,real:true},
 {name:'real-atomic-commit-after-browser-deadline',read:0,write:5100,archive:0,delayWrite:1,real:true}
];
// Exact controlled-clock expectations: [HTTP, stage, receipt, reads, writes,
// archive writes, elapsed IO ms]. CPU/serialization time is deliberately absent.
const latencyExpected={
 'minimal-zero':[200,"stored","completed",5,1,0,0],
 'minimal-each-100':[200,"stored","completed",5,1,0,600],
 'minimal-each-200':[200,"stored","completed",5,1,0,1200],
 'minimal-each-222':[200,"stored","completed",5,1,0,1332],
 'minimal-each-223':[200,"stored","completed",5,1,0,1338],
 'minimal-each-250':[200,"stored","completed",5,1,0,1500],
 'minimal-each-400':[200,"stored","completed",5,1,0,2400],
 'minimal-each-444':[200,"stored","completed",5,1,0,2664],
 'minimal-each-445':[200,"stored","completed",5,1,0,2670],
 'minimal-each-666':[200,"stored","completed",5,1,0,3996],
 'minimal-each-667':[409,"saved_status","completed",5,1,0,4002],
 'minimal-read-300':[200,"stored","completed",5,1,0,1500],
 'minimal-write-1000':[200,"stored","completed",5,1,0,1000],
 'archive-each-0':[200,"stored","completed",5,1,5,0],
 'archive-each-100':[200,"stored","completed",5,1,5,1100],
 'archive-each-150':[200,"stored","completed",5,1,5,1650],
 'archive-each-200':[200,"stored","completed",5,1,5,2200],
 'archive-each-300':[200,"stored","completed",5,1,5,3300],
 'archive-only-400':[200,"stored","completed",5,1,5,2000]
};
for(const scenario of latencyCases)test('synthetic save latency: '+scenario.name,{timeout:10000},async t=>{
 let armed=false,elapsed=0,patches=0,active=0;const trace=[],wallNow=performance.now.bind(performance),base=Date.now();
 if(!scenario.real){t.mock.method(performance,'now',()=>elapsed);t.mock.method(Date,'now',()=>base+elapsed);}
 const f=await fixture(t,{prepareState:scenario.archives?archiveNeeded:undefined,intercept:async({url,options,proceed})=>{
  if(!armed)return proceed();
  const method=options.method||'GET',table=url.pathname.split('/').at(-1);
  const kind=method==='GET'&&table==='saas_workspace_state'?'read':method==='PATCH'&&table==='saas_workspace_state'?'write':method==='POST'&&['audit_events','runvara_history','operations_briefs'].includes(table)?'archive':null;
  assert.ok(kind,'Unexpected synthetic transport operation');
  if(kind==='write')patches++;
  const delay=kind==='write'&&scenario.delayWrite&&patches!==scenario.delayWrite?0:scenario[kind];
  const row={kind,startMs:scenario.real?Math.round(wallNow()-started):elapsed,delayMs:delay};trace.push(row);active++;
  try{if(scenario.real){if(delay)await new Promise(r=>setTimeout(r,delay));}else{await new Promise(r=>setImmediate(r));elapsed+=delay;}const result=await proceed();row.endMs=scenario.real?Math.round(wallNow()-started):elapsed;return result;}finally{active--;}
 }});
 const stateSummary=()=>{const s=f.fake.states.get('packsmart-solutions');return {receipt:s.parcel2goLiveQuoteRuns?.[0]?.status??'none',connections:s.connections.filter(c=>c.provider==='parcel2go-live').length,admissionAudits:s.audit.filter(a=>a.type==='parcel2go_live_reserved'||a.type==='parcel2go_live_completed').length,archiveRows:[...f.fake.tables.values()].reduce((n,rows)=>n+rows.length,0)};};
 const started=wallNow();armed=true;const response=await f.submit(),responseMs=scenario.real?Math.round(wallNow()-started):elapsed,atResponse=stateSummary();
 // Observe outstanding transport completion without draining/closing admission
 // first, which would change the result of this investigation.
 for(let turns=0;turns<1000;turns++){await new Promise(r=>setImmediate(r));if(!active)break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(active,0,'Synthetic transport did not settle');
 const settled=stateSummary(),counts=Object.fromEntries(['read','write','archive'].map(k=>[k,trace.filter(x=>x.kind===k).length]));
 armed=false;const writesBefore=f.calls.filter(x=>x.method==='PATCH'||x.method==='POST').length,reconciled=await f.status();
 assert.equal(f.calls.filter(x=>x.method==='PATCH'||x.method==='POST').length,writesBefore,'Reconciliation wrote state');
 assert.equal(JSON.stringify(f.fake.states.get('packsmart-solutions')).includes('synthetic-client-secret'),false);
 assert.ok([200,409].includes(response.status));
 if(response.status===200){assert.equal(response.payload.status,'stored');assert.equal(settled.receipt,'completed');assert.equal(settled.connections,1);assert.equal(reconciled.payload.status,'stored');}
 else{assert.equal(response.payload.status,'unconfirmed');assert.equal(response.payload.diagnostic.cause,'deadline');assert.ok(response.payload.diagnostic.durationMs<=4000);assert.equal(reconciled.payload.canSubmit,false);}
 assert.equal(settled.connections,settled.receipt==='completed'?1:0);
 assert.equal(settled.receipt==='reserved',false,'Atomic credential saves never leave a new reservation');assert.equal(counts.write,settled.receipt==='completed'?1:0);
 assert.equal(settled.admissionAudits,counts.write*2);
 if(!scenario.archives)assert.equal(counts.archive,0);
 if(!scenario.real)assert.deepEqual([response.status,response.payload.diagnostic?.stage??'stored',settled.receipt,counts.read,counts.write,counts.archive,responseMs],latencyExpected[scenario.name]);
 if(scenario.delayWrite){assert.equal(response.status,409);assert.equal(atResponse.receipt,'none');assert.equal(settled.receipt,'completed');}
 if(scenario.name==='real-archive-stops-at-deadline'){assert.equal(response.status,409);assert.equal(settled.receipt,'none');assert.equal(counts.write,0);assert.equal(counts.archive,3);assert.ok(trace.filter(row=>row.kind==='archive').every(row=>row.startMs<4000),'No archive starts after deadline');assert.ok(settled.archiveRows>atResponse.archiveRows);}
 for(const value of [f.body.clientId,f.body.clientSecret,f.cookie,f.session.csrf,f.body.requestId,f.body.reviewDigest])assert.equal(JSON.stringify(response.payload.diagnostic??{}).includes(value),false,'Diagnostic leaked synthetic private value');
 const safe={case:scenario.name,clock:scenario.real?'real-timer':'controlled-monotonic',responseMs,http:response.status,stage:response.payload.diagnostic?.stage??'stored',counts,atResponse,settled,reconciled:reconciled.payload.status,trace};
 t.diagnostic(JSON.stringify(safe));
});

for(const kind of ['audit-batch','history-batch','legacy-read','large-brief','optional-write','optional-read','optional-failed-write'])test('archive deadline stops '+kind+' without a primary write',async t=>{
 let elapsed=0,armed=false,expired=false;const base=Date.now(),archives=[],warnings=[],legacy=[];
 t.mock.method(performance,'now',()=>elapsed);t.mock.method(Date,'now',()=>base+elapsed);t.mock.method(console,'warn',(...args)=>warnings.push(args));
 const prepareState=state=>{
  const at=new Date(base-86400000).toISOString();
  if(kind==='audit-batch')state.audit=Array.from({length:501},(_,i)=>({id:'a'+i,type:'s',actor:'s',createdAt:at}));
  if(kind==='history-batch')state.workRecords=Array.from({length:501},(_,i)=>({id:'synthetic-work-'+i,createdAt:at}));
  if(kind==='legacy-read'){
   state.dailyBriefs=Array.from({length:32},(_,i)=>({id:'synthetic-brief-'+i,generatedAt:at,summary:'Synthetic history'}));
   for(const brief of state.dailyBriefs.slice(30)){const original=structuredClone(brief);legacy.push({id:brief.id,workspace_id:state.workspace.id,metrics:original});brief.archive={table:'operations_briefs',id:brief.id,sha256:createHash('sha256').update(JSON.stringify(original)).digest('hex')};}
  }
  if(kind==='large-brief')state.dailyBriefs=Array.from({length:2},(_,i)=>({id:'synthetic-large-'+i,generatedAt:at,summary:'x'.repeat(70000)}));
  if(kind.startsWith('optional')){
   state.dailyBriefs=Array.from({length:3},(_,i)=>({id:'synthetic-optional-'+i,generatedAt:new Date(base-(i?2*86400000:0)).toISOString(),summary:'Synthetic history',logic:'deterministic-v2',rows:[{description:'x'.repeat(2500)}]}));
   assert.equal(planBriefHistoryCompaction(state).candidates.length,2);
  }
 };
 const f=await fixture(t,{prepareState,env:kind.startsWith('optional')?{BRIEF_HISTORY_COMPACTION_CONTRACT:BRIEF_HISTORY_CONTRACT}:{},beforeListen:({fake})=>{if(legacy.length)fake.tables.set('operations_briefs',legacy);},intercept:async({url,options,proceed})=>{
  const table=url.pathname.split('/').at(-1),method=options.method||'GET';
  if(!armed||!['audit_events','runvara_history','operations_briefs'].includes(table))return proceed();
  assert.equal(expired,false,'No further archive IO after deadline');archives.push({table,method});
  const target=kind==='optional-read'?method==='GET':true;
  const result=kind==='optional-failed-write'?Response.json({code:'synthetic-private-error',message:'synthetic-private-error'},{status:503}):await proceed();
  if(target){elapsed=4000;expired=true;}return result;
 }});
 armed=true;const r=await f.submit();assert.equal(r.status,409);assert.equal(r.payload.diagnostic.cause,'deadline');assert.equal(r.payload.diagnostic.durationMs,4000);
 assert.equal(f.calls.filter(x=>x.method==='PATCH').length,0);assert.equal(f.fake.states.get('packsmart-solutions').parcel2goLiveQuoteRuns?.length??0,0);
 assert.equal(archives.length,kind==='optional-read'?2:1);assert.deepEqual(warnings,[],'Deadline is not swallowed/logged as optional compaction failure');
 assert.equal(JSON.stringify(r.payload).includes('synthetic-private-error'),false);
});
test('admitted automation archives stop between immutable batches',async t=>{
 let elapsed=0,posts=0;const at=new Date(Date.now()-60000).toISOString();t.mock.method(performance,'now',()=>elapsed);
 const f=await fixture(t,{prepareState:state=>{state.automationRuns=Array.from({length:250},(_,i)=>({id:'synthetic-run-'+i,ruleId:'profitGuard',status:'COMPLETED',startedAt:at,completedAt:at,leaseUntil:at,risk:'low',spend:0,errorCode:null,evidence:[{type:'recorded',id:'synthetic-evidence-'+i,detail:'x'.repeat(1000)}]}));},intercept:async({url,options,proceed})=>{
  if(!url.pathname.endsWith('/runvara_history'))return proceed();assert.equal(options.method,'POST');assert.equal(elapsed,0);posts++;const result=await proceed();elapsed=4000;return result;
 }});
 assert.ok(planAutomationRetention(f.state).archiveBatches.length>1);
 const r=await f.submit();assert.equal(r.status,409);assert.equal(r.payload.diagnostic.cause,'deadline');
 assert.equal(posts,1);assert.equal(f.calls.filter(x=>x.method==='PATCH').length,0);
});
function largeSyntheticState(state,kind){
 if(kind==='catalogue')state.products=Array.from({length:80},(_,i)=>({id:'synthetic-product-'+i,name:'Synthetic product',sku:'SYN-'+i,variants:Array.from({length:10},(_,j)=>({id:'synthetic-variant-'+i+'-'+j,sku:'SYN-'+i+'-'+j,title:'Synthetic variant',price:1,stock:1,inventoryTracked:true,currency:'GBP',options:[{name:'Synthetic size',value:String(j)}]}))}));
 if(kind==='history')state.workRecords=Array.from({length:200},(_,i)=>({id:'synthetic-work-'+i,status:'COMPLETED',createdAt:'2026-01-01T00:00:00.000Z',summary:'Synthetic history '.repeat(30)}));
 if(kind==='brief')state.dailyBriefs=[{id:'synthetic-large',generatedAt:new Date().toISOString(),summary:'Synthetic history '.repeat(4200)}];
 if(kind==='nodes')state.syntheticCounts=Array(6000).fill(0);
}
for(const kind of ['catalogue','history','brief','nodes'])test('bounded workspace admission succeeds beyond operation canonical limit: '+kind,async t=>{
 const f=await fixture(t,{prepareState:state=>largeSyntheticState(state,kind)}),before=f.calls.length,bytes=Buffer.byteLength(JSON.stringify(f.state));
 assert.throws(()=>hash(f.state),'Operation fingerprint remains intentionally small');
 const r=await f.submit();assert.equal(r.status,200);assert.equal(r.payload.status,'stored');assert.equal((await f.status()).payload.status,'stored');
 const saved=f.fake.states.get('packsmart-solutions');assert.equal(saved.parcel2goLiveQuoteRuns[0].status,'completed');assert.equal(JSON.stringify(saved).includes('synthetic-client-secret'),false);
 if(kind==='catalogue')assert.deepEqual(saved.products,f.state.products);if(kind==='nodes')assert.deepEqual(saved.syntheticCounts,f.state.syntheticCounts);
 const writes=f.calls.slice(before).filter(x=>x.method==='PATCH').length;assert.equal(writes,1);assert.equal((await f.submit()).status,409);assert.equal(f.calls.slice(before).filter(x=>x.method==='PATCH').length,writes);
 t.diagnostic(JSON.stringify({case:'workspace-'+kind,inputBytes:bytes,stateWrites:writes,archiveWrites:f.calls.slice(before).filter(x=>x.method==='POST').length}));
});
for(const kind of ['record','revision-getter','foreign-workspace'])test('large workspace permit rejects '+kind+' and remains spent',async t=>{
 let captured,getters=0;const f=await fixture(t,{prepareState:state=>largeSyntheticState(state,'catalogue'),beforeListen:({store})=>{
  const save=store.save.bind(store);store.save=async(w,s,o)=>{
   captured={permit:o.parcel2goLivePermit,snapshot:structuredClone(s)};
   if(kind==='record')s.products[0].name='Changed after permit';
   if(kind==='revision-getter')Object.defineProperty(s,'_revision',{enumerable:true,get(){getters++;return captured.snapshot._revision;}});
   if(kind==='foreign-workspace')assertParcel2GoLivePersistencePermit(o.parcel2goLivePermit,'synthetic-foreign',s);
   return save(w,s,o);
  };
 }});
 const r=await f.submit();assert.equal(r.status,409);assert.equal(getters,0);assert.ok(captured);
 assert.equal(f.calls.filter(x=>x.method!=='GET').length,0);
 assert.throws(()=>assertParcel2GoLivePersistencePermit(captured.permit,'packsmart-solutions',captured.snapshot));
});
test('large workspace key reordering preserves permit identity',async t=>{
 const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).reverse().map(([k,v])=>[k,reorder(v)])):value;
 const f=await fixture(t,{prepareState:state=>largeSyntheticState(state,'catalogue'),beforeListen:({store})=>{const save=store.save.bind(store);store.save=(w,s,o)=>save(w,reorder(s),o);}});
 assert.equal((await f.submit()).status,200);assert.equal((await f.status()).payload.status,'stored');assert.equal(f.calls.filter(x=>x.method==='PATCH').length,1);
});
test('larger fingerprint does not bypass final store capacity before effects',async t=>{
 const f=await fixture(t,{prepareState:state=>{state.syntheticPadding='x'.repeat(2097152-Buffer.byteLength(JSON.stringify(state))-128);}});
 assert.ok(Buffer.byteLength(JSON.stringify(f.state))<2097152);const r=await f.submit();assert.equal(r.status,409);
 assert.equal(f.calls.filter(x=>x.method!=='GET').length,0);assert.equal(f.fake.states.get('packsmart-solutions').parcel2goLiveQuoteRuns?.length??0,0);
});
test('large workspace lost completion acknowledgement reconciles without repeat admission',async t=>{
 let saves=0;const f=await fixture(t,{prepareState:state=>largeSyntheticState(state,'catalogue'),beforeListen:({store})=>{const save=store.save.bind(store);store.save=async(...args)=>{const result=await save(...args);if(++saves===1)throw Error('synthetic lost acknowledgement');return result;};}});
 assert.equal((await f.submit()).status,409);assert.equal((await f.status()).payload.status,'stored');assert.equal((await f.submit()).status,409);assert.equal(saves,1);assert.equal(f.calls.filter(x=>x.method==='PATCH').length,1);
});
test('large workspace saves inside reviewed budget with 250ms per transport operation',{timeout:8000},async t=>{
 let armed=false;const f=await fixture(t,{prepareState:state=>largeSyntheticState(state,'catalogue'),intercept:async({proceed})=>{if(armed)await new Promise(r=>setTimeout(r,250));return proceed();}});
 const before=f.calls.length,start=performance.now();armed=true;const r=await f.submit(),elapsedMs=Math.round(performance.now()-start);armed=false;
 assert.equal(r.status,200);assert.equal((await f.status()).payload.status,'stored');assert.equal(f.calls.slice(before).filter(x=>x.method==='PATCH').length,1);
 t.diagnostic(JSON.stringify({case:'large-workspace-250ms',elapsedMs,inputBytes:Buffer.byteLength(JSON.stringify(f.state))}));
});
test('final bookkeeping cannot commit an atomic save beyond the exact reader node limit',async t=>{
 const nodes=value=>1+(value&&typeof value==='object'?Object.values(value).reduce((n,x)=>n+nodes(x),0):0);
 let candidateNodes;const f=await fixture(t,{prepareState:state=>{state.syntheticCounts=Array(49666).fill(0);},beforeListen:({store})=>{const save=store.save.bind(store);store.save=(w,s,o)=>{candidateNodes=nodes(s);return save(w,s,o);};}});
 assert.ok(nodes(f.state)<PARCEL2GO_WORKSPACE_LIMITS.nodes);const r=await f.submit();assert.equal(r.status,409);assert.equal(candidateNodes,PARCEL2GO_WORKSPACE_LIMITS.nodes);
 assert.equal(f.calls.filter(x=>x.method!=='GET').length,0);
 const saved=await f.store.get('packsmart-solutions',{exactSnapshot:true});assert.equal(saved.parcel2goLiveQuoteRuns?.length??0,0);assert.equal((await f.status()).status,200);
});

// Every newly admitted credential state is either absent or fully completed.
// Faults may still make the HTTP result uncertain; status never repeats a write.
const atomicScenarios=['commit-invalid-ack','commit-deadline','readback-failure','readback-deadline','status-read-failure','revision-changed','owner-revoked','commit-rejected','commit-conflict','commit-network-ack-reconciled','precommit-read-failure'];
for(const scenario of atomicScenarios)test('atomic credential reconciliation matrix: '+scenario,async t=>{
 let elapsed=0,armed=false,reads=0,patches=0;const snapshots=[];t.mock.method(performance,'now',()=>elapsed);
 const f=await fixture(t,{intercept:async({url,options,fake,proceed})=>{
  if(!armed)return proceed();const method=options.method||'GET';assert.equal(url.pathname.split('/').at(-1),'saas_workspace_state');
  if(method==='GET'){
   reads++;
   if((scenario==='precommit-read-failure'&&reads===3)||(scenario==='readback-failure'&&reads===4)||(scenario==='status-read-failure'&&reads===5))return Response.json({code:'XX000',message:'synthetic-private-error'},{status:503});
   const result=await proceed();if(scenario==='readback-deadline'&&reads===4)elapsed=4000;return result;
  }
  assert.equal(method,'PATCH');patches++;
  const candidate=JSON.parse(options.body).state;
  assert.equal(candidate.parcel2goLiveQuoteRuns[0].status,'completed');assert.equal(candidate.connections.filter(c=>c.provider==='parcel2go-live').length,1);
  assert.equal(candidate.audit.filter(a=>['parcel2go_live_reserved','parcel2go_live_completed'].includes(a.type)).length,2);
  if(scenario==='commit-rejected')return Response.json({code:'XX000',message:'synthetic-private-error'},{status:503});
  if(scenario==='commit-conflict')fake.states.get('packsmart-solutions')._revision=randomUUID();
  const result=await proceed();snapshots.push(structuredClone(fake.states.get('packsmart-solutions')));
  if(scenario==='commit-invalid-ack')return Response.json([{unexpected:true}]);
  if(scenario==='commit-deadline')elapsed=4000;
  if(scenario==='revision-changed')fake.states.get('packsmart-solutions')._revision=randomUUID();
  if(scenario==='owner-revoked'){fake.states.get('packsmart-solutions').users[0].role='member';fake.states.get('packsmart-solutions')._revision=randomUUID();}
  if(scenario==='commit-network-ack-reconciled')throw Error('synthetic-private-lost-ack');
  return result;
 }});
 armed=true;const response=await f.submit();armed=false;
 const stored=f.fake.states.get('packsmart-solutions'),completed=!['precommit-read-failure','commit-rejected','commit-conflict'].includes(scenario);
 assert.equal(response.status,scenario==='commit-network-ack-reconciled'?200:409);
 assert.equal(stored.parcel2goLiveQuoteRuns?.[0]?.status,completed?'completed':undefined);
 assert.equal(stored.connections.filter(c=>c.provider==='parcel2go-live').length,Number(completed));
 for(const type of ['parcel2go_live_reserved','parcel2go_live_completed'])assert.equal(stored.audit.filter(a=>a.type===type).length,Number(completed));
 for(const state of snapshots){assert.equal(state.parcel2goLiveQuoteRuns?.some(r=>r.status==='reserved')??false,false);assert.equal(JSON.stringify(state).includes(f.body.clientSecret),false);}
 const writes=f.calls.filter(c=>c.method!=='GET').length,status=await f.status();
 if(scenario==='owner-revoked')assert.equal(status.status,409);
 else {assert.equal(status.payload.status,completed?'stored':'unavailable');assert.equal(status.payload.canSubmit,false);assert.equal(status.payload.retryAllowed,false);}
 assert.equal(f.calls.filter(c=>c.method!=='GET').length,writes,'Status is read-only');
 assert.equal((await f.submit()).status,409);assert.equal(f.calls.filter(c=>c.method!=='GET').length,writes,'Spent window cannot admit again even if no write committed');
 for(const value of [f.body.clientSecret,f.body.clientId,f.cookie,f.session.csrf,'synthetic-private-error','synthetic-private-lost-ack'])assert.equal(JSON.stringify(response.payload.diagnostic??{}).includes(value),false);
 assert.equal(patches,scenario==='precommit-read-failure'?0:1);
 t.diagnostic(JSON.stringify({scenario,http:response.status,stage:response.payload.diagnostic?.stage??'stored',cause:response.payload.diagnostic?.cause??null,reads,patches,durableReceipt:completed?'completed':'none',liveConnections:Number(completed)}));
});

// Seed a synthetic legacy receipt directly. The atomic route cannot create one.
async function syntheticReservedRestart(t,{disabled=false,renew=false}={}){
 const base=Date.now(),f=await fixture(t),state=structuredClone(f.state),c=f.config,b=c.trustedBinding;await f.close();
 state._revision=randomUUID();
 state.parcel2goLiveQuoteRuns=[{requestId:c.requestId,operation:'admit_credentials',connectionId:b.connectionId,accountId:b.accountId,environment:'live',status:'reserved',termsReference:c.termsReference,entryReview:{reviewDigest:f.body.reviewDigest,principalEmail:c.principalEmail,accountEvidenceReference:c.accountEvidenceReference,scope:'private_storage_only'},expiresAt:c.expiresAt,fingerprint:hash(['live-credential-admission/v1',b,c.expectedSessionFingerprint])}];
 state.audit.unshift({id:'audit_'+randomUUID(),type:'parcel2go_live_reserved',actor:'owner',detail:{requestId:c.requestId,operation:'admit_credentials'},createdAt:new Date(base).toISOString()});
 const config={...c};
 if(renew){t.mock.method(Date,'now',()=>base+600000);config.requestId=randomUUID();config.expectedRevision=state._revision;config.expiresAt=new Date(Date.now()+300000).toISOString();assert.ok(Date.parse(state.parcel2goLiveQuoteRuns[0].expiresAt)<Date.now());}
 const next=await maintenanceFixture({states:[state],env:{RUNVARA_QUIET_OWNER_WORKSPACE:'enabled/v1',RUNVARA_QUIET_PARCEL2GO_LIVE_CREDENTIAL_ENTRY:disabled?'disabled/v1':'enabled/v1',RUNVARA_PARCEL2GO_LIVE_ENTRY_CONFIG:JSON.stringify(config)}});t.after(next.close);
 return {f,next,state,config};
}
test('reserved state survives restart; status cannot reconstruct or resume the secret',async t=>{
 const {f,next,state}=await syntheticReservedRestart(t),before=JSON.stringify(next.fake.states.get('packsmart-solutions'));
 const status=await next.request(LIVE_ENTRY_PATH,{cookie:f.cookie});assert.equal(status.status,200);assert.equal(status.payload.status,'unconfirmed');assert.equal(status.payload.canSubmit,false);assert.equal(status.payload.retryAllowed,false);
 const r=await next.request(LIVE_ENTRY_PATH,{method:'POST',cookie:f.cookie,headers:{Origin:next.config.APP_PUBLIC_URL,'X-CSRF-Token':f.session.csrf},body:f.body});assert.equal(r.status,409);
 assert.equal(next.calls.filter(c=>c.method!=='GET').length,0);assert.equal(JSON.stringify(next.fake.states.get('packsmart-solutions')),before);
 assert.equal(state.connections.some(c=>c.provider==='parcel2go-live'),false);
});
test('disabled restart leaves the reservation intact and does not expose entry status',async t=>{
 const {f,next,state}=await syntheticReservedRestart(t,{disabled:true});
 const r=await next.request(LIVE_ENTRY_PATH,{cookie:f.cookie});assert.equal(r.status,503);assert.equal(r.payload.code,'PARCEL2GO_LIVE_ENTRY_DISABLED');assert.equal(next.calls.length,0);
 assert.equal(next.fake.states.get('packsmart-solutions').parcel2goLiveQuoteRuns[0].status,'reserved');assert.equal(state.connections.some(c=>c.provider==='parcel2go-live'),false);
});
test('expired reservation still fences a new request after restart and fresh revision binding',async t=>{
 const {f,next,config}=await syntheticReservedRestart(t,{renew:true});
 const status=await next.request(LIVE_ENTRY_PATH,{cookie:f.cookie});assert.equal(status.payload.status,'unavailable');assert.equal(status.payload.canSubmit,false);assert.equal(status.payload.retryAllowed,false);
 const body={...f.body,requestId:config.requestId,expectedRevision:config.expectedRevision,reviewDigest:status.payload.reviewDigest};
 assert.equal((await next.request(LIVE_ENTRY_PATH,{method:'POST',cookie:f.cookie,headers:{Origin:next.config.APP_PUBLIC_URL,'X-CSRF-Token':f.session.csrf},body})).status,409);
 assert.equal(next.calls.filter(c=>c.method!=='GET').length,0);assert.equal(next.fake.states.get('packsmart-solutions').parcel2goLiveQuoteRuns.length,1);
});
test('fresh setup refuses an expired reserved admission before preparing another entry',async t=>{
 const {f,state,config}=await syntheticReservedRestart(t,{renew:true});
 const {expectedRevision,expectedSessionFingerprint,...setupConfig}=config;
 const next=await maintenanceFixture({states:[state],env:{RUNVARA_QUIET_OWNER_WORKSPACE:'enabled/v1',RUNVARA_QUIET_PARCEL2GO_LIVE_SETUP:'enabled/v1',RUNVARA_PARCEL2GO_LIVE_SETUP_CONFIG:JSON.stringify(setupConfig)}});t.after(next.close);
 const r=await next.request('/api/owner/parcel2go-live-setup',{method:'POST',cookie:f.cookie,headers:{Origin:next.config.APP_PUBLIC_URL,'X-CSRF-Token':f.session.csrf}});
 assert.equal(r.status,409);assert.equal(r.payload.savePerformed,false);assert.equal(r.payload.diagnostic.stage,'account_revision');assert.equal(r.payload.diagnostic.cause,'refused');
 assert.equal(next.calls.filter(c=>c.method!=='GET').length,0);assert.equal((await next.request(LIVE_ENTRY_PATH,{cookie:f.cookie})).status,503);
});
test('completed save with lost acknowledgement reconciles after restart without another write',async t=>{
 let saves=0;const f=await fixture(t,{beforeListen:({store})=>{const save=store.save.bind(store);store.save=async(...args)=>{const result=await save(...args);if(++saves===1)throw Error('synthetic-private-lost-ack');return result;};}});
 assert.equal((await f.submit()).status,409);const state=structuredClone(f.fake.states.get('packsmart-solutions'));await f.close();
 const next=await maintenanceFixture({states:[state],env:{RUNVARA_QUIET_OWNER_WORKSPACE:'enabled/v1',RUNVARA_QUIET_PARCEL2GO_LIVE_CREDENTIAL_ENTRY:'enabled/v1',RUNVARA_PARCEL2GO_LIVE_ENTRY_CONFIG:JSON.stringify(f.config)}});t.after(next.close);
 const r=await next.request(LIVE_ENTRY_PATH,{cookie:f.cookie});assert.equal(r.status,200);assert.equal(r.payload.status,'stored');assert.equal(r.payload.canSubmit,false);assert.equal(r.payload.retryAllowed,false);
 assert.equal((await next.request(LIVE_ENTRY_PATH,{method:'POST',cookie:f.cookie,headers:{Origin:next.config.APP_PUBLIC_URL,'X-CSRF-Token':f.session.csrf},body:f.body})).status,409);
 assert.equal(next.calls.filter(c=>c.method!=='GET').length,0);assert.equal(state.parcel2goLiveQuoteRuns.length,1);assert.equal(state.connections.filter(c=>c.provider==='parcel2go-live').length,1);
});
for(const differentRequest of [false,true])test('independent owner controllers race one atomic CAS: '+(differentRequest?'distinct requests':'same request'),{timeout:6000},async t=>{
 let attempts=0,commits=0,release;const gate=new Promise(r=>release=r);t.after(()=>release());
 const f=await fixture(t,{intercept:async({options,proceed})=>{
  if(options.method!=='PATCH')return proceed();
  if(++attempts===2)release();await gate;const response=await proceed();if((await response.clone().json()).length===1)commits++;return response;
 }});
 const config={...f.config,...(differentRequest?{requestId:randomUUID()}:{})};
 const controller=createLiveCredentialEntryController({env:{RUNVARA_STARTUP_MODE:'quiet',RUNVARA_QUIET_OWNER_WORKSPACE:'enabled/v1',RUNVARA_QUIET_PARCEL2GO_LIVE_CREDENTIAL_ENTRY:'enabled/v1',RUNVARA_PARCEL2GO_LIVE_ENTRY_CONFIG:JSON.stringify(config),SESSION_SECRET:SECRET,CREDENTIALS_KEY:SECRET,APP_PUBLIC_URL:'https://maintenance.example.test'},store:f.store,withWorkspaceLock:createWorkspaceLock()});t.after(()=>controller.close());
 const request=(method,body)=>Object.assign(new EventEmitter(),{url:LIVE_ENTRY_PATH,method,headers:{cookie:f.cookie,origin:'https://maintenance.example.test','x-csrf-token':f.session.csrf,'content-type':'application/json'},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(body));}});
 const descriptor=(await controller.handle(request('GET'),new EventEmitter())).body;
 const body={...f.body,requestId:config.requestId,reviewDigest:descriptor.reviewDigest};
 const results=await Promise.all([f.submit(),controller.handle(request('POST',body),new EventEmitter())]);
 assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===409).length,1);assert.equal(attempts,2);assert.equal(commits,1);
 const state=f.fake.states.get('packsmart-solutions');assert.equal(state.parcel2goLiveQuoteRuns.length,1);assert.equal(state.parcel2goLiveQuoteRuns[0].status,'completed');assert.equal(state.connections.filter(c=>c.provider==='parcel2go-live').length,1);
 for(const type of ['parcel2go_live_reserved','parcel2go_live_completed'])assert.equal(state.audit.filter(a=>a.type===type).length,1);
 assert.equal((await f.submit()).status,409);assert.equal((await controller.handle(request('POST',body),new EventEmitter())).status,409);assert.equal(attempts,2);
});
