# Future-only allowance: disabled local design experiment

This is a proposal and disposable database qualification, not a release migration,
an accounting attestation or an executable provider integration. The SQL lives in
`server/tests/future-allowance-lab`, outside the migrations directory. It refuses
any database except `runvara_future_allowance_test`; its runner additionally requires
an explicit opt-in, loopback URL, PostgreSQL 17 and an empty database. Neither the
application nor a workflow imports it. Every response sets `dispatch_allowed:false`.

## Accounting meaning and the decision required

An unknown historical provider account attribution cannot satisfy the current
opening installer's `historicalExposureReconciled` and `monthUsageComplete`
attestations. An empty ledger, a new calendar month, a new key or a new allowance
does not turn that uncertainty into zero. The existing installer is unchanged and
is exercised directly in the design tests: it rejects unresolved history without
creating an opening, reservation or counter.

A possible alternative is an explicitly approved *additional* allowance for newly
governed requests after an actual retirement/cutover time. Historical exposure is
retained as `{status:'unknown',costMicros:null,reconciled:false}` with a separate
evidence fingerprint. A new grant is not a full-month opening balance. Reports
must show incremental governed consumption and unresolved legacy exposure
separately. They must not claim that a total monthly account ceiling is established.

This changes the accounting scope and needs an explicit owner decision before
production implementation/activation. An existing total-month ceiling must not be
silently reinterpreted as an additional allowance. No amount, account binding,
retirement time, approval time or expiry is supplied for a real tenant here.

## Small conservative candidate

One immutable initial grant per workspace binds the provider, verified future
account/project identity fingerprint, evidence, actual start/retirement times,
absolute expiry and finite request/input/output/total-token/USD-micro ceilings.
The grant does not reset at a month boundary and has no renewal/replacement API.
Its counters consume the entire reserved upper bound permanently within that
grant, including after a timeout or settlement. This deliberately sacrifices
budget reuse to simplify a small initial allowance; it may exhaust much sooner
than actual billed consumption. Later reconciliation must not refund this grant
or silently convert the legacy unknown amount to zero.

The laboratory exercises those counters, immutable logical call identities and
audit inserts in one PostgreSQL transaction. It takes a per-workspace counter lock,
locks/rechecks the synthetic claimed job, then rechecks actual database time,
expiry, lease, worker/attempt and current binding. A duplicate or changed
fingerprint never gets another simulated reservation. Other tenants can progress.
The laboratory's `exercise_enabled` switch enables only these synthetic accounting
operations. `paid_dispatch_enabled` is constrained to false, and all responses
deny dispatch. The service role can execute the narrow function but cannot write
its grant, counters, history or audit directly; an untrusted role cannot execute.

## Production integration still required, not proved by this experiment

Do not deploy the laboratory schema or substitute its function for the existing
reserve RPC. It is a model of the supplemental budget transaction, not a second
accounting authority or a new API client. It accepts synthetic bounds and bindings
from its test driver; that is NOT production evidence or authentication.

A production implementation must obtain bounds and account identity from the
existing trusted runtime/policy and perform the supplemental debit inside the
same existing reserve transaction. Preserve existing tenant/lease checks, pricing,
request fingerprint, deadline rechecks, reservation uniqueness, audit and exact
acknowledgement gate. Use a single documented lock order shared with settlement
and every writer; the isolated lab does not qualify mixed production lock orders.
No provider POST may happen from `simulation_reserved` or an uncertain response.
The grant identity, binding, expiry and evidence must participate in the runtime
fingerprint and be freshly checked immediately before transmission, including
when a successful reservation acknowledgement arrives after the grant expires.

The initial installer must be administrator-only, idempotent for exact evidence,
truthfully dated, revision-bound and require explicit disabled governance. It
must refuse any preexisting governed opening/window/reservation, rather than
resetting or migrating holds implicitly. Existing grants/evidence remain immutable
to runtime roles. Preserve the existing legacy-history fingerprint check: unexpected
legacy ledger changes after the retirement snapshot freeze further admission for
review. The lab models immutable evidence but does not replace that history scan.
Settlement continues through the existing measured-usage path;
it must preserve the grant's consumed upper bound. Unexpected billed overrun must
retain evidence and block further use pending review. Renewal, refunds, account
rotation and retrospective allocation need separate designs and approval.

The alternative baseline must be explicit in SQL, JavaScript policy/fingerprints
and owner-visible accounting. It must never set the old reconciled-history
attestations to true. Existing per-request, tenant/provider limits remain enforced;
the owner must explicitly resolve how their existing monthly ceiling relates to
the additional grant. Historical liability is neither paid nor capped by this
design. No automatic activation, pricing poll, provider health check or replay.

Before activation, independently establish legacy dispatcher retirement and
drain, exclusive future dispatch scope for the bound credential, fresh model and
all-in price evidence, and the effective outer database deadline. An unknown
historical bill may remain unknown under an explicitly approved future-only
contract; an unknown *still-running legacy dispatcher* cannot. The existing
deterministic Commander remains available while any requirement is unresolved.

## Qualification and practical next decisions

Run in a fresh disposable PostgreSQL 17 instance, with the existing local `pg`
test dependency installed. Example (loopback disposable database only):

```sh
FUTURE_ALLOWANCE_DISPOSABLE_OPT_IN=1 \
FUTURE_ALLOWANCE_DATABASE_URL=postgres://postgres@127.0.0.1:55439/runvara_future_allowance_test \
node --test --test-concurrency=1 saas/server/tests/future-allowance-lab/design.test.mjs
```

The 19 cases cover default-disabled behavior, the unchanged real installer,
30-connection contention, each independent ceiling, cross-tenant/binding/job
rejection, expiry after observed lock contention, another tenant's progress,
rollback on cancellation and audit failure, runtime permissions, cumulative
month-spanning consumption, unsafe input and no identifier leakage. The lost
acknowledgement case discards the result after a real local commit; it is a
simulation of transport loss, not another HTTP gateway qualification.

Decisions: accept or reject the future-only accounting scope; select an approved
incremental allowance and expiry; accept conservative nonrefundable reservations;
establish the future account binding and real retirement evidence; approve a
separately reviewed production implementation and disabled release. Paid
activation is another explicit step. Current PR opening support remains separate.

The gateway's effective hoisting and pool/network settings still require managed
configuration evidence or an independently approved bounded diagnostic. Existing
role defaults and a fast successful request alone do not prove the outer deadline.
Do not change timeout configuration simply to match a laboratory profile.
