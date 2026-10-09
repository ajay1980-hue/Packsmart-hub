import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEbayReadContext,
  ebayErrorCooldown,
  ebayReadCooldown,
  mergeEbayReadCooldown,
  parseEbayRetryAfter,
  validEbayRetryAt
} from '../lib/ebay-read-cooldown.mjs';
import { IntegrationService } from '../lib/integrations.mjs';

const NOW = Date.parse('2026-10-09T08:00:00.000Z');
const at = seconds => new Date(NOW + seconds * 1000).toISOString();
const emptyCooldown = { retryAt: null, retryReviewRequired: false };
const reviewCooldown = { retryAt: null, retryReviewRequired: true };
const areas = ['products', 'inventory', 'prices', 'orders', 'promotions'];
const token = 'synthetic-access-token';
const tick = () => new Promise(resolve => setImmediate(resolve));
const capture = promise => promise.then(value => ({ value }), error => ({ error }));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function response(status, payload = {}, retryAfter) {
  return Response.json(payload, { status, headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter } });
}
function serviceWith(fetchImpl) {
  return new IntegrationService({ EBAY_CLIENT_ID: 'synthetic-client-id', EBAY_CLIENT_SECRET: 'synthetic-client-secret' }, { fetchImpl });
}
function oauthFixture(fetchImpl) {
  const service = serviceWith(fetchImpl);
  service.ebayAccessToken = async () => token;
  service.ebayIdentity = async () => ({ username: 'synthetic-seller' });
  const config = { expectedAccount: 'synthetic-seller', marketplaceId: 'EBAY_GB', connection: { metadata: {} } };
  const state = {
    workspace: { id: 'synthetic-workspace' }, products: [],
    orders: [{ id: 'retained-order', provider: 'ebay', total: 42 }], integrationStatus: {},
    ebay: {
      listings: [{ id: 'retained-listing', sku: 'retained-sku', title: 'Retained', price: 12, quantity: 7 }],
      drafts: [{ id: 'retained-draft', sku: 'draft-sku', title: 'Draft', updatedAt: null }],
      fees: [{ orderId: 'retained-order', amount: 2 }], promotions: [{ campaignId: 'retained-campaign' }],
      inventoryApiComparison: { missingInInventoryApi: ['retained-comparison'] }
    }
  };
  return { service, config, state };
}

test('eBay Retry-After accepts nonnegative whole seconds and keeps delays beyond one day', () => {
  for (const [header, seconds] of [['0', 60], ['1', 60], ['59', 60], ['60', 60], ['61', 61], ['000120', 120], [' \t172800\t ', 172800], ['0'.repeat(128), 60]]) {
    assert.deepEqual(parseEbayRetryAfter(header, NOW), { retryAt: at(seconds), retryReviewRequired: false }, JSON.stringify(header));
  }
});

test('eBay Retry-After parses all three HTTP date forms, including a far-future deadline', () => {
  for (const header of ['Sat, 10 Oct 2026 09:00:00 GMT', 'Saturday, 10-Oct-26 09:00:00 GMT', 'Sat Oct 10 09:00:00 2026']) {
    assert.deepEqual(parseEbayRetryAfter(header, NOW), { retryAt: at(90000), retryReviewRequired: false }, header);
  }
  assert.equal(parseEbayRetryAfter('Sat Nov  7 09:00:00 2026', NOW).retryAt, '2026-11-07T09:00:00.000Z');
  assert.equal(parseEbayRetryAfter('Fri, 31 Dec 9999 23:59:59 GMT', NOW).retryAt, '9999-12-31T23:59:59.000Z');
  assert.equal(parseEbayRetryAfter('Sunday, 06-Nov-94 08:49:37 GMT', NOW).retryAt, at(60), 'obsolete two-digit years more than 50 years ahead refer to the prior century');
  assert.deepEqual(
    ['Friday, 09-Oct-76 08:00:00 GMT', 'Friday, 09-Oct-76 08:00:01 GMT', 'Saturday, 09-Oct-76 08:00:01 GMT'].map(header => parseEbayRetryAfter(header, NOW).retryAt),
    ['2076-10-09T08:00:00.000Z', at(60), at(60)],
    'the exact 50-year boundary is allowed; one second later shifts to the prior century before weekday validation'
  );
});

