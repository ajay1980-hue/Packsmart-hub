import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { routeOperatorBrief, operatorBriefRoutingPolicyDigest } from '../lib/operator-brief-routing.mjs';
import { OPERATOR_BRIEF_ADAPTER, OPERATOR_BRIEF_SHAPE, OPERATOR_BRIEF_ENDPOINT } from '../lib/operator-brief-policy.mjs';

// All accounts, timestamps, credential digests, prices and proofs are synthetic.
// Nothing in these fixtures verifies an actual provider or authorizes dispatch.
const NOW = 1_800_000_000_000;
const MODEL = 'gpt-5.6-terra';
const limits = () => ({ maxRequests: 1000, maxInputTokens: 20_000_000, maxOutputTokens: 20_000_000,
  maxTotalTokens: 40_000_000, maxCostMicros: 10_000_000 });
const stamp = (extra = {}) => ({ verified: true, checkedAt: NOW - 1000, expiresAt: NOW + 100_000, ...extra });
function fixture() {
  const subject = { workspaceId: 'fixture-workspace', provider: 'openai', adapterId: OPERATOR_BRIEF_ADAPTER,
    modelId: MODEL, requestShape: OPERATOR_BRIEF_SHAPE, endpoint: OPERATOR_BRIEF_ENDPOINT,
    credentialDigest: 'a'.repeat(64), accountId: 'fixture-private-billing-account' };
  const evidence = extra => ({ binding: { ...subject }, ...stamp(extra) });
  return attest({ now: NOW, workspaceId: subject.workspaceId, selectedRoute: { provider: 'openai', model: MODEL },
    endpoint: OPERATOR_BRIEF_ENDPOINT, credentialDigest: subject.credentialDigest, accountId: subject.accountId, outputTokens: 500,
    policySnapshot: { version: 1, enabled: true, currency: 'USD', configuredAt: NOW - 10_000,
      accountingStartAt: NOW - 5000, tenantLimits: limits(), monthlyCostLimitUsd: null,
      provider: { enabled: true, allowedAdapters: [OPERATOR_BRIEF_ADAPTER], allowedModels: [MODEL], limits: limits(),
        pricing: [{ version: 'synthetic-price-v1', adapterId: OPERATOR_BRIEF_ADAPTER, modelId: MODEL,
          ...stamp(), currency: 'USD', allInUpperBound: true, inputMicrosPerMillionTokens: 2_000_000,
          cachedInputMicrosPerMillionTokens: 200_000, cacheWriteMicrosPerMillionTokens: 3_000_000,
          outputMicrosPerMillionTokens: 12_000_000, requestMicros: 7 }] },
      adapter: { enabled: true, atomicUsageCutoverAt: NOW - 5000 },
      modelProof: { ...stamp(), requestShape: OPERATOR_BRIEF_SHAPE, endpoint: OPERATOR_BRIEF_ENDPOINT,
        allBillableInputTokensCovered: true, outputLimitCoversAllBillableOutput: true,
        maxBillableInputTokens: 4000, maxBillableOutputTokens: 2000, cacheWriteMode: 'reported' } },
    evidence: { account: evidence(), configuration: evidence({ capabilities: ['intelligence.text', 'intelligence.reasoning'], contextWindowTokens: 128_000 }),
      credentials: evidence({ state: 'configured' }), health: evidence({ status: 'healthy' }),
      metrics: evidence({ qualityScore: 90, reliabilityBps: 9900, latencyMs: 1000 }) } });
}
// Explicitly simulates a fresh trusted issuer attestation in synthetic fixtures.
function attest(input) {
  const digest = operatorBriefRoutingPolicyDigest({ modelProof: input.policySnapshot.modelProof,
    pricing: input.policySnapshot.provider.pricing[0] });
  input.evidence.account.policyDigest = digest;
  input.evidence.configuration.policyDigest = digest;
  return input;
}
const set = (value, path, replacement) => {
  const keys = path.split('.'); const key = keys.pop();
  const parent = keys.reduce((item, name) => item[name], value); parent[key] = replacement;
};
function blocked(value, code) {
  const result = routeOperatorBrief(value);
  assert.equal(result.status, 'blocked');
  if (code) assert.ok(result.reasonCodes.includes(code), JSON.stringify(result));
  assert.equal(result.selected, null); assert.equal(result.bindingFingerprint, null); assert.equal(result.validUntil, null);
  assert.equal(result.executionAuthorized, false); assert.equal(result.writesAuthorized, false);
  assert.equal(result.plannedOnly, true); assert.ok(JSON.stringify(result).length < 3000);
  return result;
}
function frozen(value) {
  if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen); }
}

