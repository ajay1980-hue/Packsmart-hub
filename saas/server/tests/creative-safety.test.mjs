import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createCreativeEffects, createCreativeLifecycle, creativeDigest, newCreativeRequest } from '../lib/creative-safety.mjs';
import { advanceCampaignCreatives, startCanvaCreative, startRunwayCreative } from '../lib/marketing-providers.mjs';
import { ensureMarketing, marketingCreativeCycle } from '../lib/marketing.mjs';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { encryptCredentials } from '../lib/security.mjs';

const CONFIG = { RUNWAY_API_KEY: 'test-only-key-never-store', CANVA_ACCESS_TOKEN: 'test-only-token-never-store', CANVA_BRAND_TEMPLATE_ID: 'test-template' };
const NOW = Date.parse('2026-10-06T20:00:00.000Z');
const json = (value, status = 200) => Response.json(value, { status });
function fixture({ provider = 'runway', legacy = false } = {}) {
  const state = { workspace: { id: 'creative-test' }, _revision: 'revision-1', marketing: { settings: {}, providers: {}, campaigns: [] } };
  const campaign = { id: 'campaign_test', status: 'draft', product: { title: 'Synthetic packaging', sku: 'SKU-TEST', image: 'https://cdn.shopify.com/test.jpg', price: 10 },
    copy: { headline: 'Synthetic creative prompt' }, publish: { status: 'not_requested', approvalRequired: true }, creativeRequests: [] };
  const request = legacy ? { provider, status: 'pending', kind: provider === 'canva' ? 'social_post' : 'product_video' }
    : newCreativeRequest({ workspaceId: state.workspace.id, campaignId: campaign.id, provider, kind: provider === 'canva' ? 'social_post' : 'product_video', formats: [], now: () => NOW });
  campaign.creativeRequests.push(request); state.marketing.campaigns.push(campaign); ensureMarketing(state);
  return { state, campaign, request };
}
function database(initial, hook) {
  let saved = structuredClone(initial), count = 0;
  return { read: () => structuredClone(saved), count: () => count,
    save: local => async () => {
      count++;
      if (local._revision !== saved._revision) throw Object.assign(new Error('conflict'), { code: 'STATE_CONFLICT' });
      if (hook?.(count, 'before')) throw Object.assign(new Error('offline'), { code: 'SUPABASE_PERSISTENCE_FAILED' });
      local._revision = `revision-${count + 1}`; saved = structuredClone(local);
      if (hook?.(count, 'after')) throw Object.assign(new Error('lost acknowledgement'), { code: 'SUPABASE_PERSISTENCE_FAILED' });
      return structuredClone(saved);
    }
  };
}
// This models a FUTURE trusted approval+reservation service for protocol tests.
// It is never installed by production routes and creates no user permission.
const syntheticAllowance = async binding => ({ allowed: true, ...binding, approvalId: 'synthetic_approval', approvalRevision: 1,
  reservationId: 'synthetic_reservation', policyRevision: 'synthetic_policy', currency: 'USD', maxCostMicros: 10000,
  verifiedUpperBound: true, expiresAt: '2026-10-06T21:00:00.000Z' });
function lifecycle(f, db, extra = {}) {
  return createCreativeLifecycle({ ...f, persist: db.save(f.state), durableStore: true, authorizePhase: syntheticAllowance, now: () => NOW, ...extra });
}
function phase(submit, extra = {}) {
  return { phase: 'generation', endpoint: 'https://api.dev.runwayml.com/v1/recipes/product_ad', payloadDigest: creativeDigest('exact synthetic payload'),
    accountBinding: creativeDigest('synthetic account'), sourceDigest: creativeDigest('synthetic source'),
    checkBinding: () => ({ payloadDigest: creativeDigest('exact synthetic payload'), accountBinding: creativeDigest('synthetic account'), sourceDigest: creativeDigest('synthetic source') }), submit,
    accepted: value => ({ provider: 'runway', status: 'in_progress', stage: 'generation', taskId: value.id }), ...extra };
}

