import test from 'node:test';
import assert from 'node:assert/strict';
import { seedWorkspaceState, createStore } from '../lib/store.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
import { runConnectionDoctor, queueFirstSync, runFirstSync, validateImportedData } from '../lib/connection-doctor.mjs';
import { intelligentConnections, providerReadiness, classifyConnectionIssue, doctorNotifications } from '../lib/connection-intelligence.mjs';
import { monitoredSync, createScheduler } from '../lib/scheduler.mjs';
import { connectionDue, connectionSettings } from '../lib/connection-centre.mjs';
import { saveOnboardingJourney, onboardingJourney } from '../lib/onboarding.mjs';
import { IntegrationService } from '../lib/integrations.mjs';
import { encryptCredentials, decryptCredentials } from '../lib/security.mjs';
import { addAudit } from '../lib/events.mjs';
const KEY='doctor-test-encryption-key-at-least-thirty-two';
const now=new Date('2026-09-26T21:00:00Z');
function stateFor(provider='shopify') {
  const state=seedWorkspaceState({}, {workspaceId:'doctor-alpha',email:'owner@example.test',passwordHash:'test'});
  state.connections=[{id:'connection',provider:provider==='ebay'?'ebay_oauth':provider,encryptedCredentials:'test-encrypted-record',status:'connected',lastCheckedAt:now.toISOString(),metadata:{account:'Expected account'}}];
  state.products=[];state.orders=[];state.integrationStatus={[provider]:{status:'connected',lastSuccessfulSyncAt:now.toISOString()}};
  state.connectionSettings={[provider]:{...connectionSettings(state,provider),areas:provider==='shopify'?['products','variants','inventory','prices','orders']:connectionSettings(state,provider).areas}};
  return state;
}
function service(extra={}) {
  return {oauthReady:()=>true,refreshSupported:()=>false,connectionAccessExpiry:()=>null,shopifyConfigured:()=>true,ebayConfigured:()=>false,
    testConnection:async()=>({ok:true}),syncProvider:async(state,provider)=>({status:'connected',lastError:null}),...extra};
}
function doctor(state,integrations,extra={}) {return runConnectionDoctor(state,{integrations,readSync:monitoredSync,save:async()=>{},now,...extra});}

test('registry exposes implemented capabilities, pending access and operator-only setup without credentials',()=>{
  const integrations=new IntegrationService({APP_PUBLIC_URL:'https://app.example.test',TIKTOK_SHOP_APP_SECRET:'secret-never-public'});
  const state=stateFor();
  const customer=providerReadiness(state,integrations), operator=providerReadiness(state,integrations,{operator:true});
  const tiktok=customer.find(p=>p.id==='tiktok_shop');
  assert.equal(tiktok.customerConnectAvailable,false);assert.match(tiktok.restrictionMessage,/approval/);assert.ok(tiktok.supportedReadAreas.includes('orders'));
  assert.equal(tiktok.setupMessage,undefined);assert.equal(tiktok.supportedMarkets,null);
  assert.match(operator.find(p=>p.id==='tiktok_shop').setupMessage,/OAuth code is ready/);
  assert.doesNotMatch(JSON.stringify([customer,operator]),/secret-never-public/);
  assert.deepEqual(customer.find(p=>p.id==='google_youtube').supportedReadAreas,['channels']);
});

test('first sync records real durable stages, retains partial imports and retries only failed areas',async()=>{
  const state=stateFor();state.orders=[{id:'old-order',provider:'shopify'}];let fail=true;const stages=[],calls=[];
  const integrations=service({syncProvider:async(s,p,{areas})=>{calls.push(areas);if(areas.includes('orders')&&fail)throw Object.assign(new Error('private provider payload'),{code:'UPSTREAM_REQUEST_FAILED',upstreamStatus:503});if(areas.includes('products'))s.products=[{id:'p1',provider:p,variants:[{id:'v1'}]}];return {status:'connected',lastError:null};}});
  queueFirstSync(state,'shopify','owner');
  const run=()=>runFirstSync(state,'shopify',{integrations,readSync:monitoredSync,save:async()=>stages.push(structuredClone(state.connectionFirstSync.shopify)),retryFailedOnly:true});
  await run();
  assert.ok(stages.some(s=>s.areas.products==='running'));assert.equal(state.connectionFirstSync.shopify.status,'partial');assert.equal(state.products.length,1);assert.equal(state.orders[0].id,'old-order');
  assert.deepEqual(Object.keys(state.connectionFirstSync.shopify.failures),['orders']);assert.equal(state.integrationStatus.shopify.status,'degraded');assert.equal(onboardingJourney(state).complete,false);
  fail=false;await run();
  assert.equal(state.connectionFirstSync.shopify.status,'completed');assert.deepEqual(calls.at(-1),['orders']);assert.equal(calls.filter(c=>c.includes('products')).length,1);assert.equal(onboardingJourney(state).complete,true);
  assert.doesNotMatch(JSON.stringify(state.audit),/private provider payload/);
});