test('missing, short, expired and malformed Retry-After values receive only the one-minute fallback', () => {
  for (const header of [undefined, null, '', 120, '-1', '+120', '1.5', '1e5', 'Infinity', '120seconds', 'Fri, 09 Oct 2026 08:00:01 GMT', 'Sun, 06 Nov 1994 08:49:37 GMT',
    'Fri, 10 Oct 2026 09:00:00 GMT', 'Sat, 31 Oct 2026 25:00:00 GMT', 'Sun, 31 Nov 2026 09:00:00 GMT', 'Sat, 10 Oct 2026 09:60:00 GMT',
    'Sat, 10 oct 2026 09:00:00 GMT', 'Sat, 10 Oct 2026 09:00:00 UTC', 'Sat, 10 Oct 2026 09:00:00 +0000', '2026-10-10T09:00:00Z',
    'Sat, 10 Oct 2026 09:00:00 GMT extra', 'Sat, 10 Oct 2026 09:00:00 GMT\r\n', 'Saturday, 10-Oct-2026 09:00:00 GMT', 'Sat Oct 7 09:00:00 2026']) {
    assert.deepEqual(parseEbayRetryAfter(header, NOW), { retryAt: at(60), retryReviewRequired: false }, JSON.stringify(header));
  }
});

test('overlong and unrepresentable Retry-After values fail closed without retaining the header', () => {
  const last = Date.parse('9999-12-31T23:59:59.999Z');
  const greatestSeconds = Math.floor((last - NOW) / 1000);
  assert.equal(parseEbayRetryAfter(String(greatestSeconds), NOW).retryAt, '9999-12-31T23:59:59.000Z');
  for (const header of ['x'.repeat(129), '0'.repeat(129), '9'.repeat(128), '999999999999999', String(greatestSeconds + 1)]) {
    assert.deepEqual(parseEbayRetryAfter(header, NOW), reviewCooldown);
  }
  for (const invalidNow of [NaN, Infinity, -1, NOW + 0.5, last]) assert.deepEqual(parseEbayRetryAfter('60', invalidNow), reviewCooldown);
});

test('absolute cooldown validation and merging retain the latest deadline and a sticky review requirement', () => {
  assert.equal(validEbayRetryAt('2026-10-10T09:00:00Z'), at(90000));
  for (const value of ['2026-02-30T09:00:00Z', '2026-10-10', '2026-10-10T09:00:00+00:00', 'PRIVATE-HEADER', null, 172800]) assert.equal(validEbayRetryAt(value), null);
  const values = [{ retryAt: at(120) }, { retryAt: at(172800) }, reviewCooldown, { retryAt: at(60), retryReviewRequired: false }];
  const merged = mergeEbayReadCooldown(values, NOW);
  assert.deepEqual(merged, { retryAt: at(172800), retryReviewRequired: true });
  assert.deepEqual(mergeEbayReadCooldown([merged, emptyCooldown], NOW + 172801000), reviewCooldown);
  assert.deepEqual(mergeEbayReadCooldown([{ retryAt: 'PRIVATE-HEADER' }], NOW), reviewCooldown);
  const state = { integrationStatus: { ebay: values[0], shopify: { retryAt: at(259200) } }, ebay: { coverage: { readDiagnostics: { orders: values[1], marketing: reviewCooldown } } } };
  assert.deepEqual(ebayReadCooldown(state, NOW), merged);
  assert.equal(JSON.stringify(merged).includes('PRIVATE-HEADER'), false);
});