test('no setting, balance, publish approval, caller price or plain object can authorize a creative POST', async () => {
  for (const issuer of [undefined, { allowed: true }, async () => ({ allowed: true }), async binding => ({ ...await syntheticAllowance(binding), verifiedUpperBound: false }),
    async binding => ({ ...await syntheticAllowance(binding), maxCostMicros: null }), async binding => ({ ...await syntheticAllowance(binding), maxCostMicros: -1 }),
    async binding => ({ ...await syntheticAllowance(binding), workspaceId: 'another-tenant' }), async binding => ({ ...await syntheticAllowance(binding), expiresAt: '2020-01-01T00:00:00Z' })]) {
    const f = fixture(); f.state.marketing.settings = { autoCreative: true, allowPaidAds: false, mode: 'automatic', maxCostMicros: 999999 };
    f.campaign.publish = { approvalId: 'some-publish-approval', status: 'approved' }; f.state.marketing.providers.runway = { health: { creditBalance: 999999 } };
    const db = database(f.state), gate = lifecycle(f, db, { authorizePhase: issuer }); let posts = 0;
    const result = await gate.mutate(phase(async () => { posts++; return { id: 'never' }; }));
    assert.equal(result.code, 'CREATIVE_ALLOWANCE_REQUIRED'); assert.equal(posts, 0); assert.equal(db.count(), 0);
  }
  await assert.rejects(startRunwayCreative({}, CONFIG), { code: 'CREATIVE_ALLOWANCE_REQUIRED' });
  await assert.rejects(startCanvaCreative({}, CONFIG), { code: 'CREATIVE_ALLOWANCE_REQUIRED' });
  const fakeLifecycle = { safety: { phases: {}, origin: 'server_created' }, canAuthorize: true, mutate: ({ submit }) => submit() };
  await assert.rejects(startRunwayCreative({ product: { image: 'https://example.test/image.png' } }, CONFIG,
    { lifecycle: fakeLifecycle, fetchImpl: () => assert.fail('Forged lifecycle must not reach HTTP') }), { code: 'CREATIVE_ALLOWANCE_REQUIRED' });
});

test('legacy pending provenance cannot become a new POST even with an allowance-shaped receipt', async () => {
  const f = fixture({ legacy: true }), db = database(f.state), gate = lifecycle(f, db);
  const result = await gate.mutate(phase(() => assert.fail('Legacy ambiguity must not dispatch')));
  assert.equal(result.code, 'CREATIVE_LEGACY_DISPATCH_UNVERIFIED'); assert.equal(gate.summary().spend, null);
});

test('real acknowledged durable persistence is mandatory before dispatch', async () => {
  for (const extra of [{ durableStore: false }, { persist: undefined }, { persist: async () => undefined }]) {
    const f = fixture(), db = database(f.state), gate = lifecycle(f, db, extra); let posts = 0;
    const operation = gate.mutate(phase(async () => { posts++; return { id: 'never' }; }));
    if (typeof extra.persist === 'function') await assert.rejects(operation, { code: 'CREATIVE_CLAIM_ACK_INVALID' });
    else assert.equal((await operation).code, 'CREATIVE_DURABLE_STORE_REQUIRED');
    assert.equal(posts, 0);
  }
});

test('two independent revision snapshots grant at most one dispatch and preserve the accepted ID', async () => {
  const base = fixture(), db = database(base.state); let posts = 0;
  const copies = [db.read(), db.read()].map(state => ({ state, campaign: state.marketing.campaigns[0], request: state.marketing.campaigns[0].creativeRequests[0] }));
  const results = await Promise.allSettled(copies.map(f => lifecycle(f, db).mutate(phase(async () => {
    posts++; assert.equal(db.read().marketing.campaigns[0].creativeRequests[0].safety.phases.generation.status, 'dispatching'); return { id: 'task_one' };
  }))));
  assert.equal(posts, 1); assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.find(value => value.status === 'rejected').reason.code, 'STATE_CONFLICT');
  assert.equal(db.read().marketing.campaigns[0].creativeRequests[0].taskId, 'task_one');
});

test('concurrent callers sharing one request recheck the phase after asynchronous allowance resolution', async () => {
  const f = fixture(), db = database(f.state); let release, authorizations = 0, posts = 0;
  const barrier = new Promise(resolve => { release = resolve; });
  const authorizePhase = async binding => { authorizations++; await barrier; return syntheticAllowance(binding); };
  const first = lifecycle(f, db, { authorizePhase }), second = lifecycle(f, db, { authorizePhase });
  const action = phase(async () => { posts++; return { id: 'one_task' }; });
  const pending = [first.mutate(action), second.mutate(action)];
  assert.equal(authorizations, 2); release();
  const results = await Promise.all(pending);
  assert.equal(posts, 1); assert.equal(results.filter(value => value.accepted).length, 1);
  assert.equal(results.find(value => value.blocked).code, 'CREATIVE_SUBMISSION_ALREADY_CLAIMED');
  assert.equal(db.read().marketing.campaigns[0].creativeRequests[0].taskId, 'one_task');
});

test('a successful save acknowledgement must contain this exact immutable phase claim', async () => {
  const f = fixture(), db = database(f.state); const realSave = db.save(f.state); let posts = 0;
  const persist = async () => { const saved = await realSave(); saved.marketing.campaigns[0].creativeRequests[0].safety.phases.generation.id = 'another_claim'; return saved; };
  await assert.rejects(lifecycle(f, db, { persist }).mutate(phase(async () => { posts++; return { id: 'never' }; })), { code: 'CREATIVE_CLAIM_ACK_INVALID' });
  assert.equal(posts, 0);
});

