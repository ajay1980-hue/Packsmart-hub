# Runvara original blueprint acceptance, updated 2026-10-07

This is a scope ledger, not a completion claim. Stages 1–9 have recorded exact production health evidence. Stage 10 is deployed at `3ebc1c75370b6a8b843da3829bc1b7af59f0a867`; its functional health remains blocked by a dismissed cloud-browser permission check. No alternative route was used to bypass an access restriction or the failed permission check. Further production changes remain held.

The owner approved PR74's reviewed tables/functions at 05:26 UTC on 2026-10-07. That authorization is recorded separately from execution: this recovery applied no SQL, migration, merge or deployment. The live health gate still blocks rollout. The original OS is incomplete and the successor universal-commerce/MCP/RAG/voice blueprint is untouched.

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
