# Packsmart Ops — customer-zero SaaS pilot

This folder is the first productized operations layer built around real Packsmart workflows.

## What version 1 does
- Loads the existing Packsmart Shopify catalogue snapshot from `ebay-manager/shopify-products.json`.
- Gives Packsmart a single mobile-friendly command centre.
- Provides per-SKU landed-cost, packing-cost and delivery-cost entry stored locally for pilot testing.
- Calculates contribution £ and contribution margin before channel/payment fees and tax.
- Surfaces low-margin and missing-cost priorities.
- Includes configurable safe automation rules.
- Includes an explicit Approval Centre for money/risk-sensitive actions.
- Reports only integrations that are actually present in the Packsmart codebase.
- Leaves the Android app and existing eBay OAuth/backend untouched.

## Approval policy
The commercial SaaS must preserve human approval for:
1. spending money;
2. placing supplier orders;
3. issuing refunds;
4. major price changes;
5. other risk-sensitive external actions.

Advisory calculations, drafts, monitoring and alerts can be automated.

## Productization path
### Phase 1 — Packsmart customer zero
Prove which operational views, profit controls and automations save real time or prevent loss.

### Phase 2 — SaaS foundations
Add server-side authentication, tenant/workspace IDs, Postgres/Supabase persistence, audit log, encrypted integration credentials and Stripe subscriptions.

### Phase 3 — first beta customers
Add guided Shopify/eBay connection, roles, onboarding, billing tiers, usage limits and support tooling.

### Phase 4 — AI operations layer
Add server-side model calls for daily briefs, listing/content drafts, anomaly explanations and decision support. Never expose provider keys in the browser.

## Data model direction
- `workspaces`: one customer/business per workspace.
- `users`: members and roles.
- `connections`: encrypted platform connections scoped to workspace.
- `products` / `variants`: normalized catalogue.
- `economics`: landed cost, packing cost, delivery cost, channel fees and margin floors.
- `automation_rules`: enabled rules and thresholds.
- `approval_requests`: proposed risk-sensitive actions and decision history.
- `audit_events`: immutable record of recommendations, approvals and executions.
- `subscriptions`: plan, status and usage limits.

## Security rules
- OAuth refresh tokens, Stripe keys and AI provider keys stay server-side only.
- Every server query/action must be scoped by authenticated workspace ID.
- Risk-sensitive writes require an approval record before execution.
- Public/browser code must never contain supplier credentials, marketplace secrets or private API keys.

## Current limitation
The pilot is intentionally single-business and browser-local for editable economics. It is a functional validation layer, not yet a multi-customer production SaaS. Marketplace-specific net-profit decisions should continue to use the existing eBay commercial engine until channel fee models are moved into the shared SaaS backend.
