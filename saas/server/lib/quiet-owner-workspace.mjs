import { evidenceInWorkspace } from './business-evidence-scope.mjs';

// The initial release is scoped to the existing Packsmart workspace. This is
// stricter than requireOwner(), which intentionally also admits administrators.
export function assertQuietOwnerWorkspace(auth, { inspectEvidence = true } = {}) {
  const id = auth?.session?.workspaceId, state = auth?.state;
  const users = Array.isArray(state?.users) ? state.users.filter(user => user?.id === auth.session.sub) : [];
  if (id !== 'packsmart-solutions' || state?.workspace?.id !== id || !evidenceInWorkspace(state, id)
    || !evidenceInWorkspace(state.workspace, id) || users.length !== 1 || !evidenceInWorkspace(users[0], id)) {
    throw Object.assign(new Error('Owner workspace scope is unavailable'), { status: 403, code: 'QUIET_OWNER_WORKSPACE_SCOPE_INVALID' });
  }
  if (users[0].role !== 'owner' || users[0].active === false || Number(users[0].sessionVersion || 1) !== Number(auth.session.sessionVersion || 1)) {
    throw Object.assign(new Error('Current workspace owner required'), { status: 403, code: 'QUIET_OWNER_WORKSPACE_OWNER_REQUIRED' });
  }
  if (users[0].passwordChangeRequired !== false) throw Object.assign(new Error('Password setup required'), { status: 403, code: 'PASSWORD_CHANGE_REQUIRED' });
  if (!inspectEvidence) return;
  // Full dashboard projections include nested records. Explicit conflicting
  // scope fails closed rather than being relabelled or silently discarded.
  const pending = [state]; let inspected = 0;
  while (pending.length) {
    const value = pending.pop(); if (!value || typeof value !== 'object') continue;
    if (++inspected > 100000) throw Object.assign(new Error('Workspace scope check exceeded its bound'), { status: 503, code: 'QUIET_OWNER_WORKSPACE_SCOPE_LIMIT' });
    if (!Array.isArray(value) && !evidenceInWorkspace(value, id)) throw Object.assign(new Error('Conflicting evidence scope'), { status: 403, code: 'QUIET_OWNER_WORKSPACE_SCOPE_INVALID' });
    for (const child of Object.values(value)) if (child && typeof child === 'object') pending.push(child);
  }
}

export function quietOwnerWorkspaceAvailable(auth) {
  try { assertQuietOwnerWorkspace(auth, { inspectEvidence: false }); return true; } catch { return false; }
}