test('expiry during acknowledged persistence blocks the HTTP call and does not release or reopen its durable intent', async () => {
  const f = fixture(), db = database(f.state); let clock = NOW, posts = 0; const save = db.save(f.state);
  const gate = lifecycle(f, db, { now: () => clock, authorizePhase: async binding => ({ ...await syntheticAllowance(binding), expiresAt: new Date(NOW + 5).toISOString() }),
    persist: async () => { const result = await save(); clock += 10; return result; } });
  const action = phase(async () => { posts++; return { id: 'never' }; });
  assert.equal((await gate.mutate(action)).code, 'CREATIVE_ALLOWANCE_EXPIRED'); assert.equal(posts, 0);
  assert.equal(db.read().marketing.campaigns[0].creativeRequests[0].safety.phases.generation.status, 'dispatching');
  assert.equal((await gate.mutate(action)).code, 'CREATIVE_SUBMISSION_ALREADY_CLAIMED'); assert.equal(posts, 0);
  assert.equal(gate.summary().spend, null);
});

test('an allowance expiring during final binding verification cannot reach dispatch', async () => {
  const f = fixture(), db = database(f.state); let clock = NOW;
  const gate = lifecycle(f, db, { now: () => clock,
    authorizePhase: async binding => ({ ...await syntheticAllowance(binding), expiresAt: new Date(NOW + 5).toISOString() }) });
  const action = phase(() => assert.fail('Expiry during verification must prevent POST'));
  action.checkBinding = () => { clock += 10; return phase(() => {}).checkBinding(); };
  assert.equal((await gate.mutate(action)).code, 'CREATIVE_ALLOWANCE_EXPIRED');
  assert.equal(gate.summary().submissionAttempts, 0); assert.equal(gate.summary().spend, null);
  assert.equal(db.read().marketing.campaigns[0].creativeRequests[0].safety.phases.generation.status, 'dispatching');
});

test('source, credential or exact payload binding changes during claim persistence prevent dispatch', async () => {
  for (const field of ['sourceDigest', 'accountBinding', 'payloadDigest']) {
    const f = fixture(), db = database(f.state); let changed = false, posts = 0; const save = db.save(f.state);
    const original = phase(async () => { posts++; return { id: 'never' }; });
    const action = { ...original, checkBinding: () => ({ ...original.checkBinding(), ...(changed ? { [field]: creativeDigest('changed') } : {}) }) };
    const gate = lifecycle(f, db, { persist: async () => { const saved = await save(); changed = true; return saved; } });
    assert.equal((await gate.mutate(action)).code, 'CREATIVE_INPUT_CHANGED'); assert.equal(posts, 0);
  }
});

test('detached campaign, request or workspace identity after the saved claim cannot dispatch', async () => {
  for (const [detach, invalidAck] of [[f => { f.state.marketing.campaigns = []; }, false],
    [f => { f.campaign.creativeRequests = []; }, false], [f => { f.state.workspace.id = 'different-workspace'; }, true]]) {
    const f = fixture(), db = database(f.state), save = db.save(f.state);
    const gate = lifecycle(f, db, { persist: async () => { const ack = await save(); detach(f); return ack; } });
    // A changed workspace fails acknowledgement identity; detached members fail
    // the subsequent final identity check. Neither may cross the HTTP boundary.
    if (invalidAck) {
      await assert.rejects(gate.mutate(phase(() => assert.fail('Detached identity must not dispatch'))), { code: 'CREATIVE_CLAIM_ACK_INVALID' });
    } else {
      const result = await gate.mutate(phase(() => assert.fail('Detached identity must not dispatch')));
      assert.equal(result.code, 'CREATIVE_INPUT_CHANGED');
    }
    assert.equal(db.read().marketing.campaigns[0].creativeRequests[0].safety.phases.generation.status, 'dispatching');
  }
});

test('mutable saved claim data cannot extend or replace the authoritative allowance after acknowledgement', async () => {
  for (const change of ['expiry', 'reservation', 'claim_digest']) {
    const f = fixture(), db = database(f.state), save = db.save(f.state); let clock = NOW;
    const gate = lifecycle(f, db, { now: () => clock,
      authorizePhase: async binding => ({ ...await syntheticAllowance(binding), expiresAt: new Date(NOW + 5).toISOString() }),
      persist: async () => {
        const ack = await save(), claim = f.request.safety.phases.generation;
        if (change === 'expiry') { clock += 10; claim.allowance.expiresAt = new Date(NOW + 3600000).toISOString(); }
        else if (change === 'reservation') claim.allowance.reservationId = 'unapproved_reservation';
        else claim.inputDigest = creativeDigest('unapproved input');
        return ack;
      } });
    const result = await gate.mutate(phase(() => assert.fail('Mutated workspace receipt must not dispatch')));
    assert.equal(result.code, change === 'expiry' ? 'CREATIVE_ALLOWANCE_EXPIRED' : 'CREATIVE_INPUT_CHANGED');
    assert.equal(gate.summary().submissionAttempts, 0); assert.equal(gate.summary().spend, null);
    assert.equal(db.read().marketing.campaigns[0].creativeRequests[0].safety.phases.generation.allowance.reservationId, 'synthetic_reservation');
  }
});

