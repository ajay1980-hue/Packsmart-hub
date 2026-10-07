# Runvara original blueprint acceptance, 2026-10-06

This remains a scope ledger, not a completion claim. PR82's separate reporting repair has merged to main at `fa1823756565a356decb4e038af0bdd538484b75`. The next incremental PR74 outcome stage is prepared locally on that actual main ancestry. PR82's exact deployed revision has now passed the owner-supplied postdeployment health check; the approved PR74 migration is applied. The outcome application's aligned head still requires fresh CI, release and its own postdeployment health verification.

The owner's conditional approval for the reviewed PR74 tables/functions is recorded by the coordinating task, which reports that the health condition cleared and the approved migration was applied as `20261007100823`. This local worker performed no production operation. The six published PR74 commits are the only feature changes included above PR82; later PR75–81 dispatch, health/activity, catalogue, analytics and static-revalidation features are not part of this branch. The original OS remains incomplete and the successor blueprint is untouched.

The table below preserves the original 2026-10-06 scope ledger. Current local evidence and release gates appear after it; historical remaining-acceptance entries must not be read as current production authorization or an aggregate completion claim.

| Original requirement | Evidence delivered | Remaining acceptance |
|---|---|---|
| Business graph | Bounded tenant-safe projection of persisted sources, explicit ambiguous links, on-demand UI | Durable archived relationship coverage; full product/supplier/customer/channel/action/outcome chain |
| Opportunity/risk decisions | Canonical identities, evidence scoping, bounded preparation; unknown forecasts withheld | Broader validated detectors and financially supported ranking; verify real Packsmart insights |
| Commander | Goal-linked bounded deterministic specialist review, queue leases, pause and source fingerprints | Fresh execution admission, objective conflicts, safe actual delegation and outcome feedback |
| Provider independence | Pure capability router; existing OpenAI path behind atomic usage admission | Verified provider health/price/cap activation; more real adapters without claiming unavailable connections |
| Outcome memory | Stage 11 exact typed measurements, immutable owner publications/corrections/withdrawals, read-only summary and provenance | Aligned-head CI, outcome application deployment/health; further metrics and automatic qualified measurement |
| Owner objectives | Validated versioned goals/limits and owner/admin UI; preparation evaluator | Enforce applicable constraints at every actual external write; zero/missing/conflicting evidence tests |
| Execution layer | Existing integrations retained; durable cost holds, creative fail-closed boundary, no uncontrolled loops | Fresh exact approval/account/payload checks at final dispatch; controlled browser-provider contract if needed |
| Connection Centre/Auto-Doctor | Existing health direction retained; safer queue/retries and data churn | Consistent expiry/staleness/webhook/rate-limit evidence, recovery rules and explicit intervention UX |
| Approval Centre | Central existing approvals retained; no automation bypass introduced | Bind objective revisions/evidence to exact action; verify final current approval before each mutation phase |
| Usage governance | Stable mirror digests, idle polling reduction, atomic cost ledger, bounded history, unknown cost holds | Complete API/crawl/database/storage/bandwidth meter coverage and anomaly UX; actual provider allowance setup |
| Customer zero | Existing Packsmart production data reused, no duplicate app or database | End-to-end authenticated scenario verification with real actionable insights and honest missing data |
| Runvara Command | Existing premium UI extended with graph/goals/usage/outcome preparation | Integrated executive metrics/recommendations/approvals/outcomes, responsive authenticated acceptance |
| Security | Existing static/tenant/security tests retained and expanded; real PG concurrency gates | Resolve demonstrated connection-write race; final cross-feature adversarial regression and rollback exercise |
| Incremental delivery | PR64–73 merged with recorded CI; production health verified through PR72 | Release and verify the aligned stage11 application; remaining safe PRs stay separate |

No real paid provider, new credential, database, service or autonomous external communication has been activated. The later universal-commerce/MCP/RAG/voice blueprint has not started.


## Incremental outcome preparation after PR82, 2026-10-07

Branch: `codex/runvara-outcomes-after-reporting`. Base: actual merged main `fa1823756565a356decb4e038af0bdd538484b75`. The initially requested aligned local PR82 commit `1ee2a471758db754f9ed83e26f59d239906677f7` has the same tree; after main merged, the local outcome chain was rebased onto actual main and ancestry verified.

| Published PR74 source | Locally replayed commit |
|---|---|
| `0e17285d5cfe1e003ac9f6f9846f53e528f605c5` | `ec2adbe08fc2c8cf320369424cd7a3f65c8f9270` |
| `e47f3ddc8d91f4eb3a13912f596b2a869afea093` | `cd80488ced77507edf16ea26f2b004f2fbb69356` |
| `2b1b77b222955dfb48fd39e1a64759acf2a31a99` | `7621e136d71f041b01a1b2d3b1da9c98b2549e43` |
| `c3021022d1287ee619c70ab0897f41d0dc067de9` | `aa2bf0bd6237a46813bbcfa0c91c24d5165d347e` |
| `92835acb1db75f9b3d8521ca4c9ac767e9176b18` | `df5649f12b6cfb09648bf70c0ac4af4b22eaf99b` |
| `a3328a4a3de04b6255e58834e381b761a6a72ec4` | `ad9b9a1f78b863ea43834fdbff67d408f160cb0e` |

