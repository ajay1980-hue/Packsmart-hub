# Operator-brief routing seam: INACTIVE PREPARATION

## Status and boundary

`server/lib/operator-brief-routing.mjs` prepares one pure translation seam between the existing operator-brief policy and `routeProviderWork`. No production caller imports it. `enhanceCommander`, existing provider execution, deterministic Commander, settings, accounting RPCs, schema, permissions and deployments are unchanged. No provider was queried or verified; unit fixtures are wholly synthetic. This is not the original Runvara OS runtime router cutover or permission to activate one.

The entrypoint, `routeOperatorBrief(input)`, evaluates the already selected OpenAI model. It cannot choose another provider, model, endpoint or adapter. Catalog membership is checked against the existing `AI_MODEL_CATALOG`; catalog display prices never supply authoritative pricing. The only route is `openai` / `openai-responses` / `https://api.openai.com/v1/responses`, request shape `operator-brief:v1`.

The task is exactly one request, without tools, requiring both `intelligence.text` and `intelligence.reasoning`. The existing request body explicitly requests reasoning. Fixed capability envelopes describe this one existing task; they are not a new subscription entitlement or proof that a model supports it.

Every result is `plannedOnly: true`, `executionAuthorized: false`, and `writesAuthorized: false`. `approvalRequired: true` is a planning marker, not an approval workflow implementation. Selection supplies eligibility evidence only. No reservation, provider request, environment read, credential resolution, health/pricing poll, state mutation, persistence or permission change occurs.

## Trusted input contract

Inputs must be explicitly constructed by a trusted server caller from authoritative, tenant-scoped sources. Do not pass a browser DTO, whole workspace, job payload, arbitrary provider response, prompt, generated text, secret, usage history or injected function. The function validates structure and consistency; it does not authenticate the source of `verified: true`. Merely constructing this DTO cannot make its assertions true.

The strict top-level fields are:

- `now`: explicit epoch milliseconds. There is no wall-clock fallback.
- `workspaceId`: the current trusted workspace identifier.
- `selectedRoute`: exactly `{ provider, model }`, copied from the already selected trusted job route. No candidate pool is accepted.
- `endpoint`: the actual configured request endpoint, which must equal the existing endpoint above.
- `credentialDigest`: the existing server-derived SHA-256 digest of the actual credential, encoded as 64 lowercase hexadecimal characters. Never supply the credential itself.
- `accountId`: the expected provider billing-account identity from a trusted account-verification source. It is private server data. A credential digest detects credential changes; it does not independently prove billing-account ownership.
- `outputTokens`: the actual hard `max_output_tokens` setting, a safe integer from 64 through 2,000, also bounded by the verified model proof.
- `policySnapshot`: the narrow existing-policy projection below.
- `evidence`: the independently verified account, configuration, credential, health and metrics evidence below.

Workspace/account/adapter identifiers accept bounded alphanumeric identifiers with `.`, `_`, `:`, and `-`, up to 96 characters. This follows the router's narrower workspace-ID contract; a longer ID accepted elsewhere is blocked, never truncated. Model identifiers are bounded to 128 characters, then restricted to the existing catalog. Unknown fields, accessors, symbols, sparse/extended arrays, unexpected prototypes, oversized lists, nonnumeric strings, negative/fractional integer counters, unsafe numbers and malformed values fail closed. Ordinary and null-prototype data objects are supported. Caller objects are not mutated or frozen, and outputs retain no caller-owned mutable references.

### Existing policy projection

`policySnapshot` contains only:

- `version`, `enabled`, `currency`, `configuredAt`, `accountingStartAt`, and `tenantLimits`, copied from the current governance object. Version must be `1`; currency must be `USD`.
- `monthlyCostLimitUsd`, copied from the owner's optional lower ceiling. Missing or `null` means no additional owner cap; explicit zero remains zero. Empty strings and numeric strings are rejected.
- `provider`: the current OpenAI `enabled`, `allowedAdapters`, `allowedModels`, `limits`, and complete `pricing` array.
- `adapter`: current `enabled` and `atomicUsageCutoverAt` for `openai-responses`.
- `modelProof`: the exact existing model proof from `governance.providers.openai.adapters['openai-responses'].models[selectedRoute.model]`. The future extractor must use this exact key, not a default, alias, neighboring model or inferred model-name property.

