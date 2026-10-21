import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.mjs';
import { draftMarketingCampaign } from '../lib/marketing.mjs';
import { executeConnectionWrite } from '../lib/connection-writes.mjs';
import { publicConnectionWrite, publicApproval } from '../lib/action-display.mjs';
import { previewMetaMarketingPublication, prepareMetaMarketingPublication, readMetaMarketingPublication,
  createMetaPublicationSimulation, createMetaPublicationPreparationSimulation } from '../lib/marketing-publication.mjs';

import { publicationFixture } from './marketing-publication-fixture.mjs';

test('exact proposal binds approval to destination, copy and complete asset reference without credential access', async t => {
  const f = await publicationFixture(t), state = await f.get();
  let credentialReads = 0;
  Object.defineProperty(state.connections[0], 'encryptedCredentials', { enumerable: true, configurable: true,
    get() { credentialReads++; throw new Error('Do not read credentials'); } });
  assert.throws(() => previewMetaMarketingPublication(state, f.campaignId, f.selection, f.session));
  assert.equal(credentialReads, 0);
  const body = await f.body(), prepared = await f.prepare(body), saved = await f.get();
  assert.equal(prepared.status, 'pending_approval'); assert.equal(prepared.publishingEnabled, false);
  assert.equal(prepared.publication.asset.bytesVerified, false);
  const approval = saved.approvals.find(row => row.id === prepared.approvalId);
  assert.deepEqual(approval.payload.publication, prepared.publication);
  assert.equal(approval.payload.marketingPublicationDigest, prepared.publication.digest);
  const display = publicApproval(approval);
  assert.equal(display.payload.publication.caption, body.caption);
  assert.equal(display.payload.publication.asset.url, body.asset.url);
  assert.equal(display.payload.publication.target.instagramId, body.target.instagramId);
  const again = await f.prepare(body);
  assert.equal(again.writeId, prepared.writeId);
  assert.equal((await f.get()).connectionWrites.length, 1);
  assert.ok(saved.audit.some(row => row.type === 'marketing_publication_prepared'));
});

test('production execution is closed before credentials, writes or transport even with exact approval', async t => {
  const f = await publicationFixture(t); await f.prepare(); await f.approve();
  const state = await f.get(), write = state.connectionWrites[0];
  const unexpected = () => assert.fail('Production path touched a boundary');
  await assert.rejects(executeConnectionWrite(state, write.id, f.session.userId, { connectorCredentials: unexpected }, unexpected,
    { durableStore: true, loadFreshState: unexpected, actorSession: f.session, metaPublicationSimulation: {} }), { code: 'META_PUBLICATION_PRODUCTION_CLOSED' });
  assert.equal((await f.read()).status, 'pending_approval');
});

test('preparation requires an unforgeable local capability bound to the exact requester, campaign and body', async t => {
  const f = await publicationFixture(t), state = await f.get(), body = await f.body();
  const capability = createMetaPublicationPreparationSimulation(state, f.campaignId, body, f.session);
  const before = structuredClone(state);
  const persist = () => assert.fail('Closed preparation must not save');
  for (const preparationSimulation of [null, {}, { ...capability }]) {
    await assert.rejects(prepareMetaMarketingPublication(state, f.campaignId, body, f.session,
      { durableStore: true, persist, preparationSimulation }), { code: 'META_PUBLICATION_PREPARATION_CLOSED' });
  }
  for (const [campaign, request] of [[f.campaignId, { ...body, requestId: 'meta-publication-request-0002' }], ['different-campaign', body]]) {
    await assert.rejects(prepareMetaMarketingPublication(state, campaign, request, f.session,
      { durableStore: true, persist, preparationSimulation: capability }), { code: 'META_PUBLICATION_PREPARATION_CLOSED' });
  }
  const beta = await publicationFixture(t, 'other-simulation'), other = await beta.get(), otherBody = await beta.body();
  await assert.rejects(prepareMetaMarketingPublication(other, beta.campaignId, otherBody, beta.session,
    { durableStore: true, persist, preparationSimulation: capability }), { code: 'META_PUBLICATION_PREPARATION_CLOSED' });
  const renewed = structuredClone(state); renewed.users[0].sessionVersion = 2;
  await assert.rejects(prepareMetaMarketingPublication(renewed, f.campaignId, body, { ...f.session, sessionVersion: 2 },
    { durableStore: true, persist, preparationSimulation: capability }), { code: 'META_PUBLICATION_PREPARATION_CLOSED' });
  const secondOwner = structuredClone(state); secondOwner.users.push({ ...secondOwner.users[0], id: 'another-owner' });
  await assert.rejects(prepareMetaMarketingPublication(secondOwner, f.campaignId, body, { ...f.session, userId: 'another-owner' },
    { durableStore: true, persist, preparationSimulation: capability }), { code: 'META_PUBLICATION_PREPARATION_CLOSED' });
  assert.deepEqual(state, before);
});

