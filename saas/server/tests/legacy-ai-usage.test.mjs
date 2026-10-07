import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../lib/store.mjs';
import { LEGACY_AI_USAGE_COLUMNS, LEGACY_AI_USAGE_MAX_ROWS, LEGACY_AI_USAGE_MAX_BYTES,
  legacyAiUsagePage, publicLegacyAiUsage, fleetLegacyAiUsage, legacyAiUsageUnknown } from '../lib/legacy-ai-usage.mjs';

const workspace = 'legacy-alpha', start = '2026-10-01T00:00:00.000Z', end = '2026-11-01T00:00:00.000Z';
const row = (overrides = {}) => ({ id: 'usage_1', workspace_id: workspace, occurred_at: '2026-10-07T12:00:00.123456+00:00',
  model: 'synthetic-model', input_tokens: 20, cached_input_tokens: 4, cache_write_tokens: 2, output_tokens: 5, estimated_cost_usd: 0.25, ...overrides });
function fixture(response) {
  const calls = [];
  const store = createStore({ SUPABASE_URL: 'https://synthetic-legacy.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-key' }, {
    fetchImpl: async (url, options) => { calls.push({ url: new URL(url), options }); return typeof response === 'function' ? response() : response; }
  });
  return { store, calls, read: () => store.aiUsageSummary(workspace, start, end) };
}
const page = (rows = [row()], range = '0-0/1') => legacyAiUsagePage({ data: rows, contentRange: range }, workspace, start, end);
const unknown = (result, status = 'unavailable') => {
  assert.equal(result.status, status); assert.equal(result.totals, null); assert.deepEqual(result.byModel, []);
};

test('legacy recorded usage proves completeness using one narrow bounded exact-count month read', async () => {
  const f = fixture(Response.json([row()], { headers: { 'Content-Range': '0-0/1', 'x-private': 'do-not-expose' } }));
  const result = await f.read();
  assert.equal(result.status, 'complete'); assert.equal(result.scope, 'legacy_recorded_usage');
  assert.deepEqual(result.totals, { requests: 1, inputTokens: 20, cachedInputTokens: 4, cacheWriteTokens: 2, outputTokens: 5, estimatedCostUsd: 0.25 });
  assert.deepEqual(publicLegacyAiUsage(result, workspace, start, end), result);
  assert.equal(f.calls.length, 1);
  const { url, options } = f.calls[0];
  assert.equal(url.pathname, '/rest/v1/runvara_ai_usage');
  assert.deepEqual([...url.searchParams], [['workspace_id', 'eq.' + workspace], ['occurred_at', 'gte.' + start], ['occurred_at', 'lt.' + end],
    ['select', LEGACY_AI_USAGE_COLUMNS], ['order', 'occurred_at.desc'], ['limit', String(LEGACY_AI_USAGE_MAX_ROWS + 1)]]);
  assert.equal(options.headers.Prefer, 'count=exact'); assert.equal(options.method, undefined);
  assert.equal(Object.hasOwn(options, 'includeResponseMetadata'), false); assert.equal(Object.hasOwn(options, 'maxResponseBytes'), false);
  assert.ok(options.signal instanceof AbortSignal);
  assert.doesNotMatch(JSON.stringify(result), /usage_1|x-private|do-not-expose|occurred_at|request_id|synthetic-key/);
});

test('server row caps, sentinels and missing or wildcard counts never become full monthly totals', async () => {
  for (const range of ['0-0/2', '0-0/1000000', null, '0-0/*']) {
    const f = fixture(Response.json([row()], { headers: range === null ? {} : { 'Content-Range': range } }));
    unknown(await f.read(), 'partial'); assert.equal(f.calls.length, 1);
  }
  const rows = Array.from({ length: LEGACY_AI_USAGE_MAX_ROWS + 1 }, (_, i) => row({ id: `usage_${i}`, estimated_cost_usd: 0 }));
  assert.equal(page(rows, `0-${rows.length - 1}/${rows.length}`).reason, 'AI_USAGE_ROW_LIMIT');
  assert.equal(page(rows.slice(1), `0-${rows.length - 2}/${rows.length - 1}`).status, 'complete');
  unknown(page([...rows, row({ id: 'over-limit' })], `0-${rows.length}/${rows.length + 1}`));
});

