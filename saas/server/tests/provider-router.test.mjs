import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ADAPTER_CAPABILITY_REGISTRY, PROVIDER_CAPABILITY_REGISTRY, PROVIDER_ROUTING_LIMITS, ProviderRoutingInputError, routeProviderWork } from '../lib/provider-router.mjs';

const NOW = 1_800_000_000_000;
const checked = extra => ({ verified: true, checkedAt: NOW - 1000, expiresAt: NOW + 60_000, ...extra });
const cap = 'intelligence.text';
const makeLimits = overrides => ({ currency: 'USD', maxInputTokens: 100_000, maxOutputTokens: 30_000, maxTotalTokens: 130_000, maxRequests: 10, maxCostMicros: 1_000_000, ...overrides });
function adapter(overrides = {}) {
  return {
    tenantId: 'tenant-a', adapterId: 'adapter-a', provider: 'openai', modelId: 'fixture-configured-model', kind: 'intelligence', enabled: true,
    capabilities: [cap, 'intelligence.reasoning'], tools: ['read.documents'], contextWindowTokens: 100_000, maxOutputTokens: 20_000,
    verification: checked(), credentials: checked({ state: 'configured' }), health: checked({ status: 'healthy' }),
    // Test-only synthetic verified rates, not a claim about any live provider.
    pricing: checked({ currency: 'USD', inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 6_000_000, requestMicros: 10, allInUpperBound: true }),
    metrics: checked({ qualityScore: 85, reliabilityBps: 9900, latencyMs: 1000 }), ...overrides
  };
}
function input(overrides = {}) {
  return {
    now: NOW,
    tenant: { id: 'tenant-a', allowedProviders: ['openai', 'xai', 'anthropic', 'gemini', 'firecrawl', 'runway', 'canva', 'custom:fixture'], plan: { capabilities: Object.values(ADAPTER_CAPABILITY_REGISTRY).flat().filter((item, index, all) => all.indexOf(item) === index), limits: makeLimits() } },
    task: { capabilities: [cap], tools: ['read.documents'], inputTokens: 2000, outputTokens: 1000, requests: 1 },
    budget: { tenantId: 'tenant-a', ...makeLimits() }, candidates: [adapter()], ...overrides
  };
}
function frozen(value) {
  if (value && typeof value === 'object') {
    assert.ok(Object.isFrozen(value));
    for (const child of Object.values(value)) frozen(child);
  }
}
function reason(request, expected) {
  const result = routeProviderWork(request);
  assert.equal(result.status, 'blocked');
  assert.ok(result.reasonCodes.includes(expected), `${expected}: ${result.reasonCodes}`);
  assert.equal(result.selected, null);
  assert.equal(result.estimatedRequestBudget.costMicros, null);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.writesAuthorized, false);
  assert.equal(result.approvalRequired, true);
  return result;
}
function invalid(request, field) {
  assert.throws(() => routeProviderWork(request), error => error instanceof ProviderRoutingInputError && error.code === 'PROVIDER_ROUTING_INPUT_INVALID' && (!field || error.field === field));
}

test('selects only configured metadata, reserves full requested output, and preserves approval gates', () => {
  const result = routeProviderWork(input());
  assert.equal(result.status, 'selected');
  assert.equal(result.reason, 'ROUTE_SELECTED');
  assert.deepEqual(result.reasonCodes, ['ROUTE_SELECTED']);
  assert.equal(result.selected.provider, 'openai');
  assert.equal(result.selected.modelId, 'fixture-configured-model');
  assert.equal(result.selected.adapterId, 'adapter-a');
  assert.deepEqual(result.estimatedRequestBudget, { currency: 'USD', requests: 1, inputTokens: 2000, outputTokens: 1000, totalTokens: 3000, costMicros: 10010, perRequestCostMicros: 10010, maxCostMicros: 1_000_000, reservationRequired: true, reserved: false });
  assert.equal(result.requirements.contextWindowTokens, 3000);
  assert.equal(result.evaluatedAt, NOW);
  assert.equal(result.validUntil, NOW + 59_000); // The health TTL is stricter than its supplied expiry.
  assert.equal(result.plannedOnly, true);
  assert.equal(result.approvalRequired, true);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.writesAuthorized, false);
  frozen(result);
});

