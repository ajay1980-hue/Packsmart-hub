# Shopify Admin catalogue read integrity

The Admin product import installs a candidate only after every requested page
passes validation. Missing connections, missing terminal metadata, missing or
duplicate identities, and unusable continuation metadata must not turn an
incomplete response into an empty or apparently complete replacement catalogue.
A valid, explicitly terminal empty catalogue remains a valid replacement.

## Contract and bounds

The existing query and request ceiling remain unchanged: at most ten product
pages, fifty products per page, and one hundred variants per product. Product
and variant connections require dense node arrays and explicit boolean
`hasNextPage` values. Variant `hasNextPage: true` retains the existing
`SHOPIFY_VARIANT_COVERAGE_LIMIT` refusal. A tenth nonterminal product page retains
`SHOPIFY_PRODUCT_COVERAGE_LIMIT` and does not trigger an eleventh request.

Product identities must be numeric Shopify Product GIDs, and variant identities
numeric ProductVariant GIDs, each no longer than 256 characters. Both identity
sets must be unique across the entire candidate, including variants appearing
under different parents. No replacement IDs are invented. Validation does not
establish that these IDs belong to the authenticated Shopify account.

Continuation requires a nonempty opaque cursor no larger than 4,096 UTF-8 bytes,
a nonempty product page, and a cursor not already used by this import. Cursor
contents are passed unchanged; they are not decoded, trimmed, or interpreted.
On terminal product pages, an absent/null cursor is accepted; a supplied cursor
must still satisfy the type and size bound. A terminal cursor need not differ
from earlier cursors because no continuation request follows it.

Inspected structures must be plain objects with own data properties for required
fields. Synthetic accessors and sparse arrays are rejected. Explicit tenant or
workspace markers must match the server-selected workspace, including markers
on inspected pagination structures; bounded nested markers are checked too.
Missing markers confer no tenant or provenance authority. Unrelated product
presentation fields are not promoted into financial evidence.

Other invalid pages produce a fixed `SHOPIFY_CATALOGUE_PAGE_INVALID` error with
status 502. Provider text, IDs, cursors, or foreign workspace values are excluded
from that error. The caller's seen-identity sets and response objects are not
modified by validation. The importer updates its private seen sets only after a
whole page passes, and installs no prefix if a later page fails.

## Preservation and request cost

The existing detached-candidate merge preserves retained catalogue records on
refusal. In a selected product-and-order sync, a malformed catalogue also prevents
the order candidate from being installed. Other concurrently requested reads may
already have occurred; validation does not cancel or refund them. Existing read
admission, usage accounting, failure bookkeeping, and bounded later repair policy
remain in force. The new error is not classified as a transient upstream error
and does not introduce an immediate retry.

Successful imports use exactly the same provider requests and GraphQL fields.
Validation adds no database, archive, authentication, or provider calls and no
persisted provenance fields. It scans only the existing bounded node sets, using
temporary identity sets. The upstream `response.json()` transport decoder is
unchanged and is not bounded by this validator; large unrelated response fields
can still consume decoding memory. These node limits are not a byte or egress
guarantee.

The repository-snapshot and public-storefront paths are unchanged. Existing
inventory and availability coercion rules are unchanged; strict price parsing
continues to preserve genuine zero and represent missing/malformed prices as
unknown. An old price regression fixture now uses valid Admin GIDs, while its
numeric/missing-ID cases remain on the unchanged snapshot/public paths.

## Verification and limits

Synthetic tests exercise real mapping/import paths, retained array identity,
multi-page failures, duplicate identities, explicit foreign scope, continuation
cycles, exact request limits, terminal empty results, mixed product/order imports,
and unaffected price, inventory, snapshot and public behavior. Pure tests cover
accessor rejection and no mutation of caller sets. No live sync is needed to
verify this contract.

This is a prerequisite integrity check, not positive financial admission. It
does not prove publication/visibility, freshness, complete sales history,
currency/cost provenance, forecast profit, or safe stock. Future objective policy
must check every affected sellable variant rather than mask losses with a product
or business average. An unknown affected-variant set, missing policy threshold,
or unqualified profit evidence must remain a hold; this change creates none of
that authority and changes no approval, stock, or budget constraint.

The shape follows Shopify's non-null connection metadata and forward pagination
contract: [ProductVariantConnection (2026-07)](https://shopify.dev/docs/api/admin-graphql/2026-07/connections/ProductVariantConnection),
[ProductConnection](https://shopify.dev/docs/api/admin-graphql/latest/connections/ProductConnection),
and [pagination guidance](https://shopify.dev/docs/api/usage/pagination-graphql).
The local identity/cursor ceilings are application safety bounds, not claimed
Shopify platform maxima. Existing retained records are not rewritten. Deploying
this code changes malformed Admin-import refusal behavior but introduces no
schema, permissions, feature activation, or additional service.
