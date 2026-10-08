# Reviewed action snapshots, preparation only

This slice associates one owner-selected recorded Shopify `product_content` action with one typed measurement. The existing owner/session/workspace-CAS/head-checked publication transaction stores the exact bounded action snapshot in the existing immutable outcome version. It is an extension of the existing app, not another execution or outcome service.

**Immutability begins at outcome publication.** The prospective execution context and workspace action remain mutable beforehand. The source is an application-recorded provider acknowledgement, not a provider-signed receipt or independent verification of external truth. A coherent forged pre-publication workspace record is not made authentic merely by matching hashes.

## Recorded execution context

Only the successful supported dispatcher branch records `recordedActionContext`, with the existing exact final save. It retains tenant/write/request/claim identities, the original claim fingerprint, exact input and dispatch request fingerprints, Shopify account/connection/API version/product/result identity, actor and completion time, captured approval decision, and every applicable policy reference. Input text remains once in `write.input`; it is not copied into the context.

A manual action keeps `origin: owner_manual` and `originatingObjective: null`. Policy ID/revision/digest references describe restrictions that applied to this manual action, not its originating objective. No matching restrictions means an explicit empty policy list and null proposal. Current objective bodies need not remain unchanged to describe an earlier captured proposal, but a fresh association must match the recorded write proposal and approval decision exactly.

The prospective context uses the existing terminal save, without another provider mutation, persistence acknowledgement write, or automatic retry. A lost/malformed final save response remains an execution acknowledgement error. If its bytes actually committed, a later authoritative publication read may validate them; it does not prove the original process received that response. No `acknowledged: true` assertion is stored.

If optional evidence construction or byte limits fail after a known provider response, completion and the known result remain unchanged. Linking context is omitted; a small unavailable reason is retained only when it fits. A conservative 16 KiB headroom below the existing 2 MiB state ceiling covers ordinary final-store metadata. Existing unrelated primary-save failures remain errors, never a reason to replay the provider action.

Legacy completed flags, work records, archive entries, copied DTOs, claims without a known matching result, failed/processing/uncertain actions, and records missing the new context cannot qualify.

## Explicit association and review

The measurement save request can supply only:

- `actionSelection: null` to save an unlinked measurement
- `actionSelection: { actionId }` to select a currently recorded action
- `actionSelection: { reuseVersionId }` to reuse an exact immutable snapshot already published for this experiment

Caller-supplied tenant, hashes, approval/context/source bytes or resolvers are rejected. The authenticated server resolves the selected record. Linked drafts require an explicit selection on edits, including explicit removal. The revision and digest advance on save.

Unlinked v1 canonical measurement/report bytes remain unchanged. Manual-linked measurements use `runvara-experiment-measurement/v2` and `runvara-measurement-report/v2`. Objective-content associations use the explicit forward measurement/report v3 union described below. Both digests cover the same compact intervention:

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

Within outcome views, full action descriptions are returned only by the existing exact version evidence request. Summary/current queries exclude `source_action`. Historical evidence reports `currentStatus: not_checked`; it does not grant current-head authority. Manual v1 rendering verifies its full linked source identity and digest. The redacted v2 reader verifies available public references and measurement/publication hashes; the server validates its private source before projection. Both render stored text safely escaped.

Without the compatible SQL contract, existing unlinked v1 publication and reads remain available; new linked saves fail closed. An old-schema missing-column evidence error permits one bounded fallback read, only for unlinked v1. FileStore does not publish immutable outcomes. No migration runs at startup.

## Authority and release boundary

This descriptive association authorizes no financial execution, objective success, causal attribution, comparison grouping, learning, ranking, forecasting or spend. Original milestone 2 is not complete.

The migration is prepared and tested only in disposable localhost PostgreSQL 17 with synthetic records. Applying it to the real database, replacing the live publisher, deploying/merging the consumers, or creating real action/outcome demonstrations remains held for explicit reviewed release approval. A real association requires the owner to select and attest the actual action and measurement. Stronger execution-time immutable receipts remain outside this persistence contract.

### Reader-first rollout, only after separate approval

Deploy the backward-compatible application/readers first and verify existing unlinked v1 behavior before applying this forward SQL. New linking stays unavailable until its compatible SQL contract is present. The new review RPC adds fields that the previous reader's exact-shape validator rejects, so applying SQL first while old readers remain would temporarily break selected review. This is a sequencing requirement for a later authorized rollout, not permission to deploy or apply the migration now.
## Objective-origin content forward union

Prospective successful [objective content bridge](objective-content-bridge.md) actions now use `runvara-recorded-action-context/v2` and `runvara-reviewed-source-action/v2`. Both retain `origin: owner_objective_content` and a mandatory captured `originatingObjective: {workspaceId,id,revision,digest}`. Its real saved objective ID, revision and definition digest match the full original proposal/source and a captured restriction reference. They are never inferred from a later objective or replaced with a null/manual origin. Existing completed v2 records without the new context stay unavailable; there is no historical backfill.