test('synthetic publication persists two claims and receipt, survives reload, and never reports external execution', async t => {
  const f = await publicationFixture(t); await f.prepare(); await f.approve();
  const run = await f.execute(), history = await f.read();
  assert.deepEqual(run.simulation.observations().map(row => row.phase), ['instagram_container', 'instagram_publish']);
  assert.equal(history.receiptStatus, 'simulated_confirmed'); assert.equal(history.executedExternally, false);
  assert.equal(history.replayPermitted, false); assert.equal(history.containerId, '900000001');
  const restarted = createStore(f.env), stored = await restarted.get(f.workspaceId), write = stored.connectionWrites[0];
  assert.equal(write.status, 'completed'); assert.equal(write.result.simulated, true);
  assert.equal(stored.approvals.find(row => row.id === write.approvalId).executedExternally, false);
  assert.equal(publicConnectionWrite(write).simulationOnly, true);
  assert.equal(publicConnectionWrite(write).executedExternally, false);
  const repeated = await f.execute({ loadStore: restarted });
  assert.equal(repeated.simulation.observations().length, 0); assert.equal(repeated.saves, 0);
  assert.equal((await f.read()).receipt.digest, history.receipt.digest);
});

test('lost preparation acknowledgement reconciles exact saved request without duplicate approval', async t => {
  const f = await publicationFixture(t), body = await f.body();
  await assert.rejects(f.prepare(body, async (state, options) => { await f.store.save(f.workspaceId, state, options); throw new Error('ACK lost'); }), { code: 'META_PUBLICATION_SAVE_UNKNOWN' });
  const reconciled = await f.prepare(body);
  assert.equal(reconciled.found, true); assert.equal((await f.get()).connectionWrites.length, 1);
  const changed = structuredClone(body); changed.caption += ' different';
  await assert.rejects(f.prepare(changed), { code: 'WRITE_CONFLICT' });
});

test('same logical publication is fenced under new request IDs, including uncertainty and changed copy', async t => {
  const f = await publicationFixture(t); await f.prepare(); await f.approve();
  await f.execute({ options: { loseResponsePhase: 'instagram_publish' } });
  assert.equal((await f.read()).outcome, 'unresolved_do_not_resend');
  await assert.rejects(f.prepare(await f.body('meta-publication-request-0002')), { code: 'META_PUBLICATION_DUPLICATE' });
  await f.change(state => { state.marketing.campaigns[0].copy.longCaption += ' revised'; });
  await assert.rejects(f.prepare(await f.body('meta-publication-request-0003')), { code: 'META_PUBLICATION_DUPLICATE' });
  assert.equal((await f.read()).sourceStatus, 'changed_or_unavailable');
  await assert.rejects(f.execute(), { code: 'WRITE_ALREADY_ATTEMPTED' });
});

for (const phase of ['instagram_container', 'instagram_publish']) test(`lost ${phase} result never resends after restart`, async t => {
  const f = await publicationFixture(t); await f.prepare(); await f.approve();
  const run = await f.execute({ options: { loseResponsePhase: phase } });
  assert.equal(run.result.status, 'uncertain');
  const history = await f.read(); assert.equal(history.receiptStatus, 'absent');
  assert.equal(history.outcome, 'unresolved_do_not_resend');
  if (phase === 'instagram_publish') assert.equal(history.containerId, '900000001');
  await assert.rejects(f.execute({ loadStore: createStore(f.env) }), { code: 'WRITE_ALREADY_ATTEMPTED' });
  assert.equal(f.executions.at(-1).simulation.observations().length, 0);
});

