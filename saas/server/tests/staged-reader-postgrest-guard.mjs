import assert from 'node:assert/strict';

// Validate before opening any database connection or starting a gateway.
export function disposablePostgrestTarget(env) {
  assert.equal(env.OUTCOME_ALLOW_DISPOSABLE_TEST_DB, '1', 'Disposable database opt-in required');
  for (const key of Object.keys(env)) {
    assert.ok(!/^(SUPABASE_|PGRST_|PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE|PGSERVICE|PGOPTIONS|DATABASE_URL$|NODE_OPTIONS$)/.test(key),
      `Unexpected connection or runtime environment: ${key}`);
  }
  assert.notEqual(env.NODE_ENV, 'production');
  let url;
  try { url = new URL(env.OUTCOME_TEST_DATABASE_URL); }
  catch { throw new Error('Disposable database URL is invalid'); }
  assert.ok(url.protocol === 'postgres:', 'Unexpected disposable database protocol');
  assert.ok(url.hostname === '127.0.0.1', 'Disposable database must use exact loopback host');
  assert.ok(url.username === 'postgres', 'Unexpected disposable database role');
  assert.ok(url.pathname === '/runvara_outcome_test', 'Unexpected disposable database name');
  assert.ok(url.search === '' && url.hash === '', 'Database URL overrides are forbidden');
  assert.ok(Number.isInteger(Number(url.port)) && Number(url.port) > 1024 && Number(url.port) <= 65535, 'Unexpected disposable database port');
  const mode = env.STAGED_READER_DISPOSABLE_FIXTURE ?? 'local';
  assert.ok(['local', 'github-actions-postgres17'].includes(mode));
  if (mode === 'github-actions-postgres17') {
    assert.equal(env.CI, 'true'); assert.equal(env.GITHUB_ACTIONS, 'true');
    assert.equal(env.GITHUB_JOB, 'postgres-business-outcomes'); assert.equal(url.port, '5432');
  } else assert.ok(url.password === '', 'Local disposable database credentials are forbidden');
  return { url, mode };
}
