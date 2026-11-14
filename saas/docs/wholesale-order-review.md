# Recorded wholesale order contribution context

This next bounded addition stays on draft PR110's existing branch after
`bc723693fccf7160478d266b4943e111bcd2c978`. `reviewWholesaleOrderContribution`
is a pure, unmounted read of one already-retained Shopify order snapshot. It
does not create a webhook handler, queue, shipping workflow, approval, quote,
booking, stock reservation, fulfilment or notification. It calls the existing
`reviewWholesaleContribution`; no price/tax/cost formulas are duplicated.

## Existing architecture inspected and reused

- `validateRetainedShopifyOrderState` rejects conflicting tenant markers,
  nested line scope and duplicate internal/external Shopify identities. This
  helper reuses it before selecting an order; even identical duplicate retained
  records are blocked rather than choosing a favourable copy.
- `inspectShopifyOrderSource` identifies source captures with retained valid
  read manifests. Legacy, invalid and missing-manifest records cannot establish
  this review context. A manifest is recorded provenance, not fresh provider
  verification, a per-order cryptographic attestation or payment proof.
- Historical `summarizeOrderInspection` counts PAID/PARTIALLY_REFUNDED/REFUNDED
  as paid order history. This helper deliberately requires exactly PAID,
  cancelledAt:null, UNFULFILLED and GBP for its narrower recorded review.
- Shopify source capture leaves actual collected cash unqualified. This helper
  never substitutes currentTotal (which includes shipping in Shopify's total)
  for verified receipts. Separate same-order economics evidence remains required.
- Order recovery already has tenant-bound reserve/append/finalize transactions,
  exact request fingerprints, durable acknowledgements, lookup after uncertain
  writes and primary revision CAS. Approval creation already has request identity,
  conflict checking, one-save/exact-read reconciliation and audit events. Generic
  approval decisions require approver/revision checks and do not automatically
  execute external actions. Parcel2Go exact approvals grant one quote only and
  explicitly forbid bookings. None of those paths is modified or bypassed here.

## Pure contract

The trusted caller supplies an existing state plus context containing workspaceId,
orderId (internal retained id), revision (state._revision), sourceReadRef,
updatedAt and economics. All snapshot/source bindings must match exactly.
Foreign markers on the context, state, order, lines, economics, receipts,
VAT treatment or individual costs block the review. Missing economics remains
unknown; the helper never fills zeros or promotes generic approved actions to
approved wholesale prices. Economics below target, blocked or quotation-required
keeps the outer review blocked. A passing result is named recorded_order_review,
not shipping-ready. bookingAllowed:false and liveReady:false always remain.

The context is a trusted-host binding assertion, not authentication, an approval
record, evidence verification or a durable idempotency key. The component reads
no credentials and writes no state or audit. Repeated calls simply return the
same projection; they do not demonstrate duplicate-webhook suppression across
processes. A future integration must authenticate/reload the same tenant, bind
current evidence to the actual paid order/variants/pack mapping and existing
approval revision, and use existing durable claim/CAS/audit paths before any
external operation. No route or external execution path is added now.

## Covered and deferred

Synthetic tests cover recorded paid/unfulfilled review; unpaid, authorised,
partially paid, refunded and unknown states; cancellation/fulfilment/currency;
foreign tenant markers at used evidence levels; duplicate internal/external
orders; repeatable non-mutating review; stale snapshot/source/order bindings;
legacy/invalid/missing provenance; missing/rejected/HOLD price approval despite
an unrelated approved action; unverified zero costs; no inferred actual cash;
and quotation-required/below-target economics.

No live order/provider/account request, message, booking, spend, credential
change, Shopify write, merge, deploy or production write was performed. Real
stock, supplier preparation/measurements/costs, current VAT, approved wholesale
figures, BP3 size resolution and browser/live acceptance remain outstanding.
Pallet/service suitability, quote cost/expiry/failure, booking-specific approval,
durable webhook admission, references/tracking, fulfilment and customer
notification remain deferred. Europlast Blackburn prepares packed orders for
direct courier collection; no customer collection is introduced.
