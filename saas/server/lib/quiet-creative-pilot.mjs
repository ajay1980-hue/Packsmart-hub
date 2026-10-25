import { isDeepStrictEqual as same } from 'node:util';
import { performance } from 'node:perf_hooks';
import { createCreativeIssuer } from './creative-allowance.mjs';
import { creativeDigest, createCreativeLifecycle } from './creative-safety.mjs';
import { runwayCreativeInput, startRunwayCreative, refreshRunwayCreative } from './marketing-providers.mjs';
import { marketingRuntimeEnv } from './marketing.mjs';
import { addAudit } from './events.mjs';

export const CREATIVE_PILOT_SCHEMA = 'runvara-quiet-creative-pilot/v1';
export const CREATIVE_PILOT_BASE = '/api/maintenance/creative-pilot/';
export const creativePilotAction = (method, path) => method === 'GET' && path === CREATIVE_PILOT_BASE + 'review'
  || method === 'POST' && ['prepare', 'decide', 'submit', 'observe'].some(op => path === CREATIVE_PILOT_BASE + op);
const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/, HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const exact = (o, fields) => o && typeof o === 'object' && !Array.isArray(o) && same(Object.keys(o).sort(), [...fields].sort());
const disabled = value => value === undefined || value === 'disabled/v1';

export function createQuietCreativePilot(env, { now = Date.now, monotonic = () => performance.now() } = {}) {
  const raw = env.RUNVARA_QUIET_CREATIVE_PILOT;
  if (disabled(raw)) return null;
  let d;
  try { d = JSON.parse(raw); } catch { throw fail('QUIET_CREATIVE_PILOT_INVALID', 500); }
  const ids = ['workspaceId', 'ownerId', 'campaignId', 'requestId', 'providerAccountId', 'policyRevision', 'priceRevision'];
  const hashes = ['inputDigest', 'sourceDigest', 'payloadDigest', 'accountBinding'];
  const stamp = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
    && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
  if (typeof raw !== 'string' || !exact(d, ['schema', ...ids, ...hashes, 'operationId', 'maxCostMicros', 'notBefore', 'expiresAt'])
    || d.schema !== CREATIVE_PILOT_SCHEMA || ids.some(k => typeof d[k] !== 'string' || !ID.test(d[k]))
    || hashes.some(k => typeof d[k] !== 'string' || !HASH.test(d[k])) || !UUID.test(d.operationId || '')
    || !Number.isSafeInteger(d.maxCostMicros) || d.maxCostMicros <= 0 || !stamp(d.notBefore) || !stamp(d.expiresAt)
    || Date.parse(d.expiresAt) <= Date.parse(d.notBefore) || Date.parse(d.expiresAt) - Date.parse(d.notBefore) > 600000
    || env.RUNVARA_STARTUP_MODE !== 'quiet'
    || ['RUNVARA_QUIET_OWNER_LOGIN', 'RUNVARA_QUIET_COMMERCE_PREVIEW', 'RUNVARA_QUIET_APPROVAL_PILOT',
      'RUNVARA_META_PUBLICATION', 'RUNVARA_CREATIVE_ALLOWANCES'].some(k => !disabled(env[k]))) throw fail('QUIET_CREATIVE_PILOT_INVALID', 500);
  d = Object.freeze(d);
  const startWall = now(), startMono = monotonic(), begin = Date.parse(d.notBefore), end = Date.parse(d.expiresAt);
  let lastWall = startWall, closed = false, stopped = false;
  function available() {
    const wall = now(), mono = monotonic();
    if (!Number.isFinite(wall) || !Number.isFinite(mono) || wall < lastWall || mono < startMono || wall >= end
      || mono - startMono >= Math.max(0, end - startWall)) closed = true;
    lastWall = Math.max(lastWall, wall);
    return !closed && wall >= begin;
  }
  const matches = session => session?.workspaceId === d.workspaceId && session?.sub === d.ownerId;
  function assertOpen(write = false) { if (!available() || write && stopped) throw fail('MAINTENANCE_CREATIVE_CLOSED', 503); }
  return Object.freeze({ descriptor: d, now, available, assertOpen, matches,
    assertScope(session) { assertOpen(); if (!matches(session)) throw fail('MAINTENANCE_CREATIVE_SCOPE_DENIED', 403); },
    stopWrites() { stopped = true; }, close() { closed = true; },
    status: () => ({ open: available() && !stopped, expiresAt: d.expiresAt }),
    metadata(auth) {
      if (!available() || !matches(auth?.session) || auth?.user?.role !== 'owner' || auth.user.active === false
        || auth.user.passwordChangeRequired !== false) return null;
      return { schema: d.schema, campaignId: d.campaignId, requestId: d.requestId, expiresAt: d.expiresAt,
        writable: !stopped, maxCostMicros: d.maxCostMicros, currency: 'USD', providerAccountId: d.providerAccountId,
        priceRevision: d.priceRevision, inputDigest: d.inputDigest, operationId: d.operationId };
    }
  });
}

