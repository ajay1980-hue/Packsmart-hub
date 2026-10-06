import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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

test('one trusted lease reserves a complete verified ceiling before POST and atomically settles exact usage', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.used, true); assert.equal(result.summary, 'Synthetic verified brief.');
  assert.deepEqual(f.events, ['reserve', 'context', 'post', 'settle']);
  const reserved = f.reservations.values().next().value.input;
  assert.equal(reserved.callKey, `${f.jobContext.jobId}:operator-brief:v1`);
  assert.equal(reserved.inputTokenBound, 10000); assert.equal(reserved.outputTokenBound, 500);
  assert.equal(reserved.workerId, 'worker_fixture'); assert.equal(reserved.jobAttempt, 1);
  assert.equal(reserved.routeValidUntil, f.jobContext.leaseUntil);
  assert.equal(f.posts[0].url, OPERATOR_BRIEF_ENDPOINT); assert.equal(f.posts[0].init.redirect, 'error');
  assert.equal(JSON.parse(f.posts[0].init.body).max_output_tokens, 500);
  assert.equal(JSON.parse(f.posts[0].init.body).store, false);
  assert.equal(result.effects.costStatus, 'accounted'); assert.equal(result.effects.accountedCostMicros, 1030);
  assert.equal(result.usage.totalTokens, 1020); assert.equal(f.settlements[0].outcome, 'complete');
  const ledger = JSON.stringify([reserved, f.settlements]);
  assert.ok(!ledger.includes('Recorded contribution')); assert.ok(!ledger.includes('Summarise recorded health'));
  assert.ok(!ledger.includes(f.env.OPENAI_API_KEY)); assert.ok(!ledger.includes(result.summary));
});

test('default configured provider cannot dispatch without platform policy, durable store and trusted job', async () => {
  for (const change of [f => { delete f.state.aiEconomics.governance; }, f => { f.store.provider = 'file'; },
    f => { delete f.args.jobContext; }, f => { f.env.RUNVARA_OPENAI_ENABLED = 'false'; },
    f => { f.env.OPENAI_API_BASE_URL = 'https://other.example/v1'; }, f => { f.args.route.provider = 'xai'; }]) {
    const f = fixture(); change(f); const result = await f.run();
    assert.equal(result.used, false); assert.equal(f.posts.length, 0); assert.equal(f.reservations.size, 0);
    assert.equal(result.effects.costStatus, 'unknown'); assert.equal(result.effects.accountedCostMicros, null);
  }
});

test('token bounds and billing semantics must be explicit, fresh and within RPC limits without clamping', async () => {
  for (const mutation of [p => { delete p.verified; }, p => { delete p.allBillableInputTokensCovered; },
    p => { delete p.outputLimitCoversAllBillableOutput; }, p => { p.maxBillableInputTokens = 1000001; },
    p => { p.maxBillableInputTokens = '10000'; }, p => { p.maxBillableInputTokens = 0; },
    p => { p.maxBillableOutputTokens = 499; }, p => { p.checkedAt = NOW + 1; }, p => { p.expiresAt = NOW; },
    p => { p.expiresAt = NOW + 8 * 86400000; }, p => { p.requestShape = 'different'; },
    p => { p.endpoint = 'https://other.example/responses'; }, p => { delete p.cacheWriteMode; }]) {
    const f = fixture(); mutation(f.proof); const result = await f.run();
    assert.equal(result.used, false); assert.equal(f.reservations.size, 0); assert.equal(f.posts.length, 0);
  }
  for (const value of ['0', '-1', '64.5', '2001', 'NaN']) {
    const f = fixture(); f.env.RUNVARA_AI_MAX_OUTPUT_TOKENS = value;
    assert.equal((await f.run()).reason, 'AI_OUTPUT_BOUND_INVALID'); assert.equal(f.posts.length, 0);
  }
});

