# Imported-order evidence and analytical consumer cutover

`projectImportedOrderEvidence` in `server/lib/imported-order-evidence.mjs` is a
pure, bounded projection of the existing workspace snapshot. The runtime cutover
uses the same reconciled evidence through `server/lib/order-analytics.mjs` for
Command, briefs, specialists, period/channel cards, order details, exports and
customer/source diagnostics. The app, state store and source records remain the
only system. There are no provider/model calls, source mutations, migrations,
grants, new services or polling added by this cutover. Qualified outcome memory
is deliberately not an imported-order input.

The original inactive foundation was commit `e5e5a5c`; this staged local change
activates the coordinated consumer contract. It does not establish a source-
complete period, verified historical currency, cost assignment, tax basis,
collected cash, accounting revenue, gross profit or contribution profit.

## Input and scope

```js
projectImportedOrderEvidence(state, {
  workspaceId: 'the-authenticated-workspace',
  period: {
    startAt: '2026-09-01T00:00:00Z',
    endAt: '2026-10-01T00:00:00Z'
  },
  providers: ['shopify', 'ebay']
});
```

The caller supplies the authenticated workspace, explicit provider selection and
nonempty half-open UTC interval `[startAt,endAt)`. Period and recorded order
timestamps accept valid UTC ISO strings with seconds or exactly three fractional
digits. There is no local-time parse, implicit clock or future grace. The period
uses the normalized `createdAt` field; it is not a settlement/refund-event period.

`state.workspace.id` must match. All present `workspaceId`, `workspace_id`,
`tenantId`, `tenant_id`, `workspace` and `tenant` markers on the root, workspace,
orders, inspected lines, economics container, referenced cost records and order
override metadata must be valid and local. Contradictory nested marker aliases
also fail. Legacy unmarked records inherit only the explicitly scoped workspace
snapshot, never another record's identity. Foreign/malformed orders and line
scope are excluded; foreign costs cannot even establish numeric coverage.

Only `state.orders` is projected. Other connectors' summaries in
`state.channelData` are not silently treated as this normalized order contract.
Selecting a provider with no retained records proves no business zero or source
coverage. All supported provider IDs are explicit; a missing provider never
defaults to Shopify.

Order identity is `(workspace, provider, externalId)`, falling back to recorded
`id` only if the `externalId` property is absent. An explicitly malformed external
ID does not activate the fallback. Nonempty bounded string IDs are required.
Identical normalized duplicates collapse once. Conflicting copies are all
excluded, including disagreement about dates outside the requested period,
cancellation, financial status, currency, amounts, overrides or lines. Identity
reconciliation precedes those filters. A foreign same-identity row taints the
local copy rather than allowing the favourable copy through. Different
providers remain separate; customer, name and SKU never deduplicate orders.

Duplicate equality compares only normalized fields consumed by the projection,
including canonical decimal values and line evidence. Line order is immaterial;
customer/raw payload fields are neither read nor returned. An unscanned line
tail can never establish duplicate equality or tenant qualification.

## Output and interpretation

The result uses schema `imported-order-evidence/v1`. It returns counts, fixed
limits, explicit completeness flags, a provenance description, financial-status
cohorts, compact provider/currency/status/cancellation groups, recorded SKU
buckets and opaque source references. It does not return customers, emails,
names, raw orders, raw order IDs, raw SKUs or cost notes.

Groups preserve PAID, PARTIALLY_REFUNDED, REFUNDED, AUTHORIZED, PARTIALLY_PAID,
PENDING, EXPIRED, VOIDED, UNPAID and UNKNOWN separately. Cancellation is a second
explicit group dimension; cancelled orders are retained so their recorded
refunds and costs do not disappear. `recordedPaidOrRefunded` describes only the
first three status labels. AUTHORIZED and PARTIALLY_PAID never become collected
cash. In fact every `collectedCash` output is null because no settlement contract
exists here.

`recordedAmounts` contains each normalized field (`total`, `currentTotal`,
`refunds`, `tax`, `currentTax`, `discounts`, `shippingCharged`) and two explicitly
derived fields:

