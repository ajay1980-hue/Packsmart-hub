/**
 * Pure, fail-closed provider routing. This module never executes an adapter,
 * resolves credentials, reads the environment, reserves a ledger, or authorizes
 * writes. The caller must supply a trusted, tenant-scoped server snapshot, not
 * accept client-supplied verification flags as proof. Recheck/reserve atomically
 * before execution: a routing decision alone cannot prevent concurrent spend.
 * Input token counts must include the complete serialized request/tool overhead;
 * outputTokens is a hard upper-bound reservation, not an average prediction.
 *
 * All timestamps are caller-supplied epoch milliseconds. All prices/limits are
 * integer millionths of the stated currency, with no FX conversion. Pricing is
 * an all-in upper bound for one request plus uncached input/output token rates;
 * adapters with duration, image, tool, or other charges must include those in
 * their verified per-request bound. No built-in live model IDs or prices exist.
 */

const freeze = value => {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};

export const PROVIDER_ROUTING_LIMITS = freeze({
  candidates: 128,
  listItems: 64,
  inputTokensPerRequest: 1_000_000,
  outputTokensPerRequest: 128_000,
  contextWindowTokens: 2_000_000,
  totalReservedTokens: 2_000_000,
  requests: 100,
  costMicros: 1_000_000_000_000,
  latencyMs: 600_000,
  healthTtlMs: 900_000,
  credentialsTtlMs: 86_400_000,
  configurationTtlMs: 604_800_000,
  pricingTtlMs: 2_592_000_000,
  metricsTtlMs: 86_400_000
});

// These are routing envelopes, not claims that an account is connected or that
// every provider/model implements every listed capability. Fresh per-adapter
// evidence and exact capability/tool matching are still required.
export const ADAPTER_CAPABILITY_REGISTRY = freeze({
  intelligence: ['intelligence.text', 'intelligence.reasoning', 'intelligence.vision', 'intelligence.structured_output'],
  research: ['research.search', 'research.fetch', 'research.crawl', 'research.extract'],
  image: ['creative.image'],
  media: ['creative.image', 'creative.video', 'creative.audio'],
  design: ['creative.design', 'creative.presentation', 'creative.image']
});

export const PROVIDER_CAPABILITY_REGISTRY = freeze({
  openai: { adapterKinds: ['intelligence', 'research', 'image'], families: ['intelligence', 'research', 'creative'] },
  xai: { adapterKinds: ['intelligence', 'research', 'image'], families: ['intelligence', 'research', 'creative'] },
  anthropic: { adapterKinds: ['intelligence', 'research'], families: ['intelligence', 'research'] },
  gemini: { adapterKinds: ['intelligence', 'research', 'image', 'media'], families: ['intelligence', 'research', 'creative'] },
  firecrawl: { adapterKinds: ['research'], families: ['research'] },
  runway: { adapterKinds: ['media'], families: ['creative'] },
  canva: { adapterKinds: ['design'], families: ['creative'] },
  custom: { adapterKinds: ['intelligence', 'research', 'image', 'media', 'design'], families: ['intelligence', 'research', 'creative'], idPrefix: 'custom:' }
});

const KNOWN_CAPABILITIES = new Set(Object.values(ADAPTER_CAPABILITY_REGISTRY).flat());
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/;
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}(?::[a-z0-9][a-z0-9-]{0,47})?$/;
const TOOL_ID = /^[a-z][a-z0-9_.:-]{0,95}$/;
const TIME_MAX = 8_640_000_000_000_000;
const EVIDENCE_KEYS = ['verified', 'checkedAt', 'expiresAt'];
const LIMIT_KEYS = ['currency', 'maxInputTokens', 'maxOutputTokens', 'maxTotalTokens', 'maxRequests', 'maxCostMicros'];
const DEFAULT_POLICY = freeze({
  weights: { cost: 25, latency: 10, reliability: 35, quality: 30 },
  minQualityScore: 60,
  minReliabilityBps: 9500,
  maxLatencyMs: 60_000,
  healthTtlMs: 60_000,
  credentialsTtlMs: 900_000,
  configurationTtlMs: 86_400_000,
  pricingTtlMs: 86_400_000,
  metricsTtlMs: 3_600_000
});
const TIE_BREAK = freeze(['weightedPenalty:ascending', 'costMicros:ascending', 'reliabilityBps:descending', 'qualityScore:descending', 'latencyMs:ascending', 'provider:ascending', 'adapterId:ascending']);