test('the production orchestration re-resolves credentials and existing gates after claim persistence', async () => {
  const changes = [f => { f.state.marketing.providers.runway.status = 'disconnected'; },
    f => { f.state.marketing.providers.runway.status = 'action_required'; },
    f => { f.state.marketing.providers.runway.health = { canSubmit: false }; },
    f => { f.state.marketing.settings.autoCreative = false; },
    f => { f.state.marketing.settings.enabled = false; },
    (_f, config) => { config.RUNWAY_API_KEY = 'changed-test-only-key'; },
    (f, config) => { f.state.marketing.providers.runway.encryptedCredentials = encryptCredentials({ apiKey: 'changed-stored-test-key' }, config.CREDENTIALS_KEY); }];
  for (const change of changes) {
    const f = fixture(); f.state.workspace.id = 'packsmart-solutions'; f.request.safety.workspaceId = 'packsmart-solutions';
    f.state.marketing.providers.runway = { status: 'connected', lastTestStatus: 'passed', lastTestAt: new Date(NOW).toISOString() };
    const config = { ...CONFIG, CREDENTIALS_KEY: 'test-only-credential-key-32-characters-long' }, db = database(f.state), save = db.save(f.state); let saves = 0;
    const result = await marketingCreativeCycle(f.state, { env: config, durableStore: true, now: () => NOW,
      authorizePhase: syntheticAllowance, persist: async () => { const ack = await save(); if (++saves === 1) change(f, config); return ack; },
      fetchImpl: () => assert.fail('Changed provider state must prevent any HTTP') });
    assert.equal(result.reason, 'CREATIVE_INPUT_CHANGED'); assert.equal(result.effects.submissionAttempts, 0);
    assert.equal(result.effects.spend, null);
    assert.equal(db.read().marketing.campaigns[0].creativeRequests[0].safety.phases.generation.status, 'dispatching');
  }
});

test('lost claim acknowledgement never dispatches and a restarted durable intent cannot replay', async () => {
  const f = fixture(), db = database(f.state, (count, when) => count === 1 && when === 'after');
  await assert.rejects(lifecycle(f, db).mutate(phase(() => assert.fail('No POST after uncertain persistence'))), { code: 'SUPABASE_PERSISTENCE_FAILED' });
  const state = db.read(), next = { state, campaign: state.marketing.campaigns[0], request: state.marketing.campaigns[0].creativeRequests[0] };
  const result = await lifecycle(next, db).mutate(phase(() => assert.fail('No replay after a durable intent')));
  assert.equal(result.code, 'CREATIVE_SUBMISSION_ALREADY_CLAIMED');
});

test('timeout, malformed receipt and provider errors remain uncertain with no replay or zero-cost claim', async () => {
  for (const submit of [async () => { throw Object.assign(new Error('private upstream secret'), { code: 'RUNWAY_TIMEOUT' }); }, async () => ({}), async () => ({ id: 123 }),
    async () => { throw Object.assign(new Error('private upstream secret'), { code: 'RUNWAY_HTTP_500' }); }]) {
    const f = fixture(), db = database(f.state), gate = lifecycle(f, db); let posts = 0;
    const action = phase(async () => { posts++; return submit(); });
    assert.equal((await gate.mutate(action)).uncertain, true);
    assert.equal((await gate.mutate(action)).code, 'CREATIVE_SUBMISSION_ALREADY_CLAIMED');
    assert.equal(posts, 1); assert.equal(gate.summary().spend, null); assert.equal(gate.summary().externalWrites, null);
    const saved = db.read().marketing.campaigns[0].creativeRequests[0];
    assert.equal(saved.safety.phases.generation.status, 'uncertain'); assert.equal(saved.safety.phases.generation.accountedCostMicros, null);
    assert.ok(!JSON.stringify(saved.safety).includes('private upstream secret'));
  }
});

