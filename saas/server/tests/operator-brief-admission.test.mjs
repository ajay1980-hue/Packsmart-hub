import test from 'node:test';
import assert from 'node:assert/strict';
import * as providerModule from '../lib/ai-provider.mjs';
import { readFile } from 'node:fs/promises';
import { briefDigest } from '../lib/operator-brief-policy.mjs';
import { operatorBriefRoutingPolicyDigest } from '../lib/operator-brief-routing.mjs';
import { createStore } from '../lib/store.mjs';
import { createAiProvider } from '../lib/ai-provider.mjs';
import { OPERATOR_BRIEF_ADAPTER, OPERATOR_BRIEF_ENDPOINT, OPERATOR_BRIEF_SHAPE } from '../lib/operator-brief-policy.mjs';

const NOW = Date.parse('2026-11-01T00:01:00.000Z');
const MODEL = 'gpt-5.6-luna';
const price = () => ({ version: 'synthetic-price-v1', adapterId: OPERATOR_BRIEF_ADAPTER, modelId: MODEL,
  verified: true, allInUpperBound: true, currency: 'USD', checkedAt: NOW - 1000, expiresAt: NOW + 3600000,
  inputMicrosPerMillionTokens: 1000000, cachedInputMicrosPerMillionTokens: 1000000,
  cacheWriteMicrosPerMillionTokens: 1000000, outputMicrosPerMillionTokens: 1000000, requestMicros: 10 });
const proof = () => ({ verified: true, allBillableInputTokensCovered: true, outputLimitCoversAllBillableOutput: true,
  requestShape: OPERATOR_BRIEF_SHAPE, endpoint: OPERATOR_BRIEF_ENDPOINT, maxBillableInputTokens: 10000,
  maxBillableOutputTokens: 2000, checkedAt: NOW - 1000, expiresAt: NOW + 3600000, cacheWriteMode: 'reported' });
