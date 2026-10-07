# Runvara original blueprint acceptance, updated 2026-10-07

This is a scope ledger, not a completion claim. Stages 1–9 have recorded exact production health evidence. Stage 10 is deployed at `3ebc1c75370b6a8b843da3829bc1b7af59f0a867`; its functional health remains blocked by a dismissed cloud-browser permission check. No alternative route was used to bypass an access restriction or the failed permission check. Further production changes remain held.

The owner approved PR74's reviewed tables/functions at 05:26 UTC on 2026-10-07. That authorization is recorded separately from execution: no production SQL, migration, merge or deployment was applied by these integration rehearsals. The live health gate still blocks rollout. The original OS is incomplete and the successor universal-commerce/MCP/RAG/voice blueprint is untouched.

The table below retains the original scope ledger from 2026-10-06. Its remaining items are not all new implementation defects: subsequently prepared PR75–81 and the local recovery evidence are described below. None of their local test results is a production acceptance claim.

| Original requirement | Evidence delivered | Remaining acceptance |
|---|---|---|
| Business graph | Bounded tenant-safe projection of persisted sources, explicit ambiguous links, on-demand UI | Durable archived relationship coverage; full product/supplier/customer/channel/action/outcome chain |
| Opportunity/risk decisions | Canonical identities, evidence scoping, bounded preparation; unknown forecasts withheld | Broader validated detectors and financially supported ranking; verify real Packsmart insights |
| Commander | Goal-linked bounded deterministic specialist review, queue leases, pause and source fingerprints | Fresh execution admission, objective conflicts, safe actual delegation and outcome feedback |
| Provider independence | Pure capability router; existing OpenAI path behind atomic usage admission | Verified provider health/price/cap activation; more real adapters without claiming unavailable connections |
| Outcome memory | Stage 11 exact typed measurements, immutable owner publications/corrections/withdrawals, read-only summary and provenance | Final-head CI and approved migration/deployment after live health clears; further metrics and automatic qualified measurement |
| Owner objectives | Validated versioned goals/limits and owner/admin UI; preparation evaluator | Enforce applicable constraints at every actual external write; zero/missing/conflicting evidence tests |
| Execution layer | Existing integrations retained; durable cost holds, creative fail-closed boundary, no uncontrolled loops | Fresh exact approval/account/payload checks at final dispatch; controlled browser-provider contract if needed |
| Connection Centre/Auto-Doctor | Existing health direction retained; safer queue/retries and data churn | Consistent expiry/staleness/webhook/rate-limit evidence, recovery rules and explicit intervention UX |
| Approval Centre | Central existing approvals retained; no automation bypass introduced | Bind objective revisions/evidence to exact action; verify final current approval before each mutation phase |
| Usage governance | Stable mirror digests, idle polling reduction, atomic cost ledger, bounded history, unknown cost holds | Complete API/crawl/database/storage/bandwidth meter coverage and anomaly UX; actual provider allowance setup |
| Customer zero | Existing Packsmart production data reused, no duplicate app or database | End-to-end authenticated scenario verification with real actionable insights and honest missing data |
| Runvara Command | Existing premium UI extended with graph/goals/usage/outcome preparation | Integrated executive metrics/recommendations/approvals/outcomes, responsive authenticated acceptance |
| Security | Existing static/tenant/security tests retained and expanded; real PG concurrency gates | Release the prepared dispatch correction; final cross-feature adversarial acceptance and rollback exercise |
| Incremental delivery | PR64–73 merged with recorded CI; production health verified through PR72 | Resolve PR73 health gate; execute the approved stage11 scope and remaining safe PRs |

No real paid provider, new credential, database, service or autonomous external communication has been activated. The later universal-commerce/MCP/RAG/voice blueprint has not started.


## Local integration recovery, 2026-10-07

