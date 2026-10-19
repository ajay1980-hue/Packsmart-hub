# Observational Meta campaign review

`GET /api/marketing/campaigns/:campaignId/review/meta` lets an authenticated owner
or admin inspect an existing campaign against the current retained workspace
snapshot. Members/viewers are denied. Lookup stays within the session workspace;
query overrides are rejected. Quiet startup refuses the route before storage.

The route shares the planner's active-product, availability, stock, cost, price,
exact source-cost margin and image checks. It matches the saved product and variant
IDs, refusing missing or ambiguous targets without a SKU fallback.
The identity check requires the raw product `id` and raw variant `id` (or
`externalId` when `id` is absent); a projected SKU is never an accepted ID.
This is a current retained-data check, not an attestation of historical provenance.
It highlights changed SKU/title/variant-title/image/price details, while separately reporting
current stock and thresholds. It does not rewrite the draft or normalize the
persisted workspace. Missing stock retains the existing planner rule and is
explicitly labelled unavailable; this change does not strengthen that rule.

Cost completeness means recorded amounts are present, not that invoices,
allocations, currency or tax basis are independently verified. Customer shipping
income is excluded from catalogue margin. No order-profit claim is made.

The response is an observation, not a capability or approval payload. Publication
readiness remains false. A recorded connection and even a saved approved request
do not prove a publishing destination, current OAuth write scope or executable
approval. The existing publisher is unimplemented. New creative submission still
requires the unavailable trusted allowance issuer. This route does not read
credentials, refresh tokens, probe providers, create approvals, append audit
events, reserve usage, submit creatives or publish anything. Existing mutation
authorization and audit behavior is unchanged.

This is a local preparation step. It has no live/provider acceptance evidence.
Before an implementation of publication, the next code review must define one
exact Meta destination and operation, the OAuth and target binding, exact approval
contents, durable admission and audit/receipt handling, and uncertain-response
reconciliation. Any deployment, access change or real post needs the separately
reviewed approval. Do not enable publishing by changing this DTO's flags.
