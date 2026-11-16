# Parcel2Go API acceptance checkpoint

The native HTTPS orchestration and an unmounted exact-owner admission candidate now have synthetic acceptance tests through token exchange, quote serialization and response parsing. This is local test evidence only. It does not establish provider access, account eligibility, a real quote or an operational connection. No application route or environment activation flag is added.

## Exercised path

[`parcel2go-https-orchestration-acceptance.test.mjs`](../server/tests/parcel2go-https-orchestration-acceptance.test.mjs) reuses the existing synthetic admission fixture and in-memory Supabase substitute. It checks the completed credential receipt and connection hash, then passes that saved envelope to the existing `approved-https-orchestration/v1` branch.

The real orchestration, credential opener, wire builder, HTTPS candidate and bounded response parser execute. Only native `https.request` is intercepted; socket connection and uninjected `fetch` are forbidden. Responses arrive as split in-memory streams. All credentials, account data, parcel data and responses come from synthetic fixtures.

The test verifies:

- One form-encoded client-credentials token request followed by one JSON quote request to the fixed endpoints, with the expected scope, bearer placement, units and TLS options.
- Strict quote projection, exact amount arithmetic and removal of secrets, ciphertext and untrusted provider text from the outward result.
- Session, plan, tenant and transport mismatches rejected before dispatch; owner/credential changes and expiry checked after both asynchronous responses.
- Issuer rejection, malformed token data, a lost quote response, redirects, inconsistent quote totals and a token echoed in a service identifier close the attempt without retries or unsafe output.
- No quote-stage persistence in the low-level orchestration; a second call on the same orchestration instance is refused. Direct native admission through the ordinary factory remains refused.

The native branch labels its result `live-http`, `fixture: false` and `synthetic: false`. Inside this test those are code-path markers, **not provider evidence**: every response is intercepted. Test output must never become a trusted runtime verification or quote receipt. `liveReady`, `purchaseAllowed`, `priceGuaranteed` and `deliveryGuaranteed` remain false.

## Exact-owner admission candidate

`createParcel2GoExactQuoteCandidate` in [`parcel2go-live-admission.mjs`](../server/lib/parcel2go-live-admission.mjs) defaults to disabled. Its explicit `unmounted-exact-https-candidate/v1` mode accepts server-pinned admission configuration, approval identity, operation hash and account-evidence reference. It does not create approval, verify entitlement or accept client-supplied authentication claims.

The candidate verifies the secure signed owner cookie, exact origin and CSRF; snapshots the submitted input; reauthenticates inside the host workspace lock; and reads the approved exact decision from the primary store. It matches the operation's input fingerprint and visible summary to the canonical wire plan, as well as account, receipt, terms, session and expiry. A matching hash alone cannot authorize a misleading summary.

Only that private composition can select native transport within the existing durable admission. It retains primary revision-CAS, one-use persistence permits, reservation/completion audit, owner and approval checks before save effects, exact rereads around asynchronous work, and the five-minute wall/monotonic deadline. The quote request must reuse the approval request identity. The reservation also records approval ID, operation hash and decision hash, preventing reuse through a changed request ID. Unknown provider or persistence outcomes remain spent, including after constructing a fresh candidate. Persisted completion contains a projection hash and quote count, not prices or secrets.

[`parcel2go-exact-native-admission.test.mjs`](../server/tests/parcel2go-exact-native-admission.test.mjs) derives a synthetic review, saves its decision in the in-memory database through the existing store, signs a synthetic owner cookie, and runs this composition with native HTTPS intercepted. It covers successful completion, pre-admission refusals, misleading summaries, concurrent workers without a shared local lock, changed approval identity, revocation/abort/expiry around both responses, and lost reservation/provider/completion acknowledgements. The existing approval rows remain decision evidence; execution is recorded in `parcel2goLiveQuoteRuns` and audit rather than changing generic approval execution fields.

## Exact remaining live acceptance boundary

The candidate is not mounted or constructed by the server. [`parcel2go-live-setup.mjs`](../server/lib/parcel2go-live-setup.mjs) and [`parcel2go-live-entry-controller.mjs`](../server/lib/parcel2go-live-entry-controller.mjs) remain private credential-storage routes only. The ordinary admission factory still rejects direct `approved-https-integrated/v1` configuration.

A reviewed production host still needs bounded HTTP parsing, the exact owner review/decision route, authoritative input/evidence preparation, finite activation and closure, and a status/reconciliation view joining the durable run receipt to the approval. The existing input producer and owner panel remain synthetic-only; neither may be relabelled as production verification. An account-evidence reference is a pin, not proof of API entitlement, currency/VAT status or terms acceptance. A supplied measurement/provenance label likewise does not establish measured dispatch packaging.

After that host is implemented and reviewed, release/activation and any real token/quote acceptance require separate authorization using privately admitted credentials and the approved exact parcel/route. Missing or uncertain results never authorize retry, a new UUID, or a larger allowance. There is no booking, payment, label, collection or purchase allowance here.

## Targeted verification

Run with the repository's Node 22 runtime:

```sh
node --test \
  saas/server/tests/parcel2go-exact-native-admission.test.mjs \
  saas/server/tests/parcel2go-https-orchestration-acceptance.test.mjs \
  saas/server/tests/parcel2go-live-https-candidate.test.mjs \
  saas/server/tests/parcel2go-live-admission.test.mjs \
  saas/server/tests/parcel2go-live-foundations.test.mjs \
  saas/server/tests/parcel2go-live-sync-guard.test.mjs \
  saas/server/tests/parcel2go-exact-input-producer.test.mjs \
  saas/server/tests/parcel2go-exact-approval.test.mjs \
  saas/server/tests/parcel2go-operational-approval.test.mjs
```

No live credentials, provider traffic or real persistence are needed by these tests.
