// Construction-time admission only. Quiet startup cannot be reopened by a
// request, tenant setting, worker option, or later environment mutation.
export function createStartupPolicy(env, staticPathnames) {
  const mode = env.RUNVARA_STARTUP_MODE === undefined ? 'normal' : env.RUNVARA_STARTUP_MODE;
  if (mode !== 'normal' && mode !== 'quiet') {
    throw Object.assign(new Error('RUNVARA_STARTUP_MODE must be normal or quiet'), { code: 'STARTUP_MODE_INVALID' });
  }
  const staticPaths = new Set(staticPathnames);
  const quiet = mode === 'quiet';
  return Object.freeze({
    mode,
    quiet,
    allowsRequest(method, pathname) {
      if (!quiet) return true;
      if (method === 'GET' && pathname === '/api/auth/session') return true;
      return (method === 'GET' || method === 'HEAD')
        && (pathname === '/api/health' || staticPaths.has(pathname));
    }
  });
}

export const QUIET_STARTUP_RESPONSE = Object.freeze({
  error: 'New work is temporarily paused for an update. Earlier work may still be running.',
  code: 'STARTUP_QUIET_MODE'
});
