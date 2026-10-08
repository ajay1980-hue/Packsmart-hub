# Reviewed action snapshots, preparation only

This slice associates one owner-selected recorded Shopify `product_content` action with one typed measurement. The existing owner/session/workspace-CAS/head-checked publication transaction stores the exact bounded action snapshot in the existing immutable outcome version. It is an extension of the existing app, not another execution or outcome service.

**Immutability begins at outcome publication.** The prospective execution context and workspace action remain mutable beforehand. The source is an application-recorded provider acknowledgement, not a provider-signed receipt or independent verification of external truth. A coherent forged pre-publication workspace record is not made authentic merely by matching hashes.

## Recorded execution context

Only the successful supported dispatcher branch records `recordedActionContext`, with the existing exact final save. It retains tenant/write/request/claim identities, the original claim fingerprint, exact input and dispatch request fingerprints, Shopify account/connection/API version/product/result identity, actor and completion time, captured approval decision, and every applicable policy reference. Input text remains once in `write.input`; it is not copied into the context.

The action keeps `origin: owner_manual` and `originatingObjective: null`. Policy ID/revision/digest references describe restrictions that applied to this manual action, not its originating objective. No matching restrictions means an explicit empty policy list and null proposal. Current objective bodies need not remain unchanged to describe an earlier captured proposal, but a fresh association must match the recorded write proposal and approval decision exactly.

The prospective context uses the existing terminal save, without another provider mutation, persistence acknowledgement write, or automatic retry. A lost/malformed final save response remains an execution acknowledgement error. If its bytes actually committed, a later authoritative publication read may validate them; it does not prove the original process received that response. No `acknowledged: true` assertion is stored.

If optional evidence construction or byte limits fail after a known provider response, completion and the known result remain unchanged. Linking context is omitted; a small unavailable reason is retained only when it fits. A conservative 16 KiB headroom below the existing 2 MiB state ceiling covers ordinary final-store metadata. Existing unrelated primary-save failures remain errors, never a reason to replay the provider action.

Legacy completed flags, work records, archive entries, copied DTOs, claims without a known matching result, failed/processing/uncertain actions, and records missing the new context cannot qualify.

## Explicit association and review

The measurement save request can supply only:

- `actionSelection: null` to save an unlinked measurement
- `actionSelection: { actionId }` to select a currently recorded action
- `actionSelection: { reuseVersionId }` to reuse an exact immutable snapshot already published for this experiment

Caller-supplied tenant, hashes, approval/context/source bytes or resolvers are rejected. The authenticated server resolves the selected record. Linked drafts require an explicit selection on edits, including explicit removal. The revision and digest advance on save.

Unlinked v1 canonical measurement/report bytes remain unchanged. Linked measurements use `runvara-experiment-measurement/v2` and `runvara-measurement-report/v2`. Both digests cover the same compact intervention:

- Exact versioned action and captured approval references
- Account, product and completion time
- The explicitly selected immutable reuse version, if any
- `relationship: owner_associated_recorded_action`
- `comparison: not_established`

`links.objective` and `links.opportunity` stay null. Method labels such as `holdout` and `before_after` do not establish a comparison cohort or causal attribution. Groups containing action/approval associations conservatively report `learningComparable: false`; recorded amounts, qualification and grouping remain unchanged. The existing outcome payload format carries the exact links and source measurement digest; it does not gain execution or learning authority.

The existing selected review returns at most 20 compact candidates plus the current immutable association, without full action descriptions. Selection is explicit. If a retained draft's mutable candidate digest changes, the UI requires a new choice rather than silently swapping it. Immutable reuse is a separate explicit choice. Review shows exact action/account/product/completion details and a non-causal warning.

## Storage and lifecycle

Prepared migration: `20261007175355_reviewed_action_outcome_snapshot.sql`.

It adds nullable `source_action` to `runvara_business_outcome_versions` and replaces the existing private validation/publication/review implementations while preserving both public RPC signatures, table access, function ownership and existing role grants. New helpers are private and denied to PUBLIC, browser roles and service_role. The original publication and reporting migrations are unchanged.

Fresh publication resolves unique write/request/claim/approval/connection identities under the same workspace lock, validates recursive tenant markers and exact decision/proposal/result/phase bindings, and independently recomputes input, dispatch request, typed claim and source canonical hashes. Existing JSON.stringify fingerprints are not reinterpreted as canonical evidence hashes. Typed claim reconstruction uses the original known property order; older/raw-order layouts that do not match remain ineligible for optional linking without changing dispatch behavior.

Snapshot, measurement, version, head, workspace revision and fixed audit row commit atomically. Existing owner/session/head/CAS and replay controls remain. A same-intent owner retry returns its original historical receipt, without moving a newer head. No automatic publication retry is added.

Correction creates a new reviewed version. Exact immutable reuse resolves by tenant, same logical outcome, version and source digest, so changed or deleted mutable action/approval/connection/objective data is not needed. Withdrawal copies the preceding immutable source and measurement, preserves any later unrelated draft, and remains final under existing rules. Historical bytes are never patched.

## Read, size and compatibility bounds

- Source snapshot: at most 24 KiB canonical UTF-8 and 32 KiB JSONB text, without truncation
- Measurement: existing 8 KiB serialized/canonical and 12 KiB JSONB bounds
- Outcome payload: existing 16 KiB JSONB bound
- Primary state: existing 2 MiB ceiling
- Selected review and exact version evidence: existing 128 KiB response cap, including final returned envelopes
- Action choices: at most 20, at most 16 KiB in the server adapter

Action descriptions are returned only by the existing exact version evidence request. Summary/current queries exclude `source_action`. Historical evidence reports `currentStatus: not_checked`; it does not grant current-head authority. Safe escaped rendering verifies exact linked source identity and digest before displaying stored text.

Without the compatible SQL contract, existing unlinked v1 publication and reads remain available; new linked saves fail closed. An old-schema missing-column evidence error permits one bounded fallback read, only for unlinked v1. FileStore does not publish immutable outcomes. No migration runs at startup.

## Authority and release boundary

This descriptive association authorizes no financial execution, objective success, causal attribution, comparison grouping, learning, ranking, forecasting or spend. Original milestone 2 is not complete.

The migration is prepared and tested only in disposable localhost PostgreSQL 17 with synthetic records. Applying it to the real database, replacing the live publisher, deploying/merging the consumers, or creating real action/outcome demonstrations remains held for explicit reviewed release approval. A real association requires the owner to select and attest the actual action and measurement. Stronger execution-time immutable receipts remain outside this persistence contract.

### Reader-first rollout, only after separate approval

Deploy the backward-compatible application/readers first and verify existing unlinked v1 behavior before applying this forward SQL. New linking stays unavailable until its compatible SQL contract is present. The new review RPC adds fields that the previous reader's exact-shape validator rejects, so applying SQL first while old readers remain would temporarily break selected review. This is a sequencing requirement for a later authorized rollout, not permission to deploy or apply the migration now.
# Objective-origin content boundary

The separately prepared [objective content bridge](objective-content-bridge.md) creates owner-requested `runvara-objective-dispatch-proposal/v2` content actions. They are outside this document's manual v1 `recordedActionContext`/`source_action` union. A successful v2 action keeps its known completion with optional evidence marked `objective_origin_unsupported`; it is never relabelled `owner_manual` or given a fabricated null originating objective. No SQL or outcome-union expansion is included. Existing manual v1 bytes and publication behavior remain unchanged.
