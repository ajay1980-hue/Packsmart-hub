# Business graph legacy outcome evidence correction

Local preparation on 2026-10-07, on branch `fix/graph-recorded-outcome-evidence`.
Base commit: `ccdd506162612477a66dafc917fa3b050c2f6d77`. Its tree is
`e18955a845c9106bd1a7c8d05e998e68da1a76cd`, identical to the supplied deployed
revision `abf83315` in the local repository. This is source-tree comparison,
not a fresh production health check.

## Problem and corrected contract

The graph previously promoted legacy `verified: true` or `status: verified`
fields to verified outcome nodes and, for terminal source records, realised
outcomes. Those fields live in the retained workspace snapshot. They do not
prove a committed typed outcome, its current publication head, currency,
window or coverage. This conflicted with the canonical opportunity and impact
consumers' treatment of legacy reviews as unqualified context.

The existing graph schema, source pointers, opaque identities, relationship
types and compatibility booleans are retained. Outcome nodes now expose
`verified: false`, `realised: false`, `qualified: false` and
`qualification: legacy_unqualified`. `legacyReviewed` preserves only the old
source assertion; `terminalSource` describes the source lifecycle. Neither
establishes evidence qualification. Metric field names remain inspectable;
raw amounts, identities, verification notes and publication payloads remain
absent from the response.

`recordedOutcomeRecords` and `legacyReviewedOutcomeRecords` count only outcome
nodes admitted to this bounded projection. They count source records, not
deduplicated commercial outcomes. `verifiedOutcomeRecords` remains a numeric
compatibility field, counting zero proven graph records. The new
`outcomeCoverage` explicitly reports unavailable committed publication proof
and incomplete outcome coverage. Its note states that the zero compatibility
count does not establish that the tenant has no qualified outcomes. No new
qualified/current-publication total is supplied.

The graph endpoint only passes authenticated retained state and fixed limits.
It does not obtain the trusted adapter snapshot consumed by
`deriveQualifiedOutcomeGroups`. The correction does not invent that snapshot,
accept copied publication claims from state/options, resolve publication heads,
or add requests. Existing graph `coverage.complete` still describes retained
source traversal; `outcomeCoverage.complete` separately describes unavailable
publication evidence.

## Consumer and invariant review

- The only production callers are the summary/detail branches of authenticated
  `GET /api/business-graph`. Query parameters cannot select its tenant or widen
  the server's bounds. No endpoint change is needed.
- The on-demand inspector in `saas/app.js` renders entity, relationship and
  unknown-mapping counts. It does not use `verifiedOutcomeRecords` or outcome
  verification booleans. DOM, session-lifecycle and API tests remain compatible.
- Stable node/edge IDs, duplicate-source handling, tenant assertions, scan and
  output bounds, raw-data privacy and read-only behaviour are unchanged.
- No schema/migration, grants, provider configuration, jobs, polling, full-state
  save or other write path was added. No remote or production operation occurred.

## Local verification

Runtime: Node 22.23.3. The pinned existing test dependencies were reused through
a temporary local symlink and removed before the clean commit.

- Focused graph, qualified-consumer, canonical-opportunity and auth/tenancy
  files: **83 tests passed**, zero failures or skips.
- Full `npm --prefix saas/server test`: **1,004 tests passed**, zero failures or
  skips, including security, tenant isolation, DOM and outcome lifecycle tests.
- `npm --prefix saas/server run check`: passed all configured syntax checks.
- `node saas/tests/saas-guard.test.cjs`: passed for all 15 fixture products.
- `git diff --check`: passed.
- Independent source/consumer review: no actionable findings; the reviewer did
  not rerun the already completed test suite.

Regression cases cover all retained outcome shapes, pending and terminal
sources, positive/negative/zero amounts, forged qualification and copied proof,
repeated evidence IDs, bounded counts, privacy, foreign nested scope assertions,
and the authenticated summary/detail contract. Existing frozen-state tests
assert no state mutation, provider request or scheduling.

Local browser/container and live PostgreSQL gates were not run for this pure
projection change. No browser, deployment or production outcome is claimed.
The branch deliberately excludes concurrent PR78–81 changes. Alignment onto
their eventual accepted ancestry, review and exact-head CI remain pending.
The original OS is not complete; the successor blueprint is outside this fix.
