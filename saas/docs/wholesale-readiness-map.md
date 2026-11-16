# Wholesale coverage and next evidence gate

Assessment starts at `a0e284a1f2cca88ef5d2c68916bc484edec54c6c` on draft PR110.
This packet changes documentation only. It adds no pallet schema, helper,
workflow, integration or activation. No current provider/supplier contract in
the inspected code supports authenticating pallet suitability. The existing
`pallet_or_service_contract_unavailable` gate therefore remains closed.

## What the current tests establish

All entries below describe local synthetic/fixture coverage. None establishes
supplier availability, approved prices, paid cash settlement, a current suitable
service, production readiness or permission to quote/book.

| Stage | Existing coverage and reused boundary | Still blocked or unproved |
| --- | --- | --- |
| Existing Shopify order | [Order review tests](../server/tests/wholesale-order-review.test.mjs): exact tenant/order/revision/source binding; PAID, unfulfilled and uncancelled subset; foreign markers and stale/missing evidence refused. Reuses retained source validation/inspection. | Authentication/current authority of a future caller; actual collected cash and fresh provider state. A retained PAID status is not verified receipts. |
| 500/1000/mixed/2000+ | [Economics tests](../server/tests/wholesale-economics.test.mjs): 32%/30% exact boundaries; stricter 32% mixed review; 2000+ quotation required. Actual received revenue includes customer shipping after discounts. | Approved wholesale figures, verified fees/current VAT and approved mixed pricing policy. All workbook prices remain HOLD. |
| Unknown costs and price rejection | [Economics](../server/tests/wholesale-economics.test.mjs) and [order review](../server/tests/wholesale-order-review.test.mjs): missing/placeholder-zero costs, missing VAT, HOLD/rejected price approval and unrelated approved actions cannot pass. | Real source verification and a bound price-approval record. Caller assertions are not authentication or a booking decision. |
| Existing families/variants | [Consignment tests](../server/tests/wholesale-consignment-review.test.mjs): fixture line/SKU/pack matching; unknown mapping and BP3 refused. No product creation or retail-price mutation. | Actual mapping for BP1–BP5, EP1–EP5 and the five existing grey mailer sizes; SKU-to-pack quantities; BP3 size discrepancy. Fixture family labels do not establish real catalogue mapping. |
| Supplier packing/stock | [Consignment tests](../server/tests/wholesale-consignment-review.test.mjs): packed readiness, preparation amount/reference, stock coverage/expiry; repeated SKU lines refused to prevent double-counting stock. | Authenticated, current Europlast packing, cost and stock evidence; stock allocation/aggregation/reservation semantics. Synthetic source references prove no real fact. |
| Collection | [Consignment tests](../server/tests/wholesale-consignment-review.test.mjs): Europlast Blackburn and direct courier collection required; customer collection refused. | Actual collection postcode, access/loading facts, packed-ready time and supplier handover. No collection is booked. |
| Parcel measurements/service | [Parcel foundation tests](../server/tests/parcel2go-live-foundations.test.mjs) and [consignment tests](../server/tests/wholesale-consignment-review.test.mjs): measured fixture versus estimate, postcodes, limits, tail-lift/residential access, insurance and timing. | Actual suitable service and current entitlement; authenticated measurements and provider limits. Internal numerical bounds are not carrier limits. |
| Pallet suitability | [Consignment tests](../server/tests/wholesale-consignment-review.test.mjs): pallet/unknown mode and parcel-versus-pallet mismatch blocked. | No pallet acceptance/parser/adapter or real pallet evidence. No pallet size, weight threshold, service code or suitability rule has been guessed. |
| Failed/expired quotes | [Consignment tests](../server/tests/wholesale-consignment-review.test.mjs): failed/unknown/expired quote, incomplete all-in charges, allocation mismatch, timing/limits failure and clock rollback refused. Complete fixtures still cannot recommend a service. | Actual provider response/validity, complete surcharges and enforceable service terms. No advertised starting price or fixture is an approved quote. |
| Repeated events/durable idempotency | [Order review](../server/tests/wholesale-order-review.test.mjs): pure repeat review, duplicate retained identities refused. Existing [recovery store tests](../server/tests/shopify-order-recovery-store.test.mjs) exercise importer claims, CAS, exact acknowledgements and uncertain-write lookup using fake transports. | No wholesale webhook consumer, booking claim or stock reservation. Importer idempotency is not tested shipping idempotency and cannot be claimed as such. |
| Approval before action | [Approval request/store tests](../server/tests/approval-request-store.test.mjs) exercise existing identity/CAS/uncertain-outcome rules using a fake backend. Existing exact Parcel2Go approval is one quote only and forbids booking. | Wholesale booking-specific approval, rejection/expiry/revision semantics and immutable exact-action binding. Price rejection tests do not test booking approval rejection. |
| Tracking/fulfilment/notification | Existing quote foundations explicitly implement none of these operations. Wholesale result flags always deny booking/live readiness. | Provider references/tracking events, verified shipment identity, durable fulfilment and customer notification remain unimplemented and untested end to end. |
| Confidentiality | [Consignment tests](../server/tests/wholesale-consignment-review.test.mjs): exact result shape excludes costs, contribution, raw errors and order/customer payloads. No customer projection is mounted. | Privacy review and evidence minimisation for any future real adapter/customer output. Internal economics projections must not be reused as customer DTOs. |