test('307 and 308 redirects cannot replay a claimed POST at another endpoint', async t => {
  for (const redirectStatus of [307, 308]) {
    const received = [];
    const server = http.createServer((request, response) => {
      received.push([request.method, request.url]);
      if (request.url === '/first') { response.writeHead(redirectStatus, { Location: '/second' }); response.end(); }
      else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ id: 'unexpected_second_job' })); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const f = fixture(), db = database(f.state), gate = lifecycle(f, db);
    const options = { request: f.request, lifecycle: gate,
      fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${server.address().port}/first`, init) };
    await startRunwayCreative(f.campaign, CONFIG, options);
    assert.deepEqual(received, [['POST', '/first']]);
    assert.equal(f.request.safety.phases.generation.status, 'uncertain');
    assert.equal(gate.summary().submissionAttempts, 1); assert.equal(gate.summary().uncertainSubmissions, 1);
    assert.equal(gate.summary().spend, null);
    await startRunwayCreative(f.campaign, CONFIG, options);
    assert.deepEqual(received, [['POST', '/first']]);
    assert.equal(db.read().marketing.campaigns[0].creativeRequests[0].safety.phases.generation.status, 'uncertain');
  }
});

test('accepted POST followed by receipt persistence failure cannot be submitted again after restart', async () => {
  const f = fixture(), db = database(f.state, (count, when) => count === 2 && when === 'before'); let posts = 0;
  await assert.rejects(lifecycle(f, db).mutate(phase(async () => { posts++; return { id: 'accepted_task' }; })), error => {
    assert.equal(error.creativeEffects.confirmedSubmissions, 1); assert.equal(error.creativeEffects.spend, null); return true;
  });
  const state = db.read(), next = { state, campaign: state.marketing.campaigns[0], request: state.marketing.campaigns[0].creativeRequests[0] };
  await lifecycle(next, db).mutate(phase(async () => { posts++; return { id: 'must_not_happen' }; }));
  assert.equal(posts, 1); assert.equal(next.request.safety.phases.generation.status, 'dispatching');
});

test('uncertain phase identity and exposure survive actual workspace normalization and file restart', async t => {
  const f = fixture(), db = database(f.state);
  await lifecycle(f, db).mutate(phase(async () => { throw Object.assign(new Error('synthetic lost response'), { code: 'RUNWAY_TIMEOUT' }); }));
  const proof = structuredClone(f.request.safety);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-proof-restart-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const env = { SAAS_STATE_FILE: path.join(directory, 'state.json') };
  const stored = seedWorkspaceState({}, { workspaceId: f.state.workspace.id, email: 'synthetic@example.test' });
  stored.marketing = f.state.marketing;
  await createStore(env).save(stored.workspace.id, stored);
  const restartedStore = createStore(env), restarted = await restartedStore.get(stored.workspace.id);
  const campaign = restarted.marketing.campaigns[0], request = campaign.creativeRequests[0];
  ensureMarketing(restarted);
  assert.deepEqual(request.safety, proof);
  const gate = createCreativeLifecycle({ state: restarted, campaign, request, persist: () => restartedStore.save(restarted.workspace.id, restarted),
    durableStore: false, authorizePhase: syntheticAllowance, now: () => NOW });
  const result = await gate.mutate(phase(() => assert.fail('Saved uncertain phase cannot replay')));
  assert.equal(result.code, 'CREATIVE_SUBMISSION_ALREADY_CLAIMED'); assert.equal(gate.summary().spend, null);
});

test('known upstream status reads need no generation allowance; a read failure keeps the same ID resumable', async () => {
  const f = fixture({ legacy: true }); Object.assign(f.request, { status: 'in_progress', stage: 'generation', taskId: 'already_accepted' });
  const db = database(f.state); let calls = 0;
  const options = { state: f.state, persist: db.save(f.state), fetchImpl: async (url, options = {}) => {
    calls++; assert.equal(options.method || 'GET', 'GET'); assert.ok(url.endsWith('/tasks/already_accepted'));
    if (calls === 1) return json({}, 503);
    return json({ status: 'SUCCEEDED', output: ['https://example.test/output.mp4'] });
  } };
  const failed = await advanceCampaignCreatives(f.campaign, CONFIG, options);
  assert.equal(f.request.taskId, 'already_accepted'); assert.equal(f.request.status, 'in_progress'); assert.equal(failed.effects.spend, null);
  const complete = await advanceCampaignCreatives(f.campaign, CONFIG, options);
  assert.equal(f.request.status, 'complete'); assert.equal(complete.effects.submissionAttempts, 0);
  await advanceCampaignCreatives(f.campaign, CONFIG, options); assert.equal(calls, 2);
});

test('Canva observation persists an artifact without hidden next POST and retains every deferred request', async () => {
  const f = fixture({ provider: 'canva', legacy: true }); Object.assign(f.request, { status: 'in_progress', stage: 'asset_upload', jobId: 'upload_existing' });
  const deferred = { provider: 'runway', status: 'pending', privateFixtureMarker: 'retained' };
  f.campaign.creativeRequests.push(deferred); const db = database(f.state); let reads = 0;
  const options = { state: f.state, persist: db.save(f.state), eligible: request => request.provider === 'canva', fetchImpl: async (_url, options = {}) => {
    reads++; assert.equal(options.method || 'GET', 'GET'); return json({ job: { status: 'success', asset: { id: 'asset_existing' } } });
  } };
  await advanceCampaignCreatives(f.campaign, { CANVA_ACCESS_TOKEN: CONFIG.CANVA_ACCESS_TOKEN }, options);
  assert.equal(f.request.stage, 'autofill_ready'); assert.equal(f.request.assetId, 'asset_existing'); assert.equal(reads, 1);
  assert.deepEqual(db.read().marketing.campaigns[0].creativeRequests[1], deferred);
  await advanceCampaignCreatives(f.campaign, CONFIG, options);
  assert.equal(reads, 1); assert.equal(f.request.blockReason, 'CREATIVE_ALLOWANCE_REQUIRED');
  assert.deepEqual(f.campaign.publish, { status: 'not_requested', approvalRequired: true });
});

test('the eight-request bound filters completed and ineligible rows before selecting known upstream jobs', async () => {
  for (const prefixStatus of ['complete', 'pending']) {
    const f = fixture({ legacy: true }); f.state.workspace.id = 'packsmart-solutions';
    Object.assign(f.request, { status: 'in_progress', stage: 'generation', taskId: 'ninth_known_job' });
    const prefix = Array.from({ length: 8 }, (_, index) => ({ provider: prefixStatus === 'complete' ? 'runway' : 'canva',
      status: prefixStatus, privateFixtureMarker: `keep_${index}` }));
    f.campaign.creativeRequests.unshift(...prefix);
    f.state.marketing.providers.canva = { status: 'disconnected' };
    const db = database(f.state); let reads = 0;
    const result = await marketingCreativeCycle(f.state, { env: CONFIG, persist: db.save(f.state), fetchImpl: async (url, options = {}) => {
      reads++; assert.ok(url.endsWith('/tasks/ninth_known_job')); assert.equal(options.method || 'GET', 'GET');
      return json({ status: 'SUCCEEDED', output: ['https://example.test/ninth.mp4'] });
    } });
    assert.equal(reads, 1); assert.equal(result.advanced, 1); assert.equal(result.reason, null);
    assert.equal(f.request.status, 'complete'); assert.equal(f.campaign.creativeRequests.length, 9);
    assert.deepEqual(f.campaign.creativeRequests.slice(0, 8), prefix);
    assert.deepEqual(db.read().marketing.campaigns[0].creativeRequests.slice(0, 8), prefix);
    assert.equal(db.read().marketing.campaigns[0].creativeRequests[8].taskId, 'ninth_known_job');
  }
});

test('known-ID work takes priority over blocked new submissions and rotates fairly across restarts', async () => {
  const f = fixture({ legacy: true }); f.state.workspace.id = 'packsmart-solutions';
  const pending = Array.from({ length: 8 }, (_, index) => ({ provider: 'runway', status: 'pending', privateFixtureMarker: `deferred_${index}` }));
  const jobs = Array.from({ length: 9 }, (_, index) => ({ provider: 'runway', status: 'in_progress', stage: 'generation', taskId: `known_${index}` }));
  f.campaign.creativeRequests = [...pending, ...jobs];
  const db = database(f.state); let local = f.state; const readBatches = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    const reads = [];
    const result = await marketingCreativeCycle(local, { env: CONFIG, persist: db.save(local), now: () => NOW,
      fetchImpl: async (url, options = {}) => {
        assert.equal(options.method || 'GET', 'GET'); const taskId = new URL(url).pathname.split('/').pop(); reads.push(taskId);
        return taskId === 'known_0' ? json({}, 503) : json({ status: 'RUNNING', progress: 20 });
      } });
    assert.equal(reads.length, 8); assert.equal(new Set(reads).size, 8);
    assert.equal(result.effects.submissionAttempts, 0); assert.equal(result.effects.blockedSubmissions, 0);
    assert.equal(result.effects.providerReads, 8); assert.equal(result.effects.spend, null);
    assert.deepEqual(local.marketing.campaigns[0].creativeRequests.slice(0, 8), pending);
    assert.equal(local.marketing.campaigns[0].creativeRequests.length, 17);
    // The API/scheduler always performs this final CAS, including RUNNING and
    // failed-read observations that have no terminal provider patch to save.
    await db.save(local)(); local = db.read(); readBatches.push(reads);
  }
  assert.deepEqual(readBatches[0], jobs.slice(0, 8).map(row => row.taskId));
  assert.equal(readBatches[1][0], 'known_8');
  assert.equal(new Set(readBatches.slice(0, 2).flat()).size, 9);
  assert.ok(jobs.every(job => readBatches.flat().filter(id => id === job.taskId).length >= 2));
  assert.deepEqual(local.marketing.campaigns[0].creativeRequests.slice(8).map(row => row.taskId), jobs.map(row => row.taskId));
});

test('new blocked campaigns do not starve old known-ID work, and explicit campaign scope cannot advance another campaign', async () => {
  const f = fixture(); f.state.workspace.id = 'packsmart-solutions'; f.request.safety.workspaceId = 'packsmart-solutions';
  const old = { id: 'campaign_old', status: 'creative_generation', creativeRequests: [{ provider: 'runway', status: 'in_progress', stage: 'generation', taskId: 'old_task' }] };
  f.state.marketing.campaigns.push(old); const db = database(f.state); let reads = 0;
  const options = { env: CONFIG, persist: db.save(f.state), fetchImpl: async (url, options = {}) => { reads++; assert.ok(url.endsWith('/tasks/old_task')); assert.equal(options.method || 'GET', 'GET'); return json({ status: 'SUCCEEDED', output: ['https://example.test/old.mp4'] }); } };
  const explicit = await marketingCreativeCycle(f.state, { ...options, campaignId: f.campaign.id });
  assert.equal(explicit.reason, 'CREATIVE_ALLOWANCE_REQUIRED'); assert.equal(reads, 0);
  const result = await marketingCreativeCycle(f.state, options);
  assert.equal(result.campaign.id, old.id); assert.equal(reads, 1); assert.equal(old.creativeRequests[0].status, 'complete');
});

test('persisted campaign rotation prevents running and failed reads from starving later known jobs', async () => {
  for (const firstResponse of [() => json({ status: 'RUNNING', progress: 5 }), () => json({}, 503)]) {
    const f = fixture({ legacy: true }); f.state.workspace.id = 'packsmart-solutions';
    Object.assign(f.request, { status: 'in_progress', stage: 'generation', taskId: 'first_task' });
    const later = { id: 'campaign_later', status: 'creative_generation', creativeRequests: [
      { provider: 'runway', status: 'in_progress', stage: 'generation', taskId: 'later_task' }] };
    f.state.marketing.campaigns.push(later);
    const db = database(f.state); let local = f.state; const reads = [];
    const fetchImpl = async (url, options = {}) => {
      assert.equal(options.method || 'GET', 'GET'); const task = new URL(url).pathname.split('/').pop(); reads.push(task);
      return task === 'first_task' ? firstResponse() : json({ status: 'SUCCEEDED', output: ['https://example.test/later.mp4'] });
    };
    for (let cycle = 0; cycle < 2; cycle++) {
      const result = await marketingCreativeCycle(local, { env: CONFIG, fetchImpl, persist: db.save(local), now: () => NOW });
      assert.equal(result.campaign.id, cycle === 0 ? f.campaign.id : later.id);
      assert.equal(result.effects.providerReads, 1); assert.equal(result.effects.submissionAttempts, 0); assert.equal(result.effects.spend, null);
      await db.save(local)(); local = db.read();
      assert.deepEqual(local.marketing.campaigns.map(row => row.id), [f.campaign.id, later.id]);
    }
    assert.deepEqual(reads, ['first_task', 'later_task']);
    assert.equal(local.marketing.campaigns[0].creativeRequests[0].taskId, 'first_task');
    assert.equal(local.marketing.campaigns[1].creativeRequests[0].status, 'complete');
    assert.equal(local.marketing.creativeCampaignCursor, later.id);
    // An explicit request keeps its exact scope and does not disturb automatic
    // scheduling metadata, even though the round-robin cursor points elsewhere.
    const explicit = await marketingCreativeCycle(local, { env: CONFIG, fetchImpl, persist: db.save(local), campaignId: f.campaign.id });
    assert.equal(explicit.campaign.id, f.campaign.id); assert.equal(reads.at(-1), 'first_task');
    assert.equal(local.marketing.creativeCampaignCursor, later.id);
  }
});

test('an unreadable earlier provider job cannot starve a later available status read', async () => {
  const f = fixture({ provider: 'canva', legacy: true }); f.state.workspace.id = 'packsmart-solutions';
  Object.assign(f.request, { status: 'in_progress', stage: 'export', jobId: 'disconnected_export' });
  f.state.marketing.providers.canva = { status: 'disconnected' };
  const later = { id: 'campaign_readable', status: 'creative_generation', creativeRequests: [{ provider: 'runway', status: 'in_progress', stage: 'generation', taskId: 'readable_task' }] };
  f.state.marketing.campaigns.push(later); const db = database(f.state); let reads = 0;
  const result = await marketingCreativeCycle(f.state, { env: CONFIG, persist: db.save(f.state), fetchImpl: async url => {
    reads++; assert.ok(url.endsWith('/tasks/readable_task')); return json({ status: 'SUCCEEDED', output: ['https://example.test/ok.mp4'] });
  } });
  assert.equal(result.campaign.id, later.id); assert.equal(reads, 1); assert.equal(f.request.jobId, 'disconnected_export');
});

test('Canva template-only setup errors do not block an existing export status read', async () => {
  const f = fixture({ provider: 'canva', legacy: true }); f.state.workspace.id = 'packsmart-solutions';
  Object.assign(f.request, { status: 'in_progress', stage: 'export', jobId: 'saved_export' });
  f.state.marketing.providers.canva = { status: 'action_required', lastError: 'CANVA_TEMPLATE_FIELDS_REQUIRED' };
  const db = database(f.state);
  const result = await marketingCreativeCycle(f.state, { env: { CANVA_ACCESS_TOKEN: CONFIG.CANVA_ACCESS_TOKEN }, persist: db.save(f.state), fetchImpl: async (url, options = {}) => {
    assert.ok(url.endsWith('/exports/saved_export')); assert.equal(options.method || 'GET', 'GET'); return json({ job: { status: 'success', urls: ['https://example.test/export.png'] } });
  } });
  assert.equal(result.advanced, 1); assert.equal(f.request.status, 'complete'); assert.equal(result.effects.submissionAttempts, 0);
});

test('status transport failures and confirmed provider job failures have distinct non-success reasons', async () => {
  for (const [response, expected] of [[() => json({}, 503), 'CREATIVE_STATUS_READ_FAILED'], [() => json({ status: 'FAILED' }), 'CREATIVE_PROVIDER_JOB_FAILED']]) {
    const f = fixture({ legacy: true }); Object.assign(f.request, { status: 'in_progress', stage: 'generation', taskId: 'saved_task' });
    const result = await advanceCampaignCreatives(f.campaign, CONFIG, { state: f.state, fetchImpl: response });
    assert.equal(result.reason, expected); assert.equal(f.request.taskId, 'saved_task'); assert.equal(result.effects.spend, null);
    assert.equal(result.effects.submissionAttempts, 0);
  }
});

test('a later valid running status clears transient poll failure, while malformed status remains unverified', async () => {
  const f = fixture({ legacy: true }); Object.assign(f.request, { status: 'in_progress', stage: 'generation', taskId: 'saved_task' });
  for (const [reply, reason] of [[() => json({}, 503), 'CREATIVE_STATUS_READ_FAILED'], [() => json({ status: 'RUNNING', progress: 30 }), null], [() => json({}), 'CREATIVE_STATUS_READ_FAILED']]) {
    const result = await advanceCampaignCreatives(f.campaign, CONFIG, { state: f.state, fetchImpl: reply });
    assert.equal(result.reason, reason); assert.equal(f.request.status, 'in_progress'); assert.equal(f.request.taskId, 'saved_task');
  }
});

test('mock-only future allowance protocol walks all four claimed mutations, never a publisher', async () => {
  const f = fixture({ provider: 'canva' }); f.campaign.creativeRequests.push(newCreativeRequest({ workspaceId: f.state.workspace.id, campaignId: f.campaign.id, provider: 'runway', kind: 'product_video', formats: [], now: () => NOW }));
  const db = database(f.state); const posts = [];
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') {
      posts.push(url); const saved = db.read().marketing.campaigns[0].creativeRequests;
      assert.ok(saved.some(request => Object.values(request.safety.phases).some(phase => phase.endpoint === url && phase.status === 'dispatching')));
    }
    if (url === f.campaign.product.image) return new Response('synthetic image', { headers: { 'content-type': 'image/jpeg' } });
    if (url.endsWith('/asset-uploads')) return json({ job: { id: 'upload' } });
    if (url.endsWith('/asset-uploads/upload')) return json({ job: { status: 'success', asset: { id: 'asset' } } });
    if (url.endsWith('/dataset')) return json({ dataset: { headline: { type: 'text' }, product_image: { type: 'image' } } });
    if (url.endsWith('/autofills')) return json({ job: { id: 'autofill' } });
    if (url.endsWith('/autofills/autofill')) return json({ job: { status: 'success', result: { design: { id: 'design' } } } });
    if (url.endsWith('/exports')) return json({ job: { id: 'export' } });
    if (url.endsWith('/exports/export')) return json({ job: { status: 'success', urls: ['https://example.test/output.png'] } });
    if (url.endsWith('/recipes/product_ad')) return json({ id: 'runway_task' });
    if (url.endsWith('/tasks/runway_task')) return json({ status: 'SUCCEEDED', output: ['https://example.test/output.mp4'] });
    assert.fail('Unexpected provider endpoint');
  };
  for (let i = 0; i < 6; i++) await advanceCampaignCreatives(f.campaign, CONFIG, { state: f.state, persist: db.save(f.state), durableStore: true, authorizePhase: syntheticAllowance, fetchImpl, now: () => NOW });
  assert.equal(posts.length, 4); assert.equal(new Set(posts).size, 4); assert.equal(f.campaign.status, 'prepared');
  for (const request of f.campaign.creativeRequests) {
    assert.equal(request.status, 'complete');
    const proof = JSON.stringify(request.safety); assert.ok(!proof.includes(CONFIG.RUNWAY_API_KEY)); assert.ok(!proof.includes(CONFIG.CANVA_ACCESS_TOKEN)); assert.ok(!proof.includes(f.campaign.copy.headline));
    assert.ok(Object.values(request.safety.phases).every(phase => phase.accountedCostMicros === null));
  }
});
