import {createHash, createHmac} from 'node:crypto';
import {addAudit} from './events.mjs';
import {contentWriteSnapshot} from './content-write-identity.mjs';
import {metaPublicationChoices} from './marketing-publication.mjs';
import {metaRequestEnvelope} from './meta-commerce.mjs';
import {metaBoundedBytes, metaStrictJson} from './meta-publication-bounded.mjs';
import {decodedMetaProductionResponse} from './meta-production-transport.mjs';
import {META_LEDGER_CONTRACT, metaLedgerDigest, metaLedgerText, metaProductionConsent} from './meta-production-ledger.mjs';
import {assertMetaDeliveryOwner, prepareMetaAssetProduction, commitMetaAsset, readMetaAsset, metaAssetDescriptor,
  metaAssetReviewBytes, assertMetaAssetSource, serveMetaAssetProduction} from './meta-production-delivery.mjs';
import {createMetaSingleImageProduction, prepareMetaSingleImageProduction, readMetaSingleImageProduction,
  executeMetaSingleImageProduction} from './meta-production-flow.mjs';

export const META_PRODUCTION_ORIGIN = 'https://packsmart-ops.onrender.com';
const fail = (code, status = 409) => Object.assign(new Error(code), {code, status});
const exact = (v, keys) => {contentWriteSnapshot(v); if (!v || Array.isArray(v)
  || Object.keys(v).sort().join('|') !== [...keys].sort().join('|')) throw fail('META_PRODUCTION_INPUT_INVALID', 400);};
const identity = (workspaceId, requestId) => 'approval-' + metaLedgerDigest({workspaceId, requestId});
const requestIdValid = v => typeof v === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(v);
const hash = b => createHash('sha256').update(b).digest('hex');
const clone = v => JSON.parse(metaLedgerText(v));