test('empty or unavailable providers are blocked without inventing connected models or zero costs', () => {
  const result = reason(input({ candidates: [] }), 'NO_CONFIGURED_ADAPTERS');
  assert.deepEqual(result.candidates, []);
  assert.equal(result.estimatedRequestBudget.reservationRequired, false);
  assert.equal(result.validUntil, null);
  reason(input({ candidates: [adapter({ enabled: false })] }), 'ADAPTER_DISABLED');
  reason(input({ candidates: [adapter({ enabled: undefined })] }), 'ADAPTER_DISABLED');
  reason(input({ candidates: [adapter({ provider: 'unregistered' })] }), 'PROVIDER_UNREGISTERED');
  reason(input({ candidates: [adapter({ modelId: null })] }), 'MODEL_ID_REQUIRED');
});

test('prices must be complete, verified, fresh, and explicitly all-in', () => {
  for (const pricing of [undefined, null, {}, checked(), checked({ currency: 'USD', requestMicros: 0, allInUpperBound: true }),
    { ...adapter().pricing, verified: false }, { ...adapter().pricing, allInUpperBound: false },
    { ...adapter().pricing, checkedAt: NOW - 86_400_000, expiresAt: NOW + 1000 }, { ...adapter().pricing, expiresAt: NOW },
    { ...adapter().pricing, checkedAt: NOW + 1 }, { ...adapter().pricing, checkedAt: undefined }]) {
    const result = reason(input({ candidates: [adapter({ pricing })] }), 'PRICING_UNVERIFIED_OR_INCOMPLETE');
    assert.equal(result.candidates[0].costMicros, null);
  }
});

test('health, credentials, configuration and performance each require independent fresh evidence', () => {
  const cases = [
    ['health', undefined, 'HEALTH_UNVERIFIED_OR_UNAVAILABLE'], ['health', checked({ status: 'unknown' }), 'HEALTH_UNVERIFIED_OR_UNAVAILABLE'],
    ['health', checked({ status: 'unavailable' }), 'HEALTH_UNVERIFIED_OR_UNAVAILABLE'], ['health', checked({ status: 'degraded' }), 'HEALTH_UNVERIFIED_OR_UNAVAILABLE'],
    ['health', checked({ status: 'healthy', checkedAt: NOW - 60_000 }), 'HEALTH_UNVERIFIED_OR_UNAVAILABLE'],
    ['health', checked({ status: 'healthy', verified: false }), 'HEALTH_UNVERIFIED_OR_UNAVAILABLE'],
    ['health', checked({ status: 'healthy', checkedAt: NOW + 1 }), 'HEALTH_UNVERIFIED_OR_UNAVAILABLE'],
    ['health', checked({ status: 'healthy', expiresAt: NOW }), 'HEALTH_UNVERIFIED_OR_UNAVAILABLE'],
    ['credentials', undefined, 'CREDENTIALS_UNVERIFIED_OR_UNAVAILABLE'], ['credentials', checked({ state: 'missing' }), 'CREDENTIALS_UNVERIFIED_OR_UNAVAILABLE'],
    ['credentials', checked({ state: 'revoked' }), 'CREDENTIALS_UNVERIFIED_OR_UNAVAILABLE'], ['credentials', checked({ state: 'unknown' }), 'CREDENTIALS_UNVERIFIED_OR_UNAVAILABLE'],
    ['credentials', checked({ state: 'configured', checkedAt: NOW - 900_000 }), 'CREDENTIALS_UNVERIFIED_OR_UNAVAILABLE'],
    ['verification', undefined, 'CONFIGURATION_UNVERIFIED_OR_STALE'], ['verification', checked({ checkedAt: NOW - 86_400_000 }), 'CONFIGURATION_UNVERIFIED_OR_STALE'],
    ['metrics', undefined, 'METRICS_UNVERIFIED_OR_INCOMPLETE'], ['metrics', checked(), 'METRICS_UNVERIFIED_OR_INCOMPLETE'],
    ['metrics', { ...adapter().metrics, verified: false }, 'METRICS_UNVERIFIED_OR_INCOMPLETE'],
    ['metrics', { ...adapter().metrics, checkedAt: NOW - 3_600_000 }, 'METRICS_UNVERIFIED_OR_INCOMPLETE']
  ];
  for (const [field, value, code] of cases) reason(input({ candidates: [adapter({ [field]: value })] }), code);
});

