# Runvara 6.1.0 — Connection Centre

Audit baseline: production and local checkout both at `53750c03450189c8131f5ba27b2850d8cc3a386d`; clean checkout; 58 passing server tests. The production database contained 89 products and 64 orders. No production credential or business record was changed during implementation.

## Changes

- The existing Sales Channels page now has interactive cards and an accessible details dialog: identity, health, imported counts, test/reconnect/refresh/disconnect actions, selected read areas, automatic-sync settings, frequency, progress and history.
- Uses the existing `IntegrationService`, encrypted `connections`, tenant state, signed sessions, CSRF checks, audit log, approval records, CAS persistence and Autopilot scheduler. No second integration store, service, database schema or production deployment target was created.
- Disconnect requires confirmation and a current settings revision. A tenant-local tombstone blocks environment fallback and scheduled reads. Credentials are nulled in the existing record so reporting mirrors also clear them. Imported records and the separate eBay Manager bridge remain intact.
- Existing Shopify and eBay read adapters now respect selected areas. Unselected fields, historical orders, manual costs and failed-read data remain intact. Read history records start/completion/failure, supports polling during a persisted claim, and keeps summaries in the durable audit log.
- Existing eBay OAuth exchange is reused for customer tenants. Every new OAuth request binds provider, workspace, initiating user/session version, expiring signed state and an HTTP-only browser nonce. Callbacks consume state before exchanging codes. Shopify validates its HMAC and shop domain. Google uses PKCE. Reconnecting to a different account requires an explicit owner opt-in.
- No existing connection is granted write privileges. Policies are read-only, approval-gated, or explicit owner-authorised automatic. Shopify additionally requires a verified `write_products` grant. Product title/description updates always require approval of the exact stored proposal. Automatic bypass is limited to private app-owned product notes. Financial, destructive and unsupported actions have no new executor. A persisted write claim prevents an uncertain result being automatically replayed.

## Connector coverage and activation

| Channel | Implemented reads | Ordinary customer setup once the platform app is enabled |
| --- | --- | --- |
| Shopify | Products, variants, inventory, prices, orders; optional customer IDs/order counts | Enter store address, sign in and consent; existing custom-app credentials remain supported |
| eBay | Existing Manager reads, or current OAuth Inventory listings, prices, quantities, orders and promotions | Existing eBay OAuth; existing Manager stays available |
| Meta | Facebook Pages and linked Instagram account identities | Facebook OAuth |
| TikTok Shop | Authorised shops, product/SKU/price/inventory records, last-90-day order summaries | TikTok Shop seller authorisation |
| Google / YouTube | YouTube channel identity and statistics | Google OAuth with offline access and PKCE |
| Pinterest | Boards and Pins | Pinterest OAuth with rotating refresh tokens |
| Amazon / WhatsApp | No adapter yet | Setup guidance and a persisted workspace setup request; no pretend connect/sync action |

Meta Shop orders/catalogue publishing, Google Merchant feeds/advertising and Pinterest advertising/catalogue publishing are explicitly unavailable. eBay direct OAuth remains Inventory-service-only; it does not claim full marketplace comparison coverage.

The **Runvara operator**, not each customer, must register/approve the provider application and allow the callback at `https://packsmart-ops.onrender.com/api/integrations/PROVIDER/oauth/callback`. A customer is never asked for these server secrets by the normal Connect flow:

