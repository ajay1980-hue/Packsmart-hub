# Atomic credential save and legacy reserved admission

This describes the local implementation and synthetic tests. It is not permission
to enable entry, read secrets, replay a save, alter a durable legacy receipt,
contact a provider, or perform production maintenance. No incident data or real
account bindings are included.

## Current credential-only path

`parcel2go-live-admission.mjs` now prepares the encrypted connection, completed
`admit_credentials` receipt and both admission audit events before one primary
workspace CAS write. It never persists a newly reserved credential row alone.

- Keep exact signed-cookie owner/session/review/revision/tenant checks, the
  one-use entry window and persistence permit, and existing expiry/deadline
  checks. Any existing reserved row still rejects before sealing credentials.
- Preserve the existing completed receipt, connection metadata and credential
  envelope schema. Existing quote binding and read-only status checks work with
  the atomic result without a migration or provider request.
- Commit `parcel2go_live_reserved` and `parcel2go_live_completed` audit events
  together with the completed receipt and encrypted connection. The retained
  reserved event denotes admission; it no longer implies an intermediate durable
  reserved state for this credential path. Consult the authoritative receipt.
- Keep the real store's capacity/readability checks, owner/deadline guards around
  archive operations and before commit, revision CAS, and disabled write retry.
  Existing append-only archive IO can still precede the primary CAS; the whole
  archive sequence is not one database transaction.
- After the write, reread exact state and revalidate owner, session, expiry and
  deadline before returning success. The HTTP controller also confirms saved
  status. Uncertain or late outcomes do not trigger another write.

The normal credential route uses five full-state reads and one primary PATCH
(previously seven reads and two PATCHes), excluding archive IO and exceptional
revision reconciliation. Concurrent controllers with independent workspace locks
still compete on the same database revision: only one CAS can win.

Quote reservation and transport remain unchanged: quotes durably reserve before
provider dispatch and finish in a separate write. This change does not authorize
quotes, bookings, provider requests or any live activation.

## Synthetic fault outcomes

The real server and `SupabaseStore` tests use only synthetic transport and state.

| Injected condition | Durable credential result |
| --- | --- |
| Initial read fails; write rejected or CAS loses | No new receipt or connection |
| Write commits but acknowledgement is invalid/lost | Completed receipt and connection; response may be unconfirmed |
| Post-commit read fails or reaches deadline | Completed receipt and connection; unconfirmed response |
| Final status read fails | Completed receipt and connection; unconfirmed response |
| Owner/revision changes before CAS | CAS refuses; no new receipt or connection |
| Owner/revision changes after CAS | Success is withheld; reconciliation rechecks current authorization and bindings |
| Already-dispatched write completes after server/browser deadline | Completed receipt and connection together; reconcile without retry |
| Lost network acknowledgement reconciles to the exact new revision in time | Completed receipt and connection; success may be confirmed |

No case leaves a new credential reservation. The one-use window remains spent
when an attempted write fails. Automatic retries are not added. A fresh process
can verify a completed result without resubmitting credentials. Independent
controller races with the same or different request IDs produce one completed
receipt, one connection and one pair of audit events.

## Legacy reserved state is unchanged

Before this change, the first credential write stored only a reserved receipt and
reserve audit. The encrypted envelope remained in memory until the second write.
A legacy reservation contains no recoverable credential material. Whether the
original secret remains in a separate authorized secure holder is a separate
question; do not read it during reconciliation.

Legacy reserved rows are seeded explicitly in the regression fixtures because
new atomic saves cannot create them. Tests verify that restart, expiry, a new
request ID and fresh revision do not release or modify a legacy reservation.
Both entry and fresh setup remain blocked. `expiresAt` is an authority cutoff,
not a lease that automatically releases the durable fence.

Keep setup and quotes disabled during legacy reconciliation. A disabled entry
route returns 503 and performs no state read; it is not a receipt lookup. Do not
re-enable it merely to inspect a receipt. Use the approved metadata-only path.

## Minimal read-only evidence

Use exact tenant/request scope and return counts, fixed statuses, timestamps and
binding-match booleans. Do not return full rows, hashes, identifiers, account
references, emails, cookies, tokens, bodies or credential values; do not fetch
full connections merely to test whether encrypted material exists.

- Exact request cardinality, operation/status, live-connection counts and count
  matching the approved request/connection binding.
- Boolean matches for the original tenant/account/connection/environment/review
  and fingerprint bindings; presence of completion evidence and matching audit
  counts/timestamps. Audit `createdAt` and receipt `completedAt` are prepared
  before persistence; neither proves the physical DB commit time.
- Revision equality against the previously observed snapshot and observation
  times, to determine whether the original result is still changing.
- Retained HTTP/DB method, status, start/end/duration, fixed operation category
  and allowlisted failure category for the original time window. Identify the
  deployed revision before interpreting counts: legacy saves had two PATCHes.
  Missing logs do not prove that an operation never started.
- Retained server diagnostic stage/cause/capped duration and process lifecycle
  metadata. The generic `credential_admission` stage does not identify each
  internal read or write. Healthy new-process telemetry does not reconstruct
  the previous request; store telemetry and the activity meter are process-local.

The store's client transport timeout defaults to 30 seconds (configured range
20–60 seconds). The four-second save response and five-second browser bounds do
not cancel a dispatched database write. Client timeout or restart does not prove
DB cancellation. Account for outstanding writer/database activity and reconcile
the original request before making a terminal decision.

## Remaining recovery boundary

A completed receipt can be called stored only after existing authorization and
full binding/hash checks. A matching legacy reservation without a connection
remains unresolved. Duplicate/mismatched evidence must be preserved for review.

There is no resume/release operation in this change. Any eventual terminal
closure requires its own explicitly approved, audited, exact-request CAS that
preserves the receipt and reserve audit, accepts only the intended credential
operation and verified bindings, rejects completion/connection/owner/revision
changes, reconciles uncertain acknowledgements without repeating the mutation,
and invalidates stale writers through the new revision. Do not delete the row,
mark it completed, clear the general reserved fence manually or replay its save.

The atomic change prevents new split credential outcomes; it neither recovers an
old secret nor releases an existing reservation. Runtime activation, production
recovery and release remain separate authorized steps.
