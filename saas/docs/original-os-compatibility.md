# Original OS combined compatibility rehearsal

Prepared locally on 2026-10-07 above the tested PR81 local chain `8bdb685296fbe43a3edffcb55fb374180223a390`. This is compatibility evidence only: it is not a release branch, current-main ancestry claim, remote CI pass, deployment permission or completion of the original autonomous OS. All production work remains held.

## Sources and conflict resolution

The individual source branches and their evidence remain intact. This separate worktree replayed, in order:

1. Graph qualification correction `8412bec351d588071e210fcccd8b700d147e6794`, locally `acf832d`.
2. Explicit owner restriction gate `b7fbcb783c0676ceda08fac51c90deae3f2bd20a`, locally `0c533b9`.
3. Legacy order field semantics correction `58572660b000954bf981e9bff20dfccb3dc97d20`, locally `c6e0b46`.
4. Inactive production-health verifier `8121482a1463b6901422684008a2c3966bde292b`, locally `e07448a`.

Only `saas/server/package.json` conflicted. Resolution retained the PR81 syntax-check command and added `objective-dispatch-policy.mjs`; no configured check was removed. App, index and server changes merged automatically and were reviewed against the base: they add only objective restriction status/edit controls, its explanatory paragraph, and current-actor/audit fields on objective configuration.

The later provenance correction and inactive verifier replayed without conflicts. The correction's nine files outside app/index/server are byte-identical to its source; differences in those three overlapping files retain only the earlier objective rendering and actor/audit wiring. Stable patch IDs match for each latest source/replay pair. Graph files and objective gate implementation remain byte-identical to their individually reviewed sources. All three verifier files are byte-identical to its source.

Imported-order evidence and catalogue qualifications, connection-health and activity semantics, static revalidation, reporting CAS, outcome publication, all inherited browser workflows and existing business data were preserved. No SQL was changed. The actual applied migration filenames remain `20261007074031_reporting_status_cas.sql` and `20261007100823_business_outcome_publication.sql`; the old rehearsal filenames were not restored or reapplied.

## Interaction regressions

Two tests use the existing real connection-write dispatcher, synthetic IntegrationService transport, and mocked Supabase CAS adapter:

- A finite covered catalogue margin remains a per-variant estimate. Exact GBP/USD retained-order subtotals remain separate, missing amounts remain unknown and imported qualified-profit counts remain zero. Copying these application results or a positive approval `financialImpact` onto a write cannot satisfy an owner financial restriction. The write stops before provider preparation and any dispatch claim; catalogue/order/cost records remain unchanged.
- A typed outcome with a valid synthetic trusted publication boundary remains a qualified historical contribution measurement in the outcome consumer. Legacy graph reviews remain unqualified, with zero verified graph outcomes and no learned prior. Copying the qualified historical measurement onto the write cannot authorize profit-first execution. Blocking dispatch does not erase descriptive outcome history.

The imported fixture initially created orders at the exclusive period endpoint; it was corrected to use a timestamp one minute before derivation. The source period contract was unchanged. Both new cases pass.

The later actual-mapper regressions establish that Shopify's positive total-difference refund field and current-tax alias remain inspectable without being called a provider refund or original tax. Across all supported providers, only an explicit recorded refund status supplies an operational review cue; it does not establish payment or completed-action evidence. Stale client flags and numeric refund differences cannot bypass that rule. The cache-v3 regressions retain source orders, owner measurements and history, reconcile either earlier calculation version once, and make the next unchanged bootstrap read-only. Existing mapper and dispatch cases establish the unchanged financial-authority boundary; independent review found no need for another duplicative interaction test.

## Verified locally

- Final combined code, including the inactive verifier, on Node **22.23.3**: **1,177 passed, 0 failed, 0 skipped**, including all security, tenant, dispatch and DOM suites.
- Full configured syntax checks, SaaS guards for 15 fixture products and whitespace checks passed.
- Independent read-only review accepted final corrected-source parity and the financial-authority boundaries; **250 focused corrected-source tests** and **28 synthetic verifier tests** passed with zero failures/skips.
- Actual PostgreSQL **17.6**: **198 passed**, zero failed/skipped/cancelled: atomic usage **41**, automation retention **8**, objective jobs **51**, outcome publication **25**, reporting CAS **73**.
- PostgreSQL ran only in four fresh disposable localhost clusters, with 160 connections available. All four were verified stopped by absent postmaster PIDs, `pg_ctl` status and a refused connection to the test port.

The fresh PostgreSQL rerun completed on clean `c6e0b46`. The subsequently preserved verifier adds only its module, synthetic tests and documentation; all PostgreSQL inputs and SQL remain unchanged. Those gates validate existing database contracts; the dispatch-policy race tests use mocked PostgREST CAS, not a new live PostgreSQL/PostgREST policy integration proof.

Existing locked server dependencies were installed offline with scripts disabled. The test-only PostgreSQL driver's offline install encountered an uncached dependency. The unchanged suites instead used an existing installed `pg` 8.16.3 via `NODE_PATH`, after verifying a byte-identical lockfile and all 14 installed dependency versions/integrity metadata. No external package retrieval occurred. Package-lock files remain unchanged.

## Boundaries that remain

The owner gate is **API-only activation** for the exact Shopify `product_content` scope. There is no activation UI, qualified-financial executor or Commander execution path. Legacy objectives remain preparation-only. An explicitly enforced objective with the existing default `profitFirst:true` is evidence-blocked. An owner may permit an otherwise exactly approved manual content write only when they explicitly configure profit-first false and no financial/stock constraint. This is not a profit optimizer or proof of objective progress.

The production-health verifier is inactive preparation only. It has no runtime import, CLI/npm/workflow activation, network adapter or global-fetch fallback. Its tests construct in-memory responses and controlled promises; the production URL is fixture metadata and was never contacted. Preserving this source does not activate verification, clear browser permissions or provide production-health evidence.

After activation, rollback must preserve the restriction reader and denial behavior. Never revert to an older executor that ignores policies, silently relax owner limits, or clear uncertain claims to permit replay. Individual stage rollback and interpretation details remain in `objective-dispatch-policy.md` and `business-graph-outcome-evidence.md`.

The expected Playwright Chromium executable is absent and Docker is unavailable. Real responsive browser/container gates, exact-head remote CI and authenticated Packsmart production acceptance were not run. No migration, remote mutation, credential/permission change, live policy activation, provider action or customer outcome was performed. Further rollout must follow the eventual accepted individual-stage ancestry; this combined rehearsal is not a shortcut around those gates.
