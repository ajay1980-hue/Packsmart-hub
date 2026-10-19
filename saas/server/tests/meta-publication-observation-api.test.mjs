import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { observationFixture } from './meta-publication-observation-fixture.mjs';
import { createPacksmartServer } from '../server.mjs';
import { createSessionToken } from '../lib/security.mjs';
const secret='synthetic-meta-observation-auth-secret-at-least-thirty-two';
async function api(t,{simulation=false,quiet=false}={}){
 const f=await observationFixture(t);let saves=0,network=0;
 await f.change(s=>{for(const role of ['admin','member','viewer'])s.users.push({...s.users[0],id:'observer-'+role,role,email:role+'@example.test'});});
 const store={...f.observationStore,get:f.get,save:async(...args)=>{saves++;return f.store.save(...args);}};
 const server=createPacksmartServer({NODE_ENV:'test',SESSION_SECRET:secret,CREDENTIALS_KEY:secret,...(quiet?{RUNVARA_STARTUP_MODE:'quiet'}:{})},
  {store,schedulerEnabled:false,agentOpsEnabled:false,...(simulation?{metaObservationSimulation:f.simulation()}:{}),fetchImpl:async()=>{network++;throw Error('Network forbidden');}});
 t.after(async()=>{await server.packsmart.drain();if(server.listening)await new Promise(resolve=>server.close(resolve));assert.equal(network,0);assert.equal(saves,0);});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 const route='/api/connection-writes/'+f.writeId+'/meta-observations';
 const token=async(role='owner',version=1)=>{const s=await f.get(),u=s.users.find(row=>row.role===role);return createSessionToken({workspaceId:f.workspaceId,userId:u.id,email:u.email,role,sessionVersion:version},secret);};
 const request=async(path=route,{auth,method='GET',csrf,body}={})=>{const r=await fetch(base+path,{method,headers:{...(auth?{Cookie:'packsmart_session='+auth}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,cache:r.headers.get('cache-control'),body:await r.json()};};
 return {...f,route,request,token};
}
test('observation HTTP history is owner-only, no-store, side-effect free and capture stays closed by default',async t=>{
 const f=await api(t);assert.equal((await f.request()).status,401);
 for(const role of ['admin','member','viewer'])assert.equal((await f.request(f.route,{auth:await f.token(role)})).status,403);
 assert.equal((await f.request(f.route,{auth:await f.token('owner',999)})).status,401);
 const auth=await f.token(),result=await f.request(f.route,{auth});assert.equal(result.status,200);assert.match(result.cache,/no-store/);assert.equal(result.body.captureAvailable,false);
 const csrf=(await f.request('/api/auth/session',{auth})).body.csrf;
 const closed=await f.request(f.route,{auth,csrf,method:'POST',body:{requestId:randomUUID()}});
 assert.equal(closed.status,409);assert.equal(closed.body.code,'META_OBSERVATION_PRODUCTION_CLOSED');assert.equal(f.observations.length,0);
 assert.equal((await f.request(f.route+'?workspaceId=other',{auth})).status,400);
});
test('private simulation capture needs CSRF and exact input; repeats only read the retained request',async t=>{
 const f=await api(t,{simulation:true}),auth=await f.token(),csrf=(await f.request('/api/auth/session',{auth})).body.csrf;
 const body={requestId:randomUUID()};assert.equal((await f.request(f.route,{auth,method:'POST',body})).status,403);
 for(const invalid of [{...body,statusCode:'PUBLISHED'},{...body,containerId:'999'},{...body,capability:{}},{requestId:1}])assert.equal((await f.request(f.route,{auth,csrf,method:'POST',body:invalid})).status,400);
 const before=await f.get();const result=await f.request(f.route,{auth,csrf,method:'POST',body});assert.equal(result.status,200,JSON.stringify(result.body));
 assert.equal(result.body.observations[0].resultId,null);assert.equal(result.body.replayPermitted,false);
 assert.equal((await f.request(f.route,{auth,csrf,method:'POST',body})).status,200);assert.equal(f.observations.length,1);assert.deepEqual(await f.get(),before);
});
test('quiet startup refuses observation routes before receipt reads',async t=>{
 const f=await api(t,{quiet:true});const before=f.calls.length;assert.equal((await f.request(f.route,{auth:await f.token()})).status,503);assert.equal(f.calls.length,before);
});
