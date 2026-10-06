# Runvara Business OS: incremental production rollout

Audit baseline: `main` `f1bb1493ff4b40e95aa5a0f80bc5a10dc56bbcd3`, 6 October 2026.
The existing `packsmart-ops` service, Supabase tenant persistence and all approval/security boundaries remain the production architecture. This is a staged implementation, not a claim that the entire autonomous OS is complete.

## Existing capabilities to extend

- `business-state.mjs`: tenant-sanitized canonical business metrics; extend relationships by referencing existing entities, not copying catalogues.
- `opportunity-engine.mjs`, `control.mjs`, `revenue-engine.mjs`: deterministic opportunities and durable approval/experiment pathways. Reconcile their identities before building another queue.
- `growth-council.mjs`, `agents.mjs`, `portfolio-engine.mjs`, `execution-plan.mjs`: specialist deliberation, value/evidence ranking, explicit capacity and non-executable approval gates.
- `learning-engine.mjs`, `impact-engine.mjs`: verified-outcome-only learning and contribution accounting. Preserve verified aggregates when detailed records archive.
- `agent-ops.mjs`, `ai-economics.mjs`, `ai-provider.mjs`: durable tenant jobs, reservations, plan ceilings and optional metered summaries. Provider-independent adapters/objective planning remain incomplete.
- `connection-centre.mjs`, `connection-doctor.mjs`, `connection-intelligence.mjs`: sync controls, bounded recovery, owner intervention and connection health.
- `store.mjs`: revision-guarded durable state, normalized mirrors, archival, scheduler cache. No replacement persistence or relaxed grants.
- Existing Command Centre, Revenue Engine, Approval Centre and Operator Fleet are the UI surfaces to refine.

## Stage 1: reduce waste and enforce existing limits

1. Exclude synthetic mirror timestamps from content fingerprints for products, variants, economics, cost profiles, automation rules, orders and order financials. Retain source timestamps and real values; retry failed mirrors; rebuild caches on restart.
2. Back off idle/failing durable queue claims, retaining prompt local enqueue wake and bounded remote-producer latency.
3. Treat an explicit zero daily AI unit limit as zero; never allow caller-supplied job estimates to undercut trusted job costs.
4. Preserve Commander approval/blocked posture in final work history.

No new recurring worker, model call, crawl, database table, service or paid provider is introduced. Business events and successful writes remain the existing triggers. Primary revision-guarded persistence is unchanged.

Expected usage reduction is a code-derived bound, not a billing promise: an idle 2.5-second queue loop currently issues 34,560 claim calls/day/instance. Bounded idle backoff should reduce this substantially, while catalogue rows with unchanged business content cause zero warm-cache mirror upserts rather than a full rewrite on every save. Cold processes still verify/write initial mirrors; identity reads and authoritative state commits remain.

## Subsequent stages (not delivered by Stage 1)

2. Add bounded, privacy-safe usage measurements and enforce per-tenant/provider request, token, crawl and retry reservations before work. Distinguish missing telemetry from zero consumption; retain durable atomic budget enforcement across replicas.
3. Reconcile existing business entity references, opportunity identities and verified long-term outcomes. Add owner objectives with hard limits subordinate to current approval/security policy. No invented margin, cost or attribution.
4. Extend Commander into bounded plans with explicit dependencies and specialist ownership. Route through capability/health/cost/plan-aware providers; unconfigured adapters remain unavailable, never silently connected.
5. Tie allowed execution to the existing Approval Centre, persist proposed action/evidence/approval/result, and measure verified commercial outcomes. API first; external computer execution only through an approved bounded provider interface.
6. Refine Runvara Command and health/usage views using real, timestamped data. Unknowns remain visible. Validate interruption, retry, repeated-click and mobile flows.

## Gates for every stage

Run syntax, guard, full security/tenant/regression suites and affected UI checks. Review the exact final diff and CI head. Create a draft PR before merge. Deploy only verified safe scoped changes, then confirm production commit and health. Preserve Android PR62/63 and concurrent opportunities work untouched.

