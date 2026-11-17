import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import {createLiveSetup,LIVE_SETUP_PATH} from '../lib/parcel2go-live-setup.mjs';
import {createWorkspaceLock} from '../lib/workspace-lock.mjs';
import {createSessionToken} from '../lib/security.mjs';
import {ownerState,SECRET} from './maintenance-login-fixture.mjs';
const ORIGIN='https://synthetic-setup.example.test',PRIVATE='synthetic-private-error-do-not-display';
const test=(name,run)=>nodeTest(name,{timeout:5000},run);
const flush=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(t){
 let elapsed=0,reads=0;const base=Date.parse('2026-11-16T12:00:00.000Z');
 t.mock.method(Date,'now',()=>base+elapsed);t.mock.timers.enable({apis:['setTimeout']});
 const network=[];for(const [object,name] of [[globalThis,'fetch'],[https,'request'],[http,'request'],[net.Socket.prototype,'connect']])t.mock.method(object,name,()=>{network.push(name);assert.fail('Network forbidden');});
 const logs=[];for(const name of ['log','warn','error'])t.mock.method(console,name,(...args)=>logs.push(args));
 const state=ownerState('packsmart-solutions');state.privateDiagnosticSentinel=PRIVATE;
 const csrf='synthetic-private-csrf-at-least-16',token=createSessionToken({userId:state.users[0].id,workspaceId:state.workspace.id,email:'synthetic-private@example.test',role:'owner',csrf},SECRET);
 const config={requestId:'11111111-1111-4111-8111-111111111111',trustedBinding:{workspaceId:state.workspace.id,connectionId:'synthetic-private-connection',accountId:'synthetic-private-account',environment:'live'},expectedClientId:'synthetic-private-client',termsReference:'synthetic-private-terms',expiresAt:new Date(base+300000).toISOString(),principalEmail:'synthetic-private@example.test',accountEvidenceReference:'synthetic-private-evidence',scope:'private_storage_only'};
 const env={RUNVARA_STARTUP_MODE:'quiet',RUNVARA_QUIET_OWNER_WORKSPACE:'enabled/v1',RUNVARA_QUIET_PARCEL2GO_LIVE_SETUP:'enabled/v1',RUNVARA_PARCEL2GO_LIVE_SETUP_CONFIG:JSON.stringify(config),SESSION_SECRET:SECRET,CREDENTIALS_KEY:SECRET,APP_PUBLIC_URL:ORIGIN};
 let read=()=>structuredClone(state);const store={provider:'supabase',get:async()=>read(++reads),save:async()=>assert.fail('Setup must not save')};
 const lock=createWorkspaceLock(),setup=createLiveSetup({env,store,withWorkspaceLock:lock,now:()=>base+elapsed,monotonic:()=>elapsed});
 const request=(changes={})=>Object.assign(new EventEmitter(),{url:LIVE_SETUP_PATH,method:'POST',headers:{origin:ORIGIN,cookie:'__Host-packsmart_session='+token,'x-csrf-token':csrf}},changes);
 const run=(changes={})=>{const req=request(changes),res=new EventEmitter();return {req,res,result:setup.handleSetup(req,res)};};
 const c={state,config,lock,setup,run,request,read:f=>read=f,advance:ms=>{elapsed+=ms;t.mock.timers.tick(ms);},get reads(){return reads;},
  unchanged:async()=>assert.equal((await setup.handleEntry(request(),new EventEmitter())).status,503),
  privateValues:[PRIVATE,SECRET,csrf,token,config.requestId,state._revision,config.expectedClientId,config.principalEmail,config.termsReference,config.accountEvidenceReference,config.trustedBinding.accountId,config.trustedBinding.connectionId]};
 c.failure=(out,stage,cause,duration)=>{
  assert.equal(out.status,409);assert.equal(out.headers['Cache-Control'],'no-store');
  assert.deepEqual(Object.keys(out.body).sort(),['diagnostic','providerCallsAllowed','savePerformed','status']);
  assert.equal(out.body.status,'unavailable');assert.equal(out.body.providerCallsAllowed,false);assert.equal(out.body.savePerformed,false);
  assert.deepEqual(out.body.diagnostic,{schema:'parcel2go-setup-diagnostic/v1',stage,cause,durationMs:duration??out.body.diagnostic.durationMs});
  assert.ok(Number.isSafeInteger(out.body.diagnostic.durationMs)&&out.body.diagnostic.durationMs>=0&&out.body.diagnostic.durationMs<=2000);
  for(const value of c.privateValues)assert.equal(JSON.stringify(out).includes(value),false,'Private value escaped in diagnostic');
 };
 t.after(()=>{setup.close();assert.deepEqual(network,[]);for(const value of c.privateValues)assert.equal(JSON.stringify(logs).includes(value),false,'Private value escaped in log');});return c;
}