// Only this server-owned composition can join the normal store, current session
// and existing connection credentials. Nothing here reads environment files,
// refreshes OAuth or falls back to a global account. Tests inject at fetch.
export function createMetaProductionController({env, store, integrations} = {}) {
  const durable = store?.provider === 'supabase' && typeof store.metaProductionRpc === 'function';
  const enabled = durable && env?.RUNVARA_META_PUBLICATION === 'enabled/v1'
    && env.APP_PUBLIC_URL === META_PRODUCTION_ORIGIN && typeof env.CREDENTIALS_KEY === 'string' && env.CREDENTIALS_KEY.length >= 32
    && typeof env.META_CLIENT_SECRET === 'string' && env.META_CLIENT_SECRET.length > 0;
  const requireEnabled = () => {if (!enabled) throw fail('META_PRODUCTION_CLOSED', 503);};
  const productionStore = {get: workspaceId => store.get(workspaceId, {exactSnapshot: true}), save: (...args) => store.save(...args)};
  const load = async session => {const state = await productionStore.get(session.workspaceId); assertMetaDeliveryOwner(state, session); return state;};
  const rpc = session => (name, body, options) => store.metaProductionRpc(name, body, {...options, workspaceId: session.workspaceId});
  const tokenFor = d => createHmac('sha256', env.CREDENTIALS_KEY).update(metaLedgerText({domain: 'runvara-meta-asset/production-v1',
    workspaceId: d.workspaceId, campaignId: d.campaignId, requestId: d.requestId, sha256: d.image.sha256})).digest('hex');
  function approval(state, campaignId, requestId) {
    if (!requestIdValid(requestId)) throw fail('META_PRODUCTION_INPUT_INVALID', 400);
    const found = (state.approvals || []).filter(a => a.id === identity(state.workspace.id, requestId));
    if (!found.length) throw fail('META_PRODUCTION_NOT_FOUND', 404);
    if (found.length !== 1) throw fail('META_PRODUCTION_APPROVAL_CHANGED');
    const a = found[0], b = a.payload?.binding, d = a.payload?.delivery;
    if (a.type !== 'protected_meta_production_publication' || a.payload?.contract !== META_LEDGER_CONTRACT || a.workspaceId !== state.workspace.id
      || !b || b.workspaceId !== state.workspace.id || b.campaignId !== campaignId || b.requestId !== requestId || b.approvalId !== a.id
      || a.payload.bindingDigest !== metaLedgerDigest(b) || !d || b.asset.deliveryDigest !== metaLedgerDigest(d)) throw fail('META_PRODUCTION_APPROVAL_CHANGED');
    return a;
  }
  const asset = (a, session) => readMetaAsset({workspaceId: session.workspaceId, assetId: a.payload.delivery.assetId,
    digest: a.payload.binding.asset.deliveryDigest}, session, {request: rpc(session), loadFreshState: () => load(session)});
  const projection = a => ({requestId: a.payload.binding.requestId, campaignId: a.payload.binding.campaignId, approvalId: a.id,
    status: a.status, binding: clone(a.payload.binding), consent: metaProductionConsent(a.payload.binding),
    expiresAt: a.payload.delivery.expiresAt, enabled, resendPermitted: false});
  function composition(session, binding) {
    const request = rpc(session);
    let pageToken = null, tokenIdentity = null;
    const transport = async (path, options, {signal, checkDeadline, guard}) => {
      requireEnabled();
      const state = await load(session);
      const records = (state.connections || []).filter(c => c.provider === 'meta');
      if (records.length !== 1 || records[0].id !== binding.target.connectionId
        || records[0].metadata?.accountId !== binding.target.account || records[0].status !== 'connected') throw fail('META_PRODUCTION_CONNECTION_CHANGED');
      const credentials = await integrations.connectorCredentials(state, 'meta', {allowRefresh: false});
      if (typeof credentials?.accessToken !== 'string' || !credentials.accessToken || credentials.accessToken.length > 16384) throw fail('META_PRODUCTION_CREDENTIAL_UNAVAILABLE');
      const fingerprint = hash(credentials.accessToken);
      if (tokenIdentity !== fingerprint) {pageToken = null; tokenIdentity = fingerprint;}
      const pageRequest = path === '/' + binding.target.pageId && options.query?.fields === 'id,tasks,instagram_business_account{id}';
      const isPost = options.method === 'POST';
      const validPost = isPost && (path === '/' + binding.target.instagramId + '/media' || path === '/' + binding.target.instagramId + '/media_publish');
      if (isPost && !validPost || !isPost && !pageRequest && !['/me', '/me/permissions', '/' + binding.target.instagramId + '/content_publishing_limit'].includes(path)
        && !/^\/\d{1,32}$/.test(path)) throw fail('META_PRODUCTION_TRANSPORT_INVALID');
      // The documented accounts edge supplies tasks and the Page token in one
      // bounded read. Never follow paging URLs or return tokens to the caller.
      const wirePath = pageRequest ? '/me/accounts' : path;
      const wireOptions = pageRequest ? {query: {fields: 'id,tasks,access_token,instagram_business_account{id}', limit: '100'}} : options;
      const needsPageToken = validPost || !pageRequest && /^\/\d{1,32}$/.test(path);
      if (needsPageToken && !pageToken) throw fail('META_PRODUCTION_PAGE_TOKEN_REQUIRED');
      const envelope = metaRequestEnvelope(wirePath, needsPageToken ? pageToken : credentials.accessToken,
        env.META_CLIENT_SECRET, {...wireOptions, signal});
      await guard(); checkDeadline();
      const response = decodedMetaProductionResponse(await integrations.fetch(envelope.address,
        {...envelope.init, headers: {...envelope.init.headers, 'Accept-Encoding': 'identity'}, signal}), pageRequest ? 262144 : 16384);
      if (!pageRequest && path !== '/me/permissions') return response;
      const value = metaStrictJson(await metaBoundedBytes(() => response, {maxBytes: pageRequest ? 262144 : 16384, mediaType: 'application/json'}));
      checkDeadline();
      if (!value || !Array.isArray(value.data) || value.data.length > (pageRequest ? 100 : 64)
        || Object.keys(value).some(k => !['data', 'paging'].includes(k))) throw fail('META_PRODUCTION_PROVIDER_RESPONSE');
      if (!pageRequest) {
        if (value.paging?.next) throw fail('META_PRODUCTION_PERMISSION_COVERAGE');
        return Response.json({data: value.data});
      }
      const pages = value.data.filter(p => p.id === binding.target.pageId);
      if (pages.length !== 1 || typeof pages[0].access_token !== 'string' || !pages[0].access_token || pages[0].access_token.length > 16384) throw fail('META_PRODUCTION_PAGE_TOKEN_REQUIRED');
      pageToken = pages[0].access_token;
      const {id, tasks, instagram_business_account} = pages[0];
      return Response.json({id, tasks, instagram_business_account});
    };
    return createMetaSingleImageProduction({environment: 'production', store: productionStore, request, transport,
      fetchAsset: async (url, options) => {
        requireEnabled();
        if (!/^https:\/\/packsmart-ops\.onrender\.com\/api\/meta-publication-assets\/production-v1\/[a-f0-9]{64}\/[a-f0-9]{64}\.jpg$/.test(url)) throw fail('META_PRODUCTION_ASSET_URL');
        return decodedMetaProductionResponse(await integrations.fetch(url,
          {...options, headers: {...options.headers, 'Accept-Encoding': 'identity'}}), 2097152);
      }});
  }
  async function getApproval(campaignId, requestId, session) {return approval(await load(session), campaignId, requestId);}
  async function read(campaignId, requestId, session) {
    const a = await getApproval(campaignId, requestId, session);
    if (!durable) throw fail('META_PRODUCTION_CLOSED', 503);
    const retained = await readMetaSingleImageProduction(composition(session, a.payload.binding), a.payload.binding, session);
    const fresh = await getApproval(campaignId, requestId, session);
    if (metaLedgerText(fresh.payload.binding) !== metaLedgerText(a.payload.binding)) throw fail('META_PRODUCTION_APPROVAL_CHANGED');
    return {...projection(fresh), retained: {...retained, publishingEnabled: enabled}};
  }
  return Object.freeze({
    enabled,
    async context(campaignId, session) {const state = await load(session); return {...metaPublicationChoices(state, campaignId, session), enabled,
      notice: enabled ? 'Review one exact JPEG, caption and Instagram destination. Approval and publishing are separate actions.' : 'Production publication is closed. Existing proposals can still be reviewed when their database contracts are available.'};},
    async prepare(campaignId, body, session) {
      requireEnabled(); exact(body, ['requestId', 'selection', 'jpegBase64', 'expiresAt']);
      if (!requestIdValid(body.requestId) || typeof body.jpegBase64 !== 'string' || body.jpegBase64.length > 2796204
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.jpegBase64) || !Number.isSafeInteger(body.expiresAt)) throw fail('META_PRODUCTION_INPUT_INVALID', 400);
      const bytes = Buffer.from(body.jpegBase64, 'base64');
      if (bytes.toString('base64') !== body.jpegBase64 || bytes.length < 100 || bytes.length > 2097152) throw fail('META_PRODUCTION_INPUT_INVALID', 400);
      const state = await load(session), old = (state.approvals || []).find(a => a.id === identity(session.workspaceId, body.requestId));
      if (old) {
        const a = approval(state, campaignId, body.requestId), d = a.payload.delivery;
        if (metaLedgerText(d.selection) !== metaLedgerText(body.selection) || d.image.sha256 !== hash(bytes)
          || d.expiresAt !== body.expiresAt || metaLedgerText(d.actor) !== metaLedgerText({userId: session.userId, sessionVersion: session.sessionVersion})) throw fail('META_PRODUCTION_REQUEST_CONFLICT');
        return {...projection(a), replayed: true};
      }
      const token = tokenFor({workspaceId: session.workspaceId, campaignId, requestId: body.requestId, image: {sha256: hash(bytes)}});
      const command = await prepareMetaAssetProduction(campaignId, body.selection, session, bytes, {environment: 'production', requestId: body.requestId,
        origin: META_PRODUCTION_ORIGIN, token, expiresAt: body.expiresAt}, {loadFreshState: () => load(session)});
      const retained = await commitMetaAsset(command, {request: rpc(session), loadFreshState: () => load(session)});
      // Preparation has no credential or provider call. The binding is generated
      // by the existing source/cost checks from current server state.
      await prepareMetaSingleImageProduction(composition(session, null), retained, campaignId, body.selection, session, body.requestId);
      return {...projection(await getApproval(campaignId, body.requestId, session)), replayed: false};
    },
    read,
    async image(campaignId, requestId, session) {
      const a = await getApproval(campaignId, requestId, session), retained = await asset(a, session);
      await load(session); return {mediaType: 'image/jpeg', sha256: metaAssetDescriptor(retained).image.sha256,
        bytesBase64: metaAssetReviewBytes(retained).toString('base64')};
    },
    async decide(campaignId, requestId, body, session) {
      exact(body, ['decision', 'consent']);
      if (!['approved', 'rejected'].includes(body.decision)) throw fail('META_PRODUCTION_INPUT_INVALID', 400);
      if (body.decision === 'approved') requireEnabled();
      const state = await load(session), a = approval(state, campaignId, requestId), binding = a.payload.binding;
      if (metaLedgerText(body.consent) !== metaLedgerText(metaProductionConsent(binding))) throw fail('META_PRODUCTION_CONSENT_CHANGED');
      if (a.status !== 'pending' && !(a.status === 'approved' && body.decision === 'rejected')) throw fail('META_PRODUCTION_ALREADY_DECIDED');
      if (body.decision === 'approved') assertMetaAssetSource(await asset(a, session), state, session);
      Object.assign(a, {status: body.decision, decidedAt: new Date().toISOString(), decidedBy: session.userId,
        metaProductionConsent: clone(body.consent)});
      a.history = [...(a.history || []), {revision: a.revision, status: a.status, actor: session.userId, at: a.decidedAt}];
      addAudit(state, {type: 'meta_production_decided', actor: session.userId, detail: {approvalId: a.id, bindingDigest: metaLedgerDigest(binding), decision: a.status}});
      const expected = contentWriteSnapshot(a), priorRevision = state._revision;
      const saved = await store.save(session.workspaceId, state, {ownedSnapshot: true, beforeCommit: next => {
        assertMetaDeliveryOwner(next, session);
        if (contentWriteSnapshot(approval(next, campaignId, requestId)) !== expected) throw fail('META_PRODUCTION_APPROVAL_CHANGED');
      }});
      if (!saved || saved._revision === priorRevision) throw fail('META_PRODUCTION_DECISION_UNKNOWN');
      return projection(approval(saved, campaignId, requestId));
    },
    async execute(campaignId, requestId, body, session) {
      requireEnabled(); exact(body, ['consent']);
      const a = await getApproval(campaignId, requestId, session), b = a.payload.binding;
      if (a.status !== 'approved' || metaLedgerText(body.consent) !== metaLedgerText(metaProductionConsent(b))) throw fail('META_PRODUCTION_CONSENT_CHANGED');
      const retained = await asset(a, session), d = metaAssetDescriptor(retained);
      const result = await executeMetaSingleImageProduction(composition(session, b), b, retained, tokenFor(d), session);
      await load(session); return result;
    },
    async deliver(digest, token) {
      requireEnabled();
      return serveMetaAssetProduction({digest, token}, {request: (name, body, options) => store.metaProductionRpc(name, body, {...options, workspaceId: null}),
        loadFreshState: workspaceId => productionStore.get(workspaceId)});
    }
  });
}