test('normalized expired error deadlines never restart a duration or fallback cooldown', () => {
  for (const error of [
    { upstreamStatus: 429, retryAt: at(60), retryAfterMs: 172800000 },
    { upstreamStatus: 503, retryAt: at(60), retryAfterMs: 172800000 },
    { code: 'CONNECTION_RATE_LIMITED', retryAt: null },
    { upstreamStatus: 429, cooldownDeferred: true },
    { upstreamStatus: 500 }
  ]) assert.deepEqual(ebayErrorCooldown(error, NOW + 60000), emptyCooldown);
  assert.deepEqual(ebayErrorCooldown({ upstreamStatus: 429, retryAfterMs: 172800000 }, NOW), { retryAt: at(172800), retryReviewRequired: false });
  assert.deepEqual(ebayErrorCooldown({ upstreamStatus: 503, retryAfterMs: 172800000 }, NOW), { retryAt: at(172800), retryReviewRequired: false }, 'fresh in-process duration compatibility is not limited to 429');
  assert.deepEqual(ebayErrorCooldown({ upstreamStatus: 429, retryAfterMs: Number.MAX_VALUE }, NOW), reviewCooldown, 'a giant finite legacy duration must require review, even when its string representation uses an exponent');
  assert.deepEqual(ebayErrorCooldown({ upstreamStatus: 429 }, NOW), { retryAt: at(60), retryReviewRequired: false });
});

test('an eBay read context retains later deadlines and review across sibling failures', t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const context = createEbayReadContext();
  context.observe({ upstreamStatus: 500 });
  assert.doesNotThrow(() => context.assertAllowed());
  context.observe({ upstreamStatus: 429, retryAt: at(120) });
  context.observe({ upstreamStatus: 403 });
  context.observe({ upstreamStatus: 429, retryAt: at(172800) });
  context.observe({ upstreamStatus: 429, ...reviewCooldown });
  context.observe({ upstreamStatus: 429, retryAt: at(60), retryReviewRequired: false });
  assert.deepEqual(context.cooldown, { retryAt: at(172800), retryReviewRequired: true });
  assert.throws(() => context.assertAllowed(), error => error.code === 'EBAY_RETRY_REVIEW_REQUIRED' && error.cooldownDeferred && error.retryAt === at(172800));
});

test('OAuth, Manager and token 429 wrappers normalize headers before delayed or unreadable bodies', async t => {
  for (const adapter of ['oauth', 'manager', 'token']) {
    for (const bodyKind of ['json', 'html', 'throws', 'null']) {
      await t.test(`${adapter}: ${bodyKind}`, async t => {
        t.mock.timers.enable({ apis: ['Date'], now: NOW });
        const service = serviceWith(async () => ({
          status: 429, ok: false, headers: new Headers({ 'Retry-After': '172800' }),
          json: async () => {
            t.mock.timers.setTime(NOW + 300000);
            if (bodyKind === 'html') return JSON.parse('<html>slow down</html>');
            if (bodyKind === 'throws') throw new Error('synthetic body read failure');
            return bodyKind === 'null' ? null : { errors: [{ errorId: '10001' }] };
          }
        }));
        const operation = adapter === 'oauth' ? service.ebayApiGet('https://api.ebay.com/synthetic', token)
          : adapter === 'manager' ? service.ebayGet({ base: 'https://manager.example.test' }, ['/synthetic'])
          : service.ebayTokenRequest({ grant_type: 'refresh_token', refresh_token: 'synthetic-refresh' }, 'EBAY_REFRESH_FAILED');
        const { error } = await capture(operation);
        assert.equal(error?.code, 'CONNECTION_RATE_LIMITED');
        assert.equal(error.upstreamStatus, 429);
        assert.equal(error.retryAt, at(172800));
        assert.equal(error.retryReviewRequired, false);
        assert.equal(Object.hasOwn(error, 'retryAfterMs'), false);
        assert.equal(Object.hasOwn(error, 'retryAfter'), false);
      });
    }
  }
});

test('all eBay wrappers expose only a review marker for an overlong raw header', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const header = 'PRIVATE-RAW-HEADER-'.repeat(10);
  const service = serviceWith(async () => response(429, {}, header));
  for (const operation of [
    () => service.ebayApiGet('https://api.ebay.com/synthetic', token),
    () => service.ebayGet({ base: 'https://manager.example.test' }, ['/synthetic']),
    () => service.ebayTokenRequest({ grant_type: 'refresh_token' }, 'EBAY_REFRESH_FAILED')
  ]) {
    const { error } = await capture(operation());
    assert.equal(error.retryAt, null);
    assert.equal(error.retryReviewRequired, true);
    assert.equal(JSON.stringify(error).includes('PRIVATE-RAW-HEADER'), false);
  }
});

