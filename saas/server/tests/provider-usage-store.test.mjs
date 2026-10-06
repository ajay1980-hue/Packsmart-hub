import assert from 'node:assert/strict';
import test from 'node:test';
import { createStore } from '../lib/store.mjs';

const workspaceId = 'tenant-one';
const secret = 'service-key-never-returned-or-logged';
const fingerprint = 'ab'.repeat(32);
const reservationId = 'provider_usage_test-one';
const input = () => ({ jobId: 'job_one', workerId: 'worker_one', jobAttempt: 1,
  callKey: 'job_one:operator-brief:v1', requestFingerprint: fingerprint, provider: 'openai', adapterId: 'openai-brief',
  model: 'test-model', inputTokenBound: 1000, outputTokenBound: 200, pricingVersion: 'test-v1', routeValidUntil: '2026-10-06T17:50:00.000Z' });
const granted = () => ({ dispatch_allowed: true, reservation_id: reservationId, status: 'held', window_start: '2026-10-01',
  reserved_requests: 1, reserved_input_tokens: 1000, reserved_output_tokens: 200, reserved_total_tokens: 1200,
  reserved_cost_micros: 1800, currency: 'USD', pricing_version: 'test-v1' });
const receipt = () => ({ jobId: 'job_one', providerRequestId: 'req_test-one', inputTokens: 500, cachedInputTokens: 100,
  cacheWriteTokens: 50, outputTokens: 80, totalTokens: 580 });
const settlement = () => ({ reservationId, requestFingerprint: fingerprint, outcome: 'complete', receipt: receipt() });
const settled = () => ({ reservation_id: reservationId, status: 'settled', accounted_cost_micros: 740,
  window_start: '2026-10-01', idempotent: false });
const windowRow = (scope = 'tenant') => ({ workspace_id: workspaceId, scope_key: scope, window_start: '2026-10-01', currency: 'USD',
  held_requests: 1, held_input_tokens: 1000, held_output_tokens: 200, held_total_tokens: 1200, held_cost_micros: 1800,
  settled_requests: 2, settled_input_tokens: 200, settled_output_tokens: 50, settled_total_tokens: 250, settled_cost_micros: 350 });
function fixture(handler = () => granted()) {
  const calls = [];
  const store = createStore({ SUPABASE_URL: 'https://usage-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: secret }, {
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: new URL(url), ...options });
      const result = await handler(calls.at(-1), calls.length);
      return result instanceof Response ? result : Response.json(result);
    }
  });
  return { store, calls };
}
const rejectsInput = action => assert.rejects(action, error => error.code === 'AI_USAGE_INPUT_INVALID' && error.dispatchAllowed === false);
const rejectsResult = action => assert.rejects(action, error => error.code === 'AI_USAGE_RESPONSE_INVALID' && error.dispatchAllowed === false);

test('reserve uses one fixed atomic RPC with exact trusted tenant and bounded parameters', async () => {
  const { store, calls } = fixture();
  const result = await store.reserveProviderUsage(workspaceId, input());
  assert.deepEqual(result, { dispatchAllowed: true, reservationId, status: 'held', windowStart: '2026-10-01',
    reservedRequests: 1, reservedInputTokens: 1000, reservedOutputTokens: 200, reservedTotalTokens: 1200,
    reservedCostMicros: 1800, currency: 'USD', pricingVersion: 'test-v1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/rest/v1/rpc/runvara_reserve_provider_usage');
  assert.equal(calls[0].url.search, '');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { p_workspace_id: workspaceId, p_job_id: 'job_one', p_worker_id: 'worker_one',
    p_job_attempt: 1, p_call_key: 'job_one:operator-brief:v1', p_request_fingerprint: fingerprint,
    p_provider: 'openai', p_adapter_id: 'openai-brief', p_model: 'test-model', p_input_token_bound: 1000,
    p_output_token_bound: 200, p_pricing_version: 'test-v1', p_route_valid_until: '2026-10-06T17:50:00.000Z' });
  assert.equal(calls[0].headers.Authorization, `Bearer ${secret}`);
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!calls[0].body.includes(secret));
});