Rollback is a revert of the scoped stage commit on the same main/service; no schema replacement or alternate app. No newly paid/credentialed capability is activated without its required owner action.

### Stage 1 verification record

- Baseline main suite: 200/200 passed.
- Stage 1 suite: 215/215 passed; syntax and Phase 1 guard checks passed.
- Focused mirror coverage includes real source-only timestamp changes, failed-write retry, cold cache and two-replica A→B→A restoration. Cache trust is invalidated on foreign revisions or uncertain final reporting commits.
- Deterministic queue simulation: 1,443–1,803 polls in the first uninterrupted idle day per replica; 1,440–1,800/day steady-state. This excludes request latency, restarts, manual ticks and local enqueue wakes.
- No new queue is created. Remote enqueue has up to 60 seconds additional idle scheduling delay; local enqueue/retry wakes immediately. Stop prevents future polls, not cancellation of active business work.
- Live pre-change health: HTTP 200, `productionReady:true`, Supabase, version 6.15.2 and baseline commit above.
- Local mobile test initially blocked by missing Playwright browser; CI must supply the browser/container verification before release.
- Container build unavailable locally (Docker absent); require the existing CI Docker build and health-smoke gate.

### Stage 1 production evidence, 6 October 2026

- [PR64](https://github.com/ajay1980-hue/Packsmart-hub/pull/64) merged as `552827ece04a88c4dac3d5a63ce33dc22ef09712` after SaaS and Android workflows passed.
- [SaaS CI 37494641874](https://github.com/ajay1980-hue/Packsmart-hub/actions/runs/37494641874) passed all stages, including Node22 tests, browser mobile/desktop checks, Docker build and container health smoke. This resolves the local browser/container verification limits for that change.
- Render auto-deploy was configured but no build or deployment event arrived. Verified no pending deployment and exact main, then triggered one deployment of the existing service, without clearing cache or changing service settings.
- Deploy `dep-db2i1349v7es73c8bp20` became live at 16:24:12 UTC. `/api/health` returned HTTP200 with exact commit552827e, productionReady, primary persistence, authentication, credential encryption and state-size checks all true.
- Live `/app.js` bytes exactly matched the merged source. SHA256: `f5dae34bdb8ea2a936b488a7b476ccbdfb7bc0ee0111e15324f46a692278e5e9`.
- The post-deploy log query was unavailable due to Render's Loki502/503 response. Do not describe this as an empty error log. Financial bandwidth savings are not yet measured.

## Stage 2: inspect recorded business relationships

An on-demand tenant-scoped graph projection now links the existing authoritative records for products/variants, exact recorded SKUs, cost profiles/suppliers, supported channels, eBay listings, orders/lines, opaque customer identities, campaigns, opportunities, approvals, experiments and work outcomes. It does not copy the catalogue or introduce a second persistence system. Opaque identities and source pointers allow relationships to be traced; source records remain authoritative.

This is a bounded projection of retained records, not a complete persistent graph or archive ledger. Leads, competitor observations, integration health, full inventory/fulfilment history, discount attribution, canonical opportunity reconciliation and durable cross-archive outcome aggregation remain later work. Unknown mappings are visible; no generated-SKU guesses or implied campaign attribution are accepted. Historical eBay line SKU provenance is ambiguous, so those cost links are withheld. Outcome counts mean records, not deduplicated financial value.

- Authenticated `/api/business-graph` defaults to a small summary. Detail is opt-in, capped at200 nodes/400 edges,50 rows per source and2000 scanned records. Caller parameters cannot widen limits or select another tenant.
- Existing Command Centre gains a collapsed inspector with explicit loading/error/retry states. It fetches the summary only when clicked; opening/closing creates no recurring requests.
- A delayed401 from an earlier session cannot sign out a newer authenticated session. Repeated clicks, failure/retry and logout/login interruptions have DOM coverage.
-236/236 stage-specific tests pass locally, including21 graph tests; syntax and guard checks pass. Objective-module experiments are excluded from this stage's commit/test count.
- Synthetic5000-product/100-variant-per-product input: summary scanned48 records, returned about3KB, and took about4ms on this cloud executor. This is a local synthetic benchmark, not a production capacity guarantee.
- A dedicated CI browser test exercises the actual app/server at320,390 and1200 pixels, checks overflow and zero automatic graph fetching. Local Chromium cannot launch under executor socket restrictions; do not weaken that CI gate.

### Stage 2 production evidence

[PR65](https://github.com/ajay1980-hue/Packsmart-hub/pull/65) merged as `2288af6daf141ae6aeca62d1a2ddd3b2697de4f8`. [CI37497487076](https://github.com/ajay1980-hue/Packsmart-hub/actions/runs/37497487076) passed full tests, existing onboarding checks, the new actual graph UI browser flow at320/390/1200 pixels, Docker and health smoke. Existing Render deploy `dep-db2iba60tbcc739c04e0` became live at16:46:12 UTC after confirming auto-deploy had not queued. Health returned exact commit2288af6 and productionReady:true. Unauthenticated graph access returned401/AUTH_REQUIRED. Authenticated behavior was exercised against synthetic tenant data in CI, not by modifying live customer records.

## Stage 3: structured planning objectives and limits

Definitions persist in existing tenant state as `businessObjectives`, with at most50 entries, generated identities, optimistic revisions, audit events, UTC windows and strict finite metric values. Owner/admin CRUD follows existing authentication/CSRF and mutation locks. Monetary objectives require currency; unknown baseline stays null; explicit zero budgets stay zero. Targets cannot contradict their own margin/advertising/stock limits.

Existing AI Team gets on-demand load/create/edit/pause/cancel controls. This is explicitly labelled a planning foundation: definitions do not yet globally govern existing executors or launch actions. Editing retains exact UTC dates, valid currencies and numeric precision. Stale loads cannot replace newly saved goals, repeated submissions coalesce, and changed revisions require reload.

The evaluator checks bounded internal preparation against known baseline, source references, remaining time, cost/currency, capacity, margin, stock and advertising limits. Evidence is supplied/unverified and references are not yet resolved. A conditional ready result is never execution authority. Every risky action or positive spend remains approval-required; external execution is always false. No model call, provider request, recurring job, purchase or external write is introduced.

Verification includes module, API, tenant/CSRF, persistence/audit, zero-budget and contradiction cases; DOM create/edit/cancel, missing/cross-currency precision and stale-session/load cases. The real mobile/desktop CI flow additionally saves and edits only synthetic objectives. No Packsmart objective or spending limit is created on the user's behalf by deployment.

### Stage 3 production evidence

[PR66](https://github.com/ajay1980-hue/Packsmart-hub/pull/66) merged as `652953999734bba2a71caf215bd9e5c8d18680ff` after explicit continuation approval. The first browser run correctly rejected a test fixture whose browser origin differed from its configured public URL. Only the fixture origin was corrected; CSRF/origin protections were not weakened. [CI37500404701](https://github.com/ajay1980-hue/Packsmart-hub/actions/runs/37500404701) then passed all tests, browser CRUD, Docker and health checks. Existing Render deploy `dep-db2iod2jnfac73ceh8e0` became live at 17:13:50 UTC. Public health confirmed the exact commit and productionReady:true. No live customer objective was created during verification.

## Stage 4: one opportunity identity and trustworthy decision evidence

Command's opportunity queue now projects the existing durable opportunity IDs instead of creating a competing set of aggregate pricing/stock IDs. Verified posture is recomputed from the matching, reciprocal, same-tenant completed experiment; raw posture flags alone cannot confer verification. The Investigate control opens that original record without creating approval requests or executing anything. Existing per-unit estimates stay separate from unknown future contribution forecasts.

Dismissed, resolved, excluded, rejected and absent conditions do not reappear through an aggregate fallback. Ambiguous duplicate identities/fingerprints are suppressed instead of choosing whichever weaker permission appears first. Existing legacy aggregate behavior remains only where no authoritative opportunity collection exists. Projection/queue output is bounded to 100/50 rows; source scans use the existing bounded workspace snapshot so later duplicate/dismissal evidence is not missed.

Portfolio, council, learning and impact use consistent tenant evidence boundaries. Foreign or malformed scope markers, ambiguous source IDs and conflicting duplicate measured values cannot be relabelled as local verified evidence. Historical contribution remains historical; cost/hour comparisons are explicitly not forecasts or measured ROI. Durable outcome history across archives remains a later stage.

Preparation planning now requires known cost, effort and capacity, preserves meaningful fractional values, blocks positive spend without approval, accounts for cumulative hours and caps a plan at 25 returned steps. No queue jobs, time reservations, payments or external writes are committed by this projection.

Validation: 298 stage-specific server tests passed locally, plus syntax, guards and independent review. Existing positive experiment fixtures now include reciprocal opportunity IDs; the revenue-only assertion was strengthened from zero contribution to unknown/null. New tests cover malformed/foreign scope, duplicate weaker permissions, original-record UI navigation, fractional costs, unknown capacity and cumulative limits. The existing browser CI gate additionally exercises the real Investigate navigation on mobile and desktop. Rollback remains a scoped code revert, with no schema or customer-data change to undo.

### Stage 4 production evidence

[PR67](https://github.com/ajay1980-hue/Packsmart-hub/pull/67) merged as `eb1021fe589937aba2c7b2e0b25d3a7556215259`. [SaaS CI37503671882](https://github.com/ajay1980-hue/Packsmart-hub/actions/runs/37503671882) and the Android workflow passed. Existing Render deploy `dep-db2j1qijnfac73cfn840` became live at 17:33:56 UTC. The 17:37:11 UTC health check returned the exact commit, ok:true and productionReady:true.

## Stage 5: inactive atomic provider accounting foundation

This stage supplies durable admission and settlement primitives in the existing Supabase database, a pure provider-routing policy module, and an on-demand platform-admin ledger inspector. Existing paid execution has NOT been switched to this boundary. No governance policy, provider credentials, provider connection, model pricing, recurring sync or paid capability is activated by this release. The admin view explicitly excludes legacy usage and provider invoices; unavailable telemetry never means zero spend.

### Admission and settlement invariants

- The existing workspace state row serializes policy changes, reservations and settlements across replicas. The RPC reads the authoritative policy server-side; callers cannot supply their own balance, price or ceiling.
- A running matching tenant/job/worker/attempt lease and a current route deadline are required. A stable logical call key deduplicates attempts. An existing reservation never grants a second dispatch, including after an ambiguous response.
- Tenant and provider month windows hold request, input/output/total-token and cost exposure before dispatch. Zero caps mean zero. Exact NUMERIC integer aggregates prevent cumulative JavaScript/bigint overflow; the JavaScript summary refuses values it cannot represent safely. Settlement acknowledgements preserve larger exact costs as canonical decimal strings (number|string contract), never rounded numbers.
- Immutable pricing snapshots determine settlement. Unknown outcomes retain the complete hold. Only trusted proof of no dispatch permits cancellation. Verified overrun records all measured usage and blocks subsequent calls for that provider; observed usage is never clipped to the reservation.
- Settlement and legacy usage-ledger insertion occur in the same transaction and retain the admission month. Idempotent receipts cannot be contradicted. No prompts, response text, keys or credentials are stored in these accounting tables.
- Both new tables have RLS and no public/anon/authenticated access. Existing service_role alone receives the minimum table/RPC privileges; reservation identity, pricing and bounds are not updateable. RPCs are SECURITY INVOKER with empty search_path. The existing estimated_cost_usd column only widens precision, preserving scale and records.

### Usage and cutover gates

There is no periodic work. An explicit inspector click authenticates with the existing compact identity projection and performs one bounded query of at most 130 compact window rows (129 accepted scopes plus overflow sentinel), without fetching workspace snapshots or full ledgers. Each eventual governed provider call requires one reservation RPC and one settlement RPC, with a maximum of two window rows updated per phase and one reservation row; complete settlement appends one existing usage record. Uncertain reconciliation is explicit rather than a retry loop. This is expected logical operation volume, not a claim that provider traffic is already governed or that database billing has been measured.

The routing module is deterministic and makes no provider calls. It uses trusted, fresh capability/configuration/health/credential/pricing/quality evidence and tenant limits, and returns a proposal only. Registered provider names are supported routing envelopes, not connected accounts or activated adapters.

Before enabling a paid path: verify platform-controlled allowlists/prices and plan ceilings; establish a clean accounting boundary or independently verified opening balance; disable/drain the old paid path on every replica; wire a single dispatch through reservation and settlement; recheck the deadline/lease after reservation immediately before HTTP; cover timeout and reconciliation end to end; obtain any required credentials/owner approval. The supplied policy requires initial accounting attestation before its UTC month boundary. Never backdate an attestation to bypass that requirement. Mid-month migration/opening-balance support remains unfinished. Tenant owners must not control shared-key model rates or plan ceilings.

### Verification and rollback

Local PostgreSQL-compatible WASM checks supplement, but do not replace, the dedicated PostgreSQL 17.6 CI service. Its tests use a fixed disposable local database with no production secrets and exercise 100 independent concurrent connections, leases, duplicate calls, settlement races, exact arithmetic, tenant/RLS/grant denial and immutable snapshots. Production migration must wait for these tests and the ordinary SaaS/Android gates.

The production migration is additive apart from widening an existing decimal column; it does not rewrite customer business state or activate policy. Apply using the existing project's migration history, then verify table RLS, column-level grants and RPC execution grants before deployment. If release rollback is needed, revert application code while retaining ledger/history and widened precision. Never drop accounting records or narrow cost columns. Once any paid cutover occurs, disable that paid path first before rollback so legacy execution cannot bypass outstanding holds.

Stage 5 pre-PR checks: 348/348 local server tests, syntax and Phase 1 guards passed. Independent read-only review found no blocking issue for inactive release after the exact-cost DTO and admission-denial-code fixes. Browser launch is restricted locally; responsive and real PostgreSQL gates remain required in CI.

Stage 5 migration applied with explicit owner approval at 19:03 UTC, recorded by Supabase as version `20261006190318`; the source filename matches that history entry. SQL is identical to the 41-test PostgreSQL 17.6 CI run. Read-back confirms both tables enforce RLS, public/customer grants are absent, RPCs are SECURITY INVOKER with fixed search_path/timeouts, pricing is immutable, and reservation count remains zero.

### Stage 5 production evidence

[PR68](https://github.com/ajay1980-hue/Packsmart-hub/pull/68) merged as `6bcac35e11ca8b7b71431481fa797f95e7e546ec` after explicit owner approval of the scoped accounting-table/function access and deployment. Final PostgreSQL CI37516457079 passed41 concurrent/role tests; SaaS CI37516456660 passed348 Node tests, responsive browser flows, Docker and health smoke; Android37516456645 passed. The approved migration is recorded as20261006190318, and its repository filename matches that history entry. Security advisors show only the expected informational RLS-without-browser-policies notices for server-only tables.

Existing Render deploy `dep-db2ki1qjnfac73clks0g` became live at19:16:50 UTC. Health at19:18:16 returned the exact merged commit, ok:true and productionReady:true with persistence/auth/encryption healthy. An optional unauthenticated endpoint probe was cancelled and is not claimed as verified. Provider routing/cutover remains inactive; an empty governed ledger does not establish zero actual provider spend.

## Stage 6: objective-linked Commander preparation

See [the objective review release record](objective-review-rollout.md) for the scope, authority boundaries, bounded request/data budget, retry/lease behavior and verification requirements. Saved objectives now drive a requested deterministic specialist review through the existing queue, with reports persisted in job.result rather than expanding the hot business snapshot. Completion of the diagnostic does not authorize or imply readiness for commercial execution.

### Stage 6 production evidence

[PR69](https://github.com/ajay1980-hue/Packsmart-hub/pull/69) merged as `ce9c0edaa73ea3278fced6e4a1c57f8c960388dd`. Final CI passed405 Node tests,51 real PostgreSQL objective-lease tests,41 atomic-accounting tests, responsive browser flows, Android and container smoke. The migration is recorded as20261006194326 and its repository filename matches. Live catalog verification confirms validated constraints, the enabled SECURITY INVOKER trigger, unchanged RLS and no direct helper-execution grants, including service_role.

Existing Render deploy `dep-db2l2s8m7kps739320dg` became live at19:52:41 UTC. Health at19:53:16 returned the exact commit, productionReady:true and healthy persistence/auth/encryption. No customer objective or review was created during verification. Hot state was1,557,015 bytes, close to its1,572,864-byte warning threshold; new objective reports live in job.result rather than adding to that snapshot.

### Mature usage observation

A bounded Render metrics read at20:14 UTC reported0.18449497 MB for18:00–19:00 UTC (timestamp19:00),99.52% below the prior23-hour baseline of38.53855 MB/hour. The preceding17:00–18:00 hour was35.690376 MB and included deployments through17:34. The mature18:00–19:00 observation predates stages5/6 and is one full hour after the earlier releases. It is a descriptive one-hour reduction, not a causal attribution, sustained-rate guarantee or billing forecast. An earlier provisional value for that hour revised upward, so publication delay matters: [Render bandwidth timing](https://render.com/docs/service-metrics#outbound-bandwidth).

## Stage 7: quota-safe automation payload retention

See [the retention release record](automation-retention-rollout.md). The stage reduces repeated hot-state payloads while preserving quota membership, immutable full evidence, active scheduler references and bounded explicit history access. It adds no database schema, access grant, service or recurring worker.

### Stage 7 release evidence

[PR70](https://github.com/ajay1980-hue/Packsmart-hub/pull/70) merged as `dd5819a9e91239a30c4de9ba73aa4fdb1cf23267`. SaaS CI37529212431 passed463 Node tests, responsive archive-history browser tests, the existing browser flows and container health. PostgreSQL CI37529212340 passed41 atomic accounting tests plus8 actual archive round-trip cases; objective lease CI37529212346 passed51 cases; Android37529212318 passed.

Existing Render deploy `dep-db2m3b7avr4c73ej7mm0` became live at21:02:11 UTC on2026-10-06. Health at21:02:20 confirmed the exact commit, productionReady:true, healthy persistence/authentication/encryption and automationRetentionEnabled:true. Initial hot state was1,573,310 JSON bytes, just above the1,572,864-byte warning threshold and below the2,097,152-byte hard limit. No normal primary save had occurred after startup at that check, so no live compaction reduction is claimed. A bounded SQL read at21:03 still found832 retained runs and no archive stubs. SQL JSONB-text bytes use a different representation and are not compared directly to application JSON bytes.

## Stage 8: governed creative submission boundary

See [creative submission safeguards](creative-safety-rollout.md). New potentially chargeable creative POSTs require exact-phase owner authority, a finite verified cost allowance and an acknowledged durable claim. No production allowance issuer is installed by this stage; existing accepted-job status reads remain available. This stage adds no migration, access grant, provider activation or recurring schedule. Unknown costs remain unknown, and saved owner drafts/claims are never silently evicted.

### Stage 8 release evidence

[PR71](https://github.com/ajay1980-hue/Packsmart-hub/pull/71) merged as `b8fa9ebe4cc2ebb64be796d6e4983464d4679669`. SaaS CI37531874535 passed509 tests plus browser/container checks; atomic/archive37531874860, objective37531874762 and Android37531874689 passed. Existing Render deployment `dep-db2mabd9fdbs739veg30` became live at21:16:54.467628 UTC on2026-10-06. Health at21:17:08 returned the exact commit, productionReady:true and healthy authentication/encryption/persistence. Hot state was1,577,738 bytes, above the warning threshold but below the hard limit. These are the existing release verification observations; this cutover implementation made no additional production probes.

## Preparation: atomic operator-brief dispatch

See [the operator-brief cutover contract](operator-brief-cutover.md). The existing queued OpenAI enhancement is switched to the stage-5 reservation/settlement boundary, with current job/policy rechecks, verified conservative token ceilings, strict response identity/accounting and preserved local summaries. Missing policy, proof or clean baseline blocks paid dispatch. No price, cap, credential, provider or policy is activated; Firecrawl and broader routing remain separate integration work.
