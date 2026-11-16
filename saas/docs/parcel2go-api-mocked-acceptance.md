# Parcel2Go API acceptance checkpoint

Owner-entered parcel input now connects through the owner UI, an unmounted Node adapter, bounded HTTP preparation, saved exact owner review, durable admission and native HTTPS orchestration to token exchange, quote serialization and response parsing. Recorded-evidence review remains available separately in the same controller. All acceptance evidence here uses synthetic inputs and intercepted transport. It does not establish provider access, account eligibility, a real quote or an operational connection. No application route is mounted and no environment activation flag is added.

## One-off quotes do not require an authoritative packing registry

The earlier checkpoint over-constrained a one-off owner-approved comparison by making an independently verified packing/account source a universal prerequisite. The provider's [v1 quick start](https://www.parcel2go.com/api/docs/articles/quickstart.html) and [client-credentials introduction](https://www.parcel2go.com/api/docs/articles/intro.html) document bearer-token quote requests with addresses and parcel weight, dimensions and value. Order creation and payment are separate operations. The documented quote input has no warehouse observation or entitlement-registry reference. This is a contract reading, not evidence that a particular account will be accepted.

The repository already supports `owner_authorised_estimate` inputs. A truthful owner declaration can therefore supply a complete parcel for a comparison. Private credential admission, account/client binding, terms reference, exact owner consent and actual provider acceptance still matter. A new database claiming to verify carrier entitlement is not necessary for this bounded quote attempt. The source-reader dependencies below apply to independently verified records and future fulfilment assurance; they must not be presented as blockers for an explicitly owner-entered comparison.

## Connected owner-input candidate

`createParcel2GoRecordedOwnerReview` in [`parcel2go-recorded-owner-review.mjs`](../server/lib/parcel2go-recorded-owner-review.mjs) now also supports the explicit, unmounted `unmounted-owner-input-quote/v1` mode. It reuses the same authenticated HTTP boundary, approval creation, decision CAS and exact native admission. Default construction stays disabled. Recorded mode keeps its existing source-reader requirements and cannot execute a quote.

In owner-input mode the host pins the existing credential receipt, account/connection/client binding, terms, request UUID and finite deadline. GET initially returns `input_required`. POST `prepare` accepts only the declaration shown below. POST `decide` uses the existing exact revision/operation-hash confirmation. POST `execute` requires a second exact confirmation with approval ID, operation hash, the same request UUID and `confirmed: true`; it uses the saved input, never replacement input from that request. Approval alone does not dispatch anything.

```json
{
  "action": "prepare",
  "requestId": "<host-issued UUID>",
  "declaration": {
    "currency": "GBP",
    "collectionVatStatus": "NotRegistered",
    "deliveryVatStatus": "Individual",
    "collectionPostcode": "SW1A 1AA",
    "deliveryPostcode": "M1 1AE",
    "acknowledgedUnverified": true,
    "parcel": {
      "basis": "estimate",
      "scope": "whole_package",
      "includesOuter": true,
      "weightGrams": "5000",
      "lengthMm": "450",
      "widthMm": "300",
      "heightMm": "250",
      "declaredValueDecimal": "15.15"
    }
  }
}
```

These are synthetic example values, not recommended parcel measurements or tax status. `basis` is `estimate` or `measured`: the latter means owner-reported measurement, not independent verification. Both require a complete package including outer packaging. Components, extra tare additions, missing dimensions, unsupported currency and unknown VAT values are refused; no carton dimensions or weights are inferred. Account choices use `evidenceSource: owner_declaration` and `declaredAt`, never a fabricated `verifiedAt`. The review labels the server receipt time as declaration time, not the time a physical measurement was taken.

The canonical input is saved inside the approval payload and covered by its content hash and plan fingerprint. Reloads reconstruct the same review and retain its original expiry; edited inputs cannot reuse the approval. The summary clearly marks estimates, owner-reported measurements and VAT choices as owner declarations. `sourceVerified` and `accountEntitlementVerified` remain false. Output is a comparison, not dispatch verification, a guaranteed price or booking authority; it does not set wholesale prices or free-freight rules.