export class ProviderRoutingInputError extends TypeError {
  constructor(field) {
    super(`Invalid provider routing input at ${field}`);
    this.name = 'ProviderRoutingInputError';
    this.code = 'PROVIDER_ROUTING_INPUT_INVALID';
    this.status = 400;
    this.field = field;
  }
}
const fail = field => { throw new ProviderRoutingInputError(field); };

function record(value, allowed, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(field);
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.length) fail(field);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor || !('value' in descriptor)) fail(field);
  }
  return value;
}
function integer(value, max, field, min = 0) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(field);
  return value;
}
function identifier(value, pattern, field) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(field);
  return value;
}
function list(value, validate, field, min = 0, max = PROVIDER_ROUTING_LIMITS.listItems) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(field);
  // Reject holes, accessors, or attached payloads instead of invoking getters.
  if (Reflect.ownKeys(value).length !== value.length + 1) fail(field);
  const result = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !('value' in descriptor)) fail(field);
    result.push(validate(descriptor.value, field));
  }
  if (new Set(result).size !== result.length) fail(field);
  return result;
}
const capability = (value, field) => {
  if (!KNOWN_CAPABILITIES.has(value)) fail(field);
  return value;
};
const providerId = (value, field) => identifier(value, PROVIDER_ID, field);
const id = (value, field) => identifier(value, ID, field);
const toolId = (value, field) => identifier(value, TOOL_ID, field);
const currency = (value, field) => identifier(value, /^[A-Z]{3}$/, field);

