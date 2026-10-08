# Connection-write dispatch safety

This patch hardens the existing manually executed Shopify and Meta writes. It
adds no provider, publisher, allowance issuer, schedule, permission, or spending
capability. Approval Centre decisions remain decisions; marketing publication
without an implemented executor remains unavailable. Creative and web scanning
admission retain their existing closed defaults.

New manual Shopify content preparation additionally requires an explicitly
reviewed exact account assertion and requester-bound request-ID reuse. See
[manual content preparation](manual-content-preparation.md) for its bounded
target resolution, unknown-save reconciliation and draft-revision limitation.
This assertion does not change existing v1 claim/source-action bytes or the
legacy exact-approved apply contract described below.

## What is enforced

The proposed input is copied and frozen before asynchronous preparation. Its
identity, exact approved digest, connection/account, approving owner and current
executing owner are checked again at dispatch. The verified server session
identity and exact session version are frozen before any await; inactive owners,
role changes, revoked sessions and a required password change stop dispatch. The
request body cannot supply or replace this actor context. The transport also compares the
actual method, destination and serialized body against that prepared request;
a substituted payload or account cannot borrow its dispatch capability.

Shopify performs the check after token acquisition. Meta does so for each
catalogue/Facebook mutation and separately for Instagram container creation and
publication. Provider reads do not receive mutation authority. Both transports
reject redirects. Capabilities exist only in the server process; JSON flags and
plain callbacks cannot impersonate them.

Execution uses identity-only authentication, then the existing mutation path
loads the full state once. Fresh boundary reads use an indexed PostgREST
projection of the selected actor/approver, connection, approval and write, plus
workspace/provider settings and revision. Initial full-state uniqueness checks,
exact projected identities and the unchanged revision bind those indexes. Each
response is streamed under a 32 KiB cap; incomplete, ambiguous, foreign-scoped,
reordered, stale or oversized context blocks without a full-state fallback.

Each write first saves an execution claim. Each mutation phase then requires a
new revision-guarded save, an acknowledgement containing the exact workspace,
new revision and complete claimed write, and a fresh authoritative store read.
A no-op, missing, mismatched or ambiguous acknowledgement does not permit a
mutation. Production enables this boundary only for the existing Supabase
store, whose revision guard is enforced by PostgreSQL. FileStore does not grant
live dispatch authority: its lock is process-local. The final phase claim is persisted before the external request.

The acknowledged, revision-guarded phase claim is the dispatch authorization
point. A pause committed before that point prevents the claim or its fresh
verification from passing. A later pause stops subsequent work; it cannot recall
an already-authorized/in-flight HTTP request. This is not a distributed
transaction with Shopify or Meta. Each Instagram phase has its own authorization
point. Process-local locks alone are not relied on for replica exclusion.

Unknown replies, timeouts, interrupted claims and result-save conflicts are not
permission to replay. The durable phase remains claimed. A known Instagram
container can continue through its existing bounded status checks and a
separately claimed publish phase; it is never recreated for a retry. The returned
container ID is captured privately and persisted in its phase result. Later
status reads or save callbacks cannot substitute another container. A transient
or malformed status GET leaves the request in processing with a sanitized
observation error, so the existing manual check can inspect that same ID again.
The UI does not claim the image is preparing when its status is unknown. A later
publication still needs its own fresh claim and authority checks.

This recovery does not reset ambiguous container-creation or publication claims.
Those remain non-replayable. Failed or unacknowledged persistence, revoked
connection/approval authority, and terminal provider states may require checking
the channel directly; this patch does not promise universal known-ID recovery. A stopped
request with no new mutation attempt is displayed as locally blocked rather than
as a provider rejection. Existing failure and uncertainty records are retained.

Fresh checks are deliberately conservative: a concurrent workspace revision
change stops dispatch instead of merging a stale execution snapshot over newer
state. An unrelated manual approval is not persistently disabled by an
Autopilot-off setting; it can execute from an unchanged current snapshot.

A connection credential change during preparation, including a credential
refresh that changes the stored encrypted record, requires refreshing/saving
the connection before retrying the review. The dispatcher does not silently
substitute a newly selected account or credential context into an approved
request. No credentials are added to claims; only digests are recorded.

## Request and bandwidth bounds

There is no new polling. The route admits at most ten execution requests per
workspace per rolling hour through an early process limiter. An additional
bounded timestamp list in workspace state is saved with the execution claim;
its existing revision CAS prevents separate replicas from independently
admitting more than ten claims in the same hour. The controlled admitted array
is frozen and pinned through later saves and acknowledgements, including final
result persistence; a changed shared snapshot cannot erase it. Missing history initializes the
new request throttle only; it is not a monetary opening balance. Malformed or
future timestamps block. Existing writes, approvals and financial history are
not removed.

