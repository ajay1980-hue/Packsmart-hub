# Inactive production-health verifier

This is local preparation on main `d32da62d0e7935597638266d44d88ae5e066d51f`. No production request was made. The production browser navigation permission remains unresolved and the release hold remains in force. Local synthetic tests cannot clear that permission or establish production health.

`server/lib/production-health-verifier.mjs` exports `verifyProductionHealth`. It deliberately has **no network adapter, global fetch fallback, command-line probe, server import, npm execution hook or workflow activation**. Importing it performs no request. Calling it without an explicitly injected transport rejects with `HEALTH_TRANSPORT_NOT_ACTIVATED`. Supplying a function is a technical dependency, not authorization to contact production.

## Contract

Inputs are the exact lower-case 40-character expected commit, a verified deployment-completion timestamp, and an explicitly supplied transport. `deployedAt` must be a valid canonical UTC timestamp including milliseconds, for example `2026-10-07T12:00:00.000Z`. Do not substitute a build start, merge time, current clock or guessed completion time. Convert a trusted higher-precision timestamp to milliseconds before invoking; the health timestamp must still be strictly later.

The only accepted destination is the exact string `https://packsmart-ops.onrender.com/api/health`. HTTP, explicit ports, URL objects, credentials, aliases, alternate paths, queries and fragments are rejected before transport invocation. Every attempt supplies only GET, `redirect: 'error'`, `credentials: 'omit'`, `cache: 'no-store'`, and an AbortSignal. It supplies no request body, custom headers, cookies or authorization. There is no arbitrary URL or request-options pass-through.

Success requires all of the following in the same response:

- Exact final destination, `redirected: false`, HTTP 200 and JSON media type, optionally UTF-8 charset.
- Nonempty valid UTF-8 JSON within 16,384 accepted body bytes. Declared Content-Length, if present, must be valid, within the limit and match bytes read. Other content encodings fail closed; missing/identity is accepted. The future adapter must verify this compatibility rather than assuming a compressed live response will pass.
- Exact expected commit, `storage: 'supabase'`, literal `ok: true` and `productionReady: true`.
- Literal true checks for persistence, primaryPersistence, stateSizeSafe, authentication and credentialEncryption. Missing, null, string, numeric and false flags never pass. `billingCharging` is intentionally not required: enabling charging is not a health prerequisite.
- A valid canonical `checkedAt`, strictly after deployment completion, no more than 30 seconds old and no more than 5 seconds ahead of the verifier clock. Future tolerance is explicit clock skew, not permission to accept an old result. The response's advertised check-cache bound must be a nonnegative integer no greater than the current 5,000 ms server limit.

The result contains only safe verification evidence: exact destination/deployment/commit, checked and verified timestamps, storage/required checks, attempt count and accepted body-byte counts. It never returns full persistence diagnostics or raw response bodies. Transport errors are replaced by a fixed code; arbitrary exception text and spoofed verifier codes are not echoed. A result is an observation at its recorded time, not a permanent release approval or a ledger of customer/business outcomes.

## Invocation budget and failure behavior

Default: **one GET**. A caller may explicitly request at most **three GETs** per invocation. Only a well-formed, same-commit, fresh HTTP 503 with unhealthy boolean checks is eligible for another attempt. Redirect, authorization/status errors, malformed body, foreign revision/storage, invalid/missing flags, stale/pre-deployment/future evidence and transport failures stop immediately. A failed request timeout stops the invocation without starting another request.

Requests have a 5-second maximum deadline including headers, streaming body and validation. Retries wait at least 5 seconds after the preceding response. The entire invocation, including delays, has a 20-second maximum deadline; smaller positive deadlines are supported, larger ones are rejected. A later attempt may be truncated by the overall deadline. Abort signals, asynchronous deadline races and monotonic checks reject late results. No polling continues after resolution/rejection and no interval, background task or persistent metadata is created.

The maximum **accepted logical response body** is 16,384 bytes per attempt or 49,152 across three attempts. This is not a hard external wire-bandwidth cap: a transport may deliver an oversized chunk before cancellation, buffer bytes elsewhere, or continue independently if it ignores abort. Likewise the deadline bounds the verifier's asynchronous waiting and acceptance, not the lifetime of an uncooperative external request. It cannot preempt arbitrary synchronous blocking JavaScript inside a trusted injected dependency; the event loop must remain able to run. A timeout never launches an overlapping retry, and a late response body is cancelled when it arrives. Cancellation itself is not awaited indefinitely.

Current `server.mjs` coalesces persistence checks and caches them for up to 5 seconds; refresh occurs when age is greater than 5,000 ms. `SupabaseStore.ping()` makes one existing `saas_workspace_state?select=workspace_id&limit=1` read. Therefore a future compliant adapter's one-to-three health GETs can induce at most one-to-three such existing ping reads, with cache/coalescing sometimes reducing that number. Exact equality at the cache boundary may reuse a sample; the verifier still enforces timestamp freshness and deployment ordering. No mirror, tenant-state mutation, provider/model call, billing amount, storage growth or production saving is inferred. A noncompliant adapter that internally retries or redirects would invalidate this request/read budget and must not be activated.

## Future activation gate

Before any production use, resolve authorization for a supported existing route. The pending browser permission is neither replaced nor bypassed by this prepared code. The owner/coordinating task must explicitly authorize the production destination and execution route; possession of this module, a passed local test, a flag or an injected function does not supply that approval.

Only after that authorization, prepare and review a bounded adapter for the existing CI system. It must enforce HTTPS certificate verification, the exact destination, no redirects/credentials, abort/cancellation and no hidden transport retries; verify its response URL/encoding behavior. No permissive TLS/proxy, browser-warning bypass or alternate host is allowed. Bind the expected SHA and actual completed deployment time from trusted release metadata, prevent concurrent/automatically repeated runs, and keep the single-invocation limits above. Any adapter/workflow wiring is a separate reviewable change. This commit adds none.

Then run exact-head CI for that separately authorized wiring and obtain fresh health evidence for the actual deployed revision. Wrong/stale/malformed results leave the gate closed. This verifier does not migrate, merge, deploy, activate a provider, grant access, generate credentials or change the release hold. Existing responsive browser/container/Android and predecessor release checks remain separate.

## Local verification

Only injected synthetic responses are used, including stalled reads, transports ignoring abort, late cancellation, malformed/oversized bodies, false/null flags, foreign revisions, strict deployment/freshness boundaries, narrow retry behavior and total wall-time expiry. Existing Node22 test discovery runs these fixtures without a production request. No external network transport is imported by this test file.

Run the synthetic cases with `node --test saas/server/tests/production-health-verifier.test.mjs`. Run the existing full server suite, syntax checks and SaaS guards for integration validation. The module can be syntax-checked directly with `node --check saas/server/lib/production-health-verifier.mjs`; no npm or workflow hook is needed. Final local counts and independent review are recorded with the accompanying evidence. PostgreSQL migrations/runtime code are unchanged; no new database validation or production-health result is claimed for this verifier.

Final local validation on Node22.23.3 passed **1,038 full server tests**, including **28 synthetic verifier cases**, with zero failures/skips. Existing syntax/SaaS guards, direct module/test syntax and whitespace checks passed. Independent review reproduced and closed a late-clock deadline edge and found no remaining blocker after four targeted cases passed. These are local code checks; the verifier remains unactivated and production health is still unverified by this preparation.
