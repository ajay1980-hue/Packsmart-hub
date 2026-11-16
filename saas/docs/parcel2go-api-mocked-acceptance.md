# Parcel2Go API acceptance checkpoint

Recorded-evidence preparation, bounded owner review, exact-owner admission and native HTTPS orchestration now have a connected synthetic acceptance test through token exchange, quote serialization and response parsing. This is local test evidence only. It does not establish provider access, account eligibility, a real quote or an operational connection. No application route is mounted and no environment activation flag is added.

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

## Recorded evidence and bounded owner review

[`parcel2go-recorded-owner-review.mjs`](../server/lib/parcel2go-recorded-owner-review.mjs) adds a default-disabled, unmounted HTTP candidate for `/api/owner/parcel2go-quote-review?requestId=…`. GET previews or reads the exact saved review. POST accepts only preparation references or an exact decision. There is no execution action or native transport dependency. Secure signed owner cookies, current tenant/user/session checks, exact origin and CSRF, strict JSON, a 2 KiB/64-chunk body limit and a two-second whole-request deadline bound the interface. Authentication is rechecked after the asynchronous evidence read and inside the workspace lock.

The host supplies a pinned packet hash, request ID and finite deadline. Without an explicit recorded-claim reader, the review uses the fail-closed primary-state reader described below. The browser cannot supply parcel/account facts, source assertions, input replacements or permission flags. `deriveRecordedQuoteApproval` shares the canonical input, wire, credential-receipt and review-summary derivation with the existing synthetic producer. Its separate recorded-evidence schema binds account/terms/receipt references, input and packing scope to the owner workspace and request.

The packing record must describe the selected whole package with measured gross weight and external dimensions, the same plan and quantity, and outer packaging included. Component measurements, estimates, mismatched quantities/dimensions, missing outer packaging and any added tare are refused. This validates the shape and consistency of recorded claims; it does not prove their physical accuracy. The DTO explicitly says the source and API eligibility are not independently verified and keeps `sourceVerified`, `accountEntitlementVerified`, `providerCallsAllowed` and `liveReady` false. Real data must never be relabelled as a synthetic fixture.

Preparation uses the existing approval-request identity, primary CAS and audit. The packet's fixed issued/expiry times keep the operation hash stable across reads and process restarts; replay does not renew the window. Decisions use the existing exact confirmation contract and add an audit entry binding the evidence hash. Evidence and cancellation guards run before save effects and commit. Exact readback reconciles a lost acknowledgement without a second write. An unconfirmed in-process attempt cannot write again; absence of a saved row does not authorize retry after restart. A transmitted persistence request can still commit after cancellation, so an unconfirmed response is not proof that nothing was saved.

[`parcel2go-recorded-owner-review.test.mjs`](../server/tests/parcel2go-recorded-owner-review.test.mjs) exercises preview → preparation → decision → manually composed native admission entirely with invented data and intercepted HTTPS. It also covers rejected decisions, immutable windows, invalid packing claims, client evidence injection, malformed/oversized input, tenant/auth refusals, changed evidence, competing workers, uncertain writes and cancellation before save effects. This test is not a production source-verification or live-permission receipt.

## Primary-source reader and concrete missing contracts

A bounded inspection of [`store.mjs`](../server/lib/store.mjs), the [database schema](../server/supabase/schema.sql), its migrations and the existing catalogue/order/consignment readers found no protected source contract for packed-parcel observations or current carrier-account entitlement. Supplier metadata and workspace settings are general records. Catalogue/order source manifests cover their own commerce data; they do not verify dispatch gross weight, external dimensions, or carrier-account facts. The existing wholesale consignment review is explicitly fixture-only. This finding concerns the repository's source model; no production records were queried.

[`parcel2go-authoritative-evidence-reader.mjs`](../server/lib/parcel2go-authoritative-evidence-reader.mjs) provides a default-disabled, unmounted, read-only interface for the authenticated host. `inspect` uses the existing Supabase store's `exactSnapshot` read, checks tenant scope, and reports whether a unique retained credential-admission receipt links consistently to the encrypted connection and timestamps. `linked_receipt` means storage linkage only. It neither decrypts nor validates credentials, account eligibility, terms acceptance or physical measurements. It has a two-second read budget and a finite wall/monotonic window, with cancellation and no writes.

