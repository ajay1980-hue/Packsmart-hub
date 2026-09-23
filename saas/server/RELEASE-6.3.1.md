# Runvara 6.3.1 — live verification follow-up

6.3.0 live verification recovered the missing authorised Facebook Page and its
linked Instagram account. The discovery root cause was the incomplete
`/me/accounts` result, not missing consent. The token's app-verified granular
Page grant allowed a direct Page lookup using the existing user token.

This follow-up addresses issues encountered during production checks:

- Coalesce slow status requests and poll no more than once every 15 seconds;
  skip polling while an action or earlier request is in flight. Abort status
  requests on session end and discard results from an older session.
- Display a loading screen while restoring a signed-in workspace; avoid presenting
  a misleading login form during slow bootstrap reads.
- Include existing eBay OAuth connections in default onboarding platform choices.
- Keep successfully read eBay campaigns when an individual advert read fails.
  Follow campaign and advert pagination with explicit coverage bounds. Record the
  failed read stage and campaign status without credentials or raw responses.
  A provider error does not become a request to change listings or reconnect blindly.
- Mirror only changed reporting rows, caching fingerprints only after a confirmed
  upsert. Retain all historical records and retry failed mirrors on later saves.
- Retry exactly once when Postgres explicitly cancels a primary write (57014).
  Repeat the identical revision-guarded database operation, never the business
  callback or provider write. Other/ambiguous failures are not automatically retried.

No database schema, access policy, timeout, credential or production permission
change. Regression coverage: 96 server tests including incremental mirrors,
failed-mirror retry, bounded SQL retry, campaign partial failures and pagination.

Live eBay error 35077 is a provider Promoted Listings eligibility restriction
(seller level and/or recent sales activity), documented in the official
[Marketing OpenAPI specification](https://developer.ebay.com/api-docs/master/sell/marketing/openapi/3/sell_marketing_v1_oas3.json).
Show actionable eligibility guidance and pause automatic marketing retries while
retaining other reads. Manual recheck remains available after eBay review.
