import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';
import { prepareApprovalRequest, createApprovalRequest, findApprovalRequest } from './approval-request.mjs';
import { addAudit, recordWork } from './events.mjs';

export const PILOT_SCHEMA = 'runvara-quiet-approval-pilot/v1';
export const PILOT_SOURCE = 'maintenance-contract-pilot/v1';
export const PILOT_BASE = '/api/maintenance/approval-pilot/';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
const same = (a, b) => isDeepStrictEqual(a, b);
const note = 'Maintenance acceptance test rejected; no external action.';
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && same(Object.keys(value).sort(), [...expected].sort());
export const isMaintenanceApproval = approval => approval?.source === PILOT_SOURCE
  || approval?.payload?.maintenancePilot === PILOT_SCHEMA;

export function createQuietApprovalPilot(env, { now = Date.now, monotonic = () => performance.now() } = {}) {
  const raw = env.RUNVARA_QUIET_APPROVAL_PILOT;
  if (raw === undefined || raw === 'disabled/v1') return null;
  let d;
  try { d = JSON.parse(raw); } catch { throw fail('QUIET_APPROVAL_PILOT_INVALID', 500); }
  const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  if (typeof raw !== 'string' || !keys(d, ['schema', 'workspaceId', 'ownerId', 'requestId', 'notBefore', 'expiresAt'])
    || d.schema !== PILOT_SCHEMA || typeof d.workspaceId !== 'string' || typeof d.ownerId !== 'string'
    || !SCOPE.test(d.workspaceId) || !SCOPE.test(d.ownerId)
    || !UUID.test(d.requestId || '') || !timestamp(d.notBefore) || !timestamp(d.expiresAt)
    || Date.parse(d.expiresAt) <= Date.parse(d.notBefore) || Date.parse(d.expiresAt) - Date.parse(d.notBefore) > 600000
    || env.RUNVARA_STARTUP_MODE !== 'quiet'
    || ![undefined, 'disabled/v1'].includes(env.RUNVARA_QUIET_OWNER_LOGIN)
    || ![undefined, 'disabled/v1'].includes(env.RUNVARA_QUIET_COMMERCE_PREVIEW)) throw fail('QUIET_APPROVAL_PILOT_INVALID', 500);
  d = Object.freeze(d);
  const startWall = now(), startMono = monotonic(), end = Date.parse(d.expiresAt), begin = Date.parse(d.notBefore);
  let lastWall = startWall, closed = false, writesStopped = false;
  function available() {
    const wall = now(), mono = monotonic();
    if (!Number.isFinite(wall) || !Number.isFinite(mono) || wall < lastWall || mono < startMono
      || wall >= end || mono - startMono >= Math.max(0, end - startWall)) closed = true;
    lastWall = Math.max(lastWall, wall);
    return !closed && wall >= begin;
  }
  function assertOpen(write = false) {
    if (!available() || write && writesStopped) throw fail('MAINTENANCE_PILOT_CLOSED', 503);
  }
  function matches(session) { return session?.workspaceId === d.workspaceId && session?.sub === d.ownerId; }
  return Object.freeze({ descriptor: d, available, matches,
    status: () => ({ open: available() && !writesStopped, expiresAt: d.expiresAt }),
    assertOpen, stopWrites: () => { writesStopped = true; }, close: () => { closed = true; },
    assertScope(session) { assertOpen(); if (!matches(session)) throw fail('MAINTENANCE_PILOT_SCOPE_DENIED', 403); },
    metadata(auth) {
      if (!available() || !matches(auth?.session) || auth?.user?.role !== 'owner' || auth.user.active === false
        || auth.user.passwordChangeRequired !== false) return null;
      return { schema: PILOT_SCHEMA, requestId: d.requestId, expiresAt: d.expiresAt, writable: !writesStopped };
    }
  });
}

export function pilotIntent(pilot) {
  return prepareApprovalRequest({ requestId: pilot.descriptor.requestId, type: 'customer_facing_publish',
    action: 'Maintenance acceptance test — reject only', reason: 'Synthetic persistence acceptance; no business action.',
    expectedBenefit: 'Verify retained request and rejection.', risk: 'No external action is permitted.',
    financialImpact: null, source: PILOT_SOURCE, payload: { maintenancePilot: PILOT_SCHEMA }, evidence: [] }, pilot.descriptor.ownerId);
}