test('known pending container resumes observation and final publication without recreating the container', async t => {
  const f = await publicationFixture(t); await f.prepare(); await f.approve();
  const pending = await f.execute({ options: { containerStatus: 'IN_PROGRESS' } });
  assert.equal(pending.result.status, 'processing');
  assert.equal((await f.read()).outcome, 'container_recorded_observation_pending');
  await f.change(state => { state.connectionWrites[0].providerState.checkAfter = 0; });
  const resumed = await f.execute({ loadStore: createStore(f.env) });
  assert.deepEqual(resumed.simulation.observations().map(row => row.phase), ['instagram_publish']);
  assert.equal((await f.read()).receiptStatus, 'simulated_confirmed');
});

test('interruption after a durable final phase claim leaves an unresolved fenced request', async t => {
  const f = await publicationFixture(t); await f.prepare(); await f.approve();
  await assert.rejects(f.execute({ persist: async (run, options, save) => {
    if (run.saves > 4) throw new Error('process remains interrupted');
    const saved = await save(options);
    if (run.saves === 4) throw new Error('process interrupted after final claim');
    return saved;
  } }));
  const history = await f.read();
  assert.equal(history.outcome, 'unresolved_do_not_resend');
  assert.equal(history.containerId, '900000001');
  await assert.rejects(f.execute(), { code: 'WRITE_ALREADY_ATTEMPTED' });
  assert.equal(f.executions[0].simulation.observations().filter(row => row.phase === 'instagram_publish').length, 0);
});

test('lost final save acknowledgement is reconciled from the committed receipt, without another send', async t => {
  const f = await publicationFixture(t); await f.prepare(); await f.approve();
  await assert.rejects(f.execute({ persist: async (run, options, save) => {
    const saved = await save(options); if (run.write.status === 'completed') throw new Error('final ACK lost'); return saved;
  } }));
  assert.equal((await f.read()).receiptStatus, 'simulated_confirmed');
  assert.equal((await f.execute()).simulation.observations().length, 0);
});

test('uncommitted final receipt remains uncertain in storage and cannot be reconstructed or replayed from caller data', async t => {
  const f = await publicationFixture(t); await f.prepare(); await f.approve();
  await assert.rejects(f.execute({ persist: (run, options, save) => {
    if (run.write.status === 'completed') throw new Error('crash before final commit'); return save(options);
  } }));
  const history = await f.read(); assert.equal(history.receiptStatus, 'absent'); assert.equal(history.outcome, 'unresolved_do_not_resend');
  await assert.rejects(f.execute(), { code: 'WRITE_ALREADY_ATTEMPTED' });
});

