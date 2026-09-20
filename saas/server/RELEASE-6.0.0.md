# Runvara 6.0.0 — existing production completion

This release extends `ajay1980-hue/Packsmart-hub` and the existing Render
`packsmart-ops` service. It preserves the Supabase database, signed-cookie
authentication, encrypted credentials, Shopify/eBay connections, current
economics, orders and approvals. The Android app, Shopify theme and eBay Manager
are unchanged.

## Changes

- Durable Exception Centre, evidence-backed opportunities, editable decision
  memory with superseded versions, actual/estimated value, and work evidence.
- Fifteen Commander/specialist definitions, concurrent analysis, disabled-agent
  policies, observation/recommendation/preparation levels, conflict detection and
  owner proposals. These are deterministic specialists: zero model calls and no
  claim that generated analysis executed an external business action.
- Autopilot ON/OFF, per-rule permissions, intervals, daily limits, zero spending,
  durable claims before work, restart recovery, and a once-daily morning brief.
- Approval modification retains revisions; a stale revision cannot be approved.
  Only an owner can decide. Approval records a decision; external execution
  remains blocked because no financial/publishing executor is connected.
- Initial-password enforcement on the API, viewer mutation denial, session
  revocation on logout, JSON/prototype validation, request/Commander limits,
  tenant-scoped controls, and spreadsheet formula neutralisation in CSV exports.
- Conditional primary-state writes reject stale replica updates. New workspaces
  are created atomically with their unique login identity. Reporting failures
  cannot erase committed state or hide other table diagnostics. Login reads the
  authoritative state rather than depending on a healthy reporting mirror.
- Source sync preserves manual order costs, historical orders and last known
  data on failures. Authentication failures stop automatic retry. Transient reads
  retry once. Incomplete bounded commerce reads surface coverage failures.
- Cockpit prioritises exceptions and approvals before the brief and operations;
  all new controls use the existing authenticated API. Browser economics are no
  longer saved under shared tenant-independent keys.

## Database rollout

Apply `supabase/migrations/20260920201552_runvara_control_and_reporting.sql`
before deploying this server. It is already applied to the existing production
project for this release. It removes the incorrect unique-SKU reporting
constraint without deleting rows, preserves tenant FKs and RLS, and grants the
new atomic creation function to `service_role` only. Existing workspaces require
no primary-state rewrite in SQL; the server upgrades their existing JSON state.

## Operations and limits

Autopilot defaults ON for Packsmart customer zero and OFF for future workspaces.
It ticks every 60 seconds while the Render process is running. Rules execute
only when their configured interval/permission permits; there is no external
spend. The daily brief runs at the first eligible tick after 07:00 Europe/London,
including catch-up after restart. This is not an uptime guarantee on a sleeping
or stopped Render service. Reporting date windows retain their existing UTC
basis. Each monitor records whether source coverage prevented completion.

The implementation monitors connected commerce and recorded order follow-up.
Customer inboxes, competitor feeds and paid discovery sources are not connected;
it does not claim to read enquiries, send replies or realise financial savings.
Financial and time savings remain unknown until independently verified.

Primary state retains history. Large legacy brief snapshots are copied in full
to the existing `operations_briefs` table before primary state stores their
summaries and archive pointers. Archive failure prevents compaction; later
reporting refresh cannot replace archived details with a summary. Authenticated
`GET /api/briefs/:id` retrieves the complete snapshot within its workspace.
New morning briefs store concise aggregates, not repeated full catalogues.
The cockpit pages recent evidence while the authoritative record is kept.
At higher SaaS volumes, move other long histories to a
transactional archive with verified retention before introducing any pruning.
Reporting tables remain secondary; their refresh can be degraded independently
and must not be used to override authoritative login or business state.

Production now refuses file persistence. The existing Supabase environment
variables remain required. CI container smoke uses `NODE_ENV=test` deliberately;
this does not weaken the production guard. Runtime requires no npm packages;
jsdom is pinned as a development-only dependency for repeatable cockpit tests.

## Verification

Run `npm --prefix saas/server ci --ignore-scripts`, then
`npm --prefix saas/server run check`, `npm --prefix saas/server test`,
`node saas/tests/saas-guard.test.cjs`, and
`node --test ebay-manager/tests/ebay-manager.test.js`.

Tests cover real HTTP permissions and tenant isolation, approval revisions,
Commander routing and policy, durable file restart, conditional Supabase saves,
atomic identity contracts, independent reporting failures, morning timing,
Autopilot restart recovery, retry limits, source-data preservation and actual
API-backed cockpit forms. DOM tests do not establish visual mobile layout;
responsive CSS still needs a production browser review.

For rollout evidence, compare `/api/health` version and commit with the pushed
Git commit, compare served static asset hashes, inspect the existing Supabase
workspace and reporting counts, and inspect GitHub Actions. Do not change
working credentials or create a second Render service to perform this rollout.
