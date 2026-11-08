# Parcel2Go: disabled local quote foundation

This is an internal Packsmart-only proposal, not a connected Parcel2Go adapter.
It adds no provider registration, HTTP route, UI, migration, scheduled worker,
network transport, token request, database write or deployment configuration.
`createParcel2GoQuoteFoundation()` defaults to `disabled/v1`. The only other
accepted mode is explicitly `offline-fixture/v1`; `enabled/v1` and live mode
are rejected. Fixtures always return `synthetic: true`, `liveReady: false`.
An environment variable cannot activate this candidate.

## Existing architecture and intended reuse

- `lib/security.mjs` already provides AES-256-GCM credential encryption and a
  public connection projection that omits ciphertext. The proposed envelope
  uses that implementation and authenticates tenant, connection, account and
  sandbox environment inside the ciphertext. No new cryptographic format or
  real key is introduced. The sealed result is SERVER-ONLY, never bootstrap,
  browser data, audit detail, logs, ordinary export or a public connection DTO.
- `assertQuietOwnerWorkspace` supplies the existing strict owner and tenant
  check. This module also checks session expiry and revision, before and after
  fixture work. A future route must obtain auth and binding from trusted server
  state, never request JSON, and retain the existing CSRF/security audit policy.
  The local harness supplies a bounded synthetic owner projection, not full
  customer/order state.
- `connection-centre.mjs` does not register Parcel2Go. Its generic defaults
  include autoSync, so adding a registry entry now would be unsafe and is
  deliberately deferred. Shopify and existing Veeqo proposal files are unchanged.
- `connection-dispatch.mjs` and guarded store paths show the established durable
  claim/CAS/audit conventions. This foundation has only an in-memory fixture
  fence; it must NOT be used as durable admission or restart-safe idempotency.

## Bounded internal quote contract

One measured packed parcel, domestic GBR to GBR only. Preserve original decimal
strings: grams, millimetres, declared GBP value. No order, customer address,
email, name or telephone input is accepted. Source authenticity and courier
limits are not proved by shape validation. The local upper bounds are safety
limits, not claimed carrier limits. Country-only data may not be sufficient for
an actual quote; provider-required addresses and privacy scope remain unresolved.

The fixture request includes trusted tenant/account/connection/environment,
request/revision and a deterministic parcel fingerprint. Fixture callbacks never
receive credentials, tokens, encryption keys or ciphertext. One request ID is
spent per in-memory instance before awaiting a fixture. Failure is generic and
cannot echo raw fixture errors. Post-await owner/revision/token/clock checks
refuse stale output; a five-minute fixture result limit is not an active timer
or a production cancellation mechanism.

The INTERNAL response schema is `runvara-parcel2go-quote-fixture/v1`, not the
Parcel2Go wire schema. It permits up to 50 distinct service codes, exact GBP
decimal amounts, explicit tax status and optional provider expiry. Unknown tax
and expiry remain unknown. A quote is never purchase authority, a guaranteed
price or a delivery promise. No payment/order/label/fulfilment/notification/
tracking/webhook operation is implemented. Unsupported operations fail before
credential handling.

## Credential and expiry design

`sealParcel2GoCredentials` is an in-memory server helper. It does not create a
provider credential, insert a connection or save an envelope. The proposal binds
synthetic credentials to an already verified sandbox account; actual account
identity is currently unknown and must not be guessed from email/order history.

`captureParcel2GoToken` is a pure response parser, not a token exchange. It uses
the returned positive integer `expires_in` from the request's sent time, omitting
network-latency extension. Responses lasting more than 24 hours are locally
refused pending review (a safety policy, not a documented provider maximum).
Only Bearer plus exactly `public-api` is accepted; when response scope is omitted,
the parser records the requested baseline scope and does not assert independent
provider scope introspection. `payment` and `my-profile` are never requested or
accepted. Missing/expired tokens fail closed with no renewal fallback.

`public-api` is broad baseline API access, NOT a provider-enforced read-only
scope. Quote-only operation must be enforced by future server routing and an
exact fixed-destination transport, not by the OAuth scope. Tokens and credentials
must remain server-side. Closing a future control would not revoke them.

## Official evidence checked 8 November 2026

- [API overview](https://www.parcel2go.com/api/docs/index.html) and
  [Quickstart](https://www.parcel2go.com/api/docs/articles/quickstart.html): stable
  quote destination is `POST /api/quotes`; auth uses `/auth/connect/token`.
- [Authentication](https://www.parcel2go.com/api/docs/articles/intro.html):
  server-side client credentials, broad `public-api`, separate payment/profile
  scopes, and returned token expiry. Example scopes are NOT copied as authority.
- [Environments](https://www.parcel2go.com/api/docs/articles/endpoints.html):
  `https://sandbox.parcel2go.com` and `https://www.parcel2go.com`; credentials are
  separate, sandbox behaviour is not proof of live equivalence. No v2 alpha.
- [Swagger](https://www.parcel2go.com/api/swagger): the public page resolved but
  the reader exposed only its shell. Full quote response/request schemas and
  wire weight/dimension units remain unverified. No payload/units are invented.
- [API licence](https://www.parcel2go.com/api/docs/articles/terms.html): use binds
  the licensee; resale needs prior written consent and third-party use has
  conditions. No terms were accepted or API use initiated in this work.

Public documentation was read, but no operational provider/API request was made.
Some direct article reads initially failed technically; following the actual
overview links succeeded. Stripe Directory guidance was checked first; CLI was
absent and its documentation returned an unsupported-content error. No install,
authentication, guessed directory command or provider provisioning was attempted.

## Gates before any connected test

1. Independently review this exact unpublished source. Verify the stable official
   wire schema, required parcel/address fields, units, tax/currency/expiry and
   bounded response handling. Implement that mapper locally; no fake adapter.
2. Privately verify the intended existing account's identity and separate sandbox
   ownership. The parent reports a live API page with no credentials and £0.00
   PrePay; this task did not recheck those facts. A sandbox account may still be
   missing. No live credential may be reused for sandbox.
3. Obtain specific owner authority to create ONE sandbox API credential, with
   baseline public-api access only, and accept applicable API terms. Creation of
   a secret/password requires a supported secure owner handoff; never paste it
   into chat, terminal history, screenshots or logs. No payment/profile scope.
4. Separately review and authorize secure storage in the existing Runvara stack:
   one server-only encrypted credential envelope on the exact tenant/account/
   connection, guarded CAS/audit without secrets, normal retention/capacity and
   redacted verification. No generic connection editor or new database. This
   candidate does not implement that write route, so storage is NOT ready yet.
5. Review/publish/release any completed transport and admission code only after
   separate authority. Keep it disabled. A bounded sandbox test then needs one
   token exchange and one quote request to the fixed sandbox host, synthetic
   nonpersonal parcel/address values, strict byte/time limits and no retries on
   uncertain send. Specify the exact data, any cost/terms and closure before
   asking; do not reuse the Shopify budget or pending import approval. Proposed
   bounds: 20-second requests, 16 KiB token response, 256 KiB quote response,
   five-minute absolute permit including rollout, durable request claim and
   read-only uncertainty reconciliation. These are future design targets, not
   implemented network guarantees in this mock-only module.
6. Live-account testing, label purchase/payment, fulfilment/customer notification,
   production activation and resale are later separate decisions. Sandbox success
   does not prove live eligibility/pricing. No order/customer data is needed for
   the proposed first synthetic test.

Rollback today means discard the isolated proposal. Future code rollback cannot
revoke issued tokens, erase a provider order or restore replaced ciphertext;
provider revocation and any credential/data recovery need their own exact plan.