const limits = () => ({ maxRequests: 10, maxInputTokens: 100000, maxOutputTokens: 20000, maxTotalTokens: 120000, maxCostMicros: 2000000 });
function receiptBody() {
  return { id: 'resp_synthetic', object: 'response', model: MODEL, status: 'completed', output_text: 'Synthetic verified brief.',
    usage: { input_tokens: 1000, output_tokens: 20, total_tokens: 1020, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 } } };
}
function response(body = receiptBody(), { status = 200, url = OPERATOR_BRIEF_ENDPOINT, redirected = false, raw = false } = {}) {
  const result = raw ? new Response(body, { status }) : Response.json(body, { status });
  Object.defineProperties(result, { url: { value: url }, redirected: { value: redirected } });
  return result;
}
function fixture() {
  let clock = NOW;
  const state = { workspace: { id: 'brief_fixture' }, aiEconomics: { monthlyCostLimitUsd: 2, governance: {
    version: 1, enabled: true, currency: 'USD', accountingStartAt: NOW - 60000, configuredAt: NOW - 60001,
    tenantLimits: limits(), providers: { openai: { enabled: true, allowedAdapters: [OPERATOR_BRIEF_ADAPTER], allowedModels: [MODEL],
      limits: limits(), adapters: { [OPERATOR_BRIEF_ADAPTER]: { enabled: true, atomicUsageCutoverAt: NOW - 60000, models: { [MODEL]: proof() } } }, pricing: [price()] } }
  } } };
  const jobContext = { workspaceId: state.workspace.id, jobId: 'job_fixture', type: 'agent_command', status: 'running',
    workerId: 'worker_fixture', attempt: 1, leaseUntil: new Date(NOW + 300000).toISOString(), createdAt: new Date(NOW - 1000).toISOString() };
  const env = { RUNVARA_OPENAI_ENABLED: 'true', OPENAI_API_KEY: 'synthetic-local-test-key-only', RUNVARA_AI_MAX_OUTPUT_TOKENS: '500' };
  const args = { workspaceId: state.workspace.id, jobId: jobContext.jobId, jobContext, route: { provider: 'openai', model: MODEL, tier: 'economy' },
    command: 'Summarise recorded health', run: { summary: 'Recorded contribution £40.', priorities: [], urgentRisks: [], workStatus: 'COMPLETED' }, state };
  const events = [], reservations = new Map(), settlements = [], posts = [];
  const store = {
    provider: 'supabase',
    aiUsageSummary: async () => assert.fail('A paid admission must not scan legacy usage'),
    recordAiUsage: async () => assert.fail('Atomic settlement owns the legacy usage insert'),
    reserveProviderUsage: async (workspaceId, input) => {
      events.push('reserve');
      assert.equal(workspaceId, state.workspace.id);
      if (reservations.has(input.callKey)) {
        const previous = reservations.get(input.callKey);
        if (previous.input.requestFingerprint !== input.requestFingerprint) throw Object.assign(new Error('Conflict'), { code: 'AI_USAGE_RESERVATION_UNCERTAIN' });
        return { dispatchAllowed: false, reason: 'AI_LOGICAL_CALL_EXISTS', reservationId: previous.ack.reservationId, status: 'held' };
      }
      const ack = { dispatchAllowed: true, reservationId: 'provider_usage_fixture', status: 'held', windowStart: '2026-11-01',
        reservedRequests: 1, reservedInputTokens: input.inputTokenBound, reservedOutputTokens: input.outputTokenBound,
        reservedTotalTokens: input.inputTokenBound + input.outputTokenBound, reservedCostMicros: 10510, currency: 'USD', pricingVersion: input.pricingVersion };
      reservations.set(input.callKey, { input: structuredClone(input), ack: structuredClone(ack) }); return ack;
    },
    getOperatorBriefContext: async () => {
      events.push('context');
      return { workspaceId: state.workspace.id, aiEconomics: structuredClone(state.aiEconomics),
        executionPolicy: { agentOpsEnabled: state.agentOps?.enabled, agentOpsPaused: state.agentOps?.paused,
          commanderEnabled: state.agentSettings?.commander?.enabled },
        job: { ...jobContext, provider: 'openai', model: MODEL } };
    },
    settleProviderUsage: async (workspaceId, input) => {
      events.push('settle'); settlements.push(structuredClone(input));
      assert.equal(workspaceId, state.workspace.id);
      return input.outcome === 'complete' ? { reservationId: input.reservationId, status: 'settled', accountedCostMicros: 1030, idempotent: false }
        : { reservationId: input.reservationId, status: 'uncertain', heldCostMicros: 10510, reason: input.receipt.errorCode, idempotent: false };
    }
  };
  const f = { state, jobContext, env, args, store, events, reservations, settlements, posts,
    now: () => clock, advance: n => { clock += n; }, fetch: async (url, init) => { events.push('post'); posts.push({ url, init }); return response(); } };
  f.run = () => createAiProvider({ env, store, now: f.now, fetchImpl: (...a) => f.fetch(...a) }).enhanceCommander(args);
  f.proof = state.aiEconomics.governance.providers.openai.adapters[OPERATOR_BRIEF_ADAPTER].models[MODEL];
  return f;
}

function routedFixture() {
  const f = fixture();
  const binding = { workspaceId: f.args.workspaceId, provider: 'openai', adapterId: OPERATOR_BRIEF_ADAPTER,
    modelId: MODEL, requestShape: OPERATOR_BRIEF_SHAPE, endpoint: OPERATOR_BRIEF_ENDPOINT,
    credentialDigest: briefDigest(f.env.OPENAI_API_KEY), accountId: 'synthetic-billing-account' };
  const stamp = extra => ({ binding: { ...binding }, verified: true, checkedAt: NOW - 1000, expiresAt: NOW + 300000, ...extra });
  const policyDigest = operatorBriefRoutingPolicyDigest({ modelProof: f.proof, pricing: price() });
  f.routingEvidence = { accountId: binding.accountId, evidence: {
    account: stamp({ policyDigest }), configuration: stamp({ policyDigest, capabilities: ['intelligence.text', 'intelligence.reasoning'], contextWindowTokens: 128000 }),
    credentials: stamp({ state: 'configured' }), health: stamp({ status: 'healthy' }),
    metrics: stamp({ qualityScore: 90, reliabilityBps: 9900, latencyMs: 1000 }) } };
  f.readRoutingEvidence = async subject => {
    f.events.push('routing');
    assert.deepEqual(subject, { workspaceId: f.args.workspaceId, jobId: f.args.jobId, provider: 'openai', adapterId: OPERATOR_BRIEF_ADAPTER,
      modelId: MODEL, requestShape: OPERATOR_BRIEF_SHAPE, endpoint: OPERATOR_BRIEF_ENDPOINT, credentialDigest: binding.credentialDigest });
    assert.ok(Object.isFrozen(subject));
    return structuredClone(f.routingEvidence);
  };
  f.run = () => providerModule.createRoutingBoundAiProvider({ env: f.env, store: f.store, now: f.now,
    fetchImpl: (...args) => f.fetch(...args), readRoutingEvidence: (...args) => f.readRoutingEvidence(...args) }).enhanceCommander(f.args);
  return f;
}

