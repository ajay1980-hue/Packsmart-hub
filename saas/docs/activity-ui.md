# Workspace activity card

Owners and admins can open **App activity** in **Audit & Account**. The card always uses the signed-in workspace; the fleet selector cannot choose its tenant. Opening it requests `GET /api/activity` once. Refresh requests a newer check. A successful check is reused when closing and reopening the card; leaving the page or changing session clears it. There is no polling, provider request or bootstrap reload.

The card distinguishes recorded requests from completed requests, save attempts from confirmed saves, and the existing saved-data check from a new save. Body sizes are totals of measured content only: counts of unknown-size observations remain visible, and a partial subtotal is labelled as such. Job figures count observed events, not the current queue or distinct jobs. Reporting save retries have separate fixed labels from primary save retries. Compact reporting request bytes are never shown as saved workspace size or storage growth. Unknown is shown as **Unknown**, including an uncertain running-request count after the tracking limit is reached; a recorded zero stays **0**.

Coverage explains server-local observations, omitted activity, recording limits, timing uncertainty and resets. A changed server identity is called out rather than adding its counts to the previous check. Completion-window reasons use fixed plain-language labels. Failure and retry alerts are withheld when the supplied window is ineligible. These observations never claim provider charges, physical database storage or network billing.

Rendering uses fixed counter names, three snapshot cards and at most five notices. Foreign workspace responses and malformed envelopes are rejected. Closing the card, navigation, logout and session replacement invalidate old requests. The request's current-view predicate also protects against a late 401 arriving before the browser dispatches the details-close event. Errors require explicit refresh; no automatic retries occur.

## Verification

- DOM and actual app lifecycle checks: `node --test saas/server/tests/activity-ui.test.mjs`
- Responsive browser check: `node saas/server/tests/activity-browser-check.mjs`
- Screenshots: `/tmp/runvara-activity-{320,390,1200}.png`

The browser check uses a local authenticated synthetic workspace and intercepted activity responses, with no provider calls. It exercises the 320, 390 and 1200 pixel layouts, permissions, repeated clicks, partial and unavailable data, restart/overflow, escaped fields and interrupted/session flows. Installed Playwright Chromium in SaaS CI is the real-browser gate; local DOM checks do not replace it.

See [activity-observability.md](activity-observability.md) for the backend scope, byte semantics and bounded recording contract.


The incremental integration keeps outcome and activity reset/pause handlers
active together. Combined real-app tests cover navigation in both directions,
delayed 401s and logout before its response, and require clean Audit/Billing
navigation. The full local Node22 suite passed 1,000 tests; responsive Chromium
and Android Build on the retargeted main PR remain exact-head CI requirements.
No new background refresh, schedule or persisted metadata is introduced.
