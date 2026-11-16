import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createPacksmartServer} from '../server.mjs';
import {createSessionToken} from '../lib/security.mjs';
import {createWorkspaceLock} from '../lib/workspace-lock.mjs';
import {createParcel2GoOwnerQuoteMount as mount,PARCEL2GO_OWNER_QUOTE_FLAG as FLAG,PARCEL2GO_OWNER_QUOTE_CONFIG as CONFIG} from '../lib/parcel2go-owner-quote-mount.mjs';
import {fixture} from './parcel2go-live-integrated-fixture.mjs';
import {nativeHttpFixture} from './parcel2go-native-http-fixture.mjs';
import {KEY,CLIENT,SECRET_VALUE,TOKEN} from './parcel2go-sandbox-fixture.mjs';
const ORIGIN='https://synthetic-mounted-quote.example.test';
const writes=c=>c.f.calls.filter(x=>x.settings.method==='PATCH');
const saved=c=>c.f.fake.states.get(c.workspaceId);
const receipt=c=>saved(c).parcel2goLiveQuoteRuns.find(r=>r.requestId===c.config.requestId);
const redact=value=>{for(const secret of [KEY,CLIENT,SECRET_VALUE,TOKEN])assert.equal(JSON.stringify(value).includes(secret),false);};
async function setup(t,{enabled=true,expired=false,responseFor=()=>({})}={}){
 let wall=Date.parse('2026-11-16T12:00:00.000Z');t.mock.method(Date,'now',()=>wall);
 let c;const network=nativeHttpFixture(t,operation=>responseFor(operation,c)),f=await fixture(),workspaceId=f.config.trustedBinding.workspaceId;
 const state=await f.store.get(workspaceId,{exactSnapshot:true}),user=state.users[0];
 const token=createSessionToken({workspaceId,userId:user.id,email:user.email,role:'owner',csrf:f.session.csrf},KEY);
 const config={...Object.fromEntries(['requestId','trustedBinding','expectedClientId','termsReference','expiresAt','credentialAdmissionRequestId','expectedCredentialReceiptHash'].map(k=>[k,f.config[k]])),scope:'one_quote_only'};
 if(expired)config.expiresAt=new Date(wall-1).toISOString();
 const env={NODE_ENV:'production',RUNVARA_STARTUP_MODE:'quiet',RUNVARA_QUIET_OWNER_WORKSPACE:'enabled/v1',APP_PUBLIC_URL:ORIGIN,SESSION_SECRET:KEY,CREDENTIALS_KEY:KEY,
  [FLAG]:enabled?'enabled/v1':'disabled/v1',[CONFIG]:JSON.stringify(config)};
 c={f,workspaceId,state,config,env,network,token,advance:ms=>wall+=ms};
 c.make=(environment=env)=>{const server=createPacksmartServer(environment,{store:f.store,fetchImpl:async()=>assert.fail('Provider fetch forbidden')});t.after(()=>server.packsmart.drain());return server;};c.server=c.make();
 c.api='/api/owner/parcel2go-quote-review?requestId='+config.requestId;c.page='/owner/parcel2go-quote?requestId='+config.requestId;c.script='/parcel2go-exact-owner-ui.js';
 c.send=async(body,{path=c.api,server=c.server,headers={},method=body===undefined?'GET':'POST'}={})=>{
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{method,url:path,aborted:false,headers:{host:new URL(ORIGIN).host,cookie:`__Host-packsmart_session=${token}`,origin:ORIGIN,'x-csrf-token':f.session.csrf,'content-type':'application/json',...headers}});
  const res=new EventEmitter();let finish;const done=new Promise(r=>finish=r),allHeaders={};Object.assign(res,{destroyed:false,writableEnded:false,headersSent:false});
  res.setHeader=(name,value)=>{allHeaders[name.toLowerCase()]=value;};res.getHeader=name=>allHeaders[name.toLowerCase()];res.writeHead=(status,values={})=>{res.statusCode=status;res.headersSent=true;for(const [name,value] of Object.entries(values))res.setHeader(name,value);};
  res.end=bytes=>{res.writableEnded=true;finish(bytes??'');};res.destroy=()=>{res.destroyed=true;res.emit('close');finish('');};
  server.emit('request',req,res);const bytes=await done;req.destroy();let payload;try{payload=JSON.parse(String(bytes));}catch{payload=String(bytes);}
  return {status:res.statusCode,body:payload,headers:allHeaders};
 };
 c.prepare=()=>({action:'prepare',requestId:config.requestId,declaration:{currency:'GBP',collectionVatStatus:'NotRegistered',deliveryVatStatus:'Individual',collectionPostcode:'SW1A 1AA',deliveryPostcode:'M1 1AE',acknowledgedUnverified:true,
  parcel:{basis:'estimate',scope:'whole_package',includesOuter:true,weightGrams:'5000',lengthMm:'450',widthMm:'300',heightMm:'250',declaredValueDecimal:'15.15'}}});
 c.decision=v=>({action:'decide',requestId:config.requestId,approvalId:v.approvalId,confirmation:{decision:'approved',revision:1,operationHash:v.operationHash}});
 c.execute=v=>({action:'execute',requestId:config.requestId,approvalId:v.approvalId,confirmation:{requestId:config.requestId,approvalId:v.approvalId,operationHash:v.operationHash,confirmed:true}});
 c.approve=async()=>{const first=await c.send(c.prepare());assert.equal(first.status,200);const second=await c.send(c.decision(first.body));assert.equal(second.status,200);return second.body;};
 f.calls.length=0;return c;
}

