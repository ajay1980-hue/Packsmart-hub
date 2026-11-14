# Wholesale contribution review: pure planning component

Based on main `329539e9d7fb5ae0b91b29359746ceac92e7c22c` (merged PR109).
Repository inspection found no AGENTS.md, .agents/skills, wholesale booking
implementation or wholesale checkpoint. Existing systems provide Shopify order
capture/recovery, recorded-cost economics, approval governance and disabled
Parcel2Go credential/quote foundations, including the pure live quote plan and
tenant-bound operational/exact approval rehearsals. Those existing plans validate
parcel/postcode evidence and quote permissions, not wholesale contribution.
Reuse those systems for future execution;
this packet adds only `reviewWholesaleContribution`, importing the existing exact
`contributionMeetsMargin` and required variable-cost buckets from `profit.mjs`.
Open PRs were inspected; the existing delivery theme proposal (#8) and older
governance/reporting proposals are not wholesale shipping execution.

## Contract and limits

This is an unconnected server helper, with no endpoint, UI, persistence, provider
transport, credentials, timer, approval action or product/retail price changes.
It consumes caller-supplied evidence; it cannot authenticate or approve evidence.
A future caller must bind fresh evidence to the same tenant, paid Shopify order,
existing catalogue variants, pack mapping and approval revision using existing
security/audit/idempotency systems. Do not expose verification flags as user claims
or use this result to bypass existing approval. `bookingAllowed` and `liveReady`
are always false. Repeated calls are pure calculations, not webhook handling.

`packs` lists physical 500/1000-unit packs in one consignment, not new SKUs.
500 uses 32%, 1000 uses 30%. Mixed consignments below 2000 units use the stricter
32% as a conservative review floor, not an approved mixed-pack pricing policy.
At 2000+ total units the helper returns `quotation_required` without calculating
contribution; it does not invent an approved bespoke price.

Currency must explicitly be GBP; missing or other currencies block economics.
All money is integer GBP pennies for the whole consignment, bounded to 1e12 per
field. Revenue must be verified actual received money **after all discounts,
including customer shipping**, never pre-promotion list revenue. Enter actual
payment fees covering that entire received amount; no illustrative fee percentage
or promotion rate is assumed. Discounts already reduce receipts and are not
deducted twice. All eight existing variable-cost buckets require explicit verified
amounts. `landed` must include supplier goods/inbound costs; `packing` and
`handling` include supplier preparation; `delivery` is actual all-in outbound
cost. Include applicable surcharges/insurance in those costs. Unknown costs,
including workbook zero placeholders, must remain unverified. An independently
verified free cost may be explicitly zero. No cost-source ingestion is added.

Only independently verified current `not_registered` VAT status with
`gross_non_reclaimable` treatment is supported: received revenue is gross and all
costs include non-reclaimable VAT. Registered/unknown VAT treatment blocks until
a separately reviewed tax model exists. The owner's November 6 statement does
not independently verify current status. `priceApproval` must be `approved`;
DRAFT/HOLD/manual blank/rejected prices withhold contribution. This input refers
to existing price evidence, never booking approval. No workbook formulas or real
prices were copied. Exact source-cost comparison runs before display rounding.

## Covered and deferred

Targeted tests cover 500/1000 exact boundaries, mixed 1500, 2000+ quotation,
actual post-discount receipts/customer shipping/payment fees, every missing or
unverified cost (including zero), malformed money/quantities, unknown/registered
VAT, HOLD/rejected price evidence and repeatable non-mutating review.

Pallet/parcel suitability, quote failure/expiry and unavailable stock are deferred:
this helper does not evaluate shipping or stock readiness. Likewise, it does not
test duplicate webhook handling, booking approval rejection, tracking, fulfilment
or customer notifications. Price rejection is covered; booking rejection is not.
Those execution scenarios need a later bounded integration into existing paid
orders and approval infrastructure, with durable tenant-bound claims/audit.

Live readiness remains blocked by supplier packed weights/dimensions, preparation
cost and stock; approved wholesale prices; current VAT evidence; real browser
acceptance/live credentials and an approved real quote. BP3's 180x230/180x235 size
discrepancy remains unresolved. Existing BP1–BP5, EP1–EP5 and five grey mailer
sizes must be mapped without duplicate products or changed retail prices.
Europlast Blackburn prepares packed orders for direct courier collection;
customer collection is not a workflow option.

A future comparison must verify actual suitable parcel/pallet services, all-in
costs, origin/destination postcodes, packed weights/dimensions, tail-lift,
residential access, insurance, timing and expiry. Advertised starting prices and
successful synthetic/sandbox tests do not establish live readiness. No provider
request, booking, spend, message, live Shopify change, credential change,
Render/Supabase check, merge, deploy or production change belongs to this packet.