function target(pilot, state, auth, env) {
  const d = pilot.descriptor;
  if (state?.workspace?.id !== d.workspaceId || !pilot.matches(auth.session)) throw fail('MAINTENANCE_CREATIVE_SCOPE_DENIED', 403);
  const users = state.users?.filter(u => u.id === d.ownerId) || [], user = users[0];
  if (users.length !== 1 || user.role !== 'owner' || user.active === false || user.passwordChangeRequired !== false
    || Number(user.sessionVersion || 1) !== Number(auth.session.sessionVersion)) throw fail('SESSION_INVALID', 401);
  const campaigns = state.marketing?.campaigns?.filter(c => c.id === d.campaignId) || [];
  const requests = campaigns[0]?.creativeRequests?.filter(r => r.id === d.requestId) || [];
  const campaign = campaigns[0], request = requests[0];
  if (campaigns.length !== 1 || requests.length !== 1 || request.provider !== 'runway' || request.kind !== 'product_video'
    || request.safety?.origin !== 'server_created' || request.safety.workspaceId !== d.workspaceId
    || request.safety.campaignId !== d.campaignId || request.safety.requestId !== d.requestId
    || request.safety.provider !== 'runway' || request.jobId || request.assetId || request.designId
    || Object.keys(request.safety.phases || {}).some(p => p !== 'generation')
    || state.marketing.providers?.runway?.status === 'disconnected') throw fail('MAINTENANCE_CREATIVE_TARGET_INVALID');
  const runtime = marketingRuntimeEnv(state, env);
  if (!runtime.RUNWAY_API_KEY || !campaign.product?.image) throw fail('MAINTENANCE_CREATIVE_PROVIDER_UNAVAILABLE');
  // The approved source is the original pending request; progress fields do
  // not alter its immutable product/copy binding after a confirmed submission.
  const original = { ...request, status: 'pending' };
  delete original.stage; delete original.taskId;
  const input = runwayCreativeInput(campaign, original, runtime);
  const digest = creativeDigest({ workspaceId: d.workspaceId, campaignId: d.campaignId, requestId: d.requestId,
    provider: 'runway', phase: 'generation', endpoint: input.endpoint, payloadDigest: input.payloadDigest,
    accountBinding: input.accountBinding, sourceDigest: input.sourceDigest });
  if (digest !== d.inputDigest || ['sourceDigest','payloadDigest','accountBinding'].some(k => input[k] !== d[k])) throw fail('MAINTENANCE_CREATIVE_INPUT_CHANGED');
  return { campaign, request, runtime, input };
}

function checkRow(pilot, row) {
  const d = pilot.descriptor;
  if (!row || row.approvalType !== 'creative_phase/v1' || row.provider !== 'runway' || row.phase !== 'generation'
    || row.currency !== 'USD' || ['workspaceId','campaignId','requestId','inputDigest','accountBinding','providerAccountId',
      'priceRevision','policyRevision','maxCostMicros'].some(k => row[k] !== d[k])
    || creativeDigest(row.sourcePreview) !== d.sourceDigest || creativeDigest(row.payloadPreview) !== d.payloadDigest
    || Date.parse(row.expiresAt) > Date.parse(d.expiresAt) || Date.parse(row.expiresAt) <= pilot.now()) throw fail('MAINTENANCE_CREATIVE_POLICY_CHANGED');
  return row;
}

function saveGuards(pilot, initial, proposed, assertActive, admitted) {
  const d = pilot.descriptor, expected = structuredClone(proposed);
  function stable(value) {
    const c = structuredClone(value);
    delete c._revision; delete c.storageReady; delete c.audit;
    if (c.workspace) delete c.workspace.updatedAt;
    if (c.integrationStatus) { delete c.integrationStatus.supabase; delete c.integrationStatus.reporting; }
    if (c.connectionSyncs === undefined) c.connectionSyncs = [];
    const request = c.marketing?.campaigns?.find(x => x.id === d.campaignId)?.creativeRequests?.find(x => x.id === d.requestId);
    if (!request) throw fail('MAINTENANCE_CREATIVE_TARGET_INVALID');
    for (const k of ['status','stage','taskId','assetUrls','startedAt','completedAt','progress','blockReason','ownerAction','lastPollError','failureConfirmed','formats','errorCode']) delete request[k];
    delete request.safety.phases.generation;
    return c;
  }
  const baseline = stable(initial);
  const expectedRequest = expected.marketing.campaigns.find(c => c.id === d.campaignId).creativeRequests.find(r => r.id === d.requestId);
  const check = (value, before) => {
    if (!admitted()) { pilot.assertOpen(true); assertActive(); }
    const actualRequest = value.marketing?.campaigns?.find(c => c.id === d.campaignId)?.creativeRequests?.find(r => r.id === d.requestId);
    if (!same(actualRequest, expectedRequest) || !same(stable(value), baseline)
      || !(same(value.audit, expected.audit) || !before && same(value.audit, expected.audit.slice(0, 300)))) throw fail('MAINTENANCE_CREATIVE_STATE_CHANGED');
  };
  return { beforeEffects(value, plans = {}) {
    check(value, true);
    if (plans.automationArchives || plans.briefArchives || (value.connectionSyncs || []).length > 100
      || (value.agentRuns || []).length > 1 || (value.dailyBriefs || []).length > 30
      || (value.dailyBriefs || []).some(b => Buffer.byteLength(JSON.stringify(b)) > 65536)
      || (value.workRecords || []).length > 100) throw fail('MAINTENANCE_CREATIVE_RETENTION_UNSUPPORTED');
  }, beforeCommit(value) { check(value, false); } };
}

