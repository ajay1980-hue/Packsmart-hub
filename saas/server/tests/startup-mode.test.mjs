import test from 'node:test';
import assert from 'node:assert/strict';
import { createStartupPolicy } from '../lib/startup-mode.mjs';

test('startup mode accepts only absent or exact normal/quiet values', () => {
  for (const value of [undefined, 'normal', 'quiet']) {
    const policy = createStartupPolicy({ RUNVARA_STARTUP_MODE: value }, ['/']);
    assert.equal(policy.mode, value ?? 'normal');
    assert.equal(Object.isFrozen(policy), true);
  }
  for (const value of ['', 'NORMAL', 'Quiet', ' quiet', 'quiet ', 'false', '0', null, false, 0, {}, ['quiet']]) {
    assert.throws(() => createStartupPolicy({ RUNVARA_STARTUP_MODE: value }, []), { code: 'STARTUP_MODE_INVALID' });
  }
});

test('quiet policy snapshots mode and exact static paths without a method or environment override', () => {
  const env = { RUNVARA_STARTUP_MODE: 'quiet' }, paths = ['/', '/app.js'];
  const policy = createStartupPolicy(env, paths);
  env.RUNVARA_STARTUP_MODE = 'normal';
  paths.push('/api/bootstrap');
  assert.throws(() => { policy.mode = 'normal'; }, TypeError);
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'get']) {
    for (const pathname of ['/', '/app.js', '/api/health', '/api/auth/session', '/api/bootstrap', '/anything.js', '/api/health/', '/api/auth/session/']) {
      const allowed = ['GET', 'HEAD'].includes(method) && ['/', '/app.js', '/api/health'].includes(pathname)
        || method === 'GET' && pathname === '/api/auth/session';
      assert.equal(policy.allowsRequest(method, pathname), allowed, `${method} ${pathname}`);
    }
  }
});

test('normal and default startup leave HTTP admission unchanged', () => {
  for (const env of [{}, { RUNVARA_STARTUP_MODE: 'normal' }]) {
    const policy = createStartupPolicy(env, []);
    for (const method of ['GET', 'POST', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) {
      assert.equal(policy.allowsRequest(method, '/any-route'), true);
    }
  }
});

test('maintenance owner login is exact, opt-in, quiet-only and immutable', () => {
  const env = { RUNVARA_STARTUP_MODE: 'quiet', RUNVARA_QUIET_OWNER_LOGIN: 'enabled/v1' };
  const policy = createStartupPolicy(env, ['/']);
  env.RUNVARA_QUIET_OWNER_LOGIN = 'disabled/v1';
  assert.equal(policy.quiet, true);
  assert.equal(policy.quietOwnerLogin, true);
  assert.throws(() => { policy.quietOwnerLogin = false; }, TypeError);
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'post']) {
    for (const pathname of ['/api/auth/login', '/api/auth/login/', '/api/auth/%6cogin', '/API/auth/login', '/api/bootstrap']) {
      assert.equal(policy.allowsRequest(method, pathname), method === 'POST' && pathname === '/api/auth/login');
    }
  }
  for (const value of [undefined, 'disabled/v1']) assert.equal(createStartupPolicy({ RUNVARA_STARTUP_MODE: 'quiet', RUNVARA_QUIET_OWNER_LOGIN: value }, []).quietOwnerLogin, false);
  for (const value of ['', 'true', 'false', 'enabled', ' enabled/v1', 'enabled/v1 ', null, true, 1, {}]) {
    assert.throws(() => createStartupPolicy({ RUNVARA_STARTUP_MODE: 'quiet', RUNVARA_QUIET_OWNER_LOGIN: value }, []), { code: 'QUIET_OWNER_LOGIN_INVALID' });
  }
  for (const mode of [undefined, 'normal']) assert.throws(() => createStartupPolicy({ RUNVARA_STARTUP_MODE: mode, RUNVARA_QUIET_OWNER_LOGIN: 'enabled/v1' }, []), { code: 'QUIET_OWNER_LOGIN_INVALID' });
});