function evidence(value, extra, field) {
  if (value === undefined || value === null) return null;
  record(value, [...EVIDENCE_KEYS, ...extra], field);
  if (value.verified !== undefined && typeof value.verified !== 'boolean') fail(field);
  for (const key of ['checkedAt', 'expiresAt']) {
    if (value[key] !== undefined) integer(value[key], TIME_MAX, field);
  }
  return { ...value };
}
function fresh(value, now, ttl) {
  return Boolean(value && value.verified === true && Number.isSafeInteger(value.checkedAt) && Number.isSafeInteger(value.expiresAt)
    && value.checkedAt <= now && now < value.expiresAt && value.expiresAt > value.checkedAt && now - value.checkedAt < ttl);
}
function limits(value, field, withTenant = false) {
  record(value, [...LIMIT_KEYS, ...(withTenant ? ['tenantId'] : [])], field);
  const result = {
    currency: currency(value.currency, `${field}.currency`),
    maxInputTokens: integer(value.maxInputTokens, PROVIDER_ROUTING_LIMITS.totalReservedTokens, `${field}.maxInputTokens`),
    maxOutputTokens: integer(value.maxOutputTokens, PROVIDER_ROUTING_LIMITS.totalReservedTokens, `${field}.maxOutputTokens`),
    maxTotalTokens: integer(value.maxTotalTokens, PROVIDER_ROUTING_LIMITS.totalReservedTokens, `${field}.maxTotalTokens`),
    maxRequests: integer(value.maxRequests, PROVIDER_ROUTING_LIMITS.requests, `${field}.maxRequests`),
    maxCostMicros: integer(value.maxCostMicros, PROVIDER_ROUTING_LIMITS.costMicros, `${field}.maxCostMicros`)
  };
  if (withTenant) result.tenantId = id(value.tenantId, `${field}.tenantId`);
  return result;
}
function readPolicy(value = {}) {
  record(value, Object.keys(DEFAULT_POLICY), 'policy');
  const policy = { ...DEFAULT_POLICY, ...value, weights: { ...DEFAULT_POLICY.weights } };
  if (value.weights !== undefined) {
    record(value.weights, ['cost', 'latency', 'reliability', 'quality'], 'policy.weights');
    for (const key of Object.keys(policy.weights)) policy.weights[key] = integer(value.weights[key], 100, 'policy.weights');
    if (Object.values(policy.weights).reduce((sum, n) => sum + n, 0) !== 100) fail('policy.weights');
  }
  integer(policy.minQualityScore, 100, 'policy.minQualityScore');
  integer(policy.minReliabilityBps, 10000, 'policy.minReliabilityBps');
  integer(policy.maxLatencyMs, PROVIDER_ROUTING_LIMITS.latencyMs, 'policy.maxLatencyMs');
  for (const key of ['healthTtlMs', 'credentialsTtlMs', 'configurationTtlMs', 'pricingTtlMs', 'metricsTtlMs']) integer(policy[key], PROVIDER_ROUTING_LIMITS[key], `policy.${key}`, 1);
  return policy;
}
function readCandidate(value) {
  const field = 'candidates';
  record(value, ['tenantId', 'adapterId', 'provider', 'modelId', 'kind', 'enabled', 'capabilities', 'tools', 'contextWindowTokens', 'maxOutputTokens', 'verification', 'credentials', 'health', 'pricing', 'metrics'], field);
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') fail(field);
  const result = {
    tenantId: id(value.tenantId, field), adapterId: id(value.adapterId, field), provider: providerId(value.provider, field),
    modelId: value.modelId === undefined || value.modelId === null ? null : identifier(value.modelId, MODEL_ID, field),
    kind: value.kind, enabled: value.enabled === true,
    capabilities: list(value.capabilities, capability, field, 1).sort(),
    tools: list(value.tools, toolId, field).sort(),
    contextWindowTokens: integer(value.contextWindowTokens, PROVIDER_ROUTING_LIMITS.contextWindowTokens, field),
    maxOutputTokens: integer(value.maxOutputTokens, PROVIDER_ROUTING_LIMITS.outputTokensPerRequest, field),
    verification: evidence(value.verification, [], field),
    credentials: evidence(value.credentials, ['state'], field),
    health: evidence(value.health, ['status'], field),
    pricing: evidence(value.pricing, ['currency', 'inputMicrosPerMillionTokens', 'outputMicrosPerMillionTokens', 'requestMicros', 'allInUpperBound'], field),
    metrics: evidence(value.metrics, ['qualityScore', 'reliabilityBps', 'latencyMs'], field)
  };
  if (typeof result.kind !== 'string' || !Object.hasOwn(ADAPTER_CAPABILITY_REGISTRY, result.kind)) fail(field);
  if (result.credentials?.state !== undefined && !['configured', 'missing', 'revoked', 'unknown'].includes(result.credentials.state)) fail(field);
  if (result.health?.status !== undefined && !['healthy', 'degraded', 'unavailable', 'unknown'].includes(result.health.status)) fail(field);
  if (result.pricing) {
    if (result.pricing.currency !== undefined) currency(result.pricing.currency, field);
    for (const key of ['inputMicrosPerMillionTokens', 'outputMicrosPerMillionTokens', 'requestMicros']) {
      if (result.pricing[key] !== undefined) integer(result.pricing[key], PROVIDER_ROUTING_LIMITS.costMicros, field);
    }
    if (result.pricing.allInUpperBound !== undefined && typeof result.pricing.allInUpperBound !== 'boolean') fail(field);
  }
  if (result.metrics) {
    for (const [key, max] of [['qualityScore', 100], ['reliabilityBps', 10000], ['latencyMs', PROVIDER_ROUTING_LIMITS.latencyMs]]) {
      if (result.metrics[key] !== undefined) integer(result.metrics[key], max, field);
    }
  }
  return result;
}
function readInput(input) {
  record(input, ['now', 'tenant', 'task', 'budget', 'policy', 'candidates'], 'input');
  const now = integer(input.now, TIME_MAX, 'now');
  record(input.tenant, ['id', 'allowedProviders', 'allowedAdapters', 'plan'], 'tenant');
  record(input.tenant.plan, ['capabilities', 'limits'], 'tenant.plan');
  const tenant = {
    id: id(input.tenant.id, 'tenant.id'),
    allowedProviders: list(input.tenant.allowedProviders, providerId, 'tenant.allowedProviders').sort(),
    allowedAdapters: input.tenant.allowedAdapters === undefined ? null : list(input.tenant.allowedAdapters, id, 'tenant.allowedAdapters').sort(),
    plan: { capabilities: list(input.tenant.plan.capabilities, capability, 'tenant.plan.capabilities').sort(), limits: limits(input.tenant.plan.limits, 'tenant.plan.limits') }
  };
  record(input.task, ['capabilities', 'tools', 'inputTokens', 'outputTokens', 'requests', 'minContextWindowTokens'], 'task');
  const task = {
    capabilities: list(input.task.capabilities, capability, 'task.capabilities', 1).sort(),
    tools: list(input.task.tools, toolId, 'task.tools').sort(),
    inputTokens: integer(input.task.inputTokens, PROVIDER_ROUTING_LIMITS.inputTokensPerRequest, 'task.inputTokens'),
    outputTokens: integer(input.task.outputTokens, PROVIDER_ROUTING_LIMITS.outputTokensPerRequest, 'task.outputTokens'),
    requests: integer(input.task.requests, PROVIDER_ROUTING_LIMITS.requests, 'task.requests', 1),
    minContextWindowTokens: input.task.minContextWindowTokens === undefined ? 0 : integer(input.task.minContextWindowTokens, PROVIDER_ROUTING_LIMITS.contextWindowTokens, 'task.minContextWindowTokens')
  };
  const budget = limits(input.budget, 'budget', true);
  if (budget.tenantId !== tenant.id) fail('budget.tenantId');
  if (budget.currency !== tenant.plan.limits.currency) fail('budget.currency');
  const candidates = list(input.candidates, readCandidate, 'candidates', 0, PROVIDER_ROUTING_LIMITS.candidates);
  if (new Set(candidates.map(c => `${c.tenantId}\0${c.adapterId}`)).size !== candidates.length) fail('candidates');
  return { now, tenant, task, budget, policy: readPolicy(input.policy), candidates };
}
const ceilDivide = (n, d) => (n + d - 1n) / d;
function estimate(pricing, task) {
  // Round each token component UP per request, never the whole batch down.
  const input = ceilDivide(BigInt(task.inputTokens) * BigInt(pricing.inputMicrosPerMillionTokens), 1_000_000n);
  const output = ceilDivide(BigInt(task.outputTokens) * BigInt(pricing.outputMicrosPerMillionTokens), 1_000_000n);
  const perRequest = input + output + BigInt(pricing.requestMicros);
  return { costMicros: Number(perRequest * BigInt(task.requests)), perRequestCostMicros: Number(perRequest) };
}
function validUntil(candidate, policy) {
  return Math.min(...[
    [candidate.verification, policy.configurationTtlMs], [candidate.credentials, policy.credentialsTtlMs],
    [candidate.health, policy.healthTtlMs], [candidate.pricing, policy.pricingTtlMs], [candidate.metrics, policy.metricsTtlMs]
  ].map(([item, ttl]) => Math.min(item.expiresAt, item.checkedAt + ttl)));
}
const lex = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function compare(a, b) {
  return a.weightedPenalty - b.weightedPenalty || a.estimate.costMicros - b.estimate.costMicros
    || b.candidate.metrics.reliabilityBps - a.candidate.metrics.reliabilityBps || b.candidate.metrics.qualityScore - a.candidate.metrics.qualityScore
    || a.candidate.metrics.latencyMs - b.candidate.metrics.latencyMs || lex(a.candidate.provider, b.candidate.provider) || lex(a.candidate.adapterId, b.candidate.adapterId);
}
const scaledPenalty = (n, cap) => cap === 0 ? 0 : Number(ceilDivide(BigInt(n) * 10000n, BigInt(cap)));
function candidateReasons(candidate, { now, tenant, task, budget, policy }, contextTokens) {
  // Never reveal identifiers or metadata from another tenant in diagnostics.
  if (candidate.tenantId !== tenant.id) return ['TENANT_MISMATCH'];
  const reasons = [];
  const envelope = candidate.provider.startsWith('custom:') ? PROVIDER_CAPABILITY_REGISTRY.custom
    : Object.hasOwn(PROVIDER_CAPABILITY_REGISTRY, candidate.provider) && candidate.provider !== 'custom' ? PROVIDER_CAPABILITY_REGISTRY[candidate.provider] : null;
  if (!envelope) reasons.push('PROVIDER_UNREGISTERED');
  else if (!envelope.adapterKinds.includes(candidate.kind)) reasons.push('PROVIDER_KIND_UNSUPPORTED');
  if (!tenant.allowedProviders.includes(candidate.provider)) reasons.push('PROVIDER_NOT_ALLOWED');
  if (tenant.allowedAdapters && !tenant.allowedAdapters.includes(candidate.adapterId)) reasons.push('ADAPTER_NOT_ALLOWED');
  if (!candidate.enabled) reasons.push('ADAPTER_DISABLED');
  if (!fresh(candidate.verification, now, policy.configurationTtlMs)) reasons.push('CONFIGURATION_UNVERIFIED_OR_STALE');
  if (candidate.kind === 'intelligence' && !candidate.modelId) reasons.push('MODEL_ID_REQUIRED');
  if (candidate.capabilities.some(cap => !ADAPTER_CAPABILITY_REGISTRY[candidate.kind].includes(cap))) reasons.push('ADAPTER_CAPABILITIES_INVALID');
  if (task.capabilities.some(cap => !candidate.capabilities.includes(cap))) reasons.push('REQUIRED_CAPABILITY_MISSING');
  if (task.tools.some(tool => !candidate.tools.includes(tool))) reasons.push('REQUIRED_TOOL_MISSING');
  if (candidate.contextWindowTokens < contextTokens) reasons.push('CONTEXT_WINDOW_EXCEEDED');
  if (candidate.maxOutputTokens < task.outputTokens) reasons.push('OUTPUT_RESERVATION_EXCEEDED');
  if (!fresh(candidate.credentials, now, policy.credentialsTtlMs) || candidate.credentials.state !== 'configured') reasons.push('CREDENTIALS_UNVERIFIED_OR_UNAVAILABLE');
  if (!fresh(candidate.health, now, policy.healthTtlMs) || candidate.health.status !== 'healthy') reasons.push('HEALTH_UNVERIFIED_OR_UNAVAILABLE');
  const pricing = candidate.pricing;
  if (!fresh(pricing, now, policy.pricingTtlMs) || pricing.allInUpperBound !== true || !pricing.currency
    || ['inputMicrosPerMillionTokens', 'outputMicrosPerMillionTokens', 'requestMicros'].some(key => !Number.isSafeInteger(pricing[key]))) reasons.push('PRICING_UNVERIFIED_OR_INCOMPLETE');
  else if (pricing.currency !== budget.currency) reasons.push('PRICING_CURRENCY_MISMATCH');
  const metrics = candidate.metrics;
  if (!fresh(metrics, now, policy.metricsTtlMs) || ['qualityScore', 'reliabilityBps', 'latencyMs'].some(key => !Number.isSafeInteger(metrics[key]))) reasons.push('METRICS_UNVERIFIED_OR_INCOMPLETE');
  else {
    if (metrics.qualityScore < policy.minQualityScore) reasons.push('QUALITY_BELOW_POLICY');
    if (metrics.reliabilityBps < policy.minReliabilityBps) reasons.push('RELIABILITY_BELOW_POLICY');
    if (metrics.latencyMs > policy.maxLatencyMs) reasons.push('LATENCY_EXCEEDS_POLICY');
  }
  return reasons;
}

