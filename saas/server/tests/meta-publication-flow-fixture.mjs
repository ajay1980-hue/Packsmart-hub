import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {publicationFixture} from './marketing-publication-fixture.mjs';
import {jpegFixture} from './marketing-local-jpeg-fixture.mjs';
import {prepareMetaAssetFixture, commitMetaAsset, metaAssetDescriptor} from '../lib/meta-publication-delivery.mjs';
import {createMetaSingleImageFixture, prepareMetaSingleImageFixture, executeMetaSingleImageFixture} from '../lib/meta-publication-flow.mjs';
import {metaLedgerText, metaLedgerDigest, metaLedgerRequestFingerprint, META_LEDGER_CONTRACT, META_LEDGER_PROVENANCE} from '../lib/meta-publication-ledger.mjs';
// Protocol doubles only; native SQL acceptance uses the actual prepared RPCs.
export async function flowFixture(t, {rpc, store, seed} = {}) {
  const f = await publicationFixture(t, 'flow-' + randomUUID());
  if (store) {f.store = store; f.get = () => store.get(f.workspaceId);}
  if (seed) await seed(f);
  f.bytes = jpegFixture(); f.token = 'd'.repeat(64); f.calls = []; f.providerCalls = []; f.events = []; f.readiness = []; f.assetRows = new Map();
  const ack = (d, bytesBase64, replayed) => ({contract: d.contract, descriptorText: metaLedgerText(d), digest: metaLedgerDigest(d), bytesBase64, replayed, providerDeliveryVerified: false});
  let lane = Promise.resolve();
  const localRpc = async (name, r) => {
    const state = await f.get();
    if (name === 'runvara_commit_meta_asset_v1') {
      const d = r.descriptor, digest = metaLedgerDigest(d), previous = f.assetRows.get(digest);
      const value = ack(d, r.bytesBase64, Boolean(previous)); f.assetRows.set(digest, value); return value;
    }
    if (name === 'runvara_read_meta_asset_v1' || name === 'runvara_deliver_meta_asset_v1') {
      const a = f.assetRows.get(r.digest); if (!a) return null; return {...a, replayed: true};
    }
    if (['runvara_read_meta_ledger_v1', 'runvara_lookup_meta_ledger_v1'].includes(name)) {
      const previous = f.events.find(e => e.event.requestId === r.requestId && e.event.workspaceId === r.workspaceId && e.event.writeId === r.writeId);
      return previous ? {...previous.ack, replayed: true} : null;
    }
    if (name === 'runvara_read_meta_readiness_v1') {
      const admission = f.readiness.filter(e => e.event.kind === 'admit').at(-1); if (!admission) return null;
      const settlement = f.readiness.find(e => e.event.admissionDigest === admission.ack.digest);
      return {admission: {...admission.ack, replayed: true}, settlement: settlement ? {...settlement.ack, replayed: true} : null};
    }
    if (name === 'runvara_commit_meta_readiness_v1') {
      const {expectedState, ...operation} = r;
      const prior = f.readiness.find(e => e.event.requestId === r.requestId);
      if (prior) {assert.equal(prior.event.requestFingerprint, metaLedgerDigest(operation)); return {...prior.ack, replayed: true};}
      const a = state.approvals.find(a => a.id === r.binding.approvalId), {executedExternally, executionStatus, workStatus, ...decision} = a;
      const event = {contract: r.contract, provenance: META_LEDGER_PROVENANCE, workspaceId: r.workspaceId, writeId: r.writeId,
        requestId: r.requestId, kind: r.kind, actor: r.actor, bindingDigest: metaLedgerDigest(r.binding), containerId: '900001',
        attempt: r.kind === 'admit' ? f.readiness.filter(e => e.event.kind === 'admit').length + 1 : f.readiness.find(e => e.ack.digest === r.admissionDigest).event.attempt,
        admissionDigest: r.admissionDigest, statusCode: r.statusCode, approvalDigest: metaLedgerDigest(decision), at: new Date().toISOString(),
        requestFingerprint: metaLedgerDigest(operation), providerReadPerformed: false};
      const value = {eventText: metaLedgerText(event), digest: metaLedgerDigest(event), replayed: false};
      f.readiness.push({event, ack: value}); return value;
    }
    assert.equal(name, 'runvara_commit_meta_ledger_v1');
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
    if (p === '/202') return Response.json({id: '202', tasks: ['CREATE_CONTENT'], instagram_business_account: {id: '303'}});
    if (p === '/303/content_publishing_limit') return Response.json({data: [{quota_usage: 0, config: {quota_total: 50}}]});
    if (p === '/303/media') return Response.json({id: '900001'});
    if (p === '/303/media_publish') return Response.json({id: '900002'});
    if (p === '/900001') return Response.json({id: '900001', status_code: 'FINISHED'});
    throw Error('Unexpected mock path: ' + p);
  };
  f.load = () => f.get();
  f.assetOptions = {environment: 'test', requestId: 'asset-request-' + randomUUID(), origin: 'https://runvara.invalid', token: f.token, expiresAt: Date.now() + 3600000};
  f.assetCommand = await prepareMetaAssetFixture(f.campaignId, f.selection, f.session, f.bytes, f.assetOptions, {loadFreshState: f.load});
  f.asset = await commitMetaAsset(f.assetCommand, {request: f.rpc, loadFreshState: f.load});
  f.descriptor = metaAssetDescriptor(f.asset);
  f.compose = () => createMetaSingleImageFixture({environment: 'test', store: f.store, request: f.rpc, fetch: f.fetch});
  f.composition = f.compose();
  f.prepare = async () => {
    const result = await prepareMetaSingleImageFixture(f.composition, f.asset, f.campaignId, f.selection, f.session, 'publication-request-00001');
    f.binding = result.binding; return result;
  };
  f.approve = async () => {
    await f.change(state => {const a = state.approvals.find(a => a.id === f.binding.approvalId);
      Object.assign(a, {status: 'approved', decidedBy: f.session.userId, decidedAt: new Date().toISOString(),
        history: [{revision: 1, status: 'approved', actor: f.session.userId}]});});
  };
  f.execute = () => executeMetaSingleImageFixture(f.composition, f.binding, f.asset, f.token, f.session);
  return f;
}
