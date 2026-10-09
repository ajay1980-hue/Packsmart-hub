# Optional recoverable Shopify order imports

Preparation in the existing importer and database. Runtime opt-in requires
`SHOPIFY_ORDER_RECOVERY_CONTRACT=runvara-order-recovery/v1` and the matching store
capability. Database control begins `prepared`. Nothing installs, grants access,
activates recovery or applies a migration at startup.

Ordinary fresh imports keep their existing source query and limits. Recovery
requires one persisted Shopify connection whose identity can be verified by the
database. Environment-only imports retain the ordinary path. Recovery does not
copy credentials or create a connection. Credential rotation is outside its
protected transaction: expiring credentials require the existing refresh or
reconnect action. A changed source identity can make an old stage ineligible.

## Explicit continuation and original freshness

A current owner or administrator explicitly reviews the original fixed updated-at
window, observation start and saved progress before starting or continuing.
Selections are opaque, bounded, expire and are consumed once. The server derives
authority from current actor/session, tenant, source configuration, settings,
accepted source generation and exact workspace/stage revisions. Client source
objects and cursors never become authority.

Continuation retains the original window and query. It never mixes saved pages
with a new rolling window. Page capture times remain evidence of their actual
observation; completion does not establish a provider snapshot, complete source
period or wholly fresh Shopify coverage. Original observation remains visible
after promotion and reload.

Expired admissions cannot dispatch or append. Explicit continuation may acquire a
new ordinary-duration lease and the next Doctor admission, but cannot steal an
active lease, reset spent attempts or bypass a source hold. The shared five-read
admission budget remains unchanged. Automatic filtering for a retained stage
blocks orders; other areas still obey their existing eligibility and shared budget.

## Finite storage

- One unfinished retained stage per business, at most eight globally.
- At most 2 MiB conservative logical payload and metadata per stage.
- One shared 16 MiB allowance for stages, compact completion receipts and a fixed
  4 KiB control/quota charge.
- Failed, paused, uncertain and superseded retained stages remain charged.
- Ten pages, fifty orders per page, 500 orders and 100 lines per order remain the
  existing traversal ceilings.

Overflow pauses the import and preserves canonical orders. No prefix is promoted,
window changed or claimed coverage silently reduced. Ordinary fresh imports do
not stage pages and remain available with their existing limits.

Immutable completed-operation receipts are bounded to 16 KiB each and consume the
same global allowance without automatic expiry or deletion. Their accumulation
can pause recovery even with an unfinished-stage slot free. Eight stages cannot
all fill their individual maxima once completion history exists. These are
logical byte limits, not physical row/index/WAL/backup sizes or a monetary cap.

## Page commits and uncertain responses

Only wholly validated pages are appended. Tenant/source identity, current role and
session, source policy, lease, duplicate order IDs and cursors, API version, row
and byte bounds are checked before advancement. Normalized rows and cursor
progress commit under the same stage revision. Each append transfers its page,
not the entire saved prefix or canonical workspace.

Fresh authority is checked before token resolution and again after token awaits,
immediately before a provider request. The append transaction independently
rechecks authority, source and lease. An uncertain mutation receives at most one
automatic exact acknowledgement lookup; it is never automatically resubmitted. A later
explicit continuation settles an already-started transaction or fences a late old
request through its new admission before reading still-uncommitted pages. A new
explicit review may make a bounded read-only exact receipt lookup with current
authority checked again; it does not resubmit the old mutation.

A private durable completion receipt is required to reconcile an uncertain final
promotion. A mutable canonical manifest cannot substitute for it. All required
operation identities and acknowledgements survive reuse of the workspace slot.
A recovered acknowledgement never causes stale generic reporting or mirror writes
over newer state.

Explicit preview reads return a bounded 32 KiB private summary to the server;
only safe display fields reach the browser. Full retained-page hydration occurs
only for an explicit action and is bounded to 2,162,688 bytes. Mutation raw JSON
has that same bound; encoded HTTP JSON is limited to 4,325,440 bytes and individual
acknowledgements to 2,048 bytes. Current-authority projections are capped at 32 KiB
and their indexes are valid only with the exact full-snapshot revision.

## Fresh import, promotion and cleanup

Choosing ordinary fresh orders durably supersedes an older recovery before the
provider read, even if that fresh attempt fails or its result is uncertain. The
old stage retains its payload and capacity but cannot resume or overwrite newer
data. Private supersession cannot be reversed by restoring old public markers.
Generic writers cannot erase the retained admission, run or debt. The existing
bounded history compaction keeps its retained run within the current hot limit.

Promotion requires an exhausted traversal, exact source reconstruction and current
workspace CAS. It preserves older out-of-window orders and user-entered costs.
Incoming deterministic null cost placeholders are reconstructible while explicit
canonical cost overrides remain intact. First-sync bookkeeping completes only the
orders area; unrelated failed areas and freshness cannot be made successful.

Canonical state, durable completion truth, quota adjustments and cleanup are one
transaction. Any failed check rolls them all back. Full source binding remains in
the private completion receipt. Canonical source rows plus retained window, page
capture times, API versions and cursor digests preserve required evidence.

Raw pagination cursors and expired leases are temporary control state disposed
of only after confirmed promotion. They are not claimed to be reconstructible
source evidence. There is no TTL cleanup, automatic abandonment or deletion of
accepted orders. Abandoning an unfinished stage needs separate owner approval and
is not implemented by these RPCs.

## Privacy and compatibility

Private tables deny ordinary direct access. Only five fixed-purpose service RPCs
are callable, with explicit tenant/current-actor checks and fixed empty search
paths. Schema reapplication must preserve those restrictions and earlier protected
receipt boundaries. Parent deletion and cascading truncation cannot erase retained
recovery or completion evidence.

The narrow recovery projection permits existing trusted-store hot-history and
reporting maintenance. It does not make arbitrary edits to every audit/work/history
field immutable. Approval, session, credentials, settings and unrelated business
state remain outside the recovery mutation authority.

Recovered source manifests use `shopify-order-read/v3` and `sor3:`. Ordinary v1/v2
bytes and meaning remain unchanged. Recovery provenance does not establish
financial authority, refund/tax/settlement qualification, causal attribution,
complete incremental ingestion or authenticated webhook coverage.

Rollback requires compatible readers/writers, retained guards and reconciliation
records. Pausing admission does not erase stages or settle unknown outcomes.
Installing SQL and its service permissions, activating recovery, releasing the
application and production acceptance remain separately reviewed operational steps.

## Acceptance and resource evidence

Required evidence includes actual disposable PostgreSQL role/CAS/quota races,
restart and lost-acknowledgement boundaries, slot reuse, older writers and fresh
supersession, source/cost reconstruction, rollback cleanup, first-sync isolation,
unchanged ordinary imports, current-session attacks, private serializers and
responsive affected controls. GitHub browser tests use synthetic transport with
zero live provider requests; actual screenshots must be inspected.

Measure stage mutations, fresh-authority reads, explicit summary/full reads,
existing primary saves, reporting/mirrors and provider body bytes separately. The
per-pass twelve-stage-mutation ceiling is not a total-request or cost guarantee.
Durable staging can reduce repeated provider reads while increasing total data
traffic; no bandwidth or monetary saving is promised.