test('a slow 429 body cannot reanchor an expired fallback deadline', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const context = createEbayReadContext();
  const service = serviceWith(async () => ({
    status: 429, ok: false, headers: new Headers(),
    json: async () => { t.mock.timers.setTime(NOW + 300000); throw new Error('synthetic delayed body'); }
  }));
  const { error } = await capture(service.ebayApiGet('https://api.ebay.com/synthetic', token, { readContext: context }));
  assert.equal(error.retryAt, at(60));
  assert.deepEqual(ebayErrorCooldown(error), emptyCooldown);
  assert.deepEqual(mergeEbayReadCooldown([error, context.cooldown]), emptyCooldown);
});

test('Manager route fallbacks stop after another started request observes a 429', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const missingRoute = deferred(), urls = [];
  const context = createEbayReadContext();
  const service = serviceWith(async url => {
    urls.push(String(url));
    return String(url).endsWith('/first') ? missingRoute.promise : response(429, {}, '172800');
  });
  const fallbackResult = capture(service.ebayGet({ base: 'https://manager.example.test' }, ['/first', '/second'], context));
  const { error } = await capture(service.ebayGet({ base: 'https://manager.example.test' }, ['/throttle'], context));
  assert.equal(error.retryAt, at(172800));
  missingRoute.resolve(response(404));
  const blocked = (await fallbackResult).error;
  assert.equal(blocked.cooldownDeferred, true);
  assert.equal(blocked.retryAt, at(172800));
  assert.deepEqual(urls, ['https://manager.example.test/first', 'https://manager.example.test/throttle']);
});

test('offer batches await every started sibling and retain later longer 429s behind earlier auth errors', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const requests = [];
  const service = serviceWith(url => {
    const gate = deferred(); requests.push({ url: new URL(url), ...gate }); return gate.promise;
  });
  let finished = false;
  const result = capture(service.fetchEbayOffers(token, Array.from({ length: 12 }, (_, i) => ({ sku: `sku-${i}` })), 'EBAY_GB')).then(value => { finished = true; return value; });
  assert.equal(requests.length, 10);
  requests[0].resolve(response(403, { errors: [{ errorId: '10002' }] }));
  requests[1].resolve(response(429, {}, '120'));
  for (let i = 3; i < 10; i++) requests[i].resolve(response(200, { offers: [] }));
  await tick();
  assert.equal(finished, false, 'the pending sibling must be allowed to report its longer deadline');
  requests[2].resolve(response(429, {}, '172800'));
  const { error } = await result;
  assert.equal(error.upstreamStatus, 403, 'authorization restriction remains the primary failure');
  assert.deepEqual(error.upstreamErrorIds, ['10002']);
  assert.equal(error.retryAt, at(172800));
  assert.equal(error.retryReviewRequired, false);
  assert.equal(requests.length, 10, 'a second offer batch must not start');
});

test('a 429 observed before its body finishes stops later order, inventory and campaign pages', async t => {
  for (const [method, key, size] of [['fetchEbayOrders', 'orders', 200], ['fetchEbayInventoryItems', 'inventoryItems', 200], ['fetchEbayMarketing', 'campaigns', 100]]) {
    await t.test(method, async t => {
      t.mock.timers.enable({ apis: ['Date'], now: NOW });
      const pageBody = deferred(), throttleBody = deferred(), throttleObserved = deferred();
      const urls = [];
      const service = serviceWith(async url => {
        urls.push(String(url));
        if (String(url).endsWith('/synthetic-throttle')) return {
          status: 429, ok: false, headers: new Headers({ 'Retry-After': '172800' }),
          json: () => { throttleObserved.resolve(); return throttleBody.promise; }
        };
        return { status: 200, ok: true, headers: new Headers(), json: () => pageBody.promise };
      });
      const context = createEbayReadContext();
      const pageResult = capture(method === 'fetchEbayMarketing' ? service[method](token, 'EBAY_GB', context) : service[method](token, context));
      const throttleResult = capture(service.ebayApiGet('https://api.ebay.com/synthetic-throttle', token, { readContext: context }));
      await throttleObserved.promise;
      assert.equal(context.cooldown.retryAt, at(172800));
      pageBody.resolve({ [key]: Array.from({ length: size }, (_, i) => ({ id: `item-${i}`, campaignId: `campaign-${i}` })), total: size * 2 });
      const { error } = await pageResult;
      assert.equal(error.cooldownDeferred, true);
      assert.equal(error.retryAt, at(172800));
      assert.equal(urls.length, 2, 'the completed page must not schedule its next page');
      throttleBody.resolve({});
      assert.equal((await throttleResult).error.upstreamStatus, 429);
    });
  }
});