test('reserve rejects tenant spoofing, caller prices, remaining budgets, bodies and unknown fields before network', async () => {
  const { store, calls } = fixture();
  for (const override of [{ workspaceId: 'tenant-two' }, { p_workspace_id: 'tenant-two' }, { tenantId: 'tenant-two' },
    { price: 0 }, { reservedCostMicros: 0 }, { remainingBudget: 1000 }, { requestBody: { apiKey: secret } }, { credentials: secret }]) {
    await rejectsInput(() => store.reserveProviderUsage(workspaceId, { ...input(), ...override }));
  }
  assert.equal(calls.length, 0);
});

test('reserve validates identities, exact logical key, hash, safe integer bounds, and canonical timestamps', async () => {
  const { store, calls } = fixture();
  for (const override of [{ jobAttempt: 0 }, { jobAttempt: 1.5 }, { jobAttempt: '1' }, { inputTokenBound: NaN },
    { inputTokenBound: 1000001 }, { outputTokenBound: 128001 }, { outputTokenBound: -1 }, { inputTokenBound: Number.MAX_SAFE_INTEGER + 1 },
    { requestFingerprint: 'AB'.repeat(32) }, { requestFingerprint: 'x' }, { callKey: 'job_one:second-dispatch' },
    { workerId: 'short' }, { model: 'private prompt\ntext' }, { provider: 'openai?workspace=other' }, { adapterId: '' },
    { routeValidUntil: '2026-02-30T00:00:00.000Z' }, { routeValidUntil: '2026-10-06' }, { routeValidUntil: Infinity }]) {
    await rejectsInput(() => store.reserveProviderUsage(workspaceId, { ...input(), ...override }));
  }
  await rejectsInput(() => store.reserveProviderUsage('tenant&select=*', input()));
  let getterInvoked = false;
  const accessor = input();
  Object.defineProperty(accessor, 'inputTokenBound', { get() { getterInvoked = true; return 1000; } });
  await rejectsInput(() => store.reserveProviderUsage(workspaceId, accessor));
  assert.equal(getterInvoked, false);
  assert.equal(calls.length, 0);
  await store.reserveProviderUsage(workspaceId, { ...input(), routeValidUntil: Date.parse(input().routeValidUntil) });
  assert.equal(JSON.parse(calls[0].body).p_route_valid_until, input().routeValidUntil);
});

test('only a complete exact grant can permit dispatch; missing or malformed RPC responses fail closed', async () => {
  const cases = [null, [], {}, 'true', [granted()], { dispatch_allowed: true }, { ...granted(), dispatch_allowed: 'true' },
    { ...granted(), status: 'uncertain' }, { ...granted(), status: 'settled' }, { ...granted(), currency: 'GBP' },
    { ...granted(), reserved_input_tokens: 999 }, { ...granted(), reserved_total_tokens: 1 },
    { ...granted(), reserved_cost_micros: Number.MAX_SAFE_INTEGER + 1 }, { ...granted(), reserved_cost_micros: '1800' },
    { ...granted(), pricing_version: 'stale' }, { ...granted(), window_start: '2026-10-02' },
    { ...granted(), reservation_id: '' }, { ...granted(), reason: 'AI_LOGICAL_CALL_EXISTS' }, { ...granted(), responseBody: secret }];
  for (const value of cases) {
    const { store, calls } = fixture(() => value);
    await rejectsResult(() => store.reserveProviderUsage(workspaceId, input()));
    assert.equal(calls.length, 1);
  }
});

test('duplicate reservations and explicit policy denials never authorize another dispatch', async () => {
  const duplicate = { dispatch_allowed: false, reason: 'AI_LOGICAL_CALL_EXISTS', reservation_id: reservationId,
    status: 'held', window_start: '2026-10-01', reserved_cost_micros: 1800 };
  const { store, calls } = fixture(() => duplicate);
  assert.deepEqual(await store.reserveProviderUsage(workspaceId, input()), { dispatchAllowed: false, reason: 'AI_LOGICAL_CALL_EXISTS',
    reservationId, status: 'held', windowStart: '2026-10-01', reservedCostMicros: 1800 });
  assert.equal(calls.length, 1);
  for (const reason of ['AI_GOVERNANCE_NOT_CONFIGURED', 'AI_JOB_LEASE_INVALID', 'AI_PRICING_UNVERIFIED',
    'AI_ADMISSION_EVIDENCE_EXPIRED', 'AI_ADMISSION_WINDOW_CHANGED']) {
    const { store } = fixture(() => ({ dispatch_allowed: false, reason }));
    assert.deepEqual(await store.reserveProviderUsage(workspaceId, input()), { dispatchAllowed: false, reason });
  }
  const budget = fixture(() => ({ dispatch_allowed: false, reason: 'AI_BUDGET_EXCEEDED', scope: 'provider:openai' }));
  assert.equal((await budget.store.reserveProviderUsage(workspaceId, input())).scope, 'provider:openai');
});