test('products-only first sync tolerates unavailable retained orders but selected orders fail explicitly', async () => {
  for (const provider of ['shopify', 'ebay']) for (const orders of [undefined, null, [null]]) for (const selectedOrders of [false, true]) {
    const state = stateFor(provider), calls = [];
    state.orders = orders;
    state.connectionSettings[provider].areas = selectedOrders ? ['products', 'orders'] : ['products'];
    const integrations = service({ syncProvider: async (current, channel, { areas }) => {
      calls.push([...areas]);
      if (channel === 'shopify') current.products = [{ id: 'p1', provider: channel, variants: [{ id: 'v1' }] }];
      else current.ebay = { listings: [{ id: 'listing1' }] };
      return { status: 'connected', lastError: null };
    } });
    queueFirstSync(state, provider, 'owner');
    const result = await runFirstSync(state, provider, { integrations, readSync: monitoredSync, save: async () => {} });
    assert.equal(result.status, selectedOrders ? 'partial' : 'completed', `${provider}: orders selected=${selectedOrders}`);
    assert.equal(result.validation.ok, !selectedOrders);
    assert.equal(result.validation.counts.orders, null);
    assert.deepEqual(result.validation.unavailableAreas, ['orders']);
    assert.deepEqual(result.validation.problemAreas, selectedOrders ? ['orders'] : []);
    assert.equal(calls.flat().includes('orders'), selectedOrders);
    assert.equal(state.orders, orders, 'Validation must preserve the retained source collection');
    assert.equal(validateImportedData(state, provider).ok, false, 'Unscoped diagnostics must still expose missing order evidence');
    assert.equal(Boolean(state.integrationStatus[provider].areaSuccessAt?.orders), selectedOrders, 'Products-only success must not claim an order read');
  }
});

test('doctor renews expiring tokens using the existing encrypted rotation and never performs channel writes',async()=>{
  const state=stateFor('pinterest');let tokenCalls=0;
  state.connections[0].encryptedCredentials=encryptCredentials({accessToken:'expired-access',refreshToken:'old-refresh',expiresAt:now.getTime()-1000},KEY);
  const integrations=new IntegrationService({CREDENTIALS_KEY:KEY,PINTEREST_CLIENT_ID:'id',PINTEREST_CLIENT_SECRET:'secret'},{fetchImpl:async(url,options)=>{
    if(String(url).includes('/oauth/token')){tokenCalls++;assert.equal(new URLSearchParams(options.body).get('grant_type'),'refresh_token');return new Response(JSON.stringify({access_token:'fresh-access',refresh_token:'rotated-refresh',expires_in:86400}),{status:200});}
    assert.match(String(url),/\/user_account$/);assert.equal(options.method,undefined);return new Response(JSON.stringify({username:'Expected account'}),{status:200});
  }});
  await doctor(state,integrations);
  assert.equal(tokenCalls,1);assert.equal(decryptCredentials(state.connections[0].encryptedCredentials,KEY).refreshToken,'rotated-refresh');
  assert.doesNotMatch(JSON.stringify(doctorNotifications(state)),/fresh-access|rotated-refresh|secret/);
  assert.ok(state.audit.some(e=>e.type==='connection_doctor_repair_success'));
});

test('revoked access, account mismatch, missing scopes and provider restrictions never trigger automatic repairs',async()=>{
  for(const code of ['CONNECTION_AUTH_REQUIRED','ACCOUNT_MISMATCH','META_PERMISSION_REQUIRED','PROVIDER_APPROVAL_REQUIRED']) {
    const state=stateFor();state.integrationStatus.shopify.lastError=code;let calls=0;
    await doctor(state,service({testConnection:async()=>calls++,syncProvider:async()=>calls++,refreshSupported:()=>true,connectionAccessExpiry:()=>new Date(now.getTime()-1).toISOString()}));
    assert.equal(calls,0);assert.ok(state.audit.some(e=>e.type==='connection_doctor_user_action_required'));
    const auditCount=state.audit.length;await doctor(state,service());assert.equal(state.audit.length,auditCount,'unchanged issues are deduplicated');
  }
});

