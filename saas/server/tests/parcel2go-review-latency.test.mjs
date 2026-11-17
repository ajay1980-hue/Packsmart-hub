import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture as integratedFixture} from './parcel2go-live-integrated-fixture.mjs';
import {maintenanceFixture,SECRET} from './maintenance-login-fixture.mjs';
import {createSessionToken,verifySessionToken} from '../lib/security.mjs';
import {assertParcel2GoQuoteReviewPersistencePermit,issueParcel2GoQuoteReviewPersistencePermit} from '../lib/parcel2go-exact-approval.mjs';
import https from 'node:https';

const W='packsmart-solutions';
const declaration={currency:'GBP',collectionVatStatus:'Individual',deliveryVatStatus:'Individual',collectionPostcode:'SW1A 1AA',deliveryPostcode:'M1 1AE',acknowledgedUnverified:true,
 parcel:{basis:'estimate',scope:'whole_package',includesOuter:true,weightGrams:'250',lengthMm:'200',widthMm:'100',heightMm:'50',declaredValueDecimal:'12.30'}};
function archiveNeeded(s){
 const at='2026-01-01T00:00:00.000Z';
 s.audit=Array.from({length:300},(_,i)=>({id:'synthetic-audit-'+i,type:'synthetic',actor:'system',detail:{},createdAt:at}));
 for(const [key,length] of [['workRecords',101],['connectionSyncs',101],['agentRuns',2]])s[key]=Array.from({length},(_,i)=>({id:'synthetic-'+key+'-'+i,status:'COMPLETED',createdAt:at}));
 s.dailyBriefs=Array.from({length:31},(_,i)=>({id:'synthetic-brief-'+i,summary:'Synthetic history',generatedAt:at}));
}
async function setup(t,{delay=0,archives=false,real=false,hook,prepareState=()=>{},beforeListen}={}){
 let armed=false,elapsed=0;const base=Date.now(),trace=[];
 if(!real){t.mock.method(performance,'now',()=>elapsed);t.mock.method(Date,'now',()=>base+elapsed);}
 const network=[],fetchLocal=globalThis.fetch;
 t.mock.method(https,'request',()=>{network.push('forbidden');assert.fail('No provider transport permitted');});
 t.mock.method(globalThis,'fetch',(url,options)=>{assert.equal(new URL(url).hostname,'127.0.0.1');return fetchLocal(url,options);});
 const seed=await integratedFixture(),state=await seed.store.get(W,{exactSnapshot:true});if(archives)archiveNeeded(state);prepareState(state);
 const config={...Object.fromEntries(['requestId','trustedBinding','expectedClientId','termsReference','expiresAt','credentialAdmissionRequestId','expectedCredentialReceiptHash'].map(k=>[k,seed.config[k]])),scope:'one_quote_only'};
 const f=await maintenanceFixture({states:[state],beforeListen,env:{RUNVARA_QUIET_OWNER_WORKSPACE:'enabled/v1',RUNVARA_QUIET_PARCEL2GO_OWNER_QUOTE:'enabled/v1',RUNVARA_PARCEL2GO_OWNER_QUOTE_CONFIG:JSON.stringify(config)},intercept:async ctx=>{
  if(!armed)return ctx.proceed();
  const row={method:ctx.options.method||'GET',table:ctx.url.pathname.split('/').at(-1),start:elapsed};trace.push(row);
  if(real){if(delay)await new Promise(r=>setTimeout(r,delay));}else{await new Promise(r=>setImmediate(r));elapsed+=delay;}
  const result=hook?await hook({...ctx,row,trace,advance:ms=>elapsed+=ms}):await ctx.proceed();row.end=elapsed;return result;
 }});t.after(f.close);
 const user=state.users[0],token=createSessionToken({workspaceId:W,userId:user.id,email:user.email,role:'owner',csrf:seed.session.csrf},SECRET),cookie='__Host-packsmart_session='+token;
 const path='/api/owner/parcel2go-quote-review?requestId='+config.requestId;
 const send=body=>f.request(path,{cookie,...(body?{method:'POST',headers:{Origin:f.config.APP_PUBLIC_URL,'X-CSRF-Token':seed.session.csrf},body}:{} )});
 return {...f,state,session:verifySessionToken(token,SECRET),config,network,trace,send,prepare:()=>send({action:'prepare',requestId:config.requestId,declaration}),
  decide:v=>send({action:'decide',requestId:config.requestId,approvalId:v.approvalId,confirmation:{decision:'approved',revision:1,operationHash:v.operationHash}}),
  arm(){armed=true;trace.length=0;},disarm(){armed=false;},advance:ms=>elapsed+=ms,
  saved:()=>f.fake.states.get(W),elapsed:()=>elapsed};
}

