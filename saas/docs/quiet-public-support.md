# Public support during quiet startup

This is a separately controlled, deterministic saved-order responder. It does not enable the dashboard, login, preview, maintenance pilots, workers, integrity repair, integrations, generation or publishing. Installation and local tests do not authorize hosted activation.

## Configuration and admission

- `RUNVARA_STARTUP_MODE=quiet` remains required for the quiet support capability.
- `RUNVARA_QUIET_PUBLIC_SUPPORT` defaults to `disabled/v1`. Only exact `disabled/v1` or `enabled/v1` values are valid. Enabling outside quiet mode is a startup error.
- An enabled process requires the bounded Supabase support reader. There is no ordinary workspace-reader fallback in the public handler.
- When enabled, only `OPTIONS` and `POST` at exact `/api/public/support` are admitted. Other quiet-mode decisions are unchanged. The policy is captured at process construction; tenant settings and requests cannot enable it.
- `/api/health` exposes the boolean `quietPublicSupport`. It does not attest to current order freshness or successful customer lookup.
- There is no automatic expiry. A hosted trial must have an explicit closure deadline and an operator responsible for disabling the flag, deploying the same build and verifying enabled predecessors have stopped. Normal startup must never be used to open this endpoint.

## Request, privacy and read limits

The existing allowed browser origins remain `https://packsmartsolutions.com`, `https://www.packsmartsolutions.com`, and `https://packsmartsolutionscom.myshopify.com`. Verify the actual storefront origin before an approved test; do not broaden this list to make an unexpected origin work. Requests without Origin retain existing non-browser compatibility. CORS is not authentication.

The JSON body limit is 8 KiB. Only string `message` (1200 characters), `orderNumber` (80) and `email` (254) fields are used. Client tenant/workspace selectors cannot choose storage. Payloads, customer emails and order-status URLs are not logged by this handler. Responses use no-store and issue no session cookie.

Support admits at most 20 POST attempts per rolling minute per reported IP AND per process in total, then blocks the exhausted key for five minutes. The conservative instance cap prevents changing forwarded IP headers from bypassing the overall bound. It also means one caller can temporarily exhaust availability for others. Limits are memory-only, reset on restart and apply per overlapping instance; they are not a monetary spending cap. OPTIONS performs no database read.

Generic questions and incomplete order requests perform no database operation. A complete saved-status query performs one primary-state GET for the fixed `packsmart-solutions` workspace, selecting only row/embedded workspace IDs and the orders array. The response is capped at 2 MiB and 5000 saved rows. Missing/malformed/oversize/foreign data fails closed, with no retry, hydration, save, archive compaction, credential decryption, reporting refresh or provider call. File-store compatibility is for normal/local operation only; quiet activation requires Supabase.

PostgREST projects the saved orders collection, so its records pass through the trusted server before a field allowlist strips unrelated order data. It does not fetch workspace users, connections, credentials, audit or other collections. Only a unique Shopify order-reference plus normalized email-hash match may produce an order response. Ambiguous matches fail closed. This is possession of order details, not a full authenticated customer session. Status-page links are returned only after a match and only for the existing allowlisted HTTPS store origins without URL credentials. Unknown link hosts are omitted.

The responder labels status as saved information, not a live carrier or inventory query. There is no ticket creation, outbound message, refund or order edit. Human-needed replies explicitly direct the customer to contact Packsmart themselves. The frontend must render replies safely and must not imply a message was delivered. Its separately managed contact link and unavailable/CORS-error fallback need storefront verification.

## Bounded hosted acceptance and closure (not authorized by this document)

Before activation, approve the exact source commit, storefront origin, one-existing-service configuration delta, test inputs and fresh bounded bandwidth allowance. Use synthetic order evidence or separately authorized owner-controlled order details; local tests do not authorize reading or copying real customer records. Establish the closure route and operator availability first. A suggested initial trial is at most one preflight and four POSTs (generic, missing details, synthetic match, wrong-email denial), with no automatic client retry. Start closure on completion, failure, ambiguity, loss of coordination or the agreed deadline; a ten-minute deadline measured from opening-rollout submission is a conservative proposed limit, not server-enforced expiry.

An initial trial requires at most two same-build rollouts: enable support only, then restore `disabled/v1` or the exact prior absence. Keep all other quiet flags/settings unchanged. Observe exact commit and `quietPublicSupport` at startup, then verify the predecessor is stopped before test requests. After closure, verify the flag is false and all enabled predecessors are stopped. A closing rollout can be delayed or fail; stop testing and report rather than extending or claiming closure. In-flight reads/responses may finish after closure begins.

Closing cannot retract already returned data or erase browser/proxy logs. The application creates no chat-history record or audit/save entry for these reads; infrastructure access-log retention, storefront analytics and customer-device handling require review before general public operation. A rollback of code is a separate approval and does not replace disabling support. Do not reset budgets, erase history or rotate credentials as cleanup.

No schema, permission, credential or provider configuration change is required by this patch. Current hosted projection compatibility, actual storefront CORS behavior, saved-data freshness/size and continued public-operation cost/privacy acceptance remain hosted gates. Local synthetic tests do not prove those facts. Publication, merge, deployment and ongoing activation remain separate decisions.
