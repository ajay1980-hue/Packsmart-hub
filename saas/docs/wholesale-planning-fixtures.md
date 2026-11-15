# Offline wholesale planning fixtures

`reviewWholesalePlanningFixture` is an unmounted, default-disabled calculation
helper. Its only active mode is `offline-fixture/v1`. It reuses canonical JSON
validation and tenant-scope checks already used by the wholesale code. It adds no
route, persistence, provider transport, product creation or live admission.

The [fixture](../server/tests/wholesale-planning-fixture.mjs) contains entirely
invented tenants, products, references, quantities, weights and hold codes. It
contains no operational catalogue mapping or owner/supplier information. Synthetic
reference prefixes prevent accidental use of ordinary references; they do not
authenticate data. Hosts must never relabel real evidence as a fixture.

Each fixture product yields two proposed pack sizes, 500 and 1000, only when those
sizes are absent from its fixture catalogue. Product references are synthetic
labels, not platform IDs. Variant IDs stay null, created stays false, prices and
inventory stay null, and price status stays HOLD. Pagination gaps, repeated product
references, retail variant fields, conflicting tenant markers and unsupported
source/verification claims reject the input without returning proposals.

Packing checks preserve the distinction between grouped components and a complete
package. Included bands cannot be added again. Outer tare belongs to the selected
quantity and cannot be scaled as part of a unit group. A whole-package fixture
must cover the selected product/quantity and outer packaging; it cannot have tare
added afterwards. Component sums and estimates never count as measured dispatch
gross, and all package dimensions remain unknown.

Fixture product holds are retained. Quantities 2000+ remain quotation-only.
Financial, tax, carrier-cost and wholesale freight-policy review remain required;
retail delivery policies are never imported into wholesale proposals.

All outputs are explicitly synthetic and deny source verification, packing
verification, quote readiness, variant creation, booking and live readiness.
`quoteEvidence` is always null. Even a structurally complete fixture cannot supply
real quote evidence. No adapter to a provider, retained order or approval payload
is supplied, and existing runtime admission/audit/idempotency is unchanged.

Run locally with Node 22:

```sh
node --test saas/server/tests/wholesale-planning.test.mjs
```
