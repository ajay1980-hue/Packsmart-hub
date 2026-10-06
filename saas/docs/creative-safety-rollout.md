# Creative submission safety boundary

## Behavior change

Previously, an enabled creative worker could submit Canva asset-upload, autofill and export requests or a Runway generation request when provider configuration and availability checks passed. Approval to publish a campaign did not authorize those potentially chargeable preparation steps. Scheduler completion records also reported zero spend and no external writes regardless of what the creative worker attempted.

New chargeable creative POSTs now fail closed unless the server supplies a trusted exact-phase allowance. No production caller currently supplies that allowance issuer. An enabled campaign, a connected provider, an existing account balance, a workspace setting or the customer's existing subscription cannot grant permission to generate. This release therefore does not activate paid generation.

This is an application behavior change. It does not disable either provider account, remove credentials, change the provider connection setup, purchase credits, publish content or change existing advertising. Existing authorized OAuth refresh may still rotate and persist a Canva access/refresh token when needed to observe a saved job; no new credential-rotation workflow is introduced. Token maintenance is not counted as a creative status GET or generation submission. Existing channel, connection-health and noncreative automation behavior remains separate.

## Missing allowance dependency

A future trusted server-side issuer must verify owner approval and atomically reserve a finite verified provider-cost allowance for the exact workspace, campaign, creative request, provider, phase and input digest. The boundary also requires approval identity/revision, reservation identity, policy revision, currency, verified upper bound and unexpired validity. Browser input, provider estimates and raw workspace settings are not an issuer.

The scheduler and explicit creative route expose durable-store capability only for Supabase. A future authorized POST additionally requires a successful compare-and-save acknowledgement, including a changed workspace revision and matching saved workspace identity. FileStore and no-op persistence cannot satisfy this claim acknowledgement. This capability flag alone is not an allowance and never activates dispatch.

The exact phase is rechecked after asynchronous allowance resolution so concurrent callers sharing one request cannot both claim it. The save acknowledgement must contain this exact claim. Immediately before HTTP dispatch, the worker rechecks allowance expiry, unchanged claim fields, current campaign/request membership and the prepared payload, source and credential bindings. The authoritative receipt is held separately from mutable workspace data; changing a saved expiry or reservation cannot extend it. Current credentials and existing enabled/provider gates are resolved again from state, so a disconnect or key rotation during persistence cannot be concealed by the prepared HTTP snapshot. Expired or changed claims remain retained and non-replayable; this stage neither refunds nor invents a replacement allowance.

The current code provides the submission boundary, not the missing approval/reservation service or settled provider billing. Supplying such a service is a separate change requiring its own authorization, review and verification.

## Existing jobs and no-replay behavior

Valid known Canva job IDs and Runway task IDs may still be polled through the existing creative worker. Status reads retain previously submitted work and do not grant permission to start a subsequent chargeable phase. A completed upload or autofill therefore does not authorize the next autofill or export POST.

Each campaign cycle selects at most eight eligible unfinished requests, prioritizing saved upstream jobs before applying the bound. A persisted round-robin cursor shares those slots across still-running jobs, including failed reads, without reordering or dropping the full request history. Automatic cycles also rotate fairly across eligible campaigns using a persisted campaign cursor. Explicit campaign requests retain their exact scope and do not move the automatic cursor. The existing one-campaign/eight-request cycle bound and polling interval are unchanged.

Legacy requests without trusted dispatch history retain historical cost uncertainty. They are not relabeled as fresh, zero-cost requests or automatically resubmitted. An existing provider ID is evidence for observation, not proof that the original submission was free.

The existing 200-campaign draft bound no longer silently discards business records. Every existing draft, claim, upstream ID and approval reference is retained, including unsent work. At the bound, new drafting returns `CREATIVE_HISTORY_RETENTION_REQUIRED` until a verified archive or owner-reviewed deletion path is available; existing requests and provider connections remain intact.

Before any future permitted chargeable POST, the worker must save a durable phase intent. A previously claimed phase, changed input binding, ambiguous provider response or interruption cannot blindly replay that POST. A confirmed upstream ID is retained for observation. Ambiguous outcomes remain uncertain because the provider may already have accepted and charged for the request. This is conservative no-replay handling; it is not a claim of exactly-once execution across the database/provider boundary or a complete billing reconciliation system.

Provider requests reject HTTP redirects. A 307/308 cannot silently replay a claimed POST at another endpoint; the first attempt remains uncertain and non-replayable.

## Truthful scheduler reporting

Creative run records and evidence include provider-read, submission-attempt, confirmed-submission, uncertain-submission and blocked-submission counts; historical exposure uncertainty; external-write state; spend; and cost status. Only these safe fields are copied from the worker. Raw provider responses, prompts and credentials are not added to scheduler evidence.

- A blocked fresh submission with verified no attempt may report spend 0 and costStatus `not_incurred`.
- A known-ID read with historical exposure reports spend null and costStatus `unknown`, even when this cycle made no external write.
- An attempted generation has unknown spend. A confirmed submission reports externalWrites true; an uncertain outcome without a confirmed submission reports externalWrites null.
- Normal worker returns with blocked or uncertain submissions remain visible as blocked automation work, including when another part of the campaign progressed.
- Worker persistence errors carry their safe effect summary into failure evidence before the run is finished, preserving uncertainty even when the automation's status is failed.
- A creative claim begins with unknown effects until completion evidence establishes otherwise. Interrupted legacy runs without effect evidence cannot retain a zero-spend assertion.
- Cycle results and the cycle-finished audit aggregate creative effects conservatively. A mixed cycle cannot hide creative uncertainty behind successful read-only work. Noncreative-only response behavior is unchanged.

No new periodic worker, polling schedule or recurring provider job is introduced. Existing scheduling and workspace locking continue to apply.

## Verification and release gates

Focused scheduler tests are mock-only and forbid network requests. They cover blocked work, known-ID historical exposure, confirmed and uncertain submissions, partial progress, persistence failures, absent or contradictory effect evidence, interruption recovery, durable-store capability and unchanged noncreative reporting. Provider/lifecycle tests must independently verify every chargeable phase, exact allowance binding, persist-before-submit ordering, ambiguous outcomes, durable acknowledgement failures and no replay.

Before release, run the combined server test suite, syntax checks and existing repository safety guards against the final integrated change, and review API/scheduler evidence together with all chargeable provider paths. No production provider calls, real credentials, migration application, paid activation, live billing changes or customer creative submissions are part of this local verification. A green mock suite is not evidence that live paid generation is approved or ready.

Rollback must preserve phase intents, upstream IDs and uncertain outcomes. Reverting to the earlier unguarded dispatch path would remove this safety boundary; retained intent history must not be deleted to make an old request eligible for replay.

### Retention compatibility

The current quota-safe retention planner requires finite known spend. Creative records with spend null therefore remain full records; they are not compacted by that planner. This intentionally preserves unknown cost and effects instead of converting them to zero. Extending the archive/stub schema for unknown spend requires a separate tested change.
