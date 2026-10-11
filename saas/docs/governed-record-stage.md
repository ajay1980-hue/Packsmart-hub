# Governed record producer stage

This is release preparation. It does not install SQL, grant access, activate a
provider, or establish live readiness. The source baseline is the cumulative
`73036459` tree, including the recorded-cost, Doctor busy, and drain semantics.
The earlier `9bb9dd39` compatibility bridge is not a reader for receipt-backed
measurements and is not a qualifying rollback target for this stage.

## Startup contract

`GOVERNED_RECORD_PRODUCER_CONTRACT=runvara-governed-record-producers/v1` is the
only enabling value. Absence, other strings, whitespace, booleans and unknown
versions are closed. The server and persistent store independently capture
their startup configuration. A request body, HTTP header, tenant setting or
copied capability object cannot enable it. An adapter caller may narrow a
store's stage, but cannot reopen a closed store.

This setting is process-wide. It is neither a per-business pilot setting nor a
shared fleet latch. Changing an environment object does not change an existing
process. Closing new admission requires replacing and actually draining every
previous open process, then reconciling retained attempts. A shutdown timeout
does not establish termination, cancel provider work or make it safe to retry.

The closed response is `503 GOVERNED_RECORDS_PAUSED`. Supported retained records
remain readable. The gate is not authority to execute: all existing roles,
current source checks, objective restrictions, exact approval bindings,
credential checks, quotas and database fences still apply when open.

The affected editors recognize only that exact HTTP status and API error code
as a known first-attempt refusal. An earlier lost response remains uncertain
even if a later retry receives the gate response. The retained exact request is
not cleared or given a new identity. Other 5xx responses, code-only exceptions
and client-supplied tags do not establish refusal. Existing reload/review and
session/navigation fences remain in force; no action retries automatically.

## Closed-stage producer and maintenance matrix

| Boundary | Closed behavior |
| --- | --- |
| Create/edit an enforced business objective | Refused before changing state, including disabling it or removing its policy. Ordinary planning-only objectives remain editable. |
| Manual proposal matching an enforced policy | New proposal refused. Exact retained original-ID reconciliation returns without a save. |
| Objective/content request | New v2 request refused. Exact retained original-ID lookup/reconciliation remains available. |
| Generic approval request carrying governed markers | Refused before adding an approval or audit record. Ordinary requests remain available. |
| Edit an existing governed approval | Refused by both the callable modifier and HTTP route. Broken or one-way write references remain governed; ordinary edits retain their existing revision checks. |
| Approve a governed request | Refused. Related write classification does not depend on a valid companion digest. Null, malformed or unknown markers do not become legacy authority. |
| Reject an existing governed request | Existing explicit rejection remains available. It grants no external authority. |
| Execute governed content | New admission refused before credentials, claims, reservation, provider submission or persistence. Existing completed/uncertain reconciliation retains its existing rules. |
| Reserve a protected receipt | Refused by both persistent-store reservation boundaries. A mandatory database capture requirement never falls back to unprotected submission. |
| Finalize an already admitted result | Existing claim/session/CAS/receipt checks continue. Closing admission does not erase a known result or authorize another submission. |
| Ordinary unmarked manual content/tags/notes/Meta | Existing restrictions and workflows remain. Closed ordinary content does not add new optional recorded-action context; existing context is preserved. Required receipt capture can still block an unprotected attempt. |
| Record, replace, reuse or detach a linked measurement | Refused before source reads or state assignment, including omission of selection on an existing linked draft. Ordinary unlinked v1 measurements remain available. |
| Publish/correct a linked result | New version refused. A v1 draft cannot hide a linked previous publication or down-convert it. |
| Publish/correct an ordinary unlinked result | Allowed only after bounded authoritative review and the existing atomic SQL CAS. Independent publication pause still applies. |
| Exact historical publication replay | Read-only reconciliation using the original publication ID, all original intent fields, the current head and current owner/session. A miss cannot invoke the publisher while independently paused. |
| Withdraw an existing result | Explicit safety maintenance is allowed while publication itself is enabled. Immutable previous source, current head, workspace, owner/session and original measurement fences are required. This creates a new withdrawal version and is not described as read-only. |
| Ordinary imports, connection checks and OAuth | The new stage does not globally pause them or grant new permissions. Their existing durability, cooldown and uncertainty rules remain. |

Pure validators and evidence builders are not durable producer boundaries.
Actual HTTP handlers, callable preparation/dispatch modules and persistent
reservation/publication adapters enforce admission. Existing scheduled workers
do not gain a new governed content dispatcher through this change.

## Publication reconciliation and safety withdrawal

The existing SQL publisher's intent digest covers the ordered twelve fields:
workspace, actor, session version, publication ID, action, experiment, expected
workspace revision, expected measurement revision and digest, expected head
version and digest, and withdrawal reason. A matching payload digest alone is
insufficient. Closed replay validates the stored immutable version and intent,
then reads the current head and fresh owner/session identity. It creates no
version and performs no cache invalidation or generic snapshot save.

