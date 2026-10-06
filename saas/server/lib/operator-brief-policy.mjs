import crypto from 'node:crypto';
import { PROVIDER_ROUTING_LIMITS } from './provider-router.mjs';

export const OPERATOR_BRIEF_ADAPTER = 'openai-responses';
export const OPERATOR_BRIEF_SHAPE = 'operator-brief:v1';
export const OPERATOR_BRIEF_ENDPOINT = 'https://api.openai.com/v1/responses';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const integer = (value, max = Number.MAX_SAFE_INTEGER, min = 0) => Number.isSafeInteger(value) && value >= min && value <= max;
const fail = reason => ({ allowed: false, reason });
export const briefDigest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const briefSafeCode = (value, fallback = 'AI_PROVIDER_FAILED') => typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value) ? value : fallback;

export function briefExecutionAllowed(value) {
  return plain(value) && ['agentOpsEnabled', 'agentOpsPaused', 'commanderEnabled']
    .every(key => value[key] === undefined || value[key] === null || typeof value[key] === 'boolean')
    && value.agentOpsEnabled !== false && value.agentOpsPaused !== true && value.commanderEnabled !== false;
}

export function validBriefJob(job, workspaceId, jobId, now) {
  return plain(job) && job.workspaceId === workspaceId && job.jobId === jobId && ID.test(jobId || '')
    && job.type === 'agent_command' && job.status === 'running' && typeof job.workerId === 'string'
    && job.workerId.length >= 8 && ID.test(job.workerId) && integer(job.attempt, 2147483647, 1)
    && typeof job.createdAt === 'string' && Number.isFinite(Date.parse(job.createdAt)) && Date.parse(job.createdAt) <= now
    && typeof job.leaseUntil === 'string' && Number.isFinite(Date.parse(job.leaseUntil)) && Date.parse(job.leaseUntil) > now;
}

