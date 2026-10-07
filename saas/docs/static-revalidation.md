# Public asset revalidation

The existing static-file allowlist now returns a SHA-256 ETag computed from the exact bytes read for that response. A matching If-None-Match on GET or HEAD returns a bodyless 304; weak validators, lists and wildcard matching follow HTTP semantics. Invalid fields fall back to the normal response. Same-length content changes invalidate the tag. Files are still read on every request, so this reduces response body transfer, not filesystem reads or request count.

Existing cache policy, CSP, security headers, MIME types, routes and method restrictions remain in place. API responses, sessions, tenant data and OAuth callbacks remain no-store and receive no validator. No timers, database requests, provider calls or dependencies are added.

## Validation and limits

Raw loopback HTTP tests inspect real status and body bytes rather than a client cache. Seven unique public assets at this revision total 445,752 initial body bytes; matching revalidation transfers zero body bytes. This excludes headers and does not establish production bandwidth savings, browser hit rates or intermediary behavior. Tests also cover malformed fields, same-length changes, missing files and tenant/API/OAuth isolation. The full local suite passes 565 tests, plus syntax and SaaS guards.

Reference: https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2

## Release and rollback

Keep this draft behind the existing production functional-health gate. After authorized release, verify the actual deployed commit and ordinary static GET/revalidation behavior through a permitted route. Reverting this code restores full-body static responses; there is no data or configuration migration. Other pending UI assets inherit the same allowlisted-file behavior after integration and require exact-head CI.
