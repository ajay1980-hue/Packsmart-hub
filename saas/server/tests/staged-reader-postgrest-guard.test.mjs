import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { disposablePostgrestTarget } from './staged-reader-postgrest-guard.mjs';

const local = { OUTCOME_ALLOW_DISPOSABLE_TEST_DB: '1', OUTCOME_TEST_DATABASE_URL: 'postgres://postgres@127.0.0.1:15432/runvara_outcome_test' };
test('PostgREST qualification rejects external targets and connection overrides before I/O', () => {
  assert.equal(disposablePostgrestTarget(local).mode, 'local');
  for (const patch of [
    { OUTCOME_ALLOW_DISPOSABLE_TEST_DB: '0' }, { NODE_ENV: 'production' },
    ...['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DATABASE_URL', 'PGRST_DB_URI', 'PGHOST', 'PGSERVICEFILE', 'NODE_OPTIONS'].map(key => ({ [key]: 'synthetic' })),
    ...['postgres://postgres@example.invalid:5432/runvara_outcome_test', 'postgres://postgres@localhost:5432/runvara_outcome_test',
      'postgres://postgres@127.0.0.1:5432/postgres', 'postgres://service_role@127.0.0.1:5432/runvara_outcome_test',
      'postgres://postgres:password@127.0.0.1:5432/runvara_outcome_test', 'postgres://postgres@127.0.0.1:5432/runvara_outcome_test?host=elsewhere',
      'postgres://postgres@127.0.0.1:5432/runvara_outcome_test#fragment', 'postgres://postgres@127.0.0.1:80/runvara_outcome_test']
      .map(OUTCOME_TEST_DATABASE_URL => ({ OUTCOME_TEST_DATABASE_URL })),
    { STAGED_READER_DISPOSABLE_FIXTURE: 'unknown' }, { STAGED_READER_DISPOSABLE_FIXTURE: 'github-actions-postgres17' }
  ]) assert.throws(() => disposablePostgrestTarget({ ...local, ...patch }));
});
test('PostgREST CI target requires the exact disposable service context', () => {
  const ci = { ...local, OUTCOME_TEST_DATABASE_URL: 'postgres://postgres:synthetic@127.0.0.1:5432/runvara_outcome_test',
    STAGED_READER_DISPOSABLE_FIXTURE: 'github-actions-postgres17', CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_JOB: 'postgres-business-outcomes' };
  assert.equal(disposablePostgrestTarget(ci).mode, 'github-actions-postgres17');
  for (const key of ['CI', 'GITHUB_ACTIONS', 'GITHUB_JOB']) assert.throws(() => disposablePostgrestTarget({ ...ci, [key]: '' }));
});
test('rejected connection diagnostics never retain credentials or a raw URL', () => {
  for (const value of ['postgres://postgres:sentinel-private-credential@127.0.0.1:5432/runvara_outcome_test',
    'postgres://postgres:sentinel-private-credential@[malformed/runvara_outcome_test']) {
    assert.throws(() => disposablePostgrestTarget({ ...local, OUTCOME_TEST_DATABASE_URL: value }), error => {
      const rendered = inspect(error) + JSON.stringify(error);
      assert.ok(!rendered.includes('sentinel-private-credential')); assert.ok(!rendered.includes(value)); return true;
    });
  }
});