test('routing evidence binds one existing atomic reservation and is revalidated before one dispatch', async () => {
  const f = routedFixture(), result = await f.run();
  assert.equal(result.used, true);
  assert.deepEqual(f.events, ['routing', 'reserve', 'context', 'routing', 'post', 'settle']);
  const reserved = f.reservations.values().next().value.input;
  assert.equal(reserved.callKey, 'job_fixture:operator-brief:v1');
  assert.equal(reserved.routeValidUntil, new Date(NOW + 59000).toISOString());
  assert.equal(reserved.inputTokenBound, 10000); assert.equal(reserved.outputTokenBound, 500);
  assert.equal(f.reservations.size, 1); assert.equal(f.posts.length, 1); assert.equal(f.settlements.length, 1);
  assert.equal(result.effects.costStatus, 'accounted'); assert.equal(result.effects.accountedCostMicros, 1030);
  const ordinary = fixture(); await ordinary.run();
  assert.notEqual(reserved.requestFingerprint, ordinary.reservations.values().next().value.input.requestFingerprint);
  for (const secret of [f.env.OPENAI_API_KEY, f.routingEvidence.accountId, f.routingEvidence.evidence.account.policyDigest]) {
    assert.equal(JSON.stringify([result, reserved, f.settlements]).includes(secret), false);
  }
});

test('dormant construction requires a server reader and cannot be installed through ordinary options or job data', async () => {
  for (const readRoutingEvidence of [undefined, null, {}, { verified: true }]) {
    assert.throws(() => providerModule.createRoutingBoundAiProvider({ readRoutingEvidence }), { code: 'AI_ROUTING_READER_REQUIRED' });
  }
  const ordinary = fixture(); let reads = 0;
  assert.equal((await createAiProvider({ env: ordinary.env, store: ordinary.store, now: ordinary.now, fetchImpl: ordinary.fetch,
    readRoutingEvidence: () => { reads++; throw new Error('Must remain dormant'); } }).enhanceCommander(ordinary.args)).used, true);
  assert.equal(reads, 0);
  const f = routedFixture(); f.args.routingDecision = { status: 'selected', executionAuthorized: true };
  f.args.routingEvidence = f.routingEvidence; f.readRoutingEvidence = async () => null;
  assert.equal((await f.run()).used, false); assert.equal(f.reservations.size, 0); assert.equal(f.posts.length, 0);
});

test('missing, stale and forged routing sources stop before any reservation', async () => {
  for (const change of [f => { f.routingEvidence.evidence = {}; },
    f => { f.routingEvidence.evidence.health.expiresAt = NOW; },
    f => { f.routingEvidence.evidence.account.verified = false; },
    f => { f.routingEvidence.policySnapshot = { verified: true }; },
    f => { f.readRoutingEvidence = async () => { throw new Error('PRIVATE_SOURCE_FAILURE'); }; }]) {
    const f = routedFixture(); change(f); const result = await f.run();
    assert.equal(result.used, false); assert.equal(f.posts.length, 0); assert.equal(f.reservations.size, 0);
    assert.equal(result.effects.accountedCostMicros, null); assert.equal(JSON.stringify(result).includes('PRIVATE_SOURCE_FAILURE'), false);
  }
});

