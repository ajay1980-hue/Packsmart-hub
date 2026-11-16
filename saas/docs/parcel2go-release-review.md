# Parcel2Go local release review

This review covers the six local commits after PR110 head `4fd62f67d04c6519f11663516f3664fd47e33893`, through `d6edd2789f32b983de8d5870ef6712647079f9fc`. It is a focused second pass over the existing implementation, not a separate implementation or production activation. No production-code defect was reproduced in this pass. No real account, credential, provider request or production record was used.

## Reviewed scope

| Commit | Reviewed behaviour | Assessment |
| --- | --- | --- |
| `b95a91a` | Native HTTPS orchestration acceptance | Exercises the actual token/quote builder and parser with intercepted IO. Its native-source markers are code-path markers, not real-provider evidence. |
| `0455530` | Exact approved input → durable native admission | Signed owner/session, canonical summary, receipt/account/terms binding and primary CAS remain on the execution path. A quote attempt records the approval/decision identity. |
| `15a4d46` | Recorded preparation and bounded owner review | Recorded claims remain distinct from independent verification. The recorded mode still cannot dispatch a quote. |
| `d7963a2` | Authoritative source-reader interface | Always refuses absent source contracts; the later owner-input mode bypasses this unused prerequisite. It must not become a release requirement for a one-off owner-declared comparison. |
| `e57fa98` | Owner declaration → review → approval → execution | Whole-package estimates and reported measurements are accepted without invented verification. Saved input and exact approval bind the wire request; unknown outcomes do not authorise retries. |
| `d6edd27` | UI and Node adapter | Default-disabled and unmounted. Separate approval/transmission confirmations, bounded body/response handling, private assets, truthful comparisons and reload without replay were exercised. |

The review traced the main server's startup policy, signed session endpoint, workspace-lock creation, static routing, request tracking and drain/close paths. It also checked that provider credentials remain server-side, generic decisions cannot execute protected approvals, quote outcomes do not alter product/order/wholesale prices, and the source reader is not called by the owner-declared flow. Existing packing/pricing holds are not resolved by a quote comparison.

## Real local browser evidence

Run the retained check with Node 22 and the repository's locked development dependencies installed:

```sh
node saas/server/tests/parcel2go-owner-quote-browser-check.mjs /tmp/parcel2go-owner-browser
```

The script uses system Chromium at `/usr/bin/chromium`, Playwright, a real local Node HTTP listener and the actual `createPacksmartServer` session endpoint. A test-only route overlay mounts the existing adapter. An HTTPS `.example.test` browser origin is intercepted and proxied only to that one loopback port. Other browser origins and server sockets are blocked, native provider HTTPS is intercepted, and Supabase/identity/credentials are synthetic. The script does not read application environment configuration. It writes only screenshots and a JSON report to the chosen local directory.

Both successful comparison and lost quote-response scenarios passed in Chromium 155.0.8059.79. Each sent three browser POSTs (prepare, decide, execute), then exactly one intercepted token request and one intercepted quote request. The actual session endpoint supplied CSRF. Success saved `completed` with a projection hash; response loss retained `reserved`. No real provider requests, external browser requests or browser script errors occurred.

Before the test overlay is enabled, the original quiet server returns 503 for the candidate page without a storage read or provider request. After an attempt, reload with empty browser markers still offers no retry. Closing and removing the overlay restores the original unavailable route and leaves state unchanged. Recreating the adapter with the same request identity still refuses replay. Screenshots show the exact summary and truthful successful/uncertain outcomes; no credentials or provider tokens appear in them.

This establishes browser/Node composition with mocked transport. It does not establish public DNS/TLS, actual issuer acceptance, provider scope/account eligibility, service availability, live quote tax semantics or production database latency.

## Actual release wiring still absent

No new route, environment switch, automatic credential lookup or deployment was added. The following are concrete integration points, not additional evidence gates:

1. **Host construction:** `server.mjs` constructs the current private-entry controllers beside `withWorkspaceLock`. A reviewed mount must construct the quote surface once for the chosen finite request window using that same lock, existing store and private session/credential configuration. Do not construct a fresh candidate per HTTP request or derive authority from browser-supplied settings.
2. **Private configuration:** provide the existing `store`, `sessionSecret`, exact HTTPS `origin`, `withWorkspaceLock`, request UUID and canonical expiry no more than five minutes ahead. Admission needs the retained credential-admission request/hash, exact workspace/connection/account/client binding, terms reference, encryption key and synchronous current-window guard. Credentials remain in the existing encrypted connection; they do not belong in page assets, browser storage, source code or PR notes. The controller derives the current revision, session fingerprint, input fingerprint and exact approval at execution.
3. **Routing and quiet policy:** the main server currently has no page/script/API registration for this surface. Explicitly dispatch only the pinned page, script and review API through the authenticated adapter. Keep the main request/drain tracking and quiet-mode restrictions; do not solve mounting by opening normal startup, adding a public static page or allowing arbitrary paths. The existing `/api/auth/session` response is already compatible with the UI.
4. **Shutdown:** call the surface's `close()` synchronously when draining starts and on server close, then wait for tracked request work and the existing workspace locks. The browser harness tracks its overlay separately; that overlay is test plumbing, not a production mount patch.
5. **Acceptance:** after code review, integration and specifically authorised release/activation, an owner must prepare and approve the exact parcel/route and separately confirm the one quote attempt. A controlled real acceptance check must use privately admitted credentials and observe the existing bounded token/quote result without broadening scopes or retrying an uncertain result. The current code intentionally retains `public-api` only and strict GBP response validation.

There is no need to invent a supplier-measurement source, entitlement database or new fulfilment subsystem to mount this one-off comparison. Existing private credential admission/configuration must be checked at release time; this review did not inspect live storage and does not claim that credentials are absent or valid.

## Rollback and uncertain outcomes

Close the active surface first, remove/disable its reviewed mount and drain outstanding request work. Retain the saved approval, credential receipt, quote reservation/completion and audit history. Rolling back code must not restore old workspace JSON, delete a reservation, clear retry markers, generate a fresh UUID or widen an allowance to make an attempt runnable again. It cannot recall a token/quote request already transmitted.

The active-window GET is not a post-expiry reconciliation service. A `reserved` row, lost persistence acknowledgement or missing response needs read-only reconciliation of the exact request and approval with existing primary state/audit. If no row can yet be observed after a transmitted write, absence is not proof of non-commit. A restarted host must not automatically repeat that operation. A completed projection hash confirms what was saved, not a reusable price guarantee; raw returned prices are not retained by this flow.

## Review packet

The six-commit implementation can be reviewed as a local patch stack against the stated PR110 head. This pass adds only this review note, the reproducible browser check and its link in the acceptance checkpoint. The existing targeted tests remain the regression baseline; browser screenshots/report are local supporting artifacts. A push, merge, deployment, credential action or real provider acceptance needs its own applicable authorisation. Nothing in this packet activates a live path.
