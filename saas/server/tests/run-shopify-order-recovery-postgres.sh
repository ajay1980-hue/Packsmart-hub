#!/usr/bin/env bash
# Explicit, disposable localhost PG17 test runner. Applies candidate SQL only inside a fresh synthetic cluster.
set -euo pipefail
: "${ORDER_RECOVERY_PG_BIN:?Set ORDER_RECOVERY_PG_BIN to existing PostgreSQL 17 bin directory}"
: "${ORDER_RECOVERY_NODE:?Set ORDER_RECOVERY_NODE to existing Node 22 executable}"
: "${ORDER_RECOVERY_EVIDENCE_DIR:?Set a writable evidence directory}"
: "${ORDER_RECOVERY_PG_MODULES:?Set the existing locked atomic-usage node_modules directory}"
ORDER_RECOVERY_TEST_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ORDER_RECOVERY_SCRIPT=${ORDER_RECOVERY_TEST_FILE:-$ORDER_RECOVERY_TEST_DIR/shopify-order-recovery-postgres.mjs}
mkdir -p -- "$ORDER_RECOVERY_EVIDENCE_DIR"
ORDER_RECOVERY_DATA=$(mktemp -d /tmp/runvara-order-recovery-pg.XXXXXX)
ORDER_RECOVERY_PORT=unselected
cleanup() {
  local result=$?
  trap - EXIT
  if "$ORDER_RECOVERY_PG_BIN/pg_ctl" -D "$ORDER_RECOVERY_DATA" status >/dev/null 2>&1; then
    "$ORDER_RECOVERY_PG_BIN/pg_ctl" -D "$ORDER_RECOVERY_DATA" -m fast -w -t 15 stop >> "$ORDER_RECOVERY_EVIDENCE_DIR/cleanup.log" 2>&1 || result=99
  fi
  if "$ORDER_RECOVERY_PG_BIN/pg_ctl" -D "$ORDER_RECOVERY_DATA" status >/dev/null 2>&1; then
    echo 'ERROR: disposable cluster is still running; data retained for safe cleanup' >> "$ORDER_RECOVERY_EVIDENCE_DIR/cleanup.log"
    exit 99
  fi
  cp "$ORDER_RECOVERY_DATA/server.log" "$ORDER_RECOVERY_EVIDENCE_DIR/postgres-server.log" 2>/dev/null || true
  echo "Verified stopped disposable cluster $ORDER_RECOVERY_DATA at 127.0.0.1:$ORDER_RECOVERY_PORT" >> "$ORDER_RECOVERY_EVIDENCE_DIR/cleanup.log"
  rm -rf -- "$ORDER_RECOVERY_DATA"
  test ! -e "$ORDER_RECOVERY_DATA" || result=99
  echo 'Verified temporary cluster data removed' >> "$ORDER_RECOVERY_EVIDENCE_DIR/cleanup.log"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ORDER_RECOVERY_PORT=$(env -i PATH="$(dirname -- "$ORDER_RECOVERY_NODE"):/usr/bin:/bin" "$ORDER_RECOVERY_NODE" --input-type=module -e "import net from 'node:net';const server=net.createServer();server.listen(0,'127.0.0.1',()=>{console.log(server.address().port);server.close();});")
"$ORDER_RECOVERY_PG_BIN/postgres" --version > "$ORDER_RECOVERY_EVIDENCE_DIR/postgres-version.txt"
"$ORDER_RECOVERY_PG_BIN/initdb" -D "$ORDER_RECOVERY_DATA" -U postgres -A trust --encoding=UTF8 --locale=C > "$ORDER_RECOVERY_EVIDENCE_DIR/initdb.log"
"$ORDER_RECOVERY_PG_BIN/pg_ctl" -D "$ORDER_RECOVERY_DATA" -l "$ORDER_RECOVERY_DATA/server.log" -o "-h 127.0.0.1 -p $ORDER_RECOVERY_PORT -c unix_socket_directories='' -c max_connections=10 -c shared_buffers=16MB -c work_mem=1MB -c maintenance_work_mem=16MB -c max_worker_processes=2 -c max_parallel_workers=0 -c autovacuum=off -c statement_timeout=20000 -c temp_file_limit=16384 -c max_wal_size=64MB -c min_wal_size=32MB" -w -t 15 start > "$ORDER_RECOVERY_EVIDENCE_DIR/startup.log"
env -i PATH="$(dirname -- "$ORDER_RECOVERY_NODE"):/usr/bin:/bin" NODE_PATH="$ORDER_RECOVERY_PG_MODULES" ORDER_RECOVERY_PORT="$ORDER_RECOVERY_PORT" "$ORDER_RECOVERY_NODE" --input-type=module > "$ORDER_RECOVERY_EVIDENCE_DIR/cluster.json" <<'JS'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(`${process.cwd()}/package.json`), { Client } = require('pg');
const client = new Client({host:'127.0.0.1',port:Number(process.env.ORDER_RECOVERY_PORT),user:'postgres',database:'postgres',ssl:false,connectionTimeoutMillis:5000});
try {
  await client.connect();
  const info=(await client.query("SELECT version() version,current_database() db,current_user role,current_setting('listen_addresses') listen_addresses,current_setting('server_version_num')::int version_num")).rows[0];
  assert.equal(info.db,'postgres');assert.equal(info.role,'postgres');assert.equal(info.listen_addresses,'127.0.0.1');
  assert.ok(info.version_num>=170000&&info.version_num<180000);assert.equal(client.connection.stream.remoteAddress,'127.0.0.1');
  await client.query('CREATE DATABASE runvara_order_recovery_test');
  console.log(JSON.stringify({...info,port:Number(process.env.ORDER_RECOVERY_PORT),created:'runvara_order_recovery_test',applicationSchemaChanges:"disposable-only"}));
} finally { await client.end(); }
JS
env -i PATH="$(dirname -- "$ORDER_RECOVERY_NODE"):/usr/bin:/bin" NODE_PATH="$ORDER_RECOVERY_PG_MODULES" ORDER_RECOVERY_ALLOW_DISPOSABLE_TEST_DB=1 ORDER_RECOVERY_TEST_DATABASE_URL="postgres://postgres@127.0.0.1:$ORDER_RECOVERY_PORT/runvara_order_recovery_test" "$ORDER_RECOVERY_NODE" --test --test-concurrency=1 "$ORDER_RECOVERY_SCRIPT" > "$ORDER_RECOVERY_EVIDENCE_DIR/results.tap" 2> "$ORDER_RECOVERY_EVIDENCE_DIR/stderr.log"