test('every routing proof binds tenant, provider, model, account, operation and credential', async () => {
  for (const field of ['account', 'configuration', 'credentials', 'health', 'metrics']) {
    for (const [key, value] of Object.entries({ workspaceId: 'other-tenant', provider: 'anthropic', modelId: 'gpt-5.6-sol',
      adapterId: 'other-adapter', accountId: 'other-account', requestShape: 'other-operation:v1',
      endpoint: 'https://unapproved.invalid', credentialDigest: 'f'.repeat(64) })) {
      const f = routedFixture(); f.routingEvidence.evidence[field].binding[key] = value;
      assert.equal((await f.run()).used, false, `${field}.${key}`);
      assert.equal(f.posts.length, 0); assert.equal(f.reservations.size, 0);
    }
  }
});

test('admitted evidence changes retain the existing hold without dispatch, cancellation or replacement', async () => {
  for (const change of [f => { f.routingEvidence.evidence.metrics.qualityScore--; },
    f => { f.routingEvidence.evidence.health.status = 'unavailable'; },
    f => { f.routingEvidence.evidence.account.binding.workspaceId = 'other-tenant'; },
    f => { f.routingEvidence.evidence.configuration.policyDigest = 'f'.repeat(64); },
    f => { f.routingEvidence.accountId = 'other-account'; },
    f => { f.advance(59000); },
    f => { f.readRoutingEvidence = async () => { throw new Error('Synthetic unavailable'); }; }]) {
    const f = routedFixture(), reserve = f.store.reserveProviderUsage;
    f.store.reserveProviderUsage = async (...args) => { const result = await reserve(...args); change(f); return result; };
    const result = await f.run();
    assert.equal(result.used, false); assert.equal(f.reservations.size, 1); assert.equal(f.posts.length, 0);
    assert.equal(f.settlements.length, 0); assert.equal(result.effects.usageStatus, 'held');
    assert.equal(result.effects.costStatus, 'unknown'); assert.equal(result.effects.accountedCostMicros, null);
  }
});

test('state and credentials changed during asynchronous final evidence reads cannot dispatch', async () => {
  for (const change of [f => { f.env.OPENAI_API_KEY = 'different-synthetic-test-key'; },
    f => { f.env.RUNVARA_OPENAI_ENABLED = 'false'; }, f => { f.env.RUNVARA_AI_MAX_OUTPUT_TOKENS = '600'; },
    f => { f.args.run.summary = 'Changed recorded source'; }, f => { f.jobContext.attempt++; },
    f => { f.jobContext.workspaceId = 'other-tenant'; }, f => { f.jobContext.workerId = 'other-worker'; },
    f => { f.advance(59000); }]) {
    const f = routedFixture(), read = f.readRoutingEvidence; let reads = 0;
    f.readRoutingEvidence = async subject => { const result = await read(subject); if (++reads === 2) change(f); return result; };
    const result = await f.run();
    assert.equal(result.used, false); assert.equal(f.posts.length, 0); assert.equal(f.reservations.size, 1);
    assert.equal(f.settlements.length, 0); assert.equal(result.effects.costStatus, 'unknown');
  }
});

test('acknowledged cost and token bounds must equal the exact routing upper bound', async () => {
  for (const patch of [{ reservedCostMicros: 10509 }, { reservedCostMicros: 10511 }, { reservedCostMicros: 0 },
    { reservedCostMicros: '10510' }, { reservedCostMicros: NaN }, { reservedInputTokens: 9999 },
    { reservedOutputTokens: 499 }, { reservedTotalTokens: 10499 }, { reservedRequests: 2 }, { currency: 'GBP' }]) {
    const f = routedFixture(), reserve = f.store.reserveProviderUsage;
    f.store.reserveProviderUsage = async (...args) => ({ ...await reserve(...args), ...patch });
    const result = await f.run();
    assert.equal(result.reason, 'AI_USAGE_RESPONSE_INVALID'); assert.equal(f.posts.length, 0);
    assert.equal(f.reservations.size, 1); assert.equal(f.settlements.length, 0); assert.equal(result.effects.costStatus, 'unknown');
  }
});

