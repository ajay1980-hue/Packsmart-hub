import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connectionHealth, intelligentConnections } from '../lib/connection-intelligence.mjs';
import { connectionSettings, finishConnectionSync } from '../lib/connection-centre.mjs';
import { monitoredSync } from '../lib/scheduler.mjs';
import { createPacksmartServer } from '../server.mjs';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { createSessionToken } from '../lib/security.mjs';
import { fakeSupabase } from './fake-supabase.mjs';

const now = new Date('2026-10-07T12:00:00.000Z');
const recent = '2026-10-07T11:45:00.000Z';
const old = '2026-09-01T12:00:00.000Z';
const readiness = { oauthReady: true, refreshSupported: false };
function fixture() {
  const state = {
    connections: [{ provider: 'shopify', status: 'connected', encryptedCredentials: 'PRIVATE-CREDENTIAL', lastCheckedAt: old }],
    integrationStatus: { shopify: { status: 'connected', lastSuccessfulSyncAt: recent, areaSuccessAt: { products: recent, orders: recent } } },
    connectionSettings: { shopify: { autoSync: true, frequencyMinutes: 30, areas: ['products', 'orders'] } },
    connectionSyncs: [], audit: []
  };
  const channel = { id: 'shopify', name: 'Shopify', configured: true, settings: connectionSettings(state, 'shopify'),
    history: [], lastSuccessfulSyncAt: recent, lastCheckedAt: old, accessExpiresAt: null };
  return { state, channel, health: (options = {}) => connectionHealth(state, channel, { ...readiness, ...options }, { now }) };
}

test('automatic freshness uses only recorded selected-area completion within the existing warning window', () => {
  const { state, health } = fixture();
  assert.equal(health().status, 'Healthy');
  assert.equal(health().dataFreshness, 'current');
  assert.equal(health().freshnessEvidence.windowMinutes, 60);
  assert.equal(health().freshnessEvidence.selectedAreaEvidence, 'all_recorded');
  state.integrationStatus.shopify.areaSuccessAt.orders = '2026-10-07T11:00:00.000Z';
  assert.equal(health().dataFreshness, 'current', 'the existing strict greater-than boundary is preserved');
  state.integrationStatus.shopify.areaSuccessAt.orders = '2026-10-07T10:59:59.999Z';
  assert.equal(health().dataFreshness, 'stale');
  assert.equal(health().status, 'Attention needed');
  assert.equal(health().freshnessEvidence.areas.find(area => area.area === 'products').dataFreshness, 'current');
});

test('every supported automatic frequency uses its saved warning window', () => {
  for (const frequencyMinutes of [15, 30, 60, 180, 360, 1440]) {
    const { state, channel, health } = fixture();
    channel.settings.frequencyMinutes = frequencyMinutes;
    const windowMinutes = Math.max(frequencyMinutes * 2, 60);
    const boundary = now.getTime() - windowMinutes * 60000;
    state.integrationStatus.shopify.areaSuccessAt = { products: new Date(boundary).toISOString(), orders: recent };
    assert.equal(health().freshnessEvidence.windowMinutes, windowMinutes);
    assert.equal(health().dataFreshness, 'current');
    state.integrationStatus.shopify.areaSuccessAt.products = new Date(boundary - 1).toISOString();
    assert.equal(health().dataFreshness, 'stale');
  }
});

