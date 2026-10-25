# Creative submission safety boundary

## Behavior change

Previously, an enabled creative worker could submit Canva asset-upload, autofill and export requests or a Runway generation request when provider configuration and availability checks passed. Approval to publish a campaign did not authorize those potentially chargeable preparation steps. Scheduler completion records also reported zero spend and no external writes regardless of what the creative worker attempted.

New chargeable creative POSTs fail closed unless the protected server issuer supplies a trusted exact-phase allowance. The existing scheduler and explicit creative route now share `authorizeCreativePhase`, enabled only by the exact `RUNVARA_CREATIVE_ALLOWANCES=enabled/v1` value with Supabase persistence and the creative database contract installed. The default is disabled. Empty/unverified policies deny new submissions even with that switch enabled. An enabled campaign, connected provider, account balance, workspace setting or subscription is not generation authority. Installing this release does not activate paid generation.

This is an application behavior change. It does not disable either provider account, remove credentials, change the provider connection setup, purchase credits, publish content or change existing advertising. Existing authorized OAuth refresh may still rotate and persist a Canva access/refresh token when needed to observe a saved job; no new credential-rotation workflow is introduced. Token maintenance is not counted as a creative status GET or generation submission. Existing channel, connection-health and noncreative automation behavior remains separate.

## Protected approval and budget contract

The issuer verifies a typed `creative_phase/v1` owner approval and atomically reserves a finite verified cost ceiling for the exact workspace, campaign, creative request, provider, canonical provider account, phase and input digest. Approval identity/revision, owner session version, pricing/capability contract, account and tenant policy revisions, USD currency, verified upper bound and unexpired validity are bound into protected records. Source and prepared-payload digests bind the exact review; the database compares the source projection with the current saved creative before approval, reservation and final dispatch admission. Browser estimates, generic or publication approvals, subscriptions and raw workspace settings cannot substitute for this authority.

The scheduler and explicit creative route expose durable-store capability only for Supabase. An authorized POST additionally requires a successful compare-and-save acknowledgement, including a changed workspace revision, matching saved identity and exact phase claim, followed by a one-use protected dispatch admission. FileStore and no-op persistence cannot satisfy either boundary. A lost admission response retains the hold and blocks replay; it is not assumed to mean that nothing committed.

The exact phase is rechecked after asynchronous allowance resolution so concurrent callers sharing one request cannot both claim it. The save acknowledgement must contain this exact claim. Immediately before HTTP dispatch, the worker rechecks allowance expiry, unchanged claim fields, current campaign/request membership and the prepared payload, source and credential bindings. The authoritative receipt is held separately from mutable workspace data; changing a saved expiry or reservation cannot extend it. Current credentials and existing enabled/provider gates are resolved again from state, so a disconnect or key rotation during persistence cannot be concealed by the prepared HTTP snapshot. Expired or changed claims remain retained and non-replayable; this stage neither refunds nor invents a replacement allowance.

The migration `20261025131500_creative_allowances.sql` adds six RLS-protected tables: budgets, verified prices, approvals, reservations, audit and settlements. Direct access is revoked from anonymous, authenticated and service roles. Seven backend RPCs expose prepare, review, decision, reserve, confirmation, observation and settlement; private helper functions are not executable by those roles. The functions lock the workspace and both finite allocation rows, using deterministic account/tenant budget lock ordering. Unique tenant/request/phase identity and reservation/receipt constraints prevent conflicting claims. No accounts, opening balances, real prices or budgets are seeded.

Both tenant and canonical provider-account allocations must cover each phase. The account allocation is shared across tenants, credential versions and phases; a credential hash is not an account identity. Caps are safe-integer USD micros. Cumulative reserved, held, spent, released, uncertain and overrun counters use exact numeric integers, transported as decimal strings; the UI uses integer formatting. These are finite allocations with explicit validity, not automatically reset monthly spend. Month rollover, expiry, cancellation, code rollback and policy revision changes do not delete claims or reset counters. An overrun is recorded truthfully and blocks additional admission on both scopes.

Completed jobs retain the full hold until a trusted billing receipt establishes the charge. The server-only settlement RPC has no browser route and is not automatically invoked by completion. An immutable receipt may move the hold to spent/released; duplicate identical receipts are idempotent, conflicting or reused receipts fail. A release without billing proof is allowed only with explicit non-dispatch evidence while the protected dispatch entitlement has never been issued. Unknown outcomes cannot be refunded, resubmitted or moved to another provider. The receipt digest records provenance; it is not an independent authentication of provider billing. A trusted operational reconciliation source must verify account, receipt, job and amount before using this boundary.

### Owner review and remaining provisioning

In the existing marketing campaign view, owners can explicitly read a saved phase review, prepare its exact source/payload review, approve/reject it, or revoke future admission. Admin/member/viewer roles cannot prepare or decide. The UI shows the canonical account, exact creative and prepared request, price/approval revisions, ceiling, budgets, expiry, reservation/accounting status, exposure and known task ID. Each Canva POST phase needs its own approval; reviewing or finishing one never authorizes the next. Quiet mode keeps these routes closed.

Preparing may read source image bytes or Canva template data, but cannot dispatch generation or save a workspace claim. Browser preparation identity is retained per owner/tenant/request/phase before its POST. Unknown responses offer an explicit saved-record read, never an automatic mutation retry. Reload/logout/re-entry cannot replace the protected logical identity; known jobs are recovered for observation only. An unavailable browser storage API blocks preparation without breaking app startup. Already-admitted work can finish after revocation; revocation cannot atomically unsend an external request.

Verified provider-account identity, current capability/entitlement, finite all-in phase pricing ceilings and opening allocation exposure must be supplied by a separately authorized trusted operator. These cannot be inferred from credits, a paid subscription or client fields. The adapter contracts remain limited to Canva asset upload/autofill/PNG export and the existing Runway product-ad recipe. No universal provider API, new model, billing credential or scheduler is added.

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

`creative-allowance.test.mjs`, `creative-allowance-api.test.mjs` and `creative-allowance-ui.test.mjs` cover the integrated mocked paths. `creative-allowance-browser-check.mjs` exercises the full app with synthetic transport and an isolated browser profile. `creative-allowance-postgres.mjs` runs real local PostgreSQL concurrency/settlement/privilege checks against hash-pinned installed-contract sources and the candidate migration; it requires explicit disposable-database opt-in and never silently skips. An explicitly supplied isolated Windows `pg_ctl`/data pair additionally exercises physical server restart. No test uses a live provider account or credits.

Publication/CI and an installation-only quiet deployment, hosted migration, trusted policy provisioning, a bounded real-credit test, and generation activation are distinct approval gates. The migration is transactional, with a five-second lock wait; RPCs use a fifteen-second statement limit. Installation creates no policy rows or business records, but DDL locks may delay concurrent operations. A Render rollback does not reverse database changes. Preserve new tables, all claims/holds/audit evidence and existing data; do not drop tables, restore production or return to an unguarded predecessor as automatic recovery. Refresh schema/backup evidence and review the exact migration hash before any authorized hosted execution. Backup availability alone does not prove restore validation.

Rollback must preserve phase intents, upstream IDs and uncertain outcomes. Reverting to the earlier unguarded dispatch path would remove this safety boundary; retained intent history must not be deleted to make an old request eligible for replay.

### Retention compatibility

The current quota-safe retention planner requires finite known spend. Creative records with spend null therefore remain full records; they are not compacted by that planner. This intentionally preserves unknown cost and effects instead of converting them to zero. Extending the archive/stub schema for unknown spend requires a separate tested change.
