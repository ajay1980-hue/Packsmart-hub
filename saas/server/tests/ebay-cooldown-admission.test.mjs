import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { seedWorkspaceState, createStore } from '../lib/store.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
import { createPacksmartServer } from '../server.mjs';
import { createSessionToken, verifySessionToken } from '../lib/security.mjs';
import { IntegrationService } from '../lib/integrations.mjs';
import { connectionSettings, connectionDue, beginConnectionSync } from '../lib/connection-centre.mjs';
import { queueFirstSync, runFirstSync, runConnectionDoctor } from '../lib/connection-doctor.mjs';
import { createScheduler, monitoredSync } from '../lib/scheduler.mjs';
import { ebayReadCooldown, parseEbayRetryAfter } from '../lib/ebay-read-cooldown.mjs';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const LATER = new Date(NOW + 1800000).toISOString();
const SECRET = 'synthetic-ebay-cooldown-session-secret-32-characters';
function fixture({ review = false, held = true } = {}) {
  const state = seedWorkspaceState({}, { workspaceId: 'ebay-cooldown', email: 'owner@example.test', passwordHash: 'synthetic' });
  state.users[0].passwordChangeRequired = false;
  state.connections = [{ id: 'ebay-source', provider: 'ebay_oauth', encryptedCredentials: 'synthetic', status: 'connected', lastCheckedAt: new Date(NOW - 60000).toISOString() }];
  state.connectionSettings = { ebay: { ...connectionSettings(state, 'ebay'), areas: ['orders'], managedReadSchedule: true } };
  state.integrationStatus = { ebay: { status: 'connected', lastError: held ? 'EBAY_PARTIAL_READ' : null, ...(held ? review ? { retryAt: null, retryReviewRequired: true } : { retryAt: LATER } : {}) } };
  state.ebay = { listings: [], coverage: {} }; state.products = []; state.orders = [];
  state.connectionDoctor = { ebay: { attempts: 2, pendingReadAttempts: 2 } }; state.connectionSyncs = [];
  for (const key of Object.keys(state.automations)) state.automations[key] = key === 'channelSync';
  state.autopilot.enabled = true;
  return state;
}
function service(syncProvider) {
  return { syncProvider, ebayConfigured: () => true, shopifyRefreshAvailable: () => false, shopifyConfigured: () => false,
    connectionAccessExpiry: () => null, refreshSupported: () => false, oauthReady: () => true };
}
const deferred = error => error.cooldownDeferred === true;

for (const review of [false,true]) test(`eBay ${review ? 'review marker' : 'deadline'} blocks shared and direct admission without debt or state mutation`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const state = fixture({ review }); queueFirstSync(state, 'ebay', 'owner');
  state.connectionDoctor.ebay = { attempts: 2, pendingReadAttempts: 2 };
  const before = structuredClone(state); let calls = 0, saves = 0;
  const integrations = service(async () => { calls++; });
  for (const automatic of [false,true]) {
    assert.throws(() => beginConnectionSync(state,'ebay',{automatic}), deferred);
    await assert.rejects(monitoredSync(state,integrations,'ebay',{automatic}), deferred);
    await assert.rejects(monitoredSync(state,integrations,'ebay',{run:{automatic:true,areas:['orders']}}), deferred);
    await assert.rejects(runFirstSync(state,'ebay',{integrations,readSync:monitoredSync,automatic,save:async()=>{saves++;}}), deferred);
  }
  const direct = new IntegrationService({}, { fetchImpl: async () => { calls++; throw new Error('No provider request allowed'); } });
  await assert.rejects(direct.syncEbay(state), deferred);
  await assert.rejects(direct.syncEbayOAuth(state, {}), deferred);
  await runConnectionDoctor(state,{integrations,readSync:monitoredSync,now:new Date(),save:async()=>{saves++;}});
  assert.equal(connectionDue(state,'ebay',new Date(),integrations),false);
  assert.equal(calls,0); assert.equal(saves,0); assert.deepEqual(state,before);
});