The stored `refunds` field may itself be an importer-derived total difference;
it is not provider-refund, receipt or completed-action proof. The stored `tax`
field may repeat `currentTax`; it does not establish original tax. These fields
remain inspectable with explicit ambiguous-basis provenance and labels.

- `netTotal`: recorded `currentTotal`, or `total - refunds` only when
  `currentTotal` is absent/null and both inputs are known. An invalid explicit
  `currentTotal` cannot trigger a fallback. No clamping or status-based refund
  fabrication occurs.
- `netTotalExCurrentTax`: `netTotal - currentTax`, requiring both values. The
  ambiguous `tax` field is not substituted for current tax after a refund.

Each metric has `knownCount`, `unknownCount`, `knownSubtotal`,
`completeCohortTotal` and `complete`. All amounts are canonical decimal strings
or null. A known zero stays `"0"`; signed values are preserved. Unknown inputs
never contribute zero. With no known values, the subtotal is null. Missing or
invalid currency retains numeric known/unknown counts but withholds monetary
sums. No workspace currency or FX conversion is used.

Currency validation checks only three ASCII letters and normalizes their case.
Every present code, including an arbitrary code such as `ZZZ`, is labeled
`currencyStatus: 'unverified_recorded_code'` on both order and SKU groups.
Missing/malformed codes are labeled `missing_or_malformed`. Neither a recognized
currency registry nor the original source monetary currency has been verified.
Recorded-code subtotals and cohort completeness do not establish currency
recognition, financial support or financial qualification. There is no invented
currency allowlist; even a familiar `GBP` code carries the same provenance limit.

`completeCohortTotal` refers only to that exact retained group of records with
the explicitly recorded provider, currency, status and cancellation flag. It
requires every retained group member's metric to be known, the bounded scan and
output to be complete, and order eligibility to be resolved. It is never the
provider's complete period total, accounting revenue or business total. A known
currency group does not absorb records in the unknown-currency group.

`knownSubtotal` remains an explicitly partial scanned-subset diagnostic when
another record is unknown, ambiguous or omitted. It must not be promoted to a
period total or used as a replacement denominator. No single cross-currency
money total is returned.

### Numeric costs versus financial qualification

`costNumbers` checks existing SKU-keyed economics, integer nonnegative recorded
quantities and order-level cost overrides. Landed cost can use the existing
recorded/unit/box-price fields, but division must be exact at supported precision.
Missing supplier delivery, VAT rate or VAT recovery treatment stays incomplete.
Invalid explicit order overrides are incomplete, not a fallback to SKU costs.
Known zero overrides are valid. All required cost components include advertising.

This is numeric availability in the current records, not a verified historical
cost assignment. It exposes:

- Cost-complete and incomplete order counts and an order-count fraction.
- The normalized net subtotal of that numeric-cost subset, never labeled profit.
- An exact value-weighted `netTotalCoverage` fraction with decimal-string
  numerator/denominator. This is available only if every group's net amount is
  known and nonnegative, the denominator is positive and the projection is
  complete. Mixed signs, negative/zero denominator, unknown values, unknown
  currency or truncation return null.

The regression with GBP100 costed and GBP900 uncosted returns count coverage
1/2 and value coverage 100/1000. It does not report the old GBP70/70% profit
subset as a period outcome.

The present source schema has no trusted historical cost currency, tax treatment,
effective interval or provider/variant assignment contract. Therefore
`financialQualification.qualifiedOrders` is zero and gross profit, contribution
profit, margin and collected cash remain null even when all numeric cost fields
are present. Ad hoc `verified`, `currency` or `costBasis` fields cannot enable
qualification. There is no legacy currency backfill. Channel advertising is
never read or subtracted again.

### SKU buckets and references

