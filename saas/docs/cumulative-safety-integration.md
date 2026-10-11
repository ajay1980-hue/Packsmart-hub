# Cumulative safety integration

This preparation combines three separately reviewed changes against the cumulative source tree of `75a70fd7bef00c68c4aa8cea2e53e9b0f86def21`. It is a new candidate requiring its own tests and review. It neither replaces nor upgrades the accepted production-derived compatibility bridge automatically.

## Source boundaries

| Component | Reviewed source | Integration treatment |
| --- | --- | --- |
| Cumulative base | `75a70fd7bef00c68c4aa8cea2e53e9b0f86def21`, tree `61fe4c48015221b46b97ae1cf6069781e5d58634` | Recovered locally as `f9596a78ef979cfe171d53ce5ea506e26726fdc0`; tree equality, not commit equality |
| Recorded cost inputs | `4e919d8b8e715b78c18b19b284fffd9f9540cb76` | Apply the exact cost-only validation, existing cache-version and narrow eBay cost-mapping changes |
| Doctor busy settlement | `ff28371c9642affa7ffa3571acf10e003a3cec77` | Apply the exact bounded busy result, blocked settlement, explicit owner review wording and test runner |
| Local shutdown and bookkeeping | `4965744044a08147a7a031b831af3cff0e103263` | Port individual lifecycle hunks from the older production-derived branch; never replace newer cumulative modules wholesale |

The runtime overlap is Agent Ops lifecycle with its current claim/Doctor settlement logic, and server shutdown with its current routes and cost validators. Scheduler admission/tracking changes surround its current implementation. Protected content receipts, recovery staging, financial action restrictions, tenant isolation, provider budgets and eBay waiting periods retain the cumulative contracts. No SQL, grants, persistent credentials, dependency, workflow or infrastructure change is included.

## Required interaction evidence

- A stop during an initial claim, awaited admission check, queued workspace lock or state read prevents new work, including after a stop/start epoch change. Existing max-attempt and stale-claim rejection still precede state/provider access.
- Work admitted before the execution boundary finishes its current result and save sequence. A returned action result followed by failed bookkeeping is not reclassified as an execution failure or automatically resubmitted. False, stale and lost acknowledgements remain unconfirmed.
- Busy Doctor results remain blocked through the current claim fence without a false completed audit, and genuine work for other providers remains saved. Drain includes completion bookkeeping and reports uncertainty rather than success.
- Finite shutdown timeout remains unsettled and does not prove task or process termination. Repeated drains are idempotent; an old timer or queued continuation cannot reopen admission.
- Recorded invalid costs remain unknown while valid explicit zero is retained. Cost-only eBay mapping, cache-version reconciliation, financial dispatch restrictions and ordinary inventory semantics remain intact during HTTP/background lifecycle changes.
- Current content/receipt/recovery admission and failure holds remain intact. This preparation does not activate those contracts or certify older readers as rollback targets after newer state has been written.

## Acceptance and open boundaries

Individual test counts are not a combined acceptance result. The integrated source needs its own frozen manifest, full regression run, independent interaction review and durable source bundle. Existing remote CI and disposable database/container checks must run on the exact public candidate after publication approval. The six added Fleet busy-row screenshots require actual browser capture and pixel inspection; earlier screenshot acceptance is not proof for these changed rows.

A pinned pre-change reader can retain the new blocked job shape, but its UI restores the previous retry wording and its cost parser still interprets malformed false as recorded zero. Data-shape readability is therefore not semantic rollback or mixed-replica safety. Old and new derivation versions must not be assumed interchangeable; raw retained inputs remaining readable does not preserve corrected financial meaning.

The existing public release still requires verified live readiness and predecessor drain/termination evidence through an allowed route. These local changes cannot supply either. Delayed Doctor retry, earlier provider-side save failure, uncertain OAuth token persistence and independent scheduler paths remain open reconciliation risks. A neutral owner retry control does not guarantee safe repetition. No live provider operation, database migration, grant, external-write activation or deployment is authorised by this document.

## Restore and operational hold

Before any new deployment, retaining the current serving revision leaves canonical state and concurrent writes in place. The last recorded production source is `d32da62d0e7935597638266d44d88ae5e066d51f`; this identifies the prior deployment, not a fresh health result. The accepted compatibility candidate `9bb9dd3917dc5eb8db6730660ae209a5b85c2b54` retains its separately tested, narrow reader boundary. Neither revision is certified to restore the corrected cost/busy semantics or to serve after forward SQL, receipt, outcome-consumer or recovery activation.

A compatible post-change rollback release has not yet been verified. Release must remain held until an exact forward and rollback artifact pair is tested against the intended stored state, predecessor instances are actually drained and terminated, and fresh permitted runtime/database verification succeeds. Approval to prepare this code does not approve process stops, database grants or feature activation. An unconfirmed drain, running old replica, unknown provider outcome or missing verification keeps that hold in place.

If a later deployment fails, preserve current canonical records and all concurrent writes. A code restoration must use a tested compatible revision under the approved operational plan; do not rewind a workspace snapshot, backfill guessed evidence, reapply older schema, or discard uncertain effects to make the old code start. Until such a plan exists, the available safe pre-change action is to keep the existing deployment unchanged.