Only `package.json` conflicted: its syntax-check command is the union of PR82's reporting check and PR74's outcome checks. The store automatically merged only the outcome persistence adapter and opt-in response/cardinality metadata. PR82's 16 KiB reporting request bound, 4 KiB acknowledgement/revision bounds, exact acknowledgements, revision-fenced recovery, narrow reporting-only update, and unconfirmed scheduler/mirror-cache invalidation remain unchanged. Independent patch-ID and source review found no later feature imports or blocking issue.

The only new executable coverage is in the outcome PostgreSQL suite. Its disposable fixture now installs the actual reporting predecessor before outcome publication. A genuine two-session lock test covers reporting first and publication first: the stale competitor cannot overwrite the winning revision; a fresh, explicitly reviewed revision can proceed; sibling business data, reporting state, immutable outcome versions/heads and audit counts remain correct. Existing privilege/bootstrap checks also verify that the reporting function remains an invoker with an empty search path, executable by service_role and denied to browser roles.

Fresh local verification on Node22.23.3/PostgreSQL17.6:

- **708 Node tests passed, 0 failed, 0 skipped.**
- **25 outcome PostgreSQL tests passed, 0 failed, 0 skipped**, including the new cross-feature race.
- **73 reporting PostgreSQL tests passed, 0 failed, 0 skipped.**
- Full syntax, SaaS security guards and whitespace checks passed.
- Independent read-only review accepted the source chain, auto-merged store, check-script union, current-head/owner/session/tenant/RLS contracts, UI lifecycle guards and new compatibility coverage.

The two PostgreSQL suites ran in separate fresh local clusters, both stopped afterward. No production SQL, migration, provider request, remote write, merge or deployment was performed. Main was fetched read-only to establish actual ancestry. Existing pinned dependencies and Node22 were reused; no dependency files changed. The local Chromium executable remains absent, so responsive browser/container gates are not claimed as passed and no installation or workaround was attempted.

PR74's applied migration is now `20261007100823_business_outcome_publication.sql`, byte-identical to the published and reviewed PR74 source (SHA-256 `7f642f8d22b7827185998d4847fa3890992a8c0569c3100efe3b69d9c07c179f`). The coordinating task applied it under the recorded approval; this worker aligned only the local filename and references. PR82's already-aligned reporting migration remains `20261007074031_reporting_status_cas.sql` unchanged.

Remaining gates: fresh CI on the aligned outcome head including responsive browser/container and all required database checks, then exact-head application release and fresh postdeployment health for that outcome revision. Predecessor PR82 health and authorized outcome migration/catalog verification are complete as reported by the coordinating task. This preparation does not claim that the outcome application has been deployed or that the full original OS is complete.


## Applied migration alignment, 2026-10-07

Owner-screenshot provenance: the coordinating task checked the owner's health screenshot with `checkedAt: 2026-10-07T10:04:12.035Z`, exact deployed PR82 revision `fa1823756565a356decb4e038af0bdd538484b75`, and all required health checks true. This evidence clears the condition attached to the recorded PR74 approval.

The approved migration succeeded as actual version `20261007100823` (`business_outcome_publication`). Reported production catalog verification confirms both outcome tables retain RLS, service SELECT-only access, no service INSERT/UPDATE/DELETE/TRUNCATE, and no anon/authenticated access. Publisher/read modes remain DEFINER/INVOKER respectively, with empty search paths and existing service-only EXECUTE; guard/helper permissions remain denied. The advisor has 25 INFO no-policy observations (23 prior plus two intentional server-only tables), no warning and no error.

The local rename preserves SQL SHA-256 `7f642f8d22b7827185998d4847fa3890992a8c0569c3100efe3b69d9c07c179f`. Fresh verification of the renamed migration passed 141 focused Node22.23.3 tests, 25 outcome PostgreSQL17.6 tests, 73 reporting PostgreSQL17.6 tests, syntax, SaaS security guards and whitespace checks, all with zero failed or skipped tests. Both disposable database clusters stopped afterward. The earlier 708-test full-suite result belongs to the preparation head; complete CI must still run on the new aligned head. Independent review confirmed the R100 rename, unchanged SQL bytes, dynamic migration discovery and absence of stale filename references or runtime changes. Production and remote mutations remain outside this worker's scope. Exact aligned-head CI and post-outcome-deployment health are the remaining release evidence; PR82's screenshot does not stand in for them.