test('manual mode never calls an old successful read current or promises an automatic retry', () => {
  const { state, channel, health } = fixture();
  channel.settings.autoSync = false;
  channel.lastSuccessfulSyncAt = old;
  state.integrationStatus.shopify.areaSuccessAt = { products: old, orders: old };
  state.connectionDoctor = { shopify: { nextRetryAt: '2026-10-07T12:30:00.000Z' } };
  const result = health();
  assert.equal(result.status, 'Attention needed');
  assert.equal(result.dataFreshness, 'not_measured');
  assert.equal(result.freshnessEvidence.mode, 'manual');
  assert.equal(result.freshnessEvidence.windowMinutes, null);
  assert.equal(result.lastSuccessfulSyncAt, old);
  assert.equal(result.nextRetryAt, null);
  assert.match(result.message, /Automatic syncing is off/);
  state.integrationStatus.shopify.areaSuccessAt = { products: recent, orders: recent };
  assert.equal(health().dataFreshness, 'not_measured', 'recent manual reads are still not assessed against a schedule');
  for (const status of [{ lastError: 'CONNECTION_RATE_LIMITED' }, { upstreamStatus: 503 }, { transient: true }, { lastError: 'WORKER_INTERRUPTED' }]) {
    Object.assign(state.integrationStatus.shopify, { lastError: null, upstreamStatus: null, transient: false }, status);
    const failure = health();
    assert.match(failure.message, /retry manually/);
    assert.doesNotMatch(failure.message, /will retry|before retrying|will attempt|can resume/);
    assert.equal(failure.action.action, 'sync');
    assert.equal(failure.nextRetryAt, null);
  }
  channel.settings.autoSync = true;
  channel.settings.disconnected = true;
  assert.equal(health().status, 'Disconnected');
  assert.equal(health().dataFreshness, 'not_measured');
  assert.equal(health().nextRetryAt, null);
});

test('aggregate or completed-history timestamps do not invent full selected-area read evidence', () => {
  const { state, channel, health } = fixture();
  delete state.integrationStatus.shopify.areaSuccessAt;
  channel.history = [{ status: 'completed', completedAt: recent, areas: ['products'] }];
  let result = health();
  assert.equal(result.lastSuccessfulSyncAt, recent);
  assert.equal(result.dataFreshness, 'not_measured');
  assert.equal(result.freshnessEvidence.selectedAreaEvidence, 'none_recorded');
  assert.equal(result.status, 'Attention needed');
  state.integrationStatus.shopify.areaSuccessAt = { products: recent };
  result = health();
  assert.equal(result.dataFreshness, 'not_measured');
  assert.equal(result.freshnessEvidence.selectedAreaEvidence, 'some_recorded');
  assert.deepEqual(result.freshnessEvidence.areas.find(area => area.area === 'orders'), {
    area: 'orders', lastSuccessfulSyncAt: null, timestampStatus: 'missing', dataFreshness: 'not_measured'
  });
  assert.equal(result.fullReadCoverage, undefined);
});

test('the existing completion writer records selected successful areas and preserves unselected evidence', () => {
  const { state, channel } = fixture();
  state.integrationStatus.shopify.areaSuccessAt = { orders: old };
  const run = { id: 'selected-products', provider: 'shopify', areas: ['products'], actor: 'owner' };
  finishConnectionSync(state, run, { status: 'connected' });
  assert.equal(state.integrationStatus.shopify.areaSuccessAt.products, run.completedAt);
  assert.equal(state.integrationStatus.shopify.areaSuccessAt.orders, old);
  channel.lastSuccessfulSyncAt = run.completedAt;
  const result = connectionHealth(state, channel, readiness, { now: new Date(run.completedAt) });
  assert.equal(result.dataFreshness, 'stale', 'a products-only success cannot make orders current');
  assert.equal(result.freshnessEvidence.areas.find(area => area.area === 'orders').lastSuccessfulSyncAt, old);
  const before = structuredClone(state.integrationStatus.shopify.areaSuccessAt);
  finishConnectionSync(state, { ...run, areas: ['orders'] }, { status: 'degraded', lastError: 'PARTIAL_READ' });
  assert.deepEqual(state.integrationStatus.shopify.areaSuccessAt, before);
  finishConnectionSync(state, { ...run, areas: ['orders'] }, null, { code: 'READ_FAILED' });
  assert.deepEqual(state.integrationStatus.shopify.areaSuccessAt, before);
});

test('the monitored completion path preserves unselected evidence when adapters replace status', async () => {
  const { state } = fixture();
  state.integrationStatus.shopify.areaSuccessAt.orders = old;
  const integrations = { syncProvider: async current => {
    current.integrationStatus.shopify = { status: 'connected', lastError: null };
    return current.integrationStatus.shopify;
  } };
  await monitoredSync(state, integrations, 'shopify', { areas: ['products'], retry: false });
  const status = state.integrationStatus.shopify;
  assert.equal(status.areaSuccessAt.products, state.connectionSyncs[0].completedAt);
  assert.equal(status.areaSuccessAt.orders, old);
  assert.equal(status.lastSuccessfulSyncAt, state.connectionSyncs[0].completedAt);
});

