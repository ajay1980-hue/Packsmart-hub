# Selected outcome relationships

This local stage adds a descriptive relationship to the existing selected
experiment review. It reuses that review's database snapshot and does not enrich
the general business graph, Command, forecasts, learning or execution. The source
base is combined compatibility commit
`54e1005023e32ba88998caceeae09296e79369fe`; this is not a production release or a
claim about current-main ancestry.

## Read and trust boundary

`GET /api/business-outcomes/experiments/:id` keeps its existing authenticated
owner/admin access and request limit. `getBusinessOutcomeReview` still delegates
to `createBusinessOutcomePersistence().review`, which makes exactly one
`runvara_read_business_outcome_review` RPC with the existing 128 KiB response cap.
The SQL function reads workspace revision, unique selected experiment, current
typed draft and current publication from one stable SQL snapshot. No additional
database, workspace, provider or browser request is added.

Only after the adapter validates the returned tenant, identity, draft and
publication does `projectValidatedSelectedReview` mint a private transient context.
Its detached data is frozen; its token is consumed only by
`selectedReviewRelationships` and removed immediately afterward. There is no
public context constructor. Neither serialized review JSON nor a client-supplied
relationship object can create this context. The existing WeakMap publication
boundary used by `current()` and aggregate qualification is unchanged. The new
serialized projection cannot substitute for that boundary.

## Bounded relationship contract

The added `relationships` property has schema
`runvara-selected-outcome-relationships/v1`, scope `selected_experiment_only`,
at most two nodes and one edge. Its complete property envelope is checked against
4,096 UTF-8 bytes before return. Its identifiers use a separate `selected_`
namespace. The snapshot has a new opaque read identifier, an opaque workspace
revision reference and the adapter's read-completion time. The time describes the
read; it is not a database commit timestamp or a freshness promise.

The first node refers to the uniquely selected existing experiment. If a current
publication exists, the second refers to that logical outcome, with an opaque
version reference. The edge says only that a measurement was recorded for that
experiment in this review snapshot. No action, approval, objective or opportunity
relationship is inferred. Each canonical graph reference remains explicitly
unresolved: the review does not contain the graph's complete collection, alias
occurrence ordinals or array pointers. It must not invent a graph node ID.

Raw source identifiers, titles, actor data, report bodies, monetary amounts and
source-reference contents are absent from the added projection. Opaque hashes are
internal references, not secrets or authorization credentials. The existing
review fields and access control are unchanged; original reports continue
through the existing explicit evidence read. Source references are not newly
resolved or fetched.

## Publication and coverage semantics

- A missing selected head means no publication was found for this experiment in
  this snapshot. Other outcomes and whole-graph synchronization are unchecked.
- A complete current publication is an owner-attested measurement. It does not
  establish independent verification, causal impact, future value, financial
  execution permission or usable learning authority.
- An incomplete publication stays unqualified. Legacy graph assertions stay
  unqualified and do not enter this projection.
- A newer draft leaves the current published source unchanged. Matching requires
  both the exact measurement revision and digest; mismatches are explicit.
- A correction retains the logical outcome reference and advances the source
  version and edge references. A withdrawal retains the recorded relationship
  with withdrawn status and removes qualification.
- Other outcomes, cross-outcome comparability and whole-graph synchronization are
  explicitly unchecked. Causal, forecast, learning and execution authority are
  explicitly false. No aggregate or new financial authority is created.

## Selected review UI and stale results

The existing explicit detail read carries the projection. For the indication,
the browser derives a display enum after strict shape, scope, source, draft and
publication consistency checks; it does not mint a server capability or pass this DTO to an
execution consumer. Fixed copy describes whether the selected result was linked,
absent, incomplete or withdrawn and states that only this experiment was checked.
The indication contains no raw IDs, amounts, actors or implementation terms.

Save and publication attempts immediately clear the indication, including lost
acknowledgements and conflicts. Navigation, panel close, reset, logout and session
replacement clear it too. Write replies, overview refreshes and late responses
cannot restore it; a successful explicit selected-detail refresh can. Existing
request coalescing remains. No polling, automatic refresh or background read is
added. Changes made elsewhere after the snapshot remain unknown until the next
explicit detail read; this is not a continuously current head claim.

## Validation and rollout limits