test('known empty ledger remains distinct from missing, malformed, or incomplete evidence', async () => {
  const empty = await fixture(Response.json([], { headers: { 'Content-Range': '*/0' } })).read();
  assert.equal(empty.status, 'complete'); assert.equal(empty.totals.requests, 0); assert.equal(empty.totals.estimatedCostUsd, 0);
  assert.deepEqual(empty.byModel, []);
  unknown(page([], null), 'partial'); unknown(page([], '*/*'), 'partial');
  for (const range of ['', '*', '0-0/0', '0-1/1', '1-1/1', '00-0/1', '0-00/1', '0-0/01', '0-0/-1',
    '0-0/1.0', 'items 0-0/1', '0-0/9007199254740993', '0-1/*', '*/0', '*/1', '0-0/1,0-0/1']) unknown(page([row()], range));
  for (const value of [null, {}, '', '[]', { length: 0 }, false]) unknown(legacyAiUsagePage({ data: value, contentRange: '*/0' }, workspace, start, end));
  unknown(await fixture(new Response('', { status: 200, headers: { 'Content-Range': '*/0' } })).read());
  unknown(await fixture(new Response(null, { status: 204, headers: { 'Content-Range': '*/0' } })).read());
});

test('transport bytes are capped before decode, including declared and streamed bodies', async () => {
  let cancelled = false;
  const f = fixture(new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(LEGACY_AI_USAGE_MAX_BYTES + 1)); }, cancel() { cancelled = true; } }),
    { headers: { 'Content-Range': '0-0/1' } }));
  unknown(await f.read()); assert.equal(cancelled, true);
  unknown(await fixture(new Response('[]', { headers: { 'Content-Length': String(LEGACY_AI_USAGE_MAX_BYTES + 1), 'Content-Range': '*/0' } })).read());
  unknown(page([row({ model: 'x'.repeat(LEGACY_AI_USAGE_MAX_BYTES) })]));
  const boundary = '[]' + ' '.repeat(LEGACY_AI_USAGE_MAX_BYTES - 2);
  assert.equal((await fixture(new Response(boundary, { headers: { 'Content-Range': '*/0' } })).read()).status, 'complete');
  unknown(await fixture(new Response(boundary + ' ', { headers: { 'Content-Range': '*/0' } })).read());
});

test('bad upstream bodies, missing tables and thrown reads yield safe fixed unavailable results', async () => {
  for (const response of [new Response('private-row-secret', { status: 500 }), Response.json({ code: '42P01', message: 'private-row-secret' }, { status: 404 }),
    new Response('private-row-secret', { headers: { 'Content-Range': '*/0' } }), () => { throw new Error('private-row-secret'); }]) {
    const result = await fixture(response).read(); unknown(result); assert.doesNotMatch(JSON.stringify(result), /private-row-secret|42P01/);
  }
});

