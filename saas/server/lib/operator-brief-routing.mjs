/**
 * INACTIVE preparation: a pure translation seam for the existing operator brief.
 * Only trusted server evidence may enter this DTO. Verification flags are not
 * authentication. No runtime imports this module; selection is never admission.
 */
import { AI_MODEL_CATALOG } from './ai-economics.mjs';
import { PROVIDER_ROUTING_LIMITS, ADAPTER_CAPABILITY_REGISTRY, routeProviderWork } from './provider-router.mjs';
import { OPERATOR_BRIEF_ADAPTER, OPERATOR_BRIEF_SHAPE, OPERATOR_BRIEF_ENDPOINT,
  briefDigest, operatorBriefPolicy } from './operator-brief-policy.mjs';

const VERSION = 'operator-brief-routing.v1';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/;
const TIME_MAX = 8_640_000_000_000_000;
const CAPABILITIES = ['intelligence.reasoning', 'intelligence.text'];
const LIMIT_KEYS = ['maxRequests', 'maxInputTokens', 'maxOutputTokens', 'maxTotalTokens', 'maxCostMicros'];
const RATE_KEYS = ['inputMicrosPerMillionTokens', 'cachedInputMicrosPerMillionTokens',
  'cacheWriteMicrosPerMillionTokens', 'outputMicrosPerMillionTokens', 'requestMicros'];
const BINDING_KEYS = ['workspaceId', 'provider', 'adapterId', 'modelId', 'requestShape', 'endpoint', 'credentialDigest', 'accountId'];
const STAMP_KEYS = ['verified', 'checkedAt', 'expiresAt'];
const PROOF_KEYS = ['verified', 'allBillableInputTokensCovered', 'outputLimitCoversAllBillableOutput',
  'requestShape', 'endpoint', 'maxBillableInputTokens', 'maxBillableOutputTokens', 'cacheWriteMode', 'checkedAt', 'expiresAt'];