test('disabled mount never reads private config, credentials or store',()=>{
 assert.equal(mount({env:{get [CONFIG](){assert.fail('Configuration read');},get CREDENTIALS_KEY(){assert.fail('Key read');}}}),null);
});

for(const bad of ['flag','normal_startup','owner_workspace','missing_config','extra','duplicate','tenant','sandbox','request_id','same_request','receipt','scope','client','terms','expiry','overlong','origin','key']){
 test(`activation refuses ${bad} before any storage or provider access`,async t=>{
  const c=await setup(t,{enabled:false}),env={...c.env,[FLAG]:'enabled/v1'},config=structuredClone(c.config);
  if(bad==='flag')env[FLAG]='true';if(bad==='normal_startup')env.RUNVARA_STARTUP_MODE='normal';if(bad==='owner_workspace')env.RUNVARA_QUIET_OWNER_WORKSPACE='disabled/v1';
  if(bad==='extra')config.clientSecret='synthetic-refused';if(bad==='tenant')config.trustedBinding.workspaceId='synthetic-other';if(bad==='sandbox')config.trustedBinding.environment='sandbox';
  if(bad==='request_id')config.requestId='invalid';if(bad==='same_request')config.requestId=config.credentialAdmissionRequestId;if(bad==='receipt')config.expectedCredentialReceiptHash='bad';if(bad==='scope')config.scope='booking';
  if(bad==='client')config.expectedClientId='';if(bad==='terms')config.termsReference='';if(bad==='expiry')config.expiresAt=new Date(Date.now()+300001).toISOString();
  if(bad==='origin')env.APP_PUBLIC_URL='http://synthetic.example.test';if(bad==='key')env.CREDENTIALS_KEY='';env[CONFIG]=JSON.stringify(config);
  if(bad==='missing_config')delete env[CONFIG];if(bad==='duplicate')env[CONFIG]=env[CONFIG].replace('"scope":','"scope":"one_quote_only","scope":');if(bad==='overlong')env[CONFIG]=' '.repeat(8193)+env[CONFIG];
  assert.throws(()=>mount({env,store:c.f.store,withWorkspaceLock:createWorkspaceLock()}),/unavailable/);assert.equal(c.f.calls.length,0);assert.equal(c.network.length,0);
 });
}

test('production routes default disabled, ignore dormant configuration and cannot activate by later env mutation',async t=>{
 const c=await setup(t,{enabled:false});c.env[FLAG]='enabled/v1';c.env[CONFIG]='invalid dormant config';
 for(const path of [c.api,c.page,c.script])for(const method of ['GET','POST','DELETE']){
  const out=await c.send(method==='GET'?undefined:{ignored:true},{path,method});assert.equal(out.status,503);assert.equal(out.body.code,'PARCEL2GO_OWNER_QUOTE_DISABLED');assert.equal(out.headers['cache-control'],'no-store');
 }
 assert.equal(c.f.calls.length,0);assert.equal(c.network.length,0);
});