test('legacy first scheduler pass cannot bypass provider or Doctor deadlines and does not save no-op work', async t => {
  t.mock.timers.enable({ apis:['Date'], now:NOW });
  for (const doctorOnly of [false,true]) {
    const state=fixture({held:!doctorOnly}); delete state.connectionSettings;
    if(doctorOnly) state.connectionDoctor.ebay.nextRetryAt=LATER;
    const before=structuredClone(state);let calls=0,saves=0;
    const scheduler=createScheduler({enabled:false,store:{get:async()=>state,save:async()=>{saves++;}},integrations:service(async()=>{calls++;}),withWorkspaceLock:async(id,fn)=>fn(),currentBrief:()=>({})});
    await scheduler.runWorkspace(state.workspace.id,{now:new Date()});
    assert.equal(calls,0);assert.equal(saves,0);assert.deepEqual(state,before);
  }
});

test('deadline equality permits one normal read, while a prebuilt automatic run honors Doctor delay',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const state=fixture();let calls=0;const integrations=service(async()=>{calls++;return{status:'connected',lastError:null};});
  t.mock.timers.tick(1800000-1);await assert.rejects(monitoredSync(state,integrations,'ebay'),deferred);
  t.mock.timers.tick(1);await monitoredSync(state,integrations,'ebay');
  assert.equal(calls,1);assert.equal(state.integrationStatus.ebay.retryAt,null);
  state.connectionDoctor.ebay.nextRetryAt=new Date(Date.now()+60000).toISOString();
  await assert.rejects(monitoredSync(state,integrations,'ebay',{run:{automatic:true,areas:['orders']}}),deferred);
  assert.equal(calls,1);
});

test('queued automatic first sync still imports with periodic syncing off and respects saved auth restrictions',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const state=fixture({held:false});state.connectionSettings.ebay.autoSync=false;queueFirstSync(state,'ebay','owner');
  let calls=0;const integrations=service(async(s,p,options)=>{calls++;assert.equal(options.automatic,true);return{status:'connected',lastError:null};});
  await runFirstSync(state,'ebay',{integrations,readSync:monitoredSync,automatic:true,save:async()=>{}});
  assert.equal(calls,1);assert.equal(state.connectionFirstSync.ebay.status,'completed');
  state.integrationStatus.ebay.lastError='UPSTREAM_AUTH_FAILED';
  await assert.rejects(monitoredSync(state,integrations,'ebay',{run:{automatic:true,areas:['orders']}}),{code:'AUTH_REPAIR_REQUIRED'});
  assert.equal(calls,1);
});

test('Doctor preserves a partial absolute deadline across save/reload and does not charge deferred ticks',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const state=fixture({held:false});let calls=0,saves=0,encoded;
  const integrations=service(async()=>{calls++;return{status:'connected',lastError:'EBAY_PARTIAL_READ',failedAreas:['orders'],upstreamStatus:429,transient:true,retryAt:LATER};});
  const save=async()=>{saves++;encoded=JSON.stringify(state);};
  await runConnectionDoctor(state,{integrations,readSync:monitoredSync,now:new Date(),save});
  assert.equal(calls,1);assert.equal(state.integrationStatus.ebay.retryAt,LATER);assert.equal(state.connectionDoctor.ebay.nextRetryAt,LATER);
  const reloaded=JSON.parse(encoded),before=structuredClone(reloaded),count=saves;
  t.mock.timers.tick(1799999);
  await runConnectionDoctor(reloaded,{integrations,readSync:monitoredSync,now:new Date(),save:async()=>{saves++;}});
  assert.equal(calls,1);assert.equal(saves,count);assert.deepEqual(reloaded,before);
});

test('successful unrelated returns and non-rate-limit failures cannot erase a deadline observed during the pass',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  for(const fails of [false,true]){
    const state=fixture({held:false});
    const integrations=service(async()=>{
      state.integrationStatus.ebay.retryAt=LATER;
      if(fails)throw Object.assign(new Error('synthetic'),{code:'UPSTREAM_REQUEST_FAILED',upstreamStatus:500});
      return{status:'connected',lastError:null,retryAt:new Date(NOW+60000).toISOString()};
    });
    if(fails)await assert.rejects(monitoredSync(state,integrations,'ebay',{retry:false}));else await monitoredSync(state,integrations,'ebay');
    assert.equal(state.integrationStatus.ebay.retryAt,LATER);
  }
});

