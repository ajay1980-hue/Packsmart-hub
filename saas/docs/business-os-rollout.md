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