test('transient recovery claims a durable lease before reading and observes backoff, retry-after and retry cap',async()=>{
  const state=stateFor();state.integrationStatus.shopify={status:'error',lastError:'UPSTREAM_REQUEST_FAILED',upstreamStatus:503};let calls=0,claimed=false;
  const integrations=service({syncProvider:async()=>{calls++;assert.equal(claimed,true);throw Object.assign(new Error('private'),{code:'CONNECTION_RATE_LIMITED',upstreamStatus:429,retryAfterMs:600000});}});
  const save=async()=>{if(state.connectionDoctor.shopify.leaseUntil)claimed=true;};
  await doctor(state,integrations,{save});assert.equal(calls,1);assert.ok(Date.parse(state.connectionDoctor.shopify.nextRetryAt)>=now.getTime()+600000);
  await doctor(state,integrations,{now:new Date(now.getTime()+1000),save});assert.equal(calls,1);
  for(let i=0;i<4;i++)await doctor(state,integrations,{now:new Date(Date.parse(state.connectionDoctor.shopify.nextRetryAt)+1),save});
  assert.equal(state.connectionDoctor.shopify.exhausted,true);assert.equal(calls,5);assert.equal(connectionDue(state,'shopify',new Date('2030-01-01')),false);
  await doctor(state,integrations,{now:new Date('2030-01-01'),save});assert.equal(calls,5);
});

test('expired read leases recover but live leases, disconnected accounts and paused reads remain untouched',async()=>{
  const state=stateFor();state.connectionSyncs=[{id:'expired',provider:'shopify',status:'running',leaseUntil:new Date(now.getTime()-1).toISOString()}];let calls=0;
  const integrations=service({syncProvider:async()=>{calls++;return {status:'connected',lastError:null};}});
  await doctor(state,integrations);assert.equal(calls,1);assert.equal(state.connectionSyncs.find(r=>r.id==='expired').errorCode,'WORKER_INTERRUPTED');
  state.integrationStatus.shopify={lastError:'UPSTREAM_REQUEST_FAILED',upstreamStatus:503};state.connectionSyncs=[{provider:'shopify',status:'running',leaseUntil:new Date(now.getTime()+60000).toISOString()}];await doctor(state,integrations);assert.equal(calls,1);
  state.connectionSyncs=[];state.connectionSettings.shopify.autoSync=false;await doctor(state,integrations);assert.equal(calls,1);
  state.connectionSettings.shopify.disconnected=true;await doctor(state,integrations);assert.equal(calls,1);
});

test('Auto-Doctor can recover read-only connections with the general autopilot paused and never accesses write methods',async()=>{
  const state=stateFor();state.autopilot={enabled:false};state.integrationStatus.shopify={lastError:'UPSTREAM_REQUEST_FAILED',upstreamStatus:503};let read=0;
  const integrations=service({syncProvider:async()=>{read++;return {status:'connected',lastError:null};}});
  for(const method of ['executeWrite','publish','shopifyWrite','metaWrite','authorizationUrl'])Object.defineProperty(integrations,method,{get(){throw new Error(`Forbidden method ${method}`);}});
  const scheduler=createScheduler({store:{get:async()=>state,save:async()=>{}},integrations,withWorkspaceLock:async(_id,callback)=>callback(),currentBrief:()=>{},enabled:false});
  await scheduler.runWorkspace(state.workspace.id,{now});assert.equal(read,1);assert.equal(state.autopilot.enabled,false);
  assert.ok(state.audit.filter(e=>e.type.startsWith('connection_doctor_')).every(e=>e.detail.externalWrites===false));
});

test('recommended defaults and optional preferences stay least privilege, are revision checked and support skip',()=>{
  const state=stateFor(),owner=state.users[0];state.onboardingJourney={revision:0,platforms:['shopify']};
  let journey=saveOnboardingJourney(state,{revision:0,useRecommended:true},owner);
  assert.equal(journey.preferences.customerRecords,false);assert.equal(journey.preferences.approval,'always');assert.equal(connectionSettings(state,'shopify').permissionMode,'read_only');
  journey=saveOnboardingJourney(state,{revision:1,preferences:{automation:'manual',stockThreshold:12,marketing:true}},owner);
  assert.equal(connectionSettings(state,'shopify').autoSync,false);assert.equal(state.settings.lowStockThreshold,12);assert.equal(journey.preferences.marketing,true);
  assert.throws(()=>saveOnboardingJourney(state,{revision:1,finish:true},owner),e=>e.code==='CONNECTION_CONFLICT');
  assert.throws(()=>saveOnboardingJourney(state,{revision:2,useRecommended:true},{role:'viewer'}),e=>e.status===403);
  assert.deepEqual(saveOnboardingJourney(state,{revision:2,platforms:[]},owner).platforms,[]);
});