test('mixed marketing errors retain auth and the latest 429 while completed reads survive and later offers stop', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const adRequests = [], urls = [];
  const { service, config, state } = oauthFixture(async url => {
    const parsed = new URL(url); urls.push(parsed);
    if (parsed.pathname.endsWith('/order')) return response(200, { orders: [{ orderId: 'new-order', pricingSummary: { total: { value: '9', currency: 'GBP' } } }] });
    if (parsed.pathname.endsWith('/inventory_item')) return response(200, { inventoryItems: [{ sku: 'new-sku' }] });
    if (parsed.pathname.endsWith('/ad_campaign')) return response(200, { campaigns: Array.from({ length: 7 }, (_, i) => ({ campaignId: `campaign-${i}`, campaignStatus: 'RUNNING' })) });
    if (parsed.pathname.endsWith('/ad')) { const gate = deferred(); adRequests.push({ url: parsed, ...gate }); return gate.promise; }
    assert.fail(`Unexpected request: ${parsed.pathname}`);
  });
  const prior = structuredClone(state.ebay);
  const sync = service.syncEbayOAuth(state, config, { areas });
  await tick();
  assert.equal(adRequests.length, 5);
  adRequests[0].resolve(response(403, { errors: [{ errorId: '10003' }] }));
  adRequests[1].resolve(response(500));
  adRequests[4].resolve(response(200, { ads: [{ adId: 'completed-ad', listingId: 'completed-listing' }] }));
  await tick();
  adRequests[2].resolve(response(429, {}, '172800'));
  await tick();
  adRequests[3].resolve(response(200, { ads: [{ adId: 'first-page' }], next: 'next-page', total: 101 }));
  const status = await sync;
  assert.equal(adRequests.length, 5, 'no later campaign batch or ad page may start');
  assert.equal(urls.some(url => url.pathname.endsWith('/offer')), false, 'offers are deferred after the earlier surfaces reveal a 429');
  assert.equal(status.retryAt, at(172800));
  assert.equal(status.upstreamStatus, 429);
  assert.deepEqual(status.failedAreas, ['products', 'inventory', 'prices', 'promotions']);
  assert.deepEqual(state.ebay.listings, prior.listings);
  assert.deepEqual(state.ebay.drafts, prior.drafts);
  assert.deepEqual(state.ebay.inventoryApiComparison, prior.inventoryApiComparison);
  assert.ok(state.orders.some(order => order.id === 'new-order'));
  assert.ok(state.orders.some(order => order.id === 'retained-order'));
  assert.equal(state.ebay.promotions.length, 7, 'the successful campaign read remains usable');
  const diagnostic = state.ebay.coverage.readDiagnostics.marketing;
  assert.equal(diagnostic.httpStatus, 429);
  assert.equal(diagnostic.automaticRetryBlocked, true);
  assert.deepEqual(diagnostic.errorIds, ['10003']);
  assert.equal(diagnostic.retryAt, at(172800));
  assert.deepEqual(diagnostic.failedCampaigns.map(item => item.httpStatus).sort(), [403, 429, 500, null], 'locally deferred reads do not fabricate an upstream response');
  assert.equal(state.ebay.coverage.readDiagnostics.offers.deferred, true);
});