test('synthetic preparation remains read-only and returns the unchanged success shape',async t=>{
 const c=fixture(t),out=await c.run().result;assert.equal(out.status,200);assert.equal(c.reads,2);
 assert.deepEqual(out.body,{status:'prepared',entryPath:'/parcel2go-live-entry.html',savePerformed:false,providerCallsAllowed:false});
});
for(const kind of ['origin','path','method','body','transfer','cookie','csrf'])test('fixed diagnostic distinguishes '+kind,async t=>{
 const c=fixture(t),req=c.request();
 if(kind==='origin')req.headers.origin='https://synthetic-other.example.test';if(kind==='path')req.url+='?private='+PRIVATE;
 if(kind==='method')req.method='GET';if(kind==='body')req.headers['content-length']='1';if(kind==='transfer')req.headers['transfer-encoding']='chunked';
 if(kind==='cookie')req.headers.cookie=PRIVATE;if(kind==='csrf')req.headers['x-csrf-token']=PRIVATE;
 const out=await c.setup.handleSetup(req,new EventEmitter());
 c.failure(out,kind==='origin'?'origin':kind==='cookie'?'owner_auth':kind==='csrf'?'csrf':'request',kind==='cookie'?'unavailable':'refused');await c.unchanged();
});
for(const nth of [1,2])test('store exceptions expose only the '+(nth===1?'initial':'fresh')+' authentication stage',async t=>{
 const c=fixture(t);c.read(n=>{if(n===nth)throw Object.assign(Error(c.privateValues.join(' ')),{code:PRIVATE,state:c.state});return structuredClone(c.state);});
 c.failure(await c.run().result,nth===1?'owner_auth':'fresh_owner_auth','unavailable');await c.unchanged();
});
test('owner revocation at the fresh read is identifiable without a session payload',async t=>{
 const c=fixture(t);c.read(n=>{const s=structuredClone(c.state);if(n===2)s.users[0].active=false;return s;});
 c.failure(await c.run().result,'fresh_owner_auth','unavailable');await c.unchanged();
});
for(const kind of ['receipt','reservation','connection','revision'])test('account/revision diagnostic covers '+kind,async t=>{
 const c=fixture(t);if(kind==='receipt')c.state.parcel2goLiveQuoteRuns=[{requestId:c.config.requestId,status:'completed'}];
 if(kind==='reservation')c.state.parcel2goLiveQuoteRuns=[{requestId:'synthetic-other',status:'reserved'}];
 if(kind==='connection')c.state.connections=[{id:c.config.trustedBinding.connectionId,provider:'parcel2go-live'}];
 if(kind==='revision')c.state._revision='invalid-private-revision';
 c.failure(await c.run().result,'account_revision',kind==='revision'?'unavailable':'refused');await c.unchanged();
});
for(const nth of [1,2])test('slow '+(nth===1?'initial':'fresh')+' store read hits the unchanged 2s deadline and cannot prepare late',async t=>{
 const c=fixture(t),held=deferred();c.read(n=>n===nth?held.promise:structuredClone(c.state));
 const {result}=c.run();await flush();assert.equal(c.reads,nth);let settled=false;void result.then(()=>settled=true);
 c.advance(1999);await flush();assert.equal(settled,false);c.advance(1);
 c.failure(await result,nth===1?'owner_auth':'fresh_owner_auth','deadline',2000);
 held.resolve(structuredClone(c.state));await flush();await c.unchanged();
});
test('workspace contention times out separately from authentication and queued work cannot prepare late',async t=>{
 const c=fixture(t),held=deferred(),occupied=c.lock(c.state.workspace.id,()=>held.promise);await flush();
 const {result}=c.run();await flush();assert.equal(c.reads,1);c.advance(2000);c.failure(await result,'workspace_lock','deadline',2000);
 held.resolve();await occupied;await flush();assert.equal(c.reads,1);await c.unchanged();
});
test('window expiry remains exact and reports no configured values',async t=>{
 const c=fixture(t);c.advance(300000);c.failure(await c.run().result,'window','unavailable',0);assert.equal(c.reads,0);await c.unchanged();
});
test('aborted setup retains a bounded diagnostic and cannot prepare',async t=>{
 const c=fixture(t),held=deferred();c.read(()=>held.promise);const {req,result}=c.run();await flush();req.emit('aborted');
 held.resolve(structuredClone(c.state));c.failure(await result,'owner_auth','cancelled');await c.unchanged();
});
test('reported duration is capped even when the event loop observes a deadline late',async t=>{
 const c=fixture(t),held=deferred();c.read(()=>held.promise);const {result}=c.run();await flush();c.advance(5000);
 c.failure(await result,'owner_auth','deadline',2000);held.resolve(structuredClone(c.state));await flush();await c.unchanged();
});
