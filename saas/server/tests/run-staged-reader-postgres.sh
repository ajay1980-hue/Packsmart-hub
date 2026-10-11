#!/usr/bin/env bash
# Existing PostgreSQL 17 + Node 22 only; disposable localhost cluster, no install.
set -euo pipefail
: "${STAGED_READER_PG_BIN:?Set STAGED_READER_PG_BIN to existing PostgreSQL 17 bin directory}"
: "${STAGED_READER_NODE:?Set STAGED_READER_NODE to existing Node 22 executable}"
: "${STAGED_READER_EVIDENCE_DIR:?Set a writable evidence directory}"
: "${STAGED_READER_PG_MODULES:?Set the existing locked atomic-usage node_modules directory}"
STAGED_READER_TEST_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mkdir -p -- "$STAGED_READER_EVIDENCE_DIR"
STAGED_READER_DATA=$(mktemp -d /tmp/runvara-staged-reader-pg.XXXXXX)
STAGED_READER_PORT=unselected
cleanup() {
  local result=$?
  trap - EXIT
  if "$STAGED_READER_PG_BIN/pg_ctl" -D "$STAGED_READER_DATA" status >/dev/null 2>&1; then
    "$STAGED_READER_PG_BIN/pg_ctl" -D "$STAGED_READER_DATA" -m fast -w -t 15 stop >> "$STAGED_READER_EVIDENCE_DIR/cleanup.log" 2>&1 || result=99
  fi
  if "$STAGED_READER_PG_BIN/pg_ctl" -D "$STAGED_READER_DATA" status >/dev/null 2>&1; then
    echo 'ERROR: disposable cluster remains running; retaining data for safe cleanup' >> "$STAGED_READER_EVIDENCE_DIR/cleanup.log"
    exit 99
  fi
  cp "$STAGED_READER_DATA/server.log" "$STAGED_READER_EVIDENCE_DIR/postgres-server.log" 2>/dev/null || true
  echo "Verified stopped disposable cluster $STAGED_READER_DATA at 127.0.0.1:$STAGED_READER_PORT" >> "$STAGED_READER_EVIDENCE_DIR/cleanup.log"
  rm -rf -- "$STAGED_READER_DATA"
  test ! -e "$STAGED_READER_DATA" || result=99
  echo 'Verified temporary cluster data removed' >> "$STAGED_READER_EVIDENCE_DIR/cleanup.log"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
STAGED_READER_PORT=$(env -i PATH="$(dirname -- "$STAGED_READER_NODE"):/usr/bin:/bin" "$STAGED_READER_NODE" --input-type=module -e "import net from 'node:net';const server=net.createServer();server.listen(0,'127.0.0.1',()=>{console.log(server.address().port);server.close();});")
"$STAGED_READER_NODE" --version > "$STAGED_READER_EVIDENCE_DIR/node-version.txt"
"$STAGED_READER_PG_BIN/postgres" --version > "$STAGED_READER_EVIDENCE_DIR/postgres-version.txt"
"$STAGED_READER_PG_BIN/initdb" -D "$STAGED_READER_DATA" -U postgres -A trust --encoding=UTF8 --locale=C > "$STAGED_READER_EVIDENCE_DIR/initdb.log"
"$STAGED_READER_PG_BIN/pg_ctl" -D "$STAGED_READER_DATA" -l "$STAGED_READER_DATA/server.log" -o "-h 127.0.0.1 -p $STAGED_READER_PORT -c unix_socket_directories='' -c max_connections=10 -c shared_buffers=16MB -c work_mem=1MB -c maintenance_work_mem=16MB -c max_worker_processes=2 -c max_parallel_workers=0 -c autovacuum=off -c statement_timeout=20000 -c temp_file_limit=16384 -c max_wal_size=64MB -c min_wal_size=32MB" -w -t 15 start > "$STAGED_READER_EVIDENCE_DIR/startup.log"
env -i PATH="$(dirname -- "$STAGED_READER_NODE"):/usr/bin:/bin" NODE_PATH="$STAGED_READER_PG_MODULES" STAGED_READER_PORT="$STAGED_READER_PORT" "$STAGED_READER_NODE" --input-type=module > "$STAGED_READER_EVIDENCE_DIR/cluster.json" <<'JS'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(`${process.cwd()}/package.json`), { Client } = require('pg');
const client = new Client({ host: '127.0.0.1', port: Number(process.env.STAGED_READER_PORT), user: 'postgres', database: 'postgres', ssl: false, connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  const info = (await client.query("SELECT version() version,current_database() db,current_user role,current_setting('listen_addresses') listen_addresses,current_setting('server_version_num')::int version_num")).rows[0];
  assert.equal(info.db, 'postgres'); assert.equal(info.role, 'postgres'); assert.equal(info.listen_addresses, '127.0.0.1');
  assert.ok(info.version_num >= 170000 && info.version_num < 180000); assert.equal(client.connection.stream.remoteAddress, '127.0.0.1');
  await client.query('CREATE DATABASE runvara_outcome_test');
  console.log(JSON.stringify({ ...info, port: Number(process.env.STAGED_READER_PORT), created: 'runvara_outcome_test', syntheticLocalOnly: true }));
} finally { await client.end(); }
JS
STAGED_READER_RESULT=0
STAGED_READER_NAMES=(business-outcome-postgres content-execution-receipt-postgres receipt-outcome-consumer-postgres shopify-order-recovery-postgres shopify-order-recovery-transport-postgres staged-reader-postgres)
if [[ ${STAGED_READER_ONLY_NEW:-0} == 1 ]]; then STAGED_READER_NAMES=(staged-reader-postgres); fi
for STAGED_READER_NAME in "${STAGED_READER_NAMES[@]}"; do
  if env -i PATH="$(dirname -- "$STAGED_READER_NODE"):/usr/bin:/bin" NODE_PATH="$STAGED_READER_PG_MODULES" OUTCOME_ALLOW_DISPOSABLE_TEST_DB=1 OUTCOME_TEST_DATABASE_URL="postgres://postgres@127.0.0.1:$STAGED_READER_PORT/runvara_outcome_test" "$STAGED_READER_NODE" --test --test-concurrency=1 "$STAGED_READER_TEST_DIR/$STAGED_READER_NAME.mjs" > "$STAGED_READER_EVIDENCE_DIR/$STAGED_READER_NAME.tap" 2> "$STAGED_READER_EVIDENCE_DIR/$STAGED_READER_NAME.stderr.log"; then
    echo "$STAGED_READER_NAME passed"
  else
    STAGED_READER_RESULT=1
    echo "$STAGED_READER_NAME FAILED"
  fi
done
exit "$STAGED_READER_RESULT"
