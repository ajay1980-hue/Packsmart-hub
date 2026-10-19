import test from 'node:test';
import assert from 'node:assert/strict';
import { seedWorkspaceState } from '../lib/store.mjs';
import { ensureControl } from '../lib/control.mjs';
import { createScheduler } from '../lib/scheduler.mjs';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const STOPPED = { skipped: true, reason: 'SCHEDULER_STOPPED' };
const SETTLED = { settled: true, errors: 0, lastError: null };
const noEffects = () => ({ providerReads: 0, submissionAttempts: 0, confirmedSubmissions: 0,
  uncertainSubmissions: 0, blockedSubmissions: 0, historicalExposureUnknown: false,
  externalWrites: false, spend: 0, costStatus: 'not_incurred' });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function assertPending(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'drain must await the blocked operation');
}

function fixture(t, { store: overrides = {}, withWorkspaceLock = async (_id, action) => action(),
  creativeCycle, enabled = false, rules = ['marketingCreativeWorker'], integrations = {} } = {}) {
  const state = seedWorkspaceState({}, { workspaceId: 'scheduler-lifecycle' });
  ensureControl(state);
  state.marketing.campaigns = [{ id: 'eligible-lifecycle-fixture', status: 'draft', creativeRequests: [{ provider: 'runway', status: 'pending' }] }];
  state.autopilot.enabled = true;
  for (const key of Object.keys(state.automations)) state.automations[key] = rules.includes(key);
  const events = [], saved = [];
  const store = { provider: 'supabase', listWorkspaceIds: async () => { events.push('list'); return [state.workspace.id]; },
    get: async () => { events.push('get'); return state; },
    save: async (_id, value) => { events.push('save'); saved.push(structuredClone(value)); }, ...overrides };
  const scheduler = createScheduler({ store, withWorkspaceLock, integrations, enabled, env: {}, intervalMs: 60000,
    currentBrief: () => ({ id: 'brief', summary: 'Recorded summary' }),
    creativeCycle: async (...args) => {
      events.push('provider');
      return creativeCycle ? creativeCycle(...args) : { advanced: 0, effects: noEffects() };
    } });
  t.after(() => scheduler.stop());
  return { state, events, saved, store, scheduler,
    run: (options = {}) => scheduler.runWorkspace(state.workspace.id, { now: NOW, ...options }) };
}

test.beforeEach(t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Lifecycle tests cannot make live provider calls'));
});

test('unavailable full eBay comparison remains a recorded block without claiming OAuth or monitor failure', async t => {
  const f = fixture(t, { rules: ['channelMismatchAlerts'] });
  f.state.ebay = { source: 'ebay-oauth-readonly', coverage: { catalogueScope: 'inventory_api_only', fullCatalogueAvailable: false }, health: null };
  const result = await f.run({ manual: true });
  const run = result.runs.find(row => row.ruleId === 'channelMismatchAlerts');
  assert.equal(run.status, 'BLOCKED');
  assert.equal(run.errorCode, 'COVERAGE_UNAVAILABLE');
  assert.equal(run.reason, 'COVERAGE_UNAVAILABLE');
  assert.equal(run.evidence[0].type, 'channel_coverage');
  assert.equal(run.evidence[0].available, false);
  assert.equal(f.events.filter(event => event === 'provider').length, 0);
  assert.equal(f.saved.length, 2, 'claim and terminal evidence remain durable');
  assert.ok(f.state.audit.some(row => row.type === 'automation_finished'));
  assert.deepEqual(await f.run({ manual: true }), { skipped: true, reason: 'FREQUENCY_OR_PERMISSION_LIMIT' });
});

