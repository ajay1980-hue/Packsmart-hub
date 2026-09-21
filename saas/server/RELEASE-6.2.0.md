# Runvara 6.2.0 — Meta commerce and publishing

Extends the existing Connection Centre, encrypted connection records, tenant state,
OAuth challenge handling, read scheduler and Approval Centre. No database migration,
second integration store or changes to the separate eBay Manager.

## Implemented

- Facebook Login using Graph API v26.0; server-side code exchange and long-lived
  token exchange; one-time signed state bound to workspace, user and browser.
- Explicit owner opt-ins for catalogue access and publishing permissions. Actual
  granted permissions are read from Meta, rather than inferred from requested scopes.
  Every reconnection resets Runvara's policy to read-only.
- Discovery and workspace selection of authorised Pages, linked professional
  Instagram accounts, and owned/client catalogues. Page tokens are used only on
  the server and are excluded from public metadata and imported records.
- Selective catalogue/product, inventory, price and Page-post reads through the
  existing sync history and scheduler. Variant group references are retained.
  Pagination follows validated cursors, never provider-supplied continuation URLs.
  Incomplete reads retain earlier data. Current ceiling: 2,000 items per sync.
- Exact, approval-gated catalogue draft creation, product name/description updates,
  inventory/availability changes, and product visibility changes.
- Approval-gated Facebook text/link publication and text updates to posts created
  by Runvara in the same workspace.
- Approval-gated Instagram single-JPEG publication, with quota check, durable media
  container, delayed progress checks and a persisted claim before publication.
- Every Meta write requires approval, including in automatic mode. Permission and
  asset ownership are checked again before writing. Altered proposals, cross-tenant
  requests, revoked grants, changed accounts and uncertain retries are blocked.
- HMAC app-secret proof on Graph resource calls; credentials remain encrypted;
  safe error messages and existing tenant-scoped audit logging.

## Provider restrictions, with primary evidence

| Capability | Exact restriction and implementation consequence |
| --- | --- |
| Native shop order ingestion | Meta retired checkout inside Facebook/Instagram Shops. Commerce Order Management endpoints are blocked in v26.0 from **29 July 2026** and removed from all earlier versions on **27 October 2026**, without a replacement API. Do not downgrade to evade this retirement. Website-checkout orders continue through the existing Shopify/checkout integration. [Graph v26 changelog](https://developers.facebook.com/docs/graph-api/changelog/version26.0/) |
| Catalogue read-only OAuth scope | `catalog_management` bundles read, create, update and delete access. The owner must explicitly consent to this broad provider permission; Runvara independently remains read-only until its owner enables writes, then requires exact approval. Development mode limits access to catalogues owned by app administrators/developers. [Catalogue prerequisites](https://developers.facebook.com/documentation/ads-commerce/catalog/get-started.md/) |
| Facebook post updates | An app can update only a Page post created by that same app. Runvara also checks the originating workspace and Page. [Pages posts guide](https://developers.facebook.com/documentation/pages-api/posts.md/) |
| Instagram publishing | Facebook Login requires a linked professional Instagram account and appropriate Page access. Single-image publication requires a public JPEG. Page Publishing Authorization may be required. API publishing is limited to 100 posts per rolling 24 hours. For roles assigned through Business Manager, Meta additionally documents `ads_read` and `ads_management`; these are a separate explicit opt-in and do not enable advertising actions in Runvara. [Content publishing guide](https://developers.facebook.com/documentation/instagram-platform/content-publishing.md/) |
| Inventory | Catalogue inventory updates are asynchronous and are not atomic warehouse reservations. This release uses the `inventory` parameter documented on the Product Item update endpoint, reads `quantity_to_sell_on_facebook` when returned and falls back to `inventory`. [Product Item reference](https://developers.facebook.com/docs/marketing-api/reference/product-item), [inventory guide](https://developers.facebook.com/documentation/ads-commerce/catalog/guides/inventory.md/) |

The API permits additional capabilities which this release does **not** implement:
Instagram videos, reels and carousels; Facebook photo/video upload; comment moderation;
bulk feeds/batches; remote deletion; existing-product price changes; advertising.
These are implementation limits, not claims of Meta API prohibition. No controls
are presented as working for those actions. Draft creation includes an explicitly
reviewed price and currency; it is not an automatic price update.

## Production platform configuration — pending owner account access

Audit on 21 September 2026: existing Render service
`srv-dadtf9gn74is73bhevg0` has no Meta environment keys. The Meta developer dashboard
is at its sign-in screen. No app ID, secret, permissions approval, live mode or
successful live OAuth connection is claimed by this release.

Use the owner's existing Meta app, if present; do not create a duplicate without
checking. Configure Facebook Login / the applicable business-login use case with:

- App domain: `packsmart-ops.onrender.com`
- Exact valid OAuth redirect: `https://packsmart-ops.onrender.com/api/integrations/meta/oauth/callback`
- Baseline scopes: `pages_show_list`, `pages_read_engagement`, `instagram_basic`.
- Explicit optional scopes: `catalog_management`, `business_management`,
  `pages_manage_posts`, `instagram_content_publish`; business-role publishing's
  additional advertising scopes only when needed and explicitly selected.
- Confirm app review/advanced access and business verification requirements for
  customers outside app roles. A development-mode login is not proof of general
  customer availability. Complete the actual app's required platform fields,
  owner-approved privacy policy and data-deletion configuration before live mode.
- Store the real app ID and secret server-side as `META_CLIENT_ID` and
  `META_CLIENT_SECRET`; enable `META_OAUTH_ENABLED=true` only for a valid configured
  app. Existing `APP_PUBLIC_URL` and credential-encryption key are reused.
- `META_LOGIN_CONFIG_ID` is supported if the existing app requires Facebook Login
  for Business. Its configured grants must match the customer's explicit choices;
  do not use a broad fixed configuration that silently adds write permissions.

Customers then use Connect inside Runvara; they do not handle API keys. Until this
platform configuration is completed, the existing setup-unavailable state remains
truthful. Code deployment alone does not enable Meta sign-in.

## Verification

- 81/81 server and DOM interaction tests pass locally; includes seven new Meta
  lifecycle, consent, tenant, approval, asset, revoked-access, uncertain-result,
  Instagram processing and customer-interface tests.
- Existing eBay Manager regression passes; SaaS safety guard passes for 15 fixtures.
- JavaScript syntax and whitespace checks pass.
- Local Node 24; deployment uses Node 22 and must pass the existing CI/container gate.
- No live Meta publication, destructive test, or change to connected Shopify/eBay
  credentials was made. Real Meta OAuth and account capability checks remain pending
  app-owner authentication and any required Meta approval.
- Responsive layout uses the existing Connection Centre CSS. DOM behaviour is
  tested; a real narrow-viewport visual test is not claimed.
