# Runvara 6.2.1 — Connection recovery and honest capability controls

## Audit, 23 September 2026

Production before this change: 6.2.0, commit
1a296b9490249e9ccec22dc67eaa7c186b20d9c2. Public health returned
ok, productionReady, Supabase persistence, authentication and encryption true.
Existing main already includes Connection Centre cards, tenant-bound OAuth,
selective/scheduled reads, disconnect confirmation, sync history, explicit owner
write consent, exact approvals, Shopify content writes and Meta commerce/publishing.
The existing unpublished Facebook destination guard and its audit are preserved.
No integration store, database, service or credential is replaced.

## Changes

- Failed actions restore panel controls even if status refresh also fails. A local
  Starting sync indicator no longer remains indefinitely after a rejected request.
- Expired Runvara sessions close the Connection Centre and show the existing login
  screen. The message distinguishes Runvara sign-in from channel reconnection.
- Browser API calls have a two-minute cancellation deadline and safe connectivity
  errors. Unknown outcomes tell customers to check activity before retrying; writes
  are never automatically replayed.
- Connection details show last failed sync, safely extracted access expiry,
  granted scopes, automation state and the latest 30 tenant-scoped audit summaries.
  Only event ID/type/time are returned, not arbitrary audit details or credentials.
- Unsupported channel write policies are rejected by the server and excluded from
  the selector. Existing Shopify/Meta approvals and permitted writes remain intact.
- Shared Google/Pinterest transport identifies rate limits and offers a delayed
  retry instead of suggesting invalid credentials. Existing Meta handling remains.
- Shopify counts include only Shopify products. Browser asset version is 6.2.1.

## Verification

87/87 server and DOM tests pass, including four new tests for safe diagnostics,
unsupported write consent, failed action/status recovery and provider rate limits.
The existing interface test now checks the real session-expiry login transition.
DOM fixtures use Node's AbortController with their Node fetch transport.
JavaScript syntax, whitespace checks, the 15-product SaaS guard and the separate
existing eBay Manager regression pass. Live commercial writes were not performed.
A live authenticated mobile/account smoke test remains required; DOM tests are not
claimed as real provider consent or visual-device verification.

## Remaining platform actions (secrets go only into server configuration)

- Meta: latest owner report says production META_CLIENT_SECRET is required. Verify
  its presence securely in the existing Render service; never print its value.
  Earlier successful Page discovery does not prove it is still configured. Confirm
  Packsmart's Page and linked Instagram after reconnect. Public customer rollout
  still needs the app's required verification/review, legal pages and live mode.
- Google/YouTube: existing or newly owner-approved Cloud project, YouTube Data API,
  OAuth web client and consent setup. Configure GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET, GOOGLE_OAUTH_ENABLED=true. Exact callback:
  https://packsmart-ops.onrender.com/api/integrations/google_youtube/oauth/callback
- Shopify public customer connection: SHOPIFY_OAUTH_CLIENT_ID,
  SHOPIFY_OAUTH_CLIENT_SECRET, SHOPIFY_OAUTH_ENABLED=true and provider distribution
  approval. Preserve Customer Zero's existing per-store connection.
- eBay: existing developer application's Production credentials and separate RuName
  when direct OAuth is unavailable. Do not alter the separate Manager callback.
- TikTok: approved Shop application and TIKTOK_SHOP_APP_KEY,
  TIKTOK_SHOP_APP_SECRET, TIKTOK_SHOP_SERVICE_ID, TIKTOK_SHOP_OAUTH_ENABLED=true.
- Pinterest: approved app and PINTEREST_CLIENT_ID, PINTEREST_CLIENT_SECRET,
  PINTEREST_OAUTH_ENABLED=true.

## Genuine remaining build work

This is an incremental recovery release, not a declaration that every requested
connector is complete. eBay, TikTok, Google and Pinterest external writes are not
implemented. Google covers YouTube channel reads, not Merchant feeds or Gmail.
Email/WhatsApp customer-message delivery is not a live connector in this centre.
Public self-service onboarding remains controlled by the existing beta flag;
a complete customer registration-to-ready wizard and broader write executors need
further implementation and provider approval. No beta/billing flag was enabled.
Existing Meta implementation limits remain documented in RELEASE-6.2.0.md.
Provider-side grant revocation is distinct from Runvara disconnect: the latter
removes saved credentials and stops jobs but does not claim remote app revocation.

Live verification must record the exact deployed SHA and authenticate as Packsmart
before claiming current data counts, reconnect, approvals, Commander visibility or
mobile workflow results. An inaccessible account is not evidence of lost data.
