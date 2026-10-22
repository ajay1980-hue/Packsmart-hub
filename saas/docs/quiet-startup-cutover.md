# Quiet startup for the first cumulative release

This is release-safety preparation against accepted source `2caa5d6a`, not a
deployment or an operational pause. No database schema, grants, credentials,
provider permissions, service or tenant settings are changed by this code.

## Startup contract

`RUNVARA_STARTUP_MODE` accepts only `normal` or `quiet`. Absence retains the
existing normal startup behavior. Any other configured value, including an empty
string, whitespace or unknown spelling, refuses construction before the store,
provider or worker constructors run. The error does not echo the supplied value.

The server captures the mode once. Later environment mutation, request fields,
headers, tenant JSON and worker constructor options cannot reopen a quiet server.
This is a process-wide admission setting, not a live fleet switch or a per-tenant
pilot policy. An existing normal process continues its original work until it is
actually drained and terminated.

By default, quiet startup admits only:

- GET or HEAD `/api/health`;
- GET `/api/auth/session` using its existing session validation and identity read;
- GET or HEAD on the exact existing static-asset pathname map.

All other requests receive `503 STARTUP_QUIET_MODE` before body consumption,
authentication, database work or provider work. The response says: "New work is
temporarily paused for an update. Earlier work may still be running." It does
not promise a retry time, cancellation, missing mutation or successful rollback.

The default-deny boundary also covers GET routes with effects: bootstrap and
brief reconciliation, OAuth callbacks and Canva template credential refresh.
Login/logout/password mutations, support submissions, webhooks, billing, import,
approval, publication and execution routes are paused. No blocked webhook is
acknowledged as processed. Existing authentication and authorization semantics
apply unchanged to the allowed session route; an invalid session may clear its
existing cookie. No new authentication mechanism or access is introduced.

The existing UI displays the fixed response and conservatively retains uncertain
mutation state. A later refusal cannot resolve an earlier lost response. Startup
offers its existing manual reload; it does not submit an action. Existing browser
GET polling can continue receiving inexpensive refusals. This mode therefore does
not promise zero browser/network traffic.

## Background work and health

### Optional maintenance owner login

`RUNVARA_QUIET_OWNER_LOGIN=enabled/v1` permits only the existing POST
`/api/auth/login` in addition to the quiet allowlist. It defaults to
`disabled/v1`; other spellings or enabling it outside quiet mode fail startup.
The value is captured at construction. It cannot activate workers, integrity
checks, bootstrap, signup, owner activation/seeding, password changes, OAuth,
webhooks, provider routes or business actions. This local patch is not approval
to set the flag or deploy it.

Only an existing active owner with a stored password hash may sign in. Existing
password verification, rate limiting, secure session cookies and tenant binding
remain. The authenticated response and session check identify maintenance so the
browser shows the verified identity and pause without bootstrap or pilot import.
The UI's manual Check session reload performs another session read, not login.

This allowance requires Supabase's narrow maintenance audit writer; other stores
fail closed. It rechecks the owner, email, password hash and session version on an
exact current snapshot, then appends the login audit through the existing revision
CAS. It changes only audit, revision and workspace/update timestamps; no state
upgrade, business/reporting mirrors, history compaction or repair is requested.
Existing database writer guards still apply, including their control/barrier
effects and possible lock contention or rejection. No schema change is needed.

All prior audit entries stay in place, including beyond the usual embedded 300.
The existing 2 MiB state ceiling refuses an oversized login rather than dropping
history. Later normal integrity/retention work may compact that history; it is a
separate activation effect. No database audit/archive export is introduced.

Each attempt submits at most one CAS write. An uncertain response can only be
accepted after a read proves that exact attempted revision; no write is replayed.
Account changes, conflicts, unconfirmed persistence, a drained server or a lost
client connection issue no session. An already submitted write may commit even
when the client disappears; its audit is preserved, without automatic retry.
Repeated deliberate successful sign-ins each add their own audit entry. No live
login or hosted-write acceptance is implied by the local synthetic tests.

Quiet construction forces scheduler and Agent Ops disabled and stops their
admission, including direct start/tick/run probes. It suppresses initial and
periodic integrity checks, which otherwise can repair and save state. No worker
polling, claims, provider retries or integrity timers start. Existing secondary
timeouts are reachable only from admitted operations; quiet does not start them.
Normal startup, shutdown and already-admitted result/finalization paths retain
their existing behavior. No claim, quota, lease, retry deadline or pending request
is deleted, refunded, extended or assigned a replacement identity.