test('expired preferred provider is skipped for a genuinely eligible lower-ranked candidate', () => {
  const stale = adapter({ adapterId: 'preferred', metrics: checked({ qualityScore: 100, reliabilityBps: 10000, latencyMs: 1 }), health: checked({ status: 'healthy', expiresAt: NOW }) });
  const selected = routeProviderWork(input({ candidates: [stale, adapter()] }));
  assert.equal(selected.selected.adapterId, 'adapter-a');
  assert.ok(selected.candidates.find(item => item.adapterId === 'preferred').reasons.includes('HEALTH_UNVERIFIED_OR_UNAVAILABLE'));
});

test('provider families and adapter capabilities cannot substitute creative, research, or intelligence work', () => {
  assert.deepEqual(PROVIDER_CAPABILITY_REGISTRY.firecrawl.families, ['research']);
  assert.deepEqual(PROVIDER_CAPABILITY_REGISTRY.runway.families, ['creative']);
  assert.deepEqual(PROVIDER_CAPABILITY_REGISTRY.canva.adapterKinds, ['design']);
  frozen(PROVIDER_CAPABILITY_REGISTRY);
  frozen(ADAPTER_CAPABILITY_REGISTRY);
  frozen(PROVIDER_ROUTING_LIMITS);
  reason(input({ candidates: [adapter({ provider: 'firecrawl' })] }), 'PROVIDER_KIND_UNSUPPORTED');
  reason(input({ candidates: [adapter({ provider: 'runway', kind: 'media', capabilities: ['creative.video'] })] }), 'REQUIRED_CAPABILITY_MISSING');
  reason(input({ candidates: [adapter({ provider: 'canva', kind: 'design', capabilities: [cap] })] }), 'ADAPTER_CAPABILITIES_INVALID');
  for (const [provider, kind, capability] of [['firecrawl', 'research', 'research.crawl'], ['runway', 'media', 'creative.video'], ['canva', 'design', 'creative.presentation']]) {
    const request = input({ task: { capabilities: [capability], tools: [], inputTokens: 0, outputTokens: 0, requests: 1 }, candidates: [adapter(), adapter({ adapterId: 'specialist', provider, kind, modelId: null, capabilities: [capability], tools: [], contextWindowTokens: 0, maxOutputTokens: 0 })] });
    assert.equal(routeProviderWork(request).selected.adapterId, 'specialist');
  }
});

test('each intelligence provider and a future custom provider use explicit caller-supplied adapters', () => {
  for (const provider of ['openai', 'xai', 'anthropic', 'gemini', 'custom:fixture']) {
    assert.equal(routeProviderWork(input({ candidates: [adapter({ provider })] })).selected.provider, provider);
  }
  reason(input({ candidates: [adapter({ provider: 'custom' })] }), 'PROVIDER_UNREGISTERED');
});

