import { createHash } from 'node:crypto';
import { normalizeApprovalRequest } from './operations.mjs';
import { addAudit } from './events.mjs';
import { evidenceInWorkspace } from './business-evidence-scope.mjs';

const SCHEMA = 'runvara-approval-request/v1';
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fields = ['type', 'action', 'reason', 'financialImpact', 'expectedBenefit', 'risk', 'source', 'payload', 'evidence', 'agentId'];
const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
function canonical(value, depth = 0) {
  if (depth > 24) throw fail('APPROVAL_REQUEST_INPUT_INVALID', 400);
  if (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object') throw fail('APPROVAL_REQUEST_INPUT_INVALID', 400);
  if (Array.isArray(value)) return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1)).join(',') + '}';
}

export function prepareApprovalRequest(body, actorId) {
  if (!body || typeof body.requestId !== 'string' || !ID.test(body.requestId)) throw fail('APPROVAL_REQUEST_ID_REQUIRED', 400);
  let approval;
  try { approval = structuredClone(normalizeApprovalRequest(body, actorId)); }
  catch { throw fail('APPROVAL_REQUEST_INPUT_INVALID', 400); }
  const content = Object.fromEntries(fields.map(key => [key, approval[key]]));
  return { requestId: body.requestId, approval,
    contentSha256: createHash('sha256').update(canonical(content)).digest('hex') };
}

export function assertApprovalRequestActor(state, auth) {
  const { workspaceId, sub } = auth.session;
  const users = Array.isArray(state?.users) ? state.users.filter(user => user?.id === sub) : [];
  if (!evidenceInWorkspace(state, workspaceId) || !evidenceInWorkspace(state?.workspace, workspaceId)
    || state.workspace.id !== workspaceId || users.length !== 1 || !evidenceInWorkspace(users[0], workspaceId)
    || !Array.isArray(state.approvals)) throw fail('APPROVAL_REQUEST_SCOPE_INVALID', 403);
  const user = users[0];
  if (user.active === false || Number(user.sessionVersion || 1) !== Number(auth.session.sessionVersion || 1)
    || user.role !== auth.user.role) throw fail('SESSION_INVALID', 401);
  if (!['owner', 'admin', 'member'].includes(user.role)) throw fail('ROLE_DENIED', 403);
  if (user.passwordChangeRequired !== false) throw fail('PASSWORD_CHANGE_REQUIRED', 403);
}

export function findApprovalRequest(state, auth, intent) {
  assertApprovalRequestActor(state, auth);
  const matches = state.approvals.filter(row => row?.requestIdentity?.requestId === intent.requestId);
  if (matches.length > 1) throw fail('APPROVAL_REQUEST_STATE_INVALID');
  if (!matches.length) return null;
  const approval = matches[0], binding = approval.requestIdentity;
  if (binding.schema !== SCHEMA || binding.workspaceId !== auth.session.workspaceId
    || !evidenceInWorkspace(approval, auth.session.workspaceId) || binding.actorId !== approval.requestedBy
    || typeof binding.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(binding.contentSha256)) throw fail('APPROVAL_REQUEST_STATE_INVALID');
  if (binding.actorId !== auth.session.sub) throw fail('APPROVAL_REQUEST_ACTOR_MISMATCH', 403);
  if (binding.contentSha256 !== intent.contentSha256) throw fail('APPROVAL_REQUEST_CONFLICT');
  return approval;
}

// The caller holds its local workspace lock. Cross-process competition is
// decided by the existing primary revision CAS, never by that lock alone.
// Each call attempts at most one save. An uncertain save is followed only by
// an exact read; absence is not proof the attempted write cannot still commit.
export async function createApprovalRequest({ store, auth, intent, admit }) {
  const workspaceId = auth.session.workspaceId;
  const read = () => store.get(workspaceId, { exactSnapshot: true });
  const state = await read();
  const existing = findApprovalRequest(state, auth, intent);
  if (existing) return { approval: existing, replayed: true };
  const approval = structuredClone(intent.approval);
  admit(state, approval);
  approval.requestIdentity = { schema: SCHEMA, requestId: intent.requestId, workspaceId,
    actorId: auth.session.sub, contentSha256: intent.contentSha256 };
  state.approvals.unshift(approval);
  addAudit(state, { type: 'approval_requested', actor: auth.session.sub,
    detail: { approvalId: approval.id, actionType: approval.type, financialImpact: approval.financialImpact } });
  let acknowledged = false;
  try {
    await store.save(workspaceId, state, { ownedSnapshot: true, beforeCommit: snapshot => {
      if (findApprovalRequest(snapshot, auth, intent)?.id !== approval.id) throw fail('APPROVAL_REQUEST_STATE_INVALID');
    } });
    acknowledged = true;
  } catch { /* No replay, including on a revision conflict or lost response. */ }
  let current;
  try { current = await read(); }
  catch { throw fail('APPROVAL_REQUEST_OUTCOME_UNKNOWN', 503); }
  const confirmed = findApprovalRequest(current, auth, intent);
  if (!confirmed) throw fail('APPROVAL_REQUEST_OUTCOME_UNKNOWN', 503);
  return { approval: confirmed, replayed: !acknowledged || confirmed.id !== approval.id };
}
