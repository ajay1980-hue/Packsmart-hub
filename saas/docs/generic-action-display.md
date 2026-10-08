# Generic write and approval display boundary

Generic HTTP responses project retained connection writes and approvals through
`server/lib/action-display.mjs`. They never return the stored record itself.
Projection occurs after the existing read or mutation has completed, allocates
fresh nested objects, and performs no storage, diagnostic-job or provider reads.
It changes neither persisted bytes nor the proposal, approval, claim or input
digests used by execution. It introduces no migration or storage capability.

## Deliberately public fields

Write views retain explicit scalar IDs, account/connection/requester references,
status and timestamps, approval navigation, input digest, error/observation codes
and dispatch-blocked state. The input digest remains necessary for exact manual
request reconciliation. Supported input schemas are Shopify product content,
internal notes and add/remove tags, and Meta catalogue creation/update,
inventory/visibility, Facebook publish/update and Instagram publish. Their
known fields are individually typed and copied. Strings remain byte-exact,
including Unicode, line breaks and an empty description; tag arrays are copied
only when every element is a string. Results contain only the supported
external ID, confirmation flag and recovery text. Unknown operations produce an
empty input display; malformed scalar values are omitted rather than coerced.

Approval views retain the existing public action, reason, benefit, risk,
financial impact, requester, source, status/decision/execution bookkeeping and
timestamps. Payload retains only connection-write, opportunity, experiment and
campaign navigation references plus the two existing experiment flags. Evidence
contains only type, ID, detail and timestamp. History contains only the existing
review/decision scalar fields and separately projected evidence. Unknown nested
fields and object-shaped values under known scalar keys cannot pass through.
The same approval projection applies to every origin, without locating a
related write or scanning another collection.

These are intentionally public business narratives and diagnostic references.
This boundary does not promise identifier secrecy or arbitrary text DLP.
Already-public objective/report/opportunity references in generated reasons,
evidence and history remain visible to every currently admitted tenant role.

## Display source versus validation source

The optional `sourceDisplay` uses a separate schema,
`runvara-objective-content-display/v1`. An available objective display contains
only `schema`, `origin: owner_objective_content`, `status: available`,
`objectiveId`, `objectiveRevision`, `jobId`, `reportId`, `opportunityId` and
`productId`. Its supported origin/schema, typed bounded references and
provider/operation/product agreement are checked locally. This is presentation,
not cryptographic validation or execution authority.

A malformed objective envelope retains an objective-origin unavailable marker;
an unsupported envelope retains an unknown-origin unavailable marker. Neither
returns raw source nor silently becomes manual. Valid manual v1 and legacy
records omit the optional display. The browser consumes this schema in Approval
Centre and Connection Centre, including the owner's bootstrap handoff.

All generic views omit the full objective proposal/source, actor security epoch,
source and approval binding material, dispatch claim, provider state, recorded
action context, stable approval snapshots and future private fields. The owner
also receives only this display through generic routes. Optional malformed
source/accessor material cannot throw during projection after a known result.

## Covered response aliases and unchanged admission

- Bootstrap, Connection Centre and approvals list retain all current tenant
  roles and the existing write limits.
- Actions and opportunity approval creation/reuse retain non-viewer admission.
- Marketing approval creation/reuse and generic write preparation/reuse retain
  owner/admin admission, including the existing original-author checks for
  manual content.
- Approval modification/decision and write execution retain owner-only
  admission. Execution projection covers new completion, already-completed
  returns and Meta processing, after the unchanged save sequence.

Dedicated objective context/preparation/request reconciliation continues to
return its exact full source under the existing owner, actor, session and tenant
checks. Dedicated manual reconciliation retains its exact ten-field request
and original owner/admin-author checks. The existing exact manual immutable
outcome evidence remains full, canonical and strict; its source validator and
manual-only schema are unchanged. This repair adds no objective-origin outcome
union or new publication capability.

## Verification

`action-display.test.mjs` covers every supported input, nested value canaries,
object-shaped scalar rejection, descriptor-safe optional lists, source
availability, copied-object isolation, manual immutable canonical bytes and
real synthetic objective dispatch counts. `generic-action-display-api.test.mjs`
uses localhost HTTP for the tenant-role matrix, foreign tenant isolation,
creation/reuse/decision aliases, exact reconciliation, persisted authority and
actual synthetic execution, including Meta processing. Existing dispatch tests
also verify projected manual success and optional context size failures preserve
three saves and one provider mutation, with no replay. These are synthetic
checks, not a live provider operation, database migration or deployment assertion.