test('reserve timeout/network failures never retry and drop raw error causes, bodies and secrets', async () => {
  for (const name of ['TimeoutError', 'AbortError', 'Error']) {
    const { store, calls } = fixture(() => { throw Object.assign(new Error(`raw provider body ${secret}`), { name, body: secret }); });
    await assert.rejects(() => store.reserveProviderUsage(workspaceId, input()), error => {
      assert.equal(error.code, 'AI_USAGE_RESERVATION_UNCERTAIN');
      assert.equal(error.dispatchAllowed, false);
      assert.equal(error.cause, undefined);
      assert.ok(!JSON.stringify(error).includes(secret));
      assert.ok(!error.stack.includes(secret));
      return true;
    });
    assert.equal(calls.length, 1);
  }
  const malformed = fixture(() => new Response(`private invalid JSON ${secret}`, { status: 200 }));
  await assert.rejects(() => malformed.store.reserveProviderUsage(workspaceId, input()), error => !error.message.includes(secret) && !error.cause);
  assert.equal(malformed.calls.length, 1);
});

test('settlement writes exact immutable identity/receipt, and explicit retries retain the same RPC body', async () => {
  const { store, calls } = fixture((_, n) => n === 1 ? settled() : { ...settled(), window_start: undefined, idempotent: true });
  assert.deepEqual(await store.settleProviderUsage(workspaceId, settlement()), { reservationId, status: 'settled',
    accountedCostMicros: 740, windowStart: '2026-10-01', idempotent: false });
  assert.equal((await store.settleProviderUsage(workspaceId, settlement())).idempotent, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, '/rest/v1/rpc/runvara_settle_provider_usage');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body, calls[1].body);
  assert.deepEqual(JSON.parse(calls[0].body), { p_workspace_id: workspaceId, p_reservation_id: reservationId,
    p_request_fingerprint: fingerprint, p_outcome: 'complete', p_receipt: receipt() });
});

test('settlement timeout preserves retry identity without another provider or reservation call', async () => {
  const { store, calls } = fixture((_, n) => {
    if (n === 1) throw new Error(`lost settlement ${secret}`);
    return { ...settled(), idempotent: true };
  });
  await assert.rejects(() => store.settleProviderUsage(workspaceId, settlement()), error => error.code === 'AI_USAGE_SETTLEMENT_UNCERTAIN' && !error.cause);
  assert.equal(calls.length, 1);
  await store.settleProviderUsage(workspaceId, settlement());
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body);
  assert.ok(calls.every(call => call.url.pathname.endsWith('/runvara_settle_provider_usage')));
});

test('settlement rejects client identity/price overrides, arbitrary payloads and invalid receipt arithmetic', async () => {
  const { store, calls } = fixture(() => settled());
  for (const override of [{ workspaceId: 'other' }, { requestFingerprint: 'not-a-hash' }, { outcome: 'refunded' }]) {
    await rejectsInput(() => store.settleProviderUsage(workspaceId, { ...settlement(), ...override }));
  }
  for (const override of [{ billedCostMicros: 0 }, { price: 0 }, { body: secret }, { workspaceId: 'other' },
    { providerRequestId: null }, { totalTokens: 0 }, { outputTokens: -1 }, { inputTokens: 1.5 },
    { cachedInputTokens: 451 }, { cacheWriteTokens: Number.MAX_SAFE_INTEGER }, { errorCode: 'raw private text' }]) {
    await rejectsInput(() => store.settleProviderUsage(workspaceId, { ...settlement(), receipt: { ...receipt(), ...override } }));
  }
  assert.equal(calls.length, 0);
});

