import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import http from 'node:http';
import {createPacksmartServer} from '../server.mjs';
import {createStore,seedWorkspaceState} from '../lib/store.mjs';
import {createSessionToken,verifySessionToken} from '../lib/security.mjs';
import {fakeSupabase} from './fake-supabase.mjs';
const SECRET='activity-api-session-secret-more-than-thirty-two-characters',WS='activity-alpha',OTHER='activity-beta';
async function fixture(t){
  const states=[WS,OTHER].map(id=>{
    const s=seedWorkspaceState({}, {workspaceId:id,email:`${id}@example.test`,passwordHash:'private-credential-sentinel'});s._revision='stored-revision';s.users[0].passwordChangeRequired=false;
    for(const role of ['admin','member','viewer'])s.users.push({...s.users[0],id:id+'-'+role,role,email:`${role}-${id}@example.test`});return s;
  });
  const fake=fakeSupabase({initialStates:states});
  const store=createStore({SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'private-service-key-sentinel'}, {fetchImpl:fake.fetchImpl,activityOptions:{instanceId:'api-instance',now:()=>Date.parse('2026-10-07T00:00:00.000Z')}});
  store.integrityCheck=undefined; // Exclude the pre-existing startup integrity task.
  const server=createPacksmartServer({NODE_ENV:'test',SESSION_SECRET:SECRET,SHOPIFY_PUBLIC_SYNC_ENABLED:'false'}, {store,schedulerEnabled:false,agentOpsEnabled:false,fetchImpl:async()=>assert.fail('No provider call')});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await server.packsmart.drain();await new Promise(resolve=>server.close(resolve));});
  const auth=(workspace=WS,role='owner')=>{const user=fake.states.get(workspace).users.find(u=>u.role===role);const token=createSessionToken({workspaceId:workspace,userId:user.id,email:user.email,role,sessionVersion:1},SECRET);return {token,csrf:verifySessionToken(token,SECRET).csrf};};
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(route='/api/activity',{identity=auth(),method='GET',body,headers={}}={})=>{
    if(identity){headers.Cookie=`packsmart_session=${identity.token}`;headers['X-CSRF-Token']=identity.csrf;}
    if(body!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});const text=await response.text();
    return {status:response.status,body:JSON.parse(text),bytes:Buffer.byteLength(text),headers:response.headers};
  };
  return {server,store,fake,auth,request,base};
}

test('owner/admin activity reads use exactly compact authentication and no snapshot/fleet/ledger I/O',async t=>{
  const f=await fixture(t);
  for(const name of ['get','save','listWorkspaceIds','listAgentJobs','providerUsageSummary'])f.store[name]=async()=>assert.fail(`${name} must not be called by activity GET`);
  for(const role of ['owner','admin']){
    const before=f.fake.calls.length,result=await f.request('/api/activity',{identity:f.auth(WS,role)});
    assert.equal(result.status,200);assert.equal(result.body.workspaceId,WS);assert.equal(result.body.schema,'runvara-activity/v1');assert.ok(result.bytes<=32768);
    assert.equal(f.fake.calls.length-before,1);const call=f.fake.calls.at(-1);
    assert.equal(call.method,'GET');assert.equal(call.url.searchParams.get('select'),'state->workspace,state->users');assert.equal(call.url.searchParams.get('workspace_id'),'eq.'+WS);
    assert.equal(result.body.db.attempted,f.fake.calls.length);assert.equal(result.body.db.operations.identity_read,f.fake.calls.length);
    assert.equal(result.headers.get('cache-control'),'no-store');
  }
  assert.ok(f.fake.calls.every(c=>c.method==='GET'));
});

