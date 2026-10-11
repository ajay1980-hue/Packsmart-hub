# Doctor checks with live repair leases

This preparation corrects a synthetic case on cumulative source `75a70fd7bef00c68c4aa8cea2e53e9b0f86def21`: a provider read completes, the following workspace save fails, and the worker queues a retry. An early retry sees the saved live repair lease and performs no repair, but previously recorded `agent_job_completed` and settled the job as `succeeded` while the saved sync still said `running`.

## Visible settlement change

When the existing Doctor loop skips an eligible provider because its Doctor or sync lease is still live, it adds an optional bounded `busy` array to the result. Each entry has only the fixed provider, `doctor_lease` or `sync_lease` reason, and a canonical `leaseUntil` timestamp. There is at most one entry per connector. A live sync lease takes precedence; its latest live deadline is used. This timestamp describes retained state and does not authorize or schedule another attempt.

The agent worker returns this result before the generic completed audit and outer save. Work already completed for other providers remains saved by Doctor. It settles the same claimed job as existing `blocked`, with `CONNECTION_CHECK_BUSY`, through the existing workspace/worker/attempt/lease fence. A confirmed blocked job does not automatically return to the queue. A null or thrown settlement acknowledgement does not increment processed/failed counts, claim success, or call the reschedule method; it records `AGENT_JOB_CLOSURE_UNCONFIRMED`. Existing lease recovery still applies to an unconfirmed running claim.

This is an intentional user-visible change from terminal success to terminal blocked for an explicitly busy result. Fleet keeps that row visible, explains that another run or uncertain prior completion needs review, and labels the existing owner retry control `Retry check`. Its acknowledgement is neutral. The control still uses the existing authenticated, scoped retry endpoint; it is not a new action or automatic retry. Review connection activity before using it. Existing manual retry resets the job attempt counter, as before.

Storage uses the existing `blocked` status and ordinary job-result JSON. Older readers can retain those fields, but an older UI can lose the new explanation and restore its previous retry wording. Storage readability is not preservation of this behavior, nor proof that the full cumulative release is safe to roll back.

Healthy unchanged scans and existing early durable policy holds retain their prior result shape and completion meaning. They do not acquire busy metadata from a client payload. Existing provider cooldowns, access rules, read budgets, repair leases and scopes are unchanged. Doctor's internal persistence boundaries are unchanged; the worker skips its generic outer save for busy results as described above. A generic retry deadline/exhaustion condition combined with a live lease can be described as busy; early structural holds and eBay cooldown admission retain their existing skip precedence.

## Important remaining uncertainty

This correction does not establish exactly-once work or a global connection hold. If the first retry occurs only after the Doctor lease expires, the existing worker can repeat the read. Synthetic IntegrationService tests also demonstrate that an OAuth refresh can have returned a new refresh token while the old token remains persisted after a failed save; a delayed retry can submit that old token again. The fake transport proves the request sequence, not any real provider's invalidation behavior. No token rollback is inferred.

Other scheduler/manual paths and ordinary expired-job lease recovery remain separate concerns. `externalWrites:false` describes the business-operation result and does not prove that no authentication state changed. Credential persistence, delayed retry safety and real activation remain release gates; no automatic credential reset, new grant, persistent marker, schema change or retry-policy expansion is introduced here.

The production-derived lifecycle candidate `4965744044a08147a7a031b831af3cff0e103263` is separate. It predates cumulative max-attempt admission guards. Any future integration must port its reviewed lifecycle changes onto the cumulative source, preserve those guards and run fresh combined tests; do not replace entire modules from the older branch. The private cumulative integration ports those lifecycle changes deliberately and combines the separate recorded-cost fix; see `cumulative-safety-integration.md` for the source and verification boundaries.

## Evidence and pending checks

Deterministic tests cover the original post-read save failure, early busy retry, first-sync and ordinary reads, confirmed/unconfirmed/stale settlement, healthy and policy-held results, mixed providers, saved successful work, and fake OAuth rotation. A deliberately named delayed-retry test preserves the unresolved behavior as a visible limitation. DOM tests cover Fleet wording, existing retry/session/CSRF/role behavior and untrusted payload exclusion.

The existing responsive runner captures the affected row at 320, 390 and 1200 pixels with normal and enlarged text. Local browser execution and actual pixel review remain pending; syntax or DOM tests are not a substitute. Public backup, exact-head CI, container checks and any eventual deployment retain their own prerequisites. No live provider, credential, database or deployment action is part of this preparation.