test('two concurrent store replicas admit only one execution and one final publication', async t => {
  const f = await publicationFixture(t); await f.prepare(); await f.approve();
  const results = await Promise.allSettled([f.execute(), f.execute({ loadStore: createStore(f.env) })]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(f.executions.flatMap(run => run.simulation.observations()).filter(row => row.phase === 'instagram_publish').length, 1);
  assert.equal((await f.read()).receiptStatus, 'simulated_confirmed');
});

test('success-only provider response cannot produce a confirmed publication receipt', async t => {
  const f = await publicationFixture(t); await f.prepare(); await f.approve();
  const run = await f.execute({ options: { invalidResult: true } });
  assert.equal(run.result.status, 'uncertain'); assert.equal((await f.read()).receiptStatus, 'absent');
  await assert.rejects(f.execute(), { code: 'WRITE_ALREADY_ATTEMPTED' });
});

const changes = {
  copy: state => { state.marketing.campaigns[0].copy.longCaption += ' changed'; },
  asset: state => { state.marketing.campaigns[0].creativeRequests[0].assetUrls[0] += '?new=1'; },
  creativeJob: state => { state.marketing.campaigns[0].creativeRequests[0].jobId = 'changed'; },
  account: state => { state.connections[0].metadata.accountId = '999'; },
  instagram: state => { state.connections[0].metadata.assets.pages[0].instagram.id = '999'; },
  page: state => { state.connectionSettings.meta.metaPageIds = []; },
  settings: state => { state.connectionSettings.meta.revision++; },
  scopes: state => { state.connections[0].metadata.grantedScopes = []; },
  stock: state => { state.products[0].variants[0].inventory = 2; },
  unknownStock: state => { state.products[0].variants[0].inventory = null; },
  cost: state => { delete state.economics.BAGS.handling; },
  margin: state => { state.economics.BAGS.landed = 19; },
  disabled: state => { state.marketing.settings.enabled = false; },
  approval: state => { state.approvals[0].payload.marketingPublicationDigest = 'changed'; },
  session: state => { state.users[0].sessionVersion++; },
  foreignProduct: state => { state.products[0].workspaceId = 'foreign'; }
};
for (const [name, change] of Object.entries(changes)) test(`changed ${name} is refused before any synthetic dispatch`, async t => {
  const f = await publicationFixture(t); await f.prepare(); await f.approve(); await f.change(change);
  await assert.rejects(f.execute());
  assert.equal(f.executions.flatMap(run => run.simulation.observations()).length, 0);
});

for (const costKey of ['BAGS', 'variant-1']) test(`exact ${costKey} cost changes below display precision invalidate approval`, async t => {
  const f = await publicationFixture(t);
  if (costKey !== 'BAGS') await f.change(state => { state.economics[costKey] = state.economics.BAGS; delete state.economics.BAGS; });
  const before = await f.preview();
  await f.prepare(); await f.approve();
  await f.change(state => { state.economics[costKey].landed = 6.000001; });
  const after = await f.preview();
  assert.notEqual(after.sourceRevision, before.sourceRevision);
  await assert.rejects(f.execute(), { code: 'META_PUBLICATION_SOURCE_CHANGED' });
  assert.equal(f.executions.flatMap(run => run.simulation.observations()).length, 0);
});

test('variant-ID cost fallback keeps tenant scope checks', async t => {
  const f = await publicationFixture(t);
  await f.change(state => { state.economics['variant-1'] = { ...state.economics.BAGS, workspaceId: 'foreign' }; delete state.economics.BAGS; });
  await assert.rejects(f.preview());
});

test('stock change between container and publication blocks the final phase', async t => {
  const f = await publicationFixture(t); await f.prepare(); await f.approve();
  await assert.rejects(f.execute({ persist: async (run, options, save) => {
    const saved = await save(options);
    if (run.saves === 3) run.state.products[0].variants[0].inventory = 0;
    return saved;
  } }));
  assert.equal(f.executions[0].simulation.observations().filter(row => row.phase === 'instagram_publish').length, 0);
});

test('confirmed publication receipt persists after a post-send eligibility change', async t => {
  const f = await publicationFixture(t); await f.prepare(); await f.approve();
  const run = await f.execute({ persist: (run, options, save) => {
    if (run.write.status === 'completed') { run.state.products[0].variants[0].inventory = 0; run.state.connectionSettings.meta.disconnected = true; }
    return save(options);
  } });
  assert.equal(run.result.status, 'completed'); assert.equal((await f.read()).receiptStatus, 'simulated_confirmed');
  assert.equal((await f.read()).sourceStatus, 'changed_or_unavailable');
});

test('receipt tampering, wrong tenant and duplicate request rows cannot reconcile as success', async t => {
  const f = await publicationFixture(t); await f.prepare(); await f.approve(); await f.execute();
  const state = await f.get();
  assert.throws(() => readMetaMarketingPublication(state, f.campaignId, 'meta-publication-request-0001', { ...f.session, workspaceId: 'foreign' }));
  const foreign = structuredClone(state); foreign.connectionWrites[0].marketingPublication.workspaceId = 'foreign';
  assert.throws(() => readMetaMarketingPublication(foreign, f.campaignId, 'meta-publication-request-0001', f.session));
  const altered = structuredClone(state); altered.connectionWrites[0].marketingPublicationReceipt.resultId = '999';
  assert.throws(() => readMetaMarketingPublication(altered, f.campaignId, 'meta-publication-request-0001', f.session), { code: 'META_PUBLICATION_RECEIPT_INVALID' });
  state.connectionWrites.push(structuredClone(state.connectionWrites[0]));
  assert.throws(() => readMetaMarketingPublication(state, f.campaignId, 'meta-publication-request-0001', f.session), { code: 'WRITE_CONFLICT' });
});

for (const field of ['providerState', 'containerClaim', 'missingProviderState']) test(`receipt reconciliation rejects conflicting ${field} container evidence without replay`, async t => {
  const f = await publicationFixture(t); await f.prepare(); await f.approve(); await f.execute();
  await f.change(state => {
    const write = state.connectionWrites[0];
    if (field === 'providerState') write.providerState.containerId = '999';
    if (field === 'containerClaim') write.dispatchClaim.phases.instagram_container.resultId = '999';
    if (field === 'missingProviderState') delete write.providerState;
  });
  await assert.rejects(f.read(), { code: 'META_PUBLICATION_RECEIPT_INVALID' });
  const repeated = await f.execute();
  assert.equal(repeated.simulation.observations().length, 0);
  assert.equal(repeated.saves, 0);
  await assert.rejects(f.read(), { code: 'META_PUBLICATION_RECEIPT_INVALID' });
});

test('stale preview, unknown fields and incomplete creative output cannot prepare an approval', async t => {
  const f = await publicationFixture(t), body = await f.body();
  await assert.rejects(f.prepare({ ...body, allowPublishing: true }), { code: 'META_PUBLICATION_INPUT_INVALID' });
  await f.change(state => { state.marketing.campaigns[0].copy.longCaption += ' revised'; });
  await assert.rejects(f.prepare(body), { code: 'META_PUBLICATION_SOURCE_CHANGED' });
  await f.change(state => { state.marketing.campaigns[0].creativeRequests[0].status = 'pending'; });
  await assert.rejects(f.preview(), { code: 'META_PUBLICATION_ASSET_UNAVAILABLE' });
  assert.equal((await f.get()).connectionWrites?.length || 0, 0);
});

test('concurrent preparation with different request IDs cannot bypass the logical duplicate fence', async t => {
  const f = await publicationFixture(t), first = await f.body(), second = await f.body('meta-publication-request-0002');
  const results = await Promise.allSettled([f.prepare(first), f.prepare(second)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal((await f.get()).connectionWrites.length, 1);
  const losing = results[0].status === 'rejected' ? first : second;
  await assert.rejects(f.prepare(losing), { code: 'META_PUBLICATION_DUPLICATE' });
});

test('daily organic limit is reserved by prepared requests and never silently expanded', async t => {
  const f = await publicationFixture(t);
  await f.change(state => { state.marketing.settings.dailyOrganicLimit = 1; });
  await f.prepare();
  const state = await f.get(), next = draftMarketingCampaign(state), original = state.marketing.campaigns.find(row => row.id === f.campaignId);
  next.creativeRequests = structuredClone(original.creativeRequests);
  await f.store.save(f.workspaceId, state);
  const current = await f.get(), preview = previewMetaMarketingPublication(current, next.id, f.selection, f.session);
  const body = { requestId: 'meta-publication-request-0002', sourceRevision: preview.sourceRevision,
    target: preview.target, caption: preview.caption, asset: preview.asset };
  const preparationSimulation = createMetaPublicationPreparationSimulation(current, next.id, body, f.session);
  await assert.rejects(prepareMetaMarketingPublication(current, next.id, body, f.session,
    { durableStore: true, preparationSimulation, persist: options => f.store.save(f.workspaceId, current, options) }), { code: 'META_PUBLICATION_DAILY_LIMIT' });
  assert.equal((await f.get()).connectionWrites.length, 1);
});

test('missing save revision and in-process source mutation cannot be acknowledged as prepared', async t => {
  const f = await publicationFixture(t), body = await f.body();
  await assert.rejects(f.prepare(body, async state => { delete state._revision; return state; }), { code: 'META_PUBLICATION_SAVE_UNKNOWN' });
  await assert.rejects(f.prepare(body, async (state, options) => {
    state.marketing.campaigns[0].copy.longCaption += ' changed';
    return f.store.save(f.workspaceId, state, options);
  }), { code: 'META_PUBLICATION_SAVE_UNKNOWN' });
  assert.equal((await f.get()).connectionWrites?.length || 0, 0);
});

test('a copied simulation capability or replacement transport cannot authorize the marked path', async t => {
  const f = await publicationFixture(t); await f.prepare(); await f.approve();
  const state = await f.get(), write = state.connectionWrites[0], simulation = createMetaPublicationSimulation(state, write);
  for (const [capability, integrations] of [[{ ...simulation.capability }, simulation.integrations], [simulation.capability, { ...simulation.integrations }]]) {
    await assert.rejects(executeConnectionWrite(state, write.id, f.session.userId, integrations, () => assert.fail('save'),
      { durableStore: true, loadFreshState: () => assert.fail('read'), actorSession: f.session, metaPublicationSimulation: capability }),
    { code: 'META_PUBLICATION_PRODUCTION_CLOSED' });
  }
});
