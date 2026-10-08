/** Opted-in, read-only JSONB casts against an empty disposable localhost PG17 DB. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(new URL('./atomic-usage/package.json', import.meta.url));
const { Client } = require('pg');
const QUERY = 'SELECT $1::jsonb AS snapshot';
const MODE = process.env.CONTENT_JSONB_DISPOSABLE_FIXTURE || 'local';
const OBJECTS = `SELECT n.nspname,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
  UNION ALL SELECT n.nspname,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'`;

export function disposableJsonbUrl() {
  assert.equal(process.env.OUTCOME_ALLOW_DISPOSABLE_TEST_DB, '1', 'Explicit disposable test database opt-in required');
  assert.ok(process.env.OUTCOME_TEST_DATABASE_URL, 'OUTCOME_TEST_DATABASE_URL is required; PostgreSQL proof must not silently skip');
  const url = new URL(process.env.OUTCOME_TEST_DATABASE_URL);
  assert.equal(url.protocol, 'postgres:');
  assert.equal(url.hostname, '127.0.0.1', 'Only the disposable loopback PostgreSQL fixture is allowed');
  assert.equal(url.pathname, '/runvara_outcome_test');
  assert.equal(url.username, 'postgres');
  assert.ok(['local', 'github-actions-postgres17'].includes(MODE), 'Unknown disposable fixture mode');
  if (MODE === 'github-actions-postgres17') {
    // The existing official Docker service binds * inside its isolated CI
    // container; the runner still connects through exactly 127.0.0.1:5432.
    assert.equal(process.env.GITHUB_ACTIONS, 'true');
    assert.equal(process.env.GITHUB_JOB, 'postgres-business-outcomes');
    assert.equal(url.port, '5432');
    assert.equal(url.password, 'disposable-test-password');
  } else assert.equal(url.password, '');
  assert.equal(url.search, '', 'Connection target overrides are forbidden');
  assert.equal(url.hash, '');
  assert.ok(Number.isInteger(Number(url.port)) && Number(url.port) > 1024);
  return url;
}

export async function openJsonbFixture() {
  const url = disposableJsonbUrl();
  const client = new Client({ connectionString: url.href, ssl: false, options: '',
    application_name: 'runvara-content-jsonb-test', connectionTimeoutMillis: 5000, statement_timeout: 20000 });
  try {
    await client.connect();
    const info = (await client.query(`SELECT version() AS version,current_database() AS db,current_user AS role,
      current_setting('server_version_num')::int AS version_num,current_setting('listen_addresses') AS listen_addresses`)).rows[0];
    assert.equal(info.db, 'runvara_outcome_test');
    assert.equal(info.role, 'postgres');
    assert.equal(info.version_num, 170006, 'Requires the existing PostgreSQL 17.6 fixture');
    assert.equal(info.listen_addresses, MODE === 'github-actions-postgres17' ? '*' : '127.0.0.1');
    assert.equal(client.connection.stream.remoteAddress, '127.0.0.1');
    assert.deepEqual((await client.query(OBJECTS)).rows, [], 'Refusing a nonempty fixture database');
    const casts = [];
    // beforeCommit is deliberately synchronous. A bounded child performs the
    // real database cast without changing that guard's production contract.
    const program = `import fs from 'node:fs';
      import { createRequire } from 'node:module';
      const require = createRequire(${JSON.stringify(new URL('./atomic-usage/package.json', import.meta.url).href)});
      const { Client } = require('pg');
      const client = new Client({connectionString:process.env.OUTCOME_TEST_DATABASE_URL,ssl:false,options:'',
        application_name:'runvara-content-jsonb-cast',connectionTimeoutMillis:5000,statement_timeout:20000});
      try { await client.connect();
        if(client.connection.stream.remoteAddress!=='127.0.0.1') throw new Error('Non-loopback connection refused');
        const input=fs.readFileSync(0,'utf8');
        const result=await client.query(${JSON.stringify(QUERY)},[input]);
        process.stdout.write(JSON.stringify(result.rows[0].snapshot));
      } finally { await client.end(); }`;
    function roundtrip(value) {
      const input = JSON.stringify(value);
      assert.ok(Buffer.byteLength(input) <= 4 * 1024 * 1024, 'Bounded synthetic JSONB fixture only');
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
        input, encoding: 'utf8', timeout: 25000, maxBuffer: 8 * 1024 * 1024,
        env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH || '', OUTCOME_TEST_DATABASE_URL: url.href }
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.deepEqual(output, value, 'Real JSONB may alter object order only; all values and array order must survive');
      casts.push({ inputBytes: Buffer.byteLength(input), outputBytes: Buffer.byteLength(result.stdout), orderChanged: input !== result.stdout });
      return output;
    }
    return { info: { ...info, fixtureMode: MODE }, casts, roundtrip, async close() {
      try { assert.deepEqual((await client.query(OBJECTS)).rows, [], 'No schema, public data, migration, or grants may be introduced'); }
      finally { await client.end(); }
    } };
  } catch (error) { await client.end(); throw error; }
}