for (const outcome of ['completed','partial','failed']) {
  test(`channel sync records ${outcome} separately from connection state without changing admission or history`, async t => {
    const calls=[];
    const f=fixture(t,{rules:['channelSync'],integrations:{
      shopifyRefreshAvailable:()=>true,ebayConfigured:()=>true,
      syncProvider:async (_state,provider)=>{
        calls.push(provider);
        assert.equal(f.saved[0].automationRuns[0].status,'IN PROGRESS');
        if(provider==='ebay' && outcome==='failed') throw Object.assign(new Error('private upstream response'),{code:'AUTH_EXPIRED'});
        return {status:'connected',lastError:provider==='ebay' && outcome==='partial'?'EBAY_PARTIAL_READ':null};
      }
    }});
    f.state.connections=[{provider:'meta',encryptedCredentials:'synthetic-fixture-only'}];
    const historical={id:'historical-sync',ruleId:'channelSync',status:'BLOCKED',errorCode:'SOURCE_COVERAGE_INCOMPLETE',startedAt:'2026-10-01T00:00:00.000Z',completedAt:'2026-10-01T00:01:00.000Z',evidence:[{type:'integration_read',id:'ebay',detail:'connected'}]};
    f.state.automationRuns=[structuredClone(historical)];
    const result=await f.run({manual:true}),run=result.runs.find(row=>row.ruleId==='channelSync');
    assert.deepEqual(calls.sort(),['ebay','meta','shopify']);
    assert.equal(f.saved.length,2,'only the existing claim and terminal saves');
    assert.equal(run.status,outcome==='completed'?'COMPLETED':'BLOCKED');
    assert.equal(run.errorCode,outcome==='partial'?'SOURCE_COVERAGE_INCOMPLETE':outcome==='failed'?'AUTH_EXPIRED':null);
    const ebay=run.evidence.find(row=>row.id==='ebay');
    assert.equal(ebay.outcome,outcome);
    assert.equal(ebay.connectionStatus,outcome==='failed'?null:'connected');
    assert.equal(ebay.errorCode,outcome==='partial'?'EBAY_PARTIAL_READ':outcome==='failed'?'AUTH_EXPIRED':null);
    assert.match(ebay.detail,new RegExp('Sync '+outcome));
    for(const provider of ['shopify','meta']) assert.equal(run.evidence.find(row=>row.id===provider).outcome,'completed');
    assert.equal(f.state.connectionSyncs.find(row=>row.provider==='ebay').status,outcome);
    assert.ok(f.state.audit.some(row=>row.type==='connection_sync_finished' && row.detail.provider==='ebay' && row.detail.status===outcome));
    assert.deepEqual(f.state.automationRuns.find(row=>row.id===historical.id),historical);
    assert.doesNotMatch(JSON.stringify(run.evidence),/private upstream response/);
    assert.deepEqual(await f.run({manual:true}),{skipped:true,reason:'FREQUENCY_OR_PERMISSION_LIMIT'});
    assert.equal(calls.length,3,'no extra provider retries from reporting');
  });
}

test('manual work remains available without starting the background scheduler and respects frequency', async t => {
  const f = fixture(t);
  const result = await f.run({ manual: true });
  assert.equal(result.skipped, false);
  assert.equal(result.runs[0].status, 'COMPLETED');
  assert.deepEqual(f.events, ['get', 'save', 'provider', 'save']);
  assert.deepEqual(await f.run({ manual: true }), { skipped: true, reason: 'FREQUENCY_OR_PERMISSION_LIMIT' });
  assert.equal(f.events.filter(event => event === 'provider').length, 1);
  assert.deepEqual(await f.scheduler.drain(), SETTLED);
});

test('drain closes all admissions immediately, is terminal and returns the same promise', async t => {
  const f = fixture(t, { enabled: true });
  const drain = f.scheduler.drain();
  assert.equal(f.scheduler.drain(), drain);
  f.scheduler.stop();
  f.scheduler.start();
  f.scheduler.start();
  assert.deepEqual(await f.run({ manual: true }), STOPPED);
  await f.scheduler.tick();
  assert.deepEqual(await drain, SETTLED);
  f.scheduler.start();
  await f.scheduler.tick();
  assert.deepEqual(f.events, []);
  assert.equal(f.scheduler.status.running, false);
  assert.equal(f.scheduler.drain(), drain);
});