test('expired canonical 429 metadata never becomes a fresh provider minute during fatal handling',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const state=fixture({held:false});
  await assert.rejects(monitoredSync(state,service(async()=>{throw Object.assign(new Error('synthetic'),{code:'CONNECTION_RATE_LIMITED',upstreamStatus:429,retryAt:new Date(NOW-1).toISOString()});}),'ebay'));
  assert.equal(state.integrationStatus.ebay.retryAt,null);
});

test('eBay 503 Retry-After is absolute and prevents inline retry without inventing a 429',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const state=fixture({held:false});let calls=0;
  const adapter=new IntegrationService({}, {fetchImpl:async()=>{calls++;return new Response('unavailable',{status:503,headers:{'retry-after':'172800'}});}});
  const integrations=service(async()=>adapter.ebayApiGet('https://synthetic.invalid/read','synthetic'));
  await assert.rejects(monitoredSync(state,integrations,'ebay'),error=>error.upstreamStatus===503&&error.retryAt===new Date(NOW+172800000).toISOString());
  assert.equal(calls,1);assert.equal(state.integrationStatus.ebay.upstreamStatus,503);
  assert.equal(state.integrationStatus.ebay.retryAt,new Date(NOW+172800000).toISOString());
  for(const header of [null,'malformed']){
    const plain=fixture({held:false});let attempts=0;
    const source=new IntegrationService({}, {fetchImpl:async()=>{attempts++;return new Response('unavailable',{status:503,headers:header?{'retry-after':header}:{}});}});
    await assert.rejects(monitoredSync(plain,service(async()=>source.ebayApiGet('https://synthetic.invalid/read','synthetic')),'ebay'));
    assert.equal(attempts,2);assert.equal(plain.integrationStatus.ebay.retryAt,null);assert.equal(plain.integrationStatus.ebay.upstreamStatus,503);
  }
});

test('Doctor preserves a fresh legacy 503 retryAfterMs and does not reanchor its persisted deadline',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const state=fixture({held:false});let calls=0;
  const integrations=service(async()=>{calls++;throw Object.assign(new Error('synthetic'),{code:'UPSTREAM_REQUEST_FAILED',upstreamStatus:503,retryAfterMs:1800000});});
  await runConnectionDoctor(state,{integrations,readSync:monitoredSync,now:new Date(),save:async()=>{}});
  assert.equal(calls,1);assert.equal(state.integrationStatus.ebay.upstreamStatus,503);
  assert.equal(state.integrationStatus.ebay.retryAt,LATER);assert.equal(state.connectionDoctor.ebay.nextRetryAt,LATER);
  assert.equal(state.integrationStatus.ebay.retryAfterMs,undefined);
  t.mock.timers.tick(1800000);
  assert.equal(ebayReadCooldown(JSON.parse(JSON.stringify(state))).retryAt,null);
});

