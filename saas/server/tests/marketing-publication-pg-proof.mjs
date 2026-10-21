// Imported only by the explicitly opted-in disposable PostgreSQL harness.
// Primary state reads and revision-conditional writes use real SQL connections.
// PostgREST projection, reporting mirrors and provider transport stay synthetic.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStore } from '../lib/store.mjs';
import { publicationFixture } from './marketing-publication-fixture.mjs';
import { fakeSupabase } from './fake-supabase.mjs';
import { previewMetaMarketingPublication, prepareMetaMarketingPublication, readMetaMarketingPublication,
  createMetaPublicationPreparationSimulation, createMetaPublicationSimulation } from '../lib/marketing-publication.mjs';
import { executeConnectionWrite } from '../lib/connection-writes.mjs';
import { createMetaPublicationLocalAsset } from '../lib/marketing-publication.mjs';
import { png } from './marketing-publication-asset-fixture.mjs';

export async function runMetaPublicationPgProof({ t, admin, withService }) {
  async function fixture(t) {
    const f = await publicationFixture(t, 'meta-pg-' + randomUUID()), seed = await f.get(), fake = fakeSupabase();
    const assetSnapshot = createMetaPublicationLocalAsset(seed, f.campaignId, f.selection, f.session, png(), 'image/png');
    await admin.query('INSERT INTO public.workspaces(id,name,slug) VALUES($1,$1,$1)', [f.workspaceId]);
    await admin.query('INSERT INTO public.saas_workspace_state(workspace_id,state) VALUES($1,$2)', [f.workspaceId, seed]);
    const counters = { primaryReads: 0, primaryWrites: 0, changedRows: 0 }, controls = { afterCommit: null };
    const raw = async () => (await withService(c => c.query('SELECT state FROM public.saas_workspace_state WHERE workspace_id=$1', [f.workspaceId]))).rows[0].state;
    const fetchImpl = async (input, options = {}) => {
      const url = new URL(input), name = url.pathname.split('/').pop(), method = options.method || 'GET';
      assert.equal(url.origin, 'https://meta-pg.invalid');
      if (name === 'saas_workspace_state') {
        assert.equal(url.searchParams.get('workspace_id'), 'eq.' + f.workspaceId);
        if (method === 'PATCH') {
          const body = JSON.parse(options.body), fence = url.searchParams.get('state->>_revision');
          assert.ok(fence.startsWith('eq.')); counters.primaryWrites++;
          const rows = (await withService(c => c.query("UPDATE public.saas_workspace_state SET state=$2,updated_at=$3 WHERE workspace_id=$1 AND state->>'_revision'=$4 RETURNING workspace_id",
            [f.workspaceId, body.state, body.updated_at, fence.slice(3)]))).rows;
          counters.changedRows += rows.length;
          if (rows.length) await controls.afterCommit?.(body.state);
          return Response.json(rows);
        }
        assert.equal(method, 'GET'); counters.primaryReads++;
        fake.states.set(f.workspaceId, await raw());
      }
      return fake.fetchImpl(input, options);
    };
    const store = createStore({ SUPABASE_URL: 'https://meta-pg.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only' }, { fetchImpl });
    const get = () => store.get(f.workspaceId);
    const preview = async () => previewMetaMarketingPublication(await get(), f.campaignId, f.selection, f.session, { assetSnapshot });
    const body = async (requestId = 'meta-native-request-0001') => {
      const p = await preview(); return { requestId, sourceRevision: p.sourceRevision, target: p.target, caption: p.caption, asset: p.asset };
    };
    const prepare = async request => {
      const state = await get(); request ||= await body();
      const preparationSimulation = createMetaPublicationPreparationSimulation(state, f.campaignId, request, f.session, { assetSnapshot });
      return prepareMetaMarketingPublication(state, f.campaignId, request, f.session,
        { durableStore: true, preparationSimulation, persist: options => store.save(f.workspaceId, state, options) });
    };
    const approve = async () => {
      const state = await get(), approval = state.approvals.find(row => row.id === state.connectionWrites[0].approvalId);
      Object.assign(approval, { status: 'approved', decidedBy: f.session.userId, decidedAt: new Date().toISOString() });
      await store.save(f.workspaceId, state);
    };
    const runs = [];
    const execute = async (options = {}) => {
      const state = await get(), write = state.connectionWrites[0], simulation = createMetaPublicationSimulation(state, write, options, { assetSnapshot });
      const run = { state, write, simulation }; runs.push(run);
      run.result = await executeConnectionWrite(state, write.id, f.session.userId, simulation.integrations,
        options => store.save(f.workspaceId, state, options), { durableStore: true, actorSession: f.session,
          metaPublicationSimulation: simulation.capability, loadFreshState: request => store.getConnectionWriteContext(f.workspaceId, request) });
      return run;
    };
    const read = async () => readMetaMarketingPublication(await get(), f.campaignId, 'meta-native-request-0001', f.session);
    return { ...f, store, get, raw, preview, body, prepare, approve, execute, read, runs, controls, counters };
  }
  await t.test('cold JSONB publication preserves exact approval and confirms only simulated transport', async t => {
    const f = await fixture(t); await f.prepare(); await f.approve();
    const stored = await f.raw();
    assert.notDeepEqual(Object.keys(stored.connectionWrites[0].input), ['operation', 'pageId', 'instagramId', 'caption', 'imageUrl']);
    const run = await f.execute(); assert.equal(run.result.status, 'completed');
    const history = await f.read(); assert.equal(history.receiptStatus, 'simulated_confirmed');
    assert.deepEqual(history.receipt.localAssetSnapshot, history.publication.asset.localSnapshot);
    assert.equal(run.simulation.observations().length, 2); assert.ok(f.counters.changedRows > 3);
    const before = { ...f.counters }; await f.execute();
    assert.equal(f.runs[1].simulation.observations().length, 0); assert.equal(f.counters.primaryWrites, before.primaryWrites);
  });
  await t.test('concurrent preparation reserves exactly one logical publication through real revision CAS', async t => {
    const f = await fixture(t), first = await f.body(), second = { ...first, requestId: 'meta-native-request-0002' };
    const results = await Promise.allSettled([f.prepare(first), f.prepare(second)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const stored = await f.raw(); assert.equal(stored.connectionWrites.length, 1);
    assert.equal(stored.approvals.filter(row => row.type === 'social_commerce_publish').length, 1);
  });
  await t.test('concurrent executors cannot duplicate either synthetic phase', async t => {
    const f = await fixture(t); await f.prepare(); await f.approve();
    const results = await Promise.allSettled([f.execute(), f.execute()]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const calls = f.runs.flatMap(run => run.simulation.observations());
    for (const phase of ['instagram_container', 'instagram_publish']) assert.equal(calls.filter(row => row.phase === phase).length, 1);
    assert.equal((await f.read()).receiptStatus, 'simulated_confirmed');
  });
  await t.test('processing container survives a cold JSONB reload without container replay', async t => {
    const f = await fixture(t); await f.prepare(); await f.approve();
    assert.equal((await f.execute({ containerStatus: 'IN_PROGRESS' })).result.status, 'processing');
    assert.equal((await f.execute()).result.status, 'processing', 'Retained observation cooldown remains enforced');
    assert.equal(f.runs[1].simulation.observations().length, 0);
    // Expire only the synthetic observation deadline, preserving the recorded
    // container and claim. Production timing and assertions are unchanged.
    const state = await f.get(); state.connectionWrites[0].providerState.checkAfter = Date.now() - 1;
    await f.store.save(f.workspaceId, state);
    assert.equal((await f.execute()).result.status, 'completed');
    const calls = f.runs.flatMap(run => run.simulation.observations());
    assert.deepEqual(calls.map(row => row.phase), ['instagram_container', 'instagram_publish']);
  });
  await t.test('lost provider response stays unresolved after a native database reload', async t => {
    const f = await fixture(t); await f.prepare(); await f.approve();
    assert.equal((await f.execute({ loseResponsePhase: 'instagram_publish' })).result.status, 'uncertain');
    assert.equal((await f.read()).receiptStatus, 'absent');
    await assert.rejects(f.execute(), { code: 'WRITE_ALREADY_ATTEMPTED' });
    assert.equal(f.runs.flatMap(run => run.simulation.observations()).filter(row => row.phase === 'instagram_publish').length, 1);
  });
}
