# Owner restrictions at Shopify content dispatch

The later [objective content bridge](objective-content-bridge.md) adds a distinct owner-requested v2 source contract for the same title/description operation. The v1 manual restriction and claim bytes described here remain unchanged. A diagnostic still supplies no financial qualification or autonomous execution authority.

The original dispatch stage was prepared from `ccdd506162612477a66dafc917fa3b050c2f6d77`. It adds an inactive-by-default execution-policy contract to existing business objectives and enforces it on the existing manually requested Shopify `product_content` action. The subsequent preparation adds an owner editor for restrictions on already saved objectives. Neither change adds SQL, grants, databases, credentials, provider activation, recurring work or automatic customer policy configuration.

Owners can deliberately add, move or remove a saved objective's restriction in the cockpit through the existing API. There is no qualified-financial executor or Commander action path in this stage. The existing default `profitFirst: true` makes an explicitly enforced objective evidence-blocked. Only a deliberately configured policy with profit-first false and no financial/stock constraints can admit an otherwise approved manual content change. The restriction editor preserves those saved conditions; this gate is not an executable profit optimizer.

## Explicit scope and owner configuration

Objectives with no `executionPolicy` field remain preparation-only. Existing example goals are not activated or backfilled. The existing owner/admin planning form does not activate restrictions; its saved-objective list distinguishes planning-only goals from an enforced account scope and hides enforced-record editing from admins.

Configuration uses the existing authenticated, CSRF-protected `PUT /api/business-objectives` contract. The cockpit's separate restriction editor sends the current saved objective ID/revision and an explicit execution policy. The API also continues to support an owner's explicit policy when creating an objective; the ordinary planning form does not send that field:

- `schema`: `runvara-objective-execution-policy/v1`.
- `mode`: `preparation_only`, without a scope; or `enforce` with the exact scope below.
- `scope.provider`: `shopify`.
- `scope.operation`: `product_content`.
- `scope.connectionId`: the existing connection's exact ID.
- `scope.account`: that connection's exact lowercase `myshopify.com` domain.

The backend checks the current stored actor, not a role or approval assertion supplied in the body. Only an active owner without a required password change can supply this field or edit any part of an already enforced objective. That includes its status, dates, limits, target, title and disabling the policy. Existing admins may still create/edit preparation-only goals. Objective revisions and existing workspace CAS apply to all configuration changes; audit records include the policy mode and authenticated actor. There is no objective delete, archive or collection-replacement API, and pilot import does not import objectives.

The scope applies to every matching manual content write. It cannot be bypassed by omitting an objective selector. Matching uses provider/action/account independently of objective status and dates. A replaced connection ID for that same account blocks until the owner reviews its scope. An enforced objective that is paused, disabled, completed, cancelled, scheduled or expired stops matching changes; it does not silently disappear from the policy set. To remove the restriction, the owner must explicitly select `preparation_only`. Other accounts and operations are outside this first contract, not implicitly governed by it.

## Saved-objective restriction editor

After explicitly loading saved objectives, an owner can choose **Manage restriction** on a row. The editor shows the saved title, revision, status/time window, target, baseline, limits and exact scope. Planning edits and restriction drafts are mutually exclusive; an unsaved planning draft must be saved or cancelled before opening restriction editing. Admins retain their existing preparation-only planning controls, and client handlers recheck the current owner identity as well as hiding owner-only controls.

Available accounts come from sanitized public connection references already in bootstrap. Opening the editor does not fetch, connect or sync. A new restriction starts with no account selected; an existing exact saved binding is displayed. **Discard draft and reload saved objective/accounts** explicitly reads `/api/business-objectives` and `/api/connections` once each. Eligible choices require a unique, valid exact Shopify connection ID and its stored lowercase `myshopify.com` domain. A saved disconnected reference is selectable, without implying verified connectivity or write authority. A missing, replaced or changed saved binding remains visible as unavailable; it is never rebound to the first available account. Explicit removal remains possible when that account has disappeared.

Adding or moving a restriction requires a deliberate account choice and a fresh acknowledgement of the displayed change. Moving names both old and proposed accounts; removal states that this objective's extra restriction is removed while other policies, permissions and mandatory approval remain. Changes to the proposed mode/account reset acknowledgement. Reloading replaces the source revision and draft, and also requires a new acknowledgement. Cancel and unchanged-policy submission make no PUT.

A save sends exactly `{id, revision, executionPolicy}` using the draft's original revision. Removal sends the valid `preparation_only` object with no `scope`. No title, target, baseline, date, status or limit is copied into the policy patch: zero, false, null, fractional amounts, currency and approval kinds stay as saved. Older planning clients that omit `executionPolicy` preserve its stored value; absence on an old preparation-only objective remains absent. Saving a restriction does not create an approval, diagnostic, proposal, job or provider request.

