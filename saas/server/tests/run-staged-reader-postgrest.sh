#!/usr/bin/env bash
# Existing Node 22, PostgreSQL 17.6 and verified PostgREST 14.5 only. No installer.
set -euo pipefail
: "${STAGED_READER_PG_BIN:?Set existing PostgreSQL 17.6 bin directory}"
: "${STAGED_READER_NODE:?Set existing Node 22 executable}"
: "${STAGED_READER_PG_MODULES:?Set existing locked atomic-usage node_modules directory}"
: "${STAGED_READER_POSTGREST_BIN:?Set verified PostgREST 14.5 executable}"
: "${STAGED_READER_EVIDENCE_DIR:?Set absolute writable evidence directory}"
[[ "$STAGED_READER_EVIDENCE_DIR" == /* ]]
STAGED_READER_TEST_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
mkdir -p -- "$STAGED_READER_EVIDENCE_DIR"
STAGED_READER_EXPECTED_BINARY_SHA=39ce04b0597c6b3c3eb4c5f34fe6ab590a2d0172616eeaccf1e4c659b822295a
STAGED_READER_BINARY_SHA=$(sha256sum -- "$STAGED_READER_POSTGREST_BIN")
[[ "${STAGED_READER_BINARY_SHA%% *}" == "$STAGED_READER_EXPECTED_BINARY_SHA" ]] || { echo 'Unexpected PostgREST binary SHA-256' >&2; exit 1; }
STAGED_READER_DATA=$(mktemp -d /tmp/runvara-postgrest-pg.XXXXXX)
STAGED_READER_PORT=unselected
STAGED_READER_CHILD=
cleanup() {
  local result=$?
  trap - EXIT
  if [[ -n "$STAGED_READER_CHILD" ]] && kill -0 "$STAGED_READER_CHILD" 2>/dev/null; then
    kill -TERM "$STAGED_READER_CHILD" 2>/dev/null || true
    wait "$STAGED_READER_CHILD" || true
  fi
  if "$STAGED_READER_PG_BIN/pg_ctl" -D "$STAGED_READER_DATA" status >/dev/null 2>&1; then
    "$STAGED_READER_PG_BIN/pg_ctl" -D "$STAGED_READER_DATA" -m fast -w -t 15 stop >> "$STAGED_READER_EVIDENCE_DIR/cleanup.log" 2>&1 || result=99
  fi
  if "$STAGED_READER_PG_BIN/pg_ctl" -D "$STAGED_READER_DATA" status >/dev/null 2>&1; then
    echo 'ERROR: disposable cluster remains running; retaining data for safe cleanup' >> "$STAGED_READER_EVIDENCE_DIR/cleanup.log"
    exit 99
  fi
  cp "$STAGED_READER_DATA/server.log" "$STAGED_READER_EVIDENCE_DIR/postgres-server.log" 2>/dev/null || true
  if [[ "$STAGED_READER_PORT" != unselected ]]; then
    env -i PATH=/usr/bin:/bin STAGED_READER_PORT="$STAGED_READER_PORT" "$STAGED_READER_NODE" --input-type=module >> "$STAGED_READER_EVIDENCE_DIR/cleanup.log" <<'JS' || result=99
import net from 'node:net';
const socket = net.connect({host:'127.0.0.1',port:Number(process.env.STAGED_READER_PORT)});
socket.setTimeout(1000);
socket.once('connect',()=>{socket.destroy(); console.error('ERROR: PostgreSQL TCP socket remains open');process.exitCode=99;});
socket.once('timeout',()=>{socket.destroy();console.error('ERROR: PostgreSQL socket cleanup unverified');process.exitCode=99;});
socket.once('error',error=>{if(error.code!=='ECONNREFUSED'){console.error(error.code);process.exitCode=99;}else console.log('Verified disposable PostgreSQL TCP socket closed');});
JS
  fi
  echo "Verified stopped disposable cluster $STAGED_READER_DATA at 127.0.0.1:$STAGED_READER_PORT" >> "$STAGED_READER_EVIDENCE_DIR/cleanup.log"
  [[ "$STAGED_READER_DATA" == /tmp/runvara-postgrest-pg.* ]]
  rm -rf -- "$STAGED_READER_DATA"
  test ! -e "$STAGED_READER_DATA" || result=99
  echo 'Verified temporary cluster data removed' >> "$STAGED_READER_EVIDENCE_DIR/cleanup.log"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
STAGED_READER_PORT=$(env -i PATH=/usr/bin:/bin "$STAGED_READER_NODE" --input-type=module -e "import net from 'node:net';const server=net.createServer();server.listen(0,'127.0.0.1',()=>{console.log(server.address().port);server.close();});")
env -i PATH=/usr/bin:/bin "$STAGED_READER_NODE" --version > "$STAGED_READER_EVIDENCE_DIR/node-version.txt"
env -i PATH=/usr/bin:/bin "$STAGED_READER_PG_BIN/postgres" --version > "$STAGED_READER_EVIDENCE_DIR/postgres-version.txt"
env -i PATH=/usr/bin:/bin "$STAGED_READER_POSTGREST_BIN" --version > "$STAGED_READER_EVIDENCE_DIR/postgrest-version.txt"
env -i PATH=/usr/bin:/bin "$STAGED_READER_PG_BIN/initdb" -D "$STAGED_READER_DATA" -U postgres -A trust --encoding=UTF8 --locale=C > "$STAGED_READER_EVIDENCE_DIR/initdb.log"
env -i PATH=/usr/bin:/bin "$STAGED_READER_PG_BIN/pg_ctl" -D "$STAGED_READER_DATA" -l "$STAGED_READER_DATA/server.log" -o "-h 127.0.0.1 -p $STAGED_READER_PORT -c unix_socket_directories='' -c max_connections=16 -c shared_buffers=16MB -c work_mem=1MB -c maintenance_work_mem=16MB -c max_worker_processes=2 -c max_parallel_workers=0 -c autovacuum=off -c statement_timeout=20000 -c log_min_error_statement=panic -c temp_file_limit=16384 -c max_wal_size=64MB -c min_wal_size=32MB" -w -t 15 start > "$STAGED_READER_EVIDENCE_DIR/startup.log"
env -i PATH=/usr/bin:/bin NODE_PATH="$STAGED_READER_PG_MODULES" STAGED_READER_PORT="$STAGED_READER_PORT" "$STAGED_READER_NODE" --input-type=module > "$STAGED_READER_EVIDENCE_DIR/cluster.json" <<'JS'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { Client }=createRequire(`${process.cwd()}/package.json`)('pg');
const client=new Client({host:'127.0.0.1',port:Number(process.env.STAGED_READER_PORT),user:'postgres',database:'postgres',ssl:false,connectionTimeoutMillis:5000});
try {
  await client.connect();
  const info=(await client.query("SELECT current_database() db,current_user role,current_setting('listen_addresses') listen,current_setting('server_version_num')::int version")).rows[0];
  assert.equal(info.db,'postgres');assert.equal(info.role,'postgres');assert.equal(info.listen,'127.0.0.1');assert.equal(info.version,170006);
  assert.equal(client.connection.stream.remoteAddress,'127.0.0.1');
  assert.deepEqual((await client.query("SELECT datname FROM pg_database WHERE datname NOT IN ('postgres','template0','template1')")).rows,[]);
  await client.query('CREATE DATABASE runvara_outcome_test');
  console.log(JSON.stringify({...info,port:Number(process.env.STAGED_READER_PORT),syntheticLocalOnly:true}));
} finally {await client.end();}
JS
env -i PATH="$(dirname -- "$STAGED_READER_NODE"):/usr/bin:/bin" NODE_PATH="$STAGED_READER_PG_MODULES" \
  OUTCOME_ALLOW_DISPOSABLE_TEST_DB=1 OUTCOME_TEST_DATABASE_URL="postgres://postgres@127.0.0.1:$STAGED_READER_PORT/runvara_outcome_test" \
  STAGED_READER_POSTGREST_BIN="$STAGED_READER_POSTGREST_BIN" STAGED_READER_EVIDENCE_DIR="$STAGED_READER_EVIDENCE_DIR" \
  "$STAGED_READER_NODE" "$STAGED_READER_TEST_DIR/staged-reader-postgrest.mjs" \
  > "$STAGED_READER_EVIDENCE_DIR/staged-reader-postgrest.tap" 2> "$STAGED_READER_EVIDENCE_DIR/staged-reader-postgrest.stderr.log" &
STAGED_READER_CHILD=$!
wait "$STAGED_READER_CHILD"
STAGED_READER_CHILD=
