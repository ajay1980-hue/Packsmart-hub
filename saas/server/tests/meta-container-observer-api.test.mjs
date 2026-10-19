import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {containerObserverFixture} from './meta-container-observer-fixture.mjs';
import {createPacksmartServer} from '../server.mjs';
import {createSessionToken} from '../lib/security.mjs';
const secret='synthetic-container-observer-session-secret-only';
async function api(t,{enabled=false,quiet=false}={}){
 const f=await containerObserverFixture(t);await f.change(s=>{for(const role of ['admin','member','viewer'])s.users.push({...s.users[0],id:'observer-'+role,role,email:role+'@example.test'});});
 let otherRequests=0;const server=createPacksmartServer({NODE_ENV:'test',SESSION_SECRET:secret,CREDENTIALS_KEY:secret,...(quiet?{RUNVARA_STARTUP_MODE:'quiet'}:{})},
  {store:f.store,schedulerEnabled:false,agentOpsEnabled:false,...(enabled?{metaContainerObserverMock:f.capability}:{}),fetchImpl:async()=>{otherRequests++;throw Error('External network prohibited');}});
 t.after(async()=>{await server.packsmart.drain();if(server.listening)await new Promise(resolve=>server.close(resolve));assert.equal(otherRequests,0);});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port,route='/api/connection-writes/'+f.writeId+'/meta-container-status';
 const token=async(role='owner',version=1)=>{const s=await f.get(),u=s.users.find(row=>row.role===role);return createSessionToken({workspaceId:f.workspaceId,userId:u.id,email:u.email,role,sessionVersion:version},secret);};
 const request=async(url=route,{auth,method='GET',csrf,body}={})=>{const response=await fetch(base+url,{method,headers:{...(auth?{Cookie:'packsmart_session='+auth}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,cache:response.headers.get('cache-control'),body:await response.json()};};
 return {...f,route,token,request};
}
test('live/default route stays closed and production composition refuses the mock capability',async t=>{
 const f=await api(t);assert.equal((await f.request(f.route,{auth:await f.token()})).body.code,'META_CONTAINER_OBSERVER_CLOSED');assert.equal(f.calls.length,0);
 assert.throws(()=>createPacksmartServer({NODE_ENV:'production'},{store:f.store,metaContainerObserverMock:f.capability,schedulerEnabled:false,agentOpsEnabled:false}),{code:'META_CONTAINER_OBSERVER_CLOSED'});
});
test('only a current owner can explicitly select and trigger one bounded mocked read with CSRF',async t=>{
 const f=await api(t,{enabled:true});assert.equal((await f.request()).status,401);
 for(const role of ['admin','member','viewer'])assert.equal((await f.request(f.route,{auth:await f.token(role)})).status,403);
 assert.equal((await f.request(f.route,{auth:await f.token('owner',9)})).status,401);
 const auth=await f.token(),preview=await f.request(f.route,{auth});assert.equal(preview.status,200);assert.match(preview.cache,/no-store/);assert.equal(preview.body.liveEnabled,false);assert.equal(f.calls.length,0);
 const csrf=(await f.request('/api/auth/session',{auth})).body.csrf,body={requestId:randomUUID(),selection:preview.body.selection};
 assert.equal((await f.request(f.route,{auth,method:'POST',body})).status,403);
 for(const extra of [{containerId:'999'},{workspaceId:'other'},{url:'https://other.example'},{capability:{}}])assert.equal((await f.request(f.route,{auth,csrf,method:'POST',body:{...body,...extra}})).status,400);
 const result=await f.request(f.route,{auth,csrf,method:'POST',body});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.providerReadPerformed,false);assert.equal(result.body.resultId,null);
 assert.equal((await f.request(f.route,{auth,csrf,method:'POST',body})).status,200);assert.equal(f.calls.length,1);
 assert.equal((await f.request(f.route+'?account=other',{auth})).status,400);
});
test('quiet startup refuses the observer route before any mocked transport',async t=>{
 const f=await api(t,{enabled:true,quiet:true});assert.equal((await f.request(f.route,{auth:await f.token()})).status,503);assert.equal(f.calls.length,0);
});