Drafts and pending requests stay in memory and are fenced to the current session, workspace, owner role, bootstrap generation and editor source. Duplicate submits and concurrent planning/policy saves are blocked. Close, navigation, hidden-tab transitions and session/bootstrap replacement invalidate pending editor work, so late responses cannot repopulate a dismissed or newer editor. Hiding the tab retains unsent choices as stale, clears their acknowledgement and requires explicit reload/review; returning never restarts work. During a sent PUT the normal Cancel action is disabled. Leaving the view cannot cancel a server commit; an interrupted save requires an explicit saved-state read before another change.

Objective/workspace conflicts and changed-account errors retain the choices as stale and require explicit reload/review. A lost response, server failure or malformed success is an unknown save outcome: the change may have committed. The editor never retries automatically, substitutes a newer revision beneath an old acknowledgement or falls back to a planning save. Authentication or owner-role loss clears the private draft. Confirmed success renders the authoritative returned snapshot, closes the editor, returns focus to the row and marks diagnostics tied to the old objective revision stale.

The displayed saved conditions retain the dispatch semantics below: profit-first and every non-null margin, budget or stock constraint, including zero, remain evidence-blocked; non-active status/window also blocks matching writes. The editor neither relaxes those fields nor claims that an account or objective is ready to execute. All applicable restrictions and exact mandatory approval continue to apply.

## Exact proposal and approval

When matching restrictions exist, the server adds a `runvara-objective-dispatch-proposal/v1` envelope to the existing write. It binds the tenant, server-derived `owner_manual` origin, write identity, exact action/input digest, account, connection, requester, required approval kind and sorted objective IDs/revisions/content hashes. The approval payload contains the envelope digest. The immutable write identity includes the envelope only when present, retaining byte-identical legacy claim shapes for other writes and saved Meta processing records.

Callers cannot submit origin, objective selectors, policy envelopes or financial-evidence authority through the channel write route. No objective-driven Commander execution is introduced. Request-ID reuse never regenerates an approval under new restrictions. Existing pending manual requests without a matching binding require a new exact proposal and owner approval after a restriction is activated. A changed or disabled policy also cannot silently refresh a bound approval. Completed history remains readable and uncertain/claimed phases remain non-replayable.

## Qualified evidence is still required

This stage can enforce identity, scope, revision, active time window and exact mandatory approval. It cannot establish commercial readiness.

Any matching non-null gross-margin, advertising-budget or stock-cover limit, including an explicit zero, requires financial/stock evidence that this stage does not have. `profitFirst: true` likewise blocks. Existing defaults remain unchanged, so an owner who explicitly activates a typical profit-first objective should expect an evidence-required blocker. Multiple policies are conjunctive; different recorded currencies also report a conflict. No monetary limit is converted, weakened or consumed.

An owner approval, `financialImpact`, planning evaluation, current product economics, report reference, legacy verified flag or caller-supplied estimate cannot supply execution evidence. `evaluateObjectivePlan` remains an internal, supplied-unverified preparation evaluator. A policy with no financial/stock restriction and profit-first explicitly false can permit an otherwise exactly approved manual content change; this proves neither financial benefit nor progress toward the objective target.

No request/credit/money allowance is issued. Paid creative work, crawling, advertising and other financially qualified execution need their own independently reviewed evidence and atomic consumption contracts.

## Dispatch, races and receipts

The dispatcher validates the entire objective collection from its one existing full-state load before selecting applicable policies. Its detached policy snapshot is immutable. The original objective source is hashed and pinned through local checks and full-state save acknowledgements, including protection against in-place mutation during a shallow Supabase save's archive awaits.

The existing fresh context read already requires the exact whole-workspace revision. That equality attests that the validated complete policy source has not changed, so no second objective download, wider projection, new RPC or full-state fallback is added. A different replica's new or edited policy causes the existing CAS/projection checks to fail. Initially absent policy state inserted during a pending save is rejected and cannot enter the already captured CAS body.

Current-time eligibility is checked before provider preparation and after the fresh checks immediately before the mutation phase. Expiry is therefore enforced even without a workspace revision change. Structural identity and source checks apply to every save, but temporal admission is not rerun merely to save a result. If an already-authorized HTTP request succeeds after the objective expires, its confirmed Shopify product reference, completed work and receipt remain persistable. A concurrent committed workspace change still cannot be overwritten; an unconfirmed result save remains uncertain and never grants a replay.