Allowlists are unique bounded arrays, at most 128 entries. Pricing remains the full bounded OpenAI array, at most 128 records; do not preselect a price and hide a duplicate fresh record. The selected version must occur exactly once for the selected adapter/model across all rows, even if a duplicate is stale; this matches SQL’s exact-version uniqueness check. Ordering of allowlists, capability lists and pricing rows is normalized before binding.

Future `configuredAt` values block conservatively. The seam reconstructs only this narrow state projection and calls the existing `operatorBriefPolicy`. It retains that policy's current enablement, provider/model/adapter allowlists, existing cutover checks, exact shape/endpoint, complete token-proof semantics, proof freshness and unique fresh all-in pricing requirements. It does not change that policy or manufacture its missing fields.

`modelProof` includes exactly `verified`, `allBillableInputTokensCovered`, `outputLimitCoversAllBillableOutput`, `requestShape`, `endpoint`, `maxBillableInputTokens`, `maxBillableOutputTokens`, `cacheWriteMode`, `checkedAt`, and `expiresAt`. The entire verified billable-input ceiling is reserved by the router projection, including framing/hidden overhead, even for a shorter prompt. Output uses the actual hard cap, including billable reasoning categories as attested by the existing proof. No characters-per-token estimate or advertised context window substitutes for that proof. Model/input/output/context proofs exceeding router maxima are rejected, not clamped.

Each pricing row retains its `version`, `adapterId`, `modelId`, `verified`, `checkedAt`, `expiresAt`, `allInUpperBound`, `currency`, and all five original rates: `inputMicrosPerMillionTokens`, `cachedInputMicrosPerMillionTokens`, `cacheWriteMicrosPerMillionTokens`, `outputMicrosPerMillionTokens`, `requestMicros`. Unknown or missing category prices are never treated as zero. Rates must fit the router's nonnegative safe-integer maximum of 1e12 micros; larger rates block rather than being lowered.

### Account-bound routing evidence

`evidence` has five entries: `account`, `configuration`, `credentials`, `health`, and `metrics`. Every supplied entry contains:

- `binding`: exactly `workspaceId`, `provider`, `adapterId`, `modelId`, `requestShape`, `endpoint`, `credentialDigest`, `accountId`.
- `verified`: a boolean.
- `checkedAt`, `expiresAt`: safe-integer epoch milliseconds.

Every binding field must match the expected top-level subject, including the actual credential digest and expected account. A fresh health or quality sample from another workspace, billing account, credential, model, shape or endpoint cannot confer eligibility. Each verified assertion must have been established for this complete subject by the trusted producer; re-labeling a generic status observation is not verification.

Additional entry-specific fields are:

- `account`: `policyDigest`, the exact policy attestation described below. Its `verified: true` explicitly attests the identified billing account is the correct account for this credential and exact route. It is separate from credential presence and requires real account verification, not a digest assumption.
- `configuration`: `policyDigest`, plus `capabilities` (a unique list of supported intelligence capabilities) and `contextWindowTokens` (verified for the exact route). Both required capabilities must be present; verified context must cover the full input ceiling plus hard output cap.
- `credentials`: `state`, with eligibility requiring `configured`. `missing`, `revoked` and `unknown` block.
- `health`: `status`, with eligibility requiring `healthy`. `degraded`, `unavailable` and `unknown` block.
- `metrics`: safe-integer `qualityScore` from 0–100, `reliabilityBps` from 0–10,000, and `latencyMs` from 0–600,000. All are required; they cannot come from catalog names or invented defaults.

The account and configuration issuers must also attest applicability of the exact normalized selected pricing and token-proof snapshot through `policyDigest`. Both must equal `operatorBriefRoutingPolicyDigest({ modelProof, pricing })`, where `pricing` is the single selected exact-version row. Changing any proof or pricing field while retaining either old attestation blocks with `AI_ROUTING_POLICY_ATTESTATION_MISMATCH`. A fingerprint computed after combining unrelated observations does not establish that those prices and billable bounds apply to this account.