A closed withdrawal uses the exact immutable source from the current head.
Mutable draft changes, missing approvals/connections, or newer action context
do not substitute evidence. The existing publisher independently rechecks its
transactional fences and copies the previous source into the withdrawal.
Source swapping, new publication IDs used as replay, altered intent, stale
heads/revisions, foreign tenants and revoked sessions fail closed. Failed or
uncertain publication responses are not automatically retried.

The new SELECTs use existing server-authorized access. The owner identity read
selects the workspace identity/revision, root tenant markers and bounded users
JSON text rather than the full workspace. Its response is private and never
returned as a public DTO. Users remain bounded by the existing 256 KiB/500-user
contract; the JSON response envelope allows 516 KiB for escaping. Root marker
absence is distinguished from explicit JSON null by the database filter.
Malformed identity, duplicate actors or uncertain authority are rejected.
Malformed non-string user IDs make this bounded identity proof unavailable;
they are not coerced into strings to manufacture an authenticated actor.
The numeric session token is inspected in the raw JSONB text before accepting
its parsed value. JavaScript rounding cannot turn a fractional token into a
valid integer. Accepted lexical forms must agree with the existing publisher's
actual cast, not only its preliminary numeric validation.

Read-only preflight is not atomic permission. The subsequent unchanged publisher
RPC owns the actual transaction and rechecks workspace/head/source/session
fences. If these existing contracts cannot establish eligibility, the client
must reload/review; no additional SQL or permissions are implied.

## Storage and operational rollback

The intended pair uses one immutable candidate artifact twice: open producer
configuration and default-closed producer configuration. This demonstrates
configuration rollback for that artifact. It does not demonstrate recovery
from a defect in the artifact, compatibility with an arbitrary future binary,
or permission to return to the old production binary after newer state exists.

Both configurations retain the same readers, financial validation, truthful
busy status and shutdown bookkeeping. They preserve already-created records,
uncertain attempts and original digests. No snapshot restoration, data deletion
or migration reversal is part of the switch. Existing unrelated concurrent
writes must survive.

Receipt capture and Shopify recovery remain separate process/database contracts.
Keep required reader/finalization capabilities installed while closing new
admission. Do not clear the recovery capability as a reader rollback: it also
controls private recovery reads. Recovery's database pause has different
first-finalization semantics from protected content receipts. This stage does
not change those SQL controls or authorize activation of either feature.

Before live use: verify the exact artifact and installed storage profile,
complete applicable database/browser/container checks, establish fresh permitted
live runtime evidence, verify predecessor drain/termination and retained attempt
reconciliation, and obtain the separate installation/access/activation decisions.
Green synthetic CI does not establish these live facts.

## Verification and limits

The candidate's focused tests cover closed defaults, fake opt-in, direct-module
and HTTP bypasses, approval companion mutation, zero-save exact reconciliation,
linked draft downgrade attempts, immutable-source withdrawal, replay intent,
request ceilings, current owner/session fences, and admitted result completion.
The process harness uses actual server/store/dispatcher modules in distinct
processes with disk-retained synthetic transport. It is not a real database or
provider test. Disposable PostgreSQL tests separately exercise real JSONB and
transaction contracts. A SQL-backed HTTP-shaped adapter is not a complete
PostgREST deployment test; its URL parsing/projection behavior needs independent
qualification in the final evidence.

Final exact-source test counts, source hashes, measured request/byte deltas,
storage-profile results and remaining checks belong in the candidate's release
evidence. This document does not assert that an unfinished check passed.

## Bounded transport cost

These are adapter-level measurements from synthetic fixtures, not provider or
billing amounts. They include JSON request bodies and response bodies, excluding
request URL/query bytes, HTTP headers, TLS, retries outside the adapter and network framing. Separate evidence also measures adapter path/query sizes; it is still not full wire cost. No dashboard
polling, bootstrap reads or background metering loop is added by this stage.

| Explicit publication attempt | Requests / mutating RPCs | Observed response bytes | Sum of response ceilings |
| --- | ---: | ---: | ---: |
| Open stage | 1 / 1 | 2,354 | 131,072 |
| Closed, unlinked initial publication | 3 / 1 | 4,861 | 393,216 |
| Closed, unlinked correction | 4 / 1 | 12,040 | 524,288 |
| Closed, exact retained replay | 3 / 0 | 2,900 | 663,552 |
| Closed, immutable-source withdrawal | 5 / 1 | 10,977 | 925,696 |
| Closed, stale or linked-denied attempt | 2 / 0 | 2,507 / 3,950 | 262,144 |
| Legacy schema correction, both existing compatibility fallbacks | 6 / 1 | 11,878 | 786,432 |
| Legacy schema withdrawal, missing source_action fallback | 6 / 1 | 7,506 | 1,056,768 |

The identity projection accounts for the larger replay/withdrawal response cap.
A malformed initial replay response stops after its first bounded read. Each
compatibility fallback is a single existing-contract read, not an automatic
mutation retry. These bounds are per explicit attempt; normal rate limits still
apply. The feature adds traffic to closed-stage maintenance/reconciliation and
does not claim bandwidth savings.