const PRICE_KEYS = ['version', 'adapterId', 'modelId', ...STAMP_KEYS, 'allInUpperBound', 'currency', ...RATE_KEYS];
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const failures = new WeakMap();
const fail = (code = 'AI_ROUTING_INPUT_INVALID') => {
  const error = new Error(code); failures.set(error, code); throw error;
};
function record(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.length) fail();
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor || !('value' in descriptor)) fail();
    result[key] = descriptor.value;
  }
  return result;
}
function text(value, pattern = ID) {
  if (typeof value !== 'string' || !pattern.test(value)) fail();
  return value;
}
function integer(value, max = Number.MAX_SAFE_INTEGER, min = 0) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail();
  return value;
}
function boolean(value) { if (typeof value !== 'boolean') fail(); return value; }
function oneOf(value, values) { if (!values.includes(value)) fail(); return value; }
function list(value, read, max = 128) {
  if (!Array.isArray(value) || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) fail();
  const result = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !('value' in descriptor)) fail();
    result.push(read(descriptor.value));
  }
  return result;
}
function identifiers(value, pattern = ID, max = 128) {
  const result = list(value, item => text(item, pattern), max).sort();
  if (new Set(result).size !== result.length) fail();
  return result;
}
function stamp(value) {
  return { verified: boolean(value.verified), checkedAt: integer(value.checkedAt, TIME_MAX), expiresAt: integer(value.expiresAt, TIME_MAX) };
}
function binding(value) {
  const item = record(value, BINDING_KEYS);
  return { workspaceId: text(item.workspaceId), provider: oneOf(item.provider, ['openai']),
    adapterId: oneOf(item.adapterId, [OPERATOR_BRIEF_ADAPTER]), modelId: text(item.modelId, MODEL),
    requestShape: oneOf(item.requestShape, [OPERATOR_BRIEF_SHAPE]), endpoint: oneOf(item.endpoint, [OPERATOR_BRIEF_ENDPOINT]),
    credentialDigest: text(item.credentialDigest, HASH), accountId: text(item.accountId) };
}
function evidence(value, extra, expected) {
  if (value === undefined || value === null) return null;
  const item = record(value, ['binding', ...STAMP_KEYS, ...extra]);
  const subject = binding(item.binding);
  if (BINDING_KEYS.some(key => subject[key] !== expected[key])) fail('AI_ROUTING_EVIDENCE_BINDING_MISMATCH');
  return { item, normalized: { binding: subject, ...stamp(item) } };
}
function limits(value) {
  const item = record(value, LIMIT_KEYS);
  return Object.fromEntries(LIMIT_KEYS.map(key => [key, integer(item[key])]));
}
function proof(value) {
  const item = record(value, PROOF_KEYS);
  return { ...stamp(item), allBillableInputTokensCovered: boolean(item.allBillableInputTokensCovered),
    outputLimitCoversAllBillableOutput: boolean(item.outputLimitCoversAllBillableOutput),
    requestShape: oneOf(item.requestShape, [OPERATOR_BRIEF_SHAPE]), endpoint: oneOf(item.endpoint, [OPERATOR_BRIEF_ENDPOINT]),
    maxBillableInputTokens: integer(item.maxBillableInputTokens, PROVIDER_ROUTING_LIMITS.inputTokensPerRequest, 1),
    maxBillableOutputTokens: integer(item.maxBillableOutputTokens, PROVIDER_ROUTING_LIMITS.outputTokensPerRequest, 1),
    cacheWriteMode: oneOf(item.cacheWriteMode, ['reported', 'not_applicable']) };
}
function price(value) {
  const item = record(value, PRICE_KEYS);
  return { version: text(item.version, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
    adapterId: text(item.adapterId), modelId: text(item.modelId, MODEL), ...stamp(item),
    allInUpperBound: boolean(item.allInUpperBound), currency: oneOf(item.currency, ['USD']),
    ...Object.fromEntries(RATE_KEYS.map(key => [key, integer(item[key], PROVIDER_ROUTING_LIMITS.costMicros)])) };
}
// SQL floors the decimal JSON number multiplied by 1e6. Avoid floating-point
// multiplication (e.g. 0.000249 * 1e6) and preserve sub-micro ceilings as zero.
function ownerCeiling(value) {
  if (value === undefined || value === null) return { usd: null, micros: null };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) fail();
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const digits = BigInt(whole + fraction);
  const scale = 6 + Number(exponent) - fraction.length;
  const micros = scale >= 0 ? digits * 10n ** BigInt(scale) : digits / 10n ** BigInt(-scale);
  return { usd: value === 0 ? 0 : value, micros: Number(micros) };
}
function policySnapshot(value) {
  const item = record(value, ['version', 'enabled', 'currency', 'configuredAt', 'accountingStartAt',
    'tenantLimits', 'monthlyCostLimitUsd', 'provider', 'adapter', 'modelProof']);
  const provider = record(item.provider, ['enabled', 'allowedAdapters', 'allowedModels', 'limits', 'pricing']);
  const adapter = record(item.adapter, ['enabled', 'atomicUsageCutoverAt']);
  return { version: oneOf(item.version, [1]), enabled: boolean(item.enabled), currency: oneOf(item.currency, ['USD']),
    configuredAt: integer(item.configuredAt, TIME_MAX), accountingStartAt: integer(item.accountingStartAt, TIME_MAX),
    tenantLimits: limits(item.tenantLimits), ownerCeiling: ownerCeiling(item.monthlyCostLimitUsd),
    provider: { enabled: boolean(provider.enabled), allowedAdapters: identifiers(provider.allowedAdapters),
      allowedModels: identifiers(provider.allowedModels, MODEL), limits: limits(provider.limits),
      pricing: list(provider.pricing, price).sort((a, b) => {
        const left = JSON.stringify(a), right = JSON.stringify(b);
        return left < right ? -1 : left > right ? 1 : 0;
      }) },
    adapter: { enabled: boolean(adapter.enabled), atomicUsageCutoverAt: integer(adapter.atomicUsageCutoverAt, TIME_MAX) },
    modelProof: proof(item.modelProof) };
}
/**
 * Canonical digest for a trusted evidence issuer. Computing it is NOT evidence
 * verification. Issuers must attest these exact values for the bound account.
 * Null means malformed input; no untrusted exception content is returned.
 */
export function operatorBriefRoutingPolicyDigest(input) {
  try {
    const value = record(input, ['modelProof', 'pricing']);
    return briefDigest({ version: 'operator-brief-routing-policy.v1',
      modelProof: proof(value.modelProof), pricing: price(value.pricing) });
  } catch { return null; }
}
function envelope(value, costCeiling = null) {
  return { currency: 'USD', maxRequests: Math.min(value.maxRequests, PROVIDER_ROUTING_LIMITS.requests),
    maxInputTokens: Math.min(value.maxInputTokens, PROVIDER_ROUTING_LIMITS.totalReservedTokens),
    maxOutputTokens: Math.min(value.maxOutputTokens, PROVIDER_ROUTING_LIMITS.totalReservedTokens),
    maxTotalTokens: Math.min(value.maxTotalTokens, PROVIDER_ROUTING_LIMITS.totalReservedTokens),
    maxCostMicros: Math.min(value.maxCostMicros, PROVIDER_ROUTING_LIMITS.costMicros, costCeiling ?? PROVIDER_ROUTING_LIMITS.costMicros) };
}
function withoutBinding(value) {
  if (!value) return null;
  const { binding: privateSubject, ...publicEvidence } = value;
  return publicEvidence;
}
function blocked(reason, evaluatedAt = null) {
  return freeze({ version: VERSION, status: 'blocked', reason, reasonCodes: [reason], evaluatedAt,
    validUntil: null, bindingFingerprint: null, plannedOnly: true, approvalRequired: true,
    executionAuthorized: false, writesAuthorized: false, selected: null, routingDecision: null });
}