SKU buckets are keyed by provider, recorded currency, status, cancellation and
an opaque recorded-SKU hash. They expose recorded line quantities/net amounts,
with `attribution: 'unverified_recorded_sku_only'` and
`refundsAllocated: false`. They do not allocate order refunds to lines or join
sales to catalogue variants, including duplicate SKUs across channels. Even a
unique string match cannot verify eBay's historical SKU provenance.

Signed, fractional and zero quantities are preserved exactly as recorded values,
not interpreted as sold units, verified returns or inventory movement. Numeric
cost availability requires an integer nonnegative quantity; a known zero can
satisfy that numeric requirement but cannot establish profit or cash. Negative
and fractional quantities cannot establish numeric cost coverage. No quantity
rewrites recorded order amounts or allocates order-level refunds to a SKU.

Order references contain a snapshot array pointer, provider, source-ID field and
SHA-256 of `[workspaceId, provider, sourceOrderId]`. Cost references point to
`/economics`, with SHA-256 of `[workspaceId, provider, 'economics-key', sku]`.
Recorded SKU hashes use `[workspaceId, provider, 'recorded-sku', sku]`. These are
references, not authorization tokens or a new source of financial authority.
The caller resolves them only inside the already authenticated snapshot.

## Completeness and bounded work

Fixed limits cannot be widened by caller options:

| Work/output | Maximum |
| --- | ---: |
| Order records inspected | 2,000 |
| Total line records inspected | 8,000 |
| Lines per order | 100 |
| Distinct referenced cost keys inspected | 2,000 |
| Financial groups returned | 64 |
| Recorded SKU groups returned | 80 |
| Opaque references returned | 100 |
| Identifier length | 256 characters |
| Decimal input precision | 24 significant integer digits, 6 fractional places |

The implementation never enumerates the whole economics dictionary, catalogue,
sync history or customer data. It examines only referenced cost keys and bounded
line/order fields. Any unscanned line tail withholds the entire order, including
its subtotal, because its tenant markers cannot be checked. Caller arrays are
not sorted or mutated. Duplicate comparison and outputs are bounded.

`scanComplete` describes the retained collection and referenced nested scans.
`outputComplete` describes all group/reference caps. `eligibilityResolved`
captures invalid identities/dates/scopes and conflicting orders.
`retainedCohortComplete` requires all three. Any truncation suppresses all
complete-cohort metric claims and value-weighted coverage. Empty observed
collection differs from unavailable/malformed collection, but neither produces
a business-zero assertion.

`sourcePeriod` and each selected provider's `sourcePeriods[].status` are always
`unverified`. Current data has no trusted persisted window/exhaustion contract;
the helper does not invent one or accept a caller-supplied `verified` flag.

Arithmetic uses scaled BigInt, not floating addition or coercive Number parsing.
Supported decimal strings and finite safe-range JavaScript numeric spellings
are read exactly at up to six decimal places. Exponent notation, blanks,
booleans, unsafe numbers and unsupported precision are unknown. Numeric source
values already passed through ingestion, so their original provider precision
cannot be recovered or certified. Sums may exceed an input's digit bound and
remain exact strings. Consumers must not coerce those strings back into unsafe
floating values to aggregate them.

## Why existing source metadata cannot qualify the period

- Shopify mapping (`integrations.mjs`, `mapOrder`) can default missing amounts to
  zero and currency to GBP, computes refunds from gross/current totals, and
  discards lower-level monetary currencies. These are normalized fields, not
  refund transactions or settled cash evidence.
- eBay mapping (`mapEbayOrder`) can assume unknown refunds are zero while deriving
  current totals, fabricate missing dates, default currency and replace a missing
  SKU with `legacyItemId`. Partial refund arrays can lose unknown elements.
- Shopify fetches a recent 90-day creation window, capped at 500 orders; eBay
  reads at most 600 orders. Pagination limits are checked, but precise successful
  coverage/exhaustion proofs are not persisted with the order collection. Later
  refunds to older retained orders can remain unseen.
- `mergeProviderRecords` intentionally retains older orders. Provider-wide
  `lastSyncAt`/`lastSuccessfulSyncAt` can advance for products-only reads.
  Order-area success is evidence of a read, not complete coverage. The eBay bridge
  can mark `ordersAvailable` true even when orders were not selected.
