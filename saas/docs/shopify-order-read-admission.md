# Admission bounds after uncertain order reads

This follow-on guard addresses the two remaining admission gaps documented in
source-capture commit `a6daeb2ef3693d88635b04681a34c7484accc286`. It uses the
existing workspace state, Doctor budget, generic job counters and conditional
save/finish paths. It adds no SQL, table, grant, provider call, request family or
automatic cap increase.

## Why the additional guard is necessary

A local failure-injection diagnostic reproduced seven automatic Doctor order
reads with autopilot disabled: fourteen pre-read saves succeeded, seven result
saves failed, and no attempt count or exhaustion reached the saved state. The
ten-minute lease limited frequency but did not make the retry sequence finite.
Doctor runs before the scheduler's channelSync daily-cap evaluation.

A separate FileStore diagnostic configured a connection job with
`max_attempts: 1`, expired its lease after each execution, and observed three
provider calls across three claims. The existing generic claim path requeues
expired leases without enforcing their attempt maximum. The separate
`objective_prepare` database guard does not protect generic connection jobs.
These are reproduced code-path risks, not observed production incidents.

## Doctor admission

Automatic Shopify order work consumes Doctor's existing five-attempt budget
before dispatch. A direct Doctor read charges the existing durable lease save;
first-sync charges the existing orders-group claim save. The current fifth
admission is allowed to finish, while later automatic checks stop. A failed
claim save permits no provider work. A process interruption or failed result
save leaves the last successfully persisted charge consumed.

The counter is bound to the existing stable tenant/provider/account/domain,
API version and parser/query policy. Credential contents, token rotation,
scheduling changes and the moving date cutoff do not change that binding.
Unavailable configuration does not prove account replacement and cannot
release a consumed budget. A verifiable replacement has a separate budget.
Malformed saved bindings and missing/newly enriched account metadata are not
replacement evidence. A reset requires a positive change between known stable
source values within the same workspace.

An admitted successful orders result clears the budget together with the
existing result save. If that save is uncertain, the previously stored charge
remains authoritative. Products-only success, token refresh and ambiguous
connected results cannot clear it. Existing authenticated, CSRF-checked manual
order retry/reconnection remains the explicit recovery path. Products-only
manual retries cannot erase uncertain order charges.
An implicit first-sync retry uses the actual unfinished areas when deciding
whether it includes orders. Successfully admitted source orders release the
budget using the attempted binding checked against the current configuration,
including recovery after account metadata was lost or enriched.

Exhaustion retains Doctor's existing provider-wide stop behavior. It does not
introduce an automatic products/refresh bypass. The scheduler's legacy
first-run shortcut and unchanged queued Doctor checks honor the same bound;
rediscovering exhaustion does not create another full-state save.

## Generic claimed-job admission

The trusted application worker checks the returned claim before loading a full
workspace, decoding credentials, running business logic or contacting a
provider. `attempts` and `max_attempts` must be valid authoritative integer
fields; malformed counters are never replaced with permissive defaults.

`attempts == max_attempts` is the final admitted claim. A greater count is
rejected and conditionally closed through the existing live tenant/worker/
lease/attempt fence. Invalid fence identity permits no guessed update. An
uncertain close is not counted as completed. A second in-memory check protects
the wait for the existing workspace lock; it adds no read or write.

This is application enforcement of existing durable counters. It is not a new
database-enforced generic attempt constraint. Objective jobs keep their
separate existing admission/publication contract.

## Effective bounds and scope

| Path | Existing bound enforced by this code |
|---|---|
| Doctor automatic Shopify orders | Five admitted order groups until a legitimate success/reset or stable scope replacement |
| Generic queued connection job | Five attempts by default; owner configuration supports 1–10; expired reclaim beyond the maximum performs no business/provider work |
| Scheduled channelSync | Default 48 durable rule claims per UTC day; valid owner configuration supports up to 96 |
| One admitted order read | Existing ten-page limit; 50 orders per page, 100 returned lines per order, no nested pagination expansion |

Doctor and connection-job reads use the existing `retry:false` path. Thus five
Doctor order admissions allow at most fifty order-page requests before a
legitimate reset; a generic connection-sync job configured for ten attempts
allows at most one hundred. These are application request ceilings, not
verified Shopify GraphQL cost or a promise that the query is accepted.

The scheduler persists rule claims before provider work, and its existing
retention policy preserves current UTC/local quota-day rows. Doctor's separate
guard is necessary because it runs before those rules, including when autopilot
is disabled. Environment-only periodic reads that do not use Doctor remain
subject to their configured channelSync daily cap.

No autonomous code path enqueues fresh generic connection jobs. The generic
enqueue/retry endpoints require the existing owner/admin authorization and
CSRF checks. A deliberate new job or manual retry is new owner-requested work,
not an automatic continuation of a failed job. Connection jobs use zero AI
units, so the daily AI budget is not a provider-read budget. Concurrency and
five-minute job leases bound pace, not total work, and are not presented as
substitutes for attempt admission.

These bounds concern admitted provider work. They do not create a universal
database-outage traffic ceiling: existing scheduler/queue polling and failed
prerequisite database requests may continue under their existing policies. No
provider work is permitted when its prerequisite claim cannot be saved.

## Request accounting

An exhausted claimed job uses two existing database requests and 326 compact
request-body bytes in the synthetic fixture: 111 bytes for the claim RPC and
215 for the conditional terminal PATCH. It makes no full-state GET, credential
read, business execution or provider request. Invalid fence identity cannot
authorize that PATCH. The valid-job structural-failure accounting from the
source-capture document remains nine warm-cache or nineteen cold-cache requests;
the new admission checks add no request to that path.

## Validation

Node 22.23.3 passed all 1,229 server tests with no failures or skips. The
42-test focused admission/claim/API run and independent adversarial review
cover lost result saves, interrupted reads, expired claims, unknown counters,
malformed/changed source identity, token rotation, products-only recovery and
effective first-sync retry scope. Syntax, the existing 15-product SaaS guard
and `git diff --check` passed. Direct and first-sync fixtures add 336 bytes to
the existing pre-read state save, with no added successful-path save.

All provider responses and database transports in these tests are synthetic.
No live PostgreSQL/Shopify call, deployment, migration or production setting
change was performed for this source guard. Combined-branch and remote CI
verification are separate from this local source checkpoint.
