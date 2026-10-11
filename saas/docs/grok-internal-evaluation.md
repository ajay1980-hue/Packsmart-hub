# Internal Grok evaluation preparation

Prepared on 11 October 2026 against production commit `d32da62d0e7935597638266d44d88ae5e066d51f` (Runvara 6.15.2). This change is for a draft pull request. It must not be merged or deployed while the existing functional release hold remains unresolved; see the acceptance hold documented in PRs #79 and #83.

## Existing architecture

Runvara already registers xAI as an intelligence capability in `provider-router.mjs`. That registry plans routes and requires verified provider configuration; it does not dispatch paid work. The working brief dispatcher in `ai-provider.mjs` is OpenAI-specific. Its fixed Responses endpoint, job lease, request digest, current policy revalidation, atomic usage reservation, receipt settlement and uncertain-dispatch accounting must be retained.

`runvara_reserve_provider_usage` and `runvara_settle_provider_usage` already provide durable accounting through the existing Supabase store. Admission requires trusted tenant/provider policy, verified prices, an upper bound for **all** billable input and output tokens, and a current `agent_command` lease. A provider timeout is not evidence that a billed request stopped. Do not add a second service, database, ledger, automatic fallback or retry to bypass those controls.

Customer model selection in `ai-economics.mjs` remains OpenAI/deterministic. No customer model catalogue, connector, approval, audit, job or billing behavior changes in this proposal.

## Security and cost configuration

The exposed xAI credential was disabled and rotated with immediate expiration of the old secret. The replacement was copied directly into the existing `packsmart-ops` Render service's `XAI_API_KEY` and verified without disclosing it. Render **Save only** was used; no deployment or restart was triggered. The replacement remains disabled in xAI.

Its xAI permissions are limited to the console's Chat endpoint category and `grok-4.7`, with one request and 8,000 tokens per minute, and an expiry of 10 November 2026 at 23:59 as shown by the console. Endpoint authorization has not been exercised against the API. Rate limits are not a per-request spending bound: in-flight requests can continue after a limit is crossed.

Both Render flags are stored as `false`:

- `RUNVARA_XAI_INTERNAL_EVAL_ENABLED`
- `RUNVARA_XAI_PAID_USAGE_APPROVED`

Existing environment variables were preserved. The replacement is never included in source, request fixtures, responses, logs or this document. Automatic credit top-ups were disabled for the trial; existing prepaid credit remains available. This work made no paid AI calls, purchases or infrastructure changes.

## Internal preparation endpoint

`GET /api/operator/grok-evaluation` uses the existing platform-owner check: the authenticated owner of `packsmart-solutions` whose stored email matches `PACKSMART_ADMIN_EMAIL`. It retains fresh stored identity, active-user, session-version, forced-password, CSRF and API-rate controls. Customer owners, other roles, duplicate identities and revoked sessions are denied. Query and body overrides are rejected; workspace scope comes from the signed session.

The endpoint performs a compact identity read and returns three immutable synthetic fixtures for unknown margin, pending approval and incomplete connection evidence. Missing compact identity support fails closed without loading the full workspace. It does not read business data, enqueue jobs, mutate tenant state, reserve spend, send provider requests or settle usage. Each request has a digest, no tools, `store: false` and review criteria. This is preparation; no Grok-generated response or comparison result is claimed. The intended comparison is manual review against the existing OpenAI brief and the same deterministic findings, without automatic provider selection.

The two configuration flags are reported only. Setting either or both to `true` cannot enable paid transport. `executionAuthorized`, `writesAuthorized`, `customerEnabled`, `liveEvaluationCompleted` and every fixture's `readyToSend` remain `false`. Public health does not expose this configuration. If later deployed, the endpoint uses `Cache-Control: no-store`.

## Live evaluation blockers and price estimate

The [Grok 4.7 developer guide](https://docs.x.ai/developers/grok-4-7) reports no text output limit. The [Responses REST schema](https://docs.x.ai/developers/rest-api-reference/inference/responses) does not establish a hard `max_output_tokens` cap. A prompt asking for 180 words, a client timeout, an HTTP body limit or a TPM rate limit cannot stand in for a verified bound on billed reasoning and output. Do not mark that proof verified or reuse OpenAI's endpoint-specific proof for xAI.

At the [published Grok 4.7 short-context rates](https://docs.x.ai/developers/models/grok-4.7) checked on 11 October 2026, input costs $2 per million tokens and output costs $6 per million tokens. Exactly 1,000 billed input tokens plus 500 billed output tokens, including billable reasoning, would cost $0.005 per request, or $0.015 for three. This is an illustration, **not a spend cap**. OpenAI comparison calls would incur their own cost. Pricing and any provider-added tokens must be reverified before dispatch.

Before live evaluation:

1. Resolve the existing production functional acceptance hold.
2. Establish provider-specific evidence bounding all billable input and output, including framing and reasoning, with current verified pricing. If a supported bounded model is selected, re-scope the key and review the request schema first.
3. Implement and test an explicitly internal xAI adapter through the existing job lease and durable reservation/settlement path. Preserve exact request identity, held uncertainty after ambiguous dispatch and no automatic retries or provider fallback.
4. Present a concrete maximum trial cost for billing approval before enabling the disabled key or either gate. Confirm the Chat endpoint ACL permits the selected Responses request without broadening access unnecessarily.
5. Run only the three synthetic cases; record scoped audit evidence, usage receipts and manual acceptance results before considering any broader use.

No schema migration, customer activation or production deployment is part of this proposal.

## Validation

Local validation on Node 22.23.3 passed all 1,023 server tests with zero failures or skips, including 13 new evaluation security and isolation tests. The server/browser syntax checks, existing SaaS safety guards for 15 products and whitespace checks passed. The tests verify that enabled flags cannot dispatch, no secret or business data appears in the evaluation response, only compact identity reads occur, stored identity changes revoke access, and customer/role/scope/body overrides fail closed. Existing OpenAI model selection and public health projection remain intact.

GitHub CI must verify this exact draft commit, including its existing responsive browser and production container gates. Passing these gates does not remove the separately documented production functional acceptance hold or authorise a paid Grok call.
