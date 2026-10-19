import { createHash } from 'node:crypto';
import { publicationFixture } from './marketing-publication-fixture.mjs';
import { createMetaPublicationPreparationSimulation, prepareMetaMarketingPublication } from '../lib/marketing-publication.mjs';
import { recordMetaReceiptAcknowledgement, readProtectedMetaReceipt, META_RECEIPT_CONTRACT, protectedMetaPublicationAdmission } from '../lib/meta-publication-receipt.mjs';
import { readMetaObservationHistory, appendMetaObservation, createMetaObservationSimulation, META_OBSERVATION_CONTRACT } from '../lib/meta-publication-observation.mjs';

// In-memory RPC responses for protocol/unit tests, explicitly not SQL proof.
export async function observationFixture(t, { phase = 'instagram_publish', workspaceId, configure } = {}) {
  const f = await publicationFixture(t,workspaceId);
  if(configure)await f.change(configure);
  const state = await f.get(), body = await f.body(), events = [];
  const preparationSimulation = createMetaPublicationPreparationSimulation(state, f.campaignId, body, f.session, { protectedReceipts: true });
  let persistenceFailure;
  try {
    await prepareMetaMarketingPublication(state, f.campaignId, body, f.session, { durableStore: true, preparationSimulation, persist: async o => {
      try { return await f.store.save(f.workspaceId, state, o); } catch(error) { persistenceFailure=error; throw error; }
    } });
  } catch(error) { if(persistenceFailure)error.cause=persistenceFailure; throw error; }
  await f.approve();
  await f.execute({ options: { loseResponsePhase: phase }, persist: async (run, options) => {
    const descriptor = options.protectedMetaCommit, event = JSON.parse(descriptor.eventText);
    events.push(structuredClone(descriptor)); await f.store.save(f.workspaceId, run.state);
    recordMetaReceiptAcknowledgement(run.state, descriptor, { contract: META_RECEIPT_CONTRACT,
      workspaceId: f.workspaceId, writeId: event.writeId, sequence: event.sequence, eventDigest: descriptor.digest, requestFingerprint: 'a'.repeat(64) });
    return run.state;
  } });
  const writeId = (await f.get()).connectionWrites[0].id, observations = [], calls = [], controls = { before: null, after: null };
  const request = async (operation, path, settings) => {
    calls.push({ operation, path, settings }); const r = JSON.parse(JSON.parse(settings.body).p_request);
    await controls.before?.(path, r);
    let result;
    if (path.endsWith('runvara_read_meta_receipt')) result = { contract: META_RECEIPT_CONTRACT, workspaceId: f.workspaceId, writeId,
      events: structuredClone(events), simulated: true, executedExternally: false };
    else if (path.endsWith('runvara_read_meta_observations')) result = { contract: META_OBSERVATION_CONTRACT, workspaceId: f.workspaceId, writeId, observations: structuredClone(observations) };
    else if (path.endsWith('runvara_append_meta_observation')) { observations.push(structuredClone(r.descriptor)); result = r.descriptor; }
    else throw Error('Unexpected synthetic RPC');
    await controls.after?.(path, r, result); return result;
  };
  const store = { provider: 'supabase', getIdentity: f.store.getIdentity.bind(f.store),
    readProtectedMetaPublication: (workspace, write, session) => readProtectedMetaReceipt(request, workspace, write, session),
    readMetaObservations: (workspace, write, session, anchor) => readMetaObservationHistory(request, workspace, write, session, anchor),
    appendMetaObservation: (workspace, write, session, descriptor, anchor) => appendMetaObservation(request, workspace, write, session, descriptor, anchor) };
  const proof = await store.readProtectedMetaPublication(f.workspaceId, writeId, f.session), anchor = protectedMetaPublicationAdmission(proof, f.workspaceId, writeId);
  const simulation = (status = 'PUBLISHED') => createMetaObservationSimulation([{ anchor, response: { id: anchor.containerId, status_code: status } }]);
  calls.length = 0;
  return { ...f, events, writeId, anchor, simulation, observations, calls, controls, observationStore: store, request,
    descriptor: row => { const observationText = JSON.stringify(row); return { contract: META_OBSERVATION_CONTRACT, observationText, digest: createHash('sha256').update(observationText).digest('hex') }; } };
}