test('rows require safe integers, exact nonnegative costs and consistent cache components', () => {
  for (const key of ['input_tokens', 'cached_input_tokens', 'cache_write_tokens', 'output_tokens']) {
    for (const value of [null, undefined, '', '0', true, [], {}, -1, -0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) unknown(page([row({ [key]: value })]));
  }
  for (const value of [null, undefined, '', '0.25', true, [], {}, -1, -0, NaN, Infinity, 0.123456789, 0.000000001, 2 ** 26, Number.MAX_SAFE_INTEGER]) unknown(page([row({ estimated_cost_usd: value })]));
  unknown(page([row({ cached_input_tokens: 19, cache_write_tokens: 2 })]));
  for (const value of [0, 0.00000001, 0.0000001, 0.1, 999999.99999999, 1000000, 67108863.99999999]) assert.equal(page([row({ estimated_cost_usd: value })]).status, 'complete');
  assert.equal(page([row({ input_tokens: Number.MAX_SAFE_INTEGER })]).status, 'complete');
  unknown(page([row({ input_tokens: Number.MAX_SAFE_INTEGER }), row({ id: 'usage_2' })], '0-1/2'));
  unknown(page(Array.from({ length: 91 }, (_, i) => row({ id: `usage_${i}`, estimated_cost_usd: 999999.99999999 })), '0-90/91'));
  assert.equal(page([row({ estimated_cost_usd: 0.1 }), row({ id: 'usage_2', estimated_cost_usd: 0.2 })], '0-1/2').totals.estimatedCostUsd, 0.3);
});

test('scope, month, row identity and timestamp validation reject wrong tenant/window evidence', async () => {
  const f = fixture(() => assert.fail('invalid arguments must never fetch'));
  for (const args of [['other&select=*', start, end], ['', start, end], [null, start, end], [workspace, start, start],
    [workspace, '2026-10-02T00:00:00.000Z', end], [workspace, start, '2027-11-01T00:00:00.000Z'], [workspace, 'invalid', end]]) unknown(await f.store.aiUsageSummary(...args));
  assert.equal(f.calls.length, 0);
  for (const patch of [{ workspace_id: 'legacy-beta' }, { occurred_at: end }, { occurred_at: '2026-09-30T23:59:59.999999+00:00' },
    { occurred_at: '2026-02-30T00:00:00Z' }, { occurred_at: '2026-10-07' }, { occurred_at: '2026-10-07T24:00:00Z' },
    { occurred_at: 'invalid' }, { id: null }, { model: null }, { model: '' }, { model: '\nsecret' }, { model: 'x'.repeat(201) }, { secret: 'unexpected' }]) unknown(page([row(patch)]));
  unknown(page([row(), row()], '0-1/2'));
  assert.equal(page([row({ occurred_at: '2026-10-01T01:00:00+01:00' })]).status, 'complete');
  unknown(page([row({ occurred_at: '2026-10-01T00:00:00+01:00' })]));
  const models = ['__proto__', 'constructor', '<img src=x onerror=alert(1)>'];
  const result = page(models.map((model, i) => row({ id: `usage_${i}`, model })), '0-2/3');
  assert.equal(result.status, 'complete'); assert.equal(result.totals.requests, 3); assert.deepEqual(result.byModel.map(item => item.model).sort(), models.sort());
});

test('FileStore cannot infer a complete month or zero from restartable process memory', async () => {
  const store = createStore({ SAAS_STATE_FILE: '/tmp/not-read-legacy-test.json' });
  for (const rows of [[], [row()], [row({ input_tokens: -1 })]]) {
    store.aiUsage = rows;
    const result = await store.aiUsageSummary(workspace, start, end);
    unknown(result, 'partial'); assert.equal(result.reason, 'AI_USAGE_VOLATILE_STORE');
  }
  unknown(await store.aiUsageSummary(workspace, 'invalid', end));
});

test('public summary projection rejects wrong scope, unsafe totals and mismatched model totals', () => {
  const good = page();
  for (const value of [undefined, null, {}, { totals: good.totals }, { ...good, workspaceId: 'other' }, { ...good, startAt: '2026-09-01T00:00:00.000Z' },
    { ...good, scope: 'governed_provider_usage' }, { ...good, totals: { ...good.totals, requests: 2 } },
    { ...good, totals: { ...good.totals, estimatedCostUsd: -1 } }, { ...good, byModel: [] },
    { ...good, byModel: [...good.byModel, ...good.byModel] }, { ...good, totals: { ...good.totals, private: 'secret' } }]) unknown(publicLegacyAiUsage(value, workspace, start, end));
  assert.deepEqual(publicLegacyAiUsage({ ...good, private: 'secret' }, workspace, start, end), good);
  const partial = legacyAiUsageUnknown(workspace, start, end, 'AI_USAGE_TRUNCATED', 'partial');
  unknown(publicLegacyAiUsage(partial, workspace, start, end), 'partial');
  unknown(publicLegacyAiUsage({ ...partial, reason: 'raw-private-error' }, workspace, start, end));
});

test('fleet aggregation retains unknowns, checks overflow and only sums complete legacy ledgers', () => {
  const good = page(), empty = { ...page([], '*/0'), workspaceId: 'legacy-beta' }, partial = legacyAiUsageUnknown(workspace, start, end, 'AI_USAGE_TRUNCATED', 'partial');
  const unavailable = legacyAiUsageUnknown(workspace, start, end);
  for (const summary of [partial, unavailable, undefined, null, { status: 'complete', totals: { requests: 0, estimatedCostUsd: 0 } }]) {
    const mixed = fleetLegacyAiUsage([good, summary ? { ...summary, workspaceId: 'legacy-beta' } : summary]);
    assert.equal(mixed.aiUsageMonthStatus, 'partial'); assert.equal(mixed.aiRequestsMonth, null); assert.equal(mixed.aiEstimatedCostUsdMonth, null);
  }
  assert.equal(fleetLegacyAiUsage([unavailable]).aiUsageMonthStatus, 'unavailable');
  assert.equal(fleetLegacyAiUsage([]).aiUsageMonthStatus, 'unavailable');
  const complete = fleetLegacyAiUsage([good, empty]);
  assert.equal(complete.aiUsageMonthStatus, 'complete'); assert.equal(complete.aiRequestsMonth, 1); assert.equal(complete.aiEstimatedCostUsdMonth, 0.25);
  assert.equal(fleetLegacyAiUsage([empty]).aiEstimatedCostUsdMonth, 0);
  const huge = page([row({ input_tokens: Number.MAX_SAFE_INTEGER })]);
  assert.equal(fleetLegacyAiUsage([huge, { ...huge, workspaceId: 'legacy-beta' }]).aiUsageMonthStatus, 'unavailable');
  const costly = page([row({ estimated_cost_usd: 40000000 })]);
  assert.equal(fleetLegacyAiUsage([costly, { ...costly, workspaceId: 'legacy-beta' }, { ...good, workspaceId: 'legacy-gamma' }]).aiUsageMonthStatus, 'unavailable');
  assert.equal(fleetLegacyAiUsage([good, good]).aiUsageMonthStatus, 'unavailable', 'duplicate tenant must not double-count');
  const priorMonth = legacyAiUsagePage({ data: [], contentRange: '*/0' }, 'legacy-beta', '2026-09-01T00:00:00.000Z', start);
  assert.equal(fleetLegacyAiUsage([good, priorMonth]).aiUsageMonthStatus, 'unavailable', 'month rollover must not mix windows');
});
