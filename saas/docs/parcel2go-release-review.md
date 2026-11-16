# Parcel2Go local release review

The initial review covered six local commits after PR110 head `4fd62f67d04c6519f11663516f3664fd47e33893`, through `d6edd2789f32b983de8d5870ef6712647079f9fc`. The subsequent local integration adds the explicit production mount identified by that review and updates the retained browser check to exercise it. Everything remains disabled by default. No real account, credential, provider request or production record was used, and no live environment was changed.

## Reviewed scope

| Commit | Reviewed behaviour | Assessment |
| --- | --- | --- |
| `b95a91a` | Native HTTPS orchestration acceptance | Exercises the actual token/quote builder and parser with intercepted IO. Its native-source markers are code-path markers, not real-provider evidence. |
| `0455530` | Exact approved input → durable native admission | Signed owner/session, canonical summary, receipt/account/terms binding and primary CAS remain on the execution path. A quote attempt records the approval/decision identity. |
| `15a4d46` | Recorded preparation and bounded owner review | Recorded claims remain distinct from independent verification. The recorded mode still cannot dispatch a quote. |
| `d7963a2` | Authoritative source-reader interface | Always refuses absent source contracts; the later owner-input mode bypasses this unused prerequisite. It must not become a release requirement for a one-off owner-declared comparison. |
| `e57fa98` | Owner declaration → review → approval → execution | Whole-package estimates and reported measurements are accepted without invented verification. Saved input and exact approval bind the wire request; unknown outcomes do not authorise retries. |
| `d6edd27` | UI and Node adapter | Separate approval/transmission confirmations, bounded body/response handling, private assets, truthful comparisons and reload without replay were exercised. The new mount composes this existing adapter without changing its admission contract. |

The review traced the main server's startup policy, signed session endpoint, workspace-lock creation, static routing, request tracking and drain/close paths. It also checked that provider credentials remain server-side, generic decisions cannot execute protected approvals, quote outcomes do not alter product/order/wholesale prices, and the source reader is not called by the owner-declared flow. Existing packing/pricing holds are not resolved by a quote comparison.

## Real local browser evidence

Run the retained check with Node 22 and the repository's locked development dependencies installed:

```sh
node saas/server/tests/parcel2go-owner-quote-browser-check.mjs /tmp/parcel2go-owner-browser
```

The script uses system Chromium at `/usr/bin/chromium`, Playwright, a real local Node HTTP listener and the actual `createPacksmartServer` routes, session endpoint, workspace lock and drain lifecycle. There is no test-only route overlay. An HTTPS `.example.test` browser origin is intercepted and proxied only to the active loopback port. Other browser origins and server sockets are blocked, native provider HTTPS is intercepted, and Supabase/identity/credentials are synthetic. The script passes a private synthetic activation config; it does not read application environment configuration. It writes only screenshots and a JSON report to the chosen local directory.

Both successful comparison and lost quote-response scenarios passed in Chromium 155.0.8059.79. Each sent three browser POSTs (prepare, decide, execute), then exactly one intercepted token request and one intercepted quote request. The actual session endpoint supplied CSRF. Success saved `completed` with a projection hash; response loss retained `reserved`. No real provider requests, external browser requests or browser script errors occurred.

With activation disabled, the actual quiet server returns 503 for the candidate page without a storage read or provider request. After an attempt, reload with empty browser markers still offers no retry. Draining and restarting the server with activation disabled restores the unavailable route and leaves state unchanged. Restarting with the same active request identity still refuses replay. Screenshots show the exact summary and truthful successful/uncertain outcomes; no credentials or provider tokens appear in them.

This establishes browser/Node composition with mocked transport. It does not establish public DNS/TLS, actual issuer acceptance, provider scope/account eligibility, service availability, live quote tax semantics or production database latency.

## Implemented production integration

[`parcel2go-owner-quote-mount.mjs`](../server/lib/parcel2go-owner-quote-mount.mjs) constructs the existing surface once beside the private-entry controllers in `server.mjs`. It receives the same Supabase store and workspace lock used by the rest of the server. No candidate is recreated per HTTP request. The three exact paths are `/owner/parcel2go-quote`, `/parcel2go-exact-owner-ui.js` and `/api/owner/parcel2go-quote-review`; the adapter still requires the pinned request UUID on the page and API and owner authentication on all three. These assets are absent from the public static map and navigation. The existing session endpoint supplies CSRF.