After the old shared worktrees were lost, a clean clone of the main SHA above was reconstructed on local branch `codex/runvara-integration-recovery`. The published source order was PR75 → PR76 → PR74 → PR77 → PR78 → PR79 → PR80 → PR81. PR76 and PR78 were each included once; PR81 contributed only its three commits above the catalogue base.

| PR | Published source commits included, in order |
|---|---|
| 75 | `fee5351ddbbbaf119780c3426499f9c2b8c36107` |
| 76 | `72310bc02e420de9867a3aeebf126862c71058b4` |
| 74 | `0e17285d5cfe1e003ac9f6f9846f53e528f605c5`, `e47f3ddc8d91f4eb3a13912f596b2a869afea093`, `2b1b77b222955dfb48fd39e1a64759acf2a31a99`, `c3021022d1287ee619c70ab0897f41d0dc067de9`, `92835acb1db75f9b3d8521ca4c9ac767e9176b18`, `a3328a4a3de04b6255e58834e381b761a6a72ec4` |
| 77 | `1810612631d55c0d5d32918fe82a31808a96149c` |
| 78 | `c9ab79ffecf00b99c245d4cdde2e99079810a3de` |
| 79 | `d9ecb818c8ec20cf074080e3a2c139c3ac4191a8` |
| 80 | `ba53cc06d1172a6b94c6c3141a8edfcc34a23c47` |
| 81 | `f3472b650cfc2bbe36e400a8047bfe7632e5710e`, `177e046c47b98549036bf78ce6a72ea790e31a39`, `919d9a09dfc639c1e571b616a0263f0939941f1d` |

The conflict review preserved response metadata after successful decoding, sanitized RPC errors, activity metering without inferred attribution, compact authentication and the pre-authentication activity quota, exact owner/current-session/revision dispatch checks, qualified current outcome heads, tenant markers, both UI lifecycle guards/styles, Command's outcome boundaries and imported-evidence disclosures. All source syntax checks and all eight responsive browser workflow gates remain. The outcome PostgreSQL/RLS/concurrency workflow and migrations were retained unchanged.

Fresh validation against the reconstructed tree:

- Full Node suite: **1,069 passed, 0 failed, 0 skipped** on Node **24.19.0**. The repository requires Node 22.x, so this does not replace supported-runtime CI.
- `npm --prefix saas/server run check`, SaaS guards and whitespace checks passed.
- Added six cross-feature tests plus both static script revalidation cases: transport-through-store cardinality and safe failures; no mutation retry or invented tenant activity; outcome/activity delayed 401 navigation and logout; exact corrected owner outcome separate from incomplete/mixed-currency imported cohorts; unavailable profit cannot create an economic zero or authority; Command preserves owner-result boundaries after refresh. Existing PR74 real-app read/save/publish lifecycle regressions were reused with both modules loaded, not duplicated.
- An independent read-only source/conflict review found no concrete regression or unresolved meaningful coverage gap. Its focused safety suites and all five amended test files passed.
- The synthetic imported-payload check passed with 500 orders/100 variants and 2,000 orders/2,000 variants. Bootstrap payloads were 1,235,108 and 3,590,316 bytes respectively. These are local synthetic measurements, not live customer performance or size guarantees.

Remaining gates: exact-head CI on Node 22, real PostgreSQL publication/concurrency/role/bootstrap suites, all responsive Chromium workflows, production container build/health and the independently blocked live stage-10 health check. The expected local Chromium executable was absent; no browser installation, substitute browser, Docker workaround or production request was attempted. Historical 1,068-test integration evidence and independently green PR heads are not proof of this reconstructed combined tree.

Activity coverage remains explicitly partial: outcome persistence and dispatch-context calls without trusted observation context are counted only as internal unattributed attempts. URL filters, RPC payloads and response identities do not create tenant attribution. Imported totals remain recorded cohort evidence; qualified owner outcomes remain separate descriptive results, not forecast or execution authority.