function actor(pilot, state, auth, intent) {
  pilot.assertScope(auth.session);
  if (auth.user.role !== 'owner') throw fail('OWNER_APPROVAL_REQUIRED', 403);
  // findApprovalRequest also checks exact tenant, unique actor, current role,
  // session version, password setup and retained request binding.
  return findApprovalRequest(state, auth, intent);
}
function retained(pilot, state, auth, intent) {
  const approval = actor(pilot, state, auth, intent);
  if (!approval) return null;
  const normalized = prepareApprovalRequest({ ...approval, requestId: intent.requestId }, auth.session.sub);
  if (normalized.contentSha256 !== intent.contentSha256 || approval.revision !== 1 || approval.executedExternally !== false
    || approval.executionStatus !== 'not_connected' || !['pending', 'rejected'].includes(approval.status)
    || (state.connectionWrites || []).some(w => w.approvalId === approval.id)
    || !same(approval.payload, { maintenancePilot: PILOT_SCHEMA })) throw fail('MAINTENANCE_PILOT_RECORD_CHANGED');
  if (approval.status === 'pending' && (approval.decidedAt !== null || approval.decidedBy !== null
    || approval.decisionNote !== null || approval.history?.length !== 0 || approval.maintenanceDecision !== undefined)) throw fail('MAINTENANCE_PILOT_RECORD_CHANGED');
  if (approval.status === 'rejected') {
    const binding = { schema: PILOT_SCHEMA, requestId: intent.requestId, approvalId: approval.id,
      revision: 1, workspaceId: auth.session.workspaceId, actorId: auth.session.sub, decision: 'rejected' };
    if (!same(approval.maintenanceDecision, binding) || approval.decidedBy !== auth.session.sub
      || approval.decisionNote !== note || typeof approval.decidedAt !== 'string' || !Number.isFinite(Date.parse(approval.decidedAt))
      || approval.workStatus !== 'COMPLETED' || !same(approval.history, [{ revision: 1, status: 'rejected',
        actor: auth.session.sub, at: approval.decidedAt, note }])) throw fail('MAINTENANCE_PILOT_RECORD_CHANGED');
  }
  return approval;
}

// Only this opt-in caller may accept the listed ordinary-save transformations.
// Optional complex history compaction is refused, not reimplemented here.
function saveChecks(pilot, proposed, assertActive) {
  const baseline = structuredClone(proposed);
  function stable(state) {
    const copy = structuredClone(state);
    delete copy._revision; delete copy.storageReady;
    if (copy.workspace) delete copy.workspace.updatedAt;
    if (copy.integrationStatus) { delete copy.integrationStatus.supabase; delete copy.integrationStatus.reporting; }
    // Ordinary retention materializes an absent, empty sync history.
    if (copy.connectionSyncs === undefined) copy.connectionSyncs = [];
    delete copy.audit; delete copy.workRecords;
    return copy;
  }
  const fingerprint = stable(baseline);
  const check = (state, beforeEffects) => {
    pilot.assertOpen(true); assertActive();
    if (!same(stable(state), fingerprint)
      || !(same(state.audit, baseline.audit) || !beforeEffects && same(state.audit, baseline.audit.slice(0, 300)))
      || !(same(state.workRecords, baseline.workRecords) || !beforeEffects && same(state.workRecords, baseline.workRecords.slice(0, 100)))) throw fail('MAINTENANCE_PILOT_STATE_CHANGED');
  };
  return {
    beforeEffects(state, plans = {}) {
      check(state, true);
      if (plans.automationArchives || plans.briefArchives || (state.connectionSyncs || []).length > 100
        || (state.agentRuns || []).length > 1 || (state.dailyBriefs || []).length > 30
        || (state.dailyBriefs || []).some(b => Buffer.byteLength(JSON.stringify(b)) > 65536)) throw fail('MAINTENANCE_PILOT_RETENTION_UNSUPPORTED');
    },
    beforeCommit(state) { check(state, false); }
  };
}