test('SQL denial and lost or malformed admission acknowledgments never dispatch or infer a refund', async () => {
  const denied = routedFixture();
  denied.store.reserveProviderUsage = async () => ({ dispatchAllowed: false, reason: 'AI_BUDGET_EXCEEDED' });
  assert.equal((await denied.run()).reason, 'AI_BUDGET_EXCEEDED'); assert.equal(denied.posts.length, 0);
  for (const malformed of [false, true]) {
    const f = routedFixture(), reserve = f.store.reserveProviderUsage;
    f.store.reserveProviderUsage = async (...args) => {
      const ack = await reserve(...args);
      if (!ack.dispatchAllowed) return ack;
      if (malformed) return { ...ack, reservationId: null };
      throw new Error('Lost committed reservation acknowledgment');
    };
    assert.equal((await f.run()).used, false);
    assert.equal((await f.run()).reason, 'AI_LOGICAL_CALL_EXISTS');
    assert.equal(f.reservations.size, 1); assert.equal(f.posts.length, 0); assert.equal(f.settlements.length, 0);
  }
});

test('route fingerprint survives time passage but binds refreshed evidence without minting a new call key', async () => {
  const f = routedFixture(); await f.run();
  const reserved = f.reservations.values().next().value.input;
  f.advance(1000);
  assert.equal((await f.run()).reason, 'AI_LOGICAL_CALL_EXISTS');
  f.routingEvidence.evidence.metrics.checkedAt++;
  assert.equal((await f.run()).used, false);
  assert.equal(f.reservations.size, 1); assert.equal(f.posts.length, 1); assert.equal(f.settlements.length, 1);
  assert.equal(f.reservations.values().next().value.input.callKey, reserved.callKey);
});

test('provider timeout, provisional usage and malformed receipts preserve uncertainty and forbid retry', async () => {
  for (const fetch of [async () => { throw new Error('Synthetic response lost'); },
    async () => response({ ...receiptBody(), status: 'in_progress' }),
    async () => response({ ...receiptBody(), model: 'wrong-model' }),
    async () => response({ ...receiptBody(), usage: {} })]) {
    const f = routedFixture(); let posts = 0;
    f.fetch = async (...args) => { posts++; return fetch(...args); };
    const result = await f.run();
    assert.equal(result.used, false); assert.equal(result.effects.costStatus, 'unknown');
    assert.equal(result.effects.usageStatus, 'uncertain'); assert.equal(f.settlements[0].outcome, 'uncertain');
    assert.equal((await f.run()).reason, 'AI_LOGICAL_CALL_EXISTS'); assert.equal(posts, 1);
    assert.equal(f.settlements.length, 1); assert.equal(f.reservations.size, 1);
  }
});

test('lost settlement acknowledgment remains unknown and cannot dispatch the logical call again', async () => {
  const f = routedFixture(), settle = f.store.settleProviderUsage;
  f.store.settleProviderUsage = async (...args) => { await settle(...args); throw new Error('Synthetic lost settlement ack'); };
  const result = await f.run();
  assert.equal(result.reason, 'AI_USAGE_SETTLEMENT_UNCERTAIN'); assert.equal(result.effects.accountedCostMicros, null);
  assert.equal((await f.run()).reason, 'AI_LOGICAL_CALL_EXISTS'); assert.equal(f.posts.length, 1); assert.equal(f.settlements.length, 1);
});