The dispatcher owns the full original proposal and approved decision before asynchronous execution. It constructs optional context after the known response, outside the provider-result catch and in the same final save. Source removal, owner removal, expiry or other later eligibility loss does not overturn a confirmed result, provided the original exact request/approval/claim/admissions and workspace CAS still hold. No new job or provider read is introduced. Size or unsupported-shape failure omits optional context with `source_size_limit` or `context_unavailable`; it never truncates content, adds a save, replays a provider mutation or downgrades known completion.

V2 also retains exact private `stableApproval` bytes: id, type, action, reason, financialImpact, expectedBenefit, risk, requestedBy, source, payload, evidence, revision, agentId and createdAt. The payload contains connectionWriteId and digest; only the existing cycle-breaking proposal digest is excluded. JS and SQL independently hash the complete bounded stable body and compare it to the proposal approvalDigest, separately from the compact decision digest. Unknown future stable fields are unsupported. The body is capped at 8 KiB canonical inside the unchanged 24 KiB complete source bound. Text preserves the producer's trim-then-slice bytes, including trailing whitespace at the maximum length. Two exact typed evidence entries bind the recorded diagnostic report and product.

The original claim fingerprint is reconstructed using the v2 producer's actual JSON.stringify property order, including its full source and approval binding. Request and input fingerprints are unchanged. The source's reconstructible prepare-payload digest and deterministic report ID are independently checked; absent diagnostic job/report bodies are not reconstructed or authenticated. The original diagnostic source remains server-recorded mutable history. Publication-time immutability still does not prove execution-time immutability, provider truth or causation.

An explicit objective-content selection creates `runvara-owner-action-association/v2`, with the same existing action/approval/account/product/completion/reuse references plus origin and originatingObjective. It is bound into `runvara-experiment-measurement/v3` and `runvara-measurement-report/v3`. Generic publication/measurement links.objective and links.opportunity remain null: no opportunity revision is invented, and captured action origin is not a new outcome-to-goal attainment relation. Existing unlinked v1, manual association v1 and manual-linked measurement/report v2 bytes are unchanged.

### Public evidence and reader boundary

The persistence adapter retains full validated source_action internally for correction/reuse. The all-role authenticated exact-version HTTP endpoint constructs a separate explicit DTO for v2 sourceAction, with schema `runvara-reviewed-source-action-display/v2`. Its only fields are:

- action and approval refs, each workspaceId/id/revision/digest
- origin and originatingObjective (the same compact historical objective ref)
- account, productId, completedAt
- input: productId, operation, exact title and description
- decision: approved status, decidedBy and decidedAt
- policies: objectiveId/revision/digest references, at most 50
- validation: snapshot `server_validated_immutable_publication`, currentStatus `not_checked`, providerAuthentication and causalAttribution `not_established`

No full proposal, diagnostic source, stable approval, decision history/note, session/security epoch, claim/request binding or unknown future field is exposed. Public action/approval/objective IDs and exact content remain intentional. The full public source is capped at 24 KiB canonical and the complete response at 128 KiB. The browser verifies the public shape, reciprocal refs and public measurement/publication hashes; it cannot reconstruct the omitted private source digest and labels those private checks as server validation. Manual full v1 evidence and its browser canonical verification remain unchanged.

Selected review returns v2 origin/objective refs only in objective choices and current association, under the existing 20-choice/16-KiB caps. Measurement PUT returns the public measurement/assessment. Publication POST returns the existing bounded publication. Summary/current and graph queries exclude source_action. Generic bootstrap, Connection Centre and approval DTO allowlists remain closed. Dedicated owner source/reconciliation paths retain their existing purpose without exposing the new private context. Existing tenant/session checks apply to all reads; owner/admin may draft/review and only owner may publish.

### Storage capability and reader-first release

`runvara-reviewed-action/v1` storage continues supporting unlinked/manual actions. `runvara-reviewed-action/v2` explicitly advertises the forward union. Objective selection/reuse requires the latter; unknown markers and mismatched schema/marker combinations fail closed. The held manual SQL migration remains unchanged; `20261008055400_objective_action_outcome_snapshot.sql` is the separate forward migration. It extends the same validators, publisher and review without changing public signatures, grants or roles.

Any future release requires compatible readers first, verification of old unlinked/manual flows, then separately authorized forward SQL application and verification. Installing the forward marker already makes v1-only selected-review readers incompatible, even before the first v2 publication, so retain readers that support both markers from that point. A compatible reader must remain for existing v2 publication, correction, reuse and withdrawal even if new v2 preparation/linking is disabled. Never patch immutable records or downgrade origin to regain old-reader compatibility. Publication compatibility is separate from executor safety: pending v2 requests still require envelope rejection guards, and production `d32da62d0e7935597638266d44d88ae5e066d51f` remains an unsafe rollback executor once v2 requests exist. No real migration, deployment, provider activity or new grant is authorized by this preparation.
