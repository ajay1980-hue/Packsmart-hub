# Store health and usage completeness

This patch fixes three observed failure-reporting cases without adding a
scheduler, provider call, database object, permission or new usage meter.

- A successful HTTP status advances read/write success only after the expected
  response body is decoded. Malformed JSON and empty JSON reads fail closed.
  HEAD and explicitly supported minimal/void writes retain their valid empty
  response behavior. Parser and upstream bodies are never kept in diagnostics.
- Primary persistence tracks the last actual primary commit outcome rather
  than ordering wall-clock timestamps, which can tie or move backwards. A
  rejected or unverifiable primary commit is unconfirmed. Expected revision
  conflicts preserve prior evidence; a reporting-status follow-up cannot undo
  or manufacture a successful primary business-state commit.
- Governed usage requests exact response cardinality. Missing, malformed or
  truncated Content-Range, mismatched scope counts, more than 129 scope rows,
  or a response above 128 KiB makes accounting unavailable. A zero total is not
  substituted for unknown or incomplete data.

The existing governed inspector still makes one tenant/month counter query on
an explicit read. The request asks for at most 130 rows, including the sentinel,
and adds exact-count work to that same database request. No additional periodic
read, retry or persistence write is introduced. Existing bounded retry/CAS
reconciliation behavior is retained. This does not turn the ledger into a
provider invoice or cover legacy activity outside its admission contract.

Public health remains a process-level diagnostic view. No tenant-attributed
counter, request URL, credential, source payload or SQL detail is added. An
actual unauthenticated health-route regression checks distinct private sentinels
from malformed JSON and failed primary SQL responses. Only fixed/sanitized
failure codes, timestamps and status remain observable.

The full local suite passed 573 tests; syntax and SaaS guards passed. Tests
cover malformed/empty/minimal responses, tied/backward clocks, primary versus
reporting failures, revision conflicts, exact usage cardinality, response caps
and public diagnostic privacy. Remote CI remains a release requirement. This
is a separate draft from current main; production remains held until stage 10
functional health is verified through an ordinary permitted read.

No data rewrite or migration is required. Prefer a forward repair if another
response contract needs adjustment; do not restore success-before-decode or
replace incomplete usage with zero to make an integration appear healthy.

Broader API/retry/body-byte meters and storage-growth reporting remain future
work. Existing stateBytes is a process-global last hot-state observation, not
selected-tenant storage or physical database size. Existing fleet samples and
provider billing coverage must not be presented as complete totals.