test('safe-era job provenance requires the real cutover and accounting boundaries, never local inference', async () => {
  for (const change of [f => { delete f.state.aiEconomics.governance.providers.openai.adapters[OPERATOR_BRIEF_ADAPTER].atomicUsageCutoverAt; },
    f => { f.state.aiEconomics.governance.providers.openai.adapters[OPERATOR_BRIEF_ADAPTER].atomicUsageCutoverAt = NOW + 1; },
    f => { delete f.jobContext.createdAt; }, f => { f.jobContext.createdAt = new Date(NOW - 60001).toISOString(); }]) {
    const f = fixture(); change(f); const result = await f.run();
    assert.equal(result.used, false); assert.equal(result.effects.accountedCostMicros, null); assert.equal(f.reservations.size, 0);
  }
  const old = fixture(); old.state.aiEconomics.governance.providers.openai.adapters[OPERATOR_BRIEF_ADAPTER].atomicUsageCutoverAt = NOW - 100;
  // Created after the clean month boundary but before legacy retirement.
  assert.equal((await old.run()).reason, 'AI_LEGACY_JOB_DISPATCH_UNVERIFIED'); assert.equal(old.posts.length, 0);
  const exact = fixture(); exact.jobContext.createdAt = new Date(NOW - 60000).toISOString();
  assert.equal((await exact.run()).used, true);
});

test('a previously uncertain logical call never becomes zero-cost when later local policy is unavailable', async () => {
  for (const change of [f => { delete f.state.aiEconomics.governance; }, f => { f.env.RUNVARA_OPENAI_ENABLED = 'false'; },
    f => { f.proof.expiresAt = NOW; }, f => { delete f.args.jobContext; }]) {
    const f = fixture(); let posts = 0; f.fetch = async () => { posts++; throw new Error('Synthetic response lost'); };
    assert.equal((await f.run()).effects.costStatus, 'unknown'); change(f);
    const next = await f.run(); assert.equal(next.effects.submissionAttempts, 0);
    assert.equal(next.effects.costStatus, 'unknown'); assert.equal(next.effects.accountedCostMicros, null); assert.equal(posts, 1);
  }
});

test('missing or ambiguous pricing cannot be replaced by the display model catalogue', async () => {
  for (const change of [p => { p.pricing = []; }, p => { p.pricing.push({ ...price(), version: 'another' }); },
    p => { p.pricing[0].verified = false; }, p => { p.pricing[0].expiresAt = NOW; }, p => { p.pricing[0].requestMicros = null; }]) {
    const f = fixture(); change(f.state.aiEconomics.governance.providers.openai);
    assert.equal((await f.run()).reason, 'AI_PRICING_UNVERIFIED'); assert.equal(f.posts.length, 0); assert.equal(f.reservations.size, 0);
  }
});

test('every RPC policy or clean-baseline denial preserves deterministic fallback with no POST', async () => {
  for (const reason of ['AI_ACCOUNTING_BASELINE_UNVERIFIED', 'AI_BUDGET_EXCEEDED', 'AI_PROVIDER_NOT_ALLOWED',
    'AI_PRICING_EXPIRED', 'AI_JOB_LEASE_INVALID', 'AI_PROVIDER_OVERRUN_BLOCKED']) {
    const f = fixture(); f.store.reserveProviderUsage = async () => ({ dispatchAllowed: false, reason });
    const result = await f.run(); assert.equal(result.reason, reason); assert.equal(result.used, false);
    assert.equal(f.posts.length, 0); assert.equal(f.settlements.length, 0); assert.equal(f.args.run.summary, 'Recorded contribution £40.');
  }
});

