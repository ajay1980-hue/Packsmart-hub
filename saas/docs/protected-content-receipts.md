# Prospective protected content receipts

This is a prepared contract for the existing Shopify `product_content` operation,
covering manual and objective-bound title/description requests. The server opt-in
is absent by default, and the forward database migration creates an inactive
control row. Applying SQL, enabling its database control, configuring the server
opt-in, and releasing code are separate operational steps. None runs at startup.

## What the record means

An admission records a bounded, originally authorized attempt. A successful
receipt records the application's observed Shopify confirmation and the exact
approved input, decision, source and dispatch identity. Its insertion must commit
in the same transaction as the final workspace result. The protected storage
boundary begins with that commit, not with the later owner outcome publication.

This is not a transaction shared with Shopify, provider-signed attestation, proof
of an uncompromised executor, financial qualification or causal effect. Process
loss after Shopify responds but before persistence can leave an unresolved
admission. Later provider state or mutable history cannot replace the lost
original observation. No historical action is backfilled as a receipt.

The existing optional `recordedActionContext` remains mutable. Its omission does
not downgrade a known success or discard a separately prepared receipt. Existing
outcome publication, graph display and learning do not automatically consume this
new ledger or acquire new authority from it.

The separate [outcome consumer contract](receipt-outcome-consumer.md) prepares
explicit selection of an exact receipt in the existing review/publication flow.
It preserves this capture boundary and requires compatible outcome readers;
reader readiness itself does not activate protected dispatch.

## Finite retention and size policy

- At most 256 retained attempts per workspace and 1,024 across the ledger.
- Each successful admission permanently charges one 40 KiB logical allocation.
- Admission JSONB text is at most 4 KiB; the full receipt JSONB text is at most
  36 KiB, including its source and wrapper.
- The reviewed source retains its existing 24 KiB canonical UTF-8 and 32 KiB
  JSONB-text limits. Each quota document is at most 1 KiB.
- There is no automatic deletion, expiry, reset, reclamation or slot reuse.
  Failed, cancelled, abandoned and uncertain admissions remain charged.

This permits at most 10 MiB of reserved evidence documents per full workspace,
40 MiB across all attempts, and 41 MiB + 1 KiB including the maximum bounded quota
documents. These are logical document limits, not physical row/index/WAL/backup
storage or a bill. Existing workspace/history storage is additional. The existing
workspace size limit can bind before the attempt quota. A workspace below its own
quota can also be stopped by exhaustion of the shared global quota.

Required capture can reject content that the legacy path could send without
retaining optional evidence. The entire future receipt is checked before the
provider call, including Unicode/escaping and supported source shape. Protected
dispatch also checks completion-state headroom. Uncertain or unsupported data
does not silently select the legacy path.

## Dispatch and persistence boundaries

The existing actor/session, account, credentials, approval, objective source and
time checks remain. The initial executing-state save remains ordinary. The
protected path replaces the primary transaction at two existing save boundaries:

1. Reserve capacity, insert the exact admission, and commit the new durable
   `shopify_mutation` phase claim atomically under its original workspace CAS.
   Dispatch requires a matching acknowledgement and then the existing final
   fresh authority checks.
2. After an exact confirmed provider result, insert the receipt and commit the
   final workspace result atomically under its original CAS. Finalization binds
   the original admission; it does not demand newly renewed policy eligibility
   after an authorized request was submitted.

A refused or unconfirmed reservation leaves the already saved executing request for review; it does not invent a terminal phase or result. A proven refusal creates no admission or quota charge. Restarting that request does not automatically resume dispatch.

An uncertain acknowledgement never permits another provider call. Every primary
RPC hashes the exact frozen UTF-8 transaction text. A retry uses the same bytes,
identity and revision fences, with at most one repeat of the database mutation.
The private lookup compares the original workspace, attempt, kind, transaction
fingerprint and admitted actor/session. It returns a bounded acknowledgement or
null, not the source document. An absent or unavailable result is unconfirmed.

An exact final receipt can prove its original commit even after unrelated state
changes. Recovery does not rebase an old workspace snapshot or run stale
normalized mirrors/reporting/cache updates. A recovered reservation still needs
the original final fresh check before dispatch. A restarted execution with an
already claimed phase remains non-replayable.

The ordinary success path replaces the primary save calls; it does not add a
separate receipt save or lookup. Existing archives, normalized mirrors and the
reporting-status CAS remain distinct. The receipt acknowledgement binds the
primary revision even when reporting later advances the returned revision.
Exceptional reconciliation calls and their bytes are counted separately.

