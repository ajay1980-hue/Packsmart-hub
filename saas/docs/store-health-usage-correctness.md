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

The existing PR76 source is `72310bc02e420de9867a3aeebf126862c71058b4`,
originally based on `3ebc1c75370b6a8b843da3829bc1b7af59f0a867`. It is now
prepared incrementally on actual PR75 main
`f3471331062cfb626a5a941d12dab61bd8cd88d3`, preserving PR74 outcomes and PR82's
narrow reporting repair. No PR77–81 features are included.

Fresh full Node22.23.3 validation passed **940 tests**, with zero failures or
skips; syntax, SaaS security guards and whitespace checks passed. Separate fresh
PostgreSQL17.6 clusters passed **25 outcome** and **73 reporting** cases and were
stopped afterward. Independent source and interaction review found no blocking
defect. These local results do not replace fresh exact-head CI or browser/
container gates. PR76 release remains held until PR75 is deployed and its exact
revision passes fresh postdeployment health.

No data rewrite or migration is required. Prefer a forward repair if another
response contract needs adjustment; do not restore success-before-decode or
replace incomplete usage with zero to make an integration appear healthy.

Broader API/retry/body-byte meters and storage-growth reporting remain future
work. Existing stateBytes is a process-global last hot-state observation, not
selected-tenant storage or physical database size. Existing fleet samples and
provider billing coverage must not be presented as complete totals.


## Compatibility with earlier incremental stages

The store conflict was resolved around the existing PR82 shared commit helper,
not by restoring a second full-state reporting save. `commitRevision`, the
strict bounded revision reader, `commitReportingStatus`, dispatch context reads
and save/cache-invalidation logic are unchanged from the current main source.
The primary commit wrapper now owns the explicit health flag. Reporting calls
cannot clear, create or replace a primary-health observation. Decoded invalid
acknowledgement shapes retain PR82's `SUPABASE_PERSISTENCE_RESPONSE_INVALID`
code, while decode failures use the safe response-invalid/too-large codes.

Outcome cardinality metadata is returned after the same single bounded decode;
no response body is consumed twice. Current-head qualification, tenant/session
checks, outcome SQL, dispatch phase claims and no-replay controls remain intact.
No change was made to existing permitted CAS retries or request counts.

Integration tests now inject reporting failure at the actual narrow RPC and
assert the failure occurred. Additional cases explicitly require malformed,
empty, interrupted and oversized reporting responses to withhold decoded-write
success while retaining either prior primary-health state. Valid reporting
acknowledgements likewise cannot repair an unrelated primary failure. Outcome
summary integration retains exact cardinality and unknown partial totals.
Final dispatch proof failures retain the previous successful-read timestamp,
produce only fixed diagnostics, block provider mutation and preserve the claimed
phase so a retry cannot replay it.

No remote write, production request, migration or deployment occurred during
this preparation. Main was fetched read-only; synthetic provider transports and
disposable local PostgreSQL fixtures were used for verification. Local Chromium
remains absent; no browser installation or Docker workaround was attempted.
The original OS remains incomplete and the successor blueprint is untouched.