test('missing, malformed and future read/check timestamps stay unknown and cannot leak raw values', () => {
  for (const [value, expected] of [[null, 'missing'], ['', 'missing'], ['PRIVATE-PROVIDER-PAYLOAD', 'invalid'], [123, 'invalid'], [true, 'invalid'],
    ['2026-10-07', 'invalid'], ['2026-10-07T11:00:00', 'invalid'], ['2026-10-07T11:00:00+24:00', 'invalid'],
    ['2026-02-30T12:00:00Z', 'invalid'], ['2026-10-07T24:00:00Z', 'invalid'], ['2026-10-07T12:00:00.001Z', 'future']]) {
    const { state, channel, health } = fixture();
    channel.lastSuccessfulSyncAt = channel.lastCheckedAt = value;
    state.connections[0].lastCheckedAt = value;
    state.integrationStatus.shopify.areaSuccessAt = { products: value, orders: value };
    const result = health();
    assert.equal(result.dataFreshness, 'not_measured');
    assert.equal(result.status, 'Attention needed');
    assert.equal(result.lastSuccessfulSyncAt, null);
    assert.equal(result.lastConnectionTestAt, null);
    assert.equal(result.authentication, 'not_verified');
    assert.equal(result.lastSuccessfulSyncEvidence.timestampStatus, expected);
    assert.equal(result.authenticationEvidence.timestampStatus, expected);
    assert.ok(result.freshnessEvidence.areas.every(area => area.timestampStatus === expected));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-PROVIDER-PAYLOAD/);
  }
});

test('valid timestamp offsets are compared as instants and normalized without changing freshness', () => {
  const { state, channel, health } = fixture();
  const at = '2026-10-07T13:45:00+02:00';
  channel.lastCheckedAt = channel.lastSuccessfulSyncAt = at;
  state.integrationStatus.shopify.areaSuccessAt = { products: at, orders: at };
  const result = health();
  assert.equal(result.lastSuccessfulSyncAt, recent);
  assert.equal(result.lastConnectionTestAt, recent);
  assert.equal(result.dataFreshness, 'current');
  assert.equal(result.authentication, 'not_verified');
});

test('historical successful identity checks remain separate from current authorization without inventing a TTL', () => {
  const { channel, health } = fixture();
  for (const at of [old, recent, now.toISOString()]) {
    channel.lastCheckedAt = at;
    const result = health();
    assert.equal(result.authentication, 'not_verified');
    assert.equal(result.lastConnectionTestAt, at);
    assert.deepEqual(result.authenticationEvidence, { source: 'connection_record', lastSuccessfulCheckAt: at, timestampStatus: 'valid', currentAccess: 'not_measured' });
    assert.doesNotMatch(result.message, /Access and the last completed read are healthy/);
  }
});

test('explicit authentication problems dominate previously successful checks and recent reads', () => {
  for (const failure of ['CONNECTION_AUTH_REQUIRED', 'ACCOUNT_MISMATCH', 'META_PERMISSION_REQUIRED']) {
    const { state, health } = fixture();
    state.integrationStatus.shopify.lastError = failure;
    const result = health();
    assert.equal(result.status, 'Reconnect required');
    assert.equal(result.authentication, 'attention');
    assert.equal(result.lastConnectionTestAt, old);
    assert.equal(result.dataFreshness, 'current', 'read age is independent of authorization');
  }
  for (const status of ['error', 'auth_expired', 'disconnected']) {
    const { state, health } = fixture();
    state.connections[0].status = status;
    assert.equal(health().authentication, 'attention');
    assert.notEqual(health().status, 'Healthy');
  }
});