test('a same-turn drain registers queued calls but prevents their dependencies from starting', async t => {
  const f = fixture(t);
  const tick = f.scheduler.tick();
  const manual = f.run({ manual: true });
  const drain = f.scheduler.drain();
  assert.deepEqual(await manual, STOPPED);
  await tick;
  assert.deepEqual(await drain, SETTLED);
  assert.deepEqual(f.events, []);
  assert.equal(f.scheduler.status.running, false);
});

test('start and stop keep one interval, and an already-queued timer callback cannot reopen a drained scheduler', async t => {
  const timers = [], cleared = [];
  t.mock.method(globalThis, 'setInterval', callback => {
    const timer = { callback, unref() {} };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearInterval', timer => { if (timer) cleared.push(timer); });
  const f = fixture(t, { enabled: true, store: { listWorkspaceIds: async () => [] } });
  f.scheduler.start();
  f.scheduler.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.length, 1);
  f.scheduler.stop();
  f.scheduler.stop();
  assert.deepEqual(cleared, [timers[0]]);
  f.scheduler.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.length, 2);
  assert.deepEqual(await f.scheduler.drain(), SETTLED);
  for (const timer of timers) timer.callback();
  f.scheduler.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.length, 2);
  assert.deepEqual(cleared, timers);
  assert.deepEqual(f.events, []);
  assert.equal(f.scheduler.status.running, false);
});

test('a cleared interval callback cannot admit a tick after ordinary stop and restart', async t => {
  const timers = [];
  t.mock.method(globalThis, 'setInterval', callback => {
    const timer = { callback, unref() {} };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearInterval', () => {});
  let lists = 0;
  const f = fixture(t, { enabled: true, store: { listWorkspaceIds: async () => { lists++; return []; } } });
  f.scheduler.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lists, 1);
  f.scheduler.stop();
  f.scheduler.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lists, 2);
  assert.equal(f.scheduler.status.running, false);
  timers[0].callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lists, 2, 'the old interval belongs to a stopped generation');
  timers[1].callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lists, 3, 'the current interval still admits normal ticks');
  assert.deepEqual(await f.scheduler.drain(), SETTLED);
});

test('drain waits for workspace listing and does not admit its eventual IDs', async t => {
  const entered = deferred(), listing = deferred();
  const f = fixture(t, { store: { listWorkspaceIds: () => { entered.resolve(); return listing.promise; } } });
  const tick = f.scheduler.tick();
  await entered.promise;
  f.scheduler.stop();
  const drain = f.scheduler.drain();
  await assertPending(drain);
  assert.equal(f.scheduler.status.running, true);
  listing.resolve([f.state.workspace.id]);
  await tick;
  assert.deepEqual(await drain, SETTLED);
  assert.deepEqual(f.events, []);
  assert.equal(f.scheduler.status.running, false);
});

test('listing failures settle drain with a safe error code and retain background status', async t => {
  const entered = deferred(), listing = deferred();
  const f = fixture(t, { store: { listWorkspaceIds: () => { entered.resolve(); return listing.promise; } } });
  const tick = f.scheduler.tick();
  await entered.promise;
  const drain = f.scheduler.drain();
  listing.reject(Object.assign(new Error('private response'), { code: 'SUPABASE_UNAVAILABLE' }));
  await tick;
  assert.deepEqual(await drain, { settled: true, errors: 1, lastError: 'SUPABASE_UNAVAILABLE' });
  assert.equal(f.scheduler.status.lastError, 'SUPABASE_UNAVAILABLE');
  assert.deepEqual(f.events, []);
});

test('reentrant shutdown inside a synchronous listing dependency still waits for that listing', async t => {
  const entered = deferred(), listing = deferred();
  let drain;
  const f = fixture(t, { store: { listWorkspaceIds: () => {
    drain = f.scheduler.drain();
    entered.resolve();
    return listing.promise;
  } } });
  const tick = f.scheduler.tick();
  await entered.promise;
  await assertPending(drain);
  listing.resolve([f.state.workspace.id]);
  await tick;
  assert.deepEqual(await drain, SETTLED);
  assert.deepEqual(f.events, []);
});