// In-memory responses simulate the existing SQL contract only. The production
// code still uses its existing tables/RPCs; these fixtures are not PostgreSQL
// concurrency or financial-accounting acceptance evidence.
function useAtomicStoreAdapter(f) {
  const reserve = f.store.reserveProviderUsage;
  f.rpcCalls = []; f.consumptions = 0;
  const conflict = () => Response.json({ code: 'P0001', message: 'Synthetic identity conflict' }, { status: 409 });
  const store = createStore({ SUPABASE_URL: 'https://routing-fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key-only' }, {
    fetchImpl: async (url, options) => {
      const name = new URL(url).pathname.split('/').at(-1), p = JSON.parse(options.body);
      f.rpcCalls.push({ name, params: p });
      assert.equal(p.p_workspace_id, f.args.workspaceId);
      if (name === 'runvara_reserve_provider_usage') {
        let ack;
        try { ack = await reserve(p.p_workspace_id, { jobId: p.p_job_id, workerId: p.p_worker_id, jobAttempt: p.p_job_attempt,
          callKey: p.p_call_key, requestFingerprint: p.p_request_fingerprint, provider: p.p_provider, adapterId: p.p_adapter_id,
          model: p.p_model, inputTokenBound: p.p_input_token_bound, outputTokenBound: p.p_output_token_bound,
          pricingVersion: p.p_pricing_version, routeValidUntil: p.p_route_valid_until }); } catch { return conflict(); }
        const row = f.reservations.get(p.p_call_key);
        if (!ack.dispatchAllowed) return Response.json({ dispatch_allowed: false, reason: 'AI_LOGICAL_CALL_EXISTS',
          reservation_id: ack.reservationId, status: row.status ?? 'held', window_start: '2026-11-01', reserved_cost_micros: 10510 });
        return Response.json({ dispatch_allowed: true, reservation_id: ack.reservationId, status: 'held', window_start: ack.windowStart,
          reserved_requests: ack.reservedRequests, reserved_input_tokens: ack.reservedInputTokens, reserved_output_tokens: ack.reservedOutputTokens,
          reserved_total_tokens: ack.reservedTotalTokens, reserved_cost_micros: ack.reservedCostMicros, currency: ack.currency, pricing_version: ack.pricingVersion });
      }
      assert.equal(name, 'runvara_settle_provider_usage');
      const row = [...f.reservations.values()].find(row => row.ack.reservationId === p.p_reservation_id);
      if (!row || row.input.requestFingerprint !== p.p_request_fingerprint || row.input.jobId !== p.p_receipt.jobId) return conflict();
      const receiptDigest = briefDigest(p.p_receipt);
      if (row.settlement) return row.receiptDigest === receiptDigest && p.p_outcome === 'complete'
        ? Response.json({ ...row.settlement, idempotent: true }) : conflict();
      if (p.p_outcome === 'uncertain') {
        row.status = 'uncertain';
        return Response.json({ reservation_id: p.p_reservation_id, status: 'uncertain', held_cost_micros: 10510,
          reason: p.p_receipt.errorCode, idempotent: false });
      }
      assert.equal(p.p_outcome, 'complete'); // No cancellation or refund path.
      f.consumptions++; row.status = 'settled'; row.receiptDigest = receiptDigest;
      row.settlement = { reservation_id: p.p_reservation_id, status: 'settled', accounted_cost_micros: 1030,
        window_start: '2026-11-01', idempotent: false };
      return Response.json(row.settlement);
    }
  });
  f.store.reserveProviderUsage = store.reserveProviderUsage.bind(store);
  f.store.settleProviderUsage = store.settleProviderUsage.bind(store);
}

test('two instances share one atomic admission and consumption through the real store adapter', async () => {
  const f = routedFixture(); useAtomicStoreAdapter(f);
  const results = await Promise.all([f.run(), f.run()]);
  assert.equal(results.filter(result => result.used).length, 1);
  assert.equal(results.filter(result => result.reason === 'AI_LOGICAL_CALL_EXISTS').length, 1);
  assert.equal(f.reservations.size, 1); assert.equal(f.posts.length, 1); assert.equal(f.consumptions, 1);
  const reserveCalls = f.rpcCalls.filter(call => call.name === 'runvara_reserve_provider_usage');
  assert.equal(reserveCalls.length, 2); assert.deepEqual(reserveCalls[0].params, reserveCalls[1].params);
  assert.equal(reserveCalls[0].params.p_call_key, 'job_fixture:operator-brief:v1');
  assert.equal(reserveCalls[0].params.p_provider, 'openai'); assert.equal(reserveCalls[0].params.p_adapter_id, OPERATOR_BRIEF_ADAPTER);
  const saved = f.rpcCalls.find(call => call.name === 'runvara_settle_provider_usage').params;
  const reconciliation = { reservationId: saved.p_reservation_id, requestFingerprint: saved.p_request_fingerprint,
    outcome: 'complete', receipt: saved.p_receipt };
  const repeated = await f.store.settleProviderUsage(f.args.workspaceId, reconciliation);
  assert.equal(repeated.idempotent, true); assert.equal(f.consumptions, 1);
  for (const patch of [{ requestFingerprint: 'f'.repeat(64) }, { receipt: { ...saved.p_receipt, jobId: 'wrong-job' } },
    { receipt: { ...saved.p_receipt, providerRequestId: 'different-receipt' } }]) {
    await assert.rejects(f.store.settleProviderUsage(f.args.workspaceId, { ...reconciliation, ...patch }));
  }
  assert.equal(f.consumptions, 1); assert.equal((await f.run()).reason, 'AI_LOGICAL_CALL_EXISTS'); assert.equal(f.posts.length, 1);
  await assert.rejects(f.store.settleProviderUsage('other-tenant', reconciliation));
  assert.equal(f.consumptions, 1);
});

