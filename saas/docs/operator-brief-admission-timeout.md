# Verified opening: database execution deadline

Paid operator briefs remain disabled until the cutover evidence and activation
requirements in [operator-brief-cutover.md](operator-brief-cutover.md) are met.
This qualification adds tests and a release requirement; it does not install an
opening, change limits, activate a provider or change database configuration.

## What must enforce the bound

The reserve, settle and opening-installer functions declare
`SET statement_timeout = '15s'`. PostgreSQL starts the statement timer when it
receives the outer command. Entering a function does not arm a new timer for an
already-running command. A local PostgreSQL 17.6 test demonstrated a successful
16-second reservation despite that function declaration when the outer timeout
was longer. A clock check inside the function cannot preempt a running scan,
trigger or lock wait. An HTTP AbortSignal is not proof of database rollback.

The smallest supported configuration is **PostgREST transaction-setting hoisting
with `statement_timeout` included**. PostgREST applies that function setting
before the main query. Its documented default includes
`statement_timeout,plan_filter.statement_cost_limit,default_transaction_isolation`.
The setting is `db-hoisted-tx-settings`, environment equivalent
`PGRST_DB_HOISTED_TX_SETTINGS`, or database configuration
`pgrst.db_hoisted_tx_settings`. Preserve all existing entries. If the deployed
gateway already has this effective configuration, no configuration change is
needed; obtain evidence rather than assuming the default.

This bounds the main database statement at 15 seconds and retains the existing
five-second timeout for each lock acquisition. It is **not** a 15-second HTTP
response guarantee: connection-pool acquisition, transaction setup/commit and
network delivery have separate bounds. SupabaseStore's request deadline remains
20–60 seconds (30 seconds by default). Any timeout, disconnect or missing exact
acknowledgment remains uncertain; the client must not infer rollback, release a
hold, issue a provider request, or retry admission. Reconcile durable state using
the same workspace/job/call/fingerprint. Deterministic Commander remains usable.

For the administrator-only opening installer, send separate protocol commands on
one database session: `BEGIN`, then `SET LOCAL statement_timeout = '15s'`, then
the exact reviewed installer call, then `COMMIT`. On an error, roll back. A lost
commit acknowledgment requires read-only reconciliation. Do not rely on a SET
embedded inside the installer or change shared role-wide timeouts. The service
role remains unable to execute installation.

## Reproducible local qualification

The atomic-usage CI job runs the real migrations on disposable PostgreSQL 17.6
and downloads the same checksum-verified PostgREST 14.5 used by the existing
staged-reader tests. No production service or provider is contacted. Locally,
supply `ATOMIC_USAGE_POSTGREST_BIN` alongside the existing disposable database
variables when running `npm --prefix saas/server/tests/atomic-usage test`.
The database must be empty and named `runvara_atomic_usage_test` on loopback.
The test refuses an absent or different gateway binary rather than skipping.

`atomic-usage-postgrest-timeout-cases.mjs` reuses the SQL suite's synthetic
opening fixtures. It starts two isolated gateways with hoisting explicitly on
and off, fresh local authentication, and no inherited gateway configuration.
Temporary triggers delay only selected synthetic workspaces after counter
writes. Production RPC definitions are unchanged. The cases establish:

- Anonymous admission and service-role installation are denied; governance off
  still denies dispatch.
- Concurrent HTTP requests cannot exceed the opening-adjusted allowance or
  reacquire dispatch for the same logical call.
- With hoisting off, the actual function can commit after 16 seconds: a negative
  control that must succeed to expose the original timeout assumption.
- With hoisting on, the actual delayed admission returns SQLSTATE `57014` around
  15 seconds. Reservation and counter updates roll back together; the opening
  balances and another tenant's rows remain unchanged.
- A concurrent same-workspace waiter reaches SQLSTATE `55P03` around five
  seconds, another tenant progresses, and the delayed holder rolls back.
- A deliberately lost acknowledgment after a real HTTP commit remains uncertain
  in SupabaseStore, with one submission and a retained hold. A synthetic
  duplicate cannot regain dispatch.
- A separate outer 15-second administrator deadline rolls back the opening and
  seeded counters together, leaving governance disabled.

These are bounded cancellation/transaction tests, not production latency or
capacity certification. Local earlier scale tests over 100,000 synthetic legacy
rows (about 28.8 MB plus 100,000 other-tenant rows) measured approximately
1.39–1.46 seconds for an uncontended admission; five concurrent same-tenant
admissions completed in approximately 1.84–7.64 seconds. They were three-sample
local measurements, not a production percentile. Each opening admission hashes
legacy history twice. History growth or queueing may reach the enforced deadline;
that must safely deny/leave uncertainty, never bypass accounting.

## Evidence required before a release or paid cutover

1. Read-only identification of the actual database and gateway versions, the
   effective hoisting configuration (including environment/database precedence),
   and the installed function settings/definitions. `SHOW statement_timeout` in
   an unrelated SQL console is insufficient.
2. Run this HTTP qualification against the exact proposed gateway version and
   configuration in isolated staging, retaining response codes, elapsed times,
   rollback/counter checks and cleanup evidence. Also verify the application and
   gateway pool/network deadlines and no automatic mutation retry. Do not install
   delay triggers or run mutation probes on production.
3. If configuration is missing or overridden, approve the smallest addition of
   `statement_timeout` to the effective hoisted list, with supported config
   reload/restart and preserved existing entries. Inventory other RPCs declaring
   function timeouts: hoisting affects them too. If the managed gateway does not
   expose a supported setting/version, keep paid activation off and obtain a
   supported configuration path; do not silently fall back to function-local SET.
4. Keep all original verified billing, historical-uncertainty, dispatcher-drain,
   exact policy/model/pricing and finite allowance requirements. A fast query or
   successful timeout test supplies none of that commercial evidence.

Rollback starts by disabling paid dispatch; retain all openings, holds, receipts
and counters. Reverting configuration must not make the unverified timeout path
eligible for activation. No automatic cleanup/refund of an uncertain reservation
is introduced.

References: [PostgreSQL statement and lock timeouts](https://www.postgresql.org/docs/17/runtime-config-client.html#GUC-STATEMENT-TIMEOUT),
[PostgREST hoisted settings](https://docs.postgrest.org/en/stable/references/transactions.html#hoisted-function-settings),
[PostgREST configuration](https://docs.postgrest.org/en/stable/references/configuration.html#db-hoisted-tx-settings).