## Smallest useful real evidence packet

Before another implementation packet invents interfaces, obtain one internally
reviewable example using the existing source/evidence workflow, with credentials
and customer identifiers excluded from review artefacts. This is an evidence
dependency list, not an instruction to contact a supplier, make a provider
request, create configuration or spend during this coding task.

1. **One existing paid Shopify order and its actual variant/pack mapping.** Keep
   tenant, internal/external order identity, source reference, retained revision
   and update time bound together. Resolve the selected variant's pack quantity;
   do not create a duplicate product or infer a pack from its title. BP3 remains
   excluded until its size is reconciled. Include separately qualified actual
   receipts and approved wholesale price evidence; currentTotal is insufficient.
2. **One source-authenticated Europlast Blackburn consignment confirmation.** It
   must identify the same order/lines, confirmed stock quantities and their
   observation/validity, preparation/packing costs and tax basis, packed-ready
   time, actual collection postcode and direct-courier handover/access. Record
   how multiple lines sharing stock are allocated. Missing values stay unknown;
   zero must have evidence rather than a workbook placeholder.
3. **Measured packed shipment facts in the provider's documented units.** For a
   pallet, establish the measured loaded footprint/height, gross packed weight,
   count and any further facts required by the actual service documentation.
   Identify whether quoted limits apply per handling unit or to the consignment.
   Obtain loading/tail-lift/residential/access requirements at both ends. Do not
   assume a standard pallet size, a parcel-to-pallet threshold or stackability.
4. **An authoritative service contract and one exact retained quote example.**
   Establish actual parcel/pallet eligibility fields, units, limits, service
   identity, collection/delivery timing, insurance, all charges/VAT/surcharges,
   postcodes, expiry and failure semantics. A starting price or an offline fixture
   is insufficient. Any real request remains separately approval-gated; this
   packet performs none. Current VAT status/cost recovery and approved price
   evidence must be resolved before claiming a contribution result.

The smallest subsequent coding change would be a reviewed, read-only mapping of
that documented source evidence into the existing retained-order/consignment
review, keeping unknown fields blocked. It must preserve tenant/order/revision
binding, source authenticity, expiry, cost confidentiality and existing approval
boundaries. If evidence cannot be authenticated, the review remains unavailable.
An adapter mapping would still grant no booking or recommendation authority.
Booking, durable event handling, fulfilment and notification require later
separate bounded packets; they are not silently included in evidence ingestion.

## Validation for this documentation packet

The aggregate command covers all three wholesale suites plus the reused canonical,
parcel-plan, Shopify source-capture, order-recovery contract/store and approval
request/store suites. They use local synthetic inputs and injected fake transports;
no real provider, supplier, hosted database or production request is made.

```sh
node --test saas/server/tests/wholesale-consignment-review.test.mjs \
  saas/server/tests/wholesale-order-review.test.mjs \
  saas/server/tests/wholesale-economics.test.mjs \
  saas/server/tests/parcel2go-live-foundations.test.mjs \
  saas/server/tests/parcel2go-live-canonical.test.mjs \
  saas/server/tests/shopify-source-capture.test.mjs \
  saas/server/tests/approval-request.test.mjs \
  saas/server/tests/approval-request-store.test.mjs \
  saas/server/tests/shopify-order-recovery-contract.test.mjs \
  saas/server/tests/shopify-order-recovery-store.test.mjs
```

Run with the repository's Node 22 runtime. No new tests mirror documentation;
existing behavioural tests are reused. Full server, browser/container and actual
PostgreSQL checks are not repeated by this documentation-only packet. CI success
and synthetic checks must not be described as live wholesale readiness.

Local aggregate result for this packet: **209 passed, zero failures/skips** on
Node 22.23.5. All 16 relative documentation links resolve; diff review and
whitespace checks pass. No new runtime behaviour or readiness permission is added.