- Shopify: `SHOPIFY_OAUTH_ENABLED=true`, `SHOPIFY_OAUTH_CLIENT_ID`, `SHOPIFY_OAUTH_CLIENT_SECRET`. Existing per-store Shopify credentials are unchanged. Request `read_customers` or `write_products` only through explicit options; platform approval may be required.
- eBay: existing `EBAY_OAUTH_ENABLED`, client ID/secret and redirect URI name are reused. The existing redirect must continue to resolve to the current eBay callback.
- Meta: `META_OAUTH_ENABLED=true`, `META_CLIENT_ID`, `META_CLIENT_SECRET`; approved `pages_show_list` and `instagram_basic` access.
- Google: `GOOGLE_OAUTH_ENABLED=true`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; YouTube Data API and approved OAuth consent for `youtube.readonly`.
- Pinterest: `PINTEREST_OAUTH_ENABLED=true`, `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET`; `user_accounts:read`, `boards:read`, `pins:read`.
- TikTok Shop: `TIKTOK_SHOP_OAUTH_ENABLED=true`, `TIKTOK_SHOP_APP_KEY`, `TIKTOK_SHOP_APP_SECRET`, `TIKTOK_SHOP_SERVICE_ID`; market defaults to ROW (set `TIKTOK_SHOP_MARKET=US` only for a US app). Seller authorisation, product and order read scopes must be approved.

Configuration is not proof of provider app approval. Keep a connector disabled until its production consent/redirect/scopes have been verified. No app credential values are included in this repository, browser payload or release note.

## Verification

- `npm --prefix saas/server run check`: passed.
- `npm --prefix saas/server test`: 74 tests passed, including 16 new Connection Centre tests and all original 58 regressions.
- `node saas/tests/saas-guard.test.cjs`: passed for all 15 snapshot fixtures.
- `node --test ebay-manager/tests/ebay-manager.test.js`: passed.
- Runtime dependency audit: zero vulnerabilities; no new runtime dependency.
- Real local HTTP tests cover connect/sync/disconnect/reconnect, durable progress, expired/invalid access, partial-read recovery, field preservation, CSRF, viewer/admin/owner boundaries, cross-tenant access, missing/expired/replayed/forged/cross-provider OAuth state, browser binding, HMAC failure, consent cancellation, refresh rotation, exact approval, unsupported financial writes and uncertain-write replay prevention.
- DOM tests load the production UI module and submit real authenticated HTTP requests for cards, sync settings, confirmations, and unavailable-channel setup requests. Responsive CSS uses one column on narrow displays, a viewport-bounded native modal, and touch-sized controls.
- TikTok signing matches the platform's published HMAC test vector. OAuth and social-channel API tests use provider-contract fixtures; they are not claims of live provider consent.

Mobile visual verification and authenticated production verification remain release-evidence items. Local preview navigation was blocked by the cloud browser URL policy; no alternative browser-control path was used. Run `node saas/server/tests/render-connection-preview.mjs /absolute/preview.html` to generate a clearly labelled responsive fixture for manual inspection.

## Operational limits

Automatic reads obey the existing workspace Autopilot switch, rule permissions and daily limits as well as individual channel settings. The UI explains when Autopilot is paused. Frequency is a requested minimum interval, subject to these limits and API availability.

Read jobs use a 10-minute lease. Stale jobs show an interrupted state and can be retried. Recent detail history retains 300 workspace records; completed summaries remain in the durable audit log. Shopify customer reads cap at 2,000 records; social reads cap at 20 pages; TikTok reads cap at 10 shops and 50 pages per shop/area. Reaching a cap fails safely without replacing the prior dataset.

## Primary implementation references

- [Shopify standalone OAuth and expiring offline tokens](https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps)
- [Shopify productUpdate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productUpdate), [metafieldsSet](https://shopify.dev/docs/api/admin-graphql/latest/mutations/metafieldsSet)
- [Google server-side OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [YouTube channels.list](https://developers.google.com/youtube/v3/docs/channels/list)
- [Pinterest authorisation and refresh rotation](https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/)
- [TikTok authorisation](https://partner.tiktokshop.com/docv2/page/authorization-overview-202407), [request signing](https://partner.tiktokshop.com/docv2/page/sign-your-api-request), [product search](https://partner.tiktokshop.com/docv2/page/search-products-202502), [order list](https://partner.tiktokshop.com/docv2/page/get-order-list-202309)
- [eBay authorisation](https://developer.ebay.com/develop/guides/sell/authorization)