for(const backend of ['file','mock-supabase'])test(`${backend} save/reload retains cooldown and stale saves cannot shorten it`,async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ebay-cooldown-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const database=fakeSupabase();const store=backend==='file'?createStore({SAAS_STATE_FILE:path.join(directory,'state.json')}):createStore({SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic'},{fetchImpl:database.fetchImpl});
  const state=fixture();await store.save(state.workspace.id,state);const stale=await store.get(state.workspace.id),fresh=await store.get(state.workspace.id);
  fresh.integrationStatus.ebay.retryAt=new Date(NOW+7200000).toISOString();await store.save(state.workspace.id,fresh);
  stale.integrationStatus.ebay.retryAt=new Date(NOW+60000).toISOString();await assert.rejects(store.save(state.workspace.id,stale),{code:'STATE_CONFLICT'});
  const reloaded=await store.get(state.workspace.id);assert.equal(ebayReadCooldown(reloaded).retryAt,new Date(NOW+7200000).toISOString());
  assert.throws(()=>beginConnectionSync(reloaded,'ebay',{automatic:true}),deferred);
});

test('review evidence survives test/refresh and reconnect bookkeeping without a new reset control',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const state=fixture({review:true});state.ebay.coverage.readDiagnostics={orders:parseEbayRetryAfter('9'.repeat(129),NOW)};
  const integrations=new IntegrationService({}, {fetchImpl:async()=>{throw new Error('Network forbidden');}});
  integrations.ebayConfig=()=>({mode:'direct_oauth',expectedAccount:'synthetic-seller',connection:state.connections[0]});
  integrations.ebayAccessToken=async()=>'synthetic';integrations.connectorIdentity=async()=>({account:'synthetic-seller'});
  for(const refresh of [false,true]){await integrations.testConnection(state,'ebay',{refresh});assert.equal(ebayReadCooldown(state).retryReviewRequired,true);}
  queueFirstSync(state,'ebay','owner');assert.equal(ebayReadCooldown(state).retryReviewRequired,true);
  assert.throws(()=>beginConnectionSync(state,'ebay'),deferred);
});

async function apiFixture(t,{held=true,review=false}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ebay-cooldown-api-'));
  const server=createPacksmartServer({NODE_ENV:'test',APP_PUBLIC_URL:'https://runvara.example.test',SESSION_SECRET:SECRET,CREDENTIALS_KEY:SECRET,SAAS_STATE_FILE:path.join(directory,'state.json'),SHOPIFY_PUBLIC_SYNC_ENABLED:'false'}, {fetchImpl:async()=>{throw new Error('Network forbidden');},schedulerEnabled:false,agentOpsEnabled:false});
  const state=fixture({held,review});await server.packsmart.store.save(state.workspace.id,state);
  server.packsmart.integrations.ebayConfigured=()=>true;server.packsmart.integrations.shopifyRefreshAvailable=()=>false;
  let calls=0;server.packsmart.integrations.syncProvider=async()=>{calls++;throw Object.assign(new Error('synthetic'),{code:'CONNECTION_RATE_LIMITED',upstreamStatus:429,retryAt:new Date(Date.now()+1800000).toISOString()});};
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await server.packsmart.drain();await fs.rm(directory,{recursive:true,force:true});});
  const token=createSessionToken({userId:state.users[0].id,workspaceId:state.workspace.id,email:state.users[0].email,role:'owner',sessionVersion:1},SECRET);
  const request=async route=>{const response=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:'POST',headers:{Cookie:`__Host-packsmart_session=${token}`,'X-CSRF-Token':verifySessionToken(token,SECRET).csrf,'Content-Type':'application/json'},body:'{}'});return{status:response.status,body:await response.json()};};
  return{server,state,request,calls:()=>calls};
}

for(const review of [false,true])test(`owner sync endpoints defer ${review?'review evidence':'cooldown'} before resetting debt or saving`,async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const f=await apiFixture(t,{review});const before=await f.server.packsmart.store.get(f.state.workspace.id);
  for(const route of ['/api/connections/ebay/sync','/api/integrations/ebay/sync','/api/integrations/sync']){
    const response=await f.request(route);assert.equal(response.status,429,route);assert.equal(f.calls(),0);
    assert.deepEqual(await f.server.packsmart.store.get(f.state.workspace.id),before,route);
  }
});

test('legacy owner endpoint saves fatal eBay deadline then refuses another request',async t=>{
  t.mock.timers.enable({apis:['Date'],now:NOW});
  const f=await apiFixture(t,{held:false});assert.equal((await f.request('/api/integrations/ebay/sync')).status,422);
  const saved=await f.server.packsmart.store.get(f.state.workspace.id);assert.equal(saved.integrationStatus.ebay.retryAt,LATER);assert.equal(f.calls(),1);
  assert.equal((await f.request('/api/integrations/ebay/sync')).status,429);assert.equal(f.calls(),1);
  assert.deepEqual(await f.server.packsmart.store.get(f.state.workspace.id),saved);
});