The existing acknowledged phase claim remains the authorization point. This is not a distributed transaction with Shopify and cannot recall an in-flight request. Expiry after a phase claim but before dispatch leaves that claim retained and non-replayable. Legacy Meta/Instagram authorization, observation and phase behavior remain unchanged because Meta is outside this policy scope.

## Bounds and usage

- Existing maximum: 50 validated objectives. Policy source serialization is capped at 128 KiB and has strict structural/depth bounds.
- A proposal is capped at 8 KiB. A large applicable set is rejected, never truncated. Not all maximum-length objective sets are guaranteed to fit.
- Fresh dispatch response cap stays 32 KiB. Oversized responses block without fallback.
- Normal successful Shopify execution retains two projected reads and three full-state saves. Policy capture adds no database requests, provider requests, timer, model tokens or background storage writes. Saved policy definitions and bounded envelopes add their actual bytes to existing state writes; this is not a zero-bandwidth claim.
- No live policy, product change, approval or customer outcome was created for validation.

## Verification and release boundary

Coverage includes policy/schema/API authorization; all enforced-objective update fields; legacy manual activation bypass; forged proposal and approval binding; malformed and foreign stored policies through the HTTP execution route; unknown and explicit-zero financial evidence; multiple/currency-conflicting policies; exact time boundaries; two mocked Supabase clients interleaved at credentials and phase acknowledgement; source mutation during pending saves; successful receipt persistence after expiry; and permanent no-replay after an uncertain provider response. Existing security, tenant, connection, outcome, activity and UI suites remain intact.

The concurrency fixtures exercise actual SupabaseStore conditional requests against fake Supabase, not live PostgreSQL or provider accounts. No new SQL is introduced and no new PostgreSQL race proof is claimed. Local Node22 and existing guard/syntax results are recorded separately from exact-head remote CI, real responsive Chromium/container checks and authenticated production acceptance. Production releases remain paused.

Original dispatch-stage local verification on 2026-10-07: 1,036 Node tests passed, zero failed/skipped, under Node 22.23.3. Full syntax, SaaS security guards and whitespace checks passed. Independent read-only review accepted that stage's stated scope and separately passed 262 policy/schema/API/dispatch/context cases. The later HTTP malformed/foreign-policy test was included in that stage's final full suite. At that verification point, the expected Playwright Chromium executable was absent and Docker was unavailable, so no real browser or container pass was claimed. Locked existing test dependencies were installed from the local cache with scripts disabled; package-lock was unchanged. These historical results do not establish acceptance of subsequent editor changes.

Editor preparation adds synthetic API cases in `business-objectives-api.test.mjs` for policy-only field preservation, legacy owner/admin omissions, explicit owner removal after account loss, stale revision and workspace-CAS rejection. `objective-restriction-ui.test.mjs` exercises the real HTML/JavaScript with synthetic responses and lifecycle interruptions. The existing `objective-review-browser-check.mjs` is extended with owner add/cancel/no-op/move/remove flows and screenshot states at 320, 390 and 1200 pixels with normal and 200% text. Prepared fixtures and screenshot paths are not browser execution evidence. Current full-suite, browser, container and exact-head CI results must be recorded separately; none of these fixtures establishes live account acceptance or authorization to release.

## Compatibility and rollback

Before any real owner activation, every production dispatcher must run code that understands this contract. This preparation does not activate a policy on the currently single-instance service.

After activation, do not roll back to an older executor that ignores `executionPolicy`. A rollback must retain the restriction reader and deny affected dispatch, or deploy a reviewed fail-closed executor while preserving all objectives, approvals, phase claims and results. Do not erase policies, regenerate old bindings, delete uncertain phases or silently change owner limits to make rollback pass. Previously in-flight calls cannot be recalled.

The saved-objective owner editor addresses restriction management in the cockpit. Remaining original-scope work includes qualified operation-specific financial evidence and allowances, objective-driven proposals/delegation, originating-objective action-to-outcome links and comparable learning, and other action scopes. This preparation is not a completion claim for those capabilities or for the original autonomous OS.

## Prepared publication-time action evidence

Successful supported content dispatch may retain a bounded prospective context through its existing exact final save. Every applicable policy ID/revision/digest and the exact approved proposal are preserved, or linking is unavailable without losing a known provider result. These are restrictions on `owner_manual` actions; they never become an originating-objective link. Publication-time immutable outcome snapshots can preserve this context after explicit owner association. No financial gate, dispatch permission, policy activation or provider retry changes. See [reviewed-action-outcomes.md](reviewed-action-outcomes.md).