test('lost, missing, malformed and contradictory reservation acknowledgements never dispatch or claim zero exposure', async () => {
  for (const reply of [undefined, {}, { dispatchAllowed: false, reason: 'UNEXPECTED' },
    { dispatchAllowed: true, reservationId: 'wrong', status: 'settled' }]) {
    const f = fixture(), reserve = f.store.reserveProviderUsage;
    f.store.reserveProviderUsage = async (...a) => { await reserve(...a); return reply; };
    const result = await f.run(); assert.equal(result.used, false); assert.equal(f.posts.length, 0);
    assert.equal(result.effects.costStatus, 'unknown'); assert.equal(result.effects.accountedCostMicros, null);
  }
  const f = fixture(), reserve = f.store.reserveProviderUsage;
  f.store.reserveProviderUsage = async (...a) => { await reserve(...a); throw Object.assign(new Error('Synthetic lost ack'), { code: 'AI_USAGE_RESERVATION_UNCERTAIN' }); };
  assert.equal((await f.run()).effects.costStatus, 'unknown'); assert.equal(f.posts.length, 0);
  f.store.reserveProviderUsage = reserve;
  assert.equal((await f.run()).reason, 'AI_LOGICAL_CALL_EXISTS'); assert.equal(f.posts.length, 0);
});

test('independent callers and subsequent retries get only one logical dispatch entitlement', async () => {
  const f = fixture(); const results = await Promise.all([f.run(), f.run()]);
  assert.equal(results.filter(row => row.used).length, 1); assert.equal(f.posts.length, 1);
  assert.equal(results.find(row => !row.used).reason, 'AI_LOGICAL_CALL_EXISTS');
  f.jobContext.attempt = 2;
  assert.equal((await f.run()).reason, 'AI_LOGICAL_CALL_EXISTS'); assert.equal(f.posts.length, 1);
  f.args.command = 'Different input cannot mint another dispatch';
  assert.equal((await f.run()).effects.costStatus, 'unknown'); assert.equal(f.posts.length, 1);
});

test('slow reservation, current job ownership changes, and changed policy/account/body leave the permanent hold', async () => {
  const changes = [f => f.advance(300001), f => { f.jobContext.workerId = 'worker_reclaimed'; },
    f => { f.jobContext.attempt = 2; }, f => { f.jobContext.status = 'queued'; }, f => { f.jobContext.type = 'connection_sync'; },
    f => { f.proof.maxBillableInputTokens = 9999; }, f => { f.proof.verified = false; },
    f => { f.state.aiEconomics.governance.providers.openai.adapters[OPERATOR_BRIEF_ADAPTER].atomicUsageCutoverAt++; },
    f => { f.state.aiEconomics.governance.providers.openai.enabled = false; }, f => { f.state.aiEconomics.monthlyCostLimitUsd = 0; },
    f => { f.env.OPENAI_API_KEY = 'changed-synthetic-key-only'; }, f => { f.env.RUNVARA_OPENAI_ENABLED = 'false'; },
    f => { f.args.run.summary = 'Changed after reservation'; }];
  for (const change of changes) {
    const f = fixture(), reserve = f.store.reserveProviderUsage;
    f.store.reserveProviderUsage = async (...a) => { const ack = await reserve(...a); change(f); return ack; };
    const result = await f.run(); assert.equal(result.used, false); assert.equal(f.posts.length, 0);
    assert.equal(f.reservations.size, 1); assert.equal(result.effects.costStatus, 'unknown'); assert.equal(f.settlements.length, 0);
  }
});

test('unavailable or cross-tenant final context and expiry during the last read cannot dispatch', async () => {
  for (const mode of ['throw', 'tenant', 'job', 'model', 'expiry', 'missing_created', 'changed_created']) {
    const f = fixture(), read = f.store.getOperatorBriefContext;
    f.store.getOperatorBriefContext = async () => {
      const context = await read();
      if (mode === 'throw') throw new Error('Synthetic context unavailable');
      if (mode === 'tenant') context.workspaceId = 'other';
      if (mode === 'job') context.job.jobId = 'other';
      if (mode === 'model') context.job.model = 'other';
      if (mode === 'expiry') f.advance(300001);
      if (mode === 'missing_created') delete context.job.createdAt;
      if (mode === 'changed_created') context.job.createdAt = new Date(NOW - 500).toISOString();
      return context;
    };
    const result = await f.run(); assert.equal(f.posts.length, 0); assert.equal(result.effects.costStatus, 'unknown');
  }
});

