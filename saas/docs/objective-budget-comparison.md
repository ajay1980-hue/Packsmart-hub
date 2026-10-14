# Exact comparisons for recorded preparation budgets

The existing internal objective evaluator added month-to-date and proposed
advertising spend as JavaScript Numbers. This could reject an exact decimal
limit (`0.1 + 0.2` against `0.3`) or erase an overrun (a recorded
`9007199254740991` plus `0.25` against that same recorded limit).

The evaluator now compares the exact decimal spellings of its three existing,
validated numeric inputs using bounded integer arithmetic. It neither rounds to
currency minor units nor chooses a tax, allocation, exchange-rate or accounting
policy. It cannot recover source precision already lost before a value became a
stored Number. A recorded `0.30000000000000004` stays above `0.3`; it is not
silently repaired to an assumed intended amount.

The existing `monthlyAdSpend` check retains numeric `actual` and `limit` fields
for compatibility. `actual` is now a Number projection of the exact total.
New additive `actualExact` and `limitExact` strings carry the values used by the
comparison, with `comparisonBasis: 'recorded_decimal'`. `actualExact` uses plain
decimal notation; `limitExact` retains the Number's canonical decimal spelling,
including an exponent where applicable. The numeric projection can still lose
precision; only the integer comparison decides `passed`. Input and output schema
names, HTTP route and persistence shapes are unchanged. No BigInt is serialized.

Inputs remain finite, nonnegative Numbers at most `Number.MAX_SAFE_INTEGER`.
Their decimal spellings need at most 324 places. With exactly three operands,
the largest exact total diagnostic is at most 342 ASCII characters. The existing
unknown, currency, observation/month, source, cost, capacity, profit and owner
approval checks continue to apply. Explicit zero remains zero; omitted, null or
malformed evidence never becomes a zero budget. No tolerance, automatic currency
conversion or implicit rounding is introduced.

This is supplied/unverified **preparation** evidence, not a financial receipt or
authority. The [existing dispatch policy](objective-dispatch-policy.md) still
blocks profit-first and every non-null financial/stock restriction, including
zero. The [source cost annotations](cost-source-review.md), retained order money
and [content execution receipts](protected-content-receipts.md) cannot satisfy
that hold. Operation-specific verified source/currency/tax/cost/period evidence,
allowances and an appropriate producer/persistence contract remain separate
work. Historical measurements do not establish a future action's profit.

The pure helper runs only inside the existing read-only evaluation. It adds no
API, queue, lease, store, SQL, receipt producer, provider call or side effect.
Existing leases, source digests, owner decisions, workspace CAS and dispatch
claims remain untouched. No production gate is activated. Previously retained
reports are not rewritten; new evaluations use the corrected arithmetic and
existing exact source reconstruction continues to govern subsequent proposals.

Synthetic coverage includes the reproduced false denial/false pass, decimal and
exponent forms, subnormal positives, large sums, recorded rounding artifacts,
zero, a 961-case independent integer-cent oracle, missing/invalid values, other
financial holds, and the actual authenticated API with zero evaluation saves.
Exact test commands, exits, full-suite status and release limits are recorded
with the local change. No live customer figures or provider receipts are used.