Preparation/decision/authentication/body reading retain the two-second deadline and 2 KiB limit. Only a valid execute envelope extends the request budget to twelve seconds measured from request start, still clipped by the original five-minute window and session expiry. Native token and quote requests retain their own five-second caps. The existing workspace lock is held once, and native admission independently performs fresh primary reads, one-use CAS reservation, exact approval checks and hash-only completion/audit. Unknown outcomes remain spent; provider rejection does not broaden scope or retry. The controller also remembers an uncertain reservation attempt when no receipt can yet be read. After a process restart, absence of a row cannot prove that a transmitted write will not commit: the host must reconcile that uncertainty, not automatically construct another attempt.

[`parcel2go-owner-input-quote.test.mjs`](../server/tests/parcel2go-owner-input-quote.test.mjs) exercises HTTP input → saved review → decision → execute → parsed quote using both bases. It forbids real sockets/fetch, intercepts native HTTPS, and uses the existing fake Supabase and synthetic encrypted credential fixture. It verifies the exact wire body, redaction, no ancillary state changes, reload/replay bounds, unsupported inputs, tenant/auth failures, pending/rejected/tampered approvals, competing executors, revocation, cancellation, time budgets and uncertain reservation/provider/completion outcomes. Tests do not count as live evidence.

## Disabled UI and Node server integration

[`parcel2go-owner-quote-surface.mjs`](../server/lib/parcel2go-owner-quote-surface.mjs) is a thin Node request/response adapter around that same controller. Default construction returns unavailable without reading configuration or assets. Its explicit `unmounted-owner-quote-surface/v1` mode takes the same private host configuration as the owner-input controller. It serves only the pinned request's `/owner/parcel2go-quote?requestId=…`, the existing `/parcel2go-exact-owner-ui.js` component, and the pinned review API path. Page and script requests also pass the controller's secure-cookie owner checks. The origin comes from the host, never request Host/forwarded headers.

The paused request-stream bridge is lazy, so authentication can reject without reading the body. The existing controller retains JSON/body/deadline limits. Disconnect and host closure propagate cancellation, remove stream listeners and prevent later execution. Page/script responses use no-store, no-referrer and restrictive CSP. Neither these assets nor the adapter are registered in `server.mjs`; the existing authenticated `/api/auth/session` endpoint is the only existing app endpoint used by the UI for CSRF.

The new `RunvaraExactOwnerUI.createOwnerInput` factory extends [`parcel2go-exact-owner-ui.js`](../parcel2go-exact-owner-ui.js). It is disabled by default; the [unmounted page shell](../parcel2go-owner-quote.html) selects the explicit candidate mode only at the fixed page path with a host-issued UUID. The original synthetic panel keeps its own contract. The owner flow has blank inputs and explicit choices for currency, VAT and estimate/reported measurement. Local format/unit validation allows corrections before preparation. It renders the server's exact summary as text, requires a review checkbox to approve, then requires a separate transmission checkbox before requesting one comparison. Approval never automatically executes.

The component uses same-origin, no-store requests with CSRF, aborts on expiry/pagehide, and ignores late responses. One-use session-storage markers contain only request/action IDs and `attempted`, not parcel values, credentials or prices. Storage failure prevents submission. Unknown responses do not unlock retry. Reloads read the saved review; the controller now marks any matching durable quote attempt (or remembered uncertain execution) as `reconcile_no_replay`. Returned comparisons show GBP total/net/VAT with explicit owner-declaration and non-guarantee notices and no purchase controls. No result updates catalogue prices, wholesale holds or free-freight rules.