test('separate authorization failures and expiry take precedence over temporary read failures and exhausted retries', () => {
  for (const savedFailure of [{ status: 'auth_expired' }, { lastError: 'CONNECTION_AUTH_REQUIRED' },
    { lastError: 'ACCOUNT_MISMATCH' }, { lastError: 'META_PERMISSION_REQUIRED' }]) {
    const { state, health } = fixture();
    Object.assign(state.connections[0], savedFailure);
    Object.assign(state.integrationStatus.shopify, { lastError: 'ETIMEDOUT', transient: true });
    state.connectionDoctor = { shopify: { exhausted: true } };
    const result = health();
    assert.equal(result.status, 'Reconnect required');
    assert.equal(result.authentication, 'attention');
    assert.equal(result.action.action, 'reconnect');
    assert.doesNotMatch(result.message, /will retry|Repeated safe retries/);
  }
  for (const expiry of [old, '2026-10-07T13:00:00Z']) {
    const { state, channel, health } = fixture();
    Object.assign(state.integrationStatus.shopify, { lastError: 'ETIMEDOUT', transient: true });
    state.connectionDoctor = { shopify: { exhausted: true } };
    channel.accessExpiresAt = expiry;
    assert.equal(health().status, 'Reconnect required');
    assert.equal(health().action.action, 'reconnect');
    assert.equal(health({ refreshSupported: true }).action.action, 'refresh');
  }
});

test('eBay health uses the same active Manager or OAuth record as the channel projection', () => {
  const { state } = fixture();
  const manager = { provider: 'ebay', encryptedCredentials: 'PRIVATE-MANAGER', status: 'connected', lastCheckedAt: recent };
  const oauth = { provider: 'ebay_oauth', encryptedCredentials: 'PRIVATE-OAUTH', status: 'auth_expired', lastError: 'CONNECTION_AUTH_REQUIRED', lastCheckedAt: old };
  state.connections = [manager, oauth];
  state.connectionSettings = { ebay: { areas: ['orders'], frequencyMinutes: 30, autoSync: true } };
  state.integrationStatus = { ebay: { status: 'connected', areaSuccessAt: { orders: recent } } };
  let active = manager;
  const integrations = { oauthReady: () => true, refreshSupported: () => false, connectionAccessExpiry: () => null,
    shopifyConfigured: () => false, ebayConfigured: () => true, ebayConnection: () => active };
  const health = () => intelligentConnections(state, integrations, { now }).find(channel => channel.id === 'ebay').health;
  assert.equal(health().status, 'Healthy');
  assert.equal(health().authentication, 'not_verified');
  assert.equal(health().lastConnectionTestAt, recent);
  active = oauth;
  assert.equal(health().status, 'Reconnect required');
  assert.equal(health().authentication, 'attention');
  assert.equal(health().lastConnectionTestAt, old);
  active = null;
  assert.equal(health().authentication, 'not_verified', 'no active record cannot resurrect an inactive OAuth failure');
  assert.equal(health().lastConnectionTestAt, null);
  assert.doesNotMatch(JSON.stringify(health()), /PRIVATE-MANAGER|PRIVATE-OAUTH/);
});

test('expiry distinguishes unknown, invalid, expired, expiring and future validity without promising renewal', () => {
  const { channel, health } = fixture();
  for (const [at, status, timestampStatus] of [[null, 'unknown', 'missing'], ['PRIVATE-EXPIRY', 'unknown', 'invalid'],
    [old, 'expired', 'valid'], [now.toISOString(), 'expired', 'valid'],
    ['2026-10-07T13:00:00Z', 'expiring', 'valid'], ['2026-10-08T12:00:00Z', 'not_expiring', 'valid']]) {
    channel.accessExpiresAt = at;
    const result = health();
    assert.equal(result.accessExpiry, status);
    assert.equal(result.expiryEvidence.timestampStatus, timestampStatus);
    if (status === 'unknown') assert.equal(result.accessExpiresAt, null);
    if (status === 'expired' || status === 'expiring') {
      assert.equal(result.status, 'Reconnect required');
      const renewable = health({ refreshSupported: true });
      assert.equal(renewable.status, 'Attention needed');
      assert.equal(renewable.action.action, 'refresh');
      assert.doesNotMatch(renewable.message, /will attempt|will renew|will retry/);
    }
    if (status === 'expired') assert.equal(result.authentication, 'attention');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-EXPIRY/);
  }
});

test('no selected areas or unsupported schedules cannot produce current freshness', () => {
  const { channel, health } = fixture();
  for (const frequencyMinutes of [0, -1, 17, '30', NaN]) {
    channel.settings.frequencyMinutes = frequencyMinutes;
    assert.equal(health().dataFreshness, 'not_measured');
    assert.equal(health().freshnessEvidence.windowMinutes, null);
  }
  channel.settings.frequencyMinutes = 30;
  channel.settings.areas = [];
  assert.equal(health().dataFreshness, 'not_measured');
  assert.equal(health().freshnessEvidence.selectedAreaEvidence, 'none_recorded');
});