## Private capability and database protection

Only the server-owned `CONTENT_EXECUTION_RECEIPT_CONTRACT` configuration selects
the prepared client contract `runvara-content-execution-receipts/v1`. Browser
inputs and workspace JSON cannot opt in. Missing/unknown database contracts or
inexact acknowledgements fail closed when capture is required. File persistence
cannot claim protected capture.

The new admission, receipt, quota and control tables deny direct access to
browser roles and ordinary service mutations. Narrow service-only reserve,
finalize and exact-lookup functions use fixed search paths and explicit input
validation. The private acknowledgement travels through a JavaScript WeakMap,
never workspace JSON, a generic response or a browser log.

The database control starts `prepared`. `enforced` admits new protected attempts;
`paused` stops new admissions while preserving existing protection and allowing
already admitted results to finalize. A workspace trigger requires durable
admission/receipt evidence for protected transitions. It does not trust a
caller-set session variable. Returning to an unguarded legacy path is prohibited.

Once protected, admission identity and completed result projections cannot be
rewritten through an ordinary workspace save. Existing pre-activation attempted
phases remain legacy observations; they are not converted into receipts.
Restrictive foreign keys prevent deletion/recreation of their authoritative
workspace row. Update/delete/truncate guards and `schema.sql` privilege resets
preserve the boundary if the base schema is reapplied. Privileged database
administrators remain outside the claimed threat boundary.

## Rollout and verification prerequisites

The migration alone leaves admission inactive. Future activation requires review
of the exact code/SQL/privilege diff and resource measurements, a receipt-capable
reader/writer release, an explicit database-control transition, and server opt-in.
The control transition must take the workspace-table lock before changing the
singleton latch; concurrent saves must observe the new control or fail. Drain
old in-flight dispatch before cutover. Older binaries must stop at their phase
save after enforcement; rollback may pause affected dispatch but must preserve
the database guard and all retained records. Do not roll back to a writer that
can bypass the protected contract.

Preparation verification must cover exact size boundaries, real JSONB conversion,
tenant/global final-slot concurrency, duplicate and altered transaction replay,
lost acknowledgements before/after competing revisions, fresh authority races,
known success with optional-context omission, schema reapplication, direct and
parent/cascade deletion, truncation, old-binary behavior, private serializers,
ordinary disabled-path compatibility, transport counts, and physical storage in
an expressly disposable PostgreSQL database. Live migration, activation,
provider calls, permission changes and production acceptance remain held.

## Preparation evidence

The executable PostgreSQL gate includes full manual/objective dispatcher-to-store
transactions, exact size boundaries, selected-row identity and late-duplicate
checks, capacity races, schema/privilege reapplication, lost acknowledgements and
rollback guards. The existing publication resolver remains limited to 500 rows;
the receipt-specific validator checks all relevant identities in bounded arrays
of at most 10,000 rows / 2 MiB JSONB text before selecting exact source records.
It also checks predictable future write/context and approval completion growth
at reservation, so that overflow cannot first be discovered after sending.

In the final measured disposable PostgreSQL 17.6 fixture, 256 real admissions and
eight successful receipts occupied 802,816 bytes across the four protected
relations, including indexes and TOAST. Their admission/receipt JSONB text total
was 252,832 bytes. This is not 256 maximum-sized completed receipts or a production
estimate. The workspace relation occupied 12,247,040 bytes including repeated
fixture-update churn; it is separate from the reserved evidence-document budget.

With those 256 admissions and 10,000 retained writes near the existing workspace
limit, four generic-save samples took 139–174 ms and four reporting CAS samples
took 159–186 ms. The initial repeated-scan design took 2,847–2,975 ms and
2,674–2,933 ms respectively on the matched fixture. The final guard builds one
ID/count/index map per state while retaining duplicate and immutable-projection
checks. Four source-valid 10,000-row finalizations took 231–253 ms. These are local
synthetic observations, not production latency guarantees; database caches were
not flushed between samples.

Synthetic store tests retained the ordinary request counts: nine for a cold save
and three for a warm save, with one primary transaction and one reporting commit
in each. Example protected primary bodies were 11,313–11,896 bytes versus
7,708–7,800 bytes without evidence; reporting bodies were 355 bytes. Exact recovery
used a mutation and compact lookup with no stale post-commit maintenance. The
maximum unresolved retry sequence is two identical mutations and two lookups.
These are decoded application bodies, not network billing or maximum body sizes.