/**
 * See saas/docs/operator-brief-routing.md for the strict trusted-server DTO.
 * This function does not accept a workspace, job payload, secret, prompt, usage
 * history, or candidate pool. All failures are bounded, value-free diagnostics.
 */
export function routeOperatorBrief(input) {
  try {
    const value = record(input, ['now', 'workspaceId', 'selectedRoute', 'endpoint', 'credentialDigest',
      'accountId', 'outputTokens', 'policySnapshot', 'evidence']);
    const now = integer(value.now, TIME_MAX);
    const route = record(value.selectedRoute, ['provider', 'model']);
    if (route.provider !== 'openai' || typeof route.model !== 'string' || !Object.hasOwn(AI_MODEL_CATALOG, route.model)
      || AI_MODEL_CATALOG[route.model].provider !== 'openai') fail('AI_ROUTING_SELECTED_ROUTE_UNSUPPORTED');
    const subject = binding({ workspaceId: value.workspaceId, provider: route.provider, adapterId: OPERATOR_BRIEF_ADAPTER,
      modelId: route.model, requestShape: OPERATOR_BRIEF_SHAPE, endpoint: value.endpoint,
      credentialDigest: value.credentialDigest, accountId: value.accountId });
    const outputTokens = integer(value.outputTokens, 2000, 64);
    const snapshot = policySnapshot(value.policySnapshot);
    if (snapshot.configuredAt > now) return blocked('AI_ROUTING_CONFIGURATION_UNVERIFIED_OR_STALE', now);
    const state = { workspace: { id: subject.workspaceId }, aiEconomics: {
      monthlyCostLimitUsd: snapshot.ownerCeiling.usd,
      governance: { version: snapshot.version, enabled: snapshot.enabled, currency: snapshot.currency,
        configuredAt: snapshot.configuredAt, accountingStartAt: snapshot.accountingStartAt, tenantLimits: snapshot.tenantLimits,
        providers: { openai: { ...snapshot.provider, adapters: { [OPERATOR_BRIEF_ADAPTER]: {
          ...snapshot.adapter, models: { [route.model]: snapshot.modelProof } } } } } } } };
    const policy = operatorBriefPolicy({ state, workspaceId: subject.workspaceId, model: route.model,
      outputTokens, endpoint: subject.endpoint, now });
    if (!policy.allowed) return blocked(policy.reason, now);
    const selectedPrices = snapshot.provider.pricing.filter(item => item.version === policy.pricingVersion
      && item.adapterId === OPERATOR_BRIEF_ADAPTER && item.modelId === route.model);
    // Match SQL's exact-version uniqueness, including expired duplicate rows.
    if (selectedPrices.length !== 1) return blocked('AI_PRICING_UNVERIFIED', now);
    const pricing = selectedPrices[0];
    const policyDigest = operatorBriefRoutingPolicyDigest({ modelProof: snapshot.modelProof, pricing });
    const evidenceInput = record(value.evidence, ['account', 'configuration', 'credentials', 'health', 'metrics']);
    const accountEvidence = evidence(evidenceInput.account, ['policyDigest'], subject);
    const account = accountEvidence ? { ...accountEvidence.normalized, policyDigest: text(accountEvidence.item.policyDigest, HASH) } : null;
    if (!account) return blocked('AI_ROUTING_ACCOUNT_UNVERIFIED_OR_STALE', now);
    const configuration = evidence(evidenceInput.configuration, ['capabilities', 'contextWindowTokens', 'policyDigest'], subject);
    if (!configuration) return blocked('AI_ROUTING_CONFIGURATION_UNVERIFIED_OR_STALE', now);
    const verifiedConfiguration = { ...configuration.normalized, policyDigest: text(configuration.item.policyDigest, HASH),
      capabilities: identifiers(configuration.item.capabilities, /^[a-z][a-z.]+$/, PROVIDER_ROUTING_LIMITS.listItems),
      contextWindowTokens: integer(configuration.item.contextWindowTokens, PROVIDER_ROUTING_LIMITS.contextWindowTokens) };
    if (account.policyDigest !== policyDigest || verifiedConfiguration.policyDigest !== policyDigest)
      return blocked('AI_ROUTING_POLICY_ATTESTATION_MISMATCH', now);
    if (verifiedConfiguration.capabilities.some(item => !ADAPTER_CAPABILITY_REGISTRY.intelligence.includes(item))) fail();
    const credentials = evidence(evidenceInput.credentials, ['state'], subject);
    const verifiedCredentials = credentials ? { ...credentials.normalized,
      state: oneOf(credentials.item.state, ['configured', 'missing', 'revoked', 'unknown']) } : null;
    const health = evidence(evidenceInput.health, ['status'], subject);
    const verifiedHealth = health ? { ...health.normalized,
      status: oneOf(health.item.status, ['healthy', 'degraded', 'unavailable', 'unknown']) } : null;
    const metrics = evidence(evidenceInput.metrics, ['qualityScore', 'reliabilityBps', 'latencyMs'], subject);
    const verifiedMetrics = metrics ? { ...metrics.normalized,
      qualityScore: integer(metrics.item.qualityScore, 100), reliabilityBps: integer(metrics.item.reliabilityBps, 10000),
      latencyMs: integer(metrics.item.latencyMs, PROVIDER_ROUTING_LIMITS.latencyMs) } : null;
    const decision = routeProviderWork({ now,
      tenant: { id: subject.workspaceId, allowedProviders: ['openai'], allowedAdapters: [OPERATOR_BRIEF_ADAPTER],
        plan: { capabilities: [...CAPABILITIES], limits: envelope(snapshot.tenantLimits, snapshot.ownerCeiling.micros) } },
      task: { capabilities: [...CAPABILITIES], tools: [], inputTokens: policy.inputTokenBound,
        outputTokens: policy.outputTokenBound, requests: 1 },
      budget: { tenantId: subject.workspaceId, ...envelope(snapshot.provider.limits) },
      candidates: [{ tenantId: subject.workspaceId, provider: 'openai', adapterId: OPERATOR_BRIEF_ADAPTER,
        modelId: route.model, kind: 'intelligence', enabled: true, capabilities: verifiedConfiguration.capabilities, tools: [],
        contextWindowTokens: verifiedConfiguration.contextWindowTokens, maxOutputTokens: snapshot.modelProof.maxBillableOutputTokens,
        verification: stamp(verifiedConfiguration), credentials: withoutBinding(verifiedCredentials), health: withoutBinding(verifiedHealth),
        metrics: withoutBinding(verifiedMetrics), pricing: { ...stamp(pricing), currency: pricing.currency,
          inputMicrosPerMillionTokens: Math.max(pricing.inputMicrosPerMillionTokens, pricing.cachedInputMicrosPerMillionTokens, pricing.cacheWriteMicrosPerMillionTokens),
          outputMicrosPerMillionTokens: pricing.outputMicrosPerMillionTokens, requestMicros: pricing.requestMicros, allInUpperBound: pricing.allInUpperBound } }] });
    const accountDeadline = Math.min(account.expiresAt, account.checkedAt + decision.rankingPolicy.credentialsTtlMs);
    if (!account.verified || account.checkedAt > now || now >= accountDeadline || account.expiresAt <= account.checkedAt)
      return blocked('AI_ROUTING_ACCOUNT_UNVERIFIED_OR_STALE', now);
    const selected = decision.status === 'selected';
    const selectedRoute = selected ? { provider: decision.selected.provider, adapterId: decision.selected.adapterId, modelId: decision.selected.modelId } : null;
    if (selected && (selectedRoute.provider !== route.provider || selectedRoute.adapterId !== OPERATOR_BRIEF_ADAPTER || selectedRoute.modelId !== route.model))
      return blocked('AI_ROUTING_SELECTED_ROUTE_MISMATCH', now);
    // Keep raw account identifiers, credential digests and proof snapshots out
    // of diagnostics. The opaque binding is server-only too; do not log it.
    const bindingFingerprint = selected ? briefDigest({ version: VERSION, subject, snapshot, policyFingerprint: policy.fingerprint,
      account, configuration: verifiedConfiguration, credentials: verifiedCredentials, health: verifiedHealth, metrics: verifiedMetrics,
      requirements: decision.requirements, rankingPolicy: decision.rankingPolicy }) : null;
    return freeze({ version: VERSION, status: decision.status, reason: decision.reason, reasonCodes: [...decision.reasonCodes],
      evaluatedAt: now, validUntil: selected ? Math.min(decision.validUntil, accountDeadline, policy.validUntil) : null,
      bindingFingerprint, plannedOnly: true, approvalRequired: true, executionAuthorized: false, writesAuthorized: false,
      selected: selectedRoute, routingDecision: { version: decision.version, status: decision.status, reason: decision.reason,
        reasonCodes: [...decision.reasonCodes], requirements: { ...decision.requirements },
        estimatedRequestBudget: { ...decision.estimatedRequestBudget }, plannedOnly: true, executionAuthorized: false, writesAuthorized: false } });
  } catch (error) {
    // No caller value, arbitrary exception, stack, or provider content escapes.
    return blocked(failures.get(error) ?? 'AI_ROUTING_INPUT_INVALID');
  }
}
