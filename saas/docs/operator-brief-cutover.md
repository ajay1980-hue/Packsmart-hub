# Governed operator-brief cutover

## Scope and behavior change

The queued `agent_command` operator-brief enhancement now has one server-side dispatch boundary through the existing stage-5 atomic reservation and settlement RPCs. A configured OpenAI key and enabled flag no longer permit an unreserved request. Missing governance, clean accounting baseline, verified model bounds, pricing, current job lease or durable accounting blocks the paid enhancement. Existing credentials and provider settings are preserved. No policy or model is enabled by this change.

The deterministic Commander analysis is produced first and remains usable when enhancement is blocked, unavailable or uncertain. Its recorded source currencies are not converted. Immediate `/api/agents/command`, objective preparation, local specialist summaries and marketing planning remain deterministic. The provider receives only the bounded existing summary surface: command text, summary, projected priority text, risk codes/severity and numeric affected counts. Nested arbitrary payloads and customer records are excluded. Serialized request bodies are capped at 65,536 UTF-8 bytes; streamed provider responses are capped at 262,144 bytes. Accounting tables receive identifiers, fingerprints, bounds and usage evidence, never prompts, generated text, credentials or full datasets.

This is a single OpenAI Responses adapter cutover. The pure multi-provider router remains a proposal module. xAI, Anthropic/Claude and Gemini registry entries are not new executable adapters. Custom `OPENAI_API_BASE_URL` destinations are blocked pending a separately verified adapter; their connection settings are not rewritten. Firecrawl scans are outside this cutover and remain a separate unresolved paid-dispatch integration. No fake scan job or operator-brief key is created for them. Creative submission safeguards remain unchanged.

## Authority and conservative bounds

The database remains authoritative for the tenant/provider request, input/output/total-token and cost ceilings in `state.aiEconomics.governance`, provider/model/adapter allowlists, immutable pricing snapshots and the owner's optional lower monthly USD ceiling. The legacy display catalogue and character/token estimate are not cost authority on this path. Tenant-facing settings cannot supply or replace shared-key platform rates, model proof or plan ceilings.

The trusted platform policy must contain exact-model metadata at `governance.providers.openai.adapters['openai-responses'].models[model]`:

- `verified: true`
- `requestShape: 'operator-brief:v1'`
- `endpoint: 'https://api.openai.com/v1/responses'`
- `allBillableInputTokensCovered: true`: the verified input ceiling covers all billable input, including instructions, framing and hidden overhead for this exact request shape
- `outputLimitCoversAllBillableOutput: true`: the actual `max_output_tokens` limit bounds all billable output, including reasoning categories
- `maxBillableInputTokens` and `maxBillableOutputTokens`: verified positive safe-integer provider ceilings, not caller estimates; values above the existing 1,000,000-input/128,000-output accounting bounds are rejected rather than clamped
- `cacheWriteMode: 'reported'` or `'not_applicable'`: the latter requires a verified provider semantic that this category cannot be billed for this shape; absence is not evidence of zero
- `checkedAt` and `expiresAt`: verified epoch-millisecond evidence, valid for no more than the existing seven-day configuration evidence limit

No values are installed by this release. A model's advertised context window is not automatically a verified billable-input ceiling. The full verified input ceiling is reserved, even for a shorter request; the actual hard output cap is reserved separately and cannot exceed the verified maximum. This can conservatively require more budget than a typical request uses. The former 64–2,000 output-token range is retained as validation; unsupported/fractional configuration is blocked. The existing default hard output cap is a request-size limit, not permission to spend.

The adapter also requires platform-managed `atomicUsageCutoverAt`, an actual epoch-millisecond attestation that every legacy OpenAI dispatcher has been retired. It is not inferred from a code version, deployment time, process startup or the current job. Trusted claimed and freshly re-read job `created_at` must match and be at or after both this cutoff and `accountingStartAt`. This blocks old ambiguous jobs from acquiring their first governed entitlement merely because a retry resets their attempt count. A new cutoff is not permission to backdate the clean accounting baseline or ignore unaccounted usage. Missing or future cutover proof blocks dispatch.

Exactly one fresh verified all-in pricing record for the model and adapter is required. A verified pricing version contains every existing stage-5 rate/category field. No static display price, quota, subscription value or provider balance supplies missing authority. The owner may lower the monthly cost ceiling; only trusted platform configuration supplies finite shared-key allowances and proof. Price and model-evidence expiry never cause automatic provider health/pricing polls.

## Admission, identity and uncertainty

