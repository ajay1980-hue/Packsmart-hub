# Runvara 6.4.0 — controlled beta and shared product design

Continues production 9bbe334 in the existing Packsmart-hub repository and
packsmart-ops Render service. No new infrastructure, schema migration, provider
grant, commercial activation or external commerce write.

## Customer behaviour

- Runvara branding and shared navy/blue/gold design tokens cover all authenticated
  views, login, invitations, onboarding, controls, forms, tables and dialogs.
  Mobile navigation uses a 44px+ menu and two-column navigation instead of tiny
  horizontally scrolling labels. Reduced motion, keyboard focus and a skip link
  are included. Completed onboarding collapses instead of pushing channels down.
- Workspace names and account labels come from the signed-in tenant. Customer
  zero's eBay Manager link and login email are not offered to new businesses.
- Signup defaults to Invite/Beta even when the old beta boolean is set. Closed,
  Beta and Public are administered only by the configured customer-zero owner.
  Public mode requires the exact confirmation `ENABLE PUBLIC SIGNUP`.
- Invitations are random 256-bit, email-bound, seven-day tokens. Only SHA-256
  hashes are stored. Links use URL fragments; the browser clears the fragment.
  A token deterministically identifies one workspace; the existing atomic
  workspace creation and unique email index prevent duplicate redemption.
  Revocation prevents new signup, not access to an already-created workspace.
- Business details, selected platforms, test/import evidence and permission
  reviews remain in each workspace. Beta accounts have explicit beta access,
  without starting a charge or choosing a trial duration.

## Performance and recovery

- Startup no longer waits for a separate health request. Session restoration
  projects workspace and user identity from authoritative state instead of
  fetching all products/history. Revocation is still checked fresh, uncached.
- Dashboard bootstrap never starts provider sync. It returns saved data even
  while that workspace has an in-flight sync. Existing scheduler and explicit
  sync actions continue to own imports. Source failures remain visible.
- Concurrent health probes share one database check, cached for at most five
  seconds, with `checkedAt` and cache lifetime in the response.
- HTTP password derivation uses asynchronous scrypt, preserving existing hashes.
- Reads have 30-second browser deadlines; changes retain the 120-second deadline
  and uncertain-result warning. Session cancellation and deadlines both work.
- No writes are retried by these changes. Existing revision, replay, approval,
  credential encryption and OAuth protections remain in force.

## Safe write preparation

Shopify's owner-only tag preview reads the exact live product tags and proposes a
unique `runvara-beta-check-*` tag plus inverse removal. It does not change provider
permissions, create an approval or execute a write. Exact reviewed tag baselines
can be bound into a write proposal's existing digest; execution refuses a changed
baseline before claiming or sending a write. Applying and reversing still require
separate approvals, product write scope and the appropriate owner policy.

## Validation before deployment

105/105 server tests pass; syntax, SaaS safety guards and existing eBay Manager
regression pass. New coverage includes invitation bypass/tampering/expiry/
revocation/concurrent redemption, independent tenant onboarding and restoration,
platform privilege separation, async password compatibility, fresh identity
revocation, read-only tag preview, changed-baseline rejection, signed billing
webhook replay/order handling, database interruption and 12 provider failures.

Isolated load sample: four tenants with 89 synthetic products each; 160 requests,
concurrency eight. Session, bootstrap (product/order reads), connection status,
onboarding, audit, approvals, agents and control surfaces all return 200. Sample
p50 19ms, p95 28ms, maximum 51ms; no provider calls. Fixture and test process heap
increased 10.5 MiB; this short run is not a leak/soak or real database capacity test.
Four concurrent real password logins also pass in the isolated server.

Pre-deploy production /api/health: 6.3.1 / 9bbe334, HTTP 200, 10.20 seconds from the
execution environment (includes network). Previous Render deployment: 25.7 sec;
Node launch/startup in the same logged second, live readiness about five seconds
later. These are distinct measurements; no unsupported cold-start claim is made.
Browser policy blocks localhost and file previews in this environment. Live
production visual verification follows deployment; no mobile acceptance claim is
made merely from CSS or DOM-only tests.

## Existing billing audit and public-launch blockers

Existing architecture: Starter/Growth/Pro definitions with indicative amounts,
Stripe Checkout creation, signed webhooks, subscription records, duplicate and
out-of-order event handling, tenant metadata, and customer-zero free protection.
Charging remains disabled; no checkout, purchase, pricing change or live webhook
is triggered by this release. Unapproved indicative pricing is removed from the
customer UI; underlying configuration is preserved.

Before a **paid public launch**, the owner must confirm plans, prices, trial term,
feature entitlements, failed-payment grace policy and cancellation/downgrade
behaviour. Missing development: entitlement enforcement, trial-expiry processing,
customer billing portal/change/cancel UI, invoice-payment lifecycle/reconciliation,
and Stripe test-mode acceptance of the agreed policy. Existing subscription status
recording is not equivalent to complete billing enforcement. Public signup should
remain gated pending these decisions and their implementation.

Account recovery/email verification, invitation delivery procedures, support,
terms/privacy publication and a real-device keyboard/accessibility acceptance
pass remain public-launch gates. Current beta signup is operator-mediated and
must be offered only to an explicitly selected, supported cohort.

Google setup remains documented in GOOGLE-PRODUCTION-SETUP.md: YouTube Data API v3,
web OAuth client, youtube.readonly scope, External consent/test users and exact
production redirect. Credentials go only into the existing Render environment.
Meta public-app approvals, eBay eligibility and any additional Shopify/Meta write
scope remain external/owner dependencies. No speculative integrations were added.