test('uneven reads, audit archive and slower commit confirm within the existing deadline',async t=>{
 let committed=false;
 const c=await setup(t,{prepareState:s=>{
  s.syntheticPadding='x'.repeat(1600000);
  s.audit=Array.from({length:300},(_,i)=>({id:'synthetic-audit-'+i,type:'synthetic',actor:'system',detail:{},createdAt:'2026-01-01T00:00:00.000Z'}));
 },hook:async({row,advance,proceed})=>{
  advance(row.method==='GET'?(committed?650:450):row.method==='PATCH'?1400:600);
  const result=await proceed();if(row.method==='PATCH')committed=true;return result;
 }});
 c.arm();const response=await c.prepare();
 const counts={reads:c.trace.filter(x=>x.method==='GET').length,archives:c.trace.filter(x=>x.method==='POST').length,patches:c.trace.filter(x=>x.method==='PATCH').length};
 t.diagnostic(JSON.stringify({http:response.status,elapsedMs:c.elapsed(),counts,review:c.saved().approvals[0]?.status}));
 assert.equal(response.status,200);assert.equal(response.payload.status,'pending');
 assert.deepEqual(counts,{reads:3,archives:1,patches:1});assert.equal(c.elapsed(),3550);
 assert.equal(c.saved().audit.filter(a=>a.type==='approval_requested').length,1);assert.equal(c.network.length,0);
 assert.deepEqual(c.saved().connections,c.state.connections);assert.deepEqual(c.saved().parcel2goLiveQuoteRuns,c.state.parcel2goLiveQuoteRuns);
});

for(const scenario of [{delay:0},{delay:250},{delay:500},{delay:999},{delay:1000,uncertain:true},{delay:300,archives:true},{delay:250,real:true,large:true}])test('bounded review persistence '+JSON.stringify(scenario),{timeout:12000},async t=>{
 const c=await setup(t,{...scenario,prepareState:scenario.large?s=>{s.syntheticPadding='x'.repeat(1500000);}:undefined});c.arm();const start=performance.now(),r=await c.prepare(),elapsedMs=performance.now()-start;c.disarm();
 const row=c.saved().approvals.find(a=>a.requestIdentity?.requestId===c.config.requestId);
 const counts=()=>({reads:c.trace.filter(x=>x.method==='GET').length,patches:c.trace.filter(x=>x.method==='PATCH').length,archives:c.trace.filter(x=>x.method==='POST').length});
 t.diagnostic(JSON.stringify({scenario,clock:scenario.real?'real-timer':'controlled-monotonic',http:r.status,elapsedMs:Math.round(elapsedMs),inputBytes:Buffer.byteLength(JSON.stringify(c.state)),review:row?.status??'none',counts:counts()}));
 assert.equal(r.status,scenario.uncertain?409:200);assert.equal(row.status,'pending');assert.equal(c.network.length,0);
 assert.deepEqual(counts(),{reads:3,patches:1,archives:scenario.archives?5:0});
 assert.ok(c.trace.every(x=>x.table==='saas_workspace_state'||['audit_events','runvara_history','operations_briefs'].includes(x.table)),'No normalized mirrors/reporting RPC');
 assert.equal(c.saved().integrationStatus.reporting.status,'degraded');
 assert.deepEqual(c.saved().connections,c.state.connections);assert.deepEqual(c.saved().parcel2goLiveQuoteRuns,c.state.parcel2goLiveQuoteRuns);
 const before=c.calls.length,read=await c.send();assert.equal(read.status,200);assert.equal(read.payload.status,'pending');assert.equal(read.payload.canExecute,false);
 assert.ok(c.calls.slice(before).every(x=>x.method==='GET'),'Reconciliation is read-only');
 if(!scenario.uncertain){
  c.arm();const decision=await c.decide(read.payload);c.disarm();assert.equal(decision.status,200);assert.equal(decision.payload.status,'approved');
  assert.equal(c.trace.filter(x=>x.method==='PATCH').length,1);assert.ok(c.trace.every(x=>x.table==='saas_workspace_state'||x.table==='audit_events'));
  assert.equal(c.network.length,0);assert.equal(c.saved().audit.filter(a=>a.type==='parcel2go_exact_decided').length,1);
 }
});

