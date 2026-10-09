# Bounded updated-order replay window

This preparation changes the existing Shopify order importer from a created-at
selection to one bounded updated-at replay. It removes the creation-date
exclusion for older orders that the existing account permissions can return.
It does not enable a sync, add a scope, add a second read stream or deploy code.

## Request and observation contract

Each attempt captures one UTC `startedAt`. The lower bound is midnight UTC on
the date 90 days before that instant, retaining the previous lookback length.
The upper bound is the same captured `startedAt`. Every page uses the identical
quoted search interval, lower-inclusive and upper-exclusive:

`updated_at:>='2026-07-09T00:00:00.000Z' AND updated_at:<'2026-10-07T10:00:00.000Z'`

The existing query now uses `sortKey: UPDATED_AT, reverse: false`. Only the
provider's opaque `endCursor` advances pages. A subsequent attempt starts with
a null cursor and recomputes the rolling lookback; it does not advance a stored
checkpoint or derive a filter from `lastSuccess`, `finishedAt` or a maximum
returned update timestamp. Tied update times are not used as cursor values.

The requested interval is evidence about the request, not an as-of snapshot or
a completeness guarantee. Orders can change during pagination and search
results can appear later. A moving order omitted from this attempt remains in
retained state; a later eligible replay can refresh it. `sourcePeriod` stays
`unverified`, and `queryExhaustion: observed_exhausted` describes only the
returned pagination flags. Account ID remains null and scopes remain
`not_observed`; no identity or permission call is added.

Shopify's default order access remains restricted to orders created in the last
60 days. Older orders require approved `read_all_orders` with an existing order
scope. The updated-at filter cannot bypass that limit. This slice requests no
new scopes and establishes no live access or historical coverage.

## Versioning, retention and admission

New request manifests use `shopify-order-read/v2` and `sor2:` digest references.
The digest covers the exact query, requested lower and upper bounds,
`sortKey: UPDATED_AT`, `reverse: false`, observation metadata and source record
digest. Validation requires the bounds to match the frozen start and 90-day
policy. Historical `shopify-order-read/v1` / `sor1:` descriptors remain valid
without rewriting their bytes. The bounded `shopify-order-reads/v1` container
can retain both versions under the same eight-manifest / 16 KiB limit.

Source-money strings, nulls, currency exceptions and `recordsDigest` inputs are
unchanged. The reporting financial object still identifies the source-money
format as `shopify-order-read/v1`; changing a request observation does not dirty
unchanged money mirrors. Missing orders and foreign-provider rows remain, as do
all five owner-entered cost overrides. Invalid metadata or any admission limit
failure retains prior orders and the prior successful observation.

The new request policy is
`shopify-orders-v2:90-day-updated-window:10-pages:50-orders:100-lines`.
The recognized v1-to-v2 transition does not reset structural holds or consumed
Doctor attempts. An unknown or malformed bound policy blocks automatic order
admission before a workspace claim/save even when attempts remain; this does
not relabel or reset its stored counter. Rotated tokens, unavailable configuration
and missing/enriched identity metadata cannot establish a replacement source.
Non-exhausted products-only work and token refresh can continue without releasing
order protections. Positively changed
known account/domain/connection/API identity keeps its existing separate-source
handling. A successful explicit orders retry can recover through the existing
admission and persistence path.

Conservative matching of a retained protection is separate from strict binding
checks on in-flight success or a new failure. Treating an old hold as applicable
does not authorize accepting a result from a changed configuration.

All existing ceilings remain: 50 orders/page, 10 pages, 100 lines/order, 2 MiB
returned body, 4 KiB per manifest, 16 KiB map, 256 KiB source metadata,
128 KiB encoding growth, 2 MiB state/reporting body and 32 KiB commit reserve.
Partial GraphQL results, duplicate identities, nonadvancing cursors, overflows,
uncertain saves, CAS conflicts and lease expiry retain their prior fail-closed
behavior. No scheduler, job-admission or successful-save count is increased.

