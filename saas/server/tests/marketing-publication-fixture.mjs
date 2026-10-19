
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore, seedWorkspaceState } from '../lib/store.mjs';
import { draftMarketingCampaign } from '../lib/marketing.mjs';
import { executeConnectionWrite } from '../lib/connection-writes.mjs';
import { publicConnectionWrite } from '../lib/action-display.mjs';
import { previewMetaMarketingPublication, prepareMetaMarketingPublication, readMetaMarketingPublication,
  createMetaPublicationSimulation, createMetaPublicationPreparationSimulation } from '../lib/marketing-publication.mjs';

export async function publicationFixture(t, workspaceId = 'meta-simulation') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runvara-meta-publication-'));
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const env = { SAAS_STATE_FILE: path.join(directory, 'state.json') };
  const store = createStore(env), state = seedWorkspaceState({}, { workspaceId, email: `${workspaceId}@example.test` });
  state.users[0].passwordChangeRequired = false;
  state.products = [{ id: 'product-1', title: 'Synthetic mailing bags', status: 'active', image: 'https://example.test/product.jpg',
    variants: [{ id: 'variant-1', sku: 'BAGS', title: 'Pack of 50', price: 20, inventory: 15, available: true }] }];
  state.economics.BAGS = { landed: 6, packing: 0.5, handling: 0.5, delivery: 1, paymentFee: 0.2, channelFee: 0.2, advertising: 0, otherVariable: 0 };
  Object.assign(state.marketing.settings, { minMarginPercent: 30, minInventory: 10 });
  state.connections = [{ id: 'meta-fixture', provider: 'meta', status: 'connected', encryptedCredentials: 'synthetic-marker-not-a-credential',
    metadata: { accountId: '101', grantedScopes: ['instagram_basic', 'instagram_content_publish', 'pages_read_engagement'],
      assets: { pages: [{ id: '202', instagram: { id: '303' } }] } } }];
  state.connectionSettings = { meta: { permissionMode: 'approval_gated', revision: 1, metaPageIds: ['202'] } };
  const campaign = draftMarketingCampaign(state), creative = campaign.creativeRequests[0];
  Object.assign(creative, { status: 'complete', stage: 'complete', jobId: 'synthetic-canva-export',
    completedAt: new Date().toISOString(), assetUrls: ['https://example.test/canva-complete.jpg'] });
  const session = { workspaceId, userId: state.users[0].id, sessionVersion: 1 };
  const selection = { pageId: '202', creativeRequestId: creative.id, assetUrl: creative.assetUrls[0] };
  await store.save(workspaceId, state);
  const f = { store, env, workspaceId, session, campaignId: campaign.id, selection, executions: [] };
  f.get = () => store.get(workspaceId);
  f.preview = async () => previewMetaMarketingPublication(await f.get(), campaign.id, selection, session, { assetSnapshot: f.assetSnapshot ?? null });
  f.body = async (requestId = 'meta-publication-request-0001') => {
    const preview = await f.preview();
    return { requestId, sourceRevision: preview.sourceRevision, target: preview.target, caption: preview.caption, asset: preview.asset };
  };
  f.prepare = async (body, hook) => {
    const current = await f.get();
    body ||= await f.body();
    const preparationSimulation = createMetaPublicationPreparationSimulation(current, campaign.id, body, session, { assetSnapshot: f.assetSnapshot ?? null });
    return prepareMetaMarketingPublication(current, campaign.id, body, session,
      { durableStore: true, preparationSimulation, persist: options => hook ? hook(current, options) : store.save(workspaceId, current, options) });
  };
  f.approve = async () => {
    const current = await f.get(), write = current.connectionWrites[0];
    Object.assign(current.approvals.find(row => row.id === write.approvalId), { status: 'approved', decidedBy: session.userId, decidedAt: new Date().toISOString() });
    await store.save(workspaceId, current);
  };
  f.change = async change => { const current = await f.get(); change(current); await store.save(workspaceId, current); };
  f.read = async () => readMetaMarketingPublication(await f.get(), campaign.id, 'meta-publication-request-0001', session);
  f.execute = async ({ options = {}, persist, fresh, loadStore = store } = {}) => {
    const current = await loadStore.get(workspaceId), write = current.connectionWrites[0];
    const simulation = createMetaPublicationSimulation(current, write, options, { assetSnapshot: f.assetSnapshot ?? null }), run = { state: current, write, simulation, saves: 0 };
    f.executions.push(run);
    // Test-only FileStore harness. Production explicitly refuses FileStore
    // dispatch. Real hosted CAS/concurrency requires separate acceptance.
    const save = saveOptions => loadStore.save(workspaceId, current, saveOptions);
    run.result = await executeConnectionWrite(current, write.id, session.userId, simulation.integrations,
      saveOptions => { run.saves++; return persist ? persist(run, saveOptions, save) : save(saveOptions); },
      { durableStore: true, actorSession: session, metaPublicationSimulation: simulation.capability,
        loadFreshState: context => fresh ? fresh(run, context) : loadStore.get(workspaceId) });
    return run;
  };
  return f;
}