test('uncertain settlement retains held accounting and accepts only bounded safe evidence', async () => {
  const { store, calls } = fixture(() => ({ reservation_id: reservationId, status: 'uncertain',
    held_cost_micros: 1800, reason: 'AI_PROVIDER_TIMEOUT', idempotent: false }));
  const value = { ...settlement(), outcome: 'uncertain', receipt: { jobId: 'job_one', errorCode: 'AI_PROVIDER_TIMEOUT' } };
  assert.deepEqual(await store.settleProviderUsage(workspaceId, value), { reservationId, status: 'uncertain',
    heldCostMicros: 1800, reason: 'AI_PROVIDER_TIMEOUT', idempotent: false });
  assert.deepEqual(JSON.parse(calls[0].body).p_receipt, value.receipt);
  await rejectsInput(() => store.settleProviderUsage(workspaceId, { ...value, receipt: { ...value.receipt, providerBody: secret } }));
});

test('pre-dispatch cancellation requires separate trusted lifecycle proof and no provider usage evidence', async () => {
  const { store, calls } = fixture(() => ({ reservation_id: reservationId, status: 'cancelled_pre_dispatch',
    accounted_cost_micros: 0, window_start: '2026-10-01', idempotent: false }));
  const value = { ...settlement(), outcome: 'cancelled_pre_dispatch', receipt: { jobId: 'job_one' } };
  await rejectsInput(() => store.settleProviderUsage(workspaceId, value));
  await rejectsInput(() => store.settleProviderUsage(workspaceId, { ...value, receipt: { jobId: 'job_one', dispatchStarted: false, proof: 'local_pre_dispatch' } }));
  await rejectsInput(() => store.settleProviderUsage(workspaceId, { ...value, trustedPreDispatchProof: { dispatchStarted: true, proof: 'local_pre_dispatch' } }));
  const proof = { dispatchStarted: false, proof: 'local_pre_dispatch' };
  await rejectsInput(() => store.settleProviderUsage(workspaceId, { ...value, receipt: receipt(), trustedPreDispatchProof: proof }));
  assert.equal(calls.length, 0);
  const result = await store.settleProviderUsage(workspaceId, { ...value, trustedPreDispatchProof: proof });
  assert.equal(result.status, 'cancelled_pre_dispatch');
  assert.deepEqual(JSON.parse(calls[0].body).p_receipt, { jobId: 'job_one', ...proof });
});

test('settlement validates response identity, status, safe money, and exact outcome consistency', async () => {
  for (const value of [null, [], { ...settled(), reservation_id: 'other' }, { ...settled(), status: 'held' },
    { ...settled(), status: 'cancelled_pre_dispatch' }, { ...settled(), accounted_cost_micros: -1 },
    { ...settled(), accounted_cost_micros: Number.MAX_SAFE_INTEGER + 1 }, { ...settled(), idempotent: 'true' },
    { ...settled(), body: secret }, { ...settled(), window_start: undefined }]) {
    const { store } = fixture(() => value);
    await rejectsResult(() => store.settleProviderUsage(workspaceId, settlement()));
  }
  const overrun = fixture(() => ({ ...settled(), status: 'overrun', accounted_cost_micros: 3000 }));
  const actual = { ...receipt(), inputTokens: 1500, totalTokens: 1580 };
  assert.equal((await overrun.store.settleProviderUsage(workspaceId, { ...settlement(), receipt: actual })).status, 'overrun');
});

test('summary performs exactly one bounded tenant/month read of compact counters, never full state or ledgers', async () => {
  const { store, calls } = fixture(() => [windowRow(), windowRow('provider:openai')]);
  const result = await store.providerUsageSummary(workspaceId, '2026-10');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/rest/v1/runvara_provider_usage_windows');
  assert.equal(calls[0].url.searchParams.get('workspace_id'), 'eq.tenant-one');
  assert.equal(calls[0].url.searchParams.get('window_start'), 'eq.2026-10-01');
  assert.equal(calls[0].url.searchParams.get('limit'), '130');
  assert.equal(calls[0].url.searchParams.get('order'), 'scope_key.asc');
  assert.equal(calls[0].url.searchParams.get('select'), 'workspace_id,scope_key,window_start,currency,held_requests,held_input_tokens,held_output_tokens,held_total_tokens,held_cost_micros,settled_requests,settled_input_tokens,settled_output_tokens,settled_total_tokens,settled_cost_micros');
  assert.equal(calls[0].method, undefined);
  assert.equal(calls[0].body, undefined);
  assert.deepEqual(result, { available: true, admissionMonth: '2026-10', currency: 'USD', scopes: ['tenant', 'provider:openai'].map(scopeKey => ({ scopeKey,
    held: { requests: 1, inputTokens: 1000, outputTokens: 200, totalTokens: 1200, costMicros: 1800 },
    settled: { requests: 2, inputTokens: 200, outputTokens: 50, totalTokens: 250, costMicros: 350 } })) });
});

