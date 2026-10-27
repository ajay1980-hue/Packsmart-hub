import { createQuietApprovalPilot, PILOT_BASE } from './quiet-approval-pilot.mjs';
import { createQuietCreativePilot, creativePilotAction } from './quiet-creative-pilot.mjs';

// Construction-time admission only. Quiet startup cannot be reopened by a
// request, tenant setting, worker option, or later environment mutation.
export function createStartupPolicy(env, staticPathnames) {
  const mode = env.RUNVARA_STARTUP_MODE === undefined ? 'normal' : env.RUNVARA_STARTUP_MODE;
  if (mode !== 'normal' && mode !== 'quiet') {
    throw Object.assign(new Error('RUNVARA_STARTUP_MODE must be normal or quiet'), { code: 'STARTUP_MODE_INVALID' });
  }
  const staticPaths = new Set(staticPathnames);
  const quiet = mode === 'quiet';
  const ownerLogin = env.RUNVARA_QUIET_OWNER_LOGIN === undefined ? 'disabled/v1' : env.RUNVARA_QUIET_OWNER_LOGIN;
  if (!['disabled/v1', 'enabled/v1'].includes(ownerLogin) || (ownerLogin === 'enabled/v1' && !quiet)) {
    throw Object.assign(new Error('Quiet owner login requires quiet mode and an exact enabled/v1 or disabled/v1 value'), { code: 'QUIET_OWNER_LOGIN_INVALID' });
  }
  const quietOwnerLogin = quiet && ownerLogin === 'enabled/v1';
  const commercePreview = env.RUNVARA_QUIET_COMMERCE_PREVIEW === undefined ? 'disabled/v1' : env.RUNVARA_QUIET_COMMERCE_PREVIEW;
  if (!['disabled/v1', 'enabled/v1'].includes(commercePreview) || (commercePreview === 'enabled/v1' && !quiet)) {
    throw Object.assign(new Error('Quiet commerce preview requires quiet mode and an exact enabled/v1 or disabled/v1 value'), { code: 'QUIET_COMMERCE_PREVIEW_INVALID' });
  }
  const quietCommercePreview = quiet && commercePreview === 'enabled/v1';
  const publicSupport = env.RUNVARA_QUIET_PUBLIC_SUPPORT === undefined ? 'disabled/v1' : env.RUNVARA_QUIET_PUBLIC_SUPPORT;
  if (!['disabled/v1', 'enabled/v1'].includes(publicSupport) || (publicSupport === 'enabled/v1' && !quiet)) {
    throw Object.assign(new Error('Quiet public support requires quiet mode and an exact enabled/v1 or disabled/v1 value'), { code: 'QUIET_PUBLIC_SUPPORT_INVALID' });
  }
  const quietPublicSupport = quiet && publicSupport === 'enabled/v1';
  const approvalPilot = createQuietApprovalPilot(env);
  const creativePilot = createQuietCreativePilot(env);
  return Object.freeze({
    mode,
    quiet,
    quietOwnerLogin,
    quietCommercePreview,
    quietPublicSupport,
    approvalPilot,
    creativePilot,
    allowsRequest(method, pathname) {
      if (!quiet) return true;
      if (quietPublicSupport && ['OPTIONS', 'POST'].includes(method) && pathname === '/api/public/support') return true;
      if (creativePilot?.available() && creativePilotAction(method, pathname)) return true;
      if (approvalPilot?.available() && method === 'POST' && ['request', 'reconcile', 'reject'].some(action => pathname === PILOT_BASE + action)) return true;
      if (method === 'GET' && pathname === '/api/auth/session') return true;
      if (quietCommercePreview && method === 'GET' && pathname === '/api/maintenance/commerce') return true;
      if (quietOwnerLogin && method === 'POST' && pathname === '/api/auth/login') return true;
      return (method === 'GET' || method === 'HEAD')
        && (pathname === '/api/health' || staticPaths.has(pathname));
    }
  });
}

export const QUIET_STARTUP_RESPONSE = Object.freeze({
  error: 'New work is temporarily paused for an update. Earlier work may still be running.',
  code: 'STARTUP_QUIET_MODE'
});