test('routes exactly one existing OpenAI brief through the actual router without admitting it', () => {
  const result = routeOperatorBrief(fixture());
  assert.equal(result.status, 'selected'); assert.equal(result.reason, 'ROUTE_SELECTED');
  assert.deepEqual(result.selected, { provider: 'openai', adapterId: OPERATOR_BRIEF_ADAPTER, modelId: MODEL });
  assert.equal(result.routingDecision.version, 'provider-routing.v1');
  assert.deepEqual(result.routingDecision.requirements, { capabilities: ['intelligence.reasoning', 'intelligence.text'], tools: [],
    inputTokensPerRequest: 4000, outputTokensPerRequest: 500, contextWindowTokens: 4500, requests: 1 });
  assert.deepEqual(result.routingDecision.estimatedRequestBudget, { currency: 'USD', requests: 1, inputTokens: 4000,
    outputTokens: 500, totalTokens: 4500, costMicros: 18007, perRequestCostMicros: 18007,
    maxCostMicros: 10_000_000, reservationRequired: true, reserved: false });
  assert.equal(result.validUntil, NOW + 59_000); assert.match(result.bindingFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(result.executionAuthorized, false); assert.equal(result.writesAuthorized, false); assert.equal(result.approvalRequired, true);
  assert.equal(result.routingDecision.executionAuthorized, false); assert.equal(result.routingDecision.writesAuthorized, false);
  frozen(result);
});

test('missing account, capability, credentials, health or metrics evidence fails closed', () => {
  for (const [key, code] of [['account', 'AI_ROUTING_ACCOUNT_UNVERIFIED_OR_STALE'],
    ['configuration', 'AI_ROUTING_CONFIGURATION_UNVERIFIED_OR_STALE'], ['credentials', 'CREDENTIALS_UNVERIFIED_OR_UNAVAILABLE'],
    ['health', 'HEALTH_UNVERIFIED_OR_UNAVAILABLE'], ['metrics', 'METRICS_UNVERIFIED_OR_INCOMPLETE']]) {
    for (const missing of [undefined, null]) { const input = fixture(); input.evidence[key] = missing; blocked(input, code); }
    const unverified = fixture(); unverified.evidence[key].verified = false; blocked(unverified);
  }
  for (const path of ['accountId', 'credentialDigest', 'evidence', 'policySnapshot']) {
    const input = fixture(); delete input[path]; blocked(input);
  }
});

test('each evidence item must bind workspace, provider, adapter, exact model, shape, endpoint, account and credential', () => {
  const changes = { workspaceId: 'another-private-workspace', provider: 'anthropic', adapterId: 'another-adapter',
    modelId: 'gpt-5.6-sol', requestShape: 'other:v1', endpoint: 'https://unapproved.invalid/v1/responses',
    credentialDigest: 'b'.repeat(64), accountId: 'wrong-private-account' };
  for (const evidenceKey of Object.keys(fixture().evidence)) {
    for (const [field, value] of Object.entries(changes)) {
      const input = fixture(); input.evidence[evidenceKey].binding[field] = value;
      const result = blocked(input); assert.ok(!JSON.stringify(result).includes(value));
    }
  }
  for (const [field, value] of [['workspaceId', 'another-workspace'], ['credentialDigest', 'b'.repeat(64)], ['accountId', 'another-account']]) {
    const input = fixture(); input[field] = value; blocked(input, 'AI_ROUTING_EVIDENCE_BINDING_MISMATCH');
  }
});

test('cannot change or expand the already selected job route, existing model catalog, endpoint or request shape', () => {
  for (const route of [{ provider: 'anthropic', model: MODEL }, { provider: 'openai', model: 'unlisted-model' },
    { provider: 'openai', model: 'deterministic' }, { provider: 'openai', model: 'constructor' },
    { provider: 'openai', model: 'gpt-5.6-sol' }]) {
    const input = fixture(); input.selectedRoute = route; blocked(input);
  }
  for (const path of ['endpoint', 'policySnapshot.modelProof.endpoint', 'policySnapshot.modelProof.requestShape']) {
    const input = fixture(); set(input, path, 'unsupported-fixture'); blocked(input);
  }
  const input = fixture(); input.candidates = [input.selectedRoute]; blocked(input);
});

test('existing governance, provider/model allowlists, cutover and billable-token proof remain mandatory', () => {
  for (const [path, value] of [['policySnapshot.enabled', false], ['policySnapshot.provider.enabled', false],
    ['policySnapshot.adapter.enabled', false], ['policySnapshot.provider.allowedAdapters', []],
    ['policySnapshot.provider.allowedModels', []], ['policySnapshot.accountingStartAt', NOW + 1], ['policySnapshot.configuredAt', NOW + 1],
    ['policySnapshot.adapter.atomicUsageCutoverAt', NOW + 1], ['policySnapshot.modelProof.verified', false],
    ['policySnapshot.modelProof.allBillableInputTokensCovered', false], ['policySnapshot.modelProof.outputLimitCoversAllBillableOutput', false],
    ['policySnapshot.modelProof.cacheWriteMode', 'unknown'], ['policySnapshot.modelProof.maxBillableInputTokens', 1_000_001],
    ['policySnapshot.modelProof.maxBillableOutputTokens', 128_001], ['policySnapshot.modelProof.maxBillableOutputTokens', 499],
    ['policySnapshot.modelProof.expiresAt', NOW], ['policySnapshot.modelProof.checkedAt', NOW + 1],
    ['policySnapshot.modelProof.expiresAt', NOW - 1000 + 604_800_001], ['outputTokens', 63], ['outputTokens', 2001]]) {
    const input = fixture(); set(input, path, value); blocked(input);
  }
  const input = fixture(); input.outputTokens = 64; input.policySnapshot.modelProof.maxBillableInputTokens = 1;
  const result = routeOperatorBrief(attest(input));
  assert.equal(result.status, 'selected'); assert.equal(result.routingDecision.requirements.inputTokensPerRequest, 1);
  assert.equal(result.routingDecision.requirements.outputTokensPerRequest, 64);
});

test('capabilities, full reserved context and actual hard output cap are distinct required evidence', () => {
  const input = fixture(); input.evidence.configuration.capabilities = ['intelligence.text']; blocked(input, 'REQUIRED_CAPABILITY_MISSING');
  input.evidence.configuration.capabilities = ['intelligence.text', 'intelligence.reasoning'];
  input.evidence.configuration.contextWindowTokens = 4499; blocked(input, 'CONTEXT_WINDOW_EXCEEDED');
  input.evidence.configuration.contextWindowTokens = 4500; assert.equal(routeOperatorBrief(input).status, 'selected');
  input.evidence.configuration.contextWindowTokens = 2_000_001; blocked(input);
  const hardCap = fixture(); hardCap.outputTokens = 2000;
  assert.equal(routeOperatorBrief(hardCap).routingDecision.estimatedRequestBudget.outputTokens, 2000);
});

test('router TTL and explicit expiry both end eligibility at the exact millisecond', () => {
  const ttls = { account: 900_000, configuration: 86_400_000, credentials: 900_000, health: 60_000, metrics: 3_600_000 };
  for (const [key, ttl] of Object.entries(ttls)) {
    const input = fixture(); input.evidence[key].checkedAt = NOW - ttl + 1;
    assert.equal(routeOperatorBrief(input).status, 'selected'); assert.equal(routeOperatorBrief(input).validUntil, NOW + 1);
    input.now = NOW + 1; blocked(input);
    const expiry = fixture(); expiry.evidence[key].expiresAt = NOW + 1;
    assert.equal(routeOperatorBrief(expiry).validUntil, NOW + 1); expiry.now = NOW + 1; blocked(expiry);
    const future = fixture(); future.evidence[key].checkedAt = NOW + 1; blocked(future);
    const backwards = fixture(); backwards.evidence[key].expiresAt = backwards.evidence[key].checkedAt; blocked(backwards);
  }
  const input = fixture(); const price = input.policySnapshot.provider.pricing[0];
  price.checkedAt = NOW - 86_400_000 + 1; price.expiresAt = NOW + 100_000; attest(input);
  assert.equal(routeOperatorBrief(input).validUntil, NOW + 1); input.now++; blocked(input, 'PRICING_UNVERIFIED_OR_INCOMPLETE');
  for (const key of ['modelProof', 'pricing']) {
    const value = fixture(); const proof = key === 'pricing' ? value.policySnapshot.provider.pricing[0] : value.policySnapshot.modelProof;
    proof.expiresAt = NOW + 1; attest(value); assert.equal(routeOperatorBrief(value).validUntil, NOW + 1); value.now++; blocked(value);
  }
});

test('metric thresholds, credential state and health status are real router gates', () => {
  for (const [path, value, code] of [['evidence.metrics.qualityScore', 59, 'QUALITY_BELOW_POLICY'],
    ['evidence.metrics.reliabilityBps', 9499, 'RELIABILITY_BELOW_POLICY'], ['evidence.metrics.latencyMs', 60001, 'LATENCY_EXCEEDS_POLICY'],
    ['evidence.credentials.state', 'revoked', 'CREDENTIALS_UNVERIFIED_OR_UNAVAILABLE'],
    ['evidence.health.status', 'degraded', 'HEALTH_UNVERIFIED_OR_UNAVAILABLE']]) {
    const input = fixture(); set(input, path, value); blocked(input, code);
  }
});

test('conservative cost uses the largest full input-category rate and rounds each component up', () => {
  for (const field of ['inputMicrosPerMillionTokens', 'cachedInputMicrosPerMillionTokens', 'cacheWriteMicrosPerMillionTokens']) {
    const input = fixture(); input.policySnapshot.provider.pricing[0][field] = 9_000_000; attest(input);
    assert.equal(routeOperatorBrief(input).routingDecision.estimatedRequestBudget.costMicros, 42007);
  }
  const input = fixture(); const price = input.policySnapshot.provider.pricing[0];
  for (const field of ['inputMicrosPerMillionTokens', 'cachedInputMicrosPerMillionTokens', 'cacheWriteMicrosPerMillionTokens', 'outputMicrosPerMillionTokens']) price[field] = 1;
  price.requestMicros = 1; input.policySnapshot.modelProof.maxBillableInputTokens = 1; input.outputTokens = 64; attest(input);
  assert.equal(routeOperatorBrief(input).routingDecision.estimatedRequestBudget.costMicros, 3);
});

test('complete unique fresh verified pricing is compulsory; display catalog prices supply nothing', () => {
  for (const [key, value] of [['verified', false], ['allInUpperBound', false], ['currency', 'GBP'], ['version', ''],
    ['modelId', 'gpt-5.6-sol'], ['adapterId', 'other'], ['expiresAt', NOW], ['checkedAt', NOW + 1],
    ['inputMicrosPerMillionTokens', 1_000_000_000_001]]) {
    const input = fixture(); input.policySnapshot.provider.pricing[0][key] = value; blocked(input);
  }
  for (const key of ['cachedInputMicrosPerMillionTokens', 'cacheWriteMicrosPerMillionTokens', 'outputMicrosPerMillionTokens', 'requestMicros']) {
    const input = fixture(); delete input.policySnapshot.provider.pricing[0][key]; blocked(input);
  }
  const missing = fixture(); missing.policySnapshot.provider.pricing = []; blocked(missing);
  const duplicate = fixture(); duplicate.policySnapshot.provider.pricing.push(structuredClone(duplicate.policySnapshot.provider.pricing[0])); blocked(duplicate, 'AI_PRICING_UNVERIFIED');
});

test('selected pricing version must be unique even when a matching duplicate is expired', () => {
  const input = fixture(); const duplicate = structuredClone(input.policySnapshot.provider.pricing[0]);
  duplicate.checkedAt = NOW - 10_000; duplicate.expiresAt = NOW - 1;
  input.policySnapshot.provider.pricing.push(duplicate); blocked(input, 'AI_PRICING_UNVERIFIED');
  input.policySnapshot.provider.pricing[1].version = 'separate-expired-version';
  assert.equal(routeOperatorBrief(input).status, 'selected');
});

test('account and configuration attest the exact canonical price and token-proof snapshot', () => {
  for (const [path, value] of [['policySnapshot.modelProof.maxBillableInputTokens', 1],
    ['policySnapshot.modelProof.maxBillableOutputTokens', 1999], ['policySnapshot.modelProof.cacheWriteMode', 'not_applicable'],
    ['policySnapshot.provider.pricing.0.inputMicrosPerMillionTokens', 1],
    ['policySnapshot.provider.pricing.0.cachedInputMicrosPerMillionTokens', 1],
    ['policySnapshot.provider.pricing.0.cacheWriteMicrosPerMillionTokens', 1],
    ['policySnapshot.provider.pricing.0.version', 'unattested-version']]) {
    const input = fixture(); set(input, path, value); blocked(input, 'AI_ROUTING_POLICY_ATTESTATION_MISMATCH');
    attest(input); assert.equal(routeOperatorBrief(input).status, 'selected');
  }
  for (const key of ['account', 'configuration']) {
    const input = fixture(); input.evidence[key].policyDigest = 'c'.repeat(64);
    blocked(input, 'AI_ROUTING_POLICY_ATTESTATION_MISMATCH'); delete input.evidence[key].policyDigest; blocked(input);
  }
  const input = fixture(); const policy = { modelProof: input.policySnapshot.modelProof, pricing: input.policySnapshot.provider.pricing[0] };
  const digest = operatorBriefRoutingPolicyDigest(policy);
  const reversed = { modelProof: Object.fromEntries(Object.entries(policy.modelProof).reverse()),
    pricing: Object.fromEntries(Object.entries(policy.pricing).reverse()) };
  assert.equal(operatorBriefRoutingPolicyDigest(reversed), digest);
  assert.equal(operatorBriefRoutingPolicyDigest({ ...policy, secret: 'must-not-echo' }), null);
});

test('valid large SQL monthly limits cap only routing envelopes; complete originals remain bound', () => {
  const input = fixture();
  for (const scope of [input.policySnapshot.tenantLimits, input.policySnapshot.provider.limits])
    for (const key of Object.keys(scope)) scope[key] = Number.MAX_SAFE_INTEGER;
  const result = routeOperatorBrief(input); assert.equal(result.status, 'selected');
  assert.equal(result.routingDecision.estimatedRequestBudget.maxCostMicros, 1_000_000_000_000);
  assert.equal(result.routingDecision.estimatedRequestBudget.inputTokens, 4000);
  input.policySnapshot.tenantLimits.maxRequests--;
  assert.notEqual(routeOperatorBrief(input).bindingFingerprint, result.bindingFingerprint);
  input.policySnapshot.provider.limits.maxInputTokens = 3999; blocked(input, 'BUDGET_INPUT_TOKEN_LIMIT');
});

test('explicit zero limits survive projection at each scope; verified zero prices remain distinct from missing', () => {
  for (const scope of ['tenantLimits', 'provider.limits']) {
    for (const key of Object.keys(limits())) { const input = fixture(); set(input, `policySnapshot.${scope}.${key}`, 0); blocked(input); }
  }
  const input = fixture(); input.policySnapshot.monthlyCostLimitUsd = 0; blocked(input, 'PLAN_COST_LIMIT');
  for (const key of ['inputMicrosPerMillionTokens', 'cachedInputMicrosPerMillionTokens', 'cacheWriteMicrosPerMillionTokens', 'outputMicrosPerMillionTokens', 'requestMicros'])
    input.policySnapshot.provider.pricing[0][key] = 0;
  const result = routeOperatorBrief(attest(input)); assert.equal(result.status, 'selected'); assert.equal(result.routingDecision.estimatedRequestBudget.costMicros, 0);
  assert.equal(result.routingDecision.estimatedRequestBudget.reserved, false);
  input.policySnapshot.tenantLimits.maxRequests = 0; blocked(input, 'PLAN_REQUEST_LIMIT');
});

test('owner USD ceilings use exact decimal micro-flooring including exponent notation and zero', () => {
  for (const [usd, micros] of [[0.000249, 249], [0.000001, 1], [0.0000009, 0], [1e-7, 0], [0.1000009, 100000], [1000000, 1_000_000_000_000], [-0, 0]]) {
    const input = fixture(); input.policySnapshot.monthlyCostLimitUsd = usd;
    input.policySnapshot.tenantLimits.maxCostMicros = Number.MAX_SAFE_INTEGER;
    input.policySnapshot.provider.limits.maxCostMicros = Number.MAX_SAFE_INTEGER;
    const result = routeOperatorBrief(input); assert.equal(result.routingDecision.estimatedRequestBudget.maxCostMicros, micros);
  }
  for (const value of [undefined, null]) {
    const input = fixture(); input.policySnapshot.monthlyCostLimitUsd = value;
    assert.equal(routeOperatorBrief(input).routingDecision.estimatedRequestBudget.maxCostMicros, 10_000_000);
  }
  for (const value of ['', '1', false, -1, Infinity, NaN, 1000000.01]) {
    const input = fixture(); input.policySnapshot.monthlyCostLimitUsd = value; blocked(input);
  }
});

test('missing, fractional, stringly, unsafe and malformed authoritative limits are never clamped into eligibility', () => {
  for (const scope of ['tenantLimits', 'provider.limits']) {
    for (const key of Object.keys(limits())) {
      for (const value of [undefined, null, '100', NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        const input = fixture(); set(input, `policySnapshot.${scope}.${key}`, value); blocked(input, 'AI_ROUTING_INPUT_INVALID');
      }
    }
  }
});

test('fingerprint is stable across clock movement, property order and allowlist/capability order', () => {
  const original = fixture(); original.policySnapshot.provider.allowedModels.push('gpt-5.6-sol');
  const before = routeOperatorBrief(original);
  const input = fixture(); input.policySnapshot.provider.allowedModels = ['gpt-5.6-sol', MODEL];
  input.evidence.configuration.capabilities.reverse(); input.now++;
  input.evidence.account.binding = Object.fromEntries(Object.entries(input.evidence.account.binding).reverse());
  const after = routeOperatorBrief(input);
  assert.equal(after.status, 'selected'); assert.notEqual(after.evaluatedAt, before.evaluatedAt);
  assert.equal(after.bindingFingerprint, before.bindingFingerprint); assert.equal(after.validUntil, before.validUntil);
});

test('binding changes for unchanged-max category rates, versions, evidence, limits, account or credentials', () => {
  const original = routeOperatorBrief(fixture());
  for (const [path, value] of [['policySnapshot.provider.pricing.0.cachedInputMicrosPerMillionTokens', 250000],
    ['policySnapshot.provider.pricing.0.version', 'synthetic-price-v2'], ['policySnapshot.modelProof.cacheWriteMode', 'not_applicable'],
    ['policySnapshot.tenantLimits.maxRequests', 1001], ['policySnapshot.monthlyCostLimitUsd', 100],
    ['evidence.health.checkedAt', NOW - 500], ['evidence.configuration.contextWindowTokens', 100000], ['outputTokens', 501]]) {
    const input = fixture(); set(input, path, value); const result = routeOperatorBrief(attest(input));
    assert.equal(result.status, 'selected'); assert.notEqual(result.bindingFingerprint, original.bindingFingerprint);
  }
  for (const [key, value] of [['accountId', 'another-trusted-account'], ['credentialDigest', 'b'.repeat(64)]]) {
    const input = fixture(); input[key] = value;
    for (const evidence of Object.values(input.evidence)) evidence.binding[key] = value;
    const result = routeOperatorBrief(input); assert.equal(result.status, 'selected'); assert.notEqual(result.bindingFingerprint, original.bindingFingerprint);
  }
});

test('diagnostics exclude private account bindings, credentials, prompts and unrelated workspace data', () => {
  const input = fixture(); const result = routeOperatorBrief(input); const serialized = JSON.stringify(result);
  for (const secret of [input.workspaceId, input.accountId, input.credentialDigest, 'credentialDigest', 'accountId', 'binding"'])
    assert.ok(!serialized.includes(secret));
  for (const key of ['apiKey', 'prompt', 'generatedText', 'workspace', 'usageHistory', 'candidates', 'policy', 'execute', 'fetchImpl']) {
    const value = fixture(); value[key] = { secret: 'synthetic-private-payload' };
    const failure = blocked(value); assert.ok(!JSON.stringify(failure).includes('synthetic-private-payload'));
  }
  for (const path of ['policySnapshot', 'policySnapshot.modelProof', 'evidence.account', 'evidence.account.binding']) {
    const value = fixture(); path.split('.').reduce((object, key) => object[key], value).secret = 'synthetic-private-payload';
    assert.ok(!JSON.stringify(blocked(value)).includes('synthetic-private-payload'));
  }
});

test('strict bounded DTOs reject accessors, symbols, holes, prototypes and extra array payloads without evaluating getters', () => {
  let calls = 0;
  for (const path of ['now', 'selectedRoute.model', 'policySnapshot.modelProof.checkedAt', 'evidence.health.binding.accountId', 'policySnapshot.provider.pricing.0']) {
    const input = fixture(); const keys = path.split('.'); const key = keys.pop();
    const parent = keys.reduce((object, name) => object[name], input);
    Object.defineProperty(parent, key, { enumerable: true, get() { calls++; throw new Error('private getter content'); } });
    blocked(input);
  }
  assert.equal(calls, 0);
  for (const change of [input => { input[Symbol('secret')] = 'secret'; }, input => { delete input.policySnapshot.provider.pricing[0]; },
    input => { input.evidence.configuration.capabilities.extra = 'secret'; }, input => { input.evidence.health = new Date(); },
    input => { input.policySnapshot.provider.pricing = Array(129).fill(input.policySnapshot.provider.pricing[0]); },
    input => { input.evidence.configuration.capabilities = Array(65).fill('intelligence.text'); },
    input => { input.evidence.configuration.capabilities = ['intelligence.text', 'intelligence.text']; },
    input => { input.workspaceId = 'w'.repeat(97); }]) {
    const input = fixture(); change(input); blocked(input);
  }
  for (const input of [null, undefined, [], () => {}, Object.create({ now: NOW })]) blocked(input);
  const nullPrototype = Object.assign(Object.create(null), fixture()); assert.equal(routeOperatorBrief(nullPrototype).status, 'selected');
});

test('revoked and nested throwing proxies cannot escape the bounded failure result', () => {
  const revocable = Proxy.revocable({}, {}); revocable.revoke();
  blocked(revocable.proxy, 'AI_ROUTING_INPUT_INVALID');
  const thrown = new Proxy({}, { getPrototypeOf() { throw new Error('SECRET_SENTINEL'); } });
  const input = new Proxy({}, { getPrototypeOf() { throw thrown; } });
  const result = blocked(input, 'AI_ROUTING_INPUT_INVALID');
  assert.ok(!JSON.stringify(result).includes('SECRET_SENTINEL'));
  assert.equal(operatorBriefRoutingPolicyDigest(input), null);
  for (const value of [null, undefined, 1, 'private-throw', Symbol('private-throw')]) {
    blocked(new Proxy({}, { getPrototypeOf() { throw value; } }), 'AI_ROUTING_INPUT_INVALID');
  }
});

test('pure calls never mutate, freeze or retain caller-owned objects and never fetch or read runtime configuration', async () => {
  const input = fixture(); const before = structuredClone(input); const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error('must not dispatch'); };
  let result;
  try { result = routeOperatorBrief(input); blocked({ ...input, evidence: {} }); } finally { globalThis.fetch = originalFetch; }
  assert.equal(calls, 0); assert.deepEqual(input, before); assert.equal(Object.isFrozen(input.evidence.health), false);
  input.evidence.health.status = 'unavailable'; input.policySnapshot.provider.pricing[0].requestMicros = 100;
  assert.equal(result.status, 'selected'); assert.equal(result.routingDecision.estimatedRequestBudget.costMicros, 18007);
  assert.throws(() => { result.selected.modelId = 'other'; }, TypeError);
  const source = await readFile(new URL('../lib/operator-brief-routing.mjs', import.meta.url), 'utf8');
  assert.match(source, /routeProviderWork\(/); assert.match(source, /operatorBriefPolicy\(/);
  assert.doesNotMatch(source, /\b(?:fetch|writeFile|appendFile|exec|spawn|setTimeout|setInterval)\s*\(/);
  assert.doesNotMatch(source, /process\.env|Date\.now|new Date|Math\.random|createAiProvider|reserveProviderUsage|settleProviderUsage/);
  const production = await readFile(new URL('../lib/ai-provider.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(production, /operator-brief-routing|routeOperatorBrief/);
});
