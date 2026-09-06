# Packsmart Ops production deployment contract

The Node 22 service serves the authenticated cockpit and API from one container. It listens on `PORT` and exposes `GET /api/health`.

## Required production configuration

Store these as private platform environment variables; never commit their values:

- `PACKSMART_ADMIN_EMAIL` — `sales@packsmartsolutions.com` for customer-zero.
- `PACKSMART_ADMIN_PASSWORD` — strong, temporary bootstrap password. On first login the owner must replace it; the database hash then takes precedence and old sessions are revoked.
- `OWNER_ACTIVATION_TOKEN` — random 256-bit-or-stronger one-time setup token. It is delivered only as a URL fragment and becomes unusable as soon as the owner sets a password.
- `SESSION_SECRET` — at least 32 random characters used to sign expiring sessions.
- `CREDENTIALS_KEY` — separate value of at least 32 random characters used for AES-256-GCM connection credential encryption.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — dedicated server-only persistence connection.
- `APP_PUBLIC_URL` — `https://packsmart-ops.onrender.com`.

Apply `saas/server/supabase/schema.sql` for a new project. For an existing Packsmart Ops project, apply each file under `saas/server/supabase/migrations/` in filename order. Schema v4 adds server-only mirrors for product cost profiles, suppliers, cost history, order financials and advertising costs. The authoritative workspace state and every mirror table remain tenant keyed. Row-level security is enabled and browser roles have no access; only the Node service uses the service-role credential.

## Read-only commerce integrations

Shopify requires:

- `SHOPIFY_STORE_DOMAIN=wavtzm-vy.myshopify.com`
- `SHOPIFY_ADMIN_API_VERSION=2026-07`
- `SHOPIFY_ADMIN_ACCESS_TOKEN` with only the read scopes needed for products, inventory and orders (`read_products`, `read_inventory`, `read_orders`; add `read_marketplace_orders` and `read_quick_sale` only when those order sources are required).

The existing eBay Manager adapter requires:

- `EBAY_MANAGER_BASE_URL` — HTTPS URL of the existing server-side OAuth backend.
- `EBAY_MANAGER_API_TOKEN` — optional backend-to-backend access token.
- `EBAY_EXPECTED_ACCOUNT=packsmartsolutions20`

Both adapters make read requests only. No listing, price, inventory, promotion or product write is implemented. Shopify imports source order totals, discounts, tax, shipping, refunds and line items. The eBay adapter reuses the existing Manager's connected seller identity and commercial guard, and can consume its read-only orders, fees and promotion endpoints when present.

## Social-commerce channel contract

Meta/Facebook Shops, Instagram Shopping, TikTok Shop, Pinterest, Google Merchant/YouTube, WhatsApp and Amazon are represented as isolated, tenant-scoped connection records. Their status, sync error and metrics can appear in the command centre without credentials reaching browser code. A provider is not marked connected until its server-side OAuth or service credential has been installed and a read test succeeds. No social or marketplace write executor is enabled; material price, inventory, listing, advertising, refund and purchasing actions remain approval-gated even after a read connection is added.

## Billing and beta flags

- `BILLING_CHECKOUT_ENABLED=false`
- `BETA_SIGNUPS_ENABLED=false`
- `AI_BRIEF_ENABLED=false`

Stripe variables (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and price IDs) may be prepared later. Checkout must remain disabled until explicitly approved. Packsmart customer-zero is hard-blocked from checkout regardless of the flag.

## Build and smoke test

```sh
docker build -f saas/server/Dockerfile -t packsmart-ops .
docker run --rm -p 8787:8787 --env-file saas/server/.env packsmart-ops
curl --fail http://127.0.0.1:8787/api/health
```

Production readiness requires `storage: "supabase"` plus successful persistence, authentication and credential-encryption checks.

## Customer-zero migration

After first login, the browser submits the existing Packsmart economics and automation preferences to the authenticated workspace once. The server merges missing landed, packing, delivery and channel costs without overwriting already-persisted values, records migration metadata and creates an audit event. Refreshing or signing in on another device then restores the server copy.

## Operational invariants

- Use HTTPS at the public edge.
- Never expose secrets or OAuth refresh tokens through static assets, API responses or logs.
- Every state access is derived from the verified session workspace, never from a request query/body workspace ID.
- Approvals record decisions only. External execution requires a separately connected and tested executor.
- Preserve the Android app and the existing eBay Manager OAuth/backend.
