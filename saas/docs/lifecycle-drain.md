# Local shutdown and completion settlement

This preparation ports the reviewed production-based lifecycle repair onto the cumulative source tree of `75a70fd7bef00c68c4aa8cea2e53e9b0f86def21`. The newer cumulative claim-admission guards, provider cooldowns, content receipts and order-recovery paths are retained. It does not change database contracts, grants, provider permissions, scheduling quotas, the ten-second shutdown deadline or existing activation and rollback requirements.

## Admission and shutdown

Shutdown closes HTTP and background admission before waiting for HTTP sockets. An admitted HTTP handler remains tracked even while authentication has not yet acquired a workspace lock. Its existing authorized mutation may finish; a new request receives HTTP 503 with `SERVER_DRAINING` and advice to check saved activity before retrying a change. No automatic retry is introduced.

Agent polling and scheduler cycles have terminal, idempotent drains. An old claim, timer, queued lock or state read cannot begin work after stop, including after stop/start. A task that crossed its execution boundary before stop retains its existing provider, result and save sequence. Startup/periodic integrity reads are tracked; they cannot begin a repair after draining, and a repair save already issued is awaited. The drain includes worker bookkeeping after the workspace lock is released.

The finite deadline is still ten seconds. A timeout records an unsettled result and the process entrypoint requests exit code 1. The timeout itself does not cancel provider work, establish a provider outcome, or prove the process terminated. A successful local drain also does not prove that another instance has stopped. Deployment still requires independent predecessor identification and actual termination evidence.

## Completion acknowledgement

An action that returned a result has crossed a separate boundary from its final workspace save and job completion acknowledgement. A failed final save, rejected or false completion write, or lost completion acknowledgement no longer enters the generic execution-failure retry branch. The local worker retains the uncertainty and performs no immediate resubmission or invented terminal update. Actual execution failures keep the existing retry policy.

Local shutdown summaries contain only bounded counters and safe error codes. `settled` means admitted local work has settled, not that every durable job completed successfully. Agent counters cover the process lifetime; `retainedClaims` includes unconfirmed outcomes and does not assert a durable row is still running. Scheduler error counters cover operations included in that drain. These process-local observations are not protected execution receipts or durable reconciliation records.

## Remaining activation gate

No new lease-recovery contract is introduced. Stores can return reclaimed generic jobs beyond their ordinary attempt limit, but the cumulative worker already rejects those claims before tenant state or provider work. That newer max-attempt guard is preserved both before execution and after acquiring the workspace lock. The earlier production-derived lifecycle candidate lacked that generic guard; its broader repeat-execution warning must not be applied to this cumulative source. An action that partially effected an upstream change and then threw can still follow its existing execution-error path. In particular, Connection Doctor has an internal save after a provider read, before returning its overall result; failure there remains an execution error to the caller and can schedule a retry. The protected boundary above is the final agent-operations save and completion acknowledgement after the whole action returns. The separate busy-result correction blocks an early retry that observes an eligible live repair lease, while a delayed retry after expiry and uncertain credential persistence remain unresolved. Those earlier paths require reconciliation before broader side-effect activation; this change is not an exactly-once guarantee. Late claims skipped before execution retain the existing lease and attempt accounting, without a shutdown-only refund or extra database request.

Before enabling newer producers, reconcile unfinished jobs, claims, leases and upstream outcomes, verify that every predecessor has actually terminated, and retain ambiguous provider outcomes as unresolved. The baseline and compatibility bridge are not certified rollback targets after forward SQL, receipt, outcome-consumer or order-recovery activation. This package does not authorize those changes.

## Verification

Synthetic tests use controlled barriers for listing, claim, lock, state-read, provider execution, final save and completion acknowledgement. They cover stop/start epochs, repeat drains, failed/false/lost acknowledgements, unchanged ordinary execution retries, integrity work, admission rejection and HTTP response completion. A child-process test explicitly demonstrates that a timeout result can occur while the process and its outstanding task remain alive. No live provider or production database is used by those tests.
