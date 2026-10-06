# Objective-linked Commander preparation

This stage connects an active saved objective to an owner-triggered internal review through the existing durable agent queue. Commander selects at most three existing specialist identities, reviews canonical recorded opportunities and returns a bounded report with original opportunity references, evidence gaps and policy checks. It does not invoke a model, contact a provider, create an approval or execute a commercial action.

A completed diagnostic is not a ready commercial proposal. Unknown future contribution, source currency, objective-period coverage, gross margin and stock-cover evidence remain unknown. Contribution margin is not substituted for gross margin; rolling advertising totals are not treated as complete calendar-month spending. Observation-only policy suppresses recommendations. Existing approval requirements are retained.

## Persistence and authority

The report is stored only in the existing tenant-scoped job.result, atomically with job success. It is not copied into the business snapshot, agentRuns, workRecords or audit arrays. The immutable job actor, timestamps, objective revision and source fingerprint provide provenance. This prevents workspace archiving or a save-before-finish retry from duplicating reports or work histories.

Only authenticated current owners/admins can request or read the review. The server derives the tenant, actor, session version, deterministic route and idempotency key. Callers cannot select providers, agents, token units, evidence, approval posture or a custom deduplication key. Execution rechecks the original actor, session, objective revision/status and relevant policy/evidence. Explicit report retrieval checks current evidence again and marks changed reports historical. The result never authorizes external execution.

The existing job table gains the objective_prepare type and a zero-provider/zero-model/zero-AI-unit constraint. A narrow SECURITY INVOKER row trigger checks lease expiry after row-lock acquisition, protects immutable job/report fields, and preserves the existing exact expired-lease recovery transition. It reads no other tables and adds no role, credential or direct function-execution grant. Tenant/worker/attempt/original-lease predicates separately prevent stale ownership from completing a reclaimed job.

An ambiguous completion is reconciled by reading the exact tenant/job. A matching persisted success is reused; only the identical body may retry against the same live claim. An unknown outcome is left for bounded lease recovery rather than blindly rescheduled or marked failed.

## Usage budget

There is no recurring background analysis or additional queue or worker. Existing concurrency and exponential idle backoff remain in use. The POST endpoint allows at most three explicit preparation requests per user/workspace per minute, and unchanged relevant inputs reuse one durable job. Input hashing excludes unrelated revisions and read timestamps while retaining meaningful evidence, currency, policy and objective-status changes.

Normal processing uses existing compact authentication, a workspace read at enqueue, bounded queue insertion/deduplication, a workspace read at execution and one atomic job completion. Explicit report retrieval reads current evidence once for staleness. These are existing snapshot reads, so their actual bytes depend on the tenant; this stage does not claim all business reads have become incremental.

While the owner keeps a requested review visible, status checks use compact identity and one exact-row job projection, without downloading full workspace evidence or report bodies. The browser waits 2/4/8/10 seconds and caps a session at eight status checks, pauses on navigation/logout/tab hiding, and offers manual resumption. A terminal report is fetched once. Status responses are bounded to 2 KiB and reports to 64 KiB UTF-8. Existing list/fleet views perform two bounded projections so objective reports cannot multiply across the 100-row legacy job list. No provider requests, model tokens or external write volume is added.

A local synthetic 1,000-opportunity fixture produced a 37,098-byte report in approximately 33 ms, with three specialists and ten proposals. Its 100-record canonical cap was explicitly marked incomplete. This is an executor benchmark, not a production latency or cost guarantee.

## Verification and release gates

Required coverage includes typed inputs, tenant/role/session/CSRF boundaries, policy changes between enqueue and execution, source-fingerprint completeness, unknown financial evidence, repeat requests, ambiguous completion, same-worker attempt fencing, no snapshot mutations/provider calls, compact status reads, report size and UI lifecycle/polling limits. Dedicated PostgreSQL 17.6 tests must verify real independent-session lock-wait expiry and unchanged claim recovery; PostgreSQL-WASM supplements do not replace that gate.

Production release must follow final combined tests, independent review, real browser/mobile checks, container smoke and migration verification. No real customer objective or review is created during verification. Rollback disables the new enqueue UI/route and reverts application code while retaining existing job results/history and the compatible integrity constraint; never delete customer reports to roll back.

Pre-PR verification: 405/405 combined Node tests, syntax and existing safety guards passed. Independent review confirmed complete typed-input fingerprints, deterministic report ordering and bounded exhausted-lease recovery. The dedicated SQL suite contains 51 cases, including four separate-connection races; real PostgreSQL CI remains required before release.
