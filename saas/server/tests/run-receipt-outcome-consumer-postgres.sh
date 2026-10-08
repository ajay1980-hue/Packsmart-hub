#!/usr/bin/env bash
# Reuse the audited disposable PostgreSQL lifecycle; no installation or real DB.
set -euo pipefail
RECEIPT_OUTCOME_TEST_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export CONTENT_RECEIPT_TEST_FILE="$RECEIPT_OUTCOME_TEST_DIR/receipt-outcome-consumer-postgres.mjs"
exec bash "$RECEIPT_OUTCOME_TEST_DIR/run-content-execution-receipt-postgres.sh"