Only locked existing npm dependencies were installed with scripts disabled; no dependency files changed and node_modules is untracked/ignored. Source patches and explicit recovery test/document files were committed locally with command-scoped Runvara engineering identity. The eight feature PRs remain the incremental release path. The unmerged recovery branch preserves this combined tree and its extra tests; it must not be treated as a production release or merged wholesale without the required review gates.


## Separate reporting repair integrated locally, 2026-10-07 07:31 UTC

PR74–81 remain the **eight held original feature PRs**. [PR82](https://github.com/ajay1980-hue/Packsmart-hub/pull/82) is a separate bandwidth repair prepared directly on current production main. Its reported remote head `41b05aead6188ad12333a1be4b3fe12d990a2ab9` has all five PR CI workflows green. Those checks apply to that standalone draft head, not to this combined integration tree. Fresh exact-tree CI must be run before treating the combined branch as verified remotely.

The reporting implementation source `b8d42f2246045e925a5343bccedb33ca02b0885b` was replayed locally onto recovery base `d999248` on `codex/runvara-reporting-integration`. The resulting local rehearsal retains every held-stage dispatch, outcome, activity, catalogue, imported-evidence, static-asset, objective and responsive workflow hook. It is not a new production release path or permission to merge the held features wholesale.

Compatibility resolutions:

- The shared revision-fenced commit helper retains PR76 primary-health behavior and strict response decoding. A reporting success or failure cannot clear, replace or create a primary-health observation. Invalid commit acknowledgements now use the shared safe `SUPABASE_PERSISTENCE_RESPONSE_INVALID` code; the existing health regression still requires rejection and failed primary health.
- The compact revision reader keeps PR82's 4 KiB response cap and exact one-row/one-field validation while using PR77's trusted `state_read` observation context. An initial conflict-resolution omission of this method was caught by both the combined suite and independent review, restored, and verified by fresh passing runs.
- Every primary/reporting transport attempt is metered once through `scopedRequest`. Reporting retries use the fixed `reporting_statement_cancelled` and `reporting_network_reconciled` keys; they do not increment primary retry categories or infer a tenant from payloads, URLs or responses. The activity UI renders these categories separately.
- The narrow reporting RPC retains its 16 KiB request and 4 KiB response bounds, exact acknowledgement, original body/revision fence on permitted retries, no full-state fallback, and scheduler/mirror-cache invalidation on unconfirmed status.
- Compact reporting DTOs never update full hot-state attempted/confirmed size samples. Primary snapshot sizes stay distinct from observed reporting request-body bytes; neither is physical storage or growth accounting.
- Reporting failure injection now targets the new RPC and asserts that it actually fired and produced deferred status. No test was removed. Package syntax checks are the held-stage union plus `reporting-status.mjs`; fake-Supabase still preserves held projection/revision semantics.

Fresh verification on this combined tree:

- **1,088 Node tests passed, 0 failed, 0 skipped**, using Node **22.23.3**.
- Full syntax checks, SaaS security guards and whitespace checks passed.
- **73 actual PostgreSQL 17.6 reporting tests passed, 0 failed, 0 skipped**, using a fresh local disposable cluster and independent physical sessions. The cluster was stopped. Production SQL was not executed.
- New integration regressions prove reporting-only retry attribution, exact attempt/body-byte accounting, retained full primary snapshots, no false primary-health repair, and distinct activity UI retry labels. An independent review accepted the fixes and passed 75 focused Node22 checks before the additional UI regression; the final full suite includes that regression.

PR82's specific function approval was requested at 07:26 UTC and remains pending. PR74's existing owner approval is conditional on clearing live health and does not authorize PR82's function. The dismissed cloud-browser permission check still blocks production functional health. No remote mutation, production request, migration or deployment occurred in this integration task. No browser installation or Docker workaround was attempted. The known local security-advisor TLS limitation was not retried; exact role/RLS/invoker checks passed in PostgreSQL.

Remaining combined gates are fresh exact-head CI, the other database suites, all responsive Chromium workflows, container health, the existing live health check, and the separate PR82 function approval. The original OS remains incomplete and the successor blueprint remains untouched.
