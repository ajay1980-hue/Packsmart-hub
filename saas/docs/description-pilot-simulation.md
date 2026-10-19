# Description pilot simulation

This runner is **simulated only**. It does not contact Shopify, Supabase, or any
other external service. Passing it is not provider acceptance or release approval.
The existing application source, saved description patch, and production startup
remain unchanged.

From the repository root, using the existing Node 22 runtime:

```powershell
node saas/server/scripts/simulate-description-pilot.mjs
node --test --test-reporter=spec saas/server/tests/description-pilot-simulation.test.mjs
node --test --test-reporter=spec saas/server/tests/description-pilot-restart.test.mjs
```

The script accepts no command-line options and has no live mode. It creates one
ephemeral owner session, one synthetic workspace/connection/product, and an opaque
five-minute capability for an exact paragraph replacement. The proposal and owner
approval are submitted through the real authenticated, CSRF-protected HTTP routes;
the real execution route invokes the real dispatcher and receipt storage adapter.
The synthetic provider receives only the exact baseline query and description-only
mutation. The protected receipt is then read through the real outcome-content-source
HTTP route and validated by the existing reader. The unmeasured experiment exists
only to exercise that reader; no financial outcome is claimed or published.

Every HTTP listener binds to `127.0.0.1` on an OS-assigned port. After listening,
the runner verifies the actual `server.address()` is IPv4 `127.0.0.1`; it closes
and refuses if that check fails. Provider and storage
URLs are identifiers consumed by in-process fakes: neither fake has a network
delegate. The only network client is a fixed loopback HTTP client. The runner does
not load `.env`, copy `process.env`, read credential files, or accept credentials,
an alternate transport, a real shop domain, or production configuration. Its
synthetic session/encryption values are generated in memory and never printed.
Schedulers and agent workers do not start. The restricted injected store omits the
customer-zero integrity probe and rejects every other workspace. Public catalogue,
environment-credential and repository snapshot fallbacks are unavailable.

The storage fake models revision checks, exact reservation/finalization envelopes,
acknowledgements, reconciliation and a protected receipt reader. It uses the actual
JavaScript adapter and validators but **does not execute SQL** or prove database
privileges, RLS, transaction isolation, durability, or PostgREST response parity.
The application DTO still says `executedExternally: true` for a confirmed simulated
execution because it is the unmodified real route; the runner's enclosing report
explicitly labels the entire result simulated.

Focused tests cover production configuration refusal, foreign workspace/connection
and credential replacement, fallback refusal, unknown proposal/mutation fields,
wrong products and targets, authentication/CSRF, missing/stale approval, changed
settings/scopes, stale provider baseline, concurrent/repeated execution, provider
response loss/wrong identity, refused receipt admission, lost storage ACKs, and
unreconciled storage outcomes. Every test closes its server and verifies its port
refuses connections, including failure paths. Running the CLI also drains/closes
in `finally` and reports the stopped listener. Expected refusal tests may print the
application's normal sanitized error logs.

The fake receipt ledger remains in memory. The simulated submission boundary now
also uses a saved attempt manifest in the task workspace's fixed
`.local-simulation-attempts/attempt-<id>` directory. The manifest binds a stable
request ID to the exact synthetic workspace, connection, account, product,
operation, owner, settings revision, API version, and input digest. Before fake
submission, the runner revalidates that manifest, exclusively creates
`consumed.json` with `wx`, writes it, calls `FileHandle.sync()`, closes it, and
revalidates the manifest again. The fake submission occurs only after those steps.
Any existing marker, including an empty or interrupted file or a directory,
prevents reopening that identity. Missing, malformed, mismatched or unreadable
state fails closed. The runner has no marker deletion, reset, repair or rearming
operation. It retains synthetic evidence files after tests.

The no-argument CLI explicitly initializes a distinct synthetic attempt on each
invocation. It does not resume or replace an earlier attempt. Tests reopen a saved
ID with `openSyntheticAttempt`; a consumed ID cannot submit again. The identifiers
and digests provide local binding, not authentication against a malicious local
writer or a provider idempotency guarantee. There is still no real-provider
credential or bootstrap path.

The restart suite forks independent Node processes with empty environments. Two
workers open the same manifest and reach a barrier before racing to claim it.
Other cases terminate workers before the claim, immediately after exclusive
creation (empty marker), after writing, after flushing, and after fake submission.
Success and response loss are followed by separate-process reopen attempts.
Malformed state, identity/binding mismatch, a changed manifest after opening,
injected access failures, and an injected flush failure also refuse dispatch.
Access and flush errors are test injections, not OS ACL or disk-failure tests.
Every child is awaited or terminated; every reported listener port must refuse
connections after exit. The suite emits a JSON process audit with checkpoints,
submission counts, I/O observations and cleanup results.

Before importing the runner, each process worker installs test-only wrappers for
common HTTP/HTTPS/fetch, TCP/TLS, HTTP/2, UDP, DNS, subprocess, and file-read APIs.
Only explicit numeric loopback connections to that worker's own verified listener
are allowed. Node's numeric-address lookup is answered locally without consulting
DNS. File contents are limited to source files and synthetic attempt state, with
credential-like names refused before I/O. Nineteen negative probes use reserved
network names/addresses and nonexistent synthetic credential filenames; their
operations must be intercepted before real I/O. Normal simulated workers must
record no denied operations. This instrumentation is not an OS firewall, packet
capture, comprehensive filesystem audit, or production outbound guard. Captured
APIs, native code, internal module-loader paths, inherited descriptors, and other
unwrapped APIs are not comprehensively covered.

These tests establish the observed one-submission bound for the same saved attempt
under the tested ordinary process terminations on this filesystem. They do not
establish hardware/power-loss durability, disk-cache or directory-entry durability,
network-filesystem semantics, resistance to concurrent filesystem tampering, or
transactional persistence of the in-memory receipt ledger. A crash before the
claim may permit the first submission after reopening; a crash after the claim
can permanently consume the attempt without any submission. No automatic retry
repairs that conservative outcome.

Before any separately authorized QA provider test, work still includes verified
permanent QA domain and QA-only app/grant identity, secure local credential input,
real baseline/approved replacement, a separately reviewed attempt boundary bound
to that real QA operation, a reviewed outbound allowlist, and explicit handling of the provider race
and HTML readback. Production Packsmart configuration must remain untouched.
Hosted Supabase/PostgREST and fleet rollout/rollback validation remain separate
release gates. This simulation grants no authority for those actions.
