import test from 'node:test';
import assert from 'node:assert/strict';
import { creativeApiFixture } from './quiet-creative-api-fixture.mjs';
import { CREATIVE_PILOT_BASE } from '../lib/quiet-creative-pilot.mjs';
const writes = f => f.calls.filter(c => c.method !== 'GET');

test('HTTP default-off creative pilot does not read state or accept business actions', async t => {
  const f=await creativeApiFixture(t,{disabled:true});
  for(const op of ['review','prepare','decide','submit','observe'])assert.equal((await f.call(op)).status,503);
  assert.equal(f.calls.length,0);assert.equal(f.providerCalls.length,0);
});

test('HTTP maintenance route requires signed exact scope before persistence and has no broad bypass', async t => {
  const f=await creativeApiFixture(t);
  assert.equal((await f.call('review',undefined,{cookie:undefined})).status,401);
  for(const auth of [f.identity({workspaceId:'beta'}),f.identity({userId:'different'})])assert.equal((await f.call('review',undefined,auth)).status,403);
  for(const [method,path] of [['GET',CREATIVE_PILOT_BASE+'submit'],['POST',CREATIVE_PILOT_BASE+'review'],['POST','/api/marketing/campaigns/campaign/creatives/advance'],['GET','/api/bootstrap'],['POST','/api/auth/login'],['GET','/api/maintenance/commerce'],['POST','/api/actions'],['GET','/api/integrations/canva/oauth/callback'],['POST','/api/marketing/publish']])assert.equal((await f.request(path,{method,...f.auth})).status,503);
  assert.equal((await f.request(CREATIVE_PILOT_BASE+'review?requestId=other',f.auth)).status,400);assert.equal(f.calls.length,0);assert.equal(f.providerCalls.length,0);
});

test('HTTP fresh role, password, session, CSRF and origin checks deny without writes', async t => {
  for(const kind of ['role','password','session','inactive','csrf','origin'])await t.test(kind,async t=>{
    const f=await creativeApiFixture(t),u=f.fake.states.get('alpha').users[0],overrides={};
    if(kind==='role')u.role='admin';if(kind==='password')u.passwordChangeRequired=true;if(kind==='session')u.sessionVersion++;if(kind==='inactive')u.active=false;
    if(kind==='csrf')overrides.headers={Origin:'https://maintenance.example.test'};if(kind==='origin')overrides.headers={...f.auth.headers,Origin:'https://foreign.invalid'};
    assert.ok([401,403].includes((await f.call('prepare',undefined,overrides)).status));assert.equal(writes(f).length,0);assert.equal(f.synthetic.calls.length,0);assert.equal(f.providerCalls.length,0);
  });
});

test('HTTP exact review, owner decision and real store CAS preserve unrelated tenant and keep workers closed',async t=>{
  const f=await creativeApiFixture(t),beta=structuredClone(f.fake.states.get('beta'));
  const session=await f.request('/api/auth/session',f.auth);assert.equal(session.payload.maintenance,true);assert.equal(session.payload.creativePilot.requestId,f.synthetic.request.id);
  assert.doesNotMatch(JSON.stringify(session.payload.creativePilot),/synthetic-key|accountBinding/);
  const p=await f.call('prepare');assert.equal(p.status,200,JSON.stringify(p.payload));assert.equal(f.providerCalls.length,0);
  const row=p.payload.allowance,body={requestId:f.synthetic.request.id,approvalId:row.id,revision:row.revision,decision:'approved'};
  assert.equal((await f.call('decide',body)).status,200);
  const sent=await f.call('submit');assert.equal(sent.status,200,JSON.stringify(sent.payload));assert.equal(f.providerCalls.length,1);
  assert.equal(f.fake.states.get('alpha').marketing.campaigns[0].creativeRequests[0].taskId,'task-synthetic');assert.deepEqual(f.fake.states.get('beta'),beta);
  assert.notEqual((await f.call('submit')).status,200);assert.equal(f.providerCalls.length,1);
  assert.equal(f.server.packsmart.scheduler.status.lastTickAt,null);assert.equal(f.server.packsmart.agentOps.status.lastTickAt,null);
});

test('HTTP browser payload and unknown target cannot prepare policy or other tasks',async t=>{
  const f=await creativeApiFixture(t);
  for(const body of [null,[],{}, {requestId:'other'}, {requestId:f.synthetic.request.id,provider:'canva'}, {requestId:f.synthetic.request.id,maxCostMicros:0}])assert.equal((await f.call('prepare',body)).status,400);
  assert.equal(f.synthetic.calls.length,0);assert.equal(writes(f).length,0);assert.equal(f.providerCalls.length,0);
});