// Called under the existing workspace lock. No general campaign cycle, token
// refresh, scheduler, new request creation or browser policy provisioning.
export async function runQuietCreativePilot({ pilot, store, auth, env, operation, body, assertActive = () => {}, fetchImpl = fetch }) {
  if (!pilot || store.provider !== 'supabase' || typeof store.creativeAllowanceRpc !== 'function') throw fail('MAINTENANCE_CREATIVE_UNAVAILABLE', 503);
  pilot.assertScope(auth.session);
  if (!['review','prepare','decide','submit','observe'].includes(operation)
    || !exact(body, operation === 'decide' ? ['requestId','approvalId','revision','decision'] : ['requestId'])
    || body.requestId !== pilot.descriptor.requestId
    || operation === 'decide' && (typeof body.approvalId !== 'string' || !ID.test(body.approvalId)
      || !Number.isSafeInteger(body.revision) || body.revision < 1 || !['approved','revoked'].includes(body.decision))) throw fail('MAINTENANCE_CREATIVE_INPUT_INVALID', 400);
  const d = pilot.descriptor;
  let attempted = false, admitted = false;
  const check = () => { pilot.assertOpen(operation !== 'review'); assertActive(); };
  try {
    check();
    const state = await store.get(d.workspaceId, { exactSnapshot: true }); check();
    const initial = structuredClone(state), { campaign, request, runtime, input } = target(pilot, state, auth, env);
    const rows = await store.creativeAllowanceRpc('review', d.workspaceId, { auth, requestId: d.requestId }); check();
    if (!Array.isArray(rows) || rows.length > 1) throw fail('MAINTENANCE_CREATIVE_RECORD_CHANGED');
    let row = rows.length ? checkRow(pilot, rows[0]) : null;
    const response = () => ({ schema: CREATIVE_PILOT_SCHEMA, maintenance: true, requestId: d.requestId,
      allowance: row, status: request.status, taskId: request.taskId || null, assetUrls: request.assetUrls || [],
      writable: pilot.status().open, expiresAt: d.expiresAt });
    if (operation === 'review') return response();
    if (operation === 'decide') {
      if (!row || row.id !== body.approvalId || row.revision !== body.revision) throw fail('MAINTENANCE_CREATIVE_RECORD_CHANGED');
      attempted = true;
      row = checkRow(pilot, await store.creativeAllowanceRpc('decide', d.workspaceId, { auth, approvalId: row.id, revision: row.revision, decision: body.decision }));
      check(); if (body.decision === 'revoked') pilot.stopWrites(); return response();
    }
    if (operation !== 'observe' && (request.status !== 'pending' || request.stage || request.taskId || request.safety.phases.generation)) throw fail('CREATIVE_SUBMISSION_ALREADY_CLAIMED');
    if (operation === 'prepare' && row) return response();
    if (operation === 'submit' && (!row || row.status !== 'approved' || row.reservationStatus)) throw fail('CREATIVE_ALLOWANCE_REQUIRED');
    const claim = request.safety.phases.generation;
    if (operation === 'observe' && (!row || !request.taskId || row.upstreamId !== request.taskId
      || !claim || claim.inputDigest !== d.inputDigest || claim.upstreamId !== request.taskId
      || !['accepted','completed'].includes(claim.status) || !['in_progress','complete','failed'].includes(request.status))) throw fail('MAINTENANCE_CREATIVE_TASK_UNVERIFIED');
    if (operation === 'observe' && ['complete','failed'].includes(request.status)) { pilot.close(); return response(); }
    if (operation === 'observe' && (claim.maintenanceObservationAttempts !== undefined
      && (!Number.isSafeInteger(claim.maintenanceObservationAttempts) || claim.maintenanceObservationAttempts < 0)
      || (claim.maintenanceObservationAttempts || 0) >= 5)) throw fail('MAINTENANCE_CREATIVE_READ_LIMIT');
    const prepared = operation === 'prepare' ? [] : null;
    // Only this sealed quiet capability activates the shared issuer locally.
    // The process-wide flag stays disabled and general routes stay closed.
    const issuer = createCreativeIssuer({ store, state, env: { ...env, RUNVARA_CREATIVE_ALLOWANCES: 'enabled/v1' },
      auth, operationId: d.operationId, prepared });
    const authorize = async (binding, context) => {
      check();
      if (binding.inputDigest !== d.inputDigest || context.sourceDigest !== d.sourceDigest || context.payloadDigest !== d.payloadDigest
        || context.accountBinding !== d.accountBinding) throw fail('MAINTENANCE_CREATIVE_INPUT_CHANGED');
      attempted = true;
      const allowance = await issuer(binding, context); check();
      if (prepared) { row = checkRow(pilot, prepared[0]); return null; }
      if (!allowance?.allowed || allowance.inputDigest !== d.inputDigest || allowance.maxCostMicros !== d.maxCostMicros
        || allowance.policyRevision !== d.policyRevision || allowance.approvalId !== row.id || allowance.approvalRevision !== row.revision
        || Date.parse(allowance.expiresAt) !== Date.parse(row.expiresAt)
        || Date.parse(allowance.expiresAt) > Date.parse(d.expiresAt)) throw fail('MAINTENANCE_CREATIVE_POLICY_CHANGED');
      return allowance;
    };
    authorize.confirmDispatch = async phase => { check(); await issuer.confirmDispatch(phase); check(); };
    // Already admitted work may finish after expiry/disconnect; preserve its
    // exact receipt and hold rather than throwing the evidence away.
    authorize.recordOutcome = (...args) => issuer.recordOutcome(...args);
    const persist = async () => {
      attempted = true;
      addAudit(state, { type: 'maintenance_creative_saved', actor: d.ownerId, detail: { requestId: d.requestId,
        phase: 'generation', status: request.safety.phases.generation?.status || request.status } });
      return store.save(d.workspaceId, state, { ownedSnapshot: true, ...saveGuards(pilot, initial, state, assertActive, () => admitted) });
    };
    const transport = async (url, options = {}) => {
      check();
      const method = options.method || 'GET';
      if (!(operation === 'submit' && method === 'POST' && url === input.endpoint && options.body === input.body
        || operation === 'observe' && method === 'GET' && url === 'https://api.dev.runwayml.com/v1/tasks/' + encodeURIComponent(request.taskId))) throw fail('MAINTENANCE_CREATIVE_TRANSPORT_DENIED');
      if (operation === 'observe') {
        // Persist the read intent before transport. A lost acknowledgement or
        // process restart consumes this slot; it never creates an extra retry.
        claim.maintenanceObservationAttempts = (claim.maintenanceObservationAttempts || 0) + 1;
        await persist();
      }
      const fresh = await store.get(d.workspaceId, { exactSnapshot: true });
      target(pilot, fresh, auth, env);
      if (fresh._revision !== state._revision) throw fail('MAINTENANCE_CREATIVE_STATE_CHANGED');
      check();
      // The exact protected approval can end before the maintenance window.
      // This final asynchronous read must not carry it across that deadline.
      if (Date.parse(row.expiresAt) <= pilot.now()) throw fail('CREATIVE_ALLOWANCE_EXPIRED');
      admitted = true;
      return fetchImpl(url, options);
    };
    const lifecycle = createCreativeLifecycle({ state, campaign, request, persist, durableStore: true, authorizePhase: authorize, now: pilot.now });
    if (operation === 'observe') await refreshRunwayCreative(campaign, request, runtime, { lifecycle, fetchImpl: transport });
    else await startRunwayCreative(campaign, runtime, { request, lifecycle, fetchImpl: transport,
      resolveRuntimeEnv: () => marketingRuntimeEnv(state, env) });
    if (operation === 'prepare' && !row) throw fail('MAINTENANCE_CREATIVE_PREPARATION_FAILED');
    if (operation !== 'prepare' && (request.blockReason || request.lastPollError)) throw fail(request.blockReason || request.lastPollError, 503);
    if (operation !== 'prepare') {
      row = checkRow(pilot, (await store.creativeAllowanceRpc('review', d.workspaceId, { auth, requestId: d.requestId }))[0]);
      if (['complete','failed'].includes(request.status)) pilot.close();
    }
    return response();
  } catch (cause) {
    pilot.stopWrites();
    if (attempted && !cause.creativePersistenceFailure) {
      const uncertain = fail('MAINTENANCE_CREATIVE_OUTCOME_UNKNOWN', 503); uncertain.causeCode = cause.code; throw uncertain;
    }
    throw cause;
  }
}