// This proof is platform-managed metadata, never inferred from a model name or
// accepted from a browser estimate. It explicitly covers every billable input
// token, including framing/hidden overhead, for this exact request shape. The
// entire verified ceiling is reserved even when a particular prompt is shorter.
export function operatorBriefPolicy({ state, workspaceId, model, outputTokens, endpoint, now }) {
  if (state?.workspace?.id !== workspaceId || typeof workspaceId !== 'string' || !ID.test(workspaceId)) return fail('AI_WORKSPACE_CONTEXT_INVALID');
  if (endpoint !== OPERATOR_BRIEF_ENDPOINT) return fail('AI_ENDPOINT_UNVERIFIED');
  const governance = state?.aiEconomics?.governance;
  if (!plain(governance) || governance.version !== 1 || governance.enabled !== true || governance.currency !== 'USD') return fail('AI_GOVERNANCE_NOT_CONFIGURED');
  const provider = governance.providers?.openai, adapter = provider?.adapters?.[OPERATOR_BRIEF_ADAPTER];
  if (!plain(provider) || provider.enabled !== true || adapter?.enabled !== true
    || !Array.isArray(provider.allowedAdapters) || !provider.allowedAdapters.includes(OPERATOR_BRIEF_ADAPTER)
    || !Array.isArray(provider.allowedModels) || !provider.allowedModels.includes(model)) return fail('AI_PROVIDER_NOT_ALLOWED');
  // This is a platform attestation of retirement of every legacy dispatcher,
  // never a timestamp synthesized from deployment, this job or local startup.
  if (!integer(adapter.atomicUsageCutoverAt) || adapter.atomicUsageCutoverAt > now
    || !integer(governance.accountingStartAt) || governance.accountingStartAt > now) return fail('AI_ACCOUNTING_CUTOVER_UNVERIFIED');
  const proof = adapter.models?.[model];
  if (!plain(proof) || proof.verified !== true || proof.allBillableInputTokensCovered !== true
    || proof.outputLimitCoversAllBillableOutput !== true
    || proof.requestShape !== OPERATOR_BRIEF_SHAPE || proof.endpoint !== endpoint
    || !integer(proof.maxBillableInputTokens, PROVIDER_ROUTING_LIMITS.inputTokensPerRequest, 1)
    || !integer(proof.maxBillableOutputTokens, PROVIDER_ROUTING_LIMITS.outputTokensPerRequest, 1)
    || !['reported', 'not_applicable'].includes(proof.cacheWriteMode)) return fail('AI_TOKEN_BOUND_UNVERIFIED');
  if (!integer(proof.checkedAt) || !integer(proof.expiresAt) || proof.checkedAt > now || now >= proof.expiresAt
    || proof.expiresAt <= proof.checkedAt || proof.expiresAt - proof.checkedAt > PROVIDER_ROUTING_LIMITS.configurationTtlMs) return fail('AI_TOKEN_BOUND_EXPIRED');
  if (!integer(outputTokens, 2000, 64) || outputTokens > proof.maxBillableOutputTokens) return fail('AI_OUTPUT_BOUND_INVALID');
  if (!Array.isArray(provider.pricing) || provider.pricing.length > 128) return fail('AI_PRICING_UNVERIFIED');
  const prices = provider.pricing.filter(row => row?.adapterId === OPERATOR_BRIEF_ADAPTER && row?.modelId === model);
  // A single active record is required. Never silently select an arbitrary
  // version or use the legacy display catalogue as live cost authority.
  const fresh = prices.filter(row => row?.verified === true && row?.allInUpperBound === true && row.currency === 'USD'
    && integer(row.checkedAt) && integer(row.expiresAt) && row.checkedAt <= now && now < row.expiresAt
    && row.expiresAt > row.checkedAt && row.expiresAt - row.checkedAt <= PROVIDER_ROUTING_LIMITS.pricingTtlMs);
  if (fresh.length !== 1) return fail('AI_PRICING_UNVERIFIED');
  const price = fresh[0];
  if (typeof price.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(price.version)
    || ['inputMicrosPerMillionTokens', 'cachedInputMicrosPerMillionTokens', 'cacheWriteMicrosPerMillionTokens', 'outputMicrosPerMillionTokens', 'requestMicros'].some(key => !integer(price[key]))) return fail('AI_PRICING_UNVERIFIED');
  const normalizedProof = Object.fromEntries(['verified', 'allBillableInputTokensCovered', 'outputLimitCoversAllBillableOutput', 'requestShape', 'endpoint',
    'maxBillableInputTokens', 'maxBillableOutputTokens', 'cacheWriteMode', 'checkedAt', 'expiresAt'].map(key => [key, proof[key]]));
  const normalizedPrice = Object.fromEntries(['version', 'adapterId', 'modelId', 'verified', 'allInUpperBound', 'currency',
    'checkedAt', 'expiresAt', 'inputMicrosPerMillionTokens', 'cachedInputMicrosPerMillionTokens',
    'cacheWriteMicrosPerMillionTokens', 'outputMicrosPerMillionTokens', 'requestMicros'].map(key => [key, price[key]]));
  const limitKeys = ['maxRequests', 'maxInputTokens', 'maxOutputTokens', 'maxTotalTokens', 'maxCostMicros'];
  const limits = value => Object.fromEntries(limitKeys.map(key => [key, value?.[key] ?? null]));
  return Object.freeze({ allowed: true, inputTokenBound: proof.maxBillableInputTokens, outputTokenBound: outputTokens,
    pricingVersion: price.version, cacheWriteMode: proof.cacheWriteMode,
    jobNotBefore: Math.max(adapter.atomicUsageCutoverAt, governance.accountingStartAt),
    validUntil: Math.min(proof.expiresAt, price.expiresAt),
    fingerprint: briefDigest({ model, proof: normalizedProof, price: normalizedPrice,
      tenantLimits: limits(governance.tenantLimits), providerLimits: limits(provider.limits),
      monthlyCostLimitUsd: state.aiEconomics.monthlyCostLimitUsd ?? null,
      configuredAt: governance.configuredAt, accountingStartAt: governance.accountingStartAt,
      atomicUsageCutoverAt: adapter.atomicUsageCutoverAt }) });
}

export function briefUsageReceipt(body, model, cacheWriteMode, jobId) {
  if (!plain(body) || body.object !== 'response' || body.model !== model || body.status !== 'completed'
    || (body.error !== undefined && body.error !== null) || (body.incomplete_details !== undefined && body.incomplete_details !== null)
    || (body.provider !== undefined && body.provider !== 'openai')
    || typeof body.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,179}$/.test(body.id)
    || !plain(body.usage) || !plain(body.usage.input_tokens_details)) return null;
  const usage = body.usage;
  let cacheWriteTokens = usage.input_tokens_details.cache_write_tokens;
  if (cacheWriteMode === 'not_applicable') {
    if (cacheWriteTokens !== undefined && cacheWriteTokens !== 0) return null;
    cacheWriteTokens = 0; // Supported only by the explicit verified adapter proof.
  }
  const receipt = { jobId, providerRequestId: body.id, inputTokens: usage.input_tokens,
    cachedInputTokens: usage.input_tokens_details.cached_tokens, cacheWriteTokens,
    outputTokens: usage.output_tokens, totalTokens: usage.total_tokens };
  if (['inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens'].some(key => !integer(receipt[key]))
    || !integer(receipt.inputTokens + receipt.outputTokens) || receipt.inputTokens + receipt.outputTokens !== receipt.totalTokens
    || !integer(receipt.cachedInputTokens + receipt.cacheWriteTokens) || receipt.cachedInputTokens + receipt.cacheWriteTokens > receipt.inputTokens) return null;
  return Object.freeze(receipt);
}