[`parcel2go-owner-quote-surface.test.mjs`](../server/tests/parcel2go-owner-quote-surface.test.mjs) and [`parcel2go-owner-input-ui.test.mjs`](../server/tests/parcel2go-owner-input-ui.test.mjs) execute the page/component in JSDOM with in-process Node request/response streams, the existing fake Supabase and intercepted native HTTPS. This covers the full UI → adapter → exact decision → reservation → token/quote → displayed comparison path, plus disabled mounting, private assets, auth/tenant/CSRF failures, body cancellation, XSS-safe rendering, exact response validation, storage uncertainty, deadline suppression and reload without replay. There are no listening sockets or provider requests in these tests. This is DOM integration evidence, not a production-browser or live-provider acceptance result.

The [focused release review](parcel2go-release-review.md) also records a real local Chromium run against the existing Node session endpoint and a test-only adapter mount. Both successful and lost-response paths passed with intercepted provider transport, including rollback, retained history and reload without replay. Production routing remains unchanged.

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

The `unmounted-recorded-review/v1` mode of [`parcel2go-recorded-owner-review.mjs`](../server/lib/parcel2go-recorded-owner-review.mjs) uses `/api/owner/parcel2go-quote-review?requestId=…`. GET previews or reads the exact saved review. POST accepts only preparation references or an exact decision. This mode has no execution action. Secure signed owner cookies, current tenant/user/session checks, exact origin and CSRF, strict JSON, a 2 KiB/64-chunk body limit and a two-second whole-request deadline bound the interface. Authentication is rechecked after the asynchronous evidence read and inside the workspace lock.

The host supplies a pinned packet hash, request ID and finite deadline. Without an explicit recorded-claim reader, the review uses the fail-closed primary-state reader described below. The browser cannot supply parcel/account facts, source assertions, input replacements or permission flags. `deriveRecordedQuoteApproval` shares the canonical input, wire, credential-receipt and review-summary derivation with the existing synthetic producer. Its separate recorded-evidence schema binds account/terms/receipt references, input and packing scope to the owner workspace and request.

The packing record must describe the selected whole package with measured gross weight and external dimensions, the same plan and quantity, and outer packaging included. Component measurements, estimates, mismatched quantities/dimensions, missing outer packaging and any added tare are refused. This validates the shape and consistency of recorded claims; it does not prove their physical accuracy. The DTO explicitly says the source and API eligibility are not independently verified and keeps `sourceVerified`, `accountEntitlementVerified`, `providerCallsAllowed` and `liveReady` false. Real data must never be relabelled as a synthetic fixture.

Preparation uses the existing approval-request identity, primary CAS and audit. The packet's fixed issued/expiry times keep the operation hash stable across reads and process restarts; replay does not renew the window. Decisions use the existing exact confirmation contract and add an audit entry binding the evidence hash. Evidence and cancellation guards run before save effects and commit. Exact readback reconciles a lost acknowledgement without a second write. An unconfirmed in-process attempt cannot write again; absence of a saved row does not authorize retry after restart. A transmitted persistence request can still commit after cancellation, so an unconfirmed response is not proof that nothing was saved.

[`parcel2go-recorded-owner-review.test.mjs`](../server/tests/parcel2go-recorded-owner-review.test.mjs) exercises preview → preparation → decision → manually composed native admission entirely with invented data and intercepted HTTPS. It also covers rejected decisions, immutable windows, invalid packing claims, client evidence injection, malformed/oversized input, tenant/auth refusals, changed evidence, competing workers, uncertain writes and cancellation before save effects. This test is not a production source-verification or live-permission receipt.

## Primary-source reader: independent verification only

A bounded inspection of [`store.mjs`](../server/lib/store.mjs), the [database schema](../server/supabase/schema.sql), its migrations and the existing catalogue/order/consignment readers found no protected source contract for packed-parcel observations or current carrier-account entitlement. Supplier metadata and workspace settings are general records. Catalogue/order source manifests cover their own commerce data; they do not verify dispatch gross weight, external dimensions, or carrier-account facts. The existing wholesale consignment review is explicitly fixture-only. This finding concerns the repository's source model; no production records were queried.