test('health projections are bounded, tenant local, read-only and make no provider or timer calls', () => {
  const { state } = fixture();
  state.integrationStatus.shopify.areaSuccessAt['PRIVATE-UNSUPPORTED-AREA'] = recent;
  state.integrationStatus.shopify.areaSuccessAt.inventory = recent;
  state.connections[0].metadata = { secret: 'PRIVATE-METADATA' };
  const before = structuredClone(state);
  const integrations = new Proxy({ oauthReady: () => true, refreshSupported: () => false, connectionAccessExpiry: () => null,
    shopifyConfigured: () => true, ebayConfigured: () => false, ebayConnection: () => null }, {
    get(target, key) { assert.ok(Object.hasOwn(target, key), `Unexpected service access: ${String(key)}`); return target[key]; }
  });
  const originalFetch = globalThis.fetch, originalTimeout = globalThis.setTimeout, originalInterval = globalThis.setInterval;
  const forbidden = () => assert.fail('Health must not call providers or schedule work');
  let channels;
  try {
    globalThis.fetch = globalThis.setTimeout = globalThis.setInterval = forbidden;
    channels = intelligentConnections(state, integrations, { now });
  } finally {
    globalThis.fetch = originalFetch; globalThis.setTimeout = originalTimeout; globalThis.setInterval = originalInterval;
  }
  assert.deepEqual(state, before);
  const result = channels.find(channel => channel.id === 'shopify').health;
  assert.equal(result.freshnessEvidence.areas.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-CREDENTIAL|PRIVATE-METADATA|PRIVATE-UNSUPPORTED-AREA/);
  assert.equal(result.webhookHealth, 'not_monitored');
  assert.equal(result.apiHealth, undefined);
  assert.equal(result.score, undefined);
  const empty = fixture();
  delete empty.state.integrationStatus.shopify.areaSuccessAt;
  assert.equal(empty.health().dataFreshness, 'not_measured', 'another tenant receives no evidence from this one');
});