- Economics records and order overrides have entry/update provenance, not a
  historical cost, currency, refund-quantity or invoice-verification contract.

## Active consumer contract

The calculation version is `imported-order-analytics/v3`. Existing `today`,
`last7d`, `last30d`, channel and business-state compatibility fields remain in
place, with unsupported revenue, gross profit, contribution, margin, refund-money
and financial profit-coverage scalars set to null. No missing coverage becomes
0%. `numericCostCoverage` is a separate count fraction explicitly limited to
numeric availability; provider/currency/status/cancellation groups retain exact
net-value coverage ratios where the helper permits them.

Periods are explicit UTC intervals ending exclusively at the supplied clock.
Today starts at UTC midnight; at exactly midnight it is an explicitly empty
interval with no monetary zero and no fabricated source observation. Missing or
malformed order collections have unknown counts. A recorded empty array is
separate and still cannot establish a business zero. Fulfilment is a normalized
recorded status; unknown statuses cannot become known open orders. Only recorded
`PARTIALLY_REFUNDED` or `REFUNDED` status supports refund review counts, across
every provider. A positive ambiguous refund field or a historical boolean cannot
establish that cue. A recorded status still does not verify refund money,
receipts or completed external actions. The compatibility names
`hasRecordedRefund` and `refundedOrders` now describe this status-only review cue.

The internal `inspectImportedOrderEvidence` returns bounded reconciled source
rows to authorized server consumers. Public evidence never exposes those raw
rows. Fulfilment status now participates in duplicate equality because open-order
consumers inspect it. Identity reconciliation still precedes date/status filters.

- Operations inspects at most four fixed windows (today, 7, 30 and 90 days), never
  one full scan per chart point. Channel cards reference the 30-day evidence.
  The former scalar revenue series now has `periodRef: 'last30d'`, no monetary
  points and null comparisons. The UI displays exact cohort tables instead.
  Bootstrap reuses its computed operations snapshot for business state,
  integration cards, onboarding and a newly generated brief. Specialists reuse
  their Command snapshot for connection lookups.
- Main period evidence is capped at 16 monetary groups and 12 recorded SKU
  groups. It excludes opaque references and the repeated full provenance text.
  Briefs, business state and finance data are capped at six groups with net and
  refund metrics. Every presentation cap has returned/available/truncated
  indicators; clipping suppresses complete-cohort totals and value ratios.
  Known subtotals remain partial diagnostics. Narrative findings lead with
  scanned/available counts, conflicts and unresolved/partial eligibility so
  model context cannot lose the caveat by omitting structured data.
- The raw editor DTO is a scoped, bounded view of up to 100 reconciled orders
  from the 90-day creation window. `orderDetailCoverage` discloses partial
  scans/omitted rows. Text fields are bounded to 256 characters; numeric inputs
  preserve bounded primitive spellings; unsupported values have unknown analytical metrics; at most 100 validated lines are
  returned. Customer/raw payload objects never pass through allowed field
  names. Bootstrap `orders` is now this same editor subset, rather than an
  unchecked raw dump. Original persisted historical orders remain untouched.
  Per-order profit, margin, variable-cost total and collected cash are null;
  per-order recorded amount evidence carries the same qualification limits.
- The cost-update endpoint keeps its route and authorized cost input contract,
  returns the bounded editor DTO, and fails with `ORDER_IDENTITY_UNQUALIFIED`
  (409) when local IDs or provider/source identities are duplicated, excluded,
  out of the supported historical window, outside bounded inspected evidence,
  or have invalid override scope. It does not migrate identity or persistence.
- Bare SKU matching no longer populates catalogue `units30d`, `revenue30d` or
  stock-cover metrics. Those fields are null and labeled
  `unverified_recorded_sku_only`. Marketing selects from existing catalogue
  economics/stock guardrails and explicitly withholds historical sales evidence.
  No product receives duplicated sales through a shared SKU.
