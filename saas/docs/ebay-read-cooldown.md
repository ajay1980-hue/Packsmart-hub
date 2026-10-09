# eBay read cooldowns

This is a correction to the existing SaaS eBay importer and its callers. It does
not modify the separate eBay Manager application, add a provider, add a database
table or grant, change the normal five-attempt recovery budget, or authorize a
production rollout. The SaaS importer can select its existing direct OAuth or
Manager bridge branch; both preserve rate-limit evidence.

## Deadline and partial reads

An eBay HTTP 429 is recognized at response receipt, before parsing its body. A
non-JSON error body cannot erase HTTP status, authentication status, or cooldown
evidence. Numeric Retry-After is anchored once at receipt; HTTP-date is absolute.
Valid Retry-After on other error responses, including 503, is also preserved and
prevents an immediate retry. Missing/malformed non-429 fields add no new wait.
The parser accepts all three HTTP-date formats, validates their calendar values,
and preserves valid waits longer than 24 hours. On 429, missing or malformed short
fields use the existing one-minute minimum; valid past dates and zero also use that minimum.
Neither an expired normalized deadline nor saved diagnostics are reanchored when
they are read later. The ordinary Doctor backoff remains separate.

The existing `integrationStatus.ebay.retryAt` stores the latest unexpired absolute
deadline. Partial surface and campaign diagnostics preserve the same normalized
fields. Completion order, unrelated successes, omitted areas, shorter later
failures, successful authentication checks, and current endpoint wrappers cannot
shorten that deadline. Failed/unselected imported data remains retained, and
partial/deferred areas are not counted as successfully refreshed.
Settled successes within an incomplete offers batch remain uncommitted: the old
catalogue is retained. Unaffected completed areas can update normally.

Within one import, a known 429 or valid provider-requested wait stops new pages,
campaigns, offer batches and later read stages. Requests already dispatched may finish; their errors are
settled before final status so a later, longer 429 remains visible. The run-local
stop remains in effect even if its deadline expires while a sibling finishes.
The next admitted pass follows the normal schedule and attempt budget.

## Admission and persistence

Direct importer calls, monitored sync, first sync, shared run admission, Doctor,
the scheduler (including legacy first runs), and owner Sync endpoints consult the
same saved provider cooldown. An explicit Sync cannot bypass it or reset Doctor
debt first. Doctor's own retry delay additionally constrains automatic reads;
queued first imports still work when periodic syncing is disabled. A wholly
deferred read makes no provider request, claims no new run, consumes/resets no
attempt, and produces no no-op save. A multi-provider owner request may still
save legitimate work for other providers.

Existing file/Supabase workspace saves persist the fields, with the existing lock
and CAS semantics. A stale writer cannot replace a newer saved deadline. The
normal committed save is the durability boundary: receiving a provider response
and saving state are not atomic. A process loss before the result save can lose
the just-observed deadline; existing durable leases and uncertain-attempt budgets
still apply. No crash-proof provider-response capture is claimed.

## Unrepresentable evidence

Input parsing is bounded to 128 characters and at most 15 significant integer
digits. A field beyond that bound or a valid wait outside the supported
four-digit-year UTC date range is not truncated into an earlier retry. It records
only `retryReviewRequired: true`, without retaining raw headers or arbitrary
decimal strings. This means the evidence could not establish a usable deadline;
it is distinct from both a known provider retry time and the short malformed-field
fallback. Invalid nonempty persisted deadline fields also fail closed.

This marker pauses automatic and ordinary manual imports. Test, refresh,
reconnect, and first-sync bookkeeping do not release it: authentication success
does not prove throttle expiry. This slice adds no reset control or endpoint.
Explicit owner authentication tests, refreshes and reconnects retain their existing
request behavior; the guard blocks data-import attempts, not those auth requests.
Such a state requires manual investigation and a separately reviewed repair;
the UI does not promise that clicking Sync or reconnecting will resolve it.

## Display and verification

For eBay, health projects the later applicable provider/Doctor deadline. The
existing next-read display also respects cadence and includes the date for waits
crossing a day. Manual, disconnected, exhausted, restricted and access-review
states do not promise an automatic retry. Other providers retain their current
behavior. The connection card/dialog fixtures include ordinary cooldown, manual,
review-required and exhausted states at 320, 390 and 1200 pixels, plus enlarged
text. Browser execution and pixel acceptance are required in the existing CI
gate; local Chromium is unavailable in the preparation environment.

Focused tests cover parsing, invalid bodies, mixed concurrent failures, stopped
dispatch, preserved data and restrictions, save/reload and stale CAS, all existing
read-admission paths, endpoint debt protection, and truthful health/schedule copy.
They use synthetic state and injected providers. These tests establish source
behavior, not a production rate-limit incident or a deployed repair.

Sources: [HTTP Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3),
[HTTP date formats](https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.7),
[HTTP 429](https://www.rfc-editor.org/rfc/rfc6585.html#section-4),
[eBay Sell API limits](https://developer.ebay.com/develop/api/sell/api_call_limits).
The connection-wide pause is conservative application policy; it does not assert
that all eBay APIs share a single quota or that the account's limits were queried.