`operatorBriefRoutingPolicyDigest` is the second, small pure export. It strictly validates and normalizes the two data objects and returns SHA-256, or `null` on malformed input. It hashes JSON for `{ version: 'operator-brief-routing-policy.v1', modelProof: normalizedProof, pricing: normalizedPrice }`. Fields are serialized in the helper's fixed order; input property order does not matter. To reproduce the digest, use this versioned helper rather than hashing raw JSON or copying object insertion order. Proof order is `verified`, `checkedAt`, `expiresAt`, `allBillableInputTokensCovered`, `outputLimitCoversAllBillableOutput`, `requestShape`, `endpoint`, `maxBillableInputTokens`, `maxBillableOutputTokens`, `cacheWriteMode`. Price order is `version`, `adapterId`, `modelId`, `verified`, `checkedAt`, `expiresAt`, `allInUpperBound`, `currency`, followed by the five rates in their order listed above. The helper contains no clock, account verification or authority check. Computing a hash is not verification; only an authenticated trusted issuer may assert that it is verified for the bound account and route. Tests explicitly synthesize refreshed attestations after intentional policy changes; runtime must not generate a new verified attestation merely to make a digest match.

Missing evidence blocks. False verification, future checks, expired proofs, backwards intervals and stale evidence block. The seam does not provide adjustable thresholds or TTLs. It uses the actual router's default policy: quality at least 60, reliability at least 9,500 basis points, latency at most 60,000 milliseconds; health TTL 60,000 milliseconds; credentials and account TTL 900,000; configuration/pricing TTL 86,400,000; metrics TTL 3,600,000. TTL means `now < checkedAt + ttl`, with independent `now < expiresAt`; eligibility ends precisely at equality. Account TTL follows the router's credential TTL. The existing model-proof expiry remains an additional independent deadline.

## Conservative cost and limit projection

SQL reserves the largest of the uncached-input, cached-input and cache-write prices. The router has one input-rate slot, so the seam projects exactly that maximum into it. The router rounds each request's input and output charge up separately and adds the request charge. The full original pricing snapshot, including smaller category rates and version, remains in the opaque binding; changing a nonmaximum category price still changes the fingerprint.

Every tenant and provider limit is compulsory: `maxRequests`, `maxInputTokens`, `maxOutputTokens`, `maxTotalTokens`, `maxCostMicros`. Validate all original values as nonnegative safe integers before any projection. SQL permits larger monthly limits than the router DTO. Only the request envelopes are conservatively capped: 100 requests, 2,000,000 aggregate tokens per token dimension, and 1e12 cost micros. Zero is preserved. The original unclamped limits remain bound, so a change beyond a router cap still changes the fingerprint.

The owner USD ceiling is translated by flooring the exact canonical decimal-number representation at micro precision, using integer arithmetic rather than binary floating multiplication. This preserves a value such as `0.000249` as 249 micros and floors sub-micro values to zero. Finite values from 0 through 1,000,000 USD are allowed. Scientific notation is handled explicitly. The owner's lower ceiling applies to the tenant envelope; the provider envelope remains separately checked.

The router's `PLAN_*` reason codes correspond to the tenant envelope, and `BUDGET_*` codes correspond to the provider envelope. These are per-request admissibility checks against configured monthly ceilings, not claims about remaining balance. The seam neither reads usage nor assumes missing usage means zero. The unchanged SQL RPC remains authoritative for held plus settled exposure, concurrent admission, actual accounting-baseline validity, duplicate logical calls, pricing-version conflicts, provider overrun blocks, job ownership and leases. A selected seam result can still be denied atomically.

## Output and privacy

Results are deeply frozen and bounded. They include `status`, safe `reason`/`reasonCodes`, `evaluatedAt`, `validUntil`, `bindingFingerprint`, fixed authority flags, a minimal `selected` route when eligible, and `routingDecision` when the router completed its evaluation. The latter is an allowlisted projection of the actual router result: version, status/reasons, requirements, estimated request budget and false authority flags. It is not a second independent ranking or eligibility implementation.

Pre-routing, malformed-input or failed-account checks return `routingDecision: null`. Blocked results never carry a selected route, fingerprint or deadline. Unknown exceptions are replaced by one static input-invalid reason; arbitrary messages, stacks and caller values are not retained.

