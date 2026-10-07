# Instance activity observations

`GET /api/activity` is an explicit, read-only owner/admin inspection of the signed-in workspace. It accepts no query parameters or request body. A tenant or platform owner cannot select another workspace through this route. Members/viewers are denied; existing session, password-change and API controls still apply.

The response is an in-memory observation, not an accounting ledger. It makes no claim about provider invoices, network charges, physical database storage, all application traffic, or other server replicas. Missing information is `null`, not inferred zero.

## Contract and lifecycle

The fixed schema is `runvara-activity/v1`:

- `workspaceId`: the authenticated session workspace.
- `instanceId`: an opaque UUID for this store instance, regenerated on restart.
- `instanceStartedAt`: meter construction time.
- `observedSince`: this tenant's first retained observation, or `null`.
- `snapshotAt`: the observation time. Clock uncertainty is reported separately.
- `coverage`: process-local scope, observed/partial/not_observed/unavailable status, restart reset, no persistence, own-tenant omissions/invalid observations/inflight overflow/counter overflow, clock reliability and explicit exclusions. Counter overflow turns counters into declared lower bounds; an overflowed byte total is `null`.
- `db`: attempted/completed/inflight/succeeded/failed counts; fixed outcome, operation, method and known-retry maps; request/response body observations.
- `hotState`: separate `attempted`, `confirmed`, `integrityRead` serialized-size samples.
- `jobs`: observed succeeded/blocked/dead_letter/rescheduled/manual_retry transitions.
- `rateWindow`: the preceding completed five-minute interval, eligibility and reasons.
- `anomalies`: bounded evidence-based observations only; they never trigger actions.

A different `instanceId` means the counters must not be compared as one continuing series. These observations are not persisted or combined across replicas. `observedSince` may be later than instance start. An unobserved tenant may have no retained event or may have reached the retention cap; neither condition means zero real activity. Global/unattributed counters and global capacity figures are internal and absent from both this tenant DTO and public health.

## What is counted

Each invocation of the Supabase request boundary records one API request attempt and, when available, one terminal transport/HTTP/decoding result. This does not count physical SQL statements, affected rows or provider API submissions. A valid empty CAS result is a successful API response, while the separate primary-persistence machinery classifies the revision conflict.

Tenant attribution comes from a separate trusted store-call context. URLs, payload fields, response rows and headers cannot assign attribution. Scoped identity/state reads, primary/reporting commits, governed-counter reads/reserve/settle calls, known job reads/writes and archive/reporting operations provide context. Global queue claims, account lookup, workspace enumeration, pings and any uninstrumented direct request remain unattributed. There is no provider attribution guessed from a table name or request URL.

Known retry categories are `upsert_network`, `primary_statement_cancelled` and `primary_network_reconciled`. A retry is another API attempt with another body-byte observation. A read used to reconcile a write is a read, not a retry. Explicit user retries, SDK/internal retries and provider-side retries are not inferred. Instrumentation does not add or alter retries.

Body fields contain `{bytes, knownObservations, unknownObservations}`. Request strings are measured as UTF-8; fully consumed response text is measured after HTTP decoding. Headers, TLS, compression effects and other network overhead are excluded. Empty permitted responses and HEAD have known zero body bytes. Interrupted or oversized responses have unknown body length; partial consumed bytes are not guessed. Only integer sizes are retained, never request/response content.

Job values count matched, acknowledged finish/reschedule/manual-retry transitions observed by this instance. They are not unique-job totals, queue depth, lifetime failures or a full durable transition history. Global lease-recovery transitions are not inferred from claim results. FileStore does not report database request totals.

Hot-state samples contain `{bytes, previousBytes, deltaBytes, observedAt, observations}`. Attempted save payloads are separate from acknowledged committed payloads. A failed or conflicting write cannot update `confirmed`. `integrityRead` comes only from an existing full saved-state integrity read. Delta compares two serialized samples of the same kind, including metadata/compaction changes. It is not archive growth, physical storage, continuous growth rate or a forecast.

## Bounds and volume

The meter retains at most 64 tenant records and 2 global records, 128 inflight tokens and 2 fixed time windows per record: at most 132 windows. Keys use fixed enums. There is no event log, eviction loop, timer, new database table or persistence write. Capacity/invalid input never changes the business request's behavior.

The endpoint admits at most 10 GET inspection attempts per signed-session workspace per minute in this server process, shared across its users, and has a 32 KiB JSON response ceiling. A precheck uses only the verified, unexpired signed session's workspace; invalid signatures and expired sessions allocate no tenant quota entries and perform no database reads. Above-quota requests perform no identity read. Every admitted request still performs the existing single compact identity read and fresh role, session-version, password-change, request-shape and general API checks. Attempts denied by those checks or returning unavailable observations consume the workspace quota. This process-local limiter resets on restart and is not a persistent or cross-replica budget. Snapshot creation adds no DB/provider calls. There is no periodic refresh or all-workspace fan-out.

The stress test with 64 tenant records and 128 inflight tokens measured a largest tenant DTO of approximately 3.2 KiB; all tenant DTOs plus the internal diagnostic DTO were approximately 202 KiB serialized. These are serialization measurements, not heap measurements. The structural caps bound retained state; no physical memory-byte claim is made.

A representative unchanged Supabase save still performs its existing three requests: two state CAS writes and the existing variants read. Activity capture adds zero requests or storage writes. Reporting/archive POST bodies retain their existing batching and limits.

## Anomalies and incomplete coverage

Hot-state flags report the observed sample kind and timestamp: warning at 1.5 MiB, hard-limit observation at 2 MiB. An attempted oversized payload must never be displayed as stored bytes.

Rate flags use completed requests in the preceding fixed five-minute window, anchored to retained observation start. They require at least 10 completed observations and at least 5 failed or known-retried completions comprising at least 50%. After an inflight-token omission, `db.inflight` is unknown (`null`) and `coverage.inflightReason` explains the loss of certainty; it is not a claim of no pending requests. Current/past missing completions, omissions, counter overflow, clock rollback and insufficient samples withhold flags. The DTO includes the exact window and eligibility reason. Lifetime partial counts remain partial even if a later window is useful.

Existing governed usage remains the separate durable reserve/settle accounting source. Its USD pricing estimates, held uncertainty, selected admission-month coverage and provider-bill exclusion are unchanged. This meter adds no spending or execution authority.

## Prepared release gates

The combined local backend/frontend suite passed 628 tests, including the
pre-authentication resource guard. Syntax, SaaS security guards and whitespace
checks passed. Responsive browser and container verification remain CI gates.
This stage depends on the store-health corrections in PR76 and adds no schema
or permissions. Production remains held pending ordinary functional verification
of stage 10; no new telemetry or UI has been deployed by this preparation.
