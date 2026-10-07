# Qualified business outcome memory

## Problem and resulting behavior

Legacy experiment verification retained a mutable `impact` object without a required currency, observation window or immutable source version. Impact totals could combine unrelated currencies and periods; a retained-history total could be divided by a monthly subscription and labeled ROI. A reviewed legacy flag alone did not establish those calculations.

This stage retains those measurements and their owner-review history as explicitly unqualified records. Legacy review cannot establish qualified money, time savings, usable learning priors, forecast ranking or a proposed action's financial impact. Existing activity counts remain visible. Unscoped scalar totals and ROI are unavailable, rather than zero.

An owner/admin can now prepare a typed contribution measurement for an existing experiment. The owner separately reviews and publishes its exact saved version. Publication, correction and withdrawal produce immutable records, an authoritative current head, a targeted workspace update and an audit event in one transaction. The initial qualified metric is incremental contribution. Currency, exact UTC window, complete population coverage, measurement method, observation time and cost completeness must be explicit.

These are owner-attested results. They do not prove that Runvara caused a change, that an external action happened, or that the result will repeat. Initial reports use one server-derived whole-business scope and standalone aggregation. Overlapping observations and reused measurement reports cannot be added together by renaming an experiment. Action, approval and objective links remain null until a real versioned resolver exists. Other outcome metrics and automatic attribution remain separate work.

## Reuse and persistence

The existing experiment stores its editable typed measurement and one bounded source report. Legacy impact is not rewritten into a qualified result. A frozen application-supported currency list removes Node/ICU drift; no FX conversion is performed.

Two tables are added inside the existing Supabase database:

- `runvara_business_outcome_versions` stores immutable outcome versions, exact source evidence and idempotent publication receipts.
- `runvara_business_outcome_heads` selects each tenant's current version through a tenant-inclusive foreign key.

Generic `runvara_history` rows, provisional archives, copied verification flags and workspace pointers cannot confer publication authority. Corrections preserve previous versions. Withdrawal creates a tombstone and preserves a newer editable draft; a withdrawn head cannot be silently reinstated.

The fixed-purpose publisher accepts reviewed identities/preconditions, never a replacement workspace or caller-authored candidate. It locks the workspace, checks the current active owner/session/password-change restriction, verifies the measurement/report and current head, computes canonical hashes and server timestamps, writes the version/head/workspace/audit atomically and returns a receipt. An identical publication ID/intent recovers the original receipt, even after later corrections, without rewinding the head. A mismatched intent conflicts. Failed CAS or audit insertion rolls back all writes.

The source normalizer preserves explicit tenant markers. A foreign-tagged revenue container cannot become local by passing through `store.get` normalization before preparation.

## Approved access boundary

The owner's recorded PR74 approval was conditional on verified PR82 postdeployment health. That condition is now satisfied by the owner-supplied health screenshot described below. The approved migration was applied through the coordinating task as version `20261007100823`; this local alignment changes only the filename and evidence, not its SQL. Application deployment still follows the exact-head release gates.

- Both new tables have RLS enabled, no public/browser-role access and SELECT-only access for the existing server role.
- Only the existing server role may call the fixed-purpose `SECURITY DEFINER` publisher. It has an empty search path and no dynamic SQL; the existing trusted migration owner owns it. It cannot accept arbitrary state or arbitrary financial values from its request parameters.
- A separate service-only `STABLE SECURITY INVOKER` function returns one compact review snapshot using the server's existing SELECT rights. It has no writes, row locks or private-helper grants.
- Private helpers remain non-callable by public/browser/server roles. Immutable versions reject update/delete/truncate through their guards.
- Baseline bootstrap resets preserve the new SELECT-only restrictions and the already-approved legacy/provider usage ledger table/column restrictions. Rerunning the broad legacy bootstrap grant must not reopen immutable request identity or ledger deletion.

No new database, service, account, credential, paid provider or background worker is created. These controls protect application access; a database administrator who changes the guards remains a privileged administrator.

## Usage and completeness

All new work is owner-triggered. Background request/model/crawl volume is zero. No provider or model call is part of preparing, publishing or reading these outcomes.

- Summary: one compact authentication read plus one indexed tenant head/version embedding request. Exact `Content-Range` cardinality is required; the first 50 heads plus one sentinel and a 2 MiB wire/JSON cap bound the result. A lower PostgREST row cap or any incomplete/mismatched read withholds totals.
- Review: compact authentication plus one read-only RPC returning one experiment/report and its current publication from the same snapshot, capped at 128 KiB. It does not transfer the full workspace or all experiment reports.
- Source evidence: one exact tenant/version read on explicit request, capped at 128 KiB. Historical retrieval is not proof that the version is current.
- Draft save: reuses the existing workspace CAS/save path, including its state-size, archive and reporting safeguards. The typed envelope is capped at 8 KiB canonical JSON; the source report is bounded and no full dataset is copied into it.
- Publication: compact authentication plus one fixed-purpose RPC. One successful new publication writes its version, head, workspace revision/pointer and compact audit event. Receipt replay adds no rows. Current policy permits 3 publication requests/minute per authenticated owner, 5 draft requests/minute and 10 outcome reads/minute, in addition to the general API limiter.
- The publisher enforces the existing 2 MiB state ceiling conservatively against post-patch JSONB text. This can reject a near-limit state earlier than the application's compact JSON calculation; it never relaxes the persistence guard. User/experiment collections, canonical recursion, source/version sizes and lock wait are bounded. No function-level statement-timeout guarantee is claimed.

