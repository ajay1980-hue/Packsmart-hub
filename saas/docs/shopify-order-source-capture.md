# Bounded Shopify order source capture

Local successor to the PR81 correction at
`58572660b000954bf981e9bff20dfccb3dc97d20`. This stage changes future existing
order reads; it does not backfill retained orders or activate a sync. No schema,
table, grant, provider query, provider call family or scheduled job is added.

The subsequent [bounded updated-order window](shopify-updated-order-window.md)
replaces the created-at selector in this same call with a frozen updated-at
interval. It versions request evidence while preserving the source-money format,
historical v1 manifests, byte ceilings and retry protections described here.

## Source values and compatibility

The existing Admin GraphQL request selects `shopMoney.amount` and `currencyCode`.
For newly admitted records, `total`, `currentTotal`, `currentTax`, `discounts`,
`shippingCharged`, and line `gross`/`net` preserve the returned decimal spelling
as a string, or null if absent. The parser accepts at most 33 characters, 24
integer digits and six decimal places. Unsupported explicit values fail the
attempt; they are not rounded, zero-filled or silently omitted.

The common currency is the returned current-total currency, including null.
Every selected amount/currency pair is checked. `sourceCurrencyOverrides` holds
only exceptions, including null for missing currency, keyed by order field or
`lineItems/<index>/gross|net`. Lines inherit the containing order's read reference;
no monetary object or read reference is repeated on each line. A different or
unknown field currency suppresses that amount from its common-currency analysis
cohort. There is no workspace-currency fallback or currency conversion.

The format `shopify-order-read/v1` means `tax` and `refunds` are null. The query
does not observe original tax, tax-inclusion basis, refund records or payment
receipts. A total difference is never persisted as a provider refund. Existing
legacy fields remain inspectable under the PR81 ambiguity labels. A recorded
refund financial status supports only operational review, not an executed refund
or verified amount. Derived analysis arithmetic remains an explicitly described
calculation on retained recorded values.

The supported editor DTO, CSV and PR81 consumers already accept bounded
number/string/null values. External consumers of raw order JSON and JSONB must
accept strings for these fields after a natural refresh; this is a documented
primitive-type transition. Other providers and untouched legacy records keep
their prior encoding. The cost editor accepts only its existing owner cost
fields and ignores attempted edits to source money/currency/references. An
importer merge without a fresh source reference removes a previous reference
and its stale currency exceptions while preserving existing owner cost overrides.

## Authority and retained observations

The authoritative current application state remains `saas_workspace_state`
(or the existing FileStore). One content-addressed descriptor is stored in
`channelData.shopify.orderReads.manifests`, with one `sourceReadRef` per order.
It records the tenant, request domain, requested API version, returned version
header only when present, exact requested query, observation times,
limits, page counts/flags, cursor digests and a digest of the captured source
records. It records explicit exhaustion of every returned nested line connection.

Historical v1 requests had no fixed upper bound; v2 records both frozen request
bounds and the ascending update sort. An exhausted connection only describes
the pages visible to that request. `sourceAccountId` is null, current scopes are
`not_observed`, and `sourcePeriod` remains `unverified`. The normal order response
does not prove the shop ID, permission scope or 90-day completeness. No identity
or scope request is added. A configured connection identity used for retry
fencing is not promoted to newly observed provider identity.

The map retains at most eight descriptors and 16 KiB, preferring descriptors
referenced by retained rows. Old source rows are never discarded to make room.
An evicted reference stays on its order and resolves to `unavailable`; it never
falls back to a legacy trust claim. Invalid descriptor metadata is reported as
invalid. Explicit foreign-tenant metadata excludes the affected evidence.
Bounded consumer summaries expose counts of retained/unavailable/invalid
observations, not private domains, manifests, cursor digests or read references.

Content addressing detects descriptor changes; it is not authentication,
immutable history or evidence that every retained row still matches an old
batch. The mutable reporting mirrors and existing bounded automation history
do not supply those guarantees. Historical action/outcome qualification still
needs its separate immutable evidence contract. Current-head publication,
qualified revenue/profit, historical cost assignment and financial execution
authority remain unavailable in this stage.

## Reporting mirrors and admission

Existing `order_financials.financial_data` and `line_items` JSONB preserve exact
strings. The financial object adds source-format/common-currency/exception
semantics and the exact `total`; it does not include volatile read references
or observation times. Therefore unchanged observations do not dirty every
financial row. These tables remain best-effort reporting copies, not source
authority or an archive.

Volatile descriptors are absent from persistent mirror fingerprints. The
separate, transient duplicate-equality check deliberately treats different read
references as conflicting observations. If duplicate source identities somehow
coexist with different references, their amounts are excluded rather than
collapsing away provenance disagreement. Normal importer merges retain one row
per source identity.

