# Offline supplier and consignment review

See [coverage and next evidence gate](wholesale-readiness-map.md) for the combined
stage-by-stage test map, pallet hold and minimum real evidence needed next.

This packet adds one composable `createWholesaleConsignmentReview` on the existing
PR110 branch. The factory is default-disabled; its only other mode is explicitly
offline-fixture/v1. Enabled/live modes are refused. It reuses canonical JSON/hash,
the existing measured Parcel2Go quote plan, source tenant checks and the existing
order/contribution review. It adds no workflow, route, persistence, credentials,
provider transport, supplier/customer message or real account configuration.

## Evidence boundary

Inspection found that saved cost-source history explicitly consists of mutable
operator attestations, not verified invoices, supplier stock or live tax evidence.
No trusted supplier/consignment verification adapter exists. Accordingly, this
module cannot admit real evidence or mark a supplier/service verified. A trusted
local fixture harness registers a detached canonical snapshot at construction.
The returned review accepts retained order state only; it cannot receive new
supplier evidence or trust flags from a request. Later mutation of constructor
objects, unrelated state fields or `{verified:true}` cannot replace pinned facts.

This is fixture provenance only, not an authenticity guarantee about real-world
facts. Never mount the constructor on request JSON or treat its mode as business
authorization. A future genuine evidence adapter requires separate review, source
authentication and current tenant/order/revision/variant/approval binding through
existing durable admission/audit/CAS systems. No such adapter is implemented here.

Both fixture records bind exactly to the existing context's workspaceId, orderId,
revision, sourceReadRef and updatedAt. Evidence references must be synthetic.
Existing paid/unfulfilled, uniqueness, tenant, VAT, cost and price-approval checks
run first. Failed evidence returns blocker codes only: no supplier costs, quote
amounts, contribution, order/customer data or raw errors appear in the projection.
There is no customer-facing projection or publication path.

## Fixture checks

- Europlast Blackburn, packed readiness and direct courier collection are required.
  Customer collection and unknown transport mode block the review. Explicit
  supplier observation and future expiry are required; no freshness is inferred.
- Every order line must map once to a matching retained SKU/id, pack count and
  500/1000 pack size. Available pack stock must cover it. Repeated SKU lines are
  rejected pending an aggregate stock contract, so stock cannot be counted twice.
  Supported fixture family
  mappings are BP1–BP5, EP1–EP5 and grey_mailer; actual grey size mapping still needs
  authenticated catalogue/supplier evidence. BP3 and BP3-bearing SKUs remain
  blocked pending resolution of the 180x230/180x235 discrepancy.
- Supplier preparation cost requires an explicit amount and synthetic source
  reference and must fit the already-reviewed packing/handling cost allocation.
  Missing cost/stock/measurements are unknown. A zero without preparation evidence
  is blocked; explicit zero in a pinned synthetic fixture is not a free live cost.
- Parcel evidence must match the measured existing quote plan exactly, including
  origin postcode. Owner estimates do not pass. Existing plan rules validate packed
  dimensions/weight, postcodes, declared value and evidence age. No carrier limit
  or pallet threshold is invented. Pallet/unknown service contracts stay blocked.
- Parcel fixtures require successful unexpired GBP quote evidence, a complete
  all-in charge breakdown (base, VAT, fuel, collection, tail-lift, residential,
  insurance, other), matching actual shipping allocation, explicit service limits,
  tail-lift/residential support, insurance cover and collection/delivery timing.
  Failed, expired, missing or unsuitable quote evidence cannot pass. These are
  fixture facts, not a claim that current provider quotes contain those fields.

Even complete fixtures return only fixture_checked, synthetic:true,
supplierVerified:false, serviceVerified:false, quoteRecommendationAllowed:false,
bookingAllowed:false and liveReady:false. No service is selected/recommended.
Repeated reviews are pure calculations, not durable webhook idempotency. Expiry
is checked again each time; clock rollback closes the fixture reviewer.

Real supplier stock, preparation cost, measurements, approved wholesale prices,
current VAT, catalogue mapping/BP3 size, current eligible all-in services, pallet
support and browser/live acceptance remain unresolved. Booking-specific approval,
durable webhook/stock claims, tracking, fulfilment and notifications remain
deferred. Existing provider/approval/recovery semantics are unchanged. All numeric
examples, postcodes and service/account labels in tests are synthetic only.
