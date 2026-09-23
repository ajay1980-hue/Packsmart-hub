import crypto from 'node:crypto';
import { normalizeEmail, safeEqual } from './security.mjs';
import { addAudit } from './events.mjs';

export function launchMode(state, env = {}) {
  // The old boolean must never silently open public registration.
  const mode = state?.launchControl?.mode || env.SIGNUP_MODE || 'beta';
  return ['closed', 'beta', 'public'].includes(mode) ? mode : 'closed';
}
export function publicLaunch(state, env) {
  const mode = launchMode(state, env);
  return { mode, enabled: mode !== 'closed', invitationRequired: mode === 'beta' };
}
export function requireLaunchAdmin(auth, env) {
  if (auth.session.workspaceId !== 'packsmart-solutions' || auth.user.role !== 'owner' ||
      normalizeEmail(auth.user.email) !== normalizeEmail(env.PACKSMART_ADMIN_EMAIL || 'sales@packsmartsolutions.com')) {
    throw Object.assign(new Error('Runvara platform owner access required'), { status: 403, code: 'PLATFORM_ADMIN_REQUIRED' });
  }
}
export function issueInvite(state, value, actor) {
  const email = normalizeEmail(value);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw Object.assign(new Error('Enter a valid invited email'), { status: 400 });
  const token = crypto.randomBytes(32).toString('base64url');
  const invite = { id: crypto.randomUUID(), email, tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(), revoked: false };
  state.launchControl ||= { mode: 'beta' };
  state.launchControl.invitations ||= [];
  // Bound active invitations without deleting audit evidence or previous identities.
  if (state.launchControl.invitations.filter(item => !item.revoked && Date.parse(item.expiresAt) > Date.now()).length >= 100) throw Object.assign(new Error('Revoke an existing invitation before issuing another'), { status: 409 });
  state.launchControl.invitations.push(invite);
  addAudit(state, { type: 'beta_invitation_created', actor, detail: { invitationId: invite.id, expiresAt: invite.expiresAt } });
  const { tokenHash, ...publicInvite } = invite;
  return { ...publicInvite, token };
}
export function validateInvite(state, token, email) {
  const hash = crypto.createHash('sha256').update(String(token || '').slice(0, 256)).digest('hex');
  const invite = state?.launchControl?.invitations?.find(item => safeEqual(item.tokenHash, hash));
  if (!invite || invite.revoked || Date.parse(invite.expiresAt) <= Date.now() || invite.email !== email) {
    throw Object.assign(new Error('A valid invitation for this email is required. Ask the Runvara owner for beta access.'), { status: 403, code: 'BETA_CLOSED' });
  }
  // The invitation ID determines the workspace ID. The existing atomic workspace
  // creation + unique email index prevents replay across replicas and crashes.
  return invite;
}