Health still performs its existing coalesced persistence read and reports safe
diagnostics. A healthy quiet process can return HTTP 200 and `ok:true`, while
`startupMode:"quiet"` and `productionReady:false` distinguish usable diagnostic
liveness from a normal serving release. The existing production verifier rejects
this paused state. Normal health retains its prior readiness checks and adds
`startupMode:"normal"`. This does not activate a transport for the separately
restricted production health URL.

## Why the first cutover needs this boundary

Production `d32da62` and the cumulative candidate use different recorded-cost
validation and calculation signatures. Both normally start workers and integrity
work on listening, before platform traffic cutover. The governed-record producer
gate alone does not stop ordinary imports, Doctor or derived bootstrap saves.
The candidate's improved shutdown cannot repair an already-running old worker.

Render's [standard deployment sequence](https://render.com/docs/deploys) overlaps
instances and sends SIGTERM to the predecessor after switching traffic and a
60-second delay. Its [maintenance mode](https://render.com/docs/maintenance-mode)
blocks public traffic while leaving the service process running. Neither is a
global worker barrier. Official suspend/resume APIs exist, but their availability
does not itself establish the chosen artifact, completed old work or a verified
stop/start procedure. No suspension is performed by this preparation.

## Conditional operational sequence

The following is a proposal requiring a concrete approved pause window and fresh
permitted live verification. It is not automatically run by this implementation.

1. Pin the candidate, exact current serving revision, storage profile and effective
   non-secret settings. Obtain applicable exact-head CI, real database API,
   container and browser evidence. Keep the five forward feature migrations
   unapplied and new governed/receipt/recovery admission inactive for the initial
   legacy-storage release. Preserve the existing publication setting.
2. Disclose the temporary global admission pause. It delays Runvara imports and
   checks and blocks this service's support, webhook, billing and OAuth handling.
   A provider may require a later explicit retry; delivery or automatic retries
   are not guaranteed here. Shopify's separate storefront is not disconnected.
3. Set the approved successor to quiet and deploy it on the existing service.
   During overlap, the old binary remains the sole writer; quiet performs only
   explicitly allowed reads. Record exact instance/deploy identity and actual
   predecessor termination using supported platform evidence.
4. Reconcile outstanding and uncertain prior work using its original identity.
   A timeout, absence of a log, lease expiry, accepted suspend request or successful
   deploy event is not proof of completed or absent upstream effects. Unresolved
   old attempts keep normal admission paused; never infer that retry is safe.
5. Replace the quiet instance with the same immutable artifact in normal mode,
   leaving governed producers and the independent receipt/recovery contracts
   inactive. The old quiet instance cannot write during this second overlap.
   Verify current exact-commit health and authenticated behavior through permitted
   routes before calling the release ready.

Closing admission later uses the same artifact in quiet mode and requires actual
drain/termination of every old normal process. This is an operational stop, not
recovery from a defect in the binary. After corrected semantics/newer records are
written, old `d32da62` and narrow bridge `9bb9dd39` are not certified binary rollback
targets. Preserve canonical data and concurrent writes; use a tested compatible
fix or remain paused. Never restore an old workspace snapshot to force old code
to run. Future SQL/access/receipt/recovery activation still needs separate review
and permission, including its own reader/finalization and rollback constraints.

## Test boundaries

Focused synthetic tests prove configuration refusal, early HTTP denials, real
store constructor non-mutation, allowed health/session reads, background admission
suppression despite enabled worker options, and unchanged ordinary lifecycle.

The process qualification uses separate real Node 22 servers and a parent-owned
synthetic transport. One scenario uses the exact public d32 source and one reuses
the candidate in both modes. Quiet overlaps a held ordinary provider operation,
the prior result finalizes once, the old child exits, and a cold normal successor
retains completed/uncertain identities and deadlines. Health/identity reads count
as real fixture transport, not zero I/O. Normal background workers are disabled
in this process scenario; the focused production-mode tests cover their quiet
suppression separately. It is not PostgreSQL concurrency, real provider durability,
d32 late-claim recovery, or live Render termination proof.

The d32 runner verifies commit `d32da62d0e7935597638266d44d88ae5e066d51f` and tree
`f58aed9bd9c99e1376b865f85c47097492faec4d`, then hashes and extracts only required
public source into a temporary fixture. CI fetches only that pinned commit; no
credentials, environment files, hooks or duplicated source archive are included.
The default app suite has no hidden dependency on this local baseline checkout.

The browser runner uses the real app and quiet server with a prewritten synthetic
session fixture. It checks visible pause text, preserved session, manual reload,
zero saves/provider calls and normal/200% affected-card text at 320/390/1200px.
Six screenshots require actual pixel inspection after CI. This is neither whole
page zoom nor a full accessibility audit. Exact counts, hashes, partial failures,
cleanup and pending gates belong to the accompanying frozen evidence.