The UI is collapsed and on demand. Repeated clicks coalesce, navigation/session changes discard late reads, and uncertain publication responses retain the exact reviewed idempotency identity. There are no automatic mutation retries or periodic refreshes. Exact decimal strings preserve zero, negative values and fractional units without JavaScript-number rounding. Currencies/windows remain separate, and missing evidence stays unknown.

## Rollout, verification and rollback

The approved migration is recorded in production history as `20261007100823` (`business_outcome_publication`). The source filename is now aligned to that actual applied version. SQL SHA-256 remains `7f642f8d22b7827185998d4847fa3890992a8c0569c3100efe3b69d9c07c179f`, identical to the reviewed and published PR74 SQL. Run the complete CI gates on the aligned application head before merging/deploying.

Required gates include the full Node suite, safety/static checks, real PostgreSQL concurrency/role/bootstrap/hash/rollback cases, API tenant/CSRF/session tests, and responsive browser flows at 320/390/1200 pixels. Local PostgreSQL-engine supplements do not replace real PostgreSQL concurrency/privilege CI. Local Chromium socket restrictions do not count as a browser pass.

No live customer measurement, publication or withdrawal is created during verification. Verify the exact deployed commit and production health, then record evidence. The owner-supplied PR82 health screenshot, relayed by the coordinating task, reports `checkedAt: 2026-10-07T10:04:12.035Z`, exact revision `fa1823756565a356decb4e038af0bdd538484b75`, and all required checks true. This clears the predecessor health condition. It does not verify an outcome application deployment: after the aligned outcome head passes CI and is released, fresh health for that exact deployed outcome revision is still required.

`BUSINESS_OUTCOME_PUBLICATION_ENABLED=false` pauses new publication calls while preserving typed drafts and read access. Any non-`true` configured value fails closed. No production setting has been changed by preparing this switch. An uncertain previous submission remains uncertain until its original receipt/current state is inspected; pausing does not erase or refund anything.

Prefer a forward fix retaining the readers and qualification rules. Do not drop outcome tables, delete immutable history, rewrite heads manually, restore legacy ROI claims or treat archived/provisional rows as committed outcomes to make rollback easier.


## Incremental compatibility evidence

The six published PR74 commits are prepared on the actual merged PR82 main ancestry, preserving the narrow reporting CAS, payload/acknowledgement bounds and cache semantics. No PR75–81 features are included. Fresh local validation passed 708 Node22 tests, 25 outcome PostgreSQL tests, 73 reporting PostgreSQL tests, syntax and SaaS guards. A new two-session race covers reporting/publication in both lock orders; reporting grants are also rechecked after outcome migration and bootstrap resets. Both disposable PostgreSQL clusters stopped after testing. Browser/container and exact-head CI remain release gates. See [business-os-acceptance.md](business-os-acceptance.md) for source commits and current hold conditions.


## Applied catalog and alignment evidence, 2026-10-07

The coordinating task reports successful application of the approved outcome migration and these production catalog results:

- Both `runvara_business_outcome_versions` and `runvara_business_outcome_heads` have RLS enabled. The existing service role has SELECT only; INSERT, UPDATE, DELETE and TRUNCATE are denied. `anon` and `authenticated` have no table access.
- The publisher remains `SECURITY DEFINER`; the compact review reader remains `SECURITY INVOKER`. Both have a fixed empty search path and EXECUTE limited to the existing authorized server role (and privileged owner). Guard/helper permissions remain denied to application/browser roles.
- The security advisor returned 25 INFO RLS-without-policy observations: 23 preexisting plus the two intentional server-only outcome tables. It reported no warning or error.

This worker performed only local filename/document alignment and disposable-database verification. It did not issue the production migration, inspect production through another route, or mutate a remote branch. Fresh exact-head CI and the subsequent outcome deployment/health gate remain with the coordinating task. No live outcome measurement, publication or withdrawal was created by this alignment.


Local alignment verification passed 141 focused Node22.23.3 tests, all 25 outcome PostgreSQL17.6 cases and all 73 reporting PostgreSQL17.6 cases, with zero failures/skips. Syntax, SaaS guards, whitespace and independent alignment review passed. Each database suite used a fresh disposable local cluster and both were stopped. These are affected checks on the renamed file; the earlier full 708-test preparation result does not replace fresh complete CI on this aligned head.

## Prepared reviewed action extension (not applied)

`20261007175355_reviewed_action_outcome_snapshot.sql` prepares publication-time immutable snapshots for explicitly owner-associated recorded Shopify product-content actions. Existing unlinked v1 publication remains supported, with new linking disabled until the compatible SQL contract is installed. Public RPC signatures and existing grants are preserved. See [reviewed-action-outcomes.md](reviewed-action-outcomes.md) for bounds, acknowledgement limits, correction/withdrawal behavior and the separate real-application/release hold. This does not complete original milestone 2 or establish causal/commercial benefit.