test('activity access is owner/admin only and never expands to another tenant',async t=>{
  const f=await fixture(t);const missing=await f.request('/api/activity',{identity:null});assert.equal(missing.status,401);assert.equal(f.fake.calls.length,0);
  for(const role of ['member','viewer']){const denied=await f.request('/api/activity',{identity:f.auth(WS,role)});assert.equal(denied.status,403);assert.equal(denied.body.code,'ROLE_DENIED');assert.equal(denied.body.db,undefined);}
  for(const query of ['?workspaceId='+OTHER,'?tenantId='+OTHER,'?workspaceId='+WS,'?window=all','?reset=true']){
    const result=await f.request('/api/activity'+query);assert.equal(result.status,400);assert.equal(result.body.code,'ACTIVITY_REQUEST_INVALID');
  }
  const before=f.store.activitySnapshot(OTHER);assert.equal(before.db.attempted,null);
  const spoofed=await f.request('/api/activity',{headers:{'X-Workspace-Id':OTHER}});assert.equal(spoofed.status,200);assert.equal(spoofed.body.workspaceId,WS);assert.ok(!JSON.stringify(spoofed.body).includes(OTHER));
});

test('activity POST/reset and GET bodies cannot mutate or select tenant state',async t=>{
  const f=await fixture(t),before=structuredClone([...f.fake.states]);
  const write=await f.request('/api/activity',{method:'POST',body:{workspaceId:OTHER,reset:true}});assert.equal(write.status,405);assert.equal(write.body.code,'ACTIVITY_READ_ONLY');
  const identity=f.auth(),body=JSON.stringify({workspaceId:OTHER});
  const result=await new Promise((resolve,reject)=>{
    const req=http.request(f.base+'/api/activity',{method:'GET',headers:{Cookie:`packsmart_session=${identity.token}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
      const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));
    });req.on('error',reject);req.end(body);
  });
  assert.equal(result.status,400);assert.equal(result.body.code,'ACTIVITY_REQUEST_INVALID');assert.deepEqual([...f.fake.states],before);assert.ok(f.fake.calls.every(c=>c.method==='GET'));
});

test('tenant DTO and unauthenticated public health exclude other tenants and internal/unattributed counters',async t=>{
  const f=await fixture(t);await f.store.get(OTHER);await f.store.get(OTHER);await f.store.ping();
  f.store.activityMeter.observeJob(OTHER,'dead_letter');
  const result=await f.request();assert.equal(result.status,200);assert.equal(result.body.db.attempted,1);assert.equal(result.body.jobs.dead_letter,0);
  const encoded=JSON.stringify(result.body);
  for(const value of [OTHER,'trackedTenants','tenantCapacityOmissions','inflightTokens','unattributed','private-credential-sentinel','private-service-key-sentinel','synthetic.invalid'])assert.ok(!encoded.includes(value));
  const health=await f.request('/api/health',{identity:null});assert.equal(health.status,200);
  const publicBody=JSON.stringify(health.body);for(const value of [WS,OTHER,'runvara-activity/v1','api-instance','requestBody','responseBody','operations','attempted'])assert.ok(!publicBody.includes(value));
});

test('missing/mismatched/oversized activity DTOs fail without global or full-state fallbacks',async t=>{
  const f=await fixture(t),real=f.store.activitySnapshot.bind(f.store);f.store.get=async()=>assert.fail('No full-state fallback');
  f.store.activitySnapshot=undefined;assert.equal((await f.request()).status,503);
  f.store.activitySnapshot=()=>({...real(WS),workspaceId:OTHER});assert.equal((await f.request()).status,503);
  f.store.activitySnapshot=()=>({...real(WS),coverage:{extra:'x'.repeat(33000)}});const tooLarge=await f.request();assert.equal(tooLarge.status,503);assert.equal(tooLarge.body.code,'ACTIVITY_UNAVAILABLE');
  f.store.activitySnapshot=()=>({...real(WS),unattributed:{private:'other tenants'},allTenants:[OTHER]});const projected=await f.request();assert.equal(projected.status,200);assert.equal(projected.body.unattributed,undefined);assert.equal(projected.body.allTenants,undefined);
});

test('every admitted activity request retains fresh session, password and role checks',async t=>{
  const f=await fixture(t),identity=f.auth();f.fake.states.get(WS).users[0].sessionVersion=2;
  const rotated=await f.request('/api/activity',{identity});assert.equal(rotated.status,401);assert.equal(rotated.body.code,'SESSION_INVALID');
  f.fake.states.get(WS).users[0].sessionVersion=1;f.fake.states.get(WS).users[0].passwordChangeRequired=true;
  assert.equal((await f.request('/api/activity',{identity})).body.code,'PASSWORD_CHANGE_REQUIRED');
  const owner=f.fake.states.get(WS).users[0];owner.passwordChangeRequired=false;owner.role='member';
  const changedRole=await f.request('/api/activity',{identity});assert.equal(changedRole.status,403);assert.equal(changedRole.body.code,'ROLE_DENIED');
  owner.role='owner';owner.active=false;
  const inactive=await f.request('/api/activity',{identity});assert.equal(inactive.status,401);assert.equal(inactive.body.code,'SESSION_INVALID');
  owner.active=true;assert.equal((await f.request('/api/activity',{identity})).status,200);
  assert.equal(f.fake.calls.length,5);
  assert.ok(f.fake.calls.every(c=>c.method==='GET'&&c.url.searchParams.get('select')==='state->workspace,state->users'));
});

test('activity quota is shared across workspace users and stops identity I/O before authentication',async t=>{
  const f=await fixture(t),owner=f.auth(),admin=f.auth(WS,'admin');
  for(let i=0;i<10;i++)assert.equal((await f.request('/api/activity',{identity:i%2?admin:owner})).status,200);
  assert.equal(f.fake.calls.length,10);
  for(let i=0;i<25;i++){
    const limited=await f.request('/api/activity',{identity:i%2?admin:owner});
    assert.equal(limited.status,429);assert.equal(limited.body.code,'ACTIVITY_RATE_LIMITED');
  }
  assert.equal(f.fake.calls.length,10,'quota-exhausted requests do not read identity');
  const other=await f.request('/api/activity',{identity:f.auth(OTHER)});
  assert.equal(other.status,200);assert.equal(other.body.workspaceId,OTHER);assert.equal(f.fake.calls.length,11);
  const existingRoute=await f.request('/api/auth/session',{identity:owner});
  assert.equal(existingRoute.status,200);assert.equal(f.fake.calls.length,12,'activity quota leaves other routes unchanged');
});

test('invalid, expired and forged sessions neither read identity nor consume a tenant quota',async t=>{
  const f=await fixture(t),identity=f.auth(),[encoded,signature]=identity.token.split('.');
  const payload=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
  const otherUser=f.fake.states.get(OTHER).users[0];
  const expired=createSessionToken({workspaceId:WS,userId:payload.sub,email:payload.email,role:'owner'},SECRET,-60);
  for(let i=0;i<15;i++){
    const forged=Buffer.from(JSON.stringify({...payload,workspaceId:i%2?OTHER:WS,sub:otherUser.id,jti:'forged-'+i})).toString('base64url')+'.'+signature;
    for(const token of [forged,expired,'unsigned-workspace-'+i]){
      const result=await f.request('/api/activity',{identity:{token,csrf:identity.csrf},headers:{'X-Workspace-Id':OTHER}});
      assert.equal(result.status,401);assert.equal(result.body.code,'AUTH_REQUIRED');
    }
  }
  assert.equal(f.fake.calls.length,0);
  for(let i=0;i<10;i++)assert.equal((await f.request()).status,200);
  const other=await f.request('/api/activity',{identity:f.auth(OTHER)});assert.equal(other.status,200);
  assert.equal(f.fake.calls.length,11);
});

test('signed-session quota scope ignores query and header overrides and still rejects invalid requests',async t=>{
  const f=await fixture(t),identity=f.auth();
  for(let i=0;i<10;i++){
    const denied=await f.request('/api/activity?workspaceId='+OTHER,{identity,headers:{'X-Workspace-Id':OTHER}});
    assert.equal(denied.status,400);assert.equal(denied.body.code,'ACTIVITY_REQUEST_INVALID');
  }
  assert.equal(f.fake.calls.length,10);assert.ok(f.fake.calls.every(c=>c.url.searchParams.get('workspace_id')==='eq.'+WS));
  const limited=await f.request('/api/activity',{identity});assert.equal(limited.status,429);assert.equal(f.fake.calls.length,10);
  const other=await f.request('/api/activity',{identity:f.auth(OTHER)});assert.equal(other.status,200);assert.equal(other.body.workspaceId,OTHER);
});