test('empty, truncated, mismatched, duplicated or unsafe summary data is unavailable, never a zero balance', async () => {
  const rows = [[], null, {}, [windowRow('provider:openai')], [windowRow(), windowRow()],
    [{ ...windowRow(), workspace_id: 'other' }], [{ ...windowRow(), window_start: '2026-09-01' }],
    [{ ...windowRow(), held_cost_micros: '1800' }], [{ ...windowRow(), held_cost_micros: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...windowRow(), held_total_tokens: 1000 }], [{ ...windowRow(), settled_requests: -1 }],
    [{ ...windowRow(), state: secret }], [{ ...windowRow(), currency: 'GBP' }],
    Array.from({ length: 130 }, (_, n) => windowRow(n ? `provider:custom:p${n}` : 'tenant'))];
  for (const value of rows) {
    const { store, calls } = fixture(() => value);
    const result = await store.providerUsageSummary(workspaceId, '2026-10');
    assert.equal(result.available, false);
    assert.equal(result.scopes, undefined);
    assert.ok(result.reason);
    assert.equal(calls.length, 1);
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  const { store, calls } = fixture();
  for (const month of ['2026-00', '2026-13', '2026-10-01', '2026-1', null, '0000-01']) {
    await rejectsInput(() => store.providerUsageSummary(workspaceId, month));
  }
  assert.equal(calls.length, 0);
});

test('missing schema/grants and outages return explicit safe unavailable reasons without fallback reads', async () => {
  for (const [code, reason, status] of [['42P01', 'AI_USAGE_MIGRATION_REQUIRED', 404], ['42703', 'AI_USAGE_MIGRATION_REQUIRED', 400],
    ['PGRST202', 'AI_USAGE_MIGRATION_REQUIRED', 404], ['PGRST205', 'AI_USAGE_MIGRATION_REQUIRED', 404],
    ['42501', 'AI_USAGE_NOT_CONFIGURED', 403], ['PGRST000', 'AI_USAGE_UNAVAILABLE', 503]]) {
    const { store, calls } = fixture(() => Response.json({ code, message: secret, details: secret, hint: secret }, { status }));
    assert.deepEqual(await store.providerUsageSummary(workspaceId, '2026-10'), { available: false, reason });
    await assert.rejects(() => store.reserveProviderUsage(workspaceId, input()), error => {
      assert.equal(error.code, reason === 'AI_USAGE_UNAVAILABLE' ? 'AI_USAGE_RESERVATION_UNCERTAIN' : reason);
      assert.equal(error.dispatchAllowed, false);
      assert.ok(!JSON.stringify(error).includes(secret));
      return true;
    });
    assert.equal(calls.length, 2);
  }
  const network = fixture(() => { throw new Error(secret); });
  assert.deepEqual(await network.store.providerUsageSummary(workspaceId, '2026-10'), { available: false, reason: 'AI_USAGE_UNAVAILABLE' });
  assert.equal(network.calls.length, 1);
});

test('FileStore explicitly refuses durable reservations/settlements and cannot claim accounting availability', async () => {
  const store = createStore({ SAAS_STATE_FILE: '/unused-provider-accounting-test.json' });
  assert.equal(store.provider, 'file');
  store.readAll = () => { throw new Error('Accounting must not read legacy workspace state'); };
  for (const action of [() => store.reserveProviderUsage(workspaceId, input()), () => store.settleProviderUsage(workspaceId, settlement())]) {
    await assert.rejects(action, error => error.code === 'AI_USAGE_DURABLE_STORE_REQUIRED' && error.dispatchAllowed === false);
  }
  assert.deepEqual(await store.providerUsageSummary(workspaceId, '2026-10'), { available: false, reason: 'AI_USAGE_NOT_CONFIGURED' });
  assert.deepEqual(store.aiUsage, []);
});