test('a workspace queued on its lock cannot read state or dispatch providers after drain', async t => {
  const entered = deferred(), lock = deferred();
  const f = fixture(t, { withWorkspaceLock: async (_id, action) => {
    entered.resolve();
    await lock.promise;
    return action();
  } });
  const run = f.run({ manual: true });
  await entered.promise;
  const drain = f.scheduler.drain();
  await assertPending(drain);
  lock.resolve();
  assert.deepEqual(await run, STOPPED);
  assert.deepEqual(await drain, SETTLED);
  assert.deepEqual(f.events, []);
});

test('a state read admitted before drain may settle without starting Doctor or claiming work', async t => {
  const entered = deferred(), read = deferred();
  const f = fixture(t, { store: {
    get: () => assert.fail('getForScheduler must remain preferred'),
    getForScheduler: () => { entered.resolve(); return read.promise; }
  } });
  const initial = structuredClone(f.state);
  const run = f.run();
  await entered.promise;
  const drain = f.scheduler.drain();
  await assertPending(drain);
  read.resolve(f.state);
  assert.deepEqual(await run, STOPPED);
  assert.deepEqual(await drain, SETTLED);
  assert.deepEqual(f.state, initial);
  assert.deepEqual(f.events, []);
});

test('ordinary stop/start admits new work without reviving an earlier pending listing', async t => {
  const entered = deferred(), listing = deferred();
  let calls = 0;
  const f = fixture(t, { enabled: true, store: { listWorkspaceIds: () => {
    calls++;
    if (calls === 1) { entered.resolve(); return listing.promise; }
    return [];
  } } });
  f.scheduler.start();
  f.scheduler.start();
  await entered.promise;
  f.scheduler.stop();
  f.scheduler.stop();
  assert.deepEqual(await f.run({ manual: true }), STOPPED);
  f.scheduler.start();
  listing.resolve([f.state.workspace.id]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.events, []);
  await f.scheduler.tick();
  assert.equal(calls, 2);
  assert.equal((await f.run({ manual: true })).skipped, false);
  assert.equal(f.events.filter(event => event === 'provider').length, 1);
});

test('ordinary restart cannot revive workspace work queued before stop', async t => {
  const entered = deferred(), lock = deferred();
  let locks = 0;
  const f = fixture(t, { enabled: true, store: { listWorkspaceIds: async () => [] },
    withWorkspaceLock: async (_id, action) => {
      if (++locks === 1) { entered.resolve(); await lock.promise; }
      return action();
    } });
  const oldRun = f.run();
  await entered.promise;
  f.scheduler.stop();
  f.scheduler.start();
  lock.resolve();
  assert.deepEqual(await oldRun, STOPPED);
  assert.deepEqual(f.events, []);
  assert.equal((await f.run()).skipped, false);
  assert.deepEqual(await f.scheduler.drain(), SETTLED);
});

test('a started cycle drains its pending claim, provider work and final save in existing order', async t => {
  const claimed = deferred(), claim = deferred(), finishing = deferred(), final = deferred();
  let saves = 0;
  const f = fixture(t, { store: { save: async (_id, state) => {
    if (++saves === 1) { assert.equal(state.automationRuns[0].status, 'IN PROGRESS'); claimed.resolve(); await claim.promise; }
    else { assert.equal(state.automationRuns[0].status, 'COMPLETED'); finishing.resolve(); await final.promise; }
  } } });
  const run = f.run();
  await claimed.promise;
  f.scheduler.stop();
  const drain = f.scheduler.drain();
  await assertPending(drain);
  assert.deepEqual(f.events, ['get']);
  claim.resolve();
  await finishing.promise;
  assert.deepEqual(f.events, ['get', 'provider']);
  await assertPending(drain);
  final.resolve();
  assert.equal((await run).runs[0].status, 'COMPLETED');
  assert.deepEqual(await drain, SETTLED);
  assert.equal(saves, 2);
});