test('health includes evidence and honest unknowns, distinguishes restrictions and never fabricates scores',()=>{
  const state=stateFor();let channels=intelligentConnections(state,service(),{now,persistence:{primaryPersistence:true},scheduler:{lastTickAt:now.toISOString()}});
  const health=channels.find(c=>c.id==='shopify').health;assert.equal(health.status,'Healthy');assert.equal(health.webhookHealth,'not_monitored');assert.equal(health.scopeEvidence,'not_reported');assert.equal(health.score,undefined);
  state.integrationStatus.shopify.lastError='ACCOUNT_MISMATCH';assert.equal(classifyConnectionIssue(state,'shopify',now).kind,'account_mismatch');
  const ebay=stateFor('ebay');ebay.ebay={coverage:{readDiagnostics:{marketing:{errorIds:['35077']}}}};assert.equal(classifyConnectionIssue(ebay,'ebay',now).kind,'provider_restriction');
  state.products=[{provider:'shopify',id:'duplicate'},{provider:'shopify',id:'duplicate'}];assert.equal(validateImportedData(state,'shopify').ok,false);
});

test('doctor events archive before hot-state trimming, restore durably and stay tenant scoped',async()=>{
  const fake=fakeSupabase();const store=createStore({SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test'},{fetchImpl:fake.fetchImpl});
  let state=stateFor();await store.save(state.workspace.id,state);state=await store.get(state.workspace.id);
  for(let i=0;i<650;i++)addAudit(state,{type:'connection_doctor_repair_success',actor:'connection-doctor',detail:{provider:'shopify',message:`Recovered ${i}`,externalWrites:false}});
  await store.save(state.workspace.id,state);const restored=await store.get(state.workspace.id);
  assert.ok(restored.audit.length<=300);assert.ok((fake.tables.get('audit_events')||[]).filter(e=>e.workspace_id===state.workspace.id).length>=650);
  assert.ok((await store.integrityCheck(state.workspace.id)).healthy);
  const beta=seedWorkspaceState({}, {workspaceId:'doctor-beta',email:'beta@example.test',passwordHash:'test'});await store.save('doctor-beta',beta);
  assert.deepEqual(doctorNotifications(await store.get('doctor-beta')),[]);assert.equal(doctorNotifications(restored).length,1);
});

test('empty authorised assets and duplicate variants cannot produce a business-ready first sync',async()=>{
  for(const [provider,area] of [['meta','accounts'],['google_youtube','channels']]) {
    const state=stateFor(provider);state.channelData={[provider]:{[area]:[]}};queueFirstSync(state,provider,'owner');
    await runFirstSync(state,provider,{integrations:service(),readSync:monitoredSync,save:async()=>{}});
    assert.notEqual(state.connectionFirstSync[provider].status,'completed');assert.equal(onboardingJourney(state).complete,false);
    assert.equal(classifyConnectionIssue(state,provider).kind,'missing_asset');
  }
  const state=stateFor();state.products=[{provider:'shopify',id:'p1',variants:[{id:'v1'},{id:'v1'}]}];
  assert.deepEqual(validateImportedData(state,'shopify').problemAreas,['variants']);
});

test('eBay provider eligibility pauses marketing retries while independent commerce reads continue',async()=>{
  const state=stateFor('ebay');state.connectionSettings.ebay.managedReadSchedule=true;
  state.ebay={coverage:{ordersAvailable:true,unavailableSurfaces:['marketing'],readDiagnostics:{marketing:{errorIds:['35077']}}}};
  state.integrationStatus.ebay={status:'connected',lastError:'Some eBay read data is currently unavailable: marketing.'};
  state.onboardingJourney={platforms:['ebay'],permissionReviews:{ebay:0}};
  state.connectionFirstSync={ebay:{status:'partial',areas:{orders:'completed',promotions:'failed'},failures:{promotions:{code:'CONNECTION_READ_FAILED'}},validation:{ok:true},previousSuccessfulSyncAt:now.toISOString()}};
  let called=[];
  await doctor(state,service({syncProvider:async(s,p,{areas})=>{called.push(areas);return {status:'connected',lastError:null};}}));
  assert.equal(called.length,1);assert.ok(called[0].includes('orders'));assert.ok(!called[0].includes('promotions'));
  assert.equal(onboardingJourney(state).complete,true);assert.equal(classifyConnectionIssue(state,'ebay').kind,'provider_restriction');
  assert.ok(!doctorNotifications(state).some(n=>n.message.includes('repaired')));
});
