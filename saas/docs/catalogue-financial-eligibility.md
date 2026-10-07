# Catalogue financial eligibility

A missing price previously passed cost completeness, became a below-floor
margin through null coercion, diluted catalogue averages to zero, and could
produce a £0.00 marketing draft when the configured margin floor was zero.

This patch preserves cost completeness as a separate fact. A financial status,
margin comparison or contribution ranking also requires the corresponding
finite recorded price/result. Missing, blank, boolean and non-decimal coerced
price inputs stay unknown. Explicit zero prices and costs remain distinct from
missing values. Percentage margin at zero revenue is unavailable; a known
negative unit contribution can still be identified as a loss.

Automatic marketing selection requires finite price, contribution and margin.
The copy helper cannot turn missing price into a zero-price offer. No campaign
is submitted, provider activated, budget changed or external write performed
by this patch.

The catalogue mean covers only variants with known margins. The UI, business
snapshot and pricing specialist carry the covered variant count and unweighted
catalogue basis. This calculation is not a business gross-margin KPI or an
objective measurement: selling-price tax basis and currency qualification remain
separate work. Graph callers that inspect costs without a price keep their
existing cost-completeness semantics.

Regression fixtures cover missing/invalid versus explicit zero, zero margin
floors, known losses, rank ordering, means and their coverage, graph cost facts,
marketing copy and the authenticated cockpit. The incremental branch passed
1,010 full Node22.23.3 tests, syntax, SaaS security guards and whitespace checks,
with zero failures or skipped tests. Fresh exact-head CI remains required.

Current brief/control signatures include an explicit calculation version. Existing
same-input caches therefore reconcile once under the corrected semantics; later
unchanged reads reuse the result without another save. False old margin conditions
become inactive while prior briefs, exception history and agent runs remain
intact. Current brief attention counts match the UI’s present-record predicate.
The price-only change does not alter objective-review inputs or its policy.

Order-period completeness, unknown order revenue, currency grouping, duplicate
identities, SKU joins and advertising allocation are intentionally separate
follow-up corrections. None is claimed fixed by this change. No schema, new
provider request or polling is added. The calculation-version reconciliation
uses the existing persistence path. PR78 release remains held
until PR77 deployment and fresh health for its exact revision are verified.


## Incremental preparation after PR77

Actual main base: `abf83315af0c65c7a1cbdcabc306a8a381c602da`.
Published PR78 source: `c9ab79ffecf00b99c245d4cdde2e99079810a3de`, directly
above old main `3ebc1c75370b6a8b843da3829bc1b7af59f0a867`. The isolated 13-file
patch applied cleanly and retained the same stable patch ID. No PR79–81 feature
was imported. Current outcome, dispatch, strict health, activity and bounded
reporting contracts remain unchanged.

The existing cache regression was extended from FileStore to the actual
SupabaseStore adapter with synthetic PostgREST responses. It starts from a
previously saved healthy reporting snapshot, so a real reporting-status change
cannot be mistaken for a catalogue-version invalidation. The first bootstrap
performs exactly one primary reconciliation and one bounded reporting RPC;
activity records one of each, and its confirmed size remains the full primary
snapshot. The second unchanged bootstrap performs only reads and leaves commit
counts and hot-state samples unchanged.

Historical briefs, acknowledged exception history, agent runs and typed owner
measurements remain equal. The prior normalized operations-brief row is also
unchanged and is not resubmitted to its reporting table. The version change makes a false old margin condition inactive without
rewriting its history. No outcome publication or provider request is performed.

Fresh validation passed all 1,010 Node22 tests. Separate disposable PostgreSQL17.6
clusters passed 25 outcome and 73 reporting cases, with zero failures/skips, and
both stopped afterward. These are predecessor contract regressions; the new
cache-transport case is explicitly synthetic. Independent source and interaction
review found no blocking issue. Local browser/container checks were not run;
existing responsive and Android workflows are retained for exact-head CI.

No production request, schema change, remote mutation, merge or deployment was
performed by this preparation. PR77 health, PR78 exact-head CI, authorized
release and fresh PR78 postdeployment health remain gates. The original OS is
incomplete and the successor blueprint remains untouched.
