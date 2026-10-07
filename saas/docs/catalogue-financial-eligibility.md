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
marketing copy and the authenticated cockpit. The standalone current-main patch passed 569 tests, syntax and SaaS guards;
its exact-head remote CI remains required before release.

Current brief/control signatures include an explicit calculation version. Existing
same-input caches therefore reconcile once under the corrected semantics; later
unchanged reads reuse the result without another save. False old margin conditions
become inactive while prior briefs, exception history and agent runs remain
intact. Current brief attention counts match the UI’s present-record predicate.
The price-only change does not alter objective-review inputs or its policy.

Order-period completeness, unknown order revenue, currency grouping, duplicate
identities, SKU joins and advertising allocation are intentionally separate
follow-up corrections. None is claimed fixed by this change. No schema or new
request, polling or persistence operation is added. Production remains held
until the current stage's ordinary functional health verification is restored.
