# Legacy order field semantics correction

Prepared locally above PR81 commit `8bdb685296fbe43a3edffcb55fb374180223a390`.
No ingestion, source-data migration, database schema, reporting mirror,
permissions, recurring work or production request is changed.

## Correction

The existing Shopify mapper (`integrations.mjs:214`) calculates `refunds` from
the rounded, nonnegative difference between two totals. It also places the same
current-tax value in both `tax` and `currentTax`. PR81 previously labelled `tax`
as original tax and used a positive `refunds` field as a refund review cue.
Neither conclusion follows from the recorded fields.

The correction applies to all providers because retained records have no
trusted origin/version contract that establishes the basis of these fields.
Amounts stay unchanged and inspectable, with explicit ambiguity labels and
provenance. Only a recorded `PARTIALLY_REFUNDED` or `REFUNDED` status supports
operational refund review. Such a status does not establish the amount, receipt
or completion of a refund, and grants no execution authority. Stale client
`hasRecordedRefund` flags cannot override a non-refund financial status.

The original evidence schema and API/CSV field names remain compatible. CSV
appends `refund_field_basis` and `tax_field_basis` without moving existing columns;
the values explicitly identify potentially derived refunds and uncertain tax basis.
`OPERATIONS_CALCULATION_VERSION` advances to `imported-order-analytics/v3` so
deterministic summaries cannot silently reuse the earlier classification.
Tenant reconciliation, provider grouping, unknown financial scalars, exact
recorded arithmetic and bounded presentation remain in place.

## Source semantics checked

Shopify's 2026-07 [Order reference](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Order)
defines the selected totals before/after returns and the selected tax as current
tax. These fields are distinct from refund records. The same reference notes
that shipping tax inclusion depends on `taxesIncluded`, which the current query
does not select. The correction therefore infers no original-tax or completed
refund facts from them.

## Separate ingestion design, not implemented

The response already returns exact amount/currency pairs. [MoneyV2](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/MoneyV2)
uses a decimal amount; [MoneyBag](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/MoneyBag)
distinguishes shop currency from customer presentment currency. The current
query selects only shop money. A later reviewed patch could keep bounded source
decimal strings directly in `total`, `currentTotal`, `currentTax`, `discounts`,
`shippingCharged` and line `gross`/`net`, using explicit null for absent values.
It must separately version handling of the ambiguous `tax`/`refunds` fields,
never promote a total difference to a provider refund, and leave older retained
records unchanged until an already-authorized sync naturally observes them.

The smallest evaluated metadata shape uses one source currency plus explicit
per-field exceptions (including null for missing currency), a source format
version, request domain, requested API version, observation time, read ID and
line-pagination fact. This encoding is only safe if the importer checks every
money pair before applying shared currency; downstream code must not infer it
from workspace settings. An explicit currency-per-field shape is simpler but
larger. Neither shape certifies immutable evidence or financial qualification.

The existing [page information](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/PageInfo)
can support observed query exhaustion. `fetchShopifyOrders` must require an
explicit boolean `hasNextPage`, valid advancing cursors, valid nodes and explicit
line-pagination flags; missing data currently can look like exhaustion. Record
the exact existing lower-bound filter, no requested upper bound, page counts,
limits and observation times. Do not equate exhausted provider-visible pages
with a full 90-day business period: order access defaults to 60 days, the query
has no fixed upper bound and older retained orders can change outside it.

Routine order reads do not return a Shopify shop ID or current granted scopes.
The existing separate identity check returns those facts, but it is not run by
order sync. Preserve request-domain provenance without claiming current account
or scope verification; do not add a call, grant, query expansion or recurring job.

## Compatibility audit for that future design

- `imported-order-evidence.mjs:40` already parses bounded decimal strings with
  exact BigInt arithmetic. Greater precision, oversized values, malformed fields
  and currency disagreements must remain unsupported/unknown without rounding.
