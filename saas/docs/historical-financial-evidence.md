# Historical financial source validation

`createBusinessOutcomePersistence().financialEvidence(workspaceId, experimentId,
actor, input)` is a dormant internal reader. It produces a bounded, immutable
`runvara-historical-financial-evidence/v1` result from existing contracts. There
is no HTTP route, scheduler, dispatcher consumer, activation flag or new table.

The supported financial source is a current **published owner attestation** of
historical incremental contribution, with an exact directly associated protected
Shopify product-content completion. It is not an independently verified invoice,
forecast, action-level causal effect or executable profit claim. Negative recorded
contribution and exact zero are valid historical amounts under the existing
decimal contract; no new accounting or freshness threshold is introduced.

## Source boundary

The caller can submit only `expectedWorkspaceRevision`, `expectedVersionId`,
`expectedVersionDigest` and the existing exact receipt selector (`attemptId`,
`receiptDigest`, `sourceDigest`). These are comparison assertions, not authority.
Actor and session come from a separate trusted server argument. Unknown fields,
including financial amounts, currencies, proof objects and verified flags, fail
before the read. Input and actor selectors are captured before awaiting it.

The persistence adapter issues one existing authenticated, bounded
`runvara_read_outcome_content_sources` RPC, requiring its protected contract and
resolving the saved measurement. There is no legacy fallback, second read, write
or caller-supplied review. Its existing validation and private WeakMap receipt
attachment supply the source. The exported reader factory is internal dependency
injection for trusted server code, not a public source-authentication constructor.
Synthetic callbacks prove contract behavior only, not a live database read.

The producer then requires:

- The same workspace, experiment and expected workspace revision.
- The expected current version ID/digest, a published head, and a recorded version.
- The exact source measurement revision/digest and identical metric, amount,
  currency, window, coverage, method, provenance and action/approval links.
- Complete measurement and cost evidence under the existing outcome and report
  validators; null amounts, unknown currency, incomplete coverage and unknown
  costs cannot become qualified merely by appearing in a publication row.
- A v4 measurement with a direct protected association (published-version reuse
  is deliberately unsupported in this first slice), its exact receipt commit
  reference, validated receipt source, and identical current action association.

Decimal values keep the existing maximum of 18 integer and 6 fractional digits,
without Number conversion or rounding. The output preserves publication,
measurement, report, receipt and operation digests, owner verification and observed
provenance. It retains the approved action reference while excluding private
claim/session/admission material and report text. A canonical digest binds the
whole detached frozen result, capped at 16 KiB.

## Limits and next boundary

`readCompletedAt` describes a single current-head snapshot. Expected revision and
version checks reject obsolete selections; they do not create a time-to-live or
promise that the workspace cannot change after the read. Every invocation reads
again. A cloned, persisted or replayed result has no capability or spending value.

The safeguards explicitly deny independent financial/invoice verification,
provider authentication, causal attribution, forecasting, learning, execution and
allowances. No mutable cost entry is treated as an invoice, and no ledger is added.
The [objective financial holds](objective-dispatch-policy.md#qualified-evidence-is-still-required)
remain in force. Owner approval cannot replace qualified financial evidence.

This closes the narrow source-join validation gap for a historical, owner-attested
measurement; it does not close the operation-specific execution-evidence gap.
Future use for margin, budgets, stock or profit-first dispatch still needs an
independently reviewed financial source contract appropriate to that operation,
freshness/reconciliation rules, and atomic allowance consumption tied to the
current workspace and exact approval. Those decisions are not inferred from
historical measurements. No activation or new owner accounting decision is needed
to test this dormant reader.

The synthetic integration suite exercises the real persistence adapter and
existing contract validators with bounded fixture responses. It covers tampering,
re-digested mismatched facts, obsolete publication/workspace selectors, incomplete
and invalid amounts, foreign scope, altered operations, in-flight request changes,
withdrawals and unavailable/denied source reads. Test results and exact exits are
recorded separately; no live provider or database acceptance is claimed.