For selection, `validUntil` is the earliest router evidence deadline, account deadline, and existing model-proof/pricing-policy deadline. It does not include a job lease because this pure seam does not accept a job. Future runtime wiring must also bind the original job lease and recheck all deadlines immediately before POST.

`bindingFingerprint` is SHA-256 over the normalized expected subject, full policy snapshot, existing policy fingerprint, complete normalized evidence, fixed task requirements and effective router policy. `now`/`evaluatedAt` are excluded; advancing the evaluation clock does not change the fingerprint while evidence remains identical. Evidence refreshes, account/credential changes, exact model, proof, pricing, authoritative limits or output-cap changes do change it.

The fingerprint is an opaque server-only binding, not a signature, credential, account-verification result or dispatch token. Raw workspace/account identifiers, credential digests, bindings, private evidence, secret values, prompts, generated text and unrelated workspace data are absent from diagnostics. Do not expose or log the input, full evidence or binding fingerprint in public settings or browser responses. The budget is an unreserved estimate; `reserved: false` is always preserved.

## Required before future wiring or paid activation

1. Obtain actual, fresh, exact-route account/credential, capability/context, health and quality/reliability/latency evidence from an authenticated trusted platform path. Define and review how each metric and attestation is established. This slice does not implement or authorize evidence collection, configuration or recurring polling.
2. Explicitly decide whether to activate the stricter routing eligibility. Current paid policy does not require these additional proofs. Missing evidence must block any future gated path; a paid fallback would bypass it. Compatibility with every previously allowed enhancement cannot be claimed.
3. Before persisting private routing/account metadata under governance, replace the full `aiEconomics` returns in `agent-ops.mjs` `workspaceSnapshot` and `configureWorkspace` with allowlisted public settings DTOs. This privacy work is not implemented here. Never persist synthetic fixture evidence as production configuration.
4. Review and implement the runtime boundary separately: evaluate immediately after existing policy; require the exact selected route; add the stable routing fingerprint to the existing request fingerprint; bind the earliest routing/proof/pricing/job-lease deadline; preserve `${jobId}:operator-brief:v1` and existing RPC inputs; compare acknowledged bounds and exact cost; rebuild evidence after the bounded final context read; compare immutable bindings; recheck the original deadline immediately before POST.
5. Keep deterministic results and durable held/unknown exposure on every uncertain or denied step. Never reroute, mint another call key, reopen a reservation, or restore an ungoverned paid fallback. No new adapter, endpoint, model or permission is implied.
6. Retain the accounting activation requirements in [operator-brief-cutover.md](operator-brief-cutover.md): verified billing/token semantics and finite allowance, retirement of old dispatchers, real clean baseline and reconciliation, plus isolated concurrency/transport tests. This slice supplies none of that operational evidence or permission.
7. Test missing/stale/cross-tenant/wrong-account evidence with zero new POSTs; evidence or credentials changing during admission; reads crossing TTL, lease or month boundaries; SQL denial after selection; lost acknowledgments; immutable-key retries; cost projection; deterministic compatibility; and private-data exclusion. The existing SQL does not atomically validate new routing metadata. Future bounded revalidation must not be described as instantaneous revocation.

## Verification for this preparation

`server/tests/operator-brief-routing.test.mjs` exercises the actual router through this seam using synthetic data only. It covers exact identity, missing/stale/bound evidence, all deadlines, existing policy and catalog constraints, required reasoning/context, pricing-category maximum, per-component rounding, large/zero/malformed limits, exact owner-cap conversion, stable binding, stale duplicate price rows, policy-attestation mixing, hostile thrown/revoked proxies, privacy, immutability and absence of runtime wiring/network calls.

Run from the repository root with Node 22:

```sh
node --test saas/server/tests/operator-brief-routing.test.mjs
node --test saas/server/tests/provider-router.test.mjs
npm --prefix saas/server run check
npm --prefix saas/server test
```

Focused tests establish the inactive translation contract, not live provider support, production evidence, SQL authorization, successful cutover or deployment. Repository aggregate checks and CI remain separate gates for the exact integrated tree.
