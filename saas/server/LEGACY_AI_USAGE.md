# Recorded legacy AI usage completeness

`FileStore.aiUsageSummary`, `SupabaseStore.aiUsageSummary`, the existing Agent Ops API, and the Fleet display share a read-only qualification contract. This does not change paid admission, provider dispatch, governance, settlement, ledger writes, or public AI-settings fields.

## Meaning of the result

Every summary identifies `scope: legacy_recorded_usage`, the workspace, and an exact UTC calendar month `[startAt, endAt)`. Invalid inputs return an unavailable result with null scope identifiers and make no database request.

- `complete`: every selected row of the recorded ledger was returned, with exact cardinality and valid values. `totals` and `byModel` are usable recorded estimates, including a genuine zero from an empty `[]` response with `Content-Range: */0`.
- `partial`: recorded-month coverage cannot be established, including a server row cap, missing/wildcard count, the application row ceiling, or FileStore's process-memory ledger. `totals` is null and `byModel` is empty.
- `unavailable`: the read failed or the response, scope, timestamps, rows, counts, numeric values, or aggregate could not be validated. `totals` is null and `byModel` is empty. Only fixed safe reason codes are returned.

`complete` describes the rows presently recorded in this historical ledger. It does not establish complete real-world usage, capture of failed/unrecorded calls, a reconciled provider bill, or all provider spend. An empty recorded ledger therefore does not prove zero provider spend. FileStore initializes its usage array in memory on every process start, so even an empty array cannot establish a complete month and always reports partial.

Fleet sums only complete summaries for distinct workspaces sharing an exact month. Missing, thrown, malformed, partial, or unavailable workspace evidence never becomes zero. Mixed coverage withholds the aggregate; unsafe sums, duplicate workspaces, mixed month windows, and an empty snapshot are unavailable. Workspace counts describe completeness of individual summaries, not proof that an aggregate is usable. `aiUsageMonthScope: returned_workspaces` is explicit: the existing workspace catalogue uses cached/paged discovery and skips missing workspace state, so this is not proof of an all-platform population. Client search does not narrow the aggregate. Legacy amounts are not added to governed tenant/provider counters, whose scopes may overlap.

## Query and resource bounds

The existing summary performs one GET to `runvara_ai_usage`, filtered by exact workspace and a single UTC month. It selects only the row identity, workspace, occurrence timestamp, model, token components, and cost. It requests descending occurrence order, `limit=1001` (1,000 accepted rows plus a sentinel), and `Prefer: count=exact`; it uses the existing response-metadata and bounded-stream reader with a 524,288-byte ceiling. No pagination, retries, new SQL/RPC, migrations, history backfill, caching, or polling are introduced. Lower PostgREST server row limits are detected by comparing the returned range, row length, and exact total. An HTTP 200 or 206 status alone is not evidence of completeness.

Exact count **adds database work** over all rows matching that workspace/month, including matches beyond the response limit. The row/byte ceilings bound client data transfer and processing; they do not bound the number of matching rows examined by the database. The existing `runvara_ai_usage_workspace_time_idx` index is `(workspace_id, occurred_at desc)` in `20260927122500_ai_usage_economics.sql`. The intended workload is a tenant-scoped monthly range supported by that deployed index, with the existing request timeout (30 seconds by default, configurable 20–60 seconds). No production EXPLAIN, latency measurement, or index-deployment verification was performed. Very large tenant months can still make exact count expensive or time out, in which case the read remains unavailable. This is not a zero-overhead change.

Existing read frequency is unchanged: Fleet loads when its view is entered, on manual Refresh, and after the existing pause/retry/settings actions. The own-workspace Agent Ops GET performs its existing one summary read. `createAiProvider.monthlyUsage` is only a read-through helper; paid admission does not call it. No periodic Fleet timer is added. Fleet remains sequential and its catalogue behavior is unchanged.

## Value and privacy bounds

Rows must belong to the requested workspace and month, have unique bounded IDs and model names, and carry nonnegative safe integer token fields. Cached plus cache-write tokens cannot exceed input tokens. Valid PostgREST timestamp offsets and microseconds are accepted; out-of-window or malformed timestamps are rejected. Model aggregation uses a Map so special names do not collide with object properties.

The current cost column is `NUMERIC(30,8)`, widened by `20261006190318_atomic_provider_usage.sql`. This is wider than a JSON number can safely represent. This display contract accepts only finite nonnegative numeric values with at most eight decimal places and an exclusive ceiling of `2^26` USD (67,108,864) per row and aggregate. Below that ceiling, binary64 spacing remains smaller than the database's `0.00000001` USD scale, keeping distinct valid database decimals distinct. Addition uses integer units at that scale, checks safe integer bounds, and verifies the final conversion round trip. Larger valid database amounts, numeric strings, excess precision, negative zero, unsafe tokens, and overflowing totals produce unknown evidence rather than a rounded amount. The wider exact number/string governed settlement contract is unchanged.

Only qualified summary fields are exposed. Row IDs, timestamps, request IDs, prompts, credentials, arbitrary persistence metadata, and raw upstream errors are not returned by this summary. Existing tenant binding, read roles, platform-owner Fleet authorization, and public AI-settings projection remain in place. Provider configuration and static catalogue dates are labelled as configuration and catalogue metadata; neither proves provider access, metering readiness, or current pricing.

## Verification

Synthetic tests cover complete empty versus missing data, truncation and lower server caps, exact/missing/wildcard/malformed range metadata, row and streaming byte ceilings, malformed/scope-mismatched rows, unsafe numbers and sums, volatile FileStore, safe API projection, mixed Fleet availability, duplicate tenants, month rollover, roles/privacy, UI escaping and refresh transitions. The new Playwright fixture is wired into SaaS CI for 320/390/1200-pixel checks. Its local execution is not claimed: the local Chromium launch restriction is respected, with no workaround.

Official semantics checked against [PostgREST pagination and count](https://docs.postgrest.org/en/stable/references/api/pagination_count.html), including server-shortened ranges and the database cost of exact count. The [Supabase changelog](https://supabase.com/changelog.md) was checked for relevant current changes. All verification uses synthetic local data; there were no live database/provider requests or production changes.