[`parcel2go-authoritative-evidence-reader.mjs`](../server/lib/parcel2go-authoritative-evidence-reader.mjs) provides a default-disabled, unmounted, read-only interface for the authenticated host. `inspect` uses the existing Supabase store's `exactSnapshot` read, checks tenant scope, and reports whether a unique retained credential-admission receipt links consistently to the encrypted connection and timestamps. `linked_receipt` means storage linkage only. It neither decrypts nor validates credentials, account eligibility, terms acceptance or physical measurements. It has a two-second read budget and a finite wall/monotonic window, with cancellation and no writes.

There is deliberately no success path for `readEvidence`: it returns no packet and throws `PARCEL2GO_AUTHORITATIVE_EVIDENCE_UNAVAILABLE`. The recorded owner-review candidate uses it by default and returns fixed dependency diagnostics, without creating an approval or audit entry. Arbitrary workspace keys, supplier metadata, hashes, `verified` flags and recorded packets cannot add authority. Explicit injected readers remain useful for recorded-claim reviews and synthetic tests; they do not become independently verified sources.

The missing contracts for an independently verified evidence reader are:

- `packed_measurement_source_missing`: a protected, tenant-scoped observation with stable identity/revision, authenticated recorder and acquisition/provenance evidence, observed time, revocation status, selected packing plan and quantity, measured whole-package gross mass including tare, and measured external dimensions. Supplier nominal/component figures cannot substitute for that observation.
- `account_entitlement_source_missing`: an authoritative account/client binding and current evidence of API eligibility, intended scope/terms, currency and VAT basis, with observed/expiry times and revocation. Private credential-storage consent is not this evidence.
- `consignment_selection_source_missing`: a current, revision-bound selection tying the intended order/packing observation to the route and declared value, with documented conflict resolution and source scope.

Before implementing a successful reader, define and review those source producers, protected persistence/read contracts, provenance checks and revocation rules. Then bind their immutable revisions to the evidence packet and revalidate them at execution. Adding self-declared JSON fields to the current workspace does not satisfy this dependency. No new source table, import, verifier, supplier measurement or provider request is fabricated by this checkpoint.

## Exact remaining live acceptance boundary

The candidate is not mounted or constructed by the server. [`parcel2go-live-setup.mjs`](../server/lib/parcel2go-live-setup.mjs) and [`parcel2go-live-entry-controller.mjs`](../server/lib/parcel2go-live-entry-controller.mjs) remain private credential-storage routes only. The ordinary admission factory still rejects direct `approved-https-integrated/v1` configuration.

The UI and server adapter now exist, but a reviewed production host still needs explicit mounting/release and finite activation/closure, private credential admission/configuration, and outcome reconciliation after the review window closes. The candidate contains the execution composition; no additional quote dispatcher or authoritative packing registry is required for its owner-declared comparison mode. The controller refuses after expiry; its active-window GET is not a post-expiry reconciliation service. The original synthetic producer and synthetic panel mode remain synthetic-only, and neither recorded nor owner-entered claims establish independent verification.

After that host is implemented and reviewed, release/activation and any real token/quote acceptance require separate authorization using privately admitted credentials and the approved exact parcel/route. Actual account acceptance, supported scope and the provider's returned GBP/tax/service semantics still need an authorized acceptance check; mock success cannot prove them. The existing implementation requests only `public-api`, refuses incompatible responses, and never broadens scopes automatically. Missing or uncertain results never authorize retry, a new UUID, or a larger allowance. There is no booking, payment, label, collection or purchase allowance here.

## Targeted verification

Run with the repository's Node 22 runtime:

```sh
node --test \
  saas/server/tests/parcel2go-owner-quote-surface.test.mjs \
  saas/server/tests/parcel2go-owner-input-ui.test.mjs \
  saas/server/tests/parcel2go-exact-owner-ui.test.mjs \
  saas/server/tests/parcel2go-owner-input-quote.test.mjs \
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
