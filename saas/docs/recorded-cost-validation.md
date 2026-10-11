# Recorded cost input validation

This preparation closes a synthetic reproduction in which whitespace, booleans and JSON containers could be converted to zero and count as recorded costs. It is based on the cumulative `75a70fd7bef00c68c4aa8cea2e53e9b0f86def21` source tree. No production records were inspected or edited to reproduce the defect.

## Input and derivation contract

`hasAmount` accepts finite JavaScript numbers and strings using the existing catalogue decimal grammar: an optional sign, digits with an optional decimal point (or a leading decimal point), and an optional signed decimal exponent. Surrounding whitespace on a valid number remains supported. Whitespace alone, booleans, arrays, objects, hexadecimal/binary/octal notation, separators, currency symbols, `NaN` and infinity are not numeric evidence.

The catalogue/supplier economics editor, pilot economics import, order cost editor, advertising spend and optional attributed revenue use that predicate before numeric conversion. The five eBay imported order-cost fields use it after their existing one-level `value`/`amount` wrapper extraction; provider requests, other mapped values and raw import history retain their existing behavior. Existing clear operations remain: an empty string or null clears an optional cost rather than recording zero. Required advertising spend cannot be cleared. Explicit numeric and decimal zero remain valid. Field-specific nonnegative checks, maximum values, four-decimal cost rounding and two-decimal advertising rounding are unchanged. The supplier VAT-recovery boolean has its separate existing contract.

Legacy raw inputs are not rewritten by calculations. Malformed retained costs become unknown; valid fallback supplier or per-unit cost evidence may still be used under existing rules. Historical signed amounts and refund clamps retain their previous interpretation. Previously persisted numeric zero cannot be distinguished from an earlier coerced zero, so this change does not invent or erase historical provenance.

The general-purpose `amount` converter and stock interpretation remain unchanged. Financial callers qualify their inputs separately, including line quantity and the configured fallback margin floor. Existing normalized reporting mirrors can already contain legacy values coerced under their older mapping; this slice does not rewrite those mirrors or qualify them as trusted financial evidence. Application derivation uses authoritative retained workspace inputs. Other provider mapper fields, including prices, inventory, revenue and refunds, are outside this cost-only import correction.

This is input-type validation, not exact-decimal accounting or verified financial evidence. Existing IEEE-754 conversion, precision, underflow and rounding remain, including very small valid decimal amounts rounding to zero. Currency, historical cost assignment, tax treatment and source-period qualification remain independent requirements. No financial execution authority or enforced objective restriction is relaxed.

## Existing cache reconciliation

The existing `OPERATIONS_CALCULATION_VERSION` becomes `catalogue-recorded-costs/v1`. This invalidates old same-input daily brief and control signatures. The existing first bootstrap reconciliation saves once; the mocked Supabase regression observes one primary CAS and one bounded reporting-status CAS. A second unchanged bootstrap performs reads only, with no save, reporting commit or changed activity samples. There is no new marker, persistence loop, request or provider call.

Raw costs, cost history, old briefs, specialist runs and typed owner measurements remain unchanged. New derived findings use current validation; old analysis retains its historical version. This does not backfill or correct published evidence.

## Validation and release boundary

Synthetic tests cover every required cost and entry field, suppliers, order overrides, signed historical inputs, numerical boundaries, explicit zero, malformed JSON, entire-request rollback for a bad pilot-import record, role/CSRF/tenant/session checks, a lost-save conflict, one-time cache reconciliation and financial dispatch denial before credentials, claims or provider calls. The provider and database fixtures are local/synthetic.

The preparation changes no UI assets, SQL, grants, schema, provider request behavior or deployment configuration. Its original separate candidate is preserved; the cumulative integration combines it with reviewed lifecycle/drain and busy-settlement changes, as described in `cumulative-safety-integration.md`. Public backup, exact-head CI and any eventual release require their respective outstanding gates; local tests do not establish live deployment health.