- Customer repeat/retention and basket diagnostics preserve useful recorded
  counts, with provider-scoped opaque customer keys and SKU associations.
  Customer revenue, contribution, AOV and every LTV field remain null. Extra
  customer/source metadata conflicts are reconciled before consumer use.
  Attribution needs provider plus an unambiguous local ID for recorded touches;
  a source label never establishes attributed financial sales. The unchanged
  touch writer's providerless records remain unjoined. Customer, attribution
  order and source-group details are capped at 100 each in returned projections only (persisted source fields, customer records and owner notes are unchanged), with full bounded
  aggregate counts and explicit partial-detail metadata; touches per returned
  order are capped at 16. Parent tenant markers survive engine normalization.
- Advertising totals, attributed revenue and ROAS are unavailable without a
  qualified currency/attribution contract. Raw recorded cost entries remain
  visible. Channel advertising is never subtracted from order costs a second
  time. All external execution, approval, CSRF, tenant and cost-ledger controls
  retain their previous behavior.
- Daily brief input signatures include the new calculation version. Existing
  brief/run history is preserved. New agent runs carry the version; current
  team cards identify earlier analyses as historical instead of recycling old
  profit findings. Activity history is explicitly labeled when it predates this
  calculation contract. Model input remains summary-only, with existing text
  limits and a 65,536-byte request ceiling; no raw or detailed order DTO is sent.
- Missing/malformed order collections make connection validation fail with an
  explicit orders problem and null count. Connection Centre also reports the
  count as unknown. First-sync validation applies order failures only when orders
  were selected, preserving products-only success and its unknown order diagnostic.
  eBay's retained-order health count uses Connection Centre counts rather than
  the capped editor-detail subset. This hardening does not infer source coverage.

## Accounting export compatibility

`GET /api/reports/accounting.csv` retains the original 22 column names/order.
The sixteen old financial amount columns are blank (unavailable), with
`profit_basis=unqualified_normalized_order_evidence` and a reason. Appended
columns carry source identity hash, cancellation, recorded currency/status,
explicit UTC creation period, scan/output/eligibility qualification, numeric
cost availability, all nine normalized recorded amount spellings and known/
unknown counts. The default historical creation window is
`[1970-01-01T00:00:00.000Z, now)`; it is not a settlement/refund-event window.

This is a deliberate semantic deprecation of the old monetary columns. Importers
must use the new recorded columns only as unverified per-order evidence, never
as a qualified accounting period. Conflicts and foreign/malformed rows are
excluded by the shared inspector. If no eligible rows remain while collection,
scan or identity completeness is unresolved, the route fails explicitly with
`ORDER_EVIDENCE_INCOMPLETE` (409), rather than creating a misleading header-only
success. A valid empty retained cohort does not establish zero business activity.
CSV formula escaping is preserved.

## Payload budgets and measurements

Fixed presentation limits above are independent of caller inputs and are tested
alongside the underlying 2,000-order/8,000-line scan limits. There is no invented
whole-bootstrap byte guarantee: unrelated existing catalogue/history collections
remain outside this change. Imported period evidence has a tested 65 KB budget,
briefs 65,536 bytes, and bounded customer/attribution projections 180 KB each on
the 2,000-customer fixture. The model request retains its absolute 65,536-byte
rejection gate and existing admission/token accounting.

`node saas/server/tests/imported-order-payload-check.mjs [local-checkout-root]`
starts only a synthetic local tenant/server and measures identical fixture shapes.
Comparison against the inactive foundation `e5e5a5c`, using local Node 24.19.0:

| Synthetic shape | Baseline bootstrap | Cutover bootstrap | Baseline business state | Cutover business state | Cutover brief | Cutover Command |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 500 orders, 100 variants, 2 providers (Packsmart-sized fixture, not production data) | 1,588,930 B | 1,221,788 B | 86,679 B | 94,022 B | 27,321 B | 35,589 B |
| 2,000 orders, 2,000 variants, 8 providers and many recorded currency/status groups | 7,132,543 B | 3,576,998 B | 87,209 B | 98,444 B | 41,428 B | 52,015 B |