The mount defaults to disabled. Explicit activation requires `RUNVARA_STARTUP_MODE=quiet`, `RUNVARA_QUIET_OWNER_WORKSPACE=enabled/v1` and `RUNVARA_QUIET_PARCEL2GO_OWNER_QUOTE=enabled/v1`. It reads `RUNVARA_PARCEL2GO_OWNER_QUOTE_CONFIG` once as strict JSON, limited to 8 KiB with no duplicate/unknown fields. This private config contains exactly:

| Field | Required binding |
| --- | --- |
| `requestId` | The quote request UUID, distinct from the credential-admission UUID. |
| `trustedBinding` | Exactly `workspaceId`, `connectionId`, `accountId`, `environment`; the existing owner workspace and live account/connection binding. |
| `expectedClientId` | The privately admitted client's identifier. |
| `termsReference` | The existing exact terms reference. |
| `expiresAt` | Canonical UTC expiry no more than five minutes ahead at construction. |
| `credentialAdmissionRequestId` | The retained credential-admission UUID. |
| `expectedCredentialReceiptHash` | The exact retained credential receipt hash. |
| `scope` | Exactly `one_quote_only`. |

The host reuses private `SESSION_SECRET`, `CREDENTIALS_KEY` and an exact HTTPS `APP_PUBLIC_URL` origin. Credentials remain in the existing encrypted connection; no client secret is accepted in this config or exposed to assets/browser storage. The controller derives the current revision, session fingerprint, input fingerprint and exact approval at execution. Browser input cannot configure host authority. Disabled construction ignores the private config entirely; a syntactically valid expired activation returns disabled, so a retained config cannot prevent a later safe restart. Invalid active config fails construction with a fixed diagnostic. Later environment mutation cannot enable the surface.

Routing stays inside the existing request tracker. Drain and server close synchronously close the surface; drain then waits for tracked requests and the existing shared locks. Focused tests cover concurrent preparation under that lock, shutdown while a preparation save is pending, and shutdown during the token response: no quote follows closure and the reservation remains spent.

## Remaining release and approval boundary

The implementation is local and has not been released. It needs code review and separately authorised branch publication/release, deployment and finite private activation. Check the existing private credential receipt and account/client/terms binding at release time; this review did not inspect live storage and does not claim credentials are absent or valid. An existing authenticated owner session is needed; any use of the separate maintenance-login or credential-entry paths remains subject to their own controls.

After authorised activation, an owner must prepare and approve the exact parcel/route and separately confirm the one quote attempt. A controlled real acceptance check must use privately admitted credentials and observe the existing bounded token/quote result without broadening scopes or retrying an uncertain result. The current code retains `public-api` only and strict GBP response validation. Mock success cannot prove live issuer acceptance, supported account scope or returned service/tax semantics. Booking, payment, labels and purchases are outside this flow.

There is no need to invent a supplier-measurement source, entitlement database or new fulfilment subsystem for this one-off owner-declared comparison.

## Rollback and uncertain outcomes

Set the activation flag to `disabled/v1` for the next process and drain/restart the current server; changing environment values alone does not alter the running mount. Drain closes the active surface before waiting for outstanding work. Retain the saved approval, credential receipt, quote reservation/completion and audit history. Rolling back code must not restore old workspace JSON, delete a reservation, clear retry markers, generate a fresh UUID or widen an allowance to make an attempt runnable again. It cannot recall a token/quote request already transmitted.

The active-window GET is not a post-expiry reconciliation service. A `reserved` row, lost persistence acknowledgement or missing response needs read-only reconciliation of the exact request and approval with existing primary state/audit. If no row can yet be observed after a transmitted write, absence is not proof of non-commit. A restarted host must not automatically repeat that operation. A completed projection hash confirms what was saved, not a reusable price guarantee; raw returned prices are not retained by this flow.

## Review packet

The implementation and integration can be reviewed as a local patch stack against the stated PR110 head. The focused mount tests and actual-server Chromium check supplement the existing targeted regression baseline; screenshots/report are local supporting artifacts. No internal catalogue IDs, supplier facts or real credentials are needed in this packet. A push, merge, deployment, credential action or real provider acceptance needs its own applicable authorisation. Nothing in this packet activates a live environment.
