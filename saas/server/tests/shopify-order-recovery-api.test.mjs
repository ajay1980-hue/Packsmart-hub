import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { recoveryFixture } from './shopify-order-recovery-fixture.mjs';
import { createPacksmartServer } from '../server.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import crypto from 'node:crypto';

async function fixture(t,options={}) {
  const f=recoveryFixture({count:1,...options}),server=createPacksmartServer(f.env,{store:f.store,integrations:f.integrations,schedulerEnabled:false,agentOpsEnabled:false});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{await server.packsmart.drain();await new Promise(resolve=>server.close(resolve));});
  const token=createSessionToken({userId:f.actor.id,workspaceId:f.state.workspace.id,email:f.state.users[0].email,role:'owner',sessionVersion:1},f.env.SESSION_SECRET);
  const session=verifySessionToken(token,f.env.SESSION_SECRET),base=`http://127.0.0.1:${server.address().port}`;
  const request=(path,body,options={})=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Cookie:`packsmart_session=${token}`,'X-CSRF-Token':session.csrf,...options.headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {...f,request};
}
const route='/api/connections/shopify/order-recovery';
test('explicit preview advertises safe fixed window and selection; action has only safe public result',async t=>{
  const f=await fixture(t),centre=await (await f.request('/api/connection-centre')).json();
  assert.equal(centre.channels.find(c=>c.id==='shopify').orderRecovery.available,true);assert.equal(f.metrics.summary,undefined);
  const response=await f.request(route),preview=await response.json();assert.equal(response.status,200);assert.equal(preview.schema,'runvara-order-recovery-preview/v1');assert.equal(preview.window.requestedUpperBound,preview.originalStartedAt);
  const result=await f.request(route+'/start',{selection:preview.selection});const body=await result.json();assert.equal(result.status,200);assert.equal(body.status,'committed',JSON.stringify(body));assert.equal(body.originalStartedAt,preview.originalStartedAt);
  assert.doesNotMatch(JSON.stringify(body),/stageId|binding|cursor|encryptedCredentials|sessionDigest/);
  const replay=await f.request(route+'/start',{selection:preview.selection});assert.equal(replay.status,409);
  const updated=await (await f.request('/api/connection-centre')).json();assert.doesNotMatch(JSON.stringify(updated),/orderRecoveryStageId|sorstage_/);assert.equal(updated.channels.find(c=>c.id==='shopify').orderRecoveryObservation.originalStartedAt,preview.originalStartedAt);
});
test('inactive feature has no stage I/O during bootstrap, connection listing, or explicit inactive preview',async t=>{
  const f=await fixture(t,{enabled:false});await f.request('/api/connection-centre');const p=await (await f.request(route)).json();assert.equal(p.available,false);assert.equal(f.metrics.summary,undefined);assert.equal(f.controls.providerCalls,0);
});
for(const role of ['member','viewer'])test(`${role} cannot inspect recovery or perform stage I/O`,async t=>{
  const f=await fixture(t);f.fake.states.get(f.state.workspace.id).users[0].role=role;
  assert.equal((await f.request(route)).status,403);assert.equal((await f.request(route+'/start',{selection:'invalid-selection'})).status,403);assert.equal(f.metrics.summary,undefined);assert.equal(f.metrics.full,undefined);assert.equal(f.controls.providerCalls,0);
});
test('inactive, stale-session and password-change-required actors do zero recovery I/O',async t=>{
  const f=await fixture(t),user=f.fake.states.get(f.state.workspace.id).users[0];
  user.active=false;assert.equal((await f.request(route)).status,401);user.active=true;
  user.sessionVersion=2;assert.equal((await f.request(route)).status,401);user.sessionVersion=1;
  user.passwordChangeRequired=true;assert.equal((await f.request(route)).status,403);assert.equal(f.metrics.summary,undefined);assert.equal(f.controls.providerCalls,0);
});
test('CSRF, query injection, body overrides and wrong endpoint cannot cause provider or stage mutation',async t=>{
  const f=await fixture(t),preview=await (await f.request(route)).json();
  assert.equal((await f.request(route+'?stageId=private')).status,400);
  assert.equal((await f.request(route+'/start',{selection:preview.selection},{headers:{'X-CSRF-Token':'bad'}})).status,403);
  assert.equal((await f.request(route+'/start',{selection:preview.selection,after:'cursor'})).status,409);
  assert.equal((await f.request(route+'/resume',{selection:preview.selection})).status,409);
  assert.equal(f.controls.providerCalls,0);assert.equal(f.metrics.full,undefined);assert.equal(f.metrics.stage_mutation,undefined);
});
test('POST admission catches a changed persisted revision since preview before full stage hydration',async t=>{
  const f=await fixture(t),preview=await (await f.request(route)).json();f.fake.states.get(f.state.workspace.id)._revision='00000000-0000-4000-8000-000000000123';
  assert.equal((await f.request(route+'/start',{selection:preview.selection})).status,409);assert.equal(f.metrics.full,undefined);assert.equal(f.controls.providerCalls,0);
});
test('legacy ordinary Shopify endpoint without retained marker keeps one original primary save and no recovery calls',async t=>{
  const f=await fixture(t,{enabled:false});f.clearMetrics();const response=await f.request('/api/integrations/shopify/sync',{});assert.equal(response.status,200,JSON.stringify(await response.json()));
  assert.equal(f.metrics.primary.calls,1);assert.equal(f.metrics.summary,undefined);assert.equal(f.metrics.full,undefined);assert.equal(f.metrics.stage_mutation,undefined);
});
test('bootstrap and connection centre show only current-tenant, exact-reference, fully validated recovery provenance',async t=>{
  const f=await fixture(t),preview=await (await f.request(route)).json();
  assert.equal((await (await f.request(route+'/start',{selection:preview.selection})).json()).status,'committed');
  const baseline=f.snapshot(),providerCalls=f.controls.providerCalls;
  const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
  const replace=(container,manifest)=>{const ref='sor3:'+crypto.createHash('sha256').update(JSON.stringify(canonical(manifest))).digest('hex');container.manifests={[ref]:manifest};container.lastSuccess=ref;};
  const mutations={
    valid:()=>{},
    foreignContainer:(s,c)=>{c.workspaceId='foreign-workspace';},
    absentContainerTenant:(s,c)=>{delete c.workspaceId;},
    foreignManifest:(s,c,m)=>{m.workspaceId='foreign-workspace';replace(c,m);},
    foreignChannelParent:s=>{s.channelData.shopify.workspaceId='foreign-workspace';},
    wrongDigest:(s,c,m)=>{c.lastSuccess='sor3:'+'0'.repeat(64);c.manifests={[c.lastSuccess]:m};},
    missingReference:(s,c)=>{c.lastSuccess='sor3:'+'f'.repeat(64);},
    invalidTime:(s,c,m)=>{m.recovery.lastCapturedAt='not-a-time';m.recovery.pageCaptureTimes[0]='not-a-time';replace(c,m);},
    wrongWindow:(s,c,m)=>{m.requestedUpperBound='2026-01-01T00:00:00.000Z';replace(c,m);},
    oversizedMap:(s,c)=>{c.padding='x'.repeat(16384);}
  };
  for(const [name,mutate] of Object.entries(mutations))for(const endpoint of ['/api/bootstrap','/api/connection-centre']) {
    const state=structuredClone(baseline),container=state.channelData.shopify.orderReads,manifest=container.manifests[container.lastSuccess];mutate(state,container,manifest);f.fake.states.set(state.workspace.id,state);
    const response=await f.request(endpoint),body=await response.json();assert.equal(response.status,200,name+':'+endpoint);
    const channels=endpoint==='/api/bootstrap'?body.connectionCentre:body.channels,observation=channels.find(channel=>channel.id==='shopify').orderRecoveryObservation;
    if(name==='valid'){assert.equal(observation.originalStartedAt,preview.originalStartedAt);assert.equal(observation.window.requestedUpperBound,preview.originalStartedAt);}
    else assert.equal(observation,null,name+':'+endpoint);
  }
  assert.equal(f.controls.providerCalls,providerCalls,'display validation does not contact the provider');
});