For a normal successful Shopify mutation, the boundary uses two projected reads
(at most 64 KiB in response bodies) and three full-state saves including the
executor's guarded final result save. The route skips a redundant outer save. Immediate Instagram creation plus publication uses
four projected reads (at most 128 KiB) and five full-state saves. The publish-start
marker is included in the publication phase claim to avoid a redundant save.
Status-only continuation has no mutation-phase reads or saves unless a publish
phase becomes ready; normal initial/final state persistence still applies.

Full-state saves remain necessary with the current revision-CAS storage API.
At an approximately 1.6 MiB workspace, their primary state payloads are roughly
4.8 MiB per Shopify mutation or 8 MiB per immediate Instagram flow, before
existing reporting mirrors and transport compression. The existing mutation
load is approximately 1.6 MiB; the earlier duplicate full-state authentication
load is eliminated. These are payload estimates, not measured production
traffic or a claim of zero bandwidth cost. A narrow atomic claim/result API is a
separate possible optimization, not introduced here.

## Objective and financial-policy follow-up

Saved business objectives still govern preparation, not live dispatch. Existing
connection-write records have no objective ID/revision, relevant policy set,
operation-specific financial evidence binding, or committed spending exposure.
This patch must not be presented as objective, margin, stock-cover or budget
limit enforcement. It neither invents missing evidence nor reads an absent
limit as unlimited authorization.

The next bounded change needs an explicit contract for:

- objective-driven versus independently approved manual origin;
- the exact objective revision, time window and all applicable owner constraints;
- immutable authoritative evidence identities for required cost, currency,
  margin, contribution effect, stock cover and relevant spending windows;
- intersecting compatible constraints and blocking unresolved conflicting goals;
- fresh approval and policy checks at this same per-phase dispatch boundary;
- atomic reservations for any consumable money/request allowance before enabling
  an action that consumes it.

Unknown required evidence must block that future guarded action. A generic
approval's financialImpact, campaign prose, cached margin, an objective review,
or a raw verification flag cannot supply financial authority. Legacy unbound
objective-driven actions will require a new qualified proposal and approval.
A paused unrelated objective or Autopilot flag must not silently revoke a
separately approved manual action.

## Verification

The dedicated connection-dispatch-safety suite uses actual IntegrationService
transports with synthetic fetch responses and two FileStore instances sharing
one disposable file. It exercises interleaved store clients and shared-object races,
acknowledgement failures, post-token and post-read changes, exact request binding,
all supported mutation branches, separate Instagram phases, continuation and
permanent no-replay after uncertain sends. Two additional tests use the actual SupabaseStore adapter against mocked
conditional PATCH responses to verify its CAS requests and losing-writer behavior.
They make no provider or production calls and are not live PostgreSQL tests. The file fixtures explicitly model a trusted durable callback for testing; they
do not prove cross-process FileStore exclusion or replace PostgreSQL concurrency
tests. The production route refuses FileStore dispatch. This patch adds no
schema, roles, credentials or database migration.

The source PR75 was one commit, `fee5351ddbbbaf119780c3426499f9c2b8c36107`,
above old main `3ebc1c75370b6a8b843da3829bc1b7af59f0a867`. It is now prepared
incrementally above actual PR74 main
`b98eb10cf0077fce5bf6696cb234350b8d1f7924`, which includes the approved outcome
migration alignment and PR82 reporting repair. The only source conflict was the
compact-authentication predicate: outcome and dispatch routes are both retained.
The store and fake Supabase merges preserve both predecessor contracts.
PR76–81 features are excluded.

Fresh full Node22.23.3 verification passed **920 tests**, with zero failures or
skips. Syntax, SaaS security guards and whitespace checks passed. Separate fresh
local PostgreSQL17.6 clusters passed all **25 outcome** and **73 reporting**
cases, preserving the predecessor publication/reporting concurrency and
privilege guarantees; both clusters stopped. These are predecessor database
regressions, not a claim of actual PostgreSQL dispatch concurrency coverage.

New interaction regressions exercise the actual dispatcher, provider transport
and Supabase adapter with synthetic responses. A rejected reporting RPC or a
lost reply reconciled by its revision read preserves exactly one authorized
mutation and three full primary saves, with only bounded reporting follow-ups.
A committed report returning malformed or oversized data after the dispatch
phase claim cannot provide a confirmed revision: fresh context/CAS blocks the
mutation and the durable phase prevents replay. Reporting failure never grants
new dispatch authority. Independent review also exercised 18 failure/phase
combinations including body-stream loss and concurrent pause without finding a
blocking defect.

PR74 merged after its six exact-head CI workflows passed. PR75 still needs fresh
CI on its own eventual head and remains held for PR74 postdeployment health.
No remote publication, provider call, production mutation or deployment was
performed for this preparation. Local Chromium remains unavailable; responsive
browser/container gates are not claimed as passed and no installation or
workaround was attempted. No migration is needed for PR75.
