# Saved goals and request history in Command

The existing on-demand business-relationship inspector now consumes a small
`retainedRequests` envelope from the same `/api/business-graph` projection. It
shows saved goal states, retained connection-request states, and the exact
recorded relationships that can be established inside the inspected snapshot.
The explicit inspector requests `outcomes=current&detail=true` once. It adds no
background polling or alternate request/reconciliation workflow.

## Recorded relationships, not execution permission

Two new node families (`objective`, `connection_write`) and two relationship
kinds (`request_recorded_approval`, `request_recorded_objective`) join the existing
graph. Their IDs and the display request reference are workspace-salted hashes.
Structural source pointers remain snapshot-relative. Raw request/write/approval/
objective IDs, actor/account names, input content, source envelopes, job results,
credentials and error bodies are absent from the DTO.

The request-to-approval relationship needs a unique primary approval ID and a
unique reciprocal `payload.connectionWriteId`, a matching actual input digest,
and the expected saved proposal digest when present. A second approval with a
different ID claiming the same write remains a conflict. Duplicate primary write
IDs or duplicate request IDs cannot establish a unique request. Existing generic
graph aliases remain compatible; these new relationships never use `externalId`.

Only the supported v2 `owner_objective_content` proposal creates a recorded
objective relationship. Its exact envelope and source shapes, 8 KiB envelope
ceiling, canonical digest, actor, provider, operation, account, connection, write,
input, independent approval binding and source/policy objective binding must be
self-consistent. Validation uses already-inspected retained records; it does not
reconstruct a source or consult a live validator. V1 `owner_manual` policy lists
remain restrictions, never objective origin. A no-envelope legacy request has
origin `not_recorded` and may still have an exact approval relationship.

A valid recorded objective association survives a valid saved revision or
definition change. `revisionComparison` separately reports
`matches_retained_definition`, `saved_revision_changed`, or
`saved_definition_changed`. The current saved definition is normalized one
already-bounded row at a time using the same definition normalization as the v2
producer. Matching those fields does not establish job availability, source
freshness, current ownership, provider permission, or execution eligibility.
Unsupported/malformed objective definitions remain unresolved.

Recorded request states include pending approval, ready, executing, processing,
completed, uncertain, failed and rejected. Approval decision and request state
are separate. Saved goal states include active, paused, disabled, completed and
cancelled, with scheduled/expired derived from its saved window at inspection.
Ready is not authorization to execute. Completed is not goal attainment, a
qualified outcome or financial progress. An uncertain/failed request is not safe
to replay. A mutually consistent privileged rewrite can satisfy these mutable
record checks: they do not provide independently authenticated immutable proof.

## Coverage, limits and compatibility

The DTO contains `objectives`, `records`, typed relationships, inspected/projected
counts, omissions, coverage and explicit false execution/progress/proof/causation
safeguards. Unknown collections differ from an explicitly empty retained array.
Absent, null, malformed, truncated or invalid indices cannot establish uniqueness.
The inspector reports incomplete inspection without claiming complete lifetime
history. Missing targets mean absent from the inspected retained snapshot, not
deleted or never created. `archiveReadsPerformed` remains zero.

Existing shared source-record, nested-row, scan, node, edge and unknown-mapping
budgets apply. New top-level families reserve their entries before catalogue
children expand. Descriptor-aware validation rejects getters, non-data records,
unsupported deep shapes and consumed foreign tenant markers before selecting a
provider/origin/status. Nested containers and array members consume the same
remaining scan allowance; arrays obey the current nested limit. Each retained
record also has a pre-hash budget of 4,096 values, depth 12, 128 own object fields
and 128 KiB of JSON UTF-8 data. Write response/error bodies are not consumed.
There is no unbounded full-collection second scan to recover uniqueness.

The existing endpoint fixes detail to 50 root records per collection, 25 nested
rows, 2,000 scans, 200 nodes, 400 edges and 100 unknown mappings. Summary retains
its existing smaller bounds. Callers cannot expand those route limits. The new
redacted envelope is limited to 16 KiB summary / 64 KiB detail. Byte trimming
removes display records, their nodes, attached edges and unknown mappings
consistently, and reports omissions. Every resolved displayed link has an
included target node. Incomplete indices, ambiguous references, missing targets,
archived targets, omitted nodes and edge exhaustion have distinct closed reasons.

The separate reviewed-outcome extension keeps its prior 16 KiB summary / 128 KiB
detail bound. Its accounting still includes all graph metadata, including the
new DTO. If necessary, history rows are trimmed consistently before outcome
rows/groups are trimmed. This remains an extension cap, not a byte cap on the
whole legacy detail graph. Existing outcome publication/qualification semantics,
financial KPIs, learning priors and the manual-only `source_action` union remain
unchanged. Stricter descriptor/scope checks may omit malformed approval rows that
legacy generic graph traversal formerly accepted; valid legacy relationships and
aliases remain compatible.

## Read cost and verification boundary

The route already loads one full current workspace. Opting into current outcomes
adds its existing separately bounded current-head read. This projection adds
zero database, job, archive or provider reads and zero writes. In-memory limits
do not cap the database cost of loading the existing workspace snapshot.

Tests use the real v2 preparation fixture with injected fake persistence and
transport, freeze the prepared state, and assert unchanged state and zero
post-setup job/credential/save/fresh-state/provider counters. They cover v1 and
legacy rows, all recorded states, changed definitions, duplicates and aliases,
reciprocal conflicts, unknown/archived/incomplete targets, malformed and oversized
proposals, foreign nested scope, accessor traps, coherent mutable rewrites and
shared/UTF-8 budgets. Auth tests exercise all authenticated roles with one
workspace plus one current-outcome read, redacted real v2 rows and explicit traps
for job/archive/evidence/provider reads and writes. Existing graph/outcome suites
preserve qualified-publication and financial boundaries.

Local Chromium remains outside the permitted local verification path. Exact-head
synthetic CI/browser checks and review are coordinated separately; this document
does not claim release, production health, real provider application or completed
Runvara OS acceptance. No migration, grants, new scopes, credential changes,
autonomous proposals or deployment operation is part of this slice.