test('retained expired activation starts successfully but cannot open the quote routes',async t=>{
 const c=await setup(t,{expired:true});assert.equal((await c.send()).status,503);assert.equal(c.f.calls.length,0);assert.equal(c.network.length,0);
});

test('actual server mount completes exact owner flow with intercepted native transport and durable replay protection',async t=>{
 const c=await setup(t);
 for(const path of [c.page,c.script]){const out=await c.send(undefined,{path});assert.equal(out.status,200);assert.equal(out.headers['cache-control'],'no-store');redact(out.body);}
 const dto=await c.approve();assert.equal(c.network.length,0);assert.equal(writes(c).length,2);
 const out=await c.send(c.execute(dto));assert.equal(out.status,200);assert.equal(out.body.status,'completed');assert.equal(out.body.quote.quotes[0].totalDecimal,'12.66');redact(out.body);
 assert.equal(c.network.length,2);assert.equal(writes(c).length,4);assert.equal(receipt(c).status,'completed');
 const fresh=c.make(),read=await c.send(undefined,{server:fresh});assert.equal(read.body.executionStatus,'reconcile_no_replay');assert.equal(read.body.canExecute,false);
 assert.equal((await c.send(c.execute(dto),{server:fresh})).status,409);assert.equal(c.network.length,2);assert.equal(writes(c).length,4);
 for(const key of ['orders','products','connections','users'])assert.deepEqual(saved(c)[key],c.state[key]);
});

for(const bad of ['cookie','tenant','origin','csrf','query','closed_window']){
 test(`mounted route rejects ${bad} without writes or transport`,async t=>{
  const c=await setup(t),headers={};let path=c.api;
  if(bad==='cookie')headers.cookie='invalid';if(bad==='tenant')headers.cookie='__Host-packsmart_session='+createSessionToken({workspaceId:'synthetic-other',userId:'synthetic-owner',role:'owner',email:'synthetic@example.test',csrf:c.f.session.csrf},KEY);
  if(bad==='origin')headers.origin='https://synthetic-other.example.test';if(bad==='csrf')headers['x-csrf-token']='bad';if(bad==='query')path+='&override=1';if(bad==='closed_window')c.advance(300000);
  assert.ok([403,404,409].includes((await c.send(c.prepare(),{headers,path})).status));assert.equal(writes(c).length,0);assert.equal(c.network.length,0);
 });
}

test('shared server lock serializes concurrent preparations into one persisted approval',async t=>{
 const c=await setup(t),results=await Promise.all([c.send(c.prepare()),c.send(c.prepare())]);
 assert.ok(results.every(r=>r.status===200));assert.equal(results[0].body.approvalId,results[1].body.approvalId);assert.equal(writes(c).length,1);assert.equal(c.network.length,0);
});

test('drain closes active and queued preparation and waits for the shared lock',async t=>{
 const c=await setup(t),save=c.f.store.save.bind(c.f.store);let release,entered;
 const gate=new Promise(r=>release=r),seen=new Promise(r=>entered=r);c.f.store.save=async(...args)=>{entered();await gate;return save(...args);};
 const first=c.send(c.prepare());await seen;const second=c.send(c.prepare());let drained=false;const drain=c.server.packsmart.drain().then(()=>{drained=true;});
 await new Promise(r=>setImmediate(r));assert.equal(drained,false);release();await drain;
 assert.ok((await Promise.all([first,second])).every(x=>[404,409,503].includes(x.status)));assert.equal(writes(c).length,0);assert.equal(c.network.length,0);
 assert.equal((await c.send(c.prepare())).status,503);
});

test('drain during token response suppresses the quote and keeps the reservation spent',async t=>{
 let draining;const c=await setup(t,{responseFor:(operation,c)=>{if(operation==='token')draining=c.server.packsmart.drain();return {};}}),dto=await c.approve();
 const out=await c.send(c.execute(dto));await draining;assert.ok([404,409].includes(out.status));assert.equal(c.network.length,1);assert.equal(receipt(c).status,'reserved');
 assert.equal((await c.send(c.execute(dto))).status,503);assert.equal(c.network.length,1);
});

test('server close event closes the quote surface without altering retained state',async t=>{
 const c=await setup(t),before=structuredClone(saved(c));c.server.emit('close');assert.equal((await c.send()).status,404);
 assert.deepEqual(saved(c),before);assert.equal(c.network.length,0);
});
