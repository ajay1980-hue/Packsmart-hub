# Public asset revalidation

The existing static-file allowlist now returns a SHA-256 ETag computed from the exact bytes read for that response. A matching If-None-Match on GET or HEAD returns a bodyless 304; weak validators, lists and wildcard matching follow HTTP semantics. Invalid fields fall back to the normal response. Same-length content changes invalidate the tag. Files are still read on every request, so this reduces response body transfer, not filesystem reads or request count.

Existing cache policy, CSP, security headers, MIME types, routes and method restrictions remain in place. API responses, sessions, tenant data and OAuth callbacks remain no-store and receive no validator. No timers, database requests, provider calls or dependencies are added.

## Validation and limits

Raw loopback HTTP tests inspect actual status and body bytes. The expanded matrix includes all nine unique public assets, including `outcomes-ui.js` and `activity-ui.js`, and the `/index.html` alias. At this tested revision those nine assets total 498,277 initial body bytes; matching GET/HEAD revalidation transfers zero body bytes. This excludes headers and does not establish production bandwidth savings, browser hit rates or intermediary behavior. Tests cover malformed fields, same-length changes, missing files and tenant/API/OAuth isolation. Successful authenticated outcome/activity reads and rejected tenant overrides remain no-store with no validator.

The full incremental Node22.23.3 suite passes 1,015 tests with zero failures/skips; syntax, SaaS security guards and whitespace checks pass. Separate fresh PostgreSQL17.6 clusters pass all 25 outcome and 73 reporting cases and are stopped afterward. These are predecessor contract regressions, not a production revalidation measurement.

Reference: https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2

## Release and rollback

Keep this preparation behind predecessor release/health and fresh exact-head CI. After authorized release, verify the actual deployed commit and ordinary static GET/revalidation behavior through a permitted route. Reverting this code restores full-body static responses; there is no data or configuration migration. Current outcome/activity assets are already included in the allowlist and regression matrix. Responsive browser/container and Android checks remain exact-head CI requirements; no local browser installation or Docker workaround was attempted.


## Incremental source and integration

Source PR79 is `d9ecb818c8ec20cf074080e3a2c139c3ac4191a8`, directly above
old main `3ebc1c75370b6a8b843da3829bc1b7af59f0a867`. It was prepared in
`codex/runvara-static-after-catalogue` above tested PR78 local commit
`fb0046beba9cd5a62cdf4a31129e71ebee596ff4`. Actual PR78 merge ancestry is a
separate finalization step once the coordinating task supplies that main SHA;
any matching-tree rebase must retain the tested tree.

The sole conflict was resolved by keeping both existing outcome/activity
no-cache entries while using the source conditional-response status. All current
asset routes, MIME types, CSP/security headers and method restrictions remain.
Existing libraries, UI assets, schemas and workflows are unchanged. No PR80–81
feature is included, and no new query, retry, provider call, periodic work or
persistent metadata was introduced.

No remote publication, production request, migration, merge or deployment was
performed in this preparation. The original OS remains incomplete; the successor
blueprint is untouched. The exact application head still needs fresh CI,
predecessor health and authorized release followed by its own health/static
verification.