/**
 * Select one configured adapter for the whole request, or return blocked. This
 * does not fabricate a fallback capable of fulfilling unmet task requirements.
 * Callers may keep their existing deterministic analysis when status is blocked.
 *
 * Required input:
 * { now, tenant:{id,allowedProviders,allowedAdapters?,plan:{capabilities,limits}},
 *   task:{capabilities,tools,inputTokens,outputTokens,requests,minContextWindowTokens?},
 *   budget:{tenantId,currency,maxInputTokens,maxOutputTokens,maxTotalTokens,maxRequests,maxCostMicros},
 *   policy?:{weights?:{cost,latency,reliability,quality}, ...thresholdsAndTtls},
 *   candidates:[{tenantId,adapterId,provider,modelId?,kind,enabled,capabilities,tools,
 *     contextWindowTokens,maxOutputTokens,verification,credentials,health,pricing,metrics}] }
 *
 * Plan limits use the same fields as budget except tenantId. Token limits are
 * aggregate reservations across all requests, including all requested output.
 * Evidence requires verified:true, checkedAt and expiresAt. Credentials add
 * state:'configured'; health adds status:'healthy'; pricing adds currency,
 * inputMicrosPerMillionTokens, outputMicrosPerMillionTokens, requestMicros and
 * allInUpperBound:true; metrics add qualityScore(0..100), reliabilityBps(0..10000)
 * and latencyMs. Missing evidence is unavailable, never implicitly connected.
 */