Node 22.23.3: all 1,190 server tests passed, including security, tenant isolation,
objective dispatch, graph qualification and the new adversarial/query-count/UI
regressions. Independent read-only review found no blocking issues and separately
passed 75 focused store/API/UI/app-lifecycle tests. Syntax checks, the 15-product
SaaS guard and `git diff --check` passed.

The unchanged outcome PostgreSQL suite passed all 25 tests on a disposable local
PostgreSQL 17.6 cluster, including concurrent correction snapshot consistency and
read lock behavior. The cluster was stopped and its loopback listener verified
closed. No migration, SQL fixture, workflow, grants or migration filename changed.
In particular, `20261007074031_reporting_status_cas.sql` and
`20261007100823_business_outcome_publication.sql` remain intact.

UI coverage uses JSDOM and actual app lifecycle code; it is not a real-browser
visual acceptance test. The existing responsive outcome-review fixture now uses
the real adapter projection and asserts selected wording, privacy, save/navigation
clearing and zero extra requests at 320, 390 and 1,200 pixels. Its existing
workflow and screenshot paths are unchanged. Chromium is unavailable locally;
actual browser execution and screenshot acceptance remain pending.

Test data is synthetic, transport/provider responses are mocked or served on
loopback, and no production health probe was run. Production
and remote publication remain held. No providers, owner policies, verification
workflows or financial execution were activated.

This stage is additive and read-only. Removing only this projection and its UI
indication does not remove the existing outcome publication or objective dispatch
controls. Any rollback must preserve those controls; reverting to an older
executor that ignores an active owner policy is unsafe. This stage still leaves
canonical graph integration, real action/objective links, causal attribution and
qualified financial execution as separate, unresolved work.

## Prepared owner-selected action association

The selected review may include compact action candidates and `currentActionAssociation` from the same committed review snapshot when `actionLinkContract` is supported. No full action text is added to summary or current-head reads. Exact action/approval links are descriptive owner associations only; originating objective and opportunity remain null. Historical action text is fetched only for an exact immutable version and does not check current head. Existing refresh-only/session/stale-response safeguards apply. See [reviewed-action-outcomes.md](reviewed-action-outcomes.md); real migration/application is held.

## Prepared reviewed-action selection UI (2026-10-07)

The optional action selector is separate from the opaque relationship indication
above. It is enabled only by `actionLinkContract: runvara-reviewed-action/v1`
with a bounded, unique compact candidate list from the existing selected review
snapshot. New drafts start with no action. A choice sends only `actionId`; an
explicit reuse choice sends only the exact `reuseVersionId`. Removing a saved
association sends `actionSelection: null`. No choice triggers provider work,
extra browser reads, background hydration or automatic publication.

A linked saved draft retains its explicit association. If a fresh action choice
has disappeared or its digest differs from the saved draft, the UI refuses to
silently replace it. The owner can choose the exact current immutable source for
a correction, choose another available action or remove the association. The
current immutable association arrives separately from the current draft, so a
later unlinked draft cannot replace the published source. Existing immutable
reuse selections preserve their exact version ID.

The saved measurement and owner confirmation show the exact recorded action ID,
Shopify account, product ID and completion timestamp. Attestation explicitly
includes the selected association and states that it establishes neither a
comparison, causality nor commercial benefit. Manual policy references do not
become an originating objective. Snapshot immutability begins at publication;
there is no claim of an execution-time immutable acknowledgement.

Full recorded action input appears only in the existing explicit exact-version
evidence request. The UI checks strict source/intervention shapes, tenant and
reference bindings, bounded source bytes and SHA-256 hashes before rendering
escaped, untruncated title and description text. A linked response without exact
source evidence fails closed. WebCrypto absence or an integrity failure cannot
produce a verified source display. Summaries do not include action input text.
Historical evidence remains available after withdrawal and says that the current
status was not checked.

The existing refresh-only relationship lifecycle remains unchanged. Form edits
cancel an unsubmitted review; duplicate writes coalesce; an uncertain publication
keeps the same intent and requires another explicit attestation. Close,
navigation, logout, replacement sessions and late source-hash completions cannot
restore stale indications or render abandoned evidence. This local preparation
adds synthetic UI/lifecycle and intercepted 320/390/1200 browser coverage; it is
not a deployment or proof that the live storage contract is installed.