The worker passes its actual claimed tenant/job/type/status/worker/attempt/lease/creation time, separately from the user job payload. The immutable call key is `${jobId}:operator-brief:v1`; it is unchanged across retries, restarts, model attempts and month changes. It permits at most one logical provider dispatch. Existing reservations never permit another POST, including cancelled, settled or uncertain reservations. A changed fingerprint is a conflict, not a reason to mint a new key.

The request fingerprint binds the exact serialized body, adapter/model/endpoint, account digest, verified proof/pricing/limit snapshot and token bounds. Only a complete validated reservation acknowledgment allows progress. A lost or malformed acknowledgment is uncertain and cannot dispatch.

After admission, two bounded database reads revalidate current policy and the job's current worker/attempt/lease. The same policy projection includes the existing Agent Ops enabled/paused and Commander enabled flags, so an owner stop during admission blocks the POST. Missing legacy flags keep their established defaults; malformed values fail closed. These projections download no full workspace, job payload/result, user records or usage history. Policy data is capped at 128 KiB and job data at 4 KiB. Changed/revoked proof, settings, identity, credentials or request input blocks dispatch. The final deadline is the earliest original lease, proof and price expiry and is checked again after asynchronous reads and binding work immediately before HTTP.

The new model metadata is a time-bounded trusted platform snapshot, rechecked before sending. The existing SQL atomically checks its existing policy fields but does not validate this new metadata. Strict instantaneous revocation across the database/provider boundary would require a future RPC contract change; this release does not claim that guarantee. Once a reservation has been acknowledged, any pre-send uncertainty leaves its hold intact for explicit reconciliation. This stage does not automatically refund or reopen claims.

POST redirects are rejected. Provider identity is established by the exact authenticated HTTPS endpoint and nonredirected response URL. The returned Responses object, model and request ID must match the supported adapter, with terminal `completed` status and no contradictory error/incomplete marker. Nonterminal or unrecognized statuses cannot release holds using provisional counters. Provider/model aliases are not guessed. Input, cached-input, cache-write, output and total token counts require explicit safe-integer evidence, with exact total and cache consistency. Missing cache-write data can become zero only under the separately verified `not_applicable` semantic. Missing, malformed, mismatched or oversized evidence keeps the full hold. A timeout, HTTP error or lost response is not proof of no charge.

Valid usage settles through the existing RPC, which also writes the legacy usage record atomically. The old post-hoc `recordAiUsage` call is removed from dispatch. Exact overrun cost strings remain strings and do not pass through JavaScript arithmetic. A lost settlement acknowledgment remains unknown and never triggers another POST. Valid accounting can be retained even when no usable generated text exists; the deterministic summary stays available.

Queue results and audit evidence distinguish this invocation's submission count from job-level accounting. A blocked invocation can truthfully record zero new submissions while its historical cost remains unknown. Local policy denials, an absent provider and missing effect evidence never erase possible same-job legacy exposure by reporting zero cost. Known zero would require explicit immutable cancellation evidence; this adapter does not manufacture it. Valid settlement supplies accounted usage, and lost settlement acknowledgments stay uncertain even if the database may already have committed. Business `externalWrites: false` continues to describe the absence of commercial execution; provider request and cost evidence is reported separately under `ai.effects`.

## Activation and rollback dependencies

The stage-5 policy requires a clean UTC month boundary, initial `configuredAt <= accountingStartAt`, no unaccounted legacy measured usage in the admission month, and reconciliation of historical uncertainty. A new attestation on 6 October 2026 cannot be backdated to 1 October. The next possible new clean boundary is 1 November UTC, after all legacy dispatchers have been drained and exposure reconciled. This release does not schedule or authorize that activation. Mid-month verified-opening-balance support remains unimplemented.

Before any paid activation: verify the exact model/API billing semantics and platform prices, obtain the applicable finite owner/platform allowance, configure evidence through a trusted platform path, drain every old ungoverned replica, establish the real accounting baseline and pass isolated concurrency/transport tests. No production credentials, policy, provider connection, price, grant, schema or service is changed here.

Rollback must never restore the old unreserved paid fallback. Preserve reservations, usage history, unknown exposure and the deterministic local path; block paid dispatch first if reverting this code. A retry of a local analysis is not permission to issue a new chargeable logical call.

## Verification

Use mock-only provider tests and local HTTP redirect fixtures; do not call live paid providers. Cover current worker/attempt/lease and policy changes, lost/duplicate admission, post-read expiry, exact payload binding, wrong model/origin, malformed/missing usage, oversized streams, unknown settlement, cost-string overruns, retry/restart and preserved deterministic summaries. Existing PostgreSQL accounting tests continue to prove atomic reservation and settlement under real concurrent database connections; this change adds no migration. Run the full server suite, syntax and repository guards on the final integrated commit, followed by ordinary browser/container/Android CI gates.