export function routeProviderWork(input) {
  const state = readInput(input);
  const { tenant, task, budget, policy, candidates } = state;
  const totalInput = task.inputTokens * task.requests;
  const totalOutput = task.outputTokens * task.requests;
  const totalTokens = totalInput + totalOutput;
  const contextTokens = Math.max(task.minContextWindowTokens, task.inputTokens + task.outputTokens);
  const blockers = [];
  if (totalTokens > PROVIDER_ROUTING_LIMITS.totalReservedTokens) blockers.push('HARD_TOTAL_TOKEN_LIMIT');
  if (task.capabilities.some(cap => !tenant.plan.capabilities.includes(cap))) blockers.push('PLAN_CAPABILITY_NOT_ALLOWED');
  for (const [source, limit] of [['PLAN', tenant.plan.limits], ['BUDGET', budget]]) {
    if (totalInput > limit.maxInputTokens) blockers.push(`${source}_INPUT_TOKEN_LIMIT`);
    if (totalOutput > limit.maxOutputTokens) blockers.push(`${source}_OUTPUT_TOKEN_LIMIT`);
    if (totalTokens > limit.maxTotalTokens) blockers.push(`${source}_TOTAL_TOKEN_LIMIT`);
    if (task.requests > limit.maxRequests) blockers.push(`${source}_REQUEST_LIMIT`);
  }
  const effectiveCostCap = Math.min(budget.maxCostMicros, tenant.plan.limits.maxCostMicros);
  const diagnostics = [];
  const eligible = [];
  for (const candidate of candidates) {
    const reasons = candidateReasons(candidate, state, contextTokens);
    let estimated = null;
    if (!reasons.some(reason => ['TENANT_MISMATCH', 'PRICING_UNVERIFIED_OR_INCOMPLETE', 'PRICING_CURRENCY_MISMATCH'].includes(reason))) {
      estimated = estimate(candidate.pricing, task);
      if (estimated.costMicros > tenant.plan.limits.maxCostMicros) reasons.push('PLAN_COST_LIMIT');
      if (estimated.costMicros > budget.maxCostMicros) reasons.push('BUDGET_COST_LIMIT');
    }
    const diagnostic = { adapterId: candidate.tenantId === tenant.id ? candidate.adapterId : null, provider: candidate.tenantId === tenant.id ? candidate.provider : null,
      eligible: reasons.length === 0 && blockers.length === 0, reasons: [...blockers, ...reasons], costMicros: estimated?.costMicros ?? null, currency: estimated ? budget.currency : null };
    if (diagnostic.eligible) {
      const penalties = {
        cost: scaledPenalty(estimated.costMicros, effectiveCostCap),
        latency: scaledPenalty(candidate.metrics.latencyMs, policy.maxLatencyMs),
        reliability: 10000 - candidate.metrics.reliabilityBps,
        quality: (100 - candidate.metrics.qualityScore) * 100
      };
      const weightedPenalty = Object.entries(penalties).reduce((sum, [key, n]) => sum + policy.weights[key] * n, 0);
      diagnostic.weightedPenalty = weightedPenalty;
      diagnostic.penalties = penalties;
      eligible.push({ candidate, estimate: estimated, weightedPenalty, penalties });
    }
    diagnostics.push(diagnostic);
  }
  eligible.sort(compare);
  diagnostics.sort((a, b) => lex(a.provider ?? '', b.provider ?? '') || lex(a.adapterId ?? '', b.adapterId ?? '') || lex(a.reasons.join(','), b.reasons.join(',')));
  const winner = eligible[0];
  const selected = winner ? {
    tenantId: tenant.id, adapterId: winner.candidate.adapterId, provider: winner.candidate.provider, modelId: winner.candidate.modelId, kind: winner.candidate.kind,
    capabilities: [...winner.candidate.capabilities], tools: [...winner.candidate.tools], contextWindowTokens: winner.candidate.contextWindowTokens,
    maxOutputTokens: winner.candidate.maxOutputTokens, weightedPenalty: winner.weightedPenalty, penalties: { ...winner.penalties },
    pricing: { ...winner.candidate.pricing }, metrics: { ...winner.candidate.metrics },
    evidence: {
      configuration: { ...winner.candidate.verification }, credentials: { ...winner.candidate.credentials }, health: { ...winner.candidate.health }
    }
  } : null;
  return freeze({
    version: 'provider-routing.v1', tenantId: tenant.id, evaluatedAt: state.now, validUntil: winner ? validUntil(winner.candidate, policy) : null,
    status: winner ? 'selected' : 'blocked', reason: winner ? 'ROUTE_SELECTED' : blockers.length ? 'REQUEST_EXCEEDS_LIMITS' : 'NO_ELIGIBLE_PROVIDER',
    reasonCodes: winner ? ['ROUTE_SELECTED'] : [...new Set([...blockers, ...(candidates.length ? diagnostics.flatMap(item => item.reasons) : ['NO_CONFIGURED_ADAPTERS'])])].sort(),
    plannedOnly: true, approvalRequired: true, executionAuthorized: false, writesAuthorized: false,
    requirements: { capabilities: [...task.capabilities], tools: [...task.tools], inputTokensPerRequest: task.inputTokens, outputTokensPerRequest: task.outputTokens,
      contextWindowTokens: contextTokens, requests: task.requests },
    estimatedRequestBudget: { currency: budget.currency, requests: task.requests, inputTokens: totalInput, outputTokens: totalOutput, totalTokens,
      costMicros: winner?.estimate.costMicros ?? null, perRequestCostMicros: winner?.estimate.perRequestCostMicros ?? null, maxCostMicros: effectiveCostCap,
      reservationRequired: Boolean(winner), reserved: false },
    rankingPolicy: { ...policy, weights: { ...policy.weights }, tieBreak: [...TIE_BREAK], penaltyScale: 10000, lowerScorePreferred: true },
    selected, candidates: diagnostics
  });
}