test('existing worker and Commander stop policies are rechecked after admission without extra reads', async () => {
  for (const change of [f => { f.state.agentOps = { enabled: false }; }, f => { f.state.agentOps = { paused: true }; },
    f => { f.state.agentSettings = { commander: { enabled: false } }; }, f => { f.state.agentOps = { paused: 'false' }; }]) {
    const f = fixture(), reserve = f.store.reserveProviderUsage;
    f.store.reserveProviderUsage = async (...a) => { const ack = await reserve(...a); change(f); return ack; };
    const result = await f.run(); assert.equal(result.reason, 'AI_WORKER_POLICY_BLOCKED');
    assert.equal(f.posts.length, 0); assert.equal(result.effects.accountedCostMicros, null); assert.equal(f.reservations.size, 1);
  }
});

test('strict provider provenance, model, ID, counters and totals are required for complete settlement', async () => {
  const mutations = [b => { delete b.status; }, b => { b.status = 'queued'; }, b => { b.status = 'in_progress'; },
    b => { b.status = 'unexpected'; }, b => { b.status = 'incomplete'; }, b => { b.status = 'failed'; },
    b => { b.error = { code: 'unexpected' }; }, b => { b.incomplete_details = { reason: 'unknown' }; },
    b => { delete b.model; }, b => { b.model = 'different-model'; }, b => { b.provider = 'xai'; },
    b => { b.object = 'chat.completion'; }, b => { delete b.id; }, b => { b.id = 123; }, b => { delete b.usage; },
    b => { b.usage.input_tokens = '1000'; }, b => { b.usage.input_tokens = -1; }, b => { b.usage.output_tokens = 1.5; },
    b => { b.usage.total_tokens = 999; }, b => { delete b.usage.total_tokens; }, b => { b.usage.total_tokens = Number.MAX_SAFE_INTEGER + 1; },
    b => { delete b.usage.input_tokens_details.cached_tokens; }, b => { delete b.usage.input_tokens_details.cache_write_tokens; },
    b => { b.usage.input_tokens_details.cached_tokens = 1001; }];
  for (const change of mutations) {
    const f = fixture(), body = receiptBody(); change(body); f.fetch = async () => { f.posts.push({}); return response(body); };
    const result = await f.run(); assert.equal(result.used, false); assert.equal(result.effects.costStatus, 'unknown');
    assert.equal(f.settlements[0].outcome, 'uncertain'); assert.equal(f.posts.length, 1);
  }
  for (const options of [{ url: 'https://other.example/responses' }, { redirected: true }, { status: 429 }, { status: 500 }]) {
    const f = fixture(); f.fetch = async () => response(receiptBody(), options);
    assert.equal((await f.run()).effects.costStatus, 'unknown'); assert.equal(f.settlements[0].outcome, 'uncertain');
  }
});

test('omitted cache-write usage is zero only under an explicit verified not-applicable semantic', async () => {
  const f = fixture(); f.proof.cacheWriteMode = 'not_applicable'; const body = receiptBody();
  delete body.usage.input_tokens_details.cache_write_tokens; f.fetch = async () => response(body);
  assert.equal((await f.run()).used, true); assert.equal(f.settlements[0].receipt.cacheWriteTokens, 0);
  const second = fixture(); second.proof.cacheWriteMode = 'not_applicable'; body.usage.input_tokens_details.cache_write_tokens = 1;
  second.fetch = async () => response(body); assert.equal((await second.run()).effects.costStatus, 'unknown');
});

