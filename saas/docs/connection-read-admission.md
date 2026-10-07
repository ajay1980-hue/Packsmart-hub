# Durable admission for existing connection reads

This repair bounds automatic eBay, Pinterest and Shopify product-family reads
when a provider has run but the result save is lost. It covers direct Doctor
reads and queued/retried first-sync groups. It adds no provider, read scope,
polling loop, timer, migration, credential, network request or external write.

## One existing ceiling

`pendingReadAttempts` records an absolute admission count in the existing
workspace Doctor record. The effective count is the maximum of that field and
the existing `attempts`, not their sum and not two independently available
five-attempt buckets. A new automatic pass reserves the next count in an
already-required pre-read save. A failed save admits no provider work. A lost
response after the save committed conservatively consumes the reservation.
The fifth admitted pass can finish; later passes stop until explicit recovery
or an applicable known successful result.

First-sync charges once per pass, preserving existing grouping. Pinterest may
read boards and pins in one pass. Shopify may read its product-family group and
orders in one pass. A later group does not receive a new retry allowance.
Completed groups stay completed when their saved results are available, and
retry-failed-only retains that coverage. A later order group adopts the same
pass admission and binds it to the existing Shopify source contract.

The existing workspace lock, durable lease and compare-and-save are reused.
Stale concurrent snapshots lose admission before provider I/O. Lease expiry
permits the next already-bounded pass; it does not reset consumed attempts.

## Orders, recovery and projections

Products-only work does not spend or release an existing order-bound counter.
Its pending read admission uses only the remaining shared headroom. Complete
known non-order success can release that pending debt, without releasing the
order binding. Product failure followed by admitted order success retains the
failed pass's generic debt even when the order adapter releases its binding.
Order-only admissions retain their prior serialization and save counts.

Recognized v1/v2 order policies, unknown-policy fail-closed behavior, structural
holds, missing/enriched identity handling, and explicit order recovery retain
their contracts. A positively verified source replacement clears the old
source's pending admission alongside the existing order-budget reset. Token
rotation and lost/enriched identity metadata cannot prove replacement.

The existing authenticated and CSRF-checked manual sync route is the recovery
path. It validates explicit areas before resetting any debt; null, empty and
unsupported selections cannot clear the counter. A valid products-only retry
can release generic pending debt while retaining protected order attempts and
binding. A retry including orders retains the existing explicit reset rule.

Exhausted or malformed pending admissions block Doctor and scheduler eligibility,
including legacy first-run discovery, without repeated issue audits, saves or
empty scheduler claims. Connection health presents a paused/manual-Retry state,
not an automatic-resume promise or a future automatic retry time. Authentication,
source holds and eBay's known marketing restriction remain independently visible.

Successful token refresh preserves pending read debt and protected order debt.
The pre-existing failed-refresh path still increments the shared Doctor failure
counter, including when it is order-bound. This repair does not introduce a new
non-read retry model or relax that existing limit. Lost-result admission for
refresh operations is outside this read-only repair's scope.

## Synthetic verification and cost

`connection-read-admission.test.mjs` covers before-commit and ambiguous
post-commit save failures, lost successful and failed results, grouped partial
coverage, the final shared admission, protected order coexistence, stale
snapshots, lease expiry, malformed debt, success and manual recovery, source
replacement, health projections and quiet exhaustion. The authenticated manual
route is also covered in `connection-centre.test.mjs`. Existing Shopify order
admission and generic claimed-job quota tests remain unchanged.

Each pending field adds exactly 24 JSON bytes to an existing pre-read snapshot
in the synthetic fixtures. There are zero additional saves or provider reads:

- Direct eBay, Pinterest or products-only Shopify: 1 grouped read, 4 saves
- First-sync eBay or products-only Shopify: 1 grouped read, 7 saves
- First-sync Pinterest boards and pins: 2 grouped reads, 9 saves
- Order-only Shopify retains its 343-byte admission overhead and 4/7 saves

The existing provider page limits and generic daily job-claim limits are
unchanged. This is admission per existing grouped pass, not a universal count
of HTTP requests: a provider adapter can still make its already-bounded page
requests within a pass. All verification uses local synthetic state, source
responses and persistence; it is not production or live-provider evidence.