for(const scenario of ['initial-auth-deadline','archive-deadline','activation-expiry','owner-revoked','foreign-state','cas-conflict','cancelled-write','lost-ack','late-write','late-readback'])test('review failure remains bounded: '+scenario,async t=>{
 let reads=0,patches=0,archives=0;
 const c=await setup(t,{archives:scenario==='archive-deadline',hook:async({row,proceed,fake,advance})=>{
  if(row.method==='GET'){
   reads++;
   if(scenario==='owner-revoked'&&reads===2)fake.states.get(W).users[0].role='member';
   if(scenario==='foreign-state'&&reads===2)fake.states.get(W).workspace.id='synthetic-other-tenant';
   const result=await proceed();if(scenario==='initial-auth-deadline'&&reads===1)advance(2000);if(scenario==='late-readback'&&patches>0)advance(4000);return result;
  }
  if(row.method==='POST'){archives++;assert.equal(archives,1,'No archive after deadline');const result=await proceed();advance(4000);return result;}
  assert.equal(row.method,'PATCH');patches++;
  if(scenario==='cancelled-write')return Response.json({code:'57014',message:'synthetic-private-error'},{status:500});
  if(scenario==='cas-conflict')fake.states.get(W)._revision='00000000-0000-4000-8000-000000000999';
  const result=await proceed();
  if(scenario==='lost-ack')throw Error('synthetic-private-lost-ack');
  if(scenario==='late-write')advance(4000);
  if(scenario==='activation-expiry')advance(300000);
  return result;
 }});
 c.arm();const response=await c.prepare();c.disarm();
 assert.equal(response.status,scenario==='lost-ack'?200:409);assert.equal(c.network.length,0);assert.ok(patches<=1,'No CAS retry');
 assert.equal(JSON.stringify(response.payload).includes('synthetic-private'),false);
 const committed=['lost-ack','late-write','late-readback','activation-expiry'].includes(scenario);
 assert.equal(c.saved().approvals.length,Number(committed));assert.equal(c.saved().approvals[0]?.status,committed?'pending':undefined);
 assert.deepEqual(c.saved().connections,c.state.connections);assert.deepEqual(c.saved().parcel2goLiveQuoteRuns,c.state.parcel2goLiveQuoteRuns);
 if(scenario==='archive-deadline'){assert.equal(archives,1);assert.equal(patches,0);}
 t.diagnostic(JSON.stringify({scenario,http:response.status,reads,patches,archives,committed}));
});

for(const phase of ['prepare','decide'])for(const fault of ['inactive','missing-active','role','session-version','password-change','foreign-tenant','receipt','connection','approval','duplicate','missing-row','expired']){
 test(`fresh ${phase} confirmation refuses ${fault} after commit without another write`,async t=>{
  let armed=false,committed=false;
  const c=await setup(t,{hook:async({row,proceed,fake,advance})=>{
   if(armed&&committed&&row.method==='GET'){
    const state=fake.states.get(W),user=state.users[0],review=state.approvals[0];
    if(fault==='inactive')user.active=false;if(fault==='missing-active')delete user.active;
    if(fault==='role')user.role='member';if(fault==='session-version')user.sessionVersion++;
    if(fault==='password-change')user.passwordChangeRequired=true;if(fault==='foreign-tenant')state.workspace.id='synthetic-foreign';
    if(fault==='receipt')state.parcel2goLiveQuoteRuns[0].connectionHash='0'.repeat(64);
    if(fault==='connection')state.connections.find(x=>x.provider==='parcel2go-live').metadata.account='synthetic-changed';
    if(fault==='approval')review.payload.quoteInput.parcel.weightGrams='300';
    if(fault==='duplicate')state.approvals.push(structuredClone(review));if(fault==='missing-row')state.approvals=[];
    if(fault==='expired')advance(300000);
   }
   const result=await proceed();if(armed&&row.method==='PATCH')committed=true;return result;
  }});
  const prepared=phase==='decide'?await c.prepare():null;
  if(prepared)assert.equal(prepared.status,200);
  armed=true;c.arm();const response=phase==='prepare'?await c.prepare():await c.decide(prepared.payload);
  assert.equal(response.status,409);assert.equal(committed,true);
  assert.equal(c.trace.filter(x=>x.method==='PATCH').length,1);assert.equal(c.network.length,0);
  assert.deepEqual(Object.keys(response.payload),['error']);
  assert.doesNotMatch(JSON.stringify(response.payload),/synthetic-changed|synthetic-foreign|encryptedCredentials|sessionVersion/);
 });
}

