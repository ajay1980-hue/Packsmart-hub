# Packsmart Ops

Packsmart Ops is the private customer-zero operations cockpit for Packsmart Solutions Ltd and the foundation for a future multi-tenant SaaS.

## Production capabilities

- Secure owner login with signed, expiring HTTP-only cookie sessions, CSRF/origin checks, login throttling and forced initial password replacement.
- Workspace-scoped users, state and APIs with server and tenancy test coverage.
- Supabase persistence using a server-only service-role credential. Workspace state is stored losslessly and mirrored into normalized reporting tables.
- Read-only Shopify Admin GraphQL sync for products, variants, SKUs, prices, inventory, images, status and recent orders.
- Safe repository Shopify snapshot fallback when the live Admin connection is unavailable.
- Read-only adapter for the existing Packsmart eBay Manager; the existing OAuth backend is reused and the expected seller account is verified before data is accepted.
- True per-SKU economics for landed, packing, delivery and channel costs, plus margin visibility and profit guard recommendations.
- Human approval records for supplier orders, advertising spend, refunds, major price changes, paid services, risky marketplace actions and social-commerce publishing.
- Deterministic daily operations brief covering sales, orders, stock, margins, pricing, SEO, customer-service proxies, approvals and recommended actions.
- Prepared social-commerce channel registry for Facebook and Instagram Shops, TikTok Shop, Pinterest Shopping, Google and YouTube Shopping, and WhatsApp Business.
- Prepared Stripe Starter, Growth and Pro architecture. Packsmart customer-zero is always internal/free, and checkout is disabled by default.
- Feature-flagged beta account/workspace onboarding. It stays closed until customer-zero is stable.

## Safety contract

- Approving a request records the decision and audit event; it never executes an external action.
- Shopify and eBay synchronization are read-only.
- Marketplace OAuth refresh tokens, Supabase service-role credentials, Stripe keys and AI provider keys never enter browser code or browser storage.
- Social publishing, advertising changes, promotions, refunds, supplier orders and financially sensitive writes remain approval-gated.
- The Android app and existing eBay OAuth/backend are outside this deployment and must remain unchanged.

## Local verification

From the repository root:

```sh
node --check saas/app.js
node saas/tests/saas-guard.test.cjs
npm --prefix saas/server run check
npm --prefix saas/server test
docker build -f saas/server/Dockerfile -t packsmart-ops:test .
```

The production server entry point is `saas/server/server.mjs`; `GET /api/health` reports persistence and security readiness without returning secret values.
