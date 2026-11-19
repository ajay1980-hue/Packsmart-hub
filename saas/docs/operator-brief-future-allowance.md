# Optional future-only operator-brief allowance

This local implementation supports an explicitly approved limit on **additional
governed usage**, with earlier exposure still unknown and outside that limit. It
does not establish a total historical/monthly account balance. Applying its schema
does not install a tenant grant, supply an amount, change configuration, create
credentials, enable a worker or authorize paid calls.

## Existing path and accounting

The existing OpenAI Responses adapter, SupabaseStore, reserve and settle functions
remain the execution path. A new optional initial grant is stored in
`runvara_provider_future_allowances`. Service runtime has SELECT only; browser
roles have no access. Only an administrator can call
`runvara_install_future_provider_allowance(workspace_id, attestation)`.

The installer takes the existing workspace lock and requires explicitly disabled
governance. It refuses any preexisting governed opening, window or reservation.
An exact repeat returns the original immutable result; a changed attestation is
a conflict. There is no replacement, renewal or refund interface. An opening-table
trigger prevents the existing reconciled-opening installer from creating a
competing baseline. Existing verified-opening and clean-month behavior is retained
for workspaces with no future grant.

Additional allowance consumption is the sum of every original reservation upper
bound for that workspace, across all months and statuses. The existing tenant lock
serializes the sum, limit check and insert, including replicas. No second counter
ledger is introduced. Settlement, cancellation and uncertain outcomes never
replenish the grant. A provider overrun retains measured evidence and blocks
further admissions through the existing overrun rule. Existing monthly tenant,
provider and owner-selected lower ceilings also continue to constrain new usage.
Those counters cannot establish a total account-month cost while older exposure
is unknown; they must not be presented as doing so.
The cumulative aggregate scales with retained reservations. Keep their original
bounds/history, and qualify latency under the effective outer timeout before use;
purging rows or resetting counters is not a supported performance workaround.

The normal measured settlement and audit path is unchanged. Each reservation's
immutable pricing snapshot also records the additional accounting scope, grant
identity and unknown historical exposure. Runtime/agent results retain
`accountingScope: additional_after_cutover` and
`historicalExposure: {status: unknown, costMicros: null, reconciled: false}` separately
from the measured cost of this invocation. Existing usage summaries show recorded
usage, not the remaining lifetime grant; no new dashboard is installed.

## Exact attestation contract

The installer accepts only these fields, with no extra keys:

- `version: 1`, exact `workspaceId`, unique `grantId`, `currency: USD`,
  `scope: additional_after_cutover`.
- `historicalExposure` exactly `{status: unknown, costMicros: null, reconciled: false}`.
- `evidenceHash`: SHA-256 of the private approval/verification packet.
- `verifiedAt`: actual epoch milliseconds within the previous 24 hours;
  `approvedAt` and actual `legacyDispatchStoppedAt`, each no later than verification.
  `expiresAt`: an explicit finite future absolute epoch-millisecond deadline.
- `legacyDispatchersRetired`, `inflightDrained`, `futureAccountVerified` and
  `exclusiveDispatchScope`, all explicitly true with evidence. Unresolved old
  charges are allowed; an unidentified still-running legacy dispatcher is not.
- `legacyUsageFingerprint`: the existing full legacy-history fingerprint. Later
  insert/edit/delete drift blocks admission, including after counter lock waits.
  This does not detect unrecorded external calls or prove billing completeness.
- `credentialDigest`: SHA-256 of the exact privately held credential; exact verified
  `organizationId` and `projectId`. Never put the credential itself in this packet.
- `limits`: explicit nonnegative safe-integer `maxRequests`, `maxInputTokens`,
  `maxOutputTokens`, `maxTotalTokens`, `maxCostMicros`. Zero is a hard stop. No default
  allowance or conversion from subscription credit is provided.

The administrator must verify those facts; a digest or caller-supplied boolean is
not evidence. No attestation or real amount is supplied by this change. DB wall time
sets `accountingStartAt`; the caller cannot backdate it. The installer returns an
exact `futureAllowance` policy projection and `accountingStartAt`, and leaves all
workspace configuration disabled and unchanged.

## Separate activation and runtime enforcement

A later trusted platform action must copy that exact projection into
`governance.futureAllowance`, set matching `governance.accountingStartAt`, record
the actual `configuredAt`, and bind the adapter's `atomicUsageCutoverAt` to the
verified retirement time. Configure fresh exact-model all-in price/token evidence
and every existing finite policy ceiling. New jobs must be created after the
database-recorded installation; never edit/replay old jobs to qualify them.

Paid use requires the existing `RUNVARA_OPENAI_ENABLED`, enabled governance/provider/
adapter, fresh job/lease and all existing checks, **plus** the new explicit
`RUNVARA_AI_FUTURE_ALLOWANCE_ENABLED=true`. Its default is false. This release does
not write either flag. Account/credential/retirement evidence alone is not spending
approval. The user must separately approve an actual amount, scope and expiry.

The runtime hashes its actual configured credential, binds grant/account policy in
the request fingerprint, sends exact `OpenAI-Organization` and `OpenAI-Project`
headers, and limits admission and transmission start by grant expiry. SQL independently checks
the installed grant, exact copied policy, credential digest, lease/job creation,
provider, legacy fingerprint and all ceilings under the existing lock order.
After reservation, the runtime freshly rechecks policy, credential, activation and
job evidence before POST. Lost acknowledgements never authorize dispatch or retry.
Grant expiry blocks new reservations and new transmission. A request already
transmitted against its full reservation may complete and settle after expiry
under the existing 45-second transport bound. Uncertainty retains the reservation;
expiry does not authorize cancellation, refund or replay.
If the response supplies contradictory organization metadata, it remains uncertain.
The account headers follow the [OpenAI authentication contract](https://developers.openai.com/api/reference/overview#authentication).

The old 13-argument reserve RPC delegates to the new 15-argument implementation
with no grant/credential binding; it fails closed for an installed future grant.
New clients supply both binding arguments, with strict DTO validation. Existing
unscoped clients retain their former behavior when no future grant is installed.
The separate dormant routing-evidence constructor has a different proof contract;
future grants fail closed there instead of silently reinterpreting that contract.
The mounted single-provider constructor is the path qualified here.

## Qualification, release and rollback boundaries

The existing disposable PostgreSQL/real PostgREST suite now applies the optional
future migration after the reviewed verified-opening migration. It exercises the
old and new RPC signatures, all original reservation/settlement tests, concurrent
future limits, exact install idempotency, expiry/legacy drift after lock waits,
permissions, unknown history, rollover, cancellation and rollback. Real provider
transport is replaced by a synthetic transport in end-to-end adapter tests.

The effective managed gateway outer timeout remains a release requirement;
function-local SET alone does not prove it. Existing eight-second and hoisted
fifteen-second HTTP profiles are qualified locally. No production configuration
or probe is performed by the tests. Administrator installation also requires a
verified finite outer statement timeout and read-only reconciliation after any
uncertain commit outcome.

Rollback begins by disabling paid dispatch, retaining all grants, holds, receipts
and history. An old application safely receives denial through the retained
compatibility RPC. Do not restore the old baseline-only reserve definition while
future grants exist: it does not know this accounting scope. Keep the new SQL guard
installed while disabled; no automatic down migration or history deletion exists.

Remaining release work: independent review, approved publication/schema release,
actual account/retirement evidence and timeout qualification, a reviewed trusted
configuration write, an explicit allowance and separate paid activation approval.
No such production actions are authorized or performed by this local patch.
