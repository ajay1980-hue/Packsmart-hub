# Parcel2Go owner sandbox quote: local candidate

This adds the missing owner action over the separately reviewed sandbox HTTP transport. It supersedes the historical missing-route statement in `parcel2go-sandbox-http.md`; it does not authorize a release, credential operation or provider request. Everything remains off by default.

## Admission and side effects

The existing Channels view conditionally exposes one confirmation and Run sandbox quote once button. Opening the dashboard never requests a token or quote. Exact GET/POST `/api/owner/parcel2go-sandbox-quote` requires the existing authenticated strict owner, Packsmart tenant, current session, quiet owner workspace and Supabase store; POST additionally requires normal CSRF, exact Origin, JSON and an exact three-field body. Neither ordinary tenants, admins nor normal startup bypass this gate.

`RUNVARA_QUIET_PARCEL2GO_SANDBOX_QUOTE=enabled/v1` requires these `RUNVARA_PARCEL2GO_QUOTE_` descriptor suffixes: REQUEST_ID, EXPECTED_REVISION, OPENED_AT, EXPIRES_AT, EXPECTED_CLIENT_ID, TERMS_REFERENCE, CONNECTION_ID, ACCOUNT_ID, ADMISSION_REQUEST_ID, DATA_CONTRACT and SCOPE_POLICY. The last two must be `synthetic-gbp-notregistered/v1` and `public-api-only/no-openid-fallback/v1`. The separate credential-entry and Shopify exchange/import controls must be absent or disabled. All independent controls retain their existing protections and must remain closed in the later operational procedure.

The private expected client ID is compared inside the existing encrypted-credential boundary. It and the credential, ciphertext, token and projection hash are never returned by this route. The fixed public DTO contains status, request/revision/account/connection references, remaining time and receipt count; a successful POST may additionally return validated ephemeral quote amounts. GET never decrypts credentials or calls a provider, and never returns rate amounts. It still reads the internal full workspace; absence of a customer projection is not absence of internal customer/order-containing state reads. Baseline authentication/security bookkeeping remains intact.

One durable reservation precedes provider traffic; one final CAS saves the receipt/audit after validated completion. Normal archives/retention and store diagnostics apply. Existing business records and encrypted connection are preserved. An uncertain claim, issuer response or save consumes the attempt. Reconcile the exact saved request/revision; never reissue or replace its UUID. A successful issuer response alone is not a completed test. Quote prices and the bearer token are not persisted.

## Fixed test and transport

Only POST `https://sandbox.parcel2go.com/auth/connect/token`, then at most one POST `https://sandbox.parcel2go.com/api/quotes`. Scope is exactly `public-api`; it is broad provider access, not provider-enforced read-only access. No openid/payment/my-profile fallback, redirects, retries, live host, orders, profile, payments, shipments, labels, webhooks or resale. The documented openid discrepancy is a deliberately bounded test uncertainty: refusal ends the attempt.

Server-fixed synthetic input: GBR to GBR; 250 g, 200 x 100 x 50 mm; declared GBP 12.30; both address VatStatus values NotRegistered. These are fictional test assumptions, not real measurements, VAT status or account eligibility. Wire units are 0.25 kg and 20 x 10 x 5 cm. Non-GBP or inconsistent total/net/VAT output is rejected; no VAT rate is invented. Country-only acceptance is unverified until a separately approved test. Successful quotes still carry unknown expiry and no price, delivery or purchase guarantee.

The absolute window is at most five minutes from opening submission, including rollout, with wall-clock and monotonic fail-closed checks. Each HTTP request is at most five seconds; token response 16 KiB, quote response 256 KiB, headers 8 KiB and at most 50 quote results. The access token remains server-memory-only and obeys returned expires_in (1..86400 seconds), additionally clipped by session/window/request deadlines. Raw buffers are cleared and references released, without a forensic-memory-erasure claim.

## Interruption, expiry and closure

The UI derives its shortest remaining budget from server timing and performance.now, subtracting request latency. It retains a session-storage spent marker before POST; unavailable storage refuses submission. Double clicks, reload, navigation, revocation, timeout and late responses do not create a new attempt. Browser receipt recovery cannot recover unsaved prices. Server expiry, shutdown and disconnected requests abort the active transport. A fresh process still assumes trusted UTC for absolute expiry; no universal guarantee against an arbitrarily reset host clock is claimed.

Immediately after any outcome, set only the quote flag to disabled/v1, retain original descriptor/evidence, deploy the same pinned build and verify effective OFF state plus enabled predecessor clean termination. Begin closure by minute two if not completed, and do not extend the original five-minute deadline. Automatic expiry closes admission but is not configuration cleanup or instance termination. Closing or code rollback cannot revoke an issued token/API client, restore prior ciphertext or remove saved evidence.

## Separate future gates

First review/publish/deploy this exact code disabled, after CI and included-cost verification. Then separately approve one sandbox client creation for the verified account, required API/item agreements, private owner secret entry and one encrypted save through the existing entry flow. No credential creation is part of this candidate. Only after that save and closure are proven may an action-time approval name one public-api-only synthetic test, exact descriptor/account/client/admission/revision, included-cost basis (or a fresh explicit monitored budget), current owner session and closure plan. No historical spend allowance applies. No live account facts, provider validity or production readiness are established by mocked tests.