test('an expired mixed marketing cooldown does not erase its retained automatic auth restriction', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  let marketingCalls = 0;
  const { service, config, state } = oauthFixture(async () => { marketingCalls++; return response(200, { campaigns: [] }); });
  state.ebay.coverage = { readDiagnostics: { marketing: {
    code: 'EBAY_MARKETING_ADS_PARTIAL', httpStatus: 429, errorIds: ['10003'], automaticRetryBlocked: true,
    retryAt: at(-60), retryReviewRequired: false,
    failedCampaigns: [{ campaignId: 'auth', httpStatus: 403, errorIds: ['10003'] }, { campaignId: 'throttle', httpStatus: 429, retryAt: at(-60) }]
  } } };
  const prior = structuredClone(state.ebay.promotions);
  const status = await service.syncEbayOAuth(state, config, { areas: ['promotions'], automatic: true });
  assert.equal(marketingCalls, 0, 'an expired rate-limit deadline cannot authorize an automatic retry of a retained 403');
  assert.deepEqual(status.failedAreas, ['promotions']);
  assert.deepEqual(state.ebay.promotions, prior);
  assert.equal(state.ebay.coverage.readDiagnostics.marketing.automaticRetryBlocked, true);
});

test('OAuth optional failures preserve old records and report all selected failed areas', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { service, config, state } = oauthFixture(async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/order')) return response(429, {}, '172800');
    if (path.endsWith('/inventory_item')) return response(500);
    if (path.endsWith('/ad_campaign')) return response(403);
    assert.fail(`Unexpected request: ${path}`);
  });
  const prior = structuredClone(state);
  const status = await service.syncEbayOAuth(state, config, { areas });
  assert.deepEqual(state.orders, prior.orders);
  for (const key of ['listings', 'drafts', 'fees', 'promotions', 'inventoryApiComparison']) assert.deepEqual(state.ebay[key], prior.ebay[key], key);
  assert.deepEqual(status.failedAreas, areas);
  assert.equal(status.retryAt, at(172800));
  assert.equal(state.ebay.coverage.readDiagnostics.orders.retryAt, at(172800));
});

test('the active Manager importer retains partial data and the latest sibling cooldown with explicit failed areas', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const pending = [];
  const { service, state } = oauthFixture(async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/status')) return response(200, { connected: true, account: 'synthetic-seller' });
    const gate = deferred(); pending.push({ path, ...gate }); return gate.promise;
  });
  state.ebay.listings[0] = { ...state.ebay.listings[0], status: 'PUBLISHED', adRate: 3, buyerShippingCharge: 2, listingUrl: 'https://www.ebay.co.uk/itm/synthetic' };
  service.ebayConfigured = () => true;
  service.ebayConfig = () => ({ mode: 'manager', base: 'https://manager.example.test', expectedAccount: 'synthetic-seller', connection: { metadata: {} } });
  const prior = structuredClone(state);
  const sync = service.syncEbay(state, { areas });
  await tick();
  assert.equal(pending.length, 5);
  for (const request of pending) {
    if (request.path.endsWith('/listings')) request.resolve(response(429, {}, '120'));
    else if (request.path.endsWith('/drafts')) request.resolve(response(500));
    else if (request.path.endsWith('/orders')) request.resolve(response(429, {}, '172800'));
    else if (request.path.endsWith('/fees')) request.resolve(response(500));
    else request.resolve(response(200, { promotions: [{ campaignId: 'new-campaign' }] }));
  }
  const status = await sync;
  assert.deepEqual(state.orders, prior.orders);
  for (const key of ['listings', 'drafts', 'fees']) assert.deepEqual(state.ebay[key], prior.ebay[key], key);
  assert.deepEqual(state.ebay.promotions, [{ campaignId: 'new-campaign' }]);
  assert.deepEqual(status.failedAreas, ['products', 'inventory', 'prices', 'orders']);
  assert.equal(status.retryAt, at(172800));
  assert.equal(status.upstreamStatus, 429);
  assert.equal(state.ebay.coverage.readDiagnostics.listings.retryAt, at(120));
  assert.equal(state.ebay.coverage.readDiagnostics.orders.retryAt, at(172800));
});
