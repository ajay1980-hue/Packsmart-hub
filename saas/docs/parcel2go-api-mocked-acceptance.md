# Parcel2Go API acceptance checkpoint

The native HTTPS orchestration now has a synthetic acceptance test from an encrypted saved credential envelope through token exchange, quote serialization and response parsing. This is local test evidence only. It does not establish provider access, account eligibility, a real quote or an operational connection. No application route or runtime switch is added.

## Exercised path

[`parcel2go-https-orchestration-acceptance.test.mjs`](../server/tests/parcel2go-https-orchestration-acceptance.test.mjs) reuses the existing synthetic admission fixture and in-memory Supabase substitute. It checks the completed credential receipt and connection hash, then passes that saved envelope to the existing `approved-https-orchestration/v1` branch.

The real orchestration, credential opener, wire builder, HTTPS candidate and bounded response parser execute. Only native `https.request` is intercepted; socket connection and uninjected `fetch` are forbidden. Responses arrive as split in-memory streams. All credentials, account data, parcel data and responses come from synthetic fixtures.

The test verifies:

- One form-encoded client-credentials token request followed by one JSON quote request to the fixed endpoints, with the expected scope, bearer placement, units and TLS options.
- Strict quote projection, exact amount arithmetic and removal of secrets, ciphertext and untrusted provider text from the outward result.
- Session, plan, tenant and transport mismatches rejected before dispatch; owner/credential changes and expiry checked after both asynchronous responses.
- Issuer rejection, malformed token data, a lost quote response, redirects, inconsistent quote totals and a token echoed in a service identifier close the attempt without retries or unsafe output.
- No quote-stage persistence; a second call on the same orchestration instance is refused. Durable live quote admission remains explicitly refused.

The native branch labels its result `live-http`, `fixture: false` and `synthetic: false`. Inside this test those are code-path markers, **not provider evidence**: every response is intercepted. Test output must never become a trusted runtime verification or quote receipt. `liveReady`, `purchaseAllowed`, `priceGuaranteed` and `deliveryGuaranteed` remain false.

## Exact remaining live acceptance boundary

[`parcel2go-live-setup.mjs`](../server/lib/parcel2go-live-setup.mjs) and [`parcel2go-live-entry-controller.mjs`](../server/lib/parcel2go-live-entry-controller.mjs), mounted by the server, provide finite private credential storage only. They do not call the token or quote transport. [`parcel2go-live-admission.mjs`](../server/lib/parcel2go-live-admission.mjs) accepts quote mode `offline-integrated/v1` and rejects `approved-https-integrated/v1`. The native orchestration is still unmounted.

The missing integration is a trusted composition joining exact owner approval and authenticated input to durable quote admission and then this native transport. It must preserve the existing tenant/session/account/receipt bindings, revision-CAS reservation and audit, fresh rereads around asynchronous work, expiry/revocation checks, completion reconciliation and no-replay handling of uncertain outcomes. The low-level orchestration alone provides no durable reservation or replay protection across fresh instances. The adjacent offline admission tests cover those mechanisms in their existing offline composition; this acceptance test does not extend that evidence to a live composition.

Only after that composition is implemented and reviewed can a separately authorized live acceptance use privately admitted credentials, verified account/client/terms/scope and currency/VAT facts, and an approved exact parcel/route. Synthetic planning input is not evidence of measured dispatch packaging. That acceptance also needs an exact finite token/quote allowance, response limits, closure and uncertain-outcome reconciliation. There is no booking, payment, label, collection or purchase allowance here.

## Targeted verification

Run with the repository's Node 22 runtime:

```sh
node --test \
  saas/server/tests/parcel2go-https-orchestration-acceptance.test.mjs \
  saas/server/tests/parcel2go-live-https-candidate.test.mjs \
  saas/server/tests/parcel2go-live-admission.test.mjs \
  saas/server/tests/parcel2go-live-foundations.test.mjs \
  saas/server/tests/parcel2go-live-sync-guard.test.mjs
```

No live credentials, provider traffic or real persistence are needed by these tests.