`orders.total` remains a Number projection into `numeric(14,2)` and is explicitly
lossy. Its currency uses the returned total's own currency, including a checked
exception to the current-total currency. Prospective admission rejects a missing
total amount or total currency, and any candidate total whose actual numeric
projection would overflow `numeric(14,2)`, including rounding across the upper
boundary. It preserves prior rows and establishes a structural hold. It does
not clamp, invent zero, change the column, or admit a value that would make every
future mirror attempt fail. In-range three/six-decimal values remain exact in
state/JSONB while the typed column loses precision. Existing legacy mirror
fallbacks remain unchanged.

This is a conservative ingestion limitation imposed by the existing required
total/currency reporting contract. Missing optional monetary fields remain null;
they do not trigger zero-filling or require a new source request.

Before changing cached source arrays or calling save, the importer builds a
detached whole-state candidate and checks these fixed limits:

| Check | Bound |
|---|---:|
| Existing pages / orders per page / lines per order | 10 / 50 / 100 |
| Returned body per page | 2,097,152 B |
| One manifest / retained map | 4,096 B / 16,384 B |
| All retained source references and currency metadata | 262,144 B |
| Added encoding for observed rows plus positive manifest growth | 131,072 B |
| Detached whole-state candidate | strictly below 2,064,384 B |
| Reserved caller completion/audit/revision headroom | 32,768 B |
| Prospective full financial mirror body | 2,097,152 B |

The store's final hard guard remains strictly below 2,097,152 B. A candidate
passing a standalone analysis cap of 2,000 orders/8,000 lines is not necessarily
an admissible business snapshot. All other tenant state contributes to the byte
limit. The ten-page request bound permits at most 500 observed orders; nested
pagination is never expanded. Missing flags, partial GraphQL data, duplicate
identities, nonadvancing cursors, interrupted returned bodies, foreign scope,
oversize metadata or admission failures reject the whole order attempt.
Retained source rows, manual overrides and last-success evidence stay intact.

The unchanged request asks for 50 orders with `lineItems(first:100)`. The fixture
proves application call/byte bounds only. Shopify's calculated requested/actual
query cost and its single-query ceiling are not verified by a mocked ten-page
read. Shopify can assign manual field costs; no live returned cost evidence was
collected or inferred. A documented `MAX_COST_EXCEEDED` response establishes a
non-retryable `SHOPIFY_ORDER_SOURCE_QUERY_COST_LIMIT` hold. An exclusively
`THROTTLED` GraphQL error uses existing scheduled rate-limit handling, makes no
immediate second request, and does not create a structural hold. Explicit
`INTERNAL_SERVER_ERROR` responses use the existing bounded transient retry.
When every code is one of those two documented transient codes, any throttle
chooses the delayed rate-limit path. An unknown/malformed code mixed with known
transient codes is conservatively incomplete; a deterministic cost-limit code
takes precedence over transient hints.
Pre-response network failures keep the existing bounded transient retry policy;
interrupted returned source bodies are incomplete structural observations. This
stage does not resize the query, expand pagination, add calls or use bulk reads.

## Failure and retry behavior

Structural source failures create a bounded, non-retryable order-read hold tied
to tenant, provider, configured connection/account/domain, API version and fixed
parser/query policy. Token contents, token-refresh timestamps, scheduling
settings and the moving day cutoff are excluded. Ordinary token rotation cannot
clear the hold. A replaced account/configuration cannot inherit an old pending
failure; detached success promotion is also checked against the attempted
binding. Existing per-dispatch credential checks remain in force.

Automatic scheduling, legacy first-run scheduling, queued connection work and
Auto-Doctor check the hold before an order claim, save or provider request.
Products-only work preserves the order hold. A deliberate existing authenticated,
CSRF-checked owner/admin manual order retry may replace it after a fully admitted
read; an automatic caller cannot supply a reset flag. Last-success timestamps
and descriptor references are not overwritten by incomplete attempts.

The successful path uses its existing save count. A queued structural failure
may perform at most one additional existing workspace save to persist a newly
established effective hold, followed by existing reporting behavior. An already
effective identical hold is deduplicated. Tenant CAS and existing job lease
fences remain active. If persistence conflicts/fails, the result states that the
hold is not confirmed durable; it does not overwrite the newer state, retry the
provider or claim that other workers are durably paused. An uncertain job close
is likewise exposed as unconfirmed rather than reported as completion.
When a hold could not be stored, a separately queued future job cannot infer
that hold from the failed worker's memory and can read again. The failed job
itself is not retried. Universal cross-worker suppression during a storage outage
is not guaranteed by the existing mechanisms and is not claimed here.

