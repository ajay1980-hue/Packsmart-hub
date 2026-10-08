#!/usr/bin/env bash
# Explicit, disposable localhost PG17 test runner. No application SQL is applied.
set -euo pipefail
: "${CONTENT_JSONB_PG_BIN:?Set CONTENT_JSONB_PG_BIN to existing PostgreSQL 17 bin directory}"
: "${CONTENT_JSONB_NODE:?Set CONTENT_JSONB_NODE to existing Node 22 executable}"
: "${CONTENT_JSONB_EVIDENCE_DIR:?Set a writable evidence directory}"
: "${CONTENT_JSONB_PG_MODULES:?Set the existing locked atomic-usage node_modules directory}"
CONTENT_JSONB_TEST_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CONTENT_JSONB_SCRIPT=${CONTENT_JSONB_TEST_FILE:-$CONTENT_JSONB_TEST_DIR/content-jsonb-postgres.mjs}
mkdir -p -- "$CONTENT_JSONB_EVIDENCE_DIR"
CONTENT_JSONB_DATA=$(mktemp -d /tmp/runvara-content-jsonb-pg.XXXXXX)
CONTENT_JSONB_PORT=unselected
cleanup() {
  local result=$?
  trap - EXIT
  if "$CONTENT_JSONB_PG_BIN/pg_ctl" -D "$CONTENT_JSONB_DATA" status >/dev/null 2>&1; then
    "$CONTENT_JSONB_PG_BIN/pg_ctl" -D "$CONTENT_JSONB_DATA" -m fast -w -t 15 stop >> "$CONTENT_JSONB_EVIDENCE_DIR/cleanup.log" 2>&1 || result=99
  fi
  if "$CONTENT_JSONB_PG_BIN/pg_ctl" -D "$CONTENT_JSONB_DATA" status >/dev/null 2>&1; then
    echo 'ERROR: disposable cluster is still running; data retained for safe cleanup' >> "$CONTENT_JSONB_EVIDENCE_DIR/cleanup.log"
    exit 99
  fi
  cp "$CONTENT_JSONB_DATA/server.log" "$CONTENT_JSONB_EVIDENCE_DIR/postgres-server.log" 2>/dev/null || true
  echo "Verified stopped disposable cluster $CONTENT_JSONB_DATA at 127.0.0.1:$CONTENT_JSONB_PORT" >> "$CONTENT_JSONB_EVIDENCE_DIR/cleanup.log"
  rm -rf -- "$CONTENT_JSONB_DATA"
  test ! -e "$CONTENT_JSONB_DATA" || result=99
  echo 'Verified temporary cluster data removed' >> "$CONTENT_JSONB_EVIDENCE_DIR/cleanup.log"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
CONTENT_JSONB_PORT=$(env -i PATH="$(dirname -- "$CONTENT_JSONB_NODE"):/usr/bin:/bin" "$CONTENT_JSONB_NODE" --input-type=module -e "import net from 'node:net';const server=net.createServer();server.listen(0,'127.0.0.1',()=>{console.log(server.address().port);server.close();});")
"$CONTENT_JSONB_PG_BIN/postgres" --version > "$CONTENT_JSONB_EVIDENCE_DIR/postgres-version.txt"
"$CONTENT_JSONB_PG_BIN/initdb" -D "$CONTENT_JSONB_DATA" -U postgres -A trust --encoding=UTF8 --locale=C > "$CONTENT_JSONB_EVIDENCE_DIR/initdb.log"
"$CONTENT_JSONB_PG_BIN/pg_ctl" -D "$CONTENT_JSONB_DATA" -l "$CONTENT_JSONB_DATA/server.log" -o "-h 127.0.0.1 -p $CONTENT_JSONB_PORT -c unix_socket_directories='' -c max_connections=10 -c shared_buffers=16MB -c work_mem=1MB -c maintenance_work_mem=16MB -c max_worker_processes=2 -c max_parallel_workers=0 -c autovacuum=off -c statement_timeout=20000 -c temp_file_limit=16384 -c max_wal_size=64MB -c min_wal_size=32MB" -w -t 15 start > "$CONTENT_JSONB_EVIDENCE_DIR/startup.log"
env -i PATH="$(dirname -- "$CONTENT_JSONB_NODE"):/usr/bin:/bin" NODE_PATH="$CONTENT_JSONB_PG_MODULES" CONTENT_JSONB_PORT="$CONTENT_JSONB_PORT" "$CONTENT_JSONB_NODE" --input-type=module > "$CONTENT_JSONB_EVIDENCE_DIR/cluster.json" <<'JS'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(`${process.cwd()}/package.json`), { Client } = require('pg');
const client = new Client({host:'127.0.0.1',port:Number(process.env.CONTENT_JSONB_PORT),user:'postgres',database:'postgres',ssl:false,connectionTimeoutMillis:5000});
try {
  await client.connect();
  const info=(await client.query("SELECT version() version,current_database() db,current_user role,current_setting('listen_addresses') listen_addresses,current_setting('server_version_num')::int version_num")).rows[0];
  assert.equal(info.db,'postgres');assert.equal(info.role,'postgres');assert.equal(info.listen_addresses,'127.0.0.1');
  assert.ok(info.version_num>=170000&&info.version_num<180000);assert.equal(client.connection.stream.remoteAddress,'127.0.0.1');
  await client.query('CREATE DATABASE runvara_outcome_test');
  console.log(JSON.stringify({...info,port:Number(process.env.CONTENT_JSONB_PORT),created:'runvara_outcome_test',applicationSchemaChanges:0}));
} finally { await client.end(); }
JS
env -i PATH="$(dirname -- "$CONTENT_JSONB_NODE"):/usr/bin:/bin" NODE_PATH="$CONTENT_JSONB_PG_MODULES" OUTCOME_ALLOW_DISPOSABLE_TEST_DB=1 OUTCOME_TEST_DATABASE_URL="postgres://postgres@127.0.0.1:$CONTENT_JSONB_PORT/runvara_outcome_test" "$CONTENT_JSONB_NODE" --test --test-concurrency=1 "$CONTENT_JSONB_SCRIPT" > "$CONTENT_JSONB_EVIDENCE_DIR/results.tap" 2> "$CONTENT_JSONB_EVIDENCE_DIR/stderr.log"