## Synthetic measurements

Run `node tests/shopify-source-budget-check.mjs` from `saas/server` with Node 22.
The fixture contains 500 orders and 2,000 lines; every provider/database response
is local. One read makes ten requests with 12,728 request-body bytes and 875,199
response-body bytes. These counts exclude headers and transport overhead and
do not establish Shopify query cost or live-provider behavior.

| Snapshot representation | Bytes |
|---|---:|
| Pre-capture state | 597,460 |
| First v2 capture state | 659,725 |
| Added bytes | 62,265 |
| Shared manifest map | 2,457 |
| Per-order reference contribution | 44,000 |

| Existing store operation | Requests | Request-body bytes |
|---|---:|---:|
| Warm baseline save | 3 | 598,141 |
| First capture save | 4 | 1,211,407 |
| Unchanged second capture save | 3 | 662,604 |
| Cold mirror-cache save | 9 | 1,423,802 |

The first exact-string capture still adds the same one 551,001-byte financial
mirror request. Repeated unchanged observations make no order or financial
mirror request. v2 request metadata adds 169 bytes per retained manifest versus
the v1 fixture, and the new policy label adds seven bytes per persisted binding.

The existing queued structural-failure fixture retains its 9 warm / 19 cold
request assertions. For `SHOPIFY_ORDER_SOURCE_SHAPE_INVALID`, the populated
small fixture sends 10,251 / 16,020 request-body bytes; the 500-order / 2,000-line
variant sends 290,232 / 706,614 bytes. These include the worker claim, primary
state read/save, reporting status, normal mirrors and fenced job completion.
Held scheduler/Doctor checks make zero provider calls and zero workspace saves.

## Verification and limitations

Coverage includes an actual filter-aware older-created/recently-updated order,
all owner overrides, absent/foreign rows, frozen all-page bounds, timestamp ties,
exclusive-upper replay, empty results and a moving-mutation case. Mixed v1/v2
descriptors and unchanged money mirrors are checked, along with rehashed invalid
bounds, timestamps, sort direction, version and response metadata. Existing
partial-response, cursor, duplicate, body/admission overflow, retry, persistence,
CAS, lease, unknown-outcome and source-consumer/selected-dispatch tests remain
in the verification set.

Shopify's schema validator accepted the existing selection with the updated
sort, explicitly resolving API version `2026-07`. Validation used only the
public query shape with telemetry disabled; no merchant operation was executed.
Repository-wide verification and independent review are separate parent gates.

The final focused source/protection run passed 183 tests, and the separate
imported-source/selected-outcome/dispatch compatibility run passed 343 tests,
with no failures or skips. The configured syntax check and whitespace check
also passed. The final combined Node 22 run then passed all 1,353 tests with no
failures or skips. A separate 18-case adversarial rerun passed against that same
runtime code, including non-exhausted unknown policies, queued Doctor no-op
accounting, supplied automatic runs, and explicit recovery. These remain local
preparation results; exact-tree remote CI and release checks are separate.

This is an updated-order window, not complete incremental ingestion, a webhook
change feed, a deletion feed or financial-readiness evidence. No production call,
release, migration, permission change, financial action or provider mutation was
performed.

## Official API references

- [Orders, API 2026-07](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/orders)
- [Order sort keys, API 2026-07](https://shopify.dev/docs/api/admin-graphql/2026-07/enums/OrderSortKeys)
- [Search query syntax](https://shopify.dev/docs/api/usage/search-syntax)
- [GraphQL cursor pagination](https://shopify.dev/docs/api/usage/pagination-graphql)
- [Order access scopes](https://shopify.dev/docs/api/usage/access-scopes#orders-permissions)

## Optional recoverable preparation

[Optional order recovery](shopify-order-recovery.md) retains an interrupted fixed
updated-order window through private bounded staging. It remains a separate,
explicit opt-in; ordinary fresh imports retain this document's v2 behavior.