test('network, malformed and oversized response failures preserve uncertainty without automatic replay', async () => {
  for (const fetchImpl of [async () => { throw new TypeError('Synthetic response lost'); },
    async () => response('{invalid', { raw: true }), async () => response('x'.repeat(262145), { raw: true })]) {
    const f = fixture(); let posts = 0; f.fetch = async (...a) => { posts++; return fetchImpl(...a); };
    const result = await f.run(); assert.equal(result.used, false); assert.equal(result.effects.costStatus, 'unknown');
    assert.equal(f.settlements[0].outcome, 'uncertain'); assert.equal((await f.run()).reason, 'AI_LOGICAL_CALL_EXISTS'); assert.equal(posts, 1);
  }
});

test('native fetch cannot replay 307/308 POST redirects outside the original claim', async t => {
  for (const code of [307, 308]) {
    const paths = [], server = http.createServer((req, res) => { paths.push(req.url); res.writeHead(code, { Location: '/second' }); res.end(); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const f = fixture(); f.fetch = (_url, init) => fetch(`http://127.0.0.1:${server.address().port}/first`, init);
    const result = await f.run(); assert.deepEqual(paths, ['/first']); assert.equal(result.effects.costStatus, 'unknown');
    await f.run(); assert.deepEqual(paths, ['/first']);
  }
});

test('lost/mismatched settlement never reports known cost or triggers another provider call', async () => {
  for (const settle of [async () => { throw new Error('Lost settlement acknowledgement'); },
    async () => ({ reservationId: 'different', status: 'settled', accountedCostMicros: 1 }),
    async () => ({ reservationId: 'provider_usage_fixture', status: 'settled', accountedCostMicros: 0.5 })]) {
    const f = fixture(); f.store.settleProviderUsage = settle;
    const result = await f.run(); assert.equal(result.reason, 'AI_USAGE_SETTLEMENT_UNCERTAIN'); assert.equal(result.effects.accountedCostMicros, null);
    assert.equal(result.effects.confirmedSubmissions, 1); assert.equal(result.effects.usageStatus, 'uncertain');
    await f.run(); assert.equal(f.posts.length, 1);
  }
});

test('valid exact accounting survives empty text and preserves a huge overrun cost string', async () => {
  const f = fixture(), body = receiptBody(); body.output_text = ''; f.fetch = async () => response(body);
  const result = await f.run(); assert.equal(result.used, false); assert.equal(result.reason, 'AI_RESPONSE_TEXT_UNAVAILABLE');
  assert.equal(result.effects.costStatus, 'accounted'); assert.equal(result.usage.accountedCostMicros, 1030);
  const second = fixture(); second.store.settleProviderUsage = async () => ({ reservationId: 'provider_usage_fixture', status: 'overrun', accountedCostMicros: '81129638414606663681390496' });
  const overrun = await second.run(); assert.equal(overrun.effects.usageStatus, 'overrun');
  assert.equal(overrun.effects.accountedCostMicros, '81129638414606663681390496');
});

test('summarization keeps source currency and excludes nested customer/credential data, with a byte cap', async () => {
  const f = fixture(); f.args.run.priorities = [{ agentId: 'pricing', action: 'Recorded contribution £40.',
    customer: { email: 'private@example.test' }, secret: f.env.OPENAI_API_KEY }];
  f.args.run.urgentRisks = [{ code: 'TEST', severity: 'HIGH', affected: { email: 'another-private@example.test' } }];
  await f.run(); const body = f.posts[0].init.body;
  assert.ok(body.includes('£40')); assert.ok(!body.includes('private@example')); assert.ok(!body.includes(f.env.OPENAI_API_KEY));
  assert.ok(Buffer.byteLength(body) <= 65536);
  const huge = fixture(); huge.args.run.summary = '\u0001'.repeat(5000);
  huge.args.run.priorities = Array.from({ length: 8 }, () => ({ action: '\u0001'.repeat(1000) }));
  assert.equal((await huge.run()).reason, 'AI_REQUEST_BYTES_EXCEEDED'); assert.equal(huge.reservations.size, 0);
});