export async function runQuietApprovalPilot({ pilot, store, auth, operation, body, assertActive = () => {} }) {
  if (!pilot || store.provider !== 'supabase') throw fail('MAINTENANCE_PILOT_UNAVAILABLE', 503);
  pilot.assertScope(auth.session); assertActive();
  const expectedKeys = operation === 'reject' ? ['requestId', 'approvalId', 'revision', 'decision'] : ['requestId'];
  if (!['request', 'reconcile', 'reject'].includes(operation) || !keys(body, expectedKeys)
    || body.requestId !== pilot.descriptor.requestId || operation === 'reject'
      && (body.decision !== 'rejected' || body.revision !== 1 || typeof body.approvalId !== 'string')) throw fail('MAINTENANCE_PILOT_INPUT_INVALID', 400);
  const intent = pilotIntent(pilot), workspaceId = auth.session.workspaceId;
  const read = () => store.get(workspaceId, { exactSnapshot: true });
  const response = (approval, replayed = false) => ({ schema: PILOT_SCHEMA, requestId: intent.requestId,
    found: Boolean(approval), approval: approval ? { id: approval.id, status: approval.status, revision: 1 } : null,
    replayed, executedExternally: false, maintenance: true });
  let mutationAttempted = false;
  try {
    const state = await read(); const existing = retained(pilot, state, auth, intent);
    if (operation === 'reconcile') { assertActive(); return response(existing); }
    if (operation === 'request') {
      if (existing) return response(existing, true);
      pilot.assertOpen(true);
      const result = await createApprovalRequest({ store, auth, intent,
        admit(fresh) { pilot.assertOpen(true); assertActive(); retained(pilot, fresh, auth, intent); },
        beforeSave: proposed => { mutationAttempted = true; return saveChecks(pilot, proposed, assertActive); } });
      const confirmed = retained(pilot, await read(), auth, intent); assertActive();
      if (!confirmed || confirmed.id !== result.approval.id) throw fail('APPROVAL_REQUEST_OUTCOME_UNKNOWN', 503);
      return response(confirmed, result.replayed);
    }
    if (!existing || existing.id !== body.approvalId) throw fail('MAINTENANCE_PILOT_RECORD_CHANGED');
    if (existing.status === 'rejected') return response(existing, true);
    pilot.assertOpen(true);
    const approval = existing;
    approval.status = 'rejected'; approval.decidedAt = new Date().toISOString(); approval.decidedBy = auth.session.sub;
    approval.decisionNote = note; approval.workStatus = 'COMPLETED';
    approval.history = [{ revision: 1, status: 'rejected', actor: auth.session.sub, at: approval.decidedAt, note }];
    approval.maintenanceDecision = { schema: PILOT_SCHEMA, requestId: intent.requestId, approvalId: approval.id,
      revision: 1, workspaceId, actorId: auth.session.sub, decision: 'rejected' };
    if ((state.workRecords || []).some(w => w.id === approval.id)) throw fail('MAINTENANCE_PILOT_RECORD_CHANGED');
    recordWork(state, { id: approval.id, title: approval.action, source: 'approval-centre', status: 'COMPLETED',
      evidence: [{ type: 'approval_decision', id: approval.id, detail: 'rejected; external execution unavailable' }], executedExternally: false });
    addAudit(state, { type: 'approval_decided', actor: auth.session.sub, detail: { approvalId: approval.id, decision: 'rejected', executedExternally: false } });
    const guards = saveChecks(pilot, state, assertActive);
    let acknowledged = false;
    mutationAttempted = true;
    try { await store.save(workspaceId, state, { ownedSnapshot: true, ...guards }); acknowledged = true; }
    catch { /* A write may have committed. Never replay the decision callback. */ }
    let confirmed;
    try { confirmed = retained(pilot, await read(), auth, intent); }
    catch (e) { if (['SESSION_INVALID', 'OWNER_APPROVAL_REQUIRED', 'MAINTENANCE_PILOT_RECORD_CHANGED'].includes(e.code)) throw e; throw fail('MAINTENANCE_PILOT_OUTCOME_UNKNOWN', 503); }
    assertActive();
    if (confirmed?.status !== 'rejected' || confirmed.id !== approval.id) throw fail('MAINTENANCE_PILOT_OUTCOME_UNKNOWN', 503);
    pilot.stopWrites(); return response(confirmed, !acknowledged);
  } catch (error) {
    pilot.stopWrites();
    // Expiry or disconnect cannot prove an admitted save did not commit.
    if (mutationAttempted && ['MAINTENANCE_PILOT_CLOSED', 'MAINTENANCE_PILOT_INTERRUPTED'].includes(error.code)) {
      throw fail(operation === 'request' ? 'APPROVAL_REQUEST_OUTCOME_UNKNOWN' : 'MAINTENANCE_PILOT_OUTCOME_UNKNOWN', 503);
    }
    throw error;
  }
}