test('already-dispatched primary write can settle after the response deadline without replay',{timeout:8000},async t=>{
 let release,entered;const gate=new Promise(r=>release=r),seen=new Promise(r=>entered=r);
 const c=await setup(t,{real:true,hook:async({row,proceed})=>{if(row.method==='PATCH'){entered();await gate;}return proceed();}});
 c.arm();const request=c.prepare();await seen;const response=await request;
 assert.equal(response.status,409);assert.equal(c.saved().approvals.length,0);release();await c.server.packsmart.drain();
 assert.equal(c.saved().approvals.length,1);assert.equal(c.saved().approvals[0].status,'pending');assert.equal(c.trace.filter(x=>x.method==='PATCH').length,1);assert.equal(c.network.length,0);
});

for(const tamper of ['forged','copied','consumed','tenant','approval','connection','mixed'])test('review permit rejects '+tamper+' before storage effects',async t=>{
 let intercepted=0;
 const c=await setup(t,{beforeListen:({store})=>{
  const save=store.save.bind(store);store.save=async(w,state,options)=>{
   if(!options?.parcel2goReviewPermit)return save(w,state,options);intercepted++;
   const next=structuredClone(state),opts={...options};
   if(tamper==='forged')opts.parcel2goReviewPermit={};
   if(tamper==='copied')opts.parcel2goReviewPermit=structuredClone(opts.parcel2goReviewPermit);
   if(tamper==='consumed')assertParcel2GoQuoteReviewPersistencePermit(opts.parcel2goReviewPermit,w,next);
   if(tamper==='tenant')assert.throws(()=>assertParcel2GoQuoteReviewPersistencePermit(opts.parcel2goReviewPermit,'synthetic-foreign',next));
   if(tamper==='approval')next.approvals[0].payload.operation.bookingAllowed=true;
   if(tamper==='connection')next.connections=[];
   if(tamper==='mixed')opts.parcel2goLivePermit={};
   return save(w,next,opts);
  };
 }});
 c.arm();const response=await c.prepare();assert.equal(response.status,409);assert.equal(intercepted,1);
 assert.ok(c.trace.every(row=>row.method==='GET'));assert.equal(c.saved().approvals.length,0);assert.equal(c.network.length,0);
});

for(const tamper of ['unrelated-state','another-approval','credentials','quote-receipts','financial-impact','audit-extra','audit-duplicate'])test('review permit cannot be issued for '+tamper,async t=>{
 let c,checked=false;
 c=await setup(t,{prepareState:s=>s.approvals.push({id:'synthetic-other',status:'pending',payload:{}}),beforeListen:({store})=>{
  const save=store.save.bind(store);store.save=async(w,state,options)=>{
   if(options?.parcel2goReviewPermit){
    const next=structuredClone(state),row=next.approvals[0];
    if(tamper==='unrelated-state')next.syntheticUnrelated='changed';
    if(tamper==='another-approval')next.approvals[1].status='approved';
    if(tamper==='credentials')next.connections=[];
    if(tamper==='quote-receipts')next.parcel2goLiveQuoteRuns=[];
    if(tamper==='financial-impact')row.financialImpact=1;
    if(tamper==='audit-extra')next.audit[0].extra='synthetic-extra';
    if(tamper==='audit-duplicate')next.audit[0].id=c.state.audit[0].id;
    assert.throws(()=>issueParcel2GoQuoteReviewPersistencePermit({before:c.state,after:next,auth:{state:c.state,session:c.session,user:c.state.users[0]},approvalId:row.id,now:Date.now()}));checked=true;
   }
   return save(w,state,options);
  };
 }});
 const response=await c.prepare();assert.equal(response.status,200);assert.equal(checked,true);assert.equal(c.network.length,0);
});

test('a pending review read and repeated prepare never produce another primary save',async t=>{
 const c=await setup(t);assert.equal((await c.prepare()).status,200);c.arm();
 const read=await c.send(),again=await c.prepare();assert.equal(read.status,200);assert.equal(again.status,200);
 assert.equal(read.payload.approvalId,again.payload.approvalId);assert.equal(again.payload.status,'pending');assert.equal(again.payload.canExecute,false);
 assert.ok(c.trace.every(x=>x.method==='GET'));assert.equal(c.saved().approvals.length,1);assert.equal(c.network.length,0);
});