There is deliberately no success path for `readEvidence`: it returns no packet and throws `PARCEL2GO_AUTHORITATIVE_EVIDENCE_UNAVAILABLE`. The recorded owner-review candidate uses it by default and returns fixed dependency diagnostics, without creating an approval or audit entry. Arbitrary workspace keys, supplier metadata, hashes, `verified` flags and recorded packets cannot add authority. Explicit injected readers remain useful for recorded-claim reviews and synthetic tests; they do not become independently verified sources.

The missing contracts are:

- `packed_measurement_source_missing`: a protected, tenant-scoped observation with stable identity/revision, authenticated recorder and acquisition/provenance evidence, observed time, revocation status, selected packing plan and quantity, measured whole-package gross mass including tare, and measured external dimensions. Supplier nominal/component figures cannot substitute for that observation.
- `account_entitlement_source_missing`: an authoritative account/client binding and current evidence of API eligibility, intended scope/terms, currency and VAT basis, with observed/expiry times and revocation. Private credential-storage consent is not this evidence.
- `consignment_selection_source_missing`: a current, revision-bound selection tying the intended order/packing observation to the route and declared value, with documented conflict resolution and source scope.

Before implementing a successful reader, define and review those source producers, protected persistence/read contracts, provenance checks and revocation rules. Then bind their immutable revisions to the evidence packet and revalidate them at execution. Adding self-declared JSON fields to the current workspace does not satisfy this dependency. No new source table, import, verifier, supplier measurement or provider request is fabricated by this checkpoint.

## Exact remaining live acceptance boundary

The candidate is not mounted or constructed by the server. [`parcel2go-live-setup.mjs`](../server/lib/parcel2go-live-setup.mjs) and [`parcel2go-live-entry-controller.mjs`](../server/lib/parcel2go-live-entry-controller.mjs) remain private credential-storage routes only. The ordinary admission factory still rejects direct `approved-https-integrated/v1` configuration.

A reviewed production host still needs an authoritative read-only evidence adapter and independent source/entitlement checks, UI and server mounting of the reviewed candidates, finite activation/closure, an execution dispatcher that revalidates evidence, and outcome reconciliation after the review window closes. The new review candidate refuses after expiry; its active-window GET is not a post-expiry reconciliation service. The original synthetic producer and owner panel remain synthetic-only. The new recorded-evidence contract is also not an independent verifier: an evidence reference/hash does not prove API entitlement, currency/VAT status, terms acceptance or measured dispatch packaging.

After that host is implemented and reviewed, release/activation and any real token/quote acceptance require separate authorization using privately admitted credentials and the approved exact parcel/route. Missing or uncertain results never authorize retry, a new UUID, or a larger allowance. There is no booking, payment, label, collection or purchase allowance here.

## Targeted verification

Run with the repository's Node 22 runtime:

```sh
node --test \
  saas/server/tests/parcel2go-authoritative-evidence-reader.test.mjs \
  saas/server/tests/parcel2go-recorded-owner-review.test.mjs \
  saas/server/tests/parcel2go-exact-native-admission.test.mjs \
  saas/server/tests/parcel2go-https-orchestration-acceptance.test.mjs \
  saas/server/tests/parcel2go-live-https-candidate.test.mjs \
  saas/server/tests/parcel2go-live-admission.test.mjs \
  saas/server/tests/parcel2go-live-foundations.test.mjs \
  saas/server/tests/parcel2go-live-sync-guard.test.mjs \
  saas/server/tests/parcel2go-exact-input-producer.test.mjs \
  saas/server/tests/parcel2go-exact-approval.test.mjs \
  saas/server/tests/parcel2go-operational-approval.test.mjs \
  saas/server/tests/parcel2go-live-entry-disabled.test.mjs \
  saas/server/tests/parcel2go-live-entry-production.test.mjs \
  saas/server/tests/parcel2go-live-setup.test.mjs \
  saas/server/tests/parcel2go-exact-owner-panel.test.mjs \
  saas/server/tests/parcel2go-exact-owner-http.test.mjs
```

No live credentials, provider traffic or real persistence are needed by these tests.