The final admission audit identified two existing limitations for a separate
guard patch: Doctor's failure count is only charged after the read, so repeated
successful lease saves followed by failed result saves can avoid exhaustion;
the generic job claim RPC can reclaim expired connection-job leases beyond the
declared attempt maximum. This source-capture commit alone does not establish
a finite automatic retry bound under those combined failures. The approved
follow-on [admission guard](shopify-order-read-admission.md) charges the existing
Doctor budget before dispatch and enforces durable generic attempt counters in
the trusted application worker. Its specification separates admitted provider
work from owner-created fresh jobs and existing database polling.

## Original v1 local measurements

These are the source-capture v1 baseline. Current v2 measurements are recorded
in [bounded updated-order window](shopify-updated-order-window.md).

Run `node tests/shopify-source-budget-check.mjs` from `saas/server` with Node 22.
All provider and database responses are local synthetic fixtures. The fixture
uses 500 orders, four lines each, native-looking IDs, one currency and the exact
pre-cutover order layout. The new importer makes the same ten order-page reads.

| Snapshot representation | Bytes |
|---|---:|
| Pre-cutover authoritative state | 597,460 |
| First source-capture state | 659,556 |
| Added bytes | 62,096 |
| Shared manifest map | 2,288 |
| Per-order reference contribution | 44,000 |

| Existing store operation | Requests | Request-body bytes |
|---|---:|---:|
| Warm baseline save | 3 | 598,141 |
| First capture save | 4 | 1,211,238 |
| Unchanged second capture save | 3 | 662,266 |
| Cold mirror-cache save | 9 | 1,423,464 |

The first natural refresh adds one existing `order_financials` request, 551,001
body bytes, because money primitive types and stable source semantics change.
The typed `orders` rows are unchanged in this fixture. The next unchanged read
adds no order or financial mirror requests. Cold-cache behavior includes the
normal workspace, user, rule, audit, subscription, order and financial mirrors
plus primary state and reporting-status persistence. There is no history upload.
These compact JSON body counts exclude response/header/transport bytes and are
fixture observations, not live cost estimates or universal snapshot maxima.

The worker failure-path accounting is executable in
`tests/shopify-source-job.test.mjs`. Its distinct populated fixture has one
product/variant/economics/supplier/connection, retained owner costs and audit,
default rules and subscription. The larger variant retains 500 orders and
2,000 lines. Counts include a whole worker tick after setup/enqueue, including
job claim and fenced completion; provider responses are simulated locally.

| Structural failure tick | Requests | Request-body bytes |
|---|---:|---:|
| Small populated fixture, warm mirrors | 9 | 10,244 |
| Small populated fixture, cold mirrors | 19 | 16,013 |
| 500 retained orders / 2,000 lines, warm mirrors | 9 | 290,225 |
| 500 retained orders / 2,000 lines, cold mirrors | 19 | 706,607 |

The larger failure tick includes one primary GET, one 288,422-byte primary
PATCH, one 373-byte reporting-status request, two job requests totaling 412
bytes, and normal mirrors. Warm mirrors use four requests/1,018 body bytes;
cold mirrors use fourteen/417,400, including the existing variant identity
GET, a 182,285-byte orders POST and a 228,961-byte financial POST. No new
request family is introduced. The compact size-error code variant uses 27 fewer
body bytes than the shape-error variant.

Three separately queued jobs against an already persisted identical hold use
nine requests/1,245 body bytes in total: three fresh primary GETs and six
claim/completion requests. They make zero provider calls and zero primary,
reporting or mirror writes. Unchanged queued Doctor checks likewise skip the
generic completion audit/workspace save while retaining fenced job completion.

## Validation

The local Node 22.23.3 source-capture suite passes **1,186 tests**, with no failures or
skips, including existing security/tenant checks and new actual-mapper, local
authenticated API, admission, decimal/currency, stale-reference, partial-data,
deduplication, token/account race, scheduler/Doctor and worker persistence tests.
Configured syntax checks, the SaaS safety guard and `git diff --check` pass.
The budget script was run separately against the final source representation.
Independent review reproduced the main adversarial cases and cleared the final
job/lease and query-cost error-classification changes.

No live PostgreSQL or Shopify account query, browser screenshot, remote CI,
deployment or production/public application probe was run. Schema constraints
are checked against the existing DDL and local prospective-payload tests; the
synthetic database does not emulate PostgreSQL numeric rounding. The prior
correction commit is retained as the parent; combined-branch ancestry alignment
and any later publication remain separate work.

## Source references

The selected source semantics were checked against Shopify's 2026-07
[Order](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Order),
[MoneyV2](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/MoneyV2),
[MoneyBag](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/MoneyBag), and
[PageInfo](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/PageInfo)
references. Error codes and the distinction between throttling and a query-cost
ceiling follow the [Admin API reference](https://shopify.dev/docs/api/admin-graphql/2026-07)
and [GraphQL rate limits](https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits).
No production account call was used to validate this patch.
