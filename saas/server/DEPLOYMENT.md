# Packsmart Ops deployment contract

The SaaS server is packaged as a single Node 22 container and serves both the Packsmart Ops cockpit and its API.

## Container
Build from the repository root:

```sh
docker build -f saas/server/Dockerfile -t packsmart-ops .
```

The service listens on `PORT` (default `8787`) and exposes `GET /api/health` for platform health checks.

## Required production environment
Do not commit any values below.

- `PACKSMART_ADMIN_EMAIL` — customer-zero owner email.
- `PACKSMART_ADMIN_PASSWORD` — strong initial owner password.
- `SESSION_SECRET` — long random secret used to sign sessions.
- `CREDENTIALS_KEY` — separate long random secret used to encrypt integration credentials.
- `SUPABASE_URL` — dedicated Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY` — server-only service-role key.
- `APP_PUBLIC_URL` — public HTTPS URL for the SaaS.

Before enabling Supabase persistence, apply `saas/server/supabase/schema.sql` in the dedicated project.

## Optional Stripe billing
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_STARTER`
- `STRIPE_PRICE_GROWTH`
- `STRIPE_PRICE_PRO`

Configure the Stripe webhook endpoint as:

`POST <APP_PUBLIC_URL>/api/webhooks/stripe`

The server verifies Stripe webhook signatures before updating subscription state.

## Production rules
- Use HTTPS only at the public edge.
- Use Supabase persistence in production; the JSON file store is development fallback only.
- Never expose the Supabase service-role key, Stripe secret key, session secret or credential key to browser code.
- Keep the five Packsmart risk action classes approval-gated.
- An approved request does not execute externally until a separately tested executor exists for that action type.

## Customer-zero cutover
On first authenticated sign-in, the cockpit migrates existing browser-local Packsmart economics and automation preferences into the server workspace. Subsequent edits mirror to the authenticated workspace. `Sync from cloud` can restore a device from the server copy.
