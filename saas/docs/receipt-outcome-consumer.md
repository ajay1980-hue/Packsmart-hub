# Protected content sources in outcome review

This forward preparation connects an exact protected Shopify content completion
to the existing experiment draft and owner outcome publication. It does not
activate capture, apply SQL, change live permissions, or release the application.
The receipt itself records the application's observed provider confirmation at
the completion workspace commit. It is not provider-signed or causal evidence.

## Source selection and authority

The explicit selection is `actionSelection: { receipt: { attemptId,
receiptDigest, sourceDigest } }`. These are comparison assertions, not client
authority. The server reads the exact same-workspace immutable admission and
receipt, validates their bindings, and derives a
`runvara-protected-content-source/v1` reference containing workspace, attempt,
receipt/source digests and the original protected commit revision.

Original `runvara-reviewed-source-action/v1` and `/v2` source objects retain
their canonical JSON and digests. No current approval, connection or optional
`recordedActionContext` is needed to reconstruct the historical protected source.
The completed write's existing immutable identity and result guards remain.
No historical action is backfilled, and no receipt is inferred from Shopify's
current state or a mutable stored reference.

Owners and admins retain review and draft access. Only an owner can publish,
correct or withdraw a reviewed outcome. Review uses the current authenticated
actor/session, rather than requiring the original executor's historical session.
The original execution acknowledgement RPC remains unchanged and source-free.

## Versioned binding and privacy

A protected measurement uses `runvara-experiment-measurement/v4` and its report
uses `runvara-measurement-report/v4`. Both contain the same bounded receipt
reference. Existing canonical measurement/report digests bind these references
and the unchanged intervention. Legacy measurement versions retain their exact
grammar. The business-outcome payload stays v1, with its source measurement
digest binding the new provenance.

The narrow service reader returns private selected evidence only to the server.
HTTP responses explicitly construct a safe display object for both protected
manual and objective sources. Admission, actor/session authority, private claim,
stable approval and proposal payloads must not reach generic workspace, review,
error or browser responses. Displayed protection is a historical persistence
boundary, not present permission, eligibility, independent provider authentication
or causal attribution. Manual origin never invents an objective.

The receipt row has no database commit timestamp. `completedAt` remains the
application's completion observation; the protected commit revision is separate.

## Bounded reads and storage

The combined reader replaces the existing review read on compatible storage.
It returns at most 20 protected choices and 16 KiB per explicit page, separately
from the existing legacy choices. Scanning is bounded by the retained 256
attempts per workspace. A cursor and `hasMore` describe the page; unresolved
admissions are not completed choices. Paging and preview are explicit user
actions, with no background polling or provider calls.

An exact selector is at most 512 bytes; a server-derived reference at most
2 KiB in canonical UTF-8 and JSONB text. Selected evidence is at most 42 KiB;
the complete combined review response remains at most 128 KiB. Existing source
limits remain 24 KiB canonical UTF-8 and 32 KiB JSONB text, inside the receipt's
36 KiB limit. Measurements remain within the existing 8 KiB application and
12 KiB database bounds; reference growth is checked before saving.

Publication continues storing a source copy of up to 32 KiB per immutable version
in the existing `source_action` column. Its measurement holds two bounded
references within the unchanged measurement limit. Corrections and withdrawals
can retain further copies. These copies are outside the receipt's reserved
40 KiB allocation. There is no new aggregate publication-retention ceiling or
physical-storage/billing guarantee. Source copies keep published evidence usable
without a later receipt lookup.

Compatible ordinary review and protected draft resolution each use one combined
database HTTP read. A requested page or preview adds one read for that action.
Publishing remains one existing mutation RPC, with exact receipt resolution
inside its transaction. Published evidence and immutable-version reuse use
their existing version read. One missing-function fallback can serve legacy
work on older storage; protected, denied, malformed or unknown contracts never
downgrade into that path. Transport tests must verify these counts.

Every public review, page and preview validates any saved v4 provenance against
its exact receipt or same-outcome immutable reused version, even when the read
previews a different receipt. An internal draft-compatibility mode can omit
that old-source resolution while replacing an association. It returns a null
measurement, so it cannot display unverified old provenance; public request
options cannot select that mode. The draft mutation still validates its exact
new source and the current workspace/measurement revision fences.

## Publication, correction and recovery

Draft preparation derives the intervention and provenance from exact private
evidence. The mutation rechecks current role/session, review workspace revision
and existing measurement CAS. It never rebases stale selection or silently
substitutes a newer receipt.

Initial publication or replacement with another receipt independently resolves
and validates the exact protected evidence inside the existing owner-authorized
transaction. The unchanged publication ID, measurement digest and revision/head
fences bind intent. An identical already-committed replay is resolved before
fresh source requirements; changed intent under the same ID conflicts.

An explicitly reused same-outcome immutable version retains its exact stored
source and provenance. Withdrawal retains the previous source measurement and
action unchanged. Neither operation reconstructs current mutable history or
claims a fresh ledger/provider check. Existing uncertainty handling and the
prohibition on generic saves after publication remain.

## Installation and rollback boundary

The forward migration prepares function definitions and one narrowly scoped
service-only reader grant. It adds no table, column, direct ledger SELECT grant,
browser-role access, capture quota, or historical backfill. Existing publisher
roles/signature and receipt immutability protections remain.

Reader/UI support must precede v4 draft creation. Missing, malformed, foreign,
oversized or altered protected evidence fails closed. Empty choices are distinct
from missing capability. Reader readiness does not activate receipt capture.

Once v4 data exists, rollback must retain compatible readers/publishers or pause
affected outcome writes with explicit unsupported-evidence handling. Preserve
all receipt guards, provenance and published versions. Do not down-convert v4,
delete records or restore an older publisher as a routine rollback. Real SQL,
grants, main merge, deployment, capture activation and live acceptance remain
separate held operations.

## Required preparation evidence

Verification covers protected source use after mutable context, approval and
connection removal; tenant/role/session and stale/forged reference rejection;
real JSONB and exact size boundaries; finite paging; draft CAS; publication
replay/uncertainty; correction/reuse/withdrawal consistency; legacy and rollback
readers; private serializers; measured transport counts; and affected mobile and
desktop interactions. Synthetic fixtures and disposable databases establish
preparation behavior, not production acceptance, financial basis or causal effect.

The disposable PostgreSQL 17.6 resource fixture traversed 256 synthetic retained
attempts in 13 finite pages. Its largest page response was 15,062 JSONB-text
bytes; first/slowest reads took 200.9/218.5 ms and all pages took 2.08 seconds
combined while other local test suites were running.
An exact 24,576-byte canonical source produced a 26,216-byte private envelope
and 32,607-byte complete review response. The 8,192-byte measurement passed;
8,193 bytes was refused. These are local fixture observations, not production
latency, physical storage or billing estimates. The function's 5-second timeout
setting alone is not proof of an enforced statement wall-time ceiling.
