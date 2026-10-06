# Firecrawl scan safety stop

## Behavior change

Live Firecrawl scraping is paused in code. The previous path could submit a chargeable `POST /v2/scrape` with only a configured API key, without a durable per-target request identity or atomic request/credit budget. The module now contains no live scrape transport and no allowance issuer, bypass flag, alternate paid adapter, or operator-brief reservation workaround.

An owner clicking Scan, enabling a setting, supplying an API key, or passing allowance-shaped JSON cannot authorize dispatch. Eligible targets return `WEB_SCAN_ALLOWANCE_REQUIRED` before any HTTP request. The manual API responds with HTTP 409 and a clear dependency message. Disabled scanning and an empty watchlist return explicit no-work results rather than a successful-scan claim.

This is a preventive application behavior change. No production crawl or charge incident is asserted. It does not rotate/remove credentials, change a provider account, activate a provider, purchase credits, add a schedule, or create a polling loop.

## Existing records remain usable

Target creation, activation/deactivation, settings, and saved findings remain available under their existing authentication and tenant scope. Blocked requests leave every stored snapshot, finding, scan, success timestamp, and previous scan status unchanged. They do not append a fake completed scan, refresh the last-success time, replace known prices with an empty set, or trim old history. A local audit event records the blocked request separately.

The UI distinguishes a configured account from permission to scan. It no longer labels the presence of a key as ready for live scanning or displays a completed-scan message when no scan ran.

## Pure receipt validation

`parseFirecrawlObservation` is a pure structural parser for synthetic or already-obtained data. It neither performs a scan nor updates state, timestamps, or billing. A parsed object is not authority to publish an observation.

The parser requires a successful HTTP status, an explicit successful envelope, an object data payload, and bounded nonempty string markdown. It rejects malformed/empty content, unsupported source identities, unsuccessful source-page status, computed fields, and oversized content. Error messages contain only safe fixed text and codes, never raw upstream error bodies or credentials. Derived content is explicitly bounded; truncation is reported rather than implying complete-page coverage.

No live code path uses this parser to overwrite a baseline. A future transport must independently bound raw response bytes before JSON parsing and prohibit automatic redirects. Malformed receipts must retain prior evidence rather than inventing price removals or zero observations.

## Honest effects and automation status

`marketRadar` now participates in the provider-effects accounting used by the scheduler:

- Fresh blocked work has zero submission attempts, zero new spend, and no external write.
- Stored scan/snapshot history does not establish historic charges. When such history is in scope, spend remains `null` and cost status remains `unknown`.
- Missing completion evidence, exceptions, and interrupted legacy radar work are conservative rather than silently claiming free scans.
- Missing authority finishes as blocked; malformed/failing mock results are never promoted to completed success.
- Cycle and audit summaries preserve uncertainty even alongside successful read-only or creative work.

These are truthful effect reports, not a billing ledger or a claim of complete historical accounting. Unknown-spend records remain outside the current retention compaction eligibility; they must not be coerced to zero merely to make them archivable.

## Required before any future paid scan

A separate reviewed extension must provide actual per-target request/credit accounting and trusted owner/platform authority. It must bind the workspace, provider account, exact target and prepared request digest, verified finite charge/credit ceiling, and one stable logical scan intent. Reservation and durable intent publication must be atomic; retries and replica races must not create new identities or new dispatch rights. Ambiguous requests retain their exposure and must not be replayed automatically.

The current provider ledger accepts operator-brief job identities and token/cost contracts. Do not invent operator-brief keys, fake token usage, or zero prices for Firecrawl. Use a genuine request/credit contract and verified provider evidence, with bounded same-tenant source/result publication and explicit reconciliation of uncertain attempts. Bounded UI scan history is not a permanent idempotency ledger.

No live scan should be restored until that extension, its permission model, and its real concurrency/ambiguity tests pass review. Reverting to the earlier unguarded HTTP path is not a safe rollback.

## Verification

Focused tests prohibit provider/network access and cover direct/manual/scheduler bypass attempts, same-object and replica-shaped calls, tenant and explicit target scope, preserved history beyond the old 500-entry display bounds, pure malformed-response rejection, safe errors, API authorization/CSRF, truthful mixed-cycle effects, and interrupted legacy runs. Full application tests and existing syntax/safety guards remain release gates.