One local Node v24.19.0 timing pass on those same fixture shapes (milliseconds;
not production/Render latency, not a percentile or service-level promise):

| Synthetic shape | Four-window operations projection | Business state reusing operations | Brief reusing operations | Revenue snapshot | Command build | Local bootstrap HTTP/build/serialization |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 500 orders / 100 variants | 137.40 | 0.81 | 0.34 | 206.08 | 86.78 | 492.57 |
| 2,000 orders / 2,000 variants | 325.49 | 0.13 | 0.19 | 553.45 | 330.85 | 1,766.36 |

Order details use the already reconciled row map/list and a bounded group lookup;
CSV performs one bounded history inspection before serializing rows. Neither
reprojects per order. Customer and source identity joins use maps over at most
2,000 inspected orders and 2,000 touches, not cross-order quadratic joins. Basket
pair enumeration is confined to each order's at-most-100 validated lines under
the shared 8,000-line ceiling (at most 396,000 candidate pairs in the maximal
100-line shape); pairs never join separate orders or providers by bare SKU.
There is no recurring benchmark or new background work.

The separate 2,000-distinct-customer review fixture dropped its revenue snapshot
from 3.34 MB to approximately 183 KB after detail caps, retaining 2,000-record
aggregate counts. Byte counts can vary slightly with generated IDs/timestamps.
The test exercises bounded summary-only model input and rejects oversized control-
character expansion before dispatch. No live model request was made.

## Remaining source and owner evidence

Qualification needs an ingestion contract that preserves original monetary
strings/currencies, explicit missing values, source order/line identities, actual
settlements/refunds and source observation times. A trusted sync result must bind
the tenant/provider/source account, exact requested period, filters, successful
pages/exhaustion, line/refund coverage and observation/freshness. It must address
updates to older orders, not only creation-window coverage.

The owner needs to establish the reporting basis (sales versus collected cash,
timezone and cancellation treatment), historical cost currency/tax treatment
and effective invoices, unambiguous provider/variant cost assignments,
refund/return quantities and their cost treatment, and advertising allocation
reconciliation. An order-cost editor timestamp or fresh product sync cannot
substitute for these facts. No approval or backfill is inferred here.

## Verification

The isolated worktree started at `bbaa54352e93b40da9ec4f922aa0abfcc9b77ee8`;
the inactive helper foundation `e5e5a5c` passed 600 server tests. Its 31 focused
projection regressions remain intact. Cutover regressions exercise Command,
briefs, specialists, business state, exact UI cohorts, channel references,
CSV and authorized cost responses, strict UTC/midnight behavior, null collections,
customer/source conflicts, provider/SKU ambiguity, missing unequal-value costs,
refund/status/cancellation filters, presentation caps, primitive-only private-data
boundaries, stale calculation caches and preserved history.

Independent reviews reproduced and closed the rejected-raw-order bypass,
malformed-row crash, missing partial-scan narrative, empty-incomplete export,
refund follow-up mismatch, primitive-field payload leak, UI filter/unknown-count
mismatches and oversized customer/source detail outputs. The final coercion audit
found no newly null imported monetary scalar becoming a zero-profit score or
expected-profit assertion in growth/opportunity/portfolio/execution consumers.
Qualified outcomes and objective preparation/execution policy remain unchanged.

The existing SaaS CI workflow now includes
`tests/imported-order-evidence-browser-check.mjs`. It boots a synthetic tenant
and checks Command/Analytics at 320, 390 and 1200 pixels, exact mixed-currency and
missing-cost evidence, unavailable financial claims, navigation without new
requests, contained tables/panels and screenshot artifacts. Existing browser gates
are preserved. Local Chromium is unavailable, so that new real-browser gate has
not been run locally; CI must run it before release. No browser installation,
Docker build, production request, remote write or remote CI run is claimed here.
The original isolated source passed 636 server tests on Node v24.19.0, syntax, SaaS guards and whitespace checks; its final CSV/override-scope refinement passed 10 focused consumer/API tests. Those historical results do not establish the incremental integration below.