test('real store uncertainty receipt retains the hold and denies a second dispatch', async () => {
  const f = routedFixture(); useAtomicStoreAdapter(f);
  let posts = 0; f.fetch = async () => { posts++; throw new Error('Synthetic lost provider response'); };
  const result = await f.run();
  assert.equal(result.effects.usageStatus, 'uncertain'); assert.equal(result.effects.accountedCostMicros, null);
  assert.equal(f.consumptions, 0); assert.equal(f.reservations.values().next().value.status, 'uncertain');
  assert.equal((await f.run()).reason, 'AI_LOGICAL_CALL_EXISTS'); assert.equal(posts, 1);
  assert.equal(f.rpcCalls.filter(call => call.name === 'runvara_settle_provider_usage').length, 1);
});

test('production entry points do not construct the dormant routing-bound provider', async () => {
  for (const file of ['server.mjs', 'lib/scheduler.mjs']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /createRoutingBoundAiProvider|readRoutingEvidence/);
  }
});

test('existing category maximum and component rounding determine the exact acknowledged cost', async () => {
  const f = routedFixture(), pricing = f.state.aiEconomics.governance.providers.openai.pricing[0];
  Object.assign(pricing, { inputMicrosPerMillionTokens: 1, cachedInputMicrosPerMillionTokens: 2,
    cacheWriteMicrosPerMillionTokens: 3, outputMicrosPerMillionTokens: 4, requestMicros: 7 });
  const digest = operatorBriefRoutingPolicyDigest({ modelProof: f.proof, pricing });
  f.routingEvidence.evidence.account.policyDigest = digest; f.routingEvidence.evidence.configuration.policyDigest = digest;
  const reserve = f.store.reserveProviderUsage;
  f.store.reserveProviderUsage = async (...args) => {
    const ack = await reserve(...args);
    if (ack.dispatchAllowed) { ack.reservedCostMicros = 9; f.reservations.values().next().value.ack.reservedCostMicros = 9; }
    return ack;
  };
  const settle = f.store.settleProviderUsage;
  f.store.settleProviderUsage = async (...args) => ({ ...await settle(...args), accountedCostMicros: 9 });
  // ceil(10000 * max(1,2,3) / 1e6) + ceil(500 * 4 / 1e6) + 7 = 9.
  const result = await f.run(); assert.equal(result.used, true); assert.equal(f.posts.length, 1);
  assert.equal(result.effects.accountedCostMicros, 9);
  assert.equal(f.reservations.values().next().value.ack.reservedCostMicros, 9);
});

test('settlement overrun keeps the existing exact cost string and cannot reopen admission', async () => {
  const f = routedFixture();
  f.store.settleProviderUsage = async inputWorkspace => {
    assert.equal(inputWorkspace, f.args.workspaceId);
    return { reservationId: 'provider_usage_fixture', status: 'overrun', accountedCostMicros: '900719925474099312345', idempotent: false };
  };
  const result = await f.run();
  assert.equal(result.effects.usageStatus, 'overrun'); assert.equal(result.effects.accountedCostMicros, '900719925474099312345');
  assert.equal((await f.run()).reason, 'AI_LOGICAL_CALL_EXISTS'); assert.equal(f.posts.length, 1);
});
