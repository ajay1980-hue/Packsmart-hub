# Saved cost source review

This stage lets an owner or admin attach short source identifiers to already
saved costs for one exact Shopify product variant. The same current attestation
is visible in the owner's existing objective-content review. It is a functional
review aid, not financial execution evidence.

Supplier invoices are the recommended basis for purchase costs, with actual
carrier, payment, channel and advertising records for the relevant other costs.
The application does not fetch or verify those documents. Do not enter invoice
bodies, personal information, credentials, URLs or payment details. Identifiers
are bounded plain text; no files or external links are fetched or embedded.

## Contract and limits

- The server binds the authenticated workspace, current owner/admin session,
  exact product and variant GIDs, exact unique retained SKU, and the one
  unambiguous saved Shopify account. Account metadata is retained context, not
  proof that Shopify authenticated this catalogue observation. No additional
  OAuth grant or credential access is needed.
- A source review records the saved cost values, source identifiers, source kind,
  optional currency, recorded tax basis and optional effective dates. Unknown
  values stay unknown. Explicit numeric zero remains valid. No default currency,
  margin threshold, forecast or tax treatment is invented.
- The source revision is an opaque comparison assertion. The server recomputes
  it from current values; a client cannot supply authority. Recording sources
  and editing numerical costs are separate operations. Source-only recording
  preserves both the saved amounts and their existing update timestamp.
- Any relevant saved cost or target change makes an existing annotation stale.
  Ordinary cost saves and imports do not rebind it. Corrections append a new
  source event and retain the preceding full review. The chain is validated,
  but this remains mutable application storage, not an immutable audit receipt.
- Exact request replay returns the retained result without another write. A
  lost response is uncertain until that exact request is found. A later refusal
  does not prove an earlier request failed. Competing writes retain the existing
  primary-state CAS fence; no snapshot restore or retry can overwrite later work.
- A review is capped at 2 KiB of serialized JSON. All latest reviews and retained
  source correction material together are capped at 64 KiB per workspace.
  Corrections consume capacity. Reaching a cap refuses the new annotation and
  preserves all existing history; nothing is automatically deleted or truncated.
  The existing primary-state 2 MiB hard limit remains independent and may stop a
  save sooner. These limits are a small bounded foundation, not a promise that
  every catalogue can be annotated indefinitely.
- Reads scan at most 500 products, 50,000 total variants and 5,000 cost history
  rows. The owner objective review projects at most 100 variants and 16 KiB.
  Unsupported or ambiguous retained data yields an explicit unavailable result.
  Exact validated history remains readable if its current target is unavailable;
  that historical view cannot authorize a new source review.

## Privacy and transport

GET `/api/economics/source-review` is an explicit owner/admin read for one exact
product, variant and SKU. It does not save, refresh integrations or fetch a
provider. PUT `/api/economics` accepts a separate source-only request with the
same identity and a UUID request reference. Normal numerical cost editing is
unchanged. The owner's existing objective-content context includes a bounded
diagnostic sidecar, with no extra database or provider request.

Generic bootstrap/dashboard economics and cost history omit private source
metadata for every role, including owners. Ordinary economics save responses
are redacted too. Audit events contain only a review ID, SKU and the explicit
attested/no-authority classification. Errors and logs use fixed codes and
messages, not source identifiers or submitted bodies. Generic exports and
financial derivations do not include the source metadata. Source-only recording
is excluded from the daily-brief input signature, preventing annotation-only
viewing from regenerating numerical reports.

The explicit source GET uses one existing workspace read. A source PUT uses two
workspace reads and one primary save, matching the ordinary cost PUT's read
count; an exact replay performs no save. These are full workspace reads, so this
feature adds traffic when an operator opens or saves a source review. There is
no background polling, per-product bootstrap lookup, or bandwidth-saving claim.
In the synthetic Store fixture, comparable primary PATCH bodies were 5,910,
8,243 and 9,669 bytes for baseline, first annotation and first correction.
The increases were 2,333 and 1,426 bytes; reporting mirror bodies add their own
traffic. These figures exclude headers, TLS and API audit rows. They are fixture
measurements, not production traffic estimates. The same-variant correction
fixtures retained 46 or 47 reviews before the byte cap; this is not a fixed
capacity for distinct products. Each new variant also retains its current head.

Stored source history uses the existing primary workspace JSON and existing
cost-profile/cost-history JSON columns. No migration or grant is introduced.
Primary-state persistence is authoritative; reporting mirrors retain their
existing asynchronous and bounded behavior. Reading a source context does not
repair or write a mirror.

## Staged installation and rollback

`COST_SOURCE_REVIEW_CONTRACT=runvara-cost-source-reviews/v1` is a separate exact
process-start opt-in. Missing, malformed or unknown values keep producers
closed. The existing governed-record producer flag cannot enable annotations,
and this flag cannot enable unrelated writers. The closed build still reads
retained reviews and returns exact idempotent replays.

Deploy the complete compatible reader with this flag absent first. Drain all
older serving instances before any separately approved activation. Older
accepted readers preserve unknown metadata in storage but return raw economics
and cost history through generic APIs. Therefore rollback to those binaries
after a source annotation exists is a privacy regression, even if they can
still parse the data. Closing the flag on this same compatible artifact is the
supported producer pause; it does not erase records or cancel work already
admitted. Actual installation, activation and live verification are separate
from these local tests.

## Financial authority remains unresolved

The selected minimum-margin rule applies to every affected sellable variant
within each affected product. An average cannot conceal a failing sibling.
Unknown sellability or an incomplete variant set remains a hold. The actual
objective margin and all stock, spending and profit-first restrictions still
apply. Existing v1/v2 proposal bytes and their
`no_financial_execution_evidence` qualification are unchanged.

An attested invoice reference does not establish net sale context, cost
allocation, effective validity, stock-cover demand evidence, complete current
spending or future incremental contribution. No sales uplift is assumed. Missing
or unreliable facts and unbounded downside continue to block execution. Positive
financial admission requires a separately reviewed source/policy contract,
explicit objective limits and compatible versioned readers; this stage cannot
remove those blockers.

## Verification

The candidate requires pure validation and scope tests, real API/session/CSRF
and concurrency tests, actual disposable PostgreSQL JSONB roundtrips, old-reader
privacy behavior, full regression checks, and responsive browser review. Local
or CI success does not prove installed production storage or authorize live
activation. Exact final evidence and measured storage/transport deltas accompany
the frozen candidate rather than relying on a previous commit's results.

Legacy-reader tests require the exact public predecessor
`601deebcc5c3fb86cd81bee85121368ff2643f05`, whose tree is
`846d356fe85f1689b8361fbb46ddf09f997dbc33`. A source-only archive does not include
Git history; obtain that pinned predecessor through the normal repository
workflow before reproducing the compatibility tests. The local database tests
exercise actual PostgreSQL JSONB casts and production Store mapping through
synthetic HTTP transport. They do not claim hosted PostgREST or installed-schema
verification.