- `order-analytics.mjs:95` preserves bounded number/string/null primitives in the
  editor DTO. The UI and CSV use these recorded spellings; CSV escaping remains
  necessary for signed strings. Unknown external API clients still need an
  explicit documented number-to-string compatibility transition.
- Business state, operations, briefs, specialists, customer/basket/attribution
  analysis consume the bounded PR81 projection. Qualified financial totals stay
  null. Legacy `profit.mjs` helpers coerce strings to Number and remain unsuitable
  as exact source evidence; no live PR81 monetary consumer uses those helpers.
- `store.mjs:1146` coerces `orders.total` through Number. Its destination is
  `numeric(14,2) NOT NULL DEFAULT 0` (`supabase/schema.sql:195`), so it cannot
  preserve arbitrary exact decimals or unknown amounts. Making this column
  authoritative exact evidence requires a separately reviewed schema/mirror
  change and is outside this design.
- `order_financials.financial_data` and `line_items` are JSONB. String values fit
  without DDL, but change JSON primitive types and the row digest on first
  natural refresh. Keep volatile read metadata off `lineItems`, which is mirrored
  wholesale, to avoid marking every reporting row dirty on unchanged reads.
- Existing full-state persistence can retain new fields without a migration.
  No automatic rewrite or backfill is authorized. New observation metadata adds
  bytes to existing snapshot writes even when no new request is introduced.
- Commit successful order data and its evidence together in the existing sync
  flow. Preserve older orders, manual cost overrides and last successful evidence
  after failure. Products-only sync cannot refresh order coverage. A partial or
  failed attempt must not be labelled a successful snapshot.

## Synthetic storage comparison

These are design encodings applied in memory to output from the existing mapper,
not an implemented importer, a live tenant sample or a performance guarantee.
The bounded fixture uses native-looking order/line IDs, no customer data, one
currency, four lines per order, a 50-row page size and the existing ten-page cap.
The 2,000-order case represents four retained import batches, not an expanded
request limit. Deltas include one 659-byte latest-read descriptor.

| Encoding | 500 orders / 2,000 lines | 2,000 orders / 8,000 lines |
|---|---:|---:|
| Current snapshot | 598,079 B | 2,379,579 B |
| Decimal strings + shared checked currency/exception metadata | 759,238 B | 3,022,238 B |
| Added bytes | **161,159 B (26.95%)** | **642,659 B (27.01%)** |
| Decimal strings + explicit per-field currencies | +258,159 B | +1,030,659 B |
| Duplicate full amount/currency objects, rejected | +556,659 B | +2,224,659 B |

With 24-digit/six-decimal source totals, the lean encoding adds 746,659 B at the
2,000-order/8,000-line bound. Currency exceptions and richer attempt history
would add bytes; these examples are not universal upper bounds. Browser payload
and mirror impacts require final-code measurements before approving ingestion.

## Regression verification

New tests exercise the unchanged Shopify mapper with synthetic responses and
assert that its actual total-difference/current-tax output does not create refund
authority. A provider matrix covers all eight supported providers, forged
verification flags, explicit refund statuses with unknown/zero amounts, and
foreign tenant rows. UI tests cover accurate field labels and both current and
historical client status paths. Focused checks passed 52 tests with no failures
or skips. The expanded refresh/consumer checks passed 14 tests. Final validation
passed all **1,107 Node 22.23.3 tests**, full configured syntax checks, the SaaS
safety guard and `git diff --check`, with zero test failures or skips.

The cache regression covers both prior catalogue-v1 and imported-analytics-v2
caches in FileStore and mock Supabase. It verifies unchanged source orders,
owner measurements, historical briefs/agent runs and owner acknowledgements;
exactly one primary reconciliation plus one reporting-status payload below
16 KiB; no order/financial reporting reuploads; and a fully read-only unchanged
second bootstrap. Independent review cleared the CSV/documentation findings
and found no remaining actionable source issue.

No live PostgreSQL, browser screenshot, container, remote CI or deployment check
was run or claimed. The ingestion design above remains unimplemented and needs
separate scope review.