## Incremental integration after PR80, 2026-10-07

The local stage starts from tested PR80 `76c8bbf71ef8d0a8ff8f138c6dc5be319d15fcdc` on `codex/runvara-imported-orders-after-health`. It applies only these PR81 commits, in order:

- `f3472b650cfc2bbe36e400a8047bfe7632e5710e`
- `177e046c47b98549036bf78ce6a72ea790e31a39`
- `919d9a09dfc639c1e571b616a0263f0939941f1d`

The original source parent `c9ab79ffecf00b99c245d4cdde2e99079810a3de` is the already-present catalogue stage and is not replayed. Actual predecessor-main ancestry must be aligned after its release; the local PR80 ancestry is not presented as actual new main.

Five conflicts were reviewed explicitly. Command retains the owner-result exact currency/window boundary, unqualified legacy counters and unavailable unscoped value/time fields, while adding the imported historical-cost/currency/tax caveat. Revenue normalization retains all explicit tenant aliases and the legacy experiment qualification caveat. Syntax checks include reporting, outcomes, activity and imported-order modules. CSS keeps outcome/activity lifecycle panels and the two imported-layout refinements. The SaaS workflow retains all eight responsive gates and their screenshot paths. Automatically merged bootstrap, business-state, connection-doctor and cache tests were also reviewed.

Three additional integration regressions prove that a corrected current-head owner outcome of `-0.000001 GBP` remains separate from incomplete GBP and USD imported groups; unavailable imported profit cannot become economic zero, ranking evidence or execution authority; and real-app Command keeps both owner-result and imported-source disclosures after bootstrap refresh. The existing FileStore/Supabase cache test now freezes the prior catalogue calculation version and still verifies one primary plus one bounded reporting write, separate activity attribution, full hot-state samples, read-only reuse and preserved typed measurement/history. Existing outcome/activity stale-session, dispatch and strict-health tests remain intact.

Independent review found and closed a raw-display gap: supported spellings such as `+0`, `.5`, `-.5` and `+12.50` were shown as Unknown even though the projection/editor accepted them. The browser now preserves those spellings under the same 33-character, six-fractional-place, 24-significant-integer-digit and safe-number bounds. A real-app regression failed before the fix and checks order quantity/net plus advertising spend/attribution, exact large decimals, explicit zero, invalid/exponent/unsafe inputs, unavailable financial KPIs and GET-only rendering.

Fresh validation passed **1,103 Node22.23.3 tests**, **25 outcome PostgreSQL17.6 cases**, and **73 reporting PostgreSQL17.6 cases**, with zero failures or skips, plus syntax, SaaS security/tenant guards and whitespace. Both disposable PostgreSQL clusters stopped afterward. Applied SQL names `20261007100823_business_outcome_publication.sql` and `20261007074031_reporting_status_cas.sql`, and their content hashes, are unchanged. No new migration, schema permission, dependency or recurring work is added.

The current Node22 synthetic payload pass measured 1,235,108 bytes of bootstrap, 13,351 bytes of period evidence and 27,322 bytes of brief for 500 orders/100 variants; the 2,000-order/2,000-variant fixture measured 3,590,316, 40,120 and 41,428 bytes respectively. These generated fixture measurements are not production observations or whole-bootstrap budgets. Prior Node24 timing/comparison tables remain historical; the current run did not establish a baseline savings percentage.

Independent integration review found no remaining blocker after the decimal-display fix; its focused Node22 UI rerun passed all nine tests. Release still requires actual predecessor-main ancestry, predecessor deployment health, fresh exact-head CI (including the real Chromium, Android, container and required database gates), authorized release and fresh postdeployment health. Local Chromium remains unavailable and no install or Docker workaround was attempted. No remote write or production action occurred here; this stage does not establish original OS completion or successor blueprint completion.