for (const uncertain of [false, true]) {
  test(`drain retains ${uncertain ? 'uncertain' : 'confirmed'} provider evidence and known upstream IDs through the final save`, async t => {
    const entered = deferred(), provider = deferred(), finishing = deferred(), final = deferred();
    const effects = { ...noEffects(), submissionAttempts: 1, confirmedSubmissions: uncertain ? 0 : 1,
      uncertainSubmissions: uncertain ? 1 : 0, externalWrites: uncertain ? null : true, spend: null, costStatus: 'unknown' };
    let saves = 0, persisted;
    const f = fixture(t, {
      creativeCycle: async state => {
        state.marketing.campaigns = [{ id: 'existing-campaign', creativeRequests: [{ provider: 'runway', taskId: 'known-upstream-task', status: 'in_progress' }] }];
        entered.resolve();
        await provider.promise;
        return { advanced: uncertain ? 0 : 1, effects };
      },
      store: { save: async (_id, state) => {
        if (++saves === 2) { persisted = structuredClone(state); finishing.resolve(); await final.promise; }
      } }
    });
    const run = f.run();
    await entered.promise;
    const drain = f.scheduler.drain();
    await assertPending(drain);
    provider.resolve();
    await finishing.promise;
    await assertPending(drain);
    assert.deepEqual(persisted.automationRuns[0].effects, effects);
    assert.equal(persisted.automationRuns[0].status, uncertain ? 'BLOCKED' : 'COMPLETED');
    assert.equal(persisted.marketing.campaigns[0].creativeRequests[0].taskId, 'known-upstream-task');
    final.resolve();
    assert.deepEqual((await run).effects, effects);
    assert.deepEqual(await drain, SETTLED);
  });
}

test('a rejected final save remains rejected to its caller while drain waits for other pending saves', async t => {
  const entered = deferred(), rejectedSave = deferred(), pendingSave = deferred();
  const saveCounts = new Map();
  let finals = 0;
  const f = fixture(t, { store: {
    get: async id => {
      const state = structuredClone(f.state);
      state.workspace.id = id;
      return state;
    },
    save: async (id) => {
      saveCounts.set(id, (saveCounts.get(id) || 0) + 1);
      if (saveCounts.get(id) === 2) {
        if (++finals === 2) entered.resolve();
        await (id === 'first' ? rejectedSave.promise : pendingSave.promise);
      }
    }
  } });
  const first = f.scheduler.runWorkspace('first', { now: NOW });
  const second = f.scheduler.runWorkspace('second', { now: NOW });
  const failure = Object.assign(new Error('private database response'), { code: 'PERSISTENCE_FAILED' });
  const rejection = assert.rejects(first, error => error === failure);
  await entered.promise;
  const drain = f.scheduler.drain();
  rejectedSave.reject(failure);
  await rejection;
  await assertPending(drain);
  pendingSave.resolve();
  assert.equal((await second).skipped, false);
  assert.deepEqual(await drain, { settled: true, errors: 1, lastError: 'PERSISTENCE_FAILED' });
  assert.equal(f.events.filter(event => event === 'provider').length, 2);
});

test('a rejected claim cannot dispatch a provider and is reported once by a draining background tick', async t => {
  const entered = deferred(), claim = deferred();
  t.mock.method(console, 'error', () => {});
  const f = fixture(t, { store: { save: () => { entered.resolve(); return claim.promise; } } });
  const tick = f.scheduler.tick();
  await entered.promise;
  const drain = f.scheduler.drain();
  claim.reject(Object.assign(new Error('private response'), { code: 'unsafe lower-case response' }));
  await tick;
  assert.deepEqual(await drain, { settled: true, errors: 1, lastError: 'READ_FAILED' });
  assert.equal(f.scheduler.status.lastError, 'READ_FAILED');
  assert.deepEqual(f.events, ['list', 'get']);
  assert.equal(f.state.automationRuns[0].status, 'IN PROGRESS');
  assert.equal(f.state.automationRuns[0].effects.costStatus, 'unknown');
});