test('authenticated saved health stays tenant-local and no-store with only the existing state read', async t => {
  const secret='connection-health-api-test-secret-more-than-thirty-two-characters';
  const observedAt=new Date(Date.now()-60_000).toISOString(),staleAt=new Date(Date.now()-3*3600_000).toISOString();
  const states=['health-alpha','health-beta'].map(workspaceId=>{
    const state=seedWorkspaceState({}, {workspaceId,email:`${workspaceId}@example.test`,passwordHash:'synthetic-only'});
    state._revision='stored-health-revision';state.users[0].passwordChangeRequired=false;
    state.connections=[{id:`${workspaceId}-shopify`,provider:'shopify',status:'connected',encryptedCredentials:'PRIVATE-SAVED-CREDENTIAL',lastCheckedAt:observedAt,
      metadata:{shopDomain:`${workspaceId}.myshopify.com`,grantedScopes:['read_products','read_orders']}}];
    state.connectionSettings={shopify:{autoSync:true,frequencyMinutes:30,areas:['products','orders']}};
    state.integrationStatus.shopify={status:'connected',lastSuccessfulSyncAt:observedAt,
      areaSuccessAt:{products:observedAt,orders:workspaceId==='health-alpha'?staleAt:observedAt}};
    return state;
  });
  const database=fakeSupabase({initialStates:states});
  const store=createStore({SUPABASE_URL:'https://health-fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-only'}, {fetchImpl:database.fetchImpl});
  store.integrityCheck=undefined; // Exclude the pre-existing startup integrity task.
  let providerCalls=0;
  const integrations={oauthReady:provider=>provider==='shopify',refreshSupported:()=>false,connectionAccessExpiry:()=>null,
    shopifyConfigured:()=>true,ebayConfigured:()=>false,ebayConnection:()=>null};
  const server=createPacksmartServer({NODE_ENV:'test',SESSION_SECRET:secret,SHOPIFY_PUBLIC_SYNC_ENABLED:'false'}, {
    store,integrations,schedulerEnabled:false,agentOpsEnabled:false,fetchImpl:async()=>{providerCalls++;assert.fail('Saved health must not contact a provider');}
  });
  t.after(async()=>{await server.packsmart.drain();if(server.listening)await new Promise(resolve=>server.close(resolve));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const preserved=structuredClone([...database.states]);
  const assertPrivate=response=>{assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('etag'),null);};
  const asset=await fetch(base+'/app.js');assert.equal(asset.status,200);
  const publicEtag=asset.headers.get('etag');assert.ok(publicEtag);
  const anonymous=await fetch(base+'/api/connection-centre',{headers:{'If-None-Match':'*'}});
  assert.equal(anonymous.status,401);assertPrivate(anonymous);assert.equal(database.calls.length,0);
  for(const state of states)for(const validator of ['*',publicEtag]){
    const workspaceId=state.workspace.id,other=workspaceId==='health-alpha'?'health-beta':'health-alpha';
    const token=createSessionToken({workspaceId,userId:state.users[0].id,email:state.users[0].email,role:'owner',sessionVersion:1},secret);
    const beforeCalls=database.calls.length;
    const response=await fetch(base+`/api/connection-centre?workspaceId=${other}`,{headers:{Cookie:`packsmart_session=${token}`,'If-None-Match':validator}});
    assert.equal(response.status,200);assertPrivate(response);
    assert.equal(database.calls.length-beforeCalls,1);
    assert.equal(database.calls.at(-1).url.searchParams.get('workspace_id'),`eq.${workspaceId}`);
    const payload=await response.json(),channel=payload.channels.find(row=>row.id==='shopify');
    assert.equal(channel.identity,`${workspaceId}.myshopify.com`);
    assert.equal(channel.health.dataFreshness,workspaceId==='health-alpha'?'stale':'current');
    assert.equal(channel.health.status,workspaceId==='health-alpha'?'Attention needed':'Healthy');
    assert.equal(channel.health.authentication,'not_verified');
    assert.equal(channel.health.authenticationEvidence.currentAccess,'not_measured');
    assert.equal(channel.health.lastConnectionTestAt,observedAt);
    assert.doesNotMatch(JSON.stringify(payload),/PRIVATE-SAVED-CREDENTIAL/);
    assert.equal(JSON.stringify(payload).includes(`${other}.myshopify.com`),false);
    const activity=store.activitySnapshot(workspaceId);
    assert.equal(activity.db.attempted,validator==='*'?1:2);assert.equal(activity.db.operations.state_read,activity.db.attempted);
    assert.equal(activity.db.operations.state_commit,0);assert.equal(activity.db.operations.reporting_commit,0);
    assert.equal(activity.hotState.attempted.observations,0);assert.equal(activity.hotState.confirmed.observations,0);
    if(workspaceId==='health-beta'&&validator===publicEtag){
      store.primaryPersistenceHealthy=false;
      const failedPersistence=await fetch(base+'/api/connection-centre',{headers:{Cookie:`packsmart_session=${token}`,'If-None-Match':'*'}});
      assert.equal(failedPersistence.status,200);assertPrivate(failedPersistence);
      const health=(await failedPersistence.json()).channels.find(row=>row.id==='shopify').health;
      assert.equal(health.status,'Degraded');assert.equal(health.persistenceHealth,'degraded');
      assert.equal(health.dataFreshness,'current','saved read age cannot erase separate persistence failure evidence');
      assert.equal(store.primaryPersistenceHealthy,false,'reading health never repairs the primary-health flag');
    }
  }
  assert.equal(database.calls.length,5);assert.ok(database.calls.every(call=>call.method==='GET'));
  for(const [workspaceId,expectedReads]of[['health-alpha',2],['health-beta',3]]){
    const observed=store.activitySnapshot(workspaceId);
    assert.equal(observed.db.attempted,expectedReads);assert.equal(observed.db.operations.state_read,expectedReads);
    assert.equal(observed.db.operations.state_commit,0);assert.equal(observed.db.operations.reporting_commit,0);
    assert.equal(observed.hotState.attempted.observations,0);assert.equal(observed.hotState.confirmed.observations,0);
  }
  assert.deepEqual([...database.states],preserved);assert.equal(providerCalls,0);
});
