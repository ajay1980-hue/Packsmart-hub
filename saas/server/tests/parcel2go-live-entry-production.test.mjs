import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {maintenanceFixture,ownerState,SECRET} from './maintenance-login-fixture.mjs';import {createSessionToken,verifySessionToken} from '../lib/security.mjs';import {parcel2GoCanonicalHash as hash} from '../lib/parcel2go-live-canonical.mjs';import {LIVE_ENTRY_PATH} from '../lib/parcel2go-live-entry-window.mjs';
async function fixture(t,extra={}){const {entryConfig={},prepareState=()=>{},...serverExtra}=extra;const state=ownerState('packsmart-solutions');prepareState(state);const token=createSessionToken({userId:state.users[0].id,workspaceId:state.workspace.id,email:'synthetic@example.test',role:'owner',csrf:'synthetic-csrf-at-least-16'},SECRET),session=verifySessionToken(token,SECRET);const config={requestId:randomUUID(),expectedRevision:state._revision,trustedBinding:{workspaceId:state.workspace.id,connectionId:'synthetic-live-entry',accountId:'synthetic-own-alias',environment:'live'},expectedClientId:'synthetic-client-id',termsReference:'synthetic-terms-owner-review',expiresAt:new Date(Date.now()+300000).toISOString(),expectedSessionFingerprint:hash(session),principalEmail:'synthetic@example.test',accountEvidenceReference:'synthetic-observed-account',scope:'private_storage_only',...entryConfig};const f=await maintenanceFixture({states:[state],env:{RUNVARA_QUIET_OWNER_WORKSPACE:'enabled/v1',RUNVARA_QUIET_PARCEL2GO_LIVE_CREDENTIAL_ENTRY:'enabled/v1',RUNVARA_PARCEL2GO_LIVE_ENTRY_CONFIG:JSON.stringify(config)},...serverExtra});t.after(f.close);const cookie='__Host-packsmart_session='+token;const status=()=>f.request(LIVE_ENTRY_PATH,{cookie});const descriptor=(await status()).payload;const body={clientId:config.expectedClientId,clientSecret:'synthetic-client-secret',requestId:config.requestId,expectedRevision:state._revision,reviewDigest:descriptor.reviewDigest,confirmed:true};const submit=(overrides={})=>f.request(LIVE_ENTRY_PATH,{method:'POST',cookie,headers:{Origin:f.config.APP_PUBLIC_URL,'X-CSRF-Token':session.csrf},body,...overrides});return {...f,state,session,config,cookie,body,status,submit};}
test('real server production storage path with synthetic inputs stores once, no provider',async t=>{const f=await fixture(t);assert.equal((await f.status()).payload.status,'ready');const r=await f.submit();assert.equal(r.status,200);assert.equal(r.payload.status,'stored');const stored=f.fake.states.get('packsmart-solutions');assert.equal(stored.connections.at(-1).provider,'parcel2go-live');assert.ok(!JSON.stringify(stored).includes('synthetic-client-secret'));assert.equal((await f.status()).payload.status,'stored');const before=f.calls.filter(x=>x.method==='PATCH').length;assert.equal((await f.submit()).status,409);assert.equal(f.calls.filter(x=>x.method==='PATCH').length,before)});
test('body cannot swap reviewed account scope',async t=>{const f=await fixture(t);f.body.reviewDigest='0'.repeat(64);assert.equal((await f.submit()).status,409);assert.equal(f.calls.filter(x=>x.method==='PATCH').length,0)});
for(const error of ['csrf','origin','bearer'])test('production route rejects '+error,async t=>{const f=await fixture(t);let options={};if(error==='bearer')options={cookie:undefined,headers:{Authorization:'Bearer '+f.cookie.split('=')[1],Origin:f.config.APP_PUBLIC_URL,'X-CSRF-Token':f.session.csrf}};else options={headers:{Origin:error==='origin'?'https://evil.example':f.config.APP_PUBLIC_URL,'X-CSRF-Token':error==='csrf'?'bad':f.session.csrf}};assert.equal((await f.submit(options)).status,409);assert.equal(f.calls.filter(x=>x.method==='PATCH').length,0)});
test('concurrent real HTTP submissions result in one stored save',async t=>{const f=await fixture(t);const results=await Promise.all([f.submit(),f.submit()]);assert.equal(results.filter(x=>x.status===200).length,1);assert.equal(f.calls.filter(x=>x.method==='PATCH').length,2)});
test('shutdown drains and closes admission',async t=>{const f=await fixture(t);await f.server.packsmart.drain();assert.notEqual((await f.submit()).status,200);assert.equal(f.calls.filter(x=>x.method==='PATCH').length,0)});
test('lost final DB acknowledgement reconciles on read without retry',async t=>{let patches=0;const f=await fixture(t,{beforeListen:({store})=>{const save=store.save.bind(store);store.save=async(...a)=>{const r=await save(...a);if(++patches===2)throw Error('synthetic-lost-ack');return r}}});assert.equal((await f.submit()).status,409);const before=patches;assert.equal((await f.status()).payload.status,'stored');assert.equal((await f.submit()).status,409);assert.equal(patches,before)});
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
 ...[100,200,222,223,250,400,667].map(ms=>({name:'minimal-each-'+ms,read:ms,write:ms,archive:ms})),
 {name:'minimal-read-300',read:300,write:0,archive:0},
 {name:'minimal-write-1000',read:0,write:1000,archive:0},
 ...[0,100,150,200,300].map(ms=>({name:'archive-each-'+ms,read:ms,write:ms,archive:ms,archives:true})),
 {name:'archive-only-400',read:0,write:0,archive:400,archives:true},
 {name:'real-minimal-each-150',read:150,write:150,archive:150,real:true},
 {name:'real-minimal-each-250',read:250,write:250,archive:250,real:true},
 {name:'real-minimal-read-700',read:700,write:0,archive:0,real:true},
 {name:'real-archive-slow',read:100,write:100,archive:400,archives:true,real:true},
 {name:'real-archive-after-deadline',read:100,write:100,archive:600,archives:true,real:true},
 {name:'real-reservation-late',read:0,write:2100,archive:0,delayWrite:1,real:true},
 {name:'real-completion-late',read:0,write:2100,archive:0,delayWrite:2,real:true}
];
// Exact controlled-clock expectations: [HTTP, stage, receipt, reads, writes,
// archive writes, elapsed IO ms]. CPU/serialization time is deliberately absent.
const latencyExpected={
 'minimal-zero':[200,'stored','completed',7,2,0,0],
 'minimal-each-100':[200,'stored','completed',7,2,0,900],
 'minimal-each-200':[200,'stored','completed',7,2,0,1800],
 'minimal-each-222':[200,'stored','completed',7,2,0,1998],
 'minimal-each-223':[409,'saved_status','completed',7,2,0,2007],
 'minimal-each-250':[409,'credential_admission','completed',6,2,0,2000],
 'minimal-each-400':[409,'credential_admission','reserved',4,1,0,2000],
 'minimal-each-667':[409,'credential_admission','none',3,0,0,2001],
 'minimal-read-300':[409,'saved_status','completed',7,2,0,2100],
 'minimal-write-1000':[409,'credential_admission','completed',5,2,0,2000],
 'archive-each-0':[200,'stored','completed',7,2,6,0],
 'archive-each-100':[200,'stored','completed',7,2,6,1500],
 'archive-each-150':[409,'credential_admission','completed',6,2,6,2100],
 'archive-each-200':[409,'credential_admission','reserved',4,1,5,2000],
 'archive-each-300':[409,'credential_admission','none',3,0,5,2400],
 'archive-only-400':[409,'credential_admission','none',3,0,5,2000]
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
 else{assert.equal(response.payload.status,'unconfirmed');assert.equal(response.payload.diagnostic.cause,'deadline');assert.ok(response.payload.diagnostic.durationMs<=2000);assert.equal(reconciled.payload.canSubmit,false);}
 assert.equal(settled.connections,settled.receipt==='completed'?1:0);
 assert.equal(counts.write,settled.receipt==='none'?0:settled.receipt==='reserved'?1:2);
 assert.equal(settled.admissionAudits,counts.write);
 if(!scenario.archives)assert.equal(counts.archive,0);
 if(!scenario.real)assert.deepEqual([response.status,response.payload.diagnostic?.stage??'stored',settled.receipt,counts.read,counts.write,counts.archive,responseMs],latencyExpected[scenario.name]);
 if(scenario.delayWrite){assert.equal(response.status,409);assert.equal(atResponse.receipt,scenario.delayWrite===1?'none':'reserved');assert.equal(settled.receipt,scenario.delayWrite===1?'reserved':'completed');}
 if(scenario.name==='real-archive-after-deadline'){assert.equal(response.status,409);assert.equal(settled.receipt,'none');assert.equal(counts.write,0);assert.equal(counts.archive,5);assert.ok(trace.some(row=>row.kind==='archive'&&row.startMs>=2000),'Observe archive calls begun after HTTP deadline');assert.ok(settled.archiveRows>atResponse.archiveRows);}
 for(const value of [f.body.clientId,f.body.clientSecret,f.cookie,f.session.csrf,f.body.requestId,f.body.reviewDigest])assert.equal(JSON.stringify(response.payload.diagnostic??{}).includes(value),false,'Diagnostic leaked synthetic private value');
 const safe={case:scenario.name,clock:scenario.real?'real-timer':'controlled-monotonic',responseMs,http:response.status,stage:response.payload.diagnostic?.stage??'stored',counts,atResponse,settled,reconciled:reconciled.payload.status,trace};
 t.diagnostic(JSON.stringify(safe));
});
