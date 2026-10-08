# Current published result to retained request and approval

This locally prepared slice extends the explicit current-result graph inspection.
It uses the existing authenticated workspace snapshot and the existing bounded
joined current-head read. It introduces no persistence, database query, source
hydration, provider request, role, permission, polling, or execution capability.

## Relationship contract

The trusted current publication projector validates the current committed
head/version pair before carrying `actionReferences` internally. That value is
either null or the compact pair `action` and `approval`, each containing only
`id`, `revision`, and `digest`. Both references must exist together and use the
supported revision 1. A partial pair or unsupported revision exposes no reference
IDs and produces `invalid_reference_pair`; malformed publication payloads fail
the existing publication validation. Explicitly unlinked publications retain
null references. The intentionally null generic opportunity/objective links are
not populated or traversed.

Public `reviewedOutcomes.records` keeps its existing experiment `relationship`
and adds `requestRelationship` and `approvalRelationship`. Each has:

- `status`: `not_recorded`, `resolved`, or `unresolved`
- `reason`: null for not recorded/resolved, otherwise a reason below
- `snapshotContentCompared`: always false
- `targetNodeId`: present only for resolved relationships, using the existing
  workspace-salted graph identity

A resolved relationship says only that this exact publication version records
a reference to an admissible retained primary identity, and that the current
request/approval pair retains its reciprocal binding. It does not assert that
the mutable records still equal the published private source snapshot. The
publication source-action digest and retained write input digest cover different
contracts and are never compared. Even a coherently rewritten current input can
still resolve the identity; the false comparison flag remains explicit.

The public reasons are:

- `invalid_reference_pair`: missing partner or unsupported reference revision
- `unresolved_reference`: the exact primary target is absent from a complete index
- `ambiguous_reference`: duplicate primary target identity
- `archived_reference`: retained target has an archival marker
- `invalid_record`: unsupported or malformed retained target identity/status
- `target_index_incomplete`: unknown, invalid, or truncated target collection
- `source_identity_ambiguous`: duplicate retained request identity
- `source_index_incomplete`: the existing request binding assessment lacks a complete source index
- `unsupported_proposal` / `invalid_proposal`: existing retained proposal checks failed
- `approval_binding_mismatch`: retained reciprocal/current input/proposal binding is inconsistent, or the recorded approval ID differs from the current request
- `paired_request_unresolved` / `paired_approval_unresolved`: this target exists, but its required partner could not resolve
- `target_outside_projection`: valid target was not admitted to graph output
- `edge_limit`: the shared graph edge allowance was exhausted
- `output_byte_limit`: UTF-8 trimming removed an already linked target

`publication_recorded_request` and `publication_recorded_approval` edges use
`recorded-publication-reference` provenance. Edge identity includes the published
version/digest identity, so correction and withdrawal change the edge even when
the logical result and retained target are unchanged. A withdrawn association
can remain visible with withdrawn status; it contributes no measured total.

## Bounds and privacy

The retained projection builds its primary indices and reciprocal binding
assessment once, and returns a private resolver alongside its public DTO. Only
exact `id` matches resolve. External aliases, request IDs, products, titles, and
text never act as fallbacks. The bridge performs at most two map lookups for the
reference pair of each admitted current row; it never rescans source collections
or invokes the full action resolver per result.

The existing record/scan/node/edge/unknown limits are unchanged. Every new edge,
reason record, repeated version/source reference and public relationship field
is included in the existing reviewed-result extension UTF-8 budget (16 KiB
summary / 128 KiB detail). These remain extension bounds, not a new whole legacy
detail-response cap. Removed records account for their experiment reference and
their recorded pair. If byte trimming removes a retained target, the surviving
relationship is changed to `output_byte_limit`; no resolved dangling reference
or edge remains. Unknown-reason omissions and unavailable index coverage stay
visible.

Raw action, approval, source, proposal, product content, owner/account identity,
security epoch, input/source digests and raw record IDs remain absent from the
generic graph DTO. Workspace/current-head read times remain independent and
non-atomic. No source, measurement, job or archive is hydrated to strengthen the
identity label.

## Meaning and verification

The whole selected publication snapshot is qualified before graph truncation.
Amounts, measurement groups, learning comparability and existing safeguards
retain their prior semantics. The new identity links establish no current
eligibility, authority, execution-time immutability, causal/commercial/learning
proof, or goal progress. In particular, following a mutable retained request's
separate objective-origin edge does not create an immutable published-result to
objective-progress relationship.

Focused tests exercise manual/objective compact references through the real
current-head adapter and authenticated graph API for owner/admin/member/viewer;
foreign scope, copied proof, malformed/mixed references, primary-ID collisions,
missing/archived/ambiguous/incomplete records, reciprocal mutations, coherent
mutable rewrites, correction/reuse/withdrawal, independent snapshot races,
shared budget and UTF-8 trimming, privacy canaries, and qualification before
truncation. Synthetic transports do not establish database durability or
provider results. This slice adds no SQL. Final aggregate/CI/browser/release
evidence is tracked separately by the preparation coordinator; this document
does not claim publication or deployment.