test('exact tools, full input plus output context, and output reservation are mandatory', () => {
  reason(input({ candidates: [adapter({ tools: [] })] }), 'REQUIRED_TOOL_MISSING');
  reason(input({ candidates: [adapter({ contextWindowTokens: 2999 })] }), 'CONTEXT_WINDOW_EXCEEDED');
  reason(input({ candidates: [adapter({ maxOutputTokens: 999 })] }), 'OUTPUT_RESERVATION_EXCEEDED');
  const request = input();
  request.task.minContextWindowTokens = 100001;
  reason(request, 'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(routeProviderWork(input({ candidates: [adapter({ contextWindowTokens: 3000, maxOutputTokens: 1000 })] })).status, 'selected');
});

test('tenant provider and adapter allowlists plus plan capability limits are enforced', () => {
  const request = input();
  request.tenant.allowedProviders = [];
  reason(request, 'PROVIDER_NOT_ALLOWED');
  request.tenant.allowedProviders = ['openai'];
  request.tenant.allowedAdapters = [];
  reason(request, 'ADAPTER_NOT_ALLOWED');
  request.tenant.allowedAdapters = ['adapter-a'];
  request.tenant.plan.capabilities = [];
  reason(request, 'PLAN_CAPABILITY_NOT_ALLOWED');
});

test('cross-tenant candidates cannot be selected or disclose adapter identifiers', () => {
  const result = reason(input({ candidates: [adapter({ tenantId: 'tenant-b', adapterId: 'foreign-secret-adapter', modelId: 'foreign-model' })] }), 'TENANT_MISMATCH');
  assert.deepEqual(result.candidates, [{ adapterId: null, provider: null, eligible: false, reasons: ['TENANT_MISMATCH'], costMicros: null, currency: null }]);
  assert.equal(JSON.stringify(result).includes('foreign'), false);
  invalid(input({ budget: { tenantId: 'tenant-b', ...makeLimits() } }), 'budget.tenantId');
});

test('tenant plan and remaining budget enforce aggregate input, output, total, requests, and cost separately', () => {
  for (const [scope, code] of [['plan', 'PLAN'], ['budget', 'BUDGET']]) {
    for (const [key, value, suffix] of [['maxInputTokens', 3999, 'INPUT_TOKEN_LIMIT'], ['maxOutputTokens', 1999, 'OUTPUT_TOKEN_LIMIT'], ['maxTotalTokens', 5999, 'TOTAL_TOKEN_LIMIT'], ['maxRequests', 1, 'REQUEST_LIMIT'], ['maxCostMicros', 20019, 'COST_LIMIT']]) {
      const request = input();
      request.task.requests = 2;
      (scope === 'plan' ? request.tenant.plan.limits : request.budget)[key] = value;
      reason(request, `${code}_${suffix}`);
    }
  }
  const exact = input();
  exact.task.requests = 2;
  exact.budget = { tenantId: 'tenant-a', currency: 'USD', maxInputTokens: 4000, maxOutputTokens: 2000, maxTotalTokens: 6000, maxRequests: 2, maxCostMicros: 20020 };
  assert.equal(routeProviderWork(exact).status, 'selected');
});

test('zero monetary or request budgets cannot produce a paid request; verified free prices remain distinct from unknown', () => {
  const request = input();
  request.budget.maxCostMicros = 0;
  reason(request, 'BUDGET_COST_LIMIT');
  request.candidates[0].pricing = checked({ currency: 'USD', inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0, requestMicros: 0, allInUpperBound: true });
  const free = routeProviderWork(request);
  assert.equal(free.status, 'selected');
  assert.equal(free.estimatedRequestBudget.costMicros, 0);
  request.budget.maxRequests = 0;
  reason(request, 'BUDGET_REQUEST_LIMIT');
});

test('currencies never mix, convert, or silently default to USD', () => {
  reason(input({ candidates: [adapter({ pricing: { ...adapter().pricing, currency: 'GBP' } })] }), 'PRICING_CURRENCY_MISMATCH');
  invalid(input({ budget: { tenantId: 'tenant-a', ...makeLimits({ currency: 'GBP' }) } }), 'budget.currency');
  const request = input();
  delete request.budget.currency;
  invalid(request, 'budget.currency');
  const gbp = input();
  gbp.budget.currency = gbp.tenant.plan.limits.currency = gbp.candidates[0].pricing.currency = 'GBP';
  assert.equal(routeProviderWork(gbp).estimatedRequestBudget.currency, 'GBP');
});

test('request cost rounds conservative per-request token components up and includes request charges', () => {
  const request = input();
  request.task = { ...request.task, inputTokens: 1, outputTokens: 1, requests: 3 };
  request.candidates[0].pricing = { ...request.candidates[0].pricing, inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1, requestMicros: 1 };
  const result = routeProviderWork(request);
  assert.equal(result.estimatedRequestBudget.perRequestCostMicros, 3);
  assert.equal(result.estimatedRequestBudget.costMicros, 9);
  request.budget.maxCostMicros = 8;
  reason(request, 'BUDGET_COST_LIMIT');
});

test('hard token, output, request, and evidence TTL caps cannot be relaxed by tenant policy', () => {
  for (const [key, value] of [['inputTokens', 1_000_001], ['outputTokens', 128_001], ['requests', 101], ['minContextWindowTokens', 2_000_001]]) {
    const request = input();
    request.task[key] = value;
    invalid(request, `task.${key}`);
  }
  const many = input();
  many.task.inputTokens = 1_000_000;
  many.task.requests = 3;
  reason(many, 'HARD_TOTAL_TOKEN_LIMIT');
  for (const key of ['healthTtlMs', 'credentialsTtlMs', 'configurationTtlMs', 'pricingTtlMs', 'metricsTtlMs']) {
    invalid(input({ policy: { [key]: PROVIDER_ROUTING_LIMITS[key] + 1 } }), `policy.${key}`);
    invalid(input({ policy: { [key]: 0 } }), `policy.${key}`);
  }
});

test('quality, reliability, and latency floors are eligibility gates before weighted ranking', () => {
  for (const [key, value, code] of [['qualityScore', 59, 'QUALITY_BELOW_POLICY'], ['reliabilityBps', 9499, 'RELIABILITY_BELOW_POLICY'], ['latencyMs', 60001, 'LATENCY_EXCEEDS_POLICY']]) {
    reason(input({ candidates: [adapter({ metrics: { ...adapter().metrics, [key]: value } })] }), code);
  }
});

test('ranking is transparent, deterministic, stable under input ordering, and configurable', () => {
  const candidates = [adapter({ adapterId: 'z' }), adapter({ adapterId: 'a' }), adapter({ adapterId: 'b', provider: 'anthropic' })];
  const result = routeProviderWork(input({ candidates }));
  assert.equal(result.selected.adapterId, 'b'); // Lexical provider then adapter after identical scores.
  assert.deepEqual(routeProviderWork(input({ candidates: [...candidates].reverse() })), result);
  const penalty = result.selected.penalties;
  assert.equal(result.selected.weightedPenalty, Object.entries(penalty).reduce((sum, [key, n]) => sum + n * result.rankingPolicy.weights[key], 0));
  const cheaper = adapter({ adapterId: 'cheap', pricing: { ...adapter().pricing, requestMicros: 0, inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 1_000_000 }, metrics: checked({ qualityScore: 60, reliabilityBps: 9500, latencyMs: 2000 }) });
  const better = adapter({ adapterId: 'quality', metrics: checked({ qualityScore: 99, reliabilityBps: 9999, latencyMs: 500 }) });
  const pool = [cheaper, better];
  const cases = [
    [{ cost: 100, latency: 0, reliability: 0, quality: 0 }, 'cheap'],
    [{ cost: 0, latency: 0, reliability: 0, quality: 100 }, 'quality'],
    [{ cost: 0, latency: 100, reliability: 0, quality: 0 }, 'quality'],
    [{ cost: 0, latency: 0, reliability: 100, quality: 0 }, 'quality']
  ];
  for (const [weights, expected] of cases) assert.equal(routeProviderWork(input({ candidates: pool, policy: { weights } })).selected.adapterId, expected);
});

test('unknown untrusted fields, secret payloads, coercion, invalid IDs and unbounded lists are rejected safely', () => {
  const secret = 'do-not-echo-this-secret';
  for (const field of ['prompt', 'sourceBody', 'apiKey', 'execute', 'fetchImpl']) {
    const request = input();
    request[field] = secret;
    assert.throws(() => routeProviderWork(request), error => error.code === 'PROVIDER_ROUTING_INPUT_INVALID' && !JSON.stringify(error).includes(secret) && !error.message.includes(secret));
    const nested = input();
    nested.candidates[0][field] = secret;
    invalid(nested);
  }
  for (const value of ['', '../tenant', 'tenant/a', ' tenant', 'tenant\n', 1, null, 'a'.repeat(97)]) {
    const request = input();
    request.tenant.id = value;
    invalid(request, 'tenant.id');
  }
  for (const value of [NaN, Infinity, -1, 1.5, '10', null]) {
    const request = input();
    request.task.inputTokens = value;
    invalid(request, 'task.inputTokens');
  }
  invalid(input({ candidates: Array.from({ length: 129 }, (_, i) => adapter({ adapterId: `adapter-${i}` })) }), 'candidates');
  invalid(input({ candidates: [adapter(), adapter()] }), 'candidates');
  invalid(input({ policy: { weights: { cost: 25, quality: 25 } } }), 'policy.weights');
  invalid(input({ policy: { weights: { cost: 0, quality: 0, latency: 0, reliability: 0 } } }), 'policy.weights');
  invalid(input({ now: undefined }), 'now');
  invalid(input({ task: { ...input().task, capabilities: ['creative.unknown'] } }), 'task.capabilities');
  invalid(input({ candidates: [adapter({ pricing: { ...adapter().pricing, requestMicros: -1 } })] }), 'candidates');
});

test('does not evaluate getters/functions, mutate the caller, or retain mutable input references', () => {
  let calls = 0;
  const request = input();
  Object.defineProperty(request.candidates[0].credentials, 'state', { get() { calls++; throw new Error('credential access'); }, enumerable: true });
  invalid(request);
  assert.equal(calls, 0);
  const array = input();
  Object.defineProperty(array.candidates, '0', { get() { calls++; throw new Error('adapter access'); }, enumerable: true });
  invalid(array);
  assert.equal(calls, 0);
  const fn = input();
  fn.candidates[0].health = () => { calls++; };
  invalid(fn);
  assert.equal(calls, 0);
  const original = input();
  const before = structuredClone(original);
  const result = routeProviderWork(original);
  assert.deepEqual(original, before);
  original.candidates[0].capabilities.push('intelligence.vision');
  original.candidates[0].health.status = 'unavailable';
  original.candidates[0].pricing.requestMicros = 999;
  assert.equal(result.selected.capabilities.includes('intelligence.vision'), false);
  assert.equal(result.selected.evidence.health.status, 'healthy');
  assert.equal(result.selected.pricing.requestMicros, 10);
  assert.throws(() => { result.selected.pricing.requestMicros = 999; }, TypeError);
});

test('routing performs no provider calls, imports no execution facilities, and never grants writes', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error('network must not be called'); };
  try {
    for (const request of [input(), input({ candidates: [] }), input({ task: { ...input().task, tools: ['write.publish'] }, candidates: [adapter({ tools: ['write.publish'] })] })]) {
      const result = routeProviderWork(request);
      assert.equal(result.executionAuthorized, false);
      assert.equal(result.writesAuthorized, false);
      assert.equal(result.approvalRequired, true);
      assert.equal(result.estimatedRequestBudget.reserved, false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
  const source = await readFile(new URL('../lib/provider-router.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import\s/m);
  assert.doesNotMatch(source, /\b(?:fetch|writeFile|appendFile|exec|spawn|setTimeout|setInterval)\s*\(/);
  assert.doesNotMatch(source, /process\.env|Date\.now|new Date|Math\.random/);
});
