import {createMetaProductionController} from '../lib/meta-production.mjs';
import {IntegrationService} from '../lib/integrations.mjs';
import {encryptCredentials} from '../lib/security.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {publicationFixture} from './marketing-publication-fixture.mjs';
import {jpegFixture} from './marketing-local-jpeg-fixture.mjs';
import {metaLedgerText, metaLedgerDigest, metaLedgerRequestFingerprint, META_LEDGER_CONTRACT, META_LEDGER_PROVENANCE} from '../lib/meta-production-ledger.mjs';
// Protocol doubles only; native SQL acceptance uses the actual prepared RPCs.
export async function productionFixture(t, {rpc, store, seed} = {}) {
  const f = await publicationFixture(t, 'flow-' + randomUUID());
  if (store) {f.store = store; f.get = () => store.get(f.workspaceId);}
  if (seed) await seed(f);
  f.bytes = jpegFixture(); f.token = 'd'.repeat(64); f.calls = []; f.providerCalls = []; f.events = []; f.readiness = []; f.assetRows = new Map();
  const ack = (d, bytesBase64, replayed) => ({contract: d.contract, descriptorText: metaLedgerText(d), digest: metaLedgerDigest(d), bytesBase64, replayed, providerDeliveryVerified: false});
  let lane = Promise.resolve();
  const localRpc = async (name, r) => {
    const state = await f.get();
    if (name === 'runvara_commit_meta_prod_asset_v1') {
      const d = r.descriptor, digest = metaLedgerDigest(d), previous = f.assetRows.get(digest);
      const value = ack(d, r.bytesBase64, Boolean(previous)); f.assetRows.set(digest, value); return value;
    }
    if (name === 'runvara_read_meta_prod_asset_v1' || name === 'runvara_deliver_meta_prod_asset_v1') {
      const a = f.assetRows.get(r.digest); if (!a) return null; return {...a, replayed: true};
    }
    if (['runvara_read_meta_prod_ledger_v1', 'runvara_lookup_meta_prod_ledger_v1'].includes(name)) {
      const previous = f.events.find(e => e.event.requestId === r.requestId && e.event.workspaceId === r.workspaceId && e.event.writeId === r.writeId);
      return previous ? {...previous.ack, replayed: true} : null;
    }
    if (name === 'runvara_read_meta_prod_readiness_v1') {
      const admission = f.readiness.filter(e => e.event.kind === 'admit').at(-1);
      const settlement = admission ? f.readiness.find(e => e.event.admissionDigest === admission.ack.digest) : null;
      const attempts = [...f.readiness, ...f.events.filter(e => e.event.phase === 'read')].filter(e => e.event.kind === 'admit').map(e => e.event.at).sort();
      return {admission: admission ? {...admission.ack, replayed: true} : null, settlement: settlement ? {...settlement.ack, replayed: true} : null,
        budget: {attempts: attempts.length, firstAt: attempts[0] ?? null, lastAt: attempts.at(-1) ?? null}};
    }
    if (name === 'runvara_commit_meta_prod_readiness_v1') {
      const {expectedState, ...operation} = r;
      const prior = f.readiness.find(e => e.event.requestId === r.requestId);
      if (prior) {assert.equal(prior.event.requestFingerprint, metaLedgerDigest(operation)); return {...prior.ack, replayed: true};}
      const a = state.approvals.find(a => a.id === r.binding.approvalId), {executedExternally, executionStatus, workStatus, ...decision} = a;
      const event = {contract: r.contract, provenance: META_LEDGER_PROVENANCE, workspaceId: r.workspaceId, writeId: r.writeId,
        requestId: r.requestId, kind: r.kind, actor: r.actor, bindingDigest: metaLedgerDigest(r.binding), containerId: '900001',
        attempt: r.kind === 'admit' ? f.readiness.filter(e => e.event.kind === 'admit').length + 1 : f.readiness.find(e => e.ack.digest === r.admissionDigest).event.attempt,
        admissionDigest: r.admissionDigest, statusCode: r.statusCode, approvalDigest: metaLedgerDigest(decision), at: new Date().toISOString(),
        requestFingerprint: metaLedgerDigest(operation), providerReadPerformed: r.kind === 'settle'};
      const value = {eventText: metaLedgerText(event), digest: metaLedgerDigest(event), replayed: false};
      f.readiness.push({event, ack: value}); return value;
    }
    assert.equal(name, 'runvara_commit_meta_prod_ledger_v1');
    const prior = f.events.find(e => e.event.requestId === r.requestId);
    if (prior) {assert.equal(prior.event.requestFingerprint, metaLedgerRequestFingerprint(r)); return {...prior.ack, replayed: true};}
    const head = f.events.at(-1);
    if (r.kind !== 'settle') assert.equal(r.expectedHead, head?.ack.digest ?? null);
    const a = state.approvals.find(a => a.id === r.binding.approvalId);
    const {executedExternally, executionStatus, workStatus, ...decision} = a;
    const event = {contract: META_LEDGER_CONTRACT, provenance: META_LEDGER_PROVENANCE, workspaceId: r.workspaceId, writeId: r.writeId,
      sequence: f.events.length + 1, requestId: r.requestId, kind: r.kind, phase: r.phase, actor: r.actor,
      bindingDigest: metaLedgerDigest(r.binding), requestFingerprint: metaLedgerRequestFingerprint(r), previousDigest: head?.ack.digest ?? null,
      admissionDigest: r.admissionDigest, data: r.data, at: new Date().toISOString(),
      containerId: f.events.find(e => e.event.kind === 'settle' && e.event.phase === 'container')?.event.data.resultId ?? null,
      publicationAdmission: f.events.find(e => e.event.kind === 'admit' && e.event.phase === 'publish')?.ack.digest ?? null,
      containerConflict: false, phaseContract: META_LEDGER_CONTRACT, approvalDigest: metaLedgerDigest(decision)};
    const value = {contract: META_LEDGER_CONTRACT, provenance: META_LEDGER_PROVENANCE, eventText: metaLedgerText(event),
      digest: metaLedgerDigest(event), replayed: false, transportPermitted: false};
    f.events.push({event, ack: value}); return value;
  };
  f.rpc = async (name, body, options) => {
    const r = JSON.parse(body.p_request); f.calls.push({name, r});
    const before = f.beforeRpc ? await f.beforeRpc(name, r) : undefined;
    if (before !== undefined) return before;
    let response;
    if (rpc) response = await rpc(name, body, options);
    else {const previous = lane; let release; lane = new Promise(resolve => {release = resolve;}); await previous;
      try {response = Response.json(await localRpc(name, r));} finally {release();}}
    if (f.afterRpc) return await f.afterRpc(name, r, response);
    return response;
  };
  f.fetch = async (url, options) => {
    const u = new URL(url), p = u.pathname.replace(/^\/v[^/]+/, '');
    f.providerCalls.push({url, options: {...options, signal: undefined}, p});
    if (f.providerHook) {const result = await f.providerHook(p, options); if (result !== undefined) return result;}
    if (p === '/me') return Response.json({id: '101'});
    if (p === '/me/permissions') return Response.json({data: ['instagram_basic', 'instagram_content_publish', 'pages_read_engagement'].map(permission => ({permission, status: 'granted'}))});
    if (p === '/me/accounts') return Response.json({data: [{id: '202', tasks: ['CREATE_CONTENT'], access_token: 'synthetic-page-token', instagram_business_account: {id: '303'}}]});
    if (p === '/303/content_publishing_limit') return Response.json({data: [{quota_usage: 0, config: {quota_total: 50}}]});
    if (p === '/303/media') return Response.json({id: '900001'});
    if (p === '/303/media_publish') return Response.json({id: '900002'});
    if (p === '/900001') return Response.json({id: '900001', status_code: 'FINISHED'});
    throw Error('Unexpected mock path: ' + p);
  };
  f.load = () => f.get();

  f.env = {NODE_ENV: 'test', APP_PUBLIC_URL: 'https://packsmart-ops.onrender.com', RUNVARA_META_PUBLICATION: 'enabled/v1',
    SESSION_SECRET: 'synthetic-production-session-at-least-32-characters', CREDENTIALS_KEY: 'synthetic-production-key-at-least-32-characters', META_CLIENT_SECRET: 'synthetic-meta-app-secret'};
  await f.change(state => {state.connections[0].encryptedCredentials = encryptCredentials({accessToken: 'synthetic-user-token', expiresAt: Date.now() + 3600000}, f.env.CREDENTIALS_KEY);});
  const previousStore = f.store;
  f.store = {provider: 'supabase', get: previousStore.get.bind(previousStore), save: previousStore.save.bind(previousStore),
    getIdentity: previousStore.getIdentity ? previousStore.getIdentity.bind(previousStore) : previousStore.get.bind(previousStore),
    metaProductionRpc: (name, body, options) => f.rpc(name, body, options)};
  f.get = () => f.store.get(f.workspaceId);
  f.change = async change => {const state = await f.get(); change(state); await f.store.save(f.workspaceId, state);};
  f.assetCalls = [];
  f.network = async (url, options) => {
    const u = new URL(url);
    if (u.origin === f.env.APP_PUBLIC_URL) {
      f.assetCalls.push({url, options});
      const parts = u.pathname.split('/');
      return f.controller.deliver(parts.at(-2), parts.at(-1).replace(/\.jpg$/, ''));
    }
    assert.equal(u.hostname, 'graph.facebook.com');
    return f.fetch(url, options);
  };
  f.integrations = new IntegrationService(f.env, {fetchImpl: (url, options) => f.network(url, options)});
  f.reopen = (env = f.env) => createMetaProductionController({env, store: f.store, integrations: f.integrations});
  f.controller = f.reopen();
  f.body = {requestId: 'production-request-00001', selection: f.selection, jpegBase64: f.bytes.toString('base64'), expiresAt: Date.now() + 3600000};
  f.prepare = async () => {f.proposal = await f.controller.prepare(f.campaignId, f.body, f.session); f.binding = f.proposal.binding; return f.proposal;};
  f.approve = () => f.controller.decide(f.campaignId, f.body.requestId, {decision: 'approved', consent: f.proposal.consent}, f.session);
  f.execute = () => f.controller.execute(f.campaignId, f.body.requestId, {consent: f.proposal.consent}, f.session);
  f.read = () => f.controller.read(f.campaignId, f.body.requestId, f.session);
  return f;
}
